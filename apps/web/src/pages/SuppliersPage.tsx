import { useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useResource } from '../lib/useApi.ts';
import { fmtDate } from '../lib/format.ts';
import { applicationTag, STAGE_FILTERS, StageWithStatus } from '../lib/supplierV2.tsx';
import { Empty, ErrorState, FilterChip, Loading, PageHeader, Tag } from '../ui/kit.tsx';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';

interface Row { id: string; status: string; taxIdType: string | null; taxId: string | null; legalName: string; identityReviewRequired: boolean;
  createdAt: string; documentCount: number; pendingBankChanges: number;
  // v2 Faz 5 (R1): türetilmiş aşama, belge uyarısı ve sorumlu ekip.
  stage?: string; stageLabel?: string; documentAlert?: 'EXPIRED' | 'EXPIRING' | null; responsibleDepartment?: { id: string; name: string } | null;
  // v2 Faz 5 izleme (D2): kartın güncel tedarikçi belgesi sayısı (yenilenmişler sayılmaz); documentCount bağlı fatura/sözleşme belgesidir.
  supplierDocumentCount?: number }
interface ListResponse { items: Row[]; counts?: Record<'CANDIDATE' | 'APPROVED' | 'PASSIVE' | 'REJECTED', number>; applicationsOpen?: number }
interface AppRow { id: string; status: string; statusLabel: string; legalName: string; taxIdType: string; taxId: string; categories: string[]; documentCount: number;
  createdAt: string; submittedAt: string | null; supplier: { id: string; legalName: string } | null }

/** Eski `?durum=` (CANDIDATE, ACTIVE, SUSPENDED, REJECTED) adresleri aynen çalışır; yeni süzgeç `?asama=`. */
const LEGACY_LABEL: Record<string, string> = { CANDIDATE: 'Aday havuzu', ACTIVE: 'Aktif', SUSPENDED: 'Askıda', REJECTED: 'Reddedilen' };

