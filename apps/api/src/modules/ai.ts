import { AI_TASKS, checkAiOutput, routeTask, type AiModel, type AiPolicy, type AiTask, type AiWorkload } from '@sp/domain';
import type pg from 'pg';
import { withTenant, type TenantContext, type Tx } from '../db.ts';
import { audit } from '../audit.ts';
import { openTask } from '../tasks.ts';
import { notFound, unprocessable } from '../errors.ts';
import type { ObjectStore } from '../storage.ts';
import { aiProvider, type AiResult } from '../ai/provider.ts';
import { pageTexts } from '../ai/text.ts';

/**
 * AI yönetişimi (07, T22–T24): her istek önce yönlendirme kapısından geçer ve deftere yazılır (çalışmasa da).
 * Kapı kapalıysa (sağlayıcı yok, izin yok, kota dolu) manuel akış sürer, belge korunur. Çıktı veri kabul edilir: kaynağı sunucuda
 * doğrulanmayan alan NULL kalır; model eylem çalıştıramaz. AI çıktısı yalnız "incelenmemiş öneri" olarak saklanır.
 */

/** Görev başına modelin döndürebileceği alanlar; başka anahtarlar yok sayılır. */
const ALLOWED_FIELDS: Partial<Record<AiTask, readonly string[]>> = {
  AI02: ['invoice_number', 'issue_date', 'currency', 'payable_amount', 'seller_tax_id', 'seller_name', 'buyer_tax_id'],
};

async function models(tx: Tx): Promise<AiModel[]> {
  return (await tx.query<AiModel>(`SELECT id, provider, model_id AS "modelId", model_version AS "modelVersion", tasks, capabilities, approved_regions AS "approvedRegions",
      trains_on_customer_data AS "trainsOnCustomerData", enabled, price FROM ai_models ORDER BY provider, model_id`)).rows;
}
async function policy(tx: Tx): Promise<AiPolicy | null> {
  return (await tx.query<AiPolicy>(`SELECT allowed_providers AS "allowedProviders", allowed_regions AS "allowedRegions", monthly_budget::text AS "monthlyBudget",
      budget_currency AS "budgetCurrency", daily_call_limit AS "dailyCallLimit", allow_upgrade AS "allowUpgrade" FROM ai_tenant_policies`)).rows[0] ?? null;
}
async function usage(tx: Tx, currency: string) {
  const u = (await tx.query<{ month_spent: string; today_calls: number }>(`SELECT month_spent::text, today_calls FROM ai_tenant_usage($1)`, [currency])).rows[0]!;
  return { monthSpent: u.month_spent, todayCalls: u.today_calls };
}

export interface AiRequest { task: AiTask; entityType: string; entityId: string; documentVersionId?: string | null; companyId?: string | null; workload: AiWorkload }

