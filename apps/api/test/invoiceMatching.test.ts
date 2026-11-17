// v2 Faz 7 (D112) Görev 3: fatura ↔ sözleşme eşleştirmesi (R1–R4): otomatik (ERP referansı, tedarikçi + tarih), Eşleşmedi kuyruğu,
// elle bağlama / bağ kaldırma, sözleşme ve proje faturaları, kullanım ve aşım görevi. Tüm veri sentetik ("(SENTETİK)", "SNT…" fatura no).
// Demo faturalar (ANB2026000101, ANB2026000102, EGE2026000877) kullanılmaz; 055 öncesi davranış auto_match = false sentetik satırlarla sınanır.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { syntheticVkn } from '@sp/domain';
import { ublInvoiceXml } from '../src/devdata.ts';
import { withTenant } from '../src/db.ts';
import { matchGuardError } from '../src/modules/invoiceMatching.ts';
import { makeHarness } from './harness.ts';

let h: Awaited<ReturnType<typeof makeHarness>>;
const rand = () => randomUUID().slice(0, 8);
const one = async <T = any>(sql: string, params: unknown[] = []) => (await h.owner.query(sql, params)).rows[0] as T;
const rows = async <T = any>(sql: string, params: unknown[] = []) => (await h.owner.query(sql, params)).rows as T[];

beforeAll(async () => {
  h = await makeHarness();
  // techEval: İK departman kullanıcısı (security BT'de kalır).
  await h.owner.query(`UPDATE memberships SET department_ids = $3 WHERE tenant_id = $1 AND user_id = $2`, [h.world.tenantA, h.world.users.techEval.id, [h.world.departments.ik]]);
});
afterAll(async () => { await h.close(); });

type Who = 'finance' | 'buyer' | 'security' | 'techEval' | 'auditor' | 'legal';
const call = (who: Who, method: string, url: string, body?: unknown) => h.call(who, method, url, body === undefined ? {} : { body });

async function supplier() {
  return (await one<{ id: string }>(`INSERT INTO suppliers (tenant_id, status, country, tax_id_type, tax_id, legal_name, created_by, activated_by, activated_at)
    VALUES ($1,'ACTIVE','TR','VKN',$2,$3,$4,$5,now()) RETURNING id`,
    [h.world.tenantA, syntheticVkn(String(Math.floor(Math.random() * 9e8) + 1e8)), `Eşleşme Tedarikçi ${rand()} (SENTETİK)`, h.world.users.buyer.id, h.world.users.masterData.id])).id;
}

/** Sentetik sözleşme ailesi (zorunlu alanlar dolu). chain: APPROVED (yürürlükte), OPEN (onayda), NONE + legacy (eski kayıt). */
async function contract(o: { supplierId: string; department?: string | null; start?: string; end?: string; amount?: string; contractNo?: string | null;
  chain?: 'APPROVED' | 'OPEN' | 'LEGACY'; owner?: string; basis?: 'NET' | 'GROSS' }) {
  const w = h.world;
  const company = w.companyA1.id;
  const department = o.department === undefined ? w.departments.bt : o.department;
  const owner = o.owner ?? w.users.buyer.id;
  const projectId = (await one<{ id: string }>(`INSERT INTO projects (tenant_id, company_id, code, title, category, owner_user_id, created_by, department_id)
    VALUES ($1,$2,$3,'Eşleşme projesi (SENTETİK)','Genel',$4,$4,$5) RETURNING id`, [w.tenantA, company, `PRJ-IM-${rand()}`, w.users.buyer.id, department])).id;
  const doc = (await one<{ id: string }>(`INSERT INTO documents (tenant_id, company_id, kind, title, created_by, code) VALUES ($1,$2,'CONTRACT',$3,$4,$5) RETURNING id`,
    [w.tenantA, company, `Eşleşme sözleşmesi ${rand()} (SENTETİK)`, w.users.buyer.id, `BLG-IM-${rand()}`])).id;
  const dv = (await one<{ id: string }>(`INSERT INTO document_versions (tenant_id, company_id, document_id, version_no, sha256, mime_type, size_bytes, storage_key,
      original_filename, basic_check_status, created_by) VALUES ($1,$2,$3,1,$4,'application/pdf',100,$5,'sozlesme.pdf','PASSED',$6) RETURNING id`,
    [w.tenantA, company, doc, 'e'.repeat(64), `tenant/${randomUUID()}`, w.users.buyer.id])).id;
  const code = `SZL-IM-${rand()}`;
  const familyId = (await one<{ id: string }>(`INSERT INTO contract_families (tenant_id, company_id, title, supplier_id, created_by, code, department_id, intake_flow,
      project_id, contract_type, owner_user_id, signed_on, contract_no) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'SERVICE',$10,'2026-01-01',$11) RETURNING id`,
    [w.tenantA, company, `Eşleşme sözleşmesi ${rand()} (SENTETİK)`, o.supplierId, w.users.buyer.id, code, department, o.chain !== 'LEGACY', projectId, owner,
      o.contractNo ?? null])).id;
  const cvId = (await one<{ id: string }>(`INSERT INTO contract_versions (tenant_id, company_id, family_id, version_no, document_version_id, created_by)
    VALUES ($1,$2,$3,1,$4,$5) RETURNING id`, [w.tenantA, company, familyId, dv, w.users.buyer.id])).id;
  const termsId = (await one<{ id: string }>(`INSERT INTO contract_terms (tenant_id, company_id, contract_version_id, revision, currency, value_type, amount,
      start_date, end_date, source_ref, entered_by, limit_basis) VALUES ($1,$2,$3,1,'TRY','FIXED',$4,$5,$6,'Madde 1 (sentetik)',$7,$8) RETURNING id`,
    [w.tenantA, company, cvId, o.amount ?? '100000.00', o.start ?? '2026-01-01', o.end ?? '2026-12-31', w.users.buyer.id, o.basis ?? 'NET'])).id;
  if (o.chain !== 'LEGACY') {
    const c = (await one<{ id: string }>(`INSERT INTO contract_approval_chains (tenant_id, family_id, version_id, terms_id, submitted_by) VALUES ($1,$2,$3,$4,$5) RETURNING id`,
      [w.tenantA, familyId, cvId, termsId, w.users.buyer.id])).id;
    if ((o.chain ?? 'APPROVED') === 'APPROVED') await h.owner.query(`UPDATE contract_approval_chains SET closed_at = now(), outcome = 'APPROVED' WHERE id = $1`, [c]);
  }
  return { familyId, cvId, projectId, code, department };
}

