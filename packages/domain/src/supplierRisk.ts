/**
 * Tedarikçi değerlendirmesi (02 §8–9, T19–T20). Saf ve deterministik; AI kullanılmaz.
 * Performans ile risk ayrıdır. Kritik engel ortalamayla aşılmaz. Puan etkisi yalnız doğrulanmış olaylara uygulanır.
 */

export type Level = 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
const RANK: Record<Level, number> = { LOW: 0, MEDIUM: 1, HIGH: 2, CRITICAL: 3 };
const byRank = (n: number): Level => (['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'] as const)[Math.max(0, Math.min(3, n))]!;

export interface InherentFactors {
  dataSensitivity: 'LOW' | 'MEDIUM' | 'HIGH';
  accessLevel: 'LOW' | 'MEDIUM' | 'HIGH';
  criticality: 'LOW' | 'MEDIUM' | 'HIGH';
  substitutability: 'LOW' | 'MEDIUM' | 'HIGH';
  subcontractorDependence: 'LOW' | 'MEDIUM' | 'HIGH';
}
export const FACTOR_LABEL: Record<keyof InherentFactors, string> = {
  dataSensitivity: 'Veri hassasiyeti', accessLevel: 'Erişim seviyesi', criticality: 'Hizmet kritikliği',
  substitutability: 'İkame güçlüğü', subcontractorDependence: 'Alt yüklenici bağımlılığı',
};

/**
 * İçsel risk: kontrollerden önceki risk. Hassas veri + ayrıcalıklı erişim birlikteyse CRITICAL; veri/erişim/kritiklikten biri
 * yüksekse HIGH; diğer yüksek faktör veya iki orta faktör MEDIUM. Kural açıktır ve sonuç gerekçesiyle döner.
 */
export function inherentRisk(f: InherentFactors): { level: Level; reasons: string[] } {
  const high = (Object.keys(f) as (keyof InherentFactors)[]).filter((k) => f[k] === 'HIGH');
  const medium = (Object.keys(f) as (keyof InherentFactors)[]).filter((k) => f[k] === 'MEDIUM');
  const reasons = [...high.map((k) => `${FACTOR_LABEL[k]} yüksek`), ...medium.map((k) => `${FACTOR_LABEL[k]} orta`)];
  if (f.dataSensitivity === 'HIGH' && f.accessLevel === 'HIGH') return { level: 'CRITICAL', reasons };
  if (high.some((k) => k === 'dataSensitivity' || k === 'accessLevel' || k === 'criticality')) return { level: 'HIGH', reasons };
  if (high.length || medium.length >= 2) return { level: 'MEDIUM', reasons };
  return { level: 'LOW', reasons };
}

export type Response = 'YES' | 'PARTIAL' | 'NO' | 'NOT_APPLICABLE' | 'UNKNOWN';
export interface QuestionDef { id: string; controlId: string; text: string; critical: boolean; evidenceRequired: boolean }
export interface AnswerState {
  questionId: string; response: Response; naReason?: string | null;
  evidenceDocumentVersionId?: string | null; evidenceExpires?: string | null;
  review?: 'ACCEPTED' | 'FINDING' | null; findingSeverity?: Level | null;
}
export type AssessmentOutcome = 'BLOCKED' | 'INCOMPLETE' | 'CONDITIONAL' | 'ACCEPTABLE';
export interface AssessmentItem { questionId: string; controlId: string; kind: 'BLOCKER' | 'FINDING' | 'UNKNOWN' | 'EVIDENCE'; message: string }

/**
 * Anket sonucu. Eksik yanıt başarılı sayılmaz (bilinmiyor = risk görünür). Kritik kontrolde "hayır", bilinmeyen yanıt, geçersiz kanıt,
 * kabul edilmemiş "uygulanamaz" veya yüksek bulgu; herhangi bir kontrolde kritik şiddetli bulgu BLOCKED üretir; uyum oranı ne olursa olsun (T20).
 */
