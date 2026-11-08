import { useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { api, ApiError } from '../lib/api.ts';
import { useResource } from '../lib/useApi.ts';
import { fmtDate, fmtDateTime, fmtMoney, todayLocal } from '../lib/format.ts';
import type { Label } from '../lib/labels.ts';
import { Banner, Empty, ErrorState, Field, FilterChip, Loading, Modal, PageHeader, Tag } from '../ui/kit.tsx';
import { Icon } from '../ui/icons.tsx';
import { Button } from '@/components/ui/button';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { cn } from '@/lib/utils';

// Lira Defteri (D80): harcamanın kanıt zinciri ve kurallarla bulunan "masada unutulan para". Bulgu öneridir; doğrulama, talep,
// tahsil ve kapatma insan kaydıdır. Para birimleri birbirine çevrilmez.

type Money = Record<string, string>;
interface Ledger {
  period: { from: string; to: string };
  evidence: { invoiceCount: number; evidencedCount: number; evidenced: Money; unevidenced: Money;
    gaps: { gap: string; count: number; amount: Money }[];
    topUnevidenced: { id: string; no: string; supplier: string; currency: string; net: string; issueDate: string; gaps: string[] }[] };
  recovery: { recoverable: Money; claimed: Money; recovered: Money; shortfall?: Money; avoidable: Money; atRisk: Money; reviewCount: number; openCount: number };
  settings: { capitalCostRate: string | null; fxRateCount: number };
  lastScanAt: string | null;
  can: { scan: boolean; manage: boolean; settle: boolean; settings: boolean };
}
interface CaseRow { id: string; code: string; kind: string; category: string; status: string; amount: string | null; currency: string; summary: string;
  supplierName: string; invoiceNo: string | null; recoveredAmount: string | null; detectedAt: string }

export const KIND: Record<string, string> = {
  FX_DIFF_NOT_ALLOWED: 'İzinsiz kur farkı', FX_DIFF_EXCESS: 'Fazla kur farkı', FX_DIFF_UNVERIFIED: 'Kur farkı incelenmeli',
  ADVANCE_UNOFFSET: 'Mahsup edilmemiş avans', EARLY_PAYMENT: 'Vadeden önce ödeme', GUARANTEE_EXPIRY: 'Teminat bitiyor',
};
const CATEGORY: Record<string, Label> = {
  RECOVERABLE: { text: 'Geri alınabilir', tone: 'info', icon: 'receipt', hint: 'Tedarikçiden iade veya mahsup istenebilir.' },
  AVOIDABLE: { text: 'Önlenebilir kayıp', tone: 'warn', icon: 'clock', hint: 'Kurumun kendi kaybı; tedarikçiden istenmez, süreç düzeltilir.' },
  RISK: { text: 'Risk', tone: 'danger', icon: 'shield', hint: 'Koruma kalkmak üzere; para henüz kaybedilmedi.' },
  REVIEW: { text: 'İncelenmeli', tone: 'neutral', icon: 'help', hint: 'Tutar hesaplanamadı; eksik veri tamamlanmalı.' },
};
const STATUS: Record<string, Label> = {
  OPEN: { text: 'Yeni bulgu', tone: 'neutral', icon: 'inbox' },
  CONFIRMED: { text: 'Doğrulandı', tone: 'human', icon: 'check' },
  CLAIMED: { text: 'Talep edildi', tone: 'info', icon: 'arrow' },
  RECOVERED: { text: 'Geri alındı', tone: 'ok', icon: 'check' },
  DISMISSED: { text: 'Kapatıldı', tone: 'neutral', icon: 'minus' },
  OBSOLETE: { text: 'Kendiliğinden çözüldü', tone: 'neutral', icon: 'minus', hint: 'Son taramada koşul artık yoktu (ör. avans mahsup edildi).' },
};
const GAP: Record<string, string> = {
  NO_ALLOCATION: 'Sipariş veya sözleşmeye tahsis yok', NO_CONTRACT: 'Sözleşme bağı yok', NO_RECEIPT: 'Mal/hizmet kabulü yok', TERMS_UNVERIFIED: 'Sözleşme koşulları doğrulanmamış',
};

const Amounts = ({ m, empty = '—', className }: { m: Money; empty?: string; className?: string }) => {
  const e = Object.entries(m);
  if (!e.length) return <span className={cn('tabular text-ink-subtle', className)}>{empty}</span>;
  return <>{e.map(([c, a]) => <span key={c} className={cn('tabular block', className)}>{fmtMoney(a, c)}</span>)}</>;
};

function Tile({ title, hint, m, tone, onClick, extra }: { title: string; hint: string; m: Money; tone?: 'ok' | 'warn' | 'danger' | 'info'; onClick?: () => void; extra?: string }) {
  const body = <>
    <span className="text-sm font-semibold text-ink-muted">{title}</span>
    <Amounts m={m} empty="Henüz yok" className={cn('text-xl font-bold', tone === 'ok' ? 'text-verified' : tone === 'danger' ? 'text-danger' : tone === 'warn' ? 'text-warn' : 'text-ink')} />
    {extra && <span className="text-sm text-ink-muted">{extra}</span>}
    <span className="text-sm text-ink-subtle">{hint}</span>
  </>;
  const cls = 'panel grid content-start gap-1 p-4 text-left';
  return onClick ? <button type="button" onClick={onClick} className={cn(cls, 'transition-colors duration-150 hover:bg-sunken')}>{body}</button> : <div className={cls}>{body}</div>;
}

const TABS = [['bulgular', 'Geri alınacak para'], ['kanitsiz', 'Kanıtsız harcama'], ['ayarlar', 'Kur ve ayarlar']] as const;

export function LedgerPage() {
  const y = new Date().getFullYear();
  const [p, setP] = useState({ from: `${y}-01-01`, to: todayLocal() });
  const [q, setQ] = useState(p);
  const r = useResource<Ledger>(`/api/v1/ledger?from=${q.from}&to=${q.to}`);
  const cases = useResource<{ items: CaseRow[] }>('/api/v1/recovery/cases');
  const [params, setParams] = useSearchParams();
  const tab = (params.get('sekme') ?? 'bulgular') as (typeof TABS)[number][0];
  const go = (k: string) => { const n = new URLSearchParams(params); k === 'bulgular' ? n.delete('sekme') : n.set('sekme', k); setParams(n, { replace: true }); };
  const [scanMsg, setScanMsg] = useState<{ tone: 'info' | 'danger'; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  async function scan() {
    setBusy(true); setScanMsg(null);
    try {
      const s = (await api<{ found: number; created: number; updated: number; inProgress?: number; closed?: number; obsolete: number }>('/api/v1/recovery/scan', { method: 'POST' })).data;
      const extra = [s.inProgress ? `${s.inProgress} işlemdeki bulgu korundu` : '', s.closed ? `${s.closed} kapanmış bulgu olduğu gibi kaldı` : ''].filter(Boolean).map((x) => `, ${x}`).join('');
      setScanMsg({ tone: 'info', text: `Tarama tamamlandı: ${s.found} bulgu (${s.created} yeni, ${s.updated} güncellendi${extra}${s.obsolete ? `, ${s.obsolete} kendiliğinden çözüldü` : ''}).` });
      await Promise.all([r.reload(), cases.reload()]);
    } catch (e) { setScanMsg({ tone: 'danger', text: (e as ApiError).message }); }
    finally { setBusy(false); }
  }
  const d = r.data;
  return (
    <div className="page">
      <PageHeader title="Lira Defteri" actions={d?.can.scan && <Button onClick={() => void scan()} disabled={busy}><Icon name="refresh" />{busy ? 'Taranıyor' : 'Taramayı çalıştır'}</Button>}>
        Her liranın hangi sözleşme, sipariş ve kabule dayandığı ve kurallarla bulunan geri alınacak para. Bulgular öneridir: doğrulama, talep ve tahsil kararı sizindir. Kapsam yalnız erişiminiz olan şirketlerdir.
      </PageHeader>
      {scanMsg && <Banner tone={scanMsg.tone} icon={scanMsg.tone === 'info' ? 'check' : undefined} title={scanMsg.text} />}
      {r.loading && !d ? <Loading rows={6} /> : r.error || !d ? <ErrorState error={r.error} onRetry={r.reload} /> : <>
        <p className="mb-3 text-sm text-ink-subtle">
          {d.lastScanAt ? `Son tarama ${fmtDateTime(d.lastScanAt)}.` : 'Henüz tarama yapılmadı.'} Bulgular güncel durumu gösterir; kanıt zinciri seçilen dönemdeki onaylı faturalardandır. Para birimleri birbirine çevrilmez.
        </p>
        <div className="mb-5 grid grid-cols-3 gap-3 max-[1100px]:grid-cols-2 max-[640px]:grid-cols-1">
          <Tile title="Geri alınabilir" m={d.recovery.recoverable} tone="info" onClick={() => go('bulgular')}
            extra={Object.keys(d.recovery.claimed).length ? `Talep edilen: ${Object.entries(d.recovery.claimed).map(([c, a]) => fmtMoney(a, c)).join(' · ')}` : undefined}
            hint="İzinsiz/fazla kur farkı ve mahsup edilmemiş avans; açık, doğrulanmış ve talep edilmiş bulgular." />
          <Tile title="Geri alınan" m={d.recovery.recovered} tone="ok" hint="Finansın tahsil (iade veya mahsup) olarak kaydettiği tutar."
            extra={d.recovery.shortfall && Object.keys(d.recovery.shortfall).length ? `Kısmi tahsilde alınamayan: ${Object.entries(d.recovery.shortfall).map(([c, a]) => fmtMoney(a, c)).join(' · ')}` : undefined} />
          <Tile title="Önlenebilir kayıp" m={d.recovery.avoidable} tone="warn" onClick={() => go('bulgular')}
            hint={d.settings.capitalCostRate ? `Vadeden önce ödemenin yıllık %${d.settings.capitalCostRate.replace('.', ',')} sermaye maliyetiyle bedeli.` : 'Sermaye maliyeti girilmediği için hesaplanmıyor.'} />
          <Tile title="Risk altındaki teminat" m={d.recovery.atRisk} tone="danger" onClick={() => go('bulgular')} hint="Sözleşme sürerken 30 gün içinde biten veya bitmiş teminat." />
          <Tile title="Kanıtlı harcama" m={d.evidence.evidenced} hint={`${d.evidence.evidencedCount} / ${d.evidence.invoiceCount} onaylı fatura: tahsis, doğrulanmış sözleşme ve kabul tam.`} />
          <Tile title="Kanıtsız harcama" m={d.evidence.unevidenced} tone={Object.keys(d.evidence.unevidenced).length ? 'warn' : undefined} onClick={() => go('kanitsiz')}
            hint={`${d.evidence.invoiceCount - d.evidence.evidencedCount} onaylı faturada zincirin bir halkası eksik.`} />
        </div>
        {d.recovery.reviewCount > 0 && <Banner tone="warn" icon="help" title={`${d.recovery.reviewCount} kur farkı faturası incelenmeli`}>Tutar hesaplanamadı: sözleşmede kur farkı hükmü, ait olduğu döviz fatura veya kur verisi eksik. Bulgular listesinde "İncelenmeli" olarak görünür.</Banner>}
        {!d.settings.capitalCostRate && <Banner tone="neutral" icon="info" title="Erken ödeme kuralı kapalı">Yıllık sermaye maliyeti girilmedi; vadeden önce ödemenin bedeli hesaplanmıyor. {d.can.settings ? <button type="button" className="underline" onClick={() => go('ayarlar')}>Ayarlardan girin.</button> : 'Finans girebilir.'}</Banner>}
        <form className="mb-2 mt-2 flex flex-wrap items-end gap-3" onSubmit={(e) => { e.preventDefault(); setQ(p); }}>
          <Field label="Kanıt dönemi başı">{(x) => <input className="input" type="date" required {...x} value={p.from} onChange={(e) => setP({ ...p, from: e.target.value })} />}</Field>
          <Field label="Kanıt dönemi sonu">{(x) => <input className="input" type="date" required {...x} value={p.to} onChange={(e) => setP({ ...p, to: e.target.value })} />}</Field>
          <Button type="submit" variant="outline" className="mb-4">Uygula</Button>
        </form>
        <div role="tablist" aria-label="Lira Defteri" className="mb-4 flex gap-6 overflow-x-auto border-b border-border">
          {TABS.map(([k, l]) => (
            <button key={k} role="tab" aria-selected={tab === k} onClick={() => go(k)}
              className={cn('-mb-px min-h-10 whitespace-nowrap border-b-2 font-semibold transition-colors duration-150', tab === k ? 'border-ink text-ink' : 'border-transparent text-ink-muted hover:text-ink')}>{l}</button>
          ))}
        </div>
        {tab === 'kanitsiz' ? <EvidenceTab d={d} /> : tab === 'ayarlar' ? <SettingsTab d={d} reload={r.reload} /> : <CasesTab r={cases} canScan={d.can.scan} />}
      </>}
    </div>
  );
}

const FILTERS = [['acik', 'Açık işler'], ['geri', 'Geri alınan'], ['kapali', 'Kapanan'], ['tum', 'Tümü']] as const;
function CasesTab({ r, canScan }: { r: ReturnType<typeof useResource<{ items: CaseRow[] }>>; canScan: boolean }) {
  const [f, setF] = useState<(typeof FILTERS)[number][0]>('acik');
  if (r.loading && !r.data) return <Loading rows={5} />;
  if (r.error || !r.data) return <ErrorState error={r.error} onRetry={r.reload} />;
  const match = (c: CaseRow) => f === 'tum' || (f === 'acik' ? ['OPEN', 'CONFIRMED', 'CLAIMED'].includes(c.status) : f === 'geri' ? c.status === 'RECOVERED' : ['DISMISSED', 'OBSOLETE'].includes(c.status));
  const rows = r.data.items.filter(match);
  return <>
    <div className="mb-3 flex flex-wrap gap-2">{FILTERS.map(([k, l]) => <FilterChip key={k} pressed={f === k} onClick={() => setF(k)} count={r.data!.items.filter((c) => k === 'tum' || (k === 'acik' ? ['OPEN', 'CONFIRMED', 'CLAIMED'].includes(c.status) : k === 'geri' ? c.status === 'RECOVERED' : ['DISMISSED', 'OBSOLETE'].includes(c.status))).length}>{l}</FilterChip>)}</div>
    {!rows.length ? <Empty icon="check" title={r.data.items.length ? 'Bu filtrede bulgu yok' : 'Henüz bulgu yok'}>{!r.data.items.length && (canScan ? 'Taramayı çalıştırın: kur farkı, avans, erken ödeme ve teminat kuralları onaylı faturalarda ve sözleşmelerde aranır.' : 'Tarama satınalma veya finans tarafından çalıştırılır.')}</Empty> : (
      <Table>
        <TableHeader><TableRow className="hover:bg-transparent"><TableHead>Kayıt</TableHead><TableHead>Bulgu</TableHead><TableHead className="max-[900px]:hidden">Tedarikçi</TableHead><TableHead className="text-right">Tutar</TableHead><TableHead>Durum</TableHead></TableRow></TableHeader>
        <TableBody>{rows.map((c) => (
          <TableRow key={c.id}>
            <TableCell className="whitespace-nowrap align-top"><Link to={`/lira-defteri/${c.id}`} className="mono font-semibold">{c.code}</Link></TableCell>
            <TableCell className="min-w-[280px] align-top"><span className="flex flex-wrap items-center gap-2"><span className="font-semibold">{KIND[c.kind] ?? c.kind}</span><Tag label={CATEGORY[c.category]} /></span>
              <span className="mt-0.5 block text-sm text-ink-muted">{c.summary}</span></TableCell>
            <TableCell className="align-top max-[900px]:hidden">{c.supplierName}</TableCell>
            <TableCell className="tabular whitespace-nowrap text-right align-top font-semibold">{c.status === 'RECOVERED' ? <>{fmtMoney(c.recoveredAmount, c.currency)}{c.amount && c.recoveredAmount && c.amount !== c.recoveredAmount && <span className="block text-sm font-normal text-ink-muted">bulgu {fmtMoney(c.amount, c.currency)}</span>}</> : c.amount ? fmtMoney(c.amount, c.currency) : <span className="font-normal text-ink-subtle">Hesaplanamadı</span>}</TableCell>
            <TableCell className="align-top"><Tag label={STATUS[c.status]} /></TableCell>
          </TableRow>
        ))}</TableBody>
      </Table>)}
  </>;
}

function EvidenceTab({ d }: { d: Ledger }) {
  const e = d.evidence;
  if (!e.invoiceCount) return <Empty icon="receipt" title="Bu dönemde onaylı fatura yok" />;
  if (!e.topUnevidenced.length) return <Empty icon="check" title="Dönemdeki tüm onaylı faturaların zinciri tam">Tahsis, doğrulanmış sözleşme koşulları ve (siparişli satırda) kabul kaydı var.</Empty>;
  return <div className="grid gap-5">
    <section className="panel"><div className="panel-head"><h2>Eksik halkalar</h2><span className="text-sm text-ink-subtle">Bir fatura birden fazla eksikte sayılabilir; tutar fatura net tutarıdır.</span></div>
      <Table><TableHeader><TableRow className="hover:bg-transparent"><TableHead>Eksik</TableHead><TableHead className="text-right">Fatura</TableHead><TableHead className="text-right">Tutar</TableHead></TableRow></TableHeader>
        <TableBody>{e.gaps.map((g) => <TableRow key={g.gap}><TableCell>{GAP[g.gap] ?? g.gap}</TableCell><TableCell className="tabular text-right">{g.count}</TableCell><TableCell className="text-right"><Amounts m={g.amount} /></TableCell></TableRow>)}</TableBody></Table></section>
    <section className="panel"><div className="panel-head"><h2>En büyük kanıtsız faturalar</h2><span className="text-sm text-ink-subtle">İlk {e.topUnevidenced.length}; tutara göre.</span></div>
      <Table><TableHeader><TableRow className="hover:bg-transparent"><TableHead>Fatura</TableHead><TableHead className="max-[900px]:hidden">Tedarikçi</TableHead><TableHead>Eksik</TableHead><TableHead className="text-right">Net</TableHead></TableRow></TableHeader>
        <TableBody>{e.topUnevidenced.map((i) => (
          <TableRow key={i.id}><TableCell className="whitespace-nowrap"><Link to={`/faturalar/${i.id}`} className="mono">{i.no}</Link><span className="block text-sm text-ink-subtle">{fmtDate(i.issueDate)}</span></TableCell>
            <TableCell className="max-[900px]:hidden">{i.supplier}</TableCell>
            <TableCell className="text-sm">{i.gaps.map((g) => GAP[g] ?? g).join(' · ')}</TableCell>
            <TableCell className="tabular whitespace-nowrap text-right">{fmtMoney(i.net, i.currency)}</TableCell></TableRow>
        ))}</TableBody></Table></section>
  </div>;
}

interface Rate { currency: string; rateDate: string; rate: string; source: string; enteredBy: string; enteredAt: string }
function SettingsTab({ d, reload }: { d: Ledger; reload: () => Promise<void> }) {
  const rates = useResource<{ items: Rate[] }>('/api/v1/fx-rates');
  const [rate, setRate] = useState(d.settings.capitalCostRate ?? '');
  const [fx, setFx] = useState({ currency: 'USD', rateDate: todayLocal(), rate: '', source: 'TCMB döviz satış' });
  const [msg, setMsg] = useState<{ tone: 'info' | 'danger' | 'warn'; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const run = async (fn: () => Promise<unknown>, ok: string) => {
    setBusy(true); setMsg(null);
    try { await fn(); setMsg({ tone: 'info', text: ok }); await Promise.all([reload(), rates.reload()]); return true; }
    catch (e) { const err = e as ApiError; setMsg({ tone: err.status === 409 ? 'warn' : 'danger', text: err.message }); return false; }
    finally { setBusy(false); }
  };
  const can = d.can.settings;
  return <div className="grid grid-cols-[minmax(0,1fr)_360px] gap-6 max-[1100px]:grid-cols-1">
    <section className="panel"><div className="panel-head"><h2>Kur tablosu</h2><span className="text-sm text-ink-subtle">Kur farkı hesabında fatura ve ödeme gününün kuru; o gün yoksa en fazla 7 gün önceki son kur.</span></div>
      {can && <form className="flex flex-wrap items-end gap-3 border-b border-border p-4" onSubmit={(e) => { e.preventDefault(); void run(() => api('/api/v1/fx-rates', { method: 'POST', json: fx }), `${fx.currency} ${fmtDate(fx.rateDate)} kuru eklendi.`).then((ok) => ok && setFx({ ...fx, rate: '' })); }}>
        <Field label="Para birimi">{(x) => <input className="input w-24 uppercase" required maxLength={3} pattern="[A-Za-z]{3}" {...x} value={fx.currency} onChange={(e) => setFx({ ...fx, currency: e.target.value.toUpperCase() })} />}</Field>
        <Field label="Tarih">{(x) => <input className="input" type="date" required {...x} value={fx.rateDate} onChange={(e) => setFx({ ...fx, rateDate: e.target.value })} />}</Field>
        <Field label="Kur (TRY)">{(x) => <input className="input w-32 tabular" required inputMode="decimal" pattern="\d{1,12}([.,]\d{1,6})?" {...x} value={fx.rate} onChange={(e) => setFx({ ...fx, rate: e.target.value.replace(',', '.') })} />}</Field>
        <Field label="Kaynak">{(x) => <input className="input" required minLength={2} {...x} value={fx.source} onChange={(e) => setFx({ ...fx, source: e.target.value })} />}</Field>
        <Button type="submit" variant="outline" className="mb-4" disabled={busy}>Ekle</Button>
      </form>}
      {rates.loading && !rates.data ? <Loading rows={3} /> : rates.error || !rates.data ? <ErrorState error={rates.error} onRetry={rates.reload} />
        : !rates.data.items.length ? <div className="panel-body text-ink-muted">Kur girilmedi. İzinli kur farkında hak edilen tutar kur olmadan hesaplanmaz.</div> : (
          <Table><TableHeader><TableRow className="hover:bg-transparent"><TableHead>Tarih</TableHead><TableHead>Para birimi</TableHead><TableHead className="text-right">Kur</TableHead><TableHead className="max-[900px]:hidden">Kaynak</TableHead>{can && <TableHead><span className="sr-only">Sil</span></TableHead>}</TableRow></TableHeader>
            <TableBody>{rates.data.items.map((x) => (
              <TableRow key={`${x.currency}${x.rateDate}`}><TableCell>{fmtDate(x.rateDate)}</TableCell><TableCell className="mono">{x.currency}</TableCell><TableCell className="tabular text-right">{x.rate.replace('.', ',')}</TableCell>
                <TableCell className="text-sm text-ink-muted max-[900px]:hidden">{x.source} · {x.enteredBy}</TableCell>
                {can && <TableCell className="text-right"><button type="button" className="text-sm underline" disabled={busy} aria-label={`${x.currency} ${fmtDate(x.rateDate)} kurunu sil`}
                  onClick={() => void run(() => api(`/api/v1/fx-rates/${x.currency}/${x.rateDate}`, { method: 'DELETE' }), 'Kur silindi.')}>Sil</button></TableCell>}</TableRow>
            ))}</TableBody></Table>)}
    </section>
    <section className="panel self-start"><div className="panel-head"><h2>Sermaye maliyeti</h2></div>
      <div className="panel-body grid gap-2">
        <p className="text-sm text-ink-muted">Vadeden önce ödenen paranın kuruma maliyeti bu yıllık oranla hesaplanır (basit faiz, 365 gün). Oranı finans belirler; girilmezse erken ödeme kuralı çalışmaz.</p>
        {can ? <form className="flex items-end gap-3" onSubmit={(e) => { e.preventDefault(); void run(() => api('/api/v1/recovery/settings', { method: 'PUT', json: { capitalCostRate: rate.replace(',', '.') } }), 'Sermaye maliyeti kaydedildi; yeni tarama bu oranı kullanır.'); }}>
          <Field label="Yıllık oran (%)">{(x) => <input className="input w-28 tabular" required inputMode="decimal" pattern="\d{1,3}([.,]\d{1,4})?" {...x} value={rate} onChange={(e) => setRate(e.target.value)} />}</Field>
          <Button type="submit" variant="outline" className="mb-4" disabled={busy}>Kaydet</Button>
        </form> : <p className="tabular font-semibold">{d.settings.capitalCostRate ? `%${d.settings.capitalCostRate.replace('.', ',')}` : 'Girilmedi'}</p>}
      </div>
    </section>
    {msg && <div className="col-span-full"><Banner tone={msg.tone} icon={msg.tone === 'info' ? 'check' : undefined} title={msg.text} /></div>}
  </div>;
}

// --- Vaka ayrıntısı ------------------------------------------------------------------------------------

interface CaseDetail extends CaseRow {
  basis: Record<string, unknown>; companyName: string; supplierId: string; invoiceId: string | null; contractVersionId: string | null; contractTitle: string | null;
  lastSeenAt: string; claimNote: string | null; recoveredNote: string | null; dismissReason: string | null;
  confirmedAt: string | null; confirmedBy: string | null; claimedAt: string | null; claimedBy: string | null; recoveredAt: string | null; recoveredBy: string | null;
  dismissedAt: string | null; dismissedBy: string | null; claimable: boolean; claimDraft: string | null; can: { manage: boolean; settle: boolean };
}
const BASIS: Record<string, string> = {
  invoiceNo: 'Fatura', paymentTerms: 'Ödeme koşulu (sözleşme)', formula: 'Hesap', credited: 'İade faturasıyla düşülen', billed: 'Faturalanan (KDV hariç)', sourceRef: 'Sözleşme maddesi', contractRule: 'Sözleşme hükmü', originalNo: 'Ait olduğu döviz fatura', originalNet: 'Döviz tutar',
  issueDate: 'Fatura tarihi', paidAt: 'Ödeme tarihi', rateAtIssue: 'Fatura günü kuru', rateAtPayment: 'Ödeme günü kuru', expected: 'Hak edilen kur farkı',
  advanceNo: 'Avans faturası', advanceNet: 'Avans tutarı', offsetTotal: 'Mahsup edilen', balance: 'Kalan bakiye', lastOffsetDate: 'Son mahsup', contractEnd: 'Sözleşme bitişi',
  paymentDays: 'Vade (gün)', due: 'Vade tarihi', daysEarly: 'Erken gün', payable: 'Ödenen tutar', annualRate: 'Yıllık sermaye maliyeti (%)',
  guaranteeKind: 'Teminat türü', referenceNo: 'Teminat no', issuer: 'Düzenleyen', validUntil: 'Geçerlilik sonu', note: 'Not', reason: 'Neden hesaplanamadı',
};
const REASON: Record<string, string> = { no_contract: 'Sözleşme bağı yok', no_rule: 'Kur farkı hükmü girilmemiş', no_original: 'Ait olduğu döviz fatura bulunamadı', not_paid: 'Ödeme tarihi bilinmiyor', no_rate: 'Kur yok' };
// Dayanak okunduğu sırayla: ne faturalandı → sözleşme ne diyor → hesap girdileri → sonuç.
const ORDER = ['invoiceNo', 'billed', 'credited', 'contractRule', 'sourceRef', 'originalNo', 'originalNet', 'issueDate', 'paidAt', 'rateAtIssue', 'rateAtPayment', 'expected',
  'advanceNo', 'advanceNet', 'offsetTotal', 'balance', 'lastOffsetDate', 'contractEnd', 'paymentTerms', 'paymentDays', 'due', 'daysEarly', 'payable', 'annualRate',
  'guaranteeKind', 'referenceNo', 'issuer', 'validUntil', 'reason', 'formula', 'note'];
const MONEY = new Set(['credited', 'billed', 'expected', 'advanceNet', 'offsetTotal', 'balance', 'payable']);
const GUARANTEE_KIND: Record<string, string> = { PERFORMANCE: 'Kesin (performans)', ADVANCE: 'Avans', WARRANTY: 'Garanti', CASH: 'Nakit', OTHER: 'Diğer' };
const showBasis = (k: string, v: unknown, b: Record<string, unknown>, currency: string) => {
  if (v === null || v === undefined || v === '') return '—';
  if (MONEY.has(k)) return fmtMoney(String(v), currency);
  if (k === 'originalNet') return fmtMoney(String(v), String(b.originalCurrency ?? ''));
  if (k === 'contractRule') return v === 'NOT_ALLOWED' ? 'Kur farkı uygulanmaz' : 'Kur farkı uygulanabilir';
  if (k === 'reason') return REASON[String(v)] ?? String(v);
  if (k === 'guaranteeKind') return GUARANTEE_KIND[String(v)] ?? String(v);
  if (k === 'annualRate') return `%${String(v).replace('.', ',')}`;
  if (k.startsWith('rateAt')) return `${String(v).replace('.', ',')} TRY / ${String(b.originalCurrency ?? '')}`;
  if (/Date$|^paidAt$|^due$|^validUntil$|^contractEnd$/.test(k)) return fmtDate(String(v));
  return String(v);
};

/** Türkçe yazılmış tutarı (12.486,50 veya 12486,50) API'nin beklediği ondalık metne çevirir. */
const toDecimal = (s: string) => { const t = s.trim().replace(/\s/g, ''); return t.includes(',') ? t.replace(/\./g, '').replace(',', '.') : t; };
/** Bulgu tutarı ile tahsil arasındaki kalan (kuruş hassasiyetinde, metin aritmetiği yerine kuruşa çevirerek). */
const shortfall = (amount: string, got: string) => {
  const k = (x: string) => { const [i, f = ''] = x.split('.'); return BigInt(i!) * 100n + BigInt((f + '00').slice(0, 2)); };
  const d = k(amount) - k(got);
  return d > 0n ? `${d / 100n}.${String(d % 100n).padStart(2, '0')}` : null;
};

export function RecoveryCasePage() {
  const { id } = useParams();
  const r = useResource<CaseDetail>(`/api/v1/recovery/cases/${id}`);
  const [dialog, setDialog] = useState<null | 'claim' | 'recover' | 'dismiss'>(null);
  const [text, setText] = useState('');
  const [amount, setAmount] = useState('');
  const [msg, setMsg] = useState<{ tone: 'info' | 'warn' | 'danger'; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  if (r.loading && !r.data) return <div className="page"><Loading rows={6} /></div>;
  if (r.error || !r.data) return <div className="page"><ErrorState error={r.error} onRetry={r.reload} /></div>;
  const c = r.data;
  const act = async (path: string, json: unknown, ok: string) => {
    setBusy(true); setMsg(null);
    try { await api(`/api/v1/recovery/cases/${c.id}/${path}`, { method: 'POST', json }); setMsg({ tone: 'info', text: ok }); setDialog(null); setText(''); }
    catch (e) { const err = e as ApiError; setMsg({ tone: err.status === 409 ? 'warn' : 'danger', text: err.message }); }
    finally { setBusy(false); await r.reload(); }
  };
  const live = ['OPEN', 'CONFIRMED', 'CLAIMED'].includes(c.status);
  const steps = [
    { at: c.detectedAt, who: 'Kural taraması', what: 'Bulgu açıldı' },
    c.confirmedAt && { at: c.confirmedAt, who: c.confirmedBy, what: c.claimable ? 'Doğrulandı' : 'Ele alındı' },
    c.claimedAt && { at: c.claimedAt, who: c.claimedBy, what: 'Tedarikçiden talep edildi', note: c.claimNote },
    c.recoveredAt && { at: c.recoveredAt, who: c.recoveredBy, what: `Geri alındı: ${fmtMoney(c.recoveredAmount, c.currency)}`, note: c.recoveredNote },
    c.dismissedAt && { at: c.dismissedAt, who: c.dismissedBy, what: 'Kapatıldı', note: c.dismissReason },
  ].filter(Boolean) as { at: string; who: string | null; what: string; note?: string | null }[];
  return (
    <div className="page">
      <p className="mb-2 text-sm"><Link to="/lira-defteri">Lira Defteri</Link></p>
      <PageHeader title={`${c.code} · ${KIND[c.kind] ?? c.kind}`}>{c.summary}</PageHeader>
      <div className="mb-4 flex flex-wrap items-center gap-2"><Tag label={STATUS[c.status]} /><Tag label={CATEGORY[c.category]} />
        <span className="text-sm text-ink-subtle">Kural sonucu; tutar ve dayanak aşağıda. Karar insanındır.</span></div>
      {msg && <Banner tone={msg.tone} icon={msg.tone === 'info' ? 'check' : undefined} title={msg.text} />}
      <div className="grid grid-cols-[minmax(0,1fr)_340px] gap-6 max-[1100px]:grid-cols-1">
        <div className="grid content-start gap-5">
          <section className="panel"><div className="panel-head"><h2>Hesap dayanağı</h2></div>
            <dl className="grid grid-cols-[minmax(160px,auto)_1fr] gap-x-6 gap-y-1.5 p-4 text-sm max-[640px]:grid-cols-1">
              {ORDER.filter((k) => k in c.basis).map((k) => <div key={k} className="contents"><dt className="text-ink-muted">{BASIS[k] ?? k}</dt><dd className="tabular max-[640px]:mb-1.5">{showBasis(k, c.basis[k], c.basis, c.currency)}</dd></div>)}
            </dl></section>
          {c.claimDraft && <section className="panel"><div className="panel-head"><h2>Talep yazısı taslağı</h2><span className="text-sm text-ink-subtle">Kurala dayalı metin; göndermeden önce gözden geçirin.</span>
            <Button variant="outline" size="sm" className="ml-auto" onClick={() => void navigator.clipboard?.writeText(c.claimDraft!).then(() => setCopied(true), () => setCopied(false))}>{copied ? 'Kopyalandı' : 'Kopyala'}</Button></div>
            <textarea readOnly aria-label="Talep yazısı taslağı" className="input m-4 min-h-[220px] w-[calc(100%-2rem)] font-[inherit] text-sm" value={c.claimDraft} /></section>}
          <section className="panel"><div className="panel-head"><h2>Geçmiş</h2></div>
            <ol className="grid gap-2 p-4">{steps.map((s, i) => <li key={i} className="text-sm"><strong>{s.what}</strong> · {s.who ?? '—'} · <span className="text-ink-subtle">{fmtDateTime(s.at)}</span>{s.note && <span className="block text-ink-muted">{s.note}</span>}</li>)}
              {c.status === 'OBSOLETE' && <li className="text-sm text-ink-muted">Son taramada koşul artık yoktu ({fmtDateTime(c.lastSeenAt)}).</li>}</ol></section>
        </div>
        <aside className="grid content-start gap-5">
          <section className="panel"><div className="panel-head"><h2>Tutar</h2></div>
            <div className="panel-body"><span className="tabular block text-2xl font-bold">{c.amount ? fmtMoney(c.amount, c.currency) : 'Hesaplanamadı'}</span>
              {c.recoveredAmount && <span className="tabular block text-verified">Geri alınan {fmtMoney(c.recoveredAmount, c.currency)}</span>}
              {c.recoveredAmount && c.amount && shortfall(c.amount, c.recoveredAmount) && <span className="tabular block text-warn">Alınamayan kalan {fmtMoney(shortfall(c.amount, c.recoveredAmount)!, c.currency)} · gerekçe tahsil notunda</span>}</div></section>
          <section className="panel"><div className="panel-head"><h2>Kayıtlar</h2></div>
            <ul className="grid gap-1.5 p-4 text-sm">
              <li>Tedarikçi: <Link to={`/tedarikciler/${c.supplierId}`}>{c.supplierName}</Link></li>
              {c.invoiceId && <li>Fatura: <Link to={`/faturalar/${c.invoiceId}`} className="mono">{c.invoiceNo}</Link></li>}
              {c.contractVersionId && <li>Sözleşme: <Link to={`/sozlesmeler/${c.contractVersionId}${c.kind === 'GUARANTEE_EXPIRY' ? '?sekme=ticari' : ''}`}>{c.contractTitle}</Link></li>}
              <li>Şirket: {c.companyName}</li>
              <li className="text-ink-subtle">Tespit {fmtDateTime(c.detectedAt)} · son görülme {fmtDateTime(c.lastSeenAt)}</li>
            </ul></section>
          {live && (c.can.manage || c.can.settle) && <section className="panel"><div className="panel-head"><h2>Sonraki adım</h2></div>
            <div className="panel-body grid gap-2">
              {c.status === 'OPEN' && c.can.manage && c.kind !== 'FX_DIFF_UNVERIFIED' && <Button disabled={busy} onClick={() => void act('confirm', {}, c.claimable ? 'Bulgu doğrulandı.' : 'Bulgu ele alındı olarak işaretlendi.')}>
                {c.claimable ? 'Doğrula' : 'Ele alındı'}</Button>}
              {c.status === 'OPEN' && c.kind === 'FX_DIFF_UNVERIFIED' && <p className="text-sm text-ink-muted">Tutar hesaplanamadığı için doğrulanamaz: sözleşmeye kur farkı hükmünü girin veya kur tablosunu tamamlayın, sonra yeniden tarayın.</p>}
              {c.status === 'CONFIRMED' && c.claimable && c.can.manage && <Button disabled={busy} onClick={() => { setText(''); setDialog('claim'); }}>Talep edildi olarak işaretle</Button>}
              {c.status === 'CLAIMED' && (c.can.settle ? <Button disabled={busy} onClick={() => { setAmount((c.amount ?? '').replace('.', ',')); setText(''); setDialog('recover'); }}>Tahsil edildi</Button>
                : <p className="text-sm text-ink-muted">Tahsil (iade veya mahsup) kaydını finans yapar.</p>)}
              {c.can.manage && <Button variant="outline" disabled={busy} onClick={() => { setText(''); setDialog('dismiss'); }}>Kapat</Button>}
            </div></section>}
        </aside>
      </div>
      {dialog === 'claim' && <Modal title="Talep edildi" onClose={() => setDialog(null)}
        footer={<><Button variant="outline" onClick={() => setDialog(null)}>Vazgeç</Button><Button disabled={busy || text.trim().length < 5} onClick={() => void act('claim', { note: text }, 'Talep kaydedildi.')}>Kaydet</Button></>}>
        <Field label="Nasıl ve kime iletildi?" hint="Ör. 12.11 tarihli e-postayla satış sorumlusuna; yazı ekte.">{(x) => <textarea className="input min-h-24" {...x} value={text} onChange={(e) => setText(e.target.value)} />}</Field>
      </Modal>}
      {dialog === 'recover' && <Modal title="Tahsil edildi" onClose={() => setDialog(null)}
        footer={<><Button variant="outline" onClick={() => setDialog(null)}>Vazgeç</Button><Button disabled={busy || text.trim().length < 5 || !amount} onClick={() => void act('recover', { amount: toDecimal(amount), note: text }, 'Tahsil kaydedildi.')}>Kaydet</Button></>}>
        <div className="grid gap-1">
          <Field label={`Geri alınan tutar (${c.currency})`} hint={`En fazla ${fmtMoney(c.amount, c.currency)}. Kısmi tahsilde kalan tutar "alınamayan" olarak görünür; nedenini nota yazın.`}>{(x) => <input className="input tabular w-48" inputMode="decimal" {...x} value={amount} onChange={(e) => setAmount(e.target.value)} />}</Field>
          <Field label="Nasıl alındı?" hint="İade dekontu veya mahsup edilen fatura numarası.">{(x) => <textarea className="input min-h-20" {...x} value={text} onChange={(e) => setText(e.target.value)} />}</Field>
        </div>
      </Modal>}
      {dialog === 'dismiss' && <Modal title="Bulguyu kapat" onClose={() => setDialog(null)}
        footer={<><Button variant="outline" onClick={() => setDialog(null)}>Vazgeç</Button><Button disabled={busy || text.trim().length < 10} onClick={() => void act('dismiss', { reason: text }, 'Bulgu kapatıldı.')}>Kapat</Button></>}>
        <Field label="Gerekçe" hint="En az 10 karakter; denetim kaydına yazılır. Kapatılan bulgu yeniden açılmaz.">{(x) => <textarea className="input min-h-24" {...x} value={text} onChange={(e) => setText(e.target.value)} />}</Field>
      </Modal>}
    </div>
  );
}
