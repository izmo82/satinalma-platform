/**
 * v2 Faz 5 (R1–R15): tedarikçi portalı kuralları. Saf ve deterministik; AI, veritabanı, ağ yok.
 * Aşama türetilir (veri değişmez), başvuru durum makinesi, belge geçerliliği, tedarikçinin gördüğü skor ve e-posta şablonları.
 */
import { DEFAULT_INCIDENT_POLICY, DEFAULT_WEIGHTS, LEVEL_TR, PERFORMANCE_DIMENSIONS, scorecardScore, type Dimension, type Level } from './supplierRisk.ts';

// ---------- R1 aşama ----------
export const SUPPLIER_STATUSES = ['CANDIDATE', 'CONDITIONAL', 'ACTIVE', 'SUSPENDED', 'ARCHIVED', 'REJECTED', 'MERGED'] as const;
export type SupplierStatus = (typeof SUPPLIER_STATUSES)[number];
export type SupplierStageCode = 'CANDIDATE' | 'APPROVED' | 'PASSIVE' | 'REJECTED' | 'MERGED';
export const SUPPLIER_STAGE_TR: Record<SupplierStageCode, string> = {
  CANDIDATE: 'Aday', APPROVED: 'Onaylı', PASSIVE: 'Pasif', REJECTED: 'Reddedildi', MERGED: 'Birleştirildi',
};
/** Başvuru satırı tedarikçi kaydı değildir; liste bu etiketi ayrı gösterir. */
export const APPLICATION_STAGE_LABEL = 'Başvuru';

export function supplierStage(status: SupplierStatus): { code: SupplierStageCode; label: string } {
  switch (status) {
    case 'CANDIDATE': return { code: 'CANDIDATE', label: SUPPLIER_STAGE_TR.CANDIDATE };
    case 'ACTIVE': return { code: 'APPROVED', label: SUPPLIER_STAGE_TR.APPROVED };
    case 'CONDITIONAL': return { code: 'APPROVED', label: 'Onaylı (koşullu)' };
    case 'SUSPENDED': case 'ARCHIVED': return { code: 'PASSIVE', label: SUPPLIER_STAGE_TR.PASSIVE };
    case 'REJECTED': return { code: 'REJECTED', label: SUPPLIER_STAGE_TR.REJECTED };
    case 'MERGED': return { code: 'MERGED', label: SUPPLIER_STAGE_TR.MERGED };
  }
}
/** Liste süzgeci: aşamanın kapsadığı eski durumlar (eski `status` parametresi ayrıca aynen çalışır). */
export function stageStatuses(code: SupplierStageCode): SupplierStatus[] {
  switch (code) {
    case 'CANDIDATE': return ['CANDIDATE'];
    case 'APPROVED': return ['ACTIVE', 'CONDITIONAL'];
    case 'PASSIVE': return ['SUSPENDED', 'ARCHIVED'];
    case 'REJECTED': return ['REJECTED'];
    case 'MERGED': return ['MERGED'];
  }
}
/** R9: yeni teklif turuna yalnız onaylı (ACTIVE/CONDITIONAL) tedarikçi davet edilir. */
export function canInviteSupplier(status: SupplierStatus): boolean { return status === 'ACTIVE' || status === 'CONDITIONAL'; }

// ---------- R2 başvuru durumları ----------
export const APPLICATION_STATUSES = ['UNVERIFIED', 'SUBMITTED', 'NEEDS_DOCUMENTS', 'APPROVED', 'REJECTED', 'EXPIRED'] as const;
export type ApplicationStatus = (typeof APPLICATION_STATUSES)[number];
export const APPLICATION_STATUS_TR: Record<ApplicationStatus, string> = {
  UNVERIFIED: 'E-posta doğrulanmadı', SUBMITTED: 'İnceleme bekliyor', NEEDS_DOCUMENTS: 'Eksik belge bekleniyor',
  APPROVED: 'Onaylandı', REJECTED: 'Reddedildi', EXPIRED: 'Süresi doldu',
};
export type ApplicationAction = 'VERIFY' | 'APPROVE' | 'REQUEST_DOCUMENTS' | 'COMPLETE' | 'REJECT' | 'EXPIRE';
const APP_TRANSITIONS: Record<ApplicationStatus, Partial<Record<ApplicationAction, ApplicationStatus>>> = {
  UNVERIFIED: { VERIFY: 'SUBMITTED', EXPIRE: 'EXPIRED' },
  SUBMITTED: { REQUEST_DOCUMENTS: 'NEEDS_DOCUMENTS', APPROVE: 'APPROVED', REJECT: 'REJECTED' },
  // Son inceleme I1: tamamlama bağlantısı (24 saat) dolduğunda başvuru takılı kalmasın; Satınalma eksik belge isteğini yeniden gönderir (yeni belirteç).
  NEEDS_DOCUMENTS: { COMPLETE: 'SUBMITTED', REQUEST_DOCUMENTS: 'NEEDS_DOCUMENTS', REJECT: 'REJECTED' },
  APPROVED: {}, REJECTED: {}, EXPIRED: {},
};
export function nextApplicationStatus(from: ApplicationStatus, action: ApplicationAction): ApplicationStatus | { error: 'invalid_transition' } {
  const to = Object.hasOwn(APP_TRANSITIONS, from) ? APP_TRANSITIONS[from][action] : undefined;
  return to ?? { error: 'invalid_transition' };
}
/** Aynı VKN ile ikinci başvuruyu engelleyen açık durumlar (R2). */
export const OPEN_APPLICATION_STATUSES: readonly ApplicationStatus[] = ['UNVERIFIED', 'SUBMITTED', 'NEEDS_DOCUMENTS'];

