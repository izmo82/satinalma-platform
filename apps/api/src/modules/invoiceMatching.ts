import {
  contractUsage, matchInvoice, matchState, normalizeRef, normalizeRoles, MATCH_METHOD_TR, MATCH_REASON_TR, MATCH_STATE_TR, USAGE_LEVEL_TR,
  type LinkContract, type MatchMethod, type MatchState, type UnmatchedReason, type UsageLevel,
} from '@sp/domain';
import type { TenantContext, Tx } from '../db.ts';
import { audit } from '../audit.ts';
import { ApiError, conflict, notFound, unprocessable } from '../errors.ts';
import { queueEmail } from '../mail/index.ts';
import { closeTasks, openTask, rederiveTaskDepartments } from '../tasks.ts';
import { withTenantWideScope } from './contractChain.ts';
import { listInfo } from './contractIntake.ts';
import { familyInvoices } from './invoices.ts';

/**
 * v2 Faz 7 (D112) Görev 3: fatura ↔ sözleşme ailesi eşleştirmesi (R1–R4).
 *
 * - Otomatik eşleştirme (`autoMatchInvoice`) yalnız `auto_match = true` faturada koşar (055 öncesi her satır false kalır; demo faturalar dahil).
 *   Tahsisli, kararlı (APPROVAL/REJECTION), zaten bağlı ya da elle bağı kaldırılmış faturaya hiç yazmaz (Review Focus 1).
 * - Bağ: aile + ailenin projesi + ailenin departmanı aynı UPDATE'te (056a `invoices_match_guard` aynısını veritabanında zorlar).
 * - Tahsis (v1) aynen kalır; tahsisli faturanın eşleşmesi saklanmaz, tahsisten türetilir (ALLOCATED/MIXED).
 * - Kullanım (R4) kodla hesaplanır (domain `contractUsage`); aşım bilgi amaçlıdır, engel değildir; ilk aşımda bir kez görev + e-posta.
 */

/** Domain `normalizeRef` ile aynı: kırpılmış, yalnız ASCII a–z büyük harf (veritabanı yerel ayarından bağımsız). */
const ASCII_UPPER = (x: string) => `translate(btrim(${x}), 'abcdefghijklmnopqrstuvwxyz', 'ABCDEFGHIJKLMNOPQRSTUVWXYZ')`;
const SUPPLIER_ROOT = (alias: string) => `coalesce(${alias}.merged_into_id, ${alias}.id)`;
const today = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Istanbul' }).format(new Date());
const trDate = (d: string | null) => (d ? `${d.slice(8, 10)}.${d.slice(5, 7)}.${d.slice(0, 4)}` : null);
const trMoney = (v: string, currency: string) =>
  `${new Intl.NumberFormat('tr-TR', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(Number(v))} ${currency === 'TRY' ? '₺' : currency}`;

/** Fatura bağlıysa (saklı aile) ya da tahsisleri bir aileye çıkıyorsa, tahsis ailelerinin listesi (`i` = invoices). */
export const ALLOC_FAMILIES_SQL = (i = 'i') => `ARRAY(SELECT DISTINCT cv.family_id::text FROM invoice_allocations a
    LEFT JOIN po_lines pl ON pl.id = a.po_line_id LEFT JOIN purchase_orders po ON po.id = pl.po_id
    JOIN contract_versions cv ON cv.id = coalesce(po.contract_version_id, a.contract_version_id) WHERE a.invoice_id = ${i}.id)`;
/** Türetilmiş eşleşme durumu SQL'de (liste süzgeci ve sayaçlar; domain `matchState` ile aynı sıra). */
export const MATCH_STATE_SQL = (i = 'i') => `(CASE WHEN ${i}.contract_family_id IS NOT NULL THEN 'MATCHED'
    ELSE (CASE cardinality(${ALLOC_FAMILIES_SQL(i)}) WHEN 0 THEN 'UNMATCHED' WHEN 1 THEN 'ALLOCATED' ELSE 'MIXED' END) END)`;
/** Kullanıma sayılan fatura: avans değil, hukuken geçerli, reddedilmemiş. */
const COUNTED_SQL = (i = 'i') => `${i}.kind <> 'ADVANCE' AND ${i}.legal_status = 'RECEIVED'
    AND NOT EXISTS (SELECT 1 FROM invoice_decisions d WHERE d.invoice_id = ${i}.id AND d.kind = 'REJECTION')`;
const LINE_TAX = (l = 'l') => `coalesce(${l}.tax_amount, round(${l}.net_amount * ${l}.tax_rate / 100, 2))`;

export const MATCH_ERROR_TR: Record<string, string> = {
  contract_not_visible: 'Sözleşme bulunamadı ya da bu sözleşmeye erişiminiz yok; fatura bağlanamadı.',
  project_mismatch: 'Faturanın projesi bağlı olduğu sözleşmenin projesiyle aynı olmalı.',
  department_mismatch: 'Sözleşmeye bağlı faturanın departmanı sözleşmenin departmanıyla aynı olmalı; departmanı değiştirmek için önce eşleşmeyi kaldırın.',
};

/** 056a `invoices_match_guard` hatası (P0001 `invoice_match_invalid: <neden>`) → 409 kendi koduyla (immutable_record değil). */
export function matchGuardError(err: { code?: unknown; message?: unknown }): { status: 409; code: 'invoice_match_invalid'; message: string; details: { reason: string } } | null {
  const msg = String(err?.message ?? '');
  if (err?.code !== 'P0001' || !msg.startsWith('invoice_match_invalid')) return null;
  const reason = msg.split(':')[1]?.trim() ?? '';
  return { status: 409, code: 'invoice_match_invalid', message: MATCH_ERROR_TR[reason] ?? 'Fatura sözleşme eşleşmesi geçersiz.', details: { reason } };
}

// --- Aile verisi --------------------------------------------------------------------------------------------------------------

