// v2 Faz 7 (D112) Görev 6: uyum denetimi motoru (R6–R10), rapor, elle işaret, Denetçi listesi ve PDF. Tüm veri sentetik ("(SENTETİK)").
// Yapay zekâ yalnız `test-fixture` (ve bu dosyada aynı adla kaydedilen hatalı alıntılı taklit) ile: çıktısı GERÇEK OKUMA DEĞİLDİR.
// Sıra önemlidir: sağlayıcısız testler önce (kayıt süreç geneli; geri alınamaz), yapay zekâ testleri sonda.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { DEFAULT_AI_MODEL_ID } from '../src/config.ts';
import { DevAuthProvider } from '../src/auth.ts';
import { ensureTestAiCatalog, ensureTestAiPolicy, syntheticPdf } from '../src/devdata.ts';
import { registerAiProvider, type AiProvider } from '../src/ai/provider.ts';
import { pageTexts } from '../src/ai/text.ts';
import { TEST_PROVIDER_LABEL, testFixtureProvider } from '../src/ai/testProvider.ts';
import { processJobs } from '../src/worker.ts';
import { loadAuditProject, runDataCheck } from '../src/modules/complianceChecks.ts';
import { makeHarness } from './harness.ts';

let h: Awaited<ReturnType<typeof makeHarness>>;
let auth: DevAuthProvider;
const rand = () => randomUUID().slice(0, 8);
const one = async <T = any>(sql: string, params: unknown[] = []) => (await h.owner.query(sql, params)).rows[0] as T;
const rows = async <T = any>(sql: string, params: unknown[] = []) => (await h.owner.query(sql, params)).rows as T[];
type Who = 'buyer' | 'finance' | 'security' | 'techEval' | 'auditor' | 'tenantAdmin';
const call = (who: Who, method: string, url: string, body?: unknown) => h.call(who, method, url, body === undefined ? {} : { body });
const today = async () => (await one<{ d: string }>(`SELECT (now() AT TIME ZONE 'Europe/Istanbul')::date::text AS d`)).d;
async function runWorker() { for (let i = 0; i < 10; i++) { if (!(await processJobs(h.pool, h.store, null, 10, null))) break; } }

let setV1: string;
let setV2: string;

/** Yayımlı set (sahip bağlantısıyla; geçmiş yürürlük tarihi yalnız testte). Kiracıda tek açık taslak: taslak → kurallar → yayım. */
async function publishedSet(versionNo: number, effectiveFrom: string, rules: [code: string, key: string | null, type: string, params: object, weight: number, mandatory: boolean][]) {
  const w = h.world;
  const s = (await one<{ id: string }>(`INSERT INTO procurement_rule_sets (tenant_id, version_no, created_by) VALUES ($1,$2,$3) RETURNING id`,
    [w.tenantA, versionNo, w.users.tenantAdmin.id])).id;
  let i = 0;
  for (const [code, key, type, params, weight, mandatory] of rules) {
    await h.owner.query(`INSERT INTO procurement_rules (tenant_id, rule_set_id, code, name, check_type, check_key, params, weight, mandatory, sort_order)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`, [w.tenantA, s, code, `${code} kuralı (SENTETİK)`, type, key, params, weight, mandatory, i++]);
  }
  await h.owner.query(`UPDATE procurement_rule_sets SET status = 'PUBLISHED', effective_from = $2, published_by = $3, published_at = now() WHERE id = $1`,
    [s, effectiveFrom, w.users.tenantAdmin.id]);
  return s;
}

beforeAll(async () => {
  h = await makeHarness();
  auth = new DevAuthProvider(h.config.devAuthSecret!);
  // security: İK departman kullanıcısı (BT projelerini görmez); techEval BT'de.
  await h.owner.query(`UPDATE memberships SET department_ids = $3 WHERE tenant_id = $1 AND user_id = $2`, [h.world.tenantA, h.world.users.security.id, [h.world.departments.ik]]);
  // v1: yalnız en az 5 teklif (zorunlu), 01.01.2026'dan; v2: varsayılan katalog (§3.6, K01–K14), bugünden (Yönetici API'siyle).
  setV1 = await publishedSet(1, '2026-01-01', [['K01', 'MIN_BIDS', 'DATA', { minBids: 5 }, 10, true]]);
  const draft = await call('tenantAdmin', 'POST', '/api/v1/procurement-rule-sets', { from: 'DEFAULT' });
  expect(draft.status, JSON.stringify(draft.body)).toBe(201);
  const pub = await call('tenantAdmin', 'POST', `/api/v1/procurement-rule-sets/${draft.body.id}/publish`, { effectiveFrom: await today() });
  expect(pub.status, JSON.stringify(pub.body)).toBe(200);
  setV2 = draft.body.id;
});
afterAll(async () => { await h.close(); });

