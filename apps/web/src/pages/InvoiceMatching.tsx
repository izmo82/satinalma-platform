import { useState } from 'react';
import { Link } from 'react-router-dom';
import { api, ApiError } from '../lib/api.ts';
import { useResource } from '../lib/useApi.ts';
import { fmtDate, fmtDateTime, fmtMoney } from '../lib/format.ts';
import type { Label } from '../lib/labels.ts';
import { Banner, Drawer, Empty, ErrorState, Field, Loading, Modal, Tag } from '../ui/kit.tsx';
import { Icon } from '../ui/icons.tsx';
import { Button } from '@/components/ui/button';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { cn } from '@/lib/utils';

// v2 Faz 7 (D112, R1–R4, Figma 17): fatura ↔ sözleşme eşleşmesi. Eşleşme durumu sunucuda türetilir (saklı bağ > tahsis); eski tahsis
// kontrolü (bulgulardan) ikincil satır olarak görünür kalır. Elle bağlama çekmecesi, bağ kaldırma ve sözleşme kullanımı burada.

export type MatchState = 'MATCHED' | 'ALLOCATED' | 'MIXED' | 'UNMATCHED';
export const MATCH_STATE_TAG: Record<MatchState, Omit<Label, 'text'>> = {
  MATCHED: { tone: 'ok', icon: 'check' }, ALLOCATED: { tone: 'info', icon: 'check' }, MIXED: { tone: 'info', icon: 'help' }, UNMATCHED: { tone: 'warn', icon: 'alert' },
};
const MATCH_STATE_FALLBACK: Record<MatchState, string> = { MATCHED: 'Eşleşti', ALLOCATED: 'Tahsisle (eski kayıt)', MIXED: 'Birden çok sözleşmeye tahsisli', UNMATCHED: 'Eşleşmedi' };
export const matchStateTag = (state: MatchState, label?: string | null): Label => ({ text: label || MATCH_STATE_FALLBACK[state], ...MATCH_STATE_TAG[state] });

export interface UsageView { amount: string | null; currency: string; basis: 'NET' | 'GROSS'; used: string; ratio: string | null; level: 'OK' | 'NEAR' | 'OVER' | 'NO_AMOUNT';
  levelLabel: string; overBy: string | null; warning: string | null; foreignCurrency: { currency: string; total: string; label: string }[] }

export interface MatchView { state: MatchState; stateLabel: string; method: string | null; methodLabel: string | null; note: string | null; matchedAt: string | null; matchedBy: string | null;
  autoMatch: boolean; contract: { id: string; code: string; title: string } | null; project: { id: string; code: string; title: string } | null;
  erpContractRef: string | null; erpOrderRef: string | null; lastAutoFailure: { reason: string; reasonLabel: string; at: string } | null; usage: UsageView | null }

/** Sözleşme kullanımı çubuğu (R4): oran ≥ %90 "Sınıra yakın", aşımda tutar; engel değildir. Başka para birimindeki faturalar ayrı satır. */
export function UsageBar({ u, label = 'Sözleşme tutarı kullanımı' }: { u: UsageView; label?: string }) {
  const pct = u.ratio !== null ? Number(u.ratio) * 100 : 0;
  const width = Math.max(0, Math.min(100, pct));
  return (
    <div className="grid gap-1.5">
      <div className="flex flex-wrap justify-between gap-2">
        <span className="tabular font-semibold">{fmtMoney(u.used, u.currency)}</span>
        <span className="tabular text-ink-muted">{u.amount ? `sözleşme tutarı ${fmtMoney(u.amount, u.currency)} (${u.basis === 'GROSS' ? 'KDV dahil' : 'KDV hariç'})` : u.levelLabel}</span>
      </div>
      {u.amount && <div className="h-2 overflow-hidden rounded-full bg-sunken" role="meter" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(width)} aria-label={label}>
        <div className={cn('h-full', u.level === 'OVER' ? 'bg-danger' : u.level === 'NEAR' ? 'bg-warn' : 'bg-ink')} style={{ width: `${width}%` }} /></div>}
      <p className="tabular text-sm text-ink-muted">{u.ratio !== null && <>%{pct.toLocaleString('tr-TR', { maximumFractionDigits: 1 })} kullanıldı · </>}{u.levelLabel}</p>
      {u.warning && <p className={cn('text-sm font-semibold', u.level === 'OVER' ? 'text-danger' : 'text-warn')}><Icon name="alert" size={14} className="mr-1 inline" />{u.warning} <span className="font-normal text-ink-muted">(bilgi; ödemeyi engellemez)</span></p>}
      {u.foreignCurrency.map((f) => <p key={f.currency} className="text-sm text-ink-muted">{f.label || `${fmtMoney(f.total, f.currency)} kur çevrilmedi`}</p>)}
    </div>
  );
}

