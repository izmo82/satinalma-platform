// v2 Faz 7 (D112) Görev 4: proje tamamlama (R5), çıkar çatışması beyanı (R9), uyum kanıtı yükleme. Tüm veri sentetik ("(SENTETİK)").
// Tamamlama testleri doğrudan yazılmış sentetik projelerle; beyan görevleri gerçek kaynak bulma akışıyla (puan, öneri, karar) sınanır.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { syntheticPdf } from '../src/devdata.ts';
import { withTenant } from '../src/db.ts';
import { makeHarness } from './harness.ts';

let h: Awaited<ReturnType<typeof makeHarness>>;
const rand = () => randomUUID().slice(0, 8);
const one = async <T = any>(sql: string, params: unknown[] = []) => (await h.owner.query(sql, params)).rows[0] as T;
const rows = async <T = any>(sql: string, params: unknown[] = []) => (await h.owner.query(sql, params)).rows as T[];

beforeAll(async () => {
  h = await makeHarness();
  // security: İK departman kullanıcısı (BT projelerini görmez); techEval BT'de kalır.
  await h.owner.query(`UPDATE memberships SET department_ids = $3 WHERE tenant_id = $1 AND user_id = $2`, [h.world.tenantA, h.world.users.security.id, [h.world.departments.ik]]);
});
afterAll(async () => { await h.close(); });

type Who = 'buyer' | 'finance' | 'legal2' | 'security' | 'techEval' | 'auditor' | 'supplier1' | 'supplier2';
const call = (who: Who, method: string, url: string, body?: unknown, headers?: Record<string, string>) =>
  h.call(who, method, url, { ...(body === undefined ? {} : { body }), ...(headers ? { headers } : {}) });

/** Doğrudan yazılmış sentetik proje (durum verilir; departman BT). */
async function rawProject(status = 'CONTRACTING') {
  const w = h.world;
  return (await one<{ id: string }>(`INSERT INTO projects (tenant_id, company_id, code, title, category, owner_user_id, created_by, department_id, status)
    VALUES ($1,$2,$3,'Tamamlama projesi (SENTETİK)','Genel',$4,$4,$5,$6) RETURNING id`,
    [w.tenantA, w.companyA1.id, `PRJ-TC-${rand()}`, w.users.buyer.id, w.departments.bt, status])).id;
}

/** Projeye bağlı sentetik sözleşme ailesi. APPROVED: onaylı zincir; OPEN: onayda; LEGACY: zincirsiz eski kayıt. */
async function contract(projectId: string, chain: 'APPROVED' | 'OPEN' | 'LEGACY') {
  const w = h.world;
  const company = w.companyA1.id;
  const doc = (await one<{ id: string }>(`INSERT INTO documents (tenant_id, company_id, kind, title, created_by, code) VALUES ($1,$2,'CONTRACT',$3,$4,$5) RETURNING id`,
    [w.tenantA, company, `Sözleşme ${rand()} (SENTETİK)`, w.users.buyer.id, `BLG-TC-${rand()}`])).id;
  const dv = (await one<{ id: string }>(`INSERT INTO document_versions (tenant_id, company_id, document_id, version_no, sha256, mime_type, size_bytes, storage_key,
      original_filename, basic_check_status, created_by) VALUES ($1,$2,$3,1,$4,'application/pdf',100,$5,'sozlesme.pdf','PASSED',$6) RETURNING id`,
    [w.tenantA, company, doc, 'f'.repeat(64), `tenant/${randomUUID()}`, w.users.buyer.id])).id;
  const familyId = (await one<{ id: string }>(`INSERT INTO contract_families (tenant_id, company_id, title, supplier_id, created_by, code, department_id, intake_flow,
      project_id, contract_type, owner_user_id, signed_on) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'SERVICE',$5,'2026-01-01') RETURNING id`,
    [w.tenantA, company, `Sözleşme ${rand()} (SENTETİK)`, w.suppliers.s1, w.users.buyer.id, `SZL-TC-${rand()}`, w.departments.bt, chain !== 'LEGACY', projectId])).id;
  const cvId = (await one<{ id: string }>(`INSERT INTO contract_versions (tenant_id, company_id, family_id, version_no, document_version_id, created_by)
    VALUES ($1,$2,$3,1,$4,$5) RETURNING id`, [w.tenantA, company, familyId, dv, w.users.buyer.id])).id;
  const termsId = (await one<{ id: string }>(`INSERT INTO contract_terms (tenant_id, company_id, contract_version_id, revision, currency, value_type, amount,
      start_date, end_date, source_ref, entered_by, limit_basis) VALUES ($1,$2,$3,1,'TRY','FIXED','100000.00','2026-01-01','2027-12-31','Madde 1 (sentetik)',$4,'NET') RETURNING id`,
    [w.tenantA, company, cvId, w.users.buyer.id])).id;
  if (chain !== 'LEGACY') {
    const c = (await one<{ id: string }>(`INSERT INTO contract_approval_chains (tenant_id, family_id, version_id, terms_id, submitted_by) VALUES ($1,$2,$3,$4,$5) RETURNING id`,
      [w.tenantA, familyId, cvId, termsId, w.users.buyer.id])).id;
    if (chain === 'APPROVED') await h.owner.query(`UPDATE contract_approval_chains SET closed_at = now(), outcome = 'APPROVED' WHERE id = $1`, [c]);
  }
  return familyId;
}

