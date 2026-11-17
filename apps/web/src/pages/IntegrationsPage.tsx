import { lazy, Suspense } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { hasRole, useSession } from '../lib/session.tsx';
import { useResource } from '../lib/useApi.ts';
import { fmtDateTime } from '../lib/format.ts';
import { Banner, Empty, ErrorState, Loading, PageHeader, Tag } from '../ui/kit.tsx';
import { Icon } from '../ui/icons.tsx';
import { cn } from '@/lib/utils';
import { countsText, directionTag, EndpointDetail, MOCK_TAG, runTag, stateTag, type EndpointCard, type ProviderView } from './ErpEndpointCard.tsx';

// v2 Faz 8 (D113, R10, Figma 22): Yönetim > Entegrasyonlar iki bölümlüdür: "Bağlantılar" (7 ERP özelliği kartı) ve "Fatura aktarım
// mutabakatı" (mevcut ErpReconciliationPage, değişmeden). Varsayılan bölüm role göre: Satınalma ve Denetçi mutabakatı bugünkü gibi ilk
// ekranda görür (dokunuş artmaz); Yönetici bağlantıları. `?bolum=baglantilar|mutabakat` adresle seçer; `/faturalar/erp-mutabakati`
// `?bolum=mutabakat`'a yönlenir.

const ErpReconciliationPage = lazy(() => import('./GovernancePages.tsx').then((m) => ({ default: m.ErpReconciliationPage })));

type Section = 'baglantilar' | 'mutabakat';
interface EndpointList { items: EndpointCard[]; providerConfigured: boolean; provider: ProviderView; secretKeyConfigured: boolean }

export function IntegrationsPage() {
  const { me } = useSession();
  const [params] = useSearchParams();
  const recon = hasRole(me, 'PROCUREMENT', 'AUDITOR');
  const asked = params.get('bolum');
  const section: Section = asked === 'baglantilar' || asked === 'mutabakat' ? asked : recon ? 'mutabakat' : 'baglantilar';
  const item = (active: boolean) => cn('-mb-px flex min-h-10 items-center whitespace-nowrap border-b-2 font-semibold no-underline transition-colors duration-150',
    active ? 'border-ink text-ink' : 'border-transparent text-ink-muted hover:text-ink');
  return <>
    <nav aria-label="Entegrasyon bölümleri" className="px-8 pt-3 max-[900px]:px-4">
      <ul className="flex gap-6 overflow-x-auto border-b border-border">
        <li className="shrink-0"><Link to="/yonetim/entegrasyonlar?bolum=baglantilar" aria-current={section === 'baglantilar' ? 'page' : undefined} className={item(section === 'baglantilar')}>Bağlantılar</Link></li>
        <li className="shrink-0"><Link to="/yonetim/entegrasyonlar?bolum=mutabakat" aria-current={section === 'mutabakat' ? 'page' : undefined} className={item(section === 'mutabakat')}>Fatura aktarım mutabakatı</Link></li>
      </ul>
      {/* v2 Faz 8 izleme (sıfır gerileme): Faz 1'de Yönetici'nin ilk ekranında görünen mutabakat açıklaması varsayılan (Bağlantılar) görünümünde de. */}
      {!recon && section === 'baglantilar' && <p className="mt-2 text-sm text-ink-muted">ERP mutabakatı Satınalma ve Denetçi rollerine açık: fatura aktarımlarının mutabakatını Satınalma yürütür, Denetçi okur.</p>}
    </nav>
    {section === 'baglantilar' ? <Connections /> : recon ? <Suspense fallback={<div className="page"><Loading rows={5} /></div>}><ErpReconciliationPage /></Suspense> : (
      // Yönetici rolünün mutabakat uçlarına yetkisi yok (Faz 1'deki açıklama aynen).
      <div className="page">
        <PageHeader title="Fatura aktarım mutabakatı" />
        <div className="rounded-md border border-border bg-surface">
          <Empty icon="clock" title="ERP mutabakatı Satınalma ve Denetçi rollerine açık">Fatura aktarımlarının ERP mutabakatını Satınalma yürütür, Denetçi okur. Oracle ERP bağlantı ayarları "Bağlantılar" bölümündedir.</Empty>
        </div>
      </div>
    )}
  </>;
}

/** Sağlayıcı şeridi: taklit uyarı tonunda; gerçek Oracle bilgi; yapılandırılmamışsa "Bağlı değil". */
function ProviderStrip({ list }: { list: EndpointList }) {
  const p = list.provider;
  return <>
    {!list.providerConfigured ? (
      <Banner tone="neutral" icon="info" title="Sağlayıcı: Bağlı değil">Bu ortamda ERP sağlayıcısı yapılandırılmadı (ERP_PROVIDER). Özellikler açılamaz; her özelliğin elle giriş yolu açık.</Banner>
    ) : p.kind === 'TAKLIT' ? (
      <Banner tone="warn" title="Sağlayıcı: Taklit Oracle (gerçek değil)">Bu ortamdaki bütün sınama ve çalışmalar taklit sağlayıcıyla yapılır; gerçek Oracle'a istek atılmaz ve sonuçlar gerçek başarı sayılmaz.</Banner>
    ) : (
      <Banner tone="info" title={`Sağlayıcı: ${p.label}`}>{p.available ? 'Sınama ve çalışmalar kurumun Oracle uç noktalarına gider.' : 'Sağlayıcı bu ortamda kullanılamıyor.'}</Banner>
    )}
    {list.providerConfigured && !list.secretKeyConfigured && (
      <Banner tone="warn" title="Sır şifreleme anahtarı yapılandırılmadı">INTEGRATION_SECRET_KEY olmadan parola veya istemci sırrı kaydedilemez; kartların sır alanı kapalıdır.</Banner>
    )}
  </>;
}

