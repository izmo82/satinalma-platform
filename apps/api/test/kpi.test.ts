// v2 Faz 1 (D93/D95): Yönetici (eski kiracı yöneticisi) raporları okur; yetkisiz rol örneği bölüm kullanıcısı
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { makeHarness } from './harness.ts';

// Faz 5 raporlar (UX13): tanım, kapsam, veri anı; dışa aktarma aynı yetkiyle ve denetim kaydıyla.
let h: Awaited<ReturnType<typeof makeHarness>>;
beforeAll(async () => { h = await makeHarness(); });
afterAll(async () => { await h.close(); });

describe('yönetim göstergeleri', () => {
  it('her gösterge tanım, kaynak ve durumla döner; hesaplanamayan gösterge uydurulmaz', async () => {
    const inv = await h.call('finance', 'POST', '/api/v1/invoices', { body: { companyId: h.world.companyA1.id, supplierId: h.world.suppliers.s1, kind: 'INVOICE', invoiceNo: `RP${randomUUID().slice(0, 8)}`,
      issueDate: '2026-10-05', currency: 'TRY', lines: [{ description: 'Hizmet', quantity: '1', unit: 'ay', unitPrice: '100', netAmount: '100.00' }] } });
    expect(inv.status).toBe(201);
    const r = await h.call('auditor', 'GET', '/api/v1/reports/summary?from=2026-10-01&to=2026-10-31');
    expect(r.status).toBe(200);
    const by = Object.fromEntries(r.body.indicators.map((i: any) => [i.key, i]));
    // Tahsis edilmemiş fatura açık uyumsuzluktur.
    expect(by.invoice_exception_rate).toMatchObject({ status: 'OK', values: [{ numerator: '1', denominator: '1', ratio: '100.0' }] });
    expect(by.savings).toMatchObject({ status: 'NO_DATA' }); // onaylı baz yok
    expect(by.savings.note).toContain('en pahalı teklif');
    expect(by.automation_reliability.status).toBe('NO_DATA');
    expect(r.body.dataAsOf).toBeTruthy();
    for (const i of r.body.indicators) { expect(i.definition.length).toBeGreaterThan(10); expect(i.source).toBeTruthy(); }
  });

  it('yetkisiz rol ne ekranı ne dışa aktarmayı görür; CSV formül enjeksiyonuna karşı kaçışlı ve denetim kaydı var', async () => {
    expect((await h.call('techEval', 'GET', '/api/v1/reports/summary?from=2026-01-01&to=2026-12-31')).status).toBe(403);
    expect((await h.call('techEval', 'GET', '/api/v1/reports/summary.csv?from=2026-01-01&to=2026-12-31')).status).toBe(403);
    // v2: Yönetici rapor okur (report.read).
    expect((await h.call('tenantAdmin', 'GET', '/api/v1/reports/summary?from=2026-01-01&to=2026-12-31')).status).toBe(200);
    const csv = await h.call('finance', 'GET', '/api/v1/reports/summary.csv?from=2026-01-01&to=2026-12-31');
    expect(csv.status).toBe(200);
    expect(csv.headers['content-type']).toContain('text/csv');
    expect(csv.raw.toString('utf8').startsWith('\uFEFFGösterge;')).toBe(true);
    expect(csv.raw.toString('utf8')).not.toMatch(/\n=|;=/);
    const a = await h.owner.query(`SELECT count(*)::int AS n FROM audit_events WHERE action = 'report.exported' AND tenant_id = $1`, [h.world.tenantA]);
    expect(a.rows[0].n).toBeGreaterThan(0);
    expect((await h.call('finance', 'GET', '/api/v1/reports/summary?from=2026-12-31&to=2026-01-01')).status).toBe(422);
  });
});

describe('rapor önbelleği (Faz 7 performans)', () => {
  let c: Awaited<ReturnType<typeof makeHarness>>;
  beforeAll(async () => { c = await makeHarness({ reportCacheSeconds: 120 }); });
  afterAll(async () => { await c.close(); });
  const url = '/api/v1/reports/summary?from=2025-03-01&to=2025-03-31';
  const den = (r: any) => r.body.indicators.find((i: any) => i.key === 'invoice_exception_rate').values[0].denominator;

  it('aynı kapsam paylaşır ve veri anını söyler; fresh yeniden hesaplar; farklı şirket kapsamı paylaşmaz; her görüntüleme denetimde', async () => {
    const before = (await c.owner.query(`SELECT count(*)::int AS n FROM audit_events WHERE action = 'report.viewed' AND tenant_id = $1`, [c.world.tenantA])).rows[0].n;
    const a = await c.call('auditor', 'GET', url);
    const inv = await c.call('finance', 'POST', '/api/v1/invoices', { body: { companyId: c.world.companyA1.id, supplierId: c.world.suppliers.s1, kind: 'INVOICE', invoiceNo: `RC${randomUUID().slice(0, 8)}`,
      issueDate: '2025-03-10', currency: 'TRY', lines: [{ description: 'Hizmet', quantity: '1', unit: 'ay', unitPrice: '10', netAmount: '10.00' }] } });
    expect(inv.status).toBe(201);
    // Finans ile denetçinin şirket kapsamı aynı (A1): önbellekteki sonuç, eski veri anıyla.
    const b = await c.call('finance', 'GET', url);
    expect(b.body.dataAsOf).toBe(a.body.dataAsOf);
    expect(den(b)).toBe(den(a));
    const fresh = await c.call('auditor', 'GET', `${url}&fresh=true`);
    expect(fresh.body.dataAsOf > a.body.dataAsOf).toBe(true);
    expect(Number(den(fresh))).toBe(Number(den(a)) + 1);
    // Başka şirket kapsamı (A2): ayrı hesap.
    const other = await c.call('multi', 'GET', url);
    expect(other.status).toBe(200);
    expect(other.body.dataAsOf).not.toBe(a.body.dataAsOf);
    const after = (await c.owner.query(`SELECT count(*)::int AS n FROM audit_events WHERE action = 'report.viewed' AND tenant_id = $1`, [c.world.tenantA])).rows[0].n;
    expect(after - before).toBe(4);
  });
});
