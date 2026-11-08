import { add, cmp, dec, div, mul, str, type Dec } from './money.ts';
import { addDays } from './contractTerms.ts';

/**
 * Lira Defteri kuralları (D80): "masada unutulan para" bulguları. Saf fonksiyonlar; girdi veritabanından gelir, sonuç
 * insan kararına sunulan öneridir. Tutar hesaplanamıyorsa uydurulmaz: bulgu "incelenmeli" olur ve tutarı boş kalır.
 */

export type RecoveryKind = 'FX_DIFF_NOT_ALLOWED' | 'FX_DIFF_EXCESS' | 'FX_DIFF_UNVERIFIED' | 'ADVANCE_UNOFFSET' | 'EARLY_PAYMENT' | 'GUARANTEE_EXPIRY';
/** Geri alınabilir: tedarikçiden talep edilir. Önlenebilir: kurumun kendi kaybı. Risk: koruma kaybı. İncelenmeli: tutar hesaplanamadı. */
export type RecoveryCategory = 'RECOVERABLE' | 'AVOIDABLE' | 'RISK' | 'REVIEW';
export const RECOVERY_CATEGORY: Record<RecoveryKind, RecoveryCategory> = {
  FX_DIFF_NOT_ALLOWED: 'RECOVERABLE', FX_DIFF_EXCESS: 'RECOVERABLE', ADVANCE_UNOFFSET: 'RECOVERABLE',
  EARLY_PAYMENT: 'AVOIDABLE', GUARANTEE_EXPIRY: 'RISK', FX_DIFF_UNVERIFIED: 'REVIEW',
};
export const isClaimable = (k: RecoveryKind) => RECOVERY_CATEGORY[k] === 'RECOVERABLE';

export interface Finding {
  subjectKey: string; kind: RecoveryKind; amount: string | null; currency: string; summary: string;
  basis: Record<string, unknown>; contractVersionId: string | null;
}

/** Kur farkı faturası tanıma: satır açıklamasında "kur farkı" (büyük/küçük harf, Türkçe ı/I farkı gözetilmez). */
export const isFxDifferenceText = (s: string) => /kur\s*fark/i.test(s.replace(/[ıİI]/g, 'i'));

/** Gün farkı (b − a), ISO tarih. */
export function daysBetween(a: string, b: string): number {
  const t = (d: string) => Date.UTC(+d.slice(0, 4), +d.slice(5, 7) - 1, +d.slice(8, 10));
  return Math.round((t(b) - t(a)) / 86_400_000);
}

const trDate = (d: string) => d.split('-').reverse().join('.');
/** Kur Türkçe biçimde (40,9123); sondaki sıfırlar atılır. */
const trRate = (r: string) => (r.includes('.') ? r.replace(/0+$/, '').replace(/\.$/, '') : r).replace('.', ',');
/** Tutarı kuruşla, binlik ayırıcıyla (özet metni için; ekranda biçim ayrıca uygulanır). */
export const fmtAmount = (a: string, currency: string) => {
  const [i, f = '00'] = a.split('.');
  return `${i!.replace(/\B(?=(\d{3})+(?!\d))/g, '.')},${f.padEnd(2, '0')} ${currency}`;
};

/** Kur farkı tutarı bu kadar veya altında fazlaysa bulgu açılmaz (yuvarlama farkı). */
export const FX_EXCESS_TOLERANCE = '1.00';

export interface FxOriginal { id: string; no: string; currency: string; net: string; issueDate: string; paidAt: string | null; rateAtIssue: string | null; rateAtPayment: string | null }
export interface FxDiffInput {
  /** `net`: yalnız "kur farkı" satırlarının net toplamı (aynı faturadaki mal/hizmet satırları dahil edilmez). */
  invoice: { id: string; no: string; issueDate: string; currency: string; net: string };
  /** Bu faturaya karşı onaylı iade faturalarının net toplamı (tedarikçinin zaten geri verdiği). */
  credited: string;
  contract: { id: string; title: string; sourceRef: string; rule: 'ALLOWED' | 'NOT_ALLOWED' | null } | null;
  /** Kur farkının ait olduğu döviz faturalar (açıklamada numarası geçenler; birden fazla olabilir). */
  originals: FxOriginal[];
  /** Döviz faturalarla bağın kaynağı (kanıt): e-Fatura BillingReference ve/veya satır açıklaması (D81). */
  originalLink?: string | null;
}

