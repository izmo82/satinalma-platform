// v2 Faz 2 (D105) Görev 4: Yönetim API'si — dizin bağlantısı, eşitlenen kullanıcılar, rol ataması (R3), departman birleştirme (R6).
// Bellekteki sahte dizin sağlayıcısı (kind 'test') ve sahte fetch'li Graph sağlayıcısı; ağ yok, gerçek PostgreSQL. Veriler sentetik.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { createSyntheticWorld, type SyntheticWorld } from '../src/devdata.ts';
import { DevAuthProvider } from '../src/auth.ts';
import { directoryProvider, type DirectoryProvider, type DirectoryUser } from '../src/directory/provider.ts';
import { TEST_LABEL } from '../src/directory/testProvider.ts';
import { directoryJobContext, processDirectorySync, setDirectoryUserRoles } from '../src/modules/directory.ts';
import { withTenant, type TenantContext } from '../src/db.ts';
import { ApiError } from '../src/errors.ts';
import { makeHarness } from './harness.ts';

/** YALNIZ TEST: bellekteki sahte dizin. */
function fakeProvider(initial: DirectoryUser[] = []) {
  const p = {
    result: initial,
    kind: 'test' as const, label: TEST_LABEL, tenantLabel: 'test',
    async testConnection() { return { ok: true as const }; },
    async listUsers() { return p.result.map((u) => ({ ...u })); },
  };
  return p satisfies DirectoryProvider;
}

function du(objectId: string, email: string | null, department: string | null, extra: Partial<DirectoryUser> = {}): DirectoryUser {
  return { objectId, email, displayName: `${objectId} (sentetik)`, userPrincipalName: `${objectId}@example.test`, department, jobTitle: 'Uzman (sentetik)',
    managerObjectId: null, accountEnabled: true, onPremisesDistinguishedName: null, ...extra };
}

const SENTINEL_SECRET = `sentinel-secret-${randomUUID()}`;
const fake = fakeProvider();
let h: Awaited<ReturnType<typeof makeHarness>>;
let hNone: Awaited<ReturnType<typeof makeHarness>>;
let hGraph: Awaited<ReturnType<typeof makeHarness>>;
let auth: DevAuthProvider;

beforeAll(async () => {
  h = await makeHarness({}, { directoryProvider: fake });
  hNone = await makeHarness({}, { directoryProvider: null });
  // Graph sağlayıcısı sahte fetch ile: belirteç ucu sırrı yankılayan bir hata döndürür (sır hiçbir yanıta geçmemeli).
  const graphCfg = { kind: 'graph' as const, tenantId: 'entra-tenant-sentetik', clientId: 'client-sentetik', clientSecret: SENTINEL_SECRET };
  const fakeFetch = (async () => new Response(JSON.stringify({ error: 'invalid_client', error_description: `bad secret ${SENTINEL_SECRET}` }),
    { status: 401, headers: { 'content-type': 'application/json' } })) as unknown as typeof fetch;
  hGraph = await makeHarness({ directory: graphCfg }, { directoryProvider: directoryProvider(graphCfg, fakeFetch, { sleep: async () => {} }) });
  auth = new DevAuthProvider(h.config.devAuthSecret!);
});
afterAll(async () => { await h.close(); await hNone.close(); await hGraph.close(); });

type H = typeof h;
type UserKey = keyof SyntheticWorld['users'];

async function freshWorld(hh: H = h): Promise<SyntheticWorld> { return createSyntheticWorld(hh.owner, `-${randomUUID().slice(0, 8)}`); }

/** Taze dünyanın kullanıcısı adına istek. */
async function as(w: SyntheticWorld, who: UserKey, method: string, url: string, body?: unknown, hh: H = h) {
  const token = await auth.issue(`dev|${w.users[who].email}`);
  const res = await hh.app.inject({ method: method as any, url, headers: { authorization: `Bearer ${token}`, 'x-tenant-id': w.tenantA },
    ...(body !== undefined ? { payload: body as any } : {}) });
  let parsed: any = null;
  try { parsed = res.body ? JSON.parse(res.body) : null; } catch { parsed = res.body; }
  return { status: res.statusCode, body: parsed, raw: res.body };
}

async function enable(w: SyntheticWorld, hh: H = h) {
  const r = await as(w, 'tenantAdmin', 'PUT', '/api/v1/directory/connection', { scopeType: 'GROUP', scopeValue: 'grp-sentetik', enabled: true }, hh);
  expect(r.status).toBe(200);
}

/** "Şimdi eşitle" ucu + işçi ile aynı işleme. */
async function syncNow(w: SyntheticWorld, users: DirectoryUser[]) {
  fake.result = users;
  const r = await as(w, 'tenantAdmin', 'POST', '/api/v1/directory/sync');
  expect(r.status).toBe(202);
  const job = (await h.owner.query<{ id: string; tenant_id: string; requested_by: string | null }>(
    `SELECT id, tenant_id, requested_by FROM jobs WHERE kind = 'directory.sync' AND payload->>'runId' = $1`, [r.body.runId])).rows[0]!;
  await processDirectorySync(h.pool, fake, job.id, directoryJobContext(job.tenant_id, job.requested_by, job.id));
  return r.body.runId as string;
}

