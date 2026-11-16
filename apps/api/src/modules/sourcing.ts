import { createHash } from 'node:crypto';
import {
  compareBids, evaluationBasis, validateAward, validateCriteria, isDecimal,
  type AwardAllocation, type Bid, type Comparison, type Criterion, type FxRate, type ProjectLine, type Score,
} from '@sp/domain';
import type { TenantContext, Tx } from '../db.ts';
import { criticalBlocks } from './supplierEval.ts';
import { audit } from '../audit.ts';
import { nextCode } from '../codes.ts';
import { closeTasks, openTask } from '../tasks.ts';
import { ApiError, conflict, forbidden, notFound, unprocessable } from '../errors.ts';
import { inspectUpload } from '../files.ts';
import { objectKey, type ObjectStore } from '../storage.ts';
import * as approvals from './approvals.ts';
import { resolveDepartment } from './departments.ts';

/**
 * Faz 2: proje → RFQ turu (görev ayrılıklı yayın onayı) → tedarikçi portalı (mühürlü teklif, sunucu saati)
 * → normalleştirilmiş karşılaştırma → değerlendirme sürümü → bölünebilir kazanan tahsisi.
 * Hesaplar @sp/domain'de deterministiktir; burada yalnız veri, yetki ve durum geçişi var.
 */

export interface LineInput { lot?: string; description: string; unit: string; quantity: string; spec?: string }
export interface CriterionInput { code: string; name: string; kind: 'PRICE' | 'SCORE'; weight: string }
export interface ProjectInput {
  companyId: string; title: string; category: string; need?: string; currency?: string; budget?: string | null; budgetVerified?: boolean;
  costCenter?: string | null; deliveryLocation?: string | null; neededBy?: string | null; lines: LineInput[]; criteria: CriterionInput[];
  /** v2 (D93): bölüm kullanıcısı için zorunlu (kendi departmanı); tüm departmanı görenler için isteğe bağlı. */
  departmentId?: string | null;
}

interface ProjectRow {
  id: string; company_id: string; code: string; title: string; category: string; need: string; currency: string; budget: string | null;
  budget_verified: boolean; cost_center: string | null; delivery_location: string | null; needed_by: string | null; status: string;
  owner_user_id: string; created_by: string; row_version: number; created_at: Date; updated_at: Date; department_id: string | null;
}

export const projectEtag = (p: { id: string; row_version: number }) => `"prj-${p.id}-${p.row_version}"`;
const sha = (s: string) => createHash('sha256').update(s).digest('hex');

function checkLines(lines: LineInput[]) {
  if (!lines.length) throw unprocessable('lines_required', 'En az bir kalem gerekli.');
  lines.forEach((l, i) => {
    if (!isDecimal(l.quantity) || Number(l.quantity) <= 0) throw unprocessable('invalid_quantity', `Kalem ${i + 1}: miktar pozitif ondalık sayı olmalı.`);
    if (!l.unit.trim()) throw unprocessable('invalid_unit', `Kalem ${i + 1}: birim gerekli.`);
  });
}
function checkCriteria(criteria: CriterionInput[]) {
  const err = validateCriteria(criteria);
  if (err) throw unprocessable('invalid_criteria', err);
  if (new Set(criteria.map((c) => c.code)).size !== criteria.length) throw unprocessable('invalid_criteria', 'Kriter kodları benzersiz olmalı.');
}

async function loadProject(tx: Tx, id: string, lock = false): Promise<ProjectRow> {
  const r = await tx.query<ProjectRow>(`SELECT * FROM projects WHERE id = $1 ${lock ? 'FOR UPDATE' : ''}`, [id]);
  if (!r.rows[0]) throw notFound();
  return r.rows[0];
}
function assertEtag(p: ProjectRow, ifMatch: string | undefined) {
  if (!ifMatch) throw new ApiError(428, 'precondition_required', 'If-Match başlığı gerekli.');
  if (ifMatch !== projectEtag(p)) throw conflict('version_conflict', 'Proje siz çalışırken değişti. Güncel hali yükleyip tekrar deneyin.', { currentEtag: projectEtag(p) });
}
async function bump(tx: Tx, id: string, status?: string) {
  await tx.query(`UPDATE projects SET row_version = row_version + 1, updated_at = now() ${status ? ', status = $2' : ''} WHERE id = $1`, status ? [id, status] : [id]);
}

