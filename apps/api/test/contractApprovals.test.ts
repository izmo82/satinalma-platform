// v2 Faz 3 (D108+) Görev 5: onay kararı API'si — sıralı ilerleme ve görevler, yanlış kişi/görev ayrılığı 403, vekil, red gerekçesi,
// yeniden gönderim, içerik değişince iptal (R5, Review Focus 3), askıya alma devri (Focus 2), başka departmandan onaycı (R6, Focus 4).
// Gerçek PostgreSQL + nesne deposu; her test kendi sentetik dünyasında. Veriler sentetik.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { createSyntheticWorld, syntheticPdf, type SyntheticWorld } from '../src/devdata.ts';
import { DevAuthProvider } from '../src/auth.ts';
import { withTenant, type TenantContext } from '../src/db.ts';
import { handOffOpenTasks } from '../src/modules/directory.ts';
import { makeHarness } from './harness.ts';

let h: Awaited<ReturnType<typeof makeHarness>>;
let auth: DevAuthProvider;
beforeAll(async () => { h = await makeHarness(); auth = new DevAuthProvider(h.config.devAuthSecret!); });
afterAll(async () => { await h.close(); });

type UserKey = keyof SyntheticWorld['users'];
type Who = UserKey | { email: string };
const fresh = () => createSyntheticWorld(h.owner, `-${randomUUID().slice(0, 8)}`);
const parse = (b: string) => { try { return b ? JSON.parse(b) : null; } catch { return b; } };

async function call(w: SyntheticWorld, who: Who, method: string, url: string, body?: unknown, headers: Record<string, string> = {}) {
  const email = typeof who === 'string' ? w.users[who].email : who.email;
  const token = await auth.issue(`dev|${email}`);
  const res = await h.app.inject({ method: method as any, url, headers: { authorization: `Bearer ${token}`, 'x-tenant-id': w.tenantA, ...headers },
    ...(body !== undefined ? { payload: body as any } : {}) });
  return { status: res.statusCode, body: parse(res.body) };
}
async function uploadContract(w: SyntheticWorld, who: UserKey = 'techEval'): Promise<string> {
  const token = await auth.issue(`dev|${w.users[who].email}`);
  const boundary = '----sp' + randomUUID();
  const text = `SENTETIK ${randomUUID()}`;
  const fields: Record<string, string> = { companyId: w.companyA1.id, kind: 'CONTRACT', title: `Bakım sözleşmesi ${text.slice(-4)} (SENTETİK)` };
  const parts: Buffer[] = [];
  for (const [k, v] of Object.entries(fields)) parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`));
  parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="sozlesme.pdf"\r\nContent-Type: application/pdf\r\n\r\n`),
    syntheticPdf([[text]]), Buffer.from(`\r\n--${boundary}--\r\n`));
  const res = await h.app.inject({ method: 'POST', url: '/api/v1/documents', payload: Buffer.concat(parts),
    headers: { authorization: `Bearer ${token}`, 'x-tenant-id': w.tenantA, 'content-type': `multipart/form-data; boundary=${boundary}` } });
  expect([200, 201], res.body).toContain(res.statusCode);
  return parse(res.body).documentVersionId;
}
/** Onaycılar: BT sorumlusu security (vekil buyer), satınalma sorumlusu legal (vekil legal2), direktör masterData (vekil finance). */
async function approvers(w: SyntheticWorld, extraDepartments: { departmentId: string; headUserId: string | null; deputyUserId: string | null }[] = [],
  org: Record<string, string> = {}) {
  const r = await call(w, 'tenantAdmin', 'PUT', '/api/v1/approver-assignments', {
    organization: { leadUserId: w.users.legal.id, leadDeputyUserId: w.users.legal2.id, directorUserId: w.users.masterData.id, directorDeputyUserId: w.users.finance.id, ...org },
    departments: [{ departmentId: w.departments.bt, headUserId: w.users.security.id, deputyUserId: w.users.buyer.id }, ...extraDepartments],
  });
  expect(r.status, JSON.stringify(r.body)).toBe(200);
}
const fullFields = (w: SyntheticWorld) => ({
  supplierId: w.suppliers.s1, contractType: 'MAINTENANCE', ownerUserId: w.users.techEval.id, signedOn: '2026-11-01',
  currency: 'TRY', amount: '120000.00', limitBasis: 'NET', startDate: '2026-11-01', endDate: '2027-10-31', autoRenewal: false,
});
/** Taslak + tam alanlar; `submit` verilirse onaya gönderilir. */
async function contract(w: SyntheticWorld, who: UserKey = 'techEval', submit: Record<string, unknown> | null = {}) {
  const p = await call(w, 'buyer', 'POST', '/api/v1/projects', { companyId: w.companyA1.id, title: `Sözleşme projesi ${randomUUID().slice(0, 4)}`, category: 'BT hizmetleri',
    need: 'Sentetik ihtiyaç', currency: 'TRY', budget: '100000.00', budgetVerified: false, departmentId: w.departments.bt,
    lines: [{ lot: 'Lot 1', description: 'Bakım hizmeti', unit: 'ay', quantity: '12' }], criteria: [{ code: 'PRICE', name: 'Fiyat', kind: 'PRICE', weight: '100' }] });
  expect(p.status, JSON.stringify(p.body)).toBe(201);
  const d = await call(w, who, 'POST', '/api/v1/contract-drafts', { documentVersionId: await uploadContract(w, who), projectId: p.body.id });
  expect(d.status, JSON.stringify(d.body)).toBe(201);
  const f = await call(w, who, 'PUT', `/api/v1/contracts/${d.body.familyId}/fields`, fullFields(w));
  expect(f.status, JSON.stringify(f.body)).toBe(200);
  let chainId: string | null = null;
  if (submit) {
    const s = await call(w, who, 'POST', `/api/v1/contracts/${d.body.familyId}/submit`, submit);
    expect(s.status, JSON.stringify(s.body)).toBe(200);
    chainId = s.body.chainId;
  }
  return { familyId: d.body.familyId as string, cv: d.body.contractVersionId as string, termsId: f.body.fields.termsId as string, chainId };
}
const v2 = (w: SyntheticWorld, who: Who, familyId: string) => call(w, who, 'GET', `/api/v1/contracts/${familyId}/v2`);
const steps = async (w: SyntheticWorld, familyId: string) => (await v2(w, 'legal', familyId)).body.chain.steps as { id: string; order: number; kind: string; decision: string | null }[];
const decide = (w: SyntheticWorld, who: Who, stepId: string, decision: 'APPROVED' | 'REJECTED', reason?: string | null) =>
  call(w, who, 'POST', `/api/v1/contract-approval-steps/${stepId}/decision`, reason === undefined ? { decision } : { decision, reason });
