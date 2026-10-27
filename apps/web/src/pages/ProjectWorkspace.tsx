import { useMemo, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { api, apiBlob, ApiError } from '../lib/api.ts';
import { useResource } from '../lib/useApi.ts';
import { fmtDate, fmtDateTime, fmtMoney } from '../lib/format.ts';
import { costKindLabel, lineState, PROJECT_STAGES, projectStatus } from '../lib/labels.ts';
import { Banner, Empty, ErrorState, Field, Loading, Tag } from '../ui/kit.tsx';
import { Icon } from '../ui/icons.tsx';
import { Button } from '@/components/ui/button';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { cn } from '@/lib/utils';

interface PLine { id: string; lot: string; lineNo: number; description: string; unit: string; quantity: string; spec: string }
interface Crit { code: string; name: string; kind: 'PRICE' | 'SCORE'; weight: string; revision: number }
interface Detail {
  project: { id: string; code: string; title: string; category: string; need: string; currency: string; budget: string | null; budgetVerified: boolean;
    costCenter: string | null; deliveryLocation: string | null; neededBy: string | null; status: string; etag: string; ownedByMe: boolean };
  lines: PLine[]; criteria: Crit[]; criteriaHistory: { revision: number; reason: string | null; createdAt: string }[];
  round: null | { id: string; roundNo: number; closesAt: string; status: string; requestedByMe: boolean; closeReason: string | null };
  invitations: { supplierId: string; supplierName: string; supplierStatus: string; bidVersion: number | null; submittedAt: string | null }[];
  questions: { id: string; question: string; askedAt: string; answer: string | null; answeredAt: string | null; supplierName: string }[];
  evaluations: { id: string; versionNo: number; createdAt: string; createdBy: string; current: boolean }[];
  awards: { id: string; versionNo: number; status: string; total: string; rationale: string; evaluationId: string; evaluationCurrent: boolean; proposedBy: string; proposedByMe: boolean;
    proposedAt: string; decidedBy: string | null; decidedAt: string | null; decisionNote: string | null;
    lines: { projectLineId: string; supplierId: string; supplierName: string; quantity: string; unitPrice: string; amount: string }[] }[];
  serverTime: string;
  can: { manage: boolean; approvePublish: boolean; score: boolean; evaluate: boolean; propose: boolean; decide: boolean; answer: boolean };
}

const TABS = [['ozet', 'Özet'], ['kalemler', 'Kalemler'], ['teklifler', 'Teklifler'], ['karsilastirma', 'Karşılaştırma'], ['karar', 'Karar']] as const;
const STAGE_TEXT: Record<string, string> = { DRAFT: 'Taslak', IN_APPROVAL: 'Onayda', OPEN: 'Teklife açık', EVALUATION: 'Değerlendirme', AWARD_APPROVAL: 'Seçim onayı', CONTRACTING: 'Sözleşme' };

function nextStep(d: Detail): string {
  const s = d.project.status;
  if (s === 'DRAFT') return d.can.manage ? 'Kalemleri ve kriterleri gözden geçirip teklif turunu yayına gönderin.' : 'Satınalmacının yayına göndermesi bekleniyor.';
  if (s === 'IN_APPROVAL') return d.round?.requestedByMe ? 'Satınalma yöneticisinin yayın onayı bekleniyor (görev ayrılığı).' : d.can.approvePublish ? 'Yayını onaylayın veya gerekçeyle geri gönderin.' : 'Yayın onayı bekleniyor.';
  if (s === 'OPEN') return `Teklifler ${fmtDateTime(d.round?.closesAt)} kapanışına kadar mühürlü. Soruları yanıtlayın.`;
  if (s === 'EVALUATION') return 'Kapsamı ve karşılaştırmayı inceleyin, kanıtlı puanları girin, değerlendirme sürümü oluşturup tahsis önerin.';
  if (s === 'AWARD_APPROVAL') return d.can.decide ? 'Önerilen tahsisi inceleyip onaylayın veya geri gönderin.' : 'Seçim onayı bekleniyor.';
  if (s === 'CONTRACTING') return 'Kazanan tahsisi onaylandı. Sözleşme ve sipariş aşamasına geçilebilir.';
  return '—';
}

export function ProjectWorkspace() {
  const { id } = useParams();
  const [params, setParams] = useSearchParams();
  const tab = params.get('sekme') ?? 'ozet';
  const r = useResource<Detail>(`/api/v1/projects/${id}`);
  if (r.loading && !r.data) return <div className="page"><Loading rows={6} /></div>;
  if (r.error) return <div className="page"><ErrorState error={r.error} onRetry={r.reload} /></div>;
  const d = r.data!;
  const stageIdx = PROJECT_STAGES.indexOf(d.project.status as (typeof PROJECT_STAGES)[number]);
  return (
    <div className="page">
      <div className="mb-1 text-sm text-ink-subtle"><Link to="/projeler" className="text-ink-subtle">Projeler</Link> / <span className="tabular">{d.project.code}</span></div>
      <div className="mb-4 flex flex-wrap items-start gap-3">
        <h1 className="min-w-0 flex-1">{d.project.title}</h1>
        <Tag label={projectStatus[d.project.status]} />
      </div>
      <ol aria-label="Proje aşaması" className="mb-3 grid grid-cols-6 overflow-hidden rounded-md border border-border bg-surface text-sm max-[900px]:grid-cols-3">
        {PROJECT_STAGES.map((s, i) => (
          <li key={s} aria-current={i === stageIdx ? 'step' : undefined}
            className={cn('flex items-center gap-1.5 border-r border-border px-3 py-2 last:border-r-0', i === stageIdx ? 'bg-ink font-semibold text-primary-foreground' : i < stageIdx ? 'text-ink' : 'text-ink-subtle')}>
            {i < stageIdx ? <Icon name="check" size={14} /> : <span className="tabular w-3.5 text-center">{i + 1}</span>}{STAGE_TEXT[s]}
          </li>
        ))}
      </ol>
      <p className="mb-5 flex gap-2 text-md"><Icon name="arrow" size={18} className="mt-0.5 shrink-0 text-ink-subtle" /><span><span className="font-semibold">Sonraki adım: </span>{nextStep(d)}</span></p>
      <div role="tablist" aria-label="Proje çalışma alanı" className="mb-5 flex gap-6 overflow-x-auto border-b border-border">
        {TABS.map(([k, l]) => (
          <button key={k} role="tab" aria-selected={tab === k} onClick={() => { const p = new URLSearchParams(params); p.set('sekme', k); setParams(p, { replace: true }); }}
            className={cn('-mb-px min-h-10 whitespace-nowrap border-b-2 font-semibold transition-colors duration-150', tab === k ? 'border-ink text-ink' : 'border-transparent text-ink-muted hover:text-ink')}>{l}</button>
        ))}
      </div>
      <div role="tabpanel">
        {tab === 'ozet' && <Summary d={d} reload={r.reload} />}
        {tab === 'kalemler' && <Lines d={d} />}
        {tab === 'teklifler' && <Bids d={d} reload={r.reload} />}
        {tab === 'karsilastirma' && <ComparisonTab d={d} reload={r.reload} />}
        {tab === 'karar' && <Decision d={d} reload={r.reload} />}
      </div>
    </div>
  );
}

function useAction(reload: () => Promise<void> | void) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const run = async (fn: () => Promise<unknown>, ok: string) => {
    setBusy(true); setError(null); setDone(null);
    try { await fn(); setDone(ok); await reload(); } catch (e) { setError(e as ApiError); } finally { setBusy(false); }
  };
  const feedback = <div aria-live="polite">{error && <Banner tone={error.status === 409 ? 'warn' : 'danger'} title={error.message} />}{done && <Banner tone="info" icon="check" title={done} />}</div>;
  return { busy, run, feedback };
}

