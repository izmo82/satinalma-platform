/**
 * v2 Faz 6: yıllık tedarikçi risk değerlendirmesi (analiz-v2 §3.4; KHC-IT-2100-002 R009 yöntemi).
 * Saf ve deterministik; AI kullanılmaz. Skorlar decimal string; kritiklik 4 hane saklanır.
 * Faz 1'deki `supplierRisk.ts` (anket/içsel-kalan risk, karne) ayrıdır ve değişmez (R14).
 */

export const RISK_METHOD_VERSION = 'khc-it-2100-002-r009/v1';

export const RISK_CRITERIA = ['businessImpact', 'dataSensitivity', 'continuity', 'integration', 'regulation', 'serviceType'] as const;
export type RiskCriterion = (typeof RISK_CRITERIA)[number];
export type CriterionValue = 1 | 3 | 5;
export type CriteriaValues = Record<RiskCriterion, CriterionValue>;

/** Excel `Risk Tablosu` C3–H3 başlıkları (numarasız). */
export const RISK_CRITERIA_TR: Record<RiskCriterion, string> = {
  businessImpact: 'Hizmetin İş Süreçlerine Etkisi',
  dataSensitivity: 'Veri Hassasiyeti',
  continuity: 'Süreklilik ve Bağımlılık Düzeyi',
  integration: 'Entegrasyon Derinliği',
  regulation: 'Regülasyon Uyumu Gerekliliği',
  serviceType: 'Hizmet Tipi ve Süresi',
};

/** Analiz §3.4 tablosu: her ölçüt için 1/3/5 açıklamaları. */
export const RISK_CRITERIA_LEVELS: Record<RiskCriterion, Record<CriterionValue, string>> = {
  businessImpact: { 1: 'Yardımcı hizmet', 3: 'Önemli ama yedeklenebilir', 5: 'Kritik süreç bu tedarikçiye bağlı' },
  dataSensitivity: { 1: 'Genel/halka açık', 3: 'Kurumsal hassas', 5: 'Kişisel, finansal, regülasyona tabi' },
  continuity: { 1: 'Alternatif var, geçici', 3: 'Orta bağımlılık, dönemsel', 5: 'Alternatifsiz, sistemik' },
  integration: { 1: 'Sistem erişimi yok', 3: 'Sınırlı entegrasyon/VPN', 5: 'Sürekli erişim, yüksek entegrasyon' },
  regulation: { 1: 'Tabi değil', 3: 'Dolaylı (iç politika, denetim)', 5: 'KVKK, ISO vb. zorunlu' },
  serviceType: { 1: 'Kısa, tek seferlik', 3: 'Orta vadeli, proje bazlı', 5: 'Sürekli, SLA\'lı uzun dönem' },
};

export type MatrixColumn = 1 | 2 | 3 | 4 | 5;
export type RiskLevelNo = 1 | 2 | 3 | 4 | 5;

/** `display` yuvarlanmamış değerden (Excel `0.00` biçimi gibi) üretilir: 3,224968 → "3,22"; saklanan 4 hane (3.2250) ekranda 3,23 olurdu, bu yüzden ekran metni her zaman ölçütlerden yeniden hesaplanır. */
/** Kritiklik = altı ölçütün geometrik ortalaması (Excel GEOMEAN); sütun en yakın tam sayı (yarım yukarı), yuvarlanmamış değerden (R1). */
export function criticality(v: CriteriaValues): { value: string; display: string; column: MatrixColumn } {
  let sumLn = 0;
  for (const k of RISK_CRITERIA) {
    const x = v[k] as number;
    if (x !== 1 && x !== 3 && x !== 5) throw new Error(`invalid_criterion_value:${k}`);
    sumLn += Math.log(x);
  }
  const raw = Math.exp(sumLn / RISK_CRITERIA.length);
  const column = Math.min(5, Math.max(1, Math.round(raw))) as MatrixColumn;
  const value = raw.toFixed(4);
  return { value, display: raw.toLocaleString('tr-TR', { minimumFractionDigits: 2, maximumFractionDigits: 2 }), column };
}

