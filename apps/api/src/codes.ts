import type { TenantContext, Tx } from './db.ts';

/** Kiracı içi sıralı kayıt numarası (ör. PRJ-2026-0001). Sayaç satırı kilitlenir; eşzamanlı istekte çakışma olmaz. */
export async function nextCode(tx: Tx, ctx: TenantContext, counter: 'project' | 'document' | 'contract' | 'po', prefix: string): Promise<string> {
  const n = (await tx.query<{ value: string }>(
    `INSERT INTO tenant_counters (tenant_id, name, value) VALUES ($1, $2, 1)
     ON CONFLICT (tenant_id, name) DO UPDATE SET value = tenant_counters.value + 1 RETURNING value`, [ctx.tenantId, counter])).rows[0]!.value;
  return `${prefix}-${new Date().getFullYear()}-${String(n).padStart(4, '0')}`;
}
