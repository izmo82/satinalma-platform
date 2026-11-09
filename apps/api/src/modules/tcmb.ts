import { XMLParser } from 'fast-xml-parser';
import { dec, div, isDecimal, str } from '@sp/domain';
import type { Tx, TenantContext } from '../db.ts';
import { ApiError, unprocessable } from '../errors.ts';
import { audit } from '../audit.ts';

/** TCMB gösterge kurları (D92): herkese açık günlük bülten. Kur farkı için döviz satış kuru; bir birim döviz karşılığı TRY. */
const BASE = 'https://www.tcmb.gov.tr/kurlar';
const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '', processEntities: false, parseTagValue: false });

export interface TcmbBulletin { rateDate: string; bulletin: string; rates: { currency: string; rate: string }[] }

export function parseTcmbBulletin(xml: string): TcmbBulletin {
  const root = parser.parse(xml)?.Tarih_Date;
  const m = /^(\d{2})\.(\d{2})\.(\d{4})$/.exec(root?.Tarih ?? '');
  if (!m) throw new ApiError(502, 'tcmb_invalid', 'TCMB bülteni beklenen biçimde değil.');
  const list = Array.isArray(root.Currency) ? root.Currency : root.Currency ? [root.Currency] : [];
  const rates: TcmbBulletin['rates'] = [];
  for (const c of list) {
    const value = String(c.ForexSelling ?? '').trim(), unit = String(c.Unit ?? '').trim();
    // XDR gibi satış kuru yayımlanmayan satırlar atlanır.
    if (!/^[A-Z]{3}$/.test(c.CurrencyCode ?? '') || !isDecimal(value) || !isDecimal(unit) || dec(value) <= 0n || dec(unit) <= 0n) continue;
    rates.push({ currency: c.CurrencyCode, rate: str(div(dec(value), dec(unit)), 6) });
  }
  return { rateDate: `${m[3]}-${m[2]}-${m[1]}`, bulletin: String(root.Bulten_No ?? ''), rates };
}

/** Veritabanı işleminin dışında çağrılır; bağlantı ağ beklerken tutulmaz. `date` yoksa son yayımlanmış bülten. */
export async function fetchTcmbBulletin(date?: string, f: typeof fetch = fetch): Promise<TcmbBulletin> {
  const url = date ? `${BASE}/${date.slice(0, 4)}${date.slice(5, 7)}/${date.slice(8, 10)}${date.slice(5, 7)}${date.slice(0, 4)}.xml` : `${BASE}/today.xml`;
  const unavailable = () => new ApiError(502, 'tcmb_unavailable', 'TCMB\'ye ulaşılamadı; kuru elle girebilir veya sonra yeniden deneyebilirsiniz.');
  let res: Response, body: string;
  try { res = await f(url, { redirect: 'error', signal: AbortSignal.timeout(10_000) }); body = await res.text(); }
  catch { throw unavailable(); }
  if (res.status === 404) throw unprocessable('tcmb_no_bulletin', 'Bu tarih için TCMB bülteni yok; hafta sonu veya resmi tatil olabilir.');
  if (!res.ok) throw unavailable();
  const b = parseTcmbBulletin(body);
  if (date && b.rateDate !== date) throw new ApiError(502, 'tcmb_invalid', 'TCMB bülteninin tarihi istenen tarihle uyuşmuyor.');
  return b;
}

/** Kiracının kullandığı dövizler ve USD/EUR/GBP alınır. Mevcut kurun üstüne yazılmaz: elle girilmiş veya önceki kayıt korunur. */
export async function importTcmbRates(tx: Tx, ctx: TenantContext, b: TcmbBulletin) {
  const used = (await tx.query<{ currency: string }>(`SELECT DISTINCT currency FROM invoices WHERE currency <> 'TRY'`)).rows.map((r) => r.currency);
  const wanted = new Set(['USD', 'EUR', 'GBP', ...used]);
  const source = `TCMB döviz satış, bülten ${b.bulletin}`;
  const imported: string[] = [], skipped: string[] = [];
  for (const r of b.rates.filter((x) => wanted.has(x.currency))) {
    const ins = await tx.query(`INSERT INTO fx_rates (tenant_id, currency, rate_date, rate, source, entered_by) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING`,
      [ctx.tenantId, r.currency, b.rateDate, r.rate, source, ctx.userId]);
    (ins.rowCount ? imported : skipped).push(r.currency);
  }
  if (imported.length) await audit(tx, ctx, 'fx_rate.imported', 'tenant', ctx.tenantId, { rateDate: b.rateDate, bulletin: b.bulletin, imported });
  return { rateDate: b.rateDate, bulletin: b.bulletin, imported, skipped };
}
