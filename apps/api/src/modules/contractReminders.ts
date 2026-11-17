import { randomUUID } from 'node:crypto';
import { addMonths, can, noticeDeadline, normalizeRoles, reminderDates, type NoticeUnit, type NonWorkingDayRule, type Reminder } from '@sp/domain';
import type { TenantContext, Tx } from '../db.ts';
import { audit } from '../audit.ts';
import { closeTasks, openTask } from '../tasks.ts';
import { notFound, unprocessable } from '../errors.ts';
import { currentApprovers } from './approvers.ts';

/**
 * v2 Faz 3 (D108+, R7) Görev 6: sözleşme bitiş ve ihbar hatırlatıcıları + e-posta kuyruğu.
 *
 * - Kurulum (`scheduleContractReminders`): onay zinciri tamamlanınca (Görev 5) ya da eski kayıtta koşullar doğrulanınca
 *   (`contractTerms.verifyTerms`). Ailenin güncel sürümünün son koşul revizyonu için kiracı süreleriyle (varsayılan 90,60,30,7)
 *   `contract_reminders` satırı ve `contract.end_reminder` işi yazılır. İş anahtarı `reminder:{terms}:{kind}:{offset}`; aynı koşul
 *   revizyonu ikinci kez kurulmaz (süre ayarı değişse de: değişiklik yalnız sonraki kurulumları etkiler).
 * - İşçi (`processEndReminder`): sözleşme sorumlusu ve departman sorumlusuna kişisel görev (İşlerim) + `email_outbox` satırı;
 *   30 ve 7 günde (ve ihbar hatırlatıcısında) Satınalma rol kuyruğuna görev, satınalma sorumlusuna e-posta. Kişi alıcı yoksa
 *   (sorumlu ve departman sorumlusu atanmamış) görev Satınalma kuyruğuna düşer. E-posta kanalı bu fazda bağlı değil: satır
 *   `NOT_CONFIGURED` yazılır, gönderilmiş gibi gösterilmez.
 * - Mevcut ihbar uyarısı (`contract.notice_reminder`, doğrulanmış koşulda 90/60/30, Satınalma kuyruğu) aynen kalır; o uyarı
 *   bu sözleşmeyi kapsıyorsa (koşul doğrulanmış, bitiş ve ihbar süresi var) NOTICE hatırlatıcısı Satınalma kuyruğunda ikinci görev açmaz.
 * - Görevler karar girilene kadar açık kalır; yenileme kararı (`decideRenewal`, dört seçenek) `contract-reminder:{aile}:` görevlerini kapatır.
 */

export const DEFAULT_OFFSETS = [90, 60, 30, 7];
export const EMAIL_NOT_CONFIGURED_LABEL = 'Gönderilmedi — e-posta kanalı yapılandırılmadı';
const EMAIL_STATUS_TR: Record<string, string> = {
  NOT_CONFIGURED: EMAIL_NOT_CONFIGURED_LABEL, QUEUED: 'Kuyrukta (henüz gönderilmedi)', SENT: 'Gönderildi', FAILED: 'Gönderilemedi',
};
const KIND_TR: Record<'END' | 'NOTICE', string> = { END: 'Bitiş hatırlatıcısı', NOTICE: 'Fesih ihbarı hatırlatıcısı' };
export const DECISION_TR: Record<string, string> = {
  RENEW: 'Yenilenecek', TERMINATE: 'Sonlandırılacak', RENEGOTIATE: 'Yeniden müzakere edilecek', NEW_PROJECT: 'Yeni proje açıldı',
};
/** Bu fazda gerçek e-posta kanalı (Graph) bağlı değil; gönderici uydurulmaz. */
export const emailChannelConfigured = () => false;

const today = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Istanbul' }).format(new Date());
const trDate = (d: string) => d.split('-').reverse().join('.');
const daysBetween = (from: string, to: string) => Math.round((Date.parse(to) - Date.parse(from)) / 86_400_000);
export const taskPrefix = (familyId: string) => `contract-reminder:${familyId}:`;

