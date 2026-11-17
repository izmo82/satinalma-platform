import { useState } from 'react';
import { Link } from 'react-router-dom';
import { api, ApiError } from '../lib/api.ts';
import { useResource } from '../lib/useApi.ts';
import { hasPermission, hasRole, useSession } from '../lib/session.tsx';
import { fmtDate, fmtDateTime } from '../lib/format.ts';
import type { Label } from '../lib/labels.ts';
import { Banner, Field, Loading, Modal, Tag } from '../ui/kit.tsx';
import { Button } from '@/components/ui/button';

// v2 Faz 8 (D113, R6): ERP özelliği kapalıyken (ve açıkken de) elle giriş yolları. Her değer kaynağıyla görünür: "Elle", "ERP",
// "ERP (taklit)", "ERP (kaynağı doğrulanamadı)". Taklit sağlayıcıdan gelen değer gerçek ERP değeri gibi gösterilmez.

const SOURCE_TONE: Record<string, Label['tone']> = { Elle: 'human', ERP: 'ok' };
export const sourceTag = (label: string): Label => ({ text: `Kaynak: ${label}`, tone: SOURCE_TONE[label] ?? 'warn', icon: label === 'Elle' ? 'pen' : label === 'ERP' ? 'check' : 'alert' });

type Msg = { tone: 'info' | 'warn' | 'danger'; title: string; text?: string } | null;

// ---------- Tedarikçi kartı: ERP tedarikçi kodu + ERP aktarımı ----------

interface SupplierCode { supplierId: string; code: string | null; source: 'ERP' | 'MANUAL' | null; sourceLabel: string | null; canEdit: boolean; verified?: boolean }

