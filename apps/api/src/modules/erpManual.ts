// v2 Faz 8 (D113) Görev 6: elle ERP kayıtları (R6) — özellik kapalıyken de açıkken de her zaman açık yol.
//  * Tedarikçi kartında "ERP tedarikçi kodu" (Satınalma), departmanda "Masraf merkezi kodu" (Yönetici), proje/sözleşme/tedarikçi için
//    "ERP'ye elle iletildi" + ERP referans no (Satınalma), faturada ERP ödeme durumu bilgisi (Satınalma; uygulama ödeme yapmaz).
//  * Her değer `source = 'MANUAL'` ile yazılır ve denetlenir; ERP okuması elle değeri ezmez (058a koruması + erpRead).
//  * Demo faturalar (ANB2026000101, ANB2026000102, EGE2026000877) elle yolla da değişmez.
import { ERP_FEATURE_CATALOG, can, type ErpFeature } from '@sp/domain';
import type { TenantContext, Tx } from '../db.ts';
import { audit } from '../audit.ts';
import { conflict, notFound, unprocessable } from '../errors.ts';
import { ALREADY_IN_ERP_PREFIX, CARD_CODE_UNVERIFIED_PREFIX, ERP_ENTITY_TYPE, supplierCodeProvenance, ERP_WRITE_FEATURES, ERP_WRITE_JOB, ERP_WRITE_LIMITS, erpProviderReady, isWriteFeature, type WriteFeature } from './erpWrite.ts';
import type { ErpProviderKind } from '../erp/providers.ts';
import { PROTECTED_DEMO_INVOICES } from './erpRead.ts';
import { ERP_PAYMENT_STATUS_TR } from './invoices.ts';

const SOURCE_TR: Record<string, string> = { ERP: 'ERP', MANUAL: 'Elle' };
const PROVIDER_TR: Record<string, string> = { ORACLE_EBS: 'Oracle ERP', TAKLIT: 'Taklit Oracle (gerçek değil)' };
const MOCK_NOTE = 'taklit sağlayıcıyla denendi — gerçek Oracle değil';
export const OUTBOUND_STATUS_TR: Record<string, string> = {
  PENDING: 'ERP\'ye gönderilmeyi bekliyor', SENT: 'ERP\'ye gönderildi', CONFIRMED: 'ERP onayladı', FAILED: 'Gönderilemedi',
  UNKNOWN: 'Belirsiz (zaman aşımı; yeniden denemede önce ERP\'de aranır)', MANUAL: 'ERP\'ye elle iletildi',
};
const ENTITY_TYPES = ['SUPPLIER', 'PROJECT', 'CONTRACT_FAMILY'] as const;
type EntityType = (typeof ENTITY_TYPES)[number];
const CODE_MAX = 60;
const YMD = /^\d{4}-\d{2}-\d{2}$/;

const norm = (s: unknown) => (typeof s === 'string' ? s.trim() : '');
function validCode(raw: unknown, field: string): string {
  const v = norm(raw);
  if (!v || v.length > CODE_MAX || /[\u0000-\u001f]/.test(v)) throw unprocessable('invalid_code', `${field} 1–${CODE_MAX} karakter olmalı.`, { field });
  return v;
}

// ---------- Tedarikçi ERP kodu ----------

export async function supplierErpCode(tx: Tx, ctx: TenantContext, supplierId: string) {
  const pv = await supplierCodeProvenance(tx, supplierId);
  if (!pv) throw notFound();
  // ERP kaynaklı kodun sağlayıcısı denetim kaydından; kayıt yoksa (eski/tohum veri) provider ve mock null: "kaynağı doğrulanamadı".
  const provider = pv.source !== 'ERP' || pv.mock === null ? null
    : pv.mock ? { kind: 'TAKLIT', label: PROVIDER_TR.TAKLIT, real: false } : { kind: 'ORACLE_EBS', label: PROVIDER_TR.ORACLE_EBS, real: true };
  return { supplierId, code: pv.code, source: pv.source, sourceLabel: pv.sourceLabel, provider, mock: pv.source === 'ERP' ? pv.mock : false,
    verified: pv.verified, canEdit: can(ctx.roles, 'erp.manual.record') };
}

