import {
  advanceFinding, claimDraft, earlyPaymentFinding, evidenceGaps, fxDifferenceFinding, guaranteeFinding, isClaimable, isFxDifferenceText, sumByCurrency,
  RECOVERY_CATEGORY, cmp, dec, str, type EvidenceGap, type Finding, type RecoveryKind,
} from '@sp/domain';
import type { TenantContext, Tx } from '../db.ts';
import { audit } from '../audit.ts';
import { nextCode } from '../codes.ts';
import { closeTasks, openTask } from '../tasks.ts';
import { conflict, notFound, unprocessable } from '../errors.ts';

/**
 * Lira Defteri (D80): harcamanın kanıt zinciri ve kurallı geri kazanım bulguları. Tarama yalnız kullanıcının şirket kapsamındaki
 * kayıtları okur (RLS). Bulgu öneridir: doğrulama, talep, tahsil ve kapatma insan kaydıdır ve denetime yazılır.
 */

const APPROVED = `EXISTS (SELECT 1 FROM invoice_decisions d WHERE d.invoice_id = i.id AND d.kind = 'APPROVAL') AND i.legal_status = 'RECEIVED'`;
const NET = `(SELECT coalesce(sum(l.net_amount), 0) FROM invoice_lines l WHERE l.invoice_id = i.id)`;
// Faturanın bağlı olduğu sözleşme: tahsisteki sözleşme ya da tahsis edilen siparişin sözleşmesi (ilk bulunan).
const INVOICE_CONTRACT = `(SELECT coalesce(a.contract_version_id, po.contract_version_id) FROM invoice_allocations a
  LEFT JOIN po_lines pl ON pl.id = a.po_line_id LEFT JOIN purchase_orders po ON po.id = pl.po_id
  WHERE a.invoice_id = i.id AND coalesce(a.contract_version_id, po.contract_version_id) IS NOT NULL ORDER BY a.line_no LIMIT 1)`;
const FX_LINE = `translate(l.description, 'ıİI', 'iii') ~* 'kur\\s*fark'`;
// Faturaya karşı onaylı iade faturalarının net toplamı (tedarikçinin zaten geri verdiği).
const CREDITED = `(SELECT coalesce(sum(cl.net_amount), 0) FROM invoices cn JOIN invoice_lines cl ON cl.invoice_id = cn.id
  WHERE cn.kind = 'CREDIT_NOTE' AND cn.original_invoice_id = i.id AND cn.legal_status = 'RECEIVED'
    AND EXISTS (SELECT 1 FROM invoice_decisions d WHERE d.invoice_id = cn.id AND d.kind = 'APPROVAL'))::text`;
/** Erken ödeme yalnız son 24 ayda ödenen faturalarda aranır (tarama süresi geçmişle büyümesin). */
const EARLY_PAYMENT_MONTHS = 24;
const earlyFrom = (day: string) => { const d = new Date(`${day}T00:00:00Z`); d.setUTCMonth(d.getUTCMonth() - EARLY_PAYMENT_MONTHS); return d.toISOString().slice(0, 10); };
// Takvim günü İstanbul saatine göre.
const today = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Istanbul' }).format(new Date());

interface ContractInfo { id: string; title: string; sourceRef: string; paymentTerms: string; endDate: string | null; paymentDays: number | null; fxDifference: 'ALLOWED' | 'NOT_ALLOWED' | null; verified: boolean }

/** Sözleşme sürümlerinin son doğrulanmış koşulları (doğrulanmamış koşul kanıt sayılmaz; kural ona dayanmaz). */
async function contracts(tx: Tx, ids: string[]): Promise<Map<string, ContractInfo>> {
  const rows = (await tx.query<{ id: string; title: string; source_ref: string | null; payment_terms: string | null; end_date: string | null; payment_days: number | null; fx_difference: ContractInfo['fxDifference'] }>(
    `SELECT cv.id, f.title, t.source_ref, t.payment_terms, t.end_date::text, t.payment_days, t.fx_difference FROM contract_versions cv JOIN contract_families f ON f.id = cv.family_id
     LEFT JOIN LATERAL (SELECT * FROM contract_terms t WHERE t.contract_version_id = cv.id AND t.verified_at IS NOT NULL ORDER BY t.revision DESC LIMIT 1) t ON true
     WHERE cv.id = ANY($1::uuid[])`, [ids])).rows;
  return new Map(rows.map((r) => [r.id, { id: r.id, title: r.title, sourceRef: r.source_ref ?? '', paymentTerms: r.payment_terms ?? '', endDate: r.end_date, paymentDays: r.payment_days,
    fxDifference: r.fx_difference, verified: r.source_ref !== null }]));
}

