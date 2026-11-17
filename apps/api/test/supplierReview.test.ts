// v2 Faz 5 (D110) Görev 5: başvuru inceleme ve karar (R2, R10, R11, R14), tedarikçi belgesi içeriği. Gerçek PostgreSQL + RLS ve yerel S3.
// E-posta kanalı `none`: satırlar NOT_CONFIGURED (gönderim yok). Tüm firmalar ve adresler sentetik (example.test).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { processJobs } from '../src/worker.ts';
import { makeHarness } from './harness.ts';

type H = Awaited<ReturnType<typeof makeHarness>>;
let h: H;
let slug: string;
const rand = () => randomUUID().slice(0, 8);
let ipSeq = 1;
const nextIp = () => `10.88.${Math.floor(ipSeq / 250)}.${(ipSeq++ % 250) + 1}`;

/** Geçerli denetim basamaklı sentetik VKN. */
function validVkn(): string {
  const d = Array.from({ length: 9 }, (_, i) => (i === 0 ? 6 : Math.floor(Math.random() * 10)));
  let sum = 0;
  for (let i = 0; i < 9; i++) {
    const tmp = (d[i]! + 9 - i) % 10;
    let r = (tmp * 2 ** (9 - i)) % 9;
    if (tmp !== 0 && r === 0) r = 9;
    sum += r;
  }
  return d.join('') + String((10 - (sum % 10)) % 10);
}
const pdf = () => Buffer.concat([Buffer.from('%PDF-1.4\n1 0 obj << /Type /Page >> endobj\n'), Buffer.alloc(800, 0x20), Buffer.from(`\n% ${randomUUID()}\n%%EOF`)]);
interface FilePart { field: string; name: string; mime: string; data: Buffer }
function multipart(fields: [string, string][], files: FilePart[]) {
  const boundary = '----sprev' + randomUUID();
  const parts: Buffer[] = [];
  for (const [k, v] of fields) parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`));
  for (const f of files) parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${f.field}"; filename="${f.name}"\r\nContent-Type: ${f.mime}\r\n\r\n`), f.data, Buffer.from('\r\n'));
  parts.push(Buffer.from(`--${boundary}--\r\n`));
  return { payload: Buffer.concat(parts), contentType: `multipart/form-data; boundary=${boundary}` };
}
const doc = (code: string): FilePart => ({ field: `documents[${code}]`, name: `${code.toLowerCase()}.pdf`, mime: 'application/pdf', data: pdf() });
const DOCS = () => [doc('VERGI_LEVHASI'), doc('IMZA_SIRKULERI'), doc('TICARET_SICIL_GAZETESI'), doc('FAALIYET_BELGESI')];
async function runJobs() { for (let i = 0; i < 20; i++) if (!(await processJobs(h.pool, h.store, null))) break; }

/** Girişsiz başvuru + e-posta doğrulaması → SUBMITTED. Döner: başvuru kimliği, e-posta, VKN. */
async function submitted(over: { taxId?: string; legalName?: string } = {}) {
  const email = `basvuru-${rand()}@example.test`;
  const taxId = over.taxId ?? validVkn();
  const m = multipart([['legalName', over.legalName ?? 'İnceleme Bilişim Ltd. Şti. (SENTETİK)'], ['taxIdType', 'VKN'], ['taxId', taxId], ['contactName', 'Deniz Başvuru'],
    ['contactEmail', email], ['contactPhone', '0216 000 00 00'], ['address', 'Sentetik Cad. 5, Ankara'], ['services', 'Sentetik ağ bakımı'], ['categories', 'Bilgi teknolojileri'],
    ['validUntil[VERGI_LEVHASI]', '2027-12-31'], ['validUntil[FAALIYET_BELGESI]', '2027-06-30'], ['validUntil[ISO27001]', '2028-01-31']], [...DOCS(), doc('ISO27001')]);
  const r = await h.app.inject({ method: 'POST', url: `/api/v1/public/applications/${slug}`, payload: m.payload, remoteAddress: nextIp(), headers: { 'content-type': m.contentType } });
  expect(r.statusCode, r.body).toBe(202);
  const body = (await h.owner.query<{ body_text: string }>(`SELECT body_text FROM email_outbox WHERE related_type = 'supplier_application' AND to_email = $1`, [email])).rows[0]!.body_text;
  const token = /#token=([A-Za-z0-9_-]+)/.exec(body)![1]!;
  const v = await h.app.inject({ method: 'POST', url: '/api/v1/public/applications/verify', payload: { token }, remoteAddress: nextIp() });
  expect(v.statusCode, v.body).toBe(200);
  await runJobs();
  const id = (await h.owner.query<{ id: string }>(`SELECT id FROM supplier_applications WHERE contact_email = $1`, [email])).rows[0]!.id;
  return { id, email, taxId };
}
const detail = async (id: string, who: 'buyer' | 'legal' | 'techEval' = 'buyer') => h.call(who, 'GET', `/api/v1/supplier-applications/${id}`);
const decide = async (id: string, body: Record<string, unknown>, who: 'buyer' | 'legal' | 'techEval' | 'auditor' = 'buyer') => {
  const rv = (await detail(id, 'buyer')).body.rowVersion;
  return h.call(who, 'POST', `/api/v1/supplier-applications/${id}/decision`, { body: { expectedRowVersion: rv, ...body } });
};
const openTasks = async (key: string) => (await h.owner.query(`SELECT kind, assignee_role FROM tasks WHERE tenant_id = $1 AND dedupe_key = $2 AND status = 'OPEN'`, [h.world.tenantA, key])).rows;

