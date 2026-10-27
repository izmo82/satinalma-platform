import { describe, expect, it } from 'vitest';
import { allowedVariance, availableLimit, checkInvoice, checkTax, netConsumption, openCommitment, type InvoiceCheckInput, type PoLineState } from '../src/invoiceMatch.ts';

describe('T14 limit: tavan − net tüketim − tüketilmemiş açık taahhüt', () => {
  it('1M tavan, 400 bin tüketim, 300 bin kalan açık sipariş → 300 bin; faturalanan sipariş tekrar düşülmez', () => {
    // Sözleşmeye bağlı 700 bin siparişin 400 bini faturalandı → kalan açık taahhüt 300 bin.
    const open = openCommitment([{ orderedAmount: '700000.00', invoicedAmount: '400000.00' }]);
    expect(open).toBe('300000.00');
    expect(availableLimit('1000000.00', '400000.00', open)).toBe('300000.00');
    expect(openCommitment([{ orderedAmount: '100.00', invoicedAmount: '150.00' }])).toBe('0.00');
  });
  it('net tüketim iade ile düşer, avans tüketim değildir', () => {
    expect(netConsumption([{ kind: 'INVOICE', amount: '50000.00' }, { kind: 'CREDIT_NOTE', amount: '10000.00' }, { kind: 'ADVANCE', amount: '20000.00' }])).toBe('40000.00');
  });
});

describe('tolerans açık kuraldır', () => {
  it('kural yoksa sıfır; %1 ve 100 TL arasında hangisinin geçerli olduğu kuralda yazar', () => {
    expect(allowedVariance('50000', null)).toBe('0.00');
    expect(allowedVariance('50000', { currency: 'TRY', absAmount: '100', percent: '1', combine: 'LOWER' })).toBe('100.00');
    expect(allowedVariance('50000', { currency: 'TRY', absAmount: '100', percent: '1', combine: 'HIGHER' })).toBe('500.00');
  });
});

const po = (over: Partial<PoLineState> = {}): PoLineState => ({ poLineId: 'P1', description: 'Yedek parça', unit: 'adet', currency: 'TRY', kind: 'GOODS',
  orderedQty: '100', unitPrice: '1000', receivedQty: '50', invoicedQty: '0', invoicedAmount: '0', contractVersionId: 'C1', ...over });
const base = (over: Partial<InvoiceCheckInput> = {}): InvoiceCheckInput => ({
  kind: 'INVOICE', currency: 'TRY', supplierActive: true, tolerance: null, advanceOffset: '0', advanceBalance: '0', poLines: [po()],
  contracts: [{ contractVersionId: 'C1', title: 'Parça sözleşmesi', currency: 'TRY', ceiling: '1000000.00', netConsumption: '0.00', openCommitment: '0.00', signatureUnresolved: false, archiveImport: false }],
  lines: [{ lineNo: 1, description: 'Yedek parça', quantity: '100', unit: 'adet', unitPrice: '1000', netAmount: '100000.00' }],
  allocations: [{ lineNo: 1, poLineId: 'P1', contractVersionId: null, quantity: '100', amount: '100000.00' }], ...over,
});