/**
 * Sentetik tam proje (BT): tek kalem, son kapanan turda `bidCount` teklif (s1 en düşük ve kazanan), onaylı kazanan kararı (gerekçeli),
 * projeye bağlı onaylı zincirli sözleşme (tutar = kazanan toplamı, imza karardan sonra), katılımcıların hepsi "Çıkar çatışmam yok".
 */
async function fullProject(o: { bidCount?: number; declarations?: boolean } = {}) {
  const w = h.world;
  const company = w.companyA1.id;
  const buyer = w.users.buyer.id;
  const p = (await one<{ id: string; code: string }>(`INSERT INTO projects (tenant_id, company_id, code, title, category, owner_user_id, created_by, department_id, status, currency, budget)
    VALUES ($1,$2,$3,'Uyum denetimi projesi (SENTETİK)','Genel',$4,$4,$5,'CONTRACTING','TRY',150000) RETURNING id, code`,
    [w.tenantA, company, `PRJ-UY-${rand()}`, buyer, w.departments.bt]));
  const line = (await one<{ id: string }>(`INSERT INTO project_lines (tenant_id, company_id, project_id, line_no, description, unit, quantity)
    VALUES ($1,$2,$3,1,'Sunucu bakımı (SENTETİK)','adet',1) RETURNING id`, [w.tenantA, company, p.id])).id;
  const round = (await one<{ id: string }>(`INSERT INTO rfq_rounds (tenant_id, company_id, project_id, round_no, closes_at, status, requested_by)
    VALUES ($1,$2,$3,1, now() + interval '1 day', 'OPEN', $4) RETURNING id`, [w.tenantA, company, p.id, buyer])).id;
  const sups = [w.suppliers.s1, w.suppliers.s2, w.suppliers.s3].slice(0, o.bidCount ?? 3);
  const tcos = ['100000.00', '120000.00', '130000.00'];
  const bids: string[] = [];
  for (const s of sups) {
    await h.owner.query(`INSERT INTO rfq_invitations (tenant_id, company_id, project_id, round_id, supplier_id, invited_by) VALUES ($1,$2,$3,$4,$5,$6)`,
      [w.tenantA, company, p.id, round, s, buyer]);
    bids.push((await one<{ id: string }>(`INSERT INTO bids (tenant_id, company_id, project_id, round_id, supplier_id, version_no, currency, status, idempotency_key, submitted_by)
      VALUES ($1,$2,$3,$4,$5,1,'TRY','SUBMITTED',$6,$7) RETURNING id`, [w.tenantA, company, p.id, round, s, `bid-${randomUUID()}`, buyer])).id);
  }
  await h.owner.query(`UPDATE rfq_rounds SET status = 'CLOSED', closed_at = now() WHERE id = $1`, [round]);
  const snapshot = { engine: 'sp-domain/compareBids@1', comparison: { bids: bids.map((b, i) => ({ bidId: b, tco: tcos[i], supplierName: `Tedarikçi ${i + 1} (SENTETİK)` })) } };
  const ev = (await one<{ id: string }>(`INSERT INTO evaluations (tenant_id, company_id, project_id, version_no, basis_hash, snapshot, created_by)
    VALUES ($1,$2,$3,1,$4,$5,$6) RETURNING id`, [w.tenantA, company, p.id, 'a'.repeat(64), snapshot, buyer])).id;
  const award = (await one<{ id: string }>(`INSERT INTO awards (tenant_id, company_id, project_id, evaluation_id, version_no, rationale, total, status, proposed_by, decided_by, decided_at)
    VALUES ($1,$2,$3,$4,1,'En düşük ve teknik olarak uygun teklif (sentetik gerekçe).','100000.00','APPROVED',$5,$6,'2026-01-20T09:00:00+03') RETURNING id`,
    [w.tenantA, company, p.id, ev, buyer, w.users.finance.id])).id;
  await h.owner.query(`INSERT INTO award_lines (tenant_id, company_id, award_id, project_line_id, supplier_id, bid_id, quantity, unit_price, amount)
    VALUES ($1,$2,$3,$4,$5,$6,1,100000,100000)`, [w.tenantA, company, award, line, w.suppliers.s1, bids[0]]);
  // Sözleşme: onaylı zincir, tutar 100.000 TRY, imza 01.02.2026 (karar 20.01.2026).
  const doc = (await one<{ id: string }>(`INSERT INTO documents (tenant_id, company_id, kind, title, created_by, code) VALUES ($1,$2,'CONTRACT',$3,$4,$5) RETURNING id`,
    [w.tenantA, company, `Sözleşme ${rand()} (SENTETİK)`, buyer, `BLG-UY-${rand()}`])).id;
  const dv = (await one<{ id: string }>(`INSERT INTO document_versions (tenant_id, company_id, document_id, version_no, sha256, mime_type, size_bytes, storage_key,
      original_filename, basic_check_status, created_by) VALUES ($1,$2,$3,1,$4,'application/pdf',100,$5,'sozlesme.pdf','PASSED',$6) RETURNING id`,
    [w.tenantA, company, doc, 'f'.repeat(64), `tenant/${randomUUID()}`, buyer])).id;
  const familyId = (await one<{ id: string }>(`INSERT INTO contract_families (tenant_id, company_id, title, supplier_id, created_by, code, department_id, intake_flow,
      project_id, contract_type, owner_user_id, signed_on) VALUES ($1,$2,$3,$4,$5,$6,$7,true,$8,'SERVICE',$5,'2026-02-01') RETURNING id`,
    [w.tenantA, company, `Sözleşme ${rand()} (SENTETİK)`, w.suppliers.s1, buyer, `SZL-UY-${rand()}`, w.departments.bt, p.id])).id;
  const cv = (await one<{ id: string }>(`INSERT INTO contract_versions (tenant_id, company_id, family_id, version_no, document_version_id, created_by)
    VALUES ($1,$2,$3,1,$4,$5) RETURNING id`, [w.tenantA, company, familyId, dv, buyer])).id;
  const terms = (await one<{ id: string }>(`INSERT INTO contract_terms (tenant_id, company_id, contract_version_id, revision, currency, value_type, amount,
      start_date, end_date, source_ref, entered_by, limit_basis) VALUES ($1,$2,$3,1,'TRY','FIXED','100000.00','2026-02-01','2027-12-31','Madde 1 (sentetik)',$4,'NET') RETURNING id`,
    [w.tenantA, company, cv, buyer])).id;
  const chain = (await one<{ id: string }>(`INSERT INTO contract_approval_chains (tenant_id, family_id, version_id, terms_id, submitted_by) VALUES ($1,$2,$3,$4,$5) RETURNING id`,
    [w.tenantA, familyId, cv, terms, buyer])).id;
  await h.owner.query(`UPDATE contract_approval_chains SET closed_at = now(), outcome = 'APPROVED' WHERE id = $1`, [chain]);
  if (o.declarations !== false) {
    for (const u of [buyer, w.users.finance.id]) {
      await h.owner.query(`INSERT INTO coi_declarations (tenant_id, company_id, project_id, user_id, kind) VALUES ($1,$2,$3,$4,'NONE')`, [w.tenantA, company, p.id, u]);
    }
  }
  return { id: p.id, code: p.code, familyId, award, bids };
}

