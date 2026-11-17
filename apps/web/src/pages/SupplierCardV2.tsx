// v2 Faz 5 (D110, Figma 14): tedarikçi kartının yeni bölümleri. Eski kart bölümleri (kimlik, onaylar, aktivasyon, kimlik çözme, bağlı
// belgeler, banka bandı) SupplierDetailPage'de aynen kalır; bu dosya yalnız eklenenleri çizer. Tedarikçi belgeleri `supplierDocuments`
// alanındadır (`documents` eski bağlı belge listesidir).
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { api, ApiError } from '../lib/api.ts';
import { useResource } from '../lib/useApi.ts';
import { fmtDate, fmtDateTime } from '../lib/format.ts';
import { hasPermission, useSession } from '../lib/session.tsx';
import { Banner, Empty, ErrorState, Field, Loading, Modal, Tag } from '../ui/kit.tsx';
import { Icon } from '../ui/icons.tsx';
import { Button } from '@/components/ui/button';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { ACCEPT, DocTags, downloadDoc, fmtNum, fmtSize, UPLOADED_VIA, type SupplierDoc } from '../lib/supplierV2.tsx';
import { cn } from '@/lib/utils';

export interface CardV2 {
  id: string; rowVersion: number; status: string; legalName: string;
  stage?: string; stageLabel?: string; eligibleForInvite?: boolean;
  profile?: { contactName: string | null; contactEmail: string | null; contactPhone: string | null; address: string | null; serviceCategories: string[];
    servicesOffered: string | null; serviceScope: string | null; responsibleDepartment: { id: string; name: string } | null; supplierManager: { id: string; name: string } | null;
    vpnAccess: 'YES' | 'NO' | 'UNKNOWN'; vpnAccessLabel: string; slaSummary: string | null; supportChannel: string | null; applicationId: string | null };
  deactivation?: { at: string; byName: string | null; reason: string } | null;
  reactivation?: { at: string; byName: string | null; reason: string } | null;
  supplierDocuments?: SupplierDoc[];
  requiredMissing?: { code: string; name: string; reason: string; reasonLabel: string }[];
  contracts?: { id: string; code: string | null; title: string; status: string | null; statusLabel: string | null; endDate: string | null; indefinite: boolean }[];
  projects?: { projectId: string; projectCode: string; projectTitle: string; roundId: string; roundNo: number; roundStatusLabel: string; closesAt: string; invitedAt: string; bidStatusLabel: string }[];
  surveys?: { year: number; score: number | null; scoreReason: string | null; pendingResponses: number;
    items: { id: string; scope: string; template: string; status: string; portalStatus: string | null; outcome: string | null; complianceRate: number | null; reviewedAt: string | null; departmentName: string | null }[] };
  risk?: { year: number; level: number; levelLabel: string; riskScore: number | string | null; criticality: string | null } | null;
  portalUsers?: { userId: string; name: string; email: string; status: string; statusLabel: string; firstLogin: string; firstLoginLabel: string; since: string }[];
  portalAccessNote?: string;
  offboarding?: { id: string; reason: string; startedAt: string; startedByName: string; completedAt: string | null; completed: boolean; status: string; statusLabel: string;
    items: { id: string; code: string; label: string; doneAt: string | null; doneByName: string | null; notApplicable: boolean; note: string | null; state: string; stateLabel: string }[] } | null;
  activationHints?: { code: string; message: string }[];
  can?: { editProfile: boolean; offboard: boolean; reactivate: boolean; manageUsers: boolean; manageDocuments: boolean };
}

type Run = (fn: () => Promise<unknown>, ok: string) => Promise<void>;

/** Pasif kartın üst bandı: kim, ne zaman, neden; yeniden açıldıysa o da. */
export function LifecycleBanner({ s }: { s: CardV2 }) {
  return <>
    {s.deactivation && (s.status === 'SUSPENDED' || s.status === 'ARCHIVED') && (
      <Banner tone="neutral" icon="archive" title={`Pasife alındı · ${fmtDateTime(s.deactivation.at)}`}>
        {s.deactivation.byName ?? 'Bilinmeyen kullanıcı'}: {s.deactivation.reason}. Yeni teklif turuna davet edilemez; portal erişimi askıda. Veri silinmedi.</Banner>
    )}
    {s.reactivation && s.status !== 'SUSPENDED' && s.status !== 'ARCHIVED' && (
      <Banner tone="info" icon="refresh" title={`Yeniden açıldı · ${fmtDateTime(s.reactivation.at)}`}>{s.reactivation.byName ?? 'Bilinmeyen kullanıcı'}: {s.reactivation.reason}</Banner>
    )}
  </>;
}

