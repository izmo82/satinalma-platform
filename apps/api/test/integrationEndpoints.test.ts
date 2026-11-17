// v2 Faz 8 (D113) Görev 4: ERP uç noktası ayar API'si — 7 kart, sır yalnız yazılır (yanıt/denetim/hata iletisinde yok), anahtar yoksa
// 409, eşleme eksikken açma 422, izinli olmayan host 422, taklit sınama (mock, "gerçek Oracle değil"), R3 yazma açma red nedenleri,
// "Şimdi çalıştır", çalışma ve hata kaydı, rol ve kiracı yalıtımı. Tüm veri sentetiktir; gerçek Oracle'a istek atılmaz
// (taklit sağlayıcıyla geçen her kontrol "taklit sağlayıcıyla denendi"dir, gerçek Oracle kontrolleri NOT_RUN).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ERP_FEATURE_CATALOG, ERP_FEATURES } from '@sp/domain';
import type { ErpConfig } from '../src/config.ts';
import { makeHarness } from './harness.ts';

const KEY = Buffer.alloc(32, 11);
const SECRET = 'Sentetik-ERP-Parola-7Q!x9';
const TAKLIT_OK = 'Taklit sağlayıcıyla denendi — gerçek Oracle değil';
let h: Awaited<ReturnType<typeof makeHarness>>;
const erpCfg = (): ErpConfig => ({ provider: 'taklit', secretKey: KEY, allowedHosts: ['erp.example.test'] });

beforeAll(async () => { h = await makeHarness({ erp: erpCfg() }); });
afterAll(async () => { await h?.close(); });

const url = (f: string, rest = '') => `/api/v1/integration/endpoints/${f}${rest}`;
const def = (f: keyof typeof ERP_FEATURE_CATALOG) => ERP_FEATURE_CATALOG[f];
const basic = (f: keyof typeof ERP_FEATURE_CATALOG, extra: Record<string, unknown> = {}) => ({
  baseUrl: 'taklit://ok', resourcePath: '/webservices/rest/sentetik', authType: 'BASIC', username: 'sentetik_kullanici', secret: SECRET,
  fieldMap: def(f).ebsDefaultMap, schedule: { mode: 'MANUAL' }, ...extra,
});
const card = async (f: string, who: 'tenantAdmin' | 'buyer' | 'auditor' = 'tenantAdmin') =>
  ((await h.call(who, 'GET', '/api/v1/integration/endpoints')).body.items as any[]).find((c) => c.feature === f);
async function withConfig<T>(patch: { env?: 'production'; erp?: Partial<ErpConfig> }, fn: () => Promise<T>): Promise<T> {
  const prevEnv = h.config.env;
  const prevErp = h.config.erp;
  if (patch.env) h.config.env = patch.env;
  if (patch.erp) h.config.erp = { ...erpCfg(), ...patch.erp };
  try { return await fn(); } finally { h.config.env = prevEnv; h.config.erp = prevErp; }
}
const auditData = async (entityId: string) => (await h.owner.query<{ action: string; data: unknown; text: string }>(
  `SELECT action, data, data::text AS text FROM audit_events WHERE tenant_id = $1 AND entity_id = $2 AND action LIKE 'integration.endpoint.%' ORDER BY id`,
  [h.world.tenantA, entityId])).rows;

