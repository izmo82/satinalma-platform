// v2 Faz 6 (D111) Görev 2: 053/054 risk şeması — her tabloda kiracı RLS'i, tedarikçi kapsamı, yayımlanmış soru setinin değişmezliği,
// revizyonun değişmezliği (GRANT + tetikleyici), tedarikçi + yıl tekilliği, departman görünürlüğü ve katkıcı departman (yürürlükteki
// sözleşme), departmansız kayıt, görev departmanı, seviye 4–5 tamamlanma güvencesi, içe aktarım partisinin bir kez uygulanması.
// Tüm veri sentetik ("Test sorusu 1" gibi açıkça sentetik metinler; kurum şablonu değildir).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { withTenant, type TenantContext } from '../src/db.ts';
import { makeHarness } from './harness.ts';

let h: Awaited<ReturnType<typeof makeHarness>>;
let yearSeq = 2030;
const nextYear = () => yearSeq++;
const rand = () => randomUUID().slice(0, 8);

type Who = 'buyer' | 'techEval' | 'tenantAdmin' | 'auditor' | 'security';
const all = (who: Who = 'buyer'): TenantContext => ({ tenantId: h.world.tenantA, userId: h.world.users[who].id, roles: ['PROCUREMENT'],
  companyIds: [h.world.companyA1.id], departmentIds: [], allDepartments: true, correlationId: 'v2-risk-schema' });
const dept = (deps: string[], who: Who = 'techEval'): TenantContext => ({ tenantId: h.world.tenantA, userId: h.world.users[who].id,
  roles: ['DEPARTMENT_USER'], companyIds: [h.world.companyA1.id], departmentIds: deps, allDepartments: false, correlationId: 'v2-risk-schema-d' });
const tenantB = (): TenantContext => ({ tenantId: h.world.tenantB, userId: h.world.users.buyerB.id, roles: ['PROCUREMENT'],
  companyIds: [h.world.companyB1.id], departmentIds: [], allDepartments: true, correlationId: 'v2-risk-schema-b' });
const supplierCtx = (who: 'supplier1' | 'supplier2', supplierId: string): TenantContext => ({ tenantId: h.world.tenantA,
  userId: h.world.users[who].id, roles: ['SUPPLIER'], companyIds: [], departmentIds: [], allDepartments: false, supplierId,
  correlationId: 'v2-risk-schema-s' });

async function rejects(p: Promise<unknown>, code: string, message?: RegExp) {
  const err = await p.then(() => null, (e: any) => e);
  expect(err, `beklenen hata ${code}`).not.toBeNull();
  expect(err.code, String(err?.message)).toBe(code);
  if (message) expect(err.message).toMatch(message);
}
const count = async (tx: pg.PoolClient, sql: string, params: unknown[] = []) =>
  (await tx.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${sql}`, params)).rows[0]!.n;
const one = async <T = any>(sql: string, params: unknown[] = []) => (await h.owner.query(sql, params)).rows[0] as T;

/** Sahip bağlantısıyla değerlendirme (OPEN). */
async function assessment(o: { supplier?: string; year?: number; department?: string | null; tenant?: string } = {}) {
  const tenant = o.tenant ?? h.world.tenantA;
  return (await one<{ id: string }>(`INSERT INTO risk_assessments (tenant_id, supplier_id, year, department_id, source, opened_by)
    VALUES ($1, $2, $3, $4, 'MANUAL', $5) RETURNING id`,
    [tenant, o.supplier ?? h.world.suppliers.s1, o.year ?? nextYear(), o.department === undefined ? h.world.departments.ik : o.department,
     tenant === h.world.tenantA ? h.world.users.buyer.id : h.world.users.buyerB.id])).id;
}
/** Excel satır 5: ölçütler 3,5,1,3,5,5 → kritiklik 3,224968 (sütun 3), skor 15 → seviye 2. */
async function revision(assessmentId: string, o: { score?: string; column?: number; level?: number; no?: number; tenant?: string } = {}) {
  const tenant = o.tenant ?? h.world.tenantA;
  return (await one<{ id: string }>(`INSERT INTO risk_assessment_revisions (tenant_id, assessment_id, revision_no, criteria, criticality, criticality_column,
      score_source, risk_score, level, method_version, created_by)
    VALUES ($1, $2, $3, $4, '3.224968', $5, 'MANUAL_RESULT', $6, $7, 'khc-it-2100-002-r009/v1', $8) RETURNING id`,
    [tenant, assessmentId, o.no ?? 1, { businessImpact: 3, dataSensitivity: 5, continuity: 1, integration: 3, regulation: 5, serviceType: 5 },
     o.column ?? 3, o.score ?? '15.00', o.level ?? 2, tenant === h.world.tenantA ? h.world.users.buyer.id : h.world.users.buyerB.id])).id;
}
async function action(assessmentId: string, o: { kind?: 'MITIGATION' | 'CONTROL'; visible?: boolean; status?: string; tenant?: string } = {}) {
  const tenant = o.tenant ?? h.world.tenantA;
  const kind = o.kind ?? 'MITIGATION';
  const closed = o.status === 'DONE' || o.status === 'VERIFIED';
  return (await one<{ id: string }>(`INSERT INTO risk_actions (tenant_id, assessment_id, kind, control_method, title, owner_user_id, due_on,
      supplier_visible, status, completed_at, completed_by, created_by)
    VALUES ($1, $2, $3, $4, $5, $6, '2099-01-31', $7, $8, $9, $10, $6) RETURNING id`,
    [tenant, assessmentId, kind, kind === 'CONTROL' ? 'DESK' : null, `Sentetik ${kind} ${rand()}`,
     tenant === h.world.tenantA ? h.world.users.buyer.id : h.world.users.buyerB.id, o.visible ?? false, o.status ?? 'OPEN',
     closed ? new Date() : null, closed ? h.world.users.buyer.id : null])).id;
}

/**
 * Sahip bağlantısıyla sözleşme ailesi (tek sürüm + koşul revizyonu). approved: son zincir APPROVED ve güncel içeriği kapsar;
 * legacy: Faz 3 öncesi (intake_flow=false), zincir yok.
 */
async function contract(o: { department: string; supplier?: string; endDate?: string | null; approved?: boolean; legacy?: boolean }) {
  const w = h.world;
  const doc = (await one<{ id: string }>(`INSERT INTO documents (tenant_id, company_id, kind, title, created_by, code) VALUES ($1, $2, 'CONTRACT', $3, $4, $5) RETURNING id`,
    [w.tenantA, w.companyA1.id, `Risk sözleşmesi ${rand()} (SENTETİK)`, w.users.buyer.id, `BLG-RSK-${rand()}`])).id;
  const dv = (await one<{ id: string }>(`INSERT INTO document_versions (tenant_id, company_id, document_id, version_no, sha256, mime_type, size_bytes, storage_key,
      original_filename, basic_check_status, created_by)
    VALUES ($1, $2, $3, 1, $4, 'application/pdf', 100, $5, 'sozlesme.pdf', 'PASSED', $6) RETURNING id`,
    [w.tenantA, w.companyA1.id, doc, 'b'.repeat(64), `tenant/${randomUUID()}`, w.users.buyer.id])).id;
  const familyId = (await one<{ id: string }>(`INSERT INTO contract_families (tenant_id, company_id, title, supplier_id, created_by, code, department_id, intake_flow)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
    [w.tenantA, w.companyA1.id, `Risk sözleşmesi ${rand()} (SENTETİK)`, o.supplier ?? w.suppliers.s1, w.users.buyer.id, `SZL-RSK-${rand()}`,
     o.department, !o.legacy])).id;
  const cvId = (await one<{ id: string }>(`INSERT INTO contract_versions (tenant_id, company_id, family_id, version_no, document_version_id, created_by)
    VALUES ($1, $2, $3, 1, $4, $5) RETURNING id`, [w.tenantA, w.companyA1.id, familyId, dv, w.users.buyer.id])).id;
  const termsId = (await one<{ id: string }>(`INSERT INTO contract_terms (tenant_id, company_id, contract_version_id, revision, currency, value_type, amount,
      start_date, end_date, source_ref, entered_by)
    VALUES ($1, $2, $3, 1, 'TRY', 'FIXED', '1000.00', '2020-01-01', $4, 'Madde 1 (sentetik)', $5) RETURNING id`,
    [w.tenantA, w.companyA1.id, cvId, o.endDate === undefined ? '2099-12-31' : o.endDate, w.users.buyer.id])).id;
  if (o.approved !== false && !o.legacy) {
    const c = (await one<{ id: string }>(`INSERT INTO contract_approval_chains (tenant_id, family_id, version_id, terms_id, submitted_by) VALUES ($1,$2,$3,$4,$5) RETURNING id`,
      [w.tenantA, familyId, cvId, termsId, w.users.buyer.id])).id;
    await h.owner.query(`UPDATE contract_approval_chains SET closed_at = now(), outcome = 'APPROVED' WHERE id = $1`, [c]);
  }
  return { familyId, cvId, termsId };
}
const isContributor = (deps: string[], assessmentId: string) =>
  withTenant(h.pool, dept(deps), async (tx) => (await tx.query<{ ok: boolean }>(`SELECT app_is_risk_contributor($1) AS ok`, [assessmentId])).rows[0]!.ok);

