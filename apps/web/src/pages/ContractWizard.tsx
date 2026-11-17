import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Link, Navigate, useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import { api, ApiError } from '../lib/api.ts';
import { useResource } from '../lib/useApi.ts';
import { hasRole, useSession } from '../lib/session.tsx';
import { fmtDate, fmtMoney } from '../lib/format.ts';
import { supplierPickHint, supplierStatus, type SupplierOption } from '../lib/labels.ts';
import { CONTRACT_TYPES, statusTag, type ApprovalPreview, type ContractType, type ContractV2, type Template } from '../lib/contractsV2.ts';
import { Banner, ErrorState, Field, Loading, PageHeader, Tag } from '../ui/kit.tsx';
import { Icon } from '../ui/icons.tsx';
import { useDepartments } from '../ui/Departments.tsx';
import { DocumentViewer } from '../ui/DocumentViewer.tsx';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { IntakeForm } from './IntakePage.tsx';
import { CONFIDENCE, flagTexts, formatAiValue, ReviewCard, runLabel, runReason, sameDecimal, TestProviderTag, usePolled, WAITING,
  type AiRunStatus, type Decision, type ExtractionField, type ExtractionsRes } from './ContractReview.tsx';

/**
 * v2 Faz 3 (D108, Figma 08–09): sözleşme ekleme sihirbazı. 1 Yükle (mevcut yükleme formu + proje), 2 Oku, 3 Tamamla ve doğrula (belge solda,
 * alanlar sağda), 4 İncele ve gönder. Taslak sunucuda tutulur: adres `?taslak=<aile>&adim=N` yenilemede ve geri dönüşte aynı yerden açar.
 * v2 Faz 4 (D109): Oku adımı yapay zekâ okumasını (AI06) gösterir; 3. adımda öneriler. Tutar, para birimi, tarihler ve VKN forma önceden yazılmaz
 * ("Öneriyi kullan" insan eylemidir); kararlar alan kaydıyla (`aiDecisions`) yazılır. Okuma çalışmazsa sebep görünür ve elle akış Faz 3'teki gibidir.
 */
const STEPS = ['Yükle', 'Oku', 'Tamamla ve doğrula', 'İncele ve gönder'] as const;
/** Okuma iş durumuna göre dürüst tek satır (3. adım bandı ve Oku adımı). SUCCEEDED için null. */
export function aiReadLine(ex: ExtractionsRes | null, failedToLoad: boolean): string | null {
  if (!ex) return failedToLoad ? 'Yapay zekâ okumasının durumu alınamadı; alanları belgeden siz girin.' : null;
  const run = ex.run;
  if (!run) return 'Yapay zekâ okuması yapılmadı; alanları belgeden siz girin.';
  if (run.status === 'SUCCEEDED') return null;
  if (run.status === 'QUEUED' || run.status === 'RUNNING') return 'Yapay zekâ okuması sürüyor; alanları beklemeden belgeden girebilirsiniz.';
  if (run.status === 'FAILED') return `Yapay zekâ okuması tamamlanamadı: ${runReason(run)} Alanları belgeden siz girin.`;
  return `Yapay zekâ okuması çalışmadı: ${runReason(run)} Alanları belgeden siz girin.`;
}

export function ContractWizard() {
  const [params] = useSearchParams();
  const familyId = params.get('taslak');
  const step = familyId ? Math.min(4, Math.max(2, Number(params.get('adim')) || 3)) : 1;
  return familyId ? <DraftSteps key={familyId} familyId={familyId} step={step} /> : <UploadStep />;
}

function StepIndicator({ current, readNote }: { current: number; readNote?: string }) {
  return (
    <ol aria-label="Sözleşme ekleme adımları" className="mb-5 flex flex-wrap items-center gap-x-2 gap-y-2">
      {STEPS.map((s, i) => {
        const n = i + 1;
        return (
          <li key={s} className="flex items-center gap-2" aria-current={n === current ? 'step' : undefined}>
            <span className={cn('tabular grid size-6 place-items-center rounded-full text-sm font-semibold',
              n === current ? 'bg-ink text-primary-foreground' : n < current ? 'bg-verified-soft text-verified' : 'bg-sunken text-ink-muted')}>{n}</span>
            <span className={cn('text-sm', n === current ? 'font-semibold text-ink' : 'text-ink-muted')}>{s}{n === 2 && n < current && readNote ? ` · ${readNote}` : ''}</span>
            {n < STEPS.length && <Icon name="chevron" size={14} className="text-ink-subtle" />}
          </li>
        );
      })}
    </ol>
  );
}

/** İptal edilmiş ya da sonuçsuz kapanmış projeye yeni sözleşme bağlanmaz (listede sunulmaz). */
const CLOSED = new Set(['CANCELLED', 'NO_AWARD']);
interface ProjectRow { id: string; code: string; title: string; companyName: string; departmentId: string | null; departmentName: string | null; status: string }

// --- 1. Yükle ---------------------------------------------------------------------------------------------------------------

function UploadStep() {
  const { me } = useSession();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const projects = useResource<{ items: ProjectRow[] }>('/api/v1/projects');
  const templates = useResource<{ items: Template[] }>('/api/v1/contract-templates');
  const [projectId, setProjectId] = useState(params.get('proje') ?? '');
  const [templateVersionId, setTemplateVersionId] = useState(params.get('sablon') ?? '');
  const [draftError, setDraftError] = useState<string | null>(null);
  const canIntake = hasRole(me, 'PROCUREMENT', 'DEPARTMENT_USER');
  const back = <Button variant="outline" asChild><Link to="/sozlesmeler">Sözleşmeler</Link></Button>;
  if (!me?.companies.length) return <div className="page"><PageHeader title="Sözleşme ekle" actions={back} /><Banner tone="neutral" icon="lock" title="Belge yükleyebileceğiniz şirket yok">Şirket kapsamı tanımlı değil.</Banner></div>;
  const companyName = (id: string) => me.companies.find((c) => c.id === id)?.name;
  const current = templates.data?.items.flatMap((t) => t.currentVersion ? [{ t, v: t.currentVersion }] : []) ?? [];
  const chosen = current.find((x) => x.v.id === templateVersionId);
  const supersededPick = templateVersionId && templates.data && !chosen;
  return (
    <div className="page" style={{ maxWidth: 860 }}>
      <PageHeader title="Sözleşme ekle" actions={back}>
        Belgeyi yükleyin ve sözleşmenin bağlı olduğu projeyi seçin. Alanları sonraki adımda belgeden siz girersiniz; e-Fatura, teklif ve diğer belgeler de bu ekrandan yüklenir.
      </PageHeader>
      <StepIndicator current={1} />
      <IntakeForm initialKind="CONTRACT"
        submitBlocked={(kind) => kind === 'CONTRACT' && canIntake && !projectId ? 'Sözleşme için proje seçin.' : null}
        extra={(kind, companyId) => kind === 'CONTRACT' && canIntake ? (
          <>
            <Field label="Proje" hint="Zorunlu. Sözleşmenin departmanı projenin departmanından gelir; sonraki adımda değiştirebilirsiniz.">
              {(p) => projects.loading && !projects.data ? <span className="text-sm text-ink-muted">Projeler yükleniyor…</span> : (
                <select className="input" required {...p} value={projectId} onChange={(e) => setProjectId(e.target.value)}>
                  <option value="">Seçin</option>
                  {(projects.data?.items ?? []).filter((x) => (!companyName(companyId) || x.companyName === companyName(companyId)) && (!CLOSED.has(x.status) || x.id === projectId)).map((x) =>
                    <option key={x.id} value={x.id}>{x.code} · {x.title}{x.departmentName ? ` · ${x.departmentName}` : ''}</option>)}
                </select>
              )}
            </Field>
            <Field label="Kullanılan şablon" hint={chosen ? `Tür: ${CONTRACT_TYPES[chosen.t.contractType]} · sürüm v${chosen.v.versionNo}` : 'İsteğe bağlı. Kurum şablonundan hazırlandıysa seçin; tür buradan gelir.'}>
              {(p) => <select className="input" {...p} value={templateVersionId} onChange={(e) => setTemplateVersionId(e.target.value)}>
                <option value="">Şablon kullanılmadı</option>
                {current.map(({ t, v }) => <option key={v.id} value={v.id}>{t.code} · {t.name} (v{v.versionNo})</option>)}
              </select>}
            </Field>
            {supersededPick && <Banner tone="warn" title="Seçilen şablon sürümü güncel değil">Yeni sözleşmede yalnız güncel sürüm kullanılır; listeden güncel sürümü seçin.</Banner>}
            {projects.error ? <Banner tone="danger" title="Projeler yüklenemedi">Yeniden deneyin.</Banner> : null}
          </>
        ) : kind === 'CONTRACT' ? <Banner tone="info" title="Sözleşme kaydını Satınalma ya da departman kullanıcısı açar">Belge yüklenir; sözleşme alanları rolünüze açık değildir.</Banner> : null}
        onResult={async (r, ctx) => {
          if (ctx.kind !== 'CONTRACT' || !canIntake) return false;
          // Güvenlik kontrolünden geçmeyen belgeyle taslak açılmaz; sonuç kartı (karantina nedeni) eskisi gibi gösterilir.
          if (r.basicCheckStatus !== 'PASSED') return false;
          setDraftError(null);
          try {
            const res = await api<{ familyId: string; duplicateOf: { familyId: string; code: string; title: string } | null;
              extraction?: { runId: string | null; status: AiRunStatus; reason: string | null } | null }>('/api/v1/contract-drafts', { method: 'POST', json: {
              documentVersionId: r.documentVersionId, projectId, templateVersionId: templateVersionId || null } });
            const dup = res.data.duplicateOf ? `&ayni=${encodeURIComponent(`${res.data.duplicateOf.code} · ${res.data.duplicateOf.title}`)}` : '';
            // v2 Faz 4 (R11): okuma istendiyse Oku adımı açılır; sağlayıcı/politika yoksa ya da istenemediyse Faz 3'teki gibi doğrudan 3. adım (sebep bantta).
            const ex = res.data.extraction;
            const read = !!ex && !!ex.runId && !['NO_PROVIDER', 'NOT_ALLOWED'].includes(ex.status);
            navigate(`/sozlesmeler/ekle?taslak=${res.data.familyId}&adim=${read ? 2 : 3}${dup}`, { state: { upload: {
              message: r.processing.message,
              detail: r.basicCheckReason ?? (r.avScanStatus === 'NOT_AVAILABLE' ? 'Yerleşik dosya kontrolleri geçti. Antivirüs taraması bu ortamda bağlı değil.' : null),
              supplier: r.supplier?.message ?? null, supplierWarn: !!r.supplier && ['SELLER_IS_OWN_COMPANY', 'IDENTITY_REVIEW_REQUIRED', 'MATCHED_RESTRICTED'].includes(r.supplier.outcome),
            } satisfies UploadNote } });
            return true;
          } catch (e) {
            setDraftError((e as ApiError).message);
            return false;
          }
        }} />
      {draftError && <Banner tone="danger" title="Belge yüklendi, sözleşme taslağı açılamadı">{draftError} Proje ya da şablon seçimini düzeltip aynı dosyayı yeniden yükleyin; aynı dosya için yeni belge kaydı açılmaz.</Banner>}
    </div>
  );
}

