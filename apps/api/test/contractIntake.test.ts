// v2 Faz 3 (D108+) Görev 4: sözleşme ekleme akışı API'si — taslak, alanlar, aday tedarikçi, onay önizlemesi, gönderim, liste durumu.
// Gerçek PostgreSQL + nesne deposu; her test kendi sentetik dünyasında (onaycı ataması kiracı ayarıdır). Veriler sentetik.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { syntheticVkn } from '@sp/domain';
import { createSyntheticWorld, syntheticPdf, type SyntheticWorld } from '../src/devdata.ts';
import { DevAuthProvider } from '../src/auth.ts';
import { ZipStreamWriter } from '../src/zip.ts';
import { DOCX_MIME } from '../src/modules/templates.ts';
import { makeHarness } from './harness.ts';

let h: Awaited<ReturnType<typeof makeHarness>>;
let auth: DevAuthProvider;
beforeAll(async () => { h = await makeHarness(); auth = new DevAuthProvider(h.config.devAuthSecret!); });
afterAll(async () => { await h.close(); });

type UserKey = keyof SyntheticWorld['users'];
const fresh = () => createSyntheticWorld(h.owner, `-${randomUUID().slice(0, 8)}`);
const parse = (b: string) => { try { return b ? JSON.parse(b) : null; } catch { return b; } };

async function call(w: SyntheticWorld, who: UserKey, method: string, url: string, body?: unknown) {
  const token = await auth.issue(`dev|${w.users[who].email}`);
  const res = await h.app.inject({ method: method as any, url, headers: { authorization: `Bearer ${token}`, 'x-tenant-id': w.tenantA },
    ...(body !== undefined ? { payload: body as any } : {}) });
  return { status: res.statusCode, body: parse(res.body) };
}
async function multipart(w: SyntheticWorld, who: UserKey, url: string, fields: Record<string, string>, file: { name: string; mime: string; data: Buffer }) {
  const token = await auth.issue(`dev|${w.users[who].email}`);
  const boundary = '----sp' + randomUUID();
  const parts: Buffer[] = [];
  for (const [k, v] of Object.entries(fields)) parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`));
  parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${file.name}"\r\nContent-Type: ${file.mime}\r\n\r\n`), file.data, Buffer.from(`\r\n--${boundary}--\r\n`));
  const res = await h.app.inject({ method: 'POST', url, payload: Buffer.concat(parts),
    headers: { authorization: `Bearer ${token}`, 'x-tenant-id': w.tenantA, 'content-type': `multipart/form-data; boundary=${boundary}` } });
  return { status: res.statusCode, body: parse(res.body) };
}
async function uploadContract(w: SyntheticWorld, who: UserKey = 'techEval', text = `SENTETIK ${randomUUID()}`): Promise<string> {
  const r = await multipart(w, who, '/api/v1/documents', { companyId: w.companyA1.id, kind: 'CONTRACT', title: `Bakım sözleşmesi ${text.slice(-4)} (SENTETİK)` },
    { name: 'sozlesme.pdf', mime: 'application/pdf', data: syntheticPdf([[text]]) });
  expect([200, 201], JSON.stringify(r.body)).toContain(r.status);
  return r.body.documentVersionId;
}
const criteria = [{ code: 'PRICE', name: 'Fiyat', kind: 'PRICE', weight: '100' }];
const lines = [{ lot: 'Lot 1', description: 'Bakım hizmeti', unit: 'ay', quantity: '12' }];
async function project(w: SyntheticWorld, who: UserKey, departmentId: string) {
  const r = await call(w, who, 'POST', '/api/v1/projects', { companyId: w.companyA1.id, title: `Sözleşme projesi ${randomUUID().slice(0, 4)}`, category: 'BT hizmetleri',
    need: 'Sentetik ihtiyaç', currency: 'TRY', budget: '100000.00', budgetVerified: false, lines, criteria, departmentId });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return r.body.id as string;
}
/** Kiracının onaycıları: BT sorumlusu Selin (vekil Alper), satınalma sorumlusu Leyla (vekil Kerem), direktör Mine (vekil Ferda). */
async function approvers(w: SyntheticWorld, head: UserKey | null = 'security', deputy: UserKey | null = 'buyer') {
  const r = await call(w, 'tenantAdmin', 'PUT', '/api/v1/approver-assignments', {
    organization: { leadUserId: w.users.legal.id, leadDeputyUserId: w.users.legal2.id, directorUserId: w.users.masterData.id, directorDeputyUserId: w.users.finance.id },
    departments: [{ departmentId: w.departments.bt, headUserId: head ? w.users[head].id : null, deputyUserId: deputy ? w.users[deputy].id : null }],
  });
  expect(r.status, JSON.stringify(r.body)).toBe(200);
}
const fullFields = (w: SyntheticWorld) => ({
  supplierId: w.suppliers.s1, contractType: 'MAINTENANCE', ownerUserId: w.users.techEval.id, signedOn: '2026-11-01',
  currency: 'TRY', amount: '120000.00', limitBasis: 'NET', startDate: '2026-11-01', endDate: '2027-10-31', autoRenewal: false,
});
async function draft(w: SyntheticWorld, who: UserKey = 'techEval', extra: Record<string, unknown> = {}) {
  const projectId = (extra.projectId as string) ?? await project(w, 'buyer', w.departments.bt);
  const documentVersionId = (extra.documentVersionId as string) ?? await uploadContract(w, who);
  const r = await call(w, who, 'POST', '/api/v1/contract-drafts', { documentVersionId, projectId, ...extra });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return { ...r.body, projectId, documentVersionId } as { familyId: string; contractVersionId: string; duplicateOf: any; projectId: string; documentVersionId: string };
}
const v2 = (w: SyntheticWorld, who: UserKey, familyId: string) => call(w, who, 'GET', `/api/v1/contracts/${familyId}/v2`);
const famCount = async (w: SyntheticWorld) => (await h.owner.query<{ n: number }>(`SELECT count(*)::int AS n FROM contract_families WHERE tenant_id = $1`, [w.tenantA])).rows[0]!.n;

