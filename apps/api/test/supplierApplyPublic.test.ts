// v2 Faz 5 (D110) Görev 4: girişsiz tedarikçi başvurusu API'si (R2–R5) ve başvuru ayarları (R3). Gerçek PostgreSQL + RLS ve yerel S3.
// E-posta: `none` kanalında satır NOT_CONFIGURED; `graph` kanalı yalnız yapılandırma (gönderim yok, işçi göndericisi verilmez).
// Virüs taraması: clamd YALNIZ yerel sahte TCP sunucusuyla — gerçek tarama değildir (NOT_RUN). Tüm firmalar ve adresler sentetik.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHash, randomUUID } from 'node:crypto';
import net from 'node:net';
import { withTenant, type TenantContext } from '../src/db.ts';
import { processJobs } from '../src/worker.ts';
import { PublicRateLimiter, loadPublicRateLimit } from '../src/publicRateLimit.ts';
import { makeHarness } from './harness.ts';

type H = Awaited<ReturnType<typeof makeHarness>>;
let h: H;
let g: H; // graph kanalı + sahte clamd
let slugA: string; let slugB: string; let slugG: string; let slugClosed: string;
const rand = () => randomUUID().slice(0, 8);
let ipSeq = 1;
const nextIp = () => `10.77.${Math.floor(ipSeq / 250)}.${(ipSeq++ % 250) + 1}`;

/** Geçerli denetim basamaklı sentetik VKN (9 hane rastgele + kontrol). */
function validVkn(): string {
  const d = Array.from({ length: 9 }, (_, i) => (i === 0 ? 7 : Math.floor(Math.random() * 10)));
  let sum = 0;
  for (let i = 0; i < 9; i++) {
    const tmp = (d[i]! + 9 - i) % 10;
    let r = (tmp * 2 ** (9 - i)) % 9;
    if (tmp !== 0 && r === 0) r = 9;
    sum += r;
  }
  return d.join('') + String((10 - (sum % 10)) % 10);
}
const badVkn = (v: string) => v.slice(0, 9) + String((Number(v[9]) + 1) % 10);

const pdf = (pad = 1200) => Buffer.concat([Buffer.from('%PDF-1.4\n1 0 obj << /Type /Page >> endobj\n'), Buffer.alloc(pad, 0x20), Buffer.from(`\n% ${randomUUID()}\n%%EOF`)]);
interface FilePart { field: string; name: string; mime: string; data: Buffer }
function multipart(fields: [string, string][], files: FilePart[]) {
  const boundary = '----spapply' + randomUUID();
  const parts: Buffer[] = [];
  for (const [k, v] of fields) parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`));
  for (const f of files) {
    parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${f.field}"; filename="${f.name}"\r\nContent-Type: ${f.mime}\r\n\r\n`), f.data, Buffer.from('\r\n'));
  }
  parts.push(Buffer.from(`--${boundary}--\r\n`));
  return { payload: Buffer.concat(parts), contentType: `multipart/form-data; boundary=${boundary}` };
}
const doc = (code: string, data = pdf()): FilePart => ({ field: `documents[${code}]`, name: `${code.toLowerCase()}.pdf`, mime: 'application/pdf', data });
const BASE_DOCS = () => [doc('VERGI_LEVHASI'), doc('IMZA_SIRKULERI'), doc('TICARET_SICIL_GAZETESI'), doc('FAALIYET_BELGESI')];
const BASE_VALID: [string, string][] = [['validUntil[VERGI_LEVHASI]', '2027-12-31'], ['validUntil[FAALIYET_BELGESI]', '2027-06-30']];

function fields(over: Record<string, string> = {}, extra: [string, string][] = []): [string, string][] {
  const base: Record<string, string> = { legalName: 'Deneme Bilişim Ltd. Şti. (SENTETİK)', taxIdType: 'VKN', taxId: validVkn(), contactName: 'Ayşe Başvuru',
    contactEmail: `basvuru-${rand()}@example.test`, contactPhone: '0212 000 00 00', address: 'Sentetik Mah. 1, İstanbul', services: 'Sentetik yazılım bakımı', ...over };
  return [...Object.entries(base), ...BASE_VALID, ...extra];
}

async function apply(x: H, slug: string, f: [string, string][], files: FilePart[] = BASE_DOCS(), ip = nextIp()) {
  const m = multipart(f, files);
  const res = await x.app.inject({ method: 'POST', url: `/api/v1/public/applications/${slug}`, payload: m.payload, remoteAddress: ip,
    headers: { 'content-type': m.contentType } });
  return { status: res.statusCode, body: safe(res.body), headers: res.headers, raw: res.body };
}
async function pub(x: H, method: 'GET' | 'POST', url: string, opts: { body?: unknown; headers?: Record<string, string>; ip?: string } = {}) {
  const res = await x.app.inject({ method, url, remoteAddress: opts.ip ?? nextIp(), headers: opts.headers,
    ...(opts.body !== undefined ? { payload: opts.body as any } : {}) });
  return { status: res.statusCode, body: safe(res.body), headers: res.headers, raw: res.body };
}
function safe(s: string) { try { return JSON.parse(s); } catch { return s; } }