// --- 2–4. Taslak üzerindeki adımlar --------------------------------------------------------------------------------------------

interface UploadNote { message: string; detail: string | null; supplier: string | null; supplierWarn: boolean }

function DraftSteps({ familyId, step }: { familyId: string; step: number }) {
  const location = useLocation();
  const upload = (location.state as { upload?: UploadNote } | null)?.upload ?? null;
  // "Tutar, tarih ve VKN'yi belgeyle karşılaştırdım." onayı adım durumunda tutulur: işaretlenmeden 4. adım açılmaz (yenileme ya da bağlantı 3'e döner).
  const [ack, setAck] = useState(false);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const first = useRef(true);
  useEffect(() => { if (first.current) { first.current = false; return; } headingRef.current?.focus(); }, [step]);
  const r = useResource<ContractV2>(`/api/v1/contracts/${familyId}/v2`);
  const ex = usePolled<ExtractionsRes>(`/api/v1/contracts/${familyId}/extractions`);
  const [params, setParams] = useSearchParams();
  const go = (n: number) => { const p = new URLSearchParams(params); p.set('adim', String(n)); p.delete('ayni'); setParams(p, { state: location.state }); };
  if (step === 4 && !ack) { const p = new URLSearchParams(params); p.set('adim', '3'); return <Navigate to={`/sozlesmeler/ekle?${p}`} replace state={location.state} />; }
  if (r.loading && !r.data) return <div className="page"><Loading rows={6} /></div>;
  if (r.error || !r.data) return <div className="page"><ErrorState error={r.error} onRetry={r.reload} /></div>;
  const d = r.data;
  const dup = params.get('ayni');
  return (
    <div className="page">
      <PageHeader title="Sözleşme ekle" actions={step === 4 ? undefined : <Button variant="outline" asChild><Link to={d.document ? `/sozlesmeler/${d.document.contractVersionId}?sekme=ozet` : '/sozlesmeler'}>Sözleşmeye dön</Link></Button>}>
        <span className="tabular">{d.family.code}</span> · {d.family.title} <Tag className="ml-1 align-middle" label={statusTag(d.status.code, d.status.label)} />
      </PageHeader>
      <StepIndicator current={step} readNote={ex.data?.run?.status === 'SUCCEEDED' ? undefined : ex.data ? 'okunmadı' : undefined} />
      <h2 ref={headingRef} tabIndex={-1} className="sr-only">Adım {step}: {STEPS[step - 1]}</h2>
      {upload && step <= 3 && <Banner tone="info" icon="check" title={upload.message}>{upload.detail}</Banner>}
      {upload?.supplier && step <= 3 && <Banner tone={upload.supplierWarn ? 'warn' : 'info'} title={upload.supplier} />}
      {dup && <Banner tone="warn" title="Aynı belge başka bir sözleşmede de kayıtlı">{dup}. Yanlışlıkla ikinci kez eklendiyse bu taslağı göndermeyin.</Banner>}
      {step === 2 ? <ReadStep d={d} ex={ex} onNext={() => go(3)} />
        : step === 3 ? <CompleteStep d={d} ex={ex} reload={r.reload} onNext={() => { setAck(true); go(4); }} onBack={() => go(2)} />
        : <ReviewStep d={d} ex={ex.data} reload={async () => { await r.reload(); await ex.reload(); }} onBack={() => go(3)} />}
    </div>
  );
}

// --- 2. Oku (Figma 08) --------------------------------------------------------------------------------------------------------

type Polled = ReturnType<typeof usePolled<ExtractionsRes>>;
/** Okuma önerisi alanı değil: forma karşılığı olmayan ya da bilgi amaçlı. Değerin para birimi aynı okumadan gelir. */
const currencyOf = (fields: ExtractionField[]) => fields.find((x) => x.field === 'currency')?.value ?? null;

