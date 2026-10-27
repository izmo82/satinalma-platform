import { add, cmp, dec, div, isDecimal, min, mul, str, type Dec } from './money.ts';

/**
 * Teklif karşılaştırması (FR01–FR04, 02 §6). Saf ve deterministik: aynı girdi her yerde aynı sonucu verir.
 * Karşılaştırılamayan kapsam (eksik kalem, kapsam dışı, birim farkı, eksik miktar, kur yok) fiyat sıralamasına girmez (T10).
 */

export type Scope = 'INCLUDED' | 'EXCLUDED' | 'ALTERNATIVE';
export type LineState = 'COMPARABLE' | 'MISSING' | 'EXCLUDED' | 'ALTERNATIVE' | 'UNIT_MISMATCH' | 'QUANTITY_SHORT' | 'NO_FX_RATE';

export interface ProjectLine { id: string; lot: string; description: string; unit: string; quantity: string }
export interface BidLine { projectLineId: string; unit: string; quantity: string; unitPrice: string; scope: Scope }
export interface BidCost { kind: 'SHIPPING' | 'INSTALLATION' | 'MAINTENANCE' | 'RENEWAL' | 'OTHER'; amount: string }
export interface Bid {
  bidId: string; supplierId: string; supplierName: string; supplierStatus: string; currency: string;
  lines: BidLine[]; costs: BidCost[];
  /** Bilgi güvenliği gibi kritik engel: ticari puanla aşılamaz (T20, 02 §6). */
  blocker?: string | null;
}
export interface Criterion { code: string; name: string; kind: 'PRICE' | 'SCORE'; weight: string }
export interface Score { bidId: string; criterionCode: string; score: string }
/** Proje para birimine çevrim: 1 birim yabancı para = rate proje parası. Kaynak ve tarih rapora yazılır. */
export interface FxRate { currency: string; rate: string; source: string; asOf: string }

export const LINE_STATE_TEXT: Record<LineState, string> = {
  COMPARABLE: 'Karşılaştırılabilir',
  MISSING: 'Teklif edilmedi',
  EXCLUDED: 'Kapsam dışı bırakıldı',
  ALTERNATIVE: 'Alternatif teklif (ayrı senaryo)',
  UNIT_MISMATCH: 'Birim dönüştürülemiyor',
  QUANTITY_SHORT: 'Miktar eksik',
  NO_FX_RATE: 'Kur varsayımı yok',
};

/** Kontrollü birim dönüşümü: yalnız tanımlı çiftler. "paket" gibi içeriği belirsiz birim dönüştürülmez. */
const UNIT_FACTORS: Record<string, Record<string, string>> = {
  'yıl': { 'ay': '12' },
  'gün': { 'saat': '8' },
  'düzine': { 'adet': '12' },
};
export const normalizeUnit = (u: string) => u.trim().toLocaleLowerCase('tr-TR');

/** bidUnit cinsinden 1 birim, lineUnit cinsinden kaç birimdir; dönüştürülemezse null. */
export function unitFactor(bidUnit: string, lineUnit: string): Dec | null {
  const a = normalizeUnit(bidUnit), b = normalizeUnit(lineUnit);
  if (a === b) return dec('1');
  const f = UNIT_FACTORS[a]?.[b];
  if (f) return dec(f);
  const r = UNIT_FACTORS[b]?.[a];
  return r ? div(dec('1'), dec(r)) : null;
}

export interface LineResult {
  projectLineId: string; state: LineState; reason: string;
  /** Proje birimi cinsinden birim fiyat ve satır toplamı (proje parası); yalnız COMPARABLE için. */
  unitPrice: string | null; total: string | null;
  original: { unit: string; quantity: string; unitPrice: string; currency: string } | null;
}
export interface BidResult {
  bidId: string; supplierId: string; supplierName: string; supplierStatus: string;
  lines: LineResult[];
  /** Tüm kalemler karşılaştırılabilir mi; değilse toplam sıralamaya girmez. */
  complete: boolean;
  missingLines: string[];
  linesTotal: string | null; costsTotal: string | null; tco: string | null;
  lotTotals: Record<string, string | null>;
  blocker: string | null;
  priceScore: string | null; weightedScore: string | null; rank: number | null;
  scoreGaps: string[];
}
export interface Comparison { currency: string; fx: FxRate[]; bids: BidResult[]; lowestTco: string | null; criteriaValid: boolean; criteriaError: string | null }

export function validateCriteria(criteria: Criterion[]): string | null {
  if (!criteria.length) return 'En az bir değerlendirme kriteri gerekli.';
  if (!criteria.some((c) => c.kind === 'PRICE')) return 'Fiyat kriteri tanımlı değil.';
  if (criteria.filter((c) => c.kind === 'PRICE').length > 1) return 'Yalnız bir fiyat kriteri olabilir.';
  for (const c of criteria) if (!isDecimal(c.weight) || cmp(dec(c.weight), 0n) <= 0) return `Geçersiz ağırlık: ${c.name}`;
  if (cmp(add(...criteria.map((c) => dec(c.weight))), dec('100')) !== 0) return 'Ağırlıkların toplamı 100 olmalı.';
  return null;
}

