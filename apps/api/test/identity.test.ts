import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { exportJWK, generateKeyPair, SignJWT, type JWK } from 'jose';
import { syntheticVkn } from '@sp/domain';
import { buildApp } from '../src/server.ts';
import { OidcAuthProvider } from '../src/auth.ts';
import { createPool } from '../src/db.ts';
import { S3ObjectStore } from '../src/storage.ts';
import { provision } from '../src/provision.ts';
import type { Config, OidcConfig } from '../src/config.ts';
import { TEST_APP_URL, TEST_OWNER_URL, TEST_S3_ENDPOINT } from './env.ts';

// Standart OIDC doğrulaması: yerel bir JWKS/keşif uç noktası ile; belirli bir IdP ürününe bağlı değil.
let idp: Server;
let issuer: string;
let key: CryptoKey;
let foreignKey: CryptoKey;
let app: Awaited<ReturnType<typeof buildApp>>;
let adfsApp: Awaited<ReturnType<typeof buildApp>>;
let pool: ReturnType<typeof createPool>;
let owner: pg.Pool;
let tenantId: string;
let companyId: string;
const quiet = () => {};
const oidcConfig = (o: Partial<OidcConfig> = {}): OidcConfig => ({
  issuer, tokenIssuer: issuer, audience: 'sp-api', jwksUrl: `${issuer}/jwks`, discoveryUrl: `${issuer}/.well-known/openid-configuration`,
  clientId: 'sp-web', scope: 'openid profile email', resource: null, subjectClaim: 'sub', emailClaim: 'email', trustedEmailDomains: [], clockToleranceSeconds: 30, ...o,
});

beforeAll(async () => {
  const kp = await generateKeyPair('RS256', { extractable: true });
  key = kp.privateKey;
  foreignKey = (await generateKeyPair('RS256')).privateKey;
  const jwk: JWK = { ...(await exportJWK(kp.publicKey)), kid: 'k1', alg: 'RS256', use: 'sig' };
  idp = createServer((req, res) => {
    res.setHeader('content-type', 'application/json');
    if (req.url === '/jwks') return res.end(JSON.stringify({ keys: [jwk] }));
    if (req.url === '/.well-known/openid-configuration') {
      return res.end(JSON.stringify({ issuer, authorization_endpoint: `${issuer}/auth`, token_endpoint: `${issuer}/token`, jwks_uri: `${issuer}/jwks` }));
    }
    res.statusCode = 404; res.end('{}');
  });
  await new Promise<void>((r) => idp.listen(0, '127.0.0.1', r));
  issuer = `http://127.0.0.1:${(idp.address() as { port: number }).port}`;
  const config: Config = {
    env: 'test', port: 0, databaseUrl: TEST_APP_URL, databaseOwnerUrl: TEST_OWNER_URL, authMode: 'oidc',
    oidc: oidcConfig(),
    devAuthSecret: null, dataRegion: 'TR',
    objectStore: { endpoint: TEST_S3_ENDPOINT, region: 'us-east-1', bucket: 'sp-documents-test', forcePathStyle: true },
    signedUrlTtlSeconds: 60, signatureDetectorProvider: null, esignValidatorProvider: null, webOrigin: 'http://localhost:5174',
  };
  pool = createPool(TEST_APP_URL, 4);
  owner = new pg.Pool({ connectionString: TEST_OWNER_URL, max: 2 });
  app = await buildApp({ config, pool, auth: new OidcAuthProvider(config.oidc!), store: new S3ObjectStore(config.objectStore) });
  // ADFS/Entra benzeri dizin: erişim token'ında farklı iss, `oid` kullanıcı anahtarı, `upn` e-posta, email_verified yok.
  const adfs = oidcConfig({ tokenIssuer: `${issuer}/adfs/services/trust`, subjectClaim: 'oid', emailClaim: 'upn', trustedEmailDomains: ['kurum.test'] });
  adfsApp = await buildApp({ config: { ...config, oidc: adfs }, pool, auth: new OidcAuthProvider(adfs), store: new S3ObjectStore(config.objectStore) });
  const t = await provision(TEST_OWNER_URL, ['tenant:create', '--name', `Kurulum ${randomUUID().slice(0, 6)}`, '--region', 'TR',
    '--company', 'Kurulum A.Ş.', '--tax-type', 'VKN', '--tax-id', syntheticVkn(String(Date.now()).slice(-9))], quiet);
  tenantId = t.tenantId!; companyId = t.companyId!;
});
afterAll(async () => {
  await app.close(); await adfsApp.close(); await pool.end(); await owner.end();
  await new Promise((r) => idp.close(r));
});

const token = (claims: Record<string, unknown>, o: { sub?: string; aud?: string; iss?: string; signer?: CryptoKey } = {}) =>
  new SignJWT(claims).setProtectedHeader({ alg: 'RS256', kid: 'k1' }).setIssuer(o.iss ?? issuer).setAudience(o.aud ?? 'sp-api')
    .setSubject(o.sub ?? randomUUID()).setIssuedAt().setExpirationTime('5m').sign(o.signer ?? key);
const me = (jwt: string) => app.inject({ method: 'GET', url: '/api/v1/me', headers: { authorization: `Bearer ${jwt}` } });
const invite = (email: string, roles = 'TENANT_ADMIN', companies = 'all') =>
  provision(TEST_OWNER_URL, ['user:invite', '--tenant', tenantId, '--email', email, '--name', 'Kurulum Yöneticisi', '--roles', roles, '--companies', companies], quiet);