function Summary({ d, reload }: { d: Detail; reload: () => Promise<void> }) {
  const p = d.project;
  return (
    <div className="grid grid-cols-[minmax(0,1fr)_420px] gap-6 max-[1100px]:grid-cols-1">
      <section className="panel">
        <div className="panel-head"><h2>Proje kartı</h2></div>
        <div className="panel-body">
          <dl className="facts">
            <dt>Proje no</dt><dd className="tabular">{p.code}</dd>
            <dt>Kategori</dt><dd>{p.category}</dd>
            <dt>Bütçe</dt><dd className="tabular">{p.budget ? fmtMoney(p.budget, p.currency) : '—'} {p.budget && (p.budgetVerified ? <Tag className="ml-1.5" label={{ text: 'Doğrulandı', tone: 'human', icon: 'stamp' }} /> : <Tag className="ml-1.5" label={{ text: 'Bütçe doğrulanmadı', tone: 'warn', icon: 'alert' }} />)}</dd>
            <dt>Maliyet merkezi</dt><dd>{p.costCenter ?? '—'}</dd>
            <dt>Teslimat yeri</dt><dd>{p.deliveryLocation ?? '—'}</dd>
            <dt>İhtiyaç tarihi</dt><dd>{p.neededBy ? fmtDate(p.neededBy) : '—'}</dd>
            <dt>İhtiyaç</dt><dd className="whitespace-pre-wrap">{p.need || '—'}</dd>
          </dl>
        </div>
      </section>
      <RoundPanel d={d} reload={reload} />
    </div>
  );
}

