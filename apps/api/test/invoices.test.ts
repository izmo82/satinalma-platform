// v2 Faz 1 (D93/D95): sipariş, mal kabul, fatura onayı/istisnası ve tolerans kaldırıldı (testler atlandı); korunan ERP, arşiv sözleşmesi ve toplu kontrol ayrı testlerde
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { syntheticPdf } from '../src/devdata.ts';
import { processJobs } from '../src/worker.ts';
import { withTenant, type TenantContext } from '../src/db.ts';
import { approveInvoice, createPo, recordReceipt } from '../src/modules/invoices.ts';
import { fakeErp, makeHarness } from './harness.ts';

// Faz 4 kabul testleri (T13–T18, T37) gerçek PostgreSQL + RLS üzerinde. Tüm veri sentetik; ERP bağdaştırıcısı yalnız testte.
let h: Awaited<ReturnType<typeof makeHarness>>;
beforeAll(async () => { h = await makeHarness(); });
afterAll(async () => { await h.close(); });

type Who = 'buyer' | 'finance' | 'finance2' | 'legal' | 'legal2';
const call = (who: Who, method: string, url: string, body?: unknown) => h.call(who, method, url, body === undefined ? {} : { body });

async function contract(ceiling: string | null, opts: { stage?: string; method?: string; limitBasis?: 'NET' | 'GROSS' } = {}) {
  const up = await h.upload('legal', { name: 's.pdf', mime: 'application/pdf', data: syntheticPdf([[`SENTETIK ${randomUUID()}`]]) },
    { companyId: h.world.companyA1.id, kind: 'CONTRACT', title: 'Tedarik Sözleşmesi (SENTETİK)' });
  const c = await call('legal', 'POST', '/api/v1/contracts', { title: `Tedarik ${randomUUID().slice(0, 4)} (SENTETİK)`, documentVersionId: up.body.documentVersionId,
    stage: opts.stage ?? 'EXECUTION', signatureMethod: opts.method ?? 'NOT_REQUIRED', originalCustodyRequired: false,
    parties: [{ role: 'BUYER', displayName: h.world.companyA1.name, legalEntityId: h.world.companyA1.id }], supplierId: h.world.suppliers.s1 });
  const cv = c.body.contractVersionId as string;
  if (ceiling) {
    const t = await call('legal', 'POST', `/api/v1/contract-versions/${cv}/terms`, { currency: 'TRY', valueType: 'CEILING', amount: ceiling, paymentTerms: '30 gün',
      startDate: '2026-01-01', endDate: '2027-12-31', autoRenewal: false, renewalMonths: null, noticeAmount: null, noticeUnit: null, nonWorkingDay: 'AS_IS', sourceRef: 'Madde 5 (sentetik)', ...(opts.limitBasis ? { limitBasis: opts.limitBasis } : {}) });
    expect((await call('legal2', 'POST', `/api/v1/contract-terms/${t.body.id}/verify`)).status).toBe(200);
  }
  return cv;
}
async function po(cv: string | null, qty: string, price = '1000', kind = 'GOODS') {
  const r = await call('buyer', 'POST', '/api/v1/purchase-orders', { companyId: h.world.companyA1.id, supplierId: h.world.suppliers.s1, contractVersionId: cv, currency: 'TRY',
    lines: [{ kind, description: 'Yedek parça (sentetik)', unit: 'adet', quantity: qty, unitPrice: price }] });
  return r;
}
const poLine = async (poId: string) => (await call('buyer', 'GET', `/api/v1/purchase-orders/${poId}`)).body.lines[0].poLineId as string;
const receive = (lineId: string, q: string) => call('buyer', 'POST', `/api/v1/po-lines/${lineId}/receipts`, { quantity: q, note: 'Depoya teslim alındı (sentetik)' });
async function invoice(qty: string, price = '1000', kind = 'INVOICE', extra: Record<string, unknown> = {}) {
  const net = (Number(qty) * Number(price)).toFixed(2);
  const r = await call('finance', 'POST', '/api/v1/invoices', { companyId: h.world.companyA1.id, supplierId: h.world.suppliers.s1, kind, invoiceNo: `SNT${randomUUID().slice(0, 8)}`,
    issueDate: '2026-10-20', currency: 'TRY', lines: [{ description: 'Yedek parça', quantity: qty, unit: 'adet', unitPrice: price, netAmount: net }], ...extra });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return { id: r.body.id as string, net };
}
const allocate = (id: string, a: { poLineId?: string | null; contractVersionId?: string | null; quantity: string; amount: string }, extra: Record<string, unknown> = {}) =>
  call('finance', 'PUT', `/api/v1/invoices/${id}/allocations`, { allocations: [{ lineNo: 1, poLineId: a.poLineId ?? null, contractVersionId: a.contractVersionId ?? null, quantity: a.quantity, amount: a.amount }], ...extra });
// Onay incelenen sürüme bağlıdır (If-Match = kontrol parmak izi).
const approve = async (id: string, who: Who = 'finance2') => {
  const fp = (await call(who, 'GET', `/api/v1/invoices/${id}`)).body.checkFingerprint as string;
  return h.call(who, 'POST', `/api/v1/invoices/${id}/approve`, { headers: { 'if-match': fp } });
};
const limit = async (cv: string) => (await call('finance', 'GET', `/api/v1/contract-versions/${cv}/limit`)).body;
/** v2 (D93): fatura onayı ucu kaldırıldı. ERP aktarımı eski (v1) onaylı faturalar için korunur; onaylı durum test verisi olarak modül
 *  işleviyle yazılır (API ucu değil, ürün davranışı değil). */
const legacyApprove = async (id: string) => {
  const ctx: TenantContext = { tenantId: h.world.tenantA, userId: h.world.users.finance2.id, roles: ['PROCUREMENT'], companyIds: [h.world.companyA1.id],
    departmentIds: [], allDepartments: true, correlationId: 'v2-legacy-approval' };
  return withTenant(h.pool, ctx, (tx) => approveInvoice(tx, ctx, id, 'test-erp'));
};

