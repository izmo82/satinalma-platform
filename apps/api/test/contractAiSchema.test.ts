// v2 Faz 4 Görev 2: 051c sözleşme yapay zekâ şeması — defter görev kodları ve sütunları, katalog satırı, okuma/inceleme/bulgu/kanıt
// kayıtlarında kiracı RLS'i, departman ve onaycı görünürlüğü (onaycı salt okur), değişmez inceleme, eşik ayarı. Tüm veri sentetik.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { withTenant, type TenantContext, type Tx } from '../src/db.ts';
import { syntheticPdf } from '../src/devdata.ts';
import { makeHarness } from './harness.ts';

let h: Awaited<ReturnType<typeof makeHarness>>;
type Contract = { familyId: string; cvId: string; termsId: string; docVersionId: string };
type AiRecords = { extractionId: string; reviewId: string; findingId: string };
// İK departmanının iki sözleşmesi: c1'de techEval (yalnız BT) onay adımına atanır, c2'ye dokunulmaz.
let c1: Contract; let c2: Contract;
let r1: AiRecords; let r2: AiRecords;

const ctxA = (userId: string, opts: { all?: boolean; departmentIds?: string[] } = {}): TenantContext => ({ tenantId: h.world.tenantA, userId,
  roles: opts.all ? ['PROCUREMENT'] : ['DEPARTMENT_USER'], companyIds: [h.world.companyA1.id], departmentIds: opts.departmentIds ?? [],
  allDepartments: opts.all ?? false, correlationId: 'v2-contract-ai-schema' });
const ctxB = (): TenantContext => ({ tenantId: h.world.tenantB, userId: h.world.users.buyerB.id, roles: ['PROCUREMENT'],
  companyIds: [h.world.companyB1.id], departmentIds: [], allDepartments: true, correlationId: 'v2-contract-ai-schema-b' });
const legalCtx = () => ctxA(h.world.users.legal.id, { all: true });
const btCtx = () => ctxA(h.world.users.techEval.id, { departmentIds: [h.world.departments.bt] });
const ikCtx = () => ctxA(h.world.users.techEval.id, { departmentIds: [h.world.departments.ik] });

async function ikContract(tag: string): Promise<Contract> {
  const up = await h.upload('legal', { name: `${tag}.pdf`, mime: 'application/pdf', data: syntheticPdf([[`SENTETIK AI ${tag} ${randomUUID()}`]]) },
    { companyId: h.world.companyA1.id, kind: 'CONTRACT', title: `İK sözleşmesi ${tag} (SENTETİK)` });
  expect(up.status).toBe(201);
  const c = await h.call('legal', 'POST', '/api/v1/contracts', { body: { title: `İK AI ${tag} ${randomUUID().slice(0, 4)} (SENTETİK)`,
    documentVersionId: up.body.documentVersionId, stage: 'EXECUTION', signatureMethod: 'NOT_REQUIRED', originalCustodyRequired: false,
    parties: [{ role: 'BUYER', displayName: h.world.companyA1.name, legalEntityId: h.world.companyA1.id }], supplierId: h.world.suppliers.s1 } });
  expect(c.status).toBe(201);
  const cvId = c.body.contractVersionId as string;
  const familyId = (await h.owner.query<{ family_id: string }>(`SELECT family_id FROM contract_versions WHERE id = $1`, [cvId])).rows[0]!.family_id;
  await h.owner.query(`UPDATE contract_families SET department_id = $2 WHERE id = $1`, [familyId, h.world.departments.ik]);
  const termsId = (await h.owner.query<{ id: string }>(
    `INSERT INTO contract_terms (tenant_id, company_id, contract_version_id, revision, currency, value_type, amount, start_date, end_date, source_ref, entered_by)
     VALUES ($1, $2, $3, 1, 'TRY', 'FIXED', '120000.00', '2026-01-01', '2026-12-31', 'Madde 4 (sentetik)', $4) RETURNING id`,
    [h.world.tenantA, h.world.companyA1.id, cvId, h.world.users.legal.id])).rows[0]!.id;
  return { familyId, cvId, termsId, docVersionId: up.body.documentVersionId };
}

