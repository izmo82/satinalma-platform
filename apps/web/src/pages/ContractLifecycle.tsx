import { useEffect, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { api, ApiError } from '../lib/api.ts';
import { useResource } from '../lib/useApi.ts';
import { fmtDate, fmtDateTime, fmtMoney } from '../lib/format.ts';
import { OWNER_ROLES, roleLabel } from '../lib/labels.ts';
import { Banner, Empty, ErrorState, Field, Loading, Tag } from '../ui/kit.tsx';
import { Icon } from '../ui/icons.tsx';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { SignatureWorkspace } from './SignatureWorkspace.tsx';
import { CommercialTab } from './ContractCommercial.tsx';

// UX09 Sözleşme: imza, koşullar/ihbar ve yükümlülükler aynı sürüm üzerinde ayrı sekmeler.
const TABS = [['imza', 'İmza kontrolü'], ['kosullar', 'Koşullar ve ihbar'], ['yukumlulukler', 'Yükümlülükler'], ['ticari', 'Fiyat, SLA ve teminat']] as const;

export function ContractPage() {
  const [params, setParams] = useSearchParams();
  const tab = params.get('sekme') ?? 'imza';
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div role="tablist" aria-label="Sözleşme" className="flex shrink-0 gap-6 overflow-x-auto border-b border-border bg-surface px-8 max-[900px]:px-4">
        {TABS.map(([k, l]) => (
          <button key={k} role="tab" aria-selected={tab === k} onClick={() => { const p = new URLSearchParams(params); k === 'imza' ? p.delete('sekme') : p.set('sekme', k); setParams(p, { replace: true }); }}
            className={cn('-mb-px min-h-10 whitespace-nowrap border-b-2 font-semibold transition-colors duration-150', tab === k ? 'border-ink text-ink' : 'border-transparent text-ink-muted hover:text-ink')}>{l}</button>
        ))}
      </div>
      <div role="tabpanel" className="min-h-0 flex-1">
        {tab === 'imza' ? <SignatureWorkspace /> : <Lifecycle tab={tab} />}
      </div>
    </div>
  );
}

type Terms = {
  id: string; revision: number; currency: string; valueType: 'FIXED' | 'CEILING' | 'UNPRICED'; amount: string | null; paymentTerms: string;
  startDate: string | null; endDate: string | null; autoRenewal: boolean; renewalMonths: number | null; noticeAmount: number | null; noticeUnit: 'DAY' | 'MONTH' | null;
  nonWorkingDay: 'PREVIOUS_WORKING_DAY' | 'AS_IS'; sourceRef: string; changeReason: string | null; enteredBy: string; enteredAt: string; enteredByMe: boolean;
  limitBasis: 'NET' | 'GROSS'; paymentDays: number | null; fxDifference: 'ALLOWED' | 'NOT_ALLOWED' | null;
  verifiedBy: string | null; verifiedAt: string | null;
};
interface Lc {
  contract: { id: string; title: string; versionNo: number; superseded: boolean };
  terms: Terms | null;
  diff: { field: string; label: string; before: unknown; after: unknown }[];
  notice: null | { deadline: string; raw: string; adjusted: boolean; explanation: string; daysLeft: number; reminders: { offset: number; date: string; due: boolean }[] };
  holidaysConfigured: number;
  decision: null | { decision: string; rationale: string; decidedAt: string; decidedBy: string };
  obligations: { id: string; title: string; counterparty: string; ownerRole: string | null; recurrence: string; until: string | null; firstDue: string; evidenceRequired: boolean;
    sourceRef: string; retired: boolean; retiredReason: string | null;
    periods: { dueDate: string; state: string; note: string | null; evidence: string | null; recordedBy: string | null; recordedAt: string | null }[] }[];
  can: { edit: boolean; verify: boolean; manageObligations: boolean; record: boolean; decide: boolean };
}
const VALUE_TYPE = { FIXED: 'Sabit bedel', CEILING: 'Tavan (limit)', UNPRICED: 'Bedelsiz' } as const;
const DECISION = { RENEW: 'Yenile', TERMINATE: 'Feshet (yenileme yok)', RENEGOTIATE: 'Yeniden müzakere' } as const;
const RECUR = { NONE: 'Tek sefer', MONTHLY: 'Aylık', QUARTERLY: 'Üç aylık', YEARLY: 'Yıllık' } as const;
const PERIOD = {
  FULFILLED: { text: 'Yerine getirildi', tone: 'human', icon: 'stamp' }, MISSED: { text: 'Kaçırıldı', tone: 'danger', icon: 'x' },
  WAIVED: { text: 'Feragat edildi', tone: 'neutral', icon: 'minus' }, OVERDUE: { text: 'Gecikti', tone: 'danger', icon: 'clock' },
  UPCOMING: { text: 'Bekliyor', tone: 'info', icon: 'clock' },
} as const;
const fmtVal = (v: unknown) => v === null || v === undefined || v === '' ? '—' : typeof v === 'boolean' ? (v ? 'Evet' : 'Hayır') : String(v);

