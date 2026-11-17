import type pg from 'pg';
import type { MailConfig } from '../config.ts';
import { withTenant, type TenantContext, type Tx } from '../db.ts';
import { GraphMailSender } from './graph.ts';

/**
 * v2 Faz 5 (R6): e-posta kanalı ve kuyruğu (`email_outbox`).
 *
 * - `none` (varsayılan): satır `NOT_CONFIGURED` yazılır; gönderilmez, ekranda "gönderildi" görünmez (Faz 3 davranışı).
 * - `graph`: satır `QUEUED` + `email.dispatch` işi (satır başına tek iş). İşçi gönderir: başarı `SENT` + `sent_at`; hata kısa kodla
 *   `error` alanına yazılır, iş yeniden denenir; 3. başarısız denemede satır `FAILED`. Sır ya da gövde günlüğe yazılmaz.
 * - Kanal sonradan açılırsa eski `NOT_CONFIGURED` satırları gönderilmez: iş yalnız `QUEUED` satır için kurulur ve işçi yalnız
 *   `QUEUED` satırı gönderir (bayat davet/hatırlatma gitmez).
 */

export type MailChannel = { kind: 'none' } | { kind: 'graph'; sender: string };
export type OutboxStatus = 'QUEUED' | 'NOT_CONFIGURED' | 'SENT' | 'FAILED';

export interface MailSender {
  readonly kind: string;
  send(m: { to: string; subject: string; body: string }): Promise<{ ok: true } | { ok: false; code: string }>;
}

export const DISPATCH_JOB = 'email.dispatch';
export const EMAIL_NOT_CONFIGURED_LABEL = 'Gönderilmedi — e-posta kanalı yapılandırılmadı';
export const EMAIL_STATUS_LABEL: Record<OutboxStatus, string> = {
  NOT_CONFIGURED: EMAIL_NOT_CONFIGURED_LABEL, QUEUED: 'Kuyrukta (henüz gönderilmedi)', SENT: 'Gönderildi', FAILED: 'Gönderilemedi',
};
export const CHANNEL_NOT_CONFIGURED_LABEL = 'E-posta kanalı yapılandırılmadı — aşağıdaki iletiler gönderilmedi';

/** Yapılandırmadan kanal (sır taşımaz). */
export function channelOf(cfg: MailConfig | undefined | null): MailChannel {
  return cfg?.kind === 'graph' ? { kind: 'graph', sender: cfg.sender } : { kind: 'none' };
}

let current: MailChannel = { kind: 'none' };
/** Süreç açılışında (API ve işçi) bir kez çağrılır; çağrılmazsa kanal `none` (gönderim yok). */
export function configureMailChannel(cfg: MailConfig | undefined | null): MailChannel {
  current = channelOf(cfg);
  return current;
}
export const mailChannel = (): MailChannel => current;

export function channelInfo(channel: MailChannel): { kind: MailChannel['kind']; sender: string | null; label: string } {
  return channel.kind === 'graph'
    ? { kind: 'graph', sender: channel.sender, label: `Microsoft Graph: ${channel.sender}` }
    : { kind: 'none', sender: null, label: CHANNEL_NOT_CONFIGURED_LABEL };
}

/** Yapılandırılmış gönderici; `none` → null (işçi `email.dispatch` çekmez). */
export function mailSender(cfg: MailConfig | undefined | null, fetchImpl?: typeof fetch): MailSender | null {
  if (cfg?.kind !== 'graph') return null;
  return new GraphMailSender(cfg, fetchImpl);
}

export interface QueuedMail { toUserId?: string | null; toEmail: string; subject: string; body: string; relatedType: string; relatedId: string }

