import { lazy, useState, type ReactNode } from 'react';
import { Link, Navigate, Outlet } from 'react-router-dom';
import { api, ApiError } from '../lib/api.ts';
import { hasRole, useSession, type Me } from '../lib/session.tsx';
import { useResource } from '../lib/useApi.ts';
import { Banner, Empty, ErrorState, Field, Loading, PageHeader } from '../ui/kit.tsx';
import { SectionTabs } from '../ui/SectionTabs.tsx';
import { Button } from '@/components/ui/button';

// v2 Faz 1 (D93): Yönetim merkezi. Sekme sırası onaylı Figma ekranlarıyla aynı. Sonraki fazların sekmeleri yalnız hangi fazda
// geleceğini söyleyen boş durumdur; sahte denetim (düğme, form) yoktur. Denetçi yalnız okunur sekmeleri görür.

const ErpReconciliationPage = lazy(() => import('./GovernancePages.tsx').then((m) => ({ default: m.ErpReconciliationPage })));

type TabKey = 'kullanicilar' | 'onaycilar' | 'sablonlar' | 'satinalma-kurallari' | 'entegrasyonlar' | 'yapay-zeka' | 'denetim-izi';
const TABS: { key: TabKey; label: string; roles: string[] }[] = [
  { key: 'kullanicilar', label: 'Kullanıcılar ve Entra', roles: ['ADMIN', 'PROCUREMENT'] },
  { key: 'onaycilar', label: 'Onaycılar', roles: ['ADMIN', 'PROCUREMENT'] },
  { key: 'sablonlar', label: 'Şablonlar', roles: ['ADMIN', 'PROCUREMENT'] },
  { key: 'satinalma-kurallari', label: 'Satınalma kuralları', roles: ['ADMIN', 'PROCUREMENT'] },
  { key: 'entegrasyonlar', label: 'Entegrasyonlar', roles: ['ADMIN', 'PROCUREMENT', 'AUDITOR'] },
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

export const ApproversTab = () => (
  <Planned title="Onaycılar" heading="Onaycı ataması Faz 2'de gelir">
    Sözleşme onay zincirindeki üç unvan (departman sorumlusu, satınalma sorumlusu, satınalma direktörü) için kişi ataması bu sekmede yapılacak. Şu an bu sekmede ayar yok.
  </Planned>
);

export const TemplatesTab = () => (
  <Planned title="Şablonlar" heading="Sözleşme şablonları Faz 3'te gelir">
    Sözleşme şablon kütüphanesi ve şablon sürümleri bu sekmede yönetilecek. Tedarikçi anket şablonları yerinde duruyor: <Link to="/tedarikciler/anketler">Tedarikçiler &gt; Anketler</Link>.
  </Planned>
);

export const RulesTab = () => (
  <Planned title="Satınalma kuralları" heading="Satınalma kuralları kataloğu Faz 7'de gelir">
    Uyum denetiminde kullanılacak satınalma kuralları ve sürümleri bu sekmede yönetilecek. Şu an bu sekmede ayar yok.
  </Planned>
);

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

/** Kullanıcılar ve Entra (Faz 1): departman listesi, Yönetici için departman ekleme ve kurum kullanıcıları. */
export function UsersTab() {
  const { me } = useSession();
  const admin = hasRole(me, 'ADMIN');
  const deps = useResource<{ items: Department[] }>('/api/v1/departments');
  const members = useResource<{ id: string; displayName: string }[]>('/api/v1/members');
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ tone: 'info' | 'danger'; text: string } | null>(null);

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

  return (
    <div className="page">
      <PageHeader title="Kullanıcılar ve Entra">
        Departmanlar ve kurumdaki kullanıcılar. Entra eşitlemesi (kullanıcıların ve departmanların Entra'dan alınması) Faz 2'de gelir; o zamana kadar departmanlar burada tanımlanır.
      </PageHeader>
      <div className="grid gap-5 min-[1100px]:grid-cols-2">
        <section className="panel">
          <div className="panel-head"><h2>Departmanlar</h2></div>
          <div className="panel-body grid gap-4">
            {deps.loading && !deps.data ? <Loading rows={3} /> : deps.error ? <ErrorState error={deps.error} onRetry={deps.reload} />
              : !deps.data?.items.length ? <p className="text-ink-muted">Henüz departman tanımlı değil.</p>
              : <ul className="grid gap-1">{deps.data.items.map((d) => <li key={d.id} className="border-b border-border py-1.5 last:border-0">{d.name}</li>)}</ul>}
            {admin && (
              <form onSubmit={create} className="grid gap-1 border-t border-border pt-4">
                <Field label="Departman adı" hint="Kurum içinde benzersiz olmalı. Kayıtlar (proje, sözleşme, fatura) departmana göre görünür.">
                  {(p) => <input className="input" {...p} value={name} maxLength={200} onChange={(e) => setName(e.target.value)} />}
                </Field>
                <div><Button type="submit" disabled={busy || !name.trim()}>{busy ? 'Ekleniyor…' : 'Departman ekle'}</Button></div>
              </form>
            )}
            <div aria-live="polite">{msg && <Banner tone={msg.tone} icon={msg.tone === 'info' ? 'check' : undefined} title={msg.text} />}</div>
          </div>
        </section>
        <section className="panel">
          <div className="panel-head"><h2>Kullanıcılar</h2></div>
          <div className="panel-body grid gap-3">
            <p className="text-sm text-ink-muted">Kullanıcıların rolü ve departman ataması Entra eşitlemesiyle (Faz 2) bu listede görünür ve buradan değiştirilir.</p>
            {members.loading && !members.data ? <Loading rows={4} /> : members.error ? <ErrorState error={members.error} onRetry={members.reload} />
              : !members.data?.length ? <p className="text-ink-muted">Kullanıcı yok.</p>
              : <ul className="grid gap-1">{members.data.map((u) => <li key={u.id} className="border-b border-border py-1.5 last:border-0">{u.displayName}</li>)}</ul>}
          </div>
        </section>
      </div>
    </div>
  );
}
