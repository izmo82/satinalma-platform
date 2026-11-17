// v2 Faz 8 (D113) Görev 5: ERP'den okuyan akışlar — tedarikçi kodu (VKN eşleşmesi, R12 yeni kart yok, R6 elle değer korunur),
// masraf merkezi (departmana otomatik atama yok), sipariş, fatura içe alımı (ERP kaynaklı kayıt, elle faturaya bağlama, Faz 7 eşleştiricisi,
// aynı fatura iki kez tek satır), ödeme durumu (elle değer korunur), bozuk tutar satırı reddi (PARTIAL), kapalı özellik / sağlayıcı yok /
// yetkisiz isteyen (istek atılmaz, çalışma RUNNING kalmaz), zamanlama (isDue; DAILY günde bir), demo faturalar hiç değişmez.
// Tüm veri sentetiktir; bütün kontroller TAKLİT SAĞLAYICIYLA DENENDİ (gerçek Oracle değil). Gerçek Oracle EBS kontrolleri NOT_RUN.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { ERP_FEATURE_CATALOG, syntheticVkn, type ErpFeature } from '@sp/domain';
import type { ErpConfig } from '../src/config.ts';
import { withoutTenant, withTenant, type TenantContext } from '../src/db.ts';
import { erpProvider, type ErpProvider, type ErpProviderKind } from '../src/erp/providers.ts';
import { enqueueTenantErpReads, importErpInvoice, runErpReadJob, PROTECTED_DEMO_INVOICES } from '../src/modules/erpRead.ts';
import { makeHarness } from './harness.ts';

const KEY = Buffer.alloc(32, 7);
const SECRET = 'Sentetik-ERP-Okuma-Parola-5Z!q';
const MOCK_NOTE = 'taklit sağlayıcıyla denendi — gerçek Oracle değil';
const erpCfg = (): ErpConfig => ({ provider: 'taklit', secretKey: KEY, allowedHosts: ['erp.example.test'] });
let h: Awaited<ReturnType<typeof makeHarness>>;
const rand = () => randomUUID().slice(0, 8);
const one = async <T = any>(sql: string, params: unknown[] = []) => (await h.owner.query(sql, params)).rows[0] as T;
const rows = async <T = any>(sql: string, params: unknown[] = []) => (await h.owner.query(sql, params)).rows as T[];
const VKN = [syntheticVkn('930000001'), syntheticVkn('930000002'), syntheticVkn('930000003')];
const sup: string[] = [];
let demoSnapshot: string[] = [];
const demoRows = async () => (await rows<{ j: string }>(`SELECT row_to_json(i)::text AS j FROM invoices i WHERE invoice_no = ANY($1) ORDER BY id`,
  [[...PROTECTED_DEMO_INVOICES]])).map((r) => r.j);

// Casus sağlayıcı: taklidi sarar, okuma çağrılarını sayar. INVOICE kaydına alıcı şirket VKN'si eklenir (kiracıda iki şirket var; şirket
// tahmin edilmez), PAYMENT_STATUS'a demo faturalı bir satır eklenir (değişmemeli).
const calls = { read: 0 };
const resolver = (kind: ErpProviderKind): ErpProvider | null => {
  const p = erpProvider(kind, h.config);
  if (!p) return null;
  return {
    ...p,
    read: async (ep, f, cursor) => {
      calls.read++;
      const r = await p.read(ep, f, cursor);
      let records = r.records as Record<string, unknown>[];
      if (f === 'INVOICE') records = records.map((x) => ({ ...x, ORG_TAX_ID: h.world.companyA1.vkn }));
      // Sipariş 1'in ERP sözleşme no'su (Faz 7 ERP_REF: fatura sipariş ref → ERP siparişi → sözleşme).
      if (f === 'PURCHASE_ORDER') records = records.map((x) => (x.SEGMENT1 === 'TKL2026PO0001' ? { ...x, CONTRACT_NUM: familyCode } : x));
      if (f === 'PAYMENT_STATUS' && cursor === null) {
        records = [...records, { INVOICE_NUM: PROTECTED_DEMO_INVOICES[0], TAX_REGISTRATION_NUM: VKN[0], PAYMENT_STATUS_FLAG: 'Y', AMOUNT_PAID: '1.00', CHECK_DATE: '2026-11-01' }];
      }
      return { ...r, records };
    },
  };
};

const url = (f: string, rest = '') => `/api/v1/integration/endpoints/${f}${rest}`;
const fieldMap = (f: ErpFeature) => (f === 'INVOICE'
  ? { ...ERP_FEATURE_CATALOG.INVOICE.ebsDefaultMap, companyTaxId: { path: 'ORG_TAX_ID', transform: 'TRIM' as const } }
  : f === 'PURCHASE_ORDER' ? { ...ERP_FEATURE_CATALOG.PURCHASE_ORDER.ebsDefaultMap, contractRef: { path: 'CONTRACT_NUM', transform: 'TRIM' as const } }
    : ERP_FEATURE_CATALOG[f].ebsDefaultMap);