describe('T13 siparişin yarısı kabul, tamamı fatura', () => {
  it('eksik kabul istisnası: kaç birim, kim çözer', () => {
    const r = checkInvoice(base());
    const miss = r.issues.find((x) => x.code === 'RECEIPT_MISSING')!;
    expect(miss.severity).toBe('EXCEPTION');
    expect(miss.message).toContain('50 adet için mal kabul kaydı yok');
    expect(miss.ownerRole).toBe('REQUESTER');
    expect(r.canApprove).toBe(true);
    expect(r.needsException).toBe(true);
  });
  it('kabul tamamsa temiz; tahsis eksikse, para birimi farklıysa veya aday firmaysa onay engellenir', () => {
    expect(checkInvoice(base({ poLines: [po({ receivedQty: '100' })] })).issues).toEqual([]);
    expect(checkInvoice(base({ allocations: [{ lineNo: 1, poLineId: 'P1', contractVersionId: null, quantity: '50', amount: '50000.00' }], poLines: [po({ receivedQty: '100' })] })).issues.map((x) => x.code)).toEqual(['UNALLOCATED']);
    expect(checkInvoice(base({ poLines: [po({ receivedQty: '100', currency: 'EUR' })] })).issues.map((x) => x.code)).toEqual(['CURRENCY_MISMATCH']);
    expect(checkInvoice(base({ supplierActive: false, poLines: [po({ receivedQty: '100' })] })).canApprove).toBe(false);
  });
  it('fiyat farkı tolerans içinde geçer, dışında istisnadır', () => {
    const lines = [{ lineNo: 1, description: 'x', quantity: '100', unit: 'adet', unitPrice: '1000.50', netAmount: '100050.00' }];
    const allocations = [{ lineNo: 1, poLineId: 'P1', contractVersionId: null, quantity: '100', amount: '100050.00' }];
    const ok = checkInvoice(base({ lines, allocations, poLines: [po({ receivedQty: '100' })], tolerance: { currency: 'TRY', absAmount: '100', percent: '1', combine: 'LOWER' } }));
    expect(ok.issues).toEqual([]);
    expect(checkInvoice(base({ lines, allocations, poLines: [po({ receivedQty: '100' })] })).issues.map((x) => x.code)).toEqual(['PRICE_MISMATCH']);
  });
});

describe('limit ve T37', () => {
  it('limit aşımı engeller; imzası çözülmemiş arşiv sözleşmesi faturayı iptal etmez, inceleme açar', () => {
    const tight = [{ contractVersionId: 'C1', title: 'Parça', currency: 'TRY', ceiling: '1000000.00', netConsumption: '600000.00', openCommitment: '350000.00', signatureUnresolved: false, archiveImport: false }];
    // Doğrudan sözleşmeye tahsis: 100 bin > kullanılabilir 50 bin.
    const over = checkInvoice(base({ poLines: [], contracts: tight, allocations: [{ lineNo: 1, poLineId: null, contractVersionId: 'C1', quantity: '100', amount: '100000.00' }] }));
    expect(over.issues.map((x) => x.code)).toEqual(['LIMIT_EXCEEDED']);
    expect(over.canApprove).toBe(false);
    // Siparişe bağlı fatura: siparişin ayırdığı açık taahhüt tüketime döner, limit yeniden düşülmez (T14 çift sayım yok).
    const viaPo = checkInvoice(base({ poLines: [po({ receivedQty: '100' })], contracts: tight }));
    expect(viaPo.issues).toEqual([]);
    expect(viaPo.limitImpact.C1).toBe('0.00');
    expect(viaPo.contractImpact.C1).toBe('100000.00');
    // Sipariş tutarını aşan kısım limiti etkiler.
    const beyond = checkInvoice(base({ poLines: [po({ receivedQty: '100', invoicedAmount: '60000.00', invoicedQty: '0' })], contracts: tight }));
    expect(beyond.limitImpact.C1).toBe('60000.00');
    expect(beyond.issues.map((x) => x.code)).toContain('LIMIT_EXCEEDED');
    const arch = checkInvoice(base({ poLines: [po({ receivedQty: '100' })], contracts: [{ contractVersionId: 'C1', title: 'Eski temizlik', currency: 'TRY', ceiling: null, netConsumption: '0', openCommitment: '0', signatureUnresolved: true, archiveImport: true }] }));
    expect(arch.issues).toEqual([expect.objectContaining({ code: 'CONTRACT_SIGNATURE_UNRESOLVED', severity: 'REVIEW', ownerRole: 'LEGAL' })]);
    expect(arch.canApprove).toBe(true);
  });
  it('T16 parçaları: iade önceki faturayı aşamaz; avans mahsubu bakiyeyi aşamaz; ödenecek = net − mahsup', () => {
    const credit = checkInvoice(base({ kind: 'CREDIT_NOTE', poLines: [po({ receivedQty: '100', invoicedQty: '5' })],
      lines: [{ lineNo: 1, description: 'İade', quantity: '10', unit: 'adet', unitPrice: '1000', netAmount: '10000.00' }],
      allocations: [{ lineNo: 1, poLineId: 'P1', contractVersionId: null, quantity: '10', amount: '10000.00' }] }));
    expect(credit.issues.map((x) => x.code)).toEqual(['CREDIT_EXCEEDS']);
    expect(credit.contractImpact.C1).toBe('-10000.00');
    const adv = checkInvoice(base({ poLines: [po({ receivedQty: '100' })], advanceOffset: '20000', advanceBalance: '20000' }));
    expect(adv.payable).toBe('80000.00');
    expect(checkInvoice(base({ poLines: [po({ receivedQty: '100' })], advanceOffset: '30000', advanceBalance: '20000' })).issues.map((x) => x.code)).toEqual(['ADVANCE_OFFSET_INVALID']);
  });
});

