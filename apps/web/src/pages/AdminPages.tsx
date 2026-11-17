import { lazy, useCallback, useEffect, useReducer, useRef, useState, type ReactNode } from 'react';
import { Link, Navigate, Outlet, useSearchParams } from 'react-router-dom';
import { api, ApiError } from '../lib/api.ts';
import { hasRole, useSession, type Me } from '../lib/session.tsx';
import { roleLabel } from '../lib/labels.ts';
import { useResource } from '../lib/useApi.ts';
import { Banner, Empty, ErrorState, Field, Loading, PageHeader } from '../ui/kit.tsx';
import { SectionTabs } from '../ui/SectionTabs.tsx';
import { Button } from '@/components/ui/button';
import { ApproversPage } from './ApproversPage.tsx';
import { TemplatesPage } from './TemplatesPage.tsx';
import { RiskQuestionsAdmin } from './RiskQuestionsAdmin.tsx';
import { RulesPage } from './RulesPage.tsx';
import { cn } from '@/lib/utils';
import { ConnectionCard, DirectoryUsersCard, EntraDepartmentList, useDirectorySync, type AdminDepartment, type DirectoryConnection } from './DirectoryAdmin.tsx';

// v2 Faz 1 (D93): Yönetim merkezi. Sekme sırası onaylı Figma ekranlarıyla aynı. Sonraki fazların sekmeleri yalnız hangi fazda
// geleceğini söyleyen boş durumdur; sahte denetim (düğme, form) yoktur. Denetçi yalnız okunur sekmeleri görür.

const ErpReconciliationPage = lazy(() => import('./GovernancePages.tsx').then((m) => ({ default: m.ErpReconciliationPage })));

type TabKey = 'kullanicilar' | 'onaycilar' | 'sablonlar' | 'satinalma-kurallari' | 'tedarikci-basvurusu' | 'entegrasyonlar' | 'e-posta-kutusu' | 'yapay-zeka' | 'denetim-izi';
const TABS: { key: TabKey; label: string; roles: string[] }[] = [
  // v2 Faz 2 (D105): Denetçi dizini (directory.read) ve onaycıları (approver.read) salt okunur görür.
  { key: 'kullanicilar', label: 'Kullanıcılar ve Entra', roles: ['ADMIN', 'PROCUREMENT', 'AUDITOR'] },
  { key: 'onaycilar', label: 'Onaycılar', roles: ['ADMIN', 'PROCUREMENT', 'AUDITOR'] },
  { key: 'sablonlar', label: 'Şablonlar', roles: ['ADMIN', 'PROCUREMENT'] },
  // v2 Faz 7 (D112, R6): kural kataloğu; Yönetici düzenler, Satınalma ve Denetçi salt okur (rule.read).
  { key: 'satinalma-kurallari', label: 'Satınalma kuralları', roles: ['ADMIN', 'PROCUREMENT', 'AUDITOR'] },
  // v2 Faz 5 (D110, R3): başvuru ayarları (okuma Yönetici + Satınalma, yazma Yönetici).
  { key: 'tedarikci-basvurusu', label: 'Tedarikçi başvurusu', roles: ['ADMIN', 'PROCUREMENT'] },
  { key: 'entegrasyonlar', label: 'Entegrasyonlar', roles: ['ADMIN', 'PROCUREMENT', 'AUDITOR'] },
  // v2 Faz 5 (D110, R7): e-posta kutusu yalnız Yönetici (email.outbox.read).
  { key: 'e-posta-kutusu', label: 'E-posta kutusu', roles: ['ADMIN'] },
  { key: 'yapay-zeka', label: 'Yapay zekâ', roles: ['ADMIN', 'PROCUREMENT', 'AUDITOR'] },
  { key: 'denetim-izi', label: 'Denetim izi', roles: ['ADMIN', 'PROCUREMENT', 'AUDITOR'] },
];
export const adminTabs = (me: Me | null) => TABS.filter((t) => hasRole(me, ...t.roles));