/** Yanıtta kiracı kimliği, `internal` alanı ya da kiracı adı yok. */
function noLeak(x: H, raw: string) {
  expect(raw).not.toContain('internal');
  expect(raw).not.toContain(x.world.tenantA);
  expect(raw).not.toContain(x.world.tenantB);
  expect(raw).not.toContain('Başka Kiracı');
}
const tokenFromOutbox = async (x: H, email: string) => {
  const r = (await x.owner.query<{ body_text: string; status: string; id: string }>(
    `SELECT id, body_text, status FROM email_outbox WHERE related_type = 'supplier_application' AND to_email = $1`, [email])).rows;
  expect(r).toHaveLength(1);
  const m = /\/basvuru\/dogrula#token=([A-Za-z0-9_-]+)/.exec(r[0]!.body_text);
  expect(m, r[0]!.body_text).not.toBeNull();
  return { token: m![1]!, outbox: r[0]! };
};
const appByEmail = async (x: H, email: string) =>
  (await x.owner.query(`SELECT id, tenant_id, status, tax_id FROM supplier_applications WHERE contact_email = $1`, [email])).rows;
async function runJobs(x: H) { for (let i = 0; i < 20; i++) if (!(await processJobs(x.pool, x.store, null))) break; }
const internal = (x: H, tenant: 'A' | 'B'): TenantContext => tenant === 'A'
  ? { tenantId: x.world.tenantA, userId: x.world.users.buyer.id, roles: ['PROCUREMENT'], companyIds: [x.world.companyA1.id], departmentIds: [], allDepartments: true, correlationId: 'apply-a' }
  : { tenantId: x.world.tenantB, userId: x.world.users.buyerB.id, roles: ['PROCUREMENT'], companyIds: [x.world.companyB1.id], departmentIds: [], allDepartments: true, correlationId: 'apply-b' };

// Sahte clamd (yerel TCP): kip testte değiştirilir.
const clam = { mode: 'ok' as 'ok' | 'found' | 'error' };
let clamd: net.Server;

beforeAll(async () => {
  clamd = net.createServer((sock) => {
    let buf = Buffer.alloc(0); let header = false;
    sock.on('data', (d) => {
      buf = Buffer.concat([buf, d]);
      if (!header) { const z = buf.indexOf(0); if (z < 0) return; buf = buf.subarray(z + 1); header = true; }
      while (buf.length >= 4) {
        const len = buf.readUInt32BE(0);
        if (len === 0) {
          sock.end(clam.mode === 'ok' ? 'stream: OK\0' : clam.mode === 'found' ? 'stream: Eicar-Test-Signature FOUND\0' : 'INSTREAM size limit exceeded. ERROR\0');
          return;
        }
        if (buf.length < 4 + len) return;
        buf = buf.subarray(4 + len);
      }
    });
    sock.on('error', () => {});
  });
  await new Promise<void>((r) => clamd.listen(0, '127.0.0.1', () => r()));
  const port = (clamd.address() as net.AddressInfo).port;

  h = await makeHarness();
  g = await makeHarness({ mail: { kind: 'graph', sender: 'satinalma@example.test', tenantId: 't-guid', clientId: 'c-guid', clientSecret: 'sentetik-sir' },
    av: { kind: 'clamav', host: '127.0.0.1', port } });
  slugA = `ta-${rand()}`; slugB = `tb-${rand()}`; slugG = `tg-${rand()}`; slugClosed = `tc-${rand()}`;

  // A: Yönetici API'den açar → R3 önerilen set yazılır.
  const put = await h.call('tenantAdmin', 'PUT', '/api/v1/settings/supplier-applications',
    { body: { enabled: true, publicSlug: slugA, categories: ['Bilgi teknolojileri', 'Temizlik'] } });
  expect(put.status, JSON.stringify(put.body)).toBe(200);
  const putG = await g.call('tenantAdmin', 'PUT', '/api/v1/settings/supplier-applications', { body: { enabled: true, publicSlug: slugG, categories: [] } });
  expect(putG.status, JSON.stringify(putG.body)).toBe(200);
  // B kiracısında Yönetici yok: ayar ve belge türü doğrudan yazılır. Kapalı kısaltma g'nin B kiracısında.
  await h.owner.query(`INSERT INTO supplier_application_settings (tenant_id, enabled, public_slug) VALUES ($1, true, $2)`, [h.world.tenantB, slugB]);
  await h.owner.query(`INSERT INTO supplier_document_types (tenant_id, code, name, required) VALUES ($1, 'VERGI_LEVHASI', 'Vergi levhası', true)`, [h.world.tenantB]);
  await h.owner.query(`INSERT INTO supplier_application_settings (tenant_id, enabled, public_slug) VALUES ($1, false, $2)`, [g.world.tenantB, slugClosed]);
});
afterAll(async () => {
  await h?.close(); await g?.close();
  await new Promise((r) => clamd?.close(r));
});

