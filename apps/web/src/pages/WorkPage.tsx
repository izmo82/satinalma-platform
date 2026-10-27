import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useResource } from '../lib/useApi.ts';
import { fmtDate, relative } from '../lib/format.ts';
import { severityLabel, roleLabel } from '../lib/labels.ts';
import { Empty, ErrorState, Loading, PageHeader, Tag } from '../ui/kit.tsx';
import { Icon } from '../ui/icons.tsx';
import { Button } from '@/components/ui/button';
import { Table, TableBody, TableCaption, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { cn } from '@/lib/utils';

interface Task { id: string; kind: string; entityType: string; entityId: string; title: string; reason: string; nextAction: string;
  assigneeRole: string; severity: string; dueAt: string | null; createdAt: string; refNo: string | null }

export const entityHref = (t: { entityType: string; entityId: string; kind?: string }) =>
  t.entityType === 'supplier' ? `/tedarikciler/${t.entityId}${['assessment_blocker', 'risk_rereview', 'new_business_hold'].includes(t.kind ?? '') ? '?sekme=degerlendirme' : ''}` : t.entityType === 'contract_version' ? `/sozlesmeler/${t.entityId}`
    : t.entityType === 'document_version' ? `/belgeler/${t.entityId}` : t.entityType === 'project' ? `/projeler/${t.entityId}`
    : t.entityType === 'invoice' ? `/faturalar/${t.entityId}`
    : t.entityType === 'incident' ? `/olaylar/${t.entityId}` : t.entityType === 'tenant' ? '/yapay-zeka'
    : t.entityType === 'disposal_batch' ? `/veri-yonetimi/imha/${t.entityId}` : t.entityType === 'tenant_export' ? '/veri-yonetimi?sekme=disa-aktarim' : '/islerim';

const VIEWS = [['mine', 'Benden beklenen'], ['overdue', 'Geciken'], ['all', 'Rolümdeki tüm işler']] as const;

export function WorkPage() {
  const [view, setView] = useState<(typeof VIEWS)[number][0]>('mine');
  const [cursor, setCursor] = useState(0);
  const navigate = useNavigate();
  const r = useResource<{ items: Task[]; counts: Record<string, number> }>(`/api/v1/tasks?view=${view}`);
  const items = r.data?.items ?? [];

  // Sıradaki iş bir tuş uzakta: j/k satır seçer, Enter işi açar. Yazı alanındayken devre dışı.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement;
      if (e.metaKey || e.ctrlKey || e.altKey || el.closest('input, textarea, select, [contenteditable]') || !items.length) return;
      if (e.key === 'j') setCursor((c) => Math.min(c + 1, items.length - 1));
      else if (e.key === 'k') setCursor((c) => Math.max(c - 1, 0));
      else if (e.key === 'Enter' && el === document.body) navigate(entityHref(items[cursor]!));
      else return;
      e.preventDefault();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [items, cursor, navigate]);
  useEffect(() => setCursor(0), [view]);

  return (
    <div className="page">
      <PageHeader title="İşlerim" actions={<Button variant="outline" onClick={() => void r.reload()}><Icon name="refresh" /> Yenile</Button>}>
        Sizden beklenen kararlar, nedenleri ve sonraki adım. Yalnız rolünüze atanmış işler gösterilir.
      </PageHeader>
      <div role="tablist" aria-label="İş görünümü" className="mb-4 flex gap-6 border-b border-border">
        {VIEWS.map(([k, l]) => (
          <button key={k} role="tab" aria-selected={view === k} onClick={() => setView(k)}
            className={cn('-mb-px min-h-10 border-b-2 font-semibold transition-colors duration-150',
              view === k ? 'border-ink text-ink' : 'border-transparent text-ink-muted hover:text-ink')}>
            {l}{r.data?.counts && <span className={cn('tabular ml-1.5', k === 'overdue' && r.data.counts.overdue ? 'text-danger' : 'text-ink-subtle')}>{r.data.counts[k]}</span>}</button>
        ))}
      </div>
      <p className="mb-4 flex flex-wrap items-center gap-x-4 gap-y-2 text-sm text-ink-muted">
        <span>Kanıtın kökeni:</span>
        <Tag label={{ text: 'İnsan kararı', tone: 'human', icon: 'stamp' }} />
        <Tag label={{ text: 'Kural ile doğrulandı', tone: 'ok', icon: 'check' }} />
        <Tag label={{ text: 'Otomatik öneri', tone: 'ai', icon: 'sparkles' }} />
        <span>Bu işler bir insan kararı bekliyor; kararınız mor ıstampa ile kaydedilir.</span>
      </p>
      {r.loading && !r.data ? <Loading /> : r.error ? <ErrorState error={r.error} onRetry={r.reload} /> : !items.length ? (
        <div className="rounded-md border border-border bg-surface"><Empty title={view === 'overdue' ? 'Geciken işiniz yok' : 'Bekleyen işiniz yok'}>Yeni bir belge veya karar geldiğinde burada görünür.</Empty></div>
      ) : (
        <>
          <ul className="hidden divide-y divide-[#ebe6da] rounded-md border border-border bg-surface max-[900px]:block" aria-label="Açık işler">
            {items.map((t) => (
              <li key={t.id} className="grid gap-1.5 p-3">
                <div className="flex items-center justify-between gap-2"><span className="flex items-center gap-2"><Tag label={severityLabel[t.severity]} />{t.refNo && <span className="tabular text-sm text-ink-subtle">{t.refNo}</span>}</span><span className="tabular text-sm"><Due at={t.dueAt} /></span></div>
                <Link className="font-semibold text-ink no-underline hover:underline" to={entityHref(t)}>{t.title}</Link>
                <p className="text-ink-muted">{t.reason}</p>
                <p className="flex gap-1.5"><Icon name="arrow" size={16} className="mt-0.5 shrink-0 text-ink-subtle" />{t.nextAction}</p>
                <Button asChild size="sm" variant="outline" className="justify-self-start"><Link to={entityHref(t)} aria-label={`İşi aç: ${t.title}`}>İşi aç</Link></Button>
              </li>
            ))}
          </ul>
          <div className="max-[900px]:hidden"><Table>
            <TableCaption className="sr-only">Açık işler, öneme ve tarihe göre sıralı</TableCaption>
            <TableHeader><TableRow className="hover:bg-transparent">
              <TableHead scope="col">Kayıt no</TableHead><TableHead scope="col">Önem</TableHead><TableHead scope="col">İş</TableHead><TableHead scope="col">Neden bekliyor</TableHead>
              <TableHead scope="col">Sonraki adım</TableHead><TableHead scope="col" className="max-[1600px]:hidden">Sorumlu rol</TableHead><TableHead scope="col">Son tarih</TableHead><TableHead scope="col"><span className="sr-only">Eylem</span></TableHead>
            </TableRow></TableHeader>
            <TableBody>
              {items.map((t, i) => (
                <TableRow key={t.id} data-state={i === cursor ? 'selected' : undefined} className={cn(i === cursor && 'outline-2 -outline-offset-2 outline-focus')}>
                  <TableCell className="whitespace-nowrap">{t.refNo ?? <span className="text-ink-subtle">—</span>}</TableCell>
                  <TableCell><Tag label={severityLabel[t.severity]} /></TableCell>
                  <TableCell className="min-w-[200px]"><Link className="font-semibold text-ink no-underline hover:underline" to={entityHref(t)}>{t.title}</Link></TableCell>
                  <TableCell className="min-w-[220px] max-w-[44ch] text-ink-muted">{t.reason}</TableCell>
                  <TableCell className="min-w-[200px]">{t.nextAction}</TableCell>
                  <TableCell className="whitespace-nowrap max-[1600px]:hidden">{roleLabel[t.assigneeRole] ?? t.assigneeRole}</TableCell>
                  <TableCell className="tabular whitespace-nowrap"><Due at={t.dueAt} /><div className="text-sm text-ink-subtle" title={t.createdAt}>Açıldı {relative(t.createdAt)}</div></TableCell>
                  <TableCell><Button asChild size="sm" variant={i === cursor ? 'default' : 'outline'}><Link to={entityHref(t)} aria-label={`İşi aç: ${t.title}`}>İşi aç</Link></Button></TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table></div>
          <p className="mt-3 text-sm text-ink-subtle max-[900px]:hidden">
            Klavye: <kbd className="rounded-sm border border-input bg-surface px-1 font-sans">j</kbd> / <kbd className="rounded-sm border border-input bg-surface px-1 font-sans">k</kbd> satır seçer,
            {' '}<kbd className="rounded-sm border border-input bg-surface px-1 font-sans">Enter</kbd> seçili işi açar.
          </p>
        </>
      )}
    </div>
  );
}

/** Son tarih: geçmişse metin + ikonla "Gecikti"; tanımsızsa açıkça belirtilir. */
function Due({ at }: { at: string | null }) {
  if (!at) return <span className="text-ink-subtle">Son tarih yok</span>;
  if (new Date(at).getTime() < Date.now()) return <Tag label={{ text: `Gecikti · ${fmtDate(at)}`, tone: 'danger', icon: 'clock' }} />;
  return <span>{fmtDate(at)}</span>;
}
