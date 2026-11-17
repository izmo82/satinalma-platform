// v2 Faz 5 (D110, Figma 15): tedarikçi başvurusu incelemesi. Sol: başvuru bilgileri, VKN denetimi, aynı VKN'li kart uyarısı, belgeler
// (indir, dosya denetimi, virüs taraması, geçerlilik). Sağ: karar (Onayla → Aday kart, Eksik belge iste, Reddet). Karar yalnız Satınalma.
import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api, ApiError } from '../lib/api.ts';
import { useResource } from '../lib/useApi.ts';
import { fmtDate, fmtDateTime } from '../lib/format.ts';
import { Banner, ErrorState, Field, Loading, Modal, Tag } from '../ui/kit.tsx';
import { Button } from '@/components/ui/button';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { applicationTag, DocTags, downloadDoc, emailTag, fmtSize, type SupplierDoc } from '../lib/supplierV2.tsx';

interface Application {
  id: string; status: string; statusLabel: string; rowVersion: number; legalName: string; country: string; taxIdType: string; taxId: string;
  taxIdCheck: { valid: boolean; label: string }; contactName: string; contactEmail: string; contactPhone: string | null; address: string | null;
  categories: string[]; services: string | null; createdAt: string; verifiedAt: string | null; submittedAt: string | null;
  requestedDocuments: string[] | null; requestedNote: string | null; completionTokenExpiresAt: string | null;
  decidedAt: string | null; decisionReason: string | null; supplierId: string | null;
  existingSupplier: { id: string; legalName: string; stage: string; stageLabel: string; contactEmail: string | null; portalUserCount: number; blocksApproval: boolean; blockReason: string | null } | null;
  documents: SupplierDoc[]; missingRequired: { code: string; name: string; reasonLabel: string }[];
  history: { code: string; label: string; at: string; actor: string | null; note: string | null }[];
  can: { decide: boolean; approve: boolean; requestDocuments: boolean };
}
interface DecisionResult {
  status: string; statusLabel: string; supplier?: { id: string; stageLabel: string; linkedToExisting: boolean };
  portalUser?: { status: string; message: string | null }; emails?: { kind: string; status: string }[]; portalAccessNote?: string;
}
const HISTORY: Record<string, string> = { CREATED: 'Başvuru alındı', VERIFIED: 'E-posta doğrulandı', 'supplier_application.approved': 'Onaylandı',
  'supplier_application.documents_requested': 'Eksik belge istendi', 'supplier_application.rejected': 'Reddedildi' };
const EMAIL_KIND: Record<string, string> = { decision: 'Karar e-postası', portal_access: 'Portal erişimi e-postası', documents_requested: 'Eksik belge e-postası' };
const TAX_TYPE: Record<string, string> = { VKN: 'VKN', TCKN: 'TCKN', FOREIGN: 'Yabancı vergi no' };

