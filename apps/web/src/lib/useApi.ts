import { useCallback, useEffect, useState } from 'react';
import { api } from './api.ts';

/** GET kaynağı: loading / error / data ayrı; yeniden yükleme. Sahte ilerleme yok. */
export function useResource<T>(path: string | null) {
  const [state, set] = useState<{ data: T | null; etag: string | null; error: unknown; loading: boolean }>({ data: null, etag: null, error: null, loading: !!path });
  const load = useCallback(async () => {
    if (!path) return;
    set((s) => ({ ...s, loading: true, error: null }));
    try {
      const r = await api<T>(path);
      set({ data: r.data, etag: r.etag, error: null, loading: false });
    } catch (error) {
      set((s) => ({ ...s, error, loading: false }));
    }
  }, [path]);
  useEffect(() => { void load(); }, [load]);
  return { ...state, reload: load };
}
