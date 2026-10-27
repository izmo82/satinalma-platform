import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, ApiError, session } from '../lib/api.ts';
import { useSession } from '../lib/session.tsx';
import { beginLogin, completeLogin, loadAuthConfig, type AuthConfig } from '../lib/oidc.ts';
import { Banner, Loading, Tag } from '../ui/kit.tsx';
import { Button } from '@/components/ui/button';

// Yalnız geliştirme: sentetik kullanıcılarla oturum. Üretimde OIDC yönlendirmesi kullanılır.
const DEMO = [
  ['alper.satinalma@example.test', 'Satınalmacı'],
  ['mine.anaveri@example.test', 'Ana veri sorumlusu'],
  ['leyla.hukuk@example.test', 'Hukuk'],
  ['kerem.hukuk@example.test', 'Hukuk + satınalma yöneticisi'],
  ['ferda.finans@example.test', 'Finans (fatura girişi)'],
  ['nur.finansonay@example.test', 'Finans (fatura onayı)'],
  ['tamer.yonetici@example.test', 'Kiracı yöneticisi (belge erişimi yok)'],
  ['deniz.denetci@example.test', 'Denetçi'],
  ['bora.baskakiraci@example.test', 'Başka kiracı kullanıcısı'],
  ['ece.cokkiracili@example.test', 'İki kiracıya üye kullanıcı'],
  ['tolga.teknik@example.test', 'Teknik değerlendirici'],
  ['teklif.anadolu@example.test', 'Tedarikçi portalı: Anadolu Bilişim'],
  ['teklif.ege@example.test', 'Tedarikçi portalı: Ege Sistem'],
  ['teklif.kuzey@example.test', 'Tedarikçi portalı: Kuzey Teknoloji (aday)'],
] as const;

export function LoginPage() {
  const { authError } = useSession();
  const [cfg, setCfg] = useState<AuthConfig | null>(null);
  const [cfgError, setCfgError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    setCfgError(null);
    loadAuthConfig().then(setCfg, (e: Error) => setCfgError(e.message));
  }, [attempt]);
  return (
    <div className="grid min-h-full place-items-center p-6 max-[600px]:p-4">
      <div className="grid w-full max-w-[960px] grid-cols-[minmax(0,1fr)_minmax(0,460px)] overflow-hidden rounded-lg border border-border bg-surface shadow-[0_1px_2px_rgba(29,34,48,.06),0_12px_32px_rgba(29,34,48,.08)] max-[860px]:grid-cols-1">
        <section className="flex flex-col gap-6 bg-rail p-8 max-[860px]:p-5">
          <h1 className="text-[1.75rem] leading-tight">Satınalma ve Sözleşme</h1>
          <p className="max-w-[44ch] text-md text-ink-muted">Her harcamanın hangi onaylı karara, sürüme ve yükümlülüğe dayandığı tek zincirde. Kanıtın kökeni mürekkebinden okunur.</p>
          <dl className="grid gap-3 max-[860px]:hidden">
            <div className="flex items-center gap-3"><dt><Tag label={{ text: 'İnsan kararı', tone: 'human', icon: 'stamp' }} /></dt><dd className="text-sm text-ink-muted">Onay, kurul kararı, imza teyidi</dd></div>
            <div className="flex items-center gap-3"><dt><Tag label={{ text: 'Kural ile doğrulandı', tone: 'ok', icon: 'check' }} /></dt><dd className="text-sm text-ink-muted">VKN sağlaması, e-Fatura XML</dd></div>
            <div className="flex items-center gap-3"><dt><Tag label={{ text: 'Otomatik öneri', tone: 'ai', icon: 'sparkles' }} /></dt><dd className="text-sm text-ink-muted">Taslaktır; karar vermez</dd></div>
          </dl>
        </section>
        <section className="p-8 max-[860px]:p-5">
          {authError && <Banner tone="danger" title="Erişim verilmedi">{authError}</Banner>}
          {cfgError ? (
            <Banner tone="danger" title="Oturum hizmetine ulaşılamadı"
              action={<Button variant="outline" size="sm" onClick={() => setAttempt((n) => n + 1)}>Tekrar dene</Button>}>{cfgError}</Banner>
          ) : !cfg ? <Loading rows={2} label="Oturum seçenekleri yükleniyor" />
            : cfg.mode === 'oidc' ? <EnterpriseLogin cfg={cfg} /> : <DevLogin />}
        </section>
      </div>
    </div>
  );
}

function EnterpriseLogin({ cfg }: { cfg: Extract<AuthConfig, { mode: 'oidc' }> }) {
  const [busy, setBusy] = useState(false);
  const host = (() => { try { return new URL(cfg.issuer).host; } catch { return cfg.issuer; } })();
  return (
    <div className="grid gap-4">
      <h2 className="text-lg">Oturum açın</h2>
      <p className="text-ink-muted">Kurumunuzun kimlik sağlayıcısına yönlendirileceksiniz. Erişim, kurum yöneticinizin verdiği davet ve rollerle sınırlıdır.</p>
      <Button size="lg" disabled={busy}
        onClick={() => { setBusy(true); void beginLogin(cfg, location.pathname + location.search); }}>
        {busy ? 'Yönlendiriliyor…' : 'Kurumsal hesapla giriş yap'}
      </Button>
      <p className="text-sm text-ink-subtle">Kimlik sağlayıcı: <span className="mono">{host}</span></p>
    </div>
  );
}

export function OidcCallback() {
  const { refresh } = useSession();
  const navigate = useNavigate();
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let done = false;
    completeLogin().then(async (to) => {
      if (done) return;
      await refresh();
      navigate(to === '/auth/callback' ? '/' : to, { replace: true });
    }, (e: Error) => setError(e.message));
    return () => { done = true; };
  }, [refresh, navigate]);
  if (!error) return <Loading label="Oturum doğrulanıyor" />;
  return (
    <div className="grid min-h-full place-items-center p-6"><div className="w-full max-w-[520px] rounded-lg border border-border bg-surface p-6">
      <Banner tone="danger" title="Giriş tamamlanamadı"
        action={<Button variant="outline" size="sm" onClick={() => navigate('/', { replace: true })}>Giriş ekranına dön</Button>}>{error}</Banner>
    </div></div>
  );
}

function DevLogin() {
  const { refresh } = useSession();
  const [email, setEmail] = useState<string>(DEMO[2][0]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true); setError(null);
    try {
      const r = await api<{ token: string }>('/api/v1/dev/token', { method: 'POST', json: { email } });
      session.token = r.data.token; session.tenant = null;
      await refresh();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Oturum açılamadı.');
    } finally { setBusy(false); }
  }
  return (
        <form onSubmit={submit} className="grid gap-3">
          <Banner tone="warn" title="Geliştirme oturumu — sentetik kullanıcılar">
            Bu giriş yalnız yerel geliştirme içindir ve üretimde kapalıdır. Üretimde kurumsal kimlik sağlayıcısı (OIDC/SAML, MFA) kullanılır.
          </Banner>
          <fieldset className="field">
            <legend>Kullanıcı</legend>
            <div className="radio-list">
              {DEMO.map(([e, r]) => (
                <label key={e}><input type="radio" name="user" value={e} checked={email === e} onChange={() => setEmail(e)} />
                  <span><span className="mono">{e}</span><br /><span className="subtle">{r}</span></span></label>
              ))}
            </div>
          </fieldset>
          {error && <Banner tone="danger" title="Oturum açılamadı">{error}</Banner>}
          <Button type="submit" size="lg" disabled={busy}>{busy ? 'Açılıyor…' : 'Oturum aç'}</Button>
        </form>
  );
}
