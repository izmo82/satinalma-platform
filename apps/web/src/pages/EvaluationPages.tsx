import { Fragment, lazy, Suspense, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { api, apiBlob, ApiError } from '../lib/api.ts';
import { useResource } from '../lib/useApi.ts';
import { fmtDate, fmtDateTime, fmtMoney } from '../lib/format.ts';
import { todayLocal } from '../lib/format.ts';
import { ANSWER_RESPONSE as RESPONSE, OWNER_ROLES, roleLabel } from '../lib/labels.ts';
import { hasPermission, hasRole, useSession, v2Role } from '../lib/session.tsx';
import { Banner, Empty, ErrorState, Field, Loading, PageHeader, Tag } from '../ui/kit.tsx';
import { DepartmentName } from '../ui/Departments.tsx';
import { Icon } from '../ui/icons.tsx';
import { Button } from '@/components/ui/button';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { cn } from '@/lib/utils';
import { trDecimal } from './ContractReview.tsx';
import { CATEGORY, DEFAULT_W, DIMS, FACTORS, INCIDENT_STATUS, IncidentTable, LEVEL, OUTCOME, weightText, type WeightPolicy } from './SupplierEvaluation.tsx';
import { RiskReportPlaceholder } from './RiskReportPlaceholder.tsx';
// v2 Faz 6 izleme: risk kartı tembel yüklenir; yer tutucu kartla aynı yükseklikte (sayfa kaymaz).
const RiskReportCard = lazy(() => import('./RiskPages.tsx').then((m) => ({ default: m.RiskReportCard })));
import { ComplianceAudits } from './ComplianceAudits.tsx';

function useAct(reload: () => Promise<void>) {
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ tone: 'info' | 'warn' | 'danger'; text: string } | null>(null);
  const run = async (fn: () => Promise<unknown>, ok: string) => {
    setBusy(true); setMsg(null);
    try { await fn(); setMsg({ tone: 'info', text: ok }); await reload(); return true; }
    catch (e) { const err = e as ApiError; setMsg({ tone: err.status === 409 ? 'warn' : 'danger', text: err.message }); await reload(); return false; }
    finally { setBusy(false); }
  };
  return { busy, run, clear: () => setMsg(null), feedback: msg && <Banner tone={msg.tone} icon={msg.tone === 'info' ? 'check' : undefined} title={msg.text} /> };
}
const ITEM_KIND = { BLOCKER: 'Engel', FINDING: 'Bulgu', UNKNOWN: 'Bilinmiyor', EVIDENCE: 'Kanıt' } as const;

// --- Değerlendirme (anket, kanıt, inceleme, kalan risk) ---------------------------------------------

interface AssessmentDetail {
  assessment: { id: string; supplierId: string; supplierName: string; scope: string; status: string; inherentFactors: Record<string, string>; reviewDue: string | null;
    createdBy: string; createdByMe: boolean; createdAt: string; reviewedBy: string | null; reviewedAt: string | null;
    residual: null | { level: string; reason: string; acceptedBy: string; acceptedAt: string }; departmentId: string | null; departmentName: string | null };
  template: { name: string; version: number; category: string };
  portal: { status: 'NONE' | 'SENT' | 'SUBMITTED'; sentAt: string | null; due: string | null; submittedAt: string | null };
  questions: { id: string; ordinal: number; controlId: string; reference: string; text: string; critical: boolean; evidenceRequired: boolean }[];
  answers: { questionId: string; response: keyof typeof RESPONSE; naReason: string | null; note: string | null; evidenceDocumentVersionId: string | null; evidenceTitle: string | null;
    evidenceDate: string | null; evidenceExpires: string | null; answeredBy: string; answeredByMe: boolean; review: 'ACCEPTED' | 'FINDING' | null; findingSeverity: string | null;
    findingNote: string | null; reviewedBy: string | null }[];
  inherent: { level: string; reasons: string[] };
  outcome: string; complianceRate: number | null; reviewedAll: boolean;
  items: { questionId: string; controlId: string; kind: keyof typeof ITEM_KIND; message: string }[];
  can: { answer: boolean; review: boolean; acceptRisk: boolean };
}

export function AssessmentPage() {
  const { id } = useParams();
  const r = useResource<AssessmentDetail>(`/api/v1/assessments/${id}`);
  const a = useAct(r.reload);
  const [editing, setEditing] = useState<string | null>(null);
  if (r.loading && !r.data) return <div className="page"><Loading rows={6} /></div>;
  if (r.error || !r.data) return <div className="page"><ErrorState error={r.error} onRetry={r.reload} /></div>;
  const d = r.data;
  const open = d.assessment.status === 'OPEN';
  const blockers = d.items.filter((x) => x.kind === 'BLOCKER');
  return (
    <div className="page">
      <p className="text-sm text-ink-subtle"><Link to={`/tedarikciler/${d.assessment.supplierId}?sekme=degerlendirme`} className="text-ink-subtle">{d.assessment.supplierName}</Link> / Değerlendirme</p>
      <div className="mb-2 mt-1 flex flex-wrap items-start gap-3"><h1 className="min-w-0 flex-1">{d.assessment.scope}</h1><Tag label={OUTCOME[d.outcome]} /></div>
      <p className="mb-5 text-ink-muted">Departman: <DepartmentName name={d.assessment.departmentName} /> · {d.template.name} v{d.template.version} · {d.template.category} · {d.assessment.createdBy}, {fmtDate(d.assessment.createdAt)}
        {d.assessment.status === 'REVIEWED' ? ` · inceleme tamamlandı (${d.assessment.reviewedBy})` : d.assessment.status === 'SUPERSEDED' ? ' · yerini yeni değerlendirme aldı' : ' · inceleme sürüyor'}</p>
      {blockers.length > 0 && <Banner tone="danger" title={`Kritik engel (${blockers.length})`}>{blockers.map((x) => x.message).join(' ')} Uyum oranı{d.complianceRate !== null ? ` %${d.complianceRate}` : ''} bu engeli aşmaz.</Banner>}
      <div className="grid grid-cols-[minmax(0,1fr)_340px] gap-6 max-[1100px]:grid-cols-1">
        <div className="grid content-start gap-3">
          {d.questions.map((q) => {
            const ans = d.answers.find((x) => x.questionId === q.id);
            const items = d.items.filter((x) => x.questionId === q.id);
            return (
              <section key={q.id} className={cn('panel', items.some((x) => x.kind === 'BLOCKER') && 'border-danger')}>
                <div className="panel-body grid gap-2">
                  <div className="flex flex-wrap items-baseline gap-2"><span className="mono text-sm">{q.controlId}</span>{q.critical && <Tag label={{ text: 'Kritik', tone: 'danger', icon: 'shield' }} />}
                    {q.evidenceRequired && <span className="text-sm text-ink-subtle">Kanıt zorunlu</span>}<span className="ml-auto text-sm text-ink-subtle">{q.reference}</span></div>
                  <p className="font-semibold">{q.text}</p>
                  {ans ? (
                    <p className="text-sm"><strong>{RESPONSE[ans.response]}</strong>{ans.naReason ? ` · gerekçe: ${ans.naReason}` : ''}{ans.note ? ` · ${ans.note}` : ''}
                      {ans.evidenceDocumentVersionId && <> · kanıt <Link to={`/belgeler/${ans.evidenceDocumentVersionId}`}>{ans.evidenceTitle ?? 'belge'}</Link>{ans.evidenceExpires ? ` (geçerlilik ${fmtDate(ans.evidenceExpires)})` : ''}</>}
                      <span className="text-ink-subtle"> · {ans.answeredBy}</span>
                      {ans.review && <span className="block">{ans.review === 'ACCEPTED' ? <Tag label={{ text: `Kabul · ${ans.reviewedBy}`, tone: 'human', icon: 'stamp' }} />
                        : <Tag label={{ text: `Bulgu (${LEVEL[ans.findingSeverity ?? 'LOW']!.text}) · ${ans.reviewedBy}`, tone: 'warn', icon: 'alert' }} />}{ans.findingNote ? ` ${ans.findingNote}` : ''}</span>}</p>
                  ) : <p className="text-sm text-warn">Yanıt yok: bilinmiyor sayılır.</p>}
                  {items.map((x, i) => <p key={i} className={cn('rounded-sm px-2 py-1 text-sm', x.kind === 'BLOCKER' ? 'bg-danger-soft' : 'bg-warn-soft')}><strong>{ITEM_KIND[x.kind]}:</strong> {x.message}</p>)}
                  {open && editing !== q.id && <div className="flex flex-wrap gap-2">
                    {d.can.answer && d.portal.status === 'NONE' && <Button size="sm" variant="outline" onClick={() => { a.clear(); setEditing(q.id); }}>{ans ? 'Yanıtı değiştir' : 'Yanıt gir'}</Button>}
                    {d.can.review && ans && !ans.answeredByMe && <ReviewButtons onReview={(b) => void a.run(() => api(`/api/v1/assessments/${d.assessment.id}/answers/${q.id}/review`, { method: 'POST', json: b }), 'İnceleme kaydedildi.')} />}
                    {d.can.review && ans?.answeredByMe && <span className="text-sm text-ink-subtle">Yanıtı siz girdiniz; inceleme başka bir yetkilinin.</span>}
                  </div>}
                  {editing === q.id && <AnswerForm d={d} q={q} ans={ans} onDone={() => { setEditing(null); void r.reload(); }} />}
                </div>
              </section>
            );
          })}
          {a.feedback}
        </div>
        <aside className="grid content-start gap-4">
          <PortalPanel d={d} run={a.run} busy={a.busy} />
          <section className="panel"><div className="panel-head"><h2>İçsel risk</h2><Tag label={LEVEL[d.inherent.level]} /></div>
            <div className="panel-body"><dl className="facts">{FACTORS.map(([k, l]) => <Fragment key={k}><dt>{l}</dt><dd>{LEVEL[d.assessment.inherentFactors[k] ?? 'LOW']!.text}</dd></Fragment>)}</dl>
              <p className="mt-2 text-sm text-ink-subtle">Kontrollerden önceki risk; kurala göre hesaplanır.</p></div></section>
          <section className="panel"><div className="panel-head"><h2>Kalan risk</h2>{d.assessment.residual && <Tag label={LEVEL[d.assessment.residual.level]} />}</div>
            <div className="panel-body grid gap-2">{d.assessment.residual ? <p className="text-sm">{d.assessment.residual.reason}<span className="block text-ink-subtle">{d.assessment.residual.acceptedBy} · {fmtDateTime(d.assessment.residual.acceptedAt)}</span></p>
              : d.assessment.status !== 'REVIEWED' ? <p className="text-sm text-ink-muted">İnceleme tamamlandıktan sonra risk sahibi kabul eder.</p>
                : d.can.acceptRisk && !d.assessment.createdByMe ? <ResidualForm initial={d.inherent.level} onSubmit={(b) => a.run(() => api(`/api/v1/assessments/${d.assessment.id}/residual`, { method: 'POST', json: b }), 'Kalan risk kabul edildi.')} busy={a.busy} />
                  : <p className="text-sm text-ink-muted">Kalan riski, değerlendirmeyi açan kişi dışında bir Satınalma veya Departman kullanıcısı kabul eder.</p>}
              <p className="text-sm text-ink-subtle">Belgesiz indirim yok: içsel riskin altına inmek için değerlendiricinin kabul ettiği, kanıt belgesi eklenmiş ve süresi geçmemiş en az bir kontrol gerekir.</p></div></section>
          <section className="panel"><div className="panel-head"><h2>Sonuç</h2></div>
            <div className="panel-body grid gap-2"><p><Tag label={OUTCOME[d.outcome]} /> {d.complianceRate !== null && <span className="tabular text-sm text-ink-muted">uyum %{d.complianceRate} (yanıtlara göre, bilgi amaçlı)</span>}</p>
              {d.items.length > 0 && <ul className="grid list-disc gap-1 pl-5 text-sm">{d.items.map((x, n) => <li key={n}><strong>{ITEM_KIND[x.kind]}:</strong> {x.message}</li>)}</ul>}
              <p className="text-sm text-ink-subtle">{d.outcome === 'BLOCKED' ? 'İnceleme tamamlanınca bu tedarikçiye yeni seçim önerisi ve seçim onayı engellenir.'
                : d.outcome === 'INCOMPLETE' ? 'Bilinmeyen yanıt veya eksik/süresi geçmiş kanıt var; sonuç kesinleşmez.' : d.outcome === 'CONDITIONAL' ? 'Bulgular düzeltici faaliyetle izlenmeli.' : 'Engel ve açık bulgu yok.'}</p>
              {open && d.can.review && <Button disabled={a.busy || !d.reviewedAll || d.portal.status === 'SENT'} onClick={() => void a.run(() => api(`/api/v1/assessments/${d.assessment.id}/complete`, { method: 'POST' }), 'Değerlendirme tamamlandı.')}><Icon name="stamp" />İncelemeyi tamamla</Button>}
              {open && !d.reviewedAll && <p className="text-sm text-ink-muted">Tüm sorular yanıtlanıp incelenince tamamlanır.</p>}</div></section>
        </aside>
      </div>
    </div>
  );
}

