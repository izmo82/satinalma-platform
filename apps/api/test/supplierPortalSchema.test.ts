// v2 Faz 5 (D110) Görev 2: 052 tedarikçi portalı şeması — yeni tablolarda kiracı/tedarikçi RLS'i, girişsiz SECURITY DEFINER işlevleri
// (kapalı ayar, açık başvuru tekilliği, R4b sayımları, tek kullanımlık belirteç), app_portal_standing() anahtar listesi (R15),
// portal_update_contact, suppliers tedarikçi kapsamı (R17), bir kez yazılan kararlar ve görev ayrılığı. Tüm veri sentetik.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import type pg from 'pg';
import { withTenant, withoutTenant, type TenantContext } from '../src/db.ts';
import { makeHarness } from './harness.ts';

let h: Awaited<ReturnType<typeof makeHarness>>;
let slugA: string; let slugB: string;
const rand = () => randomUUID().slice(0, 8);
const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const token = () => randomBytes(32);
const hashOf = (t: Buffer) => createHash('sha256').update(t).digest();
let vknSeq = 0;
const vkn = () => `8${String(Date.now() % 1e6).padStart(6, '0')}${String(vknSeq++).padStart(3, '0')}`;

const internalA = (): TenantContext => ({ tenantId: h.world.tenantA, userId: h.world.users.buyer.id, roles: ['PROCUREMENT'],
  companyIds: [h.world.companyA1.id], departmentIds: [], allDepartments: true, correlationId: 'v2-supplier-portal-schema' });
const internalB = (): TenantContext => ({ tenantId: h.world.tenantB, userId: h.world.users.buyerB.id, roles: ['PROCUREMENT'],
  companyIds: [h.world.companyB1.id], departmentIds: [], allDepartments: true, correlationId: 'v2-supplier-portal-schema-b' });
const supplierCtx = (who: 'supplier1' | 'supplier2', supplierId: string): TenantContext => ({ tenantId: h.world.tenantA,
  userId: h.world.users[who].id, roles: ['SUPPLIER'], companyIds: [], departmentIds: [], allDepartments: false, supplierId,
  correlationId: 'v2-supplier-portal-schema-s' });

function app(over: Record<string, unknown> = {}) {
  return { legalName: 'Deneme Tedarik A.Ş. (SENTETİK)', taxIdType: 'VKN', taxId: vkn(), contactName: 'Ayşe Deneme',
    contactEmail: `basvuru-${rand()}@example.test`, contactPhone: '0212 000 00 00', address: 'Sentetik Mah. 1, İstanbul', categories: [], ...over };
}
function doc(typeCode: string, over: Record<string, unknown> = {}) {
  return { typeCode, title: null, originalFilename: `${typeCode}.pdf`, mimeType: 'application/pdf', sizeBytes: 1200, sha256: sha(randomUUID()),
    storageKey: `applications/${randomUUID()}`, basicCheckStatus: 'PASSED', basicCheckReason: null, avScanStatus: 'NOT_CONFIGURED',
    validUntil: '2027-06-30', ...over };
}
const mail = { subject: 'Başvurunuzu doğrulayın', body: 'Bağlantı: /basvuru/dogrula#token=…', status: 'NOT_CONFIGURED' };