export function SupplierApplicationReview() {
  const { id } = useParams();
  const r = useResource<Application>(`/api/v1/supplier-applications/${id}`);
  const [dialog, setDialog] = useState<null | 'approve' | 'documents' | 'reject'>(null);
  const [result, setResult] = useState<DecisionResult | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  if (r.loading && !r.data) return <div className="page"><Loading rows={6} /></div>;
  if (r.error || !r.data) return <div className="page"><ErrorState error={r.error} onRetry={r.reload} /></div>;
  const a = r.data;

  async function decide(body: Record<string, unknown>) {
    setError(null);
    try {
      const res = await api<DecisionResult>(`/api/v1/supplier-applications/${a.id}/decision`, { method: 'POST', json: { ...body, expectedRowVersion: a.rowVersion } });
      setResult(res.data); setDialog(null); await r.reload();
    } catch (e) { setError(e as ApiError); setDialog(null); if ((e as ApiError).status === 409) await r.reload(); }
  }
  const unsent = result?.emails?.some((e) => e.status === 'NOT_CONFIGURED');

  return (
    <div className="page">
      <p className="text-sm text-ink-subtle"><Link to="/tedarikciler?asama=basvuru" className="text-ink-subtle">Tedarikçiler · Başvurular</Link> / {a.legalName}</p>
      <div className="mb-5 mt-1 flex flex-wrap items-start gap-3">
        <div className="min-w-[240px] flex-1">
          <h1 style={{ overflowWrap: 'anywhere' }}>Başvuru · {a.legalName}</h1>
          <p className="mt-1 text-ink-muted">Başvuru {fmtDateTime(a.createdAt)} · girişsiz başvuru formundan{a.verifiedAt ? ` · e-posta doğrulandı ${fmtDateTime(a.verifiedAt)}` : ''}</p>
        </div>
        <Tag label={applicationTag(a.status, a.statusLabel)} />
      </div>

      {result && (
        <Banner tone="info" icon="check" title={`Karar kaydedildi: ${result.statusLabel}`}>
          {result.supplier && <span className="block">{result.supplier.linkedToExisting ? 'Başvuru mevcut tedarikçi kartına bağlandı; kartın durumu değişmedi.' : `Tedarikçi kartı açıldı (${result.supplier.stageLabel}).`}{' '}
            <Link to={`/tedarikciler/${result.supplier.id}`}>Tedarikçi kartını aç</Link></span>}
          {result.portalUser?.message && <span className="block">{result.portalUser.message}</span>}
          {result.emails?.map((e, i) => <span key={i} className="block">{EMAIL_KIND[e.kind] ?? 'E-posta'}: {emailTag(e.status).text}</span>)}
          {unsent && <strong className="block">Başvurana e-posta gönderilemedi — kanal yapılandırılmadı. İleti Yönetim &gt; E-posta kutusunda görünür.</strong>}
          {result.portalAccessNote && <span className="block text-sm">{result.portalAccessNote}</span>}
        </Banner>
      )}
      {error && <Banner tone={error.status === 409 ? 'warn' : 'danger'} title={error.message}>{error.status === 409 ? 'Başvuru güncel bilgilerle yenilendi; kararınızı yeniden gözden geçirin.' : null}</Banner>}

      <div className="grid items-start gap-5 min-[1100px]:grid-cols-[minmax(0,1fr)_380px]">
        <div className="grid min-w-0 gap-5">
          <section className="panel" aria-labelledby="info-h">
            <div className="panel-head"><h2 id="info-h">Başvuru bilgileri</h2></div>
            <div className="panel-body grid gap-3">
              <dl className="facts">
                <dt>Unvan</dt><dd>{a.legalName}</dd>
                <dt>Vergi kimliği</dt><dd><span className="mono">{a.country} · {TAX_TYPE[a.taxIdType] ?? 'Kimlik'} {a.taxId}</span>{' '}
                  <Tag label={a.taxIdCheck.valid ? { text: a.taxIdCheck.label, tone: 'ok', icon: 'check' } : { text: a.taxIdCheck.label, tone: 'danger', icon: 'x' }} /></dd>
                <dt>Yetkili kişi</dt><dd>{a.contactName}</dd>
                <dt>E-posta</dt><dd className="mono">{a.contactEmail}</dd>
                <dt>Telefon</dt><dd>{a.contactPhone ?? '—'}</dd>
                <dt>Adres</dt><dd>{a.address ?? '—'}</dd>
                <dt>Kategoriler</dt><dd>{a.categories.length ? a.categories.join(', ') : '—'}</dd>
                <dt>Hizmetler</dt><dd>{a.services ?? '—'}</dd>
              </dl>
              <p className="text-sm text-ink-subtle">Denetim basamağının doğru olması firmanın gerçekliğini veya mükellefiyetini kanıtlamaz.</p>
              {a.existingSupplier && (
                <Banner tone={a.existingSupplier.blocksApproval ? 'danger' : 'warn'} title="Bu vergi kimliğiyle kayıtlı tedarikçi kartı var">
                  <Link to={`/tedarikciler/${a.existingSupplier.id}`}>{a.existingSupplier.legalName}</Link> · {a.existingSupplier.stageLabel}
                  {a.existingSupplier.blocksApproval ? <span className="block">{a.existingSupplier.blockReason}</span>
                    : <span className="block">Onaylarsanız yeni kart açılmaz; başvuru bu karta bağlanır ve kartın durumu değişmez. Portal kullanıcısı kart doğrulandıktan sonra karttan eklenir.</span>}
                </Banner>
              )}
            </div>
          </section>

          <section aria-labelledby="docs-h">
            <h2 id="docs-h" className="mb-2 text-base">Yüklenen belgeler</h2>
            {!a.documents.length ? <p className="rounded-md border border-border bg-surface px-4 py-3 text-ink-muted">Belge yüklenmedi.</p> : (
              <Table>
                <TableHeader><TableRow className="hover:bg-transparent"><TableHead>Belge</TableHead><TableHead>Dosya</TableHead><TableHead>Geçerlilik</TableHead><TableHead>Kontrol</TableHead><TableHead><span className="sr-only">İndir</span></TableHead></TableRow></TableHeader>
                <TableBody>{a.documents.map((d) => (
                  <TableRow key={d.id}>
                    <TableCell className="font-semibold">{d.typeName}</TableCell>
                    <TableCell className="min-w-[160px]"><span className="mono block break-all text-sm">{d.originalFilename}</span><span className="text-xs text-ink-subtle">{fmtSize(d.sizeBytes)}</span></TableCell>
                    <TableCell className="tabular whitespace-nowrap">{d.validUntil ? fmtDate(d.validUntil) : '—'}</TableCell>
                    <TableCell><DocTags d={d} /></TableCell>
                    <TableCell>{d.quarantined ? <span className="text-sm text-ink-subtle">Karantinada; indirilemez</span>
                      : <Button size="sm" variant="ghost" aria-label={`${d.typeName} indir`} onClick={() => void downloadDoc(d.contentUrl, d.originalFilename)}>İndir</Button>}</TableCell>
                  </TableRow>
                ))}</TableBody>
              </Table>
            )}
            {a.missingRequired.length > 0 && <div className="mt-3"><Banner tone="warn" title="Eksik ya da geçersiz zorunlu belge">{a.missingRequired.map((m) => `${m.name} (${m.reasonLabel.toLocaleLowerCase('tr-TR')})`).join(', ')}.</Banner></div>}
          </section>

          {a.status === 'NEEDS_DOCUMENTS' && (
            <Banner tone="info" title="Başvurandan eksik belge istendi">
              <RequestedNames codes={a.requestedDocuments ?? []} />{a.requestedNote ? ` · Not: ${a.requestedNote}` : ''}
              {a.completionTokenExpiresAt && <span className="block">Tamamlama bağlantısı {fmtDateTime(a.completionTokenExpiresAt)} tarihine kadar geçerli.</span>}
            </Banner>
          )}

          <section className="panel" aria-labelledby="hist-h">
            <div className="panel-head"><h2 id="hist-h">Geçmiş</h2></div>
            <div className="panel-body"><ol className="timeline">{a.history.map((h, i) => (
              <li key={i}><strong>{HISTORY[h.code] ?? 'İşlem'}</strong>{h.note && <span>{h.note}</span>}<span className="subtle">{[h.actor, fmtDateTime(h.at)].filter(Boolean).join(' · ')}</span></li>))}</ol></div>
          </section>
        </div>

        <aside className="panel min-[1100px]:sticky min-[1100px]:top-4" aria-labelledby="dec-h">
          <div className="panel-head"><h2 id="dec-h">Karar</h2></div>
          <div className="panel-body grid gap-3">
            {a.can.decide ? <>
              <p className="text-sm text-ink-muted">Kararı siz verirsiniz. Onayda tedarikçi aday kart olur; Onaylı yapmak için ikinci bir Satınalma kullanıcısının kayıt onayı ve aktivasyonu gerekir.</p>
              {a.status === 'SUBMITTED' && <Button disabled={!a.can.approve} onClick={() => setDialog('approve')}>Onayla (Aday yap)</Button>}
              {a.can.requestDocuments && <Button variant="outline" onClick={() => setDialog('documents')}>Eksik belge iste</Button>}
              <Button variant="outline" className="border-[#dcb3aa] text-danger" onClick={() => setDialog('reject')}>Başvuruyu reddet</Button>
              {a.status === 'NEEDS_DOCUMENTS' && <p className="text-sm text-ink-muted">Başvuran belgeleri tamamlayınca başvuru yeniden "İnceleme bekliyor" olur ve onaylanabilir.</p>}
            </> : a.status === 'APPROVED' || a.status === 'REJECTED' ? <>
              <p><Tag label={applicationTag(a.status, a.statusLabel)} /> {a.decidedAt && <span className="text-sm text-ink-subtle">{fmtDateTime(a.decidedAt)}</span>}</p>
              {a.decisionReason && <p className="text-sm">Gerekçe: {a.decisionReason}</p>}
              {a.supplierId && <Link to={`/tedarikciler/${a.supplierId}`}>Tedarikçi kartını aç</Link>}
            </> : <p className="text-ink-muted">{a.status === 'UNVERIFIED' ? 'Başvuranın e-posta doğrulaması bekleniyor.' : a.status === 'EXPIRED' ? 'Başvuru 24 saatte doğrulanmadığı için kapandı.' : 'Başvuru kararını Satınalma verir.'}</p>}
          </div>
        </aside>
      </div>

      {dialog === 'approve' && <ApproveDialog a={a} onClose={() => setDialog(null)} onSubmit={() => decide({ action: 'APPROVE' })} />}
      {dialog === 'documents' && <DocumentsDialog onClose={() => setDialog(null)} onSubmit={(documents, note) => decide({ action: 'REQUEST_DOCUMENTS', documents, note: note || null })} />}
      {dialog === 'reject' && <RejectDialog onClose={() => setDialog(null)} onSubmit={(reason) => decide({ action: 'REJECT', reason })} />}
    </div>
  );
}

