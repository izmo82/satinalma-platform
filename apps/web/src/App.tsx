import { Link, NavLink, Navigate, Outlet, Route, Routes, useLocation, useNavigate, useParams } from 'react-router-dom';
import { lazy, Suspense, useEffect, useRef } from 'react';
import { hasRole, useSession } from './lib/session.tsx';
import { roleLabel } from './lib/labels.ts';
import { Icon } from './ui/icons.tsx';
import { Loading, useOnline } from './ui/kit.tsx';
import { useResource } from './lib/useApi.ts';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { LoginPage, OidcCallback } from './pages/LoginPage.tsx';
import { isCallback } from './lib/oidc.ts';
import { WorkPage } from './pages/WorkPage.tsx';
import { SuppliersPage } from './pages/SuppliersPage.tsx';
import { SupplierDetailPage } from './pages/SupplierDetailPage.tsx';
import { IntakePage } from './pages/IntakePage.tsx';
import { ContractsPage } from './pages/ContractsPage.tsx';
import { NotYetPage, RemovedPage } from './pages/NotYetPage.tsx';
import { AdminIndex, AdminLayout, AdminTab, adminTabs, ApproversTab, IntegrationsTab, RulesTab, TemplatesTab as ContractTemplatesTab, UsersTab } from './pages/AdminPages.tsx';
import { SectionTabs } from './ui/SectionTabs.tsx';
import { TemplatesPage as ContractTemplatesPage } from './pages/TemplatesPage.tsx';
import { ProjectsPage } from './pages/ProjectsPage.tsx';
import { ProjectWizard } from './pages/ProjectWizard.tsx';
import { ProjectWorkspace } from './pages/ProjectWorkspace.tsx';
import { PortalAssessment, PortalAssessments, PortalHome, PortalRoundRoute } from './pages/PortalPages.tsx';
import { PortalBids, PortalDocuments, PortalProfile, PortalStanding } from './pages/PortalV2Pages.tsx';
import { PublicApplication } from './pages/PublicApplication.tsx';
import { GlobalSearch, NotificationBell } from './ui/TopBar.tsx';

// PDF görüntüleyici içeren ağır ekranlar ayrı paket olarak yüklenir.
const DocumentPage = lazy(() => import('./pages/DocumentPage.tsx').then((m) => ({ default: m.DocumentPage })));
const ContractPage = lazy(() => import('./pages/ContractLifecycle.tsx').then((m) => ({ default: m.ContractPage })));
const contractV2 = () => import('./pages/ContractOverview.tsx');
const ContractRedirect = lazy(() => contractV2().then((m) => ({ default: m.ContractRedirect })));
const ContractWizard = lazy(() => import('./pages/ContractWizard.tsx').then((m) => ({ default: m.ContractWizard })));
const purchasing = () => import('./pages/PurchasingPages.tsx');
const InvoicesPage = lazy(() => purchasing().then((m) => ({ default: m.InvoicesPage })));
const InvoicePage = lazy(() => purchasing().then((m) => ({ default: m.InvoicePage })));
const SearchPage = lazy(() => import('./pages/SearchPage.tsx').then((m) => ({ default: m.SearchPage })));
const evaluation = () => import('./pages/EvaluationPages.tsx');
const AssessmentPage = lazy(() => evaluation().then((m) => ({ default: m.AssessmentPage })));
const IncidentPage = lazy(() => evaluation().then((m) => ({ default: m.IncidentPage })));
const IncidentsPage = lazy(() => evaluation().then((m) => ({ default: m.IncidentsPage })));
const TemplatesPage = lazy(() => evaluation().then((m) => ({ default: m.TemplatesPage })));
const PerformanceWeightsPage = lazy(() => evaluation().then((m) => ({ default: m.PerformanceWeightsPage })));
const ReportsPage = lazy(() => evaluation().then((m) => ({ default: m.ReportsPage })));
const AiPage = lazy(() => evaluation().then((m) => ({ default: m.AiPage })));
const SupplierApplicationReview = lazy(() => import('./pages/SupplierApplicationReview.tsx').then((m) => ({ default: m.SupplierApplicationReview })));
const SupplierApplicationSettings = lazy(() => import('./pages/SupplierApplicationSettings.tsx').then((m) => ({ default: m.SupplierApplicationSettings })));
const EmailOutboxPage = lazy(() => import('./pages/EmailOutboxPage.tsx').then((m) => ({ default: m.EmailOutboxPage })));
const AuditPage = lazy(() => import('./pages/AuditPage.tsx').then((m) => ({ default: m.AuditPage })));
// v2 Faz 6 (D111): yıllık risk matrisi, değerlendirme formu ve Excel içe aktarımı.
const risk = () => import('./pages/RiskPages.tsx');
const RiskMatrixPage = lazy(() => risk().then((m) => ({ default: m.RiskMatrixPage })));
const RiskAssessmentPage = lazy(() => risk().then((m) => ({ default: m.RiskAssessmentPage })));
const RiskImportPage = lazy(() => risk().then((m) => ({ default: m.RiskImportPage })));