const mine = (w: SyntheticWorld, who: Who) => call(w, who, 'GET', '/api/v1/contract-approvals/mine');
const tasks = (w: SyntheticWorld, who: Who, view = 'mine') => call(w, who, 'GET', `/api/v1/tasks?view=${view}`);
const audits = async (familyId: string) => (await h.owner.query<{ action: string; reason: string | null; data: any }>(
  `SELECT action, reason, data FROM audit_events WHERE entity_id = $1 ORDER BY id`, [familyId])).rows;
const taskRow = async (key: string) => (await h.owner.query<{ status: string; assignee_user_id: string | null; reason: string; kind: string; entity_type: string }>(
  `SELECT status, assignee_user_id, reason, kind, entity_type FROM tasks WHERE dedupe_key = $1 ORDER BY created_at DESC LIMIT 1`, [key])).rows[0];
/** Başka departmandan (İK) Departman kullanıcısı (R6). */
async function ikUser(w: SyntheticWorld) {
  const email = `ik-${randomUUID().slice(0, 8)}@sentetik.example`;
  const id = (await h.owner.query<{ id: string }>(`INSERT INTO users (auth_subject, email, display_name) VALUES ($1,$2,'İK Onaycı (SENTETİK)') RETURNING id`,
    [`dev|${email}`, email])).rows[0]!.id;
  await h.owner.query(`INSERT INTO memberships (tenant_id, user_id, roles, company_ids, department_ids) VALUES ($1,$2,ARRAY['DEPARTMENT_USER'],$3,$4)`,
    [w.tenantA, id, [w.companyA1.id], [w.departments.ik]]);
  return { id, email };
}

describe('onay kararı: sıralı ilerleme', () => {
  it('adımlar sırayla onaylanır; görev sıradakine geçer; son adımda zincir APPROVED + hatırlatıcılar; yanlış kişi ve ekleyen 403', async () => {
    const w = await fresh();
    await approvers(w);
    const c = await contract(w);
    const [s1, s2, s3] = await steps(w, c.familyId);

    // Yanlış kişi (adımda değil, vekil değil) 403; ekleyen 403 segregation_of_duties; sırası gelmemiş adım 409; bilinmeyen adım 404.
    const wrong = await decide(w, 'finance', s1!.id, 'APPROVED');
    expect(wrong.status).toBe(403);
    expect(wrong.body.error.code).toBe('not_step_approver');
    const own = await decide(w, 'techEval', s1!.id, 'APPROVED');
    expect(own.status).toBe(403);
    expect(own.body.error.code).toBe('segregation_of_duties');
    const early = await decide(w, 'legal', s2!.id, 'APPROVED');
    expect(early.status).toBe(409);
    expect(early.body.error.code).toBe('step_not_current');
    expect((await decide(w, 'legal', randomUUID(), 'APPROVED')).status).toBe(404);
    // Departman kullanıcısı olmayan rol (Denetçi) karar veremez.
    expect((await decide(w, 'auditor', s1!.id, 'APPROVED')).status).toBe(403);

    // Bekleyen onaylarım: görev listesiyle aynı küme.
    const m1 = await mine(w, 'security');
    expect(m1.status).toBe(200);
    expect(m1.body.items).toHaveLength(1);
    expect(m1.body.items[0]).toMatchObject({ stepId: s1!.id, order: 1, stepCount: 3, kind: 'DEPARTMENT_HEAD', kindLabel: 'Departman sorumlusu', asDeputy: false, canDecide: true,
      submittedBy: { id: w.users.techEval.id }, contract: { familyId: c.familyId, status: 'IN_APPROVAL', statusLabel: 'Departman sorumlusu onayında', amount: '120000.00' } });
    const t1 = (await tasks(w, 'security')).body.items.filter((t: any) => t.kind === 'contract_approval');
    expect(t1.map((t: any) => t.id)).toEqual([m1.body.items[0].taskId]);
    expect((await mine(w, 'legal')).body.items).toHaveLength(0);

    const a1 = await decide(w, 'security', s1!.id, 'APPROVED', 'Uygundur');
    expect(a1.status, JSON.stringify(a1.body)).toBe(200);
    expect(a1.body).toMatchObject({ stepId: s1!.id, decision: 'APPROVED', chainStatus: 'OPEN', nextStep: { stepId: s2!.id, order: 2, kind: 'PROCUREMENT_LEAD', assigneeUserId: w.users.legal.id } });
    expect(a1.body.contract.status).toEqual({ code: 'IN_APPROVAL', label: 'Satınalma sorumlusu onayında' });
    expect((await taskRow(`contract-approval:${c.chainId}:1`))!.status).toBe('DONE');
    expect(await taskRow(`contract-approval:${c.chainId}:2`)).toMatchObject({ status: 'OPEN', assignee_user_id: w.users.legal.id });
    expect((await mine(w, 'security')).body.items).toHaveLength(0);
    expect((await mine(w, 'legal')).body.items.map((i: any) => i.stepId)).toEqual([s2!.id]);
    const again = await decide(w, 'security', s1!.id, 'APPROVED');
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe('step_decided');

    expect((await decide(w, 'legal', s2!.id, 'APPROVED')).status).toBe(200);
    const last = await decide(w, 'masterData', s3!.id, 'APPROVED');
    expect(last.status, JSON.stringify(last.body)).toBe(200);
    expect(last.body.chainStatus).toBe('APPROVED');
    expect(last.body.nextStep).toBeNull();
    expect(last.body.contract.status).toEqual({ code: 'APPROVED', label: 'Yürürlükte' });
    expect(last.body.contract.chain.status).toBe('APPROVED');
    expect(last.body.contract.can).toMatchObject({ edit: false, submit: false, decide: false });
    // R7: hatırlatıcılar onaylı koşul revizyonu için aynı işlemde kuruldu.
    const rem = (await h.owner.query<{ terms_id: string; kind: string; offset_days: number }>(`SELECT terms_id, kind, offset_days FROM contract_reminders WHERE family_id = $1 ORDER BY offset_days`, [c.familyId])).rows;
    expect(rem.map((r) => r.offset_days)).toEqual([7, 30, 60, 90]);
    expect(new Set(rem.map((r) => r.terms_id))).toEqual(new Set([c.termsId]));
    expect(last.body.contract.reminders.scheduled).toHaveLength(4);
    // Kapalı zincire karar 409.
    const closed = await decide(w, 'masterData', s3!.id, 'APPROVED');
    expect(closed.status).toBe(409);

    // Denetim: her karar, onay; karar kaydı adımda.
    const acts = (await audits(c.familyId)).map((a) => a.action);
    expect(acts.filter((a) => a === 'contract.approval.decided')).toHaveLength(3);
    expect(acts).toContain('contract.approval.approved');
    expect(acts).toContain('contract.submitted');
    expect(acts).toContain('contract.reminders.scheduled');
    expect(acts.indexOf('contract.approval.approved')).toBeLessThan(acts.indexOf('contract.reminders.scheduled'));
    const st = (await h.owner.query(`SELECT step_order, decision, decided_by, reason FROM contract_approval_steps WHERE chain_id = $1 ORDER BY step_order`, [c.chainId])).rows;
    expect(st).toEqual([
      { step_order: 1, decision: 'APPROVED', decided_by: w.users.security.id, reason: 'Uygundur' },
      { step_order: 2, decision: 'APPROVED', decided_by: w.users.legal.id, reason: null },
      { step_order: 3, decision: 'APPROVED', decided_by: w.users.masterData.id, reason: null },
    ]);
  });

  it('vekil karar verebilir (adımdaki kişinin yerine); asıl kişi de karar verebilir ama adım bir kez karar alır', async () => {
    const w = await fresh();
    await approvers(w);
    const c = await contract(w);
    const [s1, s2] = await steps(w, c.familyId);
    expect((await v2(w, 'buyer', c.familyId)).body.can.decide).toBe(true);
    const d = await decide(w, 'buyer', s1!.id, 'APPROVED');
    expect(d.status, JSON.stringify(d.body)).toBe(200);
    expect((await decide(w, 'security', s1!.id, 'APPROVED')).body.error.code).toBe('step_decided');
    expect((await decide(w, 'legal2', s2!.id, 'APPROVED')).status).toBe(200);
    const st = (await h.owner.query(`SELECT decided_by FROM contract_approval_steps WHERE chain_id = $1 ORDER BY step_order`, [c.chainId])).rows.map((r) => r.decided_by);
    expect(st.slice(0, 2)).toEqual([w.users.buyer.id, w.users.legal2.id]);
    const ev = (await audits(c.familyId)).filter((a) => a.action === 'contract.approval.decided');
    expect(ev.map((e) => e.data.asDeputy)).toEqual([true, true]);
  });
});

