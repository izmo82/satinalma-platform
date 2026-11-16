// v2 Faz 1 (D93/D95): sipariş açma/değişiklik/kapatma, mal kabul, fatura onayı ve tolerans kaldırıldı (testler atlandı); eski (v1) sipariş ve onay durumu gereken korunan testlerde test verisi modül işleviyle
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { syntheticPdf, ublInvoiceXml } from '../src/devdata.ts';
import { makeHarness } from './harness.ts';
import { withTenant, type TenantContext } from '../src/db.ts';
import { approveInvoice, contractOptions, createInvoice, createPo, recordReceipt, setAllocations } from '../src/modules/invoices.ts';

// Faz 4 açıkları: e-Fatura XML → fatura, vergi aritmetiği, sipariş değişikliği/kapatma/iptal, tolerans kuralı. Gerçek PostgreSQL + RLS; veri sentetik.
let h: Awaited<ReturnType<typeof makeHarness>>;
let sellerVkn: string;
beforeAll(async () => {
  h = await makeHarness();
  sellerVkn = (await h.owner.query<{ tax_id: string }>(`SELECT tax_id FROM suppliers WHERE id = $1`, [h.world.suppliers.s1])).rows[0]!.tax_id;
});
afterAll(async () => { await h.close(); });

type Who = 'buyer' | 'finance' | 'finance2' | 'legal' | 'legal2' | 'masterData';
const call = (who: Who, method: string, url: string, body?: unknown) => h.call(who, method, url, body === undefined ? {} : { body });
const goodLines = [
  { name: 'Yedek disk 2 TB', qty: '3', unitCode: 'C62', price: '333.33', net: '999.99', rate: '20', tax: '200.00' },
  { name: 'Kurulum', qty: '2', unitCode: 'HUR', price: '500', net: '1000.00', rate: '20', tax: '200.00' },
];
const xml = (o: Partial<Parameters<typeof ublInvoiceXml>[0]> = {}) => ({
  name: `efatura-${randomUUID().slice(0, 6)}.xml`, mime: 'application/xml',
  data: ublInvoiceXml({ invoiceNo: `EFT${randomUUID().slice(0, 10).replace(/-/g, '')}`, ettn: randomUUID(), sellerVkn, sellerName: 'Anadolu Bilişim (SENTETİK)',
    buyerVkn: h.world.companyA1.vkn, buyerName: h.world.companyA1.name, lines: goodLines, taxTotal: '400.00', amount: '2399.99', ...o }),
});
const upload = (f: ReturnType<typeof xml>) => h.upload('finance', f, { companyId: h.world.companyA1.id, kind: 'INVOICE', title: f.name });
const issueCodes = async (id: string) => ((await call('finance', 'GET', `/api/v1/invoices/${id}`)).body.check.issues as { code: string }[]).map((x) => x.code);

describe('e-Fatura XML → fatura (deterministik)', () => {
  it('satırlar, birim, KDV ve beyan edilen toplamlar okunur; vergi tutarlı ise vergi bulgusu yok', async () => {
    const up = await upload(xml());
    expect(up.status).toBe(201);
    expect(up.body.invoice).toMatchObject({ created: true, duplicate: false });
    const inv = (await call('finance', 'GET', `/api/v1/invoices/${up.body.invoice.invoiceId}`)).body;
    expect(inv.invoice).toMatchObject({ kind: 'INVOICE', supplierId: h.world.suppliers.s1, declaredTaxTotal: '400.00', declaredPayable: '2399.99', documentVersionId: up.body.documentVersionId });
    expect(inv.lines.map((l: any) => [l.unit, l.quantity, l.unitPrice, l.netAmount, l.taxAmount])).toEqual([['adet', '3', '333.33', '999.99', '200.00'], ['saat', '2', '500', '1000.00', '200.00']]);
    expect(inv.check.taxTotal).toBe('400.00');
    expect(inv.check.grossAmount).toBe('2399.99');
    expect(inv.check.issues.filter((x: any) => x.code.startsWith('TAX') || x.code === 'PAYABLE_MISMATCH')).toEqual([]);
    expect(inv.intake[0]).toMatchObject({ source: 'einvoice', duplicate: false });
  });

  it('aynı ETTN farklı dosyada tekrar gelirse ikinci fatura açılmaz, tekrar izi görünür', async () => {
    const ettn = randomUUID(); const no = `EFT${randomUUID().slice(0, 8)}`;
    const a = await upload(xml({ ettn, invoiceNo: no }));
    const b = await upload(xml({ ettn, invoiceNo: no, sellerName: 'Anadolu Bilişim A.Ş. (SENTETİK, yeniden gönderim)' }));
    expect(b.body.invoice).toMatchObject({ created: false, duplicate: true, invoiceId: a.body.invoice.invoiceId });
    const inv = (await call('finance', 'GET', `/api/v1/invoices/${a.body.invoice.invoiceId}`)).body;
    expect(inv.intake.map((x: any) => x.duplicate)).toEqual([false, true]);
  });

  it('yanlış KDV ve tutmayan ödenecek tutar onayı engeller; sorumlu finans', async () => {
    const up = await upload(xml({ lines: [{ ...goodLines[0]!, tax: '180.00' }, goodLines[1]!], taxTotal: '380.00', amount: '2500.00' }));
    const codes = await issueCodes(up.body.invoice.invoiceId);
    expect(codes).toEqual(expect.arrayContaining(['TAX_LINE_MISMATCH', 'PAYABLE_MISMATCH']));
    const inv = (await call('finance', 'GET', `/api/v1/invoices/${up.body.invoice.invoiceId}`)).body;
    expect(inv.check.canApprove).toBe(false);
    expect(inv.check.issues.find((x: any) => x.code === 'TAX_LINE_MISMATCH').ownerRole).toBe('FINANCE');
  });

  it('tevkifatlı fatura: ödenecek = net + KDV − tevkifat', async () => {
    const up = await upload(xml({ withholding: '200.00', amount: '2199.99' }));
    const inv = (await call('finance', 'GET', `/api/v1/invoices/${up.body.invoice.invoiceId}`)).body;
    expect(inv.check.grossAmount).toBe('2199.99');
    expect(inv.check.issues.filter((x: any) => /TAX|PAYABLE|WITHHOLDING/.test(x.code))).toEqual([]);
  });

  it('alıcı başka şirket, satır yok veya özgün faturası olmayan iade: kayıt açılmaz, sebep finans görevine düşer', async () => {
    const wrongBuyer = await upload(xml({ buyerVkn: h.world.companyA2.vkn }));
    expect(wrongBuyer.body.invoice).toMatchObject({ created: false, invoiceId: null });
    expect(wrongBuyer.body.invoice.reason).toContain('alıcı');
    const noLines = await upload(xml({ lines: [] }));
    expect(noLines.body.invoice.reason).toContain('satırı yok');
    const orphan = await upload(xml({ typeCode: 'IADE', billingRef: 'YOK2026000001' }));
    expect(orphan.body.invoice.reason).toContain('özgün fatura');
    const tasks = (await call('finance', 'GET', '/api/v1/tasks?view=all')).body.items as { entityId: string; title: string }[];
    expect(tasks.filter((t) => [wrongBuyer, noLines, orphan].some((u) => u.body.documentVersionId === t.entityId) && t.title.includes('dönüştürülemedi'))).toHaveLength(3);
  });

  it('IADE türü özgün faturaya bağlı iade/alacak belgesi olarak açılır', async () => {
    const no = `EFT${randomUUID().slice(0, 8)}`;
    const orig = await upload(xml({ invoiceNo: no }));
    const ret = await upload(xml({ typeCode: 'IADE', billingRef: no, lines: [goodLines[1]!], taxTotal: '200.00', amount: '1200.00' }));
    const inv = (await call('finance', 'GET', `/api/v1/invoices/${ret.body.invoice.invoiceId}`)).body;
    expect(inv.invoice).toMatchObject({ kind: 'CREDIT_NOTE', originalInvoiceId: orig.body.invoice.invoiceId });
  });

  it('UBL-TR temel kuralları (D81): uygun belgede bulgu yok; sonuç belge, fatura ve denetim izinde', async () => {
    const no = `ABC2026${String(Date.now()).slice(-9)}`;
    const up = await upload(xml({ invoiceNo: no, typeCode: 'SATIS' }));
    expect(up.status).toBe(201);
    expect(up.body.ublCheck).toMatchObject({ errors: 0, warnings: 0, findings: [] });
    const doc = (await call('finance', 'GET', `/api/v1/document-versions/${up.body.documentVersionId}`)).body;
    expect(doc.ublCheck).toMatchObject({ errors: 0, warnings: 0, profileId: 'TICARIFATURA', typeCode: 'SATIS' });
    expect((await call('finance', 'GET', `/api/v1/invoices/${up.body.invoice.invoiceId}`)).body.ublCheck).toMatchObject({ errors: 0 });
    const ev = await h.owner.query(`SELECT data FROM audit_events WHERE action = 'einvoice.checked' AND entity_id = $1`, [up.body.documentVersionId]);
    expect(ev.rows[0]?.data).toMatchObject({ errors: 0, warnings: 0 });
  });

  it('UBL-TR kusurlu belge: bulgular kaydedilir ama fatura kaydı yine açılır (onay engeli değil); kayıt değiştirilemez', async () => {
    const up = await upload(xml({ profileId: null, lineCount: 5, typeCode: 'TEVKIFAT' }));
    expect(up.body.invoice).toMatchObject({ created: true });
    const rules = (up.body.ublCheck.findings as { rule: string; severity: string }[]).map((f) => `${f.severity}:${f.rule}`);
    expect(rules).toEqual(expect.arrayContaining(['ERROR:PROFILE_MISSING', 'ERROR:LINE_COUNT', 'ERROR:INVOICE_NO_FORMAT', 'ERROR:WITHHOLDING_MISSING']));
    expect(up.body.ublCheck.errors).toBe(rules.filter((r) => r.startsWith('ERROR')).length);
    const inv = (await call('finance', 'GET', `/api/v1/invoices/${up.body.invoice.invoiceId}`)).body;
    expect(inv.check.issues.map((x: any) => x.code).some((c: string) => /UBL|PROFILE|LINE_COUNT/.test(c))).toBe(false);
    // Aynı dosya tekrar gelirse yeni denetim kaydı açılmaz.
    expect((await h.owner.query(`SELECT count(*)::int AS n FROM einvoice_checks WHERE document_version_id = $1`, [up.body.documentVersionId])).rows[0].n).toBe(1);
    await expect(withTenant(h.pool, { tenantId: h.world.tenantA, userId: h.world.users.finance.id, roles: [], companyIds: [h.world.companyA1.id], departmentIds: [], allDepartments: true, correlationId: 'd81' },
      (tx) => tx.query(`UPDATE einvoice_checks SET error_count = 0 WHERE document_version_id = $1`, [up.body.documentVersionId]))).rejects.toThrow(/permission denied/);
    // Şirket kapsamı dışındaki kullanıcı kaydı göremez (RLS).
    const other = await withTenant(h.pool, { tenantId: h.world.tenantA, userId: h.world.users.finance.id, roles: [], companyIds: [h.world.companyA2.id], departmentIds: [], allDepartments: true, correlationId: 'd81' },
      (tx) => tx.query(`SELECT 1 FROM einvoice_checks WHERE document_version_id = $1`, [up.body.documentVersionId]));
    expect(other.rowCount).toBe(0);
  });

  it('UBL-TR: geçersiz tarih yüklemeyi düşürmez (bulgu olur); UBL olmayan XML "e-Fatura değil" kaydı alır ve elle girişe gider', async () => {
    const bad = await upload(xml({ issueDate: '2026-13-01' }));
    expect(bad.status).toBe(201);
    expect((bad.body.ublCheck.findings as { rule: string }[]).map((f) => f.rule)).toContain('ISSUE_DATE');
    expect(bad.body.invoice).toMatchObject({ created: false });
    expect(bad.body.invoice.reason).toContain('tarih');
    const notUbl = await upload({ name: `x-${randomUUID().slice(0, 6)}.xml`, mime: 'application/xml', data: Buffer.from(`<?xml version="1.0"?><Order><ID>${randomUUID()}</ID></Order>`) });
    expect(notUbl.status).toBe(201);
    expect(notUbl.body.processing.stage).toBe('MANUAL_EXTRACTION_REQUIRED');
    expect(notUbl.body.ublCheck).toMatchObject({ errors: 1, findings: [{ rule: 'NOT_UBL' }] });
    expect((await call('finance', 'GET', `/api/v1/document-versions/${notUbl.body.documentVersionId}`)).body.ublCheck.findings[0].rule).toBe('NOT_UBL');
    // İyi biçimli olmayan XML "okundu" sayılmaz: aday tedarikçi açılmaz, elle girişe gider.
    const broken = await upload({ name: `b-${randomUUID().slice(0, 6)}.xml`, mime: 'application/xml', data: Buffer.from(`<?xml version="1.0"?><Invoice><cbc:ID>bozuk-${randomUUID()}`) });
    expect(broken.status).toBe(201);
    expect(broken.body).toMatchObject({ supplier: null, processing: { stage: 'MANUAL_EXTRACTION_REQUIRED' }, ublCheck: { findings: [{ rule: 'NOT_UBL' }] } });
  });

  it('UBL-TR: aynı dosya tekrar yüklenirse önceki denetim sonucu döner', async () => {
    const f = xml();
    const a = await upload(f);
    const b = await upload(f);
    expect(b.body.duplicate).toBe(true);
    expect(b.body.ublCheck).toEqual(a.body.ublCheck);
  });

  it('elle girişte de belge toplamı satırlarla karşılaştırılır', async () => {
    const r = await call('finance', 'POST', '/api/v1/invoices', { companyId: h.world.companyA1.id, supplierId: h.world.suppliers.s1, kind: 'INVOICE', invoiceNo: `MAN${randomUUID().slice(0, 8)}`,
      issueDate: '2026-10-20', currency: 'TRY', lines: [{ description: 'Hizmet', quantity: '1', unit: 'ay', unitPrice: '1000', netAmount: '1000.00', taxRate: '20' }],
      declaredTaxTotal: '200.00', declaredPayable: '1250.00' });
    expect(r.status).toBe(201);
    expect(await issueCodes(r.body.id)).toContain('PAYABLE_MISMATCH');
  });
});

