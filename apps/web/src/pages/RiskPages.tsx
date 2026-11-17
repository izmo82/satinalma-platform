// v2 Faz 6 (D111) Görev 7: yıllık tedarikçi risk değerlendirmesi — risk matrisi (Figma 16), değerlendirme formu ve Excel içe aktarımı.
// Skorlar sunucuda kodla hesaplanır (R1–R3); ekrandaki canlı değer kaydetmeden önceki önizlemedir. Görünürlük sunucudadır (RLS):
// departman kullanıcısı kendi departmanının ve katkıcı olduğu değerlendirmeleri görür; katkıcı salt okur ve görüş ekler (R5).
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { api, apiDownload, ApiError } from '../lib/api.ts';
import { useResource } from '../lib/useApi.ts';
import { fmtDate, fmtDateTime } from '../lib/format.ts';
import { hasPermission, useSession } from '../lib/session.tsx';
import {
  ACTION_KIND_TR, ACTION_STATUS_TR, ASSESSMENT_STATUS_TR, bandOf, changedLabel, CONTROL_METHOD_TR, currentPeriod, currentYear, fmtScore, levelOf, levelTag,
  liveCriticality, liveScore, REVIEW_OUTCOME_TR, RISK_BAND_LABEL, RISK_CRITERIA, RISK_CRITERIA_LEVELS, RISK_CRITERIA_TR, RISK_LEVEL_TR, RiskMatrix,
  SCORE_SOURCE_TR, type RiskCriterion,
} from '../lib/risk.tsx';
import { Banner, Empty, ErrorState, Field, FilterChip, Loading, Modal, PageHeader, Tag } from '../ui/kit.tsx';
import { DepartmentFilter, DepartmentName, useDepartmentParam, useDepartments } from '../ui/Departments.tsx';
import { Icon } from '../ui/icons.tsx';
import { Button } from '@/components/ui/button';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { cn } from '@/lib/utils';

type Ref = { id: string; name: string | null };
interface ListItem {
  id: string; supplier: { id: string; name: string }; year: number; department: Ref | null; status: string; source: string; dueOn: string | null; overdue: boolean;
  criticality: string | null; criticalityDisplay: string | null; column: number | null; riskScore: string | null; level: number | null; levelLabel: string | null;
  scoreSource: string | null; revisionNo: number | null; lastReview: { period: string; outcome: string } | null; openActions: number; contributor: boolean;
}
interface Matrix {
  year: number; unscored: number; byStatus: { OPEN: number; COMPLETED: number; CANCELLED: number; overdue: number };
  cells: { band: number; bandLabel: string; column: number; level: number; count: number; supplierIds: string[]; assessmentIds: string[] }[];
}

const statusTag = (status: string, overdue?: boolean) => overdue ? { text: 'Gecikmiş', tone: 'danger' as const, icon: 'clock' }
  : status === 'COMPLETED' ? { text: 'Tamamlandı', tone: 'ok' as const, icon: 'check' }
  : status === 'CANCELLED' ? { text: 'İptal', tone: 'neutral' as const, icon: 'minus' } : { text: 'Açık', tone: 'info' as const, icon: 'clock' };

const errMsg = (e: unknown) => (e instanceof ApiError ? e.message : 'İşlem tamamlanamadı.');
/** Sunucunun 422 engel listesi (completion_blocked, action_plan_required). */
function ErrorBanner({ error }: { error: ApiError | null }) {
  if (!error) return null;
  const blockers: { message: string }[] = error.details?.blockers ?? [];
  return <Banner tone={error.status === 409 ? 'warn' : 'danger'} title={error.message}>
    {blockers.length > 0 && <ul className="mt-1 list-disc pl-5">{blockers.map((b, i) => <li key={i}>{b.message}</li>)}</ul>}
  </Banner>;
}

// =====================================================================================================================
// Risk matrisi (/tedarikciler/risk)
// =====================================================================================================================

type StatusFilter = 'all' | 'OPEN' | 'overdue' | 'COMPLETED' | 'unscored';

