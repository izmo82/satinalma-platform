import { Link, useSearchParams } from 'react-router-dom';
import { useResource } from '../lib/useApi.ts';
import { fmtDateTime, fmtMoney, relative } from '../lib/format.ts';
import { projectStatus } from '../lib/labels.ts';
import { hasRole, useSession } from '../lib/session.tsx';
import { Empty, ErrorState, FilterChip, Loading, PageHeader, Tag } from '../ui/kit.tsx';
import { SavedViews } from '../ui/SavedViews.tsx';
import { Icon } from '../ui/icons.tsx';
import { Button } from '@/components/ui/button';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';

interface Row { id: string; code: string; title: string; category: string; status: string; currency: string; budget: string | null; budgetVerified: boolean;
  updatedAt: string; companyName: string; ownerName: string; closesAt: string | null; bidCount: number }

const FILTERS = [['', 'Tümü'], ['DRAFT', 'Taslak'], ['IN_APPROVAL', 'Onayda'], ['OPEN', 'Teklife açık'], ['EVALUATION', 'Değerlendirmede'], ['AWARD_APPROVAL', 'Seçim onayında'],
  ['CONTRACTING', 'Sözleşme aşamasında'], ['CANCELLED', 'İptal'], ['NO_AWARD', 'Sonuçsuz']] as const;

export function ProjectsPage() {
  const { me } = useSession();
  const [params, setParams] = useSearchParams();
  const f = params.get('durum') ?? '';
  const r = useResource<{ items: Row[] }>('/api/v1/projects');
  const rows = (r.data?.items ?? []).filter((x) => !f || x.status === f);
  const canCreate = hasRole(me, 'REQUESTER', 'BUYER', 'PROCUREMENT_MANAGER');
  return (
    <div className="page">
      <PageHeader title="Projeler" actions={<><Button asChild variant="outline"><Link to="/projeler/onay-politikasi">Onay politikası</Link></Button>
        {canCreate && <Button asChild><Link to="/projeler/yeni"><Icon name="folder" />Yeni proje</Link></Button>}</>}>
        İhtiyaçtan kazanan tahsisine kadar satınalma projeleri. Teklifler kapanışa kadar mühürlüdür; kapanış sunucu saatidir.
      </PageHeader>
      <SavedViews page="projects" />
      <div className="mb-3 flex flex-wrap gap-2" role="group" aria-label="Aşama filtresi">
        {FILTERS.map(([k, l]) => <FilterChip key={k} pressed={f === k} count={k ? r.data?.items.filter((x) => x.status === k).length : r.data?.items.length}
          onClick={() => { const p = new URLSearchParams(params); k ? p.set('durum', k) : p.delete('durum'); setParams(p, { replace: true }); }}>{l}</FilterChip>)}
      </div>
      {r.loading && !r.data ? <Loading /> : r.error ? <ErrorState error={r.error} onRetry={r.reload} /> : !rows.length ? (
        <div className="rounded-md border border-border bg-surface"><Empty icon="folder" title={f ? 'Bu aşamada proje yok' : 'Henüz proje yok'}>
          {canCreate ? 'İhtiyaç, kalemler ve değerlendirme kriterleriyle yeni bir proje başlatın.' : 'Size atanmış bir proje olduğunda burada görünür.'}</Empty></div>
      ) : (
        <>
          <ul className="hidden divide-y divide-[#ebe6da] rounded-md border border-border bg-surface max-[640px]:block" aria-label="Projeler">
            {rows.map((p) => (
              <li key={p.id} className="grid gap-1.5 p-3">
                <div className="flex items-center justify-between gap-2"><span className="tabular text-sm text-ink-subtle">{p.code}</span><Tag label={projectStatus[p.status]} /></div>
                <Link className="font-semibold text-ink no-underline hover:underline" to={`/projeler/${p.id}`}>{p.title}</Link>
                <div className="text-sm text-ink-muted">{p.companyName} · {p.budget ? fmtMoney(p.budget, p.currency) : 'Bütçe yok'}</div>
              </li>
            ))}
          </ul>
          <div className="max-[640px]:hidden"><Table>
            <TableHeader><TableRow className="hover:bg-transparent">
              <TableHead scope="col">Proje no</TableHead><TableHead scope="col">Proje</TableHead><TableHead scope="col">Aşama</TableHead>
              <TableHead scope="col" className="text-right">Bütçe</TableHead><TableHead scope="col">Kapanış</TableHead><TableHead scope="col" className="text-right">Teklif</TableHead>
              <TableHead scope="col" className="max-[1100px]:hidden">Sahip</TableHead><TableHead scope="col" className="max-[1100px]:hidden">Güncellendi</TableHead>
            </TableRow></TableHeader>
            <TableBody>
              {rows.map((p) => (
                <TableRow key={p.id}>
                  <TableCell className="whitespace-nowrap text-ink-muted">{p.code}</TableCell>
                  <TableCell className="min-w-[240px]"><Link className="font-semibold text-ink no-underline hover:underline" to={`/projeler/${p.id}`}>{p.title}</Link>
                    <div className="text-sm text-ink-subtle">{p.companyName} · {p.category}</div></TableCell>
                  <TableCell><Tag label={projectStatus[p.status]} /></TableCell>
                  <TableCell className="whitespace-nowrap text-right">{p.budget ? fmtMoney(p.budget, p.currency) : <span className="text-ink-subtle">Yok</span>}
                    {p.budget && !p.budgetVerified && <div className="text-sm text-warn">Bütçe doğrulanmadı</div>}</TableCell>
                  <TableCell className="whitespace-nowrap">{p.closesAt ? fmtDateTime(p.closesAt) : <span className="text-ink-subtle">—</span>}</TableCell>
                  <TableCell className="text-right">{p.bidCount}</TableCell>
                  <TableCell className="whitespace-nowrap max-[1100px]:hidden">{p.ownerName}</TableCell>
                  <TableCell className="whitespace-nowrap text-sm text-ink-subtle max-[1100px]:hidden">{relative(p.updatedAt)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table></div>
        </>
      )}
    </div>
  );
}
