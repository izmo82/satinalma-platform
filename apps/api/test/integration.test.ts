// v2 Faz 1 (D93/D95): fatura onayı kaldırıldı; mutabakat korunur, onaylı fatura test verisi olarak modül işleviyle (API ucu değil) oluşur; yetkisiz rol örneği bölüm kullanıcısı
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { syntheticPdf } from '../src/devdata.ts';
import { withTenant, type TenantContext } from '../src/db.ts';
import { approveInvoice } from '../src/modules/invoices.ts';
import { parseCsv } from '../src/modules/integration.ts';
import { makeHarness } from './harness.ts';

// Faz 7: ERP mutabakatı. Bu ortamda ERP bağdaştırıcısı YOK (gerçek kurulumdaki gibi): onaylar "yapılandırılmadı" olur,
// CSV ile aktarılır ve ERP'den dönen sonuç dosyası satır satır eşlenir.
let h: Awaited<ReturnType<typeof makeHarness>>;
beforeAll(async () => { h = await makeHarness({ erpAdapter: null }); });
afterAll(async () => { await h.close(); });

// Dönem filtresi İstanbul iş günüdür (UTC değil): gece yarısından sonra UTC tarihi bir gün geride kalır.
const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Istanbul' }).format(new Date());
const q = `from=${today}&to=${today}`;

async function approvedInvoice(net: string) {
  const up = await h.upload('legal', { name: 's.pdf', mime: 'application/pdf', data: syntheticPdf([[`SENTETIK ${randomUUID()}`]]) },
    { companyId: h.world.companyA1.id, kind: 'CONTRACT', title: 'Hizmet Sözleşmesi (SENTETİK)' });
  const c = await h.call('legal', 'POST', '/api/v1/contracts', { body: { title: `Hizmet ${randomUUID().slice(0, 4)} (SENTETİK)`, documentVersionId: up.body.documentVersionId,
    stage: 'EXECUTION', signatureMethod: 'NOT_REQUIRED', originalCustodyRequired: false,
    parties: [{ role: 'BUYER', displayName: h.world.companyA1.name, legalEntityId: h.world.companyA1.id }], supplierId: h.world.suppliers.s1 } });
  const cv = c.body.contractVersionId as string;
  const no = `ERP${randomUUID().slice(0, 8)}`;
  const inv = await h.call('finance', 'POST', '/api/v1/invoices', { body: { companyId: h.world.companyA1.id, supplierId: h.world.suppliers.s1, kind: 'INVOICE', invoiceNo: no,
    issueDate: today, currency: 'TRY', lines: [{ description: 'Hizmet', quantity: '1', unit: 'ay', unitPrice: net, netAmount: net }] } });
  expect(inv.status).toBe(201);
  await h.call('finance', 'PUT', `/api/v1/invoices/${inv.body.id}/allocations`, { body: { allocations: [{ lineNo: 1, poLineId: null, contractVersionId: cv, quantity: '1', amount: net }] } });
  // v2 (D93): fatura onayı ucu kaldırıldı. Mutabakat eski (v1) onaylı faturalar için korunur; onaylı durum test verisi olarak modül
  // işleviyle yazılır (karar, ERP aktarım kaydı aynen v1'deki gibi). Ürün davranışı değildir.
  const ctx: TenantContext = { tenantId: h.world.tenantA, userId: h.world.users.finance2.id, roles: ['PROCUREMENT'], companyIds: [h.world.companyA1.id],
    departmentIds: [], allDepartments: true, correlationId: 'v2-legacy-approval' };
  await withTenant(h.pool, ctx, (tx) => approveInvoice(tx, ctx, inv.body.id, null));
  return { id: inv.body.id as string, no, key: `erp-invoice-${inv.body.id}` };
}

