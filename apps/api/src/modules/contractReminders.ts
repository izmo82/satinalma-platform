import { randomUUID } from 'node:crypto';
import { addMonths, can, noticeDeadline, normalizeRoles, reminderDates, type NoticeUnit, type NonWorkingDayRule, type Reminder } from '@sp/domain';
import type pg from 'pg';
import { withTenant, withoutTenant, type TenantContext, type Tx } from '../db.ts';
import { audit } from '../audit.ts';
import { closeTasks, openTask } from '../tasks.ts';
import { notFound, unprocessable } from '../errors.ts';
import { currentApprovers } from './approvers.ts';
import { EMAIL_NOT_CONFIGURED_LABEL, EMAIL_STATUS_LABEL, mailChannel, queueEmail } from '../mail/index.ts';

/**
 * v2 Faz 3 (D108+, R7) Görev 6: sözleşme bitiş ve ihbar hatırlatıcıları + e-posta kuyruğu.
 *
 * - Kurulum (`scheduleContractReminders`): onay zinciri tamamlanınca (Görev 5) ya da eski kayıtta koşullar doğrulanınca
 *   (`contractTerms.verifyTerms`; geri doldurma: `backfillLegacyReminders`, gece sistem işi). Yürürlükteki koşul revizyonu
 *   (`effectiveTermsId`: en yeni onaylı zincirin koşulu; eski kayıtta en yeni doğrulanmış koşul) için kiracı süreleriyle (varsayılan 90,60,30,7)
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
// v2 Faz 5 (R6): etiketler ve kuyruk yazımı ortak e-posta yardımcısında (`mail/index.ts`); metinler aynı.
export { EMAIL_NOT_CONFIGURED_LABEL };
const EMAIL_STATUS_TR: Record<string, string> = EMAIL_STATUS_LABEL;
/** Rol kuyruğu adı; bilinmeyen rol ham kod olarak gösterilmez (final inceleme M3). */
const ROLE_QUEUE_TR: Record<string, string> = {
  PROCUREMENT: 'Satınalma', DEPARTMENT_USER: 'Departman kullanıcıları', LEGAL: 'Hukuk', FINANCE: 'Finans', ADMIN: 'Yönetici', AUDITOR: 'Denetçi',
};
const KIND_TR: Record<'END' | 'NOTICE', string> = { END: 'Bitiş hatırlatıcısı', NOTICE: 'Fesih ihbarı hatırlatıcısı' };
export const DECISION_TR: Record<string, string> = {
  RENEW: 'Yenilenecek', TERMINATE: 'Sonlandırılacak', RENEGOTIATE: 'Yeniden müzakere edilecek', NEW_PROJECT: 'Yeni proje açıldı',
};
/** v2 Faz 5 (R6): yapılandırılmış kanal (`MAIL_PROVIDER`); varsayılan `none` → bağlı değil, gönderici uydurulmaz. */
export const emailChannelConfigured = () => mailChannel().kind !== 'none';

/** İstanbul takvim günü (YYYY-MM-DD). */
export const istanbulDay = (d: Date) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Istanbul' }).format(d);
const today = () => istanbulDay(new Date());
const trDate = (d: string) => d.split('-').reverse().join('.');
const daysBetween = (from: string, to: string) => Math.round((Date.parse(to) - Date.parse(from)) / 86_400_000);
export const SYSTEM_USER = '00000000-0000-0000-0000-000000000000';
export const taskPrefix = (familyId: string) => `contract-reminder:${familyId}:`;

interface FamilyRow {
  id: string; code: string; title: string; company_id: string; department_id: string | null; owner_user_id: string | null; indefinite: boolean;
  intake_flow: boolean; termination_notice_amount: number | null; termination_notice_unit: NoticeUnit | null;
  version_id: string | null; version_no: number | null; revision: number | null; version_current: boolean | null; latest_of_version: boolean | null;
  terms_id: string | null; start_date: string | null; end_date: string | null; auto_renewal: boolean | null;
  notice_amount: number | null; notice_unit: NoticeUnit | null; non_working_day_rule: NonWorkingDayRule | null; verified_at: Date | null;
}

