// v2 Faz 4 Görev 5: sözleşme incelemesi (AI14) — şablonla/şablonsuz, puan kodda (reviewScore), doğrulanmamış bulgu puana girmez, model puanı yok
// sayılır, yeni belge sürümü eskisini "güncel değil" yapar, eşik ayarı ve gönderimde denetim olayı (engel yok), görünürlük, Yapay zekâ defteri.
// Gerçek PostgreSQL + nesne deposu. Sağlayıcı yalnız bu dosyada kayıtlı `test-fixture`: çıktısı GERÇEK İNCELEME DEĞİLDİR. Veriler sentetik.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { AI_DISCLAIMER, REVIEW_RUBRIC_VERSION, reviewScore, syntheticVkn, type CheckedFinding } from '@sp/domain';
import { createSyntheticWorld, ensureTestAiCatalog, ensureTestAiPolicy, syntheticContractPdf, syntheticDocx, type SyntheticWorld } from '../src/devdata.ts';
import { DevAuthProvider } from '../src/auth.ts';
import { DEFAULT_AI_MODEL_ID } from '../src/config.ts';
import { registerAiProvider, type AiProvider } from '../src/ai/provider.ts';
import { testFixtureProvider } from '../src/ai/testProvider.ts';
import { PROMPT_VERSIONS } from '../src/ai/prompts.ts';
import { DOCX_MIME } from '../src/modules/templates.ts';
import { processJobs } from '../src/worker.ts';
import { makeHarness } from './harness.ts';

const fixture = testFixtureProvider();
registerAiProvider(fixture);

let h: Awaited<ReturnType<typeof makeHarness>>;
let auth: DevAuthProvider;
beforeAll(async () => {
  h = await makeHarness();
  auth = new DevAuthProvider(h.config.devAuthSecret!);
  await ensureTestAiCatalog(h.owner, DEFAULT_AI_MODEL_ID);
});
afterAll(async () => { registerAiProvider(fixture); await h.close(); });

type UserKey = keyof SyntheticWorld['users'];
const fresh = () => createSyntheticWorld(h.owner, `-${randomUUID().slice(0, 8)}`);
const parse = (b: string) => { try { return b ? JSON.parse(b) : null; } catch { return b; } };
const emailOf = (w: SyntheticWorld, who: UserKey | { email: string }) => (typeof who === 'string' ? w.users[who].email : who.email);

