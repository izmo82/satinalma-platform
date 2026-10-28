import { useState } from 'react';
import { api } from '../lib/api.ts';
import { useResource } from '../lib/useApi.ts';
import { fmtDate, fmtDateTime, fmtMoney } from '../lib/format.ts';
import type { Label } from '../lib/labels.ts';
import { Empty, ErrorState, Field, Loading, Tag } from '../ui/kit.tsx';
import { Icon } from '../ui/icons.tsx';
import { Button } from '@/components/ui/button';
import { useAct } from './ContractLifecycle.tsx';

// Faz 3 (02 §11): endeksli fiyat revizyonu, SLA kredisi ve teminat. Hesap sunucuda; öneren/giren onaylayamaz.
interface Rule { id: string; indexName: string; baseIndex: string; basePeriod: string; period: keyof typeof PERIOD; capPercent: string | null; floorPercent: string | null; sourceRef: string;
  createdBy: string; createdAt: string; retiredAt: string | null; retiredReason: string | null }
interface Revision { id: string; ruleId: string; effectiveFrom: string; indexValue: string; indexSource: string; rawChangePercent: string; appliedChangePercent: string; factor: string;
  proposedBy: string; proposedByMe: boolean; proposedAt: string; approvedBy: string | null; approvedAt: string | null }
interface Tier { threshold: string; creditPercent: string }
interface Sla { id: string; name: string; unit: string; direction: 'MIN' | 'MAX'; target: string; periodFee: string; currency: string; tiers: Tier[]; capPercent: string | null; sourceRef: string; retiredAt: string | null }
interface Measurement { id: string; slaTermId: string; periodStart: string; measured: string; evidence: string; breached: boolean; creditPercent: string; creditAmount: string;
  enteredBy: string; enteredByMe: boolean; enteredAt: string; verifiedBy: string | null; verifiedAt: string | null; rejectedBy: string | null; rejectedAt: string | null; rejectedReason: string | null }
interface Guarantee { id: string; kind: keyof typeof KIND; amount: string; currency: string; issuer: string; referenceNo: string; validUntil: string | null; receivedBy: string; receivedAt: string;
  returnedBy: string | null; returnedAt: string | null; returnNote: string | null; status: keyof typeof G_STATUS }
interface Commercial { rules: Rule[]; revisions: Revision[]; currentFactor: { factor: string; effectiveFrom: string } | null; sla: Sla[]; measurements: Measurement[]; guarantees: Guarantee[];
  can: { propose: boolean; approve: boolean; guarantee: boolean } }

const PERIOD = { MONTHLY: 'Aylık', QUARTERLY: 'Üç aylık', YEARLY: 'Yıllık' } as const;
const KIND = { PERFORMANCE: 'Kesin teminat', ADVANCE: 'Avans teminatı', WARRANTY: 'Garanti teminatı', CASH: 'Nakit teminat', OTHER: 'Diğer' } as const;
const G_STATUS: Record<string, Label> = {
  ACTIVE: { text: 'Geçerli', tone: 'ok', icon: 'check' }, EXPIRING: { text: 'Süresi doluyor', tone: 'warn', icon: 'clock' },
  EXPIRED: { text: 'Süresi geçti', tone: 'danger', icon: 'clock' }, RETURNED: { text: 'İade edildi', tone: 'neutral', icon: 'minus' },
};
const pct = (v: string | null) => (v === null ? '—' : `%${v.replace('.', ',')}`);
const num = (v: string) => v.replace('.', ',');
const dot = (v: string) => v.replace(',', '.').trim();

export function CommercialTab({ cvId, readOnly }: { cvId: string; readOnly: boolean }) {
  const r = useResource<Commercial>(`/api/v1/contract-versions/${cvId}/commercial`);
  if (r.loading && !r.data) return <Loading rows={6} />;
  if (r.error || !r.data) return <ErrorState error={r.error} onRetry={r.reload} />;
  const d = r.data;
  return (
    <div className="grid content-start gap-5">
      <PricePanel d={d} cvId={cvId} readOnly={readOnly} reload={r.reload} />
      <SlaPanel d={d} cvId={cvId} readOnly={readOnly} reload={r.reload} />
      <GuaranteePanel d={d} cvId={cvId} reload={r.reload} />
    </div>
  );
}