describe('Review Focus 1: ekleyen birden çok unvanda', () => {
  it('ekleyen hem departman hem satınalma sorumlusuysa adımlar vekile gider; ekleyen vekil olsa bile karar veremez; sözleşme vekillerle onaylanır', async () => {
    const w = await fresh();
    // buyer: BT sorumlusu ve satınalma sorumlusu; vekiller security ve legal2. buyer ayrıca kendi eklediği sözleşmede BT vekili gibi davranmaya çalışır.
    const r = await call(w, 'tenantAdmin', 'PUT', '/api/v1/approver-assignments', {
      organization: { leadUserId: w.users.buyer.id, leadDeputyUserId: w.users.legal2.id, directorUserId: w.users.masterData.id, directorDeputyUserId: w.users.finance.id },
      departments: [{ departmentId: w.departments.bt, headUserId: w.users.buyer.id, deputyUserId: w.users.security.id }],
    });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const c = await contract(w, 'buyer');
    const g = (await v2(w, 'buyer', c.familyId)).body;
    expect(g.chain.steps.map((s: any) => [s.assignedUser.id, s.viaDeputy])).toEqual([[w.users.security.id, true], [w.users.legal2.id, true], [w.users.masterData.id, false]]);
    expect(g.can.decide).toBe(false);
    const [s1, s2, s3] = g.chain.steps;
    const self = await decide(w, 'buyer', s1.id, 'APPROVED');
    expect(self.status).toBe(403);
    expect(self.body.error.code).toBe('segregation_of_duties');
    // buyer'ı BT vekili yapsak da (asıl kişi security) görev ayrılığı karar vermesini engeller.
    await call(w, 'tenantAdmin', 'PUT', '/api/v1/approver-assignments', { departments: [{ departmentId: w.departments.bt, headUserId: w.users.security.id, deputyUserId: w.users.buyer.id }] });
    expect((await decide(w, 'buyer', s1.id, 'APPROVED')).body.error.code).toBe('segregation_of_duties');
    expect((await decide(w, 'security', s1.id, 'APPROVED')).status).toBe(200);
    expect((await decide(w, 'legal2', s2.id, 'APPROVED')).status).toBe(200);
    expect((await decide(w, 'masterData', s3.id, 'APPROVED')).status).toBe(200);
    const decidedBy = (await h.owner.query(`SELECT decided_by FROM contract_approval_steps WHERE chain_id = $1`, [c.chainId])).rows.map((x) => x.decided_by);
    expect(decidedBy).not.toContain(w.users.buyer.id);
    expect((await v2(w, 'buyer', c.familyId)).body.status.code).toBe('APPROVED');
  });
});

