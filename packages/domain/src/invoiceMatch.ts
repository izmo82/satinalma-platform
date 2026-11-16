import { add, cmp, dec, div, isDecimal as isDec, mul, str, type Dec } from './money.ts';

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
export interface ToleranceRule { currency: string; absAmount: string | null; percent: string | null; combine: 'LOWER' | 'HIGHER';
  /** Alım kategorisi (siparişin projesi); '' veya yok = o para biriminde kategori kuralı olmayan bütün alımlar. */
  category?: string }
/** Kategori kuralı varsa o, yoksa para biriminin genel kuralı; ikisi de yoksa tolerans sıfır. Kimlik/para birimi farkı hiçbir kuralla geçmez. */
export function pickTolerance(rules: ToleranceRule[], currency: string, category: string | null | undefined): ToleranceRule | null {
  const same = rules.filter((r) => r.currency === currency);
  const cat = (category ?? '').trim().toLocaleLowerCase('tr-TR');
  return (cat && same.find((r) => (r.category ?? '').trim().toLocaleLowerCase('tr-TR') === cat)) || same.find((r) => !(r.category ?? '').trim()) || null;
}
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
/**
 * v2 Faz 1 (D93): kaldırma listesindeki üçlü eşleştirme (sipariş/kabul), fiyat toleransı ve sözleşmesiz istisna bulguları.
 * Hesap değişmez (eski sipariş bağlı faturalar için kayıt doğru kalır); arayüz göstermez, görev açılmaz. Web ve API bu tek listeyi kullanır.
 */
/**
 * v2 eşleşme durumu (düzeltme dalgası I5): fatura, satırı varsa ve tahsisi engelleyen bulgu (eksik, fazla, başka tedarikçi ya da şirkete
 * tahsis) yoksa "Eşleşti" sayılır. Liste (API), web ve iOS aynı listeyi kullanır.
 */
export const MATCH_BLOCKING_CODES: readonly string[] = ['UNALLOCATED', 'OVER_ALLOCATED', 'SUPPLIER_MISMATCH', 'COMPANY_MISMATCH'];
export const allocationMatched = (hasLines: boolean, issues: readonly { code: string }[]): boolean =>
  hasLines && !issues.some((i) => MATCH_BLOCKING_CODES.includes(i.code));

export const REMOVED_ISSUE_CODES: readonly string[] = ['RECEIPT_MISSING', 'OVER_ORDER', 'PRICE_MISMATCH', 'UNIT_MISMATCH', 'PO_CANCELLED', 'CURRENCY_MISMATCH', 'CREDIT_EXCEEDS', 'NO_CONTRACT'];
export interface MatchIssue { code: string; severity: IssueSeverity; message: string; ownerRole: string; lineNo?: number }

