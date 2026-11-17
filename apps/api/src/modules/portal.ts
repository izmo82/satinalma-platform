import { randomUUID } from 'node:crypto';
import { documentValidity, formatDateTr, inviteEmail, portalStanding, supplierStage, type Level, type SupplierStatus } from '@sp/domain';
import type { TenantContext, Tx } from '../db.ts';
import { audit } from '../audit.ts';
import { ApiError, conflict, forbidden, notFound, unprocessable } from '../errors.ts';
import { EMAIL_STATUS_LABEL, enqueueEmailDispatch, mailChannel, type OutboxStatus } from '../mail/index.ts';
import { closeTasks, openTask } from '../tasks.ts';
import { withTenantWideScope } from './contractChain.ts';
import { portalRisk } from './riskAssessments.ts';
import { DOC_SELECT, documentView, prepareInternalUpload, requiredMissing, SUPPLIER_DOC_MAX_BYTES, today, type DocRow, type InternalUpload } from './supplierCard.ts';
import { ensureDocumentReminderJob } from './supplierDocReminders.ts';

/**
 * v2 Faz 5 (D110) Görev 6: tedarikçi portalı API'si (R8, R12, R14, R15) ve tur davet e-postası.
 * Tedarikçi oturumu (`ctx.supplierId`) yalnız kendi kartını görür (R17 `supplier_scope`, 052 RLS); skor ve risk yalnız
 * `app_portal_standing()` ve `app_portal_risk()` (SECURITY DEFINER) üzerinden gelir. İç kullanıcı adları, notlar, ölçütler dönmez.
 */

function supplierOnly(ctx: TenantContext): string {
  if (!ctx.supplierId) throw forbidden('supplier_portal');
  return ctx.supplierId;
}

// ---------- R8 davet e-postası ----------

export const ROUND_INVITE = 'rfq_round_invite';
const INVITE_STATUS_ORDER: (OutboxStatus | 'NONE')[] = ['FAILED', 'NOT_CONFIGURED', 'QUEUED', 'SENT'];

/**
 * Tur Satınalma onayıyla OPEN olduğunda (decidePublish) her davetli tedarikçinin etkin portal kullanıcısına tek satır. Aynı tur ve alıcı
 * için ikinci satır yazılmaz (052/052a tekil dizinleri; ON CONFLICT DO NOTHING). Portal kullanıcısı olmayan davetli için e-posta yazılmaz,
 * Satınalma'ya "Tedarikçinin portal kullanıcısı yok" görevi açılır. Onaycının departman kapsamı ne olursa olsun yazılır (kiracı geneli kapsam).
 */
