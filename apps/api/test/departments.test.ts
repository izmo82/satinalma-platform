import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { withTenant, type TenantContext } from '../src/db.ts';
import { syntheticPdf } from '../src/devdata.ts';
import { makeHarness } from './harness.ts';

// v2 Faz 1 (D93): departman kapsamı RLS'de. Bölüm kullanıcısı yalnız kendi departmanının kayıtlarını görür; Yönetici, Satınalma
// ve Denetçi hepsini görür; departmansız kayıt bölüm kullanıcısına kapalıdır; tedarikçi portalı etkilenmez. Tüm veri sentetik.
let h: Awaited<ReturnType<typeof makeHarness>>;
let bt: string; let ik: string;
// İK projesi tam akışla (tur, teklif, değerlendirme, kazanan); BT projesi ve departmansız proje yalnız taslak.
let ikProject: string; let btProject: string; let nullProject: string;
let roundId: string; let bidId: string; let evaluationId: string; let awardId: string; let cvId: string; let familyId: string;

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
  const dep = async (name: string) => (await h.owner.query<{ id: string }>(`INSERT INTO departments (tenant_id, name) VALUES ($1, $2) RETURNING id`, [h.world.tenantA, name])).rows[0]!.id;
  bt = await dep('Bilgi Teknolojileri');
  ik = await dep('İnsan Kaynakları');
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
    { companyId: h.world.companyA1.id, kind: 'CONTRACT', title: 'Bordro bakım sözleşmesi (SENTETİK)' });
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
    // API'de departman alanı henüz yok (Task 3): bölüm kullanıcısının açtığı kayıt kendi departmanında olmadığından RLS reddeder.
    const r = await h.call('techEval', 'POST', '/api/v1/projects', { body: { companyId: h.world.companyA1.id, title: 'Başka departmana proje denemesi', category: 'Genel', lines, criteria } });
    expect([403, 404, 409]).toContain(r.status);
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
});
