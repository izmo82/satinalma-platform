// v2 Faz 8 (D113) Görev 6: ERP'ye yazan akışlar (2. aşama, kapalı varsayılan) — onaylı tedarikçi (SUPPLIER), satınalma talebi
// (REQUISITION, kazanan seçimi), sözleşme başlığı (CONTRACT_HEADER, Faz 3 zinciri APPROVED).
// Kurallar:
//  * R3: yazma yalnız özellik açık + `write_enabled` iken. Kapalıyken `enqueueErpOutbound` HİÇBİR ŞEY yazmaz (kayıt da iş de açılmaz;
//    elle yol açık kalır) ve sağlayıcı hiç çağrılmaz. Koşul iş işlenirken kısa bir işlemde yeniden denetlenir; yazma bu arada
//    kapatıldıysa istek atılmadan biter.
//  * Ruling 9: ERP çağrısı sırasında veritabanı işlemi/bağlantısı tutulmaz (hazırlık kısa işlem → çağrı → sonuç kısa işlem).
//  * Zaman aşımı "belirsiz"dir (UNKNOWN): kayıt ERP'de oluşmuş olabilir. Daha önce denenmiş (attempts > 0) ya da UNKNOWN kayıtta önce
//    `find` (aynı idempotency anahtarı) sorulur; bulunursa ikinci `write` yapılmaz.
//  * Başarı → SENT + external_ref (bir kez yazılır). SUPPLIER'da ERP kodu kartta boşsa ERP kaynağıyla yazılır; elle girilmiş kod ezilmez.
//  * Hata → FAILED; olay işinde mevcut iş kuyruğu politikasıyla yeniden denenir (attempts/max_attempts, artan bekleme); "Şimdi çalıştır"
//    yeniden denemesi (WRITE_RETRY) tek denemedir ve çalışmayı son işi bitince kapatır (RUNNING kalmaz).
//  * Yük: tedarikçide unvan, VKN, adres, iletişim — banka bilgisi GÖNDERİLMEZ (D93). Tutar decimal string; yuvarlanmaz.
//  * Taklit sağlayıcının sonucu "taklit sağlayıcıyla denendi — gerçek Oracle değil" olarak işaretlenir (mock); gerçek başarı gibi gösterilmez.
import type pg from 'pg';
import {
  ERP_FEATURE_CATALOG, can, missingMappings, normalizeRoles, redactSecrets, type ErpFeature, type FieldMap,
} from '@sp/domain';
import type { Config } from '../config.ts';
import { withoutTenant, withTenant, type TenantContext, type Tx } from '../db.ts';
import { audit } from '../audit.ts';
import { SecretBox, SecretKekMismatch, SecretKeyNotConfigured, SecretOpenFailed, loadEndpointSecret } from '../integrationSecrets.ts';
import { ErpProviderError, ErpTimeout, erpProvider, type ErpProvider, type ErpProviderKind, type ResolvedEndpoint } from '../erp/providers.ts';

export const ERP_WRITE_JOB = 'erp.write';
export const ERP_WRITE_FEATURES = ['SUPPLIER', 'REQUISITION', 'CONTRACT_HEADER'] as const satisfies readonly ErpFeature[];
export type WriteFeature = (typeof ERP_WRITE_FEATURES)[number];
/** Özelliğin yazdığı uygulama kaydı (detay ekranı bu türle sorgular). */
export const ERP_ENTITY_TYPE: Record<WriteFeature, 'SUPPLIER' | 'PROJECT' | 'CONTRACT_FAMILY'> = {
  SUPPLIER: 'SUPPLIER', REQUISITION: 'PROJECT', CONTRACT_HEADER: 'CONTRACT_FAMILY',
};
export const isWriteFeature = (f: unknown): f is WriteFeature => typeof f === 'string' && (ERP_WRITE_FEATURES as readonly string[]).includes(f);

type ErpCfg = Pick<Config, 'env' | 'erp'>;
export type ProviderResolver = (kind: ErpProviderKind) => ErpProvider | null;
export type ErpWriteDeps = { config: ErpCfg; provider?: ProviderResolver };

const SYSTEM_USER = '00000000-0000-0000-0000-000000000000';
const RETRYABLE = ['PENDING', 'FAILED', 'UNKNOWN'];
/** Kısa işlem sınırları (Ruling 9) ve bayat sınırları. YALNIZ TEST değiştirir. */
export const ERP_WRITE_LIMITS = { lockTimeout: '5s', statementTimeout: '30s', staleJobMinutes: 15, staleRetryRunMinutes: 60, inFlightMinutes: 10 };
const MOCK_NOTE = 'taklit sağlayıcıyla denendi — gerçek Oracle değil';

const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n) : s);
const shortTx = async (tx: Tx) => {
  await tx.query(`SET LOCAL lock_timeout = '${ERP_WRITE_LIMITS.lockTimeout}'`);
  await tx.query(`SET LOCAL statement_timeout = '${ERP_WRITE_LIMITS.statementTimeout}'`);
};

// ---------- Kuyruğa alma (olay noktaları) ----------

/**
 * Olay noktasında (kazanan seçildi / sözleşme zinciri APPROVED / tedarikçi onaylandı) çağrılır; çağıranın işleminde çalışır.
 * Özellik kapalı ya da ERP'ye yazma açık değilse (R3) hiçbir şey yazmaz ve null döner (elle yol açık kalır). Açıksa `erp_outbound_records`
 * PENDING + `jobs` `erp.write` (idempotency `erp:<feature>:<entityId>:v<rev>`; aynı olay ikinci kez kayıt açmaz).
 * SUPPLIER'da kartın ERP kodu zaten varsa (ERP'de kayıtlı) yazılmaz.
 */
export async function enqueueErpOutbound(tx: Tx, ctx: TenantContext, feature: WriteFeature, entityType: string, entityId: string,
  opts: { rev?: number } = {}): Promise<{ outboundId: string; created: boolean } | null> {
  if (!isWriteFeature(feature) || ERP_ENTITY_TYPE[feature] !== entityType) throw new Error(`enqueueErpOutbound: ${feature}/${entityType} uyumsuz`);
  const ep = (await tx.query<{ enabled: boolean; write_enabled: boolean }>(`SELECT enabled, write_enabled FROM integration_endpoints WHERE feature = $1`, [feature])).rows[0];
  if (!ep || !ep.enabled || !ep.write_enabled) return null;
  if (feature === 'SUPPLIER') {
    const s = (await tx.query<{ erp_supplier_code: string | null }>(`SELECT erp_supplier_code FROM suppliers WHERE id = $1`, [entityId])).rows[0];
    if (!s || s.erp_supplier_code) return null;
  }
  const rev = opts.rev ?? await revisionOf(tx, feature, entityId);
  const key = `erp:${feature}:${entityId}:v${rev}`;
  const ins = await tx.query<{ id: string }>(`INSERT INTO erp_outbound_records (tenant_id, feature, entity_type, entity_id, idempotency_key, status, created_by)
    VALUES ($1,$2,$3,$4,$5,'PENDING',$6) ON CONFLICT (tenant_id, idempotency_key) DO NOTHING RETURNING id`,
    [ctx.tenantId, feature, entityType, entityId, key, ctx.userId === SYSTEM_USER ? null : ctx.userId]);
  if (!ins.rows[0]) {
    const ex = (await tx.query<{ id: string }>(`SELECT id FROM erp_outbound_records WHERE idempotency_key = $1`, [key])).rows[0]!;
    return { outboundId: ex.id, created: false };
  }
  const outboundId = ins.rows[0].id;
  await tx.query(`INSERT INTO jobs (tenant_id, kind, idempotency_key, payload, requested_by) VALUES ($1,$2,$3,$4,$5)
    ON CONFLICT (tenant_id, kind, idempotency_key) DO NOTHING`,
    [ctx.tenantId, ERP_WRITE_JOB, key, JSON.stringify({ feature, outboundId }), ctx.userId === SYSTEM_USER ? null : ctx.userId]);
  await audit(tx, ctx, 'erp.outbound.queued', entityTypeAudit(entityType), entityId, { feature, outboundId, idempotencyKey: key });
  return { outboundId, created: true };
}

