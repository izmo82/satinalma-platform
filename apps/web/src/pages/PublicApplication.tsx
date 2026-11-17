// v2 Faz 5 (D110, Figma P1): girişsiz tedarikçi başvurusu, e-posta doğrulama ve eksik belge tamamlama. Oturum gerekmez; yalnız
// /api/v1/public/... uçları çağrılır. Belirteç adres çubuğunun `#` parçasından okunur ve hemen adresten silinir (sunucu günlüğüne,
// yönlendirene düşmez); tarayıcıda saklanmaz.
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { Route, Routes, useParams } from 'react-router-dom';
import { Banner, Field, Loading } from '../ui/kit.tsx';
import { Icon } from '../ui/icons.tsx';
import { Button } from '@/components/ui/button';
import { ACCEPT, fmtSize, MIME_OK, typesText } from '../lib/supplierV2.tsx';
import { cn } from '@/lib/utils';

interface Limits { maxFiles: number; maxFileBytes: number; maxTotalBytes: number; types: string[] }
interface DocType { code: string; name: string; required: boolean; requiredCategories: string[]; expiryRequired: boolean }
type Config = { enabled: false } | { enabled: true; organizationName: string; categories: string[]; documentTypes: DocType[]; limits: Limits };

class PublicError extends Error { constructor(public status: number, public code: string, message: string, public details?: any) { super(message); } }

/** Oturumsuz istek: oturum/kiracı başlığı ve oturum olayları yok. */
async function pub<T>(path: string, init: RequestInit = {}): Promise<T> {
  let res: Response;
  try { res = await fetch(path, { ...init, credentials: 'omit' }); }
  catch { throw new PublicError(0, 'network', 'Sunucuya ulaşılamadı. Bağlantınızı kontrol edin; başvurunuz gönderilmedi.'); }
  const text = await res.text();
  let body: any = null; try { body = text ? JSON.parse(text) : null; } catch { body = null; }
  if (!res.ok) {
    if (res.status === 429) throw new PublicError(429, 'rate_limited', body?.error?.message ?? 'Çok fazla deneme yapıldı. Bir süre sonra yeniden deneyin.');
    throw new PublicError(res.status, body?.error?.code ?? 'error', body?.error?.message ?? `İstek tamamlanamadı (${res.status}).`, body?.error?.details);
  }
  return body as T;
}

