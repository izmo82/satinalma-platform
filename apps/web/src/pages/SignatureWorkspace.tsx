import { useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useResource } from '../lib/useApi.ts';
import { api, ApiError } from '../lib/api.ts';
import { fmtDate, fmtDateTime, shortHash } from '../lib/format.ts';
import {
  custodyLabel, decisionLabel, detectionLabel, digitalLabel, markLabel, methodLabel, overallLabel, partyRoleLabel, requirementLabel, stageLabel,
  type SupplierOption,
} from '../lib/labels.ts';
import { useSession } from '../lib/session.tsx';
import { Banner, Drawer, Empty, ErrorState, Field, Loading, Tag } from '../ui/kit.tsx';
import { Icon } from '../ui/icons.tsx';
import { SplitPanes } from '../ui/SplitPanes.tsx';
import { DocumentViewer, type Region } from '../ui/DocumentViewer.tsx';

interface Blocker { code: string; requirementId?: string; partyName?: string; action: string }
interface Status {
  contractVersion: { id: string; companyId: string; title: string; versionNo: number; stage: string; signatureMethod: string; originalCustodyRequired: boolean;
    documentVersionId: string; documentSha256: string; pageCount: number | null; supersededById: string | null; finalizedAt: string | null; finalizedStatus: string | null; etag: string };
  status: { overall: string; underlying: string; blockers: Blocker[]; custody: string; automaticCheck: string; automaticAlert: string | null;
    activeExceptionId: string | null; canFinalize: boolean;
    requirements: { id: string; partyName: string; signerRole: string; required: boolean; state: string; satisfiedBy: string | null; digital: string;
      slots: { slot: number; decision: string; observedMark: string | null }[] }[] };
  requirements: { id: string; partyId: string; partyName: string; partyRole: string; signerRole: string; requirementCount: number; acceptableMethods: string[]; required: boolean; page: number | null }[];
  reviews: { id: string; requirementId: string; slot: number; decision: string; observedMark: string; rationale: string; reviewerName: string; reviewedAt: string; page: number | null; appliesToCurrentDocument: boolean }[];
  detectionRuns: { id: string; status: string; provider: string; modelVersion: string; processedPages: number[]; totalPages: number | null; errorCode: string | null; createdAt: string; appliesToCurrentDocument: boolean }[];
  detections: { id: string; page: number; bbox: Region['bbox']; rawConfidence: string | null; status: string }[];
  validations: { id: string; requirementId: string | null; status: string; validator: string; blockedReason: string | null; validatedAt: string }[];
  exceptions: { id: string; requirementIds: string[]; status: string; expiresAt: string; reason: string; residualRisk: string; scope: string; decidedAt: string | null; expired: boolean }[];
  custodyEvents: { status: string; location: string; occurred_at: string; recorded_at: string }[];
  parties: { id: string; role: string; displayName: string }[];
  can: Record<'review' | 'defineRequirement' | 'analyze' | 'custody' | 'requestException' | 'decideException' | 'finalize' | 'manage', boolean>;
}

const blockerCodeText: Record<string, string> = {
  METHOD_NOT_CLASSIFIED: 'İmza yöntemi sınıflandırılmadı', NO_REQUIREMENTS_DEFINED: 'Taraf/imzacı gereksinimi tanımlanmadı',
  REVIEW_PENDING: 'İnceleme bekliyor', SIGNATURE_MISSING: 'İmza eksik', SIGNATURE_UNCLEAR: 'Belirsiz', ESIGN_NOT_VALIDATED: 'E-imza doğrulanmadı',
  ESIGN_INVALID: 'E-imza geçersiz', ORIGINAL_CUSTODY_NOT_CONFIRMED: 'Fiziksel asıl muhafazası teyit edilmedi',
};

