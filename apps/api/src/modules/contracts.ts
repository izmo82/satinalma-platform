import { deriveSignatureStatus, type RequirementMethod, type SignatureMethod, type SignatureStatus } from '@sp/domain';
import type { TenantContext, Tx } from '../db.ts';
import type { ObjectStore } from '../storage.ts';
import { audit } from '../audit.ts';
import { nextCode } from '../codes.ts';
import { closeTasks, openTask } from '../tasks.ts';
import { ApiError, conflict, notFound, unprocessable } from '../errors.ts';
import { selectDetector } from '../signature/detector.ts';
import { resolveDepartment } from './departments.ts';
import { cancelOpenChain, CONTENT_CHANGED_REASON, familyWritable, lockFamily } from './contractChain.ts';

interface CvRow {
  id: string; company_id: string; family_id: string; version_no: number; document_version_id: string; stage: string;
  signature_method: SignatureMethod; original_custody_required: boolean; superseded_by_id: string | null;
  signature_finalized_at: Date | null; signature_finalized_status: string | null; row_version: number; sha256: string;
  page_count: number | null; title: string; department_id: string | null; department_name: string | null; created_by: string;
}

export const etagOf = (cv: { id: string; row_version: number }) => `"cv-${cv.id}-${cv.row_version}"`;

async function loadCv(tx: Tx, id: string, lock = false): Promise<CvRow> {
  const r = await tx.query<CvRow>(
    `SELECT cv.*, dv.sha256, dv.page_count, f.title, f.department_id, (SELECT d.name FROM departments d WHERE d.id = f.department_id) AS department_name FROM contract_versions cv
     JOIN document_versions dv ON dv.id = cv.document_version_id
     JOIN contract_families f ON f.id = cv.family_id
     WHERE cv.id = $1 ${lock ? 'FOR UPDATE OF cv' : ''}`, [id]);
  if (!r.rows[0]) throw notFound();
  return r.rows[0];
}

/** Sürüm kilidi: eski ETag veya yerine geçmiş sürüm üzerinde karar verilemez (T32). */
function assertCurrent(cv: CvRow, ifMatch: string | undefined) {
  if (cv.superseded_by_id) {
    throw conflict('version_superseded', 'Bu sözleşme sürümünün yerine yeni sürüm geldi. Güncel sürümü inceleyin.',
      { currentContractVersionId: cv.superseded_by_id });
  }
  if (!ifMatch) throw new ApiError(428, 'precondition_required', 'If-Match başlığı gerekli.');
  if (ifMatch !== etagOf(cv)) {
    throw conflict('version_conflict', 'Onaylamak istediğiniz sürüm değişti. Yeni değerleri gözden geçirin.', { currentEtag: etagOf(cv) });
  }
}

export interface PartyInput { role: 'BUYER' | 'SUPPLIER' | 'OTHER'; displayName: string; legalEntityId?: string | null; supplierId?: string | null }

