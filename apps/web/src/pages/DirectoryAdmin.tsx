import { useCallback, useEffect, useId, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { api, ApiError } from '../lib/api.ts';
import type { Label } from '../lib/labels.ts';
import { useResource } from '../lib/useApi.ts';
import { Banner, ErrorState, Loading, Modal, Tag } from '../ui/kit.tsx';
import { Icon } from '../ui/icons.tsx';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

// v2 Faz 2 (D105) Görev 6: Yönetim > Kullanıcılar ve Entra ekranının Entra bölümleri (Figma 20). Faz 1 bölümleri (üye departman
// düzenleyici, departman ekleme, Departmansız kayıtlar) AdminPages.tsx'te kalır; bu dosya yalnız eklenen bölümleri taşır.
// Test dizini sağlayıcısı gerçek Entra gibi gösterilmez: bağlantı kartında ve eşitleme durumunda her zaman etiketlenir.

export type ScopeType = 'GROUP' | 'ADMIN_UNIT' | 'OU_FILTER';
export interface DirectoryProviderView { kind: 'graph' | 'test'; label: string; tenantLabel: string; configured: boolean }
export interface RunView {
  id: string; status: 'QUEUED' | 'RUNNING' | 'SUCCEEDED' | 'FAILED'; trigger: string; providerKind: string; fetched: number; created: number; updated: number;
  suspended: number; reactivated: number; warnings: number; errorCode: string | null; errorMessage: string | null; createdAt: string;
  startedAt: string | null; finishedAt: string | null;
}
export interface DirectoryConnection { provider: DirectoryProviderView | null; scope: { type: ScopeType; value: string } | null; enabled: boolean; lastRun: RunView | null }
export interface AdminDepartment { id: string; name: string; source?: 'MANUAL' | 'ENTRA'; userCount?: number }
type DirUserStatus = 'ACTIVE' | 'SUSPENDED' | 'NO_MEMBERSHIP' | 'DISABLED';
interface DirUser { id: string; displayName: string; email: string | null; departmentName: string | null; departmentId: string | null; roles: string[] | null; status: DirUserStatus; jobTitle: string | null }

export const TEST_DIRECTORY_LABEL = 'Test dizini (gerçek Entra değil)';
const SCOPE_TYPES: { value: ScopeType; label: string; hint: string }[] = [
  { value: 'GROUP', label: 'Güvenlik grubu', hint: 'Güvenlik grubunun nesne kimliği (Object ID). İç içe gruplardaki üyeler de alınır.' },
  { value: 'ADMIN_UNIT', label: 'Yönetim birimi', hint: 'Yönetim biriminin (administrative unit) nesne kimliği.' },
  { value: 'OU_FILTER', label: 'OU filtresi', hint: 'Şirket içi dizinden eşitlenen kullanıcıların OU yolu; bu yolun altındaki kullanıcılar alınır.' },
];
/** Rol ataması ekranından verilebilen roller (API ASSIGNABLE_ROLES; tedarikçi rolü verilmez). */
const ROLE_OPTIONS: [string, string][] = [['ADMIN', 'Yönetici'], ['PROCUREMENT', 'Satınalma'], ['DEPARTMENT_USER', 'Departman kullanıcısı'], ['AUDITOR', 'Denetçi (salt okunur)']];
const roleText = (roles: string[]) => ROLE_OPTIONS.filter(([r]) => roles.includes(r)).map(([, l]) => l).join(', ');

const dateTime = new Intl.DateTimeFormat('tr-TR', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Istanbul' });
/** Figma biçimi: 16.11.2026 06:00. */
export const fmtStamp = (v: string | null | undefined) => (v ? dateTime.format(new Date(v)).replace(',', '') : '—');
const count = (n: number) => new Intl.NumberFormat('tr-TR').format(n);

/** Test dizini etiketi: yalnız test sağlayıcısında, her zaman görünür. */
export function TestDirectoryTag({ provider }: { provider: DirectoryProviderView | null }) {
  if (provider?.kind !== 'test') return null;
  return <Tag label={{ text: TEST_DIRECTORY_LABEL, tone: 'warn', icon: 'alert' }} title="Kullanıcılar sentetik bir test dosyasından okunur; Microsoft Entra ID'ye bağlanılmaz." />;
}

// --- Eşitleme: başlat, çalıştırmayı izle (GET /directory/runs, 2 sn arayla, en çok ~60 sn) ----------------------------------

export type SyncState =
  | { phase: 'idle' }
  | { phase: 'starting' }
  | { phase: 'running'; run: RunView | null }
  | { phase: 'done'; run: RunView }
  | { phase: 'failed'; run: RunView }
  | { phase: 'timeout'; runId: string }
  | { phase: 'error'; message: string };

const POLL_MS = 2000;
const POLL_LIMIT = 30;

export function useDirectorySync(onFinished: () => void) {
  const [state, setState] = useState<SyncState>({ phase: 'idle' });
  const watching = useRef<string | null>(null);
  const finished = useRef(onFinished);
  finished.current = onFinished;
  useEffect(() => () => { watching.current = null; }, []);

  const watch = useCallback(async (runId: string) => {
    if (watching.current === runId) return;
    watching.current = runId;
    setState({ phase: 'running', run: null });
    for (let i = 0; i < POLL_LIMIT; i++) {
      if (i > 0) await new Promise((r) => setTimeout(r, POLL_MS));
      if (watching.current !== runId) return;
      let run: RunView | undefined;
      try { run = (await api<{ items: RunView[] }>('/api/v1/directory/runs')).data.items.find((r) => r.id === runId); }
      catch (e) { if (watching.current === runId) { watching.current = null; setState({ phase: 'error', message: e instanceof ApiError ? e.message : 'Eşitleme durumu okunamadı.' }); } return; }
      if (watching.current !== runId) return;
      if (run?.status === 'SUCCEEDED' || run?.status === 'FAILED') {
        watching.current = null;
        setState(run.status === 'SUCCEEDED' ? { phase: 'done', run } : { phase: 'failed', run });
        finished.current();
        return;
      }
      setState({ phase: 'running', run: run ?? null });
    }
    if (watching.current === runId) { watching.current = null; setState({ phase: 'timeout', runId }); }
  }, []);

  const start = useCallback(async () => {
    setState({ phase: 'starting' });
    try {
      const r = await api<{ runId: string }>('/api/v1/directory/sync', { method: 'POST', json: {} });
      void watch(r.data.runId);
    } catch (e) {
      // Sürmekte olan eşitleme varsa onu izle (409 sync_running, ayrıntıda runId).
      if (e instanceof ApiError && e.code === 'sync_running' && typeof e.details?.runId === 'string') { void watch(e.details.runId); return; }
      setState({ phase: 'error', message: e instanceof ApiError ? e.message : 'Eşitleme başlatılamadı.' });
    }
  }, [watch]);
  return { state, start, watch };
}

/** Eşitleme durumu satırı (Figma: "Son eşitleme 16.11.2026 06:00 · 38 kullanıcı."); test dizininde etiket yanında. */
export function SyncStatus({ conn, sync }: { conn: DirectoryConnection; sync: SyncState }) {
  const scopeNote = 'Kapsam dışındaki Entra kullanıcıları alınmaz.';
  let body: ReactNode;
  const runSummary = (r: RunView) => {
    const parts = [`${count(r.created)} yeni`, `${count(r.updated)} güncellendi`, `${count(r.suspended)} askıya alındı`, `${count(r.reactivated)} yeniden açıldı`];
    return `${parts.join(', ')}${r.warnings ? ` · ${count(r.warnings)} uyarı (denetim izinde)` : ''}.`;
  };
  if (sync.phase === 'starting' || sync.phase === 'running') {
    body = <span className="inline-flex items-center gap-2"><Icon name="refresh" className="animate-spin motion-reduce:animate-none" />
      {sync.phase === 'running' && sync.run?.status === 'RUNNING' ? 'Eşitleme sürüyor…' : 'Eşitleme sıraya alındı…'}</span>;
  } else if (sync.phase === 'done') {
    body = <span><strong className="font-semibold">Eşitleme tamamlandı.</strong> {fmtStamp(sync.run.finishedAt)} · {count(sync.run.fetched)} kullanıcı alındı: {runSummary(sync.run)} {scopeNote}</span>;
  } else if (sync.phase === 'failed') {
    body = <span className="text-danger"><strong className="font-semibold">Eşitleme başarısız.</strong> {sync.run.errorMessage ?? 'Neden bildirilmedi.'} Hiçbir üyelik değiştirilmedi.</span>;
  } else if (sync.phase === 'timeout') {
    body = <span>Eşitleme hâlâ sürüyor; sonucu birkaç dakika sonra bu sayfayı yenileyerek görebilirsiniz.</span>;
  } else if (sync.phase === 'error') {
    body = <span className="text-danger">{sync.message}</span>;
  } else {
    const r = conn.lastRun;
    if (!r) body = <span>Henüz eşitleme yapılmadı. {scopeNote}</span>;
    else if (r.status === 'SUCCEEDED') body = <span>Son eşitleme {fmtStamp(r.finishedAt)} · {count(r.fetched)} kullanıcı.{r.warnings ? ` ${count(r.warnings)} uyarı (denetim izinde).` : ''} {scopeNote}</span>;
    else if (r.status === 'FAILED') body = <span className="text-danger">Son eşitleme denemesi {fmtStamp(r.finishedAt ?? r.createdAt)} başarısız: {r.errorMessage ?? 'neden bildirilmedi.'} Hiçbir üyelik değiştirilmedi.</span>;
    else body = <span>Eşitleme sürüyor (başlangıç {fmtStamp(r.startedAt ?? r.createdAt)}).</span>;
  }
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 text-sm text-ink-muted" aria-live="polite" data-testid="sync-status">
      <TestDirectoryTag provider={conn.provider} />
      {body}
    </div>
  );
}

// --- Bağlantı ve kapsam -----------------------------------------------------------------------------------------------------

/** Kapsam türü: üç seçenekli bölümlü denetim (radyo grubu). */
function ScopeTypeControl({ value, onChange, disabled }: { value: ScopeType; onChange: (v: ScopeType) => void; disabled: boolean }) {
  const name = useId();
  return (
    <fieldset className="grid gap-1.5">
      <legend className="mb-1.5 text-sm font-semibold">Kapsam türü</legend>
      <div className="inline-flex w-fit max-w-full flex-wrap rounded-md border border-input bg-white p-0.5">
        {SCOPE_TYPES.map((t) => (
          <label key={t.value} className={cn('inline-flex min-h-8 cursor-pointer items-center rounded-[5px] px-3 text-sm font-semibold text-ink-muted transition-colors duration-150',
            'has-[:checked]:bg-ink has-[:checked]:text-primary-foreground has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-[var(--focus)]',
            disabled && 'cursor-not-allowed opacity-70')}>
            <input type="radio" className="sr-only" name={name} value={t.value} checked={value === t.value} disabled={disabled} onChange={() => onChange(t.value)} />
            {t.label}
          </label>
        ))}
      </div>
    </fieldset>
  );
}

export function ConnectionCard({ conn, admin, sync, onSaved }: { conn: DirectoryConnection; admin: boolean; sync: SyncState; onSaved: () => Promise<void> }) {
  const provider = conn.provider!;
  const [type, setType] = useState<ScopeType>(conn.scope?.type ?? 'GROUP');
  const [value, setValue] = useState(conn.scope?.value ?? '');
  const [enabled, setEnabled] = useState(conn.scope ? conn.enabled : true);
  const [busy, setBusy] = useState<'save' | 'test' | null>(null);
  const [msg, setMsg] = useState<{ tone: 'info' | 'danger'; text: string } | null>(null);
  const [tested, setTested] = useState<{ ok: true } | { ok: false; message: string } | null>(null);
  const dirty = type !== (conn.scope?.type ?? 'GROUP') || value.trim() !== (conn.scope?.value ?? '') || enabled !== (conn.scope ? conn.enabled : true);
  const typeInfo = SCOPE_TYPES.find((t) => t.value === type)!;
  const valueId = useId();

  async function save(e: FormEvent) {
    e.preventDefault();
    if (busy) return;
    setBusy('save'); setMsg(null);
    try {
      await api('/api/v1/directory/connection', { method: 'PUT', json: { scopeType: type, scopeValue: value.trim(), enabled } });
      setValue(value.trim());
      await onSaved();
      setMsg({ tone: 'info', text: 'Kapsam kaydedildi.' });
    } catch (err) { setMsg({ tone: 'danger', text: err instanceof ApiError ? err.message : 'Kapsam kaydedilemedi.' }); }
    finally { setBusy(null); }
  }
  async function test() {
    setBusy('test'); setTested(null);
    try {
      const r = await api<{ ok: boolean; message?: string }>('/api/v1/directory/connection/test', { method: 'POST', json: {} });
      setTested(r.data.ok ? { ok: true } : { ok: false, message: r.data.message ?? 'Bağlantı denenemedi.' });
    } catch (err) { setTested({ ok: false, message: err instanceof ApiError ? err.message : 'Bağlantı denenemedi.' }); }
    finally { setBusy(null); }
  }

  return (
    <section className="panel" aria-labelledby="dir-conn-h">
      <div className="panel-head">
        <h2 id="dir-conn-h">Bağlantı ve kapsam</h2>
        <TestDirectoryTag provider={provider} />
        {tested?.ok && <Tag label={{ text: provider.kind === 'test' ? 'Bağlantı doğrulandı (test dizini)' : 'Bağlantı doğrulandı', tone: 'ok', icon: 'check' }} />}
      </div>
      <form className="panel-body grid gap-4" onSubmit={save}>
        <div className="grid gap-4 min-[900px]:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
          <div className="grid content-start gap-1">
            <span className="text-sm font-semibold">Kiracı</span>
            <span className="mono break-all">{provider.tenantLabel}</span>
            <span className="text-sm text-ink-subtle">{provider.label}</span>
          </div>
          {admin ? <ScopeTypeControl value={type} onChange={setType} disabled={!!busy} /> : (
            <div className="grid content-start gap-1"><span className="text-sm font-semibold">Kapsam türü</span>
              <span>{SCOPE_TYPES.find((t) => t.value === conn.scope?.type)?.label ?? <span className="text-ink-muted">Tanımlanmadı</span>}</span></div>
          )}
        </div>
        {admin ? (
          <div className="field mb-0">
            <label htmlFor={valueId}>Kapsam</label>
            <input id={valueId} className={cn('input', type !== 'OU_FILTER' && 'mono')} value={value} maxLength={500} disabled={!!busy}
              aria-describedby={`${valueId}-hint`} onChange={(e) => setValue(e.target.value)} />
            <span id={`${valueId}-hint`} className="hint">{typeInfo.hint}</span>
          </div>
        ) : (
          <div className="grid gap-1"><span className="text-sm font-semibold">Kapsam</span>
            <span className="mono break-all">{conn.scope?.value || <span className="text-ink-muted">Tanımlanmadı</span>}</span></div>
        )}
        <div className="grid gap-1 rounded-md border border-border bg-sunken px-3 py-2 text-sm">
          <span className="font-semibold">OU filtresi örneği</span>
          <span className="mono break-all text-ink-muted">OU=Satinalma,OU=Kullanicilar,DC=moment</span>
        </div>
        {admin ? (
          <label className="inline-flex min-h-8 items-start gap-2 text-sm">
            <input type="checkbox" className="mt-0.5 size-4 accent-ink" checked={enabled} disabled={!!busy} onChange={(e) => setEnabled(e.target.checked)} />
            <span>Eşitleme açık: her gün 06:00'dan sonra ve "Şimdi eşitle" ile kapsamdaki kullanıcılar alınır.</span>
          </label>
        ) : <p className="text-sm text-ink-muted">{conn.enabled ? 'Eşitleme açık: her gün 06:00\'dan sonra çalışır.' : 'Eşitleme kapalı.'}</p>}
        {admin && (
          <div className="flex flex-wrap items-center gap-3">
            <Button type="submit" variant="outline" disabled={!!busy || !dirty || !value.trim()}>{busy === 'save' ? 'Kaydediliyor…' : 'Kapsamı kaydet'}</Button>
            <Button type="button" variant="outline" disabled={!!busy} onClick={() => void test()}>{busy === 'test' ? 'Sınanıyor…' : 'Bağlantıyı sına'}</Button>
            <span aria-live="polite" className={msg?.tone === 'danger' ? 'text-sm text-danger' : 'text-sm text-ink-muted'}>{msg?.text}</span>
          </div>
        )}
        {tested && !tested.ok && <Banner tone="danger" title="Bağlantı doğrulanamadı">{tested.message}</Banner>}
        <div className="border-t border-border pt-3"><SyncStatus conn={conn} sync={sync} /></div>
      </form>
    </section>
  );
}

// --- Eşitlenen kullanıcılar -------------------------------------------------------------------------------------------------

const STATUS: Record<DirUserStatus, Label | null> = {
  ACTIVE: { text: 'Etkin', tone: 'info', icon: 'check' },
  SUSPENDED: { text: 'Askıda', tone: 'warn', icon: 'clock', hint: 'Üyelik askıda; kullanıcı oturum açamaz.' },
  DISABLED: { text: "Entra'da kapalı ya da kapsam dışı", tone: 'danger', icon: 'x' },
  NO_MEMBERSHIP: null,
};

function RoleCell({ u, admin, onSaved }: { u: DirUser; admin: boolean; onSaved: () => Promise<void> }) {
  const [open, setOpen] = useState(false);
  const [sel, setSel] = useState<string[]>(u.roles ?? []);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ tone: 'info' | 'danger'; text: string } | null>(null);
  const current = u.roles ?? [];
  const dirty = [...sel].sort().join() !== [...current].sort().join();
  async function save() {
    setBusy(true); setMsg(null);
    try {
      await api(`/api/v1/directory/users/${u.id}/roles`, { method: 'PUT', json: { roles: sel } });
      await onSaved();
      setOpen(false);
      setMsg({ tone: 'info', text: sel.length ? 'Roller kaydedildi.' : 'Erişim kaldırıldı.' });
    } catch (err) { setMsg({ tone: 'danger', text: err instanceof ApiError ? err.message : 'Roller kaydedilemedi.' }); }
    finally { setBusy(false); }
  }
  return (
    <div className="grid gap-1.5">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <span>{current.length ? roleText(current) : <span className="text-ink-muted">Rol yok</span>}</span>
        {admin && !open && (
          <Button size="sm" variant="ghost" className="h-7 px-2 text-sm underline-offset-2 hover:underline"
            aria-label={`${u.displayName} rolünü değiştir`} onClick={() => { setSel(current); setMsg(null); setOpen(true); }}>Değiştir</Button>
        )}
      </div>
      {open && (
        <fieldset className="grid gap-1.5 rounded-md border border-border bg-white p-2">
          <legend className="sr-only">{u.displayName} rolleri</legend>
          {ROLE_OPTIONS.map(([r, l]) => (
            <label key={r} className="inline-flex min-h-7 items-center gap-2 text-sm">
              <input type="checkbox" className="size-4 accent-ink" checked={sel.includes(r)} disabled={busy}
                onChange={(e) => setSel(e.target.checked ? [...sel, r] : sel.filter((x) => x !== r))} />{l}
            </label>
          ))}
          {!sel.length && current.length > 0 && <p className="text-sm text-warn">Rol seçilmezse kullanıcının erişimi kaldırılır.</p>}
          <div className="flex flex-wrap gap-2">
            <Button size="sm" disabled={busy || !dirty} onClick={() => void save()} aria-label={`${u.displayName} rollerini kaydet`}>{busy ? 'Kaydediliyor…' : 'Kaydet'}</Button>
            <Button size="sm" variant="outline" disabled={busy} onClick={() => { setOpen(false); setMsg(null); }}>Vazgeç</Button>
          </div>
        </fieldset>
      )}
      <span aria-live="polite" className={msg?.tone === 'danger' ? 'text-sm text-danger' : 'text-sm text-ink-muted'}>{msg?.text}</span>
    </div>
  );
}

