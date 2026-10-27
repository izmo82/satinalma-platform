import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import { api, ApiError, session } from './api.ts';
import { endSession } from './oidc.ts';

export interface Me {
  user: { id: string; email: string; displayName: string };
  memberships: { tenantId: string; tenantName: string; roles: string[] }[];
  activeTenantId: string | null;
  roles: string[];
  /** Tedarikçi portalı kullanıcısı: yalnız davet edildiği teklif turlarını görür. */
  supplierPortal: boolean;
  companies: { id: string; name: string; country: string; default_currency: string }[];
}

interface SessionCtx {
  me: Me | null; loading: boolean;
  /** Son oturum açma denemesinin kullanıcıya gösterilecek nedeni (ör. davet yok). */
  authError: string | null;
  refresh: () => Promise<void>; switchTenant: (id: string) => Promise<void>; logout: () => void;
}
const Ctx = createContext<SessionCtx | null>(null);

export function SessionProvider({ children }: { children: ReactNode }) {
  const [me, setMe] = useState<Me | null>(null);
  const [loading, setLoading] = useState(!!session.token);
  const [authError, setAuthError] = useState<string | null>(null);
  const refresh = useCallback(async () => {
    if (!session.token) { setMe(null); setLoading(false); return; }
    setLoading(true);
    try {
      let r = (await api<Me>('/api/v1/me')).data;
      if (!r.activeTenantId && r.memberships.length > 0) {
        session.tenant = r.memberships[0]!.tenantId;
        r = (await api<Me>('/api/v1/me')).data;
      }
      setMe(r); setAuthError(null);
    } catch (e) {
      session.token = null; session.tenant = null; setMe(null);
      setAuthError(e instanceof ApiError && e.status !== 401 ? e.message : null);
    } finally { setLoading(false); }
  }, []);
  useEffect(() => { void refresh(); }, [refresh]);
  const switchTenant = useCallback(async (id: string) => { session.tenant = id; await refresh(); }, [refresh]);
  const logout = useCallback(() => { session.token = null; session.tenant = null; setMe(null); void endSession(); }, []);
  return <Ctx.Provider value={{ me, loading, authError, refresh, switchTenant, logout }}>{children}</Ctx.Provider>;
}

export function useSession() {
  const c = useContext(Ctx);
  if (!c) throw new Error('no session');
  return c;
}
export const hasRole = (me: Me | null, ...roles: string[]) => !!me && me.roles.some((r) => roles.includes(r));
