import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { api, ApiError } from '../lib/api.ts';
import { useResource } from '../lib/useApi.ts';
import { hasRole, useSession } from '../lib/session.tsx';
import { fmtDate, fmtDateTime, fmtMoney } from '../lib/format.ts';
import { supplierStatus } from '../lib/labels.ts';
import { actorName, downloadBlob, RENEWAL_DECISIONS, statusTag, type ChainStep, type ContractV2, type RemindersRes } from '../lib/contractsV2.ts';
import { Banner, Empty, ErrorState, Field, Loading, Tag } from '../ui/kit.tsx';
import { Icon } from '../ui/icons.tsx';
import { DocumentViewer } from '../ui/DocumentViewer.tsx';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { contractFacts, Facts, PlannedList } from './ContractWizard.tsx';

/**
 * v2 Faz 3 (D108, Figma 10–11): sözleşme detayının yeni sekmeleri (Özet, Belge, İnceleme, Onaylar, Hatırlatıcılar, Geçmiş) ve üst bilgi.
 * Mevcut İmza kontrolü, Koşullar, Yükümlülükler ve Ticari sekmeleri ContractLifecycle.tsx'te aynen kalır.
 */

export type V2State = { data: ContractV2 | null; error: unknown; loading: boolean; reload: () => Promise<void> };

/** Bütün sekmelerin üstünde: kod, durum, tedarikçi · proje · departman ve "Belgeyi indir". Başlık (h1) yalnız yeni sekmelerde. */
export function ContractHeader({ v2, withTitle }: { v2: V2State; withTitle: boolean }) {
  const [err, setErr] = useState<string | null>(null);
  const d = v2.data;
  if (!d) return null;
  const meta = [d.supplier?.legalName, d.project?.visible ? d.project.code : null, d.family.departmentName].filter(Boolean).join(' · ');
  return (
    <div className={cn('flex shrink-0 flex-wrap items-start gap-x-4 gap-y-2 bg-surface px-8 max-[900px]:px-4', withTitle ? 'pt-5 pb-3' : 'border-b border-border py-2')}>
      <div className="min-w-0 flex-1">
        {withTitle ? <>
          <p className="text-sm text-ink-subtle"><Link to="/sozlesmeler" className="text-ink-subtle">Sözleşmeler</Link></p>
          <h1 className="mt-1 [overflow-wrap:anywhere]"><span className="tabular">{d.family.code}</span> · {d.family.title}</h1>
          {meta && <p className="mt-1 text-ink-muted">{meta}</p>}
        </> : <p className="flex flex-wrap items-center gap-x-2 text-sm text-ink-muted"><span className="tabular font-semibold text-ink">{d.family.code}</span>{meta && <span className="max-[640px]:hidden">· {meta}</span>}</p>}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Tag label={statusTag(d.status.code, d.status.label)} />
        {d.document && <Button variant="outline" size={withTitle ? 'default' : 'sm'} onClick={() => { setErr(null); void downloadBlob(`/api/v1/document-versions/${d.document!.documentVersionId}/content`, d.document!.filename ?? `${d.family.code}.pdf`).catch((e) => setErr((e as ApiError).message)); }}>
          <Icon name="download" />Belgeyi indir</Button>}
      </div>
      {err && <p className="w-full text-sm text-danger" role="alert">{err}</p>}
    </div>
  );
}

function V2Gate({ v2, children }: { v2: V2State; children: (d: ContractV2) => React.ReactNode }) {
  if (v2.loading && !v2.data) return <div className="page"><Loading rows={6} /></div>;
  if (v2.error || !v2.data) return <div className="page"><ErrorState error={v2.error} onRetry={v2.reload} /></div>;
  return <>{children(v2.data)}</>;
}

/** Onaydan sonra koşul ya da sürüm değiştiyse: kayıt Taslak'a döner, hatırlatıcılar onaylı koşullarla sürer (R5, R7a). */
function AmendmentNote({ d, rem }: { d: ContractV2; rem: RemindersRes | null }) {
  if (!rem?.effective || ['APPROVED', 'LEGACY', 'EXPIRED'].includes(d.status.code)) return null;
  return (
    <Banner tone="info" title="Onaylı koşullardan sonra değişiklik var">
      Onaydan sonra belge (yeni sürüm) ya da koşullar değiştiği için sözleşme yeniden onay bekliyor ({d.status.label}). Değişiklik onaylanana kadar hatırlatıcılar ve yenileme kararı onaylı koşullara göre sürer.
    </Banner>
  );
}

// --- Özet -------------------------------------------------------------------------------------------------------------

export function SummaryTab({ v2 }: { v2: V2State }) {
  const [params] = useSearchParams();
  return <V2Gate v2={v2}>{(d) => <Summary d={d} savedDraft={params.get('taslak') === '1'} />}</V2Gate>;
}