async function configure(f: ErpFeature, extra: Record<string, unknown> = {}) {
  const r = await h.call('tenantAdmin', 'PUT', url(f), { body: { enabled: true, baseUrl: 'taklit://ok', resourcePath: '/webservices/rest/sentetik', authType: 'BASIC',
    username: 'sentetik_kullanici', secret: SECRET, fieldMap: fieldMap(f), schedule: { mode: 'MANUAL' }, ...extra } });
  expect(r.status, JSON.stringify(r.body)).toBe(200);
}
const memberOf = async (userId: string) => (await one<{ roles: string[] } | undefined>(`SELECT roles FROM memberships WHERE tenant_id = $1 AND user_id = $2`,
  [h.world.tenantA, userId]));
const jobOf = (runId: string) => one<{ id: string; tenant_id: string; requested_by: string | null; status: string; error_code: string | null }>(
  `SELECT id, tenant_id, requested_by, status, error_code FROM jobs WHERE tenant_id = $1 AND kind = 'erp.read' AND payload->>'runId' = $2`, [h.world.tenantA, runId]);
const runOf = (runId: string) => one<{ status: string; mock: boolean; provider_kind: string | null; counts: Record<string, number>; trigger: string; finished_at: Date | null }>(
  `SELECT status, mock, provider_kind, counts, trigger, finished_at FROM integration_runs WHERE id = $1`, [runId]);
const errorsOf = (runId: string) => rows<{ record_key: string | null; code: string; message: string; payload_sha256: string | null }>(
  `SELECT record_key, code, message, payload_sha256 FROM integration_run_errors WHERE run_id = $1 ORDER BY created_at, id`, [runId]);

/** "Şimdi çalıştır" (API) + işçi işi (runErpReadJob; isteyenin güncel üyeliği). */
async function runRead(f: ErpFeature) {
  const r = await h.call('tenantAdmin', 'POST', url(f, '/run'));
  expect(r.status, JSON.stringify(r.body)).toBe(202);
  const runId = r.body.runId as string;
  if (r.body.status === 'NOT_CONFIGURED') return { runId, run: await runOf(runId), errors: await errorsOf(runId), api: r.body };
  const job = await jobOf(runId);
  await runErpReadJob(h.pool, job, await memberOf(job.requested_by!), { config: h.config, provider: resolver });
  return { runId, run: await runOf(runId), errors: await errorsOf(runId), api: r.body, job: await jobOf(runId) };
}

async function contract(supplierId: string) {
  const w = h.world;
  const company = w.companyA1.id;
  const projectId = (await one<{ id: string }>(`INSERT INTO projects (tenant_id, company_id, code, title, category, owner_user_id, created_by, department_id)
    VALUES ($1,$2,$3,'ERP okuma projesi (SENTETİK)','Genel',$4,$4,$5) RETURNING id`, [w.tenantA, company, `PRJ-ER-${rand()}`, w.users.buyer.id, w.departments.bt])).id;
  const doc = (await one<{ id: string }>(`INSERT INTO documents (tenant_id, company_id, kind, title, created_by, code) VALUES ($1,$2,'CONTRACT',$3,$4,$5) RETURNING id`,
    [w.tenantA, company, `ERP okuma sözleşmesi ${rand()} (SENTETİK)`, w.users.buyer.id, `BLG-ER-${rand()}`])).id;
  const dv = (await one<{ id: string }>(`INSERT INTO document_versions (tenant_id, company_id, document_id, version_no, sha256, mime_type, size_bytes, storage_key,
      original_filename, basic_check_status, created_by) VALUES ($1,$2,$3,1,$4,'application/pdf',100,$5,'sozlesme.pdf','PASSED',$6) RETURNING id`,
    [w.tenantA, company, doc, 'e'.repeat(64), `tenant/${randomUUID()}`, w.users.buyer.id])).id;
  const familyId = (await one<{ id: string }>(`INSERT INTO contract_families (tenant_id, company_id, title, supplier_id, created_by, code, department_id, intake_flow,
      project_id, contract_type, owner_user_id, signed_on) VALUES ($1,$2,$3,$4,$5,$6,$7,true,$8,'SERVICE',$9,'2026-01-01') RETURNING id`,
    [w.tenantA, company, `ERP okuma sözleşmesi ${rand()} (SENTETİK)`, supplierId, w.users.buyer.id, `SZL-ER-${rand()}`, w.departments.bt, projectId, w.users.buyer.id])).id;
  const cvId = (await one<{ id: string }>(`INSERT INTO contract_versions (tenant_id, company_id, family_id, version_no, document_version_id, created_by)
    VALUES ($1,$2,$3,1,$4,$5) RETURNING id`, [w.tenantA, company, familyId, dv, w.users.buyer.id])).id;
  const termsId = (await one<{ id: string }>(`INSERT INTO contract_terms (tenant_id, company_id, contract_version_id, revision, currency, value_type, amount,
      start_date, end_date, source_ref, entered_by, limit_basis) VALUES ($1,$2,$3,1,'TRY','FIXED','500000.00','2026-01-01','2026-12-31','Madde 1 (sentetik)',$4,'NET') RETURNING id`,
    [w.tenantA, company, cvId, w.users.buyer.id])).id;
  const c = (await one<{ id: string }>(`INSERT INTO contract_approval_chains (tenant_id, family_id, version_id, terms_id, submitted_by) VALUES ($1,$2,$3,$4,$5) RETURNING id`,
    [w.tenantA, familyId, cvId, termsId, w.users.buyer.id])).id;
  await h.owner.query(`UPDATE contract_approval_chains SET closed_at = now(), outcome = 'APPROVED' WHERE id = $1`, [c]);
  return familyId;
}
const invByNo = (no: string) => rows<any>(`SELECT * FROM invoices WHERE tenant_id = $1 AND invoice_no = $2`, [h.world.tenantA, no]);