interface FamilyFacts {
  id: string; code: string; title: string; contract_no: string | null; company_id: string; project_id: string | null; department_id: string | null;
  indefinite: boolean; owner_user_id: string | null; supplier_root_id: string | null; start_date: string | null; end_date: string | null;
  amount: string | null; currency: string | null; limit_basis: 'NET' | 'GROSS' | null; value_type: string | null;
}
const FAMILY_FACTS_SQL = `SELECT f.id, f.code, f.title, f.contract_no, f.company_id, f.project_id, f.department_id, f.indefinite, f.owner_user_id,
    (SELECT ${SUPPLIER_ROOT('s')} FROM suppliers s WHERE s.id = f.supplier_id) AS supplier_root_id,
    t.start_date::text AS start_date, t.end_date::text AS end_date, t.amount::text AS amount, t.currency, t.limit_basis, t.value_type
  FROM contract_families f
  LEFT JOIN LATERAL (SELECT v.id FROM contract_versions v WHERE v.family_id = f.id AND v.superseded_by_id IS NULL ORDER BY v.version_no DESC LIMIT 1) cv ON true
  LEFT JOIN LATERAL (SELECT x.* FROM contract_terms x WHERE x.contract_version_id = cv.id ORDER BY x.revision DESC LIMIT 1) t ON true`;

/** Faz 3 türetilmiş durumu (contractIntake.listInfo). Süresi dolmuş onaylı/eski kayıt (EXPIRED) eşleştirme için yürürlükte sayılır:
 *  faturanın kendi tarihi aralıkla ayrıca denetlenir (bitişten önce kesilmiş fatura sonradan girilebilir). */
async function familyStatuses(tx: Tx, ids: string[]) {
  const info = await listInfo(tx, ids);
  return new Map([...info.entries()].map(([id, v]) => [id, { status: v.status as string, statusLabel: v.statusLabel }]));
}
const matcherStatus = (s: string | undefined) => (s === 'EXPIRED' ? 'APPROVED' : s ?? 'UNKNOWN');
const inRange = (f: Pick<FamilyFacts, 'start_date' | 'end_date' | 'indefinite'>, day: string) =>
  !!f.start_date && day >= f.start_date && (f.indefinite || (f.end_date !== null && day <= f.end_date));

// --- Kullanım (R4) ------------------------------------------------------------------------------------------------------------

export interface UsageView {
  amount: string | null; currency: string; basis: 'NET' | 'GROSS'; used: string; ratio: string | null; level: UsageLevel; levelLabel: string;
  overBy: string | null; warning: string | null; foreignCurrency: { currency: string; total: string; label: string }[];
}

interface UsageRow { family_id: string; id: string; kind: string; currency: string; net: string; tax: string; matched: boolean }
/** Ailelere sayılan faturalar: saklı bağ (tüm fatura) + bağsız faturanın bu aileye tahsis edilen kısmı (vergi satır oranıyla). */
async function usageRows(tx: Tx, familyIds: string[]): Promise<UsageRow[]> {
  if (!familyIds.length) return [];
  return (await tx.query<UsageRow>(`
    SELECT i.contract_family_id::text AS family_id, i.id, i.kind, i.currency, true AS matched,
      (SELECT coalesce(sum(l.net_amount), 0) FROM invoice_lines l WHERE l.invoice_id = i.id)::numeric(20,2)::text AS net,
      (SELECT coalesce(sum(${LINE_TAX('l')}), 0) FROM invoice_lines l WHERE l.invoice_id = i.id)::numeric(20,2)::text AS tax
    FROM invoices i WHERE i.contract_family_id = ANY($1::uuid[]) AND ${COUNTED_SQL('i')}
    UNION ALL
    SELECT cv.family_id::text, i.id, i.kind, i.currency, false,
      sum(a.amount)::numeric(20,2)::text,
      sum(coalesce(round(a.amount * ${LINE_TAX('il')} / nullif(il.net_amount, 0), 2), 0))::numeric(20,2)::text
    FROM invoice_allocations a JOIN invoices i ON i.id = a.invoice_id JOIN invoice_lines il ON il.invoice_id = a.invoice_id AND il.line_no = a.line_no
      LEFT JOIN po_lines pl ON pl.id = a.po_line_id LEFT JOIN purchase_orders po ON po.id = pl.po_id
      JOIN contract_versions cv ON cv.id = coalesce(po.contract_version_id, a.contract_version_id)
    WHERE cv.family_id = ANY($1::uuid[]) AND i.contract_family_id IS NULL AND ${COUNTED_SQL('i')}
    GROUP BY cv.family_id, i.id`, [familyIds])).rows;
}

function usageView(f: Pick<FamilyFacts, 'amount' | 'currency' | 'limit_basis' | 'value_type'>, rows: UsageRow[]): UsageView {
  const currency = f.currency ?? 'TRY';
  const basis = f.limit_basis === 'GROSS' ? 'GROSS' : 'NET';
  const amount = f.value_type === 'UNPRICED' ? null : f.amount;
  const u = contractUsage({ amount, currency, basis, invoices: rows.map((r) => ({ kind: r.kind, currency: r.currency, net: r.net, tax: r.tax })) });
  const warning = u.level === 'OVER' ? `Aşım: ${trMoney(u.overBy!, currency)}` : u.level === 'NEAR' ? 'Sınıra yakın' : null;
  return { amount, currency, basis, used: u.used, ratio: u.ratio, level: u.level, levelLabel: USAGE_LEVEL_TR[u.level], overBy: u.overBy, warning,
    foreignCurrency: u.foreignCurrency.map((x) => ({ ...x, label: `${x.currency} faturalar toplama girmedi (kur çevrilmedi): ${x.total} ${x.currency}` })) };
}

export async function familyUsage(tx: Tx, familyIds: string[]): Promise<Map<string, UsageView>> {
  const ids = [...new Set(familyIds)];
  const out = new Map<string, UsageView>();
  if (!ids.length) return out;
  const facts = (await tx.query<FamilyFacts>(`${FAMILY_FACTS_SQL} WHERE f.id = ANY($1::uuid[])`, [ids])).rows;
  const rows = await usageRows(tx, ids);
  for (const f of facts) out.set(f.id, usageView(f, rows.filter((r) => r.family_id === f.id)));
  return out;
}

/**
 * İlk aşımda (R4) sözleşme sorumlusuna bir kez görev + e-posta; sorumlu yoksa Satınalma kuyruğu. Kapalı görev de "bir kez" sayılır.
 * Kullanım çağıranın kapsamında hesaplanır (aileyi görüyor); bildirim sunucu içi kuraldır: sorumlu başka departmandan olabilir ve
 * Departman kullanıcısının işlemi kişi görevini/e-postayı yazamaz, bu yüzden kısa bölüm kiracı geneli kapsamda yazılır (withTenantWideScope).
 */