function RoundPanel({ d, reload }: { d: Detail; reload: () => Promise<void> }) {
  const a = useAction(reload);
  const suppliers = useResource<{ items: { id: string; legalName: string; status: string }[] }>(d.can.manage && ['DRAFT', 'EVALUATION'].includes(d.project.status) ? '/api/v1/supplier-options' : null);
  const [picked, setPicked] = useState<string[]>([]);
  const [closesAt, setClosesAt] = useState('');
  const [note, setNote] = useState('');
  const round = d.round;
  const canPublish = d.can.manage && ['DRAFT', 'EVALUATION'].includes(d.project.status);
  return (
    <section className="panel self-start">
      <div className="panel-head"><h2>Teklif turu</h2>{round && <span className="tabular text-sm text-ink-subtle">Tur {round.roundNo}</span>}</div>
      <div className="panel-body grid gap-3">
        {round ? (
          <dl className="facts">
            <dt>Durum</dt><dd>{round.status === 'OPEN' ? 'Açık' : round.status === 'PENDING_APPROVAL' ? 'Yayın onayı bekliyor' : round.status === 'CLOSED' ? 'Kapandı' : 'İptal'}</dd>
            <dt>Kapanış</dt><dd className="tabular">{fmtDateTime(round.closesAt)} <span className="text-sm text-ink-subtle">(sunucu saati)</span></dd>
            <dt>Davetli</dt><dd>{d.invitations.length} tedarikçi</dd>
            {round.closeReason && <><dt>Not</dt><dd>{round.closeReason}</dd></>}
          </dl>
        ) : <p className="text-ink-muted">Henüz teklif turu yok.</p>}
        {round?.status === 'PENDING_APPROVAL' && d.can.approvePublish && !round.requestedByMe && (
          <div className="grid gap-2 border-t border-border pt-3">
            <Field label="Not (geri göndermede zorunlu)">{(p) => <textarea className="input" rows={2} {...p} value={note} onChange={(e) => setNote(e.target.value)} />}</Field>
            <div className="flex flex-wrap gap-2">
              <Button disabled={a.busy} onClick={() => void a.run(() => api(`/api/v1/rfq-rounds/${round.id}/decision`, { method: 'POST', json: { approve: true, note } }), 'Yayın onaylandı; davetliler teklif verebilir.')}><Icon name="stamp" />Yayını onayla</Button>
              <Button variant="outline" disabled={a.busy} onClick={() => void a.run(() => api(`/api/v1/rfq-rounds/${round.id}/decision`, { method: 'POST', json: { approve: false, note } }), 'Tur geri gönderildi.')}>Geri gönder</Button>
            </div>
          </div>
        )}
        {round?.status === 'PENDING_APPROVAL' && round.requestedByMe && <Banner tone="neutral" icon="lock" title="Yayını siz başlattınız">Görev ayrılığı gereği onayı başka bir satınalma yöneticisi verir.</Banner>}
        {round?.status === 'OPEN' && d.can.approvePublish && (
          <div className="grid gap-2 border-t border-border pt-3">
            <Field label="Erken kapanış gerekçesi">{(p) => <textarea className="input" rows={2} {...p} value={note} onChange={(e) => setNote(e.target.value)} />}</Field>
            <Button variant="outline" className="justify-self-start" disabled={a.busy} onClick={() => void a.run(() => api(`/api/v1/rfq-rounds/${round.id}/close`, { method: 'POST', json: { reason: note } }), 'Tur kapatıldı; teklifler açıldı.')}>Turu şimdi kapat</Button>
          </div>
        )}
        {canPublish && (
          <form className="grid gap-2 border-t border-border pt-3" onSubmit={(e) => { e.preventDefault(); void a.run(() => api(`/api/v1/projects/${d.project.id}/rounds`, { method: 'POST', ifMatch: d.project.etag,
            json: { closesAt: closesAt ? new Date(closesAt).toISOString() : '', supplierIds: picked } }), 'Tur yayın onayına gönderildi.'); }}>
            <h3 className="text-base">{d.round ? 'Yeni teklif turu' : 'Yayına gönder'}</h3>
            <Field label="Kapanış" hint="Kapanış sunucu saatine göre uygulanır; sonrasında teklif kabul edilmez.">{(p) => <input className="input tabular" type="datetime-local" {...p} value={closesAt} onChange={(e) => setClosesAt(e.target.value)} required />}</Field>
            <fieldset className="field">
              <legend>Davet edilecek tedarikçiler</legend>
              {suppliers.loading ? <Loading rows={2} /> : (
                <div className="radio-list max-h-56 overflow-auto">
                  {suppliers.data?.items.map((s) => (
                    <label key={s.id}><input type="checkbox" checked={picked.includes(s.id)} onChange={(e) => setPicked((x) => e.target.checked ? [...x, s.id] : x.filter((y) => y !== s.id))} />
                      <span>{s.legalName}{s.status === 'CANDIDATE' && <span className="block text-sm text-warn">Aday: teklif verebilir, aktivasyon olmadan kazanan olamaz</span>}</span></label>
                  ))}
                </div>
              )}
            </fieldset>
            <Button type="submit" className="justify-self-start" disabled={a.busy || !picked.length || !closesAt}>Yayın onayına gönder</Button>
          </form>
        )}
        {a.feedback}
      </div>
    </section>
  );
}

function Lines({ d }: { d: Detail }) {
  const history = d.criteriaHistory.filter((h) => h.reason);
  return (
    <div className="grid gap-6">
      <Table>
        <TableHeader><TableRow className="hover:bg-transparent"><TableHead>Lot</TableHead><TableHead>Kalem</TableHead><TableHead className="text-right">Miktar</TableHead><TableHead>Birim</TableHead><TableHead>Şartname / kabul</TableHead></TableRow></TableHeader>
        <TableBody>{d.lines.map((l) => (
          <TableRow key={l.id}><TableCell className="whitespace-nowrap">{l.lot}</TableCell><TableCell className="font-semibold">{l.description}</TableCell>
            <TableCell className="text-right">{Number(l.quantity).toLocaleString('tr-TR')}</TableCell><TableCell>{l.unit}</TableCell><TableCell className="max-w-[48ch] text-ink-muted">{l.spec || '—'}</TableCell></TableRow>
        ))}</TableBody>
      </Table>
      <section className="panel">
        <div className="panel-head"><h2>Değerlendirme kriterleri</h2><span className="text-sm text-ink-subtle">Revizyon {d.criteria[0]?.revision}</span></div>
        <div className="panel-body grid gap-3">
          <ul className="grid gap-1.5">{d.criteria.map((c) => <li key={c.code} className="flex justify-between gap-3"><span>{c.name} <span className="text-sm text-ink-subtle">{c.kind === 'PRICE' ? 'hesaplanır' : 'kanıtlı puan'}</span></span><span className="tabular font-semibold">%{Number(c.weight).toLocaleString('tr-TR')}</span></li>)}</ul>
          {history.length > 0 && <div className="border-t border-border pt-3"><h3 className="mb-2 text-base">Yayın sonrası değişiklikler</h3>
            <ol className="timeline">{history.map((h) => <li key={h.revision}><strong>Revizyon {h.revision}</strong><span>{h.reason}</span><span className="subtle">{fmtDateTime(h.createdAt)}</span></li>)}</ol></div>}
        </div>
      </section>
    </div>
  );
}

