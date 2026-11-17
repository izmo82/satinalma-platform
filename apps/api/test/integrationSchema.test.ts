// v2 Faz 8 (D113): Görev 4 (Ruling 5, 058b) sır satırı kiracı içinde silinebilir; sır tablosundaki DELETE izni beklentisi buna göre güncellendi.
// v2 Faz 8 (D113) Görev 2: 057/058 şeması — özellik başına ERP uç noktası (varsayılan kapalı, yazma yalnız yazan özellikte ve
// açıkken), zarf şifreli sır (düz metin sütunu yok), çalışma/hata kaydı (hata değişmez, kapanan çalışma değişmez, taklit ⇒ mock),
// ERP'ye yazma kaydı, masraf merkezi ve sipariş kopyası, tedarikçi/departman/fatura ERP sütunları (kaynak ERP|MANUAL).
// Her yeni tabloda kiracı RLS'i, tedarikçi bağlamı kapalı, DELETE izni yok. Tüm veri sentetiktir.
// 058a: fatura ERP referansları kaynaklı (NULL → değer, elle → elle; ERP/kaynaksız değer değişmez), ERP elle değerin yerine geçemez,
// ERP yazma kaydında dış referans bir kez yazılır, CONFIRMED/MANUAL son durumdur.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomBytes, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import type pg from 'pg';
import { withTenant, type TenantContext } from '../src/db.ts';
import { makeHarness } from './harness.ts';

let h: Awaited<ReturnType<typeof makeHarness>>;
const rand = () => randomUUID().slice(0, 8);

const admin = (): TenantContext => ({ tenantId: h.world.tenantA, userId: h.world.users.tenantAdmin.id, roles: ['TENANT_ADMIN'],
  companyIds: [h.world.companyA1.id], departmentIds: [], allDepartments: true, correlationId: 'v2-integration-schema' });
const tenantB = (): TenantContext => ({ tenantId: h.world.tenantB, userId: h.world.users.buyerB.id, roles: ['PROCUREMENT'],
  companyIds: [h.world.companyB1.id], departmentIds: [], allDepartments: true, correlationId: 'v2-integration-schema-b' });
const supplierCtx = (): TenantContext => ({ tenantId: h.world.tenantA, userId: h.world.users.supplier1.id, roles: ['SUPPLIER'],
  companyIds: [], departmentIds: [], allDepartments: false, supplierId: h.world.suppliers.s1, correlationId: 'v2-integration-schema-s' });

