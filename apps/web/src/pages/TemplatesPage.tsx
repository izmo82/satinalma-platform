import { useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, ApiError } from '../lib/api.ts';
import { useResource } from '../lib/useApi.ts';
import { hasRole, useSession } from '../lib/session.tsx';
import { fmtDate, fmtDateTime, todayLocal } from '../lib/format.ts';
import { CONTRACT_TYPES, downloadBlob, type ContractType, type Template, type TemplateVersion } from '../lib/contractsV2.ts';
import { Banner, Empty, ErrorState, Field, Loading, PageHeader } from '../ui/kit.tsx';
import { Icon } from '../ui/icons.tsx';
import { Button } from '@/components/ui/button';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { cn } from '@/lib/utils';

/**
 * v2 Faz 3 (R8, Figma 12): sözleşme şablon kütüphanesi. Yönetim > Şablonlar ve Sözleşmeler > Şablonlar aynı sayfadır. İndirme bütün iç
 * rollere; yükleme ve yeni sürüm Yönetici ve Satınalma'ya. Yeni sürüm öncekini geçersiz yapar, eski sürüm silinmez.
 * Yönetim sekmesinde Yönetici ayrıca hatırlatıcı sürelerini (R7) ayarlar.
 */
export function TemplatesPage({ admin = false }: { admin?: boolean }) {
  const { me } = useSession();
  const r = useResource<{ items: Template[] }>('/api/v1/contract-templates');
  const canManage = hasRole(me, 'ADMIN', 'PROCUREMENT');
  const canUse = hasRole(me, 'PROCUREMENT', 'DEPARTMENT_USER');
  const [upload, setUpload] = useState<{ file: File; templateId: string } | null>(null);
  const [msg, setMsg] = useState<{ tone: 'info' | 'danger' | 'warn'; text: string } | null>(null);
  const items = r.data?.items ?? [];
  const pick = (file: File | undefined, templateId = '') => {
    setMsg(null);
    if (!file) return;
    if (!file.name.toLowerCase().endsWith('.docx')) { setMsg({ tone: 'warn', text: 'Yalnız .docx dosyası yüklenebilir.' }); return; }
    setUpload({ file, templateId });
  };
  return (
    <div className="page">
      <PageHeader title={admin ? 'Şablonlar' : 'Sözleşme şablonları'} actions={<div className="flex flex-wrap gap-2">
        {!admin && <Button variant="outline" asChild><Link to="/sozlesmeler">Sözleşmeler</Link></Button>}
        {canManage && <FilePick label="Şablon yükle (.docx)" onPick={(f) => pick(f)} primary />}</div>}>
        Kurumun onaylı sözleşme şablonları. Yeni sözleşmeler güncel sürümü kullanır; şablondan eklenen sözleşmenin türü ve sürümü dolu gelir.
      </PageHeader>
      {msg && <Banner tone={msg.tone} title={msg.text} />}
      {upload && canManage && <UploadForm key={upload.file.name + upload.templateId} file={upload.file} templateId={upload.templateId} templates={items}
        onCancel={() => setUpload(null)} onDone={async (t) => { setUpload(null); setMsg({ tone: 'info', text: t }); await r.reload(); }} />}
      {r.loading && !r.data ? <Loading /> : r.error ? <ErrorState error={r.error} onRetry={r.reload} /> : !items.length ? (
        <div className="rounded-md border border-border bg-surface"><Empty icon="file" title="Henüz şablon yok">{canManage ? 'Kurumun onaylı sözleşme taslağını .docx olarak yükleyin.' : 'Şablonları Satınalma ve Yönetici yükler.'}</Empty></div>
      ) : (
        <>
          <ul className="hidden divide-y divide-[#ebe6da] rounded-md border border-border bg-surface max-[760px]:block" aria-label="Şablonlar">
            {items.map((t) => (
              <li key={t.id} className="grid gap-1.5 p-3">
                <div className="font-semibold">{t.name}</div>
                <div className="tabular text-sm text-ink-subtle">{t.code} · {CONTRACT_TYPES[t.contractType]} · {t.currentVersion ? `v${t.currentVersion.versionNo}` : 'güncel sürüm yok'} · {t.usageCount} kullanım</div>
                <RowActions t={t} canUse={canUse} canManage={canManage} onPick={(f) => pick(f, t.id)} onError={(e) => setMsg({ tone: 'danger', text: e })} />
                <Versions t={t} onError={(e) => setMsg({ tone: 'danger', text: e })} />
              </li>
            ))}
          </ul>
          <div className="max-[760px]:hidden"><Table>
            <TableHeader><TableRow className="hover:bg-transparent">
              <TableHead scope="col" className="max-[1279px]:hidden">Kod</TableHead><TableHead scope="col">Taslak</TableHead><TableHead scope="col">Tür</TableHead><TableHead scope="col">Sürüm</TableHead>
              <TableHead scope="col" className="max-[1279px]:hidden">Güncelleme</TableHead><TableHead scope="col" className="text-right">Kullanım</TableHead><TableHead scope="col"><span className="sr-only">Eylemler</span></TableHead>
            </TableRow></TableHeader>
            <TableBody>
              {items.map((t) => (
                <TableRow key={t.id}>
                  <TableCell className="tabular whitespace-nowrap max-[1279px]:hidden">{t.code}</TableCell>
                  {/* Persona K4: 1280 px altında kod adın altında (Kod sütunu gizlenir; bilgi kaybolmaz, eylemler kesilmez). */}
                  <TableCell className="min-w-[200px] max-[1279px]:min-w-[160px]">{t.name}
                    <div className="tabular hidden text-sm text-ink-subtle max-[1279px]:block"><span className="sr-only">Kod: </span>{t.code}</div><Versions t={t} onError={(e) => setMsg({ tone: 'danger', text: e })} /></TableCell>
                  <TableCell className="whitespace-nowrap">{CONTRACT_TYPES[t.contractType]}</TableCell>
                  <TableCell className="tabular">{t.currentVersion ? `v${t.currentVersion.versionNo}` : '—'}
                    {/* Persona K4: 1280 px altında güncelleme tarihi sürümün altında (sütun sayısı azalır, "Yeni sürüm" kesilmez). */}
                    {t.currentVersion && <div className="hidden whitespace-nowrap text-sm text-ink-subtle max-[1279px]:block"><span className="sr-only">Güncelleme: </span>{fmtDate(t.currentVersion.uploadedAt)}</div>}</TableCell>
                  <TableCell className="tabular whitespace-nowrap max-[1279px]:hidden">{t.currentVersion ? fmtDate(t.currentVersion.uploadedAt) : '—'}</TableCell>
                  <TableCell className="tabular text-right">{t.usageCount}</TableCell>
                  <TableCell><RowActions t={t} canUse={canUse} canManage={canManage} stack onPick={(f) => pick(f, t.id)} onError={(e) => setMsg({ tone: 'danger', text: e })} /></TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table></div>
        </>
      )}
      {canManage && <DropZone onFile={(f) => pick(f)} />}
      <p className="mt-4 text-sm text-ink-muted">Eski sürümler silinmez; yeni sürüm yüklenince önceki sürüm geçersiz olur ve o sürümle eklenmiş sözleşmeler aynı sürüme bağlı kalır. Kullanım sayısı görebildiğiniz sözleşmelerden hesaplanır.
        {admin && <> Tedarikçi anket şablonları yerinde: <Link to="/tedarikciler/anketler">Tedarikçiler &gt; Anketler</Link>.</>}</p>
      {admin && hasRole(me, 'ADMIN') && <ReminderSettings />}
    </div>
  );
}

function FilePick({ label, onPick, primary, small }: { label: string; onPick: (f: File | undefined) => void; primary?: boolean; small?: boolean }) {
  const ref = useRef<HTMLInputElement>(null);
  return <>
    <input ref={ref} type="file" accept=".docx,application/vnd.openxmlformats-officedocument.wordprocessingml.document" className="sr-only" tabIndex={-1} aria-hidden="true"
      onChange={(e) => { onPick(e.target.files?.[0]); e.target.value = ''; }} />
    <Button variant={primary ? 'default' : 'outline'} size={small ? 'sm' : 'default'} onClick={() => ref.current?.click()}><Icon name="upload" />{label}</Button>
  </>;
}

function RowActions({ t, canUse, canManage, stack, onPick, onError }: { t: Template; canUse: boolean; canManage: boolean; stack?: boolean; onPick: (f: File | undefined) => void; onError: (e: string) => void }) {
  const v = t.currentVersion;
  return (
    <div className={cn('flex flex-wrap gap-2', stack && 'max-[1279px]:flex-col max-[1279px]:items-start')}>
      {v && <Button size="sm" variant="outline" aria-label={`${t.code} indir`} onClick={() => void downloadBlob(`/api/v1/contract-template-versions/${v.id}/download`, v.filename).catch((e) => onError((e as ApiError).message))}><Icon name="download" />İndir</Button>}
      {v && canUse && <Button size="sm" variant="outline" asChild><Link to={`/sozlesmeler/ekle?sablon=${v.id}`} aria-label={`${t.code} ile yeni sözleşme`}>Yeni sözleşmede kullan</Link></Button>}
      {canManage && <FilePick label="Yeni sürüm" small onPick={onPick} />}
    </div>
  );
}

function Versions({ t, onError }: { t: Template; onError: (e: string) => void }) {
  const old = t.versions.filter((v) => v.supersededAt);
  if (!old.length) return null;
  return (
    <details className="mt-1 text-sm">
      <summary className="cursor-pointer text-ink-muted">Önceki sürümler ({old.length})</summary>
      <ul className="mt-1 grid gap-1">{old.map((v: TemplateVersion) => (
        <li key={v.id} className="flex flex-wrap items-center gap-x-2 text-ink-muted">
          <span className="tabular">v{v.versionNo}</span><span>geçersiz · {fmtDate(v.supersededAt)}</span><span>{v.usageCount} kullanım</span>
          <button type="button" className="underline" onClick={() => void downloadBlob(`/api/v1/contract-template-versions/${v.id}/download`, v.filename).catch((e) => onError((e as ApiError).message))}>İndir</button>
        </li>))}</ul>
    </details>
  );
}

function DropZone({ onFile }: { onFile: (f: File | undefined) => void }) {
  const [over, setOver] = useState(false);
  return (
    <div onDragOver={(e) => { e.preventDefault(); setOver(true); }} onDragLeave={() => setOver(false)}
      onDrop={(e) => { e.preventDefault(); setOver(false); onFile(e.dataTransfer.files?.[0]); }}
      className={cn('mt-5 grid place-items-center rounded-md border border-dashed px-4 py-8 text-center text-ink-muted', over ? 'border-ink bg-sunken' : 'border-input bg-surface')}>
      <p className="flex items-center gap-2"><Icon name="upload" />Yeni şablon ya da yeni sürüm için .docx dosyasını buraya bırakın</p>
    </div>
  );
}

function UploadForm({ file, templateId, templates, onCancel, onDone }: { file: File; templateId: string; templates: Template[]; onCancel: () => void; onDone: (msg: string) => Promise<void> }) {
  const [target, setTarget] = useState(templateId);
  const [f, setF] = useState({ code: '', name: file.name.replace(/\.docx$/i, ''), contractType: 'SERVICE' as ContractType, validFrom: todayLocal() });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const existing = templates.find((t) => t.id === target);
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true); setError(null);
    const fd = new FormData();
    if (existing) { fd.set('validFrom', f.validFrom); fd.set('file', file); }
    else { fd.set('code', f.code); fd.set('name', f.name); fd.set('contractType', f.contractType); fd.set('validFrom', f.validFrom); fd.set('file', file); }
    try {
      const r = await api<{ versionNo: number }>(existing ? `/api/v1/contract-templates/${existing.id}/versions` : '/api/v1/contract-templates', { method: 'POST', body: fd });
      await onDone(existing ? `${existing.code} için v${r.data.versionNo} yüklendi; önceki sürüm geçersiz oldu.` : `${f.code} şablonu yüklendi.`);
    } catch (err) { setError((err as ApiError).message); setBusy(false); }
  }
  return (
    <form className="panel mb-5" onSubmit={submit} aria-label="Şablon yükle">
      <div className="panel-head"><h2 className="flex-1">Şablon yükle</h2><span className="text-sm text-ink-subtle">{file.name} · {(file.size / 1024).toLocaleString('tr-TR', { maximumFractionDigits: 0 })} KB</span></div>
      <div className="panel-body grid grid-cols-2 gap-x-4 max-[640px]:grid-cols-1">
        <div className="col-span-full"><Field label="Ne yüklüyorsunuz?">{(p) => <select className="input" {...p} value={target} onChange={(e) => setTarget(e.target.value)}>
          <option value="">Yeni şablon</option>{templates.map((t) => <option key={t.id} value={t.id}>Yeni sürüm: {t.code} · {t.name}</option>)}</select>}</Field></div>
        {!existing && <>
          <Field label="Kod">{(p) => <input className="input tabular" required maxLength={50} {...p} value={f.code} onChange={(e) => setF({ ...f, code: e.target.value })} />}</Field>
          <Field label="Tür">{(p) => <select className="input" {...p} value={f.contractType} onChange={(e) => setF({ ...f, contractType: e.target.value as ContractType })}>
            {Object.entries(CONTRACT_TYPES).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select>}</Field>
          <div className="col-span-full"><Field label="Ad">{(p) => <input className="input" required maxLength={200} {...p} value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} />}</Field></div>
        </>}
        <Field label="Geçerlilik tarihi">{(p) => <input className="input" type="date" required {...p} value={f.validFrom} onChange={(e) => setF({ ...f, validFrom: e.target.value })} />}</Field>
        {existing && <p className="col-span-full mb-3 text-sm text-ink-muted">Güncel sürüm v{existing.currentVersion?.versionNo ?? '—'} geçersiz olur; silinmez.</p>}
        {error && <div className="col-span-full"><Banner tone="danger" title={error} /></div>}
        <div className="col-span-full flex gap-2"><Button type="submit" disabled={busy}>{busy ? 'Yükleniyor…' : 'Yükle'}</Button><Button type="button" variant="outline" onClick={onCancel}>Vazgeç</Button></div>
      </div>
    </form>
  );
}

/** R7: hatırlatıcı süreleri (Yönetici). Değişiklik yalnız bundan sonra kurulacak hatırlatıcıları etkiler. */
function ReminderSettings() {
  const r = useResource<{ offsets: number[]; defaults: number[]; isDefault: boolean; updatedAt: string | null; updatedBy: { displayName: string } | null; note: string }>('/api/v1/settings/contract-reminders');
  const [text, setText] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ tone: 'info' | 'danger'; text: string } | null>(null);
  if (r.loading && !r.data) return <Loading rows={2} />;
  if (r.error || !r.data) return <ErrorState error={r.error} onRetry={r.reload} />;
  const d = r.data;
  const value = text ?? d.offsets.join(', ');
  const parsed = value.split(/[,\s]+/).filter(Boolean).map(Number);
  const valid = parsed.length >= 1 && parsed.length <= 6 && parsed.every((n) => Number.isInteger(n) && n >= 1 && n <= 365) && new Set(parsed).size === parsed.length;
  async function save() {
    setBusy(true); setMsg(null);
    try { await api('/api/v1/settings/contract-reminders', { method: 'PUT', json: { offsets: parsed } }); setText(null); await r.reload(); setMsg({ tone: 'info', text: 'Hatırlatıcı süreleri kaydedildi.' }); }
    catch (e) { setMsg({ tone: 'danger', text: (e as ApiError).message }); } finally { setBusy(false); }
  }
  return (
    <section className="panel mt-6 max-w-[720px]" aria-labelledby="rem-h">
      <div className="panel-head"><h2 id="rem-h">Sözleşme hatırlatıcı süreleri</h2></div>
      <div className="panel-body grid gap-2">
        <p className="text-ink-muted">Bitişten kaç gün önce hatırlatılacağı. Varsayılan {d.defaults.join(', ')} gün.{d.updatedAt ? ` Son değişiklik: ${d.updatedBy?.displayName ?? 'Sistem'} · ${fmtDateTime(d.updatedAt)}.` : ''}</p>
        <Field label="Süreler (gün)" hint="Virgülle ayırın; 1–6 değer, her biri 1–365, tekrarsız." error={!valid ? 'Geçerli süreler girin.' : null}>
          {(p) => <input className="input tabular max-w-[320px]" {...p} value={value} onChange={(e) => setText(e.target.value)} />}</Field>
        <p className="text-sm text-ink-muted">{d.note}</p>
        {msg && <Banner tone={msg.tone} title={msg.text} />}
        <Button className="justify-self-start" disabled={busy || !valid || text === null} onClick={() => void save()}>Kaydet</Button>
      </div>
    </section>
  );
}
