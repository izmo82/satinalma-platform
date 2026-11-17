// v2 Faz 8 (D113) Görev 5: ERP'den okuyan akışlar (1. aşama) — tedarikçi kodu, masraf merkezi, sipariş, fatura, ödeme durumu.
// Kurallar:
//  * İş türü `erp.read` (payload `{ feature, runId }`); çalışma satırı (integration_runs) isteyen yerde açılır (elle: "Şimdi çalıştır",
//    zamanlanmış: `enqueueDueErpReads`) ve burada mutlaka kapanır (SUCCESS / PARTIAL / FAILED). Özellik çalışma alınmadan kapatıldıysa,
//    sağlayıcı yoksa ya da sır açılamıyorsa ERP'ye istek atılmaz, çalışma FAILED + nedeni hata kaydında kapanır (sağlayıcılı çalışma
//    şemada NOT_CONFIGURED olamaz). Zamanlanmış okumada sağlayıcı yoksa çalışma NOT_CONFIGURED yazılır, iş açılmaz.
//  * Kayıt başına SAVEPOINT: bir kaydın hatası diğerlerini düşürmez; hata `integration_run_errors`'a (kod, sırdan arındırılmış ileti
//    ≤500, yükün SHA-256 özeti; ham yük saklanmaz), toplamlar `counts`'a.
//  * R6: ERP okuması elle (MANUAL) girilmiş değeri ezmez ve silmez; fark CONFLICT_MANUAL "elle girilen değerle çelişiyor" olarak yazılır.
//    Kaynak sütunu değerle birlikte her zaman yazılır.
//  * R12: ERP tedarikçi kaydı yeni tedarikçi açmaz (VKN eşleşmezse hata kaydı). ERP faturası aynı tedarikçi + fatura no ile elle
//    girilmiş faturaya bağlanır (ikinci kayıt açılmaz); sonra Faz 7 eşleştiricisi (`autoMatchInvoice`) çağrılır.
//  * Demo faturalar (ANB2026000101, ANB2026000102, EGE2026000877) hiçbir okumada değişmez.
//  * Tutar decimal string; yuvarlanmaz (fatura tutarı 2 ondalıktan fazlaysa satır reddedilir — fatura sütunları 2 ondalık).
//  * Taklit sağlayıcının her sonucu mock=true çalışmada kalır ("taklit sağlayıcıyla denendi — gerçek Oracle değil").
import { createHash, randomUUID } from 'node:crypto';
import type pg from 'pg';
import {
  ERP_FEATURE_CATALOG, applyFieldMap, can, dec, div, isDue, missingMappings, mul, normalizeRoles, normalizeTaxId, reconcileManual, redactSecrets, str,
  type ErpFeature, type ErpInvoiceRecord, type ErpSchedule, type FieldMap,
} from '@sp/domain';
import type { Config } from '../config.ts';
import { withoutTenant, withTenant, type TenantContext, type Tx } from '../db.ts';
import { audit } from '../audit.ts';
import { ApiError } from '../errors.ts';
import { SecretBox, SecretKekMismatch, SecretKeyNotConfigured, SecretOpenFailed, loadEndpointSecret } from '../integrationSecrets.ts';
import { ErpProviderError, ErpTimeout, erpProvider, type ErpProvider, type ErpProviderKind, type ResolvedEndpoint } from '../erp/providers.ts';
import { createInvoice } from './invoices.ts';
import { autoMatchInvoice, type AutoMatchResult } from './invoiceMatching.ts';

export const ERP_READ_JOB = 'erp.read';
export const ERP_READ_FEATURES = ['SUPPLIER', 'COST_CENTER', 'PURCHASE_ORDER', 'INVOICE', 'PAYMENT_STATUS'] as const satisfies readonly ErpFeature[];
type ReadFeature = (typeof ERP_READ_FEATURES)[number];
/** Hiçbir ERP okumasında değişmeyen demo faturalar (sabit kural; taklit veri bu numaraları kullanmaz). */
export const PROTECTED_DEMO_INVOICES = ['ANB2026000101', 'ANB2026000102', 'EGE2026000877'] as const;

type ErpCfg = Pick<Config, 'env' | 'erp'>;
export type ProviderResolver = (kind: ErpProviderKind) => ErpProvider | null;
export type ErpReadDeps = { config: ErpCfg; provider?: ProviderResolver };

const SYSTEM_USER = '00000000-0000-0000-0000-000000000000';
const MAX_PAGES = 1000;
const ERP_DECIMAL = /^-?\d+(\.\d{1,4})?$/;
const YMD = /^\d{4}-\d{2}-\d{2}$/;
const isReadFeature = (f: unknown): f is ReadFeature => typeof f === 'string' && (ERP_READ_FEATURES as readonly string[]).includes(f);
const isDemo = (no: string) => (PROTECTED_DEMO_INVOICES as readonly string[]).includes(no.trim().toUpperCase());
const sha256 = (v: unknown) => createHash('sha256').update(JSON.stringify(v) ?? 'null').digest('hex');
const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n) : s);

export type RunCounts = { read: number; created: number; updated: number; unchanged: number; skipped: number; failed: number };
type Note = { code: string; message: string };
type HandlerResult = { outcome: 'created' | 'updated' | 'unchanged' | 'skipped' | 'failed'; notes?: Note[] };
const failed = (code: string, message: string): HandlerResult => ({ outcome: 'failed', notes: [{ code, message }] });

// ---------- İşçi işi ----------

type RunRow = { id: string; status: string; provider_kind: ErpProviderKind | null; mock: boolean; trigger: string; counts: Record<string, unknown> };
type EndpointRow = {
  id: string; enabled: boolean; provider_kind: ErpProviderKind; base_url: string | null; resource_path: string | null; auth_type: ResolvedEndpoint['authType'] | null;
  username: string | null; client_id: string | null; token_url: string | null; field_map: FieldMap; timeout_ms: number;
};

/** Çalışmayı kapatır (yalnız RUNNING ise). Hata kaydı varsa önce yazılır. */
async function closeRun(tx: Tx, runId: string, status: 'SUCCESS' | 'PARTIAL' | 'FAILED', counts: Record<string, unknown>): Promise<boolean> {
  return ((await tx.query(`UPDATE integration_runs SET status = $2, finished_at = now(), counts = counts || $3::jsonb WHERE id = $1 AND status = 'RUNNING'`,
    [runId, status, JSON.stringify(counts)])).rowCount ?? 0) > 0;
}

async function addError(tx: Tx, ctx: TenantContext, runId: string, recordKey: string | null, code: string, message: string, payloadSha: string | null, secrets: string[] = []) {
  const safeCode = /^[A-Za-z0-9_.:-]{1,80}$/.test(code) ? code : 'error';
  await tx.query(`INSERT INTO integration_run_errors (tenant_id, run_id, record_key, code, message, payload_sha256) VALUES ($1,$2,$3,$4,$5,$6)`,
    [ctx.tenantId, runId, recordKey ? clip(recordKey, 200) : null, safeCode, redactSecrets(message, secrets).slice(0, 500), payloadSha]);
}

/**
 * Çalışmayı istek atmadan FAILED kapatır (nedeni hata kaydında) ve işi bitirir. Elle istenen çalışma alınmadan özellik kapatıldıysa,
 * sağlayıcı kalktıysa, isteyenin üyeliği gittiyse ya da beklenmeyen hata olduysa çalışma RUNNING kalmaz.
 */
export async function failRunForJob(tx: Tx, ctx: TenantContext, jobId: string, code: string, message: string, jobStatus: 'FAILED' | 'BLOCKED' = 'FAILED',
  requestSent = false) {
  const job = (await tx.query<{ payload: { runId?: unknown } }>(`SELECT payload FROM jobs WHERE id = $1`, [jobId])).rows[0];
  const runId = typeof job?.payload?.runId === 'string' ? job.payload.runId : null;
  if (runId) {
    const run = (await tx.query<{ status: string }>(`SELECT status FROM integration_runs WHERE id = $1 FOR UPDATE`, [runId])).rows[0];
    if (run?.status === 'RUNNING') {
      await addError(tx, ctx, runId, null, code, message, null);
      await closeRun(tx, runId, 'FAILED', { requestSent, reason: code });
    }
  }
  await tx.query(`UPDATE jobs SET status = $2, error_code = $3, result = $4, updated_at = now() WHERE id = $1`,
    [jobId, jobStatus, clip(code.toUpperCase(), 80), JSON.stringify({ runId, status: 'FAILED', reason: code })]);
}

