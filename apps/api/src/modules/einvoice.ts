import { XMLParser } from 'fast-xml-parser';

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
}

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@',
  removeNSPrefix: true,
  processEntities: false,
  htmlEntities: false,
  parseTagValue: false,
  isArray: (name) => ['PartyIdentification', 'PaymentMeans'].includes(name),
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
  };
}