export async function queueRoundInvites(tx: Tx, ctx: TenantContext, roundId: string, webOrigin = ''): Promise<{ queued: number; missingUsers: string[] }> {
  return withTenantWideScope(tx, async () => {
    const r = (await tx.query<{ id: string; status: string; closes_at: Date; title: string; need: string | null }>(
      `SELECT r.id, r.status, r.closes_at, p.title, p.need FROM rfq_rounds r JOIN projects p ON p.id = r.project_id WHERE r.id = $1`, [roundId])).rows[0];
    if (!r || r.status !== 'OPEN') return { queued: 0, missingUsers: [] };
    const invited = (await tx.query<{ supplier_id: string; legal_name: string }>(
      `SELECT i.supplier_id, s.legal_name FROM rfq_invitations i JOIN suppliers s ON s.id = i.supplier_id WHERE i.round_id = $1 ORDER BY s.legal_name, s.id`, [roundId])).rows;
    const channel = mailChannel();
    const status: OutboxStatus = channel.kind === 'graph' ? 'QUEUED' : 'NOT_CONFIGURED';
    const link = `${webOrigin.replace(/\/$/, '')}/portal/${roundId}`;
    const scope = (r.need ?? '').trim() || r.title;
    let queued = 0;
    const missingUsers: string[] = [];
    for (const s of invited) {
      const users = (await tx.query<{ user_id: string; email: string }>(
        `SELECT m.user_id, u.email FROM memberships m JOIN users u ON u.id = m.user_id
          WHERE m.tenant_id = $1 AND m.supplier_id = $2 AND m.status = 'ACTIVE' ORDER BY u.email, u.id`, [ctx.tenantId, s.supplier_id])).rows;
      if (!users.length) {
        missingUsers.push(s.supplier_id);
        await openTask(tx, ctx, { companyId: null, departmentId: null, kind: 'supplier_no_portal_user', entityType: 'supplier', entityId: s.supplier_id,
          title: 'Tedarikçinin portal kullanıcısı yok',
          reason: `${s.legal_name}, "${r.title}" teklif turuna davet edildi; portal kullanıcısı olmadığı için davet e-postası yazılmadı.`,
          nextAction: 'Tedarikçi kartından portal kullanıcısı ekleyin ve tedarikçiye daveti ayrıca bildirin.', assigneeRole: 'PROCUREMENT',
          dedupeKey: `round:${roundId}:no_portal_user:${s.supplier_id}` });
        continue;
      }
      const mail = inviteEmail({ supplierName: s.legal_name, projectTitle: r.title, scopeSummary: scope, closesAt: r.closes_at.toISOString(), link });
      for (const u of users) {
        // RETURNING kullanılmaz: satır onaycının okuma kapsamı dışında kalabilir (050 RLS); kimlik uygulamada üretilir.
        const id = randomUUID();
        const ins = await tx.query(`INSERT INTO email_outbox (id, tenant_id, to_user_id, to_email, subject, body_text, related_type, related_id, status)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT DO NOTHING`,
          [id, ctx.tenantId, u.user_id, u.email, mail.subject.slice(0, 300), mail.body, ROUND_INVITE, roundId, status]);
        if (!ins.rowCount) continue;
        queued++;
        if (status === 'QUEUED') await enqueueEmailDispatch(tx, ctx.tenantId, id);
      }
    }
    return { queued, missingUsers };
  });
}

/** İç ekran: davetin e-posta durumu (tedarikçi başına; birden çok alıcıda en az ilerlemiş durum — "gönderildi" abartılmaz). */
export async function roundInviteEmails(tx: Tx, roundId: string) {
  return withTenantWideScope(tx, async () => {
    const rows = (await tx.query<{ supplier_id: string; status: OutboxStatus | null; has_user: boolean }>(
      `SELECT i.supplier_id, e.status,
              EXISTS (SELECT 1 FROM memberships m WHERE m.supplier_id = i.supplier_id AND m.status = 'ACTIVE') AS has_user
         FROM rfq_invitations i
         LEFT JOIN memberships m ON m.supplier_id = i.supplier_id
         LEFT JOIN email_outbox e ON e.related_type = $2 AND e.related_id = i.round_id AND e.to_user_id = m.user_id
        WHERE i.round_id = $1`, [roundId, ROUND_INVITE])).rows;
    const by = new Map<string, { statuses: OutboxStatus[]; hasUser: boolean }>();
    for (const r of rows) {
      const x = by.get(r.supplier_id) ?? { statuses: [], hasUser: r.has_user };
      if (r.status) x.statuses.push(r.status);
      by.set(r.supplier_id, x);
    }
    return [...by.entries()].map(([supplierId, x]) => {
      if (!x.statuses.length) {
        return { supplierId, status: 'NONE' as const, recipients: 0,
          statusLabel: x.hasUser ? 'Davet e-postası yazılmadı' : 'Portal kullanıcısı yok; davet e-postası yazılmadı' };
      }
      const status = INVITE_STATUS_ORDER.find((s) => x.statuses.includes(s as OutboxStatus)) as OutboxStatus;
      return { supplierId, status, statusLabel: EMAIL_STATUS_LABEL[status], recipients: x.statuses.length };
    });
  });
}