async function rejects(p: Promise<unknown>, code: string, message?: RegExp) {
  const err = await p.then(() => null, (e: any) => e);
  expect(err, `beklenen hata ${code}`).not.toBeNull();
  expect(err.code, String(err?.message)).toBe(code);
  if (message) expect(err.message).toMatch(message);
}
const count = async (tx: pg.PoolClient, sql: string, params: unknown[] = []) =>
  (await tx.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${sql}`, params)).rows[0]!.n;
const one = async <T = any>(sql: string, params: unknown[] = []) => (await h.owner.query(sql, params)).rows[0] as T;

const NEW_TABLES = ['integration_endpoints', 'integration_endpoint_secrets', 'integration_runs', 'integration_run_errors',
  'erp_outbound_records', 'erp_cost_centers', 'erp_purchase_orders'];

/** Uygulama rolüyle (sp_app) kiracı A'da uç nokta; özellik başına tek satır olduğundan her test kendi özelliğini kullanır ya da var olanı alır. */
async function endpoint(feature: string, tenant: 'A' | 'B' = 'A') {
  const ctx = tenant === 'A' ? admin() : tenantB();
  return withTenant(h.pool, ctx, async (tx) => {
    const existing = await tx.query<{ id: string }>(`SELECT id FROM integration_endpoints WHERE feature = $1`, [feature]);
    if (existing.rows[0]) return existing.rows[0].id;
    return (await tx.query<{ id: string }>(`INSERT INTO integration_endpoints (tenant_id, feature, base_url, resource_path, auth_type, username, updated_by)
      VALUES ($1, $2, 'taklit://oracle', '/webservices/rest/sentetik', 'BASIC', 'sentetik_kullanici', $3) RETURNING id`,
      [ctx.tenantId, feature, ctx.userId])).rows[0]!.id;
  });
}
const sealed = () => ({ kek: 'a1b2c3d4', dek: randomBytes(48), dekIv: randomBytes(12), iv: randomBytes(12), ct: randomBytes(40) });

async function finishedRun(endpointId: string, feature: string, provider: 'TAKLIT' | 'ORACLE_EBS' = 'TAKLIT') {
  return withTenant(h.pool, admin(), async (tx) => (await tx.query<{ id: string }>(`INSERT INTO integration_runs (tenant_id, endpoint_id, feature, trigger,
      provider_kind, mock, requested_by) VALUES ($1, $2, $3, 'MANUAL', $4, $5, $6) RETURNING id`,
    [h.world.tenantA, endpointId, feature, provider, provider === 'TAKLIT', h.world.users.tenantAdmin.id])).rows[0]!.id);
}

beforeAll(async () => { h = await makeHarness(); });
afterAll(async () => { await h.close(); });

describe('057 uç noktalar', () => {
  it('feature_defaults_closed_and_unique_per_tenant', async () => {
    const id = await endpoint('PURCHASE_ORDER');
    const row = await one(`SELECT enabled, write_enabled, provider_kind, schedule_kind, field_map, timeout_ms FROM integration_endpoints WHERE id = $1`, [id]);
    expect(row).toEqual({ enabled: false, write_enabled: false, provider_kind: 'TAKLIT', schedule_kind: 'MANUAL', field_map: {}, timeout_ms: 15000 });
    // Aynı özellik aynı kiracıda ikinci kez eklenemez; başka kiracıda eklenebilir.
    await withTenant(h.pool, admin(), (tx) => rejects(tx.query(`INSERT INTO integration_endpoints (tenant_id, feature) VALUES ($1, 'PURCHASE_ORDER')`,
      [h.world.tenantA]), '23505'));
    expect(await endpoint('PURCHASE_ORDER', 'B')).not.toBe(id);
    // Bilinmeyen özellik / sağlayıcı / kimlik doğrulama türü.
    await withTenant(h.pool, admin(), (tx) => rejects(tx.query(`INSERT INTO integration_endpoints (tenant_id, feature) VALUES ($1, 'GL_JOURNAL')`, [h.world.tenantA]), '23514'));
    await withTenant(h.pool, admin(), (tx) => rejects(tx.query(`UPDATE integration_endpoints SET provider_kind = 'SAP' WHERE id = $1`, [id]), '23514'));
    await withTenant(h.pool, admin(), (tx) => rejects(tx.query(`UPDATE integration_endpoints SET auth_type = 'DIGEST' WHERE id = $1`, [id]), '23514'));
    // Özellik ve kiracı sonradan değiştirilemez (UPDATE izni yok).
    await withTenant(h.pool, admin(), (tx) => rejects(tx.query(`UPDATE integration_endpoints SET feature = 'INVOICE' WHERE id = $1`, [id]), '42501'));
    await withTenant(h.pool, admin(), (tx) => rejects(tx.query(`UPDATE integration_endpoints SET tenant_id = $2 WHERE id = $1`, [id, h.world.tenantB]), '42501'));
  });

  it('write_enabled_only_on_writing_feature_while_enabled_and_confirmed', async () => {
    const reader = await endpoint('COST_CENTER');
    const writer = await endpoint('REQUISITION');
    const admin_ = h.world.users.tenantAdmin.id;
    await withTenant(h.pool, admin(), async (tx) => {
      expect((await tx.query(`UPDATE integration_endpoints SET enabled = true WHERE id = $1`, [reader])).rowCount).toBe(1);
      expect((await tx.query(`UPDATE integration_endpoints SET enabled = true WHERE id = $1`, [writer])).rowCount).toBe(1);
    });
    // Okuma özelliğinde yazma açılamaz (onaylı olsa bile).
    await withTenant(h.pool, admin(), (tx) => rejects(tx.query(`UPDATE integration_endpoints SET write_enabled = true, write_confirmed_by = $2,
      write_confirmed_at = now() WHERE id = $1`, [reader, admin_]), '23514', /integration_endpoints_write_check/));
    // Yazan özellikte onaysız açılamaz; onay kişi + zaman birlikte.
    await withTenant(h.pool, admin(), (tx) => rejects(tx.query(`UPDATE integration_endpoints SET write_enabled = true WHERE id = $1`, [writer]), '23514'));
    await withTenant(h.pool, admin(), (tx) => rejects(tx.query(`UPDATE integration_endpoints SET write_confirmed_by = $2 WHERE id = $1`, [writer, admin_]), '23514'));
    await withTenant(h.pool, admin(), async (tx) => {
      expect((await tx.query(`UPDATE integration_endpoints SET write_enabled = true, write_confirmed_by = $2, write_confirmed_at = now() WHERE id = $1`,
        [writer, admin_])).rowCount).toBe(1);
    });
    // Özellik kapatılırken yazma açık kalamaz; ikisi birlikte kapanır, onay kaydı saklı kalır.
    await withTenant(h.pool, admin(), (tx) => rejects(tx.query(`UPDATE integration_endpoints SET enabled = false WHERE id = $1`, [writer]), '23514'));
    await withTenant(h.pool, admin(), async (tx) => {
      expect((await tx.query(`UPDATE integration_endpoints SET enabled = false, write_enabled = false WHERE id = $1`, [writer])).rowCount).toBe(1);
    });
    expect(await one(`SELECT write_confirmed_by IS NOT NULL AS kept FROM integration_endpoints WHERE id = $1`, [writer])).toEqual({ kept: true });
  });

  it('config_shape_checks_schedule_url_userinfo_enabled_requires_config', async () => {
    const id = await endpoint('INVOICE');
    const bad = async (set: string, params: unknown[] = []) =>
      withTenant(h.pool, admin(), (tx) => rejects(tx.query(`UPDATE integration_endpoints SET ${set} WHERE id = $1`, [id, ...params]), '23514'));
    await bad(`schedule_kind = 'INTERVAL'`);                                     // aralık eksik
    await bad(`schedule_kind = 'INTERVAL', schedule_interval_min = 10`);         // < 15
    await bad(`schedule_kind = 'INTERVAL', schedule_interval_min = 1441`);       // > 1440
    await bad(`schedule_kind = 'DAILY'`);                                        // saat eksik
    await bad(`schedule_interval_min = 60`);                                     // MANUAL'da aralık olmaz
    await bad(`base_url = 'https://kullanici:parola@erp.example.test'`);         // adreste kimlik bilgisi yok
    await bad(`token_url = 'https://istemci:sir@erp.example.test/token'`);
    await bad(`timeout_ms = 500`);
    await bad(`field_map = '[]'::jsonb`);
    await bad(`last_test_message = $2`, ['x'.repeat(501)]);
    await withTenant(h.pool, admin(), async (tx) => {
      expect((await tx.query(`UPDATE integration_endpoints SET schedule_kind = 'DAILY', schedule_daily_at = '02:30' WHERE id = $1`, [id])).rowCount).toBe(1);
      expect((await tx.query(`UPDATE integration_endpoints SET schedule_kind = 'INTERVAL', schedule_daily_at = NULL, schedule_interval_min = 15 WHERE id = $1`, [id])).rowCount).toBe(1);
    });
    // Adres/yol/kimlik türü olmadan özellik açılamaz.
    const bare = await withTenant(h.pool, admin(), async (tx) => (await tx.query<{ id: string }>(
      `INSERT INTO integration_endpoints (tenant_id, feature) VALUES ($1, 'PAYMENT_STATUS') ON CONFLICT (tenant_id, feature) DO UPDATE SET updated_at = now() RETURNING id`,
      [h.world.tenantA])).rows[0]!.id);
    await withTenant(h.pool, admin(), (tx) => rejects(tx.query(`UPDATE integration_endpoints SET enabled = true, base_url = NULL WHERE id = $1`, [bare]), '23514',
      /integration_endpoints_enabled_config/));
  });
});

describe('057 sır', () => {
  it('secret_table_has_no_plaintext_column', async () => {
    const cols = (await h.owner.query<{ column_name: string; data_type: string }>(`SELECT column_name, data_type FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'integration_endpoint_secrets' ORDER BY column_name`)).rows;
    // Tek metin sütunu anahtar kimliğidir (8 hex, CHECK); sır yalnız bytea şifreli metin.
    expect(cols.filter((c) => ['text', 'character varying', 'character', 'json', 'jsonb'].includes(c.data_type)).map((c) => c.column_name)).toEqual(['kek_id']);
    expect(cols.filter((c) => c.data_type === 'bytea').map((c) => c.column_name)).toEqual(['ciphertext', 'dek_iv', 'secret_iv', 'wrapped_dek']);
    // Uç nokta tablosunda da parola/sır sütunu yok.
    const ep = (await h.owner.query<{ column_name: string }>(`SELECT column_name FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'integration_endpoints'`)).rows.map((r) => r.column_name);
    expect(ep.filter((c) => /pass|secret|sifre|parola|token$|cipher/i.test(c))).toEqual([]);
  });

  it('secret_rows_tenant_scoped_shape_checked_deletable_only_in_own_tenant', async () => {
    const id = await endpoint('SUPPLIER');
    const s = sealed();
    await withTenant(h.pool, admin(), async (tx) => {
      await tx.query(`INSERT INTO integration_endpoint_secrets (endpoint_id, tenant_id, kek_id, wrapped_dek, dek_iv, secret_iv, ciphertext, updated_by)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`, [id, h.world.tenantA, s.kek, s.dek, s.dekIv, s.iv, s.ct, h.world.users.tenantAdmin.id]);
      expect((await tx.query(`UPDATE integration_endpoint_secrets SET ciphertext = $2, updated_at = now() WHERE endpoint_id = $1`, [id, randomBytes(30)])).rowCount).toBe(1);
    });
    // Biçim: kek_id 8 hex, IV 12 bayt.
    await withTenant(h.pool, admin(), (tx) => rejects(tx.query(`UPDATE integration_endpoint_secrets SET kek_id = 'parola123' WHERE endpoint_id = $1`, [id]), '23514'));
    await withTenant(h.pool, admin(), (tx) => rejects(tx.query(`UPDATE integration_endpoint_secrets SET secret_iv = $2 WHERE endpoint_id = $1`, [id, randomBytes(16)]), '23514'));
    // Başka kiracı ve tedarikçi bağlamı görmez; başka kiracının uç noktasına sır yazılamaz.
    await withTenant(h.pool, tenantB(), async (tx) => {
      expect(await count(tx, `integration_endpoint_secrets WHERE endpoint_id = $1`, [id])).toBe(0);
      expect((await tx.query(`UPDATE integration_endpoint_secrets SET kek_id = 'ffffffff' WHERE endpoint_id = $1`, [id])).rowCount).toBe(0);
    });
    await withTenant(h.pool, supplierCtx(), async (tx) => expect(await count(tx, `integration_endpoint_secrets`)).toBe(0));
    // Kiracı-bileşik FK: B kendi kiracısı adına A'nın (sırsız) uç noktasına sır bağlayamaz.
    const bare = await endpoint('CONTRACT_HEADER');
    await withTenant(h.pool, tenantB(), (tx) => rejects(tx.query(`INSERT INTO integration_endpoint_secrets (endpoint_id, tenant_id, kek_id, wrapped_dek, dek_iv,
      secret_iv, ciphertext, updated_by) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [bare, h.world.tenantB, s.kek, s.dek, s.dekIv, s.iv, s.ct, h.world.users.buyerB.id]), '23503'));
    // 058b (Ruling 5): sır satırı yalnız kendi kiracısında silinir; uç nokta kalır. Başka kiracı ve tedarikçi bağlamı silemez.
    await withTenant(h.pool, tenantB(), async (tx) => expect((await tx.query(`DELETE FROM integration_endpoint_secrets WHERE endpoint_id = $1`, [id])).rowCount).toBe(0));
    await withTenant(h.pool, supplierCtx(), async (tx) => expect((await tx.query(`DELETE FROM integration_endpoint_secrets WHERE endpoint_id = $1`, [id])).rowCount).toBe(0));
    await withTenant(h.pool, admin(), async (tx) => {
      expect((await tx.query(`DELETE FROM integration_endpoint_secrets WHERE endpoint_id = $1`, [id])).rowCount).toBe(1);
      expect(await count(tx, `integration_endpoints WHERE id = $1`, [id])).toBe(1);
    });
  });
});

