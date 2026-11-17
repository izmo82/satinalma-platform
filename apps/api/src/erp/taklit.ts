// v2 Faz 8 (D113): Taklit Oracle sağlayıcısı — GERÇEK DEĞİL. Ağ yok, ücretsiz, deterministik sentetik veri; geliştirme ve testte
// akışları uçtan uca yürütmek için. Sonucu her yerde "taklit sağlayıcıyla denendi" olarak gösterilir (PASS değildir); üretimde
// yapılandırma açılışta reddedilir ve yazma ayrıca burada reddedilir. Kayıt alanları EBS adlarıyla (ebsDefaultMap ile eşlenir).
// Adres kipleri: `taklit://hata-401` (yetkisiz), `taklit://zaman-asimi` (zaman aşımı; yazma kaydı oluşur ama yanıt gelmez),
// `taklit://bozuk-tutar` (tutarlı özelliklerde bir satırın tutarı bozuk). Fatura numaraları `TKL2026…`; demo faturalar kullanılmaz.
import { syntheticVkn, type ErpFeature } from '@sp/domain';
import { ErpTimeout } from './adapter.ts';
import { ErpProviderError, assertReadable, assertWritable, type ErpProvider, type ResolvedEndpoint } from './providers.ts';

export const TAKLIT_LABEL = 'Taklit Oracle (gerçek değil)';
const PAGE_SIZE = 2;

// Tohum tedarikçileri (seedSourcing: Anadolu, Ege, Kuzey) VKN'leriyle; sonuncusu uygulamada eşleşmeyen VKN (R12 "eşleşmedi").
const SUPPLIERS = [
  { VENDOR_ID: '900001', SEGMENT1: 'TKL-SUP-1001', VENDOR_NAME: 'Anadolu Bilişim Hizmetleri A.Ş. (SENTETİK)', TAX_REGISTRATION_NUM: syntheticVkn('930000001') },
  { VENDOR_ID: '900002', SEGMENT1: 'TKL-SUP-1002', VENDOR_NAME: 'Ege Sistem Entegrasyon Ltd. Şti. (SENTETİK)', TAX_REGISTRATION_NUM: syntheticVkn('930000002') },
  { VENDOR_ID: '900003', SEGMENT1: 'TKL-SUP-1003', VENDOR_NAME: 'Kuzey Teknoloji A.Ş. (SENTETİK)', TAX_REGISTRATION_NUM: syntheticVkn('930000003') },
  { VENDOR_ID: '900099', SEGMENT1: 'TKL-SUP-1099', VENDOR_NAME: 'Eşleşmeyen Tedarikçi (SENTETİK)', TAX_REGISTRATION_NUM: syntheticVkn('930000099') },
];
const COST_CENTERS = [
  { FLEX_VALUE: 'TKL-MM-100', DESCRIPTION: 'Bilgi Teknolojileri (taklit)', ENABLED_FLAG: 'Y' },
  { FLEX_VALUE: 'TKL-MM-200', DESCRIPTION: 'Finans (taklit)', ENABLED_FLAG: 'Y' },
  { FLEX_VALUE: 'TKL-MM-300', DESCRIPTION: 'İdari İşler (taklit)', ENABLED_FLAG: 'N' },
];
const vkn = (i: number) => SUPPLIERS[i]!.TAX_REGISTRATION_NUM;
const ORDERS = [
  { PO_HEADER_ID: '700001', SEGMENT1: 'TKL2026PO0001', TAX_REGISTRATION_NUM: vkn(0), AMOUNT: '125000.00', CURRENCY_CODE: 'TRY', CREATION_DATE: '2026-09-15T10:00:00Z' },
  { PO_HEADER_ID: '700002', SEGMENT1: 'TKL2026PO0002', TAX_REGISTRATION_NUM: vkn(1), AMOUNT: '48000.50', CURRENCY_CODE: 'TRY', CREATION_DATE: '2026-10-02T09:30:00Z' },
];
const INVOICES = [
  { INVOICE_ID: '800001', INVOICE_NUM: 'TKL2026000001', TAX_REGISTRATION_NUM: vkn(0), INVOICE_DATE: '2026-10-05', INVOICE_AMOUNT: '60000.00', TAX_AMOUNT: '10000.00', INVOICE_CURRENCY_CODE: 'TRY', PO_NUMBER: 'TKL2026PO0001' },
  { INVOICE_ID: '800002', INVOICE_NUM: 'TKL2026000002', TAX_REGISTRATION_NUM: vkn(0), INVOICE_DATE: '2026-10-20', INVOICE_AMOUNT: '30000.00', TAX_AMOUNT: '5000.00', INVOICE_CURRENCY_CODE: 'TRY', PO_NUMBER: 'TKL2026PO0001' },
  { INVOICE_ID: '800003', INVOICE_NUM: 'TKL2026000003', TAX_REGISTRATION_NUM: vkn(1), INVOICE_DATE: '2026-10-25', INVOICE_AMOUNT: '57600.60', TAX_AMOUNT: '9600.10', INVOICE_CURRENCY_CODE: 'TRY', PO_NUMBER: 'TKL2026PO0002' },
];
const PAYMENTS = [
  { INVOICE_NUM: 'TKL2026000001', TAX_REGISTRATION_NUM: vkn(0), PAYMENT_STATUS_FLAG: 'Y', AMOUNT_PAID: '60000.00', CHECK_DATE: '2026-11-04' },
  { INVOICE_NUM: 'TKL2026000002', TAX_REGISTRATION_NUM: vkn(0), PAYMENT_STATUS_FLAG: 'P', AMOUNT_PAID: '10000.00', CHECK_DATE: '2026-11-10' },
  { INVOICE_NUM: 'TKL2026000003', TAX_REGISTRATION_NUM: vkn(1), PAYMENT_STATUS_FLAG: 'N', AMOUNT_PAID: null, CHECK_DATE: null },
];