async function contract(ceiling: string) {
  const up = await h.upload('legal', { name: 's.pdf', mime: 'application/pdf', data: syntheticPdf([[`SENTETIK ${randomUUID()}`]]) },
    { companyId: h.world.companyA1.id, kind: 'CONTRACT', title: 'Tedarik Sözleşmesi (SENTETİK)' });
  const c = await call('legal', 'POST', '/api/v1/contracts', { title: `Tedarik ${randomUUID().slice(0, 4)} (SENTETİK)`, documentVersionId: up.body.documentVersionId,
    stage: 'EXECUTION', signatureMethod: 'NOT_REQUIRED', originalCustodyRequired: false,
    parties: [{ role: 'BUYER', displayName: h.world.companyA1.name, legalEntityId: h.world.companyA1.id }], supplierId: h.world.suppliers.s1 });
  const cv = c.body.contractVersionId as string;
  const t = await call('legal', 'POST', `/api/v1/contract-versions/${cv}/terms`, { currency: 'TRY', valueType: 'CEILING', amount: ceiling, paymentTerms: '30 gün',
    startDate: '2026-01-01', endDate: '2027-12-31', autoRenewal: false, renewalMonths: null, noticeAmount: null, noticeUnit: null, nonWorkingDay: 'AS_IS', sourceRef: 'Madde 5 (sentetik)' });
  expect((await call('legal2', 'POST', `/api/v1/contract-terms/${t.body.id}/verify`)).status).toBe(200);
  return cv;
}
async function po(cv: string | null, qty = '10', price = '1000') {
  const r = await call('buyer', 'POST', '/api/v1/purchase-orders', { companyId: h.world.companyA1.id, supplierId: h.world.suppliers.s1, contractVersionId: cv, currency: 'TRY',
    lines: [{ kind: 'GOODS', description: 'Yedek parça (sentetik)', unit: 'adet', quantity: qty, unitPrice: price }] });
  expect(r.status).toBe(201);
  return r.body.id as string;
}
const getPo = async (id: string) => (await call('buyer', 'GET', `/api/v1/purchase-orders/${id}`)).body;
const limit = async (cv: string) => (await call('finance', 'GET', `/api/v1/contract-versions/${cv}/limit`)).body;
const reason = 'Talep sahibi miktarı güncelledi (sentetik)';
/** Onay incelenen sürüme bağlıdır: önce güncel kontrol parmak izi okunur (If-Match). */
const approve = async (id: string) => {
  const fp = (await call('finance2', 'GET', `/api/v1/invoices/${id}`)).body.checkFingerprint as string;
  return h.call('finance2', 'POST', `/api/v1/invoices/${id}/approve`, { headers: { 'if-match': fp } });
};

// v2 (D93): sipariş, mal kabul ve fatura onayı uçları kaldırıldı. Eski (v1) siparişe bağlı faturaların kontrolleri (tedarikçi/şirket uyuşmazlığı,
// iade, engel işareti) korunduğu için bu durumlar test verisi olarak modül işlevleriyle yazılır (API ucu değil, ürün davranışı değil).
const legacyCtx = (userId = h.world.users.buyer.id): TenantContext => ({ tenantId: h.world.tenantA, userId, roles: ['PROCUREMENT'], companyIds: [h.world.companyA1.id],
  departmentIds: [], allDepartments: true, correlationId: 'v2-legacy-po' });
async function legacyPo(cv: string | null, qty = '10', price = '1000') {
  const ctx = legacyCtx();
  const r = await withTenant(h.pool, ctx, (tx) => createPo(tx, ctx, { companyId: h.world.companyA1.id, supplierId: h.world.suppliers.s1, contractVersionId: cv, currency: 'TRY',
    lines: [{ kind: 'GOODS', description: 'Yedek parça (sentetik)', unit: 'adet', quantity: qty, unitPrice: price }] } as never));
  return r.id as string;
}
const legacyPoLine = async (poId: string) => (await h.owner.query<{ id: string }>(`SELECT id FROM po_lines WHERE po_id = $1 ORDER BY line_no`, [poId])).rows[0]!.id;
const legacyReceive = (poLineId: string, quantity: string) => { const ctx = legacyCtx(); return withTenant(h.pool, ctx, (tx) => recordReceipt(tx, ctx, poLineId, { quantity, note: 'Teslim alındı (sentetik)' })); };
const legacyApprove = (invoiceId: string) => { const ctx = legacyCtx(h.world.users.finance2.id); return withTenant(h.pool, ctx, (tx) => approveInvoice(tx, ctx, invoiceId, null)); };

