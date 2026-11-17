// v2 Faz 5 (D110) Görev 5: tedarikçi kartı v2 (R1, R10–R14), pasife alma ve ayrılış kontrol listesi (R13), portal kullanıcıları (R11),
// davet uygunluğu (R9). Gerçek PostgreSQL + RLS ve yerel S3. Firmalar ve adresler sentetik (example.test). E-posta kanalı `none`.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { DevAuthProvider } from '../src/auth.ts';
import { makeHarness } from './harness.ts';

type H = Awaited<ReturnType<typeof makeHarness>>;
/** Geçerli denetim basamaklı sentetik VKN. */
function validVkn(): string {
  const d = Array.from({ length: 9 }, (_, i) => (i === 0 ? 5 : Math.floor(Math.random() * 10)));
  let sum = 0;
  for (let i = 0; i < 9; i++) {
    const tmp = (d[i]! + 9 - i) % 10;
    let r = (tmp * 2 ** (9 - i)) % 9;
    if (tmp !== 0 && r === 0) r = 9;
    sum += r;
  }
  return d.join('') + String((10 - (sum % 10)) % 10);
}
let h: H;
const auth = new DevAuthProvider('test-secret-'.padEnd(40, 'x'));
const rand = () => randomUUID().slice(0, 8);
const isoDay = (offset: number) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);
const pdf = () => Buffer.concat([Buffer.from('%PDF-1.4\n1 0 obj << /Type /Page >> endobj\n'), Buffer.alloc(600, 0x20), Buffer.from(`\n% ${randomUUID()}\n%%EOF`)]);

async function newSupplier(status: string, name = `Kart Firma ${rand()} A.Ş. (SENTETİK)`) {
  return (await h.owner.query<{ id: string }>(`INSERT INTO suppliers (tenant_id, status, country, tax_id_type, tax_id, legal_name, created_by, activated_by, activated_at)
    VALUES ($1,$2,'TR','VKN',$3,$4,$5,$6,$7) RETURNING id`, [h.world.tenantA, status, validVkn(), name, h.world.users.masterData.id,
    ['ACTIVE', 'CONDITIONAL'].includes(status) ? h.world.users.legal.id : null, ['ACTIVE', 'CONDITIONAL'].includes(status) ? new Date() : null])).rows[0]!.id;
}
/** Sentetik portal kullanıcısı (dev| oturumu açılabilir) + SUPPLIER üyeliği. */
async function portalUser(supplierId: string) {
  const email = `portal-${rand()}@example.test`;
  const id = (await h.owner.query<{ id: string }>(`INSERT INTO users (auth_subject, email, display_name) VALUES ($1,$2,'Portal Kişisi (SENTETİK)') RETURNING id`, [`dev|${email}`, email])).rows[0]!.id;
  await h.owner.query(`INSERT INTO memberships (tenant_id, user_id, roles, company_ids, supplier_id) VALUES ($1,$2,ARRAY['SUPPLIER'],'{}',$3)`, [h.world.tenantA, id, supplierId]);
  return { id, email, token: await auth.issue(`dev|${email}`) };
}
async function asUser(token: string, method: string, url: string) {
  const r = await h.app.inject({ method: method as any, url, headers: { authorization: `Bearer ${token}`, 'x-tenant-id': h.world.tenantA } });
  return { status: r.statusCode, body: JSON.parse(r.body || 'null') };
}
const card = async (id: string, who: 'buyer' | 'legal' | 'techEval' | 'auditor' = 'buyer') => (await h.call(who, 'GET', `/api/v1/suppliers/${id}`)).body;
async function upload(supplierId: string, fields: Record<string, string>, who: 'buyer' | 'techEval' = 'buyer', data = pdf()) {
  const b = '----spcard' + randomUUID();
  const parts: Buffer[] = Object.entries(fields).map(([k, v]) => Buffer.from(`--${b}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`));
  parts.push(Buffer.from(`--${b}\r\nContent-Disposition: form-data; name="file"; filename="belge.pdf"\r\nContent-Type: application/pdf\r\n\r\n`), data, Buffer.from(`\r\n--${b}--\r\n`));
  const tok = await auth.issue(`dev|${h.world.users[who].email}`);
  const r = await h.app.inject({ method: 'POST', url: `/api/v1/suppliers/${supplierId}/documents`, payload: Buffer.concat(parts),
    headers: { authorization: `Bearer ${tok}`, 'x-tenant-id': h.world.tenantA, 'content-type': `multipart/form-data; boundary=${b}` } });
  return { status: r.statusCode, body: JSON.parse(r.body || 'null') };
}

