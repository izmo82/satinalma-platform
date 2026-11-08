import { XMLParser, XMLValidator } from 'fast-xml-parser';
import { add, dec, isDecimal, str, type UblTrHeader } from '@sp/domain';

const sumDec = (xs: string[]) => (xs.every(isDecimal) ? str(add(...xs.map(dec))) : null);

// UBL-TR e-Fatura deterministik ayrıştırıcı (AI'dan önce yapılandırılmış veri; 07 Router ilk adım).
// Taraf rolleri belgede açıktır: AccountingSupplierParty = satıcı, AccountingCustomerParty = alıcı (T05).

export interface ExtractedParty {
  taxIdType: 'VKN' | 'TCKN' | null;
  taxId: string | null;
  name: string | null;
  source: string;
}
export interface EInvoiceExtraction {
  invoiceNumber: string | null;
  ettn: string | null;
  issueDate: string | null;
  currency: string | null;
  payableAmount: string | null;
  seller: ExtractedParty;
  buyer: ExtractedParty;
  sellerIban: string | null;
  /** SATIS, IADE, TEVKIFAT, ISTISNA… (InvoiceTypeCode). */
  typeCode: string | null;
  /** İade faturasının bağlı olduğu özgün fatura no (BillingReference). */
  billingReference: string | null;
  lines: EInvoiceLine[];
  /** Belgede beyan edilen toplamlar; kontrol bunlarla satırları karşılaştırır, kendisi doğru kabul etmez. */
  totals: { lineExtension: string | null; taxExclusive: string | null; taxInclusive: string | null; taxTotal: string | null; otherTaxTotal: string | null; withholding: string | null; payable: string | null };
  /** UBL-TR kural denetimi girdisi (D81). `references`: tüm BillingReference fatura numaraları (kur farkı/iade bağı). */
  header: UblTrHeader;
}
export interface EInvoiceLine { description: string; quantity: string | null; unitCode: string | null; unitPrice: string | null; netAmount: string | null; taxRate: string | null; taxAmount: string | null; otherTax: string | null;
  /** KDV dışı vergiler tek tek (kod, ad, oran, tutar); oran yoksa maktu. */
  otherTaxes: { code: string; name: string | null; rate: string | null; amount: string }[] }

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@',
  removeNSPrefix: true,
  processEntities: false,
  htmlEntities: false,
  parseTagValue: false,
  isArray: (name) => ['PartyIdentification', 'PaymentMeans', 'InvoiceLine', 'TaxSubtotal', 'TaxTotal', 'WithholdingTaxTotal', 'BillingReference'].includes(name),
});

type Node = Record<string, any>;
const text = (n: unknown): string | null => {
  if (n == null) return null;
  if (typeof n === 'string') return n.trim() || null;
  if (typeof n === 'object' && '#text' in (n as Node)) return String((n as Node)['#text']).trim() || null;
  return null;
};

function party(p: Node | undefined, path: string): ExtractedParty {
  const partyNode: Node | undefined = p?.Party;
  const ids: Node[] = partyNode?.PartyIdentification ?? [];
  let taxIdType: ExtractedParty['taxIdType'] = null;
  let taxId: string | null = null;
  for (const id of ids) {
    const scheme = String(id?.ID?.['@schemeID'] ?? '').toUpperCase();
    if (scheme === 'VKN' || scheme === 'TCKN') {
      taxIdType = scheme;
      taxId = text(id.ID);
      break;
    }
  }
  const person = partyNode?.Person;
  const name = text(partyNode?.PartyName?.Name)
    ?? (person ? [text(person.FirstName), text(person.FamilyName)].filter(Boolean).join(' ') || null : null);
  return { taxIdType, taxId, name, source: `xpath:/Invoice/${path}/Party/PartyIdentification/ID[@schemeID]` };
}

/**
 * Satır vergileri: KDV (TaxTypeCode 0015) oranı ve tutarı; KDV dışı vergiler (ÖTV, ÖİV…) toplamı ayrı.
 * KDV dışı vergiler KDV matrahına girer ve ödenecek tutara eklenir; her biri kod, ad ve (varsa) oranıyla ayrı alınır, oranlı olanlar
 * eşleştirme kontrolünde net × oran ile denetlenir.
 */
function lineTaxes(totals: Node[] | undefined): { rate: string | null; amount: string | null; other: string | null; others: EInvoiceLine['otherTaxes'] } {
  let rate: string | null = null; let amount: string | null = null; const other: string[] = [];
  const others: EInvoiceLine['otherTaxes'] = [];
  for (const t of totals ?? []) for (const st of (t?.TaxSubtotal ?? []) as Node[]) {
    const code = text(st?.TaxCategory?.TaxScheme?.TaxTypeCode);
    if ((code === '0015' || code === null) && amount === null) { rate = text(st?.Percent) ?? text(st?.TaxCategory?.Percent); amount = text(st?.TaxAmount); }
    else if (code !== '0015' && code !== null) {
      const a = text(st?.TaxAmount);
      if (a) { other.push(a); others.push({ code, name: text(st?.TaxCategory?.TaxScheme?.Name), rate: text(st?.Percent) ?? text(st?.TaxCategory?.Percent), amount: a }); }
    }
  }
  return { rate, amount, other: other.length ? sumDec(other) ?? 'INVALID' : null, others };
}
/** Belge düzeyi toplam: KDV alt toplamları, KDV dışı vergiler veya (tevkifat için) tümü. Ondalık dizge toplamı (float yok). */
function sumTax(totals: Node[] | undefined, which: 'VAT' | 'OTHER' | 'ALL'): string | null {
  const xs: string[] = [];
  for (const t of totals ?? []) {
    const subs = (t?.TaxSubtotal ?? []) as Node[];
    if (!subs.length) { const amt = text(t?.TaxAmount); if (amt && which !== 'OTHER') xs.push(amt); continue; }
    for (const st of subs) {
      const code = text(st?.TaxCategory?.TaxScheme?.TaxTypeCode);
      const amt = text(st?.TaxAmount);
      const isVat = code === '0015' || code === null;
      if (amt && (which === 'ALL' || (which === 'VAT') === isVat)) xs.push(amt);
    }
  }
  return xs.length ? sumDec(xs) ?? 'INVALID' : null; // okunamayan tutar "belgede yok" sayılmaz
}