async function overrunCheck(tx: Tx, ctx: TenantContext, familyId: string) {
  // Kullanım kiracı geneli kapsamda: aileye sayılan faturaların hepsi (çağıranın görmediği departmanınkiler dahil) toplanır.
  await withTenantWideScope(tx, async () => {
    const usage = (await familyUsage(tx, [familyId])).get(familyId);
    if (usage?.level === 'OVER') await notifyOverrun(tx, ctx, familyId, usage);
  });
}
/** Tahsis girişinden sonra (M1): faturanın tahsis edildiği ailelerde ilk aşım bildirimi. */
export async function overrunCheckForInvoice(tx: Tx, ctx: TenantContext, invoiceId: string) {
  const fams = (await tx.query<{ fams: string[] }>(`SELECT ${ALLOC_FAMILIES_SQL('i')} AS fams FROM invoices i WHERE i.id = $1`, [invoiceId])).rows[0]?.fams ?? [];
  for (const f of fams) await overrunCheck(tx, ctx, f);
}
async function notifyOverrun(tx: Tx, ctx: TenantContext, familyId: string, usage: UsageView) {
  const key = `overrun:${familyId}`;
  const seen = (await tx.query(`SELECT 1 FROM tasks WHERE tenant_id = $1 AND dedupe_key = $2 LIMIT 1`, [ctx.tenantId, key])).rowCount;
  if (seen) return;
  const f = (await tx.query<FamilyFacts>(`${FAMILY_FACTS_SQL} WHERE f.id = $1`, [familyId])).rows[0]!;
  const owner = f.owner_user_id ? (await tx.query<{ id: string; email: string; display_name: string; roles: string[] | null }>(
    `SELECT u.id, u.email, u.display_name, (SELECT m.roles FROM memberships m WHERE m.user_id = u.id AND m.tenant_id = $2 AND m.supplier_id IS NULL LIMIT 1) AS roles
     FROM users u WHERE u.id = $1`, [f.owner_user_id, ctx.tenantId])).rows[0] : undefined;
  const roles = normalizeRoles(owner?.roles ?? []);
  const role = !owner ? 'PROCUREMENT' : roles.includes('PROCUREMENT') ? 'PROCUREMENT' : roles.includes('DEPARTMENT_USER') ? 'DEPARTMENT_USER' : roles[0] ?? 'PROCUREMENT';
  const title = `Sözleşme tutarı aşıldı: ${f.code}`;
  const reason = `${f.title} sözleşmesine bağlı faturaların toplamı (${trMoney(usage.used, usage.currency)}) sözleşme tutarını (${trMoney(usage.amount!, usage.currency)}) aştı. ${usage.warning}.`;
  const nextAction = 'Sözleşmeyi açıp faturaları ve tutarı gözden geçirin; gerekiyorsa ek protokol ya da yeni sözleşme başlatın. Bu uyarı ödemeyi engellemez.';
  await openTask(tx, ctx, { companyId: owner ? null : f.company_id, kind: 'contract_overrun', entityType: 'contract_family', entityId: familyId,
    ...(owner ? { departmentId: null } : {}), title, reason, nextAction, assigneeRole: role, assigneeUserId: owner?.id ?? null, severity: 'HIGH', dedupeKey: key });
  let emailStatus: string | null = null;
  if (owner) {
    const m = await queueEmail(tx, ctx, { toUserId: owner.id, toEmail: owner.email, subject: title,
      body: `Sayın ${owner.display_name},\n\n${reason}\n\n${nextAction}\n\nBu ileti Satınalma Platformu tarafından hazırlanmıştır.`, relatedType: 'contract_family', relatedId: familyId });
    emailStatus = m.status;
  }
  await audit(tx, ctx, 'contract.overrun', 'contract_family', familyId, { used: usage.used, amount: usage.amount, overBy: usage.overBy, ownerUserId: owner?.id ?? null, emailStatus });
}

// --- Bağlama / bağ kaldırma -----------------------------------------------------------------------------------------------------

interface InvoiceFacts {
  id: string; company_id: string; invoice_no: string; kind: string; issue_date: string; auto_match: boolean; contract_family_id: string | null;
  match_method: MatchMethod | null; matched_by: string | null; department_id: string | null; original_invoice_id: string | null;
  supplier_root_id: string; erp_contract_ref: string | null; erp_order_ref: string | null; allocations: number; decided: string | null; unlinked: boolean;
}
async function invoiceFacts(tx: Tx, id: string): Promise<InvoiceFacts | undefined> {
  return (await tx.query<InvoiceFacts>(`SELECT i.id, i.company_id, i.invoice_no, i.kind, i.issue_date::text AS issue_date, i.auto_match, i.contract_family_id,
      i.match_method, i.matched_by, i.department_id, i.original_invoice_id, ${SUPPLIER_ROOT('s')} AS supplier_root_id, i.erp_contract_ref, i.erp_order_ref,
      (SELECT count(*)::int FROM invoice_allocations a WHERE a.invoice_id = i.id) AS allocations,
      (SELECT d.kind FROM invoice_decisions d WHERE d.invoice_id = i.id AND d.kind IN ('APPROVAL','REJECTION') LIMIT 1) AS decided,
      EXISTS (SELECT 1 FROM invoice_match_events e WHERE e.invoice_id = i.id AND e.action = 'UNLINK') AS unlinked
    FROM invoices i JOIN suppliers s ON s.id = i.supplier_id WHERE i.id = $1`, [id])).rows[0];
}

/**
 * Bağı yazar: aile, ailenin projesi ve departmanı aynı UPDATE'te (R1, §2.3); LINK olayı, denetim kaydı, kuyruk görevi kapanır,
 * departmanı değişen faturanın görevleri yeni departmanı izler, ilk aşımda görev.
 */