/** AI isteği: yönlendirme kararı + defter kaydı (idempotent). RUN ise iş kuyruğa girer; değilse sebep döner ve manuel akış sürer. */
export async function requestAi(tx: Tx, ctx: TenantContext, r: AiRequest) {
  const key = `${r.task}:${r.entityType}:${r.entityId}:${r.documentVersionId ?? ''}`;
  await tx.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`ai:${ctx.tenantId}:${key}`]);
  const existing = (await tx.query<{ id: string; status: string; reason: string | null }>(`SELECT id, status, reason FROM ai_runs WHERE idempotency_key = $1`, [key])).rows[0];
  // Çalışmış/kuyruktaki iş tekrar ücret yaratmaz. Bekleyen (kota, sağlayıcı, izin) iş yeniden yönlendirilebilir: "ücretli iş bekler" (T23).
  if (existing && !WAITING.includes(existing.status)) return { runId: existing.id, status: existing.status, reason: existing.reason, duplicate: true };
  // Kota ölçümü kiracı genelinde yapılır; eşzamanlı istekler bütçeyi birlikte aşmasın diye seri.
  await tx.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`ai-budget:${ctx.tenantId}`]);
  const pol = await policy(tx);
  const decision = routeTask(r.task, await models(tx), pol, await usage(tx, pol?.budgetCurrency ?? 'USD'), r.workload);
  let status: string; let reason: string | null; let modelRef: string | null = null; let estimated: string | null = decision.estimatedCost === 'UNKNOWN' ? null : decision.estimatedCost;
  if (decision.decision === 'RUN') {
    if (!aiProvider(decision.model.provider)) { status = 'NO_PROVIDER'; reason = `${decision.model.provider} için bağdaştırıcı kurulu değil.`; estimated = null; }
    else { status = 'QUEUED'; reason = decision.warnings.join(' ') || null; modelRef = decision.model.id; }
  } else { status = decision.decision === 'WAIT_QUOTA' ? 'WAITING_QUOTA' : decision.decision; reason = decision.reasons.join(' '); }
  const currency = decision.decision === 'RUN' ? decision.model.price.currency : null;
  const run = existing
    ? (await tx.query<{ id: string }>(`UPDATE ai_runs SET status = $2, reason = $3, model_ref = $4, estimated_cost = $5, cost_currency = $6 WHERE id = $1 RETURNING id`,
      [existing.id, status, reason, modelRef, estimated, currency])).rows[0]!
    : (await tx.query<{ id: string }>(`INSERT INTO ai_runs (tenant_id, company_id, task, entity_type, entity_id, document_version_id, model_ref, status, reason, estimated_cost, cost_currency, idempotency_key, requested_by)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING id`, [ctx.tenantId, r.companyId ?? null, r.task, r.entityType, r.entityId, r.documentVersionId ?? null, modelRef, status, reason,
      estimated, currency, key, ctx.userId])).rows[0]!;
  if (status === 'QUEUED') {
    await tx.query(`INSERT INTO jobs (tenant_id, company_id, kind, idempotency_key, payload, requested_by) VALUES ($1,$2,'ai.run',$3,$4,$5) ON CONFLICT DO NOTHING`,
      [ctx.tenantId, r.companyId ?? null, `ai-run-${run.id}`, { runId: run.id }, ctx.userId]);
    if (decision.decision === 'RUN' && decision.warnings.length) {
      await openTask(tx, ctx, { companyId: null, kind: 'ai_budget', entityType: 'tenant', entityId: ctx.tenantId, title: 'AI bütçesi %80 eşiğini aştı', reason: decision.warnings.join(' '),
        nextAction: '%100\'de yeni ücretli AI işleri bekler; bütçeyi gözden geçirin.', assigneeRole: 'TENANT_ADMIN', dedupeKey: `ai-budget-80:${new Date().toISOString().slice(0, 7)}` });
    }
  }
  await audit(tx, ctx, 'ai.routed', r.entityType, r.entityId, { runId: run.id, task: r.task, status, model: modelRef, estimated });
  return { runId: run.id, status, reason, duplicate: !!existing };
}

const WAITING = ['WAITING_QUOTA', 'NO_PROVIDER', 'NOT_ALLOWED'];

/** Bekleyen işi yeniden yönlendirir (bütçe yenilendi, politika değişti veya sağlayıcı kuruldu). */
export async function retryRun(tx: Tx, ctx: TenantContext, runId: string) {
  const r = (await tx.query<{ task: AiTask; entity_type: string; entity_id: string; document_version_id: string | null; company_id: string | null; status: string; page_count: number | null }>(
    `SELECT r.task, r.entity_type, r.entity_id, r.document_version_id, r.company_id, r.status, dv.page_count FROM ai_runs r LEFT JOIN document_versions dv ON dv.id = r.document_version_id WHERE r.id = $1`, [runId])).rows[0];
  if (!r) throw notFound();
  if (!WAITING.includes(r.status)) throw unprocessable('not_waiting', 'Yalnız bekleyen (kota, sağlayıcı veya izin) iş yeniden denenir.');
  const pages = r.page_count ?? 1;
  return requestAi(tx, ctx, { task: r.task, entityType: r.entity_type, entityId: r.entity_id, documentVersionId: r.document_version_id, companyId: r.company_id,
    workload: { pages, inputTokens: 1500 * pages, outputTokens: 500 } });
}

/**
 * Kuyruktaki AI işi. Ücretli sağlayıcı çağrısı veritabanı işlemi dışında ve en fazla bir kez yapılır: önce iş RUNNING işaretlenir
 * (kısa işlem), sonra çağrı, sonra sonuç ve gerçekleşen ücret ayrı işlemde yazılır. Hata olursa iş FAILED olur; otomatik tekrar
 * yeni ücret yaratmaz. Fatura/tedarikçi kaydı açılmaz; çıktı yalnız incelenmemiş öneridir.
 */
