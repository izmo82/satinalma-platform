import { useState, type ReactNode } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { api, apiBlob, ApiError } from '../lib/api.ts';
import { useResource } from '../lib/useApi.ts';
import { hasRole, useSession } from '../lib/session.tsx';
import { fmtDate, fmtDateTime, fmtMoney, shortHash } from '../lib/format.ts';
import { todayLocal } from '../lib/format.ts';
import type { Label } from '../lib/labels.ts';
import { Banner, Empty, ErrorState, Field, Loading, PageHeader, Tag } from '../ui/kit.tsx';
import { Icon } from '../ui/icons.tsx';
import { Button } from '@/components/ui/button';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { cn } from '@/lib/utils';

// Faz 7: veri yönetimi (saklama, hukuki saklama, imha, dışa aktarım; T48) ve ERP mutabakatı.

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

const KIND_TR: Record<string, string> = { INVOICE: 'Fatura', CONTRACT: 'Sözleşme', QUOTE: 'Teklif', OTHER: 'Diğer' };
const VERDICT_TR: Record<string, string> = { NO_POLICY: 'Politika yok', NOT_DUE: 'Süresi dolmadı', LEGAL_HOLD: 'Hukuki saklamada', ALREADY_DISPOSED: 'İmha edilmiş' };
const BATCH: Record<string, Label> = {
  PROPOSED: { text: 'Onay bekliyor', tone: 'warn', icon: 'clock' },
  REJECTED: { text: 'Reddedildi', tone: 'neutral', icon: 'x' },
  APPROVED: { text: 'Onaylandı', tone: 'info', icon: 'check' },
  EXECUTED: { text: 'İmha edildi', tone: 'human', icon: 'stamp' },
};
const EXPORT: Record<string, Label> = {
  REQUESTED: { text: 'Onay bekliyor', tone: 'warn', icon: 'clock' },
  REJECTED: { text: 'Reddedildi', tone: 'neutral', icon: 'x' },
  APPROVED: { text: 'Hazırlanıyor', tone: 'info', icon: 'refresh' },
  READY: { text: 'Hazır', tone: 'ok', icon: 'check' },
  FAILED: { text: 'Hata', tone: 'danger', icon: 'x' },
};
const HOLD_SCOPE: Record<string, string> = { TENANT: 'Tüm kiracı', COMPANY: 'Şirket', DOCUMENT: 'Belge' };

interface Overview {
  policies: { documentKind: string; retentionMonths: number; legalBasis: string; updatedBy: string; updatedAt: string }[];
  holds: { id: string; scope: string; companyName: string | null; documentId: string | null; documentTitle: string | null; documentCode: string | null; matterRef: string; reason: string;
    createdBy: string; createdAt: string; releasedBy: string | null; releasedAt: string | null; releaseReason: string | null }[];
  batches: { id: string; status: string; reason: string; proposedBy: string; proposedAt: string; decidedBy: string | null; decidedAt: string | null; itemCount: number;
    result: null | { disposed: number; skipped: { documentId: string; reason: string }[] } }[];
  can: { managePolicy: boolean; manageHold: boolean; propose: boolean; approve: boolean };
}
interface Candidates { asOf: string; summary: Record<string, number>; candidates: { id: string; code: string | null; title: string; kind: string; companyName: string; dueOn: string; versions: number; inOpenBatch: boolean }[] }

const TABS = [['saklama', 'Saklama ve imha'], ['hukuki', 'Hukuki saklama'], ['disa-aktarim', 'Dışa aktarım']] as const;

export function DataGovernancePage() {
  const [params, setParams] = useSearchParams();
  const tab = (params.get('sekme') ?? 'saklama') as (typeof TABS)[number][0];
  const r = useResource<Overview>('/api/v1/retention');
  return (
    <div className="page">
      <PageHeader title="Veri yönetimi">
        Saklama süresi belge türüne göre ve dayanağıyla tanımlanır; tanımsız tür süresiz saklanır. Hukuki saklama imhayı her koşulda durdurur. İmha ve kiracı dışa aktarımı iki kişinin onayıyla yürür.
      </PageHeader>
      <div role="tablist" aria-label="Veri yönetimi" className="mb-4 flex gap-6 overflow-x-auto border-b border-border">
        {TABS.map(([k, l]) => (
          <button key={k} role="tab" aria-selected={tab === k} onClick={() => { const p = new URLSearchParams(params); k === 'saklama' ? p.delete('sekme') : p.set('sekme', k); setParams(p, { replace: true }); }}
            className={cn('-mb-px min-h-10 whitespace-nowrap border-b-2 font-semibold transition-colors duration-150', tab === k ? 'border-ink text-ink' : 'border-transparent text-ink-muted hover:text-ink')}>{l}</button>
        ))}
      </div>
      {tab === 'disa-aktarim' ? <ExportsTab /> : r.loading && !r.data ? <Loading rows={6} /> : r.error || !r.data ? <ErrorState error={r.error} onRetry={r.reload} />
        : tab === 'hukuki' ? <HoldsTab d={r.data} reload={r.reload} /> : <RetentionTab d={r.data} reload={r.reload} />}
    </div>
  );
}