/** "ERP'de zaten kayıtlı" notunun öneki (detay etiketi bunu tanır). */
export const ALREADY_IN_ERP_PREFIX = 'ERP\'de zaten kayıtlı';
/** "Kartta ERP kodu var ama ERP'de doğrulanmadı" notunun öneki (kayıt açık kalır; elle iletilebilir). */
export const CARD_CODE_UNVERIFIED_PREFIX = 'Kartta ERP kodu var';

export type CodeProvenance = { code: string | null; source: 'ERP' | 'MANUAL' | null; mock: boolean | null; verified: boolean; sourceLabel: string | null };
/**
 * Tedarikçi ERP kodunun kökeni. ERP kaynaklı kodun sağlayıcısı, kodu yazan son ERP okuması/yazmasının `supplier.erp_code_set`
 * denetim kaydındaki `mock` bayrağından okunur; kayıt yoksa (eski/tohum veri) köken doğrulanamaz (mock null). Yalnız ERP kaynaklı ve
 * gerçek sağlayıcıdan gelen kod "doğrulanmış" sayılır.
 */
export async function supplierCodeProvenance(tx: Tx, supplierId: string): Promise<CodeProvenance | null> {
  const s = (await tx.query<{ erp_supplier_code: string | null; erp_supplier_code_source: 'ERP' | 'MANUAL' | null }>(
    `SELECT erp_supplier_code, erp_supplier_code_source FROM suppliers WHERE id = $1`, [supplierId])).rows[0];
  if (!s) return null;
  const src = s.erp_supplier_code ? s.erp_supplier_code_source : null;
  let mock: boolean | null = null;
  if (src === 'ERP') {
    const a = (await tx.query<{ mock: string | null }>(`SELECT data->>'mock' AS mock FROM audit_events WHERE entity_type = 'supplier' AND entity_id = $1
      AND action = 'supplier.erp_code_set' AND data->>'source' = 'ERP' AND data->>'to' = $2 ORDER BY id DESC LIMIT 1`, [supplierId, s.erp_supplier_code])).rows[0];
    mock = a?.mock === 'true' ? true : a?.mock === 'false' ? false : null;
  }
  const sourceLabel = !src ? null : src === 'MANUAL' ? 'Elle' : mock === true ? 'ERP (taklit)' : mock === false ? 'ERP' : 'ERP (kaynağı doğrulanamadı)';
  return { code: s.erp_supplier_code, source: src, mock, verified: src === 'ERP' && mock === false, sourceLabel };
}

/**
 * Olay noktası için güvenli sarmalayıcı: kuyruğa alma SAVEPOINT içinde çalışır; veritabanı hatasında yalnız bu kısım geri alınır ve
 * günlüğe kod yazılır — iş akışı (kazanan seçimi, zincir onayı, tedarikçi onayı) hiçbir zaman ERP kuyruğu yüzünden geri alınmaz.
 */
export async function enqueueErpOutboundSafe(tx: Tx, ctx: TenantContext, feature: WriteFeature, entityType: string, entityId: string) {
  await tx.query('SAVEPOINT erp_outbound_enqueue');
  try {
    const r = await enqueueErpOutbound(tx, ctx, feature, entityType, entityId);
    await tx.query('RELEASE SAVEPOINT erp_outbound_enqueue');
    return r;
  } catch (e) {
    await tx.query('ROLLBACK TO SAVEPOINT erp_outbound_enqueue');
    console.error('erp outbound enqueue failed', feature, entityId, (e as { code?: string })?.code ?? (e as Error)?.name ?? 'error');
    return null;
  }
}

const entityTypeAudit = (t: string) => (t === 'PROJECT' ? 'project' : t === 'CONTRACT_FAMILY' ? 'contract_family' : 'supplier');

/** Sürüm: sözleşmede onaylı zincir sayısı (yeni sürüm yeniden onaylanınca yeni başlık), talepte onaylı seçim sayısı, tedarikçide 1. */
async function revisionOf(tx: Tx, feature: WriteFeature, entityId: string): Promise<number> {
  if (feature === 'CONTRACT_HEADER') {
    return Math.max(1, (await tx.query<{ n: number }>(`SELECT count(*)::int AS n FROM contract_approval_chains WHERE family_id = $1 AND outcome = 'APPROVED'`, [entityId])).rows[0]!.n);
  }
  if (feature === 'REQUISITION') {
    return Math.max(1, (await tx.query<{ n: number }>(`SELECT count(*)::int AS n FROM awards WHERE project_id = $1 AND status = 'APPROVED'`, [entityId])).rows[0]!.n);
  }
  return 1;
}

// ---------- Yük kuruluşu ----------

type Built = { ok: true; values: Record<string, string | null>; recordKey: string } | { ok: false; code: string; message: string; skip?: boolean; existingRef?: string };

