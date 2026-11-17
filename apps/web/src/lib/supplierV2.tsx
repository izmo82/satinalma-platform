// v2 Faz 5 (D110): tedarikçi portalı, başvuru ve kart ekranlarının ortak etiketleri. Durumlar sunucunun Türkçe etiketiyle gelir; ton koddan
// seçilir (renk tek başına anlam taşımaz: ikon + metin). Ham kod (NOT_CONFIGURED, EXPIRING …) ekranda görünmez.
import { apiBlob } from './api.ts';
import type { Label, Tone } from './labels.ts';
import { Tag } from '../ui/kit.tsx';

/** R1: v2 aşaması (türetilir). Metin sunucunun `stageLabel`'ı (ör. "Onaylı (koşullu)"); yoksa varsayılan. */
const STAGE: Record<string, Label> = {
  APPLICATION: { text: 'Başvuru', tone: 'info', icon: 'inbox' },
  CANDIDATE: { text: 'Aday', tone: 'warn', icon: 'clock' },
  APPROVED: { text: 'Onaylı', tone: 'human', icon: 'stamp' },
  PASSIVE: { text: 'Pasif', tone: 'neutral', icon: 'archive' },
  REJECTED: { text: 'Reddedildi', tone: 'neutral', icon: 'x' },
  MERGED: { text: 'Birleştirildi', tone: 'neutral', icon: 'minus' },
};
export const stageTag = (stage: string | null | undefined, label?: string | null): Label | undefined => {
  const base = stage ? STAGE[stage] : undefined;
  if (!base) return label ? { text: label, tone: 'neutral', icon: 'info' } : undefined;
  return { ...base, text: label ?? base.text };
};
export const STAGE_FILTERS = [['', 'Tümü'], ['basvuru', 'Başvuru'], ['CANDIDATE', 'Aday'], ['APPROVED', 'Onaylı'], ['PASSIVE', 'Pasif'], ['REJECTED', 'Reddedildi']] as const;

/** R2 başvuru durumu. */
const APP_TONE: Record<string, [Tone, string]> = {
  UNVERIFIED: ['neutral', 'help'], SUBMITTED: ['info', 'clock'], NEEDS_DOCUMENTS: ['warn', 'alert'], APPROVED: ['ok', 'check'], REJECTED: ['neutral', 'x'], EXPIRED: ['neutral', 'minus'],
};
const APP_TEXT: Record<string, string> = {
  UNVERIFIED: 'E-posta doğrulanmadı', SUBMITTED: 'İnceleme bekliyor', NEEDS_DOCUMENTS: 'Eksik belge bekleniyor', APPROVED: 'Onaylandı', REJECTED: 'Reddedildi', EXPIRED: 'Süresi doldu',
};
export const applicationTag = (status: string, label?: string | null): Label => {
  const [tone, icon] = APP_TONE[status] ?? ['neutral', 'info'];
  return { text: label ?? APP_TEXT[status] ?? 'Durum bilinmiyor', tone, icon };
};

/** R12 geçerlilik (türetilir). */
const VALIDITY: Record<string, [Tone, string]> = { NO_EXPIRY: ['neutral', 'minus'], VALID: ['ok', 'check'], EXPIRING: ['warn', 'clock'], EXPIRED: ['danger', 'x'] };
export const validityTag = (code: string | null | undefined, label: string | null | undefined, daysLeft?: number | null): Label | undefined => {
  if (!code) return undefined;
  const [tone, icon] = VALIDITY[code] ?? ['neutral', 'info'];
  const text = code === 'EXPIRING' && daysLeft != null ? `${label ?? 'Süresi yaklaşıyor'} · ${daysLeft} gün kaldı` : label ?? 'Geçerlilik bilinmiyor';
  return { text, tone, icon };
};

/** R5 virüs taraması: yapılandırılmamış tarama "temiz" gösterilmez. */
const AV: Record<string, Label> = {
  NOT_CONFIGURED: { text: 'Virüs taraması yapılandırılmadı', tone: 'neutral', icon: 'minus', hint: 'Dosya virüs taramasından geçmedi; tarama hizmeti bu ortamda kapalı.' },
  CLEAN: { text: 'Virüs taraması temiz', tone: 'ok', icon: 'shield' },
  INFECTED: { text: 'Virüs bulundu', tone: 'danger', icon: 'x' },
  ERROR: { text: 'Virüs taraması tamamlanamadı', tone: 'warn', icon: 'alert' },
};
export const avTag = (status: string | null | undefined, label?: string | null): Label | undefined =>
  status ? { ...(AV[status] ?? { text: label ?? 'Tarama durumu bilinmiyor', tone: 'neutral', icon: 'info' }), ...(label && !AV[status] ? { text: label } : {}) } : undefined;