export function fxDifferenceFinding(x: FxDiffInput): Finding | null {
  const { invoice: inv, contract: c } = x;
  // İade edilen kısım düşülür; tamamı iade edildiyse bulgu yok.
  const billed = dec(inv.net) - dec(x.credited);
  if (billed <= 0n) return null;
  const b = str(billed);
  const base = { subjectKey: `fx:${inv.id}`, currency: inv.currency, contractVersionId: c?.id ?? null };
  const common = { rule: 'fx_difference', invoiceNo: inv.no, billed: b, ...(cmp(dec(x.credited), 0n) > 0 ? { credited: x.credited } : {}) };
  const review = (reason: string, why: string): Finding => ({ ...base, kind: 'FX_DIFF_UNVERIFIED', amount: null,
    summary: `${inv.no} kur farkı faturası doğrulanamadı: ${why}`, basis: { ...common, reason } });
  if (!c) return review('no_contract', 'faturanın veya ait olduğu döviz faturanın sözleşme bağı yok.');
  if (c.rule === null) return review('no_rule', `${c.title} sözleşmesinin doğrulanmış koşullarında kur farkı hükmü girilmemiş.`);
  if (c.rule === 'NOT_ALLOWED') {
    return { ...base, kind: 'FX_DIFF_NOT_ALLOWED', amount: b,
      summary: `${c.title} sözleşmesi kur farkına izin vermiyor (${c.sourceRef}); ${inv.no} faturasıyla ${fmtAmount(b, inv.currency)} kur farkı faturalandı.`,
      basis: { ...common, contractRule: 'NOT_ALLOWED', sourceRef: c.sourceRef } };
  }
  if (!x.originals.length) return review('no_original', 'açıklamada veya e-Fatura referansında ait olduğu döviz faturanın numarası bulunamadı.');
  for (const o of x.originals) {
    if (!o.paidAt) return review('not_paid', `${o.no} faturasının ödeme tarihi bilinmiyor.`);
    if (!o.rateAtIssue || !o.rateAtPayment) return review('no_rate', `kur tablosunda ${o.currency} için ${!o.rateAtIssue ? trDate(o.issueDate) : trDate(o.paidAt)} kuru yok.`);
  }
  // Hak edilen fark = Σ döviz tutar × (ödeme günü kuru − fatura günü kuru). Kur düştüyse o faturanın hak edilen farkı sıfırdır.
  let expected = 0n;
  for (const o of x.originals) {
    const diff = dec(o.rateAtPayment!) - dec(o.rateAtIssue!);
    if (diff > 0n) expected += dec(str(mul(dec(o.net), diff)));
  }
  const excess = billed - expected;
  if (cmp(excess, dec(FX_EXCESS_TOLERANCE)) <= 0) return null;
  const refs = x.originals.map((o) => `${o.no}: ${fmtAmount(o.net, o.currency)}, kur ${trRate(o.rateAtIssue!)} → ${trRate(o.rateAtPayment!)}`).join('; ');
  const one = x.originals.length === 1 ? x.originals[0]! : null;
  // Hesap ekranda ve talep yazısında açıkça kurulur: finansçı formülü kendisi çıkarmak zorunda kalmaz.
  const terms = x.originals.map((o) => `${fmtAmount(o.net, o.currency)} × (${trRate(o.rateAtPayment!)} − ${trRate(o.rateAtIssue!)})`).join(' + ');
  const formula = `Hak edilen: ${terms} = ${fmtAmount(str(expected), inv.currency)}; fark: ${fmtAmount(b, inv.currency)} − ${fmtAmount(str(expected), inv.currency)} = ${fmtAmount(str(excess), inv.currency)}`;
  return { ...base, kind: 'FX_DIFF_EXCESS', amount: str(excess),
    summary: `${inv.no} kur farkı faturası hak edilen farkı ${fmtAmount(str(excess), inv.currency)} aşıyor (${refs}).`,
    basis: { ...common, contractRule: 'ALLOWED', sourceRef: c.sourceRef, expected: str(expected), formula, note: 'KDV hariç tutarlar üzerinden',
      originalNo: x.originals.map((o) => o.no).join(', '), ...(x.originalLink ? { originalLink: x.originalLink } : {}),
      ...(one ? { originalNet: one.net, originalCurrency: one.currency, issueDate: one.issueDate, paidAt: one.paidAt, rateAtIssue: one.rateAtIssue, rateAtPayment: one.rateAtPayment }
        : { originals: x.originals.map((o) => ({ no: o.no, net: o.net, currency: o.currency, issueDate: o.issueDate, paidAt: o.paidAt, rateAtIssue: o.rateAtIssue, rateAtPayment: o.rateAtPayment })) }) } };
}