// ---------- Özet (P2) ----------

interface StandingRaw {
  surveys: { ratio: string }[]; review: { score: string } | null; verifiedIncidents: { severity: Level }[]; residualLevel: Level | null;
  scoreRiskLevel: Level | null; actions: { title: string; dueDate: string; status: string }[]; pendingSurveys: number; missingDocs: number;
}
const standingRaw = async (tx: Tx) => (await tx.query<{ v: StandingRaw }>(`SELECT app_portal_standing() AS v`)).rows[0]!.v;

const RISK_ACTION_OPEN = new Set(['OPEN']);

/**
 * R15: Skorum ve risk. Puan D103 kuralıyla kodla (`portalStanding`, risk girdisi `scoreRiskLevel`; kendisi dönmez). Seviye: Faz 6
 * yıllık risk değerlendirmesi tamamlanmışsa onun seviyesi (`app_portal_risk()`), değilse son tamamlanmış tedarikçi değerlendirmesinin
 * kalan riski. Beklenen aksiyonlar: açık düzeltici faaliyetler, tedarikçiye görünür açık risk aksiyonları, eksik belgeler, anketler.
 */
export async function standing(tx: Tx, ctx: TenantContext) {
  supplierOnly(ctx);
  const raw = await standingRaw(tx);
  const s = portalStanding({ surveys: raw.surveys, review: raw.review, verifiedIncidents: raw.verifiedIncidents, residualLevel: raw.residualLevel,
    scoreRiskLevel: raw.scoreRiskLevel ?? null, actions: raw.actions, pendingSurveys: raw.pendingSurveys, missingDocs: raw.missingDocs });
  const risk = await portalRisk(tx, ctx);
  const annual = risk.level !== null && risk.year !== null;
  return {
    year: Number(today().slice(0, 4)),
    score: s.score, scoreReason: s.scoreReason,
    levelLabel: annual ? risk.levelLabel : s.levelLabel,
    levelSource: annual ? 'ANNUAL_RISK' as const : s.level ? 'SUPPLIER_ASSESSMENT' as const : null,
    levelSourceLabel: annual ? `${risk.year} yıllık risk değerlendirmesi` : s.level ? 'Son tamamlanmış tedarikçi değerlendirmesi' : null,
    risk: annual ? { year: risk.year, level: risk.level, levelLabel: risk.levelLabel, riskScore: risk.riskScore } : null,
    assessment: s.level ? { level: s.level, levelLabel: s.levelLabel } : null,
    expectedActions: [
      ...s.expectedActions,
      ...risk.actions.filter((a) => RISK_ACTION_OPEN.has(a.status)).map((a) => ({ kind: 'RISK' as const, title: a.title, dueDate: a.dueOn })),
    ],
  };
}

export async function summary(tx: Tx, ctx: TenantContext) {
  const sid = supplierOnly(ctx);
  const openInvites = (await tx.query<{ n: number }>(`SELECT count(*)::int AS n FROM rfq_invitations i JOIN rfq_rounds r ON r.id = i.round_id
    WHERE i.supplier_id = $1 AND r.status = 'OPEN' AND r.closes_at > now()`, [sid])).rows[0]!.n;
  const raw = await standingRaw(tx);
  const docs = await currentDocuments(tx, sid);
  const st = await standing(tx, ctx);
  return {
    openInvites, pendingSurveys: raw.pendingSurveys,
    documents: { expired: docs.filter((d) => d.code === 'EXPIRED').length, expiring: docs.filter((d) => d.code === 'EXPIRING').length, missing: raw.missingDocs },
    standing: { score: st.score, levelLabel: st.levelLabel },
  };
}

// ---------- Tekliflerim ----------

const ROUND_STATUS_TR = { OPEN: 'Açık', CLOSED: 'Kapandı' } as const;