export function SupplierErpPanel({ supplierId }: { supplierId: string }) {
  const { me } = useSession();
  const r = useResource<SupplierCode>(`/api/v1/suppliers/${supplierId}/erp-code`);
  const [editing, setEditing] = useState(false);
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<Msg>(null);
  const [dupId, setDupId] = useState<string | null>(null);
  async function save(value: string | null) {
    setBusy(true); setMsg(null); setDupId(null);
    try {
      await api(`/api/v1/suppliers/${supplierId}/erp-code`, { method: 'PUT', json: { code: value } });
      setEditing(false);
      setMsg({ tone: 'info', title: value ? 'ERP tedarikçi kodu kaydedildi (kaynak: Elle).' : 'ERP tedarikçi kodu temizlendi.' });
      await r.reload();
    } catch (x) {
      const e = x as ApiError;
      if (e.code === 'supplier_code_duplicate' && typeof e.details?.supplierId === 'string') setDupId(e.details.supplierId);
      setMsg({ tone: e.status === 409 ? 'warn' : 'danger', title: e.message });
    } finally { setBusy(false); }
  }
  const d = r.data;
  return (
    <section className="panel" aria-labelledby="erp-h">
      <div className="panel-head"><h2 id="erp-h">ERP</h2></div>
      <div className="panel-body grid gap-3">
        {r.loading && !d ? <Loading rows={2} /> : r.error || !d ? <p className="text-sm text-ink-muted">ERP bilgisi alınamadı.</p> : <>
          <dl className="facts">
            <dt>ERP tedarikçi kodu</dt>
            <dd>{d.code ? <span className="flex flex-wrap items-center gap-2"><span className="mono">{d.code}</span>{d.sourceLabel && <Tag label={sourceTag(d.sourceLabel)} />}</span> : 'Girilmedi'}</dd>
          </dl>
          {d.sourceLabel === 'ERP (taklit)' && <p className="text-sm text-warn">Kod taklit sağlayıcıdan geldi (gerçek değil); gerçek ERP'de doğrulanmadı.</p>}
          {d.sourceLabel === 'ERP (kaynağı doğrulanamadı)' && <p className="text-sm text-warn">Kodun ERP kaynağı doğrulanamadı.</p>}
          {d.canEdit && (editing ? (
            <form className="flex flex-wrap items-end gap-2" onSubmit={(e) => { e.preventDefault(); void save(code.trim() || null); }}>
              <Field label="ERP tedarikçi kodu" hint="1–60 karakter; kaynak 'Elle' olarak kaydedilir.">{(p) => <input className="input mono" {...p} value={code} maxLength={60} onChange={(e) => setCode(e.target.value)} />}</Field>
              <Button type="submit" className="mb-4" disabled={busy || !code.trim()}>{busy ? 'Kaydediliyor…' : 'Kaydet'}</Button>
              <Button type="button" variant="ghost" className="mb-4" onClick={() => setEditing(false)}>Vazgeç</Button>
            </form>
          ) : (
            <div className="flex flex-wrap gap-2">
              <Button size="sm" variant="outline" onClick={() => { setCode(d.code ?? ''); setEditing(true); setMsg(null); }}>{d.code ? 'Kodu düzenle' : 'ERP tedarikçi kodu gir'}</Button>
              {d.code && <Button size="sm" variant="ghost" disabled={busy} onClick={() => void save(null)}>Kodu temizle</Button>}
            </div>
          ))}
          <div aria-live="polite">{msg && <Banner tone={msg.tone} title={msg.title}>{dupId && <Link to={`/tedarikciler/${dupId}`}>Kodun kayıtlı olduğu tedarikçiyi aç</Link>}</Banner>}</div>
        </>}
        {hasPermission(me, 'integration.endpoint.read') && <ErpOutboundPanel entityType="SUPPLIER" entityId={supplierId} embedded />}
      </div>
    </section>
  );
}

// ---------- ERP aktarımı (proje, sözleşme, tedarikçi) ----------

interface Outbound {
  id: string; feature: string; featureLabel: string; status: string; statusLabel: string; provider: { kind: string; label: string; real: boolean } | null; mock: boolean;
  externalRef: string | null; attempts: number; lastError: string | null; alreadyInErp?: boolean; cardCodeUnverified?: boolean;
  manual: { by: { id: string; name: string | null } | null; at: string | null; note: string | null } | null; createdAt: string; updatedAt: string;
}
interface OutboundRes {
  items: Outbound[];
  features: { feature: string; label: string; enabled: boolean; writeEnabled: boolean; modeLabel: string; manualFallback: string; latest: Outbound | null }[];
  can: { recordManual: boolean };
}
const OUT_TONE: Record<string, Label['tone']> = { SENT: 'ok', CONFIRMED: 'ok', MANUAL: 'human', PENDING: 'info', FAILED: 'danger', UNKNOWN: 'warn' };
const OUT_ICON: Record<string, string> = { SENT: 'check', CONFIRMED: 'check', MANUAL: 'stamp', PENDING: 'clock', FAILED: 'x', UNKNOWN: 'help' };
const outTag = (o: Outbound): Label => ({ text: o.statusLabel, tone: o.cardCodeUnverified ? 'warn' : o.mock && o.status !== 'MANUAL' ? 'warn' : OUT_TONE[o.status] ?? 'neutral', icon: OUT_ICON[o.status] ?? 'info' });
const CLOSED = new Set(['SENT', 'CONFIRMED', 'MANUAL']);

/**
 * "ERP aktarımı" satırı. `integration.endpoint.read` izni olmayan rolde (Departman kullanıcısı) çizilmez; 403 hata olarak gösterilmez.
 */
export function ErpOutboundPanel({ entityType, entityId, embedded }: { entityType: 'SUPPLIER' | 'PROJECT' | 'CONTRACT_FAMILY'; entityId: string; embedded?: boolean }) {
  const { me } = useSession();
  const allowed = hasPermission(me, 'integration.endpoint.read');
  const r = useResource<OutboundRes>(allowed ? `/api/v1/erp/outbound?entityType=${entityType}&entityId=${entityId}` : null);
  const [recording, setRecording] = useState<string | null>(null);
  const [msg, setMsg] = useState<Msg>(null);
  if (!allowed || (r.error instanceof ApiError && (r.error.status === 403 || r.error.status === 404))) return null;
  const body = r.loading && !r.data ? <Loading rows={2} /> : r.error || !r.data ? <p className="text-sm text-ink-muted">ERP aktarım bilgisi alınamadı.</p> : (
    <div className="grid gap-3">
      {r.data.features.map((f) => {
        const older = r.data!.items.filter((x) => x.feature === f.feature && x.id !== f.latest?.id);
        return (
          <div key={f.feature} className="grid gap-1.5">
            <dl className="facts">
              <dt>ERP aktarımı</dt>
              <dd>{f.latest ? <span className="flex flex-wrap items-center gap-2"><Tag label={outTag(f.latest)} className="whitespace-normal" />{f.latest.externalRef && <span className="mono text-sm">ERP ref. {f.latest.externalRef}</span>}</span>
                : <span>Kayıt yok</span>}
                <span className="block text-sm text-ink-muted">{f.label}: {f.modeLabel}</span></dd>
              {f.latest?.manual && <><dt>Elle iletildi</dt><dd className="text-sm">{f.latest.manual.by?.name ?? 'Satınalma'} · {fmtDateTime(f.latest.manual.at)}{f.latest.manual.note ? ` · ${f.latest.manual.note}` : ''}</dd></>}
              {f.latest?.lastError && !f.latest.alreadyInErp && <><dt>Son not</dt><dd className="text-sm text-ink-muted">{f.latest.lastError}</dd></>}
            </dl>
            {f.feature === 'REQUISITION' && <p className="text-sm text-ink-subtle">Birden çok kazanan varsa ERP'ye tek talep olarak gider; kazananların ERP kodları virgülle tek alana yazılır, birinin kodu yoksa alan boş gider.</p>}
            {r.data!.can.recordManual && !(f.latest && CLOSED.has(f.latest.status)) && (
              <div><Button size="sm" variant="outline" onClick={() => { setMsg(null); setRecording(f.feature); }}>ERP'ye elle iletildi</Button></div>
            )}
            {older.length > 0 && <details className="text-sm"><summary className="cursor-pointer text-ink-muted">Önceki kayıtlar ({older.length})</summary>
              <ul className="mt-1 grid gap-1">{older.map((o) => <li key={o.id} className="flex flex-wrap items-center gap-2"><span className="tabular text-ink-subtle">{fmtDateTime(o.createdAt)}</span><Tag label={outTag(o)} className="whitespace-normal" />{o.externalRef && <span className="mono">{o.externalRef}</span>}</li>)}</ul></details>}
          </div>
        );
      })}
      <div aria-live="polite">{msg && <Banner tone={msg.tone} title={msg.title}>{msg.text}</Banner>}</div>
      {recording && <ManualOutboundDialog feature={recording} label={r.data.features.find((f) => f.feature === recording)?.label ?? ''} entityType={entityType} entityId={entityId}
        onClose={() => setRecording(null)} onDone={async (m) => { setRecording(null); setMsg(m); await r.reload(); }} />}
    </div>
  );
  if (embedded) return <div className="grid gap-2 border-t border-border pt-3"><h3 className="text-[15px] font-semibold">ERP'ye aktarım</h3>{body}</div>;
  return (
    <section className="panel" aria-labelledby={`erp-out-${entityType}`}>
      <div className="panel-head"><h2 id={`erp-out-${entityType}`}>ERP aktarımı</h2></div>
      <div className="panel-body">{body}</div>
    </section>
  );
}

function ManualOutboundDialog({ feature, label, entityType, entityId, onClose, onDone }: { feature: string; label: string; entityType: string; entityId: string; onClose: () => void; onDone: (m: Msg) => Promise<void> }) {
  const [ref, setRef] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<ApiError | null>(null);
  async function submit() {
    setBusy(true); setErr(null);
    try {
      await api('/api/v1/erp/outbound/manual', { method: 'POST', json: { feature, entityType, entityId, externalRef: ref.trim(), note: note.trim() || null } });
      await onDone({ tone: 'info', title: 'ERP\'ye elle iletildi olarak kaydedildi.', text: `ERP referans no ${ref.trim()}.` });
    } catch (x) { setErr(x as ApiError); } finally { setBusy(false); }
  }
  const retry = typeof err?.details?.retryAfterMinutes === 'number' ? ` En geç ${err.details.retryAfterMinutes} dakika sonra yeniden bakın.` : '';
  return (
    <Modal title={`${label}: ERP'ye elle iletildi`} onClose={onClose} footer={<>
      <Button variant="ghost" onClick={onClose}>Vazgeç</Button>
      <Button disabled={busy || !ref.trim()} onClick={() => void submit()}>{busy ? 'Kaydediliyor…' : 'Kaydet'}</Button>
    </>}>
      <div className="grid gap-2">
        <Banner tone="warn" title="Elle kayıt sonradan düzeltilemez">Kaydetmeden önce ERP referans numarasını ERP ekranıyla karşılaştırın. Bekleyen otomatik yazma varsa bu kayıtla kapanır ve ERP'ye istek atılmaz.</Banner>
        <Field label="ERP referans no" hint="1–120 karakter">{(p) => <input className="input mono" {...p} value={ref} maxLength={120} onChange={(e) => setRef(e.target.value)} />}</Field>
        <Field label="Not (isteğe bağlı)">{(p) => <textarea className="input min-h-20" {...p} value={note} maxLength={1000} onChange={(e) => setNote(e.target.value)} />}</Field>
        <div aria-live="polite">{err && <Banner tone={err.status === 409 ? 'warn' : 'danger'} title={err.message}>{retry || undefined}</Banner>}</div>
      </div>
    </Modal>
  );
}

// ---------- Fatura detayı: kaynak, ERP referansları, ödeme durumu ----------

export interface ErpSource {
  kind: 'ERP' | 'EINVOICE' | 'MANUAL'; label: string; erp: { invoiceId: string; providerKind: string | null; providerLabel: string | null; real: boolean } | null;
  payment: { status: string; statusLabel: string; at: string | null; source: 'ERP' | 'MANUAL'; sourceLabel: string } | null;
}
const PAYMENT_OPTIONS = [['PAID', 'Ödendi'], ['PARTIAL', 'Kısmi'], ['UNPAID', 'Ödenmedi'], ['UNKNOWN', 'Bilinmiyor']] as const;

export function InvoiceErpPanel({ invoiceId, src, refs, onChanged }: { invoiceId: string; src: ErpSource; refs: { contract: string | null; order: string | null }; onChanged: () => Promise<void> }) {
  const { me } = useSession();
  const canEdit = hasRole(me, 'PROCUREMENT'); // erp.manual.record
  const [editing, setEditing] = useState(false);
  const [status, setStatus] = useState(src.payment?.status ?? 'UNKNOWN');
  const [at, setAt] = useState(src.payment?.at ?? '');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<Msg>(null);
  async function save(clear = false) {
    setBusy(true); setMsg(null);
    try {
      await api(`/api/v1/invoices/${invoiceId}/erp-payment-status`, { method: 'PUT', json: clear ? { status: null, at: null } : { status, at: at || null } });
      setEditing(false);
      setMsg({ tone: 'info', title: clear ? 'Ödeme durumu bilgisi temizlendi.' : 'Ödeme durumu kaydedildi (kaynak: Elle).', text: 'Bu yalnız bilgidir; uygulama ödeme yapmaz.' });
      await onChanged();
    } catch (x) { const e = x as ApiError; setMsg({ tone: e.status === 409 ? 'warn' : 'danger', title: e.message }); }
    finally { setBusy(false); }
  }
  const mock = src.kind === 'ERP' && src.erp?.providerKind === 'TAKLIT';
  return (
    <section className="panel" aria-labelledby="inv-erp-h">
      <div className="panel-head"><h2 id="inv-erp-h">Kaynak ve ERP</h2></div>
      <div className="panel-body grid gap-3">
        <dl className="facts">
          <dt>Kaynak</dt><dd>{src.label}{mock && <span className="block text-sm text-warn">Taklit sağlayıcıdan içe aktarıldı; gerçek Oracle kaydı değil.</span>}</dd>
          {src.erp && <><dt>ERP fatura kimliği</dt><dd><span className="mono">{src.erp.invoiceId}</span>{src.erp.providerLabel && <span className="block text-sm text-ink-muted">{src.erp.providerLabel}</span>}</dd></>}
          <dt>ERP sözleşme referansı</dt><dd className="mono">{refs.contract ?? '—'}</dd>
          <dt>ERP sipariş referansı</dt><dd className="mono">{refs.order ?? '—'}</dd>
          <dt>ERP ödeme durumu</dt>
          <dd>{src.payment ? <span className="flex flex-wrap items-center gap-2"><span className="font-semibold">{src.payment.statusLabel}</span>{src.payment.at && <span className="text-sm">{fmtDate(src.payment.at)}</span>}<Tag label={sourceTag(src.payment.sourceLabel)} /></span> : 'Bilgi yok'}</dd>
        </dl>
        <p className="text-sm text-ink-subtle">Ödeme ERP'de yürür; bu alan yalnız bilgidir. ERP okuması elle girilen değeri ezmez.</p>
        {canEdit && (editing ? (
          <form className="grid gap-x-3 min-[480px]:grid-cols-2" onSubmit={(e) => { e.preventDefault(); void save(); }}>
            <Field label="Ödeme durumu">{(p) => <select className="input" {...p} value={status} onChange={(e) => setStatus(e.target.value)}>{PAYMENT_OPTIONS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select>}</Field>
            <Field label="Tarih (isteğe bağlı)">{(p) => <input className="input" type="date" {...p} value={at} onChange={(e) => setAt(e.target.value)} />}</Field>
            <div className="flex flex-wrap gap-2 min-[480px]:col-span-2">
              <Button type="submit" size="sm" disabled={busy}>{busy ? 'Kaydediliyor…' : 'Kaydet'}</Button>
              <Button type="button" size="sm" variant="ghost" onClick={() => setEditing(false)}>Vazgeç</Button>
            </div>
          </form>
        ) : (
          <div className="flex flex-wrap gap-2">
            <Button size="sm" variant="outline" onClick={() => { setStatus(src.payment?.status ?? 'UNKNOWN'); setAt(src.payment?.at ?? ''); setEditing(true); setMsg(null); }}>Ödeme durumunu gir</Button>
            {src.payment?.source === 'MANUAL' && <Button size="sm" variant="ghost" disabled={busy} onClick={() => void save(true)}>Temizle</Button>}
          </div>
        ))}
        <div aria-live="polite">{msg && <Banner tone={msg.tone} title={msg.title}>{msg.text}</Banner>}</div>
      </div>
    </section>
  );
}

// ---------- Departman masraf merkezi kodu (Yönetici) ----------

interface DeptCostCenter { departmentId: string; name: string; costCenterCode: string | null; source: 'ERP' | 'MANUAL' | null; sourceLabel: string | null }
interface ErpCostCenter { code: string; name: string; active: boolean; activeLabel: string; provider: { kind: string; label: string; real: boolean } | null; syncedAt: string }

export function CostCentersPanel() {
  const deps = useResource<{ items: DeptCostCenter[] }>('/api/v1/departments/cost-centers');
  const erp = useResource<{ items: ErpCostCenter[] }>('/api/v1/integration/erp/cost-centers');
  const erpItems = erp.data?.items ?? [];
  return (
    <section className="panel mt-5" aria-labelledby="cc-h">
      <div className="panel-head"><h2 id="cc-h">Masraf merkezi kodları</h2></div>
      <div className="panel-body grid gap-3">
        <p className="text-sm text-ink-muted">Departmanın ERP masraf merkezi kodu. ERP'den okunan listeden seçilir ya da elle yazılır; departmanların ana kaynağı Entra kalır.
          {erpItems.length ? '' : ' ERP\'den okunmuş masraf merkezi yok (Entegrasyonlar > Departman / masraf merkezi).'}</p>
        {erpItems.some((x) => x.provider?.kind === 'TAKLIT') && <p className="text-sm text-warn">ERP listesi taklit sağlayıcıdan okundu (gerçek değil).</p>}
        {deps.loading && !deps.data ? <Loading rows={3} /> : deps.error || !deps.data ? <p className="text-sm text-danger">Masraf merkezleri yüklenemedi.</p>
          : !deps.data.items.length ? <p className="text-ink-muted">Henüz departman yok.</p>
          : <ul className="grid">{deps.data.items.map((d) => <CostCenterRow key={d.departmentId} d={d} erp={erpItems} onSaved={deps.reload} />)}</ul>}
        <datalist id="erp-cost-centers">{erpItems.map((x) => <option key={x.code} value={x.code}>{`${x.name}${x.active ? '' : ' (pasif)'}`}</option>)}</datalist>
      </div>
    </section>
  );
}

function CostCenterRow({ d, erp, onSaved }: { d: DeptCostCenter; erp: ErpCostCenter[]; onSaved: () => Promise<void> }) {
  const [editing, setEditing] = useState(false);
  const [code, setCode] = useState(d.costCenterCode ?? '');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<Msg>(null);
  const known = d.costCenterCode ? erp.find((x) => x.code === d.costCenterCode) : undefined;
  async function save(value: string | null) {
    setBusy(true); setMsg(null);
    try {
      const r = (await api<{ knownInErp: boolean | null }>(`/api/v1/departments/${d.departmentId}/cost-center`, { method: 'PUT', json: { code: value } })).data;
      setEditing(false);
      setMsg(value ? { tone: r.knownInErp === false ? 'warn' : 'info', title: 'Masraf merkezi kodu kaydedildi (kaynak: Elle).',
        text: r.knownInErp === false ? 'Bu kod ERP\'den okunan listede yok; yine de kaydedildi.' : r.knownInErp ? 'Kod ERP listesinde var.' : undefined } : { tone: 'info', title: 'Masraf merkezi kodu temizlendi.' });
      await onSaved();
    } catch (x) { setMsg({ tone: 'danger', title: (x as ApiError).message }); } finally { setBusy(false); }
  }
  return (
    <li className="grid gap-2 border-b border-border py-2.5 last:border-0">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <span className="min-w-40 flex-1 font-semibold">{d.name}</span>
        {d.costCenterCode ? <><span className="mono">{d.costCenterCode}</span>{d.sourceLabel && <Tag label={sourceTag(d.sourceLabel)} />}
          {known ? <span className="text-sm text-ink-muted">{known.name}{known.active ? '' : ' (ERP\'de pasif)'}</span> : erp.length ? <span className="text-sm text-warn">ERP listesinde yok</span> : null}</>
          : <span className="text-sm text-ink-muted">Kod girilmedi</span>}
        {!editing && <Button size="sm" variant="outline" aria-label={`${d.name} masraf merkezi kodunu düzenle`} onClick={() => { setCode(d.costCenterCode ?? ''); setEditing(true); setMsg(null); }}>Düzenle</Button>}
      </div>
      {editing && (
        <form className="flex flex-wrap items-end gap-2" onSubmit={(e) => { e.preventDefault(); void save(code.trim() || null); }}>
          <Field label={`${d.name} masraf merkezi kodu`} hint={erp.length ? 'ERP listesinden seçin ya da elle yazın.' : 'Elle yazın.'}>
            {(p) => <input className="input mono" list="erp-cost-centers" {...p} value={code} maxLength={60} onChange={(e) => setCode(e.target.value)} />}</Field>
          <Button type="submit" size="sm" className="mb-4" disabled={busy}>{busy ? 'Kaydediliyor…' : 'Kaydet'}</Button>
          {d.costCenterCode && <Button type="button" size="sm" variant="ghost" className="mb-4" disabled={busy} onClick={() => void save(null)}>Temizle</Button>}
          <Button type="button" size="sm" variant="ghost" className="mb-4" onClick={() => setEditing(false)}>Vazgeç</Button>
        </form>
      )}
      <div aria-live="polite">{msg && <p className={msg.tone === 'danger' ? 'text-sm text-danger' : msg.tone === 'warn' ? 'text-sm text-warn' : 'text-sm text-ink-muted'}>{msg.title}{msg.text ? ` ${msg.text}` : ''}</p>}</div>
    </li>
  );
}
