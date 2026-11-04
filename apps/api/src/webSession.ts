import { createCipheriv, createDecipheriv, createHash, hkdfSync, randomBytes } from 'node:crypto';
import { createRemoteJWKSet, jwtVerify, type JWTPayload } from 'jose';
import type pg from 'pg';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { OidcConfig } from './config.ts';
import type { AuthProvider, VerifiedToken } from './auth.ts';
import { ApiError } from './errors.ts';

/**
 * Web oturumu sunucuda (BFF, D78). Tarayıcı IdP token'ı görmez: yalnız HttpOnly, SameSite=Strict çerezde 256 bit rastgele
 * oturum kimliği taşır. Token'lar AES-256-GCM ile şifreli olarak `web_sessions`'ta, kimlik yalnız SHA-256 özetiyle aranır.
 * Erişim token'ı süresi dolmak üzereyken sunucu yeniler (IdP devre dışı bıraktıysa oturum biter). iOS ve servisler Bearer ile.
 */
export interface SessionConfig {
  /** Şifreleme anahtarının kaynağı (≥32 karakter). OIDC modunda zorunlu; dev'de verilmezse süreç başına rastgele. */
  secret: string | null;
  /** Çerez yalnız HTTPS'te (ad `__Host-` önekli). Üretimde zorunlu. */
  cookieSecure: boolean;
  idleMinutes: number;
  maxHours: number;
}
export const DEFAULT_SESSION: SessionConfig = { secret: null, cookieSecure: false, idleMinutes: 30, maxHours: 12 };

export interface Tokens { access: string; refresh: string | null; id: string | null; accessExp: number }
interface Flow { verifier: string; state: string; nonce: string; returnTo: string; at: number }
const FLOW_TTL_MS = 10 * 60_000;
/** Erişim token'ının bitmesine bu kadar kala yenilenir (istek ortasında sona ermesin). */
const REFRESH_EARLY_S = 60;
const TOUCH_EVERY_MS = 60_000;

const b64url = (b: Buffer) => b.toString('base64url');
const sha256 = (s: string | Buffer) => createHash('sha256').update(s).digest();

