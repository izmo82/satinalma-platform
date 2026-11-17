// v2 Faz 8 (D113) Görev 6: ERP'ye yazan akışlar (2. aşama, kapalı varsayılan) — yazma kapalıyken olay noktaları (tedarikçi onayı,
// sözleşme zinciri APPROVED, kazanan seçimi) hiçbir kayıt/iş açmaz ve sağlayıcıyı çağırmaz (casus); R3 sağlanınca taklitle SENT
// (tedarikçide ERP kodu ERP kaynağıyla); zaman aşımı → UNKNOWN, yeniden denemede `find` bulur ve ikinci `write` yok; iş alınmadan ya da
// çalışma sırasında yazma kapatılırsa istek yok; "Şimdi çalıştır" yeniden denemesi çalışmayı kapatır; bayat işler; işçi şeritleri.
// Tüm veri sentetiktir; bütün kontroller TAKLİT SAĞLAYICIYLA DENENDİ (gerçek Oracle değil). Gerçek Oracle EBS kontrolleri NOT_RUN.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { ERP_FEATURE_CATALOG, syntheticVkn, type ErpFeature } from '@sp/domain';
import type { ErpConfig } from '../src/config.ts';
import { withTenant, type TenantContext } from '../src/db.ts';
import { erpProvider, type ErpProvider, type ErpProviderKind } from '../src/erp/providers.ts';
import { resetTaklitStore } from '../src/erp/taklit.ts';
import { ERP_WRITE_LIMITS, enqueueErpOutbound, enqueueErpOutboundSafe, reapAllStaleErpWrites, runErpWriteJob } from '../src/modules/erpWrite.ts';
import { PROTECTED_DEMO_INVOICES } from '../src/modules/erpRead.ts';
import { laneKinds } from '../src/worker.ts';
import { makeHarness } from './harness.ts';

const KEY = Buffer.alloc(32, 9);
const SECRET = 'Sentetik-ERP-Yazma-Parola-8K!w';
const MOCK_NOTE = 'taklit sağlayıcıyla denendi — gerçek Oracle değil';
const erpCfg = (): ErpConfig => ({ provider: 'taklit', secretKey: KEY, allowedHosts: ['erp.example.test'] });
let h: Awaited<ReturnType<typeof makeHarness>>;
const rand = () => randomUUID().slice(0, 8);
const one = async <T = any>(sql: string, params: unknown[] = []) => (await h.owner.query(sql, params)).rows[0] as T;
const rows = async <T = any>(sql: string, params: unknown[] = []) => (await h.owner.query(sql, params)).rows as T[];
const demoRows = async () => (await rows<{ j: string }>(`SELECT row_to_json(i)::text AS j FROM invoices i WHERE invoice_no = ANY($1) ORDER BY id`,
  [[...PROTECTED_DEMO_INVOICES]])).map((r) => r.j);
let demoSnapshot: string[] = [];

// Casus sağlayıcı: taklidi sarar; find/write çağrılarını ve yazılan yükü kaydeder. `onFind` arama sırasında bir şey yapar (ör. yazmayı kapatır).
const spy = { find: 0, write: 0, read: 0, payloads: [] as Record<string, string | null>[], onFind: null as null | (() => Promise<void>) };
const resetSpy = () => { spy.find = 0; spy.write = 0; spy.read = 0; spy.payloads = []; spy.onFind = null; };
const resolver = (kind: ErpProviderKind): ErpProvider | null => {
  const p = erpProvider(kind, h.config);
  if (!p) return null;
  return {
    ...p,
    read: async (...a) => { spy.read++; return p.read(...a); },
    find: async (ep, f, k) => { spy.find++; if (spy.onFind) await spy.onFind(); return p.find(ep, f, k); },
    write: async (ep, f, payload, k) => { spy.write++; spy.payloads.push(payload); return p.write(ep, f, payload, k); },
  };
};

const url = (f: string, rest = '') => `/api/v1/integration/endpoints/${f}${rest}`;
async function configure(f: ErpFeature, baseUrl = 'taklit://ok') {
  const r = await h.call('tenantAdmin', 'PUT', url(f), { body: { enabled: true, baseUrl, resourcePath: '/webservices/rest/sentetik', authType: 'BASIC',
    username: 'sentetik_kullanici', secret: SECRET, fieldMap: ERP_FEATURE_CATALOG[f].ebsDefaultMap } });
  expect(r.status, JSON.stringify(r.body)).toBe(200);
}
/** R3: özellik açık + son 24 saatte başarılı sınama (zaman aşımı kipinde sınama başarısız olacağından doğrudan yazılır) + Yönetici onayı. */
async function enableWrite(f: ErpFeature, baseUrl = 'taklit://ok') {
  await configure(f, baseUrl);
  await h.owner.query(`UPDATE integration_endpoints SET last_test_at = now(), last_test_ok = true, last_test_message = 'Taklit sağlayıcıyla denendi — gerçek Oracle değil'
    WHERE tenant_id = $1 AND feature = $2`, [h.world.tenantA, f]);
  const r = await h.call('tenantAdmin', 'POST', url(f, '/write-enable'), { body: { confirm: true } });
  expect(r.status, JSON.stringify(r.body)).toBe(200);
}
const disableWrite = async (f: ErpFeature) => expect((await h.call('tenantAdmin', 'DELETE', url(f, '/write-enable'))).status).toBe(200);

