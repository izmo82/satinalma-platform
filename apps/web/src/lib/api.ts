// API istemcisi. Oturum HttpOnly çerezdedir (BFF, D78): tarayıcı kodu token görmez ve saklamaz. Kiracı seçimi başlıkla
// bildirilir (gizli değil); yetki kararı sunucudadır.

export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string, public details?: any) { super(message); }
}

const TENANT_KEY = 'sp.tenant';
// Önceki sürümün tarayıcıda bıraktığı token'lar silinir (BFF'ye geçişte artık kullanılmaz).
try { for (const k of ['sp.token', 'sp.oidc.refresh', 'sp.oidc.id', 'sp.oidc.flow']) sessionStorage.removeItem(k); } catch { /* yok */ }

/**
 * Oturum çerezi sekmeler arasında ortaktır. Sunucu her yanıtta oturumun kullanıcısını (`X-SP-User`) bildirir; bu sekmenin
 * ekranındaki kullanıcıdan farklıysa (başka sekmede çıkış + başka kullanıcıyla giriş) ekran eski kullanıcıyı göstermeye devam
 * etmesin diye `sp:identity-changed` yayınlanır ve uygulama baştan kurulur.
 */
let expectedUser: string | null = null;
export function setExpectedUser(id: string | null) { expectedUser = id; }
function checkIdentity(res: Response) {
  const u = res.headers.get('X-SP-User');
  if (expectedUser && u && u !== expectedUser) window.dispatchEvent(new Event('sp:identity-changed'));
}

export const session = {
  get tenant() { try { return sessionStorage.getItem(TENANT_KEY); } catch { return null; } },
  set tenant(v: string | null) { try { v ? sessionStorage.setItem(TENANT_KEY, v) : sessionStorage.removeItem(TENANT_KEY); } catch { /* yok */ } },
};

/** Her istekte: çerez (aynı köken), CSRF başlığı ve seçili kiracı. */
function baseHeaders(init?: HeadersInit) {
  const headers = new Headers(init);
  headers.set('X-SP-CSRF', '1');
  if (expectedUser) headers.set('X-SP-Expect-User', expectedUser);
  if (session.tenant) headers.set('X-Tenant-Id', session.tenant);
  return headers;
}

export interface Res<T> { data: T; etag: string | null }

export async function api<T = any>(path: string, init: RequestInit & { json?: unknown; ifMatch?: string | null } = {}): Promise<Res<T>> {
  const headers = baseHeaders(init.headers);
  if (init.ifMatch) headers.set('If-Match', init.ifMatch);
  let body = init.body;
  if (init.json !== undefined) { headers.set('Content-Type', 'application/json'); body = JSON.stringify(init.json); }
  let res: Response;
  try {
    res = await fetch(path, { ...init, headers, body, credentials: 'same-origin' });
  } catch {
    throw new ApiError(0, 'network', 'Sunucuya ulaşılamadı. Bağlantınızı kontrol edin; işlem kaydedilmedi.');
  }
  // Süresi dolan oturumu sunucu yeniler; yenilenemediyse 401 döner ve giriş ekranı açılır.
  if (res.status === 401) window.dispatchEvent(new Event('sp:unauthenticated'));
  checkIdentity(res);
  const etag = res.headers.get('ETag');
  if (res.status === 204) {
    if ((init.method ?? 'GET').toUpperCase() !== 'GET') window.dispatchEvent(new Event('sp:tasks-changed'));
    return { data: undefined as T, etag };
  }
  const text = await res.text();
  const parsed = text ? safeParse(text) : null;
  if (!res.ok) {
    const e = parsed?.error;
    if (e?.code === 'identity_changed') window.dispatchEvent(new Event('sp:identity-changed'));
    throw new ApiError(res.status, e?.code ?? 'error', e?.message ?? `İstek başarısız (${res.status}).`, e?.details);
  }
  // Persona K4: başarılı her yazma isteğinden sonra menü sayaçları tazelenir (onay, red, yeniden gönderim vb. iş sayısını değiştirir).
  if ((init.method ?? 'GET').toUpperCase() !== 'GET') window.dispatchEvent(new Event('sp:tasks-changed'));
  return { data: parsed as T, etag };
}

export async function apiBlob(path: string): Promise<Blob> {
  const res = await fetch(path, { headers: baseHeaders(), credentials: 'same-origin' });
  if (res.status === 401) window.dispatchEvent(new Event('sp:unauthenticated'));
  checkIdentity(res);
  if (!res.ok) {
    const parsed = safeParse(await res.text());
    if (parsed?.error?.code === 'identity_changed') window.dispatchEvent(new Event('sp:identity-changed'));
    throw new ApiError(res.status, parsed?.error?.code ?? 'error', parsed?.error?.message ?? 'Belge açılamadı.');
  }
  return res.blob();
}

function safeParse(t: string) { try { return JSON.parse(t); } catch { return null; } }
