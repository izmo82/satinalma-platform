import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api, ApiError } from '../lib/api.ts';
import { useResource } from '../lib/useApi.ts';
import { fmtDate, fmtDateTime } from '../lib/format.ts';
import { todayLocal } from '../lib/format.ts';
import type { Label } from '../lib/labels.ts';
import { Banner, Empty, ErrorState, Field, Loading, Tag } from '../ui/kit.tsx';
import { Icon } from '../ui/icons.tsx';
import { DepartmentSelect } from '../ui/Departments.tsx';
import { Button } from '@/components/ui/button';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { cn } from '@/lib/utils';

// Tedarikçi değerlendirmesi (02 §8–9): risk ve performans ayrı; kritik engel ortalamayla aşılmaz; iddia ≠ doğrulanmış olay.
export const OUTCOME: Record<string, Label> = {
  BLOCKED: { text: 'Kritik engel', tone: 'danger', icon: 'x' }, INCOMPLETE: { text: 'Eksik / bilinmiyor', tone: 'warn', icon: 'help' },
  CONDITIONAL: { text: 'Bulgulu', tone: 'warn', icon: 'alert' }, ACCEPTABLE: { text: 'Kabul edilebilir', tone: 'ok', icon: 'check' },
};
export const LEVEL: Record<string, Label> = {
  LOW: { text: 'Düşük', tone: 'neutral', icon: 'minus' }, MEDIUM: { text: 'Orta', tone: 'info', icon: 'info' },
  HIGH: { text: 'Yüksek', tone: 'warn', icon: 'alert' }, CRITICAL: { text: 'Kritik', tone: 'danger', icon: 'x' },
};
export const INCIDENT_STATUS: Record<string, Label> = {
  REPORTED: { text: 'Bildirildi (iddia)', tone: 'neutral', icon: 'inbox' }, UNDER_REVIEW: { text: 'İnceleniyor', tone: 'info', icon: 'clock' },
  VERIFIED: { text: 'Doğrulandı', tone: 'human', icon: 'stamp' }, REJECTED: { text: 'Doğrulanmadı', tone: 'neutral', icon: 'minus' }, CLOSED: { text: 'Kapandı', tone: 'ok', icon: 'check' },
};
export const CATEGORY: Record<string, string> = {
  QUALITY: 'Kalite kusuru', DELAY: 'Gecikme', OUTAGE: 'Kesinti', SLA: 'SLA ihlali', INVOICE_DISPUTE: 'Fatura ihtilafı', SECURITY: 'Güvenlik', PERSONAL_DATA: 'Kişisel veri', ETHICS: 'Etik ihlal',
};
export const FACTORS = [['dataSensitivity', 'Veri hassasiyeti'], ['accessLevel', 'Erişim seviyesi'], ['criticality', 'Hizmet kritikliği'],
  ['substitutability', 'İkame güçlüğü'], ['subcontractorDependence', 'Alt yüklenici bağımlılığı']] as const;
const LMH = [['LOW', 'Düşük'], ['MEDIUM', 'Orta'], ['HIGH', 'Yüksek']] as const;
const today = () => todayLocal();

export function SupplierEvaluation({ tab, supplierId }: { tab: string; supplierId: string }) {
  if (tab === 'olaylar') return <IncidentsTab supplierId={supplierId} />;
  if (tab === 'karne') return <ScorecardTab supplierId={supplierId} />;
  return <AssessmentsTab supplierId={supplierId} />;
}

interface AssessmentRow { id: string; scope: string; status: string; template: string; category: string; outcome: string; complianceRate: number | null; blockers: number; findings: number;
  inherent: string; residual: string | null; createdAt: string; reviewDue: string | null }