function Summary({ d, savedDraft }: { d: ContractV2; savedDraft: boolean }) {
  const rem = useResource<RemindersRes>(`/api/v1/contracts/${d.family.id}/reminders`);
  const limit = useResource<{ ceiling: string | null; netConsumption: string; openCommitment: string; currency: string; limitBasis: string; available: string | null }>(
    d.document ? `/api/v1/contract-versions/${d.document.contractVersionId}/limit` : null);
  const wizard = `/sozlesmeler/ekle?taslak=${d.family.id}&adim=3`;
  return (
    <div className="page grid gap-5">
      {savedDraft && <Banner tone="info" icon="check" title="Taslak kaydedildi">Alanlar kaydedildi; hazır olduğunuzda "Onaya gönder" ile gönderin.</Banner>}
      {d.legacy && <Banner tone="neutral" icon="archive" title="Onay kaydı yok (eski kayıt)">Bu sözleşme onay zinciri öncesinde eklendi. Kayıt silinmez ve yürürlükte sayılır; eksik alanlar tamamlanınca onaya gönderilebilir.</Banner>}
      {d.missing.length > 0 && <Banner tone="warn" title={`${d.missing.length} zorunlu alan eksik`} action={d.can.edit ? <Button size="sm" asChild><Link to={wizard}>Alanları tamamla</Link></Button> : undefined}>
        {d.missing.map((m) => m.label).join(', ')}</Banner>}
      {!d.missing.length && d.can.submit && ['DRAFT', 'REJECTED', 'LEGACY'].includes(d.status.code) && (
        <Banner tone="info" title={d.status.code === 'REJECTED' ? 'Reddedildi; düzeltip yeniden gönderin' : 'Onaya gönderilebilir'}
          action={<Button size="sm" asChild><Link to={`/sozlesmeler/ekle?taslak=${d.family.id}&adim=3`}>{d.status.code === 'REJECTED' ? 'Düzenle ve yeniden gönder' : 'Doğrula ve gönder'}</Link></Button>} />
      )}
      <AmendmentNote d={d} rem={rem.data} />
      <div className="grid grid-cols-[minmax(0,1fr)_420px] gap-5 max-[1100px]:grid-cols-1">
        <div className="grid content-start gap-5">
          <section className="panel">
            <div className="panel-head"><h2 className="flex-1">Sözleşme bilgileri</h2>{d.can.edit && <Button size="sm" variant="outline" asChild><Link to={wizard}><Icon name="pen" />Alanları düzenle</Link></Button>}</div>
            <div className="panel-body"><Facts items={[...contractFacts(d), ['Ön inceleme', 'Faz 4\'te (yapay zekâ bağlı değil)']]} /></div>
          </section>
          <section className="panel" aria-labelledby="inv-h">
            <div className="panel-head"><h2 id="inv-h">Eşleşen faturalar</h2></div>
            <div className="panel-body grid gap-3">
              {limit.loading && !limit.data ? <Loading rows={2} /> : limit.error ? <p className="text-ink-muted">Tüketim bilgisi alınamadı.</p> : limit.data && <Usage l={limit.data} />}
              <InvoiceRows familyId={d.family.id} />
              <p className="text-sm text-ink-muted">Tüketim yalnız onaylı faturalardan hesaplanır; tutar, faturanın bu sözleşmeye tahsis edilen kısmıdır. Bütün faturalar: <Link to="/faturalar">Faturalar</Link>.</p>
            </div>
          </section>
        </div>
        <div className="grid content-start gap-5">
          <section className="panel">
            <div className="panel-head"><h2 className="flex-1">Onay zinciri</h2><Link to="?sekme=onaylar" className="text-sm">Onaylar</Link></div>
            <div className="panel-body">{d.chain ? <Steps d={d} compact /> : <p className="text-ink-muted">{d.legacy ? 'Onay kaydı yok (eski kayıt).' : 'Henüz onaya gönderilmedi.'}</p>}</div>
          </section>
          <section className="panel">
            <div className="panel-head"><h2 className="flex-1">Hatırlatıcılar</h2><Link to="?sekme=hatirlaticilar" className="text-sm">Ayrıntı</Link></div>
            <div className="panel-body grid gap-2">
              <PlannedList d={d} />
              <p className="text-sm text-ink-muted">{rem.data?.scheduled ? 'Kuruldu.' : 'Onay tamamlanınca kurulur.'}</p>
            </div>
          </section>
          <section className="panel">
            <div className="panel-head"><h2>Tedarikçi kartı</h2></div>
            <div className="panel-body grid gap-2">
              {d.supplier ? <>
                <p className="font-semibold">{d.supplier.legalName}</p>
                <p className="text-sm text-ink-muted">{d.supplier.vkn ? `VKN ${d.supplier.vkn}` : 'VKN yok'}{d.supplier.contactEmail ? ` · ${d.supplier.contactEmail}` : ''}</p>
                <div><Tag label={supplierStatus[d.supplier.status] ?? { text: d.supplier.status, tone: 'neutral', icon: 'info' }} /></div>
                <Link to={`/tedarikciler/${d.supplier.id}`} className="text-sm font-semibold">Tedarikçi kartını aç</Link>
              </> : <p className="text-ink-muted">Tedarikçi seçilmedi.</p>}
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}

interface FamilyInvoice { id: string; invoiceNo: string; date: string; amount: string; currency: string; status: 'APPROVED' | 'REJECTED' | 'PENDING'; statusLabel: string; supplier: { legalName: string } }
const INVOICE_TONE = { APPROVED: { tone: 'ok', icon: 'check' }, REJECTED: { tone: 'danger', icon: 'x' }, PENDING: { tone: 'warn', icon: 'clock' } } as const;

function InvoiceRows({ familyId }: { familyId: string }) {
  const r = useResource<{ items: FamilyInvoice[] }>(`/api/v1/contracts/${familyId}/invoices`);
  if (r.loading && !r.data) return <Loading rows={2} />;
  if (r.error || !r.data) return <p className="text-sm text-ink-muted">Faturalar alınamadı. <button type="button" className="underline" onClick={() => void r.reload()}>Yeniden dene</button></p>;
  if (!r.data.items.length) return <p className="text-ink-muted">Bu sözleşmeye tahsis edilmiş fatura yok.</p>;
  return (
    <div className="overflow-x-auto rounded-md border border-border">
      <table className="w-full text-left text-sm">
        <caption className="sr-only">Bu sözleşmeye tahsis edilmiş faturalar</caption>
        <thead className="bg-sunken text-ink-muted"><tr><th scope="col" className="px-3 py-2 font-semibold">Fatura no</th><th scope="col" className="px-3 py-2 font-semibold">Tarih</th>
          <th scope="col" className="px-3 py-2 text-right font-semibold">Tutar</th><th scope="col" className="px-3 py-2 font-semibold">Durum</th></tr></thead>
        <tbody>{r.data.items.map((i) => (
          <tr key={i.id} className="border-t border-border">
            <td className="px-3 py-2"><Link to={`/faturalar/${i.id}`} className="tabular">{i.invoiceNo}</Link></td>
            <td className="tabular whitespace-nowrap px-3 py-2">{fmtDate(i.date)}</td>
            <td className="tabular whitespace-nowrap px-3 py-2 text-right">{fmtMoney(i.amount, i.currency)}</td>
            <td className="px-3 py-2"><Tag label={{ text: i.statusLabel, ...INVOICE_TONE[i.status] }} /></td>
          </tr>))}</tbody>
      </table>
    </div>
  );
}

function Usage({ l }: { l: { ceiling: string | null; netConsumption: string; currency: string; limitBasis: string } }) {
  if (!l.ceiling) return <p><span className="tabular font-semibold">{fmtMoney(l.netConsumption, l.currency)}</span> <span className="text-ink-muted">onaylı faturalarla tüketildi · doğrulanmış tavan yok</span></p>;
  const pct = Math.min(100, (Number(l.netConsumption) / Number(l.ceiling)) * 100 || 0);
  return (
    <div className="grid gap-1.5">
      <div className="flex flex-wrap justify-between gap-2"><span className="tabular font-semibold">{fmtMoney(l.netConsumption, l.currency)}</span>
        <span className="tabular text-ink-muted">tavan {fmtMoney(l.ceiling, l.currency)} ({l.limitBasis === 'GROSS' ? 'vergi dahil' : 'vergi hariç'})</span></div>
      <div className="h-2 overflow-hidden rounded-full bg-sunken" role="meter" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(pct)} aria-label="Sözleşme tutarı kullanımı">
        <div className={cn('h-full', pct >= 90 ? 'bg-danger' : pct >= 70 ? 'bg-warn' : 'bg-ink')} style={{ width: `${pct}%` }} /></div>
      <p className="tabular text-sm text-ink-muted">Sözleşme tutarının %{pct.toLocaleString('tr-TR', { maximumFractionDigits: 1 })}'i kullanıldı.</p>
    </div>
  );
}