beforeAll(async () => {
  h = await makeHarness();
  // techEval yalnız BT departmanında (İK değil).
  await h.owner.query(`UPDATE memberships SET department_ids = $3 WHERE tenant_id = $1 AND user_id = $2`,
    [h.world.tenantA, h.world.users.techEval.id, [h.world.departments.bt]]);
});
afterAll(async () => { await h.close(); });

describe('053 kiracı ve tedarikçi kapsamı', () => {
  it('every_risk_table_isolated_by_tenant', async () => {
    const w = h.world;
    const set = (await one<{ id: string }>(`INSERT INTO risk_question_sets (tenant_id, code, version, name, created_by) VALUES ($1, $2, 1, 'Sentetik set', $3) RETURNING id`,
      [w.tenantA, `SET-${rand()}`, w.users.buyer.id])).id;
    await h.owner.query(`INSERT INTO risk_questions (tenant_id, set_id, ordinal, code, text, weight) VALUES ($1, $2, 1, 'Q1', 'Test sorusu 1', '2.50')`, [w.tenantA, set]);
    await h.owner.query(`INSERT INTO risk_settings (tenant_id, due_days, updated_by) VALUES ($1, 60, $2) ON CONFLICT (tenant_id) DO NOTHING`, [w.tenantA, w.users.tenantAdmin.id]);
    const a = await assessment({ department: null });
    const r = await revision(a);
    await action(a, { visible: true });
    await h.owner.query(`INSERT INTO risk_reviews (tenant_id, assessment_id, period, outcome, decided_by) VALUES ($1, $2, '2030-2', 'NO_CHANGE', $3)`, [w.tenantA, a, w.users.buyer.id]);
    await h.owner.query(`INSERT INTO risk_opinions (tenant_id, assessment_id, author_id, body) VALUES ($1, $2, $3, 'Sentetik görüş')`, [w.tenantA, a, w.users.buyer.id]);
    const b = (await one<{ id: string }>(`INSERT INTO risk_import_batches (tenant_id, file_sha256, file_name, year, fraction_scale, uploaded_by)
      VALUES ($1, $2, 'risk.xlsx', 2026, true, $3) RETURNING id`, [w.tenantA, 'c'.repeat(64), w.users.buyer.id])).id;
    await h.owner.query(`INSERT INTO risk_import_rows (tenant_id, batch_id, row_no, raw) VALUES ($1, $2, 5, '{"A":"Sentetik Tedarik A.Ş."}')`, [w.tenantA, b]);
    const tables: [string, string, unknown[]][] = [
      ['risk_question_sets', 'id = $1', [set]], ['risk_questions', 'set_id = $1', [set]], ['risk_settings', 'tenant_id = $1', [w.tenantA]],
      ['risk_assessments', 'id = $1', [a]], ['risk_assessment_revisions', 'id = $1', [r]], ['risk_actions', 'assessment_id = $1', [a]],
      ['risk_reviews', 'assessment_id = $1', [a]], ['risk_opinions', 'assessment_id = $1', [a]], ['risk_import_batches', 'id = $1', [b]],
      ['risk_import_rows', 'batch_id = $1', [b]],
    ];
    await withTenant(h.pool, all(), async (tx) => {
      for (const [t, where, p] of tables) expect(await count(tx, `${t} WHERE ${where}`, p), t).toBeGreaterThan(0);
    });
    await withTenant(h.pool, tenantB(), async (tx) => {
      for (const [t, where, p] of tables) expect(await count(tx, `${t} WHERE ${where}`, p), t).toBe(0);
      for (const [t] of tables) expect(await count(tx, t), t).toBe(0);
    });
    // B kiracısı A'nın tedarikçisine/değerlendirmesine yazamaz.
    await withTenant(h.pool, tenantB(), (tx) => rejects(tx.query(`INSERT INTO risk_opinions (tenant_id, assessment_id, author_id, body) VALUES ($1, $2, $3, 'Sızma')`,
      [w.tenantA, a, w.users.buyerB.id]), '42501'));
  });

  it('supplier_session_sees_only_own_rows_and_nothing_else', async () => {
    const w = h.world;
    const mine = await assessment({ supplier: w.suppliers.s1 });
    await revision(mine);
    const visible = await action(mine, { visible: true });
    await action(mine, { visible: false });
    await h.owner.query(`INSERT INTO risk_opinions (tenant_id, assessment_id, author_id, body) VALUES ($1, $2, $3, 'İç görüş (sentetik)')`, [w.tenantA, mine, w.users.buyer.id]);
    await h.owner.query(`INSERT INTO risk_reviews (tenant_id, assessment_id, period, outcome, decided_by) VALUES ($1, $2, '2030-3', 'NO_CHANGE', $3)`, [w.tenantA, mine, w.users.buyer.id]);
    const other = await assessment({ supplier: w.suppliers.s2 });
    await revision(other);
    await action(other, { visible: true });
    const ids = [mine, other];
    await withTenant(h.pool, supplierCtx('supplier1', w.suppliers.s1), async (tx) => {
      expect((await tx.query(`SELECT id FROM risk_assessments WHERE id = ANY($1::uuid[])`, [ids])).rows.map((r) => r.id)).toEqual([mine]);
      expect(await count(tx, `risk_assessments WHERE supplier_id <> $1`, [w.suppliers.s1])).toBe(0);
      expect(await count(tx, `risk_assessment_revisions WHERE assessment_id = ANY($1::uuid[])`, [ids])).toBe(1);
      expect((await tx.query(`SELECT id FROM risk_actions WHERE assessment_id = ANY($1::uuid[])`, [ids])).rows.map((r) => r.id)).toEqual([visible]);
      expect(await count(tx, `risk_actions WHERE NOT supplier_visible`)).toBe(0);
      for (const t of ['risk_opinions', 'risk_import_rows', 'risk_import_batches', 'risk_reviews', 'risk_question_sets', 'risk_questions', 'risk_settings']) {
        expect(await count(tx, t), t).toBe(0);
      }
    });
    // Tedarikçi bağlamı hiçbir risk tablosuna yazamaz.
    const s = () => supplierCtx('supplier1', w.suppliers.s1);
    await withTenant(h.pool, s(), (tx) => rejects(tx.query(`INSERT INTO risk_opinions (tenant_id, assessment_id, author_id, body) VALUES ($1, $2, $3, 'Tedarikçi görüşü')`,
      [w.tenantA, mine, w.users.supplier1.id]), '42501'));
    await withTenant(h.pool, s(), (tx) => rejects(tx.query(`INSERT INTO risk_assessments (tenant_id, supplier_id, year, source) VALUES ($1, $2, $3, 'MANUAL')`,
      [w.tenantA, w.suppliers.s1, nextYear()]), '42501'));
    await withTenant(h.pool, s(), async (tx) => {
      expect((await tx.query(`UPDATE risk_assessments SET services = 'değişti' WHERE id = $1`, [mine])).rowCount).toBe(0);
      expect((await tx.query(`UPDATE risk_actions SET title = 'değişti' WHERE id = $1`, [visible])).rowCount).toBe(0);
    });
  });
});