describe('T14 limit hesabı ve T13 eksik kabul', () => {
  // v2 Faz 1 (D93): işlev onaylı kaldırma listesinde; davranış removed-v1.test.ts ile 403 olarak korunur
  it.skip('T14: 1M tavan, 400 bin faturalanmış tüketim, 300 bin kalan açık sipariş → kullanılabilir 300 bin; aşan sipariş verilemez', async () => {
    const cv = await contract('1000000.00');
    const p = await po(cv, '700');
    expect(p.status).toBe(201);
    const line = await poLine(p.body.id);
    expect((await receive(line, '400')).status).toBe(201);
    const inv = await invoice('400');
    await allocate(inv.id, { poLineId: line, quantity: '400', amount: inv.net });
    expect((await approve(inv.id)).status).toBe(200);
    expect(await limit(cv)).toMatchObject({ ceiling: '1000000.00', netConsumption: '400000.00', openCommitment: '300000.00', available: '300000.00' });
    const over = await po(cv, '301');
    expect(over.status).toBe(422);
    expect(over.body.error.code).toBe('limit_exceeded');
  });

  // v2 Faz 1 (D93): işlev onaylı kaldırma listesinde; davranış removed-v1.test.ts ile 403 olarak korunur
  it.skip('T13: siparişin yarısı kabul, tamamı fatura → eksik kabul istisnası; yetkisiz onay engelli; istisna kontrol parmak izine bağlı', async () => {
    const cv = await contract('1000000.00');
    const p = await po(cv, '100');
    const line = await poLine(p.body.id);
    await receive(line, '50');
    const inv = await invoice('100');
    await allocate(inv.id, { poLineId: line, quantity: '100', amount: inv.net });
    const d = (await call('finance', 'GET', `/api/v1/invoices/${inv.id}`)).body;
    expect(d.status).toBe('NEEDS_EXCEPTION');
    const miss = d.check.issues.find((x: any) => x.code === 'RECEIPT_MISSING');
    expect(miss).toMatchObject({ severity: 'EXCEPTION', ownerRole: 'REQUESTER' });
    expect(miss.message).toContain('50 adet için mal kabul kaydı yok');
    // Kabul sorumlusunun İşlerim'inde görev (kim çözer).
    expect((await call('buyer', 'GET', '/api/v1/tasks?view=all')).body.items.some((t: any) => t.entityId === inv.id && t.assigneeRole === 'REQUESTER')).toBe(true);
    expect((await approve(inv.id)).body.error.code).toBe('exception_required');
    expect((await approve(inv.id, 'finance')).status).toBe(403); // giren onaylayamaz
    expect((await approve(inv.id, 'buyer')).status).toBe(403); // yetkisiz
    expect((await call('finance2', 'POST', `/api/v1/invoices/${inv.id}/exception-approval`, { reason: 'Kalan 50 adet sevkte; kabul sonrası tamamlanacak (sentetik).' })).status).toBe(403);
    expect((await call('legal2', 'POST', `/api/v1/invoices/${inv.id}/exception-approval`, { reason: 'Kalan 50 adet sevkte; kabul sonrası tamamlanacak (sentetik).' })).status).toBe(200);
    // İstisnadan sonra tahsis değişirse istisna eskir (BR04).
    await allocate(inv.id, { poLineId: line, quantity: '99', amount: inv.net });
    expect((await approve(inv.id)).body.error.code).toBe('exception_stale');
    await allocate(inv.id, { poLineId: line, quantity: '100', amount: inv.net });
    expect((await approve(inv.id)).status).toBe(200);
    expect((await allocate(inv.id, { poLineId: line, quantity: '1', amount: '1.00' })).status).toBe(409);
  });
});

describe('T15 eşzamanlı onay', () => {
  // v2 Faz 1 (D93): işlev onaylı kaldırma listesinde; davranış removed-v1.test.ts ile 403 olarak korunur
  it.skip('aynı limit için iki onay aynı anda: biri geçer, diğeri atomik olarak engellenir', async () => {
    const cv = await contract('100000.00');
    const a = await invoice('60'); const b = await invoice('60');
    await allocate(a.id, { contractVersionId: cv, quantity: '60', amount: a.net });
    await allocate(b.id, { contractVersionId: cv, quantity: '60', amount: b.net });
    const rs = await Promise.all([approve(a.id), approve(b.id)]);
    expect(rs.map((r) => r.status).sort()).toEqual([200, 422]);
    expect(rs.find((r) => r.status === 422)!.body.error.code).toBe('invoice_blocked');
    expect(await limit(cv)).toMatchObject({ netConsumption: '60000.00', available: '40000.00' });
  });
});

describe('T16 avans, kısmi fatura, iade ve ters kabul', () => {
  // v2 Faz 1 (D93): işlev onaylı kaldırma listesinde; davranış removed-v1.test.ts ile 403 olarak korunur
  it.skip('net tüketim ve önceki tahsis doğru; faturalanmış kabul geri alınamaz', async () => {
    const cv = await contract('1000000.00');
    const p = await po(cv, '100');
    const line = await poLine(p.body.id);
    const rec = await receive(line, '60');
    const adv = await invoice('1', '20000', 'ADVANCE');
    await allocate(adv.id, { contractVersionId: cv, quantity: '1', amount: adv.net });
    expect((await approve(adv.id)).status).toBe(200);
    expect((await limit(cv)).netConsumption).toBe('0.00'); // avans tüketim değildir
    const inv = await invoice('50');
    expect((await allocate(inv.id, { poLineId: line, quantity: '50', amount: inv.net }, { advanceOffset: '25000', advanceInvoiceId: adv.id })).body.check.issues.map((x: any) => x.code)).toContain('ADVANCE_OFFSET_INVALID');
    await allocate(inv.id, { poLineId: line, quantity: '50', amount: inv.net }, { advanceOffset: '20000', advanceInvoiceId: adv.id });
    const ok = await approve(inv.id);
    expect(ok.body.payable).toBe('30000.00');
    const cn = await invoice('10', '1000', 'CREDIT_NOTE', { originalInvoiceId: inv.id });
    await allocate(cn.id, { poLineId: line, quantity: '10', amount: cn.net });
    expect((await approve(cn.id)).status).toBe(200);
    expect(await limit(cv)).toMatchObject({ netConsumption: '40000.00', openCommitment: '60000.00' });
    // Kabul 60, net faturalanan 40: 25 ters kabul faturalanmış miktarın altına iner.
    const rev = await call('buyer', 'POST', `/api/v1/receipts/${rec.body.id}/reverse`, { quantity: '25', note: 'Hasarlı iade (sentetik)' });
    expect(rev.body.error.code).toBe('receipt_already_invoiced');
    expect((await call('buyer', 'POST', `/api/v1/receipts/${rec.body.id}/reverse`, { quantity: '15', note: 'Hasarlı iade (sentetik)' })).status).toBe(201);
    const next = await invoice('10');
    const chk = (await allocate(next.id, { poLineId: line, quantity: '10', amount: next.net })).body.check;
    expect(chk.issues.find((x: any) => x.code === 'RECEIPT_MISSING').message).toContain('5 adet');
  });
});

