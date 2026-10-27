// Standart OIDC yetkilendirme kodu + PKCE (S256). Herhangi bir uyumlu IdP ile çalışır; IdP adresleri çalışma anında
// API'nin /auth/config ucundan gelir, böylece aynı web imajı bulutta da kurum içinde de kullanılır.
import { session } from './api.ts';

export type AuthConfig =
  | { mode: 'dev' }
  | { mode: 'oidc'; issuer: string; clientId: string; scope: string; resource: string | null; authorizationEndpoint: string; tokenEndpoint: string; endSessionEndpoint: string | null };

const FLOW_KEY = 'sp.oidc.flow';
const REFRESH_KEY = 'sp.oidc.refresh';
const ID_TOKEN_KEY = 'sp.oidc.id';
const CALLBACK_PATH = '/auth/callback';

let cached: Promise<AuthConfig> | null = null;
export function loadAuthConfig(): Promise<AuthConfig> {
  cached ??= fetch('/api/v1/auth/config').then(async (r) => {
    if (!r.ok) throw new Error((await r.json().catch(() => null))?.error?.message ?? 'Oturum yapılandırması alınamadı.');
    return r.json() as Promise<AuthConfig>;
  }).catch((e) => { cached = null; throw e; });
  return cached;
}

const store = {
  get(k: string) { try { return sessionStorage.getItem(k); } catch { return null; } },
  set(k: string, v: string | null) { try { v ? sessionStorage.setItem(k, v) : sessionStorage.removeItem(k); } catch { /* yok */ } },
};

function b64url(bytes: Uint8Array) {
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
const random = (n = 32) => b64url(crypto.getRandomValues(new Uint8Array(n)));
const redirectUri = () => `${location.origin}${CALLBACK_PATH}`;

export async function beginLogin(cfg: Extract<AuthConfig, { mode: 'oidc' }>, returnTo: string) {
  const verifier = random(48);
  const challenge = b64url(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))));
  const state = random();
  const nonce = random();
  store.set(FLOW_KEY, JSON.stringify({ verifier, state, nonce, returnTo }));
  const u = new URL(cfg.authorizationEndpoint);
  u.search = new URLSearchParams({
    response_type: 'code', client_id: cfg.clientId, redirect_uri: redirectUri(), scope: cfg.scope,
    state, nonce, code_challenge: challenge, code_challenge_method: 'S256',
    ...(cfg.resource ? { resource: cfg.resource } : {}),
  }).toString();
  location.assign(u.toString());
}

export const isCallback = () => location.pathname === CALLBACK_PATH;

/** Geri dönüşte kodu token'a çevirir. Başarıda dönülecek yolu verir. */
export async function completeLogin(): Promise<string> {
  const cfg = await loadAuthConfig();
  if (cfg.mode !== 'oidc') throw new Error('Kurumsal oturum etkin değil.');
  const params = new URLSearchParams(location.search);
  const flow = JSON.parse(store.get(FLOW_KEY) ?? 'null') as { verifier: string; state: string; returnTo: string } | null;
  store.set(FLOW_KEY, null);
  if (params.get('error')) throw new Error(params.get('error_description') ?? 'Kimlik sağlayıcısı girişi reddetti.');
  if (!flow || params.get('state') !== flow.state) throw new Error('Oturum isteği eşleşmedi. Lütfen yeniden giriş yapın.');
  const tokens = await tokenRequest(cfg, {
    grant_type: 'authorization_code', code: params.get('code') ?? '', redirect_uri: redirectUri(), code_verifier: flow.verifier,
  });
  accept(tokens);
  return flow.returnTo.startsWith('/') && !flow.returnTo.startsWith('//') ? flow.returnTo : '/';
}

/** Erişim token'ının süresi dolduğunda bir kez sessiz yenileme; başarısızsa yeniden giriş gerekir. */
export async function refreshSession(): Promise<boolean> {
  const rt = store.get(REFRESH_KEY);
  if (!rt) return false;
  try {
    const cfg = await loadAuthConfig();
    if (cfg.mode !== 'oidc') return false;
    accept(await tokenRequest(cfg, { grant_type: 'refresh_token', refresh_token: rt }));
    return true;
  } catch {
    store.set(REFRESH_KEY, null);
    return false;
  }
}

export async function endSession() {
  const idToken = store.get(ID_TOKEN_KEY);
  store.set(REFRESH_KEY, null); store.set(ID_TOKEN_KEY, null);
  const cfg = await loadAuthConfig().catch(() => null);
  if (cfg?.mode === 'oidc' && cfg.endSessionEndpoint) {
    const u = new URL(cfg.endSessionEndpoint);
    u.search = new URLSearchParams({ client_id: cfg.clientId, post_logout_redirect_uri: location.origin + '/',
      ...(idToken ? { id_token_hint: idToken } : {}) }).toString();
    location.assign(u.toString());
  }
}

async function tokenRequest(cfg: Extract<AuthConfig, { mode: 'oidc' }>, body: Record<string, string>) {
  const r = await fetch(cfg.tokenEndpoint, {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: cfg.clientId, ...(cfg.resource ? { resource: cfg.resource } : {}), ...body }),
  });
  if (!r.ok) throw new Error('Kimlik sağlayıcısı token vermedi.');
  return r.json() as Promise<{ access_token: string; refresh_token?: string; id_token?: string }>;
}

function accept(t: { access_token: string; refresh_token?: string; id_token?: string }) {
  session.token = t.access_token;
  if (t.refresh_token) store.set(REFRESH_KEY, t.refresh_token);
  if (t.id_token) store.set(ID_TOKEN_KEY, t.id_token);
}