describe('057 çalışma ve hata kaydı', () => {
  it('runs_mock_flag_follows_provider_and_finished_run_immutable', async () => {
    const id = await endpoint('PURCHASE_ORDER');
    const ins = (provider: string | null, mock: boolean, status = 'RUNNING', endpointId: string | null = id) =>
      withTenant(h.pool, admin(), (tx) => tx.query(`INSERT INTO integration_runs (tenant_id, endpoint_id, feature, trigger, provider_kind, mock, status,
        finished_at, requested_by) VALUES ($1, $2, 'PURCHASE_ORDER', 'MANUAL', $3, $4, $5, CASE WHEN $5 = 'RUNNING' THEN NULL ELSE now() END, $6)`,
        [h.world.tenantA, endpointId, provider, mock, status, h.world.users.tenantAdmin.id]));
    await rejects(ins('TAKLIT', false), '23514', /integration_runs_mock_check/);          // taklit gerçek gibi kaydedilemez
    await rejects(ins('ORACLE_EBS', true), '23514', /integration_runs_mock_check/);
    await rejects(ins(null, false, 'SUCCESS'), '23514', /integration_runs_mock_check/);   // sağlayıcısız yalnız NOT_CONFIGURED
    await ins(null, false, 'NOT_CONFIGURED', null);
    // Özellik uç noktanınkiyle aynı olmalı.
    const other = await endpoint('INVOICE');
    await rejects(ins('TAKLIT', true, 'RUNNING', other), '23503');
    // Elle/sınama tetikleyeni bilinir.
    await withTenant(h.pool, admin(), (tx) => rejects(tx.query(`INSERT INTO integration_runs (tenant_id, endpoint_id, feature, trigger, provider_kind, mock)
      VALUES ($1, $2, 'PURCHASE_ORDER', 'TEST', 'TAKLIT', true)`, [h.world.tenantA, id]), '23514'));

    const run = await finishedRun(id, 'PURCHASE_ORDER');
    await withTenant(h.pool, admin(), (tx) => rejects(tx.query(`UPDATE integration_runs SET status = 'SUCCESS' WHERE id = $1`, [run]), '23514'));   // bitiş zamanı birlikte
    await withTenant(h.pool, admin(), async (tx) => {
      expect((await tx.query(`UPDATE integration_runs SET status = 'PARTIAL', finished_at = now(), counts = '{"read":3,"failed":1}' WHERE id = $1`, [run])).rowCount).toBe(1);
    });
    await withTenant(h.pool, admin(), (tx) => rejects(tx.query(`UPDATE integration_runs SET counts = '{}' WHERE id = $1`, [run]), 'P0001', /finished integration run/));
    await withTenant(h.pool, admin(), (tx) => rejects(tx.query(`UPDATE integration_runs SET mock = false WHERE id = $1`, [run]), '42501'));
    await withTenant(h.pool, admin(), (tx) => rejects(tx.query(`DELETE FROM integration_runs WHERE id = $1`, [run]), '42501'));
    await rejects(h.owner.query(`DELETE FROM integration_runs WHERE id = $1`, [run]), 'P0001');
  });

  it('run_errors_insert_only_and_bounded', async () => {
    const id = await endpoint('PURCHASE_ORDER');
    const run = await finishedRun(id, 'PURCHASE_ORDER');
    const errId = await withTenant(h.pool, admin(), async (tx) => (await tx.query<{ id: string }>(`INSERT INTO integration_run_errors (tenant_id, run_id,
        record_key, code, message, payload_sha256) VALUES ($1, $2, 'PO-SNT-1', 'amount_invalid', 'Tutar biçimi geçersiz (sentetik)', $3) RETURNING id`,
      [h.world.tenantA, run, 'a'.repeat(64)])).rows[0]!.id);
    await withTenant(h.pool, admin(), (tx) => rejects(tx.query(`UPDATE integration_run_errors SET message = 'değişti' WHERE id = $1`, [errId]), '42501'));
    await withTenant(h.pool, admin(), (tx) => rejects(tx.query(`DELETE FROM integration_run_errors WHERE id = $1`, [errId]), '42501'));
    await rejects(h.owner.query(`UPDATE integration_run_errors SET message = 'değişti' WHERE id = $1`, [errId]), 'P0001', /immutable_record/);
    await rejects(h.owner.query(`DELETE FROM integration_run_errors WHERE id = $1`, [errId]), 'P0001', /immutable_record/);
    // İleti ≤ 500; özet 64 hex.
    await withTenant(h.pool, admin(), (tx) => rejects(tx.query(`INSERT INTO integration_run_errors (tenant_id, run_id, code, message) VALUES ($1, $2, 'x', $3)`,
      [h.world.tenantA, run, 'x'.repeat(501)]), '22001'));
    await withTenant(h.pool, admin(), (tx) => rejects(tx.query(`INSERT INTO integration_run_errors (tenant_id, run_id, code, message, payload_sha256)
      VALUES ($1, $2, 'x', 'y', 'ham yük')`, [h.world.tenantA, run]), '23514'));
    // Başka kiracının çalışmasına hata yazılamaz.
    await withTenant(h.pool, tenantB(), (tx) => rejects(tx.query(`INSERT INTO integration_run_errors (tenant_id, run_id, code, message) VALUES ($1, $2, 'x', 'y')`,
      [h.world.tenantB, run]), '23503'));
  });
});