/**
 * Aile + seçilen koşul revizyonu. `termsId` verilmezse güncel (geçersiz kılınmamış) sürümün son revizyonu (önizleme için).
 * `version_current`/`latest_of_version`: mevcut ihbar uyarısının bu koşulda hâlâ çalışıp çalışmayacağını belirler.
 */
async function loadFamily(tx: Tx, familyId: string, termsId?: string | null): Promise<FamilyRow | null> {
  const pick = termsId
    ? `SELECT x.* FROM contract_terms x JOIN contract_versions xv ON xv.id = x.contract_version_id WHERE x.id = $2 AND xv.family_id = f.id`
    : `SELECT x.* FROM contract_versions xv JOIN contract_terms x ON x.contract_version_id = xv.id
       WHERE xv.family_id = f.id AND xv.superseded_by_id IS NULL ORDER BY xv.version_no DESC, x.revision DESC LIMIT 1`;
  return (await tx.query<FamilyRow>(`SELECT f.id, f.code, f.title, f.company_id, f.department_id, f.owner_user_id, f.indefinite, f.intake_flow,
      f.termination_notice_amount, f.termination_notice_unit, t.contract_version_id AS version_id, v.version_no, t.revision,
      (v.superseded_by_id IS NULL) AS version_current,
      NOT EXISTS (SELECT 1 FROM contract_terms y WHERE y.contract_version_id = t.contract_version_id AND y.revision > t.revision) AS latest_of_version,
      t.id AS terms_id, t.start_date::text, t.end_date::text, t.auto_renewal, t.notice_amount, t.notice_unit, t.non_working_day_rule, t.verified_at
    FROM contract_families f
    LEFT JOIN LATERAL (${pick}) t ON true
    LEFT JOIN contract_versions v ON v.id = t.contract_version_id
    WHERE f.id = $1`, termsId ? [familyId, termsId] : [familyId])).rows[0] ?? null;
}

/**
 * Yürürlükteki koşul revizyonu (Görev 6 inceleme I1): en yeni (sürüm no, revizyon) APPROVED zincirin koşulu; onaylı zincir yoksa ve
 * aile eski kayıtsa (intake_flow false) en yeni doğrulanmış koşul. Onaydan sonra eklenen, henüz onaylanmamış zeyilname sürümü
 * yürürlükteki koşulu değiştirmez; hatırlatıcılar onaylı koşulla sürer.
 */
export async function effectiveTermsId(tx: Tx, familyId: string): Promise<string | null> {
  const approved = (await tx.query<{ terms_id: string }>(`SELECT c.terms_id FROM contract_approval_chains c JOIN contract_terms t ON t.id = c.terms_id
    JOIN contract_versions v ON v.id = t.contract_version_id WHERE c.family_id = $1 AND c.outcome = 'APPROVED'
    ORDER BY v.version_no DESC, t.revision DESC LIMIT 1`, [familyId])).rows[0];
  if (approved) return approved.terms_id;
  const legacy = (await tx.query<{ id: string }>(`SELECT t.id FROM contract_families f JOIN contract_versions v ON v.family_id = f.id
    JOIN contract_terms t ON t.contract_version_id = v.id WHERE f.id = $1 AND NOT f.intake_flow AND t.verified_at IS NOT NULL
    ORDER BY v.version_no DESC, t.revision DESC LIMIT 1`, [familyId])).rows[0];
  return legacy?.id ?? null;
}

/** Mevcut ihbar uyarısı (`contract.notice_reminder`) bu koşulda çalışır mı: doğrulanmış, süreli, bitiş + ihbar süresi var, sürümün güncel son revizyonu. */
const existingNoticeCovers = (f: FamilyRow) => !f.indefinite && f.verified_at != null && f.end_date != null && f.notice_amount != null
  && !!f.version_current && !!f.latest_of_version;
const includesProcurement = (f: FamilyRow, kind: 'END' | 'NOTICE', offset: number) =>
  (kind === 'END' ? offset === 30 || offset === 7 : true) && !(kind === 'NOTICE' && existingNoticeCovers(f));

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
  return { offsets, notice: nb, list: list.map((r) => ({ ...r, includeProcurement: includesProcurement(f, r.kind, r.offset) })) };
}

// --- Kurulum ---------------------------------------------------------------------------------------------------------------