/** Yönetim kabuğu: rolün görebildiği sekmeler + seçili sekmenin içeriği. */
export function AdminLayout() {
  const { me } = useSession();
  const tabs = adminTabs(me);
  if (!tabs.length) return (
    <div className="page">
      <PageHeader title="Yönetim" />
      <div className="rounded-md border border-border bg-surface">
        <Empty icon="lock" title="Yönetim bölümü rolünüze açık değil">Yönetim sekmelerini Yönetici, Satınalma ve Denetçi rolleri görür. <Link to="/islerim">İşlerim'e dön</Link></Empty>
      </div>
    </div>
  );
  return (
    <div className="flex min-h-full flex-col">
      <SectionTabs label="Yönetim sekmeleri" tabs={tabs.map((t) => ({ to: `/yonetim/${t.key}`, label: t.label }))} />
      <Outlet />
    </div>
  );
}

/** `/yonetim` ve bilinmeyen alt adres: rolün ilk sekmesi. */
export function AdminIndex() {
  const { me } = useSession();
  const first = adminTabs(me)[0];
  return first ? <Navigate to={`/yonetim/${first.key}`} replace /> : null;
}

/** Rolün göremediği sekmenin adresi ilk görünen sekmeye döner (yetkisiz ekran çizilmez). */
export function AdminTab({ tab, children }: { tab: TabKey; children: ReactNode }) {
  const { me } = useSession();
  return adminTabs(me).some((t) => t.key === tab) ? <>{children}</> : <AdminIndex />;
}

function Planned({ title, heading, children }: { title: string; heading: string; children: ReactNode }) {
  return (
    <div className="page">
      <PageHeader title={title} />
      <div className="rounded-md border border-border bg-surface">
        <Empty icon="clock" title={heading}>{children}</Empty>
      </div>
    </div>
  );
}

/** v2 Faz 2 (D105): onaycı ataması (Figma 21). Faz 1'deki "Faz 2'de gelir" boş durumu yerine gerçek ekran. */
export const ApproversTab = () => <ApproversPage />;

/** v2 Faz 3 (R8, Figma 12): Faz 1'deki "Faz 3'te gelir" boş durumu yerine şablon kütüphanesi (Sözleşmeler > Şablonlar ile aynı sayfa) ve
 * Yöneticiye hatırlatıcı süreleri. Tedarikçi anket şablonları yerinde: Tedarikçiler > Anketler. */
export function TemplatesTab() {
  // v2 Faz 6 (D111): Şablonlar içinde ikinci sekme "Risk soruları" (`?sekme=risk-sorulari`); varsayılan sözleşme taslakları aynen.
  const [params] = useSearchParams();
  const risk = params.get('sekme') === 'risk-sorulari';
  const item = (active: boolean) => cn('-mb-px flex min-h-10 items-center whitespace-nowrap border-b-2 font-semibold no-underline transition-colors duration-150',
    active ? 'border-ink text-ink' : 'border-transparent text-ink-muted hover:text-ink');
  return <>
    <nav aria-label="Şablon türleri" className="px-8 pt-3 max-[900px]:px-4">
      <ul className="flex gap-6 overflow-x-auto border-b border-border">
        <li className="shrink-0"><Link to="/yonetim/sablonlar" aria-current={!risk ? 'page' : undefined} className={item(!risk)}>Sözleşme taslakları</Link></li>
        <li className="shrink-0"><Link to="/yonetim/sablonlar?sekme=risk-sorulari" aria-current={risk ? 'page' : undefined} className={item(risk)}>Risk soruları</Link></li>
      </ul>
    </nav>
    {risk ? <RiskQuestionsAdmin /> : <TemplatesPage admin />}
  </>;
}

/** v2 Faz 7 (D112, Figma 19): Faz 1'deki "Faz 7'de gelir" boş durumu yerine sürümlü satınalma kuralı seti. */
export const RulesTab = () => <RulesPage />;