const memberOf = async (userId: string) => one<{ roles: string[] } | undefined>(`SELECT roles FROM memberships WHERE tenant_id = $1 AND user_id = $2`, [h.world.tenantA, userId]);
/** İşçi çekişi (claim_jobs gibi: RUNNING + attempts+1) ve `runErpWriteJob`. */
async function runJob(jobId: string) {
  await h.owner.query(`UPDATE jobs SET status = 'RUNNING', attempts = attempts + 1, updated_at = now() WHERE id = $1`, [jobId]);
  const job = await one<{ id: string; tenant_id: string; requested_by: string | null }>(`SELECT id, tenant_id, requested_by FROM jobs WHERE id = $1`, [jobId]);
  return runErpWriteJob(h.pool, job, job.requested_by ? await memberOf(job.requested_by) : undefined, { config: h.config, provider: resolver });
}
const outboundFor = (entityId: string) => rows<{ id: string; feature: string; status: string; provider_kind: string | null; external_ref: string | null; attempts: number;
  last_error: string | null; idempotency_key: string }>(`SELECT id, feature, status, provider_kind, external_ref, attempts, last_error, idempotency_key FROM erp_outbound_records
  WHERE tenant_id = $1 AND entity_id = $2 ORDER BY created_at`, [h.world.tenantA, entityId]);
const writeJobsFor = (outboundId: string) => rows<{ id: string; status: string; error_code: string | null; attempts: number; idempotency_key: string }>(
  `SELECT id, status, error_code, attempts, idempotency_key FROM jobs WHERE tenant_id = $1 AND kind = 'erp.write' AND payload->>'outboundId' = $2 ORDER BY created_at`,
  [h.world.tenantA, outboundId]);
const writeJobCount = async () => (await one<{ n: number }>(`SELECT count(*)::int AS n FROM jobs WHERE tenant_id = $1 AND kind = 'erp.write'`, [h.world.tenantA])).n;
const outboundCount = async () => (await one<{ n: number }>(`SELECT count(*)::int AS n FROM erp_outbound_records WHERE tenant_id = $1`, [h.world.tenantA])).n;
const eventRunFor = (outboundId: string) => one<{ id: string; status: string; mock: boolean; provider_kind: string; trigger: string; counts: any } | undefined>(
  `SELECT id, status, mock, provider_kind, trigger, counts FROM integration_runs WHERE tenant_id = $1 AND counts->>'outboundId' = $2 ORDER BY started_at DESC LIMIT 1`,
  [h.world.tenantA, outboundId]);
const audits = (action: string, entityId: string) => rows<{ data: any; actor_user_id: string }>(
  `SELECT data, actor_user_id FROM audit_events WHERE tenant_id = $1 AND action = $2 AND entity_id = $3 ORDER BY id`, [h.world.tenantA, action, entityId]);
const ctxOf = (userId: string, roles: string[]): TenantContext => ({ tenantId: h.world.tenantA, userId, roles: roles as any, companyIds: [h.world.companyA1.id],
  departmentIds: [], allDepartments: true, correlationId: `t-${rand()}` });

/** Aday tedarikçi (sentetik; adres/iletişim dolu, doğrulanmış banka hesabı var — ERP'ye gönderilmemeli). */
async function candidate() {
  const vkn = syntheticVkn(`93${String(Math.floor(Math.random() * 1e7)).padStart(7, '0')}`);
  const id = (await one<{ id: string }>(`INSERT INTO suppliers (tenant_id, status, country, tax_id_type, tax_id, legal_name, created_by, address, contact_name, contact_email, contact_phone)
    VALUES ($1,'CANDIDATE','TR','VKN',$2,$3,$4,'Sentetik Cad. No:1 Ankara','Ayşe Sentetik','ayse@sentetik.example','+90 312 000 00 00') RETURNING id`,
    [h.world.tenantA, vkn, `ERP Yazma Tedarikçi ${rand()} (SENTETİK)`, h.world.users.buyer.id])).id;
  await h.owner.query(`INSERT INTO supplier_bank_accounts (tenant_id, supplier_id, iban, status) VALUES ($1,$2,'TR000000000000000000000099','VERIFIED')`, [h.world.tenantA, id]);
  return { id, vkn };
}
/** Tedarikçi onayı (API): ana veri onayı + aktivasyon (olay noktası). */
async function approveSupplier(id: string) {
  const rv = (await one<{ v: number }>(`SELECT row_version AS v FROM suppliers WHERE id = $1`, [id])).v;
  const a = await h.call('masterData', 'POST', `/api/v1/suppliers/${id}/approvals`, { body: { kind: 'MASTER_DATA', decision: 'APPROVED', rationale: 'Sentetik ana veri onayı.', expectedRowVersion: rv } });
  expect(a.status, JSON.stringify(a.body)).toBeLessThan(300);
  const rv2 = (await one<{ v: number }>(`SELECT row_version AS v FROM suppliers WHERE id = $1`, [id])).v;
  const r = await h.call('masterData', 'POST', `/api/v1/suppliers/${id}/activate`, { body: { expectedRowVersion: rv2 } });
  expect(r.status, JSON.stringify(r.body)).toBe(204);
}