function RetentionTab({ d, reload }: { d: Overview; reload: () => Promise<void> }) {
  const c = useResource<Candidates>('/api/v1/retention/candidates');
  const a = useAct(async () => { await reload(); await c.reload(); });
  const [editing, setEditing] = useState<string | null>(null);
  const [picked, setPicked] = useState<string[]>([]);
  const [reason, setReason] = useState('');
  const [holdFor, setHoldFor] = useState<{ id: string; title: string } | null>(null);
  const [holdDone, setHoldDone] = useState<string | null>(null);
  const reloadAll = async () => { await reload(); await c.reload(); };
  return (
    <div className="grid gap-5">
      {a.feedback}
      {holdDone && <Banner tone="info" icon="check" title={holdDone} />}
      <section className="panel"><div className="panel-head"><h2>Saklama politikası</h2><span className="text-sm text-ink-subtle">Süre, belgenin son sürüm tarihinden işler.</span></div>
        <Table><TableHeader><TableRow className="hover:bg-transparent"><TableHead>Belge türü</TableHead><TableHead>Süre</TableHead><TableHead>Dayanak</TableHead><TableHead className="max-[900px]:hidden">Son değişiklik</TableHead>{d.can.managePolicy && <TableHead><span className="sr-only">İşlem</span></TableHead>}</TableRow></TableHeader>
          <TableBody>{Object.keys(KIND_TR).map((k) => {
            const p = d.policies.find((x) => x.documentKind === k);
            if (editing === k) return <TableRow key={k}><TableCell colSpan={5}><PolicyForm kind={k} p={p} busy={a.busy} onCancel={() => setEditing(null)}
              onSubmit={(b) => a.run(() => api(`/api/v1/retention/policies/${k}`, { method: 'PUT', json: b }), `${KIND_TR[k]} için saklama süresi kaydedildi.`).then((ok) => { if (ok) setEditing(null); })} /></TableCell></TableRow>;
            return <TableRow key={k}>
              <TableCell className="font-semibold">{KIND_TR[k]}</TableCell>
              <TableCell className="tabular">{p ? `${p.retentionMonths} ay` : <span className="text-ink-muted">Tanımsız: süresiz saklanır</span>}</TableCell>
              <TableCell className="text-sm">{p?.legalBasis ?? '—'}</TableCell>
              <TableCell className="text-sm text-ink-subtle max-[900px]:hidden">{p ? `${p.updatedBy} · ${fmtDate(p.updatedAt)}` : '—'}</TableCell>
              {d.can.managePolicy && <TableCell className="whitespace-nowrap text-right"><Button size="sm" variant="outline" aria-label={`${KIND_TR[k]} süresini ${p ? 'düzenle' : 'tanımla'}`} onClick={() => { a.clear(); setEditing(k); }}>{p ? 'Düzenle' : 'Tanımla'}</Button>
                {p && <Button size="sm" variant="ghost" aria-label={`${KIND_TR[k]} politikasını kaldır`} disabled={a.busy} onClick={() => void a.run(() => api(`/api/v1/retention/policies/${k}`, { method: 'DELETE' }), `${KIND_TR[k]} politikası kaldırıldı; bu tür süresiz saklanır.`)}>Kaldır</Button>}</TableCell>}
            </TableRow>;
          })}</TableBody></Table></section>

      <section className="panel"><div className="panel-head"><h2>İmha adayları</h2>{c.data && <span className="text-sm text-ink-subtle">{fmtDate(c.data.asOf)} itibarıyla · yalnız erişiminiz olan şirketler</span>}</div>
        <div className="panel-body">
          {c.loading && !c.data ? <Loading rows={3} /> : c.error || !c.data ? <ErrorState error={c.error} onRetry={c.reload} /> : <>
            <p className="mb-3 text-sm text-ink-muted">Aday {c.data.summary.ELIGIBLE} · politika yok {c.data.summary.NO_POLICY} · süresi dolmadı {c.data.summary.NOT_DUE} · hukuki saklamada {c.data.summary.LEGAL_HOLD} · imha edilmiş {c.data.summary.ALREADY_DISPOSED}</p>
            {!c.data.candidates.length ? <Empty icon="archive" title="İmha için uygun belge yok">Politika tanımlı türlerde süresi dolan ve hukuki saklamada olmayan belgeler burada görünür{c.data.summary.LEGAL_HOLD ? `; ${c.data.summary.LEGAL_HOLD} belge hukuki saklama nedeniyle listede değil` : ''}. Yalnız erişiminiz olan şirketlerin belgeleri sayılır.</Empty> : <>
              <Table><TableHeader><TableRow className="hover:bg-transparent">{d.can.propose && <TableHead className="w-10"><span className="sr-only">Seç</span></TableHead>}<TableHead>Belge</TableHead><TableHead>Tür</TableHead><TableHead className="max-[900px]:hidden">Şirket</TableHead><TableHead>Süre doldu</TableHead><TableHead><span className="sr-only">İşlem</span></TableHead></TableRow></TableHeader>
                <TableBody>{c.data.candidates.map((x) => (
                  <TableRow key={x.id}>
                    {d.can.propose && <TableCell><input type="checkbox" aria-label={`${x.title} seç`} disabled={x.inOpenBatch} checked={picked.includes(x.id)}
                      onChange={(e) => setPicked(e.target.checked ? [...picked, x.id] : picked.filter((p) => p !== x.id))} /></TableCell>}
                    <TableCell><span className="font-semibold">{x.title}</span>{x.code && <span className="mono ml-2 text-sm text-ink-subtle">{x.code}</span>}
                      {x.inOpenBatch && <span className="block text-sm text-warn">Onay bekleyen bir imha partisinde</span>}</TableCell>
                    <TableCell>{KIND_TR[x.kind] ?? x.kind}</TableCell>
                    <TableCell className="max-[900px]:hidden">{x.companyName}</TableCell>
                    <TableCell className="tabular whitespace-nowrap">{fmtDate(x.dueOn)}{(() => { const p = d.policies.find((y) => y.documentKind === x.kind); return p ? <span className="block text-sm text-ink-subtle">son sürümden {p.retentionMonths} ay</span> : null; })()}</TableCell>
                    <TableCell className="text-right">{d.can.manageHold && <Button size="sm" variant="ghost" aria-label={`${x.title} belgesini hukuki saklamaya al`} onClick={() => setHoldFor({ id: x.id, title: x.title })}>Saklamaya al</Button>}</TableCell>
                  </TableRow>))}</TableBody></Table>
              {d.can.propose && <form className="mt-4 grid max-w-xl gap-2" onSubmit={(e) => { e.preventDefault(); void a.run(() => api('/api/v1/disposal-batches', { method: 'POST', json: { documentIds: picked, reason } }),
                `${picked.length} belge için imha önerildi; başka bir hukuk yetkilisinin onayı bekleniyor.`).then((ok) => { if (ok) { setPicked([]); setReason(''); } }); }}>
                <Field label="İmha gerekçesi" hint="En az 10 karakter. Öneren kişi onaylayamaz.">{(x) => <textarea className="input min-h-16" {...x} value={reason} onChange={(e) => setReason(e.target.value)} />}</Field>
                <div><Button type="submit" disabled={a.busy || !picked.length || reason.trim().length < 10}>Seçilen {picked.length} belge için imha öner</Button></div>
              </form>}
            </>}
          </>}
        </div></section>

      <section className="panel"><div className="panel-head"><h2>İmha partileri</h2></div>
        <div className="panel-body">{!d.batches.length ? <p className="text-ink-muted">Henüz imha önerisi yok.</p> : <ul className="grid gap-2">{d.batches.map((b) => (
          <li key={b.id} className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
            <Tag label={BATCH[b.status]} /><Link to={`/veri-yonetimi/imha/${b.id}`} className="font-semibold" aria-label={`${b.itemCount} belgelik imha partisi, ${BATCH[b.status]?.text ?? b.status}, ${fmtDateTime(b.proposedAt)}`}>{b.itemCount} belge</Link>
            <span className="text-sm text-ink-muted">{b.proposedBy} · {fmtDateTime(b.proposedAt)}{b.decidedBy ? ` · karar: ${b.decidedBy}` : ''}</span>
            {b.result && <span className="text-sm">{b.result.disposed} imha edildi{b.result.skipped.length ? `, ${b.result.skipped.length} atlandı` : ''}</span>}
          </li>))}</ul>}</div></section>

      {holdFor && <HoldDialog doc={holdFor} onClose={() => setHoldFor(null)} onDone={async () => { setHoldDone(`"${holdFor.title}" hukuki saklamaya alındı; saklama kaldırılana kadar imha edilemez.`); await reloadAll(); }} />}
    </div>
  );
}