describe('taslak', () => {
  it('projesiz taslak 422 project_required; aile oluşmaz', async () => {
    const w = await fresh();
    const dv = await uploadContract(w);
    const r = await call(w, 'techEval', 'POST', '/api/v1/contract-drafts', { documentVersionId: dv });
    expect(r.status).toBe(422);
    expect(r.body.error.code).toBe('project_required');
    expect(await famCount(w)).toBe(0);
  });

  it('Departman kullanıcısı başka departmanın projesine ya da başka departmana sözleşme ekleyemez', async () => {
    const w = await fresh();
    const ikProject = await project(w, 'legal', w.departments.ik);
    const btProject = await project(w, 'buyer', w.departments.bt);
    const dv = await uploadContract(w);
    const foreign = await call(w, 'techEval', 'POST', '/api/v1/contract-drafts', { documentVersionId: dv, projectId: ikProject });
    expect(foreign.status).toBe(404);
    const otherDept = await call(w, 'techEval', 'POST', '/api/v1/contract-drafts', { documentVersionId: dv, projectId: btProject, departmentId: w.departments.ik });
    expect(otherDept.status).toBe(403);
    expect(otherDept.body.error.code).toBe('department_forbidden');
    expect(await famCount(w)).toBe(0);
  });

  it('taslak: aile + MAIN sürüm (DRAFT), proje ve departman projeden; durum Eksik alan; aynı belge uyarısı engellemez', async () => {
    const w = await fresh();
    const d = await draft(w);
    expect(d.duplicateOf).toBeNull();
    const row = (await h.owner.query(`SELECT f.project_id, f.department_id, f.intake_flow, cv.stage, cv.kind, cv.version_no FROM contract_families f
      JOIN contract_versions cv ON cv.family_id = f.id WHERE f.id = $1`, [d.familyId])).rows[0];
    expect(row).toMatchObject({ project_id: d.projectId, department_id: w.departments.bt, intake_flow: true, stage: 'DRAFT', kind: 'MAIN', version_no: 1 });
    const g = await v2(w, 'techEval', d.familyId);
    expect(g.status).toBe(200);
    expect(g.body.status).toEqual({ code: 'INCOMPLETE', label: 'Eksik alan' });
    expect(g.body.legacy).toBe(false);
    expect(g.body.project).toMatchObject({ id: d.projectId, visible: true });
    expect(g.body.missing.map((m: any) => m.field)).toEqual(['supplier', 'contractType', 'owner', 'signedOn', 'amount', 'currency', 'limitBasis', 'startDate', 'endDate', 'autoRenewal']);
    expect(g.body.can).toEqual({ edit: true, submit: false, decide: false });
    expect(g.body.document).toMatchObject({ contractVersionId: d.contractVersionId, versionNo: 1, stage: 'DRAFT', documentVersionId: d.documentVersionId });

    const again = await draft(w, 'techEval', { documentVersionId: d.documentVersionId, projectId: d.projectId });
    expect(again.duplicateOf).toMatchObject({ familyId: d.familyId });
    expect(again.familyId).not.toBe(d.familyId);
  });

  it('şablonla taslak: tür şablondan gelir ve şablon sürümünün kullanım sayısı artar (Görev 3 ertelenen test)', async () => {
    const w = await fresh();
    const chunks: Buffer[] = [];
    const z = new ZipStreamWriter({ write: async (c) => { chunks.push(c); } });
    await z.addFile('word/document.xml', Buffer.from('<w:document>sablon</w:document>'));
    await z.finish();
    const t = await multipart(w, 'masterData', '/api/v1/contract-templates', { code: 'BKM-STD', name: 'Bakım Sözleşmesi', contractType: 'MAINTENANCE', validFrom: '2026-01-01' },
      { name: 'sablon.docx', mime: DOCX_MIME, data: Buffer.concat(chunks) });
    expect(t.status, JSON.stringify(t.body)).toBe(201);
    const before = (await call(w, 'techEval', 'GET', '/api/v1/contract-templates')).body.items[0];
    expect(before.usageCount).toBe(0);
    const d = await draft(w, 'techEval', { templateVersionId: t.body.versionId });
    const after = (await call(w, 'techEval', 'GET', '/api/v1/contract-templates')).body.items[0];
    expect(after.usageCount).toBe(1);
    expect(after.currentVersion.usageCount).toBe(1);
    const g = (await v2(w, 'techEval', d.familyId)).body;
    expect(g.fields.contractType).toBe('MAINTENANCE');
    expect(g.template).toMatchObject({ versionId: t.body.versionId, code: 'BKM-STD', versionNo: 1, superseded: false });
    const bad = await call(w, 'techEval', 'POST', '/api/v1/contract-drafts', { documentVersionId: d.documentVersionId, projectId: d.projectId, templateVersionId: randomUUID() });
    expect(bad.status).toBe(422);
    expect(bad.body.error.code).toBe('template_unknown');
    // Yeni sürüm gelince eski sürüm geçersiz: taslakta ve alanlarda 422 template_superseded.
    const chunks2: Buffer[] = [];
    const z2 = new ZipStreamWriter({ write: async (c) => { chunks2.push(c); } });
    await z2.addFile('word/document.xml', Buffer.from('<w:document>sablon v2</w:document>'));
    await z2.finish();
    const v2t = await multipart(w, 'masterData', `/api/v1/contract-templates/${t.body.id}/versions`, { validFrom: '2026-06-01' },
      { name: 'sablon2.docx', mime: DOCX_MIME, data: Buffer.concat(chunks2) });
    expect(v2t.status, JSON.stringify(v2t.body)).toBe(201);
    const old = await call(w, 'techEval', 'POST', '/api/v1/contract-drafts', { documentVersionId: d.documentVersionId, projectId: d.projectId, templateVersionId: t.body.versionId });
    expect(old.status).toBe(422);
    expect(old.body.error.code).toBe('template_superseded');
    const d2 = await draft(w);
    const oldField = await call(w, 'techEval', 'PUT', `/api/v1/contracts/${d2.familyId}/fields`, { templateVersionId: t.body.versionId });
    expect(oldField.status).toBe(422);
    expect(oldField.body.error.code).toBe('template_superseded');
    expect((await call(w, 'techEval', 'PUT', `/api/v1/contracts/${d2.familyId}/fields`, { templateVersionId: v2t.body.versionId })).status).toBe(200);
  });
});

