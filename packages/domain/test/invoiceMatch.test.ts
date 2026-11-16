// v2 Faz 1 (D93/D95): bulgu metinlerinde tutar ve oran Türkçe biçimde, imza bulgusunda ödeme dili yok; eski ham metni bekleyen üç test güncellendi.
import { describe, expect, it } from 'vitest';
import { allowedVariance, availableLimit, checkInvoice, checkTax, netConsumption, openCommitment, pickTolerance, type InvoiceCheckInput, type PoLineState } from '../src/invoiceMatch.ts';

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
    // v2 Faz 1 (D93/D95): bulgu metnindeki tutarlar Türkçe biçimde gösterilir (önce '999.99 × %20 = 200.00').
    expect(r.issues[0]!.message).toContain('999,99 × %20 = 200,00');
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

describe('Faz 4: kategori bazında tolerans', () => {
  const genel = { currency: 'TRY', absAmount: '100', percent: null, combine: 'LOWER' as const };
  const it_ = { currency: 'TRY', absAmount: '5000', percent: null, combine: 'LOWER' as const, category: 'BT donanımı' };
  it('kategori kuralı varsa o, yoksa para biriminin genel kuralı, o da yoksa sıfır; büyük/küçük harf ve boşluk farkı yok sayılır', () => {
    expect(pickTolerance([genel, it_], 'TRY', ' bt DONANIMI ')).toBe(it_);
    expect(pickTolerance([genel, it_], 'TRY', 'Temizlik')).toBe(genel);
    expect(pickTolerance([genel, it_], 'TRY', null)).toBe(genel);
    expect(pickTolerance([it_], 'TRY', 'Temizlik')).toBeNull();
    expect(pickTolerance([genel, it_], 'EUR', 'BT donanımı')).toBeNull();
  });
  it('aynı fatura farklı kategorideki iki sipariş satırına kendi kuralıyla bakılır', () => {
    const r = checkInvoice(base({
      tolerances: [genel, it_],
      poLines: [po({ poLineId: 'P1', receivedQty: '100', category: 'BT donanımı' }), po({ poLineId: 'P2', receivedQty: '100', category: 'Temizlik' })],
      lines: [{ lineNo: 1, description: 'Yedek parça', quantity: '100', unit: 'adet', unitPrice: '1020', netAmount: '102000.00' },
        { lineNo: 2, description: 'Yedek parça', quantity: '100', unit: 'adet', unitPrice: '1020', netAmount: '102000.00' }],
      allocations: [{ lineNo: 1, poLineId: 'P1', contractVersionId: null, quantity: '100', amount: '102000.00' },
        { lineNo: 2, poLineId: 'P2', contractVersionId: null, quantity: '100', amount: '102000.00' }],
    }));
    const price = r.issues.filter((x) => x.code === 'PRICE_MISMATCH');
    // 2.000 TL fark: BT kuralı (5.000) içinde, genel kural (100) dışında.
    expect(price.map((x) => x.lineNo)).toEqual([2]);
    expect(price[0]!.message).toContain('TRY genel kuralı');
  });
});

describe('Faz 4: KDV dışı vergilerin oran kontrolü', () => {
  const line = (otherTaxes: any[], otherTax?: string) => ({ lineNo: 1, description: 'Haberleşme', quantity: '1', unit: 'ay', unitPrice: '1000', netAmount: '1000.00', taxRate: '20', otherTax, otherTaxes });
  it('oranlı vergi net × oran tutmalı; tutmazsa düzeltme istenir', () => {
    expect(checkTax([line([{ code: '4080', name: 'ÖİV', rate: '7.5', amount: '75.00' }])], undefined, 'TRY').issues).toEqual([]);
    const bad = checkTax([line([{ code: '4080', name: 'ÖİV', rate: '7.5', amount: '80.00' }])], undefined, 'TRY');
    expect(bad.issues.map((x) => x.code)).toEqual(['OTHER_TAX_RATE_MISMATCH']);
    // v2 Faz 1 (D93/D95): tutar ve oran Türkçe biçimde (önce '1000.00 × %7.50 = 75.00').
    expect(bad.issues[0]!.message).toContain('1.000,00 × %7,5 = 75,00');
  });
  it('maktu (oransız) vergi beyan olarak kalır; kalem toplamı satır toplamıyla tutmalı; KDV matrahına girer', () => {
    const r = checkTax([line([{ code: '0071', name: 'ÖTV', rate: null, amount: '150.00' }, { code: '4080', name: 'ÖİV', rate: '10', amount: '100.00' }], '250.00')], undefined, 'TRY');
    expect(r.issues).toEqual([]);
    expect(r.otherTaxTotal).toBe('250.00');
    expect(r.taxTotal).toBe('250.00'); // (1000 + 250) × %20
    expect(checkTax([line([{ code: '0071', rate: null, amount: '150.00' }], '200.00')], undefined, 'TRY').issues.map((x) => x.code)).toEqual(['OTHER_TAX_MISMATCH']);
    expect(checkTax([line([{ code: '4080', rate: '150', amount: '1.00' }])], undefined, 'TRY').issues.map((x) => x.code)).toEqual(['OTHER_TAX_RATE_INVALID']);
  });
});

