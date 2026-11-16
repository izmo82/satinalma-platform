// v2 Faz 1 (D93/D95): hukuk artık Satınalma rolünde ve proje okur; izinsiz tür örneği tedarikçi kullanıcısı
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { makeHarness } from './harness.ts';

// Üst çubuk araması, bildirim ve kayıtlı görünüm: yetki ve kiracı/şirket sınırı içinde.
let h: Awaited<ReturnType<typeof makeHarness>>;
beforeAll(async () => { h = await makeHarness(); });
afterAll(async () => { await h.close(); });

describe('arama', () => {
  it('eşleşen alanı söyler; izinsiz tür ve başka kiracı/şirket kaydı dönmez; % ve _ joker değildir', async () => {
    const tag = `Ararız${randomUUID().slice(0, 6)}`;
    const p = await h.call('buyer', 'POST', '/api/v1/projects', { body: { companyId: h.world.companyA1.id, title: `${tag} sunucu bakımı`, category: 'BT', lines: [{ lot: 'L', description: 'Bakım', unit: 'ay', quantity: '1' }],
      criteria: [{ code: 'PRICE', name: 'Fiyat', kind: 'PRICE', weight: '100' }] } });
    const r = await h.call('buyer', 'GET', `/api/v1/search?q=${encodeURIComponent(tag)}`);
    const proj = r.body.groups.find((g: any) => g.type === 'project');
    expect(proj.items[0]).toMatchObject({ id: p.body.id, matched: 'Başlık' });
    const byCode = await h.call('buyer', 'GET', `/api/v1/search?q=${p.body.code}`);
    expect(byCode.body.groups.find((g: any) => g.type === 'project').items[0].matched).toBe('Proje no');
    // v2: hukuk (Satınalma) proje okur; proje okuma izni olmayan rol (tedarikçi) proje sonucu almaz.
    expect((await h.call('legal', 'GET', `/api/v1/search?q=${encodeURIComponent(tag)}`)).body.groups.some((g: any) => g.type === 'project')).toBe(true);
    expect((await h.call('supplier1', 'GET', `/api/v1/search?q=${encodeURIComponent(tag)}`)).body.groups.some((g: any) => g.type === 'project')).toBe(false);
    expect((await h.call('buyerB', 'GET', `/api/v1/search?q=${encodeURIComponent(tag)}`, { tenant: h.world.tenantB })).body.groups).toEqual([]);
    // A2 şirketine erişimi olan kullanıcı A1 projesini görmez.
    expect((await h.call('multi', 'GET', `/api/v1/search?q=${encodeURIComponent(tag)}`)).body.groups).toEqual([]);
    expect((await h.call('buyer', 'GET', '/api/v1/search?q=%25%25')).body.groups).toEqual([]);
    expect((await h.call('buyer', 'GET', '/api/v1/search?q=a')).status).toBe(422);
  });
});

describe('bildirim ve kayıtlı görünüm', () => {
  it('okunmamış sayı son görülmeden sonraki görevlerdir; görünümler kişiseldir', async () => {
    const before = (await h.call('legal2', 'GET', '/api/v1/notifications')).body;
    expect(before.unread).toBeGreaterThanOrEqual(0);
    await h.call('legal2', 'POST', '/api/v1/notifications/seen');
    expect((await h.call('legal2', 'GET', '/api/v1/notifications')).body.unread).toBe(0);
    await h.call('buyer', 'POST', '/api/v1/projects', { body: { companyId: h.world.companyA1.id, title: 'Bildirim denemesi (SENTETİK)', category: 'BT', budget: '10',
      lines: [{ lot: 'L', description: 'Bakım', unit: 'ay', quantity: '1' }], criteria: [{ code: 'PRICE', name: 'Fiyat', kind: 'PRICE', weight: '100' }] } })
      .then(async (p) => h.call('buyer', 'POST', `/api/v1/projects/${p.body.id}/rounds`, { body: { closesAt: new Date(Date.now() + 86_400_000).toISOString(), supplierIds: [h.world.suppliers.s1] }, headers: { 'if-match': p.body.etag } }));
    const after = (await h.call('legal2', 'GET', '/api/v1/notifications')).body;
    expect(after.unread).toBe(1);
    expect(after.items[0]).toMatchObject({ unread: true, entityType: 'project' });
    const v = await h.call('buyer', 'POST', '/api/v1/saved-views', { body: { page: 'invoices', name: 'Onay bekleyen TRY', params: { status: 'PENDING', currency: 'TRY', columns: ['no', 'supplier'] } } });
    expect(v.status).toBe(201);
    expect((await h.call('buyer', 'POST', '/api/v1/saved-views', { body: { page: 'invoices', name: 'Onay bekleyen TRY', params: {} } })).body.error.code).toBe('duplicate_name');
    expect((await h.call('buyer', 'GET', '/api/v1/saved-views?page=invoices')).body.items.map((x: any) => x.name)).toEqual(['Onay bekleyen TRY']);
    expect((await h.call('finance', 'GET', '/api/v1/saved-views?page=invoices')).body.items).toEqual([]);
    expect((await h.call('finance', 'DELETE', `/api/v1/saved-views/${v.body.id}`)).status).toBe(404); // başkasının görünümü görünmez, silinemez
    expect((await h.call('buyer', 'GET', '/api/v1/saved-views?page=invoices')).body.items).toHaveLength(1);
  });

  it('tedarikçi iç ekranların görünüm, kullanıcı ve tatil uçlarını kullanamaz; görünüm listenin okuma iznini ister', async () => {
    for (const page of ['projects', 'invoices', 'purchase_orders', 'tasks', 'suppliers', 'contracts']) {
      expect((await h.call('supplier1', 'GET', `/api/v1/saved-views?page=${page}`)).status).toBe(403);
      expect((await h.call('supplier1', 'POST', '/api/v1/saved-views', { body: { page, name: 'Tedarikçi', params: {} } })).status).toBe(403);
    }
    const v = await h.call('buyer', 'POST', '/api/v1/saved-views', { body: { page: 'projects', name: `Tedarikçi denemesi ${randomUUID().slice(0, 6)}`, params: {} } });
    expect((await h.call('supplier1', 'DELETE', `/api/v1/saved-views/${v.body.id}`)).status).toBe(403);
    expect((await h.call('supplier1', 'GET', '/api/v1/members')).status).toBe(403);
    expect((await h.call('supplier1', 'GET', '/api/v1/holidays')).status).toBe(403);
    // Güvenlik rolü fatura okuyamaz: fatura listesinin görünümü de yok. İç kullanıcı için kullanıcı ve tatil uçları açık kalır.
    expect((await h.call('security', 'GET', '/api/v1/saved-views?page=invoices')).status).toBe(403);
    expect((await h.call('legal', 'GET', '/api/v1/members')).status).toBe(200);
    expect((await h.call('legal', 'GET', '/api/v1/holidays')).status).toBe(200);
  });
});
