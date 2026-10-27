import { add, cmp, dec, div, mul, str, type Dec } from './money.ts';

/**
 * Fatura–sipariş–kabul eşleştirmesi ve sözleşme limiti (FR10, 02 §12–13, T13–T16, T37). Saf ve deterministik.
 * Kontrol sonucu açıklanabilir: her bulgu neden, hangi satır ve kimin çözeceğiyle döner.
 */

/** Kullanılabilir limit = onaylı tavan − net tüketim − tüketilmemiş açık taahhüt (02 §13). */
export function availableLimit(ceiling: string, netConsumption: string, openCommitment: string): string {
  return str(add(dec(ceiling), -dec(netConsumption), -dec(openCommitment)));
}

/**
 * Açık taahhüt: sözleşmeye bağlı sipariş satırlarında sipariş tutarı − onaylı faturalanmış tutar (negatif olmaz).
 * Faturalanmış bölüm tekrar açık taahhüt sayılmaz (double count yok, T14).
 */
export function openCommitment(lines: { orderedAmount: string; invoicedAmount: string }[]): string {
  return str(add(...lines.map((l) => { const r = dec(l.orderedAmount) - dec(l.invoicedAmount); return r > 0n ? r : 0n; })));
}

/** Tolerans açık kuraldır; varsayılan evrensel tolerans yoktur. Kural yoksa sıfır. */
export interface ToleranceRule { currency: string; absAmount: string | null; percent: string | null; combine: 'LOWER' | 'HIGHER' }
export function allowedVariance(base: string, rule: ToleranceRule | null): string {
  if (!rule) return '0.00';
  const abs = rule.absAmount !== null ? dec(rule.absAmount) : null;
  const pct = rule.percent !== null ? div(mul(dec(base) < 0n ? -dec(base) : dec(base), dec(rule.percent)), dec('100')) : null;
  if (abs === null && pct === null) return '0.00';
  if (abs === null) return str(pct!);
  if (pct === null) return str(abs);
  return str(rule.combine === 'LOWER' ? (abs < pct ? abs : pct) : (abs > pct ? abs : pct));
}

export type IssueSeverity = 'BLOCK' | 'EXCEPTION' | 'REVIEW';
export interface MatchIssue { code: string; severity: IssueSeverity; message: string; ownerRole: string; lineNo?: number }

export interface PoLineState {
  poLineId: string; description: string; unit: string; currency: string; kind: 'GOODS' | 'SERVICE';
  orderedQty: string; unitPrice: string;
  /** Net kabul (ters kabuller düşülmüş). */
  receivedQty: string;
  /** Bu fatura hariç onaylı faturalarla tüketilmiş net miktar (iadeler düşülmüş). */
  invoicedQty: string;
  /** Aynı kapsamda net faturalanmış tutar; sipariş satırının kalan açık taahhüdü = sipariş tutarı − bu tutar. */
  invoicedAmount: string;
  contractVersionId: string | null;
}
export interface InvoiceLineInput { lineNo: number; description: string; quantity: string; unit: string; unitPrice: string; netAmount: string }
export interface AllocationInput { lineNo: number; poLineId: string | null; contractVersionId: string | null; quantity: string; amount: string }
export interface ContractState {
  contractVersionId: string; title: string; currency: string;
  /** Doğrulanmış tavan yoksa null (bedelsiz/sabit bedel veya doğrulanmamış). */
  ceiling: string | null; netConsumption: string; openCommitment: string;
  /** İmza kontrolü kesinleşmemiş veya arşivden alınmış: eski borç iptal edilmez, politika incelemesi (T37). */
  signatureUnresolved: boolean; archiveImport: boolean;
}

export interface InvoiceCheckInput {
  kind: 'INVOICE' | 'CREDIT_NOTE' | 'ADVANCE';
  currency: string;
  supplierActive: boolean;
  lines: InvoiceLineInput[];
  allocations: AllocationInput[];
  poLines: PoLineState[];
  contracts: ContractState[];
  tolerance: ToleranceRule | null;
  /** Bu faturaya uygulanan avans mahsubu ve mahsup edilebilir avans bakiyesi. */
  advanceOffset: string; advanceBalance: string;
}
export interface InvoiceCheck {
  issues: MatchIssue[];
  canApprove: boolean;
  needsException: boolean;
  /** Sözleşme başına bu faturanın tüketim etkisi (iade negatif). */
  contractImpact: Record<string, string>;
  /** Kullanılabilir limite etkisi: sipariş satırının kalan açık taahhüdünü aşan kısım + doğrudan sözleşme tahsisi. */
  limitImpact: Record<string, string>;
  netAmount: string; payable: string;
}

