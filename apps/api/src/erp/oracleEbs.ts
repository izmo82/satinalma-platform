// v2 Faz 8 (D113, R1): Oracle E-Business Suite REST bağdaştırıcısı (Integrated SOA Gateway ya da kurumun REST servisleri).
// Yol ve alan adları uç nokta kartından gelir (taban adres + kaynak yolu + alan eşlemesi); kod sabit bir EBS sürümüne bağlanmaz.
// Güvenlik: her istekten önce adres denetimi (R12: INTEGRATION_ALLOWED_HOSTS, üretimde yalnız https, kullanıcı bilgisi yok);
// yönlendirme izlenmez (`redirect: 'manual'`); her istek `AbortSignal.timeout`; hata iletileri `redactSecrets`'ten geçer.
// Kimlik: BASIC ya da OAuth2 client credentials (token yalnız süreç belleğinde önbelleklenir; R4).
// Sözleşme (varsayım, gerçek Oracle'la doğrulanmadı — NOT_RUN):
//   okuma  GET  <taban><kaynak>?offset=N&limit=M → `{ items: [...], hasMore }` ya da dizi
//   sorgu  GET  <taban><kaynak>?idempotency_key=K (+ Idempotency-Key başlığı) → `{ items: [{ externalRef|id }] }`, 404 = yok
//   yazma  POST <taban><kaynak> JSON, Idempotency-Key başlığı → `{ externalRef|id }`
import { createHash } from 'node:crypto';
import { redactSecrets, validateEndpointConfig, type ErpFeature } from '@sp/domain';
import { ErpTimeout } from './adapter.ts';
import { ErpProviderError, assertReadable, assertWritable, type ErpProvider, type ResolvedEndpoint } from './providers.ts';

export const ORACLE_EBS_LABEL = 'Oracle E-Business Suite';
const DEFAULT_PAGE_SIZE = 100;
const MAX_TOKEN_CACHE = 200;

type Opts = { allowedHosts: string[]; production: boolean; fetch?: typeof fetch; pageSize?: number; now?: () => number };

/** Token önbelleği yalnız bellekte; anahtar sırrın özetini içerir (sır değişince eski token kullanılmaz). */
const tokenCache = new Map<string, { token: string; expiresAt: number }>();
/** YALNIZ TEST: token önbelleğini boşaltır. */
export function clearOracleTokenCache(): void { tokenCache.clear(); }

/** Adres denetimi domain kuralıyla (validateEndpointConfig içindeki URL kuralları) yapılır; yalnız adres alanı hataları alınır. */
function urlProblem(url: string, opts: Opts): string | null {
  const v = validateEndpointConfig({ feature: 'INVOICE', baseUrl: url, authType: 'BASIC', username: 'x', secretSet: true, schedule: { mode: 'MANUAL' },
    sourcePath: 'x', fieldMap: {} }, { allowedHosts: opts.allowedHosts, production: opts.production });
  return v.ok ? null : v.errors.find((e) => e.field === 'baseUrl')?.code ?? null;
}

const URL_MESSAGES: Record<string, string> = {
  host_not_allowed: 'Adres izinli ana bilgisayar listesinde değil (INTEGRATION_ALLOWED_HOSTS).',
  https_required: 'Üretimde yalnız https adres kullanılabilir.',
  userinfo_not_allowed: 'Adres kullanıcı adı/parola içeremez.',
};

function joinUrl(base: string, path: string): string {
  return `${base.replace(/\/+$/, '')}/${path.replace(/^\/+/, '')}`;
}

function secretsOf(ep: ResolvedEndpoint, token?: string): string[] {
  const s: string[] = [];
  if (ep.secret) {
    s.push(ep.secret);
    if (ep.username) s.push(`${ep.username}:${ep.secret}`);
  }
  if (token) s.push(token);
  return s;
}

const isTimeout = (e: unknown) => e instanceof Error && (e.name === 'TimeoutError' || e.name === 'AbortError');

