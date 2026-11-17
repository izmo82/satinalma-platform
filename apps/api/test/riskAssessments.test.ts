// v2 Faz 6 (D111) Görev 4: yıllık risk değerlendirmesi API'si — taslak (R4/R8), tamamlama (R9, değişmez revizyon), aksiyon/kontrol,
// görüş (katkıcı departman), sorumlu departman, çeyreklik gözden geçirme (R10), matris, liste, tedarikçi geçmişi, currentRisk, portal (R13).
// Tüm veri sentetik ("Test sorusu 1" gibi açıkça sentetik sorular; kurum şablonu değildir). Excel satırları yalnız ölçüt değerleriyle.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { DevAuthProvider } from '../src/auth.ts';
import { withTenant } from '../src/db.ts';
import { currentRisk } from '../src/modules/riskAssessments.ts';
import { makeHarness } from './harness.ts';

let h: Awaited<ReturnType<typeof makeHarness>>;
let auth: DevAuthProvider;
// Geçmiş yıllar: çeyreklik gözden geçirme dönemi bugünkü çeyrekten sonra olamaz.
let yearSeq = 2010;
const nextYear = () => yearSeq++;
const rand = () => randomUUID().slice(0, 8);
const extra: Record<string, { id: string; email: string }> = {};

beforeAll(async () => {
  h = await makeHarness();
  auth = new DevAuthProvider(h.config.devAuthSecret!);
  // techEval yalnız BT departmanında; İK ve Tıbbi Cihaz için ayrı sentetik departman kullanıcıları.
  await h.owner.query(`UPDATE memberships SET department_ids = $3 WHERE tenant_id = $1 AND user_id = $2`, [h.world.tenantA, h.world.users.techEval.id, [h.world.departments.bt]]);
  for (const [key, dep] of [['ik', h.world.departments.ik], ['tc', h.world.departments.tc]] as const) {
    const email = `risk.${key}.${rand()}@example.test`;
    const id = (await h.owner.query(`INSERT INTO users (auth_subject, email, display_name) VALUES ($1,$2,$3) RETURNING id`, [`dev|${email}`, email, `Risk ${key} kullanıcısı (SENTETİK)`])).rows[0].id;
    await h.owner.query(`INSERT INTO memberships (tenant_id, user_id, roles, company_ids, department_ids) VALUES ($1,$2,'{DEPARTMENT_USER}',$3,$4)`,
      [h.world.tenantA, id, [h.world.companyA1.id], [dep]]);
    extra[key] = { id, email };
  }
});
afterAll(async () => { await h.close(); });

type Who = keyof typeof h.world.users | 'ik' | 'tc';
async function call(who: Who, method: string, url: string, body?: unknown) {
  const email = who === 'ik' || who === 'tc' ? extra[who]!.email : h.world.users[who as keyof typeof h.world.users].email;
  const token = await auth.issue(`dev|${email}`);
  const res = await h.app.inject({ method: method as any, url, headers: { authorization: `Bearer ${token}`, 'x-tenant-id': h.world.tenantA },
    ...(body !== undefined ? { payload: body as any } : {}) });
  let parsed: any = null;
  try { parsed = res.body ? JSON.parse(res.body) : null; } catch { parsed = res.body; }
  return { status: res.statusCode, body: parsed, raw: res.body };
}
const one = async <T = any>(sql: string, params: unknown[] = []) => (await h.owner.query(sql, params)).rows[0] as T;
const audits = async (action: string, entityId?: string) =>
  (await h.owner.query(`SELECT 1 FROM audit_events WHERE tenant_id = $1 AND action = $2 AND ($3::uuid IS NULL OR entity_id = $3::uuid)`, [h.world.tenantA, action, entityId ?? null])).rowCount;

/** Sahip bağlantısıyla OPEN değerlendirme (yıllık döngü T5'in açtığı kaydın eşdeğeri) + departman görevi. */
async function assessment(o: { supplier?: string; year?: number; department?: string | null } = {}) {
  const year = o.year ?? nextYear();
  const id = (await one<{ id: string }>(`INSERT INTO risk_assessments (tenant_id, supplier_id, year, department_id, source, due_on, opened_by)
    VALUES ($1,$2,$3,$4,'CYCLE','2099-03-31',$5) RETURNING id`,
    [h.world.tenantA, o.supplier ?? h.world.suppliers.s1, year, o.department === undefined ? h.world.departments.bt : o.department, h.world.users.buyer.id])).id;
  return { id, year };
}
async function task(assessmentId: string, key: string, kind = 'risk_assessment_due') {
  await h.owner.query(`INSERT INTO tasks (tenant_id, kind, entity_type, entity_id, title, reason, next_action, assignee_role, dedupe_key, department_id)
    VALUES ($1,$2,'risk_assessment',$3,'Sentetik risk görevi','Sentetik','Sentetik',$5,$4,(SELECT department_id FROM risk_assessments WHERE id = $3))`,
    [h.world.tenantA, kind, assessmentId, key, kind === 'risk_assessment_department' ? 'PROCUREMENT' : 'DEPARTMENT_USER']);
}
const taskStatus = async (key: string) => (await h.owner.query(`SELECT status FROM tasks WHERE tenant_id = $1 AND dedupe_key = $2 ORDER BY created_at DESC LIMIT 1`, [h.world.tenantA, key])).rows[0]?.status;