/** Açık onay zincirli sözleşme (tek adım: Satınalma lideri legal2); karar API ile verilir (olay noktası). */
async function contractInApproval(supplierId: string) {
  const w = h.world;
  const company = w.companyA1.id;
  const projectId = (await one<{ id: string }>(`INSERT INTO projects (tenant_id, company_id, code, title, category, owner_user_id, created_by, department_id)
    VALUES ($1,$2,$3,'ERP yazma projesi (SENTETİK)','Genel',$4,$4,$5) RETURNING id`, [w.tenantA, company, `PRJ-EW-${rand()}`, w.users.buyer.id, w.departments.bt])).id;
  const doc = (await one<{ id: string }>(`INSERT INTO documents (tenant_id, company_id, kind, title, created_by, code) VALUES ($1,$2,'CONTRACT',$3,$4,$5) RETURNING id`,
    [w.tenantA, company, `ERP yazma sözleşmesi ${rand()} (SENTETİK)`, w.users.buyer.id, `BLG-EW-${rand()}`])).id;
  const dv = (await one<{ id: string }>(`INSERT INTO document_versions (tenant_id, company_id, document_id, version_no, sha256, mime_type, size_bytes, storage_key,
      original_filename, basic_check_status, created_by) VALUES ($1,$2,$3,1,$4,'application/pdf',100,$5,'sozlesme.pdf','PASSED',$6) RETURNING id`,
    [w.tenantA, company, doc, 'f'.repeat(64), `tenant/${randomUUID()}`, w.users.buyer.id])).id;
  const code = `SZL-EW-${rand()}`;
  const familyId = (await one<{ id: string }>(`INSERT INTO contract_families (tenant_id, company_id, title, supplier_id, created_by, code, department_id, intake_flow,
      project_id, contract_type, owner_user_id, signed_on) VALUES ($1,$2,$3,$4,$5,$6,$7,true,$8,'SERVICE',$9,'2026-01-01') RETURNING id`,
    [w.tenantA, company, `ERP yazma sözleşmesi ${rand()} (SENTETİK)`, supplierId, w.users.buyer.id, code, w.departments.bt, projectId, w.users.buyer.id])).id;
  const cvId = (await one<{ id: string }>(`INSERT INTO contract_versions (tenant_id, company_id, family_id, version_no, document_version_id, created_by)
    VALUES ($1,$2,$3,1,$4,$5) RETURNING id`, [w.tenantA, company, familyId, dv, w.users.buyer.id])).id;
  const termsId = (await one<{ id: string }>(`INSERT INTO contract_terms (tenant_id, company_id, contract_version_id, revision, currency, value_type, amount,
      start_date, end_date, source_ref, entered_by, limit_basis) VALUES ($1,$2,$3,1,'TRY','FIXED','500000.00','2026-01-01','2026-12-31','Madde 1 (sentetik)',$4,'NET') RETURNING id`,
    [w.tenantA, company, cvId, w.users.buyer.id])).id;
  const chainId = (await one<{ id: string }>(`INSERT INTO contract_approval_chains (tenant_id, family_id, version_id, terms_id, submitted_by) VALUES ($1,$2,$3,$4,$5) RETURNING id`,
    [w.tenantA, familyId, cvId, termsId, w.users.buyer.id])).id;
  const stepId = (await one<{ id: string }>(`INSERT INTO contract_approval_steps (tenant_id, chain_id, step_order, kind, assigned_user_id) VALUES ($1,$2,1,'PROCUREMENT_LEAD',$3) RETURNING id`,
    [w.tenantA, chainId, w.users.legal2.id])).id;
  return { familyId, code, stepId, projectId };
}
async function approveChain(stepId: string) {
  const r = await h.call('legal2', 'POST', `/api/v1/contract-approval-steps/${stepId}/decision`, { body: { decision: 'APPROVED' } });
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  expect(r.body.chainStatus).toBe('APPROVED');
}

/** Onaylı kazanan seçimi olan proje (doğrudan; kazanan seçimi API akışı sourcing testlerinde). Olay çağrısı enqueueErpOutbound ile. */
async function awardedProject(total = '125000.50') {
  const w = h.world;
  const projectId = (await one<{ id: string }>(`INSERT INTO projects (tenant_id, company_id, code, title, category, owner_user_id, created_by, department_id, currency)
    VALUES ($1,$2,$3,'ERP talep projesi (SENTETİK)','Genel',$4,$4,$5,'TRY') RETURNING id`, [w.tenantA, w.companyA1.id, `PRJ-RQ-${rand()}`, w.users.buyer.id, w.departments.bt])).id;
  const ev = (await one<{ id: string }>(`INSERT INTO evaluations (tenant_id, company_id, project_id, version_no, basis_hash, snapshot, created_by) VALUES ($1,$2,$3,1,'x','{}',$4) RETURNING id`,
    [w.tenantA, w.companyA1.id, projectId, w.users.buyer.id])).id;
  await h.owner.query(`INSERT INTO awards (tenant_id, company_id, project_id, evaluation_id, version_no, rationale, total, status, proposed_by, decided_by, decided_at)
    VALUES ($1,$2,$3,$4,1,'Sentetik seçim gerekçesi.',$5,'APPROVED',$6,$7,now())`, [w.tenantA, w.companyA1.id, projectId, ev, total, w.users.buyer.id, w.users.legal2.id]);
  return projectId;
}
const enqueueReq = (projectId: string) => withTenant(h.pool, ctxOf(h.world.users.legal2.id, ['PROCUREMENT']), (tx) =>
  enqueueErpOutbound(tx, ctxOf(h.world.users.legal2.id, ['PROCUREMENT']), 'REQUISITION', 'PROJECT', projectId));

beforeAll(async () => {
  h = await makeHarness({ erp: erpCfg() });
  resetTaklitStore();
  demoSnapshot = await demoRows();
  await h.owner.query(`UPDATE departments SET cost_center_code = 'TKL-MM-100', cost_center_source = 'MANUAL' WHERE id = $1`, [h.world.departments.bt]);
});
afterAll(async () => { await h?.close(); });