/** Tarihteki kur: o gün yoksa en fazla 7 gün önceki son kur (hafta sonu/tatil). Yoksa null; uydurulmaz. */
async function rateOn(tx: Tx, currency: string, date: string): Promise<string | null> {
  return (await tx.query<{ rate: string }>(`SELECT trim_scale(rate)::text AS rate FROM fx_rates WHERE currency = $1 AND rate_date <= $2 AND rate_date >= $2::date - 7
    ORDER BY rate_date DESC LIMIT 1`, [currency, date])).rows[0]?.rate ?? null;
}

interface Subject { finding: Finding; companyId: string; supplierId: string; invoiceId: string | null; guaranteeId: string | null }

async function detect(tx: Tx): Promise<Subject[]> {
  const out: Subject[] = [];
  const day = today();
  const rate = (await tx.query<{ r: string }>(`SELECT trim_scale(capital_cost_rate)::text AS r FROM recovery_settings`)).rows[0]?.r ?? null;

  // 1) Kur farkı faturaları: onaylı faturada "kur farkı" satırı.
  // Tutar yalnız "kur farkı" satırlarıdır (aynı faturadaki mal/hizmet bedeli dahil edilmez); onaylı iade faturaları düşülür.
  const fxInv = (await tx.query<{ id: string; no: string; issue_date: string; currency: string; net: string; credited: string; company_id: string; supplier_id: string; text: string; cv: string | null }>(
    `SELECT i.id, i.invoice_no AS no, i.issue_date::text, i.currency,
       (SELECT coalesce(sum(l.net_amount), 0) FROM invoice_lines l WHERE l.invoice_id = i.id AND ${FX_LINE})::text AS net, ${CREDITED} AS credited,
       i.company_id, i.supplier_id, (SELECT string_agg(description, ' ') FROM invoice_lines l WHERE l.invoice_id = i.id) AS text, ${INVOICE_CONTRACT} AS cv
     FROM invoices i WHERE i.kind = 'INVOICE' AND ${APPROVED} AND EXISTS (SELECT 1 FROM invoice_lines l WHERE l.invoice_id = i.id AND ${FX_LINE})`)).rows
    .filter((r) => isFxDifferenceText(r.text));
  // 2) Avanslar: onaylı avans faturaları, mahsup toplamı ve son mahsup tarihi.
  const adv = (await tx.query<{ id: string; no: string; issue_date: string; currency: string; net: string; company_id: string; supplier_id: string; offset_total: string; last_offset: string | null; credited: string; cv: string | null }>(
    `SELECT i.id, i.invoice_no AS no, i.issue_date::text, i.currency, ${NET}::text AS net, i.company_id, i.supplier_id,
       (SELECT coalesce(sum(o.advance_offset), 0)::text FROM invoices o WHERE o.advance_invoice_id = i.id AND EXISTS (SELECT 1 FROM invoice_decisions d WHERE d.invoice_id = o.id AND d.kind = 'APPROVAL') AND o.legal_status = 'RECEIVED') AS offset_total,
       (SELECT max(o.issue_date)::text FROM invoices o WHERE o.advance_invoice_id = i.id AND EXISTS (SELECT 1 FROM invoice_decisions d WHERE d.invoice_id = o.id AND d.kind = 'APPROVAL') AND o.legal_status = 'RECEIVED') AS last_offset,
       ${CREDITED} AS credited, ${INVOICE_CONTRACT} AS cv
     FROM invoices i WHERE i.kind = 'ADVANCE' AND ${APPROVED}`)).rows;
  // 3) Ödenmiş faturalar (ödeme tarihi biliniyorsa); ödenen tutar ERP'ye gidenle aynı ifade (KDV hariç; ihtiyatlı).
  const paid = rate ? (await tx.query<{ id: string; no: string; issue_date: string; paid_at: string; currency: string; payable: string; company_id: string; supplier_id: string; cv: string | null }>(
    `SELECT i.id, i.invoice_no AS no, i.issue_date::text, i.paid_at::text, i.currency, (${NET} - i.advance_offset)::numeric(20,2)::text AS payable, i.company_id, i.supplier_id, ${INVOICE_CONTRACT} AS cv
     FROM invoices i WHERE i.kind = 'INVOICE' AND i.paid_at >= $1 AND ${APPROVED}`, [earlyFrom(day)])).rows : [];
  // 4) İade edilmemiş teminatlar.
  const guar = (await tx.query<{ id: string; kind: string; reference_no: string; issuer: string; amount: string; currency: string; valid_until: string | null; company_id: string; cv: string; supplier_id: string | null }>(
    `SELECT g.id, g.kind, g.reference_no, g.issuer, g.amount::text, g.currency, g.valid_until::text, g.company_id, g.contract_version_id AS cv,
       (SELECT supplier_id FROM contract_families f JOIN contract_versions v ON v.family_id = f.id WHERE v.id = g.contract_version_id) AS supplier_id
     FROM contract_guarantees g WHERE g.returned_at IS NULL AND g.valid_until IS NOT NULL`)).rows;

  const cvIds = [...new Set([...fxInv, ...adv, ...paid, ...guar].map((r) => r.cv).filter((x): x is string => !!x))];

  // Ait olduğu döviz faturalar: açıklamada numarası geçen, aynı tedarikçinin geçerli (iptal/ret edilmemiş) döviz faturalarının tümü.
  type Orig = { id: string; no: string; currency: string; net: string; issue_date: string; paid_at: string | null; cv: string | null };
  const originals = new Map<string, Orig[]>();
  for (const r of fxInv) {
    const os = (await tx.query<Orig>(
      `SELECT i.id, i.invoice_no AS no, i.currency, ${NET}::text AS net, i.issue_date::text, i.paid_at::text, ${INVOICE_CONTRACT} AS cv FROM invoices i
       WHERE i.supplier_id = $1 AND i.id <> $2 AND i.currency <> $3 AND i.kind = 'INVOICE' AND i.legal_status = 'RECEIVED'
         AND NOT EXISTS (SELECT 1 FROM invoice_decisions d WHERE d.invoice_id = i.id AND d.kind = 'REJECTION')
         AND position(upper(i.invoice_no) in upper($4)) > 0 ORDER BY i.issue_date`, [r.supplier_id, r.id, r.currency, r.text])).rows;
    for (const o of os) if (o.cv) cvIds.push(o.cv);
    originals.set(r.id, os);
  }
  const cmap = await contracts(tx, [...new Set(cvIds)]);

  for (const r of fxInv) {
    const os = originals.get(r.id)!;
    const c = cmap.get(r.cv ?? os.find((o) => o.cv)?.cv ?? '') ?? null;
    const f = fxDifferenceFinding({
      invoice: { id: r.id, no: r.no, issueDate: r.issue_date, currency: r.currency, net: r.net }, credited: r.credited,
      contract: c && { id: c.id, title: c.title, sourceRef: c.sourceRef, rule: c.verified ? c.fxDifference : null },
      originals: await Promise.all(os.map(async (o) => ({ id: o.id, no: o.no, currency: o.currency, net: o.net, issueDate: o.issue_date, paidAt: o.paid_at,
        rateAtIssue: await rateOn(tx, o.currency, o.issue_date), rateAtPayment: o.paid_at ? await rateOn(tx, o.currency, o.paid_at) : null }))),
    });
    if (f) out.push({ finding: f, companyId: r.company_id, supplierId: r.supplier_id, invoiceId: r.id, guaranteeId: null });
  }
  for (const r of adv) {
    const c = r.cv ? cmap.get(r.cv) ?? null : null;
    const f = advanceFinding({ advance: { id: r.id, no: r.no, issueDate: r.issue_date, currency: r.currency, net: r.net }, offsetTotal: r.offset_total, credited: r.credited,
      lastOffsetDate: r.last_offset, contract: c && { id: c.id, title: c.title, endDate: c.endDate }, today: day });
    if (f) out.push({ finding: f, companyId: r.company_id, supplierId: r.supplier_id, invoiceId: r.id, guaranteeId: null });
  }
  for (const r of paid) {
    const c = r.cv ? cmap.get(r.cv) ?? null : null;
    const f = earlyPaymentFinding({ invoice: { id: r.id, no: r.no, issueDate: r.issue_date, paidAt: r.paid_at, currency: r.currency, payable: r.payable },
      contract: c?.verified ? { id: c.id, title: c.title, paymentTerms: c.paymentTerms, paymentDays: c.paymentDays } : null, annualRate: rate });
    if (f) out.push({ finding: { ...f, basis: { ...f.basis, note: 'KDV hariç ödenen tutar üzerinden (ihtiyatlı)' } }, companyId: r.company_id, supplierId: r.supplier_id, invoiceId: r.id, guaranteeId: null });
  }
  for (const r of guar) {
    const c = cmap.get(r.cv)!;
    if (!r.supplier_id) continue; // tedarikçisi bağlanmamış sözleşme: vaka tedarikçiye bağlanamaz
    const f = guaranteeFinding({ guarantee: { id: r.id, kind: r.kind, referenceNo: r.reference_no, issuer: r.issuer, amount: r.amount, currency: r.currency, validUntil: r.valid_until },
      contract: { id: c.id, title: c.title, endDate: c.verified ? c.endDate : null }, today: day });
    if (f) out.push({ finding: f, companyId: r.company_id, supplierId: r.supplier_id, invoiceId: null, guaranteeId: r.id });
  }
  return out;
}