describe('sipariş değişikliği', () => {
  // v2 Faz 1 (D93): işlev onaylı kaldırma listesinde; davranış removed-v1.test.ts ile 403 olarak korunur
  it.skip('miktar artışı limit kilidiyle kontrol edilir; özgün kalem korunur, revizyon ve fark görünür', async () => {
    const cv = await contract('20000.00');
    const id = await po(cv);
    const line = (await getPo(id)).lines[0].poLineId;
    const over = await call('buyer', 'POST', `/api/v1/purchase-orders/${id}/changes`, { baseChangeNo: 0, reason, lines: [{ poLineId: line, quantity: '25', unitPrice: '1000' }] });
    expect(over.status).toBe(422);
    expect(over.body.error.code).toBe('limit_exceeded');
    const ok = await call('buyer', 'POST', `/api/v1/purchase-orders/${id}/changes`, { baseChangeNo: 0, reason, lines: [{ poLineId: line, quantity: '15', unitPrice: '1000' }],
      add: [{ kind: 'SERVICE', description: 'Montaj hizmeti', unit: 'saat', quantity: '4', unitPrice: '500' }] });
    expect(ok.status).toBe(201);
    expect(ok.body).toEqual({ changeNo: 1, delta: '7000.00' });
    const p = await getPo(id);
    expect(p.lines.map((l: any) => [l.orderedQty, l.originalQty, l.revision])).toEqual([['15', '10', 1], ['4', '4', 0]]);
    expect(p.changes[0]).toMatchObject({ changeNo: 1, kind: 'CHANGE', reason });
    expect((await limit(cv)).openCommitment).toBe('17000.00');
    // Eski sürümü gören ikinci düzenleme kaybolmaz: 409.
    const stale = await call('buyer', 'POST', `/api/v1/purchase-orders/${id}/changes`, { baseChangeNo: 0, reason, lines: [{ poLineId: line, quantity: '12', unitPrice: '1000' }] });
    expect(stale.status).toBe(409);
  });

  // v2 Faz 1 (D93): işlev onaylı kaldırma listesinde; davranış removed-v1.test.ts ile 403 olarak korunur
  it.skip('kabul edilen miktarın altına inemez; faturalanmış kalemin fiyatı değişmez; gerekçe zorunlu; yalnız satınalma', async () => {
    const id = await po(null, '10', '100');
    const line = (await getPo(id)).lines[0].poLineId;
    await call('buyer', 'POST', `/api/v1/po-lines/${line}/receipts`, { quantity: '6', note: 'Teslim alındı (sentetik)' });
    const below = await call('buyer', 'POST', `/api/v1/purchase-orders/${id}/changes`, { baseChangeNo: 0, reason, lines: [{ poLineId: line, quantity: '5', unitPrice: '100' }] });
    expect(below.body.error.code).toBe('below_consumed');
    const noReason = await call('buyer', 'POST', `/api/v1/purchase-orders/${id}/changes`, { baseChangeNo: 0, reason: 'kısa', lines: [{ poLineId: line, quantity: '8', unitPrice: '100' }] });
    expect(noReason.body.error.code).toBe('reason_required');
    expect((await call('finance', 'POST', `/api/v1/purchase-orders/${id}/changes`, { baseChangeNo: 0, reason, lines: [{ poLineId: line, quantity: '8', unitPrice: '100' }] })).status).toBe(403);
    const inv = await call('finance', 'POST', '/api/v1/invoices', { companyId: h.world.companyA1.id, supplierId: h.world.suppliers.s1, kind: 'INVOICE', invoiceNo: `PO${randomUUID().slice(0, 8)}`,
      issueDate: '2026-10-20', currency: 'TRY', lines: [{ description: 'Yedek parça', quantity: '6', unit: 'adet', unitPrice: '100', netAmount: '600.00' }] });
    await call('finance', 'PUT', `/api/v1/invoices/${inv.body.id}/allocations`, { allocations: [{ lineNo: 1, poLineId: line, contractVersionId: null, quantity: '6', amount: '600.00' }] });
    expect((await approve(inv.body.id)).status).toBe(200);
    const price = await call('buyer', 'POST', `/api/v1/purchase-orders/${id}/changes`, { baseChangeNo: 0, reason, lines: [{ poLineId: line, quantity: '10', unitPrice: '120' }] });
    expect(price.body.error.code).toBe('price_locked');
  });
});

describe('sipariş kapatma ve iptal', () => {
  // v2 Faz 1 (D93): işlev onaylı kaldırma listesinde; davranış removed-v1.test.ts ile 403 olarak korunur
  it.skip('tüketim varsa kapatılır: kalan taahhüt serbest kalır, yeni kabul yapılamaz', async () => {
    const cv = await contract('50000.00');
    const id = await po(cv, '10', '1000');
    const line = (await getPo(id)).lines[0].poLineId;
    await call('buyer', 'POST', `/api/v1/po-lines/${line}/receipts`, { quantity: '4', note: 'Kısmi teslim (sentetik)' });
    expect((await limit(cv)).openCommitment).toBe('10000.00');
    const r = await call('buyer', 'POST', `/api/v1/purchase-orders/${id}/close`, { baseChangeNo: 0, reason: 'Kalan miktar artık gerekmiyor (sentetik)' });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ status: 'CLOSED', released: '6000.00' });
    const p = await getPo(id);
    expect(p.po).toMatchObject({ status: 'CLOSED', closeReason: 'Kalan miktar artık gerekmiyor (sentetik)' });
    expect(p.lines[0]).toMatchObject({ orderedQty: '4', originalQty: '10' });
    // Kabul edilmiş 4 birim henüz faturalanmadı: taahhüt olarak kalır.
    expect((await limit(cv)).openCommitment).toBe('4000.00');
    expect((await call('buyer', 'POST', `/api/v1/po-lines/${line}/receipts`, { quantity: '1', note: 'Geç teslim (sentetik)' })).status).toBe(409);
    expect((await call('buyer', 'POST', `/api/v1/purchase-orders/${id}/close`, { baseChangeNo: 1, reason: 'Tekrar kapatma denemesi' })).status).toBe(409);
  });

  // v2 Faz 1 (D93): işlev onaylı kaldırma listesinde; davranış removed-v1.test.ts ile 403 olarak korunur
  it.skip('hiç tüketim yoksa iptal edilir: taahhüt sıfır, iptal edilmiş siparişe fatura bağlanamaz', async () => {
    const cv = await contract('50000.00');
    const id = await po(cv, '5', '1000');
    const line = (await getPo(id)).lines[0].poLineId;
    const r = await call('buyer', 'POST', `/api/v1/purchase-orders/${id}/close`, { baseChangeNo: 0, reason: 'Proje ertelendi, sipariş iptal (sentetik)' });
    expect(r.body).toMatchObject({ status: 'CANCELLED', released: '5000.00' });
    expect((await limit(cv)).openCommitment).toBe('0.00');
    const inv = await call('finance', 'POST', '/api/v1/invoices', { companyId: h.world.companyA1.id, supplierId: h.world.suppliers.s1, kind: 'INVOICE', invoiceNo: `CX${randomUUID().slice(0, 8)}`,
      issueDate: '2026-10-20', currency: 'TRY', lines: [{ description: 'Yedek parça', quantity: '1', unit: 'adet', unitPrice: '1000', netAmount: '1000.00' }] });
    await call('finance', 'PUT', `/api/v1/invoices/${inv.body.id}/allocations`, { allocations: [{ lineNo: 1, poLineId: line, contractVersionId: null, quantity: '1', amount: '1000.00' }] });
    expect(await issueCodes(inv.body.id)).toContain('PO_CANCELLED');
  });
});

describe('tolerans kuralı', () => {
  // v2 Faz 1 (D93): işlev onaylı kaldırma listesinde; davranış removed-v1.test.ts ile 403 olarak korunur
  it.skip('finans kural koyar, listeler ve kaldırır; satınalma koyamaz; geçersiz yüzde reddedilir', async () => {
    const cur = 'CHF';
    expect((await call('buyer', 'PUT', '/api/v1/tolerance-rules', { currency: cur, absAmount: '50', percent: null, combine: 'LOWER' })).status).toBe(403);
    expect((await call('finance', 'PUT', '/api/v1/tolerance-rules', { currency: cur, absAmount: null, percent: '150', combine: 'LOWER' })).status).toBe(422);
    expect((await call('finance', 'PUT', '/api/v1/tolerance-rules', { currency: cur, absAmount: '50.00', percent: '1', combine: 'LOWER' })).status).toBe(200);
    const list = (await call('buyer', 'GET', '/api/v1/tolerance-rules')).body;
    expect(list.can.manage).toBe(false);
    expect(list.items.find((x: any) => x.currency === cur)).toMatchObject({ absAmount: '50.00', percent: '1', combine: 'LOWER' });
    expect((await call('finance', 'DELETE', `/api/v1/tolerance-rules/${cur}`)).status).toBe(200);
    expect((await call('finance', 'GET', '/api/v1/tolerance-rules')).body.items.find((x: any) => x.currency === cur)).toBeUndefined();
  });
});