async function insertLines(tx: Tx, ctx: TenantContext, p: { id: string; company_id: string }, lines: LineInput[]) {
  let n = 0;
  for (const l of lines) {
    await tx.query(`INSERT INTO project_lines (tenant_id, company_id, project_id, lot, line_no, description, unit, quantity, spec)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [ctx.tenantId, p.company_id, p.id, (l.lot ?? 'Lot 1').trim() || 'Lot 1', ++n, l.description.trim(), l.unit.trim(), l.quantity, l.spec ?? '']);
  }
}
async function insertCriteria(tx: Tx, ctx: TenantContext, p: { id: string; company_id: string }, criteria: CriterionInput[], reason: string | null) {
  const rev = (await tx.query<{ r: number }>(`SELECT coalesce(max(revision), 0) + 1 AS r FROM evaluation_criteria WHERE project_id = $1`, [p.id])).rows[0]!.r;
  for (const c of criteria) {
    await tx.query(`INSERT INTO evaluation_criteria (tenant_id, company_id, project_id, revision, code, name, kind, weight, reason, created_by)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`, [ctx.tenantId, p.company_id, p.id, rev, c.code, c.name, c.kind, c.weight, reason, ctx.userId]);
  }
  return rev;
}

export async function createProject(tx: Tx, ctx: TenantContext, body: ProjectInput) {
  if (!ctx.companyIds.includes(body.companyId)) throw forbidden('company');
  checkLines(body.lines);
  checkCriteria(body.criteria);
  if (body.budget != null && !isDecimal(body.budget)) throw unprocessable('invalid_budget', 'Bütçe ondalık sayı olmalı.');
  const departmentId = await resolveDepartment(tx, ctx, body.departmentId);
  const code = await nextCode(tx, ctx, 'project', 'PRJ');
  const p = (await tx.query<ProjectRow>(
    `INSERT INTO projects (tenant_id, company_id, code, title, category, need, currency, budget, budget_verified, cost_center, delivery_location, needed_by, owner_user_id, created_by, department_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$13,$14) RETURNING *`,
    [ctx.tenantId, body.companyId, code, body.title.trim(), body.category.trim(), body.need ?? '', (body.currency ?? 'TRY').toUpperCase(),
      body.budget ?? null, body.budgetVerified ?? false, body.costCenter ?? null, body.deliveryLocation ?? null, body.neededBy ?? null, ctx.userId, departmentId])).rows[0]!;
  await insertLines(tx, ctx, p, body.lines);
  await insertCriteria(tx, ctx, p, body.criteria, null);
  await audit(tx, ctx, 'project.created', 'project', p.id, { code, lines: body.lines.length, departmentId });
  return { id: p.id, code, etag: projectEtag(p) };
}

/** Taslak düzenleme: kalemler ve kriterler bütün olarak değiştirilir; eski kalemler silinmez, emekliye ayrılır. */
export async function updateDraft(tx: Tx, ctx: TenantContext, id: string, ifMatch: string | undefined, body: Omit<ProjectInput, 'companyId'>) {
  const p = await loadProject(tx, id, true);
  assertEtag(p, ifMatch);
  if (p.status !== 'DRAFT') throw conflict('not_draft', 'Yayına gönderilmiş projenin kalemleri değiştirilemez; yeni tur veya kriter revizyonu kullanın.');
  checkLines(body.lines);
  checkCriteria(body.criteria);
  if (body.budget != null && !isDecimal(body.budget)) throw unprocessable('invalid_budget', 'Bütçe ondalık sayı olmalı.');
  await tx.query(`UPDATE projects SET title=$2, category=$3, need=$4, currency=$5, budget=$6, budget_verified=$7, cost_center=$8,
    delivery_location=$9, needed_by=$10 WHERE id=$1`,
    [id, body.title.trim(), body.category.trim(), body.need ?? '', (body.currency ?? p.currency).toUpperCase(), body.budget ?? null,
      body.budgetVerified ?? false, body.costCenter ?? null, body.deliveryLocation ?? null, body.neededBy ?? null]);
  await tx.query(`UPDATE project_lines SET retired_at = now() WHERE project_id = $1 AND retired_at IS NULL`, [id]);
  await insertLines(tx, ctx, p, body.lines);
  await insertCriteria(tx, ctx, p, body.criteria, null);
  await bump(tx, id);
  await audit(tx, ctx, 'project.draft_updated', 'project', id, { lines: body.lines.length });
  return { etag: projectEtag({ id, row_version: p.row_version + 1 }) };
}

/** Yayın sonrası kriter/ağırlık değişikliği: gerekçe zorunlu; önceki değerlendirmeler eskir (T11). */
export async function reviseCriteria(tx: Tx, ctx: TenantContext, id: string, ifMatch: string | undefined, criteria: CriterionInput[], reason: string) {
  const p = await loadProject(tx, id, true);
  assertEtag(p, ifMatch);
  if (p.status === 'DRAFT') throw conflict('use_draft_update', 'Taslakta kriterler proje düzenlemesiyle değiştirilir.');
  if (['CONTRACTING', 'CANCELLED'].includes(p.status)) throw conflict('project_closed', 'Karar onaylanmış veya iptal edilmiş projede kriter değişmez.');
  if (reason.trim().length < 10) throw unprocessable('reason_required', 'Ağırlık değişikliği için en az 10 karakterlik gerekçe gerekli.');
  checkCriteria(criteria);
  const rev = await insertCriteria(tx, ctx, p, criteria, reason.trim());
  await bump(tx, id);
  await audit(tx, ctx, 'project.criteria_revised', 'project', id, { revision: rev }, reason.trim());
  return { revision: rev, etag: projectEtag({ id, row_version: p.row_version + 1 }) };
}

async function currentLines(tx: Tx, projectId: string): Promise<(ProjectLine & { lineNo: number; spec: string })[]> {
  return (await tx.query(`SELECT id, lot, line_no AS "lineNo", description, unit, trim_scale(quantity)::text AS quantity, spec FROM project_lines
    WHERE project_id = $1 AND retired_at IS NULL ORDER BY lot, line_no`, [projectId])).rows;
}
async function currentCriteria(tx: Tx, projectId: string): Promise<(Criterion & { revision: number; reason: string | null })[]> {
  return (await tx.query(`SELECT code, name, kind, trim_scale(weight)::text AS weight, revision, reason FROM evaluation_criteria
    WHERE project_id = $1 AND revision = (SELECT max(revision) FROM evaluation_criteria WHERE project_id = $1) ORDER BY (kind = 'PRICE') DESC, code`, [projectId])).rows;
}

/** Sunucu saatine göre süresi dolan tur kapanır ve proje değerlendirmeye geçer (alıcı okuduğunda). */
async function settleRounds(tx: Tx, projectId: string) {
  const r = await tx.query(`UPDATE rfq_rounds SET status = 'CLOSED', closed_at = closes_at
    WHERE project_id = $1 AND status = 'OPEN' AND closes_at <= now() RETURNING id`, [projectId]);
  if (r.rowCount) await tx.query(`UPDATE projects SET status = 'EVALUATION', row_version = row_version + 1, updated_at = now() WHERE id = $1 AND status = 'OPEN'`, [projectId]);
}

export async function requestPublish(tx: Tx, ctx: TenantContext, id: string, ifMatch: string | undefined, body: { closesAt: string; supplierIds: string[] }) {
  const p = await loadProject(tx, id, true);
  assertEtag(p, ifMatch);
  if (!['DRAFT', 'EVALUATION'].includes(p.status)) throw conflict('invalid_state', 'Bu aşamada yeni teklif turu açılamaz.');
  const closesAt = new Date(body.closesAt);
  if (Number.isNaN(closesAt.getTime()) || closesAt.getTime() <= Date.now() + 60_000) throw unprocessable('invalid_closes_at', 'Kapanış zamanı gelecekte olmalı.');
  if (p.budget === null) throw unprocessable('budget_required', 'Yayın için bütçe tutarı gerekli (doğrulanmamış olarak işaretlenebilir).');
  const lines = await currentLines(tx, id);
  if (!lines.length) throw unprocessable('lines_required', 'En az bir kalem gerekli.');
  const err = validateCriteria(await currentCriteria(tx, id));
  if (err) throw unprocessable('invalid_criteria', err);
  const ids = [...new Set(body.supplierIds)];
  if (!ids.length) throw unprocessable('suppliers_required', 'En az bir tedarikçi davet edilmeli.');
  const sup = await tx.query<{ id: string; status: string; legal_name: string }>(`SELECT id, status, legal_name FROM suppliers WHERE id = ANY($1::uuid[])`, [ids]);
  if (sup.rowCount !== ids.length) throw unprocessable('unknown_supplier', 'Davet listesinde bulunamayan tedarikçi var.');
  const bad = sup.rows.filter((s) => !['ACTIVE', 'CONDITIONAL', 'CANDIDATE'].includes(s.status));
  if (bad.length) throw unprocessable('supplier_not_eligible', `Davet edilemez: ${bad.map((s) => s.legal_name).join(', ')} (askıda, reddedilmiş veya arşivde).`);
  // Kurum politikası (onay motoru): onay adımları, en az davetli ve en az teklif süresi. Altında kalmak onaylı istisna ister.
  const { policyId, plan } = await approvals.planFor(tx, { action: 'RFQ_PUBLISH', companyId: p.company_id, category: p.category, currency: p.currency, amount: p.budget });
  const usable = (kind: string) => tx.query<{ id: string; details: { supplierId?: string } }>(`SELECT id, details FROM sourcing_exceptions WHERE project_id = $1 AND kind = $2 AND status = 'APPROVED' FOR UPDATE`, [id, kind]).then((x) => x.rows[0] ?? null);
  const used: string[] = [];
  if (plan.minInvitees && ids.length < plan.minInvitees) {
    const ex = await usable('SINGLE_SOURCE');
    // Tek kaynak istisnası onaylandığı tedarikçiye bağlıdır: davet listesi yalnız o tedarikçi olmalı.
    if (ex && !(ids.length === 1 && ids[0] === ex.details.supplierId)) throw unprocessable('single_source_mismatch', 'Onaylı tek kaynak istisnası başka bir tedarikçi için verildi; davet yalnız o tedarikçiye yapılabilir.');
    if (!ex) throw unprocessable('min_invitees', `Kurum politikası en az ${plan.minInvitees} tedarikçi daveti istiyor (${ids.length} seçildi). Daha az davet için onaylı tek kaynak istisnası gerekir.`, { minInvitees: plan.minInvitees, explanation: plan.explanation });
    used.push(ex.id);
  }
  const days = (closesAt.getTime() - Date.now()) / 86_400_000;
  if (plan.minResponseDays && days < plan.minResponseDays) {
    const ex = await usable('URGENT');
    if (!ex) throw unprocessable('min_response_days', `Kurum politikası teklif için en az ${plan.minResponseDays} gün istiyor. Daha kısa süre için onaylı acil alım istisnası gerekir.`, { minResponseDays: plan.minResponseDays, explanation: plan.explanation });
    used.push(ex.id);
  }
  const roundNo = (await tx.query<{ n: number }>(`SELECT coalesce(max(round_no), 0) + 1 AS n FROM rfq_rounds WHERE project_id = $1`, [id])).rows[0]!.n;
  const round = (await tx.query<{ id: string }>(`INSERT INTO rfq_rounds (tenant_id, company_id, project_id, round_no, closes_at, requested_by)
    VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`, [ctx.tenantId, p.company_id, id, roundNo, closesAt, ctx.userId])).rows[0]!;
  for (const ex of used) await tx.query(`UPDATE sourcing_exceptions SET status = 'USED', used_round_id = $2 WHERE id = $1`, [ex, round.id]);
  for (const s of ids) {
    await tx.query(`INSERT INTO rfq_invitations (tenant_id, company_id, project_id, round_id, supplier_id, invited_by) VALUES ($1,$2,$3,$4,$5,$6)`,
      [ctx.tenantId, p.company_id, id, round.id, s, ctx.userId]);
  }
  await bump(tx, id, 'IN_APPROVAL');
  await approvals.openRequest(tx, ctx, { companyId: p.company_id, entityType: 'rfq_round', entityId: round.id, action: 'RFQ_PUBLISH', policyId, plan,
    title: `Yayın onayı: ${p.title} (${roundNo}. tur, ${ids.length} tedarikçi)`, projectId: id });
  await audit(tx, ctx, 'rfq.publish_requested', 'rfq_round', round.id, { projectId: id, roundNo, suppliers: ids.length, closesAt, policyVersion: plan.policyVersion, steps: plan.steps.length, exceptions: used });
  return { roundId: round.id, roundNo, approval: { steps: plan.steps, explanation: plan.explanation } };
}

export async function decidePublish(tx: Tx, ctx: TenantContext, roundId: string, body: { approve: boolean; note?: string }) {
  const r = (await tx.query<{ id: string; project_id: string; company_id: string; status: string; requested_by: string; closes_at: Date; round_no: number }>(
    `SELECT id, project_id, company_id, status, requested_by, closes_at, round_no FROM rfq_rounds WHERE id = $1 FOR UPDATE`, [roundId])).rows[0];
  if (!r) throw notFound();
  if (r.status !== 'PENDING_APPROVAL') throw conflict('already_decided', 'Bu tur için karar zaten verildi.');
  if (body.approve && r.closes_at.getTime() <= Date.now()) throw unprocessable('closes_at_passed', 'Kapanış zamanı geçmiş; yeni kapanışla tekrar gönderilmeli.');
  const p = await loadProject(tx, r.project_id, true);
  // Politika adımları: talep eden onaylayamaz, aynı kişi iki adımı onaylayamaz, adım rolü zorunlu.
  const step = await approvals.decideStep(tx, ctx, { entityType: 'rfq_round', entityId: roundId, action: 'RFQ_PUBLISH', companyId: r.company_id, requestedBy: r.requested_by,
    title: `Yayın onayı: ${p.title} (${r.round_no}. tur)`, projectId: p.id }, body.approve, body.note);
  if (step === 'PENDING') return { status: 'PENDING_APPROVAL' };
  if (body.approve) {
    // Teklif süresi tedarikçi için yayın anında başlar: onay gecikmesi politikadaki en az süreyi kısaltmamalı.
    const minDays = (await tx.query<{ d: number | null }>(`SELECT (plan->>'minResponseDays')::int AS d FROM approval_requests WHERE entity_type = 'rfq_round' AND entity_id = $1`, [roundId])).rows[0]?.d ?? null;
    const urgent = (await tx.query(`SELECT 1 FROM sourcing_exceptions WHERE used_round_id = $1 AND kind = 'URGENT'`, [roundId])).rowCount;
    if (minDays && !urgent && (r.closes_at.getTime() - Date.now()) / 86_400_000 < minDays) {
      throw unprocessable('closes_at_too_short', `Onay sürecinde kalan teklif süresi politikadaki en az ${minDays} günün altına düştü; geri gönderip yeni kapanışla yayına gönderin veya acil alım istisnası alın.`);
    }
    await tx.query(`UPDATE rfq_rounds SET status = 'OPEN', approved_by = $2, approved_at = now() WHERE id = $1`, [roundId, ctx.userId]);
    await bump(tx, p.id, 'OPEN');
  } else {
    await tx.query(`UPDATE rfq_rounds SET status = 'CANCELLED', close_reason = $2 WHERE id = $1`, [roundId, body.note!.trim()]);
    const prevRound = (await tx.query(`SELECT 1 FROM rfq_rounds WHERE project_id = $1 AND status = 'CLOSED'`, [p.id])).rowCount;
    await bump(tx, p.id, prevRound ? 'EVALUATION' : 'DRAFT');
  }
  await closeTasks(tx, `rfq-publish:${roundId}`);
  await audit(tx, ctx, body.approve ? 'rfq.published' : 'rfq.publish_rejected', 'rfq_round', roundId, { projectId: p.id }, body.note);
  return { status: body.approve ? 'OPEN' : 'CANCELLED' };
}

// --- Kaynak bulma istisnaları (02 §5): tek kaynak, acil alım, iptal, sonuçsuz kapanış; onay motoruyla karara bağlanır ---

const EX_TEXT = { SINGLE_SOURCE: 'Tek kaynak', URGENT: 'Acil alım', CANCEL: 'Projeyi iptal', NO_AWARD: 'Sonuçsuz kapanış' } as const;
type ExKind = keyof typeof EX_TEXT;
const EX_STATES: Record<ExKind, string[]> = {
  SINGLE_SOURCE: ['DRAFT', 'EVALUATION'], URGENT: ['DRAFT', 'EVALUATION'],
  CANCEL: ['DRAFT', 'IN_APPROVAL', 'OPEN', 'EVALUATION', 'AWARD_APPROVAL'], NO_AWARD: ['EVALUATION'],
};

export async function requestException(tx: Tx, ctx: TenantContext, projectId: string, b: { kind: ExKind; reason: string; supplierId?: string | null }) {
  const p = await loadProject(tx, projectId, true);
  if (!EX_STATES[b.kind].includes(p.status)) throw conflict('invalid_state', `${EX_TEXT[b.kind]} istisnası bu aşamada istenemez.`);
  if (b.reason.trim().length < 20) throw unprocessable('reason_required', 'Gerekçe en az 20 karakter olmalı (neden, kapsam, alternatifler).');
  if (b.kind === 'SINGLE_SOURCE') {
    if (!b.supplierId) throw unprocessable('supplier_required', 'Tek kaynak istisnasında tedarikçi seçilmeli.');
    const sup = (await tx.query<{ status: string }>(`SELECT status FROM suppliers WHERE id = $1`, [b.supplierId])).rows[0];
    if (!sup) throw notFound();
  }
  const ex = (await tx.query<{ id: string }>(`INSERT INTO sourcing_exceptions (tenant_id, company_id, project_id, kind, reason, details, requested_by) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
    [ctx.tenantId, p.company_id, projectId, b.kind, b.reason.trim(), b.supplierId ? { supplierId: b.supplierId } : {}, ctx.userId])).rows[0]!;
  const { policyId, plan } = await approvals.planFor(tx, { action: 'SOURCING_EXCEPTION', companyId: p.company_id, category: p.category, currency: p.currency, amount: p.budget });
  await approvals.openRequest(tx, ctx, { companyId: p.company_id, entityType: 'sourcing_exception', entityId: ex.id, action: 'SOURCING_EXCEPTION', policyId, plan,
    title: `${EX_TEXT[b.kind]} istisnası: ${p.title}`, projectId });
  await audit(tx, ctx, 'sourcing.exception_requested', 'project', projectId, { exceptionId: ex.id, kind: b.kind }, b.reason.trim());
  return { id: ex.id, approval: { steps: plan.steps, explanation: plan.explanation } };
}