function ReadStep({ d, ex, onNext }: { d: ContractV2; ex: Polled; onNext: () => void }) {
  const [sel, setSel] = useState<ExtractionField | null>(null);
  const [nonce, setNonce] = useState(0);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const data = ex.data;
  const run = data?.run ?? null;
  const ok = run?.status === 'SUCCEEDED';
  const line = aiReadLine(data, !!ex.error);
  const canRetry = !!data?.can.request && !ex.active && (!run || run.status === 'FAILED' || WAITING.includes(run.status));
  async function retry() {
    setBusy(true); setErr(null);
    try { await api(`/api/v1/contracts/${d.family.id}/extractions`, { method: 'POST' }); ex.restart(); await ex.reload(); }
    catch (e) { setErr((e as ApiError).message); } finally { setBusy(false); }
  }
  const fields = ok ? data!.fields : [];
  return (
    <div className="grid grid-cols-[minmax(0,1fr)_440px] gap-6 max-[1100px]:grid-cols-1">
      <section className="panel flex min-h-[520px] flex-col overflow-hidden max-[1100px]:min-h-[420px]" aria-label="Belge önizlemesi">
        <div className="panel-head"><h2 className="min-w-0 flex-1 truncate">{d.document?.filename ?? 'Belge'}</h2>{d.document?.pageCount ? <span className="text-sm text-ink-subtle">{d.document.pageCount} sayfa</span> : null}</div>
        {sel?.evidence && (
          <div className="border-b border-border bg-surface px-4 py-2 text-sm" role="status">
            <span className="font-semibold">{sel.label} · s. {sel.page} alıntısı:</span>{' '}
            <q className="[overflow-wrap:anywhere]">{sel.evidence}</q>
          </div>
        )}
        <div className="min-h-0 flex-1">{d.document ? <DocumentViewer versionId={d.document.documentVersionId} mimeType={d.document.mimeType} targetPage={sel?.page ?? null} scrollNonce={nonce} /> : <p className="p-4 text-ink-muted">Belge bulunamadı.</p>}</div>
      </section>
      <section className="panel self-start" aria-labelledby="read-h">
        <div className="panel-head flex-wrap"><h2 id="read-h" className="flex-1 whitespace-nowrap">Okunan alanlar</h2>
          <TestProviderTag show={!!run?.isTestProvider} /><Tag label={runLabel(run, 'read')} /></div>
        <div className="panel-body grid gap-3">
          {ex.loading && !data ? <Loading rows={4} /> : <>
            {line && <p className="m-0">{line}</p>}
            {ex.timedOut && <p className="m-0 text-sm text-ink-muted">Okuma sürüyor, alanları elle girebilirsiniz.</p>}
            {ok && <p className="m-0 text-sm text-ink-muted">Öneridir; hiçbir değer siz kaydetmeden sözleşmeye yazılmaz. Tutar, para birimi, tarihler ve VKN'yi bir sonraki adımda "Öneriyi kullan" ile siz alırsınız.
              Sayfa bağlantısı belgeyi o sayfada açar ve alıntıyı gösterir.</p>}
            {fields.length > 0 && (
              <ul className="grid" aria-label="Okunan alanlar">
                {fields.map((x) => (
                  <li key={x.id} className="grid gap-0.5 border-t border-border py-2 first:border-t-0">
                    <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                      <span className="min-w-0 flex-1 font-semibold">{x.label}{x.critical && <span className="ml-1 text-sm font-normal text-ink-subtle">· siz onaylarsınız</span>}</span>
                      <Tag label={CONFIDENCE[x.confidence]} />
                    </div>
                    <div className="flex flex-wrap items-baseline gap-x-2">
                      <span className={cn('tabular [overflow-wrap:anywhere]', x.value === null && 'text-ink-muted')}>{x.value === null ? 'Okunamadı' : formatAiValue(x.field, x.value, currencyOf(fields))}</span>
                      {x.page ? <button type="button" className="text-sm font-semibold underline" aria-label={`${x.label}: belgeyi ${x.page}. sayfada aç ve alıntıyı göster`}
                        aria-pressed={sel?.id === x.id} onClick={() => { setSel(x); setNonce((n) => n + 1); }}>{x.page}. sayfa</button> : null}
                    </div>
                    {x.evidence && <p className="m-0 text-sm text-ink-muted [overflow-wrap:anywhere]">“{x.evidence}”</p>}
                    {flagTexts(x.flags).map((t) => <p key={t} className="m-0 text-sm text-warn">{t}</p>)}
                  </li>
                ))}
              </ul>
            )}
            {err && <Banner tone="danger" title={err} />}
            <div className="flex flex-wrap gap-2">
              {canRetry && <Button type="button" variant="outline" disabled={busy} onClick={() => void retry()}><Icon name="refresh" />Yeniden oku</Button>}
              <Button type="button" className="ml-auto" onClick={onNext}>{ok ? 'Devam: Tamamla ve doğrula' : 'Alanları elle girin'}</Button>
            </div>
          </>}
        </div>
      </section>
    </div>
  );
}

// --- 3. Tamamla ve doğrula -------------------------------------------------------------------------------------------------

type Form = Record<string, string | boolean>;
const fromFields = (d: ContractV2): Form => {
  const f = d.fields;
  return {
    projectId: f.projectId ?? '', departmentId: d.family.departmentId ?? '', supplierId: f.supplierId ?? '', contractType: f.contractType ?? d.template?.contractType ?? '',
    ownerUserId: f.ownerUserId ?? '', signedOn: f.signedOn ?? '', indefinite: f.indefinite, contractNo: f.contractNo ?? '', governingCourt: f.governingCourt ?? '',
    kvkkClause: f.kvkkClause === null ? '' : f.kvkkClause ? 'yes' : 'no', priceEscalation: f.priceEscalation ?? '',
    currency: f.currency ?? 'TRY', valueType: f.valueType ?? 'FIXED', amount: trAmount(f.amount), limitBasis: f.limitBasis ?? 'NET',
    startDate: f.startDate ?? '', endDate: f.endDate ?? '', autoRenewal: !!f.autoRenewal, renewalMonths: f.renewalMonths != null ? String(f.renewalMonths) : '',
    noticeAmount: f.noticeAmount != null ? String(f.noticeAmount) : '', noticeUnit: f.noticeUnit ?? 'DAY', paymentDays: f.paymentDays != null ? String(f.paymentDays) : '',
    paymentTerms: f.paymentTerms ?? '', sourceRef: f.sourceRef ?? '', fxDifference: f.fxDifference ?? '',
  };
};
const TERMS_KEYS = ['currency', 'valueType', 'amount', 'limitBasis', 'startDate', 'endDate', 'autoRenewal', 'renewalMonths', 'noticeAmount', 'noticeUnit', 'paymentDays', 'paymentTerms', 'sourceRef', 'fxDifference'];
/** Sunucunun decimal string'i ("2400000.50") → ekranda tr-TR ("2.400.000,50"). Sayıya çevrilmez (kayan nokta yok). */
const trAmount = (v: string | null) => {
  if (!v) return '';
  const [int, frac = ''] = v.split('.');
  return `${int!.replace(/\B(?=(\d{3})+(?!\d))/g, '.')},${frac.padEnd(2, '0').slice(0, 2)}`;
};
/** tr-TR tutar: nokta binlik ayırıcı (yalnız 3'lü gruplar), virgül ondalık (en çok 2 hane). Geçersizse null. */
export const parseTrAmount = (v: string): string | null => {
  const t = v.replace(/\s/g, '');
  const m = /^(\d{1,3}(?:\.\d{3})+|\d+)(?:,(\d{1,2}))?$/.exec(t);
  if (!m) return null;
  const int = m[1]!.replace(/\./g, '').replace(/^0+(?=\d)/, '');
  return m[2] ? `${int}.${m[2]}` : int;
};
export const AMOUNT_ERROR = 'Tutarı 120.000,00 biçiminde girin: binlik için nokta, kuruş için virgül.';
const nul = (v: string | boolean) => (typeof v === 'string' && v.trim() === '' ? null : v);
const int = (v: string | boolean) => (typeof v === 'string' && v.trim() !== '' ? Number(v) : null);

/** Değişen alanlardan PUT /fields gövdesi; koşul alanlarından biri değiştiyse koşul grubu bütün gönderilir (tutarlı revizyon). */
function bodyOf(before: Form, f: Form): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const changed = (k: string) => before[k] !== f[k];
  const conv: Record<string, (v: string | boolean) => unknown> = {
    projectId: nul, departmentId: nul, supplierId: nul, contractType: nul, ownerUserId: nul, signedOn: nul, indefinite: (v) => v,
    contractNo: nul, governingCourt: nul, kvkkClause: (v) => (v === '' ? null : v === 'yes'), priceEscalation: nul,
    currency: (v) => v, valueType: (v) => v, amount: (v) => (f.valueType === 'UNPRICED' || (typeof v === 'string' && v.trim() === '') ? null : parseTrAmount(String(v))),
    limitBasis: (v) => v, startDate: nul, endDate: (v) => (f.indefinite ? null : nul(v)), autoRenewal: (v) => v,
    renewalMonths: (v) => (f.autoRenewal ? int(v) : null), noticeAmount: int, noticeUnit: (v) => (int(f.noticeAmount!) === null ? null : v), paymentDays: int,
    paymentTerms: (v) => v, sourceRef: (v) => v, fxDifference: nul,
  };
  for (const k of Object.keys(conv)) if (!TERMS_KEYS.includes(k) && changed(k)) {
    if ((k === 'projectId' || k === 'departmentId') && f[k] === '') continue;
    out[k] = conv[k]!(f[k]!);
  }
  if (TERMS_KEYS.some(changed) || (changed('indefinite'))) {
    for (const k of TERMS_KEYS) {
      if (k === 'sourceRef' && String(f.sourceRef).trim().length < 3) continue;
      out[k] = conv[k]!(f[k]!);
    }
    out.indefinite = f.indefinite;
  }
  return out;
}

interface Member { id: string; displayName: string; roles: string[] }

/**
 * Okunan alan → form alanı (R5/R6). `same`: formdaki değer öneriyle aynı mı (sunucu kayıttan sonra yeniden karşılaştırır). Tedarikçi (VKN) ve
 * forma karşılığı olmayan alanlar (başlık, teminat, cezai şart) burada yok; VKN ayrı ele alınır, diğerleri yalnız bilgi olarak listelenir.
 */