describe('T17 mükerrer fatura ve olay, T18 ERP zaman aşımı', () => {
  it('aynı ETTN tek mali kayıt; tekrar izi görünür; aynı ERP olayı beş kez gelir, tek değişiklik', async () => {
    const ettn = randomUUID();
    const body = { companyId: h.world.companyA1.id, supplierId: h.world.suppliers.s1, kind: 'INVOICE', invoiceNo: `SNT${randomUUID().slice(0, 8)}`, ettn, issueDate: '2026-10-20', currency: 'TRY',
      lines: [{ description: 'Parça', quantity: '1', unit: 'adet', unitPrice: '100', netAmount: '100.00' }] };
    const a = await call('finance', 'POST', '/api/v1/invoices', body);
    const b = await call('finance', 'POST', '/api/v1/invoices', { ...body, invoiceNo: 'FARKLI-NO' });
    expect(a.status).toBe(201);
    expect(b.status).toBe(200);
    expect(b.body).toEqual({ id: a.body.id, duplicate: true });
    expect((await call('finance', 'GET', `/api/v1/invoices/${a.body.id}`)).body.intake.map((x: any) => x.duplicate)).toEqual([false, true]);
    const ev = { eventId: `erp-${randomUUID()}`, invoiceId: a.body.id, status: 'PAID', at: new Date().toISOString() };
    const results = [];
    for (let i = 0; i < 5; i++) results.push((await call('finance', 'POST', '/api/v1/integration/erp/status-events', { events: [ev] })).body.results[0].result);
    expect(results).toEqual(['applied', 'duplicate', 'duplicate', 'duplicate', 'duplicate']);
    expect((await h.owner.query(`SELECT repeat_count FROM integration_inbox WHERE event_id = $1`, [ev.eventId])).rows[0].repeat_count).toBe(4);
    expect((await h.owner.query(`SELECT count(*)::int AS n FROM audit_events WHERE action = 'invoice.erp_status' AND entity_id = $1`, [a.body.id])).rows[0].n).toBe(1);
  });

  // v2 Faz 1 (D93): işlev onaylı kaldırma listesinde; davranış removed-v1.test.ts ile 403 olarak korunur
  it.skip('T18: ERP zaman aşımı ama kayıt dışarıda oluştu → sorgu ile mutabakat, ikinci kayıt yok', async () => {
    const cv = await contract('1000000.00');
    const inv = await invoice('1', '500');
    await allocate(inv.id, { contractVersionId: cv, quantity: '1', amount: inv.net });
    fakeErp.timeoutOnce.add(`erp-invoice-${inv.id}`);
    expect((await approve(inv.id)).status).toBe(200);
    const status = async () => (await call('finance', 'GET', `/api/v1/invoices/${inv.id}`)).body.erp;
    for (let i = 0; i < 50 && (await status()).status === 'PENDING'; i++) { await processJobs(h.pool, h.store, null, 10, 'test-erp'); await new Promise((r) => setTimeout(r, 50)); }
    expect(await status()).toMatchObject({ status: 'UNKNOWN', postCalls: 1 });
    await h.owner.query(`UPDATE jobs SET run_after = now() WHERE idempotency_key = $1`, [`erp-invoice-${inv.id}`]);
    for (let i = 0; i < 50 && (await status()).status !== 'CONFIRMED'; i++) { await processJobs(h.pool, h.store, null, 10, 'test-erp'); await new Promise((r) => setTimeout(r, 50)); }
    expect(await status()).toMatchObject({ status: 'CONFIRMED', postCalls: 1, externalId: fakeErp.records.get(`erp-invoice-${inv.id}`) });
    expect(fakeErp.posts.get(`erp-invoice-${inv.id}`)).toBe(1);
  });
});

