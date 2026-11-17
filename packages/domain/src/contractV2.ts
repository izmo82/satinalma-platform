// v2 Faz 3: sözleşme alan kuralları, türetilmiş durum, onay zinciri planı ve hatırlatıcı tarihleri.
// Saf işlevler; veritabanı ve saat bağımlılığı yok (bugün girdi olarak gelir). Para decimal string'dir.

export const CONTRACT_TYPES = ['SERVICE', 'HARDWARE', 'MAINTENANCE', 'NDA', 'CONSULTING', 'OTHER'] as const;
export type ContractType = (typeof CONTRACT_TYPES)[number];
export const CONTRACT_TYPE_TR: Record<ContractType, string> = {
  SERVICE: 'Hizmet',
  HARDWARE: 'Donanım',
  MAINTENANCE: 'Bakım-destek',
  NDA: 'Gizlilik',
  CONSULTING: 'Danışmanlık',
  OTHER: 'Diğer',
};

// ---- R2: zorunlu alanlar ----
export type LimitBasis = 'NET' | 'GROSS';

export interface ContractFields {
  project: string | null;
  supplier: string | null;
  contractType: ContractType | null;
  owner: string | null;
  signedOn: string | null;
  amount: string | null;
  currency: string | null;
  limitBasis: LimitBasis | null;
  startDate: string | null;
  endDate: string | null;
  indefinite: boolean;
  autoRenewal: boolean | null;
  noticePeriod: string | null;
}

export type RequiredField =
  | 'project' | 'supplier' | 'contractType' | 'owner' | 'signedOn' | 'amount' | 'currency' | 'limitBasis'
  | 'startDate' | 'endDate' | 'autoRenewal' | 'noticePeriod';

export const REQUIRED_FIELD_TR: Record<RequiredField, string> = {
  project: 'Proje',
  supplier: 'Tedarikçi',
  contractType: 'Sözleşme türü',
  owner: 'Sözleşme sorumlusu',
  signedOn: 'İmza tarihi',
  amount: 'Tutar',
  currency: 'Para birimi',
  limitBasis: 'Limit esası (KDV dahil/hariç)',
  startDate: 'Başlangıç tarihi',
  endDate: 'Bitiş tarihi',
  autoRenewal: 'Otomatik yenileme',
  noticePeriod: 'İhbar süresi',
};

const blank = (v: string | null | undefined): boolean => v == null || v.trim() === '';

export function missingRequired(c: ContractFields): RequiredField[] {
  const out: RequiredField[] = [];
  if (blank(c.project)) out.push('project');
  if (blank(c.supplier)) out.push('supplier');
  if (blank(c.contractType)) out.push('contractType');
  if (blank(c.owner)) out.push('owner');
  if (blank(c.signedOn)) out.push('signedOn');
  if (blank(c.amount)) out.push('amount');
  if (blank(c.currency)) out.push('currency');
  if (blank(c.limitBasis)) out.push('limitBasis');
  if (blank(c.startDate)) out.push('startDate');
  if (!c.indefinite && blank(c.endDate)) out.push('endDate');
  if (c.autoRenewal === null || c.autoRenewal === undefined) out.push('autoRenewal');
  if ((c.indefinite || c.autoRenewal === true) && blank(c.noticePeriod)) out.push('noticePeriod');
  return out;
}

// ---- R4: onay zinciri ----
export type StepKind = 'DEPARTMENT_HEAD' | 'PROCUREMENT_LEAD' | 'PROCUREMENT_DIRECTOR' | 'EXTRA';

export const STEP_KIND_TR: Record<StepKind, string> = {
  DEPARTMENT_HEAD: 'Departman sorumlusu',
  PROCUREMENT_LEAD: 'Satınalma sorumlusu',
  PROCUREMENT_DIRECTOR: 'Satınalma direktörü',
  EXTRA: 'Ek onaycı',
};

export interface Person { id: string }

export interface PlannedStep { order: number; kind: StepKind; userId: string; viaDeputy: boolean }

export type PlanChainError = {
  error: 'department_head_missing' | 'lead_missing' | 'director_missing' | 'no_eligible_approver';
  kind: StepKind;
};

