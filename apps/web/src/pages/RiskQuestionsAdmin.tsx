// v2 Faz 6 (D111) Görev 7: Yönetim > Şablonlar > Risk soruları. Soru setleri sürümlüdür; yayımlanan set değişmez, aynı koddaki önceki
// yayımlı sürüm emekliye ayrılır (Görev 3). Kurumun 26 soruluk şablonu verilmedi (§9 #2): uygulama soru içermeden gelir, örnek soru yok.
// Yönetici set girer ve yayımlar; Satınalma listeyi okur. Son tarih ayarı (gün) Yönetici ve Satınalma'ya açıktır.
import { useState } from 'react';
import { api, ApiError } from '../lib/api.ts';
import { useResource } from '../lib/useApi.ts';
import { fmtDateTime } from '../lib/format.ts';
import { hasPermission, useSession } from '../lib/session.tsx';
import { Banner, Empty, ErrorState, Field, Loading, Modal, Tag } from '../ui/kit.tsx';
import { Button } from '@/components/ui/button';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';

interface SetRow { id: string; code: string; version: number; name: string; scopeNote: string | null; status: string; questionCount: number; totalWeight: string;
  createdAt: string; publishedAt: string | null }
interface SetDetail extends SetRow { questions: { id: string; ordinal: number; code: string; text: string; weight: string; riskAnswer: 'YES' | 'NO'; guidance: string | null }[] }
const STATUS: Record<string, { text: string; tone: 'ok' | 'info' | 'neutral'; icon: string }> = {
  DRAFT: { text: 'Taslak', tone: 'info', icon: 'pen' }, PUBLISHED: { text: 'Yayımlandı', tone: 'ok', icon: 'check' }, RETIRED: { text: 'Emekli', tone: 'neutral', icon: 'archive' },
};

