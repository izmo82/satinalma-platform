// v2 Faz 1 (D93/D95): TenantContext departmentIds/allDepartments ister; Yönetici belge okur (şirket kapsamı RLS'de); T07 ayrılığı iki ayrı Satınalma kullanıcısıyla
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { syntheticVkn } from '@sp/domain';
import { createPool, withTenant } from '../src/db.ts';
import { syntheticPdf, ublInvoiceXml } from '../src/devdata.ts';
import { makeHarness } from './harness.ts';
import { TEST_APP_URL } from './env.ts';

let h: Awaited<ReturnType<typeof makeHarness>>;
beforeAll(async () => { h = await makeHarness(); });
afterAll(async () => { await h.close(); });

let n = 0;
/** Sentetik, mod-97 geçerli TR IBAN (gerçek hesap değildir). */
function makeTrIban(bban22: string) {
  const rem = [...(bban22 + '2927' + '00')].reduce((r, d) => (r * 10 + Number(d)) % 97, 0);
  return `TR${String(98 - rem).padStart(2, '0')}${bban22}`;
}
const invoice = (o: Partial<Parameters<typeof ublInvoiceXml>[0]> & { sellerVkn: string | null }) => ({
  name: `fatura-${++n}.xml`, mime: 'application/xml',
  data: ublInvoiceXml({ invoiceNo: `SNT2026${String(n).padStart(9, '0')}`, ettn: randomUUID(), sellerName: 'Sentetik Tedarik Ltd. Şti.',
    buyerVkn: h.world.companyA1.vkn, buyerName: h.world.companyA1.name, ...o }),
});
const uploadInvoice = (who: 'buyer' | 'masterData' | 'finance', inv: ReturnType<typeof invoice>, company = h.world.companyA1.id) =>
  h.upload(who, inv, { companyId: company, kind: 'INVOICE', title: inv.name });

