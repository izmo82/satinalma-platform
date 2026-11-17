/**
 * v2 Faz 7 (R6–R9): Satınalma uyum denetimi kuralları. Puan ve hüküm kodda hesaplanır (LLM puan vermez).
 */
import { cmp, dec, isDecimal } from './money.ts';

export type RuleResult = 'PASS' | 'FAIL' | 'NO_DATA' | 'PENDING' | 'NOT_APPLICABLE';
export const RESULT_TR: Record<RuleResult, string> = {
  PASS: 'Karşılandı', FAIL: 'Karşılanmadı', NO_DATA: 'Veri yok', PENDING: 'Elle işaret bekliyor', NOT_APPLICABLE: 'Uygulanmaz',
};
export type Verdict = 'COMPLIANT' | 'NONCOMPLIANT' | 'NO_RULES';
export const VERDICT_TR: Record<Verdict, string> = { COMPLIANT: 'Uyumlu', NONCOMPLIANT: 'Uyumsuz', NO_RULES: 'Kural yok' };

export const PROJECT_METHODS = ['INVITED_BIDS', 'SINGLE_SOURCE'] as const;
export type ProjectMethod = (typeof PROJECT_METHODS)[number];
export const PROJECT_METHOD_TR: Record<ProjectMethod, string> = { INVITED_BIDS: 'Davetli teklif', SINGLE_SOURCE: 'Tek kaynak' };

export type CheckType = 'DATA' | 'EVIDENCE_AI' | 'MANUAL';
export const CHECK_TYPE_TR: Record<CheckType, string> = { DATA: 'Otomatik (veri)', EVIDENCE_AI: 'Kanıt + yapay zekâ', MANUAL: 'Elle' };

type ParamSpec = { kind: 'int'; min: number; max: number } | { kind: 'decimal'; min: number; max: number };
type CheckDef = { name: string; type: 'DATA' | 'EVIDENCE_AI'; defaultParams: Record<string, number | string>; spec: Record<string, ParamSpec> };

export const COMPLIANCE_CHECKS = {
  MIN_BIDS: { name: 'En az teklif alınmış', type: 'DATA', defaultParams: { minBids: 3 }, spec: { minBids: { kind: 'int', min: 1, max: 20 } } },
  LOWEST_OR_JUSTIFIED: { name: 'En düşük teklif seçildi ya da gerekçe var', type: 'DATA', defaultParams: {}, spec: {} },
  WINNER_APPROVED: { name: 'Kazanan tedarikçi onaylı', type: 'DATA', defaultParams: {}, spec: {} },
  WINNER_RISK_CURRENT: { name: 'Kazananın risk değerlendirmesi güncel', type: 'DATA', defaultParams: { maxAgeMonths: 12 }, spec: { maxAgeMonths: { kind: 'int', min: 1, max: 60 } } },
  WINNER_RISK_LEVEL: { name: 'Kazananın risk seviyesi sınırda', type: 'DATA', defaultParams: { maxLevel: 3 }, spec: { maxLevel: { kind: 'int', min: 1, max: 5 } } },
  CONTRACT_CHAIN_APPROVED: { name: 'Sözleşme üç onayı tamamlamış', type: 'DATA', defaultParams: {}, spec: {} },
  CONTRACT_AFTER_AWARD: { name: 'Sözleşme tarihi karardan sonra', type: 'DATA', defaultParams: {}, spec: {} },
  CONTRACT_AMOUNT_MATCHES_AWARD: { name: 'Sözleşme tutarı kazanan teklifle uyumlu', type: 'DATA', defaultParams: { tolerancePercent: '0' }, spec: { tolerancePercent: { kind: 'decimal', min: 0, max: 100 } } },
  INVOICES_WITHIN_CONTRACT: { name: 'Faturalar sözleşme tutarını aşmıyor', type: 'DATA', defaultParams: {}, spec: {} },
  TEMPLATE_SCORE_ABOVE: { name: 'Şablon uygunluk puanı eşiğin üstünde', type: 'DATA', defaultParams: { threshold: '70' }, spec: { threshold: { kind: 'decimal', min: 0, max: 100 } } },
  COI_COMPLETE: { name: 'Çıkar çatışması beyanları tamam ve çatışma yok', type: 'DATA', defaultParams: {}, spec: {} },
  WINNER_RESEARCH: { name: 'Kazanan firma araştırması yapılmış', type: 'EVIDENCE_AI', defaultParams: {}, spec: {} },
  OWNERSHIP_RESEARCH: { name: 'Sahiplik ve ilişkili taraf araştırması yapılmış', type: 'EVIDENCE_AI', defaultParams: {}, spec: {} },
} as const satisfies Record<string, CheckDef>;
export type CheckKey = keyof typeof COMPLIANCE_CHECKS;