describe('Review Focus 2: askıya alma devri', () => {
  it('zincir ortasında askıya alınan onaycının görevi o unvanın vekiline geçer; vekil karar verir, askıdaki kişi ve başka unvanın vekili veremez', async () => {
    const w = await fresh();
    // legal: satınalma sorumlusu (vekil legal2) ve İK sorumlusu (vekil finance). Genel devir ilk atamayı (İK) seçerdi; adım görevi legal2'ye gitmeli.
    await approvers(w, [{ departmentId: w.departments.ik, headUserId: w.users.legal.id, deputyUserId: w.users.finance.id }]);
    const c = await contract(w);
    const [s1, s2, s3] = await steps(w, c.familyId);
    expect((await decide(w, 'security', s1!.id, 'APPROVED')).status).toBe(200);
    expect(await taskRow(`contract-approval:${c.chainId}:2`)).toMatchObject({ status: 'OPEN', assignee_user_id: w.users.legal.id });

    // Entra eşitlemesi askıya alır (Faz 2 R5): üyelik SUSPENDED + açık görevlerin devri (eşitleme bağlamı: tüm şirketler, tüm departmanlar).
    await h.owner.query(`UPDATE memberships SET status = 'SUSPENDED', suspended_by_directory = true WHERE tenant_id = $1 AND user_id = $2`, [w.tenantA, w.users.legal.id]);
    const sys: TenantContext = { tenantId: w.tenantA, userId: w.users.tenantAdmin.id, roles: [], companyIds: [w.companyA1.id, w.companyA2.id], departmentIds: [],
      allDepartments: true, correlationId: `test-${randomUUID()}` };
    const n = await withTenant(h.pool, sys, (tx) => handOffOpenTasks(tx, sys, w.users.legal.id, 'directory_suspended', { runId: 'test' }));
    expect(n).toBeGreaterThanOrEqual(1);
    expect(await taskRow(`contract-approval:${c.chainId}:2`)).toMatchObject({ status: 'OPEN', assignee_user_id: w.users.legal2.id });
    const m = await mine(w, 'legal2');
    expect(m.body.items).toHaveLength(1);
    expect(m.body.items[0]).toMatchObject({ stepId: s2!.id, asDeputy: true, canDecide: true });

    expect((await decide(w, 'legal', s2!.id, 'APPROVED')).status).toBe(403);
    const other = await decide(w, 'finance', s2!.id, 'APPROVED');
    expect(other.status).toBe(403);
    expect(other.body.error.code).toBe('not_step_approver');
    const ok = await decide(w, 'legal2', s2!.id, 'APPROVED');
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect((await decide(w, 'masterData', s3!.id, 'APPROVED')).body.chainStatus).toBe('APPROVED');
  });

  it('sıradaki adımın kişisi askıdaysa görev doğrudan o unvanın etkin vekiline açılır', async () => {
    const w = await fresh();
    await approvers(w);
    const c = await contract(w);
    const [s1] = await steps(w, c.familyId);
    await h.owner.query(`UPDATE memberships SET status = 'SUSPENDED' WHERE tenant_id = $1 AND user_id = $2`, [w.tenantA, w.users.legal.id]);
    const r = await decide(w, 'security', s1!.id, 'APPROVED');
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.nextStep).toMatchObject({ order: 2, assigneeUserId: w.users.legal2.id });
  });
});

describe('red ve yeniden gönderim; başka departmandan onaycı (R6, Review Focus 4)', () => {
  it('red gerekçesiz 422; İK onaycısı gerekçeyle reddeder → REJECTED, ekleyene görev; yeniden gönderim yeni zincir; onaycı kaydı görmeye devam eder', async () => {
    const w = await fresh();
    await approvers(w);
    const ik = await ikUser(w);
    const other = await contract(w, 'techEval', null); // İK onaycısının hiç adımı olmayan BT sözleşmesi
    const c = await contract(w, 'techEval', { extraApproverIds: [ik.id] });
    const [s1, s2, s3, s4] = await steps(w, c.familyId);
    expect(s4).toMatchObject({ order: 4, kind: 'EXTRA' });

    // R6: İK kullanıcısı adımı olan sözleşmeyi görür, departmanın diğer sözleşmesini görmez; listede yalnız o.
    expect((await v2(w, ik, c.familyId)).status).toBe(200);
    expect((await v2(w, ik, other.familyId)).status).toBe(404);
    const list = await call(w, ik, 'GET', '/api/v1/contracts');
    expect(list.status).toBe(200);
    expect(list.body.items.map((i: any) => i.familyId ?? i.family?.id).filter(Boolean).length).toBeLessThanOrEqual(1);
    expect(JSON.stringify(list.body)).not.toContain(other.familyId);
    // Onaycı yazamaz: 403 (RLS 500 değil).
    const put = await call(w, ik, 'PUT', `/api/v1/contracts/${c.familyId}/fields`, { amount: '1.00' });
    expect(put.status).toBe(403);
    const etag = (await v2(w, 'techEval', c.familyId)).body.document.etag;
    const ver = await call(w, ik, 'POST', `/api/v1/contract-versions/${c.cv}/versions`, { documentVersionId: await uploadContract(w), kind: 'AMENDMENT', stage: 'DRAFT' }, { 'if-match': etag });
    expect(ver.status).toBe(403);
    expect(ver.body.error.code).toBe('department_forbidden');

    // Gerekçesiz / kısa gerekçeli red 422; karar yazılmaz.
    const noReason = await decide(w, 'security', s1!.id, 'REJECTED');
    expect(noReason.status).toBe(422);
    expect(noReason.body.error.code).toBe('reason_required');
    expect((await decide(w, 'security', s1!.id, 'REJECTED', 'kısa')).status).toBe(422);
    expect((await h.owner.query(`SELECT decision FROM contract_approval_steps WHERE id = $1`, [s1!.id])).rows[0].decision).toBeNull();

    for (const [who, s] of [['security', s1], ['legal', s2], ['masterData', s3]] as const) expect((await decide(w, who, s!.id, 'APPROVED')).status).toBe(200);
    expect((await mine(w, ik)).body.items.map((i: any) => i.stepId)).toEqual([s4!.id]);
    const reason = 'Bedel bütçe onayını aşıyor, revize edilmeli.';
    const rej = await decide(w, ik, s4!.id, 'REJECTED', reason);
    expect(rej.status, JSON.stringify(rej.body)).toBe(200);
    expect(rej.body.chainStatus).toBe('REJECTED');
    expect(rej.body.contract.status).toEqual({ code: 'REJECTED', label: 'Reddedildi' });

    // Ekleyene (gönderen) görev; gerekçe metinde; başka kullanıcının "Tümü" görünümünde yok.
    const rt = await taskRow(`contract-rejected:${c.familyId}`);
    expect(rt).toMatchObject({ status: 'OPEN', assignee_user_id: w.users.techEval.id, kind: 'contract_rejected', entity_type: 'contract_rejection' });
    expect(rt!.reason).toContain(reason);
    const tt = (await tasks(w, 'techEval')).body.items.find((t: any) => t.kind === 'contract_rejected');
    expect(tt).toMatchObject({ entityId: c.familyId, refNo: expect.stringMatching(/^SZL/) });
    expect((await tasks(w, 'security', 'all')).body.items.some((t: any) => t.kind === 'contract_rejected')).toBe(false);
    const ra = (await audits(c.familyId)).find((a) => a.action === 'contract.approval.rejected');
    expect(ra).toMatchObject({ reason, data: { order: 4, kind: 'EXTRA' } });

    // Onaydan/karardan sonra da İK onaycısı kaydı görür (R6, decided_by).
    expect((await v2(w, ik, c.familyId)).status).toBe(200);

    // Yeniden gönderim → yeni zincir; eski zincir ve gerekçe tarih olarak kalır; red görevi kapanır.
    const re = await call(w, 'techEval', 'POST', `/api/v1/contracts/${c.familyId}/submit`, { extraApproverIds: [ik.id] });
    expect(re.status, JSON.stringify(re.body)).toBe(200);
    expect(re.body.chainId).not.toBe(c.chainId);
    expect(re.body.contract.chainCount).toBe(2);
    expect((await taskRow(`contract-rejected:${c.familyId}`))!.status).toBe('DONE');
    const old = (await h.owner.query(`SELECT c.outcome, s.reason FROM contract_approval_chains c JOIN contract_approval_steps s ON s.chain_id = c.id
      WHERE c.id = $1 AND s.step_order = 4`, [c.chainId])).rows[0];
    expect(old).toEqual({ outcome: 'REJECTED', reason });

    // Yeni zinciri sonuna kadar onaylar; İK onaycısı onay bittikten sonra da görür.
    const ns = re.body.contract.chain.steps;
    for (const [who, s] of [['security', ns[0]], ['legal', ns[1]], ['masterData', ns[2]]] as const) expect((await decide(w, who, s.id, 'APPROVED')).status).toBe(200);
    const fin = await decide(w, ik, ns[3].id, 'APPROVED');
    expect(fin.status, JSON.stringify(fin.body)).toBe(200);
    expect(fin.body.chainStatus).toBe('APPROVED');
    const after = await v2(w, ik, c.familyId);
    expect(after.status).toBe(200);
    expect(after.body.status.code).toBe('APPROVED');
    expect((await v2(w, ik, other.familyId)).status).toBe(404);
  });
});

