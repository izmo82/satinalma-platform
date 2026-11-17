// v2 Faz 8 (D113): 058a ile ERP referansları kaynaklı ve UPDATE izinli; kaynaksız (058a öncesi/eski yol) referans değişmez kalır, ret artık izin hatası (42501) değil kaynak koruması (P0001).
// v2 Faz 7 (D112) Görev 2: 055/056 şeması — fatura eşleşme sütunları (auto_match 055 öncesi satırlarda false, yeni satırda true;
// ERP referansı ve auto_match yazıldıktan sonra değişmez), eşleşme olayları, proje "Tamamlandı" durumu, çıkar çatışması beyanı,
// uyum kanıtı, sürümlü kural setleri (yayımlı set ve kuralı değişmez), değişmez denetim koşusu ve kural sonuçları, elle işaret,
// yapay zekâ önbelleği. Her yeni tabloda kiracı RLS'i, tedarikçi bağlamı kapalı, BT departman kullanıcısı İK projesinin/faturasının
// kayıtlarını (ve kanıt belgesini) göremez. Tüm veri sentetiktir; demo faturalara (test veritabanında yoklar) dokunulmaz.
// v2 Faz 7 (D112) Görev 2 inceleme (056a): R1 artık veritabanında — bağ görünür aileye, proje ve departman ailenin aynısı olmalı;
// bu yüzden bağlama örneği ailenin projesini kullanır ve var olmayan aile FK'dan önce tetikleyicide (P0001) reddedilir. Yeni
// testler: departmanlar arası doğrudan SQL bağ, beyan yalnız kendi adına, elle LINK olayı yapanı ister, kural/yayımlama yarışı.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { withTenant, type TenantContext } from '../src/db.ts';
import { makeHarness } from './harness.ts';

let h: Awaited<ReturnType<typeof makeHarness>>;
const rand = () => randomUUID().slice(0, 8);

const all = (): TenantContext => ({ tenantId: h.world.tenantA, userId: h.world.users.buyer.id, roles: ['PROCUREMENT'],
  companyIds: [h.world.companyA1.id], departmentIds: [], allDepartments: true, correlationId: 'v2-compliance-schema' });
const dept = (deps: string[]): TenantContext => ({ tenantId: h.world.tenantA, userId: h.world.users.techEval.id,
  roles: ['DEPARTMENT_USER'], companyIds: [h.world.companyA1.id], departmentIds: deps, allDepartments: false, correlationId: 'v2-compliance-schema-d' });
const tenantB = (): TenantContext => ({ tenantId: h.world.tenantB, userId: h.world.users.buyerB.id, roles: ['PROCUREMENT'],
  companyIds: [h.world.companyB1.id], departmentIds: [], allDepartments: true, correlationId: 'v2-compliance-schema-b' });
const supplierCtx = (): TenantContext => ({ tenantId: h.world.tenantA, userId: h.world.users.supplier1.id, roles: ['SUPPLIER'],
  companyIds: [], departmentIds: [], allDepartments: false, supplierId: h.world.suppliers.s1, correlationId: 'v2-compliance-schema-s' });

async function rejects(p: Promise<unknown>, code: string, message?: RegExp) {
  const err = await p.then(() => null, (e: any) => e);
  expect(err, `beklenen hata ${code}`).not.toBeNull();
  expect(err.code, String(err?.message)).toBe(code);
  if (message) expect(err.message).toMatch(message);
}
const count = async (tx: pg.PoolClient, sql: string, params: unknown[] = []) =>
  (await tx.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${sql}`, params)).rows[0]!.n;
const one = async <T = any>(sql: string, params: unknown[] = []) => (await h.owner.query(sql, params)).rows[0] as T;

/** Sahip bağlantısıyla proje (varsayılan İK, DRAFT). */
async function project(o: { department?: string | null; status?: string } = {}) {
  const w = h.world;
  return (await one<{ id: string }>(`INSERT INTO projects (tenant_id, company_id, code, title, category, owner_user_id, created_by, department_id, status)
    VALUES ($1, $2, $3, 'Uyum şeması projesi (SENTETİK)', 'Genel', $4, $4, $5, $6) RETURNING id`,
    [w.tenantA, w.companyA1.id, `PRJ-UYM-${rand()}`, w.users.buyer.id, o.department === undefined ? w.departments.ik : o.department,
     o.status ?? 'DRAFT'])).id;
}
async function docVersion() {
  const w = h.world;
  const doc = (await one<{ id: string }>(`INSERT INTO documents (tenant_id, company_id, kind, title, created_by, code) VALUES ($1, $2, 'OTHER', $3, $4, $5) RETURNING id`,
    [w.tenantA, w.companyA1.id, `Kanıt ${rand()} (SENTETİK)`, w.users.buyer.id, `BLG-UYM-${rand()}`])).id;
  return (await one<{ id: string }>(`INSERT INTO document_versions (tenant_id, company_id, document_id, version_no, sha256, mime_type, size_bytes, storage_key,
      original_filename, basic_check_status, created_by)
    VALUES ($1, $2, $3, 1, $4, 'application/pdf', 100, $5, 'kanit.pdf', 'PASSED', $6) RETURNING id`,
    [w.tenantA, w.companyA1.id, doc, randomUUID().replaceAll('-', '').padEnd(64, '0'), `tenant/${randomUUID()}`, w.users.buyer.id])).id;
}
async function family(department: string | null, projectId: string | null = null) {
  const w = h.world;
  return (await one<{ id: string }>(`INSERT INTO contract_families (tenant_id, company_id, title, supplier_id, created_by, code, department_id, project_id)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
    [w.tenantA, w.companyA1.id, `Uyum sözleşmesi ${rand()} (SENTETİK)`, w.suppliers.s1, w.users.buyer.id, `SZL-UYM-${rand()}`, department, projectId])).id;
}
/** Sahip bağlantısıyla sentetik yeni fatura (auto_match varsayılanla). */
async function invoice(department: string | null) {
  const w = h.world;
  return (await one<{ id: string; auto_match: boolean }>(`INSERT INTO invoices (tenant_id, company_id, supplier_id, kind, invoice_no, issue_date, currency,
      created_by, department_id, erp_contract_ref, erp_order_ref)
    VALUES ($1, $2, $3, 'INVOICE', $4, '2026-11-17', 'TRY', $5, $6, 'SZL-REF-1', 'SIP-REF-1') RETURNING id, auto_match`,
    [w.tenantA, w.companyA1.id, w.suppliers.s1, `SNT${rand()}`, w.users.buyer.id, department]));
}
/** Kiracının açık taslağı (kiracı başına tek) ya da yeni taslak. */
async function draftSetId() {
  const d = await one<{ id: string } | undefined>(`SELECT id FROM procurement_rule_sets WHERE tenant_id = $1 AND status = 'DRAFT'`, [h.world.tenantA]);
  return d ? d.id : (await ruleSet({ publish: false })).set;
}
/** Taslak set + kurallar; publish ise yayımlanır. */
async function ruleSet(o: { publish?: boolean; tenant?: string } = {}) {
  const w = h.world;
  const tenant = o.tenant ?? w.tenantA;
  const by = tenant === w.tenantA ? w.users.tenantAdmin.id : w.users.buyerB.id;
  const n = (await one<{ n: number }>(`SELECT coalesce(max(version_no), 0) + 1 AS n FROM procurement_rule_sets WHERE tenant_id = $1`, [tenant])).n;
  const set = (await one<{ id: string }>(`INSERT INTO procurement_rule_sets (tenant_id, version_no, created_by) VALUES ($1, $2, $3) RETURNING id`, [tenant, n, by])).id;
  const rule = (await one<{ id: string }>(`INSERT INTO procurement_rules (tenant_id, rule_set_id, code, name, check_type, check_key, params, scope_methods, weight, mandatory, sort_order)
    VALUES ($1, $2, 'K01', 'En az teklif alınmış', 'DATA', 'MIN_BIDS', '{"minBids":3}', '{INVITED_BIDS}', 15, true, 1) RETURNING id`, [tenant, set])).id;
  const manual = (await one<{ id: string }>(`INSERT INTO procurement_rules (tenant_id, rule_set_id, code, name, check_type, weight, sort_order)
    VALUES ($1, $2, 'K14', 'Kuruma özel kural (elle)', 'MANUAL', 5, 14) RETURNING id`, [tenant, set])).id;
  if (o.publish !== false) await publish(set);
  return { set, rule, manual };
}
async function publish(setId: string) {
  await h.owner.query(`UPDATE procurement_rule_sets SET status = 'PUBLISHED', effective_from = '2026-01-01', published_by = created_by, published_at = now() WHERE id = $1`, [setId]);
}
async function audit(projectId: string, setId: string | null, runNo = 1) {
  const w = h.world;
  return (await one<{ id: string }>(`INSERT INTO compliance_audits (tenant_id, company_id, project_id, run_no, rule_set_id, trigger, status, score, verdict, summary,
      summary_source, ai_provider, ai_provider_is_test, run_by)
    VALUES ($1, $2, $3, $4, $5, 'COMPLETED', $6, $7, $8, 'Otomatik özet (sentetik)', 'AUTO', $9, $10, $11) RETURNING id`,
    [w.tenantA, w.companyA1.id, projectId, runNo, setId, setId ? 'DONE' : 'NO_RULESET', setId ? 75 : null, setId ? 'NONCOMPLIANT' : null,
     setId ? 'Test sağlayıcısı — gerçek değil' : null, Boolean(setId), w.users.buyer.id])).id;
}

