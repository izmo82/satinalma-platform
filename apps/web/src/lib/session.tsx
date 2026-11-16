import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import { api, ApiError, session, setExpectedUser } from './api.ts';
import { endSession } from './oidc.ts';

export interface Me {
  user: { id: string; email: string; displayName: string };
  memberships: { tenantId: string; tenantName: string; roles: string[] }[];
  activeTenantId: string | null;
  roles: string[];
  /** Tedarikçi portalı kullanıcısı: yalnız davet edildiği teklif turlarını görür. */
  supplierPortal: boolean;
  companies: { id: string; name: string; country: string; default_currency: string }[];
  /** v2 (D93): aktif üyeliğin departmanları; allDepartments rolden türer (Yönetici, Satınalma, Denetçi). */
  departments?: { id: string; name: string }[];
  allDepartments?: boolean;
}

interface SessionCtx {
  me: Me | null; loading: boolean;
  /** Son oturum açma denemesinin kullanıcıya gösterilecek nedeni (ör. davet yok). */
  authError: string | null;
  /** Çıkış sunucuda tamamlanamadıysa nedeni (oturum açık kalır; kullanıcı tekrar dener). */
  logoutError: string | null;
  /** Giriş ekranında gösterilecek bilgi (ör. oturum süresi doldu). */
  notice: string | null;
  refresh: () => Promise<void>; switchTenant: (id: string) => Promise<void>; logout: () => void;
}
const Ctx = createContext<SessionCtx | null>(null);

export function SessionProvider({ children }: { children: ReactNode }) {
  const [me, setMe] = useState<Me | null>(null);
  // Oturum HttpOnly çerezde; tarayıcı varlığını bilemez, bu yüzden açılışta her zaman /me sorulur.
  const [loading, setLoading] = useState(true);
  const [authError, setAuthError] = useState<string | null>(null);
  const [logoutError, setLogoutError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      let r = (await api<Me>('/api/v1/me')).data;
      if (!r.activeTenantId && r.memberships.length > 0) {
        session.tenant = r.memberships[0]!.tenantId;
        r = (await api<Me>('/api/v1/me')).data;
      }
      setExpectedUser(r.user.id); setMe(r); setAuthError(null); setNotice(null);
    } catch (e) {
      session.tenant = null; setExpectedUser(null); setMe(null);
      setAuthError(e instanceof ApiError && e.status !== 401 ? e.message : null);
    } finally { setLoading(false); }
  }, []);
  useEffect(() => { void refresh(); }, [refresh]);
  // Kullanım sırasında oturum biterse (boşta kalma, IdP reddi) giriş ekranına dönülür.
  useEffect(() => {
    const onExpired = () => setMe((cur) => {
      if (cur) setNotice('Oturumunuzun süresi doldu ya da başka bir sekmede çıkış yapıldı. Kaydedilmemiş değişiklikler kaydedilmedi; yeniden giriş yapın.');
      setExpectedUser(null);
      return null;
    });
    // Başka sekmede kullanıcı değişti: eski kullanıcının ekranı ve önbelleği tamamen bırakılır.
    const onChanged = () => { location.assign('/'); };
    if (channel) channel.onmessage = () => { onChanged(); };
    window.addEventListener('sp:unauthenticated', onExpired);
    window.addEventListener('sp:identity-changed', onChanged);
    return () => { window.removeEventListener('sp:unauthenticated', onExpired); window.removeEventListener('sp:identity-changed', onChanged); if (channel) channel.onmessage = null; };
  }, []);
  const switchTenant = useCallback(async (id: string) => { session.tenant = id; await refresh(); }, [refresh]);
  // Çıkışta adres köke döner: sonraki kullanıcı önceki kullanıcının (belki yetkisiz olduğu) sayfasına düşmez.
  // Ekran yalnız sunucu oturumu kapattığında (ya da oturum zaten yoksa, 401) sıfırlanır; aksi halde paylaşılan bilgisayarda
  // sonraki kişi sayfayı yenileyince önceki kullanıcının oturumu açık kalırdı.
  const logout = useCallback(() => {
    setLogoutError(null);
    void endSession().then(() => true, (e: unknown) => {
      if (e instanceof ApiError && e.status === 401) return true;
      setLogoutError(e instanceof ApiError && e.status !== 0 ? e.message : 'Sunucuya ulaşılamadı.');
      return false;
    }).then((ok) => {
      if (!ok) return;
      announceSessionChange();
      // Çıkıştan sonraki giriş, önceki kullanıcının (Geri ile dönülen) sayfasına değil İşlerim'e iner.
      try { sessionStorage.setItem(AFTER_LOGOUT, '1'); } catch { /* yok */ }
      session.tenant = null; setExpectedUser(null); setMe(null); window.history.replaceState(null, '', '/');
      // Yönlendirici replaceState'i duymaz; popstate olmadan sonraki kullanıcı önceki kullanıcının son sayfasında açılır.
      window.dispatchEvent(new PopStateEvent('popstate'));
    });
  }, []);
  return <Ctx.Provider value={{ me, loading, authError, logoutError, notice, refresh, switchTenant, logout }}>{children}</Ctx.Provider>;
}

const AFTER_LOGOUT = 'sp.afterLogout';
/**
 * Sekmeler arası tek kanal nesnesi: gönderen nesne kendi mesajını almaz. Ayrı nesneyle gönderilseydi bu sekme de kendi
 * giriş/çıkış bildirimini alıp kendini yeniden yüklerdi.
 */
const channel: BroadcastChannel | null = (() => { try { return new BroadcastChannel('sp-session'); } catch { return null; } })();
/** Giriş veya çıkış oldu: aynı tarayıcıdaki öteki sekmeler kendini baştan kurar (ortak çerez). */
export function announceSessionChange() {
  try { channel?.postMessage('changed'); } catch { /* desteklenmiyor */ }
}
/** Girişten sonra dönülecek yol: bu sekmede az önce çıkış yapıldıysa İşlerim (önceki kullanıcının sayfası değil). */
export function loginReturnPath(): string {
  let after = false;
  try { after = sessionStorage.getItem(AFTER_LOGOUT) === '1'; sessionStorage.removeItem(AFTER_LOGOUT); } catch { /* yok */ }
  return after ? '/' : location.pathname + location.search;
}

export function useSession() {
  const c = useContext(Ctx);
  if (!c) throw new Error('no session');
  return c;
}
/** Eski rol kodu → v2 rolü (packages/domain/src/roles.ts LEGACY_ROLE_MAP ile aynı; API can() da girdiyi böyle normalize eder). */
const LEGACY_ROLE: Record<string, string> = {
  TENANT_ADMIN: 'ADMIN', PLATFORM_OPS: 'ADMIN',
  BUYER: 'PROCUREMENT', PROCUREMENT_MANAGER: 'PROCUREMENT', MASTER_DATA: 'PROCUREMENT', LEGAL: 'PROCUREMENT', FINANCE: 'PROCUREMENT',
  REQUESTER: 'DEPARTMENT_USER', TECH_EVALUATOR: 'DEPARTMENT_USER', SECURITY: 'DEPARTMENT_USER',
};
export const v2Role = (r: string) => LEGACY_ROLE[r] ?? r;
/** Oturumdaki rol (v2) verilenlerden biri mi? Eski kodla yazılmış denetimler eşlendiği v2 rolüne göre çalışır. */
export const hasRole = (me: Me | null, ...roles: string[]) => {
  if (!me) return false;
  const wanted = new Set(roles.map(v2Role));
  return me.roles.some((r) => wanted.has(v2Role(r)));
};
