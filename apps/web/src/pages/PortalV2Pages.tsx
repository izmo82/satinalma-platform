// v2 Faz 5 (D110, Figma P2): tedarikçi portalının yeni ekranları — özet kartları, Tekliflerim, Belgelerim, Skorum ve risk durumum,
// Firma bilgileri. Tedarikçi yalnız kendi kartını görür (R17); iç notlar, içsel risk faktörleri ve iç kullanıcı adları yanıtta yoktur (R15).
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { api, ApiError } from '../lib/api.ts';
import { useResource } from '../lib/useApi.ts';
import { fmtDate, fmtDateTime, fmtMoney } from '../lib/format.ts';
import { Banner, Empty, ErrorState, Field, Loading, PageHeader, Tag } from '../ui/kit.tsx';
import { Icon } from '../ui/icons.tsx';
import { Button } from '@/components/ui/button';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { ACCEPT, DocTags, downloadDoc, fmtNum, fmtSize, typesText, type SupplierDoc } from '../lib/supplierV2.tsx';
import { cn } from '@/lib/utils';

interface Summary { openInvites: number; pendingSurveys: number; documents: { expired: number; expiring: number; missing: number }; standing: { score: number | null; levelLabel: string | null } }

function Card({ to, title, children, tone }: { to: string; title: string; children: React.ReactNode; tone?: 'warn' | 'danger' }) {
  return (
    <Link to={to} className={cn('grid gap-1 rounded-md border bg-surface px-4 py-3 text-ink no-underline transition-colors duration-150 hover:bg-sunken',
      tone === 'danger' ? 'border-[#e5b9b0]' : tone === 'warn' ? 'border-[#e8d29c]' : 'border-border')}>
      <span className="text-sm font-semibold text-ink-muted">{title}</span>
      {children}
    </Link>
  );
}

/** Teklif davetleri ekranının üstündeki özet (P2). Özet yüklenemezse davet listesi yine çalışır. */
export function PortalSummaryCards() {
  const r = useResource<Summary>('/api/v1/portal/summary');
  if (!r.data) return r.error ? <p className="mb-4 text-sm text-ink-muted">Özet bilgileri şu an alınamadı.</p> : null;
  const s = r.data;
  const docTone = s.documents.expired || s.documents.missing ? 'danger' : s.documents.expiring ? 'warn' : undefined;
  return (
    <section aria-label="Özet" className="mb-5 grid grid-cols-2 gap-3 min-[1100px]:grid-cols-4">
      <Card to="/portal" title="Açık teklif daveti"><span className="tabular text-2xl font-semibold">{s.openInvites}</span></Card>
      <Card to="/portal/anketler" title="Yanıt bekleyen anket" tone={s.pendingSurveys ? 'warn' : undefined}><span className="tabular text-2xl font-semibold">{s.pendingSurveys}</span></Card>
      <Card to="/portal/belgeler" title="Belgeleriniz" tone={docTone}>
        <span className="text-sm">{!s.documents.expired && !s.documents.expiring && !s.documents.missing ? 'Tüm belgeler geçerli'
          : [s.documents.expired && `${s.documents.expired} süresi dolmuş`, s.documents.expiring && `${s.documents.expiring} süresi yaklaşıyor`, s.documents.missing && `${s.documents.missing} eksik`].filter(Boolean).join(' · ')}</span>
      </Card>
      <Card to="/portal/skorum" title="Skorunuz ve risk durumunuz">
        <span>{s.standing.score === null ? <span className="text-sm text-ink-muted">Henüz skor yok</span> : <><span className="tabular text-2xl font-semibold">{fmtNum(s.standing.score)}</span><span className="text-sm text-ink-muted"> / 100</span></>}</span>
        {s.standing.levelLabel && <span className="text-sm">{s.standing.levelLabel}</span>}
      </Card>
    </section>
  );
}

/** Teklif ekranına (P3) eklenen tek bant: süresi dolmuş belge varsa. */
export function ExpiredDocumentsBand() {
  const r = useResource<Summary>('/api/v1/portal/summary');
  const n = r.data?.documents.expired ?? 0;
  if (!n) return null;
  return <Banner tone="warn" title="Belgelerinizin süresi dolmuş" action={<Button asChild size="sm" variant="outline"><Link to="/portal/belgeler">Belgelerim</Link></Button>}>
    {n} belgenizin geçerlilik süresi doldu. Teklif verebilirsiniz; belgeyi Belgelerim ekranından yenileyin.</Banner>;
}

