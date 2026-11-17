import {
  addDays, contractStatus, missingRequired, planChain, reminderDates, termsDiff, normalizeRoles,
  CONTRACT_TYPE_TR, REQUIRED_FIELD_TR, STEP_KIND_TR,
  type ChainSummary, type CommercialTerms, type ContractFields, type ContractStatus, type ContractType, type NoticeUnit, type RequiredField, type StepKind,
} from '@sp/domain';
import type { TenantContext, Tx } from '../db.ts';
import { audit } from '../audit.ts';
import { closeTasks, openTask, rederiveTaskDepartments } from '../tasks.ts';
import { ApiError, conflict, notFound, unprocessable } from '../errors.ts';
import { createContract } from './contracts.ts';
import { saveTerms } from './contractTerms.ts';
import { currentApprovers } from './approvers.ts';
import { resolveDepartment } from './departments.ts';
import { noticeBasis } from './contractReminders.ts';

/**
 * v2 Faz 3 (D108+, R1–R5, R9, R10) Görev 4: sözleşme ekleme akışı. Taslak (aile + MAIN sürüm, proje zorunlu), zorunlu alanlar
 * (aile sütunları + koşul revizyonu, `saveTerms` yeniden kullanılır), türetilmiş durum, onay zinciri önizlemesi ve gönderimi.
 * Durum saklanmaz: `contractStatus` ile alanlardan ve zincir kayıtlarından türetilir.
 *
 * Eski kayıt (R1 LEGACY): `intake_flow = false` (aile ekleme akışıyla açılmadı: Faz 3 öncesi ya da eski POST /contracts ucu) ve hiç onay
 * zinciri yok. Zorunlu alan eksikse durum yine `INCOMPLETE`; alanlar tamamlanınca `LEGACY` görünür ve onaya gönderilebilir.
 */

const today = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Istanbul' }).format(new Date());
const UNIT_TR: Record<NoticeUnit, string> = { DAY: 'gün', MONTH: 'ay' };
const noticeLabel = (amount: number | null, unit: NoticeUnit | null) => (amount != null && unit ? `${amount} ${UNIT_TR[unit]}` : null);
const INTAKE_REASON = 'Sözleşme ekleme akışı';
export const CONTENT_CHANGED_REASON = 'İçerik değişti, onay baştan.';
/** D107: onaycı yalnız etkin, Satınalma ya da Departman kullanıcısı rolündeki iç kişidir. */
const APPROVER_ROLES = ['PROCUREMENT', 'DEPARTMENT_USER'];

interface FamilyRow {
  id: string; code: string; title: string; company_id: string; department_id: string | null; department_name: string | null;
  created_by: string; created_by_name: string | null; created_at: Date; project_id: string | null; supplier_id: string | null;
  contract_type: ContractType | null; owner_user_id: string | null; signed_on: string | null; template_version_id: string | null;
  indefinite: boolean; contract_no: string | null; governing_court: string | null; kvkk_clause: boolean | null; price_escalation: string | null;
  intake_flow: boolean; termination_notice_amount: number | null; termination_notice_unit: NoticeUnit | null;
  // Güncel sürüm ve onun son koşul revizyonu
  version_id: string | null; version_no: number | null;
  terms_id: string | null; terms_revision: number | null; currency: string | null; value_type: CommercialTerms['valueType'] | null; amount: string | null;
  payment_terms: string | null; start_date: string | null; end_date: string | null; auto_renewal: boolean | null; renewal_months: number | null;
  notice_amount: number | null; notice_unit: NoticeUnit | null; non_working_day_rule: CommercialTerms['nonWorkingDay'] | null; source_ref: string | null;
  limit_basis: 'NET' | 'GROSS' | null; payment_days: number | null; fx_difference: 'ALLOWED' | 'NOT_ALLOWED' | null; terms_verified_at: Date | null;
}

const FAMILY_SQL = `SELECT f.id, f.code, f.title, f.company_id, f.department_id, d.name AS department_name, f.created_by, cu.display_name AS created_by_name,
    f.created_at, f.project_id, f.supplier_id, f.contract_type, f.owner_user_id, f.signed_on::text, f.template_version_id, f.indefinite, f.contract_no,
    f.governing_court, f.kvkk_clause, f.price_escalation, f.intake_flow, f.termination_notice_amount, f.termination_notice_unit,
    cv.id AS version_id, cv.version_no,
    t.id AS terms_id, t.revision AS terms_revision, t.currency, t.value_type, t.amount::text, t.payment_terms, t.start_date::text, t.end_date::text,
    t.auto_renewal, t.renewal_months, t.notice_amount, t.notice_unit, t.non_working_day_rule, t.source_ref, t.limit_basis, t.payment_days, t.fx_difference,
    t.verified_at AS terms_verified_at
  FROM contract_families f
  LEFT JOIN departments d ON d.id = f.department_id
  LEFT JOIN users cu ON cu.id = f.created_by
  LEFT JOIN LATERAL (SELECT v.id, v.version_no FROM contract_versions v WHERE v.family_id = f.id AND v.superseded_by_id IS NULL
                     ORDER BY v.version_no DESC LIMIT 1) cv ON true
  LEFT JOIN LATERAL (SELECT x.* FROM contract_terms x WHERE x.contract_version_id = cv.id ORDER BY x.revision DESC LIMIT 1) t ON true`;

async function familyRows(tx: Tx, ids: string[]): Promise<FamilyRow[]> {
  if (!ids.length) return [];
  return (await tx.query<FamilyRow>(`${FAMILY_SQL} WHERE f.id = ANY($1::uuid[])`, [ids])).rows;
}

async function loadFamily(tx: Tx, id: string): Promise<FamilyRow> {
  const f = (await familyRows(tx, [id]))[0];
  if (!f) throw notFound();
  return f;
}