function stepTag(s: ChainStep, chainStatus: string) {
  if (s.decision === 'APPROVED') return <Tag label={{ text: 'Onayladı', tone: 'human', icon: 'stamp' }} />;
  if (s.decision === 'REJECTED') return <Tag label={{ text: 'Reddetti', tone: 'danger', icon: 'x' }} />;
  if (chainStatus === 'CANCELLED') return <Tag label={{ text: 'İptal edildi', tone: 'neutral', icon: 'minus' }} />;
  if (s.current) return <Tag label={{ text: 'Sırada', tone: 'info', icon: 'info' }} />;
  return <Tag label={{ text: 'Bekliyor', tone: 'neutral', icon: 'clock' }} />;
}

function Steps({ d, compact }: { d: ContractV2; compact?: boolean }) {
  const c = d.chain!;
  return (
    <ol className="grid gap-3" aria-label="Onay adımları">
      {c.steps.map((s) => (
        <li key={s.id} className="flex items-start gap-3">
          <span className="tabular grid size-7 shrink-0 place-items-center rounded-full bg-sunken text-sm">{s.order}</span>
          <div className="min-w-0 flex-1">
            <div className="font-semibold">{s.assignedUser.displayName}</div>
            <div className="text-sm text-ink-muted">{s.kindLabel}{s.viaDeputy ? ' · vekil' : ''}{s.decidedAt ? ` · ${fmtDateTime(s.decidedAt)}` : ''}</div>
            {!compact && s.deputyUser && !s.decision && <div className="text-sm text-ink-subtle">Vekil: {s.deputyUser.displayName}</div>}
            {!compact && s.decidedBy && s.decidedBy.id !== s.assignedUser.id && <div className="text-sm text-ink-subtle">Karar veren: {actorName(s.decidedBy)} (vekil)</div>}
            {!compact && s.reason && <p className={cn('mt-1 text-sm', s.decision === 'REJECTED' ? 'text-danger' : 'text-ink-muted')}>{s.decision === 'REJECTED' ? 'Red gerekçesi: ' : 'Not: '}{s.reason}</p>}
          </div>
          {stepTag(s, c.status)}
        </li>
      ))}
    </ol>
  );
}

