import { NavLink, Navigate, Route, Routes, useLocation } from 'react-router-dom';
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
import { NotYetPage } from './pages/NotYetPage.tsx';
import { ProjectsPage } from './pages/ProjectsPage.tsx';
import { ProjectWizard } from './pages/ProjectWizard.tsx';
import { ProjectWorkspace } from './pages/ProjectWorkspace.tsx';
import { PortalAssessment, PortalAssessments, PortalHome, PortalRound } from './pages/PortalPages.tsx';
import { GlobalSearch, NotificationBell } from './ui/TopBar.tsx';

// PDF görüntüleyici içeren ağır ekranlar ayrı paket olarak yüklenir.
const DocumentPage = lazy(() => import('./pages/DocumentPage.tsx').then((m) => ({ default: m.DocumentPage })));
const ContractPage = lazy(() => import('./pages/ContractLifecycle.tsx').then((m) => ({ default: m.ContractPage })));
const purchasing = () => import('./pages/PurchasingPages.tsx');
const PurchaseOrdersPage = lazy(() => purchasing().then((m) => ({ default: m.PurchaseOrdersPage })));
const PurchaseOrderPage = lazy(() => purchasing().then((m) => ({ default: m.PurchaseOrderPage })));
const InvoicesPage = lazy(() => purchasing().then((m) => ({ default: m.InvoicesPage })));
const InvoicePage = lazy(() => purchasing().then((m) => ({ default: m.InvoicePage })));
const SearchPage = lazy(() => import('./pages/SearchPage.tsx').then((m) => ({ default: m.SearchPage })));
const ApprovalPolicyPage = lazy(() => import('./pages/ApprovalPolicyPage.tsx').then((m) => ({ default: m.ApprovalPolicyPage })));
const ToleranceRulesPage = lazy(() => purchasing().then((m) => ({ default: m.ToleranceRulesPage })));
const evaluation = () => import('./pages/EvaluationPages.tsx');
const AssessmentPage = lazy(() => evaluation().then((m) => ({ default: m.AssessmentPage })));
const IncidentPage = lazy(() => evaluation().then((m) => ({ default: m.IncidentPage })));
const IncidentsPage = lazy(() => evaluation().then((m) => ({ default: m.IncidentsPage })));
const TemplatesPage = lazy(() => evaluation().then((m) => ({ default: m.TemplatesPage })));
const PerformanceWeightsPage = lazy(() => evaluation().then((m) => ({ default: m.PerformanceWeightsPage })));
const ReportsPage = lazy(() => evaluation().then((m) => ({ default: m.ReportsPage })));
const AiPage = lazy(() => evaluation().then((m) => ({ default: m.AiPage })));
const governance = () => import('./pages/GovernancePages.tsx');
const DataGovernancePage = lazy(() => governance().then((m) => ({ default: m.DataGovernancePage })));
const DisposalBatchPage = lazy(() => governance().then((m) => ({ default: m.DisposalBatchPage })));
const ErpReconciliationPage = lazy(() => governance().then((m) => ({ default: m.ErpReconciliationPage })));

export function App() {
  const { me, loading } = useSession();
  if (isCallback()) return <OidcCallback />;
  if (loading) return <Loading label="Oturum açılıyor" />;
  if (!me) return <LoginPage />;
  return <Shell />;
}

