// v2 Faz 3 (D108+, R7) Görev 6: sözleşme bitiş/ihbar hatırlatıcıları, e-posta kuyruğu (kanal yok → NOT_CONFIGURED), karar ile kapanış,
// kiracı süre ayarı ve eski kayıtta doğrulamayla kurulum. Gerçek PostgreSQL + RLS + iş kuyruğu; her test kendi sentetik dünyasında. Veri sentetik.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { addDays, noticeDeadline } from '@sp/domain';
import { createSyntheticWorld, syntheticPdf, type SyntheticWorld } from '../src/devdata.ts';
import { DevAuthProvider } from '../src/auth.ts';
import { withTenant, type TenantContext } from '../src/db.ts';
import { processJobs } from '../src/worker.ts';
import { scheduleContractReminders, EMAIL_NOT_CONFIGURED_LABEL } from '../src/modules/contractReminders.ts';
import { makeHarness } from './harness.ts';

let h: Awaited<ReturnType<typeof makeHarness>>;
let auth: DevAuthProvider;
beforeAll(async () => { h = await makeHarness(); auth = new DevAuthProvider(h.config.devAuthSecret!); });
afterAll(async () => { await h.close(); });

type UserKey = keyof SyntheticWorld['users'];
const fresh = () => createSyntheticWorld(h.owner, `-${randomUUID().slice(0, 8)}`);
const parse = (b: string) => { try { return b ? JSON.parse(b) : null; } catch { return b; } };
const today = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Istanbul' }).format(new Date());

async function call(w: SyntheticWorld, who: UserKey, method: string, url: string, body?: unknown, extra: Record<string, string> = {}) {
  const token = await auth.issue(`dev|${w.users[who].email}`);
  const res = await h.app.inject({ method: method as any, url, headers: { authorization: `Bearer ${token}`, 'x-tenant-id': w.tenantA, ...extra },
    ...(body !== undefined ? { payload: body as any } : {}) });
  return { status: res.statusCode, body: parse(res.body) };
}
async function uploadContract(w: SyntheticWorld, who: UserKey = 'techEval'): Promise<string> {
  const token = await auth.issue(`dev|${w.users[who].email}`);
  const boundary = '----sp' + randomUUID();
  const fields = { companyId: w.companyA1.id, kind: 'CONTRACT', title: `Bakım sözleşmesi ${randomUUID().slice(0, 4)} (SENTETİK)` };
  const parts: Buffer[] = [];
  for (const [k, v] of Object.entries(fields)) parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`));
  parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="s.pdf"\r\nContent-Type: application/pdf\r\n\r\n`),
    syntheticPdf([[`SENTETIK ${randomUUID()}`]]), Buffer.from(`\r\n--${boundary}--\r\n`));
  const res = await h.app.inject({ method: 'POST', url: '/api/v1/documents', payload: Buffer.concat(parts),
    headers: { authorization: `Bearer ${token}`, 'x-tenant-id': w.tenantA, 'content-type': `multipart/form-data; boundary=${boundary}` } });
  expect([200, 201]).toContain(res.statusCode);
  return parse(res.body).documentVersionId;
}
const criteria = [{ code: 'PRICE', name: 'Fiyat', kind: 'PRICE', weight: '100' }];
const lines = [{ lot: 'Lot 1', description: 'Bakım hizmeti', unit: 'ay', quantity: '12' }];
async function project(w: SyntheticWorld) {
  const r = await call(w, 'buyer', 'POST', '/api/v1/projects', { companyId: w.companyA1.id, title: `Sözleşme projesi ${randomUUID().slice(0, 4)}`, category: 'BT hizmetleri',
    need: 'Sentetik ihtiyaç', currency: 'TRY', budget: '100000.00', budgetVerified: false, lines, criteria, departmentId: w.departments.bt });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return r.body.id as string;
}
/** BT sorumlusu Selin (security; vekil buyer), satınalma sorumlusu legal (vekil legal2), direktör masterData (vekil finance). */
async function approvers(w: SyntheticWorld) {
  const r = await call(w, 'tenantAdmin', 'PUT', '/api/v1/approver-assignments', {
    organization: { leadUserId: w.users.legal.id, leadDeputyUserId: w.users.legal2.id, directorUserId: w.users.masterData.id, directorDeputyUserId: w.users.finance.id },
    departments: [{ departmentId: w.departments.bt, headUserId: w.users.security.id, deputyUserId: w.users.buyer.id }],
  });
  expect(r.status, JSON.stringify(r.body)).toBe(200);
}
const fields = (w: SyntheticWorld, over: Record<string, unknown> = {}) => ({
  supplierId: w.suppliers.s1, contractType: 'MAINTENANCE', ownerUserId: w.users.techEval.id, signedOn: '2026-11-01',
  currency: 'TRY', amount: '120000.00', limitBasis: 'NET', startDate: '2026-11-01', endDate: '2028-12-31', autoRenewal: false, ...over,
});
/**
 * Görev 5 (karar ucu) henüz yok: onaylı zincir sahibi bağlantısıyla yazılır (zincir = sürüm + koşul revizyonu). Yürürlükteki koşul budur.
 */
async function approve(w: SyntheticWorld, familyId: string, versionId: string, termsId: string) {
  const c = (await h.owner.query(`INSERT INTO contract_approval_chains (tenant_id, family_id, version_id, terms_id, submitted_by) VALUES ($1,$2,$3,$4,$5) RETURNING id`,
    [w.tenantA, familyId, versionId, termsId, w.users.techEval.id])).rows[0].id;
  await h.owner.query(`UPDATE contract_approval_chains SET closed_at = now(), outcome = 'APPROVED' WHERE id = $1`, [c]);
}
/** Ekleme akışıyla sözleşme (techEval ekler, sorumlu techEval); alanlar dolu; varsayılan olarak onaylı. */
async function contract(w: SyntheticWorld, over: Record<string, unknown> = {}, opts: { approved?: boolean } = { approved: true }) {
  const projectId = await project(w);
  const documentVersionId = await uploadContract(w);
  const d = await call(w, 'techEval', 'POST', '/api/v1/contract-drafts', { documentVersionId, projectId });
  expect(d.status, JSON.stringify(d.body)).toBe(201);
  const f = await call(w, 'techEval', 'PUT', `/api/v1/contracts/${d.body.familyId}/fields`, fields(w, over));
  expect(f.status, JSON.stringify(f.body)).toBe(200);
  if (opts.approved !== false) await approve(w, d.body.familyId, d.body.contractVersionId, f.body.fields.termsId);
  return { familyId: d.body.familyId as string, cv: d.body.contractVersionId as string, termsId: f.body.fields.termsId as string };
}
const procurementCtx = (w: SyntheticWorld): TenantContext => ({ userId: w.users.legal.id, tenantId: w.tenantA, roles: ['PROCUREMENT'],
  companyIds: [w.companyA1.id, w.companyA2.id], departmentIds: [], allDepartments: true, correlationId: `test-${randomUUID()}` });
