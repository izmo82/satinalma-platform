// v2 Faz 1 (D93/D95): departmanlar artık sentetik dünyada (devdata) oluşur; test aynı departmanları kullanır
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { withTenant, type TenantContext } from '../src/db.ts';
import { syntheticPdf } from '../src/devdata.ts';
import { openTask } from '../src/tasks.ts';
import { makeHarness } from './harness.ts';

// v2 Faz 1 (D93): departman kapsamı RLS'de. Bölüm kullanıcısı yalnız kendi departmanının kayıtlarını görür; Yönetici, Satınalma
// ve Denetçi hepsini görür; departmansız kayıt bölüm kullanıcısına kapalıdır; tedarikçi portalı etkilenmez. Tüm veri sentetik.
let h: Awaited<ReturnType<typeof makeHarness>>;
let bt: string; let ik: string;
// İK projesi tam akışla (tur, teklif, değerlendirme, kazanan); BT projesi ve departmansız proje yalnız taslak.
let ikProject: string; let btProject: string; let nullProject: string;
let roundId: string; let bidId: string; let evaluationId: string; let awardId: string; let cvId: string; let familyId: string;
let ikDocVersion: string; const docTag = `IKBELGE${randomUUID().slice(0, 6)}`;

const criteria = [
  { code: 'PRICE', name: 'Fiyat', kind: 'PRICE', weight: '60' },
  { code: 'TECH', name: 'Teknik uygunluk', kind: 'SCORE', weight: '40' },
];
const lines = [{ lot: 'Lot 1', description: 'Bordro yazılımı bakımı', unit: 'ay', quantity: '12' }];
const inHours = (n: number) => new Date(Date.now() + n * 3600_000).toISOString();

async function newProject(title: string) {
  const r = await h.call('buyer', 'POST', '/api/v1/projects', { body: { companyId: h.world.companyA1.id, title, category: 'BT hizmetleri',
    need: 'Sentetik ihtiyaç', currency: 'TRY', budget: '100000.00', budgetVerified: false, lines, criteria } });
  expect(r.status).toBe(201);
  return r.body.id as string;
}
const setDept = (table: 'projects' | 'contract_families', id: string, dep: string | null) =>
  h.owner.query(`UPDATE ${table} SET department_id = $2 WHERE id = $1`, [id, dep]);

/** Bölüm kullanıcısı bağlamı (techEval: TECH_EVALUATOR → DEPARTMENT_USER), doğrudan RLS sınaması için. */
const deptCtx = (departmentIds: string[]): TenantContext => ({ tenantId: h.world.tenantA, userId: h.world.users.techEval.id, roles: ['DEPARTMENT_USER'],
  companyIds: [h.world.companyA1.id], departmentIds, allDepartments: false, correlationId: 'v2-dept' });

