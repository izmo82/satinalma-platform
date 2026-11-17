import { useEffect, useMemo, useState } from 'react';
import { api, type ApiError } from '../lib/api.ts';
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

/** Tedarikçi görevinin açacağı kart sekmesi (v2 Faz 5: belge, ayrılış, portal kullanıcısı görevleri ilgili sekmeye). */
function supplierTab(kind?: string) {
  if (['assessment_blocker', 'risk_rereview', 'new_business_hold'].includes(kind ?? '')) return '?sekme=degerlendirme';
  if (kind?.startsWith('supplier_document_')) return '?sekme=belgeler';
  if (kind === 'supplier_offboarding') return '?sekme=ayrilis';
  if (kind === 'supplier_no_portal_user') return '?sekme=portal';
  return '';
}
/** v2 Faz 6 (D111): risk görevi değerlendirme formunu açar; çeyreklik görevde dönem başlıktan (ör. "… 2026-2: …") önseçilir. */
const riskHref = (t: { entityId: string; kind?: string; title?: string }) => {
  const p = t.kind === 'risk_quarterly_review' ? /\b(\d{4}-[1-4])\b/.exec(t.title ?? '')?.[1] : undefined;
  return `/tedarikciler/risk/${t.entityId}${p ? `?donem=${p}` : ''}`;
};
export const entityHref = (t: { entityType: string; entityId: string; kind?: string; title?: string }) =>
  t.entityType === 'risk_assessment' ? riskHref(t) : t.entityType === 'supplier' ? `/tedarikciler/${t.entityId}${supplierTab(t.kind)}` : t.entityType === 'supplier_application' ? `/tedarikciler/basvurular/${t.entityId}` : t.entityType === 'contract_version' ? `/sozlesmeler/${t.entityId}`
    : t.entityType === 'document_version' ? `/belgeler/${t.entityId}` : t.entityType === 'project' ? `/projeler/${t.entityId}`
    : t.entityType === 'invoice' ? `/faturalar/${t.entityId}`
    : t.entityType === 'incident' ? `/tedarikciler/olaylar/${t.entityId}` : t.entityType === 'tenant' ? '/yonetim/yapay-zeka'
    : t.entityType === 'tenant_export' ? '/yonetim/denetim-izi'
    // v2 Faz 3 (D108): onay adımı → Onaylar sekmesi; hatırlatıcı → Hatırlatıcılar; red ve yeniden gönderim → Onaylar (aile kimliğiyle).
    : t.entityType === 'contract_approval_step' ? `/sozlesmeler/onay-adimi/${t.entityId}`
    : t.entityType === 'contract_reminder' ? `/sozlesmeler/aile/${t.entityId}?sekme=hatirlaticilar`
    : t.entityType === 'contract_rejection' || t.entityType === 'contract_family' ? `/sozlesmeler/aile/${t.entityId}?sekme=onaylar` : '/islerim';
// v2 (D93): Lira Defteri (recovery_case) ve imha (disposal_batch) görevleri sunucuda listelenmez; kaldırılan ekrana hedef yok.

const VIEWS = [['mine', 'Benden beklenen'], ['overdue', 'Geciken'], ['all', 'Rolümdeki tüm işler']] as const;

interface TaskPage { items: Task[]; counts: Record<string, number>; total?: number; nextOffset?: number | null }