// ---------- Tekliflerim ----------
interface BidRow { roundId: string; roundNo: number; projectCode: string; projectTitle: string; buyerName: string; closesAt: string; open: boolean; roundStatusLabel: string;
  myBid: { versionNo: number; submittedAt: string; currency: string; total: string } | null; versionCount: number; bidStatusLabel: string }

export function PortalBids() {
  const r = useResource<{ items: BidRow[] }>('/api/v1/portal/bids');
  return (
    <div className="page">
      <PageHeader title="Tekliflerim">Davet edildiğiniz turlar ve gönderdiğiniz son teklif. Tutarlar yalnız sizin teklifinizdir; diğer firmaların teklifleri görünmez.</PageHeader>
      {r.loading && !r.data ? <Loading /> : r.error ? <ErrorState error={r.error} onRetry={r.reload} /> : !r.data?.items.length ? (
        <div className="rounded-md border border-border bg-surface"><Empty icon="receipt" title="Henüz teklif davetiniz yok">Bir alıcı sizi teklif turuna davet ettiğinde burada görünür.</Empty></div>
      ) : (
        <Table>
          <TableHeader><TableRow className="hover:bg-transparent"><TableHead>Proje</TableHead><TableHead className="max-[900px]:hidden">Alıcı</TableHead><TableHead>Kapanış</TableHead>
            <TableHead>Teklifim</TableHead><TableHead className="text-right">Toplam</TableHead><TableHead><span className="sr-only">Eylem</span></TableHead></TableRow></TableHeader>
          <TableBody>{r.data.items.map((x) => (
            <TableRow key={x.roundId}>
              <TableCell className="min-w-[200px]"><span className="block font-semibold">{x.projectTitle}</span><span className="text-sm text-ink-subtle">{x.projectCode} · Tur {x.roundNo}</span></TableCell>
              <TableCell className="max-[900px]:hidden">{x.buyerName}</TableCell>
              <TableCell className="whitespace-nowrap">{fmtDateTime(x.closesAt)}<span className="block text-sm text-ink-subtle">{x.roundStatusLabel}</span></TableCell>
              <TableCell>{x.myBid ? <><span className="block">{x.bidStatusLabel}</span><span className="text-sm text-ink-subtle">{fmtDateTime(x.myBid.submittedAt)}</span></> : <span className="text-ink-subtle">{x.bidStatusLabel}</span>}</TableCell>
              <TableCell className="tabular whitespace-nowrap text-right">{x.myBid ? fmtMoney(x.myBid.total, x.myBid.currency) : '—'}</TableCell>
              <TableCell><Button asChild size="sm" variant={x.open ? 'default' : 'outline'}><Link to={`/portal/${x.roundId}`}>{x.open ? (x.myBid ? 'Teklifi güncelle' : 'Teklif ver') : 'Görüntüle'}</Link></Button></TableCell>
            </TableRow>
          ))}</TableBody>
        </Table>
      )}
    </div>
  );
}

// ---------- Belgelerim ----------
interface PortalDocs {
  types: { code: string; name: string; expiryRequired: boolean; required: boolean; current: SupplierDoc[] }[];
  documents: SupplierDoc[]; missing: { code: string; name: string; reason: string; reasonLabel: string }[]; upload: { maxBytes: number; mimeTypes: string[] };
}