// --- Elle bağlama çekmecesi (R3) ----------------------------------------------------------------------------------------------

interface Candidate { familyId: string; code: string; title: string; contractNo: string | null; status: string | null; statusLabel: string | null; active: boolean;
  startDate: string | null; endDate: string | null; indefinite: boolean; inRange: boolean; project: { id: string; code: string; title: string } | null;
  usage: UsageView | null; canLink: boolean; cannotLinkReason?: string | null }
interface Candidates { invoice: { id: string; invoiceNo: string; issueDate: string; state: string | null }; items: Candidate[]; blocked: null | 'invoice_decided' | 'invoice_allocated' | 'invoice_already_matched' }
const BLOCKED_TR = {
  invoice_decided: 'Bu faturada eski (v1) onay ya da ret kararı var; sözleşmeye elle bağlanamaz.',
  invoice_allocated: 'Fatura satırları sözleşmeye tahsis edilmiş; eşleşme tahsisten türer. Elle bağlamak için önce tahsisi kaldırın.',
  invoice_already_matched: 'Fatura zaten bir sözleşmeye bağlı. Başka sözleşmeye bağlamak için önce bağı gerekçeyle kaldırın.',
} as const;

export function MatchDrawer({ invoiceId, invoiceNo, onClose, onDone }: { invoiceId: string; invoiceNo: string; onClose: () => void; onDone: (msg: string) => void }) {
  const r = useResource<Candidates>(`/api/v1/invoices/${invoiceId}/match-candidates`);
  const [pick, setPick] = useState('');
  const [ack, setAck] = useState(false);
  const [note, setNote] = useState('');
  const [err, setErr] = useState<ApiError | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirmRange, setConfirmRange] = useState<{ start: string | null; end: string | null; issueDate: string | null } | null>(null);
  const chosen = r.data?.items.find((c) => c.familyId === pick);
  const needAck = !!chosen && !chosen.inRange;
  const send = async (acknowledge: boolean) => {
    if (!chosen) return;
    setBusy(true); setErr(null);
    try {
      await api(`/api/v1/invoices/${invoiceId}/match`, { method: 'POST', json: { familyId: chosen.familyId, acknowledgeOutOfRange: acknowledge || undefined, note: note.trim() || null } });
      onDone(`${invoiceNo} faturası ${chosen.code} sözleşmesine bağlandı.`);
    } catch (e) {
      const x = e as ApiError;
      // Sunucu tarih dışı bağlamada onay ister: onay penceresi açılır, onaylanınca aynı istek onayla yinelenir.
      if (x.code === 'out_of_range_ack_required') setConfirmRange({ start: x.details?.start ?? chosen.startDate, end: x.details?.end ?? chosen.endDate, issueDate: x.details?.issueDate ?? r.data?.invoice.issueDate ?? null });
      else setErr(x);
    } finally { setBusy(false); }
  };
  return (
    <Drawer title={`Elle bağla · ${invoiceNo}`} onClose={onClose} footer={<>
      <Button variant="ghost" onClick={onClose}>Vazgeç</Button>
      <Button disabled={busy || !chosen || !chosen.canLink || !!r.data?.blocked || (needAck && !ack)} onClick={() => void send(needAck && ack)}>Sözleşmeye bağla</Button>
    </>}>
      {r.loading && !r.data ? <Loading rows={4} /> : r.error ? <ErrorState error={r.error} onRetry={r.reload} /> : r.data && <div className="grid gap-3">
        <p className="text-sm text-ink-muted">Fatura tarihi {fmtDate(r.data.invoice.issueDate)}. Yalnız aynı tedarikçinin ve şirketin sözleşmeleri listelenir; yürürlükte ve tarihi uyan sözleşmeler üsttedir.</p>
        {r.data.blocked && <Banner tone="warn" title={BLOCKED_TR[r.data.blocked]} />}
        {!r.data.items.length ? <Empty icon="file" title="Uygun sözleşme yok">Bu tedarikçiyle bu şirkette sözleşme bulunamadı. Sözleşme eklendikten sonra “Kuyruğu yeniden dene” ya da elle bağlama kullanılabilir.</Empty> : (
          <fieldset className="grid gap-2">
            <legend className="mb-1 font-semibold">Aday sözleşmeler</legend>
            {r.data.items.map((c) => (
              <label key={c.familyId} className={cn('grid grid-cols-[auto_minmax(0,1fr)] gap-x-2 rounded-md border p-2.5', pick === c.familyId ? 'border-ink' : 'border-border', !c.canLink && 'opacity-75')}>
                <input type="radio" name="aday" className="mt-1 accent-[var(--ink)]" disabled={!c.canLink || !!r.data!.blocked} checked={pick === c.familyId}
                  onChange={() => { setPick(c.familyId); setAck(false); }} aria-describedby={`aday-${c.familyId}`} />
                <span className="min-w-0">
                  <span className="block font-semibold">{c.code} · {c.title}</span>
                  <span id={`aday-${c.familyId}`} className="block text-sm text-ink-muted">
                    {[c.statusLabel, c.indefinite ? `${fmtDate(c.startDate)} – süresiz` : `${fmtDate(c.startDate)} – ${fmtDate(c.endDate)}`, c.project ? `Proje ${c.project.code}` : null].filter(Boolean).join(' · ')}
                    {!c.inRange && <span className="block text-warn">Fatura tarihi sözleşme süresinin dışında.</span>}
                    {!c.active && <span className="block text-warn">Sözleşme yürürlükte değil.</span>}
                    {!c.canLink && c.cannotLinkReason && <span className="block text-danger">{c.cannotLinkReason}</span>}
                  </span>
                  {c.usage && <span className="mt-1.5 block"><UsageBar u={c.usage} label={`${c.code} kullanımı`} /></span>}
                </span>
              </label>
            ))}
          </fieldset>
        )}
        {needAck && <label className="flex items-start gap-2 rounded-md bg-warn-soft p-2.5 text-sm"><input type="checkbox" className="mt-0.5" checked={ack} onChange={(e) => setAck(e.target.checked)} />
          <span>Fatura tarihi ({fmtDate(r.data.invoice.issueDate)}) sözleşme süresi dışında; yine de bu sözleşmeye bağlamayı onaylıyorum.</span></label>}
        <Field label="Not (isteğe bağlı)" hint="Bağlama nedenini yazabilirsiniz; denetim kaydına girer.">{(p) => <textarea className="input" rows={2} maxLength={2000} {...p} value={note} onChange={(e) => setNote(e.target.value)} />}</Field>
        {err && <Banner tone={err.status === 409 || err.status === 422 ? 'warn' : 'danger'} title={err.message} />}
      </div>}
      {confirmRange && <Modal title="Tarih aralığı dışında" onClose={() => setConfirmRange(null)} footer={<>
        <Button variant="ghost" onClick={() => setConfirmRange(null)}>Vazgeç</Button>
        <Button onClick={() => { setConfirmRange(null); setAck(true); void send(true); }}>Onayla ve bağla</Button></>}>
        <p>Fatura tarihi {fmtDate(confirmRange.issueDate)}, sözleşme süresi {fmtDate(confirmRange.start)} – {confirmRange.end ? fmtDate(confirmRange.end) : 'süresiz'}. Yine de bağlansın mı?</p>
      </Modal>}
    </Drawer>
  );
}