/** Bozuk tutar kipi: her tutarlı özellikte ikinci satırın tutarı decimal biçimine uymaz (yuvarlanmaz, satır reddedilmeli). */
const BROKEN: Partial<Record<ErpFeature, { index: number; field: string; value: string }>> = {
  INVOICE: { index: 1, field: 'INVOICE_AMOUNT', value: '30.000,00' },
  PURCHASE_ORDER: { index: 1, field: 'AMOUNT', value: '4.8e4' },
  PAYMENT_STATUS: { index: 1, field: 'AMOUNT_PAID', value: '10000.12345' },
};

const DATA: Partial<Record<ErpFeature, readonly Record<string, string | null>[]>> = {
  SUPPLIER: SUPPLIERS, COST_CENTER: COST_CENTERS, PURCHASE_ORDER: ORDERS, INVOICE: INVOICES, PAYMENT_STATUS: PAYMENTS,
};

/** Taklit "ERP"de oluşan yazma kayıtları (süreç belleği); anahtar kiracı + özellik + idempotency. */
const store = new Map<string, string>();
let seq = 0;
/** YALNIZ TEST: taklit yazma belleğini temizler. */
export function resetTaklitStore(): void { store.clear(); seq = 0; }

type Mode = 'ok' | 'hata-401' | 'zaman-asimi' | 'bozuk-tutar';
function mode(ep: ResolvedEndpoint): Mode {
  const m = /^taklit:\/\/([a-z0-9-]+)/i.exec(ep.baseUrl ?? '')?.[1]?.toLowerCase();
  return m === 'hata-401' || m === 'zaman-asimi' || m === 'bozuk-tutar' ? m : 'ok';
}
const unauthorized = () => new ErpProviderError('http_401', 'Taklit sağlayıcı: HTTP 401 Yetkisiz — gerçek Oracle değil');

export function taklitProvider(opts: { production: boolean }): ErpProvider {
  return {
    kind: 'TAKLIT',
    label: TAKLIT_LABEL,
    real: false,
    async test(ep) {
      const m = mode(ep);
      if (m === 'hata-401') return { ok: false, message: unauthorized().message, latencyMs: 0 };
      if (m === 'zaman-asimi') return { ok: false, message: 'Taklit sağlayıcı: zaman aşımı — gerçek Oracle değil', latencyMs: ep.timeoutMs };
      return { ok: true, message: 'Taklit sağlayıcıyla denendi — gerçek Oracle değil', latencyMs: 0 };
    },
    async read(ep, feature, cursor) {
      assertReadable(feature);
      const m = mode(ep);
      if (m === 'hata-401') throw unauthorized();
      if (m === 'zaman-asimi') throw new ErpTimeout();
      const offset = cursor === null ? 0 : /^\d{1,9}$/.test(cursor) ? Number(cursor) : NaN;
      if (!Number.isFinite(offset)) throw new ErpProviderError('invalid_cursor', 'Geçersiz sayfa imleci.');
      const all = (DATA[feature] ?? []).map((r) => ({ ...r }));
      const broken = m === 'bozuk-tutar' ? BROKEN[feature] : undefined;
      if (broken && all[broken.index]) all[broken.index]![broken.field] = broken.value;
      const records = all.slice(offset, offset + PAGE_SIZE);
      const next = offset + records.length;
      return { records, nextCursor: records.length > 0 && next < all.length ? String(next) : null };
    },
    async find(ep, feature, idempotencyKey) {
      assertWritable(feature);
      if (mode(ep) === 'hata-401') throw unauthorized();
      const ref = store.get(`${ep.tenantId}|${feature}|${idempotencyKey}`);
      return ref ? { externalRef: ref } : null;
    },
    async write(ep, feature, _payload, idempotencyKey) {
      assertWritable(feature);
      if (opts.production) throw new ErpProviderError('mock_write_in_production', 'Üretimde taklit sağlayıcıyla ERP\'ye yazılamaz.');
      const m = mode(ep);
      if (m === 'hata-401') throw unauthorized();
      const key = `${ep.tenantId}|${feature}|${idempotencyKey}`;
      let ref = store.get(key);
      if (!ref) { ref = `TKL-${feature}-${String(++seq).padStart(6, '0')}`; store.set(key, ref); }
      // Zaman aşımı kipi: kayıt "ERP'de" oluştu ama yanıt gelmedi (belirsiz); yeniden denemede önce find bulur.
      if (m === 'zaman-asimi') throw new ErpTimeout();
      return { externalRef: ref };
    },
  };
}
