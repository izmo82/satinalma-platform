import type { TenantContext, Tx } from '../db.ts';
import type { ObjectStore } from '../storage.ts';
import { objectKey } from '../storage.ts';
import { inspectUpload } from '../files.ts';
import { audit } from '../audit.ts';
import { openTask } from '../tasks.ts';
import { ApiError, notFound } from '../errors.ts';
import { parseUblInvoice } from './einvoice.ts';
import { invoiceFromEInvoice, type EInvoiceIntake } from './invoices.ts';
import { requestAi } from './ai.ts';
import { resolveSeller, type ResolveResult } from './suppliers.ts';
import { nextCode } from '../codes.ts';

export interface UploadInput {
  companyId: string;
  kind: 'INVOICE' | 'CONTRACT' | 'QUOTE' | 'OTHER';
  title: string;
  documentId: string | null;
  filename: string;
  mimeType: string;
  body: Buffer;
}

export interface UploadResult {
  documentId: string;
  documentVersionId: string;
  versionNo: number;
  sha256: string;
  duplicate: boolean;
  basicCheckStatus: 'PASSED' | 'QUARANTINED';
  basicCheckReason: string | null;
  avScanStatus: 'NOT_AVAILABLE';
  processing: { stage: string; message: string };
  supplier: ResolveResult | null;
  /** e-Fatura XML'den açılan fatura kaydı (yalnız yapılandırılmış fatura belgesinde). */
  invoice?: EInvoiceIntake | null;
  /** AI yönlendirme kararı (çalışmasa da kayıtlı; T23). */
  ai?: { runId: string; status: string; reason: string | null };
}

/**
 * Belge sürümü kaydı. Aynı içerik (hash) aynı belgeye/aynı şirket+türde tekrar yüklenirse
 * yeni sürüm ya da iş açılmaz; mevcut sürüm döner (BR08, T30).
 */
