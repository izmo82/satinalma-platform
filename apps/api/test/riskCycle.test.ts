// v2 Faz 6 (D111) Görev 5: yıllık risk döngüsü (R5, R6, R8), gecikme yükseltmesi (R7), çeyreklik gözden geçirme görevleri (R10),
// işçi zamanlayıcısı. Tüm veri sentetik (tedarikçi adları "(SENTETİK)", sorular "Test sorusu N"). Her harness kendi kiracısını kurar.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { syntheticVkn } from '@sp/domain';
import { withTenant } from '../src/db.ts';
import { systemContext } from '../src/modules/contractReminders.ts';
import {
  dailyRiskSchedules, enqueueRiskSchedules, escalateOverdueRisk, openQuarterlyReviews, processRiskJob, riskCycleTenants, riskSchedule, RISK_JOBS,
} from '../src/modules/riskCycle.ts';
import { makeHarness } from './harness.ts';

let h: Awaited<ReturnType<typeof makeHarness>>;
const rand = () => randomUUID().slice(0, 8);
let ikUser = '';
const ROW5 = { businessImpact: 3, dataSensitivity: 5, continuity: 1, integration: 3, regulation: 5, serviceType: 5 };
const today = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Istanbul' }).format(new Date());

beforeAll(async () => {
  h = await makeHarness();
  await h.owner.query(`UPDATE memberships SET department_ids = $3 WHERE tenant_id = $1 AND user_id = $2`, [h.world.tenantA, h.world.users.techEval.id, [h.world.departments.bt]]);
  const email = `risk.cycle.ik.${rand()}@example.test`;
  ikUser = (await h.owner.query(`INSERT INTO users (auth_subject, email, display_name) VALUES ($1,$2,'Risk döngüsü İK kullanıcısı (SENTETİK)') RETURNING id`, [`dev|${email}`, email])).rows[0].id;
  await h.owner.query(`INSERT INTO memberships (tenant_id, user_id, roles, company_ids, department_ids) VALUES ($1,$2,'{DEPARTMENT_USER}',$3,$4)`,
    [h.world.tenantA, ikUser, [h.world.companyA1.id], [h.world.departments.ik]]);
});
afterAll(async () => { await h.close(); });

const one = async <T = any>(sql: string, params: unknown[] = []) => (await h.owner.query(sql, params)).rows[0] as T;
const rows = async <T = any>(sql: string, params: unknown[] = []) => (await h.owner.query(sql, params)).rows as T[];
const sys = () => systemContext(h.world.tenantA, [h.world.companyA1.id, h.world.companyA2.id], `test-${rand()}`);

async function supplier(status = 'ACTIVE') {
  return (await one<{ id: string }>(`INSERT INTO suppliers (tenant_id, status, country, tax_id_type, tax_id, legal_name, created_by, activated_by, activated_at)
    VALUES ($1,$2,'TR','VKN',$3,$4,$5,$6,now()) RETURNING id`,
    [h.world.tenantA, status, syntheticVkn(String(Math.floor(Math.random() * 9e8) + 1e8)), `Döngü Tedarikçi ${rand()} (SENTETİK)`, h.world.users.buyer.id,
      h.world.users.masterData.id])).id;
}