describe('057 ERP yazma kaydı', () => {
  it('outbound_idempotent_status_shapes_no_delete', async () => {
    const w = h.world;
    const key = `erp:SUPPLIER:${randomUUID()}:v1`;
    const id = await withTenant(h.pool, admin(), async (tx) => (await tx.query<{ id: string }>(`INSERT INTO erp_outbound_records (tenant_id, feature, entity_type,
        entity_id, idempotency_key, created_by) VALUES ($1, 'SUPPLIER', 'SUPPLIER', $2, $3, $4) RETURNING id`, [w.tenantA, w.suppliers.s1, key, w.users.tenantAdmin.id])).rows[0]!.id);
    await withTenant(h.pool, admin(), (tx) => rejects(tx.query(`INSERT INTO erp_outbound_records (tenant_id, feature, entity_type, entity_id, idempotency_key)
      VALUES ($1, 'SUPPLIER', 'SUPPLIER', $2, $3)`, [w.tenantA, w.suppliers.s1, key]), '23505'));
    // Okuma özelliği için yazma kaydı açılmaz.
    await withTenant(h.pool, admin(), (tx) => rejects(tx.query(`INSERT INTO erp_outbound_records (tenant_id, feature, entity_type, entity_id, idempotency_key)
      VALUES ($1, 'INVOICE', 'INVOICE', $2, $3)`, [w.tenantA, randomUUID(), `k-${rand()}`]), '23514'));
    // Gönderildi: dış referans ve sağlayıcı zorunlu.
    await withTenant(h.pool, admin(), (tx) => rejects(tx.query(`UPDATE erp_outbound_records SET status = 'SENT' WHERE id = $1`, [id]), '23514'));
    await withTenant(h.pool, admin(), async (tx) => {
      expect((await tx.query(`UPDATE erp_outbound_records SET status = 'UNKNOWN', attempts = 1, last_error = 'Zaman aşımı', updated_at = now() WHERE id = $1`, [id])).rowCount).toBe(1);
      expect((await tx.query(`UPDATE erp_outbound_records SET status = 'SENT', provider_kind = 'TAKLIT', external_ref = 'TKL-SUP-1' WHERE id = $1`, [id])).rowCount).toBe(1);
    });
    await withTenant(h.pool, admin(), (tx) => rejects(tx.query(`DELETE FROM erp_outbound_records WHERE id = $1`, [id]), '42501'));
    expect(await one(`SELECT status, external_ref, attempts FROM erp_outbound_records WHERE id = $1`, [id])).toEqual({ status: 'SENT', external_ref: 'TKL-SUP-1', attempts: 1 });
    await withTenant(h.pool, admin(), (tx) => rejects(tx.query(`UPDATE erp_outbound_records SET idempotency_key = 'x' WHERE id = $1`, [id]), '42501'));
    await rejects(h.owner.query(`DELETE FROM erp_outbound_records WHERE id = $1`, [id]), 'P0001');
    // "ERP'ye elle iletildi": yapan, zaman ve referans birlikte; sağlayıcı yok.
    const manual = (ref: string | null, provider: string | null) => withTenant(h.pool, admin(), (tx) => tx.query(`INSERT INTO erp_outbound_records (tenant_id, feature,
      entity_type, entity_id, idempotency_key, status, external_ref, provider_kind, manual_by, manual_at, manual_note)
      VALUES ($1, 'REQUISITION', 'PROJECT', $2, $3, 'MANUAL', $4, $5, $6, now(), 'Elle iletildi (sentetik)')`,
      [w.tenantA, randomUUID(), `manual-${rand()}`, ref, provider, w.users.buyer.id]));
    await rejects(manual(null, null), '23514');
    await rejects(manual('REQ-1', 'TAKLIT'), '23514');
    await manual('REQ-SNT-1', null);
    await withTenant(h.pool, tenantB(), async (tx) => expect(await count(tx, `erp_outbound_records WHERE id = $1`, [id])).toBe(0));
  });
});