beforeAll(async () => {
  h = await makeHarness();
  // techEval yalnız BT departmanında (İK değil).
  await h.owner.query(`UPDATE memberships SET department_ids = $3 WHERE tenant_id = $1 AND user_id = $2`,
    [h.world.tenantA, h.world.users.techEval.id, [h.world.departments.bt]]);
});
afterAll(async () => { await h.close(); });

describe('055 fatura eşleşmesi', () => {
  it('auto_match_false_for_pre_055_rows_true_for_new', async () => {
    // 055 öncesi satırlar: sütun DEFAULT false ile eklendi (satır yeniden yazılmadan "eksik değer" false okunur), varsayılan sonra true.
    const meta = await one<{ atthasmissing: boolean; attmissingval: string; def: string; notnull: boolean }>(
      `SELECT a.atthasmissing, a.attmissingval::text, pg_get_expr(d.adbin, d.adrelid) AS def, a.attnotnull AS notnull
       FROM pg_attribute a JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
       WHERE a.attrelid = 'invoices'::regclass AND a.attname = 'auto_match'`);
    expect(meta).toEqual({ atthasmissing: true, attmissingval: '{f}', def: 'true', notnull: true });
    // Yeni açılan fatura otomatik eşleştirmeye açıktır.
    const inv = await invoice(h.world.departments.ik);
    expect(inv.auto_match).toBe(true);
    // Dev veritabanındaki 055 öncesi faturalar (demo ANB2026000101, ANB2026000102, EGE2026000877) false okunur: dev migrate sonrası elle doğrulanır.
  });

  it('match_columns_updatable_refs_and_auto_match_insert_only', async () => {
    const w = h.world;
    const inv = await invoice(w.departments.ik);
    const proj = await project();
    const fam = await family(w.departments.ik, proj);
    await withTenant(h.pool, all(), async (tx) => {
      const r = await tx.query(`UPDATE invoices SET contract_family_id = $2, project_id = $3, match_method = 'MANUAL', match_note = 'Elle bağlandı (sentetik)',
        matched_by = $4, matched_at = now() WHERE id = $1`, [inv.id, fam, proj, w.users.buyer.id]);
      expect(r.rowCount).toBe(1);
    });
    await withTenant(h.pool, all(), (tx) => rejects(tx.query(`UPDATE invoices SET auto_match = false WHERE id = $1`, [inv.id]), '42501'));
    await withTenant(h.pool, all(), (tx) => rejects(tx.query(`UPDATE invoices SET erp_contract_ref = 'BAŞKA' WHERE id = $1`, [inv.id]), 'P0001', /erp_source_conflict/));
    await withTenant(h.pool, all(), (tx) => rejects(tx.query(`UPDATE invoices SET erp_order_ref = 'BAŞKA' WHERE id = $1`, [inv.id]), 'P0001', /erp_source_conflict/));
    // Biçim: bağ yöntemsiz olamaz; elle bağın yapanı bilinir; bağsız faturada proje olmaz; bilinmeyen yöntem; referans ≤ 60.
    const inv2 = await invoice(w.departments.ik);
    await withTenant(h.pool, all(), (tx) => rejects(tx.query(`UPDATE invoices SET contract_family_id = $2, project_id = $3, matched_at = now() WHERE id = $1`, [inv2.id, fam, proj]), '23514'));
    await withTenant(h.pool, all(), (tx) => rejects(tx.query(`UPDATE invoices SET contract_family_id = $2, project_id = $3, match_method = 'MANUAL', matched_at = now() WHERE id = $1`, [inv2.id, fam, proj]), '23514'));
    await withTenant(h.pool, all(), (tx) => rejects(tx.query(`UPDATE invoices SET project_id = $2 WHERE id = $1`, [inv2.id, proj]), '23514'));
    await withTenant(h.pool, all(), (tx) => rejects(tx.query(`UPDATE invoices SET contract_family_id = $2, project_id = $3, match_method = 'GUESS', matched_at = now() WHERE id = $1`, [inv2.id, fam, proj]), '23514'));
    await rejects(h.owner.query(`INSERT INTO invoices (tenant_id, company_id, supplier_id, kind, invoice_no, issue_date, currency, created_by, erp_order_ref)
      VALUES ($1, $2, $3, 'INVOICE', $4, '2026-11-17', 'TRY', $5, $6)`, [w.tenantA, w.companyA1.id, w.suppliers.s1, `SNT${rand()}`, w.users.buyer.id, 'X'.repeat(61)]), '23514');
    // Otomatik bağ (yapan yok) geçerli; bağ kaldırma tüm sütunları boşaltır.
    await withTenant(h.pool, all(), async (tx) => {
      expect((await tx.query(`UPDATE invoices SET contract_family_id = $2, project_id = $3, match_method = 'SUPPLIER_DATE', matched_at = now() WHERE id = $1`, [inv2.id, fam, proj])).rowCount).toBe(1);
      expect((await tx.query(`UPDATE invoices SET contract_family_id = NULL, project_id = NULL, match_method = NULL, matched_by = NULL, matched_at = NULL WHERE id = $1`, [inv2.id])).rowCount).toBe(1);
    });
    // Var olmayan (ya da başka kiracının) sözleşmesine bağ kurulamaz (056a tetikleyicisi; ayrıca kiracı-bileşik FK).
    await rejects(h.owner.query(`UPDATE invoices SET contract_family_id = $2, match_method = 'SUPPLIER_DATE', matched_at = now() WHERE id = $1`, [inv2.id, randomUUID()]),
      'P0001', /contract_not_visible/);
  });

  it('r1_link_requires_visible_family_same_project_and_department', async () => {
    const w = h.world;
    const ikProj = await project();
    const ikFam = await family(w.departments.ik, ikProj);
    const btProj = await project({ department: w.departments.bt });
    const btFam = await family(w.departments.bt, btProj);
    const link = (invId: string, fam: string, proj: string | null) => (tx: pg.PoolClient) => tx.query(
      `UPDATE invoices SET contract_family_id = $2, project_id = $3, match_method = 'MANUAL', matched_by = app_user_id(), matched_at = now() WHERE id = $1`, [invId, fam, proj]);
    // BT kullanıcısı doğrudan SQL ile kendi (BT) faturasını İK sözleşmesine bağlayamaz (aile RLS'le görünmez).
    const btInv = await invoice(w.departments.bt);
    await withTenant(h.pool, dept([w.departments.bt]), (tx) => rejects(link(btInv.id, ikFam, ikProj)(tx), 'P0001', /contract_not_visible/));
    // Departmanı İK'ya çevirip bağlamayı denemek de olmaz (fatura departman kapsamından çıkar).
    await withTenant(h.pool, dept([w.departments.bt]), (tx) => rejects(tx.query(
      `UPDATE invoices SET department_id = $2, contract_family_id = $3, project_id = $4, match_method = 'MANUAL', matched_by = app_user_id(), matched_at = now() WHERE id = $1`,
      [btInv.id, w.departments.ik, ikFam, ikProj]), 'P0001'));
    // Kendi departmanındaki sözleşmeye bağlar.
    await withTenant(h.pool, dept([w.departments.bt]), async (tx) => expect((await link(btInv.id, btFam, btProj)(tx)).rowCount).toBe(1));
    // Tüm departmanı gören (işçi/Satınalma) bile: proje ailenin projesi, departman ailenin departmanı olmalı.
    const ikInv = await invoice(w.departments.ik);
    await withTenant(h.pool, all(), (tx) => rejects(link(ikInv.id, ikFam, btProj)(tx), 'P0001', /project_mismatch/));
    await withTenant(h.pool, all(), (tx) => rejects(link(ikInv.id, ikFam, null)(tx), 'P0001', /project_mismatch/));
    await withTenant(h.pool, all(), (tx) => rejects(link(ikInv.id, btFam, btProj)(tx), 'P0001', /department_mismatch/));
    // Departman devriyle birlikte bağ (R1/§2.3): aynı ifadede departman ailenin departmanına çekilir.
    await withTenant(h.pool, all(), async (tx) => expect((await tx.query(
      `UPDATE invoices SET department_id = $2, contract_family_id = $3, project_id = $4, match_method = 'SUPPLIER_DATE', matched_at = now() WHERE id = $1`,
      [ikInv.id, w.departments.bt, btFam, btProj])).rowCount).toBe(1));
    // Bağlı faturanın departmanı aileden ayrılamaz; bağ kaldırılınca serbest.
    await withTenant(h.pool, all(), (tx) => rejects(tx.query(`UPDATE invoices SET department_id = $2 WHERE id = $1`, [ikInv.id, w.departments.ik]), 'P0001', /department_mismatch/));
    await withTenant(h.pool, all(), async (tx) => {
      await tx.query(`UPDATE invoices SET contract_family_id = NULL, project_id = NULL, match_method = NULL, matched_by = NULL, matched_at = NULL WHERE id = $1`, [ikInv.id]);
      expect((await tx.query(`UPDATE invoices SET department_id = $2 WHERE id = $1`, [ikInv.id, w.departments.ik])).rowCount).toBe(1);
    });
    // Projesiz ve departmansız aile: fatura da projesiz ve departmansız olmalı; bağsız faturada (eski yollar) tetikleyici devreye girmez.
    const bare = await family(null);
    const plain = await invoice(null);
    await withTenant(h.pool, all(), async (tx) => {
      expect((await tx.query(`UPDATE invoices SET contract_family_id = $2, match_method = 'ERP_REF', matched_at = now() WHERE id = $1`, [plain.id, bare])).rowCount).toBe(1);
    });
    const loose = await invoice(null);
    await withTenant(h.pool, all(), async (tx) => expect((await tx.query(`UPDATE invoices SET department_id = $2 WHERE id = $1`, [loose.id, w.departments.ik])).rowCount).toBe(1));
  });

  it('match_events_insert_only_tenant_and_department_scoped', async () => {
    const w = h.world;
    const inv = await invoice(w.departments.ik);
    const fam = await family(w.departments.ik);
    const ev = await withTenant(h.pool, all(), async (tx) => (await tx.query<{ id: string }>(`INSERT INTO invoice_match_events (tenant_id, company_id, invoice_id, action, family_id, method, actor)
      VALUES ($1, $2, $3, 'LINK', $4, 'MANUAL', $5) RETURNING id`, [w.tenantA, w.companyA1.id, inv.id, fam, w.users.buyer.id])).rows[0]!.id);
    // Elle bağlama olayı yapanı ister (056a); otomatik bağ olayı yapansız olabilir.
    await withTenant(h.pool, all(), (tx) => rejects(tx.query(`INSERT INTO invoice_match_events (tenant_id, company_id, invoice_id, action, family_id, method)
      VALUES ($1, $2, $3, 'LINK', $4, 'MANUAL')`, [w.tenantA, w.companyA1.id, inv.id, fam]), '23514'));
    await withTenant(h.pool, all(), async (tx) => expect((await tx.query(`INSERT INTO invoice_match_events (tenant_id, company_id, invoice_id, action, family_id, method)
      VALUES ($1, $2, $3, 'LINK', $4, 'ERP_REF')`, [w.tenantA, w.companyA1.id, inv.id, fam])).rowCount).toBe(1));
    // Gerekçesiz (ya da 10 karakterden kısa) bağ kaldırma reddedilir; başarısız otomatik eşleşme nedeni zorunlu.
    await withTenant(h.pool, all(), (tx) => rejects(tx.query(`INSERT INTO invoice_match_events (tenant_id, company_id, invoice_id, action, family_id, reason, actor)
      VALUES ($1, $2, $3, 'UNLINK', $4, 'kısa', $5)`, [w.tenantA, w.companyA1.id, inv.id, fam, w.users.buyer.id]), '23514'));
    await withTenant(h.pool, all(), (tx) => rejects(tx.query(`INSERT INTO invoice_match_events (tenant_id, company_id, invoice_id, action)
      VALUES ($1, $2, $3, 'AUTO_FAILED')`, [w.tenantA, w.companyA1.id, inv.id]), '23514'));
    await withTenant(h.pool, all(), (tx) => rejects(tx.query(`UPDATE invoice_match_events SET reason = 'değişti' WHERE id = $1`, [ev]), '42501'));
    await withTenant(h.pool, all(), (tx) => rejects(tx.query(`DELETE FROM invoice_match_events WHERE id = $1`, [ev]), '42501'));
    await rejects(h.owner.query(`UPDATE invoice_match_events SET reason = 'değişti' WHERE id = $1`, [ev]), 'P0001', /immutable_record/);
    await rejects(h.owner.query(`DELETE FROM invoice_match_events WHERE id = $1`, [ev]), 'P0001', /immutable_record/);
    // BT kullanıcısı İK faturasının olayını görmez ve yazamaz; kendi (BT) faturasınınkini yazar.
    await withTenant(h.pool, dept([w.departments.bt]), async (tx) => expect(await count(tx, `invoice_match_events WHERE id = $1`, [ev])).toBe(0));
    await withTenant(h.pool, dept([w.departments.bt]), (tx) => rejects(tx.query(`INSERT INTO invoice_match_events (tenant_id, company_id, invoice_id, action, reason)
      VALUES ($1, $2, $3, 'AUTO_FAILED', 'no_candidate')`, [w.tenantA, w.companyA1.id, inv.id]), '42501'));
    const btInv = await invoice(w.departments.bt);
    await withTenant(h.pool, dept([w.departments.bt]), async (tx) => {
      expect((await tx.query(`INSERT INTO invoice_match_events (tenant_id, company_id, invoice_id, action, reason) VALUES ($1, $2, $3, 'AUTO_FAILED', 'no_candidate')`,
        [w.tenantA, w.companyA1.id, btInv.id])).rowCount).toBe(1);
    });
    // Olaydaki aile yazarken görünür olmalı (056a): BT kullanıcısı kendi faturasının olayına İK ailesini yazamaz.
    await withTenant(h.pool, dept([w.departments.bt]), (tx) => rejects(tx.query(`INSERT INTO invoice_match_events (tenant_id, company_id, invoice_id, action, family_id, method, actor)
      VALUES ($1, $2, $3, 'LINK', $4, 'MANUAL', $5)`, [w.tenantA, w.companyA1.id, btInv.id, fam, w.users.techEval.id]), '42501'));
    await withTenant(h.pool, dept([w.departments.ik]), async (tx) => expect(await count(tx, `invoice_match_events WHERE id = $1`, [ev])).toBe(1));
  });
});

