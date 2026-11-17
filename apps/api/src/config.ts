import { DEFAULT_RATE_LIMIT, type RateLimitConfig } from './rateLimit.ts';
import type { SessionConfig } from './webSession.ts';
import { loadPublicRateLimit, type PublicRateLimitConfig } from './publicRateLimit.ts';

// 12-factor yapılandırma: tüm bağlantılar ortamdan gelir; bulutta secret manager doldurur.
export interface Config {
  env: 'development' | 'test' | 'production';
  port: number;
  databaseUrl: string;
  databaseOwnerUrl: string | null;
  authMode: 'oidc' | 'dev';
  oidc: OidcConfig | null;
  devAuthSecret: string | null;
  dataRegion: string;
  objectStore: { endpoint: string | null; region: string; bucket: string; forcePathStyle: boolean };
  signedUrlTtlSeconds: number;
  signatureDetectorProvider: string | null;
  esignValidatorProvider: string | null;
  /** Yapılandırılmış ERP bağdaştırıcısı adı; yoksa ERP aktarımı NOT_CONFIGURED kalır. */
  erpAdapter?: string | null;
  webOrigin: string;
  /** Aynı web'e başka adresten (ör. yerel ağ IP'si) erişim: CSRF köken kontrolü ve CORS bunları da kabul eder. Yönlendirmeler `webOrigin`'i kullanır. */
  extraWebOrigins?: string[];
  /**
   * Güvenilen vekillerin adres/CIDR listesi (web nginx, ingress). `X-Forwarded-For` yalnız bunlardan gelirse okunur;
   * aksi halde istemci adresini sahteleyip sınırı aşabilir. Fastify atlama sayısıyla güveni kapalı tutar; liste şarttır.
   * Tanımsızsa yalnız loopback: kapsayıcıda bütün istemciler vekilin adresiyle görünür (yalnız adres kovası paylaşılır).
   */
  trustProxy?: string[] | false;
  rateLimit?: RateLimitConfig;
  /** Web oturumu (BFF): çerez ve süreler; şifreleme anahtarı SESSION_SECRET'ten türetilir. */
  session?: SessionConfig;
  /** Yönetim raporu sonuç önbelleği (saniye); 0 = kapalı. Veri anı yanıtta görünür. */
  reportCacheSeconds?: number;
  /** Entra dizin sağlayıcısı (v2 Faz 2). `none` = bağlı değil. Sır yalnız ortamdan gelir; veritabanına, yanıta, günlüğe yazılmaz. */
  directory?: { kind: 'graph' | 'test' | 'none'; tenantId?: string; clientId?: string; clientSecret?: string; testFixture?: string };
  /**
   * Yapay zekâ sağlayıcısı (v2 Faz 4, R1). `none` = bağlı değil (varsayılan). `test` = etiketli deterministik test sağlayıcısı (üretimde yasak).
   * `anthropic` = ücretli, kurum dışı; anahtar zorunlu, üretimde ayrıca KVKK/kurum onayı bayrağı. Anahtar yalnız ortamdan gelir; yanıta/günlüğe yazılmaz.
   */
  ai?: { provider: 'none' | 'test' | 'anthropic'; modelId: string; apiKey?: string; externalTransferApproved: boolean };
  /**
   * v2 Faz 5 (R6): e-posta kanalı. `none` (varsayılan) = satır `NOT_CONFIGURED` yazılır, gönderilmez. `graph` = Microsoft Graph `sendMail`
   * (`MAIL_SENDER` posta kutusu; kimlik Faz 2 `ENTRA_*` uygulama kaydı, `Mail.Send` uygulama izni). Sır yalnız ortamdan gelir; yanıta/günlüğe yazılmaz.
   */
  mail?: MailConfig;
  /** v2 Faz 5 (R5): virüs taraması. `none` (varsayılan) = "Virüs taraması yapılandırılmadı"; `clamav` = clamd `zINSTREAM`. */
  av?: AvConfig;
  /** v2 Faz 5 (R4a): girişsiz başvuru uçlarının adres başına sınırı; her ortamda açık (`PUBLIC_APPLY_PER_HOUR`, `PUBLIC_TOKEN_PER_HOUR`). */
  publicRateLimit?: PublicRateLimitConfig;
  /**
   * v2 Faz 8 (D113): ERP entegrasyon sağlayıcısı. `none` (varsayılan) = bağlı değil. `taklit` = "Taklit Oracle (gerçek değil)", üretimde yasak.
   * `oracle-ebs` = Oracle E-Business Suite REST (R1). `secretKey` uç nokta sırlarının zarf şifreleme anahtarı (R5); `allowedHosts` taban
   * adres listesi (R12). Mevcut `erpAdapter` (fatura aktarımı) bundan ayrıdır. Anahtar yanıta/günlüğe/iletiye yazılmaz.
   */
  erp?: ErpConfig;
}