describe('inceleme bulguları (regresyon)', () => {
  it('ÖİV gibi KDV dışı vergi: KDV matrahına ve ödenecek tutara girer, fatura engellenmez', async () => {
    const up = await upload(xml({ lines: [{ name: 'Hat ücreti', qty: '1', unitCode: 'MON', price: '1000', net: '1000.00', rate: '20', tax: '220.00', oiv: '100.00' }],
      taxTotal: '220.00', oivTotal: '100.00', amount: '1320.00' }));
    expect(up.body.invoice.created).toBe(true);
    const inv = (await call('finance', 'GET', `/api/v1/invoices/${up.body.invoice.invoiceId}`)).body;
    expect(inv.check).toMatchObject({ taxTotal: '220.00', otherTaxTotal: '100.00', grossAmount: '1320.00' });
    expect(inv.check.issues.filter((x: any) => /TAX|PAYABLE/.test(x.code))).toEqual([]);
  });

  it('Faz 4: e-Faturadaki KDV dışı vergi kodu ve oranıyla ayrı alınır; oranı tutmayan tutar onayı engeller', async () => {
    const up = await upload(xml({ lines: [{ name: 'Hat ücreti', qty: '1', unitCode: 'MON', price: '1000', net: '1000.00', rate: '20', tax: '216.00', oiv: '80.00' }],
      taxTotal: '216.00', oivTotal: '80.00', amount: '1296.00' }));
    expect(up.body.invoice.created).toBe(true);
    const inv = (await call('finance', 'GET', `/api/v1/invoices/${up.body.invoice.invoiceId}`)).body;
    expect(inv.lines[0].otherTaxes).toEqual([{ code: '4080', name: null, rate: '10', amount: '80.00' }]);
    expect(inv.check.issues.find((x: any) => x.code === 'OTHER_TAX_RATE_MISMATCH')).toMatchObject({ severity: 'BLOCK' });
    expect(inv.check.canApprove).toBe(false);
  });

  it('geçersiz ETTN, olmayan tarih veya negatif tutar: belge saklanır, fatura açılmaz, sebep görünür', async () => {
    for (const o of [{ ettn: 'not-a-uuid' }, { issueDate: '2026-02-30' }, { amount: '-5.00' }]) {
      const up = await upload(xml(o));
      expect(up.status).toBe(201);
      expect(up.body.invoice).toMatchObject({ created: false, invoiceId: null });
      expect(up.body.invoice.reason).toBeTruthy();
    }
  });

  // v2 Faz 1 (D93): işlev onaylı kaldırma listesinde; davranış removed-v1.test.ts ile 403 olarak korunur
  it.skip('karar bekleyen faturası olan sipariş kapatılamaz (taahhüt erken serbest kalmaz)', async () => {
    const id = await po(null, '10', '100');
    const line = (await getPo(id)).lines[0].poLineId;
    const inv = await call('finance', 'POST', '/api/v1/invoices', { companyId: h.world.companyA1.id, supplierId: h.world.suppliers.s1, kind: 'INVOICE', invoiceNo: `PD${randomUUID().slice(0, 8)}`,
      issueDate: '2026-10-20', currency: 'TRY', lines: [{ description: 'Yedek parça', quantity: '3', unit: 'adet', unitPrice: '100', netAmount: '300.00' }] });
    await call('finance', 'PUT', `/api/v1/invoices/${inv.body.id}/allocations`, { allocations: [{ lineNo: 1, poLineId: line, contractVersionId: null, quantity: '3', amount: '300.00' }] });
    const r = await call('buyer', 'POST', `/api/v1/purchase-orders/${id}/close`, { baseChangeNo: 0, reason: 'Kalan artık gerekmiyor (sentetik)' });
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe('pending_invoices');
  });

  // v2 Faz 1 (D93): işlev onaylı kaldırma listesinde; davranış removed-v1.test.ts ile 403 olarak korunur
  it.skip('istisna onayından sonra sipariş fiyatı değişirse istisna eskir; eski onayla finans onayı verilemez', async () => {
    const id = await po(null, '10', '100');
    const line = (await getPo(id)).lines[0].poLineId;
    await call('buyer', 'POST', `/api/v1/po-lines/${line}/receipts`, { quantity: '10', note: 'Teslim alındı (sentetik)' });
    const inv = await call('finance', 'POST', '/api/v1/invoices', { companyId: h.world.companyA1.id, supplierId: h.world.suppliers.s1, kind: 'INVOICE', invoiceNo: `FP${randomUUID().slice(0, 8)}`,
      issueDate: '2026-10-20', currency: 'TRY', lines: [{ description: 'Yedek parça', quantity: '10', unit: 'adet', unitPrice: '102', netAmount: '1020.00' }] });
    await call('finance', 'PUT', `/api/v1/invoices/${inv.body.id}/allocations`, { allocations: [{ lineNo: 1, poLineId: line, contractVersionId: null, quantity: '10', amount: '1020.00' }] });
    expect(await issueCodes(inv.body.id)).toContain('PRICE_MISMATCH');
    expect((await call('legal2', 'POST', `/api/v1/invoices/${inv.body.id}/exception-approval`, { reason: 'Kur farkı nedeniyle 2 TL fark kabul (sentetik)' })).status).toBe(200);
    expect((await call('finance', 'GET', `/api/v1/invoices/${inv.body.id}`)).body.status).toBe('EXCEPTION_APPROVED');
    expect((await call('buyer', 'POST', `/api/v1/purchase-orders/${id}/changes`, { baseChangeNo: 0, reason, lines: [{ poLineId: line, quantity: '10', unitPrice: '80' }] })).status).toBe(201);
    const after = (await call('finance', 'GET', `/api/v1/invoices/${inv.body.id}`)).body;
    expect(after.exceptionCurrent).toBe(false);
    const ap = await approve(inv.body.id);
    expect(ap.status).toBe(409);
    expect(ap.body.error.code).toBe('exception_stale');
  });

  // v2 Faz 1 (D93): işlev onaylı kaldırma listesinde; davranış removed-v1.test.ts ile 403 olarak korunur
  it.skip('eşzamanlı kabul ve kapatma: kabul hiçbir durumda sipariş miktarını aşmaz', async () => {
    for (let i = 0; i < 5; i++) {
      const id = await po(null, '10', '100');
      const line = (await getPo(id)).lines[0].poLineId;
      await call('buyer', 'POST', `/api/v1/po-lines/${line}/receipts`, { quantity: '5', note: 'İlk teslim (sentetik)' });
      await Promise.all([
        call('buyer', 'POST', `/api/v1/purchase-orders/${id}/close`, { baseChangeNo: 0, reason: 'Kalan artık gerekmiyor (sentetik)' }),
        call('buyer', 'POST', `/api/v1/po-lines/${line}/receipts`, { quantity: '3', note: 'Geç teslim (sentetik)' }),
      ]);
      const l = (await getPo(id)).lines[0];
      expect(Number(l.receivedQty)).toBeLessThanOrEqual(Number(l.orderedQty));
    }
  });
});

describe('T44 nihai onay görülen sürüme bağlı', () => {
  // v2 Faz 1 (D93): işlev onaylı kaldırma listesinde; davranış removed-v1.test.ts ile 403 olarak korunur
  it.skip('If-Match yoksa 428; inceleme sonrası tahsis değiştiyse eski parmak iziyle onay 409', async () => {
    const id = await po(null, '10', '100');
    const line = (await getPo(id)).lines[0].poLineId;
    await call('buyer', 'POST', `/api/v1/po-lines/${line}/receipts`, { quantity: '10', note: 'Teslim alındı (sentetik)' });
    const inv = await call('finance', 'POST', '/api/v1/invoices', { companyId: h.world.companyA1.id, supplierId: h.world.suppliers.s1, kind: 'INVOICE', invoiceNo: `T44${randomUUID().slice(0, 8)}`,
      issueDate: '2026-10-20', currency: 'TRY', lines: [{ description: 'Yedek parça', quantity: '10', unit: 'adet', unitPrice: '100', netAmount: '1000.00' }] });
    const alloc = (q: string) => call('finance', 'PUT', `/api/v1/invoices/${inv.body.id}/allocations`, { allocations: [{ lineNo: 1, poLineId: line, contractVersionId: null, quantity: q, amount: '1000.00' }] });
    await alloc('10');
    const seen = (await call('finance2', 'GET', `/api/v1/invoices/${inv.body.id}`)).body.checkFingerprint;
    expect((await call('finance2', 'POST', `/api/v1/invoices/${inv.body.id}/approve`)).status).toBe(428);
    await alloc('9');
    const stale = await h.call('finance2', 'POST', `/api/v1/invoices/${inv.body.id}/approve`, { headers: { 'if-match': seen } });
    expect(stale.status).toBe(409);
    expect(stale.body.error.code).toBe('invoice_changed');
    await alloc('10');
    expect((await approve(inv.body.id)).status).toBe(200);
  });
});

describe('zayıf bağlantı: yanıtı kaybolan istek tekrar gönderilince ikinci kayıt açılmaz', () => {
  // v2 Faz 1 (D93): işlev onaylı kaldırma listesinde; davranış removed-v1.test.ts ile 403 olarak korunur
  it.skip('aynı Idempotency-Key ile kabul ve olay tek kayıt; anahtar başka kalemde kullanılırsa 409', async () => {
    const id = await po(null, '10', '100');
    const line = (await getPo(id)).lines[0].poLineId;
    const key = `rcpt-${randomUUID()}`;
    const send = () => h.call('buyer', 'POST', `/api/v1/po-lines/${line}/receipts`, { body: { quantity: '5', note: 'Mobil kabul (sentetik)' }, headers: { 'idempotency-key': key } });
    const a = await send(); const b = await send();
    expect(a.status).toBe(201);
    expect(b.body).toMatchObject({ id: a.body.id, duplicate: true });
    expect((await getPo(id)).lines[0].receivedQty).toBe('5');
    const other = await po(null, '10', '100');
    const otherLine = (await getPo(other)).lines[0].poLineId;
    expect((await h.call('buyer', 'POST', `/api/v1/po-lines/${otherLine}/receipts`, { body: { quantity: '1', note: 'Yanlış anahtar (sentetik)' }, headers: { 'idempotency-key': key } })).status).toBe(409);
    // Aynı anahtar, aynı kalem ama farklı miktar: eski kayıt başarı diye dönmez.
    const changed = await h.call('buyer', 'POST', `/api/v1/po-lines/${line}/receipts`, { body: { quantity: '3', note: 'Mobil kabul (sentetik)' }, headers: { 'idempotency-key': key } });
    expect(changed.status).toBe(409);
    expect(changed.body.error.code).toBe('idempotency_mismatch');
    expect((await getPo(id)).lines[0].receivedQty).toBe('5');
    const ikey = `inc-${randomUUID()}`;
    const inc = () => h.call('buyer', 'POST', '/api/v1/incidents', { body: { supplierId: h.world.suppliers.s1, category: 'DELAY', severity: 'LOW', title: 'Mobil olay bildirimi',
      description: 'Bağlantı koptu, tekrar gönderildi (sentetik).', occurredOn: '2026-10-20' }, headers: { 'idempotency-key': ikey } });
    const i1 = await inc(); const i2 = await inc();
    expect(i2.body).toMatchObject({ id: i1.body.id, code: i1.body.code, duplicate: true });
    const i3 = await h.call('buyer', 'POST', '/api/v1/incidents', { body: { supplierId: h.world.suppliers.s1, category: 'DELAY', severity: 'HIGH', title: 'Mobil olay bildirimi',
      description: 'Bağlantı koptu, tekrar gönderildi (sentetik).', occurredOn: '2026-10-20' }, headers: { 'idempotency-key': ikey } });
    expect(i3.status).toBe(409);
    expect(i3.body.error.code).toBe('idempotency_mismatch');
  });
});

describe('tedarikçi seçim listesi: aynı adlı aday ayırt edilir (D82)', () => {
  it('geçersiz VKN ile aynı ünvanla açılan aday, aktif firmadan ayrı etiketle listelenir; aktif firmanın etiketi değişmez; tam vergi kimliği dönmez', async () => {
    const s1 = (await h.owner.query<{ legal_name: string }>(`SELECT legal_name FROM suppliers WHERE id = $1`, [h.world.suppliers.s1])).rows[0]!.legal_name;
    const badVkn = sellerVkn.slice(0, 9) + String((Number(sellerVkn[9]) + 1) % 10);
    const up = await upload(xml({ sellerVkn: badVkn, sellerName: s1 }));
    expect(up.status).toBe(201);
    const candidateId = up.body.supplier.supplierId as string;
    expect(up.body.supplier.outcome).toBe('IDENTITY_REVIEW_REQUIRED');
    expect(candidateId).not.toBe(h.world.suppliers.s1);

    const res = await call('buyer', 'GET', '/api/v1/supplier-options');
    expect(res.status).toBe(200);
    const items = res.body.items as { id: string; legalName: string; label: string; taxIdTail: string | null; identityVerified: boolean }[];
    const active = items.find((x) => x.id === h.world.suppliers.s1)!;
    const cand = items.find((x) => x.id === candidateId)!;
    expect(active.label).toBe(s1);
    expect(active).toMatchObject({ identityVerified: true, taxIdTail: `VKN …${sellerVkn.slice(-4)}` });
    expect(cand.legalName).toBe(s1);
    expect(cand.label).toBe(`${s1} · Aday, vergi kimliği doğrulanmadı`);
    expect(cand.identityVerified).toBe(false);
    expect(JSON.stringify(res.body)).not.toContain(sellerVkn);
  });
});