describe('053 değişmezlik ve tekillik', () => {
  it('published_question_set_is_immutable', async () => {
    const w = h.world;
    const code = `SET-${rand()}`;
    const set = (await one<{ id: string }>(`INSERT INTO risk_question_sets (tenant_id, code, version, name, created_by) VALUES ($1, $2, 1, 'Sentetik set', $3) RETURNING id`,
      [w.tenantA, code, w.users.tenantAdmin.id])).id;
    // Taslak: uygulama rolü soru ekler, değiştirir, siler.
    await withTenant(h.pool, all('tenantAdmin'), async (tx) => {
      const q1 = (await tx.query(`INSERT INTO risk_questions (tenant_id, set_id, ordinal, code, text, weight) VALUES ($1, $2, 1, 'Q1', 'Test sorusu 1', '3.00') RETURNING id`, [w.tenantA, set])).rows[0].id;
      const q2 = (await tx.query(`INSERT INTO risk_questions (tenant_id, set_id, ordinal, code, text, weight, risk_answer) VALUES ($1, $2, 2, 'Q2', 'Test sorusu 2', '1.50', 'NO') RETURNING id`, [w.tenantA, set])).rows[0].id;
      expect((await tx.query(`UPDATE risk_questions SET weight = '4.25' WHERE id = $1`, [q1])).rowCount).toBe(1);
      expect((await tx.query(`DELETE FROM risk_questions WHERE id = $1`, [q2])).rowCount).toBe(1);
      expect((await tx.query(`UPDATE risk_question_sets SET status = 'PUBLISHED', published_by = $2, published_at = now() WHERE id = $1`, [set, w.users.tenantAdmin.id])).rowCount).toBe(1);
    });
    const q1 = (await one<{ id: string; weight: string }>(`SELECT id, weight::text FROM risk_questions WHERE set_id = $1`, [set]));
    expect(q1.weight).toBe('4.25');
    const ctx = () => all('tenantAdmin');
    await withTenant(h.pool, ctx(), (tx) => rejects(tx.query(`UPDATE risk_questions SET weight = '9.00' WHERE id = $1`, [q1.id]), 'P0001', /immutable_record/));
    await withTenant(h.pool, ctx(), (tx) => rejects(tx.query(`DELETE FROM risk_questions WHERE id = $1`, [q1.id]), 'P0001', /immutable_record/));
    await withTenant(h.pool, ctx(), (tx) => rejects(tx.query(`INSERT INTO risk_questions (tenant_id, set_id, ordinal, code, text, weight) VALUES ($1, $2, 3, 'Q3', 'Test sorusu 3', '1.00')`,
      [w.tenantA, set]), 'P0001', /immutable_record/));
    await withTenant(h.pool, ctx(), (tx) => rejects(tx.query(`UPDATE risk_question_sets SET name = 'Yeni ad' WHERE id = $1`, [set]), 'P0001', /immutable_record/));
    await withTenant(h.pool, ctx(), (tx) => rejects(tx.query(`UPDATE risk_question_sets SET status = 'DRAFT', published_by = NULL, published_at = NULL WHERE id = $1`, [set]), 'P0001'));
    await withTenant(h.pool, ctx(), (tx) => rejects(tx.query(`DELETE FROM risk_question_sets WHERE id = $1`, [set]), '42501'));
    // Sahip bağlantısı da değiştiremez (tetikleyici).
    await rejects(h.owner.query(`UPDATE risk_questions SET text = 'Değişti' WHERE id = $1`, [q1.id]), 'P0001', /immutable_record/);
    await rejects(h.owner.query(`DELETE FROM risk_questions WHERE id = $1`, [q1.id]), 'P0001', /immutable_record/);
    // Kod başına tek yayımlanmış sürüm; eski sürüm emekliye ayrılınca yenisi yayımlanır. Emekli set de değişmez.
    const v2 = (await one<{ id: string }>(`INSERT INTO risk_question_sets (tenant_id, code, version, name, created_by) VALUES ($1, $2, 2, 'Sentetik set v2', $3) RETURNING id`,
      [w.tenantA, code, w.users.tenantAdmin.id])).id;
    await rejects(h.owner.query(`UPDATE risk_question_sets SET status = 'PUBLISHED', published_by = $2, published_at = now() WHERE id = $1`, [v2, w.users.tenantAdmin.id]), '23505');
    await withTenant(h.pool, ctx(), async (tx) => {
      expect((await tx.query(`UPDATE risk_question_sets SET status = 'RETIRED' WHERE id = $1`, [set])).rowCount).toBe(1);
      expect((await tx.query(`UPDATE risk_question_sets SET status = 'PUBLISHED', published_by = $2, published_at = now() WHERE id = $1`, [v2, w.users.tenantAdmin.id])).rowCount).toBe(1);
    });
    await rejects(h.owner.query(`UPDATE risk_question_sets SET status = 'PUBLISHED' WHERE id = $1`, [set]), 'P0001', /immutable_record/);
    // Ağırlık > 0.
    const draft = (await one<{ id: string }>(`INSERT INTO risk_question_sets (tenant_id, code, version, name, created_by) VALUES ($1, $2, 1, 'Sentetik set', $3) RETURNING id`,
      [w.tenantA, `SET-${rand()}`, w.users.tenantAdmin.id])).id;
    await rejects(h.owner.query(`INSERT INTO risk_questions (tenant_id, set_id, ordinal, code, text, weight) VALUES ($1, $2, 1, 'Q1', 'Test sorusu 1', '0')`, [w.tenantA, draft]), '23514');
    // Taslak setle soru kaynaklı revizyon yazılmaz.
    const a = await assessment();
    await rejects(h.owner.query(`INSERT INTO risk_assessment_revisions (tenant_id, assessment_id, revision_no, criteria, criticality, criticality_column, question_set_id,
        score_source, risk_score, level, method_version, created_by)
      VALUES ($1, $2, 1, '{}', '1', 1, $3, 'QUESTIONS', '10', 1, 'v1', $4)`, [w.tenantA, a, draft, w.users.buyer.id]), 'P0001', /not_published/);
  });

  it('revision_is_insert_only_and_level_follows_matrix', async () => {
    const w = h.world;
    const a = await assessment();
    const r = await revision(a);
    // Kritiklik 6 hane saklanır (Ruling 2).
    expect((await one(`SELECT criticality::text AS c, level FROM risk_assessment_revisions WHERE id = $1`, [r]))).toEqual({ c: '3.224968', level: 2 });
    await withTenant(h.pool, all(), (tx) => rejects(tx.query(`UPDATE risk_assessment_revisions SET level = 1 WHERE id = $1`, [r]), '42501'));
    await withTenant(h.pool, all(), (tx) => rejects(tx.query(`DELETE FROM risk_assessment_revisions WHERE id = $1`, [r]), '42501'));
    await rejects(h.owner.query(`UPDATE risk_assessment_revisions SET score_note = 'x' WHERE id = $1`, [r]), 'P0001', /immutable_record/);
    await rejects(h.owner.query(`DELETE FROM risk_assessment_revisions WHERE id = $1`, [r]), 'P0001', /immutable_record/);
    // Aynı revizyon numarası ikinci kez yazılmaz; seviye matrisle çelişemez (Excel satır 54: skor 48, sütun 5 → seviye 4; satır 26: skor 20, sütun 4 → 2).
    await rejects(revision(a, { no: 1 }), '23505');
    await rejects(revision(a, { no: 2, score: '48.00', column: 5, level: 3 }), '23514');
    await rejects(revision(a, { no: 2, score: '20.00', column: 4, level: 3 }), '23514');
    await revision(a, { no: 2, score: '20.00', column: 4, level: 2 });
    await revision(a, { no: 3, score: '20.01', column: 4, level: 3 });
    await revision(a, { no: 4, score: '40.00', column: 1, level: 1 });
    // Uygulama rolü revizyon ekleyebilir (yalnız INSERT/SELECT).
    await withTenant(h.pool, all(), (tx) => tx.query(`INSERT INTO risk_assessment_revisions (tenant_id, assessment_id, revision_no, criteria, criticality, criticality_column,
        score_source, risk_score, level, method_version, created_by) VALUES ($1, $2, 5, '{}', '4.591930', 5, 'MANUAL_RESULT', '48.00', 4, 'v1', $3)`,
      [w.tenantA, a, w.users.buyer.id]));
  });

  it('one_assessment_per_supplier_and_year', async () => {
    const year = nextYear();
    await assessment({ year });
    await rejects(assessment({ year }), '23505');
    await rejects(assessment({ year, department: h.world.departments.bt }), '23505');
    // Başka yıl ya da başka tedarikçi serbest; değerlendirme silinmez; tedarikçi ve yıl uygulama rolünce değiştirilemez.
    const a = await assessment({ year: year + 50 });
    await assessment({ year, supplier: h.world.suppliers.s2 });
    await rejects(h.owner.query(`DELETE FROM risk_assessments WHERE id = $1`, [a]), 'P0001', /immutable_record/);
    await withTenant(h.pool, all(), (tx) => rejects(tx.query(`UPDATE risk_assessments SET year = year + 1 WHERE id = $1`, [a]), '42501'));
    await withTenant(h.pool, all(), (tx) => rejects(tx.query(`UPDATE risk_assessments SET supplier_id = $2 WHERE id = $1`, [a, h.world.suppliers.s2]), '42501'));
  });

  it('actions_control_method_and_close_once', async () => {
    const w = h.world;
    const a = await assessment();
    await rejects(h.owner.query(`INSERT INTO risk_actions (tenant_id, assessment_id, kind, title, created_by) VALUES ($1, $2, 'CONTROL', 'Yöntemsiz kontrol', $3)`,
      [w.tenantA, a, w.users.buyer.id]), '23514');
    await rejects(h.owner.query(`INSERT INTO risk_actions (tenant_id, assessment_id, kind, control_method, title, created_by) VALUES ($1, $2, 'MITIGATION', 'ON_SITE', 'Yöntemli aksiyon', $3)`,
      [w.tenantA, a, w.users.buyer.id]), '23514');
    const x = await action(a, { kind: 'CONTROL' });
    await withTenant(h.pool, all(), async (tx) => {
      expect((await tx.query(`UPDATE risk_actions SET status = 'DONE', completed_at = now(), completed_by = $2, completion_note = 'Kanıt incelendi' WHERE id = $1`,
        [x, w.users.buyer.id])).rowCount).toBe(1);
    });
    await withTenant(h.pool, all(), (tx) => rejects(tx.query(`UPDATE risk_actions SET title = 'Sonradan değişti' WHERE id = $1`, [x]), 'P0001', /immutable_record/));
    await withTenant(h.pool, all(), (tx) => rejects(tx.query(`UPDATE risk_actions SET status = 'OPEN', completed_at = NULL, completed_by = NULL WHERE id = $1`, [x]), 'P0001'));
    await withTenant(h.pool, all(), async (tx) => expect((await tx.query(`UPDATE risk_actions SET status = 'VERIFIED' WHERE id = $1`, [x])).rowCount).toBe(1));
    await withTenant(h.pool, all(), (tx) => rejects(tx.query(`UPDATE risk_actions SET status = 'CANCELLED' WHERE id = $1`, [x]), 'P0001', /immutable_record/));
    const y = await action(a);
    await withTenant(h.pool, all(), async (tx) => expect((await tx.query(`UPDATE risk_actions SET status = 'CANCELLED' WHERE id = $1`, [y])).rowCount).toBe(1));
    await withTenant(h.pool, all(), (tx) => rejects(tx.query(`UPDATE risk_actions SET status = 'OPEN' WHERE id = $1`, [y]), 'P0001', /immutable_record/));
    await withTenant(h.pool, all(), (tx) => rejects(tx.query(`UPDATE risk_actions SET kind = 'MITIGATION' WHERE id = $1`, [x]), '42501'));
    await withTenant(h.pool, all(), (tx) => rejects(tx.query(`DELETE FROM risk_actions WHERE id = $1`, [y]), '42501'));
    await rejects(h.owner.query(`DELETE FROM risk_actions WHERE id = $1`, [y]), 'P0001', /immutable_record/);
  });

  it('reviews_opinions_insert_only_one_review_per_period', async () => {
    const w = h.world;
    const a = await assessment();
    const r = await revision(a);
    await withTenant(h.pool, all(), async (tx) => {
      await tx.query(`INSERT INTO risk_reviews (tenant_id, assessment_id, period, outcome, decided_by) VALUES ($1, $2, '2031-2', 'NO_CHANGE', $3)`, [w.tenantA, a, w.users.buyer.id]);
      await tx.query(`INSERT INTO risk_reviews (tenant_id, assessment_id, period, outcome, revision_id, decided_by) VALUES ($1, $2, '2031-3', 'UPDATED', $3, $4)`, [w.tenantA, a, r, w.users.buyer.id]);
    });
    await withTenant(h.pool, all(), (tx) => rejects(tx.query(`INSERT INTO risk_reviews (tenant_id, assessment_id, period, outcome, decided_by) VALUES ($1, $2, '2031-2', 'NO_CHANGE', $3)`,
      [w.tenantA, a, w.users.buyer.id]), '23505'));
    await withTenant(h.pool, all(), (tx) => rejects(tx.query(`INSERT INTO risk_reviews (tenant_id, assessment_id, period, outcome, decided_by) VALUES ($1, $2, '2031-4', 'UPDATED', $3)`,
      [w.tenantA, a, w.users.buyer.id]), '23514'));
    await withTenant(h.pool, all(), (tx) => rejects(tx.query(`INSERT INTO risk_reviews (tenant_id, assessment_id, period, outcome, decided_by) VALUES ($1, $2, '2031-Q4', 'NO_CHANGE', $3)`,
      [w.tenantA, a, w.users.buyer.id]), '23514'));
    await withTenant(h.pool, all(), (tx) => rejects(tx.query(`UPDATE risk_reviews SET outcome = 'UPDATED' WHERE assessment_id = $1`, [a]), '42501'));
    await withTenant(h.pool, all(), (tx) => rejects(tx.query(`INSERT INTO risk_opinions (tenant_id, assessment_id, author_id, body) VALUES ($1, $2, $3, 'ab')`,
      [w.tenantA, a, w.users.buyer.id]), '23514'));
    await withTenant(h.pool, all(), (tx) => tx.query(`INSERT INTO risk_opinions (tenant_id, assessment_id, author_id, body) VALUES ($1, $2, $3, 'Satınalma görüşü (sentetik)')`,
      [w.tenantA, a, w.users.buyer.id]));
    await withTenant(h.pool, all(), (tx) => rejects(tx.query(`UPDATE risk_opinions SET body = 'değişti' WHERE assessment_id = $1`, [a]), '42501'));
    await rejects(h.owner.query(`UPDATE risk_opinions SET body = 'değişti' WHERE assessment_id = $1`, [a]), 'P0001', /immutable_record/);
    await rejects(h.owner.query(`DELETE FROM risk_reviews WHERE assessment_id = $1`, [a]), 'P0001', /immutable_record/);
    // Görüşün yazarı çağıranın kendisidir.
    await withTenant(h.pool, all(), (tx) => rejects(tx.query(`INSERT INTO risk_opinions (tenant_id, assessment_id, author_id, body) VALUES ($1, $2, $3, 'Başkası adına')`,
      [w.tenantA, a, w.users.legal.id]), '42501'));
  });

  it('import_batch_applied_once_and_frozen', async () => {
    const w = h.world;
    const sha = randomUUID().replace(/-/g, '').repeat(2);
    const mk = () => one<{ id: string }>(`INSERT INTO risk_import_batches (tenant_id, file_sha256, file_name, period, year, fraction_scale, uploaded_by)
      VALUES ($1, $2, 'risk.xlsx', '2026-1', 2026, true, $3) RETURNING id`, [w.tenantA, sha, w.users.buyer.id]);
    const b1 = (await mk()).id;
    const b2 = (await mk()).id; // aynı dosyanın ikinci önizlemesi serbest
    await h.owner.query(`INSERT INTO risk_import_rows (tenant_id, batch_id, row_no, raw, decision, primary_row) VALUES ($1, $2, 54, '{"A":"Sentetik Tedarik"}', 'CREATE', true)`, [w.tenantA, b1]);
    await withTenant(h.pool, all(), async (tx) => {
      expect((await tx.query(`UPDATE risk_import_rows SET decision = 'SKIP', issues = '{eslesme_yok}' WHERE batch_id = $1`, [b1])).rowCount).toBe(1);
      expect((await tx.query(`UPDATE risk_import_batches SET status = 'APPLIED', applied_by = $2, applied_at = now() WHERE id = $1`, [b1, w.users.buyer.id])).rowCount).toBe(1);
    });
    await withTenant(h.pool, all(), (tx) => rejects(tx.query(`UPDATE risk_import_batches SET status = 'APPLIED', applied_by = $2, applied_at = now() WHERE id = $1`,
      [b2, w.users.buyer.id]), '23505'));
    await withTenant(h.pool, all(), (tx) => rejects(tx.query(`UPDATE risk_import_batches SET summary = '{"x":1}' WHERE id = $1`, [b1]), 'P0001', /immutable_record/));
    await withTenant(h.pool, all(), (tx) => rejects(tx.query(`UPDATE risk_import_rows SET decision = 'CREATE' WHERE batch_id = $1`, [b1]), 'P0001', /immutable_record/));
    await withTenant(h.pool, all(), (tx) => rejects(tx.query(`UPDATE risk_import_rows SET raw = '{}' WHERE batch_id = $1`, [b1]), '42501'));
    await withTenant(h.pool, all(), (tx) => rejects(tx.query(`DELETE FROM risk_import_batches WHERE id = $1`, [b2]), '42501'));
    // İçe aktarım tabloları departman kullanıcısına kapalı.
    await withTenant(h.pool, dept([w.departments.bt]), async (tx) => {
      expect(await count(tx, `risk_import_batches WHERE id = $1`, [b1])).toBe(0);
      expect(await count(tx, `risk_import_rows WHERE batch_id = $1`, [b1])).toBe(0);
    });
  });
});

