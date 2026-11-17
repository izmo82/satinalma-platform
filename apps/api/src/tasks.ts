import { normalizeRoles, REMOVED_ISSUE_CODES } from '@sp/domain';
import type { TenantContext, Tx } from './db.ts';

/** Saklanan/gelen rol kodu (eski ya da v2) → v2 rolü; bilinmeyen kod olduğu gibi kalır. Görev ve sorumlu rolleri her zaman v2 saklanır. */
export const v2Role = (role: string): string => normalizeRoles([role])[0] ?? role;

export interface TaskInput {
  companyId: string | null;
  kind: string;
  entityType: string;
  entityId: string;
  title: string;
  reason: string;
  nextAction: string;
  assigneeRole: string;
  severity?: 'NORMAL' | 'HIGH' | 'CRITICAL';
  dueAt?: Date | null;
  dedupeKey: string;
  /** Görevin departmanı. Verilmezse bağlı kayıttan çözülür (proje, sözleşme, fatura, değerlendirme ve alt kayıtları); diğerlerinde boş. */
  departmentId?: string | null;
  /** v2 Faz 3 (D108+): kişiye atanmış görev (onay adımı, yeniden gönderim). Verilmezse rol kuyruğu (NULL). */
  assigneeUserId?: string | null;
}

/**
 * Görev görünürlüğü (rol): kullanıcının rolüne atanmış görevler. Göç (D93) eski bölüm adımlarını DEPARTMENT_USER'a çevirdi;
 * departmanı atanmamış eski kayıttaki bu görevleri hiçbir bölüm kullanıcısı açamaz. Onay motorundaki istisnanın aynısı:
 * Satınalma bu görevleri de görür (departmanlı kayıtta görmez). `roles` SQL parametre yeri (ör. `$1`).
 */
export const taskRoleSql = (roles: string, t = 't') => `(${t}.assignee_role = ANY(${roles}::text[]) OR ('PROCUREMENT' = ANY(${roles}::text[])
  AND ${t}.assignee_role = 'DEPARTMENT_USER' AND ${t}.department_id IS NULL AND app_task_departmental(${t}.entity_type)
  AND app_task_department(${t}.entity_type, ${t}.entity_id) IS NULL))`;

/**
 * v2 Faz 1 (D93): kaldırılan işlevlerin görevleri İşlerim'de, sayaçlarda ve bildirimlerde listelenmez (kayıt silinmez):
 * Lira Defteri vakaları, imha partileri, banka bilgisi doğrulaması (banka değişikliği akışı kaldırıldı; düzeltme dalgası Y1) ve fatura bulgularından yalnız kaldırılan kodlar (üçlü eşleştirme, tolerans, sözleşmesiz
 * istisna; `REMOVED_ISSUE_CODES`). Korunan bulgular (vergi, tahsis, tedarikçi/şirket uyuşmazlığı, limit, imza, avans) görünür kalır.
 * Bulgu kodu görevin tekil anahtarındadır: `invoice-issue:<faturaId>:<kod>`.
 */
const REMOVED_ISSUE_KEYS = REMOVED_ISSUE_CODES.map((c) => `'${c}'`).join(', ');
export const visibleTaskSql = (t = 't') => `(${t}.entity_type NOT IN ('recovery_case', 'disposal_batch')
  AND ${t}.kind <> 'BANK_CHANGE_VERIFICATION'
  AND NOT (${t}.kind = 'invoice_issue' AND split_part(${t}.dedupe_key, ':', 3) IN (${REMOVED_ISSUE_KEYS})))`;

/** Aynı açık görev ikinci kez oluşmaz (BR12/SIG15). Var olanın id'sini döner. */
export async function openTask(tx: Tx, ctx: TenantContext, t: TaskInput): Promise<{ id: string; created: boolean }> {
  const departmentId = t.departmentId !== undefined ? t.departmentId
    : (await tx.query<{ d: string | null }>(`SELECT app_task_department($1, $2) AS d`, [t.entityType, t.entityId])).rows[0]?.d ?? null;
  const ins = await tx.query<{ id: string }>(
    `INSERT INTO tasks (tenant_id, company_id, kind, entity_type, entity_id, title, reason, next_action, assignee_role, severity, due_at, dedupe_key, department_id, assignee_user_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
     ON CONFLICT (tenant_id, dedupe_key) WHERE status = 'OPEN' DO NOTHING RETURNING id`,
    [ctx.tenantId, t.companyId, t.kind, t.entityType, t.entityId, t.title, t.reason, t.nextAction, v2Role(t.assigneeRole),
      t.severity ?? 'NORMAL', t.dueAt ?? null, t.dedupeKey, departmentId, t.assigneeUserId ?? null],
  );
  if (ins.rows[0]) return { id: ins.rows[0].id, created: true };
  const existing = await tx.query<{ id: string }>(
    `SELECT id FROM tasks WHERE tenant_id = $1 AND dedupe_key = $2 AND status = 'OPEN'`, [ctx.tenantId, t.dedupeKey]);
  return { id: existing.rows[0]!.id, created: false };
}

/**
 * Kaydın departmanı değişince (departman ataması, faturanın tahsisle devraldığı departman) bağlı görevlerin departmanı kayıttan
 * yeniden türetilir (açık ve kapalı; departman boşalırsa görev de boşalır). Yalnız departmanı kayıttan gelen türler. `where` görev satırı (t) üzerinde koşul; parametreler $1'den başlar.
 */
export async function rederiveTaskDepartments(tx: Tx, where: string, params: unknown[]): Promise<number> {
  const r = await tx.query(`UPDATE tasks t SET department_id = app_task_department(t.entity_type, t.entity_id)
    WHERE (${where}) AND (app_task_departmental(t.entity_type) OR t.entity_type = 'incident')
      AND t.department_id IS DISTINCT FROM app_task_department(t.entity_type, t.entity_id)`, params);
  return r.rowCount ?? 0;
}

/** Tedarikçi aktifleşince, reddedilince veya birleşince ona bağlı fatura görevleri biter (D92). */
export async function closeSupplierInvoiceTasks(tx: Tx, supplierId: string): Promise<void> {
  await tx.query(`UPDATE tasks SET status = 'DONE', closed_at = now() WHERE status = 'OPEN' AND kind = 'invoice_issue' AND entity_type = 'supplier' AND entity_id = $1`, [supplierId]);
}

export async function closeTasks(tx: Tx, dedupePrefix: string): Promise<void> {
  await tx.query(`UPDATE tasks SET status = 'DONE', closed_at = now() WHERE status = 'OPEN' AND dedupe_key LIKE $1`,
    [`${dedupePrefix}%`]);
}