describe('aday tedarikçi (R9)', () => {
  it('VKN hatalı 422; yeni VKN aday kart + görev; aynı VKN mevcut kartı döner', async () => {
    const w = await fresh();
    const vkn = syntheticVkn(`95${randomUUID().replace(/\D/g, '').padEnd(7, '1').slice(0, 7)}`);
    for (const wrong of [`${vkn.slice(0, 9)}${(Number(vkn[9]) + 1) % 10}`, '12345']) {
      const bad = await call(w, 'techEval', 'POST', '/api/v1/suppliers/candidates', { legalName: 'Deneme Bilişim A.Ş. (SENTETİK)', vkn: wrong });
      expect(bad.status).toBe(422);
      expect(bad.body.error.code).toBe('invalid_tax_id');
    }
    const r = await call(w, 'techEval', 'POST', '/api/v1/suppliers/candidates', { legalName: 'Deneme Bilişim A.Ş. (SENTETİK)', vkn, contactEmail: 'iletisim@example.test' });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.body).toMatchObject({ legalName: 'Deneme Bilişim A.Ş. (SENTETİK)', status: 'CANDIDATE', vkn, contactEmail: 'iletisim@example.test', existing: false });
    const task = await h.owner.query(`SELECT assignee_role FROM tasks WHERE tenant_id = $1 AND dedupe_key = $2 AND status = 'OPEN'`, [w.tenantA, `supplier:${r.body.id}:activation`]);
    expect(task.rows[0]?.assignee_role).toBe('PROCUREMENT');
    const again = await call(w, 'buyer', 'POST', '/api/v1/suppliers/candidates', { legalName: 'Başka Unvan', vkn });
    expect(again.status).toBe(200);
    expect(again.body).toMatchObject({ id: r.body.id, existing: true, legalName: 'Deneme Bilişim A.Ş. (SENTETİK)' });
    const seeded = (await h.owner.query<{ tax_id: string }>(`SELECT tax_id FROM suppliers WHERE id = $1`, [w.suppliers.s1])).rows[0]!.tax_id;
    const ex = await call(w, 'techEval', 'POST', '/api/v1/suppliers/candidates', { legalName: 'Anadolu', vkn: seeded });
    expect(ex.body).toMatchObject({ id: w.suppliers.s1, status: 'ACTIVE', existing: true });
    // Reddedilmiş kart: mevcut kart önerilmez, 409 supplier_unusable.
    await h.owner.query(`UPDATE suppliers SET status = 'REJECTED', rejection_reason = 'Sentetik red' WHERE id = $1`, [r.body.id]);
    const rejected = await call(w, 'techEval', 'POST', '/api/v1/suppliers/candidates', { legalName: 'Deneme', vkn });
    expect(rejected.status).toBe(409);
    expect(rejected.body.error.code).toBe('supplier_unusable');
    expect(rejected.body.error.message).toMatch(/reddedilmiş/);
    await h.owner.query(`UPDATE suppliers SET status = 'CANDIDATE', rejection_reason = NULL WHERE id = $1`, [r.body.id]);
    const own = await call(w, 'techEval', 'POST', '/api/v1/suppliers/candidates', { legalName: 'Kendi şirketimiz', vkn: w.companyA1.vkn });
    expect(own.status).toBe(422);
    expect(own.body.error.code).toBe('own_company_tax_id');
    // Aday kart ekleme akışında sözleşmenin tedarikçisi olarak seçilebilir.
    const d = await draft(w);
    const f = await call(w, 'techEval', 'PUT', `/api/v1/contracts/${d.familyId}/fields`, { supplierId: r.body.id });
    expect(f.status, JSON.stringify(f.body)).toBe(200);
    expect(f.body.supplier).toMatchObject({ id: r.body.id, status: 'CANDIDATE', vkn });
  });
});

