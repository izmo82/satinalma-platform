import { normalizeTaxId } from './taxId.ts';

// UBL-TR 1.2 e-Fatura temel kural denetimi (deterministik; D81). GİB'in resmî şema/Schematron paketinin yerini tutmaz:
// GİB'den geçmiş belgeyi yeniden onaylamaz, elle üretilmiş, bozulmuş ya da e-Fatura olmayan XML'i işaretler.
// Sonuç onayı engellemez; kaydedilir ve belge/fatura ekranında gösterilir. Tutar aritmetiği burada değil, fatura kontrolündedir.

export type UblSeverity = 'ERROR' | 'WARNING';
export interface UblFinding { rule: string; severity: UblSeverity; message: string; path: string }

export interface UblTrHeader {
  ublVersion: string | null;
  customizationId: string | null;
  profileId: string | null;
  typeCode: string | null;
  invoiceNumber: string | null;
  ettn: string | null;
  issueDate: string | null;
  documentCurrency: string | null;
  /** Belgedeki tutarların currencyID öznitelikleri (benzersiz). */
  amountCurrencies: string[];
  /** PricingExchangeRate/CalculationRate (döviz faturada zorunlu). */
  exchangeRate: string | null;
  lineCountNumeric: string | null;
  lineCount: number;
  linesWithoutUnit: number;
  seller: { taxIdType: 'VKN' | 'TCKN' | null; taxId: string | null };
  buyer: { taxIdType: 'VKN' | 'TCKN' | null; taxId: string | null };
  /** BillingReference/InvoiceDocumentReference/ID değerlerinin tümü. */
  references: string[];
  hasWithholding: boolean;
}

/** GİB senaryoları (bilinmeyen değer yalnız uyarı; liste zamanla genişler). */
export const UBL_TR_PROFILES = ['TEMELFATURA', 'TICARIFATURA', 'IHRACAT', 'YOLCUBERABERFATURA', 'EARSIVFATURA', 'KAMU', 'HKS', 'ENERJI', 'ILAC_TIBBICIHAZ', 'YATIRIMTESVIK', 'IDIS'];
/** GİB fatura tipleri (bilinmeyen değer yalnız uyarı). */
export const UBL_TR_TYPES = ['SATIS', 'IADE', 'TEVKIFAT', 'TEVKIFATIADE', 'ISTISNA', 'OZELMATRAH', 'IHRACKAYITLI', 'SGK', 'KOMISYONCU', 'HKSSATIS', 'HKSKOMISYONCU',
  'KONAKLAMAVERGISI', 'SARJ', 'SARJANLIK', 'TEKNOLOJIDESTEK', 'YTBSATIS', 'YTBIADE', 'YTBISTISNA', 'YTBTEVKIFAT', 'YTBTEVKIFATIADE'];
const RETURN_TYPES = ['IADE', 'TEVKIFATIADE', 'YTBIADE', 'YTBTEVKIFATIADE'];
const WITHHOLDING_TYPES = ['TEVKIFAT', 'TEVKIFATIADE', 'YTBTEVKIFAT', 'YTBTEVKIFATIADE'];

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** GİB fatura no: 3 karakter seri + 4 haneli yıl + 9 haneli sıra (16 karakter). */
const INVOICE_NO = /^[A-Z0-9]{3}(\d{4})\d{9}$/;
const validDate = (d: string | null) => {
  if (!d || !/^\d{4}-\d{2}-\d{2}$/.test(d)) return false;
  const t = new Date(`${d}T00:00:00Z`); // 2026-13-01 gibi değerde geçersiz tarih: toISOString fırlatır, önce denetlenir
  return !Number.isNaN(t.getTime()) && t.toISOString().slice(0, 10) === d;
};

