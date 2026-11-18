import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { api, ApiError } from '../lib/api.ts';
import { useResource } from '../lib/useApi.ts';
import { fmtDate, fmtDateTime, fmtMoney } from '../lib/format.ts';
import type { Label } from '../lib/labels.ts';
import { CONTRACT_TYPES, type ContractType, type ReviewAcknowledgement, type ReviewSummary } from '../lib/contractsV2.ts';
import { Banner, Empty, ErrorState, FilterChip, Loading, Tag } from '../ui/kit.tsx';
import { Icon } from '../ui/icons.tsx';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

/**
 * v2 Faz 4 (D109, Figma 08–10): sözleşme yapay zekâ ekranlarının ortak parçaları. Okuma (AI06) önerisi ve ön inceleme (AI14) yalnız bilgidir:
 * kritik alanlar forma önceden yazılmaz, puan onay vermez ve gönderimi engellemez. Test sağlayıcısının çıktısı her yerde
 * "Test sağlayıcısı — gerçek değil" etiketiyle görünür.
 */

export const AI_DISCLAIMER = 'Yapay zekâ ön incelemesidir, hukuki görüş değildir.';
export const TEST_PROVIDER_LABEL = 'Test sağlayıcısı — gerçek değil';

export type AiRunStatus = 'QUEUED' | 'RUNNING' | 'SUCCEEDED' | 'FAILED' | 'WAITING_QUOTA' | 'NO_PROVIDER' | 'NOT_ALLOWED';
export interface AiRun {
  id: string; status: AiRunStatus; reason: string | null; provider: string | null; isTestProvider: boolean; providerLabel: string | null;
  promptVersion: string | null; responseModel: string | null; createdAt: string; finishedAt: string | null;
}
export type Confidence = 'HIGH' | 'MEDIUM' | 'LOW' | 'MISSING';
export type Decision = 'PENDING' | 'CONFIRMED' | 'CORRECTED' | 'REJECTED';
export interface ExtractionField {
  id: string; field: string; label: string; value: string | null; page: number | null; evidence: string | null; confidence: Confidence; flags: string[];
  requiresHuman: boolean; critical: boolean; prefill: boolean; decision: Decision; decidedBy: { id: string; displayName: string } | null; decidedAt: string | null;
  /** Persona K6: yalnız VKN önerisinde — aynı VKN ile kayıtlı, kullanılabilir kart (aday ucu yeni kart açmaz, bunu seçer). */
  existingSupplier?: { id: string; legalName: string } | null;
}
export interface ExtractionsRes { familyId: string; contractVersionId: string; documentVersionId: string; run: AiRun | null; fields: ExtractionField[]; can: { request: boolean } }

export type Severity = 'HIGH' | 'MEDIUM' | 'LOW' | 'INFO';
export interface Finding {
  id: string; category: string; categoryLabel: string; kind: string; severity: Severity; title: string; quote: string | null; page: number | null;
  templateRef: string | null; suggestion: string | null; verified: boolean; sourceLabel: string | null;
}
interface ReviewBase {
  id: string; score: number; documentVersionId: string; template: { code: string; versionNo: number } | null; modelId: string | null; promptVersion: string;
  rubricVersion: string; isTestProvider: boolean; providerLabel: string | null; stale: boolean; createdAt: string;
}
export interface Review extends ReviewBase {
  subScoreList: { category: string; label: string; score: number | null }[]; summary: string | null; templateNote: string | null; findings: Finding[];
  templateAutoPicked?: boolean; templateUsageNote?: string | null;
}
export interface ReviewsRes {
  familyId: string; contractVersionId: string; documentVersionId: string; templateVersionId: string | null;
  current: Review | null; run: AiRun | null; history: ReviewBase[]; threshold: number; belowThreshold: boolean; advice: string | null; disclaimer: string;
  submitAcknowledgement?: ReviewAcknowledgement | null;
  can: { request: boolean };
}

/** Çalışmayan (yönlenmemiş ya da bekleyen) iş: yeniden istemek ücret yaratmaz (çağrı yapılmadı). */
export const WAITING: AiRunStatus[] = ['WAITING_QUOTA', 'NO_PROVIDER', 'NOT_ALLOWED'];
const ACTIVE: AiRunStatus[] = ['QUEUED', 'RUNNING'];