// --- Belge -------------------------------------------------------------------------------------------------------------

export function DocumentTab({ v2 }: { v2: V2State }) {
  return <V2Gate v2={v2}>{(d) => !d.document ? <div className="page"><Empty icon="file" title="Belge yok" /></div> : (
    <div className="flex h-full min-h-[520px] flex-col">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 border-b border-border bg-surface px-8 py-2 text-sm text-ink-muted max-[900px]:px-4">
        <span className="font-semibold text-ink">{d.document.filename ?? 'Belge'}</span><span>Sürüm {d.document.versionNo}</span>
        {d.document.pageCount ? <span>{d.document.pageCount} sayfa</span> : null}
        <Link to={`/belgeler/${d.document.documentVersionId}`}>Belge kaydını aç</Link>
      </div>
      <div className="min-h-0 flex-1"><DocumentViewer versionId={d.document.documentVersionId} mimeType={d.document.mimeType} /></div>
    </div>
  )}</V2Gate>;
}

// --- İnceleme (Faz 4) ---------------------------------------------------------------------------------------------------

export function ReviewTab() {
  return (
    <div className="page">
      <div className="rounded-md border border-border bg-surface">
        <Empty icon="sparkles" title="Yapay zekâ ön incelemesi Faz 4'te">
          Taslakla karşılaştırma, farklar ve bulgular yapay zekâ bağlanınca bu sekmede görünür. Şu an inceleme yapılmaz; puan ya da örnek bulgu gösterilmez. Belgeyi Belge sekmesinden siz inceleyin.
        </Empty>
      </div>
    </div>
  );
}

// --- Onaylar -----------------------------------------------------------------------------------------------------------

export function ApprovalsTab({ v2 }: { v2: V2State }) {
  return <V2Gate v2={v2}>{(d) => <Approvals d={d} reload={v2.reload} />}</V2Gate>;
}