/** R10: "Onaylı yapmadan önce" bilgi kutusu; engellemez. */
export function ActivationHints({ s }: { s: CardV2 }) {
  if (s.status !== 'CANDIDATE') return null;
  const hints = s.activationHints ?? [];
  return (
    <section className="mb-4 rounded-md border border-[#cfd5e2] bg-info-soft px-4 py-3" aria-labelledby="before-h">
      <h2 id="before-h" className="flex items-center gap-2 text-base"><Icon name="info" size={18} className="text-info" />Onaylı yapmadan önce</h2>
      {hints.length ? <ul className="mt-1 list-disc pl-6 text-ink-muted">{hints.map((h, i) => <li key={i}>{h.message}</li>)}</ul>
        : <p className="mt-1 text-ink-muted">Yanıtlanmamış anket ve eksik zorunlu belge yok.</p>}
      <p className="mt-1 text-sm text-ink-subtle">Bu kutu bilgi verir; aktivasyonu engellemez. Aktivasyon için bağımsız kayıt onayı ve doğrulanmış kimlik gerekir.</p>
    </section>
  );
}

/** Kimlik ve iletişim + envanter (R14). */
export function ProfilePanel({ s, run }: { s: CardV2; run: Run }) {
  const [edit, setEdit] = useState(false);
  const p = s.profile;
  if (!p) return null;
  return (
    <section className="panel" aria-labelledby="inv-h">
      <div className="panel-head"><h2 id="inv-h">İletişim ve envanter</h2>
        {s.can?.editProfile && <Button size="sm" variant="outline" className="ml-auto" onClick={() => setEdit(true)}><Icon name="pen" />Düzenle</Button>}</div>
      <div className="panel-body"><dl className="facts">
        <dt>İletişim kişisi</dt><dd>{p.contactName ?? '—'}</dd>
        <dt>E-posta</dt><dd className="mono">{p.contactEmail ?? '—'}</dd>
        <dt>Telefon</dt><dd>{p.contactPhone ?? '—'}</dd>
        <dt>Adres</dt><dd>{p.address ?? '—'}</dd>
        <dt>Hizmet kategorileri</dt><dd>{p.serviceCategories.length ? p.serviceCategories.join(', ') : '—'}</dd>
        <dt>Sunulan hizmetler</dt><dd>{p.servicesOffered ?? '—'}</dd>
        <dt>Hizmet kapsamı</dt><dd>{p.serviceScope ?? '—'}</dd>
        <dt>Sorumlu ekip</dt><dd>{p.responsibleDepartment?.name ?? '—'}</dd>
        <dt>Tedarikçi yöneticisi</dt><dd>{p.supplierManager?.name ?? '—'}</dd>
        <dt>VPN erişimi</dt><dd>{p.vpnAccessLabel}</dd>
        <dt>SLA özeti</dt><dd>{p.slaSummary ?? '—'}</dd>
        <dt>Çağrı kanalı</dt><dd>{p.supportChannel ?? '—'}</dd>
        {p.applicationId && <><dt>Başvuru</dt><dd><Link to={`/tedarikciler/basvurular/${p.applicationId}`}>Başvuruyu aç</Link></dd></>}
      </dl></div>
      {edit && <ProfileDialog s={s} onClose={() => setEdit(false)} onSubmit={(body) => run(() => api(`/api/v1/suppliers/${s.id}/profile`, { method: 'PUT', json: { ...body, expectedRowVersion: s.rowVersion } }), 'İletişim ve envanter bilgileri kaydedildi.').then(() => setEdit(false))} />}
    </section>
  );
}