export function assessmentOutcome(questions: QuestionDef[], answers: AnswerState[], asOf: string) {
  const items: AssessmentItem[] = [];
  let applicable = 0; let points = 0;
  for (const q of questions) {
    const a = answers.find((x) => x.questionId === q.id);
    const push = (kind: AssessmentItem['kind'], message: string) => items.push({ questionId: q.id, controlId: q.controlId, kind: q.critical && kind !== 'FINDING' ? 'BLOCKER' : kind, message });
    if (!a || a.response === 'UNKNOWN') { push('UNKNOWN', `${q.controlId}: yanıt yok (bilinmiyor).`); applicable++; continue; }
    if (a.response === 'NOT_APPLICABLE') {
      if (!a.naReason || a.naReason.trim().length < 10) push('UNKNOWN', `${q.controlId}: "uygulanamaz" gerekçesiz.`);
      // Kritik kontrolün kapsam dışı sayılması tek kişinin kararı olamaz: değerlendirici kabulü gerekir.
      else if (q.critical && a.review !== 'ACCEPTED') push('UNKNOWN', `${q.controlId}: kritik kontrol "uygulanamaz" işaretlendi; değerlendirici kabulü gerekli.`);
      continue;
    }
    applicable++;
    if (a.response === 'YES') points += 2; else if (a.response === 'PARTIAL') points += 1;
    if (a.response === 'NO') push(q.critical ? 'BLOCKER' : 'FINDING', `${q.controlId}: kontrol uygulanmıyor.`);
    if (q.evidenceRequired && a.response !== 'NO') {
      if (!a.evidenceDocumentVersionId) push('EVIDENCE', `${q.controlId}: kanıt eklenmedi.`);
      else if (a.evidenceExpires && a.evidenceExpires < asOf) push('EVIDENCE', `${q.controlId}: kanıtın süresi ${a.evidenceExpires} tarihinde doldu.`);
    }
    if (a.review === 'FINDING' && a.findingSeverity) {
      // Kritik şiddetli bulgu her kontrolde, yüksek şiddetli bulgu kritik kontrolde engeldir.
      const blocks = a.findingSeverity === 'CRITICAL' || (q.critical && RANK[a.findingSeverity] >= RANK.HIGH);
      items.push({ questionId: q.id, controlId: q.controlId, kind: blocks ? 'BLOCKER' : 'FINDING',
        message: `${q.controlId}: değerlendirici bulgusu (${LEVEL_TR[a.findingSeverity]}).` });
    }
  }
  const reviewedAll = questions.every((q) => { const a = answers.find((x) => x.questionId === q.id); return a && (a.review || (a.response === 'NOT_APPLICABLE' && !q.critical)); });
  const outcome: AssessmentOutcome = items.some((x) => x.kind === 'BLOCKER') ? 'BLOCKED'
    : items.some((x) => x.kind === 'UNKNOWN' || x.kind === 'EVIDENCE') || !reviewedAll ? 'INCOMPLETE'
      : items.some((x) => x.kind === 'FINDING') ? 'CONDITIONAL' : 'ACCEPTABLE';
  // Uyum oranı bilgi amaçlıdır; sonuç kararı değildir.
  return { outcome, items, complianceRate: applicable ? Math.round((points / (applicable * 2)) * 1000) / 10 : null, reviewedAll };
}
export const LEVEL_TR: Record<Level, string> = { LOW: 'düşük', MEDIUM: 'orta', HIGH: 'yüksek', CRITICAL: 'kritik' };

/** Kalan risk: yalnız insan kabulüyle; içsel riskten düşükse gerekçe ve en az bir kabul edilmiş kontrol kanıtı gerekir. */
export function validateResidual(inherent: Level, residual: Level, reason: string, acceptedControls: number): string | null {
  if (reason.trim().length < 20) return 'Kalan risk gerekçesi gerekli (en az 20 karakter).';
  if (RANK[residual] < RANK[inherent] && acceptedControls === 0) return 'Doğrulanmış kontrol olmadan kalan risk içsel riskin altına indirilemez.';
  return null;
}