async function complete(projectId: string, completedOn?: string) {
  const r = await call('buyer', 'POST', `/api/v1/projects/${projectId}/complete`);
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  if (completedOn) await h.owner.query(`UPDATE projects SET completed_on = $2 WHERE id = $1`, [projectId, completedOn]);
  return r.body.auditJobId as string;
}
const report = async (projectId: string, who: Who = 'buyer') => call(who, 'GET', `/api/v1/projects/${projectId}/compliance`);
const resultOf = (rep: any, code: string) => rep.latest.results.find((r: any) => r.code === code);

async function uploadEvidence(projectId: string, pdf: Buffer, checkKey: string) {
  const token = await auth.issue(`dev|${h.world.users.buyer.email}`);
  const boundary = '----sp' + randomUUID();
  const parts: Buffer[] = [];
  for (const [k, v] of Object.entries({ checkKey, kind: 'RESEARCH', title: `Firma araştırması ${rand()} (SENTETİK)` })) {
    parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`));
  }
  parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="arastirma.pdf"\r\nContent-Type: application/pdf\r\n\r\n`), pdf,
    Buffer.from(`\r\n--${boundary}--\r\n`));
  const res = await h.app.inject({ method: 'POST', url: `/api/v1/projects/${projectId}/compliance-evidence`, payload: Buffer.concat(parts),
    headers: { authorization: `Bearer ${token}`, 'x-tenant-id': h.world.tenantA, 'content-type': `multipart/form-data; boundary=${boundary}` } });
  expect(res.statusCode, res.body).toBe(201);
  return JSON.parse(res.body).documentVersionId as string;
}
const researchPdf = (code: string, sentence: string) => syntheticPdf([['SENTETIK KANIT BELGESI - gercek degildir', `Proje ${code}`, sentence]]);