// ---- decimal yardımcıları (BigInt; kayan nokta yok) ----
function parseDec(s: string, scale: number): bigint {
  const m = /^(-)?(\d+)(?:\.(\d+))?$/.exec(s.trim());
  if (!m) throw new Error(`invalid_decimal:${s}`);
  const frac = m[3] ?? '';
  if (frac.length > scale) {
    if (/[1-9]/.test(frac.slice(scale))) throw new Error(`invalid_decimal:${s}`);
  }
  const n = BigInt(m[2]! + frac.slice(0, scale).padEnd(scale, '0'));
  return m[1] ? -n : n;
}
function fmtDec(n: bigint, scale: number): string {
  const neg = n < 0n;
  const abs = (neg ? -n : n).toString().padStart(scale + 1, '0');
  return `${neg ? '-' : ''}${abs.slice(0, abs.length - scale)}.${abs.slice(abs.length - scale)}`;
}

export interface RiskQuestionDef { id: string; code: string; weight: string; riskAnswer: 'YES' | 'NO' }
export type RiskAnswer = 'YES' | 'NO';

/** Risk skoru = Σ(ağırlık × riskli cevap) / Σ ağırlık × 100, 2 hane yarım yukarı. Tüm sorular cevaplanmadan skor yok (R3). */
export function riskScore(questions: readonly RiskQuestionDef[], answers: Readonly<Record<string, RiskAnswer | undefined>>): { score: string | null; missing: string[] } {
  const missing = questions.filter((q) => answers[q.id] !== 'YES' && answers[q.id] !== 'NO').map((q) => q.id);
  if (missing.length > 0) return { score: null, missing };
  let total = 0n;
  let risky = 0n;
  for (const q of questions) {
    const w = parseDec(q.weight, 4);
    if (w < 0n) throw new Error(`invalid_weight:${q.id}`);
    total += w;
    if (answers[q.id] === q.riskAnswer) risky += w;
  }
  if (total === 0n) return { score: null, missing: [] };
  // risky/total × 100 → 2 hane: (risky × 10000) / total, yarım yukarı
  const num = risky * 10000n;
  const q = (2n * num + total) / (2n * total);
  return { score: fmtDec(q, 2), missing: [] };
}

/** Matris satırları: bant 1 (0–20) … bant 5 (80–100); sütunlar kritiklik 1–5. Excel `Risk Grafiği` ile birebir. */
export const RISK_MATRIX: readonly (readonly [RiskLevelNo, RiskLevelNo, RiskLevelNo, RiskLevelNo, RiskLevelNo])[] = [
  [1, 1, 2, 2, 3],
  [1, 2, 2, 3, 3],
  [2, 2, 3, 3, 4],
  [2, 3, 3, 4, 5],
  [3, 3, 4, 5, 5],
];
export const RISK_BAND_LABEL: Record<RiskLevelNo, string> = { 1: '0–20', 2: '20–40', 3: '40–60', 4: '60–80', 5: '80–100' };

/** Bant üst sınırı dahil: [0,20], (20,40], (40,60], (60,80], (80,100] (R2). */
export function riskBand(score: string): RiskLevelNo {
  const n = parseDec(score, 6);
  const hundred = 100n * 1000000n;
  if (n < 0n || n > hundred) throw new Error(`score_out_of_range:${score}`);
  for (let b = 1; b <= 5; b++) if (n <= BigInt(b * 20) * 1000000n) return b as RiskLevelNo;
  throw new Error(`score_out_of_range:${score}`);
}

export function riskLevel(score: string, column: MatrixColumn): { level: RiskLevelNo; band: RiskLevelNo } {
  if (![1, 2, 3, 4, 5].includes(column)) throw new Error('invalid_column');
  const band = riskBand(score);
  return { level: RISK_MATRIX[band - 1]![column - 1]!, band };
}

export const RISK_LEVEL_TR: Record<RiskLevelNo, string> = {
  1: 'Seviye 1 — Kabul edilebilir',
  2: 'Seviye 2 — Yeşil',
  3: 'Seviye 3 — Sarı',
  4: 'Seviye 4 — Turuncu',
  5: 'Seviye 5 — Kırmızı',
};

/** Prosedür kabul kuralı: risk ≤ 40 ve kritiklik 1, ya da risk ≤ 20 ve kritiklik ≤ 2. Matriste seviye 1 ile eşdeğerdir. */
export function procedureAcceptable(score: string, column: MatrixColumn): boolean {
  riskBand(score);
  const n = parseDec(score, 6);
  const m = 1000000n;
  return (n <= 40n * m && column === 1) || (n <= 20n * m && column <= 2);
}

export interface RiskActionInput { kind: 'MITIGATION' | 'CONTROL'; ownerUserId: string | null; dueOn: string | null; status: string }