export function SignatureWorkspace() {
  const { id } = useParams();
  const r = useResource<Status>(`/api/v1/contract-versions/${id}/signature-status`);
  const [targetPage, setTargetPage] = useState<number | null>(null);
  const [selectedDetection, setSelectedDetection] = useState<string | null>(null);
  const [reviewing, setReviewing] = useState<{ requirementId: string; slot: number } | null>(null);
  const [drawer, setDrawer] = useState<null | 'exception' | 'custody' | 'requirements' | 'version'>(null);
  const [feedback, setFeedback] = useState<{ tone: 'info' | 'warn' | 'danger'; title: string; body?: string; blockers?: Blocker[] } | null>(null);

  const regions: Region[] = useMemo(() => (r.data?.detections ?? []).map((d, i) => ({
    id: d.id, page: d.page, bbox: d.bbox, label: `AI adayı ${i + 1}`,
  })), [r.data]);

  if (r.loading && !r.data) return <div className="page"><Loading rows={6} label="İmza durumu yükleniyor" /></div>;
  if (r.error || !r.data) return <div className="page"><ErrorState error={r.error} onRetry={r.reload} /></div>;
  const s = r.data;
  const cv = s.contractVersion;
  const finalized = !!cv.finalizedAt;
  const readOnly = finalized || !!cv.supersededById;

  /** Sunucu işlemi: 409'da güncel sürüm yeniden yüklenir; 422'de gereksinim bazlı engeller gösterilir. */
  async function act(fn: () => Promise<unknown>, ok: string) {
    setFeedback(null);
    try {
      await fn();
      setFeedback({ tone: 'info', title: ok });
      await r.reload();
      return true;
    } catch (e) {
      const err = e as ApiError;
      if (err.status === 409) { setFeedback({ tone: 'warn', title: err.message, body: 'Güncel sürüm yüklendi. Değerleri gözden geçirip kararınızı yeniden verin.' }); await r.reload(); }
      else if (err.status === 422 && err.details?.blockers) setFeedback({ tone: 'danger', title: err.message, blockers: err.details.blockers });
      else setFeedback({ tone: 'danger', title: err.message });
      return false;
    }
  }

  const overall = overallLabel[s.status.overall];
  const reqResult = (rid: string) => s.status.requirements.find((x) => x.id === rid);

  return (
    <>
    <SplitPanes docLabel="Belge" sideLabel="Taraflar ve kararlar" docSignal={targetPage} doc={<>
        <DocumentViewer versionId={cv.documentVersionId} mimeType="application/pdf" regions={regions} targetPage={targetPage}
          selectedRegion={selectedDetection} onSelectRegion={(rid) => { setSelectedDetection(rid); setTargetPage(regions.find((x) => x.id === rid)?.page ?? null); }} />
      </>} side={<>
        <div className="section">
          <p className="subtle"><Link to="/sozlesmeler">Sözleşmeler</Link> / İmza kontrolü</p>
          <h1 style={{ fontSize: 18, marginTop: 4, overflowWrap: 'anywhere' }}>{cv.title}</h1>
          <div className="kv-inline" style={{ marginTop: 6 }}>
            <span>Sürüm {cv.versionNo}</span><span>{stageLabel[cv.stage]}</span><span>{methodLabel[cv.signatureMethod]}</span>
            <span className="mono" title={cv.documentSha256}>SHA-256 {shortHash(cv.documentSha256)}</span>
          </div>
        </div>

        <div className="section" aria-live="polite">
          {cv.supersededById && <Banner tone="warn" title="Bu sürümün yerine yeni sürüm geldi">Bu sürümdeki kararlar yeni sürüme taşınmaz. <Link to={`/sozlesmeler/${cv.supersededById}`}>Güncel sürümü aç</Link></Banner>}
          {s.status.automaticAlert === 'IMAGE_NOT_FOUND_REVIEW_REQUIRED' && <Banner tone="warn" title="İmza görüntüsü bulunamadı — inceleme gerekli">Algılayıcının bulamaması belgenin imzasız olduğu anlamına gelmez. Taraf bazında kaynak sayfayı inceleyin.</Banner>}
          {s.status.automaticAlert === 'AUTOMATIC_CHECK_UNAVAILABLE' && <Banner tone="neutral" title="Otomatik kontrol yapılamadı">İmza tespit servisi bağlı değil veya hata verdi. Manuel inceleme tam olarak çalışır; otomatik kontrol yapılmış sayılmaz.</Banner>}
          {cv.stage === 'ARCHIVE_IMPORT' && <Banner tone="neutral" title="Arşivden alınan sözleşme">İmza durumunun doğrulanmamış olması mevcut borç veya faturaları otomatik geçersiz kılmaz; fatura blokajı kurum politikasına göre finans/hukuk kararıdır.</Banner>}
          {feedback && <Banner tone={feedback.tone} title={feedback.title}>
            {feedback.body}
            {feedback.blockers && <ul className="blockers" style={{ marginTop: 6 }}>{feedback.blockers.map((b, i) => <li key={i}><Icon name="x" size={14} /><span><strong>{b.partyName ?? blockerCodeText[b.code]}</strong> — {blockerCodeText[b.code]}. {b.action}</span></li>)}</ul>}
          </Banner>}

          <h2 style={{ fontSize: 15, marginBottom: 10 }}>Durum</h2>
          <dl className="layer-grid">
            <dt>Sonuç</dt><dd><Tag label={overall} /></dd>
            {s.status.overall === 'EXCEPTION_ACTIVE' && <><dt>Asıl durum</dt><dd><Tag label={overallLabel[s.status.underlying]} /></dd></>}
            <dt>Otomatik tarama</dt><dd><Tag label={detectionLabel[s.status.automaticCheck]} /></dd>
            <dt>Fiziksel asıl</dt><dd><Tag label={custodyLabel[s.status.custody]} />{cv.originalCustodyRequired ? <span className="subtle"> · politika gereği zorunlu</span> : <span className="subtle"> · zorunlu değil</span>}</dd>
            <dt>Kesinleştirme</dt><dd>{finalized ? <span>{fmtDateTime(cv.finalizedAt)} · {overallLabel[cv.finalizedStatus ?? '']?.text}</span> : <span className="muted">Kesinleşmedi</span>}</dd>
          </dl>
          <p className="subtle" style={{ marginTop: 10 }}>İmza görüntüsü teyidi; ıslak mürekkep, imzalayanın kimliği/yetkisi veya hukuki geçerlilik kararı değildir.</p>
        </div>

        <div className="section">
          <div className="btn-row" style={{ justifyContent: 'space-between', marginBottom: 10 }}>
            <h2 style={{ fontSize: 15 }}>Taraflar ve gereksinimler</h2>
            {s.can.defineRequirement && !readOnly && <button className="btn btn-sm" onClick={() => setDrawer('requirements')}>Gereksinim / yöntem</button>}
          </div>
          {s.requirements.length === 0 ? (
            <Empty icon="users" title="Gereksinim tanımlanmadı">Hangi tarafın, hangi yöntemle imzalaması gerektiği belirlenmeden kontrol tamamlanamaz.</Empty>
          ) : s.requirements.map((q) => {
            const res = reqResult(q.id);
            const wet = q.acceptableMethods.includes('WET_IMAGE_REVIEW');
            return (
              <article key={q.id} className="party" aria-labelledby={`p-${q.id}`}>
                <div className="party-head">
                  <div><div id={`p-${q.id}`} className="party-name">{q.partyName}</div>
                    <div className="subtle">{partyRoleLabel[q.partyRole]} · {q.signerRole}{q.requirementCount > 1 ? ` · ${q.requirementCount} imzacı` : ''}{!q.required ? ' · isteğe bağlı' : ''}</div></div>
                  <Tag label={res ? requirementLabel[res.state] : undefined} />
                </div>
                <div className="subtle">Kabul edilen: {q.acceptableMethods.map((m) => methodLabel[m]).join(', ')}</div>
                {wet && res?.slots.map((sl) => (
                  <div key={sl.slot} className="btn-row" style={{ justifyContent: 'space-between' }}>
                    <span className="flex flex-wrap items-center gap-1.5 text-sm">{q.requirementCount > 1 ? `İmzacı ${sl.slot}:` : 'İnsan kararı:'}
                      {sl.decision === 'PENDING' ? <strong>{decisionLabel[sl.decision]}</strong> : <Tag label={{ text: decisionLabel[sl.decision] ?? sl.decision, tone: 'human', icon: 'stamp' }} />}
                      {sl.observedMark ? <span className="text-ink-muted">{markLabel[sl.observedMark]}</span> : null}</span>
                    {s.can.review && !readOnly && <button className="btn btn-sm" onClick={() => setReviewing({ requirementId: q.id, slot: sl.slot })} aria-label={`${q.partyName} için incele`}>
                      <Icon name="pen" size={14} /> İncele</button>}
                  </div>
                ))}
                {res && res.digital !== 'NOT_APPLICABLE' && (
                  <div className="btn-row" style={{ justifyContent: 'space-between' }}>
                    <Tag label={digitalLabel[res.digital]} />
                    {s.can.analyze && !readOnly && res.digital !== 'VALIDATED' && <button className="btn btn-sm"
                      onClick={() => void act(() => api(`/api/v1/contract-versions/${cv.id}/digital-validation-jobs`, { method: 'POST', json: { requirementId: q.id } }), 'E-imza doğrulama isteği kaydedildi.')}>
                      E-imzayı doğrula</button>}
                  </div>
                )}
                {reviewing?.requirementId === q.id && (
                  <ReviewForm requirement={q} slot={reviewing.slot} detections={s.detections} selectedDetection={selectedDetection}
                    onPickDetection={(d) => { setSelectedDetection(d); setTargetPage(s.detections.find((x) => x.id === d)?.page ?? null); }}
                    onCancel={() => setReviewing(null)}
                    onSubmit={async (body) => {
                      const ok = await act(() => api(`/api/v1/contract-versions/${cv.id}/signature-reviews`, { method: 'POST', ifMatch: r.etag, json: { ...body, requirementId: q.id, slot: reviewing.slot, documentSha256: cv.documentSha256 } }), 'İnceleme kararı kaydedildi.');
                      if (ok) setReviewing(null);
                    }} />
                )}
              </article>
            );
          })}
        </div>

        {s.status.blockers.length > 0 && (
          <div className="section">
            <h2 style={{ fontSize: 15, marginBottom: 10 }}>Tamamlanmak için</h2>
            <ul className="blockers">
              {s.status.blockers.map((b, i) => <li key={i}><Icon name={b.code === 'REVIEW_PENDING' ? 'clock' : 'alert'} size={14} />
                <span><strong>{b.partyName ? `${b.partyName}: ` : ''}{blockerCodeText[b.code]}</strong> — {b.action}</span></li>)}
            </ul>
          </div>
        )}

        <div className="section">
          <h2 style={{ fontSize: 15, marginBottom: 10 }}>Otomatik tarama</h2>
          {s.detectionRuns.filter((x) => x.appliesToCurrentDocument).length === 0 ? <p className="muted">Bu belge sürümü için tarama istenmedi.</p>
            : s.detectionRuns.filter((x) => x.appliesToCurrentDocument).slice(0, 1).map((run) => (
              <div key={run.id} style={{ display: 'grid', gap: 6 }}>
                <Tag label={detectionLabel[run.status]} />
                <span className="subtle">{run.provider === 'none' ? 'Sağlayıcı yapılandırılmadı' : `Sağlayıcı: ${run.provider} · ${run.modelVersion}`} · {fmtDateTime(run.createdAt)}
                  {run.totalPages ? ` · işlenen sayfa ${run.processedPages.length}/${run.totalPages}` : ''}</span>
              </div>))}
          {s.detections.length > 0 && (
            <ul className="blockers" style={{ marginTop: 10 }} aria-label="İmza görüntüsü adayları">
              {s.detections.map((d, i) => <li key={d.id}><Icon name="sparkles" size={14} />
                <button className="btn btn-ghost btn-sm" onClick={() => { setSelectedDetection(d.id); setTargetPage(d.page); }}>AI adayı {i + 1} · sayfa {d.page}{d.rawConfidence ? ` · ham skor ${d.rawConfidence}` : ''}</button></li>)}
            </ul>
          )}
          {s.can.analyze && !readOnly && <button className="btn btn-sm" style={{ marginTop: 10 }}
            onClick={() => void act(() => api(`/api/v1/contract-versions/${cv.id}/signature-analysis-jobs`, { method: 'POST' }), 'Tarama isteği kaydedildi. Sonuç hazır olduğunda burada görünür.')}>
            Otomatik tarama iste</button>}
        </div>

        <div className="section">
          <div className="btn-row" style={{ justifyContent: 'space-between', marginBottom: 10 }}>
            <h2 style={{ fontSize: 15 }}>İstisnalar</h2>
            {s.can.requestException && !readOnly && s.status.blockers.some((b) => b.requirementId) && <button className="btn btn-sm" onClick={() => setDrawer('exception')}>İstisna talep et</button>}
          </div>
          {s.exceptions.length === 0 ? <p className="muted">İstisna yok.</p> : <ol className="timeline">
            {s.exceptions.map((x) => (
              <li key={x.id}>
                <strong>{x.expired ? 'Süresi doldu' : x.status === 'APPROVED' ? 'Onaylı' : x.status === 'REJECTED' ? 'Reddedildi' : 'Karar bekliyor'} · bitiş {fmtDate(x.expiresAt)}</strong>
                <span>{x.reason}</span><span className="subtle">Kapsam: {x.scope} · Kalan risk: {x.residualRisk}</span>
                {x.status === 'REQUESTED' && s.can.decideException && <div className="btn-row" style={{ marginTop: 4 }}>
                  <DecideException onDecide={(decision, rationale) => act(() => api(`/api/v1/signature-exceptions/${x.id}/decision`, { method: 'POST', json: { decision, rationale } }), decision === 'APPROVED' ? 'İstisna onaylandı.' : 'İstisna reddedildi.')} />
                </div>}
              </li>))}
          </ol>}
        </div>

        <div className="section">
          <div className="btn-row" style={{ justifyContent: 'space-between', marginBottom: 10 }}>
            <h2 style={{ fontSize: 15 }}>Fiziksel asıl</h2>
            {s.can.custody && <button className="btn btn-sm" onClick={() => setDrawer('custody')}>Kayıt ekle</button>}
          </div>
          {s.custodyEvents.length === 0 ? <p className="muted">Teslim veya muhafaza kaydı yok.</p> : <ol className="timeline">
            {s.custodyEvents.map((c, i) => <li key={i}><strong>{custodyLabel[c.status]?.text}</strong><span>{c.location}</span><span className="subtle">{fmtDateTime(c.occurred_at)}</span></li>)}
          </ol>}
        </div>

        <div className="section">
          <h2 style={{ fontSize: 15, marginBottom: 10 }}>İnceleme geçmişi</h2>
          {s.reviews.length === 0 ? <p className="muted">Henüz insan kararı yok.</p> : <ol className="timeline">
            {[...s.reviews].reverse().map((v) => {
              const q = s.requirements.find((x) => x.id === v.requirementId);
              return <li key={v.id} className="border-l-istampa!"><strong>{q?.partyName ?? 'Taraf'}: <span className="text-istampa">{decisionLabel[v.decision]}</span> · {markLabel[v.observedMark]}</strong><span>{v.rationale}</span>
                <span className="subtle">{v.reviewerName} · {fmtDateTime(v.reviewedAt)}{v.page ? ` · sayfa ${v.page}` : ''}{!v.appliesToCurrentDocument ? ' · başka belge sürümü' : ''}</span></li>;
            })}
          </ol>}
        </div>

        <div className="section" style={{ position: 'sticky', bottom: 0, background: 'var(--surface)', borderTop: '1px solid var(--border)' }}>
          <div className="btn-row" style={{ justifyContent: 'space-between' }}>
            {s.can.manage && !cv.supersededById && <button className="btn" onClick={() => setDrawer('version')}>Yeni sürüm / zeyilname</button>}
            {s.can.finalize && !readOnly && (
              <button className="btn btn-primary" disabled={!s.status.canFinalize} aria-describedby="finalize-hint"
                onClick={() => void act(() => api(`/api/v1/contract-versions/${cv.id}/finalize-signature-review`, { method: 'POST', ifMatch: r.etag }), 'İmza kontrolü bu sürüm için kesinleşti.')}>
                İmza kontrolünü kesinleştir</button>
            )}
          </div>
          {s.can.finalize && !readOnly && !s.status.canFinalize && <p id="finalize-hint" className="subtle" style={{ marginTop: 6 }}>Kesinleştirme için yukarıdaki eksikler giderilmeli veya yetkili istisna onaylanmalı.</p>}
        </div>
      </>} />

      {drawer === 'exception' && <ExceptionDrawer s={s} onClose={() => setDrawer(null)} onSubmit={(b) => act(() => api(`/api/v1/contract-versions/${cv.id}/signature-exceptions`, { method: 'POST', json: b }), 'İstisna talebi kaydedildi; başka bir hukuk yetkilisinin kararı gerekir.').then((ok) => { if (ok) setDrawer(null); })} />}
      {drawer === 'custody' && <CustodyDrawer onClose={() => setDrawer(null)} onSubmit={(b) => act(() => api(`/api/v1/contract-versions/${cv.id}/original-custody-events`, { method: 'POST', json: b }), 'Fiziksel asıl kaydı eklendi.').then((ok) => { if (ok) setDrawer(null); })} />}
      {drawer === 'requirements' && <RequirementsDrawer s={s} etag={r.etag} onClose={() => setDrawer(null)} onDone={async (msg) => { setFeedback({ tone: 'info', title: msg }); await r.reload(); setDrawer(null); }} />}
      {drawer === 'version' && <VersionDrawer s={s} etag={r.etag} onClose={() => setDrawer(null)} />}
    </>
  );
}