export async function uploadDocument(tx: Tx, ctx: TenantContext, store: ObjectStore, input: UploadInput): Promise<UploadResult> {
  if (!ctx.companyIds.includes(input.companyId)) throw new ApiError(403, 'company_forbidden', 'Bu şirket için yetkiniz yok.');
  const inspected = inspectUpload(input.filename, input.mimeType, input.body);
  if ('rejected' in inspected) throw new ApiError(415, 'unsupported_file', inspected.rejected);

  const dup = await tx.query<{ id: string; document_id: string; version_no: number; basic_check_status: 'PASSED' | 'QUARANTINED'; basic_check_reason: string | null }>(
    `SELECT dv.id, dv.document_id, dv.version_no, dv.basic_check_status, dv.basic_check_reason
     FROM document_versions dv JOIN documents d ON d.id = dv.document_id
     WHERE dv.sha256 = $1 AND dv.company_id = $2 AND d.kind = $3 AND ($4::uuid IS NULL OR dv.document_id = $4)
     ORDER BY dv.created_at LIMIT 1`,
    [inspected.sha256, input.companyId, input.kind, input.documentId]);
  if (dup.rows[0]) {
    const d = dup.rows[0];
    return {
      documentId: d.document_id, documentVersionId: d.id, versionNo: d.version_no, sha256: inspected.sha256, duplicate: true,
      basicCheckStatus: d.basic_check_status, basicCheckReason: d.basic_check_reason, avScanStatus: 'NOT_AVAILABLE',
      processing: { stage: 'DUPLICATE', message: 'Bu dosya daha önce yüklenmiş. Yeni kayıt oluşturulmadı.' }, supplier: null,
    };
  }

  let documentId = input.documentId;
  let versionNo = 1;
  if (documentId) {
    const d = await tx.query<{ max: number | null }>(
      `SELECT max(version_no) AS max FROM document_versions WHERE document_id = $1 AND company_id = $2`, [documentId, input.companyId]);
    if (d.rows[0]?.max == null) throw notFound();
    versionNo = d.rows[0].max + 1;
  } else {
    const d = await tx.query<{ id: string }>(
      `INSERT INTO documents (tenant_id, company_id, kind, title, created_by, code) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
      [ctx.tenantId, input.companyId, input.kind, input.title, ctx.userId, await nextCode(tx, ctx, 'document', 'BLG')]);
    documentId = d.rows[0]!.id;
  }

  const key = objectKey(ctx.tenantId, inspected.sha256);
  // Orijinal baytlar hash anahtarıyla, dönüştürülmeden saklanır (T46). Önizleme ayrı türetilir.
  await store.put(key, input.body, inspected.mimeType);

  const v = await tx.query<{ id: string }>(
    `INSERT INTO document_versions (tenant_id, company_id, document_id, version_no, sha256, mime_type, size_bytes, storage_key,
       original_filename, basic_check_status, basic_check_reason, page_count, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING id`,
    [ctx.tenantId, input.companyId, documentId, versionNo, inspected.sha256, inspected.mimeType, inspected.sizeBytes, key,
      input.filename.slice(0, 255), inspected.status, inspected.reason, inspected.pageCount, ctx.userId]);
  const dvId = v.rows[0]!.id;
  await audit(tx, ctx, 'document.version.created', 'document_version', dvId,
    { documentId, versionNo, sha256: inspected.sha256, sizeBytes: inspected.sizeBytes, basicCheck: inspected.status });

  const base = {
    documentId, documentVersionId: dvId, versionNo, sha256: inspected.sha256, duplicate: false,
    basicCheckStatus: inspected.status, basicCheckReason: inspected.reason, avScanStatus: 'NOT_AVAILABLE' as const,
  };

  if (inspected.status === 'QUARANTINED') {
    await openTask(tx, ctx, {
      companyId: input.companyId, kind: 'DOCUMENT_QUARANTINED', entityType: 'document_version', entityId: dvId,
      title: 'Belge karantinada', reason: inspected.reason ?? 'Güvenlik kontrolü geçmedi.',
      nextAction: 'Göndericiden temiz/şifresiz belge isteyin.', assigneeRole: 'SECURITY', severity: 'HIGH',
      dedupeKey: `doc:${dvId}:quarantine`,
    });
    return { ...base, processing: { stage: 'QUARANTINED', message: 'Belge güvenlik kontrolünden geçmedi ve işlenmeyecek.' }, supplier: null };
  }

  if (input.kind === 'INVOICE' && inspected.mimeType === 'application/xml') {
    const ubl = parseUblInvoice(input.body);
    if (ubl) {
      await saveRuleFields(tx, ctx, input.companyId, dvId, ubl);
      const supplier = await resolveSeller(tx, ctx, {
        companyId: input.companyId, documentVersionId: dvId, iban: ubl.sellerIban,
        seller: { country: 'TR', taxIdType: ubl.seller.taxIdType, taxId: ubl.seller.taxId, name: ubl.seller.name,
          confidence: ubl.seller.taxId ? 'HIGH' : 'MISSING', source: ubl.seller.source },
      });
      // Satıcı kesin kimlikle bulunduysa (aday dahil) fatura kaydı açılır; aday satıcıya onay kontrolde engellenir (BR02).
      const invoice = supplier.supplierId && !['IDENTITY_REVIEW_REQUIRED', 'SELLER_IS_OWN_COMPANY'].includes(supplier.outcome)
        ? await invoiceFromEInvoice(tx, ctx, { companyId: input.companyId, documentVersionId: dvId, supplierId: supplier.supplierId, ubl })
        : null;
      return { ...base, processing: { stage: 'STRUCTURED_PARSED', message: 'e-Fatura XML okundu; alanlar kural ile çıkarıldı.' }, supplier, invoice };
    }
  }

  if (input.kind === 'INVOICE') {
    // OCR sağlayıcısı bağlı değilse (BLOCKED) manuel alan girişi görevi; sahte çıkarım yok.
    await openTask(tx, ctx, {
      companyId: input.companyId, kind: 'DOCUMENT_MANUAL_EXTRACTION', entityType: 'document_version', entityId: dvId,
      title: 'Fatura alanları girilmeli', reason: 'Yapılandırılmış veri yok ve OCR sağlayıcısı yapılandırılmadı.',
      nextAction: 'Belgeyi açıp satıcı kimliğini ve tutarları girin.', assigneeRole: 'FINANCE', dedupeKey: `doc:${dvId}:manual-extraction`,
    });
    // AI02 yalnız yönlendirme kapısından geçerse kuyruğa girer (izinli sağlayıcı, bölge, bütçe). Kapı kapalıysa manuel görev sürer.
    const ai = await requestAi(tx, ctx, { task: 'AI02', entityType: 'document_version', entityId: dvId, documentVersionId: dvId, companyId: input.companyId,
      workload: { pages: inspected.pageCount ?? 1, inputTokens: 1500 * (inspected.pageCount ?? 1), outputTokens: 500 } });
    return { ...base, processing: { stage: 'MANUAL_EXTRACTION_REQUIRED', message: ai.status === 'QUEUED'
      ? 'AI okuması kuyrukta; sonuç inceleme önerisi olarak gelir. Alanlar onaylanana kadar manuel giriş görevi açık.'
      : 'Otomatik okuma yapılamadı; manuel alan girişi gerekli.' }, supplier: null, ai };
  }
  return { ...base, processing: { stage: 'STORED', message: 'Belge sürümü kaydedildi.' }, supplier: null };
}

async function saveRuleFields(tx: Tx, ctx: TenantContext, companyId: string, dvId: string, u: NonNullable<ReturnType<typeof parseUblInvoice>>) {
  const fields: [string, string | null, string][] = [
    ['invoice_number', u.invoiceNumber, 'xpath:/Invoice/ID'],
    ['ettn', u.ettn, 'xpath:/Invoice/UUID'],
    ['issue_date', u.issueDate, 'xpath:/Invoice/IssueDate'],
    ['currency', u.currency, 'xpath:/Invoice/LegalMonetaryTotal/PayableAmount/@currencyID'],
    ['payable_amount', u.payableAmount, 'xpath:/Invoice/LegalMonetaryTotal/PayableAmount'],
    ['seller_tax_id', u.seller.taxId, u.seller.source],
    ['seller_tax_id_type', u.seller.taxIdType, u.seller.source],
    ['seller_name', u.seller.name, 'xpath:/Invoice/AccountingSupplierParty/Party/PartyName/Name'],
    ['buyer_tax_id', u.buyer.taxId, u.buyer.source],
    ['buyer_name', u.buyer.name, 'xpath:/Invoice/AccountingCustomerParty/Party/PartyName/Name'],
    ['seller_iban', u.sellerIban, 'xpath:/Invoice/PaymentMeans/PayeeFinancialAccount/ID'],
  ];
  for (const [field, value, path] of fields) {
    await tx.query(
      `INSERT INTO extracted_fields (tenant_id, company_id, document_version_id, field, value, origin, source_ref, confidence)
       VALUES ($1,$2,$3,$4,$5,'RULE',$6,$7)`,
      [ctx.tenantId, companyId, dvId, field, value, { kind: 'xpath', path }, value == null ? 'MISSING' : 'HIGH']);
  }
}

/** İnsanın kaynak belgeden girdiği satıcı kimliği (OCR yokken veya düzeltmede). */
export async function submitSellerIdentity(tx: Tx, ctx: TenantContext, dvId: string,
  body: { taxIdType: 'VKN' | 'TCKN' | 'FOREIGN'; taxId: string; name: string; country: string; iban?: string | null; page?: number | null }) {
  const dv = await tx.query<{ company_id: string }>(`SELECT company_id FROM document_versions WHERE id = $1 AND basic_check_status = 'PASSED'`, [dvId]);
  if (!dv.rows[0]) throw notFound();
  const src = { kind: 'human', page: body.page ?? null };
  for (const [field, value] of [['seller_tax_id', body.taxId], ['seller_tax_id_type', body.taxIdType], ['seller_name', body.name], ['seller_iban', body.iban ?? null]] as const) {
    await tx.query(
      `INSERT INTO extracted_fields (tenant_id, company_id, document_version_id, field, value, origin, source_ref, confidence, review_state, created_by)
       VALUES ($1,$2,$3,$4,$5,'HUMAN',$6,$7,'CONFIRMED',$8)`,
      [ctx.tenantId, dv.rows[0].company_id, dvId, field, value, src, value == null ? 'MISSING' : 'HIGH', ctx.userId]);
  }
  return resolveSeller(tx, ctx, {
    companyId: dv.rows[0].company_id, documentVersionId: dvId, iban: body.iban ?? null,
    seller: { country: body.country, taxIdType: body.taxIdType, taxId: body.taxId, name: body.name, confidence: 'HIGH', source: 'human' },
  });
}