/** Avans bu kadar gündür açık ve son mahsuptan bu kadar gün geçmişse "unutulmuş" sayılır. */
export const ADVANCE_STALE_DAYS = 90;
export const ADVANCE_IDLE_DAYS = 60;

export interface AdvanceInput {
  advance: { id: string; no: string; issueDate: string; currency: string; net: string };
  offsetTotal: string; lastOffsetDate: string | null;
  /** Avansa karşı onaylı iade faturalarının net toplamı. */
  credited?: string;
  contract: { id: string; title: string; endDate: string | null } | null;
  today: string;
}

export function advanceFinding(x: AdvanceInput): Finding | null {
  const a = x.advance;
  const balance = dec(a.net) - dec(x.offsetTotal) - dec(x.credited ?? '0');
  if (balance <= 0n) return null;
  const ended = !!x.contract?.endDate && x.contract.endDate < x.today;
  const age = daysBetween(a.issueDate, x.today);
  const idle = x.lastOffsetDate ? daysBetween(x.lastOffsetDate, x.today) : age;
  if (!ended && !(age >= ADVANCE_STALE_DAYS && idle >= ADVANCE_IDLE_DAYS)) return null;
  const why = ended ? `${x.contract!.title} sözleşmesi ${trDate(x.contract!.endDate!)} tarihinde bitti` : `${age} gündür açık, ${x.lastOffsetDate ? `son mahsup ${idle} gün önce` : 'hiç mahsup yapılmadı'}`;
  return { subjectKey: `adv:${a.id}`, kind: 'ADVANCE_UNOFFSET', amount: str(balance), currency: a.currency, contractVersionId: x.contract?.id ?? null,
    summary: `${a.no} avansından ${fmtAmount(str(balance), a.currency)} mahsup edilmedi; ${why}.`,
    basis: { rule: 'advance_unoffset', advanceNo: a.no, advanceNet: a.net, offsetTotal: x.offsetTotal, ...(x.credited && cmp(dec(x.credited), 0n) > 0 ? { credited: x.credited } : {}), balance: str(balance),
      formula: `${fmtAmount(a.net, a.currency)} − ${fmtAmount(x.offsetTotal, a.currency)} mahsup${x.credited && cmp(dec(x.credited), 0n) > 0 ? ` − ${fmtAmount(x.credited, a.currency)} iade` : ''} = ${fmtAmount(str(balance), a.currency)}`, issueDate: a.issueDate,
      lastOffsetDate: x.lastOffsetDate, contractEnd: x.contract?.endDate ?? null, staleDays: ADVANCE_STALE_DAYS, idleDays: ADVANCE_IDLE_DAYS } };
}

export interface EarlyPaymentInput {
  invoice: { id: string; no: string; issueDate: string; paidAt: string | null; currency: string; payable: string };
  /**
   * `paymentTerms`: sözleşmedeki ödeme koşulu metni. Koşulların "kaynak maddesi" (sourceRef) tek alandır ve
   * çoğu zaman tavan/kur maddesini gösterir; vade dayanağı olarak ona yaslanmak yanlış maddeyi göstermek olur.
   */
  contract: { id: string; title: string; paymentTerms: string; paymentDays: number | null } | null;
  /** Yıllık sermaye maliyeti (%); kiracı ayarı. */
  annualRate: string | null;
}

