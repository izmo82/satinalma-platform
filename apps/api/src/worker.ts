import type pg from 'pg';
import { loadConfig } from './config.ts';
import { createPool, withoutTenant, withTenant, type TenantContext } from './db.ts';
import { S3ObjectStore, type ObjectStore } from './storage.ts';
import { processSignatureJob } from './modules/contracts.ts';
import { processNoticeReminder, processObligationDue } from './modules/contractTerms.ts';
import { dailyReminderBackfill, processEndReminder, processReminderBackfill, systemContext } from './modules/contractReminders.ts';
import { processErpExport } from './modules/invoices.ts';
import { processAiRun } from './modules/ai.ts';
import { processPurge, processTenantExport } from './modules/governance.ts';
import { hasAiProviders } from './ai/provider.ts';
import { registerConfiguredAiProvider } from './ai/register.ts';
import { normalizeRoles } from '@sp/domain';
import { directoryProvider, type DirectoryProvider } from './directory/provider.ts';
import { directoryJobContext, enqueueNightlySyncs, processDirectorySync } from './modules/directory.ts';
import { configureMailChannel, DISPATCH_JOB, mailSender, processEmailDispatch, type MailSender } from './mail/index.ts';
import { EXPIRE_JOB, processApplicationExpiry, processApplicationSubmitted, SUBMITTED_JOB } from './modules/supplierApplications.ts';

/** İsteğe bağlı işçi bağımlılıkları; eski çağrılar etkilenmez. */
export interface WorkerOptions {
  /** v2 Faz 2 (D105): yapılandırılmış dizin sağlayıcısı; yoksa `directory.sync` işi çekilmez. */
  directoryProvider?: DirectoryProvider | null;
  /** v2 Faz 5 (R6): yapılandırılmış e-posta göndericisi; yoksa `email.dispatch` işi çekilmez (kanal `none` iken QUEUED satır da yazılmaz). */
  mailSender?: MailSender | null;
}

/**
 * Durumsuz worker: kuyruktan iş çeker (SKIP LOCKED), işi isteyen kullanıcının GÜNCEL üyeliğiyle kiracı bağlamı kurar.
 * Kiracı kimliği tek başına yetki sayılmaz; üyelik iptal edildiyse iş BLOCKED olur.
 */