/** Sayfa işlemi sınırları (Ruling 9): kilit beklemesi ve deyim süresi kısa; çalışma toplam süresi sınırlı. YALNIZ TEST değiştirir. */
export const ERP_READ_LIMITS = { lockTimeout: '5s', statementTimeout: '30s', maxRunMs: 30 * 60_000 };

type Prepared =
  | { kind: 'done'; result: { runId: string | null; status: string } }
  | { kind: 'go'; runId: string; feature: ReadFeature; trigger: string; provider: ErpProvider; ep: EndpointRow; resolved: ResolvedEndpoint; secrets: string[] };

/** 1. kısa işlem: iş, çalışma, uç nokta ve sır; koşul yoksa çalışma istek atılmadan kapanır. */
async function prepareRead(tx: Tx, ctx: TenantContext, jobId: string, deps: ErpReadDeps): Promise<Prepared> {
  const resolve: ProviderResolver = deps.provider ?? ((k) => erpProvider(k, deps.config));
  await tx.query(`SET LOCAL lock_timeout = '${ERP_READ_LIMITS.lockTimeout}'`);
  await tx.query(`SET LOCAL statement_timeout = '${ERP_READ_LIMITS.statementTimeout}'`);
  const job = (await tx.query<{ payload: { feature?: unknown; runId?: unknown }; status: string }>(`SELECT payload, status FROM jobs WHERE id = $1`, [jobId])).rows[0];
  if (!job) return { kind: 'done', result: { runId: null, status: 'SKIPPED' } };
  const feature = job.payload?.feature;
  const runId = typeof job.payload?.runId === 'string' ? job.payload.runId : null;
  if (!isReadFeature(feature) || !runId) {
    await tx.query(`UPDATE jobs SET status = 'FAILED', error_code = 'INVALID_PAYLOAD', updated_at = now() WHERE id = $1`, [jobId]);
    return { kind: 'done', result: { runId, status: 'SKIPPED' } };
  }
  const run = (await tx.query<RunRow>(`SELECT id, status, provider_kind, mock, trigger, counts FROM integration_runs WHERE id = $1 AND feature = $2 FOR UPDATE`,
    [runId, feature])).rows[0];
  if (!run) {
    await tx.query(`UPDATE jobs SET status = 'FAILED', error_code = 'RUN_NOT_FOUND', updated_at = now() WHERE id = $1`, [jobId]);
    return { kind: 'done', result: { runId, status: 'SKIPPED' } };
  }
  if (run.status !== 'RUNNING') {
    // Temizleyicinin (stale_run) ya da başka yolun FAILED/BLOCKED yaptığı iş ezilmez.
    await tx.query(`UPDATE jobs SET status = 'SUCCEEDED', result = $2, updated_at = now() WHERE id = $1 AND status NOT IN ('FAILED','BLOCKED','DEAD')`,
      [jobId, JSON.stringify({ runId, skipped: 'run_closed', status: run.status })]);
    return { kind: 'done', result: { runId, status: run.status } };
  }
  const ep = (await tx.query<EndpointRow>(`SELECT id, enabled, provider_kind, base_url, resource_path, auth_type, username, client_id, token_url, field_map, timeout_ms
    FROM integration_endpoints WHERE feature = $1`, [feature])).rows[0];
  const refuse = async (code: string, message: string): Promise<Prepared> => {
    await failRunForJob(tx, ctx, jobId, code, message);
    await audit(tx, ctx, 'integration.endpoint.read_finished', 'integration_endpoint', ep?.id ?? null,
      { feature, runId, status: 'FAILED', reason: code, requestSent: false, mock: run.mock, providerKind: run.provider_kind });
    return { kind: 'done', result: { runId, status: 'FAILED' } };
  };
  if (!ep || !ep.enabled) return refuse('feature_disabled', 'Özellik çalışma başlamadan kapatıldı; ERP\'ye istek atılmadı.');
  if (!ep.base_url || !ep.resource_path || !ep.auth_type) return refuse('endpoint_not_configured', 'Bağlantı ayarları eksik; ERP\'ye istek atılmadı.');
  const provider = resolve(ep.provider_kind);
  if (!provider) return refuse('provider_not_configured', 'Bu ortamda ERP sağlayıcısı yapılandırılmadı; istek atılmadı.');
  if (provider.kind !== run.provider_kind) return refuse('provider_changed', 'Sağlayıcı türü çalışma istendikten sonra değişti; istek atılmadı.');
  const missing = missingMappings(feature, ep.field_map ?? {});
  if (missing.length) return refuse('mapping_incomplete', `Zorunlu alan eşlenmemiş (${missing.join(', ')}); istek atılmadı.`);
  let secret: string | null;
  try {
    secret = await loadEndpointSecret(tx, ep.id, new SecretBox(deps.config.erp?.secretKey ?? null));
  } catch (e) {
    if (e instanceof SecretKekMismatch) return refuse('secret_needs_reentry', 'Sır yeniden girilmeli (anahtar değişti); istek atılmadı.');
    if (e instanceof SecretKeyNotConfigured) return refuse('secret_key_not_configured', 'Sır şifreleme anahtarı yapılandırılmadı; istek atılmadı.');
    if (e instanceof SecretOpenFailed) return refuse('secret_unreadable', 'Kayıtlı sır açılamadı; sırrı yeniden girin. İstek atılmadı.');
    throw e;
  }
  // Nabız ve alınma anı: çalışma alındı (bayat çalışma temizleyicisi bunları izler; süre sınırı kuyrukta bekleme değil alınmadan ölçülür).
  const claimedAt = new Date().toISOString();
  await tx.query(`UPDATE integration_runs SET counts = counts || $2::jsonb WHERE id = $1`, [runId, JSON.stringify({ heartbeatAt: claimedAt, claimedAt })]);
  return {
    kind: 'go', runId, feature, trigger: run.trigger, provider, ep, secrets: secret ? [secret] : [],
    resolved: { id: ep.id, tenantId: ctx.tenantId, feature, baseUrl: ep.base_url, resourcePath: ep.resource_path, authType: ep.auth_type,
      username: ep.username, clientId: ep.client_id, tokenUrl: ep.token_url, secret, timeoutMs: ep.timeout_ms },
  };
}

/** Sağlayıcı hatası saklanırken genel iletiye çevrilir (ERP yanıt metni saklanmaz; yalnız makine kodu). */
function pageFailure(e: unknown): Note {
  if (e instanceof ErpTimeout) return { code: 'timeout', message: 'ERP yanıt vermedi (zaman aşımı); okuma durduruldu.' };
  if (e instanceof ErpProviderError) {
    const code = /^[A-Za-z0-9_.:-]{1,80}$/.test(e.code) ? e.code : 'read_failed';
    return { code, message: code === 'http_401' ? 'ERP kimlik doğrulamayı reddetti (HTTP 401); okuma durduruldu.' : `ERP okuması başarısız oldu (kod ${code}); okuma durduruldu.` };
  }
  return { code: 'read_failed', message: 'ERP okuması başarısız oldu; okuma durduruldu.' };
}

/**
 * Beklenmeyen hatadan sonra çalışmayı kapatır; ileti ve `requestSent` kaydedilmiş duruma göre: hazırlık işlemi commit olmadıysa (nabız yok)
 * değişiklik ve istek yoktur; sayfa(lar) commit olduysa onlar kalır (geri alınmaz), yalnız sonrası işlenmemiştir.
 */
export async function failRunAfterError(tx: Tx, ctx: TenantContext, jobId: string) {
  const job = (await tx.query<{ payload: { runId?: unknown } }>(`SELECT payload FROM jobs WHERE id = $1`, [jobId])).rows[0];
  const runId = typeof job?.payload?.runId === 'string' ? job.payload.runId : null;
  const counts = runId ? (await tx.query<{ counts: Record<string, unknown> }>(`SELECT counts FROM integration_runs WHERE id = $1`, [runId])).rows[0]?.counts ?? {} : {};
  const pages = typeof counts.page === 'number' ? counts.page : 0;
  const started = typeof counts.heartbeatAt === 'string';
  const message = pages > 0
    ? `Çalışma beklenmeyen bir hatayla durdu; kaydedilmiş ${pages} sayfa (${Number(counts.read ?? 0)} kayıt) yerinde kaldı, sonraki sayfalar işlenmedi. Yeniden çalıştırın.`
    : started ? 'Çalışma beklenmeyen bir hatayla durdu; ERP\'ye istek atıldı ama hiçbir sayfa kaydedilmedi. Yeniden çalıştırın.'
      : 'Çalışma hazırlanırken beklenmeyen bir hatayla durdu; değişiklikler geri alındı, ERP\'ye istek atılmadı. Yeniden çalıştırın.';
  await failRunForJob(tx, ctx, jobId, 'internal_error', message, 'FAILED', started);
}

