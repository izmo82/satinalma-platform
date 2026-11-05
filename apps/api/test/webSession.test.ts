import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { createHash, randomUUID } from 'node:crypto';
import pg from 'pg';
import { exportJWK, generateKeyPair, SignJWT, type JWK } from 'jose';
import { syntheticVkn } from '@sp/domain';
import { buildApp } from '../src/server.ts';
import { OidcAuthProvider } from '../src/auth.ts';
import { createPool } from '../src/db.ts';
import { S3ObjectStore } from '../src/storage.ts';
import { provision } from '../src/provision.ts';
import type { Config } from '../src/config.ts';
import { makeHarness } from './harness.ts';
import { TEST_APP_URL, TEST_OWNER_URL, TEST_S3_ENDPOINT } from './env.ts';

// Web oturumu sunucuda (BFF, D78): token tarayıcıya hiç verilmez; çerez HttpOnly + SameSite=Strict, CSRF başlığı, süre sınırları.
const WEB = 'http://localhost:5174';
const csrf = { 'x-sp-csrf': '1', origin: WEB };
const cookieOf = (res: { headers: Record<string, unknown> }, name: string) => {
  const raw = res.headers['set-cookie'];
  const all = (Array.isArray(raw) ? raw : raw ? [String(raw)] : []) as string[];
  const c = all.find((x) => x.startsWith(`${name}=`));
  return c ? { value: c.slice(name.length + 1, c.indexOf(';')), attrs: c } : null;
};