describe('alanlar ve gönderim', () => {
  it('eksik alanda gönderim 422 missing_fields (Türkçe listeli); yalnız ekleyen ya da Satınalma düzenler', async () => {
    const w = await fresh();
    await approvers(w);
    const d = await draft(w);
    const r = await call(w, 'techEval', 'POST', `/api/v1/contracts/${d.familyId}/submit`, {});
    expect(r.status).toBe(422);
    expect(r.body.error.code).toBe('missing_fields');
    expect(r.body.error.details.missing).toContainEqual({ field: 'supplier', label: 'Tedarikçi' });
    expect(r.body.error.details.missing).toContainEqual({ field: 'endDate', label: 'Bitiş tarihi' });
    // Aynı departmandaki başka bölüm kullanıcısı (ekleyen değil, Satınalma değil) düzenleyemez.
    const other = await call(w, 'security', 'PUT', `/api/v1/contracts/${d.familyId}/fields`, { contractType: 'SERVICE' });
    expect(other.status).toBe(403);
    expect(other.body.error.code).toBe('not_contract_owner');
    expect((await v2(w, 'security', d.familyId)).body.can.edit).toBe(false);
    // Bölüm kullanıcısı sözleşmeyi başka departmana taşıyamaz.
    const foreignDept = await call(w, 'techEval', 'PUT', `/api/v1/contracts/${d.familyId}/fields`, { departmentId: w.departments.ik });
    expect(foreignDept.status).toBe(403);
    expect(foreignDept.body.error.code).toBe('department_forbidden');
    // Satınalma düzenleyebilir.
    const proc = await call(w, 'legal', 'PUT', `/api/v1/contracts/${d.familyId}/fields`, { contractType: 'SERVICE' });
    expect(proc.status).toBe(200);
    // Sorumlu kiracının etkin kullanıcısı olmalı.
    const owner = await call(w, 'techEval', 'PUT', `/api/v1/contracts/${d.familyId}/fields`, { ownerUserId: randomUUID() });
    expect(owner.status).toBe(422);
    expect(owner.body.error.code).toBe('owner_invalid');
  });

  it('tam alanlarla gönderim: üç adımlı zincir, ilk adım görevi kişiye atanır; durum "Departman sorumlusu onayında"', async () => {
    const w = await fresh();
    await approvers(w);
    const d = await draft(w);
    const f = await call(w, 'techEval', 'PUT', `/api/v1/contracts/${d.familyId}/fields`, fullFields(w));
    expect(f.status, JSON.stringify(f.body)).toBe(200);
    expect(f.body.missing).toEqual([]);
    expect(f.body.status).toEqual({ code: 'DRAFT', label: 'Taslak' });
    expect(f.body.fields).toMatchObject({ amount: '120000.00', currency: 'TRY', limitBasis: 'NET', endDate: '2027-10-31', autoRenewal: false, termsRevision: 1, termsVerified: false });
    expect(f.body.can).toEqual({ edit: true, submit: true, decide: false });
    // Koşul revizyonu ekleyenin adıyla; mevcut ikinci kişi doğrulaması görevi açılır (R3).
    const terms = (await h.owner.query(`SELECT entered_by FROM contract_terms WHERE contract_version_id = $1`, [d.contractVersionId])).rows;
    expect(terms).toEqual([{ entered_by: w.users.techEval.id }]);
    // Değişmeyen alanlarla tekrar kayıt yeni revizyon açmaz.
    const same = await call(w, 'techEval', 'PUT', `/api/v1/contracts/${d.familyId}/fields`, fullFields(w));
    expect(same.body.changed).toBe(false);
    expect(same.body.fields.termsRevision).toBe(1);
    // Hatırlatıcı planı (R7, varsayılan süreler): bitişten 90/60/30/7 gün önce.
    expect(f.body.reminders.planned.map((r: any) => r.date)).toEqual(['2027-08-02', '2027-09-01', '2027-10-01', '2027-10-24']);

    const p = await call(w, 'techEval', 'GET', `/api/v1/contracts/${d.familyId}/approval-preview`);
    expect(p.status).toBe(200);
    expect(p.body.ok).toBe(true);
    expect(p.body.steps.map((s: any) => [s.kind, s.userId, s.viaDeputy])).toEqual([
      ['DEPARTMENT_HEAD', w.users.security.id, false], ['PROCUREMENT_LEAD', w.users.legal.id, false], ['PROCUREMENT_DIRECTOR', w.users.masterData.id, false]]);
    expect(p.body.steps[0]).toMatchObject({ kindLabel: 'Departman sorumlusu', displayName: 'Selin Arslan' });

    const s = await call(w, 'techEval', 'POST', `/api/v1/contracts/${d.familyId}/submit`, { note: 'Bakım sözleşmesi onayınıza.' });
    expect(s.status, JSON.stringify(s.body)).toBe(200);
    const c = s.body.contract;
    expect(c.status).toEqual({ code: 'IN_APPROVAL', label: 'Departman sorumlusu onayında' });
    expect(c.chain).toMatchObject({ status: 'OPEN', note: 'Bakım sözleşmesi onayınıza.', versionId: d.contractVersionId, termsId: c.fields.termsId });
    expect(c.chain.steps.map((x: any) => [x.order, x.kind, x.assignedUser.id, x.current])).toEqual([
      [1, 'DEPARTMENT_HEAD', w.users.security.id, true], [2, 'PROCUREMENT_LEAD', w.users.legal.id, false], [3, 'PROCUREMENT_DIRECTOR', w.users.masterData.id, false]]);
    expect(c.can).toEqual({ edit: true, submit: false, decide: false });
    const task = (await h.owner.query(`SELECT kind, assignee_user_id, assignee_role, entity_type, entity_id, department_id FROM tasks WHERE id = $1`, [s.body.firstTaskId])).rows[0];
    expect(task).toMatchObject({ kind: 'contract_approval', assignee_user_id: w.users.security.id, assignee_role: 'DEPARTMENT_USER',
      entity_type: 'contract_approval_step', entity_id: c.chain.steps[0].id, department_id: null });
    // Görev onaycının İşlerim'inde; onaycı karar verebilir, ekleyen veremez.
    const mine = (await call(w, 'security', 'GET', '/api/v1/tasks?view=mine')).body.items;
    expect(mine.map((t: any) => t.id)).toContain(s.body.firstTaskId);
    // Aynı roldeki başka kullanıcı (ekleyen, Departman kullanıcısı) "Tümü" görünümünde kişiye atanmış onay adımı görevini görmez; sayılar şişmez.
    const others = (await call(w, 'techEval', 'GET', '/api/v1/tasks?view=all')).body;
    expect(others.items.map((t: any) => t.id)).not.toContain(s.body.firstTaskId);
    expect(others.items.some((t: any) => t.kind === 'contract_approval')).toBe(false);
    expect(others.counts.all).toBe(others.items.length);
    const selin = (await call(w, 'security', 'GET', '/api/v1/tasks?view=all')).body;
    expect(selin.counts.all).toBe(selin.items.length);
    expect((await v2(w, 'security', d.familyId)).body.can.decide).toBe(true);
    expect((await v2(w, 'legal', d.familyId)).body.can.decide).toBe(false);
    // İkinci gönderim açık zincirde 409.
    const twice = await call(w, 'techEval', 'POST', `/api/v1/contracts/${d.familyId}/submit`, {});
    expect(twice.status).toBe(409);
    expect(twice.body.error.code).toBe('chain_open');
    expect((await h.owner.query(`SELECT 1 FROM audit_events WHERE tenant_id = $1 AND action = 'contract.submitted' AND entity_id = $2`, [w.tenantA, d.familyId])).rowCount).toBe(1);
  });

  it('ekleyen departman sorumlusuysa adım vekile gider; vekil yoksa 409 no_eligible_approver; sorumlu yoksa 409', async () => {
    const w = await fresh();
    await approvers(w, 'techEval', 'buyer');
    const d = await draft(w);
    await call(w, 'techEval', 'PUT', `/api/v1/contracts/${d.familyId}/fields`, fullFields(w));
    const p = (await call(w, 'techEval', 'GET', `/api/v1/contracts/${d.familyId}/approval-preview`)).body;
    expect(p.steps[0]).toMatchObject({ kind: 'DEPARTMENT_HEAD', userId: w.users.buyer.id, viaDeputy: true });

    await approvers(w, 'techEval', null);
    const none = await call(w, 'techEval', 'POST', `/api/v1/contracts/${d.familyId}/submit`, {});
    expect(none.status).toBe(409);
    expect(none.body.error.code).toBe('no_eligible_approver');
    expect(none.body.error.message).toMatch(/Departman sorumlusu adımında/);
    const pv = (await call(w, 'techEval', 'GET', `/api/v1/contracts/${d.familyId}/approval-preview`)).body;
    expect(pv).toMatchObject({ ok: false, error: 'no_eligible_approver', kind: 'DEPARTMENT_HEAD' });

    await approvers(w, null, null);
    const missing = await call(w, 'techEval', 'POST', `/api/v1/contracts/${d.familyId}/submit`, {});
    expect(missing.status).toBe(409);
    expect(missing.body.error.code).toBe('department_head_missing');
    expect((await h.owner.query(`SELECT count(*)::int AS n FROM contract_approval_chains WHERE family_id = $1`, [d.familyId])).rows[0].n).toBe(0);

    // "Vekili kullan" seçimi ve ek onaycılar (sona, sırayla); ek onaycı yalnız etkin Satınalma/Departman kullanıcısı.
    await approvers(w);
    const extra = (await call(w, 'techEval', 'GET', `/api/v1/contracts/${d.familyId}/approval-preview?useDeputyForHead=true&extraApproverIds=${w.users.finance2.id}`)).body;
    expect(extra.steps.map((s: any) => [s.kind, s.userId])).toEqual([['DEPARTMENT_HEAD', w.users.buyer.id], ['PROCUREMENT_LEAD', w.users.legal.id],
      ['PROCUREMENT_DIRECTOR', w.users.masterData.id], ['EXTRA', w.users.finance2.id]]);
    const badExtra = await call(w, 'techEval', 'POST', `/api/v1/contracts/${d.familyId}/submit`, { extraApproverIds: [w.users.auditor.id] });
    expect(badExtra.status).toBe(422);
    expect(badExtra.body.error.code).toBe('approver_invalid');
  });

  it('gönderimden sonra alan değişirse açık zincir iptal edilir (R5), ekleyene yeniden gönder görevi; yeniden gönderim yeni zincir', async () => {
    const w = await fresh();
    await approvers(w);
    const d = await draft(w);
    await call(w, 'techEval', 'PUT', `/api/v1/contracts/${d.familyId}/fields`, fullFields(w));
    const s = await call(w, 'techEval', 'POST', `/api/v1/contracts/${d.familyId}/submit`, {});
    expect(s.status).toBe(200);
    const chainId = s.body.chainId;
    const ch = await call(w, 'techEval', 'PUT', `/api/v1/contracts/${d.familyId}/fields`, { amount: '125000.00' });
    expect(ch.status, JSON.stringify(ch.body)).toBe(200);
    expect(ch.body.cancelledChainId).toBe(chainId);
    expect(ch.body.status.code).toBe('DRAFT');
    expect(ch.body.chain).toMatchObject({ id: chainId, status: 'CANCELLED', cancelReason: 'İçerik değişti, onay baştan.' });
    expect(ch.body.fields).toMatchObject({ amount: '125000.00', termsRevision: 2 });
    const tasks = (await h.owner.query<{ dedupe_key: string; status: string; assignee_user_id: string | null }>(
      `SELECT dedupe_key, status, assignee_user_id FROM tasks WHERE tenant_id = $1 AND (dedupe_key LIKE 'contract-approval:%' OR dedupe_key LIKE 'contract-resubmit:%') ORDER BY created_at`, [w.tenantA])).rows;
    expect(tasks).toEqual([
      { dedupe_key: `contract-approval:${chainId}:1`, status: 'DONE', assignee_user_id: w.users.security.id },
      { dedupe_key: `contract-resubmit:${d.familyId}`, status: 'OPEN', assignee_user_id: w.users.techEval.id },
    ]);
    const change = (await h.owner.query(`SELECT change_reason FROM contract_terms WHERE contract_version_id = $1 AND revision = 2`, [d.contractVersionId])).rows[0];
    expect(change.change_reason).toBe('Sözleşme ekleme akışı');
    const again = await call(w, 'techEval', 'POST', `/api/v1/contracts/${d.familyId}/submit`, {});
    expect(again.status).toBe(200);
    expect(again.body.chainId).not.toBe(chainId);
    expect(again.body.contract.chainCount).toBe(2);
    expect((await h.owner.query(`SELECT status FROM tasks WHERE tenant_id = $1 AND dedupe_key = $2`, [w.tenantA, `contract-resubmit:${d.familyId}`])).rows[0].status).toBe('DONE');
  });

  it('süresiz sözleşme: bitiş gerekmez, ihbar süresi zorunlu ve ailede tutulur', async () => {
    const w = await fresh();
    const d = await draft(w);
    const { endDate: _e, ...rest } = fullFields(w);
    const f = await call(w, 'techEval', 'PUT', `/api/v1/contracts/${d.familyId}/fields`, { ...rest, indefinite: true });
    expect(f.status, JSON.stringify(f.body)).toBe(200);
    expect(f.body.missing).toEqual([{ field: 'noticePeriod', label: 'İhbar süresi' }]);
    const g = await call(w, 'techEval', 'PUT', `/api/v1/contracts/${d.familyId}/fields`, { noticeAmount: 3, noticeUnit: 'MONTH' });
    expect(g.status, JSON.stringify(g.body)).toBe(200);
    expect(g.body.missing).toEqual([]);
    expect(g.body.fields).toMatchObject({ indefinite: true, endDate: null, noticeAmount: 3, noticeUnit: 'MONTH', noticePeriod: '3 ay' });
    expect(g.body.status.code).toBe('DRAFT');
  });
});