/** İstenen belge kodları türlerin adıyla (ham kod gösterilmez); tür listesi okunamazsa yalnız sayı. */
function RequestedNames({ codes }: { codes: string[] }) {
  const t = useResource<{ items: { code: string; name: string }[] }>('/api/v1/settings/supplier-document-types');
  if (!t.data) return <>{codes.length} belge türü</>;
  return <>{codes.map((c) => t.data!.items.find((x) => x.code === c)?.name ?? 'Belge').join(', ')}</>;
}

function ApproveDialog({ a, onClose, onSubmit }: { a: Application; onClose: () => void; onSubmit: () => Promise<void> }) {
  const [busy, setBusy] = useState(false);
  return (
    <Modal title="Başvuruyu onayla" onClose={onClose} footer={<><Button variant="outline" onClick={onClose}>Vazgeç</Button>
      <Button disabled={busy} onClick={() => { setBusy(true); void onSubmit().finally(() => setBusy(false)); }}>{busy ? 'Kaydediliyor…' : 'Onayla (Aday yap)'}</Button></>}>
      {a.existingSupplier ? <p>Başvuru mevcut <strong>{a.existingSupplier.legalName}</strong> kartına bağlanır; kartın durumu ({a.existingSupplier.stageLabel}) değişmez. Portal kullanıcısı açılmaz.</p>
        : <p><strong>{a.legalName}</strong> için aday tedarikçi kartı açılır, belgeler karta taşınır ve <span className="mono">{a.contactEmail}</span> adresi portal kullanıcısı olarak davet edilir.</p>}
      <p className="mt-2 text-sm text-ink-muted">Onaylı yapmak için ikinci bir Satınalma kullanıcısının kayıt onayı ve aktivasyonu gerekir (görev ayrılığı).</p>
    </Modal>
  );
}