export function planChain(input: {
  creatorId: string;
  approvers: {
    head: Person | null; deputy: Person | null;
    lead: Person | null; leadDeputy: Person | null;
    director: Person | null; directorDeputy: Person | null;
  };
  useDeputyForHead: boolean;
  extras: string[];
}): { steps: PlannedStep[] } | PlanChainError {
  const { creatorId, approvers: a } = input;
  const steps: PlannedStep[] = [];

  const slots: { kind: StepKind; main: Person | null; deputy: Person | null; missing: PlanChainError['error']; forceDeputy: boolean }[] = [
    { kind: 'DEPARTMENT_HEAD', main: a.head, deputy: a.deputy, missing: 'department_head_missing', forceDeputy: input.useDeputyForHead },
    { kind: 'PROCUREMENT_LEAD', main: a.lead, deputy: a.leadDeputy, missing: 'lead_missing', forceDeputy: false },
    { kind: 'PROCUREMENT_DIRECTOR', main: a.director, deputy: a.directorDeputy, missing: 'director_missing', forceDeputy: false },
  ];
  for (const s of slots) {
    if (!s.main) return { error: s.missing, kind: s.kind };
    let person: Person = s.main;
    let viaDeputy = false;
    if (s.forceDeputy || person.id === creatorId) {
      if (!s.deputy || s.deputy.id === creatorId) return { error: 'no_eligible_approver', kind: s.kind };
      person = s.deputy;
      viaDeputy = true;
    }
    steps.push({ order: steps.length + 1, kind: s.kind, userId: person.id, viaDeputy });
  }
  for (const id of input.extras) {
    if (id === creatorId) return { error: 'no_eligible_approver', kind: 'EXTRA' };
    steps.push({ order: steps.length + 1, kind: 'EXTRA', userId: id, viaDeputy: false });
  }
  return { steps };
}

// Karar verebilir mi: atanan kişi ya da (varsa) aktif vekil; karar verilmiş adım bir daha karar almaz.
export function canDecide(
  step: { userId: string; decidedAt?: string | null },
  actorId: string,
  activeDeputyId: string | null,
): boolean {
  if (step.decidedAt) return false;
  if (actorId === step.userId) return true;
  return activeDeputyId != null && actorId === activeDeputyId;
}

// ---- R1: türetilmiş durum (saklanmaz) ----
export type ContractStatus = 'INCOMPLETE' | 'DRAFT' | 'IN_APPROVAL' | 'REJECTED' | 'APPROVED' | 'EXPIRED' | 'LEGACY';

// chains eskiden yeniye sıralıdır; sonuncusu geçerlidir.
export interface ChainSummary {
  status: 'OPEN' | 'APPROVED' | 'REJECTED' | 'CANCELLED';
  nextStepKind?: StepKind | null;
}

export function contractStatus(input: {
  missing: RequiredField[];
  chains: ChainSummary[];
  legacy: boolean;
  endDate: string | null;
  indefinite: boolean;
  today: string;
}): { code: ContractStatus; label: string } {
  const expired = !input.indefinite && input.endDate != null && input.endDate < input.today;
  if (input.missing.length > 0) return { code: 'INCOMPLETE', label: 'Eksik alan' };
  const latest = input.chains.length > 0 ? input.chains[input.chains.length - 1]! : null;
  if (!latest || latest.status === 'CANCELLED') {
    if (input.legacy && input.chains.length === 0) {
      return expired ? { code: 'EXPIRED', label: 'Süresi doldu' } : { code: 'LEGACY', label: 'Onay kaydı yok (eski kayıt)' };
    }
    return { code: 'DRAFT', label: 'Taslak' };
  }
  if (latest.status === 'OPEN') {
    const title = latest.nextStepKind ? STEP_KIND_TR[latest.nextStepKind] : null;
    return { code: 'IN_APPROVAL', label: title ? `${title} onayında` : 'Onayda' };
  }
  if (latest.status === 'REJECTED') return { code: 'REJECTED', label: 'Reddedildi' };
  return expired ? { code: 'EXPIRED', label: 'Süresi doldu' } : { code: 'APPROVED', label: 'Yürürlükte' };
}

// ---- R7: hatırlatıcı tarihleri ----
export interface Reminder { offset: number; date: string; kind: 'END' | 'NOTICE'; includeProcurement: boolean }

function minusDays(iso: string, days: number): string {
  const [y, m, d] = iso.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d - days)).toISOString().slice(0, 10);
}

export function reminderDates(input: {
  endDate: string | null;
  indefinite: boolean;
  autoRenewal: boolean;
  noticeDeadline: string | null;
  offsets?: number[];
  today?: string;
}): Reminder[] {
  const offsets = input.offsets ?? [90, 60, 30, 7];
  const out: Reminder[] = [];
  if (!input.indefinite && input.endDate) {
    for (const offset of offsets) {
      out.push({ offset, date: minusDays(input.endDate, offset), kind: 'END', includeProcurement: offset === 30 || offset === 7 });
    }
  }
  if (input.noticeDeadline && (input.indefinite || input.autoRenewal)) {
    out.push({ offset: 30, date: minusDays(input.noticeDeadline, 30), kind: 'NOTICE', includeProcurement: true });
  }
  out.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  const today = input.today;
  if (!today) return out;
  const future = out.filter((r) => r.date >= today);
  const past = out.filter((r) => r.date < today);
  if (past.length === 0) return out;
  // Geçmişte kalanlardan yalnız en yakın olan hemen (bugün) tetiklenir; diğerleri düşer.
  const last = past[past.length - 1]!;
  const moved: Reminder = { ...last, date: today };
  // Bugüne taşınan girdi, zaten bugün olan aynı türdeki girdiyle çakışırsa tek kalır.
  const collides = future.some((r) => r.date === today && r.kind === moved.kind);
  return collides ? future : [moved, ...future];
}
