// API istemcisi. Kiracı seçimi başlıkla bildirilir; yetki kararı sunucudadır.
import { refreshSession } from './oidc.ts';

export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string, public details?: any) { super(message); }
}

const TOKEN_KEY = 'sp.token';
const TENANT_KEY = 'sp.tenant';

export const session = {
  get token() { try { return sessionStorage.getItem(TOKEN_KEY); } catch { return null; } },
  set token(v: string | null) { try { v ? sessionStorage.setItem(TOKEN_KEY, v) : sessionStorage.removeItem(TOKEN_KEY); } catch { /* yok */ } },
  get tenant() { try { return sessionStorage.getItem(TENANT_KEY); } catch { return null; } },
  set tenant(v: string | null) { try { v ? sessionStorage.setItem(TENANT_KEY, v) : sessionStorage.removeItem(TENANT_KEY); } catch { /* yok */ } },
};

export interface Res<T> { data: T; etag: string | null }

export async function api<T = any>(path: string, init: RequestInit & { json?: unknown; ifMatch?: string | null } = {}, retried = false): Promise<Res<T>> {
  const headers = new Headers(init.headers);
  if (session.token) headers.set('Authorization', `Bearer ${session.token}`);
  if (session.tenant) headers.set('X-Tenant-Id', session.tenant);
  if (init.ifMatch) headers.set('If-Match', init.ifMatch);
  let body = init.body;
  if (init.json !== undefined) { headers.set('Content-Type', 'application/json'); body = JSON.stringify(init.json); }
  let res: Response;
  try {
    res = await fetch(path, { ...init, headers, body });
  } catch {
    throw new ApiError(0, 'network', 'Sunucuya ulaşılamadı. Bağlantınızı kontrol edin; işlem kaydedilmedi.');
  }
  // Süresi dolan kurumsal oturum bir kez sessizce yenilenir; istek aynı gövdeyle tekrarlanır.
  if (res.status === 401 && !retried && session.token && await refreshSession()) return api<T>(path, init, true);
  const etag = res.headers.get('ETag');
  if (res.status === 204) return { data: undefined as T, etag };
  const text = await res.text();
  const parsed = text ? safeParse(text) : null;
  if (!res.ok) {
    const e = parsed?.error;
    throw new ApiError(res.status, e?.code ?? 'error', e?.message ?? `İstek başarısız (${res.status}).`, e?.details);
  }
  return { data: parsed as T, etag };
}

export async function apiBlob(path: string): Promise<Blob> {
  const headers = new Headers();
  if (session.token) headers.set('Authorization', `Bearer ${session.token}`);
  if (session.tenant) headers.set('X-Tenant-Id', session.tenant);
  let res = await fetch(path, { headers });
  if (res.status === 401 && await refreshSession()) {
    headers.set('Authorization', `Bearer ${session.token}`);
    res = await fetch(path, { headers });
  }
  if (!res.ok) {
    const parsed = safeParse(await res.text());
    throw new ApiError(res.status, parsed?.error?.code ?? 'error', parsed?.error?.message ?? 'Belge açılamadı.');
  }
  return res.blob();
}

function safeParse(t: string) { try { return JSON.parse(t); } catch { return null; } }