export interface PoLineState {
  poLineId: string; description: string; unit: string; currency: string; kind: 'GOODS' | 'SERVICE';
  /** Kapatılmış siparişte miktar tüketilen kadardır; iptal edilmiş siparişe yeni fatura bağlanmaz. */
  poStatus?: 'OPEN' | 'CLOSED' | 'CANCELLED';
  orderedQty: string; unitPrice: string;
  /** Net kabul (ters kabuller düşülmüş). */
  receivedQty: string;
  /** Bu fatura hariç onaylı faturalarla tüketilmiş net miktar (iadeler düşülmüş). */
  invoicedQty: string;
  /** Aynı kapsamda net faturalanmış tutar; sipariş satırının kalan açık taahhüdü = sipariş tutarı − bu tutar. */
  invoicedAmount: string;
  contractVersionId: string | null;
  /** Alım kategorisi (siparişin projesinden): kategori bazında tolerans. */
  category?: string | null;
  /** Sipariş satırının KDV oranı (%): vergi dahil limitli sözleşmede açık taahhüt brüt hesaplanır. */
  taxRate?: string | null;
  /** Siparişin tedarikçi kökü (D84). */
  supplierRootId?: string | null;
  /** Siparişin şirketi (D87). */
  companyId?: string | null;
}
export interface InvoiceLineInput {
  lineNo: number; description: string; quantity: string; unit: string; unitPrice: string; netAmount: string;
  /** KDV oranı (%) ve belgede beyan edilen satır KDV'si (yoksa hesaplanır, karşılaştırılmaz). */
  taxRate?: string; taxAmount?: string | null;
  /** KDV dışı satır vergileri (ÖTV, ÖİV…) toplamı: KDV matrahına girer, ödenecek tutara eklenir. */
  otherTax?: string | null;
  /** KDV dışı vergiler tek tek: oran varsa tutar = net × oran denetlenir; oransız (maktu) tutar beyan olarak kalır. */
  otherTaxes?: OtherTax[] | null;
}
export interface OtherTax { code: string | null; name?: string | null; rate: string | null; amount: string }
/** Belgede beyan edilen toplamlar (e-Fatura XML veya elle giriş). null = belgede yok. */
export interface DeclaredTotals { taxTotal: string | null; withholding: string | null; payable: string | null; otherTaxTotal?: string | null }
export interface AllocationInput { lineNo: number; poLineId: string | null; contractVersionId: string | null; quantity: string; amount: string }
export interface ContractState {
  contractVersionId: string; title: string; currency: string;
  /** Doğrulanmış tavan yoksa null (bedelsiz/sabit bedel veya doğrulanmamış). */
  ceiling: string | null; netConsumption: string; openCommitment: string;
  /** NET: tavan vergi hariç; GROSS: KDV ve KDV dışı vergiler dahil (tüketim ve açık taahhüt de brüt verilir). */
  limitBasis?: 'NET' | 'GROSS';
  /** İmza kontrolü kesinleşmemiş veya arşivden alınmış: eski borç iptal edilmez, politika incelemesi (T37). */
  signatureUnresolved: boolean; archiveImport: boolean;
  /** Sözleşmenin tedarikçi kökleri (aile tedarikçisi + SUPPLIER tarafları); hiç tedarikçi kayıtlı değilse boş (kontrol edilmez). */
  supplierRootIds?: string[];
  /** Sözleşmenin şirketi (D87). */
  companyId?: string | null;
}

export interface InvoiceCheckInput {
  kind: 'INVOICE' | 'CREDIT_NOTE' | 'ADVANCE';
  currency: string;
  supplierActive: boolean;
  /** Faturanın şirketi; verilmezse şirket eşleşmesi denetlenmez (D87). */
  companyId?: string | null;
  /** Faturanın tedarikçi kökü (birleştirilmiş kayıtta hedef firma); tahsis hedefleriyle karşılaştırılır (D84). */
  supplierRootId?: string | null;
  /** İade belgesinde onaylı özgün faturanın tahsis hedefleri (sipariş satırı/sözleşme): yanlış bağı geri alma yolu kapanmasın (D84). */
  reversalTargets?: string[];
  lines: InvoiceLineInput[];
  allocations: AllocationInput[];
  poLines: PoLineState[];
  contracts: ContractState[];
  /** Tek kural (geriye uyum) veya kiracının bütün kuralları; satır başına siparişin kategorisine göre seçilir. */
  tolerance?: ToleranceRule | null;
  tolerances?: ToleranceRule[];
  /** Bu faturaya uygulanan avans mahsubu ve mahsup edilebilir avans bakiyesi. */
  advanceOffset: string; advanceBalance: string;
  declared?: DeclaredTotals;
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
  /** KDV toplamı (beyan edilen satır KDV'si veya oran × net) ve vergi dahil tutar − tevkifat. */
  taxTotal: string; otherTaxTotal: string; grossAmount: string;
}

/** Yuvarlama payı: satır başına 1 kuruş; toplamlarda satır sayısı kadar kuruş (satır bazında yuvarlanmış vergiler). */
const KURUS = dec('0.01');
const absd = (x: Dec) => (x < 0n ? -x : x);