const TASK_KIND: Partial<Record<RecoveryKind, { title: string; next: string }>> = {
  FX_DIFF_NOT_ALLOWED: { title: 'Geri alınacak para', next: 'Bulguyu doğrulayın; doğruysa tedarikçiye talep gönderin.' },
  FX_DIFF_EXCESS: { title: 'Geri alınacak para', next: 'Bulguyu doğrulayın; doğruysa tedarikçiye talep gönderin.' },
  ADVANCE_UNOFFSET: { title: 'Mahsup edilmemiş avans', next: 'Bakiyeyi doğrulayın; sonraki faturadan mahsup veya iade isteyin.' },
  GUARANTEE_EXPIRY: { title: 'Teminat bitiyor', next: 'Tedarikçiden teminat uzatması isteyin veya sözleşmeye göre karar verin.' },
  FX_DIFF_UNVERIFIED: { title: 'Kur farkı faturası incelenmeli', next: 'Sözleşmedeki kur farkı hükmünü ve kur verisini tamamlayın.' },
};

async function caseTask(tx: Tx, ctx: TenantContext, id: string, code: string, companyId: string, f: Finding) {
  const t = TASK_KIND[f.kind];
  if (!t) return;
  await openTask(tx, ctx, { companyId, kind: 'recovery_case', entityType: 'recovery_case', entityId: id, title: `${t.title}: ${code}`,
    reason: f.summary, nextAction: t.next, assigneeRole: f.kind === 'GUARANTEE_EXPIRY' ? 'FINANCE' : 'BUYER',
    severity: f.kind === 'GUARANTEE_EXPIRY' && (f.basis as any).expired ? 'HIGH' : 'NORMAL', dedupeKey: `recovery:${id}` });
}