async function invoice(supplierId: string, o: { date?: string; net?: string; contractRef?: string; orderRef?: string; kind?: string; originalId?: string; tax?: string } = {}) {
  const net = o.net ?? '1000.00';
  const r = await call('finance', 'POST', '/api/v1/invoices', { companyId: h.world.companyA1.id, supplierId, kind: o.kind ?? 'INVOICE', invoiceNo: `SNT${rand()}`,
    issueDate: o.date ?? '2026-06-15', currency: 'TRY', ...(o.originalId ? { originalInvoiceId: o.originalId } : {}),
    ...(o.contractRef ? { erpContractRef: o.contractRef } : {}), ...(o.orderRef ? { erpOrderRef: o.orderRef } : {}),
    lines: [{ description: 'Hizmet bedeli (SENTETİK)', quantity: '1', unit: 'adet', unitPrice: net, netAmount: net, taxRate: '20', ...(o.tax ? { taxAmount: o.tax } : {}) }] });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return r.body as { id: string; match: { state: string; method?: string; familyId?: string; reason?: string } };
}
const inv = (id: string) => one(`SELECT contract_family_id, project_id, department_id, match_method, matched_by, matched_at, match_note, auto_match,
  erp_contract_ref, erp_contract_ref_source, erp_order_ref, erp_order_ref_source FROM invoices WHERE id = $1`, [id]);
const events = (id: string) => rows<{ action: string; family_id: string | null; method: string | null; reason: string | null; actor: string | null }>(
  `SELECT action, family_id, method, reason, actor FROM invoice_match_events WHERE invoice_id = $1 ORDER BY at, id`, [id]);
const tasks = (prefix: string) => rows<{ status: string; assignee_role: string; department_id: string | null; kind: string; dedupe_key: string; assignee_user_id: string | null }>(
  `SELECT status, assignee_role, department_id, kind, dedupe_key, assignee_user_id FROM tasks WHERE tenant_id = $1 AND dedupe_key LIKE $2 ORDER BY created_at, dedupe_key`,
  [h.world.tenantA, `${prefix}%`]);