function fieldsOf(f: FamilyRow): ContractFields {
  const hasTerms = f.terms_id != null;
  return {
    project: f.project_id, supplier: f.supplier_id, contractType: f.contract_type, owner: f.owner_user_id, signedOn: f.signed_on,
    // Bedelsiz (UNPRICED) sözleşmede tutar girilmez; zorunlu alan sayılmaz.
    amount: f.value_type === 'UNPRICED' ? 'UNPRICED' : f.amount,
    currency: f.currency, limitBasis: hasTerms ? f.limit_basis : null, startDate: f.start_date, endDate: f.end_date, indefinite: f.indefinite,
    autoRenewal: hasTerms ? f.auto_renewal : null,
    noticePeriod: f.indefinite ? noticeLabel(f.termination_notice_amount, f.termination_notice_unit) : noticeLabel(f.notice_amount, f.notice_unit),
  };
}

interface ChainRow {
  id: string; family_id: string; version_id: string; terms_id: string; submitted_by: string; submitted_by_name: string | null; submitted_at: Date;
  note: string | null; closed_at: Date | null; outcome: 'APPROVED' | 'REJECTED' | 'CANCELLED' | null; cancel_reason: string | null; next_kind: StepKind | null;
}

async function chainRows(tx: Tx, familyIds: string[]): Promise<Map<string, ChainRow[]>> {
  const out = new Map<string, ChainRow[]>();
  if (!familyIds.length) return out;
  const rows = (await tx.query<ChainRow>(`SELECT c.id, c.family_id, c.version_id, c.terms_id, c.submitted_by, u.display_name AS submitted_by_name, c.submitted_at,
      c.note, c.closed_at, c.outcome, c.cancel_reason,
      (SELECT s.kind FROM contract_approval_steps s WHERE s.chain_id = c.id AND s.decision IS NULL ORDER BY s.step_order LIMIT 1) AS next_kind
    FROM contract_approval_chains c LEFT JOIN users u ON u.id = c.submitted_by
    WHERE c.family_id = ANY($1::uuid[]) ORDER BY c.submitted_at, c.id`, [familyIds])).rows;
  for (const r of rows) out.set(r.family_id, [...(out.get(r.family_id) ?? []), r]);
  return out;
}

/**
 * Zincir özeti. Onaylanan zincirin sürümü ailenin güncel sürümü değilse (onaydan sonra yeni sürüm eklendi) onay güncel belgeyi
 * kapsamaz: özet "iptal" sayılır ve durum Taslak (yeniden onay gerekir) türetilir.
 */
const summary = (c: ChainRow, currentVersionId: string | null): ChainSummary =>
  !c.closed_at ? { status: 'OPEN', nextStepKind: c.next_kind }
    : c.outcome === 'APPROVED' && c.version_id !== currentVersionId ? { status: 'CANCELLED' } : { status: c.outcome! };

/** Son zincir güncel sürüm için onaylandı mı: bu durumda alanlar değişmez, yeniden gönderilmez (değişiklik yeni sürümle). */
const approvedCurrent = (f: FamilyRow, chains: ChainRow[]) => {
  const l = chains.at(-1);
  return !!l && l.outcome === 'APPROVED' && l.version_id === f.version_id;
};

function statusOf(f: FamilyRow, chains: ChainRow[], day = today()) {
  const missing = missingRequired(fieldsOf(f));
  // Eski kayıt: Faz 3 geçişinden (051a) önce açılmış (intake_flow false) ve hiç onay zinciri yok.
  const legacy = !f.intake_flow && chains.length === 0;
  const s = contractStatus({ missing, chains: chains.map((c) => summary(c, f.version_id)), legacy, endDate: f.end_date, indefinite: f.indefinite, today: day });
  return { missing, legacy, code: s.code, label: s.label };
}

/** Liste alanları (GET /contracts eki): durum, proje, bitiş, tutar. Görünmeyen (RLS) proje boş döner; durum proje kimliğinden türetilir. */
export async function listInfo(tx: Tx, familyIds: string[]) {
  const fams = await familyRows(tx, familyIds);
  const chains = await chainRows(tx, familyIds);
  const projects = new Map((await tx.query<{ id: string; code: string; title: string }>(`SELECT id, code, title FROM projects WHERE id = ANY($1::uuid[])`,
    [fams.map((f) => f.project_id).filter(Boolean)])).rows.map((p) => [p.id, p]));
  const suppliers = new Map((await tx.query<{ id: string; legal_name: string; status: string }>(`SELECT id, legal_name, status FROM suppliers WHERE id = ANY($1::uuid[])`,
    [fams.map((f) => f.supplier_id).filter(Boolean)])).rows.map((s) => [s.id, s]));
  const day = today();
  const out = new Map<string, { status: ContractStatus; statusLabel: string; project: { id: string; code: string; title: string } | null;
    supplier: { id: string; legalName: string; status: string } | null; endDate: string | null; indefinite: boolean; amount: string | null; currency: string | null }>();
  for (const f of fams) {
    const s = statusOf(f, chains.get(f.id) ?? [], day);
    const sup = f.supplier_id ? suppliers.get(f.supplier_id) : undefined;
    out.set(f.id, { status: s.code, statusLabel: s.label, project: f.project_id ? projects.get(f.project_id) ?? null : null,
      supplier: sup ? { id: sup.id, legalName: sup.legal_name, status: sup.status } : null,
      endDate: f.end_date, indefinite: f.indefinite, amount: f.amount, currency: f.currency });
  }
  return out;
}

/** Liste süzgeci (Tümü/Onayda/Yürürlükte/90 gün içinde biten/Eksik alan). Yürürlükte = onaylı ya da eski kayıt (R1). */
export type StatusFilter = 'ALL' | 'IN_APPROVAL' | 'ACTIVE' | 'ENDING_90' | 'INCOMPLETE';
export function matchesFilter(filter: StatusFilter, i: { status: ContractStatus; endDate: string | null; indefinite: boolean }, day = today()): boolean {
  const active = i.status === 'APPROVED' || i.status === 'LEGACY';
  switch (filter) {
    case 'ALL': return true;
    case 'IN_APPROVAL': return i.status === 'IN_APPROVAL';
    case 'ACTIVE': return active;
    case 'INCOMPLETE': return i.status === 'INCOMPLETE';
    case 'ENDING_90': return active && !i.indefinite && i.endDate != null && i.endDate >= day && i.endDate <= addDays(day, 90);
  }
}