async function writeLink(tx: Tx, ctx: TenantContext, inv: InvoiceFacts, familyId: string, method: MatchMethod, by: string | null, note: string | null) {
  const f = (await tx.query<{ project_id: string | null; department_id: string | null; code: string }>(
    `SELECT project_id, department_id, code FROM contract_families WHERE id = $1`, [familyId])).rows[0];
  if (!f) throw notFound();
  await tx.query(`UPDATE invoices SET contract_family_id = $2, project_id = $3, department_id = $4, match_method = $5, matched_by = $6, matched_at = now(), match_note = $7
    WHERE id = $1`, [inv.id, familyId, f.project_id, f.department_id, method, by, note]);
  await tx.query(`INSERT INTO invoice_match_events (tenant_id, company_id, invoice_id, action, family_id, method, reason, actor) VALUES ($1,$2,$3,'LINK',$4,$5,$6,$7)`,
    [ctx.tenantId, inv.company_id, inv.id, familyId, method, note, by]);
  await closeTasks(tx, `invoice-unmatched:${inv.id}`);
  if (inv.department_id !== f.department_id) await rederiveTaskDepartments(tx, `t.entity_type = 'invoice' AND t.entity_id = $1`, [inv.id]);
  await audit(tx, ctx, 'invoice.matched', 'invoice', inv.id, { familyId, contractCode: f.code, method, projectId: f.project_id, departmentId: f.department_id,
    ...(inv.department_id !== f.department_id ? { departmentFrom: inv.department_id } : {}) }, note ?? undefined);
  await overrunCheck(tx, ctx, familyId);
}

/** Eşleşmeyen fatura: Satınalma kuyruğu görevi (+ departmanlıysa departman görevi). Aynı açık görev ikinci kez açılmaz. */
async function openUnmatchedTasks(tx: Tx, ctx: TenantContext, inv: Pick<InvoiceFacts, 'id' | 'company_id' | 'invoice_no' | 'department_id'>, reason: string) {
  const title = `Fatura ${inv.invoice_no}: sözleşmeyle eşleşmedi`;
  const nextAction = 'Faturalar > Eşleşmedi listesinden faturayı açıp doğru sözleşmeye bağlayın.';
  // Departman faturadan türetilir (departmanlı faturada Departman kullanıcısının kendi işleminde de RLS'e uyar; Satınalma tüm departmanları görür).
  await openTask(tx, ctx, { companyId: inv.company_id, kind: 'invoice_unmatched', entityType: 'invoice', entityId: inv.id,
    title, reason, nextAction, assigneeRole: 'PROCUREMENT', dedupeKey: `invoice-unmatched:${inv.id}` });
  if (inv.department_id) {
    await openTask(tx, ctx, { companyId: inv.company_id, kind: 'invoice_unmatched', entityType: 'invoice', entityId: inv.id, departmentId: inv.department_id,
      title, reason, nextAction, assigneeRole: 'DEPARTMENT_USER', dedupeKey: `invoice-unmatched:${inv.id}:dept` });
  }
}

export type AutoMatchResult =
  | { state: 'MATCHED'; method: MatchMethod; familyId: string }
  | { state: 'UNMATCHED'; reason: UnmatchedReason; reasonLabel: string }
  | { state: 'SKIPPED'; reason: 'auto_match_off' | 'already_matched' | 'allocated' | 'decided' | 'manually_unlinked' | 'not_found' };

/**
 * R2 otomatik eşleştirme. Yalnız `auto_match` faturada; tahsisli, kararlı, bağlı ya da elle bağı kaldırılmış faturaya dokunmaz.
 * (0) İade/alacak: özgün fatura bağlıysa onu izler. (1) ERP referansı (sipariş → aile; sözleşme kodu/no) — domain `matchInvoice`
 * referansla bulunan başka tedarikçinin sözleşmesini de görür (ref_supplier_mismatch). (2) Aynı kök tedarikçi + tarih + yürürlükte tek aile.
 * (3) Aksi halde Eşleşmedi + kuyruk görevi. Aile aynı şirketin olmalı; çağıranın görebildiği aileler (RLS) aranır.
 * Faz 8 ERP girişi aynı işlevi çağırır.
 */
export async function autoMatchInvoice(tx: Tx, ctx: TenantContext, invoiceId: string): Promise<AutoMatchResult> {
  const inv = await invoiceFacts(tx, invoiceId);
  if (!inv) return { state: 'SKIPPED', reason: 'not_found' };
  if (!inv.auto_match) return { state: 'SKIPPED', reason: 'auto_match_off' };
  if (inv.contract_family_id) return { state: 'SKIPPED', reason: 'already_matched' };
  if (inv.allocations > 0) return { state: 'SKIPPED', reason: 'allocated' };
  if (inv.decided) return { state: 'SKIPPED', reason: 'decided' };
  if (inv.unlinked) return { state: 'SKIPPED', reason: 'manually_unlinked' };
  // Karar ve yazım sunucu içi kuraldır (I1): aday arama, durum ve bağ kiracı geneli kapsamda; çağıranın departman RLS'i
  // (ör. BT kullanıcısının e-Fatura yüklemesi) eşleştirme sonucunu değiştirmez. Fatura departmanı bağlanan sözleşmeninkini alır.
  return withTenantWideScope(tx, () => decideAndWrite(tx, ctx, inv));
}

