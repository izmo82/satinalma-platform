import { useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { cn } from '@/lib/utils';
import { SupplierEvaluation } from './SupplierEvaluation.tsx';
import { useResource } from '../lib/useApi.ts';
import { api, ApiError } from '../lib/api.ts';
import { fmtDateTime } from '../lib/format.ts';
import { hasPermission, hasRole, useSession } from '../lib/session.tsx';
import { Banner, ErrorState, Field, Loading, Modal, Tag } from '../ui/kit.tsx';
import { Icon } from '../ui/icons.tsx';
import { StageWithStatus } from '../lib/supplierV2.tsx';
import { ActivationHints, ContractsProjectsTab, DocumentsTab, LifecycleBanner, OffboardingTab, PortalUsersTab, ProfilePanel, ReasonDialog, ScoreRiskPanel, type CardV2 } from './SupplierCardV2.tsx';

// v2 Faz 5 (D110, Figma 14): Belgeler ve geçerlilik, Sözleşmeler ve projeler, Portal kullanıcıları ve (liste varsa) Ayrılış sekmeleri eklendi;
// eski dört sekme aynı adla ve aynı `?sekme=` adresiyle kalır, varsayılan sekme yine "Kayıt ve onay".
const SUPPLIER_TABS = [['kayit', 'Kayıt ve onay'], ['belgeler', 'Belgeler ve geçerlilik'], ['sozlesmeler', 'Sözleşmeler ve projeler'], ['degerlendirme', 'Değerlendirme ve risk'],
  ['olaylar', 'Olaylar'], ['karne', 'Performans karnesi'], ['portal', 'Portal kullanıcıları'], ['ayrilis', 'Ayrılış kontrol listesi']] as const;
const V2_TABS = new Set(['belgeler', 'sozlesmeler', 'portal', 'ayrilis']);

interface Supplier extends CardV2 {
  id: string; status: string; country: string; taxIdType: string | null; taxId: string | null; legalName: string; identityReviewRequired: boolean;
  createdByName: string | null; isCreator: boolean; activatedAt: string | null; rowVersion: number; rejectionReason: string | null; mergedIntoId: string | null;
  documents: { documentVersionId: string; title: string; kind: string; extractedName: string | null; nameMismatch: boolean; linkedAt: string }[];
  approvals: { kind: string; decision: string; rationale: string; at: string; approverName: string; rowVersion: number }[];
  bankAccounts: { id: string; iban: string; currency: string; status: string }[];
  bankChangeRequests: { id: string; proposedIban: string; source: string; status: string; createdAt: string }[];
}

/** Tedarikçi onay türleri (v1 rol adları yerine v2 dilinde, düzeltme dalgası Y3). */
const APPROVAL_KIND: Record<string, string> = { MASTER_DATA: 'Kayıt onayı', SECURITY: 'Güvenlik onayı', FINANCE: 'Banka ve ödeme bilgisi onayı' };

export function SupplierDetailPage() {
  const { id } = useParams();
  const { me } = useSession();
  const r = useResource<Supplier>(`/api/v1/suppliers/${id}`);
  const [params, setParams] = useSearchParams();
  const tab = params.get('sekme') ?? 'kayit';
  const [dialog, setDialog] = useState<null | 'approve' | 'reject' | 'identity' | 'deactivate' | 'reactivate'>(null);
  const [warnings, setWarnings] = useState<{ code: string; message: string }[]>([]);
  const [actionError, setActionError] = useState<ApiError | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  if (r.loading && !r.data) return <div className="page"><Loading /></div>;
  if (r.error || !r.data) return <div className="page"><ErrorState error={r.error} onRetry={r.reload} /></div>;
  const s = r.data;
  const isMasterData = hasRole(me, 'MASTER_DATA');
  const approvedNow = s.approvals.some((a) => a.kind === 'MASTER_DATA' && a.decision === 'APPROVED' && a.rowVersion === s.rowVersion);
  const blockers: string[] = [];
  if (!s.taxId || s.identityReviewRequired) blockers.push('Vergi kimliği doğrulanmadı');
  if (!approvedNow) blockers.push('Bağımsız kayıt onayı yok');
  if (s.isCreator) blockers.push('Bu adayı siz açtınız; görev ayrılığı gereği onay ve aktivasyon başka bir yetkiliye aittir');

  async function run(fn: () => Promise<unknown>, ok: string) {
    setActionError(null);
    try { await fn(); setNotice(ok); setDialog(null); await r.reload(); }
    catch (e) { setActionError(e as ApiError); if ((e as ApiError).status === 409) await r.reload(); }
  }
  /** v2 bölümleri: hata çağırana da döner (diyalog açık kalır, yazılan korunur). */
  async function runV2(fn: () => Promise<unknown>, ok: string) {
    setActionError(null); setNotice(null);
    try { await fn(); setNotice(ok); await r.reload(); }
    catch (e) { if ((e as ApiError).status === 409) await r.reload(); throw e; }
  }
  const tabs = SUPPLIER_TABS.filter(([k]) => k !== 'ayrilis' || s.offboarding);
  const openTab = (k: string) => { const p = new URLSearchParams(params); k === 'kayit' ? p.delete('sekme') : p.set('sekme', k); setParams(p, { replace: true }); };

  return (
    <div className="page">
      <p className="subtle"><Link to="/tedarikciler">Tedarikçiler</Link> / {s.legalName}</p>
      <div className="page-header">
        <div className="grow">
          <h1 style={{ overflowWrap: 'anywhere' }}>{s.legalName}</h1>
          <div className="btn-row" style={{ marginTop: 8 }}>
            {/* v2 Faz 5 (R1): aşama etiketi (türetilir); eski kayıt durumu ipucunda. */}
            <StageWithStatus stage={s.stage} stageLabel={s.stageLabel} status={s.status} />
            {s.taxId ? <span className="mono">{s.country} · {s.taxIdType} {s.taxId}</span> : <Tag label={{ text: 'Kimlik doğrulanmadı', tone: 'warn', icon: 'help' }} />}
          </div>
        </div>
        {(s.can?.offboard || s.can?.reactivate) && (
          <div className="btn-row">
            {s.can?.offboard && <button className="btn btn-danger" onClick={() => setDialog('deactivate')}>Pasife al</button>}
            {s.can?.reactivate && <button className="btn" onClick={() => setDialog('reactivate')}>Yeniden aç</button>}
          </div>
        )}
        {s.status === 'CANDIDATE' && isMasterData && (
          <div className="btn-row">
            {(!s.taxId || s.identityReviewRequired) && <button className="btn" onClick={() => setDialog('identity')}>Kimliği doğrula</button>}
            <button className="btn btn-danger" onClick={() => setDialog('reject')} disabled={s.isCreator}>Reddet</button>
            <button className="btn" onClick={() => setDialog('approve')} disabled={s.isCreator || approvedNow}>Kayıt onayı ver</button>
            <button className="btn btn-primary" disabled={blockers.length > 0}
              onClick={() => void run(() => api(`/api/v1/suppliers/${s.id}/activate`, { method: 'POST', json: { expectedRowVersion: s.rowVersion } }), 'Tedarikçi aktifleştirildi.')}>
              Aktifleştir
            </button>
          </div>
        )}
      </div>

      {notice && <Banner tone="info" icon="check" title={notice} />}
      {actionError && <Banner tone={actionError.status === 409 ? 'warn' : 'danger'} title={actionError.message}>
        {actionError.details?.missing && `Eksik koşullar: ${actionError.details.missing.join(', ')}`}
        {actionError.status === 409 && 'Sayfa güncel bilgilerle yenilendi; kararınızı yeniden gözden geçirin.'}
      </Banner>}
      <LifecycleBanner s={s} />
      {/* can.reactivate izni olan ama pasife alan kişi için false döner: not yalnız o kişiye. */}
      {s.status === 'SUSPENDED' && s.deactivation && s.can && !s.can.reactivate && hasPermission(me, 'supplier.offboard') && <p className="mb-4 -mt-2 text-sm text-ink-muted">Görev ayrılığı: tedarikçiyi siz pasife aldınız; yeniden açmayı başka bir Satınalma kullanıcısı yapar.</p>}
      {s.status === 'ARCHIVED' && <p className="mb-4 -mt-2 text-sm text-ink-muted">Arşivlenmiş kayıt bu aşamada yeniden açılamaz; bu yüzden "Yeniden aç" yok. Kayıt ve geçmişi silinmedi.</p>}
      {warnings.length > 0 && <Banner tone="warn" title="Pasife alındı; kontrol edilmesi gerekenler">{warnings.map((w) => w.message).join(' · ')}</Banner>}
      {s.status === 'CANDIDATE' && (
        <Banner tone="warn" title="Aday kayıt: kayıt onayına kadar kesin seçim engelli">
          {blockers.length ? <>Aktivasyon için: {blockers.join(' · ')}.</> : 'Aktivasyon koşulları tamam.'}
        </Banner>
      )}
      {s.status === 'MERGED' && s.mergedIntoId && <Banner tone="neutral" title="Bu kayıt başka bir tedarikçiyle birleştirildi"><Link to={`/tedarikciler/${s.mergedIntoId}`}>Güncel kayda git</Link></Banner>}

      <div role="tablist" aria-label="Tedarikçi" className="mb-4 flex gap-6 overflow-x-auto border-b border-border">
        {tabs.map(([k, l]) => (
          <button key={k} role="tab" aria-selected={tab === k} onClick={() => openTab(k)}
            className={cn('-mb-px min-h-10 whitespace-nowrap border-b-2 font-semibold transition-colors duration-150', tab === k ? 'border-ink text-ink' : 'border-transparent text-ink-muted hover:text-ink')}>{l}</button>
        ))}
      </div>
      {tab === 'belgeler' ? <DocumentsTab s={s} run={runV2} />
        : tab === 'sozlesmeler' ? <ContractsProjectsTab s={s} />
        : tab === 'portal' ? <PortalUsersTab s={s} run={runV2} />
        : tab === 'ayrilis' ? <OffboardingTab s={s} run={runV2} />
        : tab !== 'kayit' && !V2_TABS.has(tab) ? <SupplierEvaluation tab={tab} supplierId={s.id} /> : <>
      <ActivationHints s={s} />
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(340px, 100%), 1fr))', gap: 16 }}>
        <section className="panel" aria-labelledby="kimlik">
          <div className="panel-head"><h2 id="kimlik">Kimlik ve kayıt</h2></div>
          <div className="panel-body">
            <dl className="facts">
              <dt>Ülke</dt><dd>{s.country}</dd>
              <dt>Kimlik</dt><dd>{s.taxId ? `${s.taxIdType} ${s.taxId}` : 'Kesin anahtar atanmadı'}</dd>
              <dt>Kaydı açan</dt><dd>{s.createdByName ?? 'Sistem'}</dd>
              <dt>Aktivasyon</dt><dd>{s.activatedAt ? fmtDateTime(s.activatedAt) : '—'}</dd>
              {s.rejectionReason && <><dt>Ret gerekçesi</dt><dd>{s.rejectionReason}</dd></>}
            </dl>
            <p className="subtle" style={{ marginTop: 12 }}>Biçim ve kontrol basamağı geçerliliği firmanın gerçekliğini veya mükellefiyetini kanıtlamaz.</p>
          </div>
        </section>

        <ProfilePanel s={s} run={runV2} />
        <ScoreRiskPanel s={s} onOpen={() => openTab('degerlendirme')} />

        <section className="panel" aria-labelledby="banka">
          <div className="panel-head"><h2 id="banka">Banka bilgisi</h2></div>
          <div className="panel-body">
            {s.bankAccounts.length ? s.bankAccounts.map((b) => <p key={b.id} className="mono">{b.iban} · {b.currency} · <Tag label={{ text: 'Doğrulanmış', tone: 'ok', icon: 'check' }} /></p>)
              : <p className="muted">Doğrulanmış banka hesabı yok.</p>}
            {s.bankChangeRequests.filter((b) => b.status === 'PENDING_VERIFICATION').map((b) => (
              <Banner key={b.id} tone="warn" icon="lock" title="Belgede farklı IBAN okundu — doğrulama bekliyor">
                <span className="mono">{b.proposedIban}</span>. Mevcut banka bilgisi değiştirilmedi. Kayıtlı güvenilir kanaldan teyit ve ikinci onay gerekir.
              </Banner>
            ))}
          </div>
        </section>
      </div>

      <section className="panel" style={{ marginTop: 16 }} aria-labelledby="belgeler">
        <div className="panel-head"><h2 id="belgeler">Kaynak belgeler</h2><span className="subtle">Erişiminiz olan şirketlerdeki belgeler</span></div>
        {s.documents.length ? (
          <table className="data compact">
            <thead><tr><th scope="col">Belge</th><th scope="col">Belgedeki ünvan</th><th scope="col">Bağlandı</th></tr></thead>
            <tbody>{s.documents.map((d) => (
              <tr key={d.documentVersionId}>
                <td><Link className="row-link" to={`/belgeler/${d.documentVersionId}`}>{d.title}</Link></td>
                <td>{d.extractedName ?? '—'} {d.nameMismatch && <Tag label={{ text: 'Ünvan farkı', tone: 'warn', icon: 'alert' }} />}</td>
                <td className="subtle">{fmtDateTime(d.linkedAt)}</td>
              </tr>))}
            </tbody>
          </table>
        ) : <div className="panel-body muted">Belge yok.</div>}
      </section>

      <section className="panel" style={{ marginTop: 16 }} aria-labelledby="onaylar">
        <div className="panel-head"><h2 id="onaylar">Onay geçmişi</h2></div>
        <div className="panel-body">
          {s.approvals.length ? <ol className="timeline">{s.approvals.map((a, i) => (
            <li key={i}><strong>{APPROVAL_KIND[a.kind] ?? 'Onay'} · {a.decision === 'APPROVED' ? 'Onaylandı' : 'Reddedildi'}</strong>
              <span>{a.rationale}</span><span className="subtle">{a.approverName} · {fmtDateTime(a.at)} · kayıt sürümü {a.rowVersion}</span></li>))}</ol>
            : <p className="muted">Henüz onay yok.</p>}
        </div>
      </section>
      </>}

      {(dialog === 'approve' || dialog === 'reject') && (
        <DecisionDialog kind={dialog} onClose={() => setDialog(null)} onSubmit={(rationale) => run(() => api(`/api/v1/suppliers/${s.id}/approvals`, {
          method: 'POST', json: { kind: 'MASTER_DATA', decision: dialog === 'approve' ? 'APPROVED' : 'REJECTED', rationale, expectedRowVersion: s.rowVersion } }),
          dialog === 'approve' ? 'Kayıt onayı kaydedildi.' : 'Aday reddedildi; belge ve gerekçe korunur.')} />
      )}
      {(dialog === 'deactivate' || dialog === 'reactivate') && (
        <ReasonDialog kind={dialog} s={s} onClose={() => setDialog(null)} onSubmit={(reason) => run(async () => {
          const res = await api<{ warnings?: { code: string; message: string }[] }>(`/api/v1/suppliers/${s.id}/${dialog}`, { method: 'POST', json: { reason, expectedRowVersion: s.rowVersion } });
          setWarnings(dialog === 'deactivate' ? res.data.warnings ?? [] : []);
        }, dialog === 'deactivate' ? 'Tedarikçi pasife alındı; ayrılış kontrol listesi açıldı.' : 'Tedarikçi yeniden açıldı.')} />
      )}
      {dialog === 'identity' && (
        <IdentityDialog onClose={() => setDialog(null)} onSubmit={(b) => run(() => api(`/api/v1/suppliers/${s.id}/identity`, {
          method: 'POST', json: { ...b, expectedRowVersion: s.rowVersion } }), 'Kimlik kaydedildi.')} />
      )}
    </div>
  );
}

