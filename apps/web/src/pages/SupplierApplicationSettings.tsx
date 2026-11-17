// v2 Faz 5 (D110, R3): Yönetim > Tedarikçi başvurusu. Başvuru adresi (aç/kapat, kısaltma, kopyala), hizmet kategorileri ve belge türleri.
// Yönetici düzenler; Satınalma salt okur. Belge türü silinmez, kapatılır (yüklenen belgeler türün koduna bağlıdır).
import { useEffect, useState } from 'react';
import { api, ApiError } from '../lib/api.ts';
import { useResource } from '../lib/useApi.ts';
import { Banner, ErrorState, Field, Loading, Modal, PageHeader, Tag } from '../ui/kit.tsx';
import { Icon } from '../ui/icons.tsx';
import { Button } from '@/components/ui/button';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';

interface Settings { enabled: boolean; publicSlug: string | null; publicPath: string | null; categories: string[]; updatedAt: string | null; can: { manage: boolean } }
interface DocType { id: string; code: string; name: string; required: boolean; requiredCategories: string[]; expiryRequired: boolean; active: boolean }

export function SupplierApplicationSettings() {
  const st = useResource<Settings>('/api/v1/settings/supplier-applications');
  const types = useResource<{ items: DocType[]; can: { manage: boolean } }>('/api/v1/settings/supplier-document-types');
  if (st.loading && !st.data) return <div className="page"><PageHeader title="Tedarikçi başvurusu" /><Loading rows={6} /></div>;
  if (st.error || !st.data) return <div className="page"><PageHeader title="Tedarikçi başvurusu" /><ErrorState error={st.error} onRetry={st.reload} /></div>;
  return (
    <div className="page">
      <PageHeader title="Tedarikçi başvurusu">Firmalar girişsiz başvuru adresinden bilgilerini ve belgelerini gönderir; e-posta doğrulandıktan sonra başvuru Satınalma'ya inceleme görevi olarak düşer.{!st.data.can.manage && ' Ayarları Yönetici değiştirir.'}</PageHeader>
      <SettingsPanel s={st.data} onSaved={async () => { await Promise.all([st.reload(), types.reload()]); }} />
      <section className="panel mt-5" aria-labelledby="types-h">
        <div className="panel-head"><h2 id="types-h">Belge türleri</h2></div>
        {types.loading && !types.data ? <Loading rows={4} /> : types.error || !types.data ? <ErrorState error={types.error} onRetry={types.reload} />
          : <DocTypes items={types.data.items} manage={types.data.can.manage} categories={st.data.categories} reload={types.reload} />}
      </section>
    </div>
  );
}

function SettingsPanel({ s, onSaved }: { s: Settings; onSaved: () => Promise<void> }) {
  const [f, setF] = useState({ enabled: s.enabled, publicSlug: s.publicSlug ?? '', categories: s.categories.join('\n') });
  useEffect(() => { setF({ enabled: s.enabled, publicSlug: s.publicSlug ?? '', categories: s.categories.join('\n') }); }, [s]);
  const [msg, setMsg] = useState<{ tone: 'info' | 'danger'; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const url = s.publicPath ? `${location.origin}${s.publicPath}` : null;
  async function save(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true); setMsg(null);
    try {
      const res = await api<{ seededDocumentTypes?: string[] }>('/api/v1/settings/supplier-applications', { method: 'PUT',
        json: { enabled: f.enabled, publicSlug: f.publicSlug.trim() || null, categories: f.categories.split('\n').map((x) => x.trim()).filter(Boolean) } });
      setMsg({ tone: 'info', text: res.data.seededDocumentTypes?.length ? `Ayarlar kaydedildi. Önerilen ${res.data.seededDocumentTypes.length} belge türü eklendi; aşağıdan düzenleyebilirsiniz.` : 'Ayarlar kaydedildi.' });
      await onSaved();
    } catch (x) { setMsg({ tone: 'danger', text: x instanceof ApiError ? x.message : 'Kaydedilemedi.' }); }
    finally { setBusy(false); }
  }
  return (
    <section className="panel" aria-labelledby="addr-h">
      <div className="panel-head"><h2 id="addr-h">Başvuru adresi</h2>
        <Tag className="ml-auto" label={s.enabled ? { text: 'Açık', tone: 'ok', icon: 'check' } : { text: 'Kapalı', tone: 'neutral', icon: 'lock' }} /></div>
      <div className="panel-body grid gap-3">
        {url ? (
          <div className="flex flex-wrap items-center gap-2">
            <span className="mono min-w-0 break-all rounded-md border border-border bg-white px-3 py-1.5">{url}</span>
            <Button size="sm" variant="outline" onClick={() => { void navigator.clipboard?.writeText(url).then(() => { setCopied(true); setTimeout(() => setCopied(false), 2000); }); }}>{copied ? 'Kopyalandı' : 'Kopyala'}</Button>
            {s.enabled && <Button size="sm" variant="ghost" asChild><a href={url} target="_blank" rel="noreferrer">Aç</a></Button>}
            <span aria-live="polite" className="sr-only">{copied ? 'Adres kopyalandı' : ''}</span>
          </div>
        ) : <p className="text-ink-muted">Başvuru adresi henüz tanımlanmadı.</p>}
        {!s.enabled && <p className="text-sm text-ink-muted">Kapalıyken adres "Başvuru şu an kabul edilmiyor" der; kurum adı gösterilmez.</p>}
        {s.can.manage ? (
          <form onSubmit={(e) => void save(e)} className="grid gap-x-6 border-t border-border pt-3 min-[900px]:grid-cols-2">
            <div className="min-[900px]:col-span-2">
              <label className="inline-flex min-h-8 items-center gap-2 font-semibold"><input type="checkbox" className="size-4 accent-ink" checked={f.enabled} onChange={(e) => setF({ ...f, enabled: e.target.checked })} />Başvuru alımı açık</label>
            </div>
            <Field label="Adres kısaltması" hint="Küçük harf, rakam ve tire. Adres: /basvuru/<kısaltma>">{(x) => <input className="input mono" maxLength={64} {...x} value={f.publicSlug} onChange={(e) => setF({ ...f, publicSlug: e.target.value })} />}</Field>
            <Field label="Hizmet kategorileri" hint="Her satıra bir kategori. Belge türü yalnız seçili kategorilerde zorunlu yapılabilir.">{(x) => <textarea className="input" rows={4} {...x} value={f.categories} onChange={(e) => setF({ ...f, categories: e.target.value })} />}</Field>
            <div className="min-[900px]:col-span-2 grid gap-2">
              <div aria-live="polite">{msg && <Banner tone={msg.tone} icon={msg.tone === 'info' ? 'check' : undefined} title={msg.text} />}</div>
              <Button type="submit" className="justify-self-start" disabled={busy}>{busy ? 'Kaydediliyor…' : 'Kaydet'}</Button>
            </div>
          </form>
        ) : (
          <dl className="facts border-t border-border pt-3"><dt>Hizmet kategorileri</dt><dd>{s.categories.length ? s.categories.join(', ') : '—'}</dd></dl>
        )}
      </div>
    </section>
  );
}