export function RiskQuestionsAdmin() {
  const { me } = useSession();
  const r = useResource<{ items: SetRow[]; can: { manage: boolean } }>('/api/v1/risk/question-sets');
  const [form, setForm] = useState<null | { from: SetDetail | null }>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [publish, setPublish] = useState<SetRow | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const manage = !!r.data?.can.manage;
  const items = r.data?.items ?? [];

  async function startFrom(id: string) {
    try { setForm({ from: (await api<SetDetail>(`/api/v1/risk/question-sets/${id}`)).data }); } catch (e) { setError((e as ApiError).message); }
  }
  async function doPublish(s: SetRow) {
    setError(null);
    try { await api(`/api/v1/risk/question-sets/${s.id}/publish`, { method: 'POST' }); setNotice(`${s.name} (${s.code} v${s.version}) yayımlandı.`); setPublish(null); await r.reload(); }
    catch (e) { setError((e as ApiError).message); setPublish(null); }
  }

  return (
    <div className="page">
      <div className="mb-5 flex flex-wrap items-end gap-4">
        <div className="min-w-[240px] flex-1">
          <h1>Risk soruları</h1>
          <p className="mt-1 max-w-[75ch] text-ink-muted">Yıllık risk değerlendirmesinin "Tedarikçi Riski Değerlendirme Şablonu" soruları: her soru ağırlıklı, riskli cevap (Evet/Hayır) soru başına seçilir.
            Risk skoru = riskli cevapların ağırlığı / toplam ağırlık × 100. Yayımlanan set değiştirilemez; değişiklik yeni sürümle yapılır.</p>
        </div>
        {manage && !form && <Button onClick={() => setForm({ from: null })}>Yeni soru seti</Button>}
      </div>
      {notice && <Banner tone="info" icon="check" title={notice} />}
      {error && <Banner tone="danger" title={error} />}
      {form && <SetForm from={form.from} onCancel={() => setForm(null)} onDone={async (s) => { setForm(null); setNotice(`${s.name} (${s.code} v${s.version}) taslak olarak kaydedildi; yayımlayınca değerlendirmelerde seçilebilir.`); await r.reload(); }} />}
      {r.loading && !r.data ? <Loading /> : r.error ? <ErrorState error={r.error} onRetry={r.reload} /> : !items.length ? (
        <div className="rounded-md border border-border bg-surface"><Empty icon="file" title="Kurumun 26 soruluk şablonu henüz girilmedi.">
          Soru seti yayımlanana dek değerlendirmelerde şablon dışında hesaplanan sonuç elle girilir ve "Elle girilen şablon sonucu" diye işaretlenir.
          {manage ? ' Kurumun şablonunu "Yeni soru seti" ile girin.' : ' Soruları Yönetici girer.'}</Empty></div>
      ) : (
        <Table aria-label="Risk soru setleri">
          <TableHeader><TableRow className="hover:bg-transparent">
            <TableHead scope="col">Set</TableHead><TableHead scope="col">Sürüm</TableHead><TableHead scope="col">Durum</TableHead><TableHead scope="col" className="text-right">Soru</TableHead>
            <TableHead scope="col" className="text-right">Toplam ağırlık</TableHead><TableHead scope="col" className="max-[900px]:hidden">Yayım</TableHead><TableHead scope="col"><span className="sr-only">Eylemler</span></TableHead>
          </TableRow></TableHeader>
          <TableBody>{items.map((s) => <SetRowView key={s.id} s={s} open={open === s.id} onToggle={() => setOpen(open === s.id ? null : s.id)} manage={manage}
            onPublish={() => setPublish(s)} onNewVersion={() => void startFrom(s.id)} />)}</TableBody>
        </Table>
      )}
      {hasPermission(me, 'risk.cycle.manage') && <DueDaysCard />}
      {publish && <Modal title="Soru setini yayımla" onClose={() => setPublish(null)} footer={<>
        <Button variant="outline" onClick={() => setPublish(null)}>Vazgeç</Button><Button onClick={() => void doPublish(publish)}>Yayımla</Button></>}>
        <p>{publish.name} ({publish.code} v{publish.version}, {publish.questionCount} soru, toplam ağırlık {publish.totalWeight.replace('.', ',')}) yayımlanacak.
          Yayımlanan set değiştirilemez; aynı koddaki önceki yayımlı sürüm emekliye ayrılır. Yayımlı set varken değerlendirmelerde elle sonuç girilemez.</p>
      </Modal>}
    </div>
  );
}

function SetRowView({ s, open, onToggle, manage, onPublish, onNewVersion }: { s: SetRow; open: boolean; onToggle: () => void; manage: boolean; onPublish: () => void; onNewVersion: () => void }) {
  const d = useResource<SetDetail>(open ? `/api/v1/risk/question-sets/${s.id}` : null);
  return <>
    <TableRow>
      <TableCell className="min-w-[200px]"><span className="font-semibold">{s.name}</span><span className="block text-sm text-ink-subtle">{s.code}{s.scopeNote ? ` · ${s.scopeNote}` : ''}</span></TableCell>
      <TableCell className="tabular">v{s.version}</TableCell>
      <TableCell><Tag label={STATUS[s.status] ?? { text: s.status, tone: 'neutral', icon: 'minus' }} /></TableCell>
      <TableCell className="tabular text-right">{s.questionCount}</TableCell>
      <TableCell className="tabular text-right">{s.totalWeight.replace('.', ',')}</TableCell>
      <TableCell className="whitespace-nowrap text-sm max-[900px]:hidden">{s.publishedAt ? fmtDateTime(s.publishedAt) : '—'}</TableCell>
      <TableCell><div className="flex flex-wrap gap-1">
        <Button size="sm" variant="ghost" aria-expanded={open} onClick={onToggle}>{open ? 'Soruları gizle' : 'Sorular'}</Button>
        {manage && s.status === 'DRAFT' && <Button size="sm" onClick={onPublish}>Yayımla</Button>}
        {manage && <Button size="sm" variant="outline" onClick={onNewVersion}>Yeni sürüm</Button>}
      </div></TableCell>
    </TableRow>
    {open && <TableRow className="hover:bg-transparent"><TableCell colSpan={7} className="bg-paper">
      {d.loading && !d.data ? <Loading rows={2} /> : d.error ? <ErrorState error={d.error} /> : d.data && <ol className="grid gap-1.5" aria-label={`${s.name} soruları`}>{d.data.questions.map((q) => (
        <li key={q.id} className="text-sm"><span className="font-semibold">{q.code}.</span> {q.text} <span className="text-ink-subtle">· ağırlık {q.weight.replace('.', ',')} · riskli cevap {q.riskAnswer === 'YES' ? 'Evet' : 'Hayır'}{q.guidance ? ` · ${q.guidance}` : ''}</span></li>))}</ol>}
    </TableCell></TableRow>}
  </>;
}