beforeAll(async () => {
  h = await makeHarness();
  // Belge türleri (R3 önerilen set) Yönetici açılışıyla yazılır.
  const put = await h.call('tenantAdmin', 'PUT', '/api/v1/settings/supplier-applications', { body: { enabled: true, publicSlug: `kc-${rand()}`, categories: ['Bilgi teknolojileri'] } });
  expect(put.status).toBe(200);
});
afterAll(async () => { await h?.close(); });

describe('Liste (R1)', () => {
  it('stage_labels_filters_counts_and_legacy_status_filter', async () => {
    const sus = await newSupplier('SUSPENDED', `Eski Askıda ${rand()} (SENTETİK)`);
    const arc = await newSupplier('ARCHIVED', `Eski Arşiv ${rand()} (SENTETİK)`);
    const cond = await newSupplier('CONDITIONAL', `Koşullu ${rand()} (SENTETİK)`);
    const all = await h.call('buyer', 'GET', '/api/v1/suppliers');
    expect(all.status).toBe(200);
    const byId = new Map(all.body.items.map((i: any) => [i.id, i]));
    expect(byId.get(sus)).toMatchObject({ status: 'SUSPENDED', stage: 'PASSIVE', stageLabel: 'Pasif', documentAlert: null, responsibleDepartment: null });
    expect(byId.get(arc)).toMatchObject({ status: 'ARCHIVED', stageLabel: 'Pasif' });
    expect(byId.get(cond)).toMatchObject({ status: 'CONDITIONAL', stage: 'APPROVED', stageLabel: 'Onaylı (koşullu)' });
    expect(byId.get(h.world.suppliers.s3)).toMatchObject({ status: 'CANDIDATE', stageLabel: 'Aday' });
    // Eski alanlar aynen.
    expect(Object.keys(byId.get(h.world.suppliers.s1) as object)).toEqual(expect.arrayContaining(['id', 'status', 'country', 'taxIdType', 'taxId', 'legalName',
      'identityReviewRequired', 'createdAt', 'rowVersion', 'documentCount', 'pendingBankChanges']));
    expect(all.body.counts).toMatchObject({ CANDIDATE: expect.any(Number), APPROVED: expect.any(Number), PASSIVE: expect.any(Number), REJECTED: expect.any(Number) });
    expect(all.body.counts.PASSIVE).toBeGreaterThanOrEqual(2);
    expect(typeof all.body.applicationsOpen).toBe('number');
    const passive = await h.call('buyer', 'GET', '/api/v1/suppliers?stage=PASSIVE');
    expect(passive.body.items.map((i: any) => i.id).sort()).toEqual(expect.arrayContaining([sus, arc]));
    expect(passive.body.items.every((i: any) => i.stage === 'PASSIVE')).toBe(true);
    const approved = await h.call('buyer', 'GET', '/api/v1/suppliers?stage=APPROVED');
    expect(approved.body.items.every((i: any) => ['ACTIVE', 'CONDITIONAL'].includes(i.status))).toBe(true);
    // Eski status süzgeci aynen; MERGED listede gizli.
    const legacy = await h.call('buyer', 'GET', '/api/v1/suppliers?status=SUSPENDED');
    expect(legacy.body.items.map((i: any) => i.id)).toContain(sus);
    expect(legacy.body.items.every((i: any) => i.status === 'SUSPENDED')).toBe(true);
    expect((await h.call('buyer', 'GET', '/api/v1/suppliers?stage=MERGED')).status).toBe(400);
    // Eski SUSPENDED kart açılır, aşama "Pasif".
    expect(await card(sus)).toMatchObject({ status: 'SUSPENDED', stage: 'PASSIVE', stageLabel: 'Pasif', can: { reactivate: true, offboard: false } });
  });
});