export function WorkPage() {
  const [view, setView] = useState<(typeof VIEWS)[number][0]>('mine');
  const [cursor, setCursor] = useState(0);
  const navigate = useNavigate();
  const r = useResource<TaskPage>(`/api/v1/tasks?view=${view}`);
  // Persona K2: ilk sayfa (200) üstüne "Daha fazla yükle" ile sonraki sayfalar eklenir; görünüm değişince ya da yenilenince sıfırlanır.
  const [more, setMore] = useState<{ items: Task[]; nextOffset: number | null; error: string | null; loading: boolean } | null>(null);
  useEffect(() => setMore(null), [r.data]);
  const items = useMemo(() => {
    const first = r.data?.items ?? [];
    if (!more) return first;
    const ids = new Set(first.map((t) => t.id));
    return [...first, ...more.items.filter((t) => !ids.has(t.id))];
  }, [r.data, more]);
  const nextOffset = more ? more.nextOffset : r.data?.nextOffset ?? null;
  const total = r.data?.total ?? r.data?.counts?.[view];
  const loadMore = async () => {
    if (nextOffset == null) return;
    setMore((m) => ({ items: m?.items ?? [], nextOffset, error: null, loading: true }));
    try {
      const res = await api<TaskPage>(`/api/v1/tasks?view=${view}&offset=${nextOffset}`);
      setMore((m) => ({ items: [...(m?.items ?? []), ...res.data.items], nextOffset: res.data.nextOffset ?? null, error: null, loading: false }));
    } catch (e) {
      setMore((m) => ({ items: m?.items ?? [], nextOffset, error: (e as ApiError).message, loading: false }));
    }
  };

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
              <TableHead scope="col">Kayıt no</TableHead><TableHead scope="col">Önem</TableHead><TableHead scope="col">İş</TableHead><TableHead scope="col" className="max-[1279px]:hidden">Neden bekliyor</TableHead>
              <TableHead scope="col" className="max-[1279px]:hidden">Sonraki adım</TableHead><TableHead scope="col" className="max-[1600px]:hidden">Sorumlu rol</TableHead><TableHead scope="col">Son tarih</TableHead><TableHead scope="col"><span className="sr-only">Eylem</span></TableHead>
            </TableRow></TableHeader>
            <TableBody>
              {items.map((t, i) => (
                <TableRow key={t.id} data-state={i === cursor ? 'selected' : undefined} className={cn(i === cursor && 'outline-2 -outline-offset-2 outline-focus')}>
                  <TableCell className="whitespace-nowrap">{t.refNo ?? <span className="text-ink-subtle">—</span>}</TableCell>
                  <TableCell><Tag label={severityLabel[t.severity]} /></TableCell>
                  <TableCell className="min-w-[200px]"><Link className="font-semibold text-ink no-underline hover:underline" to={entityHref(t)}>{t.title}</Link>
                    {/* 1280 px altında neden ve sonraki adım İş hücresinde alt alta (sütunlar kesilmesin, persona K4); bilgi kaybolmaz. */}
                    <div className="hidden max-[1279px]:block">
                      <p className="mt-1 text-ink-muted"><span className="sr-only">Neden bekliyor: </span>{t.reason}</p>
                      <p className="mt-1 flex gap-1.5"><Icon name="arrow" size={16} className="mt-0.5 shrink-0 text-ink-subtle" /><span><span className="sr-only">Sonraki adım: </span>{t.nextAction}</span></p>
                    </div></TableCell>
                  <TableCell className="min-w-[220px] max-w-[44ch] text-ink-muted max-[1279px]:hidden">{t.reason}</TableCell>
                  <TableCell className="min-w-[200px] max-[1279px]:hidden">{t.nextAction}</TableCell>
                  <TableCell className="whitespace-nowrap max-[1600px]:hidden">{roleLabel[t.assigneeRole] ?? t.assigneeRole}</TableCell>
                  <TableCell className="tabular whitespace-nowrap"><Due at={t.dueAt} /><div className="text-sm text-ink-subtle" title={t.createdAt}>Açıldı {relative(t.createdAt)}</div></TableCell>
                  <TableCell><Button asChild size="sm" variant={i === cursor ? 'default' : 'outline'}><Link to={entityHref(t)} aria-label={`İşi aç: ${t.title}`}>İşi aç</Link></Button></TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table></div>
          {(nextOffset != null || (total != null && total > items.length) || more?.error) && (
            <div className="mt-3 flex flex-wrap items-center gap-3" role="status" aria-live="polite">
              <span className="tabular text-sm text-ink-muted">{items.length} / {total ?? items.length} iş gösteriliyor</span>
              {nextOffset != null && <Button variant="outline" size="sm" disabled={!!more?.loading} onClick={() => void loadMore()}>
                {more?.loading ? 'Yükleniyor…' : 'Daha fazla yükle'}</Button>}
              {more?.error && <span className="text-sm text-danger">{more.error}</span>}
            </div>
          )}
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
