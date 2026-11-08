import { describe, expect, it } from 'vitest';
import {
  advanceFinding, claimDraft, daysBetween, earlyPaymentFinding, evidenceGaps, fxDifferenceFinding, guaranteeFinding, isFxDifferenceText, sumByCurrency,
  type FxDiffInput,
} from '../src/recovery.ts';

const orig = { id: 'o1', no: 'USD2026000010', currency: 'USD', net: '10000.00', issueDate: '2026-04-01', paidAt: '2026-05-02', rateAtIssue: '38.000000', rateAtPayment: '41.500000' };
const fx = (over: Partial<FxDiffInput> = {}): FxDiffInput => ({
  invoice: { id: 'i1', no: 'KF2026000001', issueDate: '2026-05-10', currency: 'TRY', net: '50000.00' },
  credited: '0', contract: { id: 'c1', title: 'Bakım', sourceRef: 'Madde 7.3', rule: 'ALLOWED' }, originals: [orig], ...over,
});

describe('kur farkı', () => {
  it('açıklamadan tanınır; Türkçe büyük I/İ farkı gözetilmez', () => {
    expect(isFxDifferenceText('USD2026000010 nolu faturanın KUR FARKI')).toBe(true);
    expect(isFxDifferenceText('Kur Farkı Faturası')).toBe(true);
    expect(isFxDifferenceText('Kurulum hizmeti')).toBe(false);
  });

  it('sözleşme izin vermiyorsa faturanın tamamı geri alınabilir', () => {
    const f = fxDifferenceFinding(fx({ contract: { id: 'c1', title: 'Bakım', sourceRef: 'Madde 7.3', rule: 'NOT_ALLOWED' } }))!;
    expect(f).toMatchObject({ kind: 'FX_DIFF_NOT_ALLOWED', amount: '50000.00', subjectKey: 'fx:i1', contractVersionId: 'c1' });
    expect(f.summary).toContain('Madde 7.3');
  });

  it('izin varsa hak edilen fark kurla hesaplanır; aşan kısım bulgu, yuvarlama farkı değil', () => {
    // 10.000 USD × (41,5 − 38) = 35.000 TL hak edilen; 50.000 faturalanmış → 15.000 fazla.
    expect(fxDifferenceFinding(fx())).toMatchObject({ kind: 'FX_DIFF_EXCESS', amount: '15000.00', basis: { expected: '35000.00',
      formula: 'Hak edilen: 10.000,00 USD × (41,5 − 38) = 35.000,00 TRY; fark: 50.000,00 TRY − 35.000,00 TRY = 15.000,00 TRY' } });
    expect(fxDifferenceFinding(fx({ invoice: { id: 'i1', no: 'KF', issueDate: '2026-05-10', currency: 'TRY', net: '35001.00' } }))).toBeNull();
    expect(fxDifferenceFinding(fx({ invoice: { id: 'i1', no: 'KF', issueDate: '2026-05-10', currency: 'TRY', net: '35001.01' } }))?.amount).toBe('1.01');
  });

  it('kur düştüyse hak edilen fark sıfır: faturanın tamamı fazla', () => {
    expect(fxDifferenceFinding(fx({ originals: [{ ...orig, rateAtPayment: '37.000000' }] }))).toMatchObject({ kind: 'FX_DIFF_EXCESS', amount: '50000.00' });
  });

  it('birden fazla döviz faturaya ait kur farkında hak edilen farklar toplanır (biri eksikse incelenmeli)', () => {
    const o2 = { ...orig, id: 'o2', no: 'USD2026000011', net: '4000.00', rateAtIssue: '39.000000', rateAtPayment: '41.500000' };
    // 35.000 + 4.000 × 2,5 = 45.000 hak edilen; 50.000 − 45.000 = 5.000 fazla.
    expect(fxDifferenceFinding(fx({ originals: [orig, o2] }))).toMatchObject({ kind: 'FX_DIFF_EXCESS', amount: '5000.00', basis: { expected: '45000.00', originalNo: 'USD2026000010, USD2026000011' } });
    expect(fxDifferenceFinding(fx({ originals: [orig, { ...o2, paidAt: null }] }))).toMatchObject({ kind: 'FX_DIFF_UNVERIFIED', basis: { reason: 'not_paid' } });
  });

  it('iade faturasıyla geri verilen kısım düşülür; tamamı iade edildiyse bulgu yok', () => {
    const no = { id: 'c1', title: 'Bakım', sourceRef: 'Madde 7.3', rule: 'NOT_ALLOWED' as const };
    expect(fxDifferenceFinding(fx({ contract: no, credited: '20000.00' }))).toMatchObject({ amount: '30000.00', basis: { billed: '30000.00', credited: '20000.00' } });
    expect(fxDifferenceFinding(fx({ contract: no, credited: '50000.00' }))).toBeNull();
  });

  it('veri eksikse tutar uydurulmaz: incelenmeli', () => {
    for (const [over, reason] of [
      [{ contract: null }, 'no_contract'],
      [{ contract: { id: 'c1', title: 'Bakım', sourceRef: 'M', rule: null } }, 'no_rule'],
      [{ originals: [] }, 'no_original'],
      [{ originals: [{ ...orig, paidAt: null }] }, 'not_paid'],
      [{ originals: [{ ...orig, rateAtPayment: null }] }, 'no_rate'],
    ] as const) {
      expect(fxDifferenceFinding(fx(over as Partial<FxDiffInput>))).toMatchObject({ kind: 'FX_DIFF_UNVERIFIED', amount: null, basis: { reason } });
    }
  });
});