describe('yazma kapalı (varsayılan): olay noktaları hiçbir şey yazmaz, sağlayıcı çağrılmaz', () => {
  it('tedarikçi onayı, sözleşme zinciri APPROVED ve kazanan seçimi: outbound satırı ve erp.write işi yok', async () => {
    resetSpy();
    const jobsBefore = await writeJobCount();
    const outBefore = await outboundCount();
    // Uç nokta hiç yok (kapalı varsayılan).
    const s = await candidate();
    await approveSupplier(s.id);
    expect((await one<{ status: string }>(`SELECT status FROM suppliers WHERE id = $1`, [s.id])).status).toBe('ACTIVE');
    const c = await contractInApproval(s.id);
    await approveChain(c.stepId);
    expect(await enqueueReq(await awardedProject())).toBeNull();
    // Özellik açık ama ERP'ye yazma açık değil (R3): yine hiçbir şey.
    await configure('SUPPLIER');
    await configure('CONTRACT_HEADER');
    await configure('REQUISITION');
    const s2 = await candidate();
    await approveSupplier(s2.id);
    const c2 = await contractInApproval(s2.id);
    await approveChain(c2.stepId);
    expect(await enqueueReq(await awardedProject())).toBeNull();
    expect(await outboundCount()).toBe(outBefore);
    expect(await writeJobCount()).toBe(jobsBefore);
    expect(spy).toMatchObject({ find: 0, write: 0, read: 0 });
    // Elle yol açık: detay ekranı yazmanın kapalı olduğunu ve elle iletme yolunu gösterir.
    const g = await h.call('buyer', 'GET', `/api/v1/erp/outbound?entityType=CONTRACT_FAMILY&entityId=${c2.familyId}`);
    expect(g.status).toBe(200);
    expect(g.body.items).toEqual([]);
    expect(g.body.features[0]).toMatchObject({ feature: 'CONTRACT_HEADER', enabled: true, writeEnabled: false, modeLabel: 'ERP\'ye yazma kapalı; elle iletin' });
    expect(g.body.can.recordManual).toBe(true);
  });
});