describe('fatura listesi: tedarikçinin durumu ve kimliği görünür (D83)', () => {
  const invoiceFor = async (supplierId: string) => {
    const r = await call('finance', 'POST', '/api/v1/invoices', { companyId: h.world.companyA1.id, supplierId, kind: 'INVOICE', invoiceNo: `D83${randomUUID().slice(0, 8)}`,
      issueDate: '2026-10-20', currency: 'TRY', lines: [{ description: 'Yedek parça', quantity: '1', unit: 'adet', unitPrice: '100', netAmount: '100.00' }] });
    expect(r.status).toBe(201);
    return r.body.id as string;
  };

  it('aynı ünvanlı adaya girilen fatura listede ve detayda ayırt edilir, onaya kapalıdır; aktif firmanın faturası doğrulanmış döner; vergi kimliği dönmez', async () => {
    const s1 = (await h.owner.query<{ legal_name: string }>(`SELECT legal_name FROM suppliers WHERE id = $1`, [h.world.suppliers.s1])).rows[0]!.legal_name;
    const badVkn = sellerVkn.slice(0, 9) + String((Number(sellerVkn[9]) + 1) % 10);
    const up = await upload(xml({ sellerVkn: badVkn, sellerName: s1 }));
    expect(up.status).toBe(201);
    const candidateInvoice = await invoiceFor(up.body.supplier.supplierId as string);
    const activeInvoice = await invoiceFor(h.world.suppliers.s1);

    const list = await call('finance', 'GET', '/api/v1/invoices');
    expect(list.status).toBe(200);
    const row = (id: string) => (list.body.items as { id: string }[]).find((x) => x.id === id)!;
    expect(row(candidateInvoice)).toMatchObject({ supplierName: s1, supplierStatus: 'CANDIDATE', supplierIdentityVerified: false });
    expect(row(activeInvoice)).toMatchObject({ supplierName: s1, supplierStatus: 'ACTIVE', supplierIdentityVerified: true });
    expect(JSON.stringify(list.body)).not.toContain(sellerVkn);

    const detail = await call('finance', 'GET', `/api/v1/invoices/${candidateInvoice}`);
    expect(detail.body.invoice).toMatchObject({ supplierStatus: 'CANDIDATE', supplierIdentityVerified: false });
    expect(detail.body.check.issues.map((x: { code: string }) => x.code)).toContain('SUPPLIER_NOT_ACTIVE');
    expect(detail.body.check.canApprove).toBe(false);
  });

  it('kimliği çözülüp mevcut firmaya birleştirilen adayın faturası "doğrulanmadı" görünmez; birleştirildiği görünür', async () => {
    const badVkn = sellerVkn.slice(0, 9) + String((Number(sellerVkn[9]) + 1) % 10);
    const up = await upload(xml({ sellerVkn: badVkn, sellerName: 'Birleşecek Aday (SENTETİK)' }));
    expect(up.status).toBe(201);
    const candidateId = up.body.supplier.supplierId as string;
    const invoiceId = await invoiceFor(candidateId);
    const before = await call('masterData', 'GET', `/api/v1/suppliers/${candidateId}`);
    const merged = await call('masterData', 'POST', `/api/v1/suppliers/${candidateId}/identity`,
      { country: 'TR', taxIdType: 'VKN', taxId: sellerVkn, rationale: 'Kaynak belgede VKN doğrulandı (sentetik)', expectedRowVersion: before.body.rowVersion });
    expect(merged.status).toBe(200);
    expect(merged.body.mergedInto).toBe(h.world.suppliers.s1);

    const list = await call('finance', 'GET', '/api/v1/invoices');
    expect((list.body.items as { id: string }[]).find((x) => x.id === invoiceId)).toMatchObject({ supplierStatus: 'MERGED', supplierIdentityVerified: true });
  });
});

describe('fatura tahsisi: sipariş faturanın tedarikçisine ait olmalı (D84)', () => {
  const invoiceFor = async (supplierId: string, extra: Record<string, unknown> = {}) => {
    const r = await call('finance', 'POST', '/api/v1/invoices', { companyId: h.world.companyA1.id, supplierId, kind: 'INVOICE', invoiceNo: `D84${randomUUID().slice(0, 8)}`,
      issueDate: '2026-10-20', currency: 'TRY', lines: [{ description: 'Yedek parça', quantity: '1', unit: 'adet', unitPrice: '100', netAmount: '100.00' }], ...extra });
    expect(r.status).toBe(201);
    return r.body.id as string;
  };
  const allocate = (invoiceId: string, poLineId: string) => call('finance', 'PUT', `/api/v1/invoices/${invoiceId}/allocations`, { allocations: [{ lineNo: 1, poLineId, contractVersionId: null, quantity: '1', amount: '100.00' }] });
  const poLineOf = async () => legacyPoLine(await legacyPo(null, '1', '100'));
  const sameNameCandidate = async (name: string) => {
    const badVkn = sellerVkn.slice(0, 9) + String((Number(sellerVkn[9]) + 1) % 10);
    const up = await upload(xml({ sellerVkn: badVkn, sellerName: name }));
    expect(up.status).toBe(201);
    return up.body.supplier.supplierId as string;
  };

  it('aynı ünvanlı adayın faturası aktif firmanın siparişine bağlanamaz; önceki tahsis değişmez', async () => {
    const s1 = (await h.owner.query<{ legal_name: string }>(`SELECT legal_name FROM suppliers WHERE id = $1`, [h.world.suppliers.s1])).rows[0]!.legal_name;
    const invoiceId = await invoiceFor(await sameNameCandidate(s1));
    const r = await allocate(invoiceId, await poLineOf());
    expect(r.status).toBe(422);
    expect(r.body.error.code).toBe('allocation_supplier_mismatch');
    expect((await call('finance', 'GET', `/api/v1/invoices/${invoiceId}`)).body.allocations).toEqual([]);
  });

  // v2 Faz 1 (D93): işlev onaylı kaldırma listesinde; davranış removed-v1.test.ts ile 403 olarak korunur
  it.skip('kendi siparişine tahsis çalışır; liste ve detay aynı tedarikçi kökünü döner', async () => {
    const invoiceId = await invoiceFor(h.world.suppliers.s1);
    const poLine = await poLineOf();
    expect((await allocate(invoiceId, poLine)).status).toBe(200);
    expect(await issueCodes(invoiceId)).not.toContain('SUPPLIER_MISMATCH');
    expect((await call('finance', 'GET', `/api/v1/invoices/${invoiceId}`)).body.invoice.supplierRootId).toBe(h.world.suppliers.s1);
    const pos = (await call('finance', 'GET', '/api/v1/purchase-orders')).body.items as { supplierRootId: string }[];
    expect(pos.length).toBeGreaterThan(0);
    expect(pos.every((x) => x.supplierRootId)).toBe(true);
  });

  it('önceden yanlış bağlanmış aktif firma faturası onaya kapanır', async () => {
    const invoiceId = await invoiceFor(h.world.suppliers.s2);
    const poLine = await poLineOf();
    await h.owner.query(`INSERT INTO invoice_allocations (tenant_id, company_id, invoice_id, line_no, po_line_id, contract_version_id, quantity, amount, created_by)
      SELECT tenant_id, company_id, id, 1, $2, NULL, 1, 100, created_by FROM invoices WHERE id = $1`, [invoiceId, poLine]);
    const detail = await call('finance2', 'GET', `/api/v1/invoices/${invoiceId}`);
    expect(detail.body.check.issues.map((x: { code: string }) => x.code)).toContain('SUPPLIER_MISMATCH');
    expect(detail.body.check.canApprove).toBe(false);
    expect((await approve(invoiceId)).status).not.toBe(200);
  });

  it('birleştirilen adayın faturası hedef firmanın siparişine bağlanabilir ama aktif olmadığı için onaya kapalı kalır', async () => {
    const candidateId = await sameNameCandidate('Birleşecek Aday 2 (SENTETİK)');
    const invoiceId = await invoiceFor(candidateId);
    const before = await call('masterData', 'GET', `/api/v1/suppliers/${candidateId}`);
    expect((await call('masterData', 'POST', `/api/v1/suppliers/${candidateId}/identity`,
      { country: 'TR', taxIdType: 'VKN', taxId: sellerVkn, rationale: 'Kaynak belgede VKN doğrulandı (sentetik)', expectedRowVersion: before.body.rowVersion })).status).toBe(200);
    expect((await allocate(invoiceId, await poLineOf())).status).toBe(200);
    const codes = await issueCodes(invoiceId);
    expect(codes).not.toContain('SUPPLIER_MISMATCH');
    expect(codes).toContain('SUPPLIER_NOT_ACTIVE');
  });

  const insertForeignAllocation = (invoiceId: string, poLine: string) => h.owner.query(`INSERT INTO invoice_allocations (tenant_id, company_id, invoice_id, line_no, po_line_id, contract_version_id, quantity, amount, created_by)
    SELECT tenant_id, company_id, id, 1, $2, NULL, 1, 100, created_by FROM invoices WHERE id = $1`, [invoiceId, poLine]);

  it('yanlış bağ kaldırılabilir: boş tahsis kaydedilir, tedarikçi uyuşmazlığı biter', async () => {
    const invoiceId = await invoiceFor(h.world.suppliers.s2);
    await insertForeignAllocation(invoiceId, await poLineOf());
    expect(await issueCodes(invoiceId)).toContain('SUPPLIER_MISMATCH');
    expect((await call('finance', 'PUT', `/api/v1/invoices/${invoiceId}/allocations`, { allocations: [] })).status).toBe(200);
    expect(await issueCodes(invoiceId)).not.toContain('SUPPLIER_MISMATCH');
  });

  it('sözleşmeye doğrudan tahsis: yabancı tedarikçi reddedilir; SUPPLIER tarafı olarak eklenen tedarikçi kabul edilir', async () => {
    const cv = await contract('50000.00');
    const invoiceId = await invoiceFor(h.world.suppliers.s2);
    const toContract = () => call('finance', 'PUT', `/api/v1/invoices/${invoiceId}/allocations`, { allocations: [{ lineNo: 1, poLineId: null, contractVersionId: cv, quantity: '1', amount: '100.00' }] });
    expect((await toContract()).body.error?.code).toBe('allocation_supplier_mismatch');
    await h.owner.query(`INSERT INTO contract_parties (tenant_id, company_id, contract_version_id, party_role, supplier_id, display_name)
      SELECT tenant_id, company_id, id, 'SUPPLIER', $2, 'İkinci tedarikçi (sentetik)' FROM contract_versions WHERE id = $1`, [cv, h.world.suppliers.s2]);
    expect((await toContract()).status).toBe(200);
  });

  it('iade belgesi onaylı özgün faturanın sonradan yabancılaşan siparişine dönebilir; başka yabancı siparişe dönemez', async () => {
    // v2: sipariş, kabul ve onay test verisi (eski v1 kayıtları); iade tahsis kontrolü korunur.
    const poId = await legacyPo(null, '1', '100');
    const line = await legacyPoLine(poId);
    await legacyReceive(line, '1');
    const original = await invoiceFor(h.world.suppliers.s1);
    expect((await allocate(original, line)).status).toBe(200);
    await legacyApprove(original);
    const otherPo = await legacyPo(null, '1', '100');
    const otherLine = await legacyPoLine(otherPo);
    await h.owner.query(`UPDATE purchase_orders SET supplier_id = $2 WHERE id = ANY($1::uuid[])`, [[poId, otherPo], h.world.suppliers.s2]);

    const credit = await invoiceFor(h.world.suppliers.s1, { kind: 'CREDIT_NOTE', originalInvoiceId: original });
    expect((await allocate(credit, line)).status).toBe(200);
    expect(await issueCodes(credit)).not.toContain('SUPPLIER_MISMATCH');
    expect((await allocate(credit, otherLine)).body.error?.code).toBe('allocation_supplier_mismatch');
  });
});