describe('Başvuru ayarları (R3)', () => {
  it('first_enable_seeds_recommended_set_and_audits', async () => {
    const s = await h.call('masterData', 'GET', '/api/v1/settings/supplier-applications');
    expect(s.status).toBe(200);
    expect(s.body).toMatchObject({ enabled: true, publicSlug: slugA, publicPath: `/basvuru/${slugA}`, categories: ['Bilgi teknolojileri', 'Temizlik'], can: { manage: false } });
    const t = await h.call('masterData', 'GET', '/api/v1/settings/supplier-document-types');
    expect(t.status).toBe(200);
    expect(t.body.items.map((i: any) => i.code).sort()).toEqual(['FAALIYET_BELGESI', 'IMZA_SIRKULERI', 'ISO27001', 'TICARET_SICIL_GAZETESI', 'VERGI_LEVHASI']);
    expect(t.body.items.find((i: any) => i.code === 'ISO27001')).toMatchObject({ required: false, requiredCategories: ['Bilgi teknolojileri'], expiryRequired: true, active: true });
    expect(t.body.items.find((i: any) => i.code === 'VERGI_LEVHASI')).toMatchObject({ required: true, expiryRequired: true });
    const a = (await h.owner.query(`SELECT data FROM audit_events WHERE tenant_id = $1 AND action = 'supplier_application.settings_changed'`, [h.world.tenantA])).rows;
    expect(a).toHaveLength(1);
    expect(a[0].data).toMatchObject({ before: { enabled: false, publicSlug: null }, after: { enabled: true, publicSlug: slugA }, seededDocumentTypes: expect.any(Array) });
    // Yeniden kaydetmek seti ikinci kez yazmaz.
    const again = await h.call('tenantAdmin', 'PUT', '/api/v1/settings/supplier-applications', { body: { enabled: true } });
    expect(again.status).toBe(200);
    expect(again.body).toMatchObject({ enabled: true, publicSlug: slugA, seededDocumentTypes: [] });
  });

  it('permissions_slug_rules_and_conflict', async () => {
    for (const who of ['masterData', 'buyer'] as const) {
      expect((await h.call(who, 'PUT', '/api/v1/settings/supplier-applications', { body: { enabled: false } })).status, who).toBe(403);
      expect((await h.call(who, 'POST', '/api/v1/settings/supplier-document-types', { body: { code: 'X_Y', name: 'Deneme' } })).status, who).toBe(403);
    }
    for (const who of ['auditor', 'techEval', 'supplier1'] as const) {
      expect((await h.call(who, 'GET', '/api/v1/settings/supplier-applications')).status, who).toBe(403);
    }
    expect((await h.call('tenantAdmin', 'PUT', '/api/v1/settings/supplier-applications', { body: { enabled: true, publicSlug: 'AB' } })).body.error.code).toBe('invalid_slug');
    expect((await h.call('tenantAdmin', 'PUT', '/api/v1/settings/supplier-applications', { body: { enabled: true, publicSlug: null } })).body.error.code).toBe('slug_required');
    const taken = await h.call('tenantAdmin', 'PUT', '/api/v1/settings/supplier-applications', { body: { enabled: true, publicSlug: slugB } });
    expect(taken.status).toBe(409);
    expect(taken.body.error.code).toBe('slug_taken');
    noLeak(h, JSON.stringify(taken.body));
    expect((await h.call('tenantAdmin', 'GET', '/api/v1/settings/supplier-applications')).body).toMatchObject({ publicSlug: slugA, can: { manage: true } });
  });

  it('document_types_create_update_no_delete', async () => {
    const code = `KVKK_${rand().toUpperCase()}`;
    const c = await h.call('tenantAdmin', 'POST', '/api/v1/settings/supplier-document-types', { body: { code, name: 'KVKK taahhütnamesi', required: false } });
    expect(c.status, JSON.stringify(c.body)).toBe(201);
    expect(c.body).toMatchObject({ code, name: 'KVKK taahhütnamesi', required: false, requiredCategories: [], expiryRequired: false, active: true });
    expect((await h.call('tenantAdmin', 'POST', '/api/v1/settings/supplier-document-types', { body: { code, name: 'Tekrar' } })).body.error.code).toBe('code_taken');
    let cfg = await pub(h, 'GET', `/api/v1/public/applications/${slugA}/config`);
    expect(cfg.body.documentTypes.some((d: any) => d.code === code)).toBe(true);
    const u = await h.call('tenantAdmin', 'PUT', `/api/v1/settings/supplier-document-types/${c.body.id}`, { body: { active: false, name: 'KVKK taahhütnamesi (eski)' } });
    expect(u.status).toBe(200);
    expect(u.body).toMatchObject({ code, active: false, name: 'KVKK taahhütnamesi (eski)' });
    // Kod değiştirilemez; silme ucu yok.
    expect((await h.call('tenantAdmin', 'PUT', `/api/v1/settings/supplier-document-types/${c.body.id}`, { body: { code: 'BASKA' } })).status).toBe(400);
    expect((await h.call('tenantAdmin', 'DELETE', `/api/v1/settings/supplier-document-types/${c.body.id}`)).status).toBe(404);
    cfg = await pub(h, 'GET', `/api/v1/public/applications/${slugA}/config`);
    expect(cfg.body.documentTypes.some((d: any) => d.code === code)).toBe(false);
    const ev = (await h.owner.query(`SELECT data->>'action' AS a FROM audit_events WHERE tenant_id = $1 AND action = 'supplier_document_type.saved' AND entity_id = $2 ORDER BY id`,
      [h.world.tenantA, c.body.id])).rows.map((r) => r.a);
    expect(ev).toEqual(['created', 'updated']);
    // Başka kiracının türü güncellenemez.
    const bType = (await h.owner.query(`SELECT id FROM supplier_document_types WHERE tenant_id = $1`, [h.world.tenantB])).rows[0].id;
    expect((await h.call('tenantAdmin', 'PUT', `/api/v1/settings/supplier-document-types/${bType}`, { body: { active: false } })).status).toBe(404);
  });
});

