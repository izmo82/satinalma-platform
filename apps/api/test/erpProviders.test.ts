// v2 Faz 8 (D113) Görev 3: ERP sağlayıcıları. Taklit sağlayıcı ("Taklit Oracle (gerçek değil)") ve Oracle EBS bağdaştırıcısı.
// Oracle EBS yalnız yerel node:http test sunucusuna karşı sınanır; gerçek Oracle'a hiçbir istek atılmaz (gerçek Oracle kontrolleri NOT_RUN).
// Tüm kimlik bilgileri ve kayıtlar sentetiktir.
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { ERP_FEATURE_CATALOG, applyFieldMap, syntheticVkn, type ErpFeature } from '@sp/domain';
import { ErpTimeout } from '../src/erp/adapter.ts';
import { ErpProviderError, erpProvider, type ResolvedEndpoint } from '../src/erp/providers.ts';
import { TAKLIT_LABEL, resetTaklitStore, taklitProvider } from '../src/erp/taklit.ts';
import { clearOracleTokenCache, oracleEbsProvider } from '../src/erp/oracleEbs.ts';

const SECRET = 'Sentetik-EBS-Parola-ÇĞ-7x9!';
const CLIENT_SECRET = 'sentetik-istemci-sirri-0a1b2c3d';

const ep = (over: Partial<ResolvedEndpoint> = {}): ResolvedEndpoint => ({
  id: '00000000-0000-0000-0000-000000000001', tenantId: '00000000-0000-0000-0000-0000000000aa', feature: 'INVOICE',
  baseUrl: 'taklit://oracle', resourcePath: '/webservices/rest/sentetik', authType: 'BASIC', username: 'sentetik_kullanici', clientId: null,
  tokenUrl: null, secret: SECRET, timeoutMs: 2000, ...over,
});
const errOf = async (p: Promise<unknown>) => p.then(() => null, (e: unknown) => e as Error);

describe('erpProvider seçimi', () => {
  it('yapılandırmaya göre: none → null; taklit yalnız taklit kipinde ve üretim dışında; oracle-ebs yalnız oracle-ebs kipinde', () => {
    const base = { secretKey: null, allowedHosts: [] };
    expect(erpProvider('TAKLIT', { env: 'development', erp: { provider: 'none', ...base } })).toBeNull();
    expect(erpProvider('TAKLIT', { env: 'development' })).toBeNull();
    const t = erpProvider('TAKLIT', { env: 'development', erp: { provider: 'taklit', ...base } })!;
    expect(t).toMatchObject({ kind: 'TAKLIT', real: false, label: 'Taklit Oracle (gerçek değil)' });
    expect(erpProvider('ORACLE_EBS', { env: 'development', erp: { provider: 'taklit', ...base } })).toBeNull();
    expect(erpProvider('TAKLIT', { env: 'production', erp: { provider: 'taklit', ...base } })).toBeNull();
    expect(erpProvider('TAKLIT', { env: 'development', erp: { provider: 'oracle-ebs', ...base } })).toBeNull();
    expect(erpProvider('ORACLE_EBS', { env: 'production', erp: { provider: 'oracle-ebs', ...base } })).toMatchObject({ kind: 'ORACLE_EBS', real: true, label: 'Oracle E-Business Suite' });
  });
});