beforeAll(async () => {
  h = await makeHarness();
  // Görev 4: departmanlar ve techEval'in departmanı (Bilgi Teknolojileri) sentetik dünyada (devdata) oluşur.
  bt = h.world.departments.bt;
  ik = h.world.departments.ik;
  await h.owner.query(`UPDATE memberships SET department_ids = $3 WHERE tenant_id = $1 AND user_id = $2`, [h.world.tenantA, h.world.users.techEval.id, [bt]]);

  ikProject = await newProject(`İK bordro yazılımı bakımı ${randomUUID().slice(0, 4)}`);
  btProject = await newProject(`BT sunucu bakımı ${randomUUID().slice(0, 4)}`);
  nullProject = await newProject(`Departmansız eski proje ${randomUUID().slice(0, 4)}`);
  await setDept('projects', ikProject, ik);
  await setDept('projects', btProject, bt);

  // İK projesi: yayın → teklif → kapanış → puan → değerlendirme → kazanan önerisi.
  const p = (await h.call('buyer', 'GET', `/api/v1/projects/${ikProject}`)).body;
  const pub = await h.call('buyer', 'POST', `/api/v1/projects/${ikProject}/rounds`, { body: { closesAt: inHours(48), supplierIds: [h.world.suppliers.s1] }, headers: { 'if-match': p.project.etag } });
  expect(pub.status).toBe(201);
  roundId = pub.body.roundId;
  expect((await h.call('legal2', 'POST', `/api/v1/rfq-rounds/${roundId}/decision`, { body: { approve: true } })).status).toBe(200);
  const lineId = (await h.call('buyer', 'GET', `/api/v1/projects/${ikProject}`)).body.lines[0].id;
  const bid = await h.call('supplier1', 'POST', `/api/v1/portal/rounds/${roundId}/bids`, { body: { currency: 'TRY', validityDays: 60,
    lines: [{ projectLineId: lineId, unit: 'ay', quantity: '12', unitPrice: '5000', scope: 'INCLUDED' }] }, headers: { 'idempotency-key': randomUUID() } });
  expect(bid.status).toBe(201);
  bidId = bid.body.bidId;
  expect((await h.call('legal2', 'POST', `/api/v1/rfq-rounds/${roundId}/close`, { body: { reason: 'Tek davetli teklif verdi; sentetik erken kapanış.' } })).status).toBe(200);
  expect((await h.call('buyer', 'POST', `/api/v1/bids/${bidId}/scores`, { body: { criterionCode: 'TECH', score: '80', evidence: 'Referans görüşmesine göre değerlendirildi (sentetik).' } })).status).toBe(200);
  const ev = await h.call('buyer', 'POST', `/api/v1/projects/${ikProject}/evaluations`);
  expect(ev.status).toBe(201);
  evaluationId = ev.body.id;
  const aw = await h.call('buyer', 'POST', `/api/v1/projects/${ikProject}/awards`, { body: { evaluationId, rationale: 'Tek geçerli teklif ve teknik uygunluk (sentetik).',
    allocations: [{ projectLineId: lineId, supplierId: h.world.suppliers.s1, quantity: '12' }] } });
  expect(aw.status).toBe(201);
  awardId = aw.body.id;

  // İK sözleşmesi.
  const up = await h.upload('legal', { name: 'ik.pdf', mime: 'application/pdf', data: syntheticPdf([[`SENTETIK ${randomUUID()}`]]) },
    { companyId: h.world.companyA1.id, kind: 'CONTRACT', title: `Bordro bakım sözleşmesi ${docTag} (SENTETİK)` });
  ikDocVersion = up.body.documentVersionId;
  const c = await h.call('legal', 'POST', '/api/v1/contracts', { body: { title: `Bordro bakım ${randomUUID().slice(0, 4)} (SENTETİK)`, documentVersionId: up.body.documentVersionId,
    stage: 'EXECUTION', signatureMethod: 'NOT_REQUIRED', originalCustodyRequired: false,
    parties: [{ role: 'BUYER', displayName: h.world.companyA1.name, legalEntityId: h.world.companyA1.id }], supplierId: h.world.suppliers.s1 } });
  expect(c.status).toBe(201);
  cvId = c.body.contractVersionId;
  familyId = (await h.owner.query<{ family_id: string }>(`SELECT family_id FROM contract_versions WHERE id = $1`, [cvId])).rows[0]!.family_id;
  await setDept('contract_families', familyId, ik);
});
afterAll(async () => { await h.close(); });