beforeAll(async () => {
  h = await makeHarness();
  slug = `rv-${rand()}`;
  const put = await h.call('tenantAdmin', 'PUT', '/api/v1/settings/supplier-applications', { body: { enabled: true, publicSlug: slug, categories: ['Bilgi teknolojileri'] } });
  expect(put.status, JSON.stringify(put.body)).toBe(200);
});
afterAll(async () => { await h?.close(); });

describe('Başvuru inceleme: liste ve ayrıntı', () => {
  it('list_detail_and_department_user_can_read_but_not_decide', async () => {
    const a = await submitted();
    const list = await h.call('buyer', 'GET', '/api/v1/supplier-applications?status=SUBMITTED');
    expect(list.status).toBe(200);
    expect(list.body.items.some((x: any) => x.id === a.id && x.statusLabel === 'İnceleme bekliyor' && x.documentCount === 5)).toBe(true);
    expect(list.body.counts.SUBMITTED).toBeGreaterThanOrEqual(1);
    expect(list.body.can).toEqual({ decide: true });
    expect(JSON.stringify(list.body)).not.toMatch(/token_hash|ip_hash|tokenHash/);
    const d = await detail(a.id);
    expect(d.status).toBe(200);
    expect(d.body).toMatchObject({ status: 'SUBMITTED', taxId: a.taxId, taxIdCheck: { valid: true }, existingSupplier: null, missingRequired: [],
      can: { decide: true, approve: true, requestDocuments: true } });
    expect(d.body.documents).toHaveLength(5);
    expect(d.body.documents[0]).toMatchObject({ avScanStatus: 'NOT_CONFIGURED', avScanLabel: 'Virüs taraması yapılandırılmadı', current: true });
    expect(d.body.history.map((x: any) => x.code)).toEqual(['CREATED', 'VERIFIED']);
    // Departman kullanıcısı görür, karar veremez.
    const dep = await detail(a.id, 'techEval');
    expect(dep.status).toBe(200);
    expect(dep.body.can.decide).toBe(false);
    expect((await h.call('techEval', 'GET', '/api/v1/supplier-applications')).body.can).toEqual({ decide: false });
    expect((await decide(a.id, { action: 'REJECT', reason: 'Departman kullanıcısı denemesi (sentetik).' }, 'techEval')).status).toBe(403);
    expect((await decide(a.id, { action: 'REJECT', reason: 'Denetçi denemesi (sentetik).' }, 'auditor')).status).toBe(403);
    expect((await h.call('supplier1', 'GET', `/api/v1/supplier-applications/${a.id}`)).status).toBe(403);
    // Başka kiracı göremez.
    expect((await h.call('buyerB', 'GET', `/api/v1/supplier-applications/${a.id}`, { tenant: h.world.tenantB })).status).toBe(404);
  });
});

