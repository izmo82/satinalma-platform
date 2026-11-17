import ExcelJS from 'exceljs';
import { excelRiskToScore, RISK_CRITERIA, RISK_CRITERIA_TR, RISK_MATRIX, scoreToExcelFraction, type CriteriaValues, type RiskCriterion } from '@sp/domain';
import { unprocessable } from './errors.ts';
import { safe } from './reports.ts';

/**
 * v2 Faz 6 (D111) Görev 6: kurumun `BT Tedarikçi Risk Değerlendirme Tablosu` Excel düzeni — içe aktarım için ayrıştırma (R11) ve
 * dışa aktarım (R12). Yalnız `Risk Tablosu` sayfası okunur; formül çalıştırılmaz, I sütununda yalnız Excel'in önbellek değeri okunur.
 * Risk skoru (J) kaynakta 0–1 kesir olarak girilmiştir (başlık "0-100" der): dosyadaki bütün J değerleri ≤ 1 ise kesir ölçeği (×100).
 * Dışa aktarım aynı düzeni yazar (J kesir, I = GEOMEAN formülü + önbellek), böylece dışa → içe gidiş-dönüş aynı değerleri verir.
 */

export const RISK_SHEET = 'Risk Tablosu';
export const RISK_CHART_SHEET = 'Risk Grafiği';
export const RISK_DETAIL_SHEET = 'Seviye ve aksiyonlar';
export const NO_ACTION_TEXT = 'Ek bir aksiyon planı yoktur';
/** R11: bu kalıptaki K metni aksiyon üretmez (kaynakta "yokktur" yazımı da var). */
export const NO_ACTION_RE = /aksiyon plan[ıi] yok/i;

export const COLS = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J', 'K', 'L'] as const;
export type Col = (typeof COLS)[number];
const CRITERIA_COLS: Record<RiskCriterion, Col> = {
  businessImpact: 'C', dataSensitivity: 'D', continuity: 'E', integration: 'F', regulation: 'G', serviceType: 'H',
};

/** Kaynak dosyanın satır 2–4 metinleri (birebir). */
export const GROUP_HEADERS: { range: string; text: string }[] = [
  { range: 'A2:B2', text: 'Tedarikçiler' }, { range: 'C2:H2', text: 'BT Tedarikçi Kritikliği Skorları' }, { range: 'I2:J2', text: 'Tedarikçi Skorları' },
  { range: 'K2', text: 'Aksiyon' }, { range: 'L2', text: 'Ekipler' },
];
export const TABLE_HEADERS: readonly string[] = [
  'Tedarikçi Adı', 'Tedarik Edilen Hizmetler',
  ...RISK_CRITERIA.map((k, i) => `${i + 1}. ${RISK_CRITERIA_TR[k]}`),
  'Kritiklik Skoru', 'Risk Skoru', 'Aksiyon Planları', 'Ekipler',
];
export const TABLE_NOTES: readonly (string | null)[] = [
  'Açık Metin', 'Açık Metin', ...RISK_CRITERIA.map(() => '1,3,5 Değerleri'), '1-5 arası',
  '0-100 arası (Tedarikçi Riski Değerlendirme Şablonu\'ndan gelen sonuç değeri)', 'Açık metin', null,
];
const COL_WIDTHS = [26.54, 44.36, 11.54, 11.54, 11.54, 11.54, 11.54, 11.54, 11.54, 11.54, 25.18, 17.27];

const normHeader = (s: unknown) => String(s ?? '').toLocaleLowerCase('tr').replace(/^\s*\d+\s*[.)]\s*/, '').replace(/\s+/g, ' ').trim();

// ---- hücre değerleri ---------------------------------------------------------------------------------------------------------------