let familyId = '';
let familyCode = '';
let manualInvoice = '';
let demoInvoice = '';

beforeAll(async () => {
  h = await makeHarness({ erp: erpCfg() });
  demoSnapshot = await demoRows();
  // Taklit tedarikçi VKN'leri (930000001–3) ile sentetik kartlar (dünya tohumunda aynı VKN varsa o kart kullanılır).
  for (const [i, v] of VKN.entries()) {
    const ex = await one<{ id: string } | undefined>(`SELECT id FROM suppliers WHERE tenant_id = $1 AND tax_id = $2`, [h.world.tenantA, v]);
    sup.push(ex?.id ?? (await one<{ id: string }>(`INSERT INTO suppliers (tenant_id, status, country, tax_id_type, tax_id, legal_name, created_by, activated_by, activated_at)
      VALUES ($1,'ACTIVE','TR','VKN',$2,$3,$4,$5,now()) RETURNING id`, [h.world.tenantA, v, `ERP Okuma Tedarikçi ${i + 1} (SENTETİK)`, h.world.users.buyer.id,
      h.world.users.masterData.id])).id);
  }
  familyId = await contract(sup[0]!);
  familyCode = (await one<{ code: string }>(`SELECT code FROM contract_families WHERE id = $1`, [familyId])).code;
  // Elle girilmiş (R12 bağlanacak) fatura: taklit TKL2026000003 ile aynı tedarikçi + numara; net tutar ERP'dekinden farklı.
  const m = await h.call('finance', 'POST', '/api/v1/invoices', { body: { companyId: h.world.companyA1.id, supplierId: sup[1], kind: 'INVOICE', invoiceNo: 'TKL2026000003',
    issueDate: '2026-10-25', currency: 'TRY', lines: [{ description: 'Elle girilen hizmet (SENTETİK)', quantity: '1', unit: 'adet', unitPrice: '48000.00', netAmount: '48000.00', taxRate: '20' }] } });
  expect(m.status, JSON.stringify(m.body)).toBe(201);
  manualInvoice = m.body.id;
  // Kiracıda demo numaralı elle fatura (ERP okumaları hiç dokunmamalı).
  const d = await h.call('finance', 'POST', '/api/v1/invoices', { body: { companyId: h.world.companyA1.id, supplierId: sup[0], kind: 'INVOICE', invoiceNo: PROTECTED_DEMO_INVOICES[0],
    issueDate: '2026-03-01', currency: 'TRY', lines: [{ description: 'Demo kopyası (SENTETİK)', quantity: '1', unit: 'adet', unitPrice: '100.00', netAmount: '100.00', taxRate: '20' }] } });
  expect(d.status, JSON.stringify(d.body)).toBe(201);
  demoInvoice = d.body.id;
});
afterAll(async () => { await h?.close(); });