// --- Yetki -----------------------------------------------------------------------------------------------------------------

const isProcurement = (ctx: TenantContext) => normalizeRoles(ctx.roles).includes('PROCUREMENT');
/** Onaycı aileyi görür ama yazamaz (R6): yazma, ailenin departman kapsamındadır. */
const writable = (ctx: TenantContext, f: FamilyRow) => ctx.allDepartments || (f.department_id != null && ctx.departmentIds.includes(f.department_id));
const editAllowed = (ctx: TenantContext, f: FamilyRow) => writable(ctx, f) && (f.created_by === ctx.userId || isProcurement(ctx));
const assertNotApproved = (f: FamilyRow, chains: ChainRow[]) => {
  if (approvedCurrent(f, chains)) throw conflict('contract_approved', 'Onaylanmış sözleşme değiştirilemez; değişiklik için yeni sürüm ekleyin.');
};
async function templateVersion(tx: Tx, id: string) {
  const tv = (await tx.query<{ contract_type: string; superseded_at: Date | null }>(`SELECT t.contract_type, tv.superseded_at FROM contract_template_versions tv
    JOIN contract_templates t ON t.id = tv.template_id WHERE tv.id = $1`, [id])).rows[0];
  if (!tv) throw unprocessable('template_unknown', 'Seçilen şablon sürümü bulunamadı.');
  if (tv.superseded_at) throw unprocessable('template_superseded', 'Bu şablon sürümü geçersiz (yerine yeni sürüm geldi); güncel sürümü seçin.');
  return tv;
}

function assertCanEdit(ctx: TenantContext, f: FamilyRow) {
  if (!writable(ctx, f)) throw new ApiError(403, 'department_forbidden', 'Bu sözleşmeyi görebilirsiniz ama düzenleyemezsiniz.');
  if (f.created_by !== ctx.userId && !isProcurement(ctx)) {
    throw new ApiError(403, 'not_contract_owner', 'Sözleşmeyi yalnız ekleyen kişi ya da Satınalma düzenler ve onaya gönderir.');
  }
}

async function roleOf(tx: Tx, userId: string): Promise<string> {
  const r = (await tx.query<{ roles: string[] }>(`SELECT roles FROM memberships WHERE user_id = $1 AND supplier_id IS NULL`, [userId])).rows[0];
  const roles = normalizeRoles(r?.roles ?? []);
  return roles.includes('PROCUREMENT') ? 'PROCUREMENT' : roles.includes('DEPARTMENT_USER') ? 'DEPARTMENT_USER' : roles[0] ?? 'PROCUREMENT';
}

/** Kiracının etkin iç üyeleri arasından (carry-forward: kimlik kiracıya bağlı doğrulanır); `approverOnly` D107 rollerini ister. */
async function activeMembers(tx: Tx, ctx: TenantContext, ids: string[], approverOnly: boolean): Promise<Set<string>> {
  if (!ids.length) return new Set();
  const rows = (await tx.query<{ user_id: string; roles: string[] }>(`SELECT user_id, roles FROM memberships
    WHERE tenant_id = $1 AND user_id = ANY($2::uuid[]) AND status = 'ACTIVE' AND supplier_id IS NULL`, [ctx.tenantId, ids])).rows;
  return new Set(rows.filter((r) => {
    const roles = normalizeRoles(r.roles);
    if (!roles.length || roles.includes('SUPPLIER')) return false;
    return !approverOnly || roles.some((x) => APPROVER_ROLES.includes(x));
  }).map((r) => r.user_id));
}

// --- Taslak ----------------------------------------------------------------------------------------------------------------

export async function createDraft(tx: Tx, ctx: TenantContext, body: { documentVersionId: string; projectId?: string | null; templateVersionId?: string | null; departmentId?: string | null }) {
  if (!body.projectId) throw unprocessable('project_required', 'Sözleşme bir projeye bağlanmalı; önce projeyi seçin.');
  const project = (await tx.query<{ id: string; company_id: string; department_id: string | null }>(
    `SELECT id, company_id, department_id FROM projects WHERE id = $1`, [body.projectId])).rows[0];
  if (!project) throw notFound();
  const doc = (await tx.query<{ company_id: string; sha256: string; title: string }>(
    `SELECT dv.company_id, dv.sha256, d.title FROM document_versions dv JOIN documents d ON d.id = dv.document_id WHERE dv.id = $1 AND d.kind = 'CONTRACT'`,
    [body.documentVersionId])).rows[0];
  if (!doc) throw notFound();
  if (doc.company_id !== project.company_id) throw unprocessable('project_company_mismatch', 'Belge ve proje aynı şirkete ait olmalı.');
  let contractType: string | null = null;
  if (body.templateVersionId) contractType = (await templateVersion(tx, body.templateVersionId)).contract_type;
  // Aynı belge (sha256) başka bir sözleşmede: engellemez, uyarır. Yalnız çağıranın görebildiği sözleşmeler (RLS).
  const dup = (await tx.query<{ id: string; code: string; title: string }>(`SELECT f.id, f.code, f.title FROM contract_versions cv
      JOIN document_versions dv ON dv.id = cv.document_version_id JOIN contract_families f ON f.id = cv.family_id
    WHERE dv.sha256 = $1 ORDER BY f.created_at, f.id LIMIT 1`, [doc.sha256])).rows[0] ?? null;
  const buyer = (await tx.query<{ name: string }>(`SELECT name FROM legal_entities WHERE id = $1`, [doc.company_id])).rows[0];
  // R10: projenin departmanı varsayılan; kullanıcı değiştirebilir (bölüm kullanıcısı yalnız kendi departmanları, resolveDepartment).
  const departmentId = body.departmentId !== undefined && body.departmentId !== null ? body.departmentId : project.department_id;
  const r = await createContract(tx, ctx, {
    title: doc.title, documentVersionId: body.documentVersionId, supplierId: null, stage: 'DRAFT', signatureMethod: 'PENDING_CLASSIFICATION',
    originalCustodyRequired: false, parties: buyer ? [{ role: 'BUYER', displayName: buyer.name, legalEntityId: doc.company_id }] : [],
    departmentId, intake: { projectId: project.id, templateVersionId: body.templateVersionId ?? null, contractType },
  });
  await audit(tx, ctx, 'contract.draft.created', 'contract_family', r.familyId,
    { projectId: project.id, templateVersionId: body.templateVersionId ?? null, duplicateOf: dup?.id ?? null });
  return { ...r, duplicateOf: dup ? { familyId: dup.id, code: dup.code, title: dup.title } : null };
}