async function decideAndWrite(tx: Tx, ctx: TenantContext, inv: InvoiceFacts): Promise<AutoMatchResult> {
  let errorCode: string | null = null;
  let decision: { method: MatchMethod; familyId: string; by: string | null; note: string | null } | { reason: UnmatchedReason } | null = null;
  if (inv.kind === 'CREDIT_NOTE' && inv.original_invoice_id) {
    const o = (await tx.query<{ contract_family_id: string | null; match_method: MatchMethod | null; matched_by: string | null; invoice_no: string }>(
      `SELECT contract_family_id, match_method, matched_by, invoice_no FROM invoices WHERE id = $1`, [inv.original_invoice_id])).rows[0];
    if (o?.contract_family_id) decision = { method: o.match_method!, familyId: o.contract_family_id, by: o.match_method === 'MANUAL' ? o.matched_by : null,
      note: `Özgün fatura ${o.invoice_no} eşleşmesini izler.` };
  }
  if (!decision) {
    // Ön süzgeç (aday aileler): domain `normalizeRef` ile aynı biçim (kırpılmış, yalnız ASCII a–z büyük harf); kesin karşılaştırma domain'de.
    const refs = [inv.erp_contract_ref, inv.erp_order_ref].map((x) => normalizeRef(x));
    // v2 Faz 8 (D113): sipariş referansı v1 siparişte yoksa ERP'den okunan siparişin (erp_purchase_orders.po_no) sözleşme referansıyla
    // (aynı şirkette tek aile: kod ya da sözleşme no) çözülür. v1 satırı varsa yalnız o konuşur (eski davranış aynen). ERP'de aynı numaralı
    // siparişler farklı ailelere (ya da biri aileye, biri hiçbirine) çıkıyorsa referans belirsizdir: çözülmemiş sayılır (Eşleşmedi kuyruğu).
    let orders: { code: string; familyId: string | null }[] = [];
    if (inv.erp_order_ref) {
      const rows = (await tx.query<{ src: number; code: string; familyId: string | null }>(`SELECT 0 AS src, po.code, cv.family_id AS "familyId" FROM purchase_orders po
          LEFT JOIN contract_versions cv ON cv.id = po.contract_version_id WHERE ${ASCII_UPPER('po.code')} = $1
        UNION ALL
        SELECT 1 AS src, ep.po_no AS code, (SELECT CASE WHEN count(*) = 1 THEN min(f.id::text)::uuid END FROM contract_families f
            WHERE f.company_id = $2 AND (${ASCII_UPPER('f.code')} = ${ASCII_UPPER('ep.contract_ref')} OR ${ASCII_UPPER('f.contract_no')} = ${ASCII_UPPER('ep.contract_ref')})) AS "familyId"
          FROM erp_purchase_orders ep WHERE ${ASCII_UPPER('ep.po_no')} = $1
        ORDER BY src, code`, [refs[1], inv.company_id])).rows;
      const v1 = rows.filter((r) => r.src === 0);
      const erp = rows.filter((r) => r.src === 1);
      if (v1.length) orders = v1.map(({ code, familyId }) => ({ code, familyId }));
      else if (erp.length) {
        const fams = new Set(erp.map((r) => r.familyId));
        orders = [{ code: erp[0]!.code, familyId: fams.size === 1 ? erp[0]!.familyId : null }];
      }
    }
    const facts = (await tx.query<FamilyFacts>(`${FAMILY_FACTS_SQL} WHERE f.company_id = $1 AND (
        (SELECT ${SUPPLIER_ROOT('s')} FROM suppliers s WHERE s.id = f.supplier_id) = $2
        OR ($3 <> '' AND (${ASCII_UPPER('f.code')} = $3 OR ${ASCII_UPPER('f.contract_no')} = $3)) OR f.id = ANY($4::uuid[]))`,
      [inv.company_id, inv.supplier_root_id, refs[0], orders.map((o) => o.familyId).filter(Boolean)])).rows;
    const statuses = await familyStatuses(tx, facts.map((f) => f.id));
    const contracts: LinkContract[] = facts.map((f) => ({ familyId: f.id, code: f.code, contractNo: f.contract_no, supplierRootId: f.supplier_root_id ?? '',
      start: f.start_date, end: f.end_date, indefinite: f.indefinite, status: matcherStatus(statuses.get(f.id)?.status), projectId: f.project_id, departmentId: f.department_id }));
    const r = matchInvoice({ invoice: { supplierRootId: inv.supplier_root_id, issueDate: inv.issue_date, erpContractRef: inv.erp_contract_ref, erpOrderRef: inv.erp_order_ref },
      contracts, orders });
    decision = r.method === 'UNMATCHED' ? { reason: r.reason } : { method: r.method, familyId: r.familyId, by: null, note: null };
  }

  if ('familyId' in decision) {
    // Bağ yazılamazsa (ör. RLS ya da tetikleyici) fatura kaydı düşmez: bağ geri alınır, fatura kuyruğa düşer.
    await tx.query('SAVEPOINT invoice_auto_match');
    try {
      await writeLink(tx, ctx, inv, decision.familyId, decision.method, decision.by, decision.note);
      await tx.query('RELEASE SAVEPOINT invoice_auto_match');
      return { state: 'MATCHED', method: decision.method, familyId: decision.familyId };
    } catch (e) {
      await tx.query('ROLLBACK TO SAVEPOINT invoice_auto_match');
      if (e instanceof ApiError) throw e;
      // M2: karar verildi ama yazılamadı; yalnız hata kodu denetime yazılır (ileti/ayrıntı değil).
      errorCode = typeof (e as { code?: unknown })?.code === 'string' ? (e as { code: string }).code : 'unknown';
      decision = { reason: 'link_failed' };
    }
  }
  const reason = decision.reason;
  const last = (await tx.query<{ action: string; reason: string | null }>(`SELECT action, reason FROM invoice_match_events WHERE invoice_id = $1 ORDER BY at DESC, id DESC LIMIT 1`, [inv.id])).rows[0];
  // Aynı sebeple tekrar deneme olay günlüğünü şişirmez.
  if (!(last?.action === 'AUTO_FAILED' && last.reason === reason)) {
    await tx.query(`INSERT INTO invoice_match_events (tenant_id, company_id, invoice_id, action, reason) VALUES ($1,$2,$3,'AUTO_FAILED',$4)`, [ctx.tenantId, inv.company_id, inv.id, reason]);
    await audit(tx, ctx, 'invoice.match_failed', 'invoice', inv.id, { reason, ...(errorCode ? { errorCode } : {}) });
  }
  await openUnmatchedTasks(tx, ctx, inv, MATCH_REASON_TR[reason]);
  return { state: 'UNMATCHED', reason, reasonLabel: MATCH_REASON_TR[reason] };
}

/** "Kuyruğu yeniden dene": yalnız `auto_match` + bağsız + tahsissiz + kararsız faturalar (çağıranın gördükleri). */
export async function retryMatchQueue(tx: Tx, ctx: TenantContext) {
  const ids = (await tx.query<{ id: string }>(`SELECT i.id FROM invoices i WHERE i.auto_match AND i.contract_family_id IS NULL
      AND NOT EXISTS (SELECT 1 FROM invoice_allocations a WHERE a.invoice_id = i.id)
      AND NOT EXISTS (SELECT 1 FROM invoice_decisions d WHERE d.invoice_id = i.id AND d.kind IN ('APPROVAL','REJECTION'))
      AND NOT EXISTS (SELECT 1 FROM invoice_match_events e WHERE e.invoice_id = i.id AND e.action = 'UNLINK')
    ORDER BY i.created_at LIMIT 500`)).rows.map((r) => r.id);
  const res = { checked: ids.length, matched: 0, unmatched: 0, skipped: 0 };
  for (const id of ids) {
    const r = await autoMatchInvoice(tx, ctx, id);
    if (r.state === 'MATCHED') res.matched++; else if (r.state === 'UNMATCHED') res.unmatched++; else res.skipped++;
  }
  await audit(tx, ctx, 'invoice.match_queue_retried', 'tenant', ctx.tenantId, res);
  return res;
}