describe('Onay (R2, R10, R11, R14)', () => {
  it('approve_creates_candidate_card_moves_documents_invites_portal_user_and_two_emails', async () => {
    const a = await submitted({ legalName: 'Onay Ağ Sistemleri A.Ş. (SENTETİK)' });
    expect(await openTasks(`application:${a.id}:review`)).toHaveLength(1);
    const r = await decide(a.id, { action: 'APPROVE', note: 'Belgeler uygun (sentetik).' });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body).toMatchObject({ status: 'APPROVED', supplier: { status: 'CANDIDATE', stage: 'CANDIDATE', stageLabel: 'Aday', linkedToExisting: false },
      documentsMoved: 5, portalUser: { status: 'CREATED' } });
    const sid = r.body.supplier.id;
    const s = (await h.owner.query(`SELECT status, created_by, legal_name, tax_id, contact_name, contact_email, contact_phone, address, service_categories, services_offered, application_id
      FROM suppliers WHERE id = $1`, [sid])).rows[0];
    expect(s).toMatchObject({ status: 'CANDIDATE', created_by: h.world.users.buyer.id, tax_id: a.taxId, contact_name: 'Deniz Başvuru', contact_email: a.email,
      contact_phone: '0216 000 00 00', address: 'Sentetik Cad. 5, Ankara', service_categories: ['Bilgi teknolojileri'], services_offered: 'Sentetik ağ bakımı', application_id: a.id });
    expect((await h.owner.query(`SELECT count(*)::int AS n FROM supplier_documents WHERE application_id = $1 AND supplier_id = $2`, [a.id, sid])).rows[0].n).toBe(5);
    // Davetli kullanıcı + SUPPLIER üyeliği.
    const u = (await h.owner.query(`SELECT u.auth_subject, m.roles, m.company_ids, m.supplier_id, m.status FROM users u JOIN memberships m ON m.user_id = u.id
      WHERE lower(u.email) = $1 AND m.tenant_id = $2`, [a.email, h.world.tenantA])).rows;
    expect(u).toEqual([{ auth_subject: `invite|${a.email}`, roles: ['SUPPLIER'], company_ids: [], supplier_id: sid, status: 'ACTIVE' }]);
    // İki e-posta satırı (portal erişimi + karar), kanal yok → NOT_CONFIGURED.
    const mails = (await h.owner.query(`SELECT subject, status, to_user_id IS NOT NULL AS to_user FROM email_outbox WHERE related_type = 'supplier_application' AND related_id = $1
      AND subject <> 'Tedarikçi başvurunuz: e-posta doğrulaması' ORDER BY subject`, [a.id])).rows;
    expect(mails).toEqual([
      { subject: 'Tedarikçi başvurunuz kabul edildi', status: 'NOT_CONFIGURED', to_user: false },
      { subject: 'Tedarikçi portalı erişiminiz hazır', status: 'NOT_CONFIGURED', to_user: true },
    ]);
    expect(r.body.emails.map((e: any) => e.status)).toEqual(['NOT_CONFIGURED', 'NOT_CONFIGURED']);
    // İnceleme görevi kapandı; aday onay görevi Satınalma'da.
    expect(await openTasks(`application:${a.id}:review`)).toHaveLength(0);
    expect(await openTasks(`supplier:${sid}:activation`)).toEqual([{ kind: 'SUPPLIER_CANDIDATE_APPROVAL', assignee_role: 'PROCUREMENT' }]);
    const ev = (await h.owner.query(`SELECT data FROM audit_events WHERE action = 'supplier_application.approved' AND entity_id = $1`, [a.id])).rows;
    expect(ev).toHaveLength(1);
    expect(ev[0].data).toMatchObject({ supplierId: sid, documentsMoved: 5, portalUser: 'CREATED' });
    // İkinci karar: sonuçlanmış başvuru değişmez.
    expect((await decide(a.id, { action: 'REJECT', reason: 'Tekrar karar denemesi (sentetik).' })).body.error.code).toBe('invalid_transition');

    // R10: onaylayan kişi Onaylı yapamaz (mevcut 403); ikinci Satınalma kullanıcısı onay + aktivasyon → ACTIVE.
    const card = (await h.call('buyer', 'GET', `/api/v1/suppliers/${sid}`)).body;
    expect(card.isCreator).toBe(true);
    const own = await h.call('buyer', 'POST', `/api/v1/suppliers/${sid}/approvals`, { body: { kind: 'MASTER_DATA', decision: 'APPROVED', rationale: 'Kendi açtığım kart (sentetik)', expectedRowVersion: card.rowVersion } });
    expect(own.status).toBe(403);
    expect((await h.call('buyer', 'POST', `/api/v1/suppliers/${sid}/activate`, { body: { expectedRowVersion: card.rowVersion } })).body.error.code).toBe('sod_violation');
    expect((await h.call('legal', 'POST', `/api/v1/suppliers/${sid}/approvals`, { body: { kind: 'MASTER_DATA', decision: 'APPROVED', rationale: 'Kimlik ve belgeler incelendi (sentetik)', expectedRowVersion: card.rowVersion } })).status).toBe(204);
    expect((await h.call('legal2', 'POST', `/api/v1/suppliers/${sid}/activate`, { body: { expectedRowVersion: card.rowVersion } })).status).toBe(204);
    const after = (await h.call('buyer', 'GET', `/api/v1/suppliers/${sid}`)).body;
    expect(after).toMatchObject({ status: 'ACTIVE', stage: 'APPROVED', stageLabel: 'Onaylı' });
    expect(after.supplierDocuments).toHaveLength(5);
    expect(after.portalUsers).toEqual([expect.objectContaining({ email: a.email, status: 'ACTIVE', firstLogin: 'PENDING' })]);
  });

  it('existing_active_card_with_same_vkn_is_linked_not_duplicated', async () => {
    const vkn = validVkn();
    const existing = (await h.owner.query<{ id: string }>(`INSERT INTO suppliers (tenant_id, status, country, tax_id_type, tax_id, legal_name, created_by, activated_by, activated_at)
      VALUES ($1,'ACTIVE','TR','VKN',$2,'Mevcut Onaylı Firma A.Ş. (SENTETİK)',$3,$4,now()) RETURNING id`,
      [h.world.tenantA, vkn, h.world.users.masterData.id, h.world.users.legal.id])).rows[0]!.id;
    const a = await submitted({ taxId: vkn });
    const d = await detail(a.id);
    expect(d.body.existingSupplier).toMatchObject({ id: existing, status: 'ACTIVE', stageLabel: 'Onaylı', blocksApproval: false, contactEmail: null, portalUserCount: 0 });
    const before = (await h.owner.query(`SELECT count(*)::int AS n FROM suppliers WHERE tenant_id = $1 AND tax_id = $2`, [h.world.tenantA, vkn])).rows[0].n;
    const r = await decide(a.id, { action: 'APPROVE' });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.supplier).toMatchObject({ id: existing, status: 'ACTIVE', linkedToExisting: true });
    // İnceleme I1: mevcut karta bağlanınca portal kullanıcısı açılmaz, erişim e-postası yazılmaz.
    expect(r.body.portalUser).toEqual({ status: 'SKIPPED_EXISTING_CARD', userId: null,
      message: 'Mevcut tedarikçi kartına bağlandı; portal kullanıcısını kartı doğruladıktan sonra karttan ekleyin.' });
    expect((await h.owner.query(`SELECT count(*)::int AS n FROM memberships WHERE supplier_id = $1`, [existing])).rows[0].n).toBe(0);
    expect((await h.owner.query(`SELECT count(*)::int AS n FROM users WHERE lower(email) = $1`, [a.email])).rows[0].n).toBe(0);
    expect(r.body.emails.map((e: any) => e.kind)).toEqual(['decision']);
    expect((await h.owner.query(`SELECT count(*)::int AS n FROM suppliers WHERE tenant_id = $1 AND tax_id = $2`, [h.world.tenantA, vkn])).rows[0].n).toBe(before);
    expect((await h.owner.query(`SELECT status FROM suppliers WHERE id = $1`, [existing])).rows[0].status).toBe('ACTIVE');
    expect((await h.owner.query(`SELECT supplier_id FROM supplier_applications WHERE id = $1`, [a.id])).rows[0].supplier_id).toBe(existing);
    // Onaylı kartta aday onay görevi açılmaz.
    expect(await openTasks(`supplier:${existing}:activation`)).toHaveLength(0);
  });

  it('passive_card_with_same_vkn_blocks_approval_409', async () => {
    const vkn = validVkn();
    const passive = (await h.owner.query<{ id: string }>(`INSERT INTO suppliers (tenant_id, status, country, tax_id_type, tax_id, legal_name, created_by)
      VALUES ($1,'SUSPENDED','TR','VKN',$2,'Pasif Eski Firma Ltd. (SENTETİK)',$3) RETURNING id`, [h.world.tenantA, vkn, h.world.users.masterData.id])).rows[0]!.id;
    const a = await submitted({ taxId: vkn });
    const d = await detail(a.id);
    expect(d.body.existingSupplier).toMatchObject({ id: passive, stageLabel: 'Pasif', blocksApproval: true });
    expect(d.body.existingSupplier.blockReason).toMatch(/pasif/);
    expect(d.body.can.approve).toBe(false);
    const r = await decide(a.id, { action: 'APPROVE' });
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe('supplier_inactive');
    expect((await h.owner.query(`SELECT status, supplier_id FROM supplier_applications WHERE id = $1`, [a.id])).rows[0]).toEqual({ status: 'SUBMITTED', supplier_id: null });
    expect((await h.owner.query(`SELECT status FROM suppliers WHERE id = $1`, [passive])).rows[0].status).toBe('SUSPENDED');
  });

  it('approved_application_with_later_suspended_card_is_informational_not_blocking', async () => {
    const a = await submitted();
    const r = await decide(a.id, { action: 'APPROVE' });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    await h.owner.query(`UPDATE suppliers SET status = 'SUSPENDED' WHERE id = $1`, [r.body.supplier.id]);
    const d = await detail(a.id);
    expect(d.body.status).toBe('APPROVED');
    expect(d.body.existingSupplier).toMatchObject({ blocksApproval: false, blockReason: null, stageLabel: 'Pasif' });
    expect(d.body).toMatchObject({ supplierStage: 'PASSIVE', supplierStageLabel: 'Pasif' });
    expect(d.body.supplierStateMessage).toMatch(/karara bağlandı.*pasif/);
  });

  it('portal_user_email_in_other_tenant_does_not_block_approval', async () => {
    const a = await submitted();
    // Başvuru e-postası başka kiracıdaki kullanıcınınkiyle aynı (046: NULL döner, hiçbir şey açılmaz).
    await h.owner.query(`UPDATE supplier_applications SET contact_email = $2 WHERE id = $1`, [a.id, h.world.users.buyerB.email]);
    const r = await decide(a.id, { action: 'APPROVE' });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.portalUser).toMatchObject({ status: 'USER_IN_OTHER_TENANT', userId: null });
    expect(r.body.portalUser.message).toMatch(/başka bir kurumda/);
    expect((await h.owner.query(`SELECT count(*)::int AS n FROM memberships WHERE supplier_id = $1`, [r.body.supplier.id])).rows[0].n).toBe(0);
  });
});