async function call(w: SyntheticWorld, who: UserKey | { email: string }, method: string, url: string, body?: unknown, extra: Record<string, string> = {}, tenant?: string) {
  const token = await auth.issue(`dev|${emailOf(w, who)}`);
  const res = await h.app.inject({ method: method as any, url, headers: { authorization: `Bearer ${token}`, 'x-tenant-id': tenant ?? w.tenantA, ...extra },
    ...(body !== undefined ? { payload: body as any } : {}) });
  return { status: res.statusCode, body: parse(res.body) };
}
async function multipart(w: SyntheticWorld, who: UserKey, url: string, fields: Record<string, string>, file: { name: string; mime: string; data: Buffer }) {
  const token = await auth.issue(`dev|${w.users[who].email}`);
  const boundary = '----sp' + randomUUID();
  const parts: Buffer[] = [];
  for (const [k, v] of Object.entries(fields)) parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`));
  parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${file.name}"\r\nContent-Type: ${file.mime}\r\n\r\n`), file.data,
    Buffer.from(`\r\n--${boundary}--\r\n`));
  const res = await h.app.inject({ method: 'POST', url, payload: Buffer.concat(parts),
    headers: { authorization: `Bearer ${token}`, 'x-tenant-id': w.tenantA, 'content-type': `multipart/form-data; boundary=${boundary}` } });
  return { status: res.statusCode, body: parse(res.body) };
}
async function uploadContract(w: SyntheticWorld, pdf: Buffer): Promise<string> {
  const r = await multipart(w, 'techEval', '/api/v1/documents', { companyId: w.companyA1.id, kind: 'CONTRACT', title: `Bakım sözleşmesi ${randomUUID().slice(0, 4)} (SENTETİK)` },
    { name: 'sozlesme.pdf', mime: 'application/pdf', data: pdf });
  expect([200, 201], JSON.stringify(r.body)).toContain(r.status);
  return r.body.documentVersionId;
}
const TEMPLATE_PARAS = ['Madde 1 - Konu', 'Yuklenici hizmeti verir.', 'Madde 3 - Fesih', 'Taraflar feshedebilir.', 'Madde 4 - Gizlilik ve KVKK', 'Taraflar kisisel veriyi korur.'];
async function template(w: SyntheticWorld, contractType = 'MAINTENANCE', paras = TEMPLATE_PARAS) {
  const r = await multipart(w, 'buyer', '/api/v1/contract-templates', { code: `SB-${randomUUID().slice(0, 6)}`, name: 'Bakım şablonu (SENTETİK)', contractType, validFrom: '2026-01-01' },
    { name: 'sablon.docx', mime: DOCX_MIME, data: await syntheticDocx(paras) });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return r.body as { id: string; code: string; versionId: string; versionNo: number };
}
const lines = [{ lot: 'Lot 1', description: 'Bakım hizmeti', unit: 'ay', quantity: '12' }];
const criteria = [{ code: 'PRICE', name: 'Fiyat', kind: 'PRICE', weight: '100' }];
async function project(w: SyntheticWorld) {
  const r = await call(w, 'buyer', 'POST', '/api/v1/projects', { companyId: w.companyA1.id, title: `Sözleşme projesi ${randomUUID().slice(0, 4)}`, category: 'BT hizmetleri',
    need: 'Sentetik ihtiyaç', currency: 'TRY', budget: '100000.00', budgetVerified: false, lines, criteria, departmentId: w.departments.bt });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return r.body.id as string;
}
async function approvers(w: SyntheticWorld) {
  const r = await call(w, 'tenantAdmin', 'PUT', '/api/v1/approver-assignments', {
    organization: { leadUserId: w.users.legal.id, leadDeputyUserId: w.users.legal2.id, directorUserId: w.users.masterData.id, directorDeputyUserId: w.users.finance.id },
    departments: [{ departmentId: w.departments.bt, headUserId: w.users.security.id, deputyUserId: w.users.buyer.id }],
  });
  expect(r.status, JSON.stringify(r.body)).toBe(200);
}
const VKN = syntheticVkn('940000123');
const RISK_LINES = ['Tedarikci fiyati tek tarafli olarak degistirebilir.', 'Yuklenici icin sinirsiz sorumluluk ongorulmustur.'];
const contractPdf = (extra: string[] = RISK_LINES) => syntheticContractPdf({ supplierVkn: VKN, contractNo: `SNT-${randomUUID().slice(0, 6)}`, extraLines: extra });
async function draft(w: SyntheticWorld, pdf: Buffer = contractPdf()) {
  const documentVersionId = await uploadContract(w, pdf);
  const r = await call(w, 'techEval', 'POST', '/api/v1/contract-drafts', { documentVersionId, projectId: await project(w) });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return { familyId: r.body.familyId as string, contractVersionId: r.body.contractVersionId as string, documentVersionId };
}
/** Sözleşme türü (şablon eşleşmesi için) ve gönderim için gereken alanlar; PDF'teki değerlerle aynı. */
const pdfFields = (w: SyntheticWorld) => ({
  supplierId: w.suppliers.s1, contractType: 'MAINTENANCE', ownerUserId: w.users.techEval.id, signedOn: '2026-12-15',
  currency: 'TRY', amount: '1250000.00', limitBasis: 'NET', startDate: '2027-01-01', endDate: '2027-12-31', autoRenewal: false,
});
async function runWorker() { for (let i = 0; i < 10; i++) { if (!(await processJobs(h.pool, h.store, null, 10, null))) break; } }
const reviewRuns = async (dv: string) => (await h.owner.query(`SELECT * FROM ai_runs WHERE task = 'AI14' AND document_version_id = $1 ORDER BY created_at`, [dv])).rows;
const reviews = (w: SyntheticWorld, who: UserKey | { email: string }, familyId: string) => call(w, who, 'GET', `/api/v1/contracts/${familyId}/reviews`);
const requestReview = (w: SyntheticWorld, who: UserKey | { email: string }, familyId: string) => call(w, who, 'POST', `/api/v1/contracts/${familyId}/reviews`);
async function departmentUser(w: SyntheticWorld, departmentId: string) {
  const email = `ik.kullanici-${randomUUID().slice(0, 8)}@example.test`;
  const id = (await h.owner.query<{ id: string }>(`INSERT INTO users (auth_subject, email, display_name) VALUES ($1,$2,'İK Kullanıcısı (SENTETİK)') RETURNING id`,
    [`dev|${email}`, email])).rows[0]!.id;
  await h.owner.query(`INSERT INTO memberships (tenant_id, user_id, roles, company_ids, department_ids) VALUES ($1,$2,ARRAY['DEPARTMENT_USER'],$3,$4)`,
    [w.tenantA, id, [w.companyA1.id], [departmentId]]);
  return { id, email };
}
/** Saklanan bulgulardan puanı yeniden hesaplar (reviewScore ile birebir olmalı). */
const recompute = (findings: any[], hasTemplate: boolean) => reviewScore(findings.map((f): CheckedFinding => ({
  category: f.category, kind: f.kind, severity: f.severity, title: f.title, quote: f.quote, page: f.page, templateRef: f.templateRef, recommendation: f.suggestion,
  verified: f.verified, flags: [] })), hasTemplate);