/**
 * `erp.read` işini işler (Ruling 9). Sayfa ERP'den hiçbir veritabanı bağlantısı tutulmadan okunur; her sayfa kısa bir kiracı işleminde
 * (lock_timeout + statement_timeout, kayıt başına SAVEPOINT) işlenir ve aynı işlemde çalışmanın sayıları, imleci ve nabzı yazılır.
 * Çalışma ayrı küçük işlemde kapanır. Toplam süre sınırı aşılırsa okuma durur (PARTIAL/FAILED). Bayat çalışmaları `reapStaleErpRuns` kapatır.
 */
export async function processErpRead(pool: pg.Pool, ctx: TenantContext, jobId: string, deps: ErpReadDeps): Promise<{ runId: string | null; status: string; counts?: RunCounts }> {
  const p = await withTenant(pool, ctx, (tx) => prepareRead(tx, ctx, jobId, deps));
  if (p.kind === 'done') return p.result;
  const { runId, feature, provider, ep, resolved, secrets } = p;
  const counts: RunCounts = { read: 0, created: 0, updated: 0, unchanged: 0, skipped: 0, failed: 0 };
  let errorRows = 0;
  let pageError: Note | null = null;
  let closedElsewhere = false;
  const handler = HANDLERS[feature];
  const hctx: HandlerCtx = { providerKind: provider.kind, mock: !provider.real, runId };
  const started = Date.now();
  try {
    let cursor: string | null = null;
    for (let page = 0; ; page++) {
      if (page >= MAX_PAGES) { pageError = { code: 'too_many_pages', message: `En fazla ${MAX_PAGES} sayfa okunur; okuma durduruldu.` }; break; }
      if (Date.now() - started > ERP_READ_LIMITS.maxRunMs) { pageError = { code: 'run_duration_exceeded', message: 'Çalışma süre sınırını aştı; okuma durduruldu.' }; break; }
      let res: { records: unknown[]; nextCursor: string | null };
      try {
        res = await provider.read(resolved, feature, cursor); // bağlantı tutulmaz
      } catch (e) {
        pageError = pageFailure(e);
        break;
      }
      const records = Array.isArray(res.records) ? res.records : [];
      const nextCursor = res.nextCursor;
      try {
        const alive = await withTenant(pool, ctx, async (tx) => {
          await tx.query(`SET LOCAL lock_timeout = '${ERP_READ_LIMITS.lockTimeout}'`);
          await tx.query(`SET LOCAL statement_timeout = '${ERP_READ_LIMITS.statementTimeout}'`);
          const st = (await tx.query<{ status: string }>(`SELECT status FROM integration_runs WHERE id = $1 FOR UPDATE`, [runId])).rows[0]?.status;
          if (st !== 'RUNNING') return false;
          const local = { ...counts };
          let localErrors = 0;
          for (const record of records) {
            local.read++;
            const payloadSha = sha256(record);
            const { values, errors } = applyFieldMap(ep.field_map, record, feature);
            const key = recordKey(feature, values);
            if (errors.length) {
              local.failed++;
              const fields = errors.map((x) => `${x.field} (${x.code})`).join(', ');
              await addError(tx, ctx, runId, key, errors[0]!.code, `Satır reddedildi; yuvarlanmadı/uydurulmadı: ${fields}.`, payloadSha, secrets);
              localErrors++;
              continue;
            }
            let r: HandlerResult;
            await tx.query('SAVEPOINT erp_read_record');
            try {
              r = await handler(tx, ctx, values, hctx);
              if (r.outcome === 'failed') await tx.query('ROLLBACK TO SAVEPOINT erp_read_record');
              else await tx.query('RELEASE SAVEPOINT erp_read_record');
            } catch (e) {
              await tx.query('ROLLBACK TO SAVEPOINT erp_read_record');
              const pgCode = typeof (e as { code?: unknown })?.code === 'string' ? (e as { code: string }).code : null;
              r = failed('record_failed', e instanceof ApiError ? e.message : `Kayıt işlenemedi${pgCode ? ` (veritabanı kodu ${pgCode})` : ''}.`);
            }
            local[r.outcome]++;
            for (const n of r.notes ?? []) { await addError(tx, ctx, runId, key, n.code, n.message, payloadSha, secrets); localErrors++; }
          }
          await tx.query(`UPDATE integration_runs SET counts = counts || $2::jsonb WHERE id = $1`,
            [runId, JSON.stringify({ ...local, page: page + 1, cursor: nextCursor, heartbeatAt: new Date().toISOString() })]);
          Object.assign(counts, local);
          errorRows += localErrors;
          return true;
        });
        if (!alive) { closedElsewhere = true; break; }
      } catch (e) {
        // Sayfa işlemi geri alındı (ör. kilit beklemesi aşıldı); önceki sayfalar kalır, okuma durur.
        const pgCode = typeof (e as { code?: unknown })?.code === 'string' ? (e as { code: string }).code : null;
        pageError = { code: 'page_failed', message: `Sayfa işlenemedi${pgCode ? ` (veritabanı kodu ${pgCode})` : ''}; bu sayfanın kayıtları geri alındı, okuma durduruldu.` };
        break;
      }
      cursor = nextCursor;
      if (!cursor) break;
    }
  } finally {
    resolved.secret = null;
  }
  if (closedElsewhere) {
    await withTenant(pool, ctx, (tx) => tx.query(`UPDATE jobs SET status = 'FAILED', error_code = 'RUN_CLOSED', updated_at = now() WHERE id = $1 AND status IN ('QUEUED','RUNNING')`, [jobId]));
    return { runId, status: 'FAILED', counts };
  }
  const okRecords = counts.created + counts.updated + counts.unchanged + counts.skipped;
  const status: 'SUCCESS' | 'PARTIAL' | 'FAILED' = (pageError && okRecords === 0) || (counts.read > 0 && okRecords === 0 && counts.failed > 0) ? 'FAILED'
    : errorRows > 0 || pageError ? 'PARTIAL' : 'SUCCESS';
  const closed = await withTenant(pool, ctx, async (tx) => {
    // Çalışma bu arada başka yoldan (temizleyici) kapandıysa: iş SUCCEEDED yapılmaz, hata eklenmez, başarı denetimi yazılmaz.
    if (!(await closeRun(tx, runId, status, { ...counts, requestSent: true }))) {
      await tx.query(`UPDATE jobs SET status = 'FAILED', error_code = 'RUN_CLOSED', updated_at = now() WHERE id = $1 AND status IN ('QUEUED','RUNNING')`, [jobId]);
      return false;
    }
    if (pageError) await addError(tx, ctx, runId, null, pageError.code, pageError.message, null, secrets);
    await tx.query(`UPDATE jobs SET status = 'SUCCEEDED', result = $2, updated_at = now() WHERE id = $1`, [jobId, JSON.stringify({ runId, status, counts })]);
    await audit(tx, ctx, 'integration.endpoint.read_finished', 'integration_endpoint', ep.id,
      { feature, runId, status, counts, errorRows: errorRows + (pageError ? 1 : 0), mock: !provider.real, providerKind: provider.kind, trigger: p.trigger });
    return true;
  });
  return { runId, status: closed ? status : 'FAILED', counts };
}

/**
 * Bayat çalışma sınırları: nabız bu kadar eskiyse ya da çalışma (alındığı andan) bu kadar uzun sürdüyse kapatılır; işi hâlâ kuyrukta
 * (QUEUED, hiç alınmamış) çalışma yalnız `maxQueuedMinutes`'ı aşınca kapatılır (erp şeridi sıralı, bir okuma 30 dk sürebilir). YALNIZ TEST değiştirir.
 */
export const ERP_STALE = { heartbeatMinutes: 15, maxRunMinutes: 60, maxQueuedMinutes: 240 };