/** Sahip bağlantısıyla yürürlükte sözleşme (APPROVED zincir, tüm zorunlu alanlar dolu, süresi 2099'a dek). */
async function contract(department: string, supplier: string) {
  const w = h.world;
  const projectId = (await one<{ id: string }>(`INSERT INTO projects (tenant_id, company_id, code, title, category, owner_user_id, created_by)
    VALUES ($1,$2,$3,'Risk projesi (SENTETİK)','Genel',$4,$4) RETURNING id`, [w.tenantA, w.companyA1.id, `PRJ-RA-${rand()}`, w.users.buyer.id])).id;
  const doc = (await one<{ id: string }>(`INSERT INTO documents (tenant_id, company_id, kind, title, created_by, code) VALUES ($1,$2,'CONTRACT',$3,$4,$5) RETURNING id`,
    [w.tenantA, w.companyA1.id, `Risk sözleşmesi ${rand()} (SENTETİK)`, w.users.buyer.id, `BLG-RA-${rand()}`])).id;
  const dv = (await one<{ id: string }>(`INSERT INTO document_versions (tenant_id, company_id, document_id, version_no, sha256, mime_type, size_bytes, storage_key,
      original_filename, basic_check_status, created_by) VALUES ($1,$2,$3,1,$4,'application/pdf',100,$5,'sozlesme.pdf','PASSED',$6) RETURNING id`,
    [w.tenantA, w.companyA1.id, doc, 'd'.repeat(64), `tenant/${randomUUID()}`, w.users.buyer.id])).id;
  const familyId = (await one<{ id: string }>(`INSERT INTO contract_families (tenant_id, company_id, title, supplier_id, created_by, code, department_id, intake_flow,
      project_id, contract_type, owner_user_id, signed_on) VALUES ($1,$2,$3,$4,$5,$6,$7,true,$8,'SERVICE',$5,'2020-01-01') RETURNING id`,
    [w.tenantA, w.companyA1.id, `Risk sözleşmesi ${rand()} (SENTETİK)`, supplier, w.users.buyer.id, `SZL-RA-${rand()}`, department, projectId])).id;
  const cvId = (await one<{ id: string }>(`INSERT INTO contract_versions (tenant_id, company_id, family_id, version_no, document_version_id, created_by)
    VALUES ($1,$2,$3,1,$4,$5) RETURNING id`, [w.tenantA, w.companyA1.id, familyId, dv, w.users.buyer.id])).id;
  const termsId = (await one<{ id: string }>(`INSERT INTO contract_terms (tenant_id, company_id, contract_version_id, revision, currency, value_type, amount,
      start_date, end_date, source_ref, entered_by) VALUES ($1,$2,$3,1,'TRY','FIXED','1000.00','2020-01-01','2099-12-31','Madde 1 (sentetik)',$4) RETURNING id`,
    [w.tenantA, w.companyA1.id, cvId, w.users.buyer.id])).id;
  const c = (await one<{ id: string }>(`INSERT INTO contract_approval_chains (tenant_id, family_id, version_id, terms_id, submitted_by) VALUES ($1,$2,$3,$4,$5) RETURNING id`,
    [w.tenantA, familyId, cvId, termsId, w.users.buyer.id])).id;
  await h.owner.query(`UPDATE contract_approval_chains SET closed_at = now(), outcome = 'APPROVED' WHERE id = $1`, [c]);
  return familyId;
}

/**
 * M6 için: ilk revizyonun oluşturulma anını değerlendirme yılına çeker (testler geçmiş yıllarla çalışır; revizyon bugün yazılır).
 * Revizyon değişmezlik tetikleyicisi yalnız bu yardımcıda, süper kullanıcı oturumunda replica moduyla atlanır (uygulama yolu değil).
 */
async function backdateFirstRevision(assessmentId: string, at: string) {
  if (!/^[0-9a-f-]{36}$/.test(assessmentId) || !/^\d{4}-\d{2}-\d{2}$/.test(at)) throw new Error('bad input');
  await h.owner.query(`BEGIN; SET LOCAL session_replication_role = replica;
    UPDATE risk_assessment_revisions SET created_at = '${at}T12:00:00+03:00' WHERE assessment_id = '${assessmentId}' AND revision_no = 1; COMMIT;`);
}
const tasksOf = async (who: Who) => (await call(who, 'GET', '/api/v1/tasks?view=all')).body.items as any[];

// Excel satır 5 ve satır 54 ölçütleri.
const ROW5 = { businessImpact: 3, dataSensitivity: 5, continuity: 1, integration: 3, regulation: 5, serviceType: 5 };
const ROW54 = { businessImpact: 5, dataSensitivity: 5, continuity: 5, integration: 3, regulation: 5, serviceType: 5 };
let setId = '';
const ANSWERS_50 = { Q1: 'YES', Q2: 'YES', Q3: 'NO' }; // Q1 (2, riskli YES) riskli; Q2 (1, riskli NO) değil; Q3 (1, riskli YES) değil → 2/4 = 50,00

describe('R4: soru seti yokken elle sonuç', () => {
  it('Excel satır 5 + elle 15 → kritiklik 3,22, sütun 3, seviye 2; not zorunlu; tamamlanır, görev kapanır; Denetçi okur yazamaz', async () => {
    const a = await assessment();
    await task(a.id, `risk:${a.id}:due`);
    const noNote = await call('techEval', 'PUT', `/api/v1/risk/assessments/${a.id}/draft`, { criteria: ROW5, manualScore: '15' });
    expect([noNote.status, noNote.body.error?.code]).toEqual([422, 'manual_note_required']);
    const d = await call('techEval', 'PUT', `/api/v1/risk/assessments/${a.id}/draft`, { criteria: ROW5, manualScore: 15, manualNote: 'Şablon dışında hesaplanan sonuç (sentetik)' });
    expect(d.status, JSON.stringify(d.body)).toBe(200);
    expect(d.body.computed.criticality).toEqual({ value: '3.224968', display: '3,22', column: 3 });
    expect(d.body.computed.score).toMatchObject({ value: '15.00', source: 'MANUAL_RESULT', sourceLabel: 'Elle girilen şablon sonucu' });
    expect(d.body.computed.level).toMatchObject({ level: 2, band: 1 });
    expect(d.body.computed.blockers).toEqual([]);
    expect(d.body.manualResultAllowed).toBe(true);
    expect(d.body.can).toMatchObject({ edit: true, complete: true });
    expect(await audits('risk.draft_saved', a.id)).toBe(1);

    // Denetçi okur, yazamaz.
    const aud = await call('auditor', 'GET', `/api/v1/risk/assessments/${a.id}`);
    expect(aud.status).toBe(200);
    expect(aud.body.can).toMatchObject({ edit: false, complete: false, review: false });
    expect((await call('auditor', 'PUT', `/api/v1/risk/assessments/${a.id}/draft`, { criteria: ROW5 })).status).toBe(403);
    expect((await call('auditor', 'POST', `/api/v1/risk/assessments/${a.id}/complete`)).status).toBe(403);
    expect((await call('auditor', 'POST', `/api/v1/risk/assessments/${a.id}/actions`, { kind: 'MITIGATION', title: 'Sentetik' })).status).toBe(403);

    const c = await call('techEval', 'POST', `/api/v1/risk/assessments/${a.id}/complete`);
    expect(c.status, JSON.stringify(c.body)).toBe(200);
    expect(c.body.assessment.status).toBe('COMPLETED');
    expect(c.body.revisions).toHaveLength(1);
    expect(c.body.revisions[0]).toMatchObject({ revisionNo: 1, criticality: '3.224968', criticalityDisplay: '3,22', column: 3, riskScore: '15.00', level: 2,
      scoreSource: 'MANUAL_RESULT', scoreNote: 'Şablon dışında hesaplanan sonuç (sentetik)', methodVersion: 'khc-it-2100-002-r009/v1' });
    expect(await taskStatus(`risk:${a.id}:due`)).toBe('DONE');
    expect(await audits('risk.completed', a.id)).toBe(1);
    // Tamamlanmış kayıt taslakla değişmez; yeniden tamamlanmaz.
    expect((await call('techEval', 'PUT', `/api/v1/risk/assessments/${a.id}/draft`, { criteria: ROW54 })).status).toBe(409);
    expect((await call('techEval', 'POST', `/api/v1/risk/assessments/${a.id}/complete`)).status).toBe(409);
  });
});