/** Bağlanabilir mi (R3): tahsisli/kararlı faturada 409; departman kullanıcısı yalnız kendi departmanındaki sözleşmeye. */
function assertLinkable(inv: InvoiceFacts) {
  if (inv.decided) throw conflict('invoice_decided', 'Karar verilmiş faturanın eşleşmesi değiştirilemez.');
  if (inv.allocations > 0) throw conflict('invoice_allocated', 'Bu fatura satır tahsisiyle sözleşmeye bağlı (eski kayıt); eşleşme tahsisten türetilir. Elle bağlamak için önce tahsisi kaldırın.');
}
const ownsDepartment = (ctx: TenantContext, departmentId: string | null) => ctx.allDepartments || (departmentId !== null && ctx.departmentIds.includes(departmentId));

export async function linkInvoice(tx: Tx, ctx: TenantContext, invoiceId: string, b: { familyId: string; acknowledgeOutOfRange?: boolean; note?: string | null }) {
  await tx.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`invoice-match:${invoiceId}`]);
  const inv = await invoiceFacts(tx, invoiceId);
  if (!inv) throw notFound();
  assertLinkable(inv);
  if (inv.contract_family_id) throw conflict('invoice_already_matched', 'Fatura zaten bir sözleşmeye bağlı; başka sözleşmeye bağlamak için önce eşleşmeyi kaldırın.');
  const f = (await tx.query<FamilyFacts>(`${FAMILY_FACTS_SQL} WHERE f.id = $1`, [b.familyId])).rows[0];
  if (!f) throw notFound();
  if (!ownsDepartment(ctx, f.department_id)) throw new ApiError(403, 'department_forbidden', 'Yalnız kendi departmanınızdaki sözleşmeye fatura bağlayabilirsiniz.');
  if (f.company_id !== inv.company_id) throw unprocessable('contract_company_mismatch', 'Sözleşme faturanın şirketine ait değil; fatura bağlanamaz.');
  if (!f.supplier_root_id || f.supplier_root_id !== inv.supplier_root_id) throw unprocessable('contract_supplier_mismatch', 'Sözleşmenin tedarikçisi faturanın tedarikçisiyle aynı değil; fatura bağlanamaz.');
  if (!inRange(f, inv.issue_date) && !b.acknowledgeOutOfRange) {
    throw unprocessable('out_of_range_ack_required', `Fatura tarihi (${trDate(inv.issue_date)}) sözleşme süresinin dışında (${trDate(f.start_date) ?? 'başlangıç yok'} – ${f.indefinite ? 'süresiz' : trDate(f.end_date) ?? 'bitiş yok'}). Yine de bağlamak için onaylayın.`,
      { start: f.start_date, end: f.end_date, indefinite: f.indefinite, issueDate: inv.issue_date });
  }
  const note = b.note?.trim() || null;
  await writeLink(tx, ctx, inv, f.id, 'MANUAL', ctx.userId, note);
  return { ...(await matchInfo(tx, invoiceId)) };
}

export async function unlinkInvoice(tx: Tx, ctx: TenantContext, invoiceId: string, b: { reason: string }) {
  await tx.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`invoice-match:${invoiceId}`]);
  const inv = await invoiceFacts(tx, invoiceId);
  if (!inv) throw notFound();
  const reason = (b.reason ?? '').trim();
  if (reason.length < 10) throw unprocessable('reason_required', 'Eşleşmeyi kaldırma gerekçesi gerekli (en az 10 karakter).');
  if (!inv.contract_family_id) throw conflict('invoice_not_matched', 'Fatura bir sözleşmeye bağlı değil.');
  if (inv.decided) throw conflict('invoice_decided', 'Karar verilmiş faturanın eşleşmesi değiştirilemez.');
  const f = (await tx.query<{ department_id: string | null }>(`SELECT department_id FROM contract_families WHERE id = $1`, [inv.contract_family_id])).rows[0];
  if (!f) throw notFound();
  if (!ownsDepartment(ctx, f.department_id)) throw new ApiError(403, 'department_forbidden', 'Yalnız kendi departmanınızdaki sözleşmenin eşleşmesini kaldırabilirsiniz.');
  await clearLink(tx, ctx, inv, reason);
  await openUnmatchedTasks(tx, ctx, inv, `Eşleşme kaldırıldı: ${reason}`);
  return { ...(await matchInfo(tx, invoiceId)) };
}

/** Bağın beş sütunu (aile, proje, yöntem, yapan, zaman) ve not birlikte boşalır; departman faturada kalır. UNLINK olayı + denetim. */
async function clearLink(tx: Tx, ctx: TenantContext, inv: InvoiceFacts, reason: string) {
  await tx.query(`UPDATE invoices SET contract_family_id = NULL, project_id = NULL, match_method = NULL, matched_by = NULL, matched_at = NULL, match_note = NULL WHERE id = $1`, [inv.id]);
  await tx.query(`INSERT INTO invoice_match_events (tenant_id, company_id, invoice_id, action, family_id, reason, actor) VALUES ($1,$2,$3,'UNLINK',$4,$5,$6)`,
    [ctx.tenantId, inv.company_id, inv.id, inv.contract_family_id, reason, ctx.userId]);
  await audit(tx, ctx, 'invoice.unmatched', 'invoice', inv.id, { familyId: inv.contract_family_id, method: inv.match_method }, reason);
}

/**
 * Tahsis düzenlemesi bağlı faturada (Görev 2 devri): elle bağ → 409 `invoice_matched`; otomatik bağ (ERP/tedarikçi+tarih) tahsisle
 * aynı işlemde gerekçeli olarak kaldırılır (eşleşme bundan sonra tahsisten türetilir). Tahsis boşaltılıyorsa bağa dokunulmaz.
 */