/** Sahip bağlantısıyla yürürlükte sözleşme (APPROVED zincir, zorunlu alanlar dolu, süresi 2099'a dek). `company` verilmezse A2 (Satınalma A1 kapsamı dışında). */
async function contract(department: string, supplierId: string, company = h.world.companyA2.id) {
  const w = h.world;
  const projectId = (await one<{ id: string }>(`INSERT INTO projects (tenant_id, company_id, code, title, category, owner_user_id, created_by)
    VALUES ($1,$2,$3,'Döngü projesi (SENTETİK)','Genel',$4,$4) RETURNING id`, [w.tenantA, company, `PRJ-RC-${rand()}`, w.users.buyer.id])).id;
  const doc = (await one<{ id: string }>(`INSERT INTO documents (tenant_id, company_id, kind, title, created_by, code) VALUES ($1,$2,'CONTRACT',$3,$4,$5) RETURNING id`,
    [w.tenantA, company, `Döngü sözleşmesi ${rand()} (SENTETİK)`, w.users.buyer.id, `BLG-RC-${rand()}`])).id;
  const dv = (await one<{ id: string }>(`INSERT INTO document_versions (tenant_id, company_id, document_id, version_no, sha256, mime_type, size_bytes, storage_key,
      original_filename, basic_check_status, created_by) VALUES ($1,$2,$3,1,$4,'application/pdf',100,$5,'sozlesme.pdf','PASSED',$6) RETURNING id`,
    [w.tenantA, company, doc, 'e'.repeat(64), `tenant/${randomUUID()}`, w.users.buyer.id])).id;
  const familyId = (await one<{ id: string }>(`INSERT INTO contract_families (tenant_id, company_id, title, supplier_id, created_by, code, department_id, intake_flow,
      project_id, contract_type, owner_user_id, signed_on) VALUES ($1,$2,$3,$4,$5,$6,$7,true,$8,'SERVICE',$5,'2020-01-01') RETURNING id`,
    [w.tenantA, company, `Döngü sözleşmesi ${rand()} (SENTETİK)`, supplierId, w.users.buyer.id, `SZL-RC-${rand()}`, department, projectId])).id;
  const cvId = (await one<{ id: string }>(`INSERT INTO contract_versions (tenant_id, company_id, family_id, version_no, document_version_id, created_by)
    VALUES ($1,$2,$3,1,$4,$5) RETURNING id`, [w.tenantA, company, familyId, dv, w.users.buyer.id])).id;
  const termsId = (await one<{ id: string }>(`INSERT INTO contract_terms (tenant_id, company_id, contract_version_id, revision, currency, value_type, amount,
      start_date, end_date, source_ref, entered_by) VALUES ($1,$2,$3,1,'TRY','FIXED','1000.00','2020-01-01','2099-12-31','Madde 1 (sentetik)',$4) RETURNING id`,
    [w.tenantA, company, cvId, w.users.buyer.id])).id;
  const c = (await one<{ id: string }>(`INSERT INTO contract_approval_chains (tenant_id, family_id, version_id, terms_id, submitted_by) VALUES ($1,$2,$3,$4,$5) RETURNING id`,
    [w.tenantA, familyId, cvId, termsId, w.users.buyer.id])).id;
  await h.owner.query(`UPDATE contract_approval_chains SET closed_at = now(), outcome = 'APPROVED' WHERE id = $1`, [c]);
}

async function assessmentOf(supplierId: string, year: number) {
  return one<{ id: string; department_id: string | null; status: string; source: string; due_on: string | null; draft: any; prior_assessment_id: string | null; opened_by: string | null }>(
    `SELECT id, department_id, status, source, due_on::text AS due_on, draft, prior_assessment_id, opened_by FROM risk_assessments WHERE tenant_id = $1 AND supplier_id = $2 AND year = $3`,
    [h.world.tenantA, supplierId, year]);
}
async function rawAssessment(o: { supplier: string; year: number; department: string | null; dueOn?: string | null }) {
  return (await one<{ id: string }>(`INSERT INTO risk_assessments (tenant_id, supplier_id, year, department_id, source, due_on, opened_by)
    VALUES ($1,$2,$3,$4,'MANUAL',$5,$6) RETURNING id`, [h.world.tenantA, o.supplier, o.year, o.department, o.dueOn ?? null, h.world.users.buyer.id])).id;
}
const tasksOf = (key: string) => rows<{ status: string; assignee_role: string; assignee_user_id: string | null; department_id: string | null; due_at: Date | null; kind: string }>(
  `SELECT status, assignee_role, assignee_user_id, department_id, due_at, kind FROM tasks WHERE tenant_id = $1 AND dedupe_key = $2 ORDER BY created_at`, [h.world.tenantA, key]);