describe('soru setiyle değerlendirme', () => {
  it('yayımlanmış set varken elle sonuç 422 questions_available; taslak set seçilemez; Excel satır 5 + 3 soruluk set → 3,22 / 50,00 / seviye 3', async () => {
    const draftSet = await call('tenantAdmin', 'POST', '/api/v1/risk/question-sets', { code: 'RA-TASLAK', name: 'Sentetik taslak set',
      questions: [{ code: 'Q1', text: 'Test sorusu 1', weight: '1' }] });
    const s = await call('tenantAdmin', 'POST', '/api/v1/risk/question-sets', { code: 'RA-TEST', name: 'Sentetik test seti', questions: [
      { code: 'Q1', text: 'Test sorusu 1', weight: '2', riskAnswer: 'YES' }, { code: 'Q2', text: 'Test sorusu 2', weight: '1', riskAnswer: 'NO' },
      { code: 'Q3', text: 'Test sorusu 3', weight: '1', riskAnswer: 'YES' }] });
    expect(s.status).toBe(201);
    setId = s.body.id;
    expect((await call('tenantAdmin', 'POST', `/api/v1/risk/question-sets/${setId}/publish`)).status).toBe(200);

    const a = await assessment();
    const m = await call('techEval', 'PUT', `/api/v1/risk/assessments/${a.id}/draft`, { manualScore: '15', manualNote: 'Sentetik' });
    expect([m.status, m.body.error?.code]).toEqual([422, 'questions_available']);
    const bad = await call('techEval', 'PUT', `/api/v1/risk/assessments/${a.id}/draft`, { questionSetId: draftSet.body.id });
    expect([bad.status, bad.body.error?.code]).toEqual([422, 'question_set_not_published']);

    const partial = await call('techEval', 'PUT', `/api/v1/risk/assessments/${a.id}/draft`, { criteria: ROW5, questionSetId: setId, answers: { Q1: 'YES', Q2: 'YES' } });
    expect(partial.status, JSON.stringify(partial.body)).toBe(200);
    expect(partial.body.manualResultAllowed).toBe(false);
    expect(partial.body.publishedQuestionSets.map((x: any) => x.id)).toContain(setId);
    expect(partial.body.publishedQuestionSets.map((x: any) => x.id)).not.toContain(draftSet.body.id);
    expect(partial.body.computed.score).toMatchObject({ value: null, source: 'QUESTIONS', missing: ['Q3'] });
    expect(partial.body.computed.blockers.map((b: any) => b.code)).toEqual(['score_missing']);
    expect((await call('techEval', 'POST', `/api/v1/risk/assessments/${a.id}/complete`)).body.error?.code).toBe('completion_blocked');
    // Sette olmayan soru reddedilir.
    expect((await call('techEval', 'PUT', `/api/v1/risk/assessments/${a.id}/draft`, { answers: { Q9: 'YES' } })).body.error?.code).toBe('invalid_question');

    const full = await call('techEval', 'PUT', `/api/v1/risk/assessments/${a.id}/draft`, { answers: { Q3: 'NO' } });
    expect(full.body.computed.criticality.display).toBe('3,22');
    expect(full.body.computed.score).toMatchObject({ value: '50.00', source: 'QUESTIONS', missing: [] });
    expect(full.body.computed.level).toMatchObject({ level: 3, band: 3 });
    expect(full.body.questionSet.questions.map((q: any) => q.code)).toEqual(['Q1', 'Q2', 'Q3']);
    const c = await call('techEval', 'POST', `/api/v1/risk/assessments/${a.id}/complete`);
    expect(c.status, JSON.stringify(c.body)).toBe(200);
    expect(c.body.revisions[0]).toMatchObject({ scoreSource: 'QUESTIONS', questionSetId: setId, answers: ANSWERS_50, riskScore: '50.00', level: 3 });
  });
});

describe('R8: önceki yıl', () => {
  it('önceki yılın son revizyonu "prior" olarak döner; değişen ölçüt "changed" ve revizyonda changed_fields', async () => {
    const supplier = h.world.suppliers.s2;
    const p = await assessment({ supplier, year: 2090 });
    await call('techEval', 'PUT', `/api/v1/risk/assessments/${p.id}/draft`, { criteria: ROW5, questionSetId: setId, answers: ANSWERS_50 });
    expect((await call('techEval', 'POST', `/api/v1/risk/assessments/${p.id}/complete`)).status).toBe(200);
    const n = await assessment({ supplier, year: p.year + 1 });
    await h.owner.query(`UPDATE risk_assessments SET prior_assessment_id = $2, draft = $3 WHERE id = $1`,
      [n.id, p.id, { criteria: ROW5, questionSetId: setId, answers: ANSWERS_50 }]);
    const same = await call('techEval', 'GET', `/api/v1/risk/assessments/${n.id}`);
    expect(same.body.prior).toMatchObject({ year: p.year, assessmentId: p.id, revision: { revisionNo: 1, level: 3, criticalityDisplay: '3,22' } });
    expect(same.body.changed).toEqual([]);
    const d = await call('techEval', 'PUT', `/api/v1/risk/assessments/${n.id}/draft`, { criteria: { businessImpact: 5 } });
    expect(d.body.changed).toEqual(['criteria.businessImpact']);
    const c = await call('techEval', 'POST', `/api/v1/risk/assessments/${n.id}/complete`);
    expect(c.status, JSON.stringify(c.body)).toBe(200);
    expect(c.body.revisions[0].changedFields).toEqual(['criteria.businessImpact']);
  });
});

