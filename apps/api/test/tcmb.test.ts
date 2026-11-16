import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { makeHarness } from './harness.ts';
import { withTenant } from '../src/db.ts';
import { ublInvoiceXml } from '../src/devdata.ts';
import { fetchTcmbBulletin, importTcmbRates, parseTcmbBulletin } from '../src/modules/tcmb.ts';

let h: Awaited<ReturnType<typeof makeHarness>>;
beforeAll(async () => { h = await makeHarness(); });
afterAll(async () => { await h.close(); });

// Biçim 2026-11-09 tarihli gerçek TCMB bülteninden; değerler sentetik.
const xml = `<?xml version="1.0" encoding="UTF-8"?><?xml-stylesheet type="text/xsl" href="isokur.xsl"?>
<Tarih_Date Tarih="09.11.2026" Date="11/09/2026" Bulten_No="2026/210">
<Currency Kod="USD" CurrencyCode="USD"><Unit>1</Unit><ForexBuying>50.0878</ForexBuying><ForexSelling>50.1780</ForexSelling></Currency>
<Currency Kod="JPY" CurrencyCode="JPY"><Unit>100</Unit><ForexSelling>33.5000</ForexSelling></Currency>
<Currency Kod="XDR" CurrencyCode="XDR"><Unit>1</Unit><ForexSelling></ForexSelling></Currency>
</Tarih_Date>`;
const fake = (status: number, body = xml) => (async () => new Response(body, { status })) as unknown as typeof fetch;

describe('TCMB kur alma (D92)', () => {
  it('bülteni okur, birime böler, satış kuru olmayanı atlar', () => {
    expect(parseTcmbBulletin(xml)).toEqual({ rateDate: '2026-11-09', bulletin: '2026/210', rates: [{ currency: 'USD', rate: '50.178000' }, { currency: 'JPY', rate: '0.335000' }] });
  });
  it('tarihli adresi doğru kurar; 404 tatil mesajı, ağ hatası 502, tarih uyuşmazlığı hata', async () => {
    let url = '';
    await fetchTcmbBulletin('2026-11-09', (async (u: string) => { url = u; return new Response(xml); }) as unknown as typeof fetch);
    expect(url).toBe('https://www.tcmb.gov.tr/kurlar/202611/09112026.xml');
    await expect(fetchTcmbBulletin('2026-11-08', fake(404))).rejects.toMatchObject({ code: 'tcmb_no_bulletin' });
    await expect(fetchTcmbBulletin(undefined, (async () => { throw new Error('ağ'); }) as unknown as typeof fetch)).rejects.toMatchObject({ code: 'tcmb_unavailable', status: 502 });
    await expect(fetchTcmbBulletin('2026-11-10', fake(200))).rejects.toMatchObject({ code: 'tcmb_invalid' });
    await expect(fetchTcmbBulletin(undefined, fake(200, '<x/>'))).rejects.toMatchObject({ code: 'tcmb_invalid' });
  });
  it('mevcut kurun üstüne yazmaz, kullanılmayan dövizi almaz, denetim izi bırakır', async () => {
    const ctx = { tenantId: h.world.tenantA, userId: h.world.users.finance.id, roles: ['FINANCE'], companyIds: [h.world.companyA1.id], departmentIds: [], allDepartments: true, correlationId: 'd92' };
    const date = `20${String(30 + Math.floor(Math.random() * 60))}-0${1 + Math.floor(Math.random() * 9)}-15`;
    const b = { rateDate: date, bulletin: 'T', rates: [{ currency: 'USD', rate: '50.000000' }, { currency: 'ZZZ', rate: '1.000000' }] };
    const first = await withTenant(h.pool, ctx as never, (tx) => importTcmbRates(tx, ctx as never, b));
    expect(first).toMatchObject({ imported: ['USD'], skipped: [] });
    const again = await withTenant(h.pool, ctx as never, (tx) => importTcmbRates(tx, ctx as never, { ...b, rates: [{ currency: 'USD', rate: '99.000000' }] }));
    expect(again).toMatchObject({ imported: [], skipped: ['USD'] });
    expect((await h.owner.query<{ r: string }>(`SELECT trim_scale(rate)::text AS r FROM fx_rates WHERE tenant_id = $1 AND currency = 'USD' AND rate_date = $2`, [h.world.tenantA, date])).rows[0]!.r).toBe('50');
    expect((await h.owner.query(`SELECT 1 FROM audit_events WHERE action = 'fx_rate.imported' AND data->>'rateDate' = $1`, [date])).rowCount).toBe(1);
  });
  it('yetkisiz kullanıcı alamaz', async () => {
    expect((await h.call('buyer', 'POST', '/api/v1/fx-rates/tcmb', { body: {} })).status).toBe(403);
  });
  it.runIf(process.env.TCMB_LIVE)('canlı TCMB bülteni uç noktadan alınır', async () => {
    const r = await h.call('finance', 'POST', '/api/v1/fx-rates/tcmb', { body: {} });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect([...r.body.imported, ...r.body.skipped]).toContain('USD');
  });
});