export function runLabel(run: AiRun | null, kind: 'read' | 'review'): Label {
  if (!run) return { text: kind === 'read' ? 'Okunmadı' : 'İncelenmedi', tone: 'neutral', icon: 'minus' };
  switch (run.status) {
    case 'QUEUED': return { text: 'Kuyrukta', tone: 'info', icon: 'clock' };
    case 'RUNNING': return { text: kind === 'read' ? 'Okunuyor' : 'İnceleniyor', tone: 'info', icon: 'refresh' };
    case 'SUCCEEDED': return { text: 'Tamamlandı', tone: 'info', icon: 'check' }; // yeşil çerçeve yalnız kural doğrulaması (Three-Ink Rule)
    case 'FAILED': return { text: 'Başarısız', tone: 'danger', icon: 'x' };
    // Persona K5: politika ya da sağlayıcı yokken inceleme beklemez, hiç çalışmaz; etiket bunu söyler (okuma "Yeniden oku" ile sürer, etiketi aynı).
    case 'NOT_ALLOWED': case 'NO_PROVIDER': if (kind === 'review') return { text: 'Çalışmayacak', tone: 'neutral', icon: 'minus' };
      return { text: 'Bekliyor', tone: 'warn', icon: 'clock' };
    default: return { text: 'Bekliyor', tone: 'warn', icon: 'clock' };
  }
}

/** Sunucu sebebi yoksa durumdan Türkçe açıklama (ham kod gösterilmez). */
export function runReason(run: AiRun | null, kind: 'read' | 'review' = 'read'): string | null {
  if (!run) return null;
  if (run.reason) return run.reason;
  return ({ WAITING_QUOTA: 'Aylık yapay zekâ bütçesi doldu.', NO_PROVIDER: 'Etkin yapay zekâ sağlayıcısı yok.', NOT_ALLOWED: 'Kiracı politikası bu sağlayıcıya izin vermiyor.',
    FAILED: kind === 'review' ? 'İnceleme tamamlanamadı.' : 'Okuma tamamlanamadı.' } as Partial<Record<AiRunStatus, string>>)[run.status] ?? null;
}

/** Decimal string → tr-TR ("1250000.5" → "1.250.000,50"); kayan noktaya çevrilmez. En az 2 ondalık, fazlası korunur. */
export function trDecimal(v: string | null | undefined): string {
  if (v == null || v === '') return '—';
  const m = /^(-?)(\d+)(?:\.(\d+))?$/.exec(v.trim());
  if (!m) return v;
  const int = m[2]!.replace(/^0+(?=\d)/, '').replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  return `${m[1]}${int},${(m[3] ?? '').padEnd(2, '0')}`;
}
/** Tutarları normalize decimal string olarak karşılaştırır ("48000" = "48000.00"); sayı dönüşümü yok. */
export function sameDecimal(a: string | null | undefined, b: string | null | undefined): boolean {
  const n = (v: string | null | undefined) => {
    const m = v == null ? null : /^(-?)(\d+)(?:\.(\d+))?$/.exec(v.trim());
    if (!m) return null;
    return `${m[1]}${m[2]!.replace(/^0+(?=\d)/, '')}.${(m[3] ?? '').replace(/0+$/, '')}`;
  };
  const x = n(a); const y = n(b);
  return x !== null && x === y;
}

export function TestProviderTag({ show = true, className }: { show?: boolean; className?: string }) {
  if (!show) return null;
  return <Tag className={className} label={{ text: TEST_PROVIDER_LABEL, tone: 'warn', icon: 'alert', hint: 'Test sağlayıcısının çıktısı gerçek okuma ya da gerçek inceleme değildir.' }} />;
}

/**
 * R11: iş kuyruktayken ya da çalışırken 3 sn aralıkla yeniden sorar; 2 dk sonra sormayı bırakır (`timedOut`). Ağ hatasında da durur.
 */
