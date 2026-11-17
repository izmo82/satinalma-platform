// v2 Faz 5 (D110) Görev 6: tedarikçi belgesi hatırlatmaları (R12) — 30/7/0 gün, portal kullanıcılarına e-posta, bitiş gününde Satınalma
// görevi, tekil satır (işçi tekrarında çift yok), yenilenmiş belgeye hatırlatma yok, 052b kiracı kapısı ve günlük işçi kapısı. Gerçek PostgreSQL + RLS.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomBytes, randomUUID } from 'node:crypto';
import { DevAuthProvider } from '../src/auth.ts';
import { withTenant } from '../src/db.ts';
import { systemContext } from '../src/modules/contractReminders.ts';
import { dailyDocumentReminders, DOC_REMINDER_JOB, dueOffset, enqueueDocumentReminders, processDocumentReminderJob, reminderTenants, runDocumentReminders } from '../src/modules/supplierDocReminders.ts';
import { makeHarness } from './harness.ts';

type H = Awaited<ReturnType<typeof makeHarness>>;
let h: H;
const rand = () => randomUUID().slice(0, 8);
const D = '2026-12-10';
const addDays = (day: string, n: number) => new Date(Date.parse(`${day}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

async function newSupplier(status = 'ACTIVE') {
  const active = ['ACTIVE', 'CONDITIONAL'].includes(status);
  const vkn = `7${String(Math.floor(Math.random() * 1e9)).padStart(9, '0')}`;
  return (await h.owner.query<{ id: string }>(`INSERT INTO suppliers (tenant_id, status, country, tax_id_type, tax_id, legal_name, created_by, identity_review_required, activated_by, activated_at)
    VALUES ($1,$2,'TR','VKN',$3,$4,$5,true,$6,$7) RETURNING id`, [h.world.tenantA, status, vkn, `Hatırlatma Firma ${rand()} (SENTETİK)`, h.world.users.masterData.id,
    active ? h.world.users.legal.id : null, active ? new Date() : null])).rows[0]!.id;
}
async function portalUser(supplierId: string, status = 'ACTIVE') {
  const email = `hatirlatma-${rand()}@example.test`;
  const id = (await h.owner.query<{ id: string }>(`INSERT INTO users (auth_subject, email, display_name) VALUES ($1,$2,'Portal Kişisi (SENTETİK)') RETURNING id`, [`dev|${email}`, email])).rows[0]!.id;
  await h.owner.query(`INSERT INTO memberships (tenant_id, user_id, roles, company_ids, supplier_id, status) VALUES ($1,$2,ARRAY['SUPPLIER'],'{}',$3,$4)`, [h.world.tenantA, id, supplierId, status]);
  return { id, email };
}
async function doc(supplierId: string, typeCode: string, validUntil: string | null) {
  return (await h.owner.query<{ id: string }>(`INSERT INTO supplier_documents (tenant_id, supplier_id, type_code, title, original_filename, mime_type, size_bytes, sha256,
      storage_key, basic_check_status, av_scan_status, valid_until, uploaded_via, uploaded_by)
    VALUES ($1,$2,$3,'Belge (SENTETİK)','belge.pdf','application/pdf',1000,$4,$5,'PASSED','NOT_CONFIGURED',$6,'INTERNAL',$7) RETURNING id`,
    [h.world.tenantA, supplierId, typeCode, randomBytes(32).toString('hex'), `t/${h.world.tenantA}/supplier-documents/${randomUUID()}`, validUntil, h.world.users.buyer.id])).rows[0]!.id;
}
const run = (day: string) => {
  const ctx = systemContext(h.world.tenantA, [], `rem-${day}`);
  return withTenant(h.pool, ctx, (tx) => runDocumentReminders(tx, ctx, day, 'http://localhost:5174'));
};
const reminders = async (docId: string) => (await h.owner.query(`SELECT offset_days, due_on::text, email_outbox_id IS NOT NULL AS mailed, task_id IS NOT NULL AS tasked
  FROM supplier_document_reminders WHERE document_id = $1 ORDER BY offset_days DESC`, [docId])).rows;
const mails = async (docId: string) => (await h.owner.query(`SELECT to_user_id, subject, body_text, status FROM email_outbox WHERE related_type = 'supplier_document' AND related_id = $1 ORDER BY created_at`, [docId])).rows;
const tasks = async (docId: string) => (await h.owner.query(`SELECT title, assignee_role, status FROM tasks WHERE dedupe_key = $1`, [`doc:${docId}:expired`])).rows;

async function internalUpload(supplierId: string, fields: Record<string, string>) {
  const b = '----sprem' + randomUUID();
  const parts = Object.entries(fields).map(([k, v]) => Buffer.from(`--${b}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`));
  const body = Buffer.concat([...parts,
    Buffer.from(`--${b}\r\nContent-Disposition: form-data; name="file"; filename="belge.pdf"\r\nContent-Type: application/pdf\r\n\r\n`),
    Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.alloc(600, 0x20), Buffer.from(`\n% ${randomUUID()}\n%%EOF`)]), Buffer.from(`\r\n--${b}--\r\n`)]);
  return h.app.inject({ method: 'POST', url: `/api/v1/suppliers/${supplierId}/documents`, payload: body,
    headers: { authorization: `Bearer ${await new DevAuthProvider('test-secret-'.padEnd(40, 'x')).issue(`dev|${h.world.users.buyer.email}`)}`,
      'x-tenant-id': h.world.tenantA, 'content-type': `multipart/form-data; boundary=${b}` } });
}

beforeAll(async () => {
  h = await makeHarness();
  const put = await h.call('tenantAdmin', 'PUT', '/api/v1/settings/supplier-applications', { body: { enabled: true, publicSlug: `hr-${rand()}`, categories: ['Bilgi teknolojileri'] } });
  expect(put.status).toBe(200);
});
afterAll(async () => { await h?.close(); });

describe('dueOffset', () => {
  it('nearest_due_offset_within_catch_up_window', () => {
    expect(dueOffset(addDays(D, 30), D)).toBe(30);
    expect(dueOffset(addDays(D, 7), D)).toBe(7);
    expect(dueOffset(D, D)).toBe(0);
    expect(dueOffset(addDays(D, 20), D)).toBeNull();
    expect(dueOffset(addDays(D, 25), D)).toBe(30); // 5 gün geç: telafi
    expect(dueOffset(addDays(D, -6), D)).toBe(0);
    expect(dueOffset(addDays(D, -7), D)).toBeNull(); // çok eski: atlanır
  });
});

describe('R12 belge hatırlatmaları', () => {
  it('writes_rows_emails_and_expiry_task_once_and_skips_renewed', async () => {
    const s = await newSupplier();
    const u = await portalUser(s);
    await portalUser(s, 'SUSPENDED');
    const d30 = await doc(s, 'VERGI_LEVHASI', addDays(D, 30));
    const d7 = await doc(s, 'FAALIYET_BELGESI', addDays(D, 7));
    const d0 = await doc(s, 'ISO27001', D);
    // Yenilenmiş (yerine yenisi yüklenmiş) belge.
    const oldRenewed = await doc(s, 'IMZA_SIRKULERI', addDays(D, 7));
    const newRenewed = await doc(s, 'IMZA_SIRKULERI', addDays(D, 400));
    await h.owner.query(`UPDATE supplier_documents SET superseded_by_id = $2 WHERE id = $1`, [oldRenewed, newRenewed]);
    // Aynı türde daha geç geçerli ikinci güncel belge (replacesId olmadan yenilenmiş).
    const covered = await doc(s, 'TICARET_SICIL_GAZETESI', addDays(D, 7));
    await doc(s, 'TICARET_SICIL_GAZETESI', addDays(D, 500));

    const r1 = await run(D);
    expect(r1.reminders).toBeGreaterThanOrEqual(3);
    expect(await reminders(d30)).toEqual([{ offset_days: 30, due_on: D, mailed: true, tasked: false }]);
    expect(await reminders(d7)).toEqual([{ offset_days: 7, due_on: D, mailed: true, tasked: false }]);
    expect(await reminders(d0)).toEqual([{ offset_days: 0, due_on: D, mailed: true, tasked: true }]);
    expect(await reminders(oldRenewed)).toEqual([]);
    expect(await reminders(covered)).toEqual([]);

    const m30 = await mails(d30);
    expect(m30).toHaveLength(1); // askıdaki kullanıcıya yok
    expect(m30[0]).toMatchObject({ to_user_id: u.id, subject: 'Belge süresi yaklaşıyor: Vergi levhası', status: 'NOT_CONFIGURED' });
    expect(m30[0].body_text).toContain('30 gün sonra');
    expect(m30[0].body_text).toContain('http://localhost:5174/portal/belgeler');
    expect((await mails(d0))[0].subject).toBe('Belge süresi doluyor: ISO 27001');
    expect(await tasks(d0)).toEqual([{ title: 'Tedarikçi belgesinin süresi doldu', assignee_role: 'PROCUREMENT', status: 'OPEN' }]);
    expect(await tasks(d7)).toEqual([]);

    // İşçi tekrarı: çift satır, e-posta ya da görev yok.
    await run(D);
    expect(await reminders(d0)).toHaveLength(1);
    expect(await mails(d0)).toHaveLength(1);
    expect((await h.owner.query(`SELECT count(*)::int AS n FROM tasks WHERE dedupe_key = $1`, [`doc:${d0}:expired`])).rows[0].n).toBe(1);

    // 7 gün kala ikinci hatırlatma ve bitiş günü görevi aynı belgeye ayrı satır.
    await run(addDays(D, 23));
    expect((await reminders(d30)).map((x: any) => x.offset_days)).toEqual([30, 7]);
    await run(addDays(D, 30));
    expect((await reminders(d30)).map((x: any) => x.offset_days)).toEqual([30, 7, 0]);
    expect(await tasks(d30)).toHaveLength(1);
  });

  it('passive_supplier_skipped_and_missing_portal_user_still_gets_task', async () => {
    const passive = await newSupplier('SUSPENDED');
    await portalUser(passive, 'SUSPENDED');
    const pd = await doc(passive, 'VERGI_LEVHASI', D);
    const lonely = await newSupplier('CANDIDATE');
    const ld = await doc(lonely, 'VERGI_LEVHASI', D);
    const r = await run(D);
    expect(await reminders(pd)).toEqual([]);
    expect(await reminders(ld)).toEqual([{ offset_days: 0, due_on: D, mailed: false, tasked: true }]);
    expect(await mails(ld)).toEqual([]);
    expect(r.withoutPortalUser).toBeGreaterThanOrEqual(1);
  });

  it('job_marks_succeeded', async () => {
    const day = '2026-12-20';
    const job = (await h.owner.query<{ id: string }>(`INSERT INTO jobs (tenant_id, kind, idempotency_key, payload, requested_by, status, attempts)
      VALUES ($1,$2,$3,$4,NULL,'RUNNING',1) RETURNING id`, [h.world.tenantA, DOC_REMINDER_JOB, `doc-reminders:test-${rand()}`, { day }])).rows[0]!.id;
    const r = await processDocumentReminderJob(h.pool, h.world.tenantA, job, { webOrigin: 'http://localhost:5174', now: new Date(`${day}T09:00:00+03:00`) });
    expect(r.day).toBe(day);
    expect((await h.owner.query(`SELECT status, result->>'day' AS day FROM jobs WHERE id = $1`, [job])).rows[0]).toEqual({ status: 'SUCCEEDED', day });
  });

  it('tenant_gate_052b_lists_only_tenants_with_dated_documents_and_enqueues_once_per_day', async () => {
    // Kapı yalnız kiracı kimliği döner; A'da tarihli belge var (önceki testler), B'de yok.
    const tenants = await reminderTenants(h.pool);
    expect(tenants).toContain(h.world.tenantA);
    expect(tenants).not.toContain(h.world.tenantB);
    const fn = (await h.owner.query(`SELECT prosecdef, proconfig FROM pg_proc WHERE proname = 'supplier_document_reminder_tenants'`)).rows[0];
    expect(fn.prosecdef).toBe(true);
    expect(fn.proconfig).toEqual(['search_path=public, pg_temp']);
    const now = new Date('2031-01-15T08:00:00+03:00');
    const onlyA = async () => [h.world.tenantA];
    expect(await enqueueDocumentReminders(h.pool, now, onlyA)).toBe(1);
    expect(await enqueueDocumentReminders(h.pool, now, onlyA)).toBe(0);
    const row = (await h.owner.query(`SELECT status, payload->>'day' AS day FROM jobs WHERE tenant_id = $1 AND kind = $2 AND idempotency_key = 'doc-reminders:2031-01-15'`,
      [h.world.tenantA, DOC_REMINDER_JOB])).rows;
    expect(row).toEqual([{ status: 'QUEUED', day: '2031-01-15' }]);
    // İşçi kapısı İstanbul gününde bir kez tarar.
    let calls = 0;
    const gate = dailyDocumentReminders(async () => { calls++; return 0; });
    await gate(h.pool, now);
    await gate(h.pool, new Date(now.getTime() + 3600_000));
    expect(calls).toBe(1);
    await gate(h.pool, new Date('2031-01-16T08:00:00+03:00'));
    expect(calls).toBe(2);
  });

  it('internal_upload_closes_covered_expired_task', async () => {
    const s = await newSupplier();
    const old = await doc(s, 'FAALIYET_BELGESI', D);
    await run(D);
    expect(await tasks(old)).toEqual([expect.objectContaining({ status: 'OPEN' })]);
    // Satınalma aynı türde daha geç geçerli belgeyi replacesId vermeden yükler: kapsanan belgenin görevi kapanır.
    const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Istanbul' }).format(new Date());
    const r = await internalUpload(s, { typeCode: 'FAALIYET_BELGESI', validUntil: addDays(today, 200) });
    expect(r.statusCode).toBe(201);
    expect(await tasks(old)).toEqual([expect.objectContaining({ status: 'DONE' })]);
  });

  it('upload_bootstraps_todays_job', async () => {
    // Geçerlilik tarihli belge yüklemesi bugünün işini idempotent kurar (işçi kapısını beklemeden).
    const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Istanbul' }).format(new Date());
    const s = await newSupplier();
    const r = await internalUpload(s, { typeCode: 'VERGI_LEVHASI', validUntil: addDays(today, 90) });
    expect(r.statusCode).toBe(201);
    expect((await h.owner.query(`SELECT count(*)::int AS n FROM jobs WHERE tenant_id = $1 AND kind = $2 AND idempotency_key = $3`,
      [h.world.tenantA, DOC_REMINDER_JOB, `doc-reminders:${today}`])).rows[0].n).toBe(1);
  });
});