// --- Alanlar -------------------------------------------------------------------------------------------------------------

export interface FieldsInput {
  projectId?: string; departmentId?: string; supplierId?: string | null; contractType?: ContractType | null; ownerUserId?: string | null;
  signedOn?: string | null; indefinite?: boolean; templateVersionId?: string | null; contractNo?: string | null; governingCourt?: string | null;
  kvkkClause?: boolean | null; priceEscalation?: string | null;
  // Koşul revizyonu (contract_terms) alanları
  currency?: string; valueType?: CommercialTerms['valueType']; amount?: string | null; limitBasis?: 'NET' | 'GROSS'; startDate?: string | null; endDate?: string | null;
  autoRenewal?: boolean; renewalMonths?: number | null; noticeAmount?: number | null; noticeUnit?: NoticeUnit | null; paymentDays?: number | null;
  paymentTerms?: string; sourceRef?: string; fxDifference?: 'ALLOWED' | 'NOT_ALLOWED' | null; nonWorkingDay?: CommercialTerms['nonWorkingDay'];
}
const TERMS_KEYS = ['currency', 'valueType', 'amount', 'limitBasis', 'startDate', 'endDate', 'autoRenewal', 'renewalMonths', 'noticeAmount', 'noticeUnit',
  'paymentDays', 'paymentTerms', 'sourceRef', 'fxDifference', 'nonWorkingDay'] as const;

const termsOf = (f: FamilyRow): CommercialTerms | null => f.terms_id ? {
  currency: f.currency!, valueType: f.value_type!, amount: f.amount, paymentTerms: f.payment_terms ?? '', startDate: f.start_date, endDate: f.end_date,
  autoRenewal: !!f.auto_renewal, renewalMonths: f.renewal_months, noticeAmount: f.notice_amount, noticeUnit: f.notice_unit,
  nonWorkingDay: f.non_working_day_rule ?? 'PREVIOUS_WORKING_DAY', sourceRef: f.source_ref ?? '', limitBasis: f.limit_basis ?? 'NET',
  paymentDays: f.payment_days, fxDifference: f.fx_difference,
} : null;

