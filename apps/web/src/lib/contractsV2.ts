// v2 Faz 3 (D108): sözleşme ekleme, onay zinciri, hatırlatıcılar ve şablonlar için API biçimleri ve Türkçe etiketler.
// Biçimler API uçlarıyla birebir (Görev 3–6 raporları). Durum sunucuda türetilir; istemci yeniden hesaplamaz.
import { api, apiBlob } from './api.ts';
import type { Label } from './labels.ts';

export type ContractStatusCode = 'INCOMPLETE' | 'DRAFT' | 'IN_APPROVAL' | 'REJECTED' | 'APPROVED' | 'EXPIRED' | 'LEGACY';
export type ContractType = 'SERVICE' | 'HARDWARE' | 'MAINTENANCE' | 'NDA' | 'CONSULTING' | 'OTHER';
export interface Person { id: string; displayName: string }

export interface ChainStep {
  id: string; order: number; kind: string; kindLabel: string; assignedUser: Person; viaDeputy: boolean; deputyUser: Person | null;
  decision: 'APPROVED' | 'REJECTED' | null; decidedAt: string | null; decidedBy: Person | null; reason: string | null; current: boolean;
}
export interface Chain {
  id: string; status: 'OPEN' | 'APPROVED' | 'REJECTED' | 'CANCELLED'; submittedBy: Person; submittedAt: string; note: string | null;
  closedAt: string | null; cancelReason: string | null; versionId: string; termsId: string | null; steps: ChainStep[];
}
export interface ContractFields {
  projectId: string | null; supplierId: string | null; contractType: ContractType | null; contractTypeLabel: string | null; ownerUserId: string | null;
  signedOn: string | null; indefinite: boolean; templateVersionId: string | null; contractNo: string | null; governingCourt: string | null;
  kvkkClause: boolean | null; priceEscalation: string | null; termsId: string | null; termsRevision: number | null; termsVerified: boolean;
  currency: string | null; valueType: 'FIXED' | 'CEILING' | 'UNPRICED' | null; amount: string | null; limitBasis: 'NET' | 'GROSS' | null;
  startDate: string | null; endDate: string | null; autoRenewal: boolean | null; renewalMonths: number | null; noticeAmount: number | null;
  noticeUnit: 'DAY' | 'MONTH' | null; noticePeriod: string | null; paymentDays: number | null; paymentTerms: string | null; sourceRef: string | null;
  fxDifference: 'ALLOWED' | 'NOT_ALLOWED' | null;
}
export interface PlannedReminder { offset: number; date: string; kind: 'END' | 'NOTICE'; includeProcurement: boolean }
export interface ContractV2 {
  family: { id: string; code: string; title: string; companyId: string; departmentId: string | null; departmentName: string | null; createdBy: Person; createdAt: string; intakeFlow: boolean };
  fields: ContractFields;
  missing: { field: string; label: string }[];
  status: { code: ContractStatusCode; label: string };
  legacy: boolean;
  chain: Chain | null;
  chainCount: number;
  reminders: { offsets: number[]; planned: PlannedReminder[]; scheduled: { id: string; kind: string; offset: number; dueOn: string }[] };
  template: null | { versionId: string; templateId: string; code: string; name: string; contractType: ContractType; versionNo: number; superseded: boolean };
  project: null | { id: string; code: string | null; title: string | null; departmentId: string | null; visible: boolean };
  supplier: null | { id: string; legalName: string; status: string; vkn: string | null; contactEmail: string | null };
  owner: Person | null;
  document: null | { contractVersionId: string; versionNo: number; stage: string; documentVersionId: string; filename: string | null; mimeType: string; sha256: string; pageCount: number | null; etag: string };
  can: { edit: boolean; submit: boolean; decide: boolean };
}