describe('Review Focus 3: içerik değişince onaylar düşer (R5)', () => {
  const oldTerms = (amount: string) => ({ currency: 'TRY', valueType: 'FIXED', amount, paymentTerms: 'Fatura tarihinden 30 gün', startDate: '2026-11-01', endDate: '2027-10-31',
    autoRenewal: false, renewalMonths: null, noticeAmount: null, noticeUnit: null, nonWorkingDay: 'PREVIOUS_WORKING_DAY', sourceRef: 'Madde 4.2', limitBasis: 'NET',
    changeReason: 'Tutar düzeltmesi yapıldı (sentetik)' });

  it('kısmen onaylı sözleşmeye yeni belge sürümü: zincir iptal, açık adım görevi kapanır, ekleyene yeniden gönder görevi; eski onay sayılmaz', async () => {
    const w = await fresh();
    await approvers(w);
    const c = await contract(w);
    const [s1, s2] = await steps(w, c.familyId);
    expect((await decide(w, 'security', s1!.id, 'APPROVED')).status).toBe(200);
    const etag = (await v2(w, 'techEval', c.familyId)).body.document.etag;
    const nv = await call(w, 'techEval', 'POST', `/api/v1/contract-versions/${c.cv}/versions`, { documentVersionId: await uploadContract(w), kind: 'AMENDMENT', stage: 'DRAFT' }, { 'if-match': etag });
    expect(nv.status, JSON.stringify(nv.body)).toBe(201);
    expect(nv.body.cancelledChainId).toBe(c.chainId);
    const g = (await v2(w, 'techEval', c.familyId)).body;
    expect(g.chain).toMatchObject({ id: c.chainId, status: 'CANCELLED', cancelReason: 'İçerik değişti, onay baştan.' });
    expect(g.chain.steps[0].decision).toBe('APPROVED'); // tarih olarak kalır
    expect(g.status.code).toBe('INCOMPLETE'); // yeni sürümün koşulları henüz girilmedi; eski onay sayılmaz
    expect((await taskRow(`contract-approval:${c.chainId}:2`))!.status).toBe('DONE');
    expect(await taskRow(`contract-resubmit:${c.familyId}`)).toMatchObject({ status: 'OPEN', assignee_user_id: w.users.techEval.id });
    const late = await decide(w, 'legal', s2!.id, 'APPROVED');
    expect(late.status).toBe(409);
    expect(late.body.error.code).toBe('chain_closed');
    // İnceleme I1: kapalı zincirin sonucu ve adımı değişmez.
    expect((await h.owner.query(`SELECT outcome FROM contract_approval_chains WHERE id = $1`, [c.chainId])).rows[0].outcome).toBe('CANCELLED');
    expect((await h.owner.query(`SELECT decision, decided_by FROM contract_approval_steps WHERE id = $1`, [s2!.id])).rows[0]).toEqual({ decision: null, decided_by: null });
    expect((await audits(c.familyId)).map((a) => a.action)).toContain('contract.approval.cancelled');
  });

  it('eski koşul ucuyla tutar değişikliği açık zinciri iptal eder', async () => {
    const w = await fresh();
    await approvers(w);
    const c = await contract(w);
    const [s1] = await steps(w, c.familyId);
    expect((await decide(w, 'security', s1!.id, 'APPROVED')).status).toBe(200);
    const t = await call(w, 'legal', 'POST', `/api/v1/contract-versions/${c.cv}/terms`, oldTerms('150000.00'));
    expect(t.status, JSON.stringify(t.body)).toBe(201);
    expect(t.body.cancelledChainId).toBe(c.chainId);
    const g = (await v2(w, 'techEval', c.familyId)).body;
    expect(g.chain.status).toBe('CANCELLED');
    expect(g.status.code).toBe('DRAFT');
    expect(g.can.submit).toBe(true);
  });

  it('onaydan sonra eski koşul ucuyla kayıt: durum Yürürlükte kalmaz; hatırlatıcılar ve yenileme kararı onaylı koşula bağlı kalır', async () => {
    const w = await fresh();
    await approvers(w);
    const c = await contract(w);
    const [s1, s2, s3] = await steps(w, c.familyId);
    for (const [who, s] of [['security', s1], ['legal', s2], ['masterData', s3]] as const) expect((await decide(w, who, s!.id, 'APPROVED')).status).toBe(200);
    expect((await v2(w, 'techEval', c.familyId)).body.status.code).toBe('APPROVED');
    const t = await call(w, 'legal', 'POST', `/api/v1/contract-versions/${c.cv}/terms`, oldTerms('150000.00'));
    expect(t.status, JSON.stringify(t.body)).toBe(201);
    expect(t.body.cancelledChainId).toBeNull();
    const g = (await v2(w, 'techEval', c.familyId)).body;
    expect(g.status.code).toBe('DRAFT');
    expect(g.fields.amount).toBe('150000.00');
    expect(g.can).toMatchObject({ edit: true, submit: true });
    // Hatırlatıcılar onaylı koşulla sürer.
    const rem = (await h.owner.query<{ terms_id: string }>(`SELECT DISTINCT terms_id FROM contract_reminders WHERE family_id = $1`, [c.familyId])).rows;
    expect(rem.map((r) => r.terms_id)).toEqual([c.termsId]);
    // T6 inceleme m2: yenileme kararı yürürlükteki (onaylı) koşula bağlanır; yeni doğrulanmamış revizyon 409 vermez.
    const dec = await call(w, 'legal', 'POST', `/api/v1/contract-versions/${c.cv}/renewal-decision`, { decision: 'RENEGOTIATE', rationale: 'Tutar değişikliği yeniden müzakere edilecek.' });
    expect(dec.status, JSON.stringify(dec.body)).toBe(201);
    const rd = (await h.owner.query(`SELECT terms_id FROM renewal_decisions WHERE id = $1`, [dec.body.id])).rows[0];
    expect(rd.terms_id).toBe(c.termsId);
    // Değişen içerik yeniden onaya gönderilebilir (yeni zincir yeni koşulla).
    const re = await call(w, 'techEval', 'POST', `/api/v1/contracts/${c.familyId}/submit`, {});
    expect(re.status, JSON.stringify(re.body)).toBe(200);
    expect(re.body.contract.chain.termsId).toBe(t.body.id);
  });
});