describe('055 proje tamamlama', () => {
  it('completed_status_writable_and_old_statuses_valid', async () => {
    const w = h.world;
    for (const s of ['DRAFT', 'IN_APPROVAL', 'OPEN', 'EVALUATION', 'AWARD_APPROVAL', 'CONTRACTING', 'CANCELLED', 'NO_AWARD']) {
      expect(await project({ status: s }), s).toBeTruthy();
    }
    await rejects(project({ status: 'FINISHED' }), '23514');
    const p = await project({ status: 'CONTRACTING' });
    await withTenant(h.pool, all(), async (tx) => {
      expect((await tx.query(`UPDATE projects SET status = 'COMPLETED', completed_on = '2026-11-17', completed_by = $2 WHERE id = $1`, [p, w.users.buyer.id])).rowCount).toBe(1);
    });
    expect(await one(`SELECT status, completed_on::text AS on, completed_by FROM projects WHERE id = $1`, [p]))
      .toEqual({ status: 'COMPLETED', on: '2026-11-17', completed_by: w.users.buyer.id });
    // Tamamlanma günü ve yapan birlikte; COMPLETED günsüz olamaz.
    const q = await project({ status: 'CONTRACTING' });
    await withTenant(h.pool, all(), (tx) => rejects(tx.query(`UPDATE projects SET status = 'COMPLETED' WHERE id = $1`, [q]), '23514'));
    await withTenant(h.pool, all(), (tx) => rejects(tx.query(`UPDATE projects SET completed_on = '2026-11-17' WHERE id = $1`, [q]), '23514'));
  });
});

