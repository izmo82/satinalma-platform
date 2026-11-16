import { createRemoteJWKSet, jwtVerify, SignJWT, type JWTPayload } from 'jose';
import type pg from 'pg';
import type { FastifyRequest } from 'fastify';
import { randomUUID } from 'node:crypto';
import type { OidcConfig } from './config.ts';
import { withoutTenant, type TenantContext } from './db.ts';
import { ApiError } from './errors.ts';
import { normalizeRoles, SEES_ALL_DEPARTMENTS } from '@sp/domain';

export interface VerifiedToken {
  /** Kalıcı kullanıcı anahtarı; OIDC için 'oidc|<issuer>|<sub>'. */
  subject: string;
  /** Yalnız IdP doğrulanmış bildirdiyse dolu; davet bağlamada kullanılır. */
  verifiedEmail: string | null;
}

export interface AuthProvider {
  /** Bearer token'ı doğrular; imza, issuer, audience ve süre kontrolü sağlayıcıdadır. */
  verify(token: string): Promise<VerifiedToken>;
}

/** Standart OIDC: herhangi bir uyumlu IdP (Keycloak, Entra ID, Okta, ADFS, Authentik...). Sağlayıcıya özel kod yok;
 *  IdP farkları (iss, subject/e-posta claim'i, email_verified yokluğu) yapılandırmayla karşılanır. */
export class OidcAuthProvider implements AuthProvider {
  private jwks;
  constructor(private cfg: OidcConfig) {
    this.jwks = createRemoteJWKSet(new URL(cfg.jwksUrl));
  }
  async verify(token: string) {
    const { payload } = await jwtVerify(token, this.jwks, {
      issuer: this.cfg.tokenIssuer, audience: this.cfg.audience, clockTolerance: this.cfg.clockToleranceSeconds,
    });
    const sub = payload[this.cfg.subjectClaim];
    if (typeof sub !== 'string' || !sub) throw new Error('no subject claim');
    return { subject: `oidc|${this.cfg.issuer}|${sub}`, verifiedEmail: verifiedEmail(payload, this.cfg) };
  }
}

/** Davet bağlamak için kullanılabilecek e-posta. Açık `email_verified: false` her durumda reddedilir. */
export function verifiedEmail(payload: JWTPayload, cfg: Pick<OidcConfig, 'emailClaim' | 'trustedEmailDomains'>): string | null {
  const raw = payload[cfg.emailClaim];
  if (typeof raw !== 'string' || !/^[^\s@]+@[^\s@]+$/.test(raw)) return null;
  const email = raw.toLowerCase();
  if (payload.email_verified === true) return email;
  if (payload.email_verified === undefined && cfg.trustedEmailDomains.includes(email.slice(email.lastIndexOf('@') + 1))) return email;
  return null;
}

/** Yalnız development/test: sentetik kullanıcılar için yerel HS256 token. Üretimde config bunu reddeder. */
export class DevAuthProvider implements AuthProvider {
  private key: Uint8Array;
  constructor(secret: string) {
    if (secret.length < 32) throw new Error('DEV_AUTH_SECRET must be at least 32 chars');
    this.key = new TextEncoder().encode(secret);
  }
  async verify(token: string) {
    const { payload } = await jwtVerify(token, this.key, { issuer: 'sp-dev', audience: 'sp-api' });
    return { subject: (payload as JWTPayload).sub!, verifiedEmail: null };
  }
  async issue(subject: string, ttl = '8h') {
    return new SignJWT({}).setProtectedHeader({ alg: 'HS256' }).setSubject(subject)
      .setIssuer('sp-dev').setAudience('sp-api').setIssuedAt().setExpirationTime(ttl).sign(this.key);
  }
}

/** `roles` her zaman v2 rolleridir (saklanan eski kodlar normalize edilir). */
export interface Membership { tenantId: string; tenantName: string; roles: string[]; companyIds: string[]; supplierId: string | null; departmentIds: string[] }
export interface Identity { userId: string; email: string; displayName: string; memberships: Membership[] }