describe('SUPPLIER okuma (taklitle denendi)', () => {
  it('VKN eşleşen karta kod ERP kaynağıyla yazılır; eşleşmeyen hata kaydında, yeni tedarikçi açılmaz', async () => {
    const before = (await one<{ n: number }>(`SELECT count(*)::int AS n FROM suppliers WHERE tenant_id = $1`, [h.world.tenantA])).n;
    await configure('SUPPLIER');
    const r = await runRead('SUPPLIER');
    expect(r.run).toMatchObject({ status: 'PARTIAL', mock: true, provider_kind: 'TAKLIT', trigger: 'MANUAL' });
    expect(r.run.counts).toMatchObject({ read: 4, updated: 3, failed: 1, requestSent: true });
    expect(r.job!.status).toBe('SUCCEEDED');
    const s = await rows<{ id: string; erp_supplier_code: string; erp_supplier_code_source: string }>(
      `SELECT id, erp_supplier_code, erp_supplier_code_source FROM suppliers WHERE id = ANY($1) ORDER BY tax_id`, [sup]);
    expect(s.map((x) => [x.erp_supplier_code, x.erp_supplier_code_source])).toEqual([['TKL-SUP-1001', 'ERP'], ['TKL-SUP-1002', 'ERP'], ['TKL-SUP-1003', 'ERP']]);
    expect(r.errors).toEqual([expect.objectContaining({ code: 'supplier_not_matched', record_key: syntheticVkn('930000099') })]);
    expect(r.errors[0]!.payload_sha256).toMatch(/^[0-9a-f]{64}$/);
    expect((await one<{ n: number }>(`SELECT count(*)::int AS n FROM suppliers WHERE tenant_id = $1`, [h.world.tenantA])).n).toBe(before);
    expect((await one<{ n: number }>(`SELECT count(*)::int AS n FROM suppliers WHERE tax_id = $1`, [syntheticVkn('930000099')])).n).toBe(0);
    // Çalışma listesinde taklit etiketi; sır hiçbir hata iletisinde yok.
    const list = await h.call('auditor', 'GET', url('SUPPLIER', '/runs'));
    expect(list.body.items[0]).toMatchObject({ id: r.runId, status: 'PARTIAL', mock: true, statusLabel: `Kısmen başarılı (${MOCK_NOTE})` });
    expect(JSON.stringify(r.errors)).not.toContain(SECRET);
  });

  it('elle girilmiş kod ezilmez (CONFLICT_MANUAL); ERP kodu aynıysa değişmez', async () => {
    await h.owner.query(`UPDATE suppliers SET erp_supplier_code = 'ELLE-0002', erp_supplier_code_source = 'MANUAL' WHERE id = $1`, [sup[1]]);
    const r = await runRead('SUPPLIER');
    expect(r.run.status).toBe('PARTIAL');
    expect(r.run.counts).toMatchObject({ read: 4, unchanged: 2, skipped: 1, failed: 1, updated: 0 });
    expect(await one(`SELECT erp_supplier_code, erp_supplier_code_source FROM suppliers WHERE id = $1`, [sup[1]]))
      .toEqual({ erp_supplier_code: 'ELLE-0002', erp_supplier_code_source: 'MANUAL' });
    const c = r.errors.find((e) => e.code === 'CONFLICT_MANUAL')!;
    expect(c.message).toContain('Elle girilen değerle çelişiyor');
    expect(c.record_key).toBe(VKN[1]);
  });
});

describe('COST_CENTER ve PURCHASE_ORDER okuma (taklitle denendi)', () => {
  it('masraf merkezleri eklenir, tekrar okumada değişmez; departmana otomatik atama yok', async () => {
    await configure('COST_CENTER');
    const r1 = await runRead('COST_CENTER');
    expect(r1.run).toMatchObject({ status: 'SUCCESS', mock: true });
    expect(r1.run.counts).toMatchObject({ read: 3, created: 3 });
    expect(await rows(`SELECT code, name, active, provider_kind FROM erp_cost_centers WHERE tenant_id = $1 ORDER BY code`, [h.world.tenantA])).toEqual([
      { code: 'TKL-MM-100', name: 'Bilgi Teknolojileri (taklit)', active: true, provider_kind: 'TAKLIT' },
      { code: 'TKL-MM-200', name: 'Finans (taklit)', active: true, provider_kind: 'TAKLIT' },
      { code: 'TKL-MM-300', name: 'İdari İşler (taklit)', active: false, provider_kind: 'TAKLIT' }]);
    const r2 = await runRead('COST_CENTER');
    expect(r2.run.counts).toMatchObject({ read: 3, unchanged: 3, created: 0 });
    expect((await one<{ n: number }>(`SELECT count(*)::int AS n FROM departments WHERE tenant_id = $1 AND cost_center_code IS NOT NULL`, [h.world.tenantA])).n).toBe(0);
    const api = await h.call('tenantAdmin', 'GET', '/api/v1/integration/erp/cost-centers');
    expect(api.status).toBe(200);
    expect(api.body.items[0]).toMatchObject({ code: 'TKL-MM-100', activeLabel: 'Etkin', provider: { kind: 'TAKLIT', label: 'Taklit Oracle (gerçek değil)', real: false } });
  });

  it('taklit://bozuk-tutar: bozuk tutarlı sipariş reddedilir (yuvarlanmaz), diğeri işlenir → PARTIAL; sonra düzgün okumada eklenir', async () => {
    await configure('PURCHASE_ORDER', { baseUrl: 'taklit://bozuk-tutar' });
    const r = await runRead('PURCHASE_ORDER');
    expect(r.run.status).toBe('PARTIAL');
    expect(r.run.counts).toMatchObject({ read: 2, created: 1, failed: 1 });
    expect(r.errors).toEqual([expect.objectContaining({ code: 'invalid_decimal', record_key: 'TKL2026PO0002' })]);
    expect(await rows(`SELECT po_no FROM erp_purchase_orders WHERE tenant_id = $1`, [h.world.tenantA])).toEqual([{ po_no: 'TKL2026PO0001' }]);
    await configure('PURCHASE_ORDER', { baseUrl: 'taklit://ok' });
    const ok = await runRead('PURCHASE_ORDER');
    expect(ok.run.status).toBe('SUCCESS');
    expect(ok.run.counts).toMatchObject({ read: 2, created: 1, unchanged: 1 });
    expect(await rows(`SELECT erp_po_id, po_no, supplier_id, erp_supplier_code, amount, currency, order_date::text AS order_date FROM erp_purchase_orders
      WHERE tenant_id = $1 ORDER BY po_no`, [h.world.tenantA])).toEqual([
      { erp_po_id: '700001', po_no: 'TKL2026PO0001', supplier_id: sup[0], erp_supplier_code: 'TKL-SUP-1001', amount: '125000.00', currency: 'TRY', order_date: '2026-09-15' },
      { erp_po_id: '700002', po_no: 'TKL2026PO0002', supplier_id: sup[1], erp_supplier_code: 'ELLE-0002', amount: '48000.50', currency: 'TRY', order_date: '2026-10-02' }]);
  });
});