interface FamilyRow {
  id: string; code: string; title: string; company_id: string; department_id: string | null; owner_user_id: string | null; indefinite: boolean;
  intake_flow: boolean; termination_notice_amount: number | null; termination_notice_unit: NoticeUnit | null;
  version_id: string | null; terms_id: string | null; start_date: string | null; end_date: string | null; auto_renewal: boolean | null;
  notice_amount: number | null; notice_unit: NoticeUnit | null; non_working_day_rule: NonWorkingDayRule | null; verified_at: Date | null;
}

async function loadFamily(tx: Tx, familyId: string): Promise<FamilyRow | null> {
  return (await tx.query<FamilyRow>(`SELECT f.id, f.code, f.title, f.company_id, f.department_id, f.owner_user_id, f.indefinite, f.intake_flow,
      f.termination_notice_amount, f.termination_notice_unit, cv.id AS version_id,
      t.id AS terms_id, t.start_date::text, t.end_date::text, t.auto_renewal, t.notice_amount, t.notice_unit, t.non_working_day_rule, t.verified_at
    FROM contract_families f
    LEFT JOIN LATERAL (SELECT v.id FROM contract_versions v WHERE v.family_id = f.id AND v.superseded_by_id IS NULL ORDER BY v.version_no DESC LIMIT 1) cv ON true
    LEFT JOIN LATERAL (SELECT x.* FROM contract_terms x WHERE x.contract_version_id = cv.id ORDER BY x.revision DESC LIMIT 1) t ON true
    WHERE f.id = $1`, [familyId])).rows[0] ?? null;
}

async function holidays(tx: Tx): Promise<string[]> {
  return (await tx.query<{ day: string }>(`SELECT day::text FROM tenant_holidays ORDER BY day`)).rows.map((r) => r.day);
}

export async function tenantOffsets(tx: Tx): Promise<number[]> {
  return (await tx.query<{ offsets: number[] }>(`SELECT offsets FROM contract_reminder_settings`)).rows[0]?.offsets ?? DEFAULT_OFFSETS;
}

export interface NoticeBasis { deadline: string; basis: 'END_DATE' | 'ANNIVERSARY'; anniversary: string | null }

/**
 * İhbar son günü. Otomatik yenilemeli süreli sözleşmede bitişten (mevcut ihbar kuralı, tatiller dahil). Süresiz sözleşmede bitiş yoktur:
 * ihbar süresi ailededir (051) ve başlangıç tarihinin yıl dönümüne uygulanır; son günü bugünden önce olmayan ilk yıl dönümü kullanılır.
 */
export function noticeBasis(f: Pick<FamilyRow, 'indefinite' | 'termination_notice_amount' | 'termination_notice_unit' | 'start_date' | 'end_date' | 'auto_renewal'
  | 'notice_amount' | 'notice_unit' | 'non_working_day_rule'>, h: string[], day: string): NoticeBasis | null {
  const nonWorkingDay = f.non_working_day_rule ?? 'PREVIOUS_WORKING_DAY';
  if (f.indefinite) {
    if (f.termination_notice_amount == null || !f.termination_notice_unit || !f.start_date) return null;
    const rule = { amount: f.termination_notice_amount, unit: f.termination_notice_unit, nonWorkingDay };
    for (let k = 1; k <= 200; k++) {
      const anniversary = addMonths(f.start_date, 12 * k);
      const deadline = noticeDeadline(anniversary, rule, h).deadline;
      if (deadline >= day) return { deadline, basis: 'ANNIVERSARY', anniversary };
    }
    return null;
  }
  if (!f.auto_renewal || !f.end_date || f.notice_amount == null || !f.notice_unit) return null;
  return { deadline: noticeDeadline(f.end_date, { amount: f.notice_amount, unit: f.notice_unit, nonWorkingDay }, h).deadline, basis: 'END_DATE', anniversary: null };
}

/** Plan (kayıt yazmadan): kiracı süreleriyle hangi tarihlerde hatırlatılacağı. `day` verilirse geçmiş tarihler reminderDates kuralıyla bugüne çekilir. */
export async function plannedReminders(tx: Tx, f: FamilyRow, opts: { offsets?: number[]; day?: string; collapsePast?: boolean } = {}) {
  const day = opts.day ?? today();
  const offsets = opts.offsets ?? await tenantOffsets(tx);
  const nb = f.terms_id ? noticeBasis(f, await holidays(tx), day) : null;
  const list: Reminder[] = f.terms_id ? reminderDates({ endDate: f.end_date, indefinite: f.indefinite, autoRenewal: !!f.auto_renewal, noticeDeadline: nb?.deadline ?? null,
    offsets, ...(opts.collapsePast ? { today: day } : {}) }) : [];
  return { offsets, notice: nb, list };
}

