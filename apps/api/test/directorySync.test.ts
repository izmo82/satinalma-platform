// v2 Faz 2 (D105) Görev 3: dizin eşitleme işi (directory.sync). Bellekteki sahte dizin sağlayıcısı (kind 'test'); ağ yok, gerçek PostgreSQL.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { createSyntheticWorld, type SyntheticWorld } from '../src/devdata.ts';
import { withTenant, type TenantContext } from '../src/db.ts';
import { DirectoryError, type DirectoryProvider, type DirectoryUser } from '../src/directory/provider.ts';
import { TEST_LABEL } from '../src/directory/testProvider.ts';
import { directoryJobContext, enqueueNightlySyncs, processDirectorySync, requestSync } from '../src/modules/directory.ts';
import { processJobs } from '../src/worker.ts';
import { ApiError } from '../src/errors.ts';
import { makeHarness } from './harness.ts';

let h: Awaited<ReturnType<typeof makeHarness>>;
beforeAll(async () => { h = await makeHarness(); });
afterAll(async () => { await h.close(); });

/** YALNIZ TEST: bellekteki sahte dizin. `result` bir Error ise listUsers onu fırlatır. */
function fakeProvider(initial: DirectoryUser[] | Error = []) {
  const p = {
    result: initial as DirectoryUser[] | Error,
    kind: 'test' as const, label: TEST_LABEL, tenantLabel: 'test',
    async testConnection() { return { ok: true as const }; },
    async listUsers() { if (p.result instanceof Error) throw p.result; return p.result.map((u) => ({ ...u })); },
  };
  return p satisfies DirectoryProvider;
}

function du(objectId: string, email: string | null, department: string | null, extra: Partial<DirectoryUser> = {}): DirectoryUser {
  return { objectId, email, displayName: `${objectId} (sentetik)`, userPrincipalName: `${objectId}@example.test`, department, jobTitle: null,
    managerObjectId: null, accountEnabled: true, onPremisesDistinguishedName: null, ...extra };
}

async function freshWorld(): Promise<SyntheticWorld> { return createSyntheticWorld(h.owner, `-${randomUUID().slice(0, 8)}`); }

function adminCtx(w: SyntheticWorld): TenantContext {
  return { tenantId: w.tenantA, userId: w.users.tenantAdmin.id, roles: ['ADMIN'], companyIds: [w.companyA1.id, w.companyA2.id],
    departmentIds: [], allDepartments: true, correlationId: `test-${randomUUID()}` };
}

async function enable(tenantId: string, enabled = true) {
  await h.owner.query(`INSERT INTO directory_connections (tenant_id, scope_type, scope_value, enabled) VALUES ($1, 'GROUP', 'grp-sentetik', $2)
    ON CONFLICT (tenant_id) DO UPDATE SET enabled = EXCLUDED.enabled`, [tenantId, enabled]);
}

async function jobOf(runId: string) {
  return (await h.owner.query<{ id: string; tenant_id: string; requested_by: string | null; status: string; kind: string }>(
    `SELECT id, tenant_id, requested_by, status, kind FROM jobs WHERE kind = 'directory.sync' AND payload->>'runId' = $1`, [runId])).rows[0]!;
}

/** Manuel eşitleme iste ve işi doğrudan işle (işçi ile aynı bağlam). */
async function sync(w: SyntheticWorld, provider: DirectoryProvider) {
  const { runId } = await withTenant(h.pool, adminCtx(w), (tx) => requestSync(tx, adminCtx(w), 'MANUAL', provider));
  const job = await jobOf(runId);
  await processDirectorySync(h.pool, provider, job.id, directoryJobContext(job.tenant_id, job.requested_by, job.id));
  return run(runId);
}

async function run(runId: string) {
  return (await h.owner.query<{ status: string; error_code: string | null; error_message: string | null; fetched: number; created: number;
    updated: number; suspended: number; reactivated: number; trigger: string; provider_kind: string }>(
    `SELECT * FROM directory_sync_runs WHERE id = $1`, [runId])).rows[0]!;
}

