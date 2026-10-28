import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api } from '../lib/api.ts';
import { useResource } from '../lib/useApi.ts';
import { fmtDateTime } from '../lib/format.ts';
import { entityHref } from '../pages/WorkPage.tsx';
import { Icon } from './icons.tsx';
import { cn } from '@/lib/utils';

/** Üst çubuk araması: sonuç sayfasına gider (yetki ve şirket kapsamı sunucuda uygulanır). */
export function GlobalSearch() {
  const navigate = useNavigate();
  const [q, setQ] = useState('');
  const submit = (e: FormEvent) => { e.preventDefault(); if (q.trim().length >= 2) navigate(`/ara?q=${encodeURIComponent(q.trim())}`); };
  return (
    <form role="search" onSubmit={submit} className="ml-auto flex min-w-0 items-center">
      <label htmlFor="global-search" className="sr-only">Kayıt ara</label>
      <input id="global-search" type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Ara: proje, sözleşme, fatura no, VKN…"
        className="input h-9 w-64 min-w-0 max-[640px]:w-40" />
    </form>
  );
}

interface Notice { id: string; title: string; entityType: string; entityId: string; severity: string; createdAt: string; unread: boolean }

/** Bildirim: rolüne atanmış açık görevlerden son görülmeden sonra gelenler. Metin görev başlığıdır; hassas ayrıntı görevin kendisinde. */
export function NotificationBell() {
  const r = useResource<{ items: Notice[]; unread: number }>('/api/v1/notifications');
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false); };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onDown); document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('mousedown', onDown); document.removeEventListener('keydown', onKey); };
  }, [open]);
  const unread = r.data?.unread ?? 0;
  return (
    <div ref={ref} className="relative">
      <button type="button" aria-expanded={open} aria-controls="notice-panel" onClick={() => { setOpen(!open); if (!open) void r.reload(); }}
        aria-label={unread ? `Bildirimler, ${unread} yeni` : 'Bildirimler'}
        className="relative inline-flex size-9 items-center justify-center rounded-md border border-border bg-surface text-ink hover:bg-sunken">
        <Icon name="bell" />
        {unread > 0 && <span className="tabular absolute -right-1.5 -top-1.5 min-w-5 rounded-full bg-ink px-1 text-center text-xs font-semibold text-primary-foreground">{unread > 99 ? '99+' : unread}</span>}
      </button>
      {open && (
        <div id="notice-panel" className="absolute right-0 z-40 mt-2 w-[360px] max-w-[calc(100vw-2rem)] rounded-md border border-border bg-surface shadow-lg">
          <div className="flex items-center justify-between border-b border-border px-3 py-2">
            <span className="font-semibold text-ink">Bildirimler</span>
            {unread > 0 && <button type="button" className="text-sm text-ink-muted underline" onClick={() => void api('/api/v1/notifications/seen', { method: 'POST' }).then(r.reload)}>Tümünü görüldü say</button>}
          </div>
          {!r.data?.items.length ? <p className="px-3 py-4 text-sm text-ink-muted">Rolünüze atanmış açık iş yok.</p> : (
            <ul className="max-h-96 divide-y divide-border overflow-auto">
              {r.data.items.map((n) => (
                <li key={n.id}>
                  <Link to={entityHref(n)} onClick={() => setOpen(false)} className={cn('block px-3 py-2 text-sm no-underline hover:bg-sunken', n.unread ? 'text-ink' : 'text-ink-muted')}>
                    <span className={cn('block', n.unread && 'font-semibold')}>{n.unread && <span className="sr-only">Yeni: </span>}{n.title}</span>
                    <span className="text-xs text-ink-subtle">{fmtDateTime(n.createdAt)}{n.severity !== 'NORMAL' ? ` · ${n.severity === 'CRITICAL' ? 'kritik' : 'yüksek öncelik'}` : ''}</span>
                  </Link>
                </li>
              ))}
            </ul>
          )}
          <div className="border-t border-border px-3 py-2 text-sm"><Link to="/islerim" onClick={() => setOpen(false)}>Bütün işler</Link></div>
        </div>
      )}
    </div>
  );
}