describe('Faz 7: yetkili ERP tekrar gönderimi', () => {
  // v2 Faz 1 (D93): işlev onaylı kaldırma listesinde; davranış removed-v1.test.ts ile 403 olarak korunur
  it.skip('kalıcı hatayla DEAD olan aktarım, sebep giderilince gerekçeli tekrar gönderimle tek kayıt olarak onaylanır', async () => {
    const cv = await contract('1000000.00');
    const inv = await invoice('1', '300');
    await allocate(inv.id, { contractVersionId: cv, quantity: '1', amount: inv.net });
    const key = `erp-invoice-${inv.id}`;
    fakeErp.failAlways.add(key);
    expect((await approve(inv.id)).status).toBe(200);
    const job = async () => (await h.owner.query(`SELECT status FROM jobs WHERE idempotency_key = $1`, [key])).rows[0].status;
    for (let i = 0; i < 10 && (await job()) !== 'DEAD'; i++) {
      await h.owner.query(`UPDATE jobs SET run_after = now() WHERE idempotency_key = $1`, [key]);
      await processJobs(h.pool, h.store, null, 10, 'test-erp');
    }
    expect(await job()).toBe('DEAD');
    expect((await call('finance', 'GET', `/api/v1/invoices/${inv.id}`)).body.erp).toMatchObject({ status: 'FAILED' });
    expect((await call('finance', 'POST', `/api/v1/integration/erp/exports/${inv.id}/replay`, { reason: 'kısa' })).status).toBe(400);
    expect((await h.call('auditor', 'POST', `/api/v1/integration/erp/exports/${inv.id}/replay`, { body: { reason: 'Cari kart ERP tarafında açıldı (sentetik).' } })).status).toBe(403);
    fakeErp.failAlways.delete(key);
    const r = await call('finance', 'POST', `/api/v1/integration/erp/exports/${inv.id}/replay`, { reason: 'Cari kart ERP tarafında açıldı (sentetik).' });
    expect(r.status).toBe(200);
    for (let i = 0; i < 5; i++) await processJobs(h.pool, h.store, null, 10, 'test-erp');
    expect((await call('finance', 'GET', `/api/v1/invoices/${inv.id}`)).body.erp).toMatchObject({ status: 'CONFIRMED', externalId: fakeErp.records.get(key) });
    // Onaylanmış aktarım tekrar gönderilemez.
    expect((await call('finance', 'POST', `/api/v1/integration/erp/exports/${inv.id}/replay`, { reason: 'Gereksiz tekrar denemesi (sentetik).' })).status).toBe(409);
    expect((await h.owner.query(`SELECT reason FROM audit_events WHERE action = 'erp.export.replayed' AND entity_id = $1`, [inv.id])).rows[0].reason).toContain('Cari kart');
  });
});

describe('T37 arşiv sözleşmesi', () => {
  // v2 Faz 1 (D93): işlev onaylı kaldırma listesinde; davranış removed-v1.test.ts ile 403 olarak korunur
  it.skip('imza durumu bilinmeyen arşiv sözleşmesine bağlı mevcut fatura iptal edilmez; politika incelemesi açılır', async () => {
    const cv = await contract(null, { stage: 'ARCHIVE_IMPORT', method: 'WET_IMAGE_REVIEW' });
    const inv = await invoice('1', '750');
    await allocate(inv.id, { contractVersionId: cv, quantity: '1', amount: inv.net });
    const d = (await call('finance', 'GET', `/api/v1/invoices/${inv.id}`)).body;
    expect(d.check.issues).toEqual([expect.objectContaining({ code: 'CONTRACT_SIGNATURE_UNRESOLVED', severity: 'REVIEW', ownerRole: 'LEGAL' })]);
    expect(d.invoice.legalStatus).toBe('RECEIVED');
    expect(d.status).toBe('NEEDS_EXCEPTION');
    expect((await approve(inv.id)).body.error.code).toBe('exception_required');
    expect((await call('legal2', 'POST', `/api/v1/invoices/${inv.id}/exception-approval`, { reason: 'Hukuk/finans politika incelemesi: hizmet alındı, ödeme yapılabilir (sentetik).' })).status).toBe(200);
    expect((await approve(inv.id)).status).toBe(200);
  });
});

describe('Faz 7: rapor için toplu fatura kontrolü', () => {
  // v2 Faz 1 (D93): işlev onaylı kaldırma listesinde; davranış removed-v1.test.ts ile 403 olarak korunur
  it.skip('toplu kontrol, onaylanmamış her faturada tek tek kontrolle aynı sonucu verir (bu dosyadaki bütün senaryolar)', async () => {
    const { withTenant } = await import('../src/db.ts');
    const { invoiceHasIssue, unapprovedInvoicesWithIssues } = await import('../src/modules/invoices.ts');
    // Onaylanmamış çeşitli durumlar: tahsissiz, kabulü eksik sipariş, tam kabullü sipariş, tavanlı sözleşme, belgede yazan tutar farkı.
    const cv = await contract('5000.00');
    await invoice('1', '100');
    const p1 = await po(null, '10', '100'); const l1 = await poLine(p1.body.id);
    const i1 = await invoice('10', '100'); await allocate(i1.id, { poLineId: l1, quantity: '10', amount: i1.net });
    const p2 = await po(null, '5', '100'); const l2 = await poLine(p2.body.id); await receive(l2, '5');
    const i2 = await invoice('5', '100'); await allocate(i2.id, { poLineId: l2, quantity: '5', amount: i2.net });
    const i3 = await invoice('1', '4000'); await allocate(i3.id, { contractVersionId: cv, quantity: '1', amount: i3.net });
    const i4 = await invoice('1', '9000'); await allocate(i4.id, { contractVersionId: cv, quantity: '1', amount: i4.net });
    await invoice('2', '50', 'INVOICE', { declaredPayable: '999.00' });
    // Avans mahsubu: bakiyeyi aşan ve aşmayan (toplu yolda avans bakiyesi avans faturası başına bir kez hesaplanır).
    const adv = await invoice('1', '1000', 'ADVANCE');
    const i5 = await invoice('1', '500'); await allocate(i5.id, { contractVersionId: cv, quantity: '1', amount: i5.net }, { advanceOffset: '2000', advanceInvoiceId: adv.id });
    const i6 = await invoice('1', '500'); await allocate(i6.id, { contractVersionId: cv, quantity: '1', amount: i6.net }, { advanceOffset: '300', advanceInvoiceId: adv.id });
    const ctx = { tenantId: h.world.tenantA, userId: h.world.users.finance.id, roles: ['FINANCE'], companyIds: [h.world.companyA1.id, h.world.companyA2.id], departmentIds: [], allDepartments: true, correlationId: 'test' };
    const ids = (await h.owner.query<{ id: string }>(`SELECT i.id FROM invoices i WHERE i.tenant_id = $1
      AND NOT EXISTS (SELECT 1 FROM invoice_decisions d WHERE d.invoice_id = i.id AND d.kind = 'APPROVAL')`, [h.world.tenantA])).rows.map((r) => r.id);
    expect(ids.length).toBeGreaterThan(5);
    await withTenant(h.pool, ctx, async (tx) => {
      const bulk = await unapprovedInvoicesWithIssues(tx, ids);
      const single = new Set<string>();
      for (const id of ids) if (await invoiceHasIssue(tx, id)) single.add(id);
      expect([...bulk].sort()).toEqual([...single].sort());
      expect(single.size).toBeGreaterThan(0);
      expect(single.size).toBeLessThan(ids.length); // hem bulgulu hem bulgusuz fatura var
    });
  });
});