describe('Girişsiz yapılandırma', () => {
  it('open_config_has_no_internal_and_closed_or_unknown_is_uniform', async () => {
    const r = await pub(h, 'GET', `/api/v1/public/applications/${slugA}/config`);
    expect(r.status).toBe(200);
    expect(Object.keys(r.body).sort()).toEqual(['categories', 'documentTypes', 'enabled', 'limits', 'organizationName']);
    expect(r.body.limits).toEqual({ maxFiles: 10, maxFileBytes: 10485760, maxTotalBytes: 41943040, types: ['application/pdf', 'image/jpeg', 'image/png'] });
    expect(Object.keys(r.body.documentTypes[0]).sort()).toEqual(['code', 'expiryRequired', 'name', 'required', 'requiredCategories']);
    expect(r.raw).not.toContain('internal');
    expect(r.raw).not.toContain(h.world.tenantA);
    for (const slug of [slugClosed, 'yok-boyle-adres', 'X']) {
      const c = await pub(h, 'GET', `/api/v1/public/applications/${slug}/config`);
      expect(c.status, slug).toBe(200);
      expect(c.body).toEqual({ enabled: false });
    }
  });
});

describe('POST /api/v1/public/applications/:slug', () => {
  it('full_application_202_outbox_not_configured_documents_stored', async () => {
    const f = fields({ categories: 'Bilgi teknolojileri' }, [['validUntil[ISO27001]', '2028-01-15']]);
    const email = f.find(([k]) => k === 'contactEmail')![1];
    const r = await apply(h, slugA, f, [...BASE_DOCS(), doc('ISO27001')]);
    expect(r.status, r.raw).toBe(202);
    expect(r.body).toEqual({ message: 'Başvurunuz alındı. Doğrulama e-postası gönderilmedi.', mailChannel: 'NOT_CONFIGURED',
      note: 'E-posta kanalı yapılandırılmadı; kurum yöneticisi başvurunuzu e-posta kutusundan görebilir.' });
    noLeak(h, r.raw);
    const [a] = await appByEmail(h, email);
    expect(a).toMatchObject({ tenant_id: h.world.tenantA, status: 'UNVERIFIED' });
    const { outbox, token } = await tokenFromOutbox(h, email);
    expect(outbox.status).toBe('NOT_CONFIGURED');
    expect(outbox.body_text).toContain(`${h.config.webOrigin}/basvuru/dogrula#token=`);
    expect(outbox.body_text).not.toMatch(/[?&]token=/);
    expect(Buffer.from(token, 'base64url')).toHaveLength(32);
    // Veritabanında belirteç değil özeti; adres yalnız özet.
    const row = (await h.owner.query(`SELECT token_hash, ip_hash FROM supplier_applications WHERE id = $1`, [a.id])).rows[0];
    expect(row.token_hash.equals(createHash('sha256').update(Buffer.from(token, 'base64url')).digest())).toBe(true);
    expect(row.ip_hash).toHaveLength(32);
    const docs = (await h.owner.query(`SELECT type_code, mime_type, av_scan_status, basic_check_status, valid_until::text AS v, storage_key, uploaded_via
      FROM supplier_documents WHERE application_id = $1 ORDER BY type_code`, [a.id])).rows;
    expect(docs.map((d) => d.type_code)).toEqual(['FAALIYET_BELGESI', 'IMZA_SIRKULERI', 'ISO27001', 'TICARET_SICIL_GAZETESI', 'VERGI_LEVHASI']);
    expect(docs.every((d) => d.av_scan_status === 'NOT_CONFIGURED' && d.basic_check_status === 'PASSED' && d.uploaded_via === 'APPLICATION')).toBe(true);
    expect(docs.find((d) => d.type_code === 'ISO27001').v).toBe('2028-01-15');
    expect(docs.find((d) => d.type_code === 'IMZA_SIRKULERI').v).toBeNull();
    expect(await h.store.exists(docs[0].storage_key)).toBe(true);
    expect(docs[0].storage_key.startsWith(`t/${h.world.tenantA}/supplier-documents/`)).toBe(true);
    // Süre dolumu işi kuruldu (24 saat sonra).
    expect((await h.owner.query(`SELECT count(*)::int AS n FROM jobs WHERE kind = 'supplier_application.expire' AND idempotency_key = $1 AND run_after > now() + interval '23 hours'`,
      [`expire:${a.id}`])).rows[0].n).toBe(1);
  });

  it('verify_submits_opens_procurement_task_and_second_verify_410', async () => {
    const f = fields();
    const email = f.find(([k]) => k === 'contactEmail')![1];
    expect((await apply(h, slugA, f)).status).toBe(202);
    const { token } = await tokenFromOutbox(h, email);
    const v = await pub(h, 'POST', '/api/v1/public/applications/verify', { body: { token } });
    expect(v.status, v.raw).toBe(200);
    expect(v.body).toEqual({ status: 'SUBMITTED' });
    noLeak(h, v.raw);
    const [a] = await appByEmail(h, email);
    expect(a.status).toBe('SUBMITTED');
    await runJobs(h);
    const tasks = await h.call('masterData', 'GET', '/api/v1/tasks?view=mine');
    const t = tasks.body.items.find((i: any) => i.entityId === a.id);
    expect(t).toMatchObject({ title: 'Tedarikçi başvurusu inceleme bekliyor', assigneeRole: 'PROCUREMENT', entityType: 'supplier_application', kind: 'supplier_application_review' });
    expect((await h.owner.query(`SELECT dedupe_key FROM tasks WHERE entity_id = $1`, [a.id])).rows.map((r) => r.dedupe_key)).toEqual([`application:${a.id}:review`]);
    // B kiracısının Satınalma'sı görmez.
    expect((await h.call('buyerB', 'GET', '/api/v1/tasks?view=mine', { tenant: h.world.tenantB })).body.items.some((i: any) => i.entityId === a.id)).toBe(false);

    const again = await pub(h, 'POST', '/api/v1/public/applications/verify', { body: { token } });
    expect(again.status).toBe(410);
    expect(again.body.error.code).toBe('token_invalid');
    for (const bad of ['kisa', 'A'.repeat(43), '../../etc']) {
      const r = await pub(h, 'POST', '/api/v1/public/applications/verify', { body: { token: bad } });
      expect(r.status, bad).toBe(410);
      expect(r.body).toEqual(again.body); // ayrım yok
    }
  });

  it('sixth_request_from_same_address_429_with_retry_after_and_honeypot_writes_nothing', async () => {
    const ip = nextIp();
    const email = `tuzak-${rand()}@example.test`;
    const ok = [];
    for (let i = 0; i < 5; i++) {
      const r = await apply(h, slugA, fields({ contactEmail: email, website: 'http://spam.example.test' }), BASE_DOCS(), ip);
      ok.push(r);
    }
    expect(ok.map((r) => r.status)).toEqual([202, 202, 202, 202, 202]);
    // Tuzak yanıtı gerçek başvurunun yanıtıyla aynı biçimde.
    expect(ok[0]!.body).toEqual({ message: 'Başvurunuz alındı. Doğrulama e-postası gönderilmedi.', mailChannel: 'NOT_CONFIGURED',
      note: 'E-posta kanalı yapılandırılmadı; kurum yöneticisi başvurunuzu e-posta kutusundan görebilir.' });
    expect(await appByEmail(h, email)).toHaveLength(0);
    expect((await h.owner.query(`SELECT count(*)::int AS n FROM email_outbox WHERE to_email = $1`, [email])).rows[0].n).toBe(0);
    const sixth = await apply(h, slugA, fields(), BASE_DOCS(), ip);
    expect(sixth.status).toBe(429);
    expect(Number(sixth.headers['retry-after'])).toBeGreaterThan(0);
    expect(sixth.body.error.code).toBe('rate_limited');
    // Uç başına ayrı kova: aynı adresten doğrulama ucu açık.
    expect((await pub(h, 'POST', '/api/v1/public/applications/verify', { body: { token: 'x' }, ip })).status).toBe(410);
  });

  it('zip_exe_and_11mb_rejected_422_nothing_written', async () => {
    const cases: [string, FilePart][] = [
      ['file_rejected', { field: 'documents[IMZA_SIRKULERI]', name: 'arsiv.zip', mime: 'application/zip', data: Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.alloc(200)]) }],
      ['file_rejected', { field: 'documents[IMZA_SIRKULERI]', name: 'kurulum.exe', mime: 'application/x-msdownload', data: Buffer.concat([Buffer.from('MZ'), Buffer.alloc(200)]) }],
      ['file_rejected', { field: 'documents[IMZA_SIRKULERI]', name: 'sahte.pdf', mime: 'application/pdf', data: Buffer.concat([Buffer.from('MZ'), Buffer.alloc(200)]) }],
      ['file_too_large', doc('IMZA_SIRKULERI', pdf(11 * 1024 * 1024))],
    ];
    for (const [code, bad] of cases) {
      const f = fields();
      const email = f.find(([k]) => k === 'contactEmail')![1];
      const files = BASE_DOCS().filter((d) => d.field !== 'documents[IMZA_SIRKULERI]');
      const r = await apply(h, slugA, f, [...files, bad]);
      expect(r.status, `${bad.name}: ${r.raw}`).toBe(422);
      expect(r.body.error.code, bad.name).toBe(code);
      expect(await appByEmail(h, email)).toHaveLength(0);
    }
  });

  it('missing_required_documents_422_with_list', async () => {
    const f = fields({ categories: 'Bilgi teknolojileri' });
    const r = await apply(h, slugA, f, [doc('VERGI_LEVHASI'), doc('IMZA_SIRKULERI')]);
    expect(r.status).toBe(422);
    expect(r.body.error.code).toBe('documents_missing');
    expect(r.body.error.details.documents.map((d: any) => d.code).sort()).toEqual(['FAALIYET_BELGESI', 'ISO27001', 'TICARET_SICIL_GAZETESI']);
    expect(r.body.error.message).toContain('Ticaret sicil gazetesi');
    // Geçerlilik tarihi zorunlu tür tarihsiz → 422.
    const noDate = await apply(h, slugA, fields().filter(([k]) => k !== 'validUntil[FAALIYET_BELGESI]'));
    expect(noDate.body.error.code).toBe('valid_until_required');
    expect(noDate.body.error.details.documents).toEqual([{ code: 'FAALIYET_BELGESI', name: 'Faaliyet belgesi' }]);
    // Tanınmayan tür.
    expect((await apply(h, slugA, fields(), [...BASE_DOCS(), doc('YOK_BOYLE')])).body.error.code).toBe('document_type');
  });

  it('tax_id_checksum_422_and_field_checks', async () => {
    const f = fields();
    const email = f.find(([k]) => k === 'contactEmail')![1];
    const vkn = f.find(([k]) => k === 'taxId')![1];
    const r = await apply(h, slugA, f.map(([k, v]) => [k, k === 'taxId' ? badVkn(vkn) : v] as [string, string]));
    expect(r.status).toBe(422);
    expect(r.body.error).toMatchObject({ code: 'invalid_tax_id', details: { reason: 'CHECKSUM' } });
    expect(await appByEmail(h, email)).toHaveLength(0);
    expect((await apply(h, slugA, fields({ taxId: '123' }))).body.error.code).toBe('invalid_tax_id');
    expect((await apply(h, slugA, fields({ contactEmail: 'gecersiz' }))).body.error).toMatchObject({ code: 'invalid_field', details: { field: 'contactEmail' } });
    expect((await apply(h, slugA, fields({ categories: 'Uzay madenciliği' }))).body.error).toMatchObject({ code: 'invalid_field', details: { field: 'categories' } });
  });

  it('closed_settings_config_disabled_and_post_404_without_tenant_name', async () => {
    const r = await apply(h, slugClosed, fields());
    expect(r.status).toBe(404);
    expect(r.body).toEqual({ error: { code: 'applications_closed', message: 'Başvuru şu an kabul edilmiyor.' } });
    noLeak(g, r.raw);
    expect((await apply(h, 'yok-boyle-adres', fields())).body).toEqual(r.body);
  });

  it('existing_supplier_tax_id_accepted_without_revealing_registration', async () => {
    const existing = (await h.owner.query(`SELECT tax_id FROM suppliers WHERE id = $1`, [h.world.suppliers.s1])).rows[0].tax_id as string;
    const f1 = fields({ taxId: existing });
    const known = await apply(h, slugA, f1);
    const fresh = await apply(h, slugA, fields());
    expect(known.status, known.raw).toBe(202);
    expect(fresh.status).toBe(202);
    expect(known.body).toEqual(fresh.body);
    expect(Object.keys(known.headers).sort()).toEqual(Object.keys(fresh.headers).sort());
    const [a] = await appByEmail(h, f1.find(([k]) => k === 'contactEmail')![1]);
    expect(a.tax_id).toBe(existing);
    // Aynı kimlikle açık ikinci başvuru 409 (genel ileti; R2).
    const dup = await apply(h, slugA, fields({ taxId: existing }));
    expect(dup.status).toBe(409);
    expect(dup.body.error).toEqual({ code: 'application_exists', message: 'Bu bilgilerle bekleyen bir başvuru var; e-postanızı kontrol edin.' });
  });

  it('slug_routes_to_its_tenant_and_other_tenant_cannot_see', async () => {
    const f = fields();
    const email = f.find(([k]) => k === 'contactEmail')![1];
    const r = await apply(h, slugB, f, [doc('VERGI_LEVHASI')]);
    expect(r.status, r.raw).toBe(202);
    const [a] = await appByEmail(h, email);
    expect(a.tenant_id).toBe(h.world.tenantB);
    await withTenant(h.pool, internal(h, 'A'), async (tx) => {
      expect((await tx.query(`SELECT id FROM supplier_applications WHERE id = $1`, [a.id])).rowCount).toBe(0);
      expect((await tx.query(`SELECT id FROM supplier_documents WHERE application_id = $1`, [a.id])).rowCount).toBe(0);
      expect((await tx.query(`SELECT id FROM email_outbox WHERE related_id = $1`, [a.id])).rowCount).toBe(0);
    });
    await withTenant(h.pool, internal(h, 'B'), async (tx) => {
      expect((await tx.query(`SELECT id FROM supplier_applications WHERE id = $1`, [a.id])).rowCount).toBe(1);
    });
    // A'nın Yöneticisi e-posta kutusunda B'nin doğrulama iletisini görmez.
    const box = await h.call('tenantAdmin', 'GET', '/api/v1/admin/email-outbox?relatedType=supplier_application&limit=200');
    expect(box.body.items.some((i: any) => i.relatedId === a.id)).toBe(false);
  });

  it('worker_expires_unverified_after_24h', async () => {
    const f = fields();
    const email = f.find(([k]) => k === 'contactEmail')![1];
    expect((await apply(h, slugA, f)).status).toBe(202);
    const [a] = await appByEmail(h, email);
    await h.owner.query(`UPDATE supplier_applications SET token_expires_at = now() - interval '1 minute' WHERE id = $1`, [a.id]);
    await h.owner.query(`UPDATE jobs SET run_after = now() WHERE kind = 'supplier_application.expire' AND idempotency_key = $1`, [`expire:${a.id}`]);
    await runJobs(h);
    const row = (await h.owner.query(`SELECT status, token_hash, (SELECT count(*)::int FROM supplier_documents d WHERE d.application_id = a.id) AS docs
      FROM supplier_applications a WHERE id = $1`, [a.id])).rows[0];
    expect(row).toEqual({ status: 'EXPIRED', token_hash: null, docs: 4 });
    expect((await h.owner.query(`SELECT status, result FROM jobs WHERE idempotency_key = $1`, [`expire:${a.id}`])).rows[0]).toMatchObject({ status: 'SUCCEEDED' });
  });
});