function UploadForm({ type, replaces, upload, onDone, onCancel }: { type: PortalDocs['types'][number]; replaces: SupplierDoc | null; upload: PortalDocs['upload'];
  onDone: (msg: string) => Promise<void>; onCancel: () => void }) {
  const [file, setFile] = useState<File | null>(null);
  const [until, setUntil] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const id = `up-${type.code}`;
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!file) { setErr('Dosya seçin.'); return; }
    if (file.size > upload.maxBytes) { setErr(`Dosya ${fmtSize(upload.maxBytes)} sınırını aşıyor.`); return; }
    if (type.expiryRequired && !until) { setErr('Geçerlilik tarihini girin.'); return; }
    const fd = new FormData();
    fd.set('typeCode', type.code);
    if (until) fd.set('validUntil', until);
    if (replaces) fd.set('replacesId', replaces.id);
    fd.set('file', file, file.name);
    setBusy(true); setErr(null);
    try { await api('/api/v1/portal/documents', { method: 'POST', body: fd }); await onDone(replaces ? `${type.name} yenilendi; önceki belge "yerine yenisi yüklendi" olarak saklanır.` : `${type.name} yüklendi.`); }
    catch (x) { setErr(x instanceof ApiError ? x.message : 'Belge yüklenemedi.'); }
    finally { setBusy(false); }
  }
  return (
    <form onSubmit={(e) => void submit(e)} className="mt-2 grid gap-2 rounded-md border border-border bg-white p-3" aria-label={`${type.name} ${replaces ? 'yenile' : 'yükle'}`}>
      <div className="flex flex-wrap items-end gap-3">
        <div className="grid min-w-0 flex-1 gap-1"><label htmlFor={id} className="text-sm font-semibold">Dosya</label>
          <input id={id} type="file" accept={ACCEPT} className="input min-w-0 py-1.5" onChange={(e) => setFile(e.target.files?.[0] ?? null)} /></div>
        {type.expiryRequired && <div className="grid gap-1"><label htmlFor={`${id}-u`} className="text-sm font-semibold">Geçerlilik tarihi</label>
          <input id={`${id}-u`} type="date" className="input tabular" value={until} onChange={(e) => setUntil(e.target.value)} /></div>}
      </div>
      <p className="text-xs text-ink-muted">{typesText(upload.mimeTypes)} · en çok {fmtSize(upload.maxBytes)}.</p>
      {err && <p role="alert" className="text-sm text-danger">{err}</p>}
      <div className="flex gap-2"><Button type="submit" size="sm" disabled={busy}>{busy ? 'Yükleniyor…' : replaces ? 'Yenisini yükle' : 'Yükle'}</Button>
        <Button type="button" size="sm" variant="ghost" onClick={onCancel}>Vazgeç</Button></div>
    </form>
  );
}

export function PortalDocuments() {
  const r = useResource<PortalDocs>('/api/v1/portal/documents');
  const [open, setOpen] = useState<{ code: string; replaces: SupplierDoc | null } | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [showOld, setShowOld] = useState(false);
  if (r.loading && !r.data) return <div className="page"><PageHeader title="Belgelerim" /><Loading /></div>;
  if (r.error || !r.data) return <div className="page"><PageHeader title="Belgelerim" /><ErrorState error={r.error} onRetry={r.reload} /></div>;
  const d = r.data;
  const old = d.documents.filter((x) => !x.current);
  return (
    <div className="page">
      <PageHeader title="Belgelerim">Kurumun sizden istediği belgeler ve geçerlilikleri. Süresi yaklaşan belge için bitişten 30 ve 7 gün önce ve bitiş günü hatırlatma yapılır. Yenilediğiniz belge eskisini silmez.</PageHeader>
      {msg && <Banner tone="info" icon="check" title={msg} />}
      {d.missing.length > 0 && <Banner tone="warn" title="Tamamlanması gereken belgeler">{d.missing.map((m) => `${m.name} (${m.reasonLabel.toLocaleLowerCase('tr-TR')})`).join(', ')}.</Banner>}
      {!d.types.length ? <div className="rounded-md border border-border bg-surface"><Empty icon="file" title="Kurum belge türü tanımlamadı">Kurum sizden belge istediğinde burada görünür.</Empty></div> : (
        <ul className="grid gap-3">
          {d.types.map((t) => (
            <li key={t.code} className="panel">
              <div className="panel-head"><h2>{t.name}</h2><span className="text-sm text-ink-muted">{t.required ? 'Zorunlu' : 'İsteğe bağlı'}{t.expiryRequired ? ' · geçerlilik tarihi gerekir' : ''}</span>
                {!t.current.length && !(open?.code === t.code) && <Button size="sm" variant="outline" className="ml-auto" onClick={() => { setMsg(null); setOpen({ code: t.code, replaces: null }); }}><Icon name="upload" />Yükle</Button>}</div>
              <div className="panel-body grid gap-2">
                {!t.current.length && <p className="text-ink-muted">Yüklenmiş belge yok.</p>}
                {t.current.map((x) => (
                  <div key={x.id} className="flex flex-wrap items-center gap-x-4 gap-y-2">
                    <div className="min-w-0 flex-1"><span className="block truncate font-semibold">{x.originalFilename}</span>
                      <span className="text-sm text-ink-subtle">{x.validUntil ? `Geçerlilik ${fmtDate(x.validUntil)}` : 'Süresiz'} · yüklendi {fmtDate(x.createdAt)}{x.uploadedViaLabel ? ` · ${x.uploadedViaLabel}` : ''}</span></div>
                    <DocTags d={x} />
                    <div className="flex gap-2">
                      {!x.quarantined && <Button size="sm" variant="ghost" onClick={() => void downloadDoc(x.contentUrl, x.originalFilename)}>İndir</Button>}
                      <Button size="sm" variant="outline" onClick={() => { setMsg(null); setOpen({ code: t.code, replaces: x }); }}>Yenile</Button>
                    </div>
                  </div>
                ))}
                {open?.code === t.code && <UploadForm type={t} replaces={open.replaces} upload={d.upload} onCancel={() => setOpen(null)}
                  onDone={async (m) => { setOpen(null); setMsg(m); await r.reload(); }} />}
              </div>
            </li>
          ))}
        </ul>
      )}
      {old.length > 0 && (
        <section className="mt-5">
          <Button variant="ghost" aria-expanded={showOld} onClick={() => setShowOld((v) => !v)}><Icon name="chevron" className={cn('transition-transform', showOld && 'rotate-90')} />Önceki belgeler ({old.length})</Button>
          {showOld && <ul className="mt-2 grid gap-1.5">{old.map((x) => (
            <li key={x.id} className="flex flex-wrap items-center gap-3 border-b border-border py-1.5 text-sm"><span className="font-semibold">{x.typeName}</span><span className="truncate">{x.originalFilename}</span>
              <span className="text-ink-subtle">{fmtDate(x.createdAt)}</span><DocTags d={x} /></li>))}</ul>}
        </section>
      )}
    </div>
  );
}

