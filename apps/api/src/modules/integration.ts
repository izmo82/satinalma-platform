import { createHash } from 'node:crypto';
import { reconcileErpResult, type ErpExpected, type ErpResultRow } from '@sp/domain';
import type { TenantContext, Tx } from '../db.ts';
import { audit } from '../audit.ts';
import { ApiError, conflict, notFound } from '../errors.ts';
import { erpAdapter } from '../erp/adapter.ts';
import { csvCell } from './kpi.ts';
import { ERP_PAYABLE_SQL } from './invoices.ts';

/**
 * ERP mutabakatı (08 "Entegrasyon ve kayıt otoritesi", Faz 7). Platform onayı ile ERP'deki muhasebe kaydı ayrı tutulur:
 * - Durum ve toplam raporu: onaylanan faturalar ERP'ye ulaştı mı, hangisi belirsiz/başarısız/yapılandırılmamış.
 * - Yetkili tekrar gönderim: gerekçeli, denetimli; belirsiz kayıt önce ERP'de sorgulanır (ikinci kayıt açılmaz).
 * - ERP API'si yoksa kontrollü CSV: aktarım dosyası ve ERP'den dönen sonuç dosyasının satır satır mutabakatı.
 */

// Dönemde onaylanan faturalar bir kez süzülür (fatura başına tek onay kaydı vardır; bkz. invoice_one_final).
const APPROVED_IN_PERIOD = `ap AS (SELECT d.invoice_id, d.decided_at AS approved_at FROM invoice_decisions d
  WHERE d.kind = 'APPROVAL' AND (d.decided_at AT TIME ZONE 'Europe/Istanbul')::date BETWEEN $1::date AND $2::date)`; // dönem yerel iş günüyle

const ATTENTION_LIMIT = 500;

export async function reconciliation(tx: Tx, q: { from: string; to: string }, adapterName: string | null) {
  const byStatus = (await tx.query<{ status: string; currency: string; n: number; total: string }>(`
    WITH ${APPROVED_IN_PERIOD}
    SELECT coalesce(e.status, 'MISSING') AS status, i.currency, count(*)::int AS n, sum(${ERP_PAYABLE_SQL}::numeric)::numeric(20,2)::text AS total
    FROM ap JOIN invoices i ON i.id = ap.invoice_id LEFT JOIN erp_exports e ON e.invoice_id = i.id
    GROUP BY 1, 2 ORDER BY 1, 2`, [q.from, q.to])).rows;
  const attention = (await tx.query(`
    WITH ${APPROVED_IN_PERIOD}
    SELECT i.id AS "invoiceId", i.invoice_no AS "invoiceNo", s.legal_name AS "supplierName", i.currency, ${ERP_PAYABLE_SQL} AS payable,
      coalesce(e.status, 'MISSING') AS status, e.idempotency_key AS "idempotencyKey", e.external_id AS "externalId", e.attempts, e.post_calls AS "postCalls",
      e.last_error AS "lastError", e.updated_at AS "updatedAt", ap.approved_at AS "approvedAt"
    FROM ap JOIN invoices i ON i.id = ap.invoice_id JOIN suppliers s ON s.id = i.supplier_id LEFT JOIN erp_exports e ON e.invoice_id = i.id
    WHERE coalesce(e.status, 'MISSING') <> 'CONFIRMED'
    ORDER BY ap.approved_at LIMIT ${ATTENTION_LIMIT}`, [q.from, q.to])).rows;
  const inbox = (await tx.query<{ events: number; repeats: number }>(`SELECT count(*)::int AS events, coalesce(sum(repeat_count), 0)::int AS repeats
    FROM integration_inbox WHERE source = 'erp' AND received_at >= $1::date AND received_at < ($2::date + 1)`, [q.from, q.to])).rows[0]!;
  return {
    period: q, dataAsOf: new Date().toISOString(), adapterConfigured: !!erpAdapter(adapterName),
    byStatus, attention, attentionTruncated: attention.length >= ATTENTION_LIMIT, inbox,
    note: 'Onay platformda, muhasebe kaydı ERP\'dedir. "Yapılandırılmadı" durumundaki faturalar ERP\'ye gitmemiştir; CSV ile aktarılıp sonuç dosyasıyla eşlenmelidir.',
  };
}

