import { describe, expect, it } from 'vitest';
import { directoryProvider } from '../src/directory/provider.ts';
import type { Config } from '../src/config.ts';

const SECRET = 'S3cr3t-DEĞER-do-not-leak-9f8e7d';
const cfg: Config['directory'] = { kind: 'graph', tenantId: 'tenant-1', clientId: 'client-1', clientSecret: SECRET };

type Handler = (url: string, init?: RequestInit) => Response | Promise<Response>;
function fakeFetch(handler: Handler) {
  const calls: { url: string; init?: RequestInit }[] = [];
  const f = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init });
    return handler(url, init);
  }) as typeof fetch;
  return { f, calls };
}
const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
const isToken = (u: string) => u.startsWith('https://login.microsoftonline.com/tenant-1/oauth2/v2.0/token');
const gu = (n: number, extra: Record<string, unknown> = {}) => ({
  id: `id-${n}`, displayName: `Kişi ${n} (sentetik)`, mail: `k${n}@example.test`, userPrincipalName: `k${n}@example.test`,
  department: 'Finans', jobTitle: null, accountEnabled: true, onPremisesDistinguishedName: null, ...extra,
});
// $batch taklidi: her alt istek için yönetici 'mgr-1' (id'si 'nomgr' ile başlayan kullanıcı için 404).
function batchOk(init?: RequestInit) {
  const reqs = JSON.parse(String(init!.body)).requests as { id: string; url: string }[];
  return json({ responses: reqs.map((r) => r.url.includes('/nomgr') ? { id: r.id, status: 404, body: {} } : { id: r.id, status: 200, body: { id: 'mgr-1' } }) });
}
const noSleep = { sleep: async () => {} };