async function dirUserId(w: SyntheticWorld, objectId: string) {
  return (await h.owner.query<{ id: string }>(`SELECT id FROM directory_users WHERE tenant_id = $1 AND entra_object_id = $2`, [w.tenantA, objectId])).rows[0]!.id;
}

async function membershipOf(tenantId: string, userId: string) {
  return (await h.owner.query<{ status: string; roles: string[]; company_ids: string[]; department_ids: string[]; directory_department_id: string | null;
    suspended_by_directory: boolean }>(`SELECT * FROM memberships WHERE tenant_id = $1 AND user_id = $2`, [tenantId, userId])).rows[0];
}

const count = async (sql: string, params: unknown[]) => (await h.owner.query<{ n: number }>(sql, params)).rows[0]!.n;
const sfx = () => randomUUID().slice(0, 8);

describe('yetki matrisi', () => {
  it('Yönetici her şeyi; Denetçi yalnız okur; Satınalma ve Departman kullanıcısı 403', async () => {
    const w = await freshWorld();
    await enable(w);
    const id = randomUUID();
    const reads: [string, string][] = [['GET', '/api/v1/directory/connection'], ['GET', '/api/v1/directory/runs'], ['GET', '/api/v1/directory/users']];
    const writes: [string, string, unknown][] = [
      ['PUT', '/api/v1/directory/connection', { scopeType: 'GROUP', scopeValue: 'grp-sentetik', enabled: true }],
      ['POST', '/api/v1/directory/connection/test', undefined],
      ['PUT', `/api/v1/directory/users/${id}/roles`, { roles: ['PROCUREMENT'] }],
      ['POST', `/api/v1/departments/${id}/merge`, { intoId: randomUUID(), confirm: true }],
    ];
    for (const [m, u] of reads) {
      expect((await as(w, 'tenantAdmin', m, u)).status, `${m} ${u} admin`).toBe(200);
      expect((await as(w, 'auditor', m, u)).status, `${m} ${u} auditor`).toBe(200);
      expect((await as(w, 'buyer', m, u)).status, `${m} ${u} buyer`).toBe(403);
      expect((await as(w, 'security', m, u)).status, `${m} ${u} dept user`).toBe(403);
      expect((await as(w, 'supplier1', m, u)).status, `${m} ${u} supplier`).toBe(403);
    }
    for (const [m, u, b] of [...writes, ['POST', '/api/v1/directory/sync', undefined] as [string, string, unknown]]) {
      for (const who of ['auditor', 'buyer', 'security', 'supplier1'] as const) {
        expect((await as(w, who, m, u, b)).status, `${m} ${u} ${who}`).toBe(403);
      }
    }
    // Yönetici yazabilir (olmayan kayıtta 404, yetki geçer).
    expect((await as(w, 'tenantAdmin', 'PUT', writes[0]![1], writes[0]![2])).status).toBe(200);
    expect((await as(w, 'tenantAdmin', 'POST', '/api/v1/directory/connection/test')).status).toBe(200);
    expect((await as(w, 'tenantAdmin', 'PUT', writes[2]![1], writes[2]![2])).status).toBe(404);
    expect((await as(w, 'tenantAdmin', 'POST', writes[3]![1], writes[3]![2])).status).toBe(404);
    expect((await as(w, 'tenantAdmin', 'POST', '/api/v1/directory/sync')).status).toBe(202);
  });
});

