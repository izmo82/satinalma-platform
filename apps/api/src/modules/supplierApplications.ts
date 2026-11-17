import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type pg from 'pg';
import type { Multipart } from '@fastify/multipart';
import { normalizeTaxId, requiredDocumentTypes, verificationEmail, type DocType, type TaxIdType } from '@sp/domain';
import { withoutTenant, withTenant, type TenantContext, type Tx } from '../db.ts';
import { ApiError, notFound, unprocessable } from '../errors.ts';
import { inspectUpload } from '../files.ts';
import type { ObjectStore } from '../storage.ts';
import { scanStatus, type AvScanner, type AvScanStatus } from '../av/index.ts';
import { enqueueEmailDispatch, type MailChannel } from '../mail/index.ts';
import { audit } from '../audit.ts';
import { clientAddressKey, DEFAULT_PUBLIC_RATE_LIMIT } from '../publicRateLimit.ts';
import { openTask } from '../tasks.ts';

/**
 * v2 Faz 5 (D110) Görev 4: girişsiz tedarikçi başvurusu (R2–R5) ve başvuru ayarları (R3).
 *
 * Girişsiz uçlar tabloları doğrudan okumaz/yazmaz: yalnız 052/052a `public_application_*` SECURITY DEFINER işlevleri çağrılır.
 * Kiracı yalnız kısaltmadan (ayar) ya da belirteç özetinden çözülür; işlevlerin `internal` alanı (kiracı/başvuru kimliği) istemciye
 * dönmeden önce çıkarılır. Tek istisna, işlevin yazdığı `QUEUED` e-posta satırına gönderim işi ve süre dolumu işi kurmaktır: bu,
 * işlevle aynı işlemde, sunucunun çözdüğü kiracının sistem bağlamında yapılır (istemci kiracı seçemez).
 * Belirteç: 32 bayt rastgele, base64url; veritabanında yalnız SHA-256 özeti; bağlantıda yalnız `#token=` parçasında.
 * İstemci adresi yalnız `sha256(ip + tenant)` olarak işleve gider.
 */

export const APPLICATION_LIMITS = {
  maxFiles: 10,
  maxFileBytes: 10 * 1024 * 1024,
  maxTotalBytes: 40 * 1024 * 1024,
  types: ['application/pdf', 'image/jpeg', 'image/png'],
} as const;
/** Rota multipart sınırları (R4c). Dosya sınırı aşılırsa 422; alan sayısı makul belge listesine göre. */
export const MULTIPART_LIMITS = { fileSize: APPLICATION_LIMITS.maxFileBytes, files: APPLICATION_LIMITS.maxFiles, fields: 60, parts: 80, fieldSize: 8000 };

export const SUBMITTED_JOB = 'supplier_application.submitted';
export const EXPIRE_JOB = 'supplier_application.expire';
const SYSTEM_USER = '00000000-0000-0000-0000-000000000000';
/** Sunucunun çözdüğü kiracıda sistem bağlamı (tüm departmanlar; rol yok). */
export const applicationSystemContext = (tenantId: string, correlationId: string): TenantContext =>
  ({ tenantId, userId: SYSTEM_USER, roles: [], companyIds: [], departmentIds: [], allDepartments: true, correlationId });

// ---------- Girişsiz: yapılandırma ----------

export interface PublicDocumentType { code: string; name: string; required: boolean; requiredCategories: string[]; expiryRequired: boolean }
export type PublicConfig =
  | { enabled: false }
  | { enabled: true; organizationName: string; categories: string[]; documentTypes: PublicDocumentType[]; limits: typeof PUBLIC_LIMITS };
const PUBLIC_LIMITS = { maxFiles: APPLICATION_LIMITS.maxFiles, maxFileBytes: APPLICATION_LIMITS.maxFileBytes,
  maxTotalBytes: APPLICATION_LIMITS.maxTotalBytes, types: [...APPLICATION_LIMITS.types] };

type ConfigRow = { enabled: boolean; organizationName?: string; categories?: string[]; documentTypes?: PublicDocumentType[]; internal?: { tenantId: string } };

/** Kapalı, bilinmeyen ya da ayarlanmamış kısaltma aynı yanıtı verir (`{ enabled: false }`; kiracı adı yok). */
export async function loadPublicConfig(pool: pg.Pool, slug: string): Promise<{ config: PublicConfig; tenantId: string | null }> {
  if (!/^[a-z0-9-]{3,40}$/.test(slug)) return { config: { enabled: false }, tenantId: null };
  const r = await withoutTenant(pool, async (c) => (await c.query<{ r: ConfigRow }>(`SELECT public_application_config($1) AS r`, [slug])).rows[0]!.r);
  if (!r.enabled || !r.internal?.tenantId) return { config: { enabled: false }, tenantId: null };
  return {
    tenantId: r.internal.tenantId,
    config: { enabled: true, organizationName: r.organizationName ?? '', categories: r.categories ?? [], documentTypes: r.documentTypes ?? [], limits: PUBLIC_LIMITS },
  };
}