describe('ana veri görevi açılabilir kayda gider (D92)', () => {
  it('aday tedarikçi görevi tedarikçi kaydına bağlıdır', async () => {
    const legalName = `Görev Adayı ${randomUUID().slice(0, 6)} (SENTETİK)`;
    const up = await h.upload('buyer', { name: 'f.xml', mime: 'application/xml', data: Buffer.from(ublInvoiceXml({ sellerVkn: null, sellerName: legalName } as never)) }, { companyId: h.world.companyA1.id, kind: 'INVOICE', title: 'Fatura (sentetik)' });
    const supplierId = up.body.supplier.supplierId as string;
    const inv = await h.call('finance', 'POST', '/api/v1/invoices', { body: { companyId: h.world.companyA1.id, supplierId, kind: 'INVOICE', invoiceNo: `GRV${randomUUID().slice(0, 8)}`, issueDate: '2026-10-20', currency: 'TRY',
      lines: [{ description: 'Parça', quantity: '1', unit: 'adet', unitPrice: '100', netAmount: '100.00' }] } });
    expect(inv.status).toBe(201);
    await h.call('finance', 'GET', `/api/v1/invoices/${inv.body.id}`);
    const tasks = (await h.call('masterData', 'GET', '/api/v1/tasks?view=mine')).body.items as { entityType: string; entityId: string; reason: string }[];
    const t = tasks.find((x) => x.reason.includes('BR02') && x.entityId === supplierId);
    expect(t).toMatchObject({ entityType: 'supplier' });
  });

  const candidateInvoice = async () => {
    const legalName = `Görev Adayı ${randomUUID().slice(0, 6)} (SENTETİK)`;
    const up = await h.upload('buyer', { name: 'f.xml', mime: 'application/xml', data: Buffer.from(ublInvoiceXml({ sellerVkn: null, sellerName: legalName } as never)) }, { companyId: h.world.companyA1.id, kind: 'INVOICE', title: 'Fatura (sentetik)' });
    const supplierId = up.body.supplier.supplierId as string;
    const inv = await h.call('finance', 'POST', '/api/v1/invoices', { body: { companyId: h.world.companyA1.id, supplierId, kind: 'INVOICE', invoiceNo: `GRV${randomUUID().slice(0, 8)}`, issueDate: '2026-10-20', currency: 'TRY',
      lines: [{ description: 'Parça', quantity: '1', unit: 'adet', unitPrice: '100', netAmount: '100.00' }] } });
    expect(inv.status).toBe(201);
    await h.call('finance', 'GET', `/api/v1/invoices/${inv.body.id}`);
    return { supplierId, invoiceId: inv.body.id as string };
  };
  const openTaskFor = async (supplierId: string) => ((await h.call('masterData', 'GET', '/api/v1/tasks?view=mine')).body.items as { entityId: string; reason: string }[]).some((x) => x.reason.includes('BR02') && x.entityId === supplierId);

  it('fatura reddedilince görev kapanır', async () => {
    const { supplierId, invoiceId } = await candidateInvoice();
    expect(await openTaskFor(supplierId)).toBe(true);
    expect((await h.call('finance2', 'POST', `/api/v1/invoices/${invoiceId}/reject`, { body: { reason: 'Aday tedarikçi (sentetik)' } })).status).toBe(200);
    expect(await openTaskFor(supplierId)).toBe(false);
  });

  it('tedarikçi birleşince görev kapanır ve fatura görüntülenince yeniden açılmaz', async () => {
    const { supplierId, invoiceId } = await candidateInvoice();
    const vkn = (await h.owner.query<{ tax_id: string }>(`SELECT tax_id FROM suppliers WHERE id = $1`, [h.world.suppliers.s1])).rows[0]!.tax_id;
    const before = await h.call('masterData', 'GET', `/api/v1/suppliers/${supplierId}`);
    expect((await h.call('masterData', 'POST', `/api/v1/suppliers/${supplierId}/identity`, { body: { country: 'TR', taxIdType: 'VKN', taxId: vkn, rationale: 'Kaynak belgede doğrulandı (sentetik)', expectedRowVersion: before.body.rowVersion } })).status).toBe(200);
    expect(await openTaskFor(supplierId)).toBe(false);
    await h.call('finance', 'GET', `/api/v1/invoices/${invoiceId}`);
    expect(await openTaskFor(supplierId)).toBe(false);
  });
});