function PolicyForm({ kind, p, busy, onSubmit, onCancel }: { kind: string; p?: Overview['policies'][number]; busy: boolean; onSubmit: (b: { retentionMonths: number; legalBasis: string }) => void; onCancel: () => void }) {
  const [months, setMonths] = useState(p?.retentionMonths.toString() ?? '');
  const [basis, setBasis] = useState(p?.legalBasis ?? '');
  const n = Number(months);
  return (
    <form className="grid grid-cols-[140px_minmax(0,1fr)_auto] items-start gap-3 max-[700px]:grid-cols-1" onSubmit={(e) => { e.preventDefault(); onSubmit({ retentionMonths: n, legalBasis: basis.trim() }); }}>
      <Field label={`${KIND_TR[kind]}: süre (ay)`}>{(x) => <input className="input tabular text-right" inputMode="numeric" {...x} value={months} onChange={(e) => setMonths(e.target.value.replace(/\D/g, ''))} />}</Field>
      <Field label="Dayanak" hint="Mevzuat maddesi veya kurum politikası; tek evrensel süre yoktur.">{(x) => <input className="input" maxLength={500} {...x} value={basis} onChange={(e) => setBasis(e.target.value)} />}</Field>
      <div className="flex gap-2 pt-6 max-[700px]:pt-0"><Button type="submit" size="sm" disabled={busy || !(n >= 1 && n <= 1200) || basis.trim().length < 5}>Kaydet</Button><Button type="button" size="sm" variant="ghost" onClick={onCancel}>Vazgeç</Button></div>
    </form>
  );
}

function HoldDialog({ doc, onClose, onDone }: { doc: { id: string; title: string }; onClose: () => void; onDone: () => Promise<void> }) {
  const [f, setF] = useState({ matterRef: '', reason: '' });
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  return (
    <div role="dialog" aria-modal="true" aria-labelledby="hold-title" className="fixed inset-0 z-50 grid place-items-center bg-black/30 p-4">
      <form className="w-full max-w-lg rounded-lg border border-border bg-surface p-5 shadow-lg" onSubmit={async (e) => {
        e.preventDefault(); setBusy(true); setErr(null);
        try { await api('/api/v1/legal-holds', { method: 'POST', json: { scope: 'DOCUMENT', documentId: doc.id, ...f } }); await onDone(); onClose(); }
        catch (x) { setErr((x as ApiError).message); } finally { setBusy(false); }
      }}>
        <h2 id="hold-title" className="mb-1 text-lg font-bold">Hukuki saklamaya al</h2>
        <p className="mb-4 text-sm text-ink-muted">{doc.title} — saklama kaldırılana kadar imha edilemez.</p>
        {err && <Banner tone="danger" title={err} />}
        <Field label="Dosya / talep referansı">{(x) => <input className="input" required maxLength={200} {...x} value={f.matterRef} onChange={(e) => setF({ ...f, matterRef: e.target.value })} />}</Field>
        <Field label="Gerekçe" hint="En az 10 karakter.">{(x) => <textarea className="input min-h-16" {...x} value={f.reason} onChange={(e) => setF({ ...f, reason: e.target.value })} />}</Field>
        <div className="flex justify-end gap-2"><Button type="button" variant="ghost" onClick={onClose}>Vazgeç</Button><Button type="submit" disabled={busy || !f.matterRef.trim() || f.reason.trim().length < 10}>Saklamaya al</Button></div>
      </form>
    </div>
  );
}