describe('OIDC (sağlayıcıdan bağımsız)', () => {
  it('oturum yapılandırması IdP keşif belgesinden gelir, sır içermez', async () => {
    const r = await app.inject({ method: 'GET', url: '/api/v1/auth/config' });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({ mode: 'oidc', issuer, clientId: 'sp-web', scope: 'openid profile email', resource: null,
      authorizationEndpoint: `${issuer}/auth`, tokenEndpoint: `${issuer}/token`, endSessionEndpoint: null });
  });

  it('davetli kullanıcı, IdP e-postayı doğruladıysa ilk girişte bağlanır ve denetim kaydı oluşur', async () => {
    const email = `yonetici.${randomUUID().slice(0, 6)}@example.test`;
    const { userId } = await invite(email);
    const sub = randomUUID();
    const r = await me(await token({ email: email.toUpperCase(), email_verified: true }, { sub }));
    expect(r.statusCode).toBe(200);
    expect(r.json().user.id).toBe(userId);
    expect(r.json().memberships.map((m: any) => m.tenantId)).toEqual([tenantId]);
    const u = await owner.query('SELECT auth_subject FROM users WHERE id = $1', [userId]);
    expect(u.rows[0].auth_subject).toBe(`oidc|${issuer}|${sub}`);
    const a = await owner.query(`SELECT data FROM audit_events WHERE action = 'user.identity_linked' AND entity_id = $1`, [userId]);
    expect(a.rows).toHaveLength(1);
    // Sonraki girişler subject ile; e-posta iddiası gerekmez.
    expect((await me(await token({}, { sub }))).statusCode).toBe(200);
  });

  it('doğrulanmamış e-posta, davetsiz e-posta ve tüketilmiş davet bağlanmaz', async () => {
    const email = `alici.${randomUUID().slice(0, 6)}@example.test`;
    await invite(email, 'BUYER');
    expect((await me(await token({ email, email_verified: false }))).json().error.code).toBe('not_invited');
    expect((await me(await token({ email: 'davetsiz@example.test', email_verified: true }))).statusCode).toBe(403);
    expect((await me(await token({ email, email_verified: true }))).statusCode).toBe(200);
    // Aynı e-postayla başka bir IdP hesabı (farklı sub) bağlanan hesabı ele geçiremez.
    const r = await me(await token({ email, email_verified: true }));
    expect(r.statusCode).toBe(403);
  });

  it('başka anahtarla imzalı veya yanlış audience token reddedilir', async () => {
    expect((await me(await token({}, { signer: foreignKey }))).statusCode).toBe(401);
    expect((await me(await token({}, { aud: 'baska-uygulama' }))).statusCode).toBe(401);
  });
});

describe('Kurumsal dizin (ADFS / Entra ID benzeri claim seti)', () => {
  const adfsMe = (jwt: string) => adfsApp.inject({ method: 'GET', url: '/api/v1/me', headers: { authorization: `Bearer ${jwt}` } });
  const trustIss = () => `${issuer}/adfs/services/trust`;

  it('güvenilen alan adındaki upn, email_verified olmadan daveti bağlar; anahtar oid claim\'idir', async () => {
    const email = `finans.${randomUUID().slice(0, 6)}@kurum.test`;
    const { userId } = await invite(email, 'FINANCE');
    const oid = randomUUID();
    const r = await adfsMe(await token({ upn: email, oid }, { iss: trustIss(), sub: 'ciftli-uygulama-sub' }));
    expect(r.statusCode).toBe(200);
    expect(r.json().user.id).toBe(userId);
    const u = await owner.query('SELECT auth_subject FROM users WHERE id = $1', [userId]);
    expect(u.rows[0].auth_subject).toBe(`oidc|${issuer}|${oid}`);
  });

  it('güvenilmeyen alan adı, açık email_verified=false, yanlış iss ve oid eksikliği reddedilir', async () => {
    const email = `hukuk.${randomUUID().slice(0, 6)}@kurum.test`;
    await invite(email, 'LEGAL');
    await invite('dis.kullanici@baska.test', 'LEGAL');
    expect((await adfsMe(await token({ upn: 'dis.kullanici@baska.test', oid: randomUUID() }, { iss: trustIss() }))).json().error.code).toBe('not_invited');
    expect((await adfsMe(await token({ upn: email, oid: randomUUID(), email_verified: false }, { iss: trustIss() }))).json().error.code).toBe('not_invited');
    expect((await adfsMe(await token({ upn: email, oid: randomUUID() }))).statusCode).toBe(401);
    expect((await adfsMe(await token({ upn: email }, { iss: trustIss() }))).statusCode).toBe(401);
  });
});

describe('Kurulum aracı', () => {
  it('geçersiz VKN, bilinmeyen rol ve kiracı dışı şirket reddedilir; hiçbir şey yazılmaz', async () => {
    const valid = syntheticVkn('400000001');
    const badChecksum = valid.slice(0, 9) + String((Number(valid[9]) + 1) % 10);
    await expect(provision(TEST_OWNER_URL, ['tenant:create', '--name', 'Geçersiz VKN', '--region', 'TR', '--company', 'X', '--tax-id', badChecksum], quiet))
      .rejects.toThrow(/invalid tax id/);
    await expect(invite('rol@example.test', 'SUPERUSER')).rejects.toThrow(/unknown roles/);
    await expect(invite('sirket@example.test', 'BUYER', randomUUID())).rejects.toThrow(/belong to --tenant/);
    await expect(invite('portal@example.test', 'SUPPLIER')).rejects.toThrow(/requires --supplier/);
    const u = await owner.query(`SELECT 1 FROM users WHERE email IN ('rol@example.test','sirket@example.test')`);
    expect(u.rowCount).toBe(0);
    expect((await owner.query(`SELECT 1 FROM tenants WHERE name = 'Geçersiz VKN'`)).rowCount).toBe(0);
    expect(companyId).toBeTruthy();
  });
});
