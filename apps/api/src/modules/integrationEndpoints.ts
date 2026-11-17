// v2 Faz 8 (D113) Görev 4: ERP uç noktası ayar API'si — 7 özellik kartı, sır (yalnız yazılır), bağlantı sınaması, yazmayı açma (R3),
// "Şimdi çalıştır" ve çalışma/hata kaydı okuma.
// Kurallar:
//  * Sır (parola / istemci sırrı) yalnız PUT gövdesinde gelir; hiçbir yanıt, denetim kaydı ya da hata iletisi sırrı, şifreli metni
//    veya kek_id'yi içermez. Kart yalnız secretSet / secretUpdatedAt / secretNeedsReentry döner.
//  * provider_kind yapılandırmadan yazılır (ERP_PROVIDER taklit → TAKLIT, oracle-ebs → ORACLE_EBS). `taklit://` adresi yalnız TAKLIT
//    uç noktasında kabul edilir; ORACLE_EBS'te domain doğrulaması şemayı reddeder.
//  * Taklit sağlayıcının her sonucu mock=true ve "gerçek Oracle değil" etiketlidir; PASS gibi gösterilmez.
//  * Bağlantı ayarı değişince eski sınama sonucu geçersizdir (last_test_* boşalır) ve ERP'ye yazma kapanır (R3 yeniden gerekir).
//  * Sağlayıcı çağrısı veritabanı işlemi dışında yapılır (sınama süresince işlem açık kalmaz); sonuç ayrı işlemde yazılır.
import {
  ERP_FEATURE_CATALOG, ERP_FEATURES, canEnableWrite, missingMappings, redactSecrets, validateEndpointConfig,
  type ErpAuthType, type ErpError, type ErpFeature, type FieldMap,
} from '@sp/domain';
import type { Config } from '../config.ts';
import type { TenantContext, Tx } from '../db.ts';
import { audit } from '../audit.ts';
import { ApiError, conflict, notFound, unprocessable } from '../errors.ts';
import {
  SecretBox, SecretKekMismatch, SecretKeyNotConfigured, SecretOpenFailed, endpointSecretStatus, loadEndpointSecret, storeEndpointSecret,
} from '../integrationSecrets.ts';
import { erpProvider, type ErpProvider, type ErpProviderKind, type ResolvedEndpoint } from '../erp/providers.ts';
import { TAKLIT_LABEL } from '../erp/taklit.ts';
import { ORACLE_EBS_LABEL } from '../erp/oracleEbs.ts';

type ErpCfg = Pick<Config, 'env' | 'erp'>;

const PROVIDER_LABEL: Record<ErpProviderKind, string> = { TAKLIT: TAKLIT_LABEL, ORACLE_EBS: ORACLE_EBS_LABEL };
const NOT_CONFIGURED_LABEL = 'Sağlayıcı yapılandırılmadı';
const MOCK_NOTE = 'taklit sağlayıcıyla denendi — gerçek Oracle değil';

export const RUN_STATUS_LABEL: Record<string, string> = {
  RUNNING: 'Çalışıyor', SUCCESS: 'Başarılı', PARTIAL: 'Kısmen başarılı', FAILED: 'Başarısız', NOT_CONFIGURED: 'Yapılandırılmadı',
};
export const RUN_TRIGGER_LABEL: Record<string, string> = { MANUAL: 'Elle', SCHEDULE: 'Zamanlanmış', EVENT: 'Olay', TEST: 'Bağlantı sınaması' };
const DIRECTION_LABEL = { IN: 'ERP → Uygulama', OUT: 'Uygulama → ERP', BOTH: 'İki yön' } as const;

const WRITE_REFUSAL: Record<string, string> = {
  feature_disabled: 'Önce özelliği açın.',
  mock_in_production: 'Üretimde taklit sağlayıcıyla ERP\'ye yazma açılamaz.',
  test_required: 'Son 24 saatte başarılı bir "Bağlantıyı sına" sonucu gerekli.',
  confirmation_required: '"ERP\'ye kayıt yazılacağını anlıyorum" onayı gerekli.',
};

/** Yapılandırmadaki sağlayıcı türü (dağıtımda tek sağlayıcı). `none` ya da yapılandırma yoksa null. */
export function configuredProviderKind(config: ErpCfg): ErpProviderKind | null {
  const p = config.erp?.provider;
  return p === 'taklit' ? 'TAKLIT' : p === 'oracle-ebs' ? 'ORACLE_EBS' : null;
}

const secretBox = (config: ErpCfg) => new SecretBox(config.erp?.secretKey ?? null);
const isFeature = (f: string): f is ErpFeature => (ERP_FEATURES as readonly string[]).includes(f);
const iso = (d: Date | null) => (d ? d.toISOString() : null);
const TAKLIT_URL_RE = /^taklit:\/\/[a-z0-9-]{0,40}\/?$/i;

