import { randomUUID } from 'node:crypto';
import {
  can, canInviteSupplier, documentValidity, missingDocuments, OFFBOARDING_ITEMS, offboardingComplete, portalAccessEmail, requiredDocumentTypes,
  RISK_LEVEL_TR, stageStatuses, supplierStage, type DocType, type RiskLevelNo, type SupplierStageCode, type SupplierStatus,
} from '@sp/domain';
import type { TenantContext, Tx } from '../db.ts';
import { audit } from '../audit.ts';
import { ApiError, conflict, notFound, unprocessable } from '../errors.ts';
import { inspectUpload } from '../files.ts';
import { AV_STATUS_LABEL, scanStatus, type AvScanner, type AvScanStatus } from '../av/index.ts';
import { queueEmail } from '../mail/index.ts';
import type { ObjectStore } from '../storage.ts';
import { closeTasks, openTask } from '../tasks.ts';
import { listInfo } from './contractIntake.ts';
import { currentRisk } from './riskAssessments.ts';
import * as evals from './supplierEval.ts';

/**
 * v2 Faz 5 (D110) Görev 5: tedarikçi kartı v2 (R1, R10–R14). Eski liste/kart alanları server.ts'te aynen kalır; bu modül yalnız ekler.
 * Aşama türetilir (`supplierStage`), hiçbir tedarikçi satırının durumu bu okumalarda değişmez.
 */

export const today = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Istanbul' }).format(new Date());

export const PORTAL_ACCESS_NOTE = 'Portal girişi kurumun Microsoft Entra kimliğiyle yapılır. Kurum dışı e-posta adresi için kurumun ayrıca misafir (B2B) daveti göndermesi gerekir; bu davet bu sistemin dışında yürür.';
export const SUPPLIER_NOT_APPROVED_MSG = 'Aday tedarikçi önce onaylanmalı.';

// ---------- Liste (R1) ----------

export const LIST_STAGES = ['CANDIDATE', 'APPROVED', 'PASSIVE', 'REJECTED'] as const satisfies readonly SupplierStageCode[];
export type ListStage = (typeof LIST_STAGES)[number];

/** Liste satırına eklenecek v2 alanları (eski alanlar route'ta aynen). `documentAlert`: tür başına en yeni geçerlilik tarihine göre. */
export async function listExtras(tx: Tx, ids: string[]) {
  const day = today();
  const rows = (await tx.query<{ id: string; status: SupplierStatus; dept_id: string | null; dept_name: string | null; min_until: string | null }>(
    `SELECT s.id, s.status, d.id AS dept_id, d.name AS dept_name,
            (SELECT min(x.vu)::text FROM (SELECT max(sd.valid_until) AS vu FROM supplier_documents sd
               WHERE sd.supplier_id = s.id AND sd.superseded_by_id IS NULL AND sd.valid_until IS NOT NULL GROUP BY sd.type_code) x) AS min_until
       FROM suppliers s LEFT JOIN departments d ON d.id = s.responsible_department_id WHERE s.id = ANY($1::uuid[])`, [ids])).rows;
  return new Map(rows.map((r) => {
    const st = supplierStage(r.status);
    const v = r.min_until ? documentValidity(r.min_until, day).code : null;
    return [r.id, { stage: st.code, stageLabel: st.label, documentAlert: v === 'EXPIRED' || v === 'EXPIRING' ? v : null,
      responsibleDepartment: r.dept_id ? { id: r.dept_id, name: r.dept_name } : null }];
  }));
}