function ProfileDialog({ s, onClose, onSubmit }: { s: CardV2; onClose: () => void; onSubmit: (b: Record<string, unknown>) => Promise<void> }) {
  const p = s.profile!;
  const deps = useResource<{ items: { id: string; name: string }[] }>('/api/v1/departments');
  const members = useResource<{ id: string; displayName: string }[]>('/api/v1/members');
  const [f, setF] = useState({ contactName: p.contactName ?? '', contactEmail: p.contactEmail ?? '', contactPhone: p.contactPhone ?? '', address: p.address ?? '',
    serviceCategories: p.serviceCategories.join(', '), servicesOffered: p.servicesOffered ?? '', serviceScope: p.serviceScope ?? '',
    responsibleDepartmentId: p.responsibleDepartment?.id ?? '', supplierManagerUserId: p.supplierManager?.id ?? '', vpnAccess: p.vpnAccess,
    slaSummary: p.slaSummary ?? '', supportChannel: p.supportChannel ?? '' });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>) => setF({ ...f, [k]: e.target.value });
  const nul = (v: string) => v.trim() || null;
  const submit = () => {
    setBusy(true);
    void onSubmit({ contactName: nul(f.contactName), contactEmail: nul(f.contactEmail), contactPhone: nul(f.contactPhone), address: nul(f.address),
      serviceCategories: f.serviceCategories.split(',').map((x) => x.trim()).filter(Boolean), servicesOffered: nul(f.servicesOffered), serviceScope: nul(f.serviceScope),
      responsibleDepartmentId: f.responsibleDepartmentId || null, supplierManagerUserId: f.supplierManagerUserId || null, vpnAccess: f.vpnAccess,
      slaSummary: nul(f.slaSummary), supportChannel: nul(f.supportChannel) }).catch((e: unknown) => setErr(e instanceof ApiError ? e.message : 'Kaydedilemedi.')).finally(() => setBusy(false));
  };
  return (
    <Modal title="İletişim ve envanteri düzenle" onClose={onClose} footer={<><Button variant="outline" onClick={onClose}>Vazgeç</Button><Button disabled={busy} onClick={submit}>{busy ? 'Kaydediliyor…' : 'Kaydet'}</Button></>}>
      <p className="mb-3 text-sm text-ink-muted">Değişiklikler önce/sonra değerleriyle denetim izine yazılır.</p>
      {err && <Banner tone="danger" title={err} />}
      <Field label="İletişim kişisi">{(x) => <input className="input" maxLength={200} {...x} value={f.contactName} onChange={set('contactName')} />}</Field>
      <Field label="İletişim e-postası">{(x) => <input className="input" type="email" maxLength={254} {...x} value={f.contactEmail} onChange={set('contactEmail')} />}</Field>
      <Field label="Telefon">{(x) => <input className="input" maxLength={40} {...x} value={f.contactPhone} onChange={set('contactPhone')} />}</Field>
      <Field label="Adres">{(x) => <textarea className="input" rows={2} maxLength={1000} {...x} value={f.address} onChange={set('address')} />}</Field>
      <Field label="Hizmet kategorileri" hint="Virgülle ayırın.">{(x) => <input className="input" {...x} value={f.serviceCategories} onChange={set('serviceCategories')} />}</Field>
      <Field label="Sunulan hizmetler">{(x) => <textarea className="input" rows={2} maxLength={4000} {...x} value={f.servicesOffered} onChange={set('servicesOffered')} />}</Field>
      <Field label="Hizmet kapsamı">{(x) => <textarea className="input" rows={2} maxLength={4000} {...x} value={f.serviceScope} onChange={set('serviceScope')} />}</Field>
      <Field label="Sorumlu ekip (departman)">{(x) => <select className="input" {...x} value={f.responsibleDepartmentId} onChange={set('responsibleDepartmentId')}>
        <option value="">Seçilmedi</option>{deps.data?.items.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}</select>}</Field>
      <Field label="Tedarikçi yöneticisi">{(x) => <select className="input" {...x} value={f.supplierManagerUserId} onChange={set('supplierManagerUserId')}>
        <option value="">Seçilmedi</option>{members.data?.map((m) => <option key={m.id} value={m.id}>{m.displayName}</option>)}</select>}</Field>
      <Field label="VPN erişimi">{(x) => <select className="input" {...x} value={f.vpnAccess} onChange={set('vpnAccess')}><option value="UNKNOWN">Bilinmiyor</option><option value="YES">Var</option><option value="NO">Yok</option></select>}</Field>
      <Field label="SLA özeti">{(x) => <textarea className="input" rows={2} maxLength={2000} {...x} value={f.slaSummary} onChange={set('slaSummary')} />}</Field>
      <Field label="Çağrı kanalı">{(x) => <input className="input" maxLength={500} {...x} value={f.supportChannel} onChange={set('supportChannel')} />}</Field>
    </Modal>
  );
}

