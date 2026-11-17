import { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, ApiError } from '../lib/api.ts';
import { useResource } from '../lib/useApi.ts';
import { fmtDate, fmtDateTime } from '../lib/format.ts';
import type { Label } from '../lib/labels.ts';
import { Banner, Field, Loading, Modal, Tag } from '../ui/kit.tsx';
import { Icon } from '../ui/icons.tsx';
import { Button } from '@/components/ui/button';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { cn } from '@/lib/utils';

// v2 Faz 8 (D113, Figma 22): bir ERP özelliğinin kartı (ayrıntı paneli). Kurallar:
//  * Sır (parola / istemci sırrı) yalnız yazılır: alan hiçbir zaman doldurulmaz, sunucu değeri döndürmez; yalnız "Ayarlı · tarih" / "Ayarlı değil".
//    PUT gövdesinde sır yoksa sır değişmez; `null` sırrı kaldırır.
//  * Taklit sağlayıcının sonucu her yerde "taklit sağlayıcıyla denendi — gerçek Oracle değil" etiketlidir; gerçek başarı gibi gösterilmez.
//  * Satınalma ve Denetçi kartı salt okunur görür (`can.manage` / `can.run` sunucudan).

export type ErpFeature = 'SUPPLIER' | 'COST_CENTER' | 'REQUISITION' | 'CONTRACT_HEADER' | 'PURCHASE_ORDER' | 'INVOICE' | 'PAYMENT_STATUS';
export interface ProviderView { kind: 'TAKLIT' | 'ORACLE_EBS' | null; label: string; real: boolean; available: boolean }
type Transform = 'NONE' | 'TRIM' | 'UPPER' | 'DATE_YMD' | 'DECIMAL';
type FieldMap = Record<string, { path: string; transform: Transform }>;
export interface RunView {
  id: string; feature: string; trigger: string; triggerLabel: string; status: string; statusLabel: string; provider: { kind: string; label: string; real: boolean } | null;
  mock: boolean; startedAt: string | null; finishedAt: string | null; counts: Record<string, unknown>; errorCount: number; requestedBy: { id: string; name: string | null } | null;
}
export interface EndpointCard {
  feature: ErpFeature; label: string; direction: 'IN' | 'OUT' | 'BOTH'; directionLabel: string; stage: 1 | 2; reads: boolean; writes: boolean;
  enabled: boolean; writeEnabled: boolean; writeConfirmation: { at: string; by: { id: string; name: string | null } } | null; provider: ProviderView;
  baseUrl: string | null; resourcePath: string | null; authType: 'BASIC' | 'OAUTH2_CLIENT_CREDENTIALS' | null; username: string | null; clientId: string | null; tokenUrl: string | null;
  timeoutMs: number; secretSet: boolean; secretUpdatedAt: string | null; secretNeedsReentry: boolean; secretKeyConfigured: boolean;
  schedule: { mode: 'MANUAL' | 'INTERVAL' | 'DAILY' | 'EVENT'; intervalMinutes: number | null; dailyTime: string | null; label: string };
  fieldMap: FieldMap; defaultFieldMap: FieldMap; appFields: { key: string; label: string; required: boolean; type: 'text' | 'money' | 'date' }[]; missingMappings: string[];
  lastTest: { at: string; ok: boolean | null; message: string | null; mock: boolean } | null; lastRun: RunView | null; manualFallback: string; updatedAt: string | null;
  can: { manage: boolean; run: boolean };
}

const MOCK_NOTE = 'taklit sağlayıcıyla denendi — gerçek Oracle değil';
const DIRECTION_ICON: Record<EndpointCard['direction'], string> = { IN: 'download', OUT: 'upload', BOTH: 'refresh' };
export const directionTag = (c: EndpointCard): Label => ({ text: c.directionLabel, tone: 'neutral', icon: DIRECTION_ICON[c.direction] });
export const stateTag = (c: EndpointCard): Label => c.enabled ? { text: 'Açık', tone: 'ok', icon: 'check' } : { text: 'Kapalı', tone: 'neutral', icon: 'minus' };
const RUN_TONE: Record<string, Label['tone']> = { SUCCESS: 'ok', PARTIAL: 'warn', FAILED: 'danger', RUNNING: 'info', NOT_CONFIGURED: 'neutral' };
const RUN_ICON: Record<string, string> = { SUCCESS: 'check', PARTIAL: 'alert', FAILED: 'x', RUNNING: 'clock', NOT_CONFIGURED: 'minus' };
/** Çalışma durumu etiketi (taklit eki sunucunun etiketinde). Renk yalnız durumdan; taklit ayrıca rozetle görünür. */
export const runTag = (r: RunView): Label => ({ text: r.statusLabel, tone: RUN_TONE[r.status] ?? 'neutral', icon: RUN_ICON[r.status] ?? 'info' });
export const MOCK_TAG: Label = { text: 'Taklit', tone: 'warn', icon: 'alert', hint: 'Taklit sağlayıcı: gerçek Oracle değil' };

/** Kapalı özellikte elle giriş yolunun ekranı (R6). */
const FALLBACK_LINK: Record<ErpFeature, { to: string; label: string }> = {
  SUPPLIER: { to: '/tedarikciler', label: 'Tedarikçiler' },
  COST_CENTER: { to: '/yonetim/kullanicilar', label: 'Yönetim > Kullanıcılar ve Entra' },
  REQUISITION: { to: '/projeler', label: 'Projeler' },
  CONTRACT_HEADER: { to: '/sozlesmeler', label: 'Sözleşmeler' },
  PURCHASE_ORDER: { to: '/faturalar', label: 'Faturalar' },
  INVOICE: { to: '/faturalar', label: 'Faturalar' },
  PAYMENT_STATUS: { to: '/faturalar', label: 'Faturalar' },
};

