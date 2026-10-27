import { createHash } from 'node:crypto';
import {
  availableLimit, checkInvoice, isDecimal, openCommitment,
  type AllocationInput, type ContractState, type InvoiceCheckInput, type PoLineState, type ToleranceRule,
} from '@sp/domain';
import type { TenantContext, Tx } from '../db.ts';
import { audit } from '../audit.ts';
import { nextCode } from '../codes.ts';
import { closeTasks, openTask } from '../tasks.ts';
import { ApiError, conflict, forbidden, notFound, unprocessable } from '../errors.ts';
import { ErpTimeout, erpAdapter } from '../erp/adapter.ts';

/**
 * Faz 4: sipariş, kabul, fatura tahsisi, kontrol, istisna, finans onayı, ERP aktarımı ve gelen durum olayları.
 * Kontrol sonucu saklanmaz; her okumada güncel veriden hesaplanır. Onay, kontrolün parmak izine bağlanır (BR04).
 */

const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const APPROVED = `EXISTS (SELECT 1 FROM invoice_decisions d WHERE d.invoice_id = i.id AND d.kind = 'APPROVAL') AND i.legal_status = 'RECEIVED'`;

/** Sözleşme sürümleri için limit kilidi: sıralı alınır (kilitlenme yok); aynı limiti tüketen işlemler seri işlenir (T15). */
async function lockContracts(tx: Tx, ids: string[]) {
  for (const id of [...new Set(ids)].sort()) await tx.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`limit:${id}`]);
}

async function contractState(tx: Tx, cvId: string, excludeInvoiceId: string | null): Promise<ContractState | null> {
  const cv = (await tx.query<{ id: string; title: string; stage: string; signature_method: string; signature_finalized_at: Date | null }>(
    `SELECT cv.id, f.title, cv.stage, cv.signature_method, cv.signature_finalized_at FROM contract_versions cv JOIN contract_families f ON f.id = cv.family_id WHERE cv.id = $1`, [cvId])).rows[0];
  if (!cv) return null;
  const t = (await tx.query<{ currency: string; value_type: string; amount: string | null; verified_by: string | null }>(
    `SELECT currency, value_type, amount::text, verified_by FROM contract_terms WHERE contract_version_id = $1 ORDER BY revision DESC LIMIT 1`, [cvId])).rows[0];
  const ceiling = t && t.verified_by && t.value_type !== 'UNPRICED' ? t.amount : null;
  // Net tüketim: onaylı fatura tahsisleri (doğrudan sözleşmeye veya sözleşmeye bağlı siparişe), iadeler negatif.
  const cons = (await tx.query<{ v: string }>(`SELECT coalesce(sum(CASE i.kind WHEN 'CREDIT_NOTE' THEN -a.amount ELSE a.amount END), 0)::numeric(20,2)::text AS v
    FROM invoice_allocations a JOIN invoices i ON i.id = a.invoice_id LEFT JOIN po_lines pl ON pl.id = a.po_line_id LEFT JOIN purchase_orders po ON po.id = pl.po_id
    WHERE coalesce(po.contract_version_id, a.contract_version_id) = $1 AND i.kind <> 'ADVANCE' AND ${APPROVED} AND ($2::uuid IS NULL OR i.id <> $2)`, [cvId, excludeInvoiceId])).rows[0]!.v;
  const lines = (await tx.query<{ ordered: string; invoiced: string }>(`SELECT round(pl.quantity * pl.unit_price, 2)::text AS ordered,
      coalesce((SELECT sum(CASE i.kind WHEN 'CREDIT_NOTE' THEN -a.amount ELSE a.amount END) FROM invoice_allocations a JOIN invoices i ON i.id = a.invoice_id
        WHERE a.po_line_id = pl.id AND ${APPROVED} AND ($2::uuid IS NULL OR i.id <> $2)), 0)::numeric(20,2)::text AS invoiced
    FROM po_lines pl JOIN purchase_orders po ON po.id = pl.po_id WHERE po.contract_version_id = $1 AND po.status = 'OPEN'`, [cvId, excludeInvoiceId])).rows;
  return {
    contractVersionId: cvId, title: cv.title, currency: t?.currency ?? 'TRY', ceiling, netConsumption: cons,
    openCommitment: openCommitment(lines.map((l) => ({ orderedAmount: l.ordered, invoicedAmount: l.invoiced }))),
    signatureUnresolved: cv.signature_method !== 'NOT_REQUIRED' && !cv.signature_finalized_at, archiveImport: cv.stage === 'ARCHIVE_IMPORT',
  };
}

// --- Sipariş ve kabul -------------------------------------------------------------------------

export interface PoInput { companyId: string; supplierId: string; contractVersionId?: string | null; projectId?: string | null; currency: string;
  lines: { kind: 'GOODS' | 'SERVICE'; description: string; unit: string; quantity: string; unitPrice: string }[] }

