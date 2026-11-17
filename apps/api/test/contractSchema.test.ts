// v2 Faz 3 (D108+) Görev 2: 048 sözleşme şeması — yeni tablolarda kiracı RLS'i, onay kararının bir kez yazılması, onaycı görünürlüğü (R6),
// NEW_PROJECT yenileme kararı, TEMPLATE belge türü. Tüm veri sentetik.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { withTenant, type TenantContext } from '../src/db.ts';
import { syntheticPdf } from '../src/devdata.ts';
import { makeHarness } from './harness.ts';

let h: Awaited<ReturnType<typeof makeHarness>>;
type Contract = { familyId: string; cvId: string; termsId: string; docVersionId: string; documentId: string };
// İK departmanının üç sözleşmesi: c1'de techEval adıma atanır, c2'ye hiç dokunulmaz, c3'te techEval departman sorumlusunun vekilidir.
let c1: Contract; let c2: Contract; let c3: Contract;
let templateDocVersion: string; let templateId: string;

const ctxA = (userId: string, opts: { all?: boolean; departmentIds?: string[] } = {}): TenantContext => ({ tenantId: h.world.tenantA, userId,
  roles: opts.all ? ['PROCUREMENT'] : ['DEPARTMENT_USER'], companyIds: [h.world.companyA1.id], departmentIds: opts.departmentIds ?? [],
  allDepartments: opts.all ?? false, correlationId: 'v2-contract-schema' });
const ctxB = (): TenantContext => ({ tenantId: h.world.tenantB, userId: h.world.users.buyerB.id, roles: ['PROCUREMENT'],
  companyIds: [h.world.companyB1.id], departmentIds: [], allDepartments: true, correlationId: 'v2-contract-schema-b' });

async function ikContract(tag: string): Promise<Contract> {
  const up = await h.upload('legal', { name: `${tag}.pdf`, mime: 'application/pdf', data: syntheticPdf([[`SENTETIK ${tag} ${randomUUID()}`]]) },
    { companyId: h.world.companyA1.id, kind: 'CONTRACT', title: `İK sözleşmesi ${tag} (SENTETİK)` });
  expect(up.status).toBe(201);
  const c = await h.call('legal', 'POST', '/api/v1/contracts', { body: { title: `İK ${tag} ${randomUUID().slice(0, 4)} (SENTETİK)`,
    documentVersionId: up.body.documentVersionId, stage: 'EXECUTION', signatureMethod: 'NOT_REQUIRED', originalCustodyRequired: false,
    parties: [{ role: 'BUYER', displayName: h.world.companyA1.name, legalEntityId: h.world.companyA1.id }], supplierId: h.world.suppliers.s1 } });
  expect(c.status).toBe(201);
  const cvId = c.body.contractVersionId as string;
  const familyId = (await h.owner.query<{ family_id: string }>(`SELECT family_id FROM contract_versions WHERE id = $1`, [cvId])).rows[0]!.family_id;
  await h.owner.query(`UPDATE contract_families SET department_id = $2 WHERE id = $1`, [familyId, h.world.departments.ik]);
  const termsId = (await h.owner.query<{ id: string }>(
    `INSERT INTO contract_terms (tenant_id, company_id, contract_version_id, revision, currency, value_type, amount, start_date, end_date, source_ref, entered_by)
     VALUES ($1, $2, $3, 1, 'TRY', 'FIXED', '120000.00', '2026-01-01', '2026-12-31', 'Madde 4 (sentetik)', $4) RETURNING id`,
    [h.world.tenantA, h.world.companyA1.id, cvId, h.world.users.legal.id])).rows[0]!.id;
  const documentId = (await h.owner.query<{ document_id: string }>(`SELECT document_id FROM document_versions WHERE id = $1`, [up.body.documentVersionId])).rows[0]!.document_id;
  return { familyId, cvId, termsId, docVersionId: up.body.documentVersionId, documentId };
}

