import { useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { apiDownload, ApiError } from '../lib/api.ts';
import { useResource } from '../lib/useApi.ts';
import { fmtDate } from '../lib/format.ts';
import { Banner, Empty, ErrorState, FilterChip, Loading, Tag } from '../ui/kit.tsx';
import { DepartmentFilter, DepartmentName, useDepartmentParam, withDepartment } from '../ui/Departments.tsx';
import { Button } from '@/components/ui/button';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { providerTag, verdictTag, type AuditSummary } from './ComplianceTab.tsx';

// v2 Faz 7 (D112, R10): Raporlar > "Uyum denetimleri". Proje başına son koşu; Denetçi salt okur ve PDF indirir. Departman kapsamı sunucuda (RLS).

interface Row extends AuditSummary { auditId: string; projectId: string; projectCode: string; projectTitle: string; departmentId: string | null; departmentName: string | null;
  completedOn: string | null; ruleSetVersion: number | null }

export function ComplianceAudits() {
  const [params, setParams] = useSearchParams();
  const [dep, setDep] = useDepartmentParam();
  const verdict = params.get('hukum') ?? '';
  const base = withDepartment('/api/v1/compliance-audits', dep);
  const r = useResource<{ items: Row[]; verdicts: { key: string; label: string }[] }>(verdict ? `${base}${base.includes('?') ? '&' : '?'}verdict=${verdict}` : base);
  const [msg, setMsg] = useState<{ tone: 'info' | 'danger'; text: string } | null>(null);
  const setVerdict = (k: string) => { const p = new URLSearchParams(params); k ? p.set('hukum', k) : p.delete('hukum'); setParams(p, { replace: true }); };
  const download = async (x: Row) => {
    setMsg(null);
    try { const n = await apiDownload(x.pdfUrl, `${x.projectCode}-uyum-denetimi-kosu-${x.runNo}.pdf`); setMsg({ tone: 'info', text: `${n} indirildi.` }); }
    catch (e) { setMsg({ tone: 'danger', text: (e as ApiError).message }); }
  };
  const verdicts = r.data?.verdicts ?? [];
  return (
    <div className="grid gap-3">
      <p className="max-w-[75ch] text-ink-muted">Tamamlanan projelerin son uyum denetimi koşusu. Puan ve hüküm kurallardan kodla hesaplanır; yapay zekâ yalnız kanıt belgesini okur ve sağlayıcısı her satırda yazılıdır.</p>
      <DepartmentFilter value={dep} onChange={setDep} />
      <div className="flex flex-wrap gap-2" role="group" aria-label="Hüküm süzgeci">
        <FilterChip pressed={!verdict} onClick={() => setVerdict('')}>Tümü</FilterChip>
        {verdicts.map((v) => <FilterChip key={v.key} pressed={verdict === v.key} onClick={() => setVerdict(v.key)}>{v.label}</FilterChip>)}
      </div>
      <div aria-live="polite">{msg && <Banner tone={msg.tone} title={msg.text} />}</div>
      {r.loading && !r.data ? <Loading /> : r.error ? <ErrorState error={r.error} onRetry={r.reload} /> : !r.data?.items.length ? (
        <div className="rounded-md border border-border bg-surface"><Empty icon="shield" title={verdict || dep ? 'Süzgece uyan denetim yok' : 'Henüz uyum denetimi yok'}>
          {verdict || dep ? 'Süzgeci değiştirin ya da “Tümü”nü seçin.' : 'Proje tamamlandığında uyum denetimi koşar ve burada listelenir.'}</Empty></div>
      ) : <>
        <ul className="hidden divide-y divide-[#ebe6da] rounded-md border border-border bg-surface max-[640px]:block" aria-label="Uyum denetimleri">
          {r.data.items.map((x) => (
            <li key={x.auditId} className="grid gap-1.5 p-3">
              <div className="flex items-center justify-between gap-2"><span className="tabular text-sm text-ink-subtle">{x.projectCode}</span><Tag label={verdictTag(x)} /></div>
              <Link className="font-semibold text-ink" to={`/projeler/${x.projectId}?sekme=uyum`}>{x.projectTitle}</Link>
              <div className="text-sm text-ink-muted">Puan {x.score ?? '—'} · {x.ruleSetVersion ? `sürüm ${x.ruleSetVersion}` : 'set yok'} · {fmtDate(x.completedOn)}</div>
              <div className="text-sm">Departman: <DepartmentName name={x.departmentName} /></div>
              <div className="flex flex-wrap items-center gap-2"><Tag label={providerTag(x)} /><Button size="xs" variant="outline" onClick={() => void download(x)} aria-label={`${x.projectCode} PDF indir`}>PDF</Button></div>
            </li>))}
        </ul>
        <div className="max-[640px]:hidden"><Table>
          <TableHeader><TableRow className="hover:bg-transparent"><TableHead>Proje</TableHead><TableHead>Departman</TableHead><TableHead>Tamamlanma</TableHead><TableHead className="text-right">Puan</TableHead>
            <TableHead>Hüküm</TableHead><TableHead>Kural seti</TableHead><TableHead className="max-[1100px]:hidden">Yapay zekâ</TableHead><TableHead><span className="sr-only">PDF</span></TableHead></TableRow></TableHeader>
          <TableBody>{r.data.items.map((x) => (
            <TableRow key={x.auditId}>
              <TableCell className="min-w-[220px]"><Link className="font-semibold text-ink" to={`/projeler/${x.projectId}?sekme=uyum`}>{x.projectTitle}</Link><span className="tabular block text-sm text-ink-subtle">{x.projectCode} · koşu {x.runNo}</span></TableCell>
              <TableCell className="whitespace-nowrap"><DepartmentName name={x.departmentName} /></TableCell>
              <TableCell className="tabular whitespace-nowrap">{fmtDate(x.completedOn)}</TableCell>
              <TableCell className="tabular text-right font-semibold">{x.score ?? '—'}</TableCell>
              <TableCell><Tag label={verdictTag(x)} /></TableCell>
              <TableCell className="text-sm">{x.ruleSetVersion ? `Sürüm ${x.ruleSetVersion}` : '—'}{x.ruleSetNote && <span className="block text-warn">{x.ruleSetNote}</span>}</TableCell>
              <TableCell className="max-[1100px]:hidden"><Tag label={providerTag(x)} /></TableCell>
              <TableCell><Button size="sm" variant="outline" onClick={() => void download(x)} aria-label={`${x.projectCode} PDF indir`}>PDF indir</Button></TableCell>
            </TableRow>))}</TableBody>
        </Table></div>
      </>}
    </div>
  );
}