type EndpointRow = {
  id: string; feature: ErpFeature; enabled: boolean; write_enabled: boolean; write_confirmed_by: string | null; write_confirmed_at: Date | null;
  write_confirmed_by_name: string | null; provider_kind: ErpProviderKind; base_url: string | null; resource_path: string | null;
  auth_type: ErpAuthType | null; username: string | null; client_id: string | null; token_url: string | null; schedule_kind: 'MANUAL' | 'INTERVAL' | 'DAILY';
  schedule_interval_min: number | null; schedule_daily_at: string | null; field_map: FieldMap; timeout_ms: number; last_test_at: Date | null;
  last_test_ok: boolean | null; last_test_message: string | null; updated_at: Date;
};

const ROW_SQL = `SELECT e.id, e.feature, e.enabled, e.write_enabled, e.write_confirmed_by, e.write_confirmed_at, u.display_name AS write_confirmed_by_name,
  e.provider_kind, e.base_url, e.resource_path, e.auth_type, e.username, e.client_id, e.token_url, e.schedule_kind, e.schedule_interval_min,
  to_char(e.schedule_daily_at, 'HH24:MI') AS schedule_daily_at, e.field_map, e.timeout_ms, e.last_test_at, e.last_test_ok, e.last_test_message, e.updated_at
  FROM integration_endpoints e LEFT JOIN users u ON u.id = e.write_confirmed_by`;

async function endpointRow(tx: Tx, feature: ErpFeature, lock = false): Promise<EndpointRow | null> {
  const r = await tx.query<EndpointRow>(`${ROW_SQL} WHERE e.feature = $1${lock ? ' FOR UPDATE OF e' : ''}`, [feature]);
  return r.rows[0] ?? null;
}

type RunRow = {
  id: string; feature: string; trigger: string; provider_kind: ErpProviderKind | null; mock: boolean; started_at: Date; finished_at: Date | null;
  status: string; counts: Record<string, number>; requested_by: string | null; requested_by_name: string | null; error_count: number;
};
const RUN_SQL = `SELECT r.id, r.feature, r.trigger, r.provider_kind, r.mock, r.started_at, r.finished_at, r.status, r.counts, r.requested_by,
  u.display_name AS requested_by_name, (SELECT count(*)::int FROM integration_run_errors x WHERE x.run_id = r.id) AS error_count
  FROM integration_runs r LEFT JOIN users u ON u.id = r.requested_by`;

function runView(r: RunRow) {
  const base = RUN_STATUS_LABEL[r.status] ?? r.status;
  return {
    id: r.id, feature: r.feature, trigger: r.trigger, triggerLabel: RUN_TRIGGER_LABEL[r.trigger] ?? r.trigger,
    status: r.status, statusLabel: r.mock ? `${base} (${MOCK_NOTE})` : base,
    provider: r.provider_kind ? { kind: r.provider_kind, label: PROVIDER_LABEL[r.provider_kind], real: r.provider_kind === 'ORACLE_EBS' } : null,
    mock: r.mock, startedAt: iso(r.started_at), finishedAt: iso(r.finished_at), counts: r.counts ?? {}, errorCount: r.error_count,
    requestedBy: r.requested_by ? { id: r.requested_by, name: r.requested_by_name } : null,
  };
}

function scheduleView(feature: ErpFeature, row: EndpointRow | null) {
  if (!ERP_FEATURE_CATALOG[feature].reads) return { mode: 'EVENT' as const, intervalMinutes: null, dailyTime: null, label: 'Olay anında' };
  const mode = row?.schedule_kind ?? 'MANUAL';
  const label = mode === 'INTERVAL' ? `${row?.schedule_interval_min} dakikada bir` : mode === 'DAILY' ? `Her gün ${row?.schedule_daily_at} (İstanbul)` : 'Yalnız elle ("Şimdi çalıştır")';
  return { mode, intervalMinutes: row?.schedule_interval_min ?? null, dailyTime: row?.schedule_daily_at ?? null, label };
}

function providerView(kind: ErpProviderKind | null, config: ErpCfg) {
  if (!kind) return { kind: null, label: NOT_CONFIGURED_LABEL, real: false, available: false };
  return { kind, label: PROVIDER_LABEL[kind], real: kind === 'ORACLE_EBS', available: erpProvider(kind, config) !== null };
}

// ---------- GET kartlar ----------

