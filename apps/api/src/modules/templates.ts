import { createHash } from 'node:crypto';
import { CONTRACT_TYPES } from '@sp/domain';
import type { TenantContext, Tx } from '../db.ts';
import type { ObjectStore } from '../storage.ts';
import { objectKey } from '../storage.ts';
import { MAX_UPLOAD_BYTES } from '../files.ts';
import { audit } from '../audit.ts';
import { nextCode } from '../codes.ts';
import { ApiError, conflict, notFound, unprocessable } from '../errors.ts';

/**
 * v2 Faz 3 (R8) Görev 3: sözleşme şablon kütüphanesi. Şablon = kod + ad + tür; sürüm = .docx belgesi + geçerlilik tarihi.
 * Yeni sürüm öncekini `superseded_at` ile kapatır, hiçbir şey silinmez. Belge yolu mevcut yükleme yoludur (documents + document_versions + nesne deposu).
 */

export const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

/** .docx = ZIP + `word/document.xml`. Yalnız merkezi dizin okunur (açma yok); imza, sınır ve dosya adı denetlenir. */
export function validateDocx(filename: string, body: Buffer): void {
  const bad = (msg: string) => unprocessable('invalid_docx', msg);
  if (body.length === 0) throw bad('Dosya boş.');
  if (body.length > MAX_UPLOAD_BYTES) throw bad('Dosya 25 MB sınırını aşıyor.');
  if (!filename.toLowerCase().endsWith('.docx')) throw bad('Yalnız .docx (Word) dosyası yüklenebilir.');
  if (body.length < 22 || body.readUInt32LE(0) !== 0x04034b50) throw bad('Dosya geçerli bir .docx (ZIP) değil.');
  // Bitiş kaydı (EOCD): son 22 + en çok 65535 yorum baytı içinde aranır.
  let eocd = -1;
  for (let i = body.length - 22; i >= Math.max(0, body.length - 22 - 65535); i--) {
    if (body.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw bad('Dosya geçerli bir .docx (ZIP) değil.');
  const entries = body.readUInt16LE(eocd + 10);
  let p = body.readUInt32LE(eocd + 16);
  let found = false;
  for (let n = 0; n < entries; n++) {
    if (p + 46 > body.length || body.readUInt32LE(p) !== 0x02014b50) throw bad('ZIP dizini bozuk.');
    const nameLen = body.readUInt16LE(p + 28), extraLen = body.readUInt16LE(p + 30), commentLen = body.readUInt16LE(p + 32);
    if (p + 46 + nameLen > body.length) throw bad('ZIP dizini bozuk.');
    if (body.subarray(p + 46, p + 46 + nameLen).toString('utf8') === 'word/document.xml') { found = true; break; }
    p += 46 + nameLen + extraLen + commentLen;
  }
  if (!found) throw bad('Dosyada word/document.xml yok; geçerli bir Word belgesi değil.');
}

const isDate = (s: unknown): s is string => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(`${s}T00:00:00Z`)) && new Date(`${s}T00:00:00Z`).toISOString().slice(0, 10) === s;

/** Belge yazımı şirket kapsamlıdır (RLS WITH CHECK): şablon belgesi, çağıranın kapsamındaki ilk şirkete bağlanır. */
function uploadCompany(ctx: TenantContext): string {
  const c = ctx.companyIds[0];
  if (!c) throw unprocessable('no_company', 'Şablon yüklemek için bir şirket kapsamınız olmalı.');
  return c;
}

export interface TemplateUpload { filename: string; body: Buffer }

async function storeVersion(tx: Tx, ctx: TenantContext, store: ObjectStore, companyId: string, documentId: string, versionNo: number, up: TemplateUpload): Promise<string> {
  const sha = createHash('sha256').update(up.body).digest('hex');
  const key = objectKey(ctx.tenantId, sha);
  await tx.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`obj:${key}`]); // imha işiyle sıralı (documents.uploadDocument ile aynı)
  await store.put(key, up.body, DOCX_MIME);
  const v = await tx.query<{ id: string }>(
    `INSERT INTO document_versions (tenant_id, company_id, document_id, version_no, sha256, mime_type, size_bytes, storage_key,
       original_filename, basic_check_status, basic_check_reason, page_count, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'PASSED',NULL,NULL,$10) RETURNING id`,
    [ctx.tenantId, companyId, documentId, versionNo, sha, DOCX_MIME, up.body.length, key, up.filename.slice(0, 255), ctx.userId]);
  return v.rows[0]!.id;
}