describe('Faz 4: vergi dahil limit, KDV dışı vergi oranı, kategori toleransı', () => {
  // v2 Faz 1 (D93): işlev onaylı kaldırma listesinde; davranış removed-v1.test.ts ile 403 olarak korunur
  it.skip('vergi dahil limitli sözleşmede siparişte KDV oranı zorunlu; açık taahhüt ve tüketim brüt; aşım KDV dahil hesaplanır', async () => {
    const cv = await contract('130000.00', { limitBasis: 'GROSS' });
    const noRate = await po(cv, '100');
    expect(noRate.status).toBe(422);
    expect(noRate.body.error.code).toBe('tax_rate_required');
    const mk = (qty: string) => call('buyer', 'POST', '/api/v1/purchase-orders', { companyId: h.world.companyA1.id, supplierId: h.world.suppliers.s1, contractVersionId: cv, currency: 'TRY',
      lines: [{ kind: 'GOODS', description: 'Yedek parça (sentetik)', unit: 'adet', quantity: qty, unitPrice: '1000', taxRate: '20' }] });
    // 110 × 1000 × 1,20 = 132.000 > 130.000 (net 110.000 sığardı).
    const over = await mk('110');
    expect(over.status).toBe(422);
    expect(over.body.error.message).toContain('(vergi dahil)');
    const p = await mk('100');
    expect(p.status).toBe(201);
    let l = await limit(cv);
    expect(l).toMatchObject({ limitBasis: 'GROSS', openCommitment: '120000.00', available: '10000.00' });
    const line = await poLine(p.body.id);
    await receive(line, '100');
    const inv = await invoice('100', '1000', 'INVOICE');
    await allocate(inv.id, { poLineId: line, quantity: '100', amount: inv.net });
    expect((await approve(inv.id)).status).toBe(200);
    l = await limit(cv);
    // Fatura satırı KDV %20 (varsayılan) → tüketim 120.000 brüt; açık taahhüt kalmadı.
    expect(l).toMatchObject({ netConsumption: '120000.00', openCommitment: '0.00', available: '10000.00' });
  });

  // v2 Faz 1 (D93): işlev onaylı kaldırma listesinde; davranış removed-v1.test.ts ile 403 olarak korunur
  it.skip('inceleme: oransız açık sipariş varken vergi dahil limite geçilmez; doğrulanmamış revizyon tavanı kaldırmaz; sipariş yalnız onaylı projeye bağlanır', async () => {
    const cv = await contract('100000.00');
    expect((await po(cv, '10')).status).toBe(201); // oran yok (NET sözleşme)
    const terms = { currency: 'TRY', valueType: 'CEILING', amount: '100000.00', paymentTerms: '30 gün', startDate: '2026-01-01', endDate: '2027-12-31', autoRenewal: false,
      renewalMonths: null, noticeAmount: null, noticeUnit: null, nonWorkingDay: 'AS_IS', sourceRef: 'Madde 5 (sentetik)' };
    const g = await call('legal', 'POST', `/api/v1/contract-versions/${cv}/terms`, { ...terms, limitBasis: 'GROSS', changeReason: 'Vergi dahil tavana geçiş (sentetik).' });
    expect(g.body.error.code).toBe('tax_rate_missing');
    // Satınalmacı doğrulanmamış revizyonla tavanı kaldıramaz.
    const loose = await call('buyer', 'POST', `/api/v1/contract-versions/${cv}/terms`, { ...terms, valueType: 'UNPRICED', amount: null, changeReason: 'Bedelsiz yapıldı (sentetik deneme).' });
    expect(loose.status).toBe(201);
    expect((await limit(cv)).ceiling).toBe('100000.00');
    expect((await po(cv, '200')).status).toBe(422);
    const proj = (await h.owner.query(`INSERT INTO projects (tenant_id, company_id, code, title, category, owner_user_id, created_by) VALUES ($1,$2,$3,'Taslak proje (SENTETİK)','Gevşek',$4,$4) RETURNING id`,
      [h.world.tenantA, h.world.companyA1.id, `PRJ-T-${randomUUID().slice(0, 6)}`, h.world.users.buyer.id])).rows[0].id;
    const linked = await call('buyer', 'POST', '/api/v1/purchase-orders', { companyId: h.world.companyA1.id, supplierId: h.world.suppliers.s1, projectId: proj, currency: 'TRY',
      lines: [{ kind: 'GOODS', description: 'Yedek parça (sentetik)', unit: 'adet', quantity: '1', unitPrice: '10' }] });
    expect(linked.body.error.code).toBe('project_not_awarded');
  });

  it('oranı tutmayan KDV dışı vergi onayı engeller; oranı tutan ve maktu vergi geçer, matraha girer', async () => {
    const bad = await invoice('1', '1000', 'INVOICE', { lines: [{ description: 'Haberleşme', quantity: '1', unit: 'ay', unitPrice: '1000', netAmount: '1000.00', taxRate: '20',
      otherTaxes: [{ code: '4080', name: 'ÖİV', rate: '7.5', amount: '80.00' }] }] });
    const d = (await call('finance', 'GET', `/api/v1/invoices/${bad.id}`)).body;
    expect(d.check.issues.find((x: any) => x.code === 'OTHER_TAX_RATE_MISMATCH')).toMatchObject({ severity: 'BLOCK', lineNo: 1 });
    expect(d.lines[0].otherTaxes).toEqual([{ code: '4080', name: 'ÖİV', rate: '7.5', amount: '80.00' }]);
    expect(d.lines[0].otherTax).toBe('80.00');
    const ok = await invoice('1', '1000', 'INVOICE', { lines: [{ description: 'Haberleşme', quantity: '1', unit: 'ay', unitPrice: '1000', netAmount: '1000.00', taxRate: '20',
      otherTaxes: [{ code: '4080', name: 'ÖİV', rate: '7.5', amount: '75.00' }, { code: '0071', name: 'ÖTV', rate: null, amount: '25.00' }] }] });
    const c = (await call('finance', 'GET', `/api/v1/invoices/${ok.id}`)).body.check;
    expect(c.issues.some((x: any) => x.code.startsWith('OTHER_TAX'))).toBe(false);
    expect(c).toMatchObject({ otherTaxTotal: '100.00', taxTotal: '220.00' });
  });

  // v2 Faz 1 (D93): işlev onaylı kaldırma listesinde; davranış removed-v1.test.ts ile 403 olarak korunur
  it.skip('kategori kuralı siparişin projesinin kategorisine göre seçilir; kural listesi ve kaldırma kategoriyle', async () => {
    expect((await call('finance', 'PUT', '/api/v1/tolerance-rules', { currency: 'TRY', absAmount: '100', percent: null, combine: 'LOWER' })).status).toBe(200);
    expect((await call('finance', 'PUT', '/api/v1/tolerance-rules', { currency: 'TRY', category: 'BT donanımı', absAmount: '5000', percent: null, combine: 'LOWER' })).status).toBe(200);
    const rules = (await call('finance', 'GET', '/api/v1/tolerance-rules')).body.items;
    expect(rules.map((r: any) => [r.currency, r.category])).toEqual(expect.arrayContaining([['TRY', ''], ['TRY', 'BT donanımı']]));
    const proj = (await h.owner.query(`INSERT INTO projects (tenant_id, company_id, code, title, category, owner_user_id, created_by) VALUES ($1,$2,$3,'Donanım yenileme (SENTETİK)','BT donanımı',$4,$4) RETURNING id`,
      [h.world.tenantA, h.world.companyA1.id, `PRJ-T-${randomUUID().slice(0, 6)}`, h.world.users.buyer.id])).rows[0].id;
    const p = await po(null, '10');
    await h.owner.query(`UPDATE purchase_orders SET project_id = $1 WHERE id = $2`, [proj, p.body.id]);
    const line = await poLine(p.body.id);
    await receive(line, '10');
    // 10 × 1200 = 12.000; sipariş 10.000 → fark 2.000: BT kuralı (5.000) içinde, genel kural (100) dışında.
    const inv = await invoice('10', '1200');
    await allocate(inv.id, { poLineId: line, quantity: '10', amount: inv.net });
    let c = (await call('finance', 'GET', `/api/v1/invoices/${inv.id}`)).body.check;
    expect(c.issues.some((x: any) => x.code === 'PRICE_MISMATCH')).toBe(false);
    expect((await h.call('finance', 'DELETE', `/api/v1/tolerance-rules/TRY?category=${encodeURIComponent('BT donanımı')}`)).status).toBe(200);
    c = (await call('finance', 'GET', `/api/v1/invoices/${inv.id}`)).body.check;
    expect(c.issues.find((x: any) => x.code === 'PRICE_MISMATCH').message).toContain('TRY genel kuralı');
  });
});