describe('otomatik eşleştirme (R2)', () => {
  it('ERP sözleşme referansı (kod ve sözleşme no) → aile, proje ve departman sözleşmeden; olay ve kaynak yazılır', async () => {
    const s = await supplier();
    const c = await contract({ supplierId: s, contractNo: `NO-${rand()}` });
    await contract({ supplierId: s }); // aynı tedarikçinin ikinci aktif sözleşmesi: tarih yolu belirsiz olurdu, referans kazanır
    const a = await invoice(s, { contractRef: c.code });
    expect(a.match).toMatchObject({ state: 'MATCHED', method: 'ERP_REF', familyId: c.familyId });
    expect(await inv(a.id)).toMatchObject({ contract_family_id: c.familyId, project_id: c.projectId, department_id: h.world.departments.bt, match_method: 'ERP_REF',
      matched_by: null, auto_match: true, erp_contract_ref: c.code, erp_contract_ref_source: 'MANUAL', erp_order_ref: null, erp_order_ref_source: null });
    expect(await events(a.id)).toEqual([{ action: 'LINK', family_id: c.familyId, method: 'ERP_REF', reason: null, actor: null }]);
    expect((await rows(`SELECT 1 FROM audit_events WHERE entity_id = $1 AND action = 'invoice.matched'`, [a.id])).length).toBe(1);

    const no = (await one<{ contract_no: string }>(`SELECT contract_no FROM contract_families WHERE id = $1`, [c.familyId])).contract_no;
    const b = await invoice(s, { contractRef: no });
    expect(b.match).toMatchObject({ state: 'MATCHED', method: 'ERP_REF', familyId: c.familyId });

    const d = await call('finance', 'GET', `/api/v1/invoices/${a.id}`);
    expect(d.status).toBe(200);
    expect(d.body.match).toMatchObject({ state: 'MATCHED', stateLabel: 'Eşleşti', method: 'ERP_REF', methodLabel: 'ERP referansı', autoMatch: true,
      contract: { id: c.familyId, code: c.code }, project: { id: c.projectId }, erpContractRef: c.code, lastAutoFailure: null });
    expect(d.body.match.usage).toMatchObject({ amount: '100000.00', used: '2000.00', level: 'OK', levelLabel: 'Sınır içinde', warning: null });
    expect(d.body.can.match).toBe(true);
    // Eski detay alanları aynen.
    expect(d.body).toHaveProperty('check');
    expect(d.body).toHaveProperty('checkFingerprint');
  });

  it('ERP sipariş referansı → siparişin sözleşme ailesi', async () => {
    const s = await supplier();
    const c = await contract({ supplierId: s });
    const code = `PO-IM-${rand()}`;
    await h.owner.query(`INSERT INTO purchase_orders (tenant_id, company_id, code, supplier_id, contract_version_id, currency, issued_by) VALUES ($1,$2,$3,$4,$5,'TRY',$6)`,
      [h.world.tenantA, h.world.companyA1.id, code, s, c.cvId, h.world.users.buyer.id]);
    const a = await invoice(s, { orderRef: code });
    expect(a.match).toMatchObject({ state: 'MATCHED', method: 'ERP_REF', familyId: c.familyId });
    expect(await inv(a.id)).toMatchObject({ erp_order_ref: code, erp_order_ref_source: 'MANUAL' });
  });

  it('referans başka tedarikçinin sözleşmesi → ref_supplier_mismatch; bulunamayan referans tarih yoluna düşmez → ref_not_found', async () => {
    const s = await supplier();
    const other = await supplier();
    const oc = await contract({ supplierId: other });
    await contract({ supplierId: s }); // tek aktif: tarih yolu eşleşirdi
    const a = await invoice(s, { contractRef: oc.code });
    expect(a.match).toMatchObject({ state: 'UNMATCHED', reason: 'ref_supplier_mismatch' });
    expect((await inv(a.id)).contract_family_id).toBeNull();
    expect(await events(a.id)).toEqual([{ action: 'AUTO_FAILED', family_id: null, method: null, reason: 'ref_supplier_mismatch', actor: null }]);
    const b = await invoice(s, { contractRef: `YOK-${rand()}` });
    expect(b.match).toMatchObject({ state: 'UNMATCHED', reason: 'ref_not_found' });
    const d = await call('finance', 'GET', `/api/v1/invoices/${b.id}`);
    expect(d.body.match).toMatchObject({ state: 'UNMATCHED', stateLabel: 'Eşleşmedi', contract: null, lastAutoFailure: { reason: 'ref_not_found', reasonLabel: 'ERP referansı hiçbir sözleşme ya da siparişle eşleşmedi' } });
  });

  it('tedarikçi + tarih: tek yürürlükte sözleşme → SUPPLIER_DATE; aralık dışı, onaydaki ya da eski kayıt sözleşme kuralları', async () => {
    const s = await supplier();
    const c = await contract({ supplierId: s, start: '2026-01-01', end: '2026-06-30' });
    await contract({ supplierId: s, chain: 'OPEN', start: '2026-01-01', end: '2026-12-31' }); // onayda: sayılmaz
    const a = await invoice(s, { date: '2026-03-01' });
    expect(a.match).toMatchObject({ state: 'MATCHED', method: 'SUPPLIER_DATE', familyId: c.familyId });
    const late = await invoice(s, { date: '2026-08-01' });
    expect(late.match).toMatchObject({ state: 'UNMATCHED', reason: 'no_active_contract' });

    const s2 = await supplier();
    const legacy = await contract({ supplierId: s2, chain: 'LEGACY' });
    const l = await invoice(s2);
    expect(l.match).toMatchObject({ state: 'MATCHED', method: 'SUPPLIER_DATE', familyId: legacy.familyId });
  });

  it('iade/alacak belgesi özgün faturanın eşleşmesini izler', async () => {
    const s = await supplier();
    const c = await contract({ supplierId: s });
    const a = await invoice(s);
    expect(a.match.state).toBe('MATCHED');
    const cn = await invoice(s, { kind: 'CREDIT_NOTE', originalId: a.id, net: '100.00', date: '2027-02-01' }); // tarih aralık dışında olsa da özgünü izler
    expect(cn.match).toMatchObject({ state: 'MATCHED', method: 'SUPPLIER_DATE', familyId: c.familyId });
    expect((await inv(cn.id)).match_note).toContain('eşleşmesini izler');
  });
});