const addDays = (d: string, n: number) => { const x = new Date(`${d}T00:00:00Z`); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };

describe('R5/R6: yılı açma (POST /risk/cycles/:year/open)', () => {
  const Y = 2016;
  const s = {} as Record<'multi' | 'single' | 'prior' | 'suspended' | 'archived' | 'noContract', string>;
  beforeAll(async () => {
    s.multi = await supplier(); await contract(h.world.departments.bt, s.multi); await contract(h.world.departments.ik, s.multi);
    s.single = await supplier(); await contract(h.world.departments.bt, s.single); await contract(h.world.departments.bt, s.single);
    s.prior = await supplier(); await contract(h.world.departments.bt, s.prior); await contract(h.world.departments.ik, s.prior);
    await rawAssessment({ supplier: s.prior, year: Y - 1, department: h.world.departments.tc });
    s.suspended = await supplier('SUSPENDED'); await contract(h.world.departments.bt, s.suspended);
    s.archived = await supplier('ARCHIVED'); await contract(h.world.departments.bt, s.archived);
    s.noContract = await supplier();
  });

  it('iki departman → departmansız + Satınalma görevi; tek departman → onun görevi; önceki yıl → onun departmanı; pasif/arşiv atlanır; ikinci çağrı açmaz', async () => {
    expect((await h.call('techEval', 'POST', `/api/v1/risk/cycles/${Y}/open`)).status).toBe(403);
    expect((await h.call('auditor', 'POST', `/api/v1/risk/cycles/${Y}/open`)).status).toBe(403);
    // Satınalma (buyer) yalnız A1 şirketini görür; sözleşmeler A2'de: döngü kiracı düzeyindedir, yine de sayılır.
    const r = await h.call('buyer', 'POST', `/api/v1/risk/cycles/${Y}/open`);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const due = addDays(today(), 90);
    expect(r.body).toEqual({ year: Y, opened: 3, skippedExisting: 0, needsDepartment: 1, skippedInactive: 2, dueOn: due });

    const multi = await assessmentOf(s.multi, Y);
    expect(multi).toMatchObject({ department_id: null, status: 'OPEN', source: 'CYCLE', due_on: due, prior_assessment_id: null, opened_by: h.world.users.buyer.id });
    expect(await tasksOf(`risk:${multi.id}:department`)).toMatchObject([{ status: 'OPEN', assignee_role: 'PROCUREMENT', kind: 'risk_assessment_department', department_id: null }]);
    expect(await tasksOf(`risk:${multi.id}:due`)).toEqual([]);

    const single = await assessmentOf(s.single, Y);
    expect(single.department_id).toBe(h.world.departments.bt);
    const st = await tasksOf(`risk:${single.id}:due`);
    expect(st).toMatchObject([{ status: 'OPEN', assignee_role: 'DEPARTMENT_USER', kind: 'risk_assessment_due', department_id: h.world.departments.bt }]);
    expect(st[0]!.due_at).not.toBeNull();
    expect(await tasksOf(`risk:${single.id}:department`)).toEqual([]);

    const prior = await assessmentOf(s.prior, Y);
    expect(prior.department_id).toBe(h.world.departments.tc);
    expect(await tasksOf(`risk:${prior.id}:due`)).toMatchObject([{ status: 'OPEN', department_id: h.world.departments.tc }]);

    expect(await assessmentOf(s.suspended, Y)).toBeUndefined();
    expect(await assessmentOf(s.archived, Y)).toBeUndefined();
    expect(await assessmentOf(s.noContract, Y)).toBeUndefined();

    // Departman kullanıcısı (BT) departmansız kaydı görmez, kendi departmanınınkini görür; görevi İşlerim'de.
    expect((await h.call('techEval', 'GET', `/api/v1/risk/assessments/${multi.id}`)).status).toBe(404);
    expect((await h.call('techEval', 'GET', `/api/v1/risk/assessments/${single.id}`)).status).toBe(200);

    // İkinci çağrı (Yönetici: şirket kapsamı boş) yeni kayıt açmaz; aynı sözleşmeleri görür.
    const again = await h.call('tenantAdmin', 'POST', `/api/v1/risk/cycles/${Y}/open`);
    expect(again.status).toBe(200);
    expect(again.body).toMatchObject({ opened: 0, skippedExisting: 3, needsDepartment: 0, skippedInactive: 2 });
    expect(await tasksOf(`risk:${multi.id}:department`)).toHaveLength(1);
    expect(await tasksOf(`risk:${single.id}:due`)).toHaveLength(1);
    expect((await rows(`SELECT 1 FROM audit_events WHERE tenant_id = $1 AND action = 'risk.cycle.opened'`, [h.world.tenantA])).length).toBeGreaterThanOrEqual(2);
    expect((await rows(`SELECT 1 FROM audit_events WHERE tenant_id = $1 AND action = 'risk.assessment.opened' AND entity_id = $2`, [h.world.tenantA, single.id])).length).toBe(1);

    // Departman seçilince (T4) Satınalma görevi kapanır ve departman görevi açılır.
    const set = await h.call('buyer', 'PUT', `/api/v1/risk/assessments/${multi.id}/department`, { body: { departmentId: h.world.departments.ik } });
    expect(set.status).toBe(200);
    expect((await tasksOf(`risk:${multi.id}:department`))[0]!.status).toBe('DONE');
    expect(await tasksOf(`risk:${multi.id}:due`)).toMatchObject([{ status: 'OPEN', department_id: h.world.departments.ik }]);

    expect((await h.call('buyer', 'POST', `/api/v1/risk/cycles/1999/open`)).status).toBe(400);
  });
});