// ---------- Girişsiz: çok parçalı form ----------

export interface UploadedFile { typeCode: string; filename: string; mimetype: string; body: Buffer }
export interface ApplicationForm { fields: Map<string, string[]>; files: UploadedFile[]; validUntil: Map<string, string> }

const DOC_FIELD = /^documents\[([A-Za-z0-9_.-]{2,40})\]$/;
const VALID_FIELD = /^validUntil\[([A-Za-z0-9_.-]{2,40})\]$/;

/** Formu okur; dosya başına 10 MB, en çok 10 dosya, toplam 40 MB (aşımda 422, gövde baştan sona belleğe alınmaz). */
export async function readApplicationForm(parts: AsyncIterableIterator<Multipart>): Promise<ApplicationForm> {
  const form: ApplicationForm = { fields: new Map(), files: [], validUntil: new Map() };
  let total = 0;
  try {
    for await (const part of parts) {
      if (part.type === 'file') {
        const m = DOC_FIELD.exec(part.fieldname);
        if (!m) {
          await part.toBuffer().catch(() => undefined);
          throw unprocessable('document_type', 'Dosya alanı tanınmadı; belgeler belge türüyle gönderilmeli.', { field: part.fieldname });
        }
        const body = await part.toBuffer();
        total += body.length;
        if (total > APPLICATION_LIMITS.maxTotalBytes) throw unprocessable('total_size', 'Dosyaların toplamı 40 MB sınırını aşıyor.');
        form.files.push({ typeCode: m[1]!, filename: part.filename, mimetype: part.mimetype, body });
      } else {
        if (part.valueTruncated || part.fieldnameTruncated) throw unprocessable('field_too_long', 'Bir form alanı çok uzun.', { field: part.fieldname.slice(0, 80) });
        const value = typeof part.value === 'string' ? part.value : String(part.value ?? '');
        const v = VALID_FIELD.exec(part.fieldname);
        if (v) { if (value.trim()) form.validUntil.set(v[1]!, value.trim()); continue; }
        const name = part.fieldname.replace(/\[\]$/, '');
        form.fields.set(name, [...(form.fields.get(name) ?? []), value]);
      }
    }
  } catch (err: any) {
    if (err instanceof ApiError) throw err;
    if (err?.code === 'FST_REQ_FILE_TOO_LARGE') throw unprocessable('file_too_large', 'Dosya 10 MB sınırını aşıyor.');
    if (err?.code === 'FST_FILES_LIMIT') throw unprocessable('too_many_files', 'En çok 10 dosya yüklenebilir.');
    if (err?.code === 'FST_PARTS_LIMIT' || err?.code === 'FST_FIELDS_LIMIT') throw unprocessable('too_many_fields', 'Formda çok fazla alan var.');
    throw err;
  }
  return form;
}

const field = (form: ApplicationForm, name: string) => (form.fields.get(name)?.[0] ?? '').trim();
const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const validDate = (s: string) => DATE.test(s) && !Number.isNaN(Date.parse(`${s}T00:00:00Z`)) && new Date(`${s}T00:00:00Z`).toISOString().startsWith(s);
const invalid = (fieldName: string, message: string) => unprocessable('invalid_field', message, { field: fieldName });

/** Tuzak alanı (R4d): insan kullanıcı görmez; doluysa kayıt açılmaz ama yanıt aynıdır. */
export const isHoneypot = (form: ApplicationForm) => field(form, 'website') !== '';

export interface ApplicationInput {
  legalName: string; country: string; taxIdType: TaxIdType; taxId: string; contactName: string; contactEmail: string;
  contactPhone: string | null; address: string | null; categories: string[]; services: string | null;
}

function categoriesOf(form: ApplicationForm): string[] {
  const raw = form.fields.get('categories') ?? [];
  // Tek alan JSON dizisi olarak da gönderilebilir.
  if (raw.length === 1 && raw[0]!.trim().startsWith('[')) {
    try {
      const arr = JSON.parse(raw[0]!);
      if (Array.isArray(arr) && arr.every((x) => typeof x === 'string')) return [...new Set(arr.map((x: string) => x.trim()).filter(Boolean))];
    } catch { /* aşağıda geçersiz sayılır */ }
    throw invalid('categories', 'Hizmet kategorileri okunamadı.');
  }
  return [...new Set(raw.map((x) => x.trim()).filter(Boolean))];
}