/** Tedarikçi portalı: anket tedarikçiye gönderilir, tedarikçi soruları yanıtlayıp gönderir; inceleme ve risk kararı kurumda kalır. */
function PortalPanel({ d, run, busy }: { d: AssessmentDetail; run: (fn: () => Promise<unknown>, ok: string) => Promise<boolean>; busy: boolean }) {
  const [due, setDue] = useState('');
  const p = d.portal;
  const open = d.assessment.status === 'OPEN';
  if (p.status === 'NONE' && !(open && d.can.answer && !d.answers.length)) return null;
  return (
    <section className="panel"><div className="panel-head"><h2>Tedarikçi portalı</h2>
      {p.status !== 'NONE' && <Tag label={p.status === 'SENT' ? { text: 'Tedarikçide', tone: 'warn', icon: 'clock' } : { text: 'Tedarikçi gönderdi', tone: 'human', icon: 'check' }} />}</div>
      <div className="panel-body grid gap-2">
        {p.status === 'NONE' ? (
          <form className="grid gap-2" onSubmit={(e) => { e.preventDefault(); void run(() => api(`/api/v1/assessments/${d.assessment.id}/send-to-supplier`, { method: 'POST', json: { due: due || null } }), 'Anket tedarikçiye gönderildi.'); }}>
            <p className="text-sm text-ink-muted">Tedarikçi kullanıcıları soruları portaldan yanıtlar. Kurum incelemesi, bulgular ve risk kararı tedarikçiye gösterilmez; kanıt belgesini kurum bağlar.</p>
            <Field label="Tedarikçi için son tarih" hint="İsteğe bağlı">{(fp) => <input type="date" className="input" min={todayLocal()} {...fp} value={due} onChange={(e) => setDue(e.target.value)} />}</Field>
            <Button type="submit" variant="outline" disabled={busy}>Tedarikçiye gönder</Button>
          </form>
        ) : (
          <p className="text-sm">Gönderildi {fmtDateTime(p.sentAt!)}{p.due ? ` · son tarih ${fmtDate(p.due)}` : ''}
            {p.submittedAt ? <span className="block">Tedarikçi yanıtları gönderdi: {fmtDateTime(p.submittedAt)}. Yanıtlar artık tedarikçi tarafından değiştirilemez.</span>
              : <span className="block text-ink-muted">Tedarikçi yanıtlıyor; yanıtları tedarikçi verir. İnceleme, tedarikçi gönderdikten sonra tamamlanır.</span>}</p>
        )}
      </div>
    </section>
  );
}

function ReviewButtons({ onReview }: { onReview: (b: { review: 'ACCEPTED' | 'FINDING'; findingSeverity?: string; findingNote?: string }) => void }) {
  const [finding, setFinding] = useState(false);
  const [sev, setSev] = useState('MEDIUM');
  const [note, setNote] = useState('');
  if (!finding) return <><Button size="sm" variant="outline" onClick={() => onReview({ review: 'ACCEPTED' })}><Icon name="check" />Kabul</Button>
    <Button size="sm" variant="ghost" onClick={() => setFinding(true)}>Bulgu yaz</Button></>;
  return (
    <div className="grid w-full grid-cols-[140px_minmax(0,1fr)_auto] items-start gap-2 max-[640px]:grid-cols-1">
      <Field label="Bulgu şiddeti">{(p) => <select className="input" {...p} value={sev} onChange={(e) => setSev(e.target.value)}>{Object.entries(LEVEL).map(([k, v]) => <option key={k} value={k}>{v.text}</option>)}</select>}</Field>
      <Field label="Bulgu">{(p) => <input className="input" {...p} value={note} onChange={(e) => setNote(e.target.value)} />}</Field>
      <Button size="sm" className="mt-6" disabled={note.trim().length < 10} onClick={() => { onReview({ review: 'FINDING', findingSeverity: sev, findingNote: note }); setFinding(false); setNote(''); }}>Kaydet</Button>
    </div>
  );
}