// --- Fatura detayı: Eşleşme kartı ---------------------------------------------------------------------------------------------

export function MatchCard({ invoiceId, invoiceNo, m, canMatch, onChanged }: { invoiceId: string; invoiceNo: string; m: MatchView; canMatch: boolean; onChanged: () => Promise<void> | void }) {
  const [drawer, setDrawer] = useState(false);
  const [unlink, setUnlink] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const doUnlink = async () => {
    setBusy(true); setErr(null); setDone(null);
    try { await api(`/api/v1/invoices/${invoiceId}/match`, { method: 'DELETE', json: { reason: unlink!.trim() } }); setUnlink(null); setDone('Eşleşme kaldırıldı; fatura eşleştirme kuyruğuna döndü.'); await onChanged(); }
    catch (e) { setErr((e as ApiError).message); } finally { setBusy(false); }
  };
  return (
    <section className="panel" aria-labelledby="match-h">
      <div className="panel-head"><h2 id="match-h" className="flex-1">Eşleşme</h2><Tag label={matchStateTag(m.state, m.stateLabel)} /></div>
      <div className="panel-body grid gap-3">
        <dl className="facts">
          <dt>Sözleşme</dt><dd>{m.contract ? <Link to={`/sozlesmeler/aile/${m.contract.id}?sekme=ozet`}>{m.contract.code} · {m.contract.title}</Link> : '—'}</dd>
          <dt>Proje</dt><dd>{m.project ? <Link to={`/projeler/${m.project.id}?sekme=faturalar`}>{m.project.code} · {m.project.title}</Link> : '—'}</dd>
          {m.state === 'MATCHED' && <><dt>Yöntem</dt><dd>{m.methodLabel ?? '—'}</dd>
            <dt>Bağlayan</dt><dd>{m.matchedBy ?? 'Sistem (otomatik)'}{m.matchedAt ? ` · ${fmtDateTime(m.matchedAt)}` : ''}</dd></>}
          {m.note && <><dt>Not</dt><dd>{m.note}</dd></>}
          {(m.erpContractRef || m.erpOrderRef) && <><dt>ERP referansı</dt><dd className="mono">{[m.erpContractRef && `Sözleşme ${m.erpContractRef}`, m.erpOrderRef && `Sipariş ${m.erpOrderRef}`].filter(Boolean).join(' · ')}</dd></>}
        </dl>
        {m.state === 'UNMATCHED' && m.lastAutoFailure && <p className="text-sm text-ink-muted"><span className="font-semibold text-ink">Otomatik eşleşmedi:</span> {m.lastAutoFailure.reasonLabel} <span className="text-ink-subtle">· {fmtDateTime(m.lastAutoFailure.at)}</span></p>}
        {m.state === 'UNMATCHED' && !m.autoMatch && <p className="text-sm text-ink-subtle">Bu fatura otomatik eşleştirme öncesinde kaydedildi; yalnız elle bağlanır.</p>}
        {m.usage && <UsageBar u={m.usage} />}
        {canMatch && m.state === 'UNMATCHED' && <Button className="justify-self-start" onClick={() => setDrawer(true)}><Icon name="arrow" />Elle bağla</Button>}
        {canMatch && m.state === 'MATCHED' && (unlink === null
          ? <Button variant="outline" className="justify-self-start" onClick={() => setUnlink('')}>Bağı kaldır</Button>
          : <form className="grid gap-2" onSubmit={(e) => { e.preventDefault(); void doUnlink(); }}>
            <Field label="Bağı kaldırma gerekçesi" hint="En az 10 karakter; denetim kaydına girer.">{(p) => <textarea className="input" rows={2} required minLength={10} maxLength={2000} {...p} value={unlink} onChange={(e) => setUnlink(e.target.value)} />}</Field>
            <div className="flex gap-2"><Button type="submit" variant="outline" disabled={busy || unlink.trim().length < 10}>Bağı kaldır</Button><Button type="button" variant="ghost" onClick={() => setUnlink(null)}>Vazgeç</Button></div>
          </form>)}
        <div aria-live="polite">{err && <Banner tone="warn" title={err} />}{done && <Banner tone="info" icon="check" title={done} />}</div>
      </div>
      {drawer && <MatchDrawer invoiceId={invoiceId} invoiceNo={invoiceNo} onClose={() => setDrawer(false)}
        onDone={(msg) => { setDrawer(false); setDone(msg); void onChanged(); }} />}
    </section>
  );
}

