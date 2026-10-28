import { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { api, ApiError } from '../lib/api.ts';
import { useResource } from '../lib/useApi.ts';
import { Icon } from './icons.tsx';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

/**
 * Kişisel kayıtlı görünüm (04: kaydedilen görünüm). Görünüm = sayfanın URL süzgeç ve kolon parametreleri; yalnız sahibi görür.
 * Uygulamak URL'yi değiştirir; sayfa süzgeçleri URL'den okur (paylaşılabilir bağlantı da aynı sonucu verir, yetki yine sunucuda).
 */
export function SavedViews({ page }: { page: 'projects' | 'invoices' | 'purchase_orders' | 'tasks' | 'suppliers' | 'contracts' }) {
  const [params, setParams] = useSearchParams();
  const r = useResource<{ items: { id: string; name: string; params: Record<string, string> }[] }>(`/api/v1/saved-views?page=${page}`);
  const [naming, setNaming] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const current = Object.fromEntries([...params.entries()].filter(([k]) => k !== 'gorunum'));
  const same = (p: Record<string, string>) => JSON.stringify(Object.entries(p).sort()) === JSON.stringify(Object.entries(current).sort());
  const save = async () => {
    setErr(null);
    try { await api('/api/v1/saved-views', { method: 'POST', json: { page, name: naming, params: current } }); setNaming(null); await r.reload(); }
    catch (e) { setErr((e as ApiError).message); }
  };
  return (
    <div className="mb-3 flex flex-wrap items-center gap-2" role="group" aria-label="Kayıtlı görünümler">
      {r.data?.items.map((v) => (
        <span key={v.id} className={cn('inline-flex items-center rounded-md border text-sm', same(v.params) ? 'border-ink bg-ink text-primary-foreground' : 'border-border bg-surface text-ink')}>
          <button type="button" className="px-2.5 py-1 font-semibold" aria-pressed={same(v.params)} onClick={() => setParams(new URLSearchParams(v.params), { replace: true })}>{v.name}</button>
          <button type="button" className="px-1.5 py-1 opacity-70 hover:opacity-100" aria-label={`${v.name} görünümünü sil`}
            onClick={() => void api(`/api/v1/saved-views/${v.id}`, { method: 'DELETE' }).then(r.reload)}><Icon name="close" size={14} /></button>
        </span>
      ))}
      {naming === null ? (
        <Button type="button" size="sm" variant="ghost" onClick={() => setNaming('')} disabled={!Object.keys(current).length}
          title={Object.keys(current).length ? undefined : 'Önce süzgeç veya kolon seçin'}>Görünümü kaydet</Button>
      ) : (
        <form className="flex items-center gap-2" onSubmit={(e) => { e.preventDefault(); void save(); }}>
          <label htmlFor={`view-name-${page}`} className="sr-only">Görünüm adı</label>
          <input id={`view-name-${page}`} className="input h-8 w-44" maxLength={60} required autoFocus placeholder="Görünüm adı" value={naming} onChange={(e) => setNaming(e.target.value)} />
          <Button type="submit" size="sm" disabled={!naming.trim()}>Kaydet</Button>
          <Button type="button" size="sm" variant="ghost" onClick={() => { setNaming(null); setErr(null); }}>Vazgeç</Button>
        </form>
      )}
      {err && <span role="alert" className="text-sm text-danger">{err}</span>}
    </div>
  );
}