export async function createTemplate(tx: Tx, ctx: TenantContext, store: ObjectStore,
  input: { code?: string; name?: string; contractType?: string; validFrom?: string; file: TemplateUpload | null }) {
  const code = (input.code ?? '').trim(), name = (input.name ?? '').trim();
  if (code.length < 1 || code.length > 50) throw unprocessable('validation_failed', 'Şablon kodu 1-50 karakter olmalı.');
  if (name.length < 1 || name.length > 200) throw unprocessable('validation_failed', 'Şablon adı 1-200 karakter olmalı.');
  if (!(CONTRACT_TYPES as readonly string[]).includes(input.contractType ?? '')) throw unprocessable('validation_failed', 'Geçersiz sözleşme türü.');
  if (!isDate(input.validFrom)) throw unprocessable('validation_failed', 'Geçerlilik tarihi YYYY-AA-GG olmalı.');
  if (!input.file) throw new ApiError(400, 'file_required', 'Dosya gerekli.');
  validateDocx(input.file.filename, input.file.body);

  const companyId = uploadCompany(ctx);
  const exists = await tx.query(`SELECT 1 FROM contract_templates WHERE code = $1`, [code]);
  if (exists.rowCount) throw conflict('template_exists', 'Bu kodla bir şablon zaten var; yeni sürüm eklemek için sürüm ucunu kullanın.');
  // Eşzamanlı aynı kod: kısıt ihlali tek tek 409'a çevrilir.
  let templateId: string;
  try {
    const t = await tx.query<{ id: string }>(
      `INSERT INTO contract_templates (tenant_id, code, name, contract_type, created_by) VALUES ($1,$2,$3,$4,$5) RETURNING id`,
      [ctx.tenantId, code, name, input.contractType, ctx.userId]);
    templateId = t.rows[0]!.id;
  } catch (e: any) {
    if (e?.code === '23505') throw conflict('template_exists', 'Bu kodla bir şablon zaten var; yeni sürüm eklemek için sürüm ucunu kullanın.');
    throw e;
  }
  const d = await tx.query<{ id: string }>(
    `INSERT INTO documents (tenant_id, company_id, kind, title, created_by, code) VALUES ($1,$2,'TEMPLATE',$3,$4,$5) RETURNING id`,
    [ctx.tenantId, companyId, `${code} ${name} v1`.slice(0, 200), ctx.userId, await nextCode(tx, ctx, 'document', 'BLG')]);
  const dvId = await storeVersion(tx, ctx, store, companyId, d.rows[0]!.id, 1, input.file);
  const tv = await tx.query<{ id: string }>(
    `INSERT INTO contract_template_versions (tenant_id, template_id, version_no, document_version_id, valid_from, uploaded_by) VALUES ($1,$2,1,$3,$4,$5) RETURNING id`,
    [ctx.tenantId, templateId, dvId, input.validFrom, ctx.userId]);
  await audit(tx, ctx, 'template.created', 'contract_template', templateId, { code, name, contractType: input.contractType, versionId: tv.rows[0]!.id, versionNo: 1, validFrom: input.validFrom });
  return { id: templateId, code, name, contractType: input.contractType!, versionId: tv.rows[0]!.id, versionNo: 1 };
}

