// İmza kontrolü durum türetme (06_IMZA_KONTROLU.md). Saf fonksiyon: aynı kanıt → aynı sonuç.
// Bu sonuç hiçbir zaman "hukuken geçerli" veya "ıslak imza doğrulandı" anlamı taşımaz;
// yalnız tanımlı gereksinimler için kaydedilmiş kanıtların durumunu özetler.

export type SignatureMethod =
  | 'WET_IMAGE_REVIEW' | 'QUALIFIED_ELECTRONIC' | 'ELECTRONIC_OTHER' | 'HYBRID' | 'NOT_REQUIRED' | 'PENDING_CLASSIFICATION';
export type RequirementMethod = 'WET_IMAGE_REVIEW' | 'QUALIFIED_ELECTRONIC' | 'ELECTRONIC_OTHER';
export type DetectionStatus = 'NOT_PROCESSED' | 'CANDIDATE_FOUND' | 'NOT_DETECTED' | 'UNCLEAR' | 'ERROR' | 'UNSUPPORTED';
export type ReviewDecision = 'IMAGE_CONFIRMED' | 'MISSING' | 'UNCLEAR';
export type ObservedMark = 'FULL_SIGNATURE' | 'STAMP_ONLY' | 'INITIALS_ONLY' | 'NAME_ONLY' | 'NONE' | 'ILLEGIBLE';
export type DigitalStatus = 'NOT_APPLICABLE' | 'NOT_CHECKED' | 'VALIDATED' | 'INVALID' | 'INDETERMINATE';
export type CustodyStatus = 'UNKNOWN' | 'RECEIPT_DECLARED' | 'CUSTODY_CONFIRMED';
export type OverallSignatureStatus = 'NOT_REQUIRED' | 'NOT_REVIEWED' | 'COMPLETE' | 'INCOMPLETE' | 'UNCLEAR' | 'EXCEPTION_ACTIVE';
export type RequirementState = 'SATISFIED' | 'PENDING' | 'MISSING' | 'UNCLEAR' | 'INVALID';

export interface RequirementInput {
  id: string;
  partyId: string;
  partyName: string;
  signerRole: string;
  requirementCount: number;
  acceptableMethods: RequirementMethod[];
  required: boolean;
}
export interface ReviewInput {
  requirementId: string;
  slot: number;
  decision: ReviewDecision;
  observedMark: ObservedMark;
  documentSha256: string;
  reviewedAt: Date;
}
export interface ValidationInput {
  requirementId: string | null;
  signedFileSha256: string;
  status: Exclude<DigitalStatus, 'NOT_APPLICABLE'>;
  validatedAt: Date;
}
export interface ExceptionInput {
  id: string;
  requirementIds: string[];
  status: 'REQUESTED' | 'APPROVED' | 'REJECTED';
  expiresAt: Date;
}
export interface SignatureEvidence {
  method: SignatureMethod;
  documentSha256: string;
  requirements: RequirementInput[];
  reviews: ReviewInput[];
  validations: ValidationInput[];
  exceptions: ExceptionInput[];
  custodyRequired: boolean;
  custodyStatuses: Exclude<CustodyStatus, 'UNKNOWN'>[];
  latestDetection: DetectionStatus;
  now: Date;
}

export type BlockerCode =
  | 'METHOD_NOT_CLASSIFIED' | 'NO_REQUIREMENTS_DEFINED' | 'REVIEW_PENDING' | 'SIGNATURE_MISSING'
  | 'SIGNATURE_UNCLEAR' | 'ESIGN_NOT_VALIDATED' | 'ESIGN_INVALID' | 'ORIGINAL_CUSTODY_NOT_CONFIRMED';

export interface Blocker {
  code: BlockerCode;
  requirementId?: string;
  partyName?: string;
  slot?: number;
  action: string;
}

export interface RequirementResult {
  id: string;
  partyName: string;
  signerRole: string;
  required: boolean;
  state: RequirementState;
  satisfiedBy: RequirementMethod | null;
  slots: { slot: number; decision: ReviewDecision | 'PENDING'; observedMark: ObservedMark | null }[];
  digital: DigitalStatus;
}