describe('kart listesi ve roller', () => {
  it('Yönetici, Satınalma ve Denetçi 7 kartı okur (satırı yoksa varsayılan kapalı); yalnız Yönetici yönetir', async () => {
    const admin = await h.call('tenantAdmin', 'GET', '/api/v1/integration/endpoints');
    expect(admin.status).toBe(200);
    expect(admin.body.items.map((c: any) => c.feature)).toEqual([...ERP_FEATURES]);
    const pay = admin.body.items.find((c: any) => c.feature === 'PAYMENT_STATUS');
    expect(pay).toMatchObject({ enabled: false, writeEnabled: false, secretSet: false, secretUpdatedAt: null, label: 'Ödeme durumu', direction: 'IN', stage: 1,
      provider: { kind: 'TAKLIT', label: 'Taklit Oracle (gerçek değil)', real: false, available: true }, lastTest: null, lastRun: null,
      can: { manage: true, run: true } });
    expect(pay.appFields.length).toBeGreaterThan(0);
    expect(pay.manualFallback).toContain('ödeme durumunu');
    expect(admin.body.items.find((c: any) => c.feature === 'REQUISITION').schedule).toMatchObject({ mode: 'EVENT', label: 'Olay anında' });
    for (const who of ['buyer', 'auditor'] as const) {
      const r = await h.call(who, 'GET', '/api/v1/integration/endpoints');
      expect(r.status, who).toBe(200);
      expect(r.body.items).toHaveLength(7);
      expect(r.body.items[0].can).toEqual({ manage: false, run: false });
      expect((await h.call(who, 'PUT', url('INVOICE'), { body: basic('INVOICE') })).status, who).toBe(403);
      expect((await h.call(who, 'POST', url('INVOICE', '/test'))).status, who).toBe(403);
      expect((await h.call(who, 'POST', url('INVOICE', '/run'))).status, who).toBe(403);
      expect((await h.call(who, 'POST', url('SUPPLIER', '/write-enable'), { body: { confirm: true } })).status, who).toBe(403);
    }
    // Departman kullanıcısı entegrasyon kartlarını göremez.
    expect((await h.call('techEval', 'GET', '/api/v1/integration/endpoints')).status).toBe(403);
    expect((await h.call('techEval', 'GET', url('INVOICE', '/runs'))).status).toBe(403);
    // Bilinmeyen özellik 400.
    expect((await h.call('tenantAdmin', 'PUT', url('BANKA'), { body: {} })).status).toBe(400);
  });
});

