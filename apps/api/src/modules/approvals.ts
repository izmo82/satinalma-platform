import { approvalProgress, planApproval, validatePolicy, type ApprovalAction, type ApprovalPlan, type ApprovalPolicy, type ApprovalRule } from '@sp/domain';
import type { TenantContext, Tx } from '../db.ts';
import { audit } from '../audit.ts';
import { ApiError, conflict, notFound, unprocessable } from '../errors.ts';
import { closeTasks, openTask } from '../tasks.ts';

// Kurallı onay motoru (02 §13). Politika sürümlüdür; yayın ikinci kişi ister. Her onaylı iş başladığı andaki planı saklar
// (göç kararı: devam eden iş eski sürümle tamamlanır). Plan öncesi kayıtlar (motor öncesi açılmış işler) varsayılan tek adımla sürer.

export type EntityType = 'rfq_round' | 'award' | 'sourcing_exception';


async function activePolicy(tx: Tx): Promise<{ id: string; policy: ApprovalPolicy } | null> {
  const r = (await tx.query<{ id: string; version_no: number; rules: ApprovalRule[] }>(`SELECT id, version_no, rules FROM approval_policies WHERE status = 'ACTIVE'`)).rows[0];
  return r ? { id: r.id, policy: { version: r.version_no, rules: r.rules } } : null;
}

export async function planFor(tx: Tx, c: { action: ApprovalAction; companyId: string; category: string | null; currency: string; amount: string | null }) {
  const a = await activePolicy(tx);
  return { policyId: a?.id ?? null, plan: planApproval(a?.policy ?? null, c) };
}

/** Onay gerektiren iş için planı sabitler ve ilk adımın görevini açar. */
export async function openRequest(tx: Tx, ctx: TenantContext, r: { companyId: string; entityType: EntityType; entityId: string; action: ApprovalAction; policyId: string | null; plan: ApprovalPlan;
  title: string; projectId: string }) {
  const req = (await tx.query<{ id: string }>(`INSERT INTO approval_requests (tenant_id, company_id, entity_type, entity_id, action, policy_id, plan, requested_by)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`, [ctx.tenantId, r.companyId, r.entityType, r.entityId, r.action, r.policyId, r.plan, ctx.userId])).rows[0]!;
  await stepTask(tx, ctx, req.id, r.companyId, r.plan, 1, r.title, r.projectId);
  return req.id;
}

async function stepTask(tx: Tx, ctx: TenantContext, requestId: string, companyId: string, plan: ApprovalPlan, stepNo: number, title: string, projectId: string) {
  const step = plan.steps[stepNo - 1];
  if (!step) return;
  await openTask(tx, ctx, { companyId, kind: 'approval_step', entityType: 'project', entityId: projectId,
    title: `${title} — ${plan.steps.length > 1 ? `adım ${stepNo}/${plan.steps.length}: ` : ''}${step.label}`, reason: plan.explanation,
    nextAction: 'İnceleyip onaylayın veya gerekçeyle geri gönderin. Talep eden ve önceki adımı onaylayan karar veremez.', assigneeRole: step.role,
    dedupeKey: `approval:${requestId}:${stepNo}` });
}

/** Plan öncesi açılmış iş için (motor devreye girmeden): varsayılan plan, talep eden = işi başlatan. */
async function ensureRequest(tx: Tx, ctx: TenantContext, e: { entityType: EntityType; entityId: string; action: ApprovalAction; companyId: string; requestedBy: string }) {
  const existing = (await tx.query<{ id: string }>(`SELECT id FROM approval_requests WHERE entity_type = $1 AND entity_id = $2`, [e.entityType, e.entityId])).rows[0];
  if (existing) return existing.id;
  const plan = planApproval(null, { action: e.action, companyId: e.companyId, category: null, currency: 'TRY', amount: null });
  plan.explanation = 'Onay motorundan önce başlatılan iş: önceki kural (tek onay, satınalma yöneticisi) ile tamamlanır.';
  return (await tx.query<{ id: string }>(`INSERT INTO approval_requests (tenant_id, company_id, entity_type, entity_id, action, policy_id, plan, requested_by)
    VALUES ($1,$2,$3,$4,$5,NULL,$6,$7) RETURNING id`, [ctx.tenantId, e.companyId, e.entityType, e.entityId, e.action, plan, e.requestedBy])).rows[0]!.id;
}

