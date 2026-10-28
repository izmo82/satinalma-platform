import { noticeDeadline } from '@sp/domain';
import type { TenantContext, Tx } from '../db.ts';
import { audit } from '../audit.ts';
import { ApiError, conflict, notFound, unprocessable } from '../errors.ts';
import { unapprovedInvoicesWithIssues } from './invoices.ts';

/**
 * Yönetim göstergeleri (02 §19, UX13). Her gösterge tanımı, payı/paydası, kapsamı (dönem + kullanıcının erişebildiği şirketler, RLS),
 * kaynağı ve veri anıyla döner. Para birimleri dönüştürülmez (kur varsayımı yok). Hesaplanamayan gösterge "veri yok" der, uydurulmaz.
 */
export interface Indicator {
  key: string; label: string; definition: string; status: 'OK' | 'NO_DATA' | 'NOT_AVAILABLE';
  values: { currency: string | null; numerator: string; denominator: string; ratio: string | null }[];
  note: string | null; source: string;
}
const MAX_INVOICES = 20_000; // istek yolunda üst sınır; aşılırsa not düşülür, dönem daraltılır
const pct = (n: number, d: number) => (d ? (Math.round((n / d) * 1000) / 10).toFixed(1) : null);

/**
 * Kısa ömürlü sonuç önbelleği (Faz 7 performans): aynı kiracı, aynı şirket kapsamı ve dönem için hesap bir kez yapılır; aynı anda
 * gelen istekler aynı hesabı bekler. Rapor tabloları yalnız kiracı/şirket kapsamıyla (RLS) süzülür, kullanıcıya göre değişmez;
 * anahtar bu kapsamı birebir içerir. Veri anı yanıtta görünür; "fresh" ile yeniden hesaplanır. Süreç içidir (kopya başına).
 */
export class ReportCache {
  private m = new Map<string, { at: number; p: Promise<Computed> }>();
  constructor(private ttlMs: number, private max = 500) {}
  get(key: string, fresh: boolean, compute: () => Promise<Computed>): Promise<Computed> {
    const hit = this.m.get(key);
    if (hit && !fresh && Date.now() - hit.at < this.ttlMs) return hit.p;
    const p = compute();
    if (this.ttlMs <= 0) return p;
    this.m.delete(key);
    if (this.m.size >= this.max) this.m.delete(this.m.keys().next().value!);
    this.m.set(key, { at: Date.now(), p });
    p.catch(() => { if (this.m.get(key)?.p === p) this.m.delete(key); });
    return p;
  }
}
interface Computed { indicators: Indicator[]; dataAsOf: string }

export async function summary(tx: Tx, ctx: TenantContext, q: { from: string; to: string; fresh?: boolean }, cache?: ReportCache) {
  if (q.to < q.from) throw unprocessable('invalid_period', 'Dönem sonu başlangıçtan önce olamaz.');
  const key = [ctx.tenantId, ctx.supplierId ?? '', [...ctx.companyIds].sort().join(','), q.from, q.to].join('|');
  const r = cache ? await cache.get(key, !!q.fresh, () => indicators(tx, q)) : await indicators(tx, q);
  await audit(tx, ctx, 'report.viewed', 'tenant', ctx.tenantId, { report: 'summary', from: q.from, to: q.to });
  return { period: { from: q.from, to: q.to }, scope: { companyIds: ctx.companyIds, note: 'Yalnız erişiminiz olan şirketlerin verisi.' }, dataAsOf: r.dataAsOf, indicators: r.indicators };
}

