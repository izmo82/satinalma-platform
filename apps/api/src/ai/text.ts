import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';

// Gömülü olmayan standart yazı tipleri (Helvetica vb.) için pdf.js veri dizini; metin çıkarımında uyarı/eksik glif olmaz.
const standardFontDataUrl = `${dirname(fileURLToPath(import.meta.resolve('pdfjs-dist/package.json')))}/standard_fonts/`;

/**
 * Belgenin sayfa metinleri (AI kanıtının sunucuda doğrulanması için). PDF gömülü metni okunur; taranmış PDF'te metin yoksa
 * boş sayfa döner (OCR bu sürümde bağlı değil). Metin loglanmaz.
 */
export async function pageTexts(body: Buffer, mimeType: string): Promise<string[]> {
  if (mimeType === 'application/pdf') {
    const task = getDocument({ data: new Uint8Array(body), enableXfa: false, disableFontFace: true, standardFontDataUrl });
    const doc = await task.promise;
    try {
      const out: string[] = [];
      for (let i = 1; i <= doc.numPages; i++) {
        const c = await (await doc.getPage(i)).getTextContent();
        out.push(c.items.map((x) => ('str' in x ? x.str : '')).join(' '));
      }
      return out;
    } finally { await task.destroy(); }
  }
  if (mimeType === 'application/xml' || mimeType.startsWith('text/')) return [body.toString('utf8')];
  return [];
}
