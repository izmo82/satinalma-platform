import { isValidIban, normalizeIban, normalizeTaxId, type TaxIdType } from '@sp/domain';
import type { TenantContext, Tx } from '../db.ts';
import { audit } from '../audit.ts';
import { openTask, closeTasks } from '../tasks.ts';
import { ApiError, conflict, notFound, unprocessable } from '../errors.ts';

export interface SellerClaim {
  country: string;
  taxIdType: TaxIdType | null;
  taxId: string | null;
  name: string | null;
  /** HIGH yalnız yapılandırılmış veri (XML) veya insan girişi; OCR/AI çıktısı varsayılan LOW'dur. */
  confidence: 'HIGH' | 'LOW' | 'MISSING';
  source: string;
}

export type ResolveOutcome =
  | 'MATCHED_ACTIVE' | 'MATCHED_RESTRICTED' | 'ATTACHED_TO_CANDIDATE' | 'CANDIDATE_CREATED'
  | 'IDENTITY_REVIEW_REQUIRED' | 'SELLER_IS_OWN_COMPANY' | 'ALREADY_LINKED';

export interface ResolveResult {
  outcome: ResolveOutcome;
  supplierId: string | null;
  nameMismatch: boolean;
  bankChangeRequestId: string | null;
  suggestions: { id: string; legalName: string; status: string }[];
  message: string;
}

const normName = (s: string | null) =>
  (s ?? '').toLocaleUpperCase('tr-TR').replace(/[.,]/g, ' ').replace(/\b(A\s*Ş|LTD|ŞTİ|SAN|TİC|VE)\b/g, ' ').replace(/\s+/g, ' ').trim();

/**
 * Belgedeki satıcıyı kiracı içinde tedarikçiye bağlar (FR05–FR07, T04–T08).
 * Kesin eşleme yalnız ülke+tür+normalize vergi kimliğiyle; isim benzerliği sadece öneri.
 */
