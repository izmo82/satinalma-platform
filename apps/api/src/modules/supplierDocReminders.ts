import type pg from 'pg';
import { documentExpiryEmail, formatDateTr } from '@sp/domain';
import { withTenant, type TenantContext, type Tx } from '../db.ts';
import { queueEmail } from '../mail/index.ts';
import { openTask } from '../tasks.ts';
import { istanbulDay, systemContext } from './contractReminders.ts';

/**
 * v2 Faz 5 (D110) R12: tedarikçi belgesi hatırlatmaları. Günlük işçi işi `supplier.document_reminders` (kiracı başına, tekil anahtar
 * `doc-reminders:<İstanbul günü>`). Bitişten 30 ve 7 gün önce ve bitiş günü: tedarikçinin etkin portal kullanıcılarına e-posta
 * (`documentExpiryEmail`); bitiş gününde Satınalma görevi "Tedarikçi belgesinin süresi doldu" (`doc:{id}:expired`). Belge + gün farkı
 * başına tek `supplier_document_reminders` satırı (UNIQUE): işçi tekrarında çift satır, e-posta ya da görev yok.
 *
 * Kiracı listesi: kiracıları sayan bir SECURITY DEFINER işlevi bu fazda yok (migration eklenmedi). Zincir kendini sürdürür: her çalışma
 * önce ertesi günün işini kurar; zinciri ilk kez belge yüklemesi (portal, iç yükleme, başvuru onayıyla karta geçen belge) başlatır.
 */

export const DOC_REMINDER_JOB = 'supplier.document_reminders';
export const REMINDER_OFFSETS = [30, 7, 0] as const;
/** İşçi bir gün çalışmadıysa hatırlatma en çok bu kadar gün geç yazılır (daha eskisi atlanır; kart zaten "Süresi doldu" gösterir). */
export const CATCH_UP_DAYS = 6;
const ACTIVE_STATUSES = ['CANDIDATE', 'ACTIVE', 'CONDITIONAL'];

const DAY_MS = 86_400_000;
const addDays = (day: string, n: number) => new Date(Date.parse(`${day}T00:00:00Z`) + n * DAY_MS).toISOString().slice(0, 10);
/** İstanbul (UTC+3, yaz saati yok) gününün 00:05'i. */
const istanbulStart = (day: string) => new Date(`${day}T00:05:00+03:00`);

/** Kiracının o günkü hatırlatma işini kurar (idempotent). `runAfter` verilmezse hemen çalışabilir. */
export async function ensureDocumentReminderJob(tx: Tx, tenantId: string, day = istanbulDay(new Date()), runAfter: Date | null = null): Promise<boolean> {
  const r = await tx.query(`INSERT INTO jobs (tenant_id, kind, idempotency_key, payload, requested_by, run_after) VALUES ($1,$2,$3,$4,NULL,coalesce($5, now()))
    ON CONFLICT (tenant_id, kind, idempotency_key) DO NOTHING`, [tenantId, DOC_REMINDER_JOB, `doc-reminders:${day}`, { day }, runAfter]);
  return (r.rowCount ?? 0) > 0;
}

interface DueDoc { id: string; supplier_id: string; legal_name: string; type_code: string; type_name: string | null; valid_until: string }

/** Belgenin `day` günü yazılacak hatırlatması: penceredeki (son CATCH_UP_DAYS gün) en yakın gün farkı; yoksa null. */
export function dueOffset(validUntil: string, day: string): number | null {
  const due = REMINDER_OFFSETS.filter((o) => { const d = addDays(validUntil, -o); return d <= day && d >= addDays(day, -CATCH_UP_DAYS); });
  return due.length ? Math.min(...due) : null;
}

/**
 * Bir kiracı için `day` (İstanbul) günü hatırlatmalarını yazar. Yalnız güncel belge (yerine yenisi yüklenmemiş ve aynı türde daha geç
 * geçerli belgesi olmayan) ve etkin/aday tedarikçi. Sistem bağlamında (tüm departmanlar) çalışır.
 */