describe('eski kayıt ve liste', () => {
  it('eski sözleşme INCOMPLETE görünür; alanlar doldurulunca LEGACY (Yürürlükte süzgecinde) ve gönderilebilir; liste süzgeçleri', async () => {
    const w = await fresh();
    await approvers(w);
    // Eski uçla (Faz 3 öncesi akış) açılan sözleşme: proje/tür/sorumlu boş.
    const dv = await uploadContract(w, 'legal');
    const old = await call(w, 'legal', 'POST', '/api/v1/contracts', { title: 'Eski bakım sözleşmesi (SENTETİK)', documentVersionId: dv, stage: 'EXECUTION',
      signatureMethod: 'NOT_REQUIRED', originalCustodyRequired: false, departmentId: w.departments.bt, supplierId: w.suppliers.s1,
      parties: [{ role: 'BUYER', displayName: w.companyA1.name, legalEntityId: w.companyA1.id }] });
    expect(old.status, JSON.stringify(old.body)).toBe(201);
    // Geçişten sonra eski uçla açılan sözleşme eski kayıt değildir (051a): alanlarına göre Eksik alan.
    const now = (await v2(w, 'legal', old.body.familyId)).body;
    expect(now.status.code).toBe('INCOMPLETE');
    expect(now.legacy).toBe(false);
    // Faz 3 öncesi kayıt (intake_flow false) eski kayıttır.
    await h.owner.query(`UPDATE contract_families SET intake_flow = false WHERE id = $1`, [old.body.familyId]);
    const g = (await v2(w, 'legal', old.body.familyId)).body;
    expect(g.status.code).toBe('INCOMPLETE');
    expect(g.legacy).toBe(true);
    expect(g.missing.map((m: any) => m.field)).toContain('project');

    // Taslak (eksik) ve gönderilmiş sözleşme de listede.
    const incomplete = await draft(w);
    const sent = await draft(w);
    await call(w, 'techEval', 'PUT', `/api/v1/contracts/${sent.familyId}/fields`, fullFields(w));
    expect((await call(w, 'techEval', 'POST', `/api/v1/contracts/${sent.familyId}/submit`, {})).status).toBe(200);

    const list = async (q = '') => (await call(w, 'legal', 'GET', `/api/v1/contracts${q}`)).body;
    const all = await list();
    const item = (fid: string) => all.items.find((x: any) => x.familyId === fid);
    expect(all.total).toBe(3);
    // Eski alanlar aynen (imza durumu vb.) + yeni alanlar.
    expect(item(old.body.familyId)).toMatchObject({ status: 'INCOMPLETE', statusLabel: 'Eksik alan', project: null, signature: expect.objectContaining({ overall: expect.any(String) }) });
    expect(item(sent.familyId)).toMatchObject({ status: 'IN_APPROVAL', statusLabel: 'Departman sorumlusu onayında', amount: '120000.00', currency: 'TRY', endDate: '2027-10-31',
      project: { id: sent.projectId } });
    const ids = (r: any) => r.items.map((x: any) => x.familyId).sort();
    expect(ids(await list('?status=INCOMPLETE'))).toEqual([old.body.familyId, incomplete.familyId].sort());
    expect(ids(await list('?status=IN_APPROVAL'))).toEqual([sent.familyId]);
    expect((await list('?status=ACTIVE')).total).toBe(0);

    // Eski kayıt alanları tamamlanınca LEGACY; bitişi 90 gün içinde → "90 gün içinde biten".
    const proj = await project(w, 'buyer', w.departments.bt);
    const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Istanbul' }).format(new Date());
    const end = new Date(Date.parse(`${today}T00:00:00Z`) + 45 * 86400000).toISOString().slice(0, 10);
    const fill = await call(w, 'legal', 'PUT', `/api/v1/contracts/${old.body.familyId}/fields`, { ...fullFields(w), projectId: proj, startDate: '2026-01-01', endDate: end });
    expect(fill.status, JSON.stringify(fill.body)).toBe(200);
    expect(fill.body.status).toEqual({ code: 'LEGACY', label: 'Onay kaydı yok (eski kayıt)' });
    expect(fill.body.can.submit).toBe(true);
    expect(ids(await list('?status=ACTIVE'))).toEqual([old.body.familyId]);
    expect(ids(await list('?status=ENDING_90'))).toEqual([old.body.familyId]);
    expect((await list('?status=ALL')).total).toBe(3);
    const paged = await list('?status=INCOMPLETE&limit=1&offset=0');
    expect(paged).toMatchObject({ total: 1 });
    expect(paged.items).toHaveLength(1);

    // Eski kayıt onaya gönderilebilir: ekleyen (Leyla) satınalma sorumlusu olduğundan o adım vekile (Kerem) gider.
    const s = await call(w, 'legal', 'POST', `/api/v1/contracts/${old.body.familyId}/submit`, {});
    expect(s.status, JSON.stringify(s.body)).toBe(200);
    expect(s.body.contract.status.code).toBe('IN_APPROVAL');
    expect(s.body.contract.legacy).toBe(false);
    expect(s.body.contract.chain.steps[1]).toMatchObject({ kind: 'PROCUREMENT_LEAD', assignedUser: { id: w.users.legal2.id }, viaDeputy: true });
  });
});