export async function processAiRun(pool: pg.Pool, ctx: TenantContext, store: ObjectStore, jobId: string) {
  const finishJob = (tx: Tx, status: string, result: unknown) => tx.query(`UPDATE jobs SET status = $2, result = $3, updated_at = now() WHERE id = $1`, [jobId, status, result]);
  const prep = await withTenant(pool, ctx, async (tx) => {
    const j = (await tx.query<{ payload: { runId: string } }>(`SELECT payload FROM jobs WHERE id = $1`, [jobId])).rows[0]!;
    const run = (await tx.query<{ id: string; task: AiTask; status: string; document_version_id: string | null; company_id: string | null; provider: string; model_id: string }>(
      `SELECT r.id, r.task, r.status, r.document_version_id, r.company_id, m.provider, m.model_id FROM ai_runs r JOIN ai_models m ON m.id = r.model_ref WHERE r.id = $1 FOR UPDATE OF r`, [j.payload.runId])).rows[0];
    if (!run || run.status !== 'QUEUED') { await finishJob(tx, 'SUCCEEDED', { skipped: true }); return null; }
    const dv = run.document_version_id ? (await tx.query<{ storage_key: string; mime_type: string }>(`SELECT storage_key, mime_type FROM document_versions dv WHERE id = $1 AND basic_check_status = 'PASSED'
      AND NOT EXISTS (SELECT 1 FROM document_disposals x WHERE x.document_id = dv.document_id)`, [run.document_version_id])).rows[0] : null;
    const fail = async (reason: string, code: string) => {
      await tx.query(`UPDATE ai_runs SET status = $2, reason = $3, finished_at = now() WHERE id = $1`, [run.id, code === 'NO_PROVIDER' ? 'NO_PROVIDER' : 'FAILED', reason]);
      await finishJob(tx, code === 'NO_PROVIDER' ? 'BLOCKED' : 'FAILED', { reason: code }); return null;
    };
    if (!aiProvider(run.provider)) return fail('Bağdaştırıcı çalışma anında yok.', 'NO_PROVIDER');
    if (!dv) return fail('Belge yok, güvenlik kontrolünden geçmedi veya imha edildi.', 'NO_DOCUMENT');
    await tx.query(`UPDATE ai_runs SET status = 'RUNNING' WHERE id = $1`, [run.id]);
    await tx.query(`UPDATE jobs SET status = 'RUNNING', updated_at = now() WHERE id = $1`, [jobId]);
    return { run, dv };
  });
  if (!prep) return;
  const { run, dv } = prep;
  const allowed = ALLOWED_FIELDS[run.task] ?? [];
  let res: AiResult; let pages: string[];
  try {
    pages = await pageTexts(await store.get(dv.storage_key), dv.mime_type);
    res = await aiProvider(run.provider)!.run(run.model_id, { task: run.task, pages, mimeType: dv.mime_type, allowedFields: allowed });
  } catch (e) {
    await withTenant(pool, ctx, async (tx) => {
      await tx.query(`UPDATE ai_runs SET status = 'FAILED', reason = $2, finished_at = now() WHERE id = $1`, [run.id, `Sağlayıcı/okuma hatası: ${(e as Error).name}`]);
      await finishJob(tx, 'FAILED', { reason: 'PROVIDER_ERROR' });
    });
    return;
  }
  try {
    await withTenant(pool, ctx, async (tx) => {
      const checked = checkAiOutput(res.output, allowed, pages);
      for (const f of checked.fields) {
        await tx.query(`INSERT INTO extracted_fields (tenant_id, company_id, document_version_id, field, value, origin, source_ref, confidence, ai_run_id)
          VALUES ($1,$2,$3,$4,$5,'AI',$6,$7,$8)`, [ctx.tenantId, run.company_id, run.document_version_id, f.name, f.value,
            { kind: 'ai', page: f.page, evidence: f.evidence, flags: f.flags }, f.value === null ? 'MISSING' : 'LOW', run.id]);
      }
      const flags = [...checked.flags, ...checked.fields.flatMap((f) => f.flags.filter((x) => x !== 'MISSING').map((x) => `${f.name}:${x}`))];
      await tx.query(`UPDATE ai_runs SET status = 'SUCCEEDED', actual_cost = $2, flags = $3, finished_at = now() WHERE id = $1`, [run.id, res.actualCost, JSON.stringify(flags)]);
      if (checked.flags.length) await audit(tx, ctx, 'ai.output.ignored', 'ai_run', run.id, { ignored: checked.flags });
      await audit(tx, ctx, 'ai.completed', 'ai_run', run.id, { fields: checked.fields.filter((f) => f.value !== null).length, flags: flags.length });
      await finishJob(tx, 'SUCCEEDED', { fields: checked.fields.length, flags: flags.length });
    });
  } catch (e) {
    // Sonuç yazılamadı: ücret yine de kayda geçer, iş tekrar ücret yaratmasın diye FAILED kalır.
    await withTenant(pool, ctx, async (tx) => {
      await tx.query(`UPDATE ai_runs SET status = 'FAILED', actual_cost = $2, reason = $3, finished_at = now() WHERE id = $1`, [run.id, res.actualCost, `Sonuç kaydedilemedi: ${(e as Error).name}`]);
      await finishJob(tx, 'FAILED', { reason: 'STORE_ERROR' });
    });
  }
}