describe('avans', () => {
  const adv = { id: 'a1', no: 'AV2026000001', issueDate: '2026-01-10', currency: 'TRY', net: '200000.00' };
  it('bakiye varsa ve uzun süredir mahsup yoksa bulgu; kalan bakiye tutardır', () => {
    expect(advanceFinding({ advance: adv, offsetTotal: '120000.00', lastOffsetDate: '2026-03-01', contract: null, today: '2026-06-01' }))
      .toMatchObject({ kind: 'ADVANCE_UNOFFSET', amount: '80000.00', subjectKey: 'adv:a1' });
  });
  it('yakında mahsup yapıldıysa veya avans yeniyse bulgu yok; sözleşme bittiyse süre beklenmez', () => {
    expect(advanceFinding({ advance: adv, offsetTotal: '120000.00', lastOffsetDate: '2026-05-20', contract: null, today: '2026-06-01' })).toBeNull();
    expect(advanceFinding({ advance: { ...adv, issueDate: '2026-05-01' }, offsetTotal: '0', lastOffsetDate: null, contract: null, today: '2026-06-01' })).toBeNull();
    expect(advanceFinding({ advance: { ...adv, issueDate: '2026-05-01' }, offsetTotal: '0', lastOffsetDate: null,
      contract: { id: 'c', title: 'Bakım', endDate: '2026-05-31' }, today: '2026-06-01' })?.amount).toBe('200000.00');
  });
  it('tamamen mahsup veya iade edilmişse bulgu yok; iade bakiyeden düşülür', () => {
    expect(advanceFinding({ advance: adv, offsetTotal: '200000.00', lastOffsetDate: null, contract: null, today: '2027-01-01' })).toBeNull();
    expect(advanceFinding({ advance: adv, offsetTotal: '120000.00', credited: '80000.00', lastOffsetDate: null, contract: null, today: '2027-01-01' })).toBeNull();
    expect(advanceFinding({ advance: adv, offsetTotal: '120000.00', credited: '30000.00', lastOffsetDate: null, contract: null, today: '2027-01-01' })?.amount).toBe('50000.00');
  });
});

describe('erken ödeme', () => {
  const inv = { id: 'i1', no: 'F1', issueDate: '2026-03-01', paidAt: '2026-03-16', currency: 'TRY', payable: '1000000.00' };
  const c = { id: 'c1', title: 'Bakım', paymentTerms: 'Fatura tarihinden itibaren 60 gün', paymentDays: 60 };
  it('vadeden önce ödeme sermaye maliyetiyle hesaplanır (basit faiz, 365 gün)', () => {
    // 1.000.000 × %45 × 45 / 365 = 55.479,45
    const f = earlyPaymentFinding({ invoice: inv, contract: c, annualRate: '45' })!;
    expect(f).toMatchObject({ kind: 'EARLY_PAYMENT', amount: '55479.45', basis: { daysEarly: 45, due: '2026-04-30', paymentTerms: 'Fatura tarihinden itibaren 60 gün' } });
    // Dayanak vade maddesini gösterir; koşulların ortak kaynak maddesi (çoğu zaman kur/tavan maddesi) gösterilmez.
    expect(f.basis).not.toHaveProperty('sourceRef');
    expect(f.basis.formula).toBe('1.000.000,00 TRY × %45 × 45 / 365 = 55.479,45 TRY');
  });
  it('oran, vade veya ödeme tarihi yoksa ya da vadede ödendiyse bulgu yok', () => {
    expect(earlyPaymentFinding({ invoice: inv, contract: c, annualRate: null })).toBeNull();
    expect(earlyPaymentFinding({ invoice: inv, contract: { ...c, paymentDays: null }, annualRate: '45' })).toBeNull();
    expect(earlyPaymentFinding({ invoice: { ...inv, paidAt: null }, contract: c, annualRate: '45' })).toBeNull();
    expect(earlyPaymentFinding({ invoice: { ...inv, paidAt: '2026-04-30' }, contract: c, annualRate: '45' })).toBeNull();
  });
});