describe('Kart (R10–R14)', () => {
  it('card_keeps_old_fields_and_adds_v2_sections', async () => {
    const c = await card(h.world.suppliers.s3);
    for (const k of ['id', 'status', 'legalName', 'isCreator', 'documents', 'approvals', 'bankAccounts', 'bankChangeRequests', 'rowVersion', 'createdByName']) expect(c).toHaveProperty(k);
    expect(c).toMatchObject({ stage: 'CANDIDATE', stageLabel: 'Aday', eligibleForInvite: false, offboarding: null, portalUsers: [expect.objectContaining({ status: 'ACTIVE' })],
      profile: { vpnAccess: 'UNKNOWN', vpnAccessLabel: 'Bilinmiyor', serviceCategories: [] }, contracts: expect.any(Array), projects: expect.any(Array),
      surveys: expect.objectContaining({ items: expect.any(Array), pendingResponses: 0 }), supplierDocuments: [],
      can: { editProfile: true, offboard: true, reactivate: false, manageUsers: true, manageDocuments: true } });
    expect(c.portalAccessNote).toMatch(/misafir \(B2B\)/);
    // Zorunlu belgeler eksik → R10 bilgi kutusu (engellemez).
    expect(c.requiredMissing.map((m: any) => m.code).sort()).toEqual(['FAALIYET_BELGESI', 'IMZA_SIRKULERI', 'TICARET_SICIL_GAZETESI', 'VERGI_LEVHASI']);
    expect(c.activationHints.map((x: any) => x.code)).toEqual(['DOCUMENT_MISSING', 'DOCUMENT_MISSING', 'DOCUMENT_MISSING', 'DOCUMENT_MISSING']);
    // Departman kullanıcısı ve denetçi görür ama düzenleyemez.
    expect((await card(h.world.suppliers.s3, 'techEval')).can).toEqual({ editProfile: false, offboard: false, reactivate: false, manageUsers: false, manageDocuments: false });
    expect((await card(h.world.suppliers.s3, 'auditor')).stageLabel).toBe('Aday');
  });

  it('profile_edit_audits_before_after_and_respects_version_and_role', async () => {
    const sid = await newSupplier('ACTIVE');
    const c = await card(sid);
    const body = { expectedRowVersion: c.rowVersion, contactName: 'Selin İletişim', contactPhone: '0312 111 11 11', serviceCategories: ['Bilgi teknolojileri'],
      responsibleDepartmentId: h.world.departments.bt, supplierManagerUserId: h.world.users.legal.id, vpnAccess: 'YES', slaSummary: '4 saatte müdahale (sentetik)' };
    expect((await h.call('techEval', 'PUT', `/api/v1/suppliers/${sid}/profile`, { body })).status).toBe(403);
    const r = await h.call('buyer', 'PUT', `/api/v1/suppliers/${sid}/profile`, { body });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.rowVersion).toBe(c.rowVersion + 1);
    expect((await h.call('buyer', 'PUT', `/api/v1/suppliers/${sid}/profile`, { body: { expectedRowVersion: c.rowVersion, address: 'X' } })).body.error.code).toBe('version_conflict');
    const after = await card(sid);
    expect(after.profile).toMatchObject({ contactName: 'Selin İletişim', vpnAccess: 'YES', vpnAccessLabel: 'Var', responsibleDepartment: { id: h.world.departments.bt },
      supplierManager: { id: h.world.users.legal.id } });
    const list = (await h.call('buyer', 'GET', '/api/v1/suppliers')).body.items.find((i: any) => i.id === sid);
    expect(list.responsibleDepartment).toMatchObject({ id: h.world.departments.bt });
    const ev = (await h.owner.query(`SELECT data FROM audit_events WHERE action = 'supplier.profile.updated' AND entity_id = $1`, [sid])).rows;
    expect(ev).toHaveLength(1);
    expect(ev[0].data.before).toMatchObject({ contactName: null, vpnAccess: 'UNKNOWN' });
    expect(ev[0].data.after).toMatchObject({ contactName: 'Selin İletişim', vpnAccess: 'YES', slaSummary: '4 saatte müdahale (sentetik)' });
    // Tedarikçi yöneticisi kurumun etkin kullanıcısı olmalı.
    expect((await h.call('buyer', 'PUT', `/api/v1/suppliers/${sid}/profile`, { body: { expectedRowVersion: after.rowVersion, supplierManagerUserId: h.world.users.supplier1.id } })).status).toBe(422);
  });

  it('documents_upload_renewal_chain_validity_alert_and_owner_access', async () => {
    const sid = h.world.suppliers.s1;
    expect((await upload(sid, { typeCode: 'VERGI_LEVHASI' }, 'techEval')).status).toBe(403);
    expect((await upload(sid, { typeCode: 'VERGI_LEVHASI' })).body.error.code).toBe('valid_until_required');
    const first = await upload(sid, { typeCode: 'VERGI_LEVHASI', validUntil: isoDay(10) });
    expect(first.status, JSON.stringify(first.body)).toBe(201);
    expect(first.body).toMatchObject({ typeCode: 'VERGI_LEVHASI', validity: 'EXPIRING', validityLabel: 'Süresi yaklaşıyor', avScanLabel: 'Virüs taraması yapılandırılmadı', current: true });
    let row = (await h.call('buyer', 'GET', '/api/v1/suppliers')).body.items.find((i: any) => i.id === sid);
    expect(row.documentAlert).toBe('EXPIRING');
    const renewed = await upload(sid, { typeCode: 'VERGI_LEVHASI', validUntil: isoDay(400), replacesId: first.body.id });
    expect(renewed.status, JSON.stringify(renewed.body)).toBe(201);
    expect(renewed.body.replacesId).toBe(first.body.id);
    expect((await upload(sid, { typeCode: 'VERGI_LEVHASI', validUntil: isoDay(500), replacesId: first.body.id })).body.error.code).toBe('already_superseded');
    expect((await upload(sid, { typeCode: 'IMZA_SIRKULERI', replacesId: renewed.body.id })).body.error.code).toBe('replaces_type_mismatch');
    const c = await card(sid);
    const old = c.supplierDocuments.find((d: any) => d.id === first.body.id);
    expect(old).toMatchObject({ current: false, supersededById: renewed.body.id, supersededLabel: 'Yerine yenisi yüklendi' });
    row = (await h.call('buyer', 'GET', '/api/v1/suppliers')).body.items.find((i: any) => i.id === sid);
    expect(row.documentAlert).toBeNull();
    expect(c.requiredMissing.map((m: any) => m.code)).not.toContain('VERGI_LEVHASI');
    // Sahibi tedarikçi kendi belgesini indirir; başka tedarikçi göremez (RLS).
    expect((await h.call('supplier1', 'GET', `/api/v1/supplier-documents/${renewed.body.id}/content`)).status).toBe(200);
    expect((await h.call('supplier2', 'GET', `/api/v1/supplier-documents/${renewed.body.id}/content`)).status).toBe(404);
    expect((await h.owner.query(`SELECT count(*)::int AS n FROM audit_events WHERE action = 'supplier_document.uploaded' AND entity_id = $1`, [sid])).rows[0].n).toBe(2);
    expect((await h.owner.query(`SELECT uploaded_via, uploaded_by FROM supplier_documents WHERE id = $1`, [renewed.body.id])).rows[0])
      .toEqual({ uploaded_via: 'INTERNAL', uploaded_by: h.world.users.buyer.id });
    // Süresi geçmiş belge → EXPIRED uyarısı.
    const s2 = await newSupplier('ACTIVE');
    expect((await upload(s2, { typeCode: 'FAALIYET_BELGESI', validUntil: isoDay(-3) })).body.validity).toBe('EXPIRED');
    expect((await h.call('buyer', 'GET', '/api/v1/suppliers')).body.items.find((i: any) => i.id === s2).documentAlert).toBe('EXPIRED');
  });

  it('same_type_upload_without_replacesId_supersedes_older_current_and_list_counts_supplier_documents', async () => {
    const sid = await newSupplier('ACTIVE');
    const a = await upload(sid, { typeCode: 'FAALIYET_BELGESI', validUntil: isoDay(200) });
    const b = await upload(sid, { typeCode: 'FAALIYET_BELGESI', validUntil: isoDay(9) });
    expect(a.status).toBe(201); expect(b.status).toBe(201);
    const c = await card(sid);
    expect(c.supplierDocuments.find((d: any) => d.id === a.body.id)).toMatchObject({ current: false, supersededById: b.body.id, supersededLabel: 'Yerine yenisi yüklendi' });
    expect(c.supplierDocuments.find((d: any) => d.id === b.body.id)).toMatchObject({ current: true });
    const row = (await h.call('buyer', 'GET', '/api/v1/suppliers')).body.items.find((i: any) => i.id === sid);
    expect(row.supplierDocumentCount).toBe(1); // yalnız güncel
    expect(row.documentCount).toBe(0); // eski alan: bağlı fatura/sözleşme belgesi, aynen
    expect(row.documentAlert).toBe('EXPIRING'); // yalnız güncel belge sayılır
  });
});