describe('Faz 4: sözleşme limiti vergi dahil (GROSS)', () => {
  const contract = (over: any = {}) => ({ contractVersionId: 'C1', title: 'Hizmet', currency: 'TRY', ceiling: '120000.00', netConsumption: '0.00', openCommitment: '0.00',
    signatureUnresolved: false, archiveImport: false, limitBasis: 'GROSS' as const, ...over });
  const direct = (net: string) => base({ poLines: [], contracts: [contract()], lines: [{ lineNo: 1, description: 'Hizmet', quantity: '1', unit: 'ay', unitPrice: net, netAmount: net, taxRate: '20' }],
    allocations: [{ lineNo: 1, poLineId: null, contractVersionId: 'C1', quantity: '1', amount: net }] });
  it('doğrudan sözleşme tahsisi KDV dahil tutarla limiti tüketir', () => {
    expect(checkInvoice(direct('100000.00')).limitImpact).toEqual({ C1: '120000.00' });
    expect(checkInvoice(direct('100000.00')).issues.some((x) => x.code === 'LIMIT_EXCEEDED')).toBe(false);
    const over = checkInvoice(direct('100001.00'));
    // v2 Faz 1 (D93/D95): tutar Türkçe biçimde (önce '120000.00').
    expect(over.issues.find((x) => x.code === 'LIMIT_EXCEEDED')!.message).toContain('kullanılabilir limit (vergi dahil) 120.000,00 TRY');
    // Aynı tutar NET limitte sığar.
    expect(checkInvoice({ ...direct('100001.00'), contracts: [contract({ limitBasis: 'NET' })] }).issues.some((x) => x.code === 'LIMIT_EXCEEDED')).toBe(false);
  });
  it('siparişe bağlı faturada sipariş taahhüdü sipariş KDV oranıyla brüt; yalnız aşan kısım limite gider', () => {
    // Sipariş 100 × 1000 = 100.000 net, %20 → 120.000 brüt açık taahhüt. Fatura 100 × 1010 = 101.000 net → 121.200 brüt; aşan 1.200.
    const r = checkInvoice(base({ contracts: [contract({ ceiling: '200000.00', openCommitment: '120000.00' })], poLines: [po({ receivedQty: '100', taxRate: '20' })],
      lines: [{ lineNo: 1, description: 'Yedek parça', quantity: '100', unit: 'adet', unitPrice: '1010', netAmount: '101000.00', taxRate: '20' }],
      allocations: [{ lineNo: 1, poLineId: 'P1', contractVersionId: null, quantity: '100', amount: '101000.00' }] }));
    expect(r.limitImpact).toEqual({ C1: '1200.00' });
  });
});

