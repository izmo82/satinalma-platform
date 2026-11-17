import { useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { api } from '../lib/api.ts';
import { useResource } from '../lib/useApi.ts';
import { Button } from '@/components/ui/button';
import { fmtDate, fmtDateTime, fmtMoney } from '../lib/format.ts';
import { statusTag } from '../lib/contractsV2.ts';
import { custodyLabel, detectionLabel, methodLabel, overallLabel, stageLabel } from '../lib/labels.ts';
import { Empty, ErrorState, FilterChip, Loading, PageHeader, Tag } from '../ui/kit.tsx';
import { Icon } from '../ui/icons.tsx';
import { DepartmentFilter, DepartmentName, useDepartmentParam, withDepartment } from '../ui/Departments.tsx';
import { hasRole, useSession } from '../lib/session.tsx';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';

interface Row {
  id: string; title: string; supplierNames?: string[]; versionNo: number; stage: string; signatureMethod: string; originalCustodyRequired: boolean; finalizedAt: string | null;
  signature: { overall: string; underlying: string; automaticCheck: string; automaticAlert: string | null; custody: string; missingParties: string[]; blockerCount: number; hasActiveException: boolean };
  lastReviewedAt: string | null; departmentId: string | null; departmentName: string | null;
  // v2 Faz 3 (D108): türetilmiş durum ve aile alanları (eski satırlarda boş olabilir).
  familyId?: string; code?: string | null; status?: string | null; statusLabel?: string | null; project?: { id: string; code: string; title: string } | null;
  supplier?: { id: string; legalName: string; status: string } | null; endDate?: string | null; indefinite?: boolean; amount?: string | null; currency?: string | null;
}

/** v2 Faz 3 (Figma 07): sunucuda türetilmiş durum süzgeci (sayfalamadan önce uygulanır); imza süzgeci istemcide, yüklenen satırlarda kalır. */
const STATUS_FILTERS = [['ALL', 'Tümü'], ['IN_APPROVAL', 'Onayda'], ['ACTIVE', 'Yürürlükte'], ['ENDING_90', '90 gün içinde biten'], ['INCOMPLETE', 'Eksik alan']] as const;
const withStatus = (path: string, status: string) => status === 'ALL' ? path : `${path}${path.includes('?') ? '&' : '?'}status=${status}`;

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

/** Sözleşme tarafı (imza) adları; yoksa ekleme akışında seçilen tedarikçi. */
const supplierText = (r: Row) => r.supplierNames?.length ? r.supplierNames.join(', ') : r.supplier?.legalName ?? '';


export function ContractsPage() {
  const [dep] = useDepartmentParam();
  const [params] = useSearchParams();
  const status = STATUS_FILTERS.some(([k]) => k === params.get('durum')) ? params.get('durum')! : 'ALL';
  // Departman ve durum süzgeci sunucuda (sayfalı liste); değişince biriken sayfalar sıfırlanır.
  return <ContractsList key={`${dep}|${status}`} dep={dep} status={status} />;
}

/** Durum süzgeci sayıları: her süzgeç için toplam (tek satırlık istek; sayım sunucuda). */
function useStatusCounts(dep: string) {
  const [counts, setCounts] = useState<Record<string, number>>({});
  useEffect(() => {
    let off = false;
    setCounts({});
    for (const [k] of STATUS_FILTERS) {
      api<{ total: number }>(withStatus(withDepartment('/api/v1/contracts?limit=1', dep), k)).then((r) => { if (!off) setCounts((c) => ({ ...c, [k]: r.data.total })); }, () => { /* sayı gösterilmez */ });
    }
    return () => { off = true; };
  }, [dep]);
  return counts;
}

function ContractsList({ dep, status }: { dep: string; status: string }) {
  const { me } = useSession();
  const [params, setParams] = useSearchParams();
  const [, setDep] = useDepartmentParam();
  const f = params.get('filtre') ?? '';
  const r = useResource<{ items: Row[]; total: number }>(withStatus(withDepartment('/api/v1/contracts', dep), status));
  const statusCounts = useStatusCounts(dep);
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
      const res = await api<{ items: Row[]; total: number }>(withStatus(withDepartment(`/api/v1/contracts?offset=${(r.data?.items.length ?? 0) + more.length}`, dep), status));
      setMore((x) => [...x, ...res.data.items]); setServerTotal(res.data.total);
    } catch { setMoreError(true); } finally { setLoadingMore(false); }
  }
  const counts = useMemo(() => Object.fromEntries(FILTERS.map(([k, , fn]) => [k, loaded.filter(fn).length])), [loaded]);
  const rows = loaded.filter(FILTERS.find(([k]) => k === f)?.[2] ?? (() => true));
  return (
    <div className="page">
      <PageHeader title="Sözleşmeler" actions={<div className="flex flex-wrap gap-2">
        <Button variant="outline" asChild><Link to="/sozlesmeler/sablonlar">Şablonlar</Link></Button>
        {hasRole(me, 'PROCUREMENT', 'DEPARTMENT_USER') && <Button asChild><Link to="/sozlesmeler/ekle"><Icon name="upload" />Sözleşme ekle</Link></Button>}</div>}>
        {me?.allDepartments ? 'Kurumun bütün sözleşmeleri.' : 'Departmanınızın sözleşmeleri ve onayınıza gelenler.'} Durum ve imza kontrolü kayıtlı kanıttan sunucuda hesaplanır.</PageHeader>
      <div className="mb-3"><DepartmentFilter value={dep} onChange={setDep} /></div>
      <div className="mb-3 flex flex-wrap gap-2" role="group" aria-label="Durum süzgeci">
        {STATUS_FILTERS.map(([k, l]) => <FilterChip key={k} pressed={status === k} count={statusCounts[k]}
          onClick={() => { const p = new URLSearchParams(params); k === 'ALL' ? p.delete('durum') : p.set('durum', k); setParams(p, { replace: true }); }}>{l}</FilterChip>)}
      </div>
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
              {c.code && <div className="tabular text-sm text-ink-subtle">{c.code}</div>}
              <div className="text-sm text-ink-subtle">{supplierText(c) ? `${supplierText(c)} · ` : ''}Sürüm {c.versionNo} · {stageLabel[c.stage]}</div>
              <div className="text-sm">Departman: <DepartmentName name={c.departmentName} />{c.project ? ` · ${c.project.code}` : ''}</div>
              <div className="text-sm tabular">Bitiş: {c.indefinite ? 'Süresiz' : c.endDate ? fmtDate(c.endDate) : '—'} · {c.amount ? fmtMoney(c.amount, c.currency) : '—'}</div>
              <div className="flex flex-wrap gap-1.5"><Tag label={statusTag(c.status, c.statusLabel)} /><Tag label={overallLabel[c.signature.overall]} /></div>
              {c.signature.missingParties.length > 0 && <p className="flex gap-1.5 text-sm"><Icon name="x" size={16} className="mt-0.5 shrink-0 text-danger" />Eksik imza: {c.signature.missingParties.join(', ')}</p>}
            </li>
          ))}
        </ul>
        <div className="max-[640px]:hidden"><Table>
          <TableHeader><TableRow className="hover:bg-transparent">
            <TableHead scope="col">Sözleşme</TableHead><TableHead scope="col" className="max-[1100px]:hidden">Tedarikçi</TableHead><TableHead scope="col" className="max-[1280px]:hidden">Proje</TableHead>
            <TableHead scope="col">Departman</TableHead><TableHead scope="col">Bitiş</TableHead><TableHead scope="col" className="text-right max-[900px]:hidden">Tutar</TableHead>
            <TableHead scope="col">Durum ve imza kontrolü</TableHead>
          </TableRow></TableHeader>
          <TableBody>
            {rows.map((c) => (
              <TableRow key={c.id}>
                <TableCell className="min-w-[200px]"><Link className="font-semibold text-ink no-underline hover:underline" to={`/sozlesmeler/${c.id}`}>{c.title}</Link>
                  {c.code && <div className="tabular text-sm text-ink-subtle">{c.code}</div>}
                  <div className="text-sm text-ink-subtle">Sürüm {c.versionNo} · {stageLabel[c.stage]} · {methodLabel[c.signatureMethod]}</div>
                  {!!supplierText(c) && <div className="hidden text-sm text-ink-muted max-[1100px]:block">Tedarikçi: {supplierText(c)}</div>}</TableCell>
                <TableCell className="max-[1100px]:hidden">{supplierText(c) || <span className="text-ink-subtle">—</span>}</TableCell>
                <TableCell className="whitespace-nowrap max-[1280px]:hidden">{c.project ? <Link to={`/projeler/${c.project.id}`} className="tabular text-ink">{c.project.code}</Link> : <span className="text-ink-subtle">—</span>}</TableCell>
                <TableCell className="whitespace-nowrap"><DepartmentName name={c.departmentName} /></TableCell>
                <TableCell className="tabular whitespace-nowrap">{c.indefinite ? 'Süresiz' : c.endDate ? fmtDate(c.endDate) : <span className="text-ink-subtle">—</span>}</TableCell>
                <TableCell className="tabular whitespace-nowrap text-right max-[900px]:hidden">{c.amount ? fmtMoney(c.amount, c.currency) : <span className="text-ink-subtle">—</span>}</TableCell>
                <TableCell className="min-w-[210px]">
                  {c.status ? <div className="mb-1.5"><Tag label={statusTag(c.status, c.statusLabel)} /></div> : null}
                  {/* İmza kontrolünün bütün katmanları tek hücrede (önceki ayrı sütunlar: eksik taraf, otomatik tarama, fiziksel asıl, son inceleme). */}
                  <Tag label={overallLabel[c.signature.overall]} />{c.finalizedAt && <span className="ml-2 text-sm text-ink-subtle">Kesinleşti</span>}
                  {c.signature.missingParties.length > 0 && <div className="mt-1 flex gap-1.5 text-sm"><Icon name="x" size={16} className="mt-0.5 shrink-0 text-danger" /><span>{c.signature.missingParties.join(', ')} <span className="text-danger">eksik</span></span></div>}
                  <div className="mt-1 flex flex-wrap gap-x-2 text-sm text-ink-subtle">
                    {quiet(c.signature.automaticCheck) ? <span>Tarama: {detectionLabel[c.signature.automaticCheck]?.text ?? '—'}</span>
                      : <span className="flex items-center gap-1">Tarama: <Tag label={detectionLabel[c.signature.automaticCheck]} /></span>}
                    <span className={c.originalCustodyRequired && c.signature.custody !== 'CUSTODY_CONFIRMED' ? 'font-semibold text-warn' : undefined}>Asıl: {!c.originalCustodyRequired ? 'zorunlu değil' : custodyLabel[c.signature.custody]?.text ?? '—'}</span>
                    {c.lastReviewedAt && <span>İnceleme: {fmtDateTime(c.lastReviewedAt)}</span>}
                  </div>
                </TableCell>
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