describe('055 beyan ve kanıt', () => {
  it('declaration_and_evidence_insert_only_and_shape', async () => {
    const w = h.world;
    const p = await project();
    const dv = await docVersion();
    const ids = await withTenant(h.pool, all(), async (tx) => ({
      coi: (await tx.query<{ id: string }>(`INSERT INTO coi_declarations (tenant_id, company_id, project_id, user_id, kind) VALUES ($1, $2, $3, $4, 'NONE') RETURNING id`,
        [w.tenantA, w.companyA1.id, p, w.users.buyer.id])).rows[0]!.id,
      ev: (await tx.query<{ id: string }>(`INSERT INTO compliance_evidence (tenant_id, company_id, project_id, check_key, document_version_id, kind, uploaded_by)
        VALUES ($1, $2, $3, 'WINNER_RESEARCH', $4, 'RESEARCH', $5) RETURNING id`, [w.tenantA, w.companyA1.id, p, dv, w.users.buyer.id])).rows[0]!.id,
    }));
    // DECLARED açıklama ister (≥ 10); bilinmeyen tür reddedilir; şirket projeninkiyle aynı olmalı.
    await withTenant(h.pool, all(), (tx) => rejects(tx.query(`INSERT INTO coi_declarations (tenant_id, company_id, project_id, user_id, kind, statement)
      VALUES ($1, $2, $3, $4, 'DECLARED', 'kısa')`, [w.tenantA, w.companyA1.id, p, w.users.buyer.id]), '23514'));
    await withTenant(h.pool, all(), (tx) => rejects(tx.query(`INSERT INTO compliance_evidence (tenant_id, company_id, project_id, check_key, document_version_id, kind, uploaded_by)
      VALUES ($1, $2, $3, 'WINNER_RESEARCH', $4, 'PHOTO', $5)`, [w.tenantA, w.companyA1.id, p, dv, w.users.buyer.id]), '23514'));
    const both = { ...all(), companyIds: [w.companyA1.id, w.companyA2.id] };
    await withTenant(h.pool, both, (tx) => rejects(tx.query(`INSERT INTO coi_declarations (tenant_id, company_id, project_id, user_id, kind)
      VALUES ($1, $2, $3, $4, 'NONE')`, [w.tenantA, w.companyA2.id, p, w.users.buyer.id]), '42501'));
    // Değişmez: uygulamada UPDATE/DELETE izni yok, sahipte tetikleyici.
    for (const [t, id] of [['coi_declarations', ids.coi], ['compliance_evidence', ids.ev]] as const) {
      await withTenant(h.pool, all(), (tx) => rejects(tx.query(`UPDATE ${t} SET tenant_id = tenant_id WHERE id = $1`, [id]), '42501'));
      await withTenant(h.pool, all(), (tx) => rejects(tx.query(`DELETE FROM ${t} WHERE id = $1`, [id]), '42501'));
      await rejects(h.owner.query(`UPDATE ${t} SET tenant_id = tenant_id WHERE id = $1`, [id]), 'P0001', /immutable_record/);
      await rejects(h.owner.query(`DELETE FROM ${t} WHERE id = $1`, [id]), 'P0001', /immutable_record/);
    }
    // Beyan yalnız oturum kullanıcısının kendi adına (056a): Satınalma başkası adına beyan yazamaz.
    await withTenant(h.pool, all(), (tx) => rejects(tx.query(`INSERT INTO coi_declarations (tenant_id, company_id, project_id, user_id, kind)
      VALUES ($1, $2, $3, $4, 'NONE')`, [w.tenantA, w.companyA1.id, p, w.users.techEval.id]), '42501'));
    // İkinci beyan eklenir (son geçerli).
    await withTenant(h.pool, all(), async (tx) => {
      await tx.query(`INSERT INTO coi_declarations (tenant_id, company_id, project_id, user_id, kind, statement) VALUES ($1, $2, $3, $4, 'DECLARED', 'Tedarikçide akrabam çalışıyor (sentetik)')`,
        [w.tenantA, w.companyA1.id, p, w.users.buyer.id]);
      expect(await count(tx, `coi_declarations WHERE project_id = $1`, [p])).toBe(2);
    });
  });
});