export function SuppliersPage() {
  const [params, setParams] = useSearchParams();
  const status = params.get('durum') ?? '';
  const stage = params.get('asama') ?? '';
  const applications = stage === 'basvuru';
  const [q, setQ] = useState(params.get('q') ?? '');
  const path = useMemo(() => {
    const u = new URLSearchParams();
    if (status) u.set('status', status);
    if (stage && !applications) u.set('stage', stage);
    if (params.get('q')) u.set('q', params.get('q')!);
    return `/api/v1/suppliers?${u}`;
  }, [status, stage, applications, params]);
  const r = useResource<ListResponse>(path);
  const apps = useResource<{ items: AppRow[] }>(applications ? '/api/v1/supplier-applications' : null);
  const set = (k: string, v: string) => { const p = new URLSearchParams(params); v ? p.set(k, v) : p.delete(k); setParams(p, { replace: true }); };
  const setStage = (v: string) => { const p = new URLSearchParams(params); p.delete('durum'); v ? p.set('asama', v) : p.delete('asama'); setParams(p, { replace: true }); };
  const counts = r.data?.counts;
  const total = counts ? counts.CANDIDATE + counts.APPROVED + counts.PASSIVE + counts.REJECTED : undefined;
  const openApps = r.data?.applicationsOpen;
  const count = (v: string) => v === '' ? total : v === 'basvuru' ? openApps : counts?.[v as keyof NonNullable<typeof counts>];
  const appsQ = (params.get('q') ?? '').toLocaleLowerCase('tr-TR');
  // Başvuru çipindeki sayı açık (incelenecek) başvurulardır; liste de varsayılan olarak yalnız onları gösterir, kapanmışlar isteğe bağlı.
  const [showClosed, setShowClosed] = useState(false);
  const OPEN_APP = new Set(['SUBMITTED', 'NEEDS_DOCUMENTS']);
  const allApps = (apps.data?.items ?? []).filter((a) => !appsQ || a.legalName.toLocaleLowerCase('tr-TR').includes(appsQ) || a.taxId === appsQ);
  const appRows = showClosed ? allApps : allApps.filter((a) => OPEN_APP.has(a.status));

  return (
    <div className="page">
      <PageHeader title="Tedarikçiler" actions={openApps ? <Button variant="outline" onClick={() => setStage('basvuru')}>Başvuruları incele ({openApps})</Button> : undefined}>
        {total !== undefined && <>{total} tedarikçi{openApps ? ` · ${openApps} başvuru inceleme bekliyor` : ''}. </>}
        Kesin eşleme yalnız ülke + kimlik türü + vergi kimliğiyle yapılır. İsim benzerliği yalnız öneridir.</PageHeader>
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <div role="group" aria-label="Aşama süzgeci" className="flex flex-wrap gap-2">
          {STAGE_FILTERS.map(([v, l]) => <FilterChip key={v} pressed={!status && stage === v} count={count(v)} onClick={() => setStage(v)}>{l}</FilterChip>)}
          {status && <FilterChip pressed onClick={() => set('durum', '')}>{LEGACY_LABEL[status] ?? 'Eski durum süzgeci'}</FilterChip>}
        </div>
        <form role="search" onSubmit={(e) => { e.preventDefault(); set('q', q.trim()); }} className="ml-auto flex gap-2 max-[900px]:ml-0 max-[900px]:w-full">
          <label className="sr-only" htmlFor="sq">Ünvan veya vergi kimliği ara</label>
          <Input id="sq" className="w-64 bg-white max-[900px]:w-auto max-[900px]:flex-1" placeholder="Ünvan veya VKN/TCKN" value={q} onChange={(e) => setQ(e.target.value)} />
          <Button variant="outline" type="submit">Ara</Button>
        </form>
      </div>
      {applications && (
        <label className="mb-3 inline-flex min-h-8 items-center gap-2 text-sm">
          <input type="checkbox" className="size-4 accent-ink" checked={showClosed} onChange={(e) => setShowClosed(e.target.checked)} />
          Doğrulanmamış, onaylanmış, reddedilmiş ve süresi dolmuş başvuruları da göster{apps.data ? ` (${allApps.length - allApps.filter((a) => OPEN_APP.has(a.status)).length})` : ''}
        </label>
      )}
      {applications ? (
        apps.loading && !apps.data ? <Loading /> : apps.error ? <ErrorState error={apps.error} onRetry={apps.reload} /> : !appRows.length ? (
          <div className="rounded-md border border-border bg-surface"><Empty icon="inbox" title={showClosed ? 'Başvuru yok' : 'İnceleme bekleyen başvuru yok'}>Başvuru adresi Yönetim &gt; Tedarikçi başvurusu sekmesinden açılır; gelen başvurular e-posta doğrulandıktan sonra burada incelenir.</Empty></div>
        ) : (
          <Table>
            <TableHeader><TableRow className="hover:bg-transparent">
              <TableHead scope="col">Firma</TableHead><TableHead scope="col">VKN</TableHead><TableHead scope="col" className="max-[900px]:hidden">Kategoriler</TableHead>
              <TableHead scope="col">Gönderim</TableHead><TableHead scope="col">Durum</TableHead><TableHead scope="col"><span className="sr-only">Eylem</span></TableHead>
            </TableRow></TableHeader>
            <TableBody>{appRows.map((a) => (
              <TableRow key={a.id}>
                <TableCell className="min-w-[200px] font-semibold">{a.legalName}{a.supplier && <span className="block text-sm font-normal text-ink-subtle">Kart: {a.supplier.legalName}</span>}</TableCell>
                <TableCell className="mono whitespace-nowrap">{a.taxId}</TableCell>
                <TableCell className="max-[900px]:hidden">{a.categories.length ? a.categories.join(', ') : '—'}</TableCell>
                <TableCell className="whitespace-nowrap text-sm">{fmtDate(a.submittedAt ?? a.createdAt)}</TableCell>
                <TableCell><Tag label={applicationTag(a.status, a.statusLabel)} /></TableCell>
                <TableCell><Button asChild size="sm" variant={a.status === 'SUBMITTED' ? 'default' : 'outline'}><Link to={`/tedarikciler/basvurular/${a.id}`} aria-label={`${a.legalName} başvurusunu incele`}>İncele</Link></Button></TableCell>
              </TableRow>
            ))}</TableBody>
          </Table>
        )
      ) : r.loading && !r.data ? <Loading /> : r.error ? <ErrorState error={r.error} onRetry={r.reload} /> : !r.data?.items.length ? (
        <div className="rounded-md border border-border bg-surface"><Empty icon="users" title="Bu filtrede tedarikçi yok">{status === 'CANDIDATE' || stage === 'CANDIDATE' ? 'Belgedeki satıcı kayıtlı değilse ya da başvuru onaylanınca aday burada görünür.' : 'Filtreyi temizleyin veya belge yükleyin.'}</Empty></div>
      ) : (
        <Table>
          <TableHeader><TableRow className="hover:bg-transparent">
            {/* v2 Faz 5 izleme: 640 px altında VKN ve aşama firma hücresinde alt satırda (yatay kaydırmadan görünür); sütunlar geniş ekranda aynen. */}
            <TableHead scope="col">Tedarikçi</TableHead><TableHead scope="col" className="max-[640px]:hidden">VKN</TableHead><TableHead scope="col" className="max-[640px]:hidden">Aşama</TableHead>
            <TableHead scope="col" className="max-[1100px]:hidden">Sorumlu ekip</TableHead>
            <TableHead scope="col"><abbr title="Kartın güncel tedarikçi belgeleri (vergi levhası, faaliyet belgesi…); yenilenen eski belgeler sayılmaz" className="no-underline">Kart belgeleri</abbr></TableHead>
            <TableHead scope="col"><abbr title="Tedarikçiye bağlı fatura ve sözleşme belgeleri" className="no-underline">Bağlı belgeler</abbr></TableHead><TableHead scope="col">Dikkat</TableHead>
            <TableHead scope="col" className="max-[900px]:hidden">Kayıt tarihi</TableHead>
          </TableRow></TableHeader>
          <TableBody>
            {r.data.items.map((s) => (
              <TableRow key={s.id}>
                <TableCell className="min-w-[220px]"><Link className="font-semibold text-ink no-underline hover:underline" to={`/tedarikciler/${s.id}`}>{s.legalName}
                  {(s.identityReviewRequired || !s.taxId) && <span className="sr-only">, vergi kimliği doğrulanmadı</span>}</Link>
                  <div className="mt-1 hidden gap-1 text-sm max-[640px]:grid">
                    <span>{s.taxId ? <span className="mono">{s.taxIdType} {s.taxId}</span> : <span className="text-ink-muted">VKN doğrulanmadı</span>}</span>
                    <span><StageWithStatus stage={s.stage} stageLabel={s.stageLabel} status={s.status} /></span>
                  </div></TableCell>
                <TableCell className="whitespace-nowrap max-[640px]:hidden">{s.taxId ? <span className="mono">{s.taxIdType} {s.taxId}</span> : <span className="text-ink-muted">Doğrulanmadı</span>}</TableCell>
                <TableCell className="max-[640px]:hidden"><StageWithStatus stage={s.stage} stageLabel={s.stageLabel} status={s.status} /></TableCell>
                <TableCell className="max-[1100px]:hidden">{s.responsibleDepartment?.name ?? <span className="text-ink-subtle">—</span>}</TableCell>
                <TableCell>
                  <div className="flex flex-wrap items-center gap-1.5">
                    <span className="tabular" title="Kartın güncel tedarikçi belgesi">{s.supplierDocumentCount ?? '—'}</span>
                    {s.documentAlert === 'EXPIRED' && <Tag label={{ text: 'Süresi dolmuş belge', tone: 'danger', icon: 'x' }} />}
                    {s.documentAlert === 'EXPIRING' && <Tag label={{ text: 'Süresi yaklaşan belge', tone: 'warn', icon: 'clock' }} />}
                  </div>
                </TableCell>
                <TableCell><span className="tabular" title="Bağlı fatura ve sözleşme belgesi">{s.documentCount}</span></TableCell>
                <TableCell>
                  <div className="flex flex-wrap gap-1.5">
                    {s.identityReviewRequired && <Tag label={{ text: 'Kimlik incelemesi', tone: 'warn', icon: 'help' }} />}
                    {s.pendingBankChanges > 0 && <Tag label={{ text: 'Banka doğrulama', tone: 'warn', icon: 'lock' }} />}
                  </div>
                </TableCell>
                <TableCell className="whitespace-nowrap text-sm text-ink-subtle max-[900px]:hidden">{fmtDate(s.createdAt)}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </div>
  );
}