export type IncidentStatus = 'REPORTED' | 'UNDER_REVIEW' | 'VERIFIED' | 'REJECTED' | 'CLOSED';
export interface IncidentState {
  id: string; severity: Level; category: string; status: IncidentStatus; verifiedAt: string | null;
  disputeOpen: boolean; duplicateOfId: string | null; countedInMetric: boolean;
}
/** Politika sürümü: şiddete göre puan düşümü. Kurum değiştirebilir; sürümü karnede görünür. */
export const DEFAULT_INCIDENT_POLICY = { version: 'olay-2026-1', penalty: { LOW: 1, MEDIUM: 3, HIGH: 7, CRITICAL: 15 } as Record<Level, number> };

/**
 * Olay etkisi (T19): doğrulanmamış (iddia), reddedilmiş, itirazı açık, mükerrer veya zaten SLA ölçümüne yansımış olay
 * puan cezası almaz; her biri neden sayılmadığıyla döner.
 */
export function incidentImpact(incidents: IncidentState[], policy = DEFAULT_INCIDENT_POLICY) {
  const counted: { id: string; penalty: number }[] = [];
  const excluded: { id: string; reason: string }[] = [];
  for (const x of incidents) {
    const verified = x.status === 'VERIFIED' || (x.status === 'CLOSED' && !!x.verifiedAt);
    if (x.duplicateOfId) excluded.push({ id: x.id, reason: 'Mükerrer kayıt; asıl olayda sayılır.' });
    else if (!verified) excluded.push({ id: x.id, reason: x.status === 'REJECTED' ? 'Doğrulanmadı (reddedildi).' : 'İddia; doğrulanmadı.' });
    else if (x.disputeOpen) excluded.push({ id: x.id, reason: 'Tedarikçi itirazı açık; kesinleşmedi.' });
    else if (x.countedInMetric) excluded.push({ id: x.id, reason: 'SLA ölçümüne zaten yansıdı; ayrıca ceza puanı yok.' });
    else counted.push({ id: x.id, penalty: policy.penalty[x.severity] });
  }
  return { counted, excluded, penalty: counted.reduce((s, x) => s + x.penalty, 0), policyVersion: policy.version };
}

export const PERFORMANCE_DIMENSIONS = ['quality', 'delivery', 'sla', 'communication', 'commercial'] as const;
export type Dimension = (typeof PERFORMANCE_DIMENSIONS)[number];
export const DIMENSION_TR: Record<Dimension, string> = { quality: 'Kalite', delivery: 'Zamanında ve tam teslimat', sla: 'SLA', communication: 'İletişim', commercial: 'Ticari uyum' };
/** Örnek ağırlıklar (02 §9); kategori bazında değişebilir, toplam 100. */
export const DEFAULT_WEIGHTS: Record<Dimension, number> = { quality: 30, delivery: 25, sla: 20, communication: 10, commercial: 15 };
export const MIN_SAMPLE = 5;

export function validateWeights(w: Record<string, number>): string | null {
  const keys = Object.keys(w);
  if (keys.length !== PERFORMANCE_DIMENSIONS.length || !PERFORMANCE_DIMENSIONS.every((d) => Number.isInteger(w[d]) && w[d]! >= 0)) return 'Her boyut için tam sayı ağırlık gerekli.';
  if (keys.reduce((s, k) => s + w[k]!, 0) !== 100) return 'Ağırlıkların toplamı 100 olmalı.';
  return null;
}

/**
 * Performans puanı: boyut puanlarının ağırlıklı ortalaması − doğrulanmış olay cezası (0 altına inmez).
 * Örneklem yetersizse puan yerine "yetersiz veri" döner; bir teslimatlı firma ile yüz teslimatlı firma aynı güvenle sıralanmaz.
 */
