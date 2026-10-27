import { XMLParser } from 'fast-xml-parser';
import { add, dec, isDecimal, str } from '@sp/domain';

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
}
export interface EInvoiceLine { description: string; quantity: string | null; unitCode: string | null; unitPrice: string | null; netAmount: string | null; taxRate: string | null; taxAmount: string | null; otherTax: string | null }

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
 * KDV dışı vergiler KDV matrahına girer ve ödenecek tutara eklenir; tutarları beyandır, oranları bu sürümde kontrol edilmez.
 */
function lineTaxes(totals: Node[] | undefined): { rate: string | null; amount: string | null; other: string | null } {
  let rate: string | null = null; let amount: string | null = null; const other: string[] = [];
  for (const t of totals ?? []) for (const st of (t?.TaxSubtotal ?? []) as Node[]) {
    const code = text(st?.TaxCategory?.TaxScheme?.TaxTypeCode);
    if ((code === '0015' || code === null) && amount === null) { rate = text(st?.Percent) ?? text(st?.TaxCategory?.Percent); amount = text(st?.TaxAmount); }
    else if (code !== '0015' && code !== null) { const a = text(st?.TaxAmount); if (a) other.push(a); }
  }
  return { rate, amount, other: other.length ? sumDec(other) ?? 'INVALID' : null };
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

export function parseUblInvoice(xml: Buffer): EInvoiceExtraction | null {
  let doc: Node;
  try {
    doc = parser.parse(xml.toString('utf8'));
  } catch {
    return null;
  }
  const inv: Node | undefined = doc.Invoice;
  if (!inv) return null;
  const pm: Node[] = inv.PaymentMeans ?? [];
  const iban = pm.map((x) => text(x?.PayeeFinancialAccount?.ID)).find(Boolean) ?? null;
  const total = inv.LegalMonetaryTotal?.PayableAmount;
  return {
    invoiceNumber: text(inv.ID),
    ettn: text(inv.UUID),
    issueDate: text(inv.IssueDate),
    currency: total?.['@currencyID'] ?? text(inv.DocumentCurrencyCode),
    payableAmount: text(total),
    seller: party(inv.AccountingSupplierParty, 'AccountingSupplierParty'),
    buyer: party(inv.AccountingCustomerParty, 'AccountingCustomerParty'),
    sellerIban: iban,
    typeCode: text(inv.InvoiceTypeCode)?.toUpperCase() ?? null,
    billingReference: ((inv.BillingReference ?? []) as Node[]).map((b) => text(b?.InvoiceDocumentReference?.ID)).find(Boolean) ?? null,
    lines: ((inv.InvoiceLine ?? []) as Node[]).map((l) => {
      const v = lineTaxes(l.TaxTotal);
      return {
        description: text(l.Item?.Name) ?? text(l.Item?.Description) ?? text(l.Note) ?? '',
        quantity: text(l.InvoicedQuantity), unitCode: l.InvoicedQuantity?.['@unitCode'] ?? null,
        unitPrice: text(l.Price?.PriceAmount), netAmount: text(l.LineExtensionAmount), taxRate: v.rate, taxAmount: v.amount, otherTax: v.other,
      };
    }),
    totals: {
      lineExtension: text(inv.LegalMonetaryTotal?.LineExtensionAmount), taxExclusive: text(inv.LegalMonetaryTotal?.TaxExclusiveAmount),
      taxInclusive: text(inv.LegalMonetaryTotal?.TaxInclusiveAmount), taxTotal: sumTax(inv.TaxTotal, 'VAT'), otherTaxTotal: sumTax(inv.TaxTotal, 'OTHER'), withholding: sumTax(inv.WithholdingTaxTotal, 'ALL'), payable: text(total),
    },
  };
}