// ---------- R3/R12 belgeler ----------
export interface DocType {
  code: string; name: string; active: boolean;
  /** ALWAYS: her başvuruda; CATEGORIES: yalnız `categories` ile kesişen hizmet kategorilerinde. */
  requiredMode: 'ALWAYS' | 'CATEGORIES'; categories: string[];
  requiresExpiry: boolean;
}
export function requiredDocumentTypes(types: DocType[], categories: string[]): DocType[] {
  return types.filter((t) => t.active && (t.requiredMode === 'ALWAYS' || t.categories.some((c) => categories.includes(c))));
}
export interface UploadedDoc { typeCode: string; validUntil: string | null; supersededById: string | null }
export type MissingReason = 'MISSING' | 'EXPIRED' | 'NO_EXPIRY_DATE';
/** Eksik zorunlu belgeler. Yerine yenisi yüklenen (superseded) belge sayılmaz; bitiş günü dahil geçerlidir. */
export function missingDocuments(required: DocType[], uploaded: UploadedDoc[], today: string): { code: string; reason: MissingReason }[] {
  const out: { code: string; reason: MissingReason }[] = [];
  for (const t of required) {
    const current = uploaded.filter((u) => u.typeCode === t.code && !u.supersededById);
    if (!current.length) { out.push({ code: t.code, reason: 'MISSING' }); continue; }
    if (!t.requiresExpiry) continue;
    const dated = current.filter((u) => u.validUntil).map((u) => u.validUntil as string);
    if (!dated.length) { out.push({ code: t.code, reason: 'NO_EXPIRY_DATE' }); continue; }
    if (!dated.some((d) => d >= today)) out.push({ code: t.code, reason: 'EXPIRED' });
  }
  return out;
}

const DAY = 86_400_000;
const dayNum = (iso: string) => Date.parse(`${iso.slice(0, 10)}T00:00:00Z`) / DAY;
const isoOf = (n: number) => new Date(n * DAY).toISOString().slice(0, 10);
export const DOCUMENT_VALIDITY_TR = { NO_EXPIRY: 'Süresiz', VALID: 'Geçerli', EXPIRING: 'Süresi yaklaşıyor', EXPIRED: 'Süresi doldu' } as const;
export function documentValidity(validUntil: string | null, today: string, warnDays = 30): { code: keyof typeof DOCUMENT_VALIDITY_TR; label: string; daysLeft: number | null } {
  if (!validUntil) return { code: 'NO_EXPIRY', label: DOCUMENT_VALIDITY_TR.NO_EXPIRY, daysLeft: null };
  const daysLeft = dayNum(validUntil) - dayNum(today);
  const code = daysLeft < 0 ? 'EXPIRED' : daysLeft <= warnDays ? 'EXPIRING' : 'VALID';
  return { code, label: DOCUMENT_VALIDITY_TR[code], daysLeft };
}
/** R12: bitişten `offset` gün önceki hatırlatma tarihleri (0 = bitiş günü). */
export function documentReminderDates(validUntil: string, offsets: number[] = [30, 7, 0]): { offset: number; date: string }[] {
  return offsets.map((offset) => ({ offset, date: isoOf(dayNum(validUntil) - offset) }));
}