describe('057/058 kiracı yalıtımı ve izinler', () => {
  it('every_new_table_tenant_isolated_supplier_blind', async () => {
    const w = h.world;
    const ep = await endpoint('PURCHASE_ORDER');
    const run = await finishedRun(ep, 'PURCHASE_ORDER');
    await withTenant(h.pool, admin(), async (tx) => {
      await tx.query(`INSERT INTO integration_run_errors (tenant_id, run_id, code, message) VALUES ($1, $2, 'unmatched', 'eşleşmedi (sentetik)')`, [w.tenantA, run]);
      await tx.query(`INSERT INTO erp_outbound_records (tenant_id, feature, entity_type, entity_id, idempotency_key) VALUES ($1, 'CONTRACT_HEADER', 'CONTRACT_FAMILY', $2, $3)`,
        [w.tenantA, randomUUID(), `iso-${rand()}`]);
      await tx.query(`INSERT INTO erp_cost_centers (tenant_id, code, name, provider_kind) VALUES ($1, $2, 'Bilgi Teknolojileri (SENTETİK)', 'TAKLIT')`, [w.tenantA, `MM-${rand()}`]);
      await tx.query(`INSERT INTO erp_purchase_orders (tenant_id, erp_po_id, po_no, supplier_id, currency, amount, provider_kind)
        VALUES ($1, $2, $3, $4, 'TRY', '1250.5000', 'TAKLIT')`, [w.tenantA, `TKL-PO-${rand()}`, `TKL2026PO${rand()}`, w.suppliers.s1]);
      for (const t of NEW_TABLES.filter((x) => x !== 'integration_endpoint_secrets')) expect(await count(tx, t), t).toBeGreaterThan(0);
    });
    await withTenant(h.pool, tenantB(), async (tx) => {
      for (const t of NEW_TABLES) expect(await count(tx, `${t} WHERE tenant_id = $1`, [w.tenantA]), t).toBe(0);
      expect((await tx.query(`UPDATE integration_endpoints SET enabled = true WHERE id = $1`, [ep])).rowCount).toBe(0);
    });
    // Başka kiracı adına yazılamaz (RLS WITH CHECK); her deneme ayrı işlemde.
    const foreign: [string, unknown[]][] = [
      [`INSERT INTO integration_endpoints (tenant_id, feature) VALUES ($1, 'COST_CENTER')`, [w.tenantA]],
      [`INSERT INTO erp_cost_centers (tenant_id, code, name, provider_kind) VALUES ($1, 'X', 'Y', 'TAKLIT')`, [w.tenantA]],
      [`INSERT INTO erp_outbound_records (tenant_id, feature, entity_type, entity_id, idempotency_key) VALUES ($1, 'SUPPLIER', 'SUPPLIER', $2, 'x')`, [w.tenantA, randomUUID()]],
      [`INSERT INTO integration_runs (tenant_id, feature, trigger, mock, status, finished_at) VALUES ($1, 'INVOICE', 'SCHEDULE', false, 'NOT_CONFIGURED', now())`, [w.tenantA]],
      [`INSERT INTO erp_purchase_orders (tenant_id, erp_po_id, po_no, provider_kind) VALUES ($1, 'x', 'y', 'TAKLIT')`, [w.tenantA]],
    ];
    for (const [sql, params] of foreign) await withTenant(h.pool, tenantB(), (tx) => rejects(tx.query(sql, params), '42501'));
    await withTenant(h.pool, supplierCtx(), async (tx) => {
      for (const t of NEW_TABLES) expect(await count(tx, t), t).toBe(0);
    });
    await withTenant(h.pool, supplierCtx(), (tx) => rejects(tx.query(`INSERT INTO erp_cost_centers (tenant_id, code, name, provider_kind) VALUES ($1, 'X', 'Y', 'TAKLIT')`,
      [w.tenantA]), '42501'));
  });

  it('no_delete_grant_on_new_tables_and_rls_enabled', async () => {
    const grants = (await h.owner.query<{ table_name: string; privilege_type: string }>(`SELECT table_name, privilege_type FROM information_schema.table_privileges
      WHERE grantee = 'sp_app' AND table_name = ANY ($1)`, [NEW_TABLES])).rows;
    // 058b (Ruling 5): tek istisna sır tablosundaki DELETE (sır kaldırma); TRUNCATE ve tablo düzeyinde UPDATE hiçbirinde yok.
    expect(grants.filter((g) => ['DELETE', 'TRUNCATE', 'UPDATE'].includes(g.privilege_type))).toEqual([{ table_name: 'integration_endpoint_secrets', privilege_type: 'DELETE' }]);
    const rls = (await h.owner.query<{ relname: string; relrowsecurity: boolean }>(`SELECT relname, relrowsecurity FROM pg_class WHERE relname = ANY ($1)`, [NEW_TABLES])).rows;
    expect(rls).toHaveLength(NEW_TABLES.length);
    expect(rls.every((r) => r.relrowsecurity)).toBe(true);
    // Mevcut tablolardaki yeni sütunlar yalnız sütun bazlı UPDATE; departments tablo düzeyinde UPDATE taşımaz, eski sütunlar güncellenebilir kalır.
    const tbl = (await h.owner.query(`SELECT table_name FROM information_schema.table_privileges WHERE grantee = 'sp_app'
      AND table_name IN ('invoices','suppliers','departments') AND privilege_type IN ('UPDATE','DELETE')`)).rows;
    expect(tbl).toEqual([]);
    const deptCols = (await h.owner.query<{ column_name: string }>(`SELECT column_name FROM information_schema.column_privileges WHERE grantee = 'sp_app'
      AND table_name = 'departments' AND privilege_type = 'UPDATE' ORDER BY 1`)).rows.map((r) => r.column_name);
    expect(deptCols).toEqual(['cost_center_code', 'cost_center_source', 'created_at', 'id', 'merged_into', 'name', 'normalized_name', 'source', 'tenant_id']);
  });
});