describe('teminat', () => {
  const g = { id: 'g1', kind: 'PERFORMANCE', referenceNo: 'TM-1', issuer: 'Örnek Bank', amount: '250000.00', currency: 'TRY', validUntil: '2026-06-20' };
  it('sözleşme sürerken 30 gün içinde biten veya bitmiş teminat risktir', () => {
    expect(guaranteeFinding({ guarantee: g, contract: { id: 'c', title: 'Bakım', endDate: '2027-01-01' }, today: '2026-06-01' }))
      .toMatchObject({ kind: 'GUARANTEE_EXPIRY', amount: '250000.00', basis: { expired: false } });
    expect(guaranteeFinding({ guarantee: g, contract: { id: 'c', title: 'Bakım', endDate: null }, today: '2026-07-01' })?.basis.expired).toBe(true);
  });
  it('uzak bitiş veya sözleşmeden sonra biten teminat sorun değil', () => {
    expect(guaranteeFinding({ guarantee: g, contract: { id: 'c', title: 'Bakım', endDate: '2027-01-01' }, today: '2026-04-01' })).toBeNull();
    expect(guaranteeFinding({ guarantee: g, contract: { id: 'c', title: 'Bakım', endDate: '2026-06-15' }, today: '2026-06-01' })).toBeNull();
  });
});

describe('kanıt zinciri ve yardımcılar', () => {
  it('eksik halkalar ayrı ayrı sayılır', () => {
    expect(evidenceGaps({ allocations: [] })).toEqual(['NO_ALLOCATION']);
    expect(evidenceGaps({ allocations: [{ poLineId: 'p', contractVersionId: 'c', hasReceipt: true, termsVerified: true }] })).toEqual([]);
    expect(evidenceGaps({ allocations: [{ poLineId: 'p', contractVersionId: null, hasReceipt: false, termsVerified: false }] }).sort()).toEqual(['NO_CONTRACT', 'NO_RECEIPT']);
    expect(evidenceGaps({ allocations: [{ poLineId: null, contractVersionId: 'c', hasReceipt: false, termsVerified: false }] })).toEqual(['TERMS_UNVERIFIED']);
  });
  it('para birimi başına toplam; TRY önce', () => {
    expect(sumByCurrency([{ currency: 'USD', amount: '1.10' }, { currency: 'TRY', amount: '5.00' }, { currency: 'USD', amount: '2.00' }])).toEqual({ TRY: '5.00', USD: '3.10' });
    expect(Object.keys(sumByCurrency([{ currency: 'USD', amount: '1' }, { currency: 'TRY', amount: '1' }]))[0]).toBe('TRY');
  });
  it('gün farkı ve talep taslağı', () => {
    expect(daysBetween('2026-02-27', '2026-03-01')).toBe(2);
    const t = claimDraft({ kind: 'FX_DIFF_NOT_ALLOWED', code: 'GRK-2026-0001', amount: '50000.00', currency: 'TRY', supplierName: 'Ege', companyName: 'Örnek',
      basis: { invoiceNo: 'KF1', sourceRef: 'Madde 7.3' } })!;
    expect(t).toContain('50.000,00 TRY');
    expect(t).toContain('Madde 7.3');
    const fx1 = fxDifferenceFinding(fx({ originals: [{ ...orig, rateAtIssue: '40.912300', rateAtPayment: '41.635800' }] }))!;
    const d = claimDraft({ kind: 'FX_DIFF_EXCESS', code: 'GRK-2026-0001', amount: fx1.amount, currency: 'TRY', supplierName: 'Ege', companyName: 'Örnek', basis: fx1.basis, date: '2026-11-08' })!;
    // Kurlar Türkçe biçimde, tarihler ve döviz tutar yazılı; 'rica ederiz' bir kez; imza yeri var.
    expect(d).toContain('Tarih: 08.11.2026');
    expect(d).toContain('USD2026000010: 10.000,00 USD; fatura tarihi 01.04.2026 kuru 40,9123, ödeme tarihi 02.05.2026 kuru 41,6358');
    expect(d).not.toContain('40.9123');
    expect(d).not.toContain('41.6358');
    expect(d.match(/rica ederiz/g)).toHaveLength(1);
    expect(d).toContain('[Ad Soyad, Unvan]');
    expect(claimDraft({ kind: 'EARLY_PAYMENT', code: 'G', amount: '1.00', currency: 'TRY', supplierName: 'E', companyName: 'Ö', basis: {} })).toBeNull();
  });
});