describe('R7: gecikme yükseltmesi', () => {
  it('sorumluya kişi görevi + NOT_CONFIGURED e-posta; sorumlu yoksa vekil; ikisi yoksa Satınalma kuyruğu; tekrar kurulmaz; yeni son tarih yeni döngü', async () => {
    const w = h.world;
    await h.owner.query(`INSERT INTO approver_assignments (tenant_id, kind, department_id, primary_user_id, deputy_user_id) VALUES
      ($1,'DEPARTMENT_HEAD',$2,$3,NULL), ($1,'DEPARTMENT_HEAD',$4,NULL,$5), ($1,'PROCUREMENT_LEAD',NULL,$6,NULL)`,
      [w.tenantA, w.departments.bt, w.users.techEval.id, w.departments.ik, ikUser, w.users.masterData.id]);
    const past = '2020-03-31';
    const bt = await rawAssessment({ supplier: await supplier(), year: 2017, department: w.departments.bt, dueOn: past });
    const ik = await rawAssessment({ supplier: await supplier(), year: 2017, department: w.departments.ik, dueOn: past });
    const tc = await rawAssessment({ supplier: await supplier(), year: 2017, department: w.departments.tc, dueOn: past });
    const none = await rawAssessment({ supplier: await supplier(), year: 2017, department: null, dueOn: past });
    const notYet = await rawAssessment({ supplier: await supplier(), year: 2017, department: w.departments.bt, dueOn: '2099-01-01' });
    await h.owner.query(`INSERT INTO tasks (tenant_id, kind, entity_type, entity_id, title, reason, next_action, assignee_role, dedupe_key, department_id)
      VALUES ($1,'risk_assessment_due','risk_assessment',$2,'Sentetik','Sentetik','Sentetik','DEPARTMENT_USER',$3,$4)`, [w.tenantA, bt, `risk:${bt}:due`, w.departments.bt]);

    const ctx = sys();
    const r = await withTenant(h.pool, ctx, (tx) => escalateOverdueRisk(tx, ctx, today()));
    expect(r).toMatchObject({ escalated: 4, toPerson: 2, toQueue: 2, emails: 4, emailStatus: ['NOT_CONFIGURED'] });

    expect(await tasksOf(`risk:${bt}:escalated:${past}`)).toMatchObject([{ status: 'OPEN', assignee_user_id: w.users.techEval.id, assignee_role: 'DEPARTMENT_USER',
      kind: 'risk_assessment_escalated', department_id: w.departments.bt }]);
    expect(await tasksOf(`risk:${ik}:escalated:${past}`)).toMatchObject([{ assignee_user_id: ikUser, department_id: w.departments.ik }]);
    expect(await tasksOf(`risk:${tc}:escalated:${past}`)).toMatchObject([{ assignee_user_id: null, assignee_role: 'PROCUREMENT' }]);
    expect(await tasksOf(`risk:${none}:escalated:${past}`)).toMatchObject([{ assignee_user_id: null, assignee_role: 'PROCUREMENT', department_id: null }]);
    expect(await rows(`SELECT 1 FROM tasks WHERE entity_id = $1 AND kind = 'risk_assessment_escalated'`, [notYet])).toEqual([]);
    // Asıl görev açık kalır.
    expect((await tasksOf(`risk:${bt}:due`))[0]!.status).toBe('OPEN');

    const mails = await rows<{ related_id: string; to_user_id: string; status: string; subject: string }>(
      `SELECT related_id, to_user_id, status, subject FROM email_outbox WHERE tenant_id = $1 AND related_type = 'risk_assessment' ORDER BY created_at`, [w.tenantA]);
    const byId = (id: string) => mails.filter((m) => m.related_id === id);
    expect(byId(bt)).toMatchObject([{ to_user_id: w.users.techEval.id, status: 'NOT_CONFIGURED' }]);
    expect(byId(bt)[0]!.subject).toContain('Gecikmiş risk değerlendirmesi');
    expect(byId(ik)).toMatchObject([{ to_user_id: ikUser, status: 'NOT_CONFIGURED' }]);
    expect(byId(tc)).toMatchObject([{ to_user_id: w.users.masterData.id, status: 'NOT_CONFIGURED' }]);

    // Departman kullanıcısı İşlerim'de kişi görevini görür.
    const work = await h.call('techEval', 'GET', '/api/v1/tasks');
    expect(JSON.stringify(work.body)).toContain(`Gecikmiş risk değerlendirmesi`);

    // Aynı gün/ertesi gün ikinci tarama yeni görev ya da e-posta kurmaz (görev elle kapatılmış olsa da).
    await h.owner.query(`UPDATE tasks SET status = 'DONE', closed_at = now() WHERE dedupe_key = $1`, [`risk:${ik}:escalated:${past}`]);
    const r2 = await withTenant(h.pool, ctx, (tx) => escalateOverdueRisk(tx, ctx, addDays(today(), 1)));
    expect(r2.escalated).toBe(0);
    expect((await rows(`SELECT 1 FROM email_outbox WHERE tenant_id = $1 AND related_type = 'risk_assessment'`, [w.tenantA])).length).toBe(4);

    // "Güncelle" ile yeni son tarih alan kayıt yeniden gecikirse yeni döngü anahtarı.
    await h.owner.query(`UPDATE risk_assessments SET due_on = '2021-06-30' WHERE id = $1`, [bt]);
    const r3 = await withTenant(h.pool, ctx, (tx) => escalateOverdueRisk(tx, ctx, today()));
    expect(r3.escalated).toBe(1);
    expect(await tasksOf(`risk:${bt}:escalated:2021-06-30`)).toHaveLength(1);
  });
});