export async function updateFields(tx: Tx, ctx: TenantContext, familyId: string, body: FieldsInput) {
  await tx.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`contract-family:${familyId}`]);
  const f = await loadFamily(tx, familyId);
  assertCanEdit(ctx, f);
  if (!f.version_id) throw notFound();
  assertNotApproved(f, (await chainRows(tx, [familyId])).get(familyId) ?? []);
  const has = (k: keyof FieldsInput) => Object.prototype.hasOwnProperty.call(body, k);
  const set: Record<string, unknown> = {};
  const put = (col: string, cur: unknown, next: unknown) => { if ((cur ?? null) !== (next ?? null)) set[col] = next ?? null; };

  if (has('projectId')) {
    if (!body.projectId) throw unprocessable('project_required', 'Sözleşme bir projeye bağlanmalı.');
    const p = (await tx.query<{ company_id: string; department_id: string | null }>(`SELECT company_id, department_id FROM projects WHERE id = $1`, [body.projectId])).rows[0];
    if (!p) throw unprocessable('project_unknown', 'Proje bulunamadı ya da erişiminiz yok.');
    if (p.company_id !== f.company_id) throw unprocessable('project_company_mismatch', 'Proje sözleşmeyle aynı şirkete ait olmalı.');
    put('project_id', f.project_id, body.projectId);
    // Departmansız (eski) kayıtta projenin departmanı varsayılan olur (R10).
    if (!has('departmentId') && f.department_id == null && p.department_id) set.department_id = await resolveDepartment(tx, ctx, p.department_id);
  }
  if (has('departmentId')) {
    const d = await resolveDepartment(tx, ctx, body.departmentId);
    put('department_id', f.department_id, d);
  }
  if (has('supplierId')) {
    if (body.supplierId) {
      const s = (await tx.query<{ status: string }>(`SELECT status FROM suppliers WHERE id = $1`, [body.supplierId])).rows[0];
      if (!s) throw unprocessable('supplier_unknown', 'Tedarikçi bulunamadı.');
      if (['MERGED', 'REJECTED', 'ARCHIVED'].includes(s.status)) throw unprocessable('supplier_unusable', 'Bu tedarikçi kartı kullanılamaz (birleştirilmiş, reddedilmiş ya da arşivde).');
    }
    put('supplier_id', f.supplier_id, body.supplierId);
  }
  if (has('ownerUserId')) {
    if (body.ownerUserId && !(await activeMembers(tx, ctx, [body.ownerUserId], false)).has(body.ownerUserId)) {
      throw unprocessable('owner_invalid', 'Sözleşme sorumlusu bu kurumun etkin bir kullanıcısı olmalı.');
    }
    put('owner_user_id', f.owner_user_id, body.ownerUserId);
  }
  if (has('templateVersionId')) {
    if (body.templateVersionId && body.templateVersionId !== f.template_version_id) await templateVersion(tx, body.templateVersionId);
    put('template_version_id', f.template_version_id, body.templateVersionId);
  }
  if (has('contractType')) put('contract_type', f.contract_type, body.contractType);
  if (has('signedOn')) put('signed_on', f.signed_on, body.signedOn);
  if (has('contractNo')) put('contract_no', f.contract_no, body.contractNo?.trim() || null);
  if (has('governingCourt')) put('governing_court', f.governing_court, body.governingCourt?.trim() || null);
  if (has('kvkkClause')) put('kvkk_clause', f.kvkk_clause, body.kvkkClause);
  if (has('priceEscalation')) put('price_escalation', f.price_escalation, body.priceEscalation?.trim() || null);
  const indefinite = has('indefinite') ? !!body.indefinite : f.indefinite;
  if (has('indefinite')) put('indefinite', f.indefinite, indefinite);

  // Süresiz sözleşmede ihbar süresi ailede (koşul revizyonunda ihbar bitişe bağlıdır); süreliye dönünce aile alanı temizlenir.
  if (indefinite) {
    if (has('noticeAmount') || has('noticeUnit')) {
      const amount = has('noticeAmount') ? body.noticeAmount ?? null : f.termination_notice_amount;
      const unit = has('noticeUnit') ? body.noticeUnit ?? null : f.termination_notice_unit;
      if ((amount === null) !== (unit === null)) throw unprocessable('invalid_terms', 'İhbar süresi ve birimi birlikte girilir.');
      if (amount !== null && (amount < 1 || amount > 3650)) throw unprocessable('invalid_terms', 'İhbar süresi 1-3650 arasında olmalı.');
      put('termination_notice_amount', f.termination_notice_amount, amount);
      put('termination_notice_unit', f.termination_notice_unit, unit);
    }
  } else {
    put('termination_notice_amount', f.termination_notice_amount, null);
    put('termination_notice_unit', f.termination_notice_unit, null);
  }

  // Koşul revizyonu: yalnız değer değişince yeni revizyon (saveTerms; ekleyenin adıyla, gerekçe otomatik).
  const prev = termsOf(f);
  const termsTouched = TERMS_KEYS.some((k) => has(k)) || (indefinite && prev != null && (prev.endDate != null || prev.noticeAmount != null));
  let termsSaved: { id: string; revision: number } | null = null;
  if (termsTouched) {
    const next: CommercialTerms = {
      currency: body.currency ?? prev?.currency ?? '', valueType: body.valueType ?? prev?.valueType ?? 'FIXED',
      amount: has('amount') ? body.amount ?? null : prev?.amount ?? null, paymentTerms: body.paymentTerms ?? prev?.paymentTerms ?? '',
      startDate: has('startDate') ? body.startDate ?? null : prev?.startDate ?? null, endDate: has('endDate') ? body.endDate ?? null : prev?.endDate ?? null,
      autoRenewal: body.autoRenewal ?? prev?.autoRenewal ?? false, renewalMonths: has('renewalMonths') ? body.renewalMonths ?? null : prev?.renewalMonths ?? null,
      noticeAmount: has('noticeAmount') ? body.noticeAmount ?? null : prev?.noticeAmount ?? null,
      noticeUnit: has('noticeUnit') ? body.noticeUnit ?? null : prev?.noticeUnit ?? null,
      nonWorkingDay: body.nonWorkingDay ?? prev?.nonWorkingDay ?? 'PREVIOUS_WORKING_DAY',
      sourceRef: body.sourceRef ?? (prev?.sourceRef || 'Sözleşme belgesi'), limitBasis: body.limitBasis ?? prev?.limitBasis ?? 'NET',
      paymentDays: has('paymentDays') ? body.paymentDays ?? null : prev?.paymentDays ?? null,
      fxDifference: has('fxDifference') ? body.fxDifference ?? null : prev?.fxDifference ?? null,
    };
    if (!next.autoRenewal) next.renewalMonths = null;
    if (indefinite) { next.endDate = null; next.noticeAmount = null; next.noticeUnit = null; }
    if (!prev || termsDiff(prev, next).length > 0) {
      const r = await saveTerms(tx, ctx, f.version_id, { ...next, changeReason: prev ? INTAKE_REASON : null });
      termsSaved = { id: r.id, revision: r.revision };
    }
  }

  const cols = Object.keys(set);
  if (cols.length) {
    await tx.query(`UPDATE contract_families SET ${cols.map((c, i) => `${c} = $${i + 2}`).join(', ')} WHERE id = $1`, [familyId, ...cols.map((c) => set[c])]);
    if (cols.includes('department_id')) {
      await rederiveTaskDepartments(tx, `(t.entity_type = 'contract_family' AND t.entity_id = $1)
        OR (t.entity_type = 'contract_version' AND t.entity_id IN (SELECT id FROM contract_versions WHERE family_id = $1))`, [familyId]);
    }
  }
  const changed = cols.length > 0 || termsSaved != null;
  let cancelled: string | null = null;
  if (changed) {
    cancelled = await cancelOpenChain(tx, ctx, familyId, CONTENT_CHANGED_REASON);
    await audit(tx, ctx, 'contract.fields.updated', 'contract_family', familyId, { fields: cols, terms: termsSaved, cancelledChainId: cancelled });
  }
  return { ...(await getContractV2(tx, ctx, familyId)), changed, cancelledChainId: cancelled };
}

// --- Zincir iptali (R5; T5 yeni sürüm ve koşul kaydı yollarından da çağırır) ------------------------------------------------

/**
 * Açık zinciri `CANCELLED` yapar (gerekçe, kapanış zamanı), açık adım görevlerini kapatır ve gönderene "Yeniden onaya gönderin"
 * görevi açar. Açık zincir yoksa hiçbir şey yapmaz (null). Karar yazılmış adımlar tarih olarak kalır.
 */
export async function cancelOpenChain(tx: Tx, ctx: TenantContext, familyId: string, reason: string): Promise<string | null> {
  const c = (await tx.query<{ id: string; submitted_by: string }>(
    `SELECT id, submitted_by FROM contract_approval_chains WHERE family_id = $1 AND closed_at IS NULL`, [familyId])).rows[0];
  if (!c) return null;
  await tx.query(`UPDATE contract_approval_chains SET closed_at = now(), outcome = 'CANCELLED', cancel_reason = $2 WHERE id = $1`, [c.id, reason]);
  await closeTasks(tx, `contract-approval:${c.id}:`);
  const f = (await tx.query<{ code: string; title: string; company_id: string }>(`SELECT code, title, company_id FROM contract_families WHERE id = $1`, [familyId])).rows[0]!;
  await openTask(tx, ctx, {
    companyId: f.company_id, kind: 'contract_resubmit', entityType: 'contract_family', entityId: familyId,
    title: `Yeniden onaya gönderin: ${f.title}`, reason: `${f.code}: ${reason} Önceki onay zinciri iptal edildi.`,
    nextAction: 'Alanları ve belgeyi kontrol edip sözleşmeyi yeniden onaya gönderin.', assigneeRole: await roleOf(tx, c.submitted_by),
    assigneeUserId: c.submitted_by, dedupeKey: `contract-resubmit:${familyId}`,
  });
  await audit(tx, ctx, 'contract.approval.cancelled', 'contract_family', familyId, { chainId: c.id }, reason);
  return c.id;
}