/** Uygulama alanları (katalog anahtarları). Banka bilgisi hiçbir yükte yoktur (D93). */
export async function buildPayload(tx: Tx, feature: WriteFeature, entityId: string): Promise<Built> {
  if (feature === 'SUPPLIER') {
    const s = (await tx.query<{ legal_name: string; tax_id: string | null; address: string | null; contact_name: string | null; contact_email: string | null;
      contact_phone: string | null; erp_supplier_code: string | null; status: string }>(
      `SELECT legal_name, tax_id, address, contact_name, contact_email, contact_phone, erp_supplier_code, status FROM suppliers WHERE id = $1`, [entityId])).rows[0];
    if (!s) return { ok: false, code: 'entity_not_found', message: 'Tedarikçi bulunamadı; ERP\'ye istek atılmadı.' };
    if (s.erp_supplier_code) {
      const pv = (await supplierCodeProvenance(tx, entityId))!;
      // Yalnız gerçek ERP'den gelmiş kod "ERP'de zaten kayıtlı" sayılır (SENT); elle, taklit ya da kökeni doğrulanamayan kodda kayıt açık kalır.
      if (pv.verified) {
        return { ok: false, skip: true, existingRef: s.erp_supplier_code, code: 'supplier_already_in_erp',
          message: `${ALREADY_IN_ERP_PREFIX} (ERP kodu ${s.erp_supplier_code}); yeni tedarikçi yazılmadı.` };
      }
      const how = pv.source === 'MANUAL' ? 'elle girilmiş' : pv.mock ? 'taklit sağlayıcıdan (gerçek değil)' : 'kaynağı doğrulanamadı';
      return { ok: false, skip: true, code: 'supplier_code_unverified',
        message: `${CARD_CODE_UNVERIFIED_PREFIX} (${s.erp_supplier_code}; ${how}; ERP'de doğrulanmadı); ERP'ye yeni tedarikçi yazılmadı. Gerekirse "ERP'ye elle iletildi" kaydedin.` };
    }
    return { ok: true, recordKey: s.tax_id ?? entityId, values: { taxId: s.tax_id, legalName: s.legal_name, address: s.address, contactName: s.contact_name,
      contactEmail: s.contact_email, contactPhone: s.contact_phone, erpSupplierCode: null } };
  }
  if (feature === 'REQUISITION') {
    const p = (await tx.query<{ code: string; title: string; currency: string; cost_center_code: string | null }>(
      `SELECT p.code, p.title, p.currency, d.cost_center_code FROM projects p LEFT JOIN departments d ON d.id = p.department_id WHERE p.id = $1`, [entityId])).rows[0];
    if (!p) return { ok: false, code: 'entity_not_found', message: 'Proje bulunamadı; ERP\'ye istek atılmadı.' };
    const a = (await tx.query<{ id: string; total: string }>(`SELECT id, total::text FROM awards WHERE project_id = $1 AND status = 'APPROVED' ORDER BY decided_at DESC NULLS LAST, version_no DESC LIMIT 1`,
      [entityId])).rows[0];
    if (!a) return { ok: false, code: 'award_not_found', message: 'Projede onaylı kazanan seçimi yok; ERP\'ye istek atılmadı.' };
    const codes = (await tx.query<{ code: string | null }>(`SELECT DISTINCT s.erp_supplier_code AS code FROM award_lines l JOIN suppliers s ON s.id = l.supplier_id
      WHERE l.award_id = $1 ORDER BY 1`, [a.id])).rows.map((r) => r.code);
    return { ok: true, recordKey: p.code, values: { projectNo: p.code, description: p.title, amount: a.total, currency: p.currency.trim(), costCenter: p.cost_center_code,
      supplierErpCode: codes.length && codes.every((c) => c) ? codes.join(',') : null } };
  }
  const f = (await tx.query<{ code: string; title: string; contract_no: string | null; tax_id: string | null; erp_supplier_code: string | null; project_code: string | null;
    currency: string | null; value_type: string | null; amount: string | null; start_date: string | null; end_date: string | null }>(
    `SELECT f.code, f.title, f.contract_no, s.tax_id, s.erp_supplier_code, p.code AS project_code, t.currency, t.value_type, t.amount::text, t.start_date::text, t.end_date::text
     FROM contract_families f
     LEFT JOIN suppliers s ON s.id = f.supplier_id
     LEFT JOIN projects p ON p.id = f.project_id
     LEFT JOIN LATERAL (SELECT c.terms_id FROM contract_approval_chains c WHERE c.family_id = f.id AND c.outcome = 'APPROVED' ORDER BY c.closed_at DESC LIMIT 1) c ON true
     LEFT JOIN contract_terms t ON t.id = c.terms_id
     WHERE f.id = $1`, [entityId])).rows[0];
  if (!f) return { ok: false, code: 'entity_not_found', message: 'Sözleşme bulunamadı; ERP\'ye istek atılmadı.' };
  return { ok: true, recordKey: f.code, values: { contractNo: f.code, title: f.title, supplierTaxId: f.tax_id, supplierErpCode: f.erp_supplier_code, projectNo: f.project_code,
    startDate: f.start_date, endDate: f.end_date, amount: f.value_type === 'UNPRICED' ? null : f.amount, currency: f.currency?.trim() ?? null } };
}

const DECIMAL_RE = /^-?\d+(\.\d{1,4})?$/;
const YMD_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Uygulama alanlarını eşlemedeki ERP alan yollarına çevirir; yalnız eşlenmiş ve dolu alanlar gönderilir. Zorunlu alan boşsa istek atılmaz. */
export function toErpPayload(feature: WriteFeature, map: FieldMap, values: Record<string, string | null>): { payload: Record<string, string | null> } | { missing: string[]; invalid: string[] } {
  const payload: Record<string, string | null> = {};
  const missing: string[] = [];
  const invalid: string[] = [];
  for (const f of ERP_FEATURE_CATALOG[feature].appFields) {
    const entry = map[f.key];
    let v = values[f.key] ?? null;
    if (v !== null && typeof v === 'string') v = v.trim() === '' ? null : v;
    // SUPPLIER'da ERP kodu ERP'nin verdiği değerdir (okuma alanı); yazmada zorunlu sayılmaz.
    const required = f.required && !(feature === 'SUPPLIER' && f.key === 'erpSupplierCode');
    if (v === null) { if (required) missing.push(f.key); continue; }
    if (!entry) continue;
    if (f.type === 'money' && !DECIMAL_RE.test(v)) { invalid.push(f.key); continue; }
    if (f.type === 'date' && !YMD_RE.test(v)) { invalid.push(f.key); continue; }
    payload[entry.path] = entry.transform === 'UPPER' ? v.trim().toUpperCase() : entry.transform === 'TRIM' ? v.trim() : v;
  }
  return missing.length || invalid.length ? { missing, invalid } : { payload };
}

// ---------- İşçi işi ----------

type OutboundRow = { id: string; feature: WriteFeature; entity_type: string; entity_id: string; idempotency_key: string; status: string; attempts: number;
  external_ref: string | null };
type JobRow = { payload: { feature?: unknown; outboundId?: unknown; runId?: unknown }; status: string; attempts: number; max_attempts: number; requested_by: string | null };
type Outcome = 'sent' | 'failed' | 'unknown' | 'skipped';
type Note = { code: string; message: string };

type Prepared =
  | { kind: 'done'; result: WriteResult }
  | { kind: 'go'; jobId: string; job: JobRow; rec: OutboundRow; runId: string | null; eventRunId: string | null; provider: ErpProvider; resolved: ResolvedEndpoint;
      payload: Record<string, string | null>; needFind: boolean; secrets: string[]; recordKey: string; endpointId: string };
export type WriteResult = { outboundId: string | null; status: string; outcome: Outcome | 'deferred' | 'refused' | 'invalid'; externalRef?: string | null; viaFind?: boolean;
  requestSent: boolean };

/** Çalışma hatası satırı (sırdan arındırılmış ileti ≤500). */
async function addRunError(tx: Tx, ctx: TenantContext, runId: string, recordKey: string | null, code: string, message: string, secrets: string[] = []) {
  const safe = /^[A-Za-z0-9_.:-]{1,80}$/.test(code) ? code : 'error';
  await tx.query(`INSERT INTO integration_run_errors (tenant_id, run_id, record_key, code, message) VALUES ($1,$2,$3,$4,$5)`,
    [ctx.tenantId, runId, recordKey ? clip(recordKey, 200) : null, safe, redactSecrets(message, secrets).slice(0, 500)]);
}

/**
 * "Şimdi çalıştır" (WRITE_RETRY) çalışmasına bu işin sonucunu ekler; çalışmanın etkin (QUEUED/RUNNING) başka işi kalmadıysa çalışmayı kapatır:
 * hepsi gönderildi/atlandı → SUCCESS, hiçbiri gönderilmedi → FAILED, karışık → PARTIAL. Çalışma satırı kilitlenir (eşzamanlı işler sıralanır).
 */
