// v2 Faz 2 (D105) Görev 5: onaycı ataması API'si (R2: satınalma sorumlusuna da isteğe bağlı vekil). Gerçek PostgreSQL; veriler sentetik.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { createSyntheticWorld, type SyntheticWorld } from '../src/devdata.ts';
import { DevAuthProvider } from '../src/auth.ts';
import { withTenant } from '../src/db.ts';
import { currentApprovers } from '../src/modules/approvers.ts';
import { makeHarness } from './harness.ts';

let h: Awaited<ReturnType<typeof makeHarness>>;
let auth: DevAuthProvider;
beforeAll(async () => { h = await makeHarness(); auth = new DevAuthProvider(h.config.devAuthSecret!); });
afterAll(async () => { await h.close(); });

type UserKey = keyof SyntheticWorld['users'];
const fresh = () => createSyntheticWorld(h.owner, `-${randomUUID().slice(0, 8)}`);
async function as(w: SyntheticWorld, who: UserKey, method: string, url: string, body?: unknown) {
  const token = await auth.issue(`dev|${w.users[who].email}`);
  const res = await h.app.inject({ method: method as any, url, headers: { authorization: `Bearer ${token}`, 'x-tenant-id': w.tenantA }, ...(body !== undefined ? { payload: body as any } : {}) });
  let parsed: any = null;
  try { parsed = res.body ? JSON.parse(res.body) : null; } catch { parsed = res.body; }
  return { status: res.statusCode, body: parsed };
}
const U = '/api/v1/approver-assignments';
const id = (w: SyntheticWorld, k: UserKey) => w.users[k].id;

describe('yetki', () => {
  it('Yönetici atar; Satınalma ve Denetçi okur ama yazamaz; Departman kullanıcısı ve tedarikçi 403', async () => {
    const w = await fresh();
    const put = await as(w, 'tenantAdmin', 'PUT', U, { organization: { leadUserId: id(w, 'buyer'), directorUserId: id(w, 'legal') }, departments: [{ departmentId: w.departments.bt, headUserId: id(w, 'finance'), deputyUserId: id(w, 'legal2') }] });
    expect(put.status).toBe(200);
    for (const who of ['tenantAdmin', 'masterData', 'auditor'] as const) {
      const r = await as(w, who, 'GET', U);
      expect(r.status, who).toBe(200);
      expect(r.body.organization.lead.userId).toBe(id(w, 'buyer'));
    }
    for (const who of ['buyer', 'security', 'supplier1'] as const) {
      // buyer hem PROCUREMENT hem DEPARTMENT_USER: PROCUREMENT okuyabilir
      const r = await as(w, who, 'GET', U);
      expect(r.status, who).toBe(who === 'buyer' ? 200 : 403);
    }
    for (const who of ['masterData', 'auditor', 'buyer', 'security', 'supplier1'] as const) {
      expect((await as(w, who, 'PUT', U, { departments: [] })).status, who).toBe(403);
    }
  });
});