/** Hücrenin JSON'a yazılabilir ham değeri: formül hücresinde formül metni + önbellek sonucu (formül çalıştırılmaz). */
function plainCell(cell: ExcelJS.Cell): unknown {
  const v = cell.value as unknown;
  if (v === null || v === undefined) return null;
  if (v instanceof Date) return v.toISOString();
  if (typeof v === 'object') {
    const o = v as Record<string, unknown>;
    if ('formula' in o || 'sharedFormula' in o || 'result' in o) {
      const r = o.result;
      return { formula: (cell.formula as string | undefined) ?? (o.formula as string | undefined) ?? (o.sharedFormula as string | undefined) ?? null,
        result: r instanceof Date ? r.toISOString() : r && typeof r === 'object' ? ((r as { error?: string }).error ?? null) : (r ?? null) };
    }
    if (Array.isArray(o.richText)) return (o.richText as { text: string }[]).map((t) => t.text).join('');
    if ('text' in o) return String(o.text ?? '');
    if ('error' in o) return { error: String(o.error) };
    return null;
  }
  return v;
}

/** Ham hücreden değer: formül nesnesinde önbellek sonucu. */
const valueOf = (raw: unknown): unknown => (raw && typeof raw === 'object' && 'result' in (raw as object) ? (raw as { result: unknown }).result : raw);
const isEmpty = (raw: unknown) => { const v = valueOf(raw); return v === null || v === undefined || (typeof v === 'string' && v.trim() === ''); };
function numberOf(raw: unknown): number | null {
  const v = valueOf(raw);
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'string') {
    const s = v.trim().replace(/\s/g, '').replace(',', '.');
    if (/^-?\d+(\.\d+)?$/.test(s)) return Number(s);
  }
  return null;
}
function textOf(raw: unknown): string | null {
  const v = valueOf(raw);
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s === '' ? null : s;
}
/** Dışa aktarımın formül kaçışı (`'=…`) içe aktarımda geri alınır. */
const unescapeText = (s: string | null) => (s && /^'[=+\-@]/.test(s) ? s.slice(1) : s);

/** Excel GEOMEAN ile aynı hesap (kayan nokta; 6 hane saklama domain'dedir). */
export function geomean(c: CriteriaValues): number {
  let sum = 0;
  for (const k of RISK_CRITERIA) sum += Math.log(c[k]);
  return Math.exp(sum / RISK_CRITERIA.length);
}

// ---- ayrıştırma (R11) ---------------------------------------------------------------------------------------------------------------

export type RawRow = Record<Col, unknown>;
export interface ParsedRiskRow {
  rowNo: number;
  raw: RawRow;
  name: string | null;
  services: string | null;
  criteria: Partial<CriteriaValues>;
  /** Altı ölçüt de 1/3/5 ise tam. */
  criteriaComplete: boolean;
  excelCriticality: number | null;
  riskScore: string | null;
  actionText: string | null;
  team: string | null;
  issues: string[];
}
export interface ParsedRiskTable { period: string | null; fractionScale: boolean; sheetNames: string[]; rows: ParsedRiskRow[] }

/** Dosya geneli ölçek: J'de 1'den büyük değer yoksa kesir ölçeği (R11). */
export function fractionScaleOf(raws: RawRow[]): boolean {
  return !raws.some((r) => { const n = numberOf(r.J); return n !== null && n > 1; });
}

/** Saklanan ham satırdan alanlar ve satır sorunları (önizleme her okumada aynı sonucu verir). */
export function rowFromRaw(rowNo: number, raw: RawRow, fractionScale: boolean): ParsedRiskRow {
  const issues: string[] = [];
  const name = unescapeText(textOf(raw.A));
  if (!name) issues.push('Tedarikçi adı boş.');
  const criteria: Partial<CriteriaValues> = {};
  let present = 0;
  for (const k of RISK_CRITERIA) {
    const col = CRITERIA_COLS[k];
    if (isEmpty(raw[col])) continue;
    present++;
    const n = numberOf(raw[col]);
    if (n === 1 || n === 3 || n === 5) criteria[k] = n;
    else issues.push(`${col} sütunu (${RISK_CRITERIA_TR[k]}): değer 1, 3 ya da 5 olmalı (bulunan: ${String(valueOf(raw[col]))}).`);
  }
  const valid = Object.keys(criteria).length;
  const criteriaComplete = valid === RISK_CRITERIA.length;
  if (present > 0 && present < RISK_CRITERIA.length) {
    const missing = RISK_CRITERIA.filter((k) => isEmpty(raw[CRITERIA_COLS[k]])).map((k) => RISK_CRITERIA_TR[k]);
    issues.push(`Ölçütler eksik: ${missing.join(', ')}.`);
  }
  const excelCriticality = numberOf(raw.I);
  if (criteriaComplete && excelCriticality !== null) {
    const calc = geomean(criteria as CriteriaValues);
    if (Math.abs(calc - excelCriticality) > 1e-6) {
      issues.push(`Kritiklik Excel'deki değerden farklı (Excel ${excelCriticality.toFixed(4)}, hesap ${calc.toFixed(4)}); hesaplanan değer kullanılır.`);
    }
  }
  let riskScore: string | null = null;
  if (!isEmpty(raw.J)) {
    const n = numberOf(raw.J);
    if (n === null || n < 0) issues.push(`Risk skoru okunamadı (bulunan: ${String(valueOf(raw.J))}).`);
    else {
      const s = excelRiskToScore(n, fractionScale);
      if (Number(s) > 100) issues.push(`Risk skoru 0–100 aralığı dışında (bulunan: ${n}).`);
      else riskScore = s;
    }
  }
  return {
    rowNo, raw, name, services: unescapeText(textOf(raw.B)), criteria, criteriaComplete, excelCriticality, riskScore,
    actionText: unescapeText(textOf(raw.K)), team: unescapeText(textOf(raw.L)), issues,
  };
}

/**
 * `Risk Tablosu` sayfasını okur. Satır 3 başlıkları normalize (tr küçük harf, numara ve boşluk) karşılaştırılır; uymazsa
 * 422 `risk_import_format` (bulunan başlıklar listeli). Veri 5. satırdan; bütün hücreleri boş satır atlanır.
 */
export async function parseRiskTable(buf: Buffer): Promise<ParsedRiskTable> {
  const wb = new ExcelJS.Workbook();
  try {
    await wb.xlsx.load(buf as unknown as ArrayBuffer);
  } catch {
    throw unprocessable('risk_import_format', 'Dosya okunamadı; Excel (.xlsx) dosyası yükleyin.');
  }
  const sheetNames = wb.worksheets.map((w) => w.name);
  const ws = wb.getWorksheet(RISK_SHEET);
  if (!ws) throw unprocessable('risk_import_format', `"${RISK_SHEET}" sayfası bulunamadı.`, { expectedSheet: RISK_SHEET, foundSheets: sheetNames });
  const found = COLS.map((c) => textOf(plainCell(ws.getCell(`${c}3`))));
  const ok = TABLE_HEADERS.every((h, i) => normHeader(h) === normHeader(found[i]));
  if (!ok) {
    throw unprocessable('risk_import_format', `"${RISK_SHEET}" sayfasının 3. satır başlıkları beklenen düzende değil.`,
      { expectedHeaders: TABLE_HEADERS, foundHeaders: found });
  }
  const b1 = textOf(plainCell(ws.getCell('B1')));
  const period = b1 && /^\d{4}-[1-4]$/.test(b1) ? b1 : null;
  const raws: { rowNo: number; raw: RawRow }[] = [];
  for (let r = 5; r <= ws.rowCount; r++) {
    const row = ws.getRow(r);
    const raw = Object.fromEntries(COLS.map((c, i) => [c, plainCell(row.getCell(i + 1))])) as RawRow;
    if (COLS.every((c) => isEmpty(raw[c]))) continue;
    raws.push({ rowNo: r, raw });
  }
  const fractionScale = fractionScaleOf(raws.map((x) => x.raw));
  return { period, fractionScale, sheetNames, rows: raws.map((x) => rowFromRaw(x.rowNo, x.raw, fractionScale)) };
}

// ---- dışa aktarım (R12) -------------------------------------------------------------------------------------------------------------

export interface RiskExportAction { kind: string; title: string; owner: string | null; dueOn: string | null; status: string; method: string | null }
export interface RiskExportRow {
  name: string; services: string | null; criteria: Partial<CriteriaValues> | null; riskScore: string | null; actionTitles: string[]; team: string | null;
  detail: {
    year: number; department: string | null; criticality: string | null; column: number | null; level: number | null; levelLabel: string | null;
    status: string; scoreSource: string | null; lastReview: string | null; actions: RiskExportAction[]; methodVersion: string | null;
  };
}

const BORDER: Partial<ExcelJS.Borders> = { top: { style: 'thin' }, left: { style: 'thin' }, bottom: { style: 'thin' }, right: { style: 'thin' } };
const HEAD_FONT: Partial<ExcelJS.Font> = { bold: true, size: 10, color: { argb: 'FFFFFFFF' }, name: 'Calibri' };
const fill = (argb: string): ExcelJS.Fill => ({ type: 'pattern', pattern: 'solid', fgColor: { argb } });
const LEVEL_FILL: Record<number, string> = { 1: 'FF00B050', 2: 'FF92D050', 3: 'FFFFFF00', 4: 'FFFFC000', 5: 'FFFF0000' };

/** R12: kaynak düzende `Risk Tablosu` + `Risk Grafiği` + `Seviye ve aksiyonlar`. Metin hücreleri formül enjeksiyonuna karşı `safe`. */
export async function riskTableWorkbook(input: { period: string; year: number; rows: RiskExportRow[] }): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Satınalma ve Sözleşme';
  const ws = wb.addWorksheet(RISK_SHEET);
  ws.columns = COL_WIDTHS.map((width) => ({ width }));
  ws.getCell('A1').value = 'Dönem:';
  ws.getCell('B1').value = safe(input.period);
  ws.getCell('A1').font = { bold: true };
  for (const g of GROUP_HEADERS) {
    if (g.range.includes(':')) ws.mergeCells(g.range);
    const c = ws.getCell(g.range.split(':')[0]!);
    c.value = g.text;
  }
  COLS.forEach((col, i) => {
    const g = ws.getCell(`${col}2`);
    g.font = HEAD_FONT; g.fill = fill('FF1F3864'); g.border = BORDER; g.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true };
    const h = ws.getCell(`${col}3`);
    h.value = TABLE_HEADERS[i]!;
    h.font = HEAD_FONT; h.fill = fill('FF0070C0'); h.border = BORDER; h.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true };
    const n = ws.getCell(`${col}4`);
    if (TABLE_NOTES[i]) n.value = TABLE_NOTES[i]!;
    n.font = { italic: true, size: 9 }; n.border = BORDER; n.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true };
  });
  let r = 5;
  for (const row of input.rows) {
    const x = ws.getRow(r);
    x.getCell(1).value = safe(row.name);
    x.getCell(2).value = row.services ? safe(row.services) : null;
    const crit = row.criteria ?? {};
    RISK_CRITERIA.forEach((k, i) => { x.getCell(3 + i).value = crit[k] ?? null; });
    const full = RISK_CRITERIA.every((k) => crit[k] === 1 || crit[k] === 3 || crit[k] === 5);
    x.getCell(9).value = full ? { formula: `GEOMEAN(C${r}:H${r})`, result: geomean(crit as CriteriaValues) } : null;
    x.getCell(9).numFmt = '0.00';
    x.getCell(10).value = row.riskScore !== null ? scoreToExcelFraction(row.riskScore) : null;
    x.getCell(11).value = safe(row.actionTitles.length ? row.actionTitles.join('; ') : NO_ACTION_TEXT);
    x.getCell(12).value = row.team ? safe(row.team) : null;
    for (let c = 1; c <= 12; c++) {
      const cell = x.getCell(c);
      cell.border = BORDER; cell.font = { size: 10 };
      cell.alignment = { horizontal: c <= 2 || c >= 11 ? 'left' : 'center', vertical: 'middle', wrapText: true };
    }
    r++;
  }
  ws.autoFilter = `A4:L${Math.max(4, r - 1)}`;

  // Risk Grafiği: C3 başlık, C5:C9 bant üst sınırları (100 … 20), D10:H10 kritiklik 1–5, hücrede seviye (Excel ile birebir).
  const g = wb.addWorksheet(RISK_CHART_SHEET);
  g.getCell('C3').value = 'Risk Grafiği';
  g.getCell('C3').font = { bold: true, size: 14 };
  for (let band = 5; band >= 1; band--) {
    const rowNo = 5 + (5 - band);
    g.getCell(`C${rowNo}`).value = band * 20;
    g.getCell(`C${rowNo}`).font = { bold: true };
    for (let col = 1; col <= 5; col++) {
      const level = RISK_MATRIX[band - 1]![col - 1]!;
      const cell = g.getRow(rowNo).getCell(3 + col);
      cell.value = level;
      cell.fill = fill(LEVEL_FILL[level]!);
      cell.border = BORDER;
      cell.alignment = { horizontal: 'center', vertical: 'middle' };
    }
  }
  for (let col = 1; col <= 5; col++) {
    const cell = g.getRow(10).getCell(3 + col);
    cell.value = col;
    cell.font = { bold: true };
    cell.alignment = { horizontal: 'center' };
  }
  g.getCell('B7').value = 'Risk skoru';
  g.getCell('F11').value = 'Kritiklik skoru';
  g.columns = [{ width: 4 }, { width: 12 }, { width: 8 }, { width: 8 }, { width: 8 }, { width: 8 }, { width: 8 }, { width: 8 }];

  // Seviye ve aksiyonlar: platformun hesapladığı değerler (Excel'de seviye sütunu yok).
  const d = wb.addWorksheet(RISK_DETAIL_SHEET);
  d.columns = [
    { header: 'Tedarikçi', width: 34 }, { header: 'Yıl', width: 8 }, { header: 'Dönem', width: 9 }, { header: 'Departman', width: 24 },
    { header: 'Kritiklik', width: 10 }, { header: 'Sütun', width: 8 }, { header: 'Risk skoru (0–100)', width: 12 }, { header: 'Seviye', width: 8 },
    { header: 'Seviye adı', width: 24 }, { header: 'Durum', width: 14 }, { header: 'Skor kaynağı', width: 24 }, { header: 'Son gözden geçirme', width: 22 },
    { header: 'Aksiyonlar (sahip, tarih, durum)', width: 70 }, { header: 'Yöntem sürümü', width: 26 },
  ];
  d.getRow(1).font = { bold: true };
  d.views = [{ state: 'frozen', ySplit: 1 }];
  for (const row of input.rows) {
    const t = row.detail;
    const acts = t.actions.map((a) => [a.kind === 'CONTROL' ? `Kontrol${a.method ? ` (${a.method})` : ''}` : 'Aksiyon', a.title,
      a.owner ?? 'Sahip yok', a.dueOn ?? 'Tarih yok', a.status].join(' · ')).join('\n');
    const x = d.addRow([safe(row.name), t.year, safe(input.period), t.department ? safe(t.department) : null,
      t.criticality !== null ? Number(t.criticality) : null, t.column, row.riskScore !== null ? Number(row.riskScore) : null, t.level,
      t.levelLabel ? safe(t.levelLabel) : null, safe(t.status), t.scoreSource ? safe(t.scoreSource) : null, t.lastReview ? safe(t.lastReview) : null,
      acts ? safe(acts) : null, t.methodVersion ? safe(t.methodVersion) : null]);
    x.getCell(5).numFmt = '0.00';
    x.getCell(7).numFmt = '0.00';
    x.getCell(13).alignment = { wrapText: true, vertical: 'top' };
  }
  return Buffer.from(await wb.xlsx.writeBuffer());
}