function AssessmentsTab({ supplierId }: { supplierId: string }) {
  const r = useResource<{ items: AssessmentRow[]; can: { manage: boolean } }>(`/api/v1/suppliers/${supplierId}/assessments`);
  const [creating, setCreating] = useState(false);
  if (r.loading && !r.data) return <Loading />;
  if (r.error || !r.data) return <ErrorState error={r.error} onRetry={r.reload} />;
  const current = r.data.items.filter((x) => x.status !== 'SUPERSEDED');
  const blocked = current.filter((x) => x.outcome === 'BLOCKED' && x.status === 'REVIEWED');
  return (
    <div className="grid gap-4">
      {blocked.length > 0 && <Banner tone="danger" title="Kritik engel: yeni seçim engelli">
        {blocked.map((x) => x.scope).join(', ')}. Yeni seçim önerisi ve seçim onayı engellenir; ticari veya ağırlıklı puan bu engeli aşmaz. Engel, incelemesi tamamlanan yeni değerlendirmeyle giderilir.</Banner>}
      <div className="flex flex-wrap items-center gap-2">
        <p className="min-w-0 flex-1 text-ink-muted">Hizmete özel anket: aynı firma farklı hizmetler için farklı değerlendirilir. Eksik yanıt başarılı sayılmaz.</p>
        <Button variant="outline" asChild><Link to="/tedarikciler/anketler">Anket şablonları</Link></Button>
        {r.data.can.manage && !creating && <Button onClick={() => setCreating(true)}>Değerlendirme başlat</Button>}
      </div>
      {creating && <NewAssessment supplierId={supplierId} onCancel={() => setCreating(false)} />}
      {!r.data.items.length ? <div className="rounded-md border border-border bg-surface"><Empty icon="shield" title="Değerlendirme yok">Hizmet kapsamına uygun anketle başlatın.</Empty></div> : (
        <Table>
          <TableHeader><TableRow className="hover:bg-transparent"><TableHead>Kapsam</TableHead><TableHead>Sonuç</TableHead><TableHead className="text-right">Uyum</TableHead>
            <TableHead>İçsel risk</TableHead><TableHead>Kalan risk</TableHead><TableHead className="max-[900px]:hidden">Tarih</TableHead></TableRow></TableHeader>
          <TableBody>{r.data.items.map((x) => (
            <TableRow key={x.id} className={cn(x.status === 'SUPERSEDED' && 'opacity-60')}>
              <TableCell className="min-w-[220px]"><Link className="font-semibold text-ink no-underline hover:underline" to={`/degerlendirmeler/${x.id}`}>{x.scope}</Link>
                <span className="block text-sm text-ink-subtle">{x.template}{x.status === 'SUPERSEDED' ? ' · yerini yenisi aldı' : x.status === 'OPEN' ? ' · inceleme sürüyor' : ''}</span></TableCell>
              <TableCell><Tag label={OUTCOME[x.outcome]} />{x.blockers > 0 && <span className="block text-sm text-danger">{x.blockers} engel</span>}</TableCell>
              <TableCell className="tabular text-right">{x.complianceRate === null ? '—' : `%${x.complianceRate}`}</TableCell>
              <TableCell><Tag label={LEVEL[x.inherent]} /></TableCell>
              <TableCell>{x.residual ? <Tag label={LEVEL[x.residual]} /> : <span className="text-sm text-ink-subtle">Henüz kabul edilmedi</span>}</TableCell>
              <TableCell className="whitespace-nowrap text-sm text-ink-subtle max-[900px]:hidden">{fmtDate(x.createdAt)}</TableCell>
            </TableRow>
          ))}</TableBody>
        </Table>
      )}
      <p className="text-sm text-ink-subtle">Uyum oranı bilgi amaçlıdır; sonuç kararını kritik kontroller, bulgular ve kanıt geçerliliği belirler.</p>
    </div>
  );
}