export interface ComplianceRule {
  code: string; name: string; description: string | null;
  checkType: CheckType; checkKey: CheckKey | null; params: Record<string, number | string>;
  methods: string[]; amountThreshold: string | null; currency: string | null;
  weight: number; mandatory: boolean;
}

/**
 * Kapsam: boş yöntem listesi = tüm yöntemler. Tutar bilinmiyorsa eşikli kural gizlenmez (uygulanır).
 * Bütün faz incelemesi I4: eşik başka para birimindeyse kur çevrilmediği için kapsam belirlenemez (`FX_UNKNOWN`); kural kapsam dışı
 * sayılmaz (zorunlu kural sessizce düşmesin), denetimde NO_DATA `FX_SCOPE_UNKNOWN_TR` olur.
 */
export type RuleScope = 'IN' | 'OUT' | 'FX_UNKNOWN';
export const FX_SCOPE_UNKNOWN_TR = 'Kur çevrilmedi; kapsam belirlenemedi';
export function ruleScope(rule: Pick<ComplianceRule, 'methods' | 'amountThreshold' | 'currency'>, project: { method: string; amount: string | null; currency: string }): RuleScope {
  if (rule.methods.length > 0 && !rule.methods.includes(project.method)) return 'OUT';
  if (rule.amountThreshold !== null) {
    if (rule.currency !== null && rule.currency !== project.currency) return 'FX_UNKNOWN';
    if (project.amount !== null && cmp(dec(project.amount), dec(rule.amountThreshold)) < 0) return 'OUT';
  }
  return 'IN';
}
/** Kural kesin kapsamda mı (`ruleScope` = IN). Kur çevrilmemiş eşik (FX_UNKNOWN) burada false; denetim `ruleScope` kullanır. */
export function ruleApplies(rule: Pick<ComplianceRule, 'methods' | 'amountThreshold' | 'currency'>, project: { method: string; amount: string | null; currency: string }): boolean {
  return ruleScope(rule, project) === 'IN';
}

/** Puan = yarım yukarı yuvarlanmış 100 × PASS ağırlığı ÷ uygulanan ağırlık (tam sayı aritmetiği). Zorunlu PASS olmayan → Uyumsuz. */
export function complianceScore(results: { weight: number; mandatory: boolean; result: RuleResult }[]): { score: number | null; verdict: Verdict; failedMandatory: number[] } {
  let pass = 0n;
  let total = 0n;
  const failedMandatory: number[] = [];
  results.forEach((r, idx) => {
    if (r.result === 'NOT_APPLICABLE') return;
    total += BigInt(r.weight);
    if (r.result === 'PASS') pass += BigInt(r.weight);
    else if (r.mandatory) failedMandatory.push(idx);
  });
  if (total === 0n) return { score: null, verdict: 'NO_RULES', failedMandatory: [] };
  const score = Number((200n * pass + total) / (2n * total));
  return { score, verdict: failedMandatory.length > 0 ? 'NONCOMPLIANT' : 'COMPLIANT', failedMandatory };
}

/** Gün (YYYY-MM-DD) için yürürlükteki set: yayımlı ve effective_from ≤ gün olanların en yenisi. */
export function activeRuleSet<T extends { id: string; status: string; effectiveFrom: string }>(sets: T[], day: string): T | null {
  const ok = sets.filter((s) => s.status === 'PUBLISHED' && s.effectiveFrom <= day);
  if (ok.length === 0) return null;
  return ok.reduce((a, b) => (b.effectiveFrom > a.effectiveFrom || (b.effectiveFrom === a.effectiveFrom && b.id > a.id) ? b : a));
}

