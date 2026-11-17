// v2 Faz 5 (R6) Görev 3: e-posta kanalı. Graph bağdaştırıcısı YALNIZ sahte HTTP taşıyıcısıyla sınanır — gerçek gönderim değildir
// (gerçek Graph gönderimi NOT_RUN). Kuyruk ve gönderim işi gerçek PostgreSQL + RLS üzerinde; veri sentetik, adresler example.test.
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { withTenant, type TenantContext } from '../src/db.ts';
import { loadMail } from '../src/config.ts';
import { GraphMailSender } from '../src/mail/graph.ts';
import { DISPATCH_JOB, processEmailDispatch, queueEmail, type MailChannel, type MailSender } from '../src/mail/index.ts';
import { processJobs } from '../src/worker.ts';
import { makeHarness } from './harness.ts';

let h: Awaited<ReturnType<typeof makeHarness>>;
beforeAll(async () => { h = await makeHarness(); });
afterAll(async () => { await h.close(); });
afterEach(() => { vi.restoreAllMocks(); });

const SECRET = 'sentetik-istemci-sirri-0123456789';
const GRAPH: MailChannel = { kind: 'graph', sender: 'satinalma@example.test' };
const NONE: MailChannel = { kind: 'none' };
const ctx = (): TenantContext => ({ tenantId: h.world.tenantA, userId: h.world.users.tenantAdmin.id, roles: ['ADMIN'], companyIds: [], departmentIds: [],
  allDepartments: true, correlationId: `mail-test-${randomUUID().slice(0, 8)}` });
const mail = (over: Record<string, unknown> = {}) => ({ toEmail: 'tedarikci@example.test', subject: 'Sentetik konu', body: 'Sentetik gövde: GIZLI-GOVDE-METNI',
  relatedType: 'mail_test', relatedId: randomUUID(), ...over });
const row = async (id: string) => (await h.owner.query(`SELECT status, sent_at, error FROM email_outbox WHERE id = $1`, [id])).rows[0];
const jobOf = async (id: string) => (await h.owner.query(`SELECT id, status, attempts, error_code FROM jobs WHERE kind = $1 AND idempotency_key = $2`,
  [DISPATCH_JOB, `email:${id}`])).rows[0];
/** Yalnız e-posta işlerini çeker (başka işlere dokunmaz) ve işler — işçinin `email.dispatch` dalı. */
async function dispatchOnce(sender: MailSender) {
  const claimed = (await h.pool.query(`SELECT * FROM claim_jobs($1, 50)`, [[DISPATCH_JOB]])).rows;
  for (const j of claimed) await processEmailDispatch(h.pool, sender, j.tenant_id, j.id);
  return claimed.length;
}
const makeReady = (jobId: string) => h.owner.query(`UPDATE jobs SET run_after = now() WHERE id = $1`, [jobId]);

describe('Yapılandırma (MAIL_PROVIDER)', () => {
  it('mail_provider_empty_is_none', () => {
    expect(loadMail({})).toEqual({ kind: 'none' });
    expect(loadMail({ MAIL_PROVIDER: '' })).toEqual({ kind: 'none' });
    expect(loadMail({ MAIL_PROVIDER: 'none', MAIL_SENDER: 'x@example.test' })).toEqual({ kind: 'none' });
  });
  it('graph_without_sender_fails_naming_only_the_variable', () => {
    const env = { MAIL_PROVIDER: 'graph', ENTRA_TENANT_ID: 'tenant-guid', ENTRA_CLIENT_ID: 'client-guid', ENTRA_CLIENT_SECRET: SECRET };
    expect(() => loadMail(env)).toThrow(/MAIL_SENDER/);
    try { loadMail(env); } catch (e) { expect((e as Error).message).not.toContain(SECRET); expect((e as Error).message).not.toContain('client-guid'); }
    // Sır eksikse yalnız değişken adı; gönderen değeri de iletiye kopyalanmaz.
    expect(() => loadMail({ ...env, MAIL_SENDER: 'satinalma@example.test', ENTRA_CLIENT_SECRET: '' })).toThrow(/ENTRA_CLIENT_SECRET/);
    expect(() => loadMail({ MAIL_PROVIDER: 'smtp://user:pass@host' })).toThrow(/MAIL_PROVIDER geçersiz/);
    try { loadMail({ MAIL_PROVIDER: 'smtp://user:pass@host' }); } catch (e) { expect((e as Error).message).not.toContain('pass'); }
    const ok = loadMail({ ...env, MAIL_SENDER: 'satinalma@example.test' });
    expect(ok).toMatchObject({ kind: 'graph', sender: 'satinalma@example.test' });
  });
});