export async function listEndpoints(tx: Tx, ctx: TenantContext, config: ErpCfg, can: { manage: boolean; run: boolean }) {
  const box = secretBox(config);
  const rows = new Map((await tx.query<EndpointRow>(ROW_SQL)).rows.map((r) => [r.feature, r]));
  const lastRuns = new Map((await tx.query<RunRow>(`SELECT DISTINCT ON (r.feature) * FROM (${RUN_SQL} WHERE r.trigger <> 'TEST') r
    ORDER BY r.feature, r.started_at DESC, r.id`)).rows.map((r) => [r.feature, r]));
  const cfgKind = configuredProviderKind(config);
  const items = [];
  for (const feature of ERP_FEATURES) {
    const def = ERP_FEATURE_CATALOG[feature];
    const row = rows.get(feature) ?? null;
    const secret = row ? await endpointSecretStatus(tx, box, row.id) : { secretSet: false, secretUpdatedAt: null, needsReentry: false };
    const fieldMap = row?.field_map ?? {};
    const last = lastRuns.get(feature);
    items.push({
      feature, label: def.label, direction: def.direction, directionLabel: DIRECTION_LABEL[def.direction], stage: def.stage,
      reads: def.reads, writes: def.writes,
      enabled: row?.enabled ?? false,
      writeEnabled: row?.write_enabled ?? false,
      writeConfirmation: row?.write_enabled && row.write_confirmed_at ? { at: iso(row.write_confirmed_at), by: { id: row.write_confirmed_by, name: row.write_confirmed_by_name } } : null,
      provider: providerView(row?.provider_kind ?? cfgKind, config),
      baseUrl: row?.base_url ?? null, resourcePath: row?.resource_path ?? null, authType: row?.auth_type ?? null,
      username: row?.username ?? null, clientId: row?.client_id ?? null, tokenUrl: row?.token_url ?? null, timeoutMs: row?.timeout_ms ?? 15000,
      secretSet: secret.secretSet, secretUpdatedAt: secret.secretUpdatedAt, secretNeedsReentry: secret.needsReentry,
      secretKeyConfigured: box.configured,
      schedule: scheduleView(feature, row),
      fieldMap, defaultFieldMap: def.ebsDefaultMap, appFields: def.appFields, missingMappings: missingMappings(feature, fieldMap),
      lastTest: row?.last_test_at ? { at: iso(row.last_test_at), ok: row.last_test_ok, message: row.last_test_message, mock: row.provider_kind === 'TAKLIT' } : null,
      lastRun: last ? runView(last) : null,
      manualFallback: def.manualFallback,
      updatedAt: row ? iso(row.updated_at) : null,
      can,
    });
  }
  return { items, providerConfigured: cfgKind !== null, provider: providerView(cfgKind, config), secretKeyConfigured: box.configured };
}

// ---------- PUT ayar ----------

export type EndpointBody = {
  enabled?: boolean;
  baseUrl?: string | null; resourcePath?: string | null; authType?: ErpAuthType | null;
  username?: string | null; clientId?: string | null; tokenUrl?: string | null;
  /** Yalnız yazılır. string = yeni sır; null = sırrı kaldır; yok = değişmez. */
  secret?: string | null;
  schedule?: { mode: 'MANUAL' | 'INTERVAL' | 'DAILY'; intervalMinutes?: number | null; dailyTime?: string | null };
  fieldMap?: FieldMap;
  timeoutMs?: number;
};

const CONNECTION_FIELDS = ['baseUrl', 'resourcePath', 'authType', 'username', 'clientId', 'tokenUrl'] as const;
const nz = (s: string | null | undefined) => (typeof s === 'string' && s.trim() !== '' ? s.trim() : null);