function AnswerForm({ d, q, ans, onDone }: { d: AssessmentDetail; q: AssessmentDetail['questions'][number]; ans?: AssessmentDetail['answers'][number]; onDone: () => void }) {
  const docs = useResource<{ documents: { documentVersionId: string; title: string }[] }>(`/api/v1/suppliers/${d.assessment.supplierId}`);
  const [f, setF] = useState({ response: (ans?.response ?? '') as keyof typeof RESPONSE | '', naReason: ans?.naReason ?? '', note: ans?.note ?? '', evidenceDocumentVersionId: ans?.evidenceDocumentVersionId ?? '',
    evidenceDate: ans?.evidenceDate ?? '', evidenceExpires: ans?.evidenceExpires ?? '' });
  const [err, setErr] = useState<string | null>(null);
  return (
    <form className="grid gap-2 rounded-md border border-border bg-white p-3" onSubmit={(e) => { e.preventDefault(); setErr(null);
      void api(`/api/v1/assessments/${d.assessment.id}/answers/${q.id}`, { method: 'PUT', json: { response: f.response, naReason: f.naReason || null, note: f.note || null,
        evidenceDocumentVersionId: f.evidenceDocumentVersionId || null, evidenceDate: f.evidenceDate || null, evidenceExpires: f.evidenceExpires || null } }).then(onDone, (x: ApiError) => setErr(x.message)); }}>
      <div className="grid grid-cols-2 items-start gap-x-3 max-[640px]:grid-cols-1">
        <Field label="Yanıt">{(p) => <select className="input" required {...p} value={f.response} onChange={(e) => setF({ ...f, response: e.target.value as typeof f.response })}><option value="">Seçin</option>{Object.entries(RESPONSE).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select>}</Field>
        {f.response === 'NOT_APPLICABLE' ? <Field label="Neden uygulanamaz">{(p) => <input className="input" required minLength={10} {...p} value={f.naReason} onChange={(e) => setF({ ...f, naReason: e.target.value })} />}</Field>
          : <Field label="Not">{(p) => <input className="input" {...p} value={f.note} onChange={(e) => setF({ ...f, note: e.target.value })} />}</Field>}
      </div>
      <div className="grid grid-cols-3 items-start gap-x-3 max-[640px]:grid-cols-1">
        <Field label="Kanıt belgesi" hint="Tedarikçiye bağlı belgeler">{(p) => <select className="input" {...p} value={f.evidenceDocumentVersionId} onChange={(e) => setF({ ...f, evidenceDocumentVersionId: e.target.value })}>
          <option value="">Yok</option>{docs.data?.documents.map((x) => <option key={x.documentVersionId} value={x.documentVersionId}>{x.title}</option>)}</select>}</Field>
        <Field label="Kanıt tarihi">{(p) => <input className="input" type="date" {...p} value={f.evidenceDate} onChange={(e) => setF({ ...f, evidenceDate: e.target.value })} />}</Field>
        <Field label="Geçerlilik sonu">{(p) => <input className="input" type="date" {...p} value={f.evidenceExpires} onChange={(e) => setF({ ...f, evidenceExpires: e.target.value })} />}</Field>
      </div>
      <p className="text-sm text-ink-subtle">Sertifika tek başına olumlu karar değildir; kapsamı, geçerliliği ve hizmetle ilişkisi incelemede doğrulanır. Yanıt değişirse önceki inceleme geçersizleşir.</p>
      <div className="flex gap-2"><Button type="submit" size="sm">Yanıtı kaydet</Button><Button type="button" size="sm" variant="ghost" onClick={onDone}>Vazgeç</Button></div>
      {err && <Banner tone="danger" title={err} />}
    </form>
  );
}

function ResidualForm({ initial, onSubmit, busy }: { initial: string; onSubmit: (b: { level: string; reason: string }) => Promise<boolean>; busy: boolean }) {
  const [level, setLevel] = useState(initial);
  const [reason, setReason] = useState('');
  return (
    <form className="grid gap-2" onSubmit={(e) => { e.preventDefault(); void onSubmit({ level, reason }); }}>
      <Field label="Kalan risk">{(p) => <select className="input" {...p} value={level} onChange={(e) => setLevel(e.target.value)}>{Object.entries(LEVEL).map(([k, v]) => <option key={k} value={k}>{v.text}</option>)}</select>}</Field>
      <Field label="Gerekçe" hint="Hangi doğrulanmış kontroller riski düşürüyor.">{(p) => <textarea className="input" rows={3} required minLength={20} {...p} value={reason} onChange={(e) => setReason(e.target.value)} />}</Field>
      <Button type="submit" disabled={busy || reason.trim().length < 20}><Icon name="stamp" />Kalan riski kabul et</Button>
    </form>
  );
}

// --- Olay (UX12) ------------------------------------------------------------------------------------

interface IncidentDetail {
  incident: { id: string; code: string; title: string; description: string; impact: string | null; location: string | null; occurredOn: string; status: string; severity: string; category: string;
    disputeOpen: boolean; duplicateOfId: string | null; duplicateOfCode: string | null; countedInMetric: boolean; supplierId: string; supplierName: string; contractVersionId: string | null; contractTitle: string | null;
    poId: string | null; poCode: string | null; reportedBy: string; reportedByMe: boolean; reportedAt: string; verifiedBy: string | null };
  events: { kind: string; fromStatus: string | null; toStatus: string | null; note: string | null; at: string; actor: string }[];
  actions: { id: string; title: string; ownerRole: string; dueDate: string; status: string; doneNote: string | null; doneBy: string | null; doneByMe: boolean; verifiedBy: string | null }[];
  scoreImpact: { counted: true; penalty: number; policy: string } | { counted: false; reason: string; policy: string };
  can: { verify: boolean; report: boolean; roles: string[] };
}
const EVENT: Record<string, string> = { REPORTED: 'Bildirildi', REVIEW_STARTED: 'Ön inceleme başladı', VERIFIED: 'Doğrulandı', REJECTED: 'Doğrulanmadı', DISPUTED: 'Tedarikçi itirazı',
  DISPUTE_RESOLVED: 'İtiraz sonuçlandı', DUPLICATE: 'Mükerrer işaretlendi', CLOSED: 'Kapandı', REOPENED: 'Yeniden açıldı', NOTE: 'Not' };
type Act = { action: string; label: string; extra?: 'verify' | 'resolve' | 'duplicate'; variant?: 'default' | 'outline' };

export function IncidentPage() {
  const { id } = useParams();
  const r = useResource<IncidentDetail>(`/api/v1/incidents/${id}`);
  const a = useAct(r.reload);
  const [act, setAct] = useState<Act | null>(null);
  if (r.loading && !r.data) return <div className="page"><Loading rows={6} /></div>;
  if (r.error || !r.data) return <div className="page"><ErrorState error={r.error} onRetry={r.reload} /></div>;
  const d = r.data; const i = d.incident;
  const acts: Act[] = [];
  if (d.can.verify) {
    if (i.status === 'REPORTED') acts.push({ action: 'START_REVIEW', label: 'Ön incelemeyi başlat', variant: 'default' }, { action: 'REJECT', label: 'Doğrulanmadı' }, { action: 'MARK_DUPLICATE', label: 'Mükerrer', extra: 'duplicate' });
    if (i.status === 'UNDER_REVIEW') acts.push({ action: 'VERIFY', label: 'Doğrula', extra: 'verify', variant: 'default' }, { action: 'REJECT', label: 'Doğrulanmadı' }, { action: 'MARK_DUPLICATE', label: 'Mükerrer', extra: 'duplicate' });
    if (i.status === 'VERIFIED' && i.disputeOpen) acts.push({ action: 'RESOLVE_DISPUTE', label: 'İtirazı sonuçlandır', extra: 'resolve', variant: 'default' });
    if (i.status === 'VERIFIED' && !i.disputeOpen) acts.push({ action: 'CLOSE', label: 'Kapat', variant: 'default' });
    if (['CLOSED', 'REJECTED'].includes(i.status)) acts.push({ action: 'REOPEN', label: 'Yeniden aç' });
  }
  if (d.can.verify && i.status === 'VERIFIED' && !i.disputeOpen) acts.push({ action: 'DISPUTE', label: 'Tedarikçi itirazını kaydet' });
  return (
    <div className="page">
      <p className="text-sm text-ink-subtle"><Link to="/tedarikciler/olaylar" className="text-ink-subtle">Olaylar</Link> / {i.code}</p>
      <div className="mb-2 mt-1 flex flex-wrap items-start gap-3"><h1 className="min-w-0 flex-1">{i.code} · {i.title}</h1><Tag label={INCIDENT_STATUS[i.status]} />
        {i.disputeOpen && <Tag label={{ text: 'İtiraz açık', tone: 'warn', icon: 'alert' }} />}</div>
      <p className="mb-5 text-ink-muted"><Link to={`/tedarikciler/${i.supplierId}?sekme=olaylar`}>{i.supplierName}</Link> · {CATEGORY[i.category]} · {fmtDate(i.occurredOn)}
        {i.contractTitle ? <> · <Link to={`/sozlesmeler/${i.contractVersionId}`}>{i.contractTitle}</Link></> : null}{i.poCode ? <> · Sipariş {i.poCode}</> : null}</p>
      <Banner tone={d.scoreImpact.counted ? 'warn' : 'neutral'} icon={d.scoreImpact.counted ? 'alert' : 'info'}
        title={d.scoreImpact.counted ? `Puan etkisi: −${d.scoreImpact.penalty}` : 'Puana yansımıyor'}>{d.scoreImpact.counted ? `Doğrulanmış, açık itirazı olmayan, tekil olay. Ceza olay politikasına göre (sürüm ${d.scoreImpact.policy}).` : d.scoreImpact.reason}</Banner>
      <div className="grid grid-cols-[minmax(0,1fr)_340px] gap-6 max-[1100px]:grid-cols-1">
        <div className="grid content-start gap-5">
          <section className="panel"><div className="panel-head"><h2>Olay</h2><Tag label={LEVEL[i.severity]} /></div>
            <div className="panel-body grid gap-2"><p>{i.description}</p>
              {i.impact && <p><strong>Etki:</strong> {i.impact}</p>}{i.location && <p><strong>Lokasyon:</strong> {i.location}</p>}
              {i.duplicateOfId && <p>Mükerrer kayıt; asıl olay <Link to={`/tedarikciler/olaylar/${i.duplicateOfId}`}>{i.duplicateOfCode}</Link>.</p>}
              {i.countedInMetric && <p className="text-sm text-ink-muted">SLA ölçümüne yansıdığı için ayrıca ceza puanı uygulanmaz.</p>}
              <p className="text-sm text-ink-subtle">Bildiren {i.reportedBy} · {fmtDateTime(i.reportedAt)}{i.verifiedBy ? ` · doğrulayan ${i.verifiedBy}` : ''}</p></div></section>
          <section className="panel"><div className="panel-head"><h2>Düzeltici faaliyet</h2></div>
            <div className="panel-body grid gap-3">
              {!d.actions.length && <p className="text-ink-muted">Faaliyet yok.</p>}
              {d.actions.map((x) => <CorrectiveRow key={x.id} x={x} roles={d.can.roles} canVerify={d.can.verify} run={a.run} busy={a.busy} />)}
              {d.can.verify && ['UNDER_REVIEW', 'VERIFIED'].includes(i.status) && <NewAction incidentId={i.id} run={a.run} />}
            </div></section>
          <section className="panel"><div className="panel-head"><h2>Zaman çizelgesi</h2><span className="text-sm text-ink-subtle">Önceki kayıtlar değişmez.</span></div>
            <div className="panel-body"><ol className="timeline">{d.events.map((e, n) => <li key={n}><strong>{EVENT[e.kind] ?? e.kind}{e.toStatus && e.fromStatus && e.fromStatus !== e.toStatus && !['VERIFIED', 'REJECTED', 'CLOSED'].includes(e.kind) ? ` → ${INCIDENT_STATUS[e.toStatus]?.text}` : ''}</strong>
              {e.note && <span>{e.note}</span>}<span className="subtle">{e.actor} · {fmtDateTime(e.at)}</span></li>)}</ol></div></section>
        </div>
        <aside className="grid content-start gap-4">
          <section className="panel"><div className="panel-head"><h2>İşlem</h2></div>
            <div className="panel-body grid gap-2">
              {!acts.length && <p className="text-sm text-ink-muted">{i.reportedByMe && i.status === 'UNDER_REVIEW' ? 'Olayı siz bildirdiniz; doğrulama başka bir yetkilinin.' : 'Bu aşamada sizin için işlem yok.'}</p>}
              {!act && <div className="flex flex-wrap gap-2">{acts.map((x) => <Button key={x.action} size="sm" variant={x.variant ?? 'outline'} onClick={() => { a.clear(); setAct(x); }}>{x.label}</Button>)}</div>}
              {act && <TransitionForm act={act} d={d} onCancel={() => setAct(null)} onSubmit={(b) => a.run(() => api(`/api/v1/incidents/${i.id}/transitions`, { method: 'POST', json: { action: act.action, ...b } }), `${act.label}: kaydedildi.`).then((ok) => { if (ok) setAct(null); })} busy={a.busy} />}
              {a.feedback}
              <p className="text-sm text-ink-subtle">Ciddi güvenlik olayı doğrulanınca risk yeniden incelemesi ve yeni işlem kararı görevleri açılır; dış bildirim kendiliğinden gönderilmez.</p>
            </div></section>
        </aside>
      </div>
    </div>
  );
}

function TransitionForm({ act, d, onCancel, onSubmit, busy }: { act: Act; d: IncidentDetail; onCancel: () => void; onSubmit: (b: Record<string, unknown>) => void; busy: boolean }) {
  const [note, setNote] = useState('');
  const [severity, setSeverity] = useState(d.incident.severity);
  const [counted, setCounted] = useState(false);
  const [upheld, setUpheld] = useState(true);
  const [dup, setDup] = useState('');
  const others = useResource<{ items: { id: string; code: string; title: string; duplicateOfId: string | null }[] }>(act.extra === 'duplicate' ? `/api/v1/incidents?supplierId=${d.incident.supplierId}` : null);
  return (
    <form className="grid gap-2" onSubmit={(e) => { e.preventDefault(); onSubmit({ note, ...(act.extra === 'verify' ? { severity, countedInMetric: counted } : {}),
      ...(act.extra === 'resolve' ? { upheld } : {}), ...(act.extra === 'duplicate' ? { duplicateOfId: dup } : {}) }); }}>
      <strong>{act.label}</strong>
      {act.extra === 'verify' && <>
        <Field label="Doğrulanan şiddet">{(p) => <select className="input" {...p} value={severity} onChange={(e) => setSeverity(e.target.value)}>{Object.entries(LEVEL).map(([k, v]) => <option key={k} value={k}>{v.text}</option>)}</select>}</Field>
        <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={counted} onChange={(e) => setCounted(e.target.checked)} />SLA ölçümüne zaten yansıdı (ayrıca ceza puanı yok)</label></>}
      {act.extra === 'resolve' && <Field label="İtiraz sonucu">{(p) => <select className="input" {...p} value={upheld ? 'yes' : 'no'} onChange={(e) => setUpheld(e.target.value === 'yes')}>
        <option value="yes">Bulgu geçerli, itiraz reddedildi</option><option value="no">İtiraz haklı, olay doğrulanmamış sayılır</option></select>}</Field>}
      {act.extra === 'duplicate' && <Field label="Asıl olay">{(p) => <select className="input" required {...p} value={dup} onChange={(e) => setDup(e.target.value)}>
        <option value="">Seçin</option>{others.data?.items.filter((x) => x.id !== d.incident.id && !x.duplicateOfId).map((x) => <option key={x.id} value={x.id}>{x.code} · {x.title}</option>)}</select>}</Field>}
      <Field label="Gerekçe ve kanıt" hint="Ne incelendi, hangi kayda dayanıyor.">{(p) => <textarea className="input" rows={3} required minLength={10} {...p} value={note} onChange={(e) => setNote(e.target.value)} />}</Field>
      <div className="flex gap-2"><Button type="submit" size="sm" disabled={busy || note.trim().length < 10}>Kaydet</Button><Button type="button" size="sm" variant="ghost" onClick={onCancel}>Vazgeç</Button></div>
    </form>
  );
}

function CorrectiveRow({ x, roles, canVerify, run, busy }: { x: IncidentDetail['actions'][number]; roles: string[]; canVerify: boolean; run: (fn: () => Promise<unknown>, ok: string) => Promise<boolean>; busy: boolean }) {
  const [note, setNote] = useState('');
  const [doing, setDoing] = useState(false);
  return (
    <div className="grid gap-1 border-b border-[#ebe6da] pb-3 last:border-b-0">
      <div className="flex flex-wrap items-baseline gap-2"><strong>{x.title}</strong><span className="text-sm text-ink-subtle">{roleLabel[x.ownerRole] ?? x.ownerRole} · hedef {fmtDate(x.dueDate)}</span>
        <span className="ml-auto">{x.status === 'VERIFIED' ? <Tag label={{ text: `Doğrulandı · ${x.verifiedBy}`, tone: 'human', icon: 'stamp' }} /> : x.status === 'DONE' ? <Tag label={{ text: 'Tamamlandı, doğrulama bekliyor', tone: 'info', icon: 'clock' }} /> : <Tag label={{ text: 'Açık', tone: 'warn', icon: 'clock' }} />}</span></div>
      {x.doneNote && <p className="text-sm">{x.doneNote} <span className="text-ink-subtle">· {x.doneBy}</span></p>}
      {x.status === 'OPEN' && roles.map(v2Role).includes(v2Role(x.ownerRole)) && (doing ? <div className="flex flex-wrap items-end gap-2"><div className="min-w-0 flex-1"><Field label="Ne yapıldı ve kanıtı">{(p) => <input className="input" {...p} value={note} onChange={(e) => setNote(e.target.value)} />}</Field></div>
        <Button size="sm" disabled={busy || note.trim().length < 10} onClick={() => void run(() => api(`/api/v1/corrective-actions/${x.id}/complete`, { method: 'POST', json: { note } }), 'Faaliyet tamamlandı; bağımsız doğrulama bekliyor.')}>Tamamlandı</Button></div>
        : <Button size="sm" variant="outline" className="justify-self-start" onClick={() => setDoing(true)}>Tamamlandı olarak işaretle</Button>)}
      {x.status === 'DONE' && canVerify && (x.doneByMe ? <p className="text-sm text-ink-subtle">Faaliyeti siz tamamladınız; doğrulama başka bir yetkilinin.</p>
        : <Button size="sm" variant="outline" className="justify-self-start" disabled={busy} onClick={() => void run(() => api(`/api/v1/corrective-actions/${x.id}/verify`, { method: 'POST' }), 'Faaliyet doğrulandı.')}><Icon name="stamp" />Bağımsız doğrula</Button>)}
    </div>
  );
}

function NewAction({ incidentId, run }: { incidentId: string; run: (fn: () => Promise<unknown>, ok: string) => Promise<boolean> }) {
  const [f, setF] = useState({ title: '', ownerRole: 'PROCUREMENT', dueDate: '' });
  return (
    <form className="grid grid-cols-[minmax(0,1fr)_170px_150px_auto] items-start gap-2 max-[900px]:grid-cols-1" onSubmit={(e) => { e.preventDefault();
      void run(() => api(`/api/v1/incidents/${incidentId}/actions`, { method: 'POST', json: f }), 'Faaliyet eklendi; sorumluya görev düştü.').then((ok) => ok && setF({ title: '', ownerRole: 'PROCUREMENT', dueDate: '' })); }}>
      <Field label="Yeni faaliyet">{(p) => <input className="input" required minLength={5} {...p} value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} />}</Field>
      <Field label="Sorumlu rol">{(p) => <select className="input" {...p} value={f.ownerRole} onChange={(e) => setF({ ...f, ownerRole: e.target.value })}>
        {OWNER_ROLES.map((k) => <option key={k} value={k}>{roleLabel[k]}</option>)}</select>}</Field>
      <Field label="Hedef tarih (zorunlu)">{(p) => <input className="input" type="date" required {...p} value={f.dueDate} onChange={(e) => setF({ ...f, dueDate: e.target.value })} />}</Field>
      <Button type="submit" size="sm" className="mt-6">Ekle</Button>
    </form>
  );
}

