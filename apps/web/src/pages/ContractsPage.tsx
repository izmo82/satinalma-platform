import { useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { api } from '../lib/api.ts';
import { useResource } from '../lib/useApi.ts';
import { Button } from '@/components/ui/button';
import { fmtDateTime } from '../lib/format.ts';
import { custodyLabel, detectionLabel, methodLabel, overallLabel, stageLabel } from '../lib/labels.ts';
import { Empty, ErrorState, FilterChip, Loading, PageHeader, Tag } from '../ui/kit.tsx';
import { Icon } from '../ui/icons.tsx';
import { hasRole, useSession } from '../lib/session.tsx';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';

interface Row {
  id: string; title: string; supplierNames?: string[]; versionNo: number; stage: string; signatureMethod: string; originalCustodyRequired: boolean; finalizedAt: string | null;
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
  const { me } = useSession();
  const [params, setParams] = useSearchParams();
  const f = params.get('filtre') ?? '';
  const r = useResource<{ items: Row[]; total: number }>('/api/v1/contracts');
  const [more, setMore] = useState<Row[]>([]);
  const [serverTotal, setServerTotal] = useState<number | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [moreError, setMoreError] = useState(false);
  // Sayfalar arasında yeni sözleşme eklenirse aynı satır iki kez gelebilir.
  const loaded = useMemo(() => [...new Map([...(r.data?.items ?? []), ...more].map((c) => [c.id, c])).values()], [r.data, more]);
  const total = serverTotal ?? r.data?.total ?? 0;
  // Tekilleştirilmiş değil, sunucudan alınan satır sayısı: sayfalar arasında kayma olsa da düğme takılı kalmaz.
  const partial = (r.data?.items.length ?? 0) + more.length < total;
  async function loadMore() {
    setLoadingMore(true); setMoreError(false);
    try {
      // Süzgeçler imza durumuna bağlı ve istemcide çalışır; bu yüzden satırlar biriktirilir, sayfa değiştirilmez (D89).
      const res = await api<{ items: Row[]; total: number }>(`/api/v1/contracts?offset=${(r.data?.items.length ?? 0) + more.length}`);
      setMore((x) => [...x, ...res.data.items]); setServerTotal(res.data.total);
    } catch { setMoreError(true); } finally { setLoadingMore(false); }
  }
  const counts = useMemo(() => Object.fromEntries(FILTERS.map(([k, , fn]) => [k, loaded.filter(fn).length])), [loaded]);
  const rows = loaded.filter(FILTERS.find(([k]) => k === f)?.[2] ?? (() => true));
  return (
    <div className="page">
      <PageHeader title="Sözleşmeler" actions={hasRole(me, 'PROCUREMENT', 'DEPARTMENT_USER') && <Button asChild><Link to="/sozlesmeler/ekle"><Icon name="upload" />Sözleşme ekle</Link></Button>}>Güncel sürümler ve imza kontrolü durumu. Durum, kayıtlı kanıt ve gereksinimlerden sunucuda hesaplanır.</PageHeader>
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
        <div className="rounded-md border border-border bg-surface"><Empty icon="file" title={partial ? 'Yüklenen sözleşmelerde bu filtreye uyan yok' : 'Bu filtrede sözleşme yok'} /></div>
      ) : (
        <>
        <ul className="hidden divide-y divide-[#ebe6da] rounded-md border border-border bg-surface max-[640px]:block" aria-label="Sözleşmeler">
          {rows.map((c) => (
            <li key={c.id} className="grid gap-1.5 p-3">
              <Link className="font-semibold text-ink no-underline hover:underline" to={`/sozlesmeler/${c.id}`}>{c.title}</Link>
              <div className="text-sm text-ink-subtle">{c.supplierNames?.length ? `${c.supplierNames.join(', ')} · ` : ''}Sürüm {c.versionNo} · {stageLabel[c.stage]}</div>
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
                  {!!c.supplierNames?.length && <div className="text-sm text-ink-muted">Tedarikçi: {c.supplierNames.join(', ')}</div>}
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
      {partial && !r.error && <div className="mt-4 flex flex-wrap items-center gap-3">
        <Button variant="outline" disabled={loadingMore} onClick={() => void loadMore()}>{loadingMore ? 'Yükleniyor…' : 'Daha fazla yükle'}</Button>
        <span className="text-sm text-ink-muted">Süzgeç sayıları yüklenen {loaded.length} sözleşmeye göredir; toplam {total}.</span>
        {moreError && <span className="text-sm text-danger" role="alert">Yüklenemedi; yeniden deneyin.</span>}
      </div>}
    </div>
  );
}