export async function createPo(tx: Tx, ctx: TenantContext, b: PoInput) {
  if (!ctx.companyIds.includes(b.companyId)) throw forbidden('company');
  const s = (await tx.query<{ status: string; legal_name: string }>(`SELECT status, legal_name FROM suppliers WHERE id = $1`, [b.supplierId])).rows[0];
  if (!s) throw notFound();
  if (s.status !== 'ACTIVE') throw unprocessable('supplier_not_active', `${s.legal_name} aktif tedarikçi değil; sipariş verilemez (BR02).`);
  for (const l of b.lines) if (!isDecimal(l.quantity) || !isDecimal(l.unitPrice) || Number(l.quantity) <= 0) throw unprocessable('invalid_number', 'Miktar ve birim fiyat ondalık sayı olmalı.');
  const total = b.lines.reduce((t, l) => t + Math.round(Number(l.quantity) * Number(l.unitPrice) * 100), 0) / 100;
  if (b.contractVersionId) {
    await lockContracts(tx, [b.contractVersionId]);
    const c = await contractState(tx, b.contractVersionId, null);
    if (!c) throw notFound();
    // Sipariş açık taahhüttür: tavanı aşan sipariş verilemez (BR07).
    if (c.ceiling !== null) {
      const avail = availableLimit(c.ceiling, c.netConsumption, c.openCommitment);
      if (total > Number(avail)) throw unprocessable('limit_exceeded', `${c.title}: kullanılabilir limit ${avail} ${c.currency}, sipariş ${total.toFixed(2)}.`, { available: avail });
    }
  }
  const code = await nextCode(tx, ctx, 'po', 'PO');
  const po = (await tx.query<{ id: string }>(`INSERT INTO purchase_orders (tenant_id, company_id, code, supplier_id, contract_version_id, project_id, currency, issued_by)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`, [ctx.tenantId, b.companyId, code, b.supplierId, b.contractVersionId ?? null, b.projectId ?? null, b.currency, ctx.userId])).rows[0]!;
  let n = 0;
  for (const l of b.lines) {
    await tx.query(`INSERT INTO po_lines (tenant_id, company_id, po_id, line_no, kind, description, unit, quantity, unit_price) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [ctx.tenantId, b.companyId, po.id, ++n, l.kind, l.description.trim(), l.unit.trim(), l.quantity, l.unitPrice]);
  }
  await audit(tx, ctx, 'po.issued', 'purchase_order', po.id, { code, total: total.toFixed(2), contractVersionId: b.contractVersionId ?? null });
  return { id: po.id, code };
}

async function poLineStates(tx: Tx, poLineIds: string[], excludeInvoiceId: string | null): Promise<PoLineState[]> {
  if (!poLineIds.length) return [];
  return (await tx.query<PoLineState>(`SELECT pl.id AS "poLineId", pl.description, pl.unit, po.currency, pl.kind, trim_scale(pl.quantity)::text AS "orderedQty",
      trim_scale(pl.unit_price)::text AS "unitPrice", po.contract_version_id AS "contractVersionId",
      coalesce((SELECT trim_scale(sum(r.quantity)) FROM receipts r WHERE r.po_line_id = pl.id), 0)::text AS "receivedQty",
      coalesce((SELECT trim_scale(sum(CASE i.kind WHEN 'CREDIT_NOTE' THEN -a.quantity ELSE a.quantity END)) FROM invoice_allocations a JOIN invoices i ON i.id = a.invoice_id
        WHERE a.po_line_id = pl.id AND i.kind <> 'ADVANCE' AND ${APPROVED} AND ($2::uuid IS NULL OR i.id <> $2)), 0)::text AS "invoicedQty",
      coalesce((SELECT sum(CASE i.kind WHEN 'CREDIT_NOTE' THEN -a.amount ELSE a.amount END) FROM invoice_allocations a JOIN invoices i ON i.id = a.invoice_id
        WHERE a.po_line_id = pl.id AND i.kind <> 'ADVANCE' AND ${APPROVED} AND ($2::uuid IS NULL OR i.id <> $2)), 0)::numeric(20,2)::text AS "invoicedAmount"
    FROM po_lines pl JOIN purchase_orders po ON po.id = pl.po_id WHERE pl.id = ANY($1::uuid[])`, [poLineIds, excludeInvoiceId])).rows;
}

export async function recordReceipt(tx: Tx, ctx: TenantContext, poLineId: string, b: { quantity: string; periodFrom?: string | null; periodTo?: string | null; note: string }) {
  if (!isDecimal(b.quantity) || Number(b.quantity) <= 0) throw unprocessable('invalid_number', 'Kabul miktarı pozitif olmalı.');
  await tx.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`receipt:${poLineId}`]);
  const [pl] = await poLineStates(tx, [poLineId], null);
  if (!pl) throw notFound();
  if (Number(pl.receivedQty) + Number(b.quantity) > Number(pl.orderedQty)) throw unprocessable('over_receipt', `Toplam kabul sipariş miktarını (${pl.orderedQty} ${pl.unit}) aşamaz; şu an ${pl.receivedQty}.`);
  if (pl.kind === 'SERVICE' && (!b.periodFrom || !b.periodTo)) throw unprocessable('period_required', 'Hizmet kabulü dönem (başlangıç–bitiş) ile kaydedilir.');
  const company = (await tx.query<{ company_id: string }>(`SELECT company_id FROM po_lines WHERE id = $1`, [poLineId])).rows[0]!.company_id;
  const r = (await tx.query<{ id: string }>(`INSERT INTO receipts (tenant_id, company_id, po_line_id, quantity, period_from, period_to, note, recorded_by)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`, [ctx.tenantId, company, poLineId, b.quantity, b.periodFrom ?? null, b.periodTo ?? null, b.note.trim(), ctx.userId])).rows[0]!;
  await closeTasks(tx, `receipt-needed:${poLineId}`);
  await audit(tx, ctx, 'receipt.recorded', 'po_line', poLineId, { receiptId: r.id, quantity: b.quantity });
  return { id: r.id };
}

/** Ters kabul: özgün kayda bağlı negatif kayıt. Kabul düşürülürken önceden faturalanmış miktarın altına inemez. */
export async function reverseReceipt(tx: Tx, ctx: TenantContext, receiptId: string, b: { quantity: string; note: string }) {
  const orig = (await tx.query<{ po_line_id: string; quantity: string; company_id: string }>(`SELECT po_line_id, quantity::text, company_id FROM receipts WHERE id = $1 AND quantity > 0`, [receiptId])).rows[0];
  if (!orig) throw notFound();
  if (!isDecimal(b.quantity) || Number(b.quantity) <= 0) throw unprocessable('invalid_number', 'Ters kabul miktarı pozitif yazılır.');
  await tx.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`receipt:${orig.po_line_id}`]);
  const already = Number((await tx.query<{ v: string }>(`SELECT coalesce(-sum(quantity), 0)::text AS v FROM receipts WHERE reverses_id = $1`, [receiptId])).rows[0]!.v);
  if (already + Number(b.quantity) > Number(orig.quantity)) throw unprocessable('over_reversal', 'Ters kabul özgün kabul miktarını aşamaz.');
  const [pl] = await poLineStates(tx, [orig.po_line_id], null);
  if (Number(pl!.receivedQty) - Number(b.quantity) < Number(pl!.invoicedQty)) {
    throw unprocessable('receipt_already_invoiced', `Bu miktar faturalanmış (${pl!.invoicedQty} ${pl!.unit}); önce iade/alacak belgesi gerekir.`);
  }
  const r = (await tx.query<{ id: string }>(`INSERT INTO receipts (tenant_id, company_id, po_line_id, quantity, reverses_id, note, recorded_by)
    VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`, [ctx.tenantId, orig.company_id, orig.po_line_id, `-${b.quantity}`, receiptId, b.note.trim(), ctx.userId])).rows[0]!;
  await audit(tx, ctx, 'receipt.reversed', 'po_line', orig.po_line_id, { receiptId: r.id, reverses: receiptId, quantity: b.quantity }, b.note);
  return { id: r.id };
}

export async function listPos(tx: Tx) {
  return (await tx.query(`SELECT po.id, po.code, po.currency, po.status, po.issued_at AS "issuedAt", s.legal_name AS "supplierName", f.title AS "contractTitle",
      (SELECT round(sum(quantity * unit_price), 2)::text FROM po_lines WHERE po_id = po.id) AS total
    FROM purchase_orders po JOIN suppliers s ON s.id = po.supplier_id LEFT JOIN contract_versions cv ON cv.id = po.contract_version_id
    LEFT JOIN contract_families f ON f.id = cv.family_id ORDER BY po.issued_at DESC LIMIT 200`)).rows;
}

export async function getPo(tx: Tx, id: string) {
  const po = (await tx.query(`SELECT po.id, po.code, po.currency, po.status, po.issued_at AS "issuedAt", po.supplier_id AS "supplierId", s.legal_name AS "supplierName",
      po.contract_version_id AS "contractVersionId", f.title AS "contractTitle", u.display_name AS "issuedBy"
    FROM purchase_orders po JOIN suppliers s ON s.id = po.supplier_id JOIN users u ON u.id = po.issued_by
    LEFT JOIN contract_versions cv ON cv.id = po.contract_version_id LEFT JOIN contract_families f ON f.id = cv.family_id WHERE po.id = $1`, [id])).rows[0];
  if (!po) throw notFound();
  const ids = (await tx.query<{ id: string }>(`SELECT id FROM po_lines WHERE po_id = $1 ORDER BY line_no`, [id])).rows.map((r) => r.id);
  const states = await poLineStates(tx, ids, null);
  const receipts = (await tx.query(`SELECT r.id, r.po_line_id AS "poLineId", trim_scale(r.quantity)::text AS quantity, r.period_from::text AS "periodFrom", r.period_to::text AS "periodTo",
      r.reverses_id AS "reversesId", r.note, r.recorded_at AS "recordedAt", u.display_name AS "recordedBy"
    FROM receipts r JOIN users u ON u.id = r.recorded_by WHERE r.po_line_id = ANY($1::uuid[]) ORDER BY r.recorded_at`, [ids])).rows;
  return { po, lines: ids.map((i) => states.find((s) => s.poLineId === i)!), receipts };
}

// --- Fatura -----------------------------------------------------------------------------------

export interface InvoiceInput {
  companyId: string; supplierId: string; kind: 'INVOICE' | 'CREDIT_NOTE' | 'ADVANCE'; invoiceNo: string; ettn?: string | null; issueDate: string; currency: string;
  documentVersionId?: string | null; originalInvoiceId?: string | null;
  lines: { description: string; quantity: string; unit: string; unitPrice: string; netAmount: string; taxRate?: string }[];
}

/** Fatura girişi: aynı tedarikçi için aynı ETTN veya fatura no ikinci mali kayıt açmaz; tekrar izi tutulur (T17). */
export async function createInvoice(tx: Tx, ctx: TenantContext, b: InvoiceInput, source = 'manual') {
  if (!ctx.companyIds.includes(b.companyId)) throw forbidden('company');
  await tx.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`invoice:${b.supplierId}:${b.invoiceNo}`]);
  const dup = (await tx.query<{ id: string; company_id: string }>(`SELECT id, company_id FROM invoices WHERE supplier_id = $1 AND (invoice_no = $2 OR ($3::uuid IS NOT NULL AND ettn = $3))`,
    [b.supplierId, b.invoiceNo.trim(), b.ettn ?? null])).rows[0];
  if (dup) {
    await tx.query(`INSERT INTO invoice_intake_events (tenant_id, company_id, invoice_id, source, duplicate, received_by) VALUES ($1,$2,$3,$4,true,$5)`,
      [ctx.tenantId, dup.company_id, dup.id, source, ctx.userId]);
    await audit(tx, ctx, 'invoice.duplicate_received', 'invoice', dup.id, { source, invoiceNo: b.invoiceNo });
    return { id: dup.id, duplicate: true };
  }
  if (b.kind === 'CREDIT_NOTE') {
    const o = (await tx.query<{ supplier_id: string; kind: string }>(`SELECT supplier_id, kind FROM invoices WHERE id = $1`, [b.originalInvoiceId ?? null])).rows[0];
    if (!o || o.supplier_id !== b.supplierId || o.kind !== 'INVOICE') throw unprocessable('original_required', 'İade/alacak belgesi aynı tedarikçinin özgün faturasına bağlanır.');
  }
  for (const l of b.lines) {
    if (![l.quantity, l.unitPrice, l.netAmount].every(isDecimal)) throw unprocessable('invalid_number', 'Satır tutarları ondalık sayı olmalı.');
    if (Math.abs(Number(l.quantity) * Number(l.unitPrice) - Number(l.netAmount)) > 0.01) throw unprocessable('line_total_mismatch', `"${l.description}": miktar × birim fiyat satır tutarına eşit değil.`);
  }
  const inv = (await tx.query<{ id: string }>(`INSERT INTO invoices (tenant_id, company_id, supplier_id, kind, invoice_no, ettn, issue_date, currency, document_version_id, original_invoice_id, created_by)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id`, [ctx.tenantId, b.companyId, b.supplierId, b.kind, b.invoiceNo.trim(), b.ettn ?? null, b.issueDate,
    b.currency, b.documentVersionId ?? null, b.originalInvoiceId ?? null, ctx.userId])).rows[0]!;
  let n = 0;
  for (const l of b.lines) {
    await tx.query(`INSERT INTO invoice_lines (tenant_id, company_id, invoice_id, line_no, description, quantity, unit, unit_price, net_amount, tax_rate) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [ctx.tenantId, b.companyId, inv.id, ++n, l.description.trim(), l.quantity, l.unit.trim(), l.unitPrice, l.netAmount, l.taxRate ?? '20']);
  }
  await tx.query(`INSERT INTO invoice_intake_events (tenant_id, company_id, invoice_id, source, duplicate, received_by) VALUES ($1,$2,$3,$4,false,$5)`, [ctx.tenantId, b.companyId, inv.id, source, ctx.userId]);
  await audit(tx, ctx, 'invoice.received', 'invoice', inv.id, { kind: b.kind, invoiceNo: b.invoiceNo, lines: b.lines.length });
  return { id: inv.id, duplicate: false };
}

