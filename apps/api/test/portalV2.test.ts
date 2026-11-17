// v2 Faz 5 (D110) Görev 6: tedarikçi portalı API'si — davet e-postası (R8), Tekliflerim, Belgelerim (R12), Skorum ve risk (R15),
// Firma bilgileri (R14). Gerçek PostgreSQL + RLS ve yerel S3. Firmalar ve adresler sentetik (example.test). E-posta kanalı `none`.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { DevAuthProvider } from '../src/auth.ts';
import { withTenant } from '../src/db.ts';
import { systemContext } from '../src/modules/contractReminders.ts';
import { queueRoundInvites } from '../src/modules/portal.ts';
import { runDocumentReminders } from '../src/modules/supplierDocReminders.ts';
import { makeHarness } from './harness.ts';
import { reviewedAssessment, securityTemplate } from './evalHelpers.ts';

type H = Awaited<ReturnType<typeof makeHarness>>;
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
let h: H;
const auth = new DevAuthProvider('test-secret-'.padEnd(40, 'x'));
const rand = () => randomUUID().slice(0, 8);
const istanbulToday = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Istanbul' }).format(new Date());
const isoDay = (offset: number) => new Date(Date.parse(`${istanbulToday()}T00:00:00Z`) + offset * 86_400_000).toISOString().slice(0, 10);
const inHours = (n: number) => new Date(Date.now() + n * 3600_000).toISOString();
const pdf = () => Buffer.concat([Buffer.from('%PDF-1.4\n1 0 obj << /Type /Page >> endobj\n'), Buffer.alloc(600, 0x20), Buffer.from(`\n% ${randomUUID()}\n%%EOF`)]);

async function newSupplier(status = 'ACTIVE', name = `Portal Firma ${rand()} A.Ş. (SENTETİK)`) {
  return (await h.owner.query<{ id: string }>(`INSERT INTO suppliers (tenant_id, status, country, tax_id_type, tax_id, legal_name, created_by, activated_by, activated_at)
    VALUES ($1,$2,'TR','VKN',$3,$4,$5,$6,$7) RETURNING id`, [h.world.tenantA, status, validVkn(), name, h.world.users.masterData.id,
    ['ACTIVE', 'CONDITIONAL'].includes(status) ? h.world.users.legal.id : null, ['ACTIVE', 'CONDITIONAL'].includes(status) ? new Date() : null])).rows[0]!.id;
}
async function portalUser(supplierId: string, status: 'ACTIVE' | 'SUSPENDED' = 'ACTIVE') {
  const email = `portal-${rand()}@example.test`;
  const id = (await h.owner.query<{ id: string }>(`INSERT INTO users (auth_subject, email, display_name) VALUES ($1,$2,'Portal Kişisi (SENTETİK)') RETURNING id`, [`dev|${email}`, email])).rows[0]!.id;
  await h.owner.query(`INSERT INTO memberships (tenant_id, user_id, roles, company_ids, supplier_id, status) VALUES ($1,$2,ARRAY['SUPPLIER'],'{}',$3,$4)`, [h.world.tenantA, id, supplierId, status]);
  return { id, email, token: await auth.issue(`dev|${email}`) };
}
async function as(token: string, method: string, url: string, body?: unknown) {
  const r = await h.app.inject({ method: method as any, url, headers: { authorization: `Bearer ${token}`, 'x-tenant-id': h.world.tenantA }, ...(body !== undefined ? { payload: body as any } : {}) });
  return { status: r.statusCode, body: JSON.parse(r.body || 'null') };
}
async function portalUpload(token: string, fields: Record<string, string>, data = pdf()) {
  const b = '----spportal' + randomUUID();
  const parts: Buffer[] = Object.entries(fields).map(([k, v]) => Buffer.from(`--${b}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`));
  parts.push(Buffer.from(`--${b}\r\nContent-Disposition: form-data; name="file"; filename="belge.pdf"\r\nContent-Type: application/pdf\r\n\r\n`), data, Buffer.from(`\r\n--${b}--\r\n`));
  const r = await h.app.inject({ method: 'POST', url: '/api/v1/portal/documents', payload: Buffer.concat(parts),
    headers: { authorization: `Bearer ${token}`, 'x-tenant-id': h.world.tenantA, 'content-type': `multipart/form-data; boundary=${b}` } });
  return { status: r.statusCode, body: JSON.parse(r.body || 'null') };
}
async function publishRound(title: string, suppliers: string[]) {
  const p = await h.call('buyer', 'POST', '/api/v1/projects', { body: { companyId: h.world.companyA1.id, title, category: 'BT hizmetleri',
    need: 'Sentetik kapsam: sunucu bakımı ve yerinde destek. '.repeat(30), currency: 'TRY', budget: '500000.00', budgetVerified: false,
    lines: [{ description: 'Sunucu bakımı', unit: 'ay', quantity: '12' }], criteria: [{ code: 'PRICE', name: 'Fiyat', kind: 'PRICE', weight: '100' }] } });
  expect(p.status).toBe(201);
  const snap = (await h.call('buyer', 'GET', `/api/v1/projects/${p.body.id}`)).body;
  const req = await h.call('buyer', 'POST', `/api/v1/projects/${p.body.id}/rounds`, { body: { closesAt: inHours(72), supplierIds: suppliers }, headers: { 'if-match': snap.project.etag } });
  expect(req.status).toBe(201);
  const dec = await h.call('legal2', 'POST', `/api/v1/rfq-rounds/${req.body.roundId}/decision`, { body: { approve: true } });
  expect(dec.status).toBe(200);
  return { projectId: p.body.id as string, roundId: req.body.roundId as string, decision: dec.body };
}

