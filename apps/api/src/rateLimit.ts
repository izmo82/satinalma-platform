import { createHash } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';

// İstek sınırlama (ASVS V11/V13 otomasyon kötüye kullanımı). Bağımlılıksız token kovası; süreç içi.
// - Oturum kovası: geçerli kullanıcının her isteği (sınıfa göre). Aynı NAT/vekil arkasındaki kullanıcılar birbirini etkilemez.
// - Adres kovası: yalnız geliştirme girişi ve kimlik doğrulaması BAŞARISIZ olan istekler. Kova boşken başarısız istek 401 yerine
//   429 alır; geçerli token kimlik doğrulamasından geçtiği için hiç etkilenmez. Böylece vekil adresi yanlış yapılandırılıp herkes
//   tek adres görünse ya da aynı NAT'ta süresi dolan token'lar 401 alsa da meşru kullanıcı kilitlenmez; sahte token çeşitlemesi durur.
// Sınıf, ham URL'ye değil eşleşen rota kalıbına göre belirlenir (yüzde kodlamasıyla sınıf atlatılamaz).
// Çok kopyalı kurulumda sınır kopya başınadır; paylaşılan sınır ingress'te ayrıca tanımlanır (docs/runbook.md "İstek sınırlama").

export type RateClass = 'default' | 'heavy' | 'auth';

export interface RateLimitConfig {
  enabled: boolean;
  /** Oturum başına dakikada istek. */
  perMinute: number;
  /** Oturum başına dakikada pahalı istek (rapor, dosya, dışa aktarım, yükleme). */
  heavyPerMinute: number;
  /** Adres başına dakikada kimlik ucu çağrısı ve başarısız kimlik doğrulaması. */
  authPerMinute: number;
}

export const DEFAULT_RATE_LIMIT: Omit<RateLimitConfig, 'enabled'> = { perMinute: 600, heavyPerMinute: 30, authPerMinute: 60 };

// Pahalı uçlar: rapor/dosya üretimi, yükleme, dışa aktarım, ERP toplu işlemleri, AI yeniden çalıştırma.
const HEAVY: [string, RegExp][] = [
  ['POST', /^\/api\/v1\/documents$/],
  ['POST', /^\/api\/v1\/portal\/rounds\/[^/]+\/files$/],
  ['GET', /^\/api\/v1\/evaluations\/[^/]+\/(report\.xlsx|decision\.pdf)$/],
  ['GET', /^\/api\/v1\/reports\/summary(\.csv)?$/],
  ['POST', /^\/api\/v1\/tenant-exports(\/[^/]+\/download)?$/],
  ['GET', /^\/api\/v1\/integration\/erp\/(reconciliation|batch\.csv)$/],
  ['POST', /^\/api\/v1\/integration\/erp\/results$/],
  ['POST', /^\/api\/v1\/ai\/runs\/[^/]+\/retry$/],
];
// /auth/config herkese açık ve önbellekli; her açılışta çağrılır, sınırlanmaz (oturum kovası yoksa default sınıf adres kovasına girmez).
// Geliştirme girişleri adres başına sınırlı. Kurumsal giriş uçları (auth/login, auth/session) bilinçli olarak dışarıda:
// sabah aynı NAT arkasından yüzlerce kişi girer; kodu IdP üretir ve tek kullanımlıktır, akış çerezi olmadan işe yaramaz.
const AUTH = /^\/api\/v1\/dev\/(token|session)$/;

export function rateClass(method: string, path: string): RateClass {
  if (AUTH.test(path)) return 'auth';
  return HEAVY.some(([m, re]) => m === method && re.test(path)) ? 'heavy' : 'default';
}

interface Bucket { tokens: number; at: number }
const MAX_KEYS = 50_000;

/**
 * Süreç içi token kovaları: `capacity` jeton, `windowMs` içinde tamamen dolar. Son kullanılan sona taşınır; taşmada en uzun süre
 * dokunulmayan anahtar düşer. Oturum sınırlayıcısı (dakika) ve girişsiz uç sınırlayıcısı (saat, `publicRateLimit.ts`) ortak kullanır.
 */
export class TokenBuckets {
  private buckets = new Map<string, Bucket>();
  constructor(private now: () => number = Date.now) {}