function Shell() {
  const { me, switchTenant, logout, logoutError } = useSession();
  const online = useOnline();
  const loc = useLocation();
  const mainRef = useRef<HTMLElement>(null);
  useEffect(() => { mainRef.current?.focus({ preventScroll: true }); }, [loc.pathname]);
  // Menüde her modülün bekleyen iş yükü; yalnız kullanıcının rolüne atanmış işler sayılır.
  const tasks = useResource<{ items: { entityType: string }[] }>(me?.activeTenantId && !me.supplierPortal ? `/api/v1/tasks?view=mine&t=${me.activeTenantId}` : null);
  const load = (types: string[] | null) => tasks.data ? tasks.data.items.filter((t) => !types || types.includes(t.entityType)).length : undefined;
  if (!me) return null;
  const nav: { to: string; label: string; icon: string; count?: number; later?: string }[] = me.supplierPortal ? [
    { to: '/portal', label: 'Teklif davetleri', icon: 'inbox' },
    { to: '/portal/anketler', label: 'Anketler', icon: 'shield' },
  ] : [
    { to: '/islerim', label: 'İşlerim', icon: 'inbox', count: load(null) },
    { to: '/projeler', label: 'Projeler', icon: 'folder', count: load(['project']) },
    { to: '/tedarikciler', label: 'Tedarikçiler', icon: 'users', count: load(['supplier']) },
    { to: '/sozlesmeler', label: 'Sözleşmeler', icon: 'file', count: load(['contract_version']) },
    { to: '/belge-girisi', label: 'Belge girişi', icon: 'upload', count: load(['document_version']) },
    { to: '/siparisler', label: 'Siparişler', icon: 'package' },
    { to: '/faturalar', label: 'Faturalar', icon: 'receipt', count: load(['invoice']) },
    { to: '/olaylar', label: 'Olaylar', icon: 'alert', count: load(['incident']) },
    ...(hasRole(me, 'BUYER', 'PROCUREMENT_MANAGER', 'FINANCE', 'AUDITOR') ? [{ to: '/raporlar', label: 'Raporlar', icon: 'chart' }] : []),
    ...(hasRole(me, 'TENANT_ADMIN', 'AUDITOR', 'PROCUREMENT_MANAGER') ? [{ to: '/yapay-zeka', label: 'Yapay zekâ', icon: 'sparkles', count: load(['tenant']) }] : []),
    ...(hasRole(me, 'LEGAL', 'TENANT_ADMIN', 'AUDITOR') ? [{ to: '/veri-yonetimi', label: 'Veri yönetimi', icon: 'archive', count: load(['disposal_batch', 'tenant_export']) }] : []),
  ];
  const companies = me.supplierPortal ? 'Tedarikçi portalı' : me.companies.length ? me.companies.map((c) => c.name).join(' · ') : 'Şirket belgesi erişimi yok';
  return (
    <div className="grid h-full grid-cols-[256px_minmax(0,1fr)] max-[900px]:grid-cols-1 max-[900px]:grid-rows-[auto_auto_1fr]">
      <a className="absolute -left-[9999px] top-2 z-50 rounded-md bg-surface px-3 py-2 focus:left-2" href="#main">Ana içeriğe geç</a>
      <aside className="flex min-h-0 flex-col border-r border-border bg-rail max-[900px]:contents">
        <div className="px-5 pt-5 pb-4 max-[900px]:flex max-[900px]:items-center max-[900px]:gap-3 max-[900px]:border-b max-[900px]:border-border max-[900px]:bg-rail max-[900px]:px-4 max-[900px]:py-2.5">
          <div className="text-md font-bold tracking-[-0.005em] max-[900px]:hidden">Satınalma ve Sözleşme</div>
          <label className="sr-only" htmlFor="tenant">Aktif kiracı</label>
          <select id="tenant" value={me.activeTenantId ?? ''} onChange={(e) => void switchTenant(e.target.value)}
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
          <div className="truncate text-sm text-ink-subtle">{me.roles.map((r) => roleLabel[r] ?? r).join(', ')}</div>
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
        <Routes>
          <Route path="/" element={<Navigate to={me.supplierPortal ? '/portal' : '/islerim'} replace />} />
          <Route path="/portal" element={<PortalHome />} />
          <Route path="/portal/anketler" element={<PortalAssessments />} />
          <Route path="/portal/anketler/:id" element={<PortalAssessment />} />
          <Route path="/portal/:id" element={<PortalRound />} />
          <Route path="/projeler" element={<ProjectsPage />} />
          <Route path="/projeler/yeni" element={<ProjectWizard />} />
          <Route path="/projeler/:id" element={<ProjectWorkspace />} />
          <Route path="/islerim" element={<WorkPage />} />
          <Route path="/tedarikciler" element={<SuppliersPage />} />
          <Route path="/tedarikciler/:id" element={<SupplierDetailPage />} />
          <Route path="/belge-girisi" element={<IntakePage />} />
          <Route path="/belgeler/:id" element={<DocumentPage />} />
          <Route path="/sozlesmeler" element={<ContractsPage />} />
          <Route path="/sozlesmeler/:id" element={<ContractPage />} />
          <Route path="/siparisler" element={<PurchaseOrdersPage />} />
          <Route path="/siparisler/:id" element={<PurchaseOrderPage />} />
          <Route path="/faturalar" element={<InvoicesPage />} />
          <Route path="/faturalar/tolerans" element={<ToleranceRulesPage />} />
          <Route path="/projeler/onay-politikasi" element={<ApprovalPolicyPage />} />
          <Route path="/ara" element={<SearchPage />} />
          <Route path="/faturalar/erp-mutabakati" element={<ErpReconciliationPage />} />
          <Route path="/faturalar/:id" element={<InvoicePage />} />
          <Route path="/raporlar" element={<ReportsPage />} />
          <Route path="/olaylar" element={<IncidentsPage />} />
          <Route path="/olaylar/:id" element={<IncidentPage />} />
          <Route path="/degerlendirmeler/:id" element={<AssessmentPage />} />
          <Route path="/anketler" element={<TemplatesPage />} />
          <Route path="/performans-agirliklari" element={<PerformanceWeightsPage />} />
          <Route path="/yapay-zeka" element={<AiPage />} />
          <Route path="/veri-yonetimi" element={<DataGovernancePage />} />
          <Route path="/veri-yonetimi/imha/:id" element={<DisposalBatchPage />} />
          <Route path="*" element={<NotYetPage title="Sayfa bulunamadı" />} />
        </Routes>
        </Suspense>
      </main>
    </div>
  );
}