/** R9: seviye 4–5 aksiyon + kontrol satırı, her birinde sahip ve gelecek tarih olmadan tamamlanamaz. */
export function completionBlockers(input: {
  criteria: Partial<CriteriaValues>; score: string | null; level: number | null; actions: readonly RiskActionInput[]; today: string;
}): { code: string; message: string }[] {
  const out: { code: string; message: string }[] = [];
  const missingCriteria = RISK_CRITERIA.filter((k) => input.criteria[k] === undefined);
  if (missingCriteria.length > 0) out.push({ code: 'criteria_missing', message: `Eksik ölçüt: ${missingCriteria.map((k) => RISK_CRITERIA_TR[k]).join(', ')}` });
  if (input.score === null) out.push({ code: 'score_missing', message: 'Risk skoru yok; tüm soruları cevaplayın.' });
  if (input.level === null || input.level < 4) return out;
  const live = input.actions.filter((a) => a.status !== 'CANCELLED');
  if (!live.some((a) => a.kind === 'MITIGATION')) out.push({ code: 'action_plan_required', message: 'Seviye 4–5 için en az bir aksiyon (azaltım) satırı gerekir.' });
  if (!live.some((a) => a.kind === 'CONTROL')) out.push({ code: 'control_required', message: 'Seviye 4–5 için en az bir denetim/kontrol satırı gerekir.' });
  live.forEach((a, i) => {
    const row = `${i + 1}. satır`;
    if (!a.ownerUserId) out.push({ code: 'action_owner_required', message: `${row}: sorumlu kişi seçilmeli.` });
    if (!a.dueOn) out.push({ code: 'action_due_required', message: `${row}: tarih girilmeli.` });
    else if (a.dueOn <= input.today) out.push({ code: 'action_due_past', message: `${row}: tarih bugünden sonra olmalı.` });
  });
  return out;
}

/** R8: iki kayıt arasında değişen alanların anahtarları (sıralı). Değerler JSON eşitliğiyle karşılaştırılır; undefined ve null eşittir. */
export function changedFields(prev: Readonly<Record<string, unknown>> | null | undefined, cur: Readonly<Record<string, unknown>>): string[] {
  const p = prev ?? {};
  const norm = (x: unknown): string => JSON.stringify(x === undefined ? null : x);
  const keys = new Set([...Object.keys(p), ...Object.keys(cur)]);
  return [...keys].filter((k) => norm(p[k]) !== norm(cur[k])).sort();
}

/** Dönem adı Excel'deki gibi `YYYY-Ç`: 2026-11-17 → 2026-4. */
export function riskPeriod(date: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(date);
  if (!m) throw new Error(`invalid_date:${date}`);
  const month = Number(m[2]);
  if (month < 1 || month > 12) throw new Error(`invalid_date:${date}`);
  return `${m[1]}-${Math.ceil(month / 3)}`;
}
export function quarterStart(period: string): string {
  const m = /^(\d{4})-([1-4])$/.exec(period);
  if (!m) throw new Error(`invalid_period:${period}`);
  return `${m[1]}-${String((Number(m[2]) - 1) * 3 + 1).padStart(2, '0')}-01`;
}

/** Excel J değeri → 0–100 skor string'i (2 hane). Kesir ölçeğinde ×100; kayan nokta hatası yok. */
export function excelRiskToScore(v: number, fractionScale: boolean): string {
  if (!Number.isFinite(v) || v < 0) throw new Error('invalid_score');
  const hundredths = Math.round(fractionScale ? v * 10000 : v * 100);
  return fmtDec(BigInt(hundredths), 2);
}
export function scoreToExcelFraction(score: string): number {
  return Number(fmtDec(parseDec(score, 2), 2)) / 100;
}

/** R11: ad eşleşmesi için normalize (tr küçük harf, şirket eki ve noktalama atılır). */
export function normalizeSupplierName(s: string): string {
  let t = s.toLocaleLowerCase('tr').replace(/\./g, '').replace(/[^\p{L}\p{N}]+/gu, ' ').trim().replace(/\s+/g, ' ');
  const suffix = /(?:^|\s)(?:a\s?[sş]|ltd(?:\s?[sş]ti)?|[sş]ti|limited(?:\s[sş]irketi)?|anonim(?:\s[sş]irketi)?|[sş]irketi)$/u;
  while (suffix.test(t) && t.replace(suffix, '').length > 0) t = t.replace(suffix, '').trim();
  return t;
}