/** `#token=…` okunur; adres hemen temizlenir. StrictMode'daki çift çizimde de aynı değer okunur (silme efektte). */
function useHashToken(path: string) {
  const [token] = useState(() => { const m = /(?:^#|&)token=([^&]+)/.exec(location.hash); return m ? decodeURIComponent(m[1]!) : null; });
  useEffect(() => { if (location.hash) history.replaceState(null, '', path); }, [path]);
  return token;
}

export function PublicApplication() {
  return (
    <Routes>
      <Route path="/basvuru/dogrula" element={<Verify />} />
      <Route path="/basvuru/tamamla" element={<Complete />} />
      <Route path="/basvuru/:slug" element={<Apply />} />
      <Route path="*" element={<Frame><Closed /></Frame>} />
    </Routes>
  );
}

function Frame({ org, children }: { org?: string; children: ReactNode }) {
  return (
    <div className="min-h-full bg-paper">
      <header className="flex min-h-14 flex-wrap items-center gap-x-4 gap-y-1 border-b border-border bg-surface px-8 py-2 max-[640px]:px-4">
        <Icon name="stamp" size={18} className="text-istampa" />
        <span className="font-semibold">{org ? `${org} · Tedarikçi portalı` : 'Tedarikçi portalı'}</span>
        <a href="/portal" className="ml-auto text-sm font-semibold text-info">Zaten hesabınız var mı? Giriş yapın</a>
      </header>
      <main id="main" className="mx-auto w-full max-w-[1040px] px-6 py-8 max-[640px]:px-4">{children}</main>
    </div>
  );
}

function Closed() {
  return (
    <div className="rounded-md border border-border bg-surface px-6 py-10 text-center">
      <h1 className="text-xl">Başvuru şu an kabul edilmiyor</h1>
      <p className="mx-auto mt-2 max-w-[60ch] text-ink-muted">Bu adresten tedarikçi başvurusu alınmıyor. Kurumla iletişime geçip güncel başvuru adresini isteyin.</p>
    </div>
  );
}

const TAX_TYPES = [['VKN', 'VKN (vergi kimlik numarası)'], ['TCKN', 'T.C. kimlik numarası (şahıs firması)'], ['FOREIGN', 'Yabancı vergi numarası']] as const;
interface Picked { file: File | null; validUntil: string }

/** Belge yükleme satırları: tür adı, zorunluluk, dosya ve (gerekiyorsa) geçerlilik tarihi. */
function DocumentRows({ types, required, picked, setPicked, errors, limits }: { types: DocType[]; required: (t: DocType) => boolean;
  picked: Record<string, Picked>; setPicked: (f: (p: Record<string, Picked>) => Record<string, Picked>) => void; errors: Record<string, string>; limits: Limits }) {
  return (
    <ul className="grid">
      {types.map((t) => {
        const p = picked[t.code] ?? { file: null, validUntil: '' };
        const req = required(t);
        const id = `doc-${t.code}`;
        return (
          <li key={t.code} className="grid gap-2 border-b border-border py-3 last:border-0">
            <div className="flex flex-wrap items-center gap-2">
              <Icon name="file" className="text-ink-subtle" />
              <span className="font-semibold">{t.name}</span>
              <span className={cn('text-sm', req ? 'text-ink' : 'text-ink-subtle')}>{req ? 'Zorunlu' : 'İsteğe bağlı'}</span>
              {p.file && <span className="ml-auto inline-flex items-center gap-1 text-sm text-verified"><Icon name="check" size={14} />Seçildi</span>}
            </div>
            <div className="flex flex-wrap items-end gap-3">
              <div className="grid min-w-0 flex-1 gap-1">
                <label htmlFor={id} className="text-sm font-semibold">{t.name} dosyası</label>
                <input id={id} type="file" accept={ACCEPT} className="input min-w-0 py-1.5" aria-invalid={errors[t.code] ? true : undefined}
                  aria-describedby={errors[t.code] ? `${id}-err` : undefined}
                  onChange={(e) => { const f = e.target.files?.[0] ?? null; setPicked((x) => ({ ...x, [t.code]: { ...(x[t.code] ?? { validUntil: '' }), file: f } })); }} />
                {p.file && <span className="truncate text-xs text-ink-muted">{p.file.name} · {fmtSize(p.file.size)}</span>}
              </div>
              {t.expiryRequired && (
                <div className="grid gap-1">
                  <label htmlFor={`${id}-until`} className="text-sm font-semibold">Geçerlilik tarihi</label>
                  <input id={`${id}-until`} type="date" className="input tabular" value={p.validUntil} aria-invalid={errors[`${t.code}-until`] ? true : undefined}
                    onChange={(e) => setPicked((x) => ({ ...x, [t.code]: { ...(x[t.code] ?? { file: null }), validUntil: e.target.value } }))} />
                </div>
              )}
            </div>
            {(errors[t.code] || errors[`${t.code}-until`]) && <span id={`${id}-err`} className="flex items-center gap-1.5 text-sm text-danger"><Icon name="alert" size={14} />{errors[t.code] ?? errors[`${t.code}-until`]}</span>}
          </li>
        );
      })}
      <li className="pt-2 text-sm text-ink-muted">Kabul edilen türler: {typesText(limits.types)}. Dosya başına en çok {fmtSize(limits.maxFileBytes)}, en çok {limits.maxFiles} dosya, toplam {fmtSize(limits.maxTotalBytes)}. ZIP, EXE ve Office dosyaları kabul edilmez.</li>
    </ul>
  );
}

/** İstemci denetimi (sunucu aynısını yeniden yapar): zorunlu dosya, geçerlilik tarihi, tür ve boyut sınırları. */
function checkFiles(types: DocType[], required: (t: DocType) => boolean, picked: Record<string, Picked>, limits: Limits) {
  const e: Record<string, string> = {};
  let total = 0; let count = 0;
  for (const t of types) {
    const p = picked[t.code];
    if (!p?.file) { if (required(t)) e[t.code] = `${t.name} yüklenmeli.`; continue; }
    count++; total += p.file.size;
    if (!MIME_OK.includes(p.file.type) && !/\.(pdf|png|jpe?g)$/i.test(p.file.name)) e[t.code] = 'Yalnız PDF, JPEG veya PNG yüklenebilir.';
    else if (p.file.size > limits.maxFileBytes) e[t.code] = `Dosya ${fmtSize(limits.maxFileBytes)} sınırını aşıyor.`;
    if (t.expiryRequired && !p.validUntil) e[`${t.code}-until`] = 'Geçerlilik tarihini girin.';
  }
  const general = count > limits.maxFiles ? `En çok ${limits.maxFiles} dosya yüklenebilir.` : total > limits.maxTotalBytes ? `Dosyaların toplamı ${fmtSize(limits.maxTotalBytes)} sınırını aşıyor.` : null;
  return { e, general };
}

function serverDetail(err: PublicError): string | null {
  const d = err.details;
  if (Array.isArray(d?.documents)) return `İlgili belgeler: ${d.documents.map((x: { name?: string; code: string }) => x.name ?? 'belge').join(', ')}.`;
  return null;
}

function Apply() {
  const { slug = '' } = useParams();
  const [cfg, setCfg] = useState<Config | null>(null);
  const [loadErr, setLoadErr] = useState<PublicError | null>(null);
  const [f, setF] = useState({ legalName: '', country: 'TR', taxIdType: 'VKN', taxId: '', contactName: '', contactEmail: '', contactPhone: '', address: '', services: '', website: '' });
  const [cats, setCats] = useState<string[]>([]);
  const [picked, setPicked] = useState<Record<string, Picked>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<PublicError | null>(null);
  const [done, setDone] = useState<{ message: string; mailChannel: string; note: string | null } | null>(null);
  useEffect(() => { pub<Config>(`/api/v1/public/applications/${encodeURIComponent(slug)}/config`).then(setCfg, setLoadErr); }, [slug]);
  const open = cfg?.enabled ? cfg : null;
  const required = useMemo(() => (t: DocType) => t.required || t.requiredCategories.some((c) => cats.includes(c)), [cats]);

  if (loadErr) return <Frame><Banner tone="danger" title="Başvuru formu yüklenemedi">{loadErr.message}</Banner></Frame>;
  if (!cfg) return <Frame><Loading label="Başvuru formu yükleniyor" /></Frame>;
  if (!open) return <Frame><Closed /></Frame>;
  const reqTypes = open.documentTypes.filter(required);
  const uploadedReq = reqTypes.filter((t) => picked[t.code]?.file).length;
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>) => setF({ ...f, [k]: e.target.value });

  if (done) return (
    <Frame org={open.organizationName}>
      <section className="panel mx-auto max-w-[680px]" aria-labelledby="done-h">
        <div className="panel-body grid gap-3">
          <h1 id="done-h" className="text-xl">E-postanızı doğrulayın</h1>
          <p role="status">{done.message}</p>
          {done.note && <Banner tone="warn" title="E-posta kanalı yapılandırılmadı">{done.note}</Banner>}
          <p className="text-ink-muted">Başvurunuz e-posta adresiniz doğrulanınca incelemeye girer. 24 saat içinde doğrulanmayan başvuru kapanır; dosyalarınız silinmez.</p>
        </div>
      </section>
    </Frame>
  );

  async function submit(ev: React.FormEvent) {
    ev.preventDefault();
    const e: Record<string, string> = {};
    if (f.legalName.trim().length < 2) e.legalName = 'Ticaret unvanını girin.';
    if (!f.taxId.trim()) e.taxId = 'Vergi kimliğini girin.';
    else if (f.taxIdType === 'VKN' && !/^\d{10}$/.test(f.taxId.trim())) e.taxId = 'VKN 10 haneli olmalı.';
    else if (f.taxIdType === 'TCKN' && !/^\d{11}$/.test(f.taxId.trim())) e.taxId = 'T.C. kimlik numarası 11 haneli olmalı.';
    if (f.contactName.trim().length < 2) e.contactName = 'Yetkili kişinin adını girin.';
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(f.contactEmail.trim())) e.contactEmail = 'Geçerli bir e-posta adresi girin.';
    const files = checkFiles(open!.documentTypes, required, picked, open!.limits);
    Object.assign(e, files.e);
    setErrors(e); setError(files.general ? new PublicError(422, 'files', files.general) : null);
    if (Object.keys(e).length || files.general) return;
    const fd = new FormData();
    for (const [k, v] of Object.entries(f)) if (k !== 'website' || v) fd.append(k, v.trim());
    for (const c of cats) fd.append('categories', c);
    for (const t of open!.documentTypes) {
      const p = picked[t.code];
      if (!p?.file) continue;
      if (p.validUntil) fd.append(`validUntil[${t.code}]`, p.validUntil);
      fd.append(`documents[${t.code}]`, p.file, p.file.name);
    }
    setBusy(true);
    try { setDone(await pub(`/api/v1/public/applications/${encodeURIComponent(slug)}`, { method: 'POST', body: fd })); }
    catch (err) { setError(err as PublicError); if ((err as PublicError).details?.field) setErrors({ [(err as PublicError).details.field]: (err as PublicError).message }); }
    finally { setBusy(false); }
  }

  return (
    <Frame org={open.organizationName}>
      <h1>Tedarikçi başvurusu</h1>
      <p className="mt-1 mb-5 text-ink-muted">Bilgilerinizi ve belgelerinizi gönderin. E-posta adresinizi doğruladıktan sonra başvurunuz incelenir; onaylanırsa aday tedarikçi olursunuz.</p>
      <form onSubmit={(e) => void submit(e)} noValidate className="grid items-start gap-5 min-[960px]:grid-cols-[minmax(0,1fr)_minmax(0,420px)]">
        {/* R4d: insanlara görünmeyen tuzak alanı; doluysa kayıt açılmaz. */}
        <div aria-hidden="true" className="absolute -left-[9999px] h-px w-px overflow-hidden">
          <label htmlFor="website">Web sitesi</label><input id="website" tabIndex={-1} autoComplete="off" value={f.website} onChange={set('website')} />
        </div>
        <section className="panel" aria-labelledby="firm-h">
          <div className="panel-head"><h2 id="firm-h">Firma bilgileri</h2></div>
          <div className="panel-body grid gap-x-4 min-[640px]:grid-cols-2">
            <div className="min-[640px]:col-span-2"><Field label="Ticaret unvanı" error={errors.legalName}>{(p) => <input className="input" autoComplete="organization" {...p} value={f.legalName} onChange={set('legalName')} />}</Field></div>
            <Field label="Kimlik türü">{(p) => <select className="input" {...p} value={f.taxIdType} onChange={set('taxIdType')}>{TAX_TYPES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select>}</Field>
            <Field label={f.taxIdType === 'TCKN' ? 'T.C. kimlik numarası' : f.taxIdType === 'FOREIGN' ? 'Vergi numarası' : 'VKN'} hint="Kontrol basamağı doğrulanır; baştaki sıfırlar korunur." error={errors.taxId}>
              {(p) => <input className="input mono" inputMode={f.taxIdType === 'FOREIGN' ? 'text' : 'numeric'} {...p} value={f.taxId} onChange={set('taxId')} />}</Field>
            {f.taxIdType === 'FOREIGN' && <Field label="Ülke kodu" hint="İki harf (ör. DE)." error={errors.country}>{(p) => <input className="input" maxLength={2} {...p} value={f.country} onChange={(e) => setF({ ...f, country: e.target.value.toUpperCase() })} />}</Field>}
            <Field label="Yetkili kişi" error={errors.contactName}>{(p) => <input className="input" autoComplete="name" {...p} value={f.contactName} onChange={set('contactName')} />}</Field>
            <Field label="E-posta" hint="Doğrulama bağlantısı bu adrese gider." error={errors.contactEmail}>{(p) => <input className="input" type="email" autoComplete="email" {...p} value={f.contactEmail} onChange={set('contactEmail')} />}</Field>
            <Field label="Telefon" error={errors.contactPhone}>{(p) => <input className="input" type="tel" autoComplete="tel" {...p} value={f.contactPhone} onChange={set('contactPhone')} />}</Field>
            <div className="min-[640px]:col-span-2"><Field label="Adres" error={errors.address}>{(p) => <input className="input" autoComplete="street-address" {...p} value={f.address} onChange={set('address')} />}</Field></div>
            <div className="min-[640px]:col-span-2"><Field label="Sunduğunuz hizmetler" hint="İsteğe bağlı; kısa açıklama." error={errors.services}>{(p) => <textarea className="input" rows={3} maxLength={4000} {...p} value={f.services} onChange={set('services')} />}</Field></div>
            {open.categories.length > 0 && (
              <fieldset className="field min-[640px]:col-span-2">
                <legend>Hizmet kategorileri</legend>
                <span className="hint">Seçtiğiniz kategoriye göre zorunlu belge listesi değişebilir.</span>
                <div className="mt-1 flex flex-wrap gap-x-5 gap-y-2">
                  {open.categories.map((c) => (
                    <label key={c} className="inline-flex min-h-8 items-center gap-2 font-normal">
                      <input type="checkbox" className="size-4 accent-ink" checked={cats.includes(c)} onChange={(e) => setCats((x) => e.target.checked ? [...x, c] : x.filter((y) => y !== c))} />{c}
                    </label>
                  ))}
                </div>
                {errors.categories && <span className="error"><Icon name="alert" size={14} />{errors.categories}</span>}
              </fieldset>
            )}
          </div>
        </section>
        <div className="grid gap-4">
          <section className="panel" aria-labelledby="docs-h">
            <div className="panel-head"><h2 id="docs-h">Belgeler</h2><span className="tabular ml-auto text-sm text-ink-muted">{uploadedReq} / {reqTypes.length} zorunlu belge seçildi</span></div>
            <div className="panel-body py-1">
              {open.documentTypes.length ? <DocumentRows types={open.documentTypes} required={required} picked={picked} setPicked={setPicked} errors={errors} limits={open.limits} />
                : <p className="py-3 text-ink-muted">Bu başvuruda belge istenmiyor.</p>}
            </div>
          </section>
          {uploadedReq < reqTypes.length && <Banner tone="warn" title={`Eksik ${reqTypes.length - uploadedReq} zorunlu belge yüklenmeden başvuru gönderilemez.`} />}
          {error && <Banner tone={error.status === 409 || error.status === 429 ? 'warn' : 'danger'} title={error.message}>{serverDetail(error)}</Banner>}
          <div className="flex flex-wrap items-center justify-end gap-3">
            <p className="mr-auto max-w-[44ch] text-sm text-ink-muted">Gönderdiğiniz bilgiler yalnız başvurunuzun incelenmesi için kullanılır.</p>
            <Button type="submit" size="lg" disabled={busy}>{busy ? 'Gönderiliyor…' : 'Başvuruyu gönder'}</Button>
          </div>
        </div>
      </form>
    </Frame>
  );
}

const verifying = new Map<string, Promise<{ status: string }>>();
function Verify() {
  const token = useHashToken('/basvuru/dogrula');
  const [state, setState] = useState<{ ok: boolean; message: string } | null>(token ? null : { ok: false, message: 'Doğrulama bağlantısı eksik. E-postadaki bağlantıyı yeniden açın.' });
  useEffect(() => {
    if (!token) return;
    // Belirteç tek kullanımlık: StrictMode'daki ikinci efekt aynı isteği paylaşır.
    if (!verifying.has(token)) verifying.set(token, pub<{ status: string }>('/api/v1/public/applications/verify', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token }) }));
    verifying.get(token)!.then(() => setState({ ok: true, message: 'E-posta adresiniz doğrulandı. Başvurunuz incelemeye alındı; sonuç e-posta adresinize bildirilir.' }),
      (e: PublicError) => setState({ ok: false, message: e.status === 410 ? 'Bağlantı geçersiz, kullanılmış ya da süresi dolmuş. Başvurunuzu yeniden gönderebilirsiniz.' : e.message }));
  }, [token]);
  return (
    <Frame>
      <section className="panel mx-auto max-w-[620px]"><div className="panel-body grid gap-3">
        <h1 className="text-xl">E-posta doğrulama</h1>
        {!state ? <Loading rows={2} label="Doğrulanıyor" /> : <Banner tone={state.ok ? 'info' : 'warn'} icon={state.ok ? 'check' : undefined} title={state.ok ? 'Doğrulandı' : 'Doğrulanamadı'}>{state.message}</Banner>}
      </div></section>
    </Frame>
  );
}

