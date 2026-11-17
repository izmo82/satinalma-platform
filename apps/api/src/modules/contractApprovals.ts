import { canDecide, STEP_KIND_TR, type StepKind } from '@sp/domain';
import type { TenantContext, Tx } from '../db.ts';
import { audit } from '../audit.ts';
import { closeTasks, openTask } from '../tasks.ts';
import { ApiError, conflict, notFound, unprocessable } from '../errors.ts';
import { currentApprovers } from './approvers.ts';
import { getContractV2, listInfo, openStepTask } from './contractIntake.ts';
import { APPROVER_SUSPENDED_REASON, cancelOpenChain, eligibleStepAssignee, eligibleStepDeputy, lockFamily, roleOf, withTenantWideScope } from './contractChain.ts';
import { scheduleContractReminders } from './contractReminders.ts';
import { enqueueErpOutboundSafe } from './erpWrite.ts';

/**
 * v2 Faz 3 (D108+, R4–R6) Görev 5: onay kararı. Karar yalnız açık zincirin sıradaki (en küçük sıralı, kararsız) adımına verilir.
 * Karar yetkisi (R4): adıma sabitlenen kişi ya da o unvanın (tür + departman) şu anki etkin vekili (Faz 2 onaycı ataması; etkin ve
 * D107 rollü). Görev ayrılığı (Ruling 9): sözleşmeyi ekleyen (`created_by`) ve zinciri gönderen karar veremez (403).
 *
 * Onay → sıradaki adım görevi açılır; son adım → zincir APPROVED + hatırlatıcılar (Görev 6, aynı işlemde, zincir kapandıktan sonra).
 * Red (gerekçe ≥ 10) → zincir REJECTED, gönderene `contract_rejected` görevi (gerekçe metinde). Adım kararı zincir kapanmadan önce
 * yazılır (050 kapalı zincir koruması).
 */

const ZERO = '00000000-0000-0000-0000-000000000000';

interface StepRow {
  id: string; chain_id: string; step_order: number; kind: StepKind; department_id: string | null; assigned_user_id: string; via_deputy: boolean;
  decision: 'APPROVED' | 'REJECTED' | null; decided_at: Date | null;
  family_id: string; closed_at: Date | null; submitted_by: string; created_by: string; code: string; title: string;
}

const STEP_SQL = `SELECT s.id, s.chain_id, s.step_order, s.kind, s.department_id, s.assigned_user_id, s.via_deputy, s.decision, s.decided_at,
    c.family_id, c.closed_at, c.submitted_by, f.created_by, f.code, f.title
  FROM contract_approval_steps s JOIN contract_approval_chains c ON c.id = s.chain_id JOIN contract_families f ON f.id = c.family_id`;

/** Adımın unvanındaki şu anki etkin vekil (etkin üyelik + D107 rolü; `currentApprovers`). Ek onaycının vekili yoktur. */
async function activeDeputyId(tx: Tx, step: { kind: StepKind; department_id: string | null },
  cache?: Map<string, Awaited<ReturnType<typeof currentApprovers>>>): Promise<string | null> {
  if (step.kind === 'EXTRA') return null;
  const key = step.department_id ?? ZERO;
  let a = cache?.get(key);
  if (!a) { a = await currentApprovers(tx, key); cache?.set(key, a); }
  const dep = step.kind === 'DEPARTMENT_HEAD' ? a.deputy : step.kind === 'PROCUREMENT_LEAD' ? a.leadDeputy : a.directorDeputy;
  return dep?.userId ?? null;
}

const exactClose = (tx: Tx, key: string) => tx.query(`UPDATE tasks SET status = 'DONE', closed_at = now() WHERE status = 'OPEN' AND dedupe_key = $1`, [key]);