// --- Onay zinciri planı ve gönderim ----------------------------------------------------------------------------------------

type PlanResult =
  | { ok: true; departmentId: string | null; steps: { order: number; kind: StepKind; kindLabel: string; userId: string; displayName: string; email: string; viaDeputy: boolean; deputyUserId: string | null }[] }
  | { ok: false; error: string; kind: StepKind; kindLabel: string; message: string };

const PLAN_MESSAGES: Record<string, (kind: string) => string> = {
  department_head_missing: () => 'Bu sözleşmenin departmanına sorumlu atanmamış; onaya gönderilemez. Yöneticinizden departman sorumlusunu atamasını isteyin.',
  lead_missing: () => 'Satınalma sorumlusu atanmamış; onaya gönderilemez. Yöneticinizden atamasını isteyin.',
  director_missing: () => 'Satınalma direktörü atanmamış; onaya gönderilemez. Yöneticinizden atamasını isteyin.',
  no_eligible_approver: (kind) => `${kind} adımında onay verebilecek kimse yok: sözleşmeyi ekleyen kendi sözleşmesini onaylayamaz ve uygun vekil atanmamış.`,
};

async function plan(tx: Tx, ctx: TenantContext, f: FamilyRow, opts: { useDeputyForHead?: boolean; extraApproverIds?: string[] }): Promise<PlanResult> {
  const extras = opts.extraApproverIds ?? [];
  const okExtras = await activeMembers(tx, ctx, extras, true);
  const bad = extras.filter((id) => !okExtras.has(id));
  if (bad.length) throw unprocessable('approver_invalid', 'Ek onaycı yalnız etkin Satınalma ya da Departman kullanıcısı olabilir.', { userIds: bad });
  const a = f.department_id ? await currentApprovers(tx, f.department_id) : { ...(await currentApprovers(tx, '00000000-0000-0000-0000-000000000000')), head: null, deputy: null };
  const p = (x: { userId: string } | null) => (x ? { id: x.userId } : null);
  // Görev ayrılığı: ekleyen ve onaya gönderen (çağıran) kendi zincirinde onaycı olmaz.
  const res = planChain({
    creatorId: f.created_by, excludedIds: [ctx.userId], useDeputyForHead: !!opts.useDeputyForHead, extras,
    approvers: { head: p(a.head), deputy: p(a.deputy), lead: p(a.lead), leadDeputy: p(a.leadDeputy), director: p(a.director), directorDeputy: p(a.directorDeputy) },
  });
  if ('error' in res) return { ok: false, error: res.error, kind: res.kind, kindLabel: STEP_KIND_TR[res.kind], message: PLAN_MESSAGES[res.error]!(STEP_KIND_TR[res.kind]) };
  const ids = [...new Set(res.steps.map((s) => s.userId))];
  const people = new Map((await tx.query<{ id: string; display_name: string; email: string }>(`SELECT id, display_name, email FROM users WHERE id = ANY($1::uuid[])`, [ids])).rows.map((u) => [u.id, u]));
  const deputyOf: Record<StepKind, string | null> = { DEPARTMENT_HEAD: a.deputy?.userId ?? null, PROCUREMENT_LEAD: a.leadDeputy?.userId ?? null, PROCUREMENT_DIRECTOR: a.directorDeputy?.userId ?? null, EXTRA: null };
  return {
    ok: true, departmentId: f.department_id,
    steps: res.steps.map((s) => ({ order: s.order, kind: s.kind, kindLabel: STEP_KIND_TR[s.kind], userId: s.userId, displayName: people.get(s.userId)?.display_name ?? '',
      email: people.get(s.userId)?.email ?? '', viaDeputy: s.viaDeputy, deputyUserId: deputyOf[s.kind] })),
  };
}

export async function approvalPreview(tx: Tx, ctx: TenantContext, familyId: string, opts: { useDeputyForHead?: boolean; extraApproverIds?: string[] }) {
  const f = await loadFamily(tx, familyId);
  const r = await plan(tx, ctx, f, opts);
  if (!r.ok) return r;
  return { ok: true as const, departmentId: r.departmentId, steps: r.steps.map(({ deputyUserId: _d, ...s }) => s) };
}

async function openStepTask(tx: Tx, ctx: TenantContext, f: { id: string; code: string }, chainId: string,
  step: { id: string; order: number; kind: StepKind; userId: string }) {
  // Onaycı başka departmandan olabilir (R6): görev departmansız, şirketsiz ve kişiye atanır (görev departman politikası onaycıyı kapsamaz).
  // Başlıkta yalnız sözleşme kodu: rol kuyruğunun "Tümü" görünümünde başka departmanın sözleşme adı görünmesin.
  return openTask(tx, ctx, {
    companyId: null, kind: 'contract_approval', entityType: 'contract_approval_step', entityId: step.id, departmentId: null,
    title: `Sözleşme onayı (${STEP_KIND_TR[step.kind]}): ${f.code}`, reason: `${f.code} numaralı sözleşme ${step.order}. adımda onayınızı bekliyor.`,
    nextAction: 'Sözleşmeyi, belgeyi ve koşulları inceleyip onaylayın ya da gerekçeyle reddedin.',
    assigneeRole: await roleOf(tx, step.userId), assigneeUserId: step.userId, dedupeKey: `contract-approval:${chainId}:${step.order}`,
  });
}
export { openStepTask };