describe('atama ve okuma', () => {
  it('kurum ve departman atamaları durumlarıyla döner; vekilsiz NO_DEPUTY, atanmamış UNASSIGNED; adaylar yalnız etkin iç kullanıcı', async () => {
    const w = await fresh();
    await as(w, 'tenantAdmin', 'PUT', U, { organization: { leadUserId: id(w, 'buyer'), leadDeputyUserId: id(w, 'masterData'), directorUserId: id(w, 'legal'), directorDeputyUserId: id(w, 'legal2') },
      departments: [{ departmentId: w.departments.bt, headUserId: id(w, 'finance'), deputyUserId: id(w, 'legal2') }, { departmentId: w.departments.ik, headUserId: id(w, 'finance'), deputyUserId: null }] });
    const r = await as(w, 'tenantAdmin', 'GET', U);
    expect(r.body.organization.leadDeputy.userId).toBe(id(w, 'masterData'));
    expect(r.body.organization.directorDeputy.userId).toBe(id(w, 'legal2'));
    const by = Object.fromEntries(r.body.departments.map((d: any) => [d.departmentId, d]));
    expect(by[w.departments.bt].status).toBe('DEFINED');
    expect(by[w.departments.bt].head).toMatchObject({ userId: id(w, 'finance'), active: true });
    expect(by[w.departments.ik].status).toBe('NO_DEPUTY');
    expect(by[w.departments.tc].status).toBe('UNASSIGNED');
    expect(by[w.departments.tc].suggestion).toBeNull();
    const cand = r.body.candidates.map((c: any) => c.userId);
    expect(cand).toContain(id(w, 'buyer'));
    expect(cand).not.toContain(id(w, 'supplier1'));
    expect(cand).not.toContain(id(w, 'buyerB'));
  });

  it('PUT tam değiştirme: payload dışı departman değişmez, iki boş kimlik atamayı temizler; denetim approvers.set', async () => {
    const w = await fresh();
    await as(w, 'tenantAdmin', 'PUT', U, { departments: [{ departmentId: w.departments.bt, headUserId: id(w, 'finance'), deputyUserId: id(w, 'legal') }, { departmentId: w.departments.ik, headUserId: id(w, 'legal'), deputyUserId: null }] });
    const r = await as(w, 'tenantAdmin', 'PUT', U, { departments: [{ departmentId: w.departments.bt, headUserId: null, deputyUserId: null }] });
    expect(r.status).toBe(200);
    const by = Object.fromEntries(r.body.departments.map((d: any) => [d.departmentId, d]));
    expect(by[w.departments.bt].status).toBe('UNASSIGNED');
    expect(by[w.departments.ik].head.userId).toBe(id(w, 'legal'));
    const a = (await h.owner.query(`SELECT data FROM audit_events WHERE tenant_id = $1 AND action = 'approvers.set' ORDER BY id DESC LIMIT 1`, [w.tenantA])).rows[0];
    expect(a.data.before[0].primary).toBe(id(w, 'finance'));
    expect(a.data.after[0].primary).toBeNull();
  });
});

describe('doğrulama', () => {
  it('vekil = sorumlu 422 (departman, satınalma sorumlusu, direktör); hiçbir şey yazılmaz', async () => {
    const w = await fresh();
    for (const body of [
      { departments: [{ departmentId: w.departments.bt, headUserId: id(w, 'finance'), deputyUserId: id(w, 'finance') }] },
      { organization: { leadUserId: id(w, 'buyer'), leadDeputyUserId: id(w, 'buyer') } },
      { organization: { directorUserId: id(w, 'legal'), directorDeputyUserId: id(w, 'legal') } },
    ]) expect((await as(w, 'tenantAdmin', 'PUT', U, body)).status).toBe(422);
    expect((await h.owner.query(`SELECT 1 FROM approver_assignments WHERE tenant_id = $1`, [w.tenantA])).rowCount).toBe(0);
  });

  it('askıdaki kişi, tedarikçi ve başka kiracının kullanıcısı atanamaz (422); toplu istekte biri hatalıysa hepsi geri alınır', async () => {
    const w = await fresh();
    await h.owner.query(`UPDATE memberships SET status = 'SUSPENDED' WHERE tenant_id = $1 AND user_id = $2`, [w.tenantA, id(w, 'legal2')]);
    for (const bad of [id(w, 'legal2'), id(w, 'supplier1'), id(w, 'buyerB'), randomUUID()]) {
      const r = await as(w, 'tenantAdmin', 'PUT', U, { departments: [{ departmentId: w.departments.ik, headUserId: id(w, 'finance'), deputyUserId: null }, { departmentId: w.departments.bt, headUserId: bad, deputyUserId: null }] });
      expect(r.status, bad).toBe(422);
    }
    expect((await as(w, 'tenantAdmin', 'PUT', U, { organization: { directorUserId: id(w, 'buyerB') } })).status).toBe(422);
    expect((await h.owner.query(`SELECT 1 FROM approver_assignments WHERE tenant_id = $1`, [w.tenantA])).rowCount).toBe(0);
    // başka kiracının departmanı da bilinmeyen
    expect((await as(w, 'tenantAdmin', 'PUT', U, { departments: [{ departmentId: w.departmentsB.bt, headUserId: id(w, 'finance'), deputyUserId: null }] })).status).toBe(422);
  });

  it('birleştirilmiş departman listeden düşer ve atanamaz', async () => {
    const w = await fresh();
    await h.owner.query(`UPDATE departments SET merged_into = $2 WHERE id = $1`, [w.departments.tc, w.departments.bt]);
    const r = await as(w, 'tenantAdmin', 'GET', U);
    expect(r.body.departments.map((d: any) => d.departmentId)).not.toContain(w.departments.tc);
    expect((await as(w, 'tenantAdmin', 'PUT', U, { departments: [{ departmentId: w.departments.tc, headUserId: id(w, 'finance'), deputyUserId: null }] })).status).toBe(422);
  });
});