describe('inceleme düzeltmeleri (Görev 4, tur 1)', () => {
  it('geçişten sonra eski uçla açılan sözleşme alanları tamamlanınca LEGACY değil Taslak olur', async () => {
    const w = await fresh();
    const dv = await uploadContract(w, 'legal');
    const c = await call(w, 'legal', 'POST', '/api/v1/contracts', { title: 'Yeni ama eski uçtan (SENTETİK)', documentVersionId: dv, stage: 'EXECUTION',
      signatureMethod: 'NOT_REQUIRED', originalCustodyRequired: false, departmentId: w.departments.bt,
      parties: [{ role: 'BUYER', displayName: w.companyA1.name, legalEntityId: w.companyA1.id }] });
    expect(c.status).toBe(201);
    const proj = await project(w, 'buyer', w.departments.bt);
    const f = await call(w, 'legal', 'PUT', `/api/v1/contracts/${c.body.familyId}/fields`, { ...fullFields(w), projectId: proj });
    expect(f.status, JSON.stringify(f.body)).toBe(200);
    expect(f.body.status).toEqual({ code: 'DRAFT', label: 'Taslak' });
    expect(f.body.legacy).toBe(false);
    expect(f.body.family.intakeFlow).toBe(true);
  });

  it('onaylanan sözleşmede alan değişmez (409 contract_approved); yeni sürüm eklenince durum Taslak ve yeniden gönderilebilir', async () => {
    const w = await fresh();
    await approvers(w);
    const d = await draft(w);
    await call(w, 'techEval', 'PUT', `/api/v1/contracts/${d.familyId}/fields`, fullFields(w));
    const s = await call(w, 'techEval', 'POST', `/api/v1/contracts/${d.familyId}/submit`, {});
    expect(s.status).toBe(200);
    // Karar akışı Görev 5'te; burada sahip bağlantısıyla bütün adımlar onaylanıp zincir kapanır.
    await h.owner.query(`UPDATE contract_approval_steps SET decided_by = assigned_user_id, decided_at = now(), decision = 'APPROVED' WHERE chain_id = $1`, [s.body.chainId]);
    await h.owner.query(`UPDATE contract_approval_chains SET closed_at = now(), outcome = 'APPROVED' WHERE id = $1`, [s.body.chainId]);
    const g = (await v2(w, 'techEval', d.familyId)).body;
    expect(g.status).toEqual({ code: 'APPROVED', label: 'Yürürlükte' });
    expect(g.can).toEqual({ edit: false, submit: false, decide: false });
    const edit = await call(w, 'techEval', 'PUT', `/api/v1/contracts/${d.familyId}/fields`, { amount: '1.00' });
    expect(edit.status).toBe(409);
    expect(edit.body.error.code).toBe('contract_approved');
    expect(edit.body.error.message).toBe('Onaylanmış sözleşme değiştirilemez; değişiklik için yeni sürüm ekleyin.');
    expect((await call(w, 'legal', 'PUT', `/api/v1/contracts/${d.familyId}/fields`, { contractNo: 'SZ-1' })).status).toBe(409);
    const resend = await call(w, 'techEval', 'POST', `/api/v1/contracts/${d.familyId}/submit`, {});
    expect(resend.status).toBe(409);
    expect(resend.body.error.code).toBe('contract_approved');

    // Yeni sürüm (zeyilname): onay güncel belgeyi kapsamaz → durum yeniden türetilir, alanlar yeni sürüme girilir, Taslak.
    const newDoc = await uploadContract(w);
    const nv = await call(w, 'techEval', 'POST', `/api/v1/contract-versions/${d.contractVersionId}/versions`,
      { documentVersionId: newDoc, kind: 'AMENDMENT', stage: 'DRAFT' }) as any;
    const token = await auth.issue(`dev|${w.users.techEval.email}`);
    const res = await h.app.inject({ method: 'POST', url: `/api/v1/contract-versions/${d.contractVersionId}/versions`,
      headers: { authorization: `Bearer ${token}`, 'x-tenant-id': w.tenantA, 'if-match': g.document.etag }, payload: { documentVersionId: newDoc, kind: 'AMENDMENT', stage: 'DRAFT' } });
    expect(nv.status).toBe(428); // If-Match olmadan eski kural aynen
    expect(res.statusCode, res.body).toBe(201);
    const after = (await v2(w, 'techEval', d.familyId)).body;
    expect(after.status.code).not.toBe('APPROVED');
    expect(after.document.versionNo).toBe(2);
    const refill = await call(w, 'techEval', 'PUT', `/api/v1/contracts/${d.familyId}/fields`, fullFields(w));
    expect(refill.status, JSON.stringify(refill.body)).toBe(200);
    expect(refill.body.status).toEqual({ code: 'DRAFT', label: 'Taslak' });
    expect(refill.body.chain).toMatchObject({ id: s.body.chainId, status: 'APPROVED' });
    expect(refill.body.can.submit).toBe(true);
    expect((await call(w, 'techEval', 'POST', `/api/v1/contracts/${d.familyId}/submit`, {})).status).toBe(200);
  });

  it('görev ayrılığı: onaya gönderen de ekleyen sayılır (zincirde vekile gider, karar veremez)', async () => {
    const w = await fresh();
    await approvers(w);
    const d = await draft(w);
    await call(w, 'techEval', 'PUT', `/api/v1/contracts/${d.familyId}/fields`, fullFields(w));
    // Satınalma direktörü (Mine) başkasının sözleşmesini gönderir: direktör adımı vekile (Ferda) gider.
    const pv = (await call(w, 'masterData', 'GET', `/api/v1/contracts/${d.familyId}/approval-preview`)).body;
    expect(pv.steps[2]).toMatchObject({ kind: 'PROCUREMENT_DIRECTOR', userId: w.users.finance.id, viaDeputy: true });
    const s = await call(w, 'masterData', 'POST', `/api/v1/contracts/${d.familyId}/submit`, {});
    expect(s.status, JSON.stringify(s.body)).toBe(200);
    expect(s.body.contract.chain.steps[2]).toMatchObject({ assignedUser: { id: w.users.finance.id }, viaDeputy: true });
    // Gönderen sonradan açık adımın etkin vekili olsa da karar veremez.
    await approvers(w, 'security', 'masterData');
    expect((await v2(w, 'masterData', d.familyId)).body.can.decide).toBe(false);
    await approvers(w, 'security', 'buyer');
    expect((await v2(w, 'buyer', d.familyId)).body.can.decide).toBe(true);
  });
});
