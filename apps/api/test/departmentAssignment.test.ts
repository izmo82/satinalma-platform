// v2 Faz 1 düzeltme dalgası: departmansız eski kayıtlara departman atanır (C1, D96) ve görevler kaydın departmanını izler (I3, D100).
// Tüm veri sentetik; her koşu kendi kiracısını kurar (harness).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { withTenant, type TenantContext } from '../src/db.ts';
import { syntheticPdf } from '../src/devdata.ts';
import { openTask } from '../src/tasks.ts';
import { makeHarness } from './harness.ts';

let h: Awaited<ReturnType<typeof makeHarness>>;
let bt: string; let ik: string;

const criteria = [
  { code: 'PRICE', name: 'Fiyat', kind: 'PRICE', weight: '60' },
  { code: 'TECH', name: 'Teknik uygunluk', kind: 'SCORE', weight: '40' },
];
const lines = [{ lot: 'Lot 1', description: 'Eğitim hizmeti', unit: 'gün', quantity: '5' }];
const inHours = (n: number) => new Date(Date.now() + n * 3600_000).toISOString();
const deptOf = async (table: string, id: string) => (await h.owner.query<{ d: string | null }>(`SELECT department_id AS d FROM ${table} WHERE id = $1`, [id])).rows[0]!.d;
const taskIds = async (who: 'techEval' | 'security' | 'legal2' | 'legal', view = 'all') =>
  ((await h.call(who, 'GET', `/api/v1/tasks?view=${view}`)).body.items as { id: string }[]).map((x) => x.id);
const assign = (who: 'legal' | 'techEval' | 'tenantAdmin' | 'auditor', entityType: string, ids: string[], departmentId: string) =>
  h.call(who, 'PUT', '/api/v1/department-assignments', { body: { entityType, ids, departmentId } });

async function nullProject(title = `Departmansız eski proje ${randomUUID().slice(0, 4)}`) {
  const r = await h.call('legal', 'POST', '/api/v1/projects', { body: { companyId: h.world.companyA1.id, title, category: 'Eğitim', need: 'Sentetik',
    currency: 'TRY', budget: '1000.00', budgetVerified: false, lines, criteria } });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  expect(await deptOf('projects', r.body.id)).toBeNull();
  return r.body.id as string;
}
async function contract(dep: string | null) {
  const up = await h.upload('legal', { name: 'k.pdf', mime: 'application/pdf', data: syntheticPdf([[`SENTETIK ${randomUUID()}`]]) },
    { companyId: h.world.companyA1.id, kind: 'CONTRACT', title: `Atama sözleşmesi ${randomUUID().slice(0, 4)} (SENTETİK)` });
  const c = await h.call('legal', 'POST', '/api/v1/contracts', { body: { title: `Atama sözleşmesi ${randomUUID().slice(0, 4)} (SENTETİK)`, documentVersionId: up.body.documentVersionId,
    stage: 'EXECUTION', signatureMethod: 'NOT_REQUIRED', originalCustodyRequired: false, ...(dep ? { departmentId: dep } : {}),
    parties: [{ role: 'BUYER', displayName: h.world.companyA1.name, legalEntityId: h.world.companyA1.id }], supplierId: h.world.suppliers.s1 } });
  expect(c.status, JSON.stringify(c.body)).toBe(201);
  return c.body as { familyId: string; contractVersionId: string };
}
const sysCtx = (): TenantContext => ({ tenantId: h.world.tenantA, userId: h.world.users.legal.id, roles: ['PROCUREMENT'],
  companyIds: [h.world.companyA1.id], departmentIds: [], allDepartments: true, correlationId: 'dept-assign-test' });
const deptTask = (entityType: string, entityId: string, companyId: string | null = h.world.companyA1.id) => withTenant(h.pool, sysCtx(), (tx) => openTask(tx, sysCtx(),
  { companyId, kind: 'dept_assign_test', entityType, entityId, title: 'Bölüm görevi (sentetik)', reason: 'Sentetik', nextAction: 'İnceleyin',
    assigneeRole: 'DEPARTMENT_USER', dedupeKey: `dept-assign:${randomUUID()}` }));