describe('R5: projeyi tamamla', () => {
  it('yalnız sözleşme aşamasında; onaylı ya da eski kayıt sözleşme yokken 409 (Türkçe neden)', async () => {
    const draft = await rawProject('EVALUATION');
    await contract(draft, 'APPROVED');
    const r1 = await call('buyer', 'POST', `/api/v1/projects/${draft}/complete`);
    expect(r1.status).toBe(409);
    expect(r1.body.error.code).toBe('invalid_state');
    expect(r1.body.error.message).toContain('sözleşme aşamasında');

    const p = await rawProject();
    const none = await call('buyer', 'POST', `/api/v1/projects/${p}/complete`);
    expect(none.status).toBe(409);
    expect(none.body.error).toMatchObject({ code: 'no_approved_contract', message: 'Projeyi tamamlamak için projeye bağlı en az bir onaylı ya da eski kayıt sözleşme gerekli.' });
    await contract(p, 'OPEN');
    expect((await call('buyer', 'POST', `/api/v1/projects/${p}/complete`)).body.error.code).toBe('no_approved_contract');
    const d = (await call('buyer', 'GET', `/api/v1/projects/${p}`)).body;
    expect(d.can.complete).toBe(false);
    expect(d.completion).toEqual({ ready: false, blockedReason: expect.stringContaining('onaylı ya da eski kayıt') });
    expect(await one(`SELECT status, completed_on FROM projects WHERE id = $1`, [p])).toEqual({ status: 'CONTRACTING', completed_on: null });
  });

  it('onaylı sözleşmeyle tamamlanır: completed_on İstanbul günü, yapan, denetim işi kuyrukta (idempotent); ikinci kez 409', async () => {
    const p = await rawProject();
    await contract(p, 'OPEN');
    await contract(p, 'APPROVED');
    const before = (await call('buyer', 'GET', `/api/v1/projects/${p}`)).body;
    expect(before.can.complete).toBe(true);
    expect(before.project.completedOn).toBeNull();
    // Departman kullanıcısı ve Denetçi tamamlayamaz; düğme de görünmez.
    expect((await call('techEval', 'GET', `/api/v1/projects/${p}`)).body.can.complete).toBe(false);
    expect((await call('techEval', 'POST', `/api/v1/projects/${p}/complete`)).status).toBe(403);
    expect((await call('auditor', 'POST', `/api/v1/projects/${p}/complete`)).status).toBe(403);
    // Başka kiracı göremez.
    expect((await h.call('buyerB', 'POST', `/api/v1/projects/${p}/complete`, { tenant: h.world.tenantB })).status).toBe(404);

    const r = await call('buyer', 'POST', `/api/v1/projects/${p}/complete`);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const today = (await one<{ d: string }>(`SELECT (now() AT TIME ZONE 'Europe/Istanbul')::date::text AS d`)).d;
    expect(r.body).toEqual({ status: 'COMPLETED', completedOn: today, auditJobId: expect.any(String) });
    expect(await one(`SELECT status, completed_on::text AS completed_on, completed_by FROM projects WHERE id = $1`, [p]))
      .toEqual({ status: 'COMPLETED', completed_on: today, completed_by: h.world.users.buyer.id });
    const job = await one(`SELECT id, kind, idempotency_key, payload, status, requested_by, company_id FROM jobs WHERE id = $1`, [r.body.auditJobId]);
    expect(job).toMatchObject({ kind: 'compliance.audit', idempotency_key: `audit:${p}:completed`, payload: { projectId: p, trigger: 'COMPLETED' },
      status: 'QUEUED', requested_by: h.world.users.buyer.id, company_id: h.world.companyA1.id });
    expect((await one(`SELECT data FROM audit_events WHERE action = 'project.completed' AND entity_id = $1`, [p])).data).toMatchObject({ completedOn: today, auditJobId: job.id });

    const again = await call('buyer', 'POST', `/api/v1/projects/${p}/complete`);
    expect(again.status).toBe(409);
    expect(again.body.error).toMatchObject({ code: 'invalid_state', message: 'Proje zaten tamamlandı.' });
    expect((await rows(`SELECT 1 FROM jobs WHERE kind = 'compliance.audit' AND idempotency_key = $1`, [`audit:${p}:completed`])).length).toBe(1);

    const after = (await call('buyer', 'GET', `/api/v1/projects/${p}`)).body;
    expect(after.project).toMatchObject({ status: 'COMPLETED', completedOn: today, completedBy: expect.any(String) });
    expect(after.can.complete).toBe(false);
    // Proje listesinde tamamlanan proje görünür (mevcut liste aynen).
    expect((await call('buyer', 'GET', '/api/v1/projects')).body.items.find((x: any) => x.id === p)?.status).toBe('COMPLETED');
  });

  it('eşzamanlı iki tamamlama: biri 200, diğeri 409; tek iş', async () => {
    const p = await rawProject();
    await contract(p, 'APPROVED');
    const rs = await Promise.all([call('buyer', 'POST', `/api/v1/projects/${p}/complete`), call('finance', 'POST', `/api/v1/projects/${p}/complete`)]);
    expect(rs.map((r) => r.status).sort()).toEqual([200, 409]);
    expect(rs.find((r) => r.status === 409)!.body.error.code).toBe('invalid_state');
    expect((await rows(`SELECT 1 FROM jobs WHERE kind = 'compliance.audit' AND idempotency_key = $1`, [`audit:${p}:completed`])).length).toBe(1);
    expect((await rows(`SELECT 1 FROM audit_events WHERE action = 'project.completed' AND entity_id = $1`, [p])).length).toBe(1);
  });

  it('eski kayıt (zincirsiz, 051a öncesi) sözleşme de tamamlamaya yeter', async () => {
    const p = await rawProject();
    await contract(p, 'LEGACY');
    expect((await call('buyer', 'GET', `/api/v1/projects/${p}`)).body.can.complete).toBe(true);
    expect((await call('buyer', 'POST', `/api/v1/projects/${p}/complete`)).status).toBe(200);
  });
});