/** Kuyruğa tek satır yazar (çağıranın işlemi içinde). `graph` kanalında gönderim işi de aynı işlemde kurulur. */
export async function queueEmail(tx: Tx, ctx: TenantContext, mail: QueuedMail, channel: MailChannel = current): Promise<{ id: string; status: 'QUEUED' | 'NOT_CONFIGURED' }> {
  const status = channel.kind === 'graph' ? 'QUEUED' as const : 'NOT_CONFIGURED' as const;
  const id = (await tx.query<{ id: string }>(`INSERT INTO email_outbox (tenant_id, to_user_id, to_email, subject, body_text, related_type, related_id, status)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
    [ctx.tenantId, mail.toUserId ?? null, mail.toEmail, mail.subject.slice(0, 300), mail.body, mail.relatedType, mail.relatedId, status])).rows[0]!.id;
  if (status === 'QUEUED') await enqueueEmailDispatch(tx, ctx.tenantId, id);
  return { id, status };
}

/**
 * `QUEUED` satır için gönderim işi (idempotent: satır başına tek iş). Satırı veritabanı işlevi yazdıysa (ör. girişsiz başvuru) çağıran
 * aynı kiracı bağlamında bunu çağırır.
 */
export async function enqueueEmailDispatch(tx: Tx, tenantId: string, outboxId: string): Promise<void> {
  await tx.query(`INSERT INTO jobs (tenant_id, kind, idempotency_key, payload, requested_by) VALUES ($1,$2,$3,$4,NULL)
    ON CONFLICT (tenant_id, kind, idempotency_key) DO NOTHING`, [tenantId, DISPATCH_JOB, `email:${outboxId}`, { outboxId }]);
}

const SYSTEM_USER = '00000000-0000-0000-0000-000000000000';
/** Gönderim sistem işidir: kuyruğa yazanın üyeliğine bağlı değildir; tüm departmanları gören bağlam (050 RLS). */
export const dispatchContext = (tenantId: string, jobId: string): TenantContext =>
  ({ tenantId, userId: SYSTEM_USER, roles: [], companyIds: [], departmentIds: [], allDepartments: true, correlationId: `job-${jobId}` });

/**
 * İşçi: `email.dispatch`. Ağ çağrısı veritabanı işlemi dışında yapılır. Yalnız `QUEUED` satır gönderilir.
 * Dönüş yalnız durum ve kısa koddur (gövde, alıcı, sır yok).
 */
export async function processEmailDispatch(pool: pg.Pool, sender: MailSender, tenantId: string, jobId: string): Promise<{ status: string; code?: string }> {
  const ctx = dispatchContext(tenantId, jobId);
  const row = await withTenant(pool, ctx, async (tx) => {
    const j = (await tx.query<{ payload: { outboxId?: string } }>(`SELECT payload FROM jobs WHERE id = $1`, [jobId])).rows[0];
    const outboxId = j?.payload?.outboxId;
    if (!outboxId) return null;
    return (await tx.query<{ id: string; to_email: string | null; subject: string; body_text: string; status: OutboxStatus }>(
      `SELECT id, to_email, subject, body_text, status FROM email_outbox WHERE id = $1`, [outboxId])).rows[0] ?? null;
  });
  const finish = (tx: Tx, status: 'SUCCEEDED' | 'DEAD', result: Record<string, unknown>, code: string | null = null) =>
    tx.query(`UPDATE jobs SET status = $2, result = $3, error_code = $4, updated_at = now() WHERE id = $1`, [jobId, status, result, code]);

  if (!row || row.status !== 'QUEUED') {
    await withTenant(pool, ctx, (tx) => finish(tx, 'SUCCEEDED', { skipped: row ? `status_${row.status}` : 'not_found' }));
    return { status: 'SKIPPED' };
  }
  if (!row.to_email) {
    await withTenant(pool, ctx, async (tx) => {
      await tx.query(`UPDATE email_outbox SET status = 'FAILED', error = 'no_recipient' WHERE id = $1 AND status = 'QUEUED'`, [row.id]);
      await finish(tx, 'DEAD', { status: 'FAILED' }, 'no_recipient');
    });
    return { status: 'FAILED', code: 'no_recipient' };
  }

  const r = await sender.send({ to: row.to_email, subject: row.subject, body: row.body_text });
  return withTenant(pool, ctx, async (tx) => {
    if (r.ok) {
      await tx.query(`UPDATE email_outbox SET status = 'SENT', sent_at = now(), error = NULL WHERE id = $1 AND status = 'QUEUED'`, [row.id]);
      await finish(tx, 'SUCCEEDED', { status: 'SENT' });
      return { status: 'SENT' };
    }
    const code = r.code.slice(0, 60);
    const j = (await tx.query<{ attempts: number; max_attempts: number }>(`SELECT attempts, max_attempts FROM jobs WHERE id = $1`, [jobId])).rows[0]!;
    if (j.attempts >= j.max_attempts) {
      await tx.query(`UPDATE email_outbox SET status = 'FAILED', error = $2 WHERE id = $1 AND status = 'QUEUED'`, [row.id, code]);
      await finish(tx, 'DEAD', { status: 'FAILED' }, code);
      return { status: 'FAILED', code };
    }
    // Satır kuyrukta kalır (son hata kodu görünür); iş artan beklemeyle yeniden denenir.
    await tx.query(`UPDATE email_outbox SET error = $2 WHERE id = $1 AND status = 'QUEUED'`, [row.id, code]);
    await tx.query(`UPDATE jobs SET status = 'QUEUED', run_after = now() + (attempts * interval '60 seconds'), error_code = $2, updated_at = now() WHERE id = $1`, [jobId, code]);
    return { status: 'RETRY', code };
  });
}