describe('dev oturumu (çerezli)', () => {
  let h: Awaited<ReturnType<typeof makeHarness>>;
  beforeAll(async () => { h = await makeHarness({ session: { secret: null, cookieSecure: false, idleMinutes: 30, maxHours: 12 } }); });
  afterAll(async () => { await h.close(); });
  const login = async (email = h.world.users.buyer.email) => {
    const r = await h.app.inject({ method: 'POST', url: '/api/v1/dev/session', headers: csrf, payload: { email } });
    expect(r.statusCode).toBe(200);
    expect(r.body).not.toContain('token');
    return cookieOf(r, 'sp_sid')!;
  };

  it('çerez HttpOnly + SameSite=Strict; yanıtta token yok; /me çerezle çalışır; kimlik veritabanında yalnız özetle', async () => {
    const c = await login();
    expect(c.attrs).toMatch(/HttpOnly/);
    expect(c.attrs).toMatch(/SameSite=Strict/);
    expect(c.attrs).toMatch(/Path=\//);
    const me = await h.app.inject({ method: 'GET', url: '/api/v1/me', headers: { cookie: `sp_sid=${c.value}` } });
    expect(me.statusCode).toBe(200);
    expect(me.json().user.email).toBe(h.world.users.buyer.email);
    const row = await h.owner.query('SELECT id_hash, mode, tokens FROM web_sessions WHERE id_hash = $1', [createHash('sha256').update(c.value).digest()]);
    expect(row.rows).toHaveLength(1);
    expect(row.rows[0]).toMatchObject({ mode: 'dev', tokens: null });
  });

  it('durum değiştiren istek CSRF başlığı ve aynı köken ister; okuma istemez; Bearer yolu değişmedi', async () => {
    const c = await login();
    const cookie = `sp_sid=${c.value}`;
    const body = { page: 'invoices', name: `Görünüm ${randomUUID().slice(0, 4)}`, params: { status: 'PENDING' } };
    expect((await h.app.inject({ method: 'POST', url: '/api/v1/saved-views', headers: { cookie }, payload: body })).json().error.code).toBe('csrf');
    expect((await h.app.inject({ method: 'POST', url: '/api/v1/saved-views', headers: { cookie, 'x-sp-csrf': '1', origin: 'https://saldirgan.example' }, payload: body })).statusCode).toBe(403);
    expect((await h.app.inject({ method: 'POST', url: '/api/v1/saved-views', headers: { cookie, ...csrf }, payload: body })).statusCode).toBe(201);
    // Yerel ağ adresi (WEB_EXTRA_ORIGINS) da aynı web sayılır.
    expect((await h.app.inject({ method: 'POST', url: '/api/v1/saved-views', headers: { cookie, 'x-sp-csrf': '1', origin: 'http://10.0.0.5:5174' }, payload: { ...body, name: `${body.name} ağ` } })).statusCode).toBe(201);
    expect((await h.app.inject({ method: 'GET', url: '/api/v1/saved-views?page=invoices', headers: { cookie } })).statusCode).toBe(200);
    expect((await h.call('buyer', 'GET', '/api/v1/me')).status).toBe(200);
    // Dev oturumu da CSRF başlığı ister (başka siteden form gönderimiyle oturum açtırılamaz).
    expect((await h.app.inject({ method: 'POST', url: '/api/v1/dev/session', payload: { email: h.world.users.buyer.email } })).statusCode).toBe(403);
  });

  it('boşta kalma ve mutlak süre dolunca 401 ve oturum silinir; çıkış oturumu siler ve çerezi temizler; bozuk çerez 401', async () => {
    const idle = await login();
    const idleHash = createHash('sha256').update(idle.value).digest();
    await h.owner.query(`UPDATE web_sessions SET last_seen_at = now() - interval '31 minutes' WHERE id_hash = $1`, [idleHash]);
    const r1 = await h.app.inject({ method: 'GET', url: '/api/v1/me', headers: { cookie: `sp_sid=${idle.value}` } });
    expect(r1.json().error.code).toBe('session_expired');
    expect((await h.owner.query('SELECT 1 FROM web_sessions WHERE id_hash = $1', [idleHash])).rowCount).toBe(0);

    const old = await login();
    await h.owner.query(`UPDATE web_sessions SET expires_at = now() - interval '1 second' WHERE id_hash = $1`, [createHash('sha256').update(old.value).digest()]);
    expect((await h.app.inject({ method: 'GET', url: '/api/v1/me', headers: { cookie: `sp_sid=${old.value}` } })).statusCode).toBe(401);

    const c = await login();
    const out = await h.app.inject({ method: 'POST', url: '/api/v1/auth/logout', headers: { cookie: `sp_sid=${c.value}`, ...csrf } });
    expect(out.json()).toEqual({ endSessionUrl: null });
    expect(cookieOf(out, 'sp_sid')!.attrs).toMatch(/Max-Age=0/);
    expect((await h.app.inject({ method: 'GET', url: '/api/v1/me', headers: { cookie: `sp_sid=${c.value}` } })).statusCode).toBe(401);
    expect((await h.app.inject({ method: 'GET', url: '/api/v1/me', headers: { cookie: 'sp_sid=uydurma' } })).statusCode).toBe(401);
  });

  it('ortak çerez başka kullanıcıya geçtiyse eski ekranın isteği yürütülmez (409); yanıtlar oturum kullanıcısını bildirir', async () => {
    const a = await login(h.world.users.buyer.email);
    const meA = await h.app.inject({ method: 'GET', url: '/api/v1/me', headers: { cookie: `sp_sid=${a.value}` } });
    const buyerId = meA.json().user.id as string;
    expect(meA.headers['x-sp-user']).toBe(buyerId);
    // Aynı tarayıcıda (çerez a ile) başka kullanıcı girişi: önceki oturum sunucuda silinir.
    const r = await h.app.inject({ method: 'POST', url: '/api/v1/dev/session', headers: { ...csrf, cookie: `sp_sid=${a.value}` }, payload: { email: h.world.users.finance.email } });
    const b = cookieOf(r, 'sp_sid')!;
    expect((await h.app.inject({ method: 'GET', url: '/api/v1/me', headers: { cookie: `sp_sid=${a.value}` } })).statusCode).toBe(401);
    // Alıcının ekranı (beklenen kullanıcı = alıcı) yeni çerezle kayıt yazmaya çalışır: yürütülmez.
    const before = (await h.owner.query('SELECT count(*)::int AS n FROM saved_views')).rows[0].n;
    const w = await h.app.inject({ method: 'POST', url: '/api/v1/saved-views', headers: { cookie: `sp_sid=${b.value}`, ...csrf, 'x-sp-expect-user': buyerId },
      payload: { page: 'invoices', name: `Yanlış kişi ${randomUUID().slice(0, 4)}`, params: {} } });
    expect([w.statusCode, w.json().error.code]).toEqual([409, 'identity_changed']);
    expect((await h.owner.query('SELECT count(*)::int AS n FROM saved_views')).rows[0].n).toBe(before);
    expect((await h.app.inject({ method: 'GET', url: '/api/v1/me', headers: { cookie: `sp_sid=${b.value}`, 'x-sp-expect-user': buyerId } })).statusCode).toBe(409);
    expect((await h.app.inject({ method: 'GET', url: '/api/v1/me', headers: { cookie: `sp_sid=${b.value}` } })).json().user.email).toBe(h.world.users.finance.email);
  });

  it('kullanımda boşta kalma süresi kayar (last_seen_at ilerler; dakikada en çok bir yazma)', async () => {
    const c = await login();
    const hash = createHash('sha256').update(c.value).digest();
    await h.owner.query(`UPDATE web_sessions SET last_seen_at = now() - interval '20 minutes' WHERE id_hash = $1`, [hash]);
    expect((await h.app.inject({ method: 'GET', url: '/api/v1/me', headers: { cookie: `sp_sid=${c.value}` } })).statusCode).toBe(200);
    const age = (await h.owner.query(`SELECT extract(epoch FROM now() - last_seen_at)::int AS s FROM web_sessions WHERE id_hash = $1`, [hash])).rows[0].s;
    expect(age).toBeLessThan(5);
  });

  it('uygulama rolü oturum tablosunu doğrudan okuyamaz (yalnız dar fonksiyonlar)', async () => {
    await expect(h.pool.query('SELECT * FROM web_sessions')).rejects.toThrow(/permission denied/);
  });
});

describe('OIDC BFF akışı (sahte, standart uyumlu IdP)', () => {
  let idp: Server; let issuer: string; let key: CryptoKey;
  let app: Awaited<ReturnType<typeof buildApp>>; let replica: Awaited<ReturnType<typeof buildApp>>; let pool: ReturnType<typeof createPool>; let owner: pg.Pool; let tenantId: string;
  // IdP durumu: verilen kodlar (PKCE doğrulanır), yenileme sayısı, iptal edilenler, yenilemeyi reddetme anahtarı.
  const codes = new Map<string, { challenge: string; sub: string; email: string; nonce: string }>();
  // refreshMode: ok | reject | 503 | 429 | html. rotate: her yenilemede yeni refresh token, eskisinin tekrar kullanımı ret + aile iptali
  // (Okta/Auth0 varsayılanı, Keycloak revokeRefreshToken). delayMs: IdP yanıtı gecikmesi (yarış penceresi).
  const idp_ = { refreshes: 0, revoked: [] as string[], refreshMode: 'ok' as 'ok' | 'reject' | '503' | '429' | 'html', rotate: false, delayMs: 0,
    accessTtl: 300, lastTokenBody: '', used: new Set<string>(), familyRevoked: new Set<string>() };
  const quiet = () => {};

  const sign = (claims: Record<string, unknown>, aud: string, sub: string, ttl: number) =>
    new SignJWT(claims).setProtectedHeader({ alg: 'RS256', kid: 'k1' }).setIssuer(issuer).setAudience(aud).setSubject(sub)
      .setIssuedAt().setExpirationTime(Math.floor(Date.now() / 1000) + ttl).sign(key);

  beforeAll(async () => {
    const kp = await generateKeyPair('RS256', { extractable: true });
    key = kp.privateKey;
    const jwk: JWK = { ...(await exportJWK(kp.publicKey)), kid: 'k1', alg: 'RS256', use: 'sig' };
    idp = createServer((req, res) => {
      let body = '';
      req.on('data', (d) => { body += d; });
      req.on('end', async () => {
        res.setHeader('content-type', 'application/json');
        const f = new URLSearchParams(body);
        if (req.url === '/jwks') return res.end(JSON.stringify({ keys: [jwk] }));
        if (req.url === '/.well-known/openid-configuration') {
          return res.end(JSON.stringify({ issuer, authorization_endpoint: `${issuer}/auth`, token_endpoint: `${issuer}/token`, jwks_uri: `${issuer}/jwks`,
            revocation_endpoint: `${issuer}/revoke`, end_session_endpoint: `${issuer}/logout` }));
        }
        if (req.url === '/revoke') { idp_.revoked.push(f.get('token') ?? ''); return res.end('{}'); }
        if (req.url === '/token') {
          idp_.lastTokenBody = body;
          if (f.get('grant_type') === 'authorization_code') {
            const c = codes.get(f.get('code') ?? '');
            const verifierOk = c && createHash('sha256').update(f.get('code_verifier') ?? '').digest('base64url') === c.challenge;
            if (!c || !verifierOk || f.get('redirect_uri') !== `${WEB}/auth/callback` || f.get('client_id') !== 'sp-web') { res.statusCode = 400; return res.end('{"error":"invalid_grant"}'); }
            codes.delete(f.get('code')!);
            return res.end(JSON.stringify({
              access_token: await sign({ email: c.email, email_verified: true }, 'sp-api', c.sub, idp_.accessTtl),
              id_token: await sign({ nonce: c.nonce }, 'sp-web', c.sub, 300), refresh_token: `rt-${c.sub}`, expires_in: idp_.accessTtl }));
          }
          if (f.get('grant_type') === 'refresh_token') {
            idp_.refreshes++;
            if (idp_.delayMs) await new Promise((r) => setTimeout(r, idp_.delayMs));
            const rt = f.get('refresh_token') ?? '';
            const sub = rt.slice(3).split('.')[0]!;
            if (idp_.refreshMode === 'reject' || idp_.familyRevoked.has(sub)) { res.statusCode = 400; return res.end('{"error":"invalid_grant"}'); }
            if (idp_.refreshMode === '503') { res.statusCode = 503; return res.end('{}'); }
            if (idp_.refreshMode === '429') { res.statusCode = 429; return res.end('{}'); }
            if (idp_.refreshMode === 'html') { res.setHeader('content-type', 'text/html'); return res.end('<html>vekil oturumu</html>'); }
            if (idp_.rotate) {
              if (idp_.used.has(rt)) { idp_.familyRevoked.add(sub); res.statusCode = 400; return res.end('{"error":"invalid_grant"}'); }
              idp_.used.add(rt);
            }
            return res.end(JSON.stringify({ access_token: await sign({}, 'sp-api', sub, 300), expires_in: 300,
              ...(idp_.rotate ? { refresh_token: `rt-${sub}.${randomUUID().slice(0, 8)}` } : {}) }));
          }
        }
        res.statusCode = 404; res.end('{}');
      });
    });
    await new Promise<void>((r) => idp.listen(0, '127.0.0.1', r));
    issuer = `http://127.0.0.1:${(idp.address() as { port: number }).port}`;
    const oidc = { issuer, tokenIssuer: issuer, audience: 'sp-api', jwksUrl: `${issuer}/jwks`, discoveryUrl: `${issuer}/.well-known/openid-configuration`,
      clientId: 'sp-web', scope: 'openid profile email', resource: null, subjectClaim: 'sub', emailClaim: 'email', trustedEmailDomains: [], clockToleranceSeconds: 5 };
    const config: Config = {
      env: 'test', port: 0, databaseUrl: TEST_APP_URL, databaseOwnerUrl: TEST_OWNER_URL, authMode: 'oidc', oidc, devAuthSecret: null, dataRegion: 'TR',
      objectStore: { endpoint: TEST_S3_ENDPOINT, region: 'us-east-1', bucket: 'sp-documents-test', forcePathStyle: true },
      signedUrlTtlSeconds: 60, signatureDetectorProvider: null, esignValidatorProvider: null, webOrigin: WEB,
      session: { secret: 'bff-test-anahtari-en-az-otuz-iki-karakter-uzun', cookieSecure: false, idleMinutes: 30, maxHours: 12 },
    };
    pool = createPool(TEST_APP_URL, 4);
    owner = new pg.Pool({ connectionString: TEST_OWNER_URL, max: 2 });
    app = await buildApp({ config, pool, auth: new OidcAuthProvider(oidc), store: new S3ObjectStore(config.objectStore) });
    // Aynı veritabanını paylaşan ikinci API kopyası (Kubernetes'te replicas: 2): süreç içi tekillik birbirini görmez.
    replica = await buildApp({ config, pool, auth: new OidcAuthProvider(oidc), store: new S3ObjectStore(config.objectStore) });
    const t = await provision(TEST_OWNER_URL, ['tenant:create', '--name', `BFF ${randomUUID().slice(0, 6)}`, '--region', 'TR',
      '--company', 'BFF A.Ş.', '--tax-type', 'VKN', '--tax-id', syntheticVkn(String(Date.now()).slice(-9))], quiet);
    tenantId = t.tenantId!;
  });
  afterAll(async () => { await app.close(); await replica.close(); await pool.end(); await owner.end(); await new Promise((r) => idp.close(r)); });

  /** Tarayıcının yaptığını taklit eder: /auth/login → IdP (kodu biz üretiriz) → /auth/session. */
  async function signIn(email: string, sub = randomUUID(), returnTo = '/sozlesmeler?durum=ACIK') {
    const start = await app.inject({ method: 'GET', url: `/api/v1/auth/login?returnTo=${encodeURIComponent(returnTo)}` });
    expect(start.statusCode).toBe(302);
    const loc = new URL(String(start.headers.location));
    const flow = cookieOf(start, 'sp_flow')!;
    expect(flow.attrs).toMatch(/HttpOnly/);
    expect(loc.searchParams.get('code_challenge_method')).toBe('S256');
    expect(loc.searchParams.get('redirect_uri')).toBe(`${WEB}/auth/callback`);
    const code = randomUUID();
    codes.set(code, { challenge: loc.searchParams.get('code_challenge')!, sub, email, nonce: loc.searchParams.get('nonce')! });
    const done = await app.inject({ method: 'POST', url: '/api/v1/auth/session', headers: { cookie: `sp_flow=${flow.value}`, ...csrf },
      payload: { code, state: loc.searchParams.get('state')! } });
    return { done, sid: cookieOf(done, 'sp_sid'), sub, state: loc.searchParams.get('state')!, flow: flow.value };
  }
  const invite = (email: string) => provision(TEST_OWNER_URL, ['user:invite', '--tenant', tenantId, '--email', email, '--name', 'BFF Kullanıcısı',
    '--roles', 'BUYER', '--companies', 'all'], quiet);
  const me = (sid: string) => app.inject({ method: 'GET', url: '/api/v1/me', headers: { cookie: `sp_sid=${sid}` } });
  const tokensOf = async (sid: string) => (await owner.query('SELECT tokens FROM web_sessions WHERE id_hash = $1', [createHash('sha256').update(sid).digest()])).rows[0]?.tokens as Buffer | undefined;

  it('davetli kullanıcı: kod sunucuda token\'a çevrilir (PKCE), davet bağlanır, dönüş yolu korunur; tarayıcıya token gitmez, saklanan token şifreli', async () => {
    const email = `bff.${randomUUID().slice(0, 6)}@example.test`;
    await invite(email);
    const s = await signIn(email);
    expect(s.done.statusCode).toBe(200);
    expect(s.done.json()).toEqual({ returnTo: '/sozlesmeler?durum=ACIK' });
    expect(s.done.body).not.toMatch(/eyJ|rt-/);
    expect(cookieOf(s.done, 'sp_flow')!.attrs).toMatch(/Max-Age=0/);
    expect((await me(s.sid!.value)).json().user.email).toBe(email);
    const enc = await tokensOf(s.sid!.value);
    expect(enc!.toString('latin1')).not.toMatch(/eyJ|rt-/);
  });

  it('state eşleşmezse, akış çerezi yoksa veya kod tekrar kullanılırsa oturum açılmaz; davetsiz hesap için oturum oluşmaz', async () => {
    const email = `bff.${randomUUID().slice(0, 6)}@example.test`;
    await invite(email);
    const start = await app.inject({ method: 'GET', url: '/api/v1/auth/login' });
    const flow = cookieOf(start, 'sp_flow')!.value;
    const wrong = await app.inject({ method: 'POST', url: '/api/v1/auth/session', headers: { cookie: `sp_flow=${flow}`, ...csrf }, payload: { code: 'x', state: 'baska' } });
    expect(wrong.json().error.code).toBe('login_state_mismatch');
    const state = new URL(String(start.headers.location)).searchParams.get('state')!;
    expect((await app.inject({ method: 'POST', url: '/api/v1/auth/session', headers: csrf, payload: { code: 'x', state } })).json().error.code).toBe('login_state_mismatch');
    const noCsrf = await app.inject({ method: 'POST', url: '/api/v1/auth/session', headers: { cookie: `sp_flow=${flow}` }, payload: { code: 'x', state } });
    expect(noCsrf.statusCode).toBe(403);
    const stranger = await signIn('davetsiz.bff@example.test');
    expect(stranger.done.json().error.code).toBe('not_invited');
    expect(stranger.sid).toBeNull();
    // Dönüş yolu yalnız uygulama içi (açık yönlendirme yok).
    const ext = await signIn(email, randomUUID(), '//saldirgan.example/x');
    expect(ext.done.json().returnTo).toBe('/');
  });

  it('erişim token\'ı bitmek üzereyken sunucu sessizce yeniler (eşzamanlı istekler tek yenileme); IdP reddederse oturum biter', async () => {
    const email = `bff.${randomUUID().slice(0, 6)}@example.test`;
    await invite(email);
    idp_.accessTtl = 30; // yenileme eşiği 60 sn: sonraki istekte yenilenir
    const s = await signIn(email);
    idp_.accessTtl = 300;
    const before = idp_.refreshes;
    const rs = await Promise.all([me(s.sid!.value), me(s.sid!.value), me(s.sid!.value)]);
    expect(rs.map((r) => r.statusCode)).toEqual([200, 200, 200]);
    expect(idp_.refreshes - before).toBe(1);
    expect((await me(s.sid!.value)).statusCode).toBe(200);
    expect(idp_.refreshes - before).toBe(1);

    idp_.accessTtl = 30;
    const s2 = await signIn(email, s.sub); // aynı IdP hesabı (davet ilk girişte bu sub'a bağlandı)
    idp_.accessTtl = 300;
    idp_.refreshMode = 'reject';
    expect((await me(s2.sid!.value)).json().error.code).toBe('session_expired');
    idp_.refreshMode = 'ok';
    expect(await tokensOf(s2.sid!.value)).toBeUndefined();
  });

  it('IdP geçici olarak yoksa (503, 429, vekilden HTML) oturum silinmez: 503 döner, IdP düzelince aynı oturum devam eder', async () => {
    const email = `bff.${randomUUID().slice(0, 6)}@example.test`;
    await invite(email);
    idp_.accessTtl = 30;
    const s = await signIn(email);
    idp_.accessTtl = 300;
    for (const mode of ['503', '429', 'html'] as const) {
      idp_.refreshMode = mode;
      const r = await me(s.sid!.value);
      expect([r.statusCode, r.json().error.code]).toEqual([503, 'idp_unavailable']);
      expect(await tokensOf(s.sid!.value)).toBeDefined();
    }
    idp_.refreshMode = 'ok';
    expect((await me(s.sid!.value)).statusCode).toBe(200);
  });

  it('iki API kopyası aynı anda yenilemeye girince IdP yalnız bir yenileme görür (döndürülen refresh token tekrar kullanılmaz, oturum düşmez)', async () => {
    const email = `bff.${randomUUID().slice(0, 6)}@example.test`;
    await invite(email);
    idp_.rotate = true; idp_.delayMs = 150; idp_.accessTtl = 30;
    const s = await signIn(email);
    idp_.accessTtl = 300;
    const before = idp_.refreshes;
    const both = await Promise.all([
      me(s.sid!.value), replica.inject({ method: 'GET', url: '/api/v1/me', headers: { cookie: `sp_sid=${s.sid!.value}` } }),
      me(s.sid!.value), replica.inject({ method: 'GET', url: '/api/v1/me', headers: { cookie: `sp_sid=${s.sid!.value}` } }),
    ]);
    idp_.rotate = false; idp_.delayMs = 0;
    expect(both.map((r) => r.statusCode)).toEqual([200, 200, 200, 200]);
    expect(idp_.refreshes - before).toBe(1);
    expect(idp_.familyRevoked.has(s.sub)).toBe(false);
    expect((await me(s.sid!.value)).statusCode).toBe(200);
  });

  it('kurumsal sunucu, aynı veritabanındaki dev oturumunu kabul etmez (mod eşleşmeli)', async () => {
    const sid = randomUUID().replace(/-/g, '');
    await owner.query(`INSERT INTO web_sessions (id_hash, user_subject, mode, tokens, expires_at) VALUES ($1, $2, 'dev', NULL, now() + interval '1 hour')`,
      [createHash('sha256').update(sid).digest(), `dev|baska.kopya.${randomUUID().slice(0, 6)}@example.test`]);
    expect((await me(sid)).json().error.code).toBe('unauthenticated');
  });

  it('çıkış: oturum silinir, yenileme token\'ı IdP\'de iptal edilir, IdP oturum kapatma adresi id_token_hint ile döner', async () => {
    const email = `bff.${randomUUID().slice(0, 6)}@example.test`;
    await invite(email);
    const s = await signIn(email);
    const out = await app.inject({ method: 'POST', url: '/api/v1/auth/logout', headers: { cookie: `sp_sid=${s.sid!.value}`, ...csrf } });
    const end = new URL(out.json().endSessionUrl);
    expect(`${end.origin}${end.pathname}`).toBe(`${issuer}/logout`);
    expect(end.searchParams.get('post_logout_redirect_uri')).toBe(`${WEB}/`);
    expect(end.searchParams.get('id_token_hint')).toBeTruthy();
    expect(idp_.revoked).toContain(`rt-${s.sub}`);
    expect((await me(s.sid!.value)).statusCode).toBe(401);
  });
});