describe('R9: seviye 4–5 aksiyon ve kontrol planı; revizyon değişmez; R10 gözden geçirme; portal', () => {
  let a: { id: string; year: number };
  it('Excel satır 54 → sütun 5, seviye 4; plansız completion_blocked; sahip/tarih girilince tamamlanır; Satınalma bilgi görevi', async () => {
    a = await assessment({ supplier: h.world.suppliers.s1 });
    const d = await call('techEval', 'PUT', `/api/v1/risk/assessments/${a.id}/draft`, { criteria: ROW54, questionSetId: setId, answers: ANSWERS_50 });
    expect(d.body.computed.criticality).toMatchObject({ display: '4,59', column: 5 });
    expect(d.body.computed.level).toMatchObject({ level: 4, band: 3 });
    const b1 = await call('techEval', 'POST', `/api/v1/risk/assessments/${a.id}/complete`);
    expect(b1.status).toBe(422);
    expect(b1.body.error.code).toBe('completion_blocked');
    expect(b1.body.error.details.blockers.map((b: any) => b.code)).toEqual(['action_plan_required', 'control_required']);

    const ctl = await call('techEval', 'POST', `/api/v1/risk/assessments/${a.id}/actions`, { kind: 'CONTROL', title: 'Sentetik kontrol' });
    expect([ctl.status, ctl.body.error?.code]).toEqual([422, 'control_method_required']);
    const badOwner = await call('techEval', 'POST', `/api/v1/risk/assessments/${a.id}/actions`, { kind: 'MITIGATION', title: 'Sentetik', ownerUserId: h.world.users.supplier1.id });
    expect([badOwner.status, badOwner.body.error?.code]).toEqual([422, 'invalid_owner']);
    const mit = await call('techEval', 'POST', `/api/v1/risk/assessments/${a.id}/actions`, { kind: 'MITIGATION', title: 'Sentetik azaltım aksiyonu', supplierVisible: true,
      description: 'İç açıklama (sentetik)' });
    expect(mit.status, JSON.stringify(mit.body)).toBe(201);
    const con = await call('techEval', 'POST', `/api/v1/risk/assessments/${a.id}/actions`, { kind: 'CONTROL', title: 'Sentetik masabaşı kontrol', controlMethod: 'DESK',
      ownerUserId: h.world.users.security.id, dueOn: '2099-06-30' });
    expect(con.status).toBe(201);
    expect(con.body).toMatchObject({ controlMethodLabel: 'Kanıt kontrolü – masabaşı', owner: { id: h.world.users.security.id } });
    const b2 = await call('techEval', 'POST', `/api/v1/risk/assessments/${a.id}/complete`);
    expect(b2.body.error.details.blockers.map((b: any) => b.code)).toEqual(['action_owner_required', 'action_due_required']);
    const past = await call('techEval', 'PATCH', `/api/v1/risk/actions/${mit.body.id}`, { ownerUserId: extra.tc!.id, dueOn: '2020-01-01' });
    expect(past.status, JSON.stringify(past.body)).toBe(200);
    expect((await call('techEval', 'POST', `/api/v1/risk/assessments/${a.id}/complete`)).body.error.details.blockers.map((b: any) => b.code)).toEqual(['action_due_past']);
    { const r = await call('techEval', 'PATCH', `/api/v1/risk/actions/${mit.body.id}`, { dueOn: '2099-05-31' }); expect(r.status, JSON.stringify(r.body)).toBe(200); }

    const c = await call('techEval', 'POST', `/api/v1/risk/assessments/${a.id}/complete`);
    expect(c.status, JSON.stringify(c.body)).toBe(200);
    expect(c.body.revisions[0]).toMatchObject({ revisionNo: 1, level: 4, column: 5, criticalityDisplay: '4,59' });
    expect((await one(`SELECT kind, assignee_role, severity, status FROM tasks WHERE tenant_id = $1 AND dedupe_key = $2`, [h.world.tenantA, `risk:${a.id}:high:1`])))
      .toMatchObject({ kind: 'risk_high_level', assignee_role: 'PROCUREMENT', severity: 'HIGH', status: 'OPEN' });
    // Revizyon veritabanında da değişmez.
    await expect(h.owner.query(`UPDATE risk_assessment_revisions SET risk_score = 10 WHERE assessment_id = $1`, [a.id])).rejects.toThrow();
    // Son kontrol satırı iptal edilemez (seviye 4 tamamlanmış).
    const cancel = await call('techEval', 'PATCH', `/api/v1/risk/actions/${con.body.id}`, { status: 'CANCELLED' });
    expect([cancel.status, cancel.body.error?.code]).toEqual([422, 'action_plan_required']);
    // Tamamlanmış seviye 4 kayıtta açık plan satırı sahipsiz ya da geçmiş tarihli bırakılamaz.
    for (const patch of [{ ownerUserId: null }, { dueOn: null }, { dueOn: '2020-01-01' }]) {
      const r = await call('techEval', 'PATCH', `/api/v1/risk/actions/${con.body.id}`, patch);
      expect([r.status, r.body.error?.code], JSON.stringify(patch)).toEqual([422, 'action_plan_required']);
    }
    expect((await call('techEval', 'PATCH', `/api/v1/risk/actions/${con.body.id}`, { dueOn: '2099-07-31' })).status).toBe(200);
    // Yalnız Denetçi (ya da Yönetici) olan kullanıcı sahip olamaz.
    for (const who of ['auditor', 'tenantAdmin'] as const) {
      const r = await call('techEval', 'PATCH', `/api/v1/risk/actions/${con.body.id}`, { ownerUserId: h.world.users[who].id });
      expect([r.status, r.body.error?.code], who).toEqual([422, 'invalid_owner']);
    }
  });

  it('aksiyon sahibi başka departmanda: yalnız durum + not; değerlendirmeyi görmez', async () => {
    const det = (await call('techEval', 'GET', `/api/v1/risk/assessments/${a.id}`)).body;
    const mit = det.actions.find((x: any) => x.kind === 'MITIGATION');
    expect(mit.owner.id).toBe(extra.tc!.id);
    expect((await call('tc', 'GET', `/api/v1/risk/assessments/${a.id}`)).status).toBe(404);
    // I2: sahibe kişisel görev (departmansız risk_action; yalnız atanan kişi görür; tarih güncellemesi göreve yansır).
    const key = `risk:${a.id}:action:${mit.id}`;
    // Tarih 2020 → 2099 değişince ilk görev iptal edildi, yenisi açıldı (görev başlık/tarih sütunları sp_app'e güncellenemez).
    expect((await h.owner.query(`SELECT 1 FROM tasks WHERE tenant_id = $1 AND dedupe_key = $2 AND status = 'CANCELLED'`, [h.world.tenantA, key])).rowCount).toBe(1);
    expect(await one(`SELECT kind, entity_type, entity_id, department_id, assignee_user_id, assignee_role, status, due_at FROM tasks WHERE tenant_id = $1 AND dedupe_key = $2 AND status = 'OPEN'`,
      [h.world.tenantA, key])).toEqual({ kind: 'risk_action_owner', entity_type: 'risk_action', entity_id: mit.id, department_id: null, assignee_user_id: extra.tc!.id,
      assignee_role: 'DEPARTMENT_USER', status: 'OPEN', due_at: new Date('2099-05-31T23:59:59+03:00') });
    expect((await tasksOf('tc')).filter((t) => t.entityId === mit.id).map((t) => [t.kind, t.entityType])).toEqual([['risk_action_owner', 'risk_action']]);
    expect((await tasksOf('techEval')).some((t) => t.entityId === mit.id)).toBe(false);
    expect((await tasksOf('ik')).some((t) => t.entityId === mit.id)).toBe(false);
    const mine = await call('tc', 'GET', '/api/v1/risk/actions/mine');
    expect(mine.status, JSON.stringify(mine.body)).toBe(200);
    const sup1 = await one<{ legal_name: string }>(`SELECT legal_name FROM suppliers WHERE id = $1`, [h.world.suppliers.s1]);
    expect(mine.body.items.find((x: any) => x.id === mit.id)).toEqual({ id: mit.id, assessmentId: a.id, assessmentVisible: false,
      supplier: { id: h.world.suppliers.s1, name: sup1.legal_name }, year: a.year, kind: 'MITIGATION', controlMethod: null, controlMethodLabel: null,
      title: 'Sentetik azaltım aksiyonu', description: 'İç açıklama (sentetik)', dueOn: '2099-05-31', overdue: false, status: 'OPEN', completionNote: null,
      completedAt: null, can: { close: true } });
    for (const k of ['criteria', 'answers', 'opinions', 'riskScore']) expect(mine.raw).not.toContain(k);
    // Başkasının aksiyonu listede yok; tedarikçi oturumu 403.
    expect((await call('techEval', 'GET', '/api/v1/risk/actions/mine')).body.items.some((x: any) => x.id === mit.id)).toBe(false);
    expect((await call('supplier1', 'GET', '/api/v1/risk/actions/mine')).status).toBe(403);
    const f = await call('tc', 'PATCH', `/api/v1/risk/actions/${mit.id}`, { title: 'Sahip başlığı değiştiremez' });
    expect([f.status, f.body.error?.code]).toEqual([403, 'owner_fields_only']);
    const f2 = await call('tc', 'PATCH', `/api/v1/risk/actions/${mit.id}`, { status: 'DONE', supplierVisible: false, completionNote: 'Sentetik' });
    expect([f2.status, f2.body.error?.code]).toEqual([403, 'owner_fields_only']);
    expect((await call('tc', 'PATCH', `/api/v1/risk/actions/${mit.id}`, { status: 'CANCELLED' })).status).toBe(403);
    const nn = await call('tc', 'PATCH', `/api/v1/risk/actions/${mit.id}`, { status: 'DONE' });
    expect([nn.status, nn.body.error?.code]).toEqual([422, 'completion_note_required']);
    const ok = await call('tc', 'PATCH', `/api/v1/risk/actions/${mit.id}`, { status: 'DONE', completionNote: 'Sentetik tamamlama notu' });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(ok.body).toMatchObject({ status: 'DONE', completionNote: 'Sentetik tamamlama notu', completedBy: extra.tc!.id });
    expect(await audits('risk.action.done', mit.id)).toBe(1);
    expect(await taskStatus(key)).toBe('DONE');
    expect((await call('tc', 'GET', '/api/v1/risk/actions/mine')).body.items.find((x: any) => x.id === mit.id))
      .toMatchObject({ status: 'DONE', completionNote: 'Sentetik tamamlama notu', can: { close: false } });
    // Tamamlanmış aksiyon yalnız doğrulanır (sahip doğrulayamaz; sorumlu departman doğrular).
    expect((await call('tc', 'PATCH', `/api/v1/risk/actions/${mit.id}`, { status: 'VERIFIED' })).status).toBe(403);
    expect((await call('techEval', 'PATCH', `/api/v1/risk/actions/${mit.id}`, { title: 'Değişmez' })).status).toBe(409);
    expect((await call('techEval', 'PATCH', `/api/v1/risk/actions/${mit.id}`, { status: 'VERIFIED' })).body.status).toBe('VERIFIED');
    // Sahip olmayan, değerlendirmeyi görmeyen departman: 404.
    const other = det.actions.find((x: any) => x.kind === 'CONTROL');
    expect((await call('tc', 'PATCH', `/api/v1/risk/actions/${other.id}`, { status: 'DONE', completionNote: 'x' })).status).toBe(404);
  });

  it('portal: yalnız son tamamlanmış yılın seviyesi, skoru ve tedarikçiye görünür aksiyonlar; iç uçlar 403', async () => {
    const p = await call('supplier1', 'GET', '/api/v1/portal/risk');
    expect(p.status, JSON.stringify(p.body)).toBe(200);
    expect(Object.keys(p.body).sort()).toEqual(['actions', 'level', 'levelLabel', 'riskScore', 'year']);
    expect(p.body).toMatchObject({ year: a.year, level: 4, riskScore: '50.00' });
    expect(p.body.actions).toEqual([{ title: 'Sentetik azaltım aksiyonu', dueOn: '2099-05-31', status: 'VERIFIED' }]);
    for (const k of ['criteria', 'answers', 'opinions', 'owner', 'description', 'criticality', 'Sentetik masabaşı kontrol']) expect(p.raw).not.toContain(k);
    expect((await call('supplier1', 'GET', `/api/v1/risk/assessments/${a.id}`)).status).toBe(403);
    expect((await call('supplier1', 'GET', '/api/v1/risk/matrix')).status).toBe(403);
    expect((await call('techEval', 'GET', '/api/v1/portal/risk')).status).toBe(403);
    // Tamamlanmış değerlendirmesi olmayan tedarikçi: boş.
    expect((await call('supplier3', 'GET', '/api/v1/portal/risk')).body).toEqual({ year: null, level: null, levelLabel: null, riskScore: null, actions: [] });
  });

  it('R10: "Değişiklik yok" aynı dönemde ikinci kez 409; "Güncelle" yeniden açar, tamamlanınca yeni revizyon, eski revizyon aynı', async () => {
    const url = `/api/v1/risk/assessments/${a.id}/reviews`;
    // M6 (bütün faz incelemesi): ilk revizyonun çeyreğinden önceki dönem gözden geçirilemez. Test yılı geçmişte, revizyon bugün yazıldı;
    // ilk revizyon değerlendirme yılının 2. çeyreğine çekilir (önceden bu test her dönemi kabul ediyordu).
    await backdateFirstRevision(a.id, `${a.year}-04-15`);
    expect((await call('techEval', 'GET', `/api/v1/risk/assessments/${a.id}`)).body.assessment.firstReviewablePeriod).toBe(`${a.year}-2`);
    const early = await call('techEval', 'POST', url, { period: `${a.year}-1`, outcome: 'NO_CHANGE' });
    expect([early.status, early.body.error?.code, early.body.error?.details]).toEqual([422, 'period_before_assessment', { firstReviewablePeriod: `${a.year}-2` }]);
    expect(early.body.error.message).toContain(`${a.year}-Ç2`);
    await task(a.id, `risk:${a.id}:review:${a.year}-2`, 'risk_quarterly_review');
    expect((await call('techEval', 'POST', url, { period: `${a.year + 1}-2`, outcome: 'NO_CHANGE' })).body.error?.code).toBe('invalid_period');
    expect((await call('auditor', 'POST', url, { period: `${a.year}-2`, outcome: 'NO_CHANGE' })).status).toBe(403);
    const n1 = await call('techEval', 'POST', url, { period: `${a.year}-2`, outcome: 'NO_CHANGE' });
    expect(n1.status, JSON.stringify(n1.body)).toBe(201);
    expect(n1.body.reviews[0]).toMatchObject({ period: `${a.year}-2`, outcome: 'NO_CHANGE', revisionId: n1.body.revisions[0].id });
    expect(await taskStatus(`risk:${a.id}:review:${a.year}-2`)).toBe('DONE');
    const n2 = await call('techEval', 'POST', url, { period: `${a.year}-2`, outcome: 'NO_CHANGE' });
    expect([n2.status, n2.body.error?.code]).toEqual([409, 'review_exists']);
    expect((await call('techEval', 'POST', url, { period: `${a.year}-2`, outcome: 'UPDATE' })).status).toBe(409);

    const rev1 = await one(`SELECT * FROM risk_assessment_revisions WHERE assessment_id = $1 AND revision_no = 1`, [a.id]);
    // Gelecek dönem reddedilir.
    expect((await call('techEval', 'POST', url, { period: '2099-1', outcome: 'NO_CHANGE' })).body.error?.code).toBe('invalid_period');
    // Eski son tarih geçmişte; yeniden açılış bugün + ayar (varsayılan 90 gün) yeni son tarih verir, gecikmiş sayılmaz.
    await h.owner.query(`UPDATE risk_assessments SET due_on = '2012-03-31' WHERE id = $1`, [a.id]);
    const u = await call('techEval', 'POST', url, { period: `${a.year}-3`, outcome: 'UPDATE' });
    expect(u.status, JSON.stringify(u.body)).toBe(201);
    expect(u.body.assessment).toMatchObject({ status: 'OPEN', pendingReviewPeriod: `${a.year}-3`, overdue: false });
    const expectDue = (await one(`SELECT ((now() AT TIME ZONE 'Europe/Istanbul')::date + 90)::text AS d`)).d;
    expect(u.body.assessment.dueOn).toBe(expectDue);
    expect(u.body.draft).toMatchObject({ criteria: ROW54, questionSetId: setId, answers: ANSWERS_50 });
    // Açıkken "Değişiklik yok" yapılamaz.
    expect((await call('techEval', 'POST', url, { period: `${a.year}-4`, outcome: 'NO_CHANGE' })).body.error?.code).toBe('not_completed');
    // Riskli cevap kalkar: Q1 = NO → 0,00 → bant 1, sütun 5 → seviye 3.
    const d = await call('techEval', 'PUT', `/api/v1/risk/assessments/${a.id}/draft`, { answers: { Q1: 'NO' } });
    expect(d.body.computed.level.level).toBe(3);
    const c = await call('techEval', 'POST', `/api/v1/risk/assessments/${a.id}/complete`);
    expect(c.status, JSON.stringify(c.body)).toBe(200);
    expect(c.body.revisions.map((r: any) => [r.revisionNo, r.level, r.riskScore])).toEqual([[2, 3, '0.00'], [1, 4, '50.00']]);
    expect(c.body.revisions[0].changedFields).toEqual(['answers.Q1', 'riskScore']);
    expect(c.body.reviews.map((r: any) => [r.period, r.outcome])).toEqual([[`${a.year}-3`, 'UPDATED'], [`${a.year}-2`, 'NO_CHANGE']]);
    expect(c.body.assessment.pendingReviewPeriod).toBeNull();
    expect(await one(`SELECT * FROM risk_assessment_revisions WHERE assessment_id = $1 AND revision_no = 1`, [a.id])).toEqual(rev1);
    expect(await audits('risk.review.no_change', a.id)).toBe(1);
    expect(await audits('risk.review.updated', a.id)).toBe(1);
  });

  it('matris, liste süzgeci, tedarikçi geçmişi ve currentRisk', async () => {
    const b = await assessment({ supplier: h.world.suppliers.s2, year: a.year });
    await call('techEval', 'PUT', `/api/v1/risk/assessments/${b.id}/draft`, { criteria: ROW54, questionSetId: setId, answers: ANSWERS_50 });
    // b açık ve revizyonsuz → skorsuz; a son revizyonu bant 1 sütun 5.
    const m = await call('auditor', 'GET', `/api/v1/risk/matrix?year=${a.year}`);
    expect(m.status).toBe(200);
    expect(m.body.cells).toHaveLength(25);
    const cell = m.body.cells.find((x: any) => x.band === 1 && x.column === 5);
    expect(cell).toMatchObject({ level: 3, count: 1, supplierIds: [h.world.suppliers.s1], assessmentIds: [a.id] });
    expect(m.body.cells.find((x: any) => x.band === 3 && x.column === 5)).toMatchObject({ level: 4, count: 0 });
    expect(m.body.unscored).toBe(1);
    expect(m.body.byStatus).toMatchObject({ OPEN: 1, COMPLETED: 1 });
    const l = await call('buyer', 'GET', `/api/v1/risk/assessments?year=${a.year}&level=3`);
    expect(l.body.items.map((x: any) => x.id)).toEqual([a.id]);
    expect(l.body.items[0]).toMatchObject({ criticalityDisplay: '4,59', column: 5, riskScore: '0.00', level: 3, revisionNo: 2, lastReview: { period: `${a.year}-3`, outcome: 'UPDATED' } });
    expect((await call('buyer', 'GET', `/api/v1/risk/assessments?year=${a.year}&status=OPEN`)).body.items.map((x: any) => x.id)).toEqual([b.id]);
    const hist = await call('techEval', 'GET', `/api/v1/suppliers/${h.world.suppliers.s1}/risk-history`);
    expect(hist.status).toBe(200);
    const y = hist.body.items.find((x: any) => x.id === a.id);
    expect(y).toMatchObject({ year: a.year, status: 'COMPLETED', level: 3, riskScore: '0.00', criticalityDisplay: '4,59', revisionCount: 2 });
    expect(y.openActions.map((x: any) => x.kind)).toEqual(['CONTROL']);
    const cur = await withTenant(h.pool, { tenantId: h.world.tenantA, userId: h.world.users.buyer.id, roles: ['PROCUREMENT'], companyIds: [], departmentIds: [],
      allDepartments: true, correlationId: 'risk-current' }, (tx) => currentRisk(tx, h.world.suppliers.s1, '2026-12-31'));
    expect(cur).toMatchObject({ assessmentId: a.id, year: a.year, revisionNo: 2, level: 3, riskScore: '0.00', column: 5 });
    const none = await withTenant(h.pool, { tenantId: h.world.tenantA, userId: h.world.users.buyer.id, roles: ['PROCUREMENT'], companyIds: [], departmentIds: [],
      allDepartments: true, correlationId: 'risk-current' }, (tx) => currentRisk(tx, h.world.suppliers.s3, '2026-12-31'));
    expect(none).toBeNull();
  });
});