describe('ERP mutabakatı', () => {
  it('bağdaştırıcı yokken onaylı faturalar "yapılandırılmadı" görünür; tekrar gönderim değil CSV yolu önerilir', async () => {
    const a = await approvedInvoice('1200.50');
    const r = await h.call('finance', 'GET', `/api/v1/integration/erp/reconciliation?${q}`);
    expect(r.status).toBe(200);
    expect(r.body.adapterConfigured).toBe(false);
    expect(r.body.attention.find((x: any) => x.invoiceId === a.id)).toMatchObject({ status: 'NOT_CONFIGURED', payable: '1200.50' });
    expect(r.body.byStatus.find((x: any) => x.status === 'NOT_CONFIGURED').n).toBeGreaterThan(0);
    const rp = await h.call('finance', 'POST', `/api/v1/integration/erp/exports/${a.id}/replay`, { body: { reason: 'Bağlantı hatası sonrası tekrar (sentetik).' } });
    expect(rp.status).toBe(409);
    expect(rp.body.error.code).toBe('erp_not_configured');
    // v2: satınalmacı (Satınalma) mutabakatı görür; yetkisiz rol bölüm kullanıcısıdır.
    expect((await h.call('buyer', 'GET', `/api/v1/integration/erp/reconciliation?${q}`)).status).toBe(200);
    expect((await h.call('techEval', 'GET', `/api/v1/integration/erp/reconciliation?${q}`)).status).toBe(403);
    expect((await h.call('auditor', 'GET', `/api/v1/integration/erp/reconciliation?${q}`)).status).toBe(200);
  });

  it('CSV aktarım dosyası formül kaçışlı; sonuç dosyası önce denenir, sonra yalnız tutan satırlar onaylanır', async () => {
    const a = await approvedInvoice('1000.00');
    const b = await approvedInvoice('250.25');
    const c = await approvedInvoice('99.90');
    const out = await h.call('finance', 'GET', `/api/v1/integration/erp/batch.csv?${q}`);
    expect(out.status).toBe(200);
    expect(out.headers['content-type']).toContain('text/csv');
    const table = parseCsv(out.raw.toString('utf8'));
    expect(table[0]).toEqual(['aktarim_anahtari', 'fatura_no', 'fatura_tarihi', 'tedarikci_vkn', 'tedarikci', 'sirket', 'para_birimi', 'net', 'odenecek', 'siparis', 'sozlesme', 'onay_tarihi']);
    const rowA = table.find((r) => r[0] === a.key)!;
    expect(rowA[1]).toBe(a.no);
    expect(rowA[8]).toBe('1000.00');
    expect((await h.call('auditor', 'GET', `/api/v1/integration/erp/batch.csv?${q}`)).status).toBe(403);

    const result = ['aktarim_anahtari;erp_kimligi;durum;odenecek;mesaj',
      `${a.key};MUH-1;OK;1000,00;`,
      `${b.key};MUH-2;OK;250.00;`,            // tutar farkı
      `${c.key};;ERROR;99.90;"Cari kart bulunamadı; açılmalı"`,
      `${a.key};MUH-1;OK;1000.00;`,           // mükerrer satır
      'yok-boyle-anahtar;MUH-9;OK;5.00;'].join('\r\n');
    const dry = await h.call('finance', 'POST', '/api/v1/integration/erp/results', { body: { csv: result, dryRun: true } });
    expect(dry.status).toBe(200);
    expect(dry.body.rows.map((x: any) => x.outcome)).toEqual(['MATCHED', 'AMOUNT_MISMATCH', 'ERP_REJECTED', 'DUPLICATE_ROW', 'UNKNOWN_KEY']);
    expect(dry.body.rows[2].detail).toBe('Cari kart bulunamadı; açılmalı');
    expect(dry.body.matchedTotal).toBe('1000.00');
    // Deneme hiçbir şeyi değiştirmez.
    let rec = await h.call('finance', 'GET', `/api/v1/integration/erp/reconciliation?${q}`);
    expect(rec.body.attention.find((x: any) => x.invoiceId === a.id).status).toBe('NOT_CONFIGURED');

    const apply = await h.call('finance', 'POST', '/api/v1/integration/erp/results', { body: { csv: result, dryRun: false } });
    expect(apply.body.counts).toMatchObject({ MATCHED: 1, AMOUNT_MISMATCH: 1, ERP_REJECTED: 1, DUPLICATE_ROW: 1, UNKNOWN_KEY: 1 });
    rec = await h.call('finance', 'GET', `/api/v1/integration/erp/reconciliation?${q}`);
    expect(rec.body.attention.find((x: any) => x.invoiceId === a.id)).toBeUndefined(); // CONFIRMED
    expect(rec.body.attention.find((x: any) => x.invoiceId === b.id).status).toBe('NOT_CONFIGURED');
    expect(rec.body.attention.find((x: any) => x.invoiceId === c.id)).toMatchObject({ status: 'FAILED', lastError: 'ERP: Cari kart bulunamadı; açılmalı' });
    expect((await h.call('finance', 'GET', `/api/v1/invoices/${a.id}`)).body.erp).toMatchObject({ status: 'CONFIRMED', externalId: 'MUH-1' });
    // Aynı dosya ikinci kez uygulanırsa hiçbir şey değişmez.
    const again = await h.call('finance', 'POST', '/api/v1/integration/erp/results', { body: { csv: result, dryRun: false } });
    expect(again.body.rows[0].outcome).toBe('ALREADY_CONFIRMED');
    const trail = await h.owner.query(`SELECT count(*)::int AS n FROM audit_events WHERE action = 'erp.reconciliation.applied' AND tenant_id = $1`, [h.world.tenantA]);
    expect(trail.rows[0].n).toBe(2);
  });

  it('başlığı eksik sonuç dosyası reddedilir; formül başlatan hücre CSV çıktısında metne çevrilir', async () => {
    const bad = await h.call('finance', 'POST', '/api/v1/integration/erp/results', { body: { csv: 'anahtar,tutar\nx,1', dryRun: true } });
    expect(bad.status).toBe(422);
    expect(bad.body.error.code).toBe('invalid_header');
    // Tedarikçi adı "=" ile başlıyorsa aktarım dosyasında formül olarak çalışmaz.
    await h.owner.query(`UPDATE suppliers SET legal_name = '=HYPERLINK("http://x")' WHERE id = $1`, [h.world.suppliers.s1]);
    await approvedInvoice('10.00');
    const out = await h.call('finance', 'GET', `/api/v1/integration/erp/batch.csv?${q}`);
    expect(out.raw.toString('utf8')).toContain(`"'=HYPERLINK(""http://x"")"`);
    expect(out.raw.toString('utf8')).not.toMatch(/;=HYPERLINK/);
  });
});