export async function decideException(tx: Tx, ctx: TenantContext, exceptionId: string, b: { approve: boolean; note?: string }) {
  const ex = (await tx.query<{ project_id: string; company_id: string; kind: ExKind; status: string; requested_by: string }>(
    `SELECT project_id, company_id, kind, status, requested_by FROM sourcing_exceptions WHERE id = $1 FOR UPDATE`, [exceptionId])).rows[0];
  if (!ex) throw notFound();
  if (ex.status !== 'REQUESTED') throw conflict('already_decided', 'Bu istisna için karar verildi.');
  const p = await loadProject(tx, ex.project_id, true);
  if (b.approve && !EX_STATES[ex.kind].includes(p.status)) throw conflict('invalid_state', `Proje aşaması değişti (${p.status}); istisna artık uygulanamaz, geri gönderin.`);
  const step = await approvals.decideStep(tx, ctx, { entityType: 'sourcing_exception', entityId: exceptionId, action: 'SOURCING_EXCEPTION', companyId: ex.company_id,
    requestedBy: ex.requested_by, title: `${EX_TEXT[ex.kind]} istisnası: ${p.title}`, projectId: p.id }, b.approve, b.note);
  if (step === 'PENDING') return { status: 'REQUESTED' };
  if (step === 'REJECTED') {
    await tx.query(`UPDATE sourcing_exceptions SET status = 'REJECTED', decided_at = now() WHERE id = $1`, [exceptionId]);
    await audit(tx, ctx, 'sourcing.exception_rejected', 'project', p.id, { exceptionId, kind: ex.kind }, b.note);
    return { status: 'REJECTED' };
  }
  await tx.query(`UPDATE sourcing_exceptions SET status = 'APPROVED', decided_at = now() WHERE id = $1`, [exceptionId]);
  if (ex.kind === 'CANCEL' || ex.kind === 'NO_AWARD') {
    // Proje kapanır: bekleyen/açık turlar ve karar bekleyen seçim önerisi kapanır (tedarikçi portalında tur kapalı görünür).
    const reason = ex.kind === 'CANCEL' ? 'Proje iptal edildi (onaylı istisna).' : 'Proje sonuçsuz kapandı (onaylı istisna).';
    const rounds = (await tx.query<{ id: string }>(`UPDATE rfq_rounds SET status = 'CANCELLED', close_reason = $2 WHERE project_id = $1 AND status IN ('PENDING_APPROVAL','OPEN') RETURNING id`, [p.id, reason])).rows;
    for (const r of rounds) { await approvals.cancelRequest(tx, 'rfq_round', r.id); await closeTasks(tx, `rfq-publish:${r.id}`); }
    const awards = (await tx.query<{ id: string }>(`UPDATE awards SET status = 'REJECTED', decided_by = $2, decided_at = now(), decision_note = $3 WHERE project_id = $1 AND status = 'PROPOSED' RETURNING id`, [p.id, ctx.userId, reason])).rows;
    for (const a of awards) { await approvals.cancelRequest(tx, 'award', a.id); await closeTasks(tx, `award:${a.id}`); }
    // Bu projenin kullanılmamış diğer istisnaları da düşer (onay kayıtları ve görevleriyle).
    const siblings = (await tx.query<{ id: string }>(`UPDATE sourcing_exceptions SET status = 'REJECTED', decided_at = now() WHERE project_id = $1 AND id <> $2 AND status IN ('REQUESTED','APPROVED') RETURNING id`, [p.id, exceptionId])).rows;
    for (const x of siblings) await approvals.cancelRequest(tx, 'sourcing_exception', x.id);
    await bump(tx, p.id, ex.kind === 'CANCEL' ? 'CANCELLED' : 'NO_AWARD');
  }
  await audit(tx, ctx, 'sourcing.exception_approved', 'project', p.id, { exceptionId, kind: ex.kind });
  return { status: 'APPROVED' };
}