export function compareBids(input: {
  currency: string; lines: ProjectLine[]; bids: Bid[]; criteria: Criterion[]; scores: Score[]; fx?: FxRate[];
}): Comparison {
  const fx = input.fx ?? [];
  const rateOf = (cur: string): Dec | null => cur === input.currency ? dec('1') : (fx.find((f) => f.currency === cur) ? dec(fx.find((f) => f.currency === cur)!.rate) : null);
  const lots = [...new Set(input.lines.map((l) => l.lot))];

  const results: BidResult[] = input.bids.map((b) => {
    const rate = rateOf(b.currency);
    const lines: LineResult[] = input.lines.map((pl) => {
      const bl = b.lines.find((x) => x.projectLineId === pl.id);
      const original = bl ? { unit: bl.unit, quantity: bl.quantity, unitPrice: bl.unitPrice, currency: b.currency } : null;
      const out = (state: LineState, extra = ''): LineResult => ({ projectLineId: pl.id, state, reason: LINE_STATE_TEXT[state] + extra, unitPrice: null, total: null, original });
      if (!bl) return out('MISSING');
      if (bl.scope === 'EXCLUDED') return out('EXCLUDED');
      if (bl.scope === 'ALTERNATIVE') return out('ALTERNATIVE');
      const f = unitFactor(bl.unit, pl.unit);
      if (!f) return out('UNIT_MISMATCH', `: "${bl.unit}" → "${pl.unit}"`);
      if (cmp(mul(dec(bl.quantity), f), dec(pl.quantity)) < 0) return out('QUANTITY_SHORT', `: ${str(mul(dec(bl.quantity), f), 2)} / ${pl.quantity} ${pl.unit}`);
      if (!rate) return out('NO_FX_RATE', `: ${b.currency}`);
      const unitPrice = mul(div(dec(bl.unitPrice), f), rate);
      return { projectLineId: pl.id, state: 'COMPARABLE', reason: LINE_STATE_TEXT.COMPARABLE, unitPrice: str(unitPrice, 4), total: str(mul(unitPrice, dec(pl.quantity))), original };
    });
    const missingLines = lines.filter((l) => l.state !== 'COMPARABLE').map((l) => l.projectLineId);
    const complete = missingLines.length === 0;
    const lotTotals: Record<string, string | null> = {};
    for (const lot of lots) {
      const ls = input.lines.filter((l) => l.lot === lot).map((pl) => lines.find((r) => r.projectLineId === pl.id)!);
      lotTotals[lot] = ls.every((l) => l.state === 'COMPARABLE') ? str(add(...ls.map((l) => dec(l.total!)))) : null;
    }
    const costsTotal = rate ? add(...b.costs.map((c) => mul(dec(c.amount), rate))) : null;
    const linesTotal = complete ? add(...lines.map((l) => dec(l.total!))) : null;
    return {
      bidId: b.bidId, supplierId: b.supplierId, supplierName: b.supplierName, supplierStatus: b.supplierStatus, lines, complete, missingLines,
      linesTotal: linesTotal === null ? null : str(linesTotal), costsTotal: costsTotal === null ? null : str(costsTotal),
      tco: linesTotal !== null && costsTotal !== null ? str(add(linesTotal, costsTotal)) : null,
      lotTotals, blocker: b.blocker ?? null, priceScore: null, weightedScore: null, rank: null, scoreGaps: [],
    };
  });

  const criteriaError = validateCriteria(input.criteria);
  // Fiyat puanı yalnız tam kapsamlı, pozitif TCO'lu ve engelsiz teklifler arasında (02 §6 formülü).
  const eligible = results.filter((r) => r.complete && r.tco !== null && cmp(dec(r.tco), 0n) > 0 && !r.blocker);
  const lowest = eligible.length ? min(eligible.map((r) => dec(r.tco!))) : null;
  for (const r of eligible) {
    r.priceScore = str(div(mul(dec('100'), lowest!), dec(r.tco!)), 2);
    if (criteriaError) continue;
    let total = 0n;
    for (const c of input.criteria) {
      const w = dec(c.weight);
      if (c.kind === 'PRICE') { total += div(mul(dec(r.priceScore), w), dec('100')); continue; }
      const s = input.scores.find((x) => x.bidId === r.bidId && x.criterionCode === c.code);
      if (!s) { r.scoreGaps.push(c.code); continue; }
      total += div(mul(dec(s.score), w), dec('100'));
    }
    r.weightedScore = r.scoreGaps.length ? null : str(total, 2);
  }
  const ranked = eligible.filter((r) => r.weightedScore !== null).sort((a, b) => cmp(dec(b.weightedScore!), dec(a.weightedScore!)));
  ranked.forEach((r, i) => { r.rank = i + 1; });
  return { currency: input.currency, fx, bids: results, lowestTco: lowest === null ? null : str(lowest), criteriaValid: !criteriaError, criteriaError };
}