/** `PUT /suppliers/:id/erp-code { code }` — elle kod (kaynak MANUAL); `code: null` kodu temizler. Aynı kod başka kartta olamaz. */
export async function setSupplierErpCode(tx: Tx, ctx: TenantContext, supplierId: string, body: { code: string | null }) {
  const cur = (await tx.query<{ erp_supplier_code: string | null; erp_supplier_code_source: string | null; status: string }>(
    `SELECT erp_supplier_code, erp_supplier_code_source, status FROM suppliers WHERE id = $1 FOR UPDATE`, [supplierId])).rows[0];
  if (!cur) throw notFound();
  if (cur.status === 'MERGED') throw conflict('supplier_merged', 'Birleştirilmiş tedarikçi kartına ERP kodu yazılmaz; birleştiği kartı kullanın.');
  const code = body.code === null ? null : validCode(body.code, 'ERP tedarikçi kodu');
  if (code !== null) {
    // Birleştirilmiş (MERGED) kart sayılmaz: kod birleşmede yaşayan karta taşınabilir.
    const other = (await tx.query<{ id: string; legal_name: string }>(`SELECT id, legal_name FROM suppliers WHERE erp_supplier_code = $1 AND id <> $2
      AND status <> 'MERGED' LIMIT 1`, [code, supplierId])).rows[0];
    if (other) throw conflict('supplier_code_duplicate', `ERP tedarikçi kodu ${code} başka bir tedarikçi kartında kayıtlı (${other.legal_name}).`, { supplierId: other.id });
  }
  if (code === cur.erp_supplier_code && (code === null || cur.erp_supplier_code_source === 'MANUAL')) return supplierErpCode(tx, ctx, supplierId);
  await tx.query(`UPDATE suppliers SET erp_supplier_code = $2, erp_supplier_code_source = $3 WHERE id = $1`, [supplierId, code, code === null ? null : 'MANUAL']);
  await audit(tx, ctx, 'supplier.erp_code_set', 'supplier', supplierId,
    { from: cur.erp_supplier_code, fromSource: cur.erp_supplier_code_source, to: code, source: code === null ? null : 'MANUAL' });
  return supplierErpCode(tx, ctx, supplierId);
}

// ---------- Departman masraf merkezi ----------

export async function listDepartmentCostCenters(tx: Tx) {
  const rows = (await tx.query<{ id: string; name: string; cost_center_code: string | null; cost_center_source: string | null }>(
    `SELECT id, name, cost_center_code, cost_center_source FROM departments WHERE merged_into IS NULL ORDER BY name, id`)).rows;
  return { items: rows.map((r) => ({ departmentId: r.id, name: r.name, costCenterCode: r.cost_center_code, source: r.cost_center_source,
    sourceLabel: r.cost_center_source ? SOURCE_TR[r.cost_center_source] : null })) };
}