describe('T01 kiracı izolasyonu', () => {
  it('B kiracısı kullanıcısı A kaynaklarına kimlik, dosya ve listeyle erişemez', async () => {
    const up = await uploadInvoice('buyer', invoice({ sellerVkn: syntheticVkn('300000001') }));
    expect(up.status).toBe(201);
    const dv = up.body.documentVersionId;
    const sup = up.body.supplier.supplierId;

    for (const url of [`/api/v1/document-versions/${dv}`, `/api/v1/document-versions/${dv}/content`, `/api/v1/suppliers/${sup}`]) {
      const r = await h.call('buyerB', 'GET', url, { tenant: h.world.tenantB });
      expect(r.status, url).toBe(404);
    }
    const list = await h.call('buyerB', 'GET', '/api/v1/suppliers', { tenant: h.world.tenantB });
    expect(list.body.items.find((s: any) => s.id === sup)).toBeUndefined();
    // Üye olmadığı kiracıyı başlıkla seçmek bağlam vermez.
    const forged = await h.call('buyerB', 'GET', `/api/v1/suppliers/${sup}`, { tenant: h.world.tenantA });
    expect(forged.status).toBe(403);
    expect(forged.body.error.code).toBe('tenant_not_selected');
    // Tahmin edilen nesne anahtarı: API dışı erişim yok; anahtar kiracı önekli.
    expect(up.body.sha256).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('T02 şirket kapsamı', () => {
  it('aynı kiracıda yetkisiz şirket belgesi reddedilir; kiracı yöneticisi otomatik görmez', async () => {
    const up = await uploadInvoice('masterData', invoice({ sellerVkn: syntheticVkn('300000002') }), h.world.companyA2.id);
    expect(up.status).toBe(201);
    const url = `/api/v1/document-versions/${up.body.documentVersionId}`;
    expect((await h.call('buyer', 'GET', url)).status).toBe(404); // buyer yalnız A1
    // v2 (D93): Yönetici belge okuma iznine sahip, ama şirket kapsamı boş: RLS kaydı göstermez (otomatik görmez).
    expect((await h.call('tenantAdmin', 'GET', url)).status).toBe(404);
    expect((await h.call('multi', 'GET', url, { tenant: h.world.tenantA })).status).toBe(200); // A2 üyesi
    // Yönetici yalnız üyeliğindeki şirketlerin belgesini görür: A1 kapsamı A2 belgesini açmaz, A2 kapsamı açar.
    const adminScope = (companies: string[]) => h.owner.query(`UPDATE memberships SET company_ids = $3 WHERE tenant_id = $1 AND user_id = $2`, [h.world.tenantA, h.world.users.tenantAdmin.id, companies]);
    try {
      await adminScope([h.world.companyA1.id]);
      expect((await h.call('tenantAdmin', 'GET', url)).status).toBe(404);
      await adminScope([h.world.companyA2.id]);
      expect((await h.call('tenantAdmin', 'GET', url)).status).toBe(200);
    } finally {
      await adminScope([]);
    }
    // Yetkisiz şirkete yükleme
    const bad = await uploadInvoice('buyer', invoice({ sellerVkn: syntheticVkn('300000003') }), h.world.companyA2.id);
    expect(bad.status).toBe(403);
  });
});

describe('T03 havuzlanmış bağlantıda bağlam sızıntısı', () => {
  it('transaction-local bağlam bağlantı yeniden kullanımında düşer', async () => {
    const pool = createPool(TEST_APP_URL, 1);
    const ctxA = { tenantId: h.world.tenantA, userId: h.world.users.masterData.id, roles: ['MASTER_DATA'], companyIds: [h.world.companyA1.id], departmentIds: [], allDepartments: true, correlationId: 't03' };
    const ctxB = { tenantId: h.world.tenantB, userId: h.world.users.buyerB.id, roles: ['BUYER'], companyIds: [h.world.companyB1.id], departmentIds: [], allDepartments: true, correlationId: 't03' };
    const countA = await withTenant(pool, ctxA, async (tx) => (await tx.query('SELECT count(*)::int AS n FROM legal_entities')).rows[0].n);
    expect(countA).toBe(2);
    const leaked = await pool.query(`SELECT count(*)::int AS n FROM legal_entities`);
    expect(leaked.rows[0].n).toBe(0);
    expect((await pool.query(`SELECT current_setting('app.tenant_id', true) AS t`)).rows[0].t || null).toBeNull();
    const [a, b] = await Promise.all([
      withTenant(pool, ctxA, async (tx) => (await tx.query('SELECT tenant_id FROM legal_entities')).rows.map((r) => r.tenant_id)),
      withTenant(pool, ctxB, async (tx) => (await tx.query('SELECT tenant_id FROM legal_entities')).rows.map((r) => r.tenant_id)),
    ]);
    expect(new Set(a)).toEqual(new Set([h.world.tenantA]));
    expect(new Set(b)).toEqual(new Set([h.world.tenantB]));
    // Uygulama rolü RLS'i atlayamaz.
    const role = await pool.query(`SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user`);
    expect(role.rows[0]).toEqual({ rolsuper: false, rolbypassrls: false });
    await pool.end();
  });

  it('başka kiracı kimliğiyle kayıt eklenemez (WITH CHECK)', async () => {
    const ctxA = { tenantId: h.world.tenantA, userId: h.world.users.masterData.id, roles: [], companyIds: [], departmentIds: [], allDepartments: true, correlationId: 't03b' };
    await expect(withTenant(h.pool, ctxA, (tx) =>
      tx.query(`INSERT INTO suppliers (tenant_id, legal_name) VALUES ($1, 'x')`, [h.world.tenantB]))).rejects.toThrow(/row-level security/);
  });
});

describe('T04 eşzamanlı aynı VKN', () => {
  it('beş eşzamanlı belge tek aday tedarikçiye bağlanır', async () => {
    const vkn = syntheticVkn('300000004');
    const results = await Promise.all(Array.from({ length: 5 }, () => uploadInvoice('buyer', invoice({ sellerVkn: vkn }))));
    expect(results.every((r) => r.status === 201)).toBe(true);
    const ids = new Set(results.map((r) => r.body.supplier.supplierId));
    expect(ids.size).toBe(1);
    expect(results.filter((r) => r.body.supplier.outcome === 'CANDIDATE_CREATED')).toHaveLength(1);
    expect(results.filter((r) => r.body.supplier.outcome === 'ATTACHED_TO_CANDIDATE')).toHaveLength(4);
    const s = await h.call('masterData', 'GET', `/api/v1/suppliers/${[...ids][0]}`);
    expect(s.body.documents).toHaveLength(5);
    expect(s.body.status).toBe('CANDIDATE');
    // Faz 1 kalan düzeltme (D93): ana veri rolü Satınalma'ya katıldı; metin web düğmesiyle aynı "kayıt onayı".
    const created = results.find((r) => r.body.supplier.outcome === 'CANDIDATE_CREATED')!.body.supplier.message as string;
    const attached = results.find((r) => r.body.supplier.outcome === 'ATTACHED_TO_CANDIDATE')!.body.supplier.message as string;
    for (const m of [created, attached]) { expect(m).toContain('kayıt onayı bekleniyor'); expect(m).not.toMatch(/ana veri/i); }
  });
});

describe('T05 alıcı/satıcı ayrımı', () => {
  it('alıcı şirket VKN satıcı diye eşlenmez', async () => {
    const r = await uploadInvoice('buyer', invoice({ sellerVkn: syntheticVkn('300000005') }));
    expect(r.body.supplier.outcome).toBe('CANDIDATE_CREATED');
    const own = await h.call('masterData', 'GET', `/api/v1/suppliers?q=${h.world.companyA1.vkn}`);
    expect(own.body.items).toHaveLength(0);
  });
  it('satıcı alanında kendi şirket VKN varsa firma oluşmaz, inceleme açılır', async () => {
    const r = await uploadInvoice('buyer', invoice({ sellerVkn: h.world.companyA1.vkn, sellerName: h.world.companyA1.name }));
    expect(r.body.supplier.outcome).toBe('SELLER_IS_OWN_COMPANY');
    expect(r.body.supplier.supplierId).toBeNull();
    const tasks = await h.call('masterData', 'GET', '/api/v1/tasks?view=all');
    expect(tasks.body.items.some((t: any) => t.entityId === r.body.documentVersionId && t.kind === 'DOCUMENT_IDENTITY_REVIEW')).toBe(true);
  });
});

describe('T06 düşük güvenli/eksik kimlik', () => {
  it('kesin firma kararı yok; kimlik incelemesi; aktivasyon engelli', async () => {
    await uploadInvoice('buyer', invoice({ sellerVkn: syntheticVkn('300000006'), sellerName: 'Benzerlik Mühendislik A.Ş.' }));
    const r = await uploadInvoice('buyer', invoice({ sellerVkn: null, sellerName: 'Benzerlik Mühendislik Ltd.' }));
    expect(r.body.supplier.outcome).toBe('IDENTITY_REVIEW_REQUIRED');
    expect(r.body.supplier.suggestions.length).toBeGreaterThan(0); // yalnız öneri
    const s = await h.call('masterData', 'GET', `/api/v1/suppliers/${r.body.supplier.supplierId}`);
    expect(s.body.taxId).toBeNull();
    expect(s.body.identityReviewRequired).toBe(true);
    const act = await h.call('masterData', 'POST', `/api/v1/suppliers/${s.body.id}/activate`, { body: { expectedRowVersion: s.body.rowVersion } });
    expect(act.status).toBe(422);
    expect(act.body.error.details.missing).toContain('IDENTITY_NOT_VERIFIED');
  });

  it('kimlik çözümü mevcut kayıtla çakışırsa birleştirir ve belgeleri taşır', async () => {
    const vkn = syntheticVkn('300000016');
    const first = await uploadInvoice('buyer', invoice({ sellerVkn: vkn }));
    const draft = await uploadInvoice('buyer', invoice({ sellerVkn: null }));
    const d = await h.call('masterData', 'GET', `/api/v1/suppliers/${draft.body.supplier.supplierId}`);
    const res = await h.call('masterData', 'POST', `/api/v1/suppliers/${d.body.id}/identity`,
      { body: { country: 'TR', taxIdType: 'VKN', taxId: vkn, rationale: 'Kaynak belgede antet VKN doğrulandı', expectedRowVersion: d.body.rowVersion } });
    expect(res.status).toBe(200);
    expect(res.body.mergedInto).toBe(first.body.supplier.supplierId);
    const target = await h.call('masterData', 'GET', `/api/v1/suppliers/${first.body.supplier.supplierId}`);
    expect(target.body.documents).toHaveLength(2);
  });
});

describe('T07 görev ayrılığı', () => {
  it('adayı açan onaylayamaz/aktifleştiremez; bağımsız ana veri aktifleştirir', async () => {
    const own = await uploadInvoice('masterData', invoice({ sellerVkn: syntheticVkn('300000007') }));
    const sid = own.body.supplier.supplierId;
    const s = await h.call('masterData', 'GET', `/api/v1/suppliers/${sid}`);
    const appr = await h.call('masterData', 'POST', `/api/v1/suppliers/${sid}/approvals`,
      { body: { kind: 'MASTER_DATA', decision: 'APPROVED', rationale: 'kendi kaydım', expectedRowVersion: s.body.rowVersion } });
    expect(appr.status).toBe(403);
    expect(appr.body.error.code).toBe('sod_violation');
    const act = await h.call('masterData', 'POST', `/api/v1/suppliers/${sid}/activate`, { body: { expectedRowVersion: s.body.rowVersion } });
    expect(act.status).toBe(403);
    // Uygulama atlansa da DB kısıtı reddeder.
    await expect(h.owner.query(`UPDATE suppliers SET status='ACTIVE', activated_by=created_by WHERE id=$1`, [sid])).rejects.toThrow(/check constraint/);

    // Satınalmacının açtığı aday: ana veri onaylar ve aktifleştirir.
    const other = await uploadInvoice('buyer', invoice({ sellerVkn: syntheticVkn('300000017') }));
    const oid = other.body.supplier.supplierId;
    const o = await h.call('masterData', 'GET', `/api/v1/suppliers/${oid}`);
    const noApproval = await h.call('masterData', 'POST', `/api/v1/suppliers/${oid}/activate`, { body: { expectedRowVersion: o.body.rowVersion } });
    expect(noApproval.status).toBe(422);
    // v2 (D93): hukuk da Satınalma rolünde (aktivasyon yetkisi var); ayrılık kişi düzeyinde: kaydı açan (buyer, Satınalma) aktifleştiremez,
    // açmayan başka Satınalma kullanıcısı (legal) yetkili, onay eksikse koşul hatası alır.
    const creator = await h.call('buyer', 'POST', `/api/v1/suppliers/${oid}/activate`, { body: { expectedRowVersion: o.body.rowVersion } });
    expect(creator.status).toBe(403);
    expect(creator.body.error.code).toBe('sod_violation');
    expect((await h.call('legal', 'POST', `/api/v1/suppliers/${oid}/activate`, { body: { expectedRowVersion: o.body.rowVersion } })).status).toBe(422);
    expect((await h.call('masterData', 'POST', `/api/v1/suppliers/${oid}/approvals`,
      { body: { kind: 'MASTER_DATA', decision: 'APPROVED', rationale: 'Kimlik ve kanıt incelendi', expectedRowVersion: o.body.rowVersion } })).status).toBe(204);
    // Rol/onay türü eşleşmeli
    expect((await h.call('finance', 'POST', `/api/v1/suppliers/${oid}/approvals`,
      { body: { kind: 'SECURITY', decision: 'APPROVED', rationale: 'x', expectedRowVersion: o.body.rowVersion } })).status).toBe(403);
    const ok = await h.call('masterData', 'POST', `/api/v1/suppliers/${oid}/activate`, { body: { expectedRowVersion: o.body.rowVersion } });
    expect(ok.status).toBe(204);
    expect((await h.call('masterData', 'GET', `/api/v1/suppliers/${oid}`)).body.status).toBe('ACTIVE');
    // Sonraki belge aktif firmaya bağlanır; ünvan farkı görünür.
    const next = await uploadInvoice('buyer', invoice({ sellerVkn: syntheticVkn('300000017'), sellerName: 'Farklı Ünvan Pazarlama A.Ş.' }));
    expect(next.body.supplier.outcome).toBe('MATCHED_ACTIVE');
    expect(next.body.supplier.nameMismatch).toBe(true);
    // Eski sürümle onay (stale)
    const stale = await h.call('masterData', 'POST', `/api/v1/suppliers/${oid}/activate`, { body: { expectedRowVersion: o.body.rowVersion } });
    expect(stale.status).toBe(409);
  });
});

describe('T08 IBAN sessiz değişmez', () => {
  it('belgedeki farklı IBAN yalnız doğrulama talebi açar; tekrar gelirse tek talep', async () => {
    const vkn = syntheticVkn('300000008');
    const first = await uploadInvoice('buyer', invoice({ sellerVkn: vkn }));
    const sid = first.body.supplier.supplierId;
    const verifiedIban = 'TR330006100519786457841326';
    await h.owner.query(`INSERT INTO supplier_bank_accounts (tenant_id, supplier_id, iban, status) VALUES ($1,$2,$3,'VERIFIED')`,
      [h.world.tenantA, sid, verifiedIban]);
    const otherIban = makeTrIban('0001000999990123456789');
    const r1 = await uploadInvoice('buyer', invoice({ sellerVkn: vkn, iban: otherIban }));
    const r2 = await uploadInvoice('buyer', invoice({ sellerVkn: vkn, iban: otherIban }));
    const s = await h.call('finance', 'GET', `/api/v1/suppliers/${sid}`);
    expect(s.body.bankAccounts).toEqual([expect.objectContaining({ iban: verifiedIban, status: 'VERIFIED' })]);
    const pending = s.body.bankChangeRequests.filter((b: any) => b.status === 'PENDING_VERIFICATION');
    expect(pending).toEqual([expect.objectContaining({ proposedIban: otherIban, source: 'DOCUMENT_EXTRACTION' })]);
    expect(r1.body.supplier.bankChangeRequestId).toBeTruthy();
    expect(r2.body.supplier.bankChangeRequestId).toBe(r1.body.supplier.bankChangeRequestId);
    const tasks = await h.call('finance', 'GET', '/api/v1/tasks?view=all');
    // v2 düzeltme dalgası (Y1): banka değişikliği kararı kaldırıldı (D93); talep kaydı sürer, kapanamayacak doğrulama görevi açılmaz (önce 1).
    expect(tasks.body.items.filter((t: any) => t.entityId === sid && t.kind === 'BANK_CHANGE_VERIFICATION')).toHaveLength(0);
    expect((await h.owner.query(`SELECT 1 FROM tasks WHERE kind = 'BANK_CHANGE_VERIFICATION' AND entity_id = $1`, [sid])).rowCount).toBe(0);
    // Kayıtlı IBAN ile gelen belge talep açmaz.
    const same = await uploadInvoice('buyer', invoice({ sellerVkn: vkn, iban: verifiedIban }));
    expect(same.body.supplier.bankChangeRequestId).toBeNull();
    // Uygulama rolünün banka hesabını güncelleme yetkisi yok.
    await expect(withTenant(h.pool, { tenantId: h.world.tenantA, userId: h.world.users.finance.id, roles: [], companyIds: [], departmentIds: [], allDepartments: true, correlationId: 't08' },
      (tx) => tx.query(`UPDATE supplier_bank_accounts SET iban = 'X' WHERE supplier_id = $1`, [sid]))).rejects.toThrow(/permission denied/);
  });
});

describe('Belge girişi güvenliği (T30 tekrar, T47 kısmi, T46)', () => {
  it('aynı dosya tekrar yüklenince yeni kayıt açılmaz', async () => {
    const inv = invoice({ sellerVkn: syntheticVkn('300000009') });
    const a = await uploadInvoice('buyer', inv);
    const b = await uploadInvoice('buyer', inv);
    expect(a.status).toBe(201);
    expect(b.status).toBe(200);
    expect(b.body.duplicate).toBe(true);
    expect(b.body.documentVersionId).toBe(a.body.documentVersionId);
  });
  it('aktif içerikli PDF ve DTD içeren XML karantinaya alınır; sahte uzantı reddedilir', async () => {
    const evil = Buffer.from('%PDF-1.4\n1 0 obj << /OpenAction << /S /JavaScript /JS (app.alert(1)) >> >> endobj\n%%EOF');
    const p = await h.upload('buyer', { name: 'x.pdf', mime: 'application/pdf', data: evil }, { companyId: h.world.companyA1.id, kind: 'OTHER' });
    expect(p.body.basicCheckStatus).toBe('QUARANTINED');
    const content = await h.call('buyer', 'GET', `/api/v1/document-versions/${p.body.documentVersionId}/content`);
    expect(content.status).toBe(423);
    const xxe = Buffer.from('<?xml version="1.0"?><!DOCTYPE r [<!ENTITY x SYSTEM "file:///etc/passwd">]><Invoice>&x;</Invoice>');
    const x = await h.upload('buyer', { name: 'x.xml', mime: 'application/xml', data: xxe }, { companyId: h.world.companyA1.id, kind: 'INVOICE' });
    expect(x.body.basicCheckStatus).toBe('QUARANTINED');
    expect(x.body.supplier).toBeNull();
    const fake = await h.upload('buyer', { name: 'a.pdf', mime: 'application/pdf', data: Buffer.from('MZ\x90\x00binary') }, { companyId: h.world.companyA1.id, kind: 'OTHER' });
    expect(fake.status).toBe(415);
  });
  it('T46: indirilen orijinal baytlar hash ile aynıdır', async () => {
    const pdf = syntheticPdf([['SENTETIK TEST SOZLESMESI'], ['Sayfa 2']]);
    const up = await h.upload('buyer', { name: 's.pdf', mime: 'application/pdf', data: pdf }, { companyId: h.world.companyA1.id, kind: 'OTHER' });
    const c = await h.call('buyer', 'GET', `/api/v1/document-versions/${up.body.documentVersionId}/content`);
    const { createHash } = await import('node:crypto');
    expect(createHash('sha256').update(c.raw).digest('hex')).toBe(up.body.sha256);
    expect(c.headers['cache-control']).toContain('no-store');
  });
  it('fatura PDF ve OCR yok → sahte çıkarım yok, manuel giriş görevi', async () => {
    const pdf = syntheticPdf([['SENTETIK FATURA', 'Satici VKN: okunamadi']]);
    const up = await h.upload('finance', { name: 'f.pdf', mime: 'application/pdf', data: pdf }, { companyId: h.world.companyA1.id, kind: 'INVOICE' });
    expect(up.body.processing.stage).toBe('MANUAL_EXTRACTION_REQUIRED');
    const manual = await h.call('finance', 'POST', `/api/v1/document-versions/${up.body.documentVersionId}/seller-identity`,
      { body: { taxIdType: 'VKN', taxId: syntheticVkn('300000010'), name: 'Elle Girilen Ltd.', country: 'TR', page: 1 } });
    expect(manual.status).toBe(200);
    expect(manual.body.outcome).toBe('CANDIDATE_CREATED');
    const dv = await h.call('finance', 'GET', `/api/v1/document-versions/${up.body.documentVersionId}`);
    expect(dv.body.fields.every((f: any) => f.origin === 'HUMAN')).toBe(true);
  });
});

describe('Denetim izi', () => {
  it('değiştirilemez ve hassas içerik taşımaz', async () => {
    const up = await uploadInvoice('buyer', invoice({ sellerVkn: syntheticVkn('300000011') }));
    const a = await h.call('auditor', 'GET', `/api/v1/audit-events?entityId=${up.body.documentVersionId}`);
    expect(a.status).toBe(200);
    expect(a.body.items[0].action).toBe('document.version.created');
    expect(JSON.stringify(a.body.items)).not.toContain('<Invoice');
    expect((await h.call('buyer', 'GET', `/api/v1/audit-events?entityId=${up.body.documentVersionId}`)).status).toBe(403);
    await expect(h.owner.query(`UPDATE audit_events SET action = 'x' WHERE entity_id = $1`, [up.body.documentVersionId])).rejects.toThrow(/immutable_record/);
  });
});

describe('Faz 7 DAST bulguları', () => {
  it('NUL baytlı sorgu ve çok parçalı olmayan yükleme 4xx döner (500 değil); yanıtlar içerik türü tahminine kapalı', async () => {
    const nul = await h.call('masterData', 'GET', '/api/v1/suppliers?status=%00&q=q');
    expect(nul.status).toBe(400);
    expect(nul.headers['x-content-type-options']).toBe('nosniff');
    const notMultipart = await h.call('buyer', 'POST', '/api/v1/documents', { body: { companyId: h.world.companyA1.id } });
    expect(notMultipart.status).toBe(415);
    expect(notMultipart.body.error.code).toBe('multipart_required');
  });
});