export function usePolled<T extends { run: AiRun | null }>(path: string | null) {
  const r = useResource<T>(path);
  const started = useRef(Date.now());
  const [timedOut, setTimedOut] = useState(false);
  const active = !!r.data?.run && ACTIVE.includes(r.data.run.status);
  const reload = r.reload;
  useEffect(() => {
    if (!active) return;
    if (Date.now() - started.current > 120_000) { setTimedOut(true); return; }
    const t = setTimeout(() => void reload(), 3000);
    return () => clearTimeout(t);
  }, [active, r.data, reload]);
  const restart = () => { started.current = Date.now(); setTimedOut(false); };
  return { ...r, active, timedOut: active && timedOut, restart };
}

const BOOL = (v: string) => (v === 'true' ? 'Evet' : v === 'false' ? 'Hayır' : v);
/** Normalize öneri değeri → ekranda tr-TR (ham kod gösterilmez). */
export function formatAiValue(field: string, value: string | null, currency?: string | null): string {
  if (value === null) return '—';
  switch (field) {
    case 'amount': return currency ? fmtMoney(value, currency) : trDecimal(value);
    case 'signedOn': case 'startDate': case 'endDate': return fmtDate(value);
    case 'indefinite': case 'autoRenewal': return BOOL(value);
    case 'contractType': return CONTRACT_TYPES[value as ContractType] ?? value;
    case 'limitBasis': return value === 'NET' ? 'KDV hariç' : value === 'GROSS' ? 'KDV dahil' : value;
    case 'noticePeriodDays': case 'paymentTermDays': return `${value} gün`;
    default: return value;
  }
}

export const CONFIDENCE: Record<Confidence, Label> = {
  HIGH: { text: 'Yüksek', tone: 'ai', icon: 'sparkles', hint: 'Alıntı belgede doğrulandı; model güveni yüksek. Yine de belgeyle karşılaştırın.' },
  MEDIUM: { text: 'Orta', tone: 'ai', icon: 'sparkles', hint: 'Alıntı belgede doğrulandı; model güveni orta.' },
  LOW: { text: 'Düşük', tone: 'warn', icon: 'help', hint: 'Düşük güven: öneri forma yazılmaz.' },
  MISSING: { text: 'Okunamadı', tone: 'neutral', icon: 'minus', hint: 'Belgede bulunamadı ya da kaynağı doğrulanamadı.' },
};

const FLAG_TEXT: Record<string, string> = {
  UNVERIFIED_SCAN: 'Taranmış sayfa: alıntı doğrulanamadı', UNDERIVABLE: 'Değer alıntıdan kesin türetilemedi', SOURCE_NOT_FOUND: 'Kaynak alıntı belgede bulunamadı',
  VALUE_NOT_IN_SOURCE: 'Değer alıntıda yok', NO_SOURCE: 'Kaynak gösterilmedi', SHORT_QUOTE: 'Alıntı çok kısa', INVALID_TAX_ID: 'VKN kontrol basamağı tutmuyor',
  INVALID_VALUE: 'Değer biçimi geçersiz', INVALID_FORMAT: 'Değer biçimi geçersiz', SOURCE_NOT_VERIFIED: 'Kaynak doğrulanamadı',
};
/** İşaret kodları ekranda Türkçe; bilinmeyen kod ham gösterilmez. MISSING zaten güven etiketinde. */
export const flagTexts = (flags: string[]) => [...new Set(flags.filter((f) => f !== 'MISSING').map((f) => FLAG_TEXT[f] ?? 'Denetim işareti var'))];

export const SEVERITY: Record<Severity, Label> = {
  HIGH: { text: 'Yüksek', tone: 'danger', icon: 'x' }, MEDIUM: { text: 'Orta', tone: 'warn', icon: 'alert' },
  LOW: { text: 'Düşük', tone: 'info', icon: 'info' }, INFO: { text: 'Bilgi', tone: 'neutral', icon: 'info' },
};
const KIND: Record<string, string> = {
  MISSING_CLAUSE: 'Şablondaki madde eksik', MODIFIED_CLAUSE: 'Şablondan farklı', UNFAVORABLE: 'Kurum aleyhine', EXTRA_CLAUSE: 'Şablonda olmayan madde', LEGAL_RISK: 'Hukuki risk',
};
const SEVERITIES: Severity[] = ['HIGH', 'MEDIUM', 'LOW', 'INFO'];