function ReviewForm({ requirement, slot, detections, selectedDetection, onPickDetection, onCancel, onSubmit }: {
  requirement: Status['requirements'][number]; slot: number; detections: Status['detections']; selectedDetection: string | null;
  onPickDetection: (id: string) => void; onCancel: () => void; onSubmit: (b: { decision: string; observedMark: string; rationale: string; page: number | null; detectionId: string | null }) => Promise<void>;
}) {
  const [decision, setDecision] = useState('');
  const [mark, setMark] = useState('FULL_SIGNATURE');
  const [rationale, setRationale] = useState('');
  const [page, setPage] = useState<string>(requirement.page ? String(requirement.page) : '');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const markOptions = decision === 'IMAGE_CONFIRMED' ? ['FULL_SIGNATURE'] : ['NONE', 'STAMP_ONLY', 'INITIALS_ONLY', 'NAME_ONLY', 'ILLEGIBLE', 'FULL_SIGNATURE'];

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const er: Record<string, string> = {};
    if (!decision) er.decision = 'Bir karar seçin.';
    if (rationale.trim().length < 3) er.rationale = 'Gerekçe yazın (ör. hangi sayfada ne gördünüz).';
    setErrors(er);
    if (Object.keys(er).length) { document.getElementById(er.decision ? 'dec-0' : 'rev-rationale')?.focus(); return; }
    setBusy(true);
    await onSubmit({ decision, observedMark: decision === 'IMAGE_CONFIRMED' ? 'FULL_SIGNATURE' : mark, rationale: rationale.trim(), page: page ? Number(page) : null, detectionId: selectedDetection });
    setBusy(false);
  }

  return (
    <form onSubmit={submit} style={{ borderTop: '1px solid var(--border)', paddingTop: 12, marginTop: 4 }} aria-label={`${requirement.partyName} imza incelemesi`}>
      {Object.keys(errors).length > 0 && <Banner tone="danger" title="Formda düzeltilecek alanlar var">{Object.values(errors).join(' ')}</Banner>}
      <fieldset className="field">
        <legend>Karar{requirement.requirementCount > 1 ? ` (imzacı ${slot})` : ''}</legend>
        <div className="radio-list">
          {[['IMAGE_CONFIRMED', 'İmza görüntüsü var', 'Bu taraf için tam imza görüntüsü kaynak sayfada görülüyor.'],
            ['MISSING', 'İmza eksik', 'Gerekli imza görüntüsü yok. Yeniden imzalı belge istenir.'],
            ['UNCLEAR', 'Belirsiz', 'Okunamıyor, kırpık veya taraf eşleştirilemiyor. Daha iyi belge istenir.']].map(([v, l, h], i) => (
            <label key={v}><input id={`dec-${i}`} type="radio" name="decision" value={v} checked={decision === v} onChange={() => { setDecision(v!); if (v === 'IMAGE_CONFIRMED') setMark('FULL_SIGNATURE'); else if (mark === 'FULL_SIGNATURE') setMark('NONE'); }} />
              <span><strong>{l}</strong><br /><span className="subtle">{h}</span></span></label>))}
        </div>
      </fieldset>
      {decision && decision !== 'IMAGE_CONFIRMED' && (
        <Field label="Görülen işaret" hint="Kaşe, paraf veya yazılı isim tam imza sayılmaz.">
          {(p) => <select className="input" {...p} value={mark} onChange={(e) => setMark(e.target.value)}>{markOptions.map((m) => <option key={m} value={m}>{markLabel[m]}</option>)}</select>}
        </Field>
      )}
      {detections.length > 0 && (
        <Field label="İlgili otomatik aday (isteğe bağlı)" hint="Seçmek kaynak sayfaya götürür. Aday, insan kararının yerine geçmez.">
          {(p) => <select className="input" {...p} value={selectedDetection ?? ''} onChange={(e) => e.target.value && onPickDetection(e.target.value)}>
            <option value="">Aday seçilmedi</option>{detections.map((d, i) => <option key={d.id} value={d.id}>AI adayı {i + 1} · sayfa {d.page}</option>)}</select>}
        </Field>
      )}
      <Field label="Sayfa" hint="Kararın dayandığı kaynak sayfa.">{(p) => <input className="input num" style={{ width: 100 }} type="number" min={1} {...p} value={page} onChange={(e) => setPage(e.target.value)} />}</Field>
      <Field label="Gerekçe" error={errors.rationale} id="rev-rationale">{(p) => <textarea className="input" {...p} value={rationale} onChange={(e) => setRationale(e.target.value)} />}</Field>
      <div className="btn-row"><button type="button" className="btn" onClick={onCancel}>Vazgeç</button><button type="submit" className="btn btn-primary" disabled={busy}>{busy ? 'Kaydediliyor…' : 'Kararı kaydet'}</button></div>
    </form>
  );
}