/** Entegrasyonlar: ERP mutabakatı (Satınalma yürütür, Denetçi okur). Yönetici rolünün bu uca yetkisi yok; açıklama görür. */
export function IntegrationsTab() {
  const { me } = useSession();
  if (hasRole(me, 'PROCUREMENT', 'AUDITOR')) return <ErpReconciliationPage />;
  return (
    <Planned title="Entegrasyonlar" heading="ERP mutabakatı Satınalma ve Denetçi rollerine açık">
      Fatura aktarımlarının ERP mutabakatını Satınalma yürütür, Denetçi okur. Oracle ERP ve Entra bağlantı ayarları sonraki fazlarda bu sekmeye gelir.
    </Planned>
  );
}

interface Department { id: string; name: string }
interface Member { userId: string; displayName: string; email: string; roles: string[]; departmentIds: string[] }

/**
 * v2 Faz 2 (D105): eşitleme, rol ataması ya da birleştirme sonrası veriyi yeniden yükler; bileşen yeniden kurulmaz, kaydedilmemiş
 * düzenleme (departman onay kutuları, kayıt seçimi) korunur. İlk çizimde çalışmaz.
 */
function useRefresh(signal: number, reload: () => Promise<void>) {
  const first = useRef(signal);
  useEffect(() => { if (signal !== first.current) void reload(); }, [signal, reload]);
}

/** Yalnız Departman kullanıcısı departmana bağlıdır; Yönetici, Satınalma ve Denetçi bütün departmanları görür. */
const departmentBound = (roles: string[]) => roles.length > 0 && roles.every((r) => r === 'DEPARTMENT_USER');

/** Bir kullanıcının satırı: rol adı, Departman kullanıcısı için departman seçimi (onay kutuları) ve kaydet. */
function MemberItem({ m, deps, onSaved }: { m: Member; deps: Department[]; onSaved: () => Promise<void> }) {
  // v2 Faz 2 (D105): liste yeniden kurulmadan yenilenir (eşitleme, rol, birleştirme) ve departmanlar ile üyelikler ayrı yanıtlarla, her
  // sırada gelebilir. Bu yüzden yerel kopya yalnız kullanıcı düzenlediğinde tutulur: düzenlenmemiş satır her çizimde güncel sunucu
  // değerinden türetilir; düzenleme korunur. Her iki durumda listede olmayan (birleştirilmiş) departman seçimde yoktur ve gönderilmez.
  const known = new Set(deps.map((d) => d.id));
  const key = (ids: string[]) => [...ids].sort().join();
  const server = m.departmentIds.filter((id) => known.has(id));
  const [local, setLocal] = useState<string[] | null>(null);
  const sel = local ? local.filter((id) => known.has(id)) : server;
  const change = (next: string[]) => setLocal(key(next) === key(server) ? null : next);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ tone: 'info' | 'danger'; text: string } | null>(null);
  const editable = departmentBound(m.roles);
  const dirty = local !== null && key(sel) !== key(server);
  const roles = [...new Set(m.roles.map((r) => roleLabel[r] ?? 'Rol tanımsız'))].join(', ');
  async function save() {
    setBusy(true); setMsg(null);
    try {
      await api(`/api/v1/memberships/${m.userId}/departments`, { method: 'PUT', json: { departmentIds: sel } });
      await onSaved();
      setLocal(null);
      // K7: "Kaydediliyor…" ile başarı mesajı aynı anda görünmesin; mesaj liste yenilendikten sonra.
      setMsg({ tone: 'info', text: 'Departmanlar kaydedildi.' });
    } catch (err) { setMsg({ tone: 'danger', text: err instanceof ApiError ? err.message : 'Departmanlar kaydedilemedi.' }); }
    finally { setBusy(false); }
  }
  return (
    <li className="grid gap-2 border-b border-border py-3 last:border-0">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5">
        <span className="font-semibold">{m.displayName}</span>
        <span className="text-sm text-ink-muted">{roles}</span>
        <span className="min-w-0 break-all text-sm text-ink-subtle">{m.email}</span>
      </div>
      {editable ? (
        <fieldset className="grid gap-2">
          <legend className="sr-only">{m.displayName} departmanları</legend>
          <div className="flex flex-wrap gap-x-5 gap-y-2">
            {deps.map((d) => (
              <label key={d.id} className="inline-flex min-h-8 items-center gap-2">
                <input type="checkbox" className="size-4 accent-ink" checked={sel.includes(d.id)} disabled={busy}
                  onChange={(e) => change(e.target.checked ? [...sel, d.id] : sel.filter((x) => x !== d.id))} />{d.name}
              </label>
            ))}
          </div>
          {!sel.length && <p className="text-sm text-warn">Departman seçilmedi: kullanıcı departmanlı kayıtları göremez.</p>}
          <div className="flex flex-wrap items-center gap-3">
            <Button size="sm" variant="outline" disabled={busy || !dirty} onClick={() => void save()} aria-label={`${m.displayName} departmanlarını kaydet`}>{busy ? 'Kaydediliyor…' : 'Kaydet'}</Button>
            <span aria-live="polite" className={msg?.tone === 'danger' ? 'text-sm text-danger' : 'text-sm text-ink-muted'}>{msg?.text}</span>
          </div>
        </fieldset>
      ) : <span className="text-sm text-ink-muted">Tüm departmanlar{m.departmentIds.length ? ` · üyelikte kayıtlı: ${m.departmentIds.map((id) => deps.find((d) => d.id === id)?.name).filter(Boolean).join(', ')}` : ''}</span>}
    </li>
  );
}

