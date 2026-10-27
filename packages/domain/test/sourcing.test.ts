import { describe, expect, it } from 'vitest';
import { add, dec, div, mul, str } from '../src/money.ts';
import { compareBids, evaluationBasis, unitFactor, validateAward, validateCriteria, type Bid, type Criterion, type ProjectLine } from '../src/sourcing.ts';

describe('ondalık hesap', () => {
  it('float hatası yok, yarım yukarı yuvarlar', () => {
    expect(str(add(dec('0.1'), dec('0.2')))).toBe('0.30');
    expect(str(mul(dec('1840000'), dec('0.18')))).toBe('331200.00');
    expect(str(div(dec('10'), dec('3')), 4)).toBe('3.3333');
    expect(str(dec('2.345'), 2)).toBe('2.35');
    expect(str(dec('-2.345'), 2)).toBe('-2.35');
    expect(() => dec('1e5')).toThrow();
  });
});

const lines: ProjectLine[] = [
  { id: 'L1', lot: 'Lot 1', description: 'Sunucu bakımı', unit: 'ay', quantity: '12' },
  { id: 'L2', lot: 'Lot 1', description: 'Yerinde destek', unit: 'saat', quantity: '480' },
  { id: 'L3', lot: 'Lot 2', description: 'Lisans yenileme', unit: 'kullanıcı', quantity: '250' },
];
const criteria: Criterion[] = [
  { code: 'PRICE', name: 'Fiyat', kind: 'PRICE', weight: '60' },
  { code: 'TECH', name: 'Teknik uygunluk', kind: 'SCORE', weight: '40' },
];
const bid = (id: string, over: Partial<Bid>): Bid => ({ bidId: id, supplierId: `s-${id}`, supplierName: id, supplierStatus: 'ACTIVE', currency: 'TRY', costs: [], lines: [], ...over });
const full = (p1: string, p2: string, p3: string) => [
  { projectLineId: 'L1', unit: 'ay', quantity: '12', unitPrice: p1, scope: 'INCLUDED' as const },
  { projectLineId: 'L2', unit: 'saat', quantity: '480', unitPrice: p2, scope: 'INCLUDED' as const },
  { projectLineId: 'L3', unit: 'kullanıcı', quantity: '250', unitPrice: p3, scope: 'INCLUDED' as const },
];

describe('T10 karşılaştırılamayan kapsam en ucuz sayılmaz', () => {
  const cheapButIncomplete = bid('ucuz', { lines: [
    { projectLineId: 'L1', unit: 'ay', quantity: '12', unitPrice: '30000', scope: 'INCLUDED' },
    { projectLineId: 'L2', unit: 'saat', quantity: '480', unitPrice: '300', scope: 'INCLUDED' },
    { projectLineId: 'L3', unit: 'paket', quantity: '1', unitPrice: '100000', scope: 'INCLUDED' },
  ] });
  const missingLine = bid('eksik', { lines: full('31000', '320', '1000').slice(0, 2) });
  const a = bid('A', { lines: full('42000', '450', '1250') });
  const b = bid('B', { lines: full('45000', '420', '1195'), costs: [{ kind: 'INSTALLATION', amount: '15000' }] });
  const r = compareBids({ currency: 'TRY', lines, bids: [cheapButIncomplete, missingLine, a, b], criteria,
    scores: [{ bidId: 'A', criterionCode: 'TECH', score: '80' }, { bidId: 'B', criterionCode: 'TECH', score: '90' }] });
  const by = (id: string) => r.bids.find((x) => x.bidId === id)!;

  it('yanlış birim ve eksik kalem görünür, toplam yok, sıralamaya girmez', () => {
    expect(by('ucuz').lines.find((l) => l.projectLineId === 'L3')!.state).toBe('UNIT_MISMATCH');
    expect(by('ucuz').complete).toBe(false);
    expect(by('ucuz').tco).toBeNull();
    expect(by('ucuz').rank).toBeNull();
    expect(by('ucuz').lotTotals['Lot 1']).toBe('504000.00');
    expect(by('ucuz').lotTotals['Lot 2']).toBeNull();
    expect(by('eksik').lines.find((l) => l.projectLineId === 'L3')!.state).toBe('MISSING');
    expect(by('eksik').priceScore).toBeNull();
  });
  it('TCO ve fiyat puanı yalnız tam kapsamlılar arasında', () => {
    expect(by('A').tco).toBe('1032500.00');
    expect(by('B').tco).toBe('1055350.00');
    expect(r.lowestTco).toBe('1032500.00');
    expect(by('A').priceScore).toBe('100.00');
    expect(by('B').priceScore).toBe('97.83');
    // A: 60 + 32 = 92; B: 97.83 × 0.6 + 36 = 94.70 → B önde (fiyat dışı fark görünür kalır)
    expect(by('A').weightedScore).toBe('92.00');
    expect(by('B').weightedScore).toBe('94.70');
    expect(by('B').rank).toBe(1);
  });
  it('kontrollü birim dönüşümü; belirsiz birim dönüşmez', () => {
    expect(str(unitFactor('yıl', 'ay')!, 2)).toBe('12.00');
    expect(unitFactor('paket', 'kullanıcı')).toBeNull();
    const yearly = bid('Y', { lines: [{ projectLineId: 'L1', unit: 'Yıl', quantity: '1', unitPrice: '480000', scope: 'INCLUDED' }, ...full('0', '400', '1000').slice(1)] });
    const ry = compareBids({ currency: 'TRY', lines, bids: [yearly], criteria, scores: [] });
    expect(ry.bids[0]!.lines[0]!.unitPrice).toBe('40000.0000');
    expect(ry.bids[0]!.lines[0]!.total).toBe('480000.00');
  });
  it('kur varsayımı yoksa karşılaştırılmaz; varsa kaynağıyla çevrilir', () => {
    const eur = bid('E', { currency: 'EUR', lines: full('1000', '10', '30') });
    expect(compareBids({ currency: 'TRY', lines, bids: [eur], criteria, scores: [] }).bids[0]!.lines[0]!.state).toBe('NO_FX_RATE');
    const withFx = compareBids({ currency: 'TRY', lines, bids: [eur], criteria, scores: [], fx: [{ currency: 'EUR', rate: '38.5', source: 'TCMB döviz satış', asOf: '2026-10-27' }] });
    expect(withFx.bids[0]!.tco).toBe(str(add(mul(dec('12000'), dec('38.5')), mul(dec('4800'), dec('38.5')), mul(dec('7500'), dec('38.5')))));
  });
  it('kritik engel ticari puanla aşılamaz (T20 kuralı)', () => {
    const rb = compareBids({ currency: 'TRY', lines, bids: [a, { ...b, blocker: 'Bilgi güvenliği: kritik bulgu açık' }], criteria,
      scores: [{ bidId: 'A', criterionCode: 'TECH', score: '80' }, { bidId: 'B', criterionCode: 'TECH', score: '100' }] });
    expect(rb.bids.find((x) => x.bidId === 'B')!.rank).toBeNull();
    expect(rb.bids.find((x) => x.bidId === 'A')!.rank).toBe(1);
  });
  it('kriter ağırlıkları 100 etmeli', () => {
    expect(validateCriteria(criteria)).toBeNull();
    expect(validateCriteria([{ ...criteria[0]!, weight: '50' }, criteria[1]!])).toMatch(/100/);
  });
});