const auditCount = async (action: string, entityId: string) =>
  (await h.owner.query(`SELECT 1 FROM audit_events WHERE tenant_id = $1 AND action = $2 AND entity_id = $3`, [h.world.tenantA, action, entityId])).rowCount;

beforeAll(async () => {
  h = await makeHarness();
  bt = h.world.departments.bt;
  ik = h.world.departments.ik;
  // techEval: Bilgi Teknolojileri; security: İnsan Kaynakları (bu dosyada). İkisi de yalnız bölüm kullanıcısı.
  await h.owner.query(`UPDATE memberships SET department_ids = $3 WHERE tenant_id = $1 AND user_id = $2`, [h.world.tenantA, h.world.users.techEval.id, [bt]]);
  await h.owner.query(`UPDATE memberships SET department_ids = $3 WHERE tenant_id = $1 AND user_id = $2`, [h.world.tenantA, h.world.users.security.id, [ik]]);
});
afterAll(async () => { await h.close(); });

describe('C1 departmansız kayıtlara departman atama', () => {
  it('departmansız proje BT\'ye atanır: BT kullanıcısı projeyi ve görevlerini görür, İK kullanıcısı görmez; denetim olayı yazılır', async () => {
    const p = await nullProject();
    // Alt kayıt görevi: yayın onayı turu (rfq_round) ve proje görevi.
    const d = (await h.call('legal', 'GET', `/api/v1/projects/${p}`)).body;
    const pub = await h.call('legal', 'POST', `/api/v1/projects/${p}/rounds`, { body: { closesAt: inHours(48), supplierIds: [h.world.suppliers.s1] }, headers: { 'if-match': d.project.etag } });
    expect(pub.status).toBe(201);
    const projectTask = (await deptTask('project', p)).id;
    const roundTask = (await deptTask('rfq_round', pub.body.roundId)).id;
    expect(await deptOf('tasks', projectTask)).toBeNull();
    expect((await h.call('techEval', 'GET', `/api/v1/projects/${p}`)).status).toBe(404);
    expect(await taskIds('techEval')).not.toContain(projectTask);

    const r = await assign('legal', 'project', [p], bt);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body).toMatchObject({ updated: 1 });
    expect(await deptOf('projects', p)).toBe(bt);
    expect(await deptOf('tasks', projectTask)).toBe(bt);
    expect(await deptOf('tasks', roundTask)).toBe(bt);
    expect((await h.call('techEval', 'GET', `/api/v1/projects/${p}`)).status).toBe(200);
    const btTasks = await taskIds('techEval');
    expect(btTasks).toContain(projectTask);
    expect(btTasks).toContain(roundTask);
    expect((await h.call('security', 'GET', `/api/v1/projects/${p}`)).status).toBe(404);
    const ikTasks = await taskIds('security');
    expect(ikTasks).not.toContain(projectTask);
    expect(ikTasks).not.toContain(roundTask);
    expect(await auditCount('department.assigned', p)).toBe(1);
    const ev = (await h.owner.query(`SELECT data FROM audit_events WHERE tenant_id = $1 AND action = 'department.assigned' AND entity_id = $2`, [h.world.tenantA, p])).rows[0].data;
    expect(ev).toMatchObject({ entityType: 'project', before: null, after: bt });
  });

  it('toplu atama: her kayıt için ayrı denetim olayı; listeden düşer', async () => {
    const a = await nullProject(); const b = await nullProject();
    const before = (await h.call('legal', 'GET', '/api/v1/department-assignments/unassigned')).body;
    expect(before.projects.map((x: any) => x.id)).toEqual(expect.arrayContaining([a, b]));
    const r = await assign('legal', 'project', [a, b], ik);
    expect(r.status).toBe(200);
    expect(r.body.updated).toBe(2);
    expect(await auditCount('department.assigned', a)).toBe(1);
    expect(await auditCount('department.assigned', b)).toBe(1);
    const after = (await h.call('legal', 'GET', '/api/v1/department-assignments/unassigned')).body;
    expect(after.projects.map((x: any) => x.id)).not.toContain(a);
    expect(after.projects.map((x: any) => x.id)).not.toContain(b);
  });

  it('sözleşme ailesi ve değerlendirme atanır; bağlı fatura departmanı ve görevleri izler', async () => {
    const c = await contract(null);
    const listed = (await h.call('legal', 'GET', '/api/v1/department-assignments/unassigned')).body;
    expect(listed.contracts.map((x: any) => x.id)).toContain(c.familyId);
    // Fatura bu sözleşmeye tahsisli: departman boş kalır (sözleşme boş). Fatura görevi de boş.
    const inv = await h.call('legal', 'POST', '/api/v1/invoices', { body: { companyId: h.world.companyA1.id, supplierId: h.world.suppliers.s1, kind: 'INVOICE', invoiceNo: `ATA${randomUUID().slice(0, 8)}`,
      issueDate: '2026-10-20', currency: 'TRY', lines: [{ description: 'Hizmet', quantity: '1', unit: 'adet', unitPrice: '100', netAmount: '100.00' }] } });
    expect(inv.status).toBe(201);
    expect((await h.call('legal', 'PUT', `/api/v1/invoices/${inv.body.id}/allocations`, { body: { allocations: [{ lineNo: 1, poLineId: null, contractVersionId: c.contractVersionId, quantity: '1', amount: '100.00' }] } })).status).toBe(200);
    expect(await deptOf('invoices', inv.body.id)).toBeNull();
    const invTask = (await deptTask('invoice', inv.body.id)).id;
    const cvTask = (await deptTask('contract_version', c.contractVersionId)).id;
    const r = await assign('legal', 'contract_family', [c.familyId], ik);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(await deptOf('contract_families', c.familyId)).toBe(ik);
    expect(await deptOf('tasks', cvTask)).toBe(ik);
    expect(await deptOf('invoices', inv.body.id)).toBe(ik);
    expect(await deptOf('tasks', invTask)).toBe(ik);
    expect(await auditCount('department.assigned', c.familyId)).toBe(1);
    expect((await h.call('security', 'GET', `/api/v1/invoices/${inv.body.id}`)).status).toBe(200);
    expect((await h.call('techEval', 'GET', `/api/v1/invoices/${inv.body.id}`)).status).toBe(404);

    // Değerlendirme (tedarikçi düzeyi; kiracı kapsamı).
    const tpl = (await h.owner.query<{ id: string }>(`INSERT INTO questionnaire_templates (tenant_id, code, version, name, category, status, created_by)
      VALUES ($1, $2, 1, 'Atama şablonu (sentetik)', 'Genel', 'PUBLISHED', $3) RETURNING id`, [h.world.tenantA, `ATA${randomUUID().slice(0, 6)}`, h.world.users.legal.id])).rows[0]!.id;
    const factors = { dataSensitivity: 'LOW', accessLevel: 'LOW', criticality: 'LOW', substitutability: 'LOW', subcontractorDependence: 'LOW' };
    const a = await h.call('legal', 'POST', '/api/v1/assessments', { body: { supplierId: h.world.suppliers.s1, templateId: tpl, scope: 'Atama kapsamı', inherentFactors: factors } });
    expect(a.status).toBe(201);
    expect(await deptOf('supplier_assessments', a.body.id)).toBeNull();
    expect((await h.call('legal', 'GET', '/api/v1/department-assignments/unassigned')).body.assessments.map((x: any) => x.id)).toContain(a.body.id);
    expect((await assign('legal', 'supplier_assessment', [a.body.id], bt)).status).toBe(200);
    expect(await deptOf('supplier_assessments', a.body.id)).toBe(bt);
    expect((await h.call('techEval', 'GET', `/api/v1/assessments/${a.body.id}`)).status).toBe(200);
    expect(await auditCount('department.assigned', a.body.id)).toBe(1);
  });

  it('tahsisle departmanı değişen faturanın görevleri yeni departmanı alır', async () => {
    const c = await contract(bt);
    const inv = await h.call('legal', 'POST', '/api/v1/invoices', { body: { companyId: h.world.companyA1.id, supplierId: h.world.suppliers.s1, kind: 'INVOICE', invoiceNo: `TSK${randomUUID().slice(0, 8)}`,
      issueDate: '2026-10-20', currency: 'TRY', lines: [{ description: 'Hizmet', quantity: '1', unit: 'adet', unitPrice: '100', netAmount: '100.00' }] } });
    const invTask = (await deptTask('invoice', inv.body.id)).id;
    expect(await deptOf('tasks', invTask)).toBeNull();
    expect((await h.call('legal', 'PUT', `/api/v1/invoices/${inv.body.id}/allocations`, { body: { allocations: [{ lineNo: 1, poLineId: null, contractVersionId: c.contractVersionId, quantity: '1', amount: '100.00' }] } })).status).toBe(200);
    expect(await deptOf('invoices', inv.body.id)).toBe(bt);
    expect(await deptOf('tasks', invTask)).toBe(bt);
    expect(await taskIds('techEval')).toContain(invTask);
    expect(await taskIds('security')).not.toContain(invTask);
  });

  it('yetki ve doğrulama: bölüm kullanıcısı ve denetçi 403; bilinmeyen departman 422; görünmeyen kayıt 404 ve hiçbir şey değişmez', async () => {
    const p = await nullProject();
    expect((await assign('techEval', 'project', [p], bt)).status).toBe(403);
    expect((await assign('auditor', 'project', [p], bt)).status).toBe(403);
    expect((await h.call('techEval', 'GET', '/api/v1/department-assignments/unassigned')).status).toBe(403);
    const unknown = await assign('legal', 'project', [p], randomUUID());
    expect(unknown.status).toBe(422);
    expect(unknown.body.error.code).toBe('department_unknown');
    // Bir kimlik görünmüyorsa (yok ya da kapsam dışı) toplu işlem bütünüyle reddedilir.
    const missing = await assign('legal', 'project', [p, randomUUID()], bt);
    expect(missing.status).toBe(404);
    expect(await deptOf('projects', p)).toBeNull();
    // Yönetici: atama yetkisi var; şirket kapsamı olmadığından şirket kayıtlarını görmez (kapsam kullanıcı kararı; değiştirilmedi).
    expect((await assign('tenantAdmin', 'project', [p], bt)).status).toBe(404);
    const adminList = await h.call('tenantAdmin', 'GET', '/api/v1/department-assignments/unassigned');
    expect(adminList.status).toBe(200);
    expect(adminList.body.projects).toEqual([]);
    expect(adminList.body.companyScopeEmpty).toBe(true);
    expect(await deptOf('projects', p)).toBeNull();
  });
});