// --- Kurulum ---------------------------------------------------------------------------------------------------------------

/**
 * R7 kurulumu. Ailenin güncel sürümünün son koşul revizyonu için hatırlatıcıları yazar ve işlerini kuyruğa koyar.
 * İdempotent: bu koşul revizyonu için hatırlatıcı zaten varsa yenisini yazmaz (mevcutları döner). Koşul yoksa ya da tarih yoksa boş döner.
 */
export async function scheduleContractReminders(tx: Tx, ctx: TenantContext, familyId: string) {
  await tx.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`contract-reminders:${familyId}`]);
  const f = await loadFamily(tx, familyId);
  if (!f) throw notFound();
  if (!f.terms_id) return { termsId: null, created: false, reminders: [] as { id: string; kind: 'END' | 'NOTICE'; offset: number; dueOn: string }[] };
  const existing = (await tx.query<{ id: string; kind: 'END' | 'NOTICE'; offset_days: number; due_on: string }>(
    `SELECT id, kind, offset_days, due_on::text FROM contract_reminders WHERE terms_id = $1 ORDER BY due_on, kind`, [f.terms_id])).rows;
  if (existing.length) return { termsId: f.terms_id, created: false, reminders: existing.map((r) => ({ id: r.id, kind: r.kind, offset: r.offset_days, dueOn: r.due_on })) };

  const day = today();
  const { offsets, notice, list } = await plannedReminders(tx, f, { day, collapsePast: true });
  const out: { id: string; kind: 'END' | 'NOTICE'; offset: number; dueOn: string }[] = [];
  for (const r of list) {
    const id = randomUUID();
    // RETURNING yok: hatırlatıcı satırı yazanın görünürlüğünden bağımsız (onaycı başka departmandan olabilir).
    const ins = await tx.query(`INSERT INTO contract_reminders (id, tenant_id, family_id, terms_id, kind, offset_days, due_on)
      VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (terms_id, kind, offset_days) DO NOTHING`, [id, ctx.tenantId, familyId, f.terms_id, r.kind, r.offset, r.date]);
    if (!ins.rowCount) continue;
    const runAt = r.date <= day ? new Date() : new Date(`${r.date}T06:00:00+03:00`);
    await tx.query(`INSERT INTO jobs (tenant_id, company_id, kind, idempotency_key, payload, requested_by, run_after)
      VALUES ($1,$2,'contract.end_reminder',$3,$4,$5,$6) ON CONFLICT (tenant_id, kind, idempotency_key) DO NOTHING`,
      [ctx.tenantId, f.company_id, `reminder:${f.terms_id}:${r.kind}:${r.offset}`,
        { reminderId: id, familyId, termsId: f.terms_id, kind: r.kind, offset: r.offset, dueOn: r.date }, ctx.userId, runAt]);
    out.push({ id, kind: r.kind, offset: r.offset, dueOn: r.date });
  }
  await audit(tx, ctx, 'contract.reminders.scheduled', 'contract_family', familyId,
    { termsId: f.terms_id, offsets, notice, reminders: out.map((r) => ({ kind: r.kind, offset: r.offset, dueOn: r.dueOn })) });
  return { termsId: f.terms_id, created: out.length > 0, reminders: out };
}

// --- İşçi ------------------------------------------------------------------------------------------------------------------

async function roleOf(tx: Tx, userId: string): Promise<string> {
  const r = (await tx.query<{ roles: string[] }>(`SELECT roles FROM memberships WHERE user_id = $1 AND supplier_id IS NULL`, [userId])).rows[0];
  const roles = normalizeRoles(r?.roles ?? []);
  return roles.includes('PROCUREMENT') ? 'PROCUREMENT' : roles.includes('DEPARTMENT_USER') ? 'DEPARTMENT_USER' : roles[0] ?? 'PROCUREMENT';
}