describe('056 kural setleri', () => {
  it('published_set_and_its_rules_are_immutable', async () => {
    const w = h.world;
    const { set, rule } = await ruleSet();
    for (const sql of [`UPDATE procurement_rules SET weight = 20 WHERE id = $1`, `DELETE FROM procurement_rules WHERE id = $1`]) {
      await withTenant(h.pool, all(), (tx) => rejects(tx.query(sql, [rule]), 'P0001', /immutable_record/));
      await rejects(h.owner.query(sql, [rule]), 'P0001', /immutable_record/);
    }
    await rejects(h.owner.query(`INSERT INTO procurement_rules (tenant_id, rule_set_id, code, name, check_type, weight) VALUES ($1, $2, 'K99', 'Sonradan', 'MANUAL', 5)`,
      [w.tenantA, set]), 'P0001', /immutable_record/);
    await withTenant(h.pool, all(), (tx) => rejects(tx.query(`UPDATE procurement_rule_sets SET effective_from = '2027-01-01' WHERE id = $1`, [set]), 'P0001', /immutable_record/));
    await withTenant(h.pool, all(), (tx) => rejects(tx.query(`UPDATE procurement_rule_sets SET status = 'DRAFT', published_at = NULL, published_by = NULL WHERE id = $1`, [set]), 'P0001', /immutable_record/));
    await withTenant(h.pool, all(), (tx) => rejects(tx.query(`DELETE FROM procurement_rule_sets WHERE id = $1`, [set]), '42501'));
    await rejects(h.owner.query(`DELETE FROM procurement_rule_sets WHERE id = $1`, [set]), 'P0001', /immutable_record/);
  });

  it('rule_write_and_publish_do_not_race', async () => {
    // İki bağlantı (056a FOR SHARE): taslağa kural ekleyen işlem açıkken yayımlama bekler; yayımlama açıkken kural ekleme bekler ve
    // yayımlama işlenince reddedilir. Bekleme lock_timeout ile (55P03) gözlenir.
    const w = h.world;
    const set = await draftSetId();
    const c1 = await h.owner.connect();
    const c2 = await h.owner.connect();
    try {
      await c1.query('BEGIN');
      await c1.query(`INSERT INTO procurement_rules (tenant_id, rule_set_id, code, name, check_type, weight) VALUES ($1, $2, $3, 'Yarış kuralı', 'MANUAL', 5)`, [w.tenantA, set, `R${rand()}`]);
      await c2.query('BEGIN');
      await c2.query(`SET LOCAL lock_timeout = '300ms'`);
      await rejects(c2.query(`UPDATE procurement_rule_sets SET status = 'PUBLISHED', effective_from = '2026-01-01', published_by = created_by, published_at = now() WHERE id = $1`, [set]), '55P03');
      await c2.query('ROLLBACK');
      await c1.query('COMMIT');
      // Ters yön: yayımlama açık, kural ekleme bekler; yayımlama işlenince bekleyen ekleme yayımlı seti görür.
      await c2.query('BEGIN');
      await c2.query(`UPDATE procurement_rule_sets SET status = 'PUBLISHED', effective_from = '2026-01-01', published_by = created_by, published_at = now() WHERE id = $1`, [set]);
      await c1.query('BEGIN');
      await c1.query(`SET LOCAL lock_timeout = '300ms'`);
      await rejects(c1.query(`INSERT INTO procurement_rules (tenant_id, rule_set_id, code, name, check_type, weight) VALUES ($1, $2, $3, 'Geç kural', 'MANUAL', 5)`, [w.tenantA, set, `R${rand()}`]), '55P03');
      await c1.query('ROLLBACK');
      const late = c1.query(`INSERT INTO procurement_rules (tenant_id, rule_set_id, code, name, check_type, weight) VALUES ($1, $2, $3, 'Geç kural', 'MANUAL', 5)`, [w.tenantA, set, `R${rand()}`])
        .then(() => null, (e: any) => e);
      await new Promise((r) => setTimeout(r, 100));
      await c2.query('COMMIT');
      const err = await late;
      expect(err?.code).toBe('P0001');
      expect(err?.message).toMatch(/immutable_record: procurement_rules \(set PUBLISHED\)/);
    } finally {
      await c1.query('ROLLBACK').catch(() => {});
      await c2.query('ROLLBACK').catch(() => {});
      c1.release();
      c2.release();
    }
  });

  it('draft_rules_editable_one_draft_per_tenant_and_rule_shape', async () => {
    const w = h.world;
    const { set, rule, manual } = await ruleSet({ publish: false });
    await withTenant(h.pool, all(), async (tx) => {
      expect((await tx.query(`UPDATE procurement_rules SET weight = 20, params = '{"minBids":4}' WHERE id = $1`, [rule])).rowCount).toBe(1);
      expect((await tx.query(`DELETE FROM procurement_rules WHERE id = $1`, [manual])).rowCount).toBe(1);
    });
    // Kiracı başına tek açık taslak.
    await rejects(h.owner.query(`INSERT INTO procurement_rule_sets (tenant_id, version_no, created_by) VALUES ($1, 9999, $2)`, [w.tenantA, w.users.tenantAdmin.id]), '23505');
    // Ağırlık 1–100; MANUAL anahtarsız/parametresiz; DATA anahtarlı; yöntem kataloğu; eşik para birimiyle; kod set içinde tekil.
    const bad = [
      `('K20', 'x', 'MANUAL', NULL, '{}', '{}', NULL, NULL, 0)`, `('K21', 'x', 'MANUAL', NULL, '{}', '{}', NULL, NULL, 101)`,
      `('K22', 'x', 'MANUAL', 'MIN_BIDS', '{}', '{}', NULL, NULL, 5)`, `('K23', 'x', 'MANUAL', NULL, '{"a":1}', '{}', NULL, NULL, 5)`,
      `('K24', 'x', 'DATA', NULL, '{}', '{}', NULL, NULL, 5)`, `('K25', 'x', 'DATA', 'MIN_BIDS', '{}', '{OPEN_TENDER}', NULL, NULL, 5)`,
      `('K26', 'x', 'DATA', 'MIN_BIDS', '{}', '{}', 1000, NULL, 5)`, `('K27', 'x', 'DATA', 'MIN_BIDS', '{}', '{}', -1, 'TRY', 5)`,
      `('K28', 'x', 'OTHER', NULL, '{}', '{}', NULL, NULL, 5)`,
    ];
    for (const v of bad) {
      await rejects(h.owner.query(`INSERT INTO procurement_rules (tenant_id, rule_set_id, code, name, check_type, check_key, params, scope_methods, min_amount, min_amount_currency, weight)
        VALUES ($1, $2, ${v.slice(1, -1)})`, [w.tenantA, set]), '23514');
    }
    await rejects(h.owner.query(`INSERT INTO procurement_rules (tenant_id, rule_set_id, code, name, check_type, check_key, params, weight)
      VALUES ($1, $2, 'K01', 'Yinelenen kod', 'DATA', 'MIN_BIDS', '{"minBids":3}', 5)`, [w.tenantA, set]), '23505');
    // Yayımlama: DRAFT → PUBLISHED (yürürlük tarihi zorunlu); sonra yeni taslak açılabilir.
    await withTenant(h.pool, { ...all(), userId: w.users.tenantAdmin.id }, async (tx) => {
      await rejects(tx.query(`UPDATE procurement_rule_sets SET status = 'PUBLISHED', published_by = $2, published_at = now() WHERE id = $1`, [set, w.users.tenantAdmin.id]), '23514');
    });
    await withTenant(h.pool, { ...all(), userId: w.users.tenantAdmin.id }, async (tx) => {
      expect((await tx.query(`UPDATE procurement_rule_sets SET status = 'PUBLISHED', effective_from = '2026-11-18', published_by = $2, published_at = now() WHERE id = $1`,
        [set, w.users.tenantAdmin.id])).rowCount).toBe(1);
    });
    // Yayımlanınca yeni taslak açılabilir (sonraki testler için yayımlanır).
    await publish((await ruleSet({ publish: false })).set);
  });
});