export function earlyPaymentFinding(x: EarlyPaymentInput): Finding | null {
  const { invoice: i, contract: c } = x;
  if (!i.paidAt || !c || c.paymentDays === null || !x.annualRate) return null;
  const due = addDays(i.issueDate, c.paymentDays);
  const early = daysBetween(i.paidAt, due);
  if (early <= 0) return null;
  // Maliyet = ödenen × yıllık oran × erken gün / 365 (basit faiz; oran kiracının kendi sermaye maliyeti).
  // Önce çarpılır, en son bölünür: oran ara adımda 6 basamağa yuvarlanırsa büyük tutarda kuruşlar kaybolur.
  const cost = div(mul(mul(dec(i.payable), dec(x.annualRate)), dec(String(early))), dec('36500'));
  if (cost <= 0n) return null;
  return { subjectKey: `early:${i.id}`, kind: 'EARLY_PAYMENT', amount: str(cost), currency: i.currency, contractVersionId: c.id,
    summary: `${i.no} vadeden ${early} gün önce ödendi (vade ${trDate(due)}, ödeme ${trDate(i.paidAt)}); yıllık %${x.annualRate} sermaye maliyetiyle ${fmtAmount(str(cost), i.currency)}.`,
    basis: { rule: 'early_payment', invoiceNo: i.no, issueDate: i.issueDate, paymentDays: c.paymentDays, ...(c.paymentTerms ? { paymentTerms: c.paymentTerms } : {}), due, paidAt: i.paidAt,
      daysEarly: early, payable: i.payable, annualRate: x.annualRate,
      formula: `${fmtAmount(i.payable, i.currency)} × %${x.annualRate.replace('.', ',')} × ${early} / 365 = ${fmtAmount(str(cost), i.currency)}` } };
}

/** Teminat bitişine bu kadar gün kala (veya bitmişse) uyarılır. */
export const GUARANTEE_HORIZON_DAYS = 30;

export interface GuaranteeInput {
  guarantee: { id: string; kind: string; referenceNo: string; issuer: string; amount: string; currency: string; validUntil: string | null };
  contract: { id: string; title: string; endDate: string | null };
  today: string;
}

export function guaranteeFinding(x: GuaranteeInput): Finding | null {
  const g = x.guarantee;
  if (!g.validUntil || g.validUntil > addDays(x.today, GUARANTEE_HORIZON_DAYS)) return null;
  // Sözleşme teminattan önce bitiyorsa koruma eksilmez.
  if (x.contract.endDate && x.contract.endDate <= g.validUntil) return null;
  const expired = g.validUntil < x.today;
  return { subjectKey: `guar:${g.id}:${g.validUntil}`, kind: 'GUARANTEE_EXPIRY', amount: g.amount, currency: g.currency, contractVersionId: x.contract.id,
    summary: `${g.issuer} ${g.referenceNo} teminatı ${expired ? `${trDate(g.validUntil)} tarihinde bitti` : `${trDate(g.validUntil)} tarihinde bitiyor`}; ${x.contract.title} sözleşmesi ${x.contract.endDate ? `${trDate(x.contract.endDate)} tarihine kadar sürüyor` : 'süresiz'}. Uzatma istenmezse ${fmtAmount(g.amount, g.currency)} koruma kalkar.`,
    basis: { rule: 'guarantee_expiry', guaranteeKind: g.kind, referenceNo: g.referenceNo, issuer: g.issuer, validUntil: g.validUntil, contractEnd: x.contract.endDate, expired, horizonDays: GUARANTEE_HORIZON_DAYS } };
}

/**
 * Tedarikçiye talep yazısı taslağı (kurala dayalı metin; yapay zekâ üretmez). Gönderme kararı ve son metin insanındır.
 */