/** Aşama sayımları (MERGED hariç; arama süzgeci uygulanır) ve incelemede bekleyen başvurular. */
export async function listCounts(tx: Tx, q: string | null) {
  const rows = (await tx.query<{ status: SupplierStatus; n: number }>(
    `SELECT s.status, count(*)::int AS n FROM suppliers s WHERE s.status <> 'MERGED'
       AND ($1::text IS NULL OR s.legal_name ILIKE '%' || $1 || '%' OR s.tax_id = $1) GROUP BY s.status`, [q])).rows;
  const counts: Record<ListStage, number> = { CANDIDATE: 0, APPROVED: 0, PASSIVE: 0, REJECTED: 0 };
  for (const r of rows) { const c = supplierStage(r.status).code; if (c !== 'MERGED') counts[c] += r.n; }
  const applicationsOpen = (await tx.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM supplier_applications WHERE status IN ('SUBMITTED','NEEDS_DOCUMENTS')`)).rows[0]!.n;
  return { counts, applicationsOpen };
}

export const stageFilterStatuses = (stage: ListStage | undefined): string[] | null => (stage ? stageStatuses(stage) : null);

// ---------- Belgeler (R12) ----------

export interface DocRow {
  id: string; supplier_id: string | null; application_id: string | null; type_code: string; type_name: string | null; title: string; original_filename: string;
  mime_type: string; size_bytes: string; basic_check_status: string; basic_check_reason: string | null; av_scan_status: AvScanStatus;
  valid_until: string | null; uploaded_via: string; uploaded_by_name: string | null; superseded_by_id: string | null; replaces_id: string | null; created_at: Date;
}
export const DOC_SELECT = `SELECT d.id, d.supplier_id, d.application_id, d.type_code, t.name AS type_name, d.title, d.original_filename, d.mime_type,
    d.size_bytes::text, d.basic_check_status, d.basic_check_reason, d.av_scan_status, d.valid_until::text, d.uploaded_via, u.display_name AS uploaded_by_name,
    d.superseded_by_id, (SELECT p.id FROM supplier_documents p WHERE p.superseded_by_id = d.id LIMIT 1) AS replaces_id, d.created_at
  FROM supplier_documents d LEFT JOIN supplier_document_types t ON t.tenant_id = d.tenant_id AND t.code = d.type_code LEFT JOIN users u ON u.id = d.uploaded_by`;

export function documentView(r: DocRow, day = today()) {
  const validity = documentValidity(r.valid_until, day);
  return {
    id: r.id, typeCode: r.type_code, typeName: r.type_name ?? r.type_code, title: r.title, originalFilename: r.original_filename, mimeType: r.mime_type,
    sizeBytes: Number(r.size_bytes), basicCheckStatus: r.basic_check_status, basicCheckReason: r.basic_check_reason,
    quarantined: r.basic_check_status === 'QUARANTINED', avScanStatus: r.av_scan_status, avScanLabel: AV_STATUS_LABEL[r.av_scan_status],
    validUntil: r.valid_until, validity: validity.code, validityLabel: validity.label, daysLeft: validity.daysLeft,
    uploadedVia: r.uploaded_via, uploadedByName: r.uploaded_by_name, createdAt: r.created_at,
    current: !r.superseded_by_id, supersededById: r.superseded_by_id, supersededLabel: r.superseded_by_id ? 'Yerine yenisi yüklendi' : null, replacesId: r.replaces_id,
    contentUrl: `/api/v1/supplier-documents/${r.id}/content`,
  };
}

const MISSING_TR = { MISSING: 'Yüklenmedi', EXPIRED: 'Süresi doldu', NO_EXPIRY_DATE: 'Geçerlilik tarihi yok' } as const;

/** Zorunlu belge türleri (her zaman ya da kategoriye bağlı) ve eksik/süresi dolmuş olanlar (domain `missingDocuments`). */
export async function requiredMissing(tx: Tx, categories: string[], uploaded: { typeCode: string; validUntil: string | null; supersededById: string | null }[], day = today()) {
  const types = (await tx.query<{ code: string; name: string; required: boolean; required_categories: string[]; expiry_required: boolean }>(
    `SELECT code, name, required, required_categories, expiry_required FROM supplier_document_types WHERE active ORDER BY name, code`)).rows;
  const dt: DocType[] = types.map((t) => ({ code: t.code, name: t.name, active: true, requiredMode: t.required ? 'ALWAYS' : 'CATEGORIES',
    categories: t.required_categories, requiresExpiry: t.expiry_required }));
  const required = requiredDocumentTypes(dt, categories);
  const names = new Map(types.map((t) => [t.code, t.name]));
  return missingDocuments(required, uploaded, day).map((m) => ({ code: m.code, name: names.get(m.code) ?? m.code, reason: m.reason, reasonLabel: MISSING_TR[m.reason] }));
}

// ---------- Kart (R10–R14) ----------

interface CardRow {
  id: string; status: SupplierStatus; legal_name: string; contact_name: string | null; contact_email: string | null; contact_phone: string | null; address: string | null;
  service_categories: string[]; services_offered: string | null; service_scope: string | null; responsible_department_id: string | null; dept_name: string | null;
  supplier_manager_user_id: string | null; manager_name: string | null; vpn_access: 'YES' | 'NO' | 'UNKNOWN'; sla_summary: string | null; support_channel: string | null;
  application_id: string | null; deactivated_at: Date | null; deactivated_by: string | null; deactivated_by_name: string | null; deactivation_reason: string | null;
  reactivated_at: Date | null; reactivated_by_name: string | null; reactivation_reason: string | null; row_version: number;
}
const VPN_TR = { YES: 'Var', NO: 'Yok', UNKNOWN: 'Bilinmiyor' } as const;

/** `GET /suppliers/:id` yanıtına eklenen v2 alanları. Görünürlük çağıranın RLS'iyle (departman kullanıcısı yalnız kendi kayıtlarını görür). */
export async function cardExtras(tx: Tx, ctx: TenantContext, id: string) {
  const s = (await tx.query<CardRow>(`SELECT s.id, s.status, s.legal_name, s.contact_name, s.contact_email, s.contact_phone, s.address, s.service_categories,
      s.services_offered, s.service_scope, s.responsible_department_id, d.name AS dept_name, s.supplier_manager_user_id, mu.display_name AS manager_name,
      s.vpn_access, s.sla_summary, s.support_channel, s.application_id, s.deactivated_at, s.deactivated_by, du.display_name AS deactivated_by_name,
      s.deactivation_reason, s.reactivated_at, ru.display_name AS reactivated_by_name, s.reactivation_reason, s.row_version
    FROM suppliers s LEFT JOIN departments d ON d.id = s.responsible_department_id LEFT JOIN users mu ON mu.id = s.supplier_manager_user_id
      LEFT JOIN users du ON du.id = s.deactivated_by LEFT JOIN users ru ON ru.id = s.reactivated_by WHERE s.id = $1`, [id])).rows[0];
  if (!s) throw notFound();
  const day = today();
  const stage = supplierStage(s.status);

  const docRows = (await tx.query<DocRow>(`${DOC_SELECT} WHERE d.supplier_id = $1 ORDER BY d.type_code, d.created_at DESC`, [id])).rows;
  const documents = docRows.map((r) => documentView(r, day));
  const missing = await requiredMissing(tx, s.service_categories, docRows.map((r) => ({ typeCode: r.type_code, validUntil: r.valid_until, supersededById: r.superseded_by_id })), day);

  // Bağlı sözleşmeler ve v2 durumu (türetilmiş; Faz 3/4).
  const fams = (await tx.query<{ id: string; title: string }>(`SELECT id, title FROM contract_families WHERE supplier_id = $1 ORDER BY created_at DESC LIMIT 100`, [id])).rows;
  const info = await listInfo(tx, fams.map((f) => f.id));
  const contracts = fams.map((f) => { const i = info.get(f.id); return { id: f.id, code: i?.code ?? null, title: f.title, status: i?.status ?? null,
    statusLabel: i?.statusLabel ?? null, endDate: i?.endDate ?? null, indefinite: i?.indefinite ?? false }; });

  // Davet edildiği turlar: teklif içeriği kapanıştan önce alıcıya kapalıdır (BR06); açık turda yalnız "kapanışa kadar gizli".
  const rounds = (await tx.query<{ round_id: string; round_no: number; round_status: string; closes_at: Date; project_id: string; code: string; title: string; invited_at: Date; has_bid: boolean }>(
    `SELECT r.id AS round_id, r.round_no, r.status AS round_status, r.closes_at, p.id AS project_id, p.code, p.title, i.created_at AS invited_at,
       EXISTS (SELECT 1 FROM bids b WHERE b.round_id = r.id AND b.supplier_id = i.supplier_id AND b.status = 'SUBMITTED') AS has_bid
     FROM rfq_invitations i JOIN rfq_rounds r ON r.id = i.round_id JOIN projects p ON p.id = r.project_id
     WHERE i.supplier_id = $1 ORDER BY i.created_at DESC LIMIT 100`, [id])).rows;
  const ROUND_TR: Record<string, string> = { PENDING_APPROVAL: 'Yayın onayında', OPEN: 'Açık', CLOSED: 'Kapandı', CANCELLED: 'İptal' };
  const projects = rounds.map((r) => {
    const sealed = r.round_status === 'OPEN' || r.round_status === 'PENDING_APPROVAL';
    const bidStatus = sealed ? 'SEALED' : r.has_bid ? 'SUBMITTED' : 'NONE';
    return { projectId: r.project_id, projectCode: r.code, projectTitle: r.title, roundId: r.round_id, roundNo: r.round_no, roundStatus: r.round_status,
      roundStatusLabel: ROUND_TR[r.round_status] ?? r.round_status, closesAt: r.closes_at, invitedAt: r.invited_at, bidStatus,
      bidStatusLabel: bidStatus === 'SEALED' ? 'Kapanışa kadar gizli' : bidStatus === 'SUBMITTED' ? 'Teklif verdi' : 'Teklif vermedi' };
  });

  // Anketler ve karne özeti (D103 hesabı; içerik çağıranın departman kapsamında).
  const assessments = await evals.supplierAssessments(tx, ctx, id);
  const portal = (await tx.query<{ id: string; portal_status: string | null }>(`SELECT id, portal_status FROM supplier_assessments WHERE supplier_id = $1`, [id])).rows;
  const portalOf = new Map(portal.map((p) => [p.id, p.portal_status]));
  const year = Number(day.slice(0, 4));
  const card = await evals.scorecard(tx, ctx, id, year);
  const surveys = {
    year, score: card.performance.score, scoreReason: card.performance.score === null ? (card.performance as { reason?: string | null }).reason ?? null : null,
    pendingResponses: portal.filter((p) => p.portal_status === 'SENT').length,
    items: assessments.map((a) => ({ id: a.id, scope: a.scope, template: a.template, status: a.status, portalStatus: portalOf.get(a.id) ?? null,
      outcome: a.outcome, complianceRate: a.complianceRate, reviewedAt: a.reviewedAt, departmentName: a.departmentName })),
  };
  const risk = await currentRisk(tx, id, day);

  const portalUsers = await listPortalUsers(tx, id);

  const ob = (await tx.query<{ id: string; reason: string; started_at: Date; started_by_name: string; completed_at: Date | null }>(
    `SELECT o.id, o.reason, o.started_at, u.display_name AS started_by_name, o.completed_at FROM supplier_offboardings o JOIN users u ON u.id = o.started_by
     WHERE o.supplier_id = $1 ORDER BY o.started_at DESC LIMIT 1`, [id])).rows[0];
  const offboarding = ob ? { id: ob.id, reason: ob.reason, startedAt: ob.started_at, startedByName: ob.started_by_name, completedAt: ob.completed_at,
    completed: !!ob.completed_at, items: await offboardingItems(tx, ob.id) } : null;

  // R10: "Onaylı yapmadan önce" bilgi kutusu (engellemez).
  const activationHints = s.status !== 'CANDIDATE' ? [] : [
    ...(surveys.pendingResponses > 0 ? [{ code: 'SURVEY_UNANSWERED', message: `Yanıtlanmamış gönderilmiş anket: ${surveys.pendingResponses}` }] : []),
    ...missing.filter((m) => m.reason !== 'EXPIRED').map((m) => ({ code: 'DOCUMENT_MISSING', message: `Eksik zorunlu belge: ${m.name}` })),
    ...missing.filter((m) => m.reason === 'EXPIRED').map((m) => ({ code: 'DOCUMENT_EXPIRED', message: `Süresi dolmuş zorunlu belge: ${m.name}` })),
  ];

  const active = s.status === 'ACTIVE' || s.status === 'CONDITIONAL' || s.status === 'CANDIDATE';
  return {
    stage: stage.code, stageLabel: stage.label,
    profile: {
      contactName: s.contact_name, contactEmail: s.contact_email, contactPhone: s.contact_phone, address: s.address, serviceCategories: s.service_categories,
      servicesOffered: s.services_offered, serviceScope: s.service_scope,
      responsibleDepartment: s.responsible_department_id ? { id: s.responsible_department_id, name: s.dept_name } : null,
      supplierManager: s.supplier_manager_user_id ? { id: s.supplier_manager_user_id, name: s.manager_name } : null,
      vpnAccess: s.vpn_access, vpnAccessLabel: VPN_TR[s.vpn_access], slaSummary: s.sla_summary, supportChannel: s.support_channel, applicationId: s.application_id,
    },
    deactivation: s.deactivated_at ? { at: s.deactivated_at, byName: s.deactivated_by_name, reason: s.deactivation_reason } : null,
    reactivation: s.reactivated_at ? { at: s.reactivated_at, byName: s.reactivated_by_name, reason: s.reactivation_reason } : null,
    documents, requiredMissing: missing, contracts, projects, surveys,
    risk: risk ? { year: risk.year, level: risk.level, levelLabel: RISK_LEVEL_TR[risk.level as RiskLevelNo], riskScore: risk.riskScore, criticality: risk.criticalityDisplay } : null,
    portalUsers, portalAccessNote: PORTAL_ACCESS_NOTE, offboarding, activationHints,
    eligibleForInvite: canInviteSupplier(s.status),
    can: {
      editProfile: can(ctx.roles, 'supplier.profile.edit') && s.status !== 'MERGED',
      offboard: can(ctx.roles, 'supplier.offboard') && active,
      reactivate: can(ctx.roles, 'supplier.offboard') && s.status === 'SUSPENDED' && s.deactivated_by !== ctx.userId,
      manageUsers: can(ctx.roles, 'supplier.portal_users.manage') && s.status !== 'MERGED',
      manageDocuments: can(ctx.roles, 'supplier.documents.manage') && s.status !== 'MERGED',
    },
  };
}

export async function offboardingItems(tx: Tx, offboardingId: string) {
  const rows = (await tx.query<{ id: string; code: string; label: string; done_at: Date | null; done_by_name: string | null; not_applicable: boolean; note: string | null }>(
    `SELECT i.id, i.code, i.label, i.done_at, u.display_name AS done_by_name, i.not_applicable, i.note FROM supplier_offboarding_items i
       LEFT JOIN users u ON u.id = i.done_by WHERE i.offboarding_id = $1`, [offboardingId])).rows;
  const order = new Map<string, number>(OFFBOARDING_ITEMS.map((o, i) => [o.code, i]));
  return rows.sort((a, b) => (order.get(a.code) ?? 99) - (order.get(b.code) ?? 99)).map((r) => ({
    id: r.id, code: r.code, label: r.label, doneAt: r.done_at, doneByName: r.done_by_name, notApplicable: r.not_applicable, note: r.note,
    state: r.not_applicable ? 'NOT_APPLICABLE' : r.done_at ? 'DONE' : 'OPEN', stateLabel: r.not_applicable ? 'Uygulanmaz' : r.done_at ? 'Yapıldı' : 'Bekliyor',
  }));
}
export { offboardingComplete };

// ---------- Envanter düzenleme (R14) ----------

export interface ProfileInput {
  expectedRowVersion: number;
  contactName?: string | null; contactEmail?: string | null; contactPhone?: string | null; address?: string | null; serviceCategories?: string[];
  servicesOffered?: string | null; serviceScope?: string | null; responsibleDepartmentId?: string | null; supplierManagerUserId?: string | null;
  vpnAccess?: 'YES' | 'NO' | 'UNKNOWN'; slaSummary?: string | null; supportChannel?: string | null;
}
const PROFILE_COLS: [keyof Omit<ProfileInput, 'expectedRowVersion'>, string][] = [
  ['contactName', 'contact_name'], ['contactEmail', 'contact_email'], ['contactPhone', 'contact_phone'], ['address', 'address'],
  ['serviceCategories', 'service_categories'], ['servicesOffered', 'services_offered'], ['serviceScope', 'service_scope'],
  ['responsibleDepartmentId', 'responsible_department_id'], ['supplierManagerUserId', 'supplier_manager_user_id'], ['vpnAccess', 'vpn_access'],
  ['slaSummary', 'sla_summary'], ['supportChannel', 'support_channel'],
];
const textOrNull = (v: unknown) => (typeof v === 'string' ? v.trim() || null : null);

export async function updateProfile(tx: Tx, ctx: TenantContext, id: string, b: ProfileInput) {
  const s = (await tx.query<Record<string, unknown> & { status: string; row_version: number }>(
    `SELECT status, row_version, ${PROFILE_COLS.map(([, c]) => c).join(', ')} FROM suppliers WHERE id = $1 FOR UPDATE`, [id])).rows[0];
  if (!s) throw notFound();
  if (s.row_version !== b.expectedRowVersion) throw conflict('version_conflict', 'Kayıt siz düzenlerken değişti. Güncel bilgileri gözden geçirin.', { currentRowVersion: s.row_version });
  if (s.status === 'MERGED') throw conflict('invalid_state', 'Birleştirilmiş kart düzenlenemez; birleştirildiği kartı düzenleyin.');
  const next: Record<string, unknown> = {};
  for (const [key, col] of PROFILE_COLS) {
    if (!(key in b)) continue;
    const v = b[key];
    if (key === 'serviceCategories') {
      const list = [...new Set((v as string[]).map((x) => x.trim()).filter(Boolean))];
      if (list.some((x) => x.length > 100)) throw unprocessable('invalid_field', 'Her kategori en çok 100 karakter olabilir.', { field: key });
      next[col] = list;
    } else if (key === 'vpnAccess') next[col] = v;
    else if (key === 'responsibleDepartmentId' || key === 'supplierManagerUserId') next[col] = v ?? null;
    else next[col] = textOrNull(v);
  }
  if (next.contact_email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(next.contact_email as string)) throw unprocessable('invalid_field', 'İletişim e-postası geçersiz.', { field: 'contactEmail' });
  if (next.contact_name !== undefined && next.contact_name !== null && (next.contact_name as string).length > 200) throw unprocessable('invalid_field', 'İletişim kişisi en çok 200 karakter olabilir.', { field: 'contactName' });
  if (next.responsible_department_id) {
    const d = await tx.query(`SELECT 1 FROM departments WHERE id = $1`, [next.responsible_department_id]);
    if (!d.rowCount) throw unprocessable('invalid_field', 'Sorumlu ekip (departman) bulunamadı.', { field: 'responsibleDepartmentId' });
  }
  if (next.supplier_manager_user_id) {
    const m = await tx.query(`SELECT 1 FROM memberships WHERE user_id = $1 AND supplier_id IS NULL AND status = 'ACTIVE'`, [next.supplier_manager_user_id]);
    if (!m.rowCount) throw unprocessable('invalid_field', 'Tedarikçi yöneticisi kurumun etkin bir kullanıcısı olmalı.', { field: 'supplierManagerUserId' });
  }
  const changed = Object.keys(next).filter((c) => JSON.stringify(next[c] ?? null) !== JSON.stringify(s[c] ?? null));
  if (!changed.length) return { rowVersion: s.row_version, changed: [] as string[] };
  const sets = changed.map((c, i) => `${c} = $${i + 2}`).join(', ');
  const rv = (await tx.query<{ row_version: number }>(`UPDATE suppliers SET ${sets}, row_version = row_version + 1 WHERE id = $1 RETURNING row_version`,
    [id, ...changed.map((c) => next[c])])).rows[0]!.row_version;
  const keyOf = new Map(PROFILE_COLS.map(([k, c]) => [c, k]));
  await audit(tx, ctx, 'supplier.profile.updated', 'supplier', id, {
    before: Object.fromEntries(changed.map((c) => [keyOf.get(c), s[c] ?? null])), after: Object.fromEntries(changed.map((c) => [keyOf.get(c), next[c] ?? null])) });
  return { rowVersion: rv, changed: changed.map((c) => keyOf.get(c)) };
}

// ---------- Portal kullanıcıları (R11) ----------

export async function listPortalUsers(tx: Tx, supplierId: string) {
  const rows = (await tx.query<{ user_id: string; display_name: string; email: string; status: string; invited: boolean; valid_from: Date }>(
    `SELECT m.user_id, u.display_name, u.email, m.status, u.auth_subject LIKE 'invite|%' AS invited, m.valid_from
       FROM memberships m JOIN users u ON u.id = m.user_id WHERE m.supplier_id = $1 ORDER BY u.display_name, u.id`, [supplierId])).rows;
  return rows.map((r) => ({ userId: r.user_id, name: r.display_name, email: r.email, status: r.status,
    statusLabel: r.status === 'ACTIVE' ? 'Etkin' : r.status === 'SUSPENDED' ? 'Askıda' : 'Kapatıldı',
    firstLogin: r.invited ? 'PENDING' : 'DONE', firstLoginLabel: r.invited ? 'İlk giriş yapılmadı (davetli)' : 'Giriş yaptı', since: r.valid_from }));
}

export type PortalInviteOutcome = { status: 'CREATED' | 'EXISTS'; userId: string } | { status: 'USER_IN_OTHER_TENANT' | 'USER_HAS_OTHER_MEMBERSHIP'; userId: null };

/**
 * R11: e-posta Faz 2 `directory_invite_user` ile davetli kullanıcıya bağlanır (046 kuralları; başka kurumdaki e-posta → NULL) ve
 * `SUPPLIER` üyeliği (`company_ids = '{}'`, `supplier_id`) açılır. İlk OIDC girişinde doğrulanmış e-postayla bağlanır (004).
 */
export async function ensurePortalUser(tx: Tx, ctx: TenantContext, supplierId: string, name: string, email: string): Promise<PortalInviteOutcome> {
  const userId = (await tx.query<{ id: string | null }>(`SELECT directory_invite_user($1, $2) AS id`, [email, name])).rows[0]!.id;
  if (!userId) return { status: 'USER_IN_OTHER_TENANT', userId: null };
  const m = (await tx.query<{ supplier_id: string | null }>(`SELECT supplier_id FROM memberships WHERE tenant_id = $1 AND user_id = $2 FOR UPDATE`, [ctx.tenantId, userId])).rows[0];
  if (m) return m.supplier_id === supplierId ? { status: 'EXISTS', userId } : { status: 'USER_HAS_OTHER_MEMBERSHIP', userId: null };
  await tx.query(`INSERT INTO memberships (tenant_id, user_id, roles, company_ids, supplier_id, status) VALUES ($1, $2, ARRAY['SUPPLIER'], '{}', $3, 'ACTIVE')`,
    [ctx.tenantId, userId, supplierId]);
  return { status: 'CREATED', userId };
}

export const PORTAL_INVITE_ERRORS = {
  USER_IN_OTHER_TENANT: 'Bu e-posta başka bir kurumda kayıtlı; erişimi operatör tanımlar.',
  USER_HAS_OTHER_MEMBERSHIP: 'Bu e-posta kurumda başka bir kullanıcıya ya da başka bir tedarikçiye bağlı; portal kullanıcısı olarak eklenemez.',
} as const;

const INACTIVE = new Set(['SUSPENDED', 'ARCHIVED', 'REJECTED', 'MERGED']);

export async function addPortalUser(tx: Tx, ctx: TenantContext, supplierId: string, b: { name: string; email: string }, webOrigin: string) {
  const s = (await tx.query<{ status: string; legal_name: string }>(`SELECT status, legal_name FROM suppliers WHERE id = $1 FOR UPDATE`, [supplierId])).rows[0];
  if (!s) throw notFound();
  if (INACTIVE.has(s.status)) throw conflict('supplier_inactive', 'Pasif, reddedilmiş ya da birleştirilmiş tedarikçiye portal kullanıcısı eklenemez.');
  const name = b.name.trim();
  const email = b.email.trim().toLowerCase();
  if (name.length < 2 || name.length > 200) throw unprocessable('invalid_field', 'Ad 2–200 karakter olmalı.', { field: 'name' });
  if (email.length > 254 || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw unprocessable('invalid_field', 'Geçerli bir e-posta adresi girin.', { field: 'email' });
  const r = await ensurePortalUser(tx, ctx, supplierId, name, email);
  if (r.status === 'USER_IN_OTHER_TENANT') throw conflict('user_in_other_tenant', PORTAL_INVITE_ERRORS.USER_IN_OTHER_TENANT);
  if (r.status === 'USER_HAS_OTHER_MEMBERSHIP') throw conflict('user_has_other_membership', PORTAL_INVITE_ERRORS.USER_HAS_OTHER_MEMBERSHIP);
  if (r.status === 'EXISTS') throw conflict('portal_user_exists', 'Bu kişi zaten bu tedarikçinin portal kullanıcısı; askıdaysa yeniden açın.');
  const mail = portalAccessEmail({ name, link: `${webOrigin.replace(/\/$/, '')}/portal` });
  const out = await queueEmail(tx, ctx, { toUserId: r.userId, toEmail: email, subject: mail.subject, body: mail.body, relatedType: 'supplier_portal_user', relatedId: supplierId });
  await audit(tx, ctx, 'supplier.portal_user.added', 'supplier', supplierId, { userId: r.userId, emailStatus: out.status });
  return { user: (await listPortalUsers(tx, supplierId)).find((u) => u.userId === r.userId)!, email: { status: out.status }, note: PORTAL_ACCESS_NOTE };
}

export async function setPortalUserStatus(tx: Tx, ctx: TenantContext, supplierId: string, userId: string, action: 'suspend' | 'reactivate') {
  const s = (await tx.query<{ status: string }>(`SELECT status FROM suppliers WHERE id = $1`, [supplierId])).rows[0];
  if (!s) throw notFound();
  const m = (await tx.query<{ status: string }>(`SELECT status FROM memberships WHERE tenant_id = $1 AND user_id = $2 AND supplier_id = $3 FOR UPDATE`,
    [ctx.tenantId, userId, supplierId])).rows[0];
  if (!m) throw notFound();
  const from = action === 'suspend' ? 'ACTIVE' : 'SUSPENDED';
  const to = action === 'suspend' ? 'SUSPENDED' : 'ACTIVE';
  if (action === 'reactivate' && INACTIVE.has(s.status)) throw conflict('supplier_inactive', 'Tedarikçi pasif; önce tedarikçiyi yeniden açın.');
  if (m.status !== from) throw conflict('invalid_state', action === 'suspend' ? 'Kullanıcı zaten etkin değil.' : 'Yalnız askıdaki kullanıcı yeniden açılabilir.');
  await tx.query(`UPDATE memberships SET status = $4 WHERE tenant_id = $1 AND user_id = $2 AND supplier_id = $3`, [ctx.tenantId, userId, supplierId, to]);
  await audit(tx, ctx, action === 'suspend' ? 'supplier.portal_user.suspended' : 'supplier.portal_user.reactivated', 'supplier', supplierId, { userId, before: from, after: to });
  return (await listPortalUsers(tx, supplierId)).find((u) => u.userId === userId)!;
}

// ---------- Belge yükleme ve okuma (R12) ----------

export const SUPPLIER_DOC_MAX_BYTES = 10 * 1024 * 1024;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const validDate = (s: string) => DATE.test(s) && new Date(`${s}T00:00:00Z`).toISOString().startsWith(s);

export interface InternalUpload { filename: string; mimetype: string; body: Buffer; fields: Record<string, string> }

/**
 * Satınalma'nın yüklediği belge (`uploaded_via='INTERNAL'`). `replacesId` verilirse eski belge silinmez, "yerine yenisi yüklendi" olur
 * (aynı tedarikçi ve tür; 052a tetikleyicisi de denetler). Dosya denetimi ve R5 taraması nesne deposuna yazmadan önce.
 */
export async function prepareInternalUpload(u: InternalUpload, tenantId: string, scanner: AvScanner | null) {
  if (u.body.length > SUPPLIER_DOC_MAX_BYTES) throw unprocessable('file_too_large', 'Dosya 10 MB sınırını aşıyor.');
  const filename = (u.filename || 'belge').slice(0, 255);
  const ins = inspectUpload(filename, u.mimetype, u.body);
  if ('rejected' in ins) throw unprocessable('file_rejected', ins.rejected, { file: filename });
  if (!['application/pdf', 'image/jpeg', 'image/png'].includes(ins.mimeType)) throw unprocessable('file_rejected', 'Desteklenmeyen dosya türü. PDF, PNG veya JPEG yükleyin.', { file: filename });
  const av = await scanStatus(scanner, u.body);
  if (av === 'INFECTED') throw unprocessable('file_infected', 'Dosyada virüs bulundu; belge kaydedilmedi.', { file: filename });
  const quarantined = av === 'ERROR' || ins.status === 'QUARANTINED';
  return { filename, mimeType: ins.mimeType, sizeBytes: ins.sizeBytes, sha256: ins.sha256, storageKey: `t/${tenantId}/supplier-documents/${randomUUID()}`,
    basicCheckStatus: quarantined ? 'QUARANTINED' as const : 'PASSED' as const,
    basicCheckReason: av === 'ERROR' ? 'Virüs taraması yapılamadı; dosya karantinada.' : ins.reason, avScanStatus: av };
}

export async function addInternalDocument(tx: Tx, ctx: TenantContext, supplierId: string, u: InternalUpload, p: Awaited<ReturnType<typeof prepareInternalUpload>>) {
  const s = (await tx.query<{ status: string }>(`SELECT status FROM suppliers WHERE id = $1 FOR UPDATE`, [supplierId])).rows[0];
  if (!s) throw notFound();
  if (s.status === 'MERGED') throw conflict('invalid_state', 'Birleştirilmiş karta belge yüklenemez.');
  const typeCode = (u.fields.typeCode ?? '').trim();
  const t = (await tx.query<{ code: string; name: string; expiry_required: boolean }>(`SELECT code, name, expiry_required FROM supplier_document_types WHERE code = $1 AND active`, [typeCode])).rows[0];
  if (!t) throw unprocessable('document_type', 'Belge türü tanımlı ya da etkin değil.', { typeCode });
  const validUntil = (u.fields.validUntil ?? '').trim() || null;
  if (validUntil && !validDate(validUntil)) throw unprocessable('invalid_field', 'Geçerlilik tarihi YYYY-AA-GG biçiminde olmalı.', { field: 'validUntil' });
  if (t.expiry_required && !validUntil) throw unprocessable('valid_until_required', `Geçerlilik tarihi gerekli: ${t.name}.`);
  const title = (u.fields.title ?? '').trim().slice(0, 300) || t.name;
  const replacesId = (u.fields.replacesId ?? '').trim() || null;
  if (replacesId) {
    const old = (await tx.query<{ type_code: string; superseded_by_id: string | null }>(
      `SELECT type_code, superseded_by_id FROM supplier_documents WHERE id = $1 AND supplier_id = $2 FOR UPDATE`, [replacesId, supplierId])).rows[0];
    if (!old) throw unprocessable('replaces_not_found', 'Yenilenecek belge bu tedarikçide bulunamadı.');
    if (old.type_code !== typeCode) throw unprocessable('replaces_type_mismatch', 'Yenilenen belge aynı türde olmalı.');
    if (old.superseded_by_id) throw conflict('already_superseded', 'Bu belgenin yerine zaten yenisi yüklendi.');
  }
  const id = (await tx.query<{ id: string }>(`INSERT INTO supplier_documents (tenant_id, supplier_id, type_code, title, original_filename, mime_type, size_bytes, sha256,
      storage_key, basic_check_status, basic_check_reason, av_scan_status, valid_until, uploaded_via, uploaded_by)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,'INTERNAL',$14) RETURNING id`,
    [ctx.tenantId, supplierId, typeCode, title, p.filename, p.mimeType, p.sizeBytes, p.sha256, p.storageKey, p.basicCheckStatus, p.basicCheckReason,
      p.avScanStatus, validUntil, ctx.userId])).rows[0]!.id;
  if (replacesId) {
    await tx.query(`UPDATE supplier_documents SET superseded_by_id = $2 WHERE id = $1`, [replacesId, id]);
    // R12: yenileme gelince eski belgenin açık hatırlatma görevleri kapanır.
    await closeTasks(tx, `doc:${replacesId}:`);
  }
  if (p.avScanStatus === 'ERROR') {
    await openTask(tx, ctx, { companyId: null, departmentId: null, kind: 'supplier_document_av_error', entityType: 'supplier', entityId: supplierId,
      title: 'Tedarikçi belgesi virüs taramasından geçemedi', reason: `${t.name} belgesi taranamadı ve karantinada.`,
      nextAction: 'Taramayı yeniden yaptırın ya da belgeyi yeniden yükleyin.', assigneeRole: 'PROCUREMENT', severity: 'HIGH', dedupeKey: `supplier-document:${id}:av_error` });
  }
  await audit(tx, ctx, 'supplier_document.uploaded', 'supplier', supplierId, { documentId: id, typeCode, replacesId, avScanStatus: p.avScanStatus, via: 'INTERNAL' });
  const row = (await tx.query<DocRow>(`${DOC_SELECT} WHERE d.id = $1`, [id])).rows[0]!;
  return documentView(row);
}

/** İçerik: iç kullanıcı ya da sahibi tedarikçi (RLS); karantinadaki dosya açılmaz; her okuma denetim kaydı. */
export async function documentForDownload(tx: Tx, ctx: TenantContext, id: string) {
  const d = (await tx.query<{ storage_key: string; mime_type: string; original_filename: string; basic_check_status: string; supplier_id: string | null; application_id: string | null }>(
    `SELECT storage_key, mime_type, original_filename, basic_check_status, supplier_id, application_id FROM supplier_documents WHERE id = $1`, [id])).rows[0];
  if (!d) throw notFound();
  if (d.basic_check_status !== 'PASSED') throw new ApiError(423, 'quarantined', 'Dosya karantinada; görüntülenemez.');
  await audit(tx, ctx, 'supplier_document.read', 'supplier_document', id, { supplierId: d.supplier_id, applicationId: d.application_id, portal: !!ctx.supplierId });
  return d;
}

export { stageStatuses, type SupplierStageCode };