export async function listExceptions(tx: Tx, ctx: TenantContext, projectId: string) {
  const rows = (await tx.query<{ id: string }>(`SELECT x.id, x.kind, x.reason, x.details, x.status, x.requested_at AS "requestedAt", u.display_name AS "requestedBy", x.requested_by = $2 AS "requestedByMe",
      x.decided_at AS "decidedAt", s.legal_name AS "supplierName"
    FROM sourcing_exceptions x JOIN users u ON u.id = x.requested_by LEFT JOIN suppliers s ON s.id = (x.details->>'supplierId')::uuid
    WHERE x.project_id = $1 ORDER BY x.requested_at DESC`, [projectId, ctx.userId])).rows;
  for (const r of rows as any[]) r.approval = await approvals.stateFor(tx, ctx, 'sourcing_exception', r.id);
  return rows;
}

/** Yetkili erken kapanış: gerekçe zorunlu (02 §5 durum tablosu). */
export async function closeRoundEarly(tx: Tx, ctx: TenantContext, roundId: string, reason: string) {
  if (reason.trim().length < 10) throw unprocessable('reason_required', 'Erken kapanış için gerekçe gerekli.');
  const r = (await tx.query<{ project_id: string; status: string }>(`SELECT project_id, status FROM rfq_rounds WHERE id = $1 FOR UPDATE`, [roundId])).rows[0];
  if (!r) throw notFound();
  if (r.status !== 'OPEN') throw conflict('not_open', 'Yalnız açık tur kapatılabilir.');
  await tx.query(`UPDATE rfq_rounds SET status = 'CLOSED', closed_at = now(), close_reason = $2 WHERE id = $1`, [roundId, reason.trim()]);
  await bump(tx, r.project_id, 'EVALUATION');
  await audit(tx, ctx, 'rfq.closed_early', 'rfq_round', roundId, {}, reason.trim());
  return { status: 'CLOSED' };
}

// --- Okuma (alıcı) --------------------------------------------------------------------------

export async function listProjects(tx: Tx, f: { departmentId?: string } = {}) {
  return (await tx.query(`SELECT p.id, p.code, p.title, p.category, p.status, p.currency, p.budget, p.budget_verified AS "budgetVerified",
      p.updated_at AS "updatedAt", le.name AS "companyName", u.display_name AS "ownerName",
      p.department_id AS "departmentId", (SELECT d.name FROM departments d WHERE d.id = p.department_id) AS "departmentName",
      (SELECT closes_at FROM rfq_rounds r WHERE r.project_id = p.id AND r.status IN ('OPEN','PENDING_APPROVAL') ORDER BY round_no DESC LIMIT 1) AS "closesAt",
      (SELECT count(*)::int FROM bids b WHERE b.project_id = p.id AND b.status = 'SUBMITTED') AS "bidCount"
    FROM projects p JOIN legal_entities le ON le.id = p.company_id JOIN users u ON u.id = p.owner_user_id
    WHERE p.company_id = ANY (app_company_ids()) AND ($1::uuid IS NULL OR p.department_id = $1)
    ORDER BY p.updated_at DESC LIMIT 200`, [f.departmentId ?? null])).rows;
}

async function latestRound(tx: Tx, projectId: string) {
  return (await tx.query<{ id: string; round_no: number; closes_at: Date; status: string; requested_by: string; approved_by: string | null; close_reason: string | null }>(
    `SELECT id, round_no, closes_at, status, requested_by, approved_by, close_reason FROM rfq_rounds
     WHERE project_id = $1 AND status <> 'CANCELLED' ORDER BY round_no DESC LIMIT 1`, [projectId])).rows[0] ?? null;
}

/** Karşılaştırma girdisi: son kapanmış turun güncel teklifleri, güncel kriterler, son puanlar, kur varsayımları. */
async function comparisonInput(tx: Tx, p: ProjectRow) {
  const round = (await tx.query<{ id: string }>(`SELECT id FROM rfq_rounds WHERE project_id = $1 AND status = 'CLOSED' ORDER BY round_no DESC LIMIT 1`, [p.id])).rows[0];
  if (!round) throw conflict('bids_sealed', 'Teklifler tur kapanana kadar mühürlü; karşılaştırma kapanıştan sonra açılır.');
  const lines = await currentLines(tx, p.id);
  const criteria = await currentCriteria(tx, p.id);
  const bidRows = (await tx.query<{ id: string; supplier_id: string; legal_name: string; status: string; currency: string; version_no: number; submitted_at: Date }>(
    `SELECT b.id, b.supplier_id, s.legal_name, s.status, b.currency, b.version_no, b.submitted_at FROM bids b JOIN suppliers s ON s.id = b.supplier_id
     WHERE b.round_id = $1 AND b.status = 'SUBMITTED' ORDER BY s.legal_name`, [round.id])).rows;
  const bids: Bid[] = [];
  for (const b of bidRows) {
    const bl = await tx.query(`SELECT project_line_id AS "projectLineId", unit, trim_scale(quantity)::text AS quantity, trim_scale(unit_price)::text AS "unitPrice", scope FROM bid_lines WHERE bid_id = $1`, [b.id]);
    const bc = await tx.query(`SELECT kind, amount::text FROM bid_costs WHERE bid_id = $1`, [b.id]);
    bids.push({ bidId: b.id, supplierId: b.supplier_id, supplierName: b.legal_name, supplierStatus: b.status, currency: b.currency, lines: bl.rows, costs: bc.rows });
  }
  const scores: Score[] = (await tx.query(`SELECT DISTINCT ON (bid_id, criterion_code) bid_id AS "bidId", criterion_code AS "criterionCode", score::text
    FROM bid_scores WHERE project_id = $1 ORDER BY bid_id, criterion_code, scored_at DESC`, [p.id])).rows;
  const fx: FxRate[] = (await tx.query(`SELECT DISTINCT ON (currency) currency, rate::text, source, as_of::text AS "asOf"
    FROM project_fx_rates WHERE project_id = $1 ORDER BY currency, created_at DESC`, [p.id])).rows;
  const basis = evaluationBasis({ bidIds: bids.map((b) => b.bidId), criteria, scores, fx });
  return { roundId: round.id, lines, criteria, bids, bidRows, scores, fx, basisHash: sha(basis) };
}

export async function getComparison(tx: Tx, id: string) {
  const p = await loadProject(tx, id);
  await settleRounds(tx, id);
  const inp = await comparisonInput(tx, p);
  const comparison = compareBids({ currency: p.currency, lines: inp.lines, bids: inp.bids, criteria: inp.criteria, scores: inp.scores, fx: inp.fx });
  // Aynı transaction bağlantısında sorgular sıralı çalışır.
  const bids = [];
  for (const b of inp.bidRows) {
    bids.push({ bidId: b.id, supplierId: b.supplier_id, supplierName: b.legal_name, versionNo: b.version_no, submittedAt: b.submitted_at,
      attachments: (await tx.query(`SELECT f.id, f.title, f.original_filename AS "filename", f.size_bytes::int AS "sizeBytes" FROM bid_attachments a
        JOIN bid_files f ON f.id = a.file_id WHERE a.bid_id = $1 ORDER BY f.uploaded_at`, [b.id])).rows });
  }
  return {
    currency: p.currency, lines: inp.lines, criteria: inp.criteria, comparison, basisHash: inp.basisHash,
    bids,
    scores: (await tx.query(`SELECT DISTINCT ON (s.bid_id, s.criterion_code) s.bid_id AS "bidId", s.criterion_code AS "criterionCode", s.score::text,
        s.evidence, u.display_name AS "scoredBy", s.scored_at AS "scoredAt"
      FROM bid_scores s JOIN users u ON u.id = s.scored_by WHERE s.project_id = $1 ORDER BY s.bid_id, s.criterion_code, s.scored_at DESC`, [id])).rows,
  };
}

