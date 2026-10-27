import { useMemo } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useResource } from '../lib/useApi.ts';
import { fmtDateTime } from '../lib/format.ts';
import { custodyLabel, detectionLabel, methodLabel, overallLabel, stageLabel } from '../lib/labels.ts';
import { Empty, ErrorState, FilterChip, Loading, PageHeader, Tag } from '../ui/kit.tsx';
import { Icon } from '../ui/icons.tsx';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';

interface Row {
  id: string; title: string; versionNo: number; stage: string; signatureMethod: string; originalCustodyRequired: boolean; finalizedAt: string | null;
  signature: { overall: string; underlying: string; automaticCheck: string; automaticAlert: string | null; custody: string; missingParties: string[]; blockerCount: number; hasActiveException: boolean };
  lastReviewedAt: string | null;
}

// 02 §40: inceleme bekleyen, görüntü bulunamadı, tarafı eksik, belirsiz, aslı beklenen, istisnalı.
const FILTERS: [string, string, (r: Row) => boolean][] = [
  ['', 'Tümü', () => true],
  ['bekleyen', 'İnceleme bekleyen', (r) => r.signature.overall === 'NOT_REVIEWED'],
  ['bulunamadi', 'Görüntü bulunamadı', (r) => r.signature.automaticAlert === 'IMAGE_NOT_FOUND_REVIEW_REQUIRED'],
  ['eksik', 'Tarafı eksik', (r) => r.signature.missingParties.length > 0],
  ['belirsiz', 'Belirsiz', (r) => r.signature.overall === 'UNCLEAR' || r.signature.underlying === 'UNCLEAR'],
  ['asil', 'Aslı beklenen', (r) => r.originalCustodyRequired && r.signature.custody !== 'CUSTODY_CONFIRMED'],
  ['istisna', 'İstisnalı', (r) => r.signature.hasActiveException],
];

const quiet = (code: string) => ['NOT_PROCESSED', 'UNSUPPORTED'].includes(code);

export function ContractsPage() {
  const [params, setParams] = useSearchParams();
  const f = params.get('filtre') ?? '';
  const r = useResource<{ items: Row[] }>('/api/v1/contracts');
  const counts = useMemo(() => Object.fromEntries(FILTERS.map(([k, , fn]) => [k, r.data?.items.filter(fn).length ?? 0])), [r.data]);
  const rows = (r.data?.items ?? []).filter(FILTERS.find(([k]) => k === f)?.[2] ?? (() => true));
  return (
    <div className="page">
      <PageHeader title="Sözleşmeler">Güncel sürümler ve imza kontrolü durumu. Durum, kayıtlı kanıt ve gereksinimlerden sunucuda hesaplanır.</PageHeader>
      <div className="mb-3 flex flex-wrap gap-2" role="group" aria-label="İmza filtresi">
        {FILTERS.map(([k, l]) => <FilterChip key={k} pressed={f === k} count={counts[k]}
          onClick={() => { const p = new URLSearchParams(params); k ? p.set('filtre', k) : p.delete('filtre'); setParams(p, { replace: true }); }}>{l}</FilterChip>)}
      </div>
      <p className="mb-4 flex flex-wrap items-center gap-x-4 gap-y-2 text-sm text-ink-muted">
        <span>Kanıtın kökeni:</span>
        <Tag label={{ text: 'İnsan kararı', tone: 'human', icon: 'stamp' }} />
        <Tag label={{ text: 'Kural ile doğrulandı', tone: 'ok', icon: 'check' }} />
        <Tag label={{ text: 'Otomatik öneri', tone: 'ai', icon: 'sparkles' }} />
      </p>
      {r.loading && !r.data ? <Loading /> : r.error ? <ErrorState error={r.error} onRetry={r.reload} /> : !rows.length ? (
        <div className="rounded-md border border-border bg-surface"><Empty icon="file" title="Bu filtrede sözleşme yok" /></div>
      ) : (
        <>
        <ul className="hidden divide-y divide-[#ebe6da] rounded-md border border-border bg-surface max-[640px]:block" aria-label="Sözleşmeler">
          {rows.map((c) => (
            <li key={c.id} className="grid gap-1.5 p-3">
              <Link className="font-semibold text-ink no-underline hover:underline" to={`/sozlesmeler/${c.id}`}>{c.title}</Link>
              <div className="text-sm text-ink-subtle">Sürüm {c.versionNo} · {stageLabel[c.stage]}</div>
              <div><Tag label={overallLabel[c.signature.overall]} /></div>
              {c.signature.missingParties.length > 0 && <p className="flex gap-1.5 text-sm"><Icon name="x" size={16} className="mt-0.5 shrink-0 text-danger" />Eksik imza: {c.signature.missingParties.join(', ')}</p>}
            </li>
          ))}
        </ul>
        <div className="max-[640px]:hidden"><Table>
          <TableHeader><TableRow className="hover:bg-transparent">
            <TableHead scope="col">Sözleşme</TableHead><TableHead scope="col">İmza durumu</TableHead><TableHead scope="col">Eksik taraf</TableHead>
            <TableHead scope="col" className="max-[900px]:hidden">Otomatik tarama</TableHead><TableHead scope="col" className="max-[900px]:hidden">Fiziksel asıl</TableHead><TableHead scope="col">Son inceleme</TableHead>
          </TableRow></TableHeader>
          <TableBody>
            {rows.map((c) => (
              <TableRow key={c.id}>
                <TableCell className="min-w-[240px]"><Link className="font-semibold text-ink no-underline hover:underline" to={`/sozlesmeler/${c.id}`}>{c.title}</Link>
                  <div className="text-sm text-ink-subtle">Sürüm {c.versionNo} · {stageLabel[c.stage]} · {methodLabel[c.signatureMethod]}</div></TableCell>
                <TableCell><Tag label={overallLabel[c.signature.overall]} />{c.finalizedAt && <div className="mt-1 text-sm text-ink-subtle">Kesinleşti</div>}</TableCell>
                <TableCell className="min-w-[200px]">{c.signature.missingParties.length ? <span className="flex gap-1.5"><Icon name="x" size={16} className="mt-0.5 shrink-0 text-danger" /><span>{c.signature.missingParties.join(', ')} <span className="text-danger">eksik</span></span></span> : <span className="text-ink-subtle">Yok</span>}</TableCell>
                <TableCell className="max-[900px]:hidden">{quiet(c.signature.automaticCheck) ? <span className="text-sm text-ink-subtle">{detectionLabel[c.signature.automaticCheck]?.text}</span> : <Tag label={detectionLabel[c.signature.automaticCheck]} />}</TableCell>
                <TableCell className="max-[900px]:hidden">{!c.originalCustodyRequired ? <span className="text-sm text-ink-subtle">Zorunlu değil</span> : c.signature.custody === 'CUSTODY_CONFIRMED' ? <Tag label={custodyLabel[c.signature.custody]} /> : <Tag label={{ ...custodyLabel[c.signature.custody]!, tone: 'warn' }} />}</TableCell>
                <TableCell className="whitespace-nowrap text-sm text-ink-subtle">{c.lastReviewedAt ? fmtDateTime(c.lastReviewedAt) : '—'}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table></div>
        </>
      )}
    </div>
  );
}