// Görev 4 ayrımı: atlanan testlerin korunan kısımları (sipariş/kabul/onay adımları olmadan; onaylı durum test verisi).
describe('v2: korunan ERP aktarımı, arşiv sözleşmesi bulgusu ve toplu kontrol', () => {
  it('T18: ERP zaman aşımı ama kayıt dışarıda oluştu → sorgu ile mutabakat, ikinci kayıt yok (onay test verisi)', async () => {
    const cv = await contract('1000000.00');
    const inv = await invoice('1', '500');
    await allocate(inv.id, { contractVersionId: cv, quantity: '1', amount: inv.net });
    fakeErp.timeoutOnce.add(`erp-invoice-${inv.id}`);
    await legacyApprove(inv.id);
    const status = async () => (await call('finance', 'GET', `/api/v1/invoices/${inv.id}`)).body.erp;
    for (let i = 0; i < 50 && (await status()).status === 'PENDING'; i++) { await processJobs(h.pool, h.store, null, 10, 'test-erp'); await new Promise((r) => setTimeout(r, 50)); }
    expect(await status()).toMatchObject({ status: 'UNKNOWN', postCalls: 1 });
    await h.owner.query(`UPDATE jobs SET run_after = now() WHERE idempotency_key = $1`, [`erp-invoice-${inv.id}`]);
    for (let i = 0; i < 50 && (await status()).status !== 'CONFIRMED'; i++) { await processJobs(h.pool, h.store, null, 10, 'test-erp'); await new Promise((r) => setTimeout(r, 50)); }
    expect(await status()).toMatchObject({ status: 'CONFIRMED', postCalls: 1, externalId: fakeErp.records.get(`erp-invoice-${inv.id}`) });
    expect(fakeErp.posts.get(`erp-invoice-${inv.id}`)).toBe(1);
  });

  it('kalıcı hatayla DEAD olan aktarım, gerekçeli tekrar gönderimle (Satınalma) tek kayıt olarak onaylanır; denetçi tekrar gönderemez (onay test verisi)', async () => {
    const cv = await contract('1000000.00');
    const inv = await invoice('1', '300');
    await allocate(inv.id, { contractVersionId: cv, quantity: '1', amount: inv.net });
    const key = `erp-invoice-${inv.id}`;
    fakeErp.failAlways.add(key);
    await legacyApprove(inv.id);
    const job = async () => (await h.owner.query(`SELECT status FROM jobs WHERE idempotency_key = $1`, [key])).rows[0].status;
    for (let i = 0; i < 10 && (await job()) !== 'DEAD'; i++) {
      await h.owner.query(`UPDATE jobs SET run_after = now() WHERE idempotency_key = $1`, [key]);
      await processJobs(h.pool, h.store, null, 10, 'test-erp');
    }
    expect(await job()).toBe('DEAD');
    expect((await call('finance', 'GET', `/api/v1/invoices/${inv.id}`)).body.erp).toMatchObject({ status: 'FAILED' });
    expect((await call('finance', 'POST', `/api/v1/integration/erp/exports/${inv.id}/replay`, { reason: 'kısa' })).status).toBe(400);
    expect((await h.call('auditor', 'POST', `/api/v1/integration/erp/exports/${inv.id}/replay`, { body: { reason: 'Cari kart ERP tarafında açıldı (sentetik).' } })).status).toBe(403);
    fakeErp.failAlways.delete(key);
    const r = await call('finance', 'POST', `/api/v1/integration/erp/exports/${inv.id}/replay`, { reason: 'Cari kart ERP tarafında açıldı (sentetik).' });
    expect(r.status).toBe(200);
    for (let i = 0; i < 5; i++) await processJobs(h.pool, h.store, null, 10, 'test-erp');
    expect((await call('finance', 'GET', `/api/v1/invoices/${inv.id}`)).body.erp).toMatchObject({ status: 'CONFIRMED', externalId: fakeErp.records.get(key) });
    expect((await call('finance', 'POST', `/api/v1/integration/erp/exports/${inv.id}/replay`, { reason: 'Gereksiz tekrar denemesi (sentetik).' })).status).toBe(409);
    expect((await h.owner.query(`SELECT reason FROM audit_events WHERE action = 'erp.export.replayed' AND entity_id = $1`, [inv.id])).rows[0].reason).toContain('Cari kart');
  });

  it('T37: imza durumu bilinmeyen arşiv sözleşmesine bağlı fatura iptal edilmez; politika incelemesi bulgusu görünür', async () => {
    const cv = await contract(null, { stage: 'ARCHIVE_IMPORT', method: 'WET_IMAGE_REVIEW' });
    const inv = await invoice('1', '750');
    await allocate(inv.id, { contractVersionId: cv, quantity: '1', amount: inv.net });
    const d = (await call('finance', 'GET', `/api/v1/invoices/${inv.id}`)).body;
    expect(d.check.issues).toEqual([expect.objectContaining({ code: 'CONTRACT_SIGNATURE_UNRESOLVED', severity: 'REVIEW', ownerRole: 'LEGAL' })]);
    expect(d.invoice.legalStatus).toBe('RECEIVED');
    expect(d.status).toBe('NEEDS_EXCEPTION');
  });

  it('toplu kontrol, onaylanmamış her faturada tek tek kontrolle aynı sonucu verir (sipariş olmadan)', async () => {
    const { invoiceHasIssue, unapprovedInvoicesWithIssues } = await import('../src/modules/invoices.ts');
    const cv = await contract('5000.00');
    await invoice('1', '100');
    const i3 = await invoice('1', '4000'); await allocate(i3.id, { contractVersionId: cv, quantity: '1', amount: i3.net });
    const i4 = await invoice('1', '9000'); await allocate(i4.id, { contractVersionId: cv, quantity: '1', amount: i4.net });
    await invoice('2', '50', 'INVOICE', { declaredPayable: '999.00' });
    const adv = await invoice('1', '1000', 'ADVANCE');
    const i5 = await invoice('1', '500'); await allocate(i5.id, { contractVersionId: cv, quantity: '1', amount: i5.net }, { advanceOffset: '2000', advanceInvoiceId: adv.id });
    const i6 = await invoice('1', '500'); await allocate(i6.id, { contractVersionId: cv, quantity: '1', amount: i6.net }, { advanceOffset: '300', advanceInvoiceId: adv.id });
    const ctx = { tenantId: h.world.tenantA, userId: h.world.users.finance.id, roles: ['PROCUREMENT'], companyIds: [h.world.companyA1.id, h.world.companyA2.id], departmentIds: [], allDepartments: true, correlationId: 'test' };
    const ids = (await h.owner.query<{ id: string }>(`SELECT i.id FROM invoices i WHERE i.tenant_id = $1
      AND NOT EXISTS (SELECT 1 FROM invoice_decisions d WHERE d.invoice_id = i.id AND d.kind = 'APPROVAL')`, [h.world.tenantA])).rows.map((r) => r.id);
    expect(ids.length).toBeGreaterThan(5);
    await withTenant(h.pool, ctx, async (tx) => {
      const bulk = await unapprovedInvoicesWithIssues(tx, ids);
      const single = new Set<string>();
      for (const id of ids) if (await invoiceHasIssue(tx, id)) single.add(id);
      expect([...bulk].sort()).toEqual([...single].sort());
      expect(single.size).toBeGreaterThan(0);
      expect(single.size).toBeLessThan(ids.length);
    });
  });

  it('doğrulanmamış koşul revizyonu tavanı kaldırmaz (satınalmacı girer, doğrulanana kadar eski tavan geçerli)', async () => {
    const cv = await contract('100000.00');
    const terms = { currency: 'TRY', valueType: 'CEILING', amount: '100000.00', paymentTerms: '30 gün', startDate: '2026-01-01', endDate: '2027-12-31', autoRenewal: false,
      renewalMonths: null, noticeAmount: null, noticeUnit: null, nonWorkingDay: 'AS_IS', sourceRef: 'Madde 5 (sentetik)' };
    const loose = await call('buyer', 'POST', `/api/v1/contract-versions/${cv}/terms`, { ...terms, valueType: 'UNPRICED', amount: null, changeReason: 'Bedelsiz yapıldı (sentetik deneme).' });
    expect(loose.status).toBe(201);
    expect((await limit(cv)).ceiling).toBe('100000.00');
  });
});