/**
 * Bayat okuma çalışmalarını (işçi çöktü, iş çok uzun süre alınmadı) FAILED `stale_run` kapatır ve işini FAILED yapar; kiracı bağlamında (RLS).
 * Kuyrukta bekleyen (iş QUEUED, nabız yok) çalışmanın süresi başlangıçtan değil, uzun bekleme sınırıyla ölçülür: önündeki uzun okuma onu öldürmez.
 * Alınmış çalışmada son etkinlik nabız / işin alınma anı / başlangıçtan en yenisidir; süre sınırı alınma anından ölçülür.
 * Yazma yeniden deneme çalışmaları (mode WRITE_RETRY) ve sınamalar dokunulmaz. Döner: kapatılan çalışma sayısı.
 */
export async function reapStaleErpRuns(tx: Tx, tenantId: string, now: Date = new Date()): Promise<number> {
  const stale = (await tx.query<{ id: string }>(`SELECT r.id FROM integration_runs r
    LEFT JOIN LATERAL (SELECT j.status, j.updated_at FROM jobs j WHERE j.kind = $5 AND j.payload->>'runId' = r.id::text ORDER BY j.created_at DESC LIMIT 1) j ON true
    WHERE r.status = 'RUNNING' AND r.trigger <> 'TEST' AND coalesce(r.counts->>'mode', 'READ') = 'READ'
      AND CASE WHEN j.status = 'QUEUED' AND r.counts->>'heartbeatAt' IS NULL
        THEN r.started_at < $1::timestamptz - make_interval(mins => $4)
        ELSE greatest((r.counts->>'heartbeatAt')::timestamptz, CASE WHEN j.status = 'RUNNING' THEN j.updated_at END, r.started_at) < $1::timestamptz - make_interval(mins => $2)
          OR coalesce((r.counts->>'claimedAt')::timestamptz, CASE WHEN j.status = 'RUNNING' THEN j.updated_at END, r.started_at) < $1::timestamptz - make_interval(mins => $3)
      END
    ORDER BY r.started_at FOR UPDATE OF r SKIP LOCKED`,
  [now.toISOString(), ERP_STALE.heartbeatMinutes, ERP_STALE.maxRunMinutes, ERP_STALE.maxQueuedMinutes, ERP_READ_JOB])).rows;
  for (const r of stale) {
    await tx.query(`INSERT INTO integration_run_errors (tenant_id, run_id, code, message) VALUES ($1,$2,'stale_run',$3)`,
      [tenantId, r.id, 'Çalışma zamanında bitmedi (işçi durmuş ya da iş uzun süre alınmamış); başarısız sayıldı. Yeniden çalıştırın.']);
    await tx.query(`UPDATE integration_runs SET status = 'FAILED', finished_at = now(), counts = counts || '{"reason":"stale_run"}'::jsonb WHERE id = $1 AND status = 'RUNNING'`, [r.id]);
    await tx.query(`UPDATE jobs SET status = 'FAILED', error_code = 'STALE_RUN', updated_at = now() WHERE kind = $1 AND payload->>'runId' = $2 AND status IN ('QUEUED','RUNNING')`,
      [ERP_READ_JOB, r.id]);
  }
  return stale.length;
}

function recordKey(feature: ReadFeature, v: Record<string, string | null>): string | null {
  const k = feature === 'SUPPLIER' ? v.taxId : feature === 'COST_CENTER' ? v.code : feature === 'PURCHASE_ORDER' ? v.poNo : v.invoiceNo;
  return k ?? null;
}

// ---------- Özellik işleyicileri ----------

type HandlerCtx = { providerKind: ErpProviderKind; mock: boolean; runId: string };
type Handler = (tx: Tx, ctx: TenantContext, v: Record<string, string | null>, h: HandlerCtx) => Promise<HandlerResult>;

/**
 * ERP'den gelen VKN/TCKN eşleme anahtarı: baştaki "TR" öneki, boşluk, nokta ve tire atılır (uygulamadaki tax_id rakam olarak saklanır).
 * Geçerli VKN/TCKN ise domain `normalizeTaxId` sonucu; kontrol basamağı tutmasa da rakamlar (eşleşme yine tam eşitlikle). Rakam değilse
 * (yabancı kimlik) kırpılmış hali. Boşsa null.
 */
export function erpTaxKey(raw: string | null | undefined): string | null {
  const t = (raw ?? '').trim();
  if (!t) return null;
  const digits = t.replace(/^TR(?=[\s.\-]*\d)/i, '').replace(/[\s.\-]/g, '');
  if (!/^\d+$/.test(digits)) return t;
  const n = digits.length === 11 ? normalizeTaxId('TR', 'TCKN', digits) : normalizeTaxId('TR', 'VKN', digits);
  return n.ok ? n.normalized : digits;
}

type SupplierRow = { id: string; erp_supplier_code: string | null; erp_supplier_code_source: 'ERP' | 'MANUAL' | null };
/** Tedarikçi: ERP kodu verilmişse önce kodla, yoksa (ya da bulunmazsa) VKN ile; birleştirilmiş kart hariç. Yeni kart açılmaz (R12). */
async function resolveSupplier(tx: Tx, taxId: string | null, code: string | null, lock = false):
  Promise<{ kind: 'ok'; row: SupplierRow } | { kind: 'none' } | { kind: 'ambiguous' }> {
  const q = async (where: string, val: string) => (await tx.query<SupplierRow>(`SELECT id, erp_supplier_code, erp_supplier_code_source FROM suppliers
    WHERE ${where} = $1 AND merged_into_id IS NULL AND status <> 'MERGED' ORDER BY created_at, id LIMIT 2${lock ? ' FOR UPDATE' : ''}`, [val])).rows;
  if (code) {
    const byCode = await q('erp_supplier_code', code);
    if (byCode.length === 1) return { kind: 'ok', row: byCode[0]! };
    if (byCode.length > 1) return { kind: 'ambiguous' };
  }
  const key = erpTaxKey(taxId);
  if (!key) return { kind: 'none' };
  const byTax = await q('tax_id', key);
  return byTax.length === 1 ? { kind: 'ok', row: byTax[0]! } : byTax.length ? { kind: 'ambiguous' } : { kind: 'none' };
}
const NOT_MATCHED = 'VKN uygulamadaki hiçbir tedarikçiyle eşleşmedi; yeni tedarikçi açılmadı (onay akışı uygulamada kalır).';
const AMBIGUOUS = 'VKN birden çok tedarikçi kartıyla eşleşti; hangisi olduğu tahmin edilmedi.';

const supplierHandler: Handler = async (tx, ctx, v, h) => {
  const code = v.erpSupplierCode!;
  if (code.length > 60) return failed('invalid_value', 'ERP tedarikçi kodu 60 karakterden uzun.');
  const s = await resolveSupplier(tx, v.taxId ?? null, null, true);
  if (s.kind === 'none') return failed('supplier_not_matched', NOT_MATCHED);
  if (s.kind === 'ambiguous') return failed('supplier_ambiguous', AMBIGUOUS);
  const cur = s.row;
  const r = reconcileManual({ value: cur.erp_supplier_code, source: cur.erp_supplier_code_source }, code);
  if (r === 'SAME') return { outcome: 'unchanged' };
  if (r === 'CONFLICT_MANUAL') {
    return { outcome: 'skipped', notes: [{ code: 'CONFLICT_MANUAL',
      message: `Elle girilen değerle çelişiyor: kartta elle girilmiş ERP tedarikçi kodu (${cur.erp_supplier_code}) korundu; ERP'deki kod ${code}.` }] };
  }
  // Birleştirilmiş (MERGED) kart sayılmaz: kod birleşmede yaşayan karta taşınabilir.
  const other = (await tx.query(`SELECT 1 FROM suppliers WHERE erp_supplier_code = $1 AND id <> $2 AND status <> 'MERGED' LIMIT 1`, [code, cur.id])).rowCount;
  if (other) return failed('supplier_code_duplicate', `ERP tedarikçi kodu ${code} başka bir tedarikçi kartında kayıtlı; ikinci karta yazılmadı.`);
  await tx.query(`UPDATE suppliers SET erp_supplier_code = $2, erp_supplier_code_source = 'ERP' WHERE id = $1`, [cur.id, code]);
  await audit(tx, ctx, 'supplier.erp_code_set', 'supplier', cur.id, { from: cur.erp_supplier_code, to: code, source: 'ERP', runId: h.runId, mock: h.mock });
  return { outcome: 'updated' };
};