beforeAll(async () => {
  h = await makeHarness();
  const put = await h.call('tenantAdmin', 'PUT', '/api/v1/settings/supplier-applications', { body: { enabled: true, publicSlug: `pv-${rand()}`, categories: ['Bilgi teknolojileri'] } });
  expect(put.status).toBe(200);
});
afterAll(async () => { await h?.close(); });

describe('R8 davet e-postası', () => {
  it('one_row_per_active_portal_user_task_for_missing_user_no_duplicates_and_honest_status', async () => {
    const a = await newSupplier('ACTIVE', `Davetli A ${rand()} (SENTETİK)`);
    const b = await newSupplier('ACTIVE', `Davetli B ${rand()} (SENTETİK)`);
    const ua = await portalUser(a);
    const suspended = await portalUser(a, 'SUSPENDED');
    const title = `Portal davet projesi ${rand()}`;
    const { projectId, roundId, decision } = await publishRound(title, [a, b]);
    expect(decision).toMatchObject({ status: 'OPEN', invites: { queued: 1, missingUsers: [b] } });

    const rows = (await h.owner.query(`SELECT to_user_id, to_email, subject, body_text, status FROM email_outbox WHERE related_type = 'rfq_round_invite' AND related_id = $1`, [roundId])).rows;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ to_user_id: ua.id, to_email: ua.email, subject: `Teklif daveti: ${title}`, status: 'NOT_CONFIGURED' });
    expect(rows[0].body_text).toContain(`http://localhost:5174/portal/${roundId}`);
    expect(rows[0].body_text).toContain('(İstanbul saati)');
    expect(rows[0].body_text).toContain('…'); // kapsam 600 karakterde kesilir
    expect(rows.some((r: any) => r.to_user_id === suspended.id)).toBe(false);

    const task = (await h.owner.query(`SELECT assignee_role, title, status FROM tasks WHERE tenant_id = $1 AND dedupe_key = $2`, [h.world.tenantA, `round:${roundId}:no_portal_user:${b}`])).rows;
    expect(task).toEqual([{ assignee_role: 'PROCUREMENT', title: 'Tedarikçinin portal kullanıcısı yok', status: 'OPEN' }]);

    // İkinci onay denemesi ve işçi/çağrı tekrarı çift satır ya da görev yazmaz.
    expect((await h.call('legal2', 'POST', `/api/v1/rfq-rounds/${roundId}/decision`, { body: { approve: true } })).status).toBe(409);
    const ctx = { ...systemContext(h.world.tenantA, [h.world.companyA1.id], 'rerun') };
    expect(await withTenant(h.pool, ctx, (tx) => queueRoundInvites(tx, ctx, roundId, 'http://localhost:5174'))).toEqual({ queued: 0, missingUsers: [b] });
    expect((await h.owner.query(`SELECT count(*)::int AS n FROM email_outbox WHERE related_type = 'rfq_round_invite' AND related_id = $1`, [roundId])).rows[0].n).toBe(1);
    expect((await h.owner.query(`SELECT count(*)::int AS n FROM tasks WHERE dedupe_key = $1`, [`round:${roundId}:no_portal_user:${b}`])).rows[0].n).toBe(1);

    // İç ekran: davetin e-posta durumu dürüst ("gönderildi" yazmaz).
    const p = (await h.call('buyer', 'GET', `/api/v1/projects/${projectId}`)).body;
    const byId = new Map(p.round.inviteEmails.map((x: any) => [x.supplierId, x]));
    expect(byId.get(a)).toEqual({ supplierId: a, status: 'NOT_CONFIGURED', statusLabel: 'Gönderilmedi — e-posta kanalı yapılandırılmadı', recipients: 1 });
    expect(byId.get(b)).toMatchObject({ status: 'NONE', statusLabel: 'Portal kullanıcısı yok; davet e-postası yazılmadı', recipients: 0 });

    // Davetli kendi turunu Tekliflerim'de görür; davet edilmeyen tedarikçi görmez ve tur adresi 404.
    const mine = await as(ua.token, 'GET', '/api/v1/portal/bids');
    expect(mine.status).toBe(200);
    expect(mine.body.items.find((x: any) => x.roundId === roundId)).toMatchObject({ projectTitle: title, open: true, roundStatusLabel: 'Açık', myBid: null,
      bidStatusLabel: 'Teklif verilmedi', link: `/portal/${roundId}` });
    const other = await portalUser(await newSupplier());
    expect((await as(other.token, 'GET', '/api/v1/portal/bids')).body.items.some((x: any) => x.roundId === roundId)).toBe(false);
    expect((await as(other.token, 'GET', `/api/v1/portal/rounds/${roundId}`)).status).toBe(404);
  });

  it('rejected_publish_writes_no_invite', async () => {
    const a = await newSupplier();
    await portalUser(a);
    const p = await h.call('buyer', 'POST', '/api/v1/projects', { body: { companyId: h.world.companyA1.id, title: `Reddedilen yayın ${rand()}`, category: 'BT hizmetleri',
      need: 'Sentetik', currency: 'TRY', budget: '1000.00', budgetVerified: false, lines: [{ description: 'Bakım', unit: 'ay', quantity: '1' }],
      criteria: [{ code: 'PRICE', name: 'Fiyat', kind: 'PRICE', weight: '100' }] } });
    const snap = (await h.call('buyer', 'GET', `/api/v1/projects/${p.body.id}`)).body;
    const req = await h.call('buyer', 'POST', `/api/v1/projects/${p.body.id}/rounds`, { body: { closesAt: inHours(72), supplierIds: [a, h.world.suppliers.s1] }, headers: { 'if-match': snap.project.etag } });
    const dec = await h.call('legal2', 'POST', `/api/v1/rfq-rounds/${req.body.roundId}/decision`, { body: { approve: false, note: 'Kapsam netleşmeli.' } });
    expect(dec.body).toEqual({ status: 'CANCELLED' });
    expect((await h.owner.query(`SELECT count(*)::int AS n FROM email_outbox WHERE related_id = $1`, [req.body.roundId])).rows[0].n).toBe(0);
  });
});