describe('058 ERP verisi', () => {
  it('supplier_and_department_codes_carry_source', async () => {
    const w = h.world;
    await withTenant(h.pool, admin(), async (tx) => {
      expect((await tx.query(`UPDATE suppliers SET erp_supplier_code = 'TED-SNT-01', erp_supplier_code_source = 'MANUAL' WHERE id = $1`, [w.suppliers.s2])).rowCount).toBe(1);
    });
    expect(await one(`SELECT erp_supplier_code, erp_supplier_code_source FROM suppliers WHERE id = $1`, [w.suppliers.s2]))
      .toEqual({ erp_supplier_code: 'TED-SNT-01', erp_supplier_code_source: 'MANUAL' });
    await withTenant(h.pool, admin(), (tx) => rejects(tx.query(`UPDATE suppliers SET erp_supplier_code = 'X' WHERE id = $1`, [w.suppliers.s3]), '23514'));
    await withTenant(h.pool, admin(), (tx) => rejects(tx.query(`UPDATE suppliers SET erp_supplier_code = 'X', erp_supplier_code_source = 'ENTRA' WHERE id = $1`, [w.suppliers.s3]), '23514'));
    await withTenant(h.pool, admin(), (tx) => rejects(tx.query(`UPDATE suppliers SET erp_supplier_code = ' X ', erp_supplier_code_source = 'ERP' WHERE id = $1`, [w.suppliers.s3]), '23514'));
    // Tedarikçi kendi kartında ERP kodunu değiştiremez (mevcut kısıtlayıcı politika).
    await withTenant(h.pool, supplierCtx(), async (tx) => {
      expect((await tx.query(`UPDATE suppliers SET erp_supplier_code = 'KENDI', erp_supplier_code_source = 'MANUAL' WHERE id = $1`, [w.suppliers.s1])).rowCount).toBe(0);
    });
    await withTenant(h.pool, admin(), async (tx) => {
      expect((await tx.query(`UPDATE departments SET cost_center_code = 'MM-100', cost_center_source = 'MANUAL' WHERE id = $1`, [w.departments.bt])).rowCount).toBe(1);
      expect((await tx.query(`UPDATE departments SET name = name WHERE id = $1`, [w.departments.bt])).rowCount).toBe(1);   // eski sütun güncellenebilir
    });
    await withTenant(h.pool, admin(), (tx) => rejects(tx.query(`UPDATE departments SET cost_center_code = NULL WHERE id = $1`, [w.departments.bt]), '23514'));
    await withTenant(h.pool, tenantB(), async (tx) => {
      expect((await tx.query(`UPDATE departments SET cost_center_code = 'MM-B', cost_center_source = 'MANUAL' WHERE id = $1`, [w.departments.ik])).rowCount).toBe(0);
    });
  });

  it('cost_centers_and_purchase_orders_shape', async () => {
    const w = h.world;
    const code = `MM-${rand()}`;
    await withTenant(h.pool, admin(), async (tx) => {
      await tx.query(`INSERT INTO erp_cost_centers (tenant_id, code, name, provider_kind) VALUES ($1, $2, 'İnsan Kaynakları (SENTETİK)', 'TAKLIT')`, [w.tenantA, code]);
      expect((await tx.query(`INSERT INTO erp_cost_centers (tenant_id, code, name, provider_kind) VALUES ($1, $2, 'Yeni ad', 'TAKLIT')
        ON CONFLICT (tenant_id, code) DO UPDATE SET name = EXCLUDED.name, active = false, synced_at = now()`, [w.tenantA, code])).rowCount).toBe(1);
    });
    await withTenant(h.pool, admin(), (tx) => rejects(tx.query(`DELETE FROM erp_cost_centers WHERE code = $1`, [code]), '42501'));
    const poId = `TKL-PO-${rand()}`;
    const po = (amount: string) => withTenant(h.pool, admin(), (tx) => tx.query(`INSERT INTO erp_purchase_orders (tenant_id, erp_po_id, po_no, currency, amount, provider_kind)
      VALUES ($1, $2, 'TKL2026PO-1', 'TRY', $3, 'TAKLIT')`, [w.tenantA, `${poId}-${amount}`, amount]));
    for (const bad of ['1.23456', '1,5', '1e3', '']) await rejects(po(bad), '23514');      // yuvarlanmaz, reddedilir
    await po('-12.3400');
    await withTenant(h.pool, admin(), (tx) => tx.query(`INSERT INTO erp_purchase_orders (tenant_id, erp_po_id, po_no, provider_kind) VALUES ($1, $2, 'TKL2026PO-2', 'TAKLIT')`, [w.tenantA, poId]));
    await withTenant(h.pool, admin(), (tx) => rejects(tx.query(`INSERT INTO erp_purchase_orders (tenant_id, erp_po_id, po_no, provider_kind) VALUES ($1, $2, 'TKL2026PO-3', 'TAKLIT')`, [w.tenantA, poId]), '23505'));
    // Başka kiracının tedarikçisine bağlanamaz.
    await withTenant(h.pool, tenantB(), (tx) => rejects(tx.query(`INSERT INTO erp_purchase_orders (tenant_id, erp_po_id, po_no, supplier_id, provider_kind)
      VALUES ($1, 'B-1', 'B-1', $2, 'TAKLIT')`, [w.tenantB, w.suppliers.s1]), '23503'));
  });

  it('invoice_erp_columns_link_once_payment_info_and_refs_unchanged', async () => {
    const w = h.world;
    const inv = async () => (await one<{ id: string }>(`INSERT INTO invoices (tenant_id, company_id, supplier_id, kind, invoice_no, issue_date, currency, created_by)
      VALUES ($1, $2, $3, 'INVOICE', $4, '2026-11-17', 'TRY', $5) RETURNING id`, [w.tenantA, w.companyA1.id, w.suppliers.s1, `SNT${rand()}`, w.users.buyer.id])).id;
    const a = await inv();
    const b = await inv();
    const erpId = `TKL-INV-${rand()}`;
    await withTenant(h.pool, admin(), async (tx) => {
      // Elle girilmiş faturaya ERP bağı (R12) bir kez yazılır.
      expect((await tx.query(`UPDATE invoices SET erp_invoice_id = $2, erp_provider_kind = 'TAKLIT' WHERE id = $1`, [a, erpId])).rowCount).toBe(1);
    });
    await withTenant(h.pool, admin(), (tx) => rejects(tx.query(`UPDATE invoices SET erp_invoice_id = $2, erp_provider_kind = 'TAKLIT' WHERE id = $1`, [b, erpId]), '23505'));
    await withTenant(h.pool, admin(), (tx) => rejects(tx.query(`UPDATE invoices SET erp_invoice_id = 'BASKA' WHERE id = $1`, [a]), 'P0001', /ERP link/));
    await withTenant(h.pool, admin(), (tx) => rejects(tx.query(`UPDATE invoices SET erp_provider_kind = 'ORACLE_EBS' WHERE id = $1`, [a]), 'P0001', /ERP link/));
    await withTenant(h.pool, admin(), (tx) => rejects(tx.query(`UPDATE invoices SET erp_invoice_id = 'X' WHERE id = $1`, [b]), '23514'));   // kaynak sağlayıcı birlikte
    // Ödeme durumu bilgisi: durum + kaynak birlikte; tarih yalnız durumla.
    await withTenant(h.pool, admin(), async (tx) => {
      expect((await tx.query(`UPDATE invoices SET erp_payment_status = 'PARTIAL', erp_payment_status_at = '2026-11-16', erp_payment_source = 'MANUAL' WHERE id = $1`, [b])).rowCount).toBe(1);
    });
    await withTenant(h.pool, admin(), (tx) => rejects(tx.query(`UPDATE invoices SET erp_payment_status = 'ODENDI' WHERE id = $1`, [b]), '23514'));
    await withTenant(h.pool, admin(), (tx) => rejects(tx.query(`UPDATE invoices SET erp_payment_source = NULL WHERE id = $1`, [b]), '23514'));
    // 055 ERP referansları (sözleşme / sipariş) yeniden eklenmedi ve hâlâ yalnız kayıt anında yazılır.
    const cols = (await h.owner.query<{ column_name: string }>(`SELECT column_name FROM information_schema.columns WHERE table_name = 'invoices' AND column_name LIKE 'erp_%' ORDER BY 1`)).rows.map((r) => r.column_name);
    expect(cols).toEqual(['erp_contract_ref', 'erp_contract_ref_source', 'erp_invoice_id', 'erp_order_ref', 'erp_order_ref_source', 'erp_payment_source',
      'erp_payment_status', 'erp_payment_status_at', 'erp_provider_kind']);
    // Başka kiracı faturanın ERP alanlarını değiştiremez.
    await withTenant(h.pool, tenantB(), async (tx) => {
      expect((await tx.query(`UPDATE invoices SET erp_payment_status = 'PAID', erp_payment_source = 'MANUAL' WHERE id = $1`, [b])).rowCount).toBe(0);
    });
  });

  it('existing_invoices_untouched_by_058', async () => {
    // Yeni fatura sütunları NULL ve varsayılansız eklendi: mevcut satırlar (demo ANB2026000101, ANB2026000102, EGE2026000877 dahil)
    // yeniden yazılmaz, yeni sütunları NULL okunur. Dosya hiçbir satırı güncellemez/silmez. Dev veritabanında önce/sonra karşılaştırması
    // ayrıca yapılır (rapor).
    const meta = (await h.owner.query<{ attname: string; attnotnull: boolean; atthasdef: boolean; atthasmissing: boolean }>(
      `SELECT attname, attnotnull, atthasdef, atthasmissing FROM pg_attribute WHERE attrelid = 'invoices'::regclass
       AND attname IN ('erp_invoice_id','erp_provider_kind','erp_payment_status','erp_payment_status_at','erp_payment_source') ORDER BY attname`)).rows;
    expect(meta).toHaveLength(5);
    expect(meta.every((m) => !m.attnotnull && !m.atthasdef && !m.atthasmissing)).toBe(true);
    for (const f of ['057_v2_integration_endpoints.sql', '058_v2_erp_data.sql', '058a_v2_erp_fixes.sql']) {
      const sql = (await readFile(new URL(`../migrations/${f}`, import.meta.url), 'utf8')).replace(/--.*$/gm, '');
      expect(sql, f).not.toMatch(/\b(UPDATE\s+(ONLY\s+)?(invoices|suppliers|departments)\b|DELETE\s+FROM|TRUNCATE)/i);
    }
    const demo = await one<{ n: number }>(`SELECT count(*)::int AS n FROM invoices WHERE invoice_no IN ('ANB2026000101','ANB2026000102','EGE2026000877')
      AND (erp_invoice_id IS NOT NULL OR erp_payment_status IS NOT NULL OR erp_provider_kind IS NOT NULL)`);
    expect(demo.n).toBe(0);
  });
});

