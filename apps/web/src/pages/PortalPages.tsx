import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api, apiBlob, ApiError } from '../lib/api.ts';
import { useResource } from '../lib/useApi.ts';
import { fmtDate, fmtDateTime, fmtMoney } from '../lib/format.ts';
import { ANSWER_RESPONSE as RESPONSE, costKindLabel, scopeLabel } from '../lib/labels.ts';
import { Banner, Empty, ErrorState, Field, Loading, PageHeader, Tag } from '../ui/kit.tsx';
import { Icon } from '../ui/icons.tsx';
import { Button } from '@/components/ui/button';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { cn } from '@/lib/utils';

// UX04 Tedarikçi portalı: yalnız davetli turlar ve kendi teklifi. Kapanış ve alındı zamanı sunucudan.
interface RoundRow { projectId: string; code: string; title: string; currency: string; buyerName: string; roundId: string; roundNo: number; closesAt: string; open: boolean;
  myVersion: number | null; mySubmittedAt: string | null }

export function PortalHome() {
  const r = useResource<{ items: RoundRow[] }>('/api/v1/portal/rounds');
  return (
    <div className="page">
      <PageHeader title="Teklif davetleri">Size gönderilen teklif turları. Başka firmaların teklifleri ve kurum içi notlar bu portalda görünmez.</PageHeader>
      {r.loading && !r.data ? <Loading /> : r.error ? <ErrorState error={r.error} onRetry={r.reload} /> : !r.data?.items.length ? (
        <div className="rounded-md border border-border bg-surface"><Empty icon="inbox" title="Açık davetiniz yok">Bir alıcı sizi teklif turuna davet ettiğinde burada görünür.</Empty></div>
      ) : (
        <Table>
          <TableHeader><TableRow className="hover:bg-transparent"><TableHead>Proje</TableHead><TableHead>Alıcı</TableHead><TableHead>Kapanış</TableHead><TableHead>Teklifiniz</TableHead><TableHead><span className="sr-only">Eylem</span></TableHead></TableRow></TableHeader>
          <TableBody>{r.data.items.map((x) => (
            <TableRow key={x.roundId}>
              <TableCell className="min-w-[220px]"><span className="block font-semibold">{x.title}</span><span className="text-sm text-ink-subtle">{x.code} · Tur {x.roundNo}</span></TableCell>
              <TableCell>{x.buyerName}</TableCell>
              <TableCell className="whitespace-nowrap">{fmtDateTime(x.closesAt)}{!x.open && <span className="block text-sm text-ink-subtle">Kapandı</span>}</TableCell>
              <TableCell>{x.myVersion ? <span>Sürüm {x.myVersion} · {fmtDateTime(x.mySubmittedAt)}</span> : <span className="text-ink-subtle">Gönderilmedi</span>}</TableCell>
              <TableCell><Button asChild size="sm" variant={x.open ? 'default' : 'outline'}><Link to={`/portal/${x.roundId}`}>{x.open ? (x.myVersion ? 'Teklifi güncelle' : 'Teklif ver') : 'Görüntüle'}</Link></Button></TableCell>
            </TableRow>
          ))}</TableBody>
        </Table>
      )}
    </div>
  );
}