/** Yönetici görünümü: iç kullanıcılar, rolleri ve departman ataması (GET /memberships, PUT /memberships/:id/departments). */
function MembersAdmin({ deps, refresh = 0 }: { deps: Department[]; refresh?: number }) {
  const r = useResource<{ items: Member[] }>('/api/v1/memberships');
  useRefresh(refresh, r.reload);
  if (r.loading && !r.data) return <Loading rows={4} />;
  if (r.error || !r.data) return <ErrorState error={r.error} onRetry={r.reload} />;
  if (!r.data.items.length) return <p className="text-ink-muted">Kullanıcı yok.</p>;
  return <ul className="grid">{r.data.items.map((m) => <MemberItem key={m.userId} m={m} deps={deps} onSaved={r.reload} />)}</ul>;
}

/** Yönetici dışındaki roller (Satınalma): Yönetici listesiyle aynı kapsam (tedarikçi kullanıcıları yok), salt okunur adlar ve roller. */
function MembersReadOnly({ refresh = 0 }: { refresh?: number }) {
  const members = useResource<{ id: string; displayName: string; roles?: string[] }[]>('/api/v1/members');
  useRefresh(refresh, members.reload);
  if (members.loading && !members.data) return <Loading rows={4} />;
  if (members.error) return <ErrorState error={members.error} onRetry={members.reload} />;
  if (!members.data?.length) return <p className="text-ink-muted">Kullanıcı yok.</p>;
  return <ul className="grid gap-1">{members.data.map((u) => (
    <li key={u.id} className="flex flex-wrap items-baseline gap-x-3 border-b border-border py-1.5 last:border-0">
      <span>{u.displayName}</span>
      {!!u.roles?.length && <span className="text-sm text-ink-muted">{[...new Set(u.roles.map((r) => roleLabel[r] ?? 'Rol tanımsız'))].join(', ')}</span>}
    </li>))}</ul>;
}

// --- Departmansız kayıtlar (düzeltme dalgası C1, D96) ------------------------------------------------------------------