export async function releaseLinkForAllocation(tx: Tx, ctx: TenantContext, invoiceId: string, allocating: boolean): Promise<string | null> {
  if (!allocating) return null;
  const inv = await invoiceFacts(tx, invoiceId);
  if (!inv?.contract_family_id) return null;
  if (inv.match_method === 'MANUAL') {
    throw conflict('invoice_matched', 'Fatura elle bir sözleşmeye bağlı; satır tahsisi girmeden önce eşleşmeyi gerekçesiyle kaldırın.', { familyId: inv.contract_family_id });
  }
  await clearLink(tx, ctx, inv, 'Satır tahsisi girildi; eşleşme bundan sonra tahsisten türetilir.');
  await closeTasks(tx, `invoice-unmatched:${invoiceId}`);
  return inv.contract_family_id;
}

// --- Okuma --------------------------------------------------------------------------------------------------------------------

/** Fatura detayındaki eşleşme bölümü (R1, R11): durum, yöntem, sözleşme, proje, referanslar, son otomatik deneme, kullanım. */
export async function matchInfo(tx: Tx, invoiceId: string) {
  const r = (await tx.query<{ family_id: string | null; method: MatchMethod | null; note: string | null; matched_at: Date | null; matched_by: string | null;
    auto_match: boolean; erp_contract_ref: string | null; erp_order_ref: string | null; erp_contract_ref_source: string | null; erp_order_ref_source: string | null;
    fam_code: string | null; fam_title: string | null; project_id: string | null; pr_code: string | null; pr_title: string | null; alloc_families: string[] }>(
    `SELECT i.contract_family_id AS family_id, i.match_method AS method, i.match_note AS note, i.matched_at, u.display_name AS matched_by, i.auto_match,
      i.erp_contract_ref, i.erp_order_ref, i.erp_contract_ref_source, i.erp_order_ref_source,
      f.code AS fam_code, f.title AS fam_title, i.project_id, p.code AS pr_code, p.title AS pr_title, ${ALLOC_FAMILIES_SQL('i')} AS alloc_families
    FROM invoices i LEFT JOIN contract_families f ON f.id = i.contract_family_id LEFT JOIN projects p ON p.id = i.project_id LEFT JOIN users u ON u.id = i.matched_by
    WHERE i.id = $1`, [invoiceId])).rows[0];
  if (!r) throw notFound();
  const state: MatchState = matchState({ familyId: r.family_id, allocationFamilies: r.alloc_families });
  const fail = (await tx.query<{ reason: string; at: Date }>(`SELECT reason, at FROM invoice_match_events WHERE invoice_id = $1 AND action = 'AUTO_FAILED' ORDER BY at DESC, id DESC LIMIT 1`, [invoiceId])).rows[0];
  const usageFamily = r.family_id ?? (state === 'ALLOCATED' ? r.alloc_families[0]! : null);
  let contract = r.family_id ? { id: r.family_id, code: r.fam_code, title: r.fam_title } : null;
  if (!contract && usageFamily) {
    const f = (await tx.query<{ code: string; title: string }>(`SELECT code, title FROM contract_families WHERE id = $1`, [usageFamily])).rows[0];
    contract = f ? { id: usageFamily, code: f.code, title: f.title } : null;
  }
  const usage = usageFamily ? (await familyUsage(tx, [usageFamily])).get(usageFamily) ?? null : null;
  return {
    state, stateLabel: MATCH_STATE_TR[state], method: r.method, methodLabel: r.method ? MATCH_METHOD_TR[r.method] : null, note: r.note,
    matchedAt: r.matched_at, matchedBy: r.matched_by, autoMatch: r.auto_match,
    contract, project: r.project_id ? { id: r.project_id, code: r.pr_code, title: r.pr_title } : null,
    erpContractRef: r.erp_contract_ref, erpOrderRef: r.erp_order_ref, erpContractRefSource: r.erp_contract_ref_source, erpOrderRefSource: r.erp_order_ref_source,
    lastAutoFailure: state === 'UNMATCHED' && fail ? { reason: fail.reason, reasonLabel: MATCH_REASON_TR[fail.reason as UnmatchedReason] ?? 'Otomatik eşleştirme yapılamadı', at: fail.at } : null,
    usage,
  };
}

/** Elle bağlama adayları: aynı şirket ve kök tedarikçinin (görülen) sözleşmeleri; yürürlükte + tarih uyumlu önce, kullanım ile. */
export async function matchCandidates(tx: Tx, ctx: TenantContext, invoiceId: string) {
  const inv = await invoiceFacts(tx, invoiceId);
  if (!inv) throw notFound();
  const facts = (await tx.query<FamilyFacts>(`${FAMILY_FACTS_SQL} WHERE f.company_id = $1 AND (SELECT ${SUPPLIER_ROOT('s')} FROM suppliers s WHERE s.id = f.supplier_id) = $2
    ORDER BY f.created_at DESC LIMIT 200`, [inv.company_id, inv.supplier_root_id])).rows;
  const statuses = await familyStatuses(tx, facts.map((f) => f.id));
  const usage = await familyUsage(tx, facts.map((f) => f.id));
  const projects = new Map((await tx.query<{ id: string; code: string; title: string }>(`SELECT id, code, title FROM projects WHERE id = ANY($1::uuid[])`,
    [facts.map((f) => f.project_id).filter(Boolean)])).rows.map((p) => [p.id, p]));
  const items = facts.map((f) => {
    const st = statuses.get(f.id);
    const active = ['APPROVED', 'LEGACY', 'EXPIRED'].includes(st?.status ?? '');
    const dateOk = inRange(f, inv.issue_date);
    const linkable = ownsDepartment(ctx, f.department_id);
    return { familyId: f.id, code: f.code, title: f.title, contractNo: f.contract_no, status: st?.status ?? null, statusLabel: st?.statusLabel ?? null,
      active, startDate: f.start_date, endDate: f.end_date, indefinite: f.indefinite, inRange: dateOk,
      project: f.project_id ? projects.get(f.project_id) ?? null : null, departmentId: f.department_id, usage: usage.get(f.id) ?? null,
      canLink: linkable && !inv.decided && inv.allocations === 0 && !inv.contract_family_id,
      ...(linkable ? {} : { cannotLinkReason: 'Başka departmanın sözleşmesi; yalnız kendi departmanınızdaki sözleşmeye bağlayabilirsiniz.' }) };
  });
  const rank = (x: (typeof items)[number]) => (x.active ? 0 : 2) + (x.inRange ? 0 : 1);
  items.sort((a, b) => rank(a) - rank(b));
  return { invoice: { id: inv.id, invoiceNo: inv.invoice_no, issueDate: inv.issue_date, state: inv.contract_family_id ? 'MATCHED' : null }, items,
    blocked: inv.decided ? 'invoice_decided' : inv.allocations > 0 ? 'invoice_allocated' : inv.contract_family_id ? 'invoice_already_matched' : null };
}