async function chain(c: Contract, submittedBy: string): Promise<string> {
  return (await h.owner.query<{ id: string }>(
    `INSERT INTO contract_approval_chains (tenant_id, family_id, version_id, terms_id, submitted_by) VALUES ($1, $2, $3, $4, $5) RETURNING id`,
    [h.world.tenantA, c.familyId, c.cvId, c.termsId, submittedBy])).rows[0]!.id;
}

/** techEval (yalnız BT departmanı) bağlamında sözleşmenin görünen parçaları. */
const seenBy = (userId: string, c: Contract) => withTenant(h.pool, ctxA(userId, { departmentIds: [h.world.departments.bt] }), async (tx) => {
  const n = async (sql: string, id: string) => (await tx.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${sql}`, [id])).rows[0]!.n;
  return {
    family: await n('contract_families WHERE id = $1', c.familyId),
    version: await n('contract_versions WHERE id = $1', c.cvId),
    terms: await n('contract_terms WHERE id = $1', c.termsId),
    parties: await n('contract_parties WHERE contract_version_id = $1', c.cvId),
    document: await n('documents WHERE id = $1', c.documentId),
    documentVersion: await n('document_versions WHERE id = $1', c.docVersionId),
  };
});
const all = (o: Record<string, number>, v: number) => Object.entries(o).filter(([, x]) => x !== v).map(([k]) => k);

beforeAll(async () => {
  h = await makeHarness();
  await h.owner.query(`UPDATE memberships SET department_ids = $3 WHERE tenant_id = $1 AND user_id = $2`,
    [h.world.tenantA, h.world.users.techEval.id, [h.world.departments.bt]]);
  c1 = await ikContract('c1');
  c2 = await ikContract('c2');
  c3 = await ikContract('c3');
  const doc = (await h.owner.query<{ id: string }>(`INSERT INTO documents (tenant_id, company_id, kind, title, created_by, code) VALUES ($1, $2, 'TEMPLATE', 'Hizmet sözleşmesi şablonu (SENTETİK)', $3, $4) RETURNING id`,
    [h.world.tenantA, h.world.companyA1.id, h.world.users.buyer.id, `BLG-SBL-${randomUUID().slice(0, 8)}`])).rows[0]!.id;
  templateDocVersion = (await h.owner.query<{ id: string }>(
    `INSERT INTO document_versions (tenant_id, company_id, document_id, version_no, sha256, mime_type, size_bytes, storage_key, original_filename, basic_check_status, created_by)
     VALUES ($1, $2, $3, 1, $4, 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 100, $5, 'hizmet.docx', 'PASSED', $6) RETURNING id`,
    [h.world.tenantA, h.world.companyA1.id, doc, 'a'.repeat(64), `tenant/${randomUUID()}`, h.world.users.buyer.id])).rows[0]!.id;
  templateId = (await h.owner.query<{ id: string }>(`INSERT INTO contract_templates (tenant_id, code, name, contract_type, created_by) VALUES ($1, $2, 'Hizmet sözleşmesi', 'SERVICE', $3) RETURNING id`,
    [h.world.tenantA, `HZM-${randomUUID().slice(0, 4)}`, h.world.users.buyer.id])).rows[0]!.id;
});
afterAll(async () => { await h.close(); });

describe('048 sözleşme şeması', () => {
  it('template_document_kind_and_versions', async () => {
    const v = await h.owner.query<{ id: string }>(
      `INSERT INTO contract_template_versions (tenant_id, template_id, version_no, document_version_id, valid_from, uploaded_by) VALUES ($1, $2, 1, $3, '2026-11-01', $4) RETURNING id`,
      [h.world.tenantA, templateId, templateDocVersion, h.world.users.buyer.id]);
    // Aynı sürüm numarası ikinci kez olamaz.
    await expect(h.owner.query(`INSERT INTO contract_template_versions (tenant_id, template_id, version_no, document_version_id, valid_from, uploaded_by) VALUES ($1, $2, 1, $3, '2026-11-02', $4)`,
      [h.world.tenantA, templateId, templateDocVersion, h.world.users.buyer.id])).rejects.toThrow();
    // Aile alanları: proje, tür, sorumlu, imza tarihi, şablon sürümü, süresiz ve isteğe bağlı alanlar uygulama rolüyle güncellenebilir.
    const project = (await h.owner.query<{ id: string }>(`SELECT id FROM projects WHERE tenant_id = $1 LIMIT 1`, [h.world.tenantA])).rows[0]?.id ?? null;
    await withTenant(h.pool, ctxA(h.world.users.buyer.id, { all: true }), async (tx) => {
      await tx.query(`UPDATE contract_families SET project_id = $2, contract_type = 'SERVICE', owner_user_id = $3, signed_on = '2026-01-02', template_version_id = $4,
        indefinite = false, contract_no = 'SZ-1', governing_court = 'İstanbul (Çağlayan)', kvkk_clause = true, price_escalation = 'TÜFE' WHERE id = $1`,
        [c2.familyId, project, h.world.users.buyer.id, v.rows[0]!.id]);
    });
    const f = (await h.owner.query(`SELECT contract_type, indefinite, template_version_id FROM contract_families WHERE id = $1`, [c2.familyId])).rows[0];
    expect(f).toMatchObject({ contract_type: 'SERVICE', indefinite: false, template_version_id: v.rows[0]!.id });
    await expect(h.owner.query(`UPDATE contract_families SET contract_type = 'BOGUS' WHERE id = $1`, [c2.familyId])).rejects.toThrow();
    // Uygulama rolü başlık gibi başka aile sütunlarını güncelleyemez.
    await expect(withTenant(h.pool, ctxA(h.world.users.buyer.id, { all: true }), (tx) => tx.query(`UPDATE contract_families SET title = 'x' WHERE id = $1`, [c2.familyId])))
      .rejects.toThrow(/permission denied/);
  });

  it('new_tables_tenant_isolated', async () => {
    const ch = await chain(c2, h.world.users.legal.id);
    await h.owner.query(`INSERT INTO contract_approval_steps (tenant_id, chain_id, step_order, kind, assigned_user_id) VALUES ($1, $2, 1, 'PROCUREMENT_LEAD', $3)`,
      [h.world.tenantA, ch, h.world.users.buyer.id]);
    await h.owner.query(`INSERT INTO contract_reminders (tenant_id, family_id, terms_id, kind, offset_days, due_on) VALUES ($1, $2, $3, 'END', 90, '2026-10-02')`,
      [h.world.tenantA, c2.familyId, c2.termsId]);
    await h.owner.query(`INSERT INTO contract_reminder_settings (tenant_id, updated_by) VALUES ($1, $2) ON CONFLICT (tenant_id) DO NOTHING`, [h.world.tenantA, h.world.users.tenantAdmin.id]);
    await withTenant(h.pool, ctxA(h.world.users.buyer.id, { all: true }), (tx) => tx.query(
      `INSERT INTO email_outbox (tenant_id, to_user_id, to_email, subject, body_text, related_type, related_id, status) VALUES ($1, $2, 'alper@example.test', 'Onay bekleyen sözleşme', 'Sentetik gövde', 'contract_family', $3, 'NOT_CONFIGURED')`,
      [h.world.tenantA, h.world.users.buyer.id, c2.familyId]));
    const tables = ['contract_templates', 'contract_template_versions', 'contract_approval_chains', 'contract_approval_steps', 'contract_reminders', 'contract_reminder_settings', 'email_outbox'];
    const count = (ctx: TenantContext) => withTenant(h.pool, ctx, async (tx) => {
      const out: Record<string, number> = {};
      for (const t of tables) out[t] = (await tx.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${t} WHERE tenant_id = $1`, [h.world.tenantA])).rows[0]!.n;
      return out;
    });
    expect(all(await count(ctxB()), 0), 'başka kiracı görmemeli').toEqual([]);
    const own = await count(ctxA(h.world.users.buyer.id, { all: true }));
    expect(Object.entries(own).filter(([, n]) => n === 0).map(([k]) => k), 'kendi kiracısı görmeli').toEqual([]);
    const settings = (await h.owner.query<{ offsets: number[] }>(`SELECT offsets FROM contract_reminder_settings WHERE tenant_id = $1`, [h.world.tenantA])).rows[0]!;
    expect(settings.offsets).toEqual([90, 60, 30, 7]);
    // E-posta kuyruğu: uygulama yalnız gönderici sütunlarını güncelleyebilir, silemez.
    await withTenant(h.pool, ctxA(h.world.users.buyer.id, { all: true }), async (tx) => {
      await tx.query(`UPDATE email_outbox SET status = 'FAILED', error = 'kanal yok' WHERE related_id = $1`, [c2.familyId]);
    });
    await expect(withTenant(h.pool, ctxA(h.world.users.buyer.id, { all: true }), (tx) => tx.query(`UPDATE email_outbox SET subject = 'x' WHERE related_id = $1`, [c2.familyId])))
      .rejects.toThrow(/permission denied/);
    await expect(withTenant(h.pool, ctxA(h.world.users.buyer.id, { all: true }), (tx) => tx.query(`DELETE FROM email_outbox WHERE related_id = $1`, [c2.familyId])))
      .rejects.toThrow(/permission denied/);
    // Kapatılmamış zincirde ikinci açık zincir olamaz.
    await expect(chain(c2, h.world.users.legal.id)).rejects.toThrow();
    await h.owner.query(`UPDATE contract_approval_chains SET closed_at = now(), outcome = 'CANCELLED', cancel_reason = 'İçerik değişti, onay baştan (sentetik).' WHERE id = $1`, [ch]);
  });

  it('step_decision_written_once', async () => {
    const ch = await chain(c3, h.world.users.legal.id);
    const step = (await h.owner.query<{ id: string }>(`INSERT INTO contract_approval_steps (tenant_id, chain_id, step_order, kind, assigned_user_id) VALUES ($1, $2, 1, 'PROCUREMENT_DIRECTOR', $3) RETURNING id`,
      [h.world.tenantA, ch, h.world.users.buyer.id])).rows[0]!.id;
    const app = (sql: string) => withTenant(h.pool, ctxA(h.world.users.buyer.id, { all: true }), (tx) => tx.query(sql, [step]));
    // Kısa red gerekçesi kabul edilmez.
    await expect(app(`UPDATE contract_approval_steps SET decision = 'REJECTED', reason = 'kısa', decided_by = assigned_user_id, decided_at = now() WHERE id = $1`)).rejects.toThrow();
    await app(`UPDATE contract_approval_steps SET decision = 'APPROVED', decided_by = assigned_user_id, decided_at = now() WHERE id = $1`);
    await expect(app(`UPDATE contract_approval_steps SET decision = 'REJECTED', reason = 'Fikir değişti, sentetik gerekçe.', decided_at = now() WHERE id = $1`))
      .rejects.toThrow(/immutable_record/);
    await expect(app(`UPDATE contract_approval_steps SET assigned_user_id = decided_by WHERE id = $1`)).rejects.toThrow(/permission denied/);
    await expect(h.owner.query(`DELETE FROM contract_approval_steps WHERE id = $1`, [step])).rejects.toThrow(/immutable_record/);
    // Kapanmış zincir yeniden açılamaz.
    await h.owner.query(`UPDATE contract_approval_chains SET closed_at = now(), outcome = 'APPROVED' WHERE id = $1`, [ch]);
    await expect(h.owner.query(`UPDATE contract_approval_chains SET closed_at = NULL, outcome = NULL WHERE id = $1`, [ch])).rejects.toThrow(/immutable_record/);
    await expect(h.owner.query(`DELETE FROM contract_approval_chains WHERE id = $1`, [ch])).rejects.toThrow(/immutable_record/);
  });

  it('approver_sees_assigned_contract_only', async () => {
    const te = h.world.users.techEval.id;
    expect(all(await seenBy(te, c1), 0), 'atanmadan önce İK sözleşmesi gizli').toEqual([]);
    const ch = await chain(c1, h.world.users.legal.id);
    await h.owner.query(`INSERT INTO contract_approval_steps (tenant_id, chain_id, step_order, kind, assigned_user_id) VALUES ($1, $2, 1, 'EXTRA', $3)`,
      [h.world.tenantA, ch, te]);
    expect(all(await seenBy(te, c1), 1), 'adıma atanınca görür').toEqual([]);
    expect(all(await seenBy(te, c2), 0), 'İK\'nın başka sözleşmesi yine gizli').toEqual([]);
    // Onaycı aileyi okur ama departman alanını kendi kapsamı dışına yazamaz (salt okunur).
    await expect(withTenant(h.pool, ctxA(te, { departmentIds: [h.world.departments.bt] }), (tx) =>
      tx.query(`UPDATE contract_families SET contract_type = 'NDA' WHERE id = $1`, [c1.familyId]))).rejects.toThrow(/row-level security/);
    // Başka kiracının aynı kullanıcı kimliği bağlamında görünmez.
    const other = await withTenant(h.pool, { ...ctxB(), userId: te }, async (tx) => (await tx.query(`SELECT 1 FROM contract_families WHERE id = $1`, [c1.familyId])).rowCount);
    expect(other).toBe(0);
  });

  it('current_deputy_sees_open_department_head_step', async () => {
    const te = h.world.users.techEval.id;
    const ik = h.world.departments.ik;
    const ch = (await h.owner.query<{ id: string }>(`SELECT id FROM contract_approval_chains WHERE family_id = $1 AND closed_at IS NULL`, [c3.familyId])).rows[0]?.id
      ?? await chain(c3, h.world.users.legal.id);
    await h.owner.query(`INSERT INTO contract_approval_steps (tenant_id, chain_id, step_order, kind, department_id, assigned_user_id) VALUES ($1, $2, 10, 'DEPARTMENT_HEAD', $3, $4)`,
      [h.world.tenantA, ch, ik, h.world.users.legal2.id]);
    expect(all(await seenBy(te, c3), 0), 'vekil değilken gizli').toEqual([]);
    await h.owner.query(`INSERT INTO approver_assignments (tenant_id, kind, department_id, primary_user_id, deputy_user_id) VALUES ($1, 'DEPARTMENT_HEAD', $2, $3, $4)
      ON CONFLICT ON CONSTRAINT approver_assignments_unique DO UPDATE SET primary_user_id = EXCLUDED.primary_user_id, deputy_user_id = EXCLUDED.deputy_user_id`,
      [h.world.tenantA, ik, h.world.users.legal2.id, te]);
    expect(all(await seenBy(te, c3), 1), 'şu anki etkin vekil görür').toEqual([]);
    // Askıya alınan vekil (etkin değil) görmez.
    await h.owner.query(`UPDATE memberships SET status = 'SUSPENDED' WHERE tenant_id = $1 AND user_id = $2`, [h.world.tenantA, te]);
    try {
      expect(all(await seenBy(te, c3), 0), 'askıdaki vekil görmez').toEqual([]);
    } finally {
      await h.owner.query(`UPDATE memberships SET status = 'ACTIVE' WHERE tenant_id = $1 AND user_id = $2`, [h.world.tenantA, te]);
    }
    await h.owner.query(`DELETE FROM approver_assignments WHERE tenant_id = $1 AND kind = 'DEPARTMENT_HEAD' AND department_id = $2`, [h.world.tenantA, ik]);
  });

  it('renewal_decision_new_project', async () => {
    await h.owner.query(`INSERT INTO renewal_decisions (tenant_id, company_id, contract_version_id, terms_id, decision, rationale, decided_by)
      VALUES ($1, $2, $3, $4, 'NEW_PROJECT', 'Yeni proje açıldı; sentetik gerekçe.', $5)`,
      [h.world.tenantA, h.world.companyA1.id, c2.cvId, c2.termsId, h.world.users.buyer.id]);
  });
});