function Approvals({ d, reload }: { d: ContractV2; reload: () => Promise<void> }) {
  const [params] = useSearchParams();
  const [mode, setMode] = useState<'APPROVED' | 'REJECTED' | null>(null);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ tone: 'info' | 'warn' | 'danger'; text: string } | null>(null);
  const c = d.chain;
  const current = c?.steps.find((s) => s.current);
  async function decide() {
    if (!current || !mode) return;
    setBusy(true); setMsg(null);
    try {
      const r = await api<{ chainStatus: string; nextStep: { kindLabel: string } | null }>(`/api/v1/contract-approval-steps/${current.id}/decision`, { method: 'POST', json: { decision: mode, reason: reason.trim() || null } });
      setMsg({ tone: 'info', text: mode === 'REJECTED' ? 'Reddedildi; sözleşme ekleyene döndü.' : r.data.chainStatus === 'APPROVED' ? 'Onaylandı; zincir tamamlandı, hatırlatıcılar kuruldu.' : `Onaylandı; sıradaki: ${r.data.nextStep?.kindLabel ?? '—'}.` });
      setMode(null); setReason('');
      await reload();
    } catch (e) {
      const err = e as ApiError; setMsg({ tone: err.status === 409 ? 'warn' : 'danger', text: err.message });
      // Zincir başka biri tarafından ilerletilmiş ya da iptal edilmiş olabilir: güncel durumu göster.
      if (err.status === 409 || err.status === 422 || err.status === 403) await reload();
    }
    finally { setBusy(false); }
  }
  const short = mode === 'REJECTED' && reason.trim().length < 10;
  return (
    <div className="page grid max-w-[920px] gap-5">
      {params.get('gonderildi') === '1' && c?.status === 'OPEN' && <Banner tone="info" icon="check" title="Onaya gönderildi">İlk onaycıya görev açıldı; karar verildikçe sıradaki onaycıya geçer.</Banner>}
      {msg && <Banner tone={msg.tone} title={msg.text} />}
      {!c ? <div className="rounded-md border border-border bg-surface"><Empty icon="stamp" title={d.legacy ? 'Onay kaydı yok (eski kayıt)' : 'Henüz onaya gönderilmedi'}>
        {d.can.submit && !d.missing.length ? <Link to={`/sozlesmeler/ekle?taslak=${d.family.id}&adim=3`}>Alanları doğrula ve gönder</Link> : d.missing.length ? 'Zorunlu alanlar tamamlanınca onaya gönderilebilir.' : null}</Empty></div> : (
        <section className="panel">
          <div className="panel-head"><h2 className="flex-1">Onay zinciri</h2>
            <Tag label={c.status === 'OPEN' ? { text: d.status.label, tone: 'info', icon: 'info' } : c.status === 'APPROVED' ? { text: 'Tamamlandı', tone: 'human', icon: 'stamp' }
              : c.status === 'REJECTED' ? { text: 'Reddedildi', tone: 'danger', icon: 'x' } : { text: 'İptal edildi', tone: 'neutral', icon: 'minus' }} /></div>
          <div className="panel-body grid gap-4">
            <p className="text-sm text-ink-muted">Gönderen {actorName(c.submittedBy)} · {fmtDateTime(c.submittedAt)}{d.chainCount > 1 ? ` · ${d.chainCount}. onay turu (önceki turlar Geçmiş sekmesinde)` : ''}</p>
            {c.note && <p className="rounded-md border border-border bg-white p-3 text-sm"><span className="font-semibold">Gönderim notu:</span> {c.note}</p>}
            {c.status === 'CANCELLED' && c.cancelReason && <Banner tone="warn" title={c.cancelReason}>Açık tur iptal edildi; sözleşme yeniden gönderilince yeni tur başlar.</Banner>}
            <Steps d={d} />
            {d.can.decide && current && c.status === 'OPEN' && (
              <div className="grid gap-3 border-t border-border pt-4">
                <h3 className="text-base">Kararınız · {current.kindLabel}</h3>
                <div className="flex flex-wrap gap-2">
                  <Button variant={mode === 'APPROVED' ? 'default' : 'outline'} aria-pressed={mode === 'APPROVED'} onClick={() => setMode('APPROVED')}><Icon name="stamp" />Onayla</Button>
                  <Button variant={mode === 'REJECTED' ? 'default' : 'outline'} aria-pressed={mode === 'REJECTED'} onClick={() => setMode('REJECTED')}><Icon name="x" />Reddet</Button>
                </div>
                {mode && <>
                  <Field label={mode === 'REJECTED' ? 'Red gerekçesi' : 'Not (isteğe bağlı)'} hint={mode === 'REJECTED' ? 'En az 10 karakter. Sözleşmeyi ekleyen kişiye gider.' : undefined}
                    error={mode === 'REJECTED' && reason.length > 0 && short ? 'Gerekçe en az 10 karakter olmalı.' : null}>
                    {(p) => <textarea className="input" rows={3} maxLength={2000} {...p} value={reason} onChange={(e) => setReason(e.target.value)} />}</Field>
                  <Button className="justify-self-start" disabled={busy || short} onClick={() => void decide()}>{mode === 'REJECTED' ? 'Reddi kaydet' : 'Onayı kaydet'}</Button>
                </>}
              </div>
            )}
            {!d.can.decide && c.status === 'OPEN' && <p className="text-sm text-ink-muted">Karar düğmeleri yalnız sıradaki onaycıya ve etkin vekiline görünür. Sözleşmeyi ekleyen ya da gönderen karar veremez (görev ayrılığı).</p>}
            {c.status === 'REJECTED' && d.can.submit && <Button className="justify-self-start" asChild><Link to={`/sozlesmeler/ekle?taslak=${d.family.id}&adim=3`}>Düzenle ve yeniden gönder</Link></Button>}
          </div>
        </section>
      )}
    </div>
  );
}

// --- Hatırlatıcılar ------------------------------------------------------------------------------------------------------

export function RemindersTab({ v2 }: { v2: V2State }) {
  return <V2Gate v2={v2}>{(d) => <Reminders d={d} />}</V2Gate>;
}

const STATE_LABEL: Record<string, { text: string; tone: 'info' | 'neutral' | 'ok' | 'danger' | 'warn'; icon: string }> = {
  PLANNED: { text: 'Planlandı', tone: 'neutral', icon: 'clock' }, OPEN: { text: 'Görev açık', tone: 'info', icon: 'bell' }, CLOSED: { text: 'Kapandı', tone: 'ok', icon: 'check' },
  SKIPPED: { text: 'Atlandı', tone: 'neutral', icon: 'minus' }, FAILED: { text: 'Başarısız', tone: 'danger', icon: 'x' },
};
const SKIP_REASON: Record<string, string> = { decided: 'karar girildi', obsolete: 'koşullar değişti' };