describe('inceleme düzeltmeleri: sahipsiz adım yok (I2), şirket erişimi (I3)', () => {
  const sysCtx = (w: SyntheticWorld): TenantContext => ({ tenantId: w.tenantA, userId: w.users.tenantAdmin.id, roles: ['ADMIN'], companyIds: [], departmentIds: [],
    allDepartments: true, correlationId: `test-${randomUUID()}` });
  /** Askıya alma + devir. Bağlam bilerek şirketsiz (Yönetici rol ekranı gibi): adım araması kiracı geneli kapsamda çalışmalı. */
  async function suspend(w: SyntheticWorld, userId: string) {
    await h.owner.query(`UPDATE memberships SET status = 'SUSPENDED', suspended_by_directory = true WHERE tenant_id = $1 AND user_id = $2`, [w.tenantA, userId]);
    const ctx = sysCtx(w);
    return withTenant(h.pool, ctx, (tx) => handOffOpenTasks(tx, ctx, userId, 'directory_suspended', { runId: 'test' }));
  }

  it('askıya alınan ek onaycı (vekili yok): zincir iptal edilir, gönderene yeniden gönderim görevi; görev sahipsiz kalmaz', async () => {
    const w = await fresh();
    await approvers(w);
    const ik = await ikUser(w);
    const c = await contract(w, 'techEval', { extraApproverIds: [ik.id] });
    const [s1, s2, s3, s4] = await steps(w, c.familyId);
    for (const [who, s] of [['security', s1], ['legal', s2], ['masterData', s3]] as const) expect((await decide(w, who, s!.id, 'APPROVED')).status).toBe(200);
    expect(await taskRow(`contract-approval:${c.chainId}:4`)).toMatchObject({ status: 'OPEN', assignee_user_id: ik.id });
    await suspend(w, ik.id);
    expect(await taskRow(`contract-approval:${c.chainId}:4`)).toMatchObject({ status: 'DONE' });
    const ch = (await h.owner.query(`SELECT outcome, cancel_reason FROM contract_approval_chains WHERE id = $1`, [c.chainId])).rows[0];
    expect(ch).toEqual({ outcome: 'CANCELLED', cancel_reason: 'Onaycı askıya alındı; uygun vekil yok. Yeniden onaya gönderin.' });
    expect(await taskRow(`contract-resubmit:${c.familyId}`)).toMatchObject({ status: 'OPEN', assignee_user_id: w.users.techEval.id });
    expect((await h.owner.query(`SELECT count(*)::int AS n FROM tasks WHERE status = 'OPEN' AND entity_type = 'contract_approval_step' AND assignee_user_id IS NULL
      AND tenant_id = $1`, [w.tenantA])).rows[0].n).toBe(0);
    expect((await v2(w, 'techEval', c.familyId)).body.status.code).toBe('DRAFT');
    expect(s4).toBeTruthy();
  });

  it('vekil üzerinden atanmış adımın kişisi askıya alınırsa (başka uygun vekil yok) zincir iptal edilir', async () => {
    const w = await fresh();
    // buyer hem ekleyen hem BT sorumlusu: 1. adım vekile (security) gider; security askıya alınınca uygun kimse kalmaz.
    const r = await call(w, 'tenantAdmin', 'PUT', '/api/v1/approver-assignments', {
      organization: { leadUserId: w.users.legal.id, leadDeputyUserId: w.users.legal2.id, directorUserId: w.users.masterData.id, directorDeputyUserId: w.users.finance.id },
      departments: [{ departmentId: w.departments.bt, headUserId: w.users.buyer.id, deputyUserId: w.users.security.id }],
    });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const c = await contract(w, 'buyer');
    const [s1] = await steps(w, c.familyId);
    expect(await taskRow(`contract-approval:${c.chainId}:1`)).toMatchObject({ status: 'OPEN', assignee_user_id: w.users.security.id });
    await suspend(w, w.users.security.id);
    expect((await h.owner.query(`SELECT outcome FROM contract_approval_chains WHERE id = $1`, [c.chainId])).rows[0].outcome).toBe('CANCELLED');
    expect(await taskRow(`contract-resubmit:${c.familyId}`)).toMatchObject({ status: 'OPEN', assignee_user_id: w.users.buyer.id });
    expect((await decide(w, 'buyer', s1!.id, 'APPROVED')).status).toBe(403); // ekleyen hâlâ karar veremez
  });

  it('karar sonrası sıradaki ek onaycı askıdaysa (vekil yok) zincir iptal edilir ve yanıt CANCELLED döner', async () => {
    const w = await fresh();
    await approvers(w);
    const ik = await ikUser(w);
    const c = await contract(w, 'techEval', { extraApproverIds: [ik.id] });
    const [s1, s2, s3] = await steps(w, c.familyId);
    for (const [who, s] of [['security', s1], ['legal', s2]] as const) expect((await decide(w, who, s!.id, 'APPROVED')).status).toBe(200);
    await h.owner.query(`UPDATE memberships SET status = 'SUSPENDED' WHERE tenant_id = $1 AND user_id = $2`, [w.tenantA, ik.id]);
    const r = await decide(w, 'masterData', s3!.id, 'APPROVED');
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body).toMatchObject({ chainStatus: 'CANCELLED', nextStep: null });
    expect(r.body.contract.chain).toMatchObject({ status: 'CANCELLED', cancelReason: 'Onaycı askıya alındı; uygun vekil yok. Yeniden onaya gönderin.' });
    expect((await h.owner.query(`SELECT decision FROM contract_approval_steps WHERE id = $1`, [s3!.id])).rows[0].decision).toBe('APPROVED');
    expect(await taskRow(`contract-resubmit:${c.familyId}`)).toMatchObject({ status: 'OPEN', assignee_user_id: w.users.techEval.id });
  });

  it('onaycı sözleşmenin şirketine erişemiyorsa gönderim 409 approver_no_company_access (kişinin adıyla); zincir oluşmaz', async () => {
    const w = await fresh();
    await approvers(w, [], { directorUserId: w.users.multi.id }); // multi yalnız A2 şirketinde; sözleşme A1
    const c = await contract(w, 'techEval', null);
    const r = await call(w, 'techEval', 'POST', `/api/v1/contracts/${c.familyId}/submit`, {});
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe('approver_no_company_access');
    expect(r.body.error.message).toContain('Ece Polat');
    expect(r.body.error.details).toMatchObject({ userId: w.users.multi.id, kind: 'PROCUREMENT_DIRECTOR' });
    expect((await h.owner.query(`SELECT count(*)::int AS n FROM contract_approval_chains WHERE family_id = $1`, [c.familyId])).rows[0].n).toBe(0);
  });

  // v2 Faz 3 (D108): final inceleme M6 — önizleme gönderimle aynı şirket erişimi denetimini yapar ve bildirir.
  it('M6: önizleme şirkete erişemeyen onaycıyı ok:false ve aynı iletiyle bildirir', async () => {
    const w = await fresh();
    await approvers(w, [], { directorUserId: w.users.multi.id });
    const c = await contract(w, 'techEval', null);
    const p = await call(w, 'techEval', 'GET', `/api/v1/contracts/${c.familyId}/approval-preview`);
    expect(p.status, JSON.stringify(p.body)).toBe(200);
    expect(p.body).toMatchObject({ ok: false, error: 'approver_no_company_access', userId: w.users.multi.id, kind: 'PROCUREMENT_DIRECTOR' });
    const r = await call(w, 'techEval', 'POST', `/api/v1/contracts/${c.familyId}/submit`, {});
    expect(r.body.error.message).toBe(p.body.message);
  });

  it('N1: şirkete erişemeyen vekil uygun sayılmaz (zincir iptal); ADMIN+PROCUREMENT kısmi company_ids ile gönderim 409 almaz', async () => {
    const w = await fresh();
    // Satınalma sorumlusu vekili multi yalnız A2'de; sözleşme A1.
    await approvers(w, [], { leadDeputyUserId: w.users.multi.id });
    const c = await contract(w);
    const [s1] = await steps(w, c.familyId);
    expect((await decide(w, 'security', s1!.id, 'APPROVED')).status).toBe(200);
    await suspend(w, w.users.legal.id);
    expect((await h.owner.query(`SELECT outcome FROM contract_approval_chains WHERE id = $1`, [c.chainId])).rows[0].outcome).toBe('CANCELLED');

    // Yönetici + Satınalma, saklı company_ids yalnız A2: 039 kuralıyla tüm şirketleri görür → direktör olabilir, gönderim 200.
    const w2 = await fresh();
    const email = `adm-${randomUUID().slice(0, 8)}@sentetik.example`;
    const id = (await h.owner.query<{ id: string }>(`INSERT INTO users (auth_subject, email, display_name) VALUES ($1,$2,'Yönetici Direktör (SENTETİK)') RETURNING id`,
      [`dev|${email}`, email])).rows[0]!.id;
    await h.owner.query(`INSERT INTO memberships (tenant_id, user_id, roles, company_ids) VALUES ($1,$2,ARRAY['ADMIN','PROCUREMENT'],$3)`, [w2.tenantA, id, [w2.companyA2.id]]);
    await approvers(w2, [], { directorUserId: id });
    const c2 = await contract(w2, 'techEval', null);
    const r = await call(w2, 'techEval', 'POST', `/api/v1/contracts/${c2.familyId}/submit`, {});
    expect(r.status, JSON.stringify(r.body)).toBe(200);
  });

  it('N2: görevi tutan vekil askıya alınırsa ve adımın kendi kişisi yeniden etkinse görev ona döner (iptal yok)', async () => {
    const w = await fresh();
    await approvers(w);
    const c = await contract(w);
    const [s1, s2] = await steps(w, c.familyId);
    expect((await decide(w, 'security', s1!.id, 'APPROVED')).status).toBe(200);
    await suspend(w, w.users.legal.id);
    expect(await taskRow(`contract-approval:${c.chainId}:2`)).toMatchObject({ status: 'OPEN', assignee_user_id: w.users.legal2.id });
    await h.owner.query(`UPDATE memberships SET status = 'ACTIVE', suspended_by_directory = false WHERE tenant_id = $1 AND user_id = $2`, [w.tenantA, w.users.legal.id]);
    await suspend(w, w.users.legal2.id);
    expect(await taskRow(`contract-approval:${c.chainId}:2`)).toMatchObject({ status: 'OPEN', assignee_user_id: w.users.legal.id });
    expect((await h.owner.query(`SELECT outcome FROM contract_approval_chains WHERE id = $1`, [c.chainId])).rows[0].outcome).toBeNull();
    expect((await decide(w, 'legal', s2!.id, 'APPROVED')).status).toBe(200);
  });
});