/** Alan denetimi (VKN denetim basamağı dahil). İletiler var olan kayıtla ilgili bilgi vermez. */
export function validateApplication(form: ApplicationForm, cfg: Extract<PublicConfig, { enabled: true }>): ApplicationInput {
  const legalName = field(form, 'legalName');
  if (legalName.length < 2 || legalName.length > 300) throw invalid('legalName', 'Firma unvanı 2–300 karakter olmalı.');
  const country = (field(form, 'country') || 'TR').toUpperCase();
  if (!/^[A-Z]{2}$/.test(country)) throw invalid('country', 'Ülke kodu iki harf olmalı (ör. TR).');
  const taxIdType = (field(form, 'taxIdType') || 'VKN') as TaxIdType;
  if (!['VKN', 'TCKN', 'FOREIGN'].includes(taxIdType)) throw invalid('taxIdType', 'Vergi kimliği türü VKN, TCKN ya da FOREIGN olmalı.');
  const tax = normalizeTaxId(country, taxIdType, field(form, 'taxId'));
  if (!tax.ok) {
    throw unprocessable('invalid_tax_id', taxIdType === 'TCKN' ? 'T.C. kimlik numarası geçersiz.' : 'Vergi kimlik numarası geçersiz; numarayı kontrol edin.', { reason: tax.reason });
  }
  const contactName = field(form, 'contactName');
  if (contactName.length < 2 || contactName.length > 200) throw invalid('contactName', 'Yetkili adı 2–200 karakter olmalı.');
  const contactEmail = field(form, 'contactEmail').toLowerCase();
  if (contactEmail.length > 254 || !EMAIL.test(contactEmail)) throw invalid('contactEmail', 'Geçerli bir e-posta adresi girin.');
  const contactPhone = field(form, 'contactPhone') || null;
  if (contactPhone && contactPhone.length > 40) throw invalid('contactPhone', 'Telefon en çok 40 karakter olabilir.');
  const address = field(form, 'address') || null;
  if (address && address.length > 1000) throw invalid('address', 'Adres en çok 1000 karakter olabilir.');
  const services = field(form, 'services') || null;
  if (services && services.length > 4000) throw invalid('services', 'Hizmet açıklaması en çok 4000 karakter olabilir.');
  const categories = categoriesOf(form);
  if (categories.some((c) => !cfg.categories.includes(c))) throw invalid('categories', 'Seçilen hizmet kategorisi bu başvuru formunda yok.');

  checkDocuments(form, cfg.documentTypes, categories, null);
  return { legalName, country, taxIdType, taxId: tax.normalized, contactName, contactEmail, contactPhone, address, categories, services };
}

/**
 * Belge listesi denetimi: tanınmayan tür, zorunlu türün eksikliği (liste), geçerlilik tarihi. `allowed` verilirse yalnız bu türler
 * kabul edilir ve hepsi gelmelidir (eksik belge tamamlama).
 */
export function checkDocuments(form: ApplicationForm, types: { code: string; name: string; required?: boolean; requiredCategories?: string[]; expiryRequired: boolean }[],
  categories: string[], allowed: string[] | null) {
  const byCode = new Map(types.map((t) => [t.code, t]));
  for (const f of form.files) {
    if (!byCode.has(f.typeCode) || (allowed && !allowed.includes(f.typeCode))) {
      throw unprocessable('document_type', allowed ? 'Yalnız istenen belgeler yüklenebilir.' : 'Belge türü bu başvuru formunda yok.', { typeCode: f.typeCode });
    }
  }
  for (const code of form.validUntil.keys()) {
    if (!validDate(form.validUntil.get(code)!)) throw unprocessable('invalid_field', 'Geçerlilik tarihi YYYY-AA-GG biçiminde olmalı.', { field: `validUntil[${code}]` });
  }
  const required: { code: string; name: string }[] = allowed
    ? allowed.map((c) => ({ code: c, name: byCode.get(c)?.name ?? c }))
    : requiredDocumentTypes(types.map((t): DocType => ({ code: t.code, name: t.name, active: true, requiredMode: t.required ? 'ALWAYS' : 'CATEGORIES',
        categories: t.requiredCategories ?? [], requiresExpiry: t.expiryRequired })), categories).map((t) => ({ code: t.code, name: t.name }));
  const uploaded = new Set(form.files.map((f) => f.typeCode));
  const missing = required.filter((t) => !uploaded.has(t.code));
  if (missing.length) {
    throw unprocessable('documents_missing', `Zorunlu belgeler eksik: ${missing.map((m) => m.name).join(', ')}.`, { documents: missing });
  }
  const noExpiry = [...uploaded].filter((c) => byCode.get(c)?.expiryRequired && !form.validUntil.has(c)).map((c) => ({ code: c, name: byCode.get(c)!.name }));
  if (noExpiry.length) {
    throw unprocessable('valid_until_required', `Geçerlilik tarihi gerekli: ${noExpiry.map((m) => m.name).join(', ')}.`, { documents: noExpiry });
  }
}

export interface PreparedDocument {
  typeCode: string; originalFilename: string; mimeType: string; sizeBytes: number; sha256: string; storageKey: string;
  basicCheckStatus: 'PASSED' | 'QUARANTINED'; basicCheckReason: string | null; avScanStatus: AvScanStatus; validUntil: string | null; body: Buffer;
}