async function create(slug: string, a: Record<string, unknown>, docs: unknown[] = [], t = token(), ip = randomBytes(32)) {
  const id = await withoutTenant(h.pool, async (c) => (await c.query<{ id: string }>(
    `SELECT public_application_create($1, $2, $3, $4, $5, $6) AS id`, [slug, a, JSON.stringify(docs), hashOf(t), ip, mail])).rows[0]!.id);
  return { id, token: t };
}
const pub = <T = any>(sql: string, params: unknown[]) => withoutTenant(h.pool, async (c) => (await c.query<{ r: T }>(sql, params)).rows[0]!.r);
async function rejects(p: Promise<unknown>, code: string, message?: RegExp) {
  const err = await p.then(() => null, (e: any) => e);
  expect(err, `beklenen hata ${code}`).not.toBeNull();
  expect(err.code).toBe(code);
  if (message) expect(err.message).toMatch(message);
}
const count = async (tx: pg.PoolClient, sql: string, params: unknown[] = []) => (await tx.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${sql}`, params)).rows[0]!.n;

beforeAll(async () => {
  h = await makeHarness();
  slugA = `t2a-${rand()}`; slugB = `t2b-${rand()}`;
  await h.owner.query(`INSERT INTO supplier_application_settings (tenant_id, enabled, public_slug, categories, updated_by) VALUES ($1, true, $2, $3, $4)`,
    [h.world.tenantA, slugA, ['Bilgi teknolojileri', 'Temizlik'], h.world.users.tenantAdmin.id]);
  await h.owner.query(`INSERT INTO supplier_application_settings (tenant_id, enabled, public_slug) VALUES ($1, true, $2)`, [h.world.tenantB, slugB]);
  const types: [string, string, string, boolean, string[], boolean][] = [
    [h.world.tenantA, 'VERGI_LEVHASI', 'Vergi levhası', true, [], true],
    [h.world.tenantA, 'IMZA_SIRKULERI', 'İmza sirküleri', true, [], false],
    [h.world.tenantA, 'ISO27001', 'ISO 27001', false, ['Bilgi teknolojileri'], true],
    [h.world.tenantB, 'VERGI_LEVHASI', 'Vergi levhası', true, [], true],
  ];
  for (const t of types) await h.owner.query(`INSERT INTO supplier_document_types (tenant_id, code, name, required, required_categories, expiry_required) VALUES ($1,$2,$3,$4,$5,$6)`, t);
  await h.owner.query(`INSERT INTO supplier_document_types (tenant_id, code, name, active) VALUES ($1, 'ESKI_BELGE', 'Kaldırılmış tür', false)`, [h.world.tenantA]);
});
afterAll(async () => { await h.close(); });

describe('052 girişsiz başvuru işlevleri', () => {
  it('config_closed_unknown_and_open', async () => {
    expect(await pub(`SELECT public_application_config($1) AS r`, ['yok-boyle-bir-adres'])).toEqual({ enabled: false });
    const open = await pub(`SELECT public_application_config($1) AS r`, [slugA]);
    expect(Object.keys(open).sort()).toEqual(['categories', 'documentTypes', 'enabled', 'internal', 'organizationName']);
    expect(open.enabled).toBe(true);
    expect(open.internal).toEqual({ tenantId: h.world.tenantA });
    expect(open.documentTypes.map((d: any) => d.code).sort()).toEqual(['IMZA_SIRKULERI', 'ISO27001', 'VERGI_LEVHASI']);
    expect(open.documentTypes.find((d: any) => d.code === 'ISO27001')).toEqual({ code: 'ISO27001', name: 'ISO 27001', required: false,
      requiredCategories: ['Bilgi teknolojileri'], expiryRequired: true });
  });

  it('no_tenant_context_cannot_touch_tables_but_function_creates', async () => {
    await withoutTenant(h.pool, async (c) => {
      expect((await c.query(`SELECT id FROM supplier_applications`)).rowCount).toBe(0);
      expect((await c.query(`SELECT * FROM supplier_documents`)).rowCount).toBe(0);
      expect((await c.query(`SELECT * FROM supplier_application_settings`)).rowCount).toBe(0);
      await rejects(c.query(`INSERT INTO supplier_applications (tenant_id, legal_name, tax_id_type, tax_id, contact_name, contact_email)
        VALUES ($1, 'Sızma Denemesi', 'VKN', '1234567890', 'Ad Soyad', 'x@example.test')`, [h.world.tenantA]), '42501');
      await rejects(c.query(`SELECT supplier_application_add_documents($1, $2, '[]'::jsonb, NULL)`, [h.world.tenantA, randomUUID()]), '42501');
    });
    const a = app({ categories: ['Bilgi teknolojileri'] });
    const { id } = await create(slugA, a, [doc('VERGI_LEVHASI'), doc('IMZA_SIRKULERI', { validUntil: null }), doc('ISO27001')]);
    const row = (await h.owner.query(`SELECT status, token_purpose, token_expires_at > now() + interval '23 hours' AS fresh, octet_length(ip_hash) AS ip FROM supplier_applications WHERE id = $1`, [id])).rows[0];
    expect(row).toEqual({ status: 'UNVERIFIED', token_purpose: 'VERIFY', fresh: true, ip: 32 });
    const mails = (await h.owner.query(`SELECT to_user_id, to_email, status, subject FROM email_outbox WHERE related_type = 'supplier_application' AND related_id = $1`, [id])).rows;
    expect(mails).toEqual([{ to_user_id: null, to_email: a.contactEmail, status: 'NOT_CONFIGURED', subject: mail.subject }]);
    expect((await h.owner.query(`SELECT count(*)::int AS n FROM supplier_documents WHERE application_id = $1 AND uploaded_via = 'APPLICATION' AND supplier_id IS NULL`, [id])).rows[0].n).toBe(3);
    // Kiracı A iç bağlamı görür (belirteç ve adres özeti sütunları okunamaz), B ve tedarikçi bağlamı görmez.
    await withTenant(h.pool, internalA(), async (tx) => {
      expect(await count(tx, `supplier_applications WHERE id = $1`, [id])).toBe(1);
      await rejects(tx.query(`SELECT token_hash FROM supplier_applications WHERE id = $1`, [id]), '42501');
    });
    await withTenant(h.pool, internalA(), (tx) => rejects(tx.query(`SELECT ip_hash FROM supplier_applications`), '42501'));
    await withTenant(h.pool, internalB(), async (tx) => {
      expect(await count(tx, `supplier_applications WHERE id = $1`, [id])).toBe(0);
      expect(await count(tx, `supplier_documents WHERE application_id = $1`, [id])).toBe(0);
    });
    await withTenant(h.pool, supplierCtx('supplier1', h.world.suppliers.s1), async (tx) => {
      expect(await count(tx, `supplier_applications`)).toBe(0);
      expect(await count(tx, `supplier_documents WHERE application_id = $1`, [id])).toBe(0);
    });
  });

  it('closed_settings_open_nothing', async () => {
    await h.owner.query(`UPDATE supplier_application_settings SET enabled = false WHERE tenant_id = $1`, [h.world.tenantB]);
    try {
      expect(await pub(`SELECT public_application_config($1) AS r`, [slugB])).toEqual({ enabled: false });
      const before = (await h.owner.query(`SELECT count(*)::int AS n FROM supplier_applications WHERE tenant_id = $1`, [h.world.tenantB])).rows[0].n;
      await rejects(create(slugB, app()), 'SP404', /applications_closed/);
      await rejects(create('yok-boyle-bir-adres', app()), 'SP404', /applications_closed/);
      expect((await h.owner.query(`SELECT count(*)::int AS n FROM supplier_applications WHERE tenant_id = $1`, [h.world.tenantB])).rows[0].n).toBe(before);
    } finally {
      await h.owner.query(`UPDATE supplier_application_settings SET enabled = true WHERE tenant_id = $1`, [h.world.tenantB]);
    }
  });

  it('slug_routes_to_its_tenant', async () => {
    const { id } = await create(slugB, app(), [doc('VERGI_LEVHASI')]);
    expect((await h.owner.query(`SELECT tenant_id FROM supplier_applications WHERE id = $1`, [id])).rows[0].tenant_id).toBe(h.world.tenantB);
    await withTenant(h.pool, internalA(), async (tx) => expect(await count(tx, `supplier_applications WHERE id = $1`, [id])).toBe(0));
    // B kiracısının belge türü A'nın kısaltmasıyla kullanılamaz (yalnız etkin ve aynı kiracının türü).
    await rejects(create(slugA, app(), [doc('ESKI_BELGE')]), 'SP422', /document_type/);
  });

  it('second_open_application_same_tax_id_rejected', async () => {
    const a = app();
    const first = await create(slugA, a);
    await rejects(create(slugA, { ...a, contactEmail: `baska-${rand()}@example.test` }), 'SP409', /application_exists/);
    // Kapanmış başvurudan sonra aynı kimlikle yeniden başvurulabilir.
    await h.owner.query(`UPDATE supplier_applications SET status = 'REJECTED', decided_by = $2, decided_at = now(), decision_reason = 'Sentetik ret gerekçesi'
      WHERE id = $1`, [first.id, h.world.users.buyer.id]);
    await create(slugA, { ...a, contactEmail: `ucuncu-${rand()}@example.test` });
  });

  it('email_daily_limit_rejects_fourth', async () => {
    const email = `limit-${rand()}@example.test`;
    for (let i = 0; i < 3; i++) await create(slugA, app({ contactEmail: i === 1 ? email.toUpperCase() : email }));
    await rejects(create(slugA, app({ contactEmail: email })), 'SP429', /rate_limited/);
  });

  it('ip_hourly_limit_rejects_eleventh', async () => {
    const ip = randomBytes(32);
    for (let i = 0; i < 10; i++) await create(slugA, app(), [], token(), ip);
    await rejects(create(slugA, app(), [], token(), ip), 'SP429', /rate_limited/);
    // Aynı adres özeti başka kiracıda ayrı sayılır (özet zaten kiracıya bağlıdır).
    await create(slugB, app(), [], token(), ip);
  });

  it('document_limits_enforced', async () => {
    await rejects(create(slugA, app(), [doc('VERGI_LEVHASI', { sizeBytes: 10 * 1024 * 1024 + 1 })]), 'SP422', /file_size/);
    await rejects(create(slugA, app(), Array.from({ length: 11 }, () => doc('IMZA_SIRKULERI'))), 'SP422', /too_many_files/);
    await rejects(create(slugA, app(), Array.from({ length: 5 }, () => doc('IMZA_SIRKULERI', { sizeBytes: 9 * 1024 * 1024 }))), 'SP422', /total_size/);
    await rejects(create(slugA, app(), [doc('VERGI_LEVHASI', { validUntil: null })]), 'SP422', /valid_until_required/);
    await rejects(create(slugA, app(), [doc('VERGI_LEVHASI', { avScanStatus: 'INFECTED' })]), 'SP422', /file_infected/);
    await rejects(create(slugA, app({ categories: ['Uzay madenciliği'] })), 'SP422', /categories/);
  });

  it('verify_token_single_use_expiry_and_purpose', async () => {
    const { id, token: t } = await create(slugA, app());
    const r = await pub(`SELECT public_application_verify($1) AS r`, [hashOf(t)]);
    expect(r).toEqual({ status: 'SUBMITTED', internal: { tenantId: h.world.tenantA, applicationId: id } });
    const row = (await h.owner.query(`SELECT status, token_hash, verified_at IS NOT NULL AS v, row_version FROM supplier_applications WHERE id = $1`, [id])).rows[0];
    expect(row).toEqual({ status: 'SUBMITTED', token_hash: null, v: true, row_version: 2 });
    expect((await h.owner.query(`SELECT count(*)::int AS n FROM jobs WHERE tenant_id = $1 AND kind = 'supplier_application.submitted' AND payload->>'applicationId' = $2`,
      [h.world.tenantA, id])).rows[0].n).toBe(1);
    await rejects(pub(`SELECT public_application_verify($1) AS r`, [hashOf(t)]), 'SP410', /token_invalid/);

    const expired = await create(slugA, app());
    await h.owner.query(`UPDATE supplier_applications SET token_expires_at = now() - interval '1 minute' WHERE id = $1`, [expired.id]);
    await rejects(pub(`SELECT public_application_verify($1) AS r`, [hashOf(expired.token)]), 'SP410', /token_invalid/);
    expect((await h.owner.query(`SELECT status FROM supplier_applications WHERE id = $1`, [expired.id])).rows[0].status).toBe('UNVERIFIED');
    await rejects(pub(`SELECT public_application_verify($1) AS r`, [hashOf(token())]), 'SP410', /token_invalid/);
  });

  it('complete_token_flow', async () => {
    const { id, token: vt } = await create(slugA, app({ categories: ['Bilgi teknolojileri'] }), [doc('VERGI_LEVHASI')]);
    await pub(`SELECT public_application_verify($1) AS r`, [hashOf(vt)]);
    // Satınalma eksik belge ister (Görev 5 bu güncellemeyi sp_app ile yapar).
    const ct = token();
    await withTenant(h.pool, internalA(), (tx) => tx.query(`UPDATE supplier_applications SET status = 'NEEDS_DOCUMENTS', token_hash = $2, token_purpose = 'COMPLETE',
      token_expires_at = now() + interval '24 hours', requested_documents = '{ISO27001}', requested_note = 'ISO belgesini ekleyin.', row_version = row_version + 1 WHERE id = $1`,
      [id, hashOf(ct)]));
    // Tamamlama belirteci doğrulama ucunda geçmez; doğrulama belirteci tamamlamada geçmez.
    await rejects(pub(`SELECT public_application_verify($1) AS r`, [hashOf(ct)]), 'SP410', /token_invalid/);
    await rejects(pub(`SELECT public_application_complete_info($1) AS r`, [hashOf(vt)]), 'SP410', /token_invalid/);
    const info = await pub(`SELECT public_application_complete_info($1) AS r`, [hashOf(ct)]);
    expect(info).toEqual({ legalName: 'Deneme Tedarik A.Ş. (SENTETİK)', note: 'ISO belgesini ekleyin.',
      requestedDocuments: [{ code: 'ISO27001', name: 'ISO 27001', expiryRequired: true }], internal: { tenantId: h.world.tenantA, applicationId: id } });
    await rejects(pub(`SELECT public_application_complete($1, $2) AS r`, [hashOf(ct), JSON.stringify([doc('IMZA_SIRKULERI')])]), 'SP422', /documents_missing/);
    await rejects(pub(`SELECT public_application_complete($1, $2) AS r`, [hashOf(ct), JSON.stringify([doc('ISO27001'), doc('IMZA_SIRKULERI')])]), 'SP422', /document_type/);
    const done = await pub(`SELECT public_application_complete($1, $2) AS r`, [hashOf(ct), JSON.stringify([doc('ISO27001')])]);
    expect(done.status).toBe('SUBMITTED');
    expect((await h.owner.query(`SELECT status, token_hash FROM supplier_applications WHERE id = $1`, [id])).rows[0]).toEqual({ status: 'SUBMITTED', token_hash: null });
    expect((await h.owner.query(`SELECT array_agg(type_code ORDER BY type_code) AS c FROM supplier_documents WHERE application_id = $1`, [id])).rows[0].c).toEqual(['ISO27001', 'VERGI_LEVHASI']);
    expect((await h.owner.query(`SELECT count(*)::int AS n FROM jobs WHERE kind = 'supplier_application.submitted' AND payload->>'applicationId' = $1`, [id])).rows[0].n).toBe(2);
    await rejects(pub(`SELECT public_application_complete($1, $2) AS r`, [hashOf(ct), JSON.stringify([doc('ISO27001')])]), 'SP410', /token_invalid/);
  });

  it('decided_application_is_immutable', async () => {
    const { id } = await create(slugA, app());
    await withTenant(h.pool, internalA(), async (tx) => {
      await rejects(tx.query(`UPDATE supplier_applications SET status = 'REJECTED', decided_by = $2, decided_at = now(), decision_reason = 'kısa' WHERE id = $1`,
        [id, h.world.users.buyer.id]), '23514');
    });
    await withTenant(h.pool, internalA(), (tx) => tx.query(`UPDATE supplier_applications SET status = 'REJECTED', decided_by = $2, decided_at = now(),
      decision_reason = 'Sentetik başvuru reddedildi' WHERE id = $1`, [id, h.world.users.buyer.id]));
    await withTenant(h.pool, internalA(), (tx) => rejects(tx.query(`UPDATE supplier_applications SET decision_reason = 'Gerekçe sonradan değişti' WHERE id = $1`, [id]), 'P0001'));
  });
});

describe('052 tedarikçi kapsamı ve portal işlevleri', () => {
  let docS1: string; let docS2: string;

  beforeAll(async () => {
    const ins = (supplierId: string, typeCode: string, validUntil: string | null) => h.owner.query<{ id: string }>(
      `INSERT INTO supplier_documents (tenant_id, supplier_id, type_code, title, original_filename, mime_type, size_bytes, sha256, storage_key,
         basic_check_status, av_scan_status, valid_until, uploaded_via, uploaded_by)
       VALUES ($1, $2, $3, 'Sentetik belge', 'belge.pdf', 'application/pdf', 900, $4, $5, 'PASSED', 'NOT_CONFIGURED', $6, 'INTERNAL', $7) RETURNING id`,
      [h.world.tenantA, supplierId, typeCode, sha(randomUUID()), `suppliers/${randomUUID()}`, validUntil, h.world.users.buyer.id]);
    docS1 = (await ins(h.world.suppliers.s1, 'IMZA_SIRKULERI', null)).rows[0]!.id;
    docS2 = (await ins(h.world.suppliers.s2, 'VERGI_LEVHASI', '2030-01-01')).rows[0]!.id;
  });

  it('r17_supplier_session_sees_only_own_supplier_row', async () => {
    await withTenant(h.pool, supplierCtx('supplier1', h.world.suppliers.s1), async (tx) => {
      const rows = (await tx.query<{ id: string }>(`SELECT id FROM suppliers`)).rows;
      expect(rows.map((r) => r.id)).toEqual([h.world.suppliers.s1]);
      expect((await tx.query(`UPDATE suppliers SET contact_phone = '1' WHERE id = $1`, [h.world.suppliers.s2])).rowCount).toBe(0);
    });
    await withTenant(h.pool, internalA(), async (tx) => {
      const ids = (await tx.query<{ id: string }>(`SELECT id FROM suppliers`)).rows.map((r) => r.id);
      expect(ids).toEqual(expect.arrayContaining([h.world.suppliers.s1, h.world.suppliers.s2, h.world.suppliers.s3]));
    });
    await withTenant(h.pool, internalB(), async (tx) => expect(await count(tx, `suppliers WHERE id = ANY($1::uuid[])`,
      [[h.world.suppliers.s1, h.world.suppliers.s2]])).toBe(0));
  });

  it('supplier_documents_scoped_to_own_supplier', async () => {
    const s1 = supplierCtx('supplier1', h.world.suppliers.s1);
    await withTenant(h.pool, s1, async (tx) => {
      const ids = (await tx.query<{ id: string }>(`SELECT id FROM supplier_documents`)).rows.map((r) => r.id);
      expect(ids).toContain(docS1);
      expect(ids).not.toContain(docS2);
      // Belge türlerini okur.
      expect(await count(tx, `supplier_document_types`)).toBeGreaterThanOrEqual(3);
    });
    // Başka tedarikçi adına belge yazılamaz; belge türü yazılamaz.
    await withTenant(h.pool, s1, async (tx) => {
      await rejects(tx.query(`INSERT INTO supplier_documents (tenant_id, supplier_id, type_code, title, original_filename, mime_type, size_bytes, sha256, storage_key,
        basic_check_status, av_scan_status, uploaded_via, uploaded_by) VALUES ($1, $2, 'IMZA_SIRKULERI', 'x', 'x.pdf', 'application/pdf', 1, $3, $4, 'PASSED', 'NOT_CONFIGURED', 'PORTAL', $5)`,
        [h.world.tenantA, h.world.suppliers.s2, sha('x'), `p/${randomUUID()}`, h.world.users.supplier1.id]), '42501');
    });
    await withTenant(h.pool, s1, (tx) => rejects(tx.query(`INSERT INTO supplier_document_types (tenant_id, code, name) VALUES ($1, 'SAHTE', 'Sahte tür')`, [h.world.tenantA]), '42501'));
    await withTenant(h.pool, internalB(), async (tx) => expect(await count(tx, `supplier_documents WHERE id = ANY($1::uuid[])`, [[docS1, docS2]])).toBe(0));
  });

  it('supplier_document_link_and_supersede_write_once', async () => {
    const ins = async () => (await h.owner.query<{ id: string }>(`INSERT INTO supplier_documents (tenant_id, supplier_id, type_code, title, original_filename, mime_type,
      size_bytes, sha256, storage_key, basic_check_status, av_scan_status, valid_until, uploaded_via, uploaded_by)
      VALUES ($1, $2, 'VERGI_LEVHASI', 'Vergi levhası', 'v.pdf', 'application/pdf', 10, $3, $4, 'PASSED', 'NOT_CONFIGURED', '2027-01-01', 'INTERNAL', $5) RETURNING id`,
      [h.world.tenantA, h.world.suppliers.s3, sha(randomUUID()), `s/${randomUUID()}`, h.world.users.buyer.id])).rows[0]!.id;
    const oldDoc = await ins(); const newDoc = await ins(); const other = await ins();
    await withTenant(h.pool, internalA(), async (tx) => {
      await tx.query(`UPDATE supplier_documents SET superseded_by_id = $2 WHERE id = $1`, [oldDoc, newDoc]);
      await rejects(tx.query(`UPDATE supplier_documents SET superseded_by_id = $2 WHERE id = $1`, [oldDoc, other]), 'P0001');
    });
    await withTenant(h.pool, internalA(), (tx) => rejects(tx.query(`UPDATE supplier_documents SET supplier_id = $2 WHERE id = $1`, [oldDoc, h.world.suppliers.s1]), 'P0001'));
    await withTenant(h.pool, internalA(), (tx) => rejects(tx.query(`UPDATE supplier_documents SET title = 'Değişti' WHERE id = $1`, [oldDoc]), '42501'));
    await withTenant(h.pool, internalA(), (tx) => rejects(tx.query(`DELETE FROM supplier_documents WHERE id = $1`, [oldDoc]), '42501'));
  });

  it('portal_standing_keys_and_values_r15', async () => {
    const A = h.world.tenantA; const s1 = h.world.suppliers.s1; const u = h.world.users;
    const tpl = (await h.owner.query<{ id: string }>(`INSERT INTO questionnaire_templates (tenant_id, code, version, name, category, created_by)
      VALUES ($1, $2, 1, 'Sentetik anket', 'Bilgi teknolojileri', $3) RETURNING id`, [A, `T2-${rand()}`, u.security.id])).rows[0]!.id;
    const q = async (n: number) => (await h.owner.query<{ id: string }>(`INSERT INTO questionnaire_questions (tenant_id, template_id, ordinal, control_id, reference, text)
      VALUES ($1, $2, $3, $4, 'Kurum kontrolü', 'Sentetik soru') RETURNING id`, [A, tpl, n, `K-${n}`])).rows[0]!.id;
    const q1 = await q(1); const q2 = await q(2); const q3 = await q(3);
    await h.owner.query(`UPDATE questionnaire_templates SET status = 'PUBLISHED', published_by = $2, published_at = now() WHERE id = $1`, [tpl, u.security.id]);
    const assessment = async (extra: string) => (await h.owner.query<{ id: string }>(`INSERT INTO supplier_assessments (tenant_id, supplier_id, template_id, scope, inherent_factors, created_by ${extra ? ', ' + extra.split('|')[0] : ''})
      VALUES ($1, $2, $3, 'Sentetik kapsam', '{"data":"HIGH"}', $4 ${extra ? ', ' + extra.split('|')[1] : ''}) RETURNING id`, [A, s1, tpl, u.security.id])).rows[0]!.id;
    const reviewed = await assessment(`status, residual_level, residual_reason, residual_accepted_by, residual_accepted_at, reviewed_by, reviewed_at|'REVIEWED', 'MEDIUM', 'Sentetik gizli kalan risk gerekçesi metni', '${u.buyer.id}', now(), '${u.buyer.id}', now()`);
    for (const [qid, resp] of [[q1, 'YES'], [q2, 'PARTIAL'], [q3, 'NOT_APPLICABLE']] as const) {
      await h.owner.query(`INSERT INTO assessment_answers (tenant_id, assessment_id, question_id, response, na_reason, note, answered_by)
        VALUES ($1, $2, $3, $4, $5, 'Gizli yanıt notu', $6)`, [A, reviewed, qid, resp, resp === 'NOT_APPLICABLE' ? 'Kapsam dışı sentetik' : null, u.security.id]);
    }
    await assessment(`portal_status, portal_sent_at|'SENT', now()`);
    await h.owner.query(`INSERT INTO performance_reviews (tenant_id, supplier_id, period_start, period_end, category, policy_version, weights, scores, basis, reviewed_by)
      VALUES ($1, $2, date_trunc('year', now())::date, current_date, 'Bilgi teknolojileri', 'ornek-2026-1', $3, $4, 'Gizli performans gerekçesi', $5)`,
      [A, s1, { quality: 30, delivery: 25, sla: 20, communication: 10, commercial: 15 }, { quality: 80, delivery: 90, sla: 70, communication: 100, commercial: 60 }, u.buyer.id]);
    const incident = (await h.owner.query<{ id: string }>(`INSERT INTO supplier_incidents (tenant_id, code, supplier_id, category, severity, title, description, occurred_on, status, reported_by, verified_by, verified_at)
      VALUES ($1, $2, $3, 'SLA', 'HIGH', 'Sentetik kesinti olayı', 'Gizli olay açıklaması', current_date, 'VERIFIED', $4, $5, now()) RETURNING id`,
      [A, `OLY-T2-${rand()}`, s1, u.buyer.id, u.security.id])).rows[0]!.id;
    await h.owner.query(`INSERT INTO supplier_incidents (tenant_id, code, supplier_id, category, severity, title, description, occurred_on, status, reported_by, dispute_open, verified_by, verified_at)
      VALUES ($1, $2, $3, 'QUALITY', 'CRITICAL', 'İtirazlı sentetik olay', 'Gizli', current_date, 'VERIFIED', $4, true, $5, now())`, [A, `OLY-T2-${rand()}`, s1, u.buyer.id, u.security.id]);
    await h.owner.query(`INSERT INTO corrective_actions (tenant_id, incident_id, title, owner_role, due_date, created_by) VALUES ($1, $2, 'Kök neden analizi gönderin', 'SUPPLIER', '2026-12-31', $3)`,
      [A, incident, u.buyer.id]);

    const standing = await withTenant(h.pool, supplierCtx('supplier1', s1), async (tx) => (await tx.query(`SELECT app_portal_standing() AS r`)).rows[0].r);
    expect(Object.keys(standing).sort()).toEqual(['actions', 'missingDocs', 'pendingSurveys', 'residualLevel', 'review', 'surveys', 'verifiedIncidents']);
    // YES (2) + PARTIAL (1) / (2 uygulanabilir × 2) = %75; NOT_APPLICABLE paydada yok.
    expect(standing.surveys).toEqual([{ ratio: '75.0' }]);
    // 80×30 + 90×25 + 70×20 + 100×10 + 60×15 = 7950 → 79.5
    expect(standing.review).toEqual({ score: '79.5' });
    expect(standing.verifiedIncidents).toEqual([{ severity: 'HIGH' }]);
    expect(standing.residualLevel).toBe('MEDIUM');
    expect(standing.actions).toEqual([{ title: 'Kök neden analizi gönderin', dueDate: '2026-12-31', status: 'OPEN' }]);
    expect(standing.pendingSurveys).toBe(1);
    // Zorunlu: VERGI_LEVHASI (yok) ve IMZA_SIRKULERI (var, süresiz); ISO27001 kategori dışı.
    expect(standing.missingDocs).toBe(1);
    const text = JSON.stringify(standing);
    // İç yorum, gerekçe, içsel risk ve iç kullanıcı kimliği yok.
    for (const secret of ['Gizli', 'inherent', 'Reason', 'reason', 'note', u.security.id, u.buyer.id]) expect(text).not.toContain(secret);

    // Tedarikçi 2 yalnız kendi (boş) görünümünü alır; iç bağlam işlevi çağıramaz.
    const s2 = await withTenant(h.pool, supplierCtx('supplier2', h.world.suppliers.s2), async (tx) => (await tx.query(`SELECT app_portal_standing() AS r`)).rows[0].r);
    expect(s2).toEqual({ surveys: [], review: null, verifiedIncidents: [], residualLevel: null, actions: [], pendingSurveys: 0, missingDocs: 1 });
    await withTenant(h.pool, internalA(), (tx) => rejects(tx.query(`SELECT app_portal_standing()`), '42501'));
    await withoutTenant(h.pool, (c) => rejects(c.query(`SELECT app_portal_standing()`), '42501'));
  });

  it('portal_update_contact_changes_only_three_fields', async () => {
    const before = (await h.owner.query(`SELECT legal_name, tax_id, status, row_version FROM suppliers WHERE id = $1`, [h.world.suppliers.s1])).rows[0];
    const r = await withTenant(h.pool, supplierCtx('supplier1', h.world.suppliers.s1), async (tx) =>
      (await tx.query(`SELECT portal_update_contact($1, $2, $3) AS r`, ['  Mehmet İletişim ', '0216 111 11 11', 'Yeni adres, Ankara'])).rows[0].r);
    expect(r).toEqual({ contactName: 'Mehmet İletişim', contactPhone: '0216 111 11 11', address: 'Yeni adres, Ankara', rowVersion: before.row_version + 1 });
    const after = (await h.owner.query(`SELECT legal_name, tax_id, status, contact_name FROM suppliers WHERE id = $1`, [h.world.suppliers.s1])).rows[0];
    expect(after).toEqual({ legal_name: before.legal_name, tax_id: before.tax_id, status: before.status, contact_name: 'Mehmet İletişim' });
    await withTenant(h.pool, supplierCtx('supplier1', h.world.suppliers.s1), (tx) => rejects(tx.query(`SELECT portal_update_contact('A', null, null)`), 'SP422'));
    await withTenant(h.pool, internalA(), (tx) => rejects(tx.query(`SELECT portal_update_contact('İç Kullanıcı', null, null)`), '42501'));
  });
});

describe('052 mevcut kayıtlar, ayrılış ve görev ayrılığı', () => {
  it('supplier_status_check_and_rows_unchanged', async () => {
    const def = (await h.owner.query<{ d: string }>(`SELECT pg_get_constraintdef(oid) AS d FROM pg_constraint WHERE conrelid = 'suppliers'::regclass AND contype = 'c' AND pg_get_constraintdef(oid) LIKE '%CANDIDATE%'`)).rows;
    expect(def.map((x) => x.d)).toEqual([`CHECK ((status = ANY (ARRAY['CANDIDATE'::text, 'CONDITIONAL'::text, 'ACTIVE'::text, 'SUSPENDED'::text, 'ARCHIVED'::text, 'REJECTED'::text, 'MERGED'::text])))`]);
    const st = (await h.owner.query<{ id: string; status: string; row_version: number }>(`SELECT id, status, row_version FROM suppliers WHERE id = ANY($1::uuid[])`,
      [[h.world.suppliers.s2, h.world.suppliers.s3]])).rows;
    expect(Object.fromEntries(st.map((r) => [r.id, r.status]))).toEqual({ [h.world.suppliers.s2]: 'ACTIVE', [h.world.suppliers.s3]: 'CANDIDATE' });
    // Migration hiçbir suppliers satırını güncellemez (yalnız sütun ve kısıt ekler).
    const sql = await readFile(new URL('../migrations/052_v2_supplier_portal.sql', import.meta.url), 'utf8');
    const statements = sql.replace(/--.*$/gm, '').replace(/\$\$[\s\S]*?\$\$/g, '');
    expect(statements).not.toMatch(/UPDATE\s+suppliers/i);
    expect(statements).not.toMatch(/DROP\s+CONSTRAINT/i);
  });

  it('offboarding_decision_written_once', async () => {
    const off = await withTenant(h.pool, internalA(), async (tx) => {
      const o = (await tx.query<{ id: string }>(`INSERT INTO supplier_offboardings (tenant_id, supplier_id, reason, started_by) VALUES ($1, $2, 'Sözleşme sona erdi (sentetik)', $3) RETURNING id`,
        [h.world.tenantA, h.world.suppliers.s2, h.world.users.buyer.id])).rows[0]!.id;
      const i = (await tx.query<{ id: string }>(`INSERT INTO supplier_offboarding_items (tenant_id, offboarding_id, code, label) VALUES ($1, $2, 'VPN_ACCESS', 'Erişimlerin kapatılması') RETURNING id`,
        [h.world.tenantA, o])).rows[0]!.id;
      return { o, i };
    });
    await withTenant(h.pool, internalA(), (tx) => rejects(tx.query(`UPDATE supplier_offboarding_items SET not_applicable = true, done_by = $2, done_at = now() WHERE id = $1`,
      [off.i, h.world.users.buyer.id]), '23514'));
    await withTenant(h.pool, internalA(), (tx) => tx.query(`UPDATE supplier_offboarding_items SET done_by = $2, done_at = now(), note = 'VPN hesabı kapatıldı' WHERE id = $1`,
      [off.i, h.world.users.buyer.id]));
    await withTenant(h.pool, internalA(), (tx) => rejects(tx.query(`UPDATE supplier_offboarding_items SET note = 'Sonradan değişti' WHERE id = $1`, [off.i]), 'P0001'));
    await withTenant(h.pool, internalA(), (tx) => rejects(tx.query(`UPDATE supplier_offboarding_items SET done_by = $2 WHERE id = $1`, [off.i, h.world.users.masterData.id]), 'P0001'));
    await withTenant(h.pool, internalA(), (tx) => tx.query(`UPDATE supplier_offboardings SET completed_at = now() WHERE id = $1`, [off.o]));
    await withTenant(h.pool, internalA(), (tx) => rejects(tx.query(`UPDATE supplier_offboardings SET completed_at = now() + interval '1 day' WHERE id = $1`, [off.o]), 'P0001'));
    await withTenant(h.pool, internalA(), (tx) => rejects(tx.query(`DELETE FROM supplier_offboarding_items WHERE id = $1`, [off.i]), '42501'));
    await withTenant(h.pool, internalB(), async (tx) => {
      expect(await count(tx, `supplier_offboardings WHERE id = $1`, [off.o])).toBe(0);
      expect(await count(tx, `supplier_offboarding_items WHERE id = $1`, [off.i])).toBe(0);
    });
    await withTenant(h.pool, supplierCtx('supplier2', h.world.suppliers.s2), async (tx) => expect(await count(tx, `supplier_offboardings`)).toBe(0));
  });

  it('reactivated_by_cannot_equal_deactivated_by', async () => {
    const s = h.world.suppliers.s2; const u = h.world.users;
    await withTenant(h.pool, internalA(), (tx) => tx.query(`UPDATE suppliers SET deactivated_by = $2, deactivated_at = now(), deactivation_reason = 'Sentetik pasife alma gerekçesi' WHERE id = $1`, [s, u.buyer.id]));
    await withTenant(h.pool, internalA(), (tx) => rejects(tx.query(`UPDATE suppliers SET reactivated_by = $2, reactivated_at = now(), reactivation_reason = 'Sentetik yeniden açma gerekçesi' WHERE id = $1`,
      [s, u.buyer.id]), '23514'));
    await withTenant(h.pool, internalA(), (tx) => tx.query(`UPDATE suppliers SET reactivated_by = $2, reactivated_at = now(), reactivation_reason = 'Sentetik yeniden açma gerekçesi' WHERE id = $1`,
      [s, u.masterData.id]));
    await withTenant(h.pool, internalA(), (tx) => rejects(tx.query(`UPDATE suppliers SET deactivated_by = $2, deactivated_at = now(), deactivation_reason = 'kısa' WHERE id = $1`,
      [h.world.suppliers.s3, u.buyer.id]), '23514'));
  });

  it('settings_types_reminders_tenant_isolated', async () => {
    const reminder = (await h.owner.query<{ id: string }>(`INSERT INTO supplier_document_reminders (tenant_id, document_id, offset_days, due_on)
      SELECT tenant_id, id, 30, valid_until - 30 FROM supplier_documents WHERE tenant_id = $1 AND valid_until IS NOT NULL AND supplier_id IS NOT NULL LIMIT 1 RETURNING id`,
      [h.world.tenantA])).rows[0]!.id;
    await withTenant(h.pool, internalA(), async (tx) => {
      expect(await count(tx, `supplier_application_settings`)).toBe(1);
      expect(await count(tx, `supplier_document_reminders WHERE id = $1`, [reminder])).toBe(1);
      await rejects(tx.query(`INSERT INTO supplier_document_reminders (tenant_id, document_id, offset_days, due_on)
        SELECT tenant_id, document_id, offset_days, due_on FROM supplier_document_reminders WHERE id = $1`, [reminder]), '23505');
    });
    await withTenant(h.pool, internalB(), async (tx) => {
      expect((await tx.query<{ tenant_id: string }>(`SELECT tenant_id FROM supplier_application_settings`)).rows.map((r) => r.tenant_id)).toEqual([h.world.tenantB]);
      expect(await count(tx, `supplier_document_types WHERE tenant_id = $1`, [h.world.tenantA])).toBe(0);
      expect(await count(tx, `supplier_document_reminders WHERE id = $1`, [reminder])).toBe(0);
      expect(await count(tx, `supplier_applications WHERE tenant_id = $1`, [h.world.tenantA])).toBe(0);
    });
    await withTenant(h.pool, supplierCtx('supplier1', h.world.suppliers.s1), async (tx) => {
      expect(await count(tx, `supplier_application_settings`)).toBe(0);
      expect(await count(tx, `supplier_document_reminders`)).toBe(0);
    });
  });

  it('email_outbox_round_invite_unique_only_for_invites', async () => {
    const roundId = randomUUID(); const to = `portal-${rand()}@example.test`;
    const ins = (type: string) => withTenant(h.pool, internalA(), (tx) => tx.query(`INSERT INTO email_outbox (tenant_id, to_email, subject, body_text, related_type, related_id, status)
      VALUES ($1, $2, 'Teklif daveti: Sentetik proje', 'Gövde', $3, $4, 'NOT_CONFIGURED')`, [h.world.tenantA, to, type, roundId]));
    await ins('rfq_round_invite');
    await rejects(ins('rfq_round_invite'), '23505');
    await ins('contract_reminder');
    await ins('contract_reminder');
  });
});