async function finalDecision(tx: Tx, invoiceId: string) {
  return (await tx.query<{ kind: string }>(`SELECT kind FROM invoice_decisions WHERE invoice_id = $1 AND kind IN ('APPROVAL','REJECTION')`, [invoiceId])).rows[0]?.kind ?? null;
}

export async function setAllocations(tx: Tx, ctx: TenantContext, invoiceId: string, b: { allocations: AllocationInput[]; advanceOffset?: string; advanceInvoiceId?: string | null }) {
  const inv = (await tx.query<{ company_id: string; kind: string; supplier_id: string }>(`SELECT company_id, kind, supplier_id FROM invoices WHERE id = $1`, [invoiceId])).rows[0];
  if (!inv) throw notFound();
  if (await finalDecision(tx, invoiceId)) throw conflict('invoice_decided', 'Karar verilmiş faturanın tahsisi değişmez; iade/alacak belgesi kullanın.');
  for (const a of b.allocations) if (!isDecimal(a.quantity) || !isDecimal(a.amount) || Number(a.amount) <= 0) throw unprocessable('invalid_number', 'Tahsis miktarı ve tutarı pozitif olmalı.');
  if (b.advanceInvoiceId) {
    const adv = (await tx.query(`SELECT 1 FROM invoices i WHERE i.id = $1 AND i.kind = 'ADVANCE' AND i.supplier_id = $2 AND ${APPROVED}`, [b.advanceInvoiceId, inv.supplier_id])).rowCount;
    if (!adv) throw unprocessable('advance_invalid', 'Mahsup için aynı tedarikçinin onaylı avans faturası seçilmeli.');
  }
  await tx.query(`DELETE FROM invoice_allocations WHERE invoice_id = $1`, [invoiceId]);
  for (const a of b.allocations) {
    await tx.query(`INSERT INTO invoice_allocations (tenant_id, company_id, invoice_id, line_no, po_line_id, contract_version_id, quantity, amount, created_by)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`, [ctx.tenantId, inv.company_id, invoiceId, a.lineNo, a.poLineId, a.contractVersionId, a.quantity, a.amount, ctx.userId]);
  }
  await tx.query(`UPDATE invoices SET advance_offset = $2, advance_invoice_id = $3 WHERE id = $1`, [invoiceId, b.advanceOffset ?? '0', b.advanceInvoiceId ?? null]);
  await audit(tx, ctx, 'invoice.allocated', 'invoice', invoiceId, { allocations: b.allocations.length, advanceOffset: b.advanceOffset ?? '0' });
  return evaluate(tx, invoiceId);
}