export async function getProject(tx: Tx, ctx: TenantContext, id: string) {
  await settleRounds(tx, id);
  const p = await loadProject(tx, id);
  const round = await latestRound(tx, id);
  const invitations = round ? (await tx.query(`SELECT i.supplier_id AS "supplierId", s.legal_name AS "supplierName", s.status AS "supplierStatus",
      (SELECT version_no FROM bids b WHERE b.round_id = i.round_id AND b.supplier_id = i.supplier_id AND b.status = 'SUBMITTED') AS "bidVersion",
      (SELECT submitted_at FROM bids b WHERE b.round_id = i.round_id AND b.supplier_id = i.supplier_id AND b.status = 'SUBMITTED') AS "submittedAt"
    FROM rfq_invitations i JOIN suppliers s ON s.id = i.supplier_id WHERE i.round_id = $1 ORDER BY s.legal_name`, [round.id])).rows : [];
  const questions = (await tx.query(`SELECT q.id, q.question, q.asked_at AS "askedAt", q.answer, q.answered_at AS "answeredAt", s.legal_name AS "supplierName"
    FROM rfq_questions q JOIN suppliers s ON s.id = q.supplier_id WHERE q.project_id = $1 ORDER BY q.asked_at`, [id])).rows;
  // Değerlendirme güncelliği saklanmaz; güncel dayanak parmak iziyle karşılaştırılır (T11).
  let currentBasis: string | null = null;
  try { currentBasis = (await comparisonInput(tx, p)).basisHash; } catch (e) { if (!(e instanceof ApiError)) throw e; }
  const evaluations = (await tx.query<{ id: string; version_no: number; basis_hash: string; created_at: Date; created_by_name: string }>(
    `SELECT e.id, e.version_no, e.basis_hash, e.created_at, u.display_name AS created_by_name FROM evaluations e JOIN users u ON u.id = e.created_by
     WHERE e.project_id = $1 ORDER BY e.version_no DESC`, [id])).rows
    .map((e) => ({ id: e.id, versionNo: e.version_no, createdAt: e.created_at, createdBy: e.created_by_name, current: e.basis_hash === currentBasis }));
  const awards = (await tx.query(`SELECT a.id, a.version_no AS "versionNo", a.status, a.total::text, a.rationale, a.evaluation_id AS "evaluationId",
      a.proposed_at AS "proposedAt", pu.display_name AS "proposedBy", a.proposed_by = $2 AS "proposedByMe",
      a.decided_at AS "decidedAt", du.display_name AS "decidedBy", a.decision_note AS "decisionNote"
    FROM awards a JOIN users pu ON pu.id = a.proposed_by LEFT JOIN users du ON du.id = a.decided_by WHERE a.project_id = $1 ORDER BY a.version_no DESC`, [id, ctx.userId])).rows;
  for (const a of awards) {
    a.lines = (await tx.query(`SELECT al.project_line_id AS "projectLineId", al.supplier_id AS "supplierId", s.legal_name AS "supplierName",
        trim_scale(al.quantity)::text AS quantity, trim_scale(al.unit_price)::text AS "unitPrice", al.amount::text FROM award_lines al JOIN suppliers s ON s.id = al.supplier_id WHERE al.award_id = $1`, [a.id])).rows;
    a.evaluationCurrent = evaluations.find((e) => e.id === a.evaluationId)?.current ?? false;
    a.approval = await approvals.stateFor(tx, ctx, 'award', a.id);
  }
  const roundApproval = round ? await approvals.stateFor(tx, ctx, 'rfq_round', round.id) : null;
  // Yeni tur için geçerli politika (davet ve süre kuralları ekranda önceden görünür).
  const publishPolicy = (await approvals.planFor(tx, { action: 'RFQ_PUBLISH', companyId: p.company_id, category: p.category, currency: p.currency, amount: p.budget })).plan;
  const criteriaHistory = (await tx.query(`SELECT DISTINCT revision, reason, created_at AS "createdAt" FROM evaluation_criteria WHERE project_id = $1 ORDER BY revision`, [id])).rows;
  return {
    project: {
      id: p.id, code: p.code, title: p.title, category: p.category, need: p.need, currency: p.currency, budget: p.budget, budgetVerified: p.budget_verified,
      costCenter: p.cost_center, deliveryLocation: p.delivery_location, neededBy: p.needed_by, status: p.status, companyId: p.company_id,
      ownedByMe: p.owner_user_id === ctx.userId, etag: projectEtag(p), updatedAt: p.updated_at,
      departmentId: p.department_id,
      departmentName: p.department_id ? (await tx.query<{ name: string }>(`SELECT name FROM departments WHERE id = $1`, [p.department_id])).rows[0]?.name ?? null : null,
    },
    lines: await currentLines(tx, id), criteria: await currentCriteria(tx, id), criteriaHistory,
    round: round && { id: round.id, roundNo: round.round_no, closesAt: round.closes_at, status: round.status, requestedByMe: round.requested_by === ctx.userId, closeReason: round.close_reason, approval: roundApproval },
    invitations, questions, evaluations, awards, exceptions: await listExceptions(tx, ctx, id),
    publishPolicy: { minInvitees: publishPolicy.minInvitees, minResponseDays: publishPolicy.minResponseDays, steps: publishPolicy.steps, explanation: publishPolicy.explanation },
    serverTime: new Date(),
  };
}

// --- Puan, kur, değerlendirme -------------------------------------------------------------