export async function runDocumentReminders(tx: Tx, ctx: TenantContext, day: string, webOrigin: string) {
  const docs = (await tx.query<DueDoc>(
    `SELECT d.id, d.supplier_id, s.legal_name, d.type_code, t.name AS type_name, d.valid_until::text
       FROM supplier_documents d JOIN suppliers s ON s.id = d.supplier_id
       LEFT JOIN supplier_document_types t ON t.tenant_id = d.tenant_id AND t.code = d.type_code
      WHERE d.supplier_id IS NOT NULL AND d.superseded_by_id IS NULL AND d.valid_until IS NOT NULL
        AND d.valid_until BETWEEN $1::date - $2::int AND $1::date + 30
        AND s.status = ANY($3::text[])
        AND NOT EXISTS (SELECT 1 FROM supplier_documents n WHERE n.supplier_id = d.supplier_id AND n.type_code = d.type_code AND n.id <> d.id
                          AND n.superseded_by_id IS NULL AND (n.valid_until IS NULL OR n.valid_until > d.valid_until))
      ORDER BY d.valid_until, d.id`, [day, CATCH_UP_DAYS, ACTIVE_STATUSES])).rows;
  const link = `${webOrigin.replace(/\/$/, '')}/portal/belgeler`;
  const result = { reminders: 0, emails: 0, tasks: 0, withoutPortalUser: 0 };
  for (const d of docs) {
    const offset = dueOffset(d.valid_until, day);
    if (offset === null) continue;
    const rem = (await tx.query<{ id: string }>(`INSERT INTO supplier_document_reminders (tenant_id, document_id, offset_days, due_on) VALUES ($1,$2,$3,$4)
      ON CONFLICT (document_id, offset_days) DO NOTHING RETURNING id`, [ctx.tenantId, d.id, offset, addDays(d.valid_until, -offset)])).rows[0];
    if (!rem) continue;
    result.reminders++;
    const documentName = d.type_name ?? d.type_code;
    const users = (await tx.query<{ user_id: string; email: string }>(
      `SELECT m.user_id, u.email FROM memberships m JOIN users u ON u.id = m.user_id
        WHERE m.tenant_id = $1 AND m.supplier_id = $2 AND m.status = 'ACTIVE' ORDER BY u.email, u.id`, [ctx.tenantId, d.supplier_id])).rows;
    let firstMail: string | null = null;
    const mail = documentExpiryEmail({ supplierName: d.legal_name, documentName, validUntil: d.valid_until, offset, link });
    for (const u of users) {
      const out = await queueEmail(tx, ctx, { toUserId: u.user_id, toEmail: u.email, subject: mail.subject, body: mail.body, relatedType: 'supplier_document', relatedId: d.id });
      firstMail ??= out.id;
      result.emails++;
    }
    if (!users.length) result.withoutPortalUser++;
    let taskId: string | null = null;
    if (offset === 0) {
      taskId = (await openTask(tx, ctx, { companyId: null, departmentId: null, kind: 'supplier_document_expired', entityType: 'supplier', entityId: d.supplier_id,
        title: 'Tedarikçi belgesinin süresi doldu', reason: `${d.legal_name}: ${documentName} belgesinin geçerliliği ${formatDateTr(d.valid_until)} tarihinde sona eriyor.`,
        nextAction: users.length ? 'Tedarikçiden güncel belgeyi isteyin ya da karttan yükleyin.' : 'Tedarikçinin portal kullanıcısı yok; güncel belgeyi isteyin ya da karttan yükleyin.',
        assigneeRole: 'PROCUREMENT', dedupeKey: `doc:${d.id}:expired` })).id;
      result.tasks++;
    }
    if (firstMail || taskId) {
      await tx.query(`UPDATE supplier_document_reminders SET email_outbox_id = coalesce(email_outbox_id, $2), task_id = coalesce(task_id, $3) WHERE id = $1`,
        [rem.id, firstMail, taskId]);
    }
  }
  return result;
}

/**
 * İşçi: `supplier.document_reminders`. Önce ertesi günün işini kurar (zincir bu çalışma başarısız olsa da sürer), sonra bugünün (çalışma
 * anındaki İstanbul günü; iş gecikmişse kaçırılan gün CATCH_UP_DAYS içinde telafi edilir) hatırlatmalarını yazar.
 */
export async function processDocumentReminderJob(pool: pg.Pool, tenantId: string, jobId: string, opts: { webOrigin: string; now?: Date }) {
  const day = istanbulDay(opts.now ?? new Date());
  const base = systemContext(tenantId, [], jobId);
  await withTenant(pool, base, (tx) => ensureDocumentReminderJob(tx, tenantId, addDays(day, 1), istanbulStart(addDays(day, 1))));
  return withTenant(pool, base, async (tx) => {
    const result = { day, ...(await runDocumentReminders(tx, base, day, opts.webOrigin)) };
    await tx.query(`UPDATE jobs SET status = 'SUCCEEDED', result = $2, updated_at = now() WHERE id = $1`, [jobId, result]);
    return result;
  });
}