describe('askıya alma ve currentApprovers', () => {
  it('askıya alınan atanmış kişi INACTIVE görünür; currentApprovers yalnız etkin kişileri verir', async () => {
    const w = await fresh();
    await as(w, 'tenantAdmin', 'PUT', U, { organization: { leadUserId: id(w, 'buyer'), directorUserId: id(w, 'legal'), directorDeputyUserId: id(w, 'legal2') },
      departments: [{ departmentId: w.departments.bt, headUserId: id(w, 'finance'), deputyUserId: id(w, 'masterData') }] });
    await h.owner.query(`UPDATE memberships SET status = 'SUSPENDED' WHERE tenant_id = $1 AND user_id = $2`, [w.tenantA, id(w, 'finance')]);
    const r = await as(w, 'tenantAdmin', 'GET', U);
    const bt = r.body.departments.find((d: any) => d.departmentId === w.departments.bt);
    expect(bt.status).toBe('INACTIVE');
    expect(bt.head).toMatchObject({ userId: id(w, 'finance'), active: false });
    expect(r.body.candidates.map((c: any) => c.userId)).not.toContain(id(w, 'finance'));
    const ctx = { tenantId: w.tenantA, userId: id(w, 'tenantAdmin'), roles: ['ADMIN'], companyIds: [], correlationId: 'c', departmentIds: [], allDepartments: true } as any;
    const cur = await withTenant(h.pool, ctx, (tx) => currentApprovers(tx, w.departments.bt));
    expect(cur.head).toBeNull();
    expect(cur.deputy?.userId).toBe(id(w, 'masterData'));
    expect(cur.lead?.userId).toBe(id(w, 'buyer'));
    expect(cur.leadDeputy).toBeNull();
    expect(cur.director?.userId).toBe(id(w, 'legal'));
    expect(cur.directorDeputy?.userId).toBe(id(w, 'legal2'));
  });

  it('pasifleşen atanmış kişi başka satırın kaydını engellemez; aynı yerde kalan pasif kişi korunur; yeniden/yeni atama 422', async () => {
    const w = await fresh();
    await as(w, 'tenantAdmin', 'PUT', U, { organization: { leadUserId: id(w, 'buyer'), directorUserId: id(w, 'legal') },
      departments: [{ departmentId: w.departments.bt, headUserId: id(w, 'finance'), deputyUserId: id(w, 'masterData') }] });
    await h.owner.query(`UPDATE memberships SET status = 'SUSPENDED' WHERE tenant_id = $1 AND user_id = $2`, [w.tenantA, id(w, 'finance')]);
    await h.owner.query(`UPDATE memberships SET status = 'SUSPENDED' WHERE tenant_id = $1 AND user_id = $2`, [w.tenantA, id(w, 'buyer')]);
    // Başka departmanı değiştir: 200, pasif satır değişmez.
    const ok = await as(w, 'tenantAdmin', 'PUT', U, { departments: [{ departmentId: w.departments.ik, headUserId: id(w, 'legal'), deputyUserId: null }] });
    expect(ok.status).toBe(200);
    const row = async (dep: string) => (await h.owner.query<{ primary_user_id: string | null; deputy_user_id: string | null }>(
      `SELECT primary_user_id, deputy_user_id FROM approver_assignments WHERE tenant_id = $1 AND kind = 'DEPARTMENT_HEAD' AND department_id = $2`, [w.tenantA, dep])).rows[0];
    expect(await row(w.departments.bt)).toEqual({ primary_user_id: id(w, 'finance'), deputy_user_id: id(w, 'masterData') });
    // Aynı satırda yalnız vekil değişse de pasif sorumlu yerinde kalabilir; kurum satırında pasif sorumlu korunarak direktör değişir.
    expect((await as(w, 'tenantAdmin', 'PUT', U, { departments: [{ departmentId: w.departments.bt, headUserId: id(w, 'finance'), deputyUserId: id(w, 'legal2') }] })).status).toBe(200);
    expect((await as(w, 'tenantAdmin', 'PUT', U, { organization: { leadUserId: id(w, 'buyer'), directorUserId: id(w, 'legal2') } })).status).toBe(200);
    // Pasif kişiyi yeni yere atamak (başka departman, vekil yerine, kurum unvanı) 422.
    for (const body of [
      { departments: [{ departmentId: w.departments.tc, headUserId: id(w, 'finance'), deputyUserId: null }] },
      { departments: [{ departmentId: w.departments.bt, headUserId: id(w, 'legal2'), deputyUserId: id(w, 'finance') }] },
      { organization: { leadUserId: id(w, 'legal'), directorUserId: id(w, 'buyer') } },
    ]) expect((await as(w, 'tenantAdmin', 'PUT', U, body)).status, JSON.stringify(body)).toBe(422);
    expect(await row(w.departments.bt)).toEqual({ primary_user_id: id(w, 'finance'), deputy_user_id: id(w, 'legal2') });
    expect(await row(w.departments.tc)).toBeUndefined();
  });

  it('rolü kaldırılmış (roles boş, REVOKED) atanmış kişi null değil pasif kişi döner ve kayıt korunur', async () => {
    const w = await fresh();
    await as(w, 'tenantAdmin', 'PUT', U, { departments: [{ departmentId: w.departments.bt, headUserId: id(w, 'finance'), deputyUserId: id(w, 'masterData') }] });
    await h.owner.query(`UPDATE memberships SET status = 'REVOKED', roles = '{}' WHERE tenant_id = $1 AND user_id = $2`, [w.tenantA, id(w, 'finance')]);
    await h.owner.query(`UPDATE memberships SET roles = '{}' WHERE tenant_id = $1 AND user_id = $2`, [w.tenantA, id(w, 'masterData')]);
    const r = await as(w, 'tenantAdmin', 'GET', U);
    const bt = r.body.departments.find((d: any) => d.departmentId === w.departments.bt);
    expect(bt.head).toMatchObject({ userId: id(w, 'finance'), active: false });
    expect(bt.deputy).toMatchObject({ userId: id(w, 'masterData'), active: false });
    expect(bt.status).toBe('INACTIVE');
    const cand = r.body.candidates.map((c: any) => c.userId);
    expect(cand).not.toContain(id(w, 'finance'));
    expect(cand).not.toContain(id(w, 'masterData'));
    // Başka satırın kaydı bu satırı silmez; yeniden atama 422.
    expect((await as(w, 'tenantAdmin', 'PUT', U, { departments: [{ departmentId: w.departments.ik, headUserId: id(w, 'legal'), deputyUserId: null }] })).status).toBe(200);
    expect((await as(w, 'tenantAdmin', 'PUT', U, { departments: [{ departmentId: w.departments.ik, headUserId: id(w, 'finance'), deputyUserId: null }] })).status).toBe(422);
    const after = (await as(w, 'tenantAdmin', 'GET', U)).body.departments.find((d: any) => d.departmentId === w.departments.bt);
    expect(after.head?.userId).toBe(id(w, 'finance'));
    const ctx = { tenantId: w.tenantA, userId: id(w, 'tenantAdmin'), roles: ['ADMIN'], companyIds: [], correlationId: 'c', departmentIds: [], allDepartments: true } as any;
    expect((await withTenant(h.pool, ctx, (tx) => currentApprovers(tx, w.departments.bt))).head).toBeNull();
  });
});

