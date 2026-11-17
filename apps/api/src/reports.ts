import ExcelJS from 'exceljs';
import type { Comparison, Criterion, FxRate, ProjectLine } from '@sp/domain';

/** Hücreye yazılan metin formül olarak yorumlanmaz (CSV/XLSX injection, T47). v2 Faz 6 Görev 6: risk dışa aktarımı da kullanır. */
export const safe = (v: unknown) => {
  const s = v == null ? '' : String(v);
  return /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
};
const num = (v: string | null) => (v == null ? null : Number(v));

interface EvalForReport {
  id: string; versionNo: number; createdAt: Date; createdBy: string; basisHash: string; current: boolean;
  project: { code: string; title: string; currency: string };
  snapshot: { comparison: Comparison; lines: (ProjectLine & { lineNo?: number })[]; criteria: Criterion[]; fx: FxRate[];
    bids: { bidId: string; supplierName: string; versionNo: number; submittedAt: string }[]; engine: string };
}

/**
 * Deterministik değerlendirme raporu (02 §6): özgün fiyatlar, normalleştirilmiş satırlar, kur varsayımı, formüller,
 * kapsam farkları ve puanlar; her satır kaynak teklif sürümüne bağlı. Model kullanılmaz.
 */
export async function evaluationWorkbook(e: EvalForReport): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Satınalma ve Sözleşme';
  wb.created = new Date(e.createdAt);
  const { comparison, lines, criteria, fx, bids } = e.snapshot;
  const src = (bidId: string) => bids.find((b) => b.bidId === bidId);

  const s = wb.addWorksheet('Özet');
  s.columns = [{ width: 34 }, { width: 22 }, { width: 18 }, { width: 18 }, { width: 18 }, { width: 12 }, { width: 50 }];
  const meta: [string, unknown][] = [
    ['Proje', `${e.project.code} · ${e.project.title}`], ['Değerlendirme sürümü', e.versionNo], ['Oluşturan', e.createdBy],
    ['Oluşturma zamanı', new Date(e.createdAt).toISOString()], ['Güncel mi', e.current ? 'Evet' : 'HAYIR: dayanak değişti, karar için kullanılamaz'],
    ['Dayanak parmak izi (SHA-256)', e.basisHash], ['Hesaplama', e.snapshot.engine], ['Para birimi', comparison.currency],
  ];
  for (const [k, v] of meta) s.addRow([k, safe(v)]).getCell(1).font = { bold: true };
  s.addRow([]);
  s.addRow(['Kur varsayımları', 'Kur', 'Kaynak', 'Tarih']).font = { bold: true };
  if (!fx.length) s.addRow(['Yok (yalnız proje para birimi)']);
  for (const f of fx) s.addRow([safe(f.currency), Number(f.rate), safe(f.source), safe(f.asOf)]);
  s.addRow([]);
  s.addRow(['Kriter', 'Tür', 'Ağırlık']).font = { bold: true };
  for (const c of criteria) s.addRow([safe(c.name), c.kind === 'PRICE' ? 'Fiyat (hesaplanır)' : 'Puan (kanıtlı)', Number(c.weight)]);
  s.addRow([]);
  s.addRow(['Tedarikçi', 'Kapsam', 'TCO', 'Fiyat puanı', 'Ağırlıklı puan', 'Sıra', 'Not']).font = { bold: true };
  for (const b of comparison.bids) {
    const r = s.addRow([safe(b.supplierName), b.complete ? 'Tam' : `Eksik (${b.missingLines.length} kalem)`, num(b.tco), num(b.priceScore), num(b.weightedScore),
      b.rank, safe(b.blocker ?? (b.scoreGaps.length ? `Eksik puan: ${b.scoreGaps.join(', ')}` : b.complete ? '' : 'Karşılaştırılamayan kapsam sıralamaya girmez'))]);
    r.getCell(3).numFmt = '#,##0.00';
  }
  s.addRow([]);
  s.addRow(['Fiyat puanı = 100 × en düşük uygun TCO / teklif TCO. Yalnız tam kapsamlı, pozitif TCO\'lu ve engelsiz teklifler arasında hesaplanır.']);
  s.addRow(['Bu rapor karar değildir; seçim yetkili onayla bu değerlendirme sürümüne bağlanır.']);

  const d = wb.addWorksheet('Kalemler');
  d.columns = [
    { header: 'Lot', width: 10 }, { header: 'Kalem', width: 36 }, { header: 'İhtiyaç', width: 12 }, { header: 'Birim', width: 12 },
    { header: 'Tedarikçi', width: 34 }, { header: 'Teklif birimi', width: 12 }, { header: 'Teklif miktarı', width: 14 }, { header: 'Özgün birim fiyat', width: 16 },
    { header: 'Para', width: 7 }, { header: 'Durum', width: 34 }, { header: 'Normalleştirilmiş birim fiyat', width: 18 }, { header: 'Satır toplamı', width: 18 },
    { header: 'Kaynak teklif', width: 38 }, { header: 'Sürüm', width: 8 }, { header: 'Alındı (sunucu)', width: 24 },
  ];
  d.getRow(1).font = { bold: true };
  d.views = [{ state: 'frozen', ySplit: 1 }];
  for (const l of lines) {
    for (const b of comparison.bids) {
      const lr = b.lines.find((x) => x.projectLineId === l.id)!;
      const sb = src(b.bidId);
      const row = d.addRow([safe(l.lot), safe(l.description), Number(l.quantity), safe(l.unit), safe(b.supplierName), safe(lr.original?.unit ?? ''),
        lr.original ? Number(lr.original.quantity) : null, lr.original ? Number(lr.original.unitPrice) : null, safe(lr.original?.currency ?? ''),
        safe(lr.reason), num(lr.unitPrice), null, b.bidId, sb?.versionNo ?? null, sb ? new Date(sb.submittedAt).toISOString() : '']);
      // Satır toplamı deterministik formüldür; hesaplanan değer de saklanır.
      const n = row.number;
      row.getCell(12).value = lr.state === 'COMPARABLE' ? { formula: `ROUND(C${n}*K${n},2)`, result: Number(lr.total) } : null;
      for (const c of [8, 11, 12]) row.getCell(c).numFmt = '#,##0.00##';
    }
  }
  return Buffer.from(await wb.xlsx.writeBuffer());
}

