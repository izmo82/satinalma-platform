import { describe, expect, it } from 'vitest';
import { checkUblTr, ublSummary, type UblTrHeader } from '../src/ublTr.ts';
import { syntheticVkn } from '../src/taxId.ts';

const vkn = syntheticVkn('123456789');
const ok = (over: Partial<UblTrHeader> = {}): UblTrHeader => ({
  ublVersion: '2.1', customizationId: 'TR1.2', profileId: 'TICARIFATURA', typeCode: 'SATIS', invoiceNumber: 'ABC2026000000123',
  ettn: '3f2504e0-4f89-11d3-9a0c-0305e82c3301', issueDate: '2026-10-20', documentCurrency: 'TRY', amountCurrencies: ['TRY'], exchangeRate: null,
  lineCountNumeric: '2', lineCount: 2, linesWithoutUnit: 0, seller: { taxIdType: 'VKN', taxId: vkn }, buyer: { taxIdType: 'TCKN', taxId: '10000000146' },
  references: [], hasWithholding: false, ...over,
});
const rules = (h: UblTrHeader) => checkUblTr(h, '2026-11-08').map((f) => `${f.severity}:${f.rule}`);

describe('UBL-TR temel kural denetimi', () => {
  it('uygun belgede bulgu yok', () => {
    expect(checkUblTr(ok(), '2026-11-08')).toEqual([]);
  });

  it('sürüm, özelleştirme, senaryo ve tip: eksik hata, tanınmayan uyarı', () => {
    expect(rules(ok({ ublVersion: '2.0', customizationId: null, profileId: null, typeCode: null }))).toEqual(
      ['ERROR:UBL_VERSION', 'ERROR:CUSTOMIZATION', 'ERROR:PROFILE_MISSING', 'ERROR:TYPE_MISSING']);
    expect(rules(ok({ profileId: 'YENISENARYO', typeCode: 'YENITIP' }))).toEqual(['WARNING:PROFILE_UNKNOWN', 'WARNING:TYPE_UNKNOWN']);
    expect(rules(ok({ customizationId: 'TR1.2.1', profileId: 'temelfatura', typeCode: 'iade', references: ['ABC2026000000001'] }))).toEqual([]);
  });

  it('fatura no GİB biçiminde; yıl düzenleme tarihiyle uyumsuzsa uyarı', () => {
    expect(rules(ok({ invoiceNumber: 'EFT1234' }))).toEqual(['ERROR:INVOICE_NO_FORMAT']);
    expect(rules(ok({ invoiceNumber: 'abc2026000000123' }))).toEqual(['ERROR:INVOICE_NO_FORMAT']);
    expect(rules(ok({ invoiceNumber: 'ABC2025000000123' }))).toEqual(['WARNING:INVOICE_NO_YEAR']);
  });

  it('ETTN, tarih: geçersiz hata, gelecek tarih uyarı', () => {
    expect(rules(ok({ ettn: 'x', issueDate: '2026-02-30' }))).toEqual(['ERROR:ETTN_FORMAT', 'ERROR:ISSUE_DATE']);
    // Ay/gün aralık dışı: istisna fırlatmaz, hata bulgusu olur.
    for (const d of ['2026-13-01', '2026-00-10', '2026-05-45']) expect(rules(ok({ issueDate: d }))).toEqual(['ERROR:ISSUE_DATE']);
    expect(rules(ok({ issueDate: '2026-12-01', invoiceNumber: 'ABC2026000000123' }))).toEqual(['WARNING:ISSUE_DATE_FUTURE']);
  });

  it('para birimi: tutarlar belge para biriminde; döviz faturada kur zorunlu', () => {
    expect(rules(ok({ amountCurrencies: ['TRY', 'USD'] }))).toEqual(['ERROR:CURRENCY_MISMATCH']);
    expect(rules(ok({ documentCurrency: 'USD', amountCurrencies: ['USD'] }))).toEqual(['ERROR:EXCHANGE_RATE_MISSING']);
    expect(rules(ok({ documentCurrency: 'USD', amountCurrencies: ['USD'], exchangeRate: '0' }))).toEqual(['ERROR:EXCHANGE_RATE_MISSING']);
    expect(rules(ok({ documentCurrency: 'USD', amountCurrencies: ['USD'], exchangeRate: '41.9123' }))).toEqual([]);
    expect(rules(ok({ documentCurrency: null }))).toEqual(['ERROR:CURRENCY']);
  });

  it('satır sayısı beyanı ve birim kodu', () => {
    expect(rules(ok({ lineCountNumeric: '3' }))).toEqual(['ERROR:LINE_COUNT']);
    expect(rules(ok({ lineCountNumeric: null }))).toEqual(['ERROR:LINE_COUNT_MISSING']);
    expect(rules(ok({ lineCount: 0, lineCountNumeric: '0' }))).toEqual(['ERROR:NO_LINES']);
    expect(rules(ok({ linesWithoutUnit: 1 }))).toEqual(['WARNING:LINE_UNIT']);
  });

  it('VKN/TCKN yok ya da kontrol basamağı tutmuyorsa hata (mesaj nedeni söyler)', () => {
    const bad = vkn.slice(0, 9) + String((Number(vkn[9]) + 1) % 10);
    const f = checkUblTr(ok({ seller: { taxIdType: 'VKN', taxId: bad }, buyer: { taxIdType: null, taxId: null } }), '2026-11-08');
    expect(f.map((x) => x.rule)).toEqual(['SELLER_TAX_ID', 'BUYER_TAX_ID']);
    expect(f[0]!.message).toContain('kontrol basamağı');
    expect(f[1]!.message).toContain('belgede yok');
  });

  it('iade referansı ve tevkifat tutarlılığı', () => {
    expect(rules(ok({ typeCode: 'IADE' }))).toEqual(['ERROR:RETURN_REFERENCE']);
    expect(rules(ok({ typeCode: 'TEVKIFAT' }))).toEqual(['ERROR:WITHHOLDING_MISSING']);
    expect(rules(ok({ typeCode: 'TEVKIFAT', hasWithholding: true }))).toEqual([]);
    expect(rules(ok({ hasWithholding: true }))).toEqual(['WARNING:WITHHOLDING_TYPE']);
  });

  it('özet hata ve uyarıyı ayrı sayar', () => {
    expect(ublSummary(checkUblTr(ok({ ublVersion: null, profileId: 'X' }), '2026-11-08'))).toEqual({ errors: 1, warnings: 1 });
  });
});