const INACTIVE = new Set(['N', 'NO', 'FALSE', '0', 'H', 'HAYIR', 'INACTIVE', 'PASIF']);
const costCenterHandler: Handler = async (tx, ctx, v, h) => {
  const code = v.code!;
  const name = v.name!.trim();
  if (code.length > 60) return failed('invalid_value', 'Masraf merkezi kodu 60 karakterden uzun.');
  if (name.length > 200) return failed('invalid_value', 'Masraf merkezi adı 200 karakterden uzun.');
  const active = v.active == null ? true : !INACTIVE.has(v.active.trim().toUpperCase());
  const cur = (await tx.query<{ name: string; active: boolean; provider_kind: string }>(`SELECT name, active, provider_kind FROM erp_cost_centers WHERE code = $1 FOR UPDATE`,
    [code])).rows[0];
  // Departmana otomatik atama yok: Yönetici departmanda masraf merkezini seçer (R6; departman ana kaynağı Entra).
  if (!cur) {
    await tx.query(`INSERT INTO erp_cost_centers (tenant_id, code, name, active, provider_kind) VALUES ($1,$2,$3,$4,$5)`, [ctx.tenantId, code, name, active, h.providerKind]);
    return { outcome: 'created' };
  }
  const same = cur.name === name && cur.active === active && cur.provider_kind === h.providerKind;
  await tx.query(`UPDATE erp_cost_centers SET name = $2, active = $3, provider_kind = $4, synced_at = now() WHERE code = $1`, [code, name, active, h.providerKind]);
  return { outcome: same ? 'unchanged' : 'updated' };
};

type PoRow = { po_no: string; supplier_id: string | null; erp_supplier_code: string | null; contract_ref: string | null; currency: string | null; amount: string | null;
  order_date: string | null; provider_kind: string };
const purchaseOrderHandler: Handler = async (tx, ctx, v, h) => {
  const poNo = v.poNo!;
  const erpPoId = v.erpPoId ?? poNo;
  const currency = v.currency!;
  if (poNo.length > 60 || erpPoId.length > 120 || (v.contractRef?.length ?? 0) > 60 || (v.erpSupplierCode?.length ?? 0) > 60) {
    return failed('invalid_value', 'Sipariş no / kimlik / sözleşme referansı / tedarikçi kodu izin verilen uzunluğu aşıyor.');
  }
  if (!/^[A-Z]{3}$/.test(currency)) return failed('invalid_currency', 'Para birimi üç harfli ISO kodu değil.');
  const s = await resolveSupplier(tx, v.supplierTaxId ?? null, v.erpSupplierCode ?? null);
  const notes: Note[] = [];
  if (s.kind === 'none') notes.push({ code: 'supplier_not_matched', message: 'Sipariş kaydedildi; VKN eşleşen tedarikçi yok, tedarikçi bağlanmadı (yeni tedarikçi açılmadı).' });
  if (s.kind === 'ambiguous') notes.push({ code: 'supplier_ambiguous', message: 'Sipariş kaydedildi; VKN birden çok tedarikçiyle eşleşti, tedarikçi bağlanmadı.' });
  const next = {
    po_no: poNo, supplier_id: s.kind === 'ok' ? s.row.id : null, erp_supplier_code: v.erpSupplierCode ?? (s.kind === 'ok' ? s.row.erp_supplier_code : null),
    contract_ref: v.contractRef, currency, amount: v.amount, order_date: v.orderDate, provider_kind: h.providerKind,
  };
  const cur = (await tx.query<PoRow>(`SELECT po_no, supplier_id, erp_supplier_code, contract_ref, currency, amount, order_date::text AS order_date, provider_kind
    FROM erp_purchase_orders WHERE erp_po_id = $1 FOR UPDATE`, [erpPoId])).rows[0];
  const params = [erpPoId, next.po_no, next.supplier_id, next.erp_supplier_code, next.contract_ref, next.currency, next.amount, next.order_date, next.provider_kind];
  if (!cur) {
    await tx.query(`INSERT INTO erp_purchase_orders (tenant_id, erp_po_id, po_no, supplier_id, erp_supplier_code, contract_ref, currency, amount, order_date, provider_kind)
      VALUES ($10,$1,$2,$3,$4,$5,$6,$7,$8,$9)`, [...params, ctx.tenantId]);
    return { outcome: 'created', notes };
  }
  const same = (Object.keys(next) as (keyof typeof next)[]).every((k) => (cur[k] ?? null) === (next[k] ?? null));
  await tx.query(`UPDATE erp_purchase_orders SET po_no = $2, supplier_id = $3, erp_supplier_code = $4, contract_ref = $5, currency = $6, amount = $7, order_date = $8,
    provider_kind = $9, synced_at = now() WHERE erp_po_id = $1`, params);
  return { outcome: same ? 'unchanged' : 'updated', notes };
};

const decPlaces = (s: string) => (s.split('.')[1] ?? '').length;

const invoiceHandler: Handler = async (tx, ctx, v, h) => {
  const gross = v.totalAmount!;
  const tax = v.taxAmount ?? '0';
  if (decPlaces(gross) > 2 || decPlaces(tax) > 2) return failed('invalid_decimal_places', 'Fatura tutarı 2 ondalıktan fazla; yuvarlanmadı, satır reddedildi.');
  if (dec(tax) > dec(gross)) return failed('invalid_amount', 'KDV tutarı fatura toplamını aşıyor; satır reddedildi.');
  const record: ErpInvoiceRecord = {
    erpInvoiceId: v.erpInvoiceId ?? `${v.supplierTaxId}:${v.invoiceNo}`, invoiceNo: v.invoiceNo!, supplierTaxId: v.supplierTaxId!, erpSupplierCode: v.erpSupplierCode ?? null,
    issueDate: v.invoiceDate!, currency: v.currency!, netAmount: str(dec(gross) - dec(tax), 2), grossAmount: gross, contractRef: v.contractRef ?? null, poRef: v.poNo ?? null,
    companyTaxId: v.companyTaxId,
  };
  const r = await importErpInvoice(tx, ctx, record, { providerKind: h.providerKind, runId: h.runId });
  const notes = r.notes ?? [];
  if (r.outcome === 'REJECTED') return { outcome: 'failed', notes: [{ code: r.code ?? 'rejected', message: r.message ?? 'ERP faturası reddedildi.' }, ...notes] };
  return { outcome: r.outcome === 'CREATED' ? 'created' : r.outcome === 'LINKED' ? 'updated' : 'unchanged', notes };
};

const PAYMENT_FLAG: Record<string, 'PAID' | 'PARTIAL' | 'UNPAID' | 'UNKNOWN'> = {
  Y: 'PAID', P: 'PARTIAL', N: 'UNPAID', PAID: 'PAID', PARTIAL: 'PARTIAL', UNPAID: 'UNPAID', UNKNOWN: 'UNKNOWN',
};
const paymentHandler: Handler = async (tx, ctx, v, h) => {
  const invoiceNo = v.invoiceNo!;
  if (isDemo(invoiceNo)) return failed('demo_invoice_protected', 'Demo fatura ERP okumasıyla değiştirilmez.');
  const status = PAYMENT_FLAG[v.status!.trim().toUpperCase()] ?? 'UNKNOWN';
  const s = await resolveSupplier(tx, v.supplierTaxId ?? null, null);
  if (s.kind === 'none') return failed('supplier_not_matched', NOT_MATCHED);
  if (s.kind === 'ambiguous') return failed('supplier_ambiguous', AMBIGUOUS);
  const inv = (await tx.query<{ id: string; erp_payment_status: string | null; at: string | null; erp_payment_source: 'ERP' | 'MANUAL' | null }>(
    `SELECT id, erp_payment_status, erp_payment_status_at::text AS at, erp_payment_source FROM invoices WHERE supplier_id = $1 AND invoice_no = $2 FOR UPDATE`,
    [s.row.id, invoiceNo])).rows[0];
  if (!inv) return failed('invoice_not_found', 'Fatura uygulamada yok; ödeme durumu yazılmadı.');
  const date = v.paymentDate ?? null;
  const fmt = (st: string | null, at: string | null) => (st ? `${st}|${at ?? ''}` : null);
  const r = reconcileManual({ value: fmt(inv.erp_payment_status, inv.at), source: inv.erp_payment_source }, fmt(status, date));
  if (r === 'SAME') return { outcome: 'unchanged' };
  if (r === 'CONFLICT_MANUAL') {
    return { outcome: 'skipped', notes: [{ code: 'CONFLICT_MANUAL',
      message: `Elle girilen değerle çelişiyor: faturada elle girilmiş ödeme durumu (${inv.erp_payment_status}${inv.at ? `, ${inv.at}` : ''}) korundu; ERP: ${status}${date ? `, ${date}` : ''}.` }] };
  }
  // Bilgi alanı: uygulama ödeme yapmaz; v1 payment_status değişmez.
  await tx.query(`UPDATE invoices SET erp_payment_status = $2, erp_payment_status_at = $3, erp_payment_source = 'ERP' WHERE id = $1`, [inv.id, status, date]);
  await audit(tx, ctx, 'invoice.erp_payment_status', 'invoice', inv.id,
    { from: inv.erp_payment_status, fromAt: inv.at, to: status, at: date, source: 'ERP', runId: h.runId, mock: h.mock });
  return { outcome: 'updated' };
};

