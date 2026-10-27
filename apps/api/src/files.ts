import { createHash } from 'node:crypto';

export const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;

const ALLOWED: Record<string, { ext: string[]; magic: (b: Buffer) => boolean }> = {
  'application/pdf': { ext: ['pdf'], magic: (b) => b.subarray(0, 5).toString('latin1') === '%PDF-' },
  'image/png': { ext: ['png'], magic: (b) => b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) },
  'image/jpeg': { ext: ['jpg', 'jpeg'], magic: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  'application/xml': { ext: ['xml'], magic: (b) => /^\s*(<\?xml|<)/.test(b.subarray(0, 64).toString('utf8').replace(/^﻿/, '')) },
};

export interface InspectedFile {
  sha256: string;
  mimeType: string;
  sizeBytes: number;
  status: 'PASSED' | 'QUARANTINED';
  reason: string | null;
  pageCount: number | null;
}

/**
 * Yerleşik, sınırlı kontroller: uzantı+bildirilen tip+sihirli bayt eşleşmesi, boyut, PDF aktif içerik,
 * XML DTD/varlık (XXE/billion laughs). Gerçek antivirüs taraması değildir (av_scan_status ayrı).
 */
export function inspectUpload(filename: string, declaredMime: string, body: Buffer): InspectedFile | { rejected: string } {
  if (body.length === 0) return { rejected: 'Dosya boş.' };
  if (body.length > MAX_UPLOAD_BYTES) return { rejected: 'Dosya 25 MB sınırını aşıyor.' };
  const ext = filename.toLowerCase().split('.').pop() ?? '';
  const mime = declaredMime === 'text/xml' ? 'application/xml' : declaredMime;
  const rule = ALLOWED[mime];
  if (!rule || !rule.ext.includes(ext)) return { rejected: 'Desteklenmeyen dosya türü. PDF, PNG, JPEG veya XML yükleyin.' };
  if (!rule.magic(body)) return { rejected: 'Dosya içeriği uzantısıyla uyuşmuyor.' };

  const sha256 = createHash('sha256').update(body).digest('hex');
  let status: InspectedFile['status'] = 'PASSED';
  let reason: string | null = null;
  let pageCount: number | null = null;

  if (mime === 'application/pdf') {
    const text = body.toString('latin1');
    if (/\/(JavaScript|JS|Launch|EmbeddedFile|RichMedia|XFA)\b/.test(text)) {
      status = 'QUARANTINED';
      reason = 'PDF aktif içerik veya gömülü dosya içeriyor.';
    }
    if (/\/Encrypt\b/.test(text)) {
      status = 'QUARANTINED';
      reason = 'PDF şifreli; içerik kontrol edilemiyor.';
    }
    const pages = text.match(/\/Type\s*\/Page(?!s)/g);
    pageCount = pages ? Math.min(pages.length, 5000) : null;
  }
  if (mime === 'application/xml') {
    const head = body.subarray(0, 4096).toString('utf8');
    if (/<!DOCTYPE|<!ENTITY/i.test(head) || /<!ENTITY/i.test(body.toString('utf8'))) {
      status = 'QUARANTINED';
      reason = 'XML DTD/ENTITY içeriyor; güvenlik nedeniyle işlenmiyor.';
    }
  }
  if (mime.startsWith('image/')) pageCount = 1;
  return { sha256, mimeType: mime, sizeBytes: body.length, status, reason, pageCount };
}