describe('R10: çeyreklik gözden geçirme görevleri', () => {
  it('yalnız COMPLETED kayıtlara; ikinci çağrı yinelemez; "Değişiklik yok" görevi kapatır', async () => {
    const w = h.world;
    const Y = 2013;
    const done = await rawAssessment({ supplier: await supplier(), year: Y, department: w.departments.bt });
    const open = await rawAssessment({ supplier: await supplier(), year: Y, department: w.departments.bt });
    const otherYear = await rawAssessment({ supplier: await supplier(), year: Y + 1, department: w.departments.bt });
    for (const id of [done, otherYear]) {
      const d = await h.call('techEval', 'PUT', `/api/v1/risk/assessments/${id}/draft`, { body: { criteria: ROW5, manualScore: '15', manualNote: 'Sentetik dayanak notu' } });
      expect(d.status, JSON.stringify(d.body)).toBe(200);
      expect((await h.call('techEval', 'POST', `/api/v1/risk/assessments/${id}/complete`)).status).toBe(200);
    }
    const period = `${Y}-2`;
    const ctx = sys();
    const r = await withTenant(h.pool, ctx, (tx) => openQuarterlyReviews(tx, ctx, period));
    expect(r).toEqual({ period, opened: 1, existing: 0 });
    const t = await tasksOf(`risk:${done}:review:${period}`);
    expect(t).toMatchObject([{ status: 'OPEN', kind: 'risk_quarterly_review', assignee_role: 'DEPARTMENT_USER', department_id: w.departments.bt }]);
    expect(t[0]!.due_at!.toISOString()).toBe(new Date(`${Y}-06-30T23:59:59+03:00`).toISOString());
    expect(await tasksOf(`risk:${open}:review:${period}`)).toEqual([]);
    expect(await tasksOf(`risk:${otherYear}:review:${period}`)).toEqual([]);

    expect(await withTenant(h.pool, ctx, (tx) => openQuarterlyReviews(tx, ctx, period))).toEqual({ period, opened: 0, existing: 1 });

    const nc = await h.call('techEval', 'POST', `/api/v1/risk/assessments/${done}/reviews`, { body: { period, outcome: 'NO_CHANGE' } });
    expect(nc.status, JSON.stringify(nc.body)).toBe(201);
    expect((await tasksOf(`risk:${done}:review:${period}`))[0]!.status).toBe('DONE');
    expect(await withTenant(h.pool, ctx, (tx) => openQuarterlyReviews(tx, ctx, period))).toEqual({ period, opened: 0, existing: 0 });
  });
});