const ruleText = (t: DocType) => t.required ? 'Her başvuruda zorunlu' : t.requiredCategories.length ? `Zorunlu: ${t.requiredCategories.join(', ')}` : 'İsteğe bağlı';

function DocTypes({ items, manage, categories, reload }: { items: DocType[]; manage: boolean; categories: string[]; reload: () => Promise<void> }) {
  const [edit, setEdit] = useState<DocType | 'new' | null>(null);
  const [msg, setMsg] = useState<{ tone: 'info' | 'danger'; text: string } | null>(null);
  async function toggle(t: DocType) {
    setMsg(null);
    try { await api(`/api/v1/settings/supplier-document-types/${t.id}`, { method: 'PUT', json: { active: !t.active } }); setMsg({ tone: 'info', text: `${t.name} ${t.active ? 'kapatıldı' : 'etkinleştirildi'}.` }); await reload(); }
    catch (x) { setMsg({ tone: 'danger', text: x instanceof ApiError ? x.message : 'Kaydedilemedi.' }); }
  }
  return (
    <div className="panel-body grid gap-3">
      {!items.length ? <p className="text-ink-muted">Belge türü yok. Başvuru ilk kez açıldığında önerilen set (vergi levhası, imza sirküleri, ticaret sicil gazetesi, faaliyet belgesi, ISO 27001) eklenir.</p> : (
        <Table>
          <TableHeader><TableRow className="hover:bg-transparent"><TableHead>Belge</TableHead><TableHead>Zorunluluk</TableHead><TableHead>Geçerlilik tarihi</TableHead><TableHead>Durum</TableHead>{manage && <TableHead><span className="sr-only">Eylem</span></TableHead>}</TableRow></TableHeader>
          <TableBody>{items.map((t) => (
            <TableRow key={t.id}>
              <TableCell className="min-w-[180px]"><span className="block font-semibold">{t.name}</span><span className="mono text-xs text-ink-subtle">{t.code}</span></TableCell>
              <TableCell>{ruleText(t)}</TableCell>
              <TableCell>{t.expiryRequired ? 'Zorunlu' : 'Gerekmez'}</TableCell>
              <TableCell><Tag label={t.active ? { text: 'Etkin', tone: 'ok', icon: 'check' } : { text: 'Kapalı', tone: 'neutral', icon: 'minus' }} /></TableCell>
              {manage && <TableCell><div className="flex gap-1">
                <Button size="sm" variant="ghost" aria-label={`${t.name} düzenle`} onClick={() => setEdit(t)}><Icon name="pen" />Düzenle</Button>
                <Button size="sm" variant="outline" onClick={() => void toggle(t)}>{t.active ? 'Kapat' : 'Etkinleştir'}</Button></div></TableCell>}
            </TableRow>))}</TableBody>
        </Table>
      )}
      <div aria-live="polite">{msg && <Banner tone={msg.tone} icon={msg.tone === 'info' ? 'check' : undefined} title={msg.text} />}</div>
      {manage && <Button variant="outline" className="justify-self-start" onClick={() => setEdit('new')}>Belge türü ekle</Button>}
      {edit && <TypeDialog t={edit === 'new' ? null : edit} categories={categories} onClose={() => setEdit(null)} onSaved={async (text) => { setEdit(null); setMsg({ tone: 'info', text }); await reload(); }} />}
    </div>
  );
}