export async function updateEndpoint(tx: Tx, ctx: TenantContext, config: ErpCfg, featureParam: string, body: EndpointBody) {
  if (!isFeature(featureParam)) throw notFound();
  const feature = featureParam;
  const def = ERP_FEATURE_CATALOG[feature];
  const production = config.env === 'production';
  const box = secretBox(config);
  const row = await endpointRow(tx, feature, true);
  const cfgKind = configuredProviderKind(config);
  const kind: ErpProviderKind = cfgKind ?? row?.provider_kind ?? 'TAKLIT';

  const prevSchedule = { mode: row?.schedule_kind ?? 'MANUAL', intervalMinutes: row?.schedule_interval_min ?? null, dailyTime: row?.schedule_daily_at ?? null };
  const next = {
    enabled: body.enabled ?? row?.enabled ?? false,
    baseUrl: 'baseUrl' in body ? nz(body.baseUrl) : row?.base_url ?? null,
    resourcePath: 'resourcePath' in body ? nz(body.resourcePath) : row?.resource_path ?? null,
    authType: 'authType' in body ? body.authType ?? null : row?.auth_type ?? null,
    username: 'username' in body ? nz(body.username) : row?.username ?? null,
    clientId: 'clientId' in body ? nz(body.clientId) : row?.client_id ?? null,
    tokenUrl: 'tokenUrl' in body ? nz(body.tokenUrl) : row?.token_url ?? null,
    schedule: def.reads ? (body.schedule ? { mode: body.schedule.mode, intervalMinutes: body.schedule.mode === 'INTERVAL' ? body.schedule.intervalMinutes ?? null : null,
      dailyTime: body.schedule.mode === 'DAILY' ? body.schedule.dailyTime ?? null : null } : prevSchedule) : { mode: 'MANUAL' as const, intervalMinutes: null, dailyTime: null },
    fieldMap: body.fieldMap ?? row?.field_map ?? {},
    timeoutMs: body.timeoutMs ?? row?.timeout_ms ?? 15000,
  };
  // Kimlik türüne ait olmayan alanlar boşaltılır (BASIC'te istemci kimliği/token adresi, OAuth'ta kullanıcı adı tutulmaz).
  if (next.authType === 'BASIC') { next.clientId = null; next.tokenUrl = null; }
  if (next.authType === 'OAUTH2_CLIENT_CREDENTIALS') next.username = null;

  const prevSecret = row ? await endpointSecretStatus(tx, box, row.id) : { secretSet: false, secretUpdatedAt: null, needsReentry: false };
  const secretAction: 'set' | 'remove' | 'keep' = typeof body.secret === 'string' ? 'set' : body.secret === null ? 'remove' : 'keep';
  const secretSet = secretAction === 'set' ? true : secretAction === 'remove' ? false : prevSecret.secretSet && !prevSecret.needsReentry;

  const changed: string[] = [];
  const cur = {
    enabled: row?.enabled ?? false, baseUrl: row?.base_url ?? null, resourcePath: row?.resource_path ?? null, authType: row?.auth_type ?? null,
    username: row?.username ?? null, clientId: row?.client_id ?? null, tokenUrl: row?.token_url ?? null, schedule: prevSchedule,
    fieldMap: row?.field_map ?? {}, timeoutMs: row?.timeout_ms ?? 15000,
  };
  for (const k of Object.keys(cur) as (keyof typeof cur)[]) {
    if (JSON.stringify(cur[k]) !== JSON.stringify(next[k])) changed.push(k);
  }
  const connectionChanged = CONNECTION_FIELDS.some((k) => changed.includes(k)) || secretAction !== 'keep' || (row !== null && row.provider_kind !== kind);

  // Yalnız kapatma ve/veya kapalı kayıtta yalnız sır kaldırma her zaman mümkündür; geri kalan her kayıt tam doğrulanır.
  const onlyDisabling = !next.enabled && secretAction !== 'set' && changed.every((k) => k === 'enabled');
  if (!onlyDisabling) {
    const errors = validateConfig(feature, kind, next, secretSet, next.enabled, config, production);
    if (errors.length) throw unprocessable('endpoint_invalid', 'Bağlantı ayarları geçersiz; işaretli alanları düzeltin.', { errors });
    if (typeof body.secret === 'string' && (Buffer.byteLength(body.secret, 'utf8') === 0 || Buffer.byteLength(body.secret, 'utf8') > 4096)) {
      throw unprocessable('endpoint_invalid', 'Bağlantı ayarları geçersiz; işaretli alanları düzeltin.', { errors: [{ field: 'secret', code: 'invalid_length' }] });
    }
  }
  if (next.enabled) {
    const missing = missingMappings(feature, next.fieldMap);
    if (missing.length) throw unprocessable('mapping_incomplete', 'Zorunlu alanlar eşlenmeden özellik açılamaz.', { missing });
    if (!cfgKind) throw conflict('provider_not_configured', 'Bu ortamda ERP sağlayıcısı yapılandırılmadı (ERP_PROVIDER); özellik açılamaz.');
  }
  if (secretAction === 'set' && !box.configured) {
    throw conflict('secret_key_not_configured', 'Sır şifreleme anahtarı (INTEGRATION_SECRET_KEY) yapılandırılmadı; sır kaydedilemez.');
  }

  const resetTest = connectionChanged;
  // R3: bağlantı değişti ya da özellik kapandı → ERP'ye yazma kapanır, onay yeniden istenir.
  const writeOff = (row?.write_enabled ?? false) && (!next.enabled || connectionChanged);
  const writeEnabled = (row?.write_enabled ?? false) && !writeOff;

  const params = [
    next.enabled, writeEnabled, kind, next.baseUrl, next.resourcePath, next.authType, next.username, next.clientId, next.tokenUrl,
    next.schedule.mode, next.schedule.intervalMinutes, next.schedule.dailyTime, JSON.stringify(next.fieldMap), next.timeoutMs, ctx.userId,
  ];
  let endpointId: string;
  if (!row) {
    endpointId = (await tx.query<{ id: string }>(`INSERT INTO integration_endpoints (tenant_id, feature, enabled, write_enabled, provider_kind, base_url,
      resource_path, auth_type, username, client_id, token_url, schedule_kind, schedule_interval_min, schedule_daily_at, field_map, timeout_ms, updated_by, updated_at)
      VALUES ($16, $17, $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::time, $13::jsonb, $14, $15, now()) RETURNING id`,
      [...params, ctx.tenantId, feature])).rows[0]!.id;
  } else {
    endpointId = row.id;
    await tx.query(`UPDATE integration_endpoints SET enabled = $1, write_enabled = $2, provider_kind = $3, base_url = $4, resource_path = $5, auth_type = $6,
      username = $7, client_id = $8, token_url = $9, schedule_kind = $10, schedule_interval_min = $11, schedule_daily_at = $12::time, field_map = $13::jsonb,
      timeout_ms = $14, updated_by = $15, updated_at = now()
      ${writeOff ? ', write_confirmed_by = NULL, write_confirmed_at = NULL' : ''}
      ${resetTest ? ', last_test_at = NULL, last_test_ok = NULL, last_test_message = NULL' : ''}
      WHERE id = $16`, [...params, endpointId]);
  }

  try {
    if (secretAction === 'set') await storeEndpointSecret(tx, box, endpointId, body.secret as string, ctx.userId);
    else if (secretAction === 'remove') await tx.query(`DELETE FROM integration_endpoint_secrets WHERE endpoint_id = $1`, [endpointId]);
  } catch (e) {
    // Sır kutusu hatası iletisi sır içermez; yine de ayrıntı yanıta taşınmaz.
    if (e instanceof SecretKeyNotConfigured) throw conflict('secret_key_not_configured', 'Sır şifreleme anahtarı (INTEGRATION_SECRET_KEY) yapılandırılmadı; sır kaydedilemez.');
    throw new ApiError(500, 'internal', 'Sır kaydedilemedi. İşlem kaydedilmedi.');
  }

  const data: Record<string, unknown> = { feature, changed, enabled: next.enabled, providerKind: kind };
  if (secretAction === 'set') data.secretChanged = true;
  if (secretAction === 'remove') { data.secretChanged = true; data.secretRemoved = true; }
  if (writeOff) data.writeDisabled = true;
  if (resetTest && row?.last_test_at) data.lastTestCleared = true;
  await audit(tx, ctx, 'integration.endpoint.updated', 'integration_endpoint', endpointId, data);
  return { id: endpointId, feature, enabled: next.enabled, writeEnabled, changed, secretChanged: secretAction !== 'keep', writeDisabled: writeOff };
}