function Reminders({ d }: { d: ContractV2 }) {
  const r = useResource<RemindersRes>(`/api/v1/contracts/${d.family.id}/reminders`);
  const [decision, setDecision] = useState<keyof typeof RENEWAL_DECISIONS>('RENEW');
  const [rationale, setRationale] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ tone: 'info' | 'warn' | 'danger'; text: string } | null>(null);
  if (r.loading && !r.data) return <div className="page"><Loading rows={5} /></div>;
  if (r.error || !r.data) return <div className="page"><ErrorState error={r.error} onRetry={r.reload} /></div>;
  const x = r.data;
  async function save() {
    setBusy(true); setMsg(null);
    try { await api(`/api/v1/contract-versions/${x.contractVersionId}/renewal-decision`, { method: 'POST', json: { decision, rationale } }); setMsg({ tone: 'info', text: 'Karar kaydedildi; açık hatırlatıcı görevleri kapandı.' }); await r.reload(); }
    catch (e) { const err = e as ApiError; setMsg({ tone: err.status === 409 ? 'warn' : 'danger', text: err.message }); } finally { setBusy(false); }
  }
  return (
    <div className="page grid gap-5">
      <AmendmentNote d={d} rem={x} />
      {!x.emailChannel.configured && <Banner tone="neutral" icon="info" title={x.emailChannel.label}>Hatırlatıcılar İşlerim'e görev olarak düşer. E-posta satırları kuyruğa yazılır ama gönderilmez.</Banner>}
      <div className="grid grid-cols-[minmax(0,1fr)_400px] gap-5 max-[1100px]:grid-cols-1">
        <div className="grid content-start gap-5">
          <section className="panel">
            <div className="panel-head"><h2 className="flex-1">Hatırlatıcılar</h2><span className="text-sm text-ink-subtle">{x.scheduled ? 'Kuruldu' : 'Henüz kurulmadı'}</span></div>
            <div className="panel-body grid gap-3">
              <p className="text-sm text-ink-muted">
                {x.basis.indefinite ? 'Süresiz sözleşme' : x.basis.endDate ? `Bitiş ${fmtDate(x.basis.endDate)}` : 'Bitiş tarihi yok'}
                {x.basis.noticeDeadline ? ` · ihbar son günü ${fmtDate(x.basis.noticeDeadline)}` : ''}
                {` · süreler ${x.offsets.join(', ')} gün`}</p>
              {!x.reminders.length ? (
                <>
                  <h3 className="text-base">Plan</h3>
                  {x.planned.length ? <ul className="grid gap-1.5">{x.planned.map((p) => <li key={`${p.kind}-${p.offset}`} className="flex justify-between gap-3">
                    <span>{p.kind === 'NOTICE' ? `İhbar · ${p.offset} gün önce` : `${p.offset} gün önce`}</span><span className="tabular">{fmtDate(p.date)}</span></li>)}</ul>
                    : <p className="text-ink-muted">Plan için bitiş tarihi ya da ihbar süresi gerekir.</p>}
                  <p className="text-sm text-ink-muted">{d.legacy ? 'Eski kayıtta koşullar doğrulanınca kurulur.' : 'Onay zinciri tamamlanınca kurulur.'}</p>
                </>
              ) : (
                <ul className="grid gap-3">
                  {x.reminders.map((m) => (
                    <li key={m.id} className={cn('grid gap-1.5 border-t border-border pt-3 first:border-t-0 first:pt-0', !m.current && 'opacity-70')}>
                      <div className="flex flex-wrap items-center gap-2"><span className="font-semibold">{m.kindLabel} · {m.offset} gün önce</span>
                        <span className="tabular text-ink-muted">{fmtDate(m.dueOn)}</span>
                        <Tag label={STATE_LABEL[m.state]} />{m.skippedReason && <span className="text-sm text-ink-subtle">({SKIP_REASON[m.skippedReason] ?? m.skippedReason})</span>}
                        {!m.current && <span className="text-sm text-ink-subtle">önceki koşullar</span>}</div>
                      {m.tasks.length > 0 && <p className="text-sm">Görev: {m.tasks.map((t) => `${t.recipient.type === 'USER' ? t.recipient.displayName : t.recipient.label} (${t.status === 'OPEN' ? 'açık' : 'kapandı'})`).join(', ')}</p>}
                      {m.emails.length > 0 && <ul className="grid gap-0.5 text-sm text-ink-muted">{m.emails.map((e) => <li key={e.id}>E-posta → {e.toUser?.displayName ?? 'alıcı'}: {e.statusLabel}{e.sentAt ? ` · ${fmtDateTime(e.sentAt)}` : ''}</li>)}</ul>}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </section>
        </div>
        <section className="panel self-start">
          <div className="panel-head"><h2>Yenileme kararı</h2></div>
          <div className="panel-body grid gap-3">
            {msg && <Banner tone={msg.tone} title={msg.text} />}
            {x.decision ? <>
              <p><Tag label={{ text: `${x.decision.label} · ${actorName(x.decision.decidedBy)}`, tone: 'human', icon: 'stamp' }} /></p>
              <p>{x.decision.rationale}</p><p className="text-sm text-ink-subtle">{fmtDateTime(x.decision.decidedAt)}</p>
            </> : x.can.decide ? (
              <form className="grid gap-2" onSubmit={(e) => { e.preventDefault(); void save(); }}>
                <fieldset className="field"><legend>Karar</legend><div className="radio-list">
                  {(Object.keys(RENEWAL_DECISIONS) as (keyof typeof RENEWAL_DECISIONS)[]).map((k) => <label key={k}><input type="radio" name="renewal" checked={decision === k} onChange={() => setDecision(k)} />{RENEWAL_DECISIONS[k]}</label>)}
                </div></fieldset>
                <Field label="Gerekçe" hint="En az 10 karakter. Karar girilince açık hatırlatıcılar kapanır.">{(p) => <textarea className="input" rows={3} {...p} value={rationale} onChange={(e) => setRationale(e.target.value)} />}</Field>
                <Button type="submit" className="justify-self-start" disabled={busy || rationale.trim().length < 10}><Icon name="stamp" />Kararı kaydet</Button>
              </form>
            ) : <p className="text-ink-muted">{!x.termsId ? 'Koşullar girilmeden karar verilemez.' : 'Kararı Satınalma verir; karar onaylı ya da doğrulanmış koşullara bağlanır.'}</p>}
          </div>
        </section>
      </div>
    </div>
  );
}

// --- Geçmiş -------------------------------------------------------------------------------------------------------------

interface AuditRow { id: string; action: string; entityType: string; entityId: string; reason: string | null; at: string; actorName: string | null }
// API'nin yazdığı denetim eylemleri (apps/api/src/modules: audit(tx, ctx, '…')). Bilinmeyen eylemde ham kod gösterilmez.
const ACTION: Record<string, string> = {
  'contract.created': 'Sözleşme eklendi', 'contract.draft.created': 'Taslak açıldı', 'contract.fields.updated': 'Alanlar güncellendi',
  'contract.submitted': 'Onaya gönderildi', 'contract.approval.decided': 'Onay kararı verildi', 'contract.approval.approved': 'Onay zinciri tamamlandı',
  'contract.approval.rejected': 'Reddedildi', 'contract.approval.cancelled': 'Onay turu iptal edildi (içerik değişti)',
  'contract.reminders.scheduled': 'Hatırlatıcılar kuruldu', 'contract.reminder_settings.updated': 'Hatırlatıcı süreleri değişti',
  'contract.version.added': 'Yeni sürüm eklendi', 'contract.supplier_party.added': 'Tedarikçi tarafı eklendi',
  'contract.terms_entered': 'Koşullar girildi', 'contract.terms_revised': 'Koşullar değiştirildi', 'contract.terms_verified': 'Koşullar doğrulandı',
  'contract.renewal_decided': 'Yenileme kararı verildi',
  'contract.obligation_added': 'Yükümlülük eklendi', 'contract.obligation_recorded': 'Yükümlülük dönemi kaydedildi', 'contract.obligation_retired': 'Yükümlülük kaldırıldı',
  'contract.price_rule.created': 'Fiyat kuralı eklendi', 'contract.price_revision.proposed': 'Fiyat revizyonu önerildi', 'contract.price_revision.approved': 'Fiyat revizyonu onaylandı',
  'contract.sla.created': 'SLA eklendi', 'contract.sla.measured': 'SLA ölçümü kaydedildi',
  'contract.guarantee.received': 'Teminat alındı', 'contract.guarantee.returned': 'Teminat iade edildi',
  'signature.analysis.requested': 'İmza taraması istendi', 'signature.analysis.completed': 'İmza taraması tamamlandı',
  'signature.custody.recorded': 'Fiziksel asıl kaydı', 'signature.digital_validation.blocked': 'E-imza doğrulaması engellendi',
  'signature.exception.requested': 'İmza istisnası istendi', 'signature.exception.decided': 'İmza istisnası karara bağlandı', 'signature.exception.expired': 'İmza istisnasının süresi doldu',
  'signature.finalization.reopened': 'İmza kesinleştirmesi yeniden açıldı', 'signature.requirement.defined': 'İmza gereksinimi tanımlandı',
  'signature.review.recorded': 'İmza incelemesi kaydedildi', 'signature.review.finalized': 'İmza kontrolü kesinleşti',
  'template.created': 'Şablon yüklendi', 'template.version_added': 'Şablonun yeni sürümü yüklendi', 'template.downloaded': 'Şablon indirildi',
};
const actionLabel = (a: string) => ACTION[a] ?? (a.startsWith('signature.') ? 'İmza kontrolü kaydı' : a.startsWith('contract.') ? 'Sözleşme kaydı' : 'Kayıt olayı');


export function HistoryTab({ v2 }: { v2: V2State }) {
  return <V2Gate v2={v2}>{(d) => <History d={d} />}</V2Gate>;
}

function History({ d }: { d: ContractV2 }) {
  const { me } = useSession();
  const auditor = hasRole(me, 'ADMIN', 'AUDITOR');
  const fam = useResource<{ items: AuditRow[] }>(auditor ? `/api/v1/audit-events?entityId=${d.family.id}` : null);
  const ver = useResource<{ items: AuditRow[] }>(auditor && d.document ? `/api/v1/audit-events?entityId=${d.document.contractVersionId}` : null);
  // Herkes için türetilmiş zaman çizelgesi: ekleme, son onay turu ve kararlar. Denetim izi (tam kayıt) Yönetici ve Denetçi'ye.
  const events: { at: string; text: string; who: string; note?: string | null }[] = [{ at: d.family.createdAt, text: 'Sözleşme eklendi', who: actorName(d.family.createdBy) }];
  if (d.chain) {
    events.push({ at: d.chain.submittedAt, text: `Onaya gönderildi${d.chainCount > 1 ? ` (${d.chainCount}. tur)` : ''}`, who: actorName(d.chain.submittedBy), note: d.chain.note });
    for (const s of d.chain.steps) if (s.decidedAt) events.push({ at: s.decidedAt, text: `${s.kindLabel}: ${s.decision === 'APPROVED' ? 'onayladı' : 'reddetti'}`, who: actorName(s.decidedBy), note: s.reason });
    if (d.chain.closedAt && d.chain.status === 'CANCELLED') events.push({ at: d.chain.closedAt, text: 'Onay turu iptal edildi', who: 'Sistem', note: d.chain.cancelReason });
  }
  events.sort((a, b) => a.at.localeCompare(b.at));
  const audit = [...(fam.data?.items ?? []), ...(ver.data?.items ?? [])].sort((a, b) => a.at.localeCompare(b.at));
  return (
    <div className="page grid max-w-[920px] gap-5">
      <section className="panel">
        <div className="panel-head"><h2>Zaman çizelgesi</h2></div>
        <div className="panel-body"><ol className="timeline">{events.map((e, i) => <li key={i}><span className="font-semibold">{e.text}</span>
          <span className="text-ink-muted">{e.who} · {fmtDateTime(e.at)}</span>{e.note && <span className="text-ink-muted">{e.note}</span>}</li>)}</ol>
          {d.chainCount > 1 && !auditor && <p className="mt-3 text-sm text-ink-muted">Önceki {d.chainCount - 1} onay turunun ayrıntısı denetim izindedir (Yönetici ve Denetçi).</p>}</div>
      </section>
      {auditor && (
        <section className="panel">
          <div className="panel-head"><h2>Denetim olayları</h2></div>
          <div className="panel-body">
            {(fam.loading && !fam.data) ? <Loading rows={3} /> : fam.error ? <ErrorState error={fam.error} onRetry={fam.reload} /> : !audit.length ? <p className="text-ink-muted">Kayıt yok.</p> : (
              <ol className="timeline">{audit.map((a) => <li key={a.id}><span className="font-semibold">{actionLabel(a.action)}</span>
                <span className="text-ink-muted">{a.actorName ?? 'Sistem'} · {fmtDateTime(a.at)}</span>{a.reason && <span className="text-ink-muted">{a.reason}</span>}</li>)}</ol>
            )}
          </div>
        </section>
      )}
    </div>
  );
}

// --- Aile / onay adımı adresleri (İşlerim görevleri) ------------------------------------------------------------------------

/**
 * Görevler aile (hatırlatıcı, red, yeniden gönderim) ya da onay adımı kimliği taşır; detay adresi sözleşme sürümü kimliğidir.
 * Aile → güncel sürümün ilgili sekmesi; onay adımı → "Onaylarım" listesinden aileyi bulup Onaylar sekmesi.
 */
export function ContractRedirect({ by }: { by: 'family' | 'step' }) {
  const { id } = useParams();
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const [error, setError] = useState<unknown>(null);
  const [gone, setGone] = useState(false);
  useEffect(() => {
    let off = false;
    (async () => {
      let familyId = id!;
      if (by === 'step') {
        const mine = await api<{ items: { stepId: string; contract: { familyId: string } }[] }>('/api/v1/contract-approvals/mine');
        const hit = mine.data.items.find((x) => x.stepId === id);
        if (!hit) { if (!off) setGone(true); return; }
        familyId = hit.contract.familyId;
      }
      const v = await api<ContractV2>(`/api/v1/contracts/${familyId}/v2`);
      const sekme = by === 'step' ? 'onaylar' : params.get('sekme') ?? 'ozet';
      if (!off) navigate(v.data.document ? `/sozlesmeler/${v.data.document.contractVersionId}?sekme=${sekme}` : '/sozlesmeler', { replace: true });
    })().catch((e) => { if (!off) setError(e); });
    return () => { off = true; };
  }, [by, id, navigate, params]);
  if (gone) return <div className="page"><div className="rounded-md border border-border bg-surface"><Empty icon="check" title="Bu onay adımı artık sizi beklemiyor">
    Adım karara bağlanmış, tur iptal edilmiş ya da başka birine devredilmiş olabilir. <Link to="/islerim">İşlerim'e dön</Link></Empty></div></div>;
  if (error) return <div className="page"><ErrorState error={error} /></div>;
  return <Loading label="Sözleşme açılıyor" />;
}