function TypeDialog({ t, categories, onClose, onSaved }: { t: DocType | null; categories: string[]; onClose: () => void; onSaved: (msg: string) => Promise<void> }) {
  const [f, setF] = useState({ code: t?.code ?? '', name: t?.name ?? '', mode: t ? (t.required ? 'ALWAYS' : t.requiredCategories.length ? 'CATEGORIES' : 'OPTIONAL') : 'ALWAYS',
    requiredCategories: t?.requiredCategories ?? [], expiryRequired: t?.expiryRequired ?? false });
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const cats = [...new Set([...categories, ...f.requiredCategories])];
  async function save() {
    if (!t && !/^[A-Z0-9_]{2,40}$/.test(f.code)) { setErr('Kod 2–40 karakter; büyük harf, rakam ve alt çizgi.'); return; }
    if (f.name.trim().length < 2) { setErr('Belge adını girin.'); return; }
    if (f.mode === 'CATEGORIES' && !f.requiredCategories.length) { setErr('En az bir kategori seçin.'); return; }
    const body = { name: f.name.trim(), required: f.mode === 'ALWAYS', requiredCategories: f.mode === 'CATEGORIES' ? f.requiredCategories : [], expiryRequired: f.expiryRequired };
    setBusy(true); setErr(null);
    try {
      if (t) await api(`/api/v1/settings/supplier-document-types/${t.id}`, { method: 'PUT', json: body });
      else await api('/api/v1/settings/supplier-document-types', { method: 'POST', json: { code: f.code, ...body } });
      await onSaved(`${body.name} kaydedildi.`);
    } catch (x) { setErr(x instanceof ApiError ? x.message : 'Kaydedilemedi.'); }
    finally { setBusy(false); }
  }
  return (
    <Modal title={t ? 'Belge türünü düzenle' : 'Belge türü ekle'} onClose={onClose} footer={<><Button variant="outline" onClick={onClose}>Vazgeç</Button><Button disabled={busy} onClick={() => void save()}>{busy ? 'Kaydediliyor…' : 'Kaydet'}</Button></>}>
      {!t && <Field label="Kod" hint="Sonradan değiştirilemez (ör. SGK_BORCU_YOKTUR).">{(x) => <input className="input mono" maxLength={40} {...x} value={f.code} onChange={(e) => setF({ ...f, code: e.target.value.toUpperCase() })} />}</Field>}
      <Field label="Ad">{(x) => <input className="input" maxLength={120} {...x} value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} />}</Field>
      <fieldset className="field"><legend>Zorunluluk</legend>
        <div className="grid gap-1.5">{([['ALWAYS', 'Her başvuruda zorunlu'], ['CATEGORIES', 'Yalnız seçili kategorilerde zorunlu'], ['OPTIONAL', 'İsteğe bağlı']] as const).map(([v, l]) => (
          <label key={v} className="inline-flex min-h-8 items-center gap-2 font-normal"><input type="radio" name="mode" className="accent-ink" checked={f.mode === v} onChange={() => setF({ ...f, mode: v })} />{l}</label>))}</div>
      </fieldset>
      {f.mode === 'CATEGORIES' && (
        <fieldset className="field"><legend>Kategoriler</legend>
          {!cats.length ? <p className="text-sm text-ink-muted">Önce başvuru ayarlarına hizmet kategorisi ekleyin.</p> : <div className="grid gap-1.5">{cats.map((c) => (
            <label key={c} className="inline-flex min-h-8 items-center gap-2 font-normal"><input type="checkbox" className="size-4 accent-ink" checked={f.requiredCategories.includes(c)}
              onChange={(e) => setF({ ...f, requiredCategories: e.target.checked ? [...f.requiredCategories, c] : f.requiredCategories.filter((y) => y !== c) })} />{c}</label>))}</div>}
        </fieldset>
      )}
      <label className="inline-flex min-h-8 items-center gap-2"><input type="checkbox" className="size-4 accent-ink" checked={f.expiryRequired} onChange={(e) => setF({ ...f, expiryRequired: e.target.checked })} />Geçerlilik tarihi zorunlu</label>
      {err && <p role="alert" className="mt-2 text-sm text-danger">{err}</p>}
    </Modal>
  );
}