const sign = (kind: InvoiceCheckInput['kind']) => (kind === 'CREDIT_NOTE' ? -1n : 1n);

export function checkInvoice(i: InvoiceCheckInput): InvoiceCheck {
  const issues: MatchIssue[] = [];
  const push = (x: MatchIssue) => issues.push(x);
  if (!i.supplierActive) push({ code: 'SUPPLIER_NOT_ACTIVE', severity: 'BLOCK', ownerRole: 'MASTER_DATA', message: 'Satıcı aktif tedarikçi değil; aday firmaya ödeme onayı verilemez (BR02).' });
  const net = add(...i.lines.map((l) => dec(l.netAmount)));
  const impact: Record<string, Dec> = {};
  const limitImpact: Record<string, Dec> = {};

  for (const l of i.lines) {
    const al = i.allocations.filter((a) => a.lineNo === l.lineNo);
    const sum = add(...al.map((a) => dec(a.amount)));
    if (cmp(sum, dec(l.netAmount)) > 0) push({ code: 'OVER_ALLOCATED', severity: 'BLOCK', ownerRole: 'FINANCE', lineNo: l.lineNo, message: `Satır ${l.lineNo}: tahsis toplamı ${str(sum)} satır tutarını (${l.netAmount}) aşıyor.` });
    else if (cmp(sum, dec(l.netAmount)) < 0) push({ code: 'UNALLOCATED', severity: 'BLOCK', ownerRole: 'FINANCE', lineNo: l.lineNo, message: `Satır ${l.lineNo}: ${str(dec(l.netAmount) - sum)} ${i.currency} sipariş veya sözleşmeye tahsis edilmedi.` });
    if (i.kind === 'ADVANCE') continue;
    for (const a of al) {
      if (!a.poLineId && !a.contractVersionId) {
        push({ code: 'NO_CONTRACT', severity: 'EXCEPTION', ownerRole: 'PROCUREMENT_MANAGER', lineNo: l.lineNo, message: `Satır ${l.lineNo}: sipariş veya sözleşme bağı yok; sözleşmesiz fatura gerekçeli istisna gerektirir.` });
        continue;
      }
      const po = a.poLineId ? i.poLines.find((p) => p.poLineId === a.poLineId) : undefined;
      const cvId = po?.contractVersionId ?? a.contractVersionId;
      if (cvId) {
        impact[cvId] = (impact[cvId] ?? 0n) + sign(i.kind) * dec(a.amount);
        // Siparişe bağlı faturada siparişin ayırdığı açık taahhüt tüketime döner; limit yalnız aşan kısımla azalır (çift sayım yok).
        let li = sign(i.kind) * dec(a.amount);
        if (po) {
          const remaining = mul(dec(po.orderedQty), dec(po.unitPrice)) - dec(po.invoicedAmount);
          li = i.kind === 'CREDIT_NOTE' ? 0n : dec(a.amount) - (remaining > 0n ? remaining : 0n);
          if (li < 0n) li = 0n;
        }
        limitImpact[cvId] = (limitImpact[cvId] ?? 0n) + li;
      }
      if (!po) continue;
      if (po.currency !== i.currency) { push({ code: 'CURRENCY_MISMATCH', severity: 'BLOCK', ownerRole: 'FINANCE', lineNo: l.lineNo, message: `Satır ${l.lineNo}: fatura ${i.currency}, sipariş ${po.currency}; para birimi farkı toleransla geçmez.` }); continue; }
      if (l.unit.trim().toLocaleLowerCase('tr-TR') !== po.unit.trim().toLocaleLowerCase('tr-TR')) push({ code: 'UNIT_MISMATCH', severity: 'BLOCK', ownerRole: 'BUYER', lineNo: l.lineNo, message: `Satır ${l.lineNo}: birim "${l.unit}", sipariş birimi "${po.unit}".` });
      if (i.kind === 'INVOICE') {
        const avail = dec(po.receivedQty) - dec(po.invoicedQty);
        if (cmp(dec(a.quantity), avail) > 0) {
          const missing = dec(a.quantity) - (avail > 0n ? avail : 0n);
          push({ code: 'RECEIPT_MISSING', severity: 'EXCEPTION', ownerRole: 'REQUESTER', lineNo: l.lineNo,
            message: `Satır ${l.lineNo}: ${str(missing, 2).replace(/\.00$/, '')} ${po.unit} için ${po.kind === 'SERVICE' ? 'hizmet/dönem' : 'mal'} kabul kaydı yok (kabul ${po.receivedQty}, önceden faturalanan ${po.invoicedQty}).` });
        }
        if (cmp(add(dec(po.invoicedQty), dec(a.quantity)), dec(po.orderedQty)) > 0) push({ code: 'OVER_ORDER', severity: 'EXCEPTION', ownerRole: 'BUYER', lineNo: l.lineNo, message: `Satır ${l.lineNo}: toplam faturalanan miktar sipariş miktarını (${po.orderedQty}) aşıyor.` });
        const diff = dec(l.unitPrice) - dec(po.unitPrice);
        const allowed = dec(allowedVariance(str(mul(dec(po.unitPrice), dec(a.quantity))), i.tolerance?.currency === i.currency ? i.tolerance : null));
        const total = mul(diff < 0n ? -diff : diff, dec(a.quantity));
        if (diff !== 0n && cmp(total, allowed) > 0) push({ code: 'PRICE_MISMATCH', severity: 'EXCEPTION', ownerRole: 'BUYER', lineNo: l.lineNo, message: `Satır ${l.lineNo}: birim fiyat ${l.unitPrice}, sipariş ${po.unitPrice}; fark ${str(total)} ${i.currency}, tolerans ${str(allowed)}.` });
      } else if (cmp(add(dec(po.invoicedQty), -dec(a.quantity)), 0n) < 0) {
        push({ code: 'CREDIT_EXCEEDS', severity: 'BLOCK', ownerRole: 'FINANCE', lineNo: l.lineNo, message: `Satır ${l.lineNo}: iade miktarı daha önce faturalanan miktarı aşıyor.` });
      }
    }
  }
  for (const cvId of Object.keys(impact)) {
    const c = i.contracts.find((x) => x.contractVersionId === cvId);
    if (!c) continue;
    const amt = limitImpact[cvId] ?? 0n;
    if (c.ceiling !== null && amt > 0n) {
      const avail = dec(availableLimit(c.ceiling, c.netConsumption, c.openCommitment));
      if (cmp(amt, avail) > 0) push({ code: 'LIMIT_EXCEEDED', severity: 'BLOCK', ownerRole: 'PROCUREMENT_MANAGER', message: `${c.title}: kullanılabilir limit ${str(avail)} ${c.currency}, bu fatura ${str(amt)}. Zeyilname veya yetkili karar gerekir.` });
    }
    if (c.signatureUnresolved || c.archiveImport) {
      // T37: eski borç otomatik iptal edilmez; politika incelemesi açılır.
      push({ code: 'CONTRACT_SIGNATURE_UNRESOLVED', severity: 'REVIEW', ownerRole: 'LEGAL', message: `${c.title}: imza kontrolü tamamlanmamış${c.archiveImport ? ' (arşivden alındı)' : ''}. Fatura iptal edilmez; ödeme politikası hukuk/finans incelemesine bağlıdır.` });
    }
  }
  const offset = dec(i.advanceOffset);
  if (offset < 0n || cmp(offset, dec(i.advanceBalance)) > 0) push({ code: 'ADVANCE_OFFSET_INVALID', severity: 'BLOCK', ownerRole: 'FINANCE', message: `Avans mahsubu ${i.advanceOffset}, kullanılabilir avans bakiyesi ${i.advanceBalance}.` });
  if (i.kind !== 'INVOICE' && offset !== 0n) push({ code: 'ADVANCE_OFFSET_INVALID', severity: 'BLOCK', ownerRole: 'FINANCE', message: 'Avans mahsubu yalnız normal faturada yapılır.' });
  if (cmp(offset, net) > 0) push({ code: 'ADVANCE_OFFSET_INVALID', severity: 'BLOCK', ownerRole: 'FINANCE', message: 'Mahsup fatura tutarını aşamaz.' });
  return {
    issues,
    canApprove: !issues.some((x) => x.severity === 'BLOCK'),
    needsException: issues.some((x) => x.severity === 'EXCEPTION' || x.severity === 'REVIEW'),
    contractImpact: Object.fromEntries(Object.entries(impact).map(([k, v]) => [k, str(v)])),
    limitImpact: Object.fromEntries(Object.entries(limitImpact).map(([k, v]) => [k, str(v)])),
    netAmount: str(net), payable: str(net - offset),
  };
}

/** Net tüketim (sözleşme): onaylı fatura tahsisleri − onaylı iade tahsisleri. Avans tüketim değildir; mahsup ödenecek tutarı düşürür. */
export function netConsumption(rows: { kind: 'INVOICE' | 'CREDIT_NOTE' | 'ADVANCE'; amount: string }[]): string {
  return str(add(...rows.filter((r) => r.kind !== 'ADVANCE').map((r) => (r.kind === 'CREDIT_NOTE' ? -dec(r.amount) : dec(r.amount)))));
}