// --- Proje detayı: Faturalar sekmesi (R4) -------------------------------------------------------------------------------------

interface ProjectInvoice { id: string; invoiceNo: string; date: string; kind: string; amount: string; currency: string; statusLabel: string; supplier: { legalName: string };
  matchState: MatchState; matchStateLabel: string; matchMethodLabel?: string | null; contract: { id: string; code: string; title: string } }
interface ProjectInvoices { items: ProjectInvoice[]; usage: { contract: { id: string; code: string; title: string }; usage: UsageView | null; invoiceCount: number }[] }

export function ProjectInvoicesTab({ projectId }: { projectId: string }) {
  const r = useResource<ProjectInvoices>(`/api/v1/projects/${projectId}/invoices`);
  if (r.loading && !r.data) return <Loading rows={4} />;
  if (r.error || !r.data) return <div className="rounded-md border border-border bg-surface"><ErrorState error={r.error} onRetry={r.reload} /></div>;
  const d = r.data;
  if (!d.usage.length) return <div className="rounded-md border border-border bg-surface"><Empty icon="receipt" title="Bu projeye bağlı sözleşme yok">Faturalar projenin sözleşmeleri üzerinden görünür. Önce Sözleşmeler sekmesinden sözleşme ekleyin.</Empty></div>;
  return (
    <div className="grid gap-5">
      <section className="panel" aria-labelledby="pinv-usage">
        <div className="panel-head"><h2 id="pinv-usage">Sözleşme başına kullanım</h2></div>
        <div className="panel-body grid gap-4">
          {d.usage.map((c) => (
            <div key={c.contract.id} className="grid gap-1.5 border-b border-border pb-3 last:border-b-0 last:pb-0">
              <p className="flex flex-wrap justify-between gap-2"><Link to={`/sozlesmeler/aile/${c.contract.id}?sekme=ozet`} className="font-semibold">{c.contract.code} · {c.contract.title}</Link>
                <span className="text-sm text-ink-subtle">{c.invoiceCount} fatura</span></p>
              {c.usage ? <UsageBar u={c.usage} label={`${c.contract.code} kullanımı`} /> : <p className="text-sm text-ink-muted">Kullanım hesaplanamadı (sözleşme koşulu yok).</p>}
            </div>
          ))}
        </div>
      </section>
      {!d.items.length ? <div className="rounded-md border border-border bg-surface"><Empty icon="receipt" title="Bu projenin sözleşmelerine eşleşmiş fatura yok">Faturalar otomatik ya da Faturalar ekranından elle eşleştirilince burada görünür.</Empty></div> : (
        <Table>
          <TableHeader><TableRow className="hover:bg-transparent"><TableHead>Fatura no</TableHead><TableHead>Tedarikçi</TableHead><TableHead>Tarih</TableHead><TableHead className="text-right">Tutar</TableHead>
            <TableHead>Sözleşme</TableHead><TableHead>Eşleşme</TableHead></TableRow></TableHeader>
          <TableBody>{d.items.map((x) => (
            <TableRow key={`${x.id}-${x.contract.id}`}>
              <TableCell className="whitespace-nowrap"><Link className="font-semibold text-ink" to={`/faturalar/${x.id}`}>{x.invoiceNo}</Link></TableCell>
              <TableCell>{x.supplier.legalName}</TableCell>
              <TableCell className="tabular whitespace-nowrap">{fmtDate(x.date)}</TableCell>
              <TableCell className="tabular whitespace-nowrap text-right">{fmtMoney(x.amount, x.currency)}</TableCell>
              <TableCell className="whitespace-nowrap">{x.contract.code}</TableCell>
              <TableCell><Tag label={matchStateTag(x.matchState, x.matchStateLabel)} />{x.matchMethodLabel && <span className="block text-sm text-ink-subtle">{x.matchMethodLabel}</span>}
                <span className="block text-sm text-ink-subtle">{x.statusLabel}</span></TableCell>
            </TableRow>
          ))}</TableBody>
        </Table>
      )}
    </div>
  );
}
