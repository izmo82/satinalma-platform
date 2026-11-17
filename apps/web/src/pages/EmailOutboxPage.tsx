// v2 Faz 5 (D110, R7): Yönetim > E-posta kutusu. Bütün giden e-posta satırları; kanal yoksa üst bant iletilerin gönderilmediğini söyler.
// Satır değiştirme ya da silme yok. Üretimde belirteçli bağlantı sunucuda maskelenir (`#token=••••`).
import { useState } from 'react';
import { useResource } from '../lib/useApi.ts';
import { fmtDateTime } from '../lib/format.ts';
import { Banner, Empty, ErrorState, FilterChip, Loading, PageHeader, Tag } from '../ui/kit.tsx';
import { Icon } from '../ui/icons.tsx';
import { Button } from '@/components/ui/button';
import { emailTag, RELATED_LABEL } from '../lib/supplierV2.tsx';
import { cn } from '@/lib/utils';

interface Outbox {
  channel: { kind: 'none' | 'graph'; sender: string | null; label: string };
  total: number; limit: number; offset: number;
  items: { id: string; toEmail: string | null; subject: string; body: string; relatedType: string | null; status: string; statusLabel: string; createdAt: string; sentAt: string | null; error: string | null }[];
}
const FILTERS = [['', 'Tümü'], ['NOT_CONFIGURED', 'Gönderilmedi'], ['QUEUED', 'Kuyrukta'], ['SENT', 'Gönderildi'], ['FAILED', 'Gönderilemedi']] as const;
const PAGE = 50;

export function EmailOutboxPage() {
  const [status, setStatus] = useState('');
  const [offset, setOffset] = useState(0);
  const [open, setOpen] = useState<string | null>(null);
  const q = new URLSearchParams({ limit: String(PAGE), offset: String(offset) });
  if (status) q.set('status', status);
  const r = useResource<Outbox>(`/api/v1/admin/email-outbox?${q}`);
  const d = r.data;
  return (
    <div className="page">
      <PageHeader title="E-posta kutusu">Sistemin yazdığı bütün e-postalar (başvuru doğrulama, karar, teklif daveti, belge hatırlatması, sözleşme hatırlatıcısı). Satırlar değiştirilmez ve silinmez.</PageHeader>
      {d && (d.channel.kind === 'none'
        ? <Banner tone="warn" title={d.channel.label}>E-posta kanalı açılınca eski "gönderilmedi" satırları kendiliğinden gönderilmez.</Banner>
        : <Banner tone="info" icon="check" title={d.channel.label}>Gönderim Microsoft Graph üzerinden yapılır; başarısız deneme üç kez yinelenir.</Banner>)}
      <div role="group" aria-label="Durum süzgeci" className="mb-3 flex flex-wrap gap-2">
        {FILTERS.map(([v, l]) => <FilterChip key={v} pressed={status === v} onClick={() => { setStatus(v); setOffset(0); setOpen(null); }}>{l}</FilterChip>)}
      </div>
      {r.loading && !d ? <Loading /> : r.error ? <ErrorState error={r.error} onRetry={r.reload} /> : !d?.items.length ? (
        <div className="rounded-md border border-border bg-surface"><Empty icon="inbox" title="Bu süzgeçte e-posta yok" /></div>
      ) : <>
        <ul className="grid rounded-md border border-border bg-surface" aria-label="E-postalar">
          {d.items.map((m) => {
            const expanded = open === m.id;
            return (
              <li key={m.id} className="border-b border-border last:border-0">
                <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 px-4 py-2.5">
                  <div className="min-w-[220px] flex-1">
                    <span className="block font-semibold" style={{ overflowWrap: 'anywhere' }}>{m.subject}</span>
                    <span className="block text-sm text-ink-muted" style={{ overflowWrap: 'anywhere' }}>{m.toEmail ?? 'Alıcı yok'} · {m.relatedType ? RELATED_LABEL[m.relatedType] ?? 'Diğer bildirim' : 'Diğer bildirim'}</span>
                  </div>
                  <Tag label={emailTag(m.status, m.statusLabel)} />
                  <span className="tabular text-sm text-ink-subtle">{fmtDateTime(m.createdAt)}{m.sentAt ? ` · gönderim ${fmtDateTime(m.sentAt)}` : ''}</span>
                  <Button size="sm" variant="ghost" aria-expanded={expanded} aria-controls={`body-${m.id}`} onClick={() => setOpen(expanded ? null : m.id)}>
                    <Icon name="chevron" className={cn('transition-transform', expanded && 'rotate-90')} />{expanded ? 'Gövdeyi gizle' : 'Gövdeyi göster'}</Button>
                </div>
                {m.error && <p className="px-4 pb-2 text-sm text-danger">Hata kodu: <span className="mono">{m.error}</span></p>}
                {expanded && <pre id={`body-${m.id}`} className="mx-4 mb-3 whitespace-pre-wrap break-words rounded-md bg-sunken p-3 text-sm" style={{ fontFamily: 'inherit' }}>{m.body}</pre>}
              </li>
            );
          })}
        </ul>
        <div className="mt-3 flex flex-wrap items-center gap-3 text-sm">
          <span className="tabular text-ink-muted">{d.offset + 1}–{d.offset + d.items.length} / {d.total}</span>
          <Button size="sm" variant="outline" disabled={d.offset === 0} onClick={() => setOffset(Math.max(0, d.offset - PAGE))}>Önceki</Button>
          <Button size="sm" variant="outline" disabled={d.offset + d.items.length >= d.total} onClick={() => setOffset(d.offset + PAGE)}>Sonraki</Button>
        </div>
      </>}
    </div>
  );
}