/** Anket skorları ve risk özeti (Figma 14 "Skor ve risk"); ayrıntı Değerlendirme ve risk sekmesinde. */
export function ScoreRiskPanel({ s, onOpen }: { s: CardV2; onOpen: () => void }) {
  if (!s.surveys) return null;
  const sv = s.surveys;
  return (
    <section className="panel" aria-labelledby="score-h">
      <div className="panel-head"><h2 id="score-h">Skor ve risk</h2><Button size="sm" variant="ghost" className="ml-auto" onClick={onOpen}>Değerlendirmeler</Button></div>
      <div className="panel-body grid gap-3">
        <div className="flex flex-wrap gap-x-10 gap-y-3">
          <div><span className="block text-sm text-ink-muted">Tedarikçi skoru ({sv.year})</span>
            {sv.score === null ? <span className="text-ink-muted">{sv.scoreReason ?? 'Henüz hesaplanmadı'}</span> : <span><span className="tabular text-2xl font-semibold">{fmtNum(sv.score)}</span><span className="text-ink-muted"> / 100</span></span>}</div>
          <div><span className="block text-sm text-ink-muted">Risk seviyesi</span>
            {s.risk ? <span><span className="tabular text-2xl font-semibold">{s.risk.level}</span><span className="text-ink-muted"> / 5 · {s.risk.levelLabel}</span></span> : <span className="text-ink-muted">Değerlendirilmedi</span>}</div>
        </div>
        {s.risk && <p className="text-sm text-ink-muted">{s.risk.year} risk değerlendirmesi{s.risk.riskScore != null ? ` · risk puanı ${fmtNum(s.risk.riskScore)}` : ''}{s.risk.criticality ? ` · kritiklik ${s.risk.criticality}` : ''}</p>}
        {sv.pendingResponses > 0 && <p className="text-sm text-warn">Tedarikçinin yanıtlamadığı gönderilmiş anket: {sv.pendingResponses}</p>}
        {sv.items.length > 0 && <ul className="grid gap-1 text-sm">{sv.items.slice(0, 5).map((a) => (
          <li key={a.id} className="flex flex-wrap gap-x-2"><Link to={`/degerlendirmeler/${a.id}`}>{a.scope}</Link><span className="text-ink-subtle">{a.template}{a.complianceRate != null ? ` · uyum %${a.complianceRate}` : ''}{a.reviewedAt ? ` · ${fmtDate(a.reviewedAt)}` : ''}</span></li>))}</ul>}
      </div>
    </section>
  );
}

// ---------- Belgeler ve geçerlilik ----------
export function DocumentsTab({ s, run }: { s: CardV2; run: Run }) {
  const [upload, setUpload] = useState<{ replaces: SupplierDoc | null } | null>(null);
  const [showOld, setShowOld] = useState(false);
  const docs = s.supplierDocuments ?? [];
  const current = docs.filter((d) => d.current);
  const old = docs.filter((d) => !d.current);
  const rows = (list: SupplierDoc[]) => list.map((d) => (
    <TableRow key={d.id} className={cn(!d.current && 'text-ink-muted')}>
      <TableCell className="font-semibold">{d.typeName}</TableCell>
      <TableCell className="min-w-[160px]"><span className="mono block break-all text-sm">{d.originalFilename}</span><span className="text-xs text-ink-subtle">{fmtSize(d.sizeBytes)}</span></TableCell>
      <TableCell className="tabular whitespace-nowrap">{d.validUntil ? fmtDate(d.validUntil) : 'Süresiz'}</TableCell>
      <TableCell><DocTags d={d} /></TableCell>
      <TableCell className="text-sm max-[900px]:hidden">{UPLOADED_VIA[d.uploadedVia] ?? 'Diğer'}{d.uploadedByName ? ` · ${d.uploadedByName}` : ''}<span className="block text-ink-subtle">{fmtDate(d.createdAt)}</span></TableCell>
      <TableCell><div className="flex gap-1">
        {!d.quarantined && <Button size="sm" variant="ghost" aria-label={`${d.typeName} indir`} onClick={() => void downloadDoc(d.contentUrl, d.originalFilename)}>İndir</Button>}
        {d.current && s.can?.manageDocuments && <Button size="sm" variant="outline" aria-label={`${d.typeName} yenile`} onClick={() => setUpload({ replaces: d })}>Yenile</Button>}
      </div></TableCell>
    </TableRow>));
  return (
    <div className="grid gap-4">
      {(s.requiredMissing?.length ?? 0) > 0 && <Banner tone="warn" title="Eksik ya da süresi dolmuş zorunlu belge">{s.requiredMissing!.map((m) => `${m.name} (${m.reasonLabel.toLocaleLowerCase('tr-TR')})`).join(', ')}.</Banner>}
      <div className="flex flex-wrap items-center gap-3">
        <p className="min-w-0 flex-1 text-sm text-ink-muted">Başvurudan gelen, portaldan yenilenen ve kurum içinden yüklenen belgeler. Yenileme eskiyi silmez. Bitişten 30 ve 7 gün önce ve bitiş günü tedarikçiye hatırlatma yazılır.</p>
        {s.can?.manageDocuments && <Button variant="outline" onClick={() => setUpload({ replaces: null })}><Icon name="upload" />Belge yükle</Button>}
      </div>
      {!current.length ? <div className="rounded-md border border-border bg-surface"><Empty icon="file" title="Tedarikçi belgesi yok">Başvurudan, portaldan ya da buradan yüklenen belgeler burada görünür.</Empty></div> : (
        <Table>
          <TableHeader><TableRow className="hover:bg-transparent"><TableHead>Belge</TableHead><TableHead>Dosya</TableHead><TableHead>Geçerlilik</TableHead><TableHead>Durum</TableHead>
            <TableHead className="max-[900px]:hidden">Yükleyen</TableHead><TableHead><span className="sr-only">Eylem</span></TableHead></TableRow></TableHeader>
          <TableBody>{rows(current)}{showOld && rows(old)}</TableBody>
        </Table>
      )}
      {old.length > 0 && <Button variant="ghost" className="justify-self-start" aria-expanded={showOld} onClick={() => setShowOld((v) => !v)}>
        <Icon name="chevron" className={cn('transition-transform', showOld && 'rotate-90')} />Yerine yenisi yüklenen belgeler ({old.length})</Button>}
      {upload && <UploadDialog s={s} replaces={upload.replaces} onClose={() => setUpload(null)} run={run} />}
    </div>
  );
}