const HANDLERS: Record<ReadFeature, Handler> = {
  SUPPLIER: supplierHandler, COST_CENTER: costCenterHandler, PURCHASE_ORDER: purchaseOrderHandler, INVOICE: invoiceHandler, PAYMENT_STATUS: paymentHandler,
};

// ---------- Fatura içe alımı (R12) ----------

export type ErpInvoiceImport = {
  /** REJECTED'da null. */
  invoiceId: string | null;
  outcome: 'CREATED' | 'LINKED' | 'UNCHANGED' | 'REJECTED';
  code?: string;
  message?: string;
  /** Kayıt dışı farklar (elle değerle çelişen referans, tutar farkı vb.); hata kaydına yazılır, değer ezilmez. */
  notes?: Note[];
  match?: AutoMatchResult;
};

const reject = (code: string, message: string): ErpInvoiceImport => ({ invoiceId: null, outcome: 'REJECTED', code, message });

/**
 * ERP faturasını içe alır: aynı ERP kimliği → UNCHANGED; aynı tedarikçi + fatura no ile elle girilmiş fatura → ERP kimliği bağlanır
 * (LINKED; ikinci kayıt açılmaz, boş ERP referansı ERP kaynağıyla doldurulur, dolu değer ezilmez); yoksa `source` ERP fatura açılır
 * (CREATED). Bağlama ve açılıştan sonra Faz 7 eşleştiricisi çalışır. Demo faturalar ve eksi tutar reddedilir.
 */
export async function importErpInvoice(tx: Tx, ctx: TenantContext, r: ErpInvoiceRecord, opts: { providerKind: ErpProviderKind; runId?: string | null }): Promise<ErpInvoiceImport> {
  const invoiceNo = r.invoiceNo?.trim() ?? '';
  if (!invoiceNo || invoiceNo.length > 60) return reject('invalid_value', 'Fatura no boş ya da 60 karakterden uzun.');
  if (!r.erpInvoiceId?.trim() || r.erpInvoiceId.trim().length > 120) return reject('invalid_value', 'ERP fatura kimliği boş ya da 120 karakterden uzun.');
  if (isDemo(invoiceNo)) return reject('demo_invoice_protected', 'Demo fatura ERP okumasıyla değiştirilmez.');
  if (![r.netAmount, r.grossAmount].every((x) => typeof x === 'string' && ERP_DECIMAL.test(x))) return reject('invalid_decimal', 'Tutar ondalık biçimde değil; yuvarlanmadı.');
  if (decPlaces(r.netAmount) > 2 || decPlaces(r.grossAmount) > 2) return reject('invalid_decimal_places', 'Fatura tutarı 2 ondalıktan fazla; yuvarlanmadı, satır reddedildi.');
  if (dec(r.netAmount) < 0n || dec(r.grossAmount) < 0n) return reject('negative_amount', 'Eksi tutarlı (iade/alacak) ERP faturası bu aşamada içe alınmaz; elle girin.');
  if (dec(r.netAmount) > dec(r.grossAmount)) return reject('invalid_amount', 'Net tutar fatura toplamını aşıyor.');
  if (!/^[A-Z]{3}$/.test(r.currency ?? '')) return reject('invalid_currency', 'Para birimi üç harfli ISO kodu değil.');
  if (!YMD.test(r.issueDate ?? '')) return reject('invalid_date', 'Fatura tarihi YYYY-AA-GG değil.');
  for (const ref of [r.contractRef, r.poRef, r.erpSupplierCode]) if (ref && ref.trim().length > 60) return reject('invalid_reference', 'ERP referansı 60 karakterden uzun.');
  const erpId = r.erpInvoiceId.trim();
  const mock = opts.providerKind === 'TAKLIT';

  const s = await resolveSupplier(tx, r.supplierTaxId?.trim() || null, r.erpSupplierCode?.trim() || null);
  if (s.kind === 'none') return reject('supplier_not_matched', NOT_MATCHED);
  if (s.kind === 'ambiguous') return reject('supplier_ambiguous', AMBIGUOUS);
  const supplierId = s.row.id;
  // createInvoice ile aynı kilit: aynı tedarikçi + fatura no eşzamanlı ikinci kayıt açmaz.
  await tx.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`invoice:${supplierId}:${invoiceNo}`]);

  const byErp = (await tx.query<{ id: string; supplier_id: string; invoice_no: string }>(`SELECT id, supplier_id, invoice_no FROM invoices WHERE erp_invoice_id = $1`, [erpId])).rows[0];
  if (byErp) {
    if (byErp.supplier_id === supplierId && byErp.invoice_no === invoiceNo) return { invoiceId: byErp.id, outcome: 'UNCHANGED' };
    return reject('erp_invoice_conflict', 'Bu ERP fatura kimliği başka bir faturaya bağlı; kayıt değiştirilmedi.');
  }

  type Existing = { id: string; company_id: string; erp_invoice_id: string | null; erp_contract_ref: string | null; erp_contract_ref_source: string | null;
    erp_order_ref: string | null; erp_order_ref_source: string | null; currency: string; issue_date: string; net: string | null };
  const ex = (await tx.query<Existing>(`SELECT i.id, i.company_id, i.erp_invoice_id, i.erp_contract_ref, i.erp_contract_ref_source, i.erp_order_ref, i.erp_order_ref_source,
      i.currency, i.issue_date::text AS issue_date, (SELECT sum(l.net_amount)::text FROM invoice_lines l WHERE l.invoice_id = i.id) AS net
    FROM invoices i WHERE i.supplier_id = $1 AND i.invoice_no = $2 FOR UPDATE OF i`, [supplierId, invoiceNo])).rows[0];
  if (ex) {
    if (ex.erp_invoice_id) return reject('erp_invoice_conflict', 'Bu fatura başka bir ERP fatura kimliğine bağlı; kayıt değiştirilmedi.');
    const notes: Note[] = [];
    await tx.query(`UPDATE invoices SET erp_invoice_id = $2, erp_provider_kind = $3 WHERE id = $1`, [ex.id, erpId, opts.providerKind]);
    // ERP referansları: boşsa ERP kaynağıyla doldurulur (058a NULL → değer); doluysa ezilmez, fark hata kaydına yazılır.
    const refs = [
      { col: 'erp_contract_ref', label: 'sözleşme referansı', cur: ex.erp_contract_ref, src: ex.erp_contract_ref_source, inc: r.contractRef?.trim() || null },
      { col: 'erp_order_ref', label: 'sipariş referansı', cur: ex.erp_order_ref, src: ex.erp_order_ref_source, inc: r.poRef?.trim() || null },
    ] as const;
    for (const x of refs) {
      if (!x.inc) continue;
      if (x.cur === null) {
        await tx.query(`UPDATE invoices SET ${x.col} = $2, ${x.col}_source = 'ERP' WHERE id = $1`, [ex.id, x.inc]);
      } else if (x.cur.trim().toUpperCase() !== x.inc.toUpperCase()) {
        notes.push(x.src === 'ERP'
          ? { code: 'erp_ref_differs', message: `ERP ${x.label} değişmiş (kayıtlı ${x.cur}, ERP ${x.inc}); kayıtlı değer değiştirilmedi.` }
          : { code: 'CONFLICT_MANUAL', message: `Elle girilen değerle çelişiyor: faturadaki ${x.label} (${x.cur}) korundu; ERP: ${x.inc}.` });
      }
    }
    if (ex.net !== null && dec(ex.net) !== dec(r.netAmount)) {
      notes.push({ code: 'amount_differs', message: `Elle girilen fatura net tutarı (${ex.net}) ERP'dekinden (${r.netAmount}) farklı; fatura tutarı değiştirilmedi.` });
    }
    if (ex.currency.trim() !== r.currency) notes.push({ code: 'currency_differs', message: `Para birimi farklı (kayıtlı ${ex.currency.trim()}, ERP ${r.currency}); değiştirilmedi.` });
    if (ex.issue_date !== r.issueDate) notes.push({ code: 'date_differs', message: `Fatura tarihi farklı (kayıtlı ${ex.issue_date}, ERP ${r.issueDate}); değiştirilmedi.` });
    await tx.query(`INSERT INTO invoice_intake_events (tenant_id, company_id, invoice_id, source, duplicate, received_by) VALUES ($1,$2,$3,'erp',true,$4)`,
      [ctx.tenantId, ex.company_id, ex.id, ctx.userId]);
    await audit(tx, ctx, 'invoice.erp_linked', 'invoice', ex.id, { erpInvoiceId: erpId, providerKind: opts.providerKind, mock, runId: opts.runId ?? null,
      differences: notes.map((n) => n.code) });
    const match = await autoMatchInvoice(tx, ctx, ex.id);
    return { invoiceId: ex.id, outcome: 'LINKED', notes, match };
  }

  // Yeni fatura: şirket tahmin edilmez (alıcı VKN eşlenmişse o; yoksa kiracıda tek şirket varsa o).
  let companyId: string;
  if (r.companyTaxId?.trim()) {
    const c = (await tx.query<{ id: string }>(`SELECT id FROM legal_entities WHERE tax_id = $1 LIMIT 2`, [erpTaxKey(r.companyTaxId)])).rows;
    if (c.length !== 1) return reject('company_not_found', 'Alıcı şirket VKN\'si kiracıdaki bir şirketle eşleşmedi; fatura açılmadı.');
    companyId = c[0]!.id;
  } else {
    const c = (await tx.query<{ id: string }>(`SELECT id FROM legal_entities ORDER BY id LIMIT 2`)).rows;
    if (c.length !== 1) return reject('company_unresolved', 'Kiracıda birden çok şirket var ve "Alıcı şirket VKN" alanı eşlenmemiş; şirket tahmin edilmedi, fatura açılmadı.');
    companyId = c[0]!.id;
  }
  if (!ctx.companyIds.includes(companyId)) return reject('company_not_in_scope', 'Faturanın şirketi bu çalışmanın kapsamında değil; fatura açılmadı.');

  // Referanslar ERP'de yazdığı gibi saklanır (uydurulmaz); sipariş referansını Faz 7 eşleştiricisi erp_purchase_orders üzerinden çözer.
  const contractRef = r.contractRef?.trim() || null;
  const poRef = r.poRef?.trim() || null;
  const net = r.netAmount;
  const tax = str(dec(r.grossAmount) - dec(net), 2);
  const rate = dec(net) === 0n ? '0' : str(mul(div(dec(tax), dec(net)), dec('100')), 2);
  if (dec(rate) > dec('100')) return reject('invalid_amount', 'KDV oranı %100\'ü aşıyor; satır reddedildi.');
  let created: Awaited<ReturnType<typeof createInvoice>>;
  try {
    created = await createInvoice(tx, ctx, {
      companyId, supplierId, kind: 'INVOICE', invoiceNo, issueDate: r.issueDate, currency: r.currency,
      lines: [{ description: `ERP faturası ${invoiceNo}`, quantity: '1', unit: 'adet', unitPrice: str(dec(net), 2), netAmount: str(dec(net), 2), taxRate: rate, taxAmount: tax }],
      declaredTaxTotal: tax, declaredPayable: str(dec(r.grossAmount), 2), erpContractRef: contractRef, erpOrderRef: poRef, erpRefSource: 'ERP',
    }, 'erp');
  } catch (e) {
    if (e instanceof ApiError) return reject(e.code, e.message);
    throw e;
  }
  if (created.duplicate) return { invoiceId: created.id, outcome: 'UNCHANGED' };
  await tx.query(`UPDATE invoices SET erp_invoice_id = $2, erp_provider_kind = $3 WHERE id = $1`, [created.id, erpId, opts.providerKind]);
  await audit(tx, ctx, 'invoice.erp_imported', 'invoice', created.id, { erpInvoiceId: erpId, providerKind: opts.providerKind, mock, runId: opts.runId ?? null,
    matchState: created.match?.state ?? null });
  return { invoiceId: created.id, outcome: 'CREATED', notes: [], match: created.match };
}

