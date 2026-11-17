// v2 Faz 8 (D113) Görev 6: elle ERP kayıtları (R6) — tedarikçi ERP kodu (Satınalma), departman masraf merkezi (Yönetici), "ERP'ye elle
// iletildi" + referans (Satınalma; açık yazma kaydını kapatır, sonra işçi istek atmaz), fatura ERP ödeme durumu (bilgi; sonraki ERP
// okumasında korunur), detay ekranı durumu. Hepsi `source = 'MANUAL'` ve denetimli; Departman kullanıcısı yazamaz (403); demo faturalar değişmez.
// Tüm veri sentetiktir; ERP okuması TAKLİT SAĞLAYICIYLA DENENDİ (gerçek Oracle değil).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { ERP_FEATURE_CATALOG, syntheticVkn } from '@sp/domain';
import type { ErpConfig } from '../src/config.ts';
import { erpProvider, type ErpProvider, type ErpProviderKind } from '../src/erp/providers.ts';
import { PROTECTED_DEMO_INVOICES, runErpReadJob } from '../src/modules/erpRead.ts';
import { runErpWriteJob } from '../src/modules/erpWrite.ts';
import { makeHarness } from './harness.ts';

const KEY = Buffer.alloc(32, 5);
const SECRET = 'Sentetik-ERP-Elle-Parola-3T!z';
const erpCfg = (): ErpConfig => ({ provider: 'taklit', secretKey: KEY, allowedHosts: ['erp.example.test'] });
let h: Awaited<ReturnType<typeof makeHarness>>;
const rand = () => randomUUID().slice(0, 8);
const one = async <T = any>(sql: string, params: unknown[] = []) => (await h.owner.query(sql, params)).rows[0] as T;
const rows = async <T = any>(sql: string, params: unknown[] = []) => (await h.owner.query(sql, params)).rows as T[];
const audits = (action: string, entityId: string) => rows<{ data: any; actor_user_id: string; reason: string | null }>(
  `SELECT data, actor_user_id, reason FROM audit_events WHERE tenant_id = $1 AND action = $2 AND entity_id = $3 ORDER BY id`, [h.world.tenantA, action, entityId]);
const calls = { find: 0, write: 0 };
const resolver = (kind: ErpProviderKind): ErpProvider | null => {
  const p = erpProvider(kind, h.config);
  if (!p) return null;
  return { ...p, find: async (...a) => { calls.find++; return p.find(...a); }, write: async (...a) => { calls.write++; return p.write(...a); } };
};
const VKN1 = syntheticVkn('930000001');
let sup1 = '';
let sup2 = '';
let projectId = '';
let familyId = '';
let invoiceId = '';
let demoInvoice = '';
let demoSnapshot = '';

