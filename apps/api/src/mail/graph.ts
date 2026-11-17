import { DirectoryError, graphAppToken, graphSend, type GraphOptions } from '../directory/graph.ts';
import type { MailSender } from './index.ts';

/**
 * v2 Faz 5 (R6): Microsoft Graph `sendMail` bağdaştırıcısı. Varsayılan kapalı (`MAIL_PROVIDER=none`); testlerde yalnız sahte HTTP
 * taşıyıcısıyla çalışır (gerçek gönderim değildir). Belirteç Faz 2 `graphAppToken` ile alınır (istemci kimlik bilgisi, `Mail.Send`
 * uygulama izni). Sonuç yalnız kısa hata kodudur: sunucu yanıtı, ileti gövdesi ya da sır hiçbir iletiye/günlüğe kopyalanmaz.
 */
const GRAPH = 'https://graph.microsoft.com';

export interface GraphMailConfig { sender: string; tenantId: string; clientId: string; clientSecret: string }

export class GraphMailSender implements MailSender {
  readonly kind = 'graph' as const;
  readonly sender: string;
  // Özel alanlar JSON.stringify ve günlükte görünmez; sır yalnız belirteç yardımcısının kapanışında durur.
  readonly #send: (url: string, init: RequestInit) => Promise<Response>;
  readonly #tokens: ReturnType<typeof graphAppToken>;

  constructor(cfg: GraphMailConfig, fetchImpl: typeof fetch = fetch, opts: GraphOptions = {}) {
    this.sender = cfg.sender;
    this.#send = graphSend(fetchImpl, opts);
    this.#tokens = graphAppToken({ tenantId: cfg.tenantId, clientId: cfg.clientId, clientSecret: cfg.clientSecret }, this.#send);
  }

  async send(m: { to: string; subject: string; body: string }): Promise<{ ok: true } | { ok: false; code: string }> {
    try {
      const token = await this.#tokens.get();
      const res = await this.#send(`${GRAPH}/v1.0/users/${encodeURIComponent(this.sender)}/sendMail`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          message: { subject: m.subject, body: { contentType: 'Text', content: m.body }, toRecipients: [{ emailAddress: { address: m.to } }] },
          saveToSentItems: false,
        }),
      });
      if (res.ok) return { ok: true };
      if (res.status === 401) { this.#tokens.clear(); return { ok: false, code: 'unauthorized' }; }
      if (res.status === 403) return { ok: false, code: 'forbidden' };
      if (res.status === 404) return { ok: false, code: 'sender_not_found' };
      if (res.status === 400) return { ok: false, code: 'bad_request' };
      if (res.status >= 500) return { ok: false, code: `http_${res.status}` };
      return { ok: false, code: 'http_error' };
    } catch (e) {
      return { ok: false, code: e instanceof DirectoryError ? e.code : 'network' };
    }
  }
}