describe('taklit sağlayıcı', () => {
  afterEach(() => resetTaklitStore());
  const t = taklitProvider({ production: false });

  it('etiketli, gerçek değil; sına iletisi taklit olduğunu söyler', async () => {
    expect(TAKLIT_LABEL).toBe('Taklit Oracle (gerçek değil)');
    expect(t).toMatchObject({ kind: 'TAKLIT', real: false, label: TAKLIT_LABEL });
    const r = await t.test(ep());
    expect(r.ok).toBe(true);
    expect(r.message).toBe('Taklit sağlayıcıyla denendi — gerçek Oracle değil');
  });

  async function readAll(feature: ErpFeature, baseUrl = 'taklit://oracle') {
    const out: unknown[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const page = await t.read(ep({ feature, baseUrl }), feature, cursor);
      out.push(...page.records);
      cursor = page.nextCursor;
      pages++;
    } while (cursor && pages < 20);
    return { out, pages };
  }

  it('sentetik veri: tohum VKN\'li tedarikçi kodları, 3 masraf merkezi, 2 sipariş, 3 fatura, ödeme durumları; EBS eşlemesiyle hatasız', async () => {
    const sup = await readAll('SUPPLIER');
    const vkns = sup.out.map((r: any) => r.TAX_REGISTRATION_NUM);
    for (const p of ['930000001', '930000002', '930000003']) expect(vkns).toContain(syntheticVkn(p));
    expect(sup.pages).toBeGreaterThan(1); // sayfalı okuma
    expect((await readAll('COST_CENTER')).out).toHaveLength(3);
    expect((await readAll('PURCHASE_ORDER')).out).toHaveLength(2);
    const inv = (await readAll('INVOICE')).out;
    expect(inv).toHaveLength(3);
    const nos = inv.map((r: any) => r.INVOICE_NUM);
    for (const n of nos) expect(n).toMatch(/^TKL2026/);
    for (const demo of ['ANB2026000101', 'ANB2026000102', 'EGE2026000877']) expect(JSON.stringify(inv)).not.toContain(demo);
    const pay = (await readAll('PAYMENT_STATUS')).out;
    expect(pay.map((r: any) => r.PAYMENT_STATUS_FLAG).sort()).toEqual(['N', 'P', 'Y']);
    for (const f of ['SUPPLIER', 'COST_CENTER', 'PURCHASE_ORDER', 'INVOICE', 'PAYMENT_STATUS'] as const) {
      for (const rec of (await readAll(f)).out) expect(applyFieldMap(ERP_FEATURE_CATALOG[f].ebsDefaultMap, rec, f).errors).toEqual([]);
    }
  });

  it('taklit://bozuk-tutar: tutarlı özelliklerde bir satırın tutarı bozuk, diğerleri geçerli', async () => {
    for (const f of ['INVOICE', 'PURCHASE_ORDER', 'PAYMENT_STATUS'] as const) {
      const recs = (await readAll(f, 'taklit://bozuk-tutar')).out;
      const errs = recs.map((r) => applyFieldMap(ERP_FEATURE_CATALOG[f].ebsDefaultMap, r, f).errors);
      expect(errs.filter((e) => e.length).length).toBe(1);
      expect(errs.flat()[0]!.code).toBe('invalid_decimal');
    }
  });

  it('taklit://hata-401: sına başarısız, okuma/yazma ErpProviderError; iletide sır yok', async () => {
    const e401 = ep({ baseUrl: 'taklit://hata-401' });
    const r = await t.test(e401);
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/401/);
    expect(r.message).toMatch(/taklit/i);
    const err = await errOf(t.read(e401, 'INVOICE', null));
    expect(err).toBeInstanceOf(ErpProviderError);
    expect((err as ErpProviderError).code).toBe('http_401');
    expect(err!.message).not.toContain(SECRET);
    expect(await errOf(t.write(ep({ baseUrl: 'taklit://hata-401', feature: 'SUPPLIER' }), 'SUPPLIER', { taxId: '1' }, 'k1'))).toBeInstanceOf(ErpProviderError);
  });

  it('taklit://zaman-asimi: yazma kaydı oluşturur ama ErpTimeout verir; find aynı anahtarla bulur; yazma idempotent', async () => {
    const e = ep({ baseUrl: 'taklit://zaman-asimi', feature: 'SUPPLIER' });
    expect((await t.test(e)).ok).toBe(false);
    expect(await errOf(t.read(e, 'SUPPLIER', null))).toBeInstanceOf(ErpTimeout);
    expect(await t.find(e, 'SUPPLIER', 'erp:SUPPLIER:x:v1')).toBeNull();
    expect(await errOf(t.write(e, 'SUPPLIER', { taxId: syntheticVkn('930000001') }, 'erp:SUPPLIER:x:v1'))).toBeInstanceOf(ErpTimeout);
    const found = await t.find(e, 'SUPPLIER', 'erp:SUPPLIER:x:v1');
    expect(found?.externalRef).toMatch(/^TKL-/);
    const ok = ep({ feature: 'SUPPLIER' });
    const w1 = await t.write(ok, 'SUPPLIER', { taxId: '1' }, 'erp:SUPPLIER:y:v1');
    const w2 = await t.write(ok, 'SUPPLIER', { taxId: '1' }, 'erp:SUPPLIER:y:v1');
    expect(w2.externalRef).toBe(w1.externalRef);
    // Başka kiracının aynı anahtarı ayrı
    expect(await t.find(ep({ feature: 'SUPPLIER', tenantId: '00000000-0000-0000-0000-0000000000bb' }), 'SUPPLIER', 'erp:SUPPLIER:y:v1')).toBeNull();
  });

  it('yön özellikten gelir: okuma-yalnız özelliğe yazma, yazma-yalnız özellikten okuma reddedilir', async () => {
    expect(await errOf(t.write(ep(), 'INVOICE', {}, 'k'))).toBeInstanceOf(ErpProviderError);
    expect(await errOf(t.read(ep({ feature: 'REQUISITION' }), 'REQUISITION', null))).toBeInstanceOf(ErpProviderError);
  });

  it('üretimde taklitle yazma reddedilir (savunma katmanı; yapılandırma zaten açılmaz)', async () => {
    const prod = taklitProvider({ production: true });
    const err = await errOf(prod.write(ep({ feature: 'SUPPLIER' }), 'SUPPLIER', { taxId: '1' }, 'k'));
    expect((err as ErpProviderError).code).toBe('mock_write_in_production');
  });
});

