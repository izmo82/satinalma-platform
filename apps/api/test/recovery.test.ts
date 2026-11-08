import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { syntheticPdf, ublInvoiceXml } from '../src/devdata.ts';
import { makeHarness } from './harness.ts';

// Lira Defteri (D80): kurallı geri kazanım bulguları, vaka yaşam döngüsü ve kanıt zinciri. Gerçek PostgreSQL + RLS; veri sentetik.
let h: Awaited<ReturnType<typeof makeHarness>>;
beforeAll(async () => { h = await makeHarness(); });
afterAll(async () => { await h.close(); });

type Who = 'buyer' | 'finance' | 'finance2' | 'legal' | 'legal2' | 'supplier1' | 'security' | 'auditor';
const call = (who: Who, method: string, url: string, body?: unknown) => h.call(who, method, url, body === undefined ? {} : { body });

async function contract(terms: { paymentDays?: number | null; fxDifference?: 'ALLOWED' | 'NOT_ALLOWED' | null; endDate?: string } | null) {
  const up = await h.upload('legal', { name: 's.pdf', mime: 'application/pdf', data: syntheticPdf([[`SENTETIK ${randomUUID()}`]]) },
    { companyId: h.world.companyA1.id, kind: 'CONTRACT', title: 'Hizmet Sözleşmesi (SENTETİK)' });
  const c = await call('legal', 'POST', '/api/v1/contracts', { title: `Bakım ${randomUUID().slice(0, 4)} (SENTETİK)`, documentVersionId: up.body.documentVersionId,
    stage: 'EXECUTION', signatureMethod: 'NOT_REQUIRED', originalCustodyRequired: false,
    parties: [{ role: 'BUYER', displayName: h.world.companyA1.name, legalEntityId: h.world.companyA1.id }], supplierId: h.world.suppliers.s1 });
  const cv = c.body.contractVersionId as string;
  if (terms) {
    const t = await call('legal', 'POST', `/api/v1/contract-versions/${cv}/terms`, { currency: 'TRY', valueType: 'CEILING', amount: '100000000.00', paymentTerms: 'Fatura tarihinden itibaren',
      startDate: '2026-01-01', endDate: terms.endDate ?? '2027-12-31', autoRenewal: false, renewalMonths: null, noticeAmount: null, noticeUnit: null, nonWorkingDay: 'AS_IS',
      sourceRef: 'Madde 7.3 (sentetik)', paymentDays: terms.paymentDays ?? null, fxDifference: terms.fxDifference ?? null });
    expect(t.status, JSON.stringify(t.body)).toBe(201);
    expect((await call('legal2', 'POST', `/api/v1/contract-terms/${t.body.id}/verify`)).status).toBe(200);
  }
  return cv;
}
async function invoice(o: { net: string; kind?: string; currency?: string; issueDate?: string; description?: string; no?: string; qty?: string; price?: string;
  lines?: { description: string; net: string }[]; originalInvoiceId?: string }) {
  const r = await call('finance', 'POST', '/api/v1/invoices', { companyId: h.world.companyA1.id, supplierId: h.world.suppliers.s1, kind: o.kind ?? 'INVOICE',
    invoiceNo: o.no ?? `SNT${randomUUID().slice(0, 8).toUpperCase()}`, issueDate: o.issueDate ?? '2026-10-20', currency: o.currency ?? 'TRY',
    lines: o.lines ? o.lines.map((l) => ({ description: l.description, quantity: '1', unit: 'adet', unitPrice: l.net, netAmount: l.net }))
      : [{ description: o.description ?? 'Bakım hizmeti', quantity: o.qty ?? '1', unit: 'adet', unitPrice: o.price ?? o.net, netAmount: o.net }],
    ...(o.originalInvoiceId ? { originalInvoiceId: o.originalInvoiceId } : {}) });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return r.body.id as string;
}
const allocate = (id: string, cv: string, amount: string, extra: Record<string, unknown> = {}) =>
  call('finance', 'PUT', `/api/v1/invoices/${id}/allocations`, { allocations: [{ lineNo: 1, poLineId: null, contractVersionId: cv, quantity: '1', amount }], ...extra });
