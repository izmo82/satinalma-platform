import type { FastifyReply, FastifyRequest } from 'fastify';
import { rateLimited, TokenBuckets } from './rateLimit.ts';

/**
 * v2 Faz 5 (R4a): girişsiz uçların istek sınırlayıcısı. `RATE_LIMIT_ENABLED`'dan bağımsız, her ortamda açıktır (yalnız sınır
 * yapılandırmadan değişir). İstemci adresi başına ve uç başına ayrı kova: başvuru `applyPerHour` (varsayılan 5/saat), doğrulama ve
 * tamamlama uçları `tokenPerHour` (varsayılan 20/saat). Süreç içidir (`rateLimit.ts` kovası); çok kopyalı kurulumda sınır kopya
 * başınadır, bu yüzden veritabanı işlevi ayrıca e-posta ve adres özeti başına sayar (R4b) — sınırlayıcı atlansa da tutar.
 * İstemci adresi bellekte de yalnız kova anahtarıdır; veritabanına yazılmaz (orada yalnız `sha256(ip + tenant)` durur).
 */
export type PublicRateClass = 'apply' | 'token' | 'read';

export interface PublicRateLimitConfig {
  /** Adres başına saatte başvuru (`PUBLIC_APPLY_PER_HOUR`). */
  applyPerHour: number;
  /** Adres başına ve uç başına saatte doğrulama/tamamlama isteği (`PUBLIC_TOKEN_PER_HOUR`). */
  tokenPerHour: number;
  /** Adres başına saatte başvuru formu yapılandırması okuma (`PUBLIC_READ_PER_HOUR`). */
  readPerHour?: number;
  /** Kiracı başına saatte toplam girişsiz başvuru (`PUBLIC_TENANT_PER_HOUR`; veritabanında sayılır, kopyalar arası geçerli). */
  tenantPerHour?: number;
}

export const DEFAULT_PUBLIC_RATE_LIMIT: Required<PublicRateLimitConfig> = { applyPerHour: 5, tokenPerHour: 20, readPerHour: 120, tenantPerHour: 200 };

/**
 * Kova ve özet anahtarı için istemci adresi: IPv4 (IPv4 eşlemeli IPv6 dahil) olduğu gibi; IPv6 /64 önekine indirgenir
 * (tek abone /64 içinde sınırsız adres alabilir, adres değiştirerek sınır aşılmasın).
 */
export function clientAddressKey(ip: string): string {
  const raw = ip.trim().toLowerCase().replace(/^\[|\]$/g, '').replace(/%.*$/, '');
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(raw);
  if (mapped) return mapped[1]!;
  if (!raw.includes(':')) return raw;
  let head = raw; let tail = '';
  if (raw.includes('::')) [head, tail] = raw.split('::') as [string, string];
  const h = head ? head.split(':') : [];
  let t = tail ? tail.split(':') : [];
  // Gömülü IPv4 son iki hane sayılır; /64 önekini etkilemez.
  if (t.length && t[t.length - 1]!.includes('.')) t = [...t.slice(0, -1), '0', '0'];
  const groups = raw.includes('::') ? [...h, ...Array(Math.max(0, 8 - h.length - t.length)).fill('0'), ...t] : h;
  return `${groups.slice(0, 4).map((x) => (parseInt(x || '0', 16) || 0).toString(16)).join(':')}::/64`;
}
const HOUR_MS = 3_600_000;

export class PublicRateLimiter {
  private buckets: TokenBuckets;
  constructor(private cfg: PublicRateLimitConfig = DEFAULT_PUBLIC_RATE_LIMIT, now: () => number = Date.now) {
    this.buckets = new TokenBuckets(now);
  }

  private limit(cls: PublicRateClass) {
    return Math.max(1, cls === 'apply' ? this.cfg.applyPerHour : cls === 'read' ? this.cfg.readPerHour ?? DEFAULT_PUBLIC_RATE_LIMIT.readPerHour : this.cfg.tokenPerHour);
  }

  /** Bir jeton harcar. null = izin; sayı = Retry-After saniyesi. `endpoint` uç kalıbıdır (her uç ayrı kova). */
  check(cls: PublicRateClass, endpoint: string, ip: string): number | null {
    return this.buckets.take(`${cls}|${endpoint}|${clientAddressKey(ip)}`, this.limit(cls), HOUR_MS) || null;
  }

  /** Rota `onRequest` kancası: gövde okunmadan (dosya akışı başlamadan) sınır denetlenir. */
  hook(cls: PublicRateClass) {
    return async (req: FastifyRequest, reply: FastifyReply) => {
      const endpoint = `${req.method} ${req.routeOptions?.url ?? req.url.split('?')[0]}`;
      const wait = this.check(cls, endpoint, req.ip);
      if (wait === null) return;
      return reply.header('Retry-After', String(wait)).status(429).send(rateLimited(wait));
    };
  }
}

/** Ortamdan: geçersiz değer açılışı durdurur (yalnız değişken adı iletiye yazılır). */
export function loadPublicRateLimit(vars: NodeJS.ProcessEnv = process.env): Required<PublicRateLimitConfig> {
  const read = (name: string, dflt: number) => {
    const raw = vars[name];
    if (raw === undefined || raw === '') return dflt;
    const n = Number(raw);
    if (!Number.isInteger(n) || n < 1 || n > 100_000) throw new Error(`${name} geçersiz: 1–100000 arası tam sayı olmalı`);
    return n;
  };
  return { applyPerHour: read('PUBLIC_APPLY_PER_HOUR', DEFAULT_PUBLIC_RATE_LIMIT.applyPerHour),
    tokenPerHour: read('PUBLIC_TOKEN_PER_HOUR', DEFAULT_PUBLIC_RATE_LIMIT.tokenPerHour),
    readPerHour: read('PUBLIC_READ_PER_HOUR', DEFAULT_PUBLIC_RATE_LIMIT.readPerHour),
    tenantPerHour: read('PUBLIC_TENANT_PER_HOUR', DEFAULT_PUBLIC_RATE_LIMIT.tenantPerHour) };
}