function DecideException({ onDecide }: { onDecide: (d: 'APPROVED' | 'REJECTED', rationale: string) => Promise<unknown> }) {
  const [rationale, setRationale] = useState('');
  return (<>
    <label className="sr-only" htmlFor="exc-r">Karar gerekçesi</label>
    <input id="exc-r" className="input" placeholder="Karar gerekçesi" value={rationale} onChange={(e) => setRationale(e.target.value)} style={{ flex: 1, minWidth: 160 }} />
    <button className="btn btn-sm" disabled={rationale.trim().length < 3} onClick={() => void onDecide('REJECTED', rationale)}>Reddet</button>
    <button className="btn btn-sm btn-primary" disabled={rationale.trim().length < 3} onClick={() => void onDecide('APPROVED', rationale)}>Onayla</button>
  </>);
}

function ExceptionDrawer({ s, onClose, onSubmit }: { s: Status; onClose: () => void; onSubmit: (b: unknown) => void }) {
  const open = s.status.blockers.filter((b) => b.requirementId).map((b) => b.requirementId!);
  const [sel, setSel] = useState<string[]>(open);
  const [b, setB] = useState({ reason: '', residualRisk: '', scope: '', expiresAt: '' });
  const [err, setErr] = useState<Record<string, string>>({});
  function submit() {
    const e: Record<string, string> = {};
    if (!sel.length) e.sel = 'En az bir gereksinim seçin.';
    if (b.reason.trim().length < 3) e.reason = 'Gerekçe gerekli.';
    if (b.residualRisk.trim().length < 3) e.residualRisk = 'Kalan riski yazın.';
    if (b.scope.trim().length < 3) e.scope = 'Kapsamı yazın.';
    if (!b.expiresAt) e.expiresAt = 'Bitiş tarihi gerekli.';
    setErr(e);
    if (!Object.keys(e).length) onSubmit({ requirementIds: sel, ...b, expiresAt: new Date(`${b.expiresAt}T23:59:00+03:00`).toISOString() });
  }
  return (
    <Drawer title="İmza istisnası talep et" onClose={onClose} footer={<><button className="btn" onClick={onClose}>Vazgeç</button><button className="btn btn-primary" onClick={submit}>Talebi gönder</button></>}>
      <Banner tone="neutral" title="İstisna eksikliği silmez">Onaylanırsa durum “Eksik — yetkili istisna ile işlem” olarak görünür. Talebi siz onaylayamazsınız; süre dolunca kontrol yeniden açılır.</Banner>
      <fieldset className="field"><legend>Kapsanan gereksinimler</legend>
        {open.map((rid) => { const q = s.requirements.find((x) => x.id === rid); return (
          <label key={rid} style={{ display: 'flex', gap: 8 }}><input type="checkbox" checked={sel.includes(rid)} onChange={(e) => setSel(e.target.checked ? [...sel, rid] : sel.filter((x) => x !== rid))} />{q?.partyName} — {q?.signerRole}</label>); })}
        {err.sel && <span className="error">{err.sel}</span>}
      </fieldset>
      <Field label="Gerekçe" error={err.reason}>{(p) => <textarea className="input" {...p} value={b.reason} onChange={(e) => setB({ ...b, reason: e.target.value })} />}</Field>
      <Field label="Kapsam" hint="Hangi işlemlere izin verildiği (ör. yalnız hizmet başlangıcı)." error={err.scope}>{(p) => <input className="input" {...p} value={b.scope} onChange={(e) => setB({ ...b, scope: e.target.value })} />}</Field>
      <Field label="Kalan risk" error={err.residualRisk}>{(p) => <textarea className="input" {...p} value={b.residualRisk} onChange={(e) => setB({ ...b, residualRisk: e.target.value })} />}</Field>
      <Field label="Bitiş tarihi" hint="En fazla 1 yıl." error={err.expiresAt}>{(p) => <input className="input" type="date" {...p} value={b.expiresAt} onChange={(e) => setB({ ...b, expiresAt: e.target.value })} />}</Field>
    </Drawer>
  );
}