/** `PUT /departments/:id/cost-center { code | null }` — Yönetici; kaynak MANUAL (departman ana kaynağı Entra kalır, ad değişmez). */
export async function setDepartmentCostCenter(tx: Tx, ctx: TenantContext, departmentId: string, body: { code: string | null }) {
  const cur = (await tx.query<{ name: string; cost_center_code: string | null; cost_center_source: string | null; merged_into: string | null }>(
    `SELECT name, cost_center_code, cost_center_source, merged_into FROM departments WHERE id = $1 FOR UPDATE`, [departmentId])).rows[0];
  if (!cur) throw notFound();
  if (cur.merged_into) throw conflict('department_merged', 'Birleştirilmiş departmana masraf merkezi yazılmaz.');
  const code = body.code === null ? null : validCode(body.code, 'Masraf merkezi kodu');
  const erpKnown = code ? ((await tx.query(`SELECT 1 FROM erp_cost_centers WHERE code = $1`, [code])).rowCount ?? 0) > 0 : null;
  if (!(code === cur.cost_center_code && (code === null || cur.cost_center_source === 'MANUAL'))) {
    await tx.query(`UPDATE departments SET cost_center_code = $2, cost_center_source = $3 WHERE id = $1`, [departmentId, code, code === null ? null : 'MANUAL']);
    await audit(tx, ctx, 'department.cost_center_set', 'department', departmentId,
      { from: cur.cost_center_code, fromSource: cur.cost_center_source, to: code, source: code === null ? null : 'MANUAL', knownInErp: erpKnown });
  }
  return { departmentId, name: cur.name, costCenterCode: code, source: code === null ? null : 'MANUAL', sourceLabel: code === null ? null : SOURCE_TR.MANUAL,
    // Bilgi: kod ERP'den okunan masraf merkezleri listesinde var mı (liste boşsa ya da özellik kapalıysa false; engel değildir).
    knownInErp: erpKnown };
}

// ---------- Fatura ERP ödeme durumu (bilgi) ----------

const PAYMENT = ['PAID', 'PARTIAL', 'UNPAID', 'UNKNOWN'] as const;

/** `PUT /invoices/:id/erp-payment-status { status, at }` — bilgi alanı (uygulama ödeme yapmaz; v1 ödeme durumu değişmez); kaynak MANUAL. */
export async function setInvoiceErpPaymentStatus(tx: Tx, ctx: TenantContext, invoiceId: string, body: { status: string | null; at?: string | null }) {
  const inv = (await tx.query<{ invoice_no: string; erp_payment_status: string | null; at: string | null; erp_payment_source: string | null }>(
    `SELECT invoice_no, erp_payment_status, erp_payment_status_at::text AS at, erp_payment_source FROM invoices WHERE id = $1 FOR UPDATE`, [invoiceId])).rows[0];
  if (!inv) throw notFound();
  if ((PROTECTED_DEMO_INVOICES as readonly string[]).includes(inv.invoice_no.trim().toUpperCase())) {
    throw conflict('demo_invoice_protected', 'Demo fatura değiştirilmez.');
  }
  const status = body.status === null ? null : norm(body.status).toUpperCase();
  if (status !== null && !(PAYMENT as readonly string[]).includes(status)) throw unprocessable('invalid_status', 'Ödeme durumu Ödendi, Kısmi, Ödenmedi ya da Bilinmiyor olmalı.');
  const at = status === null ? null : body.at == null || body.at === '' ? null : norm(body.at);
  if (at !== null) {
    const d = new Date(`${at}T00:00:00Z`);
    if (!YMD.test(at) || Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== at) throw unprocessable('invalid_date', 'Tarih YYYY-AA-GG olmalı.');
  }
  const same = status === inv.erp_payment_status && at === inv.at && (status === null || inv.erp_payment_source === 'MANUAL');
  if (!same) {
    await tx.query(`UPDATE invoices SET erp_payment_status = $2, erp_payment_status_at = $3, erp_payment_source = $4 WHERE id = $1`,
      [invoiceId, status, at, status === null ? null : 'MANUAL']);
    await audit(tx, ctx, 'invoice.erp_payment_status', 'invoice', invoiceId,
      { from: inv.erp_payment_status, fromAt: inv.at, fromSource: inv.erp_payment_source, to: status, at, source: status === null ? null : 'MANUAL' });
  }
  return { invoiceId, payment: status ? { status, statusLabel: ERP_PAYMENT_STATUS_TR[status] ?? status, at, source: 'MANUAL', sourceLabel: SOURCE_TR.MANUAL } : null };
}