// ---------- Zamanlama (R7) ----------

type ScheduleRow = { id: string; feature: ReadFeature; provider_kind: ErpProviderKind; schedule_kind: 'MANUAL' | 'INTERVAL' | 'DAILY'; schedule_interval_min: number | null;
  daily: string | null; last_slot: string | null; updated_by: string | null };

/** Bir kiracının zamanı gelen okumalarını kuyruklar (kiracı bağlamında; RLS). Döner: açılan iş sayısı. */
export async function enqueueTenantErpReads(tx: Tx, tenantId: string, now: Date, resolve: ProviderResolver): Promise<number> {
  const rows = (await tx.query<ScheduleRow>(`SELECT id, feature, provider_kind, schedule_kind, schedule_interval_min, to_char(schedule_daily_at, 'HH24:MI') AS daily,
      last_slot, updated_by FROM integration_endpoints WHERE enabled AND schedule_kind <> 'MANUAL' AND feature = ANY ($1) ORDER BY feature FOR UPDATE SKIP LOCKED`,
    [[...ERP_READ_FEATURES]])).rows;
  let n = 0;
  for (const e of rows) {
    const schedule: ErpSchedule = { mode: e.schedule_kind, intervalMinutes: e.schedule_interval_min ?? undefined, dailyTime: e.daily ?? undefined };
    const due = isDue(schedule, e.last_slot, now);
    if (!due.due) continue;
    // Süren okuma çalışması varsa bu dakika atlanır (yuva işaretlenmez; çalışma bitince aynı yuvada alınır). Yazma çalışmaları
    // (WRITE olay / WRITE_RETRY) okumayı geciktirmez.
    const running = (await tx.query(`SELECT 1 FROM integration_runs WHERE feature = $1 AND status = 'RUNNING' AND trigger <> 'TEST'
      AND coalesce(counts->>'mode', 'READ') = 'READ' AND started_at > now() - interval '30 minutes' LIMIT 1`, [e.feature])).rowCount;
    if (running) continue;
    const provider = resolve(e.provider_kind);
    if (!provider || !e.updated_by) {
      // INTERVAL'de her yuvada değil, İstanbul gününde en fazla bir NOT_CONFIGURED satırı (çalışma listesi şişmesin).
      const today = (await tx.query(`SELECT 1 FROM integration_runs WHERE endpoint_id = $1 AND trigger = 'SCHEDULE' AND status = 'NOT_CONFIGURED'
        AND (started_at AT TIME ZONE 'Europe/Istanbul')::date = ($2::timestamptz AT TIME ZONE 'Europe/Istanbul')::date LIMIT 1`, [e.id, now.toISOString()])).rowCount;
      if (today) { await tx.query(`UPDATE integration_endpoints SET last_slot = $2 WHERE id = $1`, [e.id, due.slot]); continue; }
      await tx.query(`INSERT INTO integration_runs (tenant_id, endpoint_id, feature, trigger, provider_kind, mock, finished_at, status, counts)
        VALUES ($1,$2,$3,'SCHEDULE',NULL,false,now(),'NOT_CONFIGURED',$4)`,
        [tenantId, e.id, e.feature, JSON.stringify({ mode: 'READ', slot: due.slot, reason: provider ? 'no_requester' : 'provider_not_configured', requestSent: false })]);
      await tx.query(`UPDATE integration_endpoints SET last_slot = $2 WHERE id = $1`, [e.id, due.slot]);
      continue;
    }
    const runId = randomUUID();
    const ins = await tx.query(`INSERT INTO jobs (tenant_id, kind, idempotency_key, payload, requested_by) VALUES ($1, $2, $3, $4, $5)
      ON CONFLICT (tenant_id, kind, idempotency_key) DO NOTHING RETURNING id`,
      [tenantId, ERP_READ_JOB, `erp.read:${e.feature}:${tenantId}:${due.slot}`, JSON.stringify({ feature: e.feature, runId }), e.updated_by]);
    await tx.query(`UPDATE integration_endpoints SET last_slot = $2 WHERE id = $1`, [e.id, due.slot]);
    if (!ins.rowCount) continue;
    await tx.query(`INSERT INTO integration_runs (id, tenant_id, endpoint_id, feature, trigger, provider_kind, mock, status, counts, requested_by)
      VALUES ($1,$2,$3,$4,'SCHEDULE',$5,$6,'RUNNING',$7,$8)`,
      [runId, tenantId, e.id, e.feature, provider.kind, !provider.real, JSON.stringify({ mode: 'READ', slot: due.slot }), e.updated_by]);
    n++;
  }
  return n;
}