describe('Tekliflerim', () => {
  it('own_bid_amounts_only', async () => {
    const a = await newSupplier();
    const b = await newSupplier();
    const ua = await portalUser(a);
    const ub = await portalUser(b);
    const { roundId } = await publishRound(`Tekliflerim projesi ${rand()}`, [a, b]);
    const round = (await as(ua.token, 'GET', `/api/v1/portal/rounds/${roundId}`)).body;
    const lineId = round.lines[0].id ?? round.lines[0].projectLineId;
    const bid = (who: string, price: string) => h.app.inject({ method: 'POST', url: `/api/v1/portal/rounds/${roundId}/bids`,
      headers: { authorization: `Bearer ${who}`, 'x-tenant-id': h.world.tenantA, 'idempotency-key': randomUUID() },
      payload: { currency: 'TRY', lines: [{ projectLineId: lineId, unit: 'ay', quantity: '12', unitPrice: price, scope: 'INCLUDED' }], costs: [{ kind: 'SHIPPING', amount: '100.00' }] } });
    expect((await bid(ua.token, '1000.50')).statusCode).toBe(201);
    expect((await bid(ua.token, '1000.00')).statusCode).toBe(201);
    expect((await bid(ub.token, '777.00')).statusCode).toBe(201);
    const item = (await as(ua.token, 'GET', '/api/v1/portal/bids')).body.items.find((x: any) => x.roundId === roundId);
    expect(item.myBid).toMatchObject({ versionNo: 2, currency: 'TRY', linesTotal: '12000.00', costsTotal: '100.00', total: '12100.00' });
    expect(item.versionCount).toBe(2);
    expect(item.bidStatusLabel).toBe('Teklif verildi (sürüm 2)');
    expect(JSON.stringify(item)).not.toContain('9324'); // B'nin tutarı (12 × 777) yok
    expect(Object.keys(item).sort()).toEqual(['bidStatusLabel', 'buyerName', 'closesAt', 'invitedAt', 'link', 'myBid', 'open', 'projectCode', 'projectId',
      'projectTitle', 'roundId', 'roundNo', 'roundStatus', 'roundStatusLabel', 'versionCount']);
  });
});