export async function accountRetryRun(tx: Tx, ctx: TenantContext, runId: string, jobId: string | null, outcome: Outcome | null, err?: Note & { recordKey?: string | null },
  requestSent = false) {
  const run = (await tx.query<{ status: string; counts: Record<string, unknown> }>(`SELECT status, counts FROM integration_runs WHERE id = $1 FOR UPDATE`, [runId])).rows[0];
  if (!run || run.status !== 'RUNNING') return false;
  if (err) await addRunError(tx, ctx, runId, err.recordKey ?? null, err.code, err.message);
  const c = run.counts ?? {};
  const n = (k: string) => (typeof c[k] === 'number' ? (c[k] as number) : 0);
  const next = { sent: n('sent'), failed: n('failed'), unknown: n('unknown'), skipped: n('skipped') };
  if (outcome) next[outcome]++;
  const active = (await tx.query<{ n: number }>(`SELECT count(*)::int AS n FROM jobs WHERE kind = $1 AND payload->>'runId' = $2 AND status IN ('QUEUED','RUNNING')
    AND ($3::uuid IS NULL OR id <> $3)`, [ERP_WRITE_JOB, runId, jobId])).rows[0]!.n;
  const patch: Record<string, unknown> = { ...next, requestSent: requestSent || c.requestSent === true, heartbeatAt: new Date().toISOString() };
  if (active > 0) {
    await tx.query(`UPDATE integration_runs SET counts = counts || $2::jsonb WHERE id = $1`, [runId, JSON.stringify(patch)]);
    return false;
  }
  const queued = n('queued');
  const done = next.sent + next.failed + next.unknown + next.skipped;
  const missing = Math.max(0, queued - done);
  const bad = next.failed + next.unknown + missing;
  const status = bad === 0 ? 'SUCCESS' : next.sent + next.skipped === 0 ? 'FAILED' : 'PARTIAL';
  await tx.query(`UPDATE integration_runs SET status = $2, finished_at = now(), counts = counts || $3::jsonb WHERE id = $1 AND status = 'RUNNING'`,
    [runId, status, JSON.stringify({ ...patch, ...(missing ? { notProcessed: missing } : {}) })]);
  return true;
}

/** İşi bitirir: başarı/atlama SUCCEEDED; hata ya da belirsizlikte olay işi kuyruk politikasıyla yeniden kuyruğa (son denemede DEAD); yeniden deneme işi tek denemedir (FAILED). */
async function finishJob(tx: Tx, jobId: string, job: JobRow, runId: string | null, outcome: Outcome, result: Record<string, unknown>, errorCode: string | null,
  terminal = false) {
  if (outcome === 'sent' || outcome === 'skipped') {
    await tx.query(`UPDATE jobs SET status = 'SUCCEEDED', result = $2, error_code = NULL, updated_at = now() WHERE id = $1`, [jobId, JSON.stringify(result)]);
  } else if (runId || terminal) {
    await tx.query(`UPDATE jobs SET status = 'FAILED', result = $2, error_code = $3, updated_at = now() WHERE id = $1`, [jobId, JSON.stringify(result), errorCode]);
  } else {
    await tx.query(`UPDATE jobs SET status = CASE WHEN attempts >= max_attempts THEN 'DEAD' ELSE 'QUEUED' END, run_after = now() + (attempts * interval '30 seconds'),
      result = $2, error_code = $3, updated_at = now() WHERE id = $1`, [jobId, JSON.stringify(result), errorCode]);
  }
}