describe('Graph sağlayıcısı', () => {
  it('iki sayfalı grup: nextLink izlenir, kullanıcılar birleşir, alanlar eşlenir', async () => {
    const page2 = 'https://graph.microsoft.com/v1.0/groups/g1/transitiveMembers/microsoft.graph.user?$skiptoken=abc';
    const { f, calls } = fakeFetch((u, init) => {
      if (isToken(u)) return json({ access_token: 'tok-1', expires_in: 3600 });
      if (u.endsWith('/$batch')) return batchOk(init);
      if (u === page2) return json({ value: [gu(3, { mail: null })] });
      return json({ value: [gu(1), gu(2)], '@odata.nextLink': page2 });
    });
    const p = directoryProvider(cfg, f, noSleep)!;
    const users = await p.listUsers({ type: 'GROUP', value: 'g1' });
    expect(users.map((x) => x.objectId)).toEqual(['id-1', 'id-2', 'id-3']);
    expect(users[0]).toMatchObject({ email: 'k1@example.test', managerObjectId: 'mgr-1', accountEnabled: true });
    // mail yoksa UPN e-posta sayılmaz
    expect(users[2]!.email).toBeNull();
    expect(users[2]!.userPrincipalName).toBe('k3@example.test');
    const first = calls.find((c) => c.url.includes('/groups/g1/'))!;
    expect(first.url).toContain('/groups/g1/transitiveMembers/microsoft.graph.user');
    expect(first.url).toContain('$top=999');
    expect(first.url).not.toContain('$expand');
    expect(first.url).toContain('$count=true');
    expect((first.init!.headers as Record<string, string>).consistencylevel).toBe('eventual');
    expect(decodeURIComponent(first.url)).toContain('$select=id,displayName,mail,userPrincipalName,department,jobTitle,accountEnabled,onPremisesDistinguishedName');
    expect((first.init!.headers as Record<string, string>).authorization).toBe('Bearer tok-1');
    const tokenCall = calls.find((c) => isToken(c.url))!;
    expect(String(tokenCall.init!.body)).toContain('grant_type=client_credentials');
    expect(decodeURIComponent(String(tokenCall.init!.body))).toContain('scope=https://graph.microsoft.com/.default');
  });

  it('ADMIN_UNIT ve OU_FILTER adresleri', async () => {
    const { f, calls } = fakeFetch((u, init) => {
      if (isToken(u)) return json({ access_token: 't' });
      if (u.endsWith('/$batch')) return batchOk(init);
      return json({ value: [
        gu(1, { onPremisesDistinguishedName: 'CN=A,OU=BT,DC=example,DC=test' }),
        gu(2, { onPremisesDistinguishedName: 'CN=B,OU=Finans,DC=example,DC=test' }),
        gu(3),
      ] });
    });
    const p = directoryProvider(cfg, f, noSleep)!;
    await p.listUsers({ type: 'ADMIN_UNIT', value: 'au1' });
    expect(calls.some((c) => c.url.includes('/directory/administrativeUnits/au1/members/microsoft.graph.user'))).toBe(true);
    const ou = await p.listUsers({ type: 'OU_FILTER', value: 'ou=bt,dc=example,dc=test' });
    expect(calls.some((c) => /graph\.microsoft\.com\/v1\.0\/users\?/.test(c.url))).toBe(true);
    expect(ou.map((x) => x.objectId)).toEqual(['id-1']);
  });

  it('429 + Retry-After: 0 sonra 200: başarılı', async () => {
    let n = 0; const sleeps: number[] = [];
    const { f } = fakeFetch((u) => {
      if (isToken(u)) return json({ access_token: 't' });
      if (u.endsWith('/$batch')) return json({ responses: [] });
      return ++n === 1 ? json({}, 429, { 'retry-after': '0' }) : json({ value: [gu(1)] });
    });
    const p = directoryProvider(cfg, f, { sleep: async (ms) => { sleeps.push(ms); } })!;
    expect(await p.listUsers({ type: 'GROUP', value: 'g' })).toHaveLength(1);
    expect(n).toBe(2);
    expect(sleeps).toEqual([0]);
  });

  it('503 üç denemeden sonra vazgeçer (throttled), sonsuz döngü yok', async () => {
    let n = 0;
    const { f } = fakeFetch((u) => { if (isToken(u)) return json({ access_token: 't' }); n++; return json({}, 503, { 'retry-after': '1' }); });
    const p = directoryProvider(cfg, f, noSleep)!;
    await expect(p.listUsers({ type: 'GROUP', value: 'g' })).rejects.toMatchObject({ code: 'throttled' });
    expect(n).toBe(3);
  });

  it('401: testConnection unauthorized, mesajda sır yok', async () => {
    const { f } = fakeFetch((u) => {
      if (isToken(u)) return json({ error: 'invalid_client', error_description: `bad secret ${SECRET}` }, 401);
      return json({}, 401);
    });
    const p = directoryProvider(cfg, f, noSleep)!;
    const r = await p.testConnection();
    expect(r).toMatchObject({ ok: false, code: 'unauthorized' });
    expect(JSON.stringify(r)).not.toContain(SECRET);
    expect(JSON.stringify(p)).not.toContain(SECRET);
    let err: unknown;
    try { await p.listUsers({ type: 'GROUP', value: 'g' }); } catch (e) { err = e; }
    expect(err).toMatchObject({ code: 'unauthorized' });
    expect(String((err as Error).message) + JSON.stringify(err) + String((err as Error).stack)).not.toContain(SECRET);
  });

  it('ağ hatası: sır içermeyen network hatası', async () => {
    const { f } = fakeFetch(() => { throw new Error(`connect failed secret=${SECRET}`); });
    const p = directoryProvider(cfg, f, noSleep)!;
    const r = await p.testConnection();
    expect(r).toMatchObject({ ok: false, code: 'network' });
    expect(JSON.stringify(r)).not.toContain(SECRET);
  });

  it('testConnection başarılı', async () => {
    const { f } = fakeFetch((u) => isToken(u) ? json({ access_token: 't' }) : json({ value: [{ id: 'x' }] }));
    expect(await directoryProvider(cfg, f, noSleep)!.testConnection()).toEqual({ ok: true });
  });

  it('sayfa sınırı: 200 sayfadan sonra nextLink varsa too_many_pages', async () => {
    let pages = 0;
    const { f } = fakeFetch((u) => {
      if (isToken(u)) return json({ access_token: 't' });
      pages++;
      return json({ value: [gu(pages)], '@odata.nextLink': `https://graph.microsoft.com/v1.0/users?$skiptoken=${pages}` });
    });
    const p = directoryProvider(cfg, f, noSleep)!;
    await expect(p.listUsers({ type: 'GROUP', value: 'g' })).rejects.toMatchObject({ code: 'too_many_pages' });
    expect(pages).toBe(200);
  });

  it('nextLink başka bir sunucuya işaret ederse belirteç gönderilmez', async () => {
    const { f, calls } = fakeFetch((u) => {
      if (isToken(u)) return json({ access_token: 'tok-secret' });
      return json({ value: [gu(1)], '@odata.nextLink': 'https://evil.example.test/steal' });
    });
    const p = directoryProvider(cfg, f, noSleep)!;
    await expect(p.listUsers({ type: 'GROUP', value: 'g' })).rejects.toMatchObject({ code: 'bad_response' });
    expect(calls.some((c) => c.url.includes('evil.example.test'))).toBe(false);
  });
});