export function useAct(reload: () => Promise<void>) {
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ tone: 'info' | 'warn' | 'danger'; text: string } | null>(null);
  const run = async (fn: () => Promise<unknown>, ok: string) => {
    setBusy(true); setMsg(null);
    try { await fn(); setMsg({ tone: 'info', text: ok }); await reload(); return true; }
    catch (e) { const err = e as ApiError; setMsg({ tone: err.status === 409 ? 'warn' : 'danger', text: err.message }); return false; }
    finally { setBusy(false); }
  };
  return { busy, run, feedback: msg && <Banner tone={msg.tone} icon={msg.tone === 'info' ? 'check' : undefined} title={msg.text} /> };
}

function Lifecycle({ tab }: { tab: string }) {
  const { id } = useParams();
  const r = useResource<Lc>(`/api/v1/contract-versions/${id}/lifecycle`);
  if (r.loading && !r.data) return <div className="page"><Loading rows={6} /></div>;
  if (r.error || !r.data) return <div className="page"><ErrorState error={r.error} onRetry={r.reload} /></div>;
  const d = r.data;
  return (
    <div className="page h-full overflow-auto">
      <p className="text-sm text-ink-subtle"><Link to="/sozlesmeler" className="text-ink-subtle">Sözleşmeler</Link> / Sürüm {d.contract.versionNo}</p>
      <h1 className="mb-4 mt-1">{d.contract.title}</h1>
      {d.contract.superseded && <Banner tone="warn" title="Bu sürümün yerine yeni sürüm geldi">Koşul ve yükümlülükler güncel sürümde yönetilir; bu sürümdeki kayıtlar korunur.</Banner>}
      {tab === 'kosullar' ? <TermsTab d={d} reload={r.reload} /> : tab === 'ticari' ? <CommercialTab cvId={id!} readOnly={d.contract.superseded} /> : <ObligationsTab d={d} reload={r.reload} />}
    </div>
  );
}