describe('Eksik belge tamamlama', () => {
  it('complete_info_by_header_and_only_requested_types', async () => {
    const f = fields();
    const email = f.find(([k]) => k === 'contactEmail')![1];
    expect((await apply(h, slugA, f)).status).toBe(202);
    const { token: vt } = await tokenFromOutbox(h, email);
    expect((await pub(h, 'POST', '/api/v1/public/applications/verify', { body: { token: vt } })).status).toBe(200);
    const [a] = await appByEmail(h, email);
    // Satınalma eksik belge ister (Görev 5 bu adımı API'ye taşır; burada sp_app ile).
    const raw = Buffer.from(Array.from({ length: 32 }, () => Math.floor(Math.random() * 256)));
    const ct = raw.toString('base64url');
    await withTenant(h.pool, internal(h, 'A'), (tx) => tx.query(`UPDATE supplier_applications SET status = 'NEEDS_DOCUMENTS', token_hash = $2, token_purpose = 'COMPLETE',
      token_expires_at = now() + interval '24 hours', requested_documents = '{ISO27001}', requested_note = 'ISO belgesini ekleyin.', row_version = row_version + 1 WHERE id = $1`,
      [a.id, createHash('sha256').update(raw).digest()]));

    expect((await pub(h, 'GET', '/api/v1/public/applications/complete-info')).status).toBe(410);
    // Tamamlama belirteci doğrulama ucunda geçmez.
    expect((await pub(h, 'POST', '/api/v1/public/applications/verify', { body: { token: ct } })).status).toBe(410);
    const info = await pub(h, 'GET', '/api/v1/public/applications/complete-info', { headers: { 'x-application-token': ct } });
    expect(info.status, info.raw).toBe(200);
    expect(info.body).toEqual({ legalName: 'Deneme Bilişim Ltd. Şti. (SENTETİK)', note: 'ISO belgesini ekleyin.',
      requestedDocuments: [{ code: 'ISO27001', name: 'ISO 27001', expiryRequired: true }],
      limits: { maxFiles: 10, maxFileBytes: 10485760, maxTotalBytes: 41943040, types: ['application/pdf', 'image/jpeg', 'image/png'] } });
    noLeak(h, info.raw);

    const send = async (files: FilePart[], extra: [string, string][] = []) => {
      const m = multipart(extra, files);
      const res = await h.app.inject({ method: 'POST', url: '/api/v1/public/applications/complete', payload: m.payload, remoteAddress: nextIp(),
        headers: { 'content-type': m.contentType, 'x-application-token': ct } });
      return { status: res.statusCode, body: safe(res.body), raw: res.body };
    };
    expect((await send([doc('IMZA_SIRKULERI')])).body.error.code).toBe('document_type');
    expect((await send([doc('ISO27001')])).body.error.code).toBe('valid_until_required');
    const ok = await send([doc('ISO27001')], [['validUntil[ISO27001]', '2028-03-01']]);
    expect(ok.status, ok.raw).toBe(200);
    expect(ok.body).toEqual({ status: 'SUBMITTED' });
    noLeak(h, ok.raw);
    expect((await h.owner.query(`SELECT status FROM supplier_applications WHERE id = $1`, [a.id])).rows[0].status).toBe('SUBMITTED');
    expect((await h.owner.query(`SELECT count(*)::int AS n FROM supplier_documents WHERE application_id = $1 AND type_code = 'ISO27001'`, [a.id])).rows[0].n).toBe(1);
    // Tek kullanımlık.
    expect((await send([doc('ISO27001')], [['validUntil[ISO27001]', '2028-03-01']])).status).toBe(410);
  });
});