async function load(tx: Tx, requestId: string, lock: boolean) {
  const r = (await tx.query<{ id: string; company_id: string; plan: ApprovalPlan; requested_by: string; status: string }>(
    `SELECT id, company_id, plan, requested_by, status FROM approval_requests WHERE id = $1 ${lock ? 'FOR UPDATE' : ''}`, [requestId])).rows[0];
  if (!r) throw notFound();
  const decisions = (await tx.query<{ stepNo: number; role: string; decision: 'APPROVE' | 'REJECT'; note: string | null; decidedBy: string; decidedByName: string; decidedAt: Date }>(
    `SELECT d.step_no AS "stepNo", d.role, d.decision, d.note, d.decided_by AS "decidedBy", u.display_name AS "decidedByName", d.decided_at AS "decidedAt"
     FROM approval_decisions d JOIN users u ON u.id = d.decided_by WHERE d.request_id = $1 ORDER BY d.step_no`, [requestId])).rows;
  return { r, decisions, progress: approvalProgress(r.plan.steps, decisions, r.requested_by) };
}

/** Ekran için: plan, kararlar, sıradaki adım ve bu kullanıcının karar verip veremeyeceği (gerekçesiyle). */
export async function stateFor(tx: Tx, ctx: TenantContext, entityType: EntityType, entityId: string) {
  const id = (await tx.query<{ id: string }>(`SELECT id FROM approval_requests WHERE entity_type = $1 AND entity_id = $2`, [entityType, entityId])).rows[0]?.id;
  if (!id) return null;
  const { r, decisions, progress } = await load(tx, id, false);
  const c = progress.canDecide(ctx.userId, ctx.roles);
  return { status: r.status, plan: { policyVersion: r.plan.policyVersion, ruleId: r.plan.ruleId, steps: r.plan.steps, explanation: r.plan.explanation },
    decisions: decisions.map(({ decidedBy: _, ...d }) => d), nextStepNo: progress.nextStepNo, nextStep: progress.nextStep,
    canDecide: r.status === 'OPEN' && c.ok, cannotDecideReason: r.status === 'OPEN' && !c.ok ? c.reason : null };
}

/**
 * Sıradaki adımı karara bağlar. Dönüş: 'APPROVED' (son adım onaylandı), 'REJECTED' veya 'PENDING' (sonraki adım bekliyor).
 * İşi kapatan (yayın, seçim, istisna uygulaması) çağırandır; bu fonksiyon yalnız onay kaydını ilerletir.
 */