/** Davet edildiği yayınlanmış turlar; tutarlar yalnız kendi güncel teklifinden (başka tedarikçinin teklifi hiç okunmaz). */
export async function bids(tx: Tx, ctx: TenantContext) {
  const sid = supplierOnly(ctx);
  const rows = (await tx.query<{ round_id: string; round_no: number; status: 'OPEN' | 'CLOSED'; closes_at: Date; project_id: string; code: string; title: string;
      buyer_name: string; invited_at: Date; version_no: number | null; submitted_at: Date | null; currency: string | null; versions: number;
      lines_total: string | null; costs_total: string | null; total: string | null }>(
    `SELECT r.id AS round_id, r.round_no, r.status, r.closes_at, p.id AS project_id, p.code, p.title, le.name AS buyer_name, i.created_at AS invited_at,
            b.version_no, b.submitted_at, b.currency,
            (SELECT count(*)::int FROM bids x WHERE x.round_id = r.id AND x.supplier_id = $1) AS versions,
            lt.v::text AS lines_total, ct.v::text AS costs_total, round(lt.v + ct.v, 2)::text AS total
       FROM rfq_invitations i JOIN rfq_rounds r ON r.id = i.round_id JOIN projects p ON p.id = r.project_id JOIN legal_entities le ON le.id = p.company_id
       LEFT JOIN bids b ON b.round_id = r.id AND b.supplier_id = $1 AND b.status = 'SUBMITTED'
       LEFT JOIN LATERAL (SELECT round(coalesce(sum(bl.quantity * bl.unit_price), 0), 2) AS v FROM bid_lines bl WHERE bl.bid_id = b.id AND bl.scope = 'INCLUDED') lt ON b.id IS NOT NULL
       LEFT JOIN LATERAL (SELECT round(coalesce(sum(c.amount), 0), 2) AS v FROM bid_costs c WHERE c.bid_id = b.id) ct ON b.id IS NOT NULL
      WHERE i.supplier_id = $1 AND r.status IN ('OPEN','CLOSED')
      ORDER BY r.closes_at DESC, r.id`, [sid])).rows;
  const now = Date.now();
  return {
    items: rows.map((r) => {
      const open = r.status === 'OPEN' && r.closes_at.getTime() > now;
      return {
        roundId: r.round_id, roundNo: r.round_no, projectId: r.project_id, projectCode: r.code, projectTitle: r.title, buyerName: r.buyer_name,
        invitedAt: r.invited_at, closesAt: r.closes_at, open, roundStatus: open ? 'OPEN' as const : 'CLOSED' as const, roundStatusLabel: ROUND_STATUS_TR[open ? 'OPEN' : 'CLOSED'],
        myBid: r.version_no === null ? null : { versionNo: r.version_no, submittedAt: r.submitted_at, currency: r.currency, linesTotal: r.lines_total, costsTotal: r.costs_total, total: r.total },
        versionCount: r.versions,
        bidStatusLabel: r.version_no === null ? 'Teklif verilmedi' : `Teklif verildi (sürüm ${r.version_no})`,
        link: `/portal/${r.round_id}`,
      };
    }),
  };
}

// ---------- Belgelerim (R12) ----------

const VIA_TR = { PORTAL: 'Firmanız yükledi', INTERNAL: 'Kurum yükledi', APPLICATION: 'Başvuruyla geldi' } as const;

/** Portal görünümü: iç kullanıcı adı (`uploadedByName`) dönmez. */
export function portalDocumentView(r: DocRow, day = today()) {
  const { uploadedByName: _hidden, ...v } = documentView(r, day);
  return { ...v, uploadedViaLabel: VIA_TR[r.uploaded_via as keyof typeof VIA_TR] ?? r.uploaded_via };
}