/** Sözleşme faturaları (Faz 3 ucu genişletilir, Ruling 3): tahsisli kalemler aynen + bağlı faturalar; kullanım (R4). */
export async function contractInvoices(tx: Tx, familyId: string) {
  const base = await familyInvoices(tx, familyId);
  const allocRows = await tx.query<{ id: string; fams: string[] }>(`SELECT i.id, ${ALLOC_FAMILIES_SQL('i')} AS fams FROM invoices i WHERE i.id = ANY($1::uuid[])`,
    [base.items.map((x) => x.id)]);
  const famsOf = new Map(allocRows.rows.map((r) => [r.id, r.fams]));
  const allocated = base.items.map((x) => {
    const s = matchState({ familyId: null, allocationFamilies: famsOf.get(x.id) ?? [] });
    return { ...x, matchState: s, matchStateLabel: MATCH_STATE_TR[s], matchMethod: null, matchMethodLabel: null };
  });
  const linked = (await tx.query<{ id: string; invoiceNo: string; issueDate: string; currency: string; kind: string; supplierId: string; supplierName: string;
    amount: string; approved: boolean; decision: string | null; method: MatchMethod }>(
    `SELECT i.id, i.invoice_no AS "invoiceNo", i.issue_date::text AS "issueDate", i.currency, i.kind, s.id AS "supplierId", s.legal_name AS "supplierName",
       (CASE i.kind WHEN 'CREDIT_NOTE' THEN -1 ELSE 1 END * (SELECT coalesce(sum(l.net_amount), 0) FROM invoice_lines l WHERE l.invoice_id = i.id))::numeric(20,2)::text AS amount,
       (EXISTS (SELECT 1 FROM invoice_decisions d WHERE d.invoice_id = i.id AND d.kind = 'APPROVAL') AND i.legal_status = 'RECEIVED') AS approved,
       (SELECT d.kind FROM invoice_decisions d WHERE d.invoice_id = i.id AND d.kind IN ('APPROVAL','REJECTION') ORDER BY d.decided_at DESC, d.id DESC LIMIT 1) AS decision,
       i.match_method AS method
     FROM invoices i JOIN suppliers s ON s.id = i.supplier_id WHERE i.contract_family_id = $1 AND i.kind <> 'ADVANCE'
     ORDER BY i.issue_date DESC, i.invoice_no LIMIT 200`, [familyId])).rows.map((r) => ({
    id: r.id, invoiceNo: r.invoiceNo, date: r.issueDate, kind: r.kind, supplier: { id: r.supplierId, legalName: r.supplierName }, amount: r.amount, currency: r.currency,
    ...(r.approved ? { status: 'APPROVED', statusLabel: 'Onaylandı (tüketime sayılır)' } : r.decision === 'REJECTION' ? { status: 'REJECTED', statusLabel: 'Reddedildi' }
      : { status: 'PENDING', statusLabel: 'Karar bekliyor' }),
    matchState: 'MATCHED' as MatchState, matchStateLabel: MATCH_STATE_TR.MATCHED, matchMethod: r.method, matchMethodLabel: MATCH_METHOD_TR[r.method],
  }));
  const items = [...allocated, ...linked].sort((a, b) => (a.date === b.date ? a.invoiceNo.localeCompare(b.invoiceNo) : a.date < b.date ? 1 : -1));
  const usage = (await familyUsage(tx, [familyId])).get(familyId) ?? null;
  return { items, usage };
}

/** Proje faturaları (R4): projenin (görülen) sözleşmelerine bağlı ya da tahsisli faturalar, sözleşme başına kullanım. */
export async function projectInvoices(tx: Tx, projectId: string) {
  const p = (await tx.query<{ id: string }>(`SELECT id FROM projects WHERE id = $1`, [projectId])).rows[0];
  if (!p) throw notFound();
  const fams = (await tx.query<{ id: string; code: string; title: string }>(`SELECT id, code, title FROM contract_families WHERE project_id = $1 ORDER BY created_at`, [projectId])).rows;
  const items: unknown[] = [];
  const contracts: { contract: { id: string; code: string; title: string }; usage: UsageView | null; invoiceCount: number }[] = [];
  for (const f of fams) {
    const r = await contractInvoices(tx, f.id);
    for (const x of r.items) items.push({ ...x, contract: { id: f.id, code: f.code, title: f.title } });
    contracts.push({ contract: f, usage: r.usage, invoiceCount: r.items.length });
  }
  return { items, usage: contracts };
}

/** Liste sayaçları (Figma 17): süzgeçle aynı türetme; departman süzgecine uyar, satır sınırı yok. */
export async function matchCounts(tx: Tx, f: { departmentId?: string }) {
  const r = (await tx.query<{ state: MatchState; n: number }>(`SELECT ${MATCH_STATE_SQL('i')} AS state, count(*)::int AS n FROM invoices i
    WHERE ($1::uuid IS NULL OR i.department_id = $1) GROUP BY 1`, [f.departmentId ?? null])).rows;
  const by = Object.fromEntries((['MATCHED', 'ALLOCATED', 'MIXED', 'UNMATCHED'] as const).map((s) => [s, r.find((x) => x.state === s)?.n ?? 0])) as Record<MatchState, number>;
  return { all: by.MATCHED + by.ALLOCATED + by.MIXED + by.UNMATCHED, matched: by.MATCHED + by.ALLOCATED + by.MIXED, unmatched: by.UNMATCHED, byState: by };
}