/** Kontrol girdisini güncel veriden kurar ve domain kontrolünü çalıştırır. */
async function evaluate(tx: Tx, invoiceId: string) {
  const inv = (await tx.query<{ id: string; kind: InvoiceCheckInput['kind']; currency: string; supplier_id: string; advance_offset: string; advance_invoice_id: string | null; supplier_status: string }>(
    `SELECT i.id, i.kind, i.currency, i.supplier_id, i.advance_offset::text, i.advance_invoice_id, s.status AS supplier_status FROM invoices i JOIN suppliers s ON s.id = i.supplier_id WHERE i.id = $1`, [invoiceId])).rows[0];
  if (!inv) throw notFound();
  const lines = (await tx.query(`SELECT line_no AS "lineNo", description, trim_scale(quantity)::text AS quantity, unit, trim_scale(unit_price)::text AS "unitPrice", net_amount::text AS "netAmount"
    FROM invoice_lines WHERE invoice_id = $1 ORDER BY line_no`, [invoiceId])).rows;
  const allocations: AllocationInput[] = (await tx.query(`SELECT line_no AS "lineNo", po_line_id AS "poLineId", contract_version_id AS "contractVersionId",
    trim_scale(quantity)::text AS quantity, amount::text FROM invoice_allocations WHERE invoice_id = $1 ORDER BY line_no`, [invoiceId])).rows;
  const poLines = await poLineStates(tx, allocations.map((a) => a.poLineId).filter((x): x is string => !!x), invoiceId);
  const cvIds = [...new Set([...poLines.map((p) => p.contractVersionId), ...allocations.map((a) => a.contractVersionId)].filter((x): x is string => !!x))];
  const contracts: ContractState[] = [];
  for (const c of cvIds) { const s = await contractState(tx, c, invoiceId); if (s) contracts.push(s); }
  const tolerance = (await tx.query<ToleranceRule>(`SELECT currency, abs_amount::text AS "absAmount", percent::text, combine FROM tolerance_rules WHERE currency = $1`, [inv.currency])).rows[0] ?? null;
  const advanceBalance = inv.advance_invoice_id ? (await tx.query<{ v: string }>(`SELECT (a.total - coalesce((SELECT sum(i.advance_offset) FROM invoices i
      WHERE i.advance_invoice_id = $1 AND i.id <> $2 AND ${APPROVED}), 0))::text AS v
    FROM (SELECT sum(net_amount) AS total FROM invoice_lines WHERE invoice_id = $1) a`, [inv.advance_invoice_id, invoiceId])).rows[0]!.v : '0';
  const input: InvoiceCheckInput = { kind: inv.kind, currency: inv.currency, supplierActive: inv.supplier_status === 'ACTIVE', lines, allocations, poLines, contracts,
    tolerance, advanceOffset: inv.advance_offset, advanceBalance };
  const check = checkInvoice(input);
  const fingerprint = sha(JSON.stringify({ a: allocations, o: inv.advance_offset, i: check.issues.map((x) => [x.code, x.lineNo ?? null]) }));
  return { check, fingerprint, contracts, poLines };
}