function Bids({ d, reload }: { d: Detail; reload: () => Promise<void> }) {
  const a = useAction(reload);
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const sealed = d.round?.status === 'OPEN';
  return (
    <div className="grid gap-6">
      {sealed && <Banner tone="info" icon="lock" title="Teklif içerikleri kapanışa kadar mühürlü">Alındı bilgisi görünür; fiyatlar {fmtDateTime(d.round?.closesAt)} kapanışından sonra açılır. Bu kural veritabanında da uygulanır.</Banner>}
      {!d.invitations.length ? <div className="rounded-md border border-border bg-surface"><Empty icon="users" title="Davet edilen tedarikçi yok" /></div> : (
        <Table>
          <TableHeader><TableRow className="hover:bg-transparent"><TableHead>Tedarikçi</TableHead><TableHead>Durum</TableHead><TableHead>Teklif</TableHead><TableHead>Alındı (sunucu)</TableHead></TableRow></TableHeader>
          <TableBody>{d.invitations.map((i) => (
            <TableRow key={i.supplierId}>
              <TableCell className="font-semibold"><Link to={`/tedarikciler/${i.supplierId}`} className="text-ink no-underline hover:underline">{i.supplierName}</Link></TableCell>
              <TableCell>{i.supplierStatus === 'ACTIVE' ? <span className="text-sm text-ink-subtle">Aktif</span> : <Tag label={{ text: i.supplierStatus === 'CANDIDATE' ? 'Aday firma' : i.supplierStatus, tone: 'warn', icon: 'clock' }} />}</TableCell>
              <TableCell>{i.bidVersion ? <span className="tabular">Sürüm {i.bidVersion}</span> : <span className="text-ink-subtle">Teklif yok</span>}</TableCell>
              <TableCell className="tabular whitespace-nowrap">{i.submittedAt ? fmtDateTime(i.submittedAt) : '—'}</TableCell>
            </TableRow>
          ))}</TableBody>
        </Table>
      )}
      <section className="panel">
        <div className="panel-head"><h2>Soru ve cevaplar</h2><span className="text-sm text-ink-subtle">Yanıt tüm davetlilere aynı metinle, soranın adı olmadan gider.</span></div>
        <div className="panel-body grid gap-4">
          {!d.questions.length ? <p className="text-ink-muted">Soru yok.</p> : d.questions.map((q) => (
            <div key={q.id} className="grid gap-1.5 border-b border-border pb-3 last:border-b-0 last:pb-0">
              <p><span className="font-semibold">{q.supplierName}</span> <span className="text-sm text-ink-subtle">· {fmtDateTime(q.askedAt)}</span></p>
              <p>{q.question}</p>
              {q.answer ? <p className="text-ink-muted"><span className="font-semibold text-ink">Yanıt:</span> {q.answer}</p> : d.can.answer && (
                <div className="flex flex-wrap items-end gap-2">
                  <div className="min-w-[260px] flex-1"><Field label="Yanıt">{(p) => <textarea className="input" rows={2} {...p} value={answers[q.id] ?? ''} onChange={(e) => setAnswers((x) => ({ ...x, [q.id]: e.target.value }))} />}</Field></div>
                  <Button className="mb-4" disabled={a.busy} onClick={() => void a.run(() => api(`/api/v1/rfq-questions/${q.id}/answer`, { method: 'POST', json: { answer: answers[q.id] ?? '' } }), 'Yanıt yayınlandı.')}>Yanıtla ve yayınla</Button>
                </div>
              )}
            </div>
          ))}
          {a.feedback}
        </div>
      </section>
    </div>
  );
}

interface CompareRes {
  currency: string; lines: PLine[]; criteria: Crit[]; basisHash: string;
  bids: { bidId: string; supplierId: string; supplierName: string; versionNo: number; submittedAt: string; attachments: { id: string; title: string; filename: string; sizeBytes: number }[] }[];
  scores: { bidId: string; criterionCode: string; score: string; evidence: string; scoredBy: string; scoredAt: string }[];
  comparison: { lowestTco: string | null; criteriaError: string | null; fx: { currency: string; rate: string; source: string; asOf: string }[];
    bids: { bidId: string; supplierId: string; supplierName: string; supplierStatus: string; complete: boolean; missingLines: string[]; tco: string | null; costsTotal: string | null;
      priceScore: string | null; weightedScore: string | null; rank: number | null; scoreGaps: string[]; lotTotals: Record<string, string | null>;
      lines: { projectLineId: string; state: string; reason: string; unitPrice: string | null; total: string | null; original: { unit: string; quantity: string; unitPrice: string; currency: string } | null }[] }[] };
}