function TermsTab({ d, reload }: { d: Lc; reload: () => Promise<void> }) {
  const a = useAct(reload);
  const [editing, setEditing] = useState(!d.terms);
  const [decision, setDecision] = useState<keyof typeof DECISION>('RENEW');
  const [rationale, setRationale] = useState('');
  const t = d.terms;
  const canEdit = d.can.edit && !d.decision && !d.contract.superseded;
  return (
    <div className="grid grid-cols-[minmax(0,1fr)_400px] gap-6 max-[1100px]:grid-cols-1">
      <div className="grid content-start gap-5">
        {t ? (
          <section className="panel">
            <div className="panel-head"><h2>Ticari koşullar</h2><span className="tabular text-sm text-ink-subtle">Revizyon {t.revision}</span>
              {canEdit && !editing && <Button size="sm" variant="outline" className="ml-auto" onClick={() => setEditing(true)}><Icon name="pen" />Değiştir</Button>}</div>
            <div className="panel-body grid gap-3">
              <dl className="facts">
                <dt>{VALUE_TYPE[t.valueType]}</dt><dd className="tabular font-semibold">{t.amount ? fmtMoney(t.amount, t.currency) : '—'}
                  {t.valueType === 'CEILING' && <span className="ml-2 text-sm font-normal text-ink-subtle">{t.limitBasis === 'GROSS' ? 'vergi dahil' : 'vergi hariç'}</span>}</dd>
                <dt>Ödeme koşulu</dt><dd>{t.paymentTerms || '—'}{t.paymentDays !== null && <span className="tabular ml-2 text-sm text-ink-subtle">vade {t.paymentDays} gün</span>}</dd>
                <dt>Kur farkı</dt><dd>{t.fxDifference === 'ALLOWED' ? 'Uygulanabilir (fatura ve ödeme günü kuru farkı)' : t.fxDifference === 'NOT_ALLOWED' ? 'Uygulanmaz' : 'Girilmedi'}</dd>
                <dt>Süre</dt><dd className="tabular">{t.startDate ? fmtDate(t.startDate) : '—'} – {t.endDate ? fmtDate(t.endDate) : 'Süresiz'}</dd>
                <dt>Yenileme</dt><dd>{t.autoRenewal ? `Otomatik, ${t.renewalMonths} ay` : 'Otomatik değil'}</dd>
                <dt>İhbar</dt><dd>{t.noticeAmount !== null ? `Bitişten ${t.noticeAmount} ${t.noticeUnit === 'DAY' ? 'gün' : 'ay'} önce · ${t.nonWorkingDay === 'PREVIOUS_WORKING_DAY' ? 'tatil/hafta sonunda önceki iş günü' : 'tatil kuralı yok'}` : 'Tanımlı değil'}</dd>
                <dt>Kaynak</dt><dd>{t.sourceRef}</dd>
              </dl>
              <p className="text-sm text-ink-subtle">Giren: {t.enteredBy} · {fmtDateTime(t.enteredAt)}</p>
              {t.verifiedBy ? <p><Tag label={{ text: `Doğrulandı · ${t.verifiedBy}`, tone: 'human', icon: 'stamp' }} /> <span className="text-sm text-ink-subtle">{fmtDateTime(t.verifiedAt)}</span></p> : (
                <Banner tone="warn" title="İkinci kişi doğrulaması bekleniyor" action={d.can.verify && !t.enteredByMe ? <Button size="sm" disabled={a.busy}
                  onClick={() => void a.run(() => api(`/api/v1/contract-terms/${t.id}/verify`, { method: 'POST' }), 'Koşullar doğrulandı; ihbar uyarıları planlandı.')}><Icon name="stamp" />Doğrula</Button> : undefined}>
                  {t.enteredByMe ? 'Koşulları siz girdiniz; görev ayrılığı gereği başka bir Satınalma kullanıcısı doğrular.' : 'Doğrulanmadan ihbar uyarıları planlanmaz ve yenileme kararı verilemez.'}
                </Banner>
              )}
            </div>
          </section>
        ) : !editing && <div className="rounded-md border border-border bg-surface"><Empty icon="file" title="Koşullar girilmedi">Bedel, süre ve ihbar kuralı kaynak maddeyle girilir.</Empty></div>}
        {d.diff.length > 0 && (
          <section className="panel">
            <div className="panel-head"><h2>Değişiklik</h2><span className="text-sm text-ink-subtle">Önceki revizyon veya önceki sürüme göre</span></div>
            <div className="panel-body grid gap-2">
              <table className="w-full text-left"><thead><tr className="text-xs text-ink-muted"><th className="py-1 font-semibold">Alan</th><th className="font-semibold">Önce</th><th className="font-semibold">Sonra</th></tr></thead>
                <tbody>{d.diff.map((x) => <tr key={x.field} className="border-t border-border"><td className="py-1.5 font-semibold">{x.label}</td>
                  <td className="tabular text-ink-muted line-through decoration-[var(--rule-strong)]">{fmtVal(x.before)}</td><td className="tabular">{fmtVal(x.after)}</td></tr>)}</tbody></table>
              {t?.changeReason && <p className="text-sm"><span className="font-semibold">Gerekçe:</span> {t.changeReason}</p>}
            </div>
          </section>
        )}
        {editing && canEdit && <TermsForm initial={t} onCancel={t ? () => setEditing(false) : undefined}
          onSave={(body) => a.run(() => api(`/api/v1/contract-versions/${d.contract.id}/terms`, { method: 'POST', json: body }), t ? 'Yeni revizyon kaydedildi; ikinci kişi doğrulaması bekleniyor.' : 'Koşullar kaydedildi; ikinci kişi doğrulaması bekleniyor.').then((ok) => { if (ok) setEditing(false); })}
          busy={a.busy} />}
        {a.feedback}
      </div>
      <aside className="grid content-start gap-5">
        <section className="panel">
          <div className="panel-head"><h2>İhbar son günü</h2></div>
          <div className="panel-body grid gap-3">
            {!d.notice ? <p className="text-ink-muted">{t?.endDate ? 'İhbar süresi tanımlı değil.' : 'Bitiş tarihi veya ihbar kuralı yok.'}</p> : <>
              <p className="tabular text-[1.75rem] font-bold leading-none">{fmtDate(d.notice.deadline)}</p>
              <p className={cn('font-semibold', d.notice.daysLeft < 0 ? 'text-danger' : d.notice.daysLeft <= 30 ? 'text-danger' : d.notice.daysLeft <= 60 ? 'text-warn' : 'text-ink')}>
                {d.notice.daysLeft >= 0 ? `${d.notice.daysLeft} gün kaldı` : `${-d.notice.daysLeft} gün geçti`}</p>
              <p className="text-sm text-ink-muted">{d.notice.explanation}</p>
              {d.holidaysConfigured === 0 && t?.nonWorkingDay === 'PREVIOUS_WORKING_DAY' && <p className="text-sm text-warn">Kiracı tatil listesi boş: yalnız hafta sonları dikkate alındı.</p>}
              <div><h3 className="mb-1.5 text-base">Uyarılar</h3>
                <ul className="grid gap-1">{d.notice.reminders.map((m) => <li key={m.offset} className="flex justify-between gap-2 text-sm"><span>{m.offset} gün önce</span>
                  <span className="tabular">{fmtDate(m.date)}{m.due ? ' · zamanı geldi' : ''}</span></li>)}</ul>
                {!t?.verifiedBy && <p className="mt-1 text-sm text-warn">Koşullar doğrulanmadan planlanmaz.</p>}
              </div>
            </>}
          </div>
        </section>
        <section className="panel">
          <div className="panel-head"><h2>Yenileme kararı</h2></div>
          <div className="panel-body grid gap-3">
            {d.decision ? <>
              <p><Tag label={{ text: `${DECISION[d.decision.decision as keyof typeof DECISION]} · ${d.decision.decidedBy}`, tone: 'human', icon: 'stamp' }} /></p>
              <p>{d.decision.rationale}</p><p className="text-sm text-ink-subtle">{fmtDateTime(d.decision.decidedAt)}</p>
              {d.decision.decision === 'TERMINATE' && <p className="text-sm text-ink-muted">Çıkış kontrolü görevleri açıldı: veri iadesi, erişim kapatma, teminat ve açık faturalar.</p>}
            </> : d.can.decide && t?.verifiedBy ? (
              <form className="grid gap-2" onSubmit={(e) => { e.preventDefault(); void a.run(() => api(`/api/v1/contract-versions/${d.contract.id}/renewal-decision`, { method: 'POST', json: { decision, rationale } }), 'Karar kaydedildi.'); }}>
                <fieldset className="field"><legend>Karar</legend><div className="radio-list">
                  {(Object.keys(DECISION) as (keyof typeof DECISION)[]).map((k) => <label key={k}><input type="radio" name="decision" checked={decision === k} onChange={() => setDecision(k)} />{DECISION[k]}</label>)}
                </div></fieldset>
                <Field label="Gerekçe" hint="Performans, risk ve mali durumu birlikte değerlendirin.">{(p) => <textarea className="input" rows={3} {...p} value={rationale} onChange={(e) => setRationale(e.target.value)} />}</Field>
                <Button type="submit" className="justify-self-start" disabled={a.busy}><Icon name="stamp" />Kararı kaydet</Button>
              </form>
            ) : <p className="text-ink-muted">{t?.verifiedBy ? 'Kararı Satınalma verir.' : 'Karar, doğrulanmış koşullara bağlanır.'}</p>}
          </div>
        </section>
      </aside>
    </div>
  );
}