type AiMap = { key: string; toForm: (v: string) => string | boolean; same: (f: Form, v: string) => boolean };
const eqStr = (key: string): AiMap => ({ key, toForm: (v) => v, same: (f, v) => String(f[key]).trim() === v });
const eqBool = (key: string): AiMap => ({ key, toForm: (v) => v === 'true', same: (f, v) => f[key] === (v === 'true') });
const AI_FORM: Record<string, AiMap> = {
  contractType: eqStr('contractType'), signedOn: eqStr('signedOn'), startDate: eqStr('startDate'), endDate: eqStr('endDate'),
  indefinite: eqBool('indefinite'), autoRenewal: eqBool('autoRenewal'), limitBasis: eqStr('limitBasis'), contractNo: eqStr('contractNo'),
  governingCourt: eqStr('governingCourt'), priceEscalation: eqStr('priceEscalation'), paymentTermDays: eqStr('paymentDays'),
  noticePeriodDays: { key: 'noticeAmount', toForm: (v) => v, same: (f, v) => String(f.noticeAmount).trim() === v && f.noticeUnit === 'DAY' },
  amount: { key: 'amount', toForm: (v) => trAmount(v), same: (f, v) => sameDecimal(parseTrAmount(String(f.amount)), v) },
  currency: { key: 'currency', toForm: (v) => v, same: (f, v) => String(f.currency).trim().toUpperCase() === v },
  // KVKK önerisi madde metnidir; kullanmak "Var" demektir (kayıtta beyan; değer yazılmaz).
  kvkkClause: { key: 'kvkkClause', toForm: () => 'yes', same: (f) => f.kvkkClause === 'yes' },
};
/**
 * Final inceleme M1: formda görünen değer kayıtta aynen saklanacak mı? Süresiz işaretliyken bitiş tarihi, bedelsizken tutar boş kaydedilir;
 * bu durumda kullanılan öneri "Onaylandı" değil "Düzeltildi" gönderilir (sunucu eşit olmayan değeri asla onay saymaz).
 */
export function savedAsShown(field: string, f: Form): boolean {
  if (field === 'endDate') return !f.indefinite;
  if (field === 'amount') return f.valueType !== 'UNPRICED';
  return true;
}
const AI_INFO_ONLY = ['title', 'supplierName', 'guarantee', 'slaPenalty'];
/** Persona K1: süresiz değil ve bitiş boş → ihbar süresi kaydedilemez (sunucu 422 invalid_terms); önce bitiş ya da "Süresiz". */
export const noticeNeedsEnd = (f: Form) => !f.indefinite && String(f.endDate ?? '').trim() === '';
const NOTICE_NEEDS_END = 'İhbar süresi için önce bitiş tarihini girin ya da sözleşmeyi süresiz işaretleyin.';
const DECIDED: Record<Exclude<Decision, 'PENDING'>, string> = { CONFIRMED: 'Öneri onaylandı', CORRECTED: 'Öneriden farklı değer kaydedildi', REJECTED: 'Öneri yoksayıldı' };