/** 1. kısa işlem: iş, kayıt, R3 koşulu, sağlayıcı, eşleme, sır ve yük. Koşul yoksa istek atılmadan biter. */
async function prepareWrite(tx: Tx, ctx: TenantContext, jobId: string, deps: ErpWriteDeps): Promise<Prepared> {
  const resolve: ProviderResolver = deps.provider ?? ((k) => erpProvider(k, deps.config));
  await shortTx(tx);
  const job = (await tx.query<JobRow>(`SELECT payload, status, attempts, max_attempts, requested_by FROM jobs WHERE id = $1 FOR UPDATE`, [jobId])).rows[0];
  if (!job) return { kind: 'done', result: { outboundId: null, status: 'SKIPPED', outcome: 'invalid', requestSent: false } };
  const feature = job.payload?.feature;
  const outboundId = typeof job.payload?.outboundId === 'string' ? job.payload.outboundId : null;
  const runId = typeof job.payload?.runId === 'string' ? job.payload.runId : null;
  const invalid = async (code: string) => {
    await tx.query(`UPDATE jobs SET status = 'FAILED', error_code = $2, updated_at = now() WHERE id = $1`, [jobId, code]);
    if (runId) await accountRetryRun(tx, ctx, runId, jobId, 'failed', { code: code.toLowerCase(), message: 'Yazma işi geçersiz; ERP\'ye istek atılmadı.' });
    return { kind: 'done' as const, result: { outboundId, status: 'FAILED', outcome: 'invalid' as const, requestSent: false } };
  };
  if (!isWriteFeature(feature) || !outboundId) return invalid('INVALID_PAYLOAD');
  const rec = (await tx.query<OutboundRow>(`SELECT id, feature, entity_type, entity_id, idempotency_key, status, attempts, external_ref FROM erp_outbound_records
    WHERE id = $1 AND feature = $2 FOR UPDATE`, [outboundId, feature])).rows[0];
  if (!rec) return invalid('OUTBOUND_NOT_FOUND');
  if (!RETRYABLE.includes(rec.status)) {
    // Kayıt bu arada gönderildi ya da elle iletildi: istek atılmaz.
    await finishJob(tx, jobId, job, runId, 'skipped', { outboundId, skipped: 'not_pending', status: rec.status }, null);
    if (runId) await accountRetryRun(tx, ctx, runId, jobId, 'skipped');
    return { kind: 'done', result: { outboundId, status: rec.status, outcome: 'skipped', requestSent: false } };
  }
  // Aynı kayıt için başka işçi şu an çağrı yapıyorsa bu iş ertelenir (aynı kayda eşzamanlı iki istek atılmaz).
  const inFlight = (await tx.query(`SELECT 1 FROM jobs WHERE kind = $1 AND status = 'RUNNING' AND payload->>'outboundId' = $2 AND id <> $3
    AND updated_at > now() - make_interval(mins => $4) LIMIT 1`, [ERP_WRITE_JOB, outboundId, jobId, ERP_WRITE_LIMITS.inFlightMinutes])).rowCount;
  if (inFlight) {
    await tx.query(`UPDATE jobs SET status = 'QUEUED', attempts = greatest(attempts - 1, 0), run_after = now() + interval '60 seconds', updated_at = now() WHERE id = $1`, [jobId]);
    return { kind: 'done', result: { outboundId, status: rec.status, outcome: 'deferred', requestSent: false } };
  }

  const ep = (await tx.query<{ id: string; enabled: boolean; write_enabled: boolean; provider_kind: ErpProviderKind; base_url: string | null; resource_path: string | null;
    auth_type: ResolvedEndpoint['authType'] | null; username: string | null; client_id: string | null; token_url: string | null; field_map: FieldMap; timeout_ms: number }>(
    `SELECT id, enabled, write_enabled, provider_kind, base_url, resource_path, auth_type, username, client_id, token_url, field_map, timeout_ms
     FROM integration_endpoints WHERE feature = $1`, [feature])).rows[0];
  const refuse = async (code: string, message: string, opts: { skip?: boolean; existingRef?: string; providerKind?: ErpProviderKind } = {}): Promise<Prepared> => {
    if (opts.skip && opts.existingRef && opts.providerKind) {
      // Kayıt ERP'de zaten var (ör. tedarikçi kodu okumayla geldi): son durum SENT + mevcut ERP referansı, not last_error'da (istek atılmadı).
      // FAILED gösterilmez ve WRITE_RETRY tarafından yeniden denenmez.
      await tx.query(`UPDATE erp_outbound_records SET status = 'SENT', provider_kind = $3, external_ref = coalesce(external_ref, $4), last_error = $2, updated_at = now()
        WHERE id = $1`, [outboundId, clip(message, 500), opts.providerKind, clip(opts.existingRef, 120)]);
    } else {
      // Atlanan (doğrulanmamış kod) kayıt durumunu korur: açık kalır, elle iletilebilir; istek atılmaz.
      await tx.query(`UPDATE erp_outbound_records SET last_error = $2, updated_at = now() WHERE id = $1`, [outboundId, clip(message, 500)]);
    }
    if (opts.skip) await finishJob(tx, jobId, job, runId, 'skipped', { outboundId, refused: code, requestSent: false }, null);
    else await tx.query(`UPDATE jobs SET status = 'FAILED', error_code = $2, result = $3, updated_at = now() WHERE id = $1`,
      [jobId, clip(code.toUpperCase(), 80), JSON.stringify({ outboundId, refused: code, requestSent: false })]);
    if (runId) await accountRetryRun(tx, ctx, runId, jobId, opts.skip ? 'skipped' : 'failed', { code, message, recordKey: rec.entity_id });
    await audit(tx, ctx, opts.skip ? 'erp.outbound.skipped' : 'erp.outbound.refused', entityTypeAudit(rec.entity_type), rec.entity_id,
      { feature, outboundId, reason: code, requestSent: false, ...(opts.existingRef ? { externalRef: opts.existingRef } : {}) });
    return { kind: 'done', result: { outboundId, status: opts.skip && opts.existingRef ? 'SENT' : rec.status, outcome: opts.skip ? 'skipped' : 'refused', requestSent: false } };
  };
  if (!ep || !ep.enabled) return refuse('feature_disabled', 'Özellik kapalı; ERP\'ye istek atılmadı. Elle iletebilirsiniz.');
  if (!ep.write_enabled) return refuse('write_not_enabled', 'ERP\'ye yazma kapalı (R3); istek atılmadı. Elle iletebilirsiniz.');
  if (!ep.base_url || !ep.resource_path || !ep.auth_type) return refuse('endpoint_not_configured', 'Bağlantı ayarları eksik; ERP\'ye istek atılmadı.');
  const provider = resolve(ep.provider_kind);
  if (!provider) return refuse('provider_not_configured', 'Bu ortamda ERP sağlayıcısı yapılandırılmadı; istek atılmadı.');
  if (runId) {
    const run = (await tx.query<{ provider_kind: string | null }>(`SELECT provider_kind FROM integration_runs WHERE id = $1`, [runId])).rows[0];
    if (run && run.provider_kind !== provider.kind) return refuse('provider_changed', 'Sağlayıcı türü çalışma istendikten sonra değişti; istek atılmadı.');
  }
  const missing = missingMappings(feature, ep.field_map ?? {});
  if (missing.length) return refuse('mapping_incomplete', `Zorunlu alan eşlenmemiş (${missing.join(', ')}); istek atılmadı.`);
  const built = await buildPayload(tx, feature, rec.entity_id);
  if (!built.ok) return refuse(built.code, built.message, { skip: built.skip, existingRef: built.existingRef, providerKind: provider.kind });
  const mapped = toErpPayload(feature, ep.field_map ?? {}, built.values);
  if (!('payload' in mapped)) {
    const parts = [...mapped.missing.map((k) => `${k} boş`), ...mapped.invalid.map((k) => `${k} biçimi geçersiz`)];
    return refuse('required_missing', `Yük eksik ya da geçersiz (${parts.join(', ')}); istek atılmadı. Kaydı tamamlayın ya da elle iletin.`);
  }
  let secret: string | null;
  try {
    secret = await loadEndpointSecret(tx, ep.id, new SecretBox(deps.config.erp?.secretKey ?? null));
  } catch (e) {
    if (e instanceof SecretKekMismatch) return refuse('secret_needs_reentry', 'Sır yeniden girilmeli (anahtar değişti); istek atılmadı.');
    if (e instanceof SecretKeyNotConfigured) return refuse('secret_key_not_configured', 'Sır şifreleme anahtarı yapılandırılmadı; istek atılmadı.');
    if (e instanceof SecretOpenFailed) return refuse('secret_unreadable', 'Kayıtlı sır açılamadı; sırrı yeniden girin. İstek atılmadı.');
    throw e;
  }
  const needFind = rec.status === 'UNKNOWN' || rec.attempts > 0;
  // Deneme sayılır: bu işlem commit olduktan sonra çökme olursa sonraki deneme önce ERP'de arar (ikinci kayıt açılmaz).
  await tx.query(`UPDATE erp_outbound_records SET attempts = attempts + 1, updated_at = now() WHERE id = $1`, [outboundId]);
  let eventRunId: string | null = null;
  if (!runId) {
    eventRunId = (await tx.query<{ id: string }>(`INSERT INTO integration_runs (tenant_id, endpoint_id, feature, trigger, provider_kind, mock, status, counts, requested_by)
      VALUES ($1,$2,$3,'EVENT',$4,$5,'RUNNING',$6,$7) RETURNING id`,
      [ctx.tenantId, ep.id, feature, provider.kind, !provider.real, JSON.stringify({ mode: 'WRITE', outboundId, heartbeatAt: new Date().toISOString() }), job.requested_by])).rows[0]!.id;
  }
  return {
    kind: 'go', jobId, job, rec, runId, eventRunId, provider, payload: mapped.payload, needFind, secrets: secret ? [secret] : [], recordKey: built.recordKey, endpointId: ep.id,
    resolved: { id: ep.id, tenantId: ctx.tenantId, feature, baseUrl: ep.base_url, resourcePath: ep.resource_path, authType: ep.auth_type, username: ep.username,
      clientId: ep.client_id, tokenUrl: ep.token_url, secret, timeoutMs: ep.timeout_ms },
  };
}

type CallResult = { outcome: 'sent'; externalRef: string; viaFind: boolean; writeCalled: boolean } | { outcome: 'unknown' | 'failed'; note: Note; requestSent: boolean }
  | { outcome: 'refused'; note: Note; requestSent: boolean };