describe('tahsis edilen sipariş/sözleşme faturanın tedarikçisine ait olmalı (D84)', () => {
  const contract = { contractVersionId: 'C1', title: 'Parça sözleşmesi', currency: 'TRY', ceiling: '1000000.00', netConsumption: '0.00', openCommitment: '0.00', signatureUnresolved: false, archiveImport: false };
  const toPo = [{ lineNo: 1, poLineId: 'P1', contractVersionId: null, quantity: '50', amount: '50000.00' }];
  const toContract = [{ lineNo: 1, poLineId: null, contractVersionId: 'C1', quantity: '100', amount: '100000.00' }];
  const codes = (over: Partial<InvoiceCheckInput>) => checkInvoice(base(over)).issues.filter((x) => x.code === 'SUPPLIER_MISMATCH');

  it('başka tedarikçinin siparişine tahsis engeldir ve satırıyla bildirilir', () => {
    const issues = codes({ supplierRootId: 'A', poLines: [po({ supplierRootId: 'B' })], allocations: toPo });
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({ severity: 'BLOCK', lineNo: 1, ownerRole: 'FINANCE' });
    expect(checkInvoice(base({ supplierRootId: 'A', poLines: [po({ supplierRootId: 'B' })], allocations: toPo })).canApprove).toBe(false);
  });
  it('başka tedarikçinin sözleşmesine doğrudan tahsis de engeldir', () => {
    expect(codes({ supplierRootId: 'A', contracts: [{ ...contract, supplierRootIds: ['B'] }], allocations: toContract })).toHaveLength(1);
  });
  it('sözleşmenin tedarikçi taraflarından biriyse bulgu yok (çok tedarikçili sözleşme)', () => {
    expect(codes({ supplierRootId: 'A', contracts: [{ ...contract, supplierRootIds: ['B', 'A'] }], allocations: toContract })).toHaveLength(0);
  });
  it('iade belgesi onaylı özgün faturanın yanlış bağına dönebilir; başka yabancı hedefe dönemez', () => {
    const reversal = { kind: 'CREDIT_NOTE' as const, supplierRootId: 'A', poLines: [po({ supplierRootId: 'B' })], allocations: toPo };
    expect(codes({ ...reversal, reversalTargets: ['P1'] })).toHaveLength(0);
    expect(codes({ ...reversal, reversalTargets: ['P9'] })).toHaveLength(1);
  });
  it('aynı tedarikçide ve tedarikçisi kayıtlı olmayan sözleşmede bulgu yok', () => {
    expect(codes({ supplierRootId: 'A', poLines: [po({ supplierRootId: 'A' })], allocations: toPo })).toHaveLength(0);
    expect(codes({ supplierRootId: 'A', contracts: [{ ...contract, supplierRootIds: [] }], allocations: toContract })).toHaveLength(0);
  });
  it('bir satır iki yabancı hedefe bölünse de tek bulgu verir', () => {
    const split = [{ lineNo: 1, poLineId: 'P1', contractVersionId: null, quantity: '25', amount: '25000.00' }, { lineNo: 1, poLineId: 'P1', contractVersionId: null, quantity: '25', amount: '25000.00' }];
    expect(codes({ supplierRootId: 'A', poLines: [po({ supplierRootId: 'B' })], allocations: split })).toHaveLength(1);
  });
});

describe('tahsis edilen sipariş/sözleşme faturanın şirketine ait olmalı (D87)', () => {
  const contract = { contractVersionId: 'C1', title: 'Parça sözleşmesi', currency: 'TRY', ceiling: '1000000.00', netConsumption: '0.00', openCommitment: '0.00', signatureUnresolved: false, archiveImport: false };
  const toPo = [{ lineNo: 1, poLineId: 'P1', contractVersionId: null, quantity: '50', amount: '50000.00' }];
  const toContract = [{ lineNo: 1, poLineId: null, contractVersionId: 'C1', quantity: '100', amount: '100000.00' }];
  const codes = (over: Partial<InvoiceCheckInput>) => checkInvoice(base(over)).issues.filter((x) => x.code === 'COMPANY_MISMATCH');

  it('başka şirketin siparişi ve sözleşmesi engeldir', () => {
    const issues = codes({ companyId: 'A', poLines: [po({ companyId: 'B' })], allocations: toPo });
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({ severity: 'BLOCK', lineNo: 1, ownerRole: 'FINANCE' });
    expect(codes({ companyId: 'A', contracts: [{ ...contract, companyId: 'B' }], allocations: toContract })).toHaveLength(1);
  });
  it('erişilemediği için durumu yüklenemeyen hedef atlanmaz, engeldir', () => {
    expect(codes({ companyId: 'A', poLines: [], allocations: toPo })).toHaveLength(1);
    expect(codes({ companyId: 'A', contracts: [], allocations: toContract })).toHaveLength(1);
  });
  it('aynı şirkette bulgu yok; şirket bilgisi verilmeyen çağrı denetlenmez', () => {
    expect(codes({ companyId: 'A', poLines: [po({ companyId: 'A' })], allocations: toPo })).toHaveLength(0);
    expect(codes({ companyId: 'A', contracts: [{ ...contract, companyId: 'A' }], allocations: toContract })).toHaveLength(0);
    expect(codes({ poLines: [], allocations: toPo })).toHaveLength(0);
  });
  it('iade belgesi onaylı özgün faturanın hedefine dönebilir', () => {
    expect(codes({ kind: 'CREDIT_NOTE', companyId: 'A', poLines: [po({ companyId: 'B' })], allocations: toPo, reversalTargets: ['P1'] })).toHaveLength(0);
  });
});