export interface ReminderTask { id: string; status: 'OPEN' | 'DONE'; closedAt: string | null; recipient: { type: 'USER'; userId: string; displayName: string } | { type: 'ROLE'; role: string; label: string } }
export interface ReminderEmail { id: string; toUser: Person | null; status: 'NOT_CONFIGURED' | 'QUEUED' | 'SENT' | 'FAILED'; statusLabel: string; createdAt: string; sentAt: string | null }
export interface RemindersRes {
  familyId: string; termsId: string | null; contractVersionId: string | null; effective: boolean; scheduled: boolean; offsets: number[];
  basis: { endDate: string | null; indefinite: boolean; autoRenewal: boolean; noticeDeadline: string | null; noticeBasis: 'END_DATE' | 'ANNIVERSARY' | null; anniversary: string | null };
  planned: PlannedReminder[];
  reminders: { id: string; termsId: string; current: boolean; kind: 'END' | 'NOTICE'; kindLabel: string; offset: number; dueOn: string; includeProcurement: boolean;
    state: 'PLANNED' | 'OPEN' | 'CLOSED' | 'SKIPPED' | 'FAILED'; jobStatus: string | null; skippedReason: string | null; tasks: ReminderTask[]; emails: ReminderEmail[] }[];
  decision: null | { decision: string; label: string; rationale: string; decidedAt: string; decidedBy: string | Person | null };
  emailChannel: { configured: boolean; label: string };
  can: { decide: boolean; settings: boolean };
}

export interface ApprovalPreview {
  ok: boolean; departmentId?: string; error?: string; kind?: string; kindLabel?: string; message?: string;
  steps?: { order: number; kind: string; kindLabel: string; userId: string; displayName: string; email: string | null; viaDeputy: boolean }[];
}

export interface TemplateVersion { id: string; versionNo: number; validFrom: string; supersededAt: string | null; uploadedAt: string; uploadedBy: string; filename: string; sizeBytes: number; usageCount: number }
export interface Template { id: string; code: string; name: string; contractType: ContractType; createdAt: string; currentVersion: TemplateVersion | null; versions: TemplateVersion[]; usageCount: number }

export const CONTRACT_TYPES: Record<ContractType, string> = {
  SERVICE: 'Hizmet', HARDWARE: 'Donanım', MAINTENANCE: 'Bakım-destek', NDA: 'Gizlilik', CONSULTING: 'Danışmanlık', OTHER: 'Diğer',
};

/** Türetilmiş durumun etiketi sunucudan gelir; ton ve ikon kökene göre (onay insan kararı: mor ıstampa). */
export function statusTag(code: string | null | undefined, label: string | null | undefined): Label | undefined {
  if (!code || !label) return undefined;
  const tone: Record<string, Pick<Label, 'tone' | 'icon'>> = {
    INCOMPLETE: { tone: 'danger', icon: 'x' }, DRAFT: { tone: 'neutral', icon: 'pen' }, IN_APPROVAL: { tone: 'info', icon: 'info' },
    REJECTED: { tone: 'danger', icon: 'x' }, APPROVED: { tone: 'human', icon: 'stamp' }, EXPIRED: { tone: 'neutral', icon: 'clock' },
    LEGACY: { tone: 'neutral', icon: 'archive' },
  };
  return { text: label, ...(tone[code] ?? { tone: 'neutral', icon: 'info' }) };
}

export const RENEWAL_DECISIONS = {
  RENEW: 'Yenilenecek', TERMINATE: 'Sonlandırılacak', RENEGOTIATE: 'Yeniden müzakere edilecek', NEW_PROJECT: 'Yeni proje açıldı',
} as const;

/** Sistem işlerinin (hatırlatıcı işçisi, eşitleme) aktörü kullanıcı değildir; geçmişte "Sistem" yazılır. */
export const SYSTEM_USER = '00000000-0000-0000-0000-000000000000';
export const actorName = (p: Person | string | null | undefined) =>
  !p ? 'Sistem' : typeof p === 'string' ? p : p.id === SYSTEM_USER || !p.displayName ? 'Sistem' : p.displayName;

/** Gelen baytları dosya olarak kaydettirir (yetkili uçtan; bağlantı paylaşılmaz). */
export async function downloadBlob(path: string, filename: string) {
  const blob = await apiBlob(path);
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename; document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** Sözleşme sürümü kimliğinden aile kimliği (eski adresler sürüm kimliği taşır). */
export async function familyOfVersion(cvId: string): Promise<string> {
  const r = await api<{ contractVersion: { familyId: string } }>(`/api/v1/contract-versions/${cvId}/signature-status`);
  return r.data.contractVersion.familyId;
}

export const fmtOffsets = (o: number[]) => o.map((x) => `${x} gün`).join(', ');