// ---------- ERP'ye elle iletildi / durum ----------

const isEntityType = (t: unknown): t is EntityType => typeof t === 'string' && (ENTITY_TYPES as readonly string[]).includes(t);

async function assertEntityVisible(tx: Tx, entityType: EntityType, entityId: string) {
  const table = entityType === 'SUPPLIER' ? 'suppliers' : entityType === 'PROJECT' ? 'projects' : 'contract_families';
  if (!(await tx.query(`SELECT 1 FROM ${table} WHERE id = $1`, [entityId])).rowCount) throw notFound();
}

type OutRow = { id: string; feature: WriteFeature; entity_type: string; entity_id: string; status: string; provider_kind: string | null; external_ref: string | null;
  attempts: number; last_error: string | null; manual_by: string | null; manual_by_name: string | null; manual_at: Date | null; manual_note: string | null;
  created_at: Date; updated_at: Date };
const OUT_SQL = `SELECT o.id, o.feature, o.entity_type, o.entity_id, o.status, o.provider_kind, o.external_ref, o.attempts, o.last_error, o.manual_by,
  u.display_name AS manual_by_name, o.manual_at, o.manual_note, o.created_at, o.updated_at FROM erp_outbound_records o LEFT JOIN users u ON u.id = o.manual_by`;

function outView(r: OutRow) {
  const mock = r.provider_kind === 'TAKLIT';
  // Kayıt ERP'de zaten vardı (ör. tedarikçi kodu okumayla geldi): istek atılmadı; "gönderildi" denmez.
  const alreadyInErp = r.status === 'SENT' && (r.last_error ?? '').startsWith(ALREADY_IN_ERP_PREFIX);
  // Kartta doğrulanmamış (elle/taklit/kökeni bilinmeyen) kod: kayıt açık, istek atılmadı; elle iletilebilir.
  const cardCodeUnverified = ['PENDING', 'FAILED', 'UNKNOWN'].includes(r.status) && (r.last_error ?? '').startsWith(CARD_CODE_UNVERIFIED_PREFIX);
  const how = /; (elle girilmiş|taklit sağlayıcıdan \(gerçek değil\)|kaynağı doğrulanamadı);/.exec(r.last_error ?? '')?.[1];
  const base = alreadyInErp ? 'ERP\'de zaten kayıtlı (yeni kayıt yazılmadı)'
    : cardCodeUnverified ? `Kartta ERP kodu var (${how ?? 'kaynağı doğrulanamadı'}; ERP'de doğrulanmadı)` : OUTBOUND_STATUS_TR[r.status] ?? r.status;
  return {
    id: r.id, feature: r.feature, featureLabel: ERP_FEATURE_CATALOG[r.feature].label, entityType: r.entity_type, entityId: r.entity_id,
    status: r.status, statusLabel: mock && r.status !== 'MANUAL' ? `${base} (${MOCK_NOTE})` : base, alreadyInErp, cardCodeUnverified,
    provider: r.provider_kind ? { kind: r.provider_kind, label: PROVIDER_TR[r.provider_kind], real: r.provider_kind === 'ORACLE_EBS' } : null,
    mock, externalRef: r.external_ref, attempts: r.attempts, lastError: r.last_error,
    manual: r.status === 'MANUAL' ? { by: r.manual_by ? { id: r.manual_by, name: r.manual_by_name } : null, at: r.manual_at?.toISOString() ?? null, note: r.manual_note } : null,
    createdAt: r.created_at.toISOString(), updatedAt: r.updated_at.toISOString(),
  };
}

