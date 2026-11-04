import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { RateLimiter, rateClass } from '../src/rateLimit.ts';
import { makeHarness } from './harness.ts';

// Faz 7 P0: istek sınırlama (ASVS V11/V13). Küçük sınırlarla gerçek uygulamaya karşı.
let h: Awaited<ReturnType<typeof makeHarness>>;
beforeAll(async () => { h = await makeHarness({ trustProxy: ['127.0.0.1'], rateLimit: { enabled: true, perMinute: 5, heavyPerMinute: 2, authPerMinute: 4 } }); });
afterAll(async () => { await h.close(); });

const get = (url: string, headers: Record<string, string>) => h.app.inject({ method: 'GET', url, headers });

describe('İstek sınırlama', () => {
  it('oturum sınırı aşılınca 429 + Retry-After; aynı adresteki başka oturum etkilenmez', async () => {
    const xff = { 'x-forwarded-for': '203.0.113.10' };
    const statuses: number[] = [];
    for (let i = 0; i < 6; i++) statuses.push((await h.call('buyer', 'GET', '/api/v1/me', { headers: xff })).status);
    expect(statuses).toEqual([200, 200, 200, 200, 200, 429]);
    const last = await h.call('buyer', 'GET', '/api/v1/me', { headers: xff });
    expect(last.body.error.code).toBe('rate_limited');
    expect(Number(last.headers['retry-after'])).toBeGreaterThan(0);
    for (let i = 0; i < 5; i++) expect((await h.call('finance', 'GET', '/api/v1/me', { headers: xff })).status).toBe(200);
  });

  it('sınıf rota kalıbından belirlenir: yüzde kodlamalı yol pahalı ucun sınırını atlatamaz', async () => {
    const xff = { 'x-forwarded-for': '203.0.113.21' };
    const codes = [];
    for (let i = 0; i < 3; i++) codes.push((await h.call('finance', 'GET', '/api/v1/reports/summar%79?from=2026-01-01&to=2026-01-31', { headers: xff })).status);
    expect(codes).toEqual([200, 200, 429]);
  });

  it('pahalı uçların sınırı ayrıdır ve daha dardır', async () => {
    const xff = { 'x-forwarded-for': '203.0.113.20' };
    const url = '/api/v1/reports/summary?from=2026-01-01&to=2026-01-31';
    const codes = [];
    for (let i = 0; i < 3; i++) codes.push((await h.call('auditor', 'GET', url, { headers: xff })).status);
    expect(codes).toEqual([200, 200, 429]);
    expect((await h.call('auditor', 'GET', '/api/v1/me', { headers: xff })).status).toBe(200);
  });

  it('başarısız kimlik doğrulaması adres başına sınırlı; sahte X-Forwarded-For okunmaz; geçerli token hiç kilitlenmez', async () => {
    const ip = '203.0.113.30';
    const codes: number[] = [];
    for (let i = 0; i < 6; i++) {
      // Saldırgan her istekte yeni sahte token ve sol tarafa farklı adres yazar; yalnız vekilin eklediği en sağdaki okunur.
      const r = await get('/api/v1/me', { authorization: `Bearer sahte-${i}`, 'x-forwarded-for': `198.51.100.${i}, ${ip}` });
      codes.push(r.statusCode);
    }
    expect(codes).toEqual([401, 401, 401, 401, 429, 429]);
    expect((await get('/api/v1/me', { 'x-forwarded-for': ip })).statusCode).toBe(429); // tokensız da
    // Aynı adresten (NAT) geçerli token'lı kullanıcılar etkilenmez — daha önce hiç istek yapmamış olsalar da.
    expect((await h.call('legal', 'GET', '/api/v1/me', { headers: { 'x-forwarded-for': ip } })).status).toBe(200);
    expect((await h.call('security', 'GET', '/api/v1/me', { headers: { 'x-forwarded-for': ip } })).status).toBe(200);
    // Başka adres etkilenmez.
    expect((await get('/api/v1/me', { authorization: 'Bearer sahte-x', 'x-forwarded-for': '203.0.113.31' })).statusCode).toBe(401);
  });

  it('rastgele oturum çerezleriyle deneme: adres kovası boşalınca çerezli istek oturum aranmadan 429 alır; geçerli çerez kullanıcısı da Bearer kullanıcısı da etkilenmez', async () => {
    const ip = '203.0.113.40';
    const codes: number[] = [];
    for (let i = 0; i < 6; i++) codes.push((await get('/api/v1/me', { cookie: `sp_sid=uydurma-${i}`, 'x-forwarded-for': ip })).statusCode);
    expect(codes).toEqual([401, 401, 401, 401, 429, 429]);
    // Kova boşken bile oturum tablosuna gidilmediğini doğrulamak için: geçersiz çerezle POST da CSRF'ten önce 429.
    expect((await h.app.inject({ method: 'POST', url: '/api/v1/saved-views', headers: { cookie: 'sp_sid=yeni', 'x-forwarded-for': ip }, payload: {} })).statusCode).toBe(429);
    expect((await h.call('legal', 'GET', '/api/v1/me', { headers: { 'x-forwarded-for': ip } })).status).toBe(200);
  });

  it('aynı NAT adresinde, kova boşken bile yakın zamanda doğrulanmış çerezli oturum kilitlenmez', async () => {
    const ip = '203.0.113.41';
    const login = await h.app.inject({ method: 'POST', url: '/api/v1/dev/session', headers: { 'x-sp-csrf': '1', 'x-forwarded-for': '203.0.113.99' },
      payload: { email: h.world.users.legal.email } });
    const sid = String([login.headers['set-cookie']].flat()[0]).split(';')[0]!;
    expect((await get('/api/v1/me', { cookie: sid, 'x-forwarded-for': ip })).statusCode).toBe(200);
    for (let i = 0; i < 6; i++) await get('/api/v1/me', { cookie: `sp_sid=uydurma2-${i}`, 'x-forwarded-for': ip });
    expect((await get('/api/v1/me', { cookie: 'sp_sid=uydurma2-x', 'x-forwarded-for': ip })).statusCode).toBe(429);
    expect((await get('/api/v1/me', { cookie: sid, 'x-forwarded-for': ip })).statusCode).toBe(200);
  });

  it('geliştirme girişi adres başına sınırlı; oturum yapılandırması ve sağlık kontrolü sınırsız', async () => {
    expect(rateClass('POST', '/api/v1/dev/token')).toBe('auth');
    expect(rateClass('GET', '/api/v1/auth/config')).toBe('default');
    expect(rateClass('POST', '/api/v1/documents')).toBe('heavy');
    expect(rateClass('GET', '/api/v1/documents')).toBe('default');
    expect(rateClass('GET', '/api/v1/evaluations/:id/report.xlsx')).toBe('heavy');
    const codes = [];
    for (let i = 0; i < 5; i++) codes.push((await h.app.inject({ method: 'POST', url: '/api/v1/dev/token', payload: { email: 'yok@example.test' }, headers: { 'x-forwarded-for': '203.0.113.40' } })).statusCode);
    expect(codes).toEqual([404, 404, 404, 404, 429]);
    for (let i = 0; i < 20; i++) expect((await get('/api/v1/auth/config', { 'x-forwarded-for': '203.0.113.40' })).statusCode).toBe(200);
    for (let i = 0; i < 20; i++) expect((await get('/health', { 'x-forwarded-for': '203.0.113.40' })).statusCode).toBe(200);
  });
});

describe('Token kovası', () => {
  it('dakikalık hızla dolar; bekleme süresini doğru söyler', () => {
    let t = 0;
    const rl = new RateLimiter({ enabled: true, perMinute: 60, heavyPerMinute: 1, authPerMinute: 1 }, () => t);
    for (let i = 0; i < 60; i++) expect(rl.check('default', '10.0.0.1', 'a')).toBeNull();
    expect(rl.check('default', '10.0.0.1', 'a')).toBe(1); // 60/dk = 1 sn'de bir jeton
    expect(rl.check('default', '10.0.0.1', 'b')).toBeNull();
    t += 1000;
    expect(rl.check('default', '10.0.0.1', 'a')).toBeNull();
    expect(rl.check('default', '10.0.0.1', 'a')).toBe(1);
    expect(rl.authFailure('10.0.0.9')).toBeNull();
    expect(rl.authFailure('10.0.0.9')).toBe(60);
    expect(new RateLimiter({ enabled: false, perMinute: 1, heavyPerMinute: 1, authPerMinute: 1 }).check('heavy', 'x', null)).toBeNull();
  });
});