describe('Pasife alma ve ayrılış (R13)', () => {
  it('deactivate_suspends_portal_checklist_task_and_sod_on_reactivation', async () => {
    const sid = await newSupplier('ACTIVE');
    const pu = await portalUser(sid);
    const me0 = await asUser(pu.token, 'GET', '/api/v1/me');
    expect(me0.body).toMatchObject({ supplierPortal: true, activeTenantId: h.world.tenantA });
    let c = await card(sid);
    expect((await h.call('techEval', 'POST', `/api/v1/suppliers/${sid}/deactivate`, { body: { reason: 'Departman denemesi (sentetik).', expectedRowVersion: c.rowVersion } })).status).toBe(403);
    expect((await h.call('buyer', 'POST', `/api/v1/suppliers/${sid}/deactivate`, { body: { reason: 'kısa', expectedRowVersion: c.rowVersion } })).body.error.code).toBe('reason_required');
    const d = await h.call('buyer', 'POST', `/api/v1/suppliers/${sid}/deactivate`, { body: { reason: 'Sözleşme sona erdi, hizmet alınmayacak (sentetik).', expectedRowVersion: c.rowVersion } });
    expect(d.status, JSON.stringify(d.body)).toBe(200);
    expect(d.body).toMatchObject({ status: 'SUSPENDED', stageLabel: 'Pasif', suspendedPortalUsers: 1, warnings: [] });
    expect(d.body.items.map((i: any) => i.code)).toEqual(['ACCESS_CLOSED', 'DATA_RETURNED', 'ASSETS_RETURNED', 'CONTRACTS_CHECKED', 'OPEN_ROUNDS_CHECKED', 'ERP_DEACTIVATED']);
    expect((await h.owner.query(`SELECT status FROM memberships WHERE user_id = $1`, [pu.id])).rows[0].status).toBe('SUSPENDED');
    // Portal kullanıcısı artık kiracıya giremez.
    const me1 = await asUser(pu.token, 'GET', '/api/v1/me');
    expect(me1.body).toMatchObject({ supplierPortal: false, activeTenantId: null, memberships: [] });
    expect((await asUser(pu.token, 'GET', '/api/v1/portal/rounds')).status).toBe(403);
    const task = (await h.owner.query(`SELECT id, kind, assignee_role, status FROM tasks WHERE dedupe_key = $1`, [`offboarding:${d.body.offboardingId}`])).rows;
    expect(task).toEqual([expect.objectContaining({ kind: 'supplier_offboarding', assignee_role: 'PROCUREMENT', status: 'OPEN' })]);
    c = await card(sid);
    expect(c).toMatchObject({ stageLabel: 'Pasif', deactivation: { reason: 'Sözleşme sona erdi, hizmet alınmayacak (sentetik).' }, offboarding: { completed: false, status: 'OPEN' },
      can: { offboard: false, reactivate: false } });
    expect(c.portalUsers[0]).toMatchObject({ status: 'SUSPENDED', statusLabel: 'Askıda' });
    // Yeni tura davet edilemez.
    expect((await h.call('buyer', 'GET', '/api/v1/supplier-options')).body.items.some((i: any) => i.id === sid)).toBe(false);

    // Pasife alan yeniden açamaz (görev ayrılığı).
    const sod = await h.call('buyer', 'POST', `/api/v1/suppliers/${sid}/reactivate`, { body: { reason: 'Yeniden çalışılacak (sentetik).', expectedRowVersion: c.rowVersion } });
    expect(sod.status).toBe(403);
    expect(sod.body.error.code).toBe('segregation_of_duties');
    expect((await card(sid, 'legal')).can.reactivate).toBe(true);

    // Kontrol listesi: hepsi kapanınca liste tamamlanır, görev kapanır.
    const items = c.offboarding.items as { id: string; code: string }[];
    expect((await h.call('buyer', 'PUT', `/api/v1/supplier-offboarding-items/${items[0]!.id}`, { body: { notApplicable: true } })).body.error.code).toBe('note_required');
    expect((await h.call('buyer', 'PUT', `/api/v1/supplier-offboarding-items/${items[0]!.id}`, { body: {} })).status).toBe(422);
    for (const [i, it] of items.entries()) {
      const body = i === 5 ? { notApplicable: true, note: 'ERP bağlantısı yok (sentetik).' } : { done: true, note: `${it.code} tamam` };
      const r = await h.call('buyer', 'PUT', `/api/v1/supplier-offboarding-items/${it.id}`, { body });
      expect(r.status, JSON.stringify(r.body)).toBe(200);
      expect(r.body.offboarding.completed).toBe(i === 5);
    }
    expect((await h.call('buyer', 'PUT', `/api/v1/supplier-offboarding-items/${items[0]!.id}`, { body: { done: true } })).body.error.code).toBe('already_decided');
    expect((await h.owner.query(`SELECT status FROM tasks WHERE id = $1`, [task[0].id])).rows[0].status).toBe('DONE');
    expect((await card(sid)).offboarding).toMatchObject({ completed: true, status: 'COMPLETED' });

    // İkinci Satınalma kullanıcısı yeniden açar → önceki durum (ACTIVE), portal kullanıcısı geri gelir.
    c = await card(sid);
    const re = await h.call('legal', 'POST', `/api/v1/suppliers/${sid}/reactivate`, { body: { reason: 'Yeni sözleşme imzalandı (sentetik).', expectedRowVersion: c.rowVersion } });
    expect(re.status, JSON.stringify(re.body)).toBe(200);
    expect(re.body).toMatchObject({ status: 'ACTIVE', stageLabel: 'Onaylı', restoredPortalUsers: 1 });
    expect((await asUser(pu.token, 'GET', '/api/v1/me')).body.supplierPortal).toBe(true);
    // Yeniden pasife alma: reactivated_* aynı UPDATE'te boşalır; bu kez yeniden açan kişi pasife alabilir.
    c = await card(sid);
    const again = await h.call('legal', 'POST', `/api/v1/suppliers/${sid}/deactivate`, { body: { reason: 'İkinci döngü denemesi (sentetik).', expectedRowVersion: c.rowVersion } });
    expect(again.status, JSON.stringify(again.body)).toBe(200);
    expect((await h.owner.query(`SELECT reactivated_by, deactivated_by FROM suppliers WHERE id = $1`, [sid])).rows[0])
      .toEqual({ reactivated_by: null, deactivated_by: h.world.users.legal.id });
    const ev = (await h.owner.query(`SELECT action FROM audit_events WHERE entity_type = 'supplier' AND entity_id = $1 AND action LIKE 'supplier.%activated' ORDER BY id`, [sid])).rows.map((r) => r.action);
    expect(ev).toEqual(['supplier.deactivated', 'supplier.reactivated', 'supplier.deactivated']);
  });

  it('warnings_for_active_rounds_candidate_returns_to_candidate_and_archived_not_reopened', async () => {
    // s3 (aday) bu dünyada açık tur davetine sahip olabilir; uyarı engel değildir.
    const sid = await newSupplier('CANDIDATE');
    const c = await card(sid);
    const d = await h.call('buyer', 'POST', `/api/v1/suppliers/${sid}/deactivate`, { body: { reason: 'Aday artık değerlendirilmeyecek (sentetik).', expectedRowVersion: c.rowVersion } });
    expect(d.status).toBe(200);
    const re = await h.call('legal', 'POST', `/api/v1/suppliers/${sid}/reactivate`, { body: { reason: 'Aday yeniden değerlendirilecek (sentetik).', expectedRowVersion: d.body.rowVersion } });
    expect(re.body).toMatchObject({ status: 'CANDIDATE', stageLabel: 'Aday' });
    // İnceleme (6): yeniden açıldıktan sonra tamamlanmamış liste işaretlenir.
    expect((await card(sid)).offboarding).toMatchObject({ completed: false, status: 'OPEN_AFTER_REACTIVATION' });
    // Açık (onayda) teklif turu uyarıdır, engel değildir.
    const act = await newSupplier('ACTIVE');
    const p = await h.call('buyer', 'POST', '/api/v1/projects', { body: { companyId: h.world.companyA1.id, title: `Uyarı turu ${rand()}`, category: 'BT hizmetleri',
      need: 'Sentetik ihtiyaç', currency: 'TRY', budget: '1000.00', budgetVerified: false, lines: [{ lot: 'Lot 1', description: 'Destek', unit: 'saat', quantity: '10' }],
      criteria: [{ code: 'PRICE', name: 'Fiyat', kind: 'PRICE', weight: '100' }] } });
    expect((await h.call('buyer', 'POST', `/api/v1/projects/${p.body.id}/rounds`, { body: { closesAt: new Date(Date.now() + 48 * 3600_000).toISOString(),
      supplierIds: [act] }, headers: { 'if-match': p.body.etag } })).status).toBe(201);
    const w = await h.call('buyer', 'POST', `/api/v1/suppliers/${act}/deactivate`, { body: { reason: 'Açık tur varken pasife alma (sentetik).', expectedRowVersion: (await card(act)).rowVersion } });
    expect(w.status, JSON.stringify(w.body)).toBe(200);
    expect(w.body.warnings).toEqual([expect.objectContaining({ code: 'OPEN_ROUND' })]);
    expect(w.body.openRounds).toEqual([expect.objectContaining({ projectId: p.body.id, status: 'PENDING_APPROVAL' })]);
    const arc = await newSupplier('ARCHIVED');
    const a = await card(arc);
    expect((await h.call('legal', 'POST', `/api/v1/suppliers/${arc}/reactivate`, { body: { reason: 'Arşivden açma denemesi (sentetik).', expectedRowVersion: a.rowVersion } })).body.error.code).toBe('invalid_state');
    expect((await h.call('legal', 'POST', `/api/v1/suppliers/${arc}/deactivate`, { body: { reason: 'Arşivi pasife alma denemesi.', expectedRowVersion: a.rowVersion } })).body.error.code).toBe('invalid_state');
  });
});