describe('INVOICE okuma (taklitle denendi) + Faz 7 eşleştiricisi', () => {
  it('bozuk tutar reddedilir, diğerleri işlenir (PARTIAL); ERP faturası açılır ve sözleşmeye bağlanır; elle fatura bağlanır (LINKED, ikinci kayıt yok)', async () => {
    await configure('INVOICE', { baseUrl: 'taklit://bozuk-tutar' });
    const r = await runRead('INVOICE');
    expect(r.run.status).toBe('PARTIAL');
    expect(r.run.counts).toMatchObject({ read: 3, created: 1, updated: 1, failed: 1 });
    expect(r.errors.find((e) => e.record_key === 'TKL2026000002')).toMatchObject({ code: 'invalid_decimal' });
    expect(await invByNo('TKL2026000002')).toHaveLength(0);

    const [a] = await invByNo('TKL2026000001');
    expect(a).toMatchObject({ supplier_id: sup[0], company_id: h.world.companyA1.id, erp_invoice_id: '800001', erp_provider_kind: 'TAKLIT',
      erp_order_ref: 'TKL2026PO0001', erp_order_ref_source: 'ERP', contract_family_id: familyId, match_method: 'ERP_REF', auto_match: true });
    expect((await rows(`SELECT net_amount::text AS net, tax_amount::text AS tax, trim_scale(tax_rate)::text AS rate FROM invoice_lines WHERE invoice_id = $1`, [a.id])))
      .toEqual([{ net: '50000.00', tax: '10000.00', rate: '20' }]);
    expect(a.declared_payable).toBe('60000.00');
    expect((await one(`SELECT source, duplicate FROM invoice_intake_events WHERE invoice_id = $1`, [a.id]))).toEqual({ source: 'erp', duplicate: false });

    // R12: elle girilmiş TKL2026000003 bağlandı; ikinci satır yok, tutar değişmedi, fark hata kaydında.
    const linked = await invByNo('TKL2026000003');
    expect(linked).toHaveLength(1);
    expect(linked[0]).toMatchObject({ id: manualInvoice, erp_invoice_id: '800003', erp_provider_kind: 'TAKLIT', erp_order_ref: 'TKL2026PO0002', erp_order_ref_source: 'ERP' });
    expect((await one(`SELECT net_amount::text AS net FROM invoice_lines WHERE invoice_id = $1`, [manualInvoice])).net).toBe('48000.00');
    expect(r.errors.find((e) => e.code === 'amount_differs')).toMatchObject({ record_key: 'TKL2026000003' });

    // Detay ve liste kaynağı gösterir (taklit "gerçek değil").
    const det = await h.call('finance', 'GET', `/api/v1/invoices/${a.id}`);
    expect(det.body.erpSource).toMatchObject({ kind: 'ERP', label: 'Taklit Oracle (gerçek değil)', erp: { invoiceId: '800001', providerKind: 'TAKLIT', real: false } });
    const det3 = await h.call('finance', 'GET', `/api/v1/invoices/${manualInvoice}`);
    expect(det3.body.erpSource).toMatchObject({ kind: 'MANUAL', label: 'Elle', erp: { invoiceId: '800003' } });
    const list = await h.call('finance', 'GET', '/api/v1/invoices');
    expect(list.body.items?.find?.((x: any) => x.id === a.id)?.sourceLabel ?? (list.body as any[]).find((x: any) => x.id === a.id)?.sourceLabel).toBe('Taklit Oracle (gerçek değil)');
  });

  it('düzgün okuma: eksik fatura açılır; aynı faturalar ikinci kez → UNCHANGED, tek satır', async () => {
    await configure('INVOICE', { baseUrl: 'taklit://ok' });
    const r = await runRead('INVOICE');
    expect(r.run.status).toBe('SUCCESS'); // bağlı faturalar aynı ERP kimliğiyle UNCHANGED (tutar farkı yalnız bağlamada yazıldı)
    expect(r.run.counts).toMatchObject({ read: 3, created: 1, unchanged: 2, failed: 0 });
    const r2 = await runRead('INVOICE');
    expect(r2.run.status).toBe('SUCCESS');
    expect(r2.run.counts).toMatchObject({ read: 3, unchanged: 3, created: 0, updated: 0 });
    for (const no of ['TKL2026000001', 'TKL2026000002', 'TKL2026000003']) expect(await invByNo(no), no).toHaveLength(1);
    expect((await invByNo('TKL2026000002'))[0]).toMatchObject({ contract_family_id: familyId, erp_invoice_id: '800002' });
  });

  it('importErpInvoice: demo numarası, şirket belirsizliği ve eşleşmeyen tedarikçi reddedilir; aynı kayıt UNCHANGED', async () => {
    const ctx: TenantContext = { tenantId: h.world.tenantA, userId: h.world.users.tenantAdmin.id, roles: ['ADMIN'], companyIds: [h.world.companyA1.id, h.world.companyA2.id],
      departmentIds: [], allDepartments: true, correlationId: 'test-erp-import' };
    const base = { erpInvoiceId: `X-${rand()}`, invoiceNo: `SNT${rand()}`, supplierTaxId: VKN[0]!, erpSupplierCode: null, issueDate: '2026-10-10', currency: 'TRY',
      netAmount: '100.00', grossAmount: '120.00', contractRef: null, poRef: null, companyTaxId: h.world.companyA1.vkn };
    const res = await withTenant(h.pool, ctx, async (tx) => ({
      demo: await importErpInvoice(tx, ctx, { ...base, invoiceNo: PROTECTED_DEMO_INVOICES[0] }, { providerKind: 'TAKLIT' }),
      company: await importErpInvoice(tx, ctx, { ...base, companyTaxId: null }, { providerKind: 'TAKLIT' }),
      noSupplier: await importErpInvoice(tx, ctx, { ...base, supplierTaxId: syntheticVkn('930000099') }, { providerKind: 'TAKLIT' }),
      places: await importErpInvoice(tx, ctx, { ...base, grossAmount: '120.001' }, { providerKind: 'TAKLIT' }),
      first: await importErpInvoice(tx, ctx, base, { providerKind: 'TAKLIT' }),
      again: await importErpInvoice(tx, ctx, base, { providerKind: 'TAKLIT' }),
    }));
    expect(res.demo).toMatchObject({ outcome: 'REJECTED', code: 'demo_invoice_protected', invoiceId: null });
    expect(res.company).toMatchObject({ outcome: 'REJECTED', code: 'company_unresolved' });
    expect(res.noSupplier).toMatchObject({ outcome: 'REJECTED', code: 'supplier_not_matched' });
    expect(res.places).toMatchObject({ outcome: 'REJECTED', code: 'invalid_decimal_places' });
    // Referanssız ERP faturası: Faz 7 aynı tedarikçi + tarih + tek yürürlükteki sözleşme.
    expect(res.first).toMatchObject({ outcome: 'CREATED', match: { state: 'MATCHED', method: 'SUPPLIER_DATE', familyId } });
    expect(res.again).toEqual({ invoiceId: res.first.invoiceId, outcome: 'UNCHANGED' });
    expect(await invByNo(base.invoiceNo)).toHaveLength(1);
  });
});