describe('056 denetim koşusu', () => {
  it('audit_and_results_are_immutable_and_follow_published_set', async () => {
    const w = h.world;
    const p = await project({ status: 'CONTRACTING' });
    const { set, rule } = await ruleSet();
    const a = await audit(p, set);
    const res = (await one<{ id: string }>(`INSERT INTO compliance_rule_results (tenant_id, audit_id, rule_id, result, method, finding, evidence, weight, mandatory)
      VALUES ($1, $2, $3, 'FAIL', 'DATA', '2 geçerli teklif (eşik 3)', '[{"quote":"sentetik","page":1}]', 15, true) RETURNING id`, [w.tenantA, a, rule])).id;
    for (const [t, id] of [['compliance_audits', a], ['compliance_rule_results', res]] as const) {
      await withTenant(h.pool, all(), (tx) => rejects(tx.query(`UPDATE ${t} SET tenant_id = tenant_id WHERE id = $1`, [id]), '42501'));
      await withTenant(h.pool, all(), (tx) => rejects(tx.query(`DELETE FROM ${t} WHERE id = $1`, [id]), '42501'));
      await rejects(h.owner.query(`UPDATE ${t} SET tenant_id = tenant_id WHERE id = $1`, [id]), 'P0001', /immutable_record/);
      await rejects(h.owner.query(`DELETE FROM ${t} WHERE id = $1`, [id]), 'P0001', /immutable_record/);
    }
    // Koşu numarası proje içinde tekil; set yokken NO_RULESET puansız; taslak setle denetim yazılmaz; DONE setsiz olmaz.
    await rejects(audit(p, set, 1), '23505');
    expect(await audit(p, null, 2)).toBeTruthy();
    const draft = await draftSetId();
    await rejects(audit(p, draft, 3), 'P0001', /compliance_rule_set_not_published/);
    await publish(draft);
    await rejects(h.owner.query(`INSERT INTO compliance_audits (tenant_id, company_id, project_id, run_no, trigger, status, verdict) VALUES ($1, $2, $3, 4, 'RERUN', 'DONE', 'COMPLIANT')`,
      [w.tenantA, w.companyA1.id, p]), '23514');
    await rejects(h.owner.query(`INSERT INTO compliance_audits (tenant_id, company_id, project_id, run_no, trigger, status, score) VALUES ($1, $2, $3, 4, 'RERUN', 'NO_RULESET', 50)`,
      [w.tenantA, w.companyA1.id, p]), '23514');
    await rejects(h.owner.query(`INSERT INTO compliance_audits (tenant_id, company_id, project_id, run_no, rule_set_id, trigger, status, verdict, summary_source)
      VALUES ($1, $2, $3, 4, $4, 'RERUN', 'DONE', 'COMPLIANT', 'AI')`, [w.tenantA, w.companyA1.id, p, set]), '23514');
    // Kural sonucu yalnız koşunun setindeki kuraldan.
    const other = await ruleSet();
    await rejects(h.owner.query(`INSERT INTO compliance_rule_results (tenant_id, audit_id, rule_id, result, weight, mandatory) VALUES ($1, $2, $3, 'PASS', 15, true)`,
      [w.tenantA, a, other.rule]), 'P0001', /compliance_rule_not_in_audit_set/);
  });

  it('manual_marks_and_ai_cache_insert_only', async () => {
    const w = h.world;
    const p = await project({ status: 'CONTRACTING' });
    const dv = await docVersion();
    const m = await withTenant(h.pool, all(), async (tx) => (await tx.query<{ id: string }>(`INSERT INTO compliance_manual_marks (tenant_id, company_id, project_id, rule_code, result, note,
        document_version_id, marked_by) VALUES ($1, $2, $3, 'K14', 'PASS', 'Kanıt belgesi incelendi (sentetik)', $4, $5) RETURNING id`,
      [w.tenantA, w.companyA1.id, p, dv, w.users.buyer.id])).rows[0]!.id);
    await withTenant(h.pool, all(), (tx) => rejects(tx.query(`INSERT INTO compliance_manual_marks (tenant_id, company_id, project_id, rule_code, result, note, document_version_id, marked_by)
      VALUES ($1, $2, $3, 'K14', 'PASS', 'kısa', $4, $5)`, [w.tenantA, w.companyA1.id, p, dv, w.users.buyer.id]), '23514'));
    await withTenant(h.pool, all(), (tx) => rejects(tx.query(`INSERT INTO compliance_manual_marks (tenant_id, company_id, project_id, rule_code, result, note, document_version_id, marked_by)
      VALUES ($1, $2, $3, 'K14', 'NO_DATA', 'Kanıt belgesi incelendi', $4, $5)`, [w.tenantA, w.companyA1.id, p, dv, w.users.buyer.id]), '23514'));
    const key = `sha256:${'d'.repeat(64)}`;
    const c = await withTenant(h.pool, all(), async (tx) => (await tx.query<{ id: string }>(`INSERT INTO compliance_ai_cache (tenant_id, cache_key, output, provider)
      VALUES ($1, $2, '{"satisfied":true,"quotes":[]}', 'test') RETURNING id`, [w.tenantA, key])).rows[0]!.id);
    await withTenant(h.pool, all(), (tx) => rejects(tx.query(`INSERT INTO compliance_ai_cache (tenant_id, cache_key, output, provider) VALUES ($1, $2, '{}', 'test')`, [w.tenantA, key]), '23505'));
    for (const [t, id] of [['compliance_manual_marks', m], ['compliance_ai_cache', c]] as const) {
      await withTenant(h.pool, all(), (tx) => rejects(tx.query(`UPDATE ${t} SET tenant_id = tenant_id WHERE id = $1`, [id]), '42501'));
      await withTenant(h.pool, all(), (tx) => rejects(tx.query(`DELETE FROM ${t} WHERE id = $1`, [id]), '42501'));
      await rejects(h.owner.query(`UPDATE ${t} SET tenant_id = tenant_id WHERE id = $1`, [id]), 'P0001', /immutable_record/);
      await rejects(h.owner.query(`DELETE FROM ${t} WHERE id = $1`, [id]), 'P0001', /immutable_record/);
    }
  });
});