export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (header ?? '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}

export class WebSessions {
  private key: Buffer;
  private refreshing = new Map<string, Promise<Tokens | null>>();
  /** Bu süreçte son doğrulanan oturum özetleri (hız sınırı ön kontrolü: NAT arkasındaki geçerli kullanıcı kilitlenmesin). */
  private recentlyValid = new Map<string, number>();
  private discovery: { at: number; doc: Record<string, any> } | null = null;
  private idJwks: ReturnType<typeof createRemoteJWKSet> | null = null;
  readonly cookieName: string;
  readonly flowCookieName: string;

  constructor(private pool: pg.Pool, private cfg: SessionConfig, private webOrigin: string, private oidc: OidcConfig | null, private auth: AuthProvider) {
    if (oidc && (!cfg.secret || cfg.secret.length < 32)) throw new Error('SESSION_SECRET (en az 32 karakter) OIDC modunda zorunlu');
    const ikm = cfg.secret ? Buffer.from(cfg.secret) : randomBytes(32);
    this.key = Buffer.from(hkdfSync('sha256', ikm, Buffer.alloc(0), 'sp-web-session-v1', 32));
    this.cookieName = cfg.cookieSecure ? '__Host-sp_sid' : 'sp_sid';
    this.flowCookieName = cfg.cookieSecure ? '__Host-sp_flow' : 'sp_flow';
  }

  // --- Şifreleme ---------------------------------------------------------------------------------------------------
  private seal(v: unknown): Buffer {
    const iv = randomBytes(12);
    const c = createCipheriv('aes-256-gcm', this.key, iv);
    const ct = Buffer.concat([c.update(JSON.stringify(v), 'utf8'), c.final()]);
    return Buffer.concat([iv, c.getAuthTag(), ct]);
  }
  private open<T>(b: Buffer): T {
    if (b.length < 28) throw new Error('short');
    // Etiket uzunluğu sabit: kısaltılmış GCM etiketi kabul edilmez.
    const d = createDecipheriv('aes-256-gcm', this.key, b.subarray(0, 12), { authTagLength: 16 });
    d.setAuthTag(b.subarray(12, 28));
    return JSON.parse(Buffer.concat([d.update(b.subarray(28)), d.final()]).toString('utf8')) as T;
  }

  // --- Çerezler ----------------------------------------------------------------------------------------------------
  private cookie(name: string, value: string, maxAgeS: number) {
    return `${name}=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAgeS}${this.cfg.cookieSecure ? '; Secure' : ''}`;
  }
  private addCookie(reply: FastifyReply, c: string) {
    const prev = reply.getHeader('set-cookie');
    reply.header('set-cookie', [...(Array.isArray(prev) ? prev : prev ? [String(prev)] : []), c]);
  }
  clearCookie(reply: FastifyReply) { this.addCookie(reply, this.cookie(this.cookieName, '', 0)); }

  /**
   * Yeni oturum: önceki oturum kimliği yeniden kullanılmaz (oturum sabitleme). Tarayıcıda başka bir oturum çerezi varsa
   * (çıkış yapmadan başka kullanıcıyla giriş) o oturum sunucuda da silinir; süresi dolana kadar geçerli yetim oturum kalmaz.
   */
  async create(reply: FastifyReply, subject: string, mode: 'oidc' | 'dev', tokens: Tokens | null, req?: FastifyRequest) {
    const prior = req ? parseCookies(req.headers.cookie)[this.cookieName] : undefined;
    if (prior) {
      this.recentlyValid.delete(sha256(prior).toString('hex'));
      await this.pool.query('SELECT web_session_delete($1)', [sha256(prior)]);
    }
    const id = b64url(randomBytes(32));
    const maxAge = this.cfg.maxHours * 3600;
    await this.pool.query('SELECT web_session_create($1, $2, $3, $4, $5)',
      [sha256(id), subject, mode, tokens ? this.seal(tokens) : null, new Date(Date.now() + maxAge * 1000)]);
    this.addCookie(reply, this.cookie(this.cookieName, id, maxAge));
  }

  hasSessionCookie(req: FastifyRequest) { return !!parseCookies(req.headers.cookie)[this.cookieName]; }
  /** Hız sınırı kovası için oturum anahtarı (kimliğin kendisi değil özeti) ve bu süreçte yakın zamanda doğrulanıp doğrulanmadığı. */
  rateKey(req: FastifyRequest): { key: string; known: boolean } | null {
    const id = parseCookies(req.headers.cookie)[this.cookieName];
    if (!id) return null;
    const h = sha256(id).toString('hex');
    return { key: b64url(sha256(`sid:${id}`)).slice(0, 22), known: (this.recentlyValid.get(h) ?? 0) > Date.now() };
  }
  private remember(hash: Buffer) {
    if (this.recentlyValid.size >= 20_000) this.recentlyValid.delete(this.recentlyValid.keys().next().value!);
    this.recentlyValid.set(hash.toString('hex'), Date.now() + 5 * 60_000);
  }

  /**
   * Çerezli istek: CSRF denetimi (durum değiştiren yöntemde özel başlık + varsa Origin eşleşmesi), boşta kalma ve mutlak
   * süre, gerekirse token yenileme. Başarıda doğrulanmış subject döner; çerez yoksa null (Bearer yoluna bırakılır).
   */
  async authenticate(req: FastifyRequest): Promise<VerifiedToken | null> {
    const id = parseCookies(req.headers.cookie)[this.cookieName];
    if (!id) return null;
    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method)) this.assertCsrf(req);
    const hash = sha256(id);
    const row = (await this.pool.query<{ user_subject: string; mode: 'oidc' | 'dev'; tokens: Buffer | null; last_seen_at: Date; expires_at: Date }>(
      'SELECT * FROM web_session_get($1)', [hash])).rows[0];
    const now = Date.now();
    if (!row || row.expires_at.getTime() <= now || row.last_seen_at.getTime() + this.cfg.idleMinutes * 60_000 <= now) {
      this.recentlyValid.delete(hash.toString('hex'));
      if (row) await this.pool.query('SELECT web_session_delete($1)', [hash]);
      throw new ApiError(401, 'session_expired', 'Oturumun süresi doldu. Yeniden giriş yapın.');
    }
    // Oturum bu sunucunun kimlik moduna ait olmalı: kurumsal (OIDC) sunucu dev oturumunu asla kabul etmez (aynı veritabanını
    // paylaşan bir geliştirme kopyasının açtığı oturum, ya da porttan bağımsız aynı ana makine çerezi).
    if (row.mode !== (this.oidc ? 'oidc' : 'dev')) throw new ApiError(401, 'unauthenticated', 'Oturum bu giriş yöntemine ait değil. Yeniden giriş yapın.');
    if (row.mode === 'oidc') {
      let t: Tokens;
      try { t = this.open<Tokens>(row.tokens!); } catch {
        await this.pool.query('SELECT web_session_delete($1)', [hash]);
        throw new ApiError(401, 'session_expired', 'Oturum geçersiz. Yeniden giriş yapın.');
      }
      if (t.accessExp - REFRESH_EARLY_S <= now / 1000) {
        const key = hash.toString('hex');
        // Aynı süreçteki eşzamanlı istekler tek yenilemeyi paylaşır; kopyalar arası tekillik veritabanı kilidiyle (refreshTokens).
        let p = this.refreshing.get(key);
        if (!p) {
          p = this.refreshTokens(hash, row.user_subject).finally(() => this.refreshing.delete(key));
          this.refreshing.set(key, p);
        }
        if (!(await p)) throw new ApiError(401, 'session_expired', 'Kimlik sağlayıcısı oturumu yenilemedi. Yeniden giriş yapın.');
        this.remember(hash);
        return { subject: row.user_subject, verifiedEmail: null };
      }
    }
    if (now - row.last_seen_at.getTime() > TOUCH_EVERY_MS) await this.pool.query('SELECT web_session_touch($1)', [hash]);
    this.remember(hash);
    return { subject: row.user_subject, verifiedEmail: null };
  }

  private assertCsrf(req: FastifyRequest) {
    const origin = req.headers.origin;
    if (req.headers['x-sp-csrf'] !== '1' || (typeof origin === 'string' && origin !== this.webOrigin)) {
      throw new ApiError(403, 'csrf', 'İstek doğrulanamadı (kaynak eşleşmedi). Sayfayı yenileyip tekrar deneyin.');
    }
  }

  // --- OIDC (yalnız web BFF akışı) ---------------------------------------------------------------------------------
  async discoveryDoc(): Promise<Record<string, any>> {
    const oidc = this.requireOidc();
    if (!this.discovery || Date.now() - this.discovery.at > 300_000) {
      try {
        const r = await fetch(oidc.discoveryUrl, { signal: AbortSignal.timeout(5000) });
        if (!r.ok) throw new Error(String(r.status));
        this.discovery = { at: Date.now(), doc: (await r.json()) as Record<string, any> };
      } catch {
        throw new ApiError(503, 'idp_unavailable', 'Kimlik sağlayıcısına ulaşılamadı. Kısa süre sonra tekrar deneyin.');
      }
    }
    return this.discovery.doc;
  }
  private requireOidc() {
    if (!this.oidc) throw new ApiError(404, 'not_found', 'Kurumsal oturum etkin değil.');
    return this.oidc;
  }
  private redirectUri() { return `${this.webOrigin}/auth/callback`; }

  /** Girişi başlatır: PKCE doğrulayıcı, state ve nonce şifreli kısa ömürlü çerezde; tarayıcı IdP'ye yönlenir. */
  async beginLogin(reply: FastifyReply, returnTo: string) {
    const oidc = this.requireOidc();
    const d = await this.discoveryDoc();
    const flow: Flow = { verifier: b64url(randomBytes(48)), state: b64url(randomBytes(24)), nonce: b64url(randomBytes(24)),
      returnTo: returnTo.startsWith('/') && !returnTo.startsWith('//') ? returnTo : '/', at: Date.now() };
    this.addCookie(reply, this.cookie(this.flowCookieName, b64url(this.seal(flow)), FLOW_TTL_MS / 1000));
    const u = new URL(String(d.authorization_endpoint));
    u.search = new URLSearchParams({
      response_type: 'code', client_id: oidc.clientId, redirect_uri: this.redirectUri(), scope: oidc.scope,
      state: flow.state, nonce: flow.nonce, code_challenge: b64url(sha256(flow.verifier)), code_challenge_method: 'S256',
      ...(oidc.resource ? { resource: oidc.resource } : {}),
    }).toString();
    return u.toString();
  }

  /**
   * IdP'den dönen kodu sunucuda token'a çevirir ve kimliği doğrular. Oturumu çağıran, kullanıcının davetli/bağlı olduğunu
   * gördükten sonra `create` ile açar (davetsiz hesap için oturum oluşmaz).
   */
  async completeLogin(req: FastifyRequest, reply: FastifyReply, code: string, state: string): Promise<{ subject: VerifiedToken; tokens: Tokens; returnTo: string }> {
    this.assertCsrf(req);
    const oidc = this.requireOidc();
    const raw = parseCookies(req.headers.cookie)[this.flowCookieName];
    this.addCookie(reply, this.cookie(this.flowCookieName, '', 0));
    let flow: Flow | null = null;
    try { flow = raw ? this.open<Flow>(Buffer.from(raw, 'base64url')) : null; } catch { flow = null; }
    if (!flow || flow.state !== state || Date.now() - flow.at > FLOW_TTL_MS) {
      throw new ApiError(400, 'login_state_mismatch', 'Oturum isteği eşleşmedi veya süresi doldu. Lütfen yeniden giriş yapın.');
    }
    let tokens: Tokens;
    try {
      tokens = await this.tokenRequest({ grant_type: 'authorization_code', code, redirect_uri: this.redirectUri(), code_verifier: flow.verifier });
    } catch (e) {
      if (e instanceof IdpRejected) throw new ApiError(401, 'unauthenticated', 'Kimlik sağlayıcısı girişi doğrulamadı (kod geçersiz veya süresi doldu). Lütfen yeniden giriş yapın.');
      throw e;
    }
    if (!tokens.id) throw new ApiError(502, 'idp_error', 'Kimlik sağlayıcısı kimlik belgesi (id_token) vermedi.');
    const d = await this.discoveryDoc();
    this.idJwks ??= createRemoteJWKSet(new URL(oidc.jwksUrl));
    let idClaims: JWTPayload;
    try {
      idClaims = (await jwtVerify(tokens.id, this.idJwks, { issuer: oidc.issuer, audience: oidc.clientId, clockTolerance: oidc.clockToleranceSeconds })).payload;
    } catch { throw new ApiError(401, 'unauthenticated', 'Kimlik belgesi doğrulanamadı.'); }
    if (idClaims.nonce !== flow.nonce) throw new ApiError(401, 'unauthenticated', 'Kimlik belgesi bu oturum isteğine ait değil.');
    // API'nin kabul ettiği kimlik erişim token'ındandır (Bearer ile aynı doğrulama: imza, issuer, audience, süre).
    let subject: VerifiedToken;
    try { subject = await this.auth.verify(tokens.access); } catch { throw new ApiError(401, 'unauthenticated', 'Erişim token\'ı doğrulanamadı.'); }
    return { subject, tokens, returnTo: flow.returnTo };
  }

  /** Çıkış: oturum silinir, yenileme token'ı IdP'de iptal edilir (en iyi çaba); IdP oturumunu kapatma adresi döner. */
  async logout(req: FastifyRequest, reply: FastifyReply): Promise<string | null> {
    this.assertCsrf(req);
    const id = parseCookies(req.headers.cookie)[this.cookieName];
    this.clearCookie(reply);
    if (!id) return null;
    const hash = sha256(id);
    this.recentlyValid.delete(hash.toString('hex'));
    const row = (await this.pool.query<{ mode: string; tokens: Buffer | null }>('SELECT mode, tokens FROM web_session_get($1)', [hash])).rows[0];
    await this.pool.query('SELECT web_session_delete($1)', [hash]);
    if (row?.mode !== 'oidc' || !row.tokens || !this.oidc) return null;
    let t: Tokens | null = null;
    try { t = this.open<Tokens>(row.tokens); } catch { /* bozuk: yalnız silinir */ }
    const d = await this.discoveryDoc().catch(() => null);
    if (t?.refresh && d?.revocation_endpoint) {
      await fetch(String(d.revocation_endpoint), { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ token: t.refresh, token_type_hint: 'refresh_token', ...this.clientAuth() }), signal: AbortSignal.timeout(5000) }).catch(() => undefined);
    }
    if (!d?.end_session_endpoint) return null;
    const u = new URL(String(d.end_session_endpoint));
    u.search = new URLSearchParams({ client_id: this.oidc.clientId, post_logout_redirect_uri: `${this.webOrigin}/`, ...(t?.id ? { id_token_hint: t.id } : {}) }).toString();
    return u.toString();
  }

  private clientAuth(): Record<string, string> {
    const oidc = this.requireOidc();
    return { client_id: oidc.clientId, ...(oidc.clientSecret ? { client_secret: oidc.clientSecret } : {}) };
  }

  private async tokenRequest(body: Record<string, string>): Promise<Tokens> {
    const oidc = this.requireOidc();
    const d = await this.discoveryDoc();
    let r: Response;
    try {
      r = await fetch(String(d.token_endpoint), { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ ...this.clientAuth(), ...(oidc.resource ? { resource: oidc.resource } : {}), ...body }), signal: AbortSignal.timeout(10_000) });
    } catch { throw new ApiError(503, 'idp_unavailable', 'Kimlik sağlayıcısına ulaşılamadı. Kısa süre sonra tekrar deneyin.'); }
    // Yalnız 400/401 açık rettir (invalid_grant: kod/yenileme token'ı geçersiz, iptal veya tekrar kullanım). 429, 5xx ve
    // beklenmeyen yanıtlar (ör. kurum vekilinden HTML) geçicidir: oturum silinmez.
    if (r.status === 400 || r.status === 401) throw new IdpRejected();
    if (!r.ok) throw idpUnavailable();
    let j: { access_token?: string; refresh_token?: string; id_token?: string; expires_in?: number };
    try { j = (await r.json()) as typeof j; } catch { throw idpUnavailable(); }
    if (!j.access_token) throw idpUnavailable();
    return { access: j.access_token, refresh: j.refresh_token ?? null, id: j.id_token ?? null, accessExp: Math.floor(Date.now() / 1000) + (j.expires_in ?? 300) };
  }

  /**
   * Yenileme, kopyalar arası tek seferlik: oturuma özgü veritabanı kilidi alınır, satır kilitten sonra yeniden okunur; başka bir
   * API kopyası az önce yenilediyse onun token'ı kullanılır (refresh token'ı döndüren IdP'lerde ikinci kullanım ailenin tamamını
   * iptal edebilir). Oturum yalnız açık retle (IdP 400/401 ya da kullanıcı değişti) biter; geçici hatalar 503 döner, oturum kalır.
   */
  private async refreshTokens(hash: Buffer, subject: string): Promise<Tokens | null> {
    const c = await this.pool.connect();
    try {
      await c.query('BEGIN');
      await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`sp-web-session:${hash.toString('hex')}`]);
      const row = (await c.query<{ tokens: Buffer | null }>('SELECT tokens FROM web_session_get($1)', [hash])).rows[0];
      const end = async () => { await c.query('SELECT web_session_delete($1)', [hash]); await c.query('COMMIT'); return null; };
      if (!row?.tokens) { await c.query('COMMIT'); return null; }
      const t = this.open<Tokens>(row.tokens);
      if (t.accessExp - REFRESH_EARLY_S > Date.now() / 1000) { await c.query('COMMIT'); return t; }
      if (!t.refresh) return await end();
      let n: Tokens;
      try {
        n = await this.tokenRequest({ grant_type: 'refresh_token', refresh_token: t.refresh });
      } catch (e) {
        if (e instanceof IdpRejected) return await end();
        throw e;
      }
      let v: VerifiedToken;
      // Yeni token'ın doğrulanamaması (JWKS'e ulaşılamadı, anahtar dönüşü) kullanıcının reddi değildir.
      try { v = await this.auth.verify(n.access); } catch { throw idpUnavailable(); }
      if (v.subject !== subject) return await end();
      const next: Tokens = { ...n, refresh: n.refresh ?? t.refresh, id: n.id ?? t.id };
      await c.query('SELECT web_session_set_tokens($1, $2)', [hash, this.seal(next)]);
      await c.query('COMMIT');
      return next;
    } catch (e) {
      await c.query('ROLLBACK').catch(() => undefined);
      throw e instanceof ApiError ? e : idpUnavailable();
    } finally {
      c.release();
    }
  }
}

/** IdP'nin açık reddi (token uç noktası 400/401). */
class IdpRejected extends Error {}
const idpUnavailable = () => new ApiError(503, 'idp_unavailable', 'Kimlik sağlayıcısına şu an ulaşılamıyor; oturumunuz açık. Kısa süre sonra tekrar deneyin.');