export function IncidentsPage() {
  const r = useResource<{ items: Parameters<typeof IncidentTable>[0]['items'] }>('/api/v1/incidents');
  const [filter, setFilter] = useState<'open' | 'all'>('open');
  const items = (r.data?.items ?? []).filter((x) => filter === 'all' || !['CLOSED', 'REJECTED'].includes(x.status));
  return (
    <div className="page">
      <PageHeader title="Tedarikçi olayları">Bildirim, ön inceleme, doğrulama, itiraz ve düzeltici faaliyet. Yeni olay tedarikçi sayfasındaki Olaylar sekmesinden bildirilir.</PageHeader>
      <div className="mb-3 flex gap-2">{([['open', 'Açık'], ['all', 'Tümü']] as const).map(([k, l]) => <Button key={k} size="sm" variant={filter === k ? 'default' : 'outline'} aria-pressed={filter === k} onClick={() => setFilter(k)}>{l}</Button>)}</div>
      {r.loading && !r.data ? <Loading /> : r.error ? <ErrorState error={r.error} onRetry={r.reload} /> : !items.length
        ? <div className="rounded-md border border-border bg-surface"><Empty icon="check" title="Bu filtrede olay yok" /></div> : <IncidentTable items={items} showSupplier />}
    </div>
  );
}

// --- Anket şablonları --------------------------------------------------------------------------------

export function TemplatesPage() {
  const r = useResource<{ items: { id: string; code: string; version: number; name: string; category: string; status: string; questions: number; critical: number; publishedAt: string | null }[]; can: { manage: boolean } }>('/api/v1/questionnaire-templates');
  const a = useAct(r.reload);
  const [creating, setCreating] = useState(false);
  const STATUS = { DRAFT: { text: 'Taslak', tone: 'neutral', icon: 'pen' }, PUBLISHED: { text: 'Yayında', tone: 'ok', icon: 'check' }, RETIRED: { text: 'Eski sürüm', tone: 'neutral', icon: 'archive' } } as const;
  return (
    <div className="page">
      <PageHeader title="Anket şablonları" actions={<>{r.data?.can.manage && !creating && <Button onClick={() => setCreating(true)}>Yeni şablon / sürüm</Button>}
        <Button asChild variant="outline"><Link to="/tedarikciler/performans-agirliklari">Performans ağırlıkları</Link></Button></>}>
        Hizmet kategorisine göre kontrol soruları. Standart metni kopyalanmaz; referans ve eşleme uzman onayına tabidir. Yayımlanan sürüm değişmez; değişiklik yeni sürümdür.
      </PageHeader>
      {creating && <TemplateForm onDone={() => { setCreating(false); void r.reload(); }} />}
      {r.loading && !r.data ? <Loading /> : r.error ? <ErrorState error={r.error} onRetry={r.reload} /> : !r.data?.items.length
        ? <div className="rounded-md border border-border bg-surface"><Empty icon="file" title="Şablon yok" /></div> : (
          <Table>
            <TableHeader><TableRow className="hover:bg-transparent"><TableHead>Şablon</TableHead><TableHead>Kategori</TableHead><TableHead className="text-right">Soru</TableHead><TableHead>Durum</TableHead><TableHead><span className="sr-only">Eylem</span></TableHead></TableRow></TableHeader>
            <TableBody>{r.data.items.map((x) => (
              <TableRow key={x.id}>
                <TableCell><span className="font-semibold">{x.name}</span><span className="block text-sm text-ink-subtle mono">{x.code} v{x.version}</span></TableCell>
                <TableCell>{x.category}</TableCell>
                <TableCell className="tabular text-right">{x.questions}{x.critical ? <span className="block text-sm text-danger">{x.critical} kritik</span> : null}</TableCell>
                <TableCell><Tag label={STATUS[x.status as keyof typeof STATUS]} /></TableCell>
                <TableCell>{r.data!.can.manage && x.status === 'DRAFT' && <Button size="sm" variant="outline" disabled={a.busy}
                  onClick={() => void a.run(() => api(`/api/v1/questionnaire-templates/${x.id}/publish`, { method: 'POST' }), `${x.name} v${x.version} yayımlandı.`)}>Yayımla</Button>}</TableCell>
              </TableRow>
            ))}</TableBody>
          </Table>
        )}
      <div className="mt-4">{a.feedback}</div>
    </div>
  );
}