function validateConfig(feature: ErpFeature, kind: ErpProviderKind, next: {
  baseUrl: string | null; resourcePath: string | null; authType: ErpAuthType | null; username: string | null; clientId: string | null; tokenUrl: string | null;
  schedule: { mode: 'MANUAL' | 'INTERVAL' | 'DAILY'; intervalMinutes: number | null; dailyTime: string | null }; fieldMap: FieldMap;
}, secretSet: boolean, enabled: boolean, config: ErpCfg, production: boolean): ErpError[] {
  const allowedHosts = config.erp?.allowedHosts ?? [];
  // Taklit uç noktasında `taklit://…` adresi kabul edilir (ağ yok); domain kuralı yalnız http/https bilir, o hata burada düşülür.
  const taklitBase = kind === 'TAKLIT' && typeof next.baseUrl === 'string' && TAKLIT_URL_RE.test(next.baseUrl);
  const taklitToken = kind === 'TAKLIT' && typeof next.tokenUrl === 'string' && TAKLIT_URL_RE.test(next.tokenUrl);
  const r = validateEndpointConfig({
    feature, baseUrl: next.baseUrl ?? '', authType: next.authType as ErpAuthType, username: next.username ?? undefined, clientId: next.clientId ?? undefined,
    tokenUrl: next.tokenUrl ?? undefined, secretSet, sourcePath: next.resourcePath ?? '',
    schedule: { mode: next.schedule.mode, intervalMinutes: next.schedule.intervalMinutes ?? undefined, dailyTime: next.schedule.dailyTime ?? undefined },
    fieldMap: next.fieldMap,
  }, { allowedHosts, production });
  const errors = r.ok ? [] : r.errors;
  // Kapalı kayıtta sır zorunlu değildir: Yönetici sırrı her zaman kaldırabilir (sızıntı şüphesi) ve sırrı sonra girebilir.
  // Açık özellik sırsız kaydedilemez.
  return errors.filter((e) => !(e.field === 'baseUrl' && taklitBase) && !(e.field === 'tokenUrl' && taklitToken) && !(e.field === 'secret' && !enabled));
}

// ---------- R3 yazmayı açma / kapama ----------

export async function enableWrite(tx: Tx, ctx: TenantContext, config: ErpCfg, featureParam: string, confirm: boolean) {
  if (!isFeature(featureParam)) throw notFound();
  const feature = featureParam;
  if (!ERP_FEATURE_CATALOG[feature].writes) throw conflict('feature_not_writable', 'Bu özellik ERP\'ye yazmaz; yazma açılamaz.');
  const row = await endpointRow(tx, feature, true);
  const check = canEnableWrite({
    enabled: row?.enabled ?? false,
    lastTestOkAt: row?.last_test_ok && row.last_test_at ? row.last_test_at.toISOString() : null,
    now: new Date().toISOString(),
    confirmed: confirm === true,
    providerReal: row?.provider_kind === 'ORACLE_EBS',
    production: config.env === 'production',
  });
  if (!check.ok) throw conflict(check.reason, WRITE_REFUSAL[check.reason] ?? 'ERP\'ye yazma açılamaz.', { reason: check.reason });
  // Sağlayıcı bu ortamda yoksa (tür uyuşmazlığı ya da ERP_PROVIDER=none) yazma açılmaz.
  if (!row || !erpProvider(row.provider_kind, config)) throw conflict('provider_not_configured', 'Bu ortamda uç noktanın sağlayıcısı yapılandırılmadı; yazma açılamaz.');
  await tx.query(`UPDATE integration_endpoints SET write_enabled = true, write_confirmed_by = $2, write_confirmed_at = now(), updated_by = $2, updated_at = now()
    WHERE id = $1`, [row.id, ctx.userId]);
  await audit(tx, ctx, 'integration.endpoint.write_enabled', 'integration_endpoint', row.id,
    { feature, providerKind: row.provider_kind, mock: row.provider_kind === 'TAKLIT', lastTestAt: iso(row.last_test_at), confirmed: true });
  return { feature, writeEnabled: true };
}