describe('Kuyruk (queueEmail)', () => {
  it('none_channel_writes_not_configured_without_job', async () => {
    const r = await withTenant(h.pool, ctx(), (tx) => queueEmail(tx, ctx(), mail(), NONE));
    expect(r.status).toBe('NOT_CONFIGURED');
    expect(await row(r.id)).toMatchObject({ status: 'NOT_CONFIGURED', sent_at: null });
    expect(await jobOf(r.id)).toBeUndefined();
  });
  it('graph_channel_writes_queued_with_single_dispatch_job', async () => {
    const r = await withTenant(h.pool, ctx(), (tx) => queueEmail(tx, ctx(), mail({ toUserId: h.world.users.buyer.id }), GRAPH));
    expect(r.status).toBe('QUEUED');
    const full = (await h.owner.query(`SELECT to_user_id, to_email, related_type, status FROM email_outbox WHERE id = $1`, [r.id])).rows[0];
    expect(full).toEqual({ to_user_id: h.world.users.buyer.id, to_email: 'tedarikci@example.test', related_type: 'mail_test', status: 'QUEUED' });
    expect(await jobOf(r.id)).toMatchObject({ status: 'QUEUED' });
  });
});

describe('Graph bağdaştırıcısı (sahte taşıyıcı — gerçek gönderim değil)', () => {
  it('posts_sendMail_to_sender_mailbox_with_app_token', async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const fake = (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      if (url.includes('login.microsoftonline.com')) return new Response(JSON.stringify({ access_token: 'sahte-belirtec', expires_in: 3600 }), { status: 200 });
      return new Response(null, { status: 202 });
    }) as unknown as typeof fetch;
    const s = new GraphMailSender({ sender: 'satinalma@example.test', tenantId: 'tenant-guid', clientId: 'client-guid', clientSecret: SECRET }, fake);
    expect(await s.send({ to: 'tedarikci@example.test', subject: 'Teklif daveti: Sentetik', body: 'Gövde' })).toEqual({ ok: true });
    expect(await s.send({ to: 'diger@example.test', subject: 'İkinci', body: 'Gövde 2' })).toEqual({ ok: true });
    expect(calls.map((c) => c.url)).toEqual([
      'https://login.microsoftonline.com/tenant-guid/oauth2/v2.0/token',
      'https://graph.microsoft.com/v1.0/users/satinalma%40example.test/sendMail',
      'https://graph.microsoft.com/v1.0/users/satinalma%40example.test/sendMail', // belirteç önbellekte
    ]);
    const tokenBody = new URLSearchParams(String(calls[0]!.init.body));
    expect(tokenBody.get('grant_type')).toBe('client_credentials');
    expect(tokenBody.get('scope')).toBe('https://graph.microsoft.com/.default');
    const send = calls[1]!;
    expect(send.init.method).toBe('POST');
    expect((send.init.headers as Record<string, string>).authorization).toBe('Bearer sahte-belirtec');
    expect(JSON.parse(String(send.init.body))).toEqual({
      message: { subject: 'Teklif daveti: Sentetik', body: { contentType: 'Text', content: 'Gövde' }, toRecipients: [{ emailAddress: { address: 'tedarikci@example.test' } }] },
      saveToSentItems: false,
    });
    // Sır gönderici nesnesinde görünmez (günlüğe nesne yazılsa da sızmaz).
    expect(JSON.stringify(s)).not.toContain(SECRET);
  });
  it('maps_errors_to_short_codes', async () => {
    const status = (code: number) => (async (url: string) => url.includes('login.') ? new Response(JSON.stringify({ access_token: 't' }), { status: 200 })
      : new Response('{"error":{"message":"ayrıntı"}}', { status: code })) as unknown as typeof fetch;
    const cfg = { sender: 'satinalma@example.test', tenantId: 't', clientId: 'c', clientSecret: SECRET };
    const nosleep = { sleep: async () => {} };
    expect(await new GraphMailSender(cfg, status(500), nosleep).send({ to: 'a@example.test', subject: 's', body: 'b' })).toEqual({ ok: false, code: 'http_500' });
    expect(await new GraphMailSender(cfg, status(403), nosleep).send({ to: 'a@example.test', subject: 's', body: 'b' })).toEqual({ ok: false, code: 'forbidden' });
    expect(await new GraphMailSender(cfg, status(503), nosleep).send({ to: 'a@example.test', subject: 's', body: 'b' })).toEqual({ ok: false, code: 'throttled' });
    const denied = (async () => new Response('{"error":"invalid_client"}', { status: 401 })) as unknown as typeof fetch;
    expect(await new GraphMailSender(cfg, denied, nosleep).send({ to: 'a@example.test', subject: 's', body: 'b' })).toEqual({ ok: false, code: 'unauthorized' });
    const down = (async () => { throw new Error(`bağlantı reddedildi ${SECRET}`); }) as unknown as typeof fetch;
    expect(await new GraphMailSender(cfg, down, nosleep).send({ to: 'a@example.test', subject: 's', body: 'b' })).toEqual({ ok: false, code: 'network' });
  });
});