function HoldsTab({ d, reload }: { d: Overview; reload: () => Promise<void> }) {
  const { me } = useSession();
  const a = useAct(reload);
  const [f, setF] = useState({ scope: 'COMPANY', companyId: me?.companies[0]?.id ?? '', matterRef: '', reason: '' });
  const [releasing, setReleasing] = useState<string | null>(null);
  const [releaseReason, setReleaseReason] = useState('');
  const active = d.holds.filter((h) => !h.releasedAt);
  const past = d.holds.filter((h) => h.releasedAt);
  const row = (h: Overview['holds'][number]) => (
    <li key={h.id} className="grid gap-0.5 border-b border-border py-2 last:border-0">
      <div className="flex flex-wrap items-baseline gap-x-3"><Tag label={{ text: HOLD_SCOPE[h.scope] ?? h.scope, tone: h.releasedAt ? 'neutral' : 'human', icon: 'lock' }} />
        <span className="font-semibold">{h.scope === 'COMPANY' ? h.companyName : h.scope === 'DOCUMENT' ? (h.documentTitle ? `${h.documentTitle}${h.documentCode ? ` (${h.documentCode})` : ''}` : 'Erişiminiz dışındaki bir belge') : 'Kiracıdaki tüm belgeler'}</span>
        <span className="mono text-sm text-ink-subtle">{h.matterRef}</span></div>
      <span className="text-sm text-ink-muted">{h.reason} · {h.createdBy}, {fmtDateTime(h.createdAt)}</span>
      {h.releasedAt && <span className="text-sm text-ink-subtle">Kaldırıldı: {h.releasedBy}, {fmtDateTime(h.releasedAt)} — {h.releaseReason}</span>}
      {!h.releasedAt && d.can.manageHold && (releasing === h.id ? (
        <form className="mt-1 flex flex-wrap items-end gap-2" onSubmit={(e) => { e.preventDefault(); void a.run(() => api(`/api/v1/legal-holds/${h.id}/release`, { method: 'POST', json: { reason: releaseReason } }), 'Hukuki saklama kaldırıldı.').then((ok) => { if (ok) { setReleasing(null); setReleaseReason(''); } }); }}>
          <Field label="Kaldırma gerekçesi" hint="En az 10 karakter.">{(x) => <input className="input min-w-72" {...x} value={releaseReason} onChange={(e) => setReleaseReason(e.target.value)} />}</Field>
          <Button type="submit" size="sm" className="mb-4" disabled={a.busy || releaseReason.trim().length < 10}>Kaldır</Button><Button type="button" size="sm" variant="ghost" className="mb-4" onClick={() => setReleasing(null)}>Vazgeç</Button>
        </form>) : <div><Button size="sm" variant="outline" onClick={() => { a.clear(); setReleasing(h.id); }}>Saklamayı kaldır</Button></div>)}
    </li>);
  return (
    <div className="grid grid-cols-[minmax(0,1fr)_360px] gap-6 max-[1100px]:grid-cols-1">
      <div className="grid content-start gap-5">
        {a.feedback}
        <section className="panel"><div className="panel-head"><h2>Etkin hukuki saklamalar</h2><span className="text-sm text-ink-subtle">{active.length}</span></div>
          <div className="panel-body">{!active.length ? <p className="text-ink-muted">Etkin hukuki saklama yok.</p> : <ul>{active.map(row)}</ul>}</div></section>
        {past.length > 0 && <section className="panel"><div className="panel-head"><h2>Kaldırılanlar</h2></div><div className="panel-body"><ul>{past.map(row)}</ul></div></section>}
      </div>
      {d.can.manageHold && <aside><section className="panel"><div className="panel-head"><h2>Yeni hukuki saklama</h2></div>
        <form className="panel-body grid gap-1" onSubmit={(e) => { e.preventDefault(); void a.run(() => api('/api/v1/legal-holds', { method: 'POST', json: { scope: f.scope, companyId: f.scope === 'COMPANY' ? f.companyId : null, matterRef: f.matterRef, reason: f.reason } }),
          'Hukuki saklama başlatıldı; kapsamdaki belgeler imha edilemez.').then((ok) => { if (ok) setF({ ...f, matterRef: '', reason: '' }); }); }}>
          <Field label="Kapsam">{(x) => <select className="input" {...x} value={f.scope} onChange={(e) => setF({ ...f, scope: e.target.value })}><option value="COMPANY">Şirket</option><option value="TENANT">Tüm kiracı</option></select>}</Field>
          {f.scope === 'COMPANY' && <Field label="Şirket">{(x) => <select className="input" {...x} value={f.companyId} onChange={(e) => setF({ ...f, companyId: e.target.value })}>{me?.companies.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select>}</Field>}
          <Field label="Dosya / talep referansı">{(x) => <input className="input" maxLength={200} {...x} value={f.matterRef} onChange={(e) => setF({ ...f, matterRef: e.target.value })} />}</Field>
          <Field label="Gerekçe" hint="En az 10 karakter. Tek belge için imha adayları listesinde 'Saklamaya al' kullanın.">{(x) => <textarea className="input min-h-16" {...x} value={f.reason} onChange={(e) => setF({ ...f, reason: e.target.value })} />}</Field>
          <div><Button type="submit" disabled={a.busy || !f.matterRef.trim() || f.reason.trim().length < 10 || (f.scope === 'COMPANY' && !f.companyId)}>Saklamayı başlat</Button></div>
        </form></section></aside>}
    </div>
  );
}

interface Exports { items: { id: string; status: string; reason: string; requestedBy: string; requestedById: string; requestedAt: string; decidedBy: string | null; decidedAt: string | null; decisionNote: string | null;
  sizeBytes: string | null; sha256: string | null; counts: Record<string, number> | null; error: string | null; readyAt: string | null; expiresAt: string | null; expired: boolean | null }[];
  can: { request: boolean; approve: boolean }; userId: string }

/** Kiracı dışa aktarımı (K-03): isteyen Yönetici, onaylayan başka bir Satınalma kullanıcısı; Yönetim > Denetim izi'nde de kullanılır. */
export function ExportsTab() {
  const r = useResource<Exports>('/api/v1/tenant-exports');
  const a = useAct(r.reload);
  const [reason, setReason] = useState('');
  const [notes, setNotes] = useState<Record<string, string>>({});
  if (r.loading && !r.data) return <Loading rows={4} />;
  if (r.error || !r.data) return <ErrorState error={r.error} onRetry={r.reload} />;
  const d = r.data;
  const mb = (s: string | null) => (s ? `${(Number(s) / 1024 / 1024).toLocaleString('tr-TR', { maximumFractionDigits: 1 })} MB` : '—');
  async function download(id: string) {
    await a.run(async () => { const res = await api<{ url: string }>(`/api/v1/tenant-exports/${id}/download`, { method: 'POST' }); window.location.assign(res.data.url); },
      'İndirme başladı. Bağlantı kısa sürelidir ve indirme kaydedildi.');
  }
  return (
    <div className="grid gap-5">
      <Banner tone="neutral" icon="info" title="Paket içeriği">Kiracının bütün şirketlerindeki kayıtlar (satır başına JSON), özgün belge baytları ve denetim izi; her dosyanın SHA-256 değeri manifest.json içindedir. Yalnız bu kiracının verisi okunur. Politika gereği görünmeyen kayıtlar (ör. kapalı teklif zarfları) ve imha edilmiş belgelerin baytları pakette yoktur.</Banner>
      {a.feedback}
      {d.can.request && <section className="panel"><div className="panel-head"><h2>Dışa aktarım iste</h2></div>
        <form className="panel-body grid max-w-xl gap-1" onSubmit={(e) => { e.preventDefault(); void a.run(() => api('/api/v1/tenant-exports', { method: 'POST', json: { reason } }), 'Talep oluşturuldu; Satınalma onayı bekleniyor.').then((ok) => { if (ok) setReason(''); }); }}>
          <Field label="Gerekçe" hint="En az 10 karakter. Onayı Satınalma rolünden başka bir kişi verir; paketi yalnız siz indirebilirsiniz.">{(x) => <textarea className="input min-h-16" {...x} value={reason} onChange={(e) => setReason(e.target.value)} />}</Field>
          <div><Button type="submit" disabled={a.busy || reason.trim().length < 10}>Dışa aktarım iste</Button></div>
        </form></section>}
      <section className="panel"><div className="panel-head"><h2>Talepler</h2><Button size="sm" variant="ghost" onClick={() => void r.reload()}><Icon name="refresh" />Yenile</Button></div>
        <div className="panel-body">{!d.items.length ? <p className="text-ink-muted">Henüz dışa aktarım talebi yok.</p> : <ul className="grid gap-3">{d.items.map((e) => (
          <li key={e.id} className="grid gap-1 border-b border-border pb-3 last:border-0">
            <div className="flex flex-wrap items-baseline gap-x-3"><Tag label={e.status === 'READY' && e.expired ? { text: 'Süresi doldu', tone: 'neutral', icon: 'clock' } : EXPORT[e.status]} />
              <span className="font-semibold">{e.requestedBy}</span><span className="text-sm text-ink-muted">{fmtDateTime(e.requestedAt)}</span></div>
            <span className="text-sm">{e.reason}</span>
            {e.decidedBy && <span className="text-sm text-ink-muted">Karar: {e.decidedBy}, {fmtDateTime(e.decidedAt)}{e.decisionNote ? ` — ${e.decisionNote}` : ''}</span>}
            {e.status === 'READY' && <span className="tabular text-sm text-ink-muted">{mb(e.sizeBytes)} · SHA-256 <span className="mono" title={e.sha256 ?? ''}>{e.sha256 ? shortHash(e.sha256) : '—'}</span>{e.counts ? ` · ${Object.keys(e.counts).length} tablo` : ''} · {fmtDateTime(e.expiresAt)} tarihine kadar indirilebilir</span>}
            {e.error && <span className="text-sm text-danger">{e.error}</span>}
            {e.status === 'REQUESTED' && d.can.approve && e.requestedById !== d.userId && (
              <div className="flex flex-wrap items-end gap-2">
                <Field label="Karar notu">{(x) => <input className="input min-w-72" {...x} value={notes[e.id] ?? ''} onChange={(ev) => setNotes({ ...notes, [e.id]: ev.target.value })} />}</Field>
                <Button size="sm" className="mb-4" disabled={a.busy || !(notes[e.id] ?? '').trim()} onClick={() => void a.run(() => api(`/api/v1/tenant-exports/${e.id}/decision`, { method: 'POST', json: { decision: 'APPROVE', note: notes[e.id] } }), 'Onaylandı; paket hazırlanıyor.')}>Onayla</Button>
                <Button size="sm" variant="outline" className="mb-4" disabled={a.busy || !(notes[e.id] ?? '').trim()} onClick={() => void a.run(() => api(`/api/v1/tenant-exports/${e.id}/decision`, { method: 'POST', json: { decision: 'REJECT', note: notes[e.id] } }), 'Talep reddedildi.')}>Reddet</Button>
              </div>)}
            {e.status === 'REQUESTED' && e.requestedById === d.userId && <span className="text-sm text-ink-subtle">Onayı başka bir kişi verir.</span>}
            {e.status === 'READY' && !e.expired && e.requestedById === d.userId && <div><Button size="sm" variant="outline" aria-label={`${fmtDateTime(e.requestedAt)} tarihli paketi indir`} disabled={a.busy} onClick={() => void download(e.id)}><Icon name="download" />İndir</Button></div>}
          </li>))}</ul>}</div></section>
    </div>
  );
}

// --- İmha partisi ---------------------------------------------------------------------------------------

interface Batch { id: string; status: string; reason: string; proposedById: string; proposedBy: string; proposedAt: string; decidedBy: string | null; decidedAt: string | null; decisionNote: string | null; executedAt: string | null;
  result: null | { disposed: number; skipped: { documentId: string; reason: string }[]; objectKeys: number; purge?: { deleted: number; kept: number; at: string } }; hiddenItems: number; canDecide: boolean; userId: string;
  items: { documentId: string; versionId: string | null; code: string | null; title: string; kind: string; companyName: string; dueOn: string; disposed: boolean }[] }

export function DisposalBatchPage() {
  const { id } = useParams();
  const r = useResource<Batch>(`/api/v1/disposal-batches/${id}`);
  const a = useAct(r.reload);
  const [note, setNote] = useState('');
  const [confirming, setConfirming] = useState(false);
  if (r.loading && !r.data) return <div className="page"><Loading rows={6} /></div>;
  if (r.error || !r.data) return <div className="page"><ErrorState error={r.error} onRetry={r.reload} /></div>;
  const b = r.data;
  const skipped = new Map((b.result?.skipped ?? []).map((s) => [s.documentId, s.reason]));
  const mine = b.proposedById === b.userId;
  return (
    <div className="page">
      <PageHeader title="İmha partisi" actions={<Button variant="outline" asChild><Link to="/veri-yonetimi">Veri yönetimi</Link></Button>}>
        Onay anında her belge yeniden kontrol edilir: bu arada hukuki saklamaya alınan veya yeni sürüm gelen belge atlanır. Belge kaydı, hash ve denetim izi kalır; yalnız baytlar silinir.
      </PageHeader>
      <div className="mb-4 flex flex-wrap items-baseline gap-3"><Tag label={BATCH[b.status]} /><span>{b.proposedBy} · {fmtDateTime(b.proposedAt)}</span><span className="text-ink-muted">{b.reason}</span></div>
      {a.feedback}
      {b.hiddenItems > 0 && <Banner tone="warn" title={`Partideki ${b.hiddenItems} belge erişim kapsamınız dışında`}>Karar, bütün şirketlere erişimi olan bir hukuk yetkilisi tarafından verilmeli.</Banner>}
      {b.result && <Banner tone="info" icon="check" title={`${b.result.disposed} belge imha edildi${b.result.skipped.length ? `, ${b.result.skipped.length} belge atlandı` : ''}`}>Karar: {b.decidedBy}, {fmtDateTime(b.decidedAt)}{b.decisionNote ? ` — ${b.decisionNote}` : ''}
        <span className="block">{!b.result.objectKeys ? 'Silinecek bayt yok.' : b.result.purge ? `Baytlar silindi (${fmtDateTime(b.result.purge.at)}): ${b.result.purge.deleted} nesne${b.result.purge.kept ? `; ${b.result.purge.kept} nesne başka canlı kayıt kullandığı için korundu` : ''}.` : 'Baytların silinmesi kuyrukta; tamamlanınca burada görünür.'}</span></Banner>}
      {b.status === 'REJECTED' && <Banner tone="neutral" title="Reddedildi">{b.decidedBy}, {fmtDateTime(b.decidedAt)} — {b.decisionNote}</Banner>}
      <Table><TableHeader><TableRow className="hover:bg-transparent"><TableHead>Belge</TableHead><TableHead>Tür</TableHead><TableHead className="max-[900px]:hidden">Şirket</TableHead><TableHead>Süre doldu</TableHead><TableHead>Sonuç</TableHead></TableRow></TableHeader>
        <TableBody>{b.items.map((x) => (
          <TableRow key={x.documentId}><TableCell>{x.versionId ? <Link to={`/belgeler/${x.versionId}`} className="font-semibold">{x.title}</Link> : <span className="font-semibold">{x.title}</span>}{x.code && <span className="mono ml-2 text-sm text-ink-subtle">{x.code}</span>}</TableCell>
            <TableCell>{KIND_TR[x.kind] ?? x.kind}</TableCell><TableCell className="max-[900px]:hidden">{x.companyName}</TableCell><TableCell className="tabular">{fmtDate(x.dueOn)}</TableCell>
            <TableCell>{x.disposed ? (b.status === 'EXECUTED' ? 'İmha edildi' : <span className="text-ink-muted">Bu partide değil; sonradan başka bir partide imha edildi</span>) : skipped.has(x.documentId) ? <span className="text-warn">Atlandı: {VERDICT_TR[skipped.get(x.documentId)!] ?? skipped.get(x.documentId)}</span> : '—'}</TableCell></TableRow>))}</TableBody></Table>
      {b.status === 'PROPOSED' && b.canDecide && (mine ? <p className="mt-4 text-ink-muted">Bu imhayı siz önerdiniz; onayı başka bir hukuk yetkilisi verir.</p> : (
        <section className="panel mt-5 max-w-xl"><div className="panel-head"><h2>Karar</h2></div>
          <div className="panel-body grid gap-1">
            <Field label="Karar notu" hint="Onay geri alınamaz: belgelerin baytları silinir.">{(x) => <textarea className="input min-h-16" {...x} value={note} onChange={(e) => setNote(e.target.value)} />}</Field>
            <div className="flex flex-wrap gap-2">{confirming ? <>
              <span className="w-full text-sm font-semibold text-danger">{b.items.length} belgenin baytları kalıcı olarak silinecek. Emin misiniz?</span>
              <Button disabled={a.busy || !note.trim()} onClick={() => void a.run(() => api(`/api/v1/disposal-batches/${b.id}/decision`, { method: 'POST', json: { decision: 'APPROVE', note } }), 'Onaylandı; belgeler imha olarak işaretlendi, baytların silinmesi kuyrukta.').then(() => setConfirming(false))}>Evet, imha et</Button>
              <Button variant="ghost" onClick={() => setConfirming(false)}>Vazgeç</Button></>
            : <Button disabled={a.busy || !note.trim()} onClick={() => setConfirming(true)}>Onayla ve imha et</Button>}
              <Button variant="outline" disabled={a.busy || !note.trim()} onClick={() => void a.run(() => api(`/api/v1/disposal-batches/${b.id}/decision`, { method: 'POST', json: { decision: 'REJECT', note } }), 'İmha önerisi reddedildi.')}>Reddet</Button></div>
          </div></section>))}
    </div>
  );
}

// --- ERP mutabakatı -----------------------------------------------------------------------------------

const ERP: Record<string, Label> = {
  CONFIRMED: { text: 'ERP\'de kayıtlı', tone: 'ok', icon: 'check' },
  PENDING: { text: 'Gönderiliyor', tone: 'info', icon: 'clock' },
  UNKNOWN: { text: 'Belirsiz', tone: 'warn', icon: 'help' },
  FAILED: { text: 'Hata', tone: 'danger', icon: 'x' },
  NOT_CONFIGURED: { text: 'Yapılandırılmadı', tone: 'neutral', icon: 'minus' },
  MISSING: { text: 'Aktarım kaydı yok', tone: 'danger', icon: 'alert' },
};
const OUTCOME_TR: Record<string, string> = { MATCHED: 'Eşleşti', ALREADY_CONFIRMED: 'Zaten kayıtlı', EXTERNAL_ID_CONFLICT: 'ERP kimliği çakışıyor', ERP_REJECTED: 'ERP reddetti',
  AMOUNT_MISMATCH: 'Tutar farkı', UNKNOWN_KEY: 'Bilinmeyen anahtar', DUPLICATE_ROW: 'Mükerrer satır', INVALID_ROW: 'Geçersiz satır' };

interface Recon { period: { from: string; to: string }; dataAsOf: string; adapterConfigured: boolean; canReplay: boolean; note: string; inbox: { events: number; repeats: number }; attentionTruncated: boolean;
  byStatus: { status: string; currency: string; n: number; total: string }[];
  attention: { invoiceId: string; invoiceNo: string; supplierName: string; currency: string; payable: string; status: string; externalId: string | null; attempts: number | null; lastError: string | null; approvedAt: string }[] }
interface ResultRec { dryRun: boolean; fileSha256: string; fileTotal: string; matchedTotal: string; counts: Record<string, number>;
  rows: { line: number; idempotencyKey: string; invoiceNo: string | null; outcome: string; detail: string }[]; missingFromFile: { idempotencyKey: string; invoiceNo: string; payable: string }[] }

export function ErpReconciliationPage() {
  const { me } = useSession();
  const y = new Date().getFullYear();
  const [p, setP] = useState({ from: `${y}-01-01`, to: todayLocal() });
  const [q, setQ] = useState(p);
  const r = useResource<Recon>(`/api/v1/integration/erp/reconciliation?from=${q.from}&to=${q.to}`);
  const a = useAct(r.reload);
  const [replaying, setReplaying] = useState<string | null>(null);
  const [replayReason, setReplayReason] = useState('');
  const [file, setFile] = useState<{ name: string; text: string } | null>(null);
  const [result, setResult] = useState<ResultRec | null>(null);
  // v2 (D93/D95): CSV aktarımı ve tekrar gönderim Satınalma'da (integration.replay); Denetçi yalnız okur.
  const finance = hasRole(me, 'PROCUREMENT');

  async function batch() {
    await a.run(async () => {
      const blob = await apiBlob(`/api/v1/integration/erp/batch.csv?from=${q.from}&to=${q.to}`);
      const url = URL.createObjectURL(blob); const link = document.createElement('a');
      link.href = url; link.download = `erp-aktarim-${q.from}-${q.to}.csv`; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
    }, 'Aktarım dosyası indirildi; dışa aktarım kaydedildi.');
  }
  async function send(dryRun: boolean) {
    if (!file) return;
    await a.run(async () => { const res = await api<ResultRec>('/api/v1/integration/erp/results', { method: 'POST', json: { csv: file.text, dryRun } }); setResult(res.data); },
      dryRun ? 'Deneme mutabakatı hazır; henüz hiçbir kayıt değişmedi.' : 'Sonuç dosyası uygulandı.');
  }
  return (
    <div className="page">
      <PageHeader title="ERP mutabakatı" actions={<Button variant="outline" asChild><Link to="/faturalar">Faturalar</Link></Button>}>
        Fatura onayı bu platformda, muhasebe kaydı ve ödeme ERP'dedir. Onaylanan her faturanın ERP'ye ulaşıp ulaşmadığı burada izlenir; tutarı tutmayan veya eşleşmeyen satır hiçbir zaman "aktarıldı" sayılmaz.
      </PageHeader>
      <form className="mb-4 flex flex-wrap items-end gap-3" onSubmit={(e) => { e.preventDefault(); setQ(p); }}>
        <Field label="Onay tarihi başı">{(x) => <input className="input" type="date" required {...x} value={p.from} onChange={(e) => setP({ ...p, from: e.target.value })} />}</Field>
        <Field label="Onay tarihi sonu">{(x) => <input className="input" type="date" required {...x} value={p.to} onChange={(e) => setP({ ...p, to: e.target.value })} />}</Field>
        <Button type="submit" variant="outline" className="mb-4">Uygula</Button>
      </form>
      {a.feedback}
      {r.loading && !r.data ? <Loading rows={5} /> : r.error || !r.data ? <ErrorState error={r.error} onRetry={r.reload} /> : <div className="grid gap-5">
        {!r.data.adapterConfigured && <Banner tone="neutral" icon="info" title="ERP bağdaştırıcısı yapılandırılmadı">{r.data.note}</Banner>}
        <section className="panel"><div className="panel-head"><h2>Durum ve toplamlar</h2><span className="text-sm text-ink-subtle">veri anı {fmtDateTime(r.data.dataAsOf)} · gelen ERP olayı {r.data.inbox.events} (tekrar {r.data.inbox.repeats})</span></div>
          {!r.data.byStatus.length ? <div className="panel-body"><p className="text-ink-muted">Bu dönemde onaylanan fatura yok.</p></div> : (
            <Table><TableHeader><TableRow className="hover:bg-transparent"><TableHead>Durum</TableHead><TableHead>Para birimi</TableHead><TableHead className="text-right">Fatura</TableHead><TableHead className="text-right">Ödenecek toplam</TableHead></TableRow></TableHeader>
              <TableBody>{r.data.byStatus.map((s) => <TableRow key={s.status + s.currency}><TableCell><Tag label={ERP[s.status]} /></TableCell><TableCell>{s.currency}</TableCell>
                <TableCell className="tabular text-right">{s.n}</TableCell><TableCell className="tabular text-right font-semibold">{fmtMoney(s.total, s.currency)}</TableCell></TableRow>)}</TableBody></Table>)}</section>

        <section className="panel"><div className="panel-head"><h2>İlgilenilmesi gerekenler</h2><span className="text-sm text-ink-subtle">{r.data.attentionTruncated ? `en eski ${r.data.attention.length} gösteriliyor; toplamlar yukarıda, dönemi daraltın` : r.data.attention.length}</span></div>
          {!r.data.attention.length ? <div className="panel-body"><p className="text-ink-muted">Bu dönemde onaylanan bütün faturalar ERP'de kayıtlı.</p></div> : (
            <Table><TableHeader><TableRow className="hover:bg-transparent"><TableHead>Fatura</TableHead><TableHead className="max-[900px]:hidden">Tedarikçi</TableHead><TableHead className="text-right">Ödenecek</TableHead><TableHead>Durum</TableHead><TableHead><span className="sr-only">İşlem</span></TableHead></TableRow></TableHeader>
              <TableBody>{r.data.attention.map((x) => (
                <TableRow key={x.invoiceId}>
                  <TableCell><Link to={`/faturalar/${x.invoiceId}`} className="font-semibold">{x.invoiceNo}</Link><span className="block text-sm text-ink-subtle">onay {fmtDate(x.approvedAt)}</span></TableCell>
                  <TableCell className="max-[900px]:hidden">{x.supplierName}</TableCell>
                  <TableCell className="tabular whitespace-nowrap text-right">{fmtMoney(x.payable, x.currency)}</TableCell>
                  <TableCell><Tag label={ERP[x.status]} />{x.lastError && x.status !== 'NOT_CONFIGURED' && <span className="block text-sm text-ink-muted">{x.lastError}</span>}</TableCell>
                  <TableCell className="text-right">{r.data!.canReplay && r.data!.adapterConfigured && ['FAILED', 'UNKNOWN'].includes(x.status) && (replaying === x.invoiceId ? (
                    <form className="flex flex-wrap items-end justify-end gap-2" onSubmit={(e) => { e.preventDefault(); void a.run(() => api(`/api/v1/integration/erp/exports/${x.invoiceId}/replay`, { method: 'POST', json: { reason: replayReason } }),
                      x.status === 'UNKNOWN' ? 'Tekrar kuyruğa alındı; önce ERP\'de aynı anahtarla sorgulanacak.' : 'Tekrar kuyruğa alındı.').then((ok) => { if (ok) { setReplaying(null); setReplayReason(''); } }); }}>
                      <Field label="Gerekçe">{(f) => <input className="input min-w-56" {...f} value={replayReason} onChange={(e) => setReplayReason(e.target.value)} />}</Field>
                      <Button size="sm" type="submit" className="mb-4" disabled={a.busy || replayReason.trim().length < 10}>Gönder</Button></form>)
                    : <Button size="sm" variant="outline" onClick={() => { a.clear(); setReplaying(x.invoiceId); }}>Tekrar gönder</Button>)}</TableCell>
                </TableRow>))}</TableBody></Table>)}</section>

        {finance && <section className="panel"><div className="panel-head"><h2>CSV ile aktarım ve sonuç dosyası</h2></div>
          <div className="panel-body grid gap-4">
            <Step n={1} title="Aktarım dosyasını indirin">ERP'ye henüz ulaşmamış (yapılandırılmamış veya hatalı) onaylı faturalar. Her satırda değişmez bir aktarım anahtarı vardır.
              <div className="mt-2"><Button variant="outline" size="sm" disabled={a.busy} onClick={() => void batch()}><Icon name="download" />Aktarım dosyası (CSV)</Button></div></Step>
            <Step n={2} title="ERP'nin sonuç dosyasını yükleyin">Sütunlar: <span className="mono break-all">aktarim_anahtari;erp_kimligi;durum;odenecek;mesaj</span> — durum OK veya ERROR.
              <div className="mt-2 flex flex-wrap items-center gap-2"><input type="file" accept=".csv,text/csv" aria-label="Sonuç dosyası" className="min-w-0 max-w-full" onChange={async (e) => { const f = e.target.files?.[0]; setResult(null); setFile(f ? { name: f.name, text: await f.text() } : null); }} />
                <Button size="sm" variant="outline" disabled={!file || a.busy} onClick={() => void send(true)}>Önce dene</Button></div>
              <p className="mt-1">"Önce dene" hiçbir kaydı değiştirmez; satır satır sonucu ve toplamları gösterir. Uygulama düğmesi denemeden sonra çıkar.</p></Step>
            {result && <ResultView res={result} />}
            {result?.dryRun && <Step n={3} title="Uygulayın">Yalnız tutarı tutan "OK" satırlar ERP'de kayıtlı sayılır; ERP'nin reddettikleri hata olarak işaretlenir. Diğer satırlar hiçbir şeyi değiştirmez.
              <div className="mt-2"><Button size="sm" disabled={a.busy} onClick={() => void send(false)}>Sonuç dosyasını uygula</Button></div></Step>}
          </div></section>}
      </div>}
    </div>
  );
}

