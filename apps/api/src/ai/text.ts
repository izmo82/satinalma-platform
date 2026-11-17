import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { readZip } from '../zip.ts';

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

const XML_ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
const decodeXml = (s: string) => s.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (_, e: string) =>
  e[0] === '#' ? String.fromCodePoint(e[1]!.toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10)) : XML_ENTITIES[e.toLowerCase()]!);

/**
 * v2 Faz 4 (R7): .docx şablonunun düz metni (`word/document.xml`). Paragraf sonları `\n`, sekme `\t`, satır kırılımı `\n` olarak korunur;
 * silinmiş izli değişiklik (`w:delText`) ve alan kodu (`w:instrText`) metne girmez. ZIP ya da belge yoksa hata atar. Metin loglanmaz.
 */
export function docxText(buf: Buffer): string {
  const xml = readZip(buf).get('word/document.xml');
  if (!xml) throw new Error('word/document.xml yok');
  // Ham satır sonları XML biçimlemesidir (Word metni w:t içinde tutar); belge metnine girmez.
  return decodeXml(xml.toString('utf8').replace(/[\r\n]+/g, '')
    .replace(/<w:(delText|instrText)\b[^>]*>[\s\S]*?<\/w:\1>/g, '')
    .replace(/<w:tab\s*\/>/g, '\t')
    .replace(/<w:(br|cr)\b[^>]*\/>/g, '\n')
    .replace(/<\/w:p>|<w:p\b[^>]*\/>/g, '\n')
    .replace(/<[^>]+>/g, ''))
    .replace(/\n+$/, '');
}