export async function resolveSeller(
  tx: Tx, ctx: TenantContext,
  input: { companyId: string; documentVersionId: string; seller: SellerClaim; iban: string | null },
): Promise<ResolveResult> {
  const { seller, companyId, documentVersionId } = input;

  const prior = await tx.query<{ supplier_id: string; name_mismatch: boolean }>(
    `SELECT supplier_id, name_mismatch FROM supplier_document_links WHERE document_version_id = $1 AND party_role = 'SELLER'`,
    [documentVersionId]);
  if (prior.rows[0]) {
    return { outcome: 'ALREADY_LINKED', supplierId: prior.rows[0].supplier_id, nameMismatch: prior.rows[0].name_mismatch,
      bankChangeRequestId: null, suggestions: [], message: 'Belge zaten bir tedarikçiye bağlı.' };
  }

  const norm = seller.taxIdType && seller.taxId ? normalizeTaxId(seller.country, seller.taxIdType, seller.taxId) : null;

  // T05: alıcı şirketin kendi kimliği satıcı olarak eşlenmez.
  if (norm?.ok) {
    const own = await tx.query(`SELECT 1 FROM legal_entities WHERE country = $1 AND tax_id_type = $2 AND tax_id = $3`,
      [norm.country, norm.type, norm.normalized]);
    if (own.rowCount) {
      await openTask(tx, ctx, {
        companyId, kind: 'DOCUMENT_IDENTITY_REVIEW', entityType: 'document_version', entityId: documentVersionId,
        title: 'Satıcı kimliği kendi şirketinizle aynı', reason: 'Satıcı olarak okunan vergi kimliği kiracıdaki bir alıcı şirkete ait.',
        nextAction: 'Satıcı/alıcı alanlarını kaynak belgede kontrol edip düzeltin.', assigneeRole: 'MASTER_DATA',
        severity: 'HIGH', dedupeKey: `doc:${documentVersionId}:own-company-as-seller`,
      });
      await audit(tx, ctx, 'supplier.resolve.own_company_blocked', 'document_version', documentVersionId);
      return { outcome: 'SELLER_IS_OWN_COMPANY', supplierId: null, nameMismatch: false, bankChangeRequestId: null, suggestions: [],
        message: 'Satıcı kimliği kendi şirketinizle aynı. Firma eşlenmedi; kimlik incelemesi açıldı.' };
    }
  }

  // Yalnız öneri: kesin karar için kullanılmaz.
  const token = normName(seller.name).split(' ')[0] ?? '';
  const suggestions = token.length >= 3
    ? (await tx.query<{ id: string; legal_name: string; status: string }>(
        `SELECT id, legal_name, status FROM suppliers WHERE status <> 'MERGED' AND legal_name ILIKE $1 ESCAPE '\\' LIMIT 5`,
        [`%${token.replace(/[\\%_]/g, (c) => '\\' + c)}%`])).rows.map((r) => ({ id: r.id, legalName: r.legal_name, status: r.status }))
    : [];

  // T06: kimlik düşük güvenli/eksik → kesin anahtarsız aday taslağı + kimlik incelemesi.
  if (!norm?.ok || seller.confidence !== 'HIGH') {
    const created = await tx.query<{ id: string }>(
      `INSERT INTO suppliers (tenant_id, country, legal_name, identity_review_required, created_by)
       VALUES ($1, $2, $3, true, $4) RETURNING id`,
      [ctx.tenantId, seller.country, seller.name ?? 'Kimliği belirsiz satıcı', ctx.userId]);
    const supplierId = created.rows[0]!.id;
    await link(tx, ctx, supplierId, companyId, documentVersionId, seller.name, false);
    await openTask(tx, ctx, {
      companyId: null, kind: 'SUPPLIER_IDENTITY_REVIEW', entityType: 'supplier', entityId: supplierId,
      title: 'Tedarikçi kimliği doğrulanmalı',
      reason: norm && !norm.ok ? `Vergi kimliği geçersiz (${norm.reason}).` : !norm ? 'Belgede vergi kimliği bulunamadı.' : 'Vergi kimliği düşük güvenle okundu.',
      nextAction: 'Kaynak belgede vergi kimliğini doğrulayın; benzer isimli kayıtlar yalnız öneridir.',
      assigneeRole: 'MASTER_DATA', dedupeKey: `supplier:${supplierId}:identity`,
    });
    await audit(tx, ctx, 'supplier.candidate.identity_review', 'supplier', supplierId, { documentVersionId, confidence: seller.confidence });
    return { outcome: 'IDENTITY_REVIEW_REQUIRED', supplierId, nameMismatch: false, bankChangeRequestId: null, suggestions,
      message: 'Vergi kimliği kesinleşmedi. Kesin firma kararı verilmedi; kimlik incelemesi açıldı.' };
  }

  // T04: atomik benzersizlik; eşzamanlı iki yükleme tek kayda bağlanır.
  const ins = await tx.query<{ id: string }>(
    `INSERT INTO suppliers (tenant_id, country, tax_id_type, tax_id, legal_name, created_by)
     VALUES ($1,$2,$3,$4,$5,$6)
     ON CONFLICT (tenant_id, country, tax_id_type, tax_id) WHERE tax_id IS NOT NULL DO NOTHING RETURNING id`,
    [ctx.tenantId, norm.country, norm.type, norm.normalized, seller.name ?? norm.normalized, ctx.userId]);
  let supplierId: string;
  let outcome: ResolveOutcome;
  let nameMismatch = false;
  if (ins.rows[0]) {
    supplierId = ins.rows[0].id;
    outcome = 'CANDIDATE_CREATED';
    await openTask(tx, ctx, {
      companyId: null, kind: 'SUPPLIER_CANDIDATE_APPROVAL', entityType: 'supplier', entityId: supplierId,
      title: 'Aday tedarikçi onay bekliyor', reason: 'Belgedeki satıcı kiracıda kayıtlı değil; aday kayıt açıldı.',
      nextAction: 'Kimlik ve kanıtı inceleyip ana veri onayı verin.', assigneeRole: 'MASTER_DATA',
      dedupeKey: `supplier:${supplierId}:activation`,
    });
  } else {
    const ex = await tx.query<{ id: string; status: string; legal_name: string; merged_into_id: string | null }>(
      `SELECT id, status, legal_name, merged_into_id FROM suppliers WHERE country = $1 AND tax_id_type = $2 AND tax_id = $3`,
      [norm.country, norm.type, norm.normalized]);
    const s = ex.rows[0]!;
    supplierId = s.merged_into_id ?? s.id;
    nameMismatch = !!seller.name && normName(seller.name) !== normName(s.legal_name);
    outcome = s.status === 'ACTIVE' || s.status === 'CONDITIONAL' ? 'MATCHED_ACTIVE'
      : s.status === 'CANDIDATE' ? 'ATTACHED_TO_CANDIDATE' : 'MATCHED_RESTRICTED';
    if (nameMismatch) {
      await openTask(tx, ctx, {
        companyId, kind: 'SUPPLIER_NAME_MISMATCH', entityType: 'document_version', entityId: documentVersionId,
        title: 'Ünvan farkı', reason: `Belgedeki ünvan kayıtlı ünvandan farklı (kayıt: ${s.legal_name}).`,
        nextAction: 'Ünvan değişikliği mi, yanlış kimlik mi olduğunu kontrol edin.', assigneeRole: 'MASTER_DATA',
        dedupeKey: `doc:${documentVersionId}:name-mismatch`,
      });
    }
    if (outcome === 'MATCHED_RESTRICTED') {
      await openTask(tx, ctx, {
        companyId, kind: 'SUPPLIER_RESTRICTED_DOCUMENT', entityType: 'document_version', entityId: documentVersionId,
        title: 'Kısıtlı tedarikçiye belge geldi', reason: `Tedarikçi durumu: ${s.status}.`,
        nextAction: 'Yetkili çözüm akışında değerlendirin; yeni taahhüt açılamaz.', assigneeRole: 'MASTER_DATA',
        severity: 'HIGH', dedupeKey: `doc:${documentVersionId}:restricted`,
      });
    }
  }
  await link(tx, ctx, supplierId, companyId, documentVersionId, seller.name, nameMismatch);

  const bankChangeRequestId = input.iban ? await proposeBankChange(tx, ctx, supplierId, input.iban, documentVersionId) : null;

  await audit(tx, ctx, 'supplier.resolve', 'supplier', supplierId, { outcome, documentVersionId, nameMismatch });
  const messages: Record<string, string> = {
    MATCHED_ACTIVE: 'Belge mevcut aktif tedarikçiye bağlandı.',
    ATTACHED_TO_CANDIDATE: 'Bekleyen aday kayda belge eklendi; ana veri onayı bekleniyor.',
    CANDIDATE_CREATED: 'Firma bulunamadı. Aday kaydı oluşturuldu; ana veri onayı bekleniyor.',
    MATCHED_RESTRICTED: 'Tedarikçi kısıtlı durumda; belge yetkili çözüm akışına alındı.',
  };
  return { outcome, supplierId, nameMismatch, bankChangeRequestId, suggestions: [], message: messages[outcome]! };
}