function providerFailure(e: unknown, op: 'find' | 'write'): { outcome: 'unknown' | 'failed'; note: Note } {
  if (e instanceof ErpTimeout) {
    return { outcome: 'unknown', note: { code: 'timeout', message: op === 'write'
      ? 'ERP yanıt vermedi (zaman aşımı); kaydın oluşup oluşmadığı belirsiz. Yeniden denemede önce ERP\'de aranır, ikinci kayıt açılmaz.'
      : 'ERP\'de arama zaman aşımına uğradı; kayıt yazılmadı (belirsiz). Yeniden denemede önce ERP\'de aranır.' } };
  }
  if (e instanceof ErpProviderError) {
    const code = /^[A-Za-z0-9_.:-]{1,80}$/.test(e.code) ? e.code : 'write_failed';
    // Arama belirsizse (ör. birden çok kayıt) yazılmaz: belirsiz kalır.
    if (op === 'find') return { outcome: 'unknown', note: { code, message: `ERP'de arama başarısız oldu (kod ${code}); ikinci kayıt açılmasın diye yazılmadı.` } };
    return { outcome: 'failed', note: { code, message: code === 'http_401' ? 'ERP kimlik doğrulamayı reddetti (HTTP 401); kayıt yazılmadı.' : `ERP'ye yazma başarısız oldu (kod ${code}).` } };
  }
  return { outcome: op === 'find' ? 'unknown' : 'failed', note: { code: 'write_failed', message: 'ERP çağrısı beklenmeyen bir hatayla bitti.' } };
}

/** Çağrı: veritabanı bağlantısı tutulmadan. Önce (gerekirse) `find`; bulunmazsa R3 yeniden denetlenir ve `write`. */
async function callProvider(pool: pg.Pool, ctx: TenantContext, p: Extract<Prepared, { kind: 'go' }>): Promise<CallResult> {
  const feature = p.rec.feature;
  let requestSent = false;
  try {
    if (p.needFind) {
      requestSent = true;
      try {
        const found = await p.provider.find(p.resolved, feature, p.rec.idempotency_key);
        if (found?.externalRef) return { outcome: 'sent', externalRef: found.externalRef, viaFind: true, writeCalled: false };
      } catch (e) {
        return { ...providerFailure(e, 'find'), requestSent };
      }
      // Arama süresince yazma kapatıldıysa yazılmaz (R3 işlem anında).
      const still = await withTenant(pool, ctx, async (tx) => {
        await shortTx(tx);
        return (await tx.query<{ ok: boolean }>(`SELECT (enabled AND write_enabled) AS ok FROM integration_endpoints WHERE feature = $1`, [feature])).rows[0]?.ok === true;
      });
      if (!still) return { outcome: 'refused', note: { code: 'write_not_enabled', message: 'ERP\'ye yazma çalışma sırasında kapatıldı; kayıt yazılmadı.' }, requestSent };
    }
    requestSent = true;
    try {
      const r = await p.provider.write(p.resolved, feature, p.payload, p.rec.idempotency_key);
      if (!r?.externalRef || typeof r.externalRef !== 'string') return { outcome: 'unknown', note: { code: 'no_reference', message: 'ERP yanıtında kayıt referansı yok; durum belirsiz.' }, requestSent };
      return { outcome: 'sent', externalRef: r.externalRef, viaFind: false, writeCalled: true };
    } catch (e) {
      return { ...providerFailure(e, 'write'), requestSent };
    }
  } finally {
    p.resolved.secret = null;
  }
}

const STATUS_FOR: Record<'sent' | 'unknown' | 'failed', string> = { sent: 'SENT', unknown: 'UNKNOWN', failed: 'FAILED' };

/** 3. kısa işlem: sonucu yazar (kayıt, tedarikçi kodu, iş, çalışma, denetim). */
async function recordWrite(tx: Tx, ctx: TenantContext, p: Extract<Prepared, { kind: 'go' }>, r: CallResult): Promise<WriteResult> {
  await shortTx(tx);
  const { rec, provider, runId, eventRunId, jobId, job } = p;
  const mock = !provider.real;
  const cur = (await tx.query<{ status: string; external_ref: string | null }>(`SELECT status, external_ref FROM erp_outbound_records WHERE id = $1 FOR UPDATE`, [rec.id])).rows[0]!;
  const notes: Note[] = [];
  let outcome: Outcome;
  let status = cur.status;
  if (r.outcome === 'refused') {
    outcome = 'failed';
    if (RETRYABLE.includes(cur.status)) await tx.query(`UPDATE erp_outbound_records SET last_error = $2, updated_at = now() WHERE id = $1`, [rec.id, r.note.message]);
  } else if (!RETRYABLE.includes(cur.status)) {
    // Çağrı sürerken kayıt elle iletildi ya da başka yoldan gönderildi: üzerine yazılmaz (MANUAL/CONFIRMED değişmez).
    outcome = 'skipped';
    notes.push({ code: 'record_closed_elsewhere', message: `Kayıt çağrı sürerken başka yoldan kapandı (${cur.status}); sonuç yazılmadı.`
      + (r.outcome === 'sent' ? ` ERP'nin döndürdüğü referans: ${clip(r.externalRef.trim(), 120)}${r.viaFind ? ' (aramayla bulundu)' : ''}.` : '') });
  } else if (r.outcome === 'sent') {
    outcome = 'sent';
    status = 'SENT';
    await tx.query(`UPDATE erp_outbound_records SET status = 'SENT', provider_kind = $2, external_ref = coalesce(external_ref, $3), last_error = NULL, updated_at = now() WHERE id = $1`,
      [rec.id, provider.kind, clip(r.externalRef.trim(), 120)]);
    if (rec.feature === 'SUPPLIER') notes.push(...await writeSupplierCode(tx, ctx, rec.entity_id, clip(r.externalRef.trim(), 60), mock, rec.id));
  } else {
    outcome = r.outcome;
    status = STATUS_FOR[r.outcome];
    await tx.query(`UPDATE erp_outbound_records SET status = $2, provider_kind = coalesce(provider_kind, $3), last_error = $4, updated_at = now() WHERE id = $1`,
      [rec.id, status, provider.kind, clip(r.note.message, 500)]);
  }
  const requestSent = r.outcome === 'sent' ? true : r.requestSent;
  const errNote = r.outcome === 'sent' ? null : r.outcome === 'refused' ? r.note : outcome === 'skipped' ? notes[0]! : r.note;
  const result = { outboundId: rec.id, outcome, status, externalRef: r.outcome === 'sent' ? r.externalRef : null, viaFind: r.outcome === 'sent' ? r.viaFind : false,
    requestSent, mock, providerKind: provider.kind };
  // Çalışma sırasında yazma kapatıldıysa (refused) iş yeniden kuyruğa alınmaz.
  await finishJob(tx, jobId, job, runId, outcome, result, errNote && outcome !== 'skipped' ? clip(errNote.code.toUpperCase(), 80) : null, r.outcome === 'refused');
  if (runId) await accountRetryRun(tx, ctx, runId, jobId, outcome, errNote ? { ...errNote, recordKey: p.recordKey } : undefined, requestSent);
  if (eventRunId) {
    const st = outcome === 'sent' || outcome === 'skipped' ? 'SUCCESS' : 'FAILED';
    if (errNote) await addRunError(tx, ctx, eventRunId, p.recordKey, errNote.code, errNote.message, p.secrets);
    for (const n of notes.slice(outcome === 'skipped' ? 1 : 0)) await addRunError(tx, ctx, eventRunId, p.recordKey, n.code, n.message, p.secrets);
    await tx.query(`UPDATE integration_runs SET status = $2, finished_at = now(), counts = counts || $3::jsonb WHERE id = $1 AND status = 'RUNNING'`,
      [eventRunId, st, JSON.stringify({ sent: outcome === 'sent' ? 1 : 0, failed: outcome === 'failed' ? 1 : 0, unknown: outcome === 'unknown' ? 1 : 0,
        skipped: outcome === 'skipped' ? 1 : 0, requestSent, viaFind: result.viaFind })]);
  } else if (runId && notes.length && outcome === 'sent') {
    for (const n of notes) await addRunError(tx, ctx, runId, p.recordKey, n.code, n.message, p.secrets);
  }
  await audit(tx, ctx, `erp.outbound.${outcome}`, entityTypeAudit(rec.entity_type), rec.entity_id, {
    feature: rec.feature, outboundId: rec.id, status, providerKind: provider.kind, mock, externalRef: result.externalRef, viaFind: result.viaFind, requestSent,
    attempt: rec.attempts + 1, code: errNote?.code ?? null, runId: runId ?? eventRunId,
  });
  return { outboundId: rec.id, status, outcome, externalRef: result.externalRef, viaFind: result.viaFind, requestSent };
}

