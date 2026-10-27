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
}

export interface OidcConfig {
  /** Kimlik ad alanı ve tarayıcı akışının issuer'ı (keşif belgesindeki). */
  issuer: string;
  /** Erişim token'ının `iss` değeri; ADFS gibi IdP'lerde farklıdır (ör. .../adfs/services/trust). */
  tokenIssuer: string;
  audience: string;
  jwksUrl: string;
  discoveryUrl: string;
  clientId: string;
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
        scope: process.env.OIDC_SCOPE || 'openid profile email',
        resource: process.env.OIDC_RESOURCE || null,
        tokenIssuer: process.env.OIDC_TOKEN_ISSUER || req('OIDC_ISSUER'),
        subjectClaim: process.env.OIDC_SUBJECT_CLAIM || 'sub',
        emailClaim: process.env.OIDC_EMAIL_CLAIM || 'email',
        trustedEmailDomains: (process.env.OIDC_TRUSTED_EMAIL_DOMAINS ?? '').split(',').map((d) => d.trim().toLowerCase()).filter(Boolean),
        clockToleranceSeconds: Number(process.env.OIDC_CLOCK_TOLERANCE_SECONDS ?? 30),
      }
    : null;
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
  };
}