describe('R5: departman yalıtımı, katkıcı görüşü, sorumlu departman seçimi', () => {
  it('katkıcı (yürürlükte sözleşmesi olan İK) okur ve görüş ekler, taslak/tamamlama 403; başka departman (TC) 404', async () => {
    const a = await assessment({ supplier: h.world.suppliers.s2, department: h.world.departments.bt });
    await contract(h.world.departments.ik, h.world.suppliers.s2);
    const g = await call('ik', 'GET', `/api/v1/risk/assessments/${a.id}`);
    expect(g.status, JSON.stringify(g.body)).toBe(200);
    expect(g.body.assessment.access).toBe('CONTRIBUTOR');
    expect(g.body.can).toMatchObject({ edit: false, complete: false, opine: true, review: false });
    const pd = await call('ik', 'PUT', `/api/v1/risk/assessments/${a.id}/draft`, { criteria: ROW5 });
    expect([pd.status, pd.body.error?.code]).toEqual([403, 'not_responsible']);
    expect((await call('ik', 'POST', `/api/v1/risk/assessments/${a.id}/complete`)).status).toBe(403);
    expect((await call('ik', 'POST', `/api/v1/risk/assessments/${a.id}/actions`, { kind: 'MITIGATION', title: 'Sentetik' })).status).toBe(403);
    const op = await call('ik', 'POST', `/api/v1/risk/assessments/${a.id}/opinions`, { body: 'Sentetik katkıcı görüşü' });
    expect(op.status, JSON.stringify(op.body)).toBe(201);
    expect(op.body.department.id).toBe(h.world.departments.ik);
    expect(await audits('risk.opinion.added', a.id)).toBe(1);
    const own = await call('techEval', 'POST', `/api/v1/risk/assessments/${a.id}/opinions`, { body: 'Sentetik sorumlu görüşü' });
    expect(own.body.department.id).toBe(h.world.departments.bt);
    expect((await call('techEval', 'GET', `/api/v1/risk/assessments/${a.id}`)).body.opinions.map((o: any) => o.body)).toEqual(['Sentetik katkıcı görüşü', 'Sentetik sorumlu görüşü']);
    expect((await call('ik', 'GET', `/api/v1/risk/assessments?year=${a.year}`)).body.items.map((x: any) => [x.id, x.contributor])).toEqual([[a.id, true]]);

    expect((await call('tc', 'GET', `/api/v1/risk/assessments/${a.id}`)).status).toBe(404);
    expect((await call('tc', 'POST', `/api/v1/risk/assessments/${a.id}/opinions`, { body: 'Sentetik görüş' })).status).toBe(404);
    expect((await call('tc', 'PUT', `/api/v1/risk/assessments/${a.id}/draft`, { criteria: ROW5 })).status).toBe(404);
    expect((await call('tc', 'GET', `/api/v1/risk/assessments?year=${a.year}`)).body.items).toEqual([]);
    expect((await call('tc', 'GET', `/api/v1/risk/matrix?year=${a.year}`)).body.byStatus).toMatchObject({ OPEN: 0, COMPLETED: 0 });
    // Denetçi görüş ekleyemez.
    expect((await call('auditor', 'POST', `/api/v1/risk/assessments/${a.id}/opinions`, { body: 'Sentetik' })).status).toBe(403);
    // İptal edilmiş değerlendirmeye görüş eklenmez.
    await h.owner.query(`UPDATE risk_assessments SET status = 'CANCELLED' WHERE id = $1`, [a.id]);
    const cx = await call('ik', 'POST', `/api/v1/risk/assessments/${a.id}/opinions`, { body: 'Sentetik görüş' });
    expect([cx.status, cx.body.error?.code]).toEqual([409, 'cancelled']);
  });

  it('departmansız kayıt yalnız tümünü görenlere; Satınalma departman seçer, görev departmanı türetilir', async () => {
    const a = await assessment({ supplier: h.world.suppliers.s3, department: null });
    await task(a.id, `risk:${a.id}:department`, 'risk_assessment_department');
    expect((await call('techEval', 'GET', `/api/v1/risk/assessments/${a.id}`)).status).toBe(404);
    expect((await call('techEval', 'PUT', `/api/v1/risk/assessments/${a.id}/department`, { departmentId: h.world.departments.bt })).status).toBe(403);
    expect((await call('buyer', 'PUT', `/api/v1/risk/assessments/${a.id}/department`, { departmentId: randomUUID() })).body.error?.code).toBe('invalid_department');
    // M5: birleştirilmiş departman seçilemez.
    const merged = (await one<{ id: string }>(`INSERT INTO departments (tenant_id, name, merged_into) VALUES ($1, $2, $3) RETURNING id`,
      [h.world.tenantA, `Birleşmiş departman ${rand()} (SENTETİK)`, h.world.departments.bt])).id;
    const mg = await call('buyer', 'PUT', `/api/v1/risk/assessments/${a.id}/department`, { departmentId: merged });
    expect([mg.status, mg.body.error?.code, mg.body.error?.details]).toEqual([422, 'department_merged', { mergedInto: h.world.departments.bt }]);
    expect(await one(`SELECT department_id FROM risk_assessments WHERE id = $1`, [a.id])).toEqual({ department_id: null });
    const s = await call('masterData', 'PUT', `/api/v1/risk/assessments/${a.id}/department`, { departmentId: h.world.departments.bt });
    expect(s.status, JSON.stringify(s.body)).toBe(200);
    expect(s.body.assessment.department.id).toBe(h.world.departments.bt);
    expect(await taskStatus(`risk:${a.id}:department`)).toBe('DONE');
    expect(await one(`SELECT kind, department_id, status, assignee_role FROM tasks WHERE tenant_id = $1 AND dedupe_key = $2`, [h.world.tenantA, `risk:${a.id}:due`]))
      .toEqual({ kind: 'risk_assessment_due', department_id: h.world.departments.bt, status: 'OPEN', assignee_role: 'DEPARTMENT_USER' });
    const g = await call('techEval', 'GET', `/api/v1/risk/assessments/${a.id}`);
    expect(g.status).toBe(200);
    expect(g.body.can.edit).toBe(true);
    expect(await audits('risk.department_set', a.id)).toBe(1);
  });
});

