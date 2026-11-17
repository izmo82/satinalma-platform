import type { ContractAiField, FindingSeverity, ReviewCategory } from '@sp/domain';
import type { AiInput, AiProvider, AiResult } from './provider.ts';

/**
 * v2 Faz 4 (R1, R13) test sağlayıcısı `test-fixture`: ağ yok, ücret yok (tarife "test tarifesi"), deterministik.
 * Sentetik sözleşmelerdeki etiketli satırları ("Sözleşme Bedeli:", "Başlangıç Tarihi:", "Yüklenici VKN:" …) okur; inceleme için şablon
 * başlıklarını sözleşmede arar; kanıt soruları için anahtar kelime eşleştirir. Çıktısı GERÇEK OKUMA DEĞİLDİR ve her ekranda
 * "Test sağlayıcısı — gerçek değil" etiketiyle gösterilir. Üretimde kaydedilemez (registerAiProvider + loadAi).
 * Belgedeki talimatları uygulamaz: yalnız şema anahtarları döner.
 */
export const TEST_PROVIDER_NAME = 'test-fixture';
export const TEST_PROVIDER_LABEL = 'Test sağlayıcısı — gerçek değil';
export const isTestProvider = (name: string | null | undefined) => !!name && name.startsWith('test-');

const TOKENS = { input: 1000, output: 200 };

/** Türkçe harfleri ASCII karşılığıyla aynı kabul eden düzenli ifade parçası (sentetik PDF'ler aksanları düşürür). */
const LETTER: Record<string, string> = { c: '[cçÇC]', g: '[gğĞG]', i: '[iıİI]', o: '[oöÖO]', s: '[sşŞS]', u: '[uüÜU]' };
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const fold = (s: string) => s.replace(/[İI]/g, 'i').replace(/ı/g, 'i').toLocaleLowerCase('tr-TR').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/\s+/g, ' ').trim();
function looseRe(label: string): string {
  return [...fold(label)].map((ch) => LETTER[ch] ?? (ch === ' ' ? '\\s+' : esc(ch))).join('');
}

/** Etiket → alan(lar). Aynı alanın birden fazla etiketi olabilir (ör. Yüklenici/Tedarikçi VKN). */
const LABELS: { label: string; fields: ContractAiField[] }[] = [
  { label: 'Sözleşme Başlığı', fields: ['title'] },
  { label: 'Sözleşme Türü', fields: ['contractType'] },
  { label: 'Sözleşme No', fields: ['contractNo'] },
  { label: 'Tedarikçi Unvanı', fields: ['supplierName'] },
  { label: 'Yüklenici VKN', fields: ['supplierVkn'] },
  { label: 'Tedarikçi VKN', fields: ['supplierVkn'] },
  { label: 'İmza Tarihi', fields: ['signedOn'] },
  { label: 'Başlangıç Tarihi', fields: ['startDate'] },
  { label: 'Bitiş Tarihi', fields: ['endDate'] },
  { label: 'Süre', fields: ['indefinite'] },
  { label: 'İhbar Süresi', fields: ['noticePeriodDays'] },
  { label: 'Sözleşme Bedeli', fields: ['amount', 'currency'] },
  { label: 'Limit Esası', fields: ['limitBasis'] },
  { label: 'Yenileme', fields: ['autoRenewal'] },
  { label: 'Ödeme Vadesi', fields: ['paymentTermDays'] },
  { label: 'Teminat', fields: ['guarantee'] },
  { label: 'Cezai Şart', fields: ['slaPenalty'] },
  { label: 'KVKK', fields: ['kvkkClause'] },
  { label: 'Yetkili Mahkeme', fields: ['governingCourt'] },
  { label: 'Fiyat Farkı', fields: ['priceEscalation'] },
];
// Uzun etiket önce: "İhbar Süresi" "Süre"den, "Sözleşme Bedeli" diğerlerinden önce eşleşsin.
const LABEL_RE = new RegExp(`(?<![\\p{L}\\p{N}])(${[...LABELS].sort((a, b) => b.label.length - a.label.length).map((l) => looseRe(l.label)).join('|')})\\s*:`, 'giu');

