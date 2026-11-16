// v2 Faz 1 (D93/D95): onaylı kaldırma listesindeki uçlar Satınalma, Yönetici ve Denetçi için 403 döner ve hiçbir satır yazmaz; eski testler bunu varsayar
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { can, normalizeRoles, PERMISSIONS, REMOVED_PERMISSIONS, V2_ROLES, type Permission } from '@sp/domain';
import { makeHarness } from './harness.ts';

// Kaldırma = ekrandan ve yetkiden çıkarma (analiz-v2 §4); tablolar ve eski veriler silinmez. Bu dosya kaldırılan her yazma/okuma
// ucunun üç iç rol için `forbidden` döndüğünü ve tablolarda satır sayısının değişmediğini korur. Tüm veri sentetik.
let h: Awaited<ReturnType<typeof makeHarness>>;
beforeAll(async () => { h = await makeHarness(); });
afterAll(async () => { await h.close(); });

const id = () => randomUUID();
const date = '2026-10-20';
const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Istanbul' }).format(new Date());

/** Kaldırılan uçlar: [yöntem, yol, gövde, başlık]. Gövdeler şema doğrulamasından geçer; red yetkiden gelir (400 değil). */
const endpoints = (): [string, string, unknown?, Record<string, string>?][] => [
  // Fatura onayı, reddi, istisna onayı ve tolerans (invoice.approve, invoice.exception.approve, tolerance.manage)
  ['POST', `/api/v1/invoices/${id()}/approve`, undefined, { 'if-match': 'x' }],
  ['POST', `/api/v1/invoices/${id()}/reject`, { reason: 'Kaldırılan uç denemesi (sentetik).' }],
  ['POST', `/api/v1/invoices/${id()}/exception-approval`, { reason: 'Kaldırılan uç denemesi (sentetik).' }],
  ['PUT', '/api/v1/tolerance-rules', { currency: 'TRY', absAmount: '10', percent: null, combine: 'LOWER' }],
  ['DELETE', '/api/v1/tolerance-rules/TRY'],
  // Sipariş ve mal kabul (po.read, po.manage, receipt.record)
  ['GET', '/api/v1/purchase-orders'],
  ['GET', `/api/v1/purchase-orders/${id()}`],
  ['POST', '/api/v1/purchase-orders', { companyId: h.world.companyA1.id, supplierId: h.world.suppliers.s1, currency: 'TRY',
    lines: [{ kind: 'GOODS', description: 'Kaldırılan uç denemesi', unit: 'adet', quantity: '1', unitPrice: '1' }] }],
  ['POST', `/api/v1/purchase-orders/${id()}/changes`, { baseChangeNo: 0, reason: 'Kaldırılan uç denemesi (sentetik).', lines: [] }],
  ['POST', `/api/v1/purchase-orders/${id()}/close`, { baseChangeNo: 0, reason: 'Kaldırılan uç denemesi (sentetik).' }],
  ['POST', `/api/v1/po-lines/${id()}/receipts`, { quantity: '1', note: 'Kaldırılan uç denemesi' }],
  ['POST', `/api/v1/receipts/${id()}/reverse`, { quantity: '1', note: 'Kaldırılan uç denemesi' }],
  // Lira Defteri / geri kazanım (recovery.*)
  ['GET', `/api/v1/ledger?from=2026-01-01&to=${today}`],
  ['POST', '/api/v1/recovery/scan'],
  ['GET', '/api/v1/recovery/cases'],
  ['GET', `/api/v1/recovery/cases/${id()}`],
  ['POST', `/api/v1/recovery/cases/${id()}/confirm`],
  ['POST', `/api/v1/recovery/cases/${id()}/claim`, { note: 'Kaldırılan uç denemesi' }],
  ['POST', `/api/v1/recovery/cases/${id()}/recover`, { amount: '1.00', note: 'Kaldırılan uç denemesi' }],
  ['POST', `/api/v1/recovery/cases/${id()}/dismiss`, { reason: 'Kaldırılan uç denemesi (sentetik).' }],
  ['PUT', '/api/v1/recovery/settings', { capitalCostRate: '40' }],
  // Kur: TCMB'den alma, elle kur girişi/silme ve listesi (recovery.settings, recovery.read)
  ['POST', '/api/v1/fx-rates/tcmb', {}],
  ['GET', '/api/v1/fx-rates'],
  ['POST', '/api/v1/fx-rates', { currency: 'USD', rateDate: date, rate: '40.5', source: 'Kaldırılan uç denemesi' }],
  ['DELETE', `/api/v1/fx-rates/USD/${date}`],
  // Saklama, hukuki saklama ve imha (retention.*, legal_hold.manage, disposal.*)
  ['GET', '/api/v1/retention'],
  ['GET', '/api/v1/retention/candidates'],
  ['PUT', '/api/v1/retention/policies/OTHER', { retentionMonths: 12, legalBasis: 'Kaldırılan uç denemesi (sentetik)' }],
  ['DELETE', '/api/v1/retention/policies/OTHER'],
  ['POST', '/api/v1/legal-holds', { scope: 'TENANT', matterRef: 'DENEME-1', reason: 'Kaldırılan uç denemesi (sentetik).' }],
  ['POST', `/api/v1/legal-holds/${id()}/release`, { reason: 'Kaldırılan uç denemesi (sentetik).' }],
  ['POST', '/api/v1/disposal-batches', { documentIds: [id()], reason: 'Kaldırılan uç denemesi (sentetik).' }],
  ['GET', `/api/v1/disposal-batches/${id()}`],
  ['POST', `/api/v1/disposal-batches/${id()}/decision`, { decision: 'APPROVE', note: 'Kaldırılan uç denemesi' }],
  // Onay politikası yönetimi (approval.policy.manage); okuma ve simülasyon proje okuma iznine bağlı kalır.
  ['POST', '/api/v1/approval-policies', { rules: [], note: 'Kaldırılan uç denemesi (sentetik).' }],
  ['POST', `/api/v1/approval-policies/${id()}/activate`],
];

