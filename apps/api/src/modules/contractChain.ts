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
  // Yalnız hâlâ açıksa kapatılır (eşzamanlı karar zinciri kapatmış olabilir; kapalı zincirin sonucu üzerine yazılmaz).
  const u = await tx.query(`UPDATE contract_approval_chains SET closed_at = now(), outcome = 'CANCELLED', cancel_reason = $2 WHERE id = $1 AND closed_at IS NULL`, [c.id, reason]);
  if (!u.rowCount) return null;
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

/** Gönderim, alan/koşul değişikliği, yeni sürüm ve kararlar aynı aile kilidinde sıralanır (Görev 5 inceleme I1). */
export async function lockFamily(tx: Tx, familyId: string): Promise<void> {
  await tx.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`contract-family:${familyId}`]);
}

/**
 * Sistem kapsamı (Görev 5 inceleme I2): onay zinciri kendiliğinden iptal edilirken (onaycı askıya alındı, uygun vekil yok) işlemi
 * başlatan kişi (dizin eşitlemesi, Yönetici rol ekranı, başka departmandan onaycı) aileyi, zinciri ve görevleri göremeyebilir.
 * Bu kısa bölüm için aynı işlemde şirket kapsamı kiracının tüm şirketlerine, departman kapsamı ALL'a açılır ve sonra geri alınır
 * (dizin eşitlemesinin bağlamıyla aynı kapsam; departments.ts'deki mevcut desen). Kiracı sınırı (app.tenant_id) değişmez.
 * Yalnız sunucu içi kurallar (iptal, devir) için kullanılır; kullanıcı girdisiyle seçilen kayıt okumak ya da yazmak için kullanılmaz.
 */
export async function withTenantWideScope<T>(tx: Tx, fn: () => Promise<T>): Promise<T> {
  const prev = (await tx.query<{ c: string | null; d: string | null }>(
    `SELECT current_setting('app.company_ids', true) AS c, current_setting('app.department_scope', true) AS d`)).rows[0]!;
  await tx.query(`SELECT set_config('app.company_ids', coalesce((SELECT array_agg(id ORDER BY id) FROM legal_entities), '{}')::text, true),
    set_config('app.department_scope', 'ALL', true)`);
  try {
    return await fn();
  } finally {
    // Hata sonrası işlem zaten geri alınır; geri yükleme hatası asıl hatayı örtmesin.
    await tx.query(`SELECT set_config('app.company_ids', $1, true), set_config('app.department_scope', $2, true)`, [prev.c || '{}', prev.d || 'LIST']).catch(() => {});
  }
}

/**
 * D107 onaycı rolleri. Aynı liste (eski kodlarıyla) şuralarda da var; birini değiştiren hepsini değiştirmeli:
 * approvers.ts APPROVER_ROLES, contractIntake.ts APPROVER_ROLES, contractApprovals.ts APPROVER_ROLES, directory.ts stepDecider SQL'i,
 * migrations/050 app_is_contract_approver (eski kodlar dahil SQL dizisi).
 */
export const APPROVER_ROLE_CODES_SQL = `ARRAY['PROCUREMENT','DEPARTMENT_USER','BUYER','PROCUREMENT_MANAGER','MASTER_DATA','LEGAL','FINANCE','REQUESTER','TECH_EVALUATOR','SECURITY']`;

/**
 * Bir onay adımında karar verebilecek uygun kişi (Görev 5 inceleme I2): adımın unvanının (tür + departman) şu anki vekili; etkin iç
 * üyelik, D107 rolü, tedarikçi değil; sözleşmeyi ekleyen, zinciri gönderen ve `excludeUserId` (askıya alınan) dışında. Ek onaycının
 * vekili yoktur (null). `contractApprovals.activeDeputyId` (currentApprovers) ile aynı anlam; SQL olarak tek sorguda.
 */
export async function eligibleStepDeputy(tx: Tx, stepId: string, excludeUserId: string | null): Promise<string | null> {
  return (await tx.query<{ deputy_user_id: string }>(
    `SELECT a.deputy_user_id FROM contract_approval_steps s
       JOIN contract_approval_chains c ON c.id = s.chain_id JOIN contract_families f ON f.id = c.family_id
       JOIN approver_assignments a ON a.tenant_id = s.tenant_id AND a.kind = s.kind AND a.department_id IS NOT DISTINCT FROM s.department_id
       JOIN memberships m ON m.tenant_id = a.tenant_id AND m.user_id = a.deputy_user_id AND m.status = 'ACTIVE' AND m.supplier_id IS NULL
      WHERE s.id = $1 AND s.kind <> 'EXTRA' AND a.deputy_user_id IS NOT NULL
        AND NOT ('SUPPLIER' = ANY (m.roles)) AND m.roles && ${APPROVER_ROLE_CODES_SQL}
        AND a.deputy_user_id <> f.created_by AND a.deputy_user_id <> c.submitted_by AND a.deputy_user_id IS DISTINCT FROM $2::uuid`,
    [stepId, excludeUserId])).rows[0]?.deputy_user_id ?? null;
}

export const APPROVER_SUSPENDED_REASON = 'Onaycı askıya alındı; uygun vekil yok. Yeniden onaya gönderin.';