/**
 * Dosya denetimi (`inspectUpload` sihirli bayt; yalnız PDF/JPEG/PNG) ve R5 taraması — nesne deposuna yazmadan önce.
 * Virüslü dosya 422 `file_infected` (hiçbir dosya yazılmaz); tarama hatası dosyayı karantinaya alır (asla temiz sayılmaz).
 */
export async function prepareDocuments(form: ApplicationForm, tenantId: string, scanner: AvScanner | null): Promise<PreparedDocument[]> {
  const out: PreparedDocument[] = [];
  for (const f of form.files) {
    if (f.body.length > APPLICATION_LIMITS.maxFileBytes) throw unprocessable('file_too_large', 'Dosya 10 MB sınırını aşıyor.', { file: f.filename });
    const filename = (f.filename || 'belge').slice(0, 255);
    const ins = inspectUpload(filename, f.mimetype, f.body);
    if ('rejected' in ins) throw unprocessable('file_rejected', ins.rejected, { file: filename });
    if (!(APPLICATION_LIMITS.types as readonly string[]).includes(ins.mimeType)) {
      throw unprocessable('file_rejected', 'Desteklenmeyen dosya türü. PDF, PNG veya JPEG yükleyin.', { file: filename });
    }
    const av = await scanStatus(scanner, f.body);
    if (av === 'INFECTED') throw unprocessable('file_infected', 'Dosyada virüs bulundu; başvuru kaydedilmedi.', { file: filename });
    const quarantined = av === 'ERROR' || ins.status === 'QUARANTINED';
    out.push({
      typeCode: f.typeCode, originalFilename: filename, mimeType: ins.mimeType, sizeBytes: ins.sizeBytes, sha256: ins.sha256,
      storageKey: `t/${tenantId}/supplier-documents/${randomUUID()}`,
      basicCheckStatus: quarantined ? 'QUARANTINED' : 'PASSED',
      basicCheckReason: av === 'ERROR' ? 'Virüs taraması yapılamadı; dosya karantinada.' : ins.reason,
      avScanStatus: av, validUntil: form.validUntil.get(f.typeCode) ?? null, body: f.body,
    });
  }
  return out;
}

const docJson = (docs: PreparedDocument[]) => JSON.stringify(docs.map(({ body: _b, ...d }) => ({ ...d, title: null })));

// ---------- Girişsiz: başvuru, doğrulama, tamamlama ----------

/** 32 bayt rastgele belirteç (base64url) ve özeti. */
export function newToken(): { token: string; hash: Buffer } {
  const raw = randomBytes(32);
  return { token: raw.toString('base64url'), hash: createHash('sha256').update(raw).digest() };
}
/** Biçimi bozuk belirteç özetlenmez (null → çağıran 410 `token_invalid`; ayrım sızmaz). */
export function tokenHash(token: unknown): Buffer | null {
  if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(token)) return null;
  const raw = Buffer.from(token, 'base64url');
  return raw.length === 32 ? createHash('sha256').update(raw).digest() : null;
}
export const tokenInvalid = () => new ApiError(410, 'token_invalid', 'Bağlantı geçersiz, kullanılmış ya da süresi dolmuş. Gerekirse yeniden başvurun.');
/** R4: `sha256(adres + kiracı)`; IPv6 /64 önekine indirgenir (sınırlayıcıyla aynı anahtar). */
export const ipHash = (ip: string, tenantId: string) => createHash('sha256').update(`${clientAddressKey(ip)}${tenantId}`).digest();

export interface SubmitResult { message: string; mailChannel: 'NOT_CONFIGURED' | 'QUEUED'; note: string | null }
/** R4e: yanıt girdiden bağımsız, yalnız kanala göre değişir (tuzak alanı, var olan tedarikçi, yeni firma aynı yanıtı alır). */
export function submitResponse(channel: MailChannel): SubmitResult {
  return channel.kind === 'graph'
    ? { message: 'Başvurunuz alındı. Doğrulama e-postası gönderildi; e-postadaki bağlantıyla 24 saat içinde doğrulayın.', mailChannel: 'QUEUED', note: null }
    : { message: 'Başvurunuz alındı. Doğrulama e-postası gönderilmedi.', mailChannel: 'NOT_CONFIGURED',
        note: 'E-posta kanalı yapılandırılmadı; kurum yöneticisi başvurunuzu e-posta kutusundan görebilir.' };
}

/** Tuzak alanı yanıtı: veritabanı adımı yok; kısa rastgele bekleme gerçek başvurunun süresini kabaca taklit eder. */
export async function honeypotResponse(channel: MailChannel): Promise<SubmitResult> {
  await new Promise((r) => setTimeout(r, 40 + Math.floor(Math.random() * 160)));
  return submitResponse(channel);
}

