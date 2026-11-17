import { createHash } from 'node:crypto';
import {
  add, allocationMatched, availableLimit, checkInvoice, cmp, dec, div, isDecimal, mul, openCommitment, REMOVED_ISSUE_CODES, str, type Dec,
  type AllocationInput, type ContractState, type InvoiceCheckInput, type OtherTax, type PoLineState, type ToleranceRule,
} from '@sp/domain';
import type { TenantContext, Tx } from '../db.ts';
import { audit } from '../audit.ts';
import { nextCode } from '../codes.ts';
import { closeTasks, openTask, rederiveTaskDepartments, v2Role } from '../tasks.ts';
import { ApiError, conflict, forbidden, notFound, unprocessable } from '../errors.ts';
import { ErpTimeout, erpAdapter } from '../erp/adapter.ts';
import { criticalBlocks } from './supplierEval.ts';
import { ALLOC_FAMILIES_SQL, autoMatchInvoice, MATCH_STATE_SQL, matchInfo, overrunCheckForInvoice, releaseLinkForAllocation, type AutoMatchResult } from './invoiceMatching.ts';
import { MATCH_STATE_TR, type MatchState } from '@sp/domain';

/**
 * Faz 4: sipariş, kabul, fatura tahsisi, kontrol, istisna, finans onayı, ERP aktarımı ve gelen durum olayları.
 * Kontrol sonucu saklanmaz; her okumada güncel veriden hesaplanır. Onay, kontrolün parmak izine bağlanır (BR04).
 */

/** Kalem tutarı (miktar × birim fiyat, kuruşa yuvarlı). Para float ile hesaplanmaz. */
const amount = (q: string, p: string): Dec => dec(str(mul(dec(q), dec(p))));
const absDec = (x: Dec) => (x < 0n ? -x : x);
/** numeric(20,6) metnindeki gereksiz sıfırları atar (decimal string 6 basamağı aşmaz). */
const trimNum = (s: string) => (s.includes('.') ? s.replace(/0+$/, '').replace(/\.$/, '') : s);
const sha = (s: string) => createHash('sha256').update(s).digest('hex');
/** Birleştirilen aday hedef firmayla aynı tüzel kişidir; tahsis kontrolü ada değil bu köke bakar (D84). `s` = suppliers. */
const SUPPLIER_ROOT_SQL = `coalesce(s.merged_into_id, s.id)`;
/** Sözleşmenin tedarikçi kökleri: aile tedarikçisi + SUPPLIER tarafları (D84, D85). `cv` = contract_versions, `f` = contract_families. */
const CONTRACT_SUPPLIER_ROOTS_SQL = `ARRAY(SELECT DISTINCT ${SUPPLIER_ROOT_SQL}::text FROM suppliers s WHERE s.id = f.supplier_id
       OR s.id IN (SELECT p.supplier_id FROM contract_parties p WHERE p.contract_version_id = cv.id AND p.party_role = 'SUPPLIER'))`;
const APPROVED = `EXISTS (SELECT 1 FROM invoice_decisions d WHERE d.invoice_id = i.id AND d.kind = 'APPROVAL') AND i.legal_status = 'RECEIVED'`;

/** Sözleşme sürümleri için limit kilidi: sıralı alınır (kilitlenme yok); aynı limiti tüketen işlemler seri işlenir (T15). */
/**
 * Sipariş kilidi: kabul, ters kabul, değişiklik, kapatma ve (siparişe bağlı) fatura onayı aynı siparişte seri işlenir.
 * Sıra her yerde aynıdır: önce sipariş kilitleri (sıralı), sonra limit kilitleri — kilitlenme olmaz.
 */
async function lockPosOfLines(tx: Tx, poLineIds: string[]) {
  if (!poLineIds.length) return;
  const ids = (await tx.query<{ po_id: string }>(`SELECT DISTINCT po_id FROM po_lines WHERE id = ANY($1::uuid[])`, [poLineIds])).rows.map((r) => r.po_id).sort();
  for (const id of ids) await tx.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`po:${id}`]);
}

async function lockContracts(tx: Tx, ids: string[]) {
  for (const id of [...new Set(ids)].sort()) await tx.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`limit:${id}`]);
}

async function contractState(tx: Tx, cvId: string, excludeInvoiceId: string | null): Promise<ContractState | null> {
  const cv = (await tx.query<{ id: string; company_id: string; title: string; stage: string; signature_method: string; signature_finalized_at: Date | null; supplier_root_ids: string[] }>(
    `SELECT cv.id, cv.company_id, f.title, cv.stage, cv.signature_method, cv.signature_finalized_at, ${CONTRACT_SUPPLIER_ROOTS_SQL} AS supplier_root_ids
     FROM contract_versions cv JOIN contract_families f ON f.id = cv.family_id WHERE cv.id = $1`, [cvId])).rows[0];
  if (!cv) return null;
  const t = (await tx.query<{ currency: string; value_type: string; amount: string | null; verified_by: string | null; limit_basis: 'NET' | 'GROSS' }>(
    `SELECT currency, value_type, amount::text, verified_by, limit_basis FROM contract_terms WHERE contract_version_id = $1 AND verified_by IS NOT NULL ORDER BY revision DESC LIMIT 1`, [cvId])).rows[0];
  // Tavan ve limit yöntemi son DOĞRULANMIŞ revizyondan: doğrulanmamış yeni revizyon (ör. satınalmacının girdiği) tavanı kaldıramaz
  // veya gevşetemez; doğrulanana kadar önceki doğrulanmış koşullar geçerlidir.
  const ceiling = t && t.value_type !== 'UNPRICED' ? t.amount : null;
  const gross = t?.limit_basis === 'GROSS';
  // Net tüketim: onaylı fatura tahsisleri (doğrudan sözleşmeye veya sözleşmeye bağlı siparişe), iadeler negatif.
  // Vergi dahil limitte tahsis, faturanın o satırının vergileriyle brütleşir (domain ile aynı yuvarlama).
  const cons = (await tx.query<{ v: string }>(`SELECT coalesce(sum(CASE i.kind WHEN 'CREDIT_NOTE' THEN -1 ELSE 1 END * ${gross ? ALLOC_GROSS : 'a.amount'}), 0)::numeric(20,2)::text AS v
    FROM invoice_allocations a JOIN invoices i ON i.id = a.invoice_id JOIN invoice_lines il ON il.invoice_id = a.invoice_id AND il.line_no = a.line_no
    LEFT JOIN po_lines pl ON pl.id = a.po_line_id LEFT JOIN purchase_orders po ON po.id = pl.po_id
    WHERE coalesce(po.contract_version_id, a.contract_version_id) = $1 AND i.kind <> 'ADVANCE' AND ${APPROVED} AND ($2::uuid IS NULL OR i.id <> $2)`, [cvId, excludeInvoiceId])).rows[0]!.v;
  // Açık taahhüt: kalan (faturalanmamış) net; vergi dahil limitte sipariş satırının KDV oranıyla brüt.
  const lines = (await tx.query<{ remaining: string }>(`SELECT CASE WHEN $3 THEN round(r.remaining * (100 + coalesce(r.tax_rate, 0)) / 100, 2) ELSE r.remaining END::text AS remaining FROM (
      SELECT pl.tax_rate, greatest(round(pl.quantity * pl.unit_price, 2) - coalesce((SELECT sum(CASE i.kind WHEN 'CREDIT_NOTE' THEN -a.amount ELSE a.amount END) FROM invoice_allocations a JOIN invoices i ON i.id = a.invoice_id
        WHERE a.po_line_id = pl.id AND ${APPROVED} AND ($2::uuid IS NULL OR i.id <> $2)), 0), 0) AS remaining
      FROM po_lines_current pl JOIN purchase_orders po ON po.id = pl.po_id WHERE po.contract_version_id = $1 AND po.status <> 'CANCELLED') r`, [cvId, excludeInvoiceId, gross])).rows;
  return {
    contractVersionId: cvId, title: cv.title, currency: t?.currency ?? 'TRY', ceiling, netConsumption: cons, limitBasis: gross ? 'GROSS' : 'NET', supplierRootIds: cv.supplier_root_ids, companyId: cv.company_id,
    openCommitment: openCommitment(lines.map((l) => ({ orderedAmount: l.remaining, invoicedAmount: '0' }))),
    signatureUnresolved: cv.signature_method !== 'NOT_REQUIRED' && !cv.signature_finalized_at, archiveImport: cv.stage === 'ARCHIVE_IMPORT',
  };
}

/** Tahsisin vergi dahil karşılığı: tahsis × (satır net + KDV dışı + KDV) / satır net; KDV beyan yoksa (net + diğer) × oran. */
const ALLOC_GROSS = `coalesce(round(a.amount * (il.net_amount + coalesce(il.other_tax_amount, 0)
  + coalesce(il.tax_amount, round((il.net_amount + coalesce(il.other_tax_amount, 0)) * il.tax_rate / 100, 2))) / nullif(il.net_amount, 0), 2), a.amount)`;
/** Sipariş tutarı, vergi dahil limitte satırın KDV oranıyla. */
const poAmount = (q: string, p: string, rate: string | null | undefined, gross: boolean): Dec => {
  const net = amount(q, p);
  return gross ? dec(str(div(mul(net, dec('100') + dec(rate ?? '0')), dec('100')))) : net;
};
/** Vergi dahil limitli sözleşmede sipariş satırının KDV oranı zorunludur (açık taahhüt brüt hesaplanır). */
function requireTaxRates(lines: { description: string; taxRate?: string | null }[], gross: boolean) {
  for (const l of lines) {
    if (l.taxRate != null && l.taxRate !== '' && (!isDecimal(l.taxRate) || dec(l.taxRate) < 0n || dec(l.taxRate) > dec('100'))) throw unprocessable('invalid_number', `"${l.description}": KDV oranı 0–100 arasında olmalı.`);
    if (gross && (l.taxRate == null || l.taxRate === '')) throw unprocessable('tax_rate_required', `"${l.description}": sözleşme limiti vergi dahil; sipariş satırında KDV oranı gerekli.`);
  }
}

// --- Sipariş ve kabul -------------------------------------------------------------------------

export interface PoInput { companyId: string; supplierId: string; contractVersionId?: string | null; projectId?: string | null; currency: string;
  lines: { kind: 'GOODS' | 'SERVICE'; description: string; unit: string; quantity: string; unitPrice: string; taxRate?: string | null }[] }

/** Sipariş formu seçenekleri: imza durumu hesaplanmaz, tek sorgu. Sınır aşılırsa form "sözleşme yok" dememek için `truncated` görür (D88). */
export async function contractOptions(tx: Tx, limit = 2000) {
  const rows = (await tx.query<{ id: string; companyId: string; title: string; supplierRootIds: string[] }>(
    `SELECT cv.id, cv.company_id AS "companyId", f.title, ${CONTRACT_SUPPLIER_ROOTS_SQL} AS "supplierRootIds"
     FROM contract_versions cv JOIN contract_families f ON f.id = cv.family_id WHERE cv.superseded_by_id IS NULL ORDER BY cv.created_at DESC LIMIT $1`, [limit + 1])).rows;
  return { items: rows.slice(0, limit), truncated: rows.length > limit };
}

