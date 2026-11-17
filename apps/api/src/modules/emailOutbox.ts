import type { Tx } from '../db.ts';
import { channelInfo, EMAIL_STATUS_LABEL, type MailChannel, type OutboxStatus } from '../mail/index.ts';

/**
 * v2 Faz 5 (R7): Yönetim > E-posta kutusu (yalnız okuma; satır değiştirme ya da silme yok). Bütün `email_outbox` satırları
 * (RLS: kiracı + tüm departmanları gören bağlam). Üst bantta kanal durumu. Geliştirme ve testte gövdedeki belirteçli bağlantı açık
 * (e2e doğrulama bağlantısını buradan alır); üretimde `#token=` değeri `••••` ile maskelenir.
 */
export const TOKEN_MASK = '••••';
/** `#token=<değer>` → `#token=••••` (bağlantının geri kalanı görünür kalır). */
export const maskTokens = (text: string) => text.replace(/#token=[^\s&#]+/g, `#token=${TOKEN_MASK}`);

export interface OutboxQuery { status?: OutboxStatus; relatedType?: string; limit?: number; offset?: number }

export async function listOutbox(tx: Tx, q: OutboxQuery, opts: { channel: MailChannel; maskTokens: boolean }) {
  const limit = Math.min(Math.max(q.limit ?? 50, 1), 200);
  const offset = Math.max(q.offset ?? 0, 0);
  const where: string[] = [];
  const args: unknown[] = [];
  if (q.status) { args.push(q.status); where.push(`e.status = $${args.length}`); }
  if (q.relatedType) { args.push(q.relatedType); where.push(`e.related_type = $${args.length}`); }
  const w = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const total = Number((await tx.query<{ n: string }>(`SELECT count(*) AS n FROM email_outbox e ${w}`, args)).rows[0]!.n);
  const rows = (await tx.query<{ id: string; to_email: string | null; user_email: string | null; subject: string; body_text: string; related_type: string | null;
      related_id: string | null; status: OutboxStatus; created_at: Date; sent_at: Date | null; error: string | null }>(
    `SELECT e.id, e.to_email, u.email AS user_email, e.subject, e.body_text, e.related_type, e.related_id, e.status, e.created_at, e.sent_at, e.error
     FROM email_outbox e LEFT JOIN users u ON u.id = e.to_user_id ${w}
     ORDER BY e.created_at DESC, e.id DESC LIMIT ${limit} OFFSET ${offset}`, args)).rows;
  return {
    channel: channelInfo(opts.channel),
    total, limit, offset,
    items: rows.map((r) => ({
      id: r.id,
      // Faz 3 satırlarında alıcı kullanıcıya bağlı; e-posta adresi satırda yoksa kullanıcının adresi gösterilir.
      toEmail: r.to_email ?? r.user_email,
      subject: r.subject,
      body: opts.maskTokens ? maskTokens(r.body_text) : r.body_text,
      relatedType: r.related_type, relatedId: r.related_id,
      status: r.status, statusLabel: EMAIL_STATUS_LABEL[r.status] ?? 'Bilinmeyen durum',
      createdAt: r.created_at, sentAt: r.sent_at, error: r.error,
    })),
  };
}