export function RiskMatrixPage() {
  const { me } = useSession();
  const [params, setParams] = useSearchParams();
  const thisYear = currentYear();
  const year = Number(params.get('yil')) || thisYear;
  const setYear = (y: number) => { const p = new URLSearchParams(params); y === thisYear ? p.delete('yil') : p.set('yil', String(y)); setParams(p, { replace: true }); setCell(null); };
  const [deptId, setDept] = useDepartmentParam();
  const m = useResource<Matrix>(`/api/v1/risk/matrix?year=${year}`);
  const l = useResource<{ items: ListItem[] }>(`/api/v1/risk/assessments?year=${year}`);
  const [cell, setCell] = useState<{ band: number; column: number } | null>(null);
  const [status, setStatus] = useState<StatusFilter>('all');
  const [level, setLevel] = useState('');
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [opening, setOpening] = useState(false);
  const canExport = hasPermission(me, 'risk.export');
  const canImport = hasPermission(me, 'risk.import');
  const canCycle = hasPermission(me, 'risk.cycle.manage');
  const years = Array.from({ length: 11 }, (_, i) => thisYear + 1 - i);
  if (!years.includes(year)) years.push(year);

  async function exportXlsx() {
    setError(null); setNotice(null);
    try { const name = await apiDownload(`/api/v1/risk/export.xlsx?year=${year}`, `BT Tedarikçi Risk Değerlendirme Tablosu ${year}.xlsx`); setNotice(`İndirildi: ${name}. Dışa aktarım kaydedildi.`); }
    catch (e) { setError(e as ApiError); }
  }
  async function openYear() {
    setError(null); setNotice(null);
    try {
      const r = await api<{ opened: number; skippedExisting: number; needsDepartment: number; skippedInactive: number; dueOn: string }>(`/api/v1/risk/cycles/${year}/open`, { method: 'POST' });
      const x = r.data;
      setNotice(`${year} yılı başlatıldı: ${x.opened} değerlendirme açıldı, ${x.skippedExisting} zaten vardı, ${x.skippedInactive} pasif/arşiv tedarikçi atlandı`
        + `${x.needsDepartment ? `, ${x.needsDepartment} değerlendirme için sorumlu departman seçilmeli (Satınalma görevi açıldı)` : ''}. Son tarih: ${fmtDate(x.dueOn)}.`);
      setOpening(false);
      await Promise.all([m.reload(), l.reload()]);
    } catch (e) { setError(e as ApiError); setOpening(false); }
  }

  const items = l.data?.items ?? [];
  const cellData = cell && m.data?.cells.find((c) => c.band === cell.band && c.column === cell.column);
  const cellItems = cellData ? items.filter((x) => cellData.assessmentIds.includes(x.id)) : [];
  const filtered = items.filter((x) => (!deptId || x.department?.id === deptId)
    && (!level || String(x.level) === level)
    && (status === 'all' || (status === 'overdue' ? x.overdue : status === 'unscored' ? x.status !== 'CANCELLED' && x.riskScore === null : x.status === status)));
  const counts = m.data?.byStatus;

  return (
    <div className="page">
      <PageHeader title="Risk matrisi" actions={<div className="flex flex-wrap gap-2">
        {canExport && <Button variant="outline" onClick={() => void exportXlsx()}><Icon name="download" />Excel'e aktar</Button>}
        {canImport && <Button variant="outline" asChild><Link to="/tedarikciler/risk/ice-aktar"><Icon name="upload" />Excel'den içe aktar</Link></Button>}
        {canCycle && <Button onClick={() => setOpening(true)}>Yılı başlat</Button>}
      </div>}>
        Yıllık tedarikçi risk değerlendirmesi: kritiklik (altı ölçütün geometrik ortalaması) sütunu, risk skoru satırı belirler. Seviye 4–5 için aksiyon ve denetim planı zorunludur.
      </PageHeader>
      {me && !me.allDepartments && <Banner tone="info" title="Departmanınızın değerlendirmeleri">
        Yalnız departmanınızın sorumlu olduğu değerlendirmeleri ve yürürlükte sözleşmeniz olan tedarikçilerin başka departmanlarca yapılan değerlendirmelerini (salt okunur, görüş ekleyebilirsiniz) görürsünüz.
      </Banner>}
      {notice && <Banner tone="info" icon="check" title={notice} />}
      <ErrorBanner error={error} />

      <div className="mb-4 flex flex-wrap items-end gap-3">
        <Field label="Yıl">{(p) => <select className="input w-32" {...p} value={year} onChange={(e) => setYear(Number(e.target.value))}>
          {years.map((y) => <option key={y} value={y}>{y}</option>)}</select>}</Field>
      </div>

      {m.loading && !m.data ? <Loading /> : m.error ? <ErrorState error={m.error} onRetry={m.reload} /> : m.data && (
        <div className="mb-6 grid items-start gap-4 min-[1100px]:grid-cols-[minmax(320px,440px)_minmax(0,1fr)]">
          <section className="panel" aria-labelledby="matrix-h">
            <div className="panel-head"><h2 id="matrix-h">{year} risk matrisi</h2><span className="subtle">Hücreye tıklayın: o hücrenin tedarikçileri</span></div>
            <div className="panel-body">
              <RiskMatrix caption={`${year} risk matrisi: hücrede değerlendirme sayısı`} cells={m.data.cells} selected={cell}
                onSelect={(c) => setCell((s) => (s && s.band === c.band && s.column === c.column ? null : c))} />
            </div>
          </section>
          <section className="panel" aria-labelledby="cell-h" aria-live="polite">
            <div className="panel-head"><h2 id="cell-h">{cellData ? `Risk ${cellData.bandLabel} · kritiklik ${cellData.column} · Seviye ${cellData.level}` : 'Seçili hücre yok'}</h2>
              {cellData && <Button size="sm" variant="ghost" className="ml-auto" onClick={() => setCell(null)}>Seçimi kaldır</Button>}</div>
            <div className="panel-body">
              {!cellData ? <p className="text-ink-muted">Matristen bir hücre seçin. Skoru olmayan {m.data.unscored} değerlendirme matriste yer almaz (Skorsuz süzgeciyle listelenir).</p>
                : !cellItems.length ? <p className="text-ink-muted">Bu hücrede değerlendirme yok.</p>
                : <ul className="grid gap-2" aria-label="Hücredeki tedarikçiler">{cellItems.map((x) => (
                  <li key={x.id} className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                    <Link className="font-semibold" to={`/tedarikciler/risk/${x.id}`}>{x.supplier.name}</Link>
                    <span className="text-sm text-ink-subtle"><DepartmentName name={x.department?.name} /> · kritiklik {x.criticalityDisplay} · skor {fmtScore(x.riskScore)} · {ASSESSMENT_STATUS_TR[x.status]}</span>
                  </li>))}</ul>}
            </div>
          </section>
        </div>
      )}

      <div className="mb-3 flex flex-wrap items-center gap-2" role="group" aria-label="Durum süzgeci">
        <FilterChip pressed={status === 'all'} onClick={() => setStatus('all')} count={counts ? counts.OPEN + counts.COMPLETED : undefined}>Tümü</FilterChip>
        <FilterChip pressed={status === 'OPEN'} onClick={() => setStatus('OPEN')} count={counts?.OPEN}>Açık</FilterChip>
        <FilterChip pressed={status === 'overdue'} onClick={() => setStatus('overdue')} count={counts?.overdue}>Gecikmiş</FilterChip>
        <FilterChip pressed={status === 'COMPLETED'} onClick={() => setStatus('COMPLETED')} count={counts?.COMPLETED}>Tamamlandı</FilterChip>
        <FilterChip pressed={status === 'unscored'} onClick={() => setStatus('unscored')} count={m.data?.unscored}>Skorsuz</FilterChip>
        <label className="ml-1 flex items-center gap-2 text-sm">Seviye
          <select className="input h-8 w-auto min-w-28" value={level} onChange={(e) => setLevel(e.target.value)}>
            <option value="">Tümü</option>{[1, 2, 3, 4, 5].map((n) => <option key={n} value={n}>Seviye {n}</option>)}
          </select>
        </label>
      </div>
      <div className="mb-3"><DepartmentFilter value={deptId} onChange={setDept} /></div>

      {l.loading && !l.data ? <Loading /> : l.error ? <ErrorState error={l.error} onRetry={l.reload} /> : !items.length ? (
        <div className="rounded-md border border-border bg-surface"><Empty icon="shield" title={`${year} için değerlendirme yok`}>
          {canCycle ? '"Yılı başlat" yürürlükte sözleşmesi olan tedarikçiler için değerlendirme açar; geçmiş tablo "Excel\'den içe aktar" ile alınır.' : 'Değerlendirmeler yıl başında açılır.'}</Empty></div>
      ) : !filtered.length ? <div className="rounded-md border border-border bg-surface"><Empty icon="search" title="Süzgece uyan değerlendirme yok" /></div> : (
        <Table aria-label="Risk değerlendirmeleri">
          <TableHeader><TableRow className="hover:bg-transparent">
            <TableHead scope="col">Tedarikçi</TableHead><TableHead scope="col" className="max-[900px]:hidden">Departman</TableHead>
            <TableHead scope="col" className="text-right">Kritiklik</TableHead><TableHead scope="col" className="text-right">Risk skoru</TableHead>
            <TableHead scope="col">Seviye</TableHead><TableHead scope="col">Durum</TableHead><TableHead scope="col">Son tarih</TableHead>
            <TableHead scope="col" className="max-[1100px]:hidden">Son gözden geçirme</TableHead>
          </TableRow></TableHeader>
          <TableBody>{filtered.map((x) => (
            <TableRow key={x.id}>
              <TableCell className="min-w-[200px]"><Link className="font-semibold text-ink no-underline hover:underline" to={`/tedarikciler/risk/${x.id}`}>{x.supplier.name}</Link>
                <span className="hidden text-sm text-ink-subtle max-[900px]:block"><DepartmentName name={x.department?.name} /></span>
                {x.contributor && <span className="block text-sm text-ink-subtle">Katkıcı: salt okunur, görüş eklenir</span>}
                {x.openActions > 0 && <span className="block text-sm text-ink-subtle">{x.openActions} açık aksiyon</span>}</TableCell>
              <TableCell className="max-[900px]:hidden"><DepartmentName name={x.department?.name} /></TableCell>
              <TableCell className="tabular text-right">{x.criticalityDisplay ?? '—'}{x.column ? <span className="block text-xs text-ink-subtle">sütun {x.column}</span> : null}</TableCell>
              <TableCell className="tabular text-right">{fmtScore(x.riskScore)}{x.scoreSource && <span className="block text-xs text-ink-subtle">{SCORE_SOURCE_TR[x.scoreSource]}</span>}</TableCell>
              <TableCell>{x.level ? <Tag label={levelTag(x.level, x.levelLabel)} /> : <span className="text-sm text-ink-subtle">Skorsuz</span>}</TableCell>
              <TableCell><Tag label={statusTag(x.status, x.overdue)} /></TableCell>
              <TableCell className="tabular whitespace-nowrap">{fmtDate(x.dueOn)}</TableCell>
              <TableCell className="whitespace-nowrap text-sm max-[1100px]:hidden">{x.lastReview ? `${x.lastReview.period} · ${REVIEW_OUTCOME_TR[x.lastReview.outcome] ?? x.lastReview.outcome}` : '—'}</TableCell>
            </TableRow>
          ))}</TableBody>
        </Table>
      )}

      {opening && <Modal title={`${year} yılını başlat`} onClose={() => setOpening(false)} footer={<>
        <Button variant="outline" onClick={() => setOpening(false)}>Vazgeç</Button><Button onClick={() => void openYear()}>Yılı başlat</Button></>}>
        <p>Yürürlükte sözleşmesi olan (pasif, arşiv, ret ve birleşmiş olmayan) her tedarikçi için {year} değerlendirmesi açılır ve sorumlu departmana görev düşer.
          Önceki yılın ölçüt ve cevapları taslağa taşınır. Zaten açılmış değerlendirmeler değişmez; işlem tekrarlanabilir.</p>
      </Modal>}
    </div>
  );
}

// =====================================================================================================================
// Değerlendirme (/tedarikciler/risk/:id)
// =====================================================================================================================

interface Question { id?: string; code: string; text: string; weight: string; riskAnswer: 'YES' | 'NO'; guidance: string | null; ordinal?: number }
interface QuestionSet { id: string; code: string; version: number; name: string; scopeNote: string | null; status: string; questions: Question[] }
interface Revision {
  id: string; revisionNo: number; criteria: Record<string, number>; criticality: string; criticalityDisplay: string; column: number; questionSetId: string | null;
  answers: Record<string, string>; scoreSource: string; scoreSourceLabel: string; riskScore: string; scoreNote: string | null; level: number; levelLabel: string; band: number;
  methodVersion: string; changedFields: string[]; createdBy: { id: string; displayName: string | null }; createdAt: string;
}
interface Action {
  id: string; kind: 'MITIGATION' | 'CONTROL'; controlMethod: string | null; controlMethodLabel: string | null; title: string; description: string | null;
  owner: { id: string; displayName: string | null } | null; ownerText: string | null; dueOn: string | null; supplierVisible: boolean; status: string;
  completedAt: string | null; completionNote: string | null; source: string;
}
export interface RiskDetail {
  assessment: {
    id: string; supplier: { id: string; name: string }; year: number; department: Ref | null; responsibleTeam: string | null; services: string | null;
    status: string; source: string; dueOn: string | null; overdue: boolean; openedAt: string; completedAt: string | null; pendingReviewPeriod: string | null;
    access: 'RESPONSIBLE' | 'CONTRIBUTOR' | 'READ';
  };
  draft: { criteria: Partial<Record<RiskCriterion, number>>; questionSetId: string | null; answers: Record<string, 'YES' | 'NO'>; manualScore: string | null; manualNote: string | null;
    importScore: string | null; importNote?: string | null };
  computed: { criticality: { value: string; display: string; column: number } | null; score: { value: string | null; source: string; sourceLabel: string; missing: string[] } | null;
    level: { level: number; band: number; bandLabel: string; label: string } | null; blockers: { code: string; message: string }[] };
  prior: { year: number; assessmentId: string; revision: Revision } | null;
  changed: string[];
  questionSet: QuestionSet | null;
  publishedQuestionSets: { id: string; code: string; version: number; name: string; scopeNote: string | null; questionCount: number; status?: string }[];
  manualResultAllowed: boolean;
  revisions: Revision[]; actions: Action[];
  opinions: { id: string; department: Ref | null; author: { id: string; displayName: string | null }; body: string; createdAt: string }[];
  reviews: { id: string; period: string; outcome: string; decidedBy: { displayName: string | null }; decidedAt: string }[];
  can: { edit: boolean; complete: boolean; opine: boolean; review: boolean; manageActions: boolean; setDepartment: boolean };
}

/** Çeyreklik gözden geçirme adayları: yılın cari İstanbul çeyreğine kadarki (geçmiş yılda 4'ü) kaydı olmayan çeyrekleri (en eski önce). */
export function reviewCandidates(year: number, reviews: { period: string }[]): string[] {
  const cur = currentPeriod();
  const curYear = Number(cur.slice(0, 4));
  const last = year < curYear ? 4 : year === curYear ? Number(cur.slice(5)) : 0;
  const done = new Set(reviews.map((r) => r.period));
  return Array.from({ length: last }, (_, i) => `${year}-${i + 1}`).filter((p) => !done.has(p));
}

export function RiskAssessmentPage() {
  const { id } = useParams();
  const r = useResource<RiskDetail>(`/api/v1/risk/assessments/${id}`);
  const [d, setD] = useState<RiskDetail | null>(null);
  const [version, setVersion] = useState(0);
  // Bildirim üst bileşende: kayıttan sonra form yeni sunucu verisiyle yeniden kurulur, bildirim kaybolmaz.
  const [notice, setNotice] = useState<string | null>(null);
  useEffect(() => { if (r.data) { setD(r.data); setVersion((v) => v + 1); } }, [r.data]);
  useEffect(() => setNotice(null), [id]);
  if (r.error && (!d || d.assessment.id !== id)) return <div className="page"><ErrorState error={r.error} onRetry={r.reload} /></div>;
  if (!d || d.assessment.id !== id) return <div className="page"><Loading /></div>;
  return <AssessmentView key={`${d.assessment.id}:${version}`} d={d} notice={notice} setNotice={setNotice}
    replace={(x) => { setD(x); setVersion((v) => v + 1); }} reload={r.reload} />;
}

interface Local { criteria: Partial<Record<RiskCriterion, number>>; questionSetId: string; answers: Record<string, 'YES' | 'NO'>; manualScore: string; manualNote: string }

function AssessmentView({ d, replace, reload, notice, setNotice }: { d: RiskDetail; replace: (x: RiskDetail) => void; reload: () => Promise<void>;
  notice: string | null; setNotice: (n: string | null) => void }) {
  const { me } = useSession();
  const [params] = useSearchParams();
  const a = d.assessment;
  const init: Local = {
    criteria: { ...d.draft.criteria }, questionSetId: d.draft.questionSetId ?? '', answers: { ...d.draft.answers },
    manualScore: d.draft.manualScore ? d.draft.manualScore.replace('.', ',') : '', manualNote: d.draft.manualNote ?? '',
  };
  const [loc, setLoc] = useState<Local>(init);
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const edit = d.can.edit;
  const upd = (f: (l: Local) => Local) => { setLoc(f); setDirty(true); setNotice(null); };

  // Seçim listesinde yalnız yayımlanmış setler (Görev 3 taşıması: taslak set listelenmez).
  const sets = d.publishedQuestionSets.filter((s) => s.status === undefined || s.status === 'PUBLISHED');
  const manualMode = d.manualResultAllowed;
  const setRes = useResource<QuestionSet>(loc.questionSetId && loc.questionSetId !== d.questionSet?.id ? `/api/v1/risk/question-sets/${loc.questionSetId}` : null);
  const activeSet = loc.questionSetId ? (loc.questionSetId === d.questionSet?.id ? d.questionSet : setRes.data) : null;

  const crit = liveCriticality(loc.criteria);
  const score = manualMode && loc.manualScore.trim() ? normalizeScore(loc.manualScore)
    : activeSet ? liveScore(activeSet.questions, loc.answers)
    : !loc.questionSetId ? d.draft.importScore : null;
  const scoreSource = manualMode && loc.manualScore.trim() ? 'MANUAL_RESULT' : activeSet ? 'QUESTIONS' : score ? 'IMPORT' : null;
  const level = crit && score ? levelOf(score, crit.column) : null;
  const band = score ? bandOf(score) : null;
  const shownLevel = edit ? level : d.computed.level?.level ?? null;

  async function save(): Promise<RiskDetail | null> {
    const body: Record<string, unknown> = { criteria: Object.fromEntries(RISK_CRITERIA.map((k) => [k, loc.criteria[k] ?? null])) };
    if (manualMode) {
      const ms = loc.manualScore.trim();
      body.manualScore = ms ? normalizeScore(ms) ?? ms : null;
      body.manualNote = loc.manualNote.trim() || null;
    } else if (loc.questionSetId) {
      body.questionSetId = loc.questionSetId;
      const codes = new Set((activeSet?.questions ?? []).map((q) => q.code));
      body.answers = Object.fromEntries(Object.entries(loc.answers).filter(([k]) => codes.has(k)));
    } else if (d.draft.questionSetId) body.questionSetId = null;
    const res = await api<RiskDetail>(`/api/v1/risk/assessments/${a.id}/draft`, { method: 'PUT', json: body });
    return res.data;
  }
  async function run(fn: () => Promise<RiskDetail | null>, ok: string) {
    setBusy(true); setError(null); setNotice(null);
    try { const x = await fn(); setNotice(ok); if (x) replace(x); }
    catch (e) { setError(e as ApiError); if ((e as ApiError).status === 409) await reload(); }
    finally { setBusy(false); }
  }
  const onSave = () => run(save, 'Taslak kaydedildi.');
  const onComplete = () => run(async () => {
    if (dirty) await save();
    return (await api<RiskDetail>(`/api/v1/risk/assessments/${a.id}/complete`, { method: 'POST' })).data;
  }, 'Değerlendirme tamamlandı; yeni revizyon yazıldı.');

  // Sayfadan çıkarken kaydedilmemiş değişiklik uyarısı.
  useEffect(() => {
    if (!dirty) return;
    const h = (e: BeforeUnloadEvent) => { e.preventDefault(); };
    window.addEventListener('beforeunload', h);
    return () => window.removeEventListener('beforeunload', h);
  }, [dirty]);

  const answered = activeSet ? activeSet.questions.filter((q) => loc.answers[q.code] === 'YES' || loc.answers[q.code] === 'NO').length : 0;
  const priorRev = d.prior?.revision;

  return (
    <div className="page">
      <p className="subtle"><Link to="/tedarikciler">Tedarikçiler</Link> / <Link to={`/tedarikciler/risk${a.year !== currentYear() ? `?yil=${a.year}` : ''}`}>Risk matrisi</Link> / {a.supplier.name}</p>
      <PageHeader title={`Yıllık risk değerlendirmesi · ${a.year}`} actions={edit ? <div className="flex flex-wrap gap-2">
        <Button variant="outline" disabled={busy || !dirty} onClick={() => void onSave()}>Kaydet</Button>
        <Button disabled={busy} onClick={() => void onComplete()}>Tamamla</Button>
      </div> : undefined}>
        <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <Link to={`/tedarikciler/${a.supplier.id}?sekme=yillik-risk`} className="font-semibold">{a.supplier.name}</Link>
          <span>{a.department ? a.department.name : 'Departman seçilmedi'}</span>
          <Tag label={statusTag(a.status, a.overdue)} />
          <span className="tabular whitespace-nowrap">Son tarih {fmtDate(a.dueOn)}</span>
        </span>
        {a.services && <span className="mt-1 block text-sm text-ink-subtle">Hizmetler: {a.services}</span>}
      </PageHeader>

      {notice && <Banner tone="info" icon="check" title={notice} />}
      <ErrorBanner error={error} />
      {a.access === 'CONTRIBUTOR' && <Banner tone="info" title="Salt okunur: bu değerlendirmeyi sorumlu departman yapar">
        Yürürlükte sözleşmeniz olan tedarikçi için görüşünüzü aşağıdaki Görüşler bölümünden ekleyebilirsiniz.</Banner>}
      {a.access === 'READ' && !edit && a.status === 'OPEN' && <Banner tone="neutral" title="Salt okunur görünüm">Bu değerlendirmeyi düzenleme yetkiniz yok.</Banner>}
      {a.pendingReviewPeriod && a.status === 'OPEN' && <Banner tone="warn" title={`${a.pendingReviewPeriod} çeyreklik güncellemesi sürüyor`}>
        Tamamlanınca yeni revizyon ve "Güncellendi" gözden geçirmesi yazılır. Bu sırada tedarikçi portalında önceki tamamlanmış yılın sonucu görünür.</Banner>}
      {!a.department && <DepartmentAssign d={d} replace={replace} />}
      {dirty && <p className="mb-3 text-sm text-warn" role="status">Kaydedilmemiş değişiklik var. Engeller listesi kayıttan sonra yenilenir.</p>}

      <div className="grid items-start gap-4 min-[1100px]:grid-cols-[minmax(0,1fr)_minmax(340px,420px)]">
        <div className="grid min-w-0 gap-4">
          {/* 1 Kritiklik */}
          <section className="panel" aria-labelledby="crit-h">
            <div className="panel-head"><h2 id="crit-h">1. Kritiklik ölçütleri</h2><span className="subtle ml-auto">1 düşük · 3 orta · 5 yüksek</span></div>
            <div className="panel-body grid gap-4">
              {RISK_CRITERIA.map((k) => {
                const v = loc.criteria[k];
                const prev = priorRev?.criteria?.[k];
                const changed = prev !== undefined && v !== undefined && prev !== v;
                return (
                  <fieldset key={k} className="grid gap-2">
                    <legend className="mb-1 flex flex-wrap items-center gap-x-2 font-semibold">{RISK_CRITERIA_TR[k]}
                      {prev !== undefined && <span className="text-sm font-normal text-ink-subtle">Geçen yıl: {prev}</span>}
                      {changed && <Tag label={{ text: 'Değişti', tone: 'warn', icon: 'refresh' }} />}</legend>
                    {edit ? (
                      <div className="grid gap-2 min-[700px]:grid-cols-3">
                        {([1, 3, 5] as const).map((n) => (
                          <label key={n} className={cn('flex cursor-pointer items-start gap-2 rounded-md border px-3 py-2 text-sm transition-colors duration-150',
                            v === n ? 'border-ink bg-selected' : 'border-input bg-surface hover:bg-sunken')}>
                            <input type="radio" name={`c-${k}`} className="mt-1" checked={v === n} onChange={() => upd((l) => ({ ...l, criteria: { ...l.criteria, [k]: n } }))} />
                            <span><span className="tabular font-semibold">{n}</span> · {RISK_CRITERIA_LEVELS[k][n]}</span>
                          </label>))}
                      </div>
                    ) : <p className="text-sm">{v ? <><span className="tabular font-semibold">{v}</span> · {RISK_CRITERIA_LEVELS[k][v as 1 | 3 | 5]}</> : <span className="text-ink-subtle">Seçilmedi</span>}</p>}
                  </fieldset>
                );
              })}
              <p className="rounded-md bg-sunken px-3 py-2 text-sm" aria-live="polite">{crit ? <>Kritiklik <strong className="tabular">{crit.display}</strong> → sütun <strong className="tabular">{crit.column}</strong></>
                : `Kritiklik için altı ölçütün hepsi seçilmeli (${RISK_CRITERIA.filter((k) => loc.criteria[k] !== undefined).length} / 6).`}</p>
            </div>
          </section>

          {/* 2 Risk skoru */}
          <section className="panel" aria-labelledby="score-h">
            <div className="panel-head"><h2 id="score-h">2. Risk skoru</h2>{activeSet && <span className="subtle ml-auto tabular">{answered} / {activeSet.questions.length} yanıtlandı</span>}</div>
            <div className="panel-body grid gap-3">
              {manualMode ? <>
                <Banner tone="neutral" title="Kurumun Tedarikçi Riski Değerlendirme Şablonu henüz girilmedi">
                  Sorular Yönetim &gt; Şablonlar &gt; Risk soruları ekranından girilir. O zamana dek şablon dışında hesaplanmış sonucu elle girin; kaynak her ekranda "Elle girilen şablon sonucu" yazılır.
                </Banner>
                {edit ? <div className="grid gap-x-3 min-[700px]:grid-cols-[160px_minmax(0,1fr)]">
                  <Field label="Şablon sonucu (0–100)" hint="En çok 2 ondalık">{(p) => <input className="input tabular" inputMode="decimal" {...p} value={loc.manualScore}
                    onChange={(e) => upd((l) => ({ ...l, manualScore: e.target.value }))} />}</Field>
                  <Field label="Dayanak notu" hint="Zorunlu: sonucun hangi değerlendirmeden geldiğini yazın.">{(p) => <textarea className="input" rows={2} {...p} value={loc.manualNote}
                    onChange={(e) => upd((l) => ({ ...l, manualNote: e.target.value }))} />}</Field>
                </div> : d.draft.manualScore && <p>Elle girilen şablon sonucu: <strong className="tabular">{fmtScore(d.draft.manualScore)}</strong>{d.draft.manualNote ? ` · ${d.draft.manualNote}` : ''}</p>}
              </> : <>
                {edit ? <Field label="Soru seti" hint="Hizmet kapsamına uyan yayımlanmış seti seçin.">{(p) => <select className="input" {...p} value={loc.questionSetId}
                  onChange={(e) => upd((l) => ({ ...l, questionSetId: e.target.value }))}>
                  <option value="">{d.draft.importScore ? 'Excel içe aktarımındaki skoru kullan' : 'Seçin'}</option>
                  {sets.map((s) => <option key={s.id} value={s.id}>{s.name} · {s.code} v{s.version} ({s.questionCount} soru)</option>)}
                </select>}</Field> : activeSet && <p className="text-sm">Soru seti: {activeSet.name} · {activeSet.code} v{activeSet.version}</p>}
                {d.draft.manualScore && <Banner tone="warn" title="Taslakta elle girilmiş sonuç var">Yayımlanmış soru seti olduğu için elle sonuç kabul edilmez; bir set seçip soruları cevaplayın.</Banner>}
                {loc.questionSetId && !activeSet && (setRes.error ? <ErrorState error={setRes.error} onRetry={setRes.reload} /> : <Loading rows={2} />)}
                {activeSet && <ul className="grid divide-y divide-[#ebe6da] rounded-md border border-border" aria-label="Risk soruları">
                  {activeSet.questions.map((q) => {
                    const v = loc.answers[q.code];
                    const prev = priorRev?.answers?.[q.code];
                    return (
                      <li key={q.code} className="grid gap-2 px-3 py-2.5 min-[760px]:grid-cols-[minmax(0,1fr)_auto] min-[760px]:items-center">
                        <div className="min-w-0"><span className="font-semibold">{q.code}.</span> {q.text}
                          <span className="block text-sm text-ink-subtle">Ağırlık {q.weight.replace('.', ',')} · riskli cevap: {q.riskAnswer === 'YES' ? 'Evet' : 'Hayır'}
                            {prev ? ` · Geçen yıl: ${prev === 'YES' ? 'Evet' : 'Hayır'}` : ''}{q.guidance ? ` · ${q.guidance}` : ''}</span>
                          {prev && v && prev !== v && <Tag label={{ text: 'Değişti', tone: 'warn', icon: 'refresh' }} />}</div>
                        {edit ? <div className="flex gap-2" role="radiogroup" aria-label={`${q.code} cevabı`}>
                          {(['YES', 'NO'] as const).map((ans) => (
                            <label key={ans} className={cn('flex min-h-9 cursor-pointer items-center gap-2 rounded-md border px-3 text-sm font-semibold',
                              v === ans ? 'border-ink bg-selected' : 'border-input bg-surface hover:bg-sunken')}>
                              <input type="radio" name={`q-${q.code}`} checked={v === ans} onChange={() => upd((l) => ({ ...l, answers: { ...l.answers, [q.code]: ans } }))} />
                              {ans === 'YES' ? 'Evet' : 'Hayır'}</label>))}
                        </div> : <span className="text-sm font-semibold">{v === 'YES' ? 'Evet' : v === 'NO' ? 'Hayır' : '—'}</span>}
                      </li>);
                  })}
                </ul>}
              </>}
              {d.draft.importScore && !loc.questionSetId && !(manualMode && loc.manualScore.trim()) && <p className="text-sm">Excel içe aktarımından gelen skor: <strong className="tabular">{fmtScore(d.draft.importScore)}</strong> (Excel içe aktarımı)</p>}
              {d.draft.importNote && <p className="text-sm text-ink-muted">{/^Excel notu/i.test(d.draft.importNote) ? d.draft.importNote : `Excel notu: ${d.draft.importNote}`}</p>}
              <p className="rounded-md bg-sunken px-3 py-2 text-sm" aria-live="polite">{score
                ? <>Risk skoru <strong className="tabular">{fmtScore(score)}</strong> / 100 → bant {RISK_BAND_LABEL[band!]}{scoreSource ? ` · ${SCORE_SOURCE_TR[scoreSource]}` : ''}</>
                : activeSet ? 'Tüm sorular cevaplanmadan skor hesaplanmaz.' : 'Risk skoru yok.'}</p>
            </div>
          </section>

          <ActionsPanel d={d} level={shownLevel} replace={replace} reload={reload} meId={me?.user.id ?? ''} />
          <ReviewsPanel d={d} replace={replace} defaultPeriod={params.get('donem')} setNotice={setNotice} />
        </div>

        <div className="grid min-w-0 gap-4">
          {/* 3 Seviye */}
          <section className="panel" aria-labelledby="level-h">
            <div className="panel-head"><h2 id="level-h">3. Seviye</h2></div>
            <div className="panel-body grid gap-3">
              <div className="flex flex-wrap gap-x-8 gap-y-2">
                <div><span className="block text-sm text-ink-muted">Kritiklik</span><span className="tabular text-2xl font-semibold">{(edit ? crit?.display : d.computed.criticality?.display) ?? '—'}</span></div>
                <div><span className="block text-sm text-ink-muted">Risk skoru</span><span className="tabular text-2xl font-semibold">{fmtScore(edit ? score : d.computed.score?.value)}</span><span className="text-ink-muted"> / 100</span></div>
              </div>
              <RiskMatrix compact caption="Bu değerlendirmenin matris hücresi" highlight={edit ? (crit && band ? { band, column: crit.column } : null)
                : d.computed.level && d.computed.criticality ? { band: d.computed.level.band, column: d.computed.criticality.column } : null} />
              <div className="flex flex-wrap items-center gap-2"><span className="font-semibold">Risk seviyesi</span>
                {shownLevel ? <Tag label={levelTag(shownLevel)} /> : <span className="text-sm text-ink-subtle">Kritiklik ve skor tamamlanınca hesaplanır</span>}</div>
              {a.status === 'OPEN' && shownLevel && shownLevel >= 4 && <p className="text-sm text-danger">Seviye 4–5: tamamlamak için en az bir aksiyon ve bir denetim/kontrol satırı (sorumlu kişi ve gelecek tarihli) gerekir.</p>}
            </div>
          </section>

          {a.status === 'OPEN' && <section className="panel" aria-labelledby="block-h">
            <div className="panel-head"><h2 id="block-h">Tamamlamak için</h2></div>
            <div className="panel-body">{d.computed.blockers.length ? <ul className="grid gap-1.5" aria-label="Tamamlama engelleri">{d.computed.blockers.map((b, i) => (
              <li key={i} className="flex items-start gap-2 text-sm"><Icon name="alert" size={14} className="mt-0.5 shrink-0 text-warn" />{b.message}</li>))}</ul>
              : <p className="text-sm text-verified">Engel yok; "Tamamla" ile revizyon yazılır.</p>}</div>
          </section>}

          <OpinionsPanel d={d} replace={replace} />
          <RevisionsPanel d={d} />
        </div>
      </div>
    </div>
  );
}

/** "48,5" → "48.50"; geçersizse null. */
function normalizeScore(s: string): string | null {
  const m = /^(\d{1,3})(?:[.,](\d{1,2}))?$/.exec(s.trim());
  if (!m) return null;
  const out = `${Number(m[1])}.${(m[2] ?? '').padEnd(2, '0')}`;
  return Number(out) <= 100 ? out : null;
}

function DepartmentAssign({ d, replace }: { d: RiskDetail; replace: (x: RiskDetail) => void }) {
  const { items } = useDepartments();
  const [v, setV] = useState('');
  const [err, setErr] = useState<string | null>(null);
  if (!d.can.setDepartment) return <Banner tone="warn" title="Sorumlu departman seçilmedi">Satınalma sorumlu departmanı seçene dek değerlendirmeyi yalnız Yönetici ve Satınalma görür.</Banner>;
  return (
    <Banner tone="warn" title="Sorumlu departmanı seçin" action={undefined}>
      <div className="mt-2 flex flex-wrap items-end gap-2">
        <label className="grid gap-1 text-sm">Departman
          <select className="input h-9 w-auto min-w-48" value={v} onChange={(e) => setV(e.target.value)}>
            <option value="">Seçin</option>{items.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
          </select></label>
        <Button size="sm" disabled={!v} onClick={() => void api<RiskDetail>(`/api/v1/risk/assessments/${d.assessment.id}/department`, { method: 'PUT', json: { departmentId: v } })
          .then((r) => replace(r.data), (e) => setErr(errMsg(e)))}>Departmanı ata</Button>
      </div>
      {err && <p className="mt-1 text-sm text-danger" role="alert">{err}</p>}
    </Banner>
  );
}

interface Member { id: string; displayName: string; roles: string[] }

function ActionsPanel({ d, level, replace, reload, meId }: { d: RiskDetail; level: number | null; replace: (x: RiskDetail) => void; reload: () => Promise<void>; meId: string }) {
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<Action | null>(null);
  const [closing, setClosing] = useState<{ a: Action; status: 'DONE' | 'VERIFIED' | 'CANCELLED' } | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const manage = d.can.manageActions;
  const refresh = async () => { const r = await api<RiskDetail>(`/api/v1/risk/assessments/${d.assessment.id}`); replace(r.data); };
  const required = level !== null && level >= 4;
  return (
    <section className="panel" aria-labelledby="act-h">
      <div className="panel-head"><h2 id="act-h">Aksiyon ve denetim planı</h2>
        {manage && !adding && <Button size="sm" variant="outline" className="ml-auto" onClick={() => { setAdding(true); setEditing(null); }}><Icon name="pen" />Aksiyon ekle</Button>}</div>
      <div className="panel-body grid gap-3">
        <p className="text-sm text-ink-muted">{required ? 'Seviye 4–5: en az bir aksiyon (azaltım) ve bir denetim/kontrol satırı zorunludur; her satırda sorumlu kişi ve bugünden sonraki tarih olmalı.'
          : 'Seviye 4 ve 5 için aksiyon planı zorunludur. Bu değerlendirmede isteğe bağlıdır.'}</p>
        <ErrorBanner error={error} />
        {d.actions.length > 0 && <ul className="grid divide-y divide-[#ebe6da] rounded-md border border-border" aria-label="Aksiyonlar">{d.actions.map((x) => {
          const isOwner = x.owner?.id === meId;
          return (
            <li key={x.id} className={cn('grid gap-1 px-3 py-2.5', x.status === 'CANCELLED' && 'opacity-60')}>
              <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
                <span className="text-sm text-ink-muted">{ACTION_KIND_TR[x.kind]}{x.controlMethodLabel ? ` · ${x.controlMethodLabel}` : ''}</span>
                <span className="min-w-0 flex-1 font-semibold">{x.title}</span>
                <Tag label={{ text: ACTION_STATUS_TR[x.status] ?? x.status, tone: x.status === 'OPEN' ? 'info' : x.status === 'CANCELLED' ? 'neutral' : 'ok', icon: x.status === 'OPEN' ? 'clock' : 'check' }} />
              </div>
              <span className="text-sm text-ink-subtle">Sorumlu: {x.owner?.displayName ?? x.ownerText ?? 'seçilmedi'} · Tarih: {fmtDate(x.dueOn)}
                {x.supplierVisible ? ' · Tedarikçi görür' : ''}{x.source === 'IMPORT' ? ' · Excel içe aktarımı' : ''}</span>
              {x.description && <span className="text-sm">{x.description}</span>}
              {x.completionNote && <span className="text-sm text-ink-muted">Kapanış notu: {x.completionNote}</span>}
              {(manage || isOwner) && x.status !== 'CANCELLED' && x.status !== 'VERIFIED' && <div className="flex flex-wrap gap-2 pt-1">
                {x.status === 'OPEN' && <Button size="sm" variant="outline" aria-label={`${x.title}: tamamlandı olarak işaretle`} onClick={() => setClosing({ a: x, status: 'DONE' })}>Tamamlandı</Button>}
                {manage && x.status === 'DONE' && <Button size="sm" variant="outline" aria-label={`${x.title}: doğrula`} onClick={() => setClosing({ a: x, status: 'VERIFIED' })}>Doğrula</Button>}
                {manage && x.status === 'OPEN' && <Button size="sm" variant="ghost" aria-label={`${x.title}: düzenle`} onClick={() => { setEditing(x); setAdding(false); }}>Düzenle</Button>}
                {manage && x.status === 'OPEN' && <Button size="sm" variant="ghost" aria-label={`${x.title}: iptal et`} onClick={() => setClosing({ a: x, status: 'CANCELLED' })}>İptal et</Button>}
              </div>}
            </li>);
        })}</ul>}
        {(adding || editing) && <ActionForm key={editing?.id ?? 'new'} initial={editing} onCancel={() => { setAdding(false); setEditing(null); }}
          onSubmit={async (b) => {
            setError(null);
            try {
              if (editing) await api(`/api/v1/risk/actions/${editing.id}`, { method: 'PATCH', json: b });
              else await api(`/api/v1/risk/assessments/${d.assessment.id}/actions`, { method: 'POST', json: b });
              setAdding(false); setEditing(null); await refresh();
            } catch (e) { setError(e as ApiError); }
          }} />}
      </div>
      {closing && <CloseActionDialog c={closing} onClose={() => setClosing(null)} onDone={async () => { setClosing(null); await refresh(); }} onError={(e) => { setError(e); void reload(); }} />}
    </section>
  );
}

function ActionForm({ initial, onSubmit, onCancel }: { initial: Action | null; onSubmit: (b: Record<string, unknown>) => Promise<void>; onCancel: () => void }) {
  const members = useResource<Member[]>('/api/v1/members?active=true');
  const owners = (members.data ?? []).filter((m) => m.roles.some((r) => r === 'PROCUREMENT' || r === 'DEPARTMENT_USER'));
  const [f, setF] = useState({ kind: initial?.kind ?? 'MITIGATION', title: initial?.title ?? '', description: initial?.description ?? '', ownerUserId: initial?.owner?.id ?? '',
    dueOn: initial?.dueOn ?? '', controlMethod: initial?.controlMethod ?? '', supplierVisible: initial?.supplierVisible ?? false });
  const [err, setErr] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  function submit() {
    const e: Record<string, string> = {};
    if (f.title.trim().length < 3) e.title = 'Başlık yazın.';
    if (f.kind === 'CONTROL' && !f.controlMethod) e.controlMethod = 'Denetim yöntemini seçin.';
    setErr(e);
    if (Object.keys(e).length) return;
    const b: Record<string, unknown> = { title: f.title.trim(), description: f.description.trim() || null, ownerUserId: f.ownerUserId || null, dueOn: f.dueOn || null,
      supplierVisible: f.supplierVisible };
    if (!initial) b.kind = f.kind;
    if (f.kind === 'CONTROL') b.controlMethod = f.controlMethod; else if (!initial) b.controlMethod = null;
    setBusy(true);
    void onSubmit(b).finally(() => setBusy(false));
  }
  return (
    <form className="grid gap-x-3 rounded-md border border-border bg-paper p-3 min-[760px]:grid-cols-2" onSubmit={(e) => { e.preventDefault(); submit(); }} aria-label={initial ? 'Aksiyonu düzenle' : 'Yeni aksiyon'}>
      {!initial && <Field label="Tür">{(p) => <select className="input" {...p} value={f.kind} onChange={(e) => setF({ ...f, kind: e.target.value as 'MITIGATION' | 'CONTROL' })}>
        <option value="MITIGATION">Aksiyon (azaltım)</option><option value="CONTROL">Denetim/kontrol</option></select>}</Field>}
      <Field label="Başlık" error={err.title}>{(p) => <input className="input" {...p} value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} />}</Field>
      {f.kind === 'CONTROL' && <Field label="Yöntem" error={err.controlMethod}>{(p) => <select className="input" {...p} value={f.controlMethod} onChange={(e) => setF({ ...f, controlMethod: e.target.value })}>
        <option value="">Seçin</option>{Object.entries(CONTROL_METHOD_TR).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select>}</Field>}
      <Field label="Sorumlu kişi" hint="Satınalma ya da departman kullanıcısı">{(p) => <select className="input" {...p} value={f.ownerUserId} onChange={(e) => setF({ ...f, ownerUserId: e.target.value })}>
        <option value="">Seçin</option>{owners.map((m) => <option key={m.id} value={m.id}>{m.displayName}</option>)}</select>}</Field>
      <Field label="Tarih" hint="Bugünden sonra">{(p) => <input className="input" type="date" {...p} value={f.dueOn} onChange={(e) => setF({ ...f, dueOn: e.target.value })} />}</Field>
      <Field label="Açıklama">{(p) => <textarea className="input" rows={2} {...p} value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} />}</Field>
      <label className="flex items-center gap-2 self-center text-sm"><input type="checkbox" checked={f.supplierVisible} onChange={(e) => setF({ ...f, supplierVisible: e.target.checked })} />
        Tedarikçi görsün <span className="text-ink-subtle">(portalda yalnız başlık, tarih ve durum)</span></label>
      <div className="flex gap-2 min-[760px]:col-span-2"><Button type="submit" disabled={busy}>{initial ? 'Kaydet' : 'Ekle'}</Button><Button type="button" variant="ghost" onClick={onCancel}>Vazgeç</Button></div>
    </form>
  );
}

function CloseActionDialog({ c, onClose, onDone, onError }: { c: { a: Action; status: 'DONE' | 'VERIFIED' | 'CANCELLED' }; onClose: () => void; onDone: () => Promise<void>; onError: (e: ApiError) => void }) {
  const [note, setNote] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const title = c.status === 'DONE' ? 'Aksiyonu tamamlandı olarak işaretle' : c.status === 'VERIFIED' ? 'Aksiyonu doğrula' : 'Aksiyonu iptal et';
  return (
    <Modal title={title} onClose={onClose} footer={<>
      <Button variant="outline" onClick={onClose}>Vazgeç</Button>
      <Button variant={c.status === 'CANCELLED' ? 'destructive' : 'default'} onClick={() => {
        if (c.status === 'DONE' && note.trim().length < 3) { setErr('Ne yapıldığını yazın.'); return; }
        void api(`/api/v1/risk/actions/${c.a.id}`, { method: 'PATCH', json: { status: c.status, ...(note.trim() ? { completionNote: note.trim() } : {}) } })
          .then(() => onDone(), (e) => { setErr(errMsg(e)); onError(e as ApiError); });
      }}>{c.status === 'DONE' ? 'Tamamlandı' : c.status === 'VERIFIED' ? 'Doğrula' : 'İptal et'}</Button></>}>
      <p className="mb-3 font-semibold">{c.a.title}</p>
      <Field label={c.status === 'DONE' ? 'Kapanış notu' : 'Not (isteğe bağlı)'} error={err}>{(p) => <textarea className="input" rows={3} {...p} value={note} onChange={(e) => setNote(e.target.value)} />}</Field>
    </Modal>
  );
}

function ReviewsPanel({ d, replace, defaultPeriod, setNotice }: { d: RiskDetail; replace: (x: RiskDetail) => void; defaultPeriod: string | null; setNotice: (n: string) => void }) {
  const a = d.assessment;
  const candidates = reviewCandidates(a.year, d.reviews);
  const [period, setPeriod] = useState(defaultPeriod && candidates.includes(defaultPeriod) ? defaultPeriod : candidates[0] ?? '');
  const [confirm, setConfirm] = useState<null | 'NO_CHANGE' | 'UPDATE'>(null);
  const [error, setError] = useState<ApiError | null>(null);
  if (a.status !== 'COMPLETED' && !d.reviews.length) return null;
  async function go(outcome: 'NO_CHANGE' | 'UPDATE') {
    setError(null);
    try {
      const r = await api<RiskDetail>(`/api/v1/risk/assessments/${a.id}/reviews`, { method: 'POST', json: { period, outcome } });
      setConfirm(null);
      setNotice(outcome === 'NO_CHANGE' ? `${period} dönemi "Değişiklik yok" olarak kaydedildi.` : `${period} güncellemesi için değerlendirme yeniden açıldı.`);
      replace(r.data);
    } catch (e) { setConfirm(null); setError(e as ApiError); }
  }
  return (
    <section className="panel" aria-labelledby="rev-h">
      <div className="panel-head"><h2 id="rev-h">Çeyreklik gözden geçirme</h2></div>
      <div className="panel-body grid gap-3">
        <ErrorBanner error={error} />
        {a.status === 'COMPLETED' && d.can.review && (candidates.length ? <div className="flex flex-wrap items-end gap-2">
          {candidates.length > 1 ? <Field label="Dönem">{(p) => <select className="input w-32" {...p} value={period} onChange={(e) => setPeriod(e.target.value)}>
            {candidates.map((c) => <option key={c} value={c}>{c}</option>)}</select>}</Field>
            : <p className="mb-4 text-sm">Dönem: <strong className="tabular">{period}</strong></p>}
          <Button className="mb-4" onClick={() => setConfirm('NO_CHANGE')}>Değişiklik yok</Button>
          <Button className="mb-4" variant="outline" onClick={() => setConfirm('UPDATE')}>Güncelle</Button>
        </div> : <p className="text-sm text-ink-muted">{a.year} yılının bugüne kadarki tüm çeyrekleri gözden geçirildi.</p>)}
        {d.reviews.length > 0 ? <ul className="grid gap-1 text-sm" aria-label="Gözden geçirmeler">{d.reviews.map((v) => (
          <li key={v.id}><span className="tabular font-semibold">{v.period}</span> · {REVIEW_OUTCOME_TR[v.outcome] ?? v.outcome} · {v.decidedBy.displayName ?? '—'} · {fmtDateTime(v.decidedAt)}</li>))}</ul>
          : <p className="text-sm text-ink-subtle">Henüz çeyreklik gözden geçirme yok.</p>}
      </div>
      {confirm && <Modal title={confirm === 'NO_CHANGE' ? `${period}: Değişiklik yok` : `${period}: Güncelle`} onClose={() => setConfirm(null)} footer={<>
        <Button variant="outline" onClick={() => setConfirm(null)}>Vazgeç</Button>
        <Button onClick={() => void go(confirm)}>{confirm === 'NO_CHANGE' ? 'Değişiklik yok' : 'Güncelle'}</Button></>}>
        <p>{confirm === 'NO_CHANGE' ? 'Son revizyon bu dönem için geçerli kalır; gözden geçirme kaydı yazılır ve dönemin görevi kapanır.'
          : 'Değerlendirme yeniden açılır; taslak son revizyondan doldurulur ve yeni son tarih verilir. Tamamlanınca yeni revizyon yazılır. Bu sırada tedarikçi portalında önceki tamamlanmış yıl görünür.'}</p>
      </Modal>}
    </section>
  );
}

function OpinionsPanel({ d, replace }: { d: RiskDetail; replace: (x: RiskDetail) => void }) {
  const [body, setBody] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  async function add() {
    if (body.trim().length < 3) { setErr('Görüşünüzü yazın.'); return; }
    setBusy(true); setErr(null);
    try {
      await api(`/api/v1/risk/assessments/${d.assessment.id}/opinions`, { method: 'POST', json: { body: body.trim() } });
      setBody('');
      replace((await api<RiskDetail>(`/api/v1/risk/assessments/${d.assessment.id}`)).data);
    } catch (e) { setErr(errMsg(e)); } finally { setBusy(false); }
  }
  return (
    <section className="panel" aria-labelledby="op-h">
      <div className="panel-head"><h2 id="op-h">Görüşler</h2></div>
      <div className="panel-body grid gap-3">
        {d.opinions.length ? <ul className="grid gap-3" aria-label="Görüşler">{d.opinions.map((o) => (
          <li key={o.id} className="grid gap-0.5"><span className="text-sm text-ink-subtle">{o.department?.name ?? 'Satınalma'} · {o.author.displayName ?? '—'} · {fmtDateTime(o.createdAt)}</span>
            <span className="whitespace-pre-wrap">{o.body}</span></li>))}</ul>
          : <p className="text-sm text-ink-muted">Henüz görüş yok. Yürürlükte sözleşmesi olan diğer departmanlar görüş ekleyebilir.</p>}
        {d.can.opine && <div className="grid gap-2">
          <Field label="Görüşünüz" error={err}>{(p) => <textarea className="input" rows={3} {...p} value={body} onChange={(e) => setBody(e.target.value)} />}</Field>
          <Button className="justify-self-start" variant="outline" disabled={busy} onClick={() => void add()}>Görüş ekle</Button>
        </div>}
      </div>
    </section>
  );
}

function RevisionsPanel({ d }: { d: RiskDetail }) {
  return (
    <section className="panel" aria-labelledby="hist-h">
      <div className="panel-head"><h2 id="hist-h">Revizyon geçmişi</h2></div>
      <div className="panel-body">
        {!d.revisions.length ? <p className="text-sm text-ink-muted">Henüz revizyon yok; "Tamamla" ile ilk revizyon yazılır. Revizyonlar değiştirilemez.</p> : (
          <ol className="grid gap-3" aria-label="Revizyonlar">{d.revisions.map((x) => (
            <li key={x.id} className="grid gap-0.5 border-b border-border pb-2 last:border-0">
              <span className="flex flex-wrap items-center gap-2"><strong>Revizyon {x.revisionNo}</strong><Tag label={levelTag(x.level, x.levelLabel)} /></span>
              <span className="text-sm">Kritiklik <span className="tabular">{x.criticalityDisplay}</span> (sütun {x.column}) · skor <span className="tabular">{fmtScore(x.riskScore)}</span> · kaynak: {x.scoreSourceLabel}</span>
              {x.scoreNote && <span className="text-sm text-ink-muted">{x.scoreNote}</span>}
              {x.changedFields.length > 0 && <span className="text-sm text-ink-muted">Değişen: {x.changedFields.map(changedLabel).join(', ')}</span>}
              <span className="text-xs text-ink-subtle">{x.createdBy.displayName ?? '—'} · {fmtDateTime(x.createdAt)} · yöntem {x.methodVersion}</span>
            </li>))}</ol>
        )}
      </div>
    </section>
  );
}

// =====================================================================================================================
// Excel içe aktarımı (/tedarikciler/risk/ice-aktar)
// =====================================================================================================================

interface ImportRow {
  rowNo: number; name: string | null; services: string | null; criteria: (number | null)[] | Record<string, number | null> | null; criteriaComplete: boolean;
  criticality: { value: string; display: string; column: number } | null; excelCriticality: number | null; riskScore: string | null;
  level: { level: number; band: number; label: string } | null; actionText: string | null; commentNote?: string | null; createsAction: boolean; team: string | null;
  department: Ref | null; supplier: { id: string; name: string; status: string } | null; decision: 'CREATE' | 'SKIP' | 'MERGE' | 'NEW_CANDIDATE'; primary: boolean;
  outcome: 'COMPLETED' | 'OPEN' | 'SKIP' | 'MERGE' | 'CONFLICT'; outcomeLabel: string; issues: string[]; assessmentId: string | null;
}
interface ImportView {
  batch: { id: string; fileName: string; sha256: string; period: string | null; year: number; fractionScale: boolean; status: string; uploadedBy: { displayName: string | null };
    createdAt: string; appliedAt: string | null; result: Record<string, number> | null };
  scaleNote: string; teams: { team: string; rowCount: number; department: Ref | null }[]; departments: { id: string; name: string }[];
  rows: ImportRow[];
  summary: { rows: number; assessments: number; completed: number; open: number; skipped: number; merged: number; conflicts: number; newCandidates: number; unmatched: number; withIssues: number };
  alreadyApplied: boolean; can: { edit: boolean; apply: boolean; discard: boolean };
  result?: Record<string, number>; rowResults?: { rowNo: number; outcome: string; assessmentId: string | null; blockers?: { message: string }[] }[];
}
const BATCH_STATUS: Record<string, string> = { PREVIEW: 'Önizleme', APPLIED: 'Uygulandı', DISCARDED: 'Vazgeçildi' };

export function RiskImportPage() {
  const { me } = useSession();
  const [params, setParams] = useSearchParams();
  const batchId = params.get('id');
  const r = useResource<ImportView>(batchId ? `/api/v1/risk/imports/${batchId}` : null);
  const [view, setView] = useState<ImportView | null>(null);
  useEffect(() => { if (r.data) setView(r.data); }, [r.data]);
  const [uploadError, setUploadError] = useState<ApiError | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  if (!hasPermission(me, 'risk.import')) return (
    <div className="page"><PageHeader title="Excel'den içe aktar" />
      <div className="rounded-md border border-border bg-surface"><Empty icon="lock" title="İçe aktarım rolünüze açık değil">Risk tablosunu Yönetici ve Satınalma içe aktarır. <Link to="/tedarikciler/risk">Risk matrisine dön</Link></Empty></div></div>
  );

  async function upload() {
    const file = fileRef.current?.files?.[0];
    setUploadError(null); setError(null);
    if (!file) { setUploadError(new ApiError(0, 'file_required', 'Dosya seçin.')); return; }
    const fd = new FormData();
    fd.append('file', file);
    setBusy(true);
    try {
      const res = await api<ImportView>('/api/v1/risk/imports', { method: 'POST', body: fd });
      setView(res.data);
      setParams({ id: res.data.batch.id }, { replace: true });
    } catch (e) { setUploadError(e as ApiError); } finally { setBusy(false); }
  }
  async function patch(body: Record<string, unknown>) {
    if (!view) return;
    setError(null);
    try { setView((await api<ImportView>(`/api/v1/risk/imports/${view.batch.id}`, { method: 'PUT', json: body })).data); }
    catch (e) { setError(e as ApiError); if ((e as ApiError).status === 409) await r.reload(); }
  }
  async function apply() {
    if (!view) return;
    setBusy(true); setError(null);
    try { setView((await api<ImportView>(`/api/v1/risk/imports/${view.batch.id}/apply`, { method: 'POST' })).data); }
    catch (e) { setError(e as ApiError); } finally { setBusy(false); setConfirm(false); }
  }
  async function discard() {
    if (!view) return;
    setError(null);
    try { await api(`/api/v1/risk/imports/${view.batch.id}/discard`, { method: 'POST' }); setView(null); setParams({}, { replace: true }); }
    catch (e) { setError(e as ApiError); }
  }

  const v = view;
  const s = v?.summary;
  return (
    <div className="page">
      <p className="subtle"><Link to="/tedarikciler">Tedarikçiler</Link> / <Link to="/tedarikciler/risk">Risk matrisi</Link> / Excel'den içe aktar</p>
      <PageHeader title="Excel'den içe aktar">
        Kurumun "BT Tedarikçi Risk Değerlendirme Tablosu" düzenindeki .xlsx dosyası: önce önizleme, sonra onayla uygulama. Mevcut değerlendirmelerin üzerine yazılmaz; her satırın bütün hücreleri saklanır.
      </PageHeader>
      {!batchId && <section className="panel mb-4" aria-labelledby="up-h">
        <div className="panel-head"><h2 id="up-h">1. Dosyayı yükleyin</h2></div>
        <div className="panel-body grid gap-3">
          <div className="flex flex-wrap items-end gap-2">
            <Field label="Risk tablosu (.xlsx)">{(p) => <input ref={fileRef} type="file" accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" className="input" {...p} />}</Field>
            <Button className="mb-4" disabled={busy} onClick={() => void upload()}><Icon name="upload" />Önizle</Button>
          </div>
          <UploadError e={uploadError} />
        </div>
      </section>}
      {batchId && r.loading && !v ? <Loading /> : batchId && r.error && !v ? <ErrorState error={r.error} onRetry={r.reload} /> : v && s && <>
        <section className="panel mb-4" aria-labelledby="file-h">
          <div className="panel-head"><h2 id="file-h">{v.batch.fileName}</h2><Tag label={{ text: BATCH_STATUS[v.batch.status] ?? v.batch.status, tone: v.batch.status === 'APPLIED' ? 'ok' : 'info', icon: v.batch.status === 'APPLIED' ? 'check' : 'clock' }} /></div>
          <div className="panel-body grid gap-3">
            <dl className="facts">
              <dt>Dönem (B1)</dt><dd className="tabular">{v.batch.period ?? 'okunamadı'}</dd>
              <dt>Ölçek</dt><dd>{v.scaleNote}</dd>
              <dt>Yükleyen</dt><dd>{v.batch.uploadedBy.displayName ?? '—'} · {fmtDateTime(v.batch.createdAt)}</dd>
            </dl>
            {v.can.edit ? <YearField year={v.batch.year} onApply={(y) => void patch({ year: y })} /> : <p>Değerlendirme yılı: <strong className="tabular">{v.batch.year}</strong></p>}
            {v.alreadyApplied && <Banner tone="warn" title="Bu dosya daha önce uygulandı">Aynı dosya (aynı içerik) ikinci kez uygulanamaz.</Banner>}
          </div>
        </section>
        <ErrorBanner error={error} />

        {v.teams.length > 0 && <section className="panel mb-4" aria-labelledby="team-h">
          <div className="panel-head"><h2 id="team-h">2. Ekip → departman eşlemesi</h2><span className="subtle">Eşlenmeyen ekibin değerlendirmesi departmansız açılır; Satınalma'ya görev düşer.</span></div>
          <Table aria-label="Ekip eşlemesi">
            <TableHeader><TableRow className="hover:bg-transparent"><TableHead scope="col">Excel ekibi</TableHead><TableHead scope="col" className="text-right">Satır</TableHead><TableHead scope="col">Departman</TableHead></TableRow></TableHeader>
            <TableBody>{v.teams.map((t) => (
              <TableRow key={t.team}>
                <TableCell className="font-semibold">{t.team}</TableCell><TableCell className="tabular text-right">{t.rowCount}</TableCell>
                <TableCell>{v.can.edit ? <select className="input h-9 w-auto min-w-48" aria-label={`${t.team} departmanı`} value={t.department?.id ?? ''}
                  onChange={(e) => void patch({ teamMapping: { [t.team]: e.target.value || null } })}>
                  <option value="">Eşlenmedi (departmansız)</option>{v.departments.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}</select>
                  : <DepartmentName name={t.department?.name} />}</TableCell>
              </TableRow>))}</TableBody>
          </Table>
        </section>}

        <section className="panel mb-4" aria-labelledby="rows-h">
          <div className="panel-head"><h2 id="rows-h">3. Satırlar</h2><span className="subtle">{s.rows} satır · {s.withIssues} satırda not</span></div>
          <Table aria-label="İçe aktarım önizlemesi">
            <TableHeader><TableRow className="hover:bg-transparent">
              <TableHead scope="col" className="text-right">Satır</TableHead><TableHead scope="col">Excel adı</TableHead><TableHead scope="col">Eşleşen kart / seçim</TableHead>
              <TableHead scope="col">Departman</TableHead><TableHead scope="col">Kritiklik · skor · seviye</TableHead><TableHead scope="col">Sorunlar</TableHead><TableHead scope="col">Karar</TableHead>
            </TableRow></TableHeader>
            <TableBody>{v.rows.map((x) => <ImportRowView key={x.rowNo} x={x} edit={v.can.edit} onPatch={(row) => patch({ rows: [{ rowNo: x.rowNo, ...row }] })} result={v.rowResults?.find((y) => y.rowNo === x.rowNo)} />)}</TableBody>
          </Table>
        </section>

        <section className="panel mb-4" aria-labelledby="sum-h">
          <div className="panel-head"><h2 id="sum-h">4. Özet</h2></div>
          <div className="panel-body grid gap-3">
            {v.batch.status === 'APPLIED' && (v.result ?? v.batch.result) ? <ResultSummary res={(v.result ?? v.batch.result)!} />
              : <p className="text-base" data-testid="import-summary"><strong className="tabular">{s.assessments}</strong> değerlendirme açılacak, <strong className="tabular">{s.completed}</strong> tamamlanmış,{' '}
                <strong className="tabular">{s.skipped + s.conflicts}</strong> atlanacak{s.conflicts ? ` (${s.conflicts} çakışma)` : ''}{s.merged ? `; ${s.merged} satır birincil satırın hizmetlerine eklenecek` : ''}
                {s.newCandidates ? `; ${s.newCandidates} yeni aday kart açılacak` : ''}.</p>}
            {v.batch.status === 'PREVIEW' && <div className="flex flex-wrap gap-2">
              {v.can.apply && <Button disabled={busy || v.alreadyApplied} onClick={() => setConfirm(true)}>Uygula</Button>}
              {v.can.discard && <Button variant="outline" disabled={busy} onClick={() => void discard()}>Vazgeç</Button>}
            </div>}
            {v.batch.status !== 'PREVIEW' && <div className="flex flex-wrap gap-2">
              <Button variant="outline" asChild><Link to={`/tedarikciler/risk?yil=${v.batch.year}`}>Risk matrisine git</Link></Button>
              <Button variant="ghost" onClick={() => { setView(null); setParams({}, { replace: true }); }}>Başka dosya yükle</Button></div>}
          </div>
        </section>
      </>}
      {confirm && v && s && <Modal title="İçe aktarımı uygula" onClose={() => setConfirm(false)} footer={<>
        <Button variant="outline" onClick={() => setConfirm(false)}>Vazgeç</Button><Button disabled={busy} onClick={() => void apply()}>Uygula</Button></>}>
        <p>{v.batch.year} yılı için {s.assessments} değerlendirme açılacak ({s.completed} tamamlanmış, {s.open} açık); {s.skipped + s.conflicts} satır atlanacak.
          Mevcut değerlendirmelerin üzerine yazılmaz. Aynı dosya ikinci kez uygulanamaz.</p>
      </Modal>}
    </div>
  );
}

function UploadError({ e }: { e: ApiError | null }) {
  if (!e) return null;
  const d = e.details ?? {};
  return (
    <Banner tone="danger" title={e.message}>
      {Array.isArray(d.foundSheets) && <p>Dosyadaki sayfalar: {d.foundSheets.join(', ') || '—'}. Beklenen: {d.expectedSheet ?? 'Risk Tablosu'}.</p>}
      {Array.isArray(d.expectedHeaders) && <div className="mt-2 overflow-x-auto" tabIndex={0} role="region" aria-label="Başlık karşılaştırması">
        <table className="data compact"><thead><tr><th scope="col">Sütun</th><th scope="col">Beklenen başlık</th><th scope="col">Dosyadaki başlık</th></tr></thead>
          <tbody>{(d.expectedHeaders as string[]).map((h, i) => {
            const f = (d.foundHeaders as (string | null)[] | undefined)?.[i] ?? '';
            return <tr key={i}><td className="mono">{String.fromCharCode(65 + i)}3</td><td>{h}</td><td className={cn(f.trim().toLocaleLowerCase('tr') !== h.trim().toLocaleLowerCase('tr') && 'font-semibold text-danger')}>{f || '(boş)'}</td></tr>;
          })}</tbody></table></div>}
    </Banner>
  );
}

function YearField({ year, onApply }: { year: number; onApply: (y: number) => void }) {
  const [y, setY] = useState(String(year));
  return (
    <form className="flex flex-wrap items-end gap-2" onSubmit={(e) => { e.preventDefault(); const n = Number(y); if (n >= 2000 && n <= 2100) onApply(n); }}>
      <Field label="Değerlendirme yılı" hint="Dönemden (B1) okunur; değiştirilebilir.">{(p) => <input className="input tabular w-28" inputMode="numeric" {...p} value={y} onChange={(e) => setY(e.target.value)} />}</Field>
      <Button type="submit" variant="outline" className="mb-4" disabled={y === String(year)}>Yılı uygula</Button>
    </form>
  );
}

function ResultSummary({ res }: { res: Record<string, number> }) {
  return <p role="status"><strong>Uygulandı:</strong> {res.created ?? 0} değerlendirme açıldı ({res.completed ?? 0} tamamlanmış, {res.open ?? 0} açık
    {res.completionBlocked ? `, ${res.completionBlocked} seviye 4–5 aksiyon planı bekliyor` : ''}), {res.skipped ?? 0} atlandı, {res.conflicts ?? 0} çakışma, {res.merged ?? 0} satır birleştirildi,
    {' '}{res.newCandidates ?? 0} aday kart, {res.actions ?? 0} aksiyon{res.needsDepartment ? `; ${res.needsDepartment} değerlendirme için sorumlu departman seçilmeli` : ''}.</p>;
}

function ImportRowView({ x, edit, onPatch, result }: { x: ImportRow; edit: boolean; onPatch: (b: Record<string, unknown>) => Promise<void>;
  result?: { outcome: string; assessmentId: string | null; blockers?: { message: string }[] } }) {
  const [picking, setPicking] = useState(false);
  const canDecide = edit && x.decision !== 'MERGE' && x.outcome !== 'CONFLICT';
  return (
    <TableRow>
      <TableCell className="tabular text-right align-top">{x.rowNo}</TableCell>
      <TableCell className="min-w-[180px] align-top"><span className="font-semibold">{x.name ?? '(ad yok)'}</span>
        {x.services && <span className="block text-sm text-ink-subtle">{x.services}</span>}
        {x.actionText && <span className="block text-sm text-ink-muted">K: {x.actionText}{x.createsAction ? ' (aksiyon olur)' : ''}</span>}
        {x.commentNote && <span className="block text-sm text-ink-muted">{/^Excel notu/i.test(x.commentNote) ? x.commentNote : `Excel notu: ${x.commentNote}`}</span>}</TableCell>
      <TableCell className="min-w-[220px] align-top">
        {x.supplier ? <Link to={`/tedarikciler/${x.supplier.id}`}>{x.supplier.name}</Link> : x.decision === 'NEW_CANDIDATE' ? <span>Yeni aday kart (VKN'siz, kimlik incelemesi gerekir)</span>
          : <span className="text-ink-subtle">Eşleşen kart yok</span>}
        {canDecide && <div className="mt-1.5 grid gap-1.5">
          <select className="input h-9" aria-label={`Satır ${x.rowNo} kararı`} value={picking ? 'PICK' : x.decision}
            onChange={(e) => { const val = e.target.value; if (val === 'PICK') { setPicking(true); return; } setPicking(false); void onPatch({ decision: val }); }}>
            {x.supplier && <option value="CREATE">Bu karta aktar</option>}
            <option value="SKIP">Atla</option>
            <option value="NEW_CANDIDATE">Yeni aday kart aç</option>
            <option value="PICK">Başka kart seç…</option>
          </select>
          {picking && <SupplierPicker rowNo={x.rowNo} initial={x.name ?? ''} onPick={(id) => { setPicking(false); void onPatch({ supplierId: id }); }} onCancel={() => setPicking(false)} />}
        </div>}
      </TableCell>
      <TableCell className="align-top">{x.team ? <span className="block text-sm text-ink-subtle">{x.team}</span> : null}<DepartmentName name={x.department?.name} /></TableCell>
      <TableCell className="whitespace-nowrap align-top text-sm">
        <span className="tabular block">{x.criticality ? `${x.criticality.display} (sütun ${x.criticality.column})` : 'Kritiklik yok'}</span>
        <span className="tabular block">{x.riskScore ? `Skor ${fmtScore(x.riskScore)}` : 'Skor yok'}</span>
        {x.level ? <Tag label={levelTag(x.level.level, x.level.label ?? RISK_LEVEL_TR[x.level.level])} /> : null}</TableCell>
      <TableCell className="min-w-[200px] align-top text-sm">{x.issues.length ? <ul className="grid gap-1">{x.issues.map((i, n) => <li key={n} className="flex gap-1.5"><Icon name="alert" size={14} className="mt-0.5 shrink-0 text-warn" />{i}</li>)}</ul> : <span className="text-ink-subtle">—</span>}</TableCell>
      <TableCell className="min-w-[160px] align-top text-sm">
        <span className={cn('font-semibold', x.outcome === 'CONFLICT' && 'text-warn')}>{x.outcomeLabel}</span>
        {x.decision === 'MERGE' && edit && <Button size="sm" variant="ghost" className="mt-1" onClick={() => void onPatch({ primary: true })}>Birincil yap</Button>}
        {x.primary && x.decision !== 'MERGE' && x.outcome !== 'SKIP' && <span className="block text-ink-subtle">Birincil satır</span>}
        {result && <span className="block">{result.outcome === 'completion_blocked' ? 'Açık kaldı: aksiyon planı bekliyor' : result.outcome === 'COMPLETED' ? 'Tamamlandı' : result.outcome === 'OPEN' ? 'Açık' : ''}
          {result.assessmentId && <> · <Link to={`/tedarikciler/risk/${result.assessmentId}`}>Değerlendirmeyi aç</Link></>}</span>}
        {!result && x.assessmentId && <Link className="block" to={`/tedarikciler/risk/${x.assessmentId}`}>Değerlendirmeyi aç</Link>}
      </TableCell>
    </TableRow>
  );
}

function SupplierPicker({ rowNo, initial, onPick, onCancel }: { rowNo: number; initial: string; onPick: (id: string) => void; onCancel: () => void }) {
  const [q, setQ] = useState(initial.replace(/\b(a\.?ş\.?|ltd\.?|şti\.?)\b/gi, '').trim().split(/\s+/).slice(0, 2).join(' '));
  const [term, setTerm] = useState(q);
  const res = useResource<{ items: { id: string; legalName: string; status: string }[] }>(term.trim().length >= 2 ? `/api/v1/suppliers?q=${encodeURIComponent(term.trim())}` : null);
  const options = useMemo(() => (res.data?.items ?? []).filter((s) => s.status !== 'REJECTED'), [res.data]);
  return (
    <div className="grid gap-1.5 rounded-md border border-border bg-paper p-2">
      <form className="flex gap-1.5" onSubmit={(e) => { e.preventDefault(); setTerm(q); }}>
        <input className="input h-9 min-w-0 flex-1" aria-label={`Satır ${rowNo} için kart ara`} value={q} onChange={(e) => setQ(e.target.value)} />
        <Button size="sm" type="submit" variant="outline">Ara</Button>
      </form>
      {res.loading ? <span className="text-sm text-ink-subtle">Aranıyor…</span> : options.length ? <ul className="grid gap-1">{options.slice(0, 8).map((o) => (
        <li key={o.id}><button type="button" className="text-left text-sm underline" onClick={() => onPick(o.id)}>{o.legalName}</button></li>))}</ul>
        : term.trim().length >= 2 ? <span className="text-sm text-ink-subtle">Kart bulunamadı.</span> : null}
      <Button size="sm" variant="ghost" className="justify-self-start" onClick={onCancel}>Vazgeç</Button>
    </div>
  );
}

// =====================================================================================================================
// Tedarikçi kartı "Yıllık risk" sekmesi
// =====================================================================================================================

interface HistoryItem {
  id: string; year: number; status: string; department: Ref | null; level: number | null; levelLabel: string | null; riskScore: string | null; scoreSource: string | null;
  criticality: string | null; criticalityDisplay: string | null; column: number | null; band: number | null; revisionCount: number;
  lastReview: { period: string; outcome: string } | null; openActions: Action[]; contributor: boolean;
}

export function SupplierAnnualRisk({ supplierId }: { supplierId: string }) {
  const h = useResource<{ items: HistoryItem[] }>(`/api/v1/suppliers/${supplierId}/risk-history`);
  const items = h.data?.items ?? [];
  const live = items.filter((x) => x.status !== 'CANCELLED');
  // Son seviye: en yeni tamamlanmış (çeyreklik güncelleme sürerken de son revizyon); yoksa en yeni kayıt.
  const latestScored = live.find((x) => x.level !== null) ?? null;
  const latest = live[0] ?? null;
  const detail = useResource<RiskDetail>(latest ? `/api/v1/risk/assessments/${latest.id}` : null);
  if (h.loading && !h.data) return <Loading />;
  if (h.error || !h.data) return <ErrorState error={h.error} onRetry={h.reload} />;
  if (!items.length) return <div className="rounded-md border border-border bg-surface"><Empty icon="shield" title="Yıllık risk değerlendirmesi yok">
    Değerlendirme yıl başında yürürlükte sözleşmesi olan tedarikçiler için açılır ya da Excel'den içe aktarılır. <Link to="/tedarikciler/risk">Risk matrisi</Link></Empty></div>;
  const openActions = live.flatMap((x) => x.openActions.map((a) => ({ ...a, year: x.year })));
  return (
    <div className="grid gap-4">
      <div className="grid items-start gap-4 min-[1100px]:grid-cols-[minmax(0,1fr)_minmax(300px,380px)]">
        <section className="panel" aria-labelledby="yr-h">
          <div className="panel-head"><h2 id="yr-h">Yıllık risk seviyesi</h2>
            {latest && <Button size="sm" asChild className="ml-auto"><Link to={`/tedarikciler/risk/${latest.id}`}>Değerlendirmeyi aç</Link></Button>}</div>
          <div className="panel-body grid gap-3">
            {latestScored ? <>
              <div className="flex flex-wrap items-center gap-x-6 gap-y-2">
                <Tag label={levelTag(latestScored.level, latestScored.levelLabel)} />
                <span className="text-sm">{latestScored.year} · kritiklik <span className="tabular font-semibold">{latestScored.criticalityDisplay}</span> · risk skoru <span className="tabular font-semibold">{fmtScore(latestScored.riskScore)}</span>
                  {latestScored.scoreSource ? ` · ${SCORE_SOURCE_TR[latestScored.scoreSource]}` : ''}</span>
              </div>
              <p className="text-sm text-ink-muted">Matris hücresi: risk {latestScored.band ? RISK_BAND_LABEL[latestScored.band] : '—'}, kritiklik {latestScored.column}. Anket riski (içsel/kalan) "Değerlendirme ve risk" sekmesinde ayrı tutulur.</p>
            </> : <p className="text-ink-muted">Henüz skorlanmış yıllık değerlendirme yok.</p>}
            <Table aria-label="Yıllar">
              <TableHeader><TableRow className="hover:bg-transparent"><TableHead scope="col">Yıl</TableHead><TableHead scope="col">Durum</TableHead><TableHead scope="col" className="max-[1300px]:hidden">Departman</TableHead>
                <TableHead scope="col" className="text-right">Kritiklik</TableHead><TableHead scope="col" className="text-right">Skor</TableHead><TableHead scope="col">Seviye</TableHead>
                <TableHead scope="col" className="max-[1100px]:hidden">Son gözden geçirme</TableHead><TableHead scope="col"><span className="sr-only">Aç</span></TableHead></TableRow></TableHeader>
              <TableBody>{items.map((x) => (
                <TableRow key={x.id}>
                  <TableCell className="tabular font-semibold">{x.year}<span className="hidden text-sm font-normal text-ink-subtle max-[1300px]:block"><DepartmentName name={x.department?.name} /></span></TableCell>
                  <TableCell><Tag label={statusTag(x.status)} /></TableCell>
                  <TableCell className="max-[1300px]:hidden"><DepartmentName name={x.department?.name} /></TableCell>
                  <TableCell className="tabular text-right">{x.criticalityDisplay ?? '—'}</TableCell>
                  <TableCell className="tabular text-right">{fmtScore(x.riskScore)}</TableCell>
                  <TableCell>{x.level ? <Tag label={levelTag(x.level, x.levelLabel)} /> : '—'}</TableCell>
                  <TableCell className="min-w-[110px] text-sm max-[1100px]:hidden">{x.lastReview ? `${x.lastReview.period} · ${REVIEW_OUTCOME_TR[x.lastReview.outcome] ?? ''}` : '—'}</TableCell>
                  <TableCell><Link to={`/tedarikciler/risk/${x.id}`} aria-label={`${x.year} değerlendirmesini aç`}>Aç</Link></TableCell>
                </TableRow>))}</TableBody>
            </Table>
          </div>
        </section>
        <section className="panel" aria-labelledby="yrm-h">
          <div className="panel-head"><h2 id="yrm-h">Matris hücresi</h2></div>
          <div className="panel-body"><RiskMatrix compact caption="Son yıllık risk değerlendirmesinin matris hücresi"
            highlight={latestScored?.band && latestScored.column ? { band: latestScored.band, column: latestScored.column } : null} /></div>
        </section>
      </div>
      <section className="panel" aria-labelledby="yra-h">
        <div className="panel-head"><h2 id="yra-h">Açık aksiyonlar</h2></div>
        {!openActions.length ? <div className="panel-body text-ink-muted">Açık aksiyon yok.</div> : (
          <ul className="grid">{openActions.map((a) => (
            <li key={a.id} className="flex flex-wrap items-baseline gap-x-3 gap-y-1 border-b border-border px-4 py-2.5 last:border-0">
              <span className="text-sm text-ink-muted">{a.year} · {ACTION_KIND_TR[a.kind]}{a.controlMethodLabel ? ` · ${a.controlMethodLabel}` : ''}</span>
              <span className="min-w-0 flex-1 font-semibold">{a.title}</span>
              <span className="text-sm text-ink-subtle">{a.owner?.displayName ?? a.ownerText ?? 'sorumlu seçilmedi'} · {fmtDate(a.dueOn)}</span>
            </li>))}</ul>)}
      </section>
      <section className="panel" aria-labelledby="yro-h">
        <div className="panel-head"><h2 id="yro-h">Görüşler{latest ? ` (${latest.year})` : ''}</h2></div>
        <div className="panel-body">{detail.loading && !detail.data ? <Loading rows={2} /> : detail.data?.opinions.length ? <ul className="grid gap-3">{detail.data.opinions.map((o) => (
          <li key={o.id} className="grid gap-0.5"><span className="text-sm text-ink-subtle">{o.department?.name ?? 'Satınalma'} · {o.author.displayName ?? '—'} · {fmtDateTime(o.createdAt)}</span><span className="whitespace-pre-wrap">{o.body}</span></li>))}</ul>
          : <p className="text-ink-muted">Görüş yok.</p>}</div>
      </section>
    </div>
  );
}

// =====================================================================================================================
// Raporlar kartı
// =====================================================================================================================

export function RiskReportCard() {
  const year = currentYear();
  const m = useResource<Matrix>(`/api/v1/risk/matrix?year=${year}`);
  if (m.error) return null;
  const byLevel = [1, 2, 3, 4, 5].map((lv) => (m.data?.cells ?? []).filter((c) => c.level === lv).reduce((s, c) => s + c.count, 0));
  return (
    <section className="panel mb-4" aria-labelledby="rr-h">
      <div className="panel-head"><h2 id="rr-h">Yıllık risk matrisi ({year})</h2>
        <Button size="sm" variant="outline" asChild className="ml-auto"><Link to="/tedarikciler/risk">Risk matrisini aç</Link></Button></div>
      <div className="panel-body">{!m.data ? <Loading rows={2} /> : <div className="grid items-start gap-4 min-[900px]:grid-cols-[minmax(260px,360px)_minmax(0,1fr)]">
        <RiskMatrix compact caption={`${year} risk matrisi: hücrede değerlendirme sayısı`} cells={m.data.cells} />
        <dl className="facts">
          {byLevel.map((n, i) => <Fragment2 key={i} dt={RISK_LEVEL_TR[i + 1]!} dd={<span className="tabular">{n}</span>} />)}
          <Fragment2 dt="Skorsuz" dd={<span className="tabular">{m.data.unscored}</span>} />
          <Fragment2 dt="Açık / gecikmiş" dd={<span className="tabular">{m.data.byStatus.OPEN} / {m.data.byStatus.overdue}</span>} />
          <Fragment2 dt="Tamamlandı" dd={<span className="tabular">{m.data.byStatus.COMPLETED}</span>} />
        </dl>
      </div>}</div>
    </section>
  );
}
function Fragment2({ dt, dd }: { dt: string; dd: ReactNode }) { return <><dt>{dt}</dt><dd>{dd}</dd></>; }