describe('denetim motoru (R6–R9) — sağlayıcı yok', () => {
  it('işçi tamamlamada koşar: tam sentetik proje → beklenen puan (67), Uyumlu; Türkçe sonuçlar; ikinci koşu aynı puan/hüküm (RF2)', async () => {
    const p = await fullProject();
    const jobId = await complete(p.id);
    expect((await report(p.id)).body).toMatchObject({ latest: null, runs: [], pendingJob: { id: jobId, status: 'QUEUED' } });
    await runWorker();
    expect(await one(`SELECT status, result->>'verdict' AS verdict FROM jobs WHERE id = $1`, [jobId])).toEqual({ status: 'SUCCEEDED', verdict: 'COMPLIANT' });
    const r = await report(p.id);
    expect(r.status).toBe(200);
    const latest = r.body.latest;
    expect(latest).toMatchObject({ runNo: 1, trigger: 'COMPLETED', triggerLabel: 'Proje tamamlanınca', status: 'DONE', score: 67, verdict: 'COMPLIANT', verdictLabel: 'Uyumlu',
      ruleSet: { id: setV2, versionNo: 2 }, aiProvider: null, aiProviderIsTest: false, providerLabel: 'Yapay zekâ kullanılmadı', summarySource: 'AUTO',
      summarySourceLabel: 'Otomatik özet', failedMandatory: [], pdfUrl: `/api/v1/compliance-audits/${latest.id}/pdf` });
    const res = Object.fromEntries(latest.results.map((x: any) => [x.code, x.result]));
    expect(res).toEqual({ K01: 'PASS', K02: 'PASS', K03: 'PASS', K04: 'NO_DATA', K05: 'NO_DATA', K06: 'PASS', K07: 'PASS', K08: 'PASS', K09: 'PASS',
      K10: 'NO_DATA', K11: 'PASS', K12: 'NO_DATA', K13: 'NO_DATA', K14: 'PENDING' });
    expect(resultOf(r.body, 'K01')).toMatchObject({ resultLabel: 'Karşılandı', method: 'DATA', methodLabel: 'Otomatik (veri)', checkTypeLabel: 'Otomatik (veri)',
      finding: 'Son kapanan turda (Tur 1) 3 geçerli teklif var; en az 3 gerekli.' });
    expect(resultOf(r.body, 'K02').finding).toContain('En düşük teklif');
    expect(resultOf(r.body, 'K04')).toMatchObject({ resultLabel: 'Veri yok', finding: expect.stringContaining('Veri yok (Faz 4/6 kaydı bulunamadı)') });
    expect(resultOf(r.body, 'K10').finding).toContain('Veri yok (Faz 4/6 kaydı bulunamadı)');
    expect(resultOf(r.body, 'K12')).toMatchObject({ result: 'NO_DATA', finding: 'Kanıt belgesi yüklenmemiş.' });
    expect(resultOf(r.body, 'K14')).toMatchObject({ result: 'PENDING', resultLabel: 'Elle işaret bekliyor' });
    expect(latest.summary).toContain('Otomatik özet');
    expect(latest.summary).toContain('Hüküm: Uyumlu. Puan: 67/100.');
    expect(r.body.can).toEqual({ rerun: true, mark: true });
    // Ham kod yerine Türkçe karşılık; önbellek içeriği hiçbir alanda yok.
    expect(JSON.stringify(r.body)).not.toMatch(/cache_key|cacheKey|compliance_ai_cache/);
    expect((await rows(`SELECT action FROM audit_events WHERE entity_id = $1 AND action = 'compliance.audited'`, [p.id])).length).toBe(1);

    // R10: yeniden koşu ayrı anahtar; aynı veri + aynı set → aynı puan ve hüküm (run_no artar, eski koşu kalır).
    const rr = await call('buyer', 'POST', `/api/v1/projects/${p.id}/compliance-audits`);
    expect(rr.status, JSON.stringify(rr.body)).toBe(202);
    expect(rr.body).toMatchObject({ status: 'QUEUED', duplicate: false });
    expect((await one(`SELECT idempotency_key, payload FROM jobs WHERE id = $1`, [rr.body.jobId]))).toMatchObject({
      idempotency_key: expect.stringMatching(new RegExp(`^audit:${p.id}:rerun:`)), payload: { projectId: p.id, trigger: 'RERUN' } });
    // Sırada iş varken ikinci istek aynı işi döner.
    expect((await call('tenantAdmin', 'POST', `/api/v1/projects/${p.id}/compliance-audits`)).body).toMatchObject({ jobId: rr.body.jobId, duplicate: true });
    await runWorker();
    const r2 = (await report(p.id)).body;
    expect(r2.latest).toMatchObject({ runNo: 2, trigger: 'RERUN', score: 67, verdict: 'COMPLIANT', ruleSet: { id: setV2 } });
    expect(r2.latest.results.map((x: any) => [x.code, x.result, x.finding])).toEqual(latest.results.map((x: any) => [x.code, x.result, x.finding]));
    expect(r2.latest.summary).toBe(latest.summary);
    expect(r2.runs.map((x: any) => x.runNo)).toEqual([2, 1]);
    // Koşu kayıtları değişmez.
    await expect(h.owner.query(`UPDATE compliance_audits SET score = 1 WHERE id = $1`, [latest.id])).rejects.toThrow();
  });

  it('2 teklif + zorunlu MIN_BIDS → Uyumsuz (neden listesi), Satınalma görevi; eksik beyan bulguda', async () => {
    const p = await fullProject({ bidCount: 2, declarations: false });
    await complete(p.id);
    await runWorker();
    const r = (await report(p.id)).body;
    expect(r.latest).toMatchObject({ verdict: 'NONCOMPLIANT', verdictLabel: 'Uyumsuz' });
    expect(r.latest.failedMandatory.map((f: any) => f.code)).toEqual(['K01', 'K11']);
    expect(resultOf(r, 'K01')).toMatchObject({ result: 'FAIL', finding: 'Son kapanan turda (Tur 1) 2 geçerli teklif var; en az 3 gerekli.' });
    expect(resultOf(r, 'K11').finding).toMatch(/^Beyan vermeyen katılımcılar: .*Alper Yıldız/);
    expect(r.latest.summary).toContain('Uyumsuzluk nedeni (zorunlu kurallar): K01');
    const task = await one(`SELECT kind, assignee_role, severity, status FROM tasks WHERE dedupe_key = $1`, [`compliance-noncompliant:${p.id}`]);
    expect(task).toEqual({ kind: 'compliance_noncompliant', assignee_role: 'PROCUREMENT', severity: 'HIGH', status: 'OPEN' });
  });

  it('R6 set seçimi: tamamlanma günü yeni setten önceyse eski set, sonraysa yeni set; set yoksa NO_RULESET + Yönetici görevi', async () => {
    const old = await fullProject();
    await complete(old.id, '2026-03-15');
    const none = await fullProject();
    await complete(none.id, '2025-12-01');
    await runWorker();
    const o = (await report(old.id)).body.latest;
    expect(o).toMatchObject({ ruleSet: { id: setV1, versionNo: 1, effectiveFrom: '2026-01-01' }, verdict: 'NONCOMPLIANT', score: 0 });
    expect(o.results).toHaveLength(1);
    expect(o.results[0]).toMatchObject({ code: 'K01', result: 'FAIL', finding: 'Son kapanan turda (Tur 1) 3 geçerli teklif var; en az 5 gerekli.' });
    const n = (await report(none.id)).body.latest;
    expect(n).toMatchObject({ status: 'NO_RULESET', statusLabel: 'Kural seti yok', score: null, verdict: null, ruleSet: null, results: [] });
    expect(await one(`SELECT kind, assignee_role FROM tasks WHERE dedupe_key = $1 AND status = 'OPEN'`, [`compliance-no-ruleset:${none.id}`]))
      .toEqual({ kind: 'compliance_no_ruleset', assignee_role: 'ADMIN' });
    // Yeniden koşu da aynı seti kullanır (eski set).
    await call('buyer', 'POST', `/api/v1/projects/${old.id}/compliance-audits`);
    await runWorker();
    expect((await report(old.id)).body.latest).toMatchObject({ runNo: 2, ruleSet: { id: setV1 } });
  });

  it('RF3: contract_reviews / risk_assessments tablosu yokken ilgili kural NO_DATA (hata değil)', async () => {
    const p = await fullProject();
    await complete(p.id);
    const c = await h.owner.connect();
    try {
      await c.query('BEGIN');
      await c.query(`SET LOCAL lock_timeout = '5s'`);
      await c.query(`ALTER TABLE contract_reviews RENAME TO contract_reviews_t6_gone`);
      await c.query(`ALTER TABLE risk_assessments RENAME TO risk_assessments_t6_gone`);
      const project = (await loadAuditProject(c, p.id))!;
      for (const [key, params] of [['TEMPLATE_SCORE_ABOVE', { threshold: '70' }], ['WINNER_RISK_CURRENT', { maxAgeMonths: 12 }], ['WINNER_RISK_LEVEL', { maxLevel: 3 }]] as const) {
        const o = await runDataCheck(c, key, params, project);
        expect(o, key).toMatchObject({ result: 'NO_DATA', finding: 'Veri yok (Faz 4/6 kaydı bulunamadı)' });
      }
    } finally { await c.query('ROLLBACK'); c.release(); }
  });

  it('departman kapsamı (RF4, RLS): başka departman kullanıcısı rapora ve PDF\'e 404; kendi departmanı okur; Denetçi listeler; yetkisiz yeniden koşu/işaret 403', async () => {
    const p = await fullProject();
    await complete(p.id);
    await runWorker();
    const auditId = (await report(p.id)).body.latest.id;
    expect((await report(p.id, 'security')).status).toBe(404);
    expect((await call('security', 'GET', `/api/v1/compliance-audits/${auditId}/pdf`)).status).toBe(404);
    expect((await call('security', 'GET', '/api/v1/compliance-audits')).body.items.find((x: any) => x.projectId === p.id)).toBeUndefined();
    expect((await call('security', 'POST', `/api/v1/projects/${p.id}/compliance-audits`)).status).toBe(403);
    const te = await report(p.id, 'techEval');
    expect(te.status).toBe(200);
    expect(te.body.can).toEqual({ rerun: false, mark: false });
    expect((await call('techEval', 'POST', `/api/v1/projects/${p.id}/compliance-audits`)).status).toBe(403);
    expect((await call('auditor', 'POST', `/api/v1/projects/${p.id}/compliance-audits`)).status).toBe(403);
    expect((await call('auditor', 'POST', `/api/v1/projects/${p.id}/compliance-marks`, { ruleCode: 'K14', result: 'PASS', note: 'Denetçi işaret deniyor', documentVersionId: randomUUID() })).status).toBe(403);
    // Denetçi listesi: proje, departman, tamamlanma, set sürümü, puan, hüküm; süzgeçler.
    const list = await call('auditor', 'GET', '/api/v1/compliance-audits');
    expect(list.status).toBe(200);
    expect(list.body.items.find((x: any) => x.projectId === p.id)).toMatchObject({ auditId, projectCode: p.code, departmentName: 'Bilgi Teknolojileri',
      completedOn: await today(), ruleSetVersion: 2, score: 67, verdict: 'COMPLIANT', verdictLabel: 'Uyumlu', providerLabel: 'Yapay zekâ kullanılmadı' });
    expect((await call('auditor', 'GET', '/api/v1/compliance-audits?verdict=NONCOMPLIANT')).body.items.every((x: any) => x.verdict === 'NONCOMPLIANT')).toBe(true);
    expect((await call('auditor', 'GET', `/api/v1/compliance-audits?departmentId=${h.world.departments.ik}`)).body.items.find((x: any) => x.projectId === p.id)).toBeUndefined();
    // Başka kiracı göremez.
    expect((await h.call('buyerB', 'GET', `/api/v1/projects/${p.id}/compliance`, { tenant: h.world.tenantB })).status).toBe(404);
    // Tamamlanmamış projede yeniden koşu 409.
    const open = await fullProject();
    expect((await call('buyer', 'POST', `/api/v1/projects/${open.id}/compliance-audits`)).body.error).toMatchObject({ code: 'invalid_state' });
  });

  it('PDF: %PDF, Content-Disposition (ASCII + filename*), başlıkta proje kodu, set sürümü, koşu no ve sağlayıcı etiketi; deterministik', async () => {
    const p = await fullProject();
    await complete(p.id);
    await runWorker();
    const auditId = (await report(p.id)).body.latest.id;
    const r = await call('auditor', 'GET', `/api/v1/compliance-audits/${auditId}/pdf`);
    expect(r.status).toBe(200);
    expect(r.headers['content-type']).toBe('application/pdf');
    expect(r.raw.subarray(0, 4).toString()).toBe('%PDF');
    expect(r.headers['content-disposition']).toBe(`attachment; filename="${p.code}-uyum-denetimi-kosu-1.pdf"; filename*=UTF-8''${p.code}-uyum-denetimi-ko%C5%9Fu-1.pdf`);
    const text = (await pageTexts(r.raw, 'application/pdf')).join('\n');
    expect(text).toContain(p.code);
    expect(text).toContain('Kural seti sürüm 2');
    expect(text).toContain('Koşu 1');
    expect(text).toContain('Yapay zekâ sağlayıcısı: Yapay zekâ kullanılmadı');
    expect(text).toContain('Uyumlu');
    const again = await call('buyer', 'GET', `/api/v1/compliance-audits/${auditId}/pdf`);
    expect(Buffer.compare(again.raw, r.raw)).toBe(0);
  });

  it('sağlayıcı yok → kanıt kuralı "Yapay zekâ bağlı değil" (elle işaret bekler); Satınalma elle işaretler (not + kanıt) → yeniden koşuda Elle', async () => {
    const p = await fullProject();
    await complete(p.id);
    const dv = await uploadEvidence(p.id, researchPdf(p.code, 'Kazanan firma arastirmasi yapilmistir.'), 'WINNER_RESEARCH');
    await runWorker();
    const r = (await report(p.id)).body;
    expect(resultOf(r, 'K12')).toMatchObject({ result: 'PENDING', method: null, finding: 'Yapay zekâ bağlı değil; kanıt belgesine bakarak elle işaretleyin.' });
    expect(r.markableRules.map((x: any) => x.code)).toEqual(['K12', 'K13', 'K14']);
    expect(r.latest.score).toBe(67);
    // Doğrulama: kısa not, başka projenin belgesi, veri kuralı.
    const bad = [
      [{ ruleCode: 'K12', result: 'PASS', note: 'kısa', documentVersionId: dv }, 'note_required'],
      [{ ruleCode: 'K12', result: 'PASS', note: 'Firma araştırması incelendi (sentetik).', documentVersionId: randomUUID() }, 'invalid_evidence'],
      [{ ruleCode: 'K01', result: 'PASS', note: 'Veri kuralı elle işaretlenemez (sentetik).', documentVersionId: dv }, 'invalid_rule'],
    ] as const;
    for (const [body, code] of bad) expect((await call('buyer', 'POST', `/api/v1/projects/${p.id}/compliance-marks`, body)).body.error.code).toBe(code);
    const m = await call('buyer', 'POST', `/api/v1/projects/${p.id}/compliance-marks`, { ruleCode: 'K12', result: 'PASS', note: 'Firma araştırması incelendi, yeterli (sentetik).', documentVersionId: dv });
    expect(m.status, JSON.stringify(m.body)).toBe(201);
    expect(m.body).toMatchObject({ mark: { ruleCode: 'K12', result: 'PASS', resultLabel: 'Karşılandı' }, auditJobId: expect.any(String) });
    const m2 = await call('buyer', 'POST', `/api/v1/projects/${p.id}/compliance-marks`, { ruleCode: 'K14', result: 'PASS', note: 'Kurum içi kural karşılandı (sentetik).', documentVersionId: dv });
    expect(m2.status).toBe(201);
    expect((await rows(`SELECT data FROM audit_events WHERE action = 'compliance.marked' AND entity_id = $1`, [p.id])).map((x) => x.data.ruleCode).sort()).toEqual(['K12', 'K14']);
    await runWorker();
    const r2 = (await report(p.id)).body;
    expect(resultOf(r2, 'K12')).toMatchObject({ result: 'PASS', method: 'MANUAL', methodLabel: 'Elle', finding: expect.stringContaining('Elle işaretlendi') });
    expect(resultOf(r2, 'K14')).toMatchObject({ result: 'PASS', method: 'MANUAL' });
    // 74 + 5 + 5 = 84 / 110 → 76.
    expect(r2.latest).toMatchObject({ score: 76, verdict: 'COMPLIANT' });
    expect(r2.marks.map((x: any) => x.ruleCode)).toEqual(['K12', 'K14']);
  });
});