describe('sır (yalnız yazılır)', () => {
  it('sır mühürlenir; GET, denetim ve yanıtlarda sır, şifreli metin ve kek_id yok; secret:null sırrı kaldırır', async () => {
    const put = await h.call('tenantAdmin', 'PUT', url('INVOICE'), { body: basic('INVOICE') });
    expect(put.status, JSON.stringify(put.body)).toBe(200);
    expect(put.body).toMatchObject({ feature: 'INVOICE', enabled: false, secretChanged: true });
    const id = put.body.id as string;
    const row = (await h.owner.query<{ kek_id: string; ciphertext: Buffer; wrapped_dek: Buffer }>(
      `SELECT kek_id, ciphertext, wrapped_dek FROM integration_endpoint_secrets WHERE endpoint_id = $1`, [id])).rows[0]!;
    expect(row.ciphertext.includes(Buffer.from(SECRET))).toBe(false);
    const ep = (await h.owner.query<{ provider_kind: string }>(`SELECT provider_kind FROM integration_endpoints WHERE id = $1`, [id])).rows[0]!;
    expect(ep.provider_kind).toBe('TAKLIT');

    const forbidden = [SECRET, row.ciphertext.toString('hex'), row.ciphertext.toString('base64'), row.wrapped_dek.toString('base64'), row.kek_id];
    for (const who of ['tenantAdmin', 'buyer', 'auditor'] as const) {
      const g = await h.call(who, 'GET', '/api/v1/integration/endpoints');
      const raw = g.raw.toString('utf8');
      for (const s of forbidden) expect(raw, who).not.toContain(s);
      expect(raw).not.toMatch(/kek_?id|ciphertext|wrapped/i);
      const c = g.body.items.find((x: any) => x.feature === 'INVOICE');
      expect(c).toMatchObject({ secretSet: true, secretNeedsReentry: false, username: 'sentetik_kullanici', baseUrl: 'taklit://ok', authType: 'BASIC' });
      expect(typeof c.secretUpdatedAt).toBe('string');
      expect(Object.keys(c)).not.toContain('secret');
    }
    expect(put.raw.toString('utf8')).not.toContain(SECRET);

    const audits = await auditData(id);
    expect(audits.at(-1)).toMatchObject({ action: 'integration.endpoint.updated', data: { feature: 'INVOICE', secretChanged: true } });
    expect((audits.at(-1)!.data as any).changed).toEqual(expect.arrayContaining(['baseUrl', 'resourcePath', 'authType', 'username', 'fieldMap']));
    for (const a of audits) for (const s of forbidden) expect(a.text).not.toContain(s);

    // Sırsız güncelleme sırrı korur; secret:null kaldırır (058b), uç nokta kalır.
    expect((await h.call('tenantAdmin', 'PUT', url('INVOICE'), { body: { timeoutMs: 20000 } })).status).toBe(200);
    expect((await card('INVOICE')).secretSet).toBe(true);
  });

  it('kimlik türü değişimi (OAuth2): yeni sır mühürlenir, kullanıcı adı boşalır, sır yanıtta yok; açık özellik sırsız kalamaz', async () => {
    const put = await h.call('tenantAdmin', 'PUT', url('PURCHASE_ORDER'), { body: basic('PURCHASE_ORDER', { enabled: true }) });
    expect(put.status).toBe(200);
    const id = put.body.id as string;
    const swap = await h.call('tenantAdmin', 'PUT', url('PURCHASE_ORDER'), { body: { authType: 'OAUTH2_CLIENT_CREDENTIALS', clientId: 'sentetik-istemci', tokenUrl: 'taklit://token', secret: 'Yeni-Sentetik-Sir-1' } });
    expect(swap.status, JSON.stringify(swap.body)).toBe(200);
    const c = await card('PURCHASE_ORDER');
    expect(c).toMatchObject({ authType: 'OAUTH2_CLIENT_CREDENTIALS', clientId: 'sentetik-istemci', tokenUrl: 'taklit://token', username: null, secretSet: true, enabled: true });
    expect(JSON.stringify(c)).not.toContain('Yeni-Sentetik-Sir-1');
    // Açık özellikte sır kaldırılamaz (sır zorunlu); önce kapatılır.
    const gone = await h.call('tenantAdmin', 'PUT', url('PURCHASE_ORDER'), { body: { secret: null } });
    expect(gone.status).toBe(422);
    expect(gone.body.error.details.errors).toEqual(expect.arrayContaining([{ field: 'secret', code: 'required' }]));
    expect((await h.owner.query(`SELECT 1 FROM integration_endpoint_secrets WHERE endpoint_id = $1`, [id])).rowCount).toBe(1);
    // Açık özellik sırsız kaydedilemez ama kapatıp aynı istekte sırrı kaldırmak her zaman mümkündür.
    const off = await h.call('tenantAdmin', 'PUT', url('PURCHASE_ORDER'), { body: { secret: null, enabled: false } });
    expect(off.status, JSON.stringify(off.body)).toBe(200);
    expect((await card('PURCHASE_ORDER')).secretSet).toBe(false);
  });

  it('sır kaldırma (secret:null) satırı siler ve "ayarlı değil" gösterir; denetimde secretRemoved, değer yok', async () => {
    // Kapalı kayıtta sır kaldırma, ayarların geri kalanı geçersiz olsa bile her zaman mümkündür (sızıntı şüphesi).
    const put = await h.call('tenantAdmin', 'PUT', url('COST_CENTER'), { body: basic('COST_CENTER') });
    expect(put.status).toBe(200);
    const id = put.body.id as string;
    const r = await withConfig({ erp: { allowedHosts: [] } }, () => h.call('tenantAdmin', 'PUT', url('COST_CENTER'), { body: { secret: null } }));
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect((await card('COST_CENTER')).secretSet).toBe(false);
    expect((await h.owner.query(`SELECT 1 FROM integration_endpoint_secrets WHERE endpoint_id = $1`, [id])).rowCount).toBe(0);
    expect((await h.owner.query(`SELECT 1 FROM integration_endpoints WHERE id = $1`, [id])).rowCount).toBe(1);
    const last = (await auditData(id)).at(-1)!;
    expect(last.data).toMatchObject({ secretChanged: true, secretRemoved: true });
    expect(last.text).not.toContain(SECRET);
  });

  it('anahtar yokken sır kaydı 409 secret_key_not_configured (sır satırı yazılmaz)', async () => {
    await withConfig({ erp: { secretKey: null } }, async () => {
      const r = await h.call('tenantAdmin', 'PUT', url('PAYMENT_STATUS'), { body: basic('PAYMENT_STATUS') });
      expect(r.status).toBe(409);
      expect(r.body.error.code).toBe('secret_key_not_configured');
      expect(JSON.stringify(r.body)).not.toContain(SECRET);
      expect((await card('PAYMENT_STATUS')).secretKeyConfigured).toBe(false);
    });
    expect((await h.owner.query(`SELECT 1 FROM integration_endpoints WHERE tenant_id = $1 AND feature = 'PAYMENT_STATUS'`, [h.world.tenantA])).rowCount).toBe(0);
  });
});