export interface AwardForReport {
  versionNo: number; status: string; total: string; rationale: string; proposedBy: string; proposedAt: Date; decidedBy: string | null; decidedAt: Date | null;
  decisionNote: string | null; lines: { description: string; supplierName: string; quantity: string; unit: string; unitPrice: string; amount: string }[];
}

const FONT_DIR = '@expo-google-fonts/source-sans-3';
const money = (v: string | null, cur: string) => v == null ? '—'
  : new Intl.NumberFormat('tr-TR', { style: 'currency', currency: cur, minimumFractionDigits: 2 }).format(Number(v));
const dt = (v: Date | string | null) => v ? new Intl.DateTimeFormat('tr-TR', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Europe/Istanbul' }).format(new Date(v)) : '—';
const STATUS: Record<string, string> = { PROPOSED: 'Onay bekliyor', APPROVED: 'Onaylandı', REJECTED: 'Geri gönderildi', SUPERSEDED: 'Yerine yenisi geldi' };

/**
 * PDF karar özeti (02 §6): adaylar, kapsam/uygunluk, TCO ve puanlar, kur varsayımları, tahsis ve insan onayları.
 * Deterministik; model kullanılmaz. Belge karar değildir; karar onay kaydıdır.
 */
export async function decisionSummaryPdf(e: EvalForReport, awards: AwardForReport[]): Promise<Buffer> {
  const { default: PDFDocument } = await import('pdfkit');
  const { createRequire } = await import('node:module');
  const req = createRequire(import.meta.url);
  const doc = new PDFDocument({ size: 'A4', margins: { top: 56, bottom: 64, left: 56, right: 56 }, bufferPages: true,
    info: { Title: `${e.project.code} karar özeti v${e.versionNo}`, Author: 'Satınalma ve Sözleşme', Subject: 'Değerlendirme karar özeti', CreationDate: new Date(e.createdAt) } });
  doc.registerFont('r', req.resolve(`${FONT_DIR}/400Regular/SourceSans3_400Regular.ttf`));
  doc.registerFont('b', req.resolve(`${FONT_DIR}/600SemiBold/SourceSans3_600SemiBold.ttf`));
  const chunks: Buffer[] = [];
  doc.on('data', (c: Buffer) => chunks.push(c));
  const done = new Promise<Buffer>((res) => doc.on('end', () => res(Buffer.concat(chunks))));
  const INK = '#1d2230', MUTED = '#4c5262', LINE = '#ddd6c6', DANGER = '#a8372a', STAMP = '#5b3fa0';
  const W = doc.page.width - 112;
  const { comparison, criteria, fx, lines } = e.snapshot;
  const cur = comparison.currency;

  const h2 = (t: string) => { doc.moveDown(0.8); doc.font('b').fontSize(12).fillColor(INK).text(t); doc.moveDown(0.3); };
  const para = (t: string, color = MUTED) => doc.font('r').fontSize(9.5).fillColor(color).text(t, { width: W });
  /** Basit tablo: sütun genişlikleri oranlı, sayfa sonunda başlık tekrar edilir. */
  function table(head: string[], widths: number[], rows: string[][], align: ('left' | 'right')[] = []) {
    const ws = widths.map((w) => (w / widths.reduce((a, b) => a + b, 0)) * W);
    const draw = (cells: string[], bold: boolean) => {
      doc.font(bold ? 'b' : 'r').fontSize(9);
      const h = Math.max(...cells.map((c, i) => doc.heightOfString(c, { width: ws[i]! - 8 }))) + 8;
      if (doc.y + h > doc.page.height - 72) { doc.addPage(); if (!bold) draw(head, true); }
      const y = doc.y; let x = 56;
      cells.forEach((c, i) => { doc.fillColor(bold ? MUTED : INK).text(c, x + 4, y + 4, { width: ws[i]! - 8, align: align[i] ?? 'left' }); x += ws[i]!; });
      doc.moveTo(56, y + h).lineTo(56 + W, y + h).lineWidth(0.5).strokeColor(LINE).stroke();
      doc.x = 56; doc.y = y + h;
    };
    draw(head, true);
    rows.forEach((r) => draw(r, false));
  }

  doc.font('b').fontSize(18).fillColor(INK).text('Karar özeti');
  doc.font('r').fontSize(11).fillColor(INK).text(`${e.project.code} · ${e.project.title}`);
  doc.moveDown(0.3);
  para(`Değerlendirme sürümü ${e.versionNo} · ${e.createdBy} · ${dt(e.createdAt)} · Para birimi ${cur}`);
  if (!e.current) {
    doc.moveDown(0.4);
    doc.font('b').fontSize(10).fillColor(DANGER).text('Bu değerlendirme güncel değil: sürümden sonra teklif, ağırlık, puan veya kur değişti. Karar için kullanılamaz.', { width: W });
  }
  doc.moveDown(0.4);
  para('Hesaplar deterministiktir; yapay zekâ kullanılmamıştır. Bu belge karar değildir; seçim, aşağıdaki yetkili onay kaydıyla bu değerlendirme sürümüne bağlanır.');

  h2('Değerlendirme kriterleri');
  table(['Kriter', 'Tür', 'Ağırlık'], [5, 3, 1.4], criteria.map((c) => [c.name, c.kind === 'PRICE' ? 'Fiyat (hesaplanır)' : 'Puan (kanıtlı)', `%${Number(c.weight).toLocaleString('tr-TR')}`]), ['left', 'left', 'right']);

  h2('Teklifler');
  table(['Tedarikçi', 'Kapsam', 'TCO', 'Fiyat puanı', 'Ağırlıklı', 'Sıra'], [4.2, 2, 2.4, 1.4, 1.4, 0.8],
    comparison.bids.map((b) => [b.supplierName + (b.supplierStatus !== 'ACTIVE' ? ' (aday)' : ''), b.complete ? 'Tam' : `Eksik: ${b.missingLines.length} kalem`,
      money(b.tco, cur), b.priceScore ?? '—', b.weightedScore ?? (b.scoreGaps.length ? 'Eksik puan' : '—'), b.rank ? String(b.rank) : '—']),
    ['left', 'left', 'right', 'right', 'right', 'right']);
  para('Fiyat puanı = 100 × en düşük uygun TCO / teklif TCO. Karşılaştırılamayan kalemi olan teklif toplam sıralamaya girmez.');

  const gaps = comparison.bids.flatMap((b) => b.lines.filter((l) => l.state !== 'COMPARABLE')
    .map((l) => [b.supplierName, lines.find((x) => x.id === l.projectLineId)?.description ?? '', l.reason]));
  h2('Kapsam farkları');
  if (gaps.length) table(['Tedarikçi', 'Kalem', 'Neden'], [3, 3, 4], gaps); else para('Tüm teklifler tüm kalemlerde karşılaştırılabilir.');

  h2('Kur varsayımları');
  if (fx.length) table(['Para birimi', 'Kur', 'Kaynak', 'Tarih'], [1.2, 1.4, 3, 1.4], fx.map((f) => [f.currency, f.rate, f.source, f.asOf]));
  else para(`Tüm teklifler ${cur}; kur varsayımı yok.`);

  h2('Kazanan tahsisi');
  if (!awards.length) para('Bu değerlendirme sürümüne bağlı tahsis önerisi yok.');
  for (const a of awards) {
    doc.font('b').fontSize(10).fillColor(a.status === 'APPROVED' ? STAMP : INK).text(`Öneri ${a.versionNo} · ${STATUS[a.status] ?? a.status}`);
    doc.moveDown(0.2);
    table(['Kalem', 'Tedarikçi', 'Miktar', 'Birim fiyat', 'Tutar'], [3.2, 3.2, 1.4, 1.8, 1.8],
      a.lines.map((l) => [l.description, l.supplierName, `${Number(l.quantity).toLocaleString('tr-TR')} ${l.unit}`, money(l.unitPrice, cur), money(l.amount, cur)]),
      ['left', 'left', 'right', 'right', 'right']);
    doc.font('b').fontSize(9.5).fillColor(INK).text(`Toplam: ${money(a.total, cur)}`, { width: W, align: 'right' });
    doc.moveDown(0.3);
    para(`Gerekçe: ${a.rationale}`, INK);
    para(`Öneren: ${a.proposedBy} · ${dt(a.proposedAt)}`);
    if (a.decidedBy) para(`${a.status === 'APPROVED' ? 'Onaylayan' : 'Karar veren'}: ${a.decidedBy} · ${dt(a.decidedAt)}${a.decisionNote ? ` · ${a.decisionNote}` : ''}`, a.status === 'APPROVED' ? STAMP : MUTED);
    doc.moveDown(0.5);
  }

  const range = doc.bufferedPageRange();
  for (let i = 0; i < range.count; i++) {
    doc.switchToPage(range.start + i);
    // Alt boşluğa yazılan metin pdfkit'te yeni sayfa açar; altbilgi için boşluk geçici sıfırlanır.
    const bottom = doc.page.margins.bottom;
    doc.page.margins.bottom = 0;
    const y = doc.page.height - 44;
    doc.font('r').fontSize(7.5).fillColor(MUTED)
      .text(`Dayanak parmak izi ${e.basisHash.slice(0, 16)}… · ${e.snapshot.engine} · sayfa ${i + 1}/${range.count}`, 56, y, { width: W, lineBreak: false });
    doc.page.margins.bottom = bottom;
  }
  doc.end();
  return done;
}