/**
 * Vergi aritmetiği (02 §AI dışı kurallar): satır KDV'si = net × oran, belge KDV toplamı = satırların toplamı,
 * ödenecek = net + KDV − tevkifat. Belgedeki değer doğru kabul edilmez; tutmazsa düzeltme belgesi istenir.
 */
export function checkTax(lines: InvoiceLineInput[], declared: DeclaredTotals | undefined, currency: string) {
  const issues: MatchIssue[] = [];
  let tax = 0n;
  let otherSum = 0n;
  /** Satırın vergi dahil tutarı (net + KDV dışı + KDV): vergi dahil limit için. */
  const lineGross = new Map<number, Dec>();
  for (const l of lines) {
    const rate = l.taxRate ?? '0';
    if (!isDec(rate) || dec(rate) < 0n || dec(rate) > dec('100')) {
      issues.push({ code: 'TAX_RATE_INVALID', severity: 'BLOCK', ownerRole: 'FINANCE', lineNo: l.lineNo, message: `Satır ${l.lineNo}: KDV oranı geçersiz (${rate}).` });
      continue;
    }
    const parts = l.otherTaxes ?? [];
    let other = l.otherTax ? dec(l.otherTax) : 0n;
    if (parts.length) {
      const partSum = add(...parts.map((p) => (isDec(p.amount) ? dec(p.amount) : 0n)));
      if (!l.otherTax) other = partSum;
      else if (cmp(absd(partSum - other), KURUS) > 0) issues.push({ code: 'OTHER_TAX_MISMATCH', severity: 'BLOCK', ownerRole: 'FINANCE', lineNo: l.lineNo,
        message: `Satır ${l.lineNo}: KDV dışı vergilerin toplamı ${l.otherTax} ${currency}, kalemlerin toplamı ${str(partSum)}.` });
      for (const p of parts) {
        const label = p.name || p.code || 'KDV dışı vergi';
        if (!isDec(p.amount) || dec(p.amount) < 0n) { issues.push({ code: 'OTHER_TAX_INVALID', severity: 'BLOCK', ownerRole: 'FINANCE', lineNo: l.lineNo, message: `Satır ${l.lineNo}: ${label} tutarı geçersiz (${p.amount}).` }); continue; }
        if (p.rate === null || p.rate === '') continue; // maktu vergi: oran yok, tutar beyan
        if (!isDec(p.rate) || dec(p.rate) < 0n || dec(p.rate) > dec('100')) { issues.push({ code: 'OTHER_TAX_RATE_INVALID', severity: 'BLOCK', ownerRole: 'FINANCE', lineNo: l.lineNo, message: `Satır ${l.lineNo}: ${label} oranı geçersiz (${p.rate}).` }); continue; }
        // KDV dışı vergilerin matrahı satırın net tutarıdır (ÖTV/ÖİV oransal).
        const exp = dec(str(div(mul(dec(l.netAmount), dec(p.rate)), dec('100'))));
        if (cmp(absd(dec(p.amount) - exp), KURUS) > 0) issues.push({ code: 'OTHER_TAX_RATE_MISMATCH', severity: 'BLOCK', ownerRole: 'FINANCE', lineNo: l.lineNo,
          message: `Satır ${l.lineNo}: ${label} ${p.amount} ${currency} yazıyor; ${l.netAmount} × %${str(dec(p.rate)).replace(/\.00$/, '')} = ${str(exp)}. Satıcıdan düzeltme istenir.` });
      }
    }
    otherSum += other;
    // KDV matrahı = net + KDV dışı vergiler (ÖTV/ÖİV dahil, KDVK 24).
    const base = dec(l.netAmount) + other;
    const expected = dec(str(div(mul(base, dec(rate)), dec('100'))));
    if (l.taxAmount != null && l.taxAmount !== '') {
      const d = dec(l.taxAmount);
      if (cmp(absd(d - expected), KURUS) > 0) issues.push({ code: 'TAX_LINE_MISMATCH', severity: 'BLOCK', ownerRole: 'FINANCE', lineNo: l.lineNo,
        message: `Satır ${l.lineNo}: KDV ${l.taxAmount} ${currency} yazıyor; ${str(base)} × %${str(dec(rate)).replace(/\.00$/, '')} = ${str(expected)}. Satıcıdan düzeltme istenir.` });
      tax += d;
      lineGross.set(l.lineNo, dec(l.netAmount) + other + d);
    } else { tax += expected; lineGross.set(l.lineNo, dec(l.netAmount) + other + expected); }
  }
  const net = add(...lines.map((l) => dec(l.netAmount)));
  const slack = KURUS * BigInt(Math.max(lines.length, 1));
  if (declared?.taxTotal != null && cmp(absd(dec(declared.taxTotal) - tax), slack) > 0) {
    issues.push({ code: 'TAX_TOTAL_MISMATCH', severity: 'BLOCK', ownerRole: 'FINANCE', message: `Belgedeki KDV toplamı ${declared.taxTotal} ${currency}, satırların toplamı ${str(tax)}.` });
  }
  const withholding = declared?.withholding != null ? dec(declared.withholding) : 0n;
  if (withholding < 0n || cmp(withholding, tax) > 0) issues.push({ code: 'WITHHOLDING_INVALID', severity: 'BLOCK', ownerRole: 'FINANCE', message: `Tevkifat ${declared!.withholding} ${currency}, KDV toplamını (${str(tax)}) aşamaz.` });
  if (declared?.otherTaxTotal != null && cmp(absd(dec(declared.otherTaxTotal) - otherSum), slack) > 0) {
    issues.push({ code: 'OTHER_TAX_MISMATCH', severity: 'BLOCK', ownerRole: 'FINANCE', message: `Belgedeki KDV dışı vergi toplamı (ÖTV/ÖİV vb.) ${declared.otherTaxTotal} ${currency}, satırların toplamı ${str(otherSum)}.` });
  }
  const gross = net + otherSum + tax - withholding;
  if (declared?.payable != null && cmp(absd(dec(declared.payable) - gross), slack) > 0) {
    issues.push({ code: 'PAYABLE_MISMATCH', severity: 'BLOCK', ownerRole: 'FINANCE',
      message: `Belgedeki ödenecek tutar ${declared.payable} ${currency}; net ${str(net)}${otherSum ? ` + diğer vergiler ${str(otherSum)}` : ''} + KDV ${str(tax)}${withholding ? ` − tevkifat ${str(withholding)}` : ''} = ${str(gross)}.` });
  }
  return { issues, taxTotal: str(tax), otherTaxTotal: str(otherSum), grossAmount: str(gross), lineGross };
}