async function link(tx: Tx, ctx: TenantContext, supplierId: string, companyId: string, dvId: string, name: string | null, mismatch: boolean) {
  await tx.query(
    `INSERT INTO supplier_document_links (tenant_id, supplier_id, company_id, document_version_id, party_role, extracted_name, name_mismatch)
     VALUES ($1,$2,$3,$4,'SELLER',$5,$6) ON CONFLICT DO NOTHING`,
    [ctx.tenantId, supplierId, companyId, dvId, name, mismatch]);
}

/** T08: belge kaynaklı IBAN mevcut banka kaydını asla değiştirmez; yalnız doğrulama talebi açar. */
async function proposeBankChange(tx: Tx, ctx: TenantContext, supplierId: string, rawIban: string, dvId: string): Promise<string | null> {
  if (!isValidIban(rawIban)) return null;
  const iban = normalizeIban(rawIban);
  const verified = await tx.query(`SELECT 1 FROM supplier_bank_accounts WHERE supplier_id = $1 AND status = 'VERIFIED' AND iban = $2`,
    [supplierId, iban]);
  if (verified.rowCount) return null;
  const ins = await tx.query<{ id: string }>(
    `INSERT INTO bank_change_requests (tenant_id, supplier_id, proposed_iban, source, source_document_version_id, requested_by)
     VALUES ($1,$2,$3,'DOCUMENT_EXTRACTION',$4,$5) ON CONFLICT DO NOTHING RETURNING id`,
    [ctx.tenantId, supplierId, iban, dvId, ctx.userId]);
  const id = ins.rows[0]?.id ?? (await tx.query<{ id: string }>(
    `SELECT id FROM bank_change_requests WHERE supplier_id = $1 AND proposed_iban = $2 AND status = 'PENDING_VERIFICATION'`,
    [supplierId, iban])).rows[0]!.id;
  await openTask(tx, ctx, {
    companyId: null, kind: 'BANK_CHANGE_VERIFICATION', entityType: 'supplier', entityId: supplierId,
    title: 'Banka bilgisi doğrulanmalı', reason: 'Belgede kayıtlı olmayan bir IBAN okundu. Mevcut banka bilgisi değiştirilmedi.',
    nextAction: 'Kayıtlı güvenilir kanaldan teyit edin; ikinci onay gerekir.', assigneeRole: 'FINANCE', severity: 'HIGH',
    dedupeKey: `bank-change:${id}`,
  });
  await audit(tx, ctx, 'supplier.bank_change.requested', 'supplier', supplierId, { bankChangeRequestId: id, source: 'DOCUMENT_EXTRACTION' });
  return id;
}