export function oracleEbsProvider(opts: Opts): ErpProvider {
  const doFetch = opts.fetch ?? fetch;
  const pageSize = opts.pageSize ?? DEFAULT_PAGE_SIZE;
  const now = opts.now ?? Date.now;

  function checkUrl(url: string): void {
    const p = urlProblem(url, opts);
    if (p) throw new ErpProviderError(p, URL_MESSAGES[p] ?? 'Adres geçersiz.');
  }

  /** Tek HTTP isteği: adres denetimi, zaman aşımı, yönlendirme yok. Gövde metin olarak okunur (zaman aşımı gövde okumasını da kapsar). */
  async function request(ep: ResolvedEndpoint, url: string, init: RequestInit, extraSecrets: string[]): Promise<{ status: number; text: string }> {
    checkUrl(url);
    try {
      const res = await doFetch(url, { ...init, redirect: 'manual', signal: AbortSignal.timeout(ep.timeoutMs) });
      const text = await res.text();
      if (res.status >= 300 && res.status < 400) throw new ErpProviderError('redirect_not_followed', `ERP yönlendirme döndü (HTTP ${res.status}); yönlendirme izlenmez.`);
      return { status: res.status, text };
    } catch (e) {
      if (e instanceof ErpProviderError) throw e;
      if (isTimeout(e)) throw new ErpTimeout();
      const raw = e instanceof Error ? `${e.message}${(e as { cause?: { code?: string } }).cause?.code ? ` (${(e as { cause: { code: string } }).cause.code})` : ''}` : 'bilinmeyen hata';
      throw new ErpProviderError('network_error', redactSecrets(`ERP'ye bağlanılamadı: ${raw}`, [...secretsOf(ep), ...extraSecrets]));
    }
  }

  function httpError(status: number, text: string, secrets: string[]): ErpProviderError {
    const snippet = text.replace(/\s+/g, ' ').slice(0, 300);
    const label = status === 401 ? 'Yetkisiz' : status === 403 ? 'Erişim reddedildi' : status === 404 ? 'Bulunamadı' : 'Hata';
    return new ErpProviderError(`http_${status}`, redactSecrets(`ERP HTTP ${status} ${label}${snippet ? `: ${snippet}` : ''}`, secrets));
  }

  async function authHeader(ep: ResolvedEndpoint): Promise<{ header: string; token?: string; cacheKey?: string }> {
    if (!ep.secret) throw new ErpProviderError('secret_missing', 'Sır ayarlı değil; ERP isteği atılmadı.');
    if (ep.authType === 'BASIC') {
      if (!ep.username) throw new ErpProviderError('username_missing', 'Kullanıcı adı ayarlı değil; ERP isteği atılmadı.');
      return { header: `Basic ${Buffer.from(`${ep.username}:${ep.secret}`, 'utf8').toString('base64')}` };
    }
    if (!ep.clientId || !ep.tokenUrl) throw new ErpProviderError('oauth_config_missing', 'Token adresi ya da istemci kimliği ayarlı değil; ERP isteği atılmadı.');
    checkUrl(ep.tokenUrl);
    const cacheKey = `${ep.tokenUrl}|${ep.clientId}|${createHash('sha256').update(ep.secret).digest('hex')}`;
    const hit = tokenCache.get(cacheKey);
    if (hit && hit.expiresAt > now()) return { header: `Bearer ${hit.token}`, token: hit.token, cacheKey };
    const body = new URLSearchParams({ grant_type: 'client_credentials', client_id: ep.clientId, client_secret: ep.secret }).toString();
    const r = await request(ep, ep.tokenUrl, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' }, body }, []);
    if (r.status < 200 || r.status >= 300) {
      const e = httpError(r.status, r.text, secretsOf(ep));
      throw new ErpProviderError(`token_${e.code}`, `Token alınamadı. ${e.message}`);
    }
    let parsed: { access_token?: unknown; expires_in?: unknown };
    try { parsed = JSON.parse(r.text); } catch { throw new ErpProviderError('token_invalid_response', 'Token yanıtı okunamadı.'); }
    if (typeof parsed.access_token !== 'string' || !parsed.access_token) throw new ErpProviderError('token_invalid_response', 'Token yanıtında erişim belirteci yok.');
    const ttl = typeof parsed.expires_in === 'number' && parsed.expires_in > 0 ? parsed.expires_in : 300;
    if (tokenCache.size >= MAX_TOKEN_CACHE) tokenCache.delete(tokenCache.keys().next().value!);
    tokenCache.set(cacheKey, { token: parsed.access_token, expiresAt: now() + Math.max(ttl - 30, 10) * 1000 });
    return { header: `Bearer ${parsed.access_token}`, token: parsed.access_token, cacheKey };
  }

  /** Kimlikli istek; 2xx dışı yanıt sırdan arındırılmış ErpProviderError olur (allowStatus listesindekiler hariç). */
  async function call(ep: ResolvedEndpoint, method: 'GET' | 'POST', url: string, extra: { body?: string; headers?: Record<string, string>; allowStatus?: number[] } = {}) {
    const auth = await authHeader(ep);
    const headers: Record<string, string> = { accept: 'application/json', authorization: auth.header, ...extra.headers };
    const r = await request(ep, url, { method, headers, ...(extra.body !== undefined ? { body: extra.body } : {}) }, auth.token ? [auth.token] : []);
    if (r.status === 401 && auth.cacheKey) tokenCache.delete(auth.cacheKey);
    if ((r.status < 200 || r.status >= 300) && !extra.allowStatus?.includes(r.status)) throw httpError(r.status, r.text, secretsOf(ep, auth.token));
    return r;
  }

  function parseJson(text: string): unknown {
    try { return text ? JSON.parse(text) : null; } catch { throw new ErpProviderError('invalid_response', 'ERP yanıtı JSON değil.'); }
  }

  function refOf(x: unknown): string | null {
    if (!x || typeof x !== 'object') return null;
    const o = x as Record<string, unknown>;
    const v = o.externalRef ?? o.id ?? o.ID;
    return (typeof v === 'string' && v.trim()) || (typeof v === 'number' && Number.isFinite(v)) ? String(v).trim().slice(0, 120) : null;
  }

  const resourceUrl = (ep: ResolvedEndpoint) => joinUrl(ep.baseUrl, ep.resourcePath);

  return {
    kind: 'ORACLE_EBS',
    label: ORACLE_EBS_LABEL,
    real: true,
    async test(ep) {
      const started = now();
      try {
        const u = new URL(resourceUrl(ep));
        u.searchParams.set('offset', '0');
        u.searchParams.set('limit', '1');
        const r = await call(ep, 'GET', u.toString());
        return { ok: true, message: `Bağlantı başarılı (HTTP ${r.status}).`, latencyMs: now() - started };
      } catch (e) {
        const message = e instanceof ErpTimeout ? `Zaman aşımı (${ep.timeoutMs} ms).`
          : e instanceof ErpProviderError ? e.message : 'Bağlantı denemesi başarısız.';
        return { ok: false, message: redactSecrets(message, secretsOf(ep)), latencyMs: now() - started };
      }
    },
    async read(ep, feature: ErpFeature, cursor) {
      assertReadable(feature);
      const offset = cursor === null ? 0 : /^\d{1,9}$/.test(cursor) ? Number(cursor) : NaN;
      if (!Number.isFinite(offset)) throw new ErpProviderError('invalid_cursor', 'Geçersiz sayfa imleci.');
      const u = new URL(resourceUrl(ep));
      u.searchParams.set('offset', String(offset));
      u.searchParams.set('limit', String(pageSize));
      const body = parseJson((await call(ep, 'GET', u.toString())).text);
      const items = Array.isArray(body) ? body : body && typeof body === 'object' && Array.isArray((body as { items?: unknown }).items) ? (body as { items: unknown[] }).items : null;
      if (!items) throw new ErpProviderError('invalid_response', 'ERP yanıtında kayıt listesi (items) yok.');
      const hasMore = !Array.isArray(body) && typeof (body as { hasMore?: unknown }).hasMore === 'boolean' ? (body as { hasMore: boolean }).hasMore : items.length >= pageSize;
      return { records: items, nextCursor: hasMore && items.length > 0 ? String(offset + items.length) : null };
    },
    async find(ep, feature, idempotencyKey) {
      assertWritable(feature);
      const u = new URL(resourceUrl(ep));
      u.searchParams.set('idempotency_key', idempotencyKey);
      const r = await call(ep, 'GET', u.toString(), { headers: { 'idempotency-key': idempotencyKey }, allowStatus: [404] });
      if (r.status === 404) return null;
      const body = parseJson(r.text);
      const first = Array.isArray(body) ? body[0] : body && typeof body === 'object' && Array.isArray((body as { items?: unknown }).items) ? (body as { items: unknown[] }).items[0] : body;
      const ref = refOf(first);
      return ref ? { externalRef: ref } : null;
    },
    async write(ep, feature, payload, idempotencyKey) {
      assertWritable(feature);
      const r = await call(ep, 'POST', resourceUrl(ep), {
        body: JSON.stringify(payload), headers: { 'content-type': 'application/json', 'idempotency-key': idempotencyKey },
      });
      const ref = refOf(parseJson(r.text));
      if (!ref) throw new ErpProviderError('invalid_response', 'ERP yanıtında dış referans (externalRef/id) yok.');
      return { externalRef: ref };
    },
  };
}