/** Depo yazımı veritabanı işleminden önce (rastgele anahtar); işlem başarısız olursa yazılanlar en iyi çabayla silinir. */
async function putObjects(store: ObjectStore, docs: PreparedDocument[]): Promise<string[]> {
  const written: string[] = [];
  try {
    for (const d of docs) { await store.put(d.storageKey, d.body, d.mimeType); written.push(d.storageKey); }
  } catch (err) {
    await removeObjects(store, written);
    throw err;
  }
  return written;
}
async function removeObjects(store: ObjectStore, keys: string[]) {
  for (const k of keys) {
    // Yalnız anahtar günlüğe yazılır (içerik, kişi verisi yok).
    await store.delete(k).catch(() => console.warn('supplier application object cleanup failed', k));
  }
}

export interface SubmitDeps { pool: pg.Pool; store: ObjectStore; scanner: AvScanner | null; channel: MailChannel; webOrigin: string; tenantPerHour?: number }

export async function submitApplication(deps: SubmitDeps, slug: string, tenantId: string, ip: string, input: ApplicationInput, docs: PreparedDocument[]): Promise<SubmitResult> {
  const { token, hash } = newToken();
  const link = `${deps.webOrigin.replace(/\/$/, '')}/basvuru/dogrula#token=${token}`;
  const mail = verificationEmail({ legalName: input.legalName, link });
  const status = deps.channel.kind === 'graph' ? 'QUEUED' : 'NOT_CONFIGURED';
  const ctx = applicationSystemContext(tenantId, `public-apply-${randomUUID().slice(0, 8)}`);
  const cap = deps.tenantPerHour ?? DEFAULT_PUBLIC_RATE_LIMIT.tenantPerHour;
  const written = await putObjects(deps.store, docs);
  try {
    await withTenant(deps.pool, ctx, async (tx) => {
      // Kiracı başına toplam saatlik sınır (adres değiştiren dağıtık deneme; kopyalar arası geçerli).
      const recent = (await tx.query<{ n: number }>(`SELECT count(*)::int AS n FROM supplier_applications WHERE created_at > now() - interval '1 hour'`)).rows[0]!.n;
      // İşlevin SP429'u ile aynı yanıt (Retry-After dahil) hata eşlemesinden gelir.
      if (recent >= cap) throw Object.assign(new Error('rate_limited: tenant'), { code: 'SP429' });
      const id = (await tx.query<{ id: string }>(`SELECT public_application_create($1, $2, $3, $4, $5, $6) AS id`,
        [slug, input, docJson(docs), hash, ipHash(ip, tenantId), { subject: mail.subject, body: mail.body, status }])).rows[0]!.id;
      // İşlev kiracıyı kısaltmadan yeniden çözer; araya kısaltma değişikliği girdiyse satır bu bağlamda görünmez → geri alınır.
      if ((await tx.query(`SELECT 1 FROM supplier_applications WHERE id = $1`, [id])).rowCount !== 1) {
        throw new ApiError(404, 'applications_closed', 'Başvuru şu an kabul edilmiyor.');
      }
      if (status === 'QUEUED') {
        const outbox = (await tx.query<{ id: string }>(`SELECT id FROM email_outbox WHERE related_type = 'supplier_application' AND related_id = $1 AND status = 'QUEUED'`, [id])).rows;
        for (const o of outbox) await enqueueEmailDispatch(tx, tenantId, o.id);
      }
      // Süre dolumu: doğrulanmayan başvuru 24 saat sonra işçide EXPIRED olur (iş kiracının bütün süresi geçmişlerini işaretler).
      await tx.query(`INSERT INTO jobs (tenant_id, kind, idempotency_key, payload, requested_by, run_after)
        VALUES ($1, $2, $3, $4, NULL, now() + interval '24 hours 1 minute') ON CONFLICT (tenant_id, kind, idempotency_key) DO NOTHING`,
        [tenantId, EXPIRE_JOB, `expire:${id}`, { applicationId: id }]);
    });
  } catch (err) {
    await removeObjects(deps.store, written);
    throw err;
  }
  return submitResponse(deps.channel);
}

export async function verifyApplication(pool: pg.Pool, token: unknown): Promise<{ status: 'SUBMITTED' }> {
  const hash = tokenHash(token);
  if (!hash) throw tokenInvalid();
  const r = await withoutTenant(pool, async (c) => (await c.query<{ r: { status: 'SUBMITTED' } }>(`SELECT public_application_verify($1) AS r`, [hash])).rows[0]!.r);
  return { status: r.status };
}

interface CompleteInfoRow { legalName: string; note: string | null; requestedDocuments: { code: string; name: string; expiryRequired: boolean }[]; internal: { tenantId: string; applicationId: string } }
async function completeInfoRow(pool: pg.Pool, token: unknown): Promise<CompleteInfoRow> {
  const hash = tokenHash(token);
  if (!hash) throw tokenInvalid();
  return withoutTenant(pool, async (c) => (await c.query<{ r: CompleteInfoRow }>(`SELECT public_application_complete_info($1) AS r`, [hash])).rows[0]!.r);
}

