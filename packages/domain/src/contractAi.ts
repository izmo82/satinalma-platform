// v2 Faz 4: sözleşme yapay zekâ okuma denetimi, inceleme puanı ve kanıt okuma denetimi. Saf ve deterministik.
// Model çıktısı veridir: güveni, puanı ve kararı KOD belirler; modelin döndürdüğü puan/onay/eylem anahtarları yok sayılır.
// Para decimal string'dir; kayan nokta yalnız doğruluk oranında (para değil) kullanılır.
import { CONTRACT_TYPES } from './contractV2.ts';
import { normalizeTaxId } from './taxId.ts';

export const AI_DISCLAIMER = 'Yapay zekâ ön incelemesidir, hukuki görüş değildir.';

// ---------------------------------------------------------------- alan okuma (R4/R5)
export const CONTRACT_AI_FIELDS = [
  'title', 'contractType', 'supplierName', 'supplierVkn', 'signedOn', 'startDate', 'endDate', 'indefinite', 'noticePeriodDays',
  'amount', 'currency', 'limitBasis', 'autoRenewal', 'contractNo', 'paymentTermDays', 'guarantee', 'slaPenalty', 'kvkkClause',
  'governingCourt', 'priceEscalation',
] as const;
export type ContractAiField = (typeof CONTRACT_AI_FIELDS)[number];
export type FieldKind = 'date' | 'money' | 'vkn' | 'currency' | 'enum' | 'int' | 'bool' | 'text';

export const FIELD_KIND: Record<ContractAiField, FieldKind> = {
  title: 'text', contractType: 'enum', supplierName: 'text', supplierVkn: 'vkn', signedOn: 'date', startDate: 'date', endDate: 'date',
  indefinite: 'bool', noticePeriodDays: 'int', amount: 'money', currency: 'currency', limitBasis: 'enum', autoRenewal: 'bool',
  contractNo: 'text', paymentTermDays: 'int', guarantee: 'text', slaPenalty: 'text', kvkkClause: 'text', governingCourt: 'text', priceEscalation: 'text',
};

/** R5: her güvende insan eylemi şart; forma önceden yazılmaz. */
export const CRITICAL_AI_FIELDS: readonly ContractAiField[] = ['amount', 'currency', 'signedOn', 'startDate', 'endDate', 'supplierVkn'];

export const AI_FIELD_TR: Record<ContractAiField, string> = {
  title: 'Sözleşme başlığı', contractType: 'Sözleşme türü', supplierName: 'Tedarikçi adı', supplierVkn: 'Tedarikçi VKN', signedOn: 'İmza tarihi',
  startDate: 'Başlangıç tarihi', endDate: 'Bitiş tarihi', indefinite: 'Süresiz', noticePeriodDays: 'İhbar süresi (gün)', amount: 'Tutar',
  currency: 'Para birimi', limitBasis: 'Limit esası (KDV dahil/hariç)', autoRenewal: 'Otomatik yenileme', contractNo: 'Sözleşme numarası',
  paymentTermDays: 'Ödeme vadesi (gün)', guarantee: 'Teminat', slaPenalty: 'SLA / cezai şart', kvkkClause: 'KVKK maddesi',
  governingCourt: 'Yetkili mahkeme', priceEscalation: 'Fiyat farkı / artış',
};

export type AiConfidence = 'HIGH' | 'MEDIUM' | 'LOW' | 'MISSING';
export interface CheckedContractField {
  field: ContractAiField; value: string | null; page: number | null; evidence: string | null;
  confidence: AiConfidence; flags: string[]; requiresHuman: boolean; prefill: boolean;
}

const norm = (s: string) => s.replace(/\s+/g, ' ').trim().toLocaleLowerCase('tr-TR');
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const containsToken = (hay: string, needle: string) => new RegExp(`(?<![\\p{L}\\p{N}])${esc(needle)}(?![\\p{L}\\p{N}])`, 'u').test(hay);