export async function approveException(tx: Tx, ctx: TenantContext, invoiceId: string, reason: string) {
  const inv = (await tx.query<{ company_id: string; created_by: string }>(`SELECT company_id, created_by FROM invoices WHERE id = $1`, [invoiceId])).rows[0];
  if (!inv) throw notFound();
  if (await finalDecision(tx, invoiceId)) throw conflict('invoice_decided', 'Bu fatura için karar verildi.');
  if (inv.created_by === ctx.userId) throw new ApiError(403, 'segregation_of_duties', 'Faturayı giren kişi istisnayı onaylayamaz.');
  if (reason.trim().length < 10) throw unprocessable('reason_required', 'İstisna gerekçesi, kapsamı ve süresi yazılmalı (en az 10 karakter).');
  const { check, fingerprint } = await evaluate(tx, invoiceId);
  if (!check.canApprove) throw unprocessable('blocked', 'Engelleyici bulgu varken istisna verilemez; önce bulguyu çözün.', { issues: check.issues });
  if (!check.needsException) throw unprocessable('no_exception_needed', 'Bu fatura için istisna gerekmiyor.');
  await tx.query(`INSERT INTO invoice_decisions (tenant_id, company_id, invoice_id, kind, check_hash, issues, reason, decided_by) VALUES ($1,$2,$3,'EXCEPTION_APPROVAL',$4,$5,$6,$7)`,
    [ctx.tenantId, inv.company_id, invoiceId, fingerprint, JSON.stringify(check.issues), reason.trim(), ctx.userId]);
  await closeTasks(tx, `invoice-exception:${invoiceId}`);
  await audit(tx, ctx, 'invoice.exception_approved', 'invoice', invoiceId, { issues: check.issues.map((x) => x.code) }, reason);
  return { ok: true };
}