// ---------- Oracle EBS: yerel test sunucusu ----------

type Hit = { method: string; url: string; headers: IncomingMessage['headers']; body: string };
let server: Server;
let base = '';
let hits: Hit[] = [];
const PAGE = Array.from({ length: 5 }, (_, i) => ({ INVOICE_NUM: `TKL2026EBS${i + 1}`, INVOICE_AMOUNT: `${(i + 1) * 100}.00` }));
const basicOk = 'Basic ' + Buffer.from(`sentetik_kullanici:${SECRET}`).toString('base64');
let tokenCount = 0;

function handler(req: IncomingMessage, res: ServerResponse) {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    hits.push({ method: req.method!, url: req.url!, headers: req.headers, body });
    const u = new URL(req.url!, 'http://x');
    const send = (status: number, obj: unknown, headers: Record<string, string> = {}) => {
      res.writeHead(status, { 'content-type': 'application/json', ...headers });
      res.end(typeof obj === 'string' ? obj : JSON.stringify(obj));
    };
    if (u.pathname === '/oauth/token') {
      tokenCount++;
      const p = new URLSearchParams(body);
      if (p.get('grant_type') !== 'client_credentials' || p.get('client_id') !== 'sentetik-istemci' || p.get('client_secret') !== CLIENT_SECRET) return send(401, { error: 'invalid_client' });
      return send(200, { access_token: `tok-${tokenCount}`, token_type: 'Bearer', expires_in: 3600 });
    }
    if (u.pathname === '/redirect/items') return send(302, '', { location: `${base}/elsewhere` });
    if (u.pathname === '/elsewhere') return send(200, { items: [] });
    if (u.pathname === '/slow/items') { setTimeout(() => send(200, { items: [] }), 1500); return; }
    if (u.pathname === '/leak/items') return send(500, `${' '.repeat(40)}${'x'.repeat(282)}\n\n  sifre=${SECRET} son`);
    if (u.pathname === '/big/items') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.on('error', () => {});
      const chunk = Buffer.alloc(1024 * 1024, 0x20);
      let sent = 0;
      const pump = () => { while (sent < 12 && !res.destroyed) { sent++; if (!res.write(chunk)) { res.once('drain', pump); return; } } if (!res.destroyed) res.end(); };
      pump();
      return;
    }
    if (u.pathname === '/bigtoken/token') { tokenCount++; return send(200, { access_token: 't'.repeat(70 * 1024), expires_in: 3600 }); }
    if (u.pathname === '/unauth/items') return send(401, `{"error":"denied","echo":"${req.headers.authorization}","password":"${SECRET}"}`);
    const auth = req.headers.authorization;
    if (auth !== basicOk && !(auth ?? '').startsWith('Bearer tok-')) return send(401, { error: 'unauthorized' });
    if (u.pathname === '/rest/items' && req.method === 'GET') {
      const key = u.searchParams.get('idempotency_key');
      if (key) return key === 'known-key' ? send(200, { items: [{ idempotencyKey: 'known-key', externalRef: 'EBS-REF-77' }] }) : send(200, { items: [] });
      const offset = Number(u.searchParams.get('offset'));
      const limit = Number(u.searchParams.get('limit'));
      const items = PAGE.slice(offset, offset + limit);
      return send(200, { items, hasMore: offset + limit < PAGE.length, offset, limit, count: items.length });
    }
    // ERP sorguyu yok sayar: anahtardan bağımsız kayıt(lar) döner.
    if (u.pathname === '/ignore/items') return send(200, { items: [{ externalRef: 'EBS-X1' }, { externalRef: 'EBS-X2' }] });
    if (u.pathname === '/ignore1/items') return send(200, { items: [{ externalRef: 'EBS-X1', idempotencyKey: 'baska-anahtar' }] });
    if (u.pathname === '/ignore0/items') return send(200, { items: [{ externalRef: 'EBS-X1' }] });
    // offset'i yok sayan ERP: her sayfa aynı.
    if (u.pathname === '/loop/items') return send(200, { items: PAGE.slice(0, 2), hasMore: true });
    if (u.pathname === '/rest/items' && req.method === 'POST') {
      if (!req.headers['idempotency-key']) return send(400, { error: 'idempotency' });
      return send(201, { externalRef: `EBS-${req.headers['idempotency-key']}` });
    }
    return send(404, { error: 'not_found' });
  });
}