interface PortalDetail {
  project: { code: string; title: string; category: string; need: string; currency: string; deliveryLocation: string | null; neededBy: string | null; buyerName: string };
  round: { id: string; roundNo: number; closesAt: string; open: boolean };
  lines: { id: string; lot: string; description: string; unit: string; quantity: string; spec: string }[];
  criteria: { name: string; kind: string; weight: string }[];
  myBids: { id: string; versionNo: number; status: string; currency: string; submittedAt: string }[];
  current: null | { id: string; versionNo: number; currency: string; note: string; validityDays: number | null;
    lines: { projectLineId: string; unit: string; quantity: string; unitPrice: string; scope: string; note: string }[]; costs: { kind: string; amount: string; note: string }[]; attachmentIds: string[] };
  files: { id: string; title: string; filename: string; mimeType: string; sizeBytes: number; status: string; reason: string | null; uploadedAt: string }[];
  questions: { id: string; question: string | null; askedAt: string; answer: string | null; answeredAt: string | null; mine: boolean }[];
  serverTime: string;
}
interface Row { unit: string; quantity: string; unitPrice: string; scope: string; note: string }
const DEC = /^\d{1,18}(\.\d{1,6})?$/;
const newKey = () => (crypto.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(16).slice(2)}`);

/** Sunucu saatine göre kalan süre; yerel saat yalnız akışı ilerletir. */
function useServerCountdown(closesAt: string | undefined, serverTime: string | undefined) {
  const offset = useMemo(() => (serverTime ? new Date(serverTime).getTime() - Date.now() : 0), [serverTime]);
  const [now, setNow] = useState(Date.now());
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(t); }, []);
  if (!closesAt) return null;
  return Math.max(0, new Date(closesAt).getTime() - (now + offset));
}
function fmtLeft(ms: number) {
  const s = Math.floor(ms / 1000), d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60);
  return d ? `${d} gün ${h} sa` : h ? `${h} sa ${m} dk` : `${m} dk ${s % 60} sn`;
}

export function PortalRound() {
  const { id } = useParams();
  const r = useResource<PortalDetail>(`/api/v1/portal/rounds/${id}`);
  const d = r.data;
  const left = useServerCountdown(d?.round.closesAt, d?.serverTime);
  const [rows, setRows] = useState<Record<string, Row>>({});
  const [currency, setCurrency] = useState('TRY');
  const [validity, setValidity] = useState('60');
  const [note, setNote] = useState('');
  const [costs, setCosts] = useState<{ kind: string; amount: string }[]>([]);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const [receipt, setReceipt] = useState<{ versionNo: number; submittedAt: string; replay: boolean } | null>(null);
  const [question, setQuestion] = useState('');
  const [attach, setAttach] = useState<string[]>([]);
  const [uploading, setUploading] = useState(false);
  const [fileMsg, setFileMsg] = useState<{ tone: 'info' | 'danger' | 'warn'; text: string } | null>(null);
  const keyRef = useRef(newKey());
  const summaryRef = useRef<HTMLDivElement>(null);

  // Form yalnız ilk yüklemede ve teklif sürümü değişince sunucudan doldurulur; ara yeniden yüklemeler yazılanı ezmez.
  const initKey = d ? `${d.round.id}:${d.current?.id ?? 'yok'}` : null;
  const initedRef = useRef<string | null>(null);
  useEffect(() => {
    if (!d || initedRef.current === initKey) return;
    initedRef.current = initKey;
    const init: Record<string, Row> = {};
    for (const l of d.lines) {
      const c = d.current?.lines.find((x) => x.projectLineId === l.id);
      init[l.id] = c ? { unit: c.unit, quantity: c.quantity, unitPrice: c.unitPrice, scope: c.scope, note: c.note } : { unit: l.unit, quantity: l.quantity, unitPrice: '', scope: 'INCLUDED', note: '' };
    }
    setRows(init);
    setCurrency(d.current?.currency ?? d.project.currency);
    setValidity(String(d.current?.validityDays ?? 60));
    setNote(d.current?.note ?? '');
    setCosts(d.current?.costs.map((c) => ({ kind: c.kind, amount: c.amount })) ?? []);
    setAttach(d.current?.attachmentIds ?? []);
  }, [d, initKey]);

  async function uploadFile(file: File) {
    setUploading(true); setFileMsg(null);
    try {
      const fd = new FormData(); fd.set('title', file.name); fd.set('file', file);
      const res = await api<{ id: string; duplicate: boolean; status: string; reason: string | null }>(`/api/v1/portal/rounds/${id}/files`, { method: 'POST', body: fd });
      if (res.data.status === 'PASSED') { setAttach((x) => [...new Set([...x, res.data.id])]); setFileMsg({ tone: 'info', text: res.data.duplicate ? 'Bu dosya zaten yüklenmişti; teklife eklendi.' : 'Dosya yüklendi ve teklife eklendi.' }); }
      else setFileMsg({ tone: 'warn', text: `Dosya karantinaya alındı: ${res.data.reason ?? 'kontrol geçmedi'}. Teklife eklenemez.` });
      await r.reload();
    } catch (err) { setFileMsg({ tone: 'danger', text: (err as ApiError).message }); } finally { setUploading(false); }
  }
  async function downloadFile(fid: string, name: string) {
    const blob = await apiBlob(`/api/v1/bid-files/${fid}/content`);
    const url = URL.createObjectURL(blob); const el = document.createElement('a'); el.href = url; el.download = name; el.click(); URL.revokeObjectURL(url);
  }

  if (r.loading && !d) return <div className="page"><Loading rows={6} /></div>;
  if (r.error || !d) return <div className="page"><ErrorState error={r.error} onRetry={r.reload} /></div>;
  const closed = !d.round.open || left === 0;
  const set = (lineId: string, k: keyof Row, v: string) => setRows((x) => ({ ...x, [lineId]: { ...x[lineId]!, [k]: v } }));

  function validate() {
    const e: Record<string, string> = {};
    for (const l of d!.lines) {
      const row = rows[l.id]!;
      if (row.scope === 'EXCLUDED') continue;
      if (!DEC.test(row.unitPrice)) e[`${l.id}-unitPrice`] = 'Birim fiyat girin (ondalık ayırıcı nokta) veya kalemi kapsam dışı işaretleyin.';
      if (!DEC.test(row.quantity)) e[`${l.id}-quantity`] = 'Miktar girin.';
      if (!row.unit.trim()) e[`${l.id}-unit`] = 'Birim girin.';
    }
    costs.forEach((c, i) => { if (!DEC.test(c.amount)) e[`cost-${i}`] = 'Tutar girin.'; });
    if (attach.length > 20) e.attachments = `Bir teklif sürümüne en fazla 20 ek bağlanabilir (şu an ${attach.length}). Gerekmeyenlerin işaretini kaldırın.`;
    return e;
  }
  async function submit(ev: React.FormEvent) {
    ev.preventDefault();
    const e = validate();
    setErrors(e); setError(null); setReceipt(null);
    if (Object.keys(e).length) { requestAnimationFrame(() => summaryRef.current?.focus()); return; }
    setBusy(true);
    try {
      const res = await api<{ versionNo: number; submittedAt: string; replay: boolean }>(`/api/v1/portal/rounds/${id}/bids`, {
        method: 'POST', headers: { 'Idempotency-Key': keyRef.current },
        json: { currency, validityDays: Number(validity) || null, note,
          lines: d!.lines.map((l) => ({ projectLineId: l.id, unit: rows[l.id]!.unit, quantity: rows[l.id]!.quantity, unitPrice: rows[l.id]!.scope === 'EXCLUDED' ? '0' : rows[l.id]!.unitPrice, scope: rows[l.id]!.scope, note: rows[l.id]!.note })),
          costs: costs.map((c) => ({ kind: c.kind, amount: c.amount })), attachmentIds: attach } });
      setReceipt(res.data);
      keyRef.current = newKey();
      await r.reload();
    } catch (err) {
      // Bağlantı koparsa aynı anahtar korunur: yeniden gönderim ikinci teklif açmaz.
      setError(err as ApiError);
    } finally { setBusy(false); }
  }
  const total = d.lines.reduce((t, l) => { const x = rows[l.id]; return t + (x && x.scope !== 'EXCLUDED' && DEC.test(x.unitPrice) && DEC.test(x.quantity) ? Number(x.unitPrice) * Number(x.quantity) : 0); }, 0)
    + costs.reduce((t, c) => t + (DEC.test(c.amount) ? Number(c.amount) : 0), 0);

  return (
    <div className="page max-w-[1200px]">
      <div className="mb-1 text-sm text-ink-subtle"><Link to="/portal" className="text-ink-subtle">Teklif davetleri</Link> / {d.project.code}</div>
      <PageHeader title={d.project.title}>{d.project.buyerName} · Tur {d.round.roundNo} · {d.project.category}</PageHeader>
      <div className={cn('mb-5 flex flex-wrap items-center gap-x-6 gap-y-2 rounded-md border px-4 py-3', closed ? 'border-border bg-sunken' : 'border-[#cfd5e2] bg-info-soft')} role="status">
        <span className="font-semibold">Kapanış: <span className="tabular">{fmtDateTime(d.round.closesAt)}</span></span>
        <span className="tabular">{closed ? 'Tur kapandı; teklif kabul edilmez.' : `Kalan süre (sunucu saatine göre): ${fmtLeft(left ?? 0)}`}</span>
        {d.current && <span>Geçerli teklifiniz: <span className="font-semibold">Sürüm {d.current.versionNo}</span></span>}
      </div>
      {receipt && (
        <Banner tone="info" icon="check" title={receipt.replay ? `Bu gönderim zaten alınmıştı: sürüm ${receipt.versionNo}` : `Teklifiniz alındı: sürüm ${receipt.versionNo}`}>
          Alındı zamanı (sunucu): <span className="tabular font-semibold">{fmtDateTime(receipt.submittedAt)}</span>. Kapanışa kadar yeni sürüm gönderebilirsiniz; önceki sürümler silinmez.
        </Banner>
      )}
      {error && <Banner tone={error.status === 409 ? 'warn' : 'danger'} title={error.status === 0 ? 'Bağlantı koptu; teklif gönderilmiş sayılmaz' : error.message}>
        {error.status === 0 ? 'Bağlantı gelince "Teklifi gönder" ile tekrar deneyin. Aynı gönderim ikinci kez kaydedilmez.' : null}</Banner>}
      {Object.keys(errors).length > 0 && <div ref={summaryRef} tabIndex={-1}><Banner tone="danger" title="Teklif formunda eksik alanlar var">{errors.attachments ?? `${Object.keys(errors).length} alan düzeltilmeli; her satırın yanında açıklama var.`}</Banner></div>}

      <div className="grid grid-cols-[minmax(0,1fr)_340px] gap-6 max-[1100px]:grid-cols-1">
        <form onSubmit={(e) => void submit(e)} className="grid gap-4">
          <fieldset disabled={closed || busy} className="grid gap-4">
            <legend className="sr-only">Fiyat tablosu</legend>
            {d.lines.map((l) => {
              const row = rows[l.id]; if (!row) return null;
              const err = (k: string) => errors[`${l.id}-${k}`] ?? null;
              return (
                <div key={l.id} className="rounded-md border border-border bg-white p-3">
                  <div className="mb-2 flex flex-wrap items-baseline justify-between gap-2"><span className="font-semibold">{l.description}</span>
                    <span className="tabular text-sm text-ink-subtle">{l.lot} · istenen {Number(l.quantity).toLocaleString('tr-TR')} {l.unit}</span></div>
                  {l.spec && <p className="mb-2 text-sm text-ink-muted">{l.spec}</p>}
                  <div className="grid grid-cols-[150px_110px_120px_minmax(0,1fr)] gap-x-3 max-[900px]:grid-cols-2">
                    <Field label="Kapsam">{(p) => <select className="input" {...p} value={row.scope} onChange={(e) => set(l.id, 'scope', e.target.value)}>{Object.entries(scopeLabel).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select>}</Field>
                    <Field label="Birim" error={err('unit')}>{(p) => <input className="input" {...p} value={row.unit} onChange={(e) => set(l.id, 'unit', e.target.value)} />}</Field>
                    <Field label="Miktar" error={err('quantity')}>{(p) => <input className="input tabular text-right" inputMode="decimal" {...p} value={row.quantity} onChange={(e) => set(l.id, 'quantity', e.target.value.replace(',', '.'))} />}</Field>
                    <Field label={`Birim fiyat (${currency})`} error={err('unitPrice')}>{(p) => <input className="input tabular text-right" inputMode="decimal" disabled={row.scope === 'EXCLUDED'} {...p} value={row.scope === 'EXCLUDED' ? '' : row.unitPrice} onChange={(e) => set(l.id, 'unitPrice', e.target.value.replace(',', '.'))} />}</Field>
                  </div>
                  {row.unit.trim().toLocaleLowerCase('tr-TR') !== l.unit.toLocaleLowerCase('tr-TR') && row.scope !== 'EXCLUDED' &&
                    <p className="flex gap-1.5 text-sm text-warn"><Icon name="alert" size={16} className="mt-0.5 shrink-0" />Birim istenenden farklı. Tanımlı dönüşüm yoksa teklifiniz bu kalemde karşılaştırılamaz.</p>}
                </div>
              );
            })}
            <div className="rounded-md border border-border bg-white p-3">
              <h2 className="mb-2 text-base">Ek maliyetler</h2>
              {costs.map((c, i) => (
                <div key={i} className="grid grid-cols-[180px_160px_auto] items-start gap-3 max-[640px]:grid-cols-2">
                  <Field label="Tür">{(p) => <select className="input" {...p} value={c.kind} onChange={(e) => setCosts((x) => x.map((y, j) => j === i ? { ...y, kind: e.target.value } : y))}>{Object.entries(costKindLabel).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select>}</Field>
                  <Field label={`Tutar (${currency})`} error={errors[`cost-${i}`]}>{(p) => <input className="input tabular text-right" inputMode="decimal" {...p} value={c.amount} onChange={(e) => setCosts((x) => x.map((y, j) => j === i ? { ...y, amount: e.target.value.replace(',', '.') } : y))} />}</Field>
                  <Button type="button" variant="ghost" size="sm" className="mt-6" onClick={() => setCosts((x) => x.filter((_, j) => j !== i))} aria-label="Ek maliyeti sil"><Icon name="close" /></Button>
                </div>
              ))}
              <Button type="button" variant="outline" size="sm" onClick={() => setCosts((x) => [...x, { kind: 'INSTALLATION', amount: '' }])}>Ek maliyet ekle</Button>
            </div>
            <div className="rounded-md border border-border bg-white p-3">
              <h2 className="mb-1 text-base">Ekler</h2>
              <p className="mb-3 text-sm text-ink-muted">Teknik föy, referans, sertifika. PDF, PNG, JPEG veya XML · en fazla 25 MB. İşaretli ekler bu teklif sürümüne bağlanır; alıcı ekleri tur kapandıktan sonra görür.</p>
              {d.files.length > 0 && <ul className="mb-3 grid gap-1.5">{d.files.map((f) => (
                <li key={f.id} className="flex flex-wrap items-center gap-2">
                  <label className="flex min-w-0 flex-1 items-center gap-2"><input type="checkbox" className="accent-[var(--ink)]" disabled={f.status !== 'PASSED'} checked={attach.includes(f.id)}
                    onChange={(e) => setAttach((x) => e.target.checked ? [...x, f.id] : x.filter((y) => y !== f.id))} />
                    <span className="truncate">{f.title}</span><span className="tabular text-sm text-ink-subtle">{Math.max(1, Math.round(f.sizeBytes / 1024)).toLocaleString('tr-TR')} KB</span></label>
                  {f.status === 'PASSED' ? <Button type="button" variant="ghost" size="sm" onClick={() => void downloadFile(f.id, f.filename)}>İndir</Button>
                    : <Tag label={{ text: 'Karantinada', tone: 'danger', icon: 'shield' }} title={f.reason ?? undefined} />}
                </li>))}</ul>}
              <div className="flex flex-wrap items-center gap-3">
                <input id="bid-file" className="peer sr-only" type="file" accept=".pdf,.png,.jpg,.jpeg,.xml" onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ''; if (f) void uploadFile(f); }} />
                <label htmlFor="bid-file" className="btn cursor-pointer peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-focus"><Icon name="upload" />{uploading ? 'Yükleniyor…' : 'Ek yükle'}</label>
                <span className={cn('text-sm', attach.length > 20 ? 'font-semibold text-danger' : 'text-ink-subtle')}>{attach.length} ek bu teklife bağlanacak{attach.length > 20 ? ' (en fazla 20)' : ''}</span>
              </div>
              {fileMsg && <p role="status" className={cn('mt-2 text-sm', fileMsg.tone === 'danger' ? 'text-danger' : fileMsg.tone === 'warn' ? 'text-warn' : 'text-verified')}>{fileMsg.text}</p>}
            </div>
            <div className="grid grid-cols-[120px_160px_minmax(0,1fr)] gap-x-3 max-[640px]:grid-cols-2">
              <Field label="Para birimi">{(p) => <input className="input" maxLength={3} {...p} value={currency} onChange={(e) => setCurrency(e.target.value.toUpperCase())} />}</Field>
              <Field label="Geçerlilik (gün)">{(p) => <input className="input tabular text-right" inputMode="numeric" {...p} value={validity} onChange={(e) => setValidity(e.target.value)} />}</Field>
              <Field label="Not">{(p) => <input className="input" {...p} value={note} onChange={(e) => setNote(e.target.value)} />}</Field>
            </div>
            <div className="flex flex-wrap items-center gap-4">
              <Button type="submit" size="lg">{busy ? 'Gönderiliyor…' : d.current ? 'Yeni sürüm gönder' : 'Teklifi gönder'}</Button>
              <span className="tabular">Önizleme toplamı: <span className="font-semibold">{fmtMoney(total.toFixed(2), currency)}</span></span>
            </div>
            <p className="text-sm text-ink-muted">Teklif yalnız sunucu "alındı" yanıtıyla gönderilmiş sayılır. Kopan bağlantı başarı değildir.</p>
          </fieldset>
        </form>
        <aside className="grid content-start gap-4">
          <section className="panel">
            <div className="panel-head"><h2>Değerlendirme</h2></div>
            <div className="panel-body"><ul className="grid gap-1.5">{d.criteria.map((c) => <li key={c.name} className="flex justify-between gap-2"><span>{c.name}</span><span className="tabular">%{Number(c.weight).toLocaleString('tr-TR')}</span></li>)}</ul>
              <p className="mt-2 text-sm text-ink-muted">Eksik kalem, kapsam dışı satır veya dönüştürülemeyen birim fiyat sıralamasına girmez.</p></div>
          </section>
          {(d.project.deliveryLocation || d.project.neededBy) && <section className="panel"><div className="panel-body"><dl className="facts">
            {d.project.deliveryLocation && <><dt>Teslimat</dt><dd>{d.project.deliveryLocation}</dd></>}
            {d.project.neededBy && <><dt>İhtiyaç tarihi</dt><dd>{fmtDate(d.project.neededBy)}</dd></>}</dl></div></section>}
          <section className="panel">
            <div className="panel-head"><h2>Gönderimlerim</h2></div>
            <div className="panel-body">{!d.myBids.length ? <p className="text-ink-muted">Henüz gönderim yok.</p> : (
              <ul className="grid gap-1.5">{d.myBids.map((b) => <li key={b.id} className="flex flex-wrap items-center justify-between gap-2"><span className="tabular">Sürüm {b.versionNo} · {fmtDateTime(b.submittedAt)}</span>
                {b.status === 'SUBMITTED' ? <Tag label={{ text: 'Geçerli', tone: 'ok', icon: 'check' }} /> : <span className="text-sm text-ink-subtle">Yerine yenisi geldi</span>}</li>)}</ul>)}</div>
          </section>
          <section className="panel">
            <div className="panel-head"><h2>Soru ve cevaplar</h2></div>
            <div className="panel-body grid gap-3">
              {d.questions.map((q) => <div key={q.id} className="grid gap-1 border-b border-border pb-2 last:border-b-0">
                {q.question && <p>{q.question}{q.mine && <span className="text-sm text-ink-subtle"> · sizin sorunuz</span>}</p>}
                <p className={q.answer ? '' : 'text-sm text-ink-subtle'}>{q.answer ? <><span className="font-semibold">Yanıt:</span> {q.answer}</> : 'Yanıt bekleniyor'}</p></div>)}
              {!closed && <form className="grid gap-2" onSubmit={(e) => { e.preventDefault(); void api(`/api/v1/portal/rounds/${id}/questions`, { method: 'POST', json: { question } }).then(() => { setQuestion(''); void r.reload(); }, (err) => setError(err)); }}>
                <Field label="Soru sor" hint="Yanıt tüm davetlilere adınız olmadan yayınlanır.">{(p) => <textarea className="input" rows={2} {...p} value={question} onChange={(e) => setQuestion(e.target.value)} />}</Field>
                <Button type="submit" variant="outline" className="justify-self-start" disabled={question.trim().length < 3}>Gönder</Button></form>}
            </div>
          </section>
        </aside>
      </div>
    </div>
  );
}

// Tedarikçi portalı: kurumun gönderdiği güvenlik/uyum anketleri. Tedarikçi yalnız soruları ve kendi beyanını görür; inceleme ve risk kararı kurumda.
interface PortalAssessmentRow { id: string; templateName: string; version: number; scope: string; portalStatus: 'SENT' | 'SUBMITTED'; sentAt: string; due: string | null;
  submittedAt: string | null; questions: number; answered: number }

export function PortalAssessments() {
  const r = useResource<{ items: PortalAssessmentRow[] }>('/api/v1/portal/assessments');
  return (
    <div className="page">
      <PageHeader title="Anketler">Kurumun sizden yanıt beklediği güvenlik ve uyum anketleri. Kurumun incelemesi ve risk kararı bu portalda görünmez.</PageHeader>
      {r.loading && !r.data ? <Loading /> : r.error ? <ErrorState error={r.error} onRetry={r.reload} /> : !r.data?.items.length ? (
        <div className="rounded-md border border-border bg-surface"><Empty icon="inbox" title="Yanıt bekleyen anket yok">Kurum bir anket gönderdiğinde burada görünür.</Empty></div>
      ) : (
        <Table>
          <TableHeader><TableRow className="hover:bg-transparent"><TableHead>Anket</TableHead><TableHead>Son tarih</TableHead><TableHead>Durum</TableHead><TableHead><span className="sr-only">Eylem</span></TableHead></TableRow></TableHeader>
          <TableBody>{r.data.items.map((x) => (
            <TableRow key={x.id}>
              <TableCell className="min-w-[220px]"><span className="block font-semibold">{x.scope}</span><span className="text-sm text-ink-subtle">{x.templateName} v{x.version} · gönderim {fmtDate(x.sentAt)}</span></TableCell>
              <TableCell className="whitespace-nowrap">{x.due ? fmtDate(x.due) : '—'}</TableCell>
              <TableCell className="whitespace-nowrap">{x.portalStatus === 'SUBMITTED' ? `Gönderildi · ${fmtDateTime(x.submittedAt!)}` : <span className="tabular">{x.answered}/{x.questions} yanıtlandı</span>}</TableCell>
              <TableCell><Button asChild size="sm" variant={x.portalStatus === 'SENT' ? 'default' : 'outline'}><Link to={`/portal/anketler/${x.id}`}>{x.portalStatus === 'SENT' ? 'Yanıtla' : 'Görüntüle'}</Link></Button></TableCell>
            </TableRow>
          ))}</TableBody>
        </Table>
      )}
    </div>
  );
}

type PResponse = keyof typeof RESPONSE;
interface PortalAssessmentDetail {
  id: string; scope: string; status: 'SENT' | 'SUBMITTED'; due: string | null;
  questions: { id: string; controlId: string; text: string; evidenceRequired: boolean }[];
  answers: { questionId: string; response: PResponse; naReason: string | null; note: string | null }[];
}

export function PortalAssessment() {
  const { id } = useParams();
  const r = useResource<PortalAssessmentDetail>(`/api/v1/portal/assessments/${id}`);
  const [msg, setMsg] = useState<{ tone: 'info' | 'warn' | 'danger'; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);
  if (r.loading && !r.data) return <div className="page"><Loading rows={5} /></div>;
  if (r.error || !r.data) return <div className="page"><ErrorState error={r.error} onRetry={r.reload} /></div>;
  const d = r.data;
  const editable = d.status === 'SENT';
  const answered = d.questions.filter((q) => d.answers.some((x) => x.questionId === q.id)).length;
  const submit = async () => {
    setBusy(true); setMsg(null);
    try { await api(`/api/v1/portal/assessments/${d.id}/submit`, { method: 'POST' }); setMsg({ tone: 'info', text: 'Yanıtlarınız kuruma gönderildi.' }); setConfirming(false); await r.reload(); }
    catch (e) { const err = e as ApiError; setMsg({ tone: err.status === 409 ? 'warn' : 'danger', text: err.message }); }
    finally { setBusy(false); }
  };
  return (
    <div className="page">
      <p className="text-sm text-ink-subtle"><Link to="/portal/anketler" className="text-ink-subtle">Anketler</Link> / Yanıt</p>
      <h1 className="mb-1 mt-1">{d.scope}</h1>
      <p className="mb-5 text-ink-muted">{d.due ? `Son tarih ${fmtDate(d.due)} · ` : ''}<span className="tabular">{answered}/{d.questions.length}</span> soru yanıtlandı
        {editable ? ' · Yanıtlar siz gönderene kadar değiştirilebilir.' : ' · Gönderildi; değişiklik için kurumla iletişime geçin.'}</p>
      {!editable && <Banner tone="info" icon="check" title="Yanıtlarınız kuruma iletildi">Kurum yanıtları inceler; gerekirse kanıt belgesi ister.</Banner>}
      <div className="grid gap-3">
        {d.questions.map((q, i) => <PortalQuestion key={q.id} n={i + 1} q={q} ans={d.answers.find((x) => x.questionId === q.id)} editable={editable}
          save={(b) => api(`/api/v1/portal/assessments/${d.id}/answers/${q.id}`, { method: 'PUT', json: b }).then(r.reload)} />)}
      </div>
      <div aria-live="polite" className="mt-4">{msg && <Banner tone={msg.tone} icon={msg.tone === 'info' ? 'check' : undefined} title={msg.text} />}</div>
      {editable && (
        <section className="panel mt-4"><div className="panel-body flex flex-wrap items-center gap-3">
          {!confirming ? <>
            <p className="min-w-0 flex-1 text-sm text-ink-muted">{answered < d.questions.length ? `${d.questions.length - answered} soru yanıtsız. Tüm sorular yanıtlanmadan gönderilemez; kapsam dışı soru için "Uygulanamaz" seçip gerekçe yazın.` : 'Tüm sorular yanıtlandı.'}</p>
            <Button disabled={answered < d.questions.length} onClick={() => setConfirming(true)}>Kuruma gönder</Button>
          </> : <>
            <p className="min-w-0 flex-1 text-sm">Gönderdikten sonra yanıtlarınızı değiştiremezsiniz. Gönderilsin mi?</p>
            <Button disabled={busy} onClick={() => void submit()}>Evet, gönder</Button><Button variant="ghost" onClick={() => setConfirming(false)}>Vazgeç</Button>
          </>}
        </div></section>
      )}
    </div>
  );
}

function PortalQuestion({ n, q, ans, editable, save }: { n: number; q: PortalAssessmentDetail['questions'][number]; ans: PortalAssessmentDetail['answers'][number] | undefined; editable: boolean;
  save: (b: { response: PResponse; naReason: string | null; note: string | null }) => Promise<unknown> }) {
  const [edit, setEdit] = useState(false);
  const [f, setF] = useState({ response: (ans?.response ?? '') as PResponse | '', naReason: ans?.naReason ?? '', note: ans?.note ?? '' });
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const na = f.response === 'NOT_APPLICABLE';
  const onSave = async () => {
    if (!f.response) return;
    setBusy(true); setErr(null);
    try { await save({ response: f.response, naReason: na ? f.naReason.trim() : null, note: f.note.trim() || null }); setEdit(false); }
    catch (e) { setErr((e as ApiError).message); }
    finally { setBusy(false); }
  };
  const showForm = editable && (edit || !ans);
  return (
    <section className="panel"><div className="panel-body grid gap-2">
      <div className="flex flex-wrap items-baseline gap-2"><span className="tabular text-sm text-ink-subtle">{n}.</span><span className="mono text-sm">{q.controlId}</span>
        {q.evidenceRequired && <span className="text-sm text-ink-subtle">Kurum kanıt belgesi isteyecek</span>}</div>
      <p className="font-semibold">{q.text}</p>
      {showForm ? (
        <form className="grid gap-2" onSubmit={(e) => { e.preventDefault(); void onSave(); }}>
          <fieldset className="flex flex-wrap gap-x-4 gap-y-1"><legend className="sr-only">{n}. soru yanıtı</legend>
            {(Object.keys(RESPONSE) as PResponse[]).filter((k) => k !== 'UNKNOWN').map((k) => (
              <label key={k} className="inline-flex items-center gap-1.5 text-sm"><input type="radio" name={`r-${q.id}`} value={k} checked={f.response === k} onChange={() => setF({ ...f, response: k })} />{RESPONSE[k]}</label>
            ))}
          </fieldset>
          {na && <Field label="Neden uygulanamaz?">{(p) => <input className="input" required maxLength={1000} {...p} value={f.naReason} onChange={(e) => setF({ ...f, naReason: e.target.value })} />}</Field>}
          <Field label="Açıklama" hint="İsteğe bağlı: nasıl uyguladığınız, kapsam, istisnalar.">{(p) => <textarea className="input" rows={2} maxLength={2000} {...p} value={f.note} onChange={(e) => setF({ ...f, note: e.target.value })} />}</Field>
          {err && <p role="alert" className="text-sm text-danger">{err}</p>}
          <div className="flex gap-2"><Button type="submit" size="sm" disabled={busy || !f.response || (na && !f.naReason.trim())}>Yanıtı kaydet</Button>
            {ans && <Button type="button" size="sm" variant="ghost" onClick={() => { setEdit(false); setErr(null); }}>Vazgeç</Button>}</div>
        </form>
      ) : ans ? (
        <div className="flex flex-wrap items-baseline gap-2">
          <p className="min-w-0 flex-1 text-sm"><strong>{RESPONSE[ans.response]}</strong>{ans.naReason ? ` · gerekçe: ${ans.naReason}` : ''}{ans.note ? ` · ${ans.note}` : ''}</p>
          {editable && <Button size="sm" variant="outline" onClick={() => setEdit(true)}>Değiştir</Button>}
        </div>
      ) : <p className="text-sm text-ink-muted">Yanıtlanmadı.</p>}
    </div></section>
  );
}