describe('Belgelerim (R12)', () => {
  it('renewal_supersedes_old_closes_expired_task_opens_info_task_and_isolated', async () => {
    const a = await newSupplier();
    const ua = await portalUser(a);
    // Eski belge bugün sona eriyor (iç yükleme yolu yerine doğrudan); hatırlatma işi bitiş gününde görev açar.
    const first = await portalUpload(ua.token, { typeCode: 'VERGI_LEVHASI', validUntil: isoDay(0) });
    expect(first.status).toBe(201);
    expect(first.body).toMatchObject({ uploadedVia: 'PORTAL', uploadedViaLabel: 'Firmanız yükledi', current: true, validity: 'EXPIRING', avScanStatus: 'NOT_CONFIGURED',
      avScanLabel: 'Virüs taraması yapılandırılmadı' });
    expect(first.body).not.toHaveProperty('uploadedByName');
    const ctx = systemContext(h.world.tenantA, [], 'doc-test');
    await withTenant(h.pool, ctx, (tx) => runDocumentReminders(tx, ctx, isoDay(0), 'http://localhost:5174'));
    const expiredKey = `doc:${first.body.id}:expired`;
    expect((await h.owner.query(`SELECT status FROM tasks WHERE dedupe_key = $1`, [expiredKey])).rows).toEqual([{ status: 'OPEN' }]);

    // Geçmiş tarihli belge ve tarihsiz zorunlu tür reddedilir.
    expect((await portalUpload(ua.token, { typeCode: 'VERGI_LEVHASI', validUntil: isoDay(-1) })).body.error.code).toBe('valid_until_past');
    expect((await portalUpload(ua.token, { typeCode: 'VERGI_LEVHASI' })).body.error.code).toBe('valid_until_required');

    const renewed = await portalUpload(ua.token, { typeCode: 'VERGI_LEVHASI', validUntil: isoDay(365), replacesId: first.body.id });
    expect(renewed.status).toBe(201);
    expect(renewed.body).toMatchObject({ replacesId: first.body.id, validity: 'VALID', current: true });
    const old = (await h.owner.query(`SELECT superseded_by_id FROM supplier_documents WHERE id = $1`, [first.body.id])).rows[0];
    expect(old.superseded_by_id).toBe(renewed.body.id);
    expect((await h.owner.query(`SELECT status FROM tasks WHERE dedupe_key = $1`, [expiredKey])).rows).toEqual([{ status: 'DONE' }]);
    const info = (await h.owner.query(`SELECT title, assignee_role, status FROM tasks WHERE dedupe_key = $1`, [`supplier-document:${renewed.body.id}:portal`])).rows;
    expect(info).toEqual([{ title: 'Tedarikçi belge yeniledi', assignee_role: 'PROCUREMENT', status: 'OPEN' }]);
    // Aynı belge ikinci kez yenilenemez.
    expect((await portalUpload(ua.token, { typeCode: 'VERGI_LEVHASI', validUntil: isoDay(300), replacesId: first.body.id })).body.error.code).toBe('already_superseded');

    const list = (await as(ua.token, 'GET', '/api/v1/portal/documents')).body;
    expect(list.documents.map((d: any) => d.id)).toEqual(expect.arrayContaining([first.body.id, renewed.body.id]));
    expect(list.documents.find((d: any) => d.id === first.body.id)).toMatchObject({ current: false, supersededLabel: 'Yerine yenisi yüklendi' });
    expect(list.types.find((t: any) => t.code === 'VERGI_LEVHASI')).toMatchObject({ required: true, expiryRequired: true });
    expect(list.missing.map((m: any) => m.code)).not.toContain('VERGI_LEVHASI');
    expect(list.missing.map((m: any) => m.code)).toContain('IMZA_SIRKULERI');
    expect(JSON.stringify(list)).not.toContain('uploadedByName');

    // Tedarikçi B, A'nın belgesini göremez, açamaz, yenileyemez.
    const ub = await portalUser(await newSupplier());
    const other = (await as(ub.token, 'GET', '/api/v1/portal/documents')).body;
    expect(other.documents).toEqual([]);
    expect((await as(ub.token, 'GET', `/api/v1/supplier-documents/${renewed.body.id}/content`)).status).toBe(404);
    expect((await portalUpload(ub.token, { typeCode: 'VERGI_LEVHASI', validUntil: isoDay(200), replacesId: renewed.body.id })).body.error.code).toBe('replaces_not_found');
    // İç kullanıcı portal ucunu kullanamaz.
    expect((await h.call('buyer', 'GET', '/api/v1/portal/documents')).status).toBe(403);
  });
});