const approve = async (id: string) => {
  const fp = (await call('finance2', 'GET', `/api/v1/invoices/${id}`)).body.checkFingerprint as string;
  const r = await h.call('finance2', 'POST', `/api/v1/invoices/${id}/approve`, { headers: { 'if-match': fp } });
  expect(r.status, JSON.stringify(r.body)).toBe(200);
};
const paid = (id: string, at: string) => call('finance', 'POST', '/api/v1/integration/erp/status-events', { events: [{ eventId: `pay-${id}`, invoiceId: id, status: 'PAID', at }] });
const scan = async () => { const r = await call('buyer', 'POST', '/api/v1/recovery/scan'); expect(r.status, JSON.stringify(r.body)).toBe(200); return r.body; };
const cases = async () => (await call('finance', 'GET', '/api/v1/recovery/cases')).body.items as any[];
const caseFor = async (invoiceNo: string) => (await cases()).find((c) => c.invoiceNo === invoiceNo);

describe('Lira Defteri bulguları', () => {
  it('kur farkı: sözleşme izin vermiyorsa tamamı, izin veriyorsa kurla hesaplanan fazlası geri alınabilir; veri eksikse tutar uydurulmaz', async () => {
    const no = await contract({ fxDifference: 'NOT_ALLOWED' });
    const kf1No = `KF${randomUUID().slice(0, 6).toUpperCase()}`;
    const kf1 = await invoice({ net: '42000.00', description: 'Kur farkı faturası', no: kf1No });
    await allocate(kf1, no, '42000.00'); await approve(kf1);

    const yes = await contract({ fxDifference: 'ALLOWED' });
    const usdNo = `USD${randomUUID().slice(0, 6).toUpperCase()}`;
    const usd = await invoice({ net: '10000.00', currency: 'USD', issueDate: '2026-09-01', no: usdNo });
    await allocate(usd, yes, '10000.00');
    expect((await paid(usd, '2026-10-01T10:00:00+03:00')).status).toBe(200);
    const kf2No = `KF${randomUUID().slice(0, 6).toUpperCase()}`;
    const kf2 = await invoice({ net: '50000.00', description: `${usdNo} nolu faturanın KUR FARKI`, no: kf2No });
    await allocate(kf2, yes, '50000.00'); await approve(kf2);

    await scan();
    expect(await caseFor(kf1No)).toMatchObject({ kind: 'FX_DIFF_NOT_ALLOWED', amount: '42000.00', status: 'OPEN', category: 'RECOVERABLE' });
    // Kur yokken hesaplanamaz: incelenmeli, tutar yok.
    expect(await caseFor(kf2No)).toMatchObject({ kind: 'FX_DIFF_UNVERIFIED', amount: null, category: 'REVIEW' });
    expect((await call('finance', 'POST', '/api/v1/fx-rates', { currency: 'USD', rateDate: '2026-09-01', rate: '38.000000', source: 'TCMB (sentetik)' })).status).toBe(201);
    // Ödeme günü hafta sonu ise önceki iş gününün kuru kullanılır (en fazla 7 gün geri).
    expect((await call('finance', 'POST', '/api/v1/fx-rates', { currency: 'USD', rateDate: '2026-09-30', rate: '41.500000', source: 'TCMB (sentetik)' })).status).toBe(201);
    expect((await call('finance', 'POST', '/api/v1/fx-rates', { currency: 'USD', rateDate: '2026-09-30', rate: '1', source: 'tekrar' })).status).toBe(409);
    expect((await call('buyer', 'POST', '/api/v1/fx-rates', { currency: 'USD', rateDate: '2026-09-02', rate: '1', source: 'yetkisiz' })).status).toBe(403);
    await scan();
    // 10.000 USD × (41,5 − 38) = 35.000 hak edilen; 50.000 faturalandı → 15.000 fazla. Aynı konu için ikinci vaka açılmaz.
    const c2 = await caseFor(kf2No);
    expect(c2).toMatchObject({ kind: 'FX_DIFF_EXCESS', amount: '15000.00', status: 'OPEN' });
    expect((await cases()).filter((c) => c.invoiceNo === kf2No)).toHaveLength(1);
    const d = (await call('legal', 'GET', `/api/v1/recovery/cases/${c2.id}`)).body;
    expect(d.basis).toMatchObject({ expected: '35000.00', rateAtIssue: '38', rateAtPayment: '41.5', paidAt: '2026-10-01' });
    expect(d.claimDraft).toContain('15.000,00 TRY');
    expect(d.claimDraft).toContain(d.code);
  });

  it('avans, erken ödeme ve teminat: kural koşulu yoksa bulgu yok, ayar yoksa erken ödeme hesaplanmaz', async () => {
    const cv = await contract({ paymentDays: 60 });
    const advNo = `AV${randomUUID().slice(0, 6).toUpperCase()}`;
    const adv = await invoice({ net: '200000.00', kind: 'ADVANCE', issueDate: '2026-06-01', no: advNo });
    await allocate(adv, cv, '200000.00'); await approve(adv);
    const late = await invoice({ net: '50000.00', issueDate: '2026-07-01' });
    await allocate(late, cv, '50000.00', { advanceOffset: '50000.00', advanceInvoiceId: adv }); await approve(late);

    const earlyNo = `EP${randomUUID().slice(0, 6).toUpperCase()}`;
    const early = await invoice({ net: '1000000.00', issueDate: '2026-09-01', no: earlyNo });
    await allocate(early, cv, '1000000.00'); await approve(early);
    await paid(early, '2026-09-10T15:00:00+03:00');

    const g = await call('finance', 'POST', `/api/v1/contract-versions/${cv}/guarantees`, { kind: 'PERFORMANCE', amount: '250000', currency: 'TRY', issuer: 'Örnek Bankası (sentetik)',
      referenceNo: `TM-${randomUUID().slice(0, 4)}`, validUntil: new Date(Date.now() + 10 * 86_400_000).toISOString().slice(0, 10) });
    expect(g.status, JSON.stringify(g.body)).toBe(201);

    await scan();
    // Avans: 200.000 − 50.000 mahsup = 150.000; son mahsup 2026-07-01 (60+ gün önce), avans 90+ gün açık.
    expect(await caseFor(advNo)).toMatchObject({ kind: 'ADVANCE_UNOFFSET', amount: '150000.00' });
    // Sermaye maliyeti girilmeden erken ödeme hesaplanmaz.
    expect(await caseFor(earlyNo)).toBeUndefined();
    expect((await call('buyer', 'PUT', '/api/v1/recovery/settings', { capitalCostRate: '45' })).status).toBe(403);
    expect((await call('finance', 'PUT', '/api/v1/recovery/settings', { capitalCostRate: '45' })).status).toBe(200);
    await scan();
    // Vade 2026-10-31, ödeme 2026-09-10 → 51 gün erken; 1.000.000 × %45 × 51 / 365 = 62.876,71
    expect(await caseFor(earlyNo)).toMatchObject({ kind: 'EARLY_PAYMENT', amount: '62876.71', category: 'AVOIDABLE' });
    // Dayanak sözleşmenin ödeme koşulunu gösterir; koşulların ortak kaynak maddesi (burada kur maddesi) vade dayanağı değildir.
    const ep = (await call('finance', 'GET', `/api/v1/recovery/cases/${(await caseFor(earlyNo)).id}`)).body;
    expect(ep.basis).toMatchObject({ paymentTerms: 'Fatura tarihinden itibaren', formula: '1.000.000,00 TRY × %45 × 51 / 365 = 62.876,71 TRY' });
    expect(ep.basis).not.toHaveProperty('sourceRef');
    const gc = (await cases()).find((c) => c.kind === 'GUARANTEE_EXPIRY' && c.guaranteeId === g.body.id);
    expect(gc).toMatchObject({ amount: '250000.00', category: 'RISK' });
    // Bulgular İşlerim'e görev olarak düşer (kayıt no ile).
    const tasks = (await call('buyer', 'GET', '/api/v1/tasks?view=all')).body.items as any[];
    const advCode = (await caseFor(advNo)).code;
    expect(tasks.find((t) => t.entityType === 'recovery_case' && t.refNo === advCode)).toBeTruthy();
  });

  it('vaka yaşam döngüsü: doğrula → talep → tahsil; yetki, durum ve tutar kuralları; kapanan vaka değişmez', async () => {
    const cv = await contract({ fxDifference: 'NOT_ALLOWED' });
    const no = `KF${randomUUID().slice(0, 6).toUpperCase()}`;
    const inv = await invoice({ net: '8000.00', description: 'kur farkı', no });
    await allocate(inv, cv, '8000.00'); await approve(inv);
    await scan();
    const c = await caseFor(no);
    const url = `/api/v1/recovery/cases/${c.id}`;
    expect((await call('supplier1', 'GET', url)).status).toBe(403);
    expect((await call('security', 'GET', '/api/v1/recovery/cases')).status).toBe(403);
    expect((await call('legal', 'POST', `${url}/confirm`)).status).toBe(403);
    expect((await call('buyer', 'POST', `${url}/claim`, { note: 'Talep yazısı gönderildi' })).status).toBe(409); // önce doğrulanmalı
    // Boş JSON gövdesi istemci hatasıdır (500 değil).
    expect((await h.call('buyer', 'POST', `${url}/confirm`, { headers: { 'content-type': 'application/json' } })).status).toBe(400);
    expect((await call('buyer', 'POST', `${url}/confirm`)).status).toBe(200);
    expect((await call('buyer', 'POST', `${url}/confirm`)).status).toBe(409);
    expect((await call('buyer', 'POST', `${url}/claim`, { note: 'Talep yazısı e-postayla gönderildi' })).status).toBe(200);
    // İşlemdeki (talep edilmiş) vaka taramada 'kapanmış' sayılmaz.
    const sc = await scan();
    expect(sc.inProgress).toBeGreaterThanOrEqual(1);
    expect(sc.found).toBe(sc.created + sc.updated + sc.inProgress + sc.closed);
    expect((await call('buyer', 'POST', `${url}/recover`, { amount: '8000.00', note: 'İade alındı' })).status).toBe(403); // tahsil kaydı yalnız finans
    expect((await call('finance', 'POST', `${url}/recover`, { amount: '8000.01', note: 'Fazla tutar' })).status).toBe(422);
    expect((await call('finance', 'POST', `${url}/recover`, { amount: '7500.00', note: 'Sonraki faturadan mahsup edildi' })).status).toBe(200);
    expect((await call('buyer', 'POST', `${url}/dismiss`, { reason: 'Kapalı vakayı yeniden açma denemesi' })).status).toBe(409);
    await expect(h.owner.query(`UPDATE recovery_cases SET amount = 1 WHERE id = $1`, [c.id])).rejects.toThrow(/immutable_record/);
    // Tarama tahsil edilmiş vakaya dokunmaz.
    await scan();
    expect(await caseFor(no)).toMatchObject({ status: 'RECOVERED', recoveredAmount: '7500.00' });
    const audit = (await h.owner.query(`SELECT action FROM audit_events WHERE entity_id = $1 ORDER BY at`, [c.id])).rows.map((r) => r.action);
    expect(audit).toEqual(['recovery.confirmed', 'recovery.claimed', 'recovery.recovered']);
    // İncelenmeli (tutarsız) vaka doğrulanamaz; gerekçeyle kapatılır.
    const cv2 = await contract({ fxDifference: null });
    const no2 = `KF${randomUUID().slice(0, 6).toUpperCase()}`;
    const inv2 = await invoice({ net: '100.00', description: 'Kur Farkı', no: no2 });
    await allocate(inv2, cv2, '100.00'); await approve(inv2);
    await scan();
    const r = await caseFor(no2);
    expect(r).toMatchObject({ kind: 'FX_DIFF_UNVERIFIED' });
    expect((await call('buyer', 'POST', `/api/v1/recovery/cases/${r.id}/confirm`)).body.error.code).toBe('not_verifiable');
    expect((await call('buyer', 'POST', `/api/v1/recovery/cases/${r.id}/dismiss`, { reason: 'kısa' })).status).toBe(400);
    expect((await call('buyer', 'POST', `/api/v1/recovery/cases/${r.id}/dismiss`, { reason: 'Sözleşme ekinde kur farkı açıkça kabul edilmiş; uygun.' })).status).toBe(200);
  });

  it('kanıt zinciri: sözleşmesiz ve kabulsüz harcama ayrılır; tutarlar para birimi başına; vaka özeti defterde', async () => {
    const from = '2026-01-01', to = '2026-12-31';
    const before = (await call('finance', 'GET', `/api/v1/ledger?from=${from}&to=${to}`)).body;
    const po = await call('buyer', 'POST', '/api/v1/purchase-orders', { companyId: h.world.companyA1.id, supplierId: h.world.suppliers.s1, contractVersionId: null, currency: 'TRY',
      lines: [{ kind: 'GOODS', description: 'Yedek parça (sentetik)', unit: 'adet', quantity: '2', unitPrice: '1000' }] });
    const line = (await call('buyer', 'GET', `/api/v1/purchase-orders/${po.body.id}`)).body.lines[0].poLineId as string;
    await call('buyer', 'POST', `/api/v1/po-lines/${line}/receipts`, { quantity: '2', note: 'Teslim alındı (sentetik)' });
    const no = `NC${randomUUID().slice(0, 6).toUpperCase()}`;
    const inv = await invoice({ net: '2000.00', no, qty: '2', price: '1000' });
    await call('finance', 'PUT', `/api/v1/invoices/${inv}/allocations`, { allocations: [{ lineNo: 1, poLineId: line, contractVersionId: null, quantity: '2', amount: '2000.00' }] });
    await approve(inv);
    const after = (await call('auditor', 'GET', `/api/v1/ledger?from=${from}&to=${to}`)).body;
    expect(after.evidence.invoiceCount).toBe(before.evidence.invoiceCount + 1);
    const row = after.evidence.topUnevidenced.find((x: any) => x.no === no);
    expect(row).toMatchObject({ gaps: ['NO_CONTRACT'], net: '2000.00', currency: 'TRY' });
    expect(Number(after.evidence.unevidenced.TRY) - Number(before.evidence.unevidenced.TRY ?? 0)).toBe(2000);
    expect(after.recovery.recovered.TRY).toBe('7500.00');
    // Kısmi tahsilde alınamayan 500 TL kaybolmaz; ayrı görünür.
    expect(after.recovery.shortfall).toEqual({ TRY: '500.00' });
    expect(after.recovery.avoidable.TRY).toBe('62876.71');
    expect(after.settings).toMatchObject({ capitalCostRate: '45' });
    expect(after.can).toEqual({ scan: false, manage: false, settle: false, settings: false }); // denetçi salt okur
    expect((await call('auditor', 'POST', '/api/v1/recovery/scan')).status).toBe(403);
    expect((await call('supplier1', 'GET', `/api/v1/ledger?from=${from}&to=${to}`)).status).toBe(403);
    expect((await call('finance', 'GET', `/api/v1/ledger?from=${to}&to=${from}`)).status).toBe(422);
  });

  it('inceleme bulguları: yalnız kur farkı satırı sayılır; birden çok döviz fatura toplanır; iade düşülür; ele alınan teminat riskten çıkar', async () => {
    // Karışık fatura: 100.000 malzeme + 2.000 kur farkı; izinsiz sözleşmede yalnız 2.000 geri alınabilir.
    const no = await contract({ fxDifference: 'NOT_ALLOWED' });
    const mixNo = `MX${randomUUID().slice(0, 6).toUpperCase()}`;
    const mix = await invoice({ net: '102000.00', no: mixNo, lines: [{ description: 'Malzeme bedeli', net: '100000.00' }, { description: 'Kur farkı', net: '2000.00' }] });
    await call('finance', 'PUT', `/api/v1/invoices/${mix}/allocations`, { allocations: [
      { lineNo: 1, poLineId: null, contractVersionId: no, quantity: '1', amount: '100000.00' }, { lineNo: 2, poLineId: null, contractVersionId: no, quantity: '1', amount: '2000.00' }] });
    await approve(mix);
    // Tedarikçi kur farkını iade faturasıyla geri verirse bulgu kendiliğinden çözülür.
    const reNo = `KF${randomUUID().slice(0, 6).toUpperCase()}`;
    const re = await invoice({ net: '3000.00', description: 'Kur farkı', no: reNo });
    await allocate(re, no, '3000.00'); await approve(re);
    await scan();
    expect(await caseFor(mixNo)).toMatchObject({ kind: 'FX_DIFF_NOT_ALLOWED', amount: '2000.00' });
    expect(await caseFor(reNo)).toMatchObject({ amount: '3000.00', status: 'OPEN' });
    const cn = await invoice({ net: '3000.00', kind: 'CREDIT_NOTE', description: 'Kur farkı iadesi', originalInvoiceId: re });
    await allocate(cn, no, '3000.00'); await approve(cn);
    await scan();
    expect(await caseFor(reNo)).toMatchObject({ status: 'OBSOLETE' });

    // Bir kur farkı faturası iki döviz faturaya ait: hak edilen farklar toplanır.
    const yes = await contract({ fxDifference: 'ALLOWED' });
    const nos = [`EUA${randomUUID().slice(0, 6).toUpperCase()}`, `EUB${randomUUID().slice(0, 6).toUpperCase()}`];
    for (const [n, net] of [[nos[0]!, '1000.00'], [nos[1]!, '2000.00']] as const) {
      const e = await invoice({ net, currency: 'EUR', issueDate: '2026-08-10', no: n });
      await allocate(e, yes, net);
      await paid(e, '2026-08-20T10:00:00+03:00');
    }
    await call('finance', 'POST', '/api/v1/fx-rates', { currency: 'EUR', rateDate: '2026-08-10', rate: '45.000000', source: 'TCMB (sentetik)' });
    await call('finance', 'POST', '/api/v1/fx-rates', { currency: 'EUR', rateDate: '2026-08-20', rate: '46.000000', source: 'TCMB (sentetik)' });
    const kfNo = `KF${randomUUID().slice(0, 6).toUpperCase()}`;
    const kf = await invoice({ net: '3500.00', description: `${nos[0]} ve ${nos[1]} nolu faturaların kur farkı`, no: kfNo });
    await allocate(kf, yes, '3500.00'); await approve(kf);
    await scan();
    // (1.000 + 2.000) × 1 = 3.000 hak edilen; 500 fazla (yalnız ilk fatura eşleşseydi 2.500 fazla görünürdü).
    expect(await caseFor(kfNo)).toMatchObject({ kind: 'FX_DIFF_EXCESS', amount: '500.00' });

    // e-Fatura'da açıklama numara içermese de BillingReference ile döviz faturaya bağlanır (D81); bağın kaynağı dayanakta.
    const gbpNo = `GBP${randomUUID().slice(0, 6).toUpperCase()}`;
    const gbp = await invoice({ net: '1000.00', currency: 'GBP', issueDate: '2026-07-01', no: gbpNo });
    await allocate(gbp, yes, '1000.00');
    await paid(gbp, '2026-07-15T10:00:00+03:00');
    await call('finance', 'POST', '/api/v1/fx-rates', { currency: 'GBP', rateDate: '2026-07-01', rate: '50.000000', source: 'TCMB (sentetik)' });
    await call('finance', 'POST', '/api/v1/fx-rates', { currency: 'GBP', rateDate: '2026-07-15', rate: '51.000000', source: 'TCMB (sentetik)' });
    const sellerVkn = (await h.owner.query<{ tax_id: string }>(`SELECT tax_id FROM suppliers WHERE id = $1`, [h.world.suppliers.s1])).rows[0]!.tax_id;
    const ublNo = `KFU2026${String(Date.now()).slice(-9)}`;
    const up = await h.upload('finance', { name: `kf-${ublNo}.xml`, mime: 'application/xml', data: ublInvoiceXml({ invoiceNo: ublNo, ettn: randomUUID(), sellerVkn,
      sellerName: 'Anadolu Bilişim (SENTETİK)', buyerVkn: h.world.companyA1.vkn, buyerName: h.world.companyA1.name, typeCode: 'SATIS', billingRef: gbpNo,
      lines: [{ name: 'Kur farkı', qty: '1', unitCode: 'C62', price: '1500.00', net: '1500.00', rate: '20', tax: '300.00' }], taxTotal: '300.00', amount: '1800.00' }) },
      { companyId: h.world.companyA1.id, kind: 'INVOICE', title: 'Kur farkı e-Fatura (SENTETİK)' });
    expect(up.body.invoice, JSON.stringify(up.body)).toMatchObject({ created: true });
    expect(up.body.ublCheck.findings.map((f: any) => f.rule)).not.toContain('RETURN_REFERENCE');
    await allocate(up.body.invoice.invoiceId, yes, '1500.00'); await approve(up.body.invoice.invoiceId);
    await scan();
    // 1.000 GBP × (51 − 50) = 1.000 hak edilen; 1.500 faturalanmış → 500 fazla.
    const uc = await caseFor(ublNo);
    expect(uc).toMatchObject({ kind: 'FX_DIFF_EXCESS', amount: '500.00' });
    expect((await call('finance', 'GET', `/api/v1/recovery/cases/${uc.id}`)).body.basis).toMatchObject({ originalNo: gbpNo, originalLink: 'e-Fatura belge referansı (BillingReference)' });
    // Açıklamadan bağlanan eski yol aynen çalışır ve kaynağı söyler.
    expect((await call('finance', 'GET', `/api/v1/recovery/cases/${(await caseFor(kfNo)).id}`)).body.basis.originalLink).toBe('Fatura satır açıklaması');

    // Teminat ele alındı (doğrulandı) → risk toplamından çıkar; uzatılınca (yeni bitiş uzak) vaka kendiliğinden çözülür.
    const gcv = await contract({});
    const before = (await call('finance', 'GET', '/api/v1/ledger?from=2026-01-01&to=2026-12-31')).body.recovery.atRisk.TRY ?? '0';
    const g = await call('finance', 'POST', `/api/v1/contract-versions/${gcv}/guarantees`, { kind: 'PERFORMANCE', amount: '70000', currency: 'TRY', issuer: 'Örnek Bankası (sentetik)',
      referenceNo: `TM-${randomUUID().slice(0, 4)}`, validUntil: new Date(Date.now() + 5 * 86_400_000).toISOString().slice(0, 10) });
    await scan();
    const gc = (await cases()).find((c) => c.guaranteeId === g.body.id);
    expect(Number((await call('finance', 'GET', '/api/v1/ledger?from=2026-01-01&to=2026-12-31')).body.recovery.atRisk.TRY) - Number(before)).toBe(70000);
    expect((await call('finance', 'POST', `/api/v1/recovery/cases/${gc.id}/confirm`)).status).toBe(200);
    expect(Number((await call('finance', 'GET', '/api/v1/ledger?from=2026-01-01&to=2026-12-31')).body.recovery.atRisk.TRY ?? 0)).toBe(Number(before));
    await h.owner.query(`UPDATE contract_guarantees SET valid_until = valid_until + 365 WHERE id = $1`, [g.body.id]);
    await scan();
    expect((await cases()).find((c) => c.id === gc.id)).toMatchObject({ status: 'OBSOLETE' });
  });
});