const MONTHS: Record<string, number> = {
  ocak: 1, şubat: 2, mart: 3, nisan: 4, mayıs: 5, haziran: 6, temmuz: 7, ağustos: 8, eylül: 9, ekim: 10, kasım: 11, aralık: 12,
};
function isoDate(y: number, m: number, d: number): string | null {
  if (!Number.isInteger(y) || y < 1900 || y > 2200 || m < 1 || m > 12 || d < 1) return null;
  const dim = new Date(Date.UTC(y, m, 0)).getUTCDate();
  if (d > dim) return null;
  return `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}
/** "31 Aralık 2028", "31.12.2028", "31/12/2028", "2028-12-31" → "2028-12-31"; tam eşleşme, geçersiz takvim günü null. */
export function parseTrDate(s: string): string | null {
  const t = s.trim().toLocaleLowerCase('tr-TR');
  let m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(t);
  if (m) return isoDate(+m[1]!, +m[2]!, +m[3]!);
  m = /^(\d{1,2})[./](\d{1,2})[./](\d{4})$/.exec(t);
  if (m) return isoDate(+m[3]!, +m[2]!, +m[1]!);
  m = /^(\d{1,2})\s+(\p{L}+)\s+(\d{4})$/u.exec(t);
  if (m && MONTHS[m[2]!] !== undefined) return isoDate(+m[3]!, MONTHS[m[2]!]!, +m[1]!);
  return null;
}
function findDates(text: string): string[] {
  const out: string[] = [];
  const t = text.toLocaleLowerCase('tr-TR');
  for (const re of [/(?<![\d-])\d{4}-\d{2}-\d{2}(?!\d)/g, /(?<![\d./])\d{1,2}[./]\d{1,2}[./]\d{4}(?!\d)/g, /(?<![\d./])\d{1,2}\s+\p{L}+\s+\d{4}(?!\d)/gu]) {
    for (const m of t.matchAll(re)) { const d = parseTrDate(m[0]); if (d) out.push(d); }
  }
  return out;
}

/** "1.250.000,00 TL" → "1250000.00". Kayan nokta yok; belirsiz biçim ve negatif null. */
export function parseTrAmount(s: string): string | null {
  const t = s.replace(/(?:TRY|TL|USD|EUR|GBP|₺|\$|€|£)/gi, '').replace(/\s+/g, '');
  let intPart: string; let frac = '';
  let m: RegExpExecArray | null;
  if ((m = /^(\d{1,3}(?:\.\d{3})+)(?:,(\d+))?$/.exec(t))) { intPart = m[1]!.replace(/\./g, ''); frac = m[2] ?? ''; }
  else if ((m = /^(\d{1,3}(?:,\d{3})+)(?:\.(\d+))?$/.exec(t))) {
    if (/^\d{1,3},\d{3}$/.test(t)) return null; // "1,250": binlik mi ondalık mı belirsiz
    intPart = m[1]!.replace(/,/g, ''); frac = m[2] ?? '';
  }
  else if ((m = /^(\d+)(?:[,.](\d+))?$/.exec(t))) { intPart = m[1]!; frac = m[2] ?? ''; }
  else return null;
  if (frac.length > 2) return null; // kuruştan ince ya da belirsiz biçim
  intPart = intPart.replace(/^0+(?=\d)/, '');
  return `${intPart}.${frac.padEnd(2, '0')}`;
}
function findAmounts(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(/\d+(?:[.,]\d+)*/g)) { const a = parseTrAmount(m[0]); if (a) out.push(a); }
  return out;
}

const CURRENCIES: Record<string, string[]> = {
  TRY: ['try', 'tl', '₺', 'türk lirası'], USD: ['usd', '$', 'abd doları', 'dolar'], EUR: ['eur', '€', 'euro'], GBP: ['gbp', '£', 'sterlin'],
};
function normCurrency(v: string): string | null {
  const t = v.trim().toLocaleLowerCase('tr-TR');
  for (const [code, al] of Object.entries(CURRENCIES)) if (al.includes(t)) return code;
  return /^[a-z]{3}$/.test(t) ? t.toUpperCase() : null; // ISO 4217 biçimi; kodun alıntıda aynen geçmesi derivable'da aranır
}
const ENUMS: Partial<Record<ContractAiField, readonly string[]>> = { contractType: CONTRACT_TYPES, limitBasis: ['NET', 'GROSS'] };

/** Alanı türüne göre normalleştirir; olmazsa null. */
function normalizeValue(field: ContractAiField, raw: string): string | null {
  switch (FIELD_KIND[field]) {
    case 'date': return parseTrDate(raw);
    case 'money': return parseTrAmount(raw);
    case 'vkn': { const r = normalizeTaxId('TR', 'VKN', raw); return r.ok ? r.normalized : null; }
    case 'currency': return normCurrency(raw);
    case 'enum': { const u = raw.trim().toUpperCase(); return ENUMS[field]!.includes(u) ? u : null; }
    case 'int': return /^\d{1,4}$/.test(raw.trim()) ? String(Number(raw.trim())) : null;
    case 'bool': { const t = raw.trim().toLowerCase(); return t === 'true' ? 'true' : t === 'false' ? 'false' : null; }
    case 'text': return raw.trim() || null;
  }
}
/** Normalleştirilmiş değer, alıntıdan türetilebiliyor mu (tr-TR ayrıştırıcıyla)? Sıralı/enum/bool alanlar yalnız alıntı varlığına bağlıdır. */
function derivable(field: ContractAiField, value: string, evidence: string): boolean {
  switch (FIELD_KIND[field]) {
    case 'date': return findDates(evidence).includes(value);
    case 'money': return findAmounts(evidence).includes(value);
    case 'vkn': return containsToken(evidence.replace(/[\s.\-]/g, ''), value);
    case 'currency': { const e = evidence.toLocaleLowerCase('tr-TR'); return containsToken(e, value.toLowerCase()) || (CURRENCIES[value] ?? []).some((a) => (/^[\p{L}\s]+$/u.test(a) ? containsToken(e, a) : e.includes(a))); }
    case 'int': return containsToken(norm(evidence), value);
    case 'text': return norm(evidence).includes(norm(value));
    case 'bool': case 'enum': return keywordDerived(field, value, evidence);
  }
}
const KW = (...w: string[]) => new RegExp(w.join('|'), 'u');
const KEYWORDS: Partial<Record<ContractAiField, Record<string, RegExp>>> = {
  autoRenewal: { false: KW('yenilenmez', 'otomatik\\s+yenileme\\s+(?:yok|yapılmaz)', 'otomatik\\s+olarak\\s+yenilenmez'), true: KW('otomatik(?:\\s+olarak)?\\s+yenilen') },
  indefinite: { true: KW('süresiz', 'belirsiz\\s+süreli'), false: KW('belirli\\s+süre') },
  limitBasis: { NET: KW('kdv\\s+hariç', "kdv'?siz"), GROSS: KW('kdv\\s+dahil') },
  contractType: { SERVICE: KW('hizmet'), HARDWARE: KW('donanım', 'cihaz', 'ekipman'), MAINTENANCE: KW('bakım', 'destek'), NDA: KW('gizlilik'), CONSULTING: KW('danışmanlık') },
};
const NEGATION = /değil\p{L}*|yok\p{L}*|yapılmaz|olmaz|\p{L}+m[ae]y[ae]cek\p{L}*|\p{L}+m[ae]mekte\p{L}*|yenilen(?:me|mi)\p{L}*/u;
/** Değerin tam olarak o olumsuz kalıptan türetilebildiği tek durumlar (false / NET). */
const NEGATED_OK: Partial<Record<ContractAiField, Record<string, RegExp>>> = {
  autoRenewal: { false: /yenilenmez|otomatik\s+yenileme\s+(?:yok|yapılmaz)/gu },
  limitBasis: { NET: /kdv\s+dahil\s+değil\p{L}*/gu },
};
/**
 * bool/enum değeri alıntıdaki anahtar sözcükle uyuşmalı. Olumsuzluk işareti içeren alıntı, değer tam o olumsuz kalıptan
 * (false/NET) çıkmıyorsa türetilemez sayılır; emin değilsek UNDERIVABLE.
 */
function keywordDerived(field: ContractAiField, value: string, evidence: string): boolean {
  const kw = KEYWORDS[field];
  if (!kw) return false; // OTHER gibi anahtarı olmayan değer insan seçer
  let e = norm(evidence);
  const neg = NEGATED_OK[field]?.[value];
  const viaNeg = !!neg && new RegExp(neg.source, 'u').test(e);
  if (neg && viaNeg) e = e.replace(neg, ' ');
  if (NEGATION.test(e)) return false;
  const hits = new Set(Object.keys(kw).filter((k) => kw[k]!.test(e)));
  if (viaNeg) hits.add(value);
  return hits.size === 1 && hits.has(value);
}
const confOf = (c: unknown): AiConfidence => (typeof c === 'number' && c >= 0.85 ? 'HIGH' : typeof c === 'number' && c >= 0.6 ? 'MEDIUM' : 'LOW');
const isObj = (x: unknown): x is Record<string, unknown> => !!x && typeof x === 'object' && !Array.isArray(x);
const shortQuote = (q: string): boolean => q.replace(/\s+/g, '').length < 8;
const pushOnce = (a: string[], x: string) => { if (!a.includes(x)) a.push(x); };

/**
 * R4/R5. Her izinli alan için tek sonuç döner (modelin atladıkları MISSING). Metin katmanlı sayfada alıntı bulunmuyor ya da değer
 * alıntıdan türetilemiyorsa NULL + MISSING; taranmış sayfada öneri LOW + UNVERIFIED_SCAN olarak kalır, asla önceden doldurulmaz.
 */
export function checkContractExtraction(raw: unknown, pages: string[]): { fields: CheckedContractField[]; flags: string[] } {
  const flags: string[] = [];
  const obj = isObj(raw) ? raw : {};
  for (const k of Object.keys(obj)) if (k !== 'fields') pushOnce(flags, `IGNORED_KEY:${k}`);
  const list = Array.isArray(obj.fields) ? obj.fields : [];
  const ENTRY_KEYS = ['name', 'value', 'page', 'evidence', 'confidence'];
  for (const e of list) {
    if (!isObj(e)) continue;
    for (const k of Object.keys(e)) if (!ENTRY_KEYS.includes(k)) pushOnce(flags, `IGNORED_KEY:${k}`);
    if (typeof e.name === 'string' && !(CONTRACT_AI_FIELDS as readonly string[]).includes(e.name)) pushOnce(flags, `IGNORED_FIELD:${e.name}`);
  }
  const fields = CONTRACT_AI_FIELDS.map((field): CheckedContractField => {
    const critical = CRITICAL_AI_FIELDS.includes(field);
    const out: CheckedContractField = { field, value: null, page: null, evidence: null, confidence: 'MISSING', flags: [], requiresHuman: true, prefill: false };
    const e = list.find((x): x is Record<string, unknown> => isObj(x) && x.name === field);
    if (!e || e.value == null || String(e.value).trim() === '') { out.flags.push('MISSING'); return out; }
    const value = normalizeValue(field, String(e.value));
    const page = Number.isInteger(e.page) ? (e.page as number) : null;
    const evidence = typeof e.evidence === 'string' && e.evidence.trim() !== '' ? e.evidence : null;
    if (value === null) { out.flags.push('MISSING', FIELD_KIND[field] === 'vkn' ? 'INVALID_TAX_ID' : 'INVALID_VALUE'); return out; }
    const text = page !== null && page >= 1 && page <= pages.length ? pages[page - 1]! : null;
    if (text === null || evidence === null) { out.flags.push('MISSING', 'NO_SOURCE'); return out; }
    if (shortQuote(evidence) && !(['money', 'date', 'int'].includes(FIELD_KIND[field]) && derivable(field, value, evidence))) { out.flags.push('MISSING', 'SHORT_QUOTE'); return out; }
    if (text.trim() === '') {
      // Metin katmanı yok: doğrulanamaz öneri.
      return { ...out, value, page, evidence, confidence: 'LOW', flags: ['UNVERIFIED_SCAN'], requiresHuman: true, prefill: false };
    }
    if (!norm(text).includes(norm(evidence))) { out.flags.push('MISSING', 'SOURCE_NOT_FOUND'); return out; }
    if (!derivable(field, value, evidence)) {
      if (FIELD_KIND[field] === 'bool' || FIELD_KIND[field] === 'enum') return { ...out, value, page, evidence, confidence: 'LOW', flags: ['UNDERIVABLE'], requiresHuman: true, prefill: false };
      out.flags.push('MISSING', 'VALUE_NOT_IN_SOURCE'); return out;
    }
    const confidence = confOf(e.confidence);
    const suggestOnly = FIELD_KIND[field] === 'bool' || FIELD_KIND[field] === 'enum'; // R5 genişlemesi: yalnız öneri
    return { ...out, value, page, evidence, confidence, requiresHuman: critical || confidence === 'LOW' || suggestOnly, prefill: !critical && !suggestOnly && (confidence === 'HIGH' || confidence === 'MEDIUM') };
  });
  return { fields, flags };
}

// ---------------------------------------------------------------- inceleme (R7/R8)
export const REVIEW_CATEGORIES = [
  'TEMPLATE', 'LIABILITY', 'PENALTY', 'TERMINATION', 'TERM_RENEWAL', 'CONFIDENTIALITY', 'IP', 'JURISDICTION', 'FORCE_MAJEURE', 'PAYMENT', 'UNILATERAL_CHANGE',
] as const;
export type ReviewCategory = (typeof REVIEW_CATEGORIES)[number];
export const REVIEW_CATEGORY_TR: Record<ReviewCategory, string> = {
  TEMPLATE: 'Şablon uygunluğu', LIABILITY: 'Sorumluluk sınırı', PENALTY: 'Cezai şart', TERMINATION: 'Fesih', TERM_RENEWAL: 'Süre ve yenileme',
  CONFIDENTIALITY: 'Gizlilik / KVKK', IP: 'Fikri haklar', JURISDICTION: 'Yetkili mahkeme', FORCE_MAJEURE: 'Mücbir sebep', PAYMENT: 'Ödeme koşulları',
  UNILATERAL_CHANGE: 'Tek taraflı değişiklik',
};
export const REVIEW_RUBRIC_VERSION = 'inceleme-puan-2026-v1';

export const FINDING_KINDS = ['MISSING_CLAUSE', 'MODIFIED_CLAUSE', 'UNFAVORABLE', 'EXTRA_CLAUSE', 'LEGAL_RISK'] as const;
export type FindingKind = (typeof FINDING_KINDS)[number];
export const FINDING_SEVERITIES = ['HIGH', 'MEDIUM', 'LOW', 'INFO'] as const;
export type FindingSeverity = (typeof FINDING_SEVERITIES)[number];
const PENALTY_POINTS: Record<FindingSeverity, number> = { HIGH: 35, MEDIUM: 15, LOW: 5, INFO: 0 };

export interface CheckedFinding {
  category: ReviewCategory; kind: FindingKind; severity: FindingSeverity; title: string; quote: string | null; page: number | null;
  templateRef: string | null; recommendation: string | null; verified: boolean; flags: string[];
}

const str = (x: unknown): string | null => (typeof x === 'string' && x.trim() !== '' ? x.trim() : null);

/**
 * R7. Model bulgu + genel yorum döndürür; puan/karar anahtarları yok sayılır. MISSING_CLAUSE alıntısı şablon metninde, diğerleri
 * sözleşmenin belirtilen sayfasında aranır. Bulunmayan ya da taranmış sayfadaki bulgu verified=false olur ve puana girmez.
 */
export function checkReviewOutput(raw: unknown, contractPages: string[], templateText: string | null): { findings: CheckedFinding[]; summary: string | null; flags: string[] } {
  const flags: string[] = [];
  const obj = isObj(raw) ? raw : {};
  for (const k of Object.keys(obj)) if (k !== 'findings' && k !== 'summary') pushOnce(flags, `IGNORED_KEY:${k}`);
  const list = Array.isArray(obj.findings) ? obj.findings : [];
  const ENTRY_KEYS = ['category', 'kind', 'severity', 'title', 'quote', 'page', 'templateRef', 'recommendation'];
  const findings: CheckedFinding[] = [];
  for (const e of list) {
    if (!isObj(e)) continue;
    for (const k of Object.keys(e)) if (!ENTRY_KEYS.includes(k)) pushOnce(flags, `IGNORED_KEY:${k}`);
    const category = (REVIEW_CATEGORIES as readonly unknown[]).includes(e.category) ? (e.category as ReviewCategory) : null;
    const kind = (FINDING_KINDS as readonly unknown[]).includes(e.kind) ? (e.kind as FindingKind) : null;
    const severity = (FINDING_SEVERITIES as readonly unknown[]).includes(e.severity) ? (e.severity as FindingSeverity) : null;
    if (!category) { flags.push('DROPPED_FINDING:category'); continue; }
    const quote = str(e.quote);
    const page = Number.isInteger(e.page) ? (e.page as number) : null;
    const f: CheckedFinding = { category, kind: kind ?? 'LEGAL_RISK', severity: severity ?? 'INFO', title: str(e.title) ?? '', quote, page, templateRef: str(e.templateRef), recommendation: str(e.recommendation), verified: false, flags: [] };
    if (!kind || !severity) f.flags.push('INVALID_FORMAT');
    else if (!quote) f.flags.push('NO_SOURCE');
    else if (shortQuote(quote)) f.flags.push('SHORT_QUOTE');
    else if (kind === 'MISSING_CLAUSE') {
      if (templateText === null) f.flags.push('TEMPLATE_UNAVAILABLE');
      else if (norm(templateText).includes(norm(quote))) f.verified = true;
      else f.flags.push('SOURCE_NOT_FOUND');
    } else if (page === null || page < 1 || page > contractPages.length) f.flags.push('NO_SOURCE');
    else if (contractPages[page - 1]!.trim() === '') f.flags.push('UNVERIFIED_SCAN');
    else if (norm(contractPages[page - 1]!).includes(norm(quote))) f.verified = true;
    else f.flags.push('SOURCE_NOT_FOUND');
    if (!f.verified) f.flags.push('SOURCE_NOT_VERIFIED');
    findings.push(f);
  }
  const summary = str(obj.summary);
  return { findings, summary: summary === null ? null : summary.slice(0, 4000), flags };
}

/**
 * R8, inceleme-puan-2026-v1. Kategori puanı = max(0, 100 − Σ ceza) yalnız doğrulanmış bulgulardan; toplam = round(0,4·TEMPLATE + 0,6·hukuk
 * ortalaması). Şablon yoksa TEMPLATE null ve toplam hukuk ortalaması. Tamsayı aritmetiği (yarım yukarı); aynı bulgu → aynı puan.
 */
export function reviewScore(findings: CheckedFinding[], hasTemplate: boolean): { score: number; subScores: Record<ReviewCategory, number | null> } {
  const subScores = {} as Record<ReviewCategory, number | null>;
  for (const c of REVIEW_CATEGORIES) {
    if (c === 'TEMPLATE' && !hasTemplate) { subScores[c] = null; continue; }
    const penalty = findings.filter((f) => f.verified && f.category === c).reduce((a, f) => a + PENALTY_POINTS[f.severity], 0);
    subScores[c] = Math.max(0, 100 - penalty);
  }
  const legalSum = REVIEW_CATEGORIES.filter((c) => c !== 'TEMPLATE').reduce((a, c) => a + subScores[c]!, 0); // 10 kategori
  const score = hasTemplate ? Math.floor((40 * subScores.TEMPLATE! + 6 * legalSum + 50) / 100) : Math.floor((legalSum + 5) / 10);
  return { score, subScores };
}

export const belowThreshold = (score: number, threshold: number): boolean => score < threshold;

// ---------------------------------------------------------------- kanıt belgesi okuma (R14)
export type EvidenceAnswer = 'YES' | 'NO' | 'UNCLEAR';
export interface CheckedEvidenceAnswer { questionId: string; answer: EvidenceAnswer; quote: string | null; page: number | null; explanation: string | null; flags: string[] }

/** Alıntısı sayfada doğrulanmayan YES/NO cevabı UNCLEAR'a düşer; cevabı olmayan soru UNCLEAR. Karar kural motorunda. */
export function checkEvidenceOutput(raw: unknown, pages: string[], questionIds: string[]): { answers: CheckedEvidenceAnswer[]; flags: string[] } {
  const flags: string[] = [];
  const obj = isObj(raw) ? raw : {};
  for (const k of Object.keys(obj)) if (k !== 'answers') pushOnce(flags, `IGNORED_KEY:${k}`);
  const list = Array.isArray(obj.answers) ? obj.answers : [];
  for (const e of list) {
    if (!isObj(e)) continue;
    for (const k of Object.keys(e)) if (!['questionId', 'answer', 'quote', 'page', 'explanation'].includes(k)) pushOnce(flags, `IGNORED_KEY:${k}`);
    if (typeof e.questionId === 'string' && !questionIds.includes(e.questionId)) pushOnce(flags, `IGNORED_ANSWER:${e.questionId}`);
  }
  const answers = questionIds.map((questionId): CheckedEvidenceAnswer => {
    const e = list.find((x): x is Record<string, unknown> => isObj(x) && x.questionId === questionId);
    const out: CheckedEvidenceAnswer = { questionId, answer: 'UNCLEAR', quote: null, page: null, explanation: null, flags: [] };
    if (!e) { out.flags.push('MISSING'); return out; }
    out.explanation = str(e.explanation);
    if (e.answer !== 'YES' && e.answer !== 'NO') return out;
    const quote = str(e.quote); const page = Number.isInteger(e.page) ? (e.page as number) : null;
    if (quote && shortQuote(quote)) { out.flags.push('SHORT_QUOTE'); return out; }
    if (!quote || page === null || page < 1 || page > pages.length) { out.flags.push('NO_SOURCE'); return out; }
    if (pages[page - 1]!.trim() === '') { out.flags.push('UNVERIFIED_SCAN'); return out; }
    if (!norm(pages[page - 1]!).includes(norm(quote))) { out.flags.push('SOURCE_NOT_FOUND'); return out; }
    return { ...out, answer: e.answer, quote, page };
  });
  return { answers, flags };
}

// ---------------------------------------------------------------- doğruluk ölçümü (R13)
/**
 * Beklenen etiketle okunanı alan alan karşılaştırır (tam eşitlik; null=null doğru). Oranlar 0–1; kritik alan etiketi yoksa critical 0
 * (tanımsız oran kusursuz görünmesin). Test sağlayıcısıyla koşulan sonuç gerçek ölçüm değildir.
 */
export function extractionAccuracy(expected: Record<string, string | null>, got: Record<string, string | null>): { perField: Record<string, boolean>; overall: number; critical: number } {
  const perField: Record<string, boolean> = {};
  for (const k of Object.keys(expected)) perField[k] = (got[k] ?? null) === expected[k];
  const ratio = (keys: string[]) => (keys.length === 0 ? 0 : Math.round((keys.filter((k) => perField[k]).length / keys.length) * 10000) / 10000);
  const keys = Object.keys(perField);
  return { perField, overall: ratio(keys), critical: ratio(keys.filter((k) => (CRITICAL_AI_FIELDS as readonly string[]).includes(k))) };
}
