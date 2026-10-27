import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { syntheticPdf } from '../src/devdata.ts';
import { processJobs } from '../src/worker.ts';
import { fakeErp, makeHarness } from './harness.ts';

// Faz 4 kabul testleri (T13–T18, T37) gerçek PostgreSQL + RLS üzerinde. Tüm veri sentetik; ERP bağdaştırıcısı yalnız testte.
let h: Awaited<ReturnType<typeof makeHarness>>;
beforeAll(async () => { h = await makeHarness(); });
afterAll(async () => { await h.close(); });

type Who = 'buyer' | 'finance' | 'finance2' | 'legal' | 'legal2';
const call = (who: Who, method: string, url: string, body?: unknown) => h.call(who, method, url, body === undefined ? {} : { body });

async function contract(ceiling: string | null, opts: { stage?: string; method?: string } = {}) {
  const up = await h.upload('legal', { name: 's.pdf', mime: 'application/pdf', data: syntheticPdf([[`SENTETIK ${randomUUID()}`]]) },
    { companyId: h.world.companyA1.id, kind: 'CONTRACT', title: 'Tedarik Sözleşmesi (SENTETİK)' });
  const c = await call('legal', 'POST', '/api/v1/contracts', { title: `Tedarik ${randomUUID().slice(0, 4)} (SENTETİK)`, documentVersionId: up.body.documentVersionId,
    stage: opts.stage ?? 'EXECUTION', signatureMethod: opts.method ?? 'NOT_REQUIRED', originalCustodyRequired: false,
    parties: [{ role: 'BUYER', displayName: h.world.companyA1.name, legalEntityId: h.world.companyA1.id }], supplierId: h.world.suppliers.s1 });
  const cv = c.body.contractVersionId as string;
  if (ceiling) {
    const t = await call('legal', 'POST', `/api/v1/contract-versions/${cv}/terms`, { currency: 'TRY', valueType: 'CEILING', amount: ceiling, paymentTerms: '30 gün',
      startDate: '2026-01-01', endDate: '2027-12-31', autoRenewal: false, renewalMonths: null, noticeAmount: null, noticeUnit: null, nonWorkingDay: 'AS_IS', sourceRef: 'Madde 5 (sentetik)' });
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
  expect(r.status).toBe(201);
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

describe('T14 limit hesabı ve T13 eksik kabul', () => {
  it('T14: 1M tavan, 400 bin faturalanmış tüketim, 300 bin kalan açık sipariş → kullanılabilir 300 bin; aşan sipariş verilemez', async () => {
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

  it('T13: siparişin yarısı kabul, tamamı fatura → eksik kabul istisnası; yetkisiz onay engelli; istisna kontrol parmak izine bağlı', async () => {
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
  it('aynı limit için iki onay aynı anda: biri geçer, diğeri atomik olarak engellenir', async () => {
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
  it('net tüketim ve önceki tahsis doğru; faturalanmış kabul geri alınamaz', async () => {
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

  it('T18: ERP zaman aşımı ama kayıt dışarıda oluştu → sorgu ile mutabakat, ikinci kayıt yok', async () => {
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

describe('T37 arşiv sözleşmesi', () => {
  it('imza durumu bilinmeyen arşiv sözleşmesine bağlı mevcut fatura iptal edilmez; politika incelemesi açılır', async () => {
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