  /** Kovayı geçen süreye göre doldurur (jeton harcamaz). */
  refill(key: string, capacity: number, windowMs: number): Bucket {
    const t = this.now();
    let b = this.buckets.get(key);
    if (b) {
      b.tokens = Math.min(capacity, b.tokens + ((t - b.at) / windowMs) * capacity);
      b.at = t;
      this.buckets.delete(key);
    } else {
      b = { tokens: capacity, at: t };
      if (this.buckets.size >= MAX_KEYS) this.buckets.delete(this.buckets.keys().next().value!);
    }
    this.buckets.set(key, b);
    return b;
  }
  /** Bir jeton için beklenecek saniye. */
  wait(b: Bucket, capacity: number, windowMs: number) { return Math.ceil(((1 - b.tokens) / capacity) * (windowMs / 1000)); }
  /** Bir jeton harcar; yetmezse Retry-After saniyesini döner (0 = izin). */
  take(key: string, capacity: number, windowMs: number): number {
    const b = this.refill(key, capacity, windowMs);
    if (b.tokens >= 1) { b.tokens -= 1; return 0; }
    return this.wait(b, capacity, windowMs);
  }
}

export class RateLimiter {
  private buckets: TokenBuckets;
  constructor(private cfg: RateLimitConfig, now: () => number = Date.now) { this.buckets = new TokenBuckets(now); }

  private bucket(key: string, perMinute: number): Bucket { return this.buckets.refill(key, perMinute, 60_000); }
  private wait(b: Bucket, perMinute: number) { return this.buckets.wait(b, perMinute, 60_000); }
  /** Bir jeton harcar; yetmezse Retry-After saniyesini döner. */
  private take(key: string, perMinute: number): number { return this.buckets.take(key, perMinute, 60_000); }

  static sessionKey(authorization: string | undefined) {
    // Token'ın kendisi bellekte tutulmaz; özeti anahtardır.
    return authorization ? createHash('sha256').update(authorization).digest('base64url').slice(0, 22) : null;
  }

  /** İstek öncesi. null = izin; sayı = Retry-After saniyesi. Adres kovası burada yalnız geliştirme girişine uygulanır. */
  check(cls: RateClass, ip: string, session: string | null): number | null {
    if (!this.cfg.enabled) return null;
    if (cls === 'auth') return this.take(`auth|${ip}`, this.cfg.authPerMinute) || null;
    if (!session) return null;
    const lim = cls === 'heavy' ? this.cfg.heavyPerMinute : this.cfg.perMinute;
    return this.take(`${cls === 'heavy' ? 'h' : 's'}|${session}`, lim) || null;
  }

  /** Adresin başarısız kimlik doğrulama kovası boş mu (jeton harcamadan). Boşsa Retry-After saniyesi. */
  authFailuresExhausted(ip: string): number | null {
    if (!this.cfg.enabled) return null;
    const b = this.bucket(`fail|${ip}`, this.cfg.authPerMinute);
    return b.tokens >= 1 ? null : this.wait(b, this.cfg.authPerMinute);
  }

  /** Kimlik doğrulaması başarısız oldu: adres kovasından düşer; kova boşsa Retry-After (401 yerine 429). */
  authFailure(ip: string): number | null {
    if (!this.cfg.enabled) return null;
    return this.take(`fail|${ip}`, this.cfg.authPerMinute) || null;
  }

  /** `cookieKey`: Bearer yoksa web oturum çerezinden kova anahtarı (BFF) ve bu süreçte yakın zamanda doğrulanıp doğrulanmadığı. */
  onRequest(cookieKey?: (req: FastifyRequest) => { key: string; known: boolean } | null) {
    return async (req: FastifyRequest, reply: FastifyReply) => {
      if (!req.url.startsWith('/api/')) return;
      const route = req.routeOptions?.url ?? req.url.split('?')[0]!;
      const bearer = RateLimiter.sessionKey(typeof req.headers.authorization === 'string' ? req.headers.authorization : undefined);
      const cookie = bearer ? null : cookieKey?.(req) ?? null;
      // Rastgele çerez değerleri her seferinde yeni kova açar; bu adres zaten çok sayıda başarısız kimlik denemesi yaptıysa
      // tanınmayan çerezli istek veritabanına (oturum araması) gitmeden reddedilir. Yakın zamanda doğrulanmış oturum (aynı NAT
      // arkasındaki gerçek kullanıcı) etkilenmez.
      if (cookie && !cookie.known) {
        const blocked = this.authFailuresExhausted(req.ip);
        if (blocked !== null) return reply.header('Retry-After', String(blocked)).status(429).send(rateLimited(blocked));
      }
      const session = bearer ?? cookie?.key ?? null;
      const wait = this.check(rateClass(req.method, route), req.ip, session);
      if (wait === null) return;
      return reply.header('Retry-After', String(wait)).status(429).send(rateLimited(wait));
    };
  }
}

export const rateLimited = (wait: number) => ({ error: { code: 'rate_limited', message: `Çok fazla istek gönderildi. ${wait} saniye sonra tekrar deneyin.`, details: { retryAfterSeconds: wait } } });