beforeAll(async () => {
  h = await makeHarness({ erp: erpCfg() });
  const w = h.world;
  const ex = await one<{ id: string } | undefined>(`SELECT id FROM suppliers WHERE tenant_id = $1 AND tax_id = $2`, [w.tenantA, VKN1]);
  sup1 = ex?.id ?? (await one<{ id: string }>(`INSERT INTO suppliers (tenant_id, status, country, tax_id_type, tax_id, legal_name, created_by, activated_by, activated_at)
    VALUES ($1,'ACTIVE','TR','VKN',$2,'ERP Elle Tedarikçi 1 (SENTETİK)',$3,$4,now()) RETURNING id`, [w.tenantA, VKN1, w.users.buyer.id, w.users.masterData.id])).id;
  sup2 = (await one<{ id: string }>(`INSERT INTO suppliers (tenant_id, status, country, tax_id_type, tax_id, legal_name, created_by, activated_by, activated_at)
    VALUES ($1,'ACTIVE','TR','VKN',$2,'ERP Elle Tedarikçi 2 (SENTETİK)',$3,$4,now()) RETURNING id`,
    [w.tenantA, syntheticVkn(`93${String(Math.floor(Math.random() * 1e7)).padStart(7, '0')}`), w.users.buyer.id, w.users.masterData.id])).id;
  projectId = (await one<{ id: string }>(`INSERT INTO projects (tenant_id, company_id, code, title, category, owner_user_id, created_by, department_id)
    VALUES ($1,$2,$3,'ERP elle projesi (SENTETİK)','Genel',$4,$4,$5) RETURNING id`, [w.tenantA, w.companyA1.id, `PRJ-EM-${rand()}`, w.users.buyer.id, w.departments.bt])).id;
  familyId = (await one<{ id: string }>(`INSERT INTO contract_families (tenant_id, company_id, title, supplier_id, created_by, code, department_id, intake_flow, project_id)
    VALUES ($1,$2,'ERP elle sözleşmesi (SENTETİK)',$3,$4,$5,$6,true,$7) RETURNING id`, [w.tenantA, w.companyA1.id, sup1, w.users.buyer.id, `SZL-EM-${rand()}`, w.departments.bt, projectId])).id;
  // Taklit ödeme durumu satırıyla aynı tedarikçi + fatura no (TKL2026000001, ERP'de "Y" = Ödendi).
  const inv = await h.call('finance', 'POST', '/api/v1/invoices', { body: { companyId: w.companyA1.id, supplierId: sup1, kind: 'INVOICE', invoiceNo: 'TKL2026000001',
    issueDate: '2026-10-05', currency: 'TRY', lines: [{ description: 'Elle girilen hizmet (SENTETİK)', quantity: '1', unit: 'adet', unitPrice: '50000.00', netAmount: '50000.00', taxRate: '20' }] } });
  expect(inv.status, JSON.stringify(inv.body)).toBe(201);
  invoiceId = inv.body.id;
  const d = await h.call('finance', 'POST', '/api/v1/invoices', { body: { companyId: w.companyA1.id, supplierId: sup1, kind: 'INVOICE', invoiceNo: PROTECTED_DEMO_INVOICES[1],
    issueDate: '2026-03-01', currency: 'TRY', lines: [{ description: 'Demo kopyası (SENTETİK)', quantity: '1', unit: 'adet', unitPrice: '100.00', netAmount: '100.00', taxRate: '20' }] } });
  expect(d.status, JSON.stringify(d.body)).toBe(201);
  demoInvoice = d.body.id;
  demoSnapshot = (await one<{ j: string }>(`SELECT row_to_json(i)::text AS j FROM invoices i WHERE id = $1`, [demoInvoice])).j;
});
afterAll(async () => { await h?.close(); });

describe('tedarikçi ERP kodu (elle, Satınalma)', () => {
  it('Satınalma yazar (kaynak Elle, denetimli); Departman kullanıcısı ve Denetçi 403; aynı kod ikinci karta 409; temizlenebilir', async () => {
    const u = `/api/v1/suppliers/${sup2}/erp-code`;
    expect((await h.call('security', 'PUT', u, { body: { code: 'ELLE-1001' } })).status).toBe(403);
    expect((await h.call('auditor', 'PUT', u, { body: { code: 'ELLE-1001' } })).status).toBe(403);
    expect((await h.call('buyer', 'PUT', u, { body: { code: '  ' } })).status).toBe(422);
    const r = await h.call('buyer', 'PUT', u, { body: { code: ' ELLE-1001 ' } });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body).toMatchObject({ code: 'ELLE-1001', source: 'MANUAL', sourceLabel: 'Elle', canEdit: true });
    expect(await one(`SELECT erp_supplier_code, erp_supplier_code_source FROM suppliers WHERE id = $1`, [sup2])).toEqual({ erp_supplier_code: 'ELLE-1001', erp_supplier_code_source: 'MANUAL' });
    expect((await audits('supplier.erp_code_set', sup2))[0]).toMatchObject({ actor_user_id: h.world.users.buyer.id, data: { from: null, to: 'ELLE-1001', source: 'MANUAL' } });
    const dup = await h.call('buyer', 'PUT', `/api/v1/suppliers/${sup1}/erp-code`, { body: { code: 'ELLE-1001' } });
    expect(dup.status).toBe(409);
    expect(dup.body.error.code).toBe('supplier_code_duplicate');
    const g = await h.call('security', 'GET', u);
    expect(g.status).toBe(200);
    expect(g.body).toMatchObject({ code: 'ELLE-1001', sourceLabel: 'Elle', canEdit: false });
    const clear = await h.call('buyer', 'PUT', u, { body: { code: null } });
    expect(clear.body).toMatchObject({ code: null, source: null });
    expect((await h.call('buyer', 'PUT', u, { body: { code: 'ELLE-1002' } })).status).toBe(200);
    expect((await audits('supplier.erp_code_set', sup2)).map((a) => a.data.to)).toEqual(['ELLE-1001', null, 'ELLE-1002']);
  });
});