export function validateComplianceRule(r: ComplianceRule): string[] {
  const e: string[] = [];
  if (!r.code || r.code.trim() === '') e.push('Kural kodu boş olamaz');
  if (!r.name || r.name.trim() === '') e.push('Kural adı boş olamaz');
  if (!Number.isInteger(r.weight) || r.weight < 1 || r.weight > 100) e.push('Ağırlık 1 ile 100 arasında tam sayı olmalı');
  for (const m of r.methods) if (!(PROJECT_METHODS as readonly string[]).includes(m)) e.push(`Bilinmeyen yöntem: ${m}`);
  if (r.amountThreshold !== null) {
    if (!isDecimal(r.amountThreshold) || r.amountThreshold.startsWith('-')) e.push('Tutar eşiği sıfır ya da pozitif ondalık sayı olmalı');
    if (!r.currency) e.push('Tutar eşiği için para birimi gerekli');
  }
  if (r.checkType === 'MANUAL') {
    if (r.checkKey !== null) e.push('Elle kuralın kontrol anahtarı olmaz');
    if (Object.keys(r.params).length > 0) e.push('Elle kuralın parametresi olmaz');
    return e;
  }
  if (r.checkType !== 'DATA' && r.checkType !== 'EVIDENCE_AI') { e.push('Bilinmeyen kontrol türü'); return e; }
  if (r.checkKey === null || !Object.hasOwn(COMPLIANCE_CHECKS, r.checkKey)) { e.push('Kontrol anahtarı katalogda yok'); return e; }
  const def: CheckDef = COMPLIANCE_CHECKS[r.checkKey];
  if (def.type !== r.checkType) e.push('Kontrol anahtarı kontrol türüyle uyuşmuyor');
  for (const k of Object.keys(r.params)) if (!Object.hasOwn(def.spec, k)) e.push(`Bilinmeyen parametre: ${k}`);
  for (const [k, s] of Object.entries(def.spec)) {
    const v = r.params[k];
    if (v === undefined) { e.push(`Parametre eksik: ${k}`); continue; }
    if (s.kind === 'int') {
      if (typeof v !== 'number' || !Number.isInteger(v) || v < s.min || v > s.max) e.push(`${k} ${s.min} ile ${s.max} arasında tam sayı olmalı`);
    } else if (typeof v !== 'string' || !isDecimal(v) || cmp(dec(v), dec(String(s.min))) < 0 || cmp(dec(v), dec(String(s.max))) > 0) {
      e.push(`${k} ${s.min} ile ${s.max} arasında ondalık sayı (metin) olmalı`);
    }
  }
  return e;
}

const D = (code: string, key: CheckKey, weight: number, mandatory: boolean, description: string, extra: Partial<ComplianceRule> = {}): ComplianceRule => ({
  code, name: COMPLIANCE_CHECKS[key].name, description, checkType: COMPLIANCE_CHECKS[key].type, checkKey: key,
  params: { ...COMPLIANCE_CHECKS[key].defaultParams }, methods: [], amountThreshold: null, currency: null, weight, mandatory, ...extra,
});

/** Analiz §3.6 örnek kuralları; "Varsayılan kataloğu yükle" bunlardan taslak v1 kurar (Yönetici yayımlar). */
export const DEFAULT_RULESET: ComplianceRule[] = [
  D('K01', 'MIN_BIDS', 15, true, 'Geçerli teklif sayısı en az eşik kadar olmalı.', { methods: ['INVITED_BIDS'] }),
  D('K02', 'LOWEST_OR_JUSTIFIED', 10, false, 'En düşük teklif seçilmediyse değerlendirme kaydında gerekçe bulunmalı.', { methods: ['INVITED_BIDS'] }),
  D('K03', 'WINNER_APPROVED', 10, true, 'Kazanan tedarikçi onaylı tedarikçi olmalı.'),
  D('K04', 'WINNER_RISK_CURRENT', 8, false, 'Kazananın risk değerlendirmesi belirlenen süreden eski olmamalı.'),
  D('K05', 'WINNER_RISK_LEVEL', 8, false, 'Kazananın risk seviyesi izin verilen en yüksek seviyeyi aşmamalı.'),
  D('K06', 'CONTRACT_CHAIN_APPROVED', 10, true, 'Sözleşme üç onayı tamamlamış olmalı.'),
  D('K07', 'CONTRACT_AFTER_AWARD', 5, false, 'Sözleşme tarihi kazanan kararından sonra olmalı.'),
  D('K08', 'CONTRACT_AMOUNT_MATCHES_AWARD', 8, false, 'Sözleşme tutarı kazanan teklifle uyumlu olmalı.'),
  D('K09', 'INVOICES_WITHIN_CONTRACT', 6, false, 'Eşleşen faturaların toplamı sözleşme tutarını aşmamalı.'),
  D('K10', 'TEMPLATE_SCORE_ABOVE', 5, false, 'Sözleşmenin şablon uygunluk puanı eşiğin üstünde olmalı.'),
  D('K11', 'COI_COMPLETE', 10, true, 'Tüm katılımcılar çıkar çatışması beyanı vermeli ve çatışma bildirilmemiş olmalı.'),
  D('K12', 'WINNER_RESEARCH', 5, false, 'Kazanan firma araştırması belgesi yüklenmiş ve içeriği kuralı karşılıyor olmalı.'),
  D('K13', 'OWNERSHIP_RESEARCH', 5, false, 'Ticaret sicil gazetesi ve çıkar çatışması beyanı sahiplik araştırmasını karşılamalı.'),
  {
    code: 'K14', name: 'Kuruma özel kural (elle)', description: 'Kuruma özel diğer kurallar; Satınalmacı işaretler ve kanıt ekler.',
    checkType: 'MANUAL', checkKey: null, params: {}, methods: [], amountThreshold: null, currency: null, weight: 5, mandatory: false,
  },
];