function PricePanel({ d, cvId, readOnly, reload }: { d: Commercial; cvId: string; readOnly: boolean; reload: () => Promise<void> }) {
  const a = useAct(reload);
  const rule = d.rules.find((x) => !x.retiredAt) ?? null;
  const emptyRule = { indexName: '', baseIndex: '', basePeriod: '', period: 'YEARLY' as keyof typeof PERIOD, capPercent: '', floorPercent: '', sourceRef: '', replaceReason: '' };
  const [rf, setRf] = useState<typeof emptyRule | null>(null);
  const [pf, setPf] = useState<{ effectiveFrom: string; indexValue: string; indexSource: string } | null>(null);
  return (
    <section className="panel">
      <div className="panel-head"><h2>Fiyat revizyonu</h2>
        {d.currentFactor && <span className="tabular text-sm text-ink-subtle">Yürürlükteki katsayı {num(d.currentFactor.factor)} ({fmtDate(d.currentFactor.effectiveFrom)} itibarıyla, baz fiyata göre)</span>}
        {d.can.propose && !readOnly && !rf && <Button size="sm" variant="outline" className="ml-auto" onClick={() => setRf(emptyRule)}><Icon name="pen" />{rule ? 'Kuralı değiştir' : 'Kural tanımla'}</Button>}</div>
      <div className="panel-body grid gap-4">
        {rule ? (
          <dl className="facts">
            <dt>Endeks</dt><dd>{rule.indexName} · {PERIOD[rule.period]} revizyon</dd>
            <dt>Baz</dt><dd className="tabular">{num(rule.baseIndex)} ({fmtDate(rule.basePeriod)})</dd>
            <dt>Sınır</dt><dd>Artış en çok {pct(rule.capPercent)}{rule.floorPercent !== null ? ` · düşüş en çok ${pct(rule.floorPercent)}` : ' · düşüş sınırsız'}</dd>
            <dt>Kaynak</dt><dd>{rule.sourceRef}</dd>
          </dl>
        ) : !rf && <Empty icon="info" title="Fiyat revizyonu kuralı yok">Sözleşmede endeksli fiyat farkı maddesi varsa endeks, baz değer ve sınırlarıyla girin.</Empty>}
        {rf && (
          <form className="grid gap-3" onSubmit={(e) => { e.preventDefault(); void a.run(() => api(`/api/v1/contract-versions/${cvId}/price-rules`, { method: 'POST', json: {
            indexName: rf.indexName, baseIndex: dot(rf.baseIndex), basePeriod: rf.basePeriod, period: rf.period, capPercent: dot(rf.capPercent) || null, floorPercent: dot(rf.floorPercent) || null,
            sourceRef: rf.sourceRef, replaceReason: rule ? rf.replaceReason : null } }), 'Fiyat revizyonu kuralı kaydedildi.').then((ok) => ok && setRf(null)); }}>
            <div className="grid grid-cols-4 items-start gap-x-3 max-[900px]:grid-cols-2">
              <Field label="Endeks adı" hint="Ör. TÜFE (TÜİK), Yİ-ÜFE.">{(p) => <input className="input" required {...p} value={rf.indexName} onChange={(e) => setRf({ ...rf, indexName: e.target.value })} />}</Field>
              <Field label="Baz endeks değeri">{(p) => <input className="input tabular text-right" required inputMode="decimal" {...p} value={rf.baseIndex} onChange={(e) => setRf({ ...rf, baseIndex: e.target.value })} />}</Field>
              <Field label="Baz dönem">{(p) => <input className="input" type="date" required {...p} value={rf.basePeriod} onChange={(e) => setRf({ ...rf, basePeriod: e.target.value })} />}</Field>
              <Field label="Revizyon sıklığı">{(p) => <select className="input" {...p} value={rf.period} onChange={(e) => setRf({ ...rf, period: e.target.value as keyof typeof PERIOD })}>
                {Object.entries(PERIOD).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select>}</Field>
              <Field label="Artış tavanı %" hint="Boş = sınırsız.">{(p) => <input className="input tabular text-right" inputMode="decimal" {...p} value={rf.capPercent} onChange={(e) => setRf({ ...rf, capPercent: e.target.value })} />}</Field>
              <Field label="Düşüş tabanı %" hint="0 = fiyat düşmez; boş = sınırsız.">{(p) => <input className="input tabular text-right" inputMode="decimal" {...p} value={rf.floorPercent} onChange={(e) => setRf({ ...rf, floorPercent: e.target.value })} />}</Field>
              <div className="col-span-2 max-[900px]:col-span-full"><Field label="Kaynak madde">{(p) => <input className="input" required {...p} value={rf.sourceRef} onChange={(e) => setRf({ ...rf, sourceRef: e.target.value })} />}</Field></div>
            </div>
            {rule && <Field label="Değişiklik gerekçesi" hint="Yürürlükteki kural kaldırılır; geçmiş revizyonlar korunur.">{(p) => <textarea className="input" rows={2} required minLength={10} {...p} value={rf.replaceReason} onChange={(e) => setRf({ ...rf, replaceReason: e.target.value })} />}</Field>}
            <div className="flex gap-2"><Button type="submit" disabled={a.busy}>Kaydet</Button><Button type="button" variant="ghost" onClick={() => setRf(null)}>Vazgeç</Button></div>
          </form>
        )}
        {d.revisions.length > 0 && (
          <div className="overflow-x-auto" tabIndex={0} role="region" aria-label="Fiyat revizyonları">
            <table className="w-full text-sm">
              <thead><tr className="text-left text-ink-subtle"><th className="py-1.5 pr-3 font-semibold">Başlangıç</th><th className="pr-3 font-semibold">Endeks</th><th className="pr-3 font-semibold">Değişim</th><th className="pr-3 font-semibold">Katsayı</th><th className="font-semibold">Onay</th></tr></thead>
              <tbody>{d.revisions.map((v) => (
                <tr key={v.id} className="border-t border-border align-top">
                  <td className="tabular py-2 pr-3">{fmtDate(v.effectiveFrom)}</td>
                  <td className="pr-3"><span className="tabular">{num(v.indexValue)}</span><span className="block text-ink-subtle">{v.indexSource}</span></td>
                  <td className="tabular pr-3">{pct(v.appliedChangePercent)}{v.rawChangePercent !== v.appliedChangePercent && <span className="block text-ink-subtle">endeks {pct(v.rawChangePercent)}, sınırlandı</span>}</td>
                  <td className="tabular pr-3 font-semibold">{num(v.factor)}</td>
                  <td>{v.approvedAt ? <span>{v.approvedBy} · {fmtDateTime(v.approvedAt)}</span>
                    : d.can.approve && !v.proposedByMe ? <Button size="sm" disabled={a.busy} onClick={() => void a.run(() => api(`/api/v1/price-revisions/${v.id}/approve`, { method: 'POST' }), `${fmtDate(v.effectiveFrom)} revizyonu onaylandı.`)}>Onayla</Button>
                    : <span className="text-ink-subtle">{v.proposedByMe ? 'Sizin öneriniz; başka biri onaylar' : 'Onay bekliyor'} ({v.proposedBy})</span>}</td>
                </tr>
              ))}</tbody>
            </table>
          </div>
        )}
        {rule && d.can.propose && !readOnly && (pf ? (
          <form className="grid gap-3" onSubmit={(e) => { e.preventDefault(); void a.run(() => api(`/api/v1/price-rules/${rule.id}/revisions`, { method: 'POST', json: { ...pf, indexValue: dot(pf.indexValue) } }),
            'Revizyon önerildi; ikinci kişinin onayı bekleniyor.').then((ok) => ok && setPf(null)); }}>
            <div className="grid grid-cols-[160px_160px_minmax(0,1fr)] items-start gap-x-3 max-[900px]:grid-cols-1">
              <Field label="Yürürlük başlangıcı">{(p) => <input className="input" type="date" required {...p} value={pf.effectiveFrom} onChange={(e) => setPf({ ...pf, effectiveFrom: e.target.value })} />}</Field>
              <Field label="Yeni endeks değeri">{(p) => <input className="input tabular text-right" required inputMode="decimal" {...p} value={pf.indexValue} onChange={(e) => setPf({ ...pf, indexValue: e.target.value })} />}</Field>
              <Field label="Endeks kaynağı" hint="Bülten, tarih; denetim kaydına yazılır.">{(p) => <input className="input" required {...p} value={pf.indexSource} onChange={(e) => setPf({ ...pf, indexSource: e.target.value })} />}</Field>
            </div>
            <div className="flex gap-2"><Button type="submit" disabled={a.busy}>Hesapla ve öner</Button><Button type="button" variant="ghost" onClick={() => setPf(null)}>Vazgeç</Button></div>
          </form>
        ) : <div><Button size="sm" variant="outline" onClick={() => setPf({ effectiveFrom: '', indexValue: '', indexSource: '' })}>Revizyon öner</Button></div>)}
        {a.feedback}
      </div>
    </section>
  );
}

function SlaPanel({ d, cvId, readOnly, reload }: { d: Commercial; cvId: string; readOnly: boolean; reload: () => Promise<void> }) {
  const a = useAct(reload);
  const emptyTerm = { name: '', unit: '%', direction: 'MIN' as 'MIN' | 'MAX', target: '', periodFee: '', currency: 'TRY', capPercent: '', sourceRef: '', tiers: [{ threshold: '', creditPercent: '' }] };
  const [tf, setTf] = useState<typeof emptyTerm | null>(null);
  const [mf, setMf] = useState<{ slaTermId: string; periodStart: string; measured: string; evidence: string } | null>(null);
  const [rejecting, setRejecting] = useState<{ id: string; reason: string } | null>(null);
  return (
    <section className="panel">
      <div className="panel-head"><h2>SLA ve hizmet kredisi</h2><span className="text-sm text-ink-subtle">Kredi, ölçüm başka biri tarafından doğrulanınca kesinleşir; finans iade/alacak belgesiyle işler.</span>
        {d.can.propose && !readOnly && !tf && <Button size="sm" variant="outline" className="ml-auto" onClick={() => setTf(emptyTerm)}>SLA ekle</Button>}</div>
      <div className="panel-body grid gap-5">
        {!d.sla.length && !tf && <Empty icon="info" title="SLA tanımı yok">Sözleşmede hizmet seviyesi ve kredi/ceza maddesi varsa hedef, kademeler ve üst sınırla girin.</Empty>}
        {tf && (
          <form className="grid gap-3 rounded-md border border-border p-4" onSubmit={(e) => { e.preventDefault(); void a.run(() => api(`/api/v1/contract-versions/${cvId}/sla-terms`, { method: 'POST', json: {
            ...tf, target: dot(tf.target), periodFee: dot(tf.periodFee), capPercent: dot(tf.capPercent) || null, tiers: tf.tiers.map((t) => ({ threshold: dot(t.threshold), creditPercent: dot(t.creditPercent) })) } }),
            'SLA kaydedildi.').then((ok) => ok && setTf(null)); }}>
            <div className="grid grid-cols-4 items-start gap-x-3 max-[900px]:grid-cols-2">
              <div className="col-span-2"><Field label="Ölçüt">{(p) => <input className="input" required {...p} placeholder="Aylık erişilebilirlik" value={tf.name} onChange={(e) => setTf({ ...tf, name: e.target.value })} />}</Field></div>
              <Field label="Birim">{(p) => <input className="input" required {...p} value={tf.unit} onChange={(e) => setTf({ ...tf, unit: e.target.value })} />}</Field>
              <Field label="Yön">{(p) => <select className="input" {...p} value={tf.direction} onChange={(e) => setTf({ ...tf, direction: e.target.value as 'MIN' | 'MAX' })}>
                <option value="MIN">En az (altına düşerse ihlal)</option><option value="MAX">En çok (üstüne çıkarsa ihlal)</option></select>}</Field>
              <Field label="Hedef">{(p) => <input className="input tabular text-right" required inputMode="decimal" {...p} value={tf.target} onChange={(e) => setTf({ ...tf, target: e.target.value })} />}</Field>
              <Field label="Dönem bedeli" hint="Kredinin matrahı.">{(p) => <input className="input tabular text-right" required inputMode="decimal" {...p} value={tf.periodFee} onChange={(e) => setTf({ ...tf, periodFee: e.target.value })} />}</Field>
              <Field label="Para">{(p) => <input className="input" maxLength={3} {...p} value={tf.currency} onChange={(e) => setTf({ ...tf, currency: e.target.value.toUpperCase() })} />}</Field>
              <Field label="Dönem üst sınırı %" hint="Boş = sınırsız.">{(p) => <input className="input tabular text-right" inputMode="decimal" {...p} value={tf.capPercent} onChange={(e) => setTf({ ...tf, capPercent: e.target.value })} />}</Field>
            </div>
            <fieldset className="grid gap-2"><legend className="mb-1 text-sm font-semibold">Kredi kademeleri ({tf.direction === 'MIN' ? 'ölçüm eşiğin altına düşerse' : 'ölçüm eşiği aşarsa'}; en yüksek geçerli kademe uygulanır)</legend>
              {tf.tiers.map((t, i) => (
                <div key={i} className="grid grid-cols-[160px_160px_auto] items-start gap-3">
                  <Field label={`Eşik ${i + 1}`}>{(p) => <input className="input tabular text-right" required inputMode="decimal" {...p} value={t.threshold} onChange={(e) => setTf({ ...tf, tiers: tf.tiers.map((x, j) => j === i ? { ...x, threshold: e.target.value } : x) })} />}</Field>
                  <Field label="Kredi %">{(p) => <input className="input tabular text-right" required inputMode="decimal" {...p} value={t.creditPercent} onChange={(e) => setTf({ ...tf, tiers: tf.tiers.map((x, j) => j === i ? { ...x, creditPercent: e.target.value } : x) })} />}</Field>
                  <Button type="button" variant="ghost" size="sm" className="mt-6" disabled={tf.tiers.length === 1} aria-label={`Kademe ${i + 1} sil`} onClick={() => setTf({ ...tf, tiers: tf.tiers.filter((_, j) => j !== i) })}><Icon name="close" /></Button>
                </div>
              ))}
              <div><Button type="button" size="sm" variant="outline" onClick={() => setTf({ ...tf, tiers: [...tf.tiers, { threshold: '', creditPercent: '' }] })}>Kademe ekle</Button></div>
            </fieldset>
            <Field label="Kaynak madde">{(p) => <input className="input" required {...p} value={tf.sourceRef} onChange={(e) => setTf({ ...tf, sourceRef: e.target.value })} />}</Field>
            <div className="flex gap-2"><Button type="submit" disabled={a.busy}>Kaydet</Button><Button type="button" variant="ghost" onClick={() => setTf(null)}>Vazgeç</Button></div>
          </form>
        )}
        {d.sla.map((s) => {
          const ms = d.measurements.filter((m) => m.slaTermId === s.id);
          return (
            <div key={s.id} className="grid gap-2 border-b border-border pb-4 last:border-b-0 last:pb-0">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <h3 className="font-semibold">{s.name}</h3>
                <span className="tabular text-sm text-ink-subtle">Hedef {s.direction === 'MIN' ? '≥' : '≤'} {num(s.target)} {s.unit} · dönem bedeli {fmtMoney(s.periodFee, s.currency)} · üst sınır {pct(s.capPercent)} · {s.sourceRef}</span>
              </div>
              <p className="tabular text-sm text-ink-muted">Kademeler: {s.tiers.map((t) => `${s.direction === 'MIN' ? '<' : '>'} ${num(t.threshold)} ${s.unit} → ${pct(t.creditPercent)}`).join(' · ')}</p>
              {ms.map((m) => (
                <div key={m.id} className="grid gap-1 rounded-md bg-sunken px-3 py-2 text-sm">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span><span className="tabular font-semibold">{m.periodStart.slice(0, 7)}</span> · ölçüm <span className="tabular">{num(m.measured)} {s.unit}</span> · {m.breached ? <>ihlal, kredi <span className="tabular font-semibold">{fmtMoney(m.creditAmount, s.currency)}</span> ({pct(m.creditPercent)})</> : 'hedef tuttu'}</span>
                    <span className="text-ink-subtle">{m.verifiedAt ? `Doğrulandı: ${m.verifiedBy}` : m.rejectedAt ? `Reddedildi: ${m.rejectedBy}` : `Giren ${m.enteredBy}; doğrulama bekliyor`}</span>
                  </div>
                  <span className="text-ink-muted">Kanıt: {m.evidence}{m.rejectedReason ? ` · Ret gerekçesi: ${m.rejectedReason}` : ''}</span>
                  {!m.verifiedAt && !m.rejectedAt && d.can.approve && !m.enteredByMe && (rejecting?.id === m.id ? (
                    <div className="grid gap-2">
                      <Field label="Ret gerekçesi">{(p) => <textarea className="input" rows={2} {...p} value={rejecting.reason} onChange={(e) => setRejecting({ id: m.id, reason: e.target.value })} />}</Field>
                      <div className="flex gap-2"><Button size="sm" variant="destructive" disabled={a.busy || rejecting.reason.trim().length < 10} onClick={() => void a.run(() => api(`/api/v1/sla-measurements/${m.id}/decision`, { method: 'POST', json: { decision: 'REJECT', reason: rejecting.reason } }), 'Ölçüm reddedildi; aynı dönem için yeniden girilebilir.').then((ok) => ok && setRejecting(null))}>Reddet</Button>
                        <Button size="sm" variant="ghost" onClick={() => setRejecting(null)}>Vazgeç</Button></div>
                    </div>
                  ) : (
                    <div className="flex gap-2"><Button size="sm" disabled={a.busy} onClick={() => void a.run(() => api(`/api/v1/sla-measurements/${m.id}/decision`, { method: 'POST', json: { decision: 'VERIFY' } }), m.breached ? `Kredi doğrulandı: ${fmtMoney(m.creditAmount, s.currency)}.` : 'Ölçüm doğrulandı.')}>Doğrula</Button>
                      <Button size="sm" variant="outline" onClick={() => setRejecting({ id: m.id, reason: '' })}>Reddet</Button></div>
                  ))}
                </div>
              ))}
              {d.can.propose && !readOnly && !s.retiredAt && (mf?.slaTermId === s.id ? (
                <form className="grid gap-3" onSubmit={(e) => { e.preventDefault(); void a.run(() => api(`/api/v1/sla-terms/${s.id}/measurements`, { method: 'POST', json: { periodStart: mf.periodStart, measured: dot(mf.measured), evidence: mf.evidence } }),
                  'Ölçüm kaydedildi; ihlal varsa doğrulama görevi açıldı.').then((ok) => ok && setMf(null)); }}>
                  <div className="grid grid-cols-[170px_150px_minmax(0,1fr)] items-start gap-x-3 max-[900px]:grid-cols-1">
                    <Field label="Dönem (ay)">{(p) => <input className="input" type="month" required {...p} value={mf.periodStart.slice(0, 7)} onChange={(e) => setMf({ ...mf, periodStart: e.target.value ? `${e.target.value}-01` : '' })} />}</Field>
                    <Field label={`Ölçüm (${s.unit})`}>{(p) => <input className="input tabular text-right" required inputMode="decimal" {...p} value={mf.measured} onChange={(e) => setMf({ ...mf, measured: e.target.value })} />}</Field>
                    <Field label="Kanıt" hint="Rapor adı, kaynak; denetim kaydına yazılır.">{(p) => <input className="input" required minLength={5} {...p} value={mf.evidence} onChange={(e) => setMf({ ...mf, evidence: e.target.value })} />}</Field>
                  </div>
                  <div className="flex gap-2"><Button type="submit" disabled={a.busy}>Hesapla ve kaydet</Button><Button type="button" variant="ghost" onClick={() => setMf(null)}>Vazgeç</Button></div>
                </form>
              ) : <div><Button size="sm" variant="outline" onClick={() => setMf({ slaTermId: s.id, periodStart: '', measured: '', evidence: '' })}>Dönem ölçümü gir</Button></div>)}
            </div>
          );
        })}
        {a.feedback}
      </div>
    </section>
  );
}

function GuaranteePanel({ d, cvId, reload }: { d: Commercial; cvId: string; reload: () => Promise<void> }) {
  const a = useAct(reload);
  const empty = { kind: 'PERFORMANCE' as keyof typeof KIND, amount: '', currency: 'TRY', issuer: '', referenceNo: '', validUntil: '' };
  const [f, setF] = useState<typeof empty | null>(null);
  const [ret, setRet] = useState<{ id: string; note: string } | null>(null);
  return (
    <section className="panel">
      <div className="panel-head"><h2>Teminatlar</h2><span className="text-sm text-ink-subtle">Bitişine 30 gün kalan veya süresi geçen iade edilmemiş teminat için finansa görev açılır.</span>
        {d.can.guarantee && !f && <Button size="sm" variant="outline" className="ml-auto" onClick={() => setF(empty)}>Teminat kaydet</Button>}</div>
      <div className="panel-body grid gap-4">
        {f && (
          <form className="grid gap-3" onSubmit={(e) => { e.preventDefault(); void a.run(() => api(`/api/v1/contract-versions/${cvId}/guarantees`, { method: 'POST', json: { ...f, amount: dot(f.amount), validUntil: f.validUntil || null } }),
            'Teminat kaydedildi.').then((ok) => ok && setF(null)); }}>
            <div className="grid grid-cols-3 items-start gap-x-3 max-[900px]:grid-cols-1">
              <Field label="Tür">{(p) => <select className="input" {...p} value={f.kind} onChange={(e) => setF({ ...f, kind: e.target.value as keyof typeof KIND })}>{Object.entries(KIND).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select>}</Field>
              <div className="grid grid-cols-[minmax(0,1fr)_80px] gap-x-3">
                <Field label="Tutar">{(p) => <input className="input tabular text-right" required inputMode="decimal" {...p} value={f.amount} onChange={(e) => setF({ ...f, amount: e.target.value })} />}</Field>
                <Field label="Para">{(p) => <input className="input" maxLength={3} {...p} value={f.currency} onChange={(e) => setF({ ...f, currency: e.target.value.toUpperCase() })} />}</Field>
              </div>
              <Field label="Geçerlilik sonu" hint="Süresizse boş bırakın.">{(p) => <input className="input" type="date" {...p} value={f.validUntil} onChange={(e) => setF({ ...f, validUntil: e.target.value })} />}</Field>
              <Field label="Veren (banka/kurum)">{(p) => <input className="input" required {...p} value={f.issuer} onChange={(e) => setF({ ...f, issuer: e.target.value })} />}</Field>
              <Field label="Mektup/belge no">{(p) => <input className="input" required {...p} value={f.referenceNo} onChange={(e) => setF({ ...f, referenceNo: e.target.value })} />}</Field>
            </div>
            <div className="flex gap-2"><Button type="submit" disabled={a.busy}>Kaydet</Button><Button type="button" variant="ghost" onClick={() => setF(null)}>Vazgeç</Button></div>
          </form>
        )}
        {!d.guarantees.length && !f ? <Empty icon="info" title="Teminat kaydı yok">Kesin, avans veya garanti teminatı alındıysa tutarı, vereni ve geçerlilik sonuyla kaydedin.</Empty> : d.guarantees.map((g) => (
          <div key={g.id} className="grid gap-1 border-b border-border pb-3 text-sm last:border-b-0 last:pb-0">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span><span className="font-semibold">{KIND[g.kind]}</span> · <span className="tabular">{fmtMoney(g.amount, g.currency)}</span> · {g.issuer} · <span className="mono">{g.referenceNo}</span></span>
              <Tag label={G_STATUS[g.status]} />
            </div>
            <span className="text-ink-muted">Geçerlilik {g.validUntil ? fmtDate(g.validUntil) : 'süresiz'} · kaydeden {g.receivedBy}{g.returnedAt ? ` · iade ${fmtDate(g.returnedAt.slice(0, 10))} (${g.returnedBy}): ${g.returnNote}` : ''}</span>
            {!g.returnedAt && d.can.guarantee && (ret?.id === g.id ? (
              <div className="grid gap-2">
                <Field label="İade notu" hint="Kime, hangi yazıyla iade edildi.">{(p) => <textarea className="input" rows={2} {...p} value={ret.note} onChange={(e) => setRet({ id: g.id, note: e.target.value })} />}</Field>
                <div className="flex gap-2"><Button size="sm" disabled={a.busy || ret.note.trim().length < 10} onClick={() => void a.run(() => api(`/api/v1/guarantees/${g.id}/return`, { method: 'POST', json: { note: ret.note } }), 'Teminat iade edildi olarak kaydedildi.').then((ok) => ok && setRet(null))}>İadeyi kaydet</Button>
                  <Button size="sm" variant="ghost" onClick={() => setRet(null)}>Vazgeç</Button></div>
              </div>
            ) : <div><Button size="sm" variant="outline" onClick={() => setRet({ id: g.id, note: '' })}>İade et</Button></div>)}
          </div>
        ))}
        {a.feedback}
      </div>
    </section>
  );
}