describe('bağlantı', () => {
  it('kapsam kaydı, boş kapsam 422, sağlayıcı etiketi ve bağlantı testi', async () => {
    const w = await freshWorld();
    const g0 = await as(w, 'tenantAdmin', 'GET', '/api/v1/directory/connection');
    expect(g0.status).toBe(200);
    expect(g0.body).toEqual({ provider: { kind: 'test', label: TEST_LABEL, tenantLabel: 'test', configured: true }, scope: null, enabled: false, lastRun: null });
    for (const scopeValue of ['', '   ']) {
      const bad = await as(w, 'tenantAdmin', 'PUT', '/api/v1/directory/connection', { scopeType: 'GROUP', scopeValue, enabled: true });
      expect(bad.status).toBe(422);
      expect(bad.body.error.code).toBe('invalid_scope');
    }
    expect((await as(w, 'tenantAdmin', 'PUT', '/api/v1/directory/connection', { scopeType: 'BOGUS', scopeValue: 'x', enabled: true })).status).toBe(400);
    const put = await as(w, 'tenantAdmin', 'PUT', '/api/v1/directory/connection', { scopeType: 'OU_FILTER', scopeValue: ' OU=Merkez,DC=example,DC=test ', enabled: true });
    expect(put.status).toBe(200);
    const g1 = await as(w, 'auditor', 'GET', '/api/v1/directory/connection');
    expect(g1.body.scope).toEqual({ type: 'OU_FILTER', value: 'OU=Merkez,DC=example,DC=test' });
    expect(g1.body.enabled).toBe(true);
    expect(await count(`SELECT count(*)::int AS n FROM audit_events WHERE tenant_id = $1 AND action = 'directory.connection.updated'`, [w.tenantA])).toBe(1);
    const t = await as(w, 'tenantAdmin', 'POST', '/api/v1/directory/connection/test');
    expect(t.status).toBe(200);
    expect(t.body).toMatchObject({ ok: true, provider: { kind: 'test', label: TEST_LABEL } });
  });

  it('sağlayıcı yapılandırılmamışsa provider null; eşitleme ve test 409 not_configured', async () => {
    const w = await freshWorld(hNone);
    const g = await as(w, 'tenantAdmin', 'GET', '/api/v1/directory/connection', undefined, hNone);
    expect(g.status).toBe(200);
    expect(g.body.provider).toBeNull();
    const s = await as(w, 'tenantAdmin', 'POST', '/api/v1/directory/sync', undefined, hNone);
    expect(s.status).toBe(409);
    expect(s.body.error.code).toBe('not_configured');
    const t = await as(w, 'tenantAdmin', 'POST', '/api/v1/directory/connection/test', undefined, hNone);
    expect(t.status).toBe(409);
    expect(t.body.error.code).toBe('not_configured');
  });

  it('istemci sırrı hiçbir yanıtta ve denetim kaydında yok (Graph, sahte fetch)', async () => {
    const w = await freshWorld(hGraph);
    const bodies: string[] = [];
    const g = await as(w, 'tenantAdmin', 'GET', '/api/v1/directory/connection', undefined, hGraph);
    expect(g.body.provider).toMatchObject({ kind: 'graph', configured: true, tenantLabel: 'entra-tenant-sentetik' });
    bodies.push(g.raw);
    bodies.push((await as(w, 'tenantAdmin', 'PUT', '/api/v1/directory/connection', { scopeType: 'GROUP', scopeValue: 'grp-sentetik', enabled: true }, hGraph)).raw);
    const t = await as(w, 'tenantAdmin', 'POST', '/api/v1/directory/connection/test', undefined, hGraph);
    expect(t.status).toBe(200);
    expect(t.body.ok).toBe(false);
    bodies.push(t.raw);
    bodies.push((await as(w, 'tenantAdmin', 'POST', '/api/v1/directory/sync', undefined, hGraph)).raw);
    bodies.push((await as(w, 'tenantAdmin', 'GET', '/api/v1/directory/runs', undefined, hGraph)).raw);
    bodies.push((await as(w, 'auditor', 'GET', '/api/v1/directory/connection', undefined, hGraph)).raw);
    for (const b of bodies) expect(b).not.toContain(SENTINEL_SECRET);
    const audits = (await h.owner.query<{ data: unknown; reason: string | null }>(`SELECT data, reason FROM audit_events WHERE tenant_id = $1`, [w.tenantA])).rows;
    expect(JSON.stringify(audits)).not.toContain(SENTINEL_SECRET);
  });
});

describe('eşitleme ve çalıştırmalar', () => {
  it('Şimdi eşitle 202; açık çalıştırma varken 409 sync_running; sonuç çalıştırma listesinde ve bağlantıda', async () => {
    const w = await freshWorld();
    const off = await as(w, 'tenantAdmin', 'POST', '/api/v1/directory/sync');
    expect(off.status).toBe(409);
    expect(off.body.error.code).toBe('not_configured');
    await enable(w);
    fake.result = [du(`o-${sfx()}`, `run-${sfx()}@example.test`, 'Kalite (sentetik)')];
    const a = await as(w, 'tenantAdmin', 'POST', '/api/v1/directory/sync');
    expect(a.status).toBe(202);
    expect(a.body.runId).toEqual(expect.any(String));
    const b = await as(w, 'tenantAdmin', 'POST', '/api/v1/directory/sync');
    expect(b.status).toBe(409);
    expect(b.body.error.code).toBe('sync_running');
    const job = (await h.owner.query<{ id: string; tenant_id: string; requested_by: string | null }>(
      `SELECT id, tenant_id, requested_by FROM jobs WHERE kind = 'directory.sync' AND payload->>'runId' = $1`, [a.body.runId])).rows[0]!;
    await processDirectorySync(h.pool, fake, job.id, directoryJobContext(job.tenant_id, job.requested_by, job.id));
    const runs = await as(w, 'auditor', 'GET', '/api/v1/directory/runs');
    expect(runs.status).toBe(200);
    expect(runs.body.items[0]).toMatchObject({ id: a.body.runId, status: 'SUCCEEDED', trigger: 'MANUAL', providerKind: 'test', fetched: 1, created: 1 });
    const conn = await as(w, 'tenantAdmin', 'GET', '/api/v1/directory/connection');
    expect(conn.body.lastRun).toMatchObject({ id: a.body.runId, status: 'SUCCEEDED' });
  });
});