/** Defter satırı platform kayıt yoluyla değil, doğrudan (sahip) eklenir; şema testidir. */
async function run(task: string, docVersionId: string | null, tenantId = h.world.tenantA): Promise<string> {
  return (await h.owner.query<{ id: string }>(
    `INSERT INTO ai_runs (tenant_id, company_id, task, entity_type, entity_id, document_version_id, status, idempotency_key, prompt_version)
     VALUES ($1, $2, $3, 'contract_family', gen_random_uuid(), $4, 'SUCCEEDED', $5, 'sozlesme-test-v1') RETURNING id`,
    [tenantId, tenantId === h.world.tenantA ? h.world.companyA1.id : h.world.companyB1.id, task, docVersionId, `${task}:${randomUUID()}`])).rows[0]!.id;
}

const insExtraction = (tx: Tx, c: Contract, runId: string, field = 'amount') => tx.query<{ id: string }>(
  `INSERT INTO contract_extractions (tenant_id, family_id, document_version_id, ai_run_id, field, value, page, evidence, confidence, flags, requires_human)
   VALUES ($1, $2, $3, $4, $5, '120000.00', 1, 'Sözleşme Bedeli: 120.000,00 TL', 'HIGH', '[]', true) RETURNING id`,
  [h.world.tenantA, c.familyId, c.docVersionId, runId, field]);
const insReview = (tx: Tx, c: Contract, runId: string) => tx.query<{ id: string }>(
  `INSERT INTO contract_reviews (tenant_id, family_id, document_version_id, ai_run_id, model_id, prompt_version, rubric_version, score, sub_scores, summary)
   VALUES ($1, $2, $3, $4, 'test-model', 'sozlesme-inceleme-2026-11-v1', 'inceleme-puan-2026-v1', 72, '{"TEMPLATE":null,"LIABILITY":65}', 'Sentetik yorum') RETURNING id`,
  [h.world.tenantA, c.familyId, c.docVersionId, runId]);
const insFinding = (tx: Tx, reviewId: string, ord = 0) => tx.query<{ id: string }>(
  `INSERT INTO contract_review_findings (tenant_id, review_id, category, kind, severity, title, quote, page, verified, ord)
   VALUES ($1, $2, 'LIABILITY', 'UNFAVORABLE', 'HIGH', 'Sorumluluk sınırı yok', 'sınırsız sorumluluk', 2, true, $3) RETURNING id`,
  [h.world.tenantA, reviewId, ord]);

async function records(c: Contract): Promise<AiRecords> {
  const ex = await run('AI06', c.docVersionId);
  const rv = await run('AI14', c.docVersionId);
  return withTenant(h.pool, legalCtx(), async (tx) => {
    const extractionId = (await insExtraction(tx, c, ex)).rows[0]!.id;
    const reviewId = (await insReview(tx, c, rv)).rows[0]!.id;
    const findingId = (await insFinding(tx, reviewId)).rows[0]!.id;
    return { extractionId, reviewId, findingId };
  });
}