export function claimDraft(c: { kind: RecoveryKind; code: string; amount: string | null; currency: string; supplierName: string; companyName: string; basis: Record<string, any>; date?: string }): string | null {
  if (!isClaimable(c.kind) || !c.amount) return null;
  const b = c.basis;
  const tutar = fmtAmount(c.amount, c.currency);
  const lines: string[] = [];
  if (c.kind === 'FX_DIFF_NOT_ALLOWED') {
    lines.push(`${b.invoiceNo} numaralı faturanızla ${b.billed ? `${fmtAmount(b.billed, c.currency)} (KDV hariç) ` : ''}kur farkı faturalandırılmıştır. Aramızdaki sözleşmenin ilgili hükmü (${b.sourceRef}) kur farkı uygulanmasına imkân tanımamaktadır.`);
  } else if (c.kind === 'FX_DIFF_EXCESS') {
    const os: { no: string; net: string; currency: string; issueDate: string; paidAt: string; rateAtIssue: string; rateAtPayment: string }[] = b.originals
      ?? [{ no: b.originalNo, net: b.originalNet, currency: b.originalCurrency, issueDate: b.issueDate, paidAt: b.paidAt, rateAtIssue: b.rateAtIssue, rateAtPayment: b.rateAtPayment }];
    lines.push(`${b.invoiceNo} numaralı kur farkı faturanız aşağıdaki döviz fatura(lar)a ilişkindir. Sözleşmenin ilgili hükmü (${b.sourceRef}) uyarınca kur farkı, fatura tarihi ile ödeme tarihi kurları arasındaki farktır:`);
    for (const o of os) {
      lines.push(`- ${o.no}: ${fmtAmount(o.net, o.currency)}; fatura tarihi ${trDate(o.issueDate)} kuru ${trRate(o.rateAtIssue)}, ödeme tarihi ${trDate(o.paidAt)} kuru ${trRate(o.rateAtPayment)}`);
    }
    lines.push(`Buna göre hak edilen kur farkı ${fmtAmount(b.expected, c.currency)}, faturalanan tutar ${fmtAmount(b.billed, c.currency)}'dir (KDV hariç). Aradaki fark ${tutar}'dir.`);
  } else {
    lines.push(`${b.advanceNo} numaralı avans faturası kapsamında ödenen ${fmtAmount(b.advanceNet, c.currency)} tutarın ${fmtAmount(b.offsetTotal, c.currency)} kadarı sonraki faturalardan mahsup edilmiştir; kalan ${tutar} bakiye mahsup veya iade edilmemiştir.`);
  }
  return [
    ...(c.date ? [`Tarih: ${trDate(c.date)}`, ''] : []),
    `Konu: ${tutar} tutarındaki alacağımız hakkında (Ref. ${c.code})`,
    '',
    `Sayın ${c.supplierName} yetkilisi,`,
    '',
    ...lines,
    '',
    `Bu nedenle ${tutar} tutarın iadesini veya bir sonraki faturanızdan mahsubunu rica ederiz. İade veya mahsup belgesinde ${c.code} referansının belirtilmesi kayıtlarımızın eşleşmesini kolaylaştıracaktır.`,
    '',
    'Saygılarımızla,',
    c.companyName,
    '[Ad Soyad, Unvan]',
    '[Telefon / e-posta]',
  ].join('\n');
}

/** Lira Defteri kanıt zinciri: onaylı faturanın hangi halkası eksik. Boş dizi = kanıtlı. */
export type EvidenceGap = 'NO_ALLOCATION' | 'NO_CONTRACT' | 'NO_RECEIPT' | 'TERMS_UNVERIFIED';
export const EVIDENCE_GAP_LABEL: Record<EvidenceGap, string> = {
  NO_ALLOCATION: 'Sipariş veya sözleşmeye tahsis yok', NO_CONTRACT: 'Sözleşme bağı yok',
  NO_RECEIPT: 'Mal/hizmet kabulü yok', TERMS_UNVERIFIED: 'Sözleşme koşulları doğrulanmamış',
};

export function evidenceGaps(x: { allocations: { poLineId: string | null; contractVersionId: string | null; hasReceipt: boolean; termsVerified: boolean }[] }): EvidenceGap[] {
  if (!x.allocations.length) return ['NO_ALLOCATION'];
  const gaps = new Set<EvidenceGap>();
  for (const a of x.allocations) {
    if (!a.contractVersionId) gaps.add('NO_CONTRACT');
    else if (!a.termsVerified) gaps.add('TERMS_UNVERIFIED');
    if (a.poLineId && !a.hasReceipt) gaps.add('NO_RECEIPT');
  }
  return [...gaps];
}

/** Para birimi başına toplam (decimal string). */
export function sumByCurrency(rows: { currency: string; amount: string }[]): Record<string, string> {
  const m = new Map<string, Dec>();
  for (const r of rows) m.set(r.currency, add(m.get(r.currency) ?? 0n, dec(r.amount)));
  return Object.fromEntries([...m].sort(([a], [b]) => (a === 'TRY' ? -1 : b === 'TRY' ? 1 : a.localeCompare(b))).map(([k, v]) => [k, str(v)]));
}