/** Tarama: bulguları vakalara yazar. Açık vaka güncellenir; üzerinde çalışılan vaka değişmez; artık geçerli olmayan açık vaka "kendiliğinden çözüldü" olur. */
export async function scan(tx: Tx, ctx: TenantContext) {
  // Aynı kiracıda eşzamanlı iki tarama seri işlenir (aynı konu için iki vaka açılmaz).
  await tx.query(`SELECT pg_advisory_xact_lock(hashtextextended('sp-recovery-scan:' || $1, 0))`, [ctx.tenantId]);
  const found = await detect(tx);
  let created = 0, updated = 0, inProgress = 0, closed = 0;
  for (const s of found) {
    const f = s.finding;
    const ex = (await tx.query<{ id: string; status: string; code: string; kind: RecoveryKind; amount: string | null }>(
      `SELECT id, status, code, kind, amount::text FROM recovery_cases WHERE subject_key = $1 FOR UPDATE`, [f.subjectKey])).rows[0];
    if (!ex) {
      const code = await nextCode(tx, ctx, 'recovery', 'GRK');
      const id = (await tx.query<{ id: string }>(`INSERT INTO recovery_cases (tenant_id, company_id, code, subject_key, kind, supplier_id, invoice_id, contract_version_id, guarantee_id,
          amount, currency, summary, basis) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING id`,
        [ctx.tenantId, s.companyId, code, f.subjectKey, f.kind, s.supplierId, s.invoiceId, f.contractVersionId, s.guaranteeId, f.amount, f.currency, f.summary, f.basis])).rows[0]!.id;
      created++;
      await caseTask(tx, ctx, id, code, s.companyId, f);
    } else if (ex.status === 'OPEN' && ex.amount !== null && f.amount === null) {
      // Hesaplanmış tutar "incelenmeli"ye düşürülmez: dar şirket kapsamlı kullanıcı ait olduğu faturayı/sözleşmeyi göremeyebilir.
      await tx.query(`UPDATE recovery_cases SET last_seen_at = now() WHERE id = $1`, [ex.id]);
      inProgress++;
    } else if (ex.status === 'OPEN' || ex.status === 'OBSOLETE') {
      await tx.query(`UPDATE recovery_cases SET kind = $2, amount = $3, currency = $4, summary = $5, basis = $6, contract_version_id = $7, status = 'OPEN', last_seen_at = now() WHERE id = $1`,
        [ex.id, f.kind, f.amount, f.currency, f.summary, f.basis, f.contractVersionId]);
      updated++;
      // Yeniden açılan veya türü değişen vakanın görevi güncel olsun (kapanmış görev yeniden açılır, eski başlıklı görev kapanır).
      if (ex.status === 'OBSOLETE' || ex.kind !== f.kind) {
        await closeTasks(tx, `recovery:${ex.id}`);
        await caseTask(tx, ctx, ex.id, ex.code, s.companyId, f);
      }
    } else if (ex.status === 'CONFIRMED' || ex.status === 'CLAIMED') {
      await tx.query(`UPDATE recovery_cases SET last_seen_at = now() WHERE id = $1`, [ex.id]);
      inProgress++;
    } else {
      closed++; // RECOVERED / DISMISSED: değişmez
    }
  }
  const keys = found.map((s) => s.finding.subjectKey);
  // Koşulu kalmayan açık vaka ve "ele alınmış" teminat vakası kendiliğinden çözülür (teminat uzatıldı/iade edildi). Tarama penceresi
  // dışında kalan erken ödeme vakası penceresi dışında kaldığı için çözülmüş sayılmaz.
  const gone = (await tx.query<{ id: string }>(`UPDATE recovery_cases c SET status = 'OBSOLETE'
    WHERE (c.status = 'OPEN' OR (c.status = 'CONFIRMED' AND c.kind = 'GUARANTEE_EXPIRY')) AND NOT (c.subject_key = ANY($1::text[]))
      AND NOT (c.kind = 'EARLY_PAYMENT' AND EXISTS (SELECT 1 FROM invoices i WHERE i.id = c.invoice_id AND i.paid_at < $2))
    RETURNING c.id`, [keys, earlyFrom(today())])).rows;
  for (const g of gone) await closeTasks(tx, `recovery:${g.id}`);
  await audit(tx, ctx, 'recovery.scanned', 'tenant', ctx.tenantId, { found: found.length, created, updated, inProgress, closed, obsolete: gone.length });
  return { found: found.length, created, updated, inProgress, closed, obsolete: gone.length };
}

