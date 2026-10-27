import type { TenantContext, Tx } from './db.ts';

/** Değişmez denetim kaydı. Belge metni, kimlik görseli veya imza kesiti yazılmaz. */
export async function audit(
  tx: Tx,
  ctx: TenantContext,
  action: string,
  entityType: string,
  entityId: string | null,
  data: Record<string, unknown> = {},
  reason?: string,
): Promise<void> {
  await tx.query(
    `INSERT INTO audit_events (tenant_id, actor_user_id, action, entity_type, entity_id, data, reason, correlation_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [ctx.tenantId, ctx.userId, action, entityType, entityId, data, reason ?? null, ctx.correlationId],
  );
}