describe('PAYMENT_STATUS okuma (taklitle denendi)', () => {
  it('ödeme durumu ERP kaynağıyla yazılır; elle değer korunur (CONFLICT_MANUAL); demo fatura değişmez; v1 ödeme durumu değişmez', async () => {
    const [i3] = await invByNo('TKL2026000003');
    await h.owner.query(`UPDATE invoices SET erp_payment_status = 'PAID', erp_payment_status_at = '2026-11-12', erp_payment_source = 'MANUAL' WHERE id = $1`, [i3.id]);
    const demoBefore = (await one(`SELECT row_to_json(i)::text AS j FROM invoices i WHERE id = $1`, [demoInvoice])).j;
    await configure('PAYMENT_STATUS');
    const r = await runRead('PAYMENT_STATUS');
    expect(r.run.status).toBe('PARTIAL');
    expect(r.run.counts).toMatchObject({ read: 4, updated: 2, skipped: 1, failed: 1 });
    const st = async (no: string) => one(`SELECT erp_payment_status, erp_payment_status_at::text AS at, erp_payment_source, payment_status FROM invoices
      WHERE tenant_id = $1 AND invoice_no = $2`, [h.world.tenantA, no]);
    expect(await st('TKL2026000001')).toEqual({ erp_payment_status: 'PAID', at: '2026-11-04', erp_payment_source: 'ERP', payment_status: 'NOT_PAID' });
    expect(await st('TKL2026000002')).toEqual({ erp_payment_status: 'PARTIAL', at: '2026-11-10', erp_payment_source: 'ERP', payment_status: 'NOT_PAID' });
    expect(await st('TKL2026000003')).toEqual({ erp_payment_status: 'PAID', at: '2026-11-12', erp_payment_source: 'MANUAL', payment_status: 'NOT_PAID' });
    expect(r.errors.map((e) => e.code).sort()).toEqual(['CONFLICT_MANUAL', 'demo_invoice_protected']);
    expect((await one(`SELECT row_to_json(i)::text AS j FROM invoices i WHERE id = $1`, [demoInvoice])).j).toBe(demoBefore);
    const det = await h.call('finance', 'GET', `/api/v1/invoices/${i3.id}`);
    expect(det.body.erpSource.payment).toEqual({ status: 'PAID', statusLabel: 'Ödendi', at: '2026-11-12', source: 'MANUAL', sourceLabel: 'Elle' });
  });
});