describe('eşitlenen kullanıcılar', () => {
  it('durumlar (ACTIVE/SUSPENDED/NO_MEMBERSHIP/DISABLED), q ve departmentId süzgeci', async () => {
    const w = await freshWorld();
    await enable(w);
    const s = sfx();
    await syncNow(w, [
      du(`a-${s}`, w.users.finance.email.toUpperCase(), `Finans ${s} (sentetik)`),
      du(`b-${s}`, `yeni-${s}@example.test`, `Lojistik ${s} (sentetik)`),
      du(`c-${s}`, `kapali-${s}@example.test`, `Lojistik ${s} (sentetik)`, { accountEnabled: false }),
      du(`d-${s}`, w.users.legal2.email, `Lojistik ${s} (sentetik)`),
    ]);
    // legal2'nin üyeliği elle askıya alınmış olsun (eşitleme dışı).
    await h.owner.query(`UPDATE memberships SET status = 'SUSPENDED' WHERE tenant_id = $1 AND user_id = $2`, [w.tenantA, w.users.legal2.id]);
    const all = await as(w, 'auditor', 'GET', '/api/v1/directory/users');
    expect(all.status).toBe(200);
    expect(all.body.truncated).toBe(false);
    const by = (o: string) => all.body.items.find((x: any) => x.id === o);
    const ids = { a: await dirUserId(w, `a-${s}`), b: await dirUserId(w, `b-${s}`), c: await dirUserId(w, `c-${s}`), d: await dirUserId(w, `d-${s}`) };
    expect(by(ids.a)).toMatchObject({ status: 'ACTIVE', roles: ['PROCUREMENT'], departmentName: `Finans ${s} (sentetik)`, jobTitle: 'Uzman (sentetik)',
      displayName: `a-${s} (sentetik)` });
    expect(by(ids.b)).toMatchObject({ status: 'NO_MEMBERSHIP', roles: null });
    expect(by(ids.c)).toMatchObject({ status: 'DISABLED' });
    expect(by(ids.d)).toMatchObject({ status: 'SUSPENDED', roles: ['PROCUREMENT'] });
    const q = await as(w, 'tenantAdmin', 'GET', `/api/v1/directory/users?q=${encodeURIComponent(`YENI-${s}`)}`);
    expect(q.body.items.map((x: any) => x.id)).toEqual([ids.b]);
    const pct = await as(w, 'tenantAdmin', 'GET', `/api/v1/directory/users?q=${encodeURIComponent('%')}`);
    expect(pct.body.items).toEqual([]);
    const lojistik = by(ids.b).departmentId as string;
    const f = await as(w, 'tenantAdmin', 'GET', `/api/v1/directory/users?departmentId=${lojistik}`);
    expect(f.body.items.map((x: any) => x.id).sort()).toEqual([ids.b, ids.c, ids.d].sort());
  });
});

