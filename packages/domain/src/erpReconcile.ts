// ERP mutabakatı (08 "Entegrasyon ve kayıt otoritesi"): API'si olmayan ERP için kontrollü CSV eşlemesi.
// Platform faturayı onaylar; muhasebe kaydı ERP'nindir. ERP'den dönen sonuç dosyası satır satır eşlenir; hata sayısı ve toplamlar
// açıkça raporlanır. Eşleşmeyen veya tutarı farklı satır hiçbir zaman "aktarıldı" sayılmaz.
import { add, cmp, dec, isDecimal, str, type Dec } from './money.ts';

export interface ErpResultRow { line: number; idempotencyKey: string; externalId: string; status: string; payable: string; message: string }
export interface ErpExpected { idempotencyKey: string; invoiceNo: string; payable: string; currentStatus: string; externalId: string | null }

export type ErpRowOutcome =
  | 'MATCHED'            // tutar aynı, ERP "OK" dedi → CONFIRMED yapılır
  | 'ALREADY_CONFIRMED'  // aynı dış kimlikle zaten onaylı (tekrar yüklenen dosya)
  | 'EXTERNAL_ID_CONFLICT' // onaylı kayıt başka dış kimlikle → elle inceleme
  | 'ERP_REJECTED'       // ERP satırı hata ile döndü
  | 'AMOUNT_MISMATCH'
  | 'UNKNOWN_KEY'        // platformda böyle aktarım yok
  | 'DUPLICATE_ROW'      // aynı anahtar dosyada ikinci kez
  | 'INVALID_ROW';

export interface ErpRowResult { line: number; idempotencyKey: string; invoiceNo: string | null; outcome: ErpRowOutcome; detail: string }
export interface ErpReconciliation {
  rows: ErpRowResult[];
  counts: Record<ErpRowOutcome, number>;
  /** Dosyadaki geçerli tutarların toplamı, eşleşen satırların toplamı ve dosyada hiç yer almayan beklenen aktarımlar. */
  fileTotal: string; matchedTotal: string;
  missingFromFile: { idempotencyKey: string; invoiceNo: string; payable: string }[];
}

const OUTCOMES: ErpRowOutcome[] = ['MATCHED', 'ALREADY_CONFIRMED', 'EXTERNAL_ID_CONFLICT', 'ERP_REJECTED', 'AMOUNT_MISMATCH', 'UNKNOWN_KEY', 'DUPLICATE_ROW', 'INVALID_ROW'];

/** `expected`: dosyanın kapsadığı dönemde platformda ERP'ye gitmesi gereken aktarımlar (onaylı faturalar). */
export function reconcileErpResult(rows: ErpResultRow[], expected: ErpExpected[]): ErpReconciliation {
  const byKey = new Map(expected.map((e) => [e.idempotencyKey, e]));
  const seen = new Set<string>();
  const out: ErpRowResult[] = [];
  let fileTotal: Dec = 0n; let matchedTotal: Dec = 0n;
  for (const r of rows) {
    const key = r.idempotencyKey.trim();
    const amount = r.payable.trim().replace(',', '.');
    const status = r.status.trim().toUpperCase();
    const res = (outcome: ErpRowOutcome, detail: string, invoiceNo: string | null = byKey.get(key)?.invoiceNo ?? null) =>
      out.push({ line: r.line, idempotencyKey: key, invoiceNo, outcome, detail });
    if (!key || !isDecimal(amount) || !['OK', 'ERROR'].includes(status) || (status === 'OK' && !r.externalId.trim())) {
      res('INVALID_ROW', 'Anahtar, tutar, durum (OK/ERROR) ve OK satırında ERP kimliği zorunlu.'); continue;
    }
    if (seen.has(key)) { res('DUPLICATE_ROW', 'Aynı aktarım anahtarı dosyada birden fazla kez geçiyor; yalnız ilk satır dikkate alındı.'); continue; }
    seen.add(key);
    fileTotal = add(fileTotal, dec(amount));
    const e = byKey.get(key);
    if (!e) { res('UNKNOWN_KEY', 'Bu anahtarla platformda ERP aktarımı yok.', null); continue; }
    if (status === 'ERROR') { res('ERP_REJECTED', r.message.trim() || 'ERP satırı hata ile döndü.'); continue; }
    if (cmp(dec(amount), dec(e.payable)) !== 0) { res('AMOUNT_MISMATCH', `ERP tutarı ${amount}, platformda ödenecek tutar ${e.payable}.`); continue; }
    if (e.currentStatus === 'CONFIRMED') {
      if (e.externalId === r.externalId.trim()) res('ALREADY_CONFIRMED', 'Zaten aynı ERP kimliğiyle onaylı.');
      else res('EXTERNAL_ID_CONFLICT', `Kayıt ${e.externalId ?? '—'} kimliğiyle onaylı; dosyada ${r.externalId.trim()}.`);
      continue;
    }
    matchedTotal = add(matchedTotal, dec(amount));
    res('MATCHED', `ERP kimliği ${r.externalId.trim()}.`);
  }
  const counts = Object.fromEntries(OUTCOMES.map((o) => [o, out.filter((x) => x.outcome === o).length])) as Record<ErpRowOutcome, number>;
  const missingFromFile = expected.filter((e) => !seen.has(e.idempotencyKey) && e.currentStatus !== 'CONFIRMED')
    .map((e) => ({ idempotencyKey: e.idempotencyKey, invoiceNo: e.invoiceNo, payable: e.payable }));
  return { rows: out, counts, fileTotal: str(fileTotal), matchedTotal: str(matchedTotal), missingFromFile };
}