describe('kapalı özellik, sağlayıcı yok, yetkisiz isteyen: istek atılmaz, çalışma RUNNING kalmaz', () => {
  it('kapalı özellik → NOT_CONFIGURED, iş açılmaz, sağlayıcı çağrılmaz (casus)', async () => {
    await h.call('tenantAdmin', 'PUT', url('COST_CENTER'), { body: { enabled: false } });
    const n = calls.read;
    const r = await runRead('COST_CENTER');
    expect(r.run).toMatchObject({ status: 'NOT_CONFIGURED', provider_kind: null, mock: false });
    expect(await jobOf(r.runId)).toBeUndefined();
    expect(calls.read).toBe(n);
  });

  it('iş alınmadan özellik kapatılırsa: çalışma FAILED (feature_disabled), iş FAILED, istek yok', async () => {
    await configure('COST_CENTER');
    const req = await h.call('tenantAdmin', 'POST', url('COST_CENTER', '/run'));
    expect(req.body.status).toBe('RUNNING');
    await h.call('tenantAdmin', 'PUT', url('COST_CENTER'), { body: { enabled: false } });
    const n = calls.read;
    const job = await jobOf(req.body.runId);
    await runErpReadJob(h.pool, job, await memberOf(job.requested_by!), { config: h.config, provider: resolver });
    expect(calls.read).toBe(n);
    expect(await runOf(req.body.runId)).toMatchObject({ status: 'FAILED', mock: true });
    expect((await errorsOf(req.body.runId)).map((e) => e.code)).toEqual(['feature_disabled']);
    expect((await jobOf(req.body.runId)).status).toBe('FAILED');
  });

  it('sağlayıcı kalktıysa (ERP_PROVIDER=none) ve isteyenin üyeliği yoksa: istek yok, çalışma kapanır', async () => {
    await configure('COST_CENTER');
    const a = await h.call('tenantAdmin', 'POST', url('COST_CENTER', '/run'));
    const n = calls.read;
    const none = (k: ErpProviderKind) => erpProvider(k, { env: h.config.env, erp: { ...erpCfg(), provider: 'none' } });
    const jobA = await jobOf(a.body.runId);
    await runErpReadJob(h.pool, jobA, await memberOf(jobA.requested_by!), { config: h.config, provider: none });
    expect(await runOf(a.body.runId)).toMatchObject({ status: 'FAILED' });
    expect((await errorsOf(a.body.runId)).map((e) => e.code)).toEqual(['provider_not_configured']);

    const b = await h.call('tenantAdmin', 'POST', url('COST_CENTER', '/run'));
    const jobB = await jobOf(b.body.runId);
    await runErpReadJob(h.pool, jobB, undefined, { config: h.config, provider: resolver });
    expect(calls.read).toBe(n);
    expect(await runOf(b.body.runId)).toMatchObject({ status: 'FAILED' });
    expect((await errorsOf(b.body.runId)).map((e) => e.code)).toEqual(['requester_not_authorized']);
    expect((await jobOf(b.body.runId)).status).toBe('BLOCKED');
  });
});