const AI_TAG: Label = { text: 'Yapay zekâ önerisi', tone: 'ai', icon: 'sparkles' };

function Provenance({ r }: { r: ReviewBase }) {
  return (
    <p className="text-sm text-ink-subtle [overflow-wrap:anywhere]">
      Model <span className="mono">{r.modelId ?? '—'}</span> · istem <span className="mono">{r.promptVersion}</span> · puan kuralı <span className="mono">{r.rubricVersion}</span>
      {' · '}{r.template ? `şablon ${r.template.code} v${r.template.versionNo}` : 'şablon yok'} · {fmtDateTime(r.createdAt)}
    </p>
  );
}

function ScoreValue({ score, size = 'lg' }: { score: number; size?: 'lg' | 'md' }) {
  return <p className="m-0 flex items-baseline gap-1"><span className={cn('tabular font-bold leading-none', size === 'lg' ? 'text-[2.5rem]' : 'text-[1.75rem]')}>{score}</span><span className="text-ink-muted">/ 100</span></p>;
}

/** Bekleyen/çalışmayan/başarısız inceleme işinin dürüst durumu. */
function RunState({ data, kind, timedOut }: { data: { run: AiRun | null }; kind: 'read' | 'review'; timedOut?: boolean }) {
  const run = data.run;
  if (!run) return <p className="text-ink-muted">{kind === 'review' ? 'Bu belge sürümü için ön inceleme yapılmadı. Onaycılar belgeyi kendileri inceler.' : 'Okuma istenmedi.'}</p>;
  if (ACTIVE.includes(run.status)) return <p className="text-ink-muted" role="status">{timedOut ? (kind === 'review' ? 'İnceleme sürüyor; gönderim için beklemeniz gerekmez.' : 'Okuma sürüyor, alanları elle girebilirsiniz.') : kind === 'review' ? 'İnceleniyor… Sonuç birkaç saniye içinde burada görünür.' : 'Okunuyor…'}</p>;
  if (run.status === 'SUCCEEDED') return null;
  if (kind === 'review' && (run.status === 'NOT_ALLOWED' || run.status === 'NO_PROVIDER')) {
    return <p className="text-ink-muted"><span className="font-semibold text-ink">Ön inceleme çalışmayacak:</span> {run.reason ?? runReason(run, 'review')} İnceleme yapılmadı; gönderim yine açık, onaycılar belgeyi kendileri inceler.</p>;
  }
  return <p className="text-ink-muted"><span className="font-semibold text-ink">{run.status === 'FAILED' ? 'İnceleme tamamlanamadı.' : 'İnceleme yapılmadı.'}</span> {run.reason ?? (run.status === 'FAILED' ? '' : runReason(run, 'review'))} Gönderim yine açık; onaycılar belgeyi kendileri inceler.</p>;
}

// --- Sihirbaz 4. adım: inceleme kartı (Figma 09) --------------------------------------------------------------------------

/**
 * İncele ve gönder adımındaki kart. Taşınan kural: istek yalnız iş yoksa ya da çalışmadan bekliyorsa (ücret yaratmaz) otomatik gönderilir;
 * ücretli denemesi başarısız olmuş iş kendiliğinden yeniden istenmez ("Yeniden incele" kullanıcı eylemidir).
 */