// v2 Faz 3 (D108): final inceleme M5 (kişi seçicide askıdaki üye yok) ve M8 (/me izin listesi).
describe('final inceleme: kişi seçici ve izinler', () => {
  it('M5: /members?active=true askıdaki üyeyi listelemez; parametresiz çağrı eskisi gibi tüm üyeleri döner', async () => {
    const w = await fresh();
    await h.owner.query(`UPDATE memberships SET status = 'SUSPENDED' WHERE tenant_id = $1 AND user_id = $2`, [w.tenantA, w.users.buyer.id]);
    const all = await call(w, 'techEval', 'GET', '/api/v1/members');
    expect(all.status).toBe(200);
    expect(all.body.map((m: any) => m.id)).toContain(w.users.buyer.id);
    const active = await call(w, 'techEval', 'GET', '/api/v1/members?active=true');
    expect(active.status).toBe(200);
    expect(active.body.map((m: any) => m.id)).not.toContain(w.users.buyer.id);
    expect(active.body.map((m: any) => m.id)).toContain(w.users.techEval.id);
  });

  it('ertelenen #9: kullanıcının değişikliğiyle iptal edilen tur o kişiyi gösterir (cancelledBy)', async () => {
    const w = await fresh();
    await approvers(w);
    const c = await contract(w);
    expect((await v2(w, 'techEval', c.familyId)).body.chain).toMatchObject({ status: 'OPEN', cancelledBy: null });
    const put = await call(w, 'techEval', 'PUT', `/api/v1/contracts/${c.familyId}/fields`, { amount: '999.00' });
    expect(put.status, JSON.stringify(put.body)).toBe(200);
    const chain = (await v2(w, 'techEval', c.familyId)).body.chain;
    expect(chain.status).toBe('CANCELLED');
    expect(chain.cancelledBy).toMatchObject({ id: w.users.techEval.id });
    expect(chain.cancelledBy.displayName).not.toBe('');
  });

  it('M8: /me etkin kiracının izinlerini döner', async () => {
    const w = await fresh();
    const me = await call(w, 'techEval', 'GET', '/api/v1/me');
    expect(me.status).toBe(200);
    expect(me.body.permissions).toContain('contract.read');
    expect(me.body.permissions).not.toContain('template.manage');
  });
});