function CustodyDrawer({ onClose, onSubmit }: { onClose: () => void; onSubmit: (b: unknown) => void }) {
  const { me } = useSession();
  const [b, setB] = useState({ status: 'RECEIPT_DECLARED', location: '', occurredAt: '' });
  const [err, setErr] = useState<Record<string, string>>({});
  function submit() {
    const e: Record<string, string> = {};
    if (b.location.trim().length < 2) e.location = 'Arşiv yerini yazın.';
    if (!b.occurredAt) e.occurredAt = 'Tarih gerekli.';
    setErr(e);
    if (!Object.keys(e).length) onSubmit({ ...b, responsibleUserId: me!.user.id, occurredAt: new Date(`${b.occurredAt}T12:00:00+03:00`).toISOString() });
  }
  return (
    <Drawer title="Fiziksel asıl kaydı" onClose={onClose} footer={<><button className="btn" onClick={onClose}>Vazgeç</button><button className="btn btn-primary" onClick={submit}>Kaydet</button></>}>
      <p className="muted" style={{ marginBottom: 12 }}>Bu kayıt teslim/muhafaza izidir; mürekkep veya özgünlük analizi değildir.</p>
      <fieldset className="field"><legend>Kayıt türü</legend><div className="radio-list">
        <label><input type="radio" checked={b.status === 'RECEIPT_DECLARED'} onChange={() => setB({ ...b, status: 'RECEIPT_DECLARED' })} />Teslim beyan edildi</label>
        <label><input type="radio" checked={b.status === 'CUSTODY_CONFIRMED'} onChange={() => setB({ ...b, status: 'CUSTODY_CONFIRMED' })} />Muhafaza teyit edildi</label>
      </div></fieldset>
      <Field label="Arşiv yeri" error={err.location}>{(p) => <input className="input" {...p} value={b.location} onChange={(e) => setB({ ...b, location: e.target.value })} />}</Field>
      <Field label="Tarih" error={err.occurredAt}>{(p) => <input className="input" type="date" {...p} value={b.occurredAt} onChange={(e) => setB({ ...b, occurredAt: e.target.value })} />}</Field>
    </Drawer>
  );
}