describe('Eşleşmedi kuyruğu ve elle bağlama (R3)', () => {
  it('iki aktif sözleşme → kuyruk + Satınalma görevi (+ departman görevi); elle bağlanınca görevler kapanır, liste süzgeci ve sayaçlar', async () => {
    const s = await supplier();
    const c1 = await contract({ supplierId: s });
    const c2 = await contract({ supplierId: s });
    const a = await invoice(s);
    expect(a.match).toMatchObject({ state: 'UNMATCHED', reason: 'multiple_active_contracts' });
    expect(await tasks(`invoice-unmatched:${a.id}`)).toEqual([expect.objectContaining({ status: 'OPEN', assignee_role: 'PROCUREMENT', kind: 'invoice_unmatched', department_id: null })]);

    const list = await call('finance', 'GET', '/api/v1/invoices?match=UNMATCHED');
    expect(list.status).toBe(200);
    const row = list.body.items.find((x: any) => x.id === a.id);
    expect(row).toMatchObject({ matchState: 'UNMATCHED', matchStateLabel: 'Eşleşmedi', contract: null, project: null, matched: false, blocked: expect.any(Boolean) });
    expect(row).toHaveProperty('departmentId');
    expect(list.body.items.every((x: any) => x.matchState === 'UNMATCHED')).toBe(true);
    expect(list.body.counts.unmatched).toBeGreaterThanOrEqual(1);
    expect(list.body.counts.all).toBe(list.body.counts.matched + list.body.counts.unmatched);
    expect(list.body.can).toEqual({ match: true, retryQueue: true });

    const cand = await call('finance', 'GET', `/api/v1/invoices/${a.id}/match-candidates`);
    expect(cand.status).toBe(200);
    expect(cand.body.items.map((x: any) => x.familyId).sort()).toEqual([c1.familyId, c2.familyId].sort());
    expect(cand.body.items[0]).toMatchObject({ active: true, inRange: true, canLink: true, statusLabel: 'Yürürlükte', usage: { level: 'OK' } });

    const r = await call('finance', 'POST', `/api/v1/invoices/${a.id}/match`, { familyId: c2.familyId, note: 'Hizmet dönemi ikinci sözleşmeye ait (SENTETİK).' });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body).toMatchObject({ state: 'MATCHED', method: 'MANUAL', methodLabel: 'Elle', contract: { id: c2.familyId } });
    expect(await inv(a.id)).toMatchObject({ contract_family_id: c2.familyId, project_id: c2.projectId, match_method: 'MANUAL', matched_by: h.world.users.finance.id });
    expect((await tasks(`invoice-unmatched:${a.id}`)).map((t) => t.status)).toEqual(['DONE']);
    expect((await events(a.id)).map((e) => e.action)).toEqual(['AUTO_FAILED', 'LINK']);

    const matched = await call('finance', 'GET', '/api/v1/invoices?match=MATCHED');
    expect(matched.body.items.find((x: any) => x.id === a.id)).toMatchObject({ matchState: 'MATCHED', contract: { id: c2.familyId, code: c2.code }, project: { id: c2.projectId } });
    // Bağlı faturaya ikinci bağ yok.
    expect((await call('finance', 'POST', `/api/v1/invoices/${a.id}/match`, { familyId: c1.familyId })).body.error.code).toBe('invoice_already_matched');
  });

  it('tarih aralığı dışı onay ister; başka tedarikçinin sözleşmesi 422', async () => {
    const s = await supplier();
    const c = await contract({ supplierId: s, start: '2026-01-01', end: '2026-03-31' });
    const a = await invoice(s, { date: '2026-09-01' });
    expect(a.match.state).toBe('UNMATCHED');
    const no = await call('finance', 'POST', `/api/v1/invoices/${a.id}/match`, { familyId: c.familyId });
    expect(no.status).toBe(422);
    expect(no.body.error.code).toBe('out_of_range_ack_required');
    expect(no.body.error.message).toContain('01.09.2026');
    const other = await contract({ supplierId: await supplier() });
    const mis = await call('finance', 'POST', `/api/v1/invoices/${a.id}/match`, { familyId: other.familyId, acknowledgeOutOfRange: true });
    expect(mis.status).toBe(422);
    expect(mis.body.error.code).toBe('contract_supplier_mismatch');
    const ok = await call('finance', 'POST', `/api/v1/invoices/${a.id}/match`, { familyId: c.familyId, acknowledgeOutOfRange: true });
    expect(ok.status).toBe(200);
  });

  it('Departman kullanıcısı kendi departman faturasını kendi sözleşmesine bağlar; başka departmanın faturası/sözleşmesi 404, izin yoksa 403', async () => {
    const s = await supplier();
    const bt1 = await contract({ supplierId: s, department: h.world.departments.bt });
    await contract({ supplierId: s, department: h.world.departments.bt });
    const ik = await contract({ supplierId: s, department: h.world.departments.ik });
    const a = await invoice(s);
    const b = await invoice(s);
    expect(a.match.state).toBe('UNMATCHED');
    await h.owner.query(`UPDATE invoices SET department_id = $2 WHERE id = ANY($1::uuid[])`, [[a.id, b.id], h.world.departments.bt]);

    // İK kullanıcısı BT faturasını göremez.
    expect((await call('techEval', 'GET', `/api/v1/invoices/${a.id}`)).status).toBe(404);
    expect((await call('techEval', 'POST', `/api/v1/invoices/${a.id}/match`, { familyId: ik.familyId })).status).toBe(404);
    // BT kullanıcısı İK sözleşmesini göremez, bağlayamaz.
    const cand = await call('security', 'GET', `/api/v1/invoices/${a.id}/match-candidates`);
    expect(cand.status).toBe(200);
    expect(cand.body.items.map((x: any) => x.familyId)).not.toContain(ik.familyId);
    expect((await call('security', 'POST', `/api/v1/invoices/${b.id}/match`, { familyId: ik.familyId })).status).toBe(404);
    expect((await inv(b.id)).contract_family_id).toBeNull();
    // Denetçinin eşleştirme izni yok.
    expect((await call('auditor', 'POST', `/api/v1/invoices/${a.id}/match`, { familyId: bt1.familyId })).status).toBe(403);

    const r = await call('security', 'POST', `/api/v1/invoices/${a.id}/match`, { familyId: bt1.familyId });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(await inv(a.id)).toMatchObject({ contract_family_id: bt1.familyId, department_id: h.world.departments.bt, match_method: 'MANUAL', matched_by: h.world.users.security.id });
  });

  it('tahsisli faturaya 409 invoice_allocated; elle bağlı faturaya tahsis 409 invoice_matched; otomatik bağ tahsisle gerekçeli kalkar', async () => {
    const s = await supplier();
    const c = await contract({ supplierId: s });
    const other = await contract({ supplierId: s, start: '2025-01-01', end: '2025-12-31' });
    // Tahsisli fatura: tarih dışı → bağsız; tahsis girilir.
    const a = await invoice(s, { date: '2027-03-01' });
    expect(a.match.state).toBe('UNMATCHED');
    const put = await call('finance', 'PUT', `/api/v1/invoices/${a.id}/allocations`, { allocations: [{ lineNo: 1, poLineId: null, contractVersionId: c.cvId, quantity: '1', amount: '1000.00' }] });
    expect(put.status, JSON.stringify(put.body)).toBe(200);
    const linkAlloc = await call('finance', 'POST', `/api/v1/invoices/${a.id}/match`, { familyId: c.familyId, acknowledgeOutOfRange: true });
    expect(linkAlloc.status).toBe(409);
    expect(linkAlloc.body.error.code).toBe('invoice_allocated');
    expect((await call('finance', 'GET', `/api/v1/invoices/${a.id}`)).body.match).toMatchObject({ state: 'ALLOCATED', stateLabel: 'Tahsisle (eski kayıt)', contract: { id: c.familyId } });
    // Tahsisli fatura yeniden denemede atlanır.
    await call('finance', 'POST', '/api/v1/invoices/match-queue/retry');
    expect((await inv(a.id)).contract_family_id).toBeNull();

    // Elle bağlı fatura → tahsis 409 invoice_matched (Türkçe ileti), bağ kalır.
    const b = await invoice(s, { date: '2027-03-02' });
    expect((await call('finance', 'POST', `/api/v1/invoices/${b.id}/match`, { familyId: other.familyId, acknowledgeOutOfRange: true })).status).toBe(200);
    const putB = await call('finance', 'PUT', `/api/v1/invoices/${b.id}/allocations`, { allocations: [{ lineNo: 1, poLineId: null, contractVersionId: c.cvId, quantity: '1', amount: '1000.00' }] });
    expect(putB.status).toBe(409);
    expect(putB.body.error.code).toBe('invoice_matched');
    expect(putB.body.error.message).toContain('eşleşmeyi gerekçesiyle kaldırın');
    expect((await inv(b.id)).contract_family_id).toBe(other.familyId);

    // Otomatik bağ → tahsis aynı işlemde bağı kaldırır (UNLINK olayı), eşleşme tahsisten türer.
    const d = await invoice(s);
    expect(d.match.state).toBe('MATCHED');
    const putD = await call('finance', 'PUT', `/api/v1/invoices/${d.id}/allocations`, { allocations: [{ lineNo: 1, poLineId: null, contractVersionId: c.cvId, quantity: '1', amount: '1000.00' }] });
    expect(putD.status, JSON.stringify(putD.body)).toBe(200);
    expect(await inv(d.id)).toMatchObject({ contract_family_id: null, project_id: null, match_method: null, matched_by: null, matched_at: null });
    expect((await events(d.id)).map((e) => e.action)).toEqual(['LINK', 'UNLINK']);
  });

  it('bağ kaldırma gerekçesiz 422; gerekçeyle beş sütun birlikte boşalır, kuyruk görevi açılır, yeniden deneme elle kaldırılanı bağlamaz', async () => {
    const s = await supplier();
    const c = await contract({ supplierId: s });
    const a = await invoice(s);
    expect(a.match.state).toBe('MATCHED');
    expect((await call('finance', 'DELETE', `/api/v1/invoices/${a.id}/match`, { reason: 'kısa' })).status).toBe(422);
    expect((await call('finance', 'DELETE', `/api/v1/invoices/${a.id}/match`, { reason: '          ' })).body.error.code).toBe('reason_required');
    expect((await inv(a.id)).contract_family_id).toBe(c.familyId);
    const r = await call('finance', 'DELETE', `/api/v1/invoices/${a.id}/match`, { reason: 'Fatura başka hizmet dönemine ait (SENTETİK).' });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body).toMatchObject({ state: 'UNMATCHED', method: null, contract: null, project: null });
    expect(await inv(a.id)).toMatchObject({ contract_family_id: null, project_id: null, match_method: null, matched_by: null, matched_at: null, match_note: null,
      department_id: h.world.departments.bt });
    expect((await events(a.id)).at(-1)).toMatchObject({ action: 'UNLINK', family_id: c.familyId, reason: 'Fatura başka hizmet dönemine ait (SENTETİK).', actor: h.world.users.finance.id });
    expect((await tasks(`invoice-unmatched:${a.id}`)).filter((t) => t.status === 'OPEN').length).toBeGreaterThanOrEqual(1);
    const retry = await call('finance', 'POST', '/api/v1/invoices/match-queue/retry');
    expect(retry.status).toBe(200);
    expect(retry.body).toMatchObject({ checked: expect.any(Number), matched: expect.any(Number), unmatched: expect.any(Number), skipped: expect.any(Number) });
    expect((await inv(a.id)).contract_family_id).toBeNull();
    expect((await call('finance', 'DELETE', `/api/v1/invoices/${a.id}/match`, { reason: 'Tekrar kaldırma denemesi (SENTETİK).' })).body.error.code).toBe('invoice_not_matched');
    // Departman kullanıcısının yeniden deneme izni yok.
    expect((await call('security', 'POST', '/api/v1/invoices/match-queue/retry')).status).toBe(403);
  });

  it('yeniden dene: sözleşme sonradan eklenince kuyruktaki fatura bağlanır, görev kapanır; aynı sebeple ikinci AUTO_FAILED yazılmaz', async () => {
    const s = await supplier();
    const a = await invoice(s);
    expect(a.match).toMatchObject({ state: 'UNMATCHED', reason: 'no_active_contract' });
    await call('finance', 'POST', '/api/v1/invoices/match-queue/retry');
    expect((await events(a.id)).map((e) => e.action)).toEqual(['AUTO_FAILED']);
    const c = await contract({ supplierId: s });
    const r = await call('finance', 'POST', '/api/v1/invoices/match-queue/retry');
    expect(r.body.matched).toBeGreaterThanOrEqual(1);
    expect((await inv(a.id)).contract_family_id).toBe(c.familyId);
    expect((await tasks(`invoice-unmatched:${a.id}`)).map((t) => t.status)).toEqual(['DONE']);
  });
});