describe('053 seviye 4–5 tamamlanma güvencesi', () => {
  const complete = (a: string) => withTenant(h.pool, all(), (tx) => tx.query(
    `UPDATE risk_assessments SET status = 'COMPLETED', completed_at = now(), completed_by = $2 WHERE id = $1`, [a, h.world.users.buyer.id]));

  it('level_4_without_mitigation_and_control_never_completes', async () => {
    const a = await assessment();
    await rejects(complete(a), 'P0001', /revision_missing/);
    // Excel satır 54: kritiklik 4,59 → sütun 5, skor 48 → seviye 4.
    await revision(a, { score: '48.00', column: 5, level: 4 });
    await rejects(complete(a), 'P0001', /action_plan_required/);
    await action(a, { kind: 'MITIGATION' });
    await rejects(complete(a), 'P0001', /action_plan_required/);
    const c = await action(a, { kind: 'CONTROL' });
    await h.owner.query(`UPDATE risk_actions SET status = 'CANCELLED' WHERE id = $1`, [c]);
    await rejects(complete(a), 'P0001', /action_plan_required/);
    await action(a, { kind: 'CONTROL', status: 'DONE' });
    await complete(a);
    expect((await one(`SELECT status FROM risk_assessments WHERE id = $1`, [a])).status).toBe('COMPLETED');
    // Doğrudan COMPLETED eklenen (içe aktarım yolu) seviye 4 kaydı da aynı denetimden geçer.
    const client = await h.owner.connect();
    try {
      await client.query('BEGIN');
      const id = (await client.query(`INSERT INTO risk_assessments (tenant_id, supplier_id, year, department_id, status, source, completed_at, completed_by)
        VALUES ($1, $2, $3, $4, 'COMPLETED', 'IMPORT', now(), $5) RETURNING id`,
        [h.world.tenantA, h.world.suppliers.s1, nextYear(), h.world.departments.ik, h.world.users.buyer.id])).rows[0].id;
      await client.query(`INSERT INTO risk_assessment_revisions (tenant_id, assessment_id, revision_no, criteria, criticality, criticality_column, score_source,
        risk_score, level, method_version, created_by) VALUES ($1, $2, 1, '{}', '4.591930', 5, 'IMPORT', '48.00', 4, 'v1', $3)`, [h.world.tenantA, id, h.world.users.buyer.id]);
      await rejects(client.query('COMMIT'), 'P0001', /action_plan_required/);
    } finally {
      await client.query('ROLLBACK').catch(() => {});
      client.release();
    }
  });

  it('level_1_to_3_completes_without_actions', async () => {
    const a = await assessment();
    await revision(a, { score: '15.00', column: 3, level: 2 });
    await complete(a);
    // Yeniden açma (çeyreklik güncelleme) serbest; tamamlanmışken completed_* boş bırakılamaz.
    await withTenant(h.pool, all(), (tx) => tx.query(`UPDATE risk_assessments SET status = 'OPEN' WHERE id = $1`, [a]));
    await rejects(withTenant(h.pool, all(), (tx) => tx.query(`UPDATE risk_assessments SET status = 'COMPLETED', completed_at = NULL, completed_by = NULL WHERE id = $1`, [a])), '23514');
  });
});

