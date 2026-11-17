import { normalizeRoles } from '@sp/domain';
import type { TenantContext, Tx } from '../db.ts';
import { audit } from '../audit.ts';
import { closeTasks, openTask } from '../tasks.ts';

/**
 * v2 Faz 3 (D108+, R5): onay zinciri iptali. Görev 4'te `contractIntake.ts` içinde yazıldı; Görev 5'te eski uçlar (yeni sözleşme sürümü
 * `contracts.ts`, koşul kaydı `contractTerms.ts`) da çağırdığı için içe aktarma döngüsü olmasın diye bu küçük modüle taşındı
 * (`contractIntake.ts` aynı adlarla yeniden dışa aktarır).
 */

export const CONTENT_CHANGED_REASON = 'İçerik değişti, onay baştan.';

/** Görevin atandığı rol: kişinin v2 rolünden (Satınalma öncelikli). */
export async function roleOf(tx: Tx, userId: string): Promise<string> {
  const r = (await tx.query<{ roles: string[] }>(`SELECT roles FROM memberships WHERE user_id = $1 AND supplier_id IS NULL`, [userId])).rows[0];
  const roles = normalizeRoles(r?.roles ?? []);
  return roles.includes('PROCUREMENT') ? 'PROCUREMENT' : roles.includes('DEPARTMENT_USER') ? 'DEPARTMENT_USER' : roles[0] ?? 'PROCUREMENT';
}

/**
 * Açık zinciri `CANCELLED` yapar (gerekçe, kapanış zamanı), açık adım görevlerini kapatır ve gönderene "Yeniden onaya gönderin"
 * görevi açar. Açık zincir yoksa hiçbir şey yapmaz (null). Karar yazılmış adımlar tarih olarak kalır.
 */
export async function cancelOpenChain(tx: Tx, ctx: TenantContext, familyId: string, reason: string): Promise<string | null> {
  const c = (await tx.query<{ id: string; submitted_by: string }>(
    `SELECT id, submitted_by FROM contract_approval_chains WHERE family_id = $1 AND closed_at IS NULL`, [familyId])).rows[0];
  if (!c) return null;
  await tx.query(`UPDATE contract_approval_chains SET closed_at = now(), outcome = 'CANCELLED', cancel_reason = $2 WHERE id = $1`, [c.id, reason]);
  await closeTasks(tx, `contract-approval:${c.id}:`);
  const f = (await tx.query<{ code: string; title: string; company_id: string }>(`SELECT code, title, company_id FROM contract_families WHERE id = $1`, [familyId])).rows[0]!;
  await openTask(tx, ctx, {
    companyId: f.company_id, kind: 'contract_resubmit', entityType: 'contract_family', entityId: familyId,
    title: `Yeniden onaya gönderin: ${f.title}`, reason: `${f.code}: ${reason} Önceki onay zinciri iptal edildi.`,
    nextAction: 'Alanları ve belgeyi kontrol edip sözleşmeyi yeniden onaya gönderin.', assigneeRole: await roleOf(tx, c.submitted_by),
    assigneeUserId: c.submitted_by, dedupeKey: `contract-resubmit:${familyId}`,
  });
  await audit(tx, ctx, 'contract.approval.cancelled', 'contract_family', familyId, { chainId: c.id }, reason);
  return c.id;
}

/** Onaycı aileyi görür ama yazamaz (R6): yazma ailenin departman kapsamındadır. RLS hatası (500) yerine 403 için önce bakılır. */
export const familyWritable = (ctx: TenantContext, departmentId: string | null) =>
  ctx.allDepartments || (departmentId != null && ctx.departmentIds.includes(departmentId));