/** `GET /erp/outbound?entityType&entityId` — detay ekranı: kayıtlar (en yeni önce) ve ilgili yazma özelliğinin durumu. */
export async function listOutbound(tx: Tx, ctx: TenantContext, q: { entityType?: unknown; entityId?: unknown }) {
  if (!isEntityType(q.entityType)) throw unprocessable('invalid_entity_type', 'Kayıt türü SUPPLIER, PROJECT ya da CONTRACT_FAMILY olmalı.');
  const entityId = String(q.entityId ?? '');
  await assertEntityVisible(tx, q.entityType, entityId);
  const features = ERP_WRITE_FEATURES.filter((f) => ERP_ENTITY_TYPE[f] === q.entityType);
  const rows = (await tx.query<OutRow>(`${OUT_SQL} WHERE o.entity_type = $1 AND o.entity_id = $2 ORDER BY o.created_at DESC, o.id LIMIT 50`, [q.entityType, entityId])).rows;
  const eps = new Map((await tx.query<{ feature: string; enabled: boolean; write_enabled: boolean; provider_kind: ErpProviderKind }>(`SELECT feature, enabled, write_enabled,
    provider_kind FROM integration_endpoints WHERE feature = ANY($1)`, [features])).rows.map((r) => [r.feature, r]));
  return {
    items: rows.map(outView),
    features: features.map((f) => {
      const ep = eps.get(f);
      const latest = rows.find((r) => r.feature === f) ?? null;
      // Yazma açık olsa da sağlayıcı bu dağıtımda yapılandırılmamışsa (ERP_PROVIDER=none) otomatik yazılmaz; kayıt açılmaz.
      const switchedOn = !!(ep?.enabled && ep.write_enabled);
      const providerReady = ep ? erpProviderReady(ep.provider_kind) : false;
      const writeEnabled = switchedOn && providerReady;
      return { feature: f, label: ERP_FEATURE_CATALOG[f].label, enabled: ep?.enabled ?? false, writeEnabled,
        modeLabel: writeEnabled ? 'ERP\'ye otomatik yazılır' : switchedOn ? 'ERP sağlayıcısı yapılandırılmadı; ERP\'ye yazılmaz, elle iletin' : 'ERP\'ye yazma kapalı; elle iletin',
        manualFallback: ERP_FEATURE_CATALOG[f].manualFallback,
        latest: latest ? outView(latest) : null };
    }),
    // Tedarikçi kaydında kartın ERP kodu ve kökeni (Elle / ERP / ERP (taklit) / ERP (kaynağı doğrulanamadı)).
    supplierCode: q.entityType === 'SUPPLIER' ? await supplierErpCode(tx, ctx, entityId) : null,
    can: { recordManual: can(ctx.roles, 'erp.manual.record') },
  };
}

/**
 * `POST /erp/outbound/manual { feature, entityType, entityId, externalRef, note }` — "ERP'ye elle iletildi" (MANUAL satırı, ERP referans no).
 * Kaydın en son yazma kaydı açıksa (bekliyor/başarısız/belirsiz) o kayıt elle kapatılır (iş artık istek atmaz); gönderilmiş ya da zaten elle
 * iletilmişse 409. Yoksa yeni MANUAL satırı açılır. Sağlayıcı çağrılmaz.
 */