/**
 * R7 kurulumu. Yürürlükteki koşul revizyonu (`effectiveTermsId`) için hatırlatıcıları yazar ve işlerini kuyruğa koyar. Görev 5 bunu
 * zinciri APPROVED kapattıktan sonra aynı işlemde çağırır. İdempotent: bu koşul revizyonu için hatırlatıcı zaten varsa yenisini
 * yazmaz (mevcutları döner). Yürürlükte koşul yoksa ya da tarih yoksa boş döner (denetim kaydı da yazılmaz).
 */
export async function scheduleContractReminders(tx: Tx, ctx: TenantContext, familyId: string) {
  await tx.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`contract-reminders:${familyId}`]);
  if (!(await tx.query(`SELECT 1 FROM contract_families WHERE id = $1`, [familyId])).rowCount) throw notFound();
  const eff = await effectiveTermsId(tx, familyId);
  const f = eff ? await loadFamily(tx, familyId, eff) : null;
  if (!f || !f.terms_id) return { termsId: null, created: false, reminders: [] as { id: string; kind: 'END' | 'NOTICE'; offset: number; dueOn: string }[] };
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
        { reminderId: id, familyId, termsId: f.terms_id, kind: r.kind, offset: r.offset, dueOn: r.date }, ctx.userId === SYSTEM_USER ? null : ctx.userId, runAt]);
    out.push({ id, kind: r.kind, offset: r.offset, dueOn: r.date });
  }
  if (out.length) {
    await audit(tx, ctx, 'contract.reminders.scheduled', 'contract_family', familyId,
      { termsId: f.terms_id, offsets, notice, reminders: out.map((r) => ({ kind: r.kind, offset: r.offset, dueOn: r.dueOn })) });
  }
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
  const f = await loadFamily(tx, r.family_id, r.terms_id);
  if (!f || !f.terms_id) return finish({ skipped: 'contract_not_visible' });
  // Karar girildiyse ya da DAHA YENİ bir yürürlükteki koşul (yeni onay / yeni doğrulanmış eski kayıt koşulu) varsa hatırlatıcı sessizce eskir.
  // Onaylanmamış zeyilname sürümü yürürlükteki koşulu değiştirmez: hatırlatıcı onaylı koşulla çalışır.
  const decided = (await tx.query(`SELECT 1 FROM renewal_decisions WHERE terms_id = $1`, [r.terms_id])).rowCount;
  if (decided) return finish({ skipped: 'decided' });
  const eff = await effectiveTermsId(tx, r.family_id);
  if (eff && eff !== r.terms_id) {
    const e = await loadFamily(tx, r.family_id, eff);
    if (e && (e.version_no! > f.version_no! || (e.version_no === f.version_no && e.revision! > f.revision!))) return finish({ skipped: 'obsolete', effectiveTermsId: eff });
  }

  const day = today();
  const h = await holidays(tx);
  const nb = r.kind === 'NOTICE' ? noticeBasis(f, h, day) : null;
  const target = r.kind === 'END' ? f.end_date : nb?.deadline ?? null;
  if (!target) return finish({ skipped: 'obsolete' });
  const left = daysBetween(day, target);
  // Mevcut ihbar uyarısı bu koşulda çalışıyorsa Satınalma kuyruğunu zaten uyarıyor: ikinci kuyruk görevi açılmaz.
  const includeProcurement = includesProcurement(f, r.kind, r.offset_days);

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
  const channel = mailChannel();
  const status = channel.kind === 'none' ? 'NOT_CONFIGURED' : 'QUEUED';
  let emails = 0;
  for (const p of mailTo) {
    const dup = (await tx.query(`SELECT 1 FROM email_outbox WHERE related_type = 'contract_reminder' AND related_id = $1 AND to_user_id = $2`, [r.id, p.id])).rowCount;
    if (dup) continue;
    await queueEmail(tx, ctx, { toUserId: p.id, toEmail: p.email, subject: `Sözleşme hatırlatıcısı: ${title}`.slice(0, 300),
      body: `Sayın ${p.display_name},\n\n${reason}\n\n${nextAction}\n\nBu ileti Satınalma Platformu tarafından hazırlanmıştır.`,
      relatedType: 'contract_reminder', relatedId: r.id }, channel);
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
  if (!(await tx.query(`SELECT 1 FROM contract_families WHERE id = $1`, [familyId])).rowCount) throw notFound();
  // Yürürlükteki koşul (onaylı / eski kayıtta doğrulanmış); yoksa önizleme için güncel sürümün son koşulu.
  const eff = await effectiveTermsId(tx, familyId);
  const f = (await loadFamily(tx, familyId, eff))!;
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

  const termsRows = new Map<string, FamilyRow>([[f.terms_id ?? '', f]]);
  for (const tid of new Set(rows.map((r) => r.terms_id))) if (!termsRows.has(tid)) termsRows.set(tid, (await loadFamily(tx, familyId, tid))!);
  const reminders = rows.map((r) => {
    const ts = r.task_ids.map((id) => tasks.get(id)).filter((t): t is NonNullable<typeof t> => !!t);
    const fired = r.task_ids.length > 0;
    const state = fired ? (ts.some((t) => t.status === 'OPEN') ? 'OPEN' : 'CLOSED')
      : r.job_status === 'SUCCEEDED' ? 'SKIPPED' : r.job_status === 'DEAD' || r.job_status === 'BLOCKED' ? 'FAILED' : 'PLANNED';
    return {
      id: r.id, termsId: r.terms_id, current: r.terms_id === f.terms_id, kind: r.kind, kindLabel: KIND_TR[r.kind], offset: r.offset_days, dueOn: r.due_on,
      includeProcurement: includesProcurement(termsRows.get(r.terms_id) ?? f, r.kind, r.offset_days), state, jobStatus: r.job_status,
      skippedReason: state === 'SKIPPED' ? (r.job_result?.skipped as string | undefined) ?? null : null,
      tasks: ts.map((t) => ({ id: t.id, status: t.status, closedAt: t.closed_at,
        recipient: t.assignee_user_id ? { type: 'USER' as const, userId: t.assignee_user_id, displayName: t.name ?? '' }
          : { type: 'ROLE' as const, role: t.assignee_role, label: ROLE_QUEUE_TR[t.assignee_role] ?? 'Rol kuyruğu' } })),
      emails: mails.filter((m) => m.related_id === r.id).map((m) => ({ id: m.id, toUser: m.to_user_id ? { id: m.to_user_id, displayName: m.name ?? '' } : null,
        status: m.status, statusLabel: EMAIL_STATUS_TR[m.status] ?? m.status, createdAt: m.created_at, sentAt: m.sent_at })),
    };
  });
  return {
    familyId, termsId: f.terms_id, contractVersionId: f.version_id, effective: eff != null, scheduled: rows.some((r) => r.terms_id === f.terms_id),
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
  };
}