// ---------- R15 tedarikçinin gördüğü skor ve risk ----------
export interface PortalStandingInput {
  surveys: { ratio: string }[]; review: { score: string } | null; verifiedIncidents: { severity: Level }[];
  residualLevel: Level | null; actions: { title: string; dueDate: string; status: string }[]; pendingSurveys: number; missingDocs: number;
  /**
   * Karne puanına giren risk seviyesi (052a `app_portal_standing().scoreRiskLevel`; supplierEval yearSummary ile aynı kural). Verilirse puan
   * bununla hesaplanır (null = risk cezası yok); verilmezse eski davranış (residualLevel). Yanıtta hiçbir zaman dönmez.
   */
  scoreRiskLevel?: Level | null;
}
export interface PortalStanding {
  score: number | null; scoreReason: string | null; level: Level | null; levelLabel: string | null;
  expectedActions: { kind: 'CORRECTIVE' | 'DOCUMENT' | 'SURVEY'; title: string; dueDate: string | null }[];
}
const CLOSED_ACTION = new Set(['COMPLETED', 'CLOSED', 'DONE', 'VERIFIED', 'CANCELLED']);
const num = (s: string): number | null => { const n = Number(s); return s.trim() !== '' && Number.isFinite(n) ? n : null; };
/**
 * Tedarikçiye gösterilen özet. Yalnız bu anahtarlar döner: içsel risk faktörleri, kalan risk gerekçesi, inceleme/bulgu notları,
 * olay açıklamaları ve iç kullanıcı adları girdide de çıktıda da yoktur. Puan D103 `scorecardScore` ile hesaplanır.
 */
export function portalStanding(input: PortalStandingInput): PortalStanding {
  const reviewScore = input.review ? num(input.review.score) : null;
  const scores = reviewScore === null ? null : Object.fromEntries(PERFORMANCE_DIMENSIONS.map((d) => [d, reviewScore])) as Record<Dimension, number>;
  const s = scorecardScore({
    surveyRates: input.surveys.map((x) => num(x.ratio)), review: scores ? { scores, weights: DEFAULT_WEIGHTS } : null,
    riskLevel: input.scoreRiskLevel !== undefined ? input.scoreRiskLevel : input.residualLevel, incidentPenalty: input.verifiedIncidents.reduce((t, i) => t + DEFAULT_INCIDENT_POLICY.penalty[i.severity], 0),
  });
  const expectedActions: PortalStanding['expectedActions'] = [
    ...input.actions.filter((a) => !CLOSED_ACTION.has(a.status)).map((a) => ({ kind: 'CORRECTIVE' as const, title: a.title, dueDate: a.dueDate })),
    ...(input.missingDocs > 0 ? [{ kind: 'DOCUMENT' as const, title: `Tamamlanması gereken zorunlu belge: ${input.missingDocs}`, dueDate: null }] : []),
    ...(input.pendingSurveys > 0 ? [{ kind: 'SURVEY' as const, title: `Yanıt bekleyen anket: ${input.pendingSurveys}`, dueDate: null }] : []),
  ];
  return { score: s.score, scoreReason: s.reason, level: input.residualLevel, levelLabel: input.residualLevel ? LEVEL_TR[input.residualLevel] : null, expectedActions };
}

// ---------- R13 ayrılış kontrol listesi ----------
export const OFFBOARDING_ITEMS = [
  { code: 'ACCESS_CLOSED', label: 'Erişimlerin kapatılması (VPN, hesaplar)' },
  { code: 'DATA_RETURNED', label: 'Kurum verisinin iadesi/imhası teyidi' },
  { code: 'ASSETS_RETURNED', label: 'Kurum varlıklarının iadesi' },
  { code: 'CONTRACTS_CHECKED', label: 'Açık sözleşmelerin fesih/bitiş kontrolü' },
  { code: 'OPEN_ROUNDS_CHECKED', label: 'Açık teklif turlarından çıkarma kontrolü' },
  { code: 'ERP_DEACTIVATED', label: 'ERP\'de tedarikçi kaydının pasifleştirilmesi (bilgi)' },
] as const;
export function offboardingComplete(items: { code: string; doneAt: string | null; notApplicable: boolean }[]): boolean {
  return OFFBOARDING_ITEMS.every((o) => { const i = items.find((x) => x.code === o.code); return !!i && (!!i.doneAt || i.notApplicable); });
}