const COUNT_LABEL: Record<string, string> = {
  read: 'okunan', created: 'oluşturulan', updated: 'güncellenen', unchanged: 'değişmeyen', skipped: 'atlanan', failed: 'hatalı',
  queued: 'kuyruğa alınan', sent: 'gönderilen', unknown: 'belirsiz',
};
const REASON_TR: Record<string, string> = {
  feature_disabled: 'Özellik kapalı; çalışma yapılmadı, ERP\'ye istek atılmadı.',
  provider_not_configured: 'Bu ortamda ERP sağlayıcısı yapılandırılmadı; çalışma yapılmadı, istek atılmadı.',
  write_not_enabled: 'ERP\'ye yazma açık değil; bekleyen kayıtlar yeniden denenmedi, istek atılmadı.',
};
/** Çalışma sayıları: çalışma türüne göre anahtarlar değişir; yalnız bilinen sayılar Türkçe adla gösterilir. */
export function countsText(counts: Record<string, unknown>): string {
  const parts = Object.entries(COUNT_LABEL).filter(([k]) => typeof counts[k] === 'number').map(([k, l]) => `${counts[k] as number} ${l}`);
  if (typeof counts.latencyMs === 'number') parts.push(`${counts.latencyMs} ms`);
  if (typeof counts.reason === 'string' && REASON_TR[counts.reason]) parts.push(REASON_TR[counts.reason]!);
  if (typeof counts.note === 'string') parts.push(counts.note);
  return parts.join(' · ') || '—';
}

const FIELD_LABEL: Record<string, string> = {
  baseUrl: 'Taban adres', resourcePath: 'Kaynak yolu', sourcePath: 'Kaynak yolu', authType: 'Kimlik doğrulama türü', username: 'Kullanıcı adı', clientId: 'İstemci kimliği',
  tokenUrl: 'Token adresi', secret: 'Parola / istemci sırrı', 'schedule.mode': 'Zamanlama', 'schedule.intervalMinutes': 'Aralık (dakika)', 'schedule.dailyTime': 'Saat',
};
const CODE_TR: Record<string, string> = {
  required: 'Zorunlu alan.', invalid: 'Geçersiz değer.', invalid_url: 'Geçerli bir adres girin (https://…).', scheme_invalid: 'Adres https:// (ya da test ortamında http://) ile başlamalı.',
  userinfo_not_allowed: 'Adreste kullanıcı adı veya parola olamaz; kimlik bilgisi ayrı alanlara girilir.', https_required: 'Üretimde yalnız https adresi kabul edilir.',
  host_not_allowed: 'Bu ana bilgisayar izinli listede değil (INTEGRATION_ALLOWED_HOSTS).', out_of_range: '15 ile 1440 dakika arasında olmalı.',
  transform_required: 'Tutar alanı "Ondalık sayı", tarih alanı "Tarih (YYYY-AA-GG)" dönüşümüyle eşlenir.', unknown_field: 'Bu özellikte böyle bir uygulama alanı yok.',
  invalid_length: 'Uzunluk geçersiz (1–4096 karakter).',
};
const TRANSFORM_LABEL: Record<Transform, string> = { NONE: 'Dönüşüm yok', TRIM: 'Boşlukları kırp', UPPER: 'Büyük harf', DATE_YMD: 'Tarih (YYYY-AA-GG)', DECIMAL: 'Ondalık sayı' };

type Notice = { tone: 'info' | 'warn' | 'danger'; title: string; text?: string } | null;