/** Yetkili tekrar gönderim. Belirsiz (UNKNOWN) kayıt durumunu korur: iş önce ERP'de anahtarla sorgular, kayıt varsa ikinci kez göndermez. */
export async function replay(tx: Tx, ctx: TenantContext, invoiceId: string, reason: string, adapterName: string | null) {
  const e = (await tx.query<{ status: string; idempotency_key: string; company_id: string }>(`SELECT status, idempotency_key, company_id FROM erp_exports WHERE invoice_id = $1 FOR UPDATE`, [invoiceId])).rows[0];
  if (!e) throw notFound();
  if (!['FAILED', 'UNKNOWN', 'NOT_CONFIGURED'].includes(e.status)) throw conflict('not_replayable', 'Yalnız başarısız, belirsiz veya yapılandırılmamış aktarım tekrar gönderilir.');
  if (!erpAdapter(adapterName)) throw conflict('erp_not_configured', 'ERP bağdaştırıcısı yapılandırılmadı; tekrar gönderim yerine CSV aktarımı ve sonuç dosyası mutabakatını kullanın.');
  const n = (await tx.query<{ n: number }>(`SELECT count(*)::int AS n FROM jobs WHERE kind = 'erp.export' AND payload->>'invoiceId' = $1`, [invoiceId])).rows[0]!.n;
  if (e.status !== 'UNKNOWN') await tx.query(`UPDATE erp_exports SET status = 'PENDING', last_error = NULL, updated_at = now() WHERE invoice_id = $1`, [invoiceId]);
  await tx.query(`INSERT INTO jobs (tenant_id, company_id, kind, idempotency_key, payload, requested_by) VALUES ($1,$2,'erp.export',$3,$4,$5)`,
    [ctx.tenantId, e.company_id, `${e.idempotency_key}:replay:${n}`, { invoiceId }, ctx.userId]);
  await audit(tx, ctx, 'erp.export.replayed', 'invoice', invoiceId, { previousStatus: e.status }, reason.trim());
  return { status: e.status === 'UNKNOWN' ? 'UNKNOWN' : 'PENDING', queued: true };
}

const BATCH_HEADER = ['aktarim_anahtari', 'fatura_no', 'fatura_tarihi', 'tedarikci_vkn', 'tedarikci', 'sirket', 'para_birimi', 'net', 'odenecek', 'siparis', 'sozlesme', 'onay_tarihi'];

/** ERP'ye CSV ile aktarılacak onaylı faturalar (ERP'de henüz onaylanmamış olanlar). Formül enjeksiyonu kaçışlı, denetimli. */
export async function batchCsv(tx: Tx, ctx: TenantContext, q: { from: string; to: string }) {
  const rows = (await tx.query<Record<string, string | null>>(`
    WITH ${APPROVED_IN_PERIOD}
    SELECT e.idempotency_key, i.invoice_no, i.issue_date::text, s.tax_id, s.legal_name, le.name AS company, i.currency,
      (SELECT coalesce(sum(l.net_amount), 0)::numeric(20,2)::text FROM invoice_lines l WHERE l.invoice_id = i.id) AS net, ${ERP_PAYABLE_SQL} AS payable,
      (SELECT string_agg(DISTINCT po.code, ' ') FROM invoice_allocations a JOIN po_lines pl ON pl.id = a.po_line_id JOIN purchase_orders po ON po.id = pl.po_id WHERE a.invoice_id = i.id) AS po_codes,
      (SELECT string_agg(DISTINCT f.code, ' ') FROM invoice_allocations a LEFT JOIN po_lines pl ON pl.id = a.po_line_id LEFT JOIN purchase_orders po ON po.id = pl.po_id
         JOIN contract_versions cv ON cv.id = coalesce(a.contract_version_id, po.contract_version_id) JOIN contract_families f ON f.id = cv.family_id WHERE a.invoice_id = i.id) AS contract_codes,
      to_char(ap.approved_at AT TIME ZONE 'Europe/Istanbul', 'YYYY-MM-DD') AS approved_on
    FROM ap JOIN invoices i ON i.id = ap.invoice_id JOIN erp_exports e ON e.invoice_id = i.id JOIN suppliers s ON s.id = i.supplier_id JOIN legal_entities le ON le.id = i.company_id
    WHERE e.status IN ('NOT_CONFIGURED','FAILED')
    ORDER BY ap.approved_at, i.invoice_no`, [q.from, q.to])).rows;
  await audit(tx, ctx, 'erp.batch.exported', 'tenant', ctx.tenantId, { from: q.from, to: q.to, rows: rows.length });
  const lines = [BATCH_HEADER, ...rows.map((r) => [r.idempotency_key, r.invoice_no, r.issue_date, r.tax_id, r.legal_name, r.company, r.currency, r.net, r.payable, r.po_codes, r.contract_codes, r.approved_on])];
  return { csv: '﻿' + lines.map((l) => l.map((c) => csvCell(c ?? null)).join(';')).join('\r\n'), rows: rows.length };
}