export async function processJobs(pool: pg.Pool, store: ObjectStore, detectorProvider: string | null, limit = 10, erpAdapterName: string | null = process.env.ERP_ADAPTER || null,
  lane: 'all' | 'short' | 'export' = 'all', opts: WorkerOptions = {}): Promise<number> {
  const directory = opts.directoryProvider ?? null;
  const sender = opts.mailSender ?? null;
  // Kiracı dışa aktarımı saatler sürebilir: ayrı şeritte tek tek çalışır, ihbar/imza/silme işlerini bekletmez.
  const short = ['signature.detect', 'contract.notice_reminder', 'contract.end_reminder', 'contract.reminder_backfill', 'contract.obligation_due', 'retention.purge', ...(erpAdapterName ? ['erp.export'] : []), ...(hasAiProviders() ? ['ai.run'] : []),
    ...(directory ? ['directory.sync'] : []), ...(sender ? [DISPATCH_JOB] : []), SUBMITTED_JOB, EXPIRE_JOB];
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
      // Dizin eşitlemesi sistem işidir: gece işinde isteyen yoktur; yetki API'de (Görev 4) denetlenir.
      if (job.kind === 'directory.sync' && directory) {
        await processDirectorySync(pool, directory, job.id, directoryJobContext(job.tenant_id, job.requested_by, job.id));
        continue;
      }
      // v2 Faz 3 (R7): hatırlatıcılar sistem işidir; kuran kişinin üyeliğine bağlı değildir (ayrılsa da çalışır).
      if (job.kind === 'contract.end_reminder') {
        const sctx = systemContext(job.tenant_id, job.company_id ? [job.company_id] : [], job.id);
        await withTenant(pool, sctx, (tx) => processEndReminder(tx, sctx, job.id));
        continue;
      }
      // v2 Faz 5 (R6): gönderim sistem işidir (kuyruğa yazanın üyeliğine bağlı değil); yalnız QUEUED satır gönderilir.
      if (job.kind === DISPATCH_JOB && sender) { await processEmailDispatch(pool, sender, job.tenant_id, job.id); continue; }
      // v2 Faz 5 (R2): girişsiz başvurunun işleri sistem işidir (isteyen kullanıcı yok; kiracı başvurudan gelir).
      if (job.kind === SUBMITTED_JOB) { await processApplicationSubmitted(pool, job.tenant_id, job.id); continue; }
      if (job.kind === EXPIRE_JOB) { await processApplicationExpiry(pool, job.tenant_id, job.id); continue; }
      if (job.kind === 'contract.reminder_backfill') { await processReminderBackfill(pool, job.tenant_id, job.id); continue; }
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
      // İşin şirketi kapsama eklenir: sistem işinde (isteyen yok) ya da isteyen o şirketi kaybetmişse satır yine güncellenir.
      const fctx = { ...ctx, companyIds: job.company_id && !ctx.companyIds.includes(job.company_id) ? [...ctx.companyIds, job.company_id] : ctx.companyIds };
      await withTenant(pool, fctx, (tx) => tx.query(
        `UPDATE jobs SET status = CASE WHEN attempts >= max_attempts THEN 'DEAD' ELSE 'QUEUED' END,
           run_after = now() + (attempts * interval '30 seconds'), error_code = 'PROCESSING_ERROR', updated_at = now() WHERE id = $1`, [job.id]));
      console.error('job failed', job.id, (err as Error).message);
    }
  }
  return claimed.length;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const config = loadConfig();
  // v2 Faz 4 (R1): API ile aynı sağlayıcı; `none` iken ai.run işi çekilmez (v1 davranışı).
  registerConfiguredAiProvider(config.ai);
  // v2 Faz 5 (R6): hatırlatıcı gibi işçide yazılan e-postalar da yapılandırılmış kanala göre QUEUED/NOT_CONFIGURED olur.
  configureMailChannel(config.mail);
  const mail = mailSender(config.mail);
  if (config.env === 'production' && (config.av?.kind ?? 'none') === 'none') console.warn('AV_SCANNER=none: virüs taraması yapılandırılmadı');
  const pool = createPool(config.databaseUrl, 4);
  const store = new S3ObjectStore(config.objectStore);
  let stopping = false;
  process.on('SIGTERM', () => { stopping = true; });
  const directory = directoryProvider(config.directory);
  let lastNightly = 0;
  const reminderBackfill = dailyReminderBackfill();
  const loop = async (lane: 'short' | 'export') => {
    while (!stopping) {
      // R8: gece eşitlemesi en fazla dakikada bir denetlenir (İstanbul 06:00 sonrası, kiracı başına günde bir iş).
      if (lane === 'short' && directory && Date.now() - lastNightly >= 60_000) {
        lastNightly = Date.now();
        await enqueueNightlySyncs(pool, new Date(), directory).catch((e) => console.error('directory nightly enqueue failed', (e as Error).message));
      }
      // R7 geri doldurma: başlangıçta ve sonra İstanbul gününde bir kez taranır (final inceleme, ertelenen #3); kiracı başına günde bir iş.
      if (lane === 'short') {
        await reminderBackfill(pool, new Date()).catch((e) => console.error('reminder backfill enqueue failed', (e as Error).message));
      }
      const n = await processJobs(pool, store, config.signatureDetectorProvider, 10, config.erpAdapter ?? null, lane, { directoryProvider: directory, mailSender: mail });
      if (n === 0) await new Promise((r) => setTimeout(r, 2000));
    }
  };
  await Promise.all([loop('short'), loop('export')]);
  await pool.end();
}