function Step({ n, title, children }: { n: number; title: string; children: ReactNode }) {
  return <div className="grid grid-cols-[28px_minmax(0,1fr)] gap-3"><span className="tabular grid size-7 place-items-center rounded-full bg-sunken font-bold">{n}</span>
    <div><h3 className="font-semibold">{title}</h3><div className="text-sm text-ink-muted">{children}</div></div></div>;
}

function ResultView({ res }: { res: ResultRec }) {
  const problems = res.rows.filter((x) => !['MATCHED', 'ALREADY_CONFIRMED'].includes(x.outcome));
  return (
    <div className="grid gap-3">
      <p className="text-sm"><strong>{res.dryRun ? 'Deneme sonucu' : 'Uygulandı'}</strong> · eşleşen {res.counts.MATCHED} · zaten kayıtlı {res.counts.ALREADY_CONFIRMED} · sorunlu {problems.length} ·
        dosya toplamı <span className="tabular">{res.fileTotal}</span> · eşleşen toplam <span className="tabular">{res.matchedTotal}</span> · dosya özeti <span className="mono" title={res.fileSha256}>{shortHash(res.fileSha256)}</span></p>
      {problems.length > 0 && <Table><TableHeader><TableRow className="hover:bg-transparent"><TableHead>Satır</TableHead><TableHead>Fatura</TableHead><TableHead>Sonuç</TableHead><TableHead>Ayrıntı</TableHead></TableRow></TableHeader>
        <TableBody>{problems.map((x) => <TableRow key={x.line}><TableCell className="tabular">{x.line}</TableCell><TableCell>{x.invoiceNo ?? <span className="mono text-sm">{x.idempotencyKey || '—'}</span>}</TableCell>
          <TableCell className="font-semibold">{OUTCOME_TR[x.outcome] ?? x.outcome}</TableCell><TableCell className="text-sm">{x.detail}</TableCell></TableRow>)}</TableBody></Table>}
      {res.missingFromFile.length > 0 && <Banner tone="warn" title={`Dosyada olmayan ${res.missingFromFile.length} bekleyen aktarım`}>{res.missingFromFile.slice(0, 10).map((m) => m.invoiceNo).join(', ')}{res.missingFromFile.length > 10 ? '…' : ''}</Banner>}
    </div>
  );
}