const CASE_COLS = `c.id, c.code, c.kind, c.status, c.amount::text, c.currency, c.summary, c.detected_at AS "detectedAt", c.last_seen_at AS "lastSeenAt",
  c.supplier_id AS "supplierId", s.legal_name AS "supplierName", c.invoice_id AS "invoiceId", i.invoice_no AS "invoiceNo", c.contract_version_id AS "contractVersionId",
  f.title AS "contractTitle", c.guarantee_id AS "guaranteeId", c.recovered_amount::text AS "recoveredAmount"`;
const CASE_FROM = `FROM recovery_cases c JOIN suppliers s ON s.id = c.supplier_id LEFT JOIN invoices i ON i.id = c.invoice_id
  LEFT JOIN contract_versions cv ON cv.id = c.contract_version_id LEFT JOIN contract_families f ON f.id = cv.family_id`;

export async function listCases(tx: Tx) {
  const items = (await tx.query(`SELECT ${CASE_COLS} ${CASE_FROM} ORDER BY (c.status IN ('OPEN','CONFIRMED','CLAIMED')) DESC, c.amount DESC NULLS LAST, c.detected_at DESC LIMIT 500`)).rows;
  return items.map((c: any) => ({ ...c, category: RECOVERY_CATEGORY[c.kind as RecoveryKind] }));
}

export async function getCase(tx: Tx, ctx: TenantContext, id: string) {
  const c = (await tx.query(`SELECT ${CASE_COLS}, c.basis, c.company_id AS "companyId", le.name AS "companyName", c.claim_note AS "claimNote", c.recovered_note AS "recoveredNote",
      c.dismiss_reason AS "dismissReason", c.confirmed_at AS "confirmedAt", uc.display_name AS "confirmedBy", c.claimed_at AS "claimedAt", ucl.display_name AS "claimedBy",
      c.recovered_at AS "recoveredAt", ur.display_name AS "recoveredBy", c.dismissed_at AS "dismissedAt", ud.display_name AS "dismissedBy"
    ${CASE_FROM} JOIN legal_entities le ON le.id = c.company_id LEFT JOIN users uc ON uc.id = c.confirmed_by LEFT JOIN users ucl ON ucl.id = c.claimed_by
    LEFT JOIN users ur ON ur.id = c.recovered_by LEFT JOIN users ud ON ud.id = c.dismissed_by WHERE c.id = $1`, [id])).rows[0];
  if (!c) throw notFound();
  const kind = c.kind as RecoveryKind;
  return { ...c, category: RECOVERY_CATEGORY[kind], claimable: isClaimable(kind) && c.amount !== null,
    claimDraft: claimDraft({ kind, code: c.code, amount: c.amount, currency: c.currency, supplierName: c.supplierName, companyName: c.companyName, basis: c.basis, date: today() }) };
}