export async function completeInfo(pool: pg.Pool, token: unknown) {
  const r = await completeInfoRow(pool, token);
  return { legalName: r.legalName, note: r.note, requestedDocuments: r.requestedDocuments, limits: PUBLIC_LIMITS };
}

export async function completeApplication(deps: SubmitDeps, token: unknown, readForm: () => Promise<ApplicationForm>): Promise<{ status: 'SUBMITTED' }> {
  const info = await completeInfoRow(deps.pool, token);
  const form = await readForm();
  checkDocuments(form, info.requestedDocuments, [], info.requestedDocuments.map((d) => d.code));
  const tenantId = info.internal.tenantId;
  const docs = await prepareDocuments(form, tenantId, deps.scanner);
  const ctx = applicationSystemContext(tenantId, `public-complete-${randomUUID().slice(0, 8)}`);
  const written = await putObjects(deps.store, docs);
  let r: { status: 'SUBMITTED'; internal?: { tenantId: string } };
  try {
    r = await withTenant(deps.pool, ctx, async (tx) => {
      const out = (await tx.query<{ r: { status: 'SUBMITTED'; internal?: { tenantId: string } } }>(`SELECT public_application_complete($1, $2) AS r`,
        [tokenHash(token), docJson(docs)])).rows[0]!.r;
      // Belirteç başka kiracının başvurusuna çözülmüşse (anahtar önekiyle uyuşmaz) işlem geri alınır.
      if (out.internal?.tenantId !== tenantId) throw tokenInvalid();
      return out;
    });
  } catch (err) {
    await removeObjects(deps.store, written);
    throw err;
  }
  return { status: r.status };
}

// ---------- İşçi ----------

/** `supplier_application.submitted`: Satınalma rol görevi (doğrulama ve eksik belge tamamlamada; açık görev tekildir). */
export async function processApplicationSubmitted(pool: pg.Pool, tenantId: string, jobId: string) {
  const ctx = applicationSystemContext(tenantId, `job-${jobId}`);
  return withTenant(pool, ctx, async (tx) => {
    const appId = (await tx.query<{ payload: { applicationId?: string } }>(`SELECT payload FROM jobs WHERE id = $1`, [jobId])).rows[0]?.payload?.applicationId;
    const a = appId ? (await tx.query<{ id: string; legal_name: string; status: string }>(
      `SELECT id, legal_name, status FROM supplier_applications WHERE id = $1`, [appId])).rows[0] : undefined;
    let result: Record<string, unknown> = { skipped: 'not_found' };
    if (a && a.status === 'SUBMITTED') {
      const task = await openTask(tx, ctx, { companyId: null, departmentId: null, kind: 'supplier_application_review', entityType: 'supplier_application', entityId: a.id,
        title: 'Tedarikçi başvurusu inceleme bekliyor', reason: `${a.legal_name} başvurusu inceleme bekliyor.`,
        nextAction: 'Başvuruyu inceleyin: onaylayın, eksik belge isteyin ya da reddedin.', assigneeRole: 'PROCUREMENT', dedupeKey: `application:${a.id}:review` });
      // R5: tarama hatası olan (karantinadaki) başvuru belgesi için ayrı görev.
      const avErrors = (await tx.query<{ n: number }>(`SELECT count(*)::int AS n FROM supplier_documents WHERE application_id = $1 AND av_scan_status = 'ERROR'`, [a.id])).rows[0]!.n;
      if (avErrors > 0) {
        await openTask(tx, ctx, { companyId: null, departmentId: null, kind: 'supplier_document_av_error', entityType: 'supplier_application', entityId: a.id,
          title: 'Başvuru belgesi virüs taramasından geçemedi', reason: `${a.legal_name} başvurusunda ${avErrors} belge taranamadı ve karantinada.`,
          nextAction: 'Belgeyi tedarikçiden yeniden isteyin ya da taramayı yeniden yaptırın.', assigneeRole: 'PROCUREMENT', severity: 'HIGH', dedupeKey: `application:${a.id}:av_error` });
      }
      result = { taskId: task.id, created: task.created };
    } else if (a) result = { skipped: `status_${a.status}` };
    await tx.query(`UPDATE jobs SET status = 'SUCCEEDED', result = $2, updated_at = now() WHERE id = $1`, [jobId, result]);
    return result;
  });
}