describe('Portal kullanıcıları (R11)', () => {
  it('add_suspend_reactivate_and_other_tenant_email_409', async () => {
    const sid = await newSupplier('ACTIVE');
    const email = `yeni-portal-${rand()}@example.test`;
    expect((await h.call('techEval', 'POST', `/api/v1/suppliers/${sid}/portal-users`, { body: { name: 'Ali Portal', email } })).status).toBe(403);
    const r = await h.call('buyer', 'POST', `/api/v1/suppliers/${sid}/portal-users`, { body: { name: 'Ali Portal', email } });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.body).toMatchObject({ user: { email, status: 'ACTIVE', firstLogin: 'PENDING' }, email: { status: 'NOT_CONFIGURED' } });
    expect(r.body.note).toMatch(/B2B/);
    const m = (await h.owner.query(`SELECT m.roles, m.company_ids, m.supplier_id, u.auth_subject FROM memberships m JOIN users u ON u.id = m.user_id WHERE m.user_id = $1`, [r.body.user.userId])).rows;
    expect(m).toEqual([{ roles: ['SUPPLIER'], company_ids: [], supplier_id: sid, auth_subject: `invite|${email}` }]);
    expect((await h.owner.query(`SELECT status FROM email_outbox WHERE to_email = $1 AND subject = 'Tedarikçi portalı erişiminiz hazır'`, [email])).rows).toEqual([{ status: 'NOT_CONFIGURED' }]);
    expect((await h.call('buyer', 'POST', `/api/v1/suppliers/${sid}/portal-users`, { body: { name: 'Ali Portal', email } })).body.error.code).toBe('portal_user_exists');
    // Başka kurumdaki e-posta: 409, hiçbir şey açılmaz.
    const other = await h.call('buyer', 'POST', `/api/v1/suppliers/${sid}/portal-users`, { body: { name: 'B Kişisi', email: h.world.users.buyerB.email } });
    expect(other.status).toBe(409);
    expect(other.body.error.code).toBe('user_in_other_tenant');
    // Kurumun iç kullanıcısı tedarikçi kullanıcısı yapılamaz.
    expect((await h.call('buyer', 'POST', `/api/v1/suppliers/${sid}/portal-users`, { body: { name: 'İç', email: h.world.users.legal.email } })).body.error.code).toBe('user_has_other_membership');
    const s = await h.call('buyer', 'POST', `/api/v1/suppliers/${sid}/portal-users/${r.body.user.userId}/suspend`);
    expect(s.status).toBe(200);
    expect(s.body).toMatchObject({ status: 'SUSPENDED' });
    expect((await h.call('buyer', 'POST', `/api/v1/suppliers/${sid}/portal-users/${r.body.user.userId}/suspend`)).body.error.code).toBe('invalid_state');
    expect((await h.call('buyer', 'POST', `/api/v1/suppliers/${sid}/portal-users/${r.body.user.userId}/reactivate`)).body).toMatchObject({ status: 'ACTIVE' });
    // Başka tedarikçinin kullanıcısı bu karttan yönetilemez.
    expect((await h.call('buyer', 'POST', `/api/v1/suppliers/${sid}/portal-users/${h.world.users.supplier1.id}/suspend`)).status).toBe(404);
    const acts = (await h.owner.query(`SELECT action FROM audit_events WHERE entity_id = $1 AND action LIKE 'supplier.portal_user.%' ORDER BY id`, [sid])).rows.map((x) => x.action);
    expect(acts).toEqual(['supplier.portal_user.added', 'supplier.portal_user.suspended', 'supplier.portal_user.reactivated']);
  });
});