async function lockCase(tx: Tx, id: string) {
  const c = (await tx.query<{ id: string; code: string; kind: RecoveryKind; status: string; amount: string | null; currency: string; company_id: string }>(
    `SELECT id, code, kind, status, amount::text, currency, company_id FROM recovery_cases WHERE id = $1 FOR UPDATE`, [id])).rows[0];
  if (!c) throw notFound();
  return c;
}
const wrongState = (now: string) => conflict('case_state', `Vaka bu işlem için uygun durumda değil (şu an: ${now}). Sayfayı yenileyin.`);

/** Doğrula: bulgu kontrol edildi ve geçerli (tutar ve kanıt). Geri alınamayan türlerde "ele alındı" anlamındadır. */
export async function confirmCase(tx: Tx, ctx: TenantContext, id: string) {
  const c = await lockCase(tx, id);
  if (c.status !== 'OPEN') throw wrongState(c.status);
  if (c.kind === 'FX_DIFF_UNVERIFIED') throw unprocessable('not_verifiable', 'Tutarı hesaplanamamış bulgu doğrulanamaz: önce sözleşmedeki kur farkı hükmünü ve kur verisini tamamlayıp yeniden tarayın, ya da gerekçeyle kapatın.');
  await tx.query(`UPDATE recovery_cases SET status = 'CONFIRMED', confirmed_by = $2, confirmed_at = now() WHERE id = $1`, [id, ctx.userId]);
  if (!isClaimable(c.kind)) await closeTasks(tx, `recovery:${id}`);
  await audit(tx, ctx, 'recovery.confirmed', 'recovery_case', id, { code: c.code, amount: c.amount, currency: c.currency });
  return { status: 'CONFIRMED' };
}

export async function claimCase(tx: Tx, ctx: TenantContext, id: string, note: string) {
  const c = await lockCase(tx, id);
  if (!isClaimable(c.kind)) throw unprocessable('not_claimable', 'Bu bulgu türü tedarikçiden talep edilmez.');
  if (c.status !== 'CONFIRMED') throw wrongState(c.status);
  await tx.query(`UPDATE recovery_cases SET status = 'CLAIMED', claimed_by = $2, claimed_at = now(), claim_note = $3 WHERE id = $1`, [id, ctx.userId, note.trim()]);
  await audit(tx, ctx, 'recovery.claimed', 'recovery_case', id, { code: c.code }, note.trim());
  return { status: 'CLAIMED' };
}

/** Tahsil kaydı (finans): iade veya mahsup. Tutar vakadan büyük olamaz; kısmi tahsil kendi tutarıyla kapanır. */
export async function recoverCase(tx: Tx, ctx: TenantContext, id: string, b: { amount: string; note: string }) {
  const c = await lockCase(tx, id);
  if (c.status !== 'CLAIMED') throw wrongState(c.status);
  if (dec(b.amount) <= 0n) throw unprocessable('invalid_amount', 'Tahsil edilen tutar sıfırdan büyük olmalı.');
  if (cmp(dec(b.amount), dec(c.amount!)) > 0) throw unprocessable('amount_exceeds', 'Tahsil edilen tutar bulgu tutarından büyük olamaz.');
  await tx.query(`UPDATE recovery_cases SET status = 'RECOVERED', recovered_by = $2, recovered_at = now(), recovered_amount = $3, recovered_note = $4 WHERE id = $1`,
    [id, ctx.userId, b.amount, b.note.trim()]);
  await closeTasks(tx, `recovery:${id}`);
  await audit(tx, ctx, 'recovery.recovered', 'recovery_case', id, { code: c.code, amount: b.amount, currency: c.currency }, b.note.trim());
  return { status: 'RECOVERED' };
}