describe('bütün faz incelemesi: aksiyon sahibi görevi (I2) ve tedarikçi oturumunda sözleşme yürürlüğü (M4)', () => {
  it('sahip değişince eski görev kapanır, yenisine açılır; başlık/tarih güncellenir; iptal kapatır; sahipsiz satıra görev yok', async () => {
    const a = await assessment({ supplier: h.world.suppliers.s3 });
    const x = await call('techEval', 'POST', `/api/v1/risk/assessments/${a.id}/actions`, { kind: 'CONTROL', title: 'Sentetik yerinde kontrol', controlMethod: 'ON_SITE',
      ownerUserId: extra.tc!.id, dueOn: '2099-01-31' });
    expect(x.status, JSON.stringify(x.body)).toBe(201);
    const key = `risk:${a.id}:action:${x.body.id}`;
    const open = async () => (await h.owner.query(`SELECT assignee_user_id, title, due_at FROM tasks WHERE tenant_id = $1 AND dedupe_key = $2 AND status = 'OPEN'`,
      [h.world.tenantA, key])).rows;
    expect((await open()).map((t) => t.assignee_user_id)).toEqual([extra.tc!.id]);
    expect((await open())[0].title).toMatch(/^Risk kontrolü: Sentetik yerinde kontrol \(.+, \d{4}\)$/);
    const none = await call('techEval', 'POST', `/api/v1/risk/assessments/${a.id}/actions`, { kind: 'MITIGATION', title: 'Sahipsiz sentetik aksiyon' });
    expect(await taskStatus(`risk:${a.id}:action:${none.body.id}`)).toBeUndefined();

    expect((await call('techEval', 'PATCH', `/api/v1/risk/actions/${x.body.id}`, { title: 'Sentetik yerinde kontrol 2', dueOn: '2099-02-28' })).status).toBe(200);
    expect(await open()).toMatchObject([{ assignee_user_id: extra.tc!.id, due_at: new Date('2099-02-28T23:59:59+03:00') }]);
    expect((await open())[0].title).toContain('Sentetik yerinde kontrol 2');

    expect((await call('techEval', 'PATCH', `/api/v1/risk/actions/${x.body.id}`, { ownerUserId: extra.ik!.id })).status).toBe(200);
    expect((await open()).map((t) => t.assignee_user_id)).toEqual([extra.ik!.id]);
    expect((await h.owner.query(`SELECT 1 FROM tasks WHERE tenant_id = $1 AND dedupe_key = $2 AND status = 'CANCELLED' AND assignee_user_id = $3`,
      [h.world.tenantA, key, extra.tc!.id])).rowCount).toBe(2); // başlık/tarih değişikliği + sahip değişikliği
    expect((await tasksOf('ik')).some((t) => t.entityId === x.body.id)).toBe(true);
    expect((await tasksOf('tc')).some((t) => t.entityId === x.body.id)).toBe(false);
    expect((await call('tc', 'GET', '/api/v1/risk/actions/mine')).body.items.some((i: any) => i.id === x.body.id)).toBe(false);

    expect((await call('techEval', 'PATCH', `/api/v1/risk/actions/${x.body.id}`, { ownerUserId: null })).status).toBe(200);
    expect(await open()).toEqual([]);
    expect((await call('techEval', 'PATCH', `/api/v1/risk/actions/${x.body.id}`, { ownerUserId: extra.tc!.id })).status).toBe(200);
    expect((await open()).map((t) => t.assignee_user_id)).toEqual([extra.tc!.id]);
    expect((await call('techEval', 'PATCH', `/api/v1/risk/actions/${x.body.id}`, { status: 'CANCELLED' })).status).toBe(200);
    expect(await open()).toEqual([]);
  });

  it('M4: app_contract_in_force tedarikçi oturumunda false; iç oturumda true', async () => {
    const familyId = await contract(h.world.departments.ik, h.world.suppliers.s1);
    const base = { tenantId: h.world.tenantA, companyIds: [h.world.companyA1.id], departmentIds: [], correlationId: 'risk-m4' };
    const inForce = (ctx: Parameters<typeof withTenant>[1]) =>
      withTenant(h.pool, ctx, async (tx) => (await tx.query<{ v: boolean }>(`SELECT app_contract_in_force($1) AS v`, [familyId])).rows[0]!.v);
    expect(await inForce({ ...base, userId: h.world.users.buyer.id, roles: ['PROCUREMENT'], allDepartments: true })).toBe(true);
    expect(await inForce({ ...base, userId: h.world.users.supplier1.id, roles: ['SUPPLIER'], supplierId: h.world.suppliers.s1, allDepartments: false })).toBe(false);
  });
});
