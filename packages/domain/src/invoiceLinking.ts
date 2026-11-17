/**
 * v2 Faz 7 (R1–R4): fatura ↔ sözleşme ailesi eşleştirme, eşleşme durumu ve sözleşme kullanımı.
 * Saf kural: veri tabanına dokunmaz. Para decimal string (money.ts); float yok.
 */
import { add, cmp, dec, div, str, type Dec } from './money.ts';

export interface LinkContract {
  familyId: string; code: string; contractNo: string | null; supplierRootId: string;
  start: string | null; end: string | null; indefinite: boolean; status: 'APPROVED' | 'LEGACY' | string;
  projectId: string | null; departmentId: string | null;
}
/** `link_failed`: karar verildi ama bağ kaydedilemedi (API yedeği; `matchInvoice` döndürmez). */
export type UnmatchedReason = 'ref_not_found' | 'ref_conflict' | 'ref_supplier_mismatch' | 'no_active_contract' | 'multiple_active_contracts' | 'link_failed';
export type MatchResult =
  | { method: 'ERP_REF' | 'SUPPLIER_DATE'; familyId: string }
  | { method: 'UNMATCHED'; reason: UnmatchedReason };

export const MATCH_REASON_TR: Record<UnmatchedReason, string> = {
  ref_not_found: 'ERP referansı hiçbir sözleşme ya da siparişle eşleşmedi',
  ref_conflict: 'Sipariş ve sözleşme referansları farklı sözleşmeleri gösteriyor',
  ref_supplier_mismatch: 'ERP referansı başka tedarikçinin sözleşmesini gösteriyor',
  no_active_contract: 'Tedarikçinin fatura tarihinde geçerli onaylı sözleşmesi yok',
  multiple_active_contracts: 'Tedarikçinin fatura tarihinde birden çok geçerli sözleşmesi var',
  link_failed: 'Sözleşme bulundu ama bağ kaydedilemedi; faturayı elle bağlayın',
};
export const MATCH_METHOD_TR = {
  ERP_REF: 'ERP referansı',
  SUPPLIER_DATE: 'Tedarikçi ve tarih',
  MANUAL: 'Elle',
} as const;
export type MatchMethod = keyof typeof MATCH_METHOD_TR;
export const MATCH_STATE_TR = {
  MATCHED: 'Eşleşti',
  ALLOCATED: 'Tahsisle (eski kayıt)',
  MIXED: 'Birden çok sözleşmeye tahsisli',
  UNMATCHED: 'Eşleşmedi',
} as const;
export type MatchState = keyof typeof MATCH_STATE_TR;

/**
 * Referans karşılaştırması: kırpılmış ve yalnız ASCII a–z büyük harfe çevrilmiş (yerel ayardan bağımsız; tr-TR "I"→"ı" sorunu yok).
 * API ön süzgeci SQL'de aynı biçimi kullanır (`translate(btrim(x), 'a..z', 'A..Z')`).
 */
export const normalizeRef = (s: string | null | undefined): string => (s ?? '').trim().replace(/[a-z]/g, (c) => c.toUpperCase());
const norm = normalizeRef;

/** Tarih (YYYY-MM-DD) sözleşme geçerlilik aralığında mı; süresiz sözleşmede yalnız başlangıç aranır. */
function inRange(c: LinkContract, day: string): boolean {
  if (!c.start || day < c.start) return false;
  if (c.indefinite) return true;
  return c.end !== null && day <= c.end;
}