function UploadDialog({ s, replaces, onClose, run }: { s: CardV2; replaces: SupplierDoc | null; onClose: () => void; run: Run }) {
  const types = useResource<{ items: { code: string; name: string; expiryRequired: boolean; active: boolean }[] }>('/api/v1/settings/supplier-document-types');
  const [typeCode, setType] = useState(replaces?.typeCode ?? '');
  const [file, setFile] = useState<File | null>(null);
  const [until, setUntil] = useState('');
  const [title, setTitle] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const t = types.data?.items.find((x) => x.code === typeCode);
  const submit = () => {
    if (!typeCode) { setErr('Belge türünü seçin.'); return; }
    if (!file) { setErr('Dosya seçin.'); return; }
    if (t?.expiryRequired && !until) { setErr('Bu belge türünde geçerlilik tarihi zorunlu.'); return; }
    const fd = new FormData();
    fd.set('typeCode', typeCode); if (until) fd.set('validUntil', until); if (title.trim()) fd.set('title', title.trim()); if (replaces) fd.set('replacesId', replaces.id);
    fd.set('file', file, file.name);
    setBusy(true); setErr(null);
    void run(() => api(`/api/v1/suppliers/${s.id}/documents`, { method: 'POST', body: fd }), replaces ? 'Belge yenilendi; önceki belge saklanır.' : 'Belge yüklendi.')
      .then(onClose, (e: unknown) => setErr(e instanceof ApiError ? e.message : 'Belge yüklenemedi.')).finally(() => setBusy(false));
  };
  return (
    <Modal title={replaces ? `${replaces.typeName} yenile` : 'Belge yükle'} onClose={onClose} footer={<><Button variant="outline" onClick={onClose}>Vazgeç</Button><Button disabled={busy} onClick={submit}>{busy ? 'Yükleniyor…' : 'Yükle'}</Button></>}>
      {types.loading && !types.data ? <Loading rows={2} /> : types.error ? <ErrorState error={types.error} /> : <>
        <Field label="Belge türü">{(x) => <select className="input" {...x} value={typeCode} disabled={!!replaces} onChange={(e) => setType(e.target.value)}>
          <option value="">Seçin</option>{types.data!.items.filter((y) => y.active || y.code === typeCode).map((y) => <option key={y.code} value={y.code}>{y.name}</option>)}</select>}</Field>
        <Field label="Dosya" hint="PDF, JPEG veya PNG · en çok 10 MB.">{(x) => <input type="file" accept={ACCEPT} className="input py-1.5" {...x} onChange={(e) => setFile(e.target.files?.[0] ?? null)} />}</Field>
        <Field label={t?.expiryRequired ? 'Geçerlilik tarihi' : 'Geçerlilik tarihi (varsa)'}>{(x) => <input type="date" className="input tabular" {...x} value={until} onChange={(e) => setUntil(e.target.value)} />}</Field>
        <Field label="Başlık" hint="İsteğe bağlı.">{(x) => <input className="input" maxLength={200} {...x} value={title} onChange={(e) => setTitle(e.target.value)} />}</Field>
        {err && <p role="alert" className="text-sm text-danger">{err}</p>}
      </>}
    </Modal>
  );
}