describe('Graph kanalı ve virüs taraması (sahte clamd)', () => {
  it('graph_channel_queues_row_and_dispatch_job', async () => {
    clam.mode = 'ok';
    const f = fields();
    const email = f.find(([k]) => k === 'contactEmail')![1];
    const r = await apply(g, slugG, f);
    expect(r.status, r.raw).toBe(202);
    expect(r.body).toEqual({ message: 'Başvurunuz alındı. Doğrulama e-postası gönderildi; e-postadaki bağlantıyla 24 saat içinde doğrulayın.', mailChannel: 'QUEUED', note: null });
    const { outbox } = await tokenFromOutbox(g, email);
    expect(outbox.status).toBe('QUEUED');
    expect((await g.owner.query(`SELECT count(*)::int AS n FROM jobs WHERE kind = 'email.dispatch' AND tenant_id = $1 AND payload->>'outboxId' = $2`,
      [g.world.tenantA, outbox.id])).rows[0].n).toBe(1);
    const [a] = await appByEmail(g, email);
    expect((await g.owner.query(`SELECT DISTINCT av_scan_status FROM supplier_documents WHERE application_id = $1`, [a.id])).rows).toEqual([{ av_scan_status: 'CLEAN' }]);
  });

  it('infected_file_422_nothing_written_and_scan_error_quarantined_with_task', async () => {
    clam.mode = 'found';
    const f = fields();
    const email = f.find(([k]) => k === 'contactEmail')![1];
    const r = await apply(g, slugG, f);
    expect(r.status).toBe(422);
    expect(r.body.error.code).toBe('file_infected');
    expect(await appByEmail(g, email)).toHaveLength(0);

    clam.mode = 'error';
    const f2 = fields();
    const email2 = f2.find(([k]) => k === 'contactEmail')![1];
    expect((await apply(g, slugG, f2)).status).toBe(202);
    const [a] = await appByEmail(g, email2);
    const docs = (await g.owner.query(`SELECT av_scan_status, basic_check_status FROM supplier_documents WHERE application_id = $1`, [a.id])).rows;
    expect(docs.every((d) => d.av_scan_status === 'ERROR' && d.basic_check_status === 'QUARANTINED')).toBe(true);
    const { token } = await tokenFromOutbox(g, email2);
    expect((await pub(g, 'POST', '/api/v1/public/applications/verify', { body: { token } })).status).toBe(200);
    await runJobs(g);
    const keys = (await g.owner.query(`SELECT dedupe_key FROM tasks WHERE entity_id = $1 ORDER BY dedupe_key`, [a.id])).rows.map((x) => x.dedupe_key);
    expect(keys).toEqual([`application:${a.id}:av_error`, `application:${a.id}:review`]);
    clam.mode = 'ok';
  });
});