// ---------- R9: kaynak bulma akışında katılımcı görevleri ----------

const criteria = [{ code: 'PRICE', name: 'Fiyat', kind: 'PRICE', weight: '60' }, { code: 'TECH', name: 'Teknik uygunluk', kind: 'SCORE', weight: '40' }];
const lines = [{ description: 'Sunucu bakımı (SENTETİK)', unit: 'ay', quantity: '12' }];

/** Gerçek akış: proje (BT) → yayın onayı → iki teklif → erken kapanış → techEval puanı → değerlendirme → buyer önerisi → legal2 kararı. */
async function sourcedProject() {
  const p = (await call('buyer', 'POST', '/api/v1/projects', { companyId: h.world.companyA1.id, title: `Beyan projesi ${rand()} (SENTETİK)`, category: 'BT hizmetleri',
    need: 'Sentetik ihtiyaç', currency: 'TRY', budget: '900000.00', budgetVerified: false, lines, criteria, departmentId: h.world.departments.bt })).body;
  expect(p.id).toBeTruthy();
  const req = await call('buyer', 'POST', `/api/v1/projects/${p.id}/rounds`, { closesAt: new Date(Date.now() + 48 * 3600_000).toISOString(),
    supplierIds: [h.world.suppliers.s1, h.world.suppliers.s2] }, { 'if-match': p.etag });
  expect(req.status, JSON.stringify(req.body)).toBe(201);
  expect((await call('legal2', 'POST', `/api/v1/rfq-rounds/${req.body.roundId}/decision`, { approve: true })).status).toBe(200);
  const lineId = (await call('buyer', 'GET', `/api/v1/projects/${p.id}`)).body.lines[0].id;
  const bid = async (who: 'supplier1' | 'supplier2', price: string) => (await h.call(who, 'POST', `/api/v1/portal/rounds/${req.body.roundId}/bids`,
    { body: { currency: 'TRY', validityDays: 60, lines: [{ projectLineId: lineId, unit: 'ay', quantity: '12', unitPrice: price, scope: 'INCLUDED' }] },
      headers: { 'idempotency-key': randomUUID() } })).body.bidId as string;
  const b1 = await bid('supplier1', '40000');
  const b2 = await bid('supplier2', '42000');
  expect((await call('legal2', 'POST', `/api/v1/rfq-rounds/${req.body.roundId}/close`, { reason: 'Tüm davetliler teklif verdi (sentetik).' })).status).toBe(200);
  return { id: p.id as string, lineId: lineId as string, b1, b2 };
}
const coiTasks = (projectId: string) => rows<{ status: string; assignee_user_id: string; assignee_role: string; department_id: string | null; entity_type: string }>(
  `SELECT status, assignee_user_id, assignee_role, department_id, entity_type FROM tasks WHERE kind = 'coi_declaration' AND entity_id = $1 ORDER BY created_at, assignee_user_id`, [projectId]);