describe('sipariş açma: sözleşme siparişin tedarikçisine ait olmalı (D85)', () => {
  const create = (supplierId: string, contractVersionId: string) => call('buyer', 'POST', '/api/v1/purchase-orders', { companyId: h.world.companyA1.id, supplierId, contractVersionId, currency: 'TRY',
    lines: [{ kind: 'GOODS', description: 'Yedek parça (sentetik)', unit: 'adet', quantity: '1', unitPrice: '100' }] });
  const poCount = async (cv: string) => Number((await h.owner.query<{ n: string }>(`SELECT count(*) AS n FROM purchase_orders WHERE contract_version_id = $1`, [cv])).rows[0]!.n);

  // v2 Faz 1 (D93): işlev onaylı kaldırma listesinde; davranış removed-v1.test.ts ile 403 olarak korunur
  it.skip('başka tedarikçinin sözleşmesine sipariş açılamaz ve kayıt oluşmaz; kendi tedarikçisi açabilir', async () => {
    const cv = await contract('50000.00');
    const r = await create(h.world.suppliers.s2, cv);
    expect(r.status).toBe(422);
    expect(r.body.error.code).toBe('contract_supplier_mismatch');
    expect(await poCount(cv)).toBe(0);
    expect((await create(h.world.suppliers.s1, cv)).status).toBe(201);
  });

  // v2 Faz 1 (D93): işlev onaylı kaldırma listesinde; davranış removed-v1.test.ts ile 403 olarak korunur
  it.skip('sözleşmeye SUPPLIER tarafı olarak eklenen tedarikçi sipariş açabilir', async () => {
    const cv = await contract('50000.00');
    await h.owner.query(`INSERT INTO contract_parties (tenant_id, company_id, contract_version_id, party_role, supplier_id, display_name)
      SELECT tenant_id, company_id, id, 'SUPPLIER', $2, 'İkinci tedarikçi (sentetik)' FROM contract_versions WHERE id = $1`, [cv, h.world.suppliers.s2]);
    expect((await create(h.world.suppliers.s2, cv)).status).toBe(201);
  });

  // v2 Faz 1 (D93): işlev onaylı kaldırma listesinde; davranış removed-v1.test.ts ile 403 olarak korunur
  it.skip('tedarikçisi kayıtlı olmayan sözleşmeye sipariş açılabilir; sözleşme listesi tedarikçi köklerini döner', async () => {
    const cv = await contract('50000.00');
    const listed = async () => ((await call('buyer', 'GET', '/api/v1/contract-options')).body.items as { id: string; supplierRootIds: string[] }[]).find((x) => x.id === cv)!;
    expect((await listed()).supplierRootIds).toEqual([h.world.suppliers.s1]);
    await h.owner.query(`UPDATE contract_families SET supplier_id = NULL WHERE id = (SELECT family_id FROM contract_versions WHERE id = $1)`, [cv]);
    expect((await listed()).supplierRootIds).toEqual([]);
    expect((await create(h.world.suppliers.s2, cv)).status).toBe(201);
  });
});

describe('sipariş açma: sözleşme siparişin şirketine ait olmalı (D86)', () => {
  it('iki şirkete erişen kullanıcı başka şirketin sözleşmesine sipariş açamaz; aynı şirkette açabilir', async () => {
    const cv = await contract('50000.00');
    const ctx = { tenantId: h.world.tenantA, userId: h.world.users.buyer.id, roles: ['BUYER'], companyIds: [h.world.companyA1.id, h.world.companyA2.id], departmentIds: [], allDepartments: true, correlationId: 'd86' };
    const open = (companyId: string) => withTenant(h.pool, ctx as never, (tx) => createPo(tx, ctx as never, { companyId, supplierId: h.world.suppliers.s1, contractVersionId: cv, currency: 'TRY',
      lines: [{ kind: 'GOODS', description: 'Yedek parça (sentetik)', unit: 'adet', quantity: '1', unitPrice: '100' }] } as never));
    await expect(open(h.world.companyA2.id)).rejects.toMatchObject({ code: 'contract_company_mismatch' });
    expect(Number((await h.owner.query<{ n: string }>(`SELECT count(*) AS n FROM purchase_orders WHERE contract_version_id = $1`, [cv])).rows[0]!.n)).toBe(0);
    await expect(open(h.world.companyA1.id)).resolves.toMatchObject({ code: expect.any(String) });
  });
});

describe('fatura tahsisi: sipariş ve sözleşme faturanın şirketine ait olmalı (D87)', () => {
  const both = () => ({ tenantId: h.world.tenantA, userId: h.world.users.finance.id, roles: ['FINANCE', 'BUYER'], companyIds: [h.world.companyA1.id, h.world.companyA2.id], departmentIds: [], allDepartments: true, correlationId: 'd87' });
  const invoice = async () => {
    const r = await call('finance', 'POST', '/api/v1/invoices', { companyId: h.world.companyA1.id, supplierId: h.world.suppliers.s1, kind: 'INVOICE', invoiceNo: `D87${randomUUID().slice(0, 8)}`,
      issueDate: '2026-10-20', currency: 'TRY', lines: [{ description: 'Yedek parça', quantity: '1', unit: 'adet', unitPrice: '100', netAmount: '100.00' }] });
    expect(r.status).toBe(201);
    return r.body.id as string;
  };
  const a2PoLine = async () => {
    const ctx = both();
    const created = await withTenant(h.pool, ctx as never, (tx) => createPo(tx, ctx as never, { companyId: h.world.companyA2.id, supplierId: h.world.suppliers.s1, contractVersionId: null, currency: 'TRY',
      lines: [{ kind: 'GOODS', description: 'Yedek parça (sentetik)', unit: 'adet', quantity: '1', unitPrice: '100' }] } as never));
    return (await h.owner.query<{ id: string }>(`SELECT id FROM po_lines WHERE po_id = $1`, [created.id])).rows[0]!.id;
  };
  const body = (poLineId: string | null, contractVersionId: string | null = null) => ({ allocations: [{ lineNo: 1, poLineId, contractVersionId, quantity: '1', amount: '100.00' }] });

  it('iki şirkete erişen kullanıcı başka şirketin siparişine bağlayamaz; önceki tahsis kalır', async () => {
    const invoiceId = await invoice();
    const line = await a2PoLine();
    const ctx = both();
    await expect(withTenant(h.pool, ctx as never, (tx) => setAllocations(tx, ctx as never, invoiceId, body(line) as never))).rejects.toMatchObject({ code: 'allocation_company_mismatch' });
    expect((await call('finance', 'GET', `/api/v1/invoices/${invoiceId}`)).body.allocations).toEqual([]);
  });

  it('tek şirketli kullanıcı gizli siparişin kimliğini göndererek kontrolü atlayamaz', async () => {
    const r = await call('finance', 'PUT', `/api/v1/invoices/${await invoice()}/allocations`, body(await a2PoLine()));
    expect(r.status).toBe(422);
    expect(r.body.error.code).toBe('allocation_company_mismatch');
  });

  it('başka şirketin sözleşmesine doğrudan tahsis reddedilir', async () => {
    const cv = await contract('50000.00');
    await h.owner.query(`UPDATE contract_versions SET company_id = $2 WHERE id = $1`, [cv, h.world.companyA2.id]);
    const r = await call('finance', 'PUT', `/api/v1/invoices/${await invoice()}/allocations`, body(null, cv));
    expect(r.body.error?.code).toBe('allocation_company_mismatch');
  });

  // v2 Faz 1 (D93): işlev onaylı kaldırma listesinde; davranış removed-v1.test.ts ile 403 olarak korunur
  it.skip('önceden yanlış bağlanmış fatura onaya kapanır ve bağ kaldırılabilir; liste şirketi döner', async () => {
    const invoiceId = await invoice();
    await h.owner.query(`INSERT INTO invoice_allocations (tenant_id, company_id, invoice_id, line_no, po_line_id, contract_version_id, quantity, amount, created_by)
      SELECT tenant_id, company_id, id, 1, $2, NULL, 1, 100, created_by FROM invoices WHERE id = $1`, [invoiceId, await a2PoLine()]);
    const d = await call('finance2', 'GET', `/api/v1/invoices/${invoiceId}`);
    expect(d.body.check.issues.map((x: { code: string }) => x.code)).toContain('COMPANY_MISMATCH');
    expect(d.body.check.canApprove).toBe(false);
    expect((await call('finance', 'PUT', `/api/v1/invoices/${invoiceId}/allocations`, { allocations: [] })).status).toBe(200);
    expect(await issueCodes(invoiceId)).not.toContain('COMPANY_MISMATCH');
    const pos = (await call('finance', 'GET', '/api/v1/purchase-orders')).body.items as { companyId: string }[];
    expect(pos.every((x) => x.companyId)).toBe(true);
  });

  it('iade belgesi başka şirketin faturasına bağlanamaz', async () => {
    const original = await invoice();
    const ctx = both();
    await expect(withTenant(h.pool, ctx as never, (tx) => createInvoice(tx, ctx as never, { companyId: h.world.companyA2.id, supplierId: h.world.suppliers.s1, kind: 'CREDIT_NOTE', originalInvoiceId: original, invoiceNo: `D87C${randomUUID().slice(0, 8)}`,
      issueDate: '2026-10-20', currency: 'TRY', lines: [{ description: 'Yedek parça', quantity: '1', unit: 'adet', unitPrice: '100', netAmount: '100.00' }] } as never))).rejects.toMatchObject({ code: 'original_required' });
  });

  it('iade istisnası yalnız aynı şirketin onaylı özgün faturası için geçerlidir', async () => {
    // v2: sipariş, kabul ve onay test verisi (eski v1 kayıtları); şirket kontrolü korunur.
    const poId = await legacyPo(null, '1', '100');
    const line = await legacyPoLine(poId);
    await legacyReceive(line, '1');
    const original = await invoice();
    expect((await call('finance', 'PUT', `/api/v1/invoices/${original}/allocations`, body(line))).status).toBe(200);
    await legacyApprove(original);
    await h.owner.query(`UPDATE purchase_orders SET company_id = $2 WHERE id = $1`, [poId, h.world.companyA2.id]);

    const credit = await call('finance', 'POST', '/api/v1/invoices', { companyId: h.world.companyA1.id, supplierId: h.world.suppliers.s1, kind: 'CREDIT_NOTE', originalInvoiceId: original, invoiceNo: `D87K${randomUUID().slice(0, 8)}`,
      issueDate: '2026-10-21', currency: 'TRY', lines: [{ description: 'Yedek parça', quantity: '1', unit: 'adet', unitPrice: '100', netAmount: '100.00' }] });
    expect(credit.status).toBe(201);
    expect((await call('finance', 'PUT', `/api/v1/invoices/${credit.body.id}/allocations`, body(line))).status).toBe(200);
    expect(await issueCodes(credit.body.id)).not.toContain('COMPANY_MISMATCH');

    await h.owner.query(`UPDATE invoices SET company_id = $2 WHERE id = $1`, [original, h.world.companyA2.id]);
    expect(await issueCodes(credit.body.id)).toContain('COMPANY_MISMATCH');
  });
});