type AssignKind = 'project' | 'contract_family' | 'supplier_assessment';
interface UnassignedRow { id: string; code?: string | null; title?: string; companyName?: string | null; supplierName?: string | null; templateName?: string; scope?: string }
interface Unassigned { projects: UnassignedRow[]; contracts: UnassignedRow[]; assessments: UnassignedRow[]; companyScopeEmpty: boolean }

const KIND_TEXT: Record<AssignKind, { heading: string; noun: string }> = {
  project: { heading: 'Projeler', noun: 'proje' },
  contract_family: { heading: 'Sözleşmeler', noun: 'sözleşme' },
  supplier_assessment: { heading: 'Tedarikçi değerlendirmeleri', noun: 'değerlendirme' },
};

function rowText(kind: AssignKind, r: UnassignedRow) {
  if (kind === 'supplier_assessment') return { main: `${r.supplierName ?? 'Tedarikçi'} · ${r.templateName ?? ''}`, sub: r.scope ?? '' };
  return { main: [r.code, r.title].filter(Boolean).join(' · '), sub: [r.companyName, r.supplierName].filter(Boolean).join(' · ') };
}

/** Bir kayıt türünün departmansız satırları: onay kutuları, departman seçimi ve "Departman ata" (tekli ya da toplu). */
function AssignGroup({ kind, rows, deps, onDone }: { kind: AssignKind; rows: UnassignedRow[]; deps: Department[]; onDone: () => Promise<void> }) {
  const [sel, setSel] = useState<string[]>([]);
  const [dep, setDep] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ tone: 'info' | 'danger'; text: string } | null>(null);
  const t = KIND_TEXT[kind];
  const selectId = `assign-${kind}`;
  // Liste yeniden yüklenince (başka sekmede atanan) artık görünmeyen kayıtlar seçimden düşer; görünenlerin seçimi korunur.
  useEffect(() => { setSel((s) => { const n = s.filter((id) => rows.some((r) => r.id === id)); return n.length === s.length ? s : n; }); }, [rows]);
  // Seçili hedef departman listeden düştüyse (birleştirildi) seçim boşalır; eski kimlik gönderilmez.
  useEffect(() => { if (dep && !deps.some((d) => d.id === dep)) setDep(''); }, [deps, dep]);
  const all = rows.length > 0 && sel.length === rows.length;
  async function save() {
    if (!sel.length || !dep || busy) return;
    setBusy(true); setMsg(null);
    try {
      const r = await api<{ updated: number }>('/api/v1/department-assignments', { method: 'PUT', json: { entityType: kind, ids: sel, departmentId: dep } });
      setMsg({ tone: 'info', text: `${r.data.updated} ${t.noun} ${deps.find((d) => d.id === dep)?.name ?? ''} departmanına atandı.` });
      setSel([]);
      await onDone();
    } catch (err) { setMsg({ tone: 'danger', text: err instanceof ApiError ? err.message : 'Departman atanamadı.' }); }
    finally { setBusy(false); }
  }
  return (
    <section className="grid gap-2 border-t border-border pt-3 first:border-0 first:pt-0" aria-labelledby={`${selectId}-h`}>
      <h3 id={`${selectId}-h`} className="text-[15px] font-semibold">{t.heading} <span className="font-normal text-ink-muted">({rows.length})</span></h3>
      {!rows.length ? <p className="text-sm text-ink-muted">Departmansız {t.noun} yok.</p> : <>
        <label className="inline-flex min-h-8 items-center gap-2 text-sm">
          <input type="checkbox" className="size-4 accent-ink" checked={all} disabled={busy} onChange={(e) => setSel(e.target.checked ? rows.map((r) => r.id) : [])} />
          Tümünü seç
        </label>
        <ul className="grid max-h-72 overflow-y-auto rounded-md border border-border">
          {rows.map((r) => {
            const x = rowText(kind, r);
            return (
              <li key={r.id} className="border-b border-border px-3 py-1.5 last:border-0">
                <label className="flex min-h-8 items-start gap-2">
                  <input type="checkbox" className="mt-1 size-4 shrink-0 accent-ink" checked={sel.includes(r.id)} disabled={busy}
                    onChange={(e) => setSel(e.target.checked ? [...sel, r.id] : sel.filter((y) => y !== r.id))} />
                  <span className="min-w-0"><span className="block break-words">{x.main}</span>{x.sub && <span className="block break-words text-sm text-ink-muted">{x.sub}</span>}</span>
                </label>
              </li>
            );
          })}
        </ul>
        <div className="flex flex-wrap items-end gap-3">
          <label className="grid gap-1 text-sm" htmlFor={selectId}>
            <span>Departman</span>
            <select id={selectId} className="input min-w-48" value={dep} disabled={busy} onChange={(e) => setDep(e.target.value)}>
              <option value="">Seçin</option>
              {deps.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
            </select>
          </label>
          <Button disabled={busy || !sel.length || !dep} onClick={() => void save()}>{busy ? 'Atanıyor…' : `Departman ata (${sel.length})`}</Button>
        </div>
      </>}
      <div aria-live="polite">{msg && <p className={msg.tone === 'danger' ? 'text-sm text-danger' : 'text-sm text-ink-muted'}>{msg.text}</p>}</div>
    </section>
  );
}