describe('R8: önceki yılın cevapları', () => {
  it('ölçütler ve kodu eşleşen cevaplar dolu gelir, yeni soru boş, değişen alan işaretlenir', async () => {
    const w = h.world;
    const Y = 2019;
    const v1 = await h.call('tenantAdmin', 'POST', '/api/v1/risk/question-sets', { body: { code: 'RC-SET', name: 'Sentetik döngü seti', questions: [
      { code: 'Q1', text: 'Test sorusu 1', weight: '2', riskAnswer: 'YES' }, { code: 'Q2', text: 'Test sorusu 2', weight: '1', riskAnswer: 'NO' }] } });
    expect(v1.status).toBe(201);
    expect((await h.call('tenantAdmin', 'POST', `/api/v1/risk/question-sets/${v1.body.id}/publish`)).status).toBe(200);
    const sup = await supplier();
    await contract(w.departments.bt, sup);
    const prev = await rawAssessment({ supplier: sup, year: Y - 1, department: w.departments.bt });
    const d = await h.call('techEval', 'PUT', `/api/v1/risk/assessments/${prev}/draft`, { body: { criteria: ROW5, questionSetId: v1.body.id, answers: { Q1: 'YES', Q2: 'YES' } } });
    expect(d.status, JSON.stringify(d.body)).toBe(200);
    expect((await h.call('techEval', 'POST', `/api/v1/risk/assessments/${prev}/complete`)).status).toBe(200);
    // Yeni sürüm: Q1, Q2 aynı kod; Q3 yeni.
    const v2 = await h.call('tenantAdmin', 'POST', '/api/v1/risk/question-sets', { body: { code: 'RC-SET', name: 'Sentetik döngü seti', questions: [
      { code: 'Q1', text: 'Test sorusu 1', weight: '2', riskAnswer: 'YES' }, { code: 'Q2', text: 'Test sorusu 2', weight: '1', riskAnswer: 'NO' },
      { code: 'Q3', text: 'Test sorusu 3', weight: '1', riskAnswer: 'YES' }] } });
    expect((await h.call('tenantAdmin', 'POST', `/api/v1/risk/question-sets/${v2.body.id}/publish`)).status).toBe(200);

    const o = await h.call('buyer', 'POST', `/api/v1/risk/cycles/${Y}/open`);
    expect(o.status).toBe(200);
    const a = await assessmentOf(sup, Y);
    expect(a.prior_assessment_id).toBe(prev);
    expect(a.department_id).toBe(w.departments.bt);
    const g = await h.call('techEval', 'GET', `/api/v1/risk/assessments/${a.id}`);
    expect(g.status).toBe(200);
    expect(g.body.draft).toMatchObject({ criteria: ROW5, questionSetId: v2.body.id, answers: { Q1: 'YES', Q2: 'YES' } });
    expect(g.body.draft.answers.Q3).toBeUndefined();
    expect(g.body.prior).toMatchObject({ year: Y - 1, assessmentId: prev });
    expect(g.body.computed.criticality).toMatchObject({ display: '3,22', column: 3 });
    expect(g.body.computed.score).toMatchObject({ value: null, missing: ['Q3'] });
    // Skor henüz yok (yeni soru boş) → yalnız skor değişti; ölçüt ve cevaplar aynı.
    expect(g.body.changed).toEqual(['riskScore']);

    const u = await h.call('techEval', 'PUT', `/api/v1/risk/assessments/${a.id}/draft`, { body: { criteria: { businessImpact: 5 }, answers: { Q3: 'NO' } } });
    expect(u.status).toBe(200);
    // Geçen yıl Q1/Q2 → 66,67; Q3 ağırlık 1 eklenince 50,00: skor da değişti.
    expect(u.body.changed).toEqual(['answers.Q3', 'criteria.businessImpact', 'riskScore']);
    expect(u.body.prior.revision).toMatchObject({ riskScore: '66.67', criteria: ROW5 });
  });
});

