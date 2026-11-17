// v2 Faz 5 (R7) Görev 3: Yönetim > E-posta kutusu ucu. Yalnız Yönetici okur; geliştirme/testte belirteçli bağlantı açık, üretim
// yapılandırmasında `#token=` değeri maskeli. Kanal bandı yapılandırmadan gelir (Graph kanalı burada yalnız yapılandırma; gönderim yok).
// Gerçek PostgreSQL + RLS; veri sentetik, adresler example.test.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { withTenant, type TenantContext } from '../src/db.ts';
import { queueEmail } from '../src/mail/index.ts';
import { maskTokens } from '../src/modules/emailOutbox.ts';
import { makeHarness } from './harness.ts';

let dev: Awaited<ReturnType<typeof makeHarness>>;
let prod: Awaited<ReturnType<typeof makeHarness>>;
const SECRET = 'sentetik-sir-asla-donmez-987654';
const TOKEN = 'Zm9vYmFyYmF6cXV4MTIzNDU2Nzg5MGFiY2RlZmdoaWprbG1u';
beforeAll(async () => {
  dev = await makeHarness();
  prod = await makeHarness({ env: 'production',
    mail: { kind: 'graph', sender: 'satinalma@example.test', tenantId: 'tenant-guid', clientId: 'client-guid', clientSecret: SECRET } });
});
afterAll(async () => { await dev.close(); await prod.close(); });

type H = typeof dev;
const ctx = (h: H): TenantContext => ({ tenantId: h.world.tenantA, userId: h.world.users.tenantAdmin.id, roles: ['ADMIN'], companyIds: [], departmentIds: [],
  allDepartments: true, correlationId: `outbox-${randomUUID().slice(0, 8)}` });
async function seed(h: H) {
  const relatedId = randomUUID();
  const verify = await withTenant(h.pool, ctx(h), (tx) => queueEmail(tx, ctx(h), {
    toEmail: 'basvuru@example.test', subject: 'E-posta adresinizi doğrulayın',
    body: `Başvurunuzu tamamlamak için: http://localhost:5174/basvuru/dogrula#token=${TOKEN}\n\nBağlantı 24 saat geçerlidir.`,
    relatedType: 'supplier_application', relatedId }, { kind: 'none' }));
  const other = await withTenant(h.pool, ctx(h), (tx) => queueEmail(tx, ctx(h), {
    toUserId: h.world.users.buyer.id, toEmail: h.world.users.buyer.email, subject: 'Sözleşme hatırlatıcısı: sentetik', body: 'Gövde',
    relatedType: 'contract_reminder', relatedId: randomUUID() }, { kind: 'none' }));
  return { verify, other, relatedId };
}

describe('GET /api/v1/admin/email-outbox', () => {
  it('admin_reads_all_rows_with_channel_band_and_open_token_in_dev', async () => {
    const { verify, other } = await seed(dev);
    const r = await dev.call('tenantAdmin', 'GET', '/api/v1/admin/email-outbox?limit=200');
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.channel).toEqual({ kind: 'none', sender: null, label: 'E-posta kanalı yapılandırılmadı — aşağıdaki iletiler gönderilmedi' });
    const v = r.body.items.find((i: any) => i.id === verify.id);
    expect(v).toMatchObject({ toEmail: 'basvuru@example.test', subject: 'E-posta adresinizi doğrulayın', relatedType: 'supplier_application',
      status: 'NOT_CONFIGURED', statusLabel: 'Gönderilmedi — e-posta kanalı yapılandırılmadı', sentAt: null, error: null });
    expect(v.body).toContain(`/basvuru/dogrula#token=${TOKEN}`); // geliştirme/test: e2e bağlantıyı buradan alır
    expect(Object.keys(v).sort()).toEqual(['body', 'createdAt', 'error', 'id', 'relatedId', 'relatedType', 'sentAt', 'status', 'statusLabel', 'subject', 'toEmail']);
    expect(r.body.items.some((i: any) => i.id === other.id)).toBe(true);
  });

  it('filters_and_paging', async () => {
    const { relatedId } = await seed(dev);
    const r = await dev.call('tenantAdmin', 'GET', '/api/v1/admin/email-outbox?relatedType=supplier_application&status=NOT_CONFIGURED&limit=1');
    expect(r.status).toBe(200);
    expect(r.body.items).toHaveLength(1);
    expect(r.body.items[0]).toMatchObject({ relatedType: 'supplier_application', relatedId, status: 'NOT_CONFIGURED' }); // en yeni önce
    expect(r.body.total).toBeGreaterThanOrEqual(2);
    expect((await dev.call('tenantAdmin', 'GET', '/api/v1/admin/email-outbox?status=SENT_BOGUS')).status).toBe(400);
    expect((await dev.call('tenantAdmin', 'GET', '/api/v1/admin/email-outbox?limit=500')).status).toBe(400);
  });

  it('only_admin_reads', async () => {
    for (const who of ['buyer', 'masterData', 'auditor', 'techEval', 'supplier1'] as const) {
      const r = await dev.call(who, 'GET', '/api/v1/admin/email-outbox');
      expect(r.status, who).toBe(403);
    }
  });

  it('tenant_isolation', async () => {
    const { verify } = await seed(dev);
    // Başka kiracıdaki Yönetici yok; B kiracısında satır yazılır ve A'nın Yöneticisi görmez.
    const bctx: TenantContext = { tenantId: dev.world.tenantB, userId: dev.world.users.buyerB.id, roles: ['PROCUREMENT'], companyIds: [], departmentIds: [],
      allDepartments: true, correlationId: 'outbox-b' };
    const b = await withTenant(dev.pool, bctx, (tx) => queueEmail(tx, bctx, { toEmail: 'b@example.test', subject: 'B kiracısı', body: 'B',
      relatedType: 'mail_test', relatedId: randomUUID() }, { kind: 'none' }));
    const r = await dev.call('tenantAdmin', 'GET', '/api/v1/admin/email-outbox?limit=200');
    expect(r.body.items.some((i: any) => i.id === verify.id)).toBe(true);
    expect(r.body.items.some((i: any) => i.id === b.id)).toBe(false);
  });

  it('production_masks_token_and_shows_graph_sender_without_secret', async () => {
    const { verify } = await seed(prod);
    const r = await prod.call('tenantAdmin', 'GET', '/api/v1/admin/email-outbox?limit=200');
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.channel).toEqual({ kind: 'graph', sender: 'satinalma@example.test', label: 'Microsoft Graph: satinalma@example.test' });
    const v = r.body.items.find((i: any) => i.id === verify.id);
    expect(v.body).toContain('/basvuru/dogrula#token=••••');
    expect(v.body).toContain('Bağlantı 24 saat geçerlidir.');
    const raw = JSON.stringify(r.body);
    expect(raw).not.toContain(TOKEN);
    expect(raw).not.toContain(SECRET);
    expect(raw).not.toContain('client-guid');
    expect((await prod.call('buyer', 'GET', '/api/v1/admin/email-outbox')).status).toBe(403);
  });

  it('mask_helper', () => {
    expect(maskTokens('a https://x.test/basvuru/tamamla#token=abc-DEF_123 b')).toBe('a https://x.test/basvuru/tamamla#token=•••• b');
    expect(maskTokens('iki #token=aaa ve #token=bbb')).toBe('iki #token=•••• ve #token=••••');
    expect(maskTokens('https://x.test/portal/123')).toBe('https://x.test/portal/123');
  });
});