// ---------- Sözleşmeler ve projeler ----------
export function ContractsProjectsTab({ s }: { s: CardV2 }) {
  return (
    <div className="grid gap-5">
      <section aria-labelledby="ctr-h"><h2 id="ctr-h" className="mb-2 text-base">Sözleşmeler</h2>
        {!s.contracts?.length ? <p className="rounded-md border border-border bg-surface px-4 py-3 text-ink-muted">Bu tedarikçiye bağlı sözleşme yok.</p> : (
          <Table>
            <TableHeader><TableRow className="hover:bg-transparent"><TableHead>Sözleşme</TableHead><TableHead>Konu</TableHead><TableHead>Durum</TableHead><TableHead>Bitiş</TableHead></TableRow></TableHeader>
            <TableBody>{s.contracts.map((c) => (
              <TableRow key={c.id}><TableCell className="mono whitespace-nowrap"><Link to={`/sozlesmeler/aile/${c.id}`}>{c.code ?? 'Kodsuz'}</Link></TableCell><TableCell className="min-w-[180px]">{c.title}</TableCell>
                <TableCell>{c.statusLabel ?? '—'}</TableCell><TableCell className="tabular whitespace-nowrap">{c.indefinite ? 'Süresiz' : fmtDate(c.endDate)}</TableCell></TableRow>))}</TableBody>
          </Table>
        )}
      </section>
      <section aria-labelledby="prj-h"><h2 id="prj-h" className="mb-2 text-base">Projeler ve teklif geçmişi</h2>
        {!s.projects?.length ? <p className="rounded-md border border-border bg-surface px-4 py-3 text-ink-muted">Bu tedarikçi henüz bir teklif turuna davet edilmedi.</p> : (
          <Table>
            <TableHeader><TableRow className="hover:bg-transparent"><TableHead>Proje</TableHead><TableHead>Tur</TableHead><TableHead>Kapanış</TableHead><TableHead>Teklif</TableHead></TableRow></TableHeader>
            <TableBody>{s.projects.map((p) => (
              <TableRow key={p.roundId}><TableCell className="min-w-[200px]"><Link to={`/projeler/${p.projectId}`} className="font-semibold">{p.projectTitle}</Link><span className="block text-sm text-ink-subtle">{p.projectCode}</span></TableCell>
                <TableCell className="whitespace-nowrap">Tur {p.roundNo} · {p.roundStatusLabel}</TableCell><TableCell className="tabular whitespace-nowrap">{fmtDateTime(p.closesAt)}</TableCell><TableCell>{p.bidStatusLabel}</TableCell></TableRow>))}</TableBody>
          </Table>
        )}
      </section>
    </div>
  );
}