describe('rol ataması (R3)', () => {
  it('yeni davetli kullanıcı ve üyelik: şirket kapsamı tüm şirketler, departman Entra\'dan; denetim önce/sonra', async () => {
    const w = await freshWorld();
    await enable(w);
    const s = sfx();
    const email = `Yeni.Kisi-${s}@Example.test`;
    await syncNow(w, [du(`n-${s}`, email, `Kalite ${s} (sentetik)`)]);
    const id = await dirUserId(w, `n-${s}`);
    const usersBefore = await count(`SELECT count(*)::int AS n FROM users`, []);
    const r = await as(w, 'tenantAdmin', 'PUT', `/api/v1/directory/users/${id}/roles`, { roles: ['PROCUREMENT', 'DEPARTMENT_USER'] });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ id, status: 'ACTIVE', roles: ['PROCUREMENT', 'DEPARTMENT_USER'] });
    expect(await count(`SELECT count(*)::int AS n FROM users`, [])).toBe(usersBefore + 1);
    const u = (await h.owner.query<{ id: string; auth_subject: string; email: string }>(
      `SELECT u.id, u.auth_subject, u.email FROM users u JOIN directory_users d ON d.user_id = u.id WHERE d.id = $1`, [id])).rows[0]!;
    expect(u.auth_subject).toBe(`invite|${email.toLowerCase()}`);
    const m = (await membershipOf(w.tenantA, u.id))!;
    const dept = (await h.owner.query<{ department_id: string }>(`SELECT department_id FROM directory_users WHERE id = $1`, [id])).rows[0]!.department_id;
    expect(m.status).toBe('ACTIVE');
    expect([...m.company_ids].sort()).toEqual([w.companyA1.id, w.companyA2.id].sort());
    expect(m.department_ids).toEqual([dept]);
    expect(m.directory_department_id).toBe(dept);
    const a = (await h.owner.query<{ data: any }>(`SELECT data FROM audit_events WHERE tenant_id = $1 AND action = 'membership.roles.set' AND entity_id = $2`,
      [w.tenantA, u.id])).rows;
    expect(a).toHaveLength(1);
    expect(a[0]!.data).toMatchObject({ before: null, after: { roles: ['PROCUREMENT', 'DEPARTMENT_USER'], status: 'ACTIVE' }, directoryUserId: id });
    // Liste ucu da aynı durumu gösterir.
    const list = await as(w, 'tenantAdmin', 'GET', '/api/v1/directory/users');
    expect(list.body.items.find((x: any) => x.id === id)).toMatchObject({ status: 'ACTIVE', roles: ['PROCUREMENT', 'DEPARTMENT_USER'] });
    // Rol değiştirme aynı üyeliği günceller; boş dizi = REVOKED.
    const r2 = await as(w, 'tenantAdmin', 'PUT', `/api/v1/directory/users/${id}/roles`, { roles: ['AUDITOR'] });
    expect(r2.status).toBe(200);
    expect((await membershipOf(w.tenantA, u.id))!.roles).toEqual(['AUDITOR']);
    const r3 = await as(w, 'tenantAdmin', 'PUT', `/api/v1/directory/users/${id}/roles`, { roles: [] });
    expect(r3.status).toBe(200);
    expect(r3.body).toMatchObject({ status: 'NO_MEMBERSHIP', roles: null });
    expect((await membershipOf(w.tenantA, u.id))!.status).toBe('REVOKED');
    expect(await count(`SELECT count(*)::int AS n FROM users`, [])).toBe(usersBefore + 1);
  });

  it('geçersiz roller, e-postasız ve kapalı kullanıcı reddedilir', async () => {
    const w = await freshWorld();
    await enable(w);
    const s = sfx();
    await syncNow(w, [
      du(`x-${s}`, `x-${s}@example.test`, null),
      du(`y-${s}`, null, null),
      du(`z-${s}`, `z-${s}@example.test`, null, { accountEnabled: false }),
    ]);
    const x = await dirUserId(w, `x-${s}`);
    const sup = await as(w, 'tenantAdmin', 'PUT', `/api/v1/directory/users/${x}/roles`, { roles: ['SUPPLIER'] });
    expect(sup.status).toBe(422);
    const bogus = await as(w, 'tenantAdmin', 'PUT', `/api/v1/directory/users/${x}/roles`, { roles: ['TENANT_ADMIN'] });
    expect(bogus.status).toBe(422);
    const noMail = await as(w, 'tenantAdmin', 'PUT', `/api/v1/directory/users/${await dirUserId(w, `y-${s}`)}/roles`, { roles: ['PROCUREMENT'] });
    expect(noMail.status).toBe(422);
    expect(noMail.body.error.code).toBe('email_missing');
    const off = await as(w, 'tenantAdmin', 'PUT', `/api/v1/directory/users/${await dirUserId(w, `z-${s}`)}/roles`, { roles: ['PROCUREMENT'] });
    expect(off.status).toBe(409);
    expect(off.body.error.code).toBe('directory_user_inactive');
    expect(await count(`SELECT count(*)::int AS n FROM users WHERE email IN ($1, $2)`, [`x-${s}@example.test`, `z-${s}@example.test`])).toBe(0);
  });

  it('aynı e-postayla var olan kullanıcı yeniden kullanılır (başka kiracıda OIDC ya da davetli; büyük/küçük harf duyarsız)', async () => {
    const w = await freshWorld();
    await enable(w);
    const s = sfx();
    // Başka kiracıda OIDC ile girmiş kullanıcı (bu kiracıda üyeliği yok, RLS ile görünmez).
    const oidcEmail = `oidc-${s}@example.test`;
    const oidcUser = (await h.owner.query<{ id: string }>(`INSERT INTO users (auth_subject, email, display_name) VALUES ($1, $2, 'OIDC Kişi (sentetik)') RETURNING id`,
      [`oidc|https://idp.example.test|${s}`, oidcEmail])).rows[0]!.id;
    await h.owner.query(`INSERT INTO memberships (tenant_id, user_id, roles, company_ids) VALUES ($1, $2, ARRAY['PROCUREMENT'], $3)`, [w.tenantB, oidcUser, [w.companyB1.id]]);
    // Başka kiracıda davet edilmiş, henüz girmemiş kullanıcı.
    const invEmail = `davetli-${s}@example.test`;
    const invUser = (await h.owner.query<{ id: string }>(`INSERT INTO users (auth_subject, email, display_name) VALUES ($1, $2, 'Davetli (sentetik)') RETURNING id`,
      [`invite|${invEmail}`, invEmail])).rows[0]!.id;
    await h.owner.query(`INSERT INTO memberships (tenant_id, user_id, roles, company_ids) VALUES ($1, $2, ARRAY['AUDITOR'], $3)`, [w.tenantB, invUser, [w.companyB1.id]]);
    await syncNow(w, [
      du(`o-${s}`, oidcEmail.toUpperCase(), null),
      du(`i-${s}`, `Davetli-${s}@EXAMPLE.test`, null),
      du(`f-${s}`, w.users.finance.email.toUpperCase(), null),
    ]);
    const usersBefore = await count(`SELECT count(*)::int AS n FROM users`, []);
    for (const o of [`o-${s}`, `i-${s}`, `f-${s}`]) {
      const r = await as(w, 'tenantAdmin', 'PUT', `/api/v1/directory/users/${await dirUserId(w, o)}/roles`, { roles: ['AUDITOR'] });
      expect(r.status, o).toBe(200);
    }
    expect(await count(`SELECT count(*)::int AS n FROM users`, [])).toBe(usersBefore);
    const linked = async (o: string) => (await h.owner.query<{ user_id: string }>(`SELECT user_id FROM directory_users WHERE tenant_id = $1 AND entra_object_id = $2`,
      [w.tenantA, o])).rows[0]!.user_id;
    expect(await linked(`o-${s}`)).toBe(oidcUser);
    expect(await linked(`i-${s}`)).toBe(invUser);
    expect(await linked(`f-${s}`)).toBe(w.users.finance.id);
    expect((await membershipOf(w.tenantA, oidcUser))!).toMatchObject({ status: 'ACTIVE', roles: ['AUDITOR'] });
    // Var olan üyelik yeniden kullanılır; başka kiracıdaki üyelik değişmez.
    expect((await membershipOf(w.tenantA, w.users.finance.id))!.roles).toEqual(['AUDITOR']);
    expect((await membershipOf(w.tenantB, oidcUser))!.roles).toEqual(['PROCUREMENT']);
  });

  it('askıdaki (eşitlemenin askıya aldığı) üyeliği rol ataması yeniden açar ve bayrağı temizler', async () => {
    const w = await freshWorld();
    await enable(w);
    const s = sfx();
    await syncNow(w, [du(`r-${s}`, w.users.legal.email, null)]);
    await h.owner.query(`UPDATE memberships SET status = 'SUSPENDED', suspended_by_directory = true WHERE tenant_id = $1 AND user_id = $2`, [w.tenantA, w.users.legal.id]);
    const r = await as(w, 'tenantAdmin', 'PUT', `/api/v1/directory/users/${await dirUserId(w, `r-${s}`)}/roles`, { roles: ['PROCUREMENT'] });
    expect(r.status).toBe(200);
    expect(await membershipOf(w.tenantA, w.users.legal.id)).toMatchObject({ status: 'ACTIVE', suspended_by_directory: false, roles: ['PROCUREMENT'] });
    const a = (await h.owner.query<{ data: any }>(`SELECT data FROM audit_events WHERE tenant_id = $1 AND action = 'membership.roles.set' AND entity_id = $2`,
      [w.tenantA, w.users.legal.id])).rows[0]!;
    expect(a.data.before).toMatchObject({ status: 'SUSPENDED', roles: ['PROCUREMENT'] });
    expect(a.data.after).toMatchObject({ status: 'ACTIVE' });
  });
});

