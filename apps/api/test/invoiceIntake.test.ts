import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { syntheticPdf, ublInvoiceXml } from '../src/devdata.ts';
import { makeHarness } from './harness.ts';
import { withTenant } from '../src/db.ts';

// Faz 4 açıkları: e-Fatura XML → fatura, vergi aritmetiği, sipariş değişikliği/kapatma/iptal, tolerans kuralı. Gerçek PostgreSQL + RLS; veri sentetik.
let h: Awaited<ReturnType<typeof makeHarness>>;
let sellerVkn: string;
beforeAll(async () => {
  h = await makeHarness();
  sellerVkn = (await h.owner.query<{ tax_id: string }>(`SELECT tax_id FROM suppliers WHERE id = $1`, [h.world.suppliers.s1])).rows[0]!.tax_id;
});
afterAll(async () => { await h.close(); });

type Who = 'buyer' | 'finance' | 'finance2' | 'legal' | 'legal2';
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
    await expect(withTenant(h.pool, { tenantId: h.world.tenantA, userId: h.world.users.finance.id, roles: [], companyIds: [h.world.companyA1.id], correlationId: 'd81' },
      (tx) => tx.query(`UPDATE einvoice_checks SET error_count = 0 WHERE document_version_id = $1`, [up.body.documentVersionId]))).rejects.toThrow(/permission denied/);
    // Şirket kapsamı dışındaki kullanıcı kaydı göremez (RLS).
    const other = await withTenant(h.pool, { tenantId: h.world.tenantA, userId: h.world.users.finance.id, roles: [], companyIds: [h.world.companyA2.id], correlationId: 'd81' },
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

describe('sipariş değişikliği', () => {
  it('miktar artışı limit kilidiyle kontrol edilir; özgün kalem korunur, revizyon ve fark görünür', async () => {
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

  it('kabul edilen miktarın altına inemez; faturalanmış kalemin fiyatı değişmez; gerekçe zorunlu; yalnız satınalma', async () => {
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
  it('tüketim varsa kapatılır: kalan taahhüt serbest kalır, yeni kabul yapılamaz', async () => {
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

  it('hiç tüketim yoksa iptal edilir: taahhüt sıfır, iptal edilmiş siparişe fatura bağlanamaz', async () => {
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
  it('finans kural koyar, listeler ve kaldırır; satınalma koyamaz; geçersiz yüzde reddedilir', async () => {
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

  it('karar bekleyen faturası olan sipariş kapatılamaz (taahhüt erken serbest kalmaz)', async () => {
    const id = await po(null, '10', '100');
    const line = (await getPo(id)).lines[0].poLineId;
    const inv = await call('finance', 'POST', '/api/v1/invoices', { companyId: h.world.companyA1.id, supplierId: h.world.suppliers.s1, kind: 'INVOICE', invoiceNo: `PD${randomUUID().slice(0, 8)}`,
      issueDate: '2026-10-20', currency: 'TRY', lines: [{ description: 'Yedek parça', quantity: '3', unit: 'adet', unitPrice: '100', netAmount: '300.00' }] });
    await call('finance', 'PUT', `/api/v1/invoices/${inv.body.id}/allocations`, { allocations: [{ lineNo: 1, poLineId: line, contractVersionId: null, quantity: '3', amount: '300.00' }] });
    const r = await call('buyer', 'POST', `/api/v1/purchase-orders/${id}/close`, { baseChangeNo: 0, reason: 'Kalan artık gerekmiyor (sentetik)' });
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe('pending_invoices');
  });

  it('istisna onayından sonra sipariş fiyatı değişirse istisna eskir; eski onayla finans onayı verilemez', async () => {
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

  it('eşzamanlı kabul ve kapatma: kabul hiçbir durumda sipariş miktarını aşmaz', async () => {
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
  it('If-Match yoksa 428; inceleme sonrası tahsis değiştiyse eski parmak iziyle onay 409', async () => {
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
  it('aynı Idempotency-Key ile kabul ve olay tek kayıt; anahtar başka kalemde kullanılırsa 409', async () => {
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