export async function recordManualOutbound(tx: Tx, ctx: TenantContext, body: { feature: string; entityType: string; entityId: string; externalRef: string; note?: string | null }) {
  if (!isWriteFeature(body.feature)) throw unprocessable('feature_not_writable', 'Bu özellik ERP\'ye yazılan bir kayıt değil.');
  const feature = body.feature as WriteFeature;
  if (ERP_ENTITY_TYPE[feature] !== body.entityType) throw unprocessable('entity_type_mismatch', `${ERP_FEATURE_CATALOG[feature as ErpFeature].label} için kayıt türü ${ERP_ENTITY_TYPE[feature]} olmalı.`);
  const entityType = body.entityType as EntityType;
  await assertEntityVisible(tx, entityType, body.entityId);
  const externalRef = norm(body.externalRef);
  if (!externalRef || externalRef.length > 120 || /[\u0000-\u001f]/.test(externalRef)) throw unprocessable('invalid_reference', 'ERP referans no 1–120 karakter olmalı.');
  const note = norm(body.note ?? '') || null;
  if (note && note.length > 1000) throw unprocessable('invalid_note', 'Not en çok 1000 karakter olabilir.');
  // Aynı kayıt için eşzamanlı iki istek (çift tıklama) iki değiştirilemez MANUAL satırı açmasın: son kayıt aranmadan önce kayıt başına kilit.
  await tx.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`erp-manual:${feature}${body.entityId}`]);
  const latest = (await tx.query<{ id: string; status: string }>(`SELECT id, status FROM erp_outbound_records WHERE feature = $1 AND entity_type = $2 AND entity_id = $3
    ORDER BY created_at DESC, id LIMIT 1 FOR UPDATE`, [feature, entityType, body.entityId])).rows[0];
  if (latest && ['SENT', 'CONFIRMED'].includes(latest.status)) {
    throw conflict('already_sent', 'Bu kayıt ERP\'ye zaten gönderildi; elle iletildi kaydı açılmadı.', { outboundId: latest.id });
  }
  if (latest?.status === 'MANUAL') throw conflict('already_recorded', 'Bu kayıt için "ERP\'ye elle iletildi" zaten kayıtlı.', { outboundId: latest.id });
  // İşçi şu an bu kaydı ERP'ye gönderiyorsa elle kapatılmaz (ikisi birden ERP'ye girmesin); bitince yeniden deneyin.
  if (latest) {
    const busy = (await tx.query<{ id: string }>(`SELECT id FROM jobs WHERE kind = $1 AND status = 'RUNNING' AND payload->>'outboundId' = $2
      AND updated_at > now() - make_interval(mins => $3) LIMIT 1`, [ERP_WRITE_JOB, latest.id, ERP_WRITE_LIMITS.inFlightMinutes])).rows[0];
    if (busy) {
      throw conflict('write_in_progress', `Bu kayıt şu an ERP'ye gönderiliyor; sonuç gelince yeniden bakın (bu durum en geç ${ERP_WRITE_LIMITS.inFlightMinutes} dakika içinde kalkar).`,
        { outboundId: latest.id, jobId: busy.id, retryAfterMinutes: ERP_WRITE_LIMITS.inFlightMinutes });
    }
  }
  let id: string;
  let closedPending = false;
  if (latest) {
    // Açık kayıt elle kapanır: sağlayıcı bilgisi temizlenir (elle kayıtta sağlayıcı yok), ERP referansı elle girilen.
    await tx.query(`UPDATE erp_outbound_records SET status = 'MANUAL', provider_kind = NULL, external_ref = $2, manual_by = $3, manual_at = now(), manual_note = $4,
      last_error = NULL, updated_at = now() WHERE id = $1`, [latest.id, externalRef, ctx.userId, note]);
    id = latest.id;
    closedPending = true;
  } else {
    id = (await tx.query<{ id: string }>(`INSERT INTO erp_outbound_records (tenant_id, feature, entity_type, entity_id, idempotency_key, status, external_ref,
      manual_by, manual_at, manual_note, created_by) VALUES ($1,$2,$3,$4,$5,'MANUAL',$6,$7,now(),$8,$7) RETURNING id`,
      [ctx.tenantId, feature, entityType, body.entityId, `manual:${feature}:${body.entityId}:${Date.now()}`, externalRef, ctx.userId, note])).rows[0]!.id;
  }
  await audit(tx, ctx, 'erp.outbound.manual', entityType === 'PROJECT' ? 'project' : entityType === 'CONTRACT_FAMILY' ? 'contract_family' : 'supplier', body.entityId,
    { feature, outboundId: id, externalRef, closedPending, source: 'MANUAL' }, note ?? undefined);
  const row = (await tx.query<OutRow>(`${OUT_SQL} WHERE o.id = $1`, [id])).rows[0]!;
  return outView(row);
}