function NewAssessment({ supplierId, onCancel }: { supplierId: string; onCancel: () => void }) {
  const navigate = useNavigate();
  const t = useResource<{ items: { id: string; code: string; version: number; name: string; category: string; status: string; questions: number; critical: number }[] }>('/api/v1/questionnaire-templates');
  const [f, setF] = useState({ templateId: '', scope: '', reviewDue: '', departmentId: '' });
  const [factors, setFactors] = useState<Record<string, string>>(Object.fromEntries(FACTORS.map(([k]) => [k, 'LOW'])));
  const [err, setErr] = useState<string | null>(null);
  const published = (t.data?.items ?? []).filter((x) => x.status === 'PUBLISHED');
  return (
    <form className="panel" onSubmit={(e) => { e.preventDefault(); setErr(null);
      void api<{ id: string }>('/api/v1/assessments', { method: 'POST', json: { supplierId, templateId: f.templateId, scope: f.scope, reviewDue: f.reviewDue || null, departmentId: f.departmentId, inherentFactors: factors } })
        .then((r) => navigate(`/degerlendirmeler/${r.data.id}`), (x: ApiError) => setErr(x.message)); }}>
      <div className="panel-head"><h2>Değerlendirme başlat</h2></div>
      <div className="panel-body grid gap-3">
        <div className="grid grid-cols-2 items-start gap-x-3 max-[900px]:grid-cols-1">
          <Field label="Anket şablonu">{(p) => <select className="input" required {...p} value={f.templateId} onChange={(e) => setF({ ...f, templateId: e.target.value })}>
            <option value="">Seçin</option>{published.map((x) => <option key={x.id} value={x.id}>{x.name} v{x.version} · {x.category} ({x.questions} soru, {x.critical} kritik)</option>)}</select>}</Field>
          <Field label="Hizmet kapsamı" hint="Ör. uzak erişimli sunucu bakımı">{(p) => <input className="input" required minLength={3} {...p} value={f.scope} onChange={(e) => setF({ ...f, scope: e.target.value })} />}</Field>
          <Field label="Yeniden inceleme tarihi">{(p) => <input className="input" type="date" {...p} value={f.reviewDue} onChange={(e) => setF({ ...f, reviewDue: e.target.value })} />}</Field>
          {/* v2 (D93): değerlendirme departman taşır; form her rolde departman ister (departman kullanıcısı yalnız kendi departmanını görür). */}
          <DepartmentSelect value={f.departmentId} onChange={(v) => setF((x) => ({ ...x, departmentId: v }))} />
        </div>
        <fieldset className="grid grid-cols-5 items-start gap-3 max-[1100px]:grid-cols-2">
          <legend className="mb-2 font-semibold">İçsel risk (kontrollerden önce)</legend>
          {FACTORS.map(([k, l]) => <Field key={k} label={l}>{(p) => <select className="input" {...p} value={factors[k]} onChange={(e) => setFactors({ ...factors, [k]: e.target.value })}>
            {LMH.map(([v, t]) => <option key={v} value={v}>{t}</option>)}</select>}</Field>)}
        </fieldset>
        {!published.length && !t.loading && <Banner tone="warn" title="Yayımlanmış anket şablonu yok">Önce bir Satınalma veya Departman kullanıcısı şablon yayımlamalı.</Banner>}
        <div className="flex gap-2"><Button type="submit">Başlat</Button><Button type="button" variant="ghost" onClick={onCancel}>Vazgeç</Button></div>
        {err && <Banner tone="danger" title={err} />}
      </div>
    </form>
  );
}

interface IncidentRow { id: string; code: string; title: string; occurredOn: string; severity: string; category: string; status: string; disputeOpen: boolean; duplicateOfId: string | null;
  countedInMetric: boolean; supplierName: string; supplierId: string; openActions: number; awaitingVerification: number }

export function IncidentTable({ items, showSupplier }: { items: IncidentRow[]; showSupplier?: boolean }) {
  return (
    <Table>
      <TableHeader><TableRow className="hover:bg-transparent"><TableHead>Olay</TableHead>{showSupplier && <TableHead>Tedarikçi</TableHead>}<TableHead>Durum</TableHead>
        <TableHead>Şiddet</TableHead><TableHead className="max-[900px]:hidden">Kategori</TableHead><TableHead>Tarih</TableHead></TableRow></TableHeader>
      <TableBody>{items.map((x) => (
        <TableRow key={x.id}>
          <TableCell className="min-w-[220px]"><Link className="font-semibold text-ink no-underline hover:underline" to={`/tedarikciler/olaylar/${x.id}`}>{x.code}</Link>
            <span className="block text-sm text-ink-muted">{x.title}</span>
            {(x.duplicateOfId || x.openActions > 0 || x.awaitingVerification > 0) && <span className="block text-sm text-ink-subtle">{x.duplicateOfId ? 'Mükerrer'
              : [x.openActions && `${x.openActions} açık faaliyet`, x.awaitingVerification && `${x.awaitingVerification} doğrulama bekliyor`].filter(Boolean).join(' · ')}</span>}</TableCell>
          {showSupplier && <TableCell><Link to={`/tedarikciler/${x.supplierId}?sekme=olaylar`}>{x.supplierName}</Link></TableCell>}
          <TableCell><Tag label={INCIDENT_STATUS[x.status]} />{x.disputeOpen && <span className="block text-sm text-warn">İtiraz açık</span>}</TableCell>
          <TableCell><Tag label={LEVEL[x.severity]} /></TableCell>
          <TableCell className="text-sm max-[900px]:hidden">{CATEGORY[x.category]}</TableCell>
          <TableCell className="whitespace-nowrap text-sm text-ink-subtle">{fmtDate(x.occurredOn)}</TableCell>
        </TableRow>
      ))}</TableBody>
    </Table>
  );
}

