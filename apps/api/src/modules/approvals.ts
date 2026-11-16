import { approvalProgress, planApproval, validatePolicy, type ApprovalAction, type ApprovalPlan, type ApprovalPolicy, type ApprovalRule } from '@sp/domain';
import type { TenantContext, Tx } from '../db.ts';
import { audit } from '../audit.ts';
import { ApiError, conflict, notFound, unprocessable } from '../errors.ts';
import { closeTasks, openTask, v2Role } from '../tasks.ts';

/** Plan adım rolleri v2 rolüne çevrilir (D93): sabitlenen plan ve karar karşılaştırması v2 kodlarıyla yapılır. Kişi düzeyindeki
 *  görev ayrılığı (talep eden karar veremez, bir adımı onaylayan sonrakini onaylayamaz) değişmez. */
/** Eski adım adları (v1 rol adları) v2 adıyla gösterilir (düzeltme dalgası Y3); sabitlenen planın rolü ve sırası değişmez. */
const LEGACY_STEP_LABEL: Record<string, string> = { 'Satınalma yöneticisi': 'Satınalma', 'Finans': 'Satınalma', 'Hukuk': 'Satınalma', 'Ana veri': 'Satınalma',
  'Bilgi güvenliği': 'Departman kullanıcısı', 'Talep eden': 'Departman kullanıcısı' };
const v2Explanation = (x: string) => x.replace(/satınalma yöneticisi/gi, 'talep edenden farklı bir Satınalma kullanıcısı');
const v2Plan = (plan: ApprovalPlan): ApprovalPlan => ({ ...plan, explanation: v2Explanation(plan.explanation ?? ''),
  steps: plan.steps.map((s) => ({ ...s, role: v2Role(s.role), label: LEGACY_STEP_LABEL[s.label] ?? s.label })) });

/** D95b: proje içi onaylar (yayın, kazanan, kaynak istisnası) tek Satınalma onayıdır; talep eden onaylayamaz (kişi düzeyi ayrılık). */
const SINGLE_STEP = [{ role: 'PROCUREMENT', label: 'Satınalma' }];
const v2Rules = (rules: ApprovalRule[]): ApprovalRule[] => rules.map((r) => ({ ...r, steps: r.steps.map((s) => ({ ...s, role: v2Role(s.role) })) }));

// Kurallı onay motoru (02 §13). Politika sürümlüdür; yayın ikinci kişi ister. Her onaylı iş başladığı andaki planı saklar
// (göç kararı: devam eden iş eski sürümle tamamlanır). Plan öncesi kayıtlar (motor öncesi açılmış işler) varsayılan tek adımla sürer.

export type EntityType = 'rfq_round' | 'award' | 'sourcing_exception';


async function activePolicy(tx: Tx): Promise<{ id: string; policy: ApprovalPolicy } | null> {
  const r = (await tx.query<{ id: string; version_no: number; rules: ApprovalRule[] }>(`SELECT id, version_no, rules FROM approval_policies WHERE status = 'ACTIVE'`)).rows[0];
  return r ? { id: r.id, policy: { version: r.version_no, rules: r.rules } } : null;
}

/**
 * Yeni onay isteğinin planı. Düzeltme dalgası (I2, D99): yürürlükte kalmış eski politika artık onay ADIMLARINI belirlemez; her yeni istek
 * tek Satınalma adımıdır (D95b). Politikanın davet sayısı ve teklif süresi kuralları (istisna gerektiren alt sınırlar) uygulanmaya devam
 * eder. Açık (planı sabitlenmiş) istekler kendi planıyla tamamlanır (D70).
 */
export async function planFor(tx: Tx, c: { action: ApprovalAction; companyId: string; category: string | null; currency: string; amount: string | null }) {
  const a = await activePolicy(tx);
  const p = planApproval(a?.policy ?? null, c);
  const limits = [p.minInvitees ? `en az ${p.minInvitees} davetli` : null, p.minResponseDays ? `en az ${p.minResponseDays} gün teklif süresi` : null].filter(Boolean).join(', ');
  const explanation = `Tek onay: talep edenden farklı bir Satınalma kullanıcısı.${limits ? ` Kurum politikası v${p.policyVersion}${p.ruleId ? `, kural ${p.ruleId}` : ''}: ${limits}.` : ''}`;
  return { policyId: a?.id ?? null, plan: { ...p, steps: SINGLE_STEP, explanation } };
}