function CompleteStep({ d, ex, reload, onNext, onBack }: { d: ContractV2; ex: Polled; reload: () => Promise<void>; onNext: () => void; onBack: () => void }) {
  const base = useMemo(() => fromFields(d), [d]);
  const [f, setF] = useState<Form>(base);
  useEffect(() => setF(base), [base]);
  // --- v2 Faz 4: okuma önerileri ---
  const aiOk = ex.data?.run?.status === 'SUCCEEDED' && ex.data.documentVersionId === d.document?.documentVersionId;
  const aiFields = useMemo(() => (aiOk ? ex.data!.fields : []), [aiOk, ex.data]);
  const byField = useMemo(() => new Map(aiFields.map((x) => [x.field, x])), [aiFields]);
  const [used, setUsed] = useState<Set<string>>(new Set());
  const [rejected, setRejected] = useState<Set<string>>(new Set());
  const [prefilled, setPrefilled] = useState<Record<string, string>>({});
  const [page, setPageState] = useState<number | null>(null);
  const [nonce, setNonce] = useState(0);
  const setPage = (n: number | null) => { setPageState(n); setNonce((x) => x + 1); };
  // R5: kritik olmayan HIGH/MEDIUM (prefill=true) öneriler yalnız boş alana "Yapay zekâ" etiketiyle yazılır; kayıt yine kullanıcının "Kaydet"iyle olur.
  useEffect(() => {
    const pf: Record<string, string> = {};
    setF((cur) => {
      let next = cur;
      for (const x of aiFields) {
        const m = AI_FORM[x.field];
        if (!m || !x.prefill || x.critical || x.value === null || x.decision !== 'PENDING') continue;
        if (cur[m.key] !== '' || base[m.key] !== '') continue;
        // Persona K1: ihbar süresi bitişe göre işler; bitiş (kritik, önceden yazılmaz) boşken ve süresiz değilken yalnız öneri olarak kalır.
        if (x.field === 'noticePeriodDays' && noticeNeedsEnd(next)) continue;
        next = { ...next, [m.key]: m.toForm(x.value) };
        pf[m.key] = x.id;
      }
      return next;
    });
    setPrefilled(pf); setUsed(new Set()); setRejected(new Set());
  }, [aiFields, base]);
  const prefillUnchanged = (x: ExtractionField) => { const m = AI_FORM[x.field]; return !!m && prefilled[m.key] === x.id && x.value !== null && m.same(f, x.value); };
  /** Bu kayıtla yazılacak kararlar: "Öneriyi kullan" → Onaylandı (değer aynı kaldıysa); elle değiştirilen ya da önceden doldurulmuş alan → Düzeltildi
   * (sunucu değer öneriye eşitse Onaylandı saklar); "Yoksay" → Yoksayıldı. Dokunulmayan öneri karar beklemeye devam eder. */
  function decisions(): { extractionId: string; decision: Exclude<Decision, 'PENDING'> }[] {
    const out: { extractionId: string; decision: Exclude<Decision, 'PENDING'> }[] = [];
    for (const x of aiFields) {
      if (x.decision !== 'PENDING' || x.value === null) continue;
      if (rejected.has(x.id)) { out.push({ extractionId: x.id, decision: 'REJECTED' }); continue; }
      if (x.field === 'supplierVkn') {
        if (used.has(x.id)) out.push({ extractionId: x.id, decision: 'CONFIRMED' });
        else if (f.supplierId !== base.supplierId && f.supplierId) out.push({ extractionId: x.id, decision: 'CORRECTED' });
        continue;
      }
      const m = AI_FORM[x.field];
      if (!m) continue;
      if (used.has(x.id)) out.push({ extractionId: x.id, decision: m.same(f, x.value) && savedAsShown(x.field, f) ? 'CONFIRMED' : 'CORRECTED' });
      else if (prefillUnchanged(x) || f[m.key] !== base[m.key]) out.push({ extractionId: x.id, decision: 'CORRECTED' });
    }
    return out;
  }
  const pendingCritical = (dec: { extractionId: string }[]) => aiFields.filter((x) => x.critical && x.value !== null && x.decision === 'PENDING' && !dec.some((y) => y.extractionId === x.id));
  function applySuggestion(x: ExtractionField) {
    if (x.value === null) return;
    setRejected((r) => { const n = new Set(r); n.delete(x.id); return n; });
    if (x.field === 'supplierVkn') {
      // Tedarikçi kartı eşleşmesi VKN ile kesin kayıt aramasıdır (yapay zekâ eşleştirmez): kayıtlı kartın VKN'si aynıysa onaylanır,
      // değilse aday kart formu VKN ile açılır; aynı VKN'li kart varsa sunucu o kartı seçer.
      if (d.supplier?.vkn === x.value && f.supplierId === d.supplier.id) { setUsed((u) => new Set(u).add(x.id)); return; }
      setCandidate({ legalName: byField.get('supplierName')?.value ?? '', vkn: x.value, contactEmail: '' });
      return;
    }
    const m = AI_FORM[x.field];
    if (!m) return;
    setF((cur) => ({ ...cur, [m.key]: m.toForm(x.value!), ...(x.field === 'noticePeriodDays' ? { noticeUnit: 'DAY' } : {}),
      ...(x.field === 'amount' && cur.valueType === 'UNPRICED' ? { valueType: 'FIXED' } : {}) }));
    setUsed((u) => new Set(u).add(x.id));
  }
  const toggleReject = (x: ExtractionField) => setRejected((r) => { const n = new Set(r); if (n.has(x.id)) n.delete(x.id); else n.add(x.id); return n; });
  const [checked, setChecked] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ tone: 'info' | 'warn' | 'danger'; text: string } | null>(null);
  const projects = useResource<{ items: ProjectRow[] }>('/api/v1/projects');
  const suppliers = useResource<{ items: SupplierOption[] }>('/api/v1/supplier-options');
  const members = useResource<Member[]>('/api/v1/members?active=true');
  const deps = useDepartments();
  const [candidate, setCandidate] = useState<{ legalName: string; vkn: string; contactEmail: string } | null>(null);
  // Persona K6: aday formundaki VKN önerilen VKN'ye eşit ve aynı VKN'li kayıtlı kart varsa düğme "Mevcut kartı seç" der (sunucu o kartı seçer).
  const vknSuggestion = byField.get('supplierVkn');
  const existingByVkn = candidate && vknSuggestion?.existingSupplier && candidate.vkn.replace(/\s/g, '') === vknSuggestion.value ? vknSuggestion.existingSupplier : null;
  const set = (k: string, v: string | boolean) => setF((x) => ({ ...x, [k]: v }));
  const dirty = Object.keys(base).some((k) => base[k] !== f[k]) || (!d.can.edit ? false : rejected.size > 0 || used.size > 0);
  const ro = !d.can.edit;
  const amountError = f.valueType !== 'UNPRICED' && String(f.amount).trim() !== '' && parseTrAmount(String(f.amount)) === null;

  async function save(next: boolean) {
    if (amountError) { setMsg({ tone: 'danger', text: AMOUNT_ERROR }); return; }
    setBusy(true); setMsg(null);
    try {
      const body = bodyOf(base, f);
      const dec = ro ? [] : decisions();
      const stillPending = pendingCritical(dec);
      if (Object.keys(body).length || dec.length) {
        const r = await api<ContractV2 & { changed: boolean; cancelledChainId: string | null }>(`/api/v1/contracts/${d.family.id}/fields`, { method: 'PUT',
          json: dec.length ? { ...body, aiDecisions: dec } : body });
        await reload();
        if (dec.length) await ex.reload();
        if (next && stillPending.length) { setMsg({ tone: 'warn', text: `Kaydedildi. Göndermeden önce kritik önerilere karar verin ("Öneriyi kullan" ya da "Yoksay"): ${stillPending.map((x) => x.label).join(', ')}.` }); return; }
        if (r.data.cancelledChainId) setMsg({ tone: 'warn', text: 'İçerik değişti; açık onay turu iptal edildi. Sözleşmeyi yeniden onaya gönderin.' });
        if (next && r.data.missing.length) { setMsg({ tone: 'warn', text: `Kaydedildi. Göndermeden önce eksik alanları tamamlayın: ${r.data.missing.map((m) => m.label).join(', ')}.` }); return; }
        if (!next && !r.data.cancelledChainId) setMsg({ tone: 'info', text: 'Alanlar kaydedildi.' });
      } else if (!next) setMsg({ tone: 'info', text: 'Değişiklik yok.' });
      if (next) {
        if (!Object.keys(body).length && d.missing.length) { setMsg({ tone: 'warn', text: `Eksik alanlar: ${d.missing.map((m) => m.label).join(', ')}.` }); return; }
        if (!Object.keys(body).length && !dec.length && stillPending.length) { setMsg({ tone: 'warn', text: `Göndermeden önce kritik önerilere karar verin ("Öneriyi kullan" ya da "Yoksay"): ${stillPending.map((x) => x.label).join(', ')}.` }); return; }
        onNext();
      }
    } catch (e) {
      const err = e as ApiError;
      // M1: karar/değer uyuşmazlığında kayıt bütünüyle geri alınır; kullanıcıya hiçbir alanın kaydedilmediği açıkça söylenir.
      if (err.code === 'decision_mismatch') setMsg({ tone: 'warn', text: `Kaydedilmedi: ${err.message}` });
      else setMsg({ tone: err.status === 409 ? 'warn' : 'danger', text: err.message });
      // Öneri artık güncel okumaya ait değilse (yeni sürüm/yeniden okuma) öneriler yenilenir.
      if (err.code === 'extraction_unknown' || err.code === 'decision_mismatch' || err.code === 'extraction_not_saved') await ex.reload();
    }
    finally { setBusy(false); }
  }
  async function openCandidate() {
    if (!candidate) return;
    setBusy(true); setMsg(null);
    try {
      const r = await api<{ id: string; legalName: string; status: string; existing: boolean }>('/api/v1/suppliers/candidates', { method: 'POST', json: {
        legalName: candidate.legalName, vkn: candidate.vkn.replace(/\s/g, ''), contactEmail: candidate.contactEmail || null } });
      await suppliers.reload();
      set('supplierId', r.data.id); setCandidate(null);
      setMsg({ tone: 'info', text: r.data.existing ? `Bu VKN ile kayıtlı kart bulundu ve seçildi: ${r.data.legalName}.` : `Aday tedarikçi kartı açıldı: ${r.data.legalName}. Satınalma kartı tamamlar.` });
    } catch (e) { setMsg({ tone: 'danger', text: (e as ApiError).message }); } finally { setBusy(false); }
  }

  const missing = d.missing;
  // Seçici yalnız etkin üyeleri listeler (M5); kayıtlı sorumlu artık etkin değilse adı kaybolmaz, ayrıca işaretlenir.
  const activeOwners = (members.data ?? []).filter((m) => m.roles.some((r) => r === 'PROCUREMENT' || r === 'DEPARTMENT_USER'));
  const owners = d.owner && members.data && !activeOwners.some((m) => m.id === d.owner!.id)
    ? [{ id: d.owner.id, displayName: `${d.owner.displayName} (etkin değil)`, roles: [] as string[] }, ...activeOwners] : activeOwners;
  const sel = (k: string, label: string, opts: [string, string][], hint?: string, empty = 'Seçin') => (
    <Field label={label} hint={hint}>{(p) => <select className="input" disabled={ro} {...p} value={String(f[k])} onChange={(e) => set(k, e.target.value)}>
      <option value="">{empty}</option>{opts.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select>}</Field>
  );
  const inp = (k: string, label: string, props: React.InputHTMLAttributes<HTMLInputElement> = {}, hint?: string) => (
    <Field label={label} hint={hint}>{(p) => <input className="input" disabled={ro} {...props} {...p} value={String(f[k])} onChange={(e) => set(k, e.target.value)} />}</Field>
  );
  const chk = (k: string, label: string) => (
    <label className="mb-4 flex items-center gap-2"><input type="checkbox" className="accent-[var(--ink)]" disabled={ro} checked={!!f[k]} onChange={(e) => set(k, e.target.checked)} />{label}</label>
  );
  const isMissing = (field: string) => missing.some((m) => m.field === field);
  /** Alanın altında öneri satırı: öneri + kaynak sayfa + güven, "Öneriyi kullan" / "Yoksay", ya da karar/işaret. */
  const ai = (field: string) => {
    const x = byField.get(field);
    if (!x) return null;
    const m = AI_FORM[field];
    const empty = m ? f[m.key] === '' : !f.supplierId;
    const src = x.page ? <button type="button" className="underline" aria-label={`${x.label} önerisinin kaynağı: belgeyi ${x.page}. sayfada aç`} onClick={() => setPage(x.page)}>{x.page}. sayfa</button> : null;
    if (x.value === null || x.confidence === 'MISSING') {
      return empty ? <p className="-mt-3 mb-3 flex flex-wrap items-center gap-x-2 text-sm text-ink-muted"><Tag label={{ text: 'Sorulan alan', tone: 'warn', icon: 'help' }} />Belgede okunamadı; belgeden siz girin.</p> : null;
    }
    if (x.decision !== 'PENDING') {
      return <p className="-mt-3 mb-3 text-sm text-ink-subtle">{DECIDED[x.decision]}{x.decidedBy ? ` · ${x.decidedBy.displayName}` : ''}{src ? <> · {src}</> : null}</p>;
    }
    const shown = formatAiValue(field, x.value, byField.get('currency')?.value ?? null);
    if (rejected.has(x.id)) return <p className="-mt-3 mb-3 flex flex-wrap items-center gap-x-2 text-sm text-ink-muted">Öneri ({shown}) kaydedince yoksayılır.
      <Button type="button" size="xs" variant="ghost" onClick={() => toggleReject(x)}>Geri al</Button></p>;
    if (prefillUnchanged(x)) return <p className="-mt-3 mb-3 flex flex-wrap items-center gap-x-2 text-sm text-ink-muted"><Tag label={{ text: 'Yapay zekâ', tone: 'ai', icon: 'sparkles', hint: 'Yapay zekâ önerisiyle dolduruldu; kaydetmeden önce belgeyle karşılaştırın.' }} />
      {src}<span>güven {CONFIDENCE[x.confidence].text.toLocaleLowerCase('tr-TR')}</span></p>;
    if (used.has(x.id) && (m ? m.same(f, x.value) : true)) return <p className="-mt-3 mb-3 text-sm text-ink-muted">Öneri kullanıldı; kaydedince onaylanır.{src ? <> · {src}</> : null}</p>;
    return (
      <div className="-mt-3 mb-3 grid gap-1 rounded-sm border border-dashed border-ai px-2 py-1.5 text-sm">
        <span className="flex flex-wrap items-center gap-x-2">
          {x.confidence === 'LOW' && <Tag label={{ text: 'Sorulan alan', tone: 'warn', icon: 'help' }} />}
          <span className="[overflow-wrap:anywhere]"><span className="text-ink-muted">Öneri:</span> <span className="tabular font-semibold">{shown}</span>{src ? <> ({src})</> : null}</span>
          <span className="text-ink-subtle">güven {CONFIDENCE[x.confidence].text.toLocaleLowerCase('tr-TR')}</span>
        </span>
        {flagTexts(x.flags).map((t) => <span key={t} className="text-warn">{t}</span>)}
        {field === 'noticePeriodDays' && noticeNeedsEnd(f) && <span className="text-ink-muted">{NOTICE_NEEDS_END}</span>}
        {!ro && <span className="flex flex-wrap gap-1.5">
          <Button type="button" size="xs" variant="outline" aria-label={`Öneriyi kullan: ${x.label}`} onClick={() => applySuggestion(x)}>Öneriyi kullan</Button>
          <Button type="button" size="xs" variant="ghost" aria-label={`Öneriyi yoksay: ${x.label}`} onClick={() => toggleReject(x)}>Yoksay</Button>
        </span>}
      </div>
    );
  };
  const aiLine = aiReadLine(ex.data, !!ex.error);
  const decCount = aiFields.filter((x) => x.critical && x.value !== null && x.decision === 'PENDING').length;
  const infoOnly = aiFields.filter((x) => AI_INFO_ONLY.includes(x.field) && x.value !== null && !(x.field === 'supplierName'));

  return (
    <div className="grid grid-cols-[minmax(0,1fr)_440px] gap-6 max-[1100px]:grid-cols-1">
      <section className="panel flex min-h-[520px] flex-col overflow-hidden max-[1100px]:min-h-[420px]" aria-label="Belge önizlemesi">
        <div className="panel-head"><h2 className="min-w-0 flex-1 truncate">{d.document?.filename ?? 'Belge'}</h2>{d.document?.pageCount ? <span className="text-sm text-ink-subtle">{d.document.pageCount} sayfa</span> : null}</div>
        <div className="min-h-0 flex-1">{d.document ? <DocumentViewer versionId={d.document.documentVersionId} mimeType={d.document.mimeType} targetPage={page} scrollNonce={nonce} /> : <p className="p-4 text-ink-muted">Belge bulunamadı.</p>}</div>
      </section>
      <section className="panel self-start" aria-labelledby="fields-h">
        <div className="panel-head"><h2 id="fields-h" className="flex-1">Sözleşme alanları</h2>
          {missing.length ? <Tag label={{ text: `${missing.length} alan eksik`, tone: 'danger', icon: 'x' }} /> : <Tag label={{ text: 'Zorunlu alanlar tam', tone: 'ok', icon: 'check' }} />}</div>
        <div className="panel-body">
          {aiOk ? (
            <Banner tone="info" icon="sparkles" title="Belgeden okunan öneriler">
              Tutar, para birimi, tarihler ve VKN forma yazılmaz; "Öneriyi kullan" ile siz alırsınız. Diğer öneriler "Yapay zekâ" etiketiyle doldurulur; kayıt sizin "Kaydet"inizle olur.
              {decCount > 0 && <span className="mt-1 block font-semibold">{decCount} kritik öneri kararınızı bekliyor.</span>}
              {ex.data?.run?.isTestProvider && <span className="mt-1 block"><TestProviderTag /></span>}
            </Banner>
          ) : <Banner tone="neutral" icon="info" title={aiLine ?? 'Yapay zekâ okuması bekleniyor.'}>Değerleri belgeyle karşılaştırarak girin.</Banner>}
          {ro && <Banner tone="info" title="Alanlar salt okunur">{d.status.code === 'APPROVED' ? 'Onaylanmış sözleşme değiştirilemez; değişiklik için yeni sürüm ekleyin.' : 'Bu sözleşmenin alanlarını ekleyen kişi ya da Satınalma düzenler.'}</Banner>}
          {missing.length > 0 && <p className="mb-3 text-sm text-danger">Eksik: {missing.map((m) => m.label).join(', ')}</p>}
          <div className="grid grid-cols-2 gap-x-3 max-[640px]:grid-cols-1">
            <div className="col-span-full">
              <Field label="Tedarikçi" hint={supplierPickHint(suppliers.data?.items.find((s) => s.id === f.supplierId)) ?? (isMissing('supplier') ? 'Zorunlu.' : undefined)}>
                {(p) => <select className="input" disabled={ro} aria-invalid={isMissing('supplier') || undefined} {...p} value={String(f.supplierId)} onChange={(e) => set('supplierId', e.target.value)}>
                  <option value="">Seçin</option>
                  {f.supplierId && d.supplier && !suppliers.data?.items.some((s) => s.id === f.supplierId) && <option value={d.supplier.id}>{d.supplier.legalName}</option>}
                  {(suppliers.data?.items ?? []).map((s) => <option key={s.id} value={s.id}>{s.label ?? s.legalName}</option>)}</select>}
              </Field>
              {ai('supplierVkn')}
              {!ro && !candidate && <Button type="button" size="sm" variant="outline" className="-mt-2 mb-4" onClick={() => setCandidate({ legalName: '', vkn: '', contactEmail: '' })}>Kayıtlı değil: aday tedarikçi aç</Button>}
              {candidate && (
                <div className="mb-4 grid gap-0 rounded-md border border-border bg-white p-3">
                  <p className="mb-2 text-sm text-ink-muted">Belgedeki firma kayıtlı değilse en az unvan ve VKN ile aday kart açılır; aynı VKN varsa o kart seçilir.</p>
                  <Field label="Unvan">{(p) => <input className="input" {...p} value={candidate.legalName} onChange={(e) => setCandidate({ ...candidate, legalName: e.target.value })} />}</Field>
                  <Field label="VKN" hint="10 hane; kontrol basamağı denetlenir.">{(p) => <input className="input tabular" inputMode="numeric" {...p} value={candidate.vkn} onChange={(e) => setCandidate({ ...candidate, vkn: e.target.value })} />}</Field>
                  <Field label="İletişim e-postası (isteğe bağlı)">{(p) => <input className="input" type="email" {...p} value={candidate.contactEmail} onChange={(e) => setCandidate({ ...candidate, contactEmail: e.target.value })} />}</Field>
                  {existingByVkn && <p className="mb-2 text-sm">Bu VKN ile kayıtlı kart var: <span className="font-semibold">{existingByVkn.legalName}</span>. Yeni kart açılmaz; bu kart seçilir.</p>}
                  <div className="flex gap-2"><Button type="button" size="sm" disabled={busy || !candidate.legalName.trim() || !candidate.vkn.trim()} onClick={() => void openCandidate()}>{existingByVkn ? 'Mevcut kartı seç' : 'Aday kartı aç'}</Button>
                    <Button type="button" size="sm" variant="outline" onClick={() => setCandidate(null)}>Vazgeç</Button></div>
                </div>
              )}
            </div>
            <div className="col-span-full">{sel('projectId', 'İlgili proje', (projects.data?.items ?? []).map((x) => [x.id, `${x.code} · ${x.title}`] as [string, string])
              .concat(f.projectId && !projects.data?.items.some((x) => x.id === f.projectId) && d.project ? [[d.project.id, d.project.code ? `${d.project.code} · ${d.project.title}` : 'Görünmeyen proje']] : []),
              'Zorunlu. Proje değişirse departman projenin departmanına geçer.')}</div>
            <div className="col-span-full">{sel('departmentId', 'İlgili departman', deps.items.map((x) => [x.id, x.name] as [string, string])
              .concat(f.departmentId && !deps.items.some((x) => x.id === f.departmentId) && d.family.departmentName ? [[String(f.departmentId), d.family.departmentName]] : []))}</div>
            <div>{sel('contractType', 'Sözleşme türü', Object.entries(CONTRACT_TYPES), d.template ? `Şablondan: ${d.template.code} v${d.template.versionNo}` : undefined)}{ai('contractType')}</div>
            {sel('ownerUserId', 'Sözleşme sorumlusu', owners.map((m) => [m.id, m.displayName] as [string, string]), 'Hatırlatıcılar bu kişiye gider.')}
            <div>{inp('signedOn', 'İmza tarihi', { type: 'date' })}{ai('signedOn')}</div>
            <div>{inp('contractNo', 'Sözleşme no (isteğe bağlı)')}{ai('contractNo')}</div>
            <div className="col-span-full my-1 border-t border-border pt-3"><h3 className="mb-2 text-base">Bedel ve süre</h3></div>
            {sel('valueType', 'Bedel türü', [['FIXED', 'Sabit bedel'], ['CEILING', 'Tavan (limit)'], ['UNPRICED', 'Bedelsiz']], undefined, 'Seçin')}
            <div>
              <div className="grid grid-cols-[minmax(0,1fr)_76px] gap-x-2">
                <Field label="Tutar" hint="Örnek: 120.000,00" error={amountError ? AMOUNT_ERROR : null}>{(p) => <input className="input tabular text-right" inputMode="decimal"
                  disabled={ro || f.valueType === 'UNPRICED'} {...p} value={String(f.amount)} onChange={(e) => set('amount', e.target.value)} />}</Field>
                {inp('currency', 'Para', { maxLength: 3 })}
              </div>
              {ai('amount')}{ai('currency')}
            </div>
            <div>{sel('limitBasis', 'KDV', [['NET', 'KDV hariç'], ['GROSS', 'KDV dahil']], undefined, 'Seçin')}{ai('limitBasis')}</div>
            <div>{inp('paymentDays', 'Ödeme vadesi (gün)', { inputMode: 'numeric' })}{ai('paymentTermDays')}</div>
            <div>{inp('startDate', 'Başlangıç', { type: 'date' })}{ai('startDate')}</div>
            <div>{inp('endDate', 'Bitiş', { type: 'date', disabled: ro || !!f.indefinite }, f.indefinite ? 'Süresiz sözleşmede bitiş yok.' : undefined)}{ai('endDate')}</div>
            <div>{chk('indefinite', 'Süresiz sözleşme')}{ai('indefinite')}</div>
            <div>{chk('autoRenewal', 'Otomatik yenilenir')}{ai('autoRenewal')}</div>
            {f.autoRenewal ? inp('renewalMonths', 'Yenileme süresi (ay)', { inputMode: 'numeric' }) : <span />}
            <div>
              <div className="grid grid-cols-[minmax(0,1fr)_110px] gap-x-2">
                {inp('noticeAmount', 'Fesih ihbar süresi', { inputMode: 'numeric' }, f.indefinite ? 'Süresiz sözleşmede zorunlu.' : 'Boşsa ihbar şartı yok.')}
                {sel('noticeUnit', 'Birim', [['DAY', 'gün'], ['MONTH', 'ay']], undefined, '—')}
              </div>
              {ai('noticePeriodDays')}
            </div>
            <div className="col-span-full">{inp('sourceRef', 'Kaynak madde ve sayfa', {}, 'Tutar ve tarihlerin dayandığı yer (ör. Madde 4, s. 2).')}</div>
            <details className="col-span-full mb-3">
              <summary className="cursor-pointer text-sm font-semibold">İsteğe bağlı alanlar</summary>
              <div className="mt-3 grid grid-cols-2 gap-x-3 max-[640px]:grid-cols-1">
                <div className="col-span-full">{inp('paymentTerms', 'Ödeme koşulu')}</div>
                {sel('fxDifference', 'Kur farkı', [['ALLOWED', 'Uygulanabilir'], ['NOT_ALLOWED', 'Uygulanmaz']], undefined, 'Girilmedi')}
                <div>{sel('kvkkClause', 'KVKK maddesi', [['yes', 'Var'], ['no', 'Yok']], undefined, 'Girilmedi')}{ai('kvkkClause')}</div>
                <div className="col-span-full">{inp('governingCourt', 'Yetkili mahkeme')}{ai('governingCourt')}</div>
                <div className="col-span-full">{inp('priceEscalation', 'Fiyat artış koşulu')}{ai('priceEscalation')}</div>
              </div>
            </details>
            {infoOnly.length > 0 && (
              <div className="col-span-full mb-3 grid gap-1 rounded-sm border border-dashed border-ai px-3 py-2 text-sm">
                <span className="font-semibold">Belgeden okunan diğer bilgiler (yalnız bilgi; kaydedilmez)</span>
                {infoOnly.map((x) => <span key={x.id} className="[overflow-wrap:anywhere]"><span className="text-ink-muted">{x.label}:</span> {x.value}{x.page ? <> (<button type="button" className="underline" aria-label={`${x.label}: belgeyi ${x.page}. sayfada aç`} onClick={() => setPage(x.page)}>{x.page}. sayfa</button>)</> : null}</span>)}
              </div>
            )}
          </div>
          <label className="mt-1 flex items-start gap-2 border-t border-border pt-3">
            <input type="checkbox" className="mt-1 accent-[var(--ink)]" checked={checked} onChange={(e) => setChecked(e.target.checked)} />
            <span>Tutar, tarih ve VKN'yi belgeyle karşılaştırdım.</span>
          </label>
          {msg && <div className="mt-3"><Banner tone={msg.tone} title={msg.text} /></div>}
          <div className="mt-3 flex flex-wrap gap-2">
            <Button type="button" variant="outline" onClick={onBack}>Geri</Button>
            {!ro && <Button type="button" variant="outline" disabled={busy || !dirty} onClick={() => void save(false)}>Kaydet</Button>}
            <Button type="button" className="ml-auto" disabled={busy || !checked} onClick={() => void save(true)}>Devam: İncele ve gönder</Button>
          </div>
          {!checked && <p className="mt-2 text-sm text-ink-muted">Devam etmek için karşılaştırma onay kutusunu işaretleyin.</p>}
        </div>
      </section>
    </div>
  );
}