function IncidentsTab({ supplierId }: { supplierId: string }) {
  const r = useResource<{ items: IncidentRow[]; can: { report: boolean } }>(`/api/v1/incidents?supplierId=${supplierId}`);
  const [creating, setCreating] = useState(false);
  if (r.loading && !r.data) return <Loading />;
  if (r.error || !r.data) return <ErrorState error={r.error} onRetry={r.reload} />;
  return (
    <div className="grid gap-4">
      <div className="flex flex-wrap items-center gap-2">
        <p className="min-w-0 flex-1 text-ink-muted">İddia ile doğrulanmış bulgu ayrıdır. Puan etkisi yalnız doğrulanmış, itirazı kapanmış ve mükerrer olmayan olaylara uygulanır.</p>
        {r.data.can.report && !creating && <Button onClick={() => setCreating(true)}><Icon name="alert" />Olay bildir</Button>}
      </div>
      {creating && <ReportIncident supplierId={supplierId} onCancel={() => setCreating(false)} onReported={() => void r.reload()} />}
      {!r.data.items.length ? <div className="rounded-md border border-border bg-surface"><Empty icon="check" title="Olay kaydı yok" /></div> : <IncidentTable items={r.data.items} />}
    </div>
  );
}

function ReportIncident({ supplierId, onCancel, onReported }: { supplierId: string; onCancel: () => void; onReported: () => void }) {
  const navigate = useNavigate();
  const [f, setF] = useState({ category: 'QUALITY', severity: 'MEDIUM', title: '', description: '', impact: '', location: '', occurredOn: today() });
  const [err, setErr] = useState<string | null>(null);
  const [dups, setDups] = useState<{ created: { id: string; code: string }; list: { id: string; code: string; title: string; occurredOn: string }[] } | null>(null);
  if (dups) return (
    <Banner tone="warn" title={`${dups.created.code} kaydedildi; ${dups.list.length} olası mükerrer olay var`} action={<Button size="sm" onClick={() => navigate(`/tedarikciler/olaylar/${dups.created.id}`)}>Olayı aç</Button>}>
      {dups.list.map((x) => `${x.code} (${fmtDate(x.occurredOn)}) ${x.title}`).join(' · ')}. Otomatik birleştirilmedi; ön incelemede mükerrer olarak işaretlenebilir.
    </Banner>
  );
  return (
    <form className="panel" onSubmit={(e) => { e.preventDefault(); setErr(null);
      void api<{ id: string; code: string; possibleDuplicates: { id: string; code: string; title: string; occurredOn: string }[] }>('/api/v1/incidents', { method: 'POST',
        json: { supplierId, ...f, impact: f.impact || null, location: f.location || null } })
        .then((r) => { if (r.data.possibleDuplicates.length) { setDups({ created: r.data, list: r.data.possibleDuplicates }); onReported(); } else navigate(`/tedarikciler/olaylar/${r.data.id}`); }, (x: ApiError) => setErr(x.message)); }}>
      <div className="panel-head"><h2>Olay bildir</h2><span className="text-sm text-ink-subtle">Bildirim iddiadır; doğrulama başka bir yetkilinindir.</span></div>
      <div className="panel-body grid gap-3">
        <div className="grid grid-cols-3 items-start gap-x-3 max-[900px]:grid-cols-1">
          <Field label="Kategori">{(p) => <select className="input" {...p} value={f.category} onChange={(e) => setF({ ...f, category: e.target.value })}>{Object.entries(CATEGORY).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select>}</Field>
          <Field label="Şiddet (bildirene göre)">{(p) => <select className="input" {...p} value={f.severity} onChange={(e) => setF({ ...f, severity: e.target.value })}>{Object.entries(LEVEL).map(([k, v]) => <option key={k} value={k}>{v.text}</option>)}</select>}</Field>
          <Field label="Olay tarihi">{(p) => <input className="input" type="date" required max={today()} {...p} value={f.occurredOn} onChange={(e) => setF({ ...f, occurredOn: e.target.value })} />}</Field>
        </div>
        <Field label="Başlık">{(p) => <input className="input" required minLength={5} {...p} value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} />}</Field>
        <Field label="Ne oldu" hint="Gözlenen olay; suçlama değil.">{(p) => <textarea className="input" rows={3} required minLength={10} {...p} value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} />}</Field>
        <div className="grid grid-cols-2 items-start gap-x-3 max-[900px]:grid-cols-1">
          <Field label="Etki (varsa)">{(p) => <input className="input" {...p} value={f.impact} onChange={(e) => setF({ ...f, impact: e.target.value })} />}</Field>
          <Field label="Lokasyon (varsa)">{(p) => <input className="input" {...p} value={f.location} onChange={(e) => setF({ ...f, location: e.target.value })} />}</Field>
        </div>
        <div className="flex gap-2"><Button type="submit">Bildir</Button><Button type="button" variant="ghost" onClick={onCancel}>Vazgeç</Button></div>
        {err && <Banner tone="danger" title={err} />}
      </div>
    </form>
  );
}