export function ReviewCard({ familyId, onAddApprover }: { familyId: string; onAddApprover: () => void }) {
  const r = usePolled<ReviewsRes>(`/api/v1/contracts/${familyId}/reviews`);
  const asked = useRef(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const d = r.data;
  const request = async () => {
    setBusy(true); setErr(null);
    try { await api(`/api/v1/contracts/${familyId}/reviews`, { method: 'POST' }); r.restart(); await r.reload(); }
    catch (e) { setErr((e as ApiError).message); } finally { setBusy(false); }
  };
  useEffect(() => {
    if (!d || asked.current || !d.can.request) return;
    const fresh = d.current && !d.current.stale;
    if (!fresh && (!d.run || WAITING.includes(d.run.status))) { asked.current = true; void request(); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [d]);
  const cur = d?.current && !d.current.stale ? d.current : null;
  const counts = cur ? SEVERITIES.map((s) => [s, cur.findings.filter((f) => f.verified && f.severity === s).length] as const).filter(([, n]) => n > 0) : [];
  const top = cur ? [...cur.findings].sort((a, b) => Number(b.verified) - Number(a.verified) || SEVERITIES.indexOf(a.severity) - SEVERITIES.indexOf(b.severity)).slice(0, 3) : [];
  return (
    <section className="panel" aria-labelledby="review-card-h">
      <div className="panel-head"><h2 id="review-card-h" className="flex-1">Ön inceleme</h2>
        {d && <><TestProviderTag show={cur ? cur.isTestProvider : !!d.run?.isTestProvider} />{cur ? <Tag label={AI_TAG} /> : <Tag label={runLabel(d.run, 'review')} />}</>}</div>
      <div className="panel-body grid gap-3">
        {r.loading && !d ? <Loading rows={2} /> : r.error && !d ? <ErrorState error={r.error} onRetry={r.reload} /> : d && <>
          {cur ? <>
            {d.belowThreshold && d.advice && <Banner tone="warn" title={d.advice}
              action={<Button size="sm" variant="outline" aria-label="Onaycı ekle alanına git" onClick={onAddApprover}><Icon name="arrow" />Onaycı ekle</Button>}>
              Puan {cur.score}, eşik {d.threshold}. Öneri zorunlu değildir; gönderim açık kalır.</Banner>}
            <div className="flex flex-wrap items-start gap-x-6 gap-y-3">
              <ScoreValue score={cur.score} />
              <div className="min-w-0 flex-1 grid gap-1">
                <p className="m-0 font-semibold">{counts.length ? counts.map(([s, n]) => `${n} ${SEVERITY[s].text.toLocaleLowerCase('tr-TR')}`).join(' · ') + ' önemde bulgu' : 'Doğrulanmış bulgu yok'}
                  {cur.findings.some((f) => !f.verified) ? <span className="font-normal text-ink-muted"> · {cur.findings.filter((f) => !f.verified).length} kaynağı doğrulanamayan (puana girmez)</span> : null}</p>
                <p className="m-0 text-sm text-ink-muted">{AI_DISCLAIMER} Eşik {d.threshold}.</p>
                {cur.templateNote && <p className="m-0 text-sm text-ink-muted">{cur.templateNote}</p>}
                {cur.templateUsageNote && <p className="m-0 text-sm text-ink-muted">{cur.templateUsageNote}</p>}
              </div>
            </div>
            <ul className="grid gap-x-4 gap-y-1 text-sm min-[641px]:grid-cols-2" aria-label="Alt puanlar">
              {cur.subScoreList.map((s) => <li key={s.category} className="flex justify-between gap-2 border-b border-border py-0.5"><span className="text-ink-muted">{s.label}</span><span className="tabular">{s.score ?? '—'}</span></li>)}
            </ul>
            {top.length > 0 && <ul className="grid gap-2" aria-label="İlk bulgular">{top.map((f) => (
              <li key={f.id} className="flex flex-wrap items-start gap-2"><Tag label={SEVERITY[f.severity]} />
                <span className="min-w-0 flex-1"><span className="font-semibold">{f.title}</span>{f.page ? <span className="text-sm text-ink-subtle"> · s. {f.page}</span> : null}
                  {f.sourceLabel && <span className="ml-1 text-sm text-warn">({f.sourceLabel})</span>}</span></li>))}</ul>}
            {cur.summary && <p className="m-0 text-sm"><span className="font-semibold">Yorum:</span> {cur.summary}</p>}
            <Provenance r={cur} />
            <p className="m-0 text-sm text-ink-muted">Ayrıntılar sözleşmenin İnceleme sekmesinde. Puan onay vermez ve gönderimi engellemez.</p>
          </> : <>
            {d.current?.stale && <p className="m-0 text-sm text-ink-muted">Önceki inceleme (puan {d.current.score}{d.current.isTestProvider ? ` · ${TEST_PROVIDER_LABEL}` : ''}) güncel değil: belge ya da şablon sürümü değişti.</p>}
            <RunState data={d} kind="review" timedOut={r.timedOut} />
          </>}
          {d.can.request && !r.active && !cur && !busy && (
            <Button size="sm" variant="outline" className="justify-self-start" disabled={busy} onClick={() => void request()}><Icon name="refresh" />{d.current ? 'Yeniden incele' : 'İncele'}</Button>)}
          {err && <Banner tone="danger" title={err} />}
        </>}
      </div>
    </section>
  );
}

// --- Detay İnceleme sekmesi (Figma 10) ------------------------------------------------------------------------------------

function ScoreRing({ score }: { score: number }) {
  const c = 2 * Math.PI * 34;
  return (
    <div className="relative size-[88px] shrink-0" role="img" aria-label={`Ön inceleme puanı ${score} / 100`}>
      <svg viewBox="0 0 80 80" className="size-full -rotate-90" aria-hidden="true">
        <circle cx="40" cy="40" r="34" fill="none" stroke="var(--surface-sunken)" strokeWidth="8" />
        <circle cx="40" cy="40" r="34" fill="none" stroke="var(--ink)" strokeWidth="8" strokeDasharray={`${(c * score) / 100} ${c}`} strokeLinecap="butt" />
      </svg>
      <span className="tabular absolute inset-0 grid place-items-center text-[1.5rem] font-bold">{score}</span>
    </div>
  );
}

export function ReviewDetail({ familyId, documentHref }: { familyId: string; documentHref: (page: number) => string }) {
  const r = usePolled<ReviewsRes>(`/api/v1/contracts/${familyId}/reviews`);
  const [sev, setSev] = useState<Severity | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ tone: 'info' | 'danger'; text: string } | null>(null);
  if (r.loading && !r.data) return <div className="page"><Loading rows={6} /></div>;
  if (r.error || !r.data) return <div className="page"><ErrorState error={r.error} onRetry={r.reload} /></div>;
  const d = r.data;
  const cur = d.current;
  const request = async () => {
    setBusy(true); setMsg(null);
    try { const x = await api<{ status: AiRunStatus; reason: string | null }>(`/api/v1/contracts/${familyId}/reviews`, { method: 'POST' });
      setMsg({ tone: 'info', text: x.data.status === 'QUEUED' || x.data.status === 'RUNNING' ? 'İnceleme istendi.' : x.data.reason ?? 'İnceleme istendi.' }); r.restart(); await r.reload(); }
    catch (e) { setMsg({ tone: 'danger', text: (e as ApiError).message }); } finally { setBusy(false); }
  };
  // R9: çalışmış iş yeniden ücret yaratmaz; yeni çağrı yalnız güncel olmayan/eksik incelemede ya da başarısız/bekleyen işte anlamlı.
  const canAsk = d.can.request && !r.active && (!cur || cur.stale || (d.run && d.run.status !== 'SUCCEEDED'));
  const findings = cur ? cur.findings.filter((f) => !sev || f.severity === sev) : [];
  return (
    <div className="page grid gap-5">
      <div className="flex flex-wrap items-center gap-2">
        <p className="m-0 min-w-[min(100%,20rem)] flex-1 text-ink-muted">{d.disclaimer} Puan onay vermez, onayı engellemez; onaycılar bilgi olarak görür.</p>
        <TestProviderTag show={cur ? cur.isTestProvider : !!d.run?.isTestProvider} />
        {canAsk && <Button size="sm" variant="outline" disabled={busy} onClick={() => void request()}><Icon name="refresh" />{cur ? 'Yeniden incele' : 'İncele'}</Button>}
      </div>
      {msg && <Banner tone={msg.tone} title={msg.text} />}
      {cur?.stale && <Banner tone="warn" title="Bu inceleme güncel değil">Belge ya da şablon sürümü incelemeden sonra değişti. {d.can.request ? '"Yeniden incele" ile güncel sürüm incelenir.' : 'Güncel sürümü sözleşmeyi ekleyen ya da Satınalma inceletir.'}</Banner>}
      {!cur ? (
        <div className="rounded-md border border-border bg-surface"><Empty icon="sparkles" title={d.run && ACTIVE.includes(d.run.status) ? 'İnceleniyor' : 'Ön inceleme yok'}>
          <RunState data={d} kind="review" timedOut={r.timedOut} /></Empty></div>
      ) : <>
        {!cur.stale && d.run && d.run.status !== 'SUCCEEDED' && <Banner tone="neutral" title={`Son istek: ${runLabel(d.run, 'review').text}`}>{runReason(d.run, 'review')}</Banner>}
        <div className="grid grid-cols-[360px_minmax(0,1fr)] gap-5 max-[1100px]:grid-cols-1">
          <section className="panel self-start" aria-labelledby="score-h">
            <div className="panel-head"><h2 id="score-h" className="flex-1">Ön inceleme puanı</h2><Tag label={AI_TAG} /></div>
            <div className="panel-body grid gap-3">
              <div className="flex items-center gap-4"><ScoreRing score={cur.score} />
                <div className="grid gap-1 text-sm"><span>Eşik <span className="tabular">{d.threshold}</span></span>
                  {d.belowThreshold && <Tag label={{ text: 'Eşiğin altında', tone: 'warn', icon: 'alert' }} />}
                  {cur.templateNote && <span className="text-ink-muted">{cur.templateNote}</span>}</div></div>
              {cur.templateUsageNote && <p className="m-0 text-sm text-ink-muted">{cur.templateUsageNote}</p>}
              {d.belowThreshold && d.advice && <p className="m-0 text-sm text-warn">{d.advice}</p>}
              {d.submitAcknowledgement && <AckLine ack={d.submitAcknowledgement} />}
              <table className="w-full text-left text-sm">
                <caption className="sr-only">Alt puanlar</caption>
                <thead><tr className="text-ink-muted"><th scope="col" className="py-1 font-semibold">Başlık</th><th scope="col" className="py-1 text-right font-semibold">Puan</th></tr></thead>
                <tbody>{cur.subScoreList.map((s) => <tr key={s.category} className="border-t border-border"><td className="py-1">{s.label}</td><td className="tabular py-1 text-right">{s.score ?? '—'}</td></tr>)}</tbody>
              </table>
              <Provenance r={cur} />
            </div>
          </section>
          <div className="grid content-start gap-5">
            <section className="panel" aria-labelledby="findings-h">
              <div className="panel-head flex-wrap"><h2 id="findings-h" className="flex-1">Bulgular</h2>
                <div className="flex flex-wrap gap-1.5" role="group" aria-label="Önem süzgeci">
                  <FilterChip pressed={!sev} onClick={() => setSev(null)} count={cur.findings.length}>Tümü</FilterChip>
                  {SEVERITIES.map((s) => <FilterChip key={s} pressed={sev === s} onClick={() => setSev(sev === s ? null : s)} count={cur.findings.filter((f) => f.severity === s).length}>{SEVERITY[s].text}</FilterChip>)}
                </div></div>
              <div className="panel-body">
                {!findings.length ? <p className="text-ink-muted">{cur.findings.length ? 'Bu önemde bulgu yok.' : 'Bulgu yok.'}</p> : (
                  <ul className="grid gap-4">{findings.map((f) => (
                    <li key={f.id} className="grid gap-1 border-t border-border pt-3 first:border-t-0 first:pt-0">
                      <div className="flex flex-wrap items-center gap-2"><Tag label={SEVERITY[f.severity]} /><span className="font-semibold">{f.title}</span>
                        {!f.verified && <Tag label={{ text: f.sourceLabel ?? 'kaynak doğrulanamadı', tone: 'neutral', icon: 'help', hint: 'Alıntı belgede ya da şablonda bulunamadı; puana girmez.' }} />}</div>
                      <p className="m-0 text-sm text-ink-muted">{KIND[f.kind] ?? 'Bulgu'} · {f.categoryLabel}</p>
                      {f.quote && <blockquote className="m-0 border-l-2 border-dashed border-ai pl-3 text-sm [overflow-wrap:anywhere]">“{f.quote}”</blockquote>}
                      {f.templateRef && f.kind === 'MISSING_CLAUSE' && <p className="m-0 text-sm text-ink-muted">Şablonda: {f.templateRef}</p>}
                      {f.suggestion && <p className="m-0 text-sm"><span className="font-semibold">Öneri:</span> {f.suggestion}</p>}
                      {f.page ? <Link className="justify-self-start text-sm font-semibold" aria-label={`Belgeyi ${f.page}. sayfada aç`} to={documentHref(f.page)}>{f.page}. sayfa</Link> : null}
                    </li>))}</ul>
                )}
              </div>
            </section>
            {cur.summary && <section className="panel"><div className="panel-head"><h2>Genel yorum</h2></div><div className="panel-body"><p className="m-0">{cur.summary}</p></div></section>}
          </div>
        </div>
      </>}
      {d.history.length > 0 && (
        <section className="panel" aria-labelledby="hist-h">
          <div className="panel-head"><h2 id="hist-h">Geçmiş incelemeler</h2></div>
          <div className="panel-body overflow-x-auto" tabIndex={0} role="region" aria-label="Geçmiş incelemeler">
            <table className="w-full text-left text-sm">
              <thead className="text-ink-muted"><tr><th scope="col" className="py-1 pr-3 font-semibold">Tarih</th><th scope="col" className="py-1 pr-3 text-right font-semibold">Puan</th>
                <th scope="col" className="py-1 pr-3 font-semibold">Şablon</th><th scope="col" className="py-1 pr-3 font-semibold">Model</th><th scope="col" className="py-1 font-semibold">Durum</th></tr></thead>
              <tbody>{d.history.map((h) => <tr key={h.id} className="border-t border-border">
                <td className="tabular whitespace-nowrap py-1.5 pr-3">{fmtDateTime(h.createdAt)}</td><td className="tabular py-1.5 pr-3 text-right">{h.score}</td>
                <td className="py-1.5 pr-3">{h.template ? `${h.template.code} v${h.template.versionNo}` : 'Yok'}</td>
                <td className="py-1.5 pr-3"><span className="mono">{h.modelId ?? '—'}</span>{h.isTestProvider && <span className="block text-warn">{TEST_PROVIDER_LABEL}</span>}</td>
                <td className="py-1.5">{h.stale ? <Tag label={{ text: 'Güncel değil', tone: 'neutral', icon: 'archive' }} /> : <Tag label={{ text: 'Güncel', tone: 'info', icon: 'check' }} />}</td></tr>)}</tbody>
            </table>
          </div>
        </section>
      )}
    </div>
  );
}

// --- Onaylar sekmesi: onaycıya bilgi ---------------------------------------------------------------------------------------

/** Persona K3: gönderenin gönderim anında eşik altı puanı onayladığı (o anki eşikle; canlı eşik sonradan değişebilir). */
function AckLine({ ack }: { ack: ReviewAcknowledgement }) {
  return (
    <span className="flex flex-wrap items-center gap-x-2 text-sm text-warn" data-testid="review-ack">
      <Icon name="alert" />{ack.text}
      <span className="text-ink-subtle">{ack.by ? `${ack.by.displayName} · ` : ''}{fmtDateTime(ack.at)}</span>
    </span>
  );
}

export function ReviewApprovalNote({ review, href }: { review: ReviewSummary; href: string }): ReactNode {
  return (
    <section className="panel" aria-labelledby="review-note-h">
      <div className="panel-head flex-wrap"><h2 id="review-note-h" className="flex-1">Ön inceleme (bilgi)</h2><TestProviderTag show={review.isTestProvider} /><Tag label={AI_TAG} /></div>
      <div className="panel-body flex flex-wrap items-center gap-x-6 gap-y-2">
        <ScoreValue score={review.score} size="md" />
        <div className="min-w-0 flex-1 grid gap-1 text-sm">
          <span>Eşik <span className="tabular">{review.threshold}</span>{review.belowThreshold ? ' · eşiğin altında' : ''}{review.stale ? ' · güncel değil (belge ya da şablon değişti)' : ''}</span>
          {review.submitAcknowledgement && <AckLine ack={review.submitAcknowledgement} />}
          {review.templateUsageNote && <span className="text-ink-muted">{review.templateUsageNote}</span>}
          <span className="text-ink-muted">{review.disclaimer} Onay kararınızı etkilemez; belgeyi siz incelersiniz.</span>
        </div>
        <Link to={href} className="text-sm font-semibold">Bulguları gör</Link>
      </div>
    </section>
  );
}