function DocumentsDialog({ onClose, onSubmit }: { onClose: () => void; onSubmit: (docs: string[], note: string) => Promise<void> }) {
  const types = useResource<{ items: { code: string; name: string; active: boolean }[] }>('/api/v1/settings/supplier-document-types');
  const [sel, setSel] = useState<string[]>([]);
  const [note, setNote] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  return (
    <Modal title="Eksik belge iste" onClose={onClose} footer={<><Button variant="outline" onClick={onClose}>Vazgeç</Button>
      <Button disabled={busy} onClick={() => { if (!sel.length) { setErr('En az bir belge türü seçin.'); return; } setBusy(true); void onSubmit(sel, note.trim()).finally(() => setBusy(false)); }}>{busy ? 'Gönderiliyor…' : 'Belgeleri iste'}</Button></>}>
      <p className="mb-3 text-sm text-ink-muted">Başvurana 24 saat geçerli tamamlama bağlantısı yazılır; yalnız seçtiğiniz belgeleri yükleyebilir.</p>
      {types.loading && !types.data ? <Loading rows={3} /> : types.error ? <ErrorState error={types.error} /> : (
        <fieldset className="field"><legend>Belge türleri</legend>
          <div className="grid gap-1.5">{types.data!.items.filter((t) => t.active).map((t) => (
            <label key={t.code} className="inline-flex min-h-8 items-center gap-2 font-normal"><input type="checkbox" className="size-4 accent-ink" checked={sel.includes(t.code)}
              onChange={(e) => setSel((x) => e.target.checked ? [...x, t.code] : x.filter((y) => y !== t.code))} />{t.name}</label>))}</div>
          {err && <span className="error">{err}</span>}
        </fieldset>
      )}
      <Field label="Not" hint="İsteğe bağlı; başvurana gönderilen iletiye eklenir.">{(p) => <textarea className="input" rows={2} maxLength={2000} {...p} value={note} onChange={(e) => setNote(e.target.value)} />}</Field>
    </Modal>
  );
}

function RejectDialog({ onClose, onSubmit }: { onClose: () => void; onSubmit: (reason: string) => Promise<void> }) {
  const [reason, setReason] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  return (
    <Modal title="Başvuruyu reddet" onClose={onClose} footer={<><Button variant="outline" onClick={onClose}>Vazgeç</Button>
      <Button variant="destructive" disabled={busy} onClick={() => { if (reason.trim().length < 10) { setErr('Gerekçe en az 10 karakter olmalı.'); return; } setBusy(true); void onSubmit(reason.trim()).finally(() => setBusy(false)); }}>{busy ? 'Kaydediliyor…' : 'Reddet'}</Button></>}>
      <Field label="Gerekçe" hint="Başvurana gönderilen iletiye eklenir ve denetim izine yazılır." error={err}>{(p) => <textarea className="input" rows={3} maxLength={2000} {...p} value={reason} onChange={(e) => setReason(e.target.value)} />}</Field>
    </Modal>
  );
}