export async function createPo(tx: Tx, ctx: TenantContext, b: PoInput) {
  if (!ctx.companyIds.includes(b.companyId)) throw forbidden('company');
  const s = (await tx.query<{ status: string; legal_name: string }>(`SELECT status, legal_name FROM suppliers WHERE id = $1`, [b.supplierId])).rows[0];
  if (!s) throw notFound();
  if (s.status !== 'ACTIVE') throw unprocessable('supplier_not_active', `${s.legal_name} aktif tedarikçi değil; sipariş verilemez (BR02).`);
  const block = (await criticalBlocks(tx, [b.supplierId])).get(b.supplierId);
  if (block) throw unprocessable('critical_blocker', `${s.legal_name}: ${block}`);
  for (const l of b.lines) if (!isDecimal(l.quantity) || !isDecimal(l.unitPrice) || Number(l.quantity) <= 0) throw unprocessable('invalid_number', 'Miktar ve birim fiyat ondalık sayı olmalı.');
  let total = add(...b.lines.map((l) => amount(l.quantity, l.unitPrice)));
  requireTaxRates(b.lines, false);
  if (b.projectId) {
    // Proje bağı kategori toleransını belirler: yalnız aynı şirketin, seçim kararı onaylanmış projesi bağlanabilir.
    const pr = (await tx.query<{ company_id: string; status: string }>(`SELECT company_id, status FROM projects WHERE id = $1`, [b.projectId])).rows[0];
    if (!pr) throw notFound();
    // v2 Faz 7 (R5): tamamlanan proje de seçim kararı onaylanmış projedir (sipariş bağlanabilir kalır).
    if (pr.company_id !== b.companyId || !['CONTRACTING', 'COMPLETED'].includes(pr.status)) throw unprocessable('project_not_awarded', 'Sipariş yalnız aynı şirketin, seçim kararı onaylanmış projesine bağlanabilir.');
  }
  if (b.contractVersionId) {
    await lockContracts(tx, [b.contractVersionId]);
    const c = await contractState(tx, b.contractVersionId, null);
    if (!c) throw notFound();
    // Şirketler arası sözleşme kullanımı için yetki mekanizması yok; limit yalnız sözleşmenin kendi şirketinden tüketilir (D86).
    const owner = (await tx.query<{ company_id: string }>(`SELECT company_id FROM contract_versions WHERE id = $1`, [b.contractVersionId])).rows[0]!;
    if (owner.company_id !== b.companyId) throw unprocessable('contract_company_mismatch', `${c.title} başka bir şirkete ait; bu şirket adına sipariş açılamaz.`);
    // Tedarikçisi kayıtlı olmayan sözleşme denetlenmez. Limit bu sözleşmeden düşeceği için başka firmanın siparişi bağlanamaz.
    if (c.supplierRootIds?.length && !c.supplierRootIds.includes(b.supplierId)) throw unprocessable('contract_supplier_mismatch', `${c.title} sözleşmesinde ${s.legal_name} tedarikçi tarafı değil; bu sözleşmeye sipariş açılamaz.`);
    const gross = c.limitBasis === 'GROSS';
    requireTaxRates(b.lines, gross);
    const committed = add(...b.lines.map((l) => poAmount(l.quantity, l.unitPrice, l.taxRate, gross)));
    // Sipariş açık taahhüttür: tavanı aşan sipariş verilemez (BR07). Vergi dahil limitte KDV dahil tutarla.
    if (c.ceiling !== null) {
      const avail = availableLimit(c.ceiling, c.netConsumption, c.openCommitment);
      if (cmp(committed, dec(avail)) > 0) throw unprocessable('limit_exceeded', `${c.title}: kullanılabilir limit${gross ? ' (vergi dahil)' : ''} ${avail} ${c.currency}, sipariş ${str(committed)}.`, { available: avail });
    }
  }
  total = add(...b.lines.map((l) => amount(l.quantity, l.unitPrice)));
  const code = await nextCode(tx, ctx, 'po', 'PO');
  const po = (await tx.query<{ id: string }>(`INSERT INTO purchase_orders (tenant_id, company_id, code, supplier_id, contract_version_id, project_id, currency, issued_by)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`, [ctx.tenantId, b.companyId, code, b.supplierId, b.contractVersionId ?? null, b.projectId ?? null, b.currency, ctx.userId])).rows[0]!;
  let n = 0;
  for (const l of b.lines) {
    await tx.query(`INSERT INTO po_lines (tenant_id, company_id, po_id, line_no, kind, description, unit, quantity, unit_price, tax_rate) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [ctx.tenantId, b.companyId, po.id, ++n, l.kind, l.description.trim(), l.unit.trim(), l.quantity, l.unitPrice, l.taxRate || null]);
  }
  await audit(tx, ctx, 'po.issued', 'purchase_order', po.id, { code, total: str(total), contractVersionId: b.contractVersionId ?? null });
  return { id: po.id, code };
}

async function poLineStates(tx: Tx, poLineIds: string[], excludeInvoiceId: string | null): Promise<PoLineState[]> {
  if (!poLineIds.length) return [];
  return (await tx.query<PoLineState>(`SELECT pl.id AS "poLineId", pl.description, pl.unit, po.currency, pl.kind, po.status AS "poStatus", trim_scale(pl.quantity)::text AS "orderedQty",
      (SELECT ${SUPPLIER_ROOT_SQL} FROM suppliers s WHERE s.id = po.supplier_id) AS "supplierRootId", po.company_id AS "companyId",
      trim_scale(pl.unit_price)::text AS "unitPrice", po.contract_version_id AS "contractVersionId", pr.category, trim_scale(pl.tax_rate)::text AS "taxRate",
      coalesce((SELECT trim_scale(sum(r.quantity)) FROM receipts r WHERE r.po_line_id = pl.id), 0)::text AS "receivedQty",
      coalesce((SELECT trim_scale(sum(CASE i.kind WHEN 'CREDIT_NOTE' THEN -a.quantity ELSE a.quantity END)) FROM invoice_allocations a JOIN invoices i ON i.id = a.invoice_id
        WHERE a.po_line_id = pl.id AND i.kind <> 'ADVANCE' AND ${APPROVED} AND ($2::uuid IS NULL OR i.id <> $2)), 0)::text AS "invoicedQty",
      coalesce((SELECT sum(CASE i.kind WHEN 'CREDIT_NOTE' THEN -a.amount ELSE a.amount END) FROM invoice_allocations a JOIN invoices i ON i.id = a.invoice_id
        WHERE a.po_line_id = pl.id AND i.kind <> 'ADVANCE' AND ${APPROVED} AND ($2::uuid IS NULL OR i.id <> $2)), 0)::numeric(20,2)::text AS "invoicedAmount"
    FROM po_lines_current pl JOIN purchase_orders po ON po.id = pl.po_id LEFT JOIN projects pr ON pr.id = po.project_id WHERE pl.id = ANY($1::uuid[])`, [poLineIds, excludeInvoiceId])).rows;
}

export async function recordReceipt(tx: Tx, ctx: TenantContext, poLineId: string, b: { quantity: string; periodFrom?: string | null; periodTo?: string | null; note: string }, idempotencyKey?: string) {
  if (!isDecimal(b.quantity) || Number(b.quantity) <= 0) throw unprocessable('invalid_number', 'Kabul miktarı pozitif olmalı.');
  await lockPosOfLines(tx, [poLineId]);
  const bodyHash = idempotencyKey ? sha(JSON.stringify([poLineId, b.quantity, b.periodFrom ?? null, b.periodTo ?? null, b.note.trim()])) : null;
  // Yanıtı kaybolan istek tekrar gelirse ikinci kabul açılmaz: aynı anahtarla önceki kayıt döner.
  if (idempotencyKey) {
    const prev = (await tx.query<{ id: string; idempotency_hash: string | null }>(`SELECT id, idempotency_hash FROM receipts WHERE idempotency_key = $1`, [idempotencyKey])).rows[0];
    if (prev) {
      if (prev.idempotency_hash !== bodyHash) throw conflict('idempotency_mismatch', 'Aynı istek anahtarı farklı bir kabul için kullanıldı; ekranı yenileyip yeni kayıt açın.');
      return { id: prev.id, duplicate: true };
    }
  }
  const [pl] = await poLineStates(tx, [poLineId], null);
  if (!pl) throw notFound();
  if (pl.poStatus !== 'OPEN') throw conflict('po_not_open', 'Sipariş kapatıldı veya iptal edildi; yeni kabul kaydedilemez.');
  if (cmp(dec(pl.receivedQty) + dec(b.quantity), dec(pl.orderedQty)) > 0) throw unprocessable('over_receipt', `Toplam kabul sipariş miktarını (${pl.orderedQty} ${pl.unit}) aşamaz; şimdiye kadar kabul edilen ${pl.receivedQty} ${pl.unit}.`);
  if (pl.kind === 'SERVICE' && (!b.periodFrom || !b.periodTo)) throw unprocessable('period_required', 'Hizmet kabulü dönem (başlangıç–bitiş) ile kaydedilir.');
  const company = (await tx.query<{ company_id: string }>(`SELECT company_id FROM po_lines WHERE id = $1`, [poLineId])).rows[0]!.company_id;
  const r = (await tx.query<{ id: string }>(`INSERT INTO receipts (tenant_id, company_id, po_line_id, quantity, period_from, period_to, note, recorded_by, idempotency_key, idempotency_hash)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`, [ctx.tenantId, company, poLineId, b.quantity, b.periodFrom ?? null, b.periodTo ?? null, b.note.trim(), ctx.userId, idempotencyKey ?? null, bodyHash])).rows[0]!;
  await closeTasks(tx, `receipt-needed:${poLineId}`);
  await audit(tx, ctx, 'receipt.recorded', 'po_line', poLineId, { receiptId: r.id, quantity: b.quantity });
  return { id: r.id };
}

/** Ters kabul: özgün kayda bağlı negatif kayıt. Kabul düşürülürken önceden faturalanmış miktarın altına inemez. */
export async function reverseReceipt(tx: Tx, ctx: TenantContext, receiptId: string, b: { quantity: string; note: string }) {
  const orig = (await tx.query<{ po_line_id: string; quantity: string; company_id: string }>(`SELECT po_line_id, quantity::text, company_id FROM receipts WHERE id = $1 AND quantity > 0`, [receiptId])).rows[0];
  if (!orig) throw notFound();
  if (!isDecimal(b.quantity) || Number(b.quantity) <= 0) throw unprocessable('invalid_number', 'Ters kabul miktarı pozitif yazılır.');
  await lockPosOfLines(tx, [orig.po_line_id]);
  const already = dec((await tx.query<{ v: string }>(`SELECT trim_scale(coalesce(-sum(quantity), 0))::text AS v FROM receipts WHERE reverses_id = $1`, [receiptId])).rows[0]!.v);
  if (cmp(already + dec(b.quantity), dec(trimNum(orig.quantity))) > 0) throw unprocessable('over_reversal', 'Ters kabul özgün kabul miktarını aşamaz.');
  const [pl] = await poLineStates(tx, [orig.po_line_id], null);
  if (cmp(dec(pl!.receivedQty) - dec(b.quantity), dec(pl!.invoicedQty)) < 0) {
    throw unprocessable('receipt_already_invoiced', `Bu miktar faturalanmış (${pl!.invoicedQty} ${pl!.unit}); önce iade/alacak belgesi gerekir.`);
  }
  const r = (await tx.query<{ id: string }>(`INSERT INTO receipts (tenant_id, company_id, po_line_id, quantity, reverses_id, note, recorded_by)
    VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`, [ctx.tenantId, orig.company_id, orig.po_line_id, `-${b.quantity}`, receiptId, b.note.trim(), ctx.userId])).rows[0]!;
  await audit(tx, ctx, 'receipt.reversed', 'po_line', orig.po_line_id, { receiptId: r.id, reverses: receiptId, quantity: b.quantity }, b.note);
  return { id: r.id };
}

export interface PoChangeInput {
  /** İstemcinin gördüğü son değişiklik no; arada başka değişiklik olduysa 409 (kayıp güncelleme yok). */
  baseChangeNo: number; reason: string;
  lines: { poLineId: string; quantity: string; unitPrice: string }[];
  add?: PoInput['lines'];
}

async function lockPo(tx: Tx, poId: string) {
  await tx.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`po:${poId}`]);
  const po = (await tx.query<{ id: string; company_id: string; status: string; contract_version_id: string | null; currency: string; code: string }>(
    `SELECT id, company_id, status, contract_version_id, currency, code FROM purchase_orders WHERE id = $1`, [poId])).rows[0];
  if (!po) throw notFound();
  if (po.contract_version_id) await lockContracts(tx, [po.contract_version_id]);
  const changeNo = Number((await tx.query<{ n: number | null }>(`SELECT max(change_no) AS n FROM po_changes WHERE po_id = $1`, [poId])).rows[0]!.n ?? 0);
  const ids = (await tx.query<{ id: string }>(`SELECT id FROM po_lines WHERE po_id = $1 ORDER BY line_no`, [poId])).rows.map((r) => r.id);
  return { po, changeNo, lines: await poLineStates(tx, ids, null) };
}


/**
 * Sipariş değişikliği: kalem miktarı/fiyatı ve yeni kalem; özgün kalem değişmez, revizyon eklenir (BR11).
 * Miktar kabul edilen veya faturalanan miktarın altına inemez; faturalanmış kalemin fiyatı değişmez.
 * Sözleşmeli siparişte artış limit kilidi altında kontrol edilir (BR07).
 */
export async function changePo(tx: Tx, ctx: TenantContext, poId: string, b: PoChangeInput) {
  if (b.reason.trim().length < 10) throw unprocessable('reason_required', 'Değişiklik gerekçesi gerekli (en az 10 karakter).');
  const { po, changeNo, lines } = await lockPo(tx, poId);
  if (po.status !== 'OPEN') throw conflict('po_not_open', 'Kapatılmış veya iptal edilmiş sipariş değiştirilemez.');
  if (b.baseChangeNo !== changeNo) throw conflict('stale_po', 'Sipariş siz düzenlerken değişti; güncel hali yükleyip tekrar deneyin.');
  const added = b.add ?? [];
  for (const x of [...b.lines, ...added]) if (!isDecimal(x.quantity) || !isDecimal(x.unitPrice) || Number(x.quantity) <= 0 || Number(x.unitPrice) < 0) throw unprocessable('invalid_number', 'Miktar pozitif, birim fiyat sıfır veya pozitif ondalık olmalı.');
  const changed: { lineNo: number; poLineId: string; description: string; before: { quantity: string; unitPrice: string }; after: { quantity: string; unitPrice: string } }[] = [];
  const cs = po.contract_version_id ? await contractState(tx, po.contract_version_id, null) : null;
  const gross = cs?.limitBasis === 'GROSS';
  requireTaxRates(added, gross);
  let delta = 0n;
  for (const x of b.lines) {
    const l = lines.find((y) => y.poLineId === x.poLineId);
    if (!l) throw unprocessable('line_not_in_po', 'Kalem bu siparişe ait değil.');
    const priceChanged = cmp(dec(x.unitPrice), dec(l.unitPrice)) !== 0;
    if (cmp(dec(x.quantity), dec(l.orderedQty)) === 0 && !priceChanged) continue;
    const floor = dec(l.receivedQty) > dec(l.invoicedQty) ? l.receivedQty : l.invoicedQty;
    if (cmp(dec(x.quantity), dec(floor)) < 0) throw unprocessable('below_consumed', `"${l.description}": miktar kabul edilen/faturalanan miktarın (${floor} ${l.unit}) altına inemez.`);
    if (priceChanged && dec(l.invoicedQty) !== 0n) throw unprocessable('price_locked', `"${l.description}" faturalandı; fiyatı değişmez. Yeni fiyat için yeni kalem ekleyin.`);
    delta += poAmount(x.quantity, x.unitPrice, l.taxRate, gross) - poAmount(l.orderedQty, l.unitPrice, l.taxRate, gross);
    changed.push({ lineNo: 0, poLineId: l.poLineId, description: l.description, before: { quantity: l.orderedQty, unitPrice: l.unitPrice }, after: { quantity: x.quantity, unitPrice: x.unitPrice } });
  }
  for (const x of added) delta += poAmount(x.quantity, x.unitPrice, x.taxRate, gross);
  if (!changed.length && !added.length) throw unprocessable('no_change', 'Değişiklik yok.');
  if (cs && delta > 0n && cs.ceiling != null) {
    const avail = availableLimit(cs.ceiling, cs.netConsumption, cs.openCommitment);
    if (cmp(delta, dec(avail)) > 0) throw unprocessable('limit_exceeded', `${cs.title}: kullanılabilir limit${gross ? ' (vergi dahil)' : ''} ${avail} ${cs.currency}, değişiklik +${str(delta)}.`, { available: avail });
  }
  const no = changeNo + 1;
  const lineNos = (await tx.query<{ id: string; line_no: number }>(`SELECT id, line_no FROM po_lines WHERE po_id = $1`, [poId])).rows;
  for (const c of changed) c.lineNo = lineNos.find((r) => r.id === c.poLineId)!.line_no;
  const details = { changed, added: added.map((x) => ({ description: x.description, quantity: x.quantity, unit: x.unit, unitPrice: x.unitPrice })), delta: str(delta) };
  const ch = (await tx.query<{ id: string }>(`INSERT INTO po_changes (tenant_id, company_id, po_id, change_no, kind, reason, details, changed_by) VALUES ($1,$2,$3,$4,'CHANGE',$5,$6,$7) RETURNING id`,
    [ctx.tenantId, po.company_id, poId, no, b.reason.trim(), details, ctx.userId])).rows[0]!;
  for (const c of changed) {
    await tx.query(`INSERT INTO po_line_revisions (tenant_id, company_id, po_line_id, change_id, change_no, quantity, unit_price) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [ctx.tenantId, po.company_id, c.poLineId, ch.id, no, c.after.quantity, c.after.unitPrice]);
  }
  let n = Math.max(0, ...lineNos.map((r) => r.line_no));
  for (const l of added) {
    await tx.query(`INSERT INTO po_lines (tenant_id, company_id, po_id, line_no, kind, description, unit, quantity, unit_price, added_by_change_id, tax_rate) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [ctx.tenantId, po.company_id, poId, ++n, l.kind, l.description.trim(), l.unit.trim(), l.quantity, l.unitPrice, ch.id, l.taxRate || null]);
  }
  await audit(tx, ctx, 'po.changed', 'purchase_order', poId, { changeNo: no, ...details }, b.reason);
  return { changeNo: no, delta: str(delta) };
}

/**
 * Kapatma/iptal: hiç kabul ve onaylı fatura yoksa sipariş iptal edilir (açık taahhüt sıfır). Tüketim varsa sipariş kapatılır:
 * her kalem kabul edilen/faturalanan miktara iner, kalan taahhüt serbest kalır. Kayıtlar silinmez.
 */
export async function closePo(tx: Tx, ctx: TenantContext, poId: string, b: { baseChangeNo: number; reason: string }) {
  if (b.reason.trim().length < 10) throw unprocessable('reason_required', 'Kapatma/iptal gerekçesi gerekli (en az 10 karakter).');
  const { po, changeNo, lines } = await lockPo(tx, poId);
  if (po.status !== 'OPEN') throw conflict('po_not_open', 'Sipariş zaten kapatıldı veya iptal edildi.');
  if (b.baseChangeNo !== changeNo) throw conflict('stale_po', 'Sipariş siz düzenlerken değişti; güncel hali yükleyip tekrar deneyin.');
  const consumed = lines.map((l) => ({ l, q: dec(l.receivedQty) > dec(l.invoicedQty) ? dec(l.receivedQty) : dec(l.invoicedQty) }));
  const pending = Number((await tx.query<{ n: number }>(`SELECT count(DISTINCT a.invoice_id)::int AS n FROM invoice_allocations a JOIN invoices i ON i.id = a.invoice_id
    WHERE a.po_line_id = ANY($1::uuid[]) AND NOT EXISTS (SELECT 1 FROM invoice_decisions d WHERE d.invoice_id = i.id AND d.kind IN ('APPROVAL','REJECTION'))`, [lines.map((l) => l.poLineId)])).rows[0]!.n);
  // Karar bekleyen fatura bu kalemlere bağlıysa taahhüt serbest bırakılmaz: önce fatura karara bağlanır veya tahsisi değişir.
  if (pending > 0) throw conflict('pending_invoices', `Bu siparişe bağlı ${pending} karar bekleyen fatura var; önce onaylanmalı, reddedilmeli veya tahsisi değiştirilmeli.`, { pendingInvoices: pending });
  const kind = consumed.every((x) => x.q <= 0n) ? 'CANCEL' : 'CLOSE';
  const released = add(...consumed.map((x) => amount(str(dec(x.l.orderedQty) - x.q, 6), x.l.unitPrice)));
  const no = changeNo + 1;
  const details = { released: str(released), pendingInvoices: pending,
    lines: consumed.map((x) => ({ description: x.l.description, before: x.l.orderedQty, after: kind === 'CANCEL' ? '0' : str(x.q, 6) })) };
  const ch = (await tx.query<{ id: string }>(`INSERT INTO po_changes (tenant_id, company_id, po_id, change_no, kind, reason, details, changed_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
    [ctx.tenantId, po.company_id, poId, no, kind, b.reason.trim(), details, ctx.userId])).rows[0]!;
  if (kind === 'CLOSE') {
    for (const x of consumed) if (x.q < dec(x.l.orderedQty)) {
      await tx.query(`INSERT INTO po_line_revisions (tenant_id, company_id, po_line_id, change_id, change_no, quantity, unit_price) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [ctx.tenantId, po.company_id, x.l.poLineId, ch.id, no, str(x.q, 6), x.l.unitPrice]);
    }
  }
  await tx.query(`UPDATE purchase_orders SET status = $2, cancel_reason = $3 WHERE id = $1`, [poId, kind === 'CANCEL' ? 'CANCELLED' : 'CLOSED', b.reason.trim()]);
  await audit(tx, ctx, kind === 'CANCEL' ? 'po.cancelled' : 'po.closed', 'purchase_order', poId, { changeNo: no, ...details }, b.reason);
  return { status: kind === 'CANCEL' ? 'CANCELLED' : 'CLOSED', released: str(released), pendingInvoices: pending };
}

export async function listPos(tx: Tx) {
  return (await tx.query(`SELECT po.id, po.code, po.currency, po.status, po.issued_at AS "issuedAt", s.legal_name AS "supplierName", ${SUPPLIER_ROOT_SQL} AS "supplierRootId", po.company_id AS "companyId", f.title AS "contractTitle",
      (SELECT round(sum(quantity * unit_price), 2)::text FROM po_lines_current WHERE po_id = po.id) AS total
    FROM purchase_orders po JOIN suppliers s ON s.id = po.supplier_id LEFT JOIN contract_versions cv ON cv.id = po.contract_version_id
    LEFT JOIN contract_families f ON f.id = cv.family_id ORDER BY po.issued_at DESC LIMIT 200`)).rows;
}

export async function getPo(tx: Tx, id: string) {
  const po = (await tx.query(`SELECT po.id, po.code, po.currency, po.status, po.cancel_reason AS "closeReason", po.issued_at AS "issuedAt", po.supplier_id AS "supplierId", s.legal_name AS "supplierName",
      po.contract_version_id AS "contractVersionId", f.title AS "contractTitle", u.display_name AS "issuedBy"
    FROM purchase_orders po JOIN suppliers s ON s.id = po.supplier_id JOIN users u ON u.id = po.issued_by
    LEFT JOIN contract_versions cv ON cv.id = po.contract_version_id LEFT JOIN contract_families f ON f.id = cv.family_id WHERE po.id = $1`, [id])).rows[0];
  if (!po) throw notFound();
  const ids = (await tx.query<{ id: string }>(`SELECT id FROM po_lines WHERE po_id = $1 ORDER BY line_no`, [id])).rows.map((r) => r.id);
  const states = await poLineStates(tx, ids, null);
  const receipts = (await tx.query(`SELECT r.id, r.po_line_id AS "poLineId", trim_scale(r.quantity)::text AS quantity, r.period_from::text AS "periodFrom", r.period_to::text AS "periodTo",
      r.reverses_id AS "reversesId", r.note, r.recorded_at AS "recordedAt", u.display_name AS "recordedBy"
    FROM receipts r JOIN users u ON u.id = r.recorded_by WHERE r.po_line_id = ANY($1::uuid[]) ORDER BY r.recorded_at`, [ids])).rows;
  const rev = (await tx.query<{ id: string; originalQty: string; originalUnitPrice: string; revision: number; addedByChange: boolean }>(`SELECT c.id, trim_scale(c.original_quantity)::text AS "originalQty",
      trim_scale(c.original_unit_price)::text AS "originalUnitPrice", c.revision, pl.added_by_change_id IS NOT NULL AS "addedByChange"
    FROM po_lines_current c JOIN po_lines pl ON pl.id = c.id WHERE c.po_id = $1`, [id])).rows;
  const changes = (await tx.query(`SELECT c.change_no AS "changeNo", c.kind, c.reason, c.details, c.changed_at AS "changedAt", u.display_name AS "changedBy"
    FROM po_changes c JOIN users u ON u.id = c.changed_by WHERE c.po_id = $1 ORDER BY c.change_no`, [id])).rows;
  return {
    po, receipts, changes, changeNo: changes.length ? changes[changes.length - 1].changeNo : 0,
    lines: ids.map((i) => ({ ...states.find((s) => s.poLineId === i)!, ...(({ id: _, ...r }) => r)(rev.find((r) => r.id === i)!) })),
  };
}

// --- Fatura -----------------------------------------------------------------------------------

export interface InvoiceInput {
  companyId: string; supplierId: string; kind: 'INVOICE' | 'CREDIT_NOTE' | 'ADVANCE'; invoiceNo: string; ettn?: string | null; issueDate: string; currency: string;
  documentVersionId?: string | null; originalInvoiceId?: string | null;
  lines: { description: string; quantity: string; unit: string; unitPrice: string; netAmount: string; taxRate?: string; taxAmount?: string | null; otherTax?: string | null; otherTaxes?: OtherTax[] | null }[];
  /** Belgede yazan toplamlar; kontrol satırlardan hesaplananla karşılaştırır. */
  declaredTaxTotal?: string | null; declaredWithholding?: string | null; declaredPayable?: string | null; declaredOtherTaxTotal?: string | null;
  /** Yalnız sunucu içi (e-Fatura yükleyen tek departmanlı Departman kullanıcısı, D98); istek gövdesinden alınmaz. */
  departmentId?: string | null;
  /** v2 Faz 7 (R2): ERP sözleşme/sipariş referansı (≤60, isteğe bağlı); otomatik eşleştirmenin ilk adımı. */
  erpContractRef?: string | null; erpOrderRef?: string | null;
  /** Yalnız sunucu içi: referans kaynağı (058a). İstekten/e-Faturadan gelen MANUAL, Faz 8 ERP girişi ERP yazar. */
  erpRefSource?: 'ERP' | 'MANUAL';
}

/** Fatura girişi: aynı tedarikçi için aynı ETTN veya fatura no ikinci mali kayıt açmaz; tekrar izi tutulur (T17). */
export async function createInvoice(tx: Tx, ctx: TenantContext, b: InvoiceInput, source = 'manual'): Promise<{ id: string; duplicate: boolean; match?: AutoMatchResult }> {
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
    const o = (await tx.query<{ company_id: string; supplier_id: string; kind: string }>(`SELECT company_id, supplier_id, kind FROM invoices WHERE id = $1`, [b.originalInvoiceId ?? null])).rows[0];
    if (!o || o.company_id !== b.companyId || o.supplier_id !== b.supplierId || o.kind !== 'INVOICE') throw unprocessable('original_required', 'İade/alacak belgesi aynı şirket ve tedarikçinin özgün faturasına bağlanır.');
  }
  for (const l of b.lines) {
    if (![l.quantity, l.unitPrice, l.netAmount, l.taxRate ?? '0', ...(l.taxAmount ? [l.taxAmount] : []), ...(l.otherTax ? [l.otherTax] : [])].every(isDecimal) || [l.taxAmount, l.otherTax].some((x) => x && dec(x) < 0n)) throw unprocessable('invalid_number', 'Satır tutarları ondalık sayı olmalı.');
    for (const t of l.otherTaxes ?? []) if (!isDecimal(t.amount) || dec(t.amount) < 0n || (t.rate != null && t.rate !== '' && !isDecimal(t.rate))) throw unprocessable('invalid_number', `"${l.description}": KDV dışı vergi oranı/tutarı ondalık sayı olmalı.`);
    if (source !== 'einvoice' && cmp(absDec(mul(dec(l.quantity), dec(l.unitPrice)) - dec(l.netAmount)), dec('0.01')) > 0) throw unprocessable('line_total_mismatch', `"${l.description}": miktar × birim fiyat satır tutarına eşit değil.`);
  }
  for (const v of [b.declaredTaxTotal, b.declaredWithholding, b.declaredPayable, b.declaredOtherTaxTotal]) if (v != null && (!isDecimal(v) || dec(v) < 0n)) throw unprocessable('invalid_number', 'Belge toplamları sıfır veya pozitif ondalık olmalı.');
  const contractRef = b.erpContractRef?.trim() || null;
  const orderRef = b.erpOrderRef?.trim() || null;
  if ((contractRef?.length ?? 0) > 60 || (orderRef?.length ?? 0) > 60) throw unprocessable('invalid_reference', 'ERP sözleşme ve sipariş referansı en fazla 60 karakter olabilir.');
  const refSource = b.erpRefSource ?? 'MANUAL';
  const inv = (await tx.query<{ id: string }>(`INSERT INTO invoices (tenant_id, company_id, supplier_id, kind, invoice_no, ettn, issue_date, currency, document_version_id, original_invoice_id, created_by,
      declared_tax_total, declared_withholding, declared_payable, declared_other_tax_total, department_id, erp_contract_ref, erp_order_ref, erp_contract_ref_source, erp_order_ref_source)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20) RETURNING id`, [ctx.tenantId, b.companyId, b.supplierId, b.kind, b.invoiceNo.trim(), b.ettn ?? null, b.issueDate,
    b.currency, b.documentVersionId ?? null, b.originalInvoiceId ?? null, ctx.userId, b.declaredTaxTotal ?? null, b.declaredWithholding ?? null, b.declaredPayable ?? null, b.declaredOtherTaxTotal ?? null,
    b.departmentId ?? null, contractRef, orderRef, contractRef ? refSource : null, orderRef ? refSource : null])).rows[0]!;
  let n = 0;
  for (const l of b.lines) {
    // Vergi kalemleri verildiyse satırın KDV dışı toplamı onlardan (beyan edilen toplam ayrıca verildiyse kontrol karşılaştırır).
    const parts = l.otherTaxes?.length ? l.otherTaxes.map((t) => ({ code: t.code ?? null, name: t.name ?? null, rate: t.rate || null, amount: t.amount })) : null;
    const otherSum = l.otherTax || (parts ? str(add(...parts.map((t) => dec(t.amount)))) : null);
    await tx.query(`INSERT INTO invoice_lines (tenant_id, company_id, invoice_id, line_no, description, quantity, unit, unit_price, net_amount, tax_rate, tax_amount, other_tax_amount, other_taxes) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
      [ctx.tenantId, b.companyId, inv.id, ++n, l.description.trim(), l.quantity, l.unit.trim(), l.unitPrice, l.netAmount, l.taxRate ?? '20', l.taxAmount || null, otherSum, parts ? JSON.stringify(parts) : null]);
  }
  await tx.query(`INSERT INTO invoice_intake_events (tenant_id, company_id, invoice_id, source, duplicate, received_by) VALUES ($1,$2,$3,$4,false,$5)`, [ctx.tenantId, b.companyId, inv.id, source, ctx.userId]);
  await audit(tx, ctx, 'invoice.received', 'invoice', inv.id, { kind: b.kind, invoiceNo: b.invoiceNo, lines: b.lines.length,
    ...(contractRef || orderRef ? { erpContractRef: contractRef, erpOrderRef: orderRef } : {}) });
  // v2 Faz 7 (R2): yeni fatura (auto_match varsayılan true) kayıtla aynı işlemde otomatik eşleştirilir.
  const match = await autoMatchInvoice(tx, ctx, inv.id);
  return { id: inv.id, duplicate: false, match };
}

async function finalDecision(tx: Tx, invoiceId: string) {
  return (await tx.query<{ kind: string }>(`SELECT kind FROM invoice_decisions WHERE invoice_id = $1 AND kind IN ('APPROVAL','REJECTION')`, [invoiceId])).rows[0]?.kind ?? null;
}

export async function setAllocations(tx: Tx, ctx: TenantContext, invoiceId: string, b: { allocations: AllocationInput[]; advanceOffset?: string; advanceInvoiceId?: string | null }) {
  const inv = (await tx.query<{ company_id: string; kind: string; supplier_id: string }>(`SELECT company_id, kind, supplier_id FROM invoices WHERE id = $1`, [invoiceId])).rows[0];
  if (!inv) throw notFound();
  if (await finalDecision(tx, invoiceId)) throw conflict('invoice_decided', 'Karar verilmiş faturanın tahsisi değişmez; iade/alacak belgesi kullanın.');
  for (const a of b.allocations) if (!isDecimal(a.quantity) || !isDecimal(a.amount) || Number(a.amount) <= 0) throw unprocessable('invalid_number', 'Tahsis miktarı ve tutarı pozitif olmalı.');
  // v2 Faz 7: sözleşmeye bağlı faturada tahsis — elle bağ 409 invoice_matched; otomatik bağ aynı işlemde gerekçeli kaldırılır.
  const unlinkedFamily = await releaseLinkForAllocation(tx, ctx, invoiceId, b.allocations.length > 0);
  // Tahsisli fatura eşleştirme kuyruğunun dışındadır (R2/R3: otomatik eşleştirme ve elle bağlama tahsisliye yapılmaz); kuyruk görevi kapanır.
  if (b.allocations.length > 0) await closeTasks(tx, `invoice-unmatched:${invoiceId}`);
  // v2 Faz 1 (D93): siparişler kalktı; yeni sipariş bağı kurulamaz. Faturanın mevcut eski (v1) sipariş bağı korunabilir veya kaldırılabilir.
  const linked = new Set((await tx.query<{ id: string }>(`SELECT DISTINCT po_line_id AS id FROM invoice_allocations WHERE invoice_id = $1 AND po_line_id IS NOT NULL`, [invoiceId])).rows.map((r) => r.id));
  if (b.allocations.some((a) => a.poLineId && !linked.has(a.poLineId))) {
    throw unprocessable('po_link_removed', 'Siparişler kaldırıldı; faturaya yeni sipariş bağı eklenemez. Satırı bir sözleşmeye tahsis edin; mevcut eski sipariş bağı korunabilir veya kaldırılabilir.');
  }
  if (b.advanceInvoiceId) {
    const adv = (await tx.query(`SELECT 1 FROM invoices i WHERE i.id = $1 AND i.kind = 'ADVANCE' AND i.supplier_id = $2 AND i.company_id = $3 AND ${APPROVED}`, [b.advanceInvoiceId, inv.supplier_id, inv.company_id])).rowCount;
    if (!adv) throw unprocessable('advance_invalid', 'Mahsup için aynı şirket ve tedarikçinin onaylı avans faturası seçilmeli.');
  }
  await tx.query(`DELETE FROM invoice_allocations WHERE invoice_id = $1`, [invoiceId]);
  for (const a of b.allocations) {
    await tx.query(`INSERT INTO invoice_allocations (tenant_id, company_id, invoice_id, line_no, po_line_id, contract_version_id, quantity, amount, created_by)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`, [ctx.tenantId, inv.company_id, invoiceId, a.lineNo, a.poLineId, a.contractVersionId, a.quantity, a.amount, ctx.userId]);
  }
  await tx.query(`UPDATE invoices SET advance_offset = $2, advance_invoice_id = $3 WHERE id = $1`, [invoiceId, b.advanceOffset ?? '0', b.advanceInvoiceId ?? null]);
  const departmentId = await inheritDepartment(tx, invoiceId);
  // Departmanı değişen faturanın görevleri yeni departmanı izler (düzeltme dalgası).
  if (departmentId !== undefined) await rederiveTaskDepartments(tx, `t.entity_type = 'invoice' AND t.entity_id = $1`, [invoiceId]);
  const result = await evaluate(tx, invoiceId);
  // Atılan hata işlemi geri alır; önceki tahsis yerinde kalır.
  if (result.check.issues.some((x) => x.code === 'COMPANY_MISMATCH')) throw unprocessable('allocation_company_mismatch', 'Seçilen sipariş veya sözleşme bu faturanın şirketine ait değil ya da erişiminiz dışında.');
  if (result.check.issues.some((x) => x.code === 'SUPPLIER_MISMATCH')) throw unprocessable('allocation_supplier_mismatch', 'Seçilen sipariş veya sözleşme bu faturanın tedarikçisine ait değil; aynı ünvanlı başka bir kayıt olabilir.');
  await audit(tx, ctx, 'invoice.allocated', 'invoice', invoiceId, { allocations: b.allocations.length, advanceOffset: b.advanceOffset ?? '0',
    ...(departmentId !== undefined ? { departmentId } : {}), ...(unlinkedFamily ? { unlinkedFamilyId: unlinkedFamily } : {}) });
  // v2 Faz 7 (R4): tahsisle türeyen fatura da kullanıma sayılır; ilk aşımda bir kez bildirim.
  await overrunCheckForInvoice(tx, ctx, invoiceId);
  return result;
}

/**
 * v2 (analiz-v2 §2.3): fatura departmanını eşleştiği sözleşmeden devralır (doğrudan sözleşme tahsisi ya da sözleşmeli sipariş kalemi).
 * Tüm sözleşmeler aynı departmandaysa o departman; farklıysa tahmin yok, departman boş. Sözleşmesiz tahsiste departman değişmez.
 * Tahsisle aynı transaction'da yazılır. Dönüş: yazılan departman (değişmediyse undefined).
 */
export async function inheritDepartment(tx: Tx, invoiceId: string): Promise<string | null | undefined> {
  const deps = (await tx.query<{ d: string | null }>(`SELECT DISTINCT f.department_id AS d FROM invoice_allocations a
      LEFT JOIN po_lines pl ON pl.id = a.po_line_id LEFT JOIN purchase_orders po ON po.id = pl.po_id
      JOIN contract_versions cv ON cv.id = coalesce(a.contract_version_id, po.contract_version_id) JOIN contract_families f ON f.id = cv.family_id
    WHERE a.invoice_id = $1`, [invoiceId])).rows;
  if (!deps.length) return undefined;
  const departmentId = deps.length === 1 ? deps[0]!.d : null;
  await tx.query(`UPDATE invoices SET department_id = $2 WHERE id = $1`, [invoiceId, departmentId]);
  return departmentId;
}

/** Kontrol girdisini güncel veriden kurar ve domain kontrolünü çalıştırır. */
type InvRow = { id: string; kind: InvoiceCheckInput['kind']; currency: string; supplier_id: string; advance_offset: string; advance_invoice_id: string | null; supplier_status: string; company_id: string; supplier_root_id: string; reversal_targets: string[] | null;
  tax_total: string | null; withholding: string | null; payable: string | null; other_tax: string | null };
const INV_SQL = `SELECT i.id, i.company_id, i.kind, i.currency, i.supplier_id, i.advance_offset::text, i.advance_invoice_id, s.status AS supplier_status, ${SUPPLIER_ROOT_SQL} AS supplier_root_id,
  CASE WHEN i.kind = 'CREDIT_NOTE' AND EXISTS (SELECT 1 FROM invoice_decisions d JOIN invoices o ON o.id = d.invoice_id WHERE o.id = i.original_invoice_id AND o.company_id = i.company_id AND d.kind = 'APPROVAL')
    THEN ARRAY(SELECT coalesce(a.po_line_id, a.contract_version_id)::text FROM invoice_allocations a WHERE a.invoice_id = i.original_invoice_id) END AS reversal_targets,
  i.declared_tax_total::text AS tax_total, i.declared_withholding::text AS withholding, i.declared_payable::text AS payable, i.declared_other_tax_total::text AS other_tax
  FROM invoices i JOIN suppliers s ON s.id = i.supplier_id WHERE i.id = ANY($1::uuid[])`;
const LINES_SQL = `SELECT invoice_id, line_no AS "lineNo", description, trim_scale(quantity)::text AS quantity, unit, trim_scale(unit_price)::text AS "unitPrice", net_amount::text AS "netAmount",
  trim_scale(tax_rate)::text AS "taxRate", tax_amount::text AS "taxAmount", other_tax_amount::text AS "otherTax", other_taxes AS "otherTaxes" FROM invoice_lines WHERE invoice_id = ANY($1::uuid[]) ORDER BY invoice_id, line_no`;
const TOLERANCE_SQL = `SELECT currency, category, abs_amount::text AS "absAmount", percent::text, combine FROM tolerance_rules`;
const ALLOC_SQL = `SELECT invoice_id, line_no AS "lineNo", po_line_id AS "poLineId", contract_version_id AS "contractVersionId",
  trim_scale(quantity)::text AS quantity, amount::text FROM invoice_allocations WHERE invoice_id = ANY($1::uuid[]) ORDER BY invoice_id, line_no`;
const ADVANCE_SQL = `SELECT (a.total - coalesce((SELECT sum(i.advance_offset) FROM invoices i WHERE i.advance_invoice_id = $1 AND i.id <> $2 AND ${APPROVED}), 0))::text AS v
  FROM (SELECT sum(net_amount) AS total FROM invoice_lines WHERE invoice_id = $1) a`;

function checkInput(inv: InvRow, lines: InvoiceCheckInput['lines'], allocations: AllocationInput[], poLines: PoLineState[], contracts: ContractState[], tolerances: ToleranceRule[], advanceBalance: string): InvoiceCheckInput {
  return { kind: inv.kind, currency: inv.currency, supplierActive: inv.supplier_status === 'ACTIVE', companyId: inv.company_id, supplierRootId: inv.supplier_root_id, reversalTargets: inv.reversal_targets ?? undefined, lines, allocations, poLines, contracts,
    tolerances, advanceOffset: inv.advance_offset, advanceBalance, declared: { taxTotal: inv.tax_total, withholding: inv.withholding, payable: inv.payable, otherTaxTotal: inv.other_tax } };
}
const strip = <T extends { invoice_id: string }>({ invoice_id: _, ...rest }: T) => rest;

async function evaluate(tx: Tx, invoiceId: string) {
  const inv = (await tx.query<InvRow>(INV_SQL, [[invoiceId]])).rows[0];
  if (!inv) throw notFound();
  const lines = (await tx.query(LINES_SQL, [[invoiceId]])).rows.map(strip) as InvoiceCheckInput['lines'];
  const allocations = (await tx.query(ALLOC_SQL, [[invoiceId]])).rows.map(strip) as AllocationInput[];
  const poLines = await poLineStates(tx, allocations.map((a) => a.poLineId).filter((x): x is string => !!x), invoiceId);
  const cvIds = [...new Set([...poLines.map((p) => p.contractVersionId), ...allocations.map((a) => a.contractVersionId)].filter((x): x is string => !!x))];
  const contracts: ContractState[] = [];
  for (const c of cvIds) { const s = await contractState(tx, c, invoiceId); if (s) contracts.push(s); }
  const tolerances = (await tx.query<ToleranceRule>(`${TOLERANCE_SQL} WHERE currency = $1`, [inv.currency])).rows;
  const advanceBalance = inv.advance_invoice_id ? (await tx.query<{ v: string | null }>(ADVANCE_SQL, [inv.advance_invoice_id, invoiceId])).rows[0]!.v ?? '0' : '0';
  const raw = checkInvoice(checkInput(inv, lines, allocations, poLines, contracts, tolerances, advanceBalance));
  // Sorumlu rol v2 koduyla döner (düzeltme dalgası Y3: alan kuralları eski rol kodlarını taşır; ekran ve API ham eski kod göstermez).
  const check = { ...raw, issues: raw.issues.map((x) => ({ ...x, ownerRole: v2Role(x.ownerRole) })) };
  // Parmak izi, istisnanın dayandığı sipariş kalemi durumunu da kapsar: sipariş fiyatı/miktarı veya kabul değişirse istisna eskir.
  const fingerprint = sha(JSON.stringify({ a: allocations, o: inv.advance_offset, i: check.issues.map((x) => [x.code, x.lineNo ?? null]),
    p: [...poLines].sort((x, y) => x.poLineId.localeCompare(y.poLineId)).map((x) => [x.poLineId, x.orderedQty, x.unitPrice, x.receivedQty, x.invoicedQty, x.poStatus]),
    // Uygulanan tolerans kuralı ve limit yöntemi değişirse istisna eskir.
    t: tolerances.map((t) => [t.category ?? '', t.absAmount, t.percent, t.combine]).sort(), c: contracts.map((c) => [c.contractVersionId, c.limitBasis ?? 'NET']).sort() }));
  return { check, fingerprint, contracts, poLines };
}

/** Rapor için yan etkisiz kontrol: bulgu var mı (görev açmaz, kaydetmez). */
export async function invoiceHasIssue(tx: Tx, invoiceId: string) {
  const { check } = await evaluate(tx, invoiceId);
  return check.issues.length > 0;
}

/**
 * Rapor için toplu, yan etkisiz kontrol: fatura sayısından bağımsız sabit sayıda sorgu (N+1 yok). YALNIZ onaylanmamış faturalar için
 * `evaluate` ile aynı sonucu verir: tek tek kontroldeki "bu faturayı hariç tut" filtreleri yalnız onaylı faturaları etkiler.
 */
export async function unapprovedInvoicesWithIssues(tx: Tx, ids: string[]): Promise<Set<string>> {
  const checks = await unapprovedInvoiceChecks(tx, ids);
  return new Set([...checks].filter(([, c]) => c.issues.length).map(([id]) => id));
}

async function unapprovedInvoiceChecks(tx: Tx, ids: string[]) {
  const out = new Map<string, ReturnType<typeof checkInvoice>>();
  if (!ids.length) return out;
  const invs = (await tx.query<InvRow>(INV_SQL, [ids])).rows;
  const group = <T extends { invoice_id: string }>(rows: T[]) => { const m = new Map<string, Omit<T, 'invoice_id'>[]>(); for (const r of rows) m.set(r.invoice_id, [...(m.get(r.invoice_id) ?? []), strip(r)]); return m; };
  const lines = group((await tx.query(LINES_SQL, [ids])).rows);
  const allocs = group((await tx.query(ALLOC_SQL, [ids])).rows);
  const allPoLines = await poLineStates(tx, [...new Set([...allocs.values()].flat().map((a: any) => a.poLineId).filter((x): x is string => !!x))], null);
  const poById = new Map(allPoLines.map((p) => [p.poLineId, p]));
  const cvIds = [...new Set([...allPoLines.map((p) => p.contractVersionId), ...[...allocs.values()].flat().map((a: any) => a.contractVersionId)].filter((x): x is string => !!x))];
  const cvById = new Map<string, ContractState>();
  for (const c of cvIds) { const s = await contractState(tx, c, null); if (s) cvById.set(c, s); }
  const tolerances = (await tx.query<ToleranceRule>(TOLERANCE_SQL)).rows;
  // Avans bakiyesi avans faturası başına bir kez (ADVANCE_SQL ile aynı ifade; hariç tutulan fatura onaysız olduğundan etkisiz).
  const advIds = [...new Set(invs.map((i) => i.advance_invoice_id).filter((x): x is string => !!x))];
  const advBalance = new Map((await tx.query<{ id: string; v: string }>(`SELECT a.id, ((SELECT sum(net_amount) FROM invoice_lines WHERE invoice_id = a.id)
      - coalesce((SELECT sum(i.advance_offset) FROM invoices i WHERE i.advance_invoice_id = a.id AND ${APPROVED}), 0))::text AS v
    FROM invoices a WHERE a.id = ANY($1::uuid[])`, [advIds])).rows.map((r) => [r.id, r.v]));
  for (const inv of invs) {
    const allocations = (allocs.get(inv.id) ?? []) as AllocationInput[];
    const poLines = [...new Set(allocations.map((a) => a.poLineId).filter((x): x is string => !!x))].map((id) => poById.get(id)).filter((x): x is PoLineState => !!x);
    const cv = [...new Set([...poLines.map((p) => p.contractVersionId), ...allocations.map((a) => a.contractVersionId)].filter((x): x is string => !!x))];
    // Erişilemeyen avansın bakiyesi sıfır sayılır (mahsup engele düşer); tek satır bütün listeyi düşürmez.
    const advanceBalance = inv.advance_invoice_id ? advBalance.get(inv.advance_invoice_id) ?? '0' : '0';
    const check = checkInvoice(checkInput(inv, (lines.get(inv.id) ?? []) as InvoiceCheckInput['lines'], allocations, poLines,
      cv.map((c) => cvById.get(c)).filter((x): x is ContractState => !!x), tolerances, advanceBalance));
    out.set(inv.id, check);
  }
  return out;
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
export async function approveInvoice(tx: Tx, ctx: TenantContext, invoiceId: string, erpAdapterName: string | null = null, expectedFingerprint?: string) {
  const inv = (await tx.query<{ company_id: string; created_by: string; legal_status: string }>(`SELECT company_id, created_by, legal_status FROM invoices WHERE id = $1`, [invoiceId])).rows[0];
  if (!inv) throw notFound();
  if (inv.legal_status !== 'RECEIVED') throw conflict('legally_cancelled', 'Hukuki olarak iptal/ret edilmiş e-belge onaylanamaz.');
  if (inv.created_by === ctx.userId) throw new ApiError(403, 'segregation_of_duties', 'Faturayı giren kişi tek başına onaylayamaz (görev ayrılığı).');
  const pre = await evaluate(tx, invoiceId);
  const allocated = (await tx.query<{ po_line_id: string }>(`SELECT po_line_id FROM invoice_allocations WHERE invoice_id = $1 AND po_line_id IS NOT NULL`, [invoiceId])).rows.map((r) => r.po_line_id);
  await lockPosOfLines(tx, allocated);
  await lockContracts(tx, Object.keys(pre.check.contractImpact));
  if (await finalDecision(tx, invoiceId)) throw conflict('invoice_decided', 'Bu fatura için karar verildi.');
  const { check, fingerprint } = await evaluate(tx, invoiceId);
  // Önce engel (kilit altında güncel limit/eşleştirme), sonra sürüm: engel varsa sebebi söylenir.
  if (!check.canApprove) throw unprocessable('invoice_blocked', check.issues.find((x) => x.severity === 'BLOCK')!.message, { issues: check.issues });
  // Onay, onaylayanın gördüğü kontrol sonucuna bağlıdır (web/iOS aynı): arada tahsis, sipariş veya kabul değiştiyse 409 (T44).
  if (expectedFingerprint !== undefined && expectedFingerprint !== fingerprint) throw conflict('invoice_changed', 'Fatura siz incelerken değişti (tahsis, sipariş veya kabul); güncel hali yükleyip yeniden inceleyin.');
  if (check.needsException) {
    const ex = (await tx.query<{ check_hash: string; decided_by: string }>(`SELECT check_hash, decided_by FROM invoice_decisions WHERE invoice_id = $1 AND kind = 'EXCEPTION_APPROVAL' ORDER BY decided_at DESC LIMIT 1`, [invoiceId])).rows[0];
    if (!ex) throw unprocessable('exception_required', 'Bu fatura istisna onayı gerektiriyor; sorumluya görev açıldı.', { issues: check.issues });
    if (ex.check_hash !== fingerprint) throw conflict('exception_stale', 'İstisna onaylandıktan sonra tahsis veya kontrol sonucu değişti; yeniden istisna onayı gerekir.');
  }
  await tx.query(`INSERT INTO invoice_decisions (tenant_id, company_id, invoice_id, kind, check_hash, issues, decided_by) VALUES ($1,$2,$3,'APPROVAL',$4,$5,$6)`,
    [ctx.tenantId, inv.company_id, invoiceId, fingerprint, JSON.stringify(check.issues), ctx.userId]);
  await closeTasks(tx, `invoice-issue:${invoiceId}:`);
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
  await closeTasks(tx, `invoice-issue:${invoiceId}:`);
  await audit(tx, ctx, 'invoice.rejected', 'invoice', invoiceId, {}, reason);
  return { rejected: true };
}

/** Kontrol bulguları sorumlu rollere görev olarak düşer (kim çözer, 02 §24). Aynı bulgu ikinci görev açmaz. */
async function syncIssueTasks(tx: Tx, ctx: TenantContext, invoiceId: string, invoiceNo: string, companyId: string, supplierId: string, supplierStatus: string, issues: { code: string; ownerRole: string; message: string; severity: string }[]) {
  await closeTasks(tx, `invoice-issue:${invoiceId}:`);
  for (const x of issues) {
    // v2 Faz 1 (D93): kaldırılan bulgular (üçlü eşleştirme, tolerans, sözleşmesiz istisna) görev açmaz.
    if (REMOVED_ISSUE_CODES.includes(x.code)) continue;
    // Birleşen veya reddedilen tedarikçide ana verinin yapacağı iş kalmaz; engel faturada görünür.
    if (x.code === 'SUPPLIER_NOT_ACTIVE' && ['MERGED', 'REJECTED'].includes(supplierStatus)) continue;
    // Ana veri fatura okuyamaz; kendi işi tedarikçi kaydındadır (D92).
    const onSupplier = x.code === 'SUPPLIER_NOT_ACTIVE';
    await openTask(tx, ctx, { companyId, kind: 'invoice_issue', entityType: onSupplier ? 'supplier' : 'invoice', entityId: onSupplier ? supplierId : invoiceId, title: `Fatura ${invoiceNo}: ${x.message.split(':')[0]}`,
      reason: x.message, nextAction: onSupplier ? 'Tedarikçinin kimliğini doğrulayıp aktivasyonunu tamamlayın.' : 'Faturayı açıp bulguyu düzeltin (tahsis, tutar veya sözleşme); düzelince görev kendiliğinden kapanır.',
      assigneeRole: x.ownerRole, severity: x.severity === 'BLOCK' ? 'HIGH' : 'NORMAL', dedupeKey: `invoice-issue:${invoiceId}:${x.code}` });
  }
}

/** Aynı ünvanlı aday ile aktif firma faturada karışmasın (D83). Vergi kimliğinin kendisi fatura listesine çıkmaz; yalnız doğrulanmış mı bilgisi.
 *  Birleştirilen aday kimliği çözülmüş sayılır: birleştirme vergi kimliğini hedef kayıtta bırakır, adayda boş kalır. */
const SUPPLIER_VERIFIED_SQL = `((s.tax_id IS NOT NULL OR s.status = 'MERGED') AND NOT s.identity_review_required)`;

export async function getInvoice(tx: Tx, ctx: TenantContext, id: string) {
  const inv = (await tx.query(`SELECT i.id, i.kind, i.invoice_no AS "invoiceNo", i.ettn, i.issue_date::text AS "issueDate", i.currency, i.company_id AS "companyId",
      i.supplier_id AS "supplierId", s.legal_name AS "supplierName", s.status AS "supplierStatus", ${SUPPLIER_VERIFIED_SQL} AS "supplierIdentityVerified", ${SUPPLIER_ROOT_SQL} AS "supplierRootId", i.legal_status AS "legalStatus", i.payment_status AS "paymentStatus",
      i.original_invoice_id AS "originalInvoiceId", i.advance_invoice_id AS "advanceInvoiceId", i.advance_offset::text AS "advanceOffset", i.document_version_id AS "documentVersionId", (SELECT sha256 FROM document_versions dv WHERE dv.id = i.document_version_id) AS "documentSha256",
      i.declared_tax_total::text AS "declaredTaxTotal", i.declared_withholding::text AS "declaredWithholding", i.declared_payable::text AS "declaredPayable", i.declared_other_tax_total::text AS "declaredOtherTaxTotal",
      i.created_by = $2 AS "createdByMe", u.display_name AS "createdBy", i.created_at AS "createdAt",
      i.department_id AS "departmentId", (SELECT d.name FROM departments d WHERE d.id = i.department_id) AS "departmentName"
    FROM invoices i JOIN suppliers s ON s.id = i.supplier_id JOIN users u ON u.id = i.created_by WHERE i.id = $1`, [id, ctx.userId])).rows[0];
  if (!inv) throw notFound();
  const lines = (await tx.query(`SELECT line_no AS "lineNo", description, trim_scale(quantity)::text AS quantity, unit, trim_scale(unit_price)::text AS "unitPrice", net_amount::text AS "netAmount", trim_scale(tax_rate)::text AS "taxRate",
      tax_amount::text AS "taxAmount", other_tax_amount::text AS "otherTax", other_taxes AS "otherTaxes" FROM invoice_lines WHERE invoice_id = $1 ORDER BY line_no`, [id])).rows;
  const allocations = (await tx.query(`SELECT a.line_no AS "lineNo", a.po_line_id AS "poLineId", a.contract_version_id AS "contractVersionId", trim_scale(a.quantity)::text AS quantity,
      a.amount::text, po.id AS "poId", po.code AS "poCode", pl.description AS "poLineDescription", f.title AS "contractTitle"
    FROM invoice_allocations a LEFT JOIN po_lines pl ON pl.id = a.po_line_id LEFT JOIN purchase_orders po ON po.id = pl.po_id
    LEFT JOIN contract_versions cv ON cv.id = coalesce(a.contract_version_id, po.contract_version_id) LEFT JOIN contract_families f ON f.id = cv.family_id
    WHERE a.invoice_id = $1 ORDER BY a.line_no`, [id])).rows;
  const decisions = (await tx.query(`SELECT d.kind, d.reason, d.decided_at AS "decidedAt", u.display_name AS "decidedBy", d.check_hash AS "checkHash"
    FROM invoice_decisions d JOIN users u ON u.id = d.decided_by WHERE d.invoice_id = $1 ORDER BY d.decided_at`, [id])).rows;
  const intake = (await tx.query(`SELECT source, duplicate, received_at AS "receivedAt" FROM invoice_intake_events WHERE invoice_id = $1 ORDER BY received_at`, [id])).rows;
  const erp = (await tx.query(`SELECT status, external_id AS "externalId", attempts, post_calls AS "postCalls", last_error AS "lastError", updated_at AS "updatedAt" FROM erp_exports WHERE invoice_id = $1`, [id])).rows[0] ?? null;
  // Kaynak e-Fatura'nın UBL-TR temel kural denetimi (D81); onayı etkilemez, bilgi olarak gösterilir.
  const ublCheck = inv.documentVersionId ? (await tx.query(`SELECT rule_set AS "ruleSet", error_count AS errors, warning_count AS warnings, findings, bill_refs AS "billingReferences"
    FROM einvoice_checks WHERE document_version_id = $1`, [inv.documentVersionId])).rows[0] ?? null : null;
  const { check, fingerprint, contracts, poLines } = await evaluate(tx, id);
  const final = decisions.find((d: any) => d.kind === 'APPROVAL' || d.kind === 'REJECTION') ?? null;
  const exception = [...decisions].reverse().find((d: any) => d.kind === 'EXCEPTION_APPROVAL') ?? null;
  if (!final) await syncIssueTasks(tx, ctx, id, inv.invoiceNo, inv.companyId, inv.supplierId, inv.supplierStatus, check.issues);
  // v2 Faz 1 (D93): fatura onayı ve istisnası kalktı. Yanıt kaldırılan bulguları (sipariş/kabul, tolerans, sözleşmesiz istisna;
  // REMOVED_ISSUE_CODES) taşımaz, onay bayrağı her zaman false. Hesap ve parmak izi değişmez (eski kayıtlar için doğru kalır).
  const issues = check.issues.filter((x) => !REMOVED_ISSUE_CODES.includes(x.code));
  const shown = { ...check, issues, canApprove: false, needsException: false };
  return {
    invoice: inv, lines, allocations, decisions, intake, erp, check: shown, contracts, poLines, ublCheck,
    /** v2 Faz 7 (R1, R11): eşleşme durumu, sözleşme, proje, yöntem, referanslar ve kullanım. */
    match: await matchInfo(tx, id),
    status: final ? final.kind : issues.some((x) => x.severity === 'BLOCK') ? 'BLOCKED' : 'OPEN',
    exceptionCurrent: exception ? exception.checkHash === fingerprint : null,
    /** Onay isteği If-Match ile bu değeri gönderir (görülen kontrol sonucu). */
    checkFingerprint: fingerprint,
  };
}

export type MatchFilter = 'ALL' | 'MATCHED' | 'UNMATCHED';
export async function listInvoices(tx: Tx, f: { departmentId?: string; match?: MatchFilter } = {}) {
  const rows = (await tx.query<{ id: string; decision: string | null; hasLines: boolean; matchState: MatchState; familyId: string | null; familyCode: string | null;
    familyTitle: string | null; projectId: string | null; projectCode: string | null; projectTitle: string | null; allocFamilies: string[] }>(`SELECT i.id, i.kind, i.invoice_no AS "invoiceNo", i.issue_date::text AS "issueDate", i.currency, s.legal_name AS "supplierName",
      s.status AS "supplierStatus", ${SUPPLIER_VERIFIED_SQL} AS "supplierIdentityVerified",
      (SELECT sum(net_amount)::text FROM invoice_lines WHERE invoice_id = i.id) AS "netAmount", i.legal_status AS "legalStatus", i.payment_status AS "paymentStatus",
      (SELECT kind FROM invoice_decisions d WHERE d.invoice_id = i.id AND d.kind IN ('APPROVAL','REJECTION')) AS decision,
      (SELECT status FROM erp_exports e WHERE e.invoice_id = i.id) AS "erpStatus",
      (SELECT count(*)::int FROM invoice_intake_events e WHERE e.invoice_id = i.id AND e.duplicate) AS "duplicateCount",
      i.department_id AS "departmentId", (SELECT d.name FROM departments d WHERE d.id = i.department_id) AS "departmentName",
      EXISTS (SELECT 1 FROM invoice_lines l WHERE l.invoice_id = i.id) AS "hasLines",
      ${MATCH_STATE_SQL('i')} AS "matchState", i.match_method AS "matchMethod", i.contract_family_id AS "familyId", cf.code AS "familyCode", cf.title AS "familyTitle",
      i.project_id AS "projectId", pr.code AS "projectCode", pr.title AS "projectTitle", ${ALLOC_FAMILIES_SQL('i')} AS "allocFamilies"
    FROM invoices i JOIN suppliers s ON s.id = i.supplier_id LEFT JOIN contract_families cf ON cf.id = i.contract_family_id LEFT JOIN projects pr ON pr.id = i.project_id
    WHERE ($1::uuid IS NULL OR i.department_id = $1)
      AND ($2::text = 'ALL' OR ($2 = 'UNMATCHED') = (${MATCH_STATE_SQL('i')} = 'UNMATCHED'))
    ORDER BY i.created_at DESC LIMIT 300`, [f.departmentId ?? null, f.match ?? 'ALL'])).rows;
  // v2 Faz 7 (R1): tahsisle türeyen tek aile (ALLOCATED) için sözleşme bilgisi; bağlı faturada saklı aile.
  const allocOnly = [...new Set(rows.filter((r) => r.matchState === 'ALLOCATED').map((r) => r.allocFamilies[0]!))];
  const allocFam = new Map((await tx.query<{ id: string; code: string; title: string; project_id: string | null; pcode: string | null; ptitle: string | null }>(
    `SELECT f.id, f.code, f.title, f.project_id, p.code AS pcode, p.title AS ptitle FROM contract_families f LEFT JOIN projects p ON p.id = f.project_id WHERE f.id = ANY($1::uuid[])`,
    [allocOnly])).rows.map((x) => [x.id, x]));
  // Karar bekleyenlerde listede de engel görünsün (D90). Maliyet: fatura başına değil, bağlı sözleşme başına sorgu.
  // v2 eşleşme (I5): "Eşleşti" tahsis kontrolünden türer (eksik/fazla/yanlış tedarikçi ya da şirket tahsisi eşleşme sayılmaz). Tahsis
  // bulguları onaylı faturada da aynı hesaplanır (toplu kontrolün onaylı fatura farkı limit ve avans hesabındadır), bu yüzden hepsi için.
  const checks = await unapprovedInvoiceChecks(tx, rows.map((r) => r.id));
  return rows.map(({ hasLines, familyId, familyCode, familyTitle, projectId, projectCode, projectTitle, allocFamilies, ...r }) => {
    const af = r.matchState === 'ALLOCATED' ? allocFam.get(allocFamilies[0]!) : undefined;
    return { ...r, matchStateLabel: MATCH_STATE_TR[r.matchState],
    contract: familyId ? { id: familyId, code: familyCode, title: familyTitle } : af ? { id: af.id, code: af.code, title: af.title } : null,
    project: projectId ? { id: projectId, code: projectCode, title: projectTitle } : af?.project_id ? { id: af.project_id, code: af.pcode, title: af.ptitle } : null,
    matched: allocationMatched(hasLines, checks.get(r.id)?.issues ?? []),
    // v2 Faz 1 (D93): detayla aynı; kaldırılan bulgu kodları (REMOVED_ISSUE_CODES) engel sayılmaz.
    blocked: !r.decision && !!checks.get(r.id)?.issues.some((x) => x.severity === 'BLOCK' && !REMOVED_ISSUE_CODES.includes(x.code)) };
  });
}

export async function listTolerance(tx: Tx) {
  return (await tx.query(`SELECT t.currency, t.category, t.abs_amount::text AS "absAmount", trim_scale(t.percent)::text AS percent, t.combine, t.created_at AS "updatedAt", u.display_name AS "updatedBy"
    FROM tolerance_rules t LEFT JOIN users u ON u.id = t.created_by ORDER BY t.currency, t.category`)).rows;
}

/** Kural kaldırılınca o para biriminde tolerans sıfırdır (varsayılan evrensel tolerans yok). */
export async function deleteTolerance(tx: Tx, ctx: TenantContext, currency: string, category = '') {
  const r = await tx.query(`DELETE FROM tolerance_rules WHERE currency = $1 AND category = $2 RETURNING currency`, [currency, category.trim()]);
  if (!r.rowCount) throw notFound();
  await audit(tx, ctx, 'tolerance.deleted', 'tenant', ctx.tenantId, { currency, category: category.trim() });
  return { ok: true };
}

export async function setTolerance(tx: Tx, ctx: TenantContext, b: { currency: string; category?: string; absAmount: string | null; percent: string | null; combine: 'LOWER' | 'HIGHER' }) {
  const category = (b.category ?? '').trim();
  if (b.absAmount === null && b.percent === null) throw unprocessable('invalid_rule', 'Tutar veya yüzde eşiği girilmeli.');
  if (b.absAmount !== null && !/^\d{1,18}(\.\d{1,2})?$/.test(b.absAmount)) throw unprocessable('invalid_rule', 'Tutar eşiği en fazla 2 ondalık olmalı.');
  if (b.percent !== null && (!isDecimal(b.percent) || cmp(dec(b.percent), dec('100')) > 0)) throw unprocessable('invalid_rule', 'Yüzde eşiği 0–100 arasında olmalı.');
  await tx.query(`INSERT INTO tolerance_rules (tenant_id, currency, category, abs_amount, percent, combine, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7)
    ON CONFLICT (tenant_id, currency, category) DO UPDATE SET abs_amount = EXCLUDED.abs_amount, percent = EXCLUDED.percent, combine = EXCLUDED.combine, created_by = EXCLUDED.created_by, created_at = now()`,
    [ctx.tenantId, b.currency, category, b.absAmount, b.percent, b.combine, ctx.userId]);
  await audit(tx, ctx, 'tolerance.set', 'tenant', ctx.tenantId, { ...b, category });
  return { ok: true };
}

// --- ERP aktarımı (worker) ve gelen durum olayları --------------------------------------------

/** ERP'ye giden ödenecek tutar: satır netleri − avans mahsubu, tam ondalık (float yok). Aktarım ve mutabakat aynı ifadeyi kullanır. `i` = invoices. */
export const ERP_PAYABLE_SQL = `((SELECT coalesce(sum(l.net_amount), 0) FROM invoice_lines l WHERE l.invoice_id = i.id) - i.advance_offset)::numeric(20,2)::text`;

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
  const inv = (await tx.query<{ invoice_no: string; currency: string; tax_id: string | null; net: string; payable: string }>(`SELECT i.invoice_no, i.currency, s.tax_id,
      (SELECT sum(net_amount)::text FROM invoice_lines WHERE invoice_id = i.id) AS net, ${ERP_PAYABLE_SQL} AS payable FROM invoices i JOIN suppliers s ON s.id = i.supplier_id WHERE i.id = $1`, [j.payload.invoiceId])).rows[0]!;
  const allocs = (await tx.query<{ contract_code: string | null; po_code: string | null; amount: string }>(`SELECT f.code AS contract_code, po.code AS po_code, a.amount::text
    FROM invoice_allocations a LEFT JOIN po_lines pl ON pl.id = a.po_line_id LEFT JOIN purchase_orders po ON po.id = pl.po_id
    LEFT JOIN contract_versions cv ON cv.id = coalesce(a.contract_version_id, po.contract_version_id) LEFT JOIN contract_families f ON f.id = cv.family_id WHERE a.invoice_id = $1`, [j.payload.invoiceId])).rows;
  await tx.query(`UPDATE erp_exports SET post_calls = post_calls + 1 WHERE invoice_id = $1`, [j.payload.invoiceId]);
  try {
    const r = await adapter.post({ idempotencyKey: ex.idempotency_key, invoiceNo: inv.invoice_no, supplierTaxId: inv.tax_id, currency: inv.currency, netAmount: inv.net,
      payable: inv.payable, allocations: allocs.map((a) => ({ contractCode: a.contract_code, poCode: a.po_code, amount: a.amount })) });
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
    // Ödeme tarihi İstanbul takvim günü (Lira Defteri erken ödeme kuralı vadeyle bunu karşılaştırır).
    if (e.status === 'PAID') await tx.query(`UPDATE invoices SET payment_status = 'PAID', paid_at = ($2::timestamptz AT TIME ZONE 'Europe/Istanbul')::date WHERE id = $1`, [e.invoiceId, e.at]);
    await audit(tx, ctx, 'invoice.erp_status', 'invoice', e.invoiceId, { eventId: e.eventId, status: e.status, at: e.at });
    out.push({ eventId: e.eventId, result: 'applied' });
  }
  return { results: out };
}


/**
 * Sözleşme ailesine tahsis edilmiş faturalar (Görev 7 inceleme, I4). Tutar, faturanın bu aileye tahsis edilen kısmıdır (iade negatif);
 * avans faturası tüketime sayılmadığı gibi burada da listelenmez. Durum: onaylı (tüketime sayılır), reddedildi ya da karar bekliyor.
 * Görünürlük: aile ve faturalar kendi RLS kurallarıyla; görülmeyen aile 404.
 */
export async function familyInvoices(tx: Tx, familyId: string) {
  const fam = (await tx.query<{ id: string }>(`SELECT id FROM contract_families WHERE id = $1`, [familyId])).rows[0];
  if (!fam) throw notFound();
  const rows = (await tx.query<{ id: string; invoiceNo: string; issueDate: string; currency: string; kind: string; supplierId: string; supplierName: string;
    amount: string; approved: boolean; decision: string | null }>(
    `SELECT i.id, i.invoice_no AS "invoiceNo", i.issue_date::text AS "issueDate", i.currency, i.kind, s.id AS "supplierId", s.legal_name AS "supplierName",
            sum(CASE i.kind WHEN 'CREDIT_NOTE' THEN -a.amount ELSE a.amount END)::numeric(20,2)::text AS amount,
            (${APPROVED}) AS approved,
            (SELECT d.kind FROM invoice_decisions d WHERE d.invoice_id = i.id AND d.kind IN ('APPROVAL','REJECTION') ORDER BY d.decided_at DESC, d.id DESC LIMIT 1) AS decision
       FROM invoice_allocations a JOIN invoices i ON i.id = a.invoice_id JOIN suppliers s ON s.id = i.supplier_id
       LEFT JOIN po_lines pl ON pl.id = a.po_line_id LEFT JOIN purchase_orders po ON po.id = pl.po_id
       JOIN contract_versions cv ON cv.id = coalesce(po.contract_version_id, a.contract_version_id)
      WHERE cv.family_id = $1 AND i.kind <> 'ADVANCE'
      GROUP BY i.id, s.id ORDER BY i.issue_date DESC, i.invoice_no LIMIT 200`, [familyId])).rows;
  const status = (r: (typeof rows)[number]) => r.approved ? { status: 'APPROVED', statusLabel: 'Onaylandı (tüketime sayılır)' }
    : r.decision === 'REJECTION' ? { status: 'REJECTED', statusLabel: 'Reddedildi' } : { status: 'PENDING', statusLabel: 'Karar bekliyor' };
  return { items: rows.map((r) => ({ id: r.id, invoiceNo: r.invoiceNo, date: r.issueDate, kind: r.kind, supplier: { id: r.supplierId, legalName: r.supplierName },
    amount: r.amount, currency: r.currency, ...status(r) })) };
}

/** Sözleşme limiti görünümü (T14): tavan, net tüketim, açık taahhüt, kullanılabilir. */
export async function contractLimit(tx: Tx, cvId: string) {
  const c = await contractState(tx, cvId, null);
  if (!c) throw notFound();
  return { ...c, available: c.ceiling === null ? null : availableLimit(c.ceiling, c.netConsumption, c.openCommitment) };
}

// --- e-Fatura XML → fatura ---------------------------------------------------------------------

/** UN/ECE Rec 20 birim kodları → sipariş biriminde kullanılan Türkçe adlar (eşleşme birim karşılaştırmasıyla yapılır). */
const validDate = (d: string | null): d is string => {
  if (!d || !/^\d{4}-\d{2}-\d{2}$/.test(d)) return false;
  const t = new Date(`${d}T00:00:00Z`);
  return !Number.isNaN(t.getTime()) && t.toISOString().slice(0, 10) === d;
};
const UNIT_CODES: Record<string, string> = { C62: 'adet', NIU: 'adet', H87: 'adet', KGM: 'kg', GRM: 'g', LTR: 'lt', MTR: 'm', MTK: 'm2', MTQ: 'm3',
  HUR: 'saat', DAY: 'gün', MON: 'ay', ANN: 'yıl', SET: 'set', PA: 'paket', BX: 'kutu', KWH: 'kWh' };

export interface EInvoiceIntake { created: boolean; invoiceId: string | null; duplicate: boolean; reason: string | null }

/**
 * Yapılandırılmış e-Fatura'dan fatura kaydı (deterministik; AI yok). Belgedeki toplamlar "beyan" olarak saklanır ve kontrol
 * satırlardan hesaplananla karşılaştırır. Kayıt açılamazsa sebep görev olarak finansa düşer; boş alan uydurulmaz.
 */
export async function invoiceFromEInvoice(tx: Tx, ctx: TenantContext, o: {
  companyId: string; documentVersionId: string; supplierId: string;
  /** v2 Faz 7 (R2): yükleme formunda girilen ERP referansları (isteğe bağlı). */
  erpContractRef?: string | null; erpOrderRef?: string | null;
  ubl: { invoiceNumber: string | null; ettn: string | null; issueDate: string | null; currency: string | null; typeCode: string | null; billingReference: string | null;
    buyer: { taxId: string | null }; lines: { description: string; quantity: string | null; unitCode: string | null; unitPrice: string | null; netAmount: string | null; taxRate: string | null; taxAmount: string | null; otherTax: string | null;
      otherTaxes?: { code: string; name: string | null; rate: string | null; amount: string }[] }[];
    totals: { taxTotal: string | null; otherTaxTotal: string | null; withholding: string | null; payable: string | null } };
}): Promise<EInvoiceIntake> {
  const u = o.ubl;
  const skip = async (reason: string): Promise<EInvoiceIntake> => {
    await openTask(tx, ctx, { companyId: o.companyId, kind: 'invoice_intake', entityType: 'document_version', entityId: o.documentVersionId,
      title: 'e-Fatura faturaya dönüştürülemedi', reason, nextAction: 'Belgeyi açıp faturayı elle girin veya satıcıdan düzeltilmiş belge isteyin.',
      assigneeRole: 'FINANCE', dedupeKey: `doc:${o.documentVersionId}:invoice-intake` });
    return { created: false, invoiceId: null, duplicate: false, reason };
  };
  const company = (await tx.query<{ tax_id: string }>(`SELECT tax_id FROM legal_entities WHERE id = $1`, [o.companyId])).rows[0];
  if (!u.buyer.taxId || !company || u.buyer.taxId !== company.tax_id) return skip('Belgedeki alıcı vergi kimliği seçilen şirketle eşleşmiyor.');
  if (!u.invoiceNumber || u.invoiceNumber.length > 40 || !validDate(u.issueDate) || !u.currency || !/^[A-Z]{3}$/.test(u.currency)) return skip('Fatura no, tarih veya para birimi belgede yok ya da geçersiz.');
  if (u.ettn && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(u.ettn)) return skip('ETTN geçerli bir UUID değil.');
  const nonNeg = (x: string | null) => x === null || (isDecimal(x) && dec(x) >= 0n);
  if (![u.totals.taxTotal, u.totals.otherTaxTotal, u.totals.withholding, u.totals.payable].every(nonNeg)) return skip('Belge toplamlarından biri okunamadı veya negatif.');
  if (!u.lines.length) return skip('Belgede fatura satırı yok.');
  const lines: InvoiceInput['lines'] = [];
  for (const [i, l] of u.lines.entries()) {
    if (!l.quantity || !l.netAmount || !isDecimal(l.quantity) || !isDecimal(l.netAmount) || dec(l.quantity) <= 0n || dec(l.netAmount) < 0n) return skip(`Satır ${i + 1}: miktar veya tutar okunamadı.`);
    if (!nonNeg(l.taxAmount) || !nonNeg(l.otherTax) || (l.taxRate !== null && !nonNeg(l.taxRate))) return skip(`Satır ${i + 1}: vergi oranı veya tutarı okunamadı.`);
    if ((l.otherTaxes ?? []).some((t) => !nonNeg(t.amount) || !nonNeg(t.rate))) return skip(`Satır ${i + 1}: KDV dışı vergi oranı veya tutarı okunamadı.`);
    // Satır indirimi varsa birim fiyat net/miktar olarak alınır (sipariş fiyatıyla karşılaştırılan değer budur).
    const listed = l.unitPrice && isDecimal(l.unitPrice) ? l.unitPrice : null;
    const effective = listed && cmp(absDec(amount(l.quantity, listed) - dec(l.netAmount)), dec('0.01')) <= 0 ? listed : str(div(dec(l.netAmount), dec(l.quantity)), 6);
    lines.push({ description: l.description || `Satır ${i + 1}`, quantity: str(dec(l.quantity), 6), unit: UNIT_CODES[l.unitCode ?? ''] ?? l.unitCode ?? 'adet',
      unitPrice: effective, netAmount: str(dec(l.netAmount)), taxRate: l.taxRate && isDecimal(l.taxRate) ? l.taxRate : '0', taxAmount: l.taxAmount ? str(dec(l.taxAmount)) : null, otherTax: l.otherTax ? str(dec(l.otherTax)) : null,
      // Vergi kalemleri: okunamayan oran "maktu" sayılmaz, kayıt açılmaz (yukarıda kontrol edilir).
      otherTaxes: l.otherTaxes?.length ? l.otherTaxes.map((t) => ({ code: t.code, name: t.name, rate: t.rate, amount: str(dec(t.amount)) })) : null });
  }
  let kind: InvoiceInput['kind'] = 'INVOICE';
  let originalInvoiceId: string | null = null;
  if (u.typeCode === 'IADE') {
    kind = 'CREDIT_NOTE';
    originalInvoiceId = (await tx.query<{ id: string }>(`SELECT id FROM invoices WHERE supplier_id = $1 AND invoice_no = $2 AND kind = 'INVOICE' AND company_id = $3`, [o.supplierId, u.billingReference ?? '', o.companyId])).rows[0]?.id ?? null;
    if (!originalInvoiceId) return skip(`İade faturasının bağlı olduğu özgün fatura (${u.billingReference ?? 'belirtilmemiş'}) sistemde yok.`);
  }
  const dec2 = (x: string | null) => (x && isDecimal(x) ? str(dec(x)) : null);
  // Düzeltme dalgası (I1, D98): Departman kullanıcısının yüklediği fatura onun departmanını taşır (departmansız fatura ona görünmez ve
  // RLS kaydı reddeder). Tek departmanı varsa o; birden çoksa ya da hiç yoksa hangisi olduğu tahmin edilmez, fatura kaydı açılmaz.
  let departmentId: string | null = null;
  if (!ctx.allDepartments) {
    if (ctx.departmentIds.length > 1) return skip('Birden fazla departmanınız olduğundan faturanın departmanı belirlenemedi; e-Faturadan fatura kaydı açılmadı. Belge kaydedildi; faturayı Satınalma girer.');
    if (!ctx.departmentIds.length) return skip('Size atanmış departman olmadığından e-Faturadan fatura kaydı açılmadı. Belge kaydedildi; faturayı Satınalma girer.');
    departmentId = ctx.departmentIds[0]!;
  }
  // Beklenmeyen bir kayıt hatası belgenin kendisini düşürmez: belge saklanır, fatura girişi göreve döner.
  await tx.query('SAVEPOINT einvoice_intake');
  let r: { id: string; duplicate: boolean };
  try {
    r = await createInvoice(tx, ctx, { companyId: o.companyId, supplierId: o.supplierId, kind, invoiceNo: u.invoiceNumber, ettn: u.ettn, issueDate: u.issueDate,
    currency: u.currency, documentVersionId: o.documentVersionId, originalInvoiceId, lines,
    declaredTaxTotal: dec2(u.totals.taxTotal), declaredWithholding: dec2(u.totals.withholding), declaredPayable: dec2(u.totals.payable), declaredOtherTaxTotal: dec2(u.totals.otherTaxTotal), departmentId,
    erpContractRef: o.erpContractRef ?? null, erpOrderRef: o.erpOrderRef ?? null }, 'einvoice');
    await tx.query('RELEASE SAVEPOINT einvoice_intake');
  } catch (e) {
    await tx.query('ROLLBACK TO SAVEPOINT einvoice_intake');
    return skip(e instanceof ApiError ? e.message : 'Fatura kaydı açılamadı.');
  }
  return { created: !r.duplicate, invoiceId: r.id, duplicate: r.duplicate, reason: null };
}