export function performanceScore(scores: Partial<Record<Dimension, number>>, weights: Record<Dimension, number>, sampleSize: number, incidentPenalty: number, minSample = MIN_SAMPLE) {
  if (sampleSize < minSample) return { score: null, insufficient: true as const, reason: `Dönemde ${sampleSize} teslimat/kabul var; en az ${minSample} gerekir.` };
  const missing = PERFORMANCE_DIMENSIONS.filter((d) => weights[d] > 0 && scores[d] === undefined);
  if (missing.length) return { score: null, insufficient: true as const, reason: `Puanlanmamış boyut: ${missing.map((d) => DIMENSION_TR[d]).join(', ')}.` };
  const raw = PERFORMANCE_DIMENSIONS.reduce((s, d) => s + (scores[d] ?? 0) * weights[d], 0) / 100;
  const score = Math.max(0, Math.round((raw - incidentPenalty) * 10) / 10);
  return { score, base: Math.round(raw * 10) / 10, insufficient: false as const, reason: null };
}

/**
 * v2 karne puanı (D103): mal kabul kalktığı için örneklem kabul kaydından gelmez.
 * Taban = yıl içinde tamamlanmış anketlerin uyum oranı ortalaması; performans incelemesi varsa ağırlıklı puanıyla eşit ağırlıkta ortalanır.
 * Puan = taban − doğrulanmış olay cezası − güncel kalan risk cezası (0 altına inmez). Kod hesaplar; AI kullanılmaz.
 */
export const SCORECARD_POLICY_VERSION = 'karne-2026-v2';
export const SCORECARD_RISK_PENALTY: Record<Level, number> = { LOW: 0, MEDIUM: 3, HIGH: 7, CRITICAL: 15 };
const round1 = (n: number) => Math.round(n * 10) / 10;

export function scorecardScore(input: { surveyRates: readonly (number | null)[]; review: { scores: Partial<Record<Dimension, number>>; weights: Record<Dimension, number> } | null;
  riskLevel: Level | null; incidentPenalty: number }) {
  const rates = input.surveyRates.filter((r): r is number => typeof r === 'number');
  const surveyMean = rates.length ? round1(rates.reduce((s, r) => s + r, 0) / rates.length) : null;
  const riskPenalty = input.riskLevel ? SCORECARD_RISK_PENALTY[input.riskLevel] : 0;
  const empty = { score: null, base: null, surveyMean, surveyCount: rates.length, reviewScore: null, riskPenalty, insufficient: true as const };
  let reviewScore: number | null = null;
  if (input.review) {
    const r = performanceScore(input.review.scores, input.review.weights, 0, 0, 0);
    if (r.insufficient) return { ...empty, reason: r.reason };
    reviewScore = r.base;
  }
  const parts = [surveyMean, reviewScore].filter((x): x is number => x !== null);
  if (!parts.length) return { ...empty, reason: 'Bu yıl için tamamlanmış anket ya da performans incelemesi yok.' };
  const base = round1(parts.reduce((s, x) => s + x, 0) / parts.length);
  const score = Math.max(0, round1(base - input.incidentPenalty - riskPenalty));
  return { score, base, surveyMean, surveyCount: rates.length, reviewScore, riskPenalty, insufficient: false as const, reason: null };
}

/** T20: kritik güvenlik engeli olan tedarikçiye seçim/sipariş, ticari puan ne olursa olsun önerilemez. */
export function criticalBlock(latest: { outcome: AssessmentOutcome; scope: string } | null): string | null {
  return latest?.outcome === 'BLOCKED' ? `Tedarikçi değerlendirmesinde kritik engel var (${latest.scope}); ticari puan bu engeli aşmaz.` : null;
}

export const levelMax = (a: Level, b: Level) => byRank(Math.max(RANK[a], RANK[b]));