const systemCtx = (tenantId: string, companyIds: string[], correlationId: string): TenantContext =>
  ({ tenantId, userId: SYSTEM_USER, roles: [], companyIds, departmentIds: [], allDepartments: true, correlationId });

/** Bütün kiracılarda bayat okuma çalışmalarını kapatır (058d dar kiracı kapısı). Döner: kapatılan çalışma sayısı. */
export async function reapAllStaleErpRuns(pool: pg.Pool, now: Date = new Date()): Promise<number> {
  const tenants = await withoutTenant(pool, async (c) => (await c.query<{ id: string }>(`SELECT t AS id FROM erp_stale_run_tenants($1, $2) t`,
    [now.toISOString(), Math.min(ERP_STALE.heartbeatMinutes, ERP_STALE.maxRunMinutes)])).rows);
  let n = 0;
  for (const { id } of tenants) {
    try {
      n += await withTenant(pool, systemCtx(id, [], `erp-reap-${now.toISOString()}`), (tx) => reapStaleErpRuns(tx, id, now));
    } catch (e) {
      console.error('erp stale run reap failed', id, (e as { code?: string })?.code ?? 'error');
    }
  }
  return n;
}

/**
 * İşçide dakikada bir: zamanlanmış (INTERVAL/DAILY) açık okuyan özelliklerin zamanı geldiyse `erp.read` işi + SCHEDULE çalışması
 * (idempotency `erp.read:<feature>:<tenant>:<slot>`; DAILY'de İstanbul günü başına bir). Sağlayıcı yoksa NOT_CONFIGURED, iş yok.
 */
export async function enqueueDueErpReads(pool: pg.Pool, now: Date, config: ErpCfg, resolve: ProviderResolver = (k) => erpProvider(k, config)): Promise<number> {
  // Bayat okuma çalışmaları (işçi çöktü / iş alınmadı) önce kapatılır: dakikalık tıkta, işçi dosyası değişmeden.
  await reapAllStaleErpRuns(pool, now).catch((e) => console.error('erp stale run reap failed', (e as { code?: string })?.code ?? 'error'));
  const tenants = await withoutTenant(pool, async (c) => (await c.query<{ id: string }>(`SELECT t AS id FROM erp_read_schedule_tenants() t`)).rows);
  let n = 0;
  for (const { id } of tenants) {
    try {
      n += await withTenant(pool, systemCtx(id, [], `erp-schedule-${now.toISOString()}`), (tx) => enqueueTenantErpReads(tx, id, now, resolve));
    } catch (e) {
      console.error('erp read enqueue failed', id, (e as { code?: string })?.code ?? (e as Error)?.name ?? 'error');
    }
  }
  return n;
}

// ---------- İşçi giriş noktası ----------

/**
 * `erp.read` işini isteyenin güncel üyeliğiyle çalıştırır (kiracının bütün şirketleri, departman kapsamı yok). İsteyen üyeliğini ya da
 * çalıştırma iznini kaybettiyse istek atılmaz, çalışma FAILED + iş BLOCKED. Beklenmeyen hata da çalışmayı kapatır (RUNNING kalmaz).
 */
export async function runErpReadJob(pool: pg.Pool, job: { id: string; tenant_id: string; requested_by: string | null },
  member: { roles: string[] } | undefined, deps: ErpReadDeps): Promise<void> {
  const base = systemCtx(job.tenant_id, [], `job-${job.id}`);
  const companyIds = await withTenant(pool, base, async (tx) => (await tx.query<{ id: string }>(`SELECT id FROM legal_entities ORDER BY id`)).rows.map((r) => r.id));
  const sys = systemCtx(job.tenant_id, companyIds, `job-${job.id}`);
  const roles = normalizeRoles(member?.roles ?? []);
  if (!member || !job.requested_by || !can(roles, 'integration.endpoint.run')) {
    await withTenant(pool, sys, (tx) => failRunForJob(tx, sys, job.id, 'requester_not_authorized',
      'Çalışmayı isteyen kullanıcının üyeliği ya da çalıştırma izni yok; ERP\'ye istek atılmadı.', 'BLOCKED'));
    return;
  }
  const ctx: TenantContext = { tenantId: job.tenant_id, userId: job.requested_by, roles, companyIds, departmentIds: [], allDepartments: true, correlationId: `job-${job.id}` };
  try {
    await processErpRead(pool, ctx, job.id, deps);
  } catch (e) {
    // İleti yazılmaz (sır içerebilecek sağlayıcı ayrıntısı olmasın); yalnız kod.
    console.error('erp.read failed', job.id, (e as { code?: string })?.code ?? (e as Error)?.name ?? 'error');
    await withTenant(pool, ctx, (tx) => failRunAfterError(tx, ctx, job.id))
      .catch(() => {});
  }
}

// ---------- Okunan veri (web: departman eşleme listesi, sipariş kopyası) ----------

const PROVIDER_TR: Record<ErpProviderKind, string> = { ORACLE_EBS: 'Oracle ERP', TAKLIT: 'Taklit Oracle (gerçek değil)' };

/** ERP masraf merkezleri (Yönetici departmanda seçer; otomatik atama yok). Etkinler önce. */
export async function listErpCostCenters(tx: Tx) {
  const rows = (await tx.query<{ code: string; name: string; active: boolean; provider_kind: ErpProviderKind; synced_at: Date }>(
    `SELECT code, name, active, provider_kind, synced_at FROM erp_cost_centers ORDER BY active DESC, code LIMIT 2000`)).rows;
  return { items: rows.map((r) => ({ code: r.code, name: r.name, active: r.active, activeLabel: r.active ? 'Etkin' : 'Pasif',
    provider: { kind: r.provider_kind, label: PROVIDER_TR[r.provider_kind], real: r.provider_kind === 'ORACLE_EBS' }, syncedAt: r.synced_at.toISOString() })) };
}

/** ERP siparişleri (salt okunur kopya); tedarikçiye göre süzülebilir. */
export async function listErpPurchaseOrders(tx: Tx, f: { supplierId?: string | null } = {}) {
  const rows = (await tx.query<{ id: string; erp_po_id: string; po_no: string; supplier_id: string | null; supplier_name: string | null; erp_supplier_code: string | null;
    contract_ref: string | null; currency: string | null; amount: string | null; order_date: string | null; provider_kind: ErpProviderKind; synced_at: Date }>(
    `SELECT p.id, p.erp_po_id, p.po_no, p.supplier_id, s.legal_name AS supplier_name, p.erp_supplier_code, p.contract_ref, p.currency, p.amount,
       p.order_date::text AS order_date, p.provider_kind, p.synced_at
     FROM erp_purchase_orders p LEFT JOIN suppliers s ON s.id = p.supplier_id
     WHERE ($1::uuid IS NULL OR p.supplier_id = $1) ORDER BY p.order_date DESC NULLS LAST, p.po_no LIMIT 500`, [f.supplierId ?? null])).rows;
  return { items: rows.map((r) => ({ id: r.id, erpPoId: r.erp_po_id, poNo: r.po_no, supplier: r.supplier_id ? { id: r.supplier_id, name: r.supplier_name } : null,
    erpSupplierCode: r.erp_supplier_code, contractRef: r.contract_ref, currency: r.currency, amount: r.amount, orderDate: r.order_date,
    provider: { kind: r.provider_kind, label: PROVIDER_TR[r.provider_kind], real: r.provider_kind === 'ORACLE_EBS' }, syncedAt: r.synced_at.toISOString() })) };
}