// Görev 4 düzeltme: sözleşme limit hesabı (GET /contract-versions/:id/limit) v2'de korunur (analiz §3.5 kullanım ve aşım uyarısı).
// Sipariş, mal kabul ve fatura onayı uçları kaldırıldığından tüketim ve taahhüt doğuran eski (v1) kayıtlar test verisi olarak modül
// işlevleriyle yazılır (API ucu değil); limit değerleri API'den okunur. Değerler atlanan T14, T15, T16 ve vergi dahil limit testleriyle aynı.
describe('v2: sözleşme limit hesabı (eski sipariş/kabul/onay test verisi)', () => {
  const ctx = (): TenantContext => ({ tenantId: h.world.tenantA, userId: h.world.users.buyer.id, roles: ['PROCUREMENT'], companyIds: [h.world.companyA1.id],
    departmentIds: [], allDepartments: true, correlationId: 'v2-legacy-limit' });
  const legacyPo = (cv: string | null, qty: string, price = '1000', taxRate?: string) => { const c = ctx(); return withTenant(h.pool, c, (tx) => createPo(tx, c, { companyId: h.world.companyA1.id,
    supplierId: h.world.suppliers.s1, contractVersionId: cv, currency: 'TRY', lines: [{ kind: 'GOODS', description: 'Yedek parça (sentetik)', unit: 'adet', quantity: qty, unitPrice: price, ...(taxRate ? { taxRate } : {}) }] } as never)); };
  const legacyLine = async (poId: string) => (await h.owner.query<{ id: string }>(`SELECT id FROM po_lines WHERE po_id = $1 ORDER BY line_no`, [poId])).rows[0]!.id;
  const legacyReceive = (line: string, q: string) => { const c = ctx(); return withTenant(h.pool, c, (tx) => recordReceipt(tx, c, line, { quantity: q, note: 'Depoya teslim alındı (sentetik)' })); };

  it('T14: 1M tavan, 400 bin faturalanmış tüketim, 300 bin kalan açık sipariş → kullanılabilir 300 bin; aşan sipariş verilemez', async () => {
    const cv = await contract('1000000.00');
    const p = await legacyPo(cv, '700');
    const line = await legacyLine(p.id);
    await legacyReceive(line, '400');
    const inv = await invoice('400');
    expect((await allocate(inv.id, { poLineId: line, quantity: '400', amount: inv.net })).status).toBe(200);
    await legacyApprove(inv.id);
    expect(await limit(cv)).toMatchObject({ ceiling: '1000000.00', netConsumption: '400000.00', openCommitment: '300000.00', available: '300000.00' });
    await expect(legacyPo(cv, '301')).rejects.toMatchObject({ code: 'limit_exceeded' });
  });

  it('T15: aynı limit için iki onay aynı anda: biri geçer, diğeri atomik olarak engellenir', async () => {
    // Onay ucu kaldırıldı; limit kilidi onay işlevinin içinde olduğundan eşzamanlılık güvencesi modül işleviyle sınanır.
    const cv = await contract('100000.00');
    const a = await invoice('60'); const b = await invoice('60');
    await allocate(a.id, { contractVersionId: cv, quantity: '60', amount: a.net });
    await allocate(b.id, { contractVersionId: cv, quantity: '60', amount: b.net });
    const rs = await Promise.allSettled([legacyApprove(a.id), legacyApprove(b.id)]);
    expect(rs.map((r) => r.status).sort()).toEqual(['fulfilled', 'rejected']);
    expect((rs.find((r) => r.status === 'rejected') as PromiseRejectedResult).reason).toMatchObject({ code: 'invoice_blocked' });
    expect(await limit(cv)).toMatchObject({ netConsumption: '60000.00', available: '40000.00' });
  });

  it('T16: avans tüketim değildir; mahsuplu fatura ödenecek tutarı düşer; iade tüketimi azaltır', async () => {
    const cv = await contract('1000000.00');
    const p = await legacyPo(cv, '100');
    const line = await legacyLine(p.id);
    await legacyReceive(line, '60');
    const adv = await invoice('1', '20000', 'ADVANCE');
    await allocate(adv.id, { contractVersionId: cv, quantity: '1', amount: adv.net });
    await legacyApprove(adv.id);
    expect((await limit(cv)).netConsumption).toBe('0.00'); // avans tüketim değildir
    const inv = await invoice('50');
    expect((await allocate(inv.id, { poLineId: line, quantity: '50', amount: inv.net }, { advanceOffset: '25000', advanceInvoiceId: adv.id })).body.check.issues.map((x: any) => x.code)).toContain('ADVANCE_OFFSET_INVALID');
    await allocate(inv.id, { poLineId: line, quantity: '50', amount: inv.net }, { advanceOffset: '20000', advanceInvoiceId: adv.id });
    expect((await legacyApprove(inv.id)).payable).toBe('30000.00');
    const cn = await invoice('10', '1000', 'CREDIT_NOTE', { originalInvoiceId: inv.id });
    await allocate(cn.id, { poLineId: line, quantity: '10', amount: cn.net });
    await legacyApprove(cn.id);
    expect(await limit(cv)).toMatchObject({ netConsumption: '40000.00', openCommitment: '60000.00' });
  });

  it('vergi dahil limitli sözleşmede siparişte KDV oranı zorunlu; açık taahhüt ve tüketim brüt; aşım KDV dahil hesaplanır', async () => {
    const cv = await contract('130000.00', { limitBasis: 'GROSS' });
    await expect(legacyPo(cv, '100')).rejects.toMatchObject({ code: 'tax_rate_required' });
    // 110 × 1000 × 1,20 = 132.000 > 130.000 (net 110.000 sığardı).
    await expect(legacyPo(cv, '110', '1000', '20')).rejects.toMatchObject({ code: 'limit_exceeded', message: expect.stringContaining('(vergi dahil)') });
    const p = await legacyPo(cv, '100', '1000', '20');
    expect(await limit(cv)).toMatchObject({ limitBasis: 'GROSS', openCommitment: '120000.00', available: '10000.00' });
    const line = await legacyLine(p.id);
    await legacyReceive(line, '100');
    const inv = await invoice('100', '1000', 'INVOICE');
    await allocate(inv.id, { poLineId: line, quantity: '100', amount: inv.net });
    await legacyApprove(inv.id);
    // Fatura satırı KDV %20 (varsayılan) → tüketim 120.000 brüt; açık taahhüt kalmadı.
    expect(await limit(cv)).toMatchObject({ netConsumption: '120000.00', openCommitment: '0.00', available: '10000.00' });
  });
});