export async function decideStep(tx: Tx, ctx: TenantContext, stepId: string, body: { decision: 'APPROVED' | 'REJECTED'; reason?: string | null }) {
  const peek = (await tx.query<{ family_id: string }>(`SELECT c.family_id FROM contract_approval_steps s JOIN contract_approval_chains c ON c.id = s.chain_id WHERE s.id = $1`,
    [stepId])).rows[0];
  if (!peek) throw notFound();
  // Gönderim, alan/koşul değişikliği, yeni sürüm ve kararlar aynı aile kilidinde sıralanır (eşzamanlı iki karar aynı adımı ya da zinciri iki kez kapatmaz).
  await lockFamily(tx, peek.family_id);
  const s = (await tx.query<StepRow>(`${STEP_SQL} WHERE s.id = $1`, [stepId])).rows[0];
  if (!s) throw notFound();

  if (ctx.userId === s.created_by || ctx.userId === s.submitted_by) {
    throw new ApiError(403, 'segregation_of_duties', 'Kendi eklediğiniz ya da onaya gönderdiğiniz sözleşmeye onay kararı veremezsiniz (görev ayrılığı).');
  }
  const deputyId = await activeDeputyId(tx, s);
  if (!canDecide({ userId: s.assigned_user_id, decidedAt: null }, ctx.userId, deputyId)) {
    throw new ApiError(403, 'not_step_approver', 'Bu onay adımı size atanmamış; yalnız adımdaki kişi ya da o unvanın etkin vekili karar verir.');
  }
  if (s.closed_at) throw conflict('chain_closed', 'Bu onay zinciri kapandı (onaylandı, reddedildi ya da içerik değiştiği için iptal edildi); karar verilemez.');
  if (s.decision) throw conflict('step_decided', 'Bu adıma zaten karar verildi.');
  const steps = (await tx.query<{ id: string; step_order: number; kind: StepKind; department_id: string | null; assigned_user_id: string; decision: string | null }>(
    `SELECT id, step_order, kind, department_id, assigned_user_id, decision FROM contract_approval_steps WHERE chain_id = $1 ORDER BY step_order`, [s.chain_id])).rows;
  const current = steps.find((x) => !x.decision)!;
  if (current.id !== s.id) {
    throw conflict('step_not_current', `Sıra bu adımda değil; önce ${current.step_order}. adım (${STEP_KIND_TR[current.kind]}) karar vermeli.`);
  }
  const reason = body.reason?.trim() || null;
  if (body.decision === 'REJECTED' && (reason ?? '').length < 10) {
    throw unprocessable('reason_required', 'Red gerekçesi gerekli (en az 10 karakter).');
  }

  // 1) Adım kararı (zincir kapanmadan önce; 050 koruması kapalı zincirde kararı reddeder).
  await tx.query(`UPDATE contract_approval_steps SET decided_by = $2, decided_at = now(), decision = $3, reason = $4 WHERE id = $1`,
    [s.id, ctx.userId, body.decision, reason]);
  await exactClose(tx, `contract-approval:${s.chain_id}:${s.step_order}`);
  const asDeputy = ctx.userId !== s.assigned_user_id;
  await audit(tx, ctx, 'contract.approval.decided', 'contract_family', s.family_id,
    { chainId: s.chain_id, stepId: s.id, order: s.step_order, kind: s.kind, decision: body.decision, assignedUserId: s.assigned_user_id, asDeputy }, reason ?? undefined);

  let chainStatus: 'OPEN' | 'APPROVED' | 'REJECTED' | 'CANCELLED' = 'OPEN';
  let next: { stepId: string; order: number; kind: StepKind; kindLabel: string; taskId: string; assigneeUserId: string } | null = null;
  const f = { id: s.family_id, code: s.code };
  // Zincir yalnız hâlâ açıksa kapatılır; değilse (kilit dışı bir yol kapatmış) 409 ve işlem geri alınır, sonuç üzerine yazılmaz.
  const closeChain = async (outcome: 'APPROVED' | 'REJECTED') => {
    const u = await tx.query(`UPDATE contract_approval_chains SET closed_at = now(), outcome = $2 WHERE id = $1 AND closed_at IS NULL`, [s.chain_id, outcome]);
    if (!u.rowCount) throw conflict('chain_closed', 'Bu onay zinciri kapandı; karar verilemez.');
  };
  if (body.decision === 'REJECTED') {
    await closeChain('REJECTED');
    chainStatus = 'REJECTED';
    // Gönderene döner. Karar veren başka departmandan olabilir (R6): görev departmansız, şirketsiz ve kişiye atanır; bağlı kayıt aile.
    await openTask(tx, ctx, {
      companyId: null, departmentId: null, kind: 'contract_rejected', entityType: 'contract_rejection', entityId: s.family_id,
      title: `Sözleşme reddedildi: ${s.code}`, reason: `${STEP_KIND_TR[s.kind]} (${s.step_order}. adım) reddetti. Gerekçe: ${reason}`,
      nextAction: 'Gerekçeye göre alanları ya da belgeyi düzeltip sözleşmeyi yeniden onaya gönderin.',
      assigneeRole: await roleOf(tx, s.submitted_by), assigneeUserId: s.submitted_by, dedupeKey: `contract-rejected:${s.family_id}`,
    });
    await audit(tx, ctx, 'contract.approval.rejected', 'contract_family', s.family_id, { chainId: s.chain_id, stepId: s.id, order: s.step_order, kind: s.kind }, reason!);
  } else {
    const n = steps.find((x) => !x.decision && x.id !== s.id);
    if (n) {
      // Sıradaki adımdaki kişi bu arada askıya alındıysa (Faz 2 R5) görev o unvanın etkin vekiline açılır (görev ayrılığı korunur).
      const assignee = (await eligibleStepAssignee(tx, n.id, null)) ?? (await eligibleStepDeputy(tx, n.id, n.assigned_user_id));
      if (assignee) {
        const t = await openStepTask(tx, ctx, f, s.chain_id, { id: n.id, order: n.step_order, kind: n.kind, userId: assignee });
        next = { stepId: n.id, order: n.step_order, kind: n.kind, kindLabel: STEP_KIND_TR[n.kind], taskId: t.id, assigneeUserId: assignee };
      } else {
        // Görev 5 inceleme I2: sıradaki adımda karar verebilecek kimse yok (kişi askıda, uygun vekil yok / ek onaycı): zincir sahipsiz
        // kalmasın, iptal edilir ve gönderene yeniden gönderim görevi açılır. Karar veren başka departmandan olabilir: kiracı geneli kapsam.
        // no data from this block may be returned to the caller
        await withTenantWideScope(tx, () => cancelOpenChain(tx, ctx, s.family_id, APPROVER_SUSPENDED_REASON));
        chainStatus = 'CANCELLED';
      }
    } else {
      await closeChain('APPROVED');
      chainStatus = 'APPROVED';
      await audit(tx, ctx, 'contract.approval.approved', 'contract_family', s.family_id, { chainId: s.chain_id, steps: steps.length });
      // R7: hatırlatıcılar zincir APPROVED kapandıktan sonra (yürürlükteki koşulu onaylı zincirden okur), aynı işlemde.
      await scheduleContractReminders(tx, ctx, s.family_id);
      // v2 Faz 8 Görev 6 (R3, R7): zincir APPROVED → ERP sözleşme başlığı; yazma kapalıyken hiçbir şey yazılmaz.
      await enqueueErpOutboundSafe(tx, ctx, 'CONTRACT_HEADER', 'CONTRACT_FAMILY', s.family_id);
    }
  }
  if (chainStatus === 'APPROVED' || chainStatus === 'REJECTED') await closeTasks(tx, `contract-approval:${s.chain_id}:`);
  return { stepId: s.id, decision: body.decision, chainId: s.chain_id, chainStatus, nextStep: next, contract: await getContractV2(tx, ctx, s.family_id) };
}