/** Departmanı atanmamış eski kayıtlar (Yönetici ve Satınalma). Atanana kadar bu kayıtları Departman kullanıcıları göremez. */
function UnassignedRecords({ deps, refresh = 0 }: { deps: Department[]; refresh?: number }) {
  const r = useResource<Unassigned>('/api/v1/department-assignments/unassigned');
  useRefresh(refresh, r.reload);
  if (r.loading && !r.data) return <Loading rows={4} />;
  if (r.error || !r.data) return <ErrorState error={r.error} onRetry={r.reload} />;
  const d = r.data;
  const empty = !d.projects.length && !d.contracts.length && !d.assessments.length;
  return (
    <div className="grid gap-4">
      {d.companyScopeEmpty && (
        <Banner tone="info" title="Şirket kapsamınız yok">
          Kurumda tanımlı şirket olmadığı için departmansız proje ve sözleşme listelenmez. Tedarikçi değerlendirmeleri şirkete bağlı olmadığından aşağıda görünür.
        </Banner>
      )}
      {empty && !d.companyScopeEmpty ? <p className="text-ink-muted">Departmanı atanmamış kayıt yok.</p> : <>
        {!d.companyScopeEmpty && <AssignGroup kind="project" rows={d.projects} deps={deps} onDone={r.reload} />}
        {!d.companyScopeEmpty && <AssignGroup kind="contract_family" rows={d.contracts} deps={deps} onDone={r.reload} />}
        <AssignGroup kind="supplier_assessment" rows={d.assessments} deps={deps} onDone={r.reload} />
      </>}
    </div>
  );
}

/**
 * Kullanıcılar ve Entra. Faz 1 bölümleri (departman listesi + Yönetici için departman ekleme, kullanıcıların departman ataması,
 * Departmansız kayıtlar) her durumda aynen kalır. v2 Faz 2 (D105, Figma 20): dizin sağlayıcısı yapılandırılmışsa ve rol dizini
 * okuyabiliyorsa (Yönetici, Denetçi) "Bağlantı ve kapsam", "Eşitlenen kullanıcılar" ve departman sayıları/birleştirme eklenir;
 * sağlayıcı yoksa Faz 1 düzeni ve "Entra bağlantısı yapılandırılmadı" açıklaması.
 */
