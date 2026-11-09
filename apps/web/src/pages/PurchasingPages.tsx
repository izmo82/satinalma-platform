import { useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { SavedViews } from '../ui/SavedViews.tsx';
import { api, ApiError } from '../lib/api.ts';
import { useResource } from '../lib/useApi.ts';
import { useSession, hasRole } from '../lib/session.tsx';
import { fmtDate, fmtDateTime, fmtMoney } from '../lib/format.ts';
import { roleLabel, supplierPickHint, supplierRecordNote, type SupplierOption } from '../lib/labels.ts';
import { Banner, Empty, ErrorState, Field, FilterChip, Loading, PageHeader, Tag, toneClass } from '../ui/kit.tsx';
import { Icon } from '../ui/icons.tsx';
import { UblFindings, ublTitle, type UblCheck } from '../ui/UblCheck.tsx';
import { Button } from '@/components/ui/button';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { cn } from '@/lib/utils';

// UX10 Fatura + sipariş/kabul. Ödeme yürütme yok; ERP aktarımı, muhasebe ve ödeme durumu ayrı gösterilir.
const num = (s: string) => Number(s).toLocaleString('tr-TR', { maximumFractionDigits: 6 });
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

// --- Siparişler -----------------------------------------------------------------------------------

export function PurchaseOrdersPage() {
  const { me } = useSession();
  const navigate = useNavigate();
  const [creating, setCreating] = useState(false);
  const r = useResource<{ items: { id: string; code: string; currency: string; status: string; issuedAt: string; supplierName: string; contractTitle: string | null; total: string }[] }>('/api/v1/purchase-orders');
  return (
    <div className="page">
      <PageHeader title="Siparişler" actions={hasRole(me, 'BUYER', 'PROCUREMENT_MANAGER') && <Button onClick={() => setCreating(true)}><Icon name="package" />Sipariş ver</Button>}>
        Hafif sipariş kaydı ve mal/hizmet kabulü. Sözleşmeye bağlı sipariş açık taahhüttür ve sözleşme limitinden düşer.
      </PageHeader>
      {creating && <PoForm onCancel={() => setCreating(false)} onCreated={(id) => navigate(`/siparisler/${id}`)} />}
      {r.loading && !r.data ? <Loading /> : r.error ? <ErrorState error={r.error} onRetry={r.reload} /> : !r.data?.items.length ? (
        <div className="rounded-md border border-border bg-surface"><Empty icon="receipt" title="Sipariş yok">Onaylanan tahsisten veya sözleşmeden sipariş verildiğinde burada görünür.</Empty></div>
      ) : (
        <Table>
          <TableHeader><TableRow className="hover:bg-transparent"><TableHead>Sipariş no</TableHead><TableHead>Tedarikçi</TableHead><TableHead>Sözleşme</TableHead><TableHead className="text-right">Tutar</TableHead><TableHead>Tarih</TableHead></TableRow></TableHeader>
          <TableBody>{r.data.items.map((p) => (
            <TableRow key={p.id}>
              <TableCell className="whitespace-nowrap"><Link className="font-semibold text-ink no-underline hover:underline" to={`/siparisler/${p.id}`}>{p.code}</Link>{p.status !== 'OPEN' && <span className="ml-2 text-sm text-ink-subtle">{PO_STATUS[p.status]}</span>}</TableCell>
              <TableCell>{p.supplierName}</TableCell><TableCell>{p.contractTitle ?? <span className="text-ink-subtle">Sözleşmesiz</span>}</TableCell>
              <TableCell className="whitespace-nowrap text-right">{fmtMoney(p.total, p.currency)}</TableCell><TableCell className="whitespace-nowrap text-sm text-ink-subtle">{fmtDate(p.issuedAt)}</TableCell>
            </TableRow>
          ))}</TableBody>
        </Table>
      )}
    </div>
  );
}

function PoForm({ onCancel, onCreated }: { onCancel: () => void; onCreated: (id: string) => void }) {
  const { me } = useSession();
  const sup = useResource<{ items: SupplierOption[] }>('/api/v1/supplier-options');
  const cons = useResource<{ items: { id: string; title: string }[] }>('/api/v1/contracts');
  const [f, setF] = useState({ companyId: me?.companies[0]?.id ?? '', supplierId: '', contractVersionId: '', currency: 'TRY' });
  const blank = { kind: 'GOODS', description: '', unit: '', quantity: '', unitPrice: '', taxRate: '20' };
  const [lines, setLines] = useState([blank]);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const set = (i: number, k: keyof typeof blank, v: string) => setLines(lines.map((x, j) => j === i ? { ...x, [k]: v } : x));
  return (
    <form className="panel mb-5" onSubmit={(e) => { e.preventDefault(); setBusy(true); setErr(null);
      void api<{ id: string }>('/api/v1/purchase-orders', { method: 'POST', json: { ...f, contractVersionId: f.contractVersionId || null, lines: lines.map((l) => ({ ...l, taxRate: l.taxRate.trim() || null })) } })
        .then((r) => onCreated(r.data.id), (x: ApiError) => setErr(x.message)).finally(() => setBusy(false)); }}>
      <div className="panel-head"><h2>Sipariş ver</h2><span className="text-sm text-ink-subtle">Tedarikçi aktif olmalı; sözleşmeli siparişte limit kilit altında kontrol edilir. Sözleşme limiti vergi dahilse KDV oranı zorunludur.</span></div>
      <div className="panel-body grid gap-3">
        <div className="grid grid-cols-4 gap-x-3 max-[900px]:grid-cols-2">
          <Field label="Şirket">{(p) => <select className="input" {...p} value={f.companyId} onChange={(e) => setF({ ...f, companyId: e.target.value })}>{me?.companies.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select>}</Field>
          <Field label="Tedarikçi" hint={supplierPickHint(sup.data?.items.find((s) => s.id === f.supplierId))}>{(p) => <select className="input" required {...p} value={f.supplierId} onChange={(e) => setF({ ...f, supplierId: e.target.value })}><option value="">Seçin</option>{sup.data?.items.filter((s) => s.status === 'ACTIVE').map((s) => <option key={s.id} value={s.id}>{s.label ?? s.legalName}</option>)}</select>}</Field>
          <Field label="Sözleşme (varsa)">{(p) => <select className="input" {...p} value={f.contractVersionId} onChange={(e) => setF({ ...f, contractVersionId: e.target.value })}><option value="">Sözleşmesiz</option>{cons.data?.items.map((c) => <option key={c.id} value={c.id}>{c.title}</option>)}</select>}</Field>
          <Field label="Para birimi">{(p) => <input className="input" maxLength={3} {...p} value={f.currency} onChange={(e) => setF({ ...f, currency: e.target.value.toUpperCase() })} />}</Field>
        </div>
        {lines.map((l, i) => (
          <div key={i} className="grid grid-cols-[110px_minmax(0,1fr)_100px_90px_130px_90px_auto] items-start gap-3 max-[900px]:grid-cols-2">
            <Field label="Tür">{(p) => <select className="input" {...p} value={l.kind} onChange={(e) => set(i, 'kind', e.target.value)}><option value="GOODS">Mal</option><option value="SERVICE">Hizmet</option></select>}</Field>
            <Field label={`Kalem ${i + 1}`}>{(p) => <input className="input" required {...p} value={l.description} onChange={(e) => set(i, 'description', e.target.value)} />}</Field>
            <Field label="Miktar">{(p) => <input className="input tabular text-right" required inputMode="decimal" {...p} value={l.quantity} onChange={(e) => set(i, 'quantity', e.target.value.replace(',', '.'))} />}</Field>
            <Field label="Birim">{(p) => <input className="input" required {...p} value={l.unit} onChange={(e) => set(i, 'unit', e.target.value)} />}</Field>
            <Field label="Birim fiyat">{(p) => <input className="input tabular text-right" required inputMode="decimal" {...p} value={l.unitPrice} onChange={(e) => set(i, 'unitPrice', e.target.value.replace(',', '.'))} />}</Field>
            <Field label="KDV %">{(p) => <input className="input tabular text-right" inputMode="decimal" {...p} value={l.taxRate} onChange={(e) => set(i, 'taxRate', e.target.value.replace(',', '.'))} />}</Field>
            <Button type="button" variant="ghost" size="sm" className="mt-6" disabled={lines.length === 1} onClick={() => setLines(lines.filter((_, j) => j !== i))} aria-label={`Kalem ${i + 1} sil`}><Icon name="close" /></Button>
          </div>
        ))}
        <div className="flex flex-wrap gap-2">
          <Button type="button" variant="outline" onClick={() => setLines([...lines, blank])}>Kalem ekle</Button>
          <Button type="submit" disabled={busy}>Siparişi kaydet</Button><Button type="button" variant="ghost" onClick={onCancel}>Vazgeç</Button>
        </div>
        {err && <Banner tone="danger" title={err} />}
      </div>
    </form>
  );
}

const PO_STATUS: Record<string, string> = { OPEN: 'Açık', CLOSED: 'Kapatıldı', CANCELLED: 'İptal edildi' };
interface PoDetail {
  po: { id: string; code: string; currency: string; status: string; closeReason: string | null; issuedAt: string; supplierName: string; contractVersionId: string | null; contractTitle: string | null; issuedBy: string };
  lines: { poLineId: string; description: string; unit: string; kind: string; orderedQty: string; unitPrice: string; receivedQty: string; invoicedQty: string; originalQty: string; originalUnitPrice: string; revision: number; addedByChange: boolean }[];
  receipts: { id: string; poLineId: string; quantity: string; periodFrom: string | null; periodTo: string | null; reversesId: string | null; note: string; recordedAt: string; recordedBy: string }[];
  changes: { changeNo: number; kind: 'CHANGE' | 'CLOSE' | 'CANCEL'; reason: string; changedAt: string; changedBy: string;
    details: { delta?: string; released?: string; pendingInvoices?: number; changed?: { lineNo: number; description: string; before: { quantity: string; unitPrice: string }; after: { quantity: string; unitPrice: string } }[];
      added?: { description: string; quantity: string; unit: string; unitPrice: string }[] } }[];
  changeNo: number;
  can: { receive: boolean; change: boolean };
}

export function PurchaseOrderPage() {
  const { id } = useParams();
  const r = useResource<PoDetail>(`/api/v1/purchase-orders/${id}`);
  const a = useAct(r.reload);
  const [form, setForm] = useState<{ lineId: string; quantity: string; note: string; periodFrom: string; periodTo: string; reverseOf?: string } | null>(null);
  const [mode, setMode] = useState<'change' | 'close' | null>(null);
  if (r.loading && !r.data) return <div className="page"><Loading rows={5} /></div>;
  if (r.error || !r.data) return <div className="page"><ErrorState error={r.error} onRetry={r.reload} /></div>;
  const d = r.data;
  const isOpen = d.po.status === 'OPEN';
  return (
    <div className="page">
      <p className="text-sm text-ink-subtle"><Link to="/siparisler" className="text-ink-subtle">Siparişler</Link> / {d.po.code}</p>
      <PageHeader title={`${d.po.code} · ${d.po.supplierName}`} actions={d.can.change && isOpen && !mode && <div className="flex flex-wrap gap-2">
        <Button variant="outline" onClick={() => { setForm(null); a.clear(); setMode('change'); }}><Icon name="pen" />Siparişi değiştir</Button>
        <Button variant="outline" onClick={() => { setForm(null); a.clear(); setMode('close'); }}>Kapat / iptal et</Button></div>}>{d.po.contractTitle ? <>Sözleşme: <Link to={`/sozlesmeler/${d.po.contractVersionId}?sekme=kosullar`}>{d.po.contractTitle}</Link></> : 'Sözleşmesiz sipariş'} · {d.po.issuedBy} · {fmtDateTime(d.po.issuedAt)}</PageHeader>
      {!isOpen && <Banner tone="neutral" icon="lock" title={`Sipariş ${PO_STATUS[d.po.status]!.toLocaleLowerCase('tr-TR')}`}>
        <span className="block">Gerekçe: {d.po.closeReason}</span>
        {d.po.status === 'CLOSED' ? `Kalemler kabul edilen/faturalanan miktara indirildi${d.po.contractTitle ? '; kalan taahhüt sözleşme limitine geri döndü' : ''}. Yeni kabul kaydedilemez.` : `Sipariş iptal edildi${d.po.contractTitle ? ', açık taahhüt sıfırlandı' : ''}; bu siparişe fatura bağlanamaz.`}</Banner>}
      {mode === 'change' && <PoChangeForm d={d} onDone={() => { setMode(null); void r.reload(); }} />}
      {mode === 'close' && <PoCloseForm d={d} onDone={() => { setMode(null); void r.reload(); }} />}
      <Table>
        <TableHeader><TableRow className="hover:bg-transparent"><TableHead>Kalem</TableHead><TableHead className="text-right">Sipariş</TableHead><TableHead className="text-right">Birim fiyat</TableHead>
          <TableHead className="text-right">Kabul (net)</TableHead><TableHead className="text-right">Faturalanan</TableHead><TableHead><span className="sr-only">Eylem</span></TableHead></TableRow></TableHeader>
        <TableBody>{d.lines.map((l) => {
          const open = Number(l.orderedQty) - Number(l.receivedQty);
          return (
            <TableRow key={l.poLineId}>
              <TableCell className="min-w-[200px]"><span className="font-semibold">{l.description}</span><span className="block text-sm text-ink-subtle">{l.kind === 'SERVICE' ? 'Hizmet (dönem kabulü)' : 'Mal'}</span></TableCell>
              <TableCell className="whitespace-nowrap text-right">{num(l.orderedQty)} {l.unit}{l.addedByChange ? <span className="block text-sm text-ink-subtle">değişiklikle eklendi{Number(l.originalQty) !== Number(l.orderedQty) ? ` (${num(l.originalQty)})` : ''}</span>
                : l.revision > 0 && Number(l.originalQty) !== Number(l.orderedQty) && <span className="block text-sm text-ink-subtle">özgün {num(l.originalQty)}</span>}</TableCell>
              <TableCell className="whitespace-nowrap text-right">{fmtMoney(l.unitPrice, d.po.currency)}{!l.addedByChange && l.revision > 0 && Number(l.originalUnitPrice) !== Number(l.unitPrice) && <span className="block text-sm text-ink-subtle">özgün {fmtMoney(l.originalUnitPrice, d.po.currency)}</span>}</TableCell>
              <TableCell className={cn('whitespace-nowrap text-right', open > 0 && 'text-warn')}>{num(l.receivedQty)} {l.unit}</TableCell>
              <TableCell className="whitespace-nowrap text-right">{num(l.invoicedQty)} {l.unit}</TableCell>
              <TableCell>{d.can.receive && isOpen && open > 0 && <Button size="sm" variant="outline" onClick={() => setForm({ lineId: l.poLineId, quantity: String(open), note: '', periodFrom: '', periodTo: '' })}>Kabul kaydet</Button>}</TableCell>
            </TableRow>
          );
        })}</TableBody>
      </Table>
      {form && (
        <form className="panel mt-4 max-w-[640px]" onSubmit={(e) => { e.preventDefault(); void a.run(() => form.reverseOf
          ? api(`/api/v1/receipts/${form.reverseOf}/reverse`, { method: 'POST', json: { quantity: form.quantity, note: form.note } })
          : api(`/api/v1/po-lines/${form.lineId}/receipts`, { method: 'POST', json: { quantity: form.quantity, note: form.note, periodFrom: form.periodFrom || null, periodTo: form.periodTo || null } }),
          form.reverseOf ? 'Ters kabul kaydedildi.' : 'Kabul kaydedildi.').then((ok) => ok && setForm(null)); }}>
          <div className="panel-head"><h2>{form.reverseOf ? 'Ters kabul' : 'Kabul kaydı'}: {d.lines.find((l) => l.poLineId === form.lineId)?.description}</h2></div>
          <div className="panel-body grid grid-cols-2 gap-x-4 max-[640px]:grid-cols-1">
            <Field label="Miktar">{(p) => <input className="input tabular text-right" inputMode="decimal" {...p} value={form.quantity} onChange={(e) => setForm({ ...form, quantity: e.target.value.replace(',', '.') })} />}</Field>
            <span />
            {!form.reverseOf && d.lines.find((l) => l.poLineId === form.lineId)?.kind === 'SERVICE' && <>
              <Field label="Dönem başı">{(p) => <input className="input" type="date" {...p} value={form.periodFrom} onChange={(e) => setForm({ ...form, periodFrom: e.target.value })} />}</Field>
              <Field label="Dönem sonu">{(p) => <input className="input" type="date" {...p} value={form.periodTo} onChange={(e) => setForm({ ...form, periodTo: e.target.value })} />}</Field></>}
            <div className="col-span-full"><Field label={form.reverseOf ? 'Ters kabul nedeni' : 'Not'} hint="Ne teslim alındı veya neden geri alınıyor.">{(p) => <input className="input" {...p} value={form.note} onChange={(e) => setForm({ ...form, note: e.target.value })} />}</Field></div>
            <div className="col-span-full flex gap-2"><Button type="submit" disabled={a.busy}>Kaydet</Button><Button type="button" variant="outline" onClick={() => setForm(null)}>Vazgeç</Button></div>
          </div>
        </form>
      )}
      <section className="panel mt-5">
        <div className="panel-head"><h2>Kabul geçmişi</h2><span className="text-sm text-ink-subtle">Kayıtlar silinmez; düzeltme ters kabulle yapılır.</span></div>
        <div className="panel-body">{!d.receipts.length ? <p className="text-ink-muted">Henüz kabul yok.</p> : (
          <ol className="timeline">{d.receipts.map((x) => (
            <li key={x.id}><strong className={cn('tabular', Number(x.quantity) < 0 && 'text-danger')}>{Number(x.quantity) < 0 ? 'Ters kabul' : 'Kabul'} {num(x.quantity)} {d.lines.find((l) => l.poLineId === x.poLineId)?.unit} · {d.lines.find((l) => l.poLineId === x.poLineId)?.description}</strong>
              <span>{x.note}{x.periodFrom ? ` · dönem ${fmtDate(x.periodFrom)}–${fmtDate(x.periodTo)}` : ''}</span>
              <span className="subtle">{x.recordedBy} · {fmtDateTime(x.recordedAt)}{d.can.receive && isOpen && Number(x.quantity) > 0 && <> · <button type="button" className="underline" onClick={() => setForm({ lineId: x.poLineId, quantity: '', note: '', periodFrom: '', periodTo: '', reverseOf: x.id })}>Ters kabul</button></>}</span></li>
          ))}</ol>)}</div>
      </section>
      {d.changes.length > 0 && (
        <section className="panel mt-5">
          <div className="panel-head"><h2>Değişiklik geçmişi</h2><span className="text-sm text-ink-subtle">Özgün kalemler korunur; her değişiklik gerekçesiyle kayıtlıdır.</span></div>
          <div className="panel-body"><ol className="timeline">{d.changes.map((c) => (
            <li key={c.changeNo}><strong>{c.kind === 'CHANGE' ? `Değişiklik ${c.changeNo}` : c.kind === 'CLOSE' ? 'Kapatıldı' : 'İptal edildi'}
              {c.details.delta ? ` · tutar farkı ${Number(c.details.delta) > 0 ? '+' : ''}${fmtMoney(c.details.delta, d.po.currency)}` : ''}{c.details.released ? ` · serbest kalan ${fmtMoney(c.details.released, d.po.currency)}` : ''}</strong>
              {(c.details.changed ?? []).map((x) => <span key={x.lineNo} className="tabular">{x.lineNo}. {x.description}: {num(x.before.quantity)} × {fmtMoney(x.before.unitPrice, d.po.currency)} → {num(x.after.quantity)} × {fmtMoney(x.after.unitPrice, d.po.currency)}</span>)}
              {(c.details.added ?? []).map((x, i) => <span key={i} className="tabular">Yeni kalem: {x.description}, {num(x.quantity)} {x.unit} × {fmtMoney(x.unitPrice, d.po.currency)}</span>)}
              {!!c.details.pendingInvoices && <span className="text-warn">Bu siparişe bağlı {c.details.pendingInvoices} karar bekleyen fatura vardı; kontrolleri yeniden çalışır.</span>}
              <span>{c.reason}</span><span className="subtle">{c.changedBy} · {fmtDateTime(c.changedAt)}</span></li>
          ))}</ol></div>
        </section>
      )}
      {a.feedback}
    </div>
  );
}

function PoChangeForm({ d, onDone }: { d: PoDetail; onDone: () => void }) {
  const [rows, setRows] = useState(d.lines.map((l) => ({ poLineId: l.poLineId, quantity: l.orderedQty, unitPrice: l.unitPrice })));
  const blank = { kind: 'GOODS', description: '', unit: '', quantity: '', unitPrice: '', taxRate: '20' };
  const [added, setAdded] = useState<typeof blank[]>([]);
  const [reason, setReason] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const changed = rows.filter((x) => { const l = d.lines.find((y) => y.poLineId === x.poLineId)!; return Number(x.quantity) !== Number(l.orderedQty) || Number(x.unitPrice) !== Number(l.unitPrice); });
  const delta = [...changed.map((x) => { const l = d.lines.find((y) => y.poLineId === x.poLineId)!; return Number(x.quantity) * Number(x.unitPrice) - Number(l.orderedQty) * Number(l.unitPrice); }),
    ...added.map((x) => Number(x.quantity) * Number(x.unitPrice))].reduce((a, b) => a + (Number.isFinite(b) ? b : 0), 0);
  const belowFloor = rows.filter((x) => { const l = d.lines.find((y) => y.poLineId === x.poLineId)!; return Number(x.quantity) < Math.max(Number(l.receivedQty), Number(l.invoicedQty)); });
  const setAdd = (i: number, k: keyof typeof blank, v: string) => setAdded(added.map((x, j) => j === i ? { ...x, [k]: v } : x));
  return (
    <form className="panel mb-5" onSubmit={(e) => { e.preventDefault(); setBusy(true); setErr(null);
      void api(`/api/v1/purchase-orders/${d.po.id}/changes`, { method: 'POST', json: { baseChangeNo: d.changeNo, reason, lines: changed, add: added.map((l) => ({ ...l, taxRate: l.taxRate.trim() || null })) } })
        .then(onDone, (x: ApiError) => setErr(x.message)).finally(() => setBusy(false)); }}>
      <div className="panel-head"><h2>Siparişi değiştir</h2><span className="text-sm text-ink-subtle">Miktar kabul edilen/faturalanan miktarın altına inemez; faturalanmış kalemin fiyatı değişmez.</span></div>
      <div className="panel-body grid gap-3">
        {d.lines.map((l, i) => {
          const floor = Math.max(Number(l.receivedQty), Number(l.invoicedQty));
          return (
            <div key={l.poLineId} className="grid grid-cols-[minmax(0,1fr)_120px_140px] items-start gap-3 max-[640px]:grid-cols-2">
              <div className="pt-6"><span className="font-semibold">{l.description}</span>{floor > 0 && <span className="block text-sm text-ink-subtle">En az {num(String(floor))} {l.unit}</span>}</div>
              <Field label={`${l.description} miktar`} error={Number(rows[i]!.quantity) < floor ? `En az ${num(String(floor))} ${l.unit}` : null}>{(p) => <input className="input tabular text-right" inputMode="decimal" {...p} value={rows[i]!.quantity} onChange={(e) => setRows(rows.map((x, j) => j === i ? { ...x, quantity: e.target.value.replace(',', '.') } : x))} />}</Field>
              <Field label={`${l.description} birim fiyat`} hint={Number(l.invoicedQty) > 0 ? 'Faturalandı; fiyat sabit.' : undefined}>{(p) => <input className="input tabular text-right" inputMode="decimal" disabled={Number(l.invoicedQty) > 0} {...p} value={rows[i]!.unitPrice} onChange={(e) => setRows(rows.map((x, j) => j === i ? { ...x, unitPrice: e.target.value.replace(',', '.') } : x))} />}</Field>
            </div>
          );
        })}
        {added.map((l, i) => (
          <div key={i} className="grid grid-cols-[110px_minmax(0,1fr)_100px_90px_130px_90px_auto] items-start gap-3 max-[900px]:grid-cols-2">
            <Field label="Tür">{(p) => <select className="input" {...p} value={l.kind} onChange={(e) => setAdd(i, 'kind', e.target.value)}><option value="GOODS">Mal</option><option value="SERVICE">Hizmet</option></select>}</Field>
            <Field label={`Yeni kalem ${i + 1}`}>{(p) => <input className="input" required {...p} value={l.description} onChange={(e) => setAdd(i, 'description', e.target.value)} />}</Field>
            <Field label="Miktar">{(p) => <input className="input tabular text-right" required inputMode="decimal" {...p} value={l.quantity} onChange={(e) => setAdd(i, 'quantity', e.target.value.replace(',', '.'))} />}</Field>
            <Field label="Birim">{(p) => <input className="input" required {...p} value={l.unit} onChange={(e) => setAdd(i, 'unit', e.target.value)} />}</Field>
            <Field label="Birim fiyat">{(p) => <input className="input tabular text-right" required inputMode="decimal" {...p} value={l.unitPrice} onChange={(e) => setAdd(i, 'unitPrice', e.target.value.replace(',', '.'))} />}</Field>
            <Field label="KDV %">{(p) => <input className="input tabular text-right" inputMode="decimal" {...p} value={l.taxRate} onChange={(e) => setAdd(i, 'taxRate', e.target.value.replace(',', '.'))} />}</Field>
            <Button type="button" variant="ghost" size="sm" className="mt-6" onClick={() => setAdded(added.filter((_, j) => j !== i))} aria-label={`Yeni kalem ${i + 1} sil`}><Icon name="close" /></Button>
          </div>
        ))}
        <Field label="Değişiklik gerekçesi" hint="Kim istedi, neden; denetim kaydına yazılır.">{(p) => <textarea className="input" rows={2} required minLength={10} {...p} value={reason} onChange={(e) => setReason(e.target.value)} />}</Field>
        <p className="tabular text-sm text-ink-muted">Tutar farkı (yaklaşık): {delta >= 0 ? '+' : ''}{fmtMoney(delta.toFixed(2), d.po.currency)}{d.po.contractTitle && delta > 0 ? ' · sözleşme limitinden kilit altında düşülür' : ''}</p>
        <div className="flex flex-wrap gap-2">
          <Button type="button" variant="outline" onClick={() => setAdded([...added, blank])}>Kalem ekle</Button>
          <Button type="submit" disabled={busy || (!changed.length && !added.length) || reason.trim().length < 10 || belowFloor.length > 0}>Değişikliği kaydet</Button>
          <Button type="button" variant="ghost" onClick={onDone}>Vazgeç</Button>
        </div>
        {err && <Banner tone="danger" title={err} />}
      </div>
    </form>
  );
}

function PoCloseForm({ d, onDone }: { d: PoDetail; onDone: () => void }) {
  const [reason, setReason] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const consumed = d.lines.some((l) => Number(l.receivedQty) > 0 || Number(l.invoicedQty) > 0);
  return (
    <form className="panel mb-5 max-w-[720px]" onSubmit={(e) => { e.preventDefault(); setBusy(true); setErr(null);
      void api(`/api/v1/purchase-orders/${d.po.id}/close`, { method: 'POST', json: { baseChangeNo: d.changeNo, reason } })
        .then(onDone, (x: ApiError) => setErr(x.message)).finally(() => setBusy(false)); }}>
      <div className="panel-head"><h2>{consumed ? 'Siparişi kapat' : 'Siparişi iptal et'}</h2></div>
      <div className="panel-body grid gap-3">
        <p className="text-ink-muted">{consumed
          ? `Kabul veya fatura olduğu için sipariş iptal edilmez, kapatılır: her kalem kabul edilen/faturalanan miktara iner${d.po.contractTitle ? ' ve kalan taahhüt sözleşme limitine geri döner' : ''}. Sonra yeni kabul kaydedilemez.`
          : `Kabul ve onaylı fatura yok; sipariş iptal edilir${d.po.contractTitle ? ' ve açık taahhüt sıfırlanır' : ''}. Bu siparişe fatura bağlanamaz.`} Kayıtlar silinmez.</p>
        <Field label="Gerekçe">{(p) => <textarea className="input" rows={2} required minLength={10} {...p} value={reason} onChange={(e) => setReason(e.target.value)} />}</Field>
        <div className="flex gap-2"><Button type="submit" variant="destructive" disabled={busy || reason.trim().length < 10}>{consumed ? 'Kapat' : 'İptal et'}</Button><Button type="button" variant="ghost" onClick={onDone}>Vazgeç</Button></div>
        {err && <Banner tone="danger" title={err} />}
      </div>
    </form>
  );
}

// --- Faturalar ------------------------------------------------------------------------------------

const KIND = { INVOICE: 'Fatura', CREDIT_NOTE: 'İade / alacak', ADVANCE: 'Avans' } as const;
const STATUS: Record<string, { text: string; tone: 'human' | 'ok' | 'warn' | 'danger' | 'info' | 'neutral'; icon: string }> = {
  APPROVAL: { text: 'Finans onaylı', tone: 'human', icon: 'stamp' }, REJECTION: { text: 'Reddedildi', tone: 'neutral', icon: 'x' },
  READY: { text: 'Onaya hazır', tone: 'ok', icon: 'check' }, NEEDS_EXCEPTION: { text: 'İstisna gerekli', tone: 'warn', icon: 'alert' },
  EXCEPTION_APPROVED: { text: 'İstisna onaylı, finans onayı bekliyor', tone: 'info', icon: 'clock' }, BLOCKED: { text: 'Engelli', tone: 'danger', icon: 'x' },
};
const ERP: Record<string, string> = { PENDING: 'ERP: aktarım bekliyor', UNKNOWN: 'ERP: belirsiz (zaman aşımı) — sorgulanacak', CONFIRMED: 'ERP: aktarıldı', FAILED: 'ERP: hata', NOT_CONFIGURED: 'ERP bağlantısı yapılandırılmadı' };

export function InvoicesPage() {
  const { me } = useSession();
  const navigate = useNavigate();
  const r = useResource<{ items: { id: string; kind: keyof typeof KIND; invoiceNo: string; issueDate: string; currency: string; supplierName: string; supplierStatus: string; supplierIdentityVerified: boolean; netAmount: string; legalStatus: string; paymentStatus: string; decision: string | null; erpStatus: string | null; duplicateCount: number }[] }>('/api/v1/invoices');
  const [creating, setCreating] = useState(false);
  // Süzgeç ve kolonlar URL'de (kayıtlı görünüm ve paylaşılabilir bağlantı); yetki ve kapsam sunucuda.
  const [params, setParams] = useSearchParams();
  const durum = params.get('durum') ?? '';
  const para = params.get('para') ?? '';
  const hidden = new Set((params.get('gizle') ?? '').split(',').filter(Boolean));
  const setParam = (k: string, v: string) => { const p = new URLSearchParams(params); v ? p.set(k, v) : p.delete(k); setParams(p, { replace: true }); };
  const toggleCol = (c: string) => { const n = new Set(hidden); n.has(c) ? n.delete(c) : n.add(c); setParam('gizle', [...n].sort().join(',')); };
  const all = r.data?.items ?? [];
  const stateOf = (x: (typeof all)[number]) => x.legalStatus !== 'RECEIVED' ? 'IPTAL' : x.decision === 'APPROVAL' || x.decision === 'REJECTION' ? x.decision : 'BEKLIYOR';
  const items = all.filter((x) => (!durum || stateOf(x) === durum) && (!para || x.currency === para));
  const currencies = [...new Set(all.map((x) => x.currency))].sort();
  const COLS = [['tedarikci', 'Tedarikçi'], ['erp', 'ERP / ödeme'], ['tarih', 'Tarih']] as const;
  const show = (c: string) => !hidden.has(c);
  return (
    <div className="page">
      <PageHeader title="Faturalar" actions={<div className="flex flex-wrap gap-2">
        <Button variant="outline" asChild><Link to="/faturalar/tolerans">Tolerans kuralları</Link></Button>
        {hasRole(me, 'FINANCE', 'AUDITOR') && <Button variant="outline" asChild><Link to="/faturalar/erp-mutabakati">ERP mutabakatı</Link></Button>}
        {hasRole(me, 'FINANCE') && <Button onClick={() => setCreating(true)}><Icon name="receipt" />Fatura gir</Button>}</div>}>
        Satır tahsisi, sipariş/kabul eşleştirmesi ve limit kontrolü. Hukuki e-belge durumu, kurum içi onay, ERP aktarımı ve ödeme ayrı durumlardır; ödeme bu sistemden yürütülmez.
      </PageHeader>
      {creating && <InvoiceForm onCancel={() => setCreating(false)} onCreated={(id) => navigate(`/faturalar/${id}`)} />}
      <SavedViews page="invoices" />
      <div className="mb-3 flex flex-wrap items-end gap-3">
        <div className="flex flex-wrap gap-2" role="group" aria-label="Onay durumu süzgeci">
          {([['', 'Tümü'], ['BEKLIYOR', 'Karar bekliyor'], ['APPROVAL', 'Onaylandı'], ['REJECTION', 'Reddedildi'], ['IPTAL', 'Hukuken iptal/ret']] as const).map(([k, l]) =>
            <FilterChip key={k} pressed={durum === k} count={k ? all.filter((x) => stateOf(x) === k).length : all.length} onClick={() => setParam('durum', k)}>{l}</FilterChip>)}
        </div>
        {currencies.length > 1 && <label className="flex items-center gap-2 text-sm">Para birimi
          <select className="input h-8 w-24" value={para} onChange={(e) => setParam('para', e.target.value)}><option value="">Tümü</option>{currencies.map((c) => <option key={c} value={c}>{c}</option>)}</select></label>}
        <fieldset className="flex flex-wrap items-center gap-3 text-sm"><legend className="sr-only">Kolonlar</legend><span className="text-ink-subtle">Kolonlar:</span>
          {COLS.map(([k, l]) => <label key={k} className="flex items-center gap-1.5"><input type="checkbox" className="accent-[var(--ink)]" aria-label={`${l} kolonunu göster`} checked={show(k)} onChange={() => toggleCol(k)} />{l}</label>)}
        </fieldset>
      </div>
      {r.loading && !r.data ? <Loading /> : r.error ? <ErrorState error={r.error} onRetry={r.reload} /> : !items.length ? (
        <div className="rounded-md border border-border bg-surface"><Empty icon="receipt" title={all.length ? 'Süzgece uyan fatura yok' : 'Fatura yok'}>{all.length ? 'Süzgeci değiştirin veya “Tümü”nü seçin.' : 'e-Fatura girişi veya elle giriş sonrası burada görünür.'}</Empty></div>
      ) : (
        <Table>
          <TableHeader><TableRow className="hover:bg-transparent"><TableHead>Fatura no</TableHead>{show('tedarikci') && <TableHead>Tedarikçi</TableHead>}<TableHead className="text-right">Net</TableHead>
            <TableHead>Onay</TableHead>{show('erp') && <TableHead className="max-[900px]:hidden">ERP / ödeme</TableHead>}{show('tarih') && <TableHead>Tarih</TableHead>}</TableRow></TableHeader>
          <TableBody>{items.map((x) => (
            <TableRow key={x.id}>
              <TableCell className="whitespace-nowrap"><Link className="font-semibold text-ink no-underline hover:underline" to={`/faturalar/${x.id}`}>{x.invoiceNo}</Link>
                <span className="block text-sm text-ink-subtle">{KIND[x.kind]}{x.duplicateCount > 0 ? ` · ${x.duplicateCount} tekrar geliş` : ''}</span></TableCell>
              {show('tedarikci') && <TableCell>{x.supplierName}{supplierRecordNote(x.supplierStatus, x.supplierIdentityVerified) && <span className="block text-sm text-warn">{supplierRecordNote(x.supplierStatus, x.supplierIdentityVerified)}</span>}</TableCell>}
              <TableCell className="whitespace-nowrap text-right">{fmtMoney(x.netAmount, x.currency)}</TableCell>
              <TableCell>{x.legalStatus !== 'RECEIVED' ? <Tag label={{ text: 'Hukuken iptal/ret', tone: 'danger', icon: 'x' }} /> : x.decision ? <Tag label={STATUS[x.decision]} /> : <span className="text-sm text-ink-subtle">Bekliyor</span>}</TableCell>
              {show('erp') && <TableCell className="text-sm text-ink-muted max-[900px]:hidden">{x.erpStatus ? ERP[x.erpStatus] : '—'}{x.paymentStatus === 'PAID' ? ' · ödendi (ERP)' : ''}</TableCell>}
              {show('tarih') && <TableCell className="whitespace-nowrap text-sm text-ink-subtle">{fmtDate(x.issueDate)}</TableCell>}
            </TableRow>
          ))}</TableBody>
        </Table>
      )}
    </div>
  );
}

function InvoiceForm({ onCancel, onCreated }: { onCancel: () => void; onCreated: (id: string) => void }) {
  const { me } = useSession();
  const sup = useResource<{ items: SupplierOption[] }>('/api/v1/supplier-options');
  const [f, setF] = useState({ companyId: me?.companies[0]?.id ?? '', supplierId: '', kind: 'INVOICE', invoiceNo: '', ettn: '', issueDate: '', currency: 'TRY', originalInvoiceId: '' });
  const [lines, setLines] = useState([{ description: '', quantity: '', unit: '', unitPrice: '', taxRate: '20' }]);
  const [declared, setDeclared] = useState({ declaredTaxTotal: '', declaredWithholding: '', declaredPayable: '' });
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const net = (l: { quantity: string; unitPrice: string }) => (Number(l.quantity) * Number(l.unitPrice) || 0).toFixed(2);
  return (
    <form className="panel mb-5" onSubmit={(e) => { e.preventDefault(); setBusy(true); setErr(null);
      void api<{ id: string; duplicate: boolean }>('/api/v1/invoices', { method: 'POST', json: { ...f, ettn: f.ettn || null, originalInvoiceId: f.kind === 'CREDIT_NOTE' ? f.originalInvoiceId || null : null,
        declaredTaxTotal: declared.declaredTaxTotal || null, declaredWithholding: declared.declaredWithholding || null, declaredPayable: declared.declaredPayable || null,
        lines: lines.map((l) => ({ ...l, netAmount: net(l) })) } }).then((r) => onCreated(r.data.id), (x: ApiError) => setErr(x.message)).finally(() => setBusy(false)); }}>
      <div className="panel-head"><h2>Fatura gir</h2><span className="text-sm text-ink-subtle">Aynı tedarikçi için aynı ETTN veya fatura no ikinci kayıt açmaz.</span></div>
      <div className="panel-body grid gap-3">
        <div className="grid grid-cols-4 gap-x-3 max-[900px]:grid-cols-2">
          <Field label="Şirket">{(p) => <select className="input" {...p} value={f.companyId} onChange={(e) => setF({ ...f, companyId: e.target.value })}>{me?.companies.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select>}</Field>
          <Field label="Tedarikçi" hint={supplierPickHint(sup.data?.items.find((s) => s.id === f.supplierId))}>{(p) => <select className="input" required {...p} value={f.supplierId} onChange={(e) => setF({ ...f, supplierId: e.target.value })}><option value="">Seçin</option>{sup.data?.items.map((s) => <option key={s.id} value={s.id}>{s.label ?? s.legalName}</option>)}</select>}</Field>
          <Field label="Tür">{(p) => <select className="input" {...p} value={f.kind} onChange={(e) => setF({ ...f, kind: e.target.value })}>{Object.entries(KIND).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select>}</Field>
          <Field label="Fatura no">{(p) => <input className="input" required {...p} value={f.invoiceNo} onChange={(e) => setF({ ...f, invoiceNo: e.target.value })} />}</Field>
          <Field label="ETTN (varsa)">{(p) => <input className="input mono" {...p} value={f.ettn} onChange={(e) => setF({ ...f, ettn: e.target.value })} />}</Field>
          <Field label="Fatura tarihi">{(p) => <input className="input" type="date" required {...p} value={f.issueDate} onChange={(e) => setF({ ...f, issueDate: e.target.value })} />}</Field>
          <Field label="Para birimi">{(p) => <input className="input" maxLength={3} {...p} value={f.currency} onChange={(e) => setF({ ...f, currency: e.target.value.toUpperCase() })} />}</Field>
          {f.kind === 'CREDIT_NOTE' && <Field label="Özgün fatura kimliği">{(p) => <input className="input mono" {...p} value={f.originalInvoiceId} onChange={(e) => setF({ ...f, originalInvoiceId: e.target.value })} />}</Field>}
        </div>
        {lines.map((l, i) => (
          <div key={i} className="grid grid-cols-[minmax(0,1fr)_100px_90px_130px_80px_120px_auto] items-start gap-3 max-[1200px]:grid-cols-3">
            <div className="max-[1200px]:col-span-full"><Field label={`Satır ${i + 1}`}>{(p) => <input className="input" required {...p} value={l.description} onChange={(e) => setLines(lines.map((x, j) => j === i ? { ...x, description: e.target.value } : x))} />}</Field></div>
            <Field label="Miktar">{(p) => <input className="input tabular text-right" required inputMode="decimal" {...p} value={l.quantity} onChange={(e) => setLines(lines.map((x, j) => j === i ? { ...x, quantity: e.target.value.replace(',', '.') } : x))} />}</Field>
            <Field label="Birim">{(p) => <input className="input" required {...p} value={l.unit} onChange={(e) => setLines(lines.map((x, j) => j === i ? { ...x, unit: e.target.value } : x))} />}</Field>
            <Field label="Birim fiyat">{(p) => <input className="input tabular text-right" required inputMode="decimal" {...p} value={l.unitPrice} onChange={(e) => setLines(lines.map((x, j) => j === i ? { ...x, unitPrice: e.target.value.replace(',', '.') } : x))} />}</Field>
            <Field label="KDV %">{(p) => <input className="input tabular text-right" required inputMode="decimal" {...p} value={l.taxRate} onChange={(e) => setLines(lines.map((x, j) => j === i ? { ...x, taxRate: e.target.value.replace(',', '.') } : x))} />}</Field>
            <div className="field"><span className="text-sm font-semibold">Net</span><span className="tabular min-h-[34px] py-1.5 text-right">{fmtMoney(net(l), f.currency)}</span></div>
            <Button type="button" variant="ghost" size="sm" className="mt-6" disabled={lines.length === 1} onClick={() => setLines(lines.filter((_, j) => j !== i))} aria-label={`Satır ${i + 1} sil`}><Icon name="close" /></Button>
          </div>
        ))}
        <div className="flex flex-wrap gap-2">
          <Button type="button" variant="outline" onClick={() => setLines([...lines, { description: '', quantity: '', unit: '', unitPrice: '', taxRate: '20' }])}>Satır ekle</Button>
        </div>
        <div className="grid grid-cols-3 items-start gap-x-3 max-[900px]:grid-cols-1">
          <Field label="Belgedeki KDV toplamı" hint="Belgede yazanı girin; satırlarla karşılaştırılır.">{(p) => <input className="input tabular text-right" inputMode="decimal" {...p} value={declared.declaredTaxTotal} onChange={(e) => setDeclared({ ...declared, declaredTaxTotal: e.target.value.replace(',', '.') })} />}</Field>
          <Field label="Tevkifat (varsa)">{(p) => <input className="input tabular text-right" inputMode="decimal" {...p} value={declared.declaredWithholding} onChange={(e) => setDeclared({ ...declared, declaredWithholding: e.target.value.replace(',', '.') })} />}</Field>
          <Field label="Belgedeki ödenecek tutar">{(p) => <input className="input tabular text-right" inputMode="decimal" {...p} value={declared.declaredPayable} onChange={(e) => setDeclared({ ...declared, declaredPayable: e.target.value.replace(',', '.') })} />}</Field>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button type="submit" disabled={busy}>Faturayı kaydet</Button><Button type="button" variant="ghost" onClick={onCancel}>Vazgeç</Button>
        </div>
        {err && <Banner tone="danger" title={err} />}
      </div>
    </form>
  );
}

/** GİB vergi türü kodları (yalnız görünüm). */
const TAX_CODE: Record<string, string> = { '4080': 'ÖİV', '4081': 'ÖİV (5035)', '0071': 'ÖTV (I sayılı liste)', '0073': 'ÖTV (III sayılı liste)', '0074': 'ÖTV (IV sayılı liste)', '0075': 'ÖTV (III sayılı liste)', '0076': 'ÖTV (II sayılı liste)', '0077': 'ÖTV (II sayılı liste)', '1047': 'Damga vergisi', '9021': 'Konaklama vergisi' };

interface InvDetail {
  invoice: { id: string; kind: keyof typeof KIND; invoiceNo: string; ettn: string | null; issueDate: string; currency: string; supplierId: string; supplierName: string; supplierStatus: string; supplierIdentityVerified: boolean;
    legalStatus: string; paymentStatus: string; documentVersionId: string | null; declaredTaxTotal: string | null; declaredWithholding: string | null; declaredPayable: string | null; originalInvoiceId: string | null; advanceInvoiceId: string | null; advanceOffset: string; createdByMe: boolean; createdBy: string; createdAt: string };
  lines: { lineNo: number; description: string; quantity: string; unit: string; unitPrice: string; netAmount: string; taxRate: string; taxAmount: string | null;
    otherTax: string | null; otherTaxes: { code: string | null; name: string | null; rate: string | null; amount: string }[] | null }[];
  allocations: { lineNo: number; poLineId: string | null; contractVersionId: string | null; quantity: string; amount: string; poId: string | null; poCode: string | null; poLineDescription: string | null; contractTitle: string | null }[];
  decisions: { kind: string; reason: string | null; decidedAt: string; decidedBy: string }[];
  intake: { source: string; duplicate: boolean; receivedAt: string }[];
  erp: null | { status: string; externalId: string | null; attempts: number; lastError: string | null; updatedAt: string };
  check: { issues: { code: string; severity: string; message: string; ownerRole: string; lineNo?: number }[]; canApprove: boolean; needsException: boolean; netAmount: string; payable: string; taxTotal: string; otherTaxTotal: string; grossAmount: string };
  contracts: { contractVersionId: string; title: string; currency: string; ceiling: string | null; netConsumption: string; openCommitment: string }[];
  status: string; exceptionCurrent: boolean | null; checkFingerprint: string;
  can: { manage: boolean; approve: boolean; approveException: boolean };
  ublCheck: UblCheck | null;
}
const SEV = { BLOCK: { text: 'Engel', tone: 'danger', icon: 'x' }, EXCEPTION: { text: 'İstisna', tone: 'warn', icon: 'alert' }, REVIEW: { text: 'İnceleme', tone: 'info', icon: 'help' } } as const;

export function InvoicePage() {
  const { id } = useParams();
  const r = useResource<InvDetail>(`/api/v1/invoices/${id}`);
  const a = useAct(r.reload);
  const [editing, setEditing] = useState(false);
  const [reason, setReason] = useState('');
  if (r.loading && !r.data) return <div className="page"><Loading rows={6} /></div>;
  if (r.error || !r.data) return <div className="page"><ErrorState error={r.error} onRetry={r.reload} /></div>;
  const d = r.data;
  const decided = d.decisions.some((x) => x.kind === 'APPROVAL' || x.kind === 'REJECTION');
  const issuesFor = (lineNo?: number) => d.check.issues.filter((x) => x.lineNo === lineNo);
  const supplierNote = supplierRecordNote(d.invoice.supplierStatus, d.invoice.supplierIdentityVerified);
  return (
    <div className="page">
      <p className="text-sm text-ink-subtle"><Link to="/faturalar" className="text-ink-subtle">Faturalar</Link> / {d.invoice.invoiceNo}</p>
      <div className="mb-4 mt-1 flex flex-wrap items-start gap-3">
        <h1 className="min-w-0 flex-1">{KIND[d.invoice.kind]} {d.invoice.invoiceNo} · {d.invoice.supplierName}</h1>
        <Tag label={STATUS[d.status]} />
      </div>
      <div className="mb-5 flex flex-wrap gap-x-6 gap-y-1 text-sm text-ink-muted">
        {supplierNote && <span className="text-warn">Tedarikçi: {supplierNote}</span>}
        <span>Tarih {fmtDate(d.invoice.issueDate)}</span>{d.invoice.ettn && <span className="mono">ETTN {d.invoice.ettn}</span>}
        <span>Hukuki durum: {d.invoice.legalStatus === 'RECEIVED' ? 'alındı' : 'iptal/ret'}</span>
        <span>{d.erp ? ERP[d.erp.status] : 'ERP: onaydan sonra'}</span><span>Ödeme: {d.invoice.paymentStatus === 'PAID' ? 'ödendi (ERP teyidi)' : 'ödenmedi'}</span>
        {d.intake.filter((x) => x.duplicate).length > 0 && <span className="text-warn">Bu fatura {d.intake.filter((x) => x.duplicate).length} kez tekrar geldi; yeni kayıt açılmadı.</span>}
      </div>
      <div className="grid grid-cols-[minmax(0,1fr)_380px] gap-6 max-[1100px]:grid-cols-1">
        <div className="grid content-start gap-5">
          <section className="panel">
            <div className="panel-head"><h2>Satırlar ve tahsis</h2>{d.can.manage && !decided && !editing && <Button size="sm" variant="outline" className="ml-auto" onClick={() => setEditing(true)}><Icon name="pen" />Tahsisi düzenle</Button>}</div>
            <div className="panel-body grid gap-4">
              {d.lines.map((l) => (
                <div key={l.lineNo} className="grid gap-1.5 border-b border-[#ebe6da] pb-3 last:border-b-0 last:pb-0">
                  <div className="flex flex-wrap justify-between gap-2"><span className="font-semibold">{l.lineNo}. {l.description}</span>
                    <span className="tabular">{num(l.quantity)} {l.unit} × {fmtMoney(l.unitPrice, d.invoice.currency)} = <span className="font-semibold">{fmtMoney(l.netAmount, d.invoice.currency)}</span>
                      <span className="block text-right text-sm text-ink-subtle">KDV %{num(l.taxRate)}{l.taxAmount ? ` · belgede ${fmtMoney(l.taxAmount, d.invoice.currency)}` : ''}</span>
                      {l.otherTaxes?.length ? l.otherTaxes.map((t, i) => (
                        <span key={i} className="block text-right text-sm text-ink-subtle">{t.name || TAX_CODE[t.code ?? ''] || t.code || 'KDV dışı vergi'} {t.rate ? `%${num(t.rate)}` : '(oransız, beyan)'} · {fmtMoney(t.amount, d.invoice.currency)}</span>))
                        : Number(l.otherTax) > 0 && <span className="block text-right text-sm text-ink-subtle">KDV dışı vergiler (kalem ayrımı yok) · {fmtMoney(l.otherTax, d.invoice.currency)}</span>}</span></div>
                  {d.allocations.filter((x) => x.lineNo === l.lineNo).map((x, i) => (
                    <p key={i} className="flex flex-wrap gap-x-2 text-sm text-ink-muted"><Icon name="arrow" size={14} className="mt-0.5" />
                      {x.poCode ? <>Sipariş <Link to={`/siparisler/${x.poId}`}>{x.poCode}</Link> · {x.poLineDescription}</> : x.contractTitle ? <>Sözleşme: {x.contractTitle}</> : 'Bağsız'}
                      <span className="tabular">· {num(x.quantity)} {l.unit} · {fmtMoney(x.amount, d.invoice.currency)}</span></p>
                  ))}
                  {issuesFor(l.lineNo).map((x, i) => <Issue key={i} x={x} />)}
                </div>
              ))}
              {issuesFor(undefined).map((x, i) => <Issue key={i} x={x} />)}
              {editing && <AllocationEditor d={d} onDone={() => { setEditing(false); void r.reload(); }} />}
            </div>
          </section>
          {a.feedback}
        </div>
        <aside className="grid content-start gap-5">
          <section className="panel">
            <div className="panel-head"><h2>Tutar</h2></div>
            <div className="panel-body"><dl className="facts">
              <dt>Net</dt><dd className="tabular font-semibold">{fmtMoney(d.check.netAmount, d.invoice.currency)}</dd>
              {Number(d.check.otherTaxTotal) > 0 && <><dt>Diğer vergiler (ÖTV/ÖİV)</dt><dd className="tabular">{fmtMoney(d.check.otherTaxTotal, d.invoice.currency)}</dd></>}
              <dt>KDV</dt><dd className="tabular">{fmtMoney(d.check.taxTotal, d.invoice.currency)}{d.invoice.declaredTaxTotal && <span className="block text-sm text-ink-subtle">belgede {fmtMoney(d.invoice.declaredTaxTotal, d.invoice.currency)}</span>}</dd>
              {d.invoice.declaredWithholding && Number(d.invoice.declaredWithholding) > 0 && <><dt>Tevkifat</dt><dd className="tabular">− {fmtMoney(d.invoice.declaredWithholding, d.invoice.currency)}</dd></>}
              <dt>Ödenecek (vergi dahil, tevkifat sonrası)</dt><dd className="tabular">{fmtMoney(d.check.grossAmount, d.invoice.currency)}{d.invoice.declaredPayable && <span className="block text-sm text-ink-subtle">belgede ödenecek {fmtMoney(d.invoice.declaredPayable, d.invoice.currency)}</span>}</dd>
              {Number(d.invoice.advanceOffset) > 0 && <><dt>Avans mahsubu</dt><dd className="tabular">− {fmtMoney(d.invoice.advanceOffset, d.invoice.currency)}</dd></>}
              <dt>Net (avans mahsubu sonrası)</dt><dd className="tabular">{fmtMoney(d.check.payable, d.invoice.currency)}</dd>
            </dl>
            <p className="mt-2 text-sm text-ink-subtle">KDV satırlardan yeniden hesaplanır; belgede yazan tutar ancak bu hesapla tutarsa kabul edilir.{d.invoice.documentVersionId && <> <Link to={`/belgeler/${d.invoice.documentVersionId}`}>Kaynak e-Fatura</Link></>}</p></div>
          </section>
          {d.ublCheck && (
            <section className="panel" aria-labelledby="ubl-h">
              <div className="panel-head"><h2 id="ubl-h">{ublTitle(d.ublCheck)}</h2></div>
              <div className="panel-body"><UblFindings c={d.ublCheck} /></div>
            </section>
          )}
          {d.contracts.filter((c) => c.ceiling).map((c) => (
            <section key={c.contractVersionId} className="panel">
              <div className="panel-head"><h2>Limit · {c.title}</h2></div>
              <div className="panel-body"><dl className="facts">
                <dt>Tavan</dt><dd className="tabular">{fmtMoney(c.ceiling, c.currency)}</dd><dt>Net tüketim</dt><dd className="tabular">{fmtMoney(c.netConsumption, c.currency)}</dd>
                <dt>Açık taahhüt</dt><dd className="tabular">{fmtMoney(c.openCommitment, c.currency)}</dd>
                <dt>Kullanılabilir</dt><dd className="tabular font-semibold">{fmtMoney((Number(c.ceiling) - Number(c.netConsumption) - Number(c.openCommitment)).toFixed(2), c.currency)}</dd>
              </dl><p className="mt-2 text-sm text-ink-subtle">Bu fatura hariç; onay anında kilit altında yeniden hesaplanır.</p></div>
            </section>
          ))}
          <section className="panel">
            <div className="panel-head"><h2>Karar</h2></div>
            <div className="panel-body grid gap-3">
              {d.decisions.map((x, i) => <p key={i}><Tag label={x.kind === 'REJECTION' ? { text: `Ret · ${x.decidedBy}`, tone: 'neutral', icon: 'x' } : { text: `${x.kind === 'APPROVAL' ? 'Finans onayı' : 'İstisna onayı'} · ${x.decidedBy}`, tone: 'human', icon: 'stamp' }} />
                <span className="block text-sm text-ink-subtle">{fmtDateTime(x.decidedAt)}{x.reason ? ` · ${x.reason}` : ''}</span></p>)}
              {d.exceptionCurrent === false && !decided && <Banner tone="warn" title="İstisna eskidi">Onaydan sonra tahsis veya kontrol sonucu değişti; yeniden istisna onayı gerekir.</Banner>}
              {!decided && (() => {
                const needsEx = d.status === 'NEEDS_EXCEPTION' || d.exceptionCurrent === false;
                const canEx = needsEx && d.can.approveException && !d.invoice.createdByMe;
                const canFin = d.can.approve && !d.invoice.createdByMe;
                return <>
                  {needsEx && !canEx && <p className="text-sm text-ink-muted">İstisna onayını satınalma yöneticisi verir; bulgular sorumlularına görev olarak düştü.</p>}
                  {d.can.approve && d.invoice.createdByMe && <p className="text-sm text-ink-muted">Faturayı siz girdiniz; görev ayrılığı gereği başka bir finans kullanıcısı onaylar.</p>}
                  {(canEx || canFin) && <Field label={canEx ? 'Gerekçe' : 'Ret gerekçesi'} hint={canEx ? 'İstisnada kapsam, tutar ve süreyi yazın.' : 'Yalnız reddederken gerekli.'}>
                    {(p) => <textarea className="input" rows={3} {...p} value={reason} onChange={(e) => setReason(e.target.value)} />}</Field>}
                  {canEx && <Button disabled={a.busy || reason.trim().length < 10} onClick={() => void a.run(() => api(`/api/v1/invoices/${d.invoice.id}/exception-approval`, { method: 'POST', json: { reason } }), 'İstisna onaylandı.')}><Icon name="stamp" />İstisnayı onayla</Button>}
                  {canFin && <>
                    <Button disabled={a.busy || !d.check.canApprove || needsEx} onClick={() => void a.run(() => api(`/api/v1/invoices/${d.invoice.id}/approve`, { method: 'POST', ifMatch: d.checkFingerprint }), 'Fatura onaylandı.')}><Icon name="stamp" />Finans onayı</Button>
                    <Button variant="outline" disabled={a.busy || reason.trim().length < 10} onClick={() => void a.run(() => api(`/api/v1/invoices/${d.invoice.id}/reject`, { method: 'POST', json: { reason } }), 'Fatura reddedildi.')}>Reddet</Button>
                  </>}
                </>;
              })()}
              {d.erp?.lastError && <p className="text-sm text-ink-muted">{d.erp.lastError}</p>}
            </div>
          </section>
        </aside>
      </div>
    </div>
  );
}

function Issue({ x }: { x: InvDetail['check']['issues'][number] }) {
  const s = SEV[x.severity as keyof typeof SEV];
  return (
    <div className={cn('flex flex-wrap items-start gap-2 rounded-md px-3 py-2 text-sm', x.severity === 'BLOCK' ? 'bg-danger-soft' : x.severity === 'EXCEPTION' ? 'bg-warn-soft' : 'bg-info-soft')}>
      <span className={cn('inline-flex items-center gap-1 rounded-sm px-1.5 font-semibold', toneClass[s.tone])}><Icon name={s.icon} size={13} />{s.text}</span>
      <span className="min-w-0 flex-1">{x.message}</span>
      <span className="font-semibold">Çözen: {roleLabel[x.ownerRole] ?? x.ownerRole}</span>
    </div>
  );
}

function AllocationEditor({ d, onDone }: { d: InvDetail; onDone: () => void }) {
  const pos = useResource<{ items: { id: string; code: string; supplierName: string; contractTitle: string | null }[] }>('/api/v1/purchase-orders');
  const [rows, setRows] = useState(d.allocations.length ? d.allocations.map((x) => ({ lineNo: x.lineNo, target: x.poLineId ? `po:${x.poLineId}` : x.contractVersionId ? `cv:${x.contractVersionId}` : '', quantity: x.quantity, amount: x.amount }))
    : d.lines.map((l) => ({ lineNo: l.lineNo, target: '', quantity: l.quantity, amount: l.netAmount })));
  const [poLines, setPoLines] = useState<Record<string, { poLineId: string; description: string }[]>>({});
  const [offset, setOffset] = useState(d.invoice.advanceOffset);
  const [advanceId, setAdvanceId] = useState(d.invoice.advanceInvoiceId ?? '');
  const [err, setErr] = useState<string | null>(null);
  const supplierPos = (pos.data?.items ?? []).filter((p) => p.supplierName === d.invoice.supplierName);
  async function loadLines(poId: string) { if (poLines[poId]) return; const r = await api<{ lines: { poLineId: string; description: string }[] }>(`/api/v1/purchase-orders/${poId}`); setPoLines((x) => ({ ...x, [poId]: r.data.lines })); }
  return (
    <form className="grid gap-3 rounded-md border border-border bg-white p-3" onSubmit={(e) => { e.preventDefault(); setErr(null);
      void api(`/api/v1/invoices/${d.invoice.id}/allocations`, { method: 'PUT', json: { advanceOffset: offset || '0', advanceInvoiceId: advanceId || null,
        allocations: rows.filter((x) => x.target).map((x) => ({ lineNo: x.lineNo, poLineId: x.target.startsWith('po:') ? x.target.slice(3) : null, contractVersionId: x.target.startsWith('cv:') ? x.target.slice(3) : null, quantity: x.quantity, amount: x.amount })) } })
        .then(onDone, (x: ApiError) => setErr(x.message)); }}>
      <p className="text-sm text-ink-muted">Satırı siparişin kalemine bağlayın. Tek satır birden çok siparişe bölünebilir; tahsis toplamı satır tutarını aşamaz.</p>
      <div className="flex flex-wrap gap-2">{supplierPos.map((p) => <Button key={p.id} type="button" size="sm" variant="outline" onClick={() => void loadLines(p.id)}>{p.code} kalemlerini yükle</Button>)}
        {!supplierPos.length && <span className="text-sm text-ink-subtle">Bu tedarikçinin siparişi yok; sözleşmesiz tahsis istisna gerektirir.</span>}</div>
      {rows.map((x, i) => (
        <div key={i} className="grid grid-cols-[60px_minmax(0,1fr)_100px_130px_auto] items-start gap-2 max-[640px]:grid-cols-2">
          <span className="pt-2 text-sm font-semibold">Satır {x.lineNo}</span>
          <select className="input" aria-label={`Satır ${x.lineNo} hedef`} value={x.target} onChange={(e) => setRows(rows.map((y, j) => j === i ? { ...y, target: e.target.value } : y))}>
            <option value="">Seçin</option>
            {Object.entries(poLines).flatMap(([poId, ls]) => ls.map((l) => <option key={l.poLineId} value={`po:${l.poLineId}`}>{supplierPos.find((p) => p.id === poId)?.code} · {l.description}</option>))}
          </select>
          <input className="input tabular text-right" aria-label="Miktar" value={x.quantity} onChange={(e) => setRows(rows.map((y, j) => j === i ? { ...y, quantity: e.target.value.replace(',', '.') } : y))} />
          <input className="input tabular text-right" aria-label="Tutar" value={x.amount} onChange={(e) => setRows(rows.map((y, j) => j === i ? { ...y, amount: e.target.value.replace(',', '.') } : y))} />
          <Button type="button" variant="ghost" size="sm" onClick={() => setRows([...rows.slice(0, i + 1), { ...x, quantity: '', amount: '' }, ...rows.slice(i + 1)])}>Böl</Button>
        </div>
      ))}
      {d.invoice.kind === 'INVOICE' && <div className="grid grid-cols-2 gap-x-3 max-[640px]:grid-cols-1">
        <Field label="Avans faturası kimliği (mahsup)">{(p) => <input className="input mono" {...p} value={advanceId} onChange={(e) => setAdvanceId(e.target.value)} />}</Field>
        <Field label="Mahsup tutarı">{(p) => <input className="input tabular text-right" {...p} value={offset} onChange={(e) => setOffset(e.target.value.replace(',', '.'))} />}</Field></div>}
      <div className="flex gap-2"><Button type="submit">Tahsisi kaydet ve kontrol et</Button><Button type="button" variant="outline" onClick={onDone}>Vazgeç</Button></div>
      {err && <Banner tone="danger" title={err} />}
    </form>
  );
}

// --- Tolerans kuralları -----------------------------------------------------------------------------

interface ToleranceRow { currency: string; category: string; absAmount: string | null; percent: string | null; combine: 'LOWER' | 'HIGHER'; updatedAt: string; updatedBy: string | null }
const combineText = (r: Pick<ToleranceRow, 'absAmount' | 'percent' | 'combine' | 'currency'>) =>
  r.absAmount && r.percent ? `%${num(r.percent)} ve ${fmtMoney(r.absAmount, r.currency)} eşiklerinden ${r.combine === 'LOWER' ? 'düşük olanı' : 'yüksek olanı'}`
    : r.percent ? `Satır tutarının %${num(r.percent)}'i` : `${fmtMoney(r.absAmount, r.currency)}`;

export function ToleranceRulesPage() {
  const r = useResource<{ items: ToleranceRow[]; can: { manage: boolean } }>('/api/v1/tolerance-rules');
  const a = useAct(r.reload);
  const empty = { currency: 'TRY', category: '', absAmount: '', percent: '', combine: 'LOWER' as 'LOWER' | 'HIGHER' };
  const label = (x: { currency: string; category: string }) => x.category.trim() ? `${x.currency} · ${x.category.trim()}` : `${x.currency} genel`;
  const keyOf = (x: { currency: string; category: string }) => `${x.currency}|${x.category.trim()}`;
  const del = (x: ToleranceRow) => `/api/v1/tolerance-rules/${x.currency}${x.category ? `?category=${encodeURIComponent(x.category)}` : ''}`;
  const [f, setF] = useState<typeof empty | null>(null);
  const [removing, setRemoving] = useState<string | null>(null);
  return (
    <div className="page">
      <p className="text-sm text-ink-subtle"><Link to="/faturalar" className="text-ink-subtle">Faturalar</Link> / Tolerans kuralları</p>
      <PageHeader title="Tolerans kuralları" actions={r.data?.can.manage && !f && <Button onClick={() => setF(empty)}>Kural ekle</Button>}>
        Fatura birim fiyatı siparişten bu kadar sapabilir; aşan fark istisna onayı ister. Siparişin projesindeki kategori için kural varsa o, yoksa para biriminin genel kuralı uygulanır; ikisi de yoksa tolerans sıfırdır. Kimlik ve para birimi farkı hiçbir kuralla geçmez.
      </PageHeader>
      {f && (
        <form className="panel mb-5 max-w-[760px]" onSubmit={(e) => { e.preventDefault(); void a.run(() => api('/api/v1/tolerance-rules', { method: 'PUT',
          json: { currency: f.currency, category: f.category.trim(), absAmount: f.absAmount || null, percent: f.percent || null, combine: f.combine } }), `${label(f)} kuralı kaydedildi.`).then((ok) => ok && setF(null)); }}>
          <div className="panel-head"><h2>{r.data?.items.some((x) => keyOf(x) === keyOf(f)) ? `${label(f)} kuralını değiştir` : 'Yeni kural'}</h2></div>
          <div className="panel-body grid gap-3">
            <div className="grid grid-cols-[120px_minmax(0,1fr)] items-start gap-x-3 max-[640px]:grid-cols-1">
              <Field label="Para birimi">{(p) => <input className="input" required maxLength={3} pattern="[A-Z]{3}" {...p} value={f.currency} onChange={(e) => setF({ ...f, currency: e.target.value.toUpperCase() })} />}</Field>
              <Field label="Kategori (isteğe bağlı)" hint="Proje kategorisiyle aynı yazılır (büyük/küçük harf fark etmez). Boş = bu para biriminin genel kuralı.">{(p) => <input className="input" maxLength={200} {...p} value={f.category} onChange={(e) => setF({ ...f, category: e.target.value })} />}</Field>
            </div>
            <div className="grid grid-cols-3 items-start gap-x-3 max-[900px]:grid-cols-2">
              <Field label="Tutar eşiği" hint="Satır başına, en fazla 2 ondalık.">{(p) => <input className="input tabular text-right" inputMode="decimal" {...p} value={f.absAmount} onChange={(e) => setF({ ...f, absAmount: e.target.value.replace(',', '.') })} />}</Field>
              <Field label="Yüzde eşiği" hint="Satır tutarına göre, 0–100.">{(p) => <input className="input tabular text-right" inputMode="decimal" {...p} value={f.percent} onChange={(e) => setF({ ...f, percent: e.target.value.replace(',', '.') })} />}</Field>
              <Field label="İkisi de varsa">{(p) => <select className="input" {...p} value={f.combine} onChange={(e) => setF({ ...f, combine: e.target.value as 'LOWER' | 'HIGHER' })}><option value="LOWER">Düşük olan geçerli</option><option value="HIGHER">Yüksek olan geçerli</option></select>}</Field>
            </div>
            {(f.absAmount || f.percent) && <p className="text-sm text-ink-muted">Geçerli tolerans: {combineText({ ...f, absAmount: f.absAmount || null, percent: f.percent || null })}.</p>}
            <div className="flex gap-2"><Button type="submit" disabled={a.busy || (!f.absAmount && !f.percent)}>Kaydet</Button><Button type="button" variant="ghost" onClick={() => setF(null)}>Vazgeç</Button></div>
          </div>
        </form>
      )}
      {r.loading && !r.data ? <Loading /> : r.error ? <ErrorState error={r.error} onRetry={r.reload} /> : !r.data?.items.length ? (
        <div className="rounded-md border border-border bg-surface"><Empty icon="info" title="Tolerans kuralı yok">Tüm para birimlerinde fiyat farkı sıfır toleransla kontrol edilir.</Empty></div>
      ) : (
        <Table>
          <TableHeader><TableRow className="hover:bg-transparent"><TableHead>Para birimi</TableHead><TableHead>Kategori</TableHead><TableHead>Geçerli tolerans</TableHead><TableHead className="max-[640px]:hidden">Son değişiklik</TableHead><TableHead><span className="sr-only">Eylem</span></TableHead></TableRow></TableHeader>
          <TableBody>{r.data.items.map((x) => (
            <TableRow key={keyOf(x)}>
              <TableCell className="font-semibold">{x.currency}</TableCell>
              <TableCell>{x.category || <span className="text-ink-subtle">Genel (kategori kuralı olmayan alımlar)</span>}</TableCell>
              <TableCell className="tabular">{combineText(x)}</TableCell>
              <TableCell className="text-sm text-ink-subtle max-[640px]:hidden">{x.updatedBy ?? '—'} · {fmtDateTime(x.updatedAt)}</TableCell>
              <TableCell className="whitespace-nowrap text-right">{r.data!.can.manage && (removing === keyOf(x) ? <>
                <span className="mr-2 text-sm">{label(x)} kuralı kaldırılsın mı?</span>
                <Button size="sm" variant="destructive" disabled={a.busy} onClick={() => void a.run(() => api(del(x), { method: 'DELETE' }),
                  x.category ? `${label(x)} kuralı kaldırıldı; bu kategoride ${x.currency} genel kuralı geçerli.` : `${label(x)} kuralı kaldırıldı; kategori kuralı olmayan alımlarda tolerans sıfır.`).then(() => setRemoving(null))}>Kaldır</Button>
                <Button size="sm" variant="ghost" onClick={() => setRemoving(null)}>Vazgeç</Button></> : <>
                <Button size="sm" variant="outline" onClick={() => setF({ currency: x.currency, category: x.category, absAmount: x.absAmount ?? '', percent: x.percent ?? '', combine: x.combine })}>Değiştir</Button>
                <Button size="sm" variant="ghost" onClick={() => setRemoving(keyOf(x))}>Kaldır</Button></>)}</TableCell>
            </TableRow>
          ))}</TableBody>
        </Table>
      )}
      <div className="mt-4">{a.feedback}</div>
    </div>
  );
}