describe('Yönetici çözümü ($batch)', () => {
  it('üye uç noktalarında $expand görülürse 400: eşitleme yine de başarılı', async () => {
    const { f } = fakeFetch((u, init) => {
      if (isToken(u)) return json({ access_token: 't' });
      if (u.endsWith('/$batch')) return batchOk(init);
      if (decodeURIComponent(u).includes('$expand')) return json({}, 400);
      return json({ value: [gu(1), gu(2, { id: 'nomgr-2' })] });
    });
    for (const type of ['GROUP', 'ADMIN_UNIT'] as const) {
      const users = await directoryProvider(cfg, f, noSleep)!.listUsers({ type, value: 'x' });
      expect(users.map((x) => x.managerObjectId)).toEqual(['mgr-1', null]);
    }
  });
  it('20den fazla kullanıcı birden çok $batch isteğine bölünür; belirteç yalnız Graph\'a gider', async () => {
    const { f, calls } = fakeFetch((u, init) => {
      if (isToken(u)) return json({ access_token: 'tok-b' });
      if (u.endsWith('/$batch')) return batchOk(init);
      return json({ value: Array.from({ length: 45 }, (_, i) => gu(i + 1)) });
    });
    const users = await directoryProvider(cfg, f, noSleep)!.listUsers({ type: 'GROUP', value: 'g' });
    expect(users).toHaveLength(45);
    const batches = calls.filter((c) => c.url.endsWith('/$batch'));
    expect(batches).toHaveLength(3);
    expect(batches.map((b) => JSON.parse(String(b.init!.body)).requests.length)).toEqual([20, 20, 5]);
    for (const b of batches) {
      expect(b.url).toBe('https://graph.microsoft.com/v1.0/$batch');
      expect((b.init!.headers as Record<string, string>).authorization).toBe('Bearer tok-b');
    }
    expect(users.every((x) => x.managerObjectId === 'mgr-1')).toBe(true);
  });
  it('başarısız $batch ya da 404 alt isteği: yönetici null, eşitleme düşmez', async () => {
    const { f } = fakeFetch((u) => {
      if (isToken(u)) return json({ access_token: 't' });
      if (u.endsWith('/$batch')) return json({}, 500);
      return json({ value: [gu(1)] });
    });
    expect((await directoryProvider(cfg, f, noSleep)!.listUsers({ type: 'GROUP', value: 'g' }))[0]!.managerObjectId).toBeNull();
    const { f: f2 } = fakeFetch((u) => {
      if (isToken(u)) return json({ access_token: 't' });
      if (u.endsWith('/$batch')) throw new Error('ağ');
      return json({ value: [gu(1)] });
    });
    expect((await directoryProvider(cfg, f2, noSleep)!.listUsers({ type: 'GROUP', value: 'g' }))[0]!.managerObjectId).toBeNull();
  });
});

