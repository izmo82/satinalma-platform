import { guaranteeStatus, priceRevision, slaCredit, validateSlaTerm, type SlaTerm, type SlaTier } from '@sp/domain';
import type { TenantContext, Tx } from '../db.ts';
import { audit } from '../audit.ts';
import { ApiError, conflict, notFound, unprocessable } from '../errors.ts';
import { closeTasks, openTask } from '../tasks.ts';

// Faz 3 kalanları (02 §11): endeksli fiyat revizyonu, SLA ceza/kredi hesabı, teminat takibi. Kural sözleşme maddesinden girilir;
// hesap deterministiktir; sonuç ikinci kişi onayıyla kesinleşir. Bu modül borç/alacak kaydı veya ödeme üretmez — onaylı kredi,
// finansın faturada (iade/alacak belgesi) veya ERP'de işleyeceği tutar olarak görünür.

const today = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Istanbul' }).format(new Date());
const DEC = /^\d{1,14}(\.\d{1,6})?$/;
const sod = () => new ApiError(403, 'segregation_of_duties', 'Öneren/giren kişi aynı kaydı onaylayamaz (görev ayrılığı).');

async function loadCv(tx: Tx, cvId: string) {
  const cv = (await tx.query<{ id: string; company_id: string; title: string; superseded_by_id: string | null }>(
    `SELECT cv.id, cv.company_id, f.title, cv.superseded_by_id FROM contract_versions cv JOIN contract_families f ON f.id = cv.family_id WHERE cv.id = $1`, [cvId])).rows[0];
  if (!cv) throw notFound();
  return cv;
}

export async function overview(tx: Tx, cvId: string, userId: string) {
  await loadCv(tx, cvId);
  const rules = (await tx.query(`SELECT r.id, r.index_name AS "indexName", trim_scale(r.base_index)::text AS "baseIndex", r.base_period::text AS "basePeriod", r.period,
      trim_scale(r.cap_percent)::text AS "capPercent", trim_scale(r.floor_percent)::text AS "floorPercent", r.source_ref AS "sourceRef", r.created_at AS "createdAt",
      u.display_name AS "createdBy", r.retired_at AS "retiredAt", r.retired_reason AS "retiredReason"
    FROM price_revision_rules r JOIN users u ON u.id = r.created_by WHERE r.contract_version_id = $1 ORDER BY r.created_at DESC`, [cvId])).rows;
  const revisions = (await tx.query(`SELECT v.id, v.rule_id AS "ruleId", v.effective_from::text AS "effectiveFrom", trim_scale(v.index_value)::text AS "indexValue", v.index_source AS "indexSource",
      trim_scale(v.raw_change_percent)::text AS "rawChangePercent", trim_scale(v.applied_change_percent)::text AS "appliedChangePercent", trim_scale(v.factor)::text AS factor,
      r.retired_at IS NOT NULL AS "ruleRetired", pu.display_name AS "proposedBy", v.proposed_by = $2 AS "proposedByMe", v.proposed_at AS "proposedAt", au.display_name AS "approvedBy", v.approved_at AS "approvedAt"
    FROM price_revisions v JOIN price_revision_rules r ON r.id = v.rule_id JOIN users pu ON pu.id = v.proposed_by LEFT JOIN users au ON au.id = v.approved_by
    WHERE r.contract_version_id = $1 ORDER BY v.effective_from DESC`, [cvId, userId])).rows;
  // Yürürlükteki katsayı: bugün veya öncesinde başlayan son onaylı revizyon (baz fiyata göre).
  // Yalnız yürürlükteki kuralın revizyonları (değiştirilen kuralın katsayısı yanlış baza göre olabilir).
  const current = revisions.find((v: any) => v.approvedAt && !v.ruleRetired && v.effectiveFrom <= today()) ?? null;
  const sla = (await tx.query(`SELECT s.id, s.name, s.unit, s.direction, trim_scale(s.target)::text AS target, s.period_fee::text AS "periodFee", s.currency, s.tiers,
      trim_scale(s.cap_percent)::text AS "capPercent", s.source_ref AS "sourceRef", s.retired_at AS "retiredAt"
    FROM sla_terms s WHERE s.contract_version_id = $1 ORDER BY s.created_at`, [cvId])).rows;
  const measurements = (await tx.query(`SELECT m.id, m.sla_term_id AS "slaTermId", m.period_start::text AS "periodStart", trim_scale(m.measured)::text AS measured, m.evidence,
      m.breached, trim_scale(m.credit_percent)::text AS "creditPercent", m.credit_amount::text AS "creditAmount", eu.display_name AS "enteredBy", m.entered_by = $2 AS "enteredByMe",
      m.entered_at AS "enteredAt", vu.display_name AS "verifiedBy", m.verified_at AS "verifiedAt", ru.display_name AS "rejectedBy", m.rejected_at AS "rejectedAt", m.rejected_reason AS "rejectedReason"
    FROM sla_measurements m JOIN sla_terms s ON s.id = m.sla_term_id JOIN users eu ON eu.id = m.entered_by LEFT JOIN users vu ON vu.id = m.verified_by LEFT JOIN users ru ON ru.id = m.rejected_by
    WHERE s.contract_version_id = $1 ORDER BY m.period_start DESC, m.entered_at DESC`, [cvId, userId])).rows;
  const guarantees = (await tx.query<{ validUntil: string | null; returnedAt: Date | null }>(`SELECT g.id, g.kind, g.amount::text, g.currency, g.issuer, g.reference_no AS "referenceNo",
      g.valid_until::text AS "validUntil", g.document_version_id AS "documentVersionId", ru.display_name AS "receivedBy", g.received_at AS "receivedAt",
      tu.display_name AS "returnedBy", g.returned_at AS "returnedAt", g.return_note AS "returnNote"
    FROM contract_guarantees g JOIN users ru ON ru.id = g.received_by LEFT JOIN users tu ON tu.id = g.returned_by WHERE g.contract_version_id = $1 ORDER BY g.received_at`, [cvId])).rows
    .map((g) => ({ ...g, status: guaranteeStatus(g.validUntil, g.returnedAt ? g.returnedAt.toISOString().slice(0, 10) : null, today()) }));
  return { rules, revisions, currentFactor: current ? { factor: (current as any).factor, effectiveFrom: (current as any).effectiveFrom } : null, sla, measurements, guarantees };
}