export async function decideStep(tx: Tx, ctx: TenantContext, e: { entityType: EntityType; entityId: string; action: ApprovalAction; companyId: string; requestedBy: string; title: string; projectId: string },
  approve: boolean, note?: string | null): Promise<'APPROVED' | 'REJECTED' | 'PENDING'> {
  const id = await ensureRequest(tx, ctx, e);
  const { r, progress } = await load(tx, id, true);
  if (r.status !== 'OPEN') throw conflict('already_decided', 'Bu iş için karar verildi.');
  const c = progress.canDecide(ctx.userId, ctx.roles);
  if (!c.ok) throw new ApiError(403, ctx.userId === r.requested_by ? 'segregation_of_duties' : 'approval_step', c.reason!);
  if (!approve && (note ?? '').trim().length < 5) throw unprocessable('note_required', 'Geri gönderme nedeni gerekli.');
  const stepNo = progress.nextStepNo!;
  await tx.query(`INSERT INTO approval_decisions (tenant_id, company_id, request_id, step_no, role, decision, note, decided_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [ctx.tenantId, r.company_id, id, stepNo, progress.nextStep!.role, approve ? 'APPROVE' : 'REJECT', note?.trim() || null, ctx.userId]);
  await closeTasks(tx, `approval:${id}:${stepNo}`);
  const finished = !approve ? 'REJECTED' : stepNo >= r.plan.steps.length ? 'APPROVED' : 'PENDING';
  if (finished === 'PENDING') await stepTask(tx, ctx, id, r.company_id, r.plan, stepNo + 1, e.title, e.projectId);
  else await tx.query(`UPDATE approval_requests SET status = $2, closed_at = now() WHERE id = $1`, [id, finished]);
  await audit(tx, ctx, `approval.step_${approve ? 'approved' : 'rejected'}`, e.entityType, e.entityId, { stepNo, of: r.plan.steps.length, role: progress.nextStep!.role, policyVersion: r.plan.policyVersion }, note ?? undefined);
  return finished;
}

/** İş geri çekildi/iptal edildi: açık onay kapanır, görevleri düşer. */
export async function cancelRequest(tx: Tx, entityType: EntityType, entityId: string) {
  const r = (await tx.query<{ id: string }>(`UPDATE approval_requests SET status = 'CANCELLED', closed_at = now() WHERE entity_type = $1 AND entity_id = $2 AND status = 'OPEN' RETURNING id`, [entityType, entityId])).rows[0];
  if (r) await closeTasks(tx, `approval:${r.id}:`);
}

// --- Politika yönetimi -----------------------------------------------------------------------

export async function listPolicies(tx: Tx, ctx: TenantContext) {
  return (await tx.query(`SELECT p.id, p.version_no AS "versionNo", p.status, p.note, p.rules, cu.display_name AS "createdBy", p.created_by = $1 AS "createdByMe", p.created_at AS "createdAt",
      au.display_name AS "activatedBy", p.activated_at AS "activatedAt"
    FROM approval_policies p JOIN users cu ON cu.id = p.created_by LEFT JOIN users au ON au.id = p.activated_by ORDER BY p.version_no DESC`, [ctx.userId])).rows;
}

export async function createDraft(tx: Tx, ctx: TenantContext, b: { rules: ApprovalRule[]; note: string }) {
  if (b.note.trim().length < 10) throw unprocessable('reason_required', 'Değişiklik notu gerekli (en az 10 karakter).');
  const err = validatePolicy(b.rules);
  if (err) throw unprocessable('invalid_policy', err);
  await tx.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`approval-policy:${ctx.tenantId}`]);
  const v = (await tx.query<{ n: number }>(`SELECT coalesce(max(version_no), 0) + 1 AS n FROM approval_policies`)).rows[0]!.n;
  const r = (await tx.query<{ id: string }>(`INSERT INTO approval_policies (tenant_id, version_no, rules, note, created_by) VALUES ($1,$2,$3,$4,$5) RETURNING id`,
    [ctx.tenantId, v, JSON.stringify(b.rules), b.note.trim(), ctx.userId])).rows[0]!;
  await audit(tx, ctx, 'approval_policy.drafted', 'tenant', ctx.tenantId, { policyId: r.id, versionNo: v, rules: b.rules.length }, b.note.trim());
  return { id: r.id, versionNo: v };
}

/** Yayın ikinci kişi ister; önceki sürüm emekliye ayrılır. Devam eden işler eski planlarıyla tamamlanır. */
export async function activate(tx: Tx, ctx: TenantContext, id: string) {
  await tx.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`approval-policy:${ctx.tenantId}`]);
  const p = (await tx.query<{ status: string; created_by: string; version_no: number }>(`SELECT status, created_by, version_no FROM approval_policies WHERE id = $1 FOR UPDATE`, [id])).rows[0];
  if (!p) throw notFound();
  if (p.status !== 'DRAFT') throw conflict('not_draft', 'Yalnız taslak sürüm yayınlanır.');
  if (p.created_by === ctx.userId) throw new ApiError(403, 'segregation_of_duties', 'Politikayı hazırlayan kişi yayınlayamaz (görev ayrılığı).');
  // Eski taslak, daha yeni yürürlükteki sürümü sessizce geri alamaz.
  const cur = (await tx.query<{ v: number }>(`SELECT version_no AS v FROM approval_policies WHERE status = 'ACTIVE'`)).rows[0]?.v ?? 0;
  if (p.version_no < cur) throw conflict('stale_draft', `Taslak ${p.version_no}, yürürlükteki sürüm ${cur}'den eski; güncel sürümden yeni taslak hazırlayın.`);
  await tx.query(`UPDATE approval_policies SET status = 'RETIRED' WHERE status = 'ACTIVE'`);
  await tx.query(`UPDATE approval_policies SET status = 'ACTIVE', activated_by = $2, activated_at = now() WHERE id = $1`, [id, ctx.userId]);
  await audit(tx, ctx, 'approval_policy.activated', 'tenant', ctx.tenantId, { policyId: id, versionNo: p.version_no });
  return { ok: true, versionNo: p.version_no };
}

/** Senaryo simülasyonu: taslak veya yürürlükteki sürümle hangi adımların çıkacağı (yayın öncesi kontrol). */
export async function simulate(tx: Tx, b: { policyId?: string | null; action: ApprovalAction; companyId: string; category: string | null; currency: string; amount: string | null }) {
  let policy: ApprovalPolicy | null = null;
  if (b.policyId) {
    const r = (await tx.query<{ version_no: number; rules: ApprovalRule[] }>(`SELECT version_no, rules FROM approval_policies WHERE id = $1`, [b.policyId])).rows[0];
    if (!r) throw notFound();
    policy = { version: r.version_no, rules: r.rules };
  } else policy = (await activePolicy(tx))?.policy ?? null;
  return planApproval(policy, b);
}