describe('sözleşme ve proje faturaları, kullanım ve aşım (R4)', () => {
  it('kullanım: %90 sınıra yakın, aşımda bir kez görev + e-posta; sözleşme ve proje uçları', async () => {
    const s = await supplier();
    const c = await contract({ supplierId: s, amount: '1000.00', owner: h.world.users.legal.id });
    const a = await invoice(s, { net: '950.00' });
    expect(a.match.state).toBe('MATCHED');
    let r = await call('legal', 'GET', `/api/v1/contracts/${c.familyId}/invoices`);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.usage).toMatchObject({ amount: '1000.00', used: '950.00', level: 'NEAR', levelLabel: 'Sınıra yakın', warning: 'Sınıra yakın', basis: 'NET' });
    expect(r.body.items).toEqual([expect.objectContaining({ id: a.id, amount: '950.00', matchState: 'MATCHED', matchMethod: 'SUPPLIER_DATE', matchMethodLabel: 'Tedarikçi ve tarih',
      status: 'PENDING', statusLabel: 'Karar bekliyor', currency: 'TRY', date: '2026-06-15', supplier: expect.objectContaining({ id: s }) })]);
    expect(await tasks(`overrun:${c.familyId}`)).toEqual([]);

    await invoice(s, { net: '100.00' });
    r = await call('legal', 'GET', `/api/v1/contracts/${c.familyId}/invoices`);
    expect(r.body.usage).toMatchObject({ used: '1050.00', level: 'OVER', overBy: '50.00' });
    expect(r.body.usage.warning).toMatch(/^Aşım: 50,00 ₺$/);
    const t = await tasks(`overrun:${c.familyId}`);
    expect(t).toEqual([expect.objectContaining({ kind: 'contract_overrun', status: 'OPEN', assignee_user_id: h.world.users.legal.id })]);
    const mails = await rows(`SELECT status, related_type FROM email_outbox WHERE related_id = $1`, [c.familyId]);
    expect(mails).toEqual([{ status: 'NOT_CONFIGURED', related_type: 'contract_family' }]);
    // Görev kapansa da ikinci aşım yeni görev/e-posta açmaz ("bir kez").
    await h.owner.query(`UPDATE tasks SET status = 'DONE', closed_at = now() WHERE tenant_id = $1 AND dedupe_key = $2`, [h.world.tenantA, `overrun:${c.familyId}`]);
    await invoice(s, { net: '10.00' });
    expect((await tasks(`overrun:${c.familyId}`)).length).toBe(1);
    expect((await rows(`SELECT 1 FROM email_outbox WHERE related_id = $1`, [c.familyId])).length).toBe(1);

    // İade düşer; USD fatura toplama girmez, ayrı listelenir.
    await invoice(s, { kind: 'CREDIT_NOTE', originalId: a.id, net: '60.00' });
    const usd = await call('finance', 'POST', '/api/v1/invoices', { companyId: h.world.companyA1.id, supplierId: s, kind: 'INVOICE', invoiceNo: `SNT${rand()}`, issueDate: '2026-06-15',
      currency: 'USD', lines: [{ description: 'Lisans (SENTETİK)', quantity: '1', unit: 'adet', unitPrice: '40.00', netAmount: '40.00' }] });
    expect(usd.body.match.state).toBe('MATCHED');
    r = await call('legal', 'GET', `/api/v1/contracts/${c.familyId}/invoices`);
    expect(r.body.usage).toMatchObject({ used: '1000.00', level: 'NEAR' });
    expect(r.body.usage.foreignCurrency).toEqual([expect.objectContaining({ currency: 'USD', total: '40.00' })]);

    const p = await call('buyer', 'GET', `/api/v1/projects/${c.projectId}/invoices`);
    expect(p.status, JSON.stringify(p.body)).toBe(200);
    expect(p.body.usage).toEqual([expect.objectContaining({ contract: expect.objectContaining({ id: c.familyId, code: c.code }), usage: expect.objectContaining({ used: '1000.00' }) })]);
    expect(p.body.items.length).toBe(5);
    expect(p.body.items.every((x: any) => x.contract.id === c.familyId)).toBe(true);
    // Başka departmanın projesi İK kullanıcısına 404.
    expect((await call('techEval', 'GET', `/api/v1/projects/${c.projectId}/invoices`)).status).toBe(404);
  });

  it('Departman kullanıcısının elle bağlaması aşıma yol açınca başka departmandaki sorumluya görev ve e-posta yazılır', async () => {
    const s = await supplier();
    const c = await contract({ supplierId: s, amount: '500.00', owner: h.world.users.legal.id });
    await contract({ supplierId: s });
    const a = await invoice(s, { net: '600.00' });
    expect(a.match.state).toBe('UNMATCHED');
    await h.owner.query(`UPDATE invoices SET department_id = $2 WHERE id = $1`, [a.id, h.world.departments.bt]);
    const r = await call('security', 'POST', `/api/v1/invoices/${a.id}/match`, { familyId: c.familyId });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.usage).toMatchObject({ level: 'OVER', overBy: '100.00' });
    expect(await tasks(`overrun:${c.familyId}`)).toEqual([expect.objectContaining({ assignee_user_id: h.world.users.legal.id, department_id: null })]);
    expect((await rows(`SELECT 1 FROM email_outbox WHERE related_id = $1`, [c.familyId])).length).toBe(1);
  });

  it('vergi dahil (GROSS) limitte KDV katılır; tahsisle türeyen fatura da sayılır', async () => {
    const s = await supplier();
    const c = await contract({ supplierId: s, amount: '10000.00', basis: 'GROSS' });
    await invoice(s, { net: '1000.00' }); // KDV %20 → 1200
    const late = await invoice(s, { net: '500.00', date: '2027-05-01' });
    expect(late.match.state).toBe('UNMATCHED');
    expect((await call('finance', 'PUT', `/api/v1/invoices/${late.id}/allocations`, { allocations: [{ lineNo: 1, poLineId: null, contractVersionId: c.cvId, quantity: '1', amount: '500.00' }] })).status).toBe(200);
    const r = await call('legal', 'GET', `/api/v1/contracts/${c.familyId}/invoices`);
    expect(r.body.usage).toMatchObject({ basis: 'GROSS', used: '1800.00', level: 'OK' });
    expect(r.body.items.map((x: any) => x.matchState).sort()).toEqual(['ALLOCATED', 'MATCHED']);
  });
});