/** Onay gerektiren iş için planı sabitler ve ilk adımın görevini açar. */
export async function openRequest(tx: Tx, ctx: TenantContext, r: { companyId: string; entityType: EntityType; entityId: string; action: ApprovalAction; policyId: string | null; plan: ApprovalPlan;
  title: string; projectId: string }) {
  const req = (await tx.query<{ id: string }>(`INSERT INTO approval_requests (tenant_id, company_id, entity_type, entity_id, action, policy_id, plan, requested_by)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`, [ctx.tenantId, r.companyId, r.entityType, r.entityId, r.action, r.policyId, v2Plan(r.plan), ctx.userId])).rows[0]!;
  await stepTask(tx, ctx, req.id, r.companyId, v2Plan(r.plan), 1, r.title, r.projectId);
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
  const plan = v2Plan(planApproval(null, { action: e.action, companyId: e.companyId, category: null, currency: 'TRY', amount: null }));
  plan.steps = SINGLE_STEP;
  plan.explanation = 'Onay motorundan önce başlatılan iş: tek onayla (talep edenden farklı bir Satınalma kullanıcısı) tamamlanır.';
  return (await tx.query<{ id: string }>(`INSERT INTO approval_requests (tenant_id, company_id, entity_type, entity_id, action, policy_id, plan, requested_by)
    VALUES ($1,$2,$3,$4,$5,NULL,$6,$7) RETURNING id`, [ctx.tenantId, e.companyId, e.entityType, e.entityId, e.action, plan, e.requestedBy])).rows[0]!.id;
}

async function load(tx: Tx, requestId: string, lock: boolean) {
  const r = (await tx.query<{ id: string; company_id: string; plan: ApprovalPlan; requested_by: string; status: string; entity_type: EntityType; entity_id: string }>(
    `SELECT id, company_id, plan, requested_by, status, entity_type, entity_id FROM approval_requests WHERE id = $1 ${lock ? 'FOR UPDATE' : ''}`, [requestId])).rows[0];
  if (!r) throw notFound();
  r.plan = v2Plan(r.plan);
  const decisions = (await tx.query<{ stepNo: number; role: string; decision: 'APPROVE' | 'REJECT'; note: string | null; decidedBy: string; decidedByName: string; decidedAt: Date }>(
    `SELECT d.step_no AS "stepNo", d.role, d.decision, d.note, d.decided_by AS "decidedBy", u.display_name AS "decidedByName", d.decided_at AS "decidedAt"
     FROM approval_decisions d JOIN users u ON u.id = d.decided_by WHERE d.request_id = $1 ORDER BY d.step_no`, [requestId])).rows
    .map((d) => ({ ...d, role: v2Role(d.role) })); // eski kararların rolü v2 koduyla gösterilir (Y3)
  return { r, decisions, progress: approvalProgress(r.plan.steps, decisions, r.requested_by) };
}

/**
 * Karar için geçerli roller. Eski (departmansız) iş istisnası (D93 göçü, kontrolcü kararı): departmanı NULL projeye bağlı işte
 * DEPARTMENT_USER adımını Satınalma karara bağlayabilir; aksi halde göçle DEPARTMENT_USER'a dönen adımı kimse göremez/karar
 * veremez. Yalnız rol eşleşmesi genişler; kişi düzeyindeki görev ayrılığı (talep eden, önceki adımı onaylayan) domain'de aynen.
 */
async function decidingRoles(tx: Tx, ctx: TenantContext, r: { entity_type: EntityType; entity_id: string }, next: { role: string } | null): Promise<string[]> {
  if (!next || next.role !== 'DEPARTMENT_USER' || ctx.roles.includes('DEPARTMENT_USER') || !ctx.roles.includes('PROCUREMENT')) return ctx.roles;
  const projectSql = { rfq_round: 'SELECT project_id FROM rfq_rounds WHERE id = $1', award: 'SELECT project_id FROM awards WHERE id = $1',
    sourcing_exception: 'SELECT project_id FROM sourcing_exceptions WHERE id = $1' }[r.entity_type];
  const legacy = (await tx.query<{ n: boolean }>(`SELECT p.department_id IS NULL AS n FROM projects p WHERE p.id = (${projectSql})`, [r.entity_id])).rows[0]?.n === true;
  return legacy ? [...ctx.roles, 'DEPARTMENT_USER'] : ctx.roles;
}

/** Ekran için: plan, kararlar, sıradaki adım ve bu kullanıcının karar verip veremeyeceği (gerekçesiyle). */
export async function stateFor(tx: Tx, ctx: TenantContext, entityType: EntityType, entityId: string) {
  const id = (await tx.query<{ id: string }>(`SELECT id FROM approval_requests WHERE entity_type = $1 AND entity_id = $2`, [entityType, entityId])).rows[0]?.id;
  if (!id) return null;
  const { r, decisions, progress } = await load(tx, id, false);
  const c = progress.canDecide(ctx.userId, await decidingRoles(tx, ctx, r, progress.nextStep));
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
  const c = progress.canDecide(ctx.userId, await decidingRoles(tx, ctx, r, progress.nextStep));
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
    [ctx.tenantId, v, JSON.stringify(v2Rules(b.rules)), b.note.trim(), ctx.userId])).rows[0]!;
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