describe('kanıt kuralı yapay zekâyla (RF5) — test sağlayıcısı (gerçek değil)', () => {
  beforeAll(async () => {
    await ensureTestAiCatalog(h.owner, DEFAULT_AI_MODEL_ID);
    await ensureTestAiPolicy(h.owner, h.world.tenantA);
  });
  afterAll(() => { registerAiProvider(testFixtureProvider()); });

  it('belgede olmayan alıntı → NO_DATA "kanıt doğrulanamadı" (karşılanmış sayılmaz); rapor test etiketini taşır', async () => {
    const liar: AiProvider = { name: 'test-fixture', async run() {
      return { output: { answers: [{ questionId: 'research', answer: 'YES', quote: 'Bu firma icin kapsamli arastirma yapildi ve sorun bulunmadi.', page: 1, explanation: 'uydurma' }] },
        usage: { inputTokens: 10, outputTokens: 10 }, actualCost: null, model: 'test-fixture' };
    } };
    registerAiProvider(liar);
    const p = await fullProject();
    await complete(p.id);
    await uploadEvidence(p.id, researchPdf(p.code, 'Bu belgede yalnizca tedarikci adresi yer alir.'), 'WINNER_RESEARCH');
    await runWorker();
    const r = (await report(p.id)).body;
    expect(resultOf(r, 'K12')).toMatchObject({ result: 'NO_DATA', method: 'AI', methodLabel: 'Yapay zekâ' });
    expect(resultOf(r, 'K12').finding).toContain('Kanıt doğrulanamadı');
    expect(resultOf(r, 'K12').finding).toContain(TEST_PROVIDER_LABEL);
    expect(r.latest).toMatchObject({ score: 67, aiProvider: 'test-fixture', aiProviderIsTest: true, providerLabel: TEST_PROVIDER_LABEL });
    expect(await one(`SELECT ai_provider_is_test FROM compliance_audits WHERE id = $1`, [r.latest.id])).toEqual({ ai_provider_is_test: true });
  });

  it('geçerli alıntı → PASS (test etiketi, ai_provider_is_test); yeniden koşu önbellekten aynı sonuç, yeni okuma yok; PDF etiketi', async () => {
    registerAiProvider(testFixtureProvider());
    const p = await fullProject();
    await complete(p.id);
    const dv = await uploadEvidence(p.id, researchPdf(p.code, 'Kazanan firma arastirmasi yapilmistir.'), 'WINNER_RESEARCH');
    await runWorker();
    const r = (await report(p.id)).body;
    const k12 = resultOf(r, 'K12');
    expect(k12).toMatchObject({ result: 'PASS', method: 'AI' });
    expect(k12.finding).toContain(TEST_PROVIDER_LABEL);
    expect(k12.evidence).toEqual(expect.arrayContaining([{ type: 'quote', documentVersionId: dv, page: 1, text: expect.stringContaining('Kazanan firma arastirmasi yapilmistir.') }]));
    // 74 + 5 = 79 / 110 → 72.
    expect(r.latest).toMatchObject({ score: 72, verdict: 'COMPLIANT', aiProvider: 'test-fixture', aiProviderIsTest: true, providerLabel: TEST_PROVIDER_LABEL });
    expect(r.latest.summary).toContain(TEST_PROVIDER_LABEL);
    const runs = await rows(`SELECT id FROM ai_runs WHERE document_version_id = $1 AND task = 'AI15'`, [dv]);
    expect(runs).toHaveLength(1);
    expect((await rows(`SELECT 1 FROM compliance_ai_cache WHERE tenant_id = $1`, [h.world.tenantA])).length).toBeGreaterThanOrEqual(1);

    await call('buyer', 'POST', `/api/v1/projects/${p.id}/compliance-audits`);
    await runWorker();
    const r2 = (await report(p.id)).body;
    expect(r2.latest).toMatchObject({ runNo: 2, score: 72, verdict: 'COMPLIANT', aiProviderIsTest: true });
    expect(resultOf(r2, 'K12')).toEqual(k12);
    expect(await rows(`SELECT id FROM ai_runs WHERE document_version_id = $1 AND task = 'AI15'`, [dv])).toHaveLength(1);
    expect(JSON.stringify(r2)).not.toMatch(/cache_key|cacheKey/);

    const pdf = await call('auditor', 'GET', `/api/v1/compliance-audits/${r2.latest.id}/pdf`);
    const text = (await pageTexts(pdf.raw, 'application/pdf')).join('\n');
    expect(text).toContain(`Yapay zekâ sağlayıcısı: ${TEST_PROVIDER_LABEL}`);
    expect(text).toContain('Koşu 2');
  });
});