interface Scorecard {
  supplier: { id: string; name: string; status: string }; year: number; dataAsOf: string; policy: { incident: string; weights: string | null; minSample: number };
  performance: { score: number | null; base?: number; insufficient: boolean; reason: string | null; sample: number;
    review: null | { period: [string, string]; category: string; basis: string; reviewer: string; reviewedAt: string };
    dimensions: { key: string; label: string; score: number | null; weight: number }[] };
  previous: { year: number; score: number | null; insufficient: boolean }; reviewCount: number;
  incidents: { total: number; counted: number; penalty: number; items: { id: string; code: string; title: string; occurredOn: string; severity: string; status: string; counted: boolean; reason: string | null }[] };
  openActions: { title: string; dueDate: string; status: string; code: string }[];
  assessments: AssessmentRow[]; narrative: string[]; sources: string[];
  can: { review: boolean };
}

function ScorecardTab({ supplierId }: { supplierId: string }) {
  const [year, setYear] = useState(new Date().getFullYear());
  const r = useResource<Scorecard>(`/api/v1/suppliers/${supplierId}/scorecard?year=${year}`);
  const [reviewing, setReviewing] = useState(false);
  if (r.loading && !r.data) return <Loading />;
  if (r.error || !r.data) return <ErrorState error={r.error} onRetry={r.reload} />;
  const d = r.data;
  return (
    <div className="grid gap-4">
      <div className="flex flex-wrap items-end gap-3">
        <Field label="Yıl">{(p) => <select className="input w-28" {...p} value={year} onChange={(e) => setYear(Number(e.target.value))}>
          {[0, 1, 2].map((n) => new Date().getFullYear() - n).map((y) => <option key={y} value={y}>{y}</option>)}</select>}</Field>
        <p className="min-w-0 flex-1 pb-2 text-sm text-ink-subtle">Veri anı {fmtDateTime(d.dataAsOf)} · olay politikası {d.policy.incident} · en az {d.policy.minSample} kabul kaydı</p>
        {d.can.review && !reviewing && <Button variant="outline" onClick={() => setReviewing(true)}>Performans incelemesi gir</Button>}
      </div>
      {reviewing && <PerformanceForm supplierId={supplierId} year={year} onDone={() => { setReviewing(false); void r.reload(); }} />}
      <div className="grid grid-cols-[minmax(0,1fr)_360px] gap-5 max-[1100px]:grid-cols-1">
        <section className="panel">
          <div className="panel-head"><h2>{d.year} performansı</h2>{d.previous.score !== null && <span className="text-sm text-ink-subtle">{d.previous.year}: {d.previous.score}</span>}</div>
          <div className="panel-body grid gap-3">
            {d.performance.score === null
              ? <Banner tone="neutral" icon="help" title="Yetersiz veri; puan verilmedi">{d.performance.reason}</Banner>
              : <p className="tabular text-3xl font-bold">{d.performance.score}<span className="ml-2 text-base font-normal text-ink-muted">/ 100 · boyut ortalaması {d.performance.base}, olay cezası −{d.incidents.penalty}</span></p>}
            <Table>
              <TableHeader><TableRow className="hover:bg-transparent"><TableHead>Boyut</TableHead><TableHead className="text-right">Ağırlık</TableHead><TableHead className="text-right">Puan</TableHead></TableRow></TableHeader>
              <TableBody>{d.performance.dimensions.map((x) => (
                <TableRow key={x.key}><TableCell>{x.label}</TableCell><TableCell className="tabular text-right">%{x.weight}</TableCell><TableCell className="tabular text-right">{x.score ?? '—'}</TableCell></TableRow>
              ))}</TableBody>
            </Table>
            <p className="text-sm text-ink-muted">Örneklem: {d.performance.sample} kabul kaydı (puan için en az {d.policy.minSample}).{d.reviewCount > 1 ? ` Bu yıl ${d.reviewCount} inceleme var; puan en son incelemeye dayanır.` : ''}{d.performance.review ? ` İnceleme: ${d.performance.review.reviewer}, ${fmtDate(d.performance.review.period[0])}–${fmtDate(d.performance.review.period[1])}. Dayanak: ${d.performance.review.basis}` : ''}</p>
          </div>
        </section>
        <aside className="grid content-start gap-4">
          <section className="panel"><div className="panel-head"><h2>Özet</h2></div>
            <div className="panel-body"><ul className="grid list-disc gap-1.5 pl-5">{d.narrative.map((n, i) => <li key={i}>{n}</li>)}</ul>
              <p className="mt-3 text-sm text-ink-subtle">Kaynak: {d.sources.join(' · ')}. Anlatı kurallarla üretilir; AI kullanılmadı.</p></div></section>
          {d.openActions.length > 0 && <section className="panel"><div className="panel-head"><h2>Açık düzeltici faaliyet</h2></div>
            <div className="panel-body"><ul className="grid gap-1.5">{d.openActions.map((a, i) => <li key={i}><strong>{a.code}</strong> {a.title} <span className="text-sm text-ink-subtle">· hedef {fmtDate(a.dueDate)}</span></li>)}</ul></div></section>}
        </aside>
      </div>
      <section className="panel">
        <div className="panel-head"><h2>Olaylar ve puan etkisi</h2><span className="text-sm text-ink-subtle">{d.incidents.counted}/{d.incidents.total} olay puana yansıdı</span></div>
        <div className="panel-body">{!d.incidents.items.length ? <p className="text-ink-muted">Bu yıl olay yok.</p> : (
          <ul className="grid gap-2">{d.incidents.items.map((x) => (
            <li key={x.id} className="flex flex-wrap items-baseline gap-x-2"><Link to={`/tedarikciler/olaylar/${x.id}`} className="font-semibold">{x.code}</Link><span>{x.title}</span>
              <Tag label={LEVEL[x.severity]} /><span className={cn('text-sm', x.counted ? 'text-danger' : 'text-ink-subtle')}>{x.counted ? 'Puana yansıdı' : x.reason}</span></li>))}</ul>)}</div>
      </section>
    </div>
  );
}