describe('zamanlama (R7)', () => {
  const sys = (): TenantContext => ({ tenantId: h.world.tenantA, userId: '00000000-0000-0000-0000-000000000000', roles: [], companyIds: [], departmentIds: [],
    allDepartments: true, correlationId: 'test-erp-schedule' });
  const enqueue = (now: Date, resolve: (k: ErpProviderKind) => ErpProvider | null = resolver) =>
    withTenant(h.pool, sys(), (tx) => enqueueTenantErpReads(tx, h.world.tenantA, now, resolve));

  it('DAILY 06:00 İstanbul: saatten önce yok, sonra günde bir iş + SCHEDULE çalışması; ertesi gün yeniden; kiracı kapısı listeler', async () => {
    await configure('COST_CENTER', { schedule: { mode: 'DAILY', dailyTime: '06:00' } });
    const gate = await withoutTenant(h.pool, async (c) => (await c.query<{ id: string }>(`SELECT t AS id FROM erp_read_schedule_tenants() t`)).rows.map((r) => r.id));
    expect(gate).toContain(h.world.tenantA);
    expect(await enqueue(new Date('2027-02-01T02:59:00Z'))).toBe(0); // 05:59 İstanbul
    expect(await enqueue(new Date('2027-02-01T03:00:00Z'))).toBe(1); // 06:00 İstanbul
    expect(await enqueue(new Date('2027-02-01T20:00:00Z'))).toBe(0); // aynı gün ikinci yok
    const sched = await rows<{ id: string; status: string; mock: boolean; counts: any }>(`SELECT id, status, mock, counts FROM integration_runs
      WHERE tenant_id = $1 AND feature = 'COST_CENTER' AND trigger = 'SCHEDULE' ORDER BY started_at`, [h.world.tenantA]);
    expect(sched).toHaveLength(1);
    expect(sched[0]).toMatchObject({ status: 'RUNNING', mock: true, counts: { mode: 'READ', slot: 'D:2027-02-01' } });
    const job = await one(`SELECT id, tenant_id, requested_by, idempotency_key FROM jobs WHERE tenant_id = $1 AND kind = 'erp.read' AND payload->>'runId' = $2`,
      [h.world.tenantA, sched[0]!.id]);
    expect(job.idempotency_key).toBe(`erp.read:COST_CENTER:${h.world.tenantA}:D:2027-02-01`);
    expect(job.requested_by).toBe(h.world.users.tenantAdmin.id);
    // Süren çalışma varken ertesi gün de beklenir; iş işlenince yeni yuva açılır.
    expect(await enqueue(new Date('2027-02-02T04:00:00Z'))).toBe(0);
    await runErpReadJob(h.pool, job, await memberOf(job.requested_by), { config: h.config, provider: resolver });
    expect(await runOf(sched[0]!.id)).toMatchObject({ status: 'SUCCESS', trigger: 'SCHEDULE' });
    expect(await enqueue(new Date('2027-02-02T04:00:00Z'))).toBe(1);
    const j2 = await one(`SELECT j.id, j.tenant_id, j.requested_by FROM jobs j JOIN integration_runs r ON r.id::text = j.payload->>'runId'
      WHERE r.tenant_id = $1 AND r.trigger = 'SCHEDULE' AND r.status = 'RUNNING'`, [h.world.tenantA]);
    await runErpReadJob(h.pool, j2, await memberOf(j2.requested_by), { config: h.config, provider: resolver });
  });

  it('sağlayıcı yoksa zamanlanmış okuma NOT_CONFIGURED yazılır, iş açılmaz', async () => {
    const n = (await one<{ n: number }>(`SELECT count(*)::int AS n FROM jobs WHERE tenant_id = $1 AND kind = 'erp.read'`, [h.world.tenantA])).n;
    expect(await enqueue(new Date('2027-02-03T04:00:00Z'), () => null)).toBe(0);
    expect((await one<{ n: number }>(`SELECT count(*)::int AS n FROM jobs WHERE tenant_id = $1 AND kind = 'erp.read'`, [h.world.tenantA])).n).toBe(n);
    const last = await one(`SELECT status, provider_kind, trigger, counts FROM integration_runs WHERE tenant_id = $1 AND feature = 'COST_CENTER' ORDER BY started_at DESC LIMIT 1`,
      [h.world.tenantA]);
    expect(last).toMatchObject({ status: 'NOT_CONFIGURED', provider_kind: null, trigger: 'SCHEDULE', counts: { reason: 'provider_not_configured', slot: 'D:2027-02-03' } });
    await h.call('tenantAdmin', 'PUT', url('COST_CENTER'), { body: { schedule: { mode: 'MANUAL' } } });
  });
});

describe('genel güvenceler', () => {
  it('hiçbir çalışma RUNNING kalmadı; demo faturalar (tüm veritabanında) değişmedi; hata iletilerinde sır yok', async () => {
    expect((await rows(`SELECT id FROM integration_runs WHERE tenant_id = $1 AND status = 'RUNNING'`, [h.world.tenantA]))).toEqual([]);
    const now = (await demoRows()).filter((j) => !j.includes(demoInvoice));
    expect(now).toEqual(demoSnapshot);
    const all = await rows<{ message: string }>(`SELECT e.message FROM integration_run_errors e JOIN integration_runs r ON r.id = e.run_id WHERE r.tenant_id = $1`, [h.world.tenantA]);
    expect(all.length).toBeGreaterThan(0);
    for (const e of all) expect(e.message).not.toContain(SECRET);
    const audits = await rows<{ t: string }>(`SELECT data::text AS t FROM audit_events WHERE tenant_id = $1 AND action IN ('integration.endpoint.read_finished','invoice.erp_imported',
      'invoice.erp_linked','supplier.erp_code_set','invoice.erp_payment_status')`, [h.world.tenantA]);
    expect(audits.length).toBeGreaterThan(5);
    for (const a of audits) expect(a.t).not.toContain(SECRET);
  });
});