describe('doğrulama (R4/R7/R8/R12)', () => {
  it('zorunlu alan eşlenmeden açma 422 mapping_incomplete (eksik alan listesi)', async () => {
    const r = await h.call('tenantAdmin', 'PUT', url('PAYMENT_STATUS'), { body: basic('PAYMENT_STATUS', { fieldMap: { invoiceNo: { path: 'INVOICE_NUM', transform: 'TRIM' } }, enabled: true }) });
    expect(r.status).toBe(422);
    expect(r.body.error.code).toBe('mapping_incomplete');
    expect(r.body.error.details.missing).toEqual(expect.arrayContaining(['supplierTaxId', 'status']));
    expect((await card('PAYMENT_STATUS')).enabled).toBe(false);
    // Eşleme tamamken kapalı kayıt da açık kayıt da geçer; zamanlama aralığı denetlenir.
    expect((await h.call('tenantAdmin', 'PUT', url('PAYMENT_STATUS'), { body: basic('PAYMENT_STATUS', { schedule: { mode: 'INTERVAL', intervalMinutes: 5 } }) })).body.error.details.errors)
      .toEqual(expect.arrayContaining([{ field: 'schedule.intervalMinutes', code: 'out_of_range' }]));
    const ok = await h.call('tenantAdmin', 'PUT', url('PAYMENT_STATUS'), { body: basic('PAYMENT_STATUS', { enabled: true, schedule: { mode: 'DAILY', dailyTime: '06:30' } }) });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect((await card('PAYMENT_STATUS')).schedule).toMatchObject({ mode: 'DAILY', dailyTime: '06:30' });
    // Yalnız kapatma her zaman mümkün.
    expect((await h.call('tenantAdmin', 'PUT', url('PAYMENT_STATUS'), { body: { enabled: false } })).status).toBe(200);
    expect((await card('PAYMENT_STATUS')).enabled).toBe(false);
  });

  it('listede olmayan host 422; taklit:// yalnız TAKLIT uç noktasında; oracle-ebs yapılandırmasında provider_kind ORACLE_EBS yazılır', async () => {
    const bad = await h.call('tenantAdmin', 'PUT', url('CONTRACT_HEADER'), { body: basic('CONTRACT_HEADER', { baseUrl: 'https://erp.baska-alan.example' }) });
    expect(bad.status).toBe(422);
    expect(bad.body.error.details.errors).toEqual(expect.arrayContaining([{ field: 'baseUrl', code: 'host_not_allowed' }]));
    const userinfo = await h.call('tenantAdmin', 'PUT', url('CONTRACT_HEADER'), { body: basic('CONTRACT_HEADER', { baseUrl: 'https://u:p@erp.example.test' }) });
    expect(userinfo.status).toBe(422);
    await withConfig({ erp: { provider: 'oracle-ebs' } }, async () => {
      const t = await h.call('tenantAdmin', 'PUT', url('CONTRACT_HEADER'), { body: basic('CONTRACT_HEADER') });
      expect(t.status).toBe(422);
      expect(t.body.error.details.errors).toEqual(expect.arrayContaining([{ field: 'baseUrl', code: 'scheme_invalid' }]));
      const ok = await h.call('tenantAdmin', 'PUT', url('CONTRACT_HEADER'), { body: basic('CONTRACT_HEADER', { baseUrl: 'https://erp.example.test/ebs' }) });
      expect(ok.status, JSON.stringify(ok.body)).toBe(200);
      const c = await card('CONTRACT_HEADER');
      expect(c.provider).toMatchObject({ kind: 'ORACLE_EBS', label: 'Oracle E-Business Suite', real: true, available: true });
      expect(c.schedule.mode).toBe('EVENT');
      // Üretimde http reddedilir.
      await withConfig({ env: 'production', erp: { provider: 'oracle-ebs' } }, async () => {
        const http = await h.call('tenantAdmin', 'PUT', url('CONTRACT_HEADER'), { body: basic('CONTRACT_HEADER', { baseUrl: 'http://erp.example.test/ebs' }) });
        expect(http.body.error.details.errors).toEqual(expect.arrayContaining([{ field: 'baseUrl', code: 'https_required' }]));
      });
    });
    // ERP_PROVIDER=none: kayıt kapalı tutulabilir, açılamaz.
    await withConfig({ erp: { provider: 'none' } }, async () => {
      const r = await h.call('tenantAdmin', 'PUT', url('CONTRACT_HEADER'), { body: { enabled: true, baseUrl: 'https://erp.example.test/ebs' } });
      expect(r.status).toBe(409);
      expect(r.body.error.code).toBe('provider_not_configured');
    });
  });
});