const seen = (ctx: TenantContext, r: AiRecords) => withTenant(h.pool, ctx, async (tx) => {
  const n = async (sql: string, id: string) => (await tx.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${sql}`, [id])).rows[0]!.n;
  return {
    extraction: await n('contract_extractions WHERE id = $1', r.extractionId),
    review: await n('contract_reviews WHERE id = $1', r.reviewId),
    finding: await n('contract_review_findings WHERE id = $1', r.findingId),
  };
});

beforeAll(async () => {
  h = await makeHarness();
  await h.owner.query(`UPDATE memberships SET department_ids = $3 WHERE tenant_id = $1 AND user_id = $2`,
    [h.world.tenantA, h.world.users.techEval.id, [h.world.departments.bt]]);
  c1 = await ikContract('c1');
  c2 = await ikContract('c2');
  r1 = await records(c1);
  r2 = await records(c2);
});
afterAll(async () => { await h.close(); });

describe('051c sözleşme yapay zekâ şeması', () => {
  it('ai_runs_task_codes_and_ledger_columns', async () => {
    const ai14 = await run('AI14', c2.docVersionId);
    const ai15 = await run('AI15', null);
    expect(ai14).toBeTruthy(); expect(ai15).toBeTruthy();
    await expect(run('AI16', null)).rejects.toThrow(/ai_runs_task_check/);
    await expect(run('AI00', null)).rejects.toThrow(/ai_runs_task_check/);
    // Uygulama rolü yeni defter sütunlarını güncelleyebilir; negatif token reddedilir.
    await withTenant(h.pool, legalCtx(), (tx) => tx.query(
      `UPDATE ai_runs SET input_tokens = 1200, output_tokens = 300, response_model = 'test-model', prompt_version = 'sozlesme-inceleme-2026-11-v1' WHERE id = $1`, [ai14]));
    const row = (await h.owner.query(`SELECT input_tokens, output_tokens, response_model, prompt_version FROM ai_runs WHERE id = $1`, [ai14])).rows[0];
    expect(row).toEqual({ input_tokens: 1200, output_tokens: 300, response_model: 'test-model', prompt_version: 'sozlesme-inceleme-2026-11-v1' });
    await expect(h.owner.query(`UPDATE ai_runs SET input_tokens = -1 WHERE id = $1`, [ai14])).rejects.toThrow();
    // Diğer sütunlar hâlâ kapalı.
    await expect(withTenant(h.pool, legalCtx(), (tx) => tx.query(`UPDATE ai_runs SET task = 'AI06' WHERE id = $1`, [ai14]))).rejects.toThrow(/permission denied/);
  });

  it('anthropic_catalog_row_disabled_unverified', async () => {
    // Test veritabanı kurulumda tüm tabloları boşaltır (globalSetup); migration'daki katalog ifadesi geri alınan işlemde yeniden çalıştırılır.
    const sql = await readFile(fileURLToPath(new URL('../migrations/051c_v2_contract_ai.sql', import.meta.url)), 'utf8');
    const insert = /INSERT INTO ai_models[\s\S]*?ON CONFLICT DO NOTHING;/.exec(sql)?.[0];
    expect(insert).toBeTruthy();
    const c = await h.owner.connect();
    try {
      await c.query('BEGIN');
      await c.query(`DELETE FROM ai_models WHERE provider = 'anthropic' AND model_id = 'claude-sonnet-5-5'`);
      await c.query(insert!);
      await c.query(insert!); // ON CONFLICT DO NOTHING: ikinci çalıştırma satır eklemez
      const m = (await c.query(`SELECT tasks, capabilities, approved_regions, trains_on_customer_data, price, verified_at, enabled
        FROM ai_models WHERE provider = 'anthropic' AND model_id = 'claude-sonnet-5-5'`)).rows;
      expect(m).toHaveLength(1);
      expect(m[0]).toMatchObject({ tasks: ['AI06', 'AI14', 'AI15'], capabilities: { structuredOutput: true, vision: true }, approved_regions: ['anthropic-api'],
        trains_on_customer_data: false, verified_at: null, enabled: false });
      expect(m[0].price).toMatchObject({ unit: 'TOKEN_1M', input: '2.00', output: '10.00', currency: 'USD' });
    } finally {
      await c.query('ROLLBACK');
      c.release();
    }
  });

  it('other_tenant_sees_nothing', async () => {
    expect(await seen(ctxB(), r1)).toEqual({ extraction: 0, review: 0, finding: 0 });
    expect(await seen(legalCtx(), r1)).toEqual({ extraction: 1, review: 1, finding: 1 });
    expect(await seen(ikCtx(), r1)).toEqual({ extraction: 1, review: 1, finding: 1 });
    // Başka kiracı kendi bağlamından bu aileye kayıt ekleyemez.
    const runB = await run('AI06', null, h.world.tenantB);
    await expect(withTenant(h.pool, ctxB(), (tx) => tx.query(
      `INSERT INTO contract_extractions (tenant_id, family_id, document_version_id, ai_run_id, field, confidence, requires_human)
       VALUES ($1, $2, $3, $4, 'title', 'MISSING', true)`, [h.world.tenantA, c2.familyId, c2.docVersionId, runB]))).rejects.toThrow();
  });

  it('department_user_hidden_until_assigned_approver_then_read_only', async () => {
    expect(await seen(btCtx(), r1)).toEqual({ extraction: 0, review: 0, finding: 0 });
    const chain = (await h.owner.query<{ id: string }>(
      `INSERT INTO contract_approval_chains (tenant_id, family_id, version_id, terms_id, submitted_by) VALUES ($1, $2, $3, $4, $5) RETURNING id`,
      [h.world.tenantA, c1.familyId, c1.cvId, c1.termsId, h.world.users.legal.id])).rows[0]!.id;
    await h.owner.query(`INSERT INTO contract_approval_steps (tenant_id, chain_id, step_order, kind, assigned_user_id) VALUES ($1, $2, 1, 'EXTRA', $3)`,
      [h.world.tenantA, chain, h.world.users.techEval.id]);
    expect(await seen(btCtx(), r1)).toEqual({ extraction: 1, review: 1, finding: 1 });
    expect(await seen(btCtx(), r2)).toEqual({ extraction: 0, review: 0, finding: 0 });
    // Onaycı salt okur: karar yazamaz, yeni okuma/inceleme/bulgu ekleyemez.
    const upd = await withTenant(h.pool, btCtx(), (tx) => tx.query(
      `UPDATE contract_extractions SET decision = 'CONFIRMED', decided_by = $2, decided_at = now() WHERE id = $1`, [r1.extractionId, h.world.users.techEval.id]));
    expect(upd.rowCount).toBe(0);
    const ex = await run('AI06', c1.docVersionId);
    const rv = await run('AI14', c1.docVersionId);
    await expect(withTenant(h.pool, btCtx(), (tx) => insExtraction(tx, c1, ex))).rejects.toThrow(/row-level security/);
    await expect(withTenant(h.pool, btCtx(), (tx) => insReview(tx, c1, rv))).rejects.toThrow(/row-level security/);
    await expect(withTenant(h.pool, btCtx(), (tx) => insFinding(tx, r1.reviewId, 5))).rejects.toThrow(/row-level security/);
    // Departman kapsamındaki kullanıcı kararı yazar.
    const ok = await withTenant(h.pool, ikCtx(), (tx) => tx.query(
      `UPDATE contract_extractions SET decision = 'CONFIRMED', decided_by = $2, decided_at = now() WHERE id = $1`, [r1.extractionId, h.world.users.techEval.id]));
    expect(ok.rowCount).toBe(1);
  });

  it('review_and_findings_immutable', async () => {
    const app = (sql: string, id: string) => withTenant(h.pool, legalCtx(), (tx) => tx.query(sql, [id]));
    await expect(app(`UPDATE contract_reviews SET score = 100 WHERE id = $1`, r2.reviewId)).rejects.toThrow(/permission denied/);
    await expect(app(`DELETE FROM contract_reviews WHERE id = $1`, r2.reviewId)).rejects.toThrow(/permission denied/);
    await expect(app(`UPDATE contract_review_findings SET verified = false WHERE id = $1`, r2.findingId)).rejects.toThrow(/permission denied/);
    await expect(app(`DELETE FROM contract_review_findings WHERE id = $1`, r2.findingId)).rejects.toThrow(/permission denied/);
    // Okuma önerisinin değeri/güveni de değişmez; yalnız karar sütunları.
    await expect(app(`UPDATE contract_extractions SET value = '1.00' WHERE id = $1`, r2.extractionId)).rejects.toThrow(/permission denied/);
    await expect(app(`DELETE FROM contract_extractions WHERE id = $1`, r2.extractionId)).rejects.toThrow(/permission denied/);
    // Sahip rolü de değiştiremez.
    await expect(h.owner.query(`UPDATE contract_reviews SET score = 100 WHERE id = $1`, [r2.reviewId])).rejects.toThrow(/immutable_record/);
    await expect(h.owner.query(`DELETE FROM contract_review_findings WHERE id = $1`, [r2.findingId])).rejects.toThrow(/immutable_record/);
  });

  it('checks_and_consistency', async () => {
    const ex = await run('AI06', c2.docVersionId);
    await withTenant(h.pool, legalCtx(), async (tx) => {
      await tx.query('SAVEPOINT s');
      // Bilinmeyen alan, MISSING'de değer, karar verilmeden karar sütunu.
      for (const sql of [
        `INSERT INTO contract_extractions (tenant_id, family_id, document_version_id, ai_run_id, field, confidence, requires_human) VALUES ($1,$2,$3,$4,'approvePayment','LOW',true)`,
        `INSERT INTO contract_extractions (tenant_id, family_id, document_version_id, ai_run_id, field, value, confidence, requires_human) VALUES ($1,$2,$3,$4,'title','X','MISSING',true)`,
        `INSERT INTO contract_extractions (tenant_id, family_id, document_version_id, ai_run_id, field, confidence, requires_human, decision) VALUES ($1,$2,$3,$4,'title','LOW',true,'CONFIRMED')`,
      ]) {
        await expect(tx.query(sql, [h.world.tenantA, c2.familyId, c2.docVersionId, ex])).rejects.toThrow();
        await tx.query('ROLLBACK TO SAVEPOINT s');
      }
      // Belge sürümü başka ailenin; defter satırı yanlış görev kodunda.
      await expect(insExtraction(tx, { ...c2, docVersionId: c1.docVersionId }, ex)).rejects.toThrow(/inconsistent_record/);
      await tx.query('ROLLBACK TO SAVEPOINT s');
      await expect(insReview(tx, c2, ex)).rejects.toThrow(/inconsistent_record/);
      await tx.query('ROLLBACK TO SAVEPOINT s');
      // Aynı çalıştırmada aynı alan ikinci kez yazılmaz.
      await insExtraction(tx, c2, ex, 'currency');
      await tx.query('SAVEPOINT t');
      await expect(insExtraction(tx, c2, ex, 'currency')).rejects.toThrow(/duplicate key/);
      await tx.query('ROLLBACK TO SAVEPOINT t');
      // Puan 0–100; bulgu kategorisi listede.
      const rv = await run('AI14', c2.docVersionId);
      await expect(tx.query(`INSERT INTO contract_reviews (tenant_id, family_id, document_version_id, ai_run_id, prompt_version, rubric_version, score, sub_scores)
        VALUES ($1,$2,$3,$4,'p','r',101,'{}')`, [h.world.tenantA, c2.familyId, c2.docVersionId, rv])).rejects.toThrow(/score/);
      await tx.query('ROLLBACK TO SAVEPOINT t');
      await expect(tx.query(`INSERT INTO contract_review_findings (tenant_id, review_id, category, kind, severity, title, verified, ord)
        VALUES ($1,$2,'APPROVAL','LEGAL_RISK','HIGH','x',false,9)`, [h.world.tenantA, r2.reviewId])).rejects.toThrow(/category/);
    });
  });

  it('evidence_reading_follows_document_visibility', async () => {
    const rid = await run('AI15', c1.docVersionId);
    const id = await withTenant(h.pool, legalCtx(), async (tx) => (await tx.query<{ id: string }>(
      `INSERT INTO ai_evidence_readings (tenant_id, company_id, document_version_id, ai_run_id, purpose, question_set, result)
       VALUES ($1, $2, $3, $4, 'Sentetik kanıt', '[{"id":"q1","text":"Sigorta poliçesi geçerli mi?"}]', '[{"id":"q1","answer":"UNCLEAR"}]') RETURNING id`,
      [h.world.tenantA, h.world.companyA1.id, c1.docVersionId, rid])).rows[0]!.id);
    const n = (ctx: TenantContext) => withTenant(h.pool, ctx, async (tx) => (await tx.query(`SELECT 1 FROM ai_evidence_readings WHERE id = $1`, [id])).rowCount);
    expect(await n(legalCtx())).toBe(1);
    expect(await n(ctxB())).toBe(0);
    // c1 belgesi İK sözleşmesinin; BT kullanıcısı c1'de onaycı olduğundan belgeyi görür, c2 belgesine bağlı okuma gizli kalır.
    expect(await n(btCtx())).toBe(1);
    const rid2 = await run('AI15', c2.docVersionId);
    const id2 = (await h.owner.query<{ id: string }>(`INSERT INTO ai_evidence_readings (tenant_id, company_id, document_version_id, ai_run_id, purpose, question_set)
      VALUES ($1, $2, $3, $4, 'Sentetik kanıt', '[]') RETURNING id`, [h.world.tenantA, h.world.companyA1.id, c2.docVersionId, rid2])).rows[0]!.id;
    expect(await withTenant(h.pool, btCtx(), async (tx) => (await tx.query(`SELECT 1 FROM ai_evidence_readings WHERE id = $1`, [id2])).rowCount)).toBe(0);
    // Onaycı yazamaz (belge yolu yazma kuralı); değişmez.
    const rid3 = await run('AI15', c1.docVersionId);
    await expect(withTenant(h.pool, btCtx(), (tx) => tx.query(`INSERT INTO ai_evidence_readings (tenant_id, company_id, document_version_id, ai_run_id, purpose, question_set)
      VALUES ($1, $2, $3, $4, 'Sentetik kanıt', '[]')`, [h.world.tenantA, h.world.companyA1.id, c1.docVersionId, rid3]))).rejects.toThrow(/row-level security/);
    await expect(withTenant(h.pool, legalCtx(), (tx) => tx.query(`UPDATE ai_evidence_readings SET result = '[]' WHERE id = $1`, [id]))).rejects.toThrow(/permission denied/);
    // Defter satırı AI15 değilse reddedilir.
    const wrong = await run('AI06', c1.docVersionId);
    await expect(h.owner.query(`INSERT INTO ai_evidence_readings (tenant_id, document_version_id, ai_run_id, purpose, question_set) VALUES ($1, $2, $3, 'x', '[]')`,
      [h.world.tenantA, c1.docVersionId, wrong])).rejects.toThrow(/inconsistent_record/);
  });

  it('review_threshold_setting', async () => {
    await withTenant(h.pool, legalCtx(), (tx) => tx.query(`INSERT INTO contract_ai_settings (tenant_id, updated_by) VALUES ($1, $2)`, [h.world.tenantA, h.world.users.legal.id]));
    const get = (ctx: TenantContext) => withTenant(h.pool, ctx, async (tx) => (await tx.query<{ review_threshold: number }>(`SELECT review_threshold FROM contract_ai_settings`)).rows);
    expect(await get(legalCtx())).toEqual([{ review_threshold: 60 }]);
    expect(await get(ctxB())).toEqual([]);
    await expect(withTenant(h.pool, legalCtx(), (tx) => tx.query(`UPDATE contract_ai_settings SET review_threshold = 101 WHERE tenant_id = $1`, [h.world.tenantA])))
      .rejects.toThrow(/review_threshold/);
    await expect(withTenant(h.pool, legalCtx(), (tx) => tx.query(`UPDATE contract_ai_settings SET review_threshold = -1 WHERE tenant_id = $1`, [h.world.tenantA])))
      .rejects.toThrow(/review_threshold/);
    await withTenant(h.pool, legalCtx(), (tx) => tx.query(`UPDATE contract_ai_settings SET review_threshold = 75, updated_at = now() WHERE tenant_id = $1`, [h.world.tenantA]));
    expect(await get(legalCtx())).toEqual([{ review_threshold: 75 }]);
    // Başka kiracının ayarı yazılamaz.
    await expect(withTenant(h.pool, ctxB(), (tx) => tx.query(`INSERT INTO contract_ai_settings (tenant_id) VALUES ($1)`, [h.world.tenantA]))).rejects.toThrow(/row-level security/);
    await expect(withTenant(h.pool, legalCtx(), (tx) => tx.query(`DELETE FROM contract_ai_settings WHERE tenant_id = $1`, [h.world.tenantA]))).rejects.toThrow(/permission denied/);
  });
});