async function dirUser(tenantId: string, objectId: string) {
  return (await h.owner.query<{ user_id: string | null; department_id: string | null; in_scope: boolean; manager_object_id: string | null;
    account_enabled: boolean; email: string | null }>(
    `SELECT * FROM directory_users WHERE tenant_id = $1 AND entra_object_id = $2`, [tenantId, objectId])).rows[0];
}

async function membership(tenantId: string, userId: string) {
  return (await h.owner.query<{ status: string; suspended_by_directory: boolean; department_ids: string[]; directory_department_id: string | null }>(
    `SELECT status, suspended_by_directory, department_ids, directory_department_id FROM memberships WHERE tenant_id = $1 AND user_id = $2`,
    [tenantId, userId])).rows[0]!;
}

async function openTask(w: SyntheticWorld, assignee: string) {
  return (await h.owner.query<{ id: string }>(
    `INSERT INTO tasks (tenant_id, company_id, kind, entity_type, entity_id, title, reason, next_action, assignee_role, assignee_user_id, dedupe_key)
     VALUES ($1, $2, 'review', 'tenant', $1, 'Sentetik görev', 'sentetik', 'incele', 'PROCUREMENT', $3, $4) RETURNING id`,
    [w.tenantA, w.companyA1.id, assignee, `test:${randomUUID()}`])).rows[0]!.id;
}

async function taskAssignee(id: string) {
  return (await h.owner.query<{ assignee_user_id: string | null }>(`SELECT assignee_user_id FROM tasks WHERE id = $1`, [id])).rows[0]!.assignee_user_id;
}

const count = async (sql: string, params: unknown[]) => (await h.owner.query<{ n: number }>(sql, params)).rows[0]!.n;