describe('Skorum ve risk (R15) ve özet', () => {
  it('standing_has_only_allowed_keys_and_summary_shape', async () => {
    const a = await newSupplier();
    const ua = await portalUser(a);
    const tpl = await securityTemplate(h);
    const assessmentId = await reviewedAssessment(h, a, tpl, {}, { dataSensitivity: 'HIGH', accessLevel: 'LOW', criticality: 'LOW', substitutability: 'LOW', subcontractorDependence: 'LOW' });
    // Kalan risk kararı (gerekçesi tedarikçiye gösterilmez).
    await h.owner.query(`UPDATE supplier_assessments SET residual_level = 'MEDIUM', residual_reason = 'GİZLİ-GEREKÇE: iç değerlendirme notu, tedarikçiye gösterilmez.',
      residual_accepted_by = $2, residual_accepted_at = now() WHERE id = $1`, [assessmentId, h.world.users.security.id]);
    const s = await as(ua.token, 'GET', '/api/v1/portal/standing');
    expect(s.status).toBe(200);
    expect(Object.keys(s.body).sort()).toEqual(['assessment', 'expectedActions', 'levelLabel', 'levelSource', 'levelSourceLabel', 'risk', 'score', 'scoreReason', 'year']);
    const text = JSON.stringify(s.body);
    for (const k of ['inherentFactors', 'inherent_factors', 'residualReason', 'residual_reason', 'scoreRiskLevel', 'note', 'comment', 'criticality', 'reviewNote', 'description', 'displayName']) {
      expect(text).not.toContain(k);
    }
    expect(text).not.toContain('GİZLİ-GEREKÇE');
    expect(s.body).toMatchObject({ levelSource: 'SUPPLIER_ASSESSMENT', levelLabel: 'orta', assessment: { level: 'MEDIUM', levelLabel: 'orta' }, risk: null });
    expect(typeof s.body.score === 'number' || s.body.score === null).toBe(true);

    const sum = await as(ua.token, 'GET', '/api/v1/portal/summary');
    expect(sum.status).toBe(200);
    expect(Object.keys(sum.body).sort()).toEqual(['documents', 'openInvites', 'pendingSurveys', 'standing']);
    expect(Object.keys(sum.body.documents).sort()).toEqual(['expired', 'expiring', 'missing']);
    expect(sum.body.standing).toEqual({ score: s.body.score, levelLabel: s.body.levelLabel });
    expect(sum.body.documents.missing).toBeGreaterThan(0);

    // Başka tedarikçinin oturumu A'nın değerlendirmesini görmez (kendi boş standing'i).
    const ub = await portalUser(await newSupplier());
    const sb = (await as(ub.token, 'GET', '/api/v1/portal/standing')).body;
    expect(sb).toMatchObject({ levelSource: null, levelLabel: null, risk: null, assessment: null });
    expect((await h.call('buyer', 'GET', '/api/v1/portal/standing')).status).toBe(403);
  });
});