export async function addTemplateVersion(tx: Tx, ctx: TenantContext, store: ObjectStore, templateId: string,
  input: { validFrom?: string; file: TemplateUpload | null }) {
  if (!isDate(input.validFrom)) throw unprocessable('validation_failed', 'Geçerlilik tarihi YYYY-AA-GG olmalı.');
  if (!input.file) throw new ApiError(400, 'file_required', 'Dosya gerekli.');
  validateDocx(input.file.filename, input.file.body);
  const t = await tx.query<{ id: string; code: string; name: string }>(`SELECT id, code, name FROM contract_templates WHERE id = $1`, [templateId]);
  if (!t.rows[0]) throw notFound();

  const companyId = uploadCompany(ctx);
  await tx.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`tpl:${templateId}`]);
  // Önceki sürümün belgesi başka şirketteki yükleyiciye RLS ile kapalı olabilir: bilgi kapıdan (app_template_file) okunur.
  const last = (await tx.query<{ version_no: number }>(
    `SELECT tv.version_no FROM contract_template_versions tv JOIN LATERAL app_template_file(tv.id) f ON true
     WHERE tv.template_id = $1 ORDER BY tv.version_no DESC LIMIT 1`, [templateId])).rows[0];
  if (!last) throw notFound();
  const sha = createHash('sha256').update(input.file.body).digest('hex');
  const same = await tx.query(`SELECT 1 FROM contract_template_versions tv JOIN LATERAL app_template_file(tv.id) f ON true WHERE tv.template_id = $1 AND f.sha256 = $2`, [templateId, sha]);
  if (same.rowCount) throw conflict('template_version_duplicate', 'Bu dosya bu şablonun mevcut bir sürümüyle aynı; değişiklik yok.');
  const versionNo = last.version_no + 1;
  // Her şablon sürümü yükleyenin şirketinde kendi belgesidir (belge ve sürümü aynı şirkette; saklama/imha tutarlı).
  const d = await tx.query<{ id: string }>(
    `INSERT INTO documents (tenant_id, company_id, kind, title, created_by, code) VALUES ($1,$2,'TEMPLATE',$3,$4,$5) RETURNING id`,
    [ctx.tenantId, companyId, `${t.rows[0]!.code} ${t.rows[0]!.name} v${versionNo}`.slice(0, 200), ctx.userId, await nextCode(tx, ctx, 'document', 'BLG')]);
  const dvId = await storeVersion(tx, ctx, store, companyId, d.rows[0]!.id, 1, input.file);
  const closed = await tx.query(`UPDATE contract_template_versions SET superseded_at = now() WHERE template_id = $1 AND superseded_at IS NULL RETURNING id`, [templateId]);
  const tv = await tx.query<{ id: string }>(
    `INSERT INTO contract_template_versions (tenant_id, template_id, version_no, document_version_id, valid_from, uploaded_by) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
    [ctx.tenantId, templateId, versionNo, dvId, input.validFrom, ctx.userId]);
  await audit(tx, ctx, 'template.version_added', 'contract_template', templateId,
    { versionId: tv.rows[0]!.id, versionNo, validFrom: input.validFrom, supersededVersionIds: closed.rows.map((r: { id: string }) => r.id) });
  return { id: templateId, versionId: tv.rows[0]!.id, versionNo };
}

export async function listTemplates(tx: Tx) {
  const rows = (await tx.query<any>(
    `SELECT t.id, t.code, t.name, t.contract_type AS "contractType", t.created_at AS "createdAt",
            tv.id AS "versionId", tv.version_no AS "versionNo", tv.valid_from::text AS "validFrom", tv.superseded_at AS "supersededAt", tv.created_at AS "uploadedAt",
            u.display_name AS "uploadedBy", f.original_filename AS filename, f.size_bytes AS "sizeBytes",
            (SELECT count(*)::int FROM contract_families cf WHERE cf.template_version_id = tv.id) AS "versionUsage"
     FROM contract_templates t
     JOIN contract_template_versions tv ON tv.template_id = t.id
     JOIN LATERAL app_template_file(tv.id) f ON true
     JOIN users u ON u.id = tv.uploaded_by
     ORDER BY t.code, tv.version_no DESC`)).rows;
  const byId = new Map<string, any>();
  for (const r of rows) {
    let t = byId.get(r.id);
    if (!t) { t = { id: r.id, code: r.code, name: r.name, contractType: r.contractType, createdAt: r.createdAt, currentVersion: null, versions: [], usageCount: 0 }; byId.set(r.id, t); }
    const v = { id: r.versionId, versionNo: r.versionNo, validFrom: r.validFrom, supersededAt: r.supersededAt, uploadedAt: r.uploadedAt, uploadedBy: r.uploadedBy,
      filename: r.filename, sizeBytes: Number(r.sizeBytes), usageCount: r.versionUsage };
    t.versions.push(v);
    t.usageCount += r.versionUsage;
    if (!r.supersededAt) t.currentVersion = v;
  }
  return { items: [...byId.values()] };
}

export async function templateDownload(tx: Tx, ctx: TenantContext, versionId: string) {
  const r = (await tx.query<{ storage_key: string; original_filename: string; mime_type: string; disposed: boolean }>(
    `SELECT * FROM app_template_file($1)`, [versionId])).rows[0];
  if (!r) throw notFound();
  if (r.disposed) throw new ApiError(410, 'disposed', 'Belge saklama süresi sonunda imha edildi; baytlar artık yok.');
  await audit(tx, ctx, 'template.downloaded', 'contract_template_version', versionId, {});
  return { key: r.storage_key, filename: r.original_filename, mimeType: r.mime_type };
}
