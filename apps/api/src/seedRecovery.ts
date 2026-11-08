// Lira Defteri sentetik demo verisi (D80): kur farkı (izinsiz ve fazla), mahsup edilmemiş avans, vadeden önce ödeme, biten teminat.
// Var olan demo kiracısını silmez; yalnız eksikse ekler. Aynı API yolunu kullanır. Tüm tutarlar ve belgeler SENTETİK.
import type pg from 'pg';
import { randomUUID } from 'node:crypto';
import type { DevAuthProvider } from './auth.ts';
import type { App } from './server.ts';
import { syntheticPdf } from './devdata.ts';

const MARK = 'EGEKF2026000031';

export async function ensureRecoveryDemo(owner: pg.Pool, app: App, auth: DevAuthProvider, tenantId: string, log = console.log) {
  if ((await owner.query(`SELECT 1 FROM invoices WHERE tenant_id = $1 AND invoice_no = $2`, [tenantId, MARK])).rowCount) { log('Lira Defteri demo zaten var; atlandı.'); return; }
  const company = (await owner.query<{ id: string; name: string }>(`SELECT le.id, le.name FROM legal_entities le JOIN contract_families f ON f.company_id = le.id
    WHERE le.tenant_id = $1 AND f.title LIKE 'Yıllık Bakım%' LIMIT 1`, [tenantId])).rows[0];
  const sup = async (name: string) => (await owner.query<{ id: string }>(`SELECT id FROM suppliers WHERE tenant_id = $1 AND legal_name LIKE $2 AND status = 'ACTIVE'`, [tenantId, `${name}%`])).rows[0]?.id;
  const [s1, s2] = [await sup('Anadolu Bilişim'), await sup('Ege Sistem')];
  if (!company || !s1 || !s2) { log('Lira Defteri demo: şirket veya aktif tedarikçi yok; atlandı.'); return; }

  const tok = async (key: string) => auth.issue(`dev|${key}@example.test`);
  async function call(who: string, method: string, url: string, body?: unknown, headers: Record<string, string> = {}) {
    const r = await app.inject({ method: method as any, url, payload: body as any, headers: { authorization: `Bearer ${await tok(who)}`, 'x-tenant-id': tenantId, ...headers } });
    if (r.statusCode >= 400) throw new Error(`${method} ${url} → ${r.statusCode} ${r.body}`);
    return r.body ? JSON.parse(r.body) : null;
  }
  async function upload(title: string) {
    const b = `----sp${randomUUID()}`;
    const payload = Buffer.concat([
      Buffer.from(`--${b}\r\nContent-Disposition: form-data; name="companyId"\r\n\r\n${company!.id}\r\n--${b}\r\nContent-Disposition: form-data; name="kind"\r\n\r\nCONTRACT\r\n`),
      Buffer.from(`--${b}\r\nContent-Disposition: form-data; name="title"\r\n\r\n${title}\r\n`),
      Buffer.from(`--${b}\r\nContent-Disposition: form-data; name="file"; filename="sozlesme.pdf"\r\nContent-Type: application/pdf\r\n\r\n`),
      syntheticPdf([[`SENTETIK SOZLESME ${randomUUID().slice(0, 8)}`, title.normalize('NFD').replace(/[^\x20-\x7e]/g, '')]]), Buffer.from(`\r\n--${b}--\r\n`),
    ]);
    const r = await app.inject({ method: 'POST', url: '/api/v1/documents', payload,
      headers: { authorization: `Bearer ${await tok('leyla.hukuk')}`, 'x-tenant-id': tenantId, 'content-type': `multipart/form-data; boundary=${b}` } });
    if (r.statusCode >= 400) throw new Error(`upload → ${r.statusCode} ${r.body}`);
    return JSON.parse(r.body).documentVersionId as string;
  }
  async function contract(title: string, supplierId: string, terms: { paymentDays: number; fxDifference: 'ALLOWED' | 'NOT_ALLOWED'; sourceRef: string }) {
    const c = await call('leyla.hukuk', 'POST', '/api/v1/contracts', { title, documentVersionId: await upload(title), stage: 'EXECUTION', signatureMethod: 'NOT_REQUIRED',
      originalCustodyRequired: false, parties: [{ role: 'BUYER', displayName: company!.name, legalEntityId: company!.id }], supplierId });
    const cv = c.contractVersionId as string;
    const t = await call('leyla.hukuk', 'POST', `/api/v1/contract-versions/${cv}/terms`, { currency: 'TRY', valueType: 'CEILING', amount: '20000000.00',
      paymentTerms: `Fatura tarihinden itibaren ${terms.paymentDays} gün`, startDate: '2026-01-01', endDate: '2027-12-31', autoRenewal: false, renewalMonths: null,
      noticeAmount: null, noticeUnit: null, nonWorkingDay: 'AS_IS', sourceRef: terms.sourceRef, paymentDays: terms.paymentDays, fxDifference: terms.fxDifference });
    await call('kerem.hukuk', 'POST', `/api/v1/contract-terms/${t.id}/verify`);
    return cv;
  }
  async function invoice(o: { supplierId: string; no: string; net: string; issueDate: string; description: string; currency?: string; kind?: string }) {
    return (await call('ferda.finans', 'POST', '/api/v1/invoices', { companyId: company!.id, supplierId: o.supplierId, kind: o.kind ?? 'INVOICE', invoiceNo: o.no, issueDate: o.issueDate,
      currency: o.currency ?? 'TRY', lines: [{ description: o.description, quantity: '1', unit: 'adet', unitPrice: o.net, netAmount: o.net, taxRate: '20' }] })).id as string;
  }
  const allocate = (id: string, cv: string, amount: string, extra: Record<string, unknown> = {}) =>
    call('ferda.finans', 'PUT', `/api/v1/invoices/${id}/allocations`, { allocations: [{ lineNo: 1, poLineId: null, contractVersionId: cv, quantity: '1', amount }], ...extra });
  const approve = async (id: string) => {
    const d = await call('nur.finansonay', 'GET', `/api/v1/invoices/${id}`);
    await call('nur.finansonay', 'POST', `/api/v1/invoices/${id}/approve`, undefined, { 'if-match': d.checkFingerprint });
  };
  const paid = (id: string, at: string) => call('ferda.finans', 'POST', '/api/v1/integration/erp/status-events', { events: [{ eventId: `demo-pay-${id}`, invoiceId: id, status: 'PAID', at }] });

  // 1) Ege: veri merkezi bakımı, kur farkı uygulanmaz (Madde 9.2). Kur farkı faturası yine de kesilmiş.
  const ege = await contract('Veri Merkezi Bakım Sözleşmesi (SENTETİK)', s2, { paymentDays: 45, fxDifference: 'NOT_ALLOWED', sourceRef: 'Madde 9.2 Fiyatlar TL ve sabittir (sentetik)' });
  const k1 = await invoice({ supplierId: s2, no: MARK, net: '186400.00', issueDate: '2026-09-18', description: 'Ağustos bakım bedeli kur farkı' });
  await allocate(k1, ege, '186400.00'); await approve(k1);

  // 2) Anadolu: lisans, USD fatura + izinli kur farkı (Madde 6.4); faturalanan fark kurla hesaplanandan fazla.
  const anb = await contract('Yazılım Lisans ve Destek Sözleşmesi (SENTETİK)', s1, { paymentDays: 60, fxDifference: 'ALLOWED', sourceRef: 'Madde 6.4 Kur farkı fatura ve ödeme günü TCMB döviz satış kuru (sentetik)' });
  const usd = await invoice({ supplierId: s1, no: 'ANBUSD2026000044', net: '24000.00', issueDate: '2026-08-03', description: 'Yıllık lisans yenileme', currency: 'USD' });
  await allocate(usd, anb, '24000.00');
  await paid(usd, '2026-09-02T11:00:00+03:00');
  for (const [d, r] of [['2026-08-03', '40.912300'], ['2026-09-02', '41.635800']] as const) {
    await call('ferda.finans', 'POST', '/api/v1/fx-rates', { currency: 'USD', rateDate: d, rate: r, source: 'TCMB döviz satış (sentetik değer)' });
  }
  const k2 = await invoice({ supplierId: s1, no: 'ANBKF2026000052', net: '29850.00', issueDate: '2026-09-10', description: 'ANBUSD2026000044 nolu fatura kur farkı' });
  await allocate(k2, anb, '29850.00'); await approve(k2);

  // 3) Anadolu: avans; bir kez mahsup edildi, kalan bakiye unutuldu.
  const adv = await invoice({ supplierId: s1, no: 'ANBAV2026000007', net: '300000.00', issueDate: '2026-04-15', description: 'Proje başlangıç avansı', kind: 'ADVANCE' });
  await allocate(adv, anb, '300000.00'); await approve(adv);
  const off = await invoice({ supplierId: s1, no: 'ANB2026000061', net: '120000.00', issueDate: '2026-06-20', description: 'Kurulum hizmeti 1. hakediş' });
  await allocate(off, anb, '120000.00', { advanceOffset: '120000.00', advanceInvoiceId: adv }); await approve(off);

  // 4) Ege: 45 gün vadeli fatura 6 günde ödenmiş.
  const early = await invoice({ supplierId: s2, no: 'EGE2026000912', net: '2450000.00', issueDate: '2026-10-01', description: 'Donanım yenileme' });
  await allocate(early, ege, '2450000.00'); await approve(early);
  await paid(early, '2026-10-07T16:30:00+03:00');
  await call('ferda.finans', 'PUT', '/api/v1/recovery/settings', { capitalCostRate: '42' });

  // 5) Ege: performans teminatı sözleşme bitmeden doluyor.
  const until = new Date(Date.now() + 12 * 86_400_000).toISOString().slice(0, 10);
  await call('ferda.finans', 'POST', `/api/v1/contract-versions/${ege}/guarantees`, { kind: 'PERFORMANCE', amount: '500000', currency: 'TRY', issuer: 'Örnek Katılım Bankası (SENTETİK)',
    referenceNo: 'TM-2026-0318', validUntil: until });

  const s = await call('alper.satinalma', 'POST', '/api/v1/recovery/scan');
  log(`Lira Defteri demo: 2 sözleşme, 7 fatura, kur tablosu, teminat; tarama ${s.found} bulgu (${s.created} yeni).`);
}