// ---------- Skorum ve risk durumum ----------
interface Standing {
  year: number; score: number | null; scoreReason: string | null; levelLabel: string | null; levelSourceLabel: string | null;
  risk: { year: number; level: number; levelLabel: string; riskScore: number | string | null } | null;
  expectedActions: { kind: 'CORRECTIVE' | 'DOCUMENT' | 'SURVEY' | 'RISK'; title: string; dueDate: string | null }[];
}
const ACTION_KIND: Record<string, string> = { CORRECTIVE: 'Düzeltici faaliyet', DOCUMENT: 'Belge', SURVEY: 'Anket', RISK: 'Risk aksiyonu' };

export function PortalStanding() {
  const r = useResource<Standing>('/api/v1/portal/standing');
  if (r.loading && !r.data) return <div className="page"><PageHeader title="Skorum ve risk durumum" /><Loading /></div>;
  if (r.error || !r.data) return <div className="page"><PageHeader title="Skorum ve risk durumum" /><ErrorState error={r.error} onRetry={r.reload} /></div>;
  const s = r.data;
  return (
    <div className="page">
      <PageHeader title="Skorum ve risk durumum">Skor kurumun anket ve performans değerlendirmelerinden kurallarla hesaplanır. Kurum içi değerlendirme notları ve gerekçeler bu ekranda gösterilmez.</PageHeader>
      <div className="grid items-start gap-4 min-[900px]:grid-cols-2">
        <section className="panel" aria-labelledby="score-h">
          <div className="panel-head"><h2 id="score-h">Skorunuz ({s.year})</h2></div>
          <div className="panel-body">{s.score === null ? <p className="text-ink-muted">{s.scoreReason ?? 'Bu yıl için henüz skor hesaplanmadı.'}</p>
            : <p><span className="tabular text-[2rem] font-semibold leading-none">{fmtNum(s.score)}</span><span className="text-ink-muted"> / 100</span></p>}</div>
        </section>
        <section className="panel" aria-labelledby="risk-h">
          <div className="panel-head"><h2 id="risk-h">Risk durumunuz</h2></div>
          <div className="panel-body grid gap-2">
            {s.levelLabel ? <Tag label={{ text: s.levelLabel, tone: 'info', icon: 'shield' }} className="justify-self-start" /> : <p className="text-ink-muted">Henüz tamamlanmış risk değerlendirmesi yok.</p>}
            {s.levelSourceLabel && <p className="text-sm text-ink-muted">Kaynak: {s.levelSourceLabel}</p>}
            {s.risk?.riskScore != null && <p className="text-sm">Risk puanı: <span className="tabular font-semibold">{fmtNum(s.risk.riskScore)}</span></p>}
          </div>
        </section>
      </div>
      <section className="panel mt-4" aria-labelledby="act-h">
        <div className="panel-head"><h2 id="act-h">Sizden beklenenler</h2></div>
        {!s.expectedActions.length ? <div className="panel-body text-ink-muted">Bekleyen aksiyon yok.</div> : (
          <ul className="grid">{s.expectedActions.map((a, i) => (
            <li key={i} className="flex flex-wrap items-baseline gap-x-3 gap-y-1 border-b border-border px-4 py-2.5 last:border-0">
              <span className="text-sm text-ink-muted">{ACTION_KIND[a.kind] ?? 'Aksiyon'}</span><span className="min-w-0 flex-1 font-semibold">{a.title}</span>
              {a.dueDate && <span className="tabular text-sm text-ink-subtle">Hedef {fmtDate(a.dueDate)}</span>}
              {a.kind === 'DOCUMENT' && <Link to="/portal/belgeler" className="text-sm">Belgelerim</Link>}
              {a.kind === 'SURVEY' && <Link to="/portal/anketler" className="text-sm">Anketler</Link>}
            </li>))}</ul>
        )}
      </section>
    </div>
  );
}