export async function disableWrite(tx: Tx, ctx: TenantContext, featureParam: string) {
  if (!isFeature(featureParam)) throw notFound();
  const feature = featureParam;
  if (!ERP_FEATURE_CATALOG[feature].writes) throw conflict('feature_not_writable', 'Bu özellik ERP\'ye yazmaz.');
  const row = await endpointRow(tx, feature, true);
  if (!row || !row.write_enabled) return { feature, writeEnabled: false };
  await tx.query(`UPDATE integration_endpoints SET write_enabled = false, write_confirmed_by = NULL, write_confirmed_at = NULL, updated_by = $2, updated_at = now()
    WHERE id = $1`, [row.id, ctx.userId]);
  await audit(tx, ctx, 'integration.endpoint.write_disabled', 'integration_endpoint', row.id, { feature });
  return { feature, writeEnabled: false };
}

// ---------- Bağlantıyı sına ----------

export type PreparedTest =
  | { kind: 'call'; feature: ErpFeature; endpointId: string; provider: ErpProvider; ep: ResolvedEndpoint }
  | { kind: 'refused'; feature: ErpFeature; endpointId: string; providerKind: ErpProviderKind | null; message: string; code: string };

/** 1. işlem: uç noktayı ve sırrı okur (sır yalnız bellekte, çağrı için). Sağlayıcı çağrısı işlem dışında yapılır. */
export async function prepareTest(tx: Tx, ctx: TenantContext, config: ErpCfg, featureParam: string): Promise<PreparedTest> {
  if (!isFeature(featureParam)) throw notFound();
  const feature = featureParam;
  const row = await endpointRow(tx, feature);
  if (!row || !row.base_url || !row.resource_path || !row.auth_type) {
    throw conflict('endpoint_not_configured', 'Önce bağlantı ayarlarını kaydedin.');
  }
  const provider = erpProvider(row.provider_kind, config);
  if (!provider) return { kind: 'refused', feature, endpointId: row.id, providerKind: null, code: 'provider_not_configured', message: 'Bu ortamda ERP sağlayıcısı yapılandırılmadı; istek atılmadı.' };
  let secret: string | null = null;
  try {
    secret = await loadEndpointSecret(tx, row.id, secretBox(config));
  } catch (e) {
    if (e instanceof SecretKekMismatch) return { kind: 'refused', feature, endpointId: row.id, providerKind: row.provider_kind, code: 'secret_needs_reentry', message: 'Sır yeniden girilmeli (anahtar değişti); istek atılmadı.' };
    if (e instanceof SecretKeyNotConfigured) return { kind: 'refused', feature, endpointId: row.id, providerKind: row.provider_kind, code: 'secret_key_not_configured', message: 'Sır şifreleme anahtarı yapılandırılmadı; istek atılmadı.' };
    if (e instanceof SecretOpenFailed) return { kind: 'refused', feature, endpointId: row.id, providerKind: row.provider_kind, code: 'secret_unreadable', message: 'Kayıtlı sır açılamadı; sırrı yeniden girin. İstek atılmadı.' };
    throw e;
  }
  return {
    kind: 'call', feature, endpointId: row.id, provider,
    ep: { id: row.id, tenantId: ctx.tenantId, feature, baseUrl: row.base_url, resourcePath: row.resource_path, authType: row.auth_type,
      username: row.username, clientId: row.client_id, tokenUrl: row.token_url, secret, timeoutMs: row.timeout_ms },
  };
}

export async function executeTest(p: PreparedTest): Promise<{ ok: boolean; message: string; latencyMs: number; providerKind: ErpProviderKind | null; mock: boolean; code: string | null; startedAt: Date }> {
  const startedAt = new Date();
  if (p.kind === 'refused') return { ok: false, message: p.message, latencyMs: 0, providerKind: p.providerKind, mock: p.providerKind === 'TAKLIT', code: p.code, startedAt };
  const secrets = [p.ep.secret ?? ''].filter(Boolean);
  try {
    const r = await p.provider.test(p.ep);
    return { ok: r.ok, message: redactSecrets(r.message, secrets), latencyMs: r.latencyMs, providerKind: p.provider.kind, mock: !p.provider.real,
      code: r.ok ? null : 'connection_test_failed', startedAt };
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'Bağlantı denemesi başarısız.';
    return { ok: false, message: redactSecrets(msg, secrets), latencyMs: Date.now() - startedAt.getTime(), providerKind: p.provider.kind, mock: !p.provider.real,
      code: 'connection_test_failed', startedAt };
  } finally {
    p.ep.secret = null;
  }
}