/** Değerlendirmenin dayandığı veri: teklif sürümleri + kriter/ağırlıklar + puanlar. Değişince karar eskir (T11). */
export function evaluationBasis(input: { bidIds: string[]; criteria: Criterion[]; scores: Score[]; fx?: FxRate[] }): string {
  return JSON.stringify({
    b: [...input.bidIds].sort(),
    c: [...input.criteria].sort((a, b) => a.code.localeCompare(b.code)).map((c) => [c.code, c.kind, str(dec(c.weight), 4)]),
    s: [...input.scores].sort((a, b) => (a.bidId + a.criterionCode).localeCompare(b.bidId + b.criterionCode)).map((s) => [s.bidId, s.criterionCode, str(dec(s.score), 2)]),
    f: [...(input.fx ?? [])].sort((a, b) => a.currency.localeCompare(b.currency)).map((f) => [f.currency, f.rate, f.asOf]),
  });
}

export interface AwardAllocation { projectLineId: string; supplierId: string; quantity: string }
export interface AwardIssue { code: string; message: string; projectLineId?: string; supplierId?: string }

/**
 * Kazanan tahsisi (T12): satır/lot bir veya birden çok tedarikçiye bölünebilir.
 * Kontroller: miktar pozitif, satır toplamı ihtiyacı aşmaz, tedarikçinin o satırda karşılaştırılabilir teklifi var,
 * onay için tedarikçi aktif (aday firma kesin kazanan olamaz, BR02) ve kritik engeli yok.
 */
export function validateAward(input: {
  lines: ProjectLine[]; comparison: Comparison; allocations: AwardAllocation[]; forApproval: boolean;
}): { issues: AwardIssue[]; total: string; byLine: Record<string, string> } {
  const issues: AwardIssue[] = [];
  const byLine: Record<string, Dec> = {};
  let total = 0n;
  if (!input.allocations.length) issues.push({ code: 'empty', message: 'En az bir tahsis satırı gerekli.' });
  for (const a of input.allocations) {
    const pl = input.lines.find((l) => l.id === a.projectLineId);
    if (!pl) { issues.push({ code: 'unknown_line', message: 'Projede olmayan kalem.', projectLineId: a.projectLineId }); continue; }
    if (!isDecimal(a.quantity) || cmp(dec(a.quantity), 0n) <= 0) { issues.push({ code: 'quantity', message: `${pl.description}: miktar pozitif olmalı.`, projectLineId: pl.id }); continue; }
    const bid = input.comparison.bids.find((b) => b.supplierId === a.supplierId);
    const lr = bid?.lines.find((l) => l.projectLineId === pl.id);
    if (!bid || !lr || lr.state !== 'COMPARABLE') {
      issues.push({ code: 'not_comparable', message: `${pl.description}: ${bid?.supplierName ?? 'tedarikçi'} için karşılaştırılabilir teklif yok.`, projectLineId: pl.id, supplierId: a.supplierId });
      continue;
    }
    if (bid.blocker) issues.push({ code: 'blocked', message: `${bid.supplierName}: ${bid.blocker}`, supplierId: a.supplierId });
    if (input.forApproval && bid.supplierStatus !== 'ACTIVE') {
      issues.push({ code: 'supplier_not_active', message: `${bid.supplierName} aktif tedarikçi değil; aktivasyon onayı olmadan kesin kazanan olamaz.`, supplierId: a.supplierId });
    }
    byLine[pl.id] = add(byLine[pl.id] ?? 0n, dec(a.quantity));
    total += mul(dec(lr.unitPrice!), dec(a.quantity));
  }
  for (const [lineId, q] of Object.entries(byLine)) {
    const pl = input.lines.find((l) => l.id === lineId)!;
    if (cmp(q, dec(pl.quantity)) > 0) issues.push({ code: 'over_allocated', message: `${pl.description}: tahsis ${str(q, 2)} > ihtiyaç ${pl.quantity} ${pl.unit}.`, projectLineId: lineId });
  }
  const seen = new Set<string>();
  for (const i of issues) { const k = i.code + (i.projectLineId ?? '') + (i.supplierId ?? ''); if (seen.has(k)) i.code = '_dup'; seen.add(k); }
  return {
    issues: issues.filter((i) => i.code !== '_dup'),
    total: str(total),
    byLine: Object.fromEntries(Object.entries(byLine).map(([k, v]) => [k, str(v, 2)])),
  };
}