beforeAll(async () => {
  server = createServer(handler);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => { server.closeAllConnections(); await new Promise((r) => server.close(r)); });

describe('Oracle EBS bağdaştırıcısı (yerel test sunucusu)', () => {
  afterEach(() => { hits = []; clearOracleTokenCache(); });
  const o = (opts: { production?: boolean; allowedHosts?: string[] } = {}) =>
    oracleEbsProvider({ allowedHosts: opts.allowedHosts ?? ['127.0.0.1'], production: opts.production ?? false, pageSize: 2 });
  const ebs = (over: Partial<ResolvedEndpoint> = {}) => ep({ baseUrl: base, resourcePath: '/rest/items', ...over });
  const oauth = (over: Partial<ResolvedEndpoint> = {}) => ebs({ authType: 'OAUTH2_CLIENT_CREDENTIALS', username: null, clientId: 'sentetik-istemci',
    tokenUrl: `${base}/oauth/token`, secret: CLIENT_SECRET, ...over });

  it('gerçek sağlayıcı olarak etiketli', () => {
    expect(o()).toMatchObject({ kind: 'ORACLE_EBS', real: true, label: 'Oracle E-Business Suite' });
  });

  it('Basic başlığı ve offset/limit sayfalaması', async () => {
    const p = o();
    const all: any[] = [];
    let cursor: string | null = null;
    let n = 0;
    do { const r = await p.read(ebs(), 'INVOICE', cursor); all.push(...r.records); cursor = r.nextCursor; n++; } while (cursor && n < 10);
    expect(all.map((x) => x.INVOICE_NUM)).toEqual(PAGE.map((x) => x.INVOICE_NUM));
    expect(n).toBe(3);
    expect(hits.map((h) => new URL(h.url, 'http://x').search)).toEqual(['?offset=0&limit=2', '?offset=2&limit=2', '?offset=4&limit=2']);
    expect(hits[0]!.headers.authorization).toBe(basicOk);
    expect(hits[0]!.headers.accept).toContain('application/json');
  });

  it('OAuth2 client credentials: token bir kez alınır, bellekte önbelleklenir', async () => {
    const p = o();
    const before = tokenCount;
    await p.read(oauth(), 'INVOICE', null);
    await p.read(oauth(), 'INVOICE', '2');
    expect(tokenCount - before).toBe(1);
    const resourceHits = hits.filter((h) => h.url.startsWith('/rest/'));
    expect(resourceHits.every((h) => /^Bearer tok-\d+$/.test(String(h.headers.authorization)))).toBe(true);
    const tokenHit = hits.find((h) => h.url === '/oauth/token')!;
    expect(tokenHit.method).toBe('POST');
    expect(tokenHit.headers['content-type']).toContain('application/x-www-form-urlencoded');
    // Yanlış sır: token alınamaz, iletide sır yok
    clearOracleTokenCache();
    const err = await errOf(p.read(oauth({ secret: 'yanlis-sentetik-sir-123' }), 'INVOICE', null));
    expect(err).toBeInstanceOf(ErpProviderError);
    expect(err!.message).not.toContain('yanlis-sentetik-sir-123');
  });

  it('sına: başarıda gecikme ve ileti, istek gerçekten atılır', async () => {
    const r = await o().test(ebs());
    expect(r.ok).toBe(true);
    expect(r.latencyMs).toBeGreaterThanOrEqual(0);
    expect(hits).toHaveLength(1);
  });

  it('3xx izlenmez', async () => {
    const err = await errOf(o().read(ebs({ resourcePath: '/redirect/items' }), 'INVOICE', null));
    expect((err as ErpProviderError).code).toBe('redirect_not_followed');
    expect(hits.some((h) => h.url.startsWith('/elsewhere'))).toBe(false);
    const t = await o().test(ebs({ resourcePath: '/redirect/items' }));
    expect(t.ok).toBe(false);
  });

  it('zaman aşımı ErpTimeout; sına ok:false', async () => {
    const err = await errOf(o().read(ebs({ resourcePath: '/slow/items', timeoutMs: 200 }), 'INVOICE', null));
    expect(err).toBeInstanceOf(ErpTimeout);
    const err2 = await errOf(o().write(ebs({ resourcePath: '/slow/items', timeoutMs: 200, feature: 'SUPPLIER' }), 'SUPPLIER', { taxId: '1' }, 'k'));
    expect(err2).toBeInstanceOf(ErpTimeout);
    const t = await o().test(ebs({ resourcePath: '/slow/items', timeoutMs: 200 }));
    expect(t.ok).toBe(false);
    expect(t.message).toMatch(/zaman aşımı/i);
  });

  it('401 iletisinde parola, Basic değeri ve token yok', async () => {
    const err = await errOf(o().read(ebs({ resourcePath: '/unauth/items' }), 'INVOICE', null));
    expect((err as ErpProviderError).code).toBe('http_401');
    const b64 = Buffer.from(`sentetik_kullanici:${SECRET}`).toString('base64');
    for (const m of [err!.message, String((err as Error).stack)]) {
      expect(m).not.toContain(SECRET);
      expect(m).not.toContain(b64);
    }
    const t = await o().test(ebs({ resourcePath: '/unauth/items' }));
    expect(t.ok).toBe(false);
    expect(t.message).toMatch(/401/);
    expect(t.message).not.toContain(SECRET);
    expect(t.message).not.toContain(b64);
    const t2 = await o().test(oauth({ resourcePath: '/unauth/items' }));
    expect(t2.message).not.toMatch(/tok-\d+/);
    expect(t2.message).not.toContain(CLIENT_SECRET);
  });

  it('yazma: Idempotency-Key başlığı ve JSON gövde; find anahtarla sorgular', async () => {
    const p = o();
    const w = await p.write(ebs({ feature: 'SUPPLIER' }), 'SUPPLIER', { taxId: syntheticVkn('930000001'), legalName: null }, 'erp:SUPPLIER:abc:v1');
    expect(w.externalRef).toBe('EBS-erp:SUPPLIER:abc:v1');
    const post = hits.find((h) => h.method === 'POST')!;
    expect(post.headers['idempotency-key']).toBe('erp:SUPPLIER:abc:v1');
    expect(post.headers['content-type']).toContain('application/json');
    expect(JSON.parse(post.body)).toEqual({ taxId: syntheticVkn('930000001'), legalName: null });
    expect(await p.find(ebs({ feature: 'SUPPLIER' }), 'SUPPLIER', 'known-key')).toEqual({ externalRef: 'EBS-REF-77' });
    expect(await p.find(ebs({ feature: 'SUPPLIER' }), 'SUPPLIER', 'unknown-key')).toBeNull();
  });

  it('find kapalı kalır: ERP sorguyu yok sayarsa (çok kayıt) ambiguous_find; anahtarı yansıtmayan tek kayıt eşleşme değil', async () => {
    const p = o();
    const e = (path: string) => ebs({ feature: 'SUPPLIER', resourcePath: path });
    expect(((await errOf(p.find(e('/ignore/items'), 'SUPPLIER', 'erp:SUPPLIER:z:v1'))) as ErpProviderError).code).toBe('ambiguous_find');
    expect(await p.find(e('/ignore1/items'), 'SUPPLIER', 'erp:SUPPLIER:z:v1')).toBeNull();
    expect(await p.find(e('/ignore0/items'), 'SUPPLIER', 'erp:SUPPLIER:z:v1')).toBeNull();
  });

  it('hata iletisi: önce tam metin arındırılır, sonra kesilir (kesim noktasındaki sır parçası sızmaz)', async () => {
    const err = await errOf(o().read(ebs({ resourcePath: '/leak/items' }), 'INVOICE', null));
    expect((err as ErpProviderError).code).toBe('http_500');
    // Sır, daraltılmış metinde 300. karakterin üstüne denk gelir; hiçbir öneki iletide yok.
    for (let n = 4; n <= SECRET.length; n++) expect(err!.message).not.toContain(SECRET.slice(0, n));
  });

  it('yanıt boyutu sınırı: kaynak 10 MB, token 64 KB aşılınca response_too_large', async () => {
    const err = await errOf(o().read(ebs({ resourcePath: '/big/items', timeoutMs: 10_000 }), 'INVOICE', null));
    expect((err as ErpProviderError).code).toBe('response_too_large');
    const err2 = await errOf(o().read(oauth({ tokenUrl: `${base}/bigtoken/token` }), 'INVOICE', null));
    expect((err2 as ErpProviderError).code).toBe('response_too_large');
  });

  it('sayfalama döngü koruması: ilk sayfa yinelenirse ya da sayfa sınırı aşılırsa paging_loop', async () => {
    const p = o();
    const e = ebs({ resourcePath: '/loop/items' });
    const first = await p.read(e, 'INVOICE', null);
    expect(first.nextCursor).toBe('2');
    expect(((await errOf(p.read(e, 'INVOICE', first.nextCursor))) as ErpProviderError).code).toBe('paging_loop');
    expect(((await errOf(p.read(ebs(), 'INVOICE', String(1000 * 2)))) as ErpProviderError).code).toBe('paging_loop');
  });

  it('izinli olmayan host, üretimde http ve kullanıcı bilgili adres: istek atılmaz', async () => {
    expect(((await errOf(o({ allowedHosts: [] }).read(ebs(), 'INVOICE', null))) as ErpProviderError).code).toBe('host_not_allowed');
    expect(((await errOf(o({ production: true }).read(ebs(), 'INVOICE', null))) as ErpProviderError).code).toBe('https_required');
    expect(((await errOf(o().read(ebs({ baseUrl: base.replace('http://', 'http://u:p@') }), 'INVOICE', null))) as ErpProviderError).code).toBe('userinfo_not_allowed');
    // Token adresi de denetlenir
    expect(((await errOf(o().read(oauth({ tokenUrl: 'http://evil.example.test/token' }), 'INVOICE', null))) as ErpProviderError).code).toBe('host_not_allowed');
    expect(hits).toHaveLength(0);
  });

  it('sır yoksa istek atılmaz', async () => {
    expect(((await errOf(o().read(ebs({ secret: null }), 'INVOICE', null))) as ErpProviderError).code).toBe('secret_missing');
    expect(hits).toHaveLength(0);
  });
});