export function matchInvoice(input: {
  invoice: { supplierRootId: string; issueDate: string; erpContractRef: string | null; erpOrderRef: string | null };
  contracts: LinkContract[];
  orders: { code: string; familyId: string | null }[];
}): MatchResult {
  const { invoice, contracts, orders } = input;

  // (1) ERP referansı verildiyse yalnız referans konuşur: çözülemezse ya da çelişirse tarih eşleşmesine düşülmez.
  const orderRef = norm(invoice.erpOrderRef);
  const contractRef = norm(invoice.erpContractRef);
  if (orderRef !== '' || contractRef !== '') {
    const resolved: Set<string>[] = [];
    if (orderRef) {
      const o = orders.find((x) => norm(x.code) === orderRef);
      const f = o?.familyId && contracts.some((c) => c.familyId === o.familyId) ? o.familyId : null;
      if (!f) return { method: 'UNMATCHED', reason: 'ref_not_found' };
      resolved.push(new Set([f]));
    }
    if (contractRef) {
      const fams = new Set(contracts.filter((c) => norm(c.code) === contractRef || (c.contractNo && norm(c.contractNo) === contractRef)).map((c) => c.familyId));
      if (fams.size === 0) return { method: 'UNMATCHED', reason: 'ref_not_found' };
      resolved.push(fams);
    }
    const all = new Set(resolved.flatMap((x) => [...x]));
    if (all.size > 1) return { method: 'UNMATCHED', reason: 'ref_conflict' };
    const familyId = [...all][0]!;
    const ok = contracts.filter((c) => c.familyId === familyId).every((c) => c.supplierRootId === invoice.supplierRootId);
    return ok ? { method: 'ERP_REF', familyId } : { method: 'UNMATCHED', reason: 'ref_supplier_mismatch' };
  }

  // (2) Aynı tedarikçi + fatura tarihi + onaylı/eski kayıt tam bir aile.
  const families = new Set(
    contracts
      .filter((c) => c.supplierRootId === invoice.supplierRootId && (c.status === 'APPROVED' || c.status === 'LEGACY') && inRange(c, invoice.issueDate))
      .map((c) => c.familyId),
  );
  if (families.size === 1) return { method: 'SUPPLIER_DATE', familyId: [...families][0]! };
  if (families.size > 1) return { method: 'UNMATCHED', reason: 'multiple_active_contracts' };
  return { method: 'UNMATCHED', reason: 'no_active_contract' };
}

/** Eşleşme durumu türetilir (saklanmaz): saklı bağ > tek aileye tahsis > çok aileye tahsis > yok. */
export function matchState(i: { familyId: string | null; allocationFamilies: string[] }): MatchState {
  if (i.familyId) return 'MATCHED';
  const fams = new Set(i.allocationFamilies);
  if (fams.size === 1) return 'ALLOCATED';
  if (fams.size > 1) return 'MIXED';
  return 'UNMATCHED';
}

export type UsageLevel = 'OK' | 'NEAR' | 'OVER' | 'NO_AMOUNT';
export const USAGE_LEVEL_TR: Record<UsageLevel, string> = {
  OK: 'Sınır içinde', NEAR: 'Sınıra yakın', OVER: 'Sınır aşıldı', NO_AMOUNT: 'Sözleşme tutarı yok',
};

/** Sözleşme kullanımı (R4): iade/alacak düşer; yakınlık eşiği tam %90 (kesin tamsayı karşılaştırması); para birimi farklı fatura toplama girmez, ayrı listelenir. */
export function contractUsage(i: {
  amount: string | null; currency: string; basis: 'NET' | 'GROSS';
  invoices: { kind: string; currency: string; net: string; tax: string }[];
}): { used: string; ratio: string | null; level: UsageLevel; overBy: string | null; foreignCurrency: { currency: string; total: string }[] } {
  let used: Dec = 0n;
  const foreign = new Map<string, Dec>();
  for (const v of i.invoices) {
    const base = i.basis === 'GROSS' ? add(dec(v.net), dec(v.tax)) : dec(v.net);
    const abs = base < 0n ? -base : base;
    const signed = v.kind === 'CREDIT_NOTE' ? -abs : abs;
    if (v.currency === i.currency) used = add(used, signed);
    else foreign.set(v.currency, add(foreign.get(v.currency) ?? 0n, signed));
  }
  const foreignCurrency = [...foreign.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([currency, t]) => ({ currency, total: str(t) }));
  const out = { used: str(used), foreignCurrency };
  if (i.amount === null || cmp(dec(i.amount), 0n) <= 0) return { ...out, ratio: null, level: 'NO_AMOUNT', overBy: null };
  const amount = dec(i.amount);
  const ratio = str(div(used, amount), 4);
  if (cmp(used, amount) > 0) return { ...out, ratio, level: 'OVER', overBy: str(used - amount) };
  if (cmp(used * 10n, amount * 9n) >= 0) return { ...out, ratio, level: 'NEAR', overBy: null };
  return { ...out, ratio, level: 'OK', overBy: null };
}