// Düzeltme dalgası (I5, D93): "Eşleşti" tahsis kontrolünden türer; eksik, fazla ya da yanlış tedarikçi/şirkete tahsis eşleşmiş sayılmaz.
describe('allocationMatched', () => {
  it('engelleyici tahsis bulgusu yoksa ve satır varsa eşleşmiş', async () => {
    const { allocationMatched, MATCH_BLOCKING_CODES } = await import('../src/invoiceMatch.ts');
    expect(MATCH_BLOCKING_CODES).toEqual(['UNALLOCATED', 'OVER_ALLOCATED', 'SUPPLIER_MISMATCH', 'COMPANY_MISMATCH']);
    expect(allocationMatched(true, [])).toBe(true);
    expect(allocationMatched(true, [{ code: 'TAX_LINE_MISMATCH' }])).toBe(true);
    for (const code of MATCH_BLOCKING_CODES) expect(allocationMatched(true, [{ code }]), code).toBe(false);
    expect(allocationMatched(false, [])).toBe(false);
  });
});

// Faz 1 kalan düzeltme: kullanıcıya giden bulgu metninde ham ondalık ("1500.00") ve kaldırılan ödeme dili yok.
describe('bulgu metni: Türkçe tutar, ödeme dili yok', () => {
  it('fazla tahsis tutarları Türkçe biçimde; imza bulgusunda ödeme politikası geçmez', async () => {
    const { trAmount, trRate } = await import('../src/money.ts');
    expect(trAmount('1500.00')).toBe('1.500,00');
    expect(trAmount('-1234567.891')).toBe('-1.234.567,89');
    expect(trAmount('0')).toBe('0,00');
    expect(trAmount('abc')).toBe('abc');
    expect(trRate('7.50')).toBe('7,5');
    expect(trRate('20')).toBe('20');
    const over = checkInvoice(base({ poLines: [], contracts: [], lines: [{ lineNo: 1, description: 'Hizmet', quantity: '1', unit: 'ay', unitPrice: '1000', netAmount: '1000.00' }],
      allocations: [{ lineNo: 1, poLineId: null, contractVersionId: 'C1', quantity: '1', amount: '1500.00' }] }));
    const msg = over.issues.find((x) => x.code === 'OVER_ALLOCATED')!.message;
    expect(msg).toBe('Satır 1: tahsis toplamı 1.500,00 TRY, satır tutarını (1.000,00 TRY) aşıyor.');
    expect(msg).not.toMatch(/\d\.\d{2}\b/);
    const arch = checkInvoice(base({ poLines: [po({ receivedQty: '100' })], contracts: [{ contractVersionId: 'C1', title: 'Eski temizlik', currency: 'TRY', ceiling: null, netConsumption: '0', openCommitment: '0', signatureUnresolved: true, archiveImport: true }] }));
    const sig = arch.issues.find((x) => x.code === 'CONTRACT_SIGNATURE_UNRESOLVED')!.message;
    expect(sig).not.toMatch(/ödeme/i);
    expect(sig).toContain('imza kontrolünü Satınalma tamamlar');
  });
});