/** `supplier_application.expire`: 24 saatte doğrulanmayan başvurular EXPIRED (satır ve dosyalar silinmez; belirteç düşer). */
export async function processApplicationExpiry(pool: pg.Pool, tenantId: string, jobId: string) {
  const ctx = applicationSystemContext(tenantId, `job-${jobId}`);
  return withTenant(pool, ctx, async (tx) => {
    const r = await tx.query(`UPDATE supplier_applications SET status = 'EXPIRED', token_hash = NULL, token_purpose = NULL, token_expires_at = NULL,
        row_version = row_version + 1 WHERE status = 'UNVERIFIED' AND token_expires_at <= now()`);
    const result = { expired: r.rowCount ?? 0 };
    await tx.query(`UPDATE jobs SET status = 'SUCCEEDED', result = $2, updated_at = now() WHERE id = $1`, [jobId, result]);
    return result;
  });
}

// ---------- Ayarlar (R3) ----------

/** R3 önerilen belge seti: başvuru ilk açıldığında (kiracıda hiç belge türü yoksa) yazılır. */
export const RECOMMENDED_DOCUMENT_TYPES = [
  { code: 'VERGI_LEVHASI', name: 'Vergi levhası', required: true, requiredCategories: [] as string[], expiryRequired: true },
  { code: 'IMZA_SIRKULERI', name: 'İmza sirküleri', required: true, requiredCategories: [] as string[], expiryRequired: false },
  { code: 'TICARET_SICIL_GAZETESI', name: 'Ticaret sicil gazetesi', required: true, requiredCategories: [] as string[], expiryRequired: false },
  { code: 'FAALIYET_BELGESI', name: 'Faaliyet belgesi', required: true, requiredCategories: [] as string[], expiryRequired: true },
  { code: 'ISO27001', name: 'ISO 27001', required: false, requiredCategories: ['Bilgi teknolojileri'], expiryRequired: true },
] as const;

/** Uç ve ekran yollarıyla karışabilecek kısaltmalar (`/basvuru/<slug>`, `/api/v1/public/applications/<slug>`). */
export const RESERVED_SLUGS = new Set(['verify', 'complete', 'complete-info', 'config', 'dogrula', 'tamamla', 'basvuru', 'admin', 'api', 'public',
  'portal', 'login', 'logout', 'auth', 'settings', 'static', 'assets', 'www', 'health', 'yonetim']);

export interface ApplicationSettings { enabled: boolean; publicSlug: string | null; publicPath: string | null; categories: string[]; updatedAt: string | null }

export async function getSettings(tx: Tx): Promise<ApplicationSettings> {
  const r = (await tx.query<{ enabled: boolean; public_slug: string | null; categories: string[]; updated_at: Date }>(
    `SELECT enabled, public_slug, categories, updated_at FROM supplier_application_settings`)).rows[0];
  if (!r) return { enabled: false, publicSlug: null, publicPath: null, categories: [], updatedAt: null };
  return { enabled: r.enabled, publicSlug: r.public_slug, publicPath: r.public_slug ? `/basvuru/${r.public_slug}` : null, categories: r.categories,
    updatedAt: r.updated_at.toISOString() };
}

function cleanCategories(list: unknown, field = 'categories'): string[] {
  if (!Array.isArray(list)) throw unprocessable('invalid_field', 'Kategoriler liste olmalı.', { field });
  const out = [...new Set(list.map((c) => (typeof c === 'string' ? c.trim() : '')))];
  if (out.some((c) => c.length < 2 || c.length > 100)) throw unprocessable('invalid_field', 'Her kategori 2–100 karakter olmalı.', { field });
  if (out.length > 50) throw unprocessable('invalid_field', 'En çok 50 kategori tanımlanabilir.', { field });
  return out;
}

export async function putSettings(tx: Tx, ctx: TenantContext, body: { enabled: boolean; publicSlug?: string | null; categories?: string[] }) {
  const before = await getSettings(tx);
  const slug = body.publicSlug === undefined ? before.publicSlug : (body.publicSlug ? body.publicSlug.trim().toLowerCase() : null);
  if (slug !== null && !/^[a-z0-9-]{3,40}$/.test(slug)) {
    throw unprocessable('invalid_slug', 'Adres kısaltması 3–40 karakter olmalı; yalnız küçük harf (a–z), rakam ve tire kullanılabilir.');
  }
  if (slug !== null && RESERVED_SLUGS.has(slug)) throw unprocessable('slug_reserved', 'Bu adres kısaltması sistemce ayrılmış; başka bir kısaltma seçin.');
  if (body.enabled && !slug) throw unprocessable('slug_required', 'Başvuruyu açmak için adres kısaltması gerekli.');
  const categories = body.categories === undefined ? before.categories : cleanCategories(body.categories);
  try {
    await tx.query(`INSERT INTO supplier_application_settings (tenant_id, enabled, public_slug, categories, updated_by, updated_at)
      VALUES ($1, $2, $3, $4, $5, now())
      ON CONFLICT (tenant_id) DO UPDATE SET enabled = EXCLUDED.enabled, public_slug = EXCLUDED.public_slug, categories = EXCLUDED.categories,
        updated_by = EXCLUDED.updated_by, updated_at = now()`, [ctx.tenantId, body.enabled, slug, categories, ctx.userId]);
  } catch (err: any) {
    if (err?.code === '23505') throw new ApiError(409, 'slug_taken', 'Bu adres kısaltması kullanılıyor; başka bir kısaltma seçin.');
    throw err;
  }
  let seeded: string[] = [];
  if (body.enabled) {
    const n = (await tx.query<{ n: number }>(`SELECT count(*)::int AS n FROM supplier_document_types`)).rows[0]!.n;
    if (n === 0) {
      for (const t of RECOMMENDED_DOCUMENT_TYPES) {
        await tx.query(`INSERT INTO supplier_document_types (tenant_id, code, name, required, required_categories, expiry_required, created_by)
          VALUES ($1,$2,$3,$4,$5,$6,$7)`, [ctx.tenantId, t.code, t.name, t.required, t.requiredCategories, t.expiryRequired, ctx.userId]);
      }
      seeded = RECOMMENDED_DOCUMENT_TYPES.map((t) => t.code);
    }
  }
  const after = await getSettings(tx);
  await audit(tx, ctx, 'supplier_application.settings_changed', 'supplier_application_settings', null,
    { before: { enabled: before.enabled, publicSlug: before.publicSlug, categories: before.categories },
      after: { enabled: after.enabled, publicSlug: after.publicSlug, categories: after.categories }, seededDocumentTypes: seeded });
  return { ...after, seededDocumentTypes: seeded };
}