describe('departman masraf merkezi (elle, Yönetici)', () => {
  it('Yönetici yazar (kaynak Elle, denetimli), Satınalma ve Departman kullanıcısı 403; null temizler; liste', async () => {
    const dep = h.world.departments.ik;
    const u = `/api/v1/departments/${dep}/cost-center`;
    expect((await h.call('buyer', 'PUT', u, { body: { code: 'MM-500' } })).status).toBe(403);
    expect((await h.call('security', 'PUT', u, { body: { code: 'MM-500' } })).status).toBe(403);
    const r = await h.call('tenantAdmin', 'PUT', u, { body: { code: 'MM-500' } });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body).toMatchObject({ departmentId: dep, costCenterCode: 'MM-500', source: 'MANUAL', sourceLabel: 'Elle', knownInErp: false });
    const name = (await one<{ name: string }>(`SELECT name FROM departments WHERE id = $1`, [dep])).name;
    expect(r.body.name).toBe(name); // ad değişmez (ana kaynak Entra/elle departman kaydı)
    expect((await audits('department.cost_center_set', dep))[0]!.data).toMatchObject({ to: 'MM-500', source: 'MANUAL' });
    const list = await h.call('tenantAdmin', 'GET', '/api/v1/departments/cost-centers');
    expect(list.body.items.find((x: any) => x.departmentId === dep)).toMatchObject({ costCenterCode: 'MM-500', sourceLabel: 'Elle' });
    expect((await h.call('buyer', 'GET', '/api/v1/departments/cost-centers')).status).toBe(403);
    const c = await h.call('tenantAdmin', 'PUT', u, { body: { code: null } });
    expect(c.body).toMatchObject({ costCenterCode: null, source: null });
    expect(await one(`SELECT cost_center_code, cost_center_source FROM departments WHERE id = $1`, [dep])).toEqual({ cost_center_code: null, cost_center_source: null });
  });
});

