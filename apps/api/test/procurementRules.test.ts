// v2 Faz 7 (D112) Görev 5: sürümlü satınalma kuralları kataloğu API'si (R6, R7).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { activeRuleSet, DEFAULT_RULESET } from '@sp/domain';
import { createSyntheticWorld, type SyntheticWorld } from '../src/devdata.ts';
import { DevAuthProvider } from '../src/auth.ts';
import { withTenant } from '../src/db.ts';
import { ruleSetForDay } from '../src/modules/procurementRules.ts';
import { makeHarness } from './harness.ts';

let h: Awaited<ReturnType<typeof makeHarness>>;
let auth: DevAuthProvider;
let w2: SyntheticWorld; // başka kiracı (yönetici dahil)
beforeAll(async () => {
  h = await makeHarness();
  auth = new DevAuthProvider(h.config.devAuthSecret!);
  w2 = await createSyntheticWorld(h.owner, `-${randomUUID().slice(0, 8)}`);
});
afterAll(async () => { await h.close(); });

const R = '/api/v1/procurement-rule-sets';
const auditCount = async (tenant: string, action: string, entityId?: string) => (await h.owner.query(
  `SELECT 1 FROM audit_events WHERE tenant_id = $1 AND action = $2 AND ($3::uuid IS NULL OR entity_id = $3)`, [tenant, action, entityId ?? null])).rowCount;