describe('bağlantıyı sına (taklit)', () => {
  it('taklit sınama: mock:true, ileti taklit etiketli, TEST çalışması ve last_test_*', async () => {
    expect((await h.call('tenantAdmin', 'PUT', url('INVOICE'), { body: basic('INVOICE', { enabled: true }) })).status).toBe(200);
    const t = await h.call('tenantAdmin', 'POST', url('INVOICE', '/test'));
    expect(t.status, JSON.stringify(t.body)).toBe(200);
    expect(t.body).toMatchObject({ ok: true, mock: true, message: TAKLIT_OK, status: 'SUCCESS' });
    expect(typeof t.body.latencyMs).toBe('number');
    expect(t.body.statusLabel).toContain('taklit sağlayıcıyla denendi');
    const run = (await h.owner.query(`SELECT trigger, provider_kind, mock, status FROM integration_runs WHERE id = $1`, [t.body.runId])).rows[0];
    expect(run).toEqual({ trigger: 'TEST', provider_kind: 'TAKLIT', mock: true, status: 'SUCCESS' });
    const c = await card('INVOICE', 'auditor');
    expect(c.lastTest).toMatchObject({ ok: true, message: TAKLIT_OK, mock: true });
    const runs = await h.call('buyer', 'GET', url('INVOICE', '/runs?limit=5'));
    expect(runs.status).toBe(200);
    expect(runs.body.items[0]).toMatchObject({ id: t.body.runId, trigger: 'TEST', triggerLabel: 'Bağlantı sınaması', mock: true,
      provider: { kind: 'TAKLIT', real: false }, requestedBy: { id: h.world.users.tenantAdmin.id } });
    expect(runs.body.items[0].statusLabel).toBe('Başarılı (taklit sağlayıcıyla denendi — gerçek Oracle değil)');
  });

  it('taklit://hata-401 → last_test_ok:false; ileti, hata kaydı ve denetimde sır yok', async () => {
    const put = await h.call('tenantAdmin', 'PUT', url('SUPPLIER'), { body: basic('SUPPLIER', { baseUrl: 'taklit://hata-401' }) });
    expect(put.status).toBe(200);
    const t = await h.call('tenantAdmin', 'POST', url('SUPPLIER', '/test'));
    expect(t.status).toBe(200);
    expect(t.body).toMatchObject({ ok: false, mock: true, status: 'FAILED' });
    expect(t.body.message).toContain('401');
    expect(t.raw.toString('utf8')).not.toContain(SECRET);
    const ep = (await h.owner.query(`SELECT last_test_ok, last_test_message FROM integration_endpoints WHERE id = $1`, [put.body.id])).rows[0];
    expect(ep.last_test_ok).toBe(false);
    expect(ep.last_test_message).not.toContain(SECRET);
    const errs = await h.call('auditor', 'GET', `/api/v1/integration/runs/${t.body.runId}/errors`);
    expect(errs.status).toBe(200);
    expect(errs.body.run).toMatchObject({ id: t.body.runId, status: 'FAILED', mock: true });
    expect(errs.body.items).toHaveLength(1);
    expect(errs.body.items[0]).toMatchObject({ code: 'connection_test_failed' });
    expect(errs.raw.toString('utf8')).not.toContain(SECRET);
    for (const a of await auditData(put.body.id)) expect(a.text).not.toContain(SECRET);
    // Başka kiracı başka kiracının çalışmasını göremez (404); kendi kartları varsayılan.
    expect((await h.call('buyerB', 'GET', `/api/v1/integration/runs/${t.body.runId}/errors`, { tenant: h.world.tenantB })).status).toBe(404);
    const b = await h.call('buyerB', 'GET', '/api/v1/integration/endpoints', { tenant: h.world.tenantB });
    expect(b.status).toBe(200);
    expect(b.body.items.every((c: any) => !c.enabled && !c.secretSet && c.baseUrl === null && c.lastTest === null)).toBe(true);
    expect((await h.call('buyerB', 'GET', url('SUPPLIER', '/runs'), { tenant: h.world.tenantB })).body.items).toEqual([]);
  });

  it('kaydedilmemiş uç nokta sınanamaz (409 endpoint_not_configured)', async () => {
    const r = await h.call('tenantAdmin', 'POST', url('REQUISITION', '/test'));
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe('endpoint_not_configured');
  });
});