describe('Firma bilgileri (R14)', () => {
  it('update_changes_only_three_fields_and_change_request_opens_task', async () => {
    const a = await newSupplier();
    const ua = await portalUser(a);
    const before = (await h.owner.query(`SELECT legal_name, tax_id, status, contact_email FROM suppliers WHERE id = $1`, [a])).rows[0];
    const g = await as(ua.token, 'GET', '/api/v1/portal/profile');
    expect(g.status).toBe(200);
    expect(g.body).toMatchObject({ legalName: before.legal_name, taxId: before.tax_id, editableFields: ['contactName', 'contactPhone', 'address'], pendingChangeRequests: [] });

    const u = await as(ua.token, 'PUT', '/api/v1/portal/profile', { contactName: 'Ayşe Örnek', contactPhone: '+90 212 555 00 00', address: 'Örnek Mah. 1, İstanbul' });
    expect(u.status).toBe(200);
    expect(u.body).toMatchObject({ contactName: 'Ayşe Örnek', contactPhone: '+90 212 555 00 00', address: 'Örnek Mah. 1, İstanbul', changed: ['contactName', 'contactPhone', 'address'] });
    const after = (await h.owner.query(`SELECT legal_name, tax_id, status, contact_email, contact_name FROM suppliers WHERE id = $1`, [a])).rows[0];
    expect(after).toEqual({ ...before, contact_name: 'Ayşe Örnek' });
    // Unvan/VKN gövdede gelirse reddedilir (veri değişmez).
    expect((await as(ua.token, 'PUT', '/api/v1/portal/profile', { contactName: 'Ayşe Örnek', taxId: '1234567890' })).status).toBe(400);
    expect((await as(ua.token, 'PUT', '/api/v1/portal/profile', { contactName: 'A' })).body.error.code).toBe('invalid_field');
    expect((await h.owner.query(`SELECT tax_id FROM suppliers WHERE id = $1`, [a])).rows[0].tax_id).toBe(before.tax_id);
    expect((await h.owner.query(`SELECT count(*)::int AS n FROM audit_events WHERE action = 'supplier.profile.portal_updated' AND entity_id = $1`, [a])).rows[0].n).toBe(1);

    expect((await as(ua.token, 'POST', '/api/v1/portal/profile/change-request', { field: 'TAX_ID', note: 'kısa' })).body.error.code).toBe('note_required');
    const cr = await as(ua.token, 'POST', '/api/v1/portal/profile/change-request', { field: 'LEGAL_NAME', note: 'Unvanımız Örnek Teknoloji A.Ş. olarak değişti; sicil gazetesi ektedir.' });
    expect(cr.status).toBe(201);
    expect(cr.body).toMatchObject({ requested: true, field: 'LEGAL_NAME', fieldLabel: 'Unvan' });
    const t = (await h.owner.query(`SELECT title, assignee_role, status, reason FROM tasks WHERE kind = 'supplier_profile_change_request' AND entity_id = $1`, [a])).rows;
    expect(t).toHaveLength(1);
    expect(t[0]).toMatchObject({ title: 'Tedarikçi bilgi değişikliği isteği: Unvan', assignee_role: 'PROCUREMENT', status: 'OPEN' });
    expect(t[0].reason).toContain('sicil gazetesi');
    expect((await h.owner.query(`SELECT legal_name FROM suppliers WHERE id = $1`, [a])).rows[0].legal_name).toBe(before.legal_name);
    expect((await as(ua.token, 'GET', '/api/v1/portal/profile')).body.pendingChangeRequests).toEqual([expect.objectContaining({ field: 'LEGAL_NAME', fieldLabel: 'Unvan' })]);

    // Tedarikçi B, A'nın firma bilgisini görmez.
    const ub = await portalUser(await newSupplier());
    expect((await as(ub.token, 'GET', '/api/v1/portal/profile')).body.legalName).not.toBe(before.legal_name);
  });
});