describe('I3 görev departmanı ve merkezi ön inceleme', () => {
  it('İK değerlendirmesinin kritik engel görevi BT kullanıcısına görünmez, İK kullanıcısına görünür', async () => {
    const t = await h.call('legal', 'POST', '/api/v1/questionnaire-templates', { body: { code: `GUV-${randomUUID().slice(0, 6)}`, name: 'Engel anketi (sentetik)', category: 'Genel',
      questions: [{ controlId: 'ERS-01', reference: 'Sentetik', text: 'Uzak erişimde MFA var mı?', critical: true, evidenceRequired: false }] } });
    expect(t.status).toBe(201);
    expect((await h.call('legal2', 'POST', `/api/v1/questionnaire-templates/${t.body.id}/publish`)).status).toBe(200);
    const a = await h.call('buyer', 'POST', '/api/v1/assessments', { body: { supplierId: h.world.suppliers.s2, templateId: t.body.id, scope: 'İK bordro erişimi (sentetik)',
      inherentFactors: { dataSensitivity: 'LOW', accessLevel: 'LOW', criticality: 'LOW', substitutability: 'LOW', subcontractorDependence: 'LOW' }, departmentId: ik } });
    expect(a.status, JSON.stringify(a.body)).toBe(201);
    const q = (await h.call('buyer', 'GET', `/api/v1/assessments/${a.body.id}`)).body.questions[0];
    expect((await h.call('buyer', 'PUT', `/api/v1/assessments/${a.body.id}/answers/${q.id}`, { body: { response: 'NO' } })).status).toBe(200);
    expect((await h.call('legal2', 'POST', `/api/v1/assessments/${a.body.id}/answers/${q.id}/review`, { body: { review: 'ACCEPTED' } })).status).toBe(200);
    expect((await h.call('legal2', 'POST', `/api/v1/assessments/${a.body.id}/complete`)).status).toBe(200);
    const blockers = (await h.owner.query<{ id: string; department_id: string | null; assignee_role: string }>(
      `SELECT id, department_id, assignee_role FROM tasks WHERE kind = 'assessment_blocker' AND dedupe_key LIKE $1`, [`assessment-blocker:${a.body.id}:%`])).rows;
    expect(blockers.length).toBe(2);
    expect(blockers.every((b) => b.department_id === ik)).toBe(true);
    const ids = blockers.map((b) => b.id);
    const btSees = await taskIds('techEval');
    expect(ids.some((id) => btSees.includes(id))).toBe(false);
    const ikSees = await taskIds('security');
    expect(ids.some((id) => ikSees.includes(id))).toBe(true);
    // Satınalma kendi engel görevini görür.
    expect(ids.some((id) => ikSees.includes(id))).toBe(true);
    const procSees = await taskIds('legal2');
    expect(ids.some((id) => procSees.includes(id))).toBe(true);
  });

  it('karantinadaki belge görevi Satınalma\'ya düşer; bölüm kullanıcısına görünmez', async () => {
    const evil = Buffer.from(`%PDF-1.4\n1 0 obj << /OpenAction << /S /JavaScript /JS (app.alert(1)) >> >> endobj\n% ${randomUUID()}\n%%EOF`);
    const p = await h.upload('legal', { name: 'x.pdf', mime: 'application/pdf', data: evil }, { companyId: h.world.companyA1.id, kind: 'OTHER' });
    expect(p.body.basicCheckStatus).toBe('QUARANTINED');
    const task = (await h.owner.query<{ id: string }>(`SELECT id FROM tasks WHERE dedupe_key = $1`, [`doc:${p.body.documentVersionId}:quarantine`])).rows[0]!.id;
    expect(await taskIds('legal2')).toContain(task);
    expect(await taskIds('techEval')).not.toContain(task);
  });

  it('sözleşmeye bağlı olay görevleri sözleşmenin departmanını taşır; güvenlik olayı ön incelemesi Satınalma\'da', async () => {
    const c = await contract(ik);
    const r = await h.call('legal', 'POST', '/api/v1/incidents', { body: { supplierId: h.world.suppliers.s1, contractVersionId: c.contractVersionId, category: 'SECURITY', severity: 'HIGH',
      title: 'Yetkisiz erişim denemesi', description: 'Bordro sistemine yetkisiz erişim denemesi (sentetik).', occurredOn: '2026-10-01' }, headers: { 'idempotency-key': randomUUID() } });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    const review = (await h.owner.query<{ id: string; department_id: string | null; assignee_role: string }>(
      `SELECT id, department_id, assignee_role FROM tasks WHERE dedupe_key = $1`, [`incident-review:${r.body.id}`])).rows[0]!;
    expect(review).toMatchObject({ department_id: ik, assignee_role: 'PROCUREMENT' });
    expect(await taskIds('legal2')).toContain(review.id);
    expect(await taskIds('techEval')).not.toContain(review.id);
    expect((await h.call('legal2', 'POST', `/api/v1/incidents/${r.body.id}/transitions`, { body: { action: 'START_REVIEW', note: 'Kayıtlar incelendi (sentetik).' } })).status).toBe(200);
    const act = await h.call('legal', 'POST', `/api/v1/incidents/${r.body.id}/actions`, { body: { title: 'Erişim günlüklerini paylaş', ownerRole: 'DEPARTMENT_USER', dueDate: '2027-01-15' } });
    expect(act.status, JSON.stringify(act.body)).toBe(201);
    const corrective = (await h.owner.query<{ id: string; department_id: string | null }>(`SELECT id, department_id FROM tasks WHERE dedupe_key = $1`, [`corrective:${act.body.id}`])).rows[0]!;
    expect(corrective.department_id).toBe(ik);
    expect(await taskIds('security')).toContain(corrective.id);
    expect(await taskIds('techEval')).not.toContain(corrective.id);
  });
});