/** SUPPLIER başarısında ERP kodu kartta boşsa ERP kaynağıyla yazılır; elle girilmiş ya da farklı kod ezilmez, aynı kod ikinci karta yazılmaz. */
async function writeSupplierCode(tx: Tx, ctx: TenantContext, supplierId: string, code: string, mock: boolean, outboundId: string): Promise<Note[]> {
  const s = (await tx.query<{ erp_supplier_code: string | null; erp_supplier_code_source: string | null }>(
    `SELECT erp_supplier_code, erp_supplier_code_source FROM suppliers WHERE id = $1 FOR UPDATE`, [supplierId])).rows[0];
  if (!s) return [];
  if (s.erp_supplier_code) {
    if (s.erp_supplier_code === code) return [];
    return [{ code: s.erp_supplier_code_source === 'MANUAL' ? 'CONFLICT_MANUAL' : 'erp_code_differs',
      message: `${s.erp_supplier_code_source === 'MANUAL' ? 'Elle girilen değerle çelişiyor' : 'Kartta başka ERP kodu var'}: kartta ${s.erp_supplier_code} korundu; ERP'nin verdiği kod ${code}.` }];
  }
  const other = (await tx.query(`SELECT 1 FROM suppliers WHERE erp_supplier_code = $1 AND id <> $2 LIMIT 1`, [code, supplierId])).rowCount;
  if (other) return [{ code: 'supplier_code_duplicate', message: `ERP tedarikçi kodu ${code} başka bir tedarikçi kartında kayıtlı; bu karta yazılmadı.` }];
  await tx.query(`UPDATE suppliers SET erp_supplier_code = $2, erp_supplier_code_source = 'ERP' WHERE id = $1`, [supplierId, code]);
  await audit(tx, ctx, 'supplier.erp_code_set', 'supplier', supplierId, { from: null, to: code, source: 'ERP', outboundId, mock });
  return [];
}

/**
 * `erp.write` işini işler (Ruling 9): kısa hazırlık işlemi (R3 yeniden denetimi) → bağlantı tutulmadan ERP çağrısı (gerekirse önce `find`)
 * → sonuç kısa işlemde. Hazırlıktan sonra beklenmeyen hata olursa çalışma ve iş yine kapanır (RUNNING kalmaz).
 */
export async function processErpWrite(pool: pg.Pool, ctx: TenantContext, jobId: string, deps: ErpWriteDeps): Promise<WriteResult> {
  const p = await withTenant(pool, ctx, (tx) => prepareWrite(tx, ctx, jobId, deps));
  if (p.kind === 'done') return p.result;
  let r: CallResult;
  try {
    r = await callProvider(pool, ctx, p);
  } catch {
    r = { outcome: 'unknown', note: { code: 'write_failed', message: 'ERP çağrısı beklenmeyen bir hatayla bitti; durum belirsiz. Yeniden denemede önce ERP\'de aranır.' }, requestSent: true };
  }
  try {
    return await withTenant(pool, ctx, (tx) => recordWrite(tx, ctx, p, r));
  } catch (e) {
    console.error('erp.write record failed', jobId, (e as { code?: string })?.code ?? (e as Error)?.name ?? 'error');
    // Sonuç yazılamadı: kayıt yerinde (deneme sayısı arttı → sonraki deneme önce ERP'de arar); çalışma ve iş kapatılır.
    await withTenant(pool, ctx, (tx) => failAfterPrepare(tx, ctx, p)).catch(() => {});
    return { outboundId: p.rec.id, status: p.rec.status, outcome: 'unknown', requestSent: true };
  }
}

async function failAfterPrepare(tx: Tx, ctx: TenantContext, p: Extract<Prepared, { kind: 'go' }>) {
  const note = { code: 'internal_error', message: 'Sonuç kaydedilemedi; ERP\'ye istek atılmış olabilir. Yeniden denemede önce ERP\'de aranır, ikinci kayıt açılmaz.' };
  await finishJob(tx, p.jobId, p.job, p.runId, 'unknown', { outboundId: p.rec.id, outcome: 'unknown', reason: 'internal_error' }, 'PROCESSING_ERROR');
  if (p.runId) await accountRetryRun(tx, ctx, p.runId, p.jobId, 'unknown', { ...note, recordKey: p.recordKey }, true);
  if (p.eventRunId) {
    await addRunError(tx, ctx, p.eventRunId, p.recordKey, note.code, note.message);
    await tx.query(`UPDATE integration_runs SET status = 'FAILED', finished_at = now(), counts = counts || '{"requestSent":true,"unknown":1}'::jsonb WHERE id = $1 AND status = 'RUNNING'`,
      [p.eventRunId]);
  }
}

const systemCtx = (tenantId: string, companyIds: string[], correlationId: string, userId = SYSTEM_USER): TenantContext =>
  ({ tenantId, userId, roles: [], companyIds, departmentIds: [], allDepartments: true, correlationId });

/**
 * İşçi giriş noktası. Olay işi sistem işidir (tetikleyen onaycının ERP izni gerekmez; koşul R3'tür): kiracının bütün şirketleri, departman
 * kapsamı yok, denetimde tetikleyen kullanıcı. "Şimdi çalıştır" yeniden denemesinde isteyenin güncel üyeliği ve çalıştırma izni gerekir
 * (yoksa istek atılmaz, iş BLOCKED, çalışma kapanır). Hazırlıkta beklenmeyen hata: işlem geri alınır (istek atılmadı), iş kuyruk politikasıyla.
 */