export function UsersTab() {
  const { me } = useSession();
  const admin = hasRole(me, 'ADMIN');
  const canAssign = hasRole(me, 'ADMIN', 'PROCUREMENT'); // department.assign: Departmansız kayıtlar
  const canDirectory = hasRole(me, 'ADMIN', 'AUDITOR'); // directory.read
  const conn = useResource<DirectoryConnection>(canDirectory ? '/api/v1/directory/connection' : null);
  const deps = useResource<{ items: AdminDepartment[] }>('/api/v1/departments');
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ tone: 'info' | 'danger'; text: string } | null>(null);
  // Eşitleme ya da rol ataması üyelikleri değiştirir: Faz 1 kullanıcı listesi ve Departmansız kayıtlar yeniden yüklenir.
  const [version, bump] = useReducer((x: number) => x + 1, 0);
  const reloadConn = conn.reload;
  const reloadDeps = deps.reload;
  const refreshAll = useCallback(async () => { bump(); await Promise.all([reloadConn(), reloadDeps()]); }, [reloadConn, reloadDeps]);
  const sync = useDirectorySync(() => { void refreshAll(); });
  const provider = conn.data?.provider ?? null;
  const entra = !!provider;
  // Sayfa açıldığında süren eşitleme varsa izlenir.
  const openRun = conn.data?.lastRun && (conn.data.lastRun.status === 'QUEUED' || conn.data.lastRun.status === 'RUNNING') ? conn.data.lastRun.id : null;
  const watch = sync.watch;
  useEffect(() => { if (openRun && sync.state.phase === 'idle') void watch(openRun); }, [openRun, sync.state.phase, watch]);

  async function create(e: React.FormEvent) {
    e.preventDefault();
    const n = name.trim();
    if (!n || busy) return;
    setBusy(true); setMsg(null);
    try {
      await api('/api/v1/departments', { method: 'POST', json: { name: n } });
      setMsg({ tone: 'info', text: `${n} departmanı eklendi.` }); setName(''); await deps.reload();
    } catch (err) { setMsg({ tone: 'danger', text: err instanceof ApiError ? err.message : 'Departman eklenemedi.' }); }
    finally { setBusy(false); }
  }

  if (canDirectory && conn.loading && !conn.data) return <div className="page"><PageHeader title="Kullanıcılar ve Entra" /><Loading rows={6} /></div>;

  const depItems = deps.data?.items ?? [];
  const syncing = sync.state.phase === 'starting' || sync.state.phase === 'running';
  const canSync = !!conn.data?.enabled && !!conn.data.scope;
  const description = entra
    ? "Kullanıcılar ve departmanlar Microsoft Entra ID'den alınır; yalnız seçilen kapsam eşitlenir."
    : canDirectory
      ? 'Departmanlar ve kurumdaki kullanıcılar. Entra bağlantısı yapılandırılmadı; kullanıcılar davetle eklenir. Departmanlar ve atamalar burada yapılır.'
      : 'Departmanlar ve kurumdaki kullanıcılar. Kullanıcıları, rollerini ve Entra eşitlemesini Yönetici yönetir; departmanlar ve atamalar burada görünür.';

  const departmentsPanel = (
    <section className="panel">
      <div className="panel-head"><h2>Departmanlar</h2></div>
      <div className="panel-body grid gap-4">
        {deps.loading && !deps.data ? <Loading rows={3} /> : deps.error ? <ErrorState error={deps.error} onRetry={deps.reload} />
          : !depItems.length ? <p className="text-ink-muted">Henüz departman tanımlı değil.</p>
          : entra ? <EntraDepartmentList deps={depItems} admin={admin} onMerged={async (text) => { setMsg({ tone: 'info', text }); await refreshAll(); }} />
          : <ul className="grid gap-1">{depItems.map((d) => <li key={d.id} className="border-b border-border py-1.5 last:border-0">{d.name}</li>)}</ul>}
        {admin && (
          <form onSubmit={create} className="grid gap-1 border-t border-border pt-4">
            <Field label="Departman adı" hint={entra
              ? "Kurum içinde benzersiz olmalı. Buradan eklenen departman Entra dışı departman olarak görünür; Entra'dan gelen departmanlar eşitlemeyle eklenir."
              : 'Kurum içinde benzersiz olmalı. Kayıtlar (proje, sözleşme, fatura) departmana göre görünür.'}>
              {(p) => <input className="input" {...p} value={name} maxLength={200} onChange={(e) => setName(e.target.value)} />}
            </Field>
            <div><Button type="submit" disabled={busy || !name.trim()}>{busy ? 'Ekleniyor…' : 'Departman ekle'}</Button></div>
          </form>
        )}
        <div aria-live="polite">{msg && <Banner tone={msg.tone} icon={msg.tone === 'info' ? 'check' : undefined} title={msg.text} />}</div>
      </div>
    </section>
  );

  const membersPanel = (
    <section className="panel">
      <div className="panel-head"><h2>Kullanıcılar</h2></div>
      <div className="panel-body grid gap-3">
        {admin ? <>
          <p className="text-sm text-ink-muted">Departman kullanıcısı yalnız atandığı departmanların kayıtlarını görür. Yönetici, Satınalma ve Denetçi bütün departmanları görür. Tedarikçi kullanıcıları bu listede yer almaz.</p>
          {deps.data ? <MembersAdmin refresh={version} deps={deps.data.items} /> : deps.error ? null : <Loading rows={4} />}
        </> : <>
          <p className="text-sm text-ink-muted">Kullanıcıların departman atamasını Yönetici değiştirir. Departman kullanıcısı yalnız atandığı departmanların kayıtlarını görür; Yönetici, Satınalma ve Denetçi bütün departmanları görür. Tedarikçi kullanıcıları bu listede yer almaz.</p>
          <MembersReadOnly refresh={version} />
        </>}
      </div>
    </section>
  );

  return (
    <div className="page">
      <PageHeader title="Kullanıcılar ve Entra"
        actions={admin && entra && (
          <div className="grid justify-items-end gap-1">
            <Button disabled={syncing || !canSync} onClick={() => void sync.start()}>{syncing ? 'Eşitleniyor…' : 'Şimdi eşitle'}</Button>
            {!canSync && <span className="text-xs text-ink-muted">Önce kapsamı kaydedip eşitlemeyi açın.</span>}
          </div>
        )}>
        {description}
      </PageHeader>
      {canDirectory && !!conn.error && <Banner tone="danger" title="Entra bağlantı bilgisi alınamadı">{conn.error instanceof ApiError ? conn.error.message : 'Yeniden deneyin.'}</Banner>}
      {entra && conn.data ? <>
        <div className="grid items-start gap-5 min-[1100px]:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
          <ConnectionCard conn={conn.data} admin={admin} sync={sync.state} onSaved={async () => { await conn.reload(); }} />
          {departmentsPanel}
        </div>
        <div className="mt-5"><DirectoryUsersCard admin={admin} deps={depItems} version={version} onChanged={refreshAll} /></div>
        <div className="mt-5">{membersPanel}</div>
      </> : (
        <div className="grid items-start gap-5 min-[1100px]:grid-cols-[minmax(0,1fr)_minmax(0,2fr)]">
          {departmentsPanel}
          {membersPanel}
        </div>
      )}
      {canAssign && (
        <section className="panel mt-5" aria-labelledby="unassigned-h">
          <div className="panel-head"><h2 id="unassigned-h">Departmansız kayıtlar</h2></div>
          <div className="panel-body grid gap-3">
            <p className="text-sm text-ink-muted">Departmanı atanmamış eski kayıtları Departman kullanıcıları göremez. Kayıtları seçip departman atayın; kaydın görevleri de aynı departmana geçer, sözleşmeye bağlı faturalar departmanı sözleşmeden alır. Her atama denetim izine yazılır.</p>
            {deps.data ? <UnassignedRecords refresh={version} deps={deps.data.items} /> : deps.error ? null : <Loading rows={3} />}
          </div>
        </section>
      )}
    </div>
  );
}