describe('Review Focus 1: 055 öncesi, tahsisli ve kararlı faturalar değişmez', () => {
  it('auto_match = false faturalar (tahsisli+kararlı ve tahsissiz) yeniden deneme ve yeni fatura girişinden sonra satır satır aynı', async () => {
    const s = await supplier();
    const c = await contract({ supplierId: s });
    const w = h.world;
    // 055 öncesi açılmış faturaların sentetik eşleri: auto_match = false (sahip bağlantısıyla; migration bu satırları güncellemez).
    const pre = async (no: string) => (await one<{ id: string }>(`INSERT INTO invoices (tenant_id, company_id, supplier_id, kind, invoice_no, issue_date, currency, created_by, auto_match)
      VALUES ($1,$2,$3,'INVOICE',$4,'2026-06-10','TRY',$5,false) RETURNING id`, [w.tenantA, w.companyA1.id, s, no, w.users.finance.id])).id;
    const allocated = await pre(`PRE055A${rand()}`);
    const plain = await pre(`PRE055B${rand()}`);
    for (const id of [allocated, plain]) {
      await h.owner.query(`INSERT INTO invoice_lines (tenant_id, company_id, invoice_id, line_no, description, quantity, unit, unit_price, net_amount, tax_rate)
        VALUES ($1,$2,$3,1,'Eski kayıt (SENTETİK)',1,'adet',500,500,20)`, [w.tenantA, w.companyA1.id, id]);
    }
    await h.owner.query(`INSERT INTO invoice_allocations (tenant_id, company_id, invoice_id, line_no, contract_version_id, quantity, amount, created_by)
      VALUES ($1,$2,$3,1,$4,1,500,$5)`, [w.tenantA, w.companyA1.id, allocated, c.cvId, w.users.finance.id]);
    await h.owner.query(`INSERT INTO invoice_decisions (tenant_id, company_id, invoice_id, kind, check_hash, decided_by) VALUES ($1,$2,$3,'APPROVAL','-',$4)`,
      [w.tenantA, w.companyA1.id, allocated, w.users.finance2.id]);
    // Kararlı ama auto_match = true (055 sonrası) fatura da eşleştirilmez.
    const decided = await invoice(s, { date: '2027-01-15' });
    await h.owner.query(`INSERT INTO invoice_decisions (tenant_id, company_id, invoice_id, kind, check_hash, reason, decided_by) VALUES ($1,$2,$3,'REJECTION','-','Sentetik ret gerekçesi',$4)`,
      [w.tenantA, w.companyA1.id, decided.id, w.users.finance2.id]);
    await h.owner.query(`UPDATE contract_terms SET end_date = '2027-12-31' WHERE contract_version_id = $1`, [c.cvId]); // artık tarih yolu eşleştirirdi

    const watched = [allocated, plain, decided.id];
    const demo = (await rows<{ id: string }>(`SELECT id FROM invoices WHERE invoice_no IN ('ANB2026000101','ANB2026000102','EGE2026000877')`)).map((r) => r.id);
    const ids = [...watched, ...demo, ...(await rows<{ id: string }>(`SELECT id FROM invoices WHERE tenant_id = $1 AND NOT auto_match`, [w.tenantA])).map((r) => r.id)];
    const snap = async () => JSON.stringify({
      i: await rows(`SELECT * FROM invoices WHERE id = ANY($1::uuid[]) ORDER BY id`, [ids]),
      a: await rows(`SELECT * FROM invoice_allocations WHERE invoice_id = ANY($1::uuid[]) ORDER BY id`, [ids]),
      d: await rows(`SELECT * FROM invoice_decisions WHERE invoice_id = ANY($1::uuid[]) ORDER BY id`, [ids]),
      e: await rows(`SELECT * FROM invoice_match_events WHERE invoice_id = ANY($1::uuid[]) ORDER BY id`, [ids]),
      t: await rows(`SELECT id, status, department_id FROM tasks WHERE entity_id = ANY($1::uuid[]) AND kind = 'invoice_unmatched' ORDER BY id`, [ids]),
    });
    const before = await snap();
    const retry = await call('finance', 'POST', '/api/v1/invoices/match-queue/retry');
    expect(retry.status).toBe(200);
    const fresh = await invoice(s, { date: '2026-06-20' });
    expect(fresh.match).toMatchObject({ state: 'MATCHED', familyId: c.familyId });
    expect(await snap()).toBe(before);
    expect((await inv(plain)).auto_match).toBe(false);
    // 055 öncesi tahsissiz fatura elle bağlanabilir (kullanıcı kararı R3); otomatik yol ona hiç dokunmadı.
    expect((await call('finance', 'GET', `/api/v1/invoices/${plain}`)).body.match).toMatchObject({ state: 'UNMATCHED', autoMatch: false, lastAutoFailure: null });
  });
});