// ---------- Firma bilgileri ----------
interface Profile {
  legalName: string; country: string; taxIdType: string; taxId: string | null; stageLabel: string; contactName: string | null; contactEmail: string | null;
  contactPhone: string | null; address: string | null; serviceCategories: string[]; rowVersion: number;
  changeRequestFields: { code: string; label: string }[]; pendingChangeRequests: { field: string; fieldLabel: string; requestedAt: string }[];
}

export function PortalProfile() {
  const r = useResource<Profile>('/api/v1/portal/profile');
  if (r.loading && !r.data) return <div className="page"><PageHeader title="Firma bilgileri" /><Loading /></div>;
  if (r.error || !r.data) return <div className="page"><PageHeader title="Firma bilgileri" /><ErrorState error={r.error} onRetry={r.reload} /></div>;
  return <ProfileView p={r.data} reload={r.reload} />;
}

function ProfileView({ p, reload }: { p: Profile; reload: () => Promise<void> }) {
  const [f, setF] = useState({ contactName: p.contactName ?? '', contactPhone: p.contactPhone ?? '', address: p.address ?? '' });
  const [msg, setMsg] = useState<{ tone: 'info' | 'danger' | 'warn'; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [req, setReq] = useState({ field: p.changeRequestFields[0]?.code ?? 'OTHER', note: '' });
  const [reqMsg, setReqMsg] = useState<{ tone: 'info' | 'danger' | 'warn'; text: string } | null>(null);
  async function save(e: React.FormEvent) {
    e.preventDefault();
    const name = f.contactName.trim();
    // İletişim kişisi zorunlu ve silinemez (sunucu da denetler).
    if (name.length < 2) { setMsg({ tone: 'danger', text: 'İletişim kişisinin adını girin (en az 2 karakter).' }); return; }
    setBusy(true); setMsg(null);
    try {
      const res = await api<{ changed: string[] }>('/api/v1/portal/profile', { method: 'PUT', ifMatch: `"${p.rowVersion}"`,
        json: { contactName: name, contactPhone: f.contactPhone.trim() || null, address: f.address.trim() || null } });
      setMsg({ tone: 'info', text: res.data.changed.length ? 'İletişim bilgileri kaydedildi.' : 'Değişiklik yok.' });
      await reload();
    } catch (x) {
      // If-Match (satır sürümü): başka oturum değiştirdiyse 409; yazılan korunur, kullanıcı yenileyip yeniden dener.
      const e = x as ApiError;
      setMsg(e.status === 409 ? { tone: 'warn', text: 'Bilgiler başka bir oturumda değişti; sayfayı yenileyip değişikliğinizi yeniden girin.' } : { tone: 'danger', text: e.message });
    } finally { setBusy(false); }
  }
  async function request(e: React.FormEvent) {
    e.preventDefault();
    if (req.note.trim().length < 10) { setReqMsg({ tone: 'danger', text: 'Değişikliği en az 10 karakterle açıklayın.' }); return; }
    try {
      const res = await api<{ message: string }>('/api/v1/portal/profile/change-request', { method: 'POST', json: { field: req.field, note: req.note.trim() } });
      setReqMsg({ tone: 'info', text: res.data.message }); setReq({ ...req, note: '' }); await reload();
    } catch (x) { setReqMsg({ tone: (x as ApiError).status === 429 ? 'warn' : 'danger', text: (x as ApiError).message }); }
  }
  return (
    <div className="page">
      <PageHeader title="Firma bilgileri">İletişim kişisi, telefon ve adresi siz güncellersiniz. Unvan ve vergi kimliği değişikliği Satınalma onayıyla yapılır.</PageHeader>
      <div className="grid items-start gap-4 min-[1000px]:grid-cols-2">
        <section className="panel" aria-labelledby="firm-h">
          <div className="panel-head"><h2 id="firm-h">Kayıtlı bilgiler</h2></div>
          <div className="panel-body"><dl className="facts">
            <dt>Unvan</dt><dd>{p.legalName}</dd>
            <dt>Vergi kimliği</dt><dd className="mono">{p.taxId ? `${p.taxIdType === 'FOREIGN' ? 'Yabancı' : p.taxIdType} ${p.taxId}` : '—'}</dd>
            <dt>Ülke</dt><dd>{p.country}</dd>
            <dt>Durum</dt><dd>{p.stageLabel}</dd>
            <dt>E-posta</dt><dd>{p.contactEmail ?? '—'}</dd>
            <dt>Hizmet kategorileri</dt><dd>{p.serviceCategories.length ? p.serviceCategories.join(', ') : '—'}</dd>
          </dl></div>
        </section>
        <section className="panel" aria-labelledby="contact-h">
          <div className="panel-head"><h2 id="contact-h">İletişim bilgileri</h2></div>
          <form className="panel-body" onSubmit={(e) => void save(e)}>
            <Field label="İletişim kişisi">{(x) => <input className="input" maxLength={200} {...x} value={f.contactName} onChange={(e) => setF({ ...f, contactName: e.target.value })} />}</Field>
            <Field label="Telefon">{(x) => <input className="input" type="tel" maxLength={40} {...x} value={f.contactPhone} onChange={(e) => setF({ ...f, contactPhone: e.target.value })} />}</Field>
            <Field label="Adres">{(x) => <textarea className="input" rows={2} maxLength={1000} {...x} value={f.address} onChange={(e) => setF({ ...f, address: e.target.value })} />}</Field>
            <div aria-live="polite">{msg && <Banner tone={msg.tone} icon={msg.tone === 'info' ? 'check' : undefined} title={msg.text}
              action={msg.tone === 'warn' ? <Button size="sm" variant="outline" type="button" onClick={() => location.reload()}>Sayfayı yenile</Button> : undefined} />}</div>
            <Button type="submit" disabled={busy}>{busy ? 'Kaydediliyor…' : 'Kaydet'}</Button>
          </form>
        </section>
      </div>
      <section className="panel mt-4" aria-labelledby="chg-h">
        <div className="panel-head"><h2 id="chg-h">Unvan veya vergi kimliği değişikliği iste</h2></div>
        <form className="panel-body grid gap-1" onSubmit={(e) => void request(e)}>
          <div className="grid gap-x-4 min-[700px]:grid-cols-[220px_minmax(0,1fr)]">
            <Field label="Değişecek bilgi">{(x) => <select className="input" {...x} value={req.field} onChange={(e) => setReq({ ...req, field: e.target.value })}>
              {p.changeRequestFields.map((c) => <option key={c.code} value={c.code}>{c.label}</option>)}</select>}</Field>
            <Field label="Açıklama" hint="Yeni bilgiyi ve dayanağını yazın (ör. ticaret sicil gazetesi tarihi). En az 10 karakter.">{(x) => <textarea className="input" rows={2} maxLength={1000} {...x} value={req.note} onChange={(e) => setReq({ ...req, note: e.target.value })} />}</Field>
          </div>
          <div aria-live="polite">{reqMsg && <Banner tone={reqMsg.tone} icon={reqMsg.tone === 'info' ? 'check' : undefined} title={reqMsg.text} />}</div>
          <Button type="submit" variant="outline" className="justify-self-start">Değişiklik iste</Button>
          {p.pendingChangeRequests.length > 0 && <div className="mt-3 border-t border-border pt-3"><h3 className="mb-1 text-base">Bekleyen istekler</h3>
            <ul className="grid gap-1">{p.pendingChangeRequests.map((c, i) => <li key={i} className="text-sm">{c.fieldLabel} · {fmtDateTime(c.requestedAt)}</li>)}</ul></div>}
        </form>
      </section>
    </div>
  );
}