describe('işçi zamanlayıcısı', () => {
  it('takvim: her gün yükseltme; 1 Ocak yıllık; çeyrek başı çeyreklik (ilk 7 gün yetişme)', () => {
    const kinds = (d: string) => riskSchedule(d).map((j) => `${j.kind}|${j.key}`);
    expect(kinds('2027-01-01')).toEqual([`${RISK_JOBS.escalate}|risk-escalate:2027-01-01`, `${RISK_JOBS.annual}|risk-annual:2027`]);
    expect(kinds('2027-01-07')).toContain(`${RISK_JOBS.annual}|risk-annual:2027`);
    expect(kinds('2027-01-08')).toEqual([`${RISK_JOBS.escalate}|risk-escalate:2027-01-08`]);
    expect(kinds('2027-04-01')).toEqual([`${RISK_JOBS.escalate}|risk-escalate:2027-04-01`, `${RISK_JOBS.quarterly}|risk-quarterly:2027-2`]);
    expect(kinds('2027-10-03')).toContain(`${RISK_JOBS.quarterly}|risk-quarterly:2027-4`);
    expect(kinds('2027-02-01')).toEqual([`${RISK_JOBS.escalate}|risk-escalate:2027-02-01`]);
  });

  it('aynı gün ikinci kez iş kurmaz (kiracı başına tekil anahtar); günlük kapı; iş sonucu yazılır', async () => {
    const tenant = h.world.tenantB; // risk verisi olmayan kiracı: başka testlerin işçisi işi çekse de etkisiz.
    const lister = async () => [tenant];
    const jan1 = new Date('2031-01-01T06:00:00+03:00');
    expect(await enqueueRiskSchedules(h.pool, jan1, lister)).toBe(2);
    expect(await enqueueRiskSchedules(h.pool, new Date('2031-01-01T22:00:00+03:00'), lister)).toBe(0);
    expect(await enqueueRiskSchedules(h.pool, new Date('2031-01-02T06:00:00+03:00'), lister)).toBe(1); // yalnız yükseltme; yıllık anahtar aynı
    const jobs = await rows<{ id: string; kind: string; idempotency_key: string }>(
      `SELECT id, kind, idempotency_key FROM jobs WHERE tenant_id = $1 AND kind LIKE 'risk.%' ORDER BY idempotency_key`, [tenant]);
    expect(jobs.map((j) => j.idempotency_key)).toEqual(['risk-annual:2031', 'risk-escalate:2031-01-01', 'risk-escalate:2031-01-02']);
    expect(await enqueueRiskSchedules(h.pool, jan1, async () => null)).toBeNull();

    // Paylaşılan veritabanında başka test dosyalarının işçisi bu işleri çekmesin: yükseltme işleri hemen kapatılır.
    await h.owner.query(`UPDATE jobs SET status = 'SUCCEEDED' WHERE tenant_id = $1 AND kind = $2 AND status = 'QUEUED'`, [tenant, RISK_JOBS.escalate]);
    const annual = jobs.find((j) => j.kind === RISK_JOBS.annual)!;
    const res = await processRiskJob(h.pool, annual.kind, tenant, annual.id);
    expect(res).toMatchObject({ year: 2031, opened: 0 });
    expect(await one(`SELECT status, result->>'year' AS year FROM jobs WHERE id = $1`, [annual.id])).toEqual({ status: 'SUCCEEDED', year: '2031' });

    let calls = 0;
    const gate = dailyRiskSchedules(async () => { calls++; return 0; });
    expect(await gate(h.pool, jan1)).toBe(0);
    expect(await gate(h.pool, new Date(jan1.getTime() + 120_000))).toBeNull();
    expect(await gate(h.pool, new Date('2031-01-02T06:00:00+03:00'))).toBe(0);
    expect(calls).toBe(2);
  });

  it('054b: varsayılan kapı risk_cycle_tenants() kiracıları listeler; işçi zamanlayıcısı varsayılan kapıyla iş kurar (yalnız kimlik, sp_app)', async () => {
    const tenants = await riskCycleTenants(h.pool);
    expect(tenants).not.toBeNull();
    // A kiracısında tedarikçili sözleşme ve değerlendirme var; B'de yok.
    expect(tenants).toContain(h.world.tenantA);
    expect(tenants).not.toContain(h.world.tenantB);
    const fn = await one(`SELECT p.prosecdef, p.proconfig, has_function_privilege('public', 'risk_cycle_tenants()', 'EXECUTE') AS pub
      FROM pg_proc p WHERE p.proname = 'risk_cycle_tenants'`);
    expect(fn).toEqual({ prosecdef: true, proconfig: ['search_path=public, pg_temp'], pub: false });

    // Uzak gelecek bir gün (2093-07-01): A için yükseltme + çeyreklik iş varsayılan kapıyla kurulur; ikinci çağrı A için yeni iş kurmaz.
    const day = new Date('2093-07-01T06:00:00+03:00');
    const keys = ['risk-escalate:2093-07-01', 'risk-quarterly:2093-3'];
    const jobsOfA = () => rows<{ idempotency_key: string }>(`SELECT idempotency_key FROM jobs WHERE tenant_id = $1 AND idempotency_key = ANY($2) ORDER BY idempotency_key`,
      [h.world.tenantA, keys]);
    expect(await enqueueRiskSchedules(h.pool, day)).toBeGreaterThanOrEqual(2);
    // Kapı paylaşılan test veritabanındaki bütün kiracıları listeler: kurulan işler (her kiracıda) hemen kapatılır ki başka test
    // dosyalarının işçisi 2093 tarihli yükseltmeyi çalıştırmasın.
    await h.owner.query(`UPDATE jobs SET status = 'SUCCEEDED' WHERE idempotency_key = ANY($1) AND status = 'QUEUED'`, [keys]);
    expect((await jobsOfA()).map((j) => j.idempotency_key)).toEqual(keys);
    await enqueueRiskSchedules(h.pool, day);
    await h.owner.query(`UPDATE jobs SET status = 'SUCCEEDED' WHERE idempotency_key = ANY($1) AND status = 'QUEUED'`, [keys]);
    expect(await jobsOfA()).toHaveLength(2);
  });
});