/** Belgedeki tüm tutar düğümlerinin currencyID değerleri (benzersiz); derinlik sınırlı gezinme. */
function currencies(n: unknown, out = new Set<string>(), depth = 0): string[] {
  if (depth > 12 || n == null || typeof n !== 'object') return [...out];
  if (Array.isArray(n)) { for (const x of n) currencies(x, out, depth + 1); return [...out]; }
  for (const [k, v] of Object.entries(n as Node)) {
    if (k === '@currencyID' && typeof v === 'string' && v.trim()) out.add(v.trim().toUpperCase());
    else if (!k.startsWith('@') && k !== '#text') currencies(v, out, depth + 1);
  }
  return [...out];
}

export function parseUblInvoice(xml: Buffer): EInvoiceExtraction | null {
  let doc: Node;
  try {
    const s = xml.toString('utf8');
    // İyi biçimli olmayan XML "okundu" sayılmaz (ayrıştırıcı kapanmamış etiketi tolere eder): e-Fatura değil, elle girişe gider (D81).
    if (XMLValidator.validate(s) !== true) return null;
    doc = parser.parse(s);
  } catch {
    return null;
  }
  const inv: Node | undefined = doc.Invoice;
  if (!inv) return null;
  const pm: Node[] = inv.PaymentMeans ?? [];
  const iban = pm.map((x) => text(x?.PayeeFinancialAccount?.ID)).find(Boolean) ?? null;
  const total = inv.LegalMonetaryTotal?.PayableAmount;
  const seller = party(inv.AccountingSupplierParty, 'AccountingSupplierParty');
  const buyer = party(inv.AccountingCustomerParty, 'AccountingCustomerParty');
  const invLines = (inv.InvoiceLine ?? []) as Node[];
  const references = [...new Set(((inv.BillingReference ?? []) as Node[]).map((b) => text(b?.InvoiceDocumentReference?.ID)).filter((x): x is string => !!x))];
  return {
    header: {
      ublVersion: text(inv.UBLVersionID), customizationId: text(inv.CustomizationID), profileId: text(inv.ProfileID), typeCode: text(inv.InvoiceTypeCode),
      invoiceNumber: text(inv.ID), ettn: text(inv.UUID), issueDate: text(inv.IssueDate), documentCurrency: text(inv.DocumentCurrencyCode),
      amountCurrencies: currencies(inv), exchangeRate: text(inv.PricingExchangeRate?.CalculationRate),
      lineCountNumeric: text(inv.LineCountNumeric), lineCount: invLines.length, linesWithoutUnit: invLines.filter((l) => !l.InvoicedQuantity?.['@unitCode']).length,
      seller: { taxIdType: seller.taxIdType, taxId: seller.taxId }, buyer: { taxIdType: buyer.taxIdType, taxId: buyer.taxId },
      references, hasWithholding: ((inv.WithholdingTaxTotal ?? []) as Node[]).length > 0,
    },
    invoiceNumber: text(inv.ID),
    ettn: text(inv.UUID),
    issueDate: text(inv.IssueDate),
    currency: total?.['@currencyID'] ?? text(inv.DocumentCurrencyCode),
    payableAmount: text(total),
    seller,
    buyer,
    sellerIban: iban,
    typeCode: text(inv.InvoiceTypeCode)?.toUpperCase() ?? null,
    billingReference: references[0] ?? null,
    lines: invLines.map((l) => {
      const v = lineTaxes(l.TaxTotal);
      return {
        description: text(l.Item?.Name) ?? text(l.Item?.Description) ?? text(l.Note) ?? '',
        quantity: text(l.InvoicedQuantity), unitCode: l.InvoicedQuantity?.['@unitCode'] ?? null,
        unitPrice: text(l.Price?.PriceAmount), netAmount: text(l.LineExtensionAmount), taxRate: v.rate, taxAmount: v.amount, otherTax: v.other, otherTaxes: v.others,
      };
    }),
    totals: {
      lineExtension: text(inv.LegalMonetaryTotal?.LineExtensionAmount), taxExclusive: text(inv.LegalMonetaryTotal?.TaxExclusiveAmount),
      taxInclusive: text(inv.LegalMonetaryTotal?.TaxInclusiveAmount), taxTotal: sumTax(inv.TaxTotal, 'VAT'), otherTaxTotal: sumTax(inv.TaxTotal, 'OTHER'), withholding: sumTax(inv.WithholdingTaxTotal, 'ALL'), payable: text(total),
    },
  };
}