// --- Fiyat revizyonu ---------------------------------------------------------------------------

export async function createPriceRule(tx: Tx, ctx: TenantContext, cvId: string, b: { indexName: string; baseIndex: string; basePeriod: string; period: 'MONTHLY' | 'QUARTERLY' | 'YEARLY';
  capPercent: string | null; floorPercent: string | null; sourceRef: string; replaceReason?: string | null }) {
  const cv = await loadCv(tx, cvId);
  if (cv.superseded_by_id) throw conflict('version_superseded', 'Bu sürümün yerine yeni sürüm geldi; kural güncel sürüme girilir.');
  for (const v of [b.baseIndex, ...(b.capPercent ? [b.capPercent] : []), ...(b.floorPercent ? [b.floorPercent] : [])]) if (!DEC.test(v)) throw unprocessable('invalid_number', 'Endeks ve yüzdeler sıfır veya pozitif ondalık olmalı.');
  if (Number(b.baseIndex) <= 0) throw unprocessable('invalid_number', 'Baz endeks pozitif olmalı.');
  if (b.floorPercent && Number(b.floorPercent) > 100) throw unprocessable('invalid_number', 'Taban en çok %100 düşüş olabilir.');
  const active = (await tx.query<{ id: string }>(`SELECT id FROM price_revision_rules WHERE contract_version_id = $1 AND retired_at IS NULL FOR UPDATE`, [cvId])).rows[0];
  if (active) {
    if ((b.replaceReason ?? '').trim().length < 10) throw unprocessable('reason_required', 'Yürürlükteki kuralı değiştirmek için gerekçe gerekli (en az 10 karakter).');
    await tx.query(`UPDATE price_revision_rules SET retired_at = now(), retired_reason = $2 WHERE id = $1`, [active.id, b.replaceReason!.trim()]);
  }
  const r = (await tx.query<{ id: string }>(`INSERT INTO price_revision_rules (tenant_id, company_id, contract_version_id, index_name, base_index, base_period, period, cap_percent, floor_percent, source_ref, created_by)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id`, [ctx.tenantId, cv.company_id, cvId, b.indexName.trim(), b.baseIndex, b.basePeriod, b.period, b.capPercent, b.floorPercent, b.sourceRef.trim(), ctx.userId])).rows[0]!;
  await audit(tx, ctx, 'contract.price_rule.created', 'contract_version', cvId, { ruleId: r.id, indexName: b.indexName, replaced: active?.id ?? null }, b.replaceReason ?? undefined);
  return { id: r.id };
}