/** Finans onayı: limit kilidi altında yeniden kontrol (T15), istisna parmak izi eşleşmesi (BR04), görev ayrılığı. */
export async function approveInvoice(tx: Tx, ctx: TenantContext, invoiceId: string, erpAdapterName: string | null = null) {
  const inv = (await tx.query<{ company_id: string; created_by: string; legal_status: string }>(`SELECT company_id, created_by, legal_status FROM invoices WHERE id = $1`, [invoiceId])).rows[0];
  if (!inv) throw notFound();
  if (inv.legal_status !== 'RECEIVED') throw conflict('legally_cancelled', 'Hukuki olarak iptal/ret edilmiş e-belge onaylanamaz.');
  if (inv.created_by === ctx.userId) throw new ApiError(403, 'segregation_of_duties', 'Faturayı giren kişi tek başına onaylayamaz (görev ayrılığı).');
  const pre = await evaluate(tx, invoiceId);
  await lockContracts(tx, Object.keys(pre.check.contractImpact));
  if (await finalDecision(tx, invoiceId)) throw conflict('invoice_decided', 'Bu fatura için karar verildi.');
  const { check, fingerprint } = await evaluate(tx, invoiceId);
  if (!check.canApprove) throw unprocessable('invoice_blocked', check.issues.find((x) => x.severity === 'BLOCK')!.message, { issues: check.issues });
  if (check.needsException) {
    const ex = (await tx.query<{ check_hash: string; decided_by: string }>(`SELECT check_hash, decided_by FROM invoice_decisions WHERE invoice_id = $1 AND kind = 'EXCEPTION_APPROVAL' ORDER BY decided_at DESC LIMIT 1`, [invoiceId])).rows[0];
    if (!ex) throw unprocessable('exception_required', 'Bu fatura istisna onayı gerektiriyor; sorumluya görev açıldı.', { issues: check.issues });
    if (ex.check_hash !== fingerprint) throw conflict('exception_stale', 'İstisna onaylandıktan sonra tahsis veya kontrol sonucu değişti; yeniden istisna onayı gerekir.');
  }
  await tx.query(`INSERT INTO invoice_decisions (tenant_id, company_id, invoice_id, kind, check_hash, issues, decided_by) VALUES ($1,$2,$3,'APPROVAL',$4,$5,$6)`,
    [ctx.tenantId, inv.company_id, invoiceId, fingerprint, JSON.stringify(check.issues), ctx.userId]);
  const key = `erp-invoice-${invoiceId}`;
  // ERP bağdaştırıcısı yoksa aktarım "yapılandırılmadı" olarak görünür; başarı gibi gösterilmez, kuyrukta da beklemez.
  const configured = !!erpAdapter(erpAdapterName);
  await tx.query(`INSERT INTO erp_exports (invoice_id, tenant_id, company_id, idempotency_key, status, last_error) VALUES ($1,$2,$3,$4,$5,$6)`,
    [invoiceId, ctx.tenantId, inv.company_id, key, configured ? 'PENDING' : 'NOT_CONFIGURED', configured ? null : 'ERP bağdaştırıcısı yapılandırılmadı']);
  await tx.query(`INSERT INTO outbox_events (tenant_id, topic, dedupe_key, payload) VALUES ($1,'invoice.approved',$2,$3) ON CONFLICT DO NOTHING`, [ctx.tenantId, invoiceId, { invoiceId, payable: check.payable }]);
  if (configured) {
    await tx.query(`INSERT INTO jobs (tenant_id, company_id, kind, idempotency_key, payload, requested_by) VALUES ($1,$2,'erp.export',$3,$4,$5) ON CONFLICT DO NOTHING`,
      [ctx.tenantId, inv.company_id, key, { invoiceId }, ctx.userId]);
  }
  await closeTasks(tx, `invoice-review:${invoiceId}`);
  await audit(tx, ctx, 'invoice.approved', 'invoice', invoiceId, { net: check.netAmount, payable: check.payable, impact: check.contractImpact });
  return { approved: true, payable: check.payable };
}

export async function rejectInvoice(tx: Tx, ctx: TenantContext, invoiceId: string, reason: string) {
  const inv = (await tx.query<{ company_id: string }>(`SELECT company_id FROM invoices WHERE id = $1`, [invoiceId])).rows[0];
  if (!inv) throw notFound();
  if (await finalDecision(tx, invoiceId)) throw conflict('invoice_decided', 'Bu fatura için karar verildi.');
  if (reason.trim().length < 10) throw unprocessable('reason_required', 'Ret gerekçesi gerekli.');
  await tx.query(`INSERT INTO invoice_decisions (tenant_id, company_id, invoice_id, kind, check_hash, reason, decided_by) VALUES ($1,$2,$3,'REJECTION','-',$4,$5)`,
    [ctx.tenantId, inv.company_id, invoiceId, reason.trim(), ctx.userId]);
  await audit(tx, ctx, 'invoice.rejected', 'invoice', invoiceId, {}, reason);
  return { rejected: true };
}

/** Kontrol bulguları sorumlu rollere görev olarak düşer (kim çözer, 02 §24). Aynı bulgu ikinci görev açmaz. */
async function syncIssueTasks(tx: Tx, ctx: TenantContext, invoiceId: string, invoiceNo: string, companyId: string, issues: { code: string; ownerRole: string; message: string; severity: string }[]) {
  await closeTasks(tx, `invoice-issue:${invoiceId}:`);
  for (const x of issues) {
    await openTask(tx, ctx, { companyId, kind: 'invoice_issue', entityType: 'invoice', entityId: invoiceId, title: `Fatura ${invoiceNo}: ${x.message.split(':')[0]}`,
      reason: x.message, nextAction: x.code === 'RECEIPT_MISSING' ? 'Teslim aldıysanız kabul kaydını girin; almadıysanız finansa bildirin.' : 'Bulguyu çözün veya yetkili istisna isteyin.',
      assigneeRole: x.ownerRole, severity: x.severity === 'BLOCK' ? 'HIGH' : 'NORMAL', dedupeKey: `invoice-issue:${invoiceId}:${x.code}` });
  }
}