export function DirectoryUsersCard({ admin, deps, version, onChanged }: { admin: boolean; deps: AdminDepartment[]; version: number; onChanged: () => Promise<void> }) {
  const [q, setQ] = useState('');
  const [applied, setApplied] = useState({ q: '', dep: '' });
  const params = new URLSearchParams();
  if (applied.q) params.set('q', applied.q);
  if (applied.dep) params.set('departmentId', applied.dep);
  params.set('v', String(version));
  const r = useResource<{ items: DirUser[]; truncated: boolean; limit: number }>(`/api/v1/directory/users?${params}`);
  const searchId = useId();
  const depId = useId();
  return (
    <section className="panel" aria-labelledby="dir-users-h">
      <div className="panel-head"><h2 id="dir-users-h">Eşitlenen kullanıcılar</h2>
        {r.data && <span className="text-sm text-ink-subtle tabular">{count(r.data.items.length)}{r.data.truncated ? '+' : ''} kullanıcı</span>}</div>
      <div className="panel-body grid gap-3">
        <form className="flex flex-wrap items-end gap-3" role="search" aria-label="Eşitlenen kullanıcılarda ara"
          onSubmit={(e) => { e.preventDefault(); setApplied((a) => ({ ...a, q: q.trim() })); }}>
          <label className="grid min-w-0 flex-1 basis-56 gap-1 text-sm" htmlFor={searchId}><span className="font-semibold">Ad ya da e-posta</span>
            <input id={searchId} type="search" className="input" value={q} maxLength={200} onChange={(e) => setQ(e.target.value)} /></label>
          <label className="grid min-w-0 basis-48 gap-1 text-sm" htmlFor={depId}><span className="font-semibold">Departman</span>
            <select id={depId} className="input" value={applied.dep} onChange={(e) => setApplied((a) => ({ ...a, dep: e.target.value }))}>
              <option value="">Tüm departmanlar</option>
              {deps.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
            </select></label>
          <Button type="submit" variant="outline">Ara</Button>
        </form>
        {r.loading && !r.data ? <Loading rows={4} /> : r.error || !r.data ? <ErrorState error={r.error} onRetry={r.reload} />
          : !r.data.items.length ? <p className="text-ink-muted">{applied.q || applied.dep ? 'Aramaya uyan eşitlenmiş kullanıcı yok.' : 'Henüz eşitlenen kullanıcı yok. Kapsamı kaydedip "Şimdi eşitle" ile kullanıcıları alın.'}</p>
          : <>
            <div className="table-wrap">
              <table className="data stack-narrow">
                <thead><tr><th scope="col">Ad</th><th scope="col">Departman (Entra)</th><th scope="col">Rol</th><th scope="col">Durum</th></tr></thead>
                <tbody>
                  {r.data.items.map((u) => (
                    <tr key={u.id}>
                      <td data-label="Ad"><span className="block font-semibold">{u.displayName}</span>
                        <span className="block text-sm text-ink-muted [overflow-wrap:anywhere]">{u.email ?? 'E-posta yok: rol verilemez'}</span>
                        {u.jobTitle && <span className="block text-sm text-ink-subtle">{u.jobTitle}</span>}</td>
                      <td data-label="Departman (Entra)">{u.departmentName ?? <span className="text-ink-muted">Entra'da departman yok</span>}</td>
                      <td data-label="Rol"><RoleCell u={u} admin={admin} onSaved={onChanged} /></td>
                      <td data-label="Durum">{STATUS[u.status] ? <Tag label={STATUS[u.status]!} /> : <span className="text-sm text-ink-muted">Rol verilmedi</span>}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {r.data.truncated && <p className="text-sm text-warn">İlk {count(r.data.limit)} kullanıcı gösteriliyor; aramayı ya da departman süzgecini daraltın.</p>}
          </>}
        <p className="text-sm text-ink-muted">Rol verilen kullanıcı ilk Entra girişinde uygulamaya bağlanır. Tedarikçi portalı kullanıcıları bu ekrandan yönetilmez.</p>
      </div>
    </section>
  );
}

// --- Departmanlar: kullanıcı sayısı, kaynak etiketi ve birleştirme (R6, R7) --------------------------------------------------

function MergeDialog({ source, deps, onClose, onMerged }: { source: AdminDepartment; deps: AdminDepartment[]; onClose: () => void; onMerged: (text: string) => Promise<void> }) {
  const [into, setInto] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const targetId = useId();
  const target = deps.find((d) => d.id === into);
  async function merge() {
    if (!into || busy) return;
    setBusy(true); setError(null);
    try {
      await api(`/api/v1/departments/${source.id}/merge`, { method: 'POST', json: { intoId: into, confirm: true } });
      await onMerged(`${source.name} departmanı ${target?.name ?? ''} departmanına birleştirildi.`);
      onClose();
    } catch (err) { setError(err instanceof ApiError ? err.message : 'Departmanlar birleştirilemedi.'); setBusy(false); }
  }
  return (
    <Modal title={`${source.name} departmanını birleştir`} onClose={() => { if (!busy) onClose(); }}
      footer={<>
        <Button variant="outline" disabled={busy} onClick={onClose}>Vazgeç</Button>
        <Button variant="outline" className="border-danger/40 text-danger hover:bg-danger-soft" disabled={busy || !into} onClick={() => void merge()}>
          {busy ? 'Birleştiriliyor…' : 'Birleştir'}</Button>
      </>}>
      <div className="grid gap-3">
        <Banner tone="warn" title="Bu işlem geri alınamaz">
          {source.name} departmanının bütün kayıtları (proje, sözleşme, fatura, değerlendirme, görev), kullanıcı atamaları ve departman sorumlusu ataması seçtiğiniz
          departmana taşınır; {source.name} listeden kalkar. Entra'daki adı hedef departmanın takma adı olur.
        </Banner>
        <label className="grid gap-1 text-sm" htmlFor={targetId}><span className="font-semibold">Hedef departman</span>
          <select id={targetId} className="input" value={into} disabled={busy} onChange={(e) => setInto(e.target.value)}>
            <option value="">Seçin</option>
            {deps.filter((d) => d.id !== source.id).map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
          </select></label>
        {error && <p role="alert" className="text-sm text-danger">{error}</p>}
      </div>
    </Modal>
  );
}

/** Entra bağlıyken departman listesi: "Bilgi Teknolojileri · 9", kaynak etiketi (Entra dışı departman) ve Yönetici için birleştirme. */
export function EntraDepartmentList({ deps, admin, onMerged }: { deps: AdminDepartment[]; admin: boolean; onMerged: (text: string) => Promise<void> }) {
  const [merging, setMerging] = useState<AdminDepartment | null>(null);
  return (
    <>
      <ul className="grid gap-1">
        {deps.map((d) => (
          <li key={d.id} className="flex flex-wrap items-center gap-x-2 gap-y-1 border-b border-border py-1.5 last:border-0">
            <span className="min-w-0 break-words">{d.name}{d.userCount !== undefined && <span className="tabular text-ink-muted"> · {count(d.userCount)}</span>}</span>
            {d.userCount !== undefined && <span className="sr-only"> kullanıcı</span>}
            {d.source === 'MANUAL' && <span className="text-sm text-ink-subtle">Entra dışı departman</span>}
            {admin && deps.length > 1 && (
              <Button size="sm" variant="ghost" className="ml-auto h-7 px-2 text-sm" aria-label={`${d.name} departmanını birleştir`} onClick={() => setMerging(d)}>Birleştir</Button>
            )}
          </li>
        ))}
      </ul>
      <p className="text-sm text-ink-muted">Entra'dan gelen departmanlar kullanıcıların department alanından türetilir; Entra dışı departmanı yalnız Yönetici ekler. Sayı, departmana atanmış etkin kullanıcıları gösterir.</p>
      {merging && <MergeDialog source={merging} deps={deps} onClose={() => setMerging(null)} onMerged={onMerged} />}
    </>
  );
}