function TemplateForm({ onDone }: { onDone: () => void }) {
  const blank = { controlId: '', reference: '', text: '', critical: false, evidenceRequired: false };
  const [f, setF] = useState({ code: '', name: '', category: '' });
  const [qs, setQs] = useState([blank]);
  const [err, setErr] = useState<string | null>(null);
  const set = (i: number, k: keyof typeof blank, v: string | boolean) => setQs(qs.map((x, j) => (j === i ? { ...x, [k]: v } : x)));
  return (
    <form className="panel mb-5" onSubmit={(e) => { e.preventDefault(); setErr(null);
      void api('/api/v1/questionnaire-templates', { method: 'POST', json: { ...f, questions: qs } }).then(onDone, (x: ApiError) => setErr(x.message)); }}>
      <div className="panel-head"><h2>Şablon taslağı</h2><span className="text-sm text-ink-subtle">Aynı kodla kaydedilirse yeni sürüm olur.</span></div>
      <div className="panel-body grid gap-3">
        <div className="grid grid-cols-3 items-start gap-x-3 max-[900px]:grid-cols-1">
          <Field label="Kod" hint="Harf, rakam, - ve _">{(p) => <input className="input mono" required pattern="[A-Za-z0-9_\-]{2,40}" {...p} value={f.code} onChange={(e) => setF({ ...f, code: e.target.value })} />}</Field>
          <Field label="Ad">{(p) => <input className="input" required minLength={3} {...p} value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} />}</Field>
          <Field label="Hizmet kategorisi">{(p) => <input className="input" required minLength={2} {...p} value={f.category} onChange={(e) => setF({ ...f, category: e.target.value })} />}</Field>
        </div>
        {qs.map((q, i) => (
          <fieldset key={i} className="grid grid-cols-[120px_minmax(0,1fr)] items-start gap-x-3 gap-y-2 rounded-md border border-border p-3 max-[640px]:grid-cols-1">
            <legend className="px-1 text-sm font-semibold">Soru {i + 1}</legend>
            <Field label="Kontrol kimliği">{(p) => <input className="input mono" required {...p} value={q.controlId} onChange={(e) => set(i, 'controlId', e.target.value)} />}</Field>
            <Field label="Standart referansı" hint="Ör. ISO/IEC 27036-2 tedarikçi erişimi">{(p) => <input className="input" required minLength={2} {...p} value={q.reference} onChange={(e) => set(i, 'reference', e.target.value)} />}</Field>
            <div className="col-span-full"><Field label="Soru metni (kurumun kendi ifadesi)">{(p) => <input className="input" required minLength={5} {...p} value={q.text} onChange={(e) => set(i, 'text', e.target.value)} />}</Field></div>
            <div className="col-span-full flex flex-wrap gap-4 text-sm">
              <label className="flex items-center gap-2"><input type="checkbox" checked={q.critical} onChange={(e) => set(i, 'critical', e.target.checked)} />Kritik kontrol (hayır/bilinmiyor = engel)</label>
              <label className="flex items-center gap-2"><input type="checkbox" checked={q.evidenceRequired} onChange={(e) => set(i, 'evidenceRequired', e.target.checked)} />Kanıt zorunlu</label>
              {qs.length > 1 && <button type="button" className="ml-auto underline" onClick={() => setQs(qs.filter((_, j) => j !== i))}>Soruyu kaldır</button>}
            </div>
          </fieldset>
        ))}
        <div className="flex flex-wrap gap-2"><Button type="button" variant="outline" onClick={() => setQs([...qs, blank])}>Soru ekle</Button><Button type="submit">Taslağı kaydet</Button><Button type="button" variant="ghost" onClick={onDone}>Vazgeç</Button></div>
        {err && <Banner tone="danger" title={err} />}
      </div>
    </form>
  );
}

// --- Raporlar (UX13) ----------------------------------------------------------------------------------

interface Summary { period: { from: string; to: string }; scope: { note: string }; dataAsOf: string;
  indicators: { key: string; label: string; definition: string; status: 'OK' | 'NO_DATA' | 'NOT_AVAILABLE'; values: { currency: string | null; numerator: string; denominator: string; ratio: string | null }[]; note: string | null; source: string }[] }
const AMOUNT_KEYS = ['contract_coverage', 'open_commitment'];

/** Raporlar yalnız Yönetici, Satınalma ve Denetçi rolüne açık (report.read). Diğer rol adresi yazarsa standart "rolünüze açık değil"
 *  ekranını görür (düzeltme dalgası Y5); yarım sayfa ve 403 isteği oluşmaz. */
export function ReportsPage() {
  const { me } = useSession();
  if (!hasRole(me, 'ADMIN', 'PROCUREMENT', 'AUDITOR')) return (
    <div className="page">
      <PageHeader title="Raporlar" />
      <div className="rounded-md border border-border bg-surface">
        <Empty icon="lock" title="Raporlar rolünüze açık değil">Raporları Yönetici, Satınalma ve Denetçi rolleri görür. <Link to="/islerim">İşlerim'e dön</Link></Empty>
      </div>
    </div>
  );
  return <ReportsTabs />;
}

/** v2 Faz 7 (D112, R10): Raporlar içinde alt sekme "Uyum denetimleri" (`?sekme=uyum`); göstergeler ekranı aynen varsayılan. Menü 7 giriş kalır. */
function ReportsTabs() {
  const [params] = useSearchParams();
  const uyum = params.get('sekme') === 'uyum';
  const item = (active: boolean) => cn('-mb-px flex min-h-10 items-center whitespace-nowrap border-b-2 font-semibold no-underline transition-colors duration-150',
    active ? 'border-ink text-ink' : 'border-transparent text-ink-muted hover:text-ink');
  return <>
    <nav aria-label="Rapor türleri" className="px-8 pt-3 max-[900px]:px-4">
      <ul className="flex gap-6 overflow-x-auto border-b border-border">
        <li className="shrink-0"><Link to="/raporlar" aria-current={!uyum ? 'page' : undefined} className={item(!uyum)}>Göstergeler</Link></li>
        <li className="shrink-0"><Link to="/raporlar?sekme=uyum" aria-current={uyum ? 'page' : undefined} className={item(uyum)}>Uyum denetimleri</Link></li>
      </ul>
    </nav>
    {uyum ? <div className="page"><PageHeader title="Uyum denetimleri" /><ComplianceAudits /></div> : <ReportsContent />}
  </>;
}

function ReportsContent() {
  const { me } = useSession();
  const y = new Date().getFullYear();
  const [p, setP] = useState({ from: `${y}-01-01`, to: todayLocal() });
  const [q, setQ] = useState(p);
  // Sunucu sonucu en çok 2 dakika saklar (veri anı görünür); "Yeniden hesapla" güncel veriyle hesaplatır.
  const [fresh, setFresh] = useState(false);
  const r = useResource<Summary>(`/api/v1/reports/summary?from=${q.from}&to=${q.to}${fresh ? '&fresh=true' : ''}`);
  const [err, setErr] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  async function csv() {
    setErr(null); setDone(null);
    try {
      const blob = await apiBlob(`/api/v1/reports/summary.csv?from=${q.from}&to=${q.to}`);
      const url = URL.createObjectURL(blob); const link = document.createElement('a');
      link.href = url; link.download = `yonetim-gostergeleri-${q.from}-${q.to}.csv`; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
      setDone(`CSV indirildi (${fmtDate(q.from)}–${fmtDate(q.to)}); dışa aktarma kaydedildi.`);
    } catch (e) { setErr((e as ApiError).message); }
  }
  return (
    <div className="page">
      <PageHeader title="Raporlar" actions={<Button variant="outline" onClick={() => void csv()}><Icon name="file" />CSV indir</Button>}>
        Yönetim göstergeleri: her birinin tanımı, payı/paydası ve kaynağı. Kapsam yalnız erişiminiz olan şirketlerdir; dışa aktarma aynı yetkiyle yapılır ve kaydedilir.
      </PageHeader>
      <form className="mb-4 flex flex-wrap items-end gap-3" onSubmit={(e) => { e.preventDefault(); setFresh(false); setQ(p); }}>
        <Field label="Dönem başı">{(x) => <input className="input" type="date" required {...x} value={p.from} onChange={(e) => setP({ ...p, from: e.target.value })} />}</Field>
        <Field label="Dönem sonu">{(x) => <input className="input" type="date" required {...x} value={p.to} onChange={(e) => setP({ ...p, to: e.target.value })} />}</Field>
        <Button type="submit" variant="outline" className="mb-4">Uygula</Button>
      </form>
      {err && <Banner tone="danger" title={err} />}
      {done && <Banner tone="info" icon="check" title={done} />}
      {/* v2 Faz 6 (D111): yıllık risk matrisi kartı; göstergeler tablosu aynen altında. */}
      {hasPermission(me, 'risk.read') && <Suspense fallback={<RiskReportPlaceholder />}><RiskReportCard /></Suspense>}
      {r.loading && !r.data ? <Loading /> : r.error ? <ErrorState error={r.error} onRetry={r.reload} /> : r.data && <>
        <div className="mb-3 flex flex-wrap items-center gap-x-3 gap-y-1">
          <p className="text-sm text-ink-subtle">{fmtDate(r.data.period.from)}–{fmtDate(r.data.period.to)} · veri anı {fmtDateTime(r.data.dataAsOf)} · {r.data.scope.note} Para birimleri dönüştürülmez.</p>
          <Button variant="ghost" size="sm" disabled={r.loading} onClick={() => (fresh ? r.reload() : setFresh(true))}>Yeniden hesapla</Button>
        </div>
        <Table>
          <TableHeader><TableRow className="hover:bg-transparent"><TableHead>Gösterge</TableHead><TableHead className="text-right">Değer</TableHead><TableHead className="max-[900px]:hidden">Pay / payda</TableHead><TableHead className="max-[1100px]:hidden">Kaynak</TableHead></TableRow></TableHeader>
          <TableBody>{r.data.indicators.map((i) => (
            <TableRow key={i.key}>
              <TableCell className="min-w-[260px]"><span className="font-semibold">{i.label}</span><span className="block text-sm text-ink-muted">{i.definition}</span>
                {i.note && <span className="block text-sm text-ink-subtle">{i.note}</span>}</TableCell>
              <TableCell className="whitespace-nowrap text-right align-top">{i.status !== 'OK' ? <span className="text-ink-subtle">{i.status === 'NO_DATA' ? 'Veri yok' : 'Hesaplanmıyor'}</span>
                : i.values.map((v, n) => <span key={n} className="tabular block font-semibold">{AMOUNT_KEYS.includes(i.key) && i.key === 'open_commitment' ? fmtMoney(v.numerator, v.currency) : i.key === 'supplier_incidents' ? `${v.numerator} / ${v.denominator}` : v.ratio !== null ? `%${v.ratio.replace('.', ',')}` : '—'}{v.currency && i.key !== 'open_commitment' ? <span className="ml-1.5 text-sm font-normal text-ink-subtle">({v.currency})</span> : null}</span>)}</TableCell>
              <TableCell className="tabular text-sm text-ink-muted max-[900px]:hidden">{i.values.map((v, n) => <span key={n} className="block">{AMOUNT_KEYS.includes(i.key) ? `${fmtMoney(v.numerator, v.currency)} / ${fmtMoney(v.denominator, v.currency)}` : `${v.numerator} / ${v.denominator}`}</span>)}</TableCell>
              <TableCell className="text-sm text-ink-subtle max-[1100px]:hidden">{i.source}</TableCell>
            </TableRow>
          ))}</TableBody>
        </Table>
      </>}
    </div>
  );
}