// ---------- e-posta şablonları ----------
export interface Email { subject: string; body: string }
const TZ = 'Europe/Istanbul';
/** tr-TR, Europe/Istanbul: "21.12.2026 17:00". Salt tarih (YYYY-MM-DD) saat dilimi kaymadan "21.12.2026" olur. */
export function formatDateTimeTr(iso: string): string {
  if (/^\d{4}-\d{2}-\d{2}$/.test(iso)) return formatDateTr(iso);
  const p = Object.fromEntries(new Intl.DateTimeFormat('tr-TR', { timeZone: TZ, day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(iso)).map((x) => [x.type, x.value]));
  return `${p.day}.${p.month}.${p.year} ${p.hour}:${p.minute}`;
}
export function formatDateTr(iso: string): string {
  if (/^\d{4}-\d{2}-\d{2}/.test(iso) && iso.length === 10) return `${iso.slice(8, 10)}.${iso.slice(5, 7)}.${iso.slice(0, 4)}`;
  return formatDateTimeTr(iso).slice(0, 10);
}
export const SCOPE_SUMMARY_MAX = 600;
export const truncateScope = (s: string) => (s.length > SCOPE_SUMMARY_MAX ? `${s.slice(0, SCOPE_SUMMARY_MAX)}…` : s);

export function inviteEmail(i: { supplierName: string; projectTitle: string; scopeSummary: string; closesAt: string; link: string }): Email {
  return {
    subject: `Teklif daveti: ${i.projectTitle}`,
    body: [`Sayın ${i.supplierName},`, '', `"${i.projectTitle}" için teklif vermeye davet edildiniz.`, '', 'Kapsam:', truncateScope(i.scopeSummary), '',
      `Son teklif tarihi: ${formatDateTimeTr(i.closesAt)} (İstanbul saati)`, '', `Tedarikçi portalında açmak için: ${i.link}`, 'Oturumunuz yoksa önce giriş yapmanız istenir; girişten sonra bu teklif turuna dönersiniz.'].join('\n'),
  };
}
export function verificationEmail(i: { legalName: string; link: string }): Email {
  return {
    subject: 'Tedarikçi başvurunuz: e-posta doğrulaması',
    body: [`Sayın ${i.legalName} yetkilisi,`, '', 'Tedarikçi başvurunuzu aldık. Başvurunuzun incelemeye girmesi için e-posta adresinizi doğrulayın:', i.link, '',
      'Bağlantı 24 saat geçerlidir ve bir kez kullanılabilir. Bu başvuruyu siz yapmadıysanız bu iletiyi dikkate almayın.'].join('\n'),
  };
}
export function documentsRequestedEmail(i: { legalName: string; documents: string[]; note: string | null; link: string }): Email {
  return {
    subject: 'Tedarikçi başvurunuz: eksik belgeler',
    body: [`Sayın ${i.legalName} yetkilisi,`, '', 'Başvurunuzun değerlendirilebilmesi için şu belgeler gerekiyor:', ...i.documents.map((d) => `- ${d}`),
      ...(i.note ? ['', `Not: ${i.note}`] : []), '', `Belgeleri yüklemek için: ${i.link}`, 'Bağlantı 24 saat geçerlidir ve bir kez kullanılabilir.'].join('\n'),
  };
}
export function applicationDecisionEmail(i: { legalName: string; decision: 'APPROVED' | 'REJECTED'; reason?: string | null }): Email {
  if (i.decision === 'APPROVED') {
    return { subject: 'Tedarikçi başvurunuz kabul edildi', body: [`Sayın ${i.legalName} yetkilisi,`, '', 'Tedarikçi başvurunuz kabul edildi ve kaydınız aday tedarikçi olarak açıldı. Teklif davetleri için onay sürecinin tamamlanması gerekir; gelişmeleri e-postayla ileteceğiz.'].join('\n') };
  }
  return { subject: 'Tedarikçi başvurunuz sonuçlandı', body: [`Sayın ${i.legalName} yetkilisi,`, '', 'Tedarikçi başvurunuz bu aşamada kabul edilmedi.', ...(i.reason ? ['', `Gerekçe: ${i.reason}`] : [])].join('\n') };
}
export function portalAccessEmail(i: { name: string; link: string }): Email {
  return {
    subject: 'Tedarikçi portalı erişiminiz hazır',
    body: [`Sayın ${i.name},`, '', 'Firmanız adına tedarikçi portalı erişiminiz tanımlandı:', i.link, '',
      'Giriş kurumun Microsoft Entra kimliğiyle yapılır. Kurum dışı bir e-posta adresiyle girecekseniz kurumun size ayrıca misafir (B2B) daveti göndermesi gerekir; bu davet bu sistemin dışında yürür.'].join('\n'),
  };
}
export function documentExpiryEmail(i: { supplierName: string; documentName: string; validUntil: string; offset: number; link: string }): Email {
  const when = i.offset === 0 ? `bugün (${formatDateTr(i.validUntil)}) sona eriyor` : `${i.offset} gün sonra (${formatDateTr(i.validUntil)}) sona erecek`;
  return {
    subject: i.offset === 0 ? `Belge süresi doluyor: ${i.documentName}` : `Belge süresi yaklaşıyor: ${i.documentName}`,
    body: [`Sayın ${i.supplierName} yetkilisi,`, '', `"${i.documentName}" belgesinin geçerliliği ${when}.`, `Güncel belgeyi yüklemek için: ${i.link}`].join('\n'),
  };
}