const tables = ['invoice_decisions', 'tolerance_rules', 'purchase_orders', 'po_lines', 'po_changes', 'po_line_revisions', 'receipts', 'recovery_cases', 'recovery_settings',
  'fx_rates', 'retention_policies', 'legal_holds', 'disposal_batches', 'disposal_items', 'document_disposals', 'approval_policies', 'bank_change_requests', 'erp_exports', 'audit_events'];
const counts = async () => Object.fromEntries(await Promise.all(tables.map(async (t) =>
  [t, (await h.owner.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${t}`)).rows[0]!.n] as const)));

describe('v2 kaldırılan işlevler (D93)', () => {
  for (const who of ['legal', 'tenantAdmin', 'auditor'] as const) {
    const role = { legal: 'PROCUREMENT', tenantAdmin: 'ADMIN', auditor: 'AUDITOR' }[who];
    it(`${role}: her kaldırılan uç 403 forbidden döner; tablolarda satır sayısı değişmez`, async () => {
      const before = await counts();
      const results: string[] = [];
      for (const [method, url, body, headers] of endpoints()) {
        const r = await h.call(who, method, url, { ...(body === undefined ? {} : { body }), ...(headers ? { headers } : {}) });
        if (r.status !== 403 || r.body?.error?.code !== 'forbidden') results.push(`${method} ${url} → ${r.status} ${JSON.stringify(r.body)}`);
        // Yetki hatası ham izin kodunu mesajda göstermez (D90).
        else expect(r.body.error.message).not.toMatch(/\b(po|receipt|invoice|tolerance|recovery|retention|legal_hold|disposal|approval)\.[a-z_.]+/);
      }
      expect(results).toEqual([]);
      expect(await counts()).toEqual(before);
    });
  }

  it('kaldırılan izinler hiçbir role (eski kodlar dahil) verilmez; banka değişikliği kararının API ucu yok', async () => {
    const legacy = ['TENANT_ADMIN', 'PLATFORM_OPS', 'BUYER', 'PROCUREMENT_MANAGER', 'MASTER_DATA', 'LEGAL', 'FINANCE', 'REQUESTER', 'TECH_EVALUATOR', 'SECURITY', 'SUPPLIER', 'AUDITOR'];
    expect(REMOVED_PERMISSIONS).toHaveLength(17);
    for (const p of REMOVED_PERMISSIONS) {
      expect(PERMISSIONS[p as Permission], p).toEqual([]);
      expect(can([...V2_ROLES], p as Permission), p).toBe(false);
      expect(can(legacy, p as Permission), p).toBe(false);
    }
    expect(normalizeRoles(legacy).sort()).toEqual([...V2_ROLES].sort());
    // bank.change.decide hiçbir uca bağlı değildi; belge kaynaklı IBAN yalnız doğrulama talebi açar (T08). Karar ucu yoktur.
    for (const url of [`/api/v1/bank-change-requests/${id()}/decision`, `/api/v1/suppliers/${h.world.suppliers.s1}/bank-changes/${id()}/decision`]) {
      expect((await h.call('legal', 'POST', url, { body: { decision: 'APPROVED' } })).status).toBe(404);
    }
  });

  it('eski açık banka doğrulama görevi İşlerim, sayaç, bildirim ve aramada listelenmez; kayıt silinmez (Y1)', async () => {
    const tag = `BNK${randomUUID().slice(0, 6)}`;
    const t = (await h.owner.query<{ id: string }>(`INSERT INTO tasks (tenant_id, company_id, kind, entity_type, entity_id, title, reason, next_action, assignee_role, severity, dedupe_key)
      VALUES ($1, NULL, 'BANK_CHANGE_VERIFICATION', 'supplier', $2, $3, 'Belgede kayıtlı olmayan bir IBAN okundu.', 'Teyit edin.', 'PROCUREMENT', 'HIGH', $4) RETURNING id`,
      [h.world.tenantA, h.world.suppliers.s1, `Banka bilgisi doğrulanmalı ${tag}`, `bank-change:${randomUUID()}`])).rows[0]!.id;
    for (const view of ['mine', 'all']) expect((await h.call('legal', 'GET', `/api/v1/tasks?view=${view}`)).body.items.map((x: any) => x.id)).not.toContain(t);
    expect((await h.call('legal', 'GET', '/api/v1/notifications')).body.items.map((x: any) => x.id)).not.toContain(t);
    expect(JSON.stringify((await h.call('legal', 'GET', `/api/v1/search?q=${tag}`)).body)).not.toContain(t);
    expect((await h.owner.query(`SELECT status FROM tasks WHERE id = $1`, [t])).rows[0].status).toBe('OPEN');
  });

  it('korunan komşu uçlar çalışmaya devam eder: politika okuma/simülasyon, fatura listesi, tolerans listesi salt okunur', async () => {
    expect((await h.call('legal', 'GET', '/api/v1/approval-policies')).body.can.manage).toBe(false);
    const sim = await h.call('buyer', 'POST', '/api/v1/approval-policies/simulate', { body: { action: 'RFQ_PUBLISH', companyId: h.world.companyA1.id, category: null, currency: 'TRY', amount: '10' } });
    expect(sim.status).toBe(200);
    expect((await h.call('legal', 'GET', '/api/v1/invoices')).status).toBe(200);
    const tol = await h.call('legal', 'GET', '/api/v1/tolerance-rules');
    expect(tol.status).toBe(200);
    expect(tol.body.can.manage).toBe(false);
    const inv = await h.call('finance', 'POST', '/api/v1/invoices', { body: { companyId: h.world.companyA1.id, supplierId: h.world.suppliers.s1, kind: 'INVOICE', invoiceNo: `RMV${randomUUID().slice(0, 8)}`,
      issueDate: date, currency: 'TRY', lines: [{ description: 'Hizmet', quantity: '1', unit: 'adet', unitPrice: '10', netAmount: '10.00' }] } });
    expect(inv.status).toBe(201);
    expect((await h.call('finance', 'GET', `/api/v1/invoices/${inv.body.id}`)).body.can).toMatchObject({ manage: true, approve: false, approveException: false });
  });
});

// v2 Faz 1 (D93): rol birleşmesiyle aynı role (Satınalma) düşen iki adımlı işlerde kişi düzeyindeki ayrılık. Aynı Satınalma kullanıcısı
// iki adımı birden yapamaz; iki ayrı Satınalma kullanıcısı yapar. (Diğer çiftler ilgili dosyalarda: commercial, lifecycle, sourcing, signature.)
describe('v2 görev ayrılığı: iki ayrı Satınalma kullanıcısı', () => {
  it('proje yayın talebi ve onayı: talep eden onaylayamaz, ikinci Satınalma kullanıcısı onaylar', async () => {
    const p = await h.call('legal', 'POST', '/api/v1/projects', { body: { companyId: h.world.companyA1.id, title: `Görev ayrılığı ${randomUUID().slice(0, 4)}`, category: 'BT hizmetleri',
      need: 'Sentetik', currency: 'TRY', budget: '1000.00', budgetVerified: false, lines: [{ lot: 'Lot 1', description: 'Bakım', unit: 'ay', quantity: '1' }],
      criteria: [{ code: 'PRICE', name: 'Fiyat', kind: 'PRICE', weight: '100' }] } });
    expect(p.status).toBe(201);
    const pub = await h.call('legal', 'POST', `/api/v1/projects/${p.body.id}/rounds`, { body: { closesAt: new Date(Date.now() + 72 * 3600_000).toISOString(), supplierIds: [h.world.suppliers.s1] },
      headers: { 'if-match': p.body.etag } });
    expect(pub.status, JSON.stringify(pub.body)).toBe(201);
    const self = await h.call('legal', 'POST', `/api/v1/rfq-rounds/${pub.body.roundId}/decision`, { body: { approve: true } });
    expect(self.status).toBe(403);
    expect(self.body.error.code).toBe('segregation_of_duties');
    expect((await h.call('legal2', 'POST', `/api/v1/rfq-rounds/${pub.body.roundId}/decision`, { body: { approve: true } })).status).toBe(200);
  });

  it('tedarikçi onayı ve aktivasyonu: kaydı açan Satınalma kullanıcısı ne onaylar ne aktifleştirir; başka Satınalma kullanıcısı yapar', async () => {
    const vkn = (await h.owner.query<{ tax_id: string }>(`SELECT tax_id FROM suppliers WHERE id = $1`, [h.world.suppliers.s3])).rows[0]!.tax_id;
    expect(vkn).toBeTruthy();
    const s = await h.call('legal', 'GET', `/api/v1/suppliers/${h.world.suppliers.s3}`);
    // s3 adayını buyer açtı (devdata): buyer onaylayamaz/aktifleştiremez.
    const own = await h.call('buyer', 'POST', `/api/v1/suppliers/${h.world.suppliers.s3}/approvals`, { body: { kind: 'MASTER_DATA', decision: 'APPROVED', rationale: 'Kendi kaydım (sentetik)', expectedRowVersion: s.body.rowVersion } });
    expect(own.status).toBe(403);
    expect(own.body.error.code).toBe('sod_violation');
    expect((await h.call('buyer', 'POST', `/api/v1/suppliers/${h.world.suppliers.s3}/activate`, { body: { expectedRowVersion: s.body.rowVersion } })).body.error.code).toBe('sod_violation');
    expect((await h.call('legal', 'POST', `/api/v1/suppliers/${h.world.suppliers.s3}/approvals`, { body: { kind: 'MASTER_DATA', decision: 'APPROVED', rationale: 'Kimlik ve kanıt incelendi (sentetik)', expectedRowVersion: s.body.rowVersion } })).status).toBe(204);
    expect((await h.call('legal2', 'POST', `/api/v1/suppliers/${h.world.suppliers.s3}/activate`, { body: { expectedRowVersion: s.body.rowVersion } })).status).toBe(204);
    // Test dünyası başka dosyalarda paylaşılmaz; yine de adayı eski durumuna döndür (yalnız test verisi).
    await h.owner.query(`UPDATE suppliers SET status = 'CANDIDATE', activated_by = NULL, activated_at = NULL WHERE id = $1`, [h.world.suppliers.s3]);
  });
});