export async function overview(tx: Tx) {
  const runs = (await tx.query(`SELECT r.id, r.task, r.status, r.reason, r.estimated_cost::text AS "estimatedCost", r.actual_cost::text AS "actualCost", r.cost_currency AS "costCurrency",
      r.flags, r.entity_type AS "entityType", r.entity_id AS "entityId", r.created_at AS "createdAt", m.provider, m.model_id AS "modelId"
    FROM ai_runs r LEFT JOIN ai_models m ON m.id = r.model_ref ORDER BY r.created_at DESC LIMIT 100`)).rows;
  return {
    tasks: Object.entries(AI_TASKS).map(([code, t]) => ({ code, ...t })),
    models: (await models(tx)).map((m) => ({ ...m, adapterInstalled: !!aiProvider(m.provider) })),
    policy: await policy(tx), usage: await usage(tx, (await policy(tx))?.budgetCurrency ?? 'USD'), runs,
    quality: { status: 'BLOCKED', reason: 'Etiketli Türkçe golden set (en az 300 belge) ve izinli sağlayıcı yok; kalite ölçümü yapılmadı.' },
  };
}

export async function setPolicy(tx: Tx, ctx: TenantContext, b: AiPolicy) {
  if (b.monthlyBudget !== null && !/^\d{1,18}(\.\d{1,2})?$/.test(b.monthlyBudget)) throw unprocessable('invalid_budget', 'Bütçe en fazla 2 ondalıklı tutar olmalı.');
  await tx.query(`INSERT INTO ai_tenant_policies (tenant_id, allowed_providers, allowed_regions, monthly_budget, budget_currency, daily_call_limit, allow_upgrade, updated_by)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT (tenant_id) DO UPDATE SET allowed_providers = EXCLUDED.allowed_providers, allowed_regions = EXCLUDED.allowed_regions,
      monthly_budget = EXCLUDED.monthly_budget, budget_currency = EXCLUDED.budget_currency, daily_call_limit = EXCLUDED.daily_call_limit, allow_upgrade = EXCLUDED.allow_upgrade,
      updated_by = EXCLUDED.updated_by, updated_at = now()`,
    [ctx.tenantId, b.allowedProviders, b.allowedRegions, b.monthlyBudget, b.budgetCurrency, b.dailyCallLimit, b.allowUpgrade, ctx.userId]);
  await audit(tx, ctx, 'ai.policy.updated', 'tenant', ctx.tenantId, { ...b });
  return { ok: true };
}

/** Politikayı kaldırır: "tanımlı değil" durumuna döner (ücretli AI kapalı). */
export async function deletePolicy(tx: Tx, ctx: TenantContext) {
  await tx.query(`DELETE FROM ai_tenant_policies`);
  await audit(tx, ctx, 'ai.policy.deleted', 'tenant', ctx.tenantId, {});
  return { ok: true };
}

export async function documentAiFields(tx: Tx, dvId: string) {
  if (!(await tx.query(`SELECT 1 FROM document_versions WHERE id = $1`, [dvId])).rowCount) throw notFound();
  return (await tx.query(`SELECT f.field, f.value, f.confidence, f.review_state AS "reviewState", f.source_ref AS source, r.task, r.status AS "runStatus"
    FROM extracted_fields f JOIN ai_runs r ON r.id = f.ai_run_id WHERE f.document_version_id = $1 ORDER BY f.created_at`, [dvId])).rows;
}
