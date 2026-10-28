import { describe, expect, it } from 'vitest';
import { guaranteeStatus, priceRevision, revisedPrice, slaCredit, validateSlaTerm, type SlaTerm } from '../src/commercial.ts';

describe('endeksli fiyat revizyonu', () => {
  it('endeks farkı uygulanır; tavan artışı, taban düşüşü sınırlar', () => {
    expect(priceRevision({ baseIndex: '2000', capPercent: null, floorPercent: null }, '2150')).toEqual({ rawChangePercent: '7.5000', appliedChangePercent: '7.5000', factor: '1.075000', limitedBy: null });
    expect(priceRevision({ baseIndex: '2000', capPercent: '5', floorPercent: null }, '2150')).toMatchObject({ rawChangePercent: '7.5000', appliedChangePercent: '5.0000', factor: '1.050000', limitedBy: 'CAP' });
    expect(priceRevision({ baseIndex: '2000', capPercent: '5', floorPercent: '0' }, '1900')).toMatchObject({ rawChangePercent: '-5.0000', appliedChangePercent: '0.0000', factor: '1.000000', limitedBy: 'FLOOR' });
    expect(revisedPrice('1234.50', '1.075')).toBe('1327.087500');
    expect(() => priceRevision({ baseIndex: '0', capPercent: null, floorPercent: null }, '1')).toThrow();
  });
});

describe('SLA kredisi', () => {
  const term: SlaTerm = { direction: 'MIN', target: '99.9', periodFee: '40000.00', capPercent: '20',
    tiers: [{ threshold: '99.9', creditPercent: '5' }, { threshold: '99.5', creditPercent: '10' }, { threshold: '99', creditPercent: '25' }] };
  it('hedef tutarsa kredi yok; ihlalde geçilen en yüksek kademe; üst sınır uygulanır', () => {
    expect(slaCredit(term, '99.95')).toMatchObject({ breached: false, creditAmount: '0.00' });
    expect(slaCredit(term, '99.6')).toMatchObject({ breached: true, creditPercent: '5.0000', creditAmount: '2000.00' });
    expect(slaCredit(term, '99.2')).toMatchObject({ creditPercent: '10.0000', creditAmount: '4000.00', capped: false });
    expect(slaCredit(term, '98.0')).toMatchObject({ creditPercent: '20.0000', creditAmount: '8000.00', capped: true });
  });
  it('MAX yönü (süre): hedefi aşınca ihlal', () => {
    const t: SlaTerm = { direction: 'MAX', target: '4', periodFee: '10000', capPercent: null, tiers: [{ threshold: '4', creditPercent: '2' }, { threshold: '8', creditPercent: '5' }] };
    expect(slaCredit(t, '4')).toMatchObject({ breached: false });
    expect(slaCredit(t, '6')).toMatchObject({ creditAmount: '200.00' });
    expect(slaCredit(t, '9')).toMatchObject({ creditAmount: '500.00' });
  });
  it('kademe hedefin ihlal tarafında olmalı; oran 0–100', () => {
    expect(validateSlaTerm(term)).toBeNull();
    expect(validateSlaTerm({ ...term, tiers: [{ threshold: '99.95', creditPercent: '5' }] })).toContain('ihlal tarafında');
    expect(validateSlaTerm({ ...term, tiers: [{ threshold: '99', creditPercent: '150' }] })).toContain('0–100');
  });
});

describe('teminat durumu', () => {
  it('iade, süresiz, yaklaşan ve geçmiş bitiş', () => {
    expect(guaranteeStatus('2026-12-31', '2026-10-01', '2026-10-28')).toBe('RETURNED');
    expect(guaranteeStatus(null, null, '2026-10-28')).toBe('ACTIVE');
    expect(guaranteeStatus('2026-11-20', null, '2026-10-28')).toBe('EXPIRING');
    expect(guaranteeStatus('2027-01-20', null, '2026-10-28')).toBe('ACTIVE');
    expect(guaranteeStatus('2026-10-27', null, '2026-10-28')).toBe('EXPIRED');
  });
});