describe('v2 departman kapsamı (RLS)', () => {
  it('dept_user_sees_only_own_department', async () => {
    expect((await h.call('techEval', 'GET', `/api/v1/projects/${ikProject}`)).status).toBe(404);
    expect((await h.call('techEval', 'GET', `/api/v1/projects/${btProject}`)).status).toBe(200);
    const ids = (await h.call('techEval', 'GET', '/api/v1/projects')).body.items.map((x: any) => x.id);
    expect(ids).toContain(btProject);
    expect(ids).not.toContain(ikProject);
  });

  it('child_tables_follow_parent', async () => {
    expect((await h.call('techEval', 'GET', `/api/v1/projects/${ikProject}/comparison`)).status).toBe(404);
    expect((await h.call('techEval', 'GET', `/api/v1/evaluations/${evaluationId}`)).status).toBe(404);
    expect((await h.call('techEval', 'POST', `/api/v1/bids/${bidId}/scores`, { body: { criterionCode: 'TECH', score: '10', evidence: 'Başka departmanın teklifini puanlama denemesi.' } })).status).toBe(404);
    const counts = (departmentIds: string[]) => withTenant(h.pool, deptCtx(departmentIds), async (tx) => {
      const n = async (sql: string, id: string) => (await tx.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${sql}`, [id])).rows[0]!.n;
      return {
        projects: await n('projects WHERE id = $1', ikProject),
        projectLines: await n('project_lines WHERE project_id = $1', ikProject),
        criteria: await n('evaluation_criteria WHERE project_id = $1', ikProject),
        rounds: await n('rfq_rounds WHERE project_id = $1', ikProject),
        invitations: await n('rfq_invitations WHERE project_id = $1', ikProject),
        bids: await n('bids WHERE project_id = $1', ikProject),
        bidLines: await n('bid_lines WHERE bid_id = $1', bidId),
        bidScores: await n('bid_scores WHERE bid_id = $1', bidId),
        evaluations: await n('evaluations WHERE project_id = $1', ikProject),
        awards: await n('awards WHERE project_id = $1', ikProject),
        awardLines: await n('award_lines WHERE award_id = $1', awardId),
        families: await n('contract_families WHERE id = $1', familyId),
        versions: await n('contract_versions WHERE id = $1', cvId),
        parties: await n('contract_parties WHERE contract_version_id = $1', cvId),
      };
    });
    const hidden = await counts([bt]);
    expect(Object.values(hidden).every((v) => v === 0), JSON.stringify(hidden)).toBe(true);
    // Aynı sorgu İK departmanı kapsamıyla satırları görür: sıfır sonuç departman süzgecinden gelir, veri yokluğundan değil.
    const visible = await counts([ik]);
    expect(Object.entries(visible).filter(([, v]) => v === 0).map(([k]) => k)).toEqual([]);
  });

  it('null_department_hidden_from_dept_user', async () => {
    expect((await h.call('techEval', 'GET', `/api/v1/projects/${nullProject}`)).status).toBe(404);
    // PROCUREMENT (buyer) ve AUDITOR uçtan görür. Kiracı yöneticisinin şirket kapsamı yok (T02); ADMIN'i SQL'de şirket kapsamıyla sınarız.
    for (const who of ['buyer', 'auditor'] as const) expect((await h.call(who, 'GET', `/api/v1/projects/${nullProject}`)).status, who).toBe(200);
    const ctx = (roles: string[], allDepartments: boolean): TenantContext => ({ tenantId: h.world.tenantA, userId: h.world.users.tenantAdmin.id, roles,
      companyIds: [h.world.companyA1.id], departmentIds: [], allDepartments, correlationId: 'v2-dept-null' });
    const seen = (c: TenantContext) => withTenant(h.pool, c, async (tx) => (await tx.query('SELECT 1 FROM projects WHERE id = $1', [nullProject])).rowCount);
    expect(await seen(ctx(['ADMIN'], true))).toBe(1);
    expect(await seen(ctx(['DEPARTMENT_USER'], false))).toBe(0);
  });

  it('supplier_portal_unaffected', async () => {
    const r = await h.call('supplier1', 'GET', `/api/v1/portal/rounds/${roundId}`);
    expect(r.status).toBe(200);
    expect(r.body.myBids.map((b: any) => b.id)).toContain(bidId);
    expect((await h.call('supplier1', 'GET', '/api/v1/portal/rounds')).body.items.some((x: any) => x.roundId === roundId)).toBe(true);
  });

  it('write_check', async () => {
    const before = (await h.owner.query<{ n: number }>(`SELECT count(*)::int AS n FROM projects WHERE tenant_id = $1`, [h.world.tenantA])).rows[0]!.n;
    // Görev 3: departmansız kayıt bölüm kullanıcısı için API'de reddedilir (department_required); RLS ayrıca aşağıda sınanır.
    const r = await h.call('techEval', 'POST', '/api/v1/projects', { body: { companyId: h.world.companyA1.id, title: 'Başka departmana proje denemesi', category: 'Genel', lines, criteria } });
    expect([403, 404, 409, 422]).toContain(r.status);
    // Doğrudan SQL: başka departmana ekleme WITH CHECK'e takılır; başka departmanın projesi güncellenemez (USING gizler).
    const insert = (dep: string) => withTenant(h.pool, deptCtx([bt]), (tx) => tx.query(
      `INSERT INTO projects (tenant_id, company_id, code, title, category, owner_user_id, created_by, department_id) VALUES ($1,$2,$3,'RLS denemesi','Genel',$4,$4,$5)`,
      [h.world.tenantA, h.world.companyA1.id, `PRJ-T-${randomUUID().slice(0, 6)}`, h.world.users.techEval.id, dep]));
    await expect(insert(ik)).rejects.toMatchObject({ code: '42501', message: expect.stringMatching(/row-level security/) });
    const upd = await withTenant(h.pool, deptCtx([bt]), (tx) => tx.query(`UPDATE projects SET title = 'Başka departman güncelleme denemesi' WHERE id = $1`, [ikProject]));
    expect(upd.rowCount).toBe(0);
    const after = (await h.owner.query<{ n: number }>(`SELECT count(*)::int AS n FROM projects WHERE tenant_id = $1`, [h.world.tenantA])).rows[0]!.n;
    expect(after).toBe(before);
    // Kontrol: kendi departmanına ekleme aynı yoldan geçer (red departmandan gelir, yetki eksikliğinden değil).
    expect((await insert(bt)).rowCount).toBe(1);
  });

  it('legacy_roles_normalized', async () => {
    await h.owner.query(`UPDATE memberships SET roles = '{BUYER,LEGAL}' WHERE tenant_id = $1 AND user_id = $2`, [h.world.tenantA, h.world.users.multi.id]);
    const me = await h.call('multi', 'GET', '/api/v1/me', { tenant: h.world.tenantA });
    expect(me.status).toBe(200);
    expect(me.body.roles).toEqual(['PROCUREMENT']);
  });

  it('documents_follow_owning_record', async () => {
    // İK sözleşmesinin belgesi BT kullanıcısına kapalı: metadata, içerik ve arama.
    expect((await h.call('techEval', 'GET', `/api/v1/document-versions/${ikDocVersion}`)).status).toBe(404);
    expect((await h.call('techEval', 'GET', `/api/v1/document-versions/${ikDocVersion}/content`)).status).toBe(404);
    const hits = (await h.call('techEval', 'GET', `/api/v1/search?q=${docTag}`)).body;
    expect(JSON.stringify(hits)).not.toContain(ikDocVersion);
    // Tüm departmanı gören (Satınalma) aynı belgeyi görür ve arar.
    expect((await h.call('legal', 'GET', `/api/v1/document-versions/${ikDocVersion}`)).status).toBe(200);
    expect(JSON.stringify((await h.call('legal', 'GET', `/api/v1/search?q=${docTag}`)).body)).toContain(ikDocVersion);
    // Hiçbir kapsamlı kaydın kullanmadığı yeni yükleme bölüm kullanıcısına bugünkü gibi açık.
    const freeTag = `SERBEST${randomUUID().slice(0, 6)}`;
    const free = await h.upload('legal', { name: 'serbest.pdf', mime: 'application/pdf', data: syntheticPdf([[`SENTETIK ${randomUUID()}`]]) },
      { companyId: h.world.companyA1.id, kind: 'CONTRACT', title: `Serbest belge ${freeTag} (SENTETİK)` });
    expect(free.status).toBe(201);
    expect((await h.call('techEval', 'GET', `/api/v1/document-versions/${free.body.documentVersionId}`)).status).toBe(200);
    expect((await h.call('techEval', 'GET', `/api/v1/document-versions/${free.body.documentVersionId}/content`)).status).toBe(200);
    expect(JSON.stringify((await h.call('techEval', 'GET', `/api/v1/search?q=${freeTag}`)).body)).toContain(free.body.documentVersionId);
    // SQL düzeyi: belge, sürüm ve sürüm alt kayıtları (çıkarılan alanlar) gizli; İK kapsamıyla görünür.
    const seen = (deps: string[]) => withTenant(h.pool, deptCtx(deps), async (tx) => ({
      versions: (await tx.query('SELECT 1 FROM document_versions WHERE id = $1', [ikDocVersion])).rowCount,
      fields: (await tx.query<{ n: number }>('SELECT count(*)::int AS n FROM extracted_fields WHERE document_version_id = $1', [ikDocVersion])).rows[0]!.n,
    }));
    const docId = (await h.owner.query<{ document_id: string }>('SELECT document_id FROM document_versions WHERE id = $1', [ikDocVersion])).rows[0]!.document_id;
    const docSeen = (deps: string[]) => withTenant(h.pool, deptCtx(deps), async (tx) => (await tx.query('SELECT 1 FROM documents WHERE id = $1', [docId])).rowCount);
    expect((await seen([bt])).versions).toBe(0);
    expect((await seen([bt])).fields).toBe(0);
    expect(await docSeen([bt])).toBe(0);
    expect((await seen([ik])).versions).toBe(1);
    expect(await docSeen([ik])).toBe(1);
  });

  it('legacy_null_department_approval_step', async () => {
    // Göç DEPARTMENT_USER adımı üretti; departmansız eski projede bu adımı ikinci bir Satınalma kullanıcısı karara bağlar.
    const category = `Eski onay ${randomUUID().slice(0, 6)}`;
    const rules = [{ id: 'ESKI', action: 'RFQ_PUBLISH', companyId: null, category, currency: 'TRY', minAmount: '0', maxAmount: null,
      steps: [{ role: 'DEPARTMENT_USER', label: 'Bölüm onayı' }] }];
    await h.owner.query(`UPDATE approval_policies SET status = 'RETIRED' WHERE tenant_id = $1 AND status = 'ACTIVE'`, [h.world.tenantA]);
    const v = (await h.owner.query<{ n: number }>(`SELECT coalesce(max(version_no), 0) + 1 AS n FROM approval_policies WHERE tenant_id = $1`, [h.world.tenantA])).rows[0]!.n;
    await h.owner.query(`INSERT INTO approval_policies (tenant_id, version_no, rules, note, status, created_by, activated_by, activated_at)
      VALUES ($1,$2,$3,'Eski departmansız onay adımı (sentetik).','ACTIVE',$4,$5,now())`, [h.world.tenantA, v, JSON.stringify(rules), h.world.users.tenantAdmin.id, h.world.users.legal.id]);
    const open = async (dep: string | null) => {
      const r = await h.call('buyer', 'POST', '/api/v1/projects', { body: { companyId: h.world.companyA1.id, title: `Eski onaylı proje ${randomUUID().slice(0, 4)}`, category,
        need: 'Sentetik', currency: 'TRY', budget: '1000.00', budgetVerified: false, lines, criteria } });
      expect(r.status).toBe(201);
      if (dep) await setDept('projects', r.body.id, dep);
      const p = (await h.call('buyer', 'GET', `/api/v1/projects/${r.body.id}`)).body;
      const pub = await h.call('buyer', 'POST', `/api/v1/projects/${r.body.id}/rounds`, { body: { closesAt: inHours(48), supplierIds: [h.world.suppliers.s1] }, headers: { 'if-match': p.project.etag } });
      expect(pub.status).toBe(201);
      return pub.body.roundId as string;
    };
    const legacyRound = await open(null);
    // Talep eden (Satınalma + bölüm kullanıcısı) yine karar veremez.
    const self = await h.call('buyer', 'POST', `/api/v1/rfq-rounds/${legacyRound}/decision`, { body: { approve: true } });
    expect(self.status).toBe(403);
    expect(self.body.error.code).toBe('segregation_of_duties');
    expect((await h.call('legal2', 'POST', `/api/v1/rfq-rounds/${legacyRound}/decision`, { body: { approve: true } })).status).toBe(200);
    // İstisna yalnız departmansız işte: BT projesinde aynı adımı Satınalma karara bağlayamaz.
    const btRound = await open(bt);
    const denied = await h.call('legal2', 'POST', `/api/v1/rfq-rounds/${btRound}/decision`, { body: { approve: true } });
    expect(denied.status).toBe(403);
    expect(denied.body.error.code).toBe('approval_step');
    await h.owner.query(`UPDATE approval_policies SET status = 'RETIRED' WHERE tenant_id = $1 AND version_no = $2`, [h.world.tenantA, v]);
  });
});

// v2 Faz 1 Görev 3: departman alanı API'de, departman uçları ve görev kapsamı. Bölüm kullanıcısı için departman zorunlu ve kendi
// departmanlarından biri; tüm departmanı görenler için isteğe bağlı (boş = departmansız, yalnız onlara görünür).
describe('v2 departman alanı ve uçları (Görev 3)', () => {
  const projectBody = (extra: Record<string, unknown> = {}) => ({ companyId: h.world.companyA1.id, title: `Departman alanı ${randomUUID().slice(0, 4)}`, category: 'BT hizmetleri',
    need: 'Sentetik', currency: 'TRY', budget: '1000.00', budgetVerified: false, lines, criteria, ...extra });
  const deptOf = async (table: string, id: string) => (await h.owner.query<{ d: string | null }>(`SELECT department_id AS d FROM ${table} WHERE id = $1`, [id])).rows[0]!.d;
  async function contractIn(dep: string | undefined) {
    const up = await h.upload('legal', { name: 'd.pdf', mime: 'application/pdf', data: syntheticPdf([[`SENTETIK ${randomUUID()}`]]) },
      { companyId: h.world.companyA1.id, kind: 'CONTRACT', title: `Departman sözleşmesi ${randomUUID().slice(0, 4)} (SENTETİK)` });
    const c = await h.call('legal', 'POST', '/api/v1/contracts', { body: { title: `Departman sözleşmesi ${randomUUID().slice(0, 4)} (SENTETİK)`, documentVersionId: up.body.documentVersionId,
      stage: 'EXECUTION', signatureMethod: 'NOT_REQUIRED', originalCustodyRequired: false, ...(dep ? { departmentId: dep } : {}),
      parties: [{ role: 'BUYER', displayName: h.world.companyA1.name, legalEntityId: h.world.companyA1.id }], supplierId: h.world.suppliers.s1 } });
    expect(c.status, JSON.stringify(c.body)).toBe(201);
    return c.body as { familyId: string; contractVersionId: string };
  }

  it('create_requires_department', async () => {
    const r = await h.call('techEval', 'POST', '/api/v1/projects', { body: projectBody() });
    expect(r.status).toBe(422);
    expect(r.body.error.code).toBe('department_required');
    // Tüm departmanı gören (Satınalma) için isteğe bağlı: departmansız kayıt.
    const p = await h.call('legal', 'POST', '/api/v1/projects', { body: projectBody() });
    expect(p.status).toBe(201);
    expect(await deptOf('projects', p.body.id)).toBeNull();
    // Kiracıda olmayan departman reddedilir.
    const unknown = await h.call('legal', 'POST', '/api/v1/projects', { body: projectBody({ departmentId: randomUUID() }) });
    expect(unknown.status).toBe(422);
    expect(unknown.body.error.code).toBe('department_unknown');
    // Bölüm kullanıcısı kendi departmanıyla açar; detay ve listede departman görünür.
    const own = await h.call('techEval', 'POST', '/api/v1/projects', { body: projectBody({ departmentId: bt }) });
    expect(own.status).toBe(201);
    expect(await deptOf('projects', own.body.id)).toBe(bt);
    const d = (await h.call('techEval', 'GET', `/api/v1/projects/${own.body.id}`)).body.project;
    expect(d).toMatchObject({ departmentId: bt, departmentName: 'Bilgi Teknolojileri' });
    // Değerlendirme de departman alır; bölüm kullanıcısı departmansız başlatamaz.
    const tpl = (await h.owner.query<{ id: string }>(`INSERT INTO questionnaire_templates (tenant_id, code, version, name, category, status, created_by)
      VALUES ($1, $2, 1, 'Departman şablonu (sentetik)', 'Genel', 'PUBLISHED', $3) RETURNING id`, [h.world.tenantA, `DEP${randomUUID().slice(0, 6)}`, h.world.users.legal.id])).rows[0]!.id;
    const factors = { dataSensitivity: 'LOW', accessLevel: 'LOW', criticality: 'LOW', substitutability: 'LOW', subcontractorDependence: 'LOW' };
    const noDep = await h.call('techEval', 'POST', '/api/v1/assessments', { body: { supplierId: h.world.suppliers.s1, templateId: tpl, scope: 'Departman kapsamı', inherentFactors: factors } });
    expect(noDep.status).toBe(422);
    expect(noDep.body.error.code).toBe('department_required');
    const a = await h.call('techEval', 'POST', '/api/v1/assessments', { body: { supplierId: h.world.suppliers.s1, templateId: tpl, scope: 'Departman kapsamı', inherentFactors: factors, departmentId: bt } });
    expect(a.status, JSON.stringify(a.body)).toBe(201);
    expect(await deptOf('supplier_assessments', a.body.id)).toBe(bt);
    expect((await h.call('techEval', 'GET', `/api/v1/assessments/${a.body.id}`)).body.assessment).toMatchObject({ departmentId: bt, departmentName: 'Bilgi Teknolojileri' });
    const listed = (await h.call('legal', 'GET', `/api/v1/suppliers/${h.world.suppliers.s1}/assessments?departmentId=${bt}`)).body.items;
    expect(listed.map((x: any) => x.id)).toContain(a.body.id);
    expect(listed.every((x: any) => x.departmentId === bt)).toBe(true);
  });

  it('dept_user_cannot_pick_foreign_department', async () => {
    const before = (await h.owner.query<{ n: number }>(`SELECT count(*)::int AS n FROM projects WHERE tenant_id = $1`, [h.world.tenantA])).rows[0]!.n;
    const r = await h.call('techEval', 'POST', '/api/v1/projects', { body: projectBody({ departmentId: ik }) });
    expect(r.status).toBe(403);
    expect(r.body.error.code).toBe('department_forbidden');
    expect((await h.owner.query<{ n: number }>(`SELECT count(*)::int AS n FROM projects WHERE tenant_id = $1`, [h.world.tenantA])).rows[0]!.n).toBe(before);
  });

  it('list_filter_by_department', async () => {
    const items = (await h.call('buyer', 'GET', `/api/v1/projects?departmentId=${bt}`)).body.items;
    const ids = items.map((x: any) => x.id);
    expect(ids).toContain(btProject);
    expect(ids).not.toContain(ikProject);
    expect(ids).not.toContain(nullProject);
    expect(items.find((x: any) => x.id === btProject)).toMatchObject({ departmentId: bt, departmentName: 'Bilgi Teknolojileri' });
    // Süzgeçsiz liste hepsini (departmansız dahil) döner.
    const all = (await h.call('buyer', 'GET', '/api/v1/projects')).body.items;
    expect(all.find((x: any) => x.id === nullProject)).toMatchObject({ departmentId: null, departmentName: null });
    // Sözleşme: oluşturmada departman; liste süzgeci ve alanları.
    const c = await contractIn(ik);
    expect(await deptOf('contract_families', c.familyId)).toBe(ik);
    const cl = (await h.call('legal', 'GET', `/api/v1/contracts?departmentId=${ik}`)).body;
    expect(cl.items.map((x: any) => x.id)).toContain(c.contractVersionId);
    expect(cl.items.every((x: any) => x.departmentId === ik)).toBe(true);
    expect(cl.items.find((x: any) => x.id === c.contractVersionId)).toMatchObject({ departmentName: 'İnsan Kaynakları' });
    expect((await h.call('legal', 'GET', `/api/v1/contracts?departmentId=${bt}`)).body.items.map((x: any) => x.id)).not.toContain(c.contractVersionId);
    expect((await h.call('legal', 'GET', `/api/v1/contract-versions/${c.contractVersionId}/signature-status`)).body.contractVersion).toMatchObject({ departmentId: ik });
  });

  it('invoice_inherits_department_from_contract', async () => {
    const ikC = await contractIn(ik);
    const btC = await contractIn(bt);
    const newInvoice = async () => {
      const r = await h.call('finance', 'POST', '/api/v1/invoices', { body: { companyId: h.world.companyA1.id, supplierId: h.world.suppliers.s1, kind: 'INVOICE', invoiceNo: `DEP${randomUUID().slice(0, 8)}`,
        issueDate: '2026-10-20', currency: 'TRY', lines: [{ description: 'Hizmet', quantity: '1', unit: 'adet', unitPrice: '100', netAmount: '100.00' },
          { description: 'Hizmet 2', quantity: '1', unit: 'adet', unitPrice: '100', netAmount: '100.00' }] } });
      expect(r.status, JSON.stringify(r.body)).toBe(201);
      return r.body.id as string;
    };
    const alloc = (cv1: string, cv2: string) => [{ lineNo: 1, poLineId: null, contractVersionId: cv1, quantity: '1', amount: '100.00' },
      { lineNo: 2, poLineId: null, contractVersionId: cv2, quantity: '1', amount: '100.00' }];
    const inv = await newInvoice();
    expect(await deptOf('invoices', inv)).toBeNull();
    expect((await h.call('finance', 'PUT', `/api/v1/invoices/${inv}/allocations`, { body: { allocations: alloc(ikC.contractVersionId, ikC.contractVersionId) } })).status).toBe(200);
    expect(await deptOf('invoices', inv)).toBe(ik);
    expect((await h.call('finance', 'GET', `/api/v1/invoices/${inv}`)).body.invoice).toMatchObject({ departmentId: ik, departmentName: 'İnsan Kaynakları' });
    expect((await h.call('finance', 'GET', `/api/v1/invoices?departmentId=${ik}`)).body.items.map((x: any) => x.id)).toContain(inv);
    expect((await h.call('finance', 'GET', `/api/v1/invoices?departmentId=${bt}`)).body.items.map((x: any) => x.id)).not.toContain(inv);
    // Farklı departmanlı iki sözleşme: tahmin yok, departman boş kalır.
    const mixed = await newInvoice();
    expect((await h.call('finance', 'PUT', `/api/v1/invoices/${mixed}/allocations`, { body: { allocations: alloc(ikC.contractVersionId, btC.contractVersionId) } })).status).toBe(200);
    expect(await deptOf('invoices', mixed)).toBeNull();
  });

  it('admin_assigns_membership_departments', async () => {
    // Departman listesi iç rollere açık; tedarikçiye kapalı.
    const list = await h.call('techEval', 'GET', '/api/v1/departments');
    expect(list.status).toBe(200);
    expect(list.body.items).toEqual(expect.arrayContaining([{ id: bt, name: 'Bilgi Teknolojileri' }, { id: ik, name: 'İnsan Kaynakları' }]));
    expect((await h.call('supplier1', 'GET', '/api/v1/departments')).status).toBe(403);
    // Departman oluşturma yalnız Yönetici.
    const name = `Finans ${randomUUID().slice(0, 4)}`;
    expect((await h.call('buyer', 'POST', '/api/v1/departments', { body: { name } })).status).toBe(403);
    const created = await h.call('tenantAdmin', 'POST', '/api/v1/departments', { body: { name } });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ name });
    expect((await h.call('tenantAdmin', 'POST', '/api/v1/departments', { body: { name } })).status).toBe(409);
    const ev = async (action: string, entityId: string) => (await h.owner.query(`SELECT 1 FROM audit_events WHERE tenant_id = $1 AND action = $2 AND entity_id = $3`, [h.world.tenantA, action, entityId])).rowCount;
    expect(await ev('department.created', created.body.id)).toBe(1);
    // Üyelik departmanları: Yönetici atar; başkası 403.
    const target = h.world.users.security.id;
    expect((await h.call('buyer', 'PUT', `/api/v1/memberships/${target}/departments`, { body: { departmentIds: [ik] } })).status).toBe(403);
    const set = await h.call('tenantAdmin', 'PUT', `/api/v1/memberships/${target}/departments`, { body: { departmentIds: [ik, created.body.id] } });
    expect(set.status, JSON.stringify(set.body)).toBe(200);
    const stored = (await h.owner.query<{ d: string[] }>(`SELECT department_ids AS d FROM memberships WHERE tenant_id = $1 AND user_id = $2`, [h.world.tenantA, target])).rows[0]!.d;
    expect([...stored].sort()).toEqual([ik, created.body.id].sort());
    expect(await ev('membership.departments.set', target)).toBe(1);
    // Başka kiracının departmanı reddedilir; başka kiracıdaki üyelik dokunulmaz (404).
    const foreign = (await h.owner.query<{ id: string }>(`INSERT INTO departments (tenant_id, name) VALUES ($1, $2) RETURNING id`, [h.world.tenantB, `Yabancı ${randomUUID().slice(0, 4)}`])).rows[0]!.id;
    const bad = await h.call('tenantAdmin', 'PUT', `/api/v1/memberships/${target}/departments`, { body: { departmentIds: [foreign] } });
    expect(bad.status).toBe(422);
    expect(bad.body.error.code).toBe('department_unknown');
    expect((await h.call('tenantAdmin', 'PUT', `/api/v1/memberships/${h.world.users.buyerB.id}/departments`, { body: { departmentIds: [ik] } })).status).toBe(404);
    const other = (await h.owner.query<{ d: string[] }>(`SELECT department_ids AS d FROM memberships WHERE tenant_id = $1 AND user_id = $2`, [h.world.tenantB, h.world.users.buyerB.id])).rows[0]!.d;
    expect(other).toEqual([]);
    // Yeni departman bağlamı sonraki istekte geçerli: kullanıcı İK projesini görür.
    expect((await h.call('security', 'GET', `/api/v1/projects/${ikProject}`)).status).toBe(200);
  });

  it('me_returns_departments', async () => {
    const me = await h.call('techEval', 'GET', '/api/v1/me');
    expect(me.status).toBe(200);
    expect(me.body.roles).toEqual(['DEPARTMENT_USER']);
    expect(me.body.departments).toEqual([{ id: bt, name: 'Bilgi Teknolojileri' }]);
    expect(me.body.allDepartments).toBe(false);
    const buyer = (await h.call('legal', 'GET', '/api/v1/me')).body;
    expect(buyer.departments).toEqual([]);
    expect(buyer.allDepartments).toBe(true);
  });

  /** Görev açma (tüm departmanı gören sistem bağlamı); departman varlıktan çözülür. */
  const sysCtx = (): TenantContext => ({ tenantId: h.world.tenantA, userId: h.world.users.legal.id, roles: ['PROCUREMENT'],
    companyIds: [h.world.companyA1.id], departmentIds: [], allDepartments: true, correlationId: 'v2-dept-task' });
  const taskFor = (projectId: string, tag: string) => withTenant(h.pool, sysCtx(), (tx) => openTask(tx, sysCtx(),
    { companyId: h.world.companyA1.id, kind: 'dept_test', entityType: 'project', entityId: projectId, title: `Bölüm görevi ${tag}`, reason: 'Sentetik',
      nextAction: 'İnceleyin', assigneeRole: 'DEPARTMENT_USER', dedupeKey: `dept-test:${tag}:${randomUUID()}` }));

  it('tasks_department_scoped', async () => {
    const ikTask = (await taskFor(ikProject, 'ik')).id;
    const btTask = (await taskFor(btProject, 'bt')).id;
    expect(await deptOf('tasks', ikTask)).toBe(ik);
    expect(await deptOf('tasks', btTask)).toBe(bt);
    const ids = (await h.call('techEval', 'GET', '/api/v1/tasks?view=all')).body.items.map((x: any) => x.id);
    expect(ids).toContain(btTask);
    expect(ids).not.toContain(ikTask);
    const notes = (await h.call('techEval', 'GET', '/api/v1/notifications')).body.items.map((x: any) => x.id);
    expect(notes).toContain(btTask);
    expect(notes).not.toContain(ikTask);
    // SQL düzeyi: İK görevi BT kullanıcısına kapalı, İK kapsamıyla açık.
    const seen = (deps: string[]) => withTenant(h.pool, deptCtx(deps), async (tx) => (await tx.query('SELECT 1 FROM tasks WHERE id = $1', [ikTask])).rowCount);
    expect(await seen([bt])).toBe(0);
    expect(await seen([ik])).toBe(1);
  });

  it('legacy_department_user_task_visible_to_procurement', async () => {
    const legacy = (await taskFor(nullProject, 'eski')).id;
    const scoped = (await taskFor(btProject, 'kapsamli')).id;
    expect(await deptOf('tasks', legacy)).toBeNull();
    // Saf Satınalma kullanıcısı (bölüm rolü yok) departmansız eski kaydın bölüm görevini görür; departmanlı olanı görmez.
    const r = (await h.call('legal', 'GET', '/api/v1/tasks?view=all')).body;
    const ids = r.items.map((x: any) => x.id);
    expect(ids).toContain(legacy);
    expect(ids).not.toContain(scoped);
    const notes = (await h.call('legal', 'GET', '/api/v1/notifications')).body.items.map((x: any) => x.id);
    expect(notes).toContain(legacy);
    expect(notes).not.toContain(scoped);
    // Departmansız kayıt yalnız tüm departmanı görenlere: bölüm kullanıcısı eski kaydın görevini ne listede ne bildirimde görür.
    expect((await h.call('techEval', 'GET', '/api/v1/tasks?view=all')).body.items.map((x: any) => x.id)).not.toContain(legacy);
    expect((await h.call('techEval', 'GET', '/api/v1/notifications')).body.items.map((x: any) => x.id)).not.toContain(legacy);
    // Departmansız kayda bağlı olmayan görev (tedarikçi) bölüm kullanıcısına rolle açık kalır.
    const supplierTask = (await withTenant(h.pool, sysCtx(), (tx) => openTask(tx, sysCtx(), { companyId: null, kind: 'dept_test', entityType: 'supplier',
      entityId: h.world.suppliers.s1, title: 'Tedarikçi görevi', reason: 'Sentetik', nextAction: 'İnceleyin', assigneeRole: 'DEPARTMENT_USER', dedupeKey: `dept-test:sup:${randomUUID()}` }))).id;
    expect((await h.call('techEval', 'GET', '/api/v1/tasks?view=all')).body.items.map((x: any) => x.id)).toContain(supplierTask);
  });
});