/** Kartın ayrıntısı: bağlantı formu, sınama, çalıştırma, ERP'ye yazma, son çalışmalar ve hata kaydı. */
export function EndpointDetail({ card, onChanged }: { card: EndpointCard; onChanged: () => Promise<void> }) {
  const manage = card.can.manage;
  const [notice, setNotice] = useState<Notice>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [writeDialog, setWriteDialog] = useState(false);
  const runs = useResource<{ items: RunView[] }>(`/api/v1/integration/endpoints/${card.feature}/runs?limit=20`);
  const [openRun, setOpenRun] = useState<string | null>(null);
  const reloadRuns = runs.reload;
  const refresh = useCallback(async () => { await Promise.all([onChanged(), reloadRuns()]); }, [onChanged, reloadRuns]);

  // Süren çalışma varken liste birkaç saniyede bir yenilenir (işçi bitirince durum görünsün); en fazla 3 dakika.
  const running = (runs.data?.items ?? []).some((r) => r.status === 'RUNNING');
  const pollStart = useRef<number | null>(null);
  useEffect(() => {
    if (!running) { pollStart.current = null; return; }
    pollStart.current ??= Date.now();
    const t = setTimeout(() => { if (Date.now() - (pollStart.current ?? 0) < 180_000) void refresh(); }, 3000);
    return () => clearTimeout(t);
  }, [running, runs.data, refresh]);

  async function act(key: string, fn: () => Promise<Notice>) {
    setBusy(key); setNotice(null);
    try { setNotice(await fn()); await refresh(); }
    catch (e) {
      const x = e instanceof ApiError ? e : new ApiError(0, 'error', 'İşlem tamamlanamadı.');
      setNotice({ tone: x.status === 409 || x.status === 429 ? 'warn' : 'danger', title: x.message, text: errorDetail(x, card) });
      if (x.status === 409) await refresh();
    } finally { setBusy(null); }
  }

  const toggle = () => act('toggle', async () => {
    const r = (await api<{ writeDisabled: boolean }>(`/api/v1/integration/endpoints/${card.feature}`, { method: 'PUT', json: { enabled: !card.enabled } })).data;
    return { tone: 'info', title: card.enabled ? `${card.label} kapatıldı.` : `${card.label} açıldı.`,
      text: r.writeDisabled ? 'Özellik kapandığı için ERP\'ye yazma da kapatıldı; yeniden açmak için koşullar yeniden aranır.' : card.enabled ? `Kapalıyken: ${card.manualFallback}` : undefined };
  });
  const test = () => act('test', async () => {
    const r = (await api<{ ok: boolean; message: string; latencyMs: number | null; mock: boolean; stale: boolean; staleNote: string | null; statusLabel: string }>(
      `/api/v1/integration/endpoints/${card.feature}/test`, { method: 'POST' })).data;
    return { tone: r.ok && !r.stale ? 'info' : 'warn', title: `Bağlantı sınaması: ${r.statusLabel}`,
      text: [r.message, r.latencyMs !== null ? `${r.latencyMs} ms` : null, r.mock ? 'Sonuç taklit sağlayıcıyla denendi; gerçek Oracle bağlantısı sınanmadı.' : null, r.staleNote].filter(Boolean).join(' · ') };
  });
  const run = (target: 'READ' | 'WRITE_RETRY') => act(`run-${target}`, async () => {
    const r = (await api<{ runId: string; status: string; statusLabel: string; reason: string | null; queued: number }>(`/api/v1/integration/endpoints/${card.feature}/run`,
      { method: 'POST', json: { target } })).data;
    if (r.status === 'NOT_CONFIGURED') return { tone: 'warn', title: 'Çalışma yapılmadı', text: REASON_TR[r.reason ?? ''] ?? 'Özellik hazır değil; istek atılmadı.' };
    if (target === 'WRITE_RETRY') return { tone: 'info', title: r.queued ? `${r.queued} bekleyen kayıt yeniden denenmek üzere kuyruğa alındı.` : 'Bekleyen yazma kaydı yok.', text: r.statusLabel };
    setOpenRun(r.runId);
    return { tone: 'info', title: 'Okuma başlatıldı; sonuç "Son çalışmalar"da görünür.', text: r.statusLabel };
  });
  const disableWrite = () => act('write-off', async () => {
    await api(`/api/v1/integration/endpoints/${card.feature}/write-enable`, { method: 'DELETE' });
    return { tone: 'info', title: 'ERP\'ye yazma kapatıldı.', text: 'Yeni olaylar ERP\'ye yazılmaz; elle iletim yolu açık.' };
  });

  const titleId = `ep-${card.feature}-h`;
  return (
    <section className="panel" aria-labelledby={titleId} data-feature={card.feature}>
      <div className="panel-head">
        <h2 id={titleId} className="min-w-0 flex-1">{card.label}</h2>
        <Tag label={directionTag(card)} />
        {manage ? (
          <button type="button" role="switch" aria-checked={card.enabled} aria-label={`${card.label} özelliği`} disabled={!!busy} onClick={() => void toggle()}
            className={cn('inline-flex min-h-8 items-center gap-2 rounded-md border px-2.5 text-sm font-semibold transition-colors duration-150 disabled:opacity-60',
              card.enabled ? 'border-verified bg-verified-soft text-verified' : 'border-input bg-surface text-ink-muted hover:bg-sunken')}>
            <span aria-hidden className={cn('relative inline-block h-4 w-7 rounded-full transition-colors', card.enabled ? 'bg-verified' : 'bg-border')}>
              <span className={cn('absolute top-0.5 size-3 rounded-full bg-white transition-all', card.enabled ? 'left-3.5' : 'left-0.5')} />
            </span>
            {card.enabled ? 'Açık' : 'Kapalı'}
          </button>
        ) : <Tag label={stateTag(card)} />}
      </div>
      <div className="panel-body grid gap-5">
        <div aria-live="polite" className="empty:-mb-5">{notice && <Banner tone={notice.tone} title={notice.title}>{notice.text}</Banner>}</div>
        {!card.enabled && (
          <Banner tone="neutral" icon="info" title={`Kapalıyken: ${card.manualFallback}`}>
            Elle giriş ekranı: <Link to={FALLBACK_LINK[card.feature].to}>{FALLBACK_LINK[card.feature].label}</Link>
          </Banner>
        )}
        {card.enabled && <p className="text-sm text-ink-muted">Özellik açıkken de elle giriş yolu kalır: {card.manualFallback} Elle girilen değerin kaynağı "Elle" görünür.</p>}
        {!manage && <p className="text-sm text-ink-muted">Bağlantı ayarlarını Yönetici değiştirir; bu kart sizin için salt okunur.</p>}
        <ConnectionForm card={card} onSaved={async (n) => { setNotice(n); await refresh(); }} />

        <section aria-labelledby={`${titleId}-act`} className="grid gap-3 border-t border-border pt-4">
          <h3 id={`${titleId}-act`} className="text-[15px] font-semibold">Sınama ve çalıştırma</h3>
          <LastTest card={card} />
          {card.can.run ? (
            <div className="flex flex-wrap gap-2">
              <Button variant="outline" disabled={!!busy} onClick={() => void test()}>{busy === 'test' ? 'Sınanıyor…' : 'Bağlantıyı sına'}</Button>
              {card.reads && <Button variant="outline" disabled={!!busy} onClick={() => void run('READ')}>{busy === 'run-READ' ? 'Başlatılıyor…' : card.writes ? 'Şimdi çalıştır (oku)' : 'Şimdi çalıştır'}</Button>}
              {card.writes && <Button variant="outline" disabled={!!busy} onClick={() => void run('WRITE_RETRY')}>{busy === 'run-WRITE_RETRY' ? 'Başlatılıyor…' : 'Bekleyen yazmaları yeniden dene'}</Button>}
            </div>
          ) : <p className="text-sm text-ink-muted">Sınama ve çalıştırma Yönetici'ye açıktır.</p>}
        </section>

        {card.writes && (
          <section aria-labelledby={`${titleId}-w`} className="grid gap-2 border-t border-border pt-4">
            <h3 id={`${titleId}-w`} className="text-[15px] font-semibold">ERP'ye yazma</h3>
            {card.writeEnabled ? <>
              <p><Tag label={{ text: 'ERP\'ye yazma açık', tone: 'warn', icon: 'upload' }} />
                {card.writeConfirmation && <span className="ml-2 text-sm text-ink-muted">Onaylayan {card.writeConfirmation.by.name ?? 'Yönetici'} · {fmtDateTime(card.writeConfirmation.at)}</span>}</p>
              {card.provider.kind === 'TAKLIT' && <p className="text-sm text-warn">Yazmalar taklit sağlayıcıya gider; gerçek Oracle'a kayıt yazılmaz.</p>}
              {manage && <div><Button variant="outline" size="sm" disabled={!!busy} onClick={() => void disableWrite()}>ERP'ye yazmayı kapat</Button></div>}
            </> : <>
              <p className="text-sm text-ink-muted">Kapalı (varsayılan). {card.feature === 'SUPPLIER' ? 'Okuma bu anahtardan bağımsızdır. ' : ''}Kapalıyken kayıtlar ERP'ye yazılmaz; ilgili ekranda "ERP'ye elle iletildi" kaydedilir.</p>
              {manage && <div><Button variant="outline" size="sm" disabled={!!busy} onClick={() => setWriteDialog(true)}>ERP'ye yazmayı aç</Button></div>}
            </>}
          </section>
        )}

        <RunsSection card={card} runs={runs} openRun={openRun} setOpenRun={setOpenRun} />
      </div>
      {writeDialog && <WriteEnableDialog card={card} onClose={() => setWriteDialog(false)} onDone={async (n) => { setWriteDialog(false); setNotice(n); await refresh(); }} />}
    </section>
  );
}

function errorDetail(x: ApiError, card: EndpointCard): string | undefined {
  if (x.code === 'mapping_incomplete' && Array.isArray(x.details?.missing)) {
    return `Eşlenmesi gereken zorunlu alanlar: ${(x.details.missing as string[]).map((k) => card.appFields.find((f) => f.key === k)?.label ?? k).join(', ')}.`;
  }
  if (x.code === 'endpoint_invalid' && Array.isArray(x.details?.errors)) {
    return (x.details.errors as { field: string; code: string }[]).map((e) => `${fieldName(e.field, card)}: ${CODE_TR[e.code] ?? 'Geçersiz değer.'}`).join(' ');
  }
  // v2 Faz 8 izleme: bekleme süresi sunucu iletisinde zaten yazıyorsa ikinci kez eklenmez.
  if (x.status === 429 && typeof x.details?.retryAfterSeconds === 'number' && !/\d+\s*saniye/.test(x.message)) return `${x.details.retryAfterSeconds} saniye sonra yeniden deneyin.`;
  return undefined;
}
function fieldName(field: string, card: EndpointCard): string {
  if (FIELD_LABEL[field]) return FIELD_LABEL[field]!;
  const m = /^fieldMap\.([^.]+)/.exec(field);
  if (m) return `Alan eşlemesi · ${card.appFields.find((f) => f.key === m[1])?.label ?? 'bilinmeyen alan'}`;
  return 'Alan';
}

function LastTest({ card }: { card: EndpointCard }) {
  const t = card.lastTest;
  if (!t) return <p className="text-sm text-ink-muted">Son sınama: henüz yok{card.writes ? ' (ERP\'ye yazmayı açmak için son 24 saatte başarılı sınama gerekir)' : ''}.</p>;
  return (
    <p className="text-sm">
      Son sınama {fmtDateTime(t.at)} · <span className={t.ok ? 'font-semibold' : 'font-semibold text-danger'}>{t.ok ? 'Başarılı' : 'Başarısız'}</span>
      {t.mock && <> · <span className="text-warn">{MOCK_NOTE}</span></>}
      {t.message && <span className="block text-ink-muted">{t.message}</span>}
    </p>
  );
}

// ---------- Bağlantı formu ----------

interface FormState {
  baseUrl: string; resourcePath: string; authType: '' | 'BASIC' | 'OAUTH2_CLIENT_CREDENTIALS'; username: string; clientId: string; tokenUrl: string;
  scheduleMode: 'MANUAL' | 'INTERVAL' | 'DAILY'; intervalMinutes: string; dailyTime: string; fieldMap: FieldMap;
}
const formOf = (c: EndpointCard): FormState => ({
  baseUrl: c.baseUrl ?? '', resourcePath: c.resourcePath ?? '', authType: c.authType ?? '', username: c.username ?? '', clientId: c.clientId ?? '', tokenUrl: c.tokenUrl ?? '',
  scheduleMode: c.schedule.mode === 'EVENT' ? 'MANUAL' : c.schedule.mode, intervalMinutes: c.schedule.intervalMinutes ? String(c.schedule.intervalMinutes) : '60',
  dailyTime: c.schedule.dailyTime ?? '06:00', fieldMap: c.fieldMap ?? {},
});
/** Tutar ve tarih alanlarının dönüşümü sabittir (R8); diğerlerinde seçilir. */
const fixedTransform = (type: string): Transform | null => type === 'money' ? 'DECIMAL' : type === 'date' ? 'DATE_YMD' : null;

function ConnectionForm({ card, onSaved }: { card: EndpointCard; onSaved: (n: Notice) => Promise<void> }) {
  const manage = card.can.manage;
  const [f, setF] = useState<FormState>(() => formOf(card));
  // Sunucu kartı değişince (kaydet, aç/kapat) form yeniden kurulur; yazılmış ama kaydedilmemiş değer yoksa.
  const [dirty, setDirty] = useState(false);
  const cardKey = `${card.updatedAt}|${card.feature}`;
  useEffect(() => { if (!dirty) setF(formOf(card)); }, [cardKey]); // eslint-disable-line react-hooks/exhaustive-deps
  const [secret, setSecret] = useState('');
  const [replacing, setReplacing] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [msg, setMsg] = useState<Notice>(null);
  const [busy, setBusy] = useState(false);
  const set = (patch: Partial<FormState>) => { setDirty(true); setF((x) => ({ ...x, ...patch })); };
  const idp = `ep-${card.feature}`;
  const secretOpen = !card.secretSet || card.secretNeedsReentry || replacing;
  const secretLabel = f.authType === 'OAUTH2_CLIENT_CREDENTIALS' ? 'İstemci sırrı' : 'Parola';

  function body(): Record<string, unknown> {
    const b: Record<string, unknown> = {
      baseUrl: f.baseUrl.trim() || null, resourcePath: f.resourcePath.trim() || null, authType: f.authType || null,
      username: f.authType === 'BASIC' ? f.username.trim() || null : null,
      clientId: f.authType === 'OAUTH2_CLIENT_CREDENTIALS' ? f.clientId.trim() || null : null,
      tokenUrl: f.authType === 'OAUTH2_CLIENT_CREDENTIALS' ? f.tokenUrl.trim() || null : null,
      fieldMap: Object.fromEntries(Object.entries(f.fieldMap).filter(([, v]) => v.path.trim()).map(([k, v]) => [k, { path: v.path.trim(), transform: v.transform }])),
    };
    if (card.reads) b.schedule = { mode: f.scheduleMode, intervalMinutes: f.scheduleMode === 'INTERVAL' ? Number(f.intervalMinutes) : null, dailyTime: f.scheduleMode === 'DAILY' ? f.dailyTime : null };
    // Sır yalnız yeni değer yazıldıysa gönderilir; gönderilmezse kayıtlı sır değişmez.
    if (secret) b.secret = secret;
    return b;
  }
  async function save(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true); setErrors({}); setMsg(null);
    try {
      const r = (await api<{ changed: string[]; secretChanged: boolean; writeDisabled: boolean }>(`/api/v1/integration/endpoints/${card.feature}`, { method: 'PUT', json: body() })).data;
      setSecret(''); setReplacing(false); setDirty(false);
      const connection = r.secretChanged || r.changed.some((k) => ['baseUrl', 'resourcePath', 'authType', 'username', 'clientId', 'tokenUrl'].includes(k));
      await onSaved({ tone: r.writeDisabled ? 'warn' : 'info', title: 'Bağlantı ayarları kaydedildi.',
        text: [r.secretChanged ? `${secretLabel} şifrelenerek saklandı; değer yeniden gösterilmez.` : null,
          r.writeDisabled ? 'Bağlantı değiştiği için ERP\'ye yazma kapatıldı ve son sınama sonucu silindi. Yeniden sınayıp yazmayı yeniden açın.'
            : connection && card.lastTest ? 'Bağlantı değiştiği için son sınama sonucu silindi; yeniden sınayın.' : null].filter(Boolean).join(' ') || undefined });
    } catch (x) {
      const err = x instanceof ApiError ? x : new ApiError(0, 'error', 'Kaydedilemedi.');
      setSecret(''); // Hata sonrası da sır alanı boşaltılır; değer ekranda/bellekte tutulmaz.
      if (err.code === 'endpoint_invalid' && Array.isArray(err.details?.errors)) {
        const m: Record<string, string> = {};
        for (const e of err.details.errors as { field: string; code: string }[]) m[e.field === 'sourcePath' ? 'resourcePath' : e.field] = CODE_TR[e.code] ?? 'Geçersiz değer.';
        setErrors(m);
      }
      setMsg({ tone: err.status === 409 ? 'warn' : 'danger', title: err.message, text: errorDetail(err, card) });
    } finally { setBusy(false); }
  }
  async function removeSecret() {
    setBusy(true); setMsg(null);
    try {
      await api(`/api/v1/integration/endpoints/${card.feature}`, { method: 'PUT', json: { secret: null } });
      await onSaved({ tone: 'info', title: `${secretLabel} kaldırıldı.`, text: 'Yeni değer girilene kadar ERP\'ye istek atılmaz.' });
    } catch (x) { const err = x as ApiError; setMsg({ tone: 'danger', title: err.message, text: err.code === 'endpoint_invalid' ? 'Açık özellikte sır kaldırılamaz; önce özelliği kapatın.' : errorDetail(err, card) }); }
    finally { setBusy(false); }
  }

  if (!manage) return <ReadOnlyConnection card={card} />;
  const loadDefault = () => set({ fieldMap: { ...f.fieldMap, ...card.defaultFieldMap } });
  const missing = card.appFields.filter((a) => a.required && !f.fieldMap[a.key]?.path.trim());
  return (
    <form onSubmit={save} className="grid gap-4" autoComplete="off" aria-label={`${card.label} bağlantı ayarları`}>
      <fieldset className="grid gap-x-3 min-[640px]:grid-cols-2">
        <legend className="mb-2 text-[15px] font-semibold">Adres</legend>
        <Field id={`${idp}-base`} label="Taban adres" error={errors.baseUrl} hint={card.provider.kind === 'TAKLIT' ? 'Taklit sağlayıcıda taklit:// adresi kullanılır (ör. taklit://, taklit://hata-401).' : 'İzinli listedeki https adresi.'}>
          {(p) => <input className="input mono" {...p} value={f.baseUrl} maxLength={500} onChange={(e) => set({ baseUrl: e.target.value })} />}</Field>
        <Field id={`${idp}-path`} label="Kaynak yolu" error={errors.resourcePath} hint="Ör. /webservices/rest/ap/invoices">
          {(p) => <input className="input mono" {...p} value={f.resourcePath} maxLength={200} onChange={(e) => set({ resourcePath: e.target.value })} />}</Field>
      </fieldset>

      <fieldset className="grid gap-x-3 min-[640px]:grid-cols-2">
        <legend className="mb-2 text-[15px] font-semibold">Kimlik doğrulama</legend>
        <Field id={`${idp}-auth`} label="Tür" error={errors.authType}>
          {(p) => <select className="input" {...p} value={f.authType} onChange={(e) => { set({ authType: e.target.value as FormState['authType'] }); setSecret(''); /* v2 Faz 8 izleme: tür değişince yazılan sır başka türe taşınmaz. */ }}>
            <option value="">Seçin</option><option value="BASIC">Kullanıcı adı ve parola</option><option value="OAUTH2_CLIENT_CREDENTIALS">OAuth 2.0 istemci kimliği</option></select>}</Field>
        {f.authType === 'BASIC' && <Field id={`${idp}-user`} label="Kullanıcı adı" error={errors.username}>
          {(p) => <input className="input" {...p} autoComplete="off" value={f.username} maxLength={200} onChange={(e) => set({ username: e.target.value })} />}</Field>}
        {f.authType === 'OAUTH2_CLIENT_CREDENTIALS' && <>
          <Field id={`${idp}-client`} label="İstemci kimliği" error={errors.clientId}>
            {(p) => <input className="input mono" {...p} autoComplete="off" value={f.clientId} maxLength={200} onChange={(e) => set({ clientId: e.target.value })} />}</Field>
          <Field id={`${idp}-token`} label="Token adresi" error={errors.tokenUrl}>
            {(p) => <input className="input mono" {...p} value={f.tokenUrl} maxLength={500} onChange={(e) => set({ tokenUrl: e.target.value })} />}</Field>
        </>}
        {f.authType && (
          <div className="min-[640px]:col-span-2">
            {secretOpen ? (
              <Field id={`${idp}-secret`} label={secretLabel} error={errors.secret}
                hint={!card.secretKeyConfigured ? 'Sır şifreleme anahtarı (INTEGRATION_SECRET_KEY) yapılandırılmadı; sır kaydedilemez.'
                  : card.secretNeedsReentry ? 'Sır yeniden girilmeli (anahtar değişti). Kayıtlı değer çözülemiyor; ERP\'ye istek atılmaz.'
                  : 'Şifrelenerek saklanır; kaydedildikten sonra hiçbir ekranda gösterilmez. Boş bırakılırsa kayıtlı değer değişmez.'}>
                {(p) => <div className="flex flex-wrap items-center gap-2">
                  <input className="input min-w-0 flex-1" type="password" autoComplete="off" spellCheck={false} {...p} value={secret} maxLength={4096}
                    disabled={!card.secretKeyConfigured} placeholder={card.secretSet && !card.secretNeedsReentry ? 'Yeni değer' : ''} onChange={(e) => setSecret(e.target.value)} />
                  {replacing && <Button type="button" variant="ghost" size="sm" onClick={() => { setReplacing(false); setSecret(''); }}>Vazgeç</Button>}
                </div>}
              </Field>
            ) : (
              <div className="field">
                <span id={`${idp}-secret-l`} className="text-sm font-semibold">{secretLabel}</span>
                <div role="group" className="flex flex-wrap items-center gap-2" aria-labelledby={`${idp}-secret-l`}>
                  <span data-testid="secret-state">Ayarlı · {fmtDate(card.secretUpdatedAt)}</span>
                  <Button type="button" variant="outline" size="sm" disabled={!card.secretKeyConfigured} onClick={() => setReplacing(true)}>Değiştir</Button>
                  {!card.enabled && <Button type="button" variant="ghost" size="sm" disabled={busy} onClick={() => void removeSecret()}>Kaldır</Button>}
                </div>
              </div>
            )}
            {card.secretNeedsReentry && <p className="text-sm text-warn">Sır yeniden girilmeli (anahtar değişti).</p>}
            {!card.secretSet && !card.secretNeedsReentry && <p className="text-sm text-ink-muted" data-testid="secret-state">Ayarlı değil</p>}
          </div>
        )}
      </fieldset>

      <div className="grid gap-x-3 min-[640px]:grid-cols-2">
        <div className="field"><span className="text-sm font-semibold">Yön</span><span>{card.directionLabel} <span className="text-sm text-ink-subtle">(özellikten gelir, değiştirilemez)</span></span></div>
        {card.reads ? (
          <div className="grid gap-x-3 grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
            <Field id={`${idp}-sched`} label="Zamanlama" error={errors['schedule.mode']}>
              {(p) => <select className="input" {...p} value={f.scheduleMode} onChange={(e) => set({ scheduleMode: e.target.value as FormState['scheduleMode'] })}>
                <option value="MANUAL">Yalnız elle</option><option value="INTERVAL">Aralıkla</option><option value="DAILY">Her gün</option></select>}</Field>
            {f.scheduleMode === 'INTERVAL' && <Field id={`${idp}-int`} label="Aralık (dakika)" hint="15–1440" error={errors['schedule.intervalMinutes']}>
              {(p) => <input className="input tabular" type="number" min={15} max={1440} {...p} value={f.intervalMinutes} onChange={(e) => set({ intervalMinutes: e.target.value })} />}</Field>}
            {f.scheduleMode === 'DAILY' && <Field id={`${idp}-daily`} label="Saat (İstanbul)" error={errors['schedule.dailyTime']}>
              {(p) => <input className="input tabular" type="time" {...p} value={f.dailyTime} onChange={(e) => set({ dailyTime: e.target.value })} />}</Field>}
          </div>
        ) : <div className="field"><span className="text-sm font-semibold">Zamanlama</span><span>Olay anında <span className="text-sm text-ink-subtle">(onay tamamlanınca)</span></span></div>}
      </div>

      <section aria-labelledby={`${idp}-map`} className="grid gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <h3 id={`${idp}-map`} className="flex-1 text-[15px] font-semibold">Alan eşlemesi</h3>
          <Button type="button" variant="outline" size="sm" onClick={loadDefault}>EBS varsayılanını yükle</Button>
        </div>
        <p className="text-sm text-ink-muted">ERP alan yolu nokta yoludur (ör. HEADER.INVOICE_NUM). Tutar alanları "Ondalık sayı", tarih alanları "Tarih (YYYY-AA-GG)" dönüşümüyle okunur; tutar yuvarlanmaz.</p>
        <FieldMapTable card={card} map={f.fieldMap} errors={errors} onChange={(fieldMap) => set({ fieldMap })} />
        {missing.length > 0 && <p className="text-sm text-warn">Zorunlu alan eşlenmeden özellik açılamaz: {missing.map((a) => a.label).join(', ')}.</p>}
      </section>

      <div className="flex flex-wrap items-center gap-2">
        <Button type="submit" disabled={busy}>{busy ? 'Kaydediliyor…' : 'Kaydet'}</Button>
        {dirty && <Button type="button" variant="ghost" disabled={busy} onClick={() => { setF(formOf(card)); setDirty(false); setErrors({}); setSecret(''); setReplacing(false); }}>Değişiklikleri geri al</Button>}
      </div>
      <div aria-live="polite">{msg && <Banner tone={msg.tone} title={msg.title}>{msg.text}</Banner>}</div>
    </form>
  );
}

function FieldMapTable({ card, map, errors, onChange }: { card: EndpointCard; map: FieldMap; errors?: Record<string, string>; onChange?: (m: FieldMap) => void }) {
  const edit = !!onChange;
  const put = (key: string, patch: Partial<FieldMap[string]>, type: string) => {
    const cur = map[key] ?? { path: '', transform: fixedTransform(type) ?? 'NONE' };
    onChange?.({ ...map, [key]: { ...cur, ...patch } });
  };
  return (
    <Table>
      <TableHeader><TableRow className="hover:bg-transparent"><TableHead>Uygulama alanı</TableHead><TableHead>Zorunlu</TableHead><TableHead>ERP alan yolu</TableHead><TableHead>Dönüşüm</TableHead></TableRow></TableHeader>
      <TableBody>{card.appFields.map((a) => {
        const e = map[a.key];
        const fixed = fixedTransform(a.type);
        const err = errors?.[`fieldMap.${a.key}.path`] ?? errors?.[`fieldMap.${a.key}.transform`] ?? errors?.[`fieldMap.${a.key}`];
        return (
          <TableRow key={a.key}>
            <TableCell className="min-w-32">{a.label}
              {card.feature === 'INVOICE' && a.key === 'companyTaxId' && <span className="block text-sm text-ink-subtle">Kurumda birden çok şirket varsa eşleyin; eşlenmezse ERP faturası açılmaz (alıcı şirket belirlenemedi).</span>}
              {err && <span className="block text-sm text-danger">{err}</span>}</TableCell>
            <TableCell className="whitespace-nowrap text-sm">{a.required ? 'Zorunlu' : 'İsteğe bağlı'}</TableCell>
            <TableCell className="min-w-40">{edit
              ? <input className="input mono w-full" aria-label={`${a.label} ERP alan yolu`} value={e?.path ?? ''} maxLength={120} onChange={(x) => put(a.key, { path: x.target.value }, a.type)} />
              : <span className="mono break-all">{e?.path || '—'}</span>}</TableCell>
            <TableCell className="min-w-36">{edit && !fixed
              ? <select className="input w-full" aria-label={`${a.label} dönüşüm`} value={e?.transform ?? 'NONE'} onChange={(x) => put(a.key, { transform: x.target.value as Transform }, a.type)}>
                  {(['NONE', 'TRIM', 'UPPER'] as Transform[]).map((t) => <option key={t} value={t}>{TRANSFORM_LABEL[t]}</option>)}</select>
              : <span className="text-sm">{TRANSFORM_LABEL[(fixed ?? e?.transform ?? 'NONE') as Transform]}</span>}</TableCell>
          </TableRow>
        );
      })}</TableBody>
    </Table>
  );
}

const AUTH_LABEL = { BASIC: 'Kullanıcı adı ve parola', OAUTH2_CLIENT_CREDENTIALS: 'OAuth 2.0 istemci kimliği' } as const;
/** Satınalma / Denetçi: ayarlar salt okunur; sır yalnız "Ayarlı · tarih" ya da "Ayarlı değil". */
function ReadOnlyConnection({ card }: { card: EndpointCard }) {
  return (
    <div className="grid gap-4">
      <dl className="facts">
        <dt>Taban adres</dt><dd className="mono">{card.baseUrl ?? '—'}</dd>
        <dt>Kaynak yolu</dt><dd className="mono">{card.resourcePath ?? '—'}</dd>
        <dt>Kimlik doğrulama</dt><dd>{card.authType ? AUTH_LABEL[card.authType] : '—'}</dd>
        {card.username && <><dt>Kullanıcı adı</dt><dd>{card.username}</dd></>}
        {card.clientId && <><dt>İstemci kimliği</dt><dd className="mono">{card.clientId}</dd></>}
        {card.tokenUrl && <><dt>Token adresi</dt><dd className="mono">{card.tokenUrl}</dd></>}
        <dt>{card.authType === 'OAUTH2_CLIENT_CREDENTIALS' ? 'İstemci sırrı' : 'Parola'}</dt>
        <dd data-testid="secret-state">{card.secretNeedsReentry ? 'Sır yeniden girilmeli (anahtar değişti)' : card.secretSet ? `Ayarlı · ${fmtDate(card.secretUpdatedAt)}` : 'Ayarlı değil'}</dd>
        <dt>Yön</dt><dd>{card.directionLabel}</dd>
        <dt>Zamanlama</dt><dd>{card.schedule.label}</dd>
      </dl>
      <section className="grid gap-2" aria-label={`${card.label} alan eşlemesi`}>
        <h3 className="text-[15px] font-semibold">Alan eşlemesi</h3>
        <FieldMapTable card={card} map={card.fieldMap} />
      </section>
    </div>
  );
}

// ---------- ERP'ye yazmayı açma (R3) ----------

function WriteEnableDialog({ card, onClose, onDone }: { card: EndpointCard; onClose: () => void; onDone: (n: Notice) => Promise<void> }) {
  const [confirm, setConfirm] = useState(false);
  const [err, setErr] = useState<ApiError | null>(null);
  const [busy, setBusy] = useState(false);
  const recentTest = !!card.lastTest?.ok && Date.now() - new Date(card.lastTest.at).getTime() < 24 * 3600_000;
  const conds: [boolean, string][] = [
    [card.enabled, 'Özellik açık'],
    [recentTest, 'Son 24 saatte başarılı "Bağlantıyı sına" sonucu'],
    [confirm, '"ERP\'ye kayıt yazılacağını anlıyorum" onayı'],
  ];
  async function submit() {
    setBusy(true); setErr(null);
    try {
      await api(`/api/v1/integration/endpoints/${card.feature}/write-enable`, { method: 'POST', json: { confirm } });
      await onDone({ tone: 'warn', title: 'ERP\'ye yazma açıldı.', text: card.provider.kind === 'TAKLIT' ? 'Yazmalar taklit sağlayıcıya gider; gerçek Oracle\'a kayıt yazılmaz.' : 'Onaylı olaylar ERP\'ye kayıt olarak yazılacak.' });
    } catch (x) { setErr(x as ApiError); } finally { setBusy(false); }
  }
  return (
    <Modal title={`${card.label}: ERP'ye yazmayı aç`} onClose={onClose} footer={<>
      <Button variant="ghost" onClick={onClose}>Vazgeç</Button>
      <Button disabled={busy} onClick={() => void submit()}>{busy ? 'Açılıyor…' : 'Yazmayı aç'}</Button>
    </>}>
      <div className="grid gap-3">
        <p className="text-ink-muted">Açılınca {card.feature === 'SUPPLIER' ? 'onaylanan tedarikçiler' : card.feature === 'REQUISITION' ? 'kazananı onaylanan projeler' : 'onay zinciri tamamlanan sözleşmeler'} ERP'ye kayıt olarak yazılır. Koşullar:</p>
        <ul className="grid gap-1">{conds.map(([ok, text]) => (
          <li key={text} className="flex items-start gap-2 text-sm"><Icon name={ok ? 'check' : 'x'} size={16} className={ok ? 'mt-0.5 text-verified' : 'mt-0.5 text-ink-subtle'} />
            <span>{text}<span className="sr-only">{ok ? ': sağlandı' : ': sağlanmadı'}</span></span></li>))}
        </ul>
        {card.provider.kind === 'TAKLIT' && <p className="text-sm text-warn">Taklit sağlayıcı: üretimde yazma açılamaz; bu ortamda yazmalar taklide gider.</p>}
        <label className="flex min-h-8 items-start gap-2">
          <input type="checkbox" className="mt-1 size-4 accent-ink" checked={confirm} onChange={(e) => setConfirm(e.target.checked)} />
          <span>ERP'ye kayıt yazılacağını anlıyorum</span>
        </label>
        <div aria-live="polite">{err && <Banner tone={err.status === 409 ? 'warn' : 'danger'} title={err.message}>{err.status === 409 ? 'Yazma açılmadı; hiçbir kayıt ERP\'ye gönderilmedi.' : undefined}</Banner>}</div>
      </div>
    </Modal>
  );
}

// ---------- Son çalışmalar ve hata kaydı ----------

interface RunErrors { run: RunView; items: { id: string; recordKey: string | null; code: string; message: string; payloadSha256: string | null; createdAt: string }[] }

function RunsSection({ card, runs, openRun, setOpenRun }: { card: EndpointCard; runs: ReturnType<typeof useResource<{ items: RunView[] }>>; openRun: string | null; setOpenRun: (id: string | null) => void }) {
  const items = runs.data?.items ?? [];
  const hid = `ep-${card.feature}-runs`;
  return (
    <section aria-labelledby={hid} className="grid gap-2 border-t border-border pt-4">
      <h3 id={hid} className="text-[15px] font-semibold">Son çalışmalar <span className="font-normal text-ink-muted">(en fazla 20)</span></h3>
      {runs.loading && !runs.data ? <Loading rows={3} /> : runs.error ? <p className="text-sm text-danger">Çalışmalar yüklenemedi. <button type="button" className="underline" onClick={() => void runs.reload()}>Yeniden dene</button></p>
        : !items.length ? <p className="text-sm text-ink-muted">Henüz çalışma yok.</p> : (
          <Table>
            <TableHeader><TableRow className="hover:bg-transparent"><TableHead>Tarih</TableHead><TableHead>Tetikleyen</TableHead><TableHead>Durum</TableHead><TableHead className="max-[700px]:hidden">Sayılar</TableHead><TableHead><span className="sr-only">Hata kaydı</span></TableHead></TableRow></TableHeader>
            <TableBody>{items.map((r) => (
              <TableRow key={r.id} aria-selected={openRun === r.id || undefined} className={openRun === r.id ? 'bg-sunken' : undefined}>
                <TableCell className="whitespace-nowrap text-sm tabular">{fmtDateTime(r.startedAt)}</TableCell>
                <TableCell className="text-sm">{r.triggerLabel}{r.requestedBy?.name ? <span className="block text-ink-subtle">{r.requestedBy.name}</span> : null}</TableCell>
                <TableCell><span className="flex flex-wrap gap-1"><Tag label={runTag(r)} className="whitespace-normal" />{r.mock && <Tag label={MOCK_TAG} />}</span></TableCell>
                <TableCell className="text-sm text-ink-muted max-[700px]:hidden">{countsText(r.counts)}</TableCell>
                <TableCell className="text-right">{r.errorCount > 0 || openRun === r.id
                  ? <Button size="xs" variant="outline" aria-expanded={openRun === r.id} onClick={() => setOpenRun(openRun === r.id ? null : r.id)}>Hata kaydı ({r.errorCount})</Button>
                  : <span className="text-sm text-ink-subtle">Hata yok</span>}</TableCell>
              </TableRow>))}</TableBody>
          </Table>
        )}
      {/* Çalışma bitince (durum ya da hata sayısı değişince) hata kaydı yeniden yüklenir. */}
      {openRun && <RunErrorsView key={`${openRun}|${items.find((r) => r.id === openRun)?.status}|${items.find((r) => r.id === openRun)?.errorCount}`} card={card} runId={openRun} onClose={() => setOpenRun(null)} />}
    </section>
  );
}

const VALUE_CODE_TR: Record<string, string> = {
  invalid_decimal: 'ondalık sayı değil', invalid_decimal_places: 'ondalık basamak sayısı fazla', invalid_date: 'geçersiz tarih', invalid_value: 'geçersiz değer',
  required_missing: 'eksik', invalid_currency: 'geçersiz para birimi', invalid_amount: 'geçersiz tutar', negative_amount: 'eksi tutar',
};
/** Sunucu iletisindeki "alan (kod)" parçaları (ör. "totalAmount (invalid_decimal)") alanın Türkçe adı ve açıklamasıyla gösterilir; ham kod görünmez. */
export function readableRunMessage(message: string, card: Pick<EndpointCard, 'appFields'>): string {
  return message.replace(/\b([A-Za-z][A-Za-z0-9_.]*) \(([a-z_]+)\)/g, (all, field: string, code: string) => {
    const label = card.appFields.find((f) => f.key === field)?.label;
    return label ? `${label}: ${VALUE_CODE_TR[code] ?? 'geçersiz değer'}` : all;
  });
}

function RunErrorsView({ card, runId, onClose }: { card: EndpointCard; runId: string; onClose: () => void }) {
  const r = useResource<RunErrors>(`/api/v1/integration/runs/${runId}/errors`);
  return (
    <section className="grid gap-2 rounded-md border border-border p-3" aria-label="Hata kaydı">
      <div className="flex flex-wrap items-center gap-2">
        <h4 className="flex-1 font-semibold">Hata kaydı{r.data ? ` · ${fmtDateTime(r.data.run.startedAt)}` : ''}</h4>
        {r.data && <span className="flex flex-wrap gap-1"><Tag label={runTag(r.data.run)} className="whitespace-normal" />{r.data.run.mock && <Tag label={MOCK_TAG} />}</span>}
        <Button size="xs" variant="ghost" onClick={onClose}>Kapat</Button>
      </div>
      {r.loading && !r.data ? <Loading rows={2} /> : r.error || !r.data ? <p className="text-sm text-danger">Hata kaydı yüklenemedi.</p> : <>
        <p className="text-sm text-ink-muted">{countsText(r.data.run.counts)}</p>
        {!r.data.items.length ? <p className="text-sm text-ink-muted">{r.data.run.status === 'RUNNING' ? 'Çalışma sürüyor; kayıtlar bitince görünür.' : 'Bu çalışmada hata kaydı yok.'}</p> : (
          <ul className="grid max-h-80 gap-1 overflow-y-auto">{r.data.items.map((x) => (
            <li key={x.id} className="border-b border-border py-1.5 text-sm last:border-0">
              {x.recordKey && <span className="mono mr-2 break-all">{x.recordKey}</span>}<span>{readableRunMessage(x.message, card)}</span>
            </li>))}</ul>
        )}
        <p className="text-xs text-ink-subtle">Ham ERP yükü saklanmaz; her kayıt için yalnız özet tutulur.</p>
      </>}
    </section>
  );
}