describe('Test sağlayıcısı ve fabrika', () => {
  const fixture = new URL('./fixtures/directory-test.json', import.meta.url).pathname;
  it('fixture döner, kind test ve etiket açık', async () => {
    const p = directoryProvider({ kind: 'test', testFixture: fixture })!;
    expect(p.kind).toBe('test');
    expect(p.label).toBe('Test dizini (gerçek Entra değil)');
    expect(p.tenantLabel).toBe('Test dizini (sentetik)');
    expect(await p.testConnection()).toEqual({ ok: true });
    const all = await p.listUsers({ type: 'GROUP', value: 'x' });
    expect(all).toHaveLength(3);
    expect(all.find((u) => u.email === null)).toBeTruthy();
    const bt = await p.listUsers({ type: 'OU_FILTER', value: 'OU=BT,OU=Merkez,DC=example,DC=test' });
    expect(bt).toHaveLength(2);
  });
  it('fixture okunamazsa testConnection ok:false', async () => {
    const p = directoryProvider({ kind: 'test', testFixture: '/yok/yok.json' })!;
    expect(await p.testConnection()).toMatchObject({ ok: false, code: 'fixture_unreadable' });
    expect(p.tenantLabel).toBe('Test dizini');
    expect(p.label).toBe('Test dizini (gerçek Entra değil)');
  });
  it('none → null; graph eksik yapılandırma → null değil hata değil: yapılandırma yükleyicisi doğrular', () => {
    expect(directoryProvider({ kind: 'none' })).toBeNull();
    expect(directoryProvider({ kind: 'graph', tenantId: 't' })).toBeNull();
  });
});

describe('Yapılandırma yükleyicisi', () => {
  const base = { DATABASE_URL: 'postgres://x', OBJECT_STORE_BUCKET: 'b', AUTH_MODE: 'dev', DEV_AUTH_SECRET: 's' };
  async function load(extra: Record<string, string>) {
    const { loadConfig } = await import('../src/config.ts');
    const saved = { ...process.env };
    for (const k of ['DIRECTORY_PROVIDER', 'ENTRA_TENANT_ID', 'ENTRA_CLIENT_ID', 'ENTRA_CLIENT_SECRET', 'DIRECTORY_TEST_FIXTURE']) delete process.env[k];
    Object.assign(process.env, base, extra);
    try { return loadConfig(); } finally { process.env = saved; }
  }
  it('varsayılan none', async () => { expect((await load({})).directory).toEqual({ kind: 'none' }); });
  it('graph üç değişkeni ister; hata sırrı yazmaz', async () => {
    await expect(load({ DIRECTORY_PROVIDER: 'graph', ENTRA_TENANT_ID: 't', ENTRA_CLIENT_SECRET: SECRET })).rejects.toThrow(/ENTRA_CLIENT_ID/);
    try { await load({ DIRECTORY_PROVIDER: 'graph', ENTRA_TENANT_ID: 't', ENTRA_CLIENT_SECRET: SECRET }); } catch (e) { expect(String((e as Error).message)).not.toContain(SECRET); }
    const ok = await load({ DIRECTORY_PROVIDER: 'graph', ENTRA_TENANT_ID: 't', ENTRA_CLIENT_ID: 'c', ENTRA_CLIENT_SECRET: SECRET });
    expect(ok.directory).toMatchObject({ kind: 'graph', tenantId: 't', clientId: 'c' });
  });
  it('test fixture yolu ister', async () => {
    await expect(load({ DIRECTORY_PROVIDER: 'test' })).rejects.toThrow(/DIRECTORY_TEST_FIXTURE/);
    expect((await load({ DIRECTORY_PROVIDER: 'test', DIRECTORY_TEST_FIXTURE: '/a.json' })).directory).toEqual({ kind: 'test', testFixture: '/a.json' });
  });
  it('geçersiz değer reddedilir', async () => { await expect(load({ DIRECTORY_PROVIDER: 'foo' })).rejects.toThrow(/DIRECTORY_PROVIDER/); });
});