type TermsBody = Omit<Terms, 'id' | 'revision' | 'enteredBy' | 'enteredAt' | 'enteredByMe' | 'verifiedBy' | 'verifiedAt' | 'changeReason'> & { changeReason: string | null };
function TermsForm({ initial, onSave, onCancel, busy }: { initial: Terms | null; onSave: (b: TermsBody) => void; onCancel?: () => void; busy: boolean }) {
  const [f, setF] = useState({
    currency: initial?.currency ?? 'TRY', valueType: initial?.valueType ?? 'CEILING', amount: initial?.amount ?? '', paymentTerms: initial?.paymentTerms ?? '',
    startDate: initial?.startDate ?? '', endDate: initial?.endDate ?? '', autoRenewal: initial?.autoRenewal ?? false, renewalMonths: String(initial?.renewalMonths ?? ''),
    hasNotice: initial ? initial.noticeAmount !== null : true, noticeAmount: String(initial?.noticeAmount ?? '60'), noticeUnit: initial?.noticeUnit ?? 'DAY',
    nonWorkingDay: initial?.nonWorkingDay ?? 'PREVIOUS_WORKING_DAY', sourceRef: initial?.sourceRef ?? '', changeReason: '', limitBasis: initial?.limitBasis ?? 'NET',
    paymentDays: initial?.paymentDays != null ? String(initial.paymentDays) : '', fxDifference: initial?.fxDifference ?? '',
  });
  const set = (k: keyof typeof f, v: string | boolean) => setF((x) => ({ ...x, [k]: v }));
  useEffect(() => { if (f.valueType === 'UNPRICED') set('amount', ''); }, [f.valueType]);
  return (
    <form className="panel" onSubmit={(e) => { e.preventDefault(); onSave({
      currency: f.currency, valueType: f.valueType, amount: f.valueType === 'UNPRICED' ? null : f.amount.replace(',', '.'), paymentTerms: f.paymentTerms,
      startDate: f.startDate || null, endDate: f.endDate || null, autoRenewal: f.autoRenewal, renewalMonths: f.autoRenewal ? Number(f.renewalMonths) || null : null,
      noticeAmount: f.hasNotice ? Number(f.noticeAmount) : null, noticeUnit: f.hasNotice ? f.noticeUnit : null, nonWorkingDay: f.nonWorkingDay, sourceRef: f.sourceRef, limitBasis: f.limitBasis,
      paymentDays: f.paymentDays.trim() === '' ? null : Number(f.paymentDays), fxDifference: (f.fxDifference || null) as Terms['fxDifference'],
      changeReason: initial ? f.changeReason : null }); }}>
      <div className="panel-head"><h2>{initial ? `Yeni revizyon (şu an ${initial.revision})` : 'Koşulları gir'}</h2></div>
      <div className="panel-body grid grid-cols-2 gap-x-4 max-[640px]:grid-cols-1">
        <Field label="Bedel türü">{(p) => <select className="input" {...p} value={f.valueType} onChange={(e) => set('valueType', e.target.value)}>
          {Object.entries(VALUE_TYPE).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select>}</Field>
        <div className="grid grid-cols-[minmax(0,1fr)_90px] gap-x-3">
          <Field label="Tutar">{(p) => <input className="input tabular text-right" inputMode="decimal" disabled={f.valueType === 'UNPRICED'} {...p} value={f.amount} onChange={(e) => set('amount', e.target.value)} />}</Field>
          <Field label="Para">{(p) => <input className="input" maxLength={3} {...p} value={f.currency} onChange={(e) => set('currency', e.target.value.toUpperCase())} />}</Field>
        </div>
        {f.valueType === 'CEILING' && <div className="col-span-full"><Field label="Tavan vergiyi kapsar mı?" hint="Vergi dahilse faturalar KDV ve KDV dışı vergilerle düşülür.">{(p) => <select className="input" {...p} value={f.limitBasis} onChange={(e) => set('limitBasis', e.target.value)}>
          <option value="NET">Vergi hariç (net tutar)</option><option value="GROSS">Vergi dahil (KDV ve diğer vergiler)</option></select>}</Field></div>}
        <Field label="Başlangıç">{(p) => <input className="input" type="date" {...p} value={f.startDate} onChange={(e) => set('startDate', e.target.value)} />}</Field>
        <Field label="Bitiş" hint="Boş bırakılırsa süresiz.">{(p) => <input className="input" type="date" {...p} value={f.endDate} onChange={(e) => set('endDate', e.target.value)} />}</Field>
        <div className="col-span-full"><Field label="Ödeme koşulu">{(p) => <input className="input" {...p} value={f.paymentTerms} onChange={(e) => set('paymentTerms', e.target.value)} />}</Field></div>
        <Field label="Vade (gün)" hint="Fatura tarihinden itibaren. Lira Defteri vadeden önce ödemeyi bununla bulur.">{(p) => <input className="input tabular text-right" inputMode="numeric" pattern="\d{1,3}" {...p} value={f.paymentDays} onChange={(e) => set('paymentDays', e.target.value)} />}</Field>
        <Field label="Kur farkı" hint="Sözleşmede kur farkı hükmü. Girilmezse kur farkı faturaları incelemeye düşer.">{(p) => <select className="input" {...p} value={f.fxDifference} onChange={(e) => set('fxDifference', e.target.value)}>
          <option value="">Girilmedi</option><option value="ALLOWED">Uygulanabilir</option><option value="NOT_ALLOWED">Uygulanmaz</option></select>}</Field>
        <label className="mb-4 flex items-center gap-2"><input type="checkbox" className="accent-[var(--ink)]" checked={f.autoRenewal} onChange={(e) => set('autoRenewal', e.target.checked)} />Otomatik yenilenir</label>
        {f.autoRenewal ? <Field label="Yenileme süresi (ay)">{(p) => <input className="input tabular text-right" inputMode="numeric" {...p} value={f.renewalMonths} onChange={(e) => set('renewalMonths', e.target.value)} />}</Field> : <span />}
        <label className="mb-4 flex items-center gap-2"><input type="checkbox" className="accent-[var(--ink)]" checked={f.hasNotice} onChange={(e) => set('hasNotice', e.target.checked)} />İhbar şartı var</label>
        {f.hasNotice ? <div className="grid grid-cols-[100px_minmax(0,1fr)] gap-x-3">
          <Field label="İhbar">{(p) => <input className="input tabular text-right" inputMode="numeric" {...p} value={f.noticeAmount} onChange={(e) => set('noticeAmount', e.target.value)} />}</Field>
          <Field label="Birim">{(p) => <select className="input" {...p} value={f.noticeUnit} onChange={(e) => set('noticeUnit', e.target.value)}><option value="DAY">gün önce</option><option value="MONTH">ay önce</option></select>}</Field>
        </div> : <span />}
        {f.hasNotice && <div className="col-span-full"><Field label="Son gün hafta sonu veya tatile denk gelirse">{(p) => <select className="input" {...p} value={f.nonWorkingDay} onChange={(e) => set('nonWorkingDay', e.target.value)}>
          <option value="PREVIOUS_WORKING_DAY">Önceki iş günü (sözleşmede böyle yazıyorsa)</option><option value="AS_IS">Takvim günü olduğu gibi</option></select>}</Field></div>}
        <div className="col-span-full"><Field label="Kaynak madde ve sayfa" hint="Tarihlerin ve bedelin dayandığı yer; doğrulayan kişi bunu kontrol eder.">{(p) => <input className="input" {...p} value={f.sourceRef} onChange={(e) => set('sourceRef', e.target.value)} />}</Field></div>
        {initial && <div className="col-span-full"><Field label="Değişiklik gerekçesi" hint="Bedel, süre veya ihbar değişikliği yeniden doğrulama ister.">{(p) => <textarea className="input" rows={2} {...p} value={f.changeReason} onChange={(e) => set('changeReason', e.target.value)} />}</Field></div>}
        <div className="col-span-full flex gap-2"><Button type="submit" disabled={busy}>Kaydet</Button>{onCancel && <Button type="button" variant="outline" onClick={onCancel}>Vazgeç</Button>}</div>
      </div>
    </form>
  );
}

function ObligationsTab({ d, reload }: { d: Lc; reload: () => Promise<void> }) {
  const a = useAct(reload);
  const [rec, setRec] = useState<{ id: string; dueDate: string; outcome: 'FULFILLED' | 'MISSED' | 'WAIVED'; note: string; evidence: string } | null>(null);
  const [adding, setAdding] = useState(false);
  const [n, setN] = useState({ title: '', counterparty: 'SUPPLIER', ownerRole: '', firstDue: '', recurrence: 'NONE', until: '', evidenceRequired: true, sourceRef: '' });
  const active = d.obligations.filter((o) => !o.retired);
  return (
    <div className="grid gap-5">
      <p className="max-w-[75ch] text-ink-muted">Her yükümlülüğün sahibi, tarihi ve kanıtı vardır. Görev son tarihten 14 gün önce açılır; sahibi olmayan yükümlülük Satınalma'ya düşer. Dönem kaydı değişmez.</p>
      {!active.length && !adding && <div className="rounded-md border border-border bg-surface"><Empty icon="file" title="Yükümlülük yok">Bakım ziyareti, güvenlik raporu, lisans sayımı veya eğitim gibi tarihli taahhütleri ekleyin.</Empty></div>}
      {active.map((o) => (
        <section key={o.id} className="panel">
          <div className="panel-head flex-wrap"><h2 className="min-w-0 flex-1">{o.title}</h2>
            <span className="text-sm text-ink-subtle">{o.counterparty === 'SUPPLIER' ? 'Tedarikçi yükümlülüğü' : 'Alıcı yükümlülüğü'} · {RECUR[o.recurrence as keyof typeof RECUR]} · {o.ownerRole ? roleLabel[o.ownerRole] ?? o.ownerRole : 'Sahipsiz → Satınalma'}</span></div>
          <div className="panel-body grid gap-2">
            <p className="text-sm text-ink-subtle">Kaynak: {o.sourceRef}{o.evidenceRequired ? ' · kanıt zorunlu' : ''}</p>
            <ul className="grid gap-1.5">{o.periods.slice(0, 8).map((p) => {
              const L = PERIOD[p.state as keyof typeof PERIOD];
              return (
                <li key={p.dueDate} className="flex flex-wrap items-center gap-3 border-t border-[#ebe6da] pt-1.5">
                  <span className="tabular w-24">{fmtDate(p.dueDate)}</span><Tag label={L} />
                  {p.note && <span className="text-sm text-ink-muted">{p.note}{p.evidence ? ` · Kanıt: ${p.evidence}` : ''} · {p.recordedBy}</span>}
                  {d.can.record && (p.state === 'UPCOMING' || p.state === 'OVERDUE') && <Button size="xs" variant="outline" className="ml-auto" onClick={() => setRec({ id: o.id, dueDate: p.dueDate, outcome: 'FULFILLED', note: '', evidence: '' })}>Sonucu kaydet</Button>}
                </li>
              );
            })}</ul>
            {rec?.id === o.id && (
              <form className="grid gap-2 rounded-md border border-border bg-white p-3" onSubmit={(e) => { e.preventDefault(); void a.run(() => api(`/api/v1/obligations/${o.id}/events`, { method: 'POST', json: { dueDate: rec.dueDate, outcome: rec.outcome, note: rec.note, evidence: rec.evidence || null } }), 'Dönem kaydedildi.').then((ok) => ok && setRec(null)); }}>
                <p className="font-semibold">{fmtDate(rec.dueDate)} dönemi</p>
                <fieldset className="field"><legend>Sonuç</legend><div className="radio-list">
                  {(['FULFILLED', 'MISSED', 'WAIVED'] as const).map((k) => <label key={k}><input type="radio" name={`o-${o.id}`} checked={rec.outcome === k} onChange={() => setRec({ ...rec, outcome: k })} />{PERIOD[k].text}</label>)}
                </div></fieldset>
                <Field label="Açıklama">{(p) => <input className="input" {...p} value={rec.note} onChange={(e) => setRec({ ...rec, note: e.target.value })} />}</Field>
                {rec.outcome === 'FULFILLED' && <Field label={`Kanıt${o.evidenceRequired ? '' : ' (isteğe bağlı)'}`} hint="Belge no, rapor adı veya bağlantı.">{(p) => <input className="input" {...p} value={rec.evidence} onChange={(e) => setRec({ ...rec, evidence: e.target.value })} />}</Field>}
                <div className="flex gap-2"><Button type="submit" disabled={a.busy}>Kaydet</Button><Button type="button" variant="outline" onClick={() => setRec(null)}>Vazgeç</Button></div>
              </form>
            )}
          </div>
        </section>
      ))}
      {d.can.manageObligations && !d.contract.superseded && (adding ? (
        <form className="panel" onSubmit={(e) => { e.preventDefault(); void a.run(() => api(`/api/v1/contract-versions/${d.contract.id}/obligations`, { method: 'POST', json: {
          ...n, ownerRole: n.ownerRole || null, until: n.until || null } }), 'Yükümlülük eklendi.').then((ok) => ok && setAdding(false)); }}>
          <div className="panel-head"><h2>Yükümlülük ekle</h2></div>
          <div className="panel-body grid grid-cols-2 gap-x-4 max-[640px]:grid-cols-1">
            <div className="col-span-full"><Field label="Yükümlülük">{(p) => <input className="input" {...p} value={n.title} onChange={(e) => setN({ ...n, title: e.target.value })} />}</Field></div>
            <Field label="Kimin yükümlülüğü">{(p) => <select className="input" {...p} value={n.counterparty} onChange={(e) => setN({ ...n, counterparty: e.target.value })}><option value="SUPPLIER">Tedarikçi</option><option value="BUYER">Alıcı (biz)</option></select>}</Field>
            <Field label="Takip eden rol" hint="Boşsa Satınalma rolüne düşer.">{(p) => <select className="input" {...p} value={n.ownerRole} onChange={(e) => setN({ ...n, ownerRole: e.target.value })}>
              <option value="">Sahipsiz</option>{OWNER_ROLES.map((r) => <option key={r} value={r}>{roleLabel[r]}</option>)}</select>}</Field>
            <Field label="İlk tarih">{(p) => <input className="input" type="date" required {...p} value={n.firstDue} onChange={(e) => setN({ ...n, firstDue: e.target.value })} />}</Field>
            <Field label="Tekrar">{(p) => <select className="input" {...p} value={n.recurrence} onChange={(e) => setN({ ...n, recurrence: e.target.value })}>{Object.entries(RECUR).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select>}</Field>
            {n.recurrence !== 'NONE' ? <Field label="Son dönem (isteğe bağlı)">{(p) => <input className="input" type="date" {...p} value={n.until} onChange={(e) => setN({ ...n, until: e.target.value })} />}</Field> : <span />}
            <label className="mb-4 flex items-center gap-2"><input type="checkbox" className="accent-[var(--ink)]" checked={n.evidenceRequired} onChange={(e) => setN({ ...n, evidenceRequired: e.target.checked })} />Kanıtla kapanır</label>
            <div className="col-span-full"><Field label="Kaynak madde">{(p) => <input className="input" required {...p} value={n.sourceRef} onChange={(e) => setN({ ...n, sourceRef: e.target.value })} />}</Field></div>
            <div className="col-span-full flex gap-2"><Button type="submit" disabled={a.busy}>Ekle</Button><Button type="button" variant="outline" onClick={() => setAdding(false)}>Vazgeç</Button></div>
          </div>
        </form>
      ) : <Button variant="outline" className="justify-self-start" onClick={() => setAdding(true)}>Yükümlülük ekle</Button>)}
      {a.feedback}
    </div>
  );
}