// --- Sistem işleri (Görev 6 inceleme M1, I3) -------------------------------------------------------------------------------

/**
 * Sistem bağlamı: kuran kullanıcıya bağlı değildir (kişi ayrılsa ya da askıya alınsa da hatırlatıcı çalışır). Rol yok; kapsam iş satırının
 * şirketi (ya da kiracının şirketleri) ve tüm departmanlar. `retention.purge` ile aynı desen.
 */
export const systemContext = (tenantId: string, companyIds: string[], jobId: string): TenantContext =>
  ({ tenantId, userId: SYSTEM_USER, roles: [], companyIds, departmentIds: [], allDepartments: true, correlationId: `job-${jobId}` });

/**
 * Geri doldurma koşulu (051b; 051d ile aynı): eski kayıt (intake_flow false); onaylı ya da açık zinciri yok (yalnız iptal/ret
 * zinciri olabilir: final inceleme M1); güncel sürümün son koşulu doğrulanmış ve o koşul için hatırlatıcı yok; süresi dolmamış
 * (süreli: bitiş bugün ya da sonra; süresiz: ihbar süresi ve başlangıç var). Süresi dolmuş sözleşmeye hatırlatıcı kurulmaz
 * (final inceleme I1); bu yüzden her gün yeniden seçilmez. `$1` İstanbul günü.
 */