describe('sipariş formu sözleşme seçenekleri (D88)', () => {
  it('güncel sözleşmeleri ad, şirket ve tedarikçi kökleriyle döner; yalnız sözleşme okuma yetkisiyle', async () => {
    const cv = await contract('50000.00');
    const r = await call('buyer', 'GET', '/api/v1/contract-options');
    expect(r.status).toBe(200);
    expect(r.body.truncated).toBe(false);
    expect((r.body.items as { id: string }[]).find((x) => x.id === cv)).toMatchObject({ companyId: h.world.companyA1.id, supplierRootIds: [h.world.suppliers.s1], title: expect.any(String) });
    expect(Object.keys(r.body.items[0]).sort()).toEqual(['companyId', 'id', 'supplierRootIds', 'title']);
  });

  it('sınır aşılınca listeyi kısaltır ve bunu bildirir', async () => {
    await contract('50000.00'); await contract('50000.00');
    const ctx = { tenantId: h.world.tenantA, userId: h.world.users.buyer.id, roles: ['BUYER'], companyIds: [h.world.companyA1.id], departmentIds: [], allDepartments: true, correlationId: 'd88' };
    const r = await withTenant(h.pool, ctx as never, (tx) => contractOptions(tx, 1));
    expect(r.items).toHaveLength(1);
    expect(r.truncated).toBe(true);
  });
});

describe('sözleşme listesi sayfalama (D89)', () => {
  it('varsayılan ilk sayfa ve toplam döner; sayfalar çakışmaz, en yeni önce gelir', async () => {
    const newest: string[] = [];
    for (let i = 0; i < 3; i++) newest.unshift(await contract('50000.00'));
    const first = await call('buyer', 'GET', '/api/v1/contracts?limit=2');
    expect(first.status).toBe(200);
    expect(first.body.items.map((x: { id: string }) => x.id)).toEqual(newest.slice(0, 2));
    expect(first.body.total).toBeGreaterThanOrEqual(3);
    const second = await call('buyer', 'GET', '/api/v1/contracts?limit=2&offset=2');
    expect(second.body.items[0].id).toBe(newest[2]);
    expect(second.body.total).toBe(first.body.total);
    const all = await call('buyer', 'GET', '/api/v1/contracts');
    expect(all.body.items.length).toBe(Math.min(all.body.total, 100));
    expect(all.body.items[0].signature).toBeDefined();
  });

  it('sınır dışı sayfa boyutu reddedilir', async () => {
    expect((await call('buyer', 'GET', '/api/v1/contracts?limit=101')).status).toBe(400);
    expect((await call('buyer', 'GET', '/api/v1/contracts?offset=-1')).status).toBe(400);
  });
});

describe('fatura listesinde engel ve yetki metni (D90)', () => {
  it('engelli karar bekleyen fatura işaretlenir; hazır fatura işaretlenmez', async () => {
    // v2: sipariş ve kabul test verisi (eski v1 kayıtları); engel işareti korunur.
    const poId = await legacyPo(null, '1', '100');
    const line = await legacyPoLine(poId);
    await legacyReceive(line, '1');
    const make = async () => (await call('finance', 'POST', '/api/v1/invoices', { companyId: h.world.companyA1.id, supplierId: h.world.suppliers.s1, kind: 'INVOICE', invoiceNo: `D90${randomUUID().slice(0, 8)}`,
      issueDate: '2026-10-20', currency: 'TRY', lines: [{ description: 'Yedek parça', quantity: '1', unit: 'adet', unitPrice: '100', netAmount: '100.00' }] })).body.id as string;
    const ready = await make(); const unallocated = await make();
    await call('finance', 'PUT', `/api/v1/invoices/${ready}/allocations`, { allocations: [{ lineNo: 1, poLineId: line, contractVersionId: null, quantity: '1', amount: '100.00' }] });
    const row = async (id: string) => ((await call('finance', 'GET', '/api/v1/invoices')).body.items as { id: string; blocked: boolean }[]).find((x) => x.id === id)!;
    expect((await row(unallocated)).blocked).toBe(true);
    expect((await call('finance', 'GET', `/api/v1/invoices/${ready}`)).body.check.canApprove).toBe(true);
    expect((await row(ready)).blocked).toBe(false);
  });

  it('yetki hatası ham izin kodu göstermez', async () => {
    const r = await call('masterData', 'GET', '/api/v1/purchase-orders');
    expect(r.status).toBe(403);
    expect(r.body.error.code).toBe('forbidden');
    expect(r.body.error.message).not.toContain('po.read');
  });
});

describe('zeyilnameyle tedarikçi tarafı ekleme (D91)', () => {
  const amend = async (cv: string, extra: Record<string, unknown>, kind = 'AMENDMENT') => {
    const up = await h.upload('legal', { name: 'z.pdf', mime: 'application/pdf', data: syntheticPdf([[`ZEYIL ${randomUUID()}`]]) }, { companyId: h.world.companyA1.id, kind: 'CONTRACT', title: 'Zeyilname (SENTETİK)' });
    const old = await h.call('legal', 'GET', `/api/v1/contract-versions/${cv}/signature-status`);
    return h.call('legal', 'POST', `/api/v1/contract-versions/${cv}/versions`, { headers: { 'if-match': old.headers.etag as string }, body: { documentVersionId: up.body.documentVersionId, kind, stage: 'EXECUTION', ...extra } });
  };
  // v2 Faz 1 (D93): işlev onaylı kaldırma listesinde; davranış removed-v1.test.ts ile 403 olarak korunur
  it.skip('zeyilnameyle eklenen tedarikçi yeni sürüme sipariş açabilir; önceki sürüm değişmez; denetim izi kalır', async () => {
    const cv = await contract('50000.00');
    const r = await amend(cv, { addSupplierId: h.world.suppliers.s2 });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    const newId = r.body.contractVersionId as string;
    const parties = async (id: string) => (await h.owner.query<{ supplier_id: string }>(`SELECT supplier_id FROM contract_parties WHERE contract_version_id = $1 AND party_role = 'SUPPLIER'`, [id])).rows.map((x) => x.supplier_id);
    expect(await parties(newId)).toContain(h.world.suppliers.s2);
    expect(await parties(cv)).not.toContain(h.world.suppliers.s2);
    expect((await h.owner.query(`SELECT 1 FROM audit_events WHERE action = 'contract.supplier_party.added' AND entity_id = $1`, [newId])).rowCount).toBe(1);
    const po2 = await call('buyer', 'POST', '/api/v1/purchase-orders', { companyId: h.world.companyA1.id, supplierId: h.world.suppliers.s2, contractVersionId: newId, currency: 'TRY', lines: [{ kind: 'GOODS', description: 'Parça (sentetik)', unit: 'adet', quantity: '1', unitPrice: '100', taxRate: '20' }] });
    expect(po2.status, JSON.stringify(po2.body)).toBe(201);
  });
  it('zeyilname dışında taraf eklenemez; zaten taraf olan tekrar eklenemez', async () => {
    const cv = await contract('50000.00');
    expect((await amend(cv, { addSupplierId: h.world.suppliers.s2 }, 'ANNEX')).body.error.code).toBe('party_change_requires_amendment');
    const cv2 = await contract('50000.00');
    await h.owner.query(`INSERT INTO contract_parties (tenant_id, company_id, contract_version_id, party_role, supplier_id, display_name)
      SELECT tenant_id, company_id, id, 'SUPPLIER', $2, 'İkinci (sentetik)' FROM contract_versions WHERE id = $1`, [cv2, h.world.suppliers.s2]);
    expect((await amend(cv2, { addSupplierId: h.world.suppliers.s2 })).body.error.code).toBe('party_exists');
  });

  it('imza gerektiren sözleşmede eklenen taraf için zorunlu gereksinim açılır; imzalamadan tamamlanmaz', async () => {
    const cv = await contract('50000.00');
    await h.owner.query(`UPDATE contract_versions SET signature_method = 'WET_IMAGE_REVIEW' WHERE id = $1`, [cv]);
    const r = await amend(cv, { addSupplierId: h.world.suppliers.s2 });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    const newId = r.body.contractVersionId as string;
    const req = (await h.owner.query<{ required: boolean; acceptable_methods: string[] }>(`SELECT r.required, r.acceptable_methods FROM signature_requirements r JOIN contract_parties p ON p.id = r.party_id
      WHERE r.contract_version_id = $1 AND p.supplier_id = $2`, [newId, h.world.suppliers.s2])).rows;
    expect(req).toHaveLength(1);
    expect(req[0]).toMatchObject({ required: true, acceptable_methods: ['WET_IMAGE_REVIEW'] });
    expect((await h.call('legal', 'GET', `/api/v1/contract-versions/${newId}/signature-status`)).body.status.overall).not.toBe('COMPLETE');
  });
});