export type ErpConfig = { provider: 'none' | 'taklit' | 'oracle-ebs'; secretKey: Buffer | null; allowedHosts: string[] };

export type MailConfig =
  | { kind: 'none'; sender?: undefined }
  | { kind: 'graph'; sender: string; tenantId: string; clientId: string; clientSecret: string };
export type AvConfig = { kind: 'none'; host?: undefined; port?: undefined } | { kind: 'clamav'; host: string; port: number };

export interface OidcConfig {
  /** Kimlik ad alanı ve tarayıcı akışının issuer'ı (keşif belgesindeki). */
  issuer: string;
  /** Erişim token'ının `iss` değeri; ADFS gibi IdP'lerde farklıdır (ör. .../adfs/services/trust). */
  tokenIssuer: string;
  audience: string;
  jwksUrl: string;
  discoveryUrl: string;
  clientId: string;
  /** Web BFF istemcisi gizli (confidential) tanımlandıysa; public istemci + PKCE'de boş. Yalnız sunucuda. */
  clientSecret?: string | null;
  /** Mobil (iOS) public istemci kimliği; yoksa mobil giriş "yapılandırılmadı" der. Yönlendirme: <bundle id>:/oauth/callback (RFC 8252). */
  nativeClientId?: string | null;
  scope: string;
  /** ADFS: yetkilendirme isteğinde `resource` parametresi (Web API tanımlayıcısı). Diğer IdP'lerde boş. */
  resource: string | null;
  /** Kalıcı kullanıcı anahtarı claim'i: varsayılan `sub`; Entra ID için `oid` önerilir. */
  subjectClaim: string;
  /** E-posta claim'i: varsayılan `email`; ADFS/Entra'da çoğu zaman `upn` veya `preferred_username`. */
  emailClaim: string;
  /**
   * `email_verified` göndermeyen kurum dizinleri (ADFS, Entra ID) için: bu alan adlarındaki e-posta doğrulanmış sayılır.
   * `email_verified: false` açıkça gelirse yine güvenilmez. Boş liste = yalnız `email_verified: true`.
   */
  trustedEmailDomains: string[];
  clockToleranceSeconds: number;
}