/** Dosya denetimi (sihirli bayt, tür, boyut). */
export const checkTag = (status: string | null | undefined, reason?: string | null): Label | undefined =>
  status === 'PASSED' ? { text: 'Dosya denetimi geçti', tone: 'ok', icon: 'check' }
    : status === 'QUARANTINED' ? { text: 'Karantinada', tone: 'danger', icon: 'shield', hint: reason ?? undefined }
      : status ? { text: 'Dosya denetimi bekliyor', tone: 'neutral', icon: 'clock' } : undefined;

/** e-posta kutusu satırı (R6/R7): gönderilmeyen ileti "gönderildi" görünmez. */
const EMAIL: Record<string, [Tone, string, string]> = {
  NOT_CONFIGURED: ['warn', 'minus', 'Gönderilmedi — e-posta kanalı yapılandırılmadı'], QUEUED: ['info', 'clock', 'Kuyrukta (henüz gönderilmedi)'],
  SENT: ['ok', 'check', 'Gönderildi'], FAILED: ['danger', 'x', 'Gönderilemedi'], NONE: ['neutral', 'minus', 'Davet e-postası yazılmadı'],
};
export const emailTag = (status: string, label?: string | null): Label => {
  const [tone, icon, text] = EMAIL[status] ?? ['neutral', 'info', 'Durum bilinmiyor'];
  return { text: label ?? text, tone, icon };
};

export const RELATED_LABEL: Record<string, string> = {
  supplier_application: 'Tedarikçi başvurusu', rfq_round_invite: 'Teklif daveti', supplier_document: 'Belge hatırlatması', supplier_portal_user: 'Portal erişimi',
  contract_reminder: 'Sözleşme hatırlatıcısı', contract_family: 'Sözleşme', risk_assessment: 'Risk değerlendirmesi',
};

/** Yüklenen tedarikçi belgesi (Görev 5 `documentView`). */
export interface SupplierDoc {
  id: string; typeCode: string; typeName: string; title: string | null; originalFilename: string; mimeType: string; sizeBytes: number;
  basicCheckStatus: string; basicCheckReason: string | null; quarantined: boolean; avScanStatus: string; avScanLabel: string | null;
  validUntil: string | null; validity: string; validityLabel: string; daysLeft: number | null; uploadedVia: string; uploadedViaLabel?: string; uploadedByName?: string | null;
  createdAt: string; current: boolean; supersededById: string | null; supersededLabel: string | null; replacesId: string | null; contentUrl: string;
}
export const UPLOADED_VIA: Record<string, string> = { APPLICATION: 'Başvuru', PORTAL: 'Tedarikçi portalı', INTERNAL: 'Kurum içi' };

export const fmtSize = (n: number) => n >= 1024 * 1024 ? `${(n / 1024 / 1024).toLocaleString('tr-TR', { maximumFractionDigits: 1 })} MB` : `${Math.max(1, Math.round(n / 1024)).toLocaleString('tr-TR')} KB`;

/** Belgeyi indirir (oturum çereziyle; yanıt `attachment`). */
export async function downloadDoc(url: string, filename: string) {
  const blob = await apiBlob(url);
  const href = URL.createObjectURL(blob);
  const a = document.createElement('a'); a.href = href; a.download = filename; a.click();
  URL.revokeObjectURL(href);
}

/** Belge satırı etiketleri: geçerlilik, dosya denetimi, virüs taraması (yerine yenisi yüklendiyse o da). */
export function DocTags({ d }: { d: SupplierDoc }) {
  return (
    <div className="flex flex-wrap gap-1.5">
      {!d.current ? <Tag label={{ text: d.supersededLabel ?? 'Yerine yenisi yüklendi', tone: 'neutral', icon: 'refresh' }} /> : <Tag label={validityTag(d.validity, d.validityLabel, d.daysLeft)} />}
      <Tag label={checkTag(d.basicCheckStatus, d.basicCheckReason)} />
      <Tag label={avTag(d.avScanStatus, d.avScanLabel)} />
    </div>
  );
}

/** Kabul edilen dosya türleri (R4c). */
export const ACCEPT = '.pdf,.png,.jpg,.jpeg,application/pdf,image/png,image/jpeg';
export const MIME_OK = ['application/pdf', 'image/jpeg', 'image/png'];
export const typesText = (mimes: string[]) => mimes.map((m) => m === 'application/pdf' ? 'PDF' : m === 'image/jpeg' ? 'JPEG' : m === 'image/png' ? 'PNG' : 'Diğer').join(', ');

/** Skor ve risk puanı tr-TR ondalıkla (80,4); sayı değilse olduğu gibi. */
export const fmtNum = (v: number | string | null | undefined) => {
  if (v == null) return '—';
  const n = Number(v);
  return Number.isFinite(n) ? n.toLocaleString('tr-TR', { maximumFractionDigits: 2 }) : String(v);
};