describe('Eksik belge ve red', () => {
  it('request_documents_then_public_complete_returns_to_submitted_with_new_task', async () => {
    const a = await submitted();
    expect((await decide(a.id, { action: 'REQUEST_DOCUMENTS', documents: [] })).body.error.code).toBe('documents_required');
    expect((await decide(a.id, { action: 'REQUEST_DOCUMENTS', documents: ['YOK_BOYLE'] })).body.error.code).toBe('document_type');
    const r = await decide(a.id, { action: 'REQUEST_DOCUMENTS', documents: ['IMZA_SIRKULERI'], note: 'Güncel imza sirküleri gerekli (sentetik).' });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body).toMatchObject({ status: 'NEEDS_DOCUMENTS', statusLabel: 'Eksik belge bekleniyor', requestedDocuments: ['IMZA_SIRKULERI'] });
    expect(JSON.stringify(r.body)).not.toContain('token');
    expect(await openTasks(`application:${a.id}:review`)).toHaveLength(0);
    const mail = (await h.owner.query<{ body_text: string; status: string }>(`SELECT body_text, status FROM email_outbox WHERE related_id = $1 AND subject = 'Tedarikçi başvurunuz: eksik belgeler'`, [a.id])).rows;
    expect(mail).toHaveLength(1);
    expect(mail[0]!.status).toBe('NOT_CONFIGURED');
    expect(mail[0]!.body_text).toContain('İmza sirküleri');
    const token = /\/basvuru\/tamamla#token=([A-Za-z0-9_-]+)/.exec(mail[0]!.body_text)![1]!;
    expect(mail[0]!.body_text).not.toMatch(/[?&]token=/);
    // Denetim kaydında belirteç yok.
    const ev = (await h.owner.query(`SELECT data::text AS d FROM audit_events WHERE action = 'supplier_application.documents_requested' AND entity_id = $1`, [a.id])).rows[0].d;
    expect(ev).not.toContain(token);
    // Eksik belge isteğinde onay yok (önce tamamlanmalı); red açık.
    expect((await decide(a.id, { action: 'APPROVE' })).body.error.code).toBe('invalid_transition');
    // Tedarikçi tamamlar (Görev 4 ucu) → SUBMITTED + yeni inceleme görevi.
    const m = multipart([], [doc('IMZA_SIRKULERI')]);
    const c = await h.app.inject({ method: 'POST', url: '/api/v1/public/applications/complete', payload: m.payload, remoteAddress: nextIp(),
      headers: { 'content-type': m.contentType, 'x-application-token': token } });
    expect(c.statusCode, c.body).toBe(200);
    await runJobs();
    expect((await detail(a.id)).body.status).toBe('SUBMITTED');
    expect(await openTasks(`application:${a.id}:review`)).toHaveLength(1);
    expect((await detail(a.id)).body.history.map((x: any) => x.code)).toContain('supplier_application.documents_requested');
  });

  it('expired_completion_link_can_be_resent_old_token_rejected_new_token_completes', async () => {
    const a = await submitted();
    const first = await decide(a.id, { action: 'REQUEST_DOCUMENTS', documents: ['IMZA_SIRKULERI'], note: 'İlk istek notu (sentetik).' });
    expect(first.status, JSON.stringify(first.body)).toBe(200);
    expect(first.body.resent).toBe(false);
    const mails = async () => (await h.owner.query<{ body_text: string; status: string }>(
      `SELECT body_text, status FROM email_outbox WHERE related_id = $1 AND subject = 'Tedarikçi başvurunuz: eksik belgeler' ORDER BY created_at, id`, [a.id])).rows;
    const tokenOf = (body: string) => /\/basvuru\/tamamla#token=([A-Za-z0-9_-]+)/.exec(body)![1]!;
    const oldToken = tokenOf((await mails())[0]!.body_text);
    // 24 saatlik bağlantı dolar.
    await h.owner.query(`UPDATE supplier_applications SET token_expires_at = now() - interval '1 minute' WHERE id = $1`, [a.id]);
    const info = async (t: string) => h.app.inject({ method: 'GET', url: '/api/v1/public/applications/complete-info', remoteAddress: nextIp(), headers: { 'x-application-token': t } });
    expect((await info(oldToken)).statusCode).toBe(410);
    const d = await detail(a.id);
    expect(d.body).toMatchObject({ status: 'NEEDS_DOCUMENTS', completionLinkExpired: true, can: { decide: true, approve: false, requestDocuments: false, resendLink: true } });
    expect(new Date(d.body.completionTokenExpiresAt).getTime()).toBeLessThan(Date.now());
    expect((await detail(a.id, 'techEval')).body.can.resendLink).toBe(false);
    expect((await decide(a.id, { action: 'REQUEST_DOCUMENTS' }, 'techEval')).status).toBe(403);
    // Yeniden gönderim: belge listesi verilmez, önceki istek ve not aynen; yeni belirteç, yeni e-posta (posta kapalı: NOT_CONFIGURED).
    const re = await decide(a.id, { action: 'REQUEST_DOCUMENTS' });
    expect(re.status, JSON.stringify(re.body)).toBe(200);
    expect(re.body).toMatchObject({ status: 'NEEDS_DOCUMENTS', requestedDocuments: ['IMZA_SIRKULERI'], resent: true, emails: [{ kind: 'documents_requested', status: 'NOT_CONFIGURED' }] });
    expect(new Date(re.body.completionTokenExpiresAt).getTime()).toBeGreaterThan(Date.now() + 23 * 3_600_000);
    expect(JSON.stringify(re.body)).not.toMatch(/token=|tokenHash/);
    const all = await mails();
    expect(all).toHaveLength(2);
    expect(all[1]!.status).toBe('NOT_CONFIGURED');
    expect(all[1]!.body_text).toContain('İlk istek notu (sentetik).');
    const newToken = tokenOf(all[1]!.body_text);
    expect(newToken).not.toBe(oldToken);
    const after = await detail(a.id);
    expect(after.body).toMatchObject({ completionLinkExpired: false, requestedNote: 'İlk istek notu (sentetik).', can: { resendLink: true } });
    expect(after.body.history.map((x: any) => x.label)).toContain('Tamamlama bağlantısı yeniden gönderildi');
    const ev = (await h.owner.query(`SELECT data::text AS d FROM audit_events WHERE action = 'supplier_application.link_resent' AND entity_id = $1`, [a.id])).rows;
    expect(ev).toHaveLength(1);
    expect(ev[0].d).not.toContain(newToken);
    // Eski belirteç artık geçmez; yenisiyle tamamlanır.
    expect((await info(oldToken)).statusCode).toBe(410);
    const complete = async (t: string) => {
      const m = multipart([], [doc('IMZA_SIRKULERI')]);
      return h.app.inject({ method: 'POST', url: '/api/v1/public/applications/complete', payload: m.payload, remoteAddress: nextIp(),
        headers: { 'content-type': m.contentType, 'x-application-token': t } });
    };
    expect((await complete(oldToken)).statusCode).toBe(410);
    const ok = await complete(newToken);
    expect(ok.statusCode, ok.body).toBe(200);
    await runJobs();
    const done = await detail(a.id);
    expect(done.body).toMatchObject({ status: 'SUBMITTED', completionTokenExpiresAt: null, completionLinkExpired: false, can: { resendLink: false, approve: true } });
    // Yeniden gönderim SUBMITTED'da belge listesi olmadan yapılamaz (yeni istek liste ister).
    expect((await decide(a.id, { action: 'REQUEST_DOCUMENTS' })).body.error.code).toBe('documents_required');
  });

  it('reject_requires_reason_and_writes_decision_email', async () => {
    const a = await submitted();
    const short = await decide(a.id, { action: 'REJECT', reason: 'kısa' });
    expect(short.status).toBe(422);
    expect(short.body.error.code).toBe('reason_required');
    expect((await decide(a.id, { action: 'REJECT' })).body.error.code).toBe('reason_required');
    const stale = await h.call('buyer', 'POST', `/api/v1/supplier-applications/${a.id}/decision`, { body: { action: 'REJECT', reason: 'Sürüm çakışması denemesi.', expectedRowVersion: 999 } });
    expect(stale.body.error.code).toBe('version_conflict');
    const r = await decide(a.id, { action: 'REJECT', reason: 'Hizmet kapsamı ihtiyacımızla örtüşmüyor (sentetik).' });
    expect(r.status).toBe(200);
    expect(r.body.status).toBe('REJECTED');
    const row = (await h.owner.query(`SELECT decision_reason, decided_by FROM supplier_applications WHERE id = $1`, [a.id])).rows[0];
    expect(row).toEqual({ decision_reason: 'Hizmet kapsamı ihtiyacımızla örtüşmüyor (sentetik).', decided_by: h.world.users.buyer.id });
    const mail = (await h.owner.query(`SELECT body_text, status FROM email_outbox WHERE related_id = $1 AND subject = 'Tedarikçi başvurunuz sonuçlandı'`, [a.id])).rows;
    expect(mail).toHaveLength(1);
    expect(mail[0].body_text).toContain('Gerekçe: Hizmet kapsamı');
    expect(await openTasks(`application:${a.id}:review`)).toHaveLength(0);
    expect((await h.owner.query(`SELECT count(*)::int AS n FROM suppliers WHERE tenant_id = $1 AND tax_id = $2`, [h.world.tenantA, a.taxId])).rows[0].n).toBe(0);
  });
});

describe('Tedarikçi belgesi içeriği', () => {
  it('internal_reads_with_audit_supplier_only_own_card_never_application_docs', async () => {
    const a = await submitted();
    const docId = (await detail(a.id)).body.documents[0].id;
    const r = await h.call('buyer', 'GET', `/api/v1/supplier-documents/${docId}/content`);
    expect(r.status).toBe(200);
    expect(r.headers['content-disposition']).toMatch(/^attachment; filename=/);
    expect(r.headers['x-content-type-options']).toBe('nosniff');
    expect(r.raw.subarray(0, 5).toString()).toBe('%PDF-');
    expect((await h.owner.query(`SELECT count(*)::int AS n FROM audit_events WHERE action = 'supplier_document.read' AND entity_id = $1`, [docId])).rows[0].n).toBe(1);
    // Başvuru belgesi tedarikçi oturumuna kapalı (supplier_id boş); başka kiracı da göremez.
    expect((await h.call('supplier1', 'GET', `/api/v1/supplier-documents/${docId}/content`)).status).toBe(404);
    expect((await h.call('buyerB', 'GET', `/api/v1/supplier-documents/${docId}/content`, { tenant: h.world.tenantB })).status).toBe(404);
  });
});