describe('R9: çıkar çatışması beyanı', () => {
  let s: Awaited<ReturnType<typeof sourcedProject>>;
  beforeAll(async () => { s = await sourcedProject(); });

  it('puan veren ve proje sahibine kişisel İşlerim görevi açılır; öneri ve karar verene de; aynı roldeki başkası görmez', async () => {
    expect(await coiTasks(s.id)).toEqual([]);
    for (const b of [s.b1, s.b2]) {
      expect((await call('techEval', 'POST', `/api/v1/bids/${b}/scores`, { criterionCode: 'TECH', score: '80', evidence: 'Referans ziyaretine göre (sentetik).' })).status).toBe(200);
    }
    const afterScore = await coiTasks(s.id);
    expect(afterScore.map((t) => t.assignee_user_id).sort()).toEqual([h.world.users.buyer.id, h.world.users.techEval.id].sort());
    expect(afterScore.find((t) => t.assignee_user_id === h.world.users.techEval.id)).toMatchObject({ status: 'OPEN', assignee_role: 'DEPARTMENT_USER',
      department_id: h.world.departments.bt, entity_type: 'project' });
    expect(afterScore.find((t) => t.assignee_user_id === h.world.users.buyer.id)).toMatchObject({ assignee_role: 'PROCUREMENT' });

    const mine = (await call('techEval', 'GET', '/api/v1/tasks?view=mine')).body.items.filter((t: any) => t.kind === 'coi_declaration' && t.entityId === s.id);
    expect(mine).toHaveLength(1);
    expect(mine[0].refNo).toMatch(/^PRJ-/);
    expect(mine[0].title).toContain('Çıkar çatışması beyanı');
    // Kişiye atanmış beyan görevi aynı roldeki başka kullanıcıya "Tümü"nde de görünmez; sayaçlar şişmez.
    const others = (await call('finance', 'GET', '/api/v1/tasks?view=all')).body;
    expect(others.items.some((t: any) => t.kind === 'coi_declaration' && t.entityId === s.id)).toBe(false);
    expect(others.counts.all).toBe(others.items.length);

    const ev = await call('buyer', 'POST', `/api/v1/projects/${s.id}/evaluations`);
    expect(ev.status).toBe(201);
    const award = await call('buyer', 'POST', `/api/v1/projects/${s.id}/awards`, { evaluationId: ev.body.id, rationale: 'En yüksek ağırlıklı puan (sentetik).',
      allocations: [{ projectLineId: s.lineId, supplierId: h.world.suppliers.s1, quantity: '12' }] });
    expect(award.status, JSON.stringify(award.body)).toBe(201);
    expect((await coiTasks(s.id)).length).toBe(2); // öneren = sahip; ikinci görev açılmaz
    expect((await call('legal2', 'POST', `/api/v1/awards/${award.body.id}/decision`, { approve: true, note: 'Kurul onayı (sentetik).' })).status).toBe(200);
    expect((await coiTasks(s.id)).map((t) => t.assignee_user_id)).toContain(h.world.users.legal2.id);
    expect((await call('buyer', 'GET', `/api/v1/projects/${s.id}`)).body.project.status).toBe('CONTRACTING');
  });

  it('GET /coi katılımcıları, son beyanları ve eksikleri döner; proje detayında da', async () => {
    const r = await call('buyer', 'GET', `/api/v1/projects/${s.id}/coi`);
    expect(r.status).toBe(200);
    expect(r.body.participants.map((p: any) => p.userId).sort()).toEqual([h.world.users.buyer.id, h.world.users.techEval.id, h.world.users.legal2.id].sort());
    expect(r.body.participants.find((p: any) => p.userId === h.world.users.buyer.id).roleLabels).toEqual(['Proje sahibi', 'Kazananı öneren']);
    expect(r.body.participants.find((p: any) => p.userId === h.world.users.techEval.id).roleLabels).toEqual(['Puan veren']);
    expect(r.body.participants.find((p: any) => p.userId === h.world.users.legal2.id).roleLabels).toEqual(['Kazanan kararını veren']);
    expect(r.body).toMatchObject({ complete: false, hasConflict: false, status: 'MISSING', statusLabel: 'Eksik beyan: 3', me: { participant: true, latest: null, canDeclare: true } });
    expect(r.body.missing).toHaveLength(3);
    const detail = (await call('techEval', 'GET', `/api/v1/projects/${s.id}`)).body;
    expect(detail.coi).toMatchObject({ status: 'MISSING', me: { participant: true, canDeclare: true } });
    // Denetçi okur ama katılımcı değildir.
    expect((await call('auditor', 'GET', `/api/v1/projects/${s.id}/coi`)).body.me).toEqual({ participant: false, latest: null, canDeclare: false });
    // Başka departmandaki kullanıcı projeyi göremez.
    expect((await call('security', 'GET', `/api/v1/projects/${s.id}/coi`)).status).toBe(404);
  });

  it('beyan görevi kapatır; DECLARED açıklama ister; ikinci beyan yenisini ekler ve sonuncu geçerlidir; katılımcı olmayan 403', async () => {
    expect((await call('finance', 'POST', `/api/v1/projects/${s.id}/coi`, { kind: 'NONE' })).body.error.code).toBe('not_participant');
    expect((await call('finance', 'POST', `/api/v1/projects/${s.id}/coi`, { kind: 'NONE' })).status).toBe(403);
    expect((await call('auditor', 'POST', `/api/v1/projects/${s.id}/coi`, { kind: 'NONE' })).status).toBe(403);
    expect((await call('security', 'POST', `/api/v1/projects/${s.id}/coi`, { kind: 'NONE' })).status).toBe(404);
    expect((await call('techEval', 'POST', `/api/v1/projects/${s.id}/coi`, { kind: 'MAYBE' })).status).toBe(400);

    const first = await call('techEval', 'POST', `/api/v1/projects/${s.id}/coi`, { kind: 'NONE' });
    expect(first.status, JSON.stringify(first.body)).toBe(201);
    expect(first.body).toMatchObject({ kind: 'NONE', kindLabel: 'Çıkar çatışmam yok' });
    expect((await coiTasks(s.id)).find((t) => t.assignee_user_id === h.world.users.techEval.id)?.status).toBe('DONE');
    expect((await call('techEval', 'GET', '/api/v1/tasks?view=mine')).body.items.some((t: any) => t.kind === 'coi_declaration' && t.entityId === s.id)).toBe(false);
    expect((await one(`SELECT data FROM audit_events WHERE action = 'coi.declared' AND entity_id = $1 AND actor_user_id = $2`, [s.id, h.world.users.techEval.id])).data)
      .toMatchObject({ kind: 'NONE', declarationId: first.body.id });

    const short = await call('techEval', 'POST', `/api/v1/projects/${s.id}/coi`, { kind: 'DECLARED', statement: 'akraba' });
    expect(short.status).toBe(422);
    expect(short.body.error.code).toBe('statement_required');
    const second = await call('techEval', 'POST', `/api/v1/projects/${s.id}/coi`, { kind: 'DECLARED', statement: 'Tedarikçi 1 ortağıyla akrabalık bağım var (sentetik).' });
    expect(second.status).toBe(201);
    expect((await rows(`SELECT kind FROM coi_declarations WHERE project_id = $1 AND user_id = $2 ORDER BY declared_at`, [s.id, h.world.users.techEval.id])).map((r) => r.kind))
      .toEqual(['NONE', 'DECLARED']);
    const coi = (await call('buyer', 'GET', `/api/v1/projects/${s.id}/coi`)).body;
    const te = coi.participants.find((p: any) => p.userId === h.world.users.techEval.id);
    expect(te.latest).toMatchObject({ kind: 'DECLARED', kindLabel: 'Çıkar çatışması beyan edildi', count: 2 });
    expect(coi.conflicts).toEqual([{ userId: h.world.users.techEval.id, name: expect.any(String), statement: 'Tedarikçi 1 ortağıyla akrabalık bağım var (sentetik).' }]);
    expect(coi.missing).toHaveLength(2);

    // Beyan değişmez (tetikleyici) ve başkası adına yazılamaz (056a RLS).
    await expect(h.owner.query(`UPDATE coi_declarations SET kind = 'NONE' WHERE id = $1`, [second.body.id])).rejects.toThrow();
    const asBuyer = { tenantId: h.world.tenantA, userId: h.world.users.buyer.id, roles: ['PROCUREMENT'], companyIds: [h.world.companyA1.id], departmentIds: [], allDepartments: true, correlationId: 'coi-rls' };
    await expect(withTenant(h.pool, asBuyer, (tx) => tx.query(`INSERT INTO coi_declarations (tenant_id, company_id, project_id, user_id, kind) VALUES ($1,$2,$3,$4,'NONE')`,
      [h.world.tenantA, h.world.companyA1.id, s.id, h.world.users.techEval.id]))).rejects.toThrow();

    // Beyan verdikten sonra yeniden puan vermek yeni görev açmaz.
    expect((await call('techEval', 'POST', `/api/v1/bids/${s.b1}/scores`, { criterionCode: 'TECH', score: '82', evidence: 'İkinci referans görüşmesi (sentetik).' })).status).toBe(200);
    expect((await coiTasks(s.id)).filter((t) => t.assignee_user_id === h.world.users.techEval.id && t.status === 'OPEN')).toHaveLength(0);

    for (const who of ['buyer', 'legal2'] as const) expect((await call(who, 'POST', `/api/v1/projects/${s.id}/coi`, { kind: 'NONE', statement: null })).status).toBe(201);
    const done = (await call('buyer', 'GET', `/api/v1/projects/${s.id}/coi`)).body;
    expect(done).toMatchObject({ complete: true, hasConflict: true, status: 'DECLARED', missing: [] });
    expect((await coiTasks(s.id)).every((t) => t.status === 'DONE')).toBe(true);
  });
});