describe('inceleme hattı (R7–R9)', () => {
  it('şablonla: eksik şablon maddesi ve risk bulguları; puan reviewScore ile birebir; defter, test etiketi, model kimliği; değişmez kayıt', async () => {
    const w = await fresh();
    const t = await template(w);
    const d = await draft(w); // politika yok: AI06 NOT_ALLOWED (gönderimi bekleyen öneri engellemesin)
    await ensureTestAiPolicy(h.owner, w.tenantA);
    expect((await call(w, 'techEval', 'PUT', `/api/v1/contracts/${d.familyId}/fields`, pdfFields(w))).status).toBe(200);

    const before = await reviews(w, 'techEval', d.familyId);
    expect(before.status).toBe(200);
    expect(before.body).toMatchObject({ current: null, run: null, history: [], threshold: 60, belowThreshold: false, disclaimer: AI_DISCLAIMER, templateVersionId: t.versionId,
      can: { request: true } });

    const r = await requestReview(w, 'techEval', d.familyId);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body).toMatchObject({ status: 'QUEUED', templateVersionId: t.versionId });
    const [queued] = await reviewRuns(d.documentVersionId);
    expect(queued).toMatchObject({ status: 'QUEUED', entity_type: 'contract_version', entity_id: d.contractVersionId, document_version_id: d.documentVersionId,
      requested_by: w.users.techEval.id, prompt_version: PROMPT_VERSIONS.AI14, company_id: w.companyA1.id });
    expect(queued.idempotency_key).toBe(`AI14:contract_version:${d.contractVersionId}:${d.documentVersionId}:tpl-${t.versionId}:${PROMPT_VERSIONS.AI14}`);

    await runWorker();
    const [run] = await reviewRuns(d.documentVersionId);
    expect(run).toMatchObject({ status: 'SUCCEEDED', input_tokens: 1000, output_tokens: 200, response_model: 'test-fixture', actual_cost: '0.010000', cost_currency: 'USD' });

    const g = await reviews(w, 'techEval', d.familyId);
    expect(g.status).toBe(200);
    const cur = g.body.current;
    expect(cur).toMatchObject({ template: { code: t.code, versionNo: 1 }, templateNote: null, modelId: 'test-fixture', isTestProvider: true,
      providerLabel: 'Test sağlayıcısı — gerçek değil', promptVersion: PROMPT_VERSIONS.AI14, rubricVersion: REVIEW_RUBRIC_VERSION, stale: false, documentVersionId: d.documentVersionId });
    expect(g.body.run).toMatchObject({ id: run.id, status: 'SUCCEEDED', isTestProvider: true, providerLabel: 'Test sağlayıcısı — gerçek değil' });
    expect(cur.summary).toMatch(/^Test sağlayıcısı — gerçek değil/);
    // Şablonda olup sözleşmede olmayan "Gizlilik ve KVKK" maddesi (alıntı şablondan, doğrulanmış) + iki risk ifadesi (alıntı sözleşmenin 1. sayfasından).
    const missing = cur.findings.find((f: any) => f.kind === 'MISSING_CLAUSE');
    expect(missing).toMatchObject({ category: 'CONFIDENTIALITY', quote: 'Madde 4 - Gizlilik ve KVKK', page: null, verified: true, sourceLabel: null });
    expect(cur.findings.filter((f: any) => f.kind === 'MISSING_CLAUSE')).toHaveLength(1); // Konu ve Fesih sözleşmede var
    expect(cur.findings.find((f: any) => f.category === 'UNILATERAL_CHANGE')).toMatchObject({ severity: 'MEDIUM', page: 1, verified: true });
    expect(cur.findings.find((f: any) => f.category === 'LIABILITY')).toMatchObject({ severity: 'HIGH', page: 1, verified: true });
    const expected = recompute(cur.findings, true);
    expect(cur.score).toBe(expected.score);
    expect(cur.subScores).toEqual(expected.subScores);
    expect(cur.subScores).toMatchObject({ TEMPLATE: 100, CONFIDENTIALITY: 85, UNILATERAL_CHANGE: 85, LIABILITY: 65 });
    expect(cur.score).toBe(Math.floor((40 * 100 + 6 * (85 + 85 + 65 + 700) + 50) / 100)); // 96
    expect(cur.subScoreList).toHaveLength(11);

    // Değişmez kayıt (R9): güncelleme/silme reddedilir; ikinci istek yeni ücret yaratmaz.
    await expect(h.owner.query(`UPDATE contract_reviews SET score = 1 WHERE id = $1`, [cur.id])).rejects.toThrow();
    const again = await requestReview(w, 'techEval', d.familyId);
    expect(again.body).toMatchObject({ runId: run.id, status: 'SUCCEEDED' });
    expect(await reviewRuns(d.documentVersionId)).toHaveLength(1);

    // GET …/v2 özeti (onay vermez, engellemez).
    const v2 = await call(w, 'techEval', 'GET', `/api/v1/contracts/${d.familyId}/v2`);
    expect(v2.body.review).toMatchObject({ id: cur.id, score: cur.score, threshold: 60, belowThreshold: false, stale: false, isTestProvider: true, disclaimer: AI_DISCLAIMER,
      template: { code: t.code, versionNo: 1 }, modelId: 'test-fixture' });

    // Yapay zekâ sayfası (defter sütunları, R3) — Satınalma ai.read.
    const ov = await call(w, 'buyer', 'GET', '/api/v1/ai/overview');
    expect(ov.status).toBe(200);
    expect(ov.body.runs.find((x: any) => x.id === run.id)).toMatchObject({ task: 'AI14', requestedBy: 'Tolga Er', requestedById: w.users.techEval.id,
      documentVersionId: d.documentVersionId, promptVersion: PROMPT_VERSIONS.AI14, inputTokens: 1000, outputTokens: 200, responseModel: 'test-fixture',
      isTestProvider: true, providerLabel: 'Test sağlayıcısı — gerçek değil', actualCost: '0.010000' });
    expect(ov.body.provider).toEqual({ kind: 'none', modelId: DEFAULT_AI_MODEL_ID, label: 'Bağlı değil', external: false });
    expect(ov.body.contractSettings).toMatchObject({ reviewThreshold: 60 });
    expect(ov.body.quality).toMatchObject({ status: 'BLOCKED', contractAccuracy: 'NOT_RUN', reason: expect.stringContaining('Gerçek sözleşmelerle doğruluk ölçümü yapılmadı (NOT_RUN)') });
    // Eski alanlar aynen.
    expect(ov.body).toHaveProperty('tasks');
    expect(ov.body).toHaveProperty('models');
    expect(ov.body).toHaveProperty('policy');
    expect(ov.body).toHaveProperty('usage');
    expect(ov.body.can).toEqual({ manage: false });
  });

  it('şablonsuz (tür OTHER): TEMPLATE null, toplam hukuk ortalaması, "Şablon yok; yalnız hukuk incelemesi"', async () => {
    const w = await fresh();
    await template(w); // MAINTENANCE şablonu var ama tür OTHER
    const d = await draft(w);
    await ensureTestAiPolicy(h.owner, w.tenantA);
    expect((await call(w, 'techEval', 'PUT', `/api/v1/contracts/${d.familyId}/fields`, { contractType: 'OTHER' })).status).toBe(200);
    const r = await requestReview(w, 'techEval', d.familyId);
    expect(r.body).toMatchObject({ status: 'QUEUED', templateVersionId: null });
    expect((await reviewRuns(d.documentVersionId))[0].idempotency_key).toContain(':tpl-none:');
    await runWorker();
    const cur = (await reviews(w, 'techEval', d.familyId)).body.current;
    expect(cur).toMatchObject({ template: null, templateNote: 'Şablon yok; yalnız hukuk incelemesi', stale: false });
    expect(cur.subScores.TEMPLATE).toBeNull();
    expect(cur.findings.some((f: any) => f.kind === 'MISSING_CLAUSE')).toBe(false);
    expect(cur.score).toBe(recompute(cur.findings, false).score);
    expect(cur.score).toBe(Math.floor((85 + 65 + 800 + 5) / 10)); // 95
  });

  it('modelin score/approve anahtarları yok sayılır; doğrulanmamış bulgu verified=false, "kaynak doğrulanamadı" ve puana girmez', async () => {
    const w = await fresh();
    const d = await draft(w, contractPdf([])); // risk ifadesi yok
    await ensureTestAiPolicy(h.owner, w.tenantA);
    await call(w, 'techEval', 'PUT', `/api/v1/contracts/${d.familyId}/fields`, { contractType: 'OTHER' });
    const evil: AiProvider = {
      name: 'test-fixture',
      async run(modelId, input) {
        const res = await fixture.run(modelId, input);
        const out = res.output as { findings: unknown[]; summary: string };
        return { ...res, output: { ...out, score: 100, approve: true, actions: ['submit'],
          findings: [...out.findings, { category: 'PAYMENT', kind: 'UNFAVORABLE', severity: 'HIGH', title: 'Uydurma ödeme hükmü',
            quote: 'Alici bedeli pesin ve iadesiz oder.', page: 1, templateRef: null, recommendation: 'Gözden geçirin.' }] } };
      },
    };
    registerAiProvider(evil);
    try {
      await requestReview(w, 'techEval', d.familyId);
      await runWorker();
    } finally { registerAiProvider(fixture); }
    const [run] = await reviewRuns(d.documentVersionId);
    expect(run.status).toBe('SUCCEEDED');
    expect(run.flags).toEqual(expect.arrayContaining(['IGNORED_KEY:score', 'IGNORED_KEY:approve', 'IGNORED_KEY:actions']));
    const cur = (await reviews(w, 'techEval', d.familyId)).body.current;
    const fake = cur.findings.find((f: any) => f.title === 'Uydurma ödeme hükmü');
    expect(fake).toMatchObject({ verified: false, sourceLabel: 'kaynak doğrulanamadı', severity: 'HIGH' });
    expect(cur.subScores.PAYMENT).toBe(100);
    expect(cur.score).toBe(100); // modelin 100'ü değil: doğrulanmış bulgu yok → kod 100 hesaplar
    expect(cur.score).toBe(recompute(cur.findings, false).score);
    expect(cur).not.toHaveProperty('approve');
    expect((await h.owner.query(`SELECT count(*)::int AS n FROM contract_approval_chains WHERE family_id = $1`, [d.familyId])).rows[0].n).toBe(0);
  });

  it('yeni belge sürümü ve yeni şablon sürümü eski incelemeyi "güncel değil" yapar; yeni inceleme açılır, eskisi geçmişte kalır', async () => {
    const w = await fresh();
    const t = await template(w);
    const d = await draft(w);
    await ensureTestAiPolicy(h.owner, w.tenantA);
    await call(w, 'techEval', 'PUT', `/api/v1/contracts/${d.familyId}/fields`, { contractType: 'MAINTENANCE' });
    await requestReview(w, 'techEval', d.familyId);
    await runWorker();
    const first = (await reviews(w, 'techEval', d.familyId)).body.current;
    expect(first.stale).toBe(false);

    // Yeni şablon sürümü → güncel değil.
    const tv2 = await multipart(w, 'buyer', `/api/v1/contract-templates/${t.id}/versions`, { validFrom: '2026-06-01' },
      { name: 'sablon2.docx', mime: DOCX_MIME, data: await syntheticDocx([...TEMPLATE_PARAS, 'Madde 5 - Mucbir Sebep', 'Mucbir sebep halleri.']) });
    expect(tv2.status, JSON.stringify(tv2.body)).toBe(201);
    let g = await reviews(w, 'techEval', d.familyId);
    expect(g.body.current).toMatchObject({ id: first.id, stale: true });
    expect(g.body.belowThreshold).toBe(false);
    expect(g.body.templateVersionId).toBe(tv2.body.versionId);

    // Yeni ana belge sürümü → yeni inceleme isteği yeni anahtarla; eskisi geçmişte "güncel değil".
    const st = await call(w, 'techEval', 'GET', `/api/v1/contract-versions/${d.contractVersionId}/signature-status`);
    const dv2 = await uploadContract(w, contractPdf());
    const nv = await call(w, 'techEval', 'POST', `/api/v1/contract-versions/${d.contractVersionId}/versions`, { documentVersionId: dv2, kind: 'MAIN', stage: 'DRAFT' },
      { 'if-match': st.body.contractVersion.etag });
    expect(nv.status, JSON.stringify(nv.body)).toBe(201);
    g = await reviews(w, 'techEval', d.familyId);
    expect(g.body).toMatchObject({ documentVersionId: dv2, current: { id: first.id, stale: true }, run: null });
    expect((await call(w, 'techEval', 'GET', `/api/v1/contracts/${d.familyId}/v2`)).body.review).toMatchObject({ id: first.id, stale: true, belowThreshold: false });
    const r2 = await requestReview(w, 'techEval', d.familyId);
    expect(r2.body).toMatchObject({ status: 'QUEUED', templateVersionId: tv2.body.versionId });
    await runWorker();
    g = await reviews(w, 'techEval', d.familyId);
    expect(g.body.current).toMatchObject({ stale: false, documentVersionId: dv2, template: { code: t.code, versionNo: 2 } });
    expect(g.body.current.findings.find((f: any) => f.kind === 'MISSING_CLAUSE' && f.category === 'FORCE_MAJEURE')).toMatchObject({ verified: true });
    expect(g.body.history).toHaveLength(1);
    expect(g.body.history[0]).toMatchObject({ id: first.id, stale: true, documentVersionId: d.documentVersionId, template: { code: t.code, versionNo: 1 } });
    expect((await h.owner.query(`SELECT count(*)::int AS n FROM contract_reviews WHERE family_id = $1`, [d.familyId])).rows[0].n).toBe(2);
  });

  it('başarısız inceleme "Yeniden incele" ile yeni deneme açar; şablon belgesi okunamazsa çağrı yapılmadan ücretsiz FAILED', async () => {
    const w = await fresh();
    const t = await template(w);
    const d = await draft(w);
    await ensureTestAiPolicy(h.owner, w.tenantA);
    await call(w, 'techEval', 'PUT', `/api/v1/contracts/${d.familyId}/fields`, { contractType: 'MAINTENANCE' });
    // Şablon belgesi nesne deposunda bozuk: hazırlık başarısız, sağlayıcı çağrılmaz, ücret 0.
    const key = (await h.owner.query(`SELECT dv.storage_key FROM contract_template_versions tv JOIN document_versions dv ON dv.id = tv.document_version_id WHERE tv.id = $1`,
      [t.versionId])).rows[0].storage_key;
    const original = await h.store.get(key);
    await h.store.put(key, Buffer.from('bozuk'), DOCX_MIME);
    let calls = 0;
    registerAiProvider({ name: 'test-fixture', run: async (m, i) => { calls++; return fixture.run(m, i); } });
    try {
      await requestReview(w, 'techEval', d.familyId);
      await runWorker();
    } finally { registerAiProvider(fixture); await h.store.put(key, original, DOCX_MIME); }
    expect(calls).toBe(0);
    const [failed] = await reviewRuns(d.documentVersionId);
    expect(failed).toMatchObject({ status: 'FAILED', actual_cost: '0.000000' });
    expect(failed.reason).toMatch(/Şablon metni okunamadı; çağrı yapılmadı/);
    expect((await reviews(w, 'techEval', d.familyId)).body).toMatchObject({ current: null, run: { id: failed.id, status: 'FAILED' } });
    const retry = await requestReview(w, 'techEval', d.familyId);
    expect(retry.body.status).toBe('QUEUED');
    expect(retry.body.runId).not.toBe(failed.id);
    await runWorker();
    expect((await reviews(w, 'techEval', d.familyId)).body).toMatchObject({ run: { id: retry.body.runId, status: 'SUCCEEDED' }, current: { stale: false } });
    // Bekleyen inceleme Yapay zekâ sayfasından yeniden yönlendirilebilir (anahtar ekiyle aynı satır).
    await h.owner.query(`UPDATE ai_tenant_policies SET monthly_budget = 0.00 WHERE tenant_id = $1`, [w.tenantA]);
    await call(w, 'techEval', 'PUT', `/api/v1/contracts/${d.familyId}/fields`, { contractType: 'OTHER' });
    const waiting = await requestReview(w, 'techEval', d.familyId);
    expect(waiting.body.status).toBe('WAITING_QUOTA');
    await h.owner.query(`UPDATE ai_tenant_policies SET monthly_budget = 5.00 WHERE tenant_id = $1`, [w.tenantA]);
    const rr = await call(w, 'buyer', 'POST', `/api/v1/ai/runs/${waiting.body.runId}/retry`);
    expect(rr.status, JSON.stringify(rr.body)).toBe(200);
    expect(rr.body).toMatchObject({ runId: waiting.body.runId, status: 'QUEUED' });
  });
});

