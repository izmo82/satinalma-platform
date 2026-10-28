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
const AUTH = /^\/api\/v1\/dev\/token$/;

export function rateClass(method: string, path: string): RateClass {
  if (AUTH.test(path)) return 'auth';
  return HEAVY.some(([m, re]) => m === method && re.test(path)) ? 'heavy' : 'default';
}

interface Bucket { tokens: number; at: number }
const MAX_KEYS = 50_000;

export class RateLimiter {
  private buckets = new Map<string, Bucket>();
  constructor(private cfg: RateLimitConfig, private now: () => number = Date.now) {}

  private bucket(key: string, perMinute: number): Bucket {
    const t = this.now();
    let b = this.buckets.get(key);
    if (b) {
      b.tokens = Math.min(perMinute, b.tokens + ((t - b.at) / 60_000) * perMinute);
      b.at = t;
      // Son kullanılan sona taşınır: taşmada en uzun süre dokunulmayan anahtar düşer.
      this.buckets.delete(key);
    } else {
      b = { tokens: perMinute, at: t };
      if (this.buckets.size >= MAX_KEYS) this.buckets.delete(this.buckets.keys().next().value!);
    }
    this.buckets.set(key, b);
    return b;
  }
  private wait(b: Bucket, perMinute: number) { return Math.ceil(((1 - b.tokens) / perMinute) * 60); }
  /** Bir jeton harcar; yetmezse Retry-After saniyesini döner. */
  private take(key: string, perMinute: number): number {
    const b = this.bucket(key, perMinute);
    if (b.tokens >= 1) { b.tokens -= 1; return 0; }
    return this.wait(b, perMinute);
  }

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

  /** Kimlik doğrulaması başarısız oldu: adres kovasından düşer; kova boşsa Retry-After (401 yerine 429). */
  authFailure(ip: string): number | null {
    if (!this.cfg.enabled) return null;
    return this.take(`fail|${ip}`, this.cfg.authPerMinute) || null;
  }

  onRequest() {
    return async (req: FastifyRequest, reply: FastifyReply) => {
      if (!req.url.startsWith('/api/')) return;
      const route = req.routeOptions?.url ?? req.url.split('?')[0]!;
      const session = RateLimiter.sessionKey(typeof req.headers.authorization === 'string' ? req.headers.authorization : undefined);
      const wait = this.check(rateClass(req.method, route), req.ip, session);
      if (wait === null) return;
      return reply.header('Retry-After', String(wait)).status(429).send(rateLimited(wait));
    };
  }
}

export const rateLimited = (wait: number) => ({ error: { code: 'rate_limited', message: `Çok fazla istek gönderildi. ${wait} saniye sonra tekrar deneyin.`, details: { retryAfterSeconds: wait } } });