export async function runErpWriteJob(pool: pg.Pool, job: { id: string; tenant_id: string; requested_by: string | null },
  member: { roles: string[] } | undefined, deps: ErpWriteDeps): Promise<WriteResult | null> {
  const base = systemCtx(job.tenant_id, [], `job-${job.id}`);
  const companyIds = await withTenant(pool, base, async (tx) => (await tx.query<{ id: string }>(`SELECT id FROM legal_entities ORDER BY id`)).rows.map((r) => r.id));
  const payload = await withTenant(pool, base, async (tx) => (await tx.query<{ payload: { runId?: unknown } }>(`SELECT payload FROM jobs WHERE id = $1`, [job.id])).rows[0]?.payload);
  const runId = typeof payload?.runId === 'string' ? payload.runId : null;
  const sys = systemCtx(job.tenant_id, companyIds, `job-${job.id}`, job.requested_by ?? SYSTEM_USER);
  if (runId) {
    const roles = normalizeRoles(member?.roles ?? []);
    if (!member || !job.requested_by || !can(roles, 'integration.endpoint.run')) {
      await withTenant(pool, sys, async (tx) => {
        await tx.query(`UPDATE jobs SET status = 'BLOCKED', error_code = 'REQUESTER_NOT_AUTHORIZED', updated_at = now() WHERE id = $1`, [job.id]);
        await accountRetryRun(tx, sys, runId, job.id, 'failed', { code: 'requester_not_authorized', message: 'Çalışmayı isteyen kullanıcının üyeliği ya da çalıştırma izni yok; ERP\'ye istek atılmadı.' });
      });
      return null;
    }
  }
  try {
    return await processErpWrite(pool, sys, job.id, deps);
  } catch (e) {
    console.error('erp.write failed', job.id, (e as { code?: string })?.code ?? (e as Error)?.name ?? 'error');
    await withTenant(pool, sys, async (tx) => {
      const j = (await tx.query<JobRow>(`SELECT payload, status, attempts, max_attempts, requested_by FROM jobs WHERE id = $1`, [job.id])).rows[0];
      if (!j) return;
      await finishJob(tx, job.id, j, runId, 'failed', { reason: 'internal_error', requestSent: false }, 'PROCESSING_ERROR');
      if (runId) await accountRetryRun(tx, sys, runId, job.id, 'failed', { code: 'internal_error', message: 'Yazma hazırlanırken beklenmeyen bir hata oldu; değişiklikler geri alındı, ERP\'ye istek atılmadı.' });
    }).catch(() => {});
    return null;
  }
}

// ---------- Bayat yazma işleri ve çalışmaları ----------

/**
 * Kiracı bağlamında (RLS): uzun süredir RUNNING kalan `erp.write` işi (işçi çöktü) olay işiyse kuyruk politikasıyla yeniden kuyruğa
 * (kayıt deneme sayısı arttığı için sonraki deneme önce ERP'de arar), yeniden deneme işiyse FAILED; bayat olay çalışması FAILED stale_run;
 * yeniden deneme çalışması etkin işi kalmadıysa ya da süre sınırını aştıysa kapanır. Döner: kapatılan/yeniden kuyruğa alınan sayısı.
 */
export async function reapStaleErpWrites(tx: Tx, ctx: TenantContext, now: Date = new Date()): Promise<number> {
  const at = now.toISOString();
  let n = 0;
  const jobs = (await tx.query<{ id: string; payload: { runId?: unknown }; attempts: number; max_attempts: number }>(`SELECT id, payload, attempts, max_attempts FROM jobs
    WHERE kind = $1 AND status = 'RUNNING' AND updated_at < $2::timestamptz - make_interval(mins => $3) ORDER BY updated_at FOR UPDATE SKIP LOCKED`,
    [ERP_WRITE_JOB, at, ERP_WRITE_LIMITS.staleJobMinutes])).rows;
  for (const j of jobs) {
    const runId = typeof j.payload?.runId === 'string' ? j.payload.runId : null;
    if (runId) {
      await tx.query(`UPDATE jobs SET status = 'FAILED', error_code = 'STALE_RUN', updated_at = now() WHERE id = $1`, [j.id]);
      await accountRetryRun(tx, ctx, runId, j.id, 'unknown', { code: 'stale_run', message: 'Yazma işi zamanında bitmedi (işçi durmuş); sonuç belirsiz. Yeniden denemede önce ERP\'de aranır.' }, true);
    } else {
      await tx.query(`UPDATE jobs SET status = CASE WHEN attempts >= max_attempts THEN 'DEAD' ELSE 'QUEUED' END, run_after = now() + (attempts * interval '30 seconds'),
        error_code = 'STALE_RUN', updated_at = now() WHERE id = $1`, [j.id]);
    }
    n++;
  }
  const eventRuns = (await tx.query<{ id: string }>(`SELECT id FROM integration_runs WHERE status = 'RUNNING' AND counts->>'mode' = 'WRITE'
    AND started_at < $1::timestamptz - make_interval(mins => $2) FOR UPDATE SKIP LOCKED`, [at, ERP_WRITE_LIMITS.staleJobMinutes])).rows;
  for (const r of eventRuns) {
    await addRunError(tx, ctx, r.id, null, 'stale_run', 'Yazma çalışması zamanında bitmedi (işçi durmuş); sonuç belirsiz. Yeniden denemede önce ERP\'de aranır.');
    await tx.query(`UPDATE integration_runs SET status = 'FAILED', finished_at = now(), counts = counts || '{"reason":"stale_run"}'::jsonb WHERE id = $1 AND status = 'RUNNING'`, [r.id]);
    n++;
  }
  const retryRuns = (await tx.query<{ id: string; old: boolean }>(`SELECT id, started_at < $1::timestamptz - make_interval(mins => $3) AS old FROM integration_runs
    WHERE status = 'RUNNING' AND counts->>'mode' = 'WRITE_RETRY' AND started_at < $1::timestamptz - make_interval(mins => $2) FOR UPDATE SKIP LOCKED`,
    [at, ERP_WRITE_LIMITS.staleJobMinutes, ERP_WRITE_LIMITS.staleRetryRunMinutes])).rows;
  for (const r of retryRuns) {
    if (r.old) {
      const left = (await tx.query(`UPDATE jobs SET status = 'FAILED', error_code = 'STALE_RUN', updated_at = now() WHERE kind = $1 AND payload->>'runId' = $2
        AND status IN ('QUEUED','RUNNING') RETURNING id`, [ERP_WRITE_JOB, r.id])).rowCount ?? 0;
      if (left) await addRunError(tx, ctx, r.id, null, 'stale_run', `${left} yazma işi zamanında alınmadı; başarısız sayıldı. Yeniden çalıştırın.`);
    }
    if (await accountRetryRun(tx, ctx, r.id, null, null)) n++;
  }
  return n;
}

/** Bütün kiracılarda bayat yazma işlerini/çalışmalarını kapatır (058e dar kiracı kapısı). */
export async function reapAllStaleErpWrites(pool: pg.Pool, now: Date = new Date()): Promise<number> {
  const tenants = await withoutTenant(pool, async (c) => (await c.query<{ id: string }>(`SELECT t AS id FROM erp_write_stale_tenants($1, $2) t`,
    [now.toISOString(), ERP_WRITE_LIMITS.staleJobMinutes])).rows);
  let n = 0;
  for (const { id } of tenants) {
    try {
      const ctx = systemCtx(id, [], `erp-write-reap-${now.toISOString()}`);
      n += await withTenant(pool, ctx, (tx) => reapStaleErpWrites(tx, ctx, now));
    } catch (e) {
      console.error('erp write reap failed', id, (e as { code?: string })?.code ?? 'error');
    }
  }
  return n;
}

export { MOCK_NOTE as ERP_WRITE_MOCK_NOTE };