// --- Yapay zekâ yönetişimi ------------------------------------------------------------------------------

interface AiOverview {
  tasks: { code: string; name: string; needs: string[]; deterministic: string; human: string }[];
  models: { id: string; provider: string; modelId: string; modelVersion: string; tasks: string[]; capabilities: Record<string, boolean>; approvedRegions: string[]; trainsOnCustomerData: boolean; enabled: boolean; adapterInstalled: boolean; isTestProvider?: boolean }[];
  policy: null | { allowedProviders: string[]; allowedRegions: string[]; monthlyBudget: string | null; budgetCurrency: string; dailyCallLimit: number | null; allowUpgrade: boolean };
  usage: { monthSpent: string; todayCalls: number };
  runs: { id: string; task: string; status: string; reason: string | null; estimatedCost: string | null; actualCost: string | null; costCurrency: string | null; flags: string[]; createdAt: string; provider: string | null; modelId: string | null;
    // v2 Faz 4 (R3) defter sütunları
    requestedBy?: string | null; documentVersionId?: string | null; promptVersion?: string | null; inputTokens?: number | null; outputTokens?: number | null;
    responseModel?: string | null; finishedAt?: string | null; isTestProvider?: boolean; providerLabel?: string | null }[];
  quality: { status: string; reason: string; contractAccuracy?: string };
  provider?: { kind: 'none' | 'test' | 'anthropic'; modelId: string; label: string; external: boolean };
  contractSettings?: { reviewThreshold: number; defaultThreshold: number; updatedAt: string | null; updatedBy: string | null };
  can: { manage: boolean };
}
const RUN_STATUS: Record<string, string> = { QUEUED: 'Kuyrukta', RUNNING: 'Çalışıyor', SUCCEEDED: 'Tamamlandı (öneri)', FAILED: 'Hata', WAITING_QUOTA: 'Kota bekliyor', NO_PROVIDER: 'Sağlayıcı yok', NOT_ALLOWED: 'İzin yok' };
const TEST_LABEL = 'Test sağlayıcısı — gerçek değil';
/** Sözleşme görevlerini (AI06 okuma, AI14 inceleme) yeniden yönlendirmek okuma/inceleme istemektir (contract.ai.request). AI15'i isteyen kural yeniden ister. */
const CONTRACT_TASKS = new Set(['AI06', 'AI14']);
const FLAG_TR: Record<string, string> = {
  IGNORED_KEY: 'modelin karar/puan anahtarı yok sayıldı', UNVERIFIED_SCAN: 'taranmış sayfa', SOURCE_NOT_FOUND: 'kaynak bulunamadı', UNDERIVABLE: 'değer türetilemedi',
  MISSING: 'alan okunamadı', NO_SOURCE: 'kaynak gösterilmedi', SHORT_QUOTE: 'alıntı çok kısa', VALUE_NOT_IN_SOURCE: 'değer alıntıda yok', INVALID_TAX_ID: 'VKN kontrol basamağı tutmuyor',
  INVALID_VALUE: 'değer biçimi geçersiz', INVALID_FORMAT: 'değer biçimi geçersiz', SOURCE_NOT_VERIFIED: 'kaynak doğrulanamadı', TEMPLATE_UNAVAILABLE: 'şablon metni okunamadı',
  DROPPED_FINDING: 'geçersiz bulgu atıldı', UNCLEAR: 'cevap belirsiz',
  WEAK_SOURCE: 'alıntı değeri zayıf destekliyor', IGNORED_ANSWER: 'sorulmayan soruya verilen cevap yok sayıldı',
};
/** Okunan alanların Türkçe adları (işaret öneki `alan:KOD`). */
const AI_FIELD_TR: Record<string, string> = {
  title: 'Sözleşme başlığı', contractType: 'Sözleşme türü', supplierName: 'Tedarikçi adı', supplierVkn: 'Tedarikçi VKN', signedOn: 'İmza tarihi',
  startDate: 'Başlangıç tarihi', endDate: 'Bitiş tarihi', indefinite: 'Süresiz', noticePeriodDays: 'İhbar süresi', amount: 'Tutar', currency: 'Para birimi',
  limitBasis: 'Limit esası', autoRenewal: 'Otomatik yenileme', contractNo: 'Sözleşme numarası', paymentTermDays: 'Ödeme vadesi', guarantee: 'Teminat',
  slaPenalty: 'SLA / cezai şart', kvkkClause: 'KVKK maddesi', governingCourt: 'Yetkili mahkeme', priceEscalation: 'Fiyat farkı / artış',
};
/**
 * Ham kod gösterilmez. Persona K7: işaretler `KOD`, `KOD:ayrıntı` (IGNORED_KEY:score), `alan:KOD` (AI06) ya da `findingN:KOD` (AI14) biçimindedir;
 * önek alan ya da bulgu adıyla Türkçe yazılır. Bilinmeyen kod yine genel metinle (öznesiyle).
 */
export function flagTr(f: string): string {
  const parts = f.split(':');
  if (FLAG_TR[parts[0]!]) return FLAG_TR[parts[0]!]!;
  const code = parts[parts.length - 1]!;
  const subject = parts.slice(0, -1).join(':');
  const n = /^finding(\d+)$/.exec(subject);
  const who = n ? `${Number(n[1]) + 1}. bulgu` : AI_FIELD_TR[subject] ?? null;
  const what = FLAG_TR[code] ?? 'diğer denetim işareti';
  return who ? `${who}: ${what}` : what;
}
/** Persona K7: aylık harcama ekranda 2 ondalığa yuvarlanır (yarım yukarı, decimal string; kayan nokta yok); kesin değer title'da. */
export function spend2(v: string | null | undefined): string {
  const m = v == null ? null : /^(-?)(\d+)(?:\.(\d+))?$/.exec(v.trim());
  if (!m) return trDecimal(v);
  const frac = (m[3] ?? '').padEnd(3, '0');
  let cents = BigInt(`${m[2]}${frac.slice(0, 2)}`);
  if (Number(frac[2]) >= 5) cents += 1n;
  const s = cents.toString().padStart(3, '0');
  return trDecimal(`${m[1]}${s.slice(0, -2)}.${s.slice(-2)}`);
}