export async function createContract(tx: Tx, ctx: TenantContext, body: {
  title: string; documentVersionId: string; supplierId?: string | null; stage: 'DRAFT' | 'EXECUTION' | 'ARCHIVE_IMPORT';
  signatureMethod: SignatureMethod; originalCustodyRequired: boolean; effectiveDate?: string | null; parties: PartyInput[];
  /** v2 (D93): bölüm kullanıcısı için zorunlu (kendi departmanı); tüm departmanı görenler için isteğe bağlı. */
  departmentId?: string | null;
  /** v2 Faz 3 (D108+): ekleme akışı (POST /contract-drafts) taslağı: proje, şablon sürümü ve tür aileye yazılır. (Eski kayıt ayrımı 051a varsayılanıyla.) */
  intake?: { projectId: string; templateVersionId: string | null; contractType: string | null };
}) {
  const dv = await tx.query<{ company_id: string; basic_check_status: string }>(
    `SELECT dv.company_id, dv.basic_check_status FROM document_versions dv JOIN documents d ON d.id = dv.document_id
     WHERE dv.id = $1 AND d.kind = 'CONTRACT'`, [body.documentVersionId]);
  const doc = dv.rows[0];
  if (!doc) throw notFound();
  if (doc.basic_check_status !== 'PASSED') throw unprocessable('document_quarantined', 'Karantinadaki belgeyle sözleşme oluşturulamaz.');
  const departmentId = await resolveDepartment(tx, ctx, body.departmentId);
  const fam = await tx.query<{ id: string }>(
    `INSERT INTO contract_families (tenant_id, company_id, title, supplier_id, created_by, code, department_id, project_id, template_version_id, contract_type)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`,
    [ctx.tenantId, doc.company_id, body.title, body.supplierId ?? null, ctx.userId, await nextCode(tx, ctx, 'contract', 'SZL'), departmentId,
      body.intake?.projectId ?? null, body.intake?.templateVersionId ?? null, body.intake?.contractType ?? null]);
  const cv = await tx.query<{ id: string }>(
    `INSERT INTO contract_versions (tenant_id, company_id, family_id, version_no, document_version_id, stage, signature_method,
       original_custody_required, effective_date, created_by)
     VALUES ($1,$2,$3,1,$4,$5,$6,$7,$8,$9) RETURNING id`,
    [ctx.tenantId, doc.company_id, fam.rows[0]!.id, body.documentVersionId, body.stage, body.signatureMethod,
      body.originalCustodyRequired, body.effectiveDate ?? null, ctx.userId]);
  const cvId = cv.rows[0]!.id;
  for (const p of body.parties) {
    await tx.query(
      `INSERT INTO contract_parties (tenant_id, company_id, contract_version_id, party_role, legal_entity_id, supplier_id, display_name)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [ctx.tenantId, doc.company_id, cvId, p.role, p.legalEntityId ?? null, p.supplierId ?? null, p.displayName]);
  }
  await audit(tx, ctx, 'contract.created', 'contract_version', cvId, { familyId: fam.rows[0]!.id, stage: body.stage, method: body.signatureMethod, departmentId });
  return { familyId: fam.rows[0]!.id, contractVersionId: cvId };
}

/**
 * Yeni belge sürümü/zeyilname: önceki sürüm "yerine geçildi" olur, delilleri korunur.
 * Taraf ve gereksinim tanımları yeni sürüme kopyalanır ama inceleme kararları taşınmaz (SIG09, T31).
 */
export async function addContractVersion(tx: Tx, ctx: TenantContext, prevId: string, ifMatch: string | undefined, body: {
  documentVersionId: string; kind: 'MAIN' | 'AMENDMENT' | 'ANNEX' | 'SOW'; stage: 'DRAFT' | 'EXECUTION' | 'ARCHIVE_IMPORT'; addSupplierId?: string;
}) {
  // v2 Faz 3 (Görev 5 inceleme I1): onay kararlarıyla aynı aile kilidi. Kilit satır kilidinden (FOR UPDATE) ÖNCE alınır: ekleme akışı
  // aile kilidini tutarken koşul yazar (sürüm satırına FK kilidi); ters sıra kilitlenme yaratırdı.
  const fam = (await tx.query<{ family_id: string }>(`SELECT family_id FROM contract_versions WHERE id = $1`, [prevId])).rows[0];
  if (!fam) throw notFound();
  await lockFamily(tx, fam.family_id);
  const prev = await loadCv(tx, prevId, true);
  // v2 Faz 3 (R6): başka departmandan onaycı sözleşmeyi görür ama sürüm ekleyemez (RLS hatası yerine 403).
  if (!familyWritable(ctx, prev.department_id)) throw new ApiError(403, 'department_forbidden', 'Bu sözleşmeyi görebilirsiniz ama düzenleyemezsiniz.');
  assertCurrent(prev, ifMatch);
  const dv = await tx.query<{ sha256: string }>(`SELECT sha256 FROM document_versions WHERE id = $1 AND company_id = $2`,
    [body.documentVersionId, prev.company_id]);
  if (!dv.rows[0]) throw notFound();
  if (dv.rows[0].sha256 === prev.sha256) {
    throw conflict('same_document', 'Bu dosya mevcut sürümle aynı (aynı hash). Yeni sürüm oluşturulmadı.');
  }
  const cv = await tx.query<{ id: string }>(
    `INSERT INTO contract_versions (tenant_id, company_id, family_id, version_no, kind, document_version_id, stage, signature_method,
       original_custody_required, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`,
    [ctx.tenantId, prev.company_id, prev.family_id, prev.version_no + 1, body.kind, body.documentVersionId, body.stage,
      prev.signature_method, prev.original_custody_required, ctx.userId]);
  const newId = cv.rows[0]!.id;
  const parties = await tx.query<{ id: string; party_role: string; legal_entity_id: string | null; supplier_id: string | null; display_name: string }>(
    `SELECT * FROM contract_parties WHERE contract_version_id = $1`, [prevId]);
  const partyMap = new Map<string, string>();
  for (const p of parties.rows) {
    const np = await tx.query<{ id: string }>(
      `INSERT INTO contract_parties (tenant_id, company_id, contract_version_id, party_role, legal_entity_id, supplier_id, display_name)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
      [ctx.tenantId, prev.company_id, newId, p.party_role, p.legal_entity_id, p.supplier_id, p.display_name]);
    partyMap.set(p.id, np.rows[0]!.id);
  }
  await tx.query(
    `INSERT INTO signature_requirements (tenant_id, company_id, contract_version_id, document_version_id, party_id, signer_role,
       requirement_count, acceptable_methods, required, attachment_scope, policy_version, created_by)
     SELECT tenant_id, company_id, $2, $3, (($4::jsonb) ->> party_id::text)::uuid, signer_role, requirement_count, acceptable_methods,
       required, attachment_scope, policy_version, $5
     FROM signature_requirements WHERE contract_version_id = $1 AND retired_at IS NULL`,
    [prevId, newId, body.documentVersionId, JSON.stringify(Object.fromEntries(partyMap)), ctx.userId]);
  // Taraf değişimi yeniden onay gerektirir (BR05): yalnız zeyilnameyle, yeni sürüm ve imza incelemesiyle eklenir (D91).
  if (body.addSupplierId) {
    if (body.kind !== 'AMENDMENT') throw unprocessable('party_change_requires_amendment', 'Yeni tedarikçi tarafı yalnız zeyilnameyle eklenir.');
    const sup = (await tx.query<{ legal_name: string; status: string }>(`SELECT legal_name, status FROM suppliers WHERE id = $1`, [body.addSupplierId])).rows[0];
    if (!sup) throw notFound();
    if (sup.status !== 'ACTIVE') throw unprocessable('supplier_not_active', `${sup.legal_name} aktif tedarikçi değil; sözleşme tarafı olarak eklenemez.`);
    if (parties.rows.some((p) => p.party_role === 'SUPPLIER' && p.supplier_id === body.addSupplierId)) throw conflict('party_exists', `${sup.legal_name} bu sözleşmede zaten tedarikçi tarafı.`);
    const party = await tx.query<{ id: string }>(`INSERT INTO contract_parties (tenant_id, company_id, contract_version_id, party_role, supplier_id, display_name) VALUES ($1,$2,$3,'SUPPLIER',$4,$5) RETURNING id`,
      [ctx.tenantId, prev.company_id, newId, body.addSupplierId, sup.legal_name]);
    // Durum yalnız gereksinimlerden türetilir: gereksinimsiz taraf imzalamadan sürüm kesinleşebilirdi.
    if (prev.signature_method !== 'NOT_REQUIRED') {
      const single = ['WET_IMAGE_REVIEW', 'QUALIFIED_ELECTRONIC', 'ELECTRONIC_OTHER'].includes(prev.signature_method);
      await tx.query(`INSERT INTO signature_requirements (tenant_id, company_id, contract_version_id, document_version_id, party_id, signer_role, requirement_count, acceptable_methods, required, policy_version, created_by)
        VALUES ($1,$2,$3,$4,$5,'Yetkili imzacı',1,$6,true,'zeyilname-taraf-1',$7)`,
        [ctx.tenantId, prev.company_id, newId, body.documentVersionId, party.rows[0]!.id, single ? [prev.signature_method] : ['WET_IMAGE_REVIEW', 'QUALIFIED_ELECTRONIC', 'ELECTRONIC_OTHER'], ctx.userId]);
    }
    await audit(tx, ctx, 'contract.supplier_party.added', 'contract_version', newId, { supplierId: body.addSupplierId, previous: prevId });
  }
  await tx.query(`UPDATE contract_versions SET superseded_by_id = $2, row_version = row_version + 1 WHERE id = $1`, [prevId, newId]);
  await closeTasks(tx, `sig:${prevId}:`);
  await audit(tx, ctx, 'contract.version.added', 'contract_version', newId, { previous: prevId, kind: body.kind });
  await openReviewTask(tx, ctx, newId, prev.company_id, prev.title);
  // v2 Faz 3 (R5): gönderimden sonra yeni belge sürümü gelirse açık onay zinciri iptal edilir; ekleyene yeniden gönderim görevi.
  const cancelledChainId = await cancelOpenChain(tx, ctx, prev.family_id, CONTENT_CHANGED_REASON);
  return { contractVersionId: newId, cancelledChainId };
}

export async function updateSignaturePolicy(tx: Tx, ctx: TenantContext, cvId: string, ifMatch: string | undefined,
  body: { signatureMethod: SignatureMethod; originalCustodyRequired: boolean; stage?: 'DRAFT' | 'EXECUTION' | 'ARCHIVE_IMPORT' }) {
  const cv = await loadCv(tx, cvId, true);
  assertCurrent(cv, ifMatch);
  if (cv.signature_finalized_at) throw conflict('already_finalized', 'İmza kontrolü kesinleşmiş sürümde politika değişmez; yeni sürüm açın.');
  await tx.query(
    `UPDATE contract_versions SET signature_method = $2, original_custody_required = $3, stage = coalesce($4, stage), row_version = row_version + 1 WHERE id = $1`,
    [cvId, body.signatureMethod, body.originalCustodyRequired, body.stage ?? null]);
  await audit(tx, ctx, 'signature.policy.updated', 'contract_version', cvId, body);
}

export async function defineRequirement(tx: Tx, ctx: TenantContext, cvId: string, ifMatch: string | undefined, body: {
  partyId: string; signerRole: string; requirementCount: number; acceptableMethods: RequirementMethod[]; required: boolean;
  page?: number | null; policyVersion: string;
}) {
  const cv = await loadCv(tx, cvId, true);
  assertCurrent(cv, ifMatch);
  if (cv.signature_finalized_at) throw conflict('already_finalized', 'İmza kontrolü kesinleşmiş sürümde gereksinim değişmez.');
  const party = await tx.query(`SELECT 1 FROM contract_parties WHERE id = $1 AND contract_version_id = $2`, [body.partyId, cvId]);
  if (!party.rowCount) throw unprocessable('party_not_in_version', 'Taraf bu sözleşme sürümüne ait değil.');
  const r = await tx.query<{ id: string }>(
    `INSERT INTO signature_requirements (tenant_id, company_id, contract_version_id, document_version_id, party_id, signer_role,
       requirement_count, acceptable_methods, required, page, policy_version, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING id`,
    [ctx.tenantId, cv.company_id, cvId, cv.document_version_id, body.partyId, body.signerRole, body.requirementCount,
      body.acceptableMethods, body.required, body.page ?? null, body.policyVersion, ctx.userId]);
  // Kural değişti → sonuç yeniden hesaplanır; eski ETag ile karar verilemez.
  await tx.query(`UPDATE contract_versions SET row_version = row_version + 1 WHERE id = $1`, [cvId]);
  await audit(tx, ctx, 'signature.requirement.defined', 'contract_version', cvId, { requirementId: r.rows[0]!.id, methods: body.acceptableMethods });
  await openReviewTask(tx, ctx, cvId, cv.company_id, cv.title);
  return { requirementId: r.rows[0]!.id };
}

async function openReviewTask(tx: Tx, ctx: TenantContext, cvId: string, companyId: string, title: string) {
  await openTask(tx, ctx, {
    companyId, kind: 'SIGNATURE_REVIEW', entityType: 'contract_version', entityId: cvId,
    title: `İmza incelemesi: ${title}`, reason: 'Bu sözleşme sürümünün imza gereksinimleri insan incelemesi bekliyor.',
    nextAction: 'Taraf bazında imza kanıtını (görüntü veya e-imza doğrulaması) kontrol edin.', assigneeRole: 'LEGAL', dedupeKey: `sig:${cvId}:review`,
  });
}

// --- Durum --------------------------------------------------------------------

export async function getSignatureStatus(tx: Tx, ctx: TenantContext, cvId: string) {
  const cv = await loadCv(tx, cvId);
  const reqs = await tx.query<{ id: string; party_id: string; display_name: string; party_role: string; signer_role: string; requirement_count: number;
    acceptable_methods: RequirementMethod[]; required: boolean; page: number | null; policy_version: string }>(
    `SELECT r.*, p.display_name, p.party_role FROM signature_requirements r JOIN contract_parties p ON p.id = r.party_id
     WHERE r.contract_version_id = $1 AND r.retired_at IS NULL ORDER BY p.party_role, r.created_at`, [cvId]);
  const reviews = await tx.query<{ id: string; requirement_id: string; slot: number; decision: any; observed_mark: any; document_sha256: string;
    reviewed_at: Date; rationale: string; reviewer_id: string; reviewer_name: string; page: number | null; detection_id: string | null }>(
    `SELECT sr.*, u.display_name AS reviewer_name FROM signature_reviews sr
     JOIN signature_requirements r ON r.id = sr.requirement_id JOIN users u ON u.id = sr.reviewer_id
     WHERE r.contract_version_id = $1 ORDER BY sr.reviewed_at`, [cvId]);
  const validations = await tx.query<{ id: string; requirement_id: string | null; signed_file_sha256: string; status: any; validated_at: Date;
    validator: string; blocked_reason: string | null; report_reference: string | null }>(
    `SELECT * FROM digital_validations WHERE contract_version_id = $1 ORDER BY validated_at`, [cvId]);
  const exceptions = await tx.query<{ id: string; requirement_ids: string[]; status: any; expires_at: Date; reason: string; residual_risk: string;
    scope: string; requested_by: string; decided_by: string | null; decided_at: Date | null }>(
    `SELECT * FROM signature_exceptions WHERE contract_version_id = $1 ORDER BY created_at`, [cvId]);
  const custody = await tx.query<{ status: 'RECEIPT_DECLARED' | 'CUSTODY_CONFIRMED'; location: string; occurred_at: Date; recorded_at: Date }>(
    `SELECT status, location, occurred_at, recorded_at FROM original_custody_events WHERE contract_version_id = $1 ORDER BY recorded_at`, [cvId]);
  const runs = await tx.query<{ id: string; status: any; provider: string; model_version: string; processed_pages: number[]; total_pages: number | null;
    error_code: string | null; created_at: Date; document_sha256: string }>(
    `SELECT * FROM signature_detection_runs WHERE contract_version_id = $1 ORDER BY created_at DESC`, [cvId]);
  const detections = await tx.query<{ id: string; run_id: string; page: number; bbox: unknown; raw_confidence: string | null; detection_status: string }>(
    `SELECT d.id, d.run_id, d.page, d.bbox, d.raw_confidence, d.detection_status FROM signature_detections d
     JOIN signature_detection_runs r ON r.id = d.run_id WHERE r.contract_version_id = $1 AND d.document_sha256 = $2 ORDER BY d.page`,
    [cvId, cv.sha256]);

  const latestRun = runs.rows.find((r) => r.document_sha256 === cv.sha256);
  const status: SignatureStatus = deriveSignatureStatus({
    method: cv.signature_method,
    documentSha256: cv.sha256,
    requirements: reqs.rows.map((r) => ({ id: r.id, partyId: r.party_id, partyName: r.display_name, signerRole: r.signer_role,
      requirementCount: r.requirement_count, acceptableMethods: r.acceptable_methods, required: r.required })),
    reviews: reviews.rows.map((r) => ({ requirementId: r.requirement_id, slot: r.slot, decision: r.decision, observedMark: r.observed_mark,
      documentSha256: r.document_sha256, reviewedAt: r.reviewed_at })),
    validations: validations.rows.map((v) => ({ requirementId: v.requirement_id, signedFileSha256: v.signed_file_sha256, status: v.status, validatedAt: v.validated_at })),
    exceptions: exceptions.rows.map((x) => ({ id: x.id, requirementIds: x.requirement_ids, status: x.status, expiresAt: x.expires_at })),
    custodyRequired: cv.original_custody_required,
    custodyStatuses: custody.rows.map((c) => c.status),
    latestDetection: latestRun?.status ?? 'NOT_PROCESSED',
    now: new Date(),
  });

  return {
    contractVersion: {
      id: cv.id, companyId: cv.company_id, familyId: cv.family_id, title: cv.title, versionNo: cv.version_no, stage: cv.stage, signatureMethod: cv.signature_method,
      originalCustodyRequired: cv.original_custody_required, documentVersionId: cv.document_version_id, documentSha256: cv.sha256,
      pageCount: cv.page_count, supersededById: cv.superseded_by_id, finalizedAt: cv.signature_finalized_at,
      finalizedStatus: cv.signature_finalized_status, etag: etagOf(cv), departmentId: cv.department_id, departmentName: cv.department_name,
      createdBy: cv.created_by,
    },
    status,
    requirements: reqs.rows.map((r) => ({ id: r.id, partyId: r.party_id, partyName: r.display_name, partyRole: r.party_role, signerRole: r.signer_role,
      requirementCount: r.requirement_count, acceptableMethods: r.acceptable_methods, required: r.required, page: r.page, policyVersion: r.policy_version })),
    reviews: reviews.rows.map((r) => ({ id: r.id, requirementId: r.requirement_id, slot: r.slot, decision: r.decision, observedMark: r.observed_mark,
      rationale: r.rationale, reviewerName: r.reviewer_name, reviewedAt: r.reviewed_at, page: r.page, detectionId: r.detection_id,
      appliesToCurrentDocument: r.document_sha256 === cv.sha256 })),
    detectionRuns: runs.rows.map((r) => ({ id: r.id, status: r.status, provider: r.provider, modelVersion: r.model_version,
      processedPages: r.processed_pages, totalPages: r.total_pages, errorCode: r.error_code, createdAt: r.created_at,
      appliesToCurrentDocument: r.document_sha256 === cv.sha256 })),
    detections: detections.rows.map((d) => ({ id: d.id, runId: d.run_id, page: d.page, bbox: d.bbox, rawConfidence: d.raw_confidence, status: d.detection_status })),
    validations: validations.rows.map((v) => ({ id: v.id, requirementId: v.requirement_id, status: v.status, validator: v.validator,
      blockedReason: v.blocked_reason, reportReference: v.report_reference, validatedAt: v.validated_at })),
    exceptions: exceptions.rows.map((x) => ({ id: x.id, requirementIds: x.requirement_ids, status: x.status, expiresAt: x.expires_at,
      reason: x.reason, residualRisk: x.residual_risk, scope: x.scope, decidedAt: x.decided_at,
      expired: x.status === 'APPROVED' && x.expires_at <= new Date() })),
    custodyEvents: custody.rows,
  };
}

/** İstisna süresi dolunca kesinleşme geri alınır ve görev yeniden açılır (T36). Worker ve okuma yolunda çağrılır. */
export async function reconcileExpiredExceptions(tx: Tx, ctx: TenantContext, cvId: string) {
  const s = await getSignatureStatus(tx, ctx, cvId);
  if (s.status.expiredExceptionIds.length === 0) return s;
  // v2 Faz 3 (R6): başka departmandan onaycı okurken görev/sürüm yazılamaz (RLS); uzlaştırma yazabilen kullanıcının okumasında yapılır.
  if (!familyWritable(ctx, s.contractVersion.departmentId ?? null)) return s;
  for (const id of s.status.expiredExceptionIds) {
    const t = await openTask(tx, ctx, {
      companyId: s.contractVersion.companyId, kind: 'SIGNATURE_EXCEPTION_EXPIRED', entityType: 'contract_version', entityId: cvId,
      title: `İmza istisnasının süresi doldu: ${s.contractVersion.title}`, reason: 'Yetkili istisnanın bitiş tarihi geçti; eksik imza durumu yeniden açıldı.',
      nextAction: 'Eksik imzalı belgeyi tamamlatın veya yeni istisna talep edin.', assigneeRole: 'LEGAL', severity: 'HIGH',
      dedupeKey: `sig:${cvId}:exception-expired:${id}`,
    });
    if (t.created) await audit(tx, ctx, 'signature.exception.expired', 'contract_version', cvId, { exceptionId: id });
  }
  if (s.contractVersion.finalizedStatus === 'EXCEPTION_ACTIVE' && s.status.overall !== 'EXCEPTION_ACTIVE') {
    await tx.query(`UPDATE contract_versions SET signature_finalized_at = NULL, signature_finalized_by = NULL,
      signature_finalized_status = NULL, row_version = row_version + 1 WHERE id = $1`, [cvId]);
    await audit(tx, ctx, 'signature.finalization.reopened', 'contract_version', cvId, { reason: 'exception_expired' });
    return getSignatureStatus(tx, ctx, cvId);
  }
  return s;
}

// --- Görsel tespit işi ----------------------------------------------------------

export const POLICY_VERSION = 'sig-policy-v1';

export async function requestSignatureAnalysis(tx: Tx, ctx: TenantContext, cvId: string, configuredProvider: string | null) {
  const cv = await loadCv(tx, cvId);
  if (cv.superseded_by_id) throw conflict('version_superseded', 'Yerine geçilmiş sürüm analiz edilmez.', { currentContractVersionId: cv.superseded_by_id });
  const tenant = await tx.query<{ data_region: string }>(`SELECT data_region FROM tenants`);
  const sel = selectDetector(configuredProvider, tenant.rows[0]!.data_region);
  const provider = sel.ok ? sel.detector.capability.provider : sel.provider;
  const modelVersion = sel.ok ? sel.detector.capability.modelVersion : sel.modelVersion;
  const idem = `${cv.sha256}:${provider}:${modelVersion}:${POLICY_VERSION}`;

  const job = await tx.query<{ id: string; status: string }>(
    `INSERT INTO jobs (tenant_id, company_id, kind, idempotency_key, payload, requested_by, status, error_code)
     VALUES ($1,$2,'signature.detect',$3,$4,$5,$6,$7)
     ON CONFLICT (tenant_id, kind, idempotency_key) DO NOTHING RETURNING id, status`,
    [ctx.tenantId, cv.company_id, idem, { contractVersionId: cvId }, ctx.userId,
      sel.ok ? 'QUEUED' : 'BLOCKED', sel.ok ? null : sel.reason]);
  if (!job.rows[0]) {
    // T30: aynı hash/sağlayıcı/politika → mevcut iş ve sonuç döner, yeni görev yok.
    const ex = await tx.query<{ id: string; status: string; error_code: string | null }>(
      `SELECT id, status, error_code FROM jobs WHERE kind = 'signature.detect' AND idempotency_key = $1`, [idem]);
    return { jobId: ex.rows[0]!.id, status: ex.rows[0]!.status, errorCode: ex.rows[0]!.error_code, reused: true };
  }
  const jobId = job.rows[0].id;
  if (!sel.ok) {
    await tx.query(
      `INSERT INTO signature_detection_runs (tenant_id, company_id, contract_version_id, document_version_id, document_sha256, provider,
         model_version, policy_version, status, error_code, job_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'UNSUPPORTED',$9,$10)`,
      [ctx.tenantId, cv.company_id, cvId, cv.document_version_id, cv.sha256, provider, modelVersion, POLICY_VERSION, sel.reason, jobId]);
    await openTask(tx, ctx, {
      companyId: cv.company_id, kind: 'SIGNATURE_AUTO_CHECK_UNAVAILABLE', entityType: 'contract_version', entityId: cvId,
      title: `Otomatik imza kontrolü yapılamadı: ${cv.title}`,
      reason: sel.reason === 'REGION_NOT_ALLOWED' ? 'İzinli veri bölgesinde imza tespit servisi yok.' : 'İmza tespit servisi yapılandırılmadı.',
      nextAction: 'Taraf bazında imzaları kaynak sayfada manuel inceleyin.', assigneeRole: 'LEGAL', dedupeKey: `sig:${cvId}:auto-unavailable`,
    });
  }
  await audit(tx, ctx, 'signature.analysis.requested', 'contract_version', cvId, { jobId, provider, blocked: !sel.ok });
  return { jobId, status: sel.ok ? 'QUEUED' : 'BLOCKED', errorCode: sel.ok ? null : sel.reason, reused: false };
}

/** Worker: kuyruktan alınan tespit işini kiracı bağlamında işler. */
export async function processSignatureJob(tx: Tx, ctx: TenantContext, store: ObjectStore, jobId: string, configuredProvider: string | null) {
  const j = await tx.query<{ payload: { contractVersionId: string } }>(`SELECT payload FROM jobs WHERE id = $1`, [jobId]);
  if (!j.rows[0]) throw notFound();
  const cvId = j.rows[0].payload.contractVersionId;
  const cv = await loadCv(tx, cvId);
  const tenant = await tx.query<{ data_region: string }>(`SELECT data_region FROM tenants`);
  const sel = selectDetector(configuredProvider, tenant.rows[0]!.data_region);
  const dv = await tx.query<{ storage_key: string; mime_type: string; page_count: number | null }>(
    `SELECT storage_key, mime_type, page_count FROM document_versions dv WHERE id = $1
       AND NOT EXISTS (SELECT 1 FROM document_disposals x WHERE x.document_id = dv.document_id)`, [cv.document_version_id]);
  if (!dv.rows[0]) {
    await tx.query(`UPDATE jobs SET status = 'BLOCKED', error_code = 'DOCUMENT_DISPOSED', updated_at = now() WHERE id = $1`, [jobId]);
    return;
  }
  if (!sel.ok) {
    await tx.query(`UPDATE jobs SET status = 'BLOCKED', error_code = $2, updated_at = now() WHERE id = $1`, [jobId, sel.reason]);
    return;
  }
  const bytes = await store.get(dv.rows[0]!.storage_key);
  const out = await sel.detector.detect({ bytes, mimeType: dv.rows[0]!.mime_type, pageCount: dv.rows[0]!.page_count });
  const run = await tx.query<{ id: string }>(
    `INSERT INTO signature_detection_runs (tenant_id, company_id, contract_version_id, document_version_id, document_sha256, provider,
       model_version, policy_version, status, processed_pages, total_pages, error_code, job_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
     ON CONFLICT (tenant_id, contract_version_id, document_sha256, provider, model_version, policy_version) DO NOTHING RETURNING id`,
    [ctx.tenantId, cv.company_id, cvId, cv.document_version_id, cv.sha256, sel.detector.capability.provider,
      sel.detector.capability.modelVersion, POLICY_VERSION, out.status, out.processedPages, out.totalPages,
      out.status === 'ERROR' ? out.errorCode : null, jobId]);
  if (run.rows[0]) {
    for (const c of out.candidates) {
      await tx.query(
        `INSERT INTO signature_detections (tenant_id, company_id, run_id, document_version_id, document_sha256, page, bbox, raw_confidence, detection_status)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [ctx.tenantId, cv.company_id, run.rows[0].id, cv.document_version_id, cv.sha256, c.page, c.bbox, c.rawConfidence, c.status]);
    }
  }
  // Kapsam eksikse (tüm sayfalar işlenmediyse) temiz sonuç sayılmaz.
  const partial = out.totalPages != null && out.processedPages.length < out.totalPages && out.status === 'NOT_DETECTED';
  if (out.status === 'NOT_DETECTED' || out.status === 'UNCLEAR' || partial) {
    await openTask(tx, ctx, {
      companyId: cv.company_id, kind: 'SIGNATURE_IMAGE_NOT_FOUND', entityType: 'contract_version', entityId: cvId,
      title: `İmza görüntüsü bulunamadı — inceleme gerekli: ${cv.title}`,
      reason: out.status === 'UNCLEAR' ? 'Algılayıcı sonucu belirsiz.' : partial ? 'Tüm sayfalar işlenemedi.' : 'Algılayıcı imza görüntüsü bulamadı. Bu, belgenin imzasız olduğu anlamına gelmez.',
      nextAction: 'Kaynak sayfaları inceleyip taraf bazında karar verin.', assigneeRole: 'LEGAL', severity: 'HIGH',
      dedupeKey: `sig:${cvId}:not-detected`,
    });
  } else if (out.status === 'ERROR') {
    await openTask(tx, ctx, {
      companyId: cv.company_id, kind: 'SIGNATURE_AUTO_CHECK_UNAVAILABLE', entityType: 'contract_version', entityId: cvId,
      title: `Otomatik imza kontrolü yapılamadı: ${cv.title}`, reason: 'Algılayıcı hata verdi.',
      nextAction: 'Taraf bazında imzaları manuel inceleyin.', assigneeRole: 'LEGAL', dedupeKey: `sig:${cvId}:auto-unavailable`,
    });
  }
  await tx.query(`UPDATE jobs SET status = 'SUCCEEDED', result = $2, updated_at = now() WHERE id = $1`, [jobId, { status: out.status }]);
  await audit(tx, ctx, 'signature.analysis.completed', 'contract_version', cvId, { jobId, status: out.status, pages: out.processedPages.length });
}

// --- İnsan incelemesi, asıl, e-imza, istisna, kesinleştirme --------------------

export async function submitReview(tx: Tx, ctx: TenantContext, cvId: string, ifMatch: string | undefined, body: {
  requirementId: string; slot: number; decision: 'IMAGE_CONFIRMED' | 'MISSING' | 'UNCLEAR';
  observedMark: 'FULL_SIGNATURE' | 'STAMP_ONLY' | 'INITIALS_ONLY' | 'NAME_ONLY' | 'NONE' | 'ILLEGIBLE';
  rationale: string; detectionId?: string | null; page?: number | null; documentSha256: string;
}) {
  const cv = await loadCv(tx, cvId, true);
  assertCurrent(cv, ifMatch);
  if (body.documentSha256 !== cv.sha256) {
    throw conflict('document_changed', 'İncelediğiniz belge güncel sürüm değil. Yeni sürümü açın.');
  }
  if (cv.signature_finalized_at) throw conflict('already_finalized', 'İmza kontrolü bu sürüm için kesinleşti.');
  const req = await tx.query<{ requirement_count: number; acceptable_methods: string[]; display_name: string }>(
    `SELECT r.requirement_count, r.acceptable_methods, p.display_name FROM signature_requirements r JOIN contract_parties p ON p.id = r.party_id
     WHERE r.id = $1 AND r.contract_version_id = $2 AND r.retired_at IS NULL`, [body.requirementId, cvId]);
  const r = req.rows[0];
  if (!r) throw unprocessable('requirement_not_in_version', 'Gereksinim bu sürüme ait değil.');
  if (!r.acceptable_methods.includes('WET_IMAGE_REVIEW')) {
    throw unprocessable('method_not_image_review', 'Bu gereksinim görsel inceleme ile karşılanmaz; e-imza doğrulaması gerekir.');
  }
  if (body.slot > r.requirement_count) throw unprocessable('invalid_slot', 'Geçersiz imzacı sırası.');
  if (body.decision === 'IMAGE_CONFIRMED' && body.observedMark !== 'FULL_SIGNATURE') {
    throw unprocessable('mark_not_signature', 'Kaşe, paraf veya yazılı isim tam imza olarak teyit edilemez.');
  }
  const ins = await tx.query<{ id: string }>(
    `INSERT INTO signature_reviews (tenant_id, company_id, requirement_id, slot, detection_id, document_version_id, document_sha256,
       reviewer_id, decision, observed_mark, rationale, page)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING id`,
    [ctx.tenantId, cv.company_id, body.requirementId, body.slot, body.detectionId ?? null, cv.document_version_id, cv.sha256,
      ctx.userId, body.decision, body.observedMark, body.rationale, body.page ?? null]);
  await audit(tx, ctx, 'signature.review.recorded', 'contract_version', cvId,
    { reviewId: ins.rows[0]!.id, requirementId: body.requirementId, decision: body.decision, observedMark: body.observedMark, sha256: cv.sha256 });
  if (body.decision === 'MISSING') {
    await openTask(tx, ctx, {
      companyId: cv.company_id, kind: 'SIGNATURE_MISSING', entityType: 'contract_version', entityId: cvId,
      title: `${r.display_name} tarafı imza eksik: ${cv.title}`, reason: 'İnsan incelemesi bu taraf için imza görüntüsünün eksik olduğunu teyit etti.',
      nextAction: 'İmzalı belgeyi yeniden isteyin veya gerekçeli istisna talep edin.', assigneeRole: 'LEGAL', severity: 'HIGH',
      dedupeKey: `sig:${cvId}:missing:${body.requirementId}`,
    });
  }
  const s = await getSignatureStatus(tx, ctx, cvId);
  if (!s.status.blockers.some((b) => b.code === 'REVIEW_PENDING')) await closeTasks(tx, `sig:${cvId}:review`);
  if (s.status.overall === 'COMPLETE') await closeTasks(tx, `sig:${cvId}:`);
  return { reviewId: ins.rows[0]!.id, status: s.status };
}

export async function recordCustody(tx: Tx, ctx: TenantContext, cvId: string, body: {
  status: 'RECEIPT_DECLARED' | 'CUSTODY_CONFIRMED'; location: string; responsibleUserId: string; occurredAt: string; evidenceReference?: string | null;
}) {
  const cv = await loadCv(tx, cvId);
  await tx.query(
    `INSERT INTO original_custody_events (tenant_id, company_id, contract_version_id, status, location, responsible_user_id, occurred_at, evidence_reference, recorded_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [ctx.tenantId, cv.company_id, cvId, body.status, body.location, body.responsibleUserId, body.occurredAt, body.evidenceReference ?? null, ctx.userId]);
  await audit(tx, ctx, 'signature.custody.recorded', 'contract_version', cvId, { status: body.status });
}

/** E-imza doğrulaması ayrı servis gerektirir; yoksa NOT_CHECKED + blokaj nedeni kaydedilir (T35). */
export async function requestDigitalValidation(tx: Tx, ctx: TenantContext, cvId: string, requirementId: string | null, configuredValidator: string | null) {
  const cv = await loadCv(tx, cvId);
  if (!configuredValidator) {
    await tx.query(
      `INSERT INTO digital_validations (tenant_id, company_id, contract_version_id, requirement_id, signed_file_sha256, validator, status, blocked_reason)
       VALUES ($1,$2,$3,$4,$5,'none','NOT_CHECKED','NO_VALIDATOR_CONFIGURED')`,
      [ctx.tenantId, cv.company_id, cvId, requirementId, cv.sha256]);
    await openTask(tx, ctx, {
      companyId: cv.company_id, kind: 'ESIGN_VALIDATION_BLOCKED', entityType: 'contract_version', entityId: cvId,
      title: `E-imza doğrulanamadı: ${cv.title}`, reason: 'E-imza doğrulama servisi yapılandırılmadı. Görsel e-imza işareti doğrulama sayılmaz.',
      nextAction: 'Doğrulayıcı entegrasyonu tamamlanana kadar Satınalma karar verir veya istisna talep edilir.',
      assigneeRole: 'LEGAL', dedupeKey: `sig:${cvId}:esign-blocked`,
    });
    await audit(tx, ctx, 'signature.digital_validation.blocked', 'contract_version', cvId, { requirementId });
    return { status: 'NOT_CHECKED' as const, blockedReason: 'NO_VALIDATOR_CONFIGURED' };
  }
  throw new ApiError(501, 'validator_not_implemented', `Doğrulayıcı adaptörü "${configuredValidator}" henüz uygulanmadı.`);
}

export async function requestException(tx: Tx, ctx: TenantContext, cvId: string, body: {
  requirementIds: string[]; reason: string; residualRisk: string; scope: string; expiresAt: string;
}) {
  const cv = await loadCv(tx, cvId);
  const exp = new Date(body.expiresAt);
  if (!(exp > new Date())) throw unprocessable('invalid_expiry', 'İstisna bitiş tarihi gelecekte olmalı.');
  if (exp.getTime() - Date.now() > 366 * 86400000) throw unprocessable('expiry_too_long', 'İstisna en fazla 1 yıl olabilir.');
  const owned = await tx.query(`SELECT count(*)::int AS n FROM signature_requirements WHERE contract_version_id = $1 AND id = ANY($2::uuid[])`,
    [cvId, body.requirementIds]);
  if ((owned.rows[0] as { n: number }).n !== body.requirementIds.length) throw unprocessable('requirement_not_in_version', 'Gereksinimler bu sürüme ait değil.');
  const r = await tx.query<{ id: string }>(
    `INSERT INTO signature_exceptions (tenant_id, company_id, contract_version_id, requirement_ids, reason, residual_risk, scope, expires_at, requested_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
    [ctx.tenantId, cv.company_id, cvId, body.requirementIds, body.reason, body.residualRisk, body.scope, exp, ctx.userId]);
  await openTask(tx, ctx, {
    companyId: cv.company_id, kind: 'SIGNATURE_EXCEPTION_DECISION', entityType: 'contract_version', entityId: cvId,
    title: `İmza istisnası kararı: ${cv.title}`, reason: body.reason, nextAction: 'Kapsam, süre ve kalan riski değerlendirip karar verin.',
    assigneeRole: 'LEGAL', dedupeKey: `sig-exc:${r.rows[0]!.id}`,
  });
  await audit(tx, ctx, 'signature.exception.requested', 'contract_version', cvId, { exceptionId: r.rows[0]!.id, expiresAt: exp });
  return { exceptionId: r.rows[0]!.id };
}

export async function decideException(tx: Tx, ctx: TenantContext, exceptionId: string, body: { decision: 'APPROVED' | 'REJECTED'; rationale: string }) {
  const x = await tx.query<{ id: string; requested_by: string; status: string; contract_version_id: string }>(
    `SELECT id, requested_by, status, contract_version_id FROM signature_exceptions WHERE id = $1 FOR UPDATE`, [exceptionId]);
  const e = x.rows[0];
  if (!e) throw notFound();
  if (e.requested_by === ctx.userId) throw new ApiError(403, 'sod_violation', 'Görev ayrılığı: istisnayı talep eden onaylayamaz.');
  if (e.status !== 'REQUESTED') throw conflict('invalid_state', 'Bu istisna zaten karara bağlandı.');
  await tx.query(`UPDATE signature_exceptions SET status = $2, decided_by = $3, decided_at = now(), decision_rationale = $4 WHERE id = $1`,
    [exceptionId, body.decision, ctx.userId, body.rationale]);
  await closeTasks(tx, `sig-exc:${exceptionId}`);
  await audit(tx, ctx, `signature.exception.${body.decision.toLowerCase()}`, 'contract_version', e.contract_version_id, { exceptionId }, body.rationale);
}

/** SIG10/T33: eksik kanıtla kesinleştirme sunucuda reddedilir; gereksinim bazlı yapılandırılmış hata. */
export async function finalizeSignatureReview(tx: Tx, ctx: TenantContext, cvId: string, ifMatch: string | undefined) {
  const cv = await loadCv(tx, cvId, true);
  assertCurrent(cv, ifMatch);
  if (cv.signature_finalized_at) throw conflict('already_finalized', 'İmza kontrolü bu sürüm için zaten kesinleşti.');
  // D95a: imza kesinleştirmesi Satınalma'ya geçti; görev ayrılığı sürer — sözleşme sürümünü ekleyen kendi kaydını kesinleştiremez.
  if (cv.created_by === ctx.userId) {
    throw new ApiError(403, 'segregation_of_duties', 'Görev ayrılığı: sözleşmeyi ekleyen kişi imza kontrolünü kesinleştiremez; başka bir Satınalma kullanıcısı kesinleştirir.');
  }
  const s = await getSignatureStatus(tx, ctx, cvId);
  if (!s.status.canFinalize) {
    throw unprocessable('unresolved_requirements', 'Gerekli imza kanıtları tamamlanmadı.', {
      overall: s.status.overall, blockers: s.status.blockers,
    });
  }
  const finalStatus = s.status.overall;
  await tx.query(
    `UPDATE contract_versions SET signature_finalized_at = now(), signature_finalized_by = $2, signature_finalized_status = $3,
       row_version = row_version + 1 WHERE id = $1`, [cvId, ctx.userId, finalStatus]);
  if (finalStatus !== 'EXCEPTION_ACTIVE') await closeTasks(tx, `sig:${cvId}:`);
  await audit(tx, ctx, 'signature.review.finalized', 'contract_version', cvId, { status: finalStatus, sha256: cv.sha256 });
  return { finalizedStatus: finalStatus };
}