const sign = (kind: InvoiceCheckInput['kind']) => (kind === 'CREDIT_NOTE' ? -1n : 1n);

export function checkInvoice(i: InvoiceCheckInput): InvoiceCheck {
  const issues: MatchIssue[] = [];
  const push = (x: MatchIssue) => issues.push(x);
  if (!i.supplierActive) push({ code: 'SUPPLIER_NOT_ACTIVE', severity: 'BLOCK', ownerRole: 'MASTER_DATA', message: 'Satıcı aktif tedarikçi değil; aday firmanın faturası işlenmeden önce tedarikçi kaydı aktifleştirilmeli (BR02).' });
  const net = add(...i.lines.map((l) => dec(l.netAmount)));
  const tax = checkTax(i.lines, i.declared, i.currency);
  issues.push(...tax.issues);
  const impact: Record<string, Dec> = {};
  const limitImpact: Record<string, Dec> = {};
  const rules = i.tolerances ?? (i.tolerance ? [i.tolerance] : []);
  const gross = (cvId: string) => i.contracts.find((c) => c.contractVersionId === cvId)?.limitBasis === 'GROSS';
  /** Tahsisin vergi dahil karşılığı: satırın brüt/net oranıyla (satır bazında, kuruşa yuvarlanmış). */
  const grossOf = (lineNo: number, netPart: Dec) => {
    const ln = i.lines.find((x) => x.lineNo === lineNo);
    const g = tax.lineGross.get(lineNo);
    if (!ln || g === undefined || dec(ln.netAmount) === 0n) return netPart;
    return dec(str(div(mul(netPart, g), dec(ln.netAmount))));
  };

  for (const l of i.lines) {
    const al = i.allocations.filter((a) => a.lineNo === l.lineNo);
    const sum = add(...al.map((a) => dec(a.amount)));
    if (cmp(sum, dec(l.netAmount)) > 0) push({ code: 'OVER_ALLOCATED', severity: 'BLOCK', ownerRole: 'FINANCE', lineNo: l.lineNo, message: `Satır ${l.lineNo}: tahsis toplamı ${str(sum)} satır tutarını (${l.netAmount}) aşıyor.` });
    else if (cmp(sum, dec(l.netAmount)) < 0) push({ code: 'UNALLOCATED', severity: 'BLOCK', ownerRole: 'FINANCE', lineNo: l.lineNo, message: `Satır ${l.lineNo}: ${str(dec(l.netAmount) - sum)} ${i.currency} sözleşmeye tahsis edilmedi.` });
    // Aynı ünvanlı başka bir tüzel kişinin siparişine/sözleşmesine tahsis, tedarikçi sonradan aktifleşse de engel kalır (D84).
    const reversal = (id: string | null) => !!id && !!i.reversalTargets?.includes(id);
    const foreignPo = (id: string | null) => {
      const root = i.poLines.find((p) => p.poLineId === id)?.supplierRootId;
      return !reversal(id) && !!i.supplierRootId && !!root && root !== i.supplierRootId;
    };
    const foreignContract = (id: string | null) => {
      const roots = i.contracts.find((c) => c.contractVersionId === id)?.supplierRootIds ?? [];
      return !reversal(id) && !!i.supplierRootId && roots.length > 0 && !roots.includes(i.supplierRootId);
    };
    if (al.some((a) => foreignPo(a.poLineId) || foreignContract(a.contractVersionId))) {
      push({ code: 'SUPPLIER_MISMATCH', severity: 'BLOCK', ownerRole: 'FINANCE', lineNo: l.lineNo, message: `Satır ${l.lineNo}: ${al.some((a) => foreignPo(a.poLineId)) ? 'bağlı eski sipariş bağı' : 'bağlı sözleşme'} bu faturanın tedarikçisine ait değil (aynı ünvanlı başka bir kayıt olabilir); tahsisi düzenleyip bu bağı kaldırın.` });
    }
    // Kapsam dışı hedef RLS nedeniyle yüklenmez; yok saymak kontrolü atlatırdı, engel sayılır (D87).
    const otherCompany = (id: string | null, owner: { companyId?: string | null } | undefined) => !!i.companyId && !!id && !reversal(id) && owner?.companyId !== i.companyId;
    if (al.some((a) => otherCompany(a.poLineId, i.poLines.find((p) => p.poLineId === a.poLineId)) || otherCompany(a.contractVersionId, i.contracts.find((c) => c.contractVersionId === a.contractVersionId)))) {
      push({ code: 'COMPANY_MISMATCH', severity: 'BLOCK', ownerRole: 'FINANCE', lineNo: l.lineNo, message: `Satır ${l.lineNo}: ${al.some((a) => otherCompany(a.poLineId, i.poLines.find((p) => p.poLineId === a.poLineId))) ? 'bağlı eski sipariş bağı' : 'bağlı sözleşme'} bu faturanın şirketine ait değil ya da erişiminiz dışında; tahsisi düzenleyip bu bağı kaldırın.` });
    }
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
        // Vergi dahil limitte: fatura tarafı satırın gerçek vergileriyle, sipariş taahhüdü sipariş satırının KDV oranıyla brütleşir.
        const g = gross(cvId);
        const amt = g ? grossOf(l.lineNo, dec(a.amount)) : dec(a.amount);
        let li = sign(i.kind) * amt;
        if (po) {
          let remaining = mul(dec(po.orderedQty), dec(po.unitPrice)) - dec(po.invoicedAmount);
          if (g && remaining > 0n) remaining = dec(str(div(mul(remaining, dec('100') + dec(po.taxRate ?? '0')), dec('100'))));
          li = i.kind === 'CREDIT_NOTE' ? 0n : amt - (remaining > 0n ? remaining : 0n);
          if (li < 0n) li = 0n;
        }
        limitImpact[cvId] = (limitImpact[cvId] ?? 0n) + li;
      }
      if (!po) continue;
      if (po.poStatus === 'CANCELLED' && i.kind !== 'CREDIT_NOTE') { push({ code: 'PO_CANCELLED', severity: 'BLOCK', ownerRole: 'BUYER', lineNo: l.lineNo, message: `Satır ${l.lineNo}: "${po.description}" siparişi iptal edildi; iptal edilmiş siparişe fatura bağlanamaz.` }); continue; }
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
        const rule = pickTolerance(rules, i.currency, po.category);
        const allowed = dec(allowedVariance(str(mul(dec(po.unitPrice), dec(a.quantity))), rule));
        const total = mul(diff < 0n ? -diff : diff, dec(a.quantity));
        const ruleName = rule ? ((rule.category ?? '').trim() ? `"${rule.category}" kategorisi kuralı` : `${i.currency} genel kuralı`) : 'kural yok';
        if (diff !== 0n && cmp(total, allowed) > 0) push({ code: 'PRICE_MISMATCH', severity: 'EXCEPTION', ownerRole: 'BUYER', lineNo: l.lineNo, message: `Satır ${l.lineNo}: birim fiyat ${l.unitPrice}, sipariş ${po.unitPrice}; fark ${str(total)} ${i.currency}, tolerans ${str(allowed)} (${ruleName}).` });
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
      const basis = c.limitBasis === 'GROSS' ? ' (vergi dahil)' : '';
      if (cmp(amt, avail) > 0) push({ code: 'LIMIT_EXCEEDED', severity: 'BLOCK', ownerRole: 'PROCUREMENT_MANAGER', message: `${c.title}: kullanılabilir limit${basis} ${str(avail)} ${c.currency}, bu fatura ${str(amt)}. Zeyilname veya yetkili karar gerekir.` });
    }
    if (c.signatureUnresolved || c.archiveImport) {
      // T37: eski borç otomatik iptal edilmez; politika incelemesi açılır.
      push({ code: 'CONTRACT_SIGNATURE_UNRESOLVED', severity: 'REVIEW', ownerRole: 'LEGAL', message: `${c.title}: imza kontrolü tamamlanmamış${c.archiveImport ? ' (arşivden alındı)' : ''}. Fatura iptal edilmez; ödeme politikası Satınalma incelemesine bağlıdır.` });
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
    netAmount: str(net), payable: str(net - offset), taxTotal: tax.taxTotal, otherTaxTotal: tax.otherTaxTotal, grossAmount: tax.grossAmount,
  };
}

/** Net tüketim (sözleşme): onaylı fatura tahsisleri − onaylı iade tahsisleri. Avans tüketim değildir; mahsup ödenecek tutarı düşürür. */
export function netConsumption(rows: { kind: 'INVOICE' | 'CREDIT_NOTE' | 'ADVANCE'; amount: string }[]): string {
  return str(add(...rows.filter((r) => r.kind !== 'ADVANCE').map((r) => (r.kind === 'CREDIT_NOTE' ? -dec(r.amount) : dec(r.amount)))));
}