describe('054 departman görünürlüğü ve katkıcı departman', () => {
  it('department_user_does_not_see_other_department', async () => {
    const w = h.world;
    const supplier = w.suppliers.s3;
    const a = await assessment({ supplier, department: w.departments.ik });
    await revision(a);
    await action(a);
    await h.owner.query(`INSERT INTO risk_opinions (tenant_id, assessment_id, department_id, author_id, body) VALUES ($1, $2, $3, $4, 'İK görüşü (sentetik)')`,
      [w.tenantA, a, w.departments.ik, w.users.buyer.id]);
    const sees = (deps: string[]) => withTenant(h.pool, dept(deps), async (tx) => ({
      assessment: await count(tx, `risk_assessments WHERE id = $1`, [a]),
      revisions: await count(tx, `risk_assessment_revisions WHERE assessment_id = $1`, [a]),
      actions: await count(tx, `risk_actions WHERE assessment_id = $1`, [a]),
      opinions: await count(tx, `risk_opinions WHERE assessment_id = $1`, [a]),
    }));
    expect(await sees([w.departments.bt])).toEqual({ assessment: 0, revisions: 0, actions: 0, opinions: 0 });
    expect(await sees([w.departments.ik])).toEqual({ assessment: 1, revisions: 1, actions: 1, opinions: 1 });
    await withTenant(h.pool, dept([w.departments.bt]), async (tx) => {
      expect((await tx.query(`UPDATE risk_assessments SET services = 'BT değiştirdi' WHERE id = $1`, [a])).rowCount).toBe(0);
    });
    await withTenant(h.pool, dept([w.departments.bt]), (tx) => rejects(tx.query(`INSERT INTO risk_opinions (tenant_id, assessment_id, department_id, author_id, body)
      VALUES ($1, $2, $3, $4, 'Yetkisiz görüş')`, [w.tenantA, a, w.departments.bt, w.users.techEval.id]), '42501'));
    // Departman kullanıcısı başka departmana değerlendirme açamaz ve kendi kaydını başka departmana taşıyamaz.
    await withTenant(h.pool, dept([w.departments.bt]), (tx) => rejects(tx.query(`INSERT INTO risk_assessments (tenant_id, supplier_id, year, department_id, source)
      VALUES ($1, $2, $3, $4, 'MANUAL')`, [w.tenantA, supplier, nextYear(), w.departments.ik]), '42501'));
    const own = await assessment({ supplier, department: w.departments.bt });
    await withTenant(h.pool, dept([w.departments.bt]), (tx) => rejects(tx.query(`UPDATE risk_assessments SET department_id = $2 WHERE id = $1`,
      [own, w.departments.ik]), '42501'));
    await withTenant(h.pool, dept([w.departments.bt]), async (tx) => {
      expect((await tx.query(`UPDATE risk_assessments SET services = 'BT güncelledi' WHERE id = $1`, [own])).rowCount).toBe(1);
      await tx.query(`INSERT INTO risk_actions (tenant_id, assessment_id, kind, title, created_by) VALUES ($1, $2, 'MITIGATION', 'BT aksiyonu (sentetik)', $3)`,
        [w.tenantA, own, w.users.techEval.id]);
    });
  });

  it('contributor_with_in_force_contract_reads_and_comments_but_cannot_edit', async () => {
    const w = h.world;
    const supplier = w.suppliers.s2;
    const a = await assessment({ supplier, department: w.departments.ik });
    await revision(a);
    await action(a);
    expect(await isContributor([w.departments.bt], a)).toBe(false);
    // Onaysız (taslak) ve süresi geçmiş BT sözleşmesi katkıcı yapmaz; başka tedarikçinin sözleşmesi de yapmaz.
    await contract({ department: w.departments.bt, supplier, approved: false });
    await contract({ department: w.departments.bt, supplier, endDate: '2020-12-31' });
    await contract({ department: w.departments.bt, supplier: w.suppliers.s1 });
    expect(await isContributor([w.departments.bt], a)).toBe(false);
    await withTenant(h.pool, dept([w.departments.bt]), async (tx) => expect(await count(tx, `risk_assessments WHERE id = $1`, [a])).toBe(0));
    // Onaylı ve süresi geçmemiş BT sözleşmesi: BT okur ve görüş ekler.
    const c = await contract({ department: w.departments.bt, supplier });
    expect(await isContributor([w.departments.bt], a)).toBe(true);
    expect(await isContributor([w.departments.tc], a)).toBe(false);
    await withTenant(h.pool, dept([w.departments.bt]), async (tx) => {
      expect(await count(tx, `risk_assessments WHERE id = $1`, [a])).toBe(1);
      expect(await count(tx, `risk_assessment_revisions WHERE assessment_id = $1`, [a])).toBe(1);
      expect(await count(tx, `risk_actions WHERE assessment_id = $1`, [a])).toBe(1);
      await tx.query(`INSERT INTO risk_opinions (tenant_id, assessment_id, department_id, author_id, body) VALUES ($1, $2, $3, $4, 'BT görüşü: erişim kapsamı geniş (sentetik)')`,
        [w.tenantA, a, w.departments.bt, w.users.techEval.id]);
      expect(await count(tx, `risk_opinions WHERE assessment_id = $1`, [a])).toBe(1);
      // Düzenleme ve tamamlama 0 satır.
      expect((await tx.query(`UPDATE risk_assessments SET draft = '{"criteria":{}}' WHERE id = $1`, [a])).rowCount).toBe(0);
      expect((await tx.query(`UPDATE risk_assessments SET status = 'COMPLETED', completed_at = now(), completed_by = $2 WHERE id = $1`, [a, w.users.techEval.id])).rowCount).toBe(0);
      expect((await tx.query(`UPDATE risk_actions SET title = 'BT değiştirdi' WHERE assessment_id = $1`, [a])).rowCount).toBe(0);
    });
    // Katkıcı aksiyon, revizyon, gözden geçirme yazamaz; görüşü başka departman adına yazamaz.
    const bt = () => dept([w.departments.bt]);
    await withTenant(h.pool, bt(), (tx) => rejects(tx.query(`INSERT INTO risk_actions (tenant_id, assessment_id, kind, title, created_by) VALUES ($1, $2, 'MITIGATION', 'Katkıcı aksiyonu', $3)`,
      [w.tenantA, a, w.users.techEval.id]), '42501'));
    await withTenant(h.pool, bt(), (tx) => rejects(tx.query(`INSERT INTO risk_reviews (tenant_id, assessment_id, period, outcome, decided_by) VALUES ($1, $2, '2032-2', 'NO_CHANGE', $3)`,
      [w.tenantA, a, w.users.techEval.id]), '42501'));
    await withTenant(h.pool, bt(), (tx) => rejects(tx.query(`INSERT INTO risk_assessment_revisions (tenant_id, assessment_id, revision_no, criteria, criticality, criticality_column,
        score_source, risk_score, level, method_version, created_by) VALUES ($1, $2, 9, '{}', '1', 1, 'MANUAL_RESULT', '10', 1, 'v1', $3)`, [w.tenantA, a, w.users.techEval.id]), '42501'));
    await withTenant(h.pool, bt(), (tx) => rejects(tx.query(`INSERT INTO risk_opinions (tenant_id, assessment_id, department_id, author_id, body) VALUES ($1, $2, $3, $4, 'İK adına görüş')`,
      [w.tenantA, a, w.departments.ik, w.users.techEval.id]), '42501'));
    expect((await one(`SELECT status, draft FROM risk_assessments WHERE id = $1`, [a]))).toEqual({ status: 'OPEN', draft: {} });
    // Onaydan sonra yeni koşul revizyonu (onay güncel içeriği kapsamıyor) → yürürlükte sayılmaz.
    await h.owner.query(`INSERT INTO contract_terms (tenant_id, company_id, contract_version_id, revision, currency, value_type, amount, start_date, end_date, source_ref, entered_by)
      VALUES ($1, $2, $3, 2, 'TRY', 'FIXED', '2000.00', '2026-01-01', '2099-12-31', 'Madde 1 rev 2 (sentetik)', $4)`, [w.tenantA, w.companyA1.id, c.cvId, w.users.buyer.id]);
    expect(await isContributor([w.departments.bt], a)).toBe(false);
  });

  it('legacy_contract_counts_as_in_force', async () => {
    const w = h.world;
    const a = await assessment({ supplier: w.suppliers.s1, department: w.departments.ik });
    await contract({ department: w.departments.tc, supplier: w.suppliers.s1, legacy: true, endDate: null });
    expect(await isContributor([w.departments.tc], a)).toBe(true);
    // Tedarikçi bağlamında ve kiracı B'de katkıcı yolu kapalı.
    await withTenant(h.pool, supplierCtx('supplier1', w.suppliers.s1), async (tx) =>
      expect((await tx.query(`SELECT app_is_risk_contributor($1) AS ok`, [a])).rows[0].ok).toBe(false));
    await withTenant(h.pool, tenantB(), async (tx) =>
      expect((await tx.query(`SELECT app_is_risk_contributor($1) AS ok`, [a])).rows[0].ok).toBe(false));
  });

  it('assessment_without_department_only_for_all_scope', async () => {
    const w = h.world;
    const a = await assessment({ supplier: w.suppliers.s1, department: null });
    // BT'nin s1 ile yürürlükte sözleşmesi olsa da departmansız kayıt katkıcıya açılmaz (D96).
    await contract({ department: w.departments.bt, supplier: w.suppliers.s1 });
    expect(await isContributor([w.departments.bt], a)).toBe(false);
    for (const who of ['buyer', 'tenantAdmin', 'auditor'] as const) {
      await withTenant(h.pool, all(who), async (tx) => expect(await count(tx, `risk_assessments WHERE id = $1`, [a]), who).toBe(1));
    }
    await withTenant(h.pool, dept([w.departments.bt, w.departments.ik, w.departments.tc]), async (tx) => {
      expect(await count(tx, `risk_assessments WHERE id = $1`, [a])).toBe(0);
      expect((await tx.query(`UPDATE risk_assessments SET department_id = $2 WHERE id = $1`, [a, w.departments.bt])).rowCount).toBe(0);
    });
    // Satınalma departman atar; artık BT görür.
    await withTenant(h.pool, all(), async (tx) => expect((await tx.query(`UPDATE risk_assessments SET department_id = $2 WHERE id = $1`, [a, w.departments.bt])).rowCount).toBe(1));
    await withTenant(h.pool, dept([w.departments.bt]), async (tx) => expect(await count(tx, `risk_assessments WHERE id = $1`, [a])).toBe(1));
  });

  it('task_department_derived_for_risk_assessment', async () => {
    const w = h.world;
    const a = await assessment({ department: w.departments.ik });
    const none = await assessment({ department: null });
    await withTenant(h.pool, all(), async (tx) => {
      const r = (await tx.query(`SELECT app_task_department('risk_assessment', $1) AS d, app_task_department('risk_assessment', $2) AS n,
        app_task_departmental('risk_assessment') AS dep, app_task_departmental('incident') AS inc`, [a, none])).rows[0];
      expect(r).toEqual({ d: w.departments.ik, n: null, dep: true, inc: false });
    });
    // Diğer dallar birebir (035): önceki tüm türler hâlâ çözülür.
    const def = (await one<{ d: string }>(`SELECT pg_get_functiondef('app_task_department(text, uuid)'::regprocedure) AS d`)).d;
    for (const t of ['project', 'rfq_round', 'award', 'evaluation', 'sourcing_exception', 'contract_family', 'contract_version', 'invoice', 'supplier_assessment', 'incident', 'risk_assessment']) {
      expect(def, t).toContain(`WHEN '${t}' THEN`);
    }
    // Görev satırı: departmanlı görev İK'ya, departmansız risk görevi yalnız tümünü görene.
    const task = async (entity: string, dep: string | null) => (await one<{ id: string }>(`INSERT INTO tasks (tenant_id, kind, entity_type, entity_id, title, reason, next_action,
        assignee_role, dedupe_key, department_id) VALUES ($1, 'risk_assessment_due', 'risk_assessment', $2, 'Yıllık risk değerlendirmesi', 'Sentetik', 'Doldurun',
        'DEPARTMENT_USER', $3, $4) RETURNING id`, [w.tenantA, entity, `risk:${entity}:${rand()}`, dep])).id;
    const t1 = await task(a, w.departments.ik);
    const t2 = await task(none, null);
    await withTenant(h.pool, dept([w.departments.ik]), async (tx) => {
      expect(await count(tx, `tasks WHERE id = $1`, [t1])).toBe(1);
      expect(await count(tx, `tasks WHERE id = $1`, [t2])).toBe(0);
    });
    await withTenant(h.pool, dept([w.departments.bt]), async (tx) => expect(await count(tx, `tasks WHERE id = ANY($1::uuid[])`, [[t1, t2]])).toBe(0));
    await withTenant(h.pool, all(), async (tx) => expect(await count(tx, `tasks WHERE id = ANY($1::uuid[])`, [[t1, t2]])).toBe(2));
  });
});