describe('"ERP\'ye elle iletildi" (Satınalma) ve detay durumu', () => {
  it('REQUISITION (proje): MANUAL satırı + referans, denetimli; Departman kullanıcısı/Denetçi 403; ikinci kez 409; tür uyumsuz 422', async () => {
    const body = { feature: 'REQUISITION', entityType: 'PROJECT', entityId: projectId, externalRef: 'REQ-ELLE-2026-001', note: 'ERP ekranından elle girildi (sentetik).' };
    expect((await h.call('security', 'POST', '/api/v1/erp/outbound/manual', { body })).status).toBe(403);
    expect((await h.call('auditor', 'POST', '/api/v1/erp/outbound/manual', { body })).status).toBe(403);
    expect((await h.call('buyer', 'POST', '/api/v1/erp/outbound/manual', { body: { ...body, entityType: 'CONTRACT_FAMILY' } })).status).toBe(422);
    const r = await h.call('buyer', 'POST', '/api/v1/erp/outbound/manual', { body });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.body).toMatchObject({ feature: 'REQUISITION', featureLabel: ERP_FEATURE_CATALOG.REQUISITION.label, status: 'MANUAL', statusLabel: 'ERP\'ye elle iletildi',
      externalRef: 'REQ-ELLE-2026-001', provider: null, mock: false, manual: { by: { id: h.world.users.buyer.id }, note: body.note } });
    const a = (await audits('erp.outbound.manual', projectId))[0]!;
    expect(a).toMatchObject({ actor_user_id: h.world.users.buyer.id, reason: body.note, data: { feature: 'REQUISITION', externalRef: 'REQ-ELLE-2026-001', source: 'MANUAL', closedPending: false } });
    const again = await h.call('buyer', 'POST', '/api/v1/erp/outbound/manual', { body });
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe('already_recorded');
    // Detay ekranı: Satınalma ve Denetçi okur (Denetçi elle kaydedemez), Departman kullanıcısı 403.
    const g = await h.call('auditor', 'GET', `/api/v1/erp/outbound?entityType=PROJECT&entityId=${projectId}`);
    expect(g.status).toBe(200);
    expect(g.body.items).toHaveLength(1);
    expect(g.body.features).toEqual([expect.objectContaining({ feature: 'REQUISITION', writeEnabled: false, latest: expect.objectContaining({ status: 'MANUAL' }) })]);
    expect(g.body.can.recordManual).toBe(false);
    expect((await h.call('security', 'GET', `/api/v1/erp/outbound?entityType=PROJECT&entityId=${projectId}`)).status).toBe(403);
    expect((await h.call('buyer', 'GET', `/api/v1/erp/outbound?entityType=PROJECT&entityId=${randomUUID()}`)).status).toBe(404);
  });

  it('açık (bekleyen) yazma kaydı elle kapatılır; sonra işçi işi istek atmadan biter', async () => {
    // Daha önce kuyruğa girmiş CONTRACT_HEADER kaydı + işi (yazma bu arada kapatılmış olabilir).
    const key = `erp:CONTRACT_HEADER:${familyId}:v1`;
    const outId = (await one<{ id: string }>(`INSERT INTO erp_outbound_records (tenant_id, feature, entity_type, entity_id, idempotency_key, status, attempts, last_error)
      VALUES ($1,'CONTRACT_HEADER','CONTRACT_FAMILY',$2,$3,'FAILED',1,$4) RETURNING id`, [h.world.tenantA, familyId, key, 'ERP\'ye yazma kapalı (R3); istek atılmadı.'])).id;
    const jobId = (await one<{ id: string }>(`INSERT INTO jobs (tenant_id, kind, idempotency_key, payload, requested_by) VALUES ($1,'erp.write',$2,$3,$4) RETURNING id`,
      [h.world.tenantA, key, JSON.stringify({ feature: 'CONTRACT_HEADER', outboundId: outId }), h.world.users.legal2.id])).id;
    const r = await h.call('buyer', 'POST', '/api/v1/erp/outbound/manual', { body: { feature: 'CONTRACT_HEADER', entityType: 'CONTRACT_FAMILY', entityId: familyId,
      externalRef: 'PO-HDR-ELLE-77' } });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.body).toMatchObject({ id: outId, status: 'MANUAL', externalRef: 'PO-HDR-ELLE-77', lastError: null, provider: null });
    expect((await audits('erp.outbound.manual', familyId))[0]!.data).toMatchObject({ closedPending: true });
    await h.owner.query(`UPDATE jobs SET status = 'RUNNING', attempts = attempts + 1 WHERE id = $1`, [jobId]);
    const res = await runErpWriteJob(h.pool, { id: jobId, tenant_id: h.world.tenantA, requested_by: h.world.users.legal2.id }, undefined, { config: h.config, provider: resolver });
    expect(res).toMatchObject({ outcome: 'skipped', requestSent: false });
    expect(calls).toEqual({ find: 0, write: 0 });
    expect(await one(`SELECT status FROM jobs WHERE id = $1`, [jobId])).toEqual({ status: 'SUCCEEDED' });
    expect(await one(`SELECT status, external_ref FROM erp_outbound_records WHERE id = $1`, [outId])).toEqual({ status: 'MANUAL', external_ref: 'PO-HDR-ELLE-77' });
    // Elle kayıt değişmez (058a: MANUAL son durum); gönderilmiş/elle kayıt varken yeni elle kayıt 409.
    expect((await h.call('buyer', 'POST', '/api/v1/erp/outbound/manual', { body: { feature: 'CONTRACT_HEADER', entityType: 'CONTRACT_FAMILY', entityId: familyId,
      externalRef: 'BASKA' } })).status).toBe(409);
  });
});