/** Minimal oturum arayüzü (döngüsel import olmasın): çerez varsa doğrulanmış subject, yoksa null. */
export interface SessionAuthenticator { authenticate(req: FastifyRequest): Promise<VerifiedToken | null> }

/**
 * İstek kimliği: `Authorization: Bearer` (iOS, servisler, testler) önce; yoksa web oturum çerezi (BFF). İkisi de yoksa 401.
 */
export async function resolveIdentity(pool: pg.Pool, provider: AuthProvider, req: FastifyRequest, sessions?: SessionAuthenticator): Promise<Identity> {
  const h = req.headers.authorization;
  let token: VerifiedToken;
  if (h?.startsWith('Bearer ')) {
    try {
      token = await provider.verify(h.slice(7));
    } catch {
      throw new ApiError(401, 'unauthenticated', 'Oturum geçersiz veya süresi dolmuş.');
    }
  } else {
    const fromCookie = sessions ? await sessions.authenticate(req) : null;
    if (!fromCookie) throw new ApiError(401, 'unauthenticated', 'Oturum gerekli.');
    token = fromCookie;
  }
  return identityFor(pool, token);
}

/** Doğrulanmış subject → kullanıcı ve üyelikler. İlk kurumsal girişte davet (doğrulanmış e-postayla) burada bağlanır. */
export async function identityFor(pool: pg.Pool, token: VerifiedToken): Promise<Identity> {
  return withoutTenant(pool, async (c) => {
    type U = { id: string; email: string; display_name: string };
    let user = (await c.query<U>('SELECT * FROM auth_user_by_subject($1)', [token.subject])).rows[0];
    // İlk kurumsal giriş: yalnız davet edilmiş ve IdP'nin doğruladığı e-posta bağlanır.
    if (!user && token.verifiedEmail) {
      user = (await c.query<U>('SELECT * FROM auth_link_invited_user($1, $2)', [token.subject, token.verifiedEmail])).rows[0];
    }
    if (!user) throw new ApiError(403, 'not_invited', 'Bu hesap için davet bulunamadı. Kurum yöneticinizden erişim isteyin.');
    const m = await c.query<{ tenant_id: string; tenant_name: string; roles: string[]; company_ids: string[]; supplier_id: string | null; department_ids: string[] }>(
      'SELECT * FROM auth_memberships($1)', [user.id]);
    return {
      userId: user.id, email: user.email, displayName: user.display_name,
      memberships: m.rows.map((r) => ({ tenantId: r.tenant_id, tenantName: r.tenant_name, roles: normalizeRoles(r.roles), companyIds: r.company_ids,
        supplierId: r.supplier_id, departmentIds: r.department_ids })),
    };
  });
}

/**
 * Aktif kiracı: istemci yalnız seçim bildirir (X-Tenant-Id); karar doğrulanmış üyelikten türetilir.
 * Üye olunmayan kiracı için 404 değil 403 döner; kaynak varlığı sızdırılmaz.
 */
export function tenantContext(identity: Identity, req: FastifyRequest): TenantContext {
  const requested = req.headers['x-tenant-id'];
  const membership = typeof requested === 'string'
    ? identity.memberships.find((m) => m.tenantId === requested)
    : identity.memberships.length === 1 ? identity.memberships[0] : undefined;
  if (!membership) throw new ApiError(403, 'tenant_not_selected', 'Geçerli bir kiracı üyeliği seçilmedi.');
  const corr = req.headers['x-correlation-id'];
  const roles = normalizeRoles(membership.roles);
  return {
    userId: identity.userId,
    tenantId: membership.tenantId,
    roles,
    companyIds: membership.companyIds,
    supplierId: membership.supplierId,
    // Departman kapsamı rolden türetilir; tedarikçi bağlamı RLS'de ayrıca açılır (kendi politikaları geçerli).
    departmentIds: membership.departmentIds,
    allDepartments: roles.some((r) => SEES_ALL_DEPARTMENTS.includes(r)),
    correlationId: typeof corr === 'string' && /^[\w\-]{8,64}$/.test(corr) ? corr : randomUUID(),
  };
}