export async function proposeRevision(tx: Tx, ctx: TenantContext, ruleId: string, b: { effectiveFrom: string; indexValue: string; indexSource: string }) {
  const rule = (await tx.query<{ id: string; company_id: string; contract_version_id: string; base_index: string; base_period: string; cap_percent: string | null; floor_percent: string | null; retired_at: Date | null }>(
    `SELECT id, company_id, contract_version_id, base_index::text, base_period::text, cap_percent::text, floor_percent::text, retired_at FROM price_revision_rules WHERE id = $1`, [ruleId])).rows[0];
  if (!rule) throw notFound();
  if (rule.retired_at) throw conflict('rule_retired', 'Bu kural yürürlükten kalktı; güncel kurala revizyon girin.');
  if (!DEC.test(b.indexValue) || Number(b.indexValue) <= 0) throw unprocessable('invalid_number', 'Endeks değeri pozitif ondalık olmalı.');
  if (b.effectiveFrom <= rule.base_period) throw unprocessable('invalid_period', 'Revizyon başlangıcı baz dönemden sonra olmalı.');
  const calc = priceRevision({ baseIndex: rule.base_index, capPercent: rule.cap_percent, floorPercent: rule.floor_percent }, b.indexValue);
  const r = (await tx.query<{ id: string }>(`INSERT INTO price_revisions (tenant_id, company_id, rule_id, effective_from, index_value, index_source, raw_change_percent, applied_change_percent, factor, proposed_by)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`, [ctx.tenantId, rule.company_id, ruleId, b.effectiveFrom, b.indexValue, b.indexSource.trim(), calc.rawChangePercent, calc.appliedChangePercent, calc.factor, ctx.userId])).rows[0]!;
  await openTask(tx, ctx, { companyId: rule.company_id, kind: 'contract.price_revision.approval', entityType: 'contract_version', entityId: rule.contract_version_id,
    title: `Fiyat revizyonu onayı: %${calc.appliedChangePercent.replace(/\.?0+$/, '')} (${b.effectiveFrom})`, reason: `Endeks ${b.indexValue} (${b.indexSource.trim()}); katsayı ${calc.factor}${calc.limitedBy ? `, ${calc.limitedBy === 'CAP' ? 'tavanla' : 'tabanla'} sınırlandı` : ''}.`,
    nextAction: 'Endeks kaynağını kontrol edip onaylayın.', assigneeRole: 'PROCUREMENT_MANAGER', dedupeKey: `price-revision:${r.id}` });
  await audit(tx, ctx, 'contract.price_revision.proposed', 'contract_version', rule.contract_version_id, { revisionId: r.id, ...calc, indexValue: b.indexValue });
  return { id: r.id, ...calc };
}

export async function approveRevision(tx: Tx, ctx: TenantContext, id: string) {
  const v = (await tx.query<{ proposed_by: string; approved_by: string | null; contract_version_id: string; retired_at: Date | null }>(`SELECT v.proposed_by, v.approved_by, r.contract_version_id, r.retired_at FROM price_revisions v
    JOIN price_revision_rules r ON r.id = v.rule_id WHERE v.id = $1 FOR UPDATE OF v`, [id])).rows[0];
  if (!v) throw notFound();
  if (v.approved_by) throw conflict('already_approved', 'Bu revizyon onaylandı.');
  if (v.retired_at) throw conflict('rule_retired', 'Revizyonun kuralı yürürlükten kalktı; güncel kurala yeni revizyon girin.');
  if (v.proposed_by === ctx.userId) throw sod();
  await tx.query(`UPDATE price_revisions SET approved_by = $2, approved_at = now() WHERE id = $1`, [id, ctx.userId]);
  await closeTasks(tx, `price-revision:${id}`);
  await audit(tx, ctx, 'contract.price_revision.approved', 'contract_version', v.contract_version_id, { revisionId: id });
  return { ok: true };
}

// --- SLA ---------------------------------------------------------------------------------------

export async function createSlaTerm(tx: Tx, ctx: TenantContext, cvId: string, b: { name: string; unit: string; direction: 'MIN' | 'MAX'; target: string; periodFee: string; currency: string;
  tiers: SlaTier[]; capPercent: string | null; sourceRef: string }) {
  const cv = await loadCv(tx, cvId);
  if (cv.superseded_by_id) throw conflict('version_superseded', 'Bu sürümün yerine yeni sürüm geldi; SLA güncel sürüme girilir.');
  const err = validateSlaTerm({ direction: b.direction, target: b.target, tiers: b.tiers, capPercent: b.capPercent, periodFee: b.periodFee });
  if (err) throw unprocessable('invalid_sla', err);
  const r = (await tx.query<{ id: string }>(`INSERT INTO sla_terms (tenant_id, company_id, contract_version_id, name, unit, direction, target, period_fee, currency, tiers, cap_percent, source_ref, created_by)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING id`, [ctx.tenantId, cv.company_id, cvId, b.name.trim(), b.unit.trim(), b.direction, b.target, b.periodFee, b.currency,
    JSON.stringify(b.tiers), b.capPercent, b.sourceRef.trim(), ctx.userId])).rows[0]!;
  await audit(tx, ctx, 'contract.sla.created', 'contract_version', cvId, { slaTermId: r.id, name: b.name });
  return { id: r.id };
}