/** Adresin ilk bölümü kendi listesi olmayan detaylar: kiracı değişince dönülecek liste. */
const LIST_OF: Record<string, string> = { belgeler: '/sozlesmeler/ekle', degerlendirmeler: '/tedarikciler' };
/** Alt adresi olan liste sayfaları (sekmeler, yükleme ekranları): kiracı değişince adres korunur. */
const KEEP = new Set(['/tedarikciler/olaylar', '/tedarikciler/anketler', '/tedarikciler/performans-agirliklari', '/tedarikciler/risk', '/tedarikciler/risk/ice-aktar', '/sozlesmeler/ekle', '/sozlesmeler/sablonlar', '/faturalar/yukle']);
/** Kiracı değişince gidilecek liste; null = adres kalır. */
function listOf(path: string): string | null {
  if (KEEP.has(path) || path.startsWith('/yonetim/')) return null;
  if (path.startsWith('/tedarikciler/olaylar/')) return '/tedarikciler/olaylar';
  if (path.startsWith('/tedarikciler/risk/')) return '/tedarikciler/risk';
  const section = path.split('/')[1];
  if (!section || path === `/${section}`) return null;
  return LIST_OF[section] ?? `/${section}`;
}

/** v2 (D93): taşınan giriş; eski adres (yer imi, bildirim) sorgusuyla birlikte yeni yere kalıcı yönlenir. */
function Moved({ to }: { to: (p: Record<string, string | undefined>) => string }) {
  const params = useParams();
  const { search } = useLocation();
  const target = to(params);
  // Hedefin kendi sorgusu varsa eski sorgu ona eklenir (v2 Faz 8: `?bolum=mutabakat`).
  return <Navigate to={`${target}${search && target.includes('?') ? `&${search.slice(1)}` : search}`} replace />;
}

/** Veri yönetimi kalktı (saklama, hukuki saklama, imha); dışa aktarım sekmesi Yönetim > Denetim izi'ne taşındı. */
function DataGovernanceRemoved() {
  const { me } = useSession();
  const { search } = useLocation();
  const exportsVisible = adminTabs(me).some((t) => t.key === 'denetim-izi');
  if (exportsVisible && new URLSearchParams(search).get('sekme') === 'disa-aktarim') return <Navigate to="/yonetim/denetim-izi" replace />;
  return <RemovedPage moved={exportsVisible ? <>Kiracı dışa aktarımı taşındı: <Link to="/yonetim/denetim-izi">Yönetim &gt; Denetim izi</Link>.</> : undefined} />;
}

/** Tedarikçiler: liste ve taşınan Olaylar, Anketler, Performans ağırlıkları alt çizgili sekme olarak; v2 Faz 6: Risk matrisi eklendi (sona). */
function SuppliersSection() {
  return (
    <div className="flex min-h-full flex-col">
      <SectionTabs label="Tedarikçiler sekmeleri" tabs={[
        { to: '/tedarikciler', label: 'Liste', end: true },
        { to: '/tedarikciler/olaylar', label: 'Olaylar' },
        { to: '/tedarikciler/anketler', label: 'Anketler' },
        { to: '/tedarikciler/performans-agirliklari', label: 'Performans ağırlıkları' },
        { to: '/tedarikciler/risk', label: 'Risk matrisi' },
      ]} />
      <Outlet />
    </div>
  );
}

