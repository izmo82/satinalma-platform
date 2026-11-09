import { useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useResource } from '../lib/useApi.ts';
import { fmtDate } from '../lib/format.ts';
import { supplierStatus } from '../lib/labels.ts';
import { Empty, ErrorState, FilterChip, Loading, PageHeader, Tag } from '../ui/kit.tsx';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';

interface Row { id: string; status: string; taxIdType: string | null; taxId: string | null; legalName: string; identityReviewRequired: boolean;
  createdAt: string; documentCount: number; pendingBankChanges: number }

const FILTERS = [['', 'Tümü'], ['CANDIDATE', 'Aday havuzu'], ['ACTIVE', 'Aktif'], ['SUSPENDED', 'Askıda'], ['REJECTED', 'Reddedilen']] as const;

export function SuppliersPage() {
  const [params, setParams] = useSearchParams();
  const status = params.get('durum') ?? '';
  const [q, setQ] = useState(params.get('q') ?? '');
  const path = useMemo(() => {
    const u = new URLSearchParams();
    if (status) u.set('status', status);
    if (params.get('q')) u.set('q', params.get('q')!);
    return `/api/v1/suppliers?${u}`;
  }, [status, params]);
  const r = useResource<{ items: Row[] }>(path);
  const set = (k: string, v: string) => { const p = new URLSearchParams(params); v ? p.set(k, v) : p.delete(k); setParams(p, { replace: true }); };

  return (
    <div className="page">
      <PageHeader title="Tedarikçiler">Kesin eşleme yalnız ülke + kimlik türü + vergi kimliğiyle yapılır. İsim benzerliği yalnız öneridir.</PageHeader>
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <div role="group" aria-label="Durum filtresi" className="flex flex-wrap gap-2">
          {FILTERS.map(([v, l]) => <FilterChip key={v} pressed={status === v} onClick={() => set('durum', v)}>{l}</FilterChip>)}
        </div>
        <form role="search" onSubmit={(e) => { e.preventDefault(); set('q', q.trim()); }} className="ml-auto flex gap-2 max-[900px]:ml-0 max-[900px]:w-full">
          <label className="sr-only" htmlFor="sq">Ünvan veya vergi kimliği ara</label>
          <Input id="sq" className="w-64 bg-white max-[900px]:w-auto max-[900px]:flex-1" placeholder="Ünvan veya VKN/TCKN" value={q} onChange={(e) => setQ(e.target.value)} />
          <Button variant="outline" type="submit">Ara</Button>
        </form>
      </div>
      {r.loading && !r.data ? <Loading /> : r.error ? <ErrorState error={r.error} onRetry={r.reload} /> : !r.data?.items.length ? (
        <div className="rounded-md border border-border bg-surface"><Empty icon="users" title="Bu filtrede tedarikçi yok">{status === 'CANDIDATE' ? 'Belgedeki satıcı kayıtlı değilse aday burada görünür.' : 'Filtreyi temizleyin veya belge yükleyin.'}</Empty></div>
      ) : (
        <Table>
          <TableHeader><TableRow className="hover:bg-transparent">
            <TableHead scope="col">Ünvan</TableHead><TableHead scope="col">Durum</TableHead><TableHead scope="col">Vergi kimliği</TableHead>
            <TableHead scope="col" className="text-right">Belge</TableHead><TableHead scope="col">Dikkat</TableHead><TableHead scope="col" className="max-[900px]:hidden">Kayıt</TableHead>
          </TableRow></TableHeader>
          <TableBody>
            {r.data.items.map((s) => (
              <TableRow key={s.id}>
                <TableCell className="min-w-[220px]"><Link className="font-semibold text-ink no-underline hover:underline" to={`/tedarikciler/${s.id}`}>{s.legalName}
                  {(s.identityReviewRequired || !s.taxId) && <span className="sr-only">, vergi kimliği doğrulanmadı</span>}</Link></TableCell>
                <TableCell><Tag label={supplierStatus[s.status]} /></TableCell>
                <TableCell className="whitespace-nowrap">{s.taxId ? <span className="mono">{s.taxIdType} {s.taxId}</span> : <span className="text-ink-muted">Doğrulanmadı</span>}</TableCell>
                <TableCell className="tabular text-right">{s.documentCount}</TableCell>
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
