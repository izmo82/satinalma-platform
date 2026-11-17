// v2 Faz 3 (D108+) Görev 7 inceleme (I4): sözleşme ailesine tahsis edilmiş faturalar (Özet > Eşleşen faturalar). Veriler sentetik.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { syntheticPdf } from '../src/devdata.ts';
import { withTenant, type TenantContext } from '../src/db.ts';
import { approveInvoice } from '../src/modules/invoices.ts';
import { makeHarness } from './harness.ts';
import { legacyLinkPut } from './legacyLinks.ts';

let h: Awaited<ReturnType<typeof makeHarness>>;
beforeAll(async () => { h = await makeHarness(); });
afterAll(async () => { await h.close(); });

type Who = 'buyer' | 'finance' | 'finance2' | 'legal' | 'legal2' | 'buyerB';
const call = (who: Who, method: string, url: string, body?: unknown) => h.call(who, method, url, body === undefined ? {} : { body });

async function contract() {
  const up = await h.upload('legal', { name: 's.pdf', mime: 'application/pdf', data: syntheticPdf([[`SENTETIK ${randomUUID()}`]]) },
    { companyId: h.world.companyA1.id, kind: 'CONTRACT', title: 'Hizmet Sözleşmesi (SENTETİK)' });
  const c = await call('legal', 'POST', '/api/v1/contracts', { title: `Hizmet ${randomUUID().slice(0, 4)} (SENTETİK)`, documentVersionId: up.body.documentVersionId,
    stage: 'EXECUTION', signatureMethod: 'NOT_REQUIRED', originalCustodyRequired: false,
    parties: [{ role: 'BUYER', displayName: h.world.companyA1.name, legalEntityId: h.world.companyA1.id }], supplierId: h.world.suppliers.s1 });
  expect(c.status, JSON.stringify(c.body)).toBe(201);
  return c.body as { familyId: string; contractVersionId: string };
}
async function invoice(net: string, kind = 'INVOICE') {
  const r = await call('finance', 'POST', '/api/v1/invoices', { companyId: h.world.companyA1.id, supplierId: h.world.suppliers.s1, kind, invoiceNo: `SNT${randomUUID().slice(0, 8)}`,
    issueDate: '2026-10-20', currency: 'TRY', lines: [{ description: 'Hizmet bedeli', quantity: '1', unit: 'adet', unitPrice: net, netAmount: net }] });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return r.body.id as string;
}
const allocate = (id: string, cv: string, amount: string) =>
  legacyLinkPut(h.owner, (b) => call('finance', 'PUT', `/api/v1/invoices/${id}/allocations`, b), id,
    { allocations: [{ lineNo: 1, poLineId: null, contractVersionId: cv, quantity: '1', amount }] });

describe('GET /api/v1/contracts/:id/invoices', () => {
  it('ailenin sürümüne tahsis edilen faturalar: tutar decimal string, durum onay kararına göre; başka sözleşmeninki gelmez', async () => {
    const c = await contract();
    const other = await contract();
    const empty = await call('legal', 'GET', `/api/v1/contracts/${c.familyId}/invoices`);
    expect(empty.status).toBe(200);
    expect(empty.body.items).toEqual([]);

    const i1 = await invoice('1500.50');
    const i2 = await invoice('700.00');
    const i3 = await invoice('900.00');
    expect((await allocate(i1, c.contractVersionId, '1500.50')).status).toBe(200);
    expect((await allocate(i2, c.contractVersionId, '700.00')).status).toBe(200);
    expect((await allocate(i3, other.contractVersionId, '900.00')).status).toBe(200);
    // Onaylı durum test verisi olarak modül işleviyle yazılır (fatura onay ucu v2'de kaldırıldı).
    const ctx: TenantContext = { tenantId: h.world.tenantA, userId: h.world.users.finance2.id, roles: ['PROCUREMENT'], companyIds: [h.world.companyA1.id],
      departmentIds: [], allDepartments: true, correlationId: 'v2-family-invoices' };
    await withTenant(h.pool, ctx, (tx) => approveInvoice(tx, ctx, i1, 'test-erp'));

    const r = await call('legal', 'GET', `/api/v1/contracts/${c.familyId}/invoices`);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.items.map((x: any) => x.id).sort()).toEqual([i1, i2].sort());
    const one = r.body.items.find((x: any) => x.id === i1);
    expect(one).toMatchObject({ amount: '1500.50', currency: 'TRY', date: '2026-10-20', status: 'APPROVED', supplier: { id: h.world.suppliers.s1 } });
    expect(one.invoiceNo).toMatch(/^SNT/);
    expect(r.body.items.find((x: any) => x.id === i2)).toMatchObject({ amount: '700.00', status: 'PENDING', statusLabel: 'Karar bekliyor' });
  });

  it('görünmeyen aile 404; başka kiracı göremez', async () => {
    const c = await contract();
    expect((await call('legal', 'GET', `/api/v1/contracts/${randomUUID()}/invoices`)).status).toBe(404);
    expect((await h.call('buyerB', 'GET', `/api/v1/contracts/${c.familyId}/invoices`, { tenant: h.world.tenantB })).status).toBe(404);
  });
});