export const BACKFILL_FAMILY_WHERE = `NOT f.intake_flow
      AND NOT EXISTS (SELECT 1 FROM contract_approval_chains c WHERE c.family_id = f.id AND (c.outcome IS NULL OR c.outcome NOT IN ('CANCELLED','REJECTED')))
      AND EXISTS (SELECT 1 FROM contract_versions v
        JOIN LATERAL (SELECT t.id, t.verified_at, t.start_date, t.end_date FROM contract_terms t WHERE t.contract_version_id = v.id ORDER BY t.revision DESC LIMIT 1) lt ON true
        WHERE v.family_id = f.id AND v.superseded_by_id IS NULL AND lt.verified_at IS NOT NULL
          AND NOT EXISTS (SELECT 1 FROM contract_reminders r WHERE r.terms_id = lt.id)
          AND CASE WHEN f.indefinite THEN f.termination_notice_amount IS NOT NULL AND lt.start_date IS NOT NULL
                   ELSE lt.end_date IS NOT NULL AND lt.end_date >= $1::date END)`;

/** Geri doldurma: `BACKFILL_FAMILY_WHERE` koşulundaki aileler. İdempotent. */
export async function backfillLegacyReminders(tx: Tx, ctx: TenantContext) {
  const fams = (await tx.query<{ id: string }>(`SELECT f.id FROM contract_families f
    WHERE ${BACKFILL_FAMILY_WHERE}
    ORDER BY f.created_at, f.id`, [today()])).rows;
  let scheduled = 0;
  for (const f of fams) if ((await scheduleContractReminders(tx, ctx, f.id)).created) scheduled++;
  return { candidates: fams.length, scheduled };
}

/** Gece/başlangıç: geri doldurulacak ailesi olan her kiracıya günde bir `contract.reminder_backfill` işi (İstanbul günü anahtarlı). */
export async function enqueueReminderBackfills(pool: pg.Pool, now: Date): Promise<number> {
  const day = istanbulDay(now);
  const tenants = await withoutTenant(pool, async (c) =>
    (await c.query<{ tenant_id: string }>(`SELECT t AS tenant_id FROM contract_reminder_backfill_tenants() t`)).rows);
  let n = 0;
  for (const { tenant_id } of tenants) {
    const ctx = systemContext(tenant_id, [], `backfill-${day}`);
    n += await withTenant(pool, ctx, async (tx) => (await tx.query(`INSERT INTO jobs (tenant_id, kind, idempotency_key, payload, requested_by)
      VALUES ($1,'contract.reminder_backfill',$2,$3,NULL) ON CONFLICT (tenant_id, kind, idempotency_key) DO NOTHING`,
      [tenant_id, `reminder-backfill:${day}`, { day }])).rowCount ?? 0);
  }
  return n;
}

/**
 * İşçi kapısı (final inceleme, ertelenen #3): tarama İstanbul gününde bir kez (bellekte son gün) yapılır, her dakika değil.
 * Tarama hata verirse gün işaretlenmez; en erken bir dakika sonra yeniden denenir. Yeni gün başlayınca yeniden tarar.
 */
export function dailyReminderBackfill(enqueue: (pool: pg.Pool, now: Date) => Promise<number> = enqueueReminderBackfills) {
  let lastDay = '';
  let lastTry = Number.NEGATIVE_INFINITY;
  return async (pool: pg.Pool, now: Date): Promise<number | null> => {
    const day = istanbulDay(now);
    if (day === lastDay || now.getTime() - lastTry < 60_000) return null;
    lastTry = now.getTime();
    const n = await enqueue(pool, now);
    lastDay = day;
    return n;
  };
}

export async function processReminderBackfill(pool: pg.Pool, tenantId: string, jobId: string) {
  const companyIds = await withTenant(pool, systemContext(tenantId, [], jobId), async (tx) =>
    (await tx.query<{ id: string }>(`SELECT id FROM legal_entities ORDER BY id`)).rows.map((r) => r.id));
  const ctx = systemContext(tenantId, companyIds, jobId);
  return withTenant(pool, ctx, async (tx) => {
    const r = await backfillLegacyReminders(tx, ctx);
    await tx.query(`UPDATE jobs SET status = 'SUCCEEDED', result = $2, updated_at = now() WHERE id = $1`, [jobId, r]);
    return r;
  });
}