export function AiPage() {
  const { me } = useSession();
  const r = useResource<AiOverview>('/api/v1/ai/overview');
  const a = useAct(r.reload);
  const t = useAct(r.reload);
  const rr = useAct(r.reload);
  const [editing, setEditing] = useState(false);
  const [threshold, setThreshold] = useState<string | null>(null);
  if (r.loading && !r.data) return <div className="page"><Loading rows={6} /></div>;
  if (r.error || !r.data) return <div className="page"><ErrorState error={r.error} onRetry={r.reload} /></div>;
  const d = r.data;
  const enabled = d.models.filter((m) => m.enabled);
  const realEnabled = enabled.filter((m) => !m.isTestProvider);
  const canContractAi = hasRole(me, 'PROCUREMENT', 'DEPARTMENT_USER');
  const canRetry = (x: AiOverview['runs'][number]) => ['WAITING_QUOTA', 'NO_PROVIDER', 'NOT_ALLOWED'].includes(x.status) && x.task !== 'AI15' && (!CONTRACT_TASKS.has(x.task) || canContractAi);
  const thr = threshold ?? String(d.contractSettings?.reviewThreshold ?? '');
  const thrValid = /^\d{1,3}$/.test(thr) && Number(thr) <= 100;
  return (
    <div className="page">
      <PageHeader title="Yapay zekâ">Önce kural ve yapılandırılmış veri; model yalnız izinli sağlayıcı, bölge ve bütçe kapısından geçerse çalışır. Para, vergi, VKN eşleme, limit, puan ve onay modele verilmez.</PageHeader>
      {!realEnabled.length && (enabled.length
        ? <Banner tone="neutral" icon="info" title="Yalnız test sağlayıcısı etkin (gerçek değil)">Kayıtlı görevleri ({[...new Set(enabled.flatMap((m) => m.tasks))].join(', ')}) ücretsiz test sağlayıcısı çalıştırır; çıktısı gerçek okuma ya da gerçek inceleme değildir. Diğer görevler manuel akışla sürer. Gerçek sağlayıcı ve ücretli kullanım kurum onayı ister.</Banner>
        : <Banner tone="neutral" icon="info" title="Etkin AI sağlayıcısı yok">Tüm AI görevleri manuel akışla sürer. Sağlayıcı seçimi ve ücretli kullanım kurum onayı ister.</Banner>)}
      <Banner tone="warn" icon="alert" title="Kalite ölçümü yapılamadı: gerçek sözleşmelerle ölçülmedi (NOT_RUN)">{d.quality.reason}</Banner>
      {d.provider && (
        <section className="panel mb-5" aria-labelledby="ai-provider-h">
          <div className="panel-head flex-wrap"><h2 id="ai-provider-h" className="flex-1">Model ve sağlayıcı</h2>
            {d.provider.kind === 'test' ? <Tag label={{ text: TEST_LABEL, tone: 'warn', icon: 'alert' }} /> : d.provider.kind === 'none' ? <Tag label={{ text: 'Bağlı değil', tone: 'neutral', icon: 'minus' }} /> : <Tag label={{ text: 'Kurum dışı API', tone: 'info', icon: 'info' }} />}</div>
          <div className="panel-body grid grid-cols-3 gap-x-6 gap-y-3 max-[900px]:grid-cols-1">
            <div><p className="m-0 text-sm text-ink-muted">Model</p><p className="m-0 mono [overflow-wrap:anywhere]">{d.provider.modelId}</p>
              <p className="m-0 text-sm text-ink-subtle">Salt okunur. Tek ayar: <span className="mono">AI_MODEL_ID</span> (sunucu yapılandırması).</p></div>
            <div><p className="m-0 text-sm text-ink-muted">Sağlayıcı</p><p className="m-0">{d.provider.label}</p>
              <p className="m-0 text-sm text-ink-subtle">{d.provider.external ? 'Sözleşme metni kurum dışına çıkar (KVKK onayı gerekir).' : d.provider.kind === 'test' ? 'Ağ yok, ücret yok; çıktısı gerçek okuma ya da gerçek inceleme değildir.' : 'Yapay zekâ çağrısı yapılmaz; elle akış sürer.'}</p></div>
            <div><p className="m-0 text-sm text-ink-muted">Bu ay harcanan</p><p className="m-0 tabular" title={`Kesin değer: ${trDecimal(d.usage.monthSpent)} ${d.policy?.budgetCurrency ?? ''}`.trim()}>{spend2(d.usage.monthSpent)} {d.policy?.budgetCurrency ?? ''}</p>
              <p className="m-0 text-sm text-ink-subtle">Bütçe: {d.policy?.monthlyBudget ? `${trDecimal(d.policy.monthlyBudget)} ${d.policy.budgetCurrency}` : d.policy ? 'sınırsız' : 'politika yok (ücretli AI kapalı)'}</p></div>
          </div>
        </section>
      )}
      <div className="grid grid-cols-[minmax(0,1fr)_360px] gap-6 max-[1100px]:grid-cols-1">
        <div className="grid min-w-0 content-start gap-5">
          <section className="panel"><div className="panel-head"><h2>Görev matrisi</h2></div>
            <Table><TableHeader><TableRow className="hover:bg-transparent"><TableHead>Görev</TableHead><TableHead className="max-[900px]:hidden">Önce</TableHead><TableHead>İnsan kontrolü</TableHead></TableRow></TableHeader>
              <TableBody>{d.tasks.map((t) => <TableRow key={t.code}><TableCell><span className="mono text-sm">{t.code}</span> {t.name}</TableCell><TableCell className="text-sm max-[900px]:hidden">{t.deterministic}</TableCell><TableCell className="text-sm">{t.human}</TableCell></TableRow>)}</TableBody></Table></section>
          <section className="panel min-w-0" aria-labelledby="ai-ledger-h"><div className="panel-head flex-wrap"><h2 id="ai-ledger-h" className="flex-1">Çağrı defteri · son çalıştırmalar</h2><span className="text-sm text-ink-subtle">Çalışmayan istek de sebebiyle kaydedilir. İstem ve belge metni saklanmaz.</span></div>
            {!d.runs.length ? <div className="panel-body"><p className="text-ink-muted">Kayıt yok.</p></div> : (
              <div className="overflow-x-auto">
                <table className="w-full min-w-[960px] text-left text-sm">
                  <caption className="sr-only">Yapay zekâ çağrı defteri</caption>
                  <thead className="bg-sunken text-ink-muted"><tr>{['Tarih', 'Kim', 'Görev', 'Belge sürümü', 'Model', 'İstem sürümü', 'Token giriş / çıkış', 'Ücret', 'Durum'].map((h) =>
                    <th key={h} scope="col" className={cn('px-3 py-2 font-semibold', (h === 'Ücret' || h.startsWith('Token')) && 'text-right')}>{h}</th>)}</tr></thead>
                  <tbody>{d.runs.map((x) => (
                    <tr key={x.id} className="border-t border-border align-top">
                      <td className="tabular whitespace-nowrap px-3 py-2">{fmtDateTime(x.createdAt)}</td>
                      <td className="px-3 py-2">{x.requestedBy ?? 'Sistem'}</td>
                      <td className="px-3 py-2"><span className="mono">{x.task}</span></td>
                      <td className="px-3 py-2">{x.documentVersionId ? <Link to={`/belgeler/${x.documentVersionId}`} className="mono" title={x.documentVersionId}>{x.documentVersionId.slice(0, 8)}</Link> : '—'}</td>
                      <td className="px-3 py-2"><span className="mono [overflow-wrap:anywhere]">{x.provider ? `${x.provider}/${x.responseModel ?? x.modelId}` : '—'}</span>
                        {x.isTestProvider && <span className="mt-0.5 block"><Tag label={{ text: x.providerLabel ?? TEST_LABEL, tone: 'warn', icon: 'alert' }} /></span>}</td>
                      <td className="px-3 py-2"><span className="mono">{x.promptVersion ?? '—'}</span></td>
                      <td className="tabular whitespace-nowrap px-3 py-2 text-right">{x.inputTokens != null || x.outputTokens != null ? `${x.inputTokens?.toLocaleString('tr-TR') ?? '—'} / ${x.outputTokens?.toLocaleString('tr-TR') ?? '—'}` : '—'}</td>
                      <td className="tabular whitespace-nowrap px-3 py-2 text-right">{x.actualCost ? `${trDecimal(x.actualCost)} ${x.costCurrency ?? ''}` : x.estimatedCost ? `tahmini ${trDecimal(x.estimatedCost)} ${x.costCurrency ?? ''}` : '—'}</td>
                      <td className="px-3 py-2"><strong>{RUN_STATUS[x.status] ?? 'Bilinmeyen durum'}</strong>
                        {x.reason && <span className="block text-ink-muted">{x.reason}</span>}
                        {x.flags.length > 0 && <span className="block text-warn">Denetim: {[...new Set(x.flags.map(flagTr))].join(', ')}</span>}
                        {canRetry(x) && <button type="button" className="underline" disabled={rr.busy}
                          onClick={() => void rr.run(() => api(`/api/v1/ai/runs/${x.id}/retry`, { method: 'POST' }), 'İş yeniden yönlendirildi.')}>Yeniden dene</button>}</td>
                    </tr>))}</tbody>
                </table>
              </div>)}
            {rr.feedback && <div className="panel-body">{rr.feedback}</div>}</section>
          <section className="panel" aria-labelledby="ai-quality-h"><div className="panel-head"><h2 id="ai-quality-h" className="flex-1">Doğruluk ölçümü</h2><Tag label={{ text: 'Ölçülmedi (NOT_RUN)', tone: 'neutral', icon: 'minus' }} /></div>
            <div className="panel-body grid gap-2"><p className="m-0">{d.quality.reason}</p>
              <p className="m-0 text-sm text-ink-muted">Sözleşme alanı okuma doğruluğu: {d.quality.contractAccuracy === 'NOT_RUN' || !d.quality.contractAccuracy ? 'ölçülmedi' : d.quality.contractAccuracy}. Ölçülmeden "okuyor" denmez; okunan her değer insan kaydıyla sözleşmeye girer.</p></div></section>
        </div>
        <aside className="grid content-start gap-4">
          <section className="panel"><div className="panel-head"><h2>Kiracı politikası</h2>{d.can.manage && !editing && <span className="ml-auto flex gap-1"><Button size="sm" variant="outline" onClick={() => { a.clear(); setEditing(true); }}>Düzenle</Button>
              {d.policy && <Button size="sm" variant="ghost" disabled={a.busy} onClick={() => void a.run(() => api('/api/v1/ai/policy', { method: 'DELETE' }), 'Politika kaldırıldı; ücretli AI kapalı.')}>Kaldır</Button>}</span>}</div>
            <div className="panel-body">{editing ? <PolicyForm p={d.policy} onSubmit={(b) => a.run(() => api('/api/v1/ai/policy', { method: 'PUT', json: b }), 'Politika kaydedildi.').then((ok) => { if (ok) setEditing(false); })} onCancel={() => setEditing(false)} />
              : !d.policy ? <p className="text-ink-muted">Tanımlı değil: ücretli AI kapalı.</p> : <dl className="facts">
                <dt>İzinli sağlayıcı</dt><dd>{d.policy.allowedProviders.join(', ') || '—'}</dd><dt>İzinli bölge</dt><dd>{d.policy.allowedRegions.join(', ') || '—'}</dd>
                <dt>Aylık bütçe</dt><dd className="tabular">{d.policy.monthlyBudget ? `${d.policy.monthlyBudget} ${d.policy.budgetCurrency}` : 'Sınırsız'}</dd>
                <dt>Günlük çağrı</dt><dd className="tabular">{d.policy.dailyCallLimit ?? 'Sınırsız'}</dd></dl>}
              {a.feedback}</div></section>
          {d.contractSettings && (
            <section className="panel" aria-labelledby="ai-threshold-h"><div className="panel-head"><h2 id="ai-threshold-h">İnceleme eşiği</h2></div>
              <div className="panel-body grid gap-2">
                {d.can.manage ? (
                  <form className="grid gap-2" onSubmit={(e) => { e.preventDefault(); if (!thrValid) return;
                    void t.run(() => api('/api/v1/ai/contract-settings', { method: 'PUT', json: { reviewThreshold: Number(thr) } }), 'Eşik kaydedildi.').then((ok) => { if (ok) setThreshold(null); }); }}>
                    <Field label="Ön inceleme eşiği (0–100)" hint={`Varsayılan ${d.contractSettings.defaultThreshold}. Altındaki puanda ek onaycı önerilir; gönderim engellenmez.`}
                      error={!thrValid && thr !== '' ? '0 ile 100 arasında tam sayı girin.' : null}>
                      {(x) => <input className="input tabular w-24 text-right" inputMode="numeric" {...x} value={thr} onChange={(e) => { t.clear(); setThreshold(e.target.value.replace(/\D/g, '').slice(0, 3)); }} />}</Field>
                    <Button type="submit" size="sm" className="justify-self-start" disabled={t.busy || !thrValid || Number(thr) === d.contractSettings.reviewThreshold}>Eşiği kaydet</Button>
                  </form>
                ) : <dl className="facts"><dt>Eşik</dt><dd className="tabular">{d.contractSettings.reviewThreshold}</dd></dl>}
                <p className="m-0 text-sm text-ink-subtle">{d.contractSettings.updatedAt ? `Son değişiklik: ${d.contractSettings.updatedBy ?? '—'} · ${fmtDateTime(d.contractSettings.updatedAt)}` : 'Varsayılan değer kullanılıyor.'}</p>
                {t.feedback}
              </div></section>
          )}
          <section className="panel"><div className="panel-head"><h2>Kullanım</h2></div>
            <div className="panel-body"><dl className="facts"><dt>Bu ay</dt><dd className="tabular" title={`Kesin değer: ${trDecimal(d.usage.monthSpent)} ${d.policy?.budgetCurrency ?? ''}`.trim()}>{spend2(d.usage.monthSpent)} {d.policy?.budgetCurrency ?? ''}</dd><dt>Bugün çağrı</dt><dd className="tabular">{d.usage.todayCalls}</dd></dl>
              <p className="mt-2 text-sm text-ink-subtle">%80'de uyarı; %100'de yeni ücretli iş bekler, manuel iş sürer. Gerçekleşen ücret yoksa tahmin sayılır; bilinmeyen tarife sıfır yazılmaz.</p></div></section>
          <section className="panel"><div className="panel-head"><h2>Model kaydı</h2></div>
            <div className="panel-body">{!d.models.length ? <p className="text-ink-muted">Kayıtlı model yok.</p> : <ul className="grid gap-2">{d.models.map((m) => (
              <li key={m.id} className="text-sm"><strong className="[overflow-wrap:anywhere]">{m.provider}/{m.modelId}</strong> <span className="text-ink-subtle">{m.modelVersion}</span>{!m.enabled && ' · kapalı'}{!m.adapterInstalled && ' · bağdaştırıcı yok'}
                {m.isTestProvider && <span className="mt-0.5 block"><Tag label={{ text: TEST_LABEL, tone: 'warn', icon: 'alert' }} /></span>}
                <span className="block text-ink-muted">{m.tasks.join(', ')} · {Object.entries(m.capabilities).filter(([, v]) => v).map(([k]) => k).join(', ')} · bölge {m.approvedRegions.join(', ')}{m.trainsOnCustomerData ? ' · müşteri verisiyle eğitir' : ''}</span></li>))}</ul>}</div></section>
        </aside>
      </div>
    </div>
  );
}