const DOC_TYPE_COLS = `id, code, name, required, required_categories AS "requiredCategories", expiry_required AS "expiryRequired", active,
  created_at AS "createdAt", updated_at AS "updatedAt"`;
export interface DocumentTypeRow { id: string; code: string; name: string; required: boolean; requiredCategories: string[]; expiryRequired: boolean; active: boolean }

export async function listDocumentTypes(tx: Tx) {
  return { items: (await tx.query<DocumentTypeRow>(`SELECT ${DOC_TYPE_COLS} FROM supplier_document_types ORDER BY active DESC, name, code`)).rows };
}

function docTypeName(name: unknown) {
  const n = typeof name === 'string' ? name.trim() : '';
  if (n.length < 2 || n.length > 120) throw unprocessable('invalid_field', 'Belge türü adı 2–120 karakter olmalı.', { field: 'name' });
  return n;
}

export async function createDocumentType(tx: Tx, ctx: TenantContext, body: { code: string; name: string; required?: boolean; requiredCategories?: string[]; expiryRequired?: boolean }) {
  const code = body.code.trim();
  if (!/^[A-Za-z0-9_.-]{2,40}$/.test(code)) throw unprocessable('invalid_field', 'Kod 2–40 karakter olmalı; harf, rakam, alt çizgi, nokta ya da tire.', { field: 'code' });
  const name = docTypeName(body.name);
  const requiredCategories = cleanCategories(body.requiredCategories ?? [], 'requiredCategories');
  let row: DocumentTypeRow;
  try {
    row = (await tx.query<DocumentTypeRow>(`INSERT INTO supplier_document_types (tenant_id, code, name, required, required_categories, expiry_required, created_by)
      VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING ${DOC_TYPE_COLS}`,
      [ctx.tenantId, code, name, body.required ?? false, requiredCategories, body.expiryRequired ?? false, ctx.userId])).rows[0]!;
  } catch (err: any) {
    if (err?.code === '23505') throw new ApiError(409, 'code_taken', 'Bu kodla bir belge türü zaten var; var olan türü düzenleyin.');
    throw err;
  }
  await audit(tx, ctx, 'supplier_document_type.saved', 'supplier_document_type', row.id, { action: 'created', after: row });
  return row;
}

export async function updateDocumentType(tx: Tx, ctx: TenantContext, id: string,
  body: { name?: string; required?: boolean; requiredCategories?: string[]; expiryRequired?: boolean; active?: boolean }) {
  const before = (await tx.query<DocumentTypeRow>(`SELECT ${DOC_TYPE_COLS} FROM supplier_document_types WHERE id = $1 FOR UPDATE`, [id])).rows[0];
  if (!before) throw notFound();
  const name = body.name === undefined ? before.name : docTypeName(body.name);
  const requiredCategories = body.requiredCategories === undefined ? before.requiredCategories : cleanCategories(body.requiredCategories, 'requiredCategories');
  const row = (await tx.query<DocumentTypeRow>(`UPDATE supplier_document_types SET name = $2, required = $3, required_categories = $4, expiry_required = $5,
      active = $6, updated_at = now() WHERE id = $1 RETURNING ${DOC_TYPE_COLS}`,
    [id, name, body.required ?? before.required, requiredCategories, body.expiryRequired ?? before.expiryRequired, body.active ?? before.active])).rows[0]!;
  await audit(tx, ctx, 'supplier_document_type.saved', 'supplier_document_type', id, { action: 'updated', before, after: row });
  return row;
}