export interface SignatureStatus {
  overall: OverallSignatureStatus;
  /** İstisna aktifken bile görünür kalan asıl durum. */
  underlying: Exclude<OverallSignatureStatus, 'EXCEPTION_ACTIVE'>;
  requirements: RequirementResult[];
  blockers: Blocker[];
  custody: CustodyStatus;
  automaticCheck: DetectionStatus;
  automaticAlert: 'IMAGE_NOT_FOUND_REVIEW_REQUIRED' | 'AUTOMATIC_CHECK_UNAVAILABLE' | null;
  activeExceptionId: string | null;
  expiredExceptionIds: string[];
  canFinalize: boolean;
}

const WET: RequirementMethod = 'WET_IMAGE_REVIEW';
const isElectronic = (m: RequirementMethod) => m !== WET;

export function deriveSignatureStatus(e: SignatureEvidence): SignatureStatus {
  const blockers: Blocker[] = [];
  const required = e.requirements.filter((r) => r.required);

  // Yeni sürüm eski incelemeyi taşımaz (SIG09): yalnız bu belge hash'ine ait kanıt sayılır.
  const reviews = e.reviews.filter((r) => r.documentSha256 === e.documentSha256);
  const validations = e.validations.filter((v) => v.signedFileSha256 === e.documentSha256);

  const requirementResults = e.requirements.map((req) => evaluateRequirement(req, reviews, validations));

  for (const r of requirementResults) {
    if (!r.required) continue;
    if (r.state === 'MISSING') {
      blockers.push({ code: 'SIGNATURE_MISSING', requirementId: r.id, partyName: r.partyName,
        action: 'Eksik imzalı belgeyi yeniden isteyin veya yetkili istisna talep edin.' });
    } else if (r.state === 'UNCLEAR') {
      blockers.push({ code: 'SIGNATURE_UNCLEAR', requirementId: r.id, partyName: r.partyName,
        action: 'Kaynak sayfayı inceleyin; okunamıyorsa daha iyi kalitede belge isteyin.' });
    } else if (r.state === 'INVALID') {
      blockers.push({ code: 'ESIGN_INVALID', requirementId: r.id, partyName: r.partyName,
        action: 'E-imza doğrulaması geçersiz; yeniden imzalı belge isteyin.' });
    } else if (r.state === 'PENDING') {
      const eOnly = r.slots.length === 0;
      blockers.push({ code: eOnly ? 'ESIGN_NOT_VALIDATED' : 'REVIEW_PENDING', requirementId: r.id, partyName: r.partyName,
        action: eOnly ? 'E-imzayı doğrulama servisiyle kontrol edin.' : 'Bu taraf için imza incelemesi yapın.' });
    }
  }

  const custody: CustodyStatus = e.custodyStatuses.includes('CUSTODY_CONFIRMED')
    ? 'CUSTODY_CONFIRMED'
    : e.custodyStatuses.includes('RECEIPT_DECLARED') ? 'RECEIPT_DECLARED' : 'UNKNOWN';

  let underlying: SignatureStatus['underlying'];
  if (e.method === 'NOT_REQUIRED' && required.length === 0) {
    underlying = 'NOT_REQUIRED';
  } else {
    if (e.method === 'PENDING_CLASSIFICATION') {
      blockers.unshift({ code: 'METHOD_NOT_CLASSIFIED', action: 'Hukuk imza yöntemini sınıflandırmalı.' });
    }
    if (required.length === 0) {
      blockers.unshift({ code: 'NO_REQUIREMENTS_DEFINED', action: 'Taraf ve imzacı gereksinimlerini tanımlayın.' });
    }
    const states = requirementResults.filter((r) => r.required).map((r) => r.state);
    if (states.includes('MISSING') || states.includes('INVALID')) underlying = 'INCOMPLETE';
    else if (states.includes('UNCLEAR')) underlying = 'UNCLEAR';
    else if (states.includes('PENDING') || required.length === 0 || e.method === 'PENDING_CLASSIFICATION') underlying = 'NOT_REVIEWED';
    else underlying = 'COMPLETE';

    // Fiziksel asıl yalnız politika zorunlu kılıyorsa engeldir (T40).
    if (e.custodyRequired && custody !== 'CUSTODY_CONFIRMED') {
      blockers.push({ code: 'ORIGINAL_CUSTODY_NOT_CONFIRMED', action: 'Islak imzalı aslın muhafaza kaydını teyit edin.' });
      if (underlying === 'COMPLETE') underlying = 'INCOMPLETE';
    }
  }

  // İstisna eksikliği silmez; yalnız onaylı, süresi dolmamış ve tüm açık gereksinimleri kapsıyorsa sonuç EXCEPTION_ACTIVE.
  const unresolved = new Set(blockers.map((b) => b.requirementId).filter((x): x is string => !!x));
  const hasNonRequirementBlocker = blockers.some((b) => !b.requirementId && b.code !== 'ORIGINAL_CUSTODY_NOT_CONFIRMED');
  const approved = e.exceptions.filter((x) => x.status === 'APPROVED');
  const expiredExceptionIds = approved.filter((x) => x.expiresAt <= e.now).map((x) => x.id);
  const active = approved.find(
    (x) => x.expiresAt > e.now && [...unresolved].every((id) => x.requirementIds.includes(id)),
  );
  const exceptionApplies = underlying !== 'COMPLETE' && underlying !== 'NOT_REQUIRED'
    && !!active && !hasNonRequirementBlocker && (unresolved.size > 0 || e.custodyRequired);

  const wetInScope = required.some((r) => r.acceptableMethods.includes(WET));
  let automaticAlert: SignatureStatus['automaticAlert'] = null;
  if (wetInScope) {
    if (e.latestDetection === 'NOT_DETECTED' || e.latestDetection === 'UNCLEAR') automaticAlert = 'IMAGE_NOT_FOUND_REVIEW_REQUIRED';
    else if (e.latestDetection === 'ERROR' || e.latestDetection === 'UNSUPPORTED') automaticAlert = 'AUTOMATIC_CHECK_UNAVAILABLE';
  }

  const overall: OverallSignatureStatus = exceptionApplies ? 'EXCEPTION_ACTIVE' : underlying;
  return {
    overall,
    underlying,
    requirements: requirementResults,
    blockers,
    custody,
    automaticCheck: wetInScope ? e.latestDetection : 'NOT_PROCESSED',
    automaticAlert,
    activeExceptionId: exceptionApplies && active ? active.id : null,
    expiredExceptionIds,
    canFinalize: overall === 'COMPLETE' || overall === 'EXCEPTION_ACTIVE' || overall === 'NOT_REQUIRED',
  };
}