function PolicyForm({ p, onSubmit, onCancel }: { p: AiOverview['policy']; onSubmit: (b: Record<string, unknown>) => void; onCancel: () => void }) {
  const [f, setF] = useState({ providers: p?.allowedProviders.join(', ') ?? '', regions: p?.allowedRegions.join(', ') ?? '', budget: p?.monthlyBudget ?? '', currency: p?.budgetCurrency ?? 'USD', daily: p?.dailyCallLimit?.toString() ?? '' });
  const list = (s: string) => s.split(',').map((x) => x.trim()).filter(Boolean);
  return (
    <form className="grid gap-2" onSubmit={(e) => { e.preventDefault(); onSubmit({ allowedProviders: list(f.providers), allowedRegions: list(f.regions), monthlyBudget: f.budget || null, budgetCurrency: f.currency,
      dailyCallLimit: f.daily ? Number(f.daily) : null, allowUpgrade: p?.allowUpgrade ?? false }); }}>
      <Field label="İzinli sağlayıcılar" hint="Virgülle ayırın">{(x) => <input className="input" {...x} value={f.providers} onChange={(e) => setF({ ...f, providers: e.target.value })} />}</Field>
      <Field label="İzinli bölgeler">{(x) => <input className="input" {...x} value={f.regions} onChange={(e) => setF({ ...f, regions: e.target.value })} />}</Field>
      <div className="grid grid-cols-[minmax(0,1fr)_80px] items-start gap-2"><Field label="Aylık bütçe" hint="Boş = sınırsız">{(x) => <input className="input tabular text-right" inputMode="decimal" {...x} value={f.budget} onChange={(e) => setF({ ...f, budget: e.target.value.replace(',', '.') })} />}</Field>
        <Field label="Birim">{(x) => <input className="input" maxLength={3} {...x} value={f.currency} onChange={(e) => setF({ ...f, currency: e.target.value.toUpperCase() })} />}</Field></div>
      <Field label="Günlük çağrı sınırı">{(x) => <input className="input tabular text-right" inputMode="numeric" {...x} value={f.daily} onChange={(e) => setF({ ...f, daily: e.target.value.replace(/\D/g, '') })} />}</Field>
      <div className="flex gap-2"><Button type="submit" size="sm">Kaydet</Button><Button type="button" size="sm" variant="ghost" onClick={onCancel}>Vazgeç</Button></div>
    </form>
  );
}

// --- Kategori bazında performans ağırlığı (kurum politikası) -----------------------------------------

/** Kategori başına tek yürürlükteki ağırlık; yeni kural öncekini emekliye ayırır. İnceleme kaydı o anki ağırlığı kopyalar, geçmiş puan değişmez. */
export function PerformanceWeightsPage() {
  const r = useResource<{ items: WeightPolicy[]; can: { manage: boolean } }>('/api/v1/performance-weights');
  const a = useAct(r.reload);
  const [f, setF] = useState<{ category: string; weights: Record<string, string>; reason: string } | null>(null);
  const sum = f ? DIMS.reduce((n, [k]) => n + (Number(f.weights[k]) || 0), 0) : 0;
  const start = (category = '', w: Record<string, number> = DEFAULT_W) => { a.clear(); setF({ category, weights: Object.fromEntries(DIMS.map(([k]) => [k, String(w[k] ?? 0)])), reason: '' }); };
  const active = r.data?.items.filter((x) => !x.retiredAt) ?? [];
  const retired = r.data?.items.filter((x) => x.retiredAt) ?? [];
  return (
    <div className="page">
      <PageHeader title="Performans ağırlıkları">Tedarikçi performans puanında boyut ağırlıkları kategoriye göre belirlenir. Kural yoksa örnek ağırlık uygulanır: {weightText(DEFAULT_W)}.
        Yeni kural yalnız sonraki incelemelere uygulanır; kayıtlı incelemeler kendi ağırlığıyla kalır.</PageHeader>
      {r.loading && !r.data ? <Loading /> : r.error ? <ErrorState error={r.error} onRetry={r.reload} /> : <>
        {r.data!.can.manage && !f && <div className="mb-3"><Button onClick={() => start()}>Kategori kuralı ekle</Button></div>}
        {f && (
          <form className="panel mb-4" onSubmit={(e) => { e.preventDefault();
            void a.run(() => api('/api/v1/performance-weights', { method: 'PUT', json: { category: f.category, reason: f.reason, weights: Object.fromEntries(DIMS.map(([k]) => [k, Number(f.weights[k]) || 0])) } }),
              `"${f.category.trim()}" ağırlığı yürürlüğe girdi.`).then((ok) => { if (ok) setF(null); }); }}>
            <div className="panel-head"><h2>Kategori ağırlığı</h2><span className={cn('tabular text-sm', sum === 100 ? 'text-ink-subtle' : 'text-danger')}>Toplam %{sum}{sum !== 100 ? ' · 100 olmalı' : ''}</span></div>
            <div className="panel-body grid gap-3">
              <Field label="Kategori" hint="İncelemedeki kategoriyle aynı yazılır (büyük/küçük harf ve baştaki/sondaki boşluk önemsiz).">{(p) =>
                <input className="input" required maxLength={200} {...p} value={f.category} onChange={(e) => setF({ ...f, category: e.target.value })} />}</Field>
              <div className="grid grid-cols-5 items-start gap-3 max-[1100px]:grid-cols-2">
                {DIMS.map(([k, l]) => <Field key={k} label={`${l} (%)`}>{(p) => <input className="input tabular text-right" inputMode="numeric" required {...p} value={f.weights[k] ?? ''}
                  onChange={(e) => setF({ ...f, weights: { ...f.weights, [k]: e.target.value.replace(/\D/g, '').slice(0, 3) } })} />}</Field>)}
              </div>
              <Field label="Gerekçe" hint="Neden bu kategoride farklı ağırlık (en az 10 karakter); denetim kaydına yazılır.">{(p) =>
                <textarea className="input" rows={2} required minLength={10} {...p} value={f.reason} onChange={(e) => setF({ ...f, reason: e.target.value })} />}</Field>
              <div className="flex gap-2"><Button type="submit" disabled={a.busy || sum !== 100 || f.reason.trim().length < 10 || !f.category.trim()}>Yürürlüğe al</Button>
                <Button type="button" variant="ghost" onClick={() => setF(null)}>Vazgeç</Button></div>
            </div>
          </form>
        )}
        <div aria-live="polite" className="mb-3">{a.feedback}</div>
        {!active.length ? <div className="rounded-md border border-border bg-surface"><Empty icon="info" title="Kategori kuralı yok">Tüm incelemelerde örnek ağırlık uygulanır.</Empty></div> : (
          <Table>
            <TableHeader><TableRow className="hover:bg-transparent"><TableHead>Kategori</TableHead>{DIMS.map(([k, l]) => <TableHead key={k} className="text-right">{l}</TableHead>)}<TableHead>Gerekçe</TableHead></TableRow></TableHeader>
            <TableBody>{active.map((x) => (
              <TableRow key={x.id}>
                <TableCell className="min-w-[180px] font-semibold">{x.category}<span className="block text-sm font-normal text-ink-subtle">{x.setBy} · {fmtDate(x.createdAt)}</span>
                  {r.data!.can.manage && <Button size="sm" variant="outline" className="mt-1.5" onClick={() => start(x.category, x.weights)}>Değiştir<span className="sr-only"> ({x.category})</span></Button>}</TableCell>
                {DIMS.map(([k]) => <TableCell key={k} className="tabular text-right">%{x.weights[k]}</TableCell>)}
                <TableCell className="min-w-[200px] text-sm">{x.reason}</TableCell>
              </TableRow>
            ))}</TableBody>
          </Table>
        )}
        {retired.length > 0 && <details className="mt-4"><summary className="cursor-pointer text-sm text-ink-muted">Emekli kurallar ({retired.length})</summary>
          <ul className="mt-2 grid gap-1 text-sm">{retired.map((x) => <li key={x.id}><strong>{x.category}</strong>: {weightText(x.weights)} · {x.setBy}, {fmtDate(x.createdAt)}–{fmtDate(x.retiredAt!)}</li>)}</ul></details>}
      </>}
    </div>
  );
}