/** Kiracının etkin iç üyesi mi (sözleşme sorumlusu ayrılmış ya da askıya alınmış olabilir). */
async function activeMember(tx: Tx, tenantId: string, userId: string | null): Promise<{ id: string; email: string; display_name: string } | null> {
  if (!userId) return null;
  return (await tx.query<{ id: string; email: string; display_name: string }>(`SELECT u.id, u.email, u.display_name FROM memberships m JOIN users u ON u.id = m.user_id
    WHERE m.tenant_id = $1 AND m.user_id = $2 AND m.status = 'ACTIVE' AND m.supplier_id IS NULL AND cardinality(m.roles) > 0`, [tenantId, userId])).rows[0] ?? null;
}

async function userById(tx: Tx, userId: string) {
  return (await tx.query<{ id: string; email: string; display_name: string }>(`SELECT id, email, display_name FROM users WHERE id = $1`, [userId])).rows[0] ?? null;
}

export async function processEndReminder(tx: Tx, ctx: TenantContext, jobId: string) {
  const j = (await tx.query<{ payload: { reminderId: string; familyId: string } }>(`SELECT payload FROM jobs WHERE id = $1`, [jobId])).rows[0];
  if (!j) throw notFound();
  const finish = (result: Record<string, unknown>) => tx.query(`UPDATE jobs SET status = 'SUCCEEDED', result = $2, updated_at = now() WHERE id = $1`, [jobId, result]);
  const r = (await tx.query<{ id: string; family_id: string; terms_id: string; kind: 'END' | 'NOTICE'; offset_days: number; due_on: string }>(
    `SELECT id, family_id, terms_id, kind, offset_days, due_on::text FROM contract_reminders WHERE id = $1`, [j.payload.reminderId])).rows[0];
  if (!r) return finish({ skipped: 'reminder_not_visible' });
  await tx.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`contract-reminders:${r.family_id}`]);
  const f = await loadFamily(tx, r.family_id);
  if (!f) return finish({ skipped: 'contract_not_visible' });
  // Koşul değiştiyse (yeni revizyon ya da yeni sürüm) ya da karar girildiyse hatırlatıcı sessizce eskir.
  const decided = (await tx.query(`SELECT 1 FROM renewal_decisions WHERE terms_id = $1`, [r.terms_id])).rowCount;
  if (f.terms_id !== r.terms_id || decided) return finish({ skipped: decided ? 'decided' : 'obsolete' });

  const day = today();
  const h = await holidays(tx);
  const nb = r.kind === 'NOTICE' ? noticeBasis(f, h, day) : null;
  const target = r.kind === 'END' ? f.end_date : nb?.deadline ?? null;
  if (!target) return finish({ skipped: 'obsolete' });
  const left = daysBetween(day, target);
  // Mevcut ihbar uyarısı (doğrulanmış koşul + bitiş + ihbar süresi) Satınalma kuyruğunu zaten uyarıyor: ikinci kuyruk görevi açılmaz.
  const legacyNoticeCovers = r.kind === 'NOTICE' && !f.indefinite && f.verified_at != null && f.end_date != null && f.notice_amount != null;
  const includeProcurement = (r.kind === 'END' ? r.offset_days === 30 || r.offset_days === 7 : true) && !legacyNoticeCovers;

  const owner = await activeMember(tx, ctx.tenantId, f.owner_user_id);
  const approvers = await currentApprovers(tx, f.department_id ?? '00000000-0000-0000-0000-000000000000');
  const head = f.department_id && approvers.head ? await userById(tx, approvers.head.userId) : null;
  const people = [owner, head].filter((p, i, a): p is NonNullable<typeof p> => !!p && a.findIndex((x) => x?.id === p.id) === i);
  // Kişi alıcı yoksa hatırlatıcı kaybolmaz: Satınalma kuyruğuna düşer.
  const queue = includeProcurement || people.length === 0;

  const what = r.kind === 'END' ? `Sözleşme bitişi ${trDate(target)}` : `Fesih ihbarı son günü ${trDate(target)}`;
  const when = left > 0 ? `${left} gün kaldı` : left === 0 ? 'bugün' : `${-left} gün geçti`;
  const title = `${what} (${when}): ${f.code}`;
  const basisText = r.kind === 'END' ? '' : nb?.basis === 'ANNIVERSARY'
    ? ` Süresiz sözleşme: ihbar süresi başlangıcın yıl dönümüne (${trDate(nb.anniversary!)}) uygulanır.`
    : ` Bitiş ${trDate(f.end_date!)}; otomatik yenileme ihbar süresi dolmadan bildirilmezse sözleşme yenilenir.`;
  const reason = `${f.code} · ${f.title}. ${KIND_TR[r.kind]} (${r.offset_days} gün önce).${basisText} Karar girilene kadar bu görev açık kalır.`;
  const nextAction = 'Sözleşmeye karar verin: yenilenecek, sonlandırılacak, yeniden müzakere edilecek ya da yeni proje açıldı.';
  const severity = r.offset_days <= 7 || left <= 7 ? 'CRITICAL' as const : r.offset_days <= 30 || left <= 30 ? 'HIGH' as const : 'NORMAL' as const;
  const dueAt = new Date(`${target}T23:59:59+03:00`);

  const taskIds: string[] = [];
  const recipients: { key: string; userId: string | null; role: string; companyId: string | null }[] = [
    ...(await Promise.all(people.map(async (p) => ({ key: p.id, userId: p.id, role: await roleOf(tx, p.id), companyId: null })))),
    ...(queue ? [{ key: 'PROCUREMENT', userId: null, role: 'PROCUREMENT', companyId: f.company_id }] : []),
  ];
  for (const rc of recipients) {
    const prefix = `${taskPrefix(f.id)}${r.kind}:${rc.key}:`;
    // Daha acil (küçük süreli) hatırlatıcı açıksa daha az acil olan onu geri almaz; değilse öncekiler kapanır.
    const open = (await tx.query<{ id: string; dedupe_key: string }>(`SELECT id, dedupe_key FROM tasks WHERE status = 'OPEN' AND dedupe_key LIKE $1`, [`${prefix}%`])).rows;
    const urgent = open.find((t) => Number(t.dedupe_key.split(':').pop()) < r.offset_days);
    if (urgent) { taskIds.push(urgent.id); continue; }
    await closeTasks(tx, prefix);
    // Kişi görevi departmansız ve şirketsiz (sorumlu başka departmandan olabilir); kuyruk görevi şirket kapsamında.
    const t = await openTask(tx, ctx, {
      companyId: rc.companyId, kind: 'contract_reminder', entityType: 'contract_reminder', entityId: f.id, departmentId: null,
      title, reason, nextAction, assigneeRole: rc.role, assigneeUserId: rc.userId, severity, dueAt, dedupeKey: `${prefix}${r.offset_days}`,
    });
    taskIds.push(t.id);
  }

  // E-posta: kişi alıcılar + Satınalma kuyruğu varsa satınalma sorumlusu. Kanal yoksa NOT_CONFIGURED (gönderilmiş gibi gösterilmez).
  const lead = queue && approvers.lead ? await userById(tx, approvers.lead.userId) : null;
  const mailTo = [...people, ...(lead && !people.some((p) => p.id === lead.id) ? [lead] : [])];
  const status = emailChannelConfigured() ? 'QUEUED' : 'NOT_CONFIGURED';
  let emails = 0;
  for (const p of mailTo) {
    const dup = (await tx.query(`SELECT 1 FROM email_outbox WHERE related_type = 'contract_reminder' AND related_id = $1 AND to_user_id = $2`, [r.id, p.id])).rowCount;
    if (dup) continue;
    await tx.query(`INSERT INTO email_outbox (id, tenant_id, to_user_id, to_email, subject, body_text, related_type, related_id, status)
      VALUES ($1,$2,$3,$4,$5,$6,'contract_reminder',$7,$8)`,
      [randomUUID(), ctx.tenantId, p.id, p.email, `Sözleşme hatırlatıcısı: ${title}`.slice(0, 300),
        `Sayın ${p.display_name},\n\n${reason}\n\n${nextAction}\n\nBu ileti Satınalma Platformu tarafından hazırlanmıştır.`, r.id, status]);
    emails++;
  }
  await tx.query(`UPDATE contract_reminders SET task_ids = $2 WHERE id = $1`, [r.id, [...new Set(taskIds)]]);
  return finish({ reminderId: r.id, kind: r.kind, offset: r.offset_days, target, tasks: taskIds.length, emails, emailStatus: status, procurementQueue: queue });
}

