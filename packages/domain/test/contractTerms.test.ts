import { describe, expect, it } from 'vitest';
import { addMonths, noticeDeadline, occurrences, reminderSchedule, termsDiff, validateTerms, type CommercialTerms } from '../src/contractTerms.ts';

// Tatil listesi kiracı verisidir; burada sentetik test girdisi.
const holidays = ['2026-10-29'];

describe('T21 ihbar son günü bitişe değil ihbar kuralına dayanır', () => {
  it('31.12 bitiş, 60 gün önce ihbar: 01.11 pazara denk gelir; sözleşme "önceki iş günü" diyorsa 30.10', () => {
    const asIs = noticeDeadline('2026-12-31', { amount: 60, unit: 'DAY', nonWorkingDay: 'AS_IS' }, holidays);
    expect(asIs.deadline).toBe('2026-11-01');
    const prev = noticeDeadline('2026-12-31', { amount: 60, unit: 'DAY', nonWorkingDay: 'PREVIOUS_WORKING_DAY' }, holidays);
    expect(prev).toMatchObject({ raw: '2026-11-01', deadline: '2026-10-30', adjusted: true });
    expect(prev.explanation).toContain('önceki iş günü 30.10.2026');
  });
  it('tatil günü atlanır: hesaplanan gün resmî tatile denk gelirse bir önceki iş gününe kayar', () => {
    // 29.10.2026 perşembe (sentetik tatil listesinde) → 28.10 çarşamba
    expect(noticeDeadline('2026-12-28', { amount: 60, unit: 'DAY', nonWorkingDay: 'PREVIOUS_WORKING_DAY' }, holidays).deadline).toBe('2026-10-28');
  });
  it('ay birimi: ay sonu kırpılır', () => {
    expect(addMonths('2027-03-31', -1)).toBe('2027-02-28');
    expect(noticeDeadline('2026-12-31', { amount: 1, unit: 'MONTH', nonWorkingDay: 'AS_IS' }).deadline).toBe('2026-11-30');
  });
  it('90/60/30 uyarıları ihbar son gününe göre; geçmişte kalan uyarı hemen', () => {
    const s = reminderSchedule('2026-10-30', '2026-09-15');
    expect(s).toEqual([
      { offset: 90, date: '2026-08-01', due: true },
      { offset: 60, date: '2026-08-31', due: true },
      { offset: 30, date: '2026-09-30', due: false },
    ]);
  });
});

describe('yükümlülük tekrarları', () => {
  it('üç aylık rapor, aralık ve bitişle sınırlı', () => {
    expect(occurrences('2027-01-15', 'QUARTERLY', '2027-01-01', '2027-12-31')).toEqual(['2027-01-15', '2027-04-15', '2027-07-15', '2027-10-15']);
    expect(occurrences('2027-01-31', 'MONTHLY', '2027-02-01', '2027-04-30')).toEqual(['2027-02-28', '2027-03-31', '2027-04-30']);
    expect(occurrences('2027-05-01', 'NONE', '2027-01-01', '2027-12-31')).toEqual(['2027-05-01']);
    expect(occurrences('2027-01-15', 'MONTHLY', '2027-01-01', '2027-12-31', '2027-03-01')).toEqual(['2027-01-15', '2027-02-15']);
  });
});

describe('koşullar', () => {
  const t: CommercialTerms = { currency: 'TRY', valueType: 'CEILING', amount: '1000000.00', paymentTerms: '30 gün', startDate: '2026-01-01', endDate: '2026-12-31',
    autoRenewal: true, renewalMonths: 12, noticeAmount: 60, noticeUnit: 'DAY', nonWorkingDay: 'PREVIOUS_WORKING_DAY', sourceRef: 'Madde 4.2, s. 3' };
  it('doğrulama: kaynak madde zorunlu, süresiz sözleşmede bitişe göre ihbar yok, bedelsizde tutar yok', () => {
    expect(validateTerms(t)).toBeNull();
    expect(validateTerms({ ...t, sourceRef: '' })).toMatch(/madde/);
    // v2 Faz 4 (D109): ileti "önce bitiş tarihini girin ya da süresiz işaretleyin" oldu (persona K1: süresiz işaretlenmemiş sözleşmede "Süresiz sözleşmede…" yanıltıyordu).
    expect(validateTerms({ ...t, endDate: null })).toMatch(/önce bitiş tarihini girin ya da sözleşmeyi süresiz işaretleyin/);
    expect(validateTerms({ ...t, valueType: 'UNPRICED' })).toMatch(/Bedelsiz/);
    expect(validateTerms({ ...t, endDate: '2025-12-31' })).toMatch(/Bitiş/);
  });
  it('önemli değişiklik farkı eski ve yeni değeri verir', () => {
    expect(termsDiff(t, { ...t, amount: '1200000.00', endDate: '2027-06-30' })).toEqual([
      { field: 'amount', label: 'Bedel/tavan', before: '1000000.00', after: '1200000.00' },
      { field: 'endDate', label: 'Bitiş', before: '2026-12-31', after: '2027-06-30' },
    ]);
  });
});