// ---------- Portal kullanıcıları (R11) ----------
export function PortalUsersTab({ s, run }: { s: CardV2; run: Run }) {
  const [f, setF] = useState({ name: '', email: '' });
  const [err, setErr] = useState<string | null>(null);
  const users = s.portalUsers ?? [];
  const add = (e: React.FormEvent) => {
    e.preventDefault();
    if (f.name.trim().length < 2) { setErr('Kullanıcının adını girin.'); return; }
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(f.email.trim())) { setErr('Geçerli bir e-posta adresi girin.'); return; }
    setErr(null);
    void run(() => api(`/api/v1/suppliers/${s.id}/portal-users`, { method: 'POST', json: { name: f.name.trim(), email: f.email.trim() } }), 'Portal kullanıcısı davet edildi.').then(() => setF({ name: '', email: '' }), (x: unknown) => setErr(x instanceof ApiError ? x.message : 'Kullanıcı eklenemedi.'));
  };
  return (
    <div className="grid gap-4">
      {s.portalAccessNote && <Banner tone="info" title="Portal girişi hakkında">{s.portalAccessNote}</Banner>}
      {!users.length ? <div className="rounded-md border border-border bg-surface"><Empty icon="users" title="Portal kullanıcısı yok">Kullanıcısı olmayan tedarikçiye teklif daveti e-postası yazılmaz; Satınalma'ya görev açılır.</Empty></div> : (
        <Table>
          <TableHeader><TableRow className="hover:bg-transparent"><TableHead>Ad</TableHead><TableHead>E-posta</TableHead><TableHead>Durum</TableHead><TableHead className="max-[900px]:hidden">İlk giriş</TableHead><TableHead><span className="sr-only">Eylem</span></TableHead></TableRow></TableHeader>
          <TableBody>{users.map((u) => (
            <TableRow key={u.userId}>
              <TableCell className="font-semibold">{u.name}</TableCell><TableCell className="mono break-all text-sm">{u.email}</TableCell>
              <TableCell><Tag label={{ text: u.statusLabel, tone: u.status === 'ACTIVE' ? 'ok' : 'neutral', icon: u.status === 'ACTIVE' ? 'check' : 'lock' }} /></TableCell>
              <TableCell className="text-sm max-[900px]:hidden">{u.firstLoginLabel}<span className="block text-ink-subtle">{fmtDate(u.since)}</span></TableCell>
              <TableCell>{s.can?.manageUsers && (u.status === 'ACTIVE'
                ? <Button size="sm" variant="outline" aria-label={`${u.name} askıya al`} onClick={() => void run(() => api(`/api/v1/suppliers/${s.id}/portal-users/${u.userId}/suspend`, { method: 'POST' }), 'Portal kullanıcısı askıya alındı.')}>Askıya al</Button>
                : u.status === 'SUSPENDED' ? <Button size="sm" variant="outline" aria-label={`${u.name} yeniden aç`} onClick={() => void run(() => api(`/api/v1/suppliers/${s.id}/portal-users/${u.userId}/reactivate`, { method: 'POST' }), 'Portal kullanıcısı yeniden açıldı.')}>Yeniden aç</Button> : null)}</TableCell>
            </TableRow>))}</TableBody>
        </Table>
      )}
      {s.can?.manageUsers && (
        <form className="panel" onSubmit={add} aria-labelledby="add-u-h">
          <div className="panel-head"><h2 id="add-u-h">Portal kullanıcısı ekle</h2></div>
          <div className="panel-body grid gap-x-4 min-[700px]:grid-cols-2">
            <Field label="Ad soyad">{(x) => <input className="input" maxLength={200} {...x} value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} />}</Field>
            <Field label="E-posta" hint={s.profile?.contactEmail ? `Kartta kayıtlı iletişim e-postası: ${s.profile.contactEmail}. Adresin firmaya ait olduğunu doğrulamadan eklemeyin.` : 'Adresin firmaya ait olduğunu doğrulayın.'}>
              {(x) => <input className="input" type="email" maxLength={254} {...x} value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} />}</Field>
            {err && <p role="alert" className="text-sm text-danger min-[700px]:col-span-2">{err}</p>}
            <Button type="submit" className="justify-self-start">Davet et</Button>
          </div>
        </form>
      )}
    </div>
  );
}

// ---------- Ayrılış kontrol listesi (R13) ----------
export function OffboardingTab({ s, run }: { s: CardV2; run: Run }) {
  const { me } = useSession();
  const ob = s.offboarding;
  const canDecide = hasPermission(me, 'supplier.offboard');
  if (!ob) return <div className="rounded-md border border-border bg-surface"><Empty icon="archive" title="Ayrılış kontrol listesi yok">Tedarikçi pasife alındığında liste açılır.</Empty></div>;
  return (
    <div className="grid gap-4">
      <div className="flex flex-wrap items-center gap-3">
        <Tag label={{ text: ob.statusLabel, tone: ob.status === 'COMPLETED' ? 'ok' : ob.status === 'OPEN' ? 'warn' : 'info', icon: ob.status === 'COMPLETED' ? 'check' : 'clock' }} />
        <span className="text-sm text-ink-muted">Başlatan {ob.startedByName} · {fmtDateTime(ob.startedAt)}{ob.completedAt ? ` · tamamlandı ${fmtDateTime(ob.completedAt)}` : ''}</span>
      </div>
      <p className="text-ink-muted">Gerekçe: {ob.reason}</p>
      <ul className="grid gap-2">{ob.items.map((i) => <OffboardingItem key={i.id} i={i} canDecide={canDecide} run={run} />)}</ul>
    </div>
  );
}