describe('T11 değerlendirme dayanağı değişirse eskir', () => {
  it('teklif sürümü, ağırlık veya puan değişince parmak izi değişir; sıra değişmesi değiştirmez', () => {
    const base = evaluationBasis({ bidIds: ['b1', 'b2'], criteria, scores: [{ bidId: 'b1', criterionCode: 'TECH', score: '80' }] });
    expect(evaluationBasis({ bidIds: ['b2', 'b1'], criteria: [...criteria].reverse(), scores: [{ bidId: 'b1', criterionCode: 'TECH', score: '80.0' }] })).toBe(base);
    expect(evaluationBasis({ bidIds: ['b1', 'b3'], criteria, scores: [{ bidId: 'b1', criterionCode: 'TECH', score: '80' }] })).not.toBe(base);
    expect(evaluationBasis({ bidIds: ['b1', 'b2'], criteria: [{ ...criteria[0]!, weight: '50' }, { ...criteria[1]!, weight: '50' }], scores: [{ bidId: 'b1', criterionCode: 'TECH', score: '80' }] })).not.toBe(base);
  });
});

describe('T12 bölünmüş tahsis', () => {
  const a = bid('A', { lines: full('42000', '450', '1250') });
  const c = bid('C', { supplierStatus: 'CANDIDATE', lines: full('41000', '440', '1200') });
  const cmpd = compareBids({ currency: 'TRY', lines, bids: [a, c], criteria, scores: [] });
  it('iki tedarikçiye bölünen satır toplamı ihtiyacı aşamaz', () => {
    const ok = validateAward({ lines, comparison: cmpd, forApproval: false, allocations: [
      { projectLineId: 'L2', supplierId: 's-A', quantity: '300' }, { projectLineId: 'L2', supplierId: 's-C', quantity: '180' }] });
    expect(ok.issues).toEqual([]);
    expect(ok.byLine.L2).toBe('480.00');
    expect(ok.total).toBe(str(add(mul(dec('450'), dec('300')), mul(dec('440'), dec('180')))));
    const over = validateAward({ lines, comparison: cmpd, forApproval: false, allocations: [
      { projectLineId: 'L2', supplierId: 's-A', quantity: '300' }, { projectLineId: 'L2', supplierId: 's-C', quantity: '200' }] });
    expect(over.issues.map((i) => i.code)).toEqual(['over_allocated']);
  });
  it('aday firma onayda kesin kazanan olamaz; teklif vermediği satıra tahsis edilemez', () => {
    const r = validateAward({ lines, comparison: cmpd, forApproval: true, allocations: [{ projectLineId: 'L1', supplierId: 's-C', quantity: '12' }] });
    expect(r.issues.map((i) => i.code)).toEqual(['supplier_not_active']);
    const nb = validateAward({ lines, comparison: cmpd, forApproval: false, allocations: [{ projectLineId: 'L1', supplierId: 's-X', quantity: '1' }] });
    expect(nb.issues.map((i) => i.code)).toEqual(['not_comparable']);
  });
});