function Connections() {
  const [params, setParams] = useSearchParams();
  const r = useResource<EndpointList>('/api/v1/integration/endpoints');
  const selected = params.get('ozellik');
  const select = (f: string | null) => {
    const p = new URLSearchParams(params); p.set('bolum', 'baglantilar'); f ? p.set('ozellik', f) : p.delete('ozellik'); setParams(p, { replace: true });
    // Dar ekranda kart listenin altında açılır; seçince karta kaydırılır (dokunuş artmaz).
    if (f && window.matchMedia('(max-width: 1199px)').matches) requestAnimationFrame(() => document.getElementById('erp-detail')?.scrollIntoView({ block: 'start' }));
  };
  const items = r.data?.items ?? [];
  const card = items.find((c) => c.feature === selected) ?? null;
  const manage = items.some((c) => c.can.manage);
  return (
    <div className="page">
      <PageHeader title="Oracle ERP entegrasyonu">
        Her özellik kendi uç noktası ve kimlik bilgisiyle veri alışverişi yapar. Her özellik varsayılan kapalıdır; kapalıyken elle giriş yolu açıktır.{!manage && r.data ? ' Ayarları Yönetici değiştirir; bu sayfa sizin için salt okunur.' : ''}
      </PageHeader>
      {r.loading && !r.data ? <Loading rows={6} /> : r.error || !r.data ? <ErrorState error={r.error} onRetry={r.reload} /> : <>
        <ProviderStrip list={r.data} />
        <div className="grid items-start gap-5 min-[1200px]:grid-cols-[minmax(0,5fr)_minmax(0,7fr)]">
          <div className="grid gap-5">
            {([1, 2] as const).map((stage) => (
              <section key={stage} className="panel" aria-labelledby={`stage-${stage}`}>
                <div className="panel-head"><h2 id={`stage-${stage}`}>{stage === 1 ? '1. aşama — okuma' : '2. aşama — ERP\'ye yazma (kapalı varsayılan)'}</h2></div>
                <ul className="grid">{items.filter((c) => c.stage === stage).map((c) => (
                  <li key={c.feature} className="border-b border-border last:border-0">
                    <button type="button" aria-expanded={selected === c.feature} aria-controls="erp-detail" onClick={() => select(selected === c.feature ? null : c.feature)}
                      className={cn('grid w-full gap-1.5 px-4 py-3 text-left transition-colors duration-150 hover:bg-sunken', selected === c.feature && 'bg-sunken')}>
                      <span className="flex flex-wrap items-center gap-2">
                        <span className="min-w-0 flex-1 font-semibold">{c.label}</span>
                        <Icon name="chevron" size={16} className={cn('text-ink-subtle transition-transform', selected === c.feature && 'rotate-90')} />
                      </span>
                      <span className="flex flex-wrap items-center gap-1.5">
                        <Tag label={directionTag(c)} /><Tag label={stateTag(c)} />
                        {c.writes && c.writeEnabled && <Tag label={{ text: 'ERP\'ye yazma açık', tone: 'warn', icon: 'upload' }} />}
                        {c.secretNeedsReentry && <Tag label={{ text: 'Sır yeniden girilmeli', tone: 'danger', icon: 'lock' }} />}
                      </span>
                      <span className="text-sm text-ink-muted">{c.lastRun ? <>Son çalışma {fmtDateTime(c.lastRun.startedAt)} · <Tag label={runTag(c.lastRun)} className="whitespace-normal" />{c.lastRun.mock && <> <Tag label={MOCK_TAG} /></>}
                        <span className="mt-0.5 block">{countsText(c.lastRun.counts)}</span></> : 'Henüz çalışma yok'}</span>
                    </button>
                  </li>
                ))}</ul>
              </section>
            ))}
          </div>
          <div id="erp-detail" className="min-w-0 min-[1200px]:sticky min-[1200px]:top-4">
            {card ? <EndpointDetail key={card.feature} card={card} onChanged={r.reload} /> : (
              <div className="rounded-md border border-border bg-surface">
                <Empty icon="settings" title="Bir özellik seçin">Adres, kimlik doğrulama, zamanlama, alan eşlemesi, sınama ve son çalışmalar seçilen özelliğin kartında görünür.</Empty>
              </div>
            )}
          </div>
        </div>
      </>}
    </div>
  );
}