describe('R3 sağlanınca taklitle yazma (gerçek Oracle değil)', () => {
  it('SUPPLIER: onay → PENDING + iş; işçi → SENT, kartta ERP kodu ERP kaynağıyla; banka bilgisi gönderilmez; EVENT çalışması taklit etiketli', async () => {
    await enableWrite('SUPPLIER');
    resetSpy();
    const s = await candidate();
    await approveSupplier(s.id);
    const [rec] = await outboundFor(s.id);
    expect(rec).toMatchObject({ feature: 'SUPPLIER', status: 'PENDING', attempts: 0, idempotency_key: `erp:SUPPLIER:${s.id}:v1` });
    const [job] = await writeJobsFor(rec!.id);
    expect(job).toMatchObject({ status: 'QUEUED', idempotency_key: `erp:SUPPLIER:${s.id}:v1` });
    expect(spy.write).toBe(0); // olay anında istek yok; işçi gönderir
    const r = await runJob(job!.id);
    expect(r).toMatchObject({ outcome: 'sent', status: 'SENT', viaFind: false, requestSent: true });
    const [after] = await outboundFor(s.id);
    expect(after).toMatchObject({ status: 'SENT', provider_kind: 'TAKLIT', attempts: 1, last_error: null });
    expect(after!.external_ref).toMatch(/^TKL-SUPPLIER-\d{6}$/);
    expect((await writeJobsFor(rec!.id))[0]!.status).toBe('SUCCEEDED');
    const sup = await one<{ erp_supplier_code: string; erp_supplier_code_source: string }>(`SELECT erp_supplier_code, erp_supplier_code_source FROM suppliers WHERE id = $1`, [s.id]);
    expect(sup).toEqual({ erp_supplier_code: after!.external_ref, erp_supplier_code_source: 'ERP' });
    // Yük: EBS alan adlarıyla unvan, VKN, adres, iletişim; banka/IBAN yok.
    expect(spy.write).toBe(1);
    const payload = spy.payloads[0]!;
    expect(payload).toMatchObject({ TAX_REGISTRATION_NUM: s.vkn, ADDRESS_LINE1: 'Sentetik Cad. No:1 Ankara', CONTACT_NAME: 'Ayşe Sentetik', EMAIL_ADDRESS: 'ayse@sentetik.example' });
    expect(payload.VENDOR_NAME).toMatch(/SENTETİK/);
    expect(Object.keys(payload).some((k) => /bank|iban/i.test(k))).toBe(false);
    expect(JSON.stringify(payload)).not.toContain('TR000000000000000000000099');
    const run = await eventRunFor(rec!.id);
    expect(run).toMatchObject({ trigger: 'EVENT', status: 'SUCCESS', mock: true, provider_kind: 'TAKLIT' });
    const audit = await audits('erp.outbound.sent', s.id);
    expect(audit[0]!.data).toMatchObject({ feature: 'SUPPLIER', mock: true, providerKind: 'TAKLIT', viaFind: false, requestSent: true });
    expect((await audits('supplier.erp_code_set', s.id))[0]!.data).toMatchObject({ source: 'ERP', mock: true });
    const g = await h.call('buyer', 'GET', `/api/v1/erp/outbound?entityType=SUPPLIER&entityId=${s.id}`);
    expect(g.body.items[0]).toMatchObject({ status: 'SENT', mock: true, statusLabel: `ERP'ye gönderildi (${MOCK_NOTE})`, provider: { kind: 'TAKLIT', real: false } });
    // Aynı olay ikinci kez yeni kayıt açmaz; ERP kodu olan tedarikçi yeniden yazılmaz.
    expect(await withTenant(h.pool, ctxOf(h.world.users.masterData.id, ['PROCUREMENT']), (tx) =>
      enqueueErpOutbound(tx, ctxOf(h.world.users.masterData.id, ['PROCUREMENT']), 'SUPPLIER', 'SUPPLIER', s.id))).toBeNull();
    expect(await outboundFor(s.id)).toHaveLength(1);
    // M6: taklitle yazılan kod kartta "ERP (taklit)" görünür (gerçek başarı gibi değil).
    const code = await h.call('buyer', 'GET', `/api/v1/suppliers/${s.id}/erp-code`);
    expect(code.body).toMatchObject({ code: after!.external_ref, source: 'ERP', sourceLabel: 'ERP (taklit)', mock: true, provider: { kind: 'TAKLIT', real: false } });
  });

  it('M1: olay noktasındaki kuyruğa alma DB hatası iş akışını geri almaz (SAVEPOINT)', async () => {
    const ctx = ctxOf(h.world.users.masterData.id, ['PROCUREMENT']);
    const marker = randomUUID();
    await withTenant(h.pool, ctx, async (tx) => {
      // Geçersiz kimlik: tedarikçi sorgusu 22P02 verir (SUPPLIER yazması açık) → yalnız kuyruk kısmı geri alınır.
      expect(await enqueueErpOutboundSafe(tx, ctx, 'SUPPLIER', 'SUPPLIER', 'gecersiz-kimlik')).toBeNull();
      await tx.query(`INSERT INTO audit_events (tenant_id, actor_user_id, action, entity_type, entity_id, data) VALUES ($1,$2,'test.after_enqueue','supplier',$3,'{}')`,
        [h.world.tenantA, ctx.userId, marker]);
    });
    expect(await audits('test.after_enqueue', marker)).toHaveLength(1);
  });

  it('M3: tedarikçinin ERP kodu bu arada geldiyse istek atılmaz; kayıt SENT + mevcut kod, "ERP\'de zaten kayıtlı", yeniden denenmez', async () => {
    resetSpy();
    const s = await candidate();
    await approveSupplier(s.id);
    const [rec] = await outboundFor(s.id);
    await h.owner.query(`UPDATE suppliers SET erp_supplier_code = 'ELLE-77', erp_supplier_code_source = 'MANUAL' WHERE id = $1`, [s.id]);
    const r = await runJob((await writeJobsFor(rec!.id))[0]!.id);
    expect(r).toMatchObject({ outcome: 'skipped', status: 'SENT', requestSent: false });
    expect(spy).toMatchObject({ find: 0, write: 0 });
    const after = (await outboundFor(s.id))[0]!;
    expect(after).toMatchObject({ status: 'SENT', external_ref: 'ELLE-77', provider_kind: 'TAKLIT' });
    expect(after.last_error).toMatch(/^ERP'de zaten kayıtlı/);
    expect((await writeJobsFor(rec!.id))[0]!.status).toBe('SUCCEEDED');
    const g = await h.call('buyer', 'GET', `/api/v1/erp/outbound?entityType=SUPPLIER&entityId=${s.id}`);
    expect(g.body.items[0]).toMatchObject({ status: 'SENT', alreadyInErp: true, statusLabel: 'ERP\'de zaten kayıtlı (yeni kayıt yazılmadı)' });
    // WRITE_RETRY bu kaydı yeniden denemez.
    const retry = await h.call('tenantAdmin', 'POST', url('SUPPLIER', '/run'), { body: { target: 'WRITE_RETRY' } });
    expect(retry.status).toBe(202);
    expect((await rows(`SELECT 1 FROM jobs WHERE payload->>'runId' = $1 AND payload->>'outboundId' = $2`, [retry.body.runId, rec!.id]))).toHaveLength(0);
    expect((await audits('erp.outbound.skipped', s.id))[0]!.data).toMatchObject({ reason: 'supplier_already_in_erp', externalRef: 'ELLE-77' });
  });

  it('CONTRACT_HEADER: zincir APPROVED → SENT; yük sözleşme kodu, tedarikçi ERP kodu, proje, tarih, tutar (decimal string), para birimi', async () => {
    await enableWrite('CONTRACT_HEADER');
    resetSpy();
    const sup = await one<{ id: string; erp_supplier_code: string }>(`SELECT id, erp_supplier_code FROM suppliers WHERE tenant_id = $1 AND erp_supplier_code IS NOT NULL LIMIT 1`, [h.world.tenantA]);
    const c = await contractInApproval(sup.id);
    await approveChain(c.stepId);
    const [rec] = await outboundFor(c.familyId);
    expect(rec).toMatchObject({ feature: 'CONTRACT_HEADER', status: 'PENDING', idempotency_key: `erp:CONTRACT_HEADER:${c.familyId}:v1` });
    await runJob((await writeJobsFor(rec!.id))[0]!.id);
    expect((await outboundFor(c.familyId))[0]).toMatchObject({ status: 'SENT', provider_kind: 'TAKLIT' });
    const projectCode = (await one<{ code: string }>(`SELECT code FROM projects WHERE id = $1`, [c.projectId])).code;
    expect(spy.payloads[0]).toEqual(expect.objectContaining({ SEGMENT1: c.code, VENDOR_NUMBER: sup.erp_supplier_code, PROJECT_NUMBER: projectCode, START_DATE: '2026-01-01',
      END_DATE: '2026-12-31', AMOUNT_AGREED: '500000.00', CURRENCY_CODE: 'TRY' }));
  });

  it('REQUISITION: kazanan seçimi → SENT; yük proje kodu, başlık, departman masraf merkezi, tutar, para birimi', async () => {
    await enableWrite('REQUISITION');
    resetSpy();
    const projectId = await awardedProject('125000.50');
    const q = await enqueueReq(projectId);
    expect(q).toMatchObject({ created: true });
    await runJob((await writeJobsFor(q!.outboundId))[0]!.id);
    expect((await outboundFor(projectId))[0]).toMatchObject({ status: 'SENT', provider_kind: 'TAKLIT' });
    const code = (await one<{ code: string }>(`SELECT code FROM projects WHERE id = $1`, [projectId])).code;
    expect(spy.payloads[0]).toEqual(expect.objectContaining({ SEGMENT_REFERENCE: code, DESCRIPTION: 'ERP talep projesi (SENTETİK)', AMOUNT: '125000.50', CURRENCY_CODE: 'TRY',
      COST_CENTER: 'TKL-MM-100' }));
  });
});

describe('zaman aşımı → UNKNOWN; yeniden denemede önce find, ikinci write yok', () => {
  it('taklit://zaman-asimi: ilk deneme UNKNOWN (iş kuyruk politikasıyla yeniden), ikinci deneme find ile SENT, write tek', async () => {
    await enableWrite('REQUISITION', 'taklit://zaman-asimi');
    resetSpy();
    const projectId = await awardedProject('9000.00');
    const q = await enqueueReq(projectId);
    const jobId = (await writeJobsFor(q!.outboundId))[0]!.id;
    const r1 = await runJob(jobId);
    expect(r1).toMatchObject({ outcome: 'unknown', status: 'UNKNOWN' });
    expect(spy).toMatchObject({ find: 0, write: 1 });
    const rec1 = (await outboundFor(projectId))[0]!;
    expect(rec1).toMatchObject({ status: 'UNKNOWN', attempts: 1, external_ref: null });
    expect(rec1.last_error).toMatch(/belirsiz/);
    const j1 = (await writeJobsFor(q!.outboundId))[0]!;
    expect(j1).toMatchObject({ status: 'QUEUED', error_code: 'TIMEOUT', attempts: 1 });
    const run1 = await eventRunFor(q!.outboundId);
    expect(run1).toMatchObject({ status: 'FAILED', mock: true });
    expect((await rows(`SELECT code FROM integration_run_errors WHERE run_id = $1`, [run1!.id])).map((e: any) => e.code)).toEqual(['timeout']);
    // Yeniden deneme (aynı iş, kuyruk politikası): önce find kaydı bulur → SENT; write yeniden çağrılmaz.
    const r2 = await runJob(jobId);
    expect(r2).toMatchObject({ outcome: 'sent', status: 'SENT', viaFind: true });
    expect(spy).toMatchObject({ find: 1, write: 1 });
    const rec2 = (await outboundFor(projectId))[0]!;
    expect(rec2).toMatchObject({ status: 'SENT', attempts: 2, last_error: null });
    expect(rec2.external_ref).toMatch(/^TKL-REQUISITION-/);
    expect((await writeJobsFor(q!.outboundId))[0]!.status).toBe('SUCCEEDED');
    expect((await audits('erp.outbound.sent', projectId))[0]!.data).toMatchObject({ viaFind: true, attempt: 2 });
  });
});

describe('yazma işlem anında yeniden denetlenir (R3)', () => {
  it('iş alınmadan yazma kapatıldı: istek yok, kayıt PENDING kalır (elle yol / sonra yeniden deneme), iş FAILED', async () => {
    await enableWrite('REQUISITION');
    resetSpy();
    const projectId = await awardedProject('100.00');
    const q = await enqueueReq(projectId);
    await disableWrite('REQUISITION');
    const r = await runJob((await writeJobsFor(q!.outboundId))[0]!.id);
    expect(r).toMatchObject({ outcome: 'refused', requestSent: false });
    expect(spy).toMatchObject({ find: 0, write: 0 });
    const rec = (await outboundFor(projectId))[0]!;
    expect(rec).toMatchObject({ status: 'PENDING', attempts: 0 });
    expect(rec.last_error).toMatch(/yazma kapalı/);
    expect((await writeJobsFor(q!.outboundId))[0]).toMatchObject({ status: 'FAILED', error_code: 'WRITE_NOT_ENABLED' });
    expect((await audits('erp.outbound.refused', projectId))[0]!.data).toMatchObject({ reason: 'write_not_enabled', requestSent: false });
    expect(await eventRunFor(q!.outboundId)).toBeUndefined();
  });

  it('çalışma sırasında (ERP\'de arama sürerken) yazma kapatıldı: write çağrılmaz', async () => {
    await enableWrite('REQUISITION');
    resetSpy();
    const projectId = await awardedProject('200.00');
    const q = await enqueueReq(projectId);
    // Daha önce denenmiş kayıt (çöken işçi): önce find; arama sırasında Yönetici yazmayı kapatır.
    await h.owner.query(`UPDATE erp_outbound_records SET attempts = 1 WHERE id = $1`, [q!.outboundId]);
    spy.onFind = async () => { await disableWrite('REQUISITION'); };
    const r = await runJob((await writeJobsFor(q!.outboundId))[0]!.id);
    expect(spy).toMatchObject({ find: 1, write: 0 });
    expect(r).toMatchObject({ outcome: 'failed' });
    expect((await outboundFor(projectId))[0]!.last_error).toMatch(/çalışma sırasında kapatıldı/);
    // Kapatılmış yazmada iş yeniden kuyruğa alınmaz.
    expect((await writeJobsFor(q!.outboundId))[0]).toMatchObject({ status: 'FAILED', error_code: 'WRITE_NOT_ENABLED' });
    expect((await eventRunFor(q!.outboundId))!.status).toBe('FAILED');
  });
});

describe('"Şimdi çalıştır" yeniden denemesi (WRITE_RETRY) çalışmayı kapatır', () => {
  it('bekleyen iki kayıt: biri SENT, biri 401 ile FAILED → çalışma PARTIAL kapanır; RUNNING çalışma kalmaz', async () => {
    await enableWrite('REQUISITION');
    resetSpy();
    const p1 = await awardedProject('300.00');
    const p2 = await awardedProject('400.00');
    const q1 = await enqueueReq(p1);
    const q2 = await enqueueReq(p2);
    // Olay işleri bu testte işlenmez (eski kuyrukta kalmasın diye kapatılır).
    await h.owner.query(`UPDATE jobs SET status = 'FAILED', error_code = 'TEST_SKIP' WHERE payload->>'outboundId' = ANY($1)`, [[q1!.outboundId, q2!.outboundId]]);
    const run = await h.call('tenantAdmin', 'POST', url('REQUISITION', '/run'), { body: { target: 'WRITE_RETRY' } });
    expect(run.status, JSON.stringify(run.body)).toBe(202);
    expect(run.body.queued).toBeGreaterThanOrEqual(2);
    const jobs = await rows<{ id: string; outbound: string }>(`SELECT id, payload->>'outboundId' AS outbound FROM jobs WHERE tenant_id = $1 AND kind = 'erp.write'
      AND payload->>'runId' = $2`, [h.world.tenantA, run.body.runId]);
    // Kalan (önceki testlerden) bekleyen kayıtlar da bu çalışmanın işleridir; hepsi işlenir. p2'nin işi sırasında bağlantı 401 verir.
    for (const j of jobs) {
      if (j.outbound === q2!.outboundId) {
        await h.owner.query(`UPDATE integration_endpoints SET base_url = 'taklit://hata-401' WHERE tenant_id = $1 AND feature = 'REQUISITION'`, [h.world.tenantA]);
        await runJob(j.id);
        await h.owner.query(`UPDATE integration_endpoints SET base_url = 'taklit://ok' WHERE tenant_id = $1 AND feature = 'REQUISITION'`, [h.world.tenantA]);
      } else {
        await runJob(j.id);
      }
    }
    expect((await outboundFor(p1))[0]!.status).toBe('SENT');
    const f = (await outboundFor(p2))[0]!;
    expect(f.status).toBe('FAILED');
    expect(f.last_error).toMatch(/HTTP 401/);
    expect(f.last_error).not.toContain(SECRET);
    const r = await one<{ status: string; counts: any; finished_at: Date | null; mock: boolean }>(`SELECT status, counts, finished_at, mock FROM integration_runs WHERE id = $1`, [run.body.runId]);
    expect(r.status).toBe('PARTIAL');
    expect(r.finished_at).not.toBeNull();
    expect(r.mock).toBe(true);
    expect(r.counts).toMatchObject({ mode: 'WRITE_RETRY', requestSent: true });
    expect(r.counts.sent).toBeGreaterThanOrEqual(1);
    expect(r.counts.failed).toBe(1);
    // Yeniden deneme işi tek denemedir (kuyruğa dönmez).
    expect((await rows(`SELECT status FROM jobs WHERE payload->>'runId' = $1`, [run.body.runId])).every((x: any) => ['SUCCEEDED', 'FAILED'].includes(x.status))).toBe(true);
    const list = await h.call('tenantAdmin', 'GET', url('REQUISITION', '/runs'));
    expect(list.body.items.find((x: any) => x.id === run.body.runId).statusLabel).toBe(`Kısmen başarılı (${MOCK_NOTE})`);
  });

  it('isteyen çalıştırma iznini kaybetti: istek yok, iş BLOCKED, çalışma kapanır', async () => {
    await enableWrite('REQUISITION');
    resetSpy();
    const p = await awardedProject('500.00');
    const q = await enqueueReq(p);
    await h.owner.query(`UPDATE jobs SET status = 'FAILED', error_code = 'TEST_SKIP' WHERE payload->>'outboundId' = $1`, [q!.outboundId]);
    const run = await h.call('tenantAdmin', 'POST', url('REQUISITION', '/run'), { body: { target: 'WRITE_RETRY' } });
    expect(run.status).toBe(202);
    const jobs = await rows<{ id: string; tenant_id: string; requested_by: string }>(`SELECT id, tenant_id, requested_by FROM jobs WHERE payload->>'runId' = $1`, [run.body.runId]);
    for (const j of jobs) {
      await h.owner.query(`UPDATE jobs SET status = 'RUNNING', attempts = attempts + 1 WHERE id = $1`, [j.id]);
      await runErpWriteJob(h.pool, j, { roles: ['PROCUREMENT'] }, { config: h.config, provider: resolver });
    }
    expect(spy).toMatchObject({ find: 0, write: 0 });
    expect((await rows(`SELECT status, error_code FROM jobs WHERE payload->>'runId' = $1`, [run.body.runId])).every((x: any) => x.status === 'BLOCKED')).toBe(true);
    const r = await one<{ status: string }>(`SELECT status FROM integration_runs WHERE id = $1`, [run.body.runId]);
    expect(r.status).toBe('FAILED');
  });
});

describe('bayat yazma işleri ve çalışmaları (işçi çöktü)', () => {
  it('uzun süre RUNNING kalan olay işi yeniden kuyruğa, olay çalışması FAILED stale_run; sonraki deneme önce find', async () => {
    await enableWrite('REQUISITION');
    resetSpy();
    const p = await awardedProject('600.00');
    const q = await enqueueReq(p);
    const jobId = (await writeJobsFor(q!.outboundId))[0]!.id;
    // Çöken işçi: iş RUNNING, deneme sayısı arttı, olay çalışması RUNNING.
    await h.owner.query(`UPDATE jobs SET status = 'RUNNING', attempts = 1, updated_at = now() - interval '20 minutes' WHERE id = $1`, [jobId]);
    await h.owner.query(`UPDATE erp_outbound_records SET attempts = 1 WHERE id = $1`, [q!.outboundId]);
    const ep = await one<{ id: string }>(`SELECT id FROM integration_endpoints WHERE tenant_id = $1 AND feature = 'REQUISITION'`, [h.world.tenantA]);
    const runId = (await one<{ id: string }>(`INSERT INTO integration_runs (tenant_id, endpoint_id, feature, trigger, provider_kind, mock, status, counts, started_at)
      VALUES ($1,$2,'REQUISITION','EVENT','TAKLIT',true,'RUNNING',$3, now() - interval '20 minutes') RETURNING id`,
      [h.world.tenantA, ep.id, JSON.stringify({ mode: 'WRITE', outboundId: q!.outboundId })])).id;
    expect(await reapAllStaleErpWrites(h.pool)).toBeGreaterThanOrEqual(2);
    expect((await writeJobsFor(q!.outboundId))[0]).toMatchObject({ status: 'QUEUED', error_code: 'STALE_RUN' });
    expect((await one<{ status: string }>(`SELECT status FROM integration_runs WHERE id = $1`, [runId])).status).toBe('FAILED');
    expect((await rows(`SELECT code FROM integration_run_errors WHERE run_id = $1`, [runId])).map((e: any) => e.code)).toEqual(['stale_run']);
    // Yeni deneme: kayıt daha önce denenmiş → önce find (taklitte yok) → write.
    await runJob(jobId);
    expect(spy).toMatchObject({ find: 1, write: 1 });
    expect((await outboundFor(p))[0]!.status).toBe('SENT');
    expect(ERP_WRITE_LIMITS.staleJobMinutes).toBe(15);
  });
});

describe('M5: olay yazma çalışması "Şimdi çalıştır"ı engellemez', () => {
  it('RUNNING EVENT çalışması varken WRITE_RETRY 409 değil', async () => {
    const ep = await one<{ id: string }>(`SELECT id FROM integration_endpoints WHERE tenant_id = $1 AND feature = 'CONTRACT_HEADER'`, [h.world.tenantA]);
    const ev = (await one<{ id: string }>(`INSERT INTO integration_runs (tenant_id, endpoint_id, feature, trigger, provider_kind, mock, status, counts)
      VALUES ($1,$2,'CONTRACT_HEADER','EVENT','TAKLIT',true,'RUNNING','{"mode":"WRITE"}') RETURNING id`, [h.world.tenantA, ep.id])).id;
    const r = await h.call('tenantAdmin', 'POST', url('CONTRACT_HEADER', '/run'), { body: { target: 'WRITE_RETRY' } });
    expect(r.status, JSON.stringify(r.body)).toBe(202);
    expect(r.body.status).toBe('SUCCESS'); // bekleyen kayıt yok
    await h.owner.query(`UPDATE integration_runs SET status = 'FAILED', finished_at = now() WHERE id = $1`, [ev]);
  });
});

describe('işçi şeritleri', () => {
  it('erp.read/erp.write kısa şeritte değil; kendi şeridinde birer birer çekilir (uzun okuma kısa işleri ve tıkı bekletmez)', () => {
    const opts = { erp: { env: 'test' as const, erp: erpCfg() } };
    const short = laneKinds('short', opts, 'test-erp', 10);
    expect(short.kinds).not.toContain('erp.read');
    expect(short.kinds).not.toContain('erp.write');
    expect(short.kinds).toEqual(expect.arrayContaining(['signature.detect', 'erp.export', 'compliance.audit']));
    expect(short.limit).toBe(10);
    expect(laneKinds('erp', opts)).toEqual({ kinds: ['erp.read', 'erp.write'], limit: 1 });
    expect(laneKinds('export', opts)).toEqual({ kinds: ['tenant.export'], limit: 1 });
    expect(laneKinds('all', opts, 'test-erp').kinds).toEqual(expect.arrayContaining(['erp.read', 'erp.write', 'tenant.export', 'signature.detect']));
    // ERP yapılandırılmamış işçi ERP işi çekmez.
    expect(laneKinds('erp', {}).kinds).toEqual([]);
    expect(laneKinds('all', {}).kinds).not.toContain('erp.write');
  });
});

describe('son kontroller', () => {
  it('RUNNING yazma çalışması kalmadı; demo faturalar değişmedi; hata/denetim kayıtlarında sır yok', async () => {
    const running = await rows(`SELECT id, counts FROM integration_runs WHERE tenant_id = $1 AND status = 'RUNNING' AND counts->>'mode' IN ('WRITE','WRITE_RETRY')`, [h.world.tenantA]);
    expect(running).toEqual([]);
    expect(await demoRows()).toEqual(demoSnapshot);
    const errs = await rows<{ message: string }>(`SELECT e.message FROM integration_run_errors e WHERE e.tenant_id = $1`, [h.world.tenantA]);
    const auditText = await rows<{ t: string }>(`SELECT data::text AS t FROM audit_events WHERE tenant_id = $1 AND action LIKE 'erp.outbound.%'`, [h.world.tenantA]);
    for (const x of [...errs.map((e) => e.message), ...auditText.map((a) => a.t)]) expect(x).not.toContain(SECRET);
    const last = await rows<{ last_error: string | null }>(`SELECT last_error FROM erp_outbound_records WHERE tenant_id = $1`, [h.world.tenantA]);
    for (const l of last) expect(l.last_error ?? '').not.toContain(SECRET);
  });
});