/** Basit CSV ayrıştırıcı: `;` veya `,` ayırıcı (başlıktan anlaşılır), çift tırnak kaçışı, BOM. */
export function parseCsv(text: string): string[][] {
  const src = text.replace(/^﻿/, '');
  const firstLine = src.split(/\r?\n/, 1)[0] ?? '';
  const sep = (firstLine.match(/;/g)?.length ?? 0) >= (firstLine.match(/,/g)?.length ?? 0) ? ';' : ',';
  const out: string[][] = []; let row: string[] = []; let cell = ''; let q = false;
  for (let i = 0; i < src.length; i++) {
    const c = src[i]!;
    if (q) {
      if (c === '"' && src[i + 1] === '"') { cell += '"'; i++; } else if (c === '"') q = false; else cell += c;
    } else if (c === '"' && cell === '') q = true;
    else if (c === sep) { row.push(cell); cell = ''; }
    else if (c === '\n' || c === '\r') { if (c === '\r' && src[i + 1] === '\n') i++; row.push(cell); cell = ''; if (row.some((x) => x !== '')) out.push(row); row = []; }
    else cell += c;
  }
  row.push(cell); if (row.some((x) => x !== '')) out.push(row);
  return out;
}

const RESULT_HEADER = ['aktarim_anahtari', 'erp_kimligi', 'durum', 'odenecek', 'mesaj'];

/**
 * ERP sonuç dosyası. Önce `dryRun` ile mutabakat görülür; uygulamada yalnız tutarı tutan "OK" satırlar CONFIRMED olur,
 * ERP'nin reddettikleri FAILED olur. Diğer her şey (bilinmeyen anahtar, tutar farkı, mükerrer satır) değişiklik yapmaz.
 */
export async function applyResultCsv(tx: Tx, ctx: TenantContext, b: { csv: string; dryRun: boolean }) {
  const table = parseCsv(b.csv);
  const header = (table[0] ?? []).map((h) => h.trim().toLowerCase());
  const idx = RESULT_HEADER.map((h) => header.indexOf(h));
  if (idx.some((i) => i < 0)) throw new ApiError(422, 'invalid_header', `Başlık satırı şu sütunları içermeli: ${RESULT_HEADER.join(';')}.`);
  if (table.length - 1 > 5000) throw new ApiError(413, 'too_many_rows', 'Sonuç dosyası en fazla 5000 satır olabilir.');
  const rows: ErpResultRow[] = table.slice(1).map((r, n) => ({ line: n + 2, idempotencyKey: r[idx[0]!] ?? '', externalId: r[idx[1]!] ?? '', status: r[idx[2]!] ?? '',
    payable: r[idx[3]!] ?? '', message: (r[idx[4]!] ?? '').slice(0, 500) }));
  const keys = rows.map((r) => r.idempotencyKey.trim()).filter(Boolean);
  // Beklenen: dosyadaki anahtarlar + ERP'de henüz onaylanmamış bütün aktarımlar (dosyada eksik kalanları görmek için).
  const expected: ErpExpected[] = (await tx.query<ErpExpected>(`
    SELECT e.idempotency_key AS "idempotencyKey", i.invoice_no AS "invoiceNo", ${ERP_PAYABLE_SQL} AS payable, e.status AS "currentStatus", e.external_id AS "externalId"
    FROM erp_exports e JOIN invoices i ON i.id = e.invoice_id WHERE e.idempotency_key = ANY($1::text[]) OR e.status IN ('NOT_CONFIGURED','FAILED')
    ${b.dryRun ? '' : 'FOR UPDATE OF e'}`, [keys])).rows;
  const r = reconcileErpResult(rows, expected);
  const fileSha256 = createHash('sha256').update(b.csv).digest('hex');
  if (!b.dryRun) {
    for (const x of r.rows) {
      if (x.outcome === 'MATCHED') {
        const ext = rows.find((y) => y.line === x.line)!.externalId.trim();
        await tx.query(`UPDATE erp_exports SET status = 'CONFIRMED', external_id = $2, last_error = NULL, updated_at = now() WHERE idempotency_key = $1 AND status <> 'CONFIRMED'`, [x.idempotencyKey, ext]);
      } else if (x.outcome === 'ERP_REJECTED') {
        await tx.query(`UPDATE erp_exports SET status = 'FAILED', last_error = $2, updated_at = now() WHERE idempotency_key = $1 AND status <> 'CONFIRMED'`, [x.idempotencyKey, `ERP: ${x.detail}`.slice(0, 200)]);
      }
    }
    await audit(tx, ctx, 'erp.reconciliation.applied', 'tenant', ctx.tenantId, { fileSha256, counts: r.counts, fileTotal: r.fileTotal, matchedTotal: r.matchedTotal });
  }
  return { dryRun: b.dryRun, fileSha256, ...r };
}