describe('R3: ERP\'ye yazmayı açma', () => {
  it('her red nedeni: yazmayan özellik, kapalı, sınama yok/24 saatten eski, onay yok, üretimde taklit; bağlantı değişince kapanır', async () => {
    const we = (body: unknown = { confirm: true }) => h.call('tenantAdmin', 'POST', url('REQUISITION', '/write-enable'), { body });
    expect((await h.call('tenantAdmin', 'POST', url('INVOICE', '/write-enable'), { body: { confirm: true } })).body.error.code).toBe('feature_not_writable');
    // Satır yok / kapalı.
    let r = await we();
    expect([r.status, r.body.error.code]).toEqual([409, 'feature_disabled']);
    const put = await h.call('tenantAdmin', 'PUT', url('REQUISITION'), { body: basic('REQUISITION') });
    expect(put.status).toBe(200);
    r = await we();
    expect(r.body.error.code).toBe('feature_disabled');
    expect((await h.call('tenantAdmin', 'PUT', url('REQUISITION'), { body: { enabled: true } })).status).toBe(200);
    // Sınama yok.
    r = await we();
    expect([r.status, r.body.error.code]).toEqual([409, 'test_required']);
    expect(r.body.error.message).toContain('24 saat');
    // Başarısız sınama yetmez.
    expect((await h.call('tenantAdmin', 'POST', url('REQUISITION', '/test'))).body.ok).toBe(true);
    // Onay yok.
    r = await we({ confirm: false });
    expect([r.status, r.body.error.code]).toEqual([409, 'confirmation_required']);
    // Üretimde taklit.
    await withConfig({ env: 'production' }, async () => {
      const p = await we();
      expect([p.status, p.body.error.code]).toEqual([409, 'mock_in_production']);
    });
    // 24 saatten eski sınama.
    await h.owner.query(`UPDATE integration_endpoints SET last_test_at = now() - interval '25 hours' WHERE id = $1`, [put.body.id]);
    expect((await we()).body.error.code).toBe('test_required');
    await h.owner.query(`UPDATE integration_endpoints SET last_test_at = now() - interval '1 hour' WHERE id = $1`, [put.body.id]);
    // Hepsi sağlanınca açılır; kim/ne zaman saklanır.
    r = await we();
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.writeEnabled).toBe(true);
    const c = await card('REQUISITION', 'buyer');
    expect(c.writeEnabled).toBe(true);
    expect(c.writeConfirmation.by.id).toBe(h.world.users.tenantAdmin.id);
    expect((await auditData(put.body.id)).map((a) => a.action)).toContain('integration.endpoint.write_enabled');
    // Bağlantı ayarı değişince yazma kapanır ve sınama sonucu silinir.
    const ch = await h.call('tenantAdmin', 'PUT', url('REQUISITION'), { body: { resourcePath: '/webservices/rest/baska' } });
    expect(ch.body).toMatchObject({ writeEnabled: false, writeDisabled: true });
    const after = await card('REQUISITION');
    expect([after.writeEnabled, after.lastTest, after.writeConfirmation]).toEqual([false, null, null]);
    // Yeniden açıp DELETE ile kapatma.
    expect((await h.call('tenantAdmin', 'POST', url('REQUISITION', '/test'))).body.ok).toBe(true);
    expect((await we()).status).toBe(200);
    const off = await h.call('tenantAdmin', 'DELETE', url('REQUISITION', '/write-enable'));
    expect([off.status, off.body.writeEnabled]).toEqual([200, false]);
    expect((await auditData(put.body.id)).map((a) => a.action)).toContain('integration.endpoint.write_disabled');
    // Özellik kapanınca yazma da kapanır.
    expect((await h.call('tenantAdmin', 'POST', url('REQUISITION', '/test'))).body.ok).toBe(true);
    expect((await we()).status).toBe(200);
    expect((await h.call('tenantAdmin', 'PUT', url('REQUISITION'), { body: { enabled: false } })).body).toMatchObject({ writeEnabled: false, writeDisabled: true });
  });
});