// --- Ayar ------------------------------------------------------------------------------------------------------------------

export async function getSettings(tx: Tx) {
  const row = (await tx.query<{ offsets: number[]; updated_at: Date; updated_by: string | null; name: string | null }>(
    `SELECT s.offsets, s.updated_at, s.updated_by, u.display_name AS name FROM contract_reminder_settings s LEFT JOIN users u ON u.id = s.updated_by`)).rows[0];
  return {
    offsets: row?.offsets ?? DEFAULT_OFFSETS, defaults: DEFAULT_OFFSETS, isDefault: !row,
    updatedAt: row?.updated_at ?? null, updatedBy: row?.updated_by ? { id: row.updated_by, displayName: row.name ?? '' } : null,
    note: 'Değişiklik yalnız bundan sonra kurulan hatırlatıcıları etkiler; kurulmuş hatırlatıcılar değişmez.',
  };
}

export async function putSettings(tx: Tx, ctx: TenantContext, body: { offsets: number[] }) {
  // Şema 1–365, tekrarsız, 1–6 değer denetler; burada da (servis çağrıları için) aynı kural.
  const offsets = [...body.offsets].sort((a, b) => b - a);
  if (!offsets.length || offsets.length > 6 || new Set(offsets).size !== offsets.length || offsets.some((o) => !Number.isInteger(o) || o < 1 || o > 365)) {
    throw unprocessable('invalid_offsets', 'Hatırlatıcı süreleri 1–365 gün arasında, tekrarsız ve en çok 6 değer olmalı.');
  }
  const before = await tenantOffsets(tx);
  await tx.query(`INSERT INTO contract_reminder_settings (tenant_id, offsets, updated_by, updated_at) VALUES ($1,$2,$3,now())
    ON CONFLICT (tenant_id) DO UPDATE SET offsets = EXCLUDED.offsets, updated_by = EXCLUDED.updated_by, updated_at = now()`, [ctx.tenantId, offsets, ctx.userId]);
  await audit(tx, ctx, 'contract.reminder_settings.updated', 'tenant', ctx.tenantId, { before, after: offsets });
  return getSettings(tx);
}