export async function recordMeasurement(tx: Tx, ctx: TenantContext, slaTermId: string, b: { periodStart: string; measured: string; evidence: string; documentVersionId?: string | null }) {
  const s = (await tx.query<{ company_id: string; contract_version_id: string; name: string; unit: string; direction: 'MIN' | 'MAX'; target: string; period_fee: string; currency: string; tiers: SlaTier[]; cap_percent: string | null; retired_at: Date | null }>(
    `SELECT company_id, contract_version_id, name, unit, direction, target::text, period_fee::text, currency, tiers, cap_percent::text, retired_at FROM sla_terms WHERE id = $1`, [slaTermId])).rows[0];
  if (!s) throw notFound();
  if (s.retired_at) throw conflict('sla_retired', 'Bu SLA yürürlükten kalktı.');
  if (!/^-?\d{1,14}(\.\d{1,6})?$/.test(b.measured)) throw unprocessable('invalid_number', 'Ölçüm ondalık sayı olmalı.');
  if (b.periodStart > today()) throw unprocessable('invalid_period', 'Gelecek dönem için ölçüm girilmez.');
  // Dönem ay bazındadır: aynı ay iki farklı günle iki kez kredi doğurmasın.
  if (!b.periodStart.endsWith('-01')) throw unprocessable('invalid_period', 'Dönem ayın ilk günü olarak girilir (ör. 2026-09-01).');
  const term: SlaTerm = { direction: s.direction, target: s.target, tiers: s.tiers, capPercent: s.cap_percent, periodFee: s.period_fee };
  const c = slaCredit(term, b.measured);
  // Aynı dönem için geçerli ölçüm tektir (aynı ihlal iki kez kredi doğurmaz); reddedilen ölçümün yerine yeni girilebilir.
  const r = (await tx.query<{ id: string }>(`INSERT INTO sla_measurements (tenant_id, company_id, sla_term_id, period_start, measured, evidence, document_version_id, breached, credit_percent, credit_amount, entered_by)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id`, [ctx.tenantId, s.company_id, slaTermId, b.periodStart, b.measured, b.evidence.trim(), b.documentVersionId ?? null, c.breached, c.creditPercent, c.creditAmount, ctx.userId])).rows[0]!;
  if (c.breached) await openTask(tx, ctx, { companyId: s.company_id, kind: 'contract.sla_credit.verify', entityType: 'contract_version', entityId: s.contract_version_id,
    title: `SLA ihlali doğrulama: ${s.name} (${b.periodStart.slice(0, 7)})`, reason: `Ölçüm ${b.measured} ${s.unit}, hedef ${s.target}; hesaplanan kredi ${c.creditAmount} ${s.currency}${c.capped ? ' (üst sınırla)' : ''}.`,
    nextAction: 'Kanıtı inceleyip krediyi doğrulayın veya gerekçeyle reddedin.', assigneeRole: 'FINANCE', dedupeKey: `sla-measure:${r.id}` });
  await audit(tx, ctx, 'contract.sla.measured', 'contract_version', s.contract_version_id, { measurementId: r.id, slaTermId, periodStart: b.periodStart, breached: c.breached, creditAmount: c.creditAmount });
  return { id: r.id, ...c };
}

export async function decideMeasurement(tx: Tx, ctx: TenantContext, id: string, b: { decision: 'VERIFY' | 'REJECT'; reason?: string | null }) {
  const m = (await tx.query<{ entered_by: string; verified_at: Date | null; rejected_at: Date | null; contract_version_id: string; breached: boolean }>(`SELECT m.entered_by, m.verified_at, m.rejected_at, s.contract_version_id, m.breached
    FROM sla_measurements m JOIN sla_terms s ON s.id = m.sla_term_id WHERE m.id = $1 FOR UPDATE OF m`, [id])).rows[0];
  if (!m) throw notFound();
  if (m.verified_at || m.rejected_at) throw conflict('already_decided', 'Bu ölçüm için karar verildi.');
  if (m.entered_by === ctx.userId) throw sod();
  if (b.decision === 'REJECT') {
    if ((b.reason ?? '').trim().length < 10) throw unprocessable('reason_required', 'Ret gerekçesi gerekli (en az 10 karakter).');
    await tx.query(`UPDATE sla_measurements SET rejected_by = $2, rejected_at = now(), rejected_reason = $3 WHERE id = $1`, [id, ctx.userId, b.reason!.trim()]);
  } else {
    await tx.query(`UPDATE sla_measurements SET verified_by = $2, verified_at = now() WHERE id = $1`, [id, ctx.userId]);
  }
  await closeTasks(tx, `sla-measure:${id}`);
  await audit(tx, ctx, b.decision === 'VERIFY' ? 'contract.sla.verified' : 'contract.sla.rejected', 'contract_version', m.contract_version_id, { measurementId: id }, b.reason ?? undefined);
  return { ok: true };
}