/**
 * Bekleyen onaylarım (İşlerim, iOS ve web): bana atanmış açık onay adımı görevleri (görev listesiyle aynı küme: `contract_approval_step`
 * görevi yalnız atanana listelenir, Ruling 10). Askıya alma devriyle vekile geçen görev vekilin listesindedir. `canDecide` karar
 * yetkisinin o anki durumudur (ör. vekil ataması sonradan değiştiyse false).
 */
export async function myApprovals(tx: Tx, ctx: TenantContext) {
  const rows = (await tx.query<StepRow & { task_id: string; submitted_at: Date; submitted_by_name: string | null; step_count: number; department_name: string | null }>(
    `SELECT s.id, s.chain_id, s.step_order, s.kind, s.department_id, s.assigned_user_id, s.via_deputy, s.decision, s.decided_at,
            c.family_id, c.closed_at, c.submitted_by, c.submitted_at, su.display_name AS submitted_by_name, f.created_by, f.code, f.title,
            d.name AS department_name, t.id AS task_id, (SELECT count(*)::int FROM contract_approval_steps x WHERE x.chain_id = c.id) AS step_count
       FROM tasks t JOIN contract_approval_steps s ON s.id = t.entity_id JOIN contract_approval_chains c ON c.id = s.chain_id
       JOIN contract_families f ON f.id = c.family_id LEFT JOIN users su ON su.id = c.submitted_by LEFT JOIN departments d ON d.id = f.department_id
      WHERE t.status = 'OPEN' AND t.entity_type = 'contract_approval_step' AND t.assignee_user_id = $1
        AND c.closed_at IS NULL AND s.decision IS NULL
      ORDER BY c.submitted_at, s.step_order, s.id`, [ctx.userId])).rows;
  const info = await listInfo(tx, [...new Set(rows.map((r) => r.family_id))]);
  const items = [];
  const approvers = new Map<string, Awaited<ReturnType<typeof currentApprovers>>>();
  for (const r of rows) {
    const sod = ctx.userId === r.created_by || ctx.userId === r.submitted_by;
    const decide = !sod && canDecide({ userId: r.assigned_user_id, decidedAt: null }, ctx.userId, await activeDeputyId(tx, r, approvers));
    const i = info.get(r.family_id);
    items.push({
      stepId: r.id, taskId: r.task_id, chainId: r.chain_id, order: r.step_order, stepCount: r.step_count, kind: r.kind, kindLabel: STEP_KIND_TR[r.kind],
      viaDeputy: r.via_deputy, asDeputy: r.assigned_user_id !== ctx.userId, submittedAt: r.submitted_at,
      submittedBy: { id: r.submitted_by, displayName: r.submitted_by_name ?? '' },
      contract: { familyId: r.family_id, code: r.code, title: r.title, departmentName: r.department_name, status: i?.status ?? null, statusLabel: i?.statusLabel ?? null,
        supplier: i?.supplier ?? null, project: i?.project ?? null, amount: i?.amount ?? null, currency: i?.currency ?? null, endDate: i?.endDate ?? null, indefinite: i?.indefinite ?? false },
      canDecide: decide,
    });
  }
  return { items, count: items.length };
}