describe('Gönderim işi (email.dispatch)', () => {
  // Önceki testlerin (ya da yarıda kalmış eski koşuların) kuyruktaki işleri boşaltılır; sayımlar yalnız bu testin işini ölçer.
  beforeAll(async () => { while (await dispatchOnce({ kind: 'fake', send: async () => ({ ok: true }) }) > 0); });
  it('success_marks_sent', async () => {
    const r = await withTenant(h.pool, ctx(), (tx) => queueEmail(tx, ctx(), mail(), GRAPH));
    const sent: unknown[] = [];
    const fake: MailSender = { kind: 'fake', send: async (m) => { sent.push(m); return { ok: true }; } };
    expect(await dispatchOnce(fake)).toBe(1);
    expect(sent).toEqual([{ to: 'tedarikci@example.test', subject: 'Sentetik konu', body: 'Sentetik gövde: GIZLI-GOVDE-METNI' }]);
    const after = await row(r.id);
    expect(after.status).toBe('SENT');
    expect(after.sent_at).not.toBeNull();
    expect((await jobOf(r.id)).status).toBe('SUCCEEDED');
    // İkinci çalıştırmada (iş tamam) yeniden gönderilmez.
    expect(await dispatchOnce(fake)).toBe(0);
    expect(sent).toHaveLength(1);
  });

  it('5xx_three_attempts_then_failed_without_secret_or_body_in_logs', async () => {
    const logs: string[] = [];
    for (const k of ['log', 'info', 'warn', 'error', 'debug'] as const) vi.spyOn(console, k).mockImplementation((...a: unknown[]) => { logs.push(a.map(String).join(' ')); });
    let sends = 0;
    const fake = (async (url: string) => {
      if (url.includes('login.')) return new Response(JSON.stringify({ access_token: 'sahte-belirtec' }), { status: 200 });
      sends++;
      return new Response(`{"error":{"message":"iç hata ${SECRET}"}}`, { status: 500 });
    }) as unknown as typeof fetch;
    const sender = new GraphMailSender({ sender: 'satinalma@example.test', tenantId: 't', clientId: 'c', clientSecret: SECRET }, fake, { sleep: async () => {} });
    const r = await withTenant(h.pool, ctx(), (tx) => queueEmail(tx, ctx(), mail(), GRAPH));
    const job = await jobOf(r.id);

    expect(await dispatchOnce(sender)).toBe(1);
    expect(await row(r.id)).toMatchObject({ status: 'QUEUED', error: 'http_500' }); // 1. deneme: kuyrukta kalır
    expect(await jobOf(r.id)).toMatchObject({ status: 'QUEUED', attempts: 1 });
    expect(await dispatchOnce(sender)).toBe(0); // bekleme süresi dolmadan yeniden çekilmez
    await makeReady(job.id);
    expect(await dispatchOnce(sender)).toBe(1);
    await makeReady(job.id);
    expect(await dispatchOnce(sender)).toBe(1);
    expect(sends).toBe(3);
    expect(await row(r.id)).toMatchObject({ status: 'FAILED', error: 'http_500', sent_at: null });
    expect(await jobOf(r.id)).toMatchObject({ status: 'DEAD', attempts: 3, error_code: 'http_500' });
    await makeReady(job.id);
    expect(await dispatchOnce(sender)).toBe(0);
    expect(sends).toBe(3);
    const all = logs.join('\n');
    expect(all).not.toContain(SECRET);
    expect(all).not.toContain('GIZLI-GOVDE-METNI');
    expect(all).not.toContain('sahte-belirtec');
  });

  it('not_configured_rows_are_never_sent_after_graph_is_enabled', async () => {
    // Kanal kapalıyken yazılan satır; sonra kanal açılır (gönderici var). Satır için iş yoktur; zorla iş yazılsa da gönderilmez.
    const old = await withTenant(h.pool, ctx(), (tx) => queueEmail(tx, ctx(), mail(), NONE));
    let sends = 0;
    const fake: MailSender = { kind: 'fake', send: async () => { sends++; return { ok: true }; } };
    await dispatchOnce(fake);
    expect(sends).toBe(0);
    await h.owner.query(`INSERT INTO jobs (tenant_id, kind, idempotency_key, payload) VALUES ($1,$2,$3,$4)`,
      [h.world.tenantA, DISPATCH_JOB, `email:${old.id}`, { outboxId: old.id }]);
    expect(await dispatchOnce(fake)).toBe(1);
    expect(sends).toBe(0);
    expect(await row(old.id)).toMatchObject({ status: 'NOT_CONFIGURED', sent_at: null });
    expect((await jobOf(old.id)).status).toBe('SUCCEEDED');
  });

  it('worker_claims_dispatch_only_with_sender', async () => {
    const r = await withTenant(h.pool, ctx(), (tx) => queueEmail(tx, ctx(), mail(), GRAPH));
    let sends = 0;
    const fake: MailSender = { kind: 'fake', send: async () => { sends++; return { ok: true }; } };
    // Gönderici yok (kanal none): iş çekilmez, satır kuyrukta kalır. (Paylaşılan test veritabanında başka bekleyen işler olabilir: boşalana dek.)
    for (let i = 0; i < 30 && (await processJobs(h.pool, h.store, null, 50, null, 'short', {})) > 0; i++);
    expect((await jobOf(r.id)).status).toBe('QUEUED');
    for (let i = 0; i < 30 && (await jobOf(r.id)).status === 'QUEUED'; i++) await processJobs(h.pool, h.store, null, 50, null, 'short', { mailSender: fake });
    expect(sends).toBeGreaterThanOrEqual(1);
    expect((await row(r.id)).status).toBe('SENT');
  });
});