async function documentRows(tx: Tx, sid: string) {
  return (await tx.query<DocRow>(`${DOC_SELECT} WHERE d.supplier_id = $1 ORDER BY d.type_code, d.created_at DESC`, [sid])).rows;
}
/** Tür başına güncel belge (yenilenmemiş, en geç geçerli). */
async function currentDocuments(tx: Tx, sid: string) {
  const day = today();
  const rows = (await documentRows(tx, sid)).filter((r) => !r.superseded_by_id);
  const best = new Map<string, DocRow>();
  for (const r of rows) {
    const b = best.get(r.type_code);
    if (!b || (b.valid_until !== null && (r.valid_until === null || r.valid_until > b.valid_until))) best.set(r.type_code, r);
  }
  return [...best.values()].map((r) => documentValidity(r.valid_until, day));
}

export async function documents(tx: Tx, ctx: TenantContext) {
  const sid = supplierOnly(ctx);
  const s = (await tx.query<{ service_categories: string[] }>(`SELECT service_categories FROM suppliers WHERE id = $1`, [sid])).rows[0];
  if (!s) throw notFound();
  const day = today();
  const rows = await documentRows(tx, sid);
  const missing = await requiredMissing(tx, s.service_categories, rows.map((r) => ({ typeCode: r.type_code, validUntil: r.valid_until, supersededById: r.superseded_by_id })), day);
  const types = (await tx.query<{ code: string; name: string; required: boolean; required_categories: string[]; expiry_required: boolean }>(
    `SELECT code, name, required, required_categories, expiry_required FROM supplier_document_types WHERE active ORDER BY name, code`)).rows;
  const views = rows.map((r) => portalDocumentView(r, day));
  return {
    types: types.map((t) => ({
      code: t.code, name: t.name, expiryRequired: t.expiry_required,
      required: t.required || t.required_categories.some((c) => s.service_categories.includes(c)),
      current: views.filter((v) => v.typeCode === t.code && v.current),
    })),
    documents: views, missing,
    upload: { maxBytes: SUPPLIER_DOC_MAX_BYTES, mimeTypes: ['application/pdf', 'image/jpeg', 'image/png'] },
  };
}

const INACTIVE = new Set(['ARCHIVED', 'REJECTED', 'MERGED', 'SUSPENDED']);
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const validDate = (s: string) => DATE.test(s) && new Date(`${s}T00:00:00Z`).toISOString().startsWith(s);

export { prepareInternalUpload as preparePortalUpload, type InternalUpload as PortalUpload };

/**
 * Portaldan belge yükleme/yenileme (`uploaded_via='PORTAL'`). Dosya denetimi ve R5 taraması nesne deposuna yazmadan önce (route).
 * `replacesId`: eski belge silinmez, "yerine yenisi yüklendi" olur. Yeni belgenin kapsadığı (aynı tür, daha erken geçerli) belgelerin açık
 * "süresi doldu" görevleri kapanır; Satınalma'ya bilgi görevi açılır.
 */