describe('fatura ERP ödeme durumu (elle bilgi, Satınalma)', () => {
  it('elle değer yazılır ve sonraki ERP okumasında korunur (CONFLICT_MANUAL); demo fatura 409; Departman kullanıcısı 403; geçersiz tarih 422', async () => {
    const u = `/api/v1/invoices/${invoiceId}/erp-payment-status`;
    expect((await h.call('security', 'PUT', u, { body: { status: 'UNPAID', at: null } })).status).toBe(403);
    expect((await h.call('buyer', 'PUT', u, { body: { status: 'UNPAID', at: '2026-02-30' } })).status).toBe(422);
    const r = await h.call('buyer', 'PUT', u, { body: { status: 'UNPAID', at: '2026-11-01' } });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.payment).toEqual({ status: 'UNPAID', statusLabel: 'Ödenmedi', at: '2026-11-01', source: 'MANUAL', sourceLabel: 'Elle' });
    expect((await audits('invoice.erp_payment_status', invoiceId))[0]!.data).toMatchObject({ to: 'UNPAID', at: '2026-11-01', source: 'MANUAL' });
    const v1Before = await one(`SELECT payment_status FROM invoices WHERE id = $1`, [invoiceId]);
    const demo = await h.call('buyer', 'PUT', `/api/v1/invoices/${demoInvoice}/erp-payment-status`, { body: { status: 'PAID', at: '2026-11-01' } });
    expect(demo.status).toBe(409);
    expect(demo.body.error.code).toBe('demo_invoice_protected');

    // ERP okuması (taklit): TKL2026000001 ERP'de "Ödendi"; elle değer ezilmez.
    const put = await h.call('tenantAdmin', 'PUT', '/api/v1/integration/endpoints/PAYMENT_STATUS', { body: { enabled: true, baseUrl: 'taklit://ok',
      resourcePath: '/webservices/rest/sentetik', authType: 'BASIC', username: 'sentetik_kullanici', secret: SECRET, fieldMap: ERP_FEATURE_CATALOG.PAYMENT_STATUS.ebsDefaultMap } });
    expect(put.status, JSON.stringify(put.body)).toBe(200);
    const run = await h.call('tenantAdmin', 'POST', '/api/v1/integration/endpoints/PAYMENT_STATUS/run');
    expect(run.status).toBe(202);
    const job = await one<{ id: string; tenant_id: string; requested_by: string }>(`SELECT id, tenant_id, requested_by FROM jobs WHERE kind = 'erp.read' AND payload->>'runId' = $1`, [run.body.runId]);
    const m = await one<{ roles: string[] }>(`SELECT roles FROM memberships WHERE tenant_id = $1 AND user_id = $2`, [h.world.tenantA, job.requested_by]);
    await runErpReadJob(h.pool, job, m, { config: h.config, provider: resolver });
    expect(await one(`SELECT erp_payment_status, erp_payment_status_at::text AS at, erp_payment_source FROM invoices WHERE id = $1`, [invoiceId]))
      .toEqual({ erp_payment_status: 'UNPAID', at: '2026-11-01', erp_payment_source: 'MANUAL' });
    const errs = await rows<{ code: string; message: string; record_key: string }>(`SELECT code, message, record_key FROM integration_run_errors WHERE run_id = $1`, [run.body.runId]);
    expect(errs.find((e) => e.record_key === 'TKL2026000001')).toMatchObject({ code: 'CONFLICT_MANUAL' });
    expect(errs.find((e) => e.record_key === 'TKL2026000001')!.message).toMatch(/Elle girilen değerle çelişiyor/);
    // Bilgi alanı: v1 ödeme durumu değişmez; fatura detayında kaynak "Elle".
    expect(await one(`SELECT payment_status FROM invoices WHERE id = $1`, [invoiceId])).toEqual(v1Before);
    const detail = await h.call('finance', 'GET', `/api/v1/invoices/${invoiceId}`);
    expect(detail.body.erpSource.payment).toMatchObject({ status: 'UNPAID', sourceLabel: 'Elle' });
    // Demo fatura hiç değişmedi.
    expect((await one<{ j: string }>(`SELECT row_to_json(i)::text AS j FROM invoices i WHERE id = $1`, [demoInvoice])).j).toBe(demoSnapshot);
  });
});