export async function getInvoice(tx: Tx, ctx: TenantContext, id: string) {
  const inv = (await tx.query(`SELECT i.id, i.kind, i.invoice_no AS "invoiceNo", i.ettn, i.issue_date::text AS "issueDate", i.currency, i.company_id AS "companyId",
      i.supplier_id AS "supplierId", s.legal_name AS "supplierName", s.status AS "supplierStatus", i.legal_status AS "legalStatus", i.payment_status AS "paymentStatus",
      i.original_invoice_id AS "originalInvoiceId", i.advance_invoice_id AS "advanceInvoiceId", i.advance_offset::text AS "advanceOffset", i.document_version_id AS "documentVersionId",
      i.created_by = $2 AS "createdByMe", u.display_name AS "createdBy", i.created_at AS "createdAt"
    FROM invoices i JOIN suppliers s ON s.id = i.supplier_id JOIN users u ON u.id = i.created_by WHERE i.id = $1`, [id, ctx.userId])).rows[0];
  if (!inv) throw notFound();
  const lines = (await tx.query(`SELECT line_no AS "lineNo", description, trim_scale(quantity)::text AS quantity, unit, trim_scale(unit_price)::text AS "unitPrice", net_amount::text AS "netAmount", trim_scale(tax_rate)::text AS "taxRate"
    FROM invoice_lines WHERE invoice_id = $1 ORDER BY line_no`, [id])).rows;
  const allocations = (await tx.query(`SELECT a.line_no AS "lineNo", a.po_line_id AS "poLineId", a.contract_version_id AS "contractVersionId", trim_scale(a.quantity)::text AS quantity,
      a.amount::text, po.id AS "poId", po.code AS "poCode", pl.description AS "poLineDescription", f.title AS "contractTitle"
    FROM invoice_allocations a LEFT JOIN po_lines pl ON pl.id = a.po_line_id LEFT JOIN purchase_orders po ON po.id = pl.po_id
    LEFT JOIN contract_versions cv ON cv.id = coalesce(a.contract_version_id, po.contract_version_id) LEFT JOIN contract_families f ON f.id = cv.family_id
    WHERE a.invoice_id = $1 ORDER BY a.line_no`, [id])).rows;
  const decisions = (await tx.query(`SELECT d.kind, d.reason, d.decided_at AS "decidedAt", u.display_name AS "decidedBy", d.check_hash AS "checkHash"
    FROM invoice_decisions d JOIN users u ON u.id = d.decided_by WHERE d.invoice_id = $1 ORDER BY d.decided_at`, [id])).rows;
  const intake = (await tx.query(`SELECT source, duplicate, received_at AS "receivedAt" FROM invoice_intake_events WHERE invoice_id = $1 ORDER BY received_at`, [id])).rows;
  const erp = (await tx.query(`SELECT status, external_id AS "externalId", attempts, post_calls AS "postCalls", last_error AS "lastError", updated_at AS "updatedAt" FROM erp_exports WHERE invoice_id = $1`, [id])).rows[0] ?? null;
  const { check, fingerprint, contracts, poLines } = await evaluate(tx, id);
  const final = decisions.find((d: any) => d.kind === 'APPROVAL' || d.kind === 'REJECTION') ?? null;
  const exception = [...decisions].reverse().find((d: any) => d.kind === 'EXCEPTION_APPROVAL') ?? null;
  if (!final) await syncIssueTasks(tx, ctx, id, inv.invoiceNo, inv.companyId, check.issues);
  return {
    invoice: inv, lines, allocations, decisions, intake, erp, check, contracts, poLines,
    status: final ? final.kind : check.canApprove ? (check.needsException ? (exception?.checkHash === fingerprint ? 'EXCEPTION_APPROVED' : 'NEEDS_EXCEPTION') : 'READY') : 'BLOCKED',
    exceptionCurrent: exception ? exception.checkHash === fingerprint : null,
  };
}

export async function listInvoices(tx: Tx) {
  return (await tx.query(`SELECT i.id, i.kind, i.invoice_no AS "invoiceNo", i.issue_date::text AS "issueDate", i.currency, s.legal_name AS "supplierName",
      (SELECT sum(net_amount)::text FROM invoice_lines WHERE invoice_id = i.id) AS "netAmount", i.legal_status AS "legalStatus", i.payment_status AS "paymentStatus",
      (SELECT kind FROM invoice_decisions d WHERE d.invoice_id = i.id AND d.kind IN ('APPROVAL','REJECTION')) AS decision,
      (SELECT status FROM erp_exports e WHERE e.invoice_id = i.id) AS "erpStatus",
      (SELECT count(*)::int FROM invoice_intake_events e WHERE e.invoice_id = i.id AND e.duplicate) AS "duplicateCount"
    FROM invoices i JOIN suppliers s ON s.id = i.supplier_id ORDER BY i.created_at DESC LIMIT 300`)).rows;
}

export async function setTolerance(tx: Tx, ctx: TenantContext, b: { currency: string; absAmount: string | null; percent: string | null; combine: 'LOWER' | 'HIGHER' }) {
  if (b.absAmount === null && b.percent === null) throw unprocessable('invalid_rule', 'Tutar veya yüzde eşiği girilmeli.');
  await tx.query(`INSERT INTO tolerance_rules (tenant_id, currency, abs_amount, percent, combine, created_by) VALUES ($1,$2,$3,$4,$5,$6)
    ON CONFLICT (tenant_id, currency) DO UPDATE SET abs_amount = EXCLUDED.abs_amount, percent = EXCLUDED.percent, combine = EXCLUDED.combine, created_by = EXCLUDED.created_by, created_at = now()`,
    [ctx.tenantId, b.currency, b.absAmount, b.percent, b.combine, ctx.userId]);
  await audit(tx, ctx, 'tolerance.set', 'tenant', ctx.tenantId, b);
  return { ok: true };
}

// --- ERP aktarımı (worker) ve gelen durum olayları --------------------------------------------