export function checkUblTr(x: UblTrHeader, today: string): UblFinding[] {
  const out: UblFinding[] = [];
  const err = (rule: string, message: string, path: string) => out.push({ rule, severity: 'ERROR', message, path });
  const warn = (rule: string, message: string, path: string) => out.push({ rule, severity: 'WARNING', message, path });

  if (x.ublVersion !== '2.1') err('UBL_VERSION', `UBL sürümü 2.1 olmalı (belgede: ${x.ublVersion ?? 'yok'}).`, '/Invoice/UBLVersionID');
  if (!x.customizationId?.startsWith('TR1.2')) err('CUSTOMIZATION', `Özelleştirme TR1.2 olmalı (belgede: ${x.customizationId ?? 'yok'}).`, '/Invoice/CustomizationID');

  const profile = x.profileId?.toUpperCase() ?? null;
  if (!profile) err('PROFILE_MISSING', 'Senaryo (ProfileID) belgede yok.', '/Invoice/ProfileID');
  else if (!UBL_TR_PROFILES.includes(profile)) warn('PROFILE_UNKNOWN', `Senaryo tanınmadı: ${x.profileId}.`, '/Invoice/ProfileID');

  const type = x.typeCode?.toUpperCase() ?? null;
  if (!type) err('TYPE_MISSING', 'Fatura tipi (InvoiceTypeCode) belgede yok.', '/Invoice/InvoiceTypeCode');
  else if (!UBL_TR_TYPES.includes(type)) warn('TYPE_UNKNOWN', `Fatura tipi tanınmadı: ${x.typeCode}.`, '/Invoice/InvoiceTypeCode');

  const no = x.invoiceNumber;
  const m = no ? INVOICE_NO.exec(no) : null;
  if (!no) err('INVOICE_NO_FORMAT', 'Fatura no belgede yok.', '/Invoice/ID');
  else if (!m) err('INVOICE_NO_FORMAT', `Fatura no GİB biçiminde değil (3 karakter seri + yıl + 9 hane sıra): ${no}.`, '/Invoice/ID');
  else if (validDate(x.issueDate) && m[1] !== x.issueDate!.slice(0, 4)) warn('INVOICE_NO_YEAR', `Fatura no yılı (${m[1]}) düzenleme tarihinin yılıyla aynı değil.`, '/Invoice/ID');

  if (!x.ettn || !UUID.test(x.ettn)) err('ETTN_FORMAT', 'ETTN (UUID) yok ya da geçerli bir UUID değil.', '/Invoice/UUID');
  if (!validDate(x.issueDate)) err('ISSUE_DATE', x.issueDate ? `Düzenleme tarihi geçersiz: ${x.issueDate}.` : 'Düzenleme tarihi belgede yok.', '/Invoice/IssueDate');
  else if (x.issueDate! > today) warn('ISSUE_DATE_FUTURE', `Düzenleme tarihi (${x.issueDate}) bugünden sonra.`, '/Invoice/IssueDate');

  const cur = x.documentCurrency?.toUpperCase() ?? null;
  if (!cur || !/^[A-Z]{3}$/.test(cur)) err('CURRENCY', 'Belge para birimi (DocumentCurrencyCode) yok ya da geçersiz.', '/Invoice/DocumentCurrencyCode');
  else {
    const other = x.amountCurrencies.filter((c) => c.toUpperCase() !== cur);
    if (other.length) err('CURRENCY_MISMATCH', `Tutarların para birimi (${[...new Set(other)].join(', ')}) belge para birimiyle (${cur}) aynı değil.`, '//@currencyID');
    if (cur !== 'TRY' && !(x.exchangeRate && /^\d+(\.\d+)?$/.test(x.exchangeRate) && Number(x.exchangeRate) > 0)) {
      err('EXCHANGE_RATE_MISSING', `Döviz (${cur}) faturada kur bilgisi (PricingExchangeRate) yok.`, '/Invoice/PricingExchangeRate/CalculationRate');
    }
  }

  if (x.lineCount === 0) err('NO_LINES', 'Belgede fatura satırı yok.', '/Invoice/InvoiceLine');
  if (x.lineCountNumeric === null) err('LINE_COUNT_MISSING', 'Satır sayısı (LineCountNumeric) belgede yok.', '/Invoice/LineCountNumeric');
  else if (x.lineCountNumeric !== String(x.lineCount)) err('LINE_COUNT', `Beyan edilen satır sayısı (${x.lineCountNumeric}) belgedeki satır sayısıyla (${x.lineCount}) aynı değil.`, '/Invoice/LineCountNumeric');
  if (x.linesWithoutUnit > 0) warn('LINE_UNIT', `${x.linesWithoutUnit} satırda birim kodu (unitCode) yok.`, '/Invoice/InvoiceLine/InvoicedQuantity/@unitCode');

  for (const [who, p, label] of [['SELLER', x.seller, 'Satıcı'], ['BUYER', x.buyer, 'Alıcı']] as const) {
    const path = `/Invoice/${who === 'SELLER' ? 'AccountingSupplierParty' : 'AccountingCustomerParty'}/Party/PartyIdentification/ID`;
    if (!p.taxIdType || !p.taxId) { err(`${who}_TAX_ID`, `${label} VKN/TCKN belgede yok.`, path); continue; }
    const r = normalizeTaxId('TR', p.taxIdType, p.taxId);
    if (!r.ok) err(`${who}_TAX_ID`, `${label} ${p.taxIdType} geçersiz (${r.reason === 'CHECKSUM' ? 'kontrol basamağı tutmuyor' : r.reason === 'BAD_LENGTH' ? 'hane sayısı yanlış' : 'yalnız rakam olmalı'}).`, path);
  }

  if (type && RETURN_TYPES.includes(type) && x.references.length === 0) err('RETURN_REFERENCE', 'İade faturasında özgün fatura referansı (BillingReference) yok.', '/Invoice/BillingReference');
  if (type && WITHHOLDING_TYPES.includes(type) && !x.hasWithholding) err('WITHHOLDING_MISSING', 'Tevkifatlı fatura tipinde tevkifat toplamı (WithholdingTaxTotal) yok.', '/Invoice/WithholdingTaxTotal');
  if (type && x.hasWithholding && !WITHHOLDING_TYPES.includes(type)) warn('WITHHOLDING_TYPE', `Tevkifat var ama fatura tipi ${type}.`, '/Invoice/InvoiceTypeCode');
  return out;
}

export const ublSummary = (fs: UblFinding[]) => ({ errors: fs.filter((f) => f.severity === 'ERROR').length, warnings: fs.filter((f) => f.severity === 'WARNING').length });