describe('vergi aritmetiği: belgedeki değer doğru kabul edilmez', () => {
  const lines = [
    { lineNo: 1, description: 'Disk', quantity: '3', unit: 'adet', unitPrice: '333.33', netAmount: '999.99', taxRate: '20', taxAmount: '200.00' },
    { lineNo: 2, description: 'Bakım', quantity: '1', unit: 'ay', unitPrice: '1000', netAmount: '1000.00', taxRate: '10', taxAmount: null },
  ];
  it('kuruş yuvarlaması geçer; toplam ve ödenecek tutar satırlardan hesaplanır', () => {
    const r = checkTax(lines, { taxTotal: '300.00', withholding: null, payable: '2299.99' }, 'TRY');
    expect(r.issues).toEqual([]);
    expect(r.taxTotal).toBe('300.00');
    expect(r.grossAmount).toBe('2299.99');
  });
  it('yanlış satır KDV\'si, tutmayan toplam ve ödenecek tutar engeller; sorumlu finans', () => {
    const bad = [{ ...lines[0]!, taxAmount: '180.00' }, lines[1]!];
    const r = checkTax(bad, { taxTotal: '300.00', withholding: null, payable: '2500.00' }, 'TRY');
    expect(r.issues.map((x) => x.code)).toEqual(['TAX_LINE_MISMATCH', 'TAX_TOTAL_MISMATCH', 'PAYABLE_MISMATCH']);
    expect(r.issues.every((x) => x.severity === 'BLOCK' && x.ownerRole === 'FINANCE')).toBe(true);
    expect(r.issues[0]!.message).toContain('999.99 × %20 = 200.00');
  });
  it('tevkifat ödenecekten düşer, KDV\'yi aşamaz; belgede toplam yoksa yalnız satır kontrolü', () => {
    expect(checkTax(lines, { taxTotal: '300.00', withholding: '100.00', payable: '2199.99' }, 'TRY').issues).toEqual([]);
    expect(checkTax(lines, { taxTotal: null, withholding: '400.00', payable: null }, 'TRY').issues.map((x) => x.code)).toEqual(['WITHHOLDING_INVALID']);
    expect(checkTax(lines, undefined, 'TRY').issues).toEqual([]);
  });
  it('vergi hatası faturanın onayını engeller', () => {
    const c = checkInvoice(base({ poLines: [po({ receivedQty: '100' })], declared: { taxTotal: '1.00', withholding: null, payable: null } }));
    expect(c.canApprove).toBe(false);
    expect(c.issues.map((x) => x.code)).toContain('TAX_TOTAL_MISMATCH');
  });
});

describe('KDV dışı vergiler (ÖTV/ÖİV)', () => {
  it('KDV matrahı net + diğer vergiler; ödenecek tutara eklenir; toplam tutmazsa engeller', () => {
    const l = [{ lineNo: 1, description: 'Hat', quantity: '1', unit: 'ay', unitPrice: '1000', netAmount: '1000.00', taxRate: '20', taxAmount: '220.00', otherTax: '100.00' }];
    const ok = checkTax(l, { taxTotal: '220.00', otherTaxTotal: '100.00', withholding: null, payable: '1320.00' }, 'TRY');
    expect(ok).toMatchObject({ issues: [], taxTotal: '220.00', otherTaxTotal: '100.00', grossAmount: '1320.00' });
    expect(checkTax(l, { taxTotal: '220.00', otherTaxTotal: '90.00', withholding: null, payable: '1320.00' }, 'TRY').issues.map((x) => x.code)).toEqual(['OTHER_TAX_MISMATCH']);
  });
});
