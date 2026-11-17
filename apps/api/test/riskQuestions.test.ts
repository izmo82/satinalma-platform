// v2 Faz 6 (D111) Görev 3: risk soru setleri ve ayar API'si. Uygulama soru içermez (R4); testlerdeki sorular açıkça sentetiktir.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { createSyntheticWorld, type SyntheticWorld } from '../src/devdata.ts';
import { DevAuthProvider } from '../src/auth.ts';
import { makeHarness } from './harness.ts';

let h: Awaited<ReturnType<typeof makeHarness>>;
let auth: DevAuthProvider;
let w: SyntheticWorld;
beforeAll(async () => { h = await makeHarness(); auth = new DevAuthProvider(h.config.devAuthSecret!); w = await createSyntheticWorld(h.owner, `-${randomUUID().slice(0, 8)}`); });
afterAll(async () => { await h.close(); });

type UserKey = keyof SyntheticWorld['users'];
const parse = (b: string) => { try { return b ? JSON.parse(b) : null; } catch { return b; } };
async function call(who: UserKey, method: string, url: string, body?: unknown) {
  const token = await auth.issue(`dev|${w.users[who].email}`);
  const res = await h.app.inject({ method: method as any, url, headers: { authorization: `Bearer ${token}`, 'x-tenant-id': w.tenantA },
    ...(body !== undefined ? { payload: body as any } : {}) });
  return { status: res.statusCode, body: parse(res.body) };
}
const q = (n: number, over: Record<string, unknown> = {}) => ({ code: `Q${n}`, text: `Test sorusu ${n}`, weight: '1', riskAnswer: 'YES', ...over });
const body = (code: string, over: Record<string, unknown> = {}) => ({ code, name: `Test seti ${code}`, questions: [q(1, { weight: '2.5' }), q(2, { weight: 1, riskAnswer: 'NO' })], ...over });
const audits = async (action: string) => (await h.owner.query(`SELECT 1 FROM audit_events WHERE tenant_id = $1 AND action = $2`, [w.tenantA, action])).rowCount;