describe('son Yönetici korunur (Review Focus 3)', () => {
  it('Yönetici kendi Yönetici rolünü düşüremez (409 self_demotion)', async () => {
    const w = await freshWorld();
    await enable(w);
    const s = sfx();
    await syncNow(w, [du(`adm-${s}`, w.users.tenantAdmin.email, null)]);
    const id = await dirUserId(w, `adm-${s}`);
    for (const roles of [[], ['PROCUREMENT']]) {
      const r = await as(w, 'tenantAdmin', 'PUT', `/api/v1/directory/users/${id}/roles`, { roles });
      expect(r.status).toBe(409);
      expect(r.body.error.code).toBe('self_demotion');
    }
    // Yönetici rolünü koruyarak rol eklemek serbest.
    expect((await as(w, 'tenantAdmin', 'PUT', `/api/v1/directory/users/${id}/roles`, { roles: ['ADMIN', 'AUDITOR'] })).status).toBe(200);
    expect((await membershipOf(w.tenantA, w.users.tenantAdmin.id))!).toMatchObject({ status: 'ACTIVE', roles: ['ADMIN', 'AUDITOR'] });
  });

  it('iki Yönetici aynı anda birbirini düşürürse ikincisi kilidi bekler ve 409 last_admin alır; kiracı yöneticisiz kalmaz', async () => {
    const w = await freshWorld();
    await enable(w);
    const s = sfx();
    await syncNow(w, [du(`adm-${s}`, w.users.tenantAdmin.email, null), du(`md-${s}`, w.users.masterData.email, null)]);
    const admin = await dirUserId(w, `adm-${s}`);
    const md = await dirUserId(w, `md-${s}`);
    expect((await as(w, 'tenantAdmin', 'PUT', `/api/v1/directory/users/${md}/roles`, { roles: ['ADMIN'] })).status).toBe(200);
    const ctxOf = (userId: string): TenantContext => ({ tenantId: w.tenantA, userId, roles: ['ADMIN'], companyIds: [w.companyA1.id, w.companyA2.id],
      departmentIds: [], allDepartments: true, correlationId: `test-${randomUUID()}` });
    // İşlem 1: Yönetici masterData'yı düşürür ama henüz işlemi bitirmez.
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    let entered!: () => void;
    const inTx1 = new Promise<void>((r) => { entered = r; });
    const a = ctxOf(w.users.tenantAdmin.id);
    const p1 = withTenant(h.pool, a, async (tx) => { const r = await setDirectoryUserRoles(tx, a, md, { roles: ['PROCUREMENT'] }); entered(); await gate; return r; });
    await inTx1;
    // İşlem 2: masterData (aynı anda hâlâ Yönetici sayılan) Yönetici'yi düşürmeye çalışır; Yönetici üyelik kilidini bekler.
    const b = ctxOf(w.users.masterData.id);
    let settled = false;
    const p2 = withTenant(h.pool, b, (tx) => setDirectoryUserRoles(tx, b, admin, { roles: [] }))
      .then(() => null, (e: unknown) => e).finally(() => { settled = true; });
    await new Promise((r) => setTimeout(r, 300));
    expect(settled).toBe(false);
    release();
    await p1;
    const err = await p2;
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).code).toBe('last_admin');
    expect(await count(`SELECT count(*)::int AS n FROM memberships WHERE tenant_id = $1 AND status = 'ACTIVE' AND roles && ARRAY['ADMIN','TENANT_ADMIN','PLATFORM_OPS']`,
      [w.tenantA])).toBe(1);
    expect((await membershipOf(w.tenantA, w.users.tenantAdmin.id))!).toMatchObject({ status: 'ACTIVE', roles: ['ADMIN'] });
  });
});