describe('eşik (R10) ve görünürlük', () => {
  it('Departman kullanıcısı eşiği değiştiremez; Yönetici değiştirir (denetim); eşik altı puanla gönderim engellenmez, denetim olayı yazılır', async () => {
    const w = await fresh();
    await approvers(w);
    const d = await draft(w);
    await ensureTestAiPolicy(h.owner, w.tenantA);
    expect((await call(w, 'techEval', 'PUT', `/api/v1/contracts/${d.familyId}/fields`, pdfFields(w))).status).toBe(200);

    expect((await call(w, 'techEval', 'PUT', '/api/v1/ai/contract-settings', { reviewThreshold: 99 })).status).toBe(403);
    expect((await call(w, 'buyer', 'PUT', '/api/v1/ai/contract-settings', { reviewThreshold: 99 })).status).toBe(403);
    expect((await call(w, 'techEval', 'GET', '/api/v1/ai/contract-settings')).status).toBe(403);
    expect((await call(w, 'tenantAdmin', 'PUT', '/api/v1/ai/contract-settings', { reviewThreshold: 101 })).status).toBe(400);
    expect((await call(w, 'buyer', 'GET', '/api/v1/ai/contract-settings')).body).toMatchObject({ reviewThreshold: 60, defaultThreshold: 60, can: { manage: false } });
    const put = await call(w, 'tenantAdmin', 'PUT', '/api/v1/ai/contract-settings', { reviewThreshold: 99 });
    expect(put.status, JSON.stringify(put.body)).toBe(200);
    expect(put.body).toMatchObject({ reviewThreshold: 99, updatedBy: 'Tamer Öztürk' });
    const ev = (await h.owner.query(`SELECT data FROM audit_events WHERE action = 'ai.contract_settings.updated' AND tenant_id = $1`, [w.tenantA])).rows;
    expect(ev).toHaveLength(1);
    expect(ev[0].data).toMatchObject({ reviewThreshold: { from: 60, to: 99 } });

    await requestReview(w, 'techEval', d.familyId);
    await runWorker();
    const g = await reviews(w, 'techEval', d.familyId);
    expect(g.body.current.score).toBeLessThan(99);
    expect(g.body).toMatchObject({ threshold: 99, belowThreshold: true, advice: 'Puan eşiğin altında; ek onaycı (ör. kurumun hukuk danışmanı) eklemeniz önerilir.' });
    expect((await call(w, 'techEval', 'GET', `/api/v1/contracts/${d.familyId}/v2`)).body.review).toMatchObject({ belowThreshold: true, threshold: 99 });

    // Engel yok: gönderim 200; olay puan ve eşikle (belge içeriği yok).
    const ik = await departmentUser(w, w.departments.ik);
    const s = await call(w, 'techEval', 'POST', `/api/v1/contracts/${d.familyId}/submit`, { extraApproverIds: [ik.id] });
    expect(s.status, JSON.stringify(s.body)).toBe(200);
    const ack = (await h.owner.query(`SELECT actor_user_id, data FROM audit_events WHERE action = 'contract.review_below_threshold_acknowledged' AND entity_id = $1`, [d.familyId])).rows;
    expect(ack).toHaveLength(1);
    expect(ack[0]).toMatchObject({ actor_user_id: w.users.techEval.id, data: { reviewId: g.body.current.id, score: g.body.current.score, threshold: 99,
      rubricVersion: REVIEW_RUBRIC_VERSION, isTestProvider: true } });

    // Görünürlük (R10, karar 1): EXTRA onaycı (İK) puanı ve bulguları görür, isteyemez; onaysız başka departman göremez; Denetçi görür; başka kiracı göremez.
    const asApprover = await reviews(w, ik, d.familyId);
    expect(asApprover.status).toBe(200);
    expect(asApprover.body).toMatchObject({ current: { id: g.body.current.id, score: g.body.current.score }, can: { request: false } });
    expect(asApprover.body.current.findings.length).toBeGreaterThan(0);
    expect((await requestReview(w, ik, d.familyId)).status).toBe(403);
    const other = await departmentUser(w, w.departments.ik);
    expect((await reviews(w, other, d.familyId)).status).toBe(404);
    expect((await requestReview(w, other, d.familyId)).status).toBe(404);
    expect((await reviews(w, 'auditor', d.familyId)).status).toBe(200);
    expect((await requestReview(w, 'auditor', d.familyId)).status).toBe(403);
    expect((await call(w, 'buyerB', 'GET', `/api/v1/contracts/${d.familyId}/reviews`, undefined, {}, w.tenantB)).status).toBe(404);
    expect((await h.owner.query(`SELECT count(*)::int AS n FROM contract_reviews WHERE family_id = $1`, [d.familyId])).rows[0].n).toBe(1);
  });

  it('eşik üstü ya da güncel olmayan incelemede olay yazılmaz; gönderimde eski "Onaylandı" kararı kayıtla uyuşmuyorsa "Düzeltildi" olur', async () => {
    const w = await fresh();
    await approvers(w);
    await ensureTestAiPolicy(h.owner, w.tenantA);
    const d = await draft(w); // AI06 de çalışır
    await requestReview(w, 'techEval', d.familyId);
    await runWorker();
    const ex = (await call(w, 'techEval', 'GET', `/api/v1/contracts/${d.familyId}/extractions`)).body;
    const id = (f: string) => ex.fields.find((x: any) => x.field === f).id;
    const crit = ['amount', 'currency', 'signedOn', 'startDate', 'endDate', 'supplierVkn'];
    const dec = await call(w, 'techEval', 'PUT', `/api/v1/contracts/${d.familyId}/fields`, { ...pdfFields(w),
      aiDecisions: crit.map((f) => ({ extractionId: id(f), decision: f === 'supplierVkn' ? 'REJECTED' : 'CONFIRMED' })) });
    expect(dec.status, JSON.stringify(dec.body)).toBe(200);
    // Alan kaydı dışındaki bir yolla tutar değişti (uzlaştırmayı atlar): gönderimde CONFIRMED yeniden denetlenir.
    const legacy = await call(w, 'buyer', 'POST', `/api/v1/contract-versions/${d.contractVersionId}/terms`, {
      currency: 'TRY', valueType: 'FIXED', amount: '1300000.00', paymentTerms: '', startDate: '2027-01-01', endDate: '2027-12-31', autoRenewal: false, renewalMonths: null,
      noticeAmount: null, noticeUnit: null, nonWorkingDay: 'PREVIOUS_WORKING_DAY', sourceRef: 'Sözleşme belgesi', limitBasis: 'NET', changeReason: 'Tutar düzeltildi (sentetik).' });
    expect(legacy.status, JSON.stringify(legacy.body)).toBe(201);
    expect((await h.owner.query(`SELECT decision FROM contract_extractions WHERE id = $1`, [id('amount')])).rows[0].decision).toBe('CONFIRMED');
    const s = await call(w, 'techEval', 'POST', `/api/v1/contracts/${d.familyId}/submit`, {});
    expect(s.status, JSON.stringify(s.body)).toBe(200);
    const amount = (await h.owner.query(`SELECT decision FROM contract_extractions WHERE id = $1`, [id('amount')])).rows[0];
    expect(amount.decision).toBe('CORRECTED');
    expect((await h.owner.query(`SELECT decision FROM contract_extractions WHERE id = $1`, [id('currency')])).rows[0].decision).toBe('CONFIRMED');
    expect((await h.owner.query(`SELECT count(*)::int AS n FROM audit_events WHERE action = 'contract.review_below_threshold_acknowledged' AND entity_id = $1`, [d.familyId])).rows[0].n).toBe(0);
  });
});