export async function scoreBid(tx: Tx, ctx: TenantContext, bidId: string, body: { criterionCode: string; score: string; evidence: string }) {
  const b = (await tx.query<{ project_id: string; company_id: string; round_status: string; closes_at: Date }>(
    `SELECT b.project_id, b.company_id, r.status AS round_status, r.closes_at FROM bids b JOIN rfq_rounds r ON r.id = b.round_id WHERE b.id = $1`, [bidId])).rows[0];
  if (!b) throw notFound();
  if (b.round_status === 'OPEN' && b.closes_at.getTime() > Date.now()) throw conflict('bids_sealed', 'Tur kapanmadan teklif puanlanamaz.');
  const c = (await currentCriteria(tx, b.project_id)).find((x) => x.code === body.criterionCode);
  if (!c || c.kind !== 'SCORE') throw unprocessable('unknown_criterion', 'Puanlanabilir kriter bulunamadı (fiyat puanı hesaplanır, elle girilmez).');
  if (!isDecimal(body.score) || Number(body.score) < 0 || Number(body.score) > 100) throw unprocessable('invalid_score', 'Puan 0–100 arasında olmalı.');
  if (body.evidence.trim().length < 10) throw unprocessable('evidence_required', 'Teknik puan kanıtla verilir: en az 10 karakter.');
  await tx.query(`INSERT INTO bid_scores (tenant_id, company_id, project_id, bid_id, criterion_code, score, evidence, scored_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [ctx.tenantId, b.company_id, b.project_id, bidId, body.criterionCode, body.score, body.evidence.trim(), ctx.userId]);
  await audit(tx, ctx, 'bid.scored', 'bid', bidId, { criterion: body.criterionCode, score: body.score });
  return { ok: true };
}

export async function addFxRate(tx: Tx, ctx: TenantContext, id: string, body: { currency: string; rate: string; source: string; asOf: string }) {
  const p = await loadProject(tx, id);
  if (!isDecimal(body.rate) || Number(body.rate) <= 0) throw unprocessable('invalid_rate', 'Kur pozitif ondalık sayı olmalı.');
  if (body.currency.toUpperCase() === p.currency) throw unprocessable('same_currency', 'Proje para birimi için kur girilmez.');
  await tx.query(`INSERT INTO project_fx_rates (tenant_id, company_id, project_id, currency, rate, source, as_of, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [ctx.tenantId, p.company_id, id, body.currency.toUpperCase(), body.rate, body.source.trim(), body.asOf, ctx.userId]);
  await audit(tx, ctx, 'project.fx_rate_added', 'project', id, { currency: body.currency, rate: body.rate, source: body.source, asOf: body.asOf });
  return { ok: true };
}

export async function createEvaluation(tx: Tx, ctx: TenantContext, id: string) {
  const p = await loadProject(tx, id, true);
  await settleRounds(tx, id);
  const inp = await comparisonInput(tx, p);
  const comparison = compareBids({ currency: p.currency, lines: inp.lines, bids: inp.bids, criteria: inp.criteria, scores: inp.scores, fx: inp.fx });
  if (!comparison.criteriaValid) throw unprocessable('invalid_criteria', comparison.criteriaError!);
  const versionNo = (await tx.query<{ n: number }>(`SELECT coalesce(max(version_no), 0) + 1 AS n FROM evaluations WHERE project_id = $1`, [id])).rows[0]!.n;
  const snapshot = { comparison, lines: inp.lines, criteria: inp.criteria, scores: inp.scores, fx: inp.fx,
    bids: inp.bidRows.map((b) => ({ bidId: b.id, supplierName: b.legal_name, versionNo: b.version_no, submittedAt: b.submitted_at })), engine: 'sp-domain/compareBids@1' };
  const e = (await tx.query<{ id: string }>(`INSERT INTO evaluations (tenant_id, company_id, project_id, version_no, basis_hash, snapshot, created_by)
    VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`, [ctx.tenantId, p.company_id, id, versionNo, inp.basisHash, snapshot, ctx.userId])).rows[0]!;
  await audit(tx, ctx, 'evaluation.created', 'evaluation', e.id, { projectId: id, versionNo, basisHash: inp.basisHash });
  return { id: e.id, versionNo };
}

export async function getEvaluation(tx: Tx, evaluationId: string) {
  const e = (await tx.query<{ id: string; project_id: string; version_no: number; basis_hash: string; snapshot: any; created_at: Date; created_by: string }>(
    `SELECT e.*, u.display_name AS created_by FROM evaluations e JOIN users u ON u.id = e.created_by WHERE e.id = $1`, [evaluationId])).rows[0];
  if (!e) throw notFound();
  const p = await loadProject(tx, e.project_id);
  let current = false;
  try { current = (await comparisonInput(tx, p)).basisHash === e.basis_hash; } catch (err) { if (!(err instanceof ApiError)) throw err; }
  return { id: e.id, versionNo: e.version_no, createdAt: e.created_at, createdBy: e.created_by, basisHash: e.basis_hash, current, project: p, snapshot: e.snapshot };
}

// --- Tahsis ----------------------------------------------------------------------------------

/** T20: güncel değerlendirmesinde kritik engel olan tedarikçiye seçim yapılamaz; ağırlıklı/ticari puan bu engeli aşmaz. */
async function assertNoCriticalBlock(tx: Tx, supplierIds: string[]) {
  const blocks = await criticalBlocks(tx, [...new Set(supplierIds)]);
  if (blocks.size) throw unprocessable('critical_blocker', [...blocks.values()][0]!, { suppliers: [...blocks.keys()] });
}

export async function proposeAward(tx: Tx, ctx: TenantContext, id: string, body: { evaluationId: string; rationale: string; allocations: AwardAllocation[] }) {
  const p = await loadProject(tx, id, true);
  if (p.status !== 'EVALUATION') throw conflict('invalid_state', 'Kazanan önerisi yalnız değerlendirme aşamasında yapılır.');
  const ev = await getEvaluation(tx, body.evaluationId);
  if (ev.project.id !== id) throw notFound();
  if (!ev.current) throw conflict('evaluation_stale', 'Değerlendirmeden sonra teklif, ağırlık, puan veya kur değişti; yeni değerlendirme sürümü oluşturun.');
  if (body.rationale.trim().length < 10) throw unprocessable('rationale_required', 'Seçim gerekçesi gerekli (en az 10 karakter).');
  const comparison = ev.snapshot.comparison as Comparison;
  const v = validateAward({ lines: ev.snapshot.lines, comparison, allocations: body.allocations, forApproval: false });
  if (v.issues.length) throw unprocessable('invalid_allocation', v.issues[0]!.message, { issues: v.issues });
  await assertNoCriticalBlock(tx, body.allocations.map((x) => x.supplierId));
  const versionNo = (await tx.query<{ n: number }>(`SELECT coalesce(max(version_no), 0) + 1 AS n FROM awards WHERE project_id = $1`, [id])).rows[0]!.n;
  const a = (await tx.query<{ id: string }>(`INSERT INTO awards (tenant_id, company_id, project_id, evaluation_id, version_no, rationale, total, proposed_by)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`, [ctx.tenantId, p.company_id, id, ev.id, versionNo, body.rationale.trim(), v.total, ctx.userId])).rows[0]!;
  for (const al of body.allocations) {
    const bid = comparison.bids.find((b) => b.supplierId === al.supplierId)!;
    const lr = bid.lines.find((l) => l.projectLineId === al.projectLineId)!;
    await tx.query(`INSERT INTO award_lines (tenant_id, company_id, award_id, project_line_id, supplier_id, bid_id, quantity, unit_price, amount)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8, round($7::numeric * $8::numeric, 2))`,
      [ctx.tenantId, p.company_id, a.id, al.projectLineId, al.supplierId, bid.bidId, al.quantity, lr.unitPrice]);
  }
  await bump(tx, id, 'AWARD_APPROVAL');
  const notActive = comparison.bids.filter((b) => body.allocations.some((x) => x.supplierId === b.supplierId) && b.supplierStatus !== 'ACTIVE');
  const { policyId, plan } = await approvals.planFor(tx, { action: 'AWARD', companyId: p.company_id, category: p.category, currency: p.currency, amount: v.total });
  await approvals.openRequest(tx, ctx, { companyId: p.company_id, entityType: 'award', entityId: a.id, action: 'AWARD', policyId, plan,
    title: `Seçim onayı: ${p.title}${notActive.length ? ` (aktif olmayan tedarikçi: ${notActive.map((b) => b.supplierName).join(', ')})` : ''}`, projectId: id });
  await audit(tx, ctx, 'award.proposed', 'award', a.id, { projectId: id, evaluationId: ev.id, total: v.total, lines: body.allocations.length });
  return { id: a.id, versionNo, total: v.total, warnings: notActive.map((b) => `${b.supplierName} aktif değil; onay için aktivasyon gerekir.`) };
}

export async function decideAward(tx: Tx, ctx: TenantContext, awardId: string, body: { approve: boolean; note?: string }) {
  const a = (await tx.query<{ id: string; project_id: string; company_id: string; evaluation_id: string; status: string; proposed_by: string }>(
    `SELECT id, project_id, company_id, evaluation_id, status, proposed_by FROM awards WHERE id = $1 FOR UPDATE`, [awardId])).rows[0];
  if (!a) throw notFound();
  if (a.status !== 'PROPOSED') throw conflict('already_decided', 'Bu öneri için karar verildi.');
  if (a.proposed_by === ctx.userId) throw new ApiError(403, 'segregation_of_duties', 'Öneriyi yapan kişi tek başına onaylayamaz (görev ayrılığı).');
  if (!body.approve && (body.note ?? '').trim().length < 5) throw unprocessable('note_required', 'Geri gönderme nedeni gerekli.');
  if (body.approve) {
    // Engel varsa adım kaydedilmeden önce söylenir (geçersiz karara onay adımı yazılmaz).
    const ev = await getEvaluation(tx, a.evaluation_id);
    if (!ev.current) throw conflict('evaluation_stale', 'Öneri yapıldıktan sonra değerlendirme dayanağı değişti; güncel olmayan karar onaylanamaz.');
    const allocations: AwardAllocation[] = (await tx.query(`SELECT project_line_id AS "projectLineId", supplier_id AS "supplierId", trim_scale(quantity)::text AS quantity FROM award_lines WHERE award_id = $1`, [awardId])).rows;
    // Tedarikçi durumu onay anında yeniden okunur (öneri sonrası askıya alınmış olabilir).
    const comparison = ev.snapshot.comparison as Comparison;
    const statuses = new Map((await tx.query<{ id: string; status: string }>(`SELECT id, status FROM suppliers WHERE id = ANY($1::uuid[])`, [allocations.map((x) => x.supplierId)])).rows.map((r) => [r.id, r.status]));
    const live: Comparison = { ...comparison, bids: comparison.bids.map((b) => ({ ...b, supplierStatus: statuses.get(b.supplierId) ?? b.supplierStatus })) };
    const v = validateAward({ lines: ev.snapshot.lines, comparison: live, allocations, forApproval: true });
    if (v.issues.length) throw unprocessable('award_blocked', v.issues[0]!.message, { issues: v.issues });
    await assertNoCriticalBlock(tx, allocations.map((x) => x.supplierId));
  }
  const p = await loadProject(tx, a.project_id);
  const step = await approvals.decideStep(tx, ctx, { entityType: 'award', entityId: awardId, action: 'AWARD', companyId: a.company_id, requestedBy: a.proposed_by,
    title: `Seçim onayı: ${p.title}`, projectId: a.project_id }, body.approve, body.note);
  if (step === 'PENDING') return { status: 'PROPOSED' };
  await tx.query(`UPDATE awards SET status = $2, decided_by = $3, decided_at = now(), decision_note = $4 WHERE id = $1`,
    [awardId, body.approve ? 'APPROVED' : 'REJECTED', ctx.userId, body.note?.trim() || null]);
  await bump(tx, a.project_id, body.approve ? 'CONTRACTING' : 'EVALUATION');
  await closeTasks(tx, `award:${awardId}`);
  await audit(tx, ctx, body.approve ? 'award.approved' : 'award.rejected', 'award', awardId, { projectId: a.project_id }, body.note);
  return { status: body.approve ? 'APPROVED' : 'REJECTED' };
}

export async function answerQuestion(tx: Tx, ctx: TenantContext, questionId: string, answer: string) {
  if (answer.trim().length < 3) throw unprocessable('answer_required', 'Yanıt gerekli.');
  const r = await tx.query(`UPDATE rfq_questions SET answer = $2, answered_by = $3, answered_at = now() WHERE id = $1 AND answered_at IS NULL RETURNING project_id`,
    [questionId, answer.trim(), ctx.userId]);
  if (!r.rowCount) throw conflict('already_answered', 'Soru bulunamadı veya zaten yanıtlandı.');
  await audit(tx, ctx, 'rfq.question_answered', 'rfq_question', questionId, { projectId: r.rows[0].project_id });
  return { ok: true };
}

// --- Tedarikçi portalı -----------------------------------------------------------------------

function supplierOnly(ctx: TenantContext): string {
  if (!ctx.supplierId) throw forbidden('supplier_portal');
  return ctx.supplierId;
}

export async function portalList(tx: Tx, ctx: TenantContext) {
  const sid = supplierOnly(ctx);
  return (await tx.query(`SELECT p.id AS "projectId", p.code, p.title, p.currency, le.name AS "buyerName", r.id AS "roundId", r.round_no AS "roundNo",
      r.closes_at AS "closesAt", (r.status = 'OPEN' AND r.closes_at > now()) AS "open",
      (SELECT version_no FROM bids b WHERE b.round_id = r.id AND b.supplier_id = $1 AND b.status = 'SUBMITTED') AS "myVersion",
      (SELECT submitted_at FROM bids b WHERE b.round_id = r.id AND b.supplier_id = $1 AND b.status = 'SUBMITTED') AS "mySubmittedAt"
    FROM rfq_invitations i JOIN rfq_rounds r ON r.id = i.round_id JOIN projects p ON p.id = i.project_id JOIN legal_entities le ON le.id = p.company_id
    WHERE i.supplier_id = $1 AND r.status IN ('OPEN','CLOSED') ORDER BY r.closes_at DESC`, [sid])).rows;
}

export async function portalProject(tx: Tx, ctx: TenantContext, roundId: string) {
  const sid = supplierOnly(ctx);
  const r = (await tx.query<{ id: string; project_id: string; round_no: number; closes_at: Date; status: string }>(
    `SELECT r.id, r.project_id, r.round_no, r.closes_at, r.status FROM rfq_rounds r JOIN rfq_invitations i ON i.round_id = r.id AND i.supplier_id = $2
     WHERE r.id = $1 AND r.status IN ('OPEN','CLOSED')`, [roundId, sid])).rows[0];
  if (!r) throw notFound();
  // Tedarikçiye bütçe, maliyet merkezi, kurum içi notlar ve diğer teklifler gösterilmez.
  const p = (await tx.query(`SELECT p.code, p.title, p.category, p.need, p.currency, p.delivery_location AS "deliveryLocation", p.needed_by AS "neededBy",
      le.name AS "buyerName" FROM projects p JOIN legal_entities le ON le.id = p.company_id WHERE p.id = $1`, [r.project_id])).rows[0];
  const myBids = (await tx.query<{ id: string; version_no: number; status: string; currency: string; submitted_at: Date; note: string; validity_days: number | null }>(
    `SELECT id, version_no, status, currency, submitted_at, note, validity_days FROM bids WHERE round_id = $1 AND supplier_id = $2 ORDER BY version_no DESC`, [roundId, sid])).rows;
  const current = myBids.find((b) => b.status === 'SUBMITTED');
  const currentLinesRows = current ? (await tx.query(`SELECT project_line_id AS "projectLineId", unit, trim_scale(quantity)::text AS quantity, trim_scale(unit_price)::text AS "unitPrice", scope, note FROM bid_lines WHERE bid_id = $1`, [current.id])).rows : [];
  const currentCosts = current ? (await tx.query(`SELECT kind, amount::text, note FROM bid_costs WHERE bid_id = $1`, [current.id])).rows : [];
  const files = (await tx.query(`SELECT id, title, original_filename AS "filename", mime_type AS "mimeType", size_bytes::int AS "sizeBytes",
      basic_check_status AS "status", basic_check_reason AS "reason", uploaded_at AS "uploadedAt" FROM bid_files WHERE round_id = $1 AND supplier_id = $2 ORDER BY uploaded_at`, [roundId, sid])).rows;
  const currentAttachments = current ? (await tx.query<{ file_id: string }>(`SELECT file_id FROM bid_attachments WHERE bid_id = $1`, [current.id])).rows.map((x) => x.file_id) : [];
  const qa = (await tx.query(`SELECT id, question, asked_at AS "askedAt", answer, answered_at AS "answeredAt", supplier_id = $2 AS "mine"
    FROM rfq_questions WHERE round_id = $1 AND (supplier_id = $2 OR answered_at IS NOT NULL) ORDER BY asked_at`, [roundId, sid])).rows;
  return {
    project: p, round: { id: r.id, roundNo: r.round_no, closesAt: r.closes_at, open: r.status === 'OPEN' && r.closes_at.getTime() > Date.now() },
    lines: await currentLines(tx, r.project_id), criteria: (await currentCriteria(tx, r.project_id)).map((c) => ({ name: c.name, kind: c.kind, weight: c.weight })),
    myBids: myBids.map((b) => ({ id: b.id, versionNo: b.version_no, status: b.status, currency: b.currency, submittedAt: b.submitted_at })),
    current: current ? { id: current.id, versionNo: current.version_no, currency: current.currency, note: current.note, validityDays: current.validity_days, lines: currentLinesRows, costs: currentCosts, attachmentIds: currentAttachments } : null,
    files,
    questions: qa.map((q) => ({ ...q, question: q.mine || q.answer ? q.question : null })), serverTime: new Date(),
  };
}

export interface BidInput {
  currency: string; validityDays?: number | null; note?: string;
  lines: { projectLineId: string; unit: string; quantity: string; unitPrice: string; scope: 'INCLUDED' | 'EXCLUDED' | 'ALTERNATIVE'; note?: string }[];
  costs?: { kind: 'SHIPPING' | 'INSTALLATION' | 'MAINTENANCE' | 'RENEWAL' | 'OTHER'; amount: string; note?: string }[];
  /** Bu tura yüklenmiş, kontrolden geçmiş ekler; teklif sürümüne bağlanır. */
  attachmentIds?: string[];
}

/** Teklif gönderimi: yeni sürüm, alındı zamanı sunucudan; aynı anahtarla tekrar gönderim ikinci kayıt açmaz. */
export async function submitBid(tx: Tx, ctx: TenantContext, roundId: string, idempotencyKey: string | undefined, body: BidInput) {
  const sid = supplierOnly(ctx);
  if (!idempotencyKey || !/^[\w-]{8,80}$/.test(idempotencyKey)) throw unprocessable('idempotency_key_required', 'Idempotency-Key başlığı gerekli.');
  // Aynı tedarikçinin aynı turdaki gönderimleri sıraya girer: eşzamanlı iki gönderim aynı sürüm numarasını alamaz.
  await tx.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`bid:${roundId}:${sid}`]);
  const prior = (await tx.query<{ id: string; version_no: number; submitted_at: Date }>(
    `SELECT id, version_no, submitted_at FROM bids WHERE supplier_id = $1 AND idempotency_key = $2`, [sid, idempotencyKey])).rows[0];
  if (prior) return { bidId: prior.id, versionNo: prior.version_no, submittedAt: prior.submitted_at, replay: true };
  const r = (await tx.query<{ id: string; project_id: string; company_id: string; status: string; closes_at: Date; now: Date }>(
    `SELECT r.id, r.project_id, r.company_id, r.status, r.closes_at, now() AS now FROM rfq_rounds r
     JOIN rfq_invitations i ON i.round_id = r.id AND i.supplier_id = $2 WHERE r.id = $1 FOR SHARE OF r`, [roundId, sid])).rows[0];
  if (!r) throw notFound();
  if (r.status !== 'OPEN' || r.now >= r.closes_at) {
    throw conflict('round_closed', `Teklif süresi doldu. Kapanış ${r.closes_at.toISOString()}, sunucu saati ${r.now.toISOString()}.`, { closesAt: r.closes_at, serverTime: r.now });
  }
  if (!/^[A-Z]{3}$/.test(body.currency)) throw unprocessable('invalid_currency', 'Para birimi ISO kodu olmalı (ör. TRY).');
  const lines = await currentLines(tx, r.project_id);
  const seen = new Set<string>();
  for (const l of body.lines) {
    if (!lines.some((x) => x.id === l.projectLineId)) throw unprocessable('unknown_line', 'Teklif satırı projedeki bir kalemle eşleşmiyor.');
    if (seen.has(l.projectLineId)) throw unprocessable('duplicate_line', 'Aynı kalem iki kez teklif edilemez.');
    seen.add(l.projectLineId);
    if (!isDecimal(l.quantity) || !isDecimal(l.unitPrice) || Number(l.quantity) < 0 || Number(l.unitPrice) < 0) {
      throw unprocessable('invalid_number', 'Miktar ve birim fiyat ondalık sayı olmalı.');
    }
  }
  for (const c of body.costs ?? []) if (!isDecimal(c.amount) || Number(c.amount) < 0) throw unprocessable('invalid_number', 'Ek maliyet tutarı ondalık sayı olmalı.');
  const attachmentIds = [...new Set(body.attachmentIds ?? [])];
  if (attachmentIds.length) {
    const f = await tx.query<{ id: string; basic_check_status: string }>(
      `SELECT id, basic_check_status FROM bid_files WHERE id = ANY($1::uuid[]) AND round_id = $2 AND supplier_id = $3`, [attachmentIds, roundId, sid]);
    if (f.rowCount !== attachmentIds.length) throw unprocessable('unknown_attachment', 'Ek bu tura yüklenmiş dosyalarınızdan biri değil.');
    if (f.rows.some((x) => x.basic_check_status !== 'PASSED')) throw unprocessable('attachment_quarantined', 'Karantinadaki dosya teklife eklenemez.');
  }
  const versionNo = (await tx.query<{ n: number }>(`SELECT coalesce(max(version_no), 0) + 1 AS n FROM bids WHERE round_id = $1 AND supplier_id = $2`, [roundId, sid])).rows[0]!.n;
  await tx.query(`UPDATE bids SET status = 'SUPERSEDED' WHERE round_id = $1 AND supplier_id = $2 AND status = 'SUBMITTED'`, [roundId, sid]);
  const b = (await tx.query<{ id: string; submitted_at: Date }>(
    `INSERT INTO bids (tenant_id, company_id, project_id, round_id, supplier_id, version_no, currency, validity_days, note, idempotency_key, submitted_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id, submitted_at`,
    [ctx.tenantId, r.company_id, r.project_id, roundId, sid, versionNo, body.currency, body.validityDays ?? null, body.note ?? '', idempotencyKey, ctx.userId])).rows[0]!;
  for (const l of body.lines) {
    await tx.query(`INSERT INTO bid_lines (tenant_id, company_id, bid_id, project_line_id, unit, quantity, unit_price, scope, note) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [ctx.tenantId, r.company_id, b.id, l.projectLineId, l.unit.trim(), l.quantity, l.unitPrice, l.scope, l.note ?? '']);
  }
  for (const c of body.costs ?? []) {
    await tx.query(`INSERT INTO bid_costs (tenant_id, company_id, bid_id, kind, amount, note) VALUES ($1,$2,$3,$4,$5,$6)`,
      [ctx.tenantId, r.company_id, b.id, c.kind, c.amount, c.note ?? '']);
  }
  for (const fid of attachmentIds) {
    await tx.query(`INSERT INTO bid_attachments (tenant_id, company_id, bid_id, file_id) VALUES ($1,$2,$3,$4)`, [ctx.tenantId, r.company_id, b.id, fid]);
  }
  await audit(tx, ctx, 'bid.submitted', 'bid', b.id, { roundId, versionNo, lines: body.lines.length, attachments: attachmentIds.length });
  return { bidId: b.id, versionNo, submittedAt: b.submitted_at, replay: false };
}

export async function askQuestion(tx: Tx, ctx: TenantContext, roundId: string, question: string) {
  const sid = supplierOnly(ctx);
  const r = (await tx.query<{ project_id: string; company_id: string; open: boolean }>(
    `SELECT r.project_id, r.company_id, (r.status = 'OPEN' AND r.closes_at > now()) AS open FROM rfq_rounds r
     JOIN rfq_invitations i ON i.round_id = r.id AND i.supplier_id = $2 WHERE r.id = $1`, [roundId, sid])).rows[0];
  if (!r) throw notFound();
  if (!r.open) throw conflict('round_closed', 'Tur kapandı; soru gönderilemez.');
  if (question.trim().length < 3) throw unprocessable('question_required', 'Soru gerekli.');
  const q = (await tx.query<{ id: string }>(`INSERT INTO rfq_questions (tenant_id, company_id, project_id, round_id, supplier_id, question, asked_by)
    VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`, [ctx.tenantId, r.company_id, r.project_id, roundId, sid, question.trim(), ctx.userId])).rows[0]!;
  await audit(tx, ctx, 'rfq.question_asked', 'rfq_question', q.id, { roundId });
  return { id: q.id };
}

// --- Teklif ekleri ---------------------------------------------------------------------------

/** Tedarikçi ek yükler (tur açıkken). Yerleşik dosya kontrolü; karantinadaki dosya teklife bağlanamaz. Aynı dosya tekrar yeni kayıt açmaz. */
export async function uploadBidFile(tx: Tx, ctx: TenantContext, store: ObjectStore, roundId: string, f: { filename: string; mimeType: string; body: Buffer; title: string }) {
  const sid = supplierOnly(ctx);
  const r = (await tx.query<{ project_id: string; company_id: string; open: boolean }>(
    `SELECT r.project_id, r.company_id, (r.status = 'OPEN' AND r.closes_at > now()) AS open FROM rfq_rounds r
     JOIN rfq_invitations i ON i.round_id = r.id AND i.supplier_id = $2 WHERE r.id = $1`, [roundId, sid])).rows[0];
  if (!r) throw notFound();
  if (!r.open) throw conflict('round_closed', 'Tur kapandı; ek yüklenemez.');
  const ins = inspectUpload(f.filename, f.mimeType, f.body);
  if ('rejected' in ins) throw unprocessable('file_rejected', ins.rejected);
  // Aynı dosyanın eşzamanlı ikinci yüklemesi çakışma hatası değil, mevcut kayda dönüş olmalı.
  await tx.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`bidfile:${roundId}:${sid}`]);
  const existing = (await tx.query(`SELECT id FROM bid_files WHERE round_id = $1 AND supplier_id = $2 AND sha256 = $3`, [roundId, sid, ins.sha256])).rows[0];
  if (existing) return { id: existing.id as string, duplicate: true, status: ins.status, reason: ins.reason };
  const key = objectKey(ctx.tenantId, ins.sha256);
  await tx.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`obj:${key}`]); // imha silmesiyle yarışmasın
  if (!(await store.exists(key))) await store.put(key, f.body, ins.mimeType);
  const row = (await tx.query<{ id: string }>(`INSERT INTO bid_files (tenant_id, company_id, project_id, round_id, supplier_id, title, original_filename, mime_type,
      size_bytes, sha256, storage_key, basic_check_status, basic_check_reason, uploaded_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING id`,
    [ctx.tenantId, r.company_id, r.project_id, roundId, sid, f.title.slice(0, 200), f.filename.slice(0, 255), ins.mimeType, ins.sizeBytes, ins.sha256, key,
      ins.status, ins.reason, ctx.userId])).rows[0]!;
  await audit(tx, ctx, 'bid.file_uploaded', 'bid_file', row.id, { roundId, status: ins.status, sizeBytes: ins.sizeBytes });
  return { id: row.id, duplicate: false, status: ins.status, reason: ins.reason };
}

/** Ek içeriği: tedarikçi kendi dosyasını, alıcı yalnız tur kapandıktan sonra (RLS). Her okuma denetim kaydına yazılır. */
export async function bidFileForDownload(tx: Tx, ctx: TenantContext, fileId: string) {
  const f = (await tx.query<{ storage_key: string; mime_type: string; original_filename: string; basic_check_status: string }>(
    `SELECT storage_key, mime_type, original_filename, basic_check_status FROM bid_files WHERE id = $1`, [fileId])).rows[0];
  if (!f) throw notFound();
  if (f.basic_check_status !== 'PASSED') throw new ApiError(423, 'quarantined', 'Dosya karantinada; görüntülenemez.');
  await audit(tx, ctx, 'bid.file_read', 'bid_file', fileId, {});
  return f;
}

export async function awardsForEvaluation(tx: Tx, evaluationId: string) {
  const awards = (await tx.query(`SELECT a.id, a.version_no AS "versionNo", a.status, a.total::text, a.rationale, pu.display_name AS "proposedBy", a.proposed_at AS "proposedAt",
      du.display_name AS "decidedBy", a.decided_at AS "decidedAt", a.decision_note AS "decisionNote"
    FROM awards a JOIN users pu ON pu.id = a.proposed_by LEFT JOIN users du ON du.id = a.decided_by WHERE a.evaluation_id = $1 ORDER BY a.version_no`, [evaluationId])).rows;
  for (const a of awards) {
    a.lines = (await tx.query(`SELECT pl.description, s.legal_name AS "supplierName", trim_scale(al.quantity)::text AS quantity, pl.unit,
        trim_scale(al.unit_price)::text AS "unitPrice", al.amount::text FROM award_lines al JOIN project_lines pl ON pl.id = al.project_line_id
        JOIN suppliers s ON s.id = al.supplier_id WHERE al.award_id = $1 ORDER BY pl.lot, pl.line_no, s.legal_name`, [a.id])).rows;
  }
  return awards;
}