// --- Teminat -----------------------------------------------------------------------------------

export async function addGuarantee(tx: Tx, ctx: TenantContext, cvId: string, b: { kind: 'PERFORMANCE' | 'ADVANCE' | 'WARRANTY' | 'CASH' | 'OTHER'; amount: string; currency: string;
  issuer: string; referenceNo: string; validUntil: string | null; documentVersionId?: string | null }) {
  const cv = await loadCv(tx, cvId);
  if (!/^\d{1,18}(\.\d{1,2})?$/.test(b.amount) || Number(b.amount) <= 0) throw unprocessable('invalid_number', 'Teminat tutarı pozitif, en fazla 2 ondalık olmalı.');
  const r = (await tx.query<{ id: string }>(`INSERT INTO contract_guarantees (tenant_id, company_id, contract_version_id, kind, amount, currency, issuer, reference_no, valid_until, document_version_id, received_by)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id`, [ctx.tenantId, cv.company_id, cvId, b.kind, b.amount, b.currency, b.issuer.trim(), b.referenceNo.trim(), b.validUntil, b.documentVersionId ?? null, ctx.userId])).rows[0]!;
  await audit(tx, ctx, 'contract.guarantee.received', 'contract_version', cvId, { guaranteeId: r.id, kind: b.kind, amount: b.amount, currency: b.currency, validUntil: b.validUntil });
  return { id: r.id };
}

export async function returnGuarantee(tx: Tx, ctx: TenantContext, id: string, note: string) {
  const g = (await tx.query<{ returned_at: Date | null; contract_version_id: string }>(`SELECT returned_at, contract_version_id FROM contract_guarantees WHERE id = $1 FOR UPDATE`, [id])).rows[0];
  if (!g) throw notFound();
  if (g.returned_at) throw conflict('already_returned', 'Bu teminat iade edildi.');
  if (note.trim().length < 10) throw unprocessable('reason_required', 'İade notu gerekli (kime, hangi yazıyla; en az 10 karakter).');
  await tx.query(`UPDATE contract_guarantees SET returned_by = $2, returned_at = now(), return_note = $3 WHERE id = $1`, [id, ctx.userId, note.trim()]);
  await closeTasks(tx, `guarantee:${id}`);
  await audit(tx, ctx, 'contract.guarantee.returned', 'contract_version', g.contract_version_id, { guaranteeId: id }, note.trim());
  return { ok: true };
}

/** Bitişi yaklaşan veya geçen, iade edilmemiş teminatlar için görev (sözleşme ekranı açıldığında; aynı görev ikinci kez açılmaz). */
export async function guaranteeReminders(tx: Tx, ctx: TenantContext, cvId: string) {
  const rows = (await tx.query<{ id: string; company_id: string; kind: string; amount: string; currency: string; valid_until: string; reference_no: string }>(
    `SELECT id, company_id, kind, amount::text, currency, valid_until::text, reference_no FROM contract_guarantees WHERE contract_version_id = $1 AND returned_at IS NULL AND valid_until IS NOT NULL`, [cvId])).rows;
  for (const g of rows) {
    const st = guaranteeStatus(g.valid_until, null, today());
    if (st === 'ACTIVE') continue;
    await openTask(tx, ctx, { companyId: g.company_id, kind: 'contract.guarantee.expiry', entityType: 'contract_version', entityId: cvId,
      title: `Teminat ${st === 'EXPIRED' ? 'süresi geçti' : 'süresi doluyor'}: ${g.reference_no} (${g.valid_until})`, reason: `${g.amount} ${g.currency} teminatın geçerliliği ${g.valid_until} tarihinde ${st === 'EXPIRED' ? 'bitti' : 'bitiyor'}.`,
      nextAction: 'Süre uzatımı isteyin, sözleşme bittiyse iade edin.', assigneeRole: 'FINANCE', severity: st === 'EXPIRED' ? 'HIGH' : 'NORMAL', dedupeKey: `guarantee:${g.id}:${st}` });
  }
}