// --- 4. İncele ve gönder ----------------------------------------------------------------------------------------------------

export function Facts({ items }: { items: [string, ReactNode][] }) {
  return (
    <dl className="grid grid-cols-3 gap-x-6 gap-y-4 max-[900px]:grid-cols-2 max-[480px]:grid-cols-1">
      {items.map(([k, v]) => <div key={k} className="min-w-0"><dt className="text-sm text-ink-muted">{k}</dt><dd className="m-0 [overflow-wrap:anywhere]">{v ?? '—'}</dd></div>)}
    </dl>
  );
}

export function contractFacts(d: ContractV2): [string, ReactNode][] {
  const f = d.fields;
  return [
    // Persona K4: aday (doğrulanmamış) tedarikçi özetlerde işaretli; diğer durumlar (Aktif hariç) etiketle gösterilir.
    ['Tedarikçi', d.supplier ? (d.supplier.status === 'ACTIVE' ? d.supplier.legalName : <span>{d.supplier.legalName}{' '}
      <Tag className="ml-1 align-middle" label={d.supplier.status === 'CANDIDATE' ? { text: 'Aday — doğrulanmadı', tone: 'warn', icon: 'clock' } : supplierStatus[d.supplier.status] ?? { text: 'Durum bilinmiyor', tone: 'neutral', icon: 'info' }} /></span>) : '—'],
    ['Proje', d.project ? (d.project.visible ? `${d.project.code} · ${d.project.title}` : 'Görme yetkiniz olmayan proje') : '—'],
    ['İlgili departman', d.family.departmentName ?? 'Departmansız'],
    ['Başlangıç', <span className="tabular">{fmtDate(f.startDate)}</span>],
    ['Bitiş', <span className="tabular">{f.indefinite ? 'Süresiz' : fmtDate(f.endDate)}</span>],
    [`Tutar (${f.limitBasis === 'GROSS' ? 'KDV dahil' : 'KDV hariç'})`, <span className="tabular">{f.valueType === 'UNPRICED' ? 'Bedelsiz' : fmtMoney(f.amount, f.currency)}</span>],
    // Persona K2: şablon seçilmediyse ve inceleme türün güncel şablonunu kullandıysa "Kullanılmadı" yanıltır; sunucunun açıklaması gösterilir.
    ['Kullanılan şablon', d.template ? `${d.template.code} ${d.template.name} · v${d.template.versionNo}${d.template.superseded ? ' (eski sürüm)' : ''}`
      : d.review && !d.review.stale && d.review.templateUsageNote ? d.review.templateUsageNote : 'Kullanılmadı'],
    ['Sözleşme türü', f.contractTypeLabel ?? '—'],
    ['Yenileme', f.autoRenewal ? `Otomatik, ${f.renewalMonths ?? '—'} ay` : f.autoRenewal === false ? 'Otomatik yenilenmez' : '—'],
    ['Fesih bildirimi', f.noticePeriod ?? 'Tanımlı değil'],
    ['Sözleşme sorumlusu', d.owner?.displayName ?? '—'],
    ['Ekleyen', `${d.family.createdBy.displayName} · ${fmtDate(d.family.createdAt)}`],
  ];
}