describe('giriş ve hata eşlemesi', () => {
  it('e-Fatura girişi isteğe bağlı ERP sözleşme referansıyla eşleşir (kaynak MANUAL); 60 karakteri aşan referans 400', async () => {
    const w = h.world;
    const c = await contract({ supplierId: w.suppliers.s1, start: '2020-01-01', end: '2099-12-31' });
    await contract({ supplierId: w.suppliers.s1, start: '2020-01-01', end: '2099-12-31' }); // tarih yolu belirsiz; referans kazanır
    const sellerVkn = (await one<{ tax_id: string }>(`SELECT tax_id FROM suppliers WHERE id = $1`, [w.suppliers.s1])).tax_id;
    const file = () => ({ name: `efatura-${rand()}.xml`, mime: 'application/xml', data: ublInvoiceXml({ invoiceNo: `EFT${rand()}`, ettn: randomUUID(), sellerVkn,
      sellerName: 'Anadolu Bilişim (SENTETİK)', buyerVkn: w.companyA1.vkn, buyerName: w.companyA1.name,
      lines: [{ name: 'Hizmet (SENTETİK)', qty: '1', unitCode: 'C62', price: '100', net: '100.00', rate: '20', tax: '20.00' }], taxTotal: '20.00', amount: '120.00' }) });
    const up = await h.upload('finance', file(), { companyId: w.companyA1.id, kind: 'INVOICE', title: 'e-Fatura (SENTETİK)', erpContractRef: c.code });
    expect(up.status, JSON.stringify(up.body)).toBe(201);
    expect(up.body.invoice).toMatchObject({ created: true });
    expect(await inv(up.body.invoice.invoiceId)).toMatchObject({ contract_family_id: c.familyId, match_method: 'ERP_REF', erp_contract_ref: c.code, erp_contract_ref_source: 'MANUAL' });
    const bad = await h.upload('finance', file(), { companyId: w.companyA1.id, kind: 'INVOICE', title: 'e-Fatura (SENTETİK)', erpOrderRef: 'X'.repeat(61) });
    expect(bad.status).toBe(400);
  });

  it('ERP referansı 60 karakteri aşamaz', async () => {
    const s = await supplier();
    const r = await call('finance', 'POST', '/api/v1/invoices', { companyId: h.world.companyA1.id, supplierId: s, kind: 'INVOICE', invoiceNo: `SNT${rand()}`, issueDate: '2026-06-15',
      currency: 'TRY', erpContractRef: 'X'.repeat(61), lines: [{ description: 'Hizmet (SENTETİK)', quantity: '1', unit: 'adet', unitPrice: '1.00', netAmount: '1.00' }] });
    expect(r.status).toBe(400);
  });

  it('056a koruması (P0001 invoice_match_invalid:*) kendi kodu ve Türkçe iletisiyle döner, immutable_record değil', () => {
    expect(matchGuardError({ code: 'P0001', message: 'invoice_match_invalid: department_mismatch' })).toEqual({ status: 409, code: 'invoice_match_invalid',
      message: 'Sözleşmeye bağlı faturanın departmanı sözleşmenin departmanıyla aynı olmalı; departmanı değiştirmek için önce eşleşmeyi kaldırın.', details: { reason: 'department_mismatch' } });
    expect(matchGuardError({ code: 'P0001', message: 'invoice_match_invalid: contract_not_visible' })?.message).toContain('erişiminiz yok');
    expect(matchGuardError({ code: 'P0001', message: 'invoice_match_invalid: project_mismatch' })?.code).toBe('invoice_match_invalid');
    expect(matchGuardError({ code: 'P0001', message: 'immutable_record: x' })).toBeNull();
    expect(matchGuardError({ code: '23505', message: 'invoice_match_invalid: x' })).toBeNull();
  });

  it('veritabanı koruması uygulama rolüyle tetiklenir: bağlı faturanın departmanı aileden ayrılamaz (409 eşlemesinin kaynağı)', async () => {
    const s = await supplier();
    await contract({ supplierId: s });
    const a = await invoice(s);
    const ctx = { tenantId: h.world.tenantA, userId: h.world.users.finance.id, roles: ['PROCUREMENT'], companyIds: [h.world.companyA1.id], departmentIds: [],
      allDepartments: true, correlationId: 'v2-match-guard' };
    const err = await withTenant(h.pool, ctx, (tx) => tx.query(`UPDATE invoices SET department_id = $2 WHERE id = $1`, [a.id, h.world.departments.ik])).catch((e) => e);
    expect(matchGuardError(err)).toMatchObject({ code: 'invoice_match_invalid', details: { reason: 'department_mismatch' } });
    expect((await inv(a.id)).department_id).toBe(h.world.departments.bt);
  });
});