export interface WeightPolicy { id: string; category: string; weights: Record<string, number>; reason: string; setBy: string; createdAt: string; retiredAt: string | null }
export const DEFAULT_W: Record<string, number> = { quality: 30, delivery: 25, sla: 20, communication: 10, commercial: 15 };
const SHORT: Record<string, string> = { quality: 'kalite', delivery: 'teslimat', sla: 'SLA', communication: 'iletişim', commercial: 'ticari' };
export const weightText = (w: Record<string, number>) => DIMS.map(([k]) => `${SHORT[k]} %${w[k] ?? 0}`).join(', ');
export const DIMS = [['quality', 'Kalite'], ['delivery', 'Zamanında ve tam teslimat'], ['sla', 'SLA'], ['communication', 'İletişim'], ['commercial', 'Ticari uyum']] as const;
function PerformanceForm({ supplierId, year, onDone }: { supplierId: string; year: number; onDone: () => void }) {
  const end = `${year}-12-31` > todayLocal() ? todayLocal() : `${year}-12-31`;
  const [f, setF] = useState({ periodStart: `${year}-01-01`, periodEnd: end, category: '', basis: '' });
  const [scores, setScores] = useState<Record<string, string>>({});
  const [err, setErr] = useState<string | null>(null);
  const policies = useResource<{ items: WeightPolicy[] }>('/api/v1/performance-weights');
  // Sunucu kategoriyi PostgreSQL lower() ile eşler; ekran aynı (dil bağımsız) küçültmeyi kullanır, yoksa "I"/"ı" farkı yanıltır.
  const key = f.category.trim().toLowerCase();
  const applied = key ? policies.data?.items.find((x) => !x.retiredAt && x.category.trim().toLowerCase() === key) : undefined;
  return (
    <form className="panel" onSubmit={(e) => { e.preventDefault(); setErr(null);
      void api(`/api/v1/suppliers/${supplierId}/performance-reviews`, { method: 'POST', json: { ...f, scores: Object.fromEntries(Object.entries(scores).filter(([, v]) => v !== '').map(([k, v]) => [k, Number(v)])) } })
        .then(onDone, (x: ApiError) => setErr(x.message)); }}>
      <div className="panel-head"><h2>Performans incelemesi</h2><span className="text-sm text-ink-subtle">{applied ? `"${applied.category}" kategori ağırlığı uygulanır: ${weightText(applied.weights)}.`
        : `Kategori kuralı yok; örnek ağırlık uygulanır: ${weightText(DEFAULT_W)}.`} <Link to="/tedarikciler/performans-agirliklari">Ağırlık kuralları</Link></span></div>
      <div className="panel-body grid gap-3">
        <div className="grid grid-cols-3 items-start gap-x-3 max-[900px]:grid-cols-1">
          <Field label="Dönem başı">{(p) => <input className="input" type="date" required {...p} value={f.periodStart} onChange={(e) => setF({ ...f, periodStart: e.target.value })} />}</Field>
          <Field label="Dönem sonu" hint="Bugünden sonra olamaz">{(p) => <input className="input" type="date" required max={todayLocal()} {...p} value={f.periodEnd} onChange={(e) => setF({ ...f, periodEnd: e.target.value })} />}</Field>
          <Field label="Kategori">{(p) => <input className="input" required minLength={2} {...p} value={f.category} onChange={(e) => setF({ ...f, category: e.target.value })} />}</Field>
        </div>
        <div className="grid grid-cols-5 items-start gap-3 max-[1100px]:grid-cols-2">
          {DIMS.map(([k, l]) => <Field key={k} label={`${l} (0–100)`}>{(p) => <input className="input tabular text-right" inputMode="numeric" required {...p} value={scores[k] ?? ''}
            onChange={(e) => setScores({ ...scores, [k]: e.target.value.replace(/\D/g, '').slice(0, 3) })} />}</Field>)}
        </div>
        <Field label="Dayanak" hint="Hangi kabul, SLA raporu veya ölçüme dayanıyor.">{(p) => <textarea className="input" rows={2} required minLength={10} {...p} value={f.basis} onChange={(e) => setF({ ...f, basis: e.target.value })} />}</Field>
        <div className="flex gap-2"><Button type="submit">Kaydet</Button><Button type="button" variant="ghost" onClick={onDone}>Vazgeç</Button></div>
        {err && <Banner tone="danger" title={err} />}
      </div>
    </form>
  );
}