describe('avans mahsubu şirket sınırı (D87)', () => {
  it('başka şirketin avansına bağlı fatura yazılamaz; erişilemeyen avansla kalmış eski kayıt listeyi düşürmez', async () => {
    const inv = await call('finance', 'POST', '/api/v1/invoices', { companyId: h.world.companyA1.id, supplierId: h.world.suppliers.s1, kind: 'INVOICE', invoiceNo: `D87A${randomUUID().slice(0, 8)}`,
      issueDate: '2026-10-20', currency: 'TRY', lines: [{ description: 'Yedek parça', quantity: '1', unit: 'adet', unitPrice: '100', netAmount: '100.00' }] });
    expect(inv.status).toBe(201);
    const adv = await call('finance', 'POST', '/api/v1/invoices', { companyId: h.world.companyA1.id, supplierId: h.world.suppliers.s1, kind: 'ADVANCE', invoiceNo: `D87B${randomUUID().slice(0, 8)}`,
      issueDate: '2026-10-19', currency: 'TRY', lines: [{ description: 'Avans', quantity: '1', unit: 'adet', unitPrice: '100', netAmount: '100.00' }] });
    expect(adv.status).toBe(201);
    await h.owner.query(`UPDATE invoices SET company_id = $2 WHERE id = $1`, [adv.body.id, h.world.companyA2.id]);
    await h.owner.query(`UPDATE invoices SET advance_invoice_id = $2 WHERE id = $1`, [inv.body.id, adv.body.id]);
    const list = await call('finance', 'GET', '/api/v1/invoices');
    expect(list.status).toBe(200);
    expect((await call('finance', 'GET', `/api/v1/invoices/${inv.body.id}`)).status).toBe(200);
  });
});

// Görev 4 ayrımı: atlanan testlerin korunan kısımları (sipariş açma/kabul/onay uçları olmadan; eski sipariş test verisi modül işleviyle).
describe('v2: atlanan testlerin korunan kısımları', () => {
  const invoiceFor = async (supplierId: string, companyId = h.world.companyA1.id) => {
    const r = await call('finance', 'POST', '/api/v1/invoices', { companyId, supplierId, kind: 'INVOICE', invoiceNo: `V2K${randomUUID().slice(0, 8)}`,
      issueDate: '2026-10-20', currency: 'TRY', lines: [{ description: 'Yedek parça', quantity: '1', unit: 'adet', unitPrice: '100', netAmount: '100.00' }] });
    expect(r.status).toBe(201);
    return r.body.id as string;
  };
  const allocateTo = (invoiceId: string, a: { poLineId?: string | null; contractVersionId?: string | null }) => call('finance', 'PUT', `/api/v1/invoices/${invoiceId}/allocations`,
    { allocations: [{ lineNo: 1, poLineId: a.poLineId ?? null, contractVersionId: a.contractVersionId ?? null, quantity: '1', amount: '100.00' }] });

  it('olay bildirimi: aynı Idempotency-Key tek kayıt; farklı içerikle aynı anahtar 409', async () => {
    const ikey = `inc-${randomUUID()}`;
    const inc = () => h.call('buyer', 'POST', '/api/v1/incidents', { body: { supplierId: h.world.suppliers.s1, category: 'DELAY', severity: 'LOW', title: 'Mobil olay bildirimi',
      description: 'Bağlantı koptu, tekrar gönderildi (sentetik).', occurredOn: '2026-10-20' }, headers: { 'idempotency-key': ikey } });
    const i1 = await inc(); const i2 = await inc();
    expect(i2.body).toMatchObject({ id: i1.body.id, code: i1.body.code, duplicate: true });
    const i3 = await h.call('buyer', 'POST', '/api/v1/incidents', { body: { supplierId: h.world.suppliers.s1, category: 'DELAY', severity: 'HIGH', title: 'Mobil olay bildirimi',
      description: 'Bağlantı koptu, tekrar gönderildi (sentetik).', occurredOn: '2026-10-20' }, headers: { 'idempotency-key': ikey } });
    expect(i3.status).toBe(409);
    expect(i3.body.error.code).toBe('idempotency_mismatch');
  });

  it('eski siparişin kendi tedarikçisine tahsis çalışır; fatura detayı tedarikçi kökünü döner (D84)', async () => {
    const invoiceId = await invoiceFor(h.world.suppliers.s1);
    expect((await allocateTo(invoiceId, { poLineId: await legacyPoLine(await legacyPo(null, '1', '100')) })).status).toBe(200);
    expect(await issueCodes(invoiceId)).not.toContain('SUPPLIER_MISMATCH');
    expect((await call('finance', 'GET', `/api/v1/invoices/${invoiceId}`)).body.invoice.supplierRootId).toBe(h.world.suppliers.s1);
  });

  it('sözleşme seçenekleri tedarikçi köklerini döner; aile tedarikçisi kalkınca boş (D85)', async () => {
    const cv = await contract('50000.00');
    const listed = async () => ((await call('buyer', 'GET', '/api/v1/contract-options')).body.items as { id: string; supplierRootIds: string[] }[]).find((x) => x.id === cv)!;
    expect((await listed()).supplierRootIds).toEqual([h.world.suppliers.s1]);
    await h.owner.query(`UPDATE contract_families SET supplier_id = NULL WHERE id = (SELECT family_id FROM contract_versions WHERE id = $1)`, [cv]);
    expect((await listed()).supplierRootIds).toEqual([]);
  });

  it('başka şirketin eski siparişine yanlış bağlanmış fatura onaya kapanır ve bağ kaldırılabilir (D87)', async () => {
    const ctx = { ...legacyCtx(h.world.users.finance.id), companyIds: [h.world.companyA1.id, h.world.companyA2.id] };
    const created = await withTenant(h.pool, ctx, (tx) => createPo(tx, ctx, { companyId: h.world.companyA2.id, supplierId: h.world.suppliers.s1, contractVersionId: null, currency: 'TRY',
      lines: [{ kind: 'GOODS', description: 'Yedek parça (sentetik)', unit: 'adet', quantity: '1', unitPrice: '100' }] } as never));
    const invoiceId = await invoiceFor(h.world.suppliers.s1);
    await h.owner.query(`INSERT INTO invoice_allocations (tenant_id, company_id, invoice_id, line_no, po_line_id, contract_version_id, quantity, amount, created_by)
      SELECT tenant_id, company_id, id, 1, $2, NULL, 1, 100, created_by FROM invoices WHERE id = $1`, [invoiceId, await legacyPoLine(created.id)]);
    const d = await call('finance2', 'GET', `/api/v1/invoices/${invoiceId}`);
    expect(d.body.check.issues.map((x: { code: string }) => x.code)).toContain('COMPANY_MISMATCH');
    expect(d.body.check.canApprove).toBe(false);
    expect((await call('finance', 'PUT', `/api/v1/invoices/${invoiceId}/allocations`, { allocations: [] })).status).toBe(200);
    expect(await issueCodes(invoiceId)).not.toContain('COMPANY_MISMATCH');
  });

  it('zeyilnameyle eklenen tedarikçi yeni sürümün tarafı olur (fatura tahsisi kabul edilir); önceki sürüm değişmez; denetim izi kalır (D91)', async () => {
    const cv = await contract('50000.00');
    const up = await h.upload('legal', { name: 'z.pdf', mime: 'application/pdf', data: syntheticPdf([[`ZEYIL ${randomUUID()}`]]) }, { companyId: h.world.companyA1.id, kind: 'CONTRACT', title: 'Zeyilname (SENTETİK)' });
    const old = await h.call('legal', 'GET', `/api/v1/contract-versions/${cv}/signature-status`);
    const r = await h.call('legal', 'POST', `/api/v1/contract-versions/${cv}/versions`, { headers: { 'if-match': old.headers.etag as string },
      body: { documentVersionId: up.body.documentVersionId, kind: 'AMENDMENT', stage: 'EXECUTION', addSupplierId: h.world.suppliers.s2 } });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    const newId = r.body.contractVersionId as string;
    const parties = async (id: string) => (await h.owner.query<{ supplier_id: string }>(`SELECT supplier_id FROM contract_parties WHERE contract_version_id = $1 AND party_role = 'SUPPLIER'`, [id])).rows.map((x) => x.supplier_id);
    expect(await parties(newId)).toContain(h.world.suppliers.s2);
    expect(await parties(cv)).not.toContain(h.world.suppliers.s2);
    expect((await h.owner.query(`SELECT 1 FROM audit_events WHERE action = 'contract.supplier_party.added' AND entity_id = $1`, [newId])).rowCount).toBe(1);
    const inv = await invoiceFor(h.world.suppliers.s2);
    expect((await allocateTo(inv, { contractVersionId: cv })).body.error?.code).toBe('allocation_supplier_mismatch');
    expect((await allocateTo(inv, { contractVersionId: newId })).status).toBe(200);
  });
});