const CONTRACT_TYPE_KW: [RegExp, string][] = [
  [/hizmet/, 'SERVICE'], [/donanim|cihaz|ekipman/, 'HARDWARE'], [/bakim|destek/, 'MAINTENANCE'], [/gizlilik/, 'NDA'], [/danismanlik/, 'CONSULTING'],
];
/** Değer ve ham metindeki bitişi (alıntı değerden sonra kesilir; ardından gelen ilgisiz metin alıntıya girmez). */
function fieldValue(field: ContractAiField, raw: string): { value: string; end: number } | null {
  const f = fold(raw);
  const at = (m: RegExpExecArray | null, v?: string) => (m ? { value: v ?? m[0], end: m.index + m[0].length } : null);
  const whole = (v: string | null) => (v === null ? null : { value: v, end: raw.length });
  switch (field) {
    case 'amount': { const m = /\d[\d.,]*\d(?:\s*(?:TRY|TL|USD|EUR|GBP)\b)?/i.exec(raw); return m ? { value: /\d[\d.,]*\d/.exec(m[0])![0], end: m.index + m[0].length } : null; }
    case 'currency': { const m = /\b(TRY|TL|USD|EUR|GBP)\b/i.exec(raw); return at(m, m?.[1]?.toUpperCase()); }
    case 'noticePeriodDays': case 'paymentTermDays': { const m = /(\d{1,4})(?:\s*g[uü]n)?/i.exec(raw); return at(m, m?.[1]); }
    case 'signedOn': case 'startDate': case 'endDate': return at(/\d{1,2}[./]\d{1,2}[./]\d{4}|\d{4}-\d{2}-\d{2}/.exec(raw));
    case 'supplierVkn': return at(/\d[\d\s.-]{8,14}\d/.exec(raw));
    case 'contractType': return whole(CONTRACT_TYPE_KW.find(([re]) => re.test(f))?.[1] ?? 'OTHER');
    case 'limitBasis': return whole(/haric|kdv'?siz/.test(f) ? 'NET' : /dahil/.test(f) ? 'GROSS' : null);
    case 'autoRenewal': return whole(/yenilenmez|yenilenmeyecek|yenileme yok/.test(f) ? 'false' : /yenilen/.test(f) ? 'true' : null);
    case 'indefinite': return whole(/belirsiz sureli|suresiz/.test(f) ? 'true' : /belirli sure/.test(f) ? 'false' : null);
    default: return whole(raw.trim() || null);
  }
}

function extract(pages: string[]) {
  const fields: { name: ContractAiField; value: string | null; page: number | null; evidence: string | null; confidence: number }[] = [];
  const seen = new Set<string>();
  pages.forEach((text, i) => {
    const hits = [...text.matchAll(LABEL_RE)];
    hits.forEach((m, k) => {
      const start = m.index!;
      const valueStart = start + m[0].length;
      let end = k + 1 < hits.length ? hits[k + 1]!.index! : text.length;
      const nl = text.indexOf('\n', valueStart);
      if (nl >= 0 && nl < end) end = nl;
      end = Math.min(end, valueStart + 200);
      const raw = text.slice(valueStart, end);
      const label = LABELS.find((l) => new RegExp(`^${looseRe(l.label)}$`, 'iu').test(m[1]!.trim()));
      for (const name of label?.fields ?? []) {
        if (seen.has(name)) continue; // ilk etiket geçerli (deterministik)
        const v = fieldValue(name, raw);
        if (v === null) continue;
        seen.add(name);
        fields.push({ name, value: v.value.trim(), page: i + 1, evidence: text.slice(start, valueStart + v.end).trim(), confidence: 0.9 });
      }
    });
  });
  return { fields };
}

const CATEGORY_KW: [RegExp, ReviewCategory][] = [
  [/fesih/, 'TERMINATION'], [/gizlilik|kvkk|kisisel veri/, 'CONFIDENTIALITY'], [/mahkeme|uyusmazlik/, 'JURISDICTION'], [/mucbir/, 'FORCE_MAJEURE'],
  [/odeme|bedel/, 'PAYMENT'], [/ceza/, 'PENALTY'], [/sorumluluk/, 'LIABILITY'], [/fikri|telif/, 'IP'], [/sure|yenileme/, 'TERM_RENEWAL'],
  [/degisiklik/, 'UNILATERAL_CHANGE'],
];
const categoryOf = (title: string): ReviewCategory => CATEGORY_KW.find(([re]) => re.test(fold(title)))?.[1] ?? 'TEMPLATE';

/** Deterministik risk ifadeleri: sözleşme sayfasında geçerse alıntılı bulgu. */
const RISKS: { phrase: string; category: ReviewCategory; severity: FindingSeverity; title: string }[] = [
  { phrase: 'tek taraflı', category: 'UNILATERAL_CHANGE', severity: 'MEDIUM', title: 'Tek taraflı değişiklik hakkı' },
  { phrase: 'sınırsız sorumluluk', category: 'LIABILITY', severity: 'HIGH', title: 'Sınırsız sorumluluk' },
  { phrase: 'cezai şart', category: 'PENALTY', severity: 'LOW', title: 'Cezai şart hükmü' },
];

/** Eşleşmenin içinde bulunduğu cümle (özgün metinden, birebir). */
function sentenceAt(text: string, index: number, len: number): string {
  let s = index; while (s > 0 && !/[.;:\n]/.test(text[s - 1]!)) s--;
  let e = index + len; while (e < text.length && !/[.;\n]/.test(text[e]!)) e++;
  return text.slice(s, Math.min(e + 1, text.length)).replace(/^[\s.;:]+/, '').trim().slice(0, 300).trim();
}

function review(pages: string[], templateText: string | null) {
  const findings: Record<string, unknown>[] = [];
  const contract = fold(pages.join(' '));
  if (templateText) {
    for (const para of templateText.split('\n').map((p) => p.trim()).filter(Boolean)) {
      const m = /^madde\s+\d+\s*[-–—:.]\s*(.+)$/iu.exec(para);
      if (!m) continue;
      const title = m[1]!.trim();
      if (contract.includes(fold(title))) continue;
      findings.push({ category: categoryOf(title), kind: 'MISSING_CLAUSE', severity: 'MEDIUM', title: `Şablon maddesi sözleşmede yok: ${title}`, quote: para, page: null,
        templateRef: para, recommendation: 'Şablondaki maddeyi sözleşmeye ekleyin ya da yokluğunu gerekçelendirin.' });
    }
  }
  pages.forEach((text, i) => {
    for (const r of RISKS) {
      const m = new RegExp(looseRe(r.phrase), 'iu').exec(text);
      if (!m) continue;
      findings.push({ category: r.category, kind: 'LEGAL_RISK', severity: r.severity, title: r.title, quote: sentenceAt(text, m.index, m[0].length), page: i + 1,
        templateRef: null, recommendation: 'Hükmü hukuk birimiyle gözden geçirin.' });
    }
  });
  const missing = findings.filter((f) => f.kind === 'MISSING_CLAUSE').length;
  const summary = `${TEST_PROVIDER_LABEL}: ${templateText ? `şablondaki ${missing} madde sözleşmede bulunamadı` : 'şablon yok'}; ${findings.length - missing} risk ifadesi bulundu.`;
  return { findings, summary };
}

const STOP = new Set(['mi', 'mı', 'mu', 'mü', 've', 'ile', 'bir', 'var', 'icin', 'olarak', 'veya', 'midir', 'mudur']);
function evidence(pages: string[], questions: { id: string; text: string }[]) {
  const answers = questions.map((q) => {
    const kws = [...new Set(fold(q.text).replace(/[^\p{L}\p{N}\s]/gu, ' ').split(' ').filter((w) => w.length >= 4 && !STOP.has(w)))]
      .map((w) => w.slice(0, Math.max(4, w.length - 2))); // basit kök: ek farkları tolere edilir
    const need = Math.min(2, kws.length);
    for (let i = 0; i < pages.length && need > 0; i++) {
      const sentences = pages[i]!.split(/(?<=[.;])\s+/);
      for (const s of sentences) {
        const f = fold(s);
        if (kws.filter((k) => f.includes(k)).length < need) continue;
        const neg = /\b(degil|yok|saglanmaz|verilmez|bulunmaz)\b/.test(f);
        return { questionId: q.id, answer: neg ? 'NO' : 'YES', quote: s.trim(), page: i + 1, explanation: `${TEST_PROVIDER_LABEL}: anahtar kelime eşleşmesi.` };
      }
    }
    return { questionId: q.id, answer: 'UNCLEAR', quote: null, page: null, explanation: `${TEST_PROVIDER_LABEL}: belgede eşleşme bulunamadı.` };
  });
  return { answers };
}

export function testFixtureProvider(): AiProvider {
  return {
    name: TEST_PROVIDER_NAME,
    async run(_modelId: string, input: AiInput): Promise<AiResult> {
      const pages = input.pages;
      let output: unknown;
      if (input.task === 'AI06') output = extract(pages);
      else if (input.task === 'AI14') output = review(pages, input.templateText ?? null);
      else if (input.task === 'AI15') output = evidence(pages, input.questions ?? []);
      else throw new Error(`${input.task} görevi test sağlayıcısında desteklenmiyor`);
      const usage = { inputTokens: TOKENS.input, outputTokens: TOKENS.output, pages: input.document?.pageCount ?? pages.length };
      return { output, usage, actualCost: null, model: TEST_PROVIDER_NAME };
    },
  };
}