describe('PublicRateLimiter', () => {
  it('per_endpoint_per_address_buckets_refill_hourly', () => {
    let now = 0;
    const l = new PublicRateLimiter({ applyPerHour: 2, tokenPerHour: 3 }, () => now);
    expect(l.check('apply', 'POST /a', '1.1.1.1')).toBeNull();
    expect(l.check('apply', 'POST /a', '1.1.1.1')).toBeNull();
    expect(l.check('apply', 'POST /a', '1.1.1.1')).toBe(1800);
    expect(l.check('apply', 'POST /a', '2.2.2.2')).toBeNull();
    expect(l.check('token', 'POST /v', '1.1.1.1')).toBeNull();
    now = 1_800_000;
    expect(l.check('apply', 'POST /a', '1.1.1.1')).toBeNull();
  });
  it('config_from_env', () => {
    expect(loadPublicRateLimit({})).toEqual({ applyPerHour: 5, tokenPerHour: 20 });
    expect(loadPublicRateLimit({ PUBLIC_APPLY_PER_HOUR: '50', PUBLIC_TOKEN_PER_HOUR: '100' })).toEqual({ applyPerHour: 50, tokenPerHour: 100 });
    expect(() => loadPublicRateLimit({ PUBLIC_APPLY_PER_HOUR: '0' })).toThrow(/PUBLIC_APPLY_PER_HOUR/);
  });
});