/** Hatırlatıcı planı (kiracı süreleriyle; kurulmadan önce önizleme). */
export function PlannedList({ d }: { d: ContractV2 }) {
  const p = d.reminders.planned;
  if (!p.length) return <p className="text-ink-muted">{d.fields.indefinite ? 'Süresiz sözleşme: ihbar süresi girilince yıl dönümüne göre ihbar hatırlatıcısı planlanır.' : 'Bitiş tarihi girilince hatırlatıcılar planlanır.'}</p>;
  return (
    <ul className="grid gap-1.5">
      {p.map((x) => <li key={`${x.kind}-${x.offset}`} className="flex justify-between gap-3">
        <span>{x.kind === 'NOTICE' ? `İhbar son gününden ${x.offset} gün önce` : `${x.offset} gün önce`}{x.includeProcurement ? <span className="text-sm text-ink-subtle"> · Satınalma da</span> : null}</span>
        <span className="tabular">{fmtDate(x.date)}</span></li>)}
    </ul>
  );
}

function ReviewStep({ d, ex, reload, onBack }: { d: ContractV2; ex: ExtractionsRes | null; reload: () => Promise<void>; onBack: () => void }) {
  const navigate = useNavigate();
  const members = useResource<Member[]>('/api/v1/members?active=true');
  const [useDeputy, setUseDeputy] = useState(false);
  const [extra, setExtra] = useState<string[]>([]);
  const [adding, setAdding] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [errorCode, setErrorCode] = useState<string | null>(null);
  const qs = new URLSearchParams();
  if (useDeputy) qs.set('useDeputyForHead', 'true');
  for (const id of extra) qs.append('extraApproverIds', id);
  const preview = useResource<ApprovalPreview>(`/api/v1/contracts/${d.family.id}/approval-preview${qs.toString() ? `?${qs}` : ''}`);
  const eligible = (members.data ?? []).filter((m) => m.roles.some((r) => r === 'PROCUREMENT' || r === 'DEPARTMENT_USER') && !extra.includes(m.id));
  const detail = d.document ? `/sozlesmeler/${d.document.contractVersionId}` : '/sozlesmeler';
  // R6: güncel okumada karar bekleyen kritik öneri varsa sunucu gönderimi reddeder (ai_suggestions_pending); aynı kural burada önceden gösterilir.
  const pendingAi = ex?.run?.status === 'SUCCEEDED' && ex.documentVersionId === d.document?.documentVersionId
    ? ex.fields.filter((x) => x.critical && x.value !== null && x.decision === 'PENDING') : [];
  const blockers = d.missing.length ? 'Eksik alanlar var.' : pendingAi.length ? `Kritik yapay zekâ önerilerine karar verilmedi: ${pendingAi.map((x) => x.label).join(', ')}. "Tamamla ve doğrula" adımında "Öneriyi kullan" ya da "Yoksay" seçin.` : !d.can.submit ? (d.status.code === 'IN_APPROVAL' ? 'Sözleşme zaten onayda.' : d.status.code === 'APPROVED' ? 'Sözleşme onaylı.' : 'Bu sözleşmeyi gönderme yetkiniz yok.') : preview.data && !preview.data.ok ? preview.data.message ?? 'Onay zinciri kurulamıyor.' : null;

  async function submit() {
    setBusy(true); setError(null); setErrorCode(null);
    try {
      await api(`/api/v1/contracts/${d.family.id}/submit`, { method: 'POST', json: { useDeputyForHead: useDeputy, extraApproverIds: extra, note: note.trim() || null } });
      navigate(`${detail}?sekme=onaylar&gonderildi=1`);
    } catch (e) {
      const err = e as ApiError;
      setError(err.message); setErrorCode(err.code); setBusy(false);
      // 409/422: zincir açık, alan eksik ya da onaycı değişti: güncel durum ve önizleme yeniden yüklenir.
      if (err.status === 409 || err.status === 422) { await reload(); await preview.reload(); }
    }
  }

  return (
    <>
      <div className="mb-4 flex flex-wrap justify-end gap-2">
        <Button variant="outline" onClick={onBack}>Geri</Button>
        <Button variant="outline" asChild><Link to={`${detail}?sekme=ozet&taslak=1`}>Taslağı kaydet</Link></Button>
        <Button disabled={busy || !!blockers || preview.loading} onClick={() => void submit()}><Icon name="stamp" />{busy ? 'Gönderiliyor…' : 'Onaya gönder'}</Button>
      </div>
      {blockers && <Banner tone="warn" title="Onaya gönderilemez">{blockers}{d.missing.length ? ` Eksik: ${d.missing.map((m) => m.label).join(', ')}.` : ''}</Banner>}
      {error && <Banner tone="danger" title={error} action={errorCode === 'ai_suggestions_pending' ? <Button size="sm" variant="outline" onClick={onBack}>Önerilere karar ver</Button> : undefined} />}
      <div className="grid grid-cols-[minmax(0,1fr)_420px] gap-6 max-[1100px]:grid-cols-1">
        <div className="grid content-start gap-5">
          <section className="panel">
            <div className="panel-head"><h2 className="flex-1">Sözleşme özeti</h2>
              {!d.missing.length && <Tag label={{ text: 'Zorunlu alanlar tam', tone: 'ok', icon: 'check' }} />}</div>
            <div className="panel-body"><Facts items={contractFacts(d)} /></div>
          </section>
          <ReviewCard familyId={d.family.id} onAddApprover={() => { const el = document.getElementById('add-approver'); el?.scrollIntoView({ block: 'center' }); el?.focus(); }} />
          <section className="panel">
            <div className="panel-head"><h2>Hatırlatıcılar</h2><span className="text-sm text-ink-subtle">{d.reminders.offsets.map((o) => `${o} gün`).join(' · ')}</span></div>
            <div className="panel-body grid gap-2">
              <PlannedList d={d} />
              <p className="text-sm text-ink-muted">Onay tamamlanınca kurulur. Alıcılar: sözleşme sorumlusu ve departman sorumlusu; 30 ve 7 günde Satınalma da. Görev İşlerim'e düşer; e-posta kanalı yapılandırılmadıysa e-posta gönderilmez.</p>
            </div>
          </section>
        </div>
        <div className="grid content-start gap-5">
          <section className="panel">
            <div className="panel-head"><h2>Onaycılar</h2><span className="text-sm text-ink-subtle">gönderen siz olursanız</span></div>
            <div className="panel-body grid gap-3">
              {preview.loading && !preview.data ? <Loading rows={3} /> : preview.error ? <ErrorState error={preview.error} onRetry={preview.reload} /> : preview.data?.ok ? (
                <ol className="grid gap-3" aria-label="Onay sırası">
                  {preview.data.steps!.map((s) => (
                    <li key={s.order} className="flex items-start gap-3">
                      <span className="tabular grid size-7 shrink-0 place-items-center rounded-full bg-sunken text-sm">{s.order}</span>
                      <div className="min-w-0 flex-1"><div className="font-semibold">{s.displayName}</div>
                        <div className="text-sm text-ink-muted">{s.kindLabel}{s.viaDeputy ? ' · vekil' : ''}</div></div>
                      {s.kind === 'EXTRA' && <Button size="xs" variant="outline" onClick={() => setExtra((x) => x.filter((id) => id !== s.userId))} aria-label={`${s.displayName} onaycısını çıkar`}>Çıkar</Button>}
                    </li>
                  ))}
                </ol>
              ) : <Banner tone="warn" title={preview.data?.message ?? 'Onay zinciri kurulamıyor.'}>Yönetim &gt; Onaycılar'dan atama yapılınca gönderilebilir.</Banner>}
              <label className="flex items-start gap-2"><input type="checkbox" className="mt-1 accent-[var(--ink)]" checked={useDeputy} onChange={(e) => setUseDeputy(e.target.checked)} />
                <span>Departman sorumlusu yerine vekili onaylasın</span></label>
              <div className="flex flex-wrap items-end gap-2">
                <div className="min-w-[200px] flex-1"><Field id="add-approver" label="Eklenecek onaycı" hint="Zincirin sonuna, sırayla eklenir. Satınalma ya da departman kullanıcısı.">{(p) =>
                  <select className="input" {...p} value={adding} onChange={(e) => setAdding(e.target.value)}><option value="">Seçin</option>
                    {eligible.map((m) => <option key={m.id} value={m.id}>{m.displayName}</option>)}</select>}</Field></div>
                <Button variant="outline" className="mb-4" aria-label="Onaycı ekle: seçileni zincire ekle" disabled={!adding} onClick={() => { setExtra((x) => [...x, adding]); setAdding(''); }}><Icon name="arrow" />Onaycı ekle</Button>
              </div>
              <p className="text-sm text-ink-muted">Onay sırayla ilerler. Zorunlu üç onaycı çıkarılamaz. Kendi eklediğiniz ya da gönderdiğiniz sözleşmeyi onaylayamazsınız; sizin adımınız vekile gider.</p>
            </div>
          </section>
          <section className="panel">
            <div className="panel-head"><h2>Gönderim notu</h2></div>
            <div className="panel-body"><Field label="Onaycılara not (isteğe bağlı)">{(p) => <textarea className="input" rows={3} maxLength={2000} {...p} value={note} onChange={(e) => setNote(e.target.value)} />}</Field></div>
          </section>
          <p className="text-sm text-ink-subtle">Durum: <Tag label={statusTag(d.status.code, d.status.label)} /></p>
        </div>
      </div>
    </>
  );
}