export function App() {
  const { me, loading } = useSession();
  const { pathname } = useLocation();
  if (isCallback()) return <OidcCallback />;
  // v2 Faz 5 (D110, R2–R4): girişsiz başvuru yolları oturumdan bağımsız açılır (oturum varken de aynı ekran).
  if (pathname === '/basvuru' || pathname.startsWith('/basvuru/')) return <PublicApplication />;
  if (loading) return <Loading label="Oturum açılıyor" />;
  if (!me) return <LoginPage />;
  return <Shell />;
}

function Shell() {
  const { me, switchTenant, logout, logoutError } = useSession();
  const online = useOnline();
  const loc = useLocation();
  const navigate = useNavigate();
  const mainRef = useRef<HTMLElement>(null);
  // Kayıt kimlikleri kiracıya özeldir: detaydayken kiracı değişince aynı adres yeni kiracıda "bulunamadı" olur. Modülün
  // listesine (adresin ilk bölümü) dönülür; liste sayfasında adres korunur.
  // Yönlendirme önce yapılır: kiracı yüklenirken bu bileşen kalkar, sonradan çağrılan navigate işlemez.
  const changeTenant = (id: string) => {
    const list = listOf(loc.pathname);
    if (list) navigate(list, { replace: true });
    return switchTenant(id);
  };
  useEffect(() => { mainRef.current?.focus({ preventScroll: true }); }, [loc.pathname]);
  // Menüde her modülün bekleyen iş yükü; yalnız kullanıcının rolüne atanmış işler sayılır.
  // Sayılar sunucu sayımından (persona K2/K4): liste 200 ile sınırlıyken menü sayacı da 200'de kalıyordu. Liste satırı gerekmez (limit=1).
  const tasks = useResource<{ items: { entityType: string }[]; counts?: { mine: number }; mineByType?: Record<string, number> }>(
    me?.activeTenantId && !me.supplierPortal ? `/api/v1/tasks?view=mine&limit=1&t=${me.activeTenantId}` : null);
  const reloadTasks = tasks.reload;
  // Yazma işleminden sonra (onay, red, yeniden gönderim, kayıt) sayaçlar tazelenir; art arda istekler tek yüklemede birleşir.
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const onChange = () => { clearTimeout(timer); timer = setTimeout(() => void reloadTasks(), 300); };
    window.addEventListener('sp:tasks-changed', onChange);
    return () => { clearTimeout(timer); window.removeEventListener('sp:tasks-changed', onChange); };
  }, [reloadTasks]);
  const load = (types: string[] | null) => {
    const d = tasks.data;
    if (!d) return undefined;
    if (d.counts && d.mineByType) return types ? types.reduce((n, t) => n + (d.mineByType![t] ?? 0), 0) : d.counts.mine;
    return d.items.filter((t) => !types || types.includes(t.entityType)).length;
  };
  if (!me) return null;
  const nav: { to: string; label: string; icon: string; count?: number; later?: string }[] = me.supplierPortal ? [
    { to: '/portal', label: 'Teklif davetleri', icon: 'inbox' },
    // v2 Faz 5 (D110, Figma P2): Tekliflerim, Skorum ve risk durumum, Belgelerim, Firma bilgileri eklendi; mevcut iki giriş aynı yerde.
    { to: '/portal/tekliflerim', label: 'Tekliflerim', icon: 'receipt' },
    { to: '/portal/anketler', label: 'Anketler', icon: 'shield' },
    { to: '/portal/skorum', label: 'Skorum ve risk durumum', icon: 'chart' },
    { to: '/portal/belgeler', label: 'Belgelerim', icon: 'file' },
    { to: '/portal/firma', label: 'Firma bilgileri', icon: 'users' },
  ] : [
    { to: '/islerim', label: 'İşlerim', icon: 'inbox', count: load(null) },
    // v2 (D93): yedi giriş, beş rol. Taşınan girişlerin sayaçları yeni üst girişe eklenir: Olaylar → Tedarikçiler,
    // Belge girişi → Sözleşmeler, Yapay zekâ ve dışa aktarım → Yönetim. Departman kullanıcısı Raporlar (report.read) ve Yönetim'i görmez.
    ...(hasRole(me, 'ADMIN', 'PROCUREMENT', 'DEPARTMENT_USER', 'AUDITOR') ? [
      { to: '/projeler', label: 'Projeler', icon: 'folder', count: load(['project']) },
      { to: '/sozlesmeler', label: 'Sözleşmeler', icon: 'file', count: load(['contract_version', 'document_version', 'contract_family', 'contract_approval_step', 'contract_reminder', 'contract_rejection']) },
      { to: '/tedarikciler', label: 'Tedarikçiler', icon: 'users', count: load(['supplier', 'incident', 'supplier_application']) },
      { to: '/faturalar', label: 'Faturalar', icon: 'receipt', count: load(['invoice']) },
    ] : []),
    ...(hasRole(me, 'ADMIN', 'PROCUREMENT', 'AUDITOR') ? [{ to: '/raporlar', label: 'Raporlar', icon: 'chart' }] : []),
    ...(adminTabs(me).length ? [{ to: '/yonetim', label: 'Yönetim', icon: 'settings', count: load(['tenant', 'tenant_export']) }] : []),
  ];
  const companies = me.supplierPortal ? 'Tedarikçi portalı' : me.companies.length ? me.companies.map((c) => c.name).join(' · ') : 'Şirket belgesi erişimi yok';
  return (
    <div className="grid h-full grid-cols-[256px_minmax(0,1fr)] max-[900px]:grid-cols-1 max-[900px]:grid-rows-[auto_auto_1fr]">
      <a className="absolute -left-[9999px] top-2 z-50 rounded-md bg-surface px-3 py-2 focus:left-2" href="#main">Ana içeriğe geç</a>
      <aside className="flex min-h-0 flex-col border-r border-border bg-rail max-[900px]:contents">
        <div className="px-5 pt-5 pb-4 max-[900px]:flex max-[900px]:items-center max-[900px]:gap-3 max-[900px]:border-b max-[900px]:border-border max-[900px]:bg-rail max-[900px]:px-4 max-[900px]:py-2.5">
          <div className="text-md font-bold tracking-[-0.005em] max-[900px]:hidden">Satınalma ve Sözleşme</div>
          <label className="sr-only" htmlFor="tenant">Aktif kiracı</label>
          <select id="tenant" value={me.activeTenantId ?? ''} onChange={(e) => void changeTenant(e.target.value)}
            className="sp-select mt-3 w-full min-w-0 rounded-md border border-input px-2.5 py-1.5 font-semibold text-ink max-[900px]:mt-0 max-[900px]:flex-1">
            {me.memberships.map((m) => <option key={m.tenantId} value={m.tenantId}>{m.tenantName}</option>)}
          </select>
          <Button variant="outline" size="sm" onClick={logout} className="hidden max-[900px]:inline-flex">Çıkış</Button>
        </div>
        <nav aria-label="Ana menü" className="flex-1 overflow-y-auto px-3 max-[900px]:border-b max-[900px]:border-border max-[900px]:bg-rail max-[900px]:px-2 max-[900px]:py-1.5">
          <ul className="grid gap-0.5 max-[900px]:flex max-[900px]:overflow-x-auto max-[900px]:[mask-image:linear-gradient(to_right,#000_85%,transparent)] max-[900px]:pr-8">
            {nav.map((n) => (
              <li key={n.to}>
                <NavLink to={n.to} end={n.to === '/portal'} className={({ isActive }) => cn(
                  'flex min-h-9 items-center gap-3 rounded-md px-2.5 font-semibold no-underline transition-colors duration-150 max-[900px]:whitespace-nowrap',
                  isActive ? 'bg-ink text-primary-foreground' : 'text-ink-muted hover:bg-sunken hover:text-ink')}>
                  {({ isActive }) => <>
                    <Icon name={n.icon} />{n.label}
                    {n.later ? <span className={cn('ml-auto text-xs font-normal max-[900px]:hidden', isActive ? 'text-[#cfd2db]' : 'text-ink-subtle')}>{n.later}</span>
                      : n.count ? <span className={cn('tabular ml-auto text-sm', isActive ? 'text-[#e4e6ec]' : 'text-ink')} aria-label={`${n.count} bekleyen iş`}>{n.count}</span> : null}
                  </>}
                </NavLink>
              </li>
            ))}
          </ul>
        </nav>
        <div className="border-t border-border px-5 py-4 max-[900px]:hidden">
          <div className="truncate font-semibold">{me.user.displayName}</div>
          <div className="truncate text-sm text-ink-subtle">{[...new Set(me.roles.map((r) => roleLabel[r] ?? 'Rol tanımsız'))].join(', ')}</div>
          <Button variant="outline" size="sm" onClick={logout} className="mt-3"><Icon name="logout" />Çıkış</Button>
        </div>
      </aside>
      <main id="main" ref={mainRef} tabIndex={-1} className="min-w-0 overflow-auto outline-none">
        <div className="flex min-h-12 items-center gap-2 border-b py-2 border-border px-8 text-sm text-ink-muted max-[900px]:px-4" title="Erişebildiğiniz şirketler">
          <span className="whitespace-nowrap text-ink-subtle">Şirket kapsamı</span><span className="truncate font-semibold text-ink max-[640px]:whitespace-normal">{companies}</span>
          {!me.supplierPortal && <><GlobalSearch /><NotificationBell /></>}
        </div>
        {logoutError && <div className="bg-danger-soft px-4 py-2 text-sm text-ink" role="alert"><strong>Çıkış tamamlanamadı; oturumunuz hâlâ açık.</strong> {logoutError}{' '}
          <button type="button" className="underline" onClick={logout}>Tekrar dene</button></div>}
        {!online && <div className="bg-ink px-4 py-1.5 text-center text-sm text-primary-foreground" role="status"><Icon name="wifiOff" size={14} className="mr-1.5 inline" />Çevrimdışısınız. Görüntülenen veri güncel olmayabilir; kaydetme ve onay işlemleri bağlantı gelince yapılabilir.</div>}
        <Suspense fallback={<Loading label="Sayfa yükleniyor" />}>
        {/* Tedarikçi yalnız portal yollarını, iç kullanıcı yalnız iç yolları açar; öteki taraftaki adres kendi ana sayfasına döner
            (iç sayfanın iskeleti tedarikçiye hiç çizilmez). */}
        {me.supplierPortal ? <Routes>
          <Route path="/portal" element={<PortalHome />} />
          <Route path="/portal/tekliflerim" element={<PortalBids />} />
          <Route path="/portal/anketler" element={<PortalAssessments />} />
          <Route path="/portal/skorum" element={<PortalStanding />} />
          <Route path="/portal/belgeler" element={<PortalDocuments />} />
          <Route path="/portal/firma" element={<PortalProfile />} />
          <Route path="/portal/anketler/:id" element={<PortalAssessment />} />
          <Route path="/portal/:id" element={<PortalRoundRoute />} />
          <Route path="*" element={<Navigate to="/portal" replace />} />
        </Routes> : <Routes>
          <Route path="/" element={<Navigate to="/islerim" replace />} />
          <Route path="/portal/*" element={<Navigate to="/islerim" replace />} />
          <Route path="/projeler" element={<ProjectsPage />} />
          <Route path="/projeler/yeni" element={<ProjectWizard />} />
          <Route path="/projeler/:id" element={<ProjectWorkspace />} />
          <Route path="/islerim" element={<WorkPage />} />
          <Route path="/tedarikciler" element={<SuppliersSection />}>
            <Route index element={<SuppliersPage />} />
            <Route path="olaylar" element={<IncidentsPage />} />
            <Route path="anketler" element={<TemplatesPage />} />
            <Route path="performans-agirliklari" element={<PerformanceWeightsPage />} />
            <Route path="risk" element={<RiskMatrixPage />} />
          </Route>
          <Route path="/tedarikciler/risk/ice-aktar" element={<RiskImportPage />} />
          <Route path="/tedarikciler/risk/:id" element={<RiskAssessmentPage />} />
          <Route path="/tedarikciler/olaylar/:id" element={<IncidentPage />} />
          <Route path="/tedarikciler/basvurular/:id" element={<SupplierApplicationReview />} />
          <Route path="/tedarikciler/:id" element={<SupplierDetailPage />} />
          <Route path="/belgeler/:id" element={<DocumentPage />} />
          <Route path="/sozlesmeler" element={<ContractsPage />} />
          {/* v2 Faz 3 (D108): Sözleşme ekle sihirbazı; 1. adım aynı yükleme formu (teklif ve diğer türler de yüklenir). */}
          <Route path="/sozlesmeler/ekle" element={<ContractWizard />} />
          <Route path="/sozlesmeler/sablonlar" element={<ContractTemplatesPage />} />
          <Route path="/sozlesmeler/aile/:id" element={<ContractRedirect by="family" />} />
          <Route path="/sozlesmeler/onay-adimi/:id" element={<ContractRedirect by="step" />} />
          <Route path="/sozlesmeler/:id" element={<ContractPage />} />
          <Route path="/faturalar" element={<InvoicesPage />} />
          <Route path="/faturalar/yukle" element={<IntakePage key="fatura" kind="INVOICE" title="Fatura yükle" back={{ to: '/faturalar', label: 'Faturalar' }} />} />
          <Route path="/faturalar/:id" element={<InvoicePage />} />
          <Route path="/ara" element={<SearchPage />} />
          <Route path="/raporlar" element={<ReportsPage />} />
          <Route path="/degerlendirmeler/:id" element={<AssessmentPage />} />
          <Route path="/yonetim" element={<AdminLayout />}>
            <Route index element={<AdminIndex />} />
            <Route path="kullanicilar" element={<AdminTab tab="kullanicilar"><UsersTab /></AdminTab>} />
            <Route path="onaycilar" element={<AdminTab tab="onaycilar"><ApproversTab /></AdminTab>} />
            <Route path="sablonlar" element={<AdminTab tab="sablonlar"><ContractTemplatesTab /></AdminTab>} />
            <Route path="satinalma-kurallari" element={<AdminTab tab="satinalma-kurallari"><RulesTab /></AdminTab>} />
            <Route path="tedarikci-basvurusu" element={<AdminTab tab="tedarikci-basvurusu"><SupplierApplicationSettings /></AdminTab>} />
            <Route path="e-posta-kutusu" element={<AdminTab tab="e-posta-kutusu"><EmailOutboxPage /></AdminTab>} />
            <Route path="entegrasyonlar" element={<AdminTab tab="entegrasyonlar"><IntegrationsTab /></AdminTab>} />
            <Route path="yapay-zeka" element={<AdminTab tab="yapay-zeka"><AiPage /></AdminTab>} />
            <Route path="denetim-izi" element={<AdminTab tab="denetim-izi"><AuditPage /></AdminTab>} />
            <Route path="*" element={<AdminIndex />} />
          </Route>
          {/* v2 (D93): taşınan girişlerin eski adresleri kalıcı yönlenir. */}
          <Route path="/yapay-zeka" element={<Moved to={() => '/yonetim/yapay-zeka'} />} />
          {/* v2 Faz 8 (D113, R10): mutabakat Entegrasyonlar'ın ikinci bölümü; eski adres bu bölüme açılır (eski sorgu korunur). */}
          <Route path="/faturalar/erp-mutabakati" element={<Moved to={() => '/yonetim/entegrasyonlar?bolum=mutabakat'} />} />
          <Route path="/olaylar" element={<Moved to={() => '/tedarikciler/olaylar'} />} />
          <Route path="/olaylar/:id" element={<Moved to={(p) => `/tedarikciler/olaylar/${p.id}`} />} />
          <Route path="/anketler" element={<Moved to={() => '/tedarikciler/anketler'} />} />
          <Route path="/performans-agirliklari" element={<Moved to={() => '/tedarikciler/performans-agirliklari'} />} />
          <Route path="/belge-girisi" element={<Moved to={() => '/sozlesmeler/ekle'} />} />
          {/* v2 (D93) onaylı kaldırma listesi: eski adres açıklama ekranına gider; veri silinmedi. */}
          <Route path="/lira-defteri/*" element={<RemovedPage />} />
          <Route path="/siparisler/*" element={<RemovedPage />} />
          <Route path="/faturalar/tolerans" element={<RemovedPage />} />
          <Route path="/projeler/onay-politikasi" element={<RemovedPage />} />
          <Route path="/veri-yonetimi/*" element={<DataGovernanceRemoved />} />
          <Route path="*" element={<NotYetPage title="Sayfa bulunamadı" />} />
        </Routes>}
        </Suspense>
      </main>
    </div>
  );
}