export async function dismissCase(tx: Tx, ctx: TenantContext, id: string, reason: string) {
  const c = await lockCase(tx, id);
  if (!['OPEN', 'CONFIRMED', 'CLAIMED'].includes(c.status)) throw wrongState(c.status);
  await tx.query(`UPDATE recovery_cases SET status = 'DISMISSED', dismissed_by = $2, dismissed_at = now(), dismiss_reason = $3 WHERE id = $1`, [id, ctx.userId, reason.trim()]);
  await closeTasks(tx, `recovery:${id}`);
  await audit(tx, ctx, 'recovery.dismissed', 'recovery_case', id, { code: c.code, from: c.status }, reason.trim());
  return { status: 'DISMISSED' };
}

/** Lira Defteri özeti: dönemdeki onaylı faturaların kanıt zinciri + vakaların güncel durumu. Para birimleri çevrilmez. */
export async function ledger(tx: Tx, from: string, to: string) {
  const rows = (await tx.query<{ id: string; no: string; supplier: string; currency: string; net: string; issue_date: string;
      po_line_id: string | null; cv: string | null; has_receipt: boolean | null; terms_verified: boolean | null }>(
    `SELECT i.id, i.invoice_no AS no, s.legal_name AS supplier, i.currency, ${NET}::text AS net, i.issue_date::text,
       a.po_line_id, coalesce(a.contract_version_id, po.contract_version_id) AS cv,
       (a.po_line_id IS NOT NULL AND (SELECT coalesce(sum(r.quantity), 0) FROM receipts r WHERE r.po_line_id = a.po_line_id) > 0) AS has_receipt,
       EXISTS (SELECT 1 FROM contract_terms t WHERE t.contract_version_id = coalesce(a.contract_version_id, po.contract_version_id) AND t.verified_at IS NOT NULL) AS terms_verified
     FROM invoices i JOIN suppliers s ON s.id = i.supplier_id
       LEFT JOIN invoice_allocations a ON a.invoice_id = i.id LEFT JOIN po_lines pl ON pl.id = a.po_line_id LEFT JOIN purchase_orders po ON po.id = pl.po_id
     WHERE i.kind = 'INVOICE' AND ${APPROVED} AND i.issue_date BETWEEN $1 AND $2 ORDER BY i.id`, [from, to])).rows;
  const byInv = new Map<string, { id: string; no: string; supplier: string; currency: string; net: string; issueDate: string; allocations: Parameters<typeof evidenceGaps>[0]['allocations'] }>();
  for (const r of rows) {
    const e = byInv.get(r.id) ?? { id: r.id, no: r.no, supplier: r.supplier, currency: r.currency, net: r.net, issueDate: r.issue_date, allocations: [] };
    if (r.po_line_id || r.cv) e.allocations.push({ poLineId: r.po_line_id, contractVersionId: r.cv, hasReceipt: !!r.has_receipt, termsVerified: !!r.terms_verified });
    byInv.set(r.id, e);
  }
  const evidenced: { currency: string; amount: string }[] = [], missing: { currency: string; amount: string }[] = [];
  const gapTotals = new Map<EvidenceGap, { count: number; rows: { currency: string; amount: string }[] }>();
  const unevidenced: { id: string; no: string; supplier: string; currency: string; net: string; issueDate: string; gaps: EvidenceGap[] }[] = [];
  for (const e of byInv.values()) {
    const gaps = evidenceGaps(e);
    const row = { currency: e.currency, amount: e.net };
    if (!gaps.length) { evidenced.push(row); continue; }
    missing.push(row);
    unevidenced.push({ id: e.id, no: e.no, supplier: e.supplier, currency: e.currency, net: e.net, issueDate: e.issueDate, gaps });
    for (const g of gaps) { const t = gapTotals.get(g) ?? { count: 0, rows: [] }; t.count++; t.rows.push(row); gapTotals.set(g, t); }
  }
  unevidenced.sort((a, b) => cmp(dec(b.net), dec(a.net)));

  const cases = (await tx.query<{ kind: RecoveryKind; status: string; amount: string | null; recovered: string | null; currency: string }>(
    `SELECT kind, status, amount::text, recovered_amount::text AS recovered, currency FROM recovery_cases`)).rows;
  const pick = (f: (c: (typeof cases)[number]) => boolean, amt: (c: (typeof cases)[number]) => string | null = (c) => c.amount) =>
    sumByCurrency(cases.filter((c) => f(c) && amt(c) !== null).map((c) => ({ currency: c.currency, amount: amt(c)! })));
  const live = (c: { status: string }) => ['OPEN', 'CONFIRMED', 'CLAIMED'].includes(c.status);
  const settings = (await tx.query<{ rate: string }>(`SELECT trim_scale(capital_cost_rate)::text AS rate FROM recovery_settings`)).rows[0] ?? null;
  const lastScan = (await tx.query<{ at: Date | null }>(`SELECT max(at) AS at FROM audit_events WHERE action = 'recovery.scanned'`)).rows[0]!.at;
  return {
    period: { from, to },
    evidence: {
      invoiceCount: byInv.size, evidencedCount: byInv.size - unevidenced.length,
      evidenced: sumByCurrency(evidenced), unevidenced: sumByCurrency(missing),
      gaps: [...gapTotals].map(([gap, t]) => ({ gap, count: t.count, amount: sumByCurrency(t.rows) })),
      topUnevidenced: unevidenced.slice(0, 50),
    },
    recovery: {
      recoverable: pick((c) => live(c) && RECOVERY_CATEGORY[c.kind] === 'RECOVERABLE'),
      claimed: pick((c) => c.status === 'CLAIMED'),
      recovered: pick((c) => c.status === 'RECOVERED', (c) => c.recovered),
      // Kısmi tahsilde alınamayan kalan: kaybolmasın, ayrıca görünür (vakada tahsil notu gerekçesidir).
      shortfall: pick((c) => c.status === 'RECOVERED' && c.amount !== null && c.recovered !== null && cmp(dec(c.amount), dec(c.recovered)) > 0,
        (c) => str(dec(c.amount!) - dec(c.recovered!))),
      avoidable: pick((c) => c.status !== 'DISMISSED' && c.status !== 'OBSOLETE' && c.kind === 'EARLY_PAYMENT'),
      // "Ele alındı" (doğrulandı) teminat vakası artık risk sayılmaz; uzatılınca tarama onu çözer.
      atRisk: pick((c) => c.status === 'OPEN' && c.kind === 'GUARANTEE_EXPIRY'),
      reviewCount: cases.filter((c) => live(c) && c.kind === 'FX_DIFF_UNVERIFIED').length,
      openCount: cases.filter((c) => c.status === 'OPEN').length,
    },
    settings: { capitalCostRate: settings?.rate ?? null, fxRateCount: (await tx.query<{ n: number }>(`SELECT count(*)::int AS n FROM fx_rates`)).rows[0]!.n },
    lastScanAt: lastScan,
  };
}