interface QRow { code: string; text: string; weight: string; riskAnswer: 'YES' | 'NO'; guidance: string }
const emptyQ = (n: number): QRow => ({ code: `S${n}`, text: '', weight: '', riskAnswer: 'YES', guidance: '' });

function SetForm({ from, onCancel, onDone }: { from: SetDetail | null; onCancel: () => void; onDone: (s: SetDetail) => Promise<void> }) {
  const [code, setCode] = useState(from?.code ?? '');
  const [name, setName] = useState(from?.name ?? '');
  const [scopeNote, setScopeNote] = useState(from?.scopeNote ?? '');
  const [qs, setQs] = useState<QRow[]>(from ? from.questions.map((q) => ({ code: q.code, text: q.text, weight: q.weight.replace('.', ','), riskAnswer: q.riskAnswer, guidance: q.guidance ?? '' })) : [emptyQ(1)]);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const w = (s: string) => Number(s.trim().replace(',', '.'));
  const total = qs.reduce((t, q) => t + (Number.isFinite(w(q.weight)) ? w(q.weight) : 0), 0);
  const set = (i: number, patch: Partial<QRow>) => setQs((x) => x.map((q, n) => (n === i ? { ...q, ...patch } : q)));
  async function submit() {
    setErr(null);
    if (!code.trim() || !name.trim()) { setErr('Set kodu ve adı zorunlu.'); return; }
    if (!qs.length || qs.some((q) => !q.code.trim() || q.text.trim().length < 3 || !(w(q.weight) > 0))) { setErr('Her soruda kod, metin ve sıfırdan büyük ağırlık olmalı.'); return; }
    setBusy(true);
    try {
      const r = await api<SetDetail>('/api/v1/risk/question-sets', { method: 'POST', json: { code: code.trim(), name: name.trim(), scopeNote: scopeNote.trim() || null,
        questions: qs.map((q) => ({ code: q.code.trim(), text: q.text.trim(), weight: q.weight.trim().replace(',', '.'), riskAnswer: q.riskAnswer, guidance: q.guidance.trim() || null })) } });
      await onDone(r.data);
    } catch (e) { setErr((e as ApiError).message); } finally { setBusy(false); }
  }
  return (
    <form className="panel mb-4" onSubmit={(e) => { e.preventDefault(); void submit(); }} aria-labelledby="sf-h">
      <div className="panel-head"><h3 id="sf-h">{from ? `Yeni sürüm: ${from.code} (v${from.version} temel alınır)` : 'Yeni soru seti'}</h3></div>
      <div className="panel-body grid gap-3">
        <div className="grid gap-x-3 min-[900px]:grid-cols-3">
          <Field label="Set kodu" hint="Aynı kodla yeni sürüm açılır">{(p) => <input className="input mono" {...p} value={code} onChange={(e) => setCode(e.target.value)} readOnly={!!from} />}</Field>
          <Field label="Set adı">{(p) => <input className="input" {...p} value={name} onChange={(e) => setName(e.target.value)} />}</Field>
          <Field label="Kapsam notu" hint="Hangi hizmetler için">{(p) => <input className="input" {...p} value={scopeNote} onChange={(e) => setScopeNote(e.target.value)} />}</Field>
        </div>
        <ol className="grid gap-3" aria-label="Sorular">{qs.map((q, i) => (
          <li key={i} className="grid gap-x-3 rounded-md border border-border p-3 min-[900px]:grid-cols-[110px_minmax(0,1fr)_110px_140px]">
            <Field label={`Soru ${i + 1} kodu`}>{(p) => <input className="input mono" {...p} value={q.code} onChange={(e) => set(i, { code: e.target.value })} />}</Field>
            <Field label={`Soru ${i + 1} metni`}>{(p) => <input className="input" {...p} value={q.text} onChange={(e) => set(i, { text: e.target.value })} />}</Field>
            <Field label="Ağırlık">{(p) => <input className="input tabular" inputMode="decimal" {...p} value={q.weight} onChange={(e) => set(i, { weight: e.target.value })} />}</Field>
            <Field label="Riskli cevap">{(p) => <select className="input" {...p} value={q.riskAnswer} onChange={(e) => set(i, { riskAnswer: e.target.value as 'YES' | 'NO' })}>
              <option value="YES">Evet</option><option value="NO">Hayır</option></select>}</Field>
            <div className="min-[900px]:col-span-3"><Field label="Açıklama (isteğe bağlı)">{(p) => <input className="input" {...p} value={q.guidance} onChange={(e) => set(i, { guidance: e.target.value })} />}</Field></div>
            <Button type="button" variant="ghost" size="sm" className="self-center justify-self-start" disabled={qs.length === 1} onClick={() => setQs((x) => x.filter((_, n) => n !== i))}>Soruyu kaldır</Button>
          </li>))}</ol>
        <div className="flex flex-wrap items-center gap-3">
          <Button type="button" variant="outline" onClick={() => setQs((x) => [...x, emptyQ(x.length + 1)])}>Soru ekle</Button>
          <span className="text-sm">Toplam ağırlık: <strong className="tabular">{total.toLocaleString('tr-TR', { maximumFractionDigits: 2 })}</strong> · {qs.length} soru</span>
        </div>
        {err && <Banner tone="danger" title={err} />}
        <div className="flex gap-2"><Button type="submit" disabled={busy}>Taslak olarak kaydet</Button><Button type="button" variant="ghost" onClick={onCancel}>Vazgeç</Button></div>
      </div>
    </form>
  );
}