/** 2. işlem: sınama çalışmasını (trigger TEST) ve last_test_* alanlarını yazar. İleti sırdan arındırılmış ve ≤500. */
export async function recordTest(tx: Tx, ctx: TenantContext, featureParam: string, endpointId: string,
  r: { ok: boolean; message: string; latencyMs: number; providerKind: ErpProviderKind | null; mock: boolean; code: string | null; startedAt: Date }) {
  const message = r.message.slice(0, 500);
  const status = r.providerKind === null ? 'NOT_CONFIGURED' : r.ok ? 'SUCCESS' : 'FAILED';
  const runId = (await tx.query<{ id: string }>(`INSERT INTO integration_runs (tenant_id, endpoint_id, feature, trigger, provider_kind, mock, started_at, finished_at,
    status, counts, requested_by) VALUES ($1, $2, $3, 'TEST', $4, $5, $6, now(), $7, $8, $9) RETURNING id`,
    [ctx.tenantId, endpointId, featureParam, r.providerKind, r.providerKind === null ? false : r.mock, r.startedAt, status,
      JSON.stringify({ latencyMs: r.latencyMs }), ctx.userId])).rows[0]!.id;
  if (!r.ok) {
    await tx.query(`INSERT INTO integration_run_errors (tenant_id, run_id, record_key, code, message) VALUES ($1, $2, NULL, $3, $4)`,
      [ctx.tenantId, runId, r.code ?? 'connection_test_failed', message]);
  }
  await tx.query(`UPDATE integration_endpoints SET last_test_at = now(), last_test_ok = $2, last_test_message = $3 WHERE id = $1`, [endpointId, r.ok, message]);
  await audit(tx, ctx, 'integration.endpoint.tested', 'integration_endpoint', endpointId,
    { feature: featureParam, ok: r.ok, mock: r.mock, providerKind: r.providerKind, runId, code: r.code });
  return { ok: r.ok, message, latencyMs: r.latencyMs, mock: r.mock, runId, status, statusLabel: r.mock ? `${RUN_STATUS_LABEL[status]} (${MOCK_NOTE})` : RUN_STATUS_LABEL[status] };
}

// ---------- Şimdi çalıştır ----------

const RETRYABLE_OUTBOUND = ['PENDING', 'FAILED', 'UNKNOWN'];
const MAX_RETRY_BATCH = 500;

/**
 * Okuyan özellikte `erp.read` işi kuyruklar (payload `{ feature, runId }`, idempotency `erp.read:<feature>:<tenant>:manual:<runId>`).
 * Yazan özellikte (ya da SUPPLIER'da `target: 'WRITE_RETRY'`) bekleyen/başarısız/belirsiz ERP yazma kayıtları için `erp.write` işi
 * kuyruklar (payload `{ feature, outboundId, runId }`); yazma açık değilse (R3) hiçbir iş açılmaz. Özellik kapalı ya da sağlayıcı yoksa
 * çalışma hemen NOT_CONFIGURED kapanır ve istek atılmaz.
 */