// --- Onay ve aktivasyon (BR02/BR03, T07) --------------------------------------

export async function recordApproval(tx: Tx, ctx: TenantContext, supplierId: string,
  body: { kind: 'MASTER_DATA' | 'SECURITY' | 'FINANCE'; decision: 'APPROVED' | 'REJECTED'; rationale: string; expectedRowVersion: number }) {
  const s = await lockSupplier(tx, supplierId, body.expectedRowVersion);
  if (s.created_by === ctx.userId) {
    throw new ApiError(403, 'sod_violation', 'Görev ayrılığı: kaydı açan kişi onay veremez.');
  }
  if (s.status !== 'CANDIDATE') throw conflict('invalid_state', 'Yalnız aday kayıt onaylanabilir.');
  await tx.query(
    `INSERT INTO supplier_approvals (tenant_id, supplier_id, approval_kind, decision, approver_id, supplier_row_version, rationale)
     VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [ctx.tenantId, supplierId, body.kind, body.decision, ctx.userId, s.row_version, body.rationale]);
  if (body.decision === 'REJECTED') {
    await tx.query(`UPDATE suppliers SET status = 'REJECTED', rejection_reason = $2, row_version = row_version + 1 WHERE id = $1`,
      [supplierId, body.rationale]);
    await closeTasks(tx, `supplier:${supplierId}:`);
  }
  await audit(tx, ctx, `supplier.approval.${body.decision.toLowerCase()}`, 'supplier', supplierId, { kind: body.kind }, body.rationale);
}

export async function activateSupplier(tx: Tx, ctx: TenantContext, supplierId: string, expectedRowVersion: number) {
  const s = await lockSupplier(tx, supplierId, expectedRowVersion);
  if (s.created_by === ctx.userId) {
    throw new ApiError(403, 'sod_violation', 'Görev ayrılığı: adayı açan kişi tek başına aktifleştiremez.');
  }
  if (s.status !== 'CANDIDATE') throw conflict('invalid_state', 'Yalnız aday kayıt aktifleştirilebilir.');
  const missing: string[] = [];
  if (!s.tax_id || s.identity_review_required) missing.push('IDENTITY_NOT_VERIFIED');
  const approvals = await tx.query<{ approver_id: string }>(
    `SELECT approver_id FROM supplier_approvals WHERE supplier_id = $1 AND approval_kind = 'MASTER_DATA'
       AND decision = 'APPROVED' AND supplier_row_version = $2`, [supplierId, s.row_version]);
  if (!approvals.rows.some((a) => a.approver_id !== s.created_by)) missing.push('MASTER_DATA_APPROVAL_MISSING');
  if (missing.length) throw unprocessable('activation_requirements_unmet', 'Aktivasyon koşulları tamamlanmadı.', { missing });
  await tx.query(
    `UPDATE suppliers SET status = 'ACTIVE', activated_by = $2, activated_at = now(), row_version = row_version + 1 WHERE id = $1`,
    [supplierId, ctx.userId]);
  await closeTasks(tx, `supplier:${supplierId}:`);
  await audit(tx, ctx, 'supplier.activated', 'supplier', supplierId);
}

/** Kimliği belirsiz adaya doğrulanmış kimlik ata. Kimlik başka kayıtta varsa birleştirir (izi korunur). */
export async function resolveIdentity(tx: Tx, ctx: TenantContext, supplierId: string,
  body: { country: string; taxIdType: TaxIdType; taxId: string; rationale: string; expectedRowVersion: number }) {
  const s = await lockSupplier(tx, supplierId, body.expectedRowVersion);
  if (s.tax_id) throw conflict('identity_already_set', 'Bu kaydın kimliği zaten kesin.');
  const norm = normalizeTaxId(body.country, body.taxIdType, body.taxId);
  if (!norm.ok) throw unprocessable('invalid_tax_id', 'Vergi kimliği geçersiz.', { reason: norm.reason });
  const own = await tx.query(`SELECT 1 FROM legal_entities WHERE country=$1 AND tax_id_type=$2 AND tax_id=$3`, [norm.country, norm.type, norm.normalized]);
  if (own.rowCount) throw unprocessable('own_company_tax_id', 'Bu kimlik kendi şirketinize ait; tedarikçi olarak atanamaz.');
  const existing = await tx.query<{ id: string }>(
    `SELECT id FROM suppliers WHERE country=$1 AND tax_id_type=$2 AND tax_id=$3 FOR UPDATE`, [norm.country, norm.type, norm.normalized]);
  if (existing.rows[0]) {
    const target = existing.rows[0].id;
    await tx.query(
      `INSERT INTO supplier_document_links (tenant_id, supplier_id, company_id, document_version_id, party_role, extracted_name, name_mismatch)
       SELECT tenant_id, $2, company_id, document_version_id, party_role, extracted_name, name_mismatch
       FROM supplier_document_links WHERE supplier_id = $1 ON CONFLICT DO NOTHING`, [supplierId, target]);
    await tx.query(`UPDATE suppliers SET status = 'MERGED', merged_into_id = $2, identity_review_required = false, row_version = row_version + 1 WHERE id = $1`,
      [supplierId, target]);
    await closeTasks(tx, `supplier:${supplierId}:`);
    await audit(tx, ctx, 'supplier.merged', 'supplier', supplierId, { into: target }, body.rationale);
    return { mergedInto: target };
  }
  await tx.query(
    `UPDATE suppliers SET country=$2, tax_id_type=$3, tax_id=$4, identity_review_required=false, row_version=row_version+1 WHERE id=$1`,
    [supplierId, norm.country, norm.type, norm.normalized]);
  await closeTasks(tx, `supplier:${supplierId}:identity`);
  await openTask(tx, ctx, {
    companyId: null, kind: 'SUPPLIER_CANDIDATE_APPROVAL', entityType: 'supplier', entityId: supplierId,
    title: 'Aday tedarikçi onay bekliyor', reason: 'Kimlik doğrulandı; ana veri onayı gerekiyor.',
    nextAction: 'Kanıtı inceleyip ana veri onayı verin.', assigneeRole: 'MASTER_DATA', dedupeKey: `supplier:${supplierId}:activation`,
  });
  await audit(tx, ctx, 'supplier.identity.resolved', 'supplier', supplierId, {}, body.rationale);
  return { mergedInto: null };
}

async function lockSupplier(tx: Tx, id: string, expectedRowVersion: number) {
  const r = await tx.query<{ id: string; status: string; created_by: string | null; row_version: number; tax_id: string | null; identity_review_required: boolean }>(
    `SELECT id, status, created_by, row_version, tax_id, identity_review_required FROM suppliers WHERE id = $1 FOR UPDATE`, [id]);
  const s = r.rows[0];
  if (!s) throw notFound();
  if (s.row_version !== expectedRowVersion) {
    throw conflict('version_conflict', 'Kayıt siz incelerken değişti. Güncel bilgileri gözden geçirin.', { currentRowVersion: s.row_version });
  }
  return s;
}