function RequirementsDrawer({ s, etag, onClose, onDone }: { s: Status; etag: string | null; onClose: () => void; onDone: (msg: string) => Promise<void> }) {
  const cv = s.contractVersion;
  const [method, setMethod] = useState(cv.signatureMethod);
  const [custody, setCustody] = useState(cv.originalCustodyRequired);
  const [party, setParty] = useState(s.parties[0]?.id ?? '');
  const [signerRole, setSignerRole] = useState('Yetkili imzacı');
  const [methods, setMethods] = useState<string[]>(['WET_IMAGE_REVIEW']);
  const [error, setError] = useState<string | null>(null);
  async function savePolicy() {
    setError(null);
    try { await api(`/api/v1/contract-versions/${cv.id}/signature-policy`, { method: 'PATCH', ifMatch: etag, json: { signatureMethod: method, originalCustodyRequired: custody } }); await onDone('İmza yöntemi ve asıl politikası güncellendi.'); }
    catch (e) { setError((e as ApiError).message); }
  }
  async function addReq() {
    setError(null);
    try { await api(`/api/v1/contract-versions/${cv.id}/signature-requirements`, { method: 'POST', ifMatch: etag, json: { partyId: party, signerRole, acceptableMethods: methods } }); await onDone('Gereksinim eklendi; sonuç yeniden hesaplandı.'); }
    catch (e) { setError((e as ApiError).message); }
  }
  return (
    <Drawer title="İmza yöntemi ve gereksinimler" onClose={onClose}>
      {error && <Banner tone="danger" title={error} />}
      <h3 style={{ fontSize: 14, marginBottom: 8 }}>Belge yöntemi</h3>
      <Field label="Yöntem">{(p) => <select className="input" {...p} value={method} onChange={(e) => setMethod(e.target.value)}>{Object.entries(methodLabel).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select>}</Field>
      <label style={{ display: 'flex', gap: 8, marginBottom: 12 }}><input type="checkbox" checked={custody} onChange={(e) => setCustody(e.target.checked)} />Fiziksel asıl muhafazası zorunlu</label>
      <button className="btn" onClick={() => void savePolicy()}>Yöntemi kaydet</button>
      <hr style={{ border: 0, borderTop: '1px solid var(--border)', margin: '20px 0' }} />
      <h3 style={{ fontSize: 14, marginBottom: 8 }}>Yeni gereksinim</h3>
      <Field label="Taraf">{(p) => <select className="input" {...p} value={party} onChange={(e) => setParty(e.target.value)}>{s.parties.map((x) => <option key={x.id} value={x.id}>{x.displayName} ({partyRoleLabel[x.role]})</option>)}</select>}</Field>
      <Field label="İmzacı rolü">{(p) => <input className="input" {...p} value={signerRole} onChange={(e) => setSignerRole(e.target.value)} />}</Field>
      <fieldset className="field"><legend>Kabul edilen yöntemler</legend>
        {['WET_IMAGE_REVIEW', 'QUALIFIED_ELECTRONIC', 'ELECTRONIC_OTHER'].map((m) => (
          <label key={m} style={{ display: 'flex', gap: 8 }}><input type="checkbox" checked={methods.includes(m)} onChange={(e) => setMethods(e.target.checked ? [...methods, m] : methods.filter((x) => x !== m))} />{methodLabel[m]}</label>))}
      </fieldset>
      <button className="btn btn-primary" disabled={!party || !methods.length || signerRole.trim().length < 1} onClick={() => void addReq()}>Gereksinimi ekle</button>
    </Drawer>
  );
}

function VersionDrawer({ s, etag, onClose }: { s: Status; etag: string | null; onClose: () => void }) {
  const nav = useNavigate();
  const [file, setFile] = useState<File | null>(null);
  const [kind, setKind] = useState('AMENDMENT');
  const [addSupplierId, setAddSupplierId] = useState('');
  const sup = useResource<{ items: SupplierOption[] }>('/api/v1/supplier-options');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  async function submit() {
    if (!file) { setError('PDF seçin.'); return; }
    setBusy(true); setError(null);
    try {
      const fd = new FormData();
      fd.set('companyId', s.contractVersion.companyId); fd.set('kind', 'CONTRACT'); fd.set('title', file.name); fd.set('file', file);
      const up = await api<{ documentVersionId: string; basicCheckStatus: string; basicCheckReason: string | null }>('/api/v1/documents', { method: 'POST', body: fd });
      if (up.data.basicCheckStatus !== 'PASSED') throw new ApiError(422, 'quarantined', `Belge karantinaya alındı: ${up.data.basicCheckReason}`);
      const v = await api<{ contractVersionId: string }>(`/api/v1/contract-versions/${s.contractVersion.id}/versions`, { method: 'POST', ifMatch: etag, json: { documentVersionId: up.data.documentVersionId, kind, stage: 'EXECUTION', ...(kind === 'AMENDMENT' && addSupplierId ? { addSupplierId } : {}) } });
      onClose();
      nav(`/sozlesmeler/${v.data.contractVersionId}`);
    } catch (e) { setError((e as ApiError).message); } finally { setBusy(false); }
  }
  return (
    <Drawer title="Yeni sürüm veya zeyilname" onClose={onClose} footer={<><button className="btn" onClick={onClose}>Vazgeç</button><button className="btn btn-primary" disabled={busy} onClick={() => void submit()}>{busy ? 'Yükleniyor…' : 'Yükle ve sürüm oluştur'}</button></>}>
      <Banner tone="neutral" title="Önceki imza kararları yeni sürüme taşınmaz">Taraf ve gereksinim tanımları kopyalanır; yeni belge için inceleme yeniden yapılır. Eski sürümün delilleri korunur.</Banner>
      {error && <Banner tone="danger" title={error} />}
      <Field label="Tür">{(p) => <select className="input" {...p} value={kind} onChange={(e) => setKind(e.target.value)}><option value="AMENDMENT">Zeyilname</option><option value="MAIN">Ana belge yeni sürüm</option><option value="ANNEX">Ek</option></select>}</Field>
      {kind === 'AMENDMENT' && <Field label="Eklenecek tedarikçi tarafı (varsa)" hint="Devir veya ek taraf için. İmza gerektiren sözleşmede bu taraf için zorunlu imza gereksinimi açılır.">{(p) => <select className="input" {...p} value={addSupplierId} onChange={(e) => setAddSupplierId(e.target.value)}><option value="">Taraf eklenmiyor</option>{sup.data?.items.filter((x) => x.status === 'ACTIVE').map((x) => <option key={x.id} value={x.id}>{x.label ?? x.legalName}</option>)}</select>}</Field>}
      <Field label="Belge (PDF)" hint="En fazla 25 MB.">{(p) => (
        <div className="flex flex-wrap items-center gap-3">
          <input className="peer sr-only" type="file" accept="application/pdf" {...p} onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
          <label htmlFor={p.id} className="btn cursor-pointer peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-focus"><Icon name="file" />Dosya seç</label>
          <span className={file ? 'font-semibold text-ink' : 'text-ink-subtle'}>{file ? file.name : 'Dosya seçilmedi'}</span>
        </div>
      )}</Field>
    </Drawer>
  );
}
