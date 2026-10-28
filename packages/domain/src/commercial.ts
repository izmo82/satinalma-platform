import { cmp, dec, div, mul, str, type Dec } from './money.ts';

/**
 * Sözleşme ticari kuralları (FR08–FR09, 02 §11): endeksli fiyat revizyonu, SLA ceza/kredi hesabı ve teminat durumu.
 * Kural sözleşme maddesinden girilir; bu modül yalnız girilen kuralı uygular. Sonuç insan onayı/doğrulaması olmadan
 * borç, alacak veya ödeme doğurmaz (02 §11: "SLA ihlalinin ceza veya kredi doğurması ilgili madde ve insan doğrulamasına bağlıdır").
 */

const HUNDRED = dec('100');

export interface PriceRevisionRule { baseIndex: string; capPercent: string | null; floorPercent: string | null }
export interface PriceRevisionResult {
  /** Endeks değişimi (%) — 4 basamak. */
  rawChangePercent: string;
  /** Tavan/taban uygulanmış değişim (%). */
  appliedChangePercent: string;
  /** Yeni fiyat = eski fiyat × katsayı (6 basamak). */
  factor: string;
  limitedBy: 'CAP' | 'FLOOR' | null;
}

/**
 * Endeks farkı: (yeni / baz − 1) × 100. Tavan artışı, taban düşüşü sınırlar (taban pozitif yazılır: 5 = en çok %5 düşüş).
 * Taban yoksa düşüş sınırsız uygulanır; sözleşme yalnız artışa izin veriyorsa taban 0 girilir.
 */
export function priceRevision(rule: PriceRevisionRule, newIndex: string): PriceRevisionResult {
  const base = dec(rule.baseIndex);
  if (base <= 0n) throw new Error('baz endeks pozitif olmalı');
  const next = dec(newIndex);
  if (next <= 0n) throw new Error('endeks değeri pozitif olmalı');
  const raw = mul(div(next, base) - dec('1'), HUNDRED);
  let applied = raw;
  let limitedBy: PriceRevisionResult['limitedBy'] = null;
  if (rule.capPercent !== null && cmp(raw, dec(rule.capPercent)) > 0) { applied = dec(rule.capPercent); limitedBy = 'CAP'; }
  if (rule.floorPercent !== null && cmp(raw, -dec(rule.floorPercent)) < 0) { applied = -dec(rule.floorPercent); limitedBy = 'FLOOR'; }
  return { rawChangePercent: str(raw, 4), appliedChangePercent: str(applied, 4), factor: str(dec('1') + div(applied, HUNDRED), 6), limitedBy };
}

/** Revize birim fiyat (6 basamak; fatura/sipariş birim fiyatı hassasiyetiyle). */
export const revisedPrice = (price: string, factor: string) => str(mul(dec(price), dec(factor)), 6);

export interface SlaTier { threshold: string; creditPercent: string }
export interface SlaTerm {
  /** MIN: ölçüm hedefin altına düşerse ihlal (ör. erişilebilirlik %). MAX: hedefi aşarsa ihlal (ör. çözüm süresi). */
  direction: 'MIN' | 'MAX';
  target: string;
  /** Kademeler: ölçüm kademe eşiğini de geçerse o kademenin kredisi. En yüksek geçerli kademe uygulanır. */
  tiers: SlaTier[];
  /** Dönem başına üst sınır (dönem bedelinin %'si). */
  capPercent: string | null;
  /** Dönem (ay) bedeli: kredinin matrahı. */
  periodFee: string;
}
export interface SlaResult { breached: boolean; creditPercent: string; creditAmount: string; tier: SlaTier | null; capped: boolean }

const breaches = (direction: 'MIN' | 'MAX', measured: Dec, threshold: Dec) => (direction === 'MIN' ? measured < threshold : measured > threshold);

export function slaCredit(term: SlaTerm, measured: string): SlaResult {
  const m = dec(measured);
  if (!breaches(term.direction, m, dec(term.target))) return { breached: false, creditPercent: '0.0000', creditAmount: '0.00', tier: null, capped: false };
  // Hedef ihlal edildi; kademe eşikleri hedefin ötesinde. Eşiği geçilen kademelerden en yüksek kredi.
  let best: SlaTier | null = null;
  for (const t of term.tiers) if (breaches(term.direction, m, dec(t.threshold))) {
    if (!best || cmp(dec(t.creditPercent), dec(best.creditPercent)) > 0) best = t;
  }
  let pct = best ? dec(best.creditPercent) : 0n;
  let capped = false;
  if (term.capPercent !== null && cmp(pct, dec(term.capPercent)) > 0) { pct = dec(term.capPercent); capped = true; }
  return { breached: true, creditPercent: str(pct, 4), creditAmount: str(div(mul(dec(term.periodFee), pct), HUNDRED)), tier: best, capped };
}

export function validateSlaTerm(t: SlaTerm): string | null {
  for (const v of [t.target, t.periodFee, ...(t.capPercent !== null ? [t.capPercent] : [])]) if (!/^\d{1,14}(\.\d{1,6})?$/.test(v)) return 'Hedef, dönem bedeli ve üst sınır sıfır veya pozitif ondalık olmalı.';
  if (!t.tiers.length) return 'En az bir kredi kademesi gerekli.';
  for (const k of t.tiers) {
    if (!/^\d{1,14}(\.\d{1,6})?$/.test(k.threshold) || !/^\d{1,3}(\.\d{1,4})?$/.test(k.creditPercent) || cmp(dec(k.creditPercent), HUNDRED) > 0) return 'Kademe eşiği ondalık, kredi oranı 0–100 olmalı.';
    // Kademe hedefin ihlal tarafında olmalı (MIN: hedef ve altı, MAX: hedef ve üstü).
    if (t.direction === 'MIN' ? cmp(dec(k.threshold), dec(t.target)) > 0 : cmp(dec(k.threshold), dec(t.target)) < 0) return `Kademe eşiği ${k.threshold} hedefin ihlal tarafında olmalı.`;
  }
  if (t.capPercent !== null && cmp(dec(t.capPercent), HUNDRED) > 0) return 'Üst sınır %100\'ü aşamaz.';
  return null;
}

export type GuaranteeStatus = 'ACTIVE' | 'EXPIRING' | 'EXPIRED' | 'RETURNED';
/** Teminat durumu türetilir: iade edildiyse RETURNED; süresiz değilse bitişe ≤ uyarı günü kaldıysa EXPIRING, geçtiyse EXPIRED. */
export function guaranteeStatus(validUntil: string | null, returnedAt: string | null, today: string, warnDays = 30): GuaranteeStatus {
  if (returnedAt) return 'RETURNED';
  if (!validUntil) return 'ACTIVE';
  if (validUntil < today) return 'EXPIRED';
  const days = (Date.parse(`${validUntil}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / 86_400_000;
  return days <= warnDays ? 'EXPIRING' : 'ACTIVE';
}