export async function addPortalDocument(tx: Tx, ctx: TenantContext, u: InternalUpload, p: Awaited<ReturnType<typeof prepareInternalUpload>>) {
  const sid = supplierOnly(ctx);
  const s = (await tx.query<{ status: SupplierStatus; legal_name: string }>(`SELECT status, legal_name FROM suppliers WHERE id = $1`, [sid])).rows[0];
  if (!s) throw notFound();
  if (INACTIVE.has(s.status)) throw conflict('supplier_inactive', 'Firma kaydı pasif; belge yüklenemez. Kurumla iletişime geçin.');
  const typeCode = (u.fields.typeCode ?? '').trim();
  const t = (await tx.query<{ code: string; name: string; expiry_required: boolean }>(`SELECT code, name, expiry_required FROM supplier_document_types WHERE code = $1 AND active`, [typeCode])).rows[0];
  if (!t) throw unprocessable('document_type', 'Belge türü tanımlı ya da etkin değil.', { typeCode });
  const validUntil = (u.fields.validUntil ?? '').trim() || null;
  if (validUntil && !validDate(validUntil)) throw unprocessable('invalid_field', 'Geçerlilik tarihi YYYY-AA-GG biçiminde olmalı.', { field: 'validUntil' });
  if (t.expiry_required && !validUntil) throw unprocessable('valid_until_required', `Geçerlilik tarihi gerekli: ${t.name}.`);
  const day = today();
  if (validUntil && validUntil < day) throw unprocessable('valid_until_past', 'Geçerlilik tarihi geçmiş bir belge yüklenemez; güncel belgeyi yükleyin.', { field: 'validUntil' });
  const title = (u.fields.title ?? '').trim().slice(0, 300) || t.name;
  const replacesId = (u.fields.replacesId ?? '').trim() || null;
  if (replacesId) {
    if (!/^[0-9a-f-]{36}$/i.test(replacesId)) throw unprocessable('replaces_not_found', 'Yenilenecek belge bulunamadı.');
    const old = (await tx.query<{ type_code: string; superseded_by_id: string | null }>(
      `SELECT type_code, superseded_by_id FROM supplier_documents WHERE id = $1 AND supplier_id = $2 FOR UPDATE`, [replacesId, sid])).rows[0];
    if (!old) throw unprocessable('replaces_not_found', 'Yenilenecek belge bulunamadı.');
    if (old.type_code !== typeCode) throw unprocessable('replaces_type_mismatch', 'Yenilenen belge aynı türde olmalı.');
    if (old.superseded_by_id) throw conflict('already_superseded', 'Bu belgenin yerine zaten yenisi yüklendi.');
  }
  const id = randomUUID();
  await tx.query(`INSERT INTO supplier_documents (id, tenant_id, supplier_id, type_code, title, original_filename, mime_type, size_bytes, sha256,
      storage_key, basic_check_status, basic_check_reason, av_scan_status, valid_until, uploaded_via, uploaded_by)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,'PORTAL',$15)`,
    [id, ctx.tenantId, sid, typeCode, title, p.filename, p.mimeType, p.sizeBytes, p.sha256, p.storageKey, p.basicCheckStatus, p.basicCheckReason,
      p.avScanStatus, validUntil, ctx.userId]);
  if (replacesId) await tx.query(`UPDATE supplier_documents SET superseded_by_id = $2 WHERE id = $1`, [replacesId, id]);
  // R12: yenileme gelince eski belgenin açık hatırlatma/"süresi doldu" görevleri kapanır (yenilenen ve yeni belgenin kapsadığı aynı türdekiler).
  const covered = (await tx.query<{ id: string }>(`SELECT id FROM supplier_documents WHERE supplier_id = $1 AND type_code = $2 AND id <> $3
      AND (id = $4 OR (valid_until IS NOT NULL AND ($5::date IS NULL OR valid_until < $5::date)))`, [sid, typeCode, id, replacesId, validUntil])).rows;
  for (const c of covered) await closeTasks(tx, `doc:${c.id}:`);
  await openTask(tx, ctx, { companyId: null, departmentId: null, kind: 'supplier_document_renewed', entityType: 'supplier', entityId: sid,
    title: replacesId ? 'Tedarikçi belge yeniledi' : 'Tedarikçi belge yükledi',
    reason: `${s.legal_name}: ${t.name}${validUntil ? ` (geçerlilik: ${formatDateTr(validUntil)})` : ''} portaldan yüklendi.`,
    nextAction: 'Belgeyi tedarikçi kartında inceleyin.', assigneeRole: 'PROCUREMENT', dedupeKey: `supplier-document:${id}:portal` });
  if (p.avScanStatus === 'ERROR') {
    await openTask(tx, ctx, { companyId: null, departmentId: null, kind: 'supplier_document_av_error', entityType: 'supplier', entityId: sid,
      title: 'Tedarikçi belgesi virüs taramasından geçemedi', reason: `${t.name} belgesi taranamadı ve karantinada.`,
      nextAction: 'Taramayı yeniden yaptırın ya da tedarikçiden belgeyi yeniden isteyin.', assigneeRole: 'PROCUREMENT', severity: 'HIGH', dedupeKey: `supplier-document:${id}:av_error` });
  }
  if (validUntil) await ensureDocumentReminderJob(tx, ctx.tenantId, day);
  await audit(tx, ctx, 'supplier_document.uploaded', 'supplier', sid, { documentId: id, typeCode, replacesId, avScanStatus: p.avScanStatus, via: 'PORTAL' });
  return portalDocumentView((await tx.query<DocRow>(`${DOC_SELECT} WHERE d.id = $1`, [id])).rows[0]!);
}