describe('departman birleştirme (R6)', () => {
  it('kaynak departmandaki proje, görev, üyelik ve dizin kullanıcısı hedefe geçer; sonraki eşitleme takma adla hedefe yazar', async () => {
    const w = await freshWorld();
    await enable(w);
    const s = sfx();
    const entraName = `Bilgi İşlem ${s} (sentetik)`;
    await syncNow(w, [du(`bi-${s}`, w.users.security.email, entraName)]);
    const source = (await h.owner.query<{ id: string }>(`SELECT id FROM departments WHERE tenant_id = $1 AND name = $2`, [w.tenantA, entraName])).rows[0]!.id;
    const target = w.departments.bt;
    // Kaynakta bir proje ve görev; ayrıca hedef + kaynak aynı üyelikte (tekilleşmeli).
    const proj = (await h.owner.query<{ id: string }>(
      `INSERT INTO projects (tenant_id, company_id, code, title, category, owner_user_id, created_by, department_id) VALUES ($1,$2,$3,'Birleştirme projesi (sentetik)','Genel',$4,$4,$5) RETURNING id`,
      [w.tenantA, w.companyA1.id, `BRL-${s}`, w.users.buyer.id, source])).rows[0]!.id;
    const task = (await h.owner.query<{ id: string }>(
      `INSERT INTO tasks (tenant_id, company_id, kind, entity_type, entity_id, title, reason, next_action, assignee_role, dedupe_key, department_id)
       VALUES ($1, $2, 'review', 'project', $3, 'Sentetik görev', 'sentetik', 'incele', 'PROCUREMENT', $4, $5) RETURNING id`,
      [w.tenantA, w.companyA1.id, proj, `test:${randomUUID()}`, source])).rows[0]!.id;
    await h.owner.query(`UPDATE memberships SET department_ids = ARRAY[$3::uuid, $4::uuid] WHERE tenant_id = $1 AND user_id = $2`,
      [w.tenantA, w.users.techEval.id, target, source]);
    const sec = (await membershipOf(w.tenantA, w.users.security.id))!;
    expect(sec.directory_department_id).toBe(source);

    // Onay yok / aynı departman 422.
    expect((await as(w, 'tenantAdmin', 'POST', `/api/v1/departments/${source}/merge`, { intoId: target })).status).toBe(422);
    expect((await as(w, 'tenantAdmin', 'POST', `/api/v1/departments/${source}/merge`, { intoId: target, confirm: false })).status).toBe(422);
    expect((await as(w, 'tenantAdmin', 'POST', `/api/v1/departments/${source}/merge`, { intoId: source, confirm: true })).status).toBe(422);

    const before = await as(w, 'tenantAdmin', 'GET', '/api/v1/departments');
    expect(before.body.items.find((d: any) => d.id === source)).toMatchObject({ source: 'ENTRA', userCount: 2 });
    expect(before.body.items.find((d: any) => d.id === target)).toMatchObject({ source: 'MANUAL' });

    const r = await as(w, 'tenantAdmin', 'POST', `/api/v1/departments/${source}/merge`, { intoId: target, confirm: true });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ sourceId: source, intoId: target });
    expect(r.body.counts).toMatchObject({ projects: 1, tasks: 1, memberships: 2, directory_users: 1 });

    expect((await h.owner.query(`SELECT department_id FROM projects WHERE id = $1`, [proj])).rows[0].department_id).toBe(target);
    expect((await h.owner.query(`SELECT department_id FROM tasks WHERE id = $1`, [task])).rows[0].department_id).toBe(target);
    expect((await membershipOf(w.tenantA, w.users.techEval.id))!.department_ids).toEqual([target]);
    const sec2 = (await membershipOf(w.tenantA, w.users.security.id))!;
    expect(sec2.department_ids).toEqual([target]);
    expect(sec2.directory_department_id).toBe(target);
    expect((await h.owner.query(`SELECT department_id FROM directory_users WHERE tenant_id = $1 AND entra_object_id = $2`, [w.tenantA, `bi-${s}`])).rows[0].department_id).toBe(target);
    expect((await h.owner.query(`SELECT merged_into FROM departments WHERE id = $1`, [source])).rows[0].merged_into).toBe(target);
    // Hiçbir tabloda kaynak kalmaz (sahip bağlantısıyla, RLS'siz).
    // Bütün department_id sütunları veritabanı kataloğundan (yeni tablo eklenirse test onu da denetler).
    const cols = (await h.owner.query<{ table_name: string }>(`SELECT table_name FROM information_schema.columns
      WHERE table_schema = 'public' AND column_name = 'department_id' ORDER BY table_name`)).rows.map((r) => r.table_name);
    expect(cols).toEqual(expect.arrayContaining(['projects', 'contract_families', 'invoices', 'supplier_assessments', 'tasks', 'directory_users', 'approver_assignments', 'department_aliases']));
    for (const t of cols) {
      expect(await count(`SELECT count(*)::int AS n FROM ${t} WHERE department_id = $1`, [source]), t).toBe(0);
    }
    expect(await count(`SELECT count(*)::int AS n FROM memberships WHERE $1 = ANY(department_ids) OR directory_department_id = $1`, [source])).toBe(0);
    const audit = (await h.owner.query<{ data: any }>(`SELECT data FROM audit_events WHERE tenant_id = $1 AND action = 'department.merged' AND entity_id = $2`,
      [w.tenantA, source])).rows;
    expect(audit).toHaveLength(1);
    expect(audit[0]!.data).toMatchObject({ intoId: target, counts: { projects: 1, tasks: 1, memberships: 2 } });

    // Listeden ve seçicilerden düşer; birleşmiş departmana atama yapılamaz; birleşmişe birleştirme 422.
    const after = await as(w, 'tenantAdmin', 'GET', '/api/v1/departments');
    expect(after.body.items.map((d: any) => d.id)).not.toContain(source);
    expect(after.body.items.find((d: any) => d.id === target).userCount).toBeGreaterThanOrEqual(3);
    expect((await as(w, 'techEval', 'GET', '/api/v1/departments')).body.items.map((d: any) => d.id)).not.toContain(source);
    expect((await as(w, 'tenantAdmin', 'PUT', `/api/v1/memberships/${w.users.buyer.id}/departments`, { departmentIds: [source] })).status).toBe(422);
    expect((await as(w, 'tenantAdmin', 'POST', `/api/v1/departments/${w.departments.ik}/merge`, { intoId: source, confirm: true })).status).toBe(422);
    expect((await as(w, 'tenantAdmin', 'POST', `/api/v1/departments/${source}/merge`, { intoId: w.departments.ik, confirm: true })).status).toBe(422);

    // Sonraki eşitleme: Entra adı (farklı yazımla) takma adla hedefe yazar, yeni departman açmaz.
    const deptsBefore = await count(`SELECT count(*)::int AS n FROM departments WHERE tenant_id = $1`, [w.tenantA]);
    await syncNow(w, [du(`bi-${s}`, w.users.security.email, entraName.toLocaleUpperCase('tr-TR')), du(`yeni-${s}`, `yeni-${s}@example.test`, `  ${entraName}  `)]);
    expect(await count(`SELECT count(*)::int AS n FROM departments WHERE tenant_id = $1`, [w.tenantA])).toBe(deptsBefore);
    for (const o of [`bi-${s}`, `yeni-${s}`]) {
      expect((await h.owner.query(`SELECT department_id FROM directory_users WHERE tenant_id = $1 AND entra_object_id = $2`, [w.tenantA, o])).rows[0].department_id).toBe(target);
    }
    expect((await membershipOf(w.tenantA, w.users.security.id))!.department_ids).toEqual([target]);
  });

  it('iki departmanın da bölüm sorumlusu atanmışsa 409 approver_conflict; yalnız kaynakta varsa hedefe taşınır', async () => {
    const w = await freshWorld();
    const a = (await as(w, 'tenantAdmin', 'POST', '/api/v1/departments', { name: `Kaynak ${sfx()} (sentetik)` })).body.id as string;
    const b = (await as(w, 'tenantAdmin', 'POST', '/api/v1/departments', { name: `Hedef ${sfx()} (sentetik)` })).body.id as string;
    const head = (dept: string, user: string) => h.owner.query(`INSERT INTO approver_assignments (tenant_id, kind, department_id, primary_user_id) VALUES ($1, 'DEPARTMENT_HEAD', $2, $3)`,
      [w.tenantA, dept, user]);
    await head(a, w.users.buyer.id);
    await head(b, w.users.legal.id);
    const c = await as(w, 'tenantAdmin', 'POST', `/api/v1/departments/${a}/merge`, { intoId: b, confirm: true });
    expect(c.status).toBe(409);
    expect(c.body.error.code).toBe('approver_conflict');
    expect((await h.owner.query(`SELECT merged_into FROM departments WHERE id = $1`, [a])).rows[0].merged_into).toBeNull();
    await h.owner.query(`DELETE FROM approver_assignments WHERE department_id = $1`, [b]);
    const ok = await as(w, 'tenantAdmin', 'POST', `/api/v1/departments/${a}/merge`, { intoId: b, confirm: true });
    expect(ok.status).toBe(200);
    expect(ok.body.counts.approver_assignments).toBe(1);
    expect((await h.owner.query(`SELECT primary_user_id FROM approver_assignments WHERE department_id = $1`, [b])).rows[0].primary_user_id).toBe(w.users.buyer.id);
    // Elle açılmış departmanın adı da takma ad olur.
    const norm = (await h.owner.query(`SELECT sp_normalize_department_name(name) AS n FROM departments WHERE id = $1`, [a])).rows[0].n;
    expect((await h.owner.query(`SELECT department_id FROM department_aliases WHERE tenant_id = $1 AND normalized_name = $2`, [w.tenantA, norm])).rows[0].department_id).toBe(b);
  });

  it('başka kiracının departmanı ile birleştirme 404', async () => {
    const w = await freshWorld();
    const r = await as(w, 'tenantAdmin', 'POST', `/api/v1/departments/${w.departments.bt}/merge`, { intoId: w.departmentsB.bt, confirm: true });
    expect(r.status).toBe(404);
  });
});