function evaluateRequirement(req: RequirementInput, reviews: ReviewInput[], validations: ValidationInput[]): RequirementResult {
  const acceptsWet = req.acceptableMethods.includes(WET);
  const eMethods = req.acceptableMethods.filter(isElectronic);

  // Belge düzeyindeki doğrulama tek başına bütün tarafları tamamlamaz (SIG01); gereksinime bağlı olmalı.
  const v = validations
    .filter((x) => x.requirementId === req.id)
    .sort((a, b) => b.validatedAt.getTime() - a.validatedAt.getTime())[0];
  const digital: DigitalStatus = eMethods.length === 0 ? 'NOT_APPLICABLE' : (v?.status ?? 'NOT_CHECKED');

  const slots: RequirementResult['slots'] = [];
  if (acceptsWet) {
    for (let slot = 1; slot <= req.requirementCount; slot++) {
      const latest = reviews
        .filter((r) => r.requirementId === req.id && r.slot === slot)
        .sort((a, b) => b.reviewedAt.getTime() - a.reviewedAt.getTime())[0];
      slots.push({ slot, decision: latest?.decision ?? 'PENDING', observedMark: latest?.observedMark ?? null });
    }
  }

  const base = { id: req.id, partyName: req.partyName, signerRole: req.signerRole, required: req.required, slots, digital };

  if (digital === 'VALIDATED') return { ...base, state: 'SATISFIED', satisfiedBy: eMethods[0]! };
  if (acceptsWet && slots.every((s) => s.decision === 'IMAGE_CONFIRMED' && s.observedMark === 'FULL_SIGNATURE')) {
    return { ...base, state: 'SATISFIED', satisfiedBy: WET };
  }

  let state: RequirementState = 'PENDING';
  if (acceptsWet) {
    if (slots.some((s) => s.decision === 'MISSING')) state = 'MISSING';
    else if (slots.some((s) => s.decision === 'UNCLEAR')) state = 'UNCLEAR';
  }
  // Yalnız e-imza kabul ediliyorsa doğrulayıcı sonucu belirleyicidir.
  if (!acceptsWet) {
    if (digital === 'INVALID') state = 'INVALID';
    else if (digital === 'INDETERMINATE') state = 'UNCLEAR';
  }
  return { ...base, state, satisfiedBy: null };
}