// ---------- Firma bilgileri (R14) ----------

export const CHANGE_FIELDS = { LEGAL_NAME: 'Unvan', TAX_ID: 'Vergi kimlik numarası', OTHER: 'Diğer firma bilgisi' } as const;
export type ChangeField = keyof typeof CHANGE_FIELDS;
const MAX_OPEN_CHANGE_REQUESTS = 5;

async function openChangeRequests(tx: Tx, sid: string) {
  return (await tx.query<{ dedupe_key: string; created_at: Date }>(`SELECT dedupe_key, created_at FROM tasks
    WHERE kind = 'supplier_profile_change_request' AND entity_type = 'supplier' AND entity_id = $1 AND status = 'OPEN' ORDER BY created_at`, [sid])).rows
    .map((t) => { const field = t.dedupe_key.split(':')[3] as ChangeField; return { field, fieldLabel: CHANGE_FIELDS[field] ?? field, requestedAt: t.created_at }; });
}

export async function profile(tx: Tx, ctx: TenantContext) {
  const sid = supplierOnly(ctx);
  const s = (await tx.query<{ legal_name: string; country: string; tax_id_type: string; tax_id: string | null; status: SupplierStatus; contact_name: string | null;
      contact_email: string | null; contact_phone: string | null; address: string | null; service_categories: string[]; row_version: number }>(
    `SELECT legal_name, country, tax_id_type, tax_id, status, contact_name, contact_email, contact_phone, address, service_categories, row_version
       FROM suppliers WHERE id = $1`, [sid])).rows[0];
  if (!s) throw notFound();
  return {
    legalName: s.legal_name, country: s.country, taxIdType: s.tax_id_type, taxId: s.tax_id, stageLabel: supplierStage(s.status).label,
    contactName: s.contact_name, contactEmail: s.contact_email, contactPhone: s.contact_phone, address: s.address, serviceCategories: s.service_categories,
    rowVersion: s.row_version,
    editableFields: ['contactName', 'contactPhone', 'address'] as const,
    changeRequestFields: Object.entries(CHANGE_FIELDS).map(([code, label]) => ({ code, label })),
    pendingChangeRequests: await openChangeRequests(tx, sid),
  };
}