describe('öneri', () => {
  it('önerilen kişi departmanın dizin kullanıcılarında en sık geçen yönetici; eşitlikte ada göre; etkin üyeliği yoksa atlanır', async () => {
    const w = await fresh();
    const q = (sql: string, p: unknown[]) => h.owner.query(sql, p);
    const ins = async (obj: string, user: string | null, dept: string | null, mgr: string | null, extra: { enabled?: boolean; scope?: boolean } = {}) =>
      q(`INSERT INTO directory_users (tenant_id, entra_object_id, email, display_name, department_id, manager_object_id, user_id, account_enabled, in_scope) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [w.tenantA, obj, `${obj}@example.test`, `${obj} (sentetik)`, dept, mgr, user, extra.enabled ?? true, extra.scope ?? true]);
    // yöneticiler: finance (obj-fin), legal (obj-leg), buyer (obj-buy) dizin kayıtlı
    await ins('obj-fin', id(w, 'finance'), null, null);
    await ins('obj-leg', id(w, 'legal'), null, null);
    await ins('obj-buy', id(w, 'buyer'), null, null);
    // bt: fin iki, leg bir kez -> fin
    await ins('e1', null, w.departments.bt, 'obj-fin'); await ins('e2', null, w.departments.bt, 'obj-fin'); await ins('e3', null, w.departments.bt, 'obj-leg');
    // kapsam dışı ve kapalı hesaplar sayılmaz
    await ins('e4', null, w.departments.bt, 'obj-leg', { enabled: false }); await ins('e5', null, w.departments.bt, 'obj-leg', { scope: false });
    // ik: eşitlik (buyer 'Ayşe..'?) ada göre ilk
    await ins('e6', null, w.departments.ik, 'obj-leg'); await ins('e7', null, w.departments.ik, 'obj-buy');
    const names = (await q(`SELECT id, display_name FROM users WHERE id = ANY($1)`, [[id(w, 'legal'), id(w, 'buyer')]])).rows as { id: string; display_name: string }[];
    const expectIk = names.sort((a, b) => a.display_name.localeCompare(b.display_name, 'tr-TR'))[0]!.id;
    // tc: tek yönetici ama üyeliği askıda -> öneri yok
    await ins('e8', null, w.departments.tc, 'obj-leg');
    await q(`UPDATE memberships SET status = 'SUSPENDED' WHERE tenant_id = $1 AND user_id = $2`, [w.tenantA, id(w, 'legal')]);
    const r = await as(w, 'tenantAdmin', 'GET', U);
    const by = Object.fromEntries(r.body.departments.map((d: any) => [d.departmentId, d]));
    expect(by[w.departments.bt].suggestion.userId).toBe(id(w, 'finance'));
    expect(by[w.departments.tc].suggestion).toBeNull();
    // legal askıda: ik'te yalnız buyer çözülür
    expect(by[w.departments.ik].suggestion.userId).toBe(id(w, 'buyer'));
    await q(`UPDATE memberships SET status = 'ACTIVE' WHERE tenant_id = $1 AND user_id = $2`, [w.tenantA, id(w, 'legal')]);
    const r2 = await as(w, 'tenantAdmin', 'GET', U);
    expect(r2.body.departments.find((d: any) => d.departmentId === w.departments.ik).suggestion.userId).toBe(expectIk);
  });
});