describe('risk soru setleri', () => {
  it('kurulu kiracıda set listesi boş (seed soru yok); okuma izni olanlar görür', async () => {
    for (const who of ['tenantAdmin', 'buyer', 'techEval', 'auditor'] as const) {
      const r = await call(who, 'GET', '/api/v1/risk/question-sets');
      expect(r.status, who).toBe(200);
      expect(r.body.items).toEqual([]);
    }
    expect((await call('buyer', 'GET', '/api/v1/risk/question-sets')).body.can.manage).toBe(false);
    expect((await call('tenantAdmin', 'GET', '/api/v1/risk/question-sets')).body.can.manage).toBe(true);
  });

  it('yönetici taslak oluşturur ve yayımlar; ağırlık decimal string; Satınalma 403', async () => {
    expect((await call('buyer', 'POST', '/api/v1/risk/question-sets', body('GEN'))).status).toBe(403);
    expect((await call('buyer', 'POST', '/api/v1/risk/question-sets/00000000-0000-4000-8000-000000000001/publish')).status).toBe(403);
    const c = await call('tenantAdmin', 'POST', '/api/v1/risk/question-sets', body('GEN', { scopeNote: 'Test kapsamı' }));
    expect(c.status, JSON.stringify(c.body)).toBe(201);
    expect(c.body).toMatchObject({ code: 'GEN', version: 1, status: 'DRAFT', questionCount: 2, totalWeight: '3.50', scopeNote: 'Test kapsamı', publishedAt: null });
    expect(c.body.questions.map((x: any) => [x.ordinal, x.code, x.weight, x.riskAnswer])).toEqual([[1, 'Q1', '2.50', 'YES'], [2, 'Q2', '1.00', 'NO']]);
    expect(await audits('risk.questions.created')).toBeGreaterThanOrEqual(1);

    const p = await call('tenantAdmin', 'POST', `/api/v1/risk/question-sets/${c.body.id}/publish`);
    expect(p.status, JSON.stringify(p.body)).toBe(200);
    expect(p.body).toMatchObject({ status: 'PUBLISHED', publishedBy: w.users.tenantAdmin.id });
    expect(p.body.publishedAt).toBeTruthy();
    expect(await audits('risk.questions.published')).toBeGreaterThanOrEqual(1);
    // Yayımlanmış set yeniden yayımlanmaz.
    expect((await call('tenantAdmin', 'POST', `/api/v1/risk/question-sets/${c.body.id}/publish`)).status).toBe(409);

    const list = (await call('buyer', 'GET', '/api/v1/risk/question-sets')).body.items.find((s: any) => s.id === c.body.id);
    expect(list).toMatchObject({ status: 'PUBLISHED', questionCount: 2, totalWeight: '3.50' });
    const get = await call('techEval', 'GET', `/api/v1/risk/question-sets/${c.body.id}`);
    expect(get.status).toBe(200);
    expect(get.body.questions).toHaveLength(2);
    expect((await call('buyer', 'GET', `/api/v1/risk/question-sets/${randomUUID()}`)).status).toBe(404);
  });

  it('yeni sürüm eskisini yayımda RETIRED yapar; eski sürüm okunur; yayımlanmış set veritabanında da değişmez', async () => {
    const v1 = (await call('tenantAdmin', 'POST', '/api/v1/risk/question-sets', body('VER'))).body;
    await call('tenantAdmin', 'POST', `/api/v1/risk/question-sets/${v1.id}/publish`);
    const v2 = await call('tenantAdmin', 'POST', '/api/v1/risk/question-sets', body('VER', { questions: [q(1), q(2), q(3)] }));
    expect(v2.body).toMatchObject({ version: 2, status: 'DRAFT', questionCount: 3, totalWeight: '3.00' });
    // Taslak yayımlanana dek v1 yayımlı kalır.
    expect((await call('buyer', 'GET', `/api/v1/risk/question-sets/${v1.id}`)).body.status).toBe('PUBLISHED');
    expect((await call('tenantAdmin', 'POST', `/api/v1/risk/question-sets/${v2.body.id}/publish`)).body.status).toBe('PUBLISHED');
    const old = await call('buyer', 'GET', `/api/v1/risk/question-sets/${v1.id}`);
    expect(old.body).toMatchObject({ version: 1, status: 'RETIRED', questionCount: 2 });
    expect(old.body.questions.map((x: any) => x.code)).toEqual(['Q1', 'Q2']);
    // Emekli set yayımlanmaz.
    expect((await call('tenantAdmin', 'POST', `/api/v1/risk/question-sets/${v1.id}/publish`)).status).toBe(409);
    const items = (await call('buyer', 'GET', '/api/v1/risk/question-sets')).body.items.filter((s: any) => s.code === 'VER');
    expect(items.map((s: any) => [s.version, s.status])).toEqual([[2, 'PUBLISHED'], [1, 'RETIRED']]);
    // Değişmezlik (tetikleyici): yayımlı setin sorusu değişmez (sahip bağlantısı bile).
    await expect(h.owner.query(`UPDATE risk_questions SET text = 'Değişti' WHERE set_id = $1`, [v2.body.id])).rejects.toThrow(/immutable_record/);
  });

  it('doğrulama: boş liste, tekrar eden kod, ağırlık ≤ 0 ya da geçersiz → 422', async () => {
    const e1 = await call('tenantAdmin', 'POST', '/api/v1/risk/question-sets', body('BAD1', { questions: [] }));
    expect([e1.status, e1.body.error?.code]).toEqual([422, 'questions_required']);
    const e2 = await call('tenantAdmin', 'POST', '/api/v1/risk/question-sets', body('BAD2', { questions: [q(1), q(1, { text: 'Test sorusu tekrar' })] }));
    expect([e2.status, e2.body.error?.code]).toEqual([422, 'duplicate_question_code']);
    for (const weight of ['0', 0, '-1', -2, 'abc', '1.234', '']) {
      const e = await call('tenantAdmin', 'POST', '/api/v1/risk/question-sets', body('BAD3', { questions: [q(1, { weight })] }));
      expect([e.status, e.body.error?.code], JSON.stringify(weight)).toEqual([422, 'invalid_weight']);
    }
    expect((await call('tenantAdmin', 'POST', '/api/v1/risk/question-sets', body('BAD4', { questions: [q(1, { riskAnswer: 'MAYBE' })] }))).status).toBe(400);
    expect((await call('tenantAdmin', 'POST', '/api/v1/risk/question-sets', body('X'))).status).toBe(422); // kod çok kısa
    // Hiçbiri kaydedilmedi.
    const codes = (await call('buyer', 'GET', '/api/v1/risk/question-sets')).body.items.map((s: any) => s.code);
    expect(codes.filter((c: string) => c.startsWith('BAD') || c === 'X')).toEqual([]);
  });

  it('başka kiracının seti görünmez', async () => {
    const c = (await call('tenantAdmin', 'POST', '/api/v1/risk/question-sets', body('ISO'))).body;
    const token = await auth.issue(`dev|${w.users.buyerB.email}`);
    const res = await h.app.inject({ method: 'GET', url: `/api/v1/risk/question-sets/${c.id}`, headers: { authorization: `Bearer ${token}`, 'x-tenant-id': w.tenantB } });
    expect(res.statusCode).toBe(404);
  });
});

describe('risk ayarı', () => {
  it('varsayılan 90; 7–365 dışı 422; yalnız Yönetici/Satınalma; denetim', async () => {
    const g = await call('tenantAdmin', 'GET', '/api/v1/settings/risk');
    expect(g.body).toMatchObject({ dueDays: 90, isDefault: true, updatedBy: null });
    expect((await call('techEval', 'GET', '/api/v1/settings/risk')).status).toBe(403);
    expect((await call('techEval', 'PUT', '/api/v1/settings/risk', { dueDays: 30 })).status).toBe(403);
    expect((await call('auditor', 'PUT', '/api/v1/settings/risk', { dueDays: 30 })).status).toBe(403);
    for (const dueDays of [6, 366, 0, -5, 30.5]) {
      const e = await call('tenantAdmin', 'PUT', '/api/v1/settings/risk', { dueDays });
      expect([e.status, e.body.error?.code], String(dueDays)).toEqual([422, 'invalid_due_days']);
    }
    expect((await call('tenantAdmin', 'PUT', '/api/v1/settings/risk', { dueDays: 'abc' })).status).toBe(400);
    expect((await call('tenantAdmin', 'PUT', '/api/v1/settings/risk', {})).status).toBe(400);
    for (const d of [7, 365, 45]) {
      const p = await call(d === 45 ? 'buyer' : 'tenantAdmin', 'PUT', '/api/v1/settings/risk', { dueDays: d });
      expect(p.status, JSON.stringify(p.body)).toBe(200);
      expect(p.body).toMatchObject({ dueDays: d, isDefault: false });
    }
    const after = await call('buyer', 'GET', '/api/v1/settings/risk');
    expect(after.body).toMatchObject({ dueDays: 45, updatedBy: w.users.buyer.id });
    expect(await audits('risk.settings.updated')).toBe(3);
  });
});