function ComparisonTab({ d, reload }: { d: Detail; reload: () => Promise<void> }) {
  const r = useResource<CompareRes>(['EVALUATION', 'AWARD_APPROVAL', 'CONTRACTING'].includes(d.project.status) ? `/api/v1/projects/${d.project.id}/comparison` : null);
  const reloadAll = async () => { await reload(); await r.reload(); };
  const a = useAction(reloadAll);
  const [onlyGaps, setOnlyGaps] = useState(false);
  const [score, setScore] = useState<{ bidId: string; code: string; value: string; evidence: string } | null>(null);
  const [fx, setFx] = useState({ currency: '', rate: '', source: 'TCMB döviz satış', asOf: '' });
  if (!['EVALUATION', 'AWARD_APPROVAL', 'CONTRACTING'].includes(d.project.status)) {
    return <div className="rounded-md border border-border bg-surface"><Empty icon="lock" title="Karşılaştırma tur kapandıktan sonra açılır">Teklifler kapanışa kadar mühürlüdür; erken görüntüleme sunucuda engellenir.</Empty></div>;
  }
  if (r.loading && !r.data) return <Loading rows={6} />;
  if (r.error) return <ErrorState error={r.error} onRetry={r.reload} />;
  const c = r.data!;
  const bids = c.comparison.bids;
  const scoreCriteria = c.criteria.filter((x) => x.kind === 'SCORE');
  const scoreOf = (bidId: string, code: string) => c.scores.find((s) => s.bidId === bidId && s.criterionCode === code);
  const visibleLines = c.lines.filter((l) => !onlyGaps || bids.some((b) => b.lines.find((x) => x.projectLineId === l.id)?.state !== 'COMPARABLE'));
  const otherCurrencies = [...new Set(bids.flatMap((b) => b.lines.map((l) => l.original?.currency).filter((x): x is string => !!x && x !== c.currency)))];
  return (
    <div className="grid gap-5">
      <p className="text-ink-muted">Önce kapsam ve uygunluk, sonra ticari sonuç. Karşılaştırılamayan kalemi olan teklif toplam sıralamaya girmez; fiyat dışı farklar görünür kalır. Hesaplama deterministiktir, model kullanılmaz.</p>
      <div className="flex flex-wrap items-center gap-3">
        <label className="flex items-center gap-2 font-semibold"><input type="checkbox" className="accent-[var(--ink)]" checked={onlyGaps} onChange={(e) => setOnlyGaps(e.target.checked)} />Yalnız kapsam farkı olan kalemler</label>
        {c.comparison.fx.length > 0 && <span className="text-sm text-ink-muted">Kur varsayımı: {c.comparison.fx.map((f) => `1 ${f.currency} = ${f.rate} ${c.currency} (${f.source}, ${fmtDate(f.asOf)})`).join(' · ')}</span>}
      </div>
      <div className="relative w-full overflow-auto rounded-md border border-border bg-surface">
        <table className="w-full border-separate border-spacing-0 text-base">
          <caption className="sr-only">Kalem bazında normalleştirilmiş teklif karşılaştırması ({c.currency})</caption>
          <thead>
            <tr>
              <th scope="col" className="sticky left-0 top-0 z-20 min-w-[240px] border-b border-r border-border bg-sunken px-3 py-2 text-left text-xs font-semibold text-ink-muted">Kalem</th>
              {bids.map((b) => (
                <th key={b.bidId} scope="col" className="sticky top-0 z-10 min-w-[200px] border-b border-border bg-sunken px-3 py-2 text-left align-top">
                  <span className="block font-semibold text-ink">{b.supplierName}</span>
                  <span className="text-xs font-normal text-ink-subtle">Sürüm {c.bids.find((x) => x.bidId === b.bidId)?.versionNo} · {fmtDateTime(c.bids.find((x) => x.bidId === b.bidId)?.submittedAt)}</span>
                  {b.supplierStatus !== 'ACTIVE' && <span className="mt-1 block"><Tag label={{ text: 'Aday firma', tone: 'warn', icon: 'clock' }} /></span>}
                  {(c.bids.find((x) => x.bidId === b.bidId)?.attachments ?? []).map((f) => (
                    <button key={f.id} type="button" onClick={() => void saveBlob(`/api/v1/bid-files/${f.id}/content`, f.filename)}
                      className="mt-1 flex max-w-full items-center gap-1 text-left text-xs font-semibold text-ink underline decoration-[var(--rule-strong)] underline-offset-2"><Icon name="file" size={12} className="shrink-0" /><span className="truncate">{f.title}</span></button>
                  ))}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {visibleLines.map((l) => (
              <tr key={l.id}>
                <th scope="row" className="sticky left-0 z-10 border-b border-r border-border bg-surface px-3 py-2.5 text-left align-top font-normal">
                  <span className="block font-semibold">{l.description}</span><span className="tabular text-sm text-ink-subtle">{l.lot} · {Number(l.quantity).toLocaleString('tr-TR')} {l.unit}</span>
                </th>
                {bids.map((b) => {
                  const x = b.lines.find((y) => y.projectLineId === l.id)!;
                  return (
                    <td key={b.bidId} className={cn('border-b border-border px-3 py-2.5 align-top tabular-nums', x.state !== 'COMPARABLE' && 'bg-[repeating-linear-gradient(135deg,transparent_0_6px,rgba(168,55,42,.06)_6px_12px)]')}>
                      {x.state === 'COMPARABLE' ? <>
                        <span className="block font-semibold">{fmtMoney(x.total, c.currency)}</span>
                        <span className="text-sm text-ink-subtle">{fmtMoney(x.unitPrice, c.currency)} / {l.unit}{x.original && x.original.unit.toLocaleLowerCase('tr-TR') !== l.unit.toLocaleLowerCase('tr-TR') ? ` · teklif: ${x.original.quantity} ${x.original.unit}` : ''}</span>
                      </> : <>
                        <Tag label={lineState[x.state]} title={x.reason} />
                        <span className="mt-1 block text-sm text-ink-muted">{x.reason}{x.original ? ` · teklif: ${x.original.quantity} ${x.original.unit} × ${fmtMoney(x.original.unitPrice, x.original.currency)}` : ''}</span>
                      </>}
                    </td>
                  );
                })}
              </tr>
            ))}
            <SummaryRow label="Ek maliyetler" bids={bids} render={(b) => b.costsTotal ? fmtMoney(b.costsTotal, c.currency) : '—'} />
            <SummaryRow label="TCO (toplam sahip olma maliyeti)" strong bids={bids} render={(b) => b.tco ? fmtMoney(b.tco, c.currency) : <span className="text-danger">Karşılaştırılamıyor · {b.missingLines.length} kalem</span>} />
            <SummaryRow label="Fiyat puanı" bids={bids} render={(b) => b.priceScore ?? '—'} />
            {scoreCriteria.map((cr) => (
              <SummaryRow key={cr.code} label={`${cr.name} (%${Number(cr.weight).toLocaleString('tr-TR')})`} bids={bids} render={(b) => {
                const s = scoreOf(b.bidId, cr.code);
                return (
                  <span className="flex flex-wrap items-center gap-2">
                    {s ? <span title={`${s.evidence} — ${s.scoredBy}, ${fmtDateTime(s.scoredAt)}`}>{s.score} <Tag label={{ text: 'İnsan puanı', tone: 'human', icon: 'stamp' }} /></span> : <span className="text-ink-subtle">Puan yok</span>}
                    {d.can.score && b.complete && d.project.status === 'EVALUATION' && <Button size="xs" variant="outline" onClick={() => setScore({ bidId: b.bidId, code: cr.code, value: s?.score ?? '', evidence: '' })}>Puanla</Button>}
                  </span>
                );
              }} />
            ))}
            <SummaryRow label="Ağırlıklı puan" strong bids={bids} render={(b) => b.weightedScore ? <>{b.weightedScore}{b.rank && <span className="ml-2 text-sm text-ink-subtle">#{b.rank}</span>}</> : <span className="text-ink-subtle">{b.scoreGaps.length ? 'Eksik puan' : '—'}</span>} />
          </tbody>
        </table>
      </div>
      {c.comparison.criteriaError && <Banner tone="warn" title={c.comparison.criteriaError} />}
      {score && (
        <form className="panel" onSubmit={(e) => { e.preventDefault(); void a.run(() => api(`/api/v1/bids/${score.bidId}/scores`, { method: 'POST', json: { criterionCode: score.code, score: score.value.replace(',', '.'), evidence: score.evidence } }), 'Puan kaydedildi.').then(() => setScore(null)); }}>
          <div className="panel-head"><h2>Puan: {bids.find((b) => b.bidId === score.bidId)?.supplierName} · {c.criteria.find((x) => x.code === score.code)?.name}</h2></div>
          <div className="panel-body grid grid-cols-[120px_minmax(0,1fr)] gap-x-4 max-[640px]:grid-cols-1">
            <Field label="Puan (0–100)">{(p) => <input className="input tabular text-right" inputMode="decimal" {...p} value={score.value} onChange={(e) => setScore({ ...score, value: e.target.value })} />}</Field>
            <Field label="Kanıt" hint="Hangi belge, sayfa veya gözleme dayandığını yazın. Kanıtsız puan kaydedilmez.">{(p) => <textarea className="input" rows={2} {...p} value={score.evidence} onChange={(e) => setScore({ ...score, evidence: e.target.value })} />}</Field>
            <div className="col-span-full flex gap-2"><Button type="submit" disabled={a.busy}>Puanı kaydet</Button><Button type="button" variant="outline" onClick={() => setScore(null)}>Vazgeç</Button></div>
          </div>
        </form>
      )}
      {d.can.evaluate && otherCurrencies.length > 0 && (
        <form className="panel" onSubmit={(e) => { e.preventDefault(); void a.run(() => api(`/api/v1/projects/${d.project.id}/fx-rates`, { method: 'POST', json: { ...fx, rate: fx.rate.replace(',', '.') } }), 'Kur varsayımı kaydedildi.'); }}>
          <div className="panel-head"><h2>Kur varsayımı</h2><span className="text-sm text-ink-subtle">Teklif para birimleri: {otherCurrencies.join(', ')}</span></div>
          <div className="panel-body grid grid-cols-4 gap-x-4 max-[900px]:grid-cols-2">
            <Field label="Para birimi">{(p) => <input className="input" maxLength={3} {...p} value={fx.currency} onChange={(e) => setFx({ ...fx, currency: e.target.value.toUpperCase() })} />}</Field>
            <Field label={`1 birim = ? ${c.currency}`}>{(p) => <input className="input tabular text-right" inputMode="decimal" {...p} value={fx.rate} onChange={(e) => setFx({ ...fx, rate: e.target.value })} />}</Field>
            <Field label="Kaynak">{(p) => <input className="input" {...p} value={fx.source} onChange={(e) => setFx({ ...fx, source: e.target.value })} />}</Field>
            <Field label="Kur tarihi">{(p) => <input className="input" type="date" {...p} value={fx.asOf} onChange={(e) => setFx({ ...fx, asOf: e.target.value })} />}</Field>
            <Button type="submit" className="justify-self-start" disabled={a.busy}>Kuru kaydet</Button>
          </div>
        </form>
      )}
      {d.can.evaluate && d.project.status === 'EVALUATION' && (
        <div className="flex flex-wrap items-center gap-3">
          <Button disabled={a.busy} onClick={() => void a.run(() => api(`/api/v1/projects/${d.project.id}/evaluations`, { method: 'POST' }), 'Değerlendirme sürümü oluşturuldu. Karar sekmesinden tahsis önerin.')}>Değerlendirme sürümü oluştur</Button>
          <span className="text-sm text-ink-muted">Sürüm; teklifleri, ağırlıkları, puanları ve kurları dondurur. Biri değişirse sürüm eskir.</span>
        </div>
      )}
      {a.feedback}
    </div>
  );
}

function SummaryRow({ label, bids, render, strong }: { label: string; bids: CompareRes['comparison']['bids']; render: (b: CompareRes['comparison']['bids'][number]) => React.ReactNode; strong?: boolean }) {
  return (
    <tr className={cn(strong && 'bg-[#f3f0e7]')}>
      <th scope="row" className={cn('sticky left-0 z-10 border-b border-r border-border px-3 py-2.5 text-left font-semibold', strong ? 'bg-[#f3f0e7]' : 'bg-surface')}>{label}</th>
      {bids.map((b) => <td key={b.bidId} className={cn('border-b border-border px-3 py-2.5 tabular-nums', strong && 'font-semibold')}>{render(b)}</td>)}
    </tr>
  );
}

function Decision({ d, reload }: { d: Detail; reload: () => Promise<void> }) {
  const a = useAction(reload);
  const current = d.evaluations.find((e) => e.current);
  const ev = useResource<{ snapshot: { comparison: CompareRes['comparison']; lines: PLine[] } }>(current ? `/api/v1/evaluations/${current.id}` : null);
  const [alloc, setAlloc] = useState<Record<string, string>>({});
  const [rationale, setRationale] = useState('');
  const [note, setNote] = useState('');
  const key = (lineId: string, supplierId: string) => `${lineId}|${supplierId}`;
  const snap = ev.data?.snapshot;
  const total = useMemo(() => {
    if (!snap) return 0;
    let t = 0;
    for (const [k, q] of Object.entries(alloc)) {
      const [lineId, sid] = k.split('|');
      const up = snap.comparison.bids.find((b) => b.supplierId === sid)?.lines.find((l) => l.projectLineId === lineId)?.unitPrice;
      if (up && Number(q) > 0) t += Number(up) * Number(q);
    }
    return t;
  }, [alloc, snap]);
  const download = (id: string, v: number) => saveBlob(`/api/v1/evaluations/${id}/report.xlsx`, `${d.project.code}-degerlendirme-v${v}.xlsx`);
  const downloadPdf = (id: string, v: number) => saveBlob(`/api/v1/evaluations/${id}/decision.pdf`, `${d.project.code}-karar-ozeti-v${v}.pdf`);
  const open = d.awards.find((x) => x.status === 'PROPOSED');
  const approved = d.awards.find((x) => x.status === 'APPROVED');
  const lineName = (id: string) => d.lines.find((l) => l.id === id)?.description ?? id;
  return (
    <div className="grid gap-6">
      <section className="panel">
        <div className="panel-head"><h2>Değerlendirme sürümleri</h2></div>
        <div className="panel-body">
          {!d.evaluations.length ? <p className="text-ink-muted">Henüz değerlendirme sürümü yok. Karşılaştırma sekmesinden oluşturulur.</p> : (
            <ul className="grid gap-2">{d.evaluations.map((e) => (
              <li key={e.id} className="flex flex-wrap items-center gap-3">
                <span className="tabular font-semibold">Sürüm {e.versionNo}</span>
                {e.current ? <Tag label={{ text: 'Güncel dayanak', tone: 'ok', icon: 'check' }} /> : <Tag label={{ text: 'Eskidi: teklif, ağırlık, puan veya kur değişti', tone: 'warn', icon: 'alert' }} />}
                <span className="text-sm text-ink-subtle">{e.createdBy} · {fmtDateTime(e.createdAt)}</span>
                <Button size="sm" variant="outline" onClick={() => void download(e.id, e.versionNo)}><Icon name="file" />XLSX rapor</Button>
                <Button size="sm" variant="outline" onClick={() => void downloadPdf(e.id, e.versionNo)}><Icon name="file" />PDF karar özeti</Button>
              </li>
            ))}</ul>
          )}
        </div>
      </section>
      {approved && <AwardView aw={approved} lineName={lineName} currency={d.project.currency} />}
      {open && (
        <section className="panel">
          <div className="panel-head"><h2>Onay bekleyen tahsis · öneri {open.versionNo}</h2>{!open.evaluationCurrent && <Tag label={{ text: 'Dayanak eskidi', tone: 'warn', icon: 'alert' }} />}</div>
          <div className="panel-body grid gap-3">
            <AwardLines aw={open} lineName={lineName} currency={d.project.currency} />
            <p><span className="font-semibold">Gerekçe:</span> {open.rationale}</p>
            <p className="text-sm text-ink-subtle">Öneren: {open.proposedBy} · {fmtDateTime(open.proposedAt)}</p>
            {d.can.decide && !open.proposedByMe ? (
              <div className="grid gap-2 border-t border-border pt-3">
                <Field label="Karar notu (geri göndermede zorunlu)">{(p) => <textarea className="input" rows={2} {...p} value={note} onChange={(e) => setNote(e.target.value)} />}</Field>
                <div className="flex flex-wrap gap-2">
                  <Button disabled={a.busy} onClick={() => void a.run(() => api(`/api/v1/awards/${open.id}/decision`, { method: 'POST', json: { approve: true, note } }), 'Tahsis onaylandı.')}><Icon name="stamp" />Tahsisi onayla</Button>
                  <Button variant="outline" disabled={a.busy} onClick={() => void a.run(() => api(`/api/v1/awards/${open.id}/decision`, { method: 'POST', json: { approve: false, note } }), 'Öneri geri gönderildi.')}>Geri gönder</Button>
                </div>
              </div>
            ) : open.proposedByMe ? <Banner tone="neutral" icon="lock" title="Bu öneriyi siz yaptınız">Görev ayrılığı gereği onayı başka bir satınalma yöneticisi verir.</Banner> : null}
          </div>
        </section>
      )}
      {d.can.propose && d.project.status === 'EVALUATION' && (
        current && snap ? (
          <form className="panel" onSubmit={(e) => { e.preventDefault(); void a.run(() => api(`/api/v1/projects/${d.project.id}/awards`, { method: 'POST', json: {
            evaluationId: current.id, rationale, allocations: Object.entries(alloc).filter(([, q]) => Number(q) > 0).map(([k, quantity]) => { const [projectLineId, supplierId] = k.split('|'); return { projectLineId, supplierId, quantity: quantity.replace(',', '.') }; }) } }), 'Tahsis önerildi; onay görevi açıldı.'); }}>
            <div className="panel-head"><h2>Kazanan tahsisi öner · değerlendirme {current.versionNo}</h2></div>
            <div className="panel-body grid gap-4">
              <p className="text-ink-muted">Satır veya lot birden çok tedarikçiye bölünebilir. Satır toplamı ihtiyacı aşamaz; yalnız karşılaştırılabilir teklif verilen satıra tahsis yapılır. Aday firma kesin kazanan olamaz.</p>
              <div className="overflow-auto rounded-md border border-border">
                <table className="w-full border-separate border-spacing-0">
                  <thead><tr><th className="border-b border-border bg-sunken px-3 py-2 text-left text-xs font-semibold text-ink-muted">Kalem</th>
                    {snap.comparison.bids.map((b) => <th key={b.supplierId} className="border-b border-border bg-sunken px-3 py-2 text-left text-xs font-semibold text-ink-muted">{b.supplierName}</th>)}
                    <th className="border-b border-border bg-sunken px-3 py-2 text-right text-xs font-semibold text-ink-muted">Tahsis / ihtiyaç</th></tr></thead>
                  <tbody>{snap.lines.map((l) => {
                    const sum = snap.comparison.bids.reduce((s, b) => s + (Number(alloc[key(l.id, b.supplierId)]) || 0), 0);
                    return (
                      <tr key={l.id}>
                        <th scope="row" className="border-b border-border px-3 py-2 text-left font-semibold">{l.description}<span className="block text-sm font-normal text-ink-subtle">{l.unit}</span></th>
                        {snap.comparison.bids.map((b) => {
                          const lr = b.lines.find((x) => x.projectLineId === l.id)!;
                          return <td key={b.supplierId} className="border-b border-border px-3 py-2">
                            {lr.state === 'COMPARABLE' ? <label className="grid gap-1"><span className="sr-only">{l.description} · {b.supplierName} miktarı</span>
                              <input className="input tabular w-28 text-right" inputMode="decimal" value={alloc[key(l.id, b.supplierId)] ?? ''} onChange={(e) => setAlloc((x) => ({ ...x, [key(l.id, b.supplierId)]: e.target.value }))} />
                              <span className="tabular text-xs text-ink-subtle">{fmtMoney(lr.unitPrice, d.project.currency)} / {l.unit}</span></label>
                              : <span className="text-sm text-ink-subtle">{lineState[lr.state]?.text}</span>}
                          </td>;
                        })}
                        <td className={cn('border-b border-border px-3 py-2 text-right tabular-nums', sum > Number(l.quantity) ? 'font-semibold text-danger' : sum === Number(l.quantity) ? 'text-verified' : '')}>{sum.toLocaleString('tr-TR')} / {Number(l.quantity).toLocaleString('tr-TR')}</td>
                      </tr>
                    );
                  })}</tbody>
                </table>
              </div>
              <p className="tabular text-md">Tahsis toplamı: <span className="font-semibold">{fmtMoney(total.toFixed(2), d.project.currency)}</span> <span className="text-sm text-ink-subtle">(önizleme; kesin tutar sunucuda ondalık hesaplanır)</span></p>
              <Field label="Seçim gerekçesi" hint="En ucuzdan farklı seçim veya bölme varsa nedeni yazın.">{(p) => <textarea className="input" rows={3} {...p} value={rationale} onChange={(e) => setRationale(e.target.value)} />}</Field>
              <Button type="submit" className="justify-self-start" disabled={a.busy}>Tahsisi öner</Button>
            </div>
          </form>
        ) : !current && d.evaluations.length ? <Banner tone="warn" title="Güncel değerlendirme sürümü yok">Son sürümden sonra dayanak değişti. Karşılaştırma sekmesinden yeni sürüm oluşturun.</Banner> : null
      )}
      {a.feedback}
    </div>
  );
}

function AwardLines({ aw, lineName, currency }: { aw: Detail['awards'][number]; lineName: (id: string) => string; currency: string }) {
  return (
    <Table>
      <TableHeader><TableRow className="hover:bg-transparent"><TableHead>Kalem</TableHead><TableHead>Tedarikçi</TableHead><TableHead className="text-right">Miktar</TableHead><TableHead className="text-right">Birim fiyat</TableHead><TableHead className="text-right">Tutar</TableHead></TableRow></TableHeader>
      <TableBody>
        {aw.lines.map((l, i) => <TableRow key={i}><TableCell>{lineName(l.projectLineId)}</TableCell><TableCell>{l.supplierName}</TableCell>
          <TableCell className="text-right">{Number(l.quantity).toLocaleString('tr-TR')}</TableCell><TableCell className="text-right">{fmtMoney(l.unitPrice, currency)}</TableCell><TableCell className="text-right">{fmtMoney(l.amount, currency)}</TableCell></TableRow>)}
        <TableRow className="hover:bg-transparent"><TableCell colSpan={4} className="text-right font-semibold">Toplam</TableCell><TableCell className="text-right font-semibold">{fmtMoney(aw.total, currency)}</TableCell></TableRow>
      </TableBody>
    </Table>
  );
}

function AwardView({ aw, lineName, currency }: { aw: Detail['awards'][number]; lineName: (id: string) => string; currency: string }) {
  return (
    <section className="panel">
      <div className="panel-head"><h2>Onaylanan tahsis</h2><Tag label={{ text: `Kurul kararı · ${aw.decidedBy}`, tone: 'human', icon: 'stamp' }} /></div>
      <div className="panel-body grid gap-3">
        <AwardLines aw={aw} lineName={lineName} currency={currency} />
        <p><span className="font-semibold">Gerekçe:</span> {aw.rationale}</p>
        <p className="text-sm text-ink-subtle">Öneren {aw.proposedBy} · onaylayan {aw.decidedBy} · {fmtDateTime(aw.decidedAt)}{aw.decisionNote ? ` · ${aw.decisionNote}` : ''}</p>
      </div>
    </section>
  );
}

async function saveBlob(path: string, name: string) {
  const blob = await apiBlob(path);
  const url = URL.createObjectURL(blob);
  const el = document.createElement('a'); el.href = url; el.download = name; el.click(); URL.revokeObjectURL(url);
}