describe('Şimdi çalıştır', () => {
  it('okuyan özellik: erp.read işi kuyruklanır ({ feature, runId }); sürerken ikinci istek 409; kapalı özellik NOT_CONFIGURED, iş yok', async () => {
    expect((await h.call('tenantAdmin', 'PUT', url('INVOICE'), { body: basic('INVOICE', { enabled: true }) })).status).toBe(200);
    const r = await h.call('tenantAdmin', 'POST', url('INVOICE', '/run'));
    expect(r.status, JSON.stringify(r.body)).toBe(202);
    expect(r.body).toMatchObject({ status: 'RUNNING', queued: 1 });
    const run = (await h.owner.query(`SELECT trigger, provider_kind, mock, status, requested_by FROM integration_runs WHERE id = $1`, [r.body.runId])).rows[0];
    expect(run).toEqual({ trigger: 'MANUAL', provider_kind: 'TAKLIT', mock: true, status: 'RUNNING', requested_by: h.world.users.tenantAdmin.id });
    const job = (await h.owner.query(`SELECT kind, idempotency_key, payload FROM jobs WHERE tenant_id = $1 AND payload->>'runId' = $2`, [h.world.tenantA, r.body.runId])).rows;
    expect(job).toEqual([{ kind: 'erp.read', idempotency_key: `erp.read:INVOICE:${h.world.tenantA}:manual:${r.body.runId}`, payload: { feature: 'INVOICE', runId: r.body.runId } }]);
    const again = await h.call('tenantAdmin', 'POST', url('INVOICE', '/run'));
    expect([again.status, again.body.error.code, again.body.error.details.runId]).toEqual([409, 'run_in_progress', r.body.runId]);
    expect((await card('INVOICE')).lastRun).toMatchObject({ id: r.body.runId, status: 'RUNNING', trigger: 'MANUAL', mock: true });

    const off = await h.call('tenantAdmin', 'POST', url('PAYMENT_STATUS', '/run'));
    expect(off.status).toBe(202);
    expect(off.body).toMatchObject({ status: 'NOT_CONFIGURED', reason: 'feature_disabled', queued: 0 });
    const offRun = (await h.owner.query(`SELECT provider_kind, mock, status, finished_at IS NOT NULL AS done FROM integration_runs WHERE id = $1`, [off.body.runId])).rows[0];
    expect(offRun).toEqual({ provider_kind: null, mock: false, status: 'NOT_CONFIGURED', done: true });
    expect((await h.owner.query(`SELECT 1 FROM jobs WHERE tenant_id = $1 AND payload->>'runId' = $2`, [h.world.tenantA, off.body.runId])).rowCount).toBe(0);
    expect((await h.call('tenantAdmin', 'POST', url('PAYMENT_STATUS', '/run'), { body: { target: 'WRITE_RETRY' } })).body.error.code).toBe('feature_not_writable');
    expect((await h.call('tenantAdmin', 'POST', url('PAYMENT_STATUS', '/run'), { body: { target: 'X' } })).status).toBe(400);
  });

  it('yazan özellik: yazma açık değilse (R3) iş yok, NOT_CONFIGURED; açıksa bekleyen/başarısız/belirsiz kayıtlar için erp.write', async () => {
    const put = await h.call('tenantAdmin', 'PUT', url('CONTRACT_HEADER'), { body: basic('CONTRACT_HEADER', { enabled: true }) });
    expect(put.status, JSON.stringify(put.body)).toBe(200);
    const closed = await h.call('tenantAdmin', 'POST', url('CONTRACT_HEADER', '/run'));
    expect(closed.body).toMatchObject({ status: 'NOT_CONFIGURED', reason: 'write_not_enabled', queued: 0 });
    expect((await h.call('tenantAdmin', 'POST', url('CONTRACT_HEADER', '/run'), { body: { target: 'READ' } })).body.error.code).toBe('feature_not_readable');
    expect((await h.call('tenantAdmin', 'POST', url('CONTRACT_HEADER', '/test'))).body.ok).toBe(true);
    expect((await h.call('tenantAdmin', 'POST', url('CONTRACT_HEADER', '/write-enable'), { body: { confirm: true } })).status).toBe(200);
    // Bekleyen kayıt yok → çalışma hemen kapanır.
    const empty = await h.call('tenantAdmin', 'POST', url('CONTRACT_HEADER', '/run'));
    expect(empty.body).toMatchObject({ status: 'SUCCESS', queued: 0 });
    const ins = (status: string) => h.owner.query<{ id: string }>(`INSERT INTO erp_outbound_records (tenant_id, feature, entity_type, entity_id, idempotency_key, status)
      VALUES ($1, 'CONTRACT_HEADER', 'CONTRACT', gen_random_uuid(), $2, $3) RETURNING id`, [h.world.tenantA, `t4:${status}:${Math.random()}`, status]);
    const ids = [(await ins('PENDING')).rows[0]!.id, (await ins('FAILED')).rows[0]!.id, (await ins('UNKNOWN')).rows[0]!.id];
    const r = await h.call('tenantAdmin', 'POST', url('CONTRACT_HEADER', '/run'));
    expect(r.body).toMatchObject({ status: 'RUNNING', queued: 3 });
    const jobs = (await h.owner.query<{ kind: string; payload: any }>(`SELECT kind, payload FROM jobs WHERE tenant_id = $1 AND payload->>'runId' = $2`, [h.world.tenantA, r.body.runId])).rows;
    expect(jobs.map((j) => j.kind)).toEqual(['erp.write', 'erp.write', 'erp.write']);
    expect(jobs.map((j) => j.payload.outboundId).sort()).toEqual([...ids].sort());
  });
});