describe('R9 düzeltme 1: tamamlamada eksik beyan görevleri; tamamlanan projede puan yok', () => {
  it('görevi hiç açılmamış katılımcılara tamamlamada görev açılır (beyan verene açılmaz); sonra puan 409', async () => {
    const s = await sourcedProject();
    expect((await call('techEval', 'POST', `/api/v1/bids/${s.b1}/scores`, { criterionCode: 'TECH', score: '75', evidence: 'Referans görüşmesi (sentetik).' })).status).toBe(200);
    const ev = await call('buyer', 'POST', `/api/v1/projects/${s.id}/evaluations`);
    const award = await call('buyer', 'POST', `/api/v1/projects/${s.id}/awards`, { evaluationId: ev.body.id, rationale: 'En yüksek ağırlıklı puan (sentetik).',
      allocations: [{ projectLineId: s.lineId, supplierId: h.world.suppliers.s1, quantity: '12' }] });
    expect((await call('legal2', 'POST', `/api/v1/awards/${award.body.id}/decision`, { approve: true })).status).toBe(200);
    expect((await call('legal2', 'POST', `/api/v1/projects/${s.id}/coi`, { kind: 'NONE' })).status).toBe(201);
    // Faz 7 öncesi proje benzetimi: katılım olayları görev açmadan yaşanmış.
    await h.owner.query(`DELETE FROM tasks WHERE kind = 'coi_declaration' AND entity_id = $1`, [s.id]);
    await contract(s.id, 'APPROVED');
    expect((await call('buyer', 'POST', `/api/v1/projects/${s.id}/complete`)).status).toBe(200);
    const open = (await coiTasks(s.id)).filter((t) => t.status === 'OPEN').map((t) => t.assignee_user_id).sort();
    expect(open).toEqual([h.world.users.buyer.id, h.world.users.techEval.id].sort());
    const late = await call('techEval', 'POST', `/api/v1/bids/${s.b1}/scores`, { criterionCode: 'TECH', score: '90', evidence: 'Tamamlandıktan sonra deneme (sentetik).' });
    expect(late.status).toBe(409);
    expect(late.body.error).toMatchObject({ code: 'invalid_state', message: 'Tamamlanan projede teklif puanlanamaz.' });
  });
});