export async function requestRun(tx: Tx, ctx: TenantContext, config: ErpCfg, featureParam: string, target?: unknown) {
  if (!isFeature(featureParam)) throw notFound();
  if (target !== undefined && target !== null && target !== 'READ' && target !== 'WRITE_RETRY') {
    throw new ApiError(400, 'validation_failed', 'İstek doğrulanamadı.', [{ field: '/target', message: 'READ ya da WRITE_RETRY olmalı' }]);
  }
  const feature = featureParam;
  const def = ERP_FEATURE_CATALOG[feature];
  const mode: 'READ' | 'WRITE_RETRY' = target === 'READ' || target === 'WRITE_RETRY' ? target : def.reads ? 'READ' : 'WRITE_RETRY';
  if (mode === 'READ' && !def.reads) throw conflict('feature_not_readable', 'Bu özellik ERP\'den okunmaz; yalnız bekleyen yazma kayıtları yeniden denenebilir.');
  if (mode === 'WRITE_RETRY' && !def.writes) throw conflict('feature_not_writable', 'Bu özellik ERP\'ye yazmaz.');
  const row = await endpointRow(tx, feature, true);
  const provider = row ? erpProvider(row.provider_kind, config) : null;
  const ready = !!row && row.enabled && !!provider && (mode === 'READ' || row.write_enabled);

  if (!ready) {
    const runId = (await tx.query<{ id: string }>(`INSERT INTO integration_runs (tenant_id, endpoint_id, feature, trigger, provider_kind, mock, finished_at, status,
      counts, requested_by) VALUES ($1, $2, $3, 'MANUAL', NULL, false, now(), 'NOT_CONFIGURED', $4, $5) RETURNING id`,
      [ctx.tenantId, row?.id ?? null, feature, JSON.stringify({ mode }), ctx.userId])).rows[0]!.id;
    const reason = !row || !row.enabled ? 'feature_disabled' : !provider ? 'provider_not_configured' : 'write_not_enabled';
    await audit(tx, ctx, 'integration.endpoint.run_requested', 'integration_endpoint', row?.id ?? null, { feature, mode, runId, status: 'NOT_CONFIGURED', reason });
    return { runId, status: 'NOT_CONFIGURED', statusLabel: RUN_STATUS_LABEL.NOT_CONFIGURED, reason, queued: 0 };
  }

  const running = await tx.query<{ id: string }>(`SELECT id FROM integration_runs WHERE feature = $1 AND status = 'RUNNING' AND trigger <> 'TEST'
    AND started_at > now() - interval '30 minutes' ORDER BY started_at DESC LIMIT 1`, [feature]);
  if (running.rows[0]) throw conflict('run_in_progress', 'Bu özellik için bir çalışma sürüyor; bitince yeniden deneyin.', { runId: running.rows[0].id });

  const mock = !provider!.real;
  const runId = (await tx.query<{ id: string }>(`INSERT INTO integration_runs (tenant_id, endpoint_id, feature, trigger, provider_kind, mock, status, counts, requested_by)
    VALUES ($1, $2, $3, 'MANUAL', $4, $5, 'RUNNING', $6, $7) RETURNING id`,
    [ctx.tenantId, row!.id, feature, provider!.kind, mock, JSON.stringify({ mode }), ctx.userId])).rows[0]!.id;

  let queued = 0;
  if (mode === 'READ') {
    await tx.query(`INSERT INTO jobs (tenant_id, kind, idempotency_key, payload, requested_by) VALUES ($1, 'erp.read', $2, $3, $4)`,
      [ctx.tenantId, `erp.read:${feature}:${ctx.tenantId}:manual:${runId}`, JSON.stringify({ feature, runId }), ctx.userId]);
    queued = 1;
  } else {
    const recs = (await tx.query<{ id: string }>(`SELECT id FROM erp_outbound_records WHERE feature = $1 AND status = ANY ($2) ORDER BY created_at LIMIT ${MAX_RETRY_BATCH}`,
      [feature, RETRYABLE_OUTBOUND])).rows;
    for (const rec of recs) {
      await tx.query(`INSERT INTO jobs (tenant_id, kind, idempotency_key, payload, requested_by) VALUES ($1, 'erp.write', $2, $3, $4)`,
        [ctx.tenantId, `erp.write:${rec.id}:retry:${runId}`, JSON.stringify({ feature, outboundId: rec.id, runId }), ctx.userId]);
    }
    queued = recs.length;
    if (queued === 0) {
      // Bekleyen kayıt yok: çalışma hemen kapanır (istek atılmadı).
      await tx.query(`UPDATE integration_runs SET status = 'SUCCESS', finished_at = now(), counts = $2 WHERE id = $1`,
        [runId, JSON.stringify({ mode, queued: 0 })]);
    } else {
      await tx.query(`UPDATE integration_runs SET counts = $2 WHERE id = $1`, [runId, JSON.stringify({ mode, queued })]);
    }
  }
  await audit(tx, ctx, 'integration.endpoint.run_requested', 'integration_endpoint', row!.id, { feature, mode, runId, mock, providerKind: provider!.kind, queued });
  const status = mode === 'WRITE_RETRY' && queued === 0 ? 'SUCCESS' : 'RUNNING';
  return { runId, status, statusLabel: mock ? `${RUN_STATUS_LABEL[status]} (${MOCK_NOTE})` : RUN_STATUS_LABEL[status], reason: null, queued };
}

// ---------- Çalışmalar ve hatalar ----------

export async function listRuns(tx: Tx, featureParam: string, limit = 20) {
  if (!isFeature(featureParam)) throw notFound();
  const n = Math.min(Math.max(Math.trunc(limit) || 20, 1), 100);
  const rows = (await tx.query<RunRow>(`${RUN_SQL} WHERE r.feature = $1 ORDER BY r.started_at DESC, r.id LIMIT $2`, [featureParam, n])).rows;
  return { items: rows.map(runView) };
}

export async function runErrors(tx: Tx, runId: string) {
  const run = (await tx.query<RunRow>(`${RUN_SQL} WHERE r.id = $1`, [runId])).rows[0];
  if (!run) throw notFound();
  const items = (await tx.query<{ id: string; record_key: string | null; code: string; message: string; payload_sha256: string | null; created_at: Date }>(
    `SELECT id, record_key, code, message, payload_sha256, created_at FROM integration_run_errors WHERE run_id = $1 ORDER BY created_at, id LIMIT 1000`, [runId])).rows;
  return {
    run: runView(run),
    items: items.map((e) => ({ id: e.id, recordKey: e.record_key, code: e.code, message: e.message, payloadSha256: e.payload_sha256, createdAt: iso(e.created_at) })),
  };
}
