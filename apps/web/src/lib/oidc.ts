// Kurumsal giriş sunucu tarafında (BFF, D78): PKCE, state/nonce ve token'lar API'de kalır; tarayıcı yalnız HttpOnly oturum
// çerezi taşır. IdP yönlendirme adresi değişmedi (`/auth/callback`): bu sayfa kodu API'ye iletir, API token'a çevirir.
import { api } from './api.ts';

export type AuthConfig =
  | { mode: 'dev' }
  | { mode: 'oidc'; issuer: string; clientId: string; scope: string; resource: string | null; authorizationEndpoint: string; tokenEndpoint: string; endSessionEndpoint: string | null };

const CALLBACK_PATH = '/auth/callback';

let cached: Promise<AuthConfig> | null = null;
export function loadAuthConfig(): Promise<AuthConfig> {
  cached ??= fetch('/api/v1/auth/config').then(async (r) => {
    if (!r.ok) throw new Error((await r.json().catch(() => null))?.error?.message ?? 'Oturum yapılandırması alınamadı.');
    return r.json() as Promise<AuthConfig>;
  }).catch((e) => { cached = null; throw e; });
  return cached;
}

/** Sunucu PKCE akışını başlatır ve tarayıcıyı IdP'ye yönlendirir. */
export function beginLogin(returnTo: string) {
  location.assign(`/api/v1/auth/login?returnTo=${encodeURIComponent(returnTo)}`);
}

export const isCallback = () => location.pathname === CALLBACK_PATH;

/**
 * IdP dönüşü: kod ve state sunucuya gider; sunucu doğrular, oturum çerezini yazar ve dönülecek yolu verir.
 * Kod tek kullanımlıktır: aynı sayfada ikinci çağrı (ör. StrictMode'da çift efekt) aynı sonucu paylaşır.
 */
let completing: Promise<string> | null = null;
export function completeLogin(): Promise<string> {
  completing ??= exchange();
  return completing;
}
async function exchange(): Promise<string> {
  const params = new URLSearchParams(location.search);
  if (params.get('error')) throw new Error(params.get('error_description') ?? 'Kimlik sağlayıcısı girişi reddetti.');
  const code = params.get('code');
  const state = params.get('state');
  if (!code || !state) throw new Error('Oturum isteği eşleşmedi. Lütfen yeniden giriş yapın.');
  // Kod adres çubuğunda ve geçmişte kalmasın.
  history.replaceState(null, '', CALLBACK_PATH);
  const r = await api<{ returnTo: string }>('/api/v1/auth/session', { method: 'POST', json: { code, state } });
  return r.data.returnTo;
}

/**
 * Çıkış: sunucu oturumu siler ve yenileme token'ını iptal eder; IdP oturumu da varsa onu kapatmaya yönlenir.
 * Çerez HttpOnly olduğu için tarayıcı oturumu kendisi silemez: istek başarısızsa hata fırlatılır, ekran "çıkıldı" göstermez.
 */
export async function endSession() {
  const r = await api<{ endSessionUrl: string | null }>('/api/v1/auth/logout', { method: 'POST' });
  if (r.data.endSessionUrl) location.assign(r.data.endSessionUrl);
}