// --- Okuma -----------------------------------------------------------------------------------------------------------------

export async function getReminders(tx: Tx, ctx: TenantContext, familyId: string) {
  const f = await loadFamily(tx, familyId);
  if (!f) throw notFound();
  const day = today();
  const plan = await plannedReminders(tx, f, { day });
  const rows = (await tx.query<{ id: string; terms_id: string; kind: 'END' | 'NOTICE'; offset_days: number; due_on: string; task_ids: string[]; created_at: Date;
      job_status: string | null; job_result: Record<string, unknown> | null }>(
    `SELECT r.id, r.terms_id, r.kind, r.offset_days, r.due_on::text, r.task_ids, r.created_at, j.status AS job_status, j.result AS job_result
     FROM contract_reminders r
     LEFT JOIN jobs j ON j.kind = 'contract.end_reminder' AND j.idempotency_key = 'reminder:' || r.terms_id || ':' || r.kind || ':' || r.offset_days
     WHERE r.family_id = $1 ORDER BY r.due_on, r.kind, r.offset_days`, [familyId])).rows;
  const taskIds = rows.flatMap((r) => r.task_ids);
  const tasks = new Map((await tx.query<{ id: string; status: string; assignee_user_id: string | null; assignee_role: string; name: string | null; closed_at: Date | null }>(
    `SELECT t.id, t.status, t.assignee_user_id, t.assignee_role, u.display_name AS name, t.closed_at FROM tasks t LEFT JOIN users u ON u.id = t.assignee_user_id
     WHERE t.id = ANY($1::uuid[])`, [taskIds])).rows.map((t) => [t.id, t]));
  // RLS: tüm departmanları gören bağlam bütün satırları, bölüm kullanıcısı yalnız kendisine giden e-postayı görür (050).
  const mails = (await tx.query<{ id: string; related_id: string; to_user_id: string | null; name: string | null; status: string; created_at: Date; sent_at: Date | null; error: string | null }>(
    `SELECT e.id, e.related_id, e.to_user_id, u.display_name AS name, e.status, e.created_at, e.sent_at, e.error FROM email_outbox e LEFT JOIN users u ON u.id = e.to_user_id
     WHERE e.related_type = 'contract_reminder' AND e.related_id = ANY($1::uuid[]) ORDER BY e.created_at`, [rows.map((r) => r.id)])).rows;
  const decision = f.terms_id ? (await tx.query<{ decision: string; rationale: string; decided_at: Date; name: string | null }>(
    `SELECT d.decision, d.rationale, d.decided_at, u.display_name AS name FROM renewal_decisions d LEFT JOIN users u ON u.id = d.decided_by WHERE d.terms_id = $1`,
    [f.terms_id])).rows[0] ?? null : null;
  const approved = f.terms_id && f.version_id ? !!(await tx.query(`SELECT 1 FROM contract_approval_chains WHERE family_id = $1 AND version_id = $2 AND terms_id = $3
    AND outcome = 'APPROVED'`, [familyId, f.version_id, f.terms_id])).rowCount : false;

  const reminders = rows.map((r) => {
    const ts = r.task_ids.map((id) => tasks.get(id)).filter((t): t is NonNullable<typeof t> => !!t);
    const fired = r.task_ids.length > 0;
    const state = fired ? (ts.some((t) => t.status === 'OPEN') ? 'OPEN' : 'CLOSED')
      : r.job_status === 'SUCCEEDED' ? 'SKIPPED' : r.job_status === 'DEAD' || r.job_status === 'BLOCKED' ? 'FAILED' : 'PLANNED';
    return {
      id: r.id, termsId: r.terms_id, current: r.terms_id === f.terms_id, kind: r.kind, kindLabel: KIND_TR[r.kind], offset: r.offset_days, dueOn: r.due_on,
      includeProcurement: r.kind === 'NOTICE' || r.offset_days === 30 || r.offset_days === 7, state, jobStatus: r.job_status,
      skippedReason: state === 'SKIPPED' ? (r.job_result?.skipped as string | undefined) ?? null : null,
      tasks: ts.map((t) => ({ id: t.id, status: t.status, closedAt: t.closed_at,
        recipient: t.assignee_user_id ? { type: 'USER' as const, userId: t.assignee_user_id, displayName: t.name ?? '' }
          : { type: 'ROLE' as const, role: t.assignee_role, label: t.assignee_role === 'PROCUREMENT' ? 'Satınalma' : t.assignee_role } })),
      emails: mails.filter((m) => m.related_id === r.id).map((m) => ({ id: m.id, toUser: m.to_user_id ? { id: m.to_user_id, displayName: m.name ?? '' } : null,
        status: m.status, statusLabel: EMAIL_STATUS_TR[m.status] ?? m.status, createdAt: m.created_at, sentAt: m.sent_at })),
    };
  });
  return {
    familyId, termsId: f.terms_id, scheduled: rows.some((r) => r.terms_id === f.terms_id),
    offsets: plan.offsets,
    basis: { endDate: f.end_date, indefinite: f.indefinite, autoRenewal: f.terms_id ? !!f.auto_renewal : null,
      noticeDeadline: plan.notice?.deadline ?? null, noticeBasis: plan.notice?.basis ?? null, anniversary: plan.notice?.anniversary ?? null },
    planned: plan.list,
    reminders,
    decision: decision && { decision: decision.decision, label: DECISION_TR[decision.decision] ?? decision.decision, rationale: decision.rationale,
      decidedAt: decision.decided_at, decidedBy: decision.name },
    emailChannel: { configured: emailChannelConfigured(), label: emailChannelConfigured() ? 'E-posta kanalı bağlı' : EMAIL_NOT_CONFIGURED_LABEL },
    can: {
      decide: can(ctx.roles, 'contract.renewal.decide') && !!f.terms_id && !decision && (f.verified_at != null || approved),
      settings: can(ctx.roles, 'reminder.settings'),
    },
    contractVersionId: f.version_id,
  };
}