const schedule = (w: SyntheticWorld, familyId: string) => withTenant(h.pool, procurementCtx(w), (tx) => scheduleContractReminders(tx, procurementCtx(w), familyId));
const reminderRows = (familyId: string) => h.owner.query<{ id: string; terms_id: string; kind: string; offset_days: number; due_on: string; task_ids: string[] }>(
  `SELECT id, terms_id, kind, offset_days, due_on::text, task_ids FROM contract_reminders WHERE family_id = $1 ORDER BY due_on, kind`, [familyId]);
const reminderJobs = (familyId: string) => h.owner.query<{ id: string; idempotency_key: string; run_after: Date; status: string; result: any; payload: any }>(
  `SELECT id, idempotency_key, run_after, status, result, payload FROM jobs WHERE kind = 'contract.end_reminder' AND payload->>'familyId' = $1 ORDER BY run_after`, [familyId]);
/** Kuyruk paralel test dosyalarıyla paylaşılır: iş sonucu görünene kadar işçiyi çalıştır. */
async function runJob(jobId: string) {
  await h.owner.query(`UPDATE jobs SET run_after = now() - interval '1 minute' WHERE id = $1 AND status = 'QUEUED'`, [jobId]);
  const end = Date.now() + 8000;
  for (;;) {
    while (await processJobs(h.pool, h.store, null)) { /* */ }
    const r = (await h.owner.query(`SELECT status, result FROM jobs WHERE id = $1`, [jobId])).rows[0];
    if (r.status !== 'QUEUED' && r.status !== 'RUNNING') return r;
    if (Date.now() > end) throw new Error(`job ${jobId} not processed`);
    await new Promise((res) => setTimeout(res, 100));
  }
}
const jobFor = async (familyId: string, kind: string, offset: number) => (await reminderJobs(familyId)).rows.find((j) => j.payload.kind === kind && j.payload.offset === offset)!;
const reminderTasks = (familyId: string) => h.owner.query<{ id: string; status: string; assignee_user_id: string | null; assignee_role: string; dedupe_key: string; severity: string; company_id: string | null; department_id: string | null }>(
  `SELECT id, status, assignee_user_id, assignee_role, dedupe_key, severity, company_id, department_id FROM tasks
   WHERE entity_type = 'contract_reminder' AND entity_id = $1 ORDER BY created_at, dedupe_key`, [familyId]);