describe('058a kaynak koruması', () => {
  const inv = async (refs: { contract?: string; order?: string } = {}) => (await one<{ id: string }>(`INSERT INTO invoices (tenant_id, company_id, supplier_id,
      kind, invoice_no, issue_date, currency, created_by, erp_contract_ref, erp_order_ref)
    VALUES ($1, $2, $3, 'INVOICE', $4, '2026-11-17', 'TRY', $5, $6, $7) RETURNING id`,
    [h.world.tenantA, h.world.companyA1.id, h.world.suppliers.s1, `SNT${rand()}`, h.world.users.buyer.id, refs.contract ?? null, refs.order ?? null])).id;
  const upd = (id: string, set: string, params: unknown[] = []) =>
    withTenant(h.pool, admin(), (tx) => tx.query(`UPDATE invoices SET ${set} WHERE id = $1`, [id, ...params]));
  const conflict = (id: string, set: string, params: unknown[] = []) => rejects(upd(id, set, params), 'P0001', /erp_source_conflict/);

  it('invoice_refs_null_to_value_manual_edit_erp_and_legacy_fixed', async () => {
    // NULL → değer (elle ya da ERP); kaynak referanssız olamaz, bilinmeyen kaynak yok.
    const a = await inv();
    await rejects(upd(a, `erp_order_ref_source = 'MANUAL'`), '23514');
    await rejects(upd(a, `erp_order_ref = 'SIP-1', erp_order_ref_source = 'ELLE'`), '23514');
    expect((await upd(a, `erp_order_ref = 'SIP-EL-1', erp_order_ref_source = 'MANUAL', erp_contract_ref = 'SZL-ERP-1', erp_contract_ref_source = 'ERP'`)).rowCount).toBe(1);
    // Elle değer elle düzeltilir; silinemez; ERP üzerine yazamaz (aynı değerle bile kaynağı ERP'ye çeviremez).
    expect((await upd(a, `erp_order_ref = 'SIP-EL-2'`)).rowCount).toBe(1);
    await conflict(a, `erp_order_ref = 'SIP-ERP-9', erp_order_ref_source = 'ERP'`);
    await conflict(a, `erp_order_ref_source = 'ERP'`);
    await conflict(a, `erp_order_ref = NULL, erp_order_ref_source = NULL`);
    // ERP değeri değişmez: ne ERP ne elle.
    await conflict(a, `erp_contract_ref = 'SZL-ERP-2'`);
    await conflict(a, `erp_contract_ref = 'SZL-EL', erp_contract_ref_source = 'MANUAL'`);
    expect((await upd(a, `erp_contract_ref = 'SZL-ERP-1'`)).rowCount).toBe(1);    // değişiklik yok: geçer
    expect(await one(`SELECT erp_order_ref, erp_order_ref_source, erp_contract_ref, erp_contract_ref_source FROM invoices WHERE id = $1`, [a]))
      .toEqual({ erp_order_ref: 'SIP-EL-2', erp_order_ref_source: 'MANUAL', erp_contract_ref: 'SZL-ERP-1', erp_contract_ref_source: 'ERP' });
    // 058a öncesi / kaynaksız yazılmış referans (demo faturalar gibi): kaynak NULL kalır, değer ve kaynak değişmez.
    const legacy = await inv({ contract: 'SZL-ESKI-1', order: 'SIP-ESKI-1' });
    await conflict(legacy, `erp_order_ref = 'SIP-YENI'`);
    await conflict(legacy, `erp_order_ref_source = 'MANUAL'`);
    await conflict(legacy, `erp_contract_ref = NULL`);
    expect(await one(`SELECT erp_contract_ref_source, erp_order_ref_source FROM invoices WHERE id = $1`, [legacy]))
      .toEqual({ erp_contract_ref_source: null, erp_order_ref_source: null });
    // Kayıt anında kaynakla yazmak da geçerli; başka kiracı göremez/güncelleyemez.
    await withTenant(h.pool, tenantB(), async (tx) => expect((await tx.query(`UPDATE invoices SET erp_order_ref = 'B' WHERE id = $1`, [a])).rowCount).toBe(0));
  });

  it('erp_never_replaces_manual_supplier_department_payment', async () => {
    const w = h.world;
    const sup = w.suppliers.s3;
    const run = (set: string, id: string, table: string) => withTenant(h.pool, admin(), (tx) => tx.query(`UPDATE ${table} SET ${set} WHERE id = $1`, [id]));
    // ERP → ERP ve elle → elle, elle düzeltme ERP'nin yerine geçebilir; ERP elle değerin yerine geçemez.
    expect((await run(`erp_supplier_code = 'TED-ERP-1', erp_supplier_code_source = 'ERP'`, sup, 'suppliers')).rowCount).toBe(1);
    expect((await run(`erp_supplier_code = 'TED-ERP-2', erp_supplier_code_source = 'ERP'`, sup, 'suppliers')).rowCount).toBe(1);
    expect((await run(`erp_supplier_code = 'TED-EL-1', erp_supplier_code_source = 'MANUAL'`, sup, 'suppliers')).rowCount).toBe(1);
    await rejects(run(`erp_supplier_code = 'TED-ERP-3', erp_supplier_code_source = 'ERP'`, sup, 'suppliers'), 'P0001', /erp_source_conflict/);
    expect((await run(`erp_supplier_code = 'TED-EL-2'`, sup, 'suppliers')).rowCount).toBe(1);
    const dep = w.departments.tc;
    expect((await run(`cost_center_code = 'MM-EL', cost_center_source = 'MANUAL'`, dep, 'departments')).rowCount).toBe(1);
    await rejects(run(`cost_center_code = 'MM-ERP', cost_center_source = 'ERP'`, dep, 'departments'), 'P0001', /erp_source_conflict/);
    await rejects(run(`cost_center_source = 'ERP'`, dep, 'departments'), 'P0001', /erp_source_conflict/);
    const i = await inv();
    expect((await upd(i, `erp_payment_status = 'UNPAID', erp_payment_source = 'ERP'`)).rowCount).toBe(1);
    expect((await upd(i, `erp_payment_status = 'PARTIAL', erp_payment_status_at = '2026-11-15', erp_payment_source = 'ERP'`)).rowCount).toBe(1);
    expect((await upd(i, `erp_payment_status = 'PAID', erp_payment_status_at = '2026-11-16', erp_payment_source = 'MANUAL'`)).rowCount).toBe(1);
    await conflict(i, `erp_payment_status = 'UNPAID', erp_payment_source = 'ERP'`);
    expect(await one(`SELECT erp_payment_status, erp_payment_source FROM invoices WHERE id = $1`, [i])).toEqual({ erp_payment_status: 'PAID', erp_payment_source: 'MANUAL' });
  });

  it('outbound_external_ref_write_once_confirmed_and_manual_terminal', async () => {
    const w = h.world;
    const mk = async (status = 'PENDING') => withTenant(h.pool, admin(), async (tx) => (await tx.query<{ id: string }>(`INSERT INTO erp_outbound_records
        (tenant_id, feature, entity_type, entity_id, idempotency_key, status, external_ref, manual_by, manual_at)
      VALUES ($1, 'CONTRACT_HEADER', 'CONTRACT_FAMILY', $2, $3, $4, $5, $6, $7) RETURNING id`,
      [w.tenantA, randomUUID(), `ob-${randomUUID()}`, status, status === 'MANUAL' ? 'SZL-ELLE-1' : null,
       status === 'MANUAL' ? w.users.buyer.id : null, status === 'MANUAL' ? new Date() : null])).rows[0]!.id);
    const set = (id: string, s: string) => withTenant(h.pool, admin(), (tx) => tx.query(`UPDATE erp_outbound_records SET ${s} WHERE id = $1`, [id]));
    const r = await mk();
    expect((await set(r, `status = 'UNKNOWN', provider_kind = 'TAKLIT', external_ref = 'TKL-1', attempts = 1`)).rowCount).toBe(1);
    await rejects(set(r, `external_ref = 'TKL-2'`), 'P0001', /write-once/);
    await rejects(set(r, `external_ref = NULL`), 'P0001', /write-once/);
    expect((await set(r, `status = 'SENT', attempts = 2, updated_at = now()`)).rowCount).toBe(1);
    expect((await set(r, `status = 'CONFIRMED'`)).rowCount).toBe(1);
    await rejects(set(r, `status = 'FAILED'`), 'P0001', /CONFIRMED outbound/);
    await rejects(set(r, `updated_at = now()`), 'P0001', /CONFIRMED outbound/);
    const m = await mk('MANUAL');
    await rejects(set(m, `status = 'PENDING', manual_by = NULL, manual_at = NULL`), 'P0001', /MANUAL outbound/);
    await rejects(set(m, `manual_note = 'değişti'`), 'P0001', /MANUAL outbound/);
    // Başarısız gönderim elle iletildi olarak kapatılabilir (dış referansı yoksa).
    const f = await mk();
    expect((await set(f, `status = 'FAILED', last_error = 'Bağlantı yok (sentetik)'`)).rowCount).toBe(1);
    expect((await set(f, `status = 'MANUAL', external_ref = 'SZL-ELLE-2', manual_by = '${w.users.buyer.id}', manual_at = now()`)).rowCount).toBe(1);
  });
});