function OffboardingItem({ i, canDecide, run }: { i: NonNullable<CardV2['offboarding']>['items'][number]; canDecide: boolean; run: Run }) {
  const [mode, setMode] = useState<null | 'done' | 'na'>(null);
  const [note, setNote] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const submit = () => {
    if (mode === 'na' && note.trim().length < 3) { setErr('Neden uygulanmadığını yazın.'); return; }
    void run(() => api(`/api/v1/supplier-offboarding-items/${i.id}`, { method: 'PUT', json: mode === 'done' ? { done: true, note: note.trim() || null } : { notApplicable: true, note: note.trim() } }),
      `${i.label}: ${mode === 'done' ? 'yapıldı' : 'uygulanmaz'} olarak kaydedildi.`).then(() => setMode(null), (x: unknown) => setErr(x instanceof ApiError ? x.message : 'Kaydedilemedi.'));
  };
  return (
    <li className="rounded-md border border-border bg-surface px-4 py-3">
      <div className="flex flex-wrap items-center gap-3">
        <span className="min-w-0 flex-1 font-semibold">{i.label}</span>
        <Tag label={{ text: i.stateLabel, tone: i.state === 'DONE' ? 'ok' : i.state === 'NOT_APPLICABLE' ? 'neutral' : 'warn', icon: i.state === 'OPEN' ? 'clock' : i.state === 'DONE' ? 'check' : 'minus' }} />
        {i.state === 'OPEN' && canDecide && !mode && <>
          <Button size="sm" variant="outline" onClick={() => setMode('done')}>Yapıldı</Button>
          <Button size="sm" variant="ghost" onClick={() => setMode('na')}>Uygulanmaz</Button></>}
      </div>
      {i.state !== 'OPEN' && <p className="mt-1 text-sm text-ink-muted">{[i.doneByName, i.doneAt ? fmtDateTime(i.doneAt) : null, i.note].filter(Boolean).join(' · ')}</p>}
      {mode && (
        <div className="mt-2 grid gap-2">
          <Field label={mode === 'done' ? 'Not (isteğe bağlı)' : 'Gerekçe'} error={err}>{(x) => <textarea className="input" rows={2} maxLength={2000} {...x} value={note} onChange={(e) => setNote(e.target.value)} />}</Field>
          <div className="flex gap-2"><Button size="sm" onClick={submit}>Kaydet</Button><Button size="sm" variant="ghost" onClick={() => { setMode(null); setErr(null); }}>Vazgeç</Button></div>
        </div>
      )}
    </li>
  );
}

/** Pasife al / Yeniden aç diyaloğu: gerekçe ≥ 10 karakter. */
export function ReasonDialog({ kind, s, onClose, onSubmit }: { kind: 'deactivate' | 'reactivate'; s: CardV2; onClose: () => void; onSubmit: (reason: string) => Promise<void> }) {
  const [reason, setReason] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const deactivate = kind === 'deactivate';
  return (
    <Modal title={deactivate ? 'Tedarikçiyi pasife al' : 'Tedarikçiyi yeniden aç'} onClose={onClose} footer={<><Button variant="outline" onClick={onClose}>Vazgeç</Button>
      <Button variant={deactivate ? 'destructive' : 'default'} disabled={busy} onClick={() => { if (reason.trim().length < 10) { setErr('Gerekçe en az 10 karakter olmalı.'); return; } setBusy(true); void onSubmit(reason.trim()).finally(() => setBusy(false)); }}>
        {busy ? 'Kaydediliyor…' : deactivate ? 'Pasife al' : 'Yeniden aç'}</Button></>}>
      {deactivate ? <p className="mb-3 text-sm text-ink-muted"><strong className="text-ink">{s.legalName}</strong> pasife alınır: portal kullanıcıları askıya alınır, yeni teklif turuna davet edilemez ve ayrılış kontrol listesi açılır. Açık sözleşme ve teklif turları engel değildir; uyarı olarak listelenir. Veri silinmez.</p>
        : <p className="mb-3 text-sm text-ink-muted">Tedarikçi pasife alınmadan önceki durumuna döner; pasife alınırken askıya alınan portal kullanıcıları yeniden açılır. Pasife alan kişi yeniden açamaz.</p>}
      <Field label="Gerekçe" hint="Denetim izine yazılır." error={err}>{(x) => <textarea className="input" rows={3} maxLength={2000} {...x} value={reason} onChange={(e) => setReason(e.target.value)} />}</Field>
    </Modal>
  );
}