// ---------- Uyum kanıtı yükleme ----------

async function uploadEvidence(who: Who, projectId: string, file: { name: string; mime: string; data: Buffer }, fields: Record<string, string>) {
  const boundary = '----ev' + randomUUID();
  const parts: Buffer[] = Object.entries(fields).map(([k, v]) => Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`));
  parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${file.name}"\r\nContent-Type: ${file.mime}\r\n\r\n`), file.data,
    Buffer.from(`\r\n--${boundary}--\r\n`));
  const { DevAuthProvider } = await import('../src/auth.ts');
  const token = await new DevAuthProvider('test-secret-'.padEnd(40, 'x')).issue(`dev|${h.world.users[who].email}`);
  const res = await h.app.inject({ method: 'POST', url: `/api/v1/projects/${projectId}/compliance-evidence`, payload: Buffer.concat(parts),
    headers: { authorization: `Bearer ${token}`, 'x-tenant-id': h.world.tenantA, 'content-type': `multipart/form-data; boundary=${boundary}` } });
  return { status: res.statusCode, body: res.body ? JSON.parse(res.body) : null };
}
const pdf = (text: string) => ({ name: 'firma-arastirmasi.pdf', mime: 'application/pdf', data: syntheticPdf([[text]]) });

describe('Uyum kanıtı yükleme', () => {
  it('Satınalma ve proje departmanındaki kullanıcı yükler; mevcut belge deposu (OTHER, sürüm); liste ve içerik', async () => {
    const p = await rawProject();
    const a = await uploadEvidence('techEval', p, pdf(`Firma arastirmasi ${rand()} (SENTETIK)`), { checkKey: 'COMPANY_RESEARCH', kind: 'RESEARCH', title: 'Firma araştırması' });
    expect(a.status, JSON.stringify(a.body)).toBe(201);
    expect(a.body).toMatchObject({ checkKey: 'COMPANY_RESEARCH', kind: 'RESEARCH', kindLabel: 'Firma araştırması', basicCheckStatus: 'PASSED', avScanStatus: 'NOT_AVAILABLE',
      mimeType: 'application/pdf', uploadedById: h.world.users.techEval.id, contentUrl: `/api/v1/document-versions/${a.body.documentVersionId}/content` });
    expect(await one(`SELECT d.kind, dv.version_no, dv.storage_key LIKE $2 AS random_key FROM document_versions dv JOIN documents d ON d.id = dv.document_id WHERE dv.id = $1`,
      [a.body.documentVersionId, `t/${h.world.tenantA}/compliance-evidence/%`])).toEqual({ kind: 'OTHER', version_no: 1, random_key: true });
    const content = await call('techEval', 'GET', a.body.contentUrl);
    expect(content.status).toBe(200);
    expect((content.raw as Buffer).subarray(0, 5).toString('latin1')).toBe('%PDF-');

    const b = await uploadEvidence('buyer', p, { name: 'sicil.png', mime: 'image/png', data: Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8ffff3f0005fe02fea7d6a4f40000000049454e44ae426082', 'hex') },
      { checkKey: 'TRADE_REGISTRY', kind: 'TRADE_REGISTRY' });
    expect(b.status, JSON.stringify(b.body)).toBe(201);
    const list = await call('buyer', 'GET', `/api/v1/projects/${p}/compliance-evidence`);
    expect(list.body.items.map((x: any) => x.checkKey).sort()).toEqual(['COMPANY_RESEARCH', 'TRADE_REGISTRY']);
    expect((await call('auditor', 'GET', `/api/v1/projects/${p}/compliance-evidence?checkKey=TRADE_REGISTRY`)).body.items).toHaveLength(1);
    expect((await one(`SELECT data FROM audit_events WHERE action = 'compliance.evidence_uploaded' AND entity_id = $1 LIMIT 1`, [p])).data).toMatchObject({ checkKey: expect.any(String) });
  });

  it('RLS: başka departmanın kullanıcısı yükleyemez, listeyi ve belgeyi göremez; Denetçi yükleyemez; başka kiracı 404', async () => {
    const p = await rawProject();
    const a = await uploadEvidence('buyer', p, pdf(`Kanit ${rand()} (SENTETIK)`), { checkKey: 'COMPANY_RESEARCH', kind: 'RESEARCH' });
    expect(a.status).toBe(201);
    const objects = async () => (await rows(`SELECT count(*)::int AS n FROM document_versions WHERE storage_key LIKE $1`, [`t/${h.world.tenantA}/compliance-evidence/%`]))[0]!.n;
    const n0 = await objects();
    expect((await uploadEvidence('security', p, pdf('x (SENTETIK)'), { checkKey: 'COMPANY_RESEARCH', kind: 'RESEARCH' })).status).toBe(404);
    expect((await uploadEvidence('auditor', p, pdf('x (SENTETIK)'), { checkKey: 'COMPANY_RESEARCH', kind: 'RESEARCH' })).status).toBe(403);
    expect((await call('security', 'GET', `/api/v1/projects/${p}/compliance-evidence`)).status).toBe(404);
    expect((await call('security', 'GET', `/api/v1/document-versions/${a.body.documentVersionId}/content`)).status).toBe(404);
    expect((await h.call('buyerB', 'GET', `/api/v1/projects/${p}/compliance-evidence`, { tenant: h.world.tenantB })).status).toBe(404);
    expect(await objects()).toBe(n0);
    // Doğrudan yazma da politikayla reddedilir (proje görünmüyor).
    const asSecurity = { tenantId: h.world.tenantA, userId: h.world.users.security.id, roles: ['DEPARTMENT_USER'], companyIds: [h.world.companyA1.id],
      departmentIds: [h.world.departments.ik], allDepartments: false, correlationId: 'ev-rls' };
    await expect(withTenant(h.pool, asSecurity, (tx) => tx.query(`INSERT INTO compliance_evidence (tenant_id, company_id, project_id, check_key, document_version_id, kind, uploaded_by)
      VALUES ($1,$2,$3,'X',$4,'OTHER',$5)`, [h.world.tenantA, h.world.companyA1.id, p, a.body.documentVersionId, h.world.users.security.id]))).rejects.toThrow();
  });

  it('dosya ve alan denetimi: desteklenmeyen tür 415, uzantı/içerik uyuşmazlığı 415, eksik anahtar/tür 422; aktif içerikli PDF karantinaya ve göreve', async () => {
    const p = await rawProject();
    expect((await uploadEvidence('buyer', p, { name: 'not.txt', mime: 'text/plain', data: Buffer.from('merhaba') }, { checkKey: 'A', kind: 'OTHER' })).status).toBe(415);
    expect((await uploadEvidence('buyer', p, { name: 'sahte.pdf', mime: 'application/pdf', data: Buffer.from('not a pdf') }, { checkKey: 'A', kind: 'OTHER' })).status).toBe(415);
    expect((await uploadEvidence('buyer', p, { name: 'e.xml', mime: 'application/xml', data: Buffer.from('<?xml version="1.0"?><a/>') }, { checkKey: 'A', kind: 'OTHER' })).status).toBe(415);
    expect((await uploadEvidence('buyer', p, pdf('x'), { checkKey: 'bad key!', kind: 'OTHER' })).body.error.code).toBe('invalid_check_key');
    expect((await uploadEvidence('buyer', p, pdf('x'), { checkKey: 'A', kind: 'PHOTO' })).body.error.code).toBe('invalid_kind');
    const js = Buffer.from(`%PDF-1.4\n1 0 obj << /Type /Catalog /OpenAction << /S /JavaScript /JS (app.alert(1)) >> >> endobj\n%%EOF ${rand()}`);
    const q = await uploadEvidence('buyer', p, { name: 'aktif.pdf', mime: 'application/pdf', data: js }, { checkKey: 'A', kind: 'OTHER' });
    expect(q.status).toBe(201);
    expect(q.body).toMatchObject({ basicCheckStatus: 'QUARANTINED', basicCheckLabel: 'Karantinada', contentUrl: null });
    expect((await call('buyer', 'GET', `/api/v1/document-versions/${q.body.documentVersionId}/content`)).status).toBe(423);
    expect(await one(`SELECT kind, status FROM tasks WHERE dedupe_key = $1`, [`doc:${q.body.documentVersionId}:quarantine`])).toEqual({ kind: 'DOCUMENT_QUARANTINED', status: 'OPEN' });
    expect((await call('buyer', 'GET', `/api/v1/projects/${p}/compliance-evidence`)).body.items).toHaveLength(1);
  });
});