async function indicators(tx: Tx, q: { from: string; to: string }): Promise<Computed> {
  const dataAsOf = new Date().toISOString();
  const out: Indicator[] = [];

  // Fatura istisna oranı: dönemde tarihli faturalardan kontrolde en az bir bulgusu olan (karar verilmişse karar anındaki bulgular).
  // Onaylananlar onay anındaki bulgularla (SQL'de yalnız var/yok); onaylanmamışlar güncel kontrolle, toplu ve fatura sayısından
  // bağımsız sorgu sayısıyla.
  const inv = (await tx.query<{ id: string; decided: boolean; has_issue: boolean }>(`SELECT i.id, d.issues IS NOT NULL AS decided, coalesce(jsonb_array_length(d.issues) > 0, false) AS has_issue
    FROM invoices i LEFT JOIN invoice_decisions d ON d.invoice_id = i.id AND d.kind = 'APPROVAL'
    WHERE i.issue_date BETWEEN $1 AND $2 AND i.kind <> 'ADVANCE' ORDER BY i.issue_date LIMIT ${MAX_INVOICES}`, [q.from, q.to])).rows;
  const flagged = await unapprovedInvoicesWithIssues(tx, inv.filter((r) => !r.decided).map((r) => r.id));
  const withIssue = inv.filter((r) => (r.decided ? r.has_issue : flagged.has(r.id))).length;
  out.push({ key: 'invoice_exception_rate', label: 'Fatura istisna oranı', definition: 'Kontrole giren faturalardan en az bir açık uyumsuzluğu olanların oranı (onaylananlarda onay anındaki bulgular).',
    status: inv.length ? 'OK' : 'NO_DATA', values: [{ currency: null, numerator: String(withIssue), denominator: String(inv.length), ratio: pct(withIssue, inv.length) }],
    note: inv.length >= MAX_INVOICES ? `Dönemin ilk ${MAX_INVOICES} faturası hesaplandı; dönemi daraltın.` : null, source: 'invoices, invoice_decisions, eşleştirme kontrolü' });

  // Sözleşme kapsamı: onaylı fatura tahsislerinden geçerli sözleşmeye (doğrudan veya sözleşmeli sipariş) bağlı tutarın oranı.
  const cov = (await tx.query<{ currency: string; covered: string; total: string }>(`SELECT i.currency,
      coalesce(sum(CASE WHEN coalesce(po.contract_version_id, a.contract_version_id) IS NOT NULL THEN (CASE i.kind WHEN 'CREDIT_NOTE' THEN -a.amount ELSE a.amount END) END), 0)::numeric(20,2)::text AS covered,
      coalesce(sum(CASE i.kind WHEN 'CREDIT_NOTE' THEN -a.amount ELSE a.amount END), 0)::numeric(20,2)::text AS total
    FROM invoice_allocations a JOIN invoices i ON i.id = a.invoice_id LEFT JOIN po_lines pl ON pl.id = a.po_line_id LEFT JOIN purchase_orders po ON po.id = pl.po_id
    WHERE i.issue_date BETWEEN $1 AND $2 AND i.kind <> 'ADVANCE' AND i.legal_status = 'RECEIVED'
      AND EXISTS (SELECT 1 FROM invoice_decisions d WHERE d.invoice_id = i.id AND d.kind = 'APPROVAL') GROUP BY i.currency ORDER BY i.currency`, [q.from, q.to])).rows;
  out.push({ key: 'contract_coverage', label: 'Sözleşme kapsamı', definition: 'Onaylı fatura tutarının geçerli sözleşmeye (doğrudan veya sözleşmeli sipariş üzerinden) bağlı kısmı.',
    status: cov.length ? 'OK' : 'NO_DATA', values: cov.map((r) => ({ currency: r.currency, numerator: r.covered, denominator: r.total, ratio: Number(r.total) ? pct(Number(r.covered), Number(r.total)) : null })),
    note: 'Para birimleri dönüştürülmedi.', source: 'invoice_allocations, purchase_orders' });

  // Yenileme disiplini: ihbar son günü dönem içinde ve bugünden önce olan doğrulanmış koşullarda, kararın son günden önce verilmesi.
  const terms = (await tx.query<{ id: string; end_date: string; notice_amount: number; notice_unit: 'DAY' | 'MONTH'; rule: 'PREVIOUS_WORKING_DAY' | 'AS_IS'; decided_at: Date | null }>(
    `SELECT t.id, t.end_date::text, t.notice_amount, t.notice_unit, t.non_working_day_rule AS rule, rd.decided_at FROM contract_terms t
     LEFT JOIN renewal_decisions rd ON rd.terms_id = t.id WHERE t.verified_by IS NOT NULL AND t.notice_amount IS NOT NULL AND t.end_date IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM contract_terms t2 WHERE t2.contract_version_id = t.contract_version_id AND t2.revision > t.revision)`)).rows;
  const holidays = (await tx.query<{ day: string }>(`SELECT day::text FROM tenant_holidays`)).rows.map((r) => r.day);
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Istanbul' }).format(new Date());
  let due = 0; let onTime = 0;
  for (const t of terms) {
    const d = noticeDeadline(t.end_date, { amount: t.notice_amount, unit: t.notice_unit, nonWorkingDay: t.rule }, holidays).deadline;
    if (d < q.from || d > q.to || d > today) continue;
    due++;
    if (t.decided_at && new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Istanbul' }).format(t.decided_at) <= d) onTime++;
  }
  out.push({ key: 'renewal_discipline', label: 'Yenileme disiplini', definition: 'İhbar son günü dönemde geçen sözleşmelerden kararı son günden önce verilenlerin oranı.',
    status: due ? 'OK' : 'NO_DATA', values: [{ currency: null, numerator: String(onTime), denominator: String(due), ratio: pct(onTime, due) }], note: null, source: 'contract_terms, renewal_decisions, tenant_holidays' });

  // Açık taahhüt: açık/kapatılmış siparişlerde faturalanmamış kalan tutar (dönemden bağımsız, veri anı itibarıyla).
  const open = (await tx.query<{ currency: string; open: string; ordered: string }>(`SELECT po.currency,
      sum(greatest(round(pl.quantity * pl.unit_price, 2) - coalesce((SELECT sum(CASE i.kind WHEN 'CREDIT_NOTE' THEN -a.amount ELSE a.amount END) FROM invoice_allocations a JOIN invoices i ON i.id = a.invoice_id
        WHERE a.po_line_id = pl.id AND i.legal_status = 'RECEIVED' AND EXISTS (SELECT 1 FROM invoice_decisions d WHERE d.invoice_id = i.id AND d.kind = 'APPROVAL')), 0), 0))::numeric(20,2)::text AS open,
      sum(round(pl.quantity * pl.unit_price, 2))::numeric(20,2)::text AS ordered
    FROM po_lines_current pl JOIN purchase_orders po ON po.id = pl.po_id WHERE po.status <> 'CANCELLED' GROUP BY po.currency ORDER BY po.currency`)).rows;
  out.push({ key: 'open_commitment', label: 'Açık taahhüt', definition: 'Siparişlerde henüz onaylı faturayla tüketilmemiş tutar (veri anı itibarıyla).',
    status: open.length ? 'OK' : 'NO_DATA', values: open.map((r) => ({ currency: r.currency, numerator: r.open, denominator: r.ordered, ratio: Number(r.ordered) ? pct(Number(r.open), Number(r.ordered)) : null })),
    note: 'Para birimleri dönüştürülmedi.', source: 'purchase_orders, po_lines_current, invoice_allocations' });

  // Tedarikçi olayları: dönemde doğrulanan olaylar ve açık düzeltici faaliyetler.
  const incidents = (await tx.query<{ verified: number; total: number; open_actions: number }>(`SELECT count(*) FILTER (WHERE status IN ('VERIFIED','CLOSED') AND verified_at IS NOT NULL AND duplicate_of_id IS NULL AND NOT dispute_open)::int AS verified,
      count(*)::int AS total, (SELECT count(*)::int FROM corrective_actions WHERE status <> 'VERIFIED') AS open_actions FROM supplier_incidents WHERE occurred_on BETWEEN $1 AND $2`, [q.from, q.to])).rows[0]!;
  out.push({ key: 'supplier_incidents', label: 'Doğrulanmış tedarikçi olayı', definition: 'Dönemde yaşanan olaylardan doğrulanmış, itirazı açık olmayan ve mükerrer olmayanlar; iddia ayrı sayılır.',
    status: incidents.total ? 'OK' : 'NO_DATA', values: [{ currency: null, numerator: String(incidents.verified), denominator: String(incidents.total), ratio: pct(incidents.verified, incidents.total) }],
    note: `${incidents.open_actions} açık düzeltici faaliyet.`, source: 'supplier_incidents, corrective_actions' });

  // Otomasyon güvenilirliği: incelenen AI önerilerinden düzeltilmeden onaylananların oranı.
  const ai = (await tx.query<{ reviewed: number; confirmed: number }>(`SELECT count(*) FILTER (WHERE review_state <> 'UNREVIEWED')::int AS reviewed, count(*) FILTER (WHERE review_state = 'CONFIRMED')::int AS confirmed
    FROM extracted_fields WHERE origin = 'AI' AND created_at >= $1::date AND created_at < ($2::date + 1)`, [q.from, q.to])).rows[0]!;
  out.push({ key: 'automation_reliability', label: 'Otomasyon güvenilirliği', definition: 'İnsan incelemesinden geçen AI önerilerinden düzeltilmeden onaylananların oranı.',
    status: ai.reviewed ? 'OK' : 'NO_DATA', values: [{ currency: null, numerator: String(ai.confirmed), denominator: String(ai.reviewed), ratio: pct(ai.confirmed, ai.reviewed) }],
    note: ai.reviewed ? null : 'İncelenmiş AI önerisi yok (izinli AI sağlayıcısı bağlı değil).', source: 'extracted_fields (origin AI)' });

  // Tasarruf: yalnız ikinci kişinin onayladığı karşılaştırılabilir baz (bütçe, önceki fiyat, piyasa) ile dönemde onaylanan seçim tutarı farkı.
  // Baz yoksa proje sayılmaz (en pahalı teklif farkı tasarruf diye raporlanmaz). Para birimleri dönüştürülmez.
  const sav = (await tx.query<{ currency: string; saved: string; base: string; n: number }>(`SELECT b.currency, sum(b.amount - a.total)::numeric(20,2)::text AS saved,
      sum(b.amount)::numeric(20,2)::text AS base, count(*)::int AS n
    FROM savings_baselines b JOIN projects p ON p.id = b.project_id
    JOIN awards a ON a.project_id = b.project_id AND a.status = 'APPROVED'
    WHERE b.status = 'APPROVED' AND b.decided_at < a.decided_at AND b.currency = p.currency AND a.decided_at >= $1::date AND a.decided_at < ($2::date + 1)
    GROUP BY b.currency ORDER BY b.currency`, [q.from, q.to])).rows;
  out.push({ key: 'savings', label: 'Tasarruf', definition: 'Onaylı karşılaştırılabilir baz ile dönemde onaylanan seçim tutarı arasındaki fark (yalnız bazı onaylanmış projeler).',
    status: sav.length ? 'OK' : 'NO_DATA', values: sav.map((r) => ({ currency: r.currency, numerator: r.saved, denominator: r.base, ratio: Number(r.base) ? pct(Number(r.saved), Number(r.base)) : null })),
    note: sav.length ? `${sav.reduce((x, r) => x + r.n, 0)} proje; negatif değer bazın üstünde karar demektir. Para birimleri dönüştürülmedi.` : 'Dönemde onaylı tasarruf bazı olan seçim kararı yok; en pahalı teklif farkı tasarruf diye raporlanmaz.',
    source: 'savings_baselines (iki kişi onaylı), awards' });

  return { indicators: out, dataAsOf };
}

export const csvCell = (v: string | null) => {
  const s = v ?? '';
  // Formül enjeksiyonu kaçışı: hücre =, +, -, @ ile başlıyorsa metin olarak.
  // Düz sayı (negatif dahil) olduğu gibi kalır; yalnız formül başlatabilecek metin kaçışlanır.
  const safe = /^-?\d+([.,]\d+)?$/.test(s) ? s : /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
  return /[";\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
};

/** CSV dışa aktarma: ekranla aynı yetki ve kapsam; dışa aktarım denetim kaydına yazılır. */
export async function summaryCsv(tx: Tx, ctx: TenantContext, q: { from: string; to: string; fresh?: boolean }, cache?: ReportCache) {
  const s = await summary(tx, ctx, q, cache);
  const rows = [['Gösterge', 'Para birimi', 'Pay', 'Payda', 'Oran (%)', 'Durum', 'Not', 'Kaynak', 'Dönem', 'Veri anı']];
  const STATUS_TR = { OK: 'Hesaplandı', NO_DATA: 'Veri yok', NOT_AVAILABLE: 'Hesaplanmıyor' } as const;
  // Türkçe tablo programları ";" ayırıcıyla ondalık virgül bekler.
  const num = (v: string) => (/^-?\d+(\.\d+)?$/.test(v) ? v.replace('.', ',') : v);
  for (const i of s.indicators) {
    const vals = i.values.length ? i.values : [{ currency: null, numerator: '', denominator: '', ratio: null }];
    for (const v of vals) rows.push([i.label, v.currency ?? '', num(v.numerator), num(v.denominator), v.ratio ? num(v.ratio) : '', STATUS_TR[i.status], i.note ?? '', i.source, `${q.from}–${q.to}`, s.dataAsOf]);
  }
  await audit(tx, ctx, 'report.exported', 'tenant', ctx.tenantId, { report: 'summary', format: 'csv', from: q.from, to: q.to });
  return '﻿' + rows.map((r) => r.map(csvCell).join(';')).join('\r\n');
}

// --- Tasarruf bazı kaydı (öneri → ikinci kişi onayı) ---
export async function proposeBaseline(tx: Tx, ctx: TenantContext, projectId: string, b: { basis: 'BUDGET' | 'PREVIOUS_PRICE' | 'MARKET'; amount: string; source: string }) {
  const p = (await tx.query<{ company_id: string; currency: string; status: string }>(`SELECT company_id, currency, status FROM projects WHERE id = $1 FOR UPDATE`, [projectId])).rows[0];
  if (!p) throw notFound();
  // Baz teklifler görülmeden önerilir: değerlendirmeye geçildikten sonra teklif tutarına bakıp baz seçmek tasarrufu uydurmaktır.
  if (!['DRAFT', 'IN_APPROVAL', 'OPEN'].includes(p.status)) throw conflict('project_closed', 'Baz, teklifler açılmadan (taslak, onay veya teklife açık aşamada) önerilir; sonradan tasarruf göstermek için uydurulamaz.');
  if (!/^\d{1,18}(\.\d{1,2})?$/.test(b.amount) || Number(b.amount) <= 0) throw unprocessable('invalid_number', 'Baz tutarı pozitif, en fazla 2 ondalık olmalı.');
  if (b.source.trim().length < 10) throw unprocessable('reason_required', 'Bazın kaynağı gerekli (ör. önceki sözleşme no ve birim fiyat, piyasa araştırması; en az 10 karakter).');
  const r = (await tx.query<{ id: string }>(`INSERT INTO savings_baselines (tenant_id, company_id, project_id, basis, amount, currency, source, proposed_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
    [ctx.tenantId, p.company_id, projectId, b.basis, b.amount, p.currency, b.source.trim(), ctx.userId])).rows[0]!;
  await audit(tx, ctx, 'savings.baseline_proposed', 'project', projectId, { baselineId: r.id, basis: b.basis, amount: b.amount });
  return { id: r.id };
}
export async function decideBaseline(tx: Tx, ctx: TenantContext, id: string, b: { approve: boolean; note?: string }) {
  const x = (await tx.query<{ status: string; proposed_by: string; project_id: string }>(`SELECT status, proposed_by, project_id FROM savings_baselines WHERE id = $1 FOR UPDATE`, [id])).rows[0];
  if (!x) throw notFound();
  // Onay da seçim kararından önce: karar sonrası onaylanan baz rapora girmez, o yüzden reddedilir.
  const ps = (await tx.query<{ status: string }>(`SELECT status FROM projects WHERE id = $1 FOR UPDATE`, [x.project_id])).rows[0]!.status;
  if (['AWARD_APPROVAL', 'CONTRACTING', 'CANCELLED', 'NO_AWARD'].includes(ps)) throw conflict('project_closed', 'Seçim kararı aşamasına geçen projede baz onaylanmaz.');
  if (x.status !== 'PROPOSED') throw conflict('already_decided', 'Bu baz için karar verildi.');
  if (x.proposed_by === ctx.userId) throw new ApiError(403, 'segregation_of_duties', 'Bazı öneren onaylayamaz (görev ayrılığı).');
  if (!b.approve && (b.note ?? '').trim().length < 5) throw unprocessable('note_required', 'Ret gerekçesi gerekli.');
  await tx.query(`UPDATE savings_baselines SET status = $2, decided_by = $3, decided_at = now(), decision_note = $4 WHERE id = $1`, [id, b.approve ? 'APPROVED' : 'REJECTED', ctx.userId, b.note?.trim() || null]);
  await audit(tx, ctx, b.approve ? 'savings.baseline_approved' : 'savings.baseline_rejected', 'project', x.project_id, { baselineId: id }, b.note);
  return { status: b.approve ? 'APPROVED' : 'REJECTED' };
}
export async function projectBaselines(tx: Tx, ctx: TenantContext, projectId: string) {
  return (await tx.query(`SELECT b.id, b.basis, b.amount::text, b.currency, b.source, b.status, pu.display_name AS "proposedBy", b.proposed_by = $2 AS "proposedByMe", b.proposed_at AS "proposedAt",
      du.display_name AS "decidedBy", b.decided_at AS "decidedAt", b.decision_note AS "decisionNote"
    FROM savings_baselines b JOIN users pu ON pu.id = b.proposed_by LEFT JOIN users du ON du.id = b.decided_by WHERE b.project_id = $1 ORDER BY b.proposed_at DESC`, [projectId, ctx.userId])).rows;
}