export async function listFxRates(tx: Tx) {
  return (await tx.query(`SELECT r.currency, r.rate_date::text AS "rateDate", trim_scale(r.rate)::text AS rate, r.source, u.display_name AS "enteredBy", r.entered_at AS "enteredAt"
    FROM fx_rates r JOIN users u ON u.id = r.entered_by ORDER BY r.rate_date DESC, r.currency LIMIT 200`)).rows;
}
export async function addFxRate(tx: Tx, ctx: TenantContext, b: { currency: string; rateDate: string; rate: string; source: string }) {
  const r = await tx.query(`INSERT INTO fx_rates (tenant_id, currency, rate_date, rate, source, entered_by) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING`,
    [ctx.tenantId, b.currency, b.rateDate, b.rate, b.source.trim(), ctx.userId]);
  if (!r.rowCount) throw conflict('rate_exists', 'Bu para birimi ve tarih için kur zaten var; düzeltmek için önce silin.');
  await audit(tx, ctx, 'fx_rate.added', 'tenant', ctx.tenantId, b);
  return { ok: true };
}
export async function deleteFxRate(tx: Tx, ctx: TenantContext, currency: string, rateDate: string) {
  const r = (await tx.query(`DELETE FROM fx_rates WHERE currency = $1 AND rate_date = $2 RETURNING trim_scale(rate)::text AS rate, source`, [currency, rateDate])).rows[0];
  if (!r) throw notFound();
  await audit(tx, ctx, 'fx_rate.deleted', 'tenant', ctx.tenantId, { currency, rateDate, ...r });
  return { ok: true };
}
export async function setCapitalCost(tx: Tx, ctx: TenantContext, rate: string) {
  const prev = (await tx.query<{ r: string }>(`SELECT trim_scale(capital_cost_rate)::text AS r FROM recovery_settings`)).rows[0]?.r ?? null;
  await tx.query(`INSERT INTO recovery_settings (tenant_id, capital_cost_rate, set_by) VALUES ($1,$2,$3)
    ON CONFLICT (tenant_id) DO UPDATE SET capital_cost_rate = EXCLUDED.capital_cost_rate, set_by = EXCLUDED.set_by, set_at = now()`, [ctx.tenantId, rate, ctx.userId]);
  await audit(tx, ctx, 'recovery.settings', 'tenant', ctx.tenantId, { capitalCostRate: rate, previous: prev });
  return { capitalCostRate: rate };
}