describe('persona K2: İşlerim sayfalama ve onay adımının görünürlüğü', () => {
  it('250 yüksek öncelikli işi olan onaycı yeni onay görevini ilk sayfada görür (kayıt no = sözleşme kodu); sayfalama bütün işlere ulaşır, sayaç değişmez', async () => {
    const w = await fresh();
    await approvers(w);
    const c = await contract(w);
    const code = (await v2(w, 'legal', c.familyId)).body.family.code as string;
    const step = (await tasks(w, 'security')).body.items.find((t: any) => t.entityType === 'contract_approval_step');
    expect(step, 'Selin için onay görevi').toBeTruthy();
    // Kişiye atanmış 250 kritik ve gecikmiş iş (önceki sırada onay adımını ilk 200'ün dışına iter).
    const role = (await h.owner.query<{ r: string }>(`SELECT assignee_role AS r FROM tasks WHERE id = $1`, [step.id])).rows[0]!.r;
    await h.owner.query(`INSERT INTO tasks (tenant_id, company_id, kind, entity_type, entity_id, title, reason, next_action, assignee_role, severity, due_at, dedupe_key, assignee_user_id)
      SELECT $1, $2, 'persona_k2_load', 'supplier', $3, 'Yük işi ' || g, 'Sentetik yük', 'İnceleyin', $4, 'CRITICAL', now() - interval '1 day', 'persona-k2:' || g || ':' || $5, $6
      FROM generate_series(1, 250) g`, [w.tenantA, w.companyA1.id, w.suppliers.s1, role, randomUUID(), w.users.security.id]);

    const first = (await tasks(w, 'security')).body;
    expect(first.items).toHaveLength(200);
    expect(first.total).toBe(first.counts.mine);
    expect(first.total).toBeGreaterThanOrEqual(251);
    expect(first.nextOffset).toBe(200);
    expect(first.items[0]).toMatchObject({ id: step.id, entityType: 'contract_approval_step', refNo: code });
    expect(first.mineByType.contract_approval_step).toBe(1);
    expect(first.mineByType.supplier).toBeGreaterThanOrEqual(250);

    // Sayfa sayfa: her iş bir kez, toplam sayaçla aynı; son sayfada nextOffset null.
    const seen: string[] = [];
    let offset: number | null = 0;
    while (offset !== null) {
      const p: any = (await call(w, 'security', 'GET', `/api/v1/tasks?view=mine&limit=100&offset=${offset}`)).body;
      seen.push(...p.items.map((t: any) => t.id));
      offset = p.nextOffset;
    }
    expect(new Set(seen).size).toBe(seen.length);
    expect(seen.length).toBe(first.total);
    // 201. iş ve sonrası erişilebilir (eski sınır 200).
    const tail = (await call(w, 'security', 'GET', '/api/v1/tasks?view=mine&offset=200')).body;
    expect(tail.items.length).toBe(first.total - 200);
    expect(tail.nextOffset).toBeNull();
    // Geçersiz sayfa parametresi reddedilir.
    expect((await call(w, 'security', 'GET', '/api/v1/tasks?view=mine&limit=500')).status).toBe(400);
  });

  it('yeniden gönderim görevinde kayıt no sözleşme kodudur', async () => {
    const w = await fresh();
    await approvers(w);
    const c = await contract(w);
    const code = (await v2(w, 'legal', c.familyId)).body.family.code as string;
    const put = await call(w, 'techEval', 'PUT', `/api/v1/contracts/${c.familyId}/fields`, { amount: '130000.00' });
    expect(put.status, JSON.stringify(put.body)).toBe(200);
    const resubmit = (await tasks(w, 'techEval')).body.items.find((t: any) => t.entityType === 'contract_family');
    expect(resubmit).toMatchObject({ kind: 'contract_resubmit', refNo: code });
  });
});