export async function submitContract(tx: Tx, ctx: TenantContext, familyId: string, body: { useDeputyForHead?: boolean; extraApproverIds?: string[]; note?: string | null }) {
  await tx.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`contract-family:${familyId}`]);
  const f = await loadFamily(tx, familyId);
  assertCanEdit(ctx, f);
  const chains = (await chainRows(tx, [familyId])).get(familyId) ?? [];
  assertNotApproved(f, chains);
  if (chains.some((c) => !c.closed_at)) throw conflict('chain_open', 'Bu sözleşme zaten onayda; yeni gönderim için önce içerik değişmeli ya da karar beklenmeli.');
  const missing = missingRequired(fieldsOf(f));
  if (missing.length) {
    throw unprocessable('missing_fields', `Zorunlu alanlar eksik: ${missing.map((m) => REQUIRED_FIELD_TR[m]).join(', ')}.`,
      { missing: missing.map((m) => ({ field: m, label: REQUIRED_FIELD_TR[m] })) });
  }
  if (!f.version_id || !f.terms_id) throw unprocessable('missing_fields', 'Koşullar girilmemiş.', { missing: [] });
  const r = await plan(tx, ctx, f, body);
  if (!r.ok) throw conflict(r.error, r.message, { kind: r.kind, kindLabel: r.kindLabel });
  const note = body.note?.trim() || null;
  const chain = (await tx.query<{ id: string }>(`INSERT INTO contract_approval_chains (tenant_id, family_id, version_id, terms_id, submitted_by, note)
    VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`, [ctx.tenantId, familyId, f.version_id, f.terms_id, ctx.userId, note])).rows[0]!;
  const steps: { id: string; order: number; kind: StepKind; userId: string }[] = [];
  for (const s of r.steps) {
    const row = (await tx.query<{ id: string }>(`INSERT INTO contract_approval_steps (tenant_id, chain_id, step_order, kind, department_id, assigned_user_id, via_deputy, deputy_user_id)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
      [ctx.tenantId, chain.id, s.order, s.kind, s.kind === 'DEPARTMENT_HEAD' ? f.department_id : null, s.userId, s.viaDeputy,
        s.viaDeputy ? null : s.deputyUserId])).rows[0]!;
    steps.push({ id: row.id, order: s.order, kind: s.kind, userId: s.userId });
  }
  const task = await openStepTask(tx, ctx, f, chain.id, steps[0]!);
  await closeTasks(tx, `contract-resubmit:${familyId}`);
  await closeTasks(tx, `contract-rejected:${familyId}`);
  await audit(tx, ctx, 'contract.submitted', 'contract_family', familyId,
    { chainId: chain.id, versionId: f.version_id, termsId: f.terms_id, steps: r.steps.map((s) => ({ order: s.order, kind: s.kind, userId: s.userId, viaDeputy: s.viaDeputy })) }, note ?? undefined);
  return { chainId: chain.id, firstTaskId: task.id, contract: await getContractV2(tx, ctx, familyId) };
}

// --- Okuma ---------------------------------------------------------------------------------------------------------------

export async function getContractV2(tx: Tx, ctx: TenantContext, familyId: string) {
  const f = await loadFamily(tx, familyId);
  const chains = (await chainRows(tx, [familyId])).get(familyId) ?? [];
  const day = today();
  const st = statusOf(f, chains, day);
  const latest = chains.at(-1) ?? null;

  const steps = latest ? (await tx.query<{ id: string; step_order: number; kind: StepKind; department_id: string | null; assigned_user_id: string; assigned_name: string | null;
      via_deputy: boolean; deputy_user_id: string | null; deputy_name: string | null; decided_by: string | null; decided_name: string | null; decided_at: Date | null;
      decision: 'APPROVED' | 'REJECTED' | null; reason: string | null }>(
    `SELECT s.id, s.step_order, s.kind, s.department_id, s.assigned_user_id, au.display_name AS assigned_name, s.via_deputy, s.deputy_user_id, du.display_name AS deputy_name,
            s.decided_by, xu.display_name AS decided_name, s.decided_at, s.decision, s.reason
     FROM contract_approval_steps s LEFT JOIN users au ON au.id = s.assigned_user_id LEFT JOIN users du ON du.id = s.deputy_user_id
       LEFT JOIN users xu ON xu.id = s.decided_by WHERE s.chain_id = $1 ORDER BY s.step_order`, [latest.id])).rows : [];
  const currentStep = latest && !latest.closed_at ? steps.find((s) => !s.decision) ?? null : null;

  // Karar yetkisi (R4): adıma sabitlenen kişi ya da o unvanın şu anki etkin vekili; ekleyen ve gönderen karar veremez.
  let decide = false;
  if (currentStep && f.created_by !== ctx.userId && latest!.submitted_by !== ctx.userId) {
    if (currentStep.assigned_user_id === ctx.userId) decide = true;
    else if (currentStep.kind !== 'EXTRA') {
      const a = await currentApprovers(tx, currentStep.department_id ?? '00000000-0000-0000-0000-000000000000');
      const dep = currentStep.kind === 'DEPARTMENT_HEAD' ? a.deputy : currentStep.kind === 'PROCUREMENT_LEAD' ? a.leadDeputy : a.directorDeputy;
      decide = dep?.userId === ctx.userId;
    }
  }

  const project = f.project_id ? (await tx.query<{ id: string; code: string; title: string; department_id: string | null }>(
    `SELECT id, code, title, department_id FROM projects WHERE id = $1`, [f.project_id])).rows[0] ?? null : null;
  const supplier = f.supplier_id ? (await tx.query<{ id: string; legal_name: string; status: string; tax_id: string | null; contact_email: string | null }>(
    `SELECT id, legal_name, status, tax_id, contact_email FROM suppliers WHERE id = $1`, [f.supplier_id])).rows[0] ?? null : null;
  const owner = f.owner_user_id ? (await tx.query<{ id: string; display_name: string }>(`SELECT id, display_name FROM users WHERE id = $1`, [f.owner_user_id])).rows[0] ?? null : null;
  const template = f.template_version_id ? (await tx.query<{ id: string; template_id: string; code: string; name: string; contract_type: string; version_no: number; superseded_at: Date | null }>(
    `SELECT tv.id, tv.template_id, t.code, t.name, t.contract_type, tv.version_no, tv.superseded_at FROM contract_template_versions tv
     JOIN contract_templates t ON t.id = tv.template_id WHERE tv.id = $1`, [f.template_version_id])).rows[0] ?? null : null;
  const doc = f.version_id ? (await tx.query<{ id: string; version_no: number; stage: string; document_version_id: string; row_version: number; sha256: string | null;
      filename: string | null; mime_type: string | null; page_count: number | null }>(
    `SELECT cv.id, cv.version_no, cv.stage, cv.document_version_id, cv.row_version, dv.sha256, dv.original_filename AS filename, dv.mime_type, dv.page_count
     FROM contract_versions cv LEFT JOIN document_versions dv ON dv.id = cv.document_version_id WHERE cv.id = $1`, [f.version_id])).rows[0] ?? null : null;

  // Hatırlatıcılar (R7): kurulanlar (Görev 6 contract_reminders) ve plan (kiracı süreleriyle; onay tamamlanınca kurulur).
  const offsets = (await tx.query<{ offsets: number[] }>(`SELECT offsets FROM contract_reminder_settings`)).rows[0]?.offsets ?? [90, 60, 30, 7];
  // İhbar son günü Görev 6 kuralıyla (otomatik yenilemede bitişten; süresizde başlangıcın yıl dönümünden, ihbar süresi ailede).
  const h = (await tx.query<{ day: string }>(`SELECT day::text FROM tenant_holidays ORDER BY day`)).rows.map((r) => r.day);
  const nd = f.terms_id ? noticeBasis(f, h, day)?.deadline ?? null : null;
  const planned = f.terms_id ? reminderDates({ endDate: f.end_date, indefinite: f.indefinite, autoRenewal: !!f.auto_renewal, noticeDeadline: nd, offsets }) : [];
  const scheduled = (await tx.query<{ id: string; kind: 'END' | 'NOTICE'; offset_days: number; due_on: string }>(
    `SELECT id, kind, offset_days, due_on::text FROM contract_reminders WHERE family_id = $1 ORDER BY due_on, kind`, [familyId])).rows;

  const canEdit = editAllowed(ctx, f) && !approvedCurrent(f, chains);
  const openChain = chains.some((c) => !c.closed_at);
  const person = (id: string | null, name: string | null) => (id ? { id, displayName: name ?? '' } : null);
  return {
    family: { id: f.id, code: f.code, title: f.title, companyId: f.company_id, departmentId: f.department_id, departmentName: f.department_name,
      createdBy: person(f.created_by, f.created_by_name), createdAt: f.created_at, intakeFlow: f.intake_flow },
    fields: {
      projectId: f.project_id, supplierId: f.supplier_id, contractType: f.contract_type, contractTypeLabel: f.contract_type ? CONTRACT_TYPE_TR[f.contract_type] : null,
      ownerUserId: f.owner_user_id, signedOn: f.signed_on, indefinite: f.indefinite, templateVersionId: f.template_version_id,
      contractNo: f.contract_no, governingCourt: f.governing_court, kvkkClause: f.kvkk_clause, priceEscalation: f.price_escalation,
      termsId: f.terms_id, termsRevision: f.terms_revision, termsVerified: f.terms_verified_at != null,
      currency: f.currency, valueType: f.value_type, amount: f.amount, limitBasis: f.terms_id ? f.limit_basis : null, startDate: f.start_date, endDate: f.end_date,
      autoRenewal: f.terms_id ? f.auto_renewal : null, renewalMonths: f.renewal_months,
      noticeAmount: f.indefinite ? f.termination_notice_amount : f.notice_amount, noticeUnit: f.indefinite ? f.termination_notice_unit : f.notice_unit,
      noticePeriod: fieldsOf(f).noticePeriod, paymentDays: f.payment_days, paymentTerms: f.payment_terms, sourceRef: f.source_ref, fxDifference: f.fx_difference,
    },
    missing: st.missing.map((m: RequiredField) => ({ field: m, label: REQUIRED_FIELD_TR[m] })),
    status: { code: st.code, label: st.label },
    legacy: st.legacy,
    chain: latest && {
      id: latest.id, status: latest.closed_at ? latest.outcome! : 'OPEN', submittedBy: person(latest.submitted_by, latest.submitted_by_name),
      submittedAt: latest.submitted_at, note: latest.note, closedAt: latest.closed_at, cancelReason: latest.cancel_reason, versionId: latest.version_id, termsId: latest.terms_id,
      steps: steps.map((s) => ({ id: s.id, order: s.step_order, kind: s.kind, kindLabel: STEP_KIND_TR[s.kind], assignedUser: person(s.assigned_user_id, s.assigned_name),
        viaDeputy: s.via_deputy, deputyUser: person(s.deputy_user_id, s.deputy_name), decision: s.decision, decidedAt: s.decided_at,
        decidedBy: person(s.decided_by, s.decided_name), reason: s.reason, current: currentStep?.id === s.id })),
    },
    chainCount: chains.length,
    reminders: { offsets, planned, scheduled: scheduled.map((r) => ({ id: r.id, kind: r.kind, offset: r.offset_days, dueOn: r.due_on })) },
    template: template && { versionId: template.id, templateId: template.template_id, code: template.code, name: template.name, contractType: template.contract_type,
      versionNo: template.version_no, superseded: template.superseded_at != null },
    project: f.project_id ? (project ? { id: project.id, code: project.code, title: project.title, departmentId: project.department_id, visible: true }
      : { id: f.project_id, code: null, title: null, departmentId: null, visible: false }) : null,
    supplier: supplier && { id: supplier.id, legalName: supplier.legal_name, status: supplier.status, vkn: supplier.tax_id, contactEmail: supplier.contact_email },
    owner: owner && { id: owner.id, displayName: owner.display_name },
    document: doc && { contractVersionId: doc.id, versionNo: doc.version_no, stage: doc.stage, documentVersionId: doc.document_version_id,
      filename: doc.filename, mimeType: doc.mime_type, sha256: doc.sha256, pageCount: doc.page_count, etag: `"cv-${doc.id}-${doc.row_version}"` },
    can: { edit: canEdit, submit: canEdit && st.missing.length === 0 && !openChain, decide },
  };
}
