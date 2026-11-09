import type { TenantContext, Tx } from './db.ts';

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
}

/** Aynı açık görev ikinci kez oluşmaz (BR12/SIG15). Var olanın id'sini döner. */
export async function openTask(tx: Tx, ctx: TenantContext, t: TaskInput): Promise<{ id: string; created: boolean }> {
  const ins = await tx.query<{ id: string }>(
    `INSERT INTO tasks (tenant_id, company_id, kind, entity_type, entity_id, title, reason, next_action, assignee_role, severity, due_at, dedupe_key)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
     ON CONFLICT (tenant_id, dedupe_key) WHERE status = 'OPEN' DO NOTHING RETURNING id`,
    [ctx.tenantId, t.companyId, t.kind, t.entityType, t.entityId, t.title, t.reason, t.nextAction, t.assigneeRole,
      t.severity ?? 'NORMAL', t.dueAt ?? null, t.dedupeKey],
  );
  if (ins.rows[0]) return { id: ins.rows[0].id, created: true };
  const existing = await tx.query<{ id: string }>(
    `SELECT id FROM tasks WHERE tenant_id = $1 AND dedupe_key = $2 AND status = 'OPEN'`, [ctx.tenantId, t.dedupeKey]);
  return { id: existing.rows[0]!.id, created: false };
}

/** Tedarikçi aktifleşince, reddedilince veya birleşince ona bağlı fatura görevleri biter (D92). */
export async function closeSupplierInvoiceTasks(tx: Tx, supplierId: string): Promise<void> {
  await tx.query(`UPDATE tasks SET status = 'DONE', closed_at = now() WHERE status = 'OPEN' AND kind = 'invoice_issue' AND entity_type = 'supplier' AND entity_id = $1`, [supplierId]);
}

export async function closeTasks(tx: Tx, dedupePrefix: string): Promise<void> {
  await tx.query(`UPDATE tasks SET status = 'DONE', closed_at = now() WHERE status = 'OPEN' AND dedupe_key LIKE $1`,
    [`${dedupePrefix}%`]);
}