describe('kurulum (R7)', () => {
  it('Figma örneği: bitiş 31.12.2028 → 90/60/30/7 gün önce; iş anahtarı reminder:{koşul}:{tür}:{süre}; ikinci çağrı yeni kayıt yazmaz', async () => {
    const w = await fresh();
    const c = await contract(w);
    const r = await schedule(w, c.familyId);
    expect(r.created).toBe(true);
    expect(r.reminders.map((x) => [x.kind, x.offset, x.dueOn])).toEqual([
      ['END', 90, '2028-10-02'], ['END', 60, '2028-11-01'], ['END', 30, '2028-12-01'], ['END', 7, '2028-12-24']]);
    const rows = (await reminderRows(c.familyId)).rows;
    expect(rows.map((x) => x.due_on)).toEqual(['2028-10-02', '2028-11-01', '2028-12-01', '2028-12-24']);
    expect(rows.every((x) => x.terms_id === c.termsId)).toBe(true);
    const jobs = (await reminderJobs(c.familyId)).rows;
    expect(jobs.map((j) => j.idempotency_key).sort()).toEqual([90, 60, 30, 7].map((o) => `reminder:${c.termsId}:END:${o}`).sort());
    expect(new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Istanbul' }).format(jobs[0]!.run_after)).toBe('2028-10-02');
    expect(jobs.every((j) => j.status === 'QUEUED')).toBe(true);

    const again = await schedule(w, c.familyId);
    expect(again.created).toBe(false);
    expect(again.reminders).toHaveLength(4);
    expect((await reminderRows(c.familyId)).rowCount).toBe(4);
    expect((await reminderJobs(c.familyId)).rowCount).toBe(4);

    const g = await call(w, 'techEval', 'GET', `/api/v1/contracts/${c.familyId}/reminders`);
    expect(g.status, JSON.stringify(g.body)).toBe(200);
    expect(g.body).toMatchObject({ familyId: c.familyId, termsId: c.termsId, contractVersionId: c.cv, effective: true, scheduled: true, offsets: [90, 60, 30, 7],
      basis: { endDate: '2028-12-31', indefinite: false, autoRenewal: false, noticeDeadline: null },
      emailChannel: { configured: false, label: EMAIL_NOT_CONFIGURED_LABEL }, decision: null, can: { decide: false, settings: false } }); // techEval: karar yetkisi yok
    expect(g.body.planned.map((p: any) => p.date)).toEqual(['2028-10-02', '2028-11-01', '2028-12-01', '2028-12-24']);
    expect(g.body.reminders.map((x: any) => [x.offset, x.state, x.includeProcurement])).toEqual([[90, 'PLANNED', false], [60, 'PLANNED', false], [30, 'PLANNED', true], [7, 'PLANNED', true]]);
    // Başka kiracı göremez.
    expect((await call(w, 'buyerB', 'GET', `/api/v1/contracts/${c.familyId}/reminders`)).status).toBe(403);
  });

  it('geçmişte kalan süreler: yalnız en yakın geçmiş olan bugüne çekilir ve hemen çalışır', async () => {
    const w = await fresh();
    const end = addDays(today(), 20);
    const c = await contract(w, { endDate: end });
    const r = await schedule(w, c.familyId);
    expect(r.reminders.map((x) => [x.offset, x.dueOn])).toEqual([[30, today()], [7, addDays(end, -7)]]);
    const j = (await reminderJobs(c.familyId)).rows;
    expect(j[0]!.run_after.getTime()).toBeLessThanOrEqual(Date.now());
  });
});

describe('işçi: görev + e-posta kuyruğu', () => {
  it('30 gün: sorumlu ve departman sorumlusuna kişisel görev, Satınalma kuyruğuna görev; e-postalar NOT_CONFIGURED; 7 gün öncekini devralır; karar (Yeni proje açıldı) kapatır', async () => {
    const w = await fresh();
    await approvers(w);
    const end = addDays(today(), 20);
    const c = await contract(w, { endDate: end });
    await schedule(w, c.familyId);
    const res = await runJob((await jobFor(c.familyId, 'END', 30)).id);
    expect(res.status).toBe('SUCCEEDED');
    expect(res.result).toMatchObject({ kind: 'END', offset: 30, target: end, tasks: 3, emails: 3, emailStatus: 'NOT_CONFIGURED', procurementQueue: true });

    const tasks = (await reminderTasks(c.familyId)).rows;
    expect(tasks.map((t) => [t.assignee_user_id, t.assignee_role, t.status]).sort()).toEqual([
      [w.users.techEval.id, 'DEPARTMENT_USER', 'OPEN'], [w.users.security.id, 'DEPARTMENT_USER', 'OPEN'], [null, 'PROCUREMENT', 'OPEN']].sort());
    expect(tasks.every((t) => t.severity === 'HIGH' && t.department_id === null)).toBe(true);
    expect(tasks.find((t) => t.assignee_user_id === null)!.company_id).toBe(w.companyA1.id);
    expect((await reminderRows(c.familyId)).rows.find((x) => x.offset_days === 30)!.task_ids.sort()).toEqual(tasks.map((t) => t.id).sort());

    const mails = (await h.owner.query(`SELECT to_user_id, to_email, status, subject, sent_at FROM email_outbox WHERE related_type = 'contract_reminder'
      AND related_id = (SELECT id FROM contract_reminders WHERE family_id = $1 AND offset_days = 30) ORDER BY to_email`, [c.familyId])).rows;
    expect(mails.map((m) => m.to_user_id).sort()).toEqual([w.users.techEval.id, w.users.security.id, w.users.legal.id].sort());
    expect(mails.every((m) => m.status === 'NOT_CONFIGURED' && m.sent_at === null)).toBe(true);
    expect(mails[0].subject).toContain('Sözleşme bitişi');

    // İşlerim: sorumlu kendi görevini görür (kayıt no = sözleşme kodu); aynı roldeki başka kişi o kişisel görevi "Tümü"nde de görmez.
    const mine = (await call(w, 'techEval', 'GET', '/api/v1/tasks?view=mine')).body.items.filter((t: any) => t.entityType === 'contract_reminder');
    expect(mine).toHaveLength(1);
    expect(mine[0]).toMatchObject({ kind: 'contract_reminder', entityId: c.familyId, severity: 'HIGH' });
    expect(mine[0].refNo).toMatch(/\S/);
    expect(mine[0].title).toContain(end.split('-').reverse().join('.'));
    const buyerAll = (await call(w, 'buyer', 'GET', '/api/v1/tasks?view=all')).body.items.filter((t: any) => t.entityType === 'contract_reminder');
    expect(buyerAll.map((t: any) => t.assigneeRole)).toEqual(['PROCUREMENT']);
    const headMine = (await call(w, 'security', 'GET', '/api/v1/tasks?view=mine')).body.items.filter((t: any) => t.entityType === 'contract_reminder');
    expect(headMine).toHaveLength(1);

    // Okuma: Satınalma bütün e-posta durumlarını, bölüm kullanıcısı yalnız kendisine gideni görür.
    const all = (await call(w, 'legal', 'GET', `/api/v1/contracts/${c.familyId}/reminders`)).body;
    const r30 = all.reminders.find((x: any) => x.offset === 30);
    expect(r30.state).toBe('OPEN');
    expect(r30.tasks).toHaveLength(3);
    expect(r30.tasks.map((t: any) => t.recipient.type).sort()).toEqual(['ROLE', 'USER', 'USER']);
    expect(r30.emails).toHaveLength(3);
    expect(r30.emails.every((e: any) => e.status === 'NOT_CONFIGURED' && e.statusLabel === EMAIL_NOT_CONFIGURED_LABEL && e.sentAt === null)).toBe(true);
    const own = (await call(w, 'techEval', 'GET', `/api/v1/contracts/${c.familyId}/reminders`)).body.reminders.find((x: any) => x.offset === 30);
    expect(own.emails.map((e: any) => e.toUser.id)).toEqual([w.users.techEval.id]);

    // 7 gün hatırlatıcısı öncekini devralır (aynı kişide tek açık hatırlatıcı); kritik.
    await runJob((await jobFor(c.familyId, 'END', 7)).id);
    const after = (await reminderTasks(c.familyId)).rows;
    expect(after.filter((t) => t.status === 'OPEN').map((t) => [t.dedupe_key.split(':').pop(), t.severity])).toEqual([['7', 'CRITICAL'], ['7', 'CRITICAL'], ['7', 'CRITICAL']]);

    // Karar (D108 R7a): onaylı koşulda doğrulama olmadan da "Yeni proje açıldı" kabul; bütün hatırlatıcı görevleri kapanır.
    expect((await call(w, 'legal', 'GET', `/api/v1/contracts/${c.familyId}/reminders`)).body.can.decide).toBe(true);
    const d = await call(w, 'legal', 'POST', `/api/v1/contract-versions/${c.cv}/renewal-decision`, { decision: 'NEW_PROJECT', rationale: 'Yeni ihtiyaç için proje açıldı (sentetik).' });
    expect(d.status, JSON.stringify(d.body)).toBe(201);
    expect(d.body.decision).toBe('NEW_PROJECT');
    expect((await reminderTasks(c.familyId)).rows.every((t) => t.status === 'DONE')).toBe(true);
    const g = (await call(w, 'legal', 'GET', `/api/v1/contracts/${c.familyId}/reminders`)).body;
    expect(g.decision).toMatchObject({ decision: 'NEW_PROJECT', label: 'Yeni proje açıldı' });
    expect(g.can.decide).toBe(false);
    expect(g.reminders.filter((x: any) => x.offset === 30 || x.offset === 7).map((x: any) => x.state)).toEqual(['CLOSED', 'CLOSED']);
    // Yeni proje kararı ek takip görevi açmaz.
    expect((await h.owner.query(`SELECT 1 FROM tasks WHERE entity_id = $1 AND kind IN ('contract_renewal','contract_exit')`, [c.cv])).rowCount).toBe(0);
  });

  it('karar seçenekleri (yenile, sonlandır, yeniden müzakere) de açık hatırlatıcıları kapatır; karardan sonra çalışan iş görev açmaz', async () => {
    const w = await fresh();
    await approvers(w);
    for (const decision of ['RENEW', 'TERMINATE', 'RENEGOTIATE'] as const) {
      const end = addDays(today(), 50);
      const c = await contract(w, { endDate: end });
      await schedule(w, c.familyId);
      await runJob((await jobFor(c.familyId, 'END', 60)).id);
      expect((await reminderTasks(c.familyId)).rows.filter((t) => t.status === 'OPEN')).toHaveLength(2); // 60 gün: Satınalma kuyruğu yok
      expect((await call(w, 'legal2', 'POST', `/api/v1/contract-terms/${c.termsId}/verify`)).status).toBe(200);
      const d = await call(w, 'legal', 'POST', `/api/v1/contract-versions/${c.cv}/renewal-decision`, { decision, rationale: `Karar: ${decision} (sentetik gerekçe).` });
      expect(d.status, JSON.stringify(d.body)).toBe(201);
      expect((await reminderTasks(c.familyId)).rows.every((t) => t.status === 'DONE'), decision).toBe(true);
      const late = await runJob((await jobFor(c.familyId, 'END', 30)).id);
      expect(late.result).toEqual({ skipped: 'decided' });
      expect((await reminderTasks(c.familyId)).rows.filter((t) => t.status === 'OPEN')).toHaveLength(0);
    }
  });

  it('onay zinciri koşulları onayladıysa doğrulama olmadan da karar girilebilir; onaysız ve doğrulanmamışta 409', async () => {
    const w = await fresh();
    await approvers(w);
    const un = await contract(w, {}, { approved: false });
    expect((await call(w, 'legal', 'POST', `/api/v1/contract-versions/${un.cv}/renewal-decision`, { decision: 'NEW_PROJECT', rationale: 'Yeni ihtiyaç için proje açıldı (sentetik).' })).status).toBe(409);
    const c = await contract(w, {}, { approved: false });
    expect((await call(w, 'techEval', 'POST', `/api/v1/contracts/${c.familyId}/submit`, {})).status).toBe(200);
    const chain = (await h.owner.query(`SELECT id FROM contract_approval_chains WHERE family_id = $1`, [c.familyId])).rows[0].id;
    // Görev 5 (karar ucu) henüz yok: zincir sahibi bağlantısıyla onaylanmış duruma getirilir.
    await h.owner.query(`UPDATE contract_approval_steps SET decision = 'APPROVED', decided_by = assigned_user_id, decided_at = now() WHERE chain_id = $1`, [chain]);
    await h.owner.query(`UPDATE contract_approval_chains SET closed_at = now(), outcome = 'APPROVED' WHERE id = $1`, [chain]);
    const r = await schedule(w, c.familyId);
    expect(r.reminders).toHaveLength(4);
    expect((await call(w, 'legal', 'GET', `/api/v1/contracts/${c.familyId}/reminders`)).body.can.decide).toBe(true);
    const d = await call(w, 'legal', 'POST', `/api/v1/contract-versions/${c.cv}/renewal-decision`, { decision: 'RENEW', rationale: 'Performans iyi, yenilenecek (sentetik).' });
    expect(d.status, JSON.stringify(d.body)).toBe(201);
  });

  it('sorumlu ve departman sorumlusu yoksa hatırlatıcı Satınalma kuyruğuna düşer', async () => {
    const w = await fresh();
    const c = await contract(w, { ownerUserId: null });
    await schedule(w, c.familyId);
    const res = await runJob((await jobFor(c.familyId, 'END', 90)).id);
    expect(res.result).toMatchObject({ tasks: 1, emails: 0, procurementQueue: true });
    expect((await reminderTasks(c.familyId)).rows.map((t) => [t.assignee_user_id, t.assignee_role])).toEqual([[null, 'PROCUREMENT']]);
  });
});

describe('kiracı ayarı', () => {
  it('yalnız Yönetici; 1–365, tekrarsız, en çok 6; değişiklik yalnız sonraki kurulumu etkiler', async () => {
    const w = await fresh();
    const g = await call(w, 'tenantAdmin', 'GET', '/api/v1/settings/contract-reminders');
    expect(g.status).toBe(200);
    expect(g.body).toMatchObject({ offsets: [90, 60, 30, 7], defaults: [90, 60, 30, 7], isDefault: true, updatedBy: null });
    expect((await call(w, 'legal', 'GET', '/api/v1/settings/contract-reminders')).status).toBe(403);
    expect((await call(w, 'legal', 'PUT', '/api/v1/settings/contract-reminders', { offsets: [45] })).status).toBe(403);
    for (const offsets of [[], [0], [366], [30, 30], [1, 2, 3, 4, 5, 6, 7], [1.5]]) {
      const bad = await call(w, 'tenantAdmin', 'PUT', '/api/v1/settings/contract-reminders', { offsets });
      expect(bad.status, JSON.stringify(offsets)).toBe(400);
    }

    const before = await contract(w);
    await schedule(w, before.familyId);
    const p = await call(w, 'tenantAdmin', 'PUT', '/api/v1/settings/contract-reminders', { offsets: [15, 45] });
    expect(p.status, JSON.stringify(p.body)).toBe(200);
    expect(p.body).toMatchObject({ offsets: [45, 15], isDefault: false, updatedBy: { id: w.users.tenantAdmin.id } });
    expect((await call(w, 'tenantAdmin', 'GET', '/api/v1/settings/contract-reminders')).body.offsets).toEqual([45, 15]);
    expect((await h.owner.query(`SELECT 1 FROM audit_events WHERE tenant_id = $1 AND action = 'contract.reminder_settings.updated'`, [w.tenantA])).rowCount).toBe(1);

    // Kurulmuş hatırlatıcılar değişmez; aynı koşul için yeniden kurulum yeni süre eklemez.
    await schedule(w, before.familyId);
    expect((await reminderRows(before.familyId)).rows.map((x) => x.offset_days)).toEqual([90, 60, 30, 7]);
    const after = await contract(w);
    const r = await schedule(w, after.familyId);
    expect(r.reminders.map((x) => [x.offset, x.dueOn])).toEqual([[45, '2028-11-16'], [15, '2028-12-16']]);
    const view = (await call(w, 'techEval', 'GET', `/api/v1/contracts/${after.familyId}/reminders`)).body;
    expect(view.offsets).toEqual([45, 15]);
    expect(view.reminders.map((x: any) => x.includeProcurement)).toEqual([false, false]);
  });
});

describe('eski kayıt (R7): koşul doğrulanınca kurulur; mevcut ihbar uyarısı korunur', () => {
  it('eski kayıtta doğrulama bitiş + ihbar hatırlatıcılarını kurar; ihbar hatırlatıcısı Satınalma kuyruğunda ikinci görev açmaz', async () => {
    const w = await fresh();
    await approvers(w);
    const dv = await uploadContract(w, 'legal');
    const old = await call(w, 'legal', 'POST', '/api/v1/contracts', { title: 'Eski bakım sözleşmesi (SENTETİK)', documentVersionId: dv, stage: 'EXECUTION',
      signatureMethod: 'NOT_REQUIRED', originalCustodyRequired: false, departmentId: w.departments.bt, supplierId: w.suppliers.s1,
      parties: [{ role: 'BUYER', displayName: w.companyA1.name, legalEntityId: w.companyA1.id }] });
    expect(old.status, JSON.stringify(old.body)).toBe(201);
    await h.owner.query(`UPDATE contract_families SET intake_flow = false WHERE id = $1`, [old.body.familyId]);
    const proj = await project(w);
    const f = await call(w, 'legal', 'PUT', `/api/v1/contracts/${old.body.familyId}/fields`,
      fields(w, { projectId: proj, autoRenewal: true, renewalMonths: 12, noticeAmount: 60, noticeUnit: 'DAY' }));
    expect(f.status, JSON.stringify(f.body)).toBe(200);
    expect(f.body.status.code).toBe('LEGACY');
    const termsId = f.body.fields.termsId;
    expect((await reminderRows(old.body.familyId)).rowCount).toBe(0);

    const v = await call(w, 'legal2', 'POST', `/api/v1/contract-terms/${termsId}/verify`);
    expect(v.status, JSON.stringify(v.body)).toBe(200);
    // Mevcut ihbar uyarısı (90/60/30, ihbar son gününe göre) aynen kurulur.
    expect(v.body.reminders.map((x: any) => x.offset)).toEqual([90, 60, 30]);
    const nd = noticeDeadline('2028-12-31', { amount: 60, unit: 'DAY', nonWorkingDay: 'PREVIOUS_WORKING_DAY' }, []).deadline;
    expect(v.body.contractReminders.map((x: any) => [x.kind, x.offset, x.dueOn])).toEqual([
      ['END', 90, '2028-10-02'], ['NOTICE', 30, addDays(nd, -30)], ['END', 60, '2028-11-01'], ['END', 30, '2028-12-01'], ['END', 7, '2028-12-24']]);
    expect(addDays(nd, -30)).toBe('2028-10-02'); // ihbar son günü 01.11.2028 (bitiş − 60 gün)
    const noticeJobs = (await h.owner.query(`SELECT count(*)::int AS n FROM jobs WHERE kind = 'contract.notice_reminder' AND payload->>'termsId' = $1`, [termsId])).rows[0].n;
    expect(noticeJobs).toBe(3);

    const res = await runJob((await jobFor(old.body.familyId, 'NOTICE', 30)).id);
    expect(res.result).toMatchObject({ kind: 'NOTICE', target: nd, procurementQueue: false, tasks: 2, emails: 2 });
    expect((await reminderTasks(old.body.familyId)).rows.map((t) => t.assignee_user_id).sort()).toEqual([w.users.techEval.id, w.users.security.id].sort());
    const g = (await call(w, 'legal', 'GET', `/api/v1/contracts/${old.body.familyId}/reminders`)).body;
    expect(g.basis).toMatchObject({ autoRenewal: true, noticeDeadline: nd, noticeBasis: 'END_DATE' });
    expect(g.effective).toBe(true);
    // Okuma işçinin yapacağını gösterir: mevcut ihbar uyarısı kapsadığından NOTICE'ta Satınalma kuyruğu yok.
    expect(g.reminders.find((x: any) => x.kind === 'NOTICE').includeProcurement).toBe(false);
    expect(g.planned.find((x: any) => x.kind === 'NOTICE').includeProcurement).toBe(false);
    expect(g.reminders.find((x: any) => x.kind === 'END' && x.offset === 30).includeProcurement).toBe(true);
  });

  it('ekleme akışındaki sözleşmede doğrulama hatırlatıcı kurmaz (onayla kurulur); yürürlükte koşul yoksa kurulum boş ve denetim kaydı yazmaz', async () => {
    const w = await fresh();
    const c = await contract(w, {}, { approved: false });
    const v = await call(w, 'legal2', 'POST', `/api/v1/contract-terms/${c.termsId}/verify`);
    expect(v.status).toBe(200);
    expect(v.body.contractReminders).toEqual([]);
    expect((await reminderRows(c.familyId)).rowCount).toBe(0);
    const r = await schedule(w, c.familyId);
    expect(r).toMatchObject({ termsId: null, created: false, reminders: [] });
    expect((await h.owner.query(`SELECT 1 FROM audit_events WHERE entity_id = $1 AND action = 'contract.reminders.scheduled'`, [c.familyId])).rowCount).toBe(0);
    const g = (await call(w, 'legal', 'GET', `/api/v1/contracts/${c.familyId}/reminders`)).body;
    expect(g).toMatchObject({ effective: false, scheduled: false, termsId: c.termsId });
    expect(g.planned).toHaveLength(4);
  });
});

describe('süresiz sözleşme', () => {
  it('ihbar süresi başlangıcın yıl dönümüne uygulanır; yalnız ihbar hatırlatıcısı kurulur', async () => {
    const w = await fresh();
    const { endDate: _e, ...rest } = fields(w);
    const projectId = await project(w);
    const documentVersionId = await uploadContract(w);
    const d = await call(w, 'techEval', 'POST', '/api/v1/contract-drafts', { documentVersionId, projectId });
    const f = await call(w, 'techEval', 'PUT', `/api/v1/contracts/${d.body.familyId}/fields`, { ...rest, startDate: '2026-01-15', indefinite: true, noticeAmount: 3, noticeUnit: 'MONTH' });
    expect(f.status, JSON.stringify(f.body)).toBe(200);
    expect(f.body.missing).toEqual([]);
    await approve(w, d.body.familyId, d.body.contractVersionId, f.body.fields.termsId);
    const r = await schedule(w, d.body.familyId);
    expect(r.reminders.map((x) => x.kind)).toEqual(['NOTICE']);
    const g = (await call(w, 'techEval', 'GET', `/api/v1/contracts/${d.body.familyId}/reminders`)).body;
    expect(g.basis).toMatchObject({ indefinite: true, endDate: null, noticeBasis: 'ANNIVERSARY' });
    const rule = { amount: 3, unit: 'MONTH' as const, nonWorkingDay: 'PREVIOUS_WORKING_DAY' as const };
    expect(g.basis.noticeDeadline).toBe(noticeDeadline(g.basis.anniversary, rule, []).deadline);
    expect(g.basis.noticeDeadline >= today()).toBe(true);
    expect(g.basis.anniversary.slice(5)).toBe('01-15');
    // Sözleşme detayı (Görev 4) planı da aynı ihbar son gününü kullanır.
    const v2 = (await call(w, 'techEval', 'GET', `/api/v1/contracts/${d.body.familyId}/v2`)).body;
    expect(v2.reminders.planned.map((p: any) => p.kind)).toEqual(['NOTICE']);
  });
});

describe('inceleme düzeltmeleri (Görev 6, tur 1)', () => {
  it('I1: onaydan sonra eklenen (onaylanmamış) zeyilname hatırlatıcıyı eskitmez; karar onaylı sürüme girilir; yeni onaylı koşul eskisini eskitir', async () => {
    const w = await fresh();
    await approvers(w);
    const end = addDays(today(), 50);
    const c = await contract(w, { endDate: end });
    await schedule(w, c.familyId);
    const etag = (await call(w, 'techEval', 'GET', `/api/v1/contracts/${c.familyId}/v2`)).body.document.etag;
    const dv = await uploadContract(w);
    const nv = await call(w, 'techEval', 'POST', `/api/v1/contract-versions/${c.cv}/versions`, { documentVersionId: dv, kind: 'AMENDMENT', stage: 'DRAFT' }, { 'if-match': etag });
    expect(nv.status, JSON.stringify(nv.body)).toBe(201);
    const newCv = nv.body.contractVersionId ?? nv.body.id;
    // Zeyilname koşulu girilir ama onaylanmaz (yarım kalan zeyilname).
    const f2 = await call(w, 'techEval', 'PUT', `/api/v1/contracts/${c.familyId}/fields`, fields(w, { endDate: addDays(end, 365) }));
    expect(f2.status, JSON.stringify(f2.body)).toBe(200);
    const amendTerms = f2.body.fields.termsId;
    expect(amendTerms).not.toBe(c.termsId);

    const res = await runJob((await jobFor(c.familyId, 'END', 60)).id);
    expect(res.result).toMatchObject({ kind: 'END', offset: 60, target: end, tasks: 2 });
    const g = (await call(w, 'legal', 'GET', `/api/v1/contracts/${c.familyId}/reminders`)).body;
    expect(g).toMatchObject({ termsId: c.termsId, contractVersionId: c.cv, effective: true, scheduled: true });
    expect(g.can.decide).toBe(true);
    expect(g.basis.endDate).toBe(end);
    const d = await call(w, 'legal', 'POST', `/api/v1/contract-versions/${g.contractVersionId}/renewal-decision`, { decision: 'RENEW', rationale: 'Zeyilname ile yenilenecek (sentetik).' });
    expect(d.status, JSON.stringify(d.body)).toBe(201);
    expect((await reminderTasks(c.familyId)).rows.every((t) => t.status === 'DONE')).toBe(true);
    expect(newCv).toBeTruthy();

    // Zeyilname onaylanınca yürürlükteki koşul değişir: eski koşulun bekleyen işi eskir, yeni koşula yeni hatırlatıcı kurulur.
    const w2 = await fresh();
    await approvers(w2);
    const c2 = await contract(w2, { endDate: end });
    await schedule(w2, c2.familyId);
    const etag2 = (await call(w2, 'techEval', 'GET', `/api/v1/contracts/${c2.familyId}/v2`)).body.document.etag;
    const nv2 = await call(w2, 'techEval', 'POST', `/api/v1/contract-versions/${c2.cv}/versions`, { documentVersionId: await uploadContract(w2), kind: 'AMENDMENT', stage: 'DRAFT' }, { 'if-match': etag2 });
    expect(nv2.status, JSON.stringify(nv2.body)).toBe(201);
    const f3 = await call(w2, 'techEval', 'PUT', `/api/v1/contracts/${c2.familyId}/fields`, fields(w2, { endDate: addDays(end, 365) }));
    expect(f3.status, JSON.stringify(f3.body)).toBe(200);
    const v2 = (await call(w2, 'techEval', 'GET', `/api/v1/contracts/${c2.familyId}/v2`)).body;
    await approve(w2, c2.familyId, v2.document.contractVersionId, f3.body.fields.termsId);
    const stale = await runJob((await jobFor(c2.familyId, 'END', 60)).id);
    expect(stale.result).toMatchObject({ skipped: 'obsolete', effectiveTermsId: f3.body.fields.termsId });
    const r2 = await schedule(w2, c2.familyId);
    expect(r2.termsId).toBe(f3.body.fields.termsId);
    expect(r2.reminders).toHaveLength(4);
  });

  it('M1: kuran kullanıcının üyeliği askıya alınsa da hatırlatıcı işi sistem bağlamında çalışır', async () => {
    const w = await fresh();
    await approvers(w);
    const c = await contract(w, { endDate: addDays(today(), 20) });
    await schedule(w, c.familyId); // kuran: legal
    await h.owner.query(`UPDATE memberships SET status = 'SUSPENDED' WHERE tenant_id = $1 AND user_id = $2`, [w.tenantA, w.users.legal.id]);
    const res = await runJob((await jobFor(c.familyId, 'END', 30)).id);
    expect(res.status).toBe('SUCCEEDED');
    expect(res.result).toMatchObject({ offset: 30, procurementQueue: true });
    expect((await reminderTasks(c.familyId)).rows.filter((t) => t.status === 'OPEN')).toHaveLength(3);
  });

  it('I3: geri doldurma — doğrulanmış ama hatırlatıcısı olmayan eski kayıtlar için kiracıya günde bir sistem işi; idempotent', async () => {
    const { enqueueReminderBackfills, backfillLegacyReminders, systemContext } = await import('../src/modules/contractReminders.ts');
    const w = await fresh();
    await approvers(w);
    // Eski kayıt: koşul Faz 3 geçişinden önce doğrulanmış (o zaman hatırlatıcı kurulmuyordu).
    const c = await contract(w, {}, { approved: false });
    expect((await call(w, 'legal2', 'POST', `/api/v1/contract-terms/${c.termsId}/verify`)).status).toBe(200);
    await h.owner.query(`UPDATE contract_families SET intake_flow = false WHERE id = $1`, [c.familyId]);
    // Eksik koşullu (doğrulanmamış) eski kayıt geri doldurulmaz.
    const un = await contract(w, {}, { approved: false });
    await h.owner.query(`UPDATE contract_families SET intake_flow = false WHERE id = $1`, [un.familyId]);
    expect((await reminderRows(c.familyId)).rowCount).toBe(0);

    const tenants = (await h.owner.query(`SELECT t FROM contract_reminder_backfill_tenants() t`)).rows.map((r: any) => r.t);
    expect(tenants).toContain(w.tenantA);
    await enqueueReminderBackfills(h.pool, new Date());
    const job = (await h.owner.query(`SELECT id, requested_by, company_id FROM jobs WHERE tenant_id = $1 AND kind = 'contract.reminder_backfill'`, [w.tenantA])).rows;
    expect(job).toHaveLength(1);
    expect(job[0]).toMatchObject({ requested_by: null, company_id: null });
    await enqueueReminderBackfills(h.pool, new Date()); // aynı gün ikinci iş açılmaz
    expect((await h.owner.query(`SELECT 1 FROM jobs WHERE tenant_id = $1 AND kind = 'contract.reminder_backfill'`, [w.tenantA])).rowCount).toBe(1);
    const res = await runJob(job[0].id);
    expect(res).toMatchObject({ status: 'SUCCEEDED', result: { candidates: 1, scheduled: 1 } });
    expect((await reminderRows(c.familyId)).rows.map((x) => x.offset_days)).toEqual([90, 60, 30, 7]);
    expect((await reminderRows(un.familyId)).rowCount).toBe(0);
    expect((await reminderJobs(c.familyId)).rows.every((j) => j.status === 'QUEUED')).toBe(true);
    expect((await h.owner.query(`SELECT requested_by FROM jobs WHERE kind = 'contract.end_reminder' AND payload->>'familyId' = $1`, [c.familyId])).rows.every((r: any) => r.requested_by === null)).toBe(true);
    expect((await h.owner.query(`SELECT t FROM contract_reminder_backfill_tenants() t`)).rows.map((r: any) => r.t)).not.toContain(w.tenantA);
    // Tekrar: yeni kayıt yazmaz.
    const ctx = systemContext(w.tenantA, [w.companyA1.id, w.companyA2.id], 'test');
    const again = await withTenant(h.pool, ctx, (tx) => backfillLegacyReminders(tx, ctx));
    expect(again).toEqual({ candidates: 0, scheduled: 0 });
    // Sistem bağlamında kurulan iş de işlenir.
    const fired = await runJob((await jobFor(c.familyId, 'END', 90)).id);
    expect(fired.status).toBe('SUCCEEDED');
  });
});

// v2 Faz 3 (D108): final inceleme düzeltmeleri — I1 (süresi dolmuş sözleşmeye hatırlatıcı yok), M1 (iptal/ret zinciri olan eski kayıt), ertelenen #3 (günlük kapı).
describe('final inceleme düzeltmeleri', () => {
  const lastYear = () => addDays(today(), -365);
  const expiredFields = () => ({ signedOn: addDays(today(), -800), startDate: addDays(today(), -790), endDate: lastYear() });
  const cancelledChain = async (w: SyntheticWorld, c: { familyId: string; cv: string; termsId: string }, outcome: 'CANCELLED' | 'REJECTED') => {
    const id = (await h.owner.query(`INSERT INTO contract_approval_chains (tenant_id, family_id, version_id, terms_id, submitted_by) VALUES ($1,$2,$3,$4,$5) RETURNING id`,
      [w.tenantA, c.familyId, c.cv, c.termsId, w.users.techEval.id])).rows[0].id;
    await h.owner.query(`UPDATE contract_approval_chains SET closed_at = now(), outcome = $2, cancel_reason = $3 WHERE id = $1`,
      [id, outcome, outcome === 'CANCELLED' ? 'İçerik değişti (test)' : null]);
  };

  it('I1: süresi geçen yıl dolmuş eski kayıt — doğrulama ve geri doldurma hatırlatıcı/görev açmaz; kiracı kapıdan seçilmez', async () => {
    const { backfillLegacyReminders, systemContext } = await import('../src/modules/contractReminders.ts');
    const w = await fresh();
    await approvers(w);
    const c = await contract(w, expiredFields(), { approved: false });
    await h.owner.query(`UPDATE contract_families SET intake_flow = false WHERE id = $1`, [c.familyId]);
    const v = await call(w, 'legal2', 'POST', `/api/v1/contract-terms/${c.termsId}/verify`);
    expect(v.status, JSON.stringify(v.body)).toBe(200);
    expect(v.body.contractReminders).toEqual([]);
    expect((await h.owner.query(`SELECT t FROM contract_reminder_backfill_tenants() t`)).rows.map((r: any) => r.t)).not.toContain(w.tenantA);
    const ctx = systemContext(w.tenantA, [w.companyA1.id, w.companyA2.id], 'test');
    expect(await withTenant(h.pool, ctx, (tx) => backfillLegacyReminders(tx, ctx))).toEqual({ candidates: 0, scheduled: 0 });
    expect((await reminderRows(c.familyId)).rowCount).toBe(0);
    expect((await reminderTasks(c.familyId)).rowCount).toBe(0);
  });

  it('I1: süresi dolmuş sözleşme onaylansa da kurulum boş; bitiş bugünse yalnız bugünkü hatırlatıcı', async () => {
    const w = await fresh();
    await approvers(w);
    const old = await contract(w, expiredFields());
    expect(await schedule(w, old.familyId)).toMatchObject({ created: false, reminders: [] });
    expect((await reminderRows(old.familyId)).rowCount).toBe(0);
    const t = await contract(w, { signedOn: addDays(today(), -400), startDate: addDays(today(), -390), endDate: today() });
    const r = await schedule(w, t.familyId);
    expect(r.reminders.map((x) => [x.kind, x.offset, x.dueOn])).toEqual([['END', 7, today()]]);
  });

  it('M1: iptal edilmiş zinciri olan eski kayıtta yeni koşul doğrulanınca hatırlatıcı kurulur; reddedilmiş zincirli eski kayıt geri doldurulur', async () => {
    const { backfillLegacyReminders, systemContext } = await import('../src/modules/contractReminders.ts');
    const w = await fresh();
    await approvers(w);
    const a = await contract(w, {}, { approved: false });
    await h.owner.query(`UPDATE contract_families SET intake_flow = false WHERE id = $1`, [a.familyId]);
    await cancelledChain(w, a, 'CANCELLED');
    const f2 = await call(w, 'techEval', 'PUT', `/api/v1/contracts/${a.familyId}/fields`, fields(w, { endDate: '2029-06-30' }));
    expect(f2.status, JSON.stringify(f2.body)).toBe(200);
    const newTerms = f2.body.fields.termsId as string;
    expect(newTerms).not.toBe(a.termsId);
    const v = await call(w, 'legal2', 'POST', `/api/v1/contract-terms/${newTerms}/verify`);
    expect(v.status, JSON.stringify(v.body)).toBe(200);
    expect(v.body.contractReminders.map((x: any) => x.offset)).toEqual([90, 60, 30, 7]);
    expect((await reminderRows(a.familyId)).rows.every((x) => x.terms_id === newTerms)).toBe(true);

    // Doğrulanmış, reddedilmiş zinciri olan eski kayıt (hatırlatıcısı yok) geri doldurmaya girer.
    const b = await contract(w, {}, { approved: false });
    expect((await call(w, 'legal2', 'POST', `/api/v1/contract-terms/${b.termsId}/verify`)).status).toBe(200);
    await h.owner.query(`UPDATE contract_families SET intake_flow = false WHERE id = $1`, [b.familyId]);
    await cancelledChain(w, b, 'REJECTED');
    expect((await reminderRows(b.familyId)).rowCount).toBe(0);
    expect((await h.owner.query(`SELECT t FROM contract_reminder_backfill_tenants() t`)).rows.map((r: any) => r.t)).toContain(w.tenantA);
    const ctx = systemContext(w.tenantA, [w.companyA1.id, w.companyA2.id], 'test');
    expect(await withTenant(h.pool, ctx, (tx) => backfillLegacyReminders(tx, ctx))).toEqual({ candidates: 1, scheduled: 1 });
    expect((await reminderRows(b.familyId)).rows.map((x) => x.offset_days)).toEqual([90, 60, 30, 7]);
    expect((await h.owner.query(`SELECT t FROM contract_reminder_backfill_tenants() t`)).rows.map((r: any) => r.t)).not.toContain(w.tenantA);
  });

  it('ertelenen #3: işçi geri doldurma taramasını İstanbul gününde bir kez yapar; hata olursa gün işaretlenmez', async () => {
    const { dailyReminderBackfill } = await import('../src/modules/contractReminders.ts');
    let calls = 0;
    let fail = false;
    const gate = dailyReminderBackfill(async () => { calls++; if (fail) throw new Error('db'); return 1; });
    const pool = h.pool;
    expect(await gate(pool, new Date('2026-11-17T06:00:00Z'))).toBe(1);
    expect(await gate(pool, new Date('2026-11-17T06:05:00Z'))).toBeNull();
    expect(await gate(pool, new Date('2026-11-17T20:59:00Z'))).toBeNull(); // İstanbul 23:59
    expect(calls).toBe(1);
    fail = true;
    await expect(gate(pool, new Date('2026-11-17T21:00:00Z'))).rejects.toThrow('db'); // İstanbul 18.11 00:00
    expect(await gate(pool, new Date('2026-11-17T21:00:30Z'))).toBeNull(); // bir dakika dolmadan yeniden denemez
    fail = false;
    expect(await gate(pool, new Date('2026-11-17T21:01:00Z'))).toBe(1);
    expect(await gate(pool, new Date('2026-11-18T10:00:00Z'))).toBeNull();
    expect(calls).toBe(3);
  });
});