function req(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env ${name}`);
  return v;
}

function loadDirectory(env: Config['env']): Config['directory'] {
  const kind = process.env.DIRECTORY_PROVIDER || 'none';
  if (kind === 'none') return { kind: 'none' };
  // Test dizini (sentetik fixture) üretimde asla açılamaz; AUTH_MODE=dev korumasıyla aynı ortam tespiti.
  if (kind === 'test' && env === 'production') throw new Error('DIRECTORY_PROVIDER=test is forbidden in production');
  if (kind === 'test') return { kind: 'test', testFixture: req('DIRECTORY_TEST_FIXTURE') };
  if (kind === 'graph') {
    // Eksik değişkenin yalnız adı yazılır; değer (özellikle sır) hiçbir ileti içinde yer almaz.
    return { kind: 'graph', tenantId: req('ENTRA_TENANT_ID'), clientId: req('ENTRA_CLIENT_ID'), clientSecret: req('ENTRA_CLIENT_SECRET') };
  }
  throw new Error('DIRECTORY_PROVIDER geçersiz: graph, test ya da none olmalı');
}

/** R6: eksik değişkende yalnız adı yazılır (Faz 2 `loadDirectory` deseni); geçersiz sağlayıcı değeri iletiye kopyalanmaz. */
export function loadMail(vars: NodeJS.ProcessEnv = process.env): MailConfig {
  const kind = vars.MAIL_PROVIDER || 'none';
  if (kind === 'none') return { kind: 'none' };
  if (kind === 'graph') {
    const need = (name: string) => {
      const v = vars[name];
      if (!v) throw new Error(`Missing required env ${name} (MAIL_PROVIDER=graph)`);
      return v;
    };
    const sender = need('MAIL_SENDER');
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(sender)) throw new Error('MAIL_SENDER geçersiz: gönderen posta kutusunun e-posta adresi olmalı');
    return { kind: 'graph', sender, tenantId: need('ENTRA_TENANT_ID'), clientId: need('ENTRA_CLIENT_ID'), clientSecret: need('ENTRA_CLIENT_SECRET') };
  }
  throw new Error('MAIL_PROVIDER geçersiz: graph ya da none olmalı');
}

/** R5: `none` üretimde de reddedilmez (dürüst "yapılandırılmadı" durumu; açılışta uyarı günlüğe yazılır). */
export function loadAv(vars: NodeJS.ProcessEnv = process.env): AvConfig {
  const kind = vars.AV_SCANNER || 'none';
  if (kind === 'none') return { kind: 'none' };
  if (kind === 'clamav') {
    const host = vars.CLAMAV_HOST;
    if (!host) throw new Error('Missing required env CLAMAV_HOST (AV_SCANNER=clamav)');
    const port = Number(vars.CLAMAV_PORT || 3310);
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('CLAMAV_PORT geçersiz: 1–65535 arası tam sayı olmalı');
    return { kind: 'clamav', host, port };
  }
  throw new Error('AV_SCANNER geçersiz: clamav ya da none olmalı');
}

/**
 * R5/R12: hata iletisi yalnız değişken adını içerir; anahtar ve geçersiz sağlayıcı değeri iletiye kopyalanmaz.
 * Verilen anahtar her ortamda geçerli olmalı (base64, çözülünce ≥32 bayt); üretimde oracle-ebs için zorunlu.
 */
export function loadErp(env: Config['env'], vars: NodeJS.ProcessEnv = process.env): ErpConfig {
  const provider = vars.ERP_PROVIDER || 'none';
  if (provider !== 'none' && provider !== 'taklit' && provider !== 'oracle-ebs') throw new Error('ERP_PROVIDER geçersiz: none, taklit ya da oracle-ebs olmalı');
  if (provider === 'taklit' && env === 'production') throw new Error('ERP_PROVIDER=taklit is forbidden in production');
  const raw = (vars.INTEGRATION_SECRET_KEY ?? '').trim();
  let secretKey: Buffer | null = null;
  if (raw) {
    const decoded = /^[A-Za-z0-9+/]+={0,2}$/.test(raw) && raw.length % 4 === 0 ? Buffer.from(raw, 'base64') : null;
    if (!decoded || decoded.length < 32) throw new Error('INTEGRATION_SECRET_KEY geçersiz: base64 olmalı ve çözülünce en az 32 bayt olmalı');
    secretKey = decoded;
  }
  if (provider === 'oracle-ebs' && env === 'production' && !secretKey) throw new Error('Missing required env INTEGRATION_SECRET_KEY (ERP_PROVIDER=oracle-ebs in production)');
  const allowedHosts = (vars.INTEGRATION_ALLOWED_HOSTS ?? '').split(',').map((x) => x.trim().toLowerCase()).filter(Boolean);
  return { provider, secretKey, allowedHosts };
}

export const DEFAULT_AI_MODEL_ID = 'claude-sonnet-5-5';

/** R1: başlangıçta reddedilen yapılandırmalar; hata iletisi yalnız değişken adını içerir (anahtar değeri asla). */
export function loadAi(env: Config['env'], vars: NodeJS.ProcessEnv = process.env): NonNullable<Config['ai']> {
  const provider = vars.AI_PROVIDER || 'none';
  const modelId = vars.AI_MODEL_ID || DEFAULT_AI_MODEL_ID;
  const externalTransferApproved = vars.AI_EXTERNAL_TRANSFER_APPROVED === 'true';
  if (provider === 'none') return { provider, modelId, externalTransferApproved };
  if (provider === 'test') {
    if (env === 'production') throw new Error('AI_PROVIDER=test is forbidden in production');
    return { provider, modelId, externalTransferApproved };
  }
  if (provider === 'anthropic') {
    const apiKey = vars.ANTHROPIC_API_KEY;
    if (!apiKey) throw new Error('Missing required env ANTHROPIC_API_KEY (AI_PROVIDER=anthropic)');
    if (env === 'production' && !externalTransferApproved) {
      throw new Error('AI_PROVIDER=anthropic in production requires AI_EXTERNAL_TRANSFER_APPROVED=true (KVKK/kurum onayı: sözleşme metni kurum dışına çıkar)');
    }
    return { provider, modelId, apiKey, externalTransferApproved };
  }
  throw new Error('AI_PROVIDER geçersiz: none, test ya da anthropic olmalı');
}

export function loadConfig(): Config {
  const env = (process.env.NODE_ENV ?? 'development') as Config['env'];
  const authMode = (process.env.AUTH_MODE ?? 'oidc') as Config['authMode'];
  // Dev kimlik doğrulaması üretimde asla açılamaz (kısayol yok).
  if (authMode === 'dev' && env === 'production') throw new Error('AUTH_MODE=dev is forbidden in production');
  const oidc = authMode === 'oidc'
    ? {
        issuer: req('OIDC_ISSUER'), audience: req('OIDC_AUDIENCE'), jwksUrl: req('OIDC_JWKS_URL'),
        // Sunucu içi ağdan erişim adresi farklı olabilir (ör. kurum içi IdP); varsayılan issuer'ın keşif belgesi.
        discoveryUrl: process.env.OIDC_DISCOVERY_URL || `${req('OIDC_ISSUER').replace(/\/$/, '')}/.well-known/openid-configuration`,
        clientId: req('OIDC_CLIENT_ID'),
        clientSecret: process.env.OIDC_CLIENT_SECRET || null,
        nativeClientId: process.env.OIDC_NATIVE_CLIENT_ID || null,
        scope: process.env.OIDC_SCOPE || 'openid profile email',
        resource: process.env.OIDC_RESOURCE || null,
        tokenIssuer: process.env.OIDC_TOKEN_ISSUER || req('OIDC_ISSUER'),
        subjectClaim: process.env.OIDC_SUBJECT_CLAIM || 'sub',
        emailClaim: process.env.OIDC_EMAIL_CLAIM || 'email',
        trustedEmailDomains: (process.env.OIDC_TRUSTED_EMAIL_DOMAINS ?? '').split(',').map((d) => d.trim().toLowerCase()).filter(Boolean),
        clockToleranceSeconds: Number(process.env.OIDC_CLOCK_TOLERANCE_SECONDS ?? 30),
      }
    : null;
  // Üretimde varsayılan açık; geliştirmede ölçüm/E2E aynı adresten yoğun istek attığı için kapalı.
  const rateLimitEnabled = (process.env.RATE_LIMIT_ENABLED ?? (env === 'production' ? 'true' : 'false')) === 'true';
  return {
    env,
    port: Number(process.env.API_PORT ?? process.env.PORT ?? 4100),
    databaseUrl: req('DATABASE_URL'),
    databaseOwnerUrl: process.env.DATABASE_OWNER_URL ?? null,
    authMode,
    oidc,
    devAuthSecret: authMode === 'dev' ? req('DEV_AUTH_SECRET') : null,
    dataRegion: process.env.DATA_REGION ?? 'UNSET',
    objectStore: {
      endpoint: process.env.OBJECT_STORE_ENDPOINT || null,
      region: process.env.OBJECT_STORE_REGION ?? 'us-east-1',
      bucket: req('OBJECT_STORE_BUCKET'),
      forcePathStyle: process.env.OBJECT_STORE_FORCE_PATH_STYLE === 'true',
    },
    signedUrlTtlSeconds: Number(process.env.SIGNED_URL_TTL_SECONDS ?? 60),
    signatureDetectorProvider: process.env.SIGNATURE_DETECTOR_PROVIDER || null,
    esignValidatorProvider: process.env.ESIGN_VALIDATOR_PROVIDER || null,
    erpAdapter: process.env.ERP_ADAPTER || null,
    webOrigin: process.env.WEB_ORIGIN ?? 'http://localhost:5174',
    extraWebOrigins: (process.env.WEB_EXTRA_ORIGINS ?? '').split(',').map((o) => o.trim()).filter(Boolean),
    trustProxy: parseTrustProxy(process.env.TRUST_PROXY),
    reportCacheSeconds: Number(process.env.REPORT_CACHE_SECONDS ?? 120),
    directory: loadDirectory(env),
    ai: loadAi(env),
    mail: loadMail(),
    av: loadAv(),
    publicRateLimit: loadPublicRateLimit(),
    erp: loadErp(env),
    session: {
      secret: process.env.SESSION_SECRET || null,
      // Üretimde çerez yalnız HTTPS'te; web kökeni https ise yerelde de Secure.
      cookieSecure: env === 'production' || (process.env.WEB_ORIGIN ?? '').startsWith('https://'),
      idleMinutes: Number(process.env.SESSION_IDLE_MINUTES ?? 30),
      maxHours: Number(process.env.SESSION_MAX_HOURS ?? 12),
    },
    rateLimit: {
      enabled: rateLimitEnabled,
      perMinute: Number(process.env.RATE_LIMIT_PER_MINUTE ?? DEFAULT_RATE_LIMIT.perMinute),
      heavyPerMinute: Number(process.env.RATE_LIMIT_HEAVY_PER_MINUTE ?? DEFAULT_RATE_LIMIT.heavyPerMinute),
      authPerMinute: Number(process.env.RATE_LIMIT_AUTH_PER_MINUTE ?? DEFAULT_RATE_LIMIT.authPerMinute),
    },
  };
}

function parseTrustProxy(v: string | undefined): string[] | false {
  if (v === 'none') return false; // API doğrudan istemciye açık, önünde vekil yok
  if (!v) return ['loopback'];
  if (v === 'true' || /^\d+$/.test(v)) throw new Error('TRUST_PROXY: atlama sayısı veya "true" kabul edilmez; vekil adres/CIDR listesi verin (ör. 10.244.0.0/16)');
  return v.split(',').map((x) => x.trim()).filter(Boolean);
}