function DecisionDialog({ kind, onClose, onSubmit }: { kind: 'approve' | 'reject'; onClose: () => void; onSubmit: (r: string) => Promise<void> }) {
  const [rationale, setRationale] = useState('');
  const [err, setErr] = useState<string | null>(null);
  return (
    <Modal title={kind === 'approve' ? 'Kayıt onayı' : 'Adayı reddet'} onClose={onClose} footer={<>
      <button className="btn" onClick={onClose}>Vazgeç</button>
      <button className={kind === 'approve' ? 'btn btn-primary' : 'btn btn-danger'} onClick={() => { if (rationale.trim().length < 3) { setErr('Gerekçe yazın.'); return; } void onSubmit(rationale.trim()); }}>
        {kind === 'approve' ? 'Onayı kaydet' : 'Reddet'}</button></>}>
      <Field label="Gerekçe" hint="Hangi kanıtı incelediğinizi yazın. Denetim izine kaydedilir." error={err}>
        {(p) => <textarea className="input" {...p} value={rationale} onChange={(e) => setRationale(e.target.value)} />}
      </Field>
    </Modal>
  );
}

function IdentityDialog({ onClose, onSubmit }: { onClose: () => void; onSubmit: (b: { country: string; taxIdType: string; taxId: string; rationale: string }) => Promise<void> }) {
  const [b, setB] = useState({ country: 'TR', taxIdType: 'VKN', taxId: '', rationale: '' });
  const [err, setErr] = useState<Record<string, string>>({});
  function submit() {
    const e: Record<string, string> = {};
    if (!b.taxId.trim()) e.taxId = 'Vergi kimliğini girin.';
    if (b.rationale.trim().length < 3) e.rationale = 'Kaynağı ve gerekçeyi yazın.';
    setErr(e);
    if (!Object.keys(e).length) void onSubmit(b);
  }
  return (
    <Modal title="Tedarikçi kimliğini doğrula" onClose={onClose} footer={<><button className="btn" onClick={onClose}>Vazgeç</button><button className="btn btn-primary" onClick={submit}>Kaydet</button></>}>
      <p className="muted" style={{ marginBottom: 12 }}>Kimlik başka bir kayıtta varsa bu aday o kayıtla birleştirilir; belgeler taşınır ve iz korunur.</p>
      <Field label="Kimlik türü">{(p) => <select className="input" {...p} value={b.taxIdType} onChange={(e) => setB({ ...b, taxIdType: e.target.value })}><option value="VKN">VKN</option><option value="TCKN">TCKN</option><option value="FOREIGN">Yabancı</option></select>}</Field>
      <Field label="Vergi kimliği" hint="Baştaki sıfırlar korunur." error={err.taxId}>{(p) => <input className="input mono" inputMode="numeric" {...p} value={b.taxId} onChange={(e) => setB({ ...b, taxId: e.target.value })} />}</Field>
      <Field label="Gerekçe ve kaynak" error={err.rationale}>{(p) => <textarea className="input" {...p} value={b.rationale} onChange={(e) => setB({ ...b, rationale: e.target.value })} />}</Field>
    </Modal>
  );
}