describe('055/056 kiracı, tedarikçi ve departman kapsamı', () => {
  it('every_new_table_isolated_by_tenant_and_closed_to_supplier', async () => {
    const w = h.world;
    const p = await project({ status: 'CONTRACTING' });
    const dv = await docVersion();
    const inv = await invoice(w.departments.ik);
    const fam = await family(w.departments.ik);
    const { set, rule } = await ruleSet();
    const a = await audit(p, set);
    await h.owner.query(`INSERT INTO compliance_rule_results (tenant_id, audit_id, rule_id, result, method, weight, mandatory) VALUES ($1, $2, $3, 'PASS', 'DATA', 15, true)`, [w.tenantA, a, rule]);
    await h.owner.query(`INSERT INTO invoice_match_events (tenant_id, company_id, invoice_id, action, family_id, method) VALUES ($1, $2, $3, 'LINK', $4, 'ERP_REF')`, [w.tenantA, w.companyA1.id, inv.id, fam]);
    await h.owner.query(`INSERT INTO coi_declarations (tenant_id, company_id, project_id, user_id, kind) VALUES ($1, $2, $3, $4, 'NONE')`, [w.tenantA, w.companyA1.id, p, w.users.buyer.id]);
    await h.owner.query(`INSERT INTO compliance_evidence (tenant_id, company_id, project_id, check_key, document_version_id, kind, uploaded_by) VALUES ($1, $2, $3, 'OWNERSHIP_RESEARCH', $4, 'TRADE_REGISTRY', $5)`,
      [w.tenantA, w.companyA1.id, p, dv, w.users.buyer.id]);
    await h.owner.query(`INSERT INTO compliance_manual_marks (tenant_id, company_id, project_id, rule_code, result, note, document_version_id, marked_by) VALUES ($1, $2, $3, 'K14', 'FAIL', 'Kanıt yetersiz (sentetik not)', $4, $5)`,
      [w.tenantA, w.companyA1.id, p, dv, w.users.buyer.id]);
    await h.owner.query(`INSERT INTO compliance_ai_cache (tenant_id, cache_key, output, provider) VALUES ($1, $2, '{}', 'test')`, [w.tenantA, `sha256:${rand()}${'e'.repeat(40)}`]);
    const tables: [string, string, unknown[]][] = [
      ['invoice_match_events', 'invoice_id = $1', [inv.id]], ['coi_declarations', 'project_id = $1', [p]], ['compliance_evidence', 'project_id = $1', [p]],
      ['procurement_rule_sets', 'id = $1', [set]], ['procurement_rules', 'rule_set_id = $1', [set]], ['compliance_audits', 'id = $1', [a]],
      ['compliance_rule_results', 'audit_id = $1', [a]], ['compliance_manual_marks', 'project_id = $1', [p]], ['compliance_ai_cache', 'tenant_id = $1', [w.tenantA]],
    ];
    await withTenant(h.pool, all(), async (tx) => {
      for (const [t, where, params] of tables) expect(await count(tx, `${t} WHERE ${where}`, params), t).toBeGreaterThan(0);
    });
    await withTenant(h.pool, tenantB(), async (tx) => {
      for (const [t, where, params] of tables) expect(await count(tx, `${t} WHERE ${where}`, params), t).toBe(0);
    });
    await withTenant(h.pool, supplierCtx(), async (tx) => {
      for (const [t] of tables) expect(await count(tx, t), t).toBe(0);
    });
    // B kiracısı A'nın kaydına yazamaz.
    await withTenant(h.pool, tenantB(), (tx) => rejects(tx.query(`INSERT INTO coi_declarations (tenant_id, company_id, project_id, user_id, kind) VALUES ($1, $2, $3, $4, 'NONE')`,
      [w.tenantA, w.companyA1.id, p, w.users.buyerB.id]), '42501'));
    await withTenant(h.pool, tenantB(), (tx) => rejects(tx.query(`INSERT INTO procurement_rule_sets (tenant_id, version_no, created_by) VALUES ($1, 777, $2)`,
      [w.tenantA, w.users.buyerB.id]), '42501'));
    // Tedarikçi bağlamı yazamaz.
    await withTenant(h.pool, supplierCtx(), (tx) => rejects(tx.query(`INSERT INTO compliance_ai_cache (tenant_id, cache_key, output, provider) VALUES ($1, $2, '{}', 'test')`,
      [w.tenantA, `sha256:${'f'.repeat(64)}`]), '42501'));
  });

  it('bt_user_cannot_see_ik_project_audit_declaration_evidence', async () => {
    const w = h.world;
    const ik = await project({ status: 'CONTRACTING' });
    const bt = await project({ status: 'CONTRACTING', department: w.departments.bt });
    const { set, rule } = await ruleSet();
    const seed = async (p: string) => {
      const dv = await docVersion();
      const a = await audit(p, set);
      await h.owner.query(`INSERT INTO compliance_rule_results (tenant_id, audit_id, rule_id, result, method, weight, mandatory) VALUES ($1, $2, $3, 'PASS', 'DATA', 15, true)`, [w.tenantA, a, rule]);
      await h.owner.query(`INSERT INTO coi_declarations (tenant_id, company_id, project_id, user_id, kind) VALUES ($1, $2, $3, $4, 'NONE')`, [w.tenantA, w.companyA1.id, p, w.users.buyer.id]);
      await h.owner.query(`INSERT INTO compliance_evidence (tenant_id, company_id, project_id, check_key, document_version_id, kind, uploaded_by) VALUES ($1, $2, $3, 'WINNER_RESEARCH', $4, 'RESEARCH', $5)`,
        [w.tenantA, w.companyA1.id, p, dv, w.users.buyer.id]);
      const dv2 = await docVersion();
      await h.owner.query(`INSERT INTO compliance_manual_marks (tenant_id, company_id, project_id, rule_code, result, note, document_version_id, marked_by) VALUES ($1, $2, $3, 'K14', 'PASS', 'Kanıt belgesi incelendi (sentetik)', $4, $5)`,
        [w.tenantA, w.companyA1.id, p, dv2, w.users.buyer.id]);
      return { a, dv, dv2 };
    };
    const ikRows = await seed(ik);
    const btRows = await seed(bt);
    const visible = (deps: string[], p: string, r: { a: string; dv: string; dv2: string }) => withTenant(h.pool, dept(deps), async (tx) => ({
      audit: await count(tx, `compliance_audits WHERE id = $1`, [r.a]),
      results: await count(tx, `compliance_rule_results WHERE audit_id = $1`, [r.a]),
      coi: await count(tx, `coi_declarations WHERE project_id = $1`, [p]),
      evidence: await count(tx, `compliance_evidence WHERE project_id = $1`, [p]),
      marks: await count(tx, `compliance_manual_marks WHERE project_id = $1`, [p]),
      evidenceDoc: await count(tx, `document_versions WHERE id = $1`, [r.dv]),
      markDoc: await count(tx, `document_versions WHERE id = $1`, [r.dv2]),
    }));
    const none = { audit: 0, results: 0, coi: 0, evidence: 0, marks: 0, evidenceDoc: 0, markDoc: 0 };
    const allOne = { audit: 1, results: 1, coi: 1, evidence: 1, marks: 1, evidenceDoc: 1, markDoc: 1 };
    expect(await visible([w.departments.bt], ik, ikRows)).toEqual(none);
    expect(await visible([w.departments.bt], bt, btRows)).toEqual(allOne);
    expect(await visible([w.departments.ik], ik, ikRows)).toEqual(allOne);
    // BT kullanıcısı İK projesine beyan/kanıt/denetim yazamaz; kendi projesine beyan yazar.
    const dv = await docVersion();
    await withTenant(h.pool, dept([w.departments.bt]), (tx) => rejects(tx.query(`INSERT INTO coi_declarations (tenant_id, company_id, project_id, user_id, kind) VALUES ($1, $2, $3, $4, 'NONE')`,
      [w.tenantA, w.companyA1.id, ik, w.users.techEval.id]), '42501'));
    await withTenant(h.pool, dept([w.departments.bt]), (tx) => rejects(tx.query(`INSERT INTO compliance_evidence (tenant_id, company_id, project_id, check_key, document_version_id, kind, uploaded_by)
      VALUES ($1, $2, $3, 'WINNER_RESEARCH', $4, 'RESEARCH', $5)`, [w.tenantA, w.companyA1.id, ik, dv, w.users.techEval.id]), '42501'));
    await withTenant(h.pool, dept([w.departments.bt]), (tx) => rejects(tx.query(`INSERT INTO compliance_audits (tenant_id, company_id, project_id, run_no, trigger, status)
      VALUES ($1, $2, $3, 9, 'RERUN', 'NO_RULESET')`, [w.tenantA, w.companyA1.id, ik]), '42501'));
    await withTenant(h.pool, dept([w.departments.bt]), async (tx) => {
      expect((await tx.query(`INSERT INTO coi_declarations (tenant_id, company_id, project_id, user_id, kind) VALUES ($1, $2, $3, $4, 'NONE')`,
        [w.tenantA, w.companyA1.id, bt, w.users.techEval.id])).rowCount).toBe(1);
    });
    // Departmansız proje: yalnız tüm departmanı gören görür.
    const none2 = await project({ department: null });
    await h.owner.query(`INSERT INTO coi_declarations (tenant_id, company_id, project_id, user_id, kind) VALUES ($1, $2, $3, $4, 'NONE')`, [w.tenantA, w.companyA1.id, none2, w.users.buyer.id]);
    await withTenant(h.pool, dept([w.departments.bt, w.departments.ik]), async (tx) => expect(await count(tx, `coi_declarations WHERE project_id = $1`, [none2])).toBe(0));
    await withTenant(h.pool, all(), async (tx) => expect(await count(tx, `coi_declarations WHERE project_id = $1`, [none2])).toBe(1));
  });
});