describe('Y4 kullanıcı listesi rol başına tutarlı', () => {
  it('Satınalma kullanıcı listesi tedarikçi portalı kullanıcılarını içermez; roller v2 adıyla', async () => {
    const r = await h.call('legal', 'GET', '/api/v1/members');
    expect(r.status).toBe(200);
    const ids = r.body.map((x: any) => x.id);
    expect(ids).not.toContain(h.world.users.supplier1.id);
    expect(ids).toContain(h.world.users.techEval.id);
    expect(r.body.find((x: any) => x.id === h.world.users.techEval.id).roles).toEqual(['DEPARTMENT_USER']);
  });
});

describe('I5 "Eşleşti" tahsis kontrolünden türer', () => {
  it('fazla tahsisli fatura listede eşleşmiş sayılmaz; tam tahsisli sayılır', async () => {
    const c = await contract(bt);
    const mk = async () => (await h.call('legal', 'POST', '/api/v1/invoices', { body: { companyId: h.world.companyA1.id, supplierId: h.world.suppliers.s1, kind: 'INVOICE', invoiceNo: `ESL${randomUUID().slice(0, 8)}`,
      issueDate: '2026-10-20', currency: 'TRY', lines: [{ description: 'Hizmet', quantity: '1', unit: 'adet', unitPrice: '100', netAmount: '100.00' }] } })).body.id as string;
    const over = await mk(); const exact = await mk();
    expect((await h.call('legal', 'PUT', `/api/v1/invoices/${over}/allocations`, { body: { allocations: [{ lineNo: 1, poLineId: null, contractVersionId: c.contractVersionId, quantity: '1', amount: '150.00' }] } })).status).toBe(200);
    expect((await h.call('legal', 'PUT', `/api/v1/invoices/${exact}/allocations`, { body: { allocations: [{ lineNo: 1, poLineId: null, contractVersionId: c.contractVersionId, quantity: '1', amount: '100.00' }] } })).status).toBe(200);
    const items = (await h.call('legal', 'GET', '/api/v1/invoices')).body.items;
    expect(items.find((x: any) => x.id === over).matched).toBe(false);
    expect(items.find((x: any) => x.id === exact).matched).toBe(true);
  });
});

describe('Y3 API yanıtlarında eski rol kodu yok', () => {
  it('fatura bulgularının sorumlu rolü v2 kodudur', async () => {
    const inv = await h.call('legal', 'POST', '/api/v1/invoices', { body: { companyId: h.world.companyA1.id, supplierId: h.world.suppliers.s1, kind: 'INVOICE', invoiceNo: `ROL${randomUUID().slice(0, 8)}`,
      issueDate: '2026-10-20', currency: 'TRY', lines: [{ description: 'Hizmet', quantity: '1', unit: 'adet', unitPrice: '100', netAmount: '100.00' }] } });
    const d = (await h.call('legal', 'GET', `/api/v1/invoices/${inv.body.id}`)).body;
    expect(d.check.issues.length).toBeGreaterThan(0);
    for (const i of d.check.issues) expect(['ADMIN', 'PROCUREMENT', 'DEPARTMENT_USER', 'AUDITOR'], i.code).toContain(i.ownerRole);
  });
});