/** Yalnız iletişim kişisi, telefon ve adres (`portal_update_contact`, SECURITY DEFINER). Unvan, VKN, e-posta ve durum değişmez. */
export async function updateProfile(tx: Tx, ctx: TenantContext, b: { contactName: string; contactPhone?: string | null; address?: string | null }) {
  const sid = supplierOnly(ctx);
  const name = (b.contactName ?? '').trim();
  const phone = (b.contactPhone ?? '').trim() || null;
  const address = (b.address ?? '').trim() || null;
  if (name.length < 2 || name.length > 200) throw unprocessable('invalid_field', 'İletişim kişisi 2–200 karakter olmalı.', { field: 'contactName' });
  if (phone && (phone.length > 40 || !/^[0-9+()\s.-]+$/.test(phone))) throw unprocessable('invalid_field', 'Telefon en çok 40 karakter; yalnız rakam, boşluk ve + ( ) - . içerebilir.', { field: 'contactPhone' });
  if (address && address.length > 1000) throw unprocessable('invalid_field', 'Adres en çok 1000 karakter olabilir.', { field: 'address' });
  const before = (await tx.query<{ contact_name: string | null; contact_phone: string | null; address: string | null }>(
    `SELECT contact_name, contact_phone, address FROM suppliers WHERE id = $1`, [sid])).rows[0];
  if (!before) throw notFound();
  const r = (await tx.query<{ v: { contactName: string; contactPhone: string | null; address: string | null; rowVersion: number } }>(
    `SELECT portal_update_contact($1, $2, $3) AS v`, [name, phone, address])).rows[0]!.v;
  const prev = { contactName: before.contact_name, contactPhone: before.contact_phone, address: before.address };
  const changed = (['contactName', 'contactPhone', 'address'] as const).filter((k) => prev[k] !== r[k]);
  await audit(tx, ctx, 'supplier.profile.portal_updated', 'supplier', sid, {
    before: Object.fromEntries(changed.map((k) => [k, prev[k]])), after: Object.fromEntries(changed.map((k) => [k, r[k]])) });
  return { contactName: r.contactName, contactPhone: r.contactPhone, address: r.address, rowVersion: r.rowVersion, changed };
}

/** Unvan, VKN ya da diğer bilgi değişikliği isteği → Satınalma görevi (veri değişmez). Açık istek sayısı sınırlı. */
export async function requestChange(tx: Tx, ctx: TenantContext, b: { field: ChangeField; note: string }) {
  const sid = supplierOnly(ctx);
  if (!Object.hasOwn(CHANGE_FIELDS, b.field)) throw unprocessable('invalid_field', 'Değişiklik alanı geçersiz.', { field: 'field' });
  const note = (b.note ?? '').trim();
  if (note.length < 10 || note.length > 1000) throw unprocessable('note_required', 'İsteğinizi 10–1000 karakterle açıklayın (ör. yeni unvan ve dayanak belge).', { field: 'note' });
  // Tedarikçi oturumu suppliers satırını kilitleyemez (052a supplier_no_direct_update); açık istek sınırı danışma kilidiyle sıralanır.
  await tx.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`supplier-change-request:${sid}`]);
  const s = (await tx.query<{ legal_name: string }>(`SELECT legal_name FROM suppliers WHERE id = $1`, [sid])).rows[0];
  if (!s) throw notFound();
  if ((await openChangeRequests(tx, sid)).length >= MAX_OPEN_CHANGE_REQUESTS) {
    throw new ApiError(429, 'too_many_requests', 'Yanıt bekleyen çok sayıda değişiklik isteğiniz var; önce Satınalma\'nın yanıtını bekleyin.');
  }
  const label = CHANGE_FIELDS[b.field];
  const task = await openTask(tx, ctx, { companyId: null, departmentId: null, kind: 'supplier_profile_change_request', entityType: 'supplier', entityId: sid,
    title: `Tedarikçi bilgi değişikliği isteği: ${label}`, reason: `${s.legal_name} portaldan şu değişikliği istedi: ${note}`,
    nextAction: b.field === 'TAX_ID' ? 'Dayanak belgeyle doğrulayın; VKN değişikliği kimlik doğrulaması ve gerekirse kart birleştirme gerektirir.'
      : 'Dayanak belgeyle doğrulayıp tedarikçi kartında güncelleyin.',
    assigneeRole: 'PROCUREMENT', dedupeKey: `supplier:${sid}:change_request:${b.field}:${randomUUID()}` });
  await audit(tx, ctx, 'supplier.change_requested', 'supplier', sid, { field: b.field, taskId: task.id });
  return { requested: true, field: b.field, fieldLabel: label, message: 'İsteğiniz Satınalma\'ya iletildi. Bilgiler doğrulandıktan sonra güncellenir.' };
}