describe('Davet uygunluğu (R9)', () => {
  it('supplier_options_flags_candidates_and_publish_refuses_candidate', async () => {
    const opts = (await h.call('buyer', 'GET', '/api/v1/supplier-options')).body.items;
    expect(opts.find((o: any) => o.id === h.world.suppliers.s3)).toMatchObject({ status: 'CANDIDATE', stageLabel: 'Aday', eligibleForInvite: false,
      ineligibleReason: 'Aday tedarikçi önce onaylanmalı.' });
    expect(opts.find((o: any) => o.id === h.world.suppliers.s1)).toMatchObject({ stageLabel: 'Onaylı', eligibleForInvite: true, ineligibleReason: null, label: expect.any(String) });
    const p = await h.call('buyer', 'POST', '/api/v1/projects', { body: { companyId: h.world.companyA1.id, title: `R9 deneme projesi ${rand()}`, category: 'BT hizmetleri',
      need: 'Sentetik ihtiyaç', currency: 'TRY', budget: '1000.00', budgetVerified: false, lines: [{ lot: 'Lot 1', description: 'Destek', unit: 'saat', quantity: '10' }],
      criteria: [{ code: 'PRICE', name: 'Fiyat', kind: 'PRICE', weight: '100' }] } });
    expect(p.status, JSON.stringify(p.body)).toBe(201);
    const r = await h.call('buyer', 'POST', `/api/v1/projects/${p.body.id}/rounds`, { body: { closesAt: new Date(Date.now() + 48 * 3600_000).toISOString(),
      supplierIds: [h.world.suppliers.s1, h.world.suppliers.s3] }, headers: { 'if-match': p.body.etag } });
    expect(r.status).toBe(422);
    expect(r.body.error).toMatchObject({ code: 'supplier_not_approved', details: { suppliers: [{ id: h.world.suppliers.s3 }] } });
    expect(r.body.error.message).toMatch(/Aday tedarikçi önce onaylanmalı/);
  });
});