export async function processErpExport(tx: Tx, ctx: TenantContext, jobId: string, adapterName: string | null) {
  const j = (await tx.query<{ payload: { invoiceId: string }; attempts: number; max_attempts: number }>(`SELECT payload, attempts, max_attempts FROM jobs WHERE id = $1`, [jobId])).rows[0]!;
  const ex = (await tx.query<{ status: string; idempotency_key: string; post_calls: number }>(`SELECT status, idempotency_key, post_calls FROM erp_exports WHERE invoice_id = $1 FOR UPDATE`, [j.payload.invoiceId])).rows[0];
  if (!ex || ex.status === 'CONFIRMED') return tx.query(`UPDATE jobs SET status = 'SUCCEEDED', updated_at = now() WHERE id = $1`, [jobId]);
  const adapter = erpAdapter(adapterName);
  if (!adapter) {
    await tx.query(`UPDATE erp_exports SET status = 'NOT_CONFIGURED', last_error = 'ERP bağdaştırıcısı yapılandırılmadı', updated_at = now() WHERE invoice_id = $1`, [j.payload.invoiceId]);
    return tx.query(`UPDATE jobs SET status = 'BLOCKED', error_code = 'ERP_NOT_CONFIGURED', updated_at = now() WHERE id = $1`, [jobId]);
  }
  const confirm = async (externalId: string, via: string) => {
    await tx.query(`UPDATE erp_exports SET status = 'CONFIRMED', external_id = $2, attempts = attempts + 1, last_error = NULL, updated_at = now() WHERE invoice_id = $1`, [j.payload.invoiceId, externalId]);
    await tx.query(`UPDATE jobs SET status = 'SUCCEEDED', result = $2, updated_at = now() WHERE id = $1`, [jobId, { externalId, via }]);
  };
  // Önceki deneme belirsiz bittiyse (zaman aşımı) dış sistem önce sorgulanır; kayıt varsa ikinci kez gönderilmez.
  if (ex.status === 'UNKNOWN' || ex.post_calls > 0) {
    const found = await adapter.find(ex.idempotency_key);
    if (found) return confirm(found.externalId, 'reconciled');
  }
  const inv = (await tx.query<{ invoice_no: string; currency: string; tax_id: string | null; net: string; offset: string }>(`SELECT i.invoice_no, i.currency, s.tax_id,
      (SELECT sum(net_amount)::text FROM invoice_lines WHERE invoice_id = i.id) AS net, i.advance_offset::text AS offset FROM invoices i JOIN suppliers s ON s.id = i.supplier_id WHERE i.id = $1`, [j.payload.invoiceId])).rows[0]!;
  const allocs = (await tx.query<{ contract_code: string | null; po_code: string | null; amount: string }>(`SELECT f.code AS contract_code, po.code AS po_code, a.amount::text
    FROM invoice_allocations a LEFT JOIN po_lines pl ON pl.id = a.po_line_id LEFT JOIN purchase_orders po ON po.id = pl.po_id
    LEFT JOIN contract_versions cv ON cv.id = coalesce(a.contract_version_id, po.contract_version_id) LEFT JOIN contract_families f ON f.id = cv.family_id WHERE a.invoice_id = $1`, [j.payload.invoiceId])).rows;
  await tx.query(`UPDATE erp_exports SET post_calls = post_calls + 1 WHERE invoice_id = $1`, [j.payload.invoiceId]);
  try {
    const r = await adapter.post({ idempotencyKey: ex.idempotency_key, invoiceNo: inv.invoice_no, supplierTaxId: inv.tax_id, currency: inv.currency, netAmount: inv.net,
      payable: (Number(inv.net) - Number(inv.offset)).toFixed(2), allocations: allocs.map((a) => ({ contractCode: a.contract_code, poCode: a.po_code, amount: a.amount })) });
    return confirm(r.externalId, 'posted');
  } catch (e) {
    const timeout = e instanceof ErpTimeout;
    await tx.query(`UPDATE erp_exports SET status = $2, attempts = attempts + 1, last_error = $3, updated_at = now() WHERE invoice_id = $1`,
      [j.payload.invoiceId, timeout ? 'UNKNOWN' : 'FAILED', timeout ? 'Zaman aşımı: dış sistemde oluşmuş olabilir; tekrar göndermeden önce sorgulanacak' : (e as Error).message.slice(0, 200)]);
    await tx.query(`UPDATE jobs SET status = CASE WHEN attempts >= max_attempts THEN 'DEAD' ELSE 'QUEUED' END, run_after = now() + interval '30 seconds',
      error_code = $2, updated_at = now() WHERE id = $1`, [jobId, timeout ? 'ERP_TIMEOUT' : 'ERP_ERROR']);
  }
}

/** Gelen ERP durum olayları (muhasebeleşti/ödendi). Aynı olay tekrar gelirse durum bir kez değişir, tekrar sayılır (T17). */
export async function ingestErpEvents(tx: Tx, ctx: TenantContext, events: { eventId: string; invoiceId: string; status: 'POSTED' | 'PAID'; at: string }[]) {
  const out: { eventId: string; result: 'applied' | 'duplicate' }[] = [];
  for (const e of events) {
    const inv = (await tx.query<{ company_id: string }>(`SELECT company_id FROM invoices WHERE id = $1`, [e.invoiceId])).rows[0];
    if (!inv) throw notFound();
    const ins = await tx.query(`INSERT INTO integration_inbox (tenant_id, company_id, source, event_id, payload) VALUES ($1,$2,'erp',$3,$4)
      ON CONFLICT (tenant_id, source, event_id) DO NOTHING RETURNING id`, [ctx.tenantId, inv.company_id, e.eventId, e]);
    if (!ins.rowCount) {
      await tx.query(`UPDATE integration_inbox SET repeat_count = repeat_count + 1, last_repeat_at = now() WHERE source = 'erp' AND event_id = $1`, [e.eventId]);
      out.push({ eventId: e.eventId, result: 'duplicate' });
      continue;
    }
    if (e.status === 'PAID') await tx.query(`UPDATE invoices SET payment_status = 'PAID' WHERE id = $1`, [e.invoiceId]);
    await audit(tx, ctx, 'invoice.erp_status', 'invoice', e.invoiceId, { eventId: e.eventId, status: e.status, at: e.at });
    out.push({ eventId: e.eventId, result: 'applied' });
  }
  return { results: out };
}


/** Sözleşme limiti görünümü (T14): tavan, net tüketim, açık taahhüt, kullanılabilir. */
export async function contractLimit(tx: Tx, cvId: string) {
  const c = await contractState(tx, cvId, null);
  if (!c) throw notFound();
  return { ...c, available: c.ceiling === null ? null : availableLimit(c.ceiling, c.netConsumption, c.openCommitment) };
}
