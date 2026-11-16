import type pg from 'pg';
import { loadConfig } from './config.ts';
import { createPool, withoutTenant, withTenant, type TenantContext } from './db.ts';
import { S3ObjectStore, type ObjectStore } from './storage.ts';
import { processSignatureJob } from './modules/contracts.ts';
import { processNoticeReminder, processObligationDue } from './modules/contractTerms.ts';
import { processErpExport } from './modules/invoices.ts';
import { processAiRun } from './modules/ai.ts';
import { processPurge, processTenantExport } from './modules/governance.ts';
import { hasAiProviders } from './ai/provider.ts';
import { normalizeRoles } from '@sp/domain';

/**
 * Durumsuz worker: kuyruktan iş çeker (SKIP LOCKED), işi isteyen kullanıcının GÜNCEL üyeliğiyle kiracı bağlamı kurar.
 * Kiracı kimliği tek başına yetki sayılmaz; üyelik iptal edildiyse iş BLOCKED olur.
 */
export async function processJobs(pool: pg.Pool, store: ObjectStore, detectorProvider: string | null, limit = 10, erpAdapterName: string | null = process.env.ERP_ADAPTER || null,
  lane: 'all' | 'short' | 'export' = 'all'): Promise<number> {
  // Kiracı dışa aktarımı saatler sürebilir: ayrı şeritte tek tek çalışır, ihbar/imza/silme işlerini bekletmez.
  const short = ['signature.detect', 'contract.notice_reminder', 'contract.obligation_due', 'retention.purge', ...(erpAdapterName ? ['erp.export'] : []), ...(hasAiProviders() ? ['ai.run'] : [])];
  const kinds = lane === 'export' ? ['tenant.export'] : lane === 'short' ? short : [...short, 'tenant.export'];
  const claimed = await withoutTenant(pool, async (c) =>
    (await c.query<{ id: string; tenant_id: string; company_id: string | null; kind: string; requested_by: string | null }>(
      'SELECT * FROM claim_jobs($1, $2)', [kinds, lane === 'export' ? 1 : limit])).rows);
  for (const job of claimed) {
    const m = await withoutTenant(pool, async (c) => (await c.query<{ tenant_id: string; roles: string[]; company_ids: string[] }>(
      'SELECT * FROM auth_memberships($1)', [job.requested_by])).rows.find((r) => r.tenant_id === job.tenant_id));
    const ctx: TenantContext = {
      tenantId: job.tenant_id, userId: job.requested_by ?? '00000000-0000-0000-0000-000000000000',
      roles: normalizeRoles(m?.roles ?? []), companyIds: m?.company_ids ?? [], correlationId: `job-${job.id}`,
      // Sistem işi: departman kapsamı uygulanmaz (yetki üyelik ve şirket kapsamıyla sınırlı kalır).
      departmentIds: [], allDepartments: true,
    };
    try {
      // İmha onaylandıktan sonraki bayt silme kullanıcı yetkisi gerektirmez (karar verildi); onaylayan ayrılsa da silme yapılır.
      if (job.kind === 'retention.purge') { await withTenant(pool, { ...ctx, roles: [], companyIds: [] }, (tx) => processPurge(tx, store, job.id)); continue; }
      if (!m || (job.company_id && !m.company_ids.includes(job.company_id))) {
        await withTenant(pool, { ...ctx, companyIds: job.company_id ? [job.company_id] : [] }, (tx) =>
          tx.query(`UPDATE jobs SET status = 'BLOCKED', error_code = 'REQUESTER_NOT_AUTHORIZED', updated_at = now() WHERE id = $1`, [job.id]));
        continue;
      }
      if (job.kind === 'contract.notice_reminder') await withTenant(pool, ctx, (tx) => processNoticeReminder(tx, ctx, job.id));
      else if (job.kind === 'erp.export') await withTenant(pool, ctx, (tx) => processErpExport(tx, ctx, job.id, erpAdapterName));
      else if (job.kind === 'ai.run') await processAiRun(pool, ctx, store, job.id);
      else if (job.kind === 'tenant.export') await processTenantExport(pool, ctx, store, job.id);
      else if (job.kind === 'contract.obligation_due') await withTenant(pool, ctx, (tx) => processObligationDue(tx, ctx, job.id));
      else await withTenant(pool, ctx, (tx) => processSignatureJob(tx, ctx, store, job.id, detectorProvider));
    } catch (err) {
      await withTenant(pool, ctx, (tx) => tx.query(
        `UPDATE jobs SET status = CASE WHEN attempts >= max_attempts THEN 'DEAD' ELSE 'QUEUED' END,
           run_after = now() + (attempts * interval '30 seconds'), error_code = 'PROCESSING_ERROR', updated_at = now() WHERE id = $1`, [job.id]));
      console.error('job failed', job.id, (err as Error).message);
    }
  }
  return claimed.length;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const config = loadConfig();
  const pool = createPool(config.databaseUrl, 4);
  const store = new S3ObjectStore(config.objectStore);
  let stopping = false;
  process.on('SIGTERM', () => { stopping = true; });
  const loop = async (lane: 'short' | 'export') => {
    while (!stopping) {
      const n = await processJobs(pool, store, config.signatureDetectorProvider, 10, config.erpAdapter ?? null, lane);
      if (n === 0) await new Promise((r) => setTimeout(r, 2000));
    }
  };
  await Promise.all([loop('short'), loop('export')]);
  await pool.end();
}
