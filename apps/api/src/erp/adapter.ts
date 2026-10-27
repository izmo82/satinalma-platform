/**
 * ERP bağdaştırıcısı (02 §18). Sağlayıcıya özel kod bu arayüzün arkasında kalır; yapılandırılmış bağdaştırıcı yoksa
 * aktarım NOT_CONFIGURED olur, başarı gibi gösterilmez. Zaman aşımı "belirsiz"dir: tekrar göndermeden önce sorgulanır (T18).
 */
export interface ErpInvoicePayload {
  idempotencyKey: string; invoiceNo: string; supplierTaxId: string | null; currency: string; netAmount: string; payable: string;
  allocations: { contractCode: string | null; poCode: string | null; amount: string }[];
}
export class ErpTimeout extends Error { constructor() { super('erp_timeout'); } }
export interface ErpAdapter {
  name: string;
  /** Aynı idempotency anahtarıyla daha önce oluşmuş kayıt varsa dış kimliği döner. */
  find(idempotencyKey: string): Promise<{ externalId: string } | null>;
  /** Kaydı oluşturur. Zaman aşımında ErpTimeout fırlatır (dış sistemde oluşmuş olabilir). */
  post(p: ErpInvoicePayload): Promise<{ externalId: string }>;
}

const adapters = new Map<string, ErpAdapter>();
export function registerErpAdapter(a: ErpAdapter) {
  if (a.name.startsWith('test-') && process.env.NODE_ENV !== 'test') throw new Error('test ERP adapter only in NODE_ENV=test');
  adapters.set(a.name, a);
}
export const erpAdapter = (name: string | null | undefined) => (name ? adapters.get(name) ?? null : null);