function DueDaysCard() {
  const r = useResource<{ dueDays: number; defaultDueDays: number; isDefault: boolean; updatedAt: string | null }>('/api/v1/settings/risk');
  const [v, setV] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ tone: 'info' | 'danger'; text: string } | null>(null);
  const value = v ?? (r.data ? String(r.data.dueDays) : '');
  return (
    <section className="panel mt-6" aria-labelledby="due-h">
      <div className="panel-head"><h3 id="due-h">Değerlendirme son tarihi</h3></div>
      <div className="panel-body">
        {r.loading && !r.data ? <Loading rows={1} /> : r.error ? <ErrorState error={r.error} onRetry={r.reload} /> : <form className="flex flex-wrap items-end gap-2" onSubmit={(e) => {
          e.preventDefault(); setMsg(null);
          void api('/api/v1/settings/risk', { method: 'PUT', json: { dueDays: Number(value) } }).then(async () => { setMsg({ tone: 'info', text: 'Son tarih süresi kaydedildi; yeni açılan değerlendirmelere uygulanır.' }); setV(null); await r.reload(); },
            (x: ApiError) => setMsg({ tone: 'danger', text: x.message }));
        }}>
          <Field label="Açılıştan sonra gün" hint={`7–365 gün. Varsayılan ${r.data?.defaultDueDays ?? 90}${r.data?.isDefault ? ' (şu an varsayılan)' : ''}.`}>{(p) => <input className="input tabular w-28" inputMode="numeric" {...p}
            value={value} onChange={(e) => setV(e.target.value)} />}</Field>
          <Button type="submit" variant="outline" className="mb-4">Kaydet</Button>
        </form>}
        {msg && <Banner tone={msg.tone} title={msg.text} />}
      </div>
    </section>
  );
}