describe('dizin eşitleme', () => {
  it('ilk eşitleme 3 kullanıcı ve 2 departman açar, kullanıcı oluşturmaz', async () => {
    const w = await freshWorld();
    await enable(w.tenantA);
    const usersBefore = await count(`SELECT count(*)::int AS n FROM users`, []);
    const p = fakeProvider([
      du('o1', 'kalite1@example.test', 'Kalite Güvence (sentetik)'),
      du('o2', 'kalite2@example.test', 'KALİTE  güvence (sentetik)'),
      du('o3', 'lojistik@example.test', 'Lojistik Planlama (sentetik)'),
    ]);
    const r = await sync(w, p);
    expect(r).toMatchObject({ status: 'SUCCEEDED', fetched: 3, created: 3, updated: 0, suspended: 0, reactivated: 0, provider_kind: 'test', trigger: 'MANUAL' });
    expect(await count(`SELECT count(*)::int AS n FROM directory_users WHERE tenant_id = $1 AND in_scope`, [w.tenantA])).toBe(3);
    const depts = (await h.owner.query<{ id: string; name: string; normalized_name: string }>(
      `SELECT id, name, normalized_name FROM departments WHERE tenant_id = $1 AND source = 'ENTRA' ORDER BY name`, [w.tenantA])).rows;
    expect(depts.map((d) => d.name)).toEqual(['Kalite Güvence (sentetik)', 'Lojistik Planlama (sentetik)']);
    expect((await dirUser(w.tenantA, 'o1'))!.department_id).toBe(depts[0]!.id);
    expect((await dirUser(w.tenantA, 'o2'))!.department_id).toBe(depts[0]!.id);
    expect(await count(`SELECT count(*)::int AS n FROM department_aliases WHERE tenant_id = $1`, [w.tenantA])).toBe(2);
    expect(await count(`SELECT count(*)::int AS n FROM users`, [])).toBe(usersBefore);
    expect(await count(`SELECT count(*)::int AS n FROM audit_events WHERE tenant_id = $1 AND action = 'directory.synced'`, [w.tenantA])).toBe(1);
    const job = (await h.owner.query<{ status: string }>(`SELECT status FROM jobs WHERE tenant_id = $1 AND kind = 'directory.sync'`, [w.tenantA])).rows[0]!;
    expect(job.status).toBe('SUCCEEDED');
    // İkinci eşitleme değişiklik yoksa yeni kayıt açmaz, güncelleme de saymaz.
    const r2 = await sync(w, p);
    expect(r2).toMatchObject({ status: 'SUCCEEDED', fetched: 3, created: 0, updated: 0 });
    expect(await count(`SELECT count(*)::int AS n FROM departments WHERE tenant_id = $1 AND source = 'ENTRA'`, [w.tenantA])).toBe(2);
  });

  it('aynı e-postayla var olan davetli kullanıcıya bağlanır (büyük/küçük harf farkı aynı kişi), e-postasız kullanıcı bağlanmaz', async () => {
    const w = await freshWorld();
    await enable(w.tenantA);
    const email = `davetli.${randomUUID().slice(0, 6)}@example.test`;
    const invited = (await h.owner.query<{ id: string }>(`INSERT INTO users (auth_subject, email, display_name) VALUES ($1, $2, 'Davetli (sentetik)') RETURNING id`,
      [`invite|${email}`, email])).rows[0]!.id;
    await h.owner.query(`INSERT INTO memberships (tenant_id, user_id, roles, company_ids) VALUES ($1, $2, '{DEPARTMENT_USER}', '{}')`, [w.tenantA, invited]);
    const usersBefore = await count(`SELECT count(*)::int AS n FROM users`, []);
    const r = await sync(w, fakeProvider([
      du('inv', email.toUpperCase(), null),
      du('tech', w.users.techEval.email, null),
      du('nomail', null, null),
    ]));
    expect(r.status).toBe('SUCCEEDED');
    expect((await dirUser(w.tenantA, 'inv'))!.user_id).toBe(invited);
    expect((await dirUser(w.tenantA, 'tech'))!.user_id).toBe(w.users.techEval.id);
    const nm = (await dirUser(w.tenantA, 'nomail'))!;
    expect(nm.email).toBeNull();
    expect(nm.user_id).toBeNull();
    expect(await count(`SELECT count(*)::int AS n FROM users`, [])).toBe(usersBefore);
  });

  it('başka kiracının kullanıcısına e-postayla bağlanmaz', async () => {
    const w = await freshWorld();
    await enable(w.tenantA);
    await sync(w, fakeProvider([du('b', w.users.buyerB.email, null)]));
    expect((await dirUser(w.tenantA, 'b'))!.user_id).toBeNull();
  });

  it('"Bilgi  teknolojileri", "Bilgi Teknolojileri" ve "BİLGİ TEKNOLOJİLERİ" tek departman (var olan) olur', async () => {
    const w = await freshWorld();
    await enable(w.tenantA);
    const r = await sync(w, fakeProvider([
      du('a', 'a@example.test', 'Bilgi  teknolojileri'),
      du('b', 'b@example.test', 'Bilgi Teknolojileri'),
      du('c', 'c@example.test', ' BİLGİ TEKNOLOJİLERİ '),
    ]));
    expect(r.status).toBe('SUCCEEDED');
    for (const o of ['a', 'b', 'c']) expect((await dirUser(w.tenantA, o))!.department_id).toBe(w.departments.bt);
    expect(await count(`SELECT count(*)::int AS n FROM departments WHERE tenant_id = $1 AND source = 'ENTRA'`, [w.tenantA])).toBe(0);
    const alias = (await h.owner.query<{ normalized_name: string; department_id: string }>(
      `SELECT normalized_name, department_id FROM department_aliases WHERE tenant_id = $1`, [w.tenantA])).rows;
    expect(alias).toEqual([{ normalized_name: 'bilgi teknolojileri', department_id: w.departments.bt }]);
  });

  it('birleştirilmiş departmanın takma adı hedefe yazar', async () => {
    const w = await freshWorld();
    await enable(w.tenantA);
    await sync(w, fakeProvider([du('a', 'a@example.test', 'Eski Birim (sentetik)')]));
    const old = (await dirUser(w.tenantA, 'a'))!.department_id!;
    await h.owner.query(`UPDATE departments SET merged_into = $2 WHERE id = $1`, [old, w.departments.ik]);
    await sync(w, fakeProvider([du('a', 'a@example.test', 'Eski Birim (sentetik)')]));
    expect((await dirUser(w.tenantA, 'a'))!.department_id).toBe(w.departments.ik);
  });

  it('Yönetici\'nin eklediği ek departman korunur; eski dizin departmanı çıkar, yenisi eklenir (R4)', async () => {
    const w = await freshWorld();
    await enable(w.tenantA);
    const p = fakeProvider([du('t', w.users.techEval.email, 'Kalite Güvence (sentetik)')]);
    await sync(w, p);
    const kalite = (await dirUser(w.tenantA, 't'))!.department_id!;
    let m = await membership(w.tenantA, w.users.techEval.id);
    expect(m.department_ids).toEqual([w.departments.bt, kalite]);
    expect(m.directory_department_id).toBe(kalite);
    // Yönetici elle İK ekler.
    await h.owner.query(`UPDATE memberships SET department_ids = department_ids || $3::uuid WHERE tenant_id = $1 AND user_id = $2`,
      [w.tenantA, w.users.techEval.id, w.departments.ik]);
    p.result = [du('t', w.users.techEval.email, 'Lojistik Planlama (sentetik)')];
    const r = await sync(w, p);
    expect(r.updated).toBe(1);
    const lojistik = (await dirUser(w.tenantA, 't'))!.department_id!;
    m = await membership(w.tenantA, w.users.techEval.id);
    expect(m.department_ids).toEqual([w.departments.bt, w.departments.ik, lojistik]);
    expect(m.directory_department_id).toBe(lojistik);
  });

  it('kapanan hesap: üyelik askıya alınır, açık görev vekile ya da kuyruğa döner; yeniden etkinleşince yalnız eşitlemenin askıya aldığı açılır (R5)', async () => {
    const w = await freshWorld();
    await enable(w.tenantA);
    // techEval bölüm sorumlusu, vekili security (etkin üye). buyer'ın vekili yok.
    await h.owner.query(`INSERT INTO approver_assignments (tenant_id, kind, department_id, primary_user_id, deputy_user_id) VALUES ($1, 'DEPARTMENT_HEAD', $2, $3, $4)`,
      [w.tenantA, w.departments.bt, w.users.techEval.id, w.users.security.id]);
    const t1 = await openTask(w, w.users.techEval.id);
    const t2 = await openTask(w, w.users.buyer.id);
    const tSecurity = await openTask(w, w.users.security.id);
    // Elle askıya alınmış üyelik (legal) eşitlemeyle açılmamalı.
    await h.owner.query(`UPDATE memberships SET status = 'SUSPENDED' WHERE tenant_id = $1 AND user_id = $2`, [w.tenantA, w.users.legal.id]);
    const all = (enabled: boolean) => [
      du('tech', w.users.techEval.email, null, { accountEnabled: enabled }),
      du('buyer', w.users.buyer.email, null, { accountEnabled: enabled }),
      du('legal', w.users.legal.email, null),
      du('sup', w.users.supplier1.email, null, { accountEnabled: enabled }),
      du('multi', w.users.multi.email, null, { accountEnabled: enabled }),
      du('sec', w.users.security.email, null),
    ];
    const p = fakeProvider(all(true));
    await sync(w, p);
    p.result = all(false);
    const r = await sync(w, p);
    expect(r).toMatchObject({ status: 'SUCCEEDED', suspended: 3, reactivated: 0 });
    for (const u of [w.users.techEval, w.users.buyer, w.users.multi]) {
      expect(await membership(w.tenantA, u.id)).toMatchObject({ status: 'SUSPENDED', suspended_by_directory: true });
    }
    // Tedarikçi üyeliğine ve başka kiracıdaki üyeliğe dokunulmaz.
    expect((await membership(w.tenantA, w.users.supplier1.id)).status).toBe('ACTIVE');
    expect((await membership(w.tenantB, w.users.multi.id)).status).toBe('ACTIVE');
    expect(await taskAssignee(t1)).toBe(w.users.security.id);
    expect(await taskAssignee(t2)).toBeNull();
    expect(await taskAssignee(tSecurity)).toBe(w.users.security.id);
    expect(await count(`SELECT count(*)::int AS n FROM audit_events WHERE tenant_id = $1 AND action = 'directory.membership_suspended'`, [w.tenantA])).toBe(3);
    expect(await count(`SELECT count(*)::int AS n FROM audit_events WHERE tenant_id = $1 AND action = 'task.reassigned' AND entity_id = ANY($2::uuid[])`,
      [w.tenantA, [t1, t2]])).toBe(2);
    // Yeniden etkin.
    p.result = all(true);
    const r3 = await sync(w, p);
    expect(r3).toMatchObject({ status: 'SUCCEEDED', suspended: 0, reactivated: 3 });
    for (const u of [w.users.techEval, w.users.buyer, w.users.multi]) {
      expect(await membership(w.tenantA, u.id)).toMatchObject({ status: 'ACTIVE', suspended_by_directory: false });
    }
    expect(await membership(w.tenantA, w.users.legal.id)).toMatchObject({ status: 'SUSPENDED', suspended_by_directory: false });
    expect(await count(`SELECT count(*)::int AS n FROM audit_events WHERE tenant_id = $1 AND action = 'directory.membership_reactivated'`, [w.tenantA])).toBe(3);
  });

  it('kapsamdan çıkan kullanıcı askıya alınır, kapsama dönünce açılır', async () => {
    const w = await freshWorld();
    await enable(w.tenantA);
    const p = fakeProvider([du('tech', w.users.techEval.email, null), du('sec', w.users.security.email, null)]);
    await sync(w, p);
    p.result = [du('sec', w.users.security.email, null)];
    const r = await sync(w, p);
    expect(r.suspended).toBe(1);
    expect((await dirUser(w.tenantA, 'tech'))!.in_scope).toBe(false);
    expect((await membership(w.tenantA, w.users.techEval.id)).status).toBe('SUSPENDED');
    p.result = [du('tech', w.users.techEval.email, null), du('sec', w.users.security.email, null)];
    expect((await sync(w, p)).reactivated).toBe(1);
    expect((await membership(w.tenantA, w.users.techEval.id)).status).toBe('ACTIVE');
  });

  it('sağlayıcı hatasında üyelikler değişmez ve çalıştırma FAILED', async () => {
    const w = await freshWorld();
    await enable(w.tenantA);
    const p = fakeProvider([du('tech', w.users.techEval.email, 'Kalite Güvence (sentetik)')]);
    await sync(w, p);
    const before = await membership(w.tenantA, w.users.techEval.id);
    const t = await openTask(w, w.users.techEval.id);
    p.result = new DirectoryError('graph_forbidden', 'Dizin okuma izni yok (sentetik).');
    const r = await sync(w, p);
    expect(r).toMatchObject({ status: 'FAILED', error_code: 'graph_forbidden', error_message: 'Dizin okuma izni yok (sentetik).', suspended: 0 });
    expect(await membership(w.tenantA, w.users.techEval.id)).toEqual(before);
    expect((await dirUser(w.tenantA, 'tech'))!.in_scope).toBe(true);
    expect(await taskAssignee(t)).toBe(w.users.techEval.id);
    // Sır ya da iç ayrıntı içeren beklenmeyen hata: sabit Türkçe ileti.
    p.result = new Error('secret=abc123 bağlantı koptu');
    const r2 = await sync(w, p);
    expect(r2.status).toBe('FAILED');
    expect(r2.error_code).toBe('provider_error');
    expect(r2.error_message).not.toContain('abc123');
    expect(await membership(w.tenantA, w.users.techEval.id)).toEqual(before);
  });

  it('boş sonuç, önceki eşitlemede kapsamda kullanıcı varken empty_result ile FAILED olur', async () => {
    const w = await freshWorld();
    await enable(w.tenantA);
    const p = fakeProvider([]);
    // İlk kez boş: kimse kapsamda değildi, başarı.
    expect((await sync(w, p)).status).toBe('SUCCEEDED');
    p.result = [du('tech', w.users.techEval.email, null)];
    await sync(w, p);
    p.result = [];
    const r = await sync(w, p);
    expect(r).toMatchObject({ status: 'FAILED', error_code: 'empty_result', suspended: 0 });
    expect(r.error_message).toBeTruthy();
    expect((await membership(w.tenantA, w.users.techEval.id)).status).toBe('ACTIVE');
    expect((await dirUser(w.tenantA, 'tech'))!.in_scope).toBe(true);
  });

  it('bağlantı ayarı yoksa ya da kapalıysa not_configured', async () => {
    const w = await freshWorld();
    expect(await sync(w, fakeProvider([du('x', 'x@example.test', null)]))).toMatchObject({ status: 'FAILED', error_code: 'not_configured' });
    await enable(w.tenantA, false);
    expect(await sync(w, fakeProvider([du('x', 'x@example.test', null)]))).toMatchObject({ status: 'FAILED', error_code: 'not_configured' });
    expect(await count(`SELECT count(*)::int AS n FROM directory_users WHERE tenant_id = $1`, [w.tenantA])).toBe(0);
  });

  it('yönetici alanı: yeni değer boşsa önceki korunur', async () => {
    const w = await freshWorld();
    await enable(w.tenantA);
    const p = fakeProvider([du('a', 'a@example.test', null, { managerObjectId: 'mgr-1' })]);
    await sync(w, p);
    expect((await dirUser(w.tenantA, 'a'))!.manager_object_id).toBe('mgr-1');
    p.result = [du('a', 'a@example.test', null, { managerObjectId: null })];
    await sync(w, p);
    expect((await dirUser(w.tenantA, 'a'))!.manager_object_id).toBe('mgr-1');
    p.result = [du('a', 'a@example.test', null, { managerObjectId: 'mgr-2' })];
    await sync(w, p);
    expect((await dirUser(w.tenantA, 'a'))!.manager_object_id).toBe('mgr-2');
  });

  it('açık çalıştırma varken ikinci istek 409 sync_running', async () => {
    const w = await freshWorld();
    await enable(w.tenantA);
    const p = fakeProvider([]);
    await withTenant(h.pool, adminCtx(w), (tx) => requestSync(tx, adminCtx(w), 'MANUAL', p));
    const err = await withTenant(h.pool, adminCtx(w), (tx) => requestSync(tx, adminCtx(w), 'MANUAL', p)).catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err).toMatchObject({ status: 409, code: 'sync_running' });
  });

  it('başka kiracının dizin satırları görünmez (RLS)', async () => {
    const w = await freshWorld();
    await enable(w.tenantA);
    await sync(w, fakeProvider([du('a', 'a@example.test', 'Kalite Güvence (sentetik)')]));
    const ctxB: TenantContext = { tenantId: w.tenantB, userId: w.users.buyerB.id, roles: ['PROCUREMENT'], companyIds: [w.companyB1.id],
      departmentIds: [], allDepartments: true, correlationId: 'test-rls' };
    const seen = await withTenant(h.pool, ctxB, async (tx) => ({
      users: (await tx.query(`SELECT 1 FROM directory_users`)).rowCount,
      runs: (await tx.query(`SELECT 1 FROM directory_sync_runs`)).rowCount,
      aliases: (await tx.query(`SELECT 1 FROM department_aliases`)).rowCount,
      conn: (await tx.query(`SELECT 1 FROM directory_connections`)).rowCount,
    }));
    expect(seen).toEqual({ users: 0, runs: 0, aliases: 0, conn: 0 });
    const seenA = await withTenant(h.pool, adminCtx(w), async (tx) => (await tx.query(`SELECT 1 FROM directory_users`)).rowCount);
    expect(seenA).toBe(1);
  });

  it('gece kuyruğu: 06:00 (İstanbul) öncesi açmaz, aynı gün ikinci iş açmaz, ertesi gün açar (R8)', async () => {
    const w = await freshWorld();
    await enable(w.tenantA);
    await enable(w.tenantB, false);
    const p = fakeProvider([]);
    const nightly = async (tenant: string) => (await h.owner.query<{ idempotency_key: string; requested_by: string | null; payload: { runId: string } }>(
      `SELECT idempotency_key, requested_by, payload FROM jobs WHERE tenant_id = $1 AND kind = 'directory.sync' ORDER BY created_at`, [tenant])).rows;
    // 05:59 İstanbul = 02:59Z
    await enqueueNightlySyncs(h.pool, new Date('2026-11-18T02:59:00Z'), p);
    expect(await nightly(w.tenantA)).toHaveLength(0);
    // 06:01 İstanbul
    expect(await enqueueNightlySyncs(h.pool, new Date('2026-11-18T03:01:00Z'), p)).toBeGreaterThanOrEqual(1);
    await enqueueNightlySyncs(h.pool, new Date('2026-11-18T20:59:00Z'), p); // 23:59 aynı gün
    const jobs = await nightly(w.tenantA);
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({ idempotency_key: `directory.sync:${w.tenantA}:2026-11-18`, requested_by: null });
    expect((await run(jobs[0]!.payload.runId))).toMatchObject({ trigger: 'NIGHTLY', status: 'QUEUED' });
    expect(await nightly(w.tenantB)).toHaveLength(0);
    // İşlenmeden ertesi gün: açık çalıştırma varken yeni iş açılmaz (hata da fırlatmaz).
    await enqueueNightlySyncs(h.pool, new Date('2026-11-19T03:01:00Z'), p);
    expect(await nightly(w.tenantA)).toHaveLength(1);
    // İşlendikten sonra ertesi gün açılır.
    const j = (await h.owner.query<{ id: string }>(`SELECT id FROM jobs WHERE tenant_id = $1 AND kind = 'directory.sync'`, [w.tenantA])).rows[0]!;
    await processDirectorySync(h.pool, p, j.id, directoryJobContext(w.tenantA, null, j.id));
    await enqueueNightlySyncs(h.pool, new Date('2026-11-19T03:01:00Z'), p);
    expect((await nightly(w.tenantA)).map((x) => x.idempotency_key)).toEqual([`directory.sync:${w.tenantA}:2026-11-18`, `directory.sync:${w.tenantA}:2026-11-19`]);
  });

  it('işçi: directory.sync yalnız sağlayıcı verilince işlenir; isteyeni olmayan gece işi engellenmez', async () => {
    const w = await freshWorld();
    await enable(w.tenantA);
    const p = fakeProvider([du('a', 'a@example.test', null)]);
    await enqueueNightlySyncs(h.pool, new Date('2026-11-18T03:30:00Z'), p);
    const j = (await h.owner.query<{ id: string; payload: { runId: string } }>(`SELECT id, payload FROM jobs WHERE tenant_id = $1 AND kind = 'directory.sync'`, [w.tenantA])).rows[0]!;
    await processJobs(h.pool, h.store, null, 10, null, 'short');
    expect((await jobOf(j.payload.runId)).status).toBe('QUEUED');
    for (let i = 0; i < 5; i++) if (!(await processJobs(h.pool, h.store, null, 10, null, 'short', { directoryProvider: p }))) break;
    expect((await jobOf(j.payload.runId)).status).toBe('SUCCEEDED');
    expect(await run(j.payload.runId)).toMatchObject({ status: 'SUCCEEDED', fetched: 1, created: 1 });
  });
});