const addDays = (day: string, n: number) => { const d = new Date(`${day}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
async function callW2(method: string, url: string, body?: unknown) {
  const token = await auth.issue(`dev|${w2.users.tenantAdmin.email}`);
  const res = await h.app.inject({ method: method as any, url, headers: { authorization: `Bearer ${token}`, 'x-tenant-id': w2.tenantA }, ...(body !== undefined ? { payload: body as any } : {}) });
  return { status: res.statusCode, body: res.body ? JSON.parse(res.body) : null };
}
const manualRule = (code: string, over: Record<string, unknown> = {}) => ({ code, name: `Test kuralı ${code}`, description: 'Sentetik elle kural', checkType: 'MANUAL', weight: 7, mandatory: false, ...over });

let v1: any;
let today: string;

describe('satınalma kuralları kataloğu', () => {
  it('kontrol kataloğu Türkçe ad ve parametre tanımlarıyla; okuma rolleri görür', async () => {
    for (const who of ['tenantAdmin', 'buyer', 'auditor', 'techEval'] as const) {
      const r = await h.call(who, 'GET', '/api/v1/compliance-checks');
      expect(r.status, who).toBe(200);
    }
    const c = (await h.call('auditor', 'GET', '/api/v1/compliance-checks')).body;
    expect(c.items).toHaveLength(13);
    expect(c.items.find((x: any) => x.key === 'MIN_BIDS')).toMatchObject({ name: 'En az teklif alınmış', checkType: 'DATA', checkTypeLabel: 'Otomatik (veri)',
      params: [{ key: 'minBids', label: 'En az teklif sayısı', kind: 'int', min: 1, max: 20, default: 3 }] });
    expect(c.items.find((x: any) => x.key === 'TEMPLATE_SCORE_ABOVE').params[0]).toMatchObject({ key: 'threshold', kind: 'decimal', default: '70' });
    expect(c.items.find((x: any) => x.key === 'WINNER_RESEARCH')).toMatchObject({ checkType: 'EVIDENCE_AI', checkTypeLabel: 'Kanıt + yapay zekâ', params: [] });
    expect(c.methods).toEqual([{ key: 'INVITED_BIDS', label: 'Davetli teklif' }, { key: 'SINGLE_SOURCE', label: 'Tek kaynak' }]);
  });

  it('kurulu kiracıda set yok; "Varsayılan kataloğu yükle" §3.6 satırlarıyla taslak v1 kurar; ikinci taslak 409', async () => {
    const empty = await h.call('buyer', 'GET', R);
    expect(empty.status).toBe(200);
    expect(empty.body).toMatchObject({ items: [], current: null, draft: null, scheduled: [], can: { manage: false } });
    today = empty.body.today;
    expect((await h.call('tenantAdmin', 'GET', R)).body.can.manage).toBe(true);

    const c = await h.call('tenantAdmin', 'POST', R, { body: { from: 'DEFAULT' } });
    expect(c.status, JSON.stringify(c.body)).toBe(201);
    v1 = c.body;
    expect(v1).toMatchObject({ versionNo: 1, status: 'DRAFT', statusLabel: 'Taslak', phase: 'DRAFT', effectiveFrom: null, ruleCount: 14, mandatoryCount: 4,
      createdBy: h.world.users.tenantAdmin.id, publishedAt: null, can: { manage: true } });
    expect(v1.rules.map((r: any) => r.code)).toEqual(DEFAULT_RULESET.map((r) => r.code));
    expect(v1.rules.filter((r: any) => r.mandatory).map((r: any) => r.code)).toEqual(['K01', 'K03', 'K06', 'K11']);
    const k01 = v1.rules.find((r: any) => r.code === 'K01');
    expect(k01).toMatchObject({ checkType: 'DATA', checkKey: 'MIN_BIDS', checkName: 'En az teklif alınmış', params: { minBids: 3 }, paramLabels: { minBids: 'En az teklif sayısı' },
      methods: ['INVITED_BIDS'], methodLabels: ['Davetli teklif'], weight: 15, mandatory: true, amountThreshold: null });
    expect(v1.rules.find((r: any) => r.code === 'K10').params).toEqual({ threshold: '70' });
    expect(v1.rules.find((r: any) => r.code === 'K12')).toMatchObject({ checkType: 'EVIDENCE_AI', checkKey: 'WINNER_RESEARCH' });
    expect(v1.rules.find((r: any) => r.code === 'K14')).toMatchObject({ checkType: 'MANUAL', checkTypeLabel: 'Elle', checkKey: null, params: {} });
    expect(await auditCount(h.world.tenantA, 'rule_set.created', v1.id)).toBe(1);

    const again = await h.call('tenantAdmin', 'POST', R, { body: { from: 'DEFAULT' } });
    expect([again.status, again.body.error.code, again.body.error.details.draftId]).toEqual([409, 'draft_exists', v1.id]);
    const list = (await h.call('auditor', 'GET', R)).body;
    expect(list.draft).toMatchObject({ id: v1.id, versionNo: 1 });
    expect(list.current).toBeNull();
  });

  it('Satınalma, Denetçi ve Departman kullanıcısı okur ama düzenleyemez (403)', async () => {
    const k14 = v1.rules.find((r: any) => r.code === 'K14');
    for (const who of ['buyer', 'auditor', 'techEval'] as const) {
      const g = await h.call(who, 'GET', `${R}/${v1.id}`);
      expect(g.status, who).toBe(200);
      expect(g.body.rules).toHaveLength(14);
      expect(g.body.can.manage).toBe(false);
      expect((await h.call(who, 'POST', R, { body: { from: 'DEFAULT' } })).status, who).toBe(403);
      expect((await h.call(who, 'POST', `${R}/${v1.id}/rules`, { body: manualRule('X1') })).status, who).toBe(403);
      expect((await h.call(who, 'PUT', `${R}/${v1.id}/rules/${k14.id}`, { body: manualRule('K14') })).status, who).toBe(403);
      expect((await h.call(who, 'DELETE', `${R}/${v1.id}/rules/${k14.id}`)).status, who).toBe(403);
      expect((await h.call(who, 'POST', `${R}/${v1.id}/publish`, { body: { effectiveFrom: today } })).status, who).toBe(403);
    }
    expect((await h.call('tenantAdmin', 'GET', `${R}/${v1.id}`)).body.rules).toHaveLength(14);
  });

  it('taslakta kural ekle/değiştir/sil: doğrulama 422 listeli, kod tekrarı 409, denetim önce/sonra', async () => {
    const add = await h.call('tenantAdmin', 'POST', `${R}/${v1.id}/rules`, { body: manualRule('K15', { amountThreshold: '250000', currency: 'try', methods: ['SINGLE_SOURCE'] }) });
    expect(add.status, JSON.stringify(add.body)).toBe(201);
    expect(add.body).toMatchObject({ code: 'K15', checkType: 'MANUAL', amountThreshold: '250000.00', currency: 'TRY', methods: ['SINGLE_SOURCE'], methodLabels: ['Tek kaynak'], sortOrder: 15 });
    const ev = (await h.owner.query(`SELECT data FROM audit_events WHERE tenant_id = $1 AND action = 'rule.changed' AND entity_id = $2`, [h.world.tenantA, add.body.id])).rows;
    expect(ev).toHaveLength(1);
    expect(ev[0].data).toMatchObject({ setId: v1.id, op: 'CREATE', before: null, after: { code: 'K15' } });

    // Katalog varsayılan parametresi: params verilmezse anahtarın varsayılanı.
    const d = await h.call('tenantAdmin', 'POST', `${R}/${v1.id}/rules`, { body: { code: 'K16', name: 'İkinci teklif kuralı', checkType: 'DATA', checkKey: 'MIN_BIDS', weight: 3 } });
    expect(d.status, JSON.stringify(d.body)).toBe(201);
    expect(d.body.params).toEqual({ minBids: 3 });

    const bad = [
      [{ ...manualRule('B1'), weight: 0 }, 'Ağırlık 1 ile 100 arasında tam sayı olmalı'],
      [{ ...manualRule('B2'), weight: 101 }, 'Ağırlık 1 ile 100 arasında tam sayı olmalı'],
      [{ ...manualRule('B3'), checkKey: 'MIN_BIDS' }, 'Elle kuralın kontrol anahtarı olmaz'],
      [{ code: 'B4', name: 'x', checkType: 'DATA', checkKey: 'YOK_BOYLE', weight: 5 }, 'Kontrol anahtarı katalogda yok'],
      [{ code: 'B5', name: 'x', checkType: 'DATA', checkKey: 'MIN_BIDS', params: { minBids: 0 }, weight: 5 }, 'minBids 1 ile 20 arasında tam sayı olmalı'],
      [{ code: 'B6', name: 'x', checkType: 'EVIDENCE_AI', checkKey: 'MIN_BIDS', weight: 5 }, 'Kontrol anahtarı kontrol türüyle uyuşmuyor'],
      [{ ...manualRule('B7'), methods: ['OPEN_TENDER'] }, 'Bilinmeyen yöntem: OPEN_TENDER'],
      [{ ...manualRule('B8'), amountThreshold: '1000' }, 'Tutar eşiği için para birimi gerekli'],
      [{ ...manualRule(' '), name: 'x' }, 'Kural kodu boş olamaz'],
      [{ code: 'B9', name: 'x', checkType: 'DATA', checkKey: 'TEMPLATE_SCORE_ABOVE', params: { threshold: '120' }, weight: 5 }, 'threshold 0 ile 100 arasında ondalık sayı (metin) olmalı'],
    ] as const;
    for (const [body, msg] of bad) {
      const r = await h.call('tenantAdmin', 'POST', `${R}/${v1.id}/rules`, { body });
      expect([r.status, r.body.error?.code], JSON.stringify(body)).toEqual([422, 'invalid_rule']);
      expect(r.body.error.details.errors, JSON.stringify(body)).toContain(msg);
      expect(r.body.error.message).toMatch(/^Kural geçersiz: /);
    }
    const dup = await h.call('tenantAdmin', 'POST', `${R}/${v1.id}/rules`, { body: manualRule('K14') });
    expect([dup.status, dup.body.error.code]).toEqual([409, 'duplicate_rule_code']);

    // PUT tam değiştirme; sıra korunur; önce/sonra denetimde.
    const k04 = v1.rules.find((r: any) => r.code === 'K04');
    const put = await h.call('tenantAdmin', 'PUT', `${R}/${v1.id}/rules/${k04.id}`, { body: { code: 'K04', name: k04.name, description: k04.description,
      checkType: 'DATA', checkKey: 'WINNER_RISK_CURRENT', params: { maxAgeMonths: 24 }, methods: [], weight: 9, mandatory: true } });
    expect(put.status, JSON.stringify(put.body)).toBe(200);
    expect(put.body).toMatchObject({ params: { maxAgeMonths: 24 }, weight: 9, mandatory: true, sortOrder: k04.sortOrder });
    const pe = (await h.owner.query(`SELECT data FROM audit_events WHERE tenant_id = $1 AND action = 'rule.changed' AND entity_id = $2`, [h.world.tenantA, k04.id])).rows;
    expect(pe[0].data).toMatchObject({ op: 'UPDATE', before: { params: { maxAgeMonths: 12 }, weight: 8, mandatory: false }, after: { params: { maxAgeMonths: 24 }, weight: 9, mandatory: true } });
    expect((await h.call('tenantAdmin', 'PUT', `${R}/${v1.id}/rules/${k04.id}`, { body: manualRule('K03') })).body.error.code).toBe('duplicate_rule_code');
    expect((await h.call('tenantAdmin', 'PUT', `${R}/${v1.id}/rules/${randomUUID()}`, { body: manualRule('K99') })).status).toBe(404);

    const del = await h.call('tenantAdmin', 'DELETE', `${R}/${v1.id}/rules/${d.body.id}`);
    expect(del.status).toBe(200);
    const de = (await h.owner.query(`SELECT data FROM audit_events WHERE tenant_id = $1 AND action = 'rule.changed' AND entity_id = $2`, [h.world.tenantA, d.body.id])).rows;
    expect(de.map((x) => x.data.op).sort()).toEqual(['CREATE', 'DELETE']);
    expect(de.find((x) => x.data.op === 'DELETE').data).toMatchObject({ before: { code: 'K16' }, after: null });
    const now = (await h.call('tenantAdmin', 'GET', `${R}/${v1.id}`)).body;
    expect(now.rules.map((r: any) => r.code)).toEqual([...DEFAULT_RULESET.map((r) => r.code), 'K15']);
  });

  it('yayım: geçmiş tarih ve geçersiz tarih 422; bugün yayımlanan set yürürlükte; yayımlı set düzenlenemez (409)', async () => {
    const past = await h.call('tenantAdmin', 'POST', `${R}/${v1.id}/publish`, { body: { effectiveFrom: addDays(today, -1) } });
    expect([past.status, past.body.error.code]).toEqual([422, 'effective_in_past']);
    for (const effectiveFrom of ['2026-02-30', '17.11.2026', '']) {
      const r = await h.call('tenantAdmin', 'POST', `${R}/${v1.id}/publish`, { body: { effectiveFrom } });
      expect([r.status, r.body.error.code], effectiveFrom).toEqual([422, 'invalid_date']);
    }
    const p = await h.call('tenantAdmin', 'POST', `${R}/${v1.id}/publish`, { body: { effectiveFrom: today } });
    expect(p.status, JSON.stringify(p.body)).toBe(200);
    expect(p.body).toMatchObject({ status: 'PUBLISHED', statusLabel: 'Yayımlandı', phase: 'IN_FORCE', phaseLabel: 'Yürürlükte', effectiveFrom: today,
      publishedBy: h.world.users.tenantAdmin.id, ruleCount: 15 });
    const ev = (await h.owner.query(`SELECT data FROM audit_events WHERE tenant_id = $1 AND action = 'rule_set.published' AND entity_id = $2`, [h.world.tenantA, v1.id])).rows;
    expect(ev).toHaveLength(1);
    expect(ev[0].data).toMatchObject({ versionNo: 1, effectiveFrom: today, ruleCount: 15, supersedes: null });

    const k14 = p.body.rules.find((r: any) => r.code === 'K14');
    const tries = [
      await h.call('tenantAdmin', 'POST', `${R}/${v1.id}/rules`, { body: manualRule('K20') }),
      await h.call('tenantAdmin', 'PUT', `${R}/${v1.id}/rules/${k14.id}`, { body: manualRule('K14', { weight: 50 }) }),
      await h.call('tenantAdmin', 'DELETE', `${R}/${v1.id}/rules/${k14.id}`),
      await h.call('tenantAdmin', 'POST', `${R}/${v1.id}/publish`, { body: { effectiveFrom: today } }),
    ];
    for (const t of tries) expect([t.status, t.body.error.code]).toEqual([409, 'rule_set_published']);
    expect((await h.call('tenantAdmin', 'GET', `${R}/${v1.id}`)).body.rules.find((r: any) => r.code === 'K14').weight).toBe(5);

    const list = (await h.call('techEval', 'GET', R)).body;
    expect(list.current).toMatchObject({ id: v1.id, versionNo: 1 });
    expect(list.draft).toBeNull();
  });

  it('yeni sürüm yayımlı setten kopyalanır; aynı gün yayımlanınca o günden geçerli olur; ileri tarihli setten önceye yayım 422', async () => {
    const c = await h.call('tenantAdmin', 'POST', R, { body: { from: v1.id } });
    expect(c.status, JSON.stringify(c.body)).toBe(201);
    expect(c.body).toMatchObject({ versionNo: 2, status: 'DRAFT', ruleCount: 15 });
    const src = (await h.call('tenantAdmin', 'GET', `${R}/${v1.id}`)).body.rules;
    const shape = (r: any) => [r.code, r.name, r.checkType, r.checkKey, r.params, r.methods, r.amountThreshold, r.currency, r.weight, r.mandatory, r.sortOrder];
    expect(c.body.rules.map(shape)).toEqual(src.map(shape));
    expect(c.body.rules.every((r: any) => !v1.rules.some((o: any) => o.id === r.id))).toBe(true);
    const created = (await h.owner.query(`SELECT data FROM audit_events WHERE tenant_id = $1 AND action = 'rule_set.created' AND entity_id = $2`, [h.world.tenantA, c.body.id])).rows[0];
    expect(created.data).toMatchObject({ versionNo: 2, from: { setId: v1.id, versionNo: 1 }, ruleCount: 15 });
    const k15 = c.body.rules.find((r: any) => r.code === 'K15');
    expect((await h.call('tenantAdmin', 'DELETE', `${R}/${c.body.id}/rules/${k15.id}`)).status).toBe(200);

    const p = await h.call('tenantAdmin', 'POST', `${R}/${c.body.id}/publish`, { body: { effectiveFrom: today } });
    expect(p.status, JSON.stringify(p.body)).toBe(200);
    expect(p.body).toMatchObject({ phase: 'IN_FORCE', ruleCount: 14 });
    const pub = (await h.owner.query(`SELECT data FROM audit_events WHERE tenant_id = $1 AND action = 'rule_set.published' AND entity_id = $2`, [h.world.tenantA, c.body.id])).rows[0];
    expect(pub.data.supersedes).toEqual({ setId: v1.id, versionNo: 1 });
    const list = (await h.call('buyer', 'GET', R)).body;
    expect(list.current.id).toBe(c.body.id);
    expect(list.items.map((s: any) => [s.versionNo, s.phase])).toEqual([[2, 'IN_FORCE'], [1, 'SUPERSEDED']]);
    // Eski sürüm okunur, kuralları aynen.
    expect((await h.call('auditor', 'GET', `${R}/${v1.id}`)).body).toMatchObject({ phase: 'SUPERSEDED', phaseLabel: 'Yerini yenisine bıraktı', ruleCount: 15 });

    // İleri tarihli v3; sonra bugüne v4 yayımlanamaz, v3'ün gününe yayımlanabilir.
    const future = addDays(today, 30);
    const v3 = (await h.call('tenantAdmin', 'POST', R, { body: { from: 'DEFAULT' } })).body;
    const p3 = await h.call('tenantAdmin', 'POST', `${R}/${v3.id}/publish`, { body: { effectiveFrom: future } });
    expect(p3.body).toMatchObject({ phase: 'SCHEDULED', effectiveFrom: future });
    const v4 = (await h.call('tenantAdmin', 'POST', R, { body: { from: v3.id } })).body;
    const early = await h.call('tenantAdmin', 'POST', `${R}/${v4.id}/publish`, { body: { effectiveFrom: today } });
    expect([early.status, early.body.error.code]).toEqual([422, 'effective_before_scheduled']);
    const l2 = (await h.call('buyer', 'GET', R)).body;
    expect(l2.current.id).toBe(c.body.id);
    expect(l2.scheduled.map((s: any) => s.id)).toEqual([v3.id]);
    expect(l2.draft.id).toBe(v4.id);
    expect((await h.call('tenantAdmin', 'POST', `${R}/${v4.id}/publish`, { body: { effectiveFrom: future } })).body.phase).toBe('SCHEDULED');

    // Gün seçimi: bugün v2, ileri günde aynı gün yayımlanan büyük sürüm (v4).
    const ctx = { tenantId: h.world.tenantA, userId: h.world.users.auditor.id, roles: ['AUDITOR'], companyIds: [h.world.companyA1.id], departmentIds: [], allDepartments: true, correlationId: 't5' };
    expect((await withTenant(h.pool, ctx, (tx) => ruleSetForDay(tx, today)))?.id).toBe(c.body.id);
    const fut = await withTenant(h.pool, ctx, (tx) => ruleSetForDay(tx, future));
    expect([fut?.id, fut?.versionNo, fut?.rules.length]).toEqual([v4.id, 4, 14]);
  });

  it('boş taslak yayımlanamaz (422)', async () => {
    const d = (await callW2('POST', R, { from: 'DEFAULT' })).body;
    for (const r of d.rules) expect((await callW2('DELETE', `${R}/${d.id}/rules/${r.id}`)).status).toBe(200);
    const p = await callW2('POST', `${R}/${d.id}/publish`, { effectiveFrom: addDays(today, 1) });
    expect([p.status, p.body.error.code]).toEqual([422, 'rules_required']);
    // Taslağı kapat (sonraki testler için kiracıda tek taslak kuralı): bir kural ekle ve ileri tarihe yayımla.
    expect((await callW2('POST', `${R}/${d.id}/rules`, manualRule('Z1'))).status).toBe(201);
    expect((await callW2('POST', `${R}/${d.id}/publish`, { effectiveFrom: addDays(today, 400) })).status).toBe(200);
  });

  it('başka kiracının seti 404 (okuma, kopyalama, düzenleme, yayım)', async () => {
    expect((await callW2('GET', `${R}/${v1.id}`)).status).toBe(404);
    expect((await callW2('POST', R, { from: v1.id })).status).toBe(404);
    const draft = (await h.call('tenantAdmin', 'GET', R)).body.draft;
    expect(draft).toBeNull();
    // A kiracısında açık taslak oluştur; B yöneticisi dokunamaz.
    const a = (await h.call('tenantAdmin', 'POST', R, { body: { from: v1.id } })).body;
    const k01 = a.rules.find((r: any) => r.code === 'K01');
    expect((await callW2('POST', `${R}/${a.id}/rules`, manualRule('Y1'))).status).toBe(404);
    expect((await callW2('PUT', `${R}/${a.id}/rules/${k01.id}`, manualRule('K01'))).status).toBe(404);
    expect((await callW2('DELETE', `${R}/${a.id}/rules/${k01.id}`)).status).toBe(404);
    expect((await callW2('POST', `${R}/${a.id}/publish`, { effectiveFrom: addDays(today, 400) })).status).toBe(404);
    expect((await callW2('GET', R)).body.items.some((s: any) => s.id === a.id || s.id === v1.id)).toBe(false);
    // Kural kimliği başka setin yolundan erişilemez.
    const w2set = (await callW2('GET', R)).body.items[0];
    expect((await h.call('tenantAdmin', 'DELETE', `${R}/${w2set.id}/rules/${k01.id}`)).status).toBe(404);
    expect((await h.call('tenantAdmin', 'GET', `${R}/${a.id}`)).body.rules).toHaveLength(15);
  });

  it('tamamlanma gününe göre doğru set (geçmiş tarihli setler; eşit günde büyük sürüm; taslak sayılmaz) — activeRuleSet ile aynı', async () => {
    const w3 = await createSyntheticWorld(h.owner, `-${randomUUID().slice(0, 8)}`);
    const admin = w3.users.tenantAdmin.id;
    const mk = async (version: number, eff: string | null) => {
      const s = (await h.owner.query<{ id: string }>(`INSERT INTO procurement_rule_sets (tenant_id, version_no, created_by) VALUES ($1,$2,$3) RETURNING id`, [w3.tenantA, version, admin])).rows[0]!;
      await h.owner.query(`INSERT INTO procurement_rules (tenant_id, rule_set_id, code, name, check_type, weight) VALUES ($1,$2,'M1','Elle kural','MANUAL',$3)`, [w3.tenantA, s.id, version]);
      if (eff) await h.owner.query(`UPDATE procurement_rule_sets SET status = 'PUBLISHED', effective_from = $2, published_by = $3, published_at = now() WHERE id = $1`, [s.id, eff, admin]);
      return s.id;
    };
    const s1 = await mk(1, '2026-01-01');
    const s2 = await mk(2, '2026-06-01');
    const s3 = await mk(3, '2026-06-01');
    const s4 = await mk(4, '2026-03-01'); // geç yayımlanmış ama erken tarihli (doğrudan veri; API bunu engeller)
    await mk(5, null); // taslak
    const ctx = { tenantId: w3.tenantA, userId: w3.users.auditor.id, roles: ['AUDITOR'], companyIds: [w3.companyA1.id], departmentIds: [], allDepartments: true, correlationId: 't5' };
    const sets = [{ id: s1, e: '2026-01-01', v: 1 }, { id: s2, e: '2026-06-01', v: 2 }, { id: s3, e: '2026-06-01', v: 3 }, { id: s4, e: '2026-03-01', v: 4 }];
    const cases: [string, string | null][] = [
      ['2025-12-31', null], ['2026-01-01', s1], ['2026-02-28', s1], ['2026-03-01', s4], ['2026-05-31', s4], ['2026-06-01', s3], ['2027-01-01', s3],
    ];
    for (const [day, want] of cases) {
      const got = await withTenant(h.pool, ctx, (tx) => ruleSetForDay(tx, day));
      expect(got?.id ?? null, day).toBe(want);
      if (got) expect(got.rules.map((r) => [r.code, r.weight]), day).toEqual([['M1', sets.find((s) => s.id === want)!.v]]);
      // Domain activeRuleSet (sürüm sırası kimlikte) aynı sonucu verir.
      const dom = activeRuleSet(sets.map((s) => ({ id: String(s.v).padStart(10, '0'), status: 'PUBLISHED', effectiveFrom: s.e, real: s.id })), day);
      expect(dom?.real ?? null, day).toBe(want);
    }
    // Başka kiracının setleri hiçbir gün görünmez.
    const other = { ...ctx, tenantId: w2.tenantA, userId: w2.users.auditor.id, companyIds: [w2.companyA1.id] };
    const o = await withTenant(h.pool, other, (tx) => ruleSetForDay(tx, '2099-01-01'));
    expect(o).not.toBeNull();
    expect(sets.some((s) => s.id === o!.id)).toBe(false);
    expect(o!.rules.map((r) => r.code)).toEqual(['Z1']);
    expect((await withTenant(h.pool, ctx, (tx) => ruleSetForDay(tx, '2099-01-01')))?.id).toBe(s3);
  });
});