interface CompleteInfo { legalName: string; note: string | null; requestedDocuments: { code: string; name: string; expiryRequired: boolean }[]; limits: Limits }
function Complete() {
  const token = useHashToken('/basvuru/tamamla');
  const [info, setInfo] = useState<CompleteInfo | null>(null);
  const [err, setErr] = useState<PublicError | null>(token ? null : new PublicError(410, 'token_invalid', 'Bağlantı eksik.'));
  const [picked, setPicked] = useState<Record<string, Picked>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [submitErr, setSubmitErr] = useState<PublicError | null>(null);
  useEffect(() => {
    if (!token) return;
    pub<CompleteInfo>('/api/v1/public/applications/complete-info', { headers: { 'X-Application-Token': token } }).then(setInfo, setErr);
  }, [token]);
  const types: DocType[] = (info?.requestedDocuments ?? []).map((d) => ({ ...d, required: true, requiredCategories: [] }));
  async function submit(ev: React.FormEvent) {
    ev.preventDefault();
    if (!info || !token) return;
    const c = checkFiles(types, () => true, picked, info.limits);
    setErrors(c.e); setSubmitErr(c.general ? new PublicError(422, 'files', c.general) : null);
    if (Object.keys(c.e).length || c.general) return;
    const fd = new FormData();
    for (const t of types) { const p = picked[t.code]!; if (p.validUntil) fd.append(`validUntil[${t.code}]`, p.validUntil); fd.append(`documents[${t.code}]`, p.file!, p.file!.name); }
    setBusy(true);
    try { await pub('/api/v1/public/applications/complete', { method: 'POST', body: fd, headers: { 'X-Application-Token': token } }); setDone(true); }
    catch (e) { setSubmitErr(e as PublicError); }
    finally { setBusy(false); }
  }
  return (
    <Frame>
      <section className="panel mx-auto max-w-[720px]"><div className="panel-body grid gap-3">
        <h1 className="text-xl">Eksik belgeleri tamamlayın</h1>
        {err ? <Banner tone="warn" title="Bağlantı geçersiz">{err.status === 410 ? 'Bağlantı geçersiz, kullanılmış ya da süresi dolmuş. Kurumdan yeni bağlantı isteyin; sayfayı yenilediyseniz e-postadaki bağlantıyı yeniden açın.' : err.message}</Banner>
          : !info ? <Loading rows={3} label="Başvuru yükleniyor" />
          : done ? <Banner tone="info" icon="check" title="Belgeleriniz alındı">Başvurunuz yeniden incelemeye girdi. Sonuç e-posta adresinize bildirilir.</Banner>
          : <form onSubmit={(e) => void submit(e)} noValidate className="grid gap-3">
            <p><span className="text-ink-muted">Başvuru:</span> <strong>{info.legalName}</strong></p>
            {info.note && <Banner tone="info" title="Kurumun notu">{info.note}</Banner>}
            <DocumentRows types={types} required={() => true} picked={picked} setPicked={setPicked} errors={errors} limits={info.limits} />
            {submitErr && <Banner tone="danger" title={submitErr.message}>{serverDetail(submitErr)}</Banner>}
            <Button type="submit" size="lg" className="justify-self-end" disabled={busy}>{busy ? 'Gönderiliyor…' : 'Belgeleri gönder'}</Button>
          </form>}
      </div></section>
    </Frame>
  );
}
