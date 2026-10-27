import { describe, expect, it } from 'vitest';
import { deriveSignatureStatus, type SignatureEvidence, type RequirementInput } from '../src/index.ts';

const SHA = 'a'.repeat(64);
const NEW_SHA = 'b'.repeat(64);
const now = new Date('2026-10-27T10:00:00Z');
const buyer: RequirementInput = { id: 'r-buyer', partyId: 'p1', partyName: 'Alıcı A.Ş.', signerRole: 'Yetkili', requirementCount: 1, acceptableMethods: ['WET_IMAGE_REVIEW'], required: true };
const supplier: RequirementInput = { ...buyer, id: 'r-sup', partyId: 'p2', partyName: 'Tedarikçi Ltd.' };

function ev(over: Partial<SignatureEvidence> = {}): SignatureEvidence {
  return { method: 'WET_IMAGE_REVIEW', documentSha256: SHA, requirements: [buyer, supplier], reviews: [], validations: [],
    exceptions: [], custodyRequired: false, custodyStatuses: [], latestDetection: 'NOT_PROCESSED', now, ...over };
}
const confirm = (requirementId: string, sha = SHA, at = now) =>
  ({ requirementId, slot: 1, decision: 'IMAGE_CONFIRMED' as const, observedMark: 'FULL_SIGNATURE' as const, documentSha256: sha, reviewedAt: at });

describe('deriveSignatureStatus', () => {
  it('T25: tespit yok → uyarı, insan kararı olmadan MISSING değil', () => {
    const s = deriveSignatureStatus(ev({ latestDetection: 'NOT_DETECTED' }));
    expect(s.overall).toBe('NOT_REVIEWED');
    expect(s.automaticAlert).toBe('IMAGE_NOT_FOUND_REVIEW_REQUIRED');
    expect(s.requirements.every((r) => r.state === 'PENDING')).toBe(true);
    const after = deriveSignatureStatus(ev({ latestDetection: 'NOT_DETECTED', reviews: [
      { requirementId: 'r-sup', slot: 1, decision: 'MISSING', observedMark: 'NONE', documentSha256: SHA, reviewedAt: now },
    ] }));
    expect(after.requirements.find((r) => r.id === 'r-sup')!.state).toBe('MISSING');
  });

  it('T26/SIG01: tek taraf imzalı → INCOMPLETE ve eksik taraf adıyla', () => {
    const s = deriveSignatureStatus(ev({ reviews: [confirm('r-buyer'),
      { requirementId: 'r-sup', slot: 1, decision: 'MISSING', observedMark: 'NONE', documentSha256: SHA, reviewedAt: now }] }));
    expect(s.overall).toBe('INCOMPLETE');
    expect(s.blockers).toContainEqual(expect.objectContaining({ code: 'SIGNATURE_MISSING', partyName: 'Tedarikçi Ltd.' }));
    expect(s.canFinalize).toBe(false);
  });

  it('T27: yalnız kaşe tam imza sayılmaz', () => {
    const s = deriveSignatureStatus(ev({ reviews: [confirm('r-buyer'),
      { requirementId: 'r-sup', slot: 1, decision: 'IMAGE_CONFIRMED', observedMark: 'STAMP_ONLY', documentSha256: SHA, reviewedAt: now }] }));
    expect(s.overall).not.toBe('COMPLETE');
  });

  it('T28: hata/desteklenmiyor durumu imzasız veya tam gösterilmez', () => {
    const s = deriveSignatureStatus(ev({ latestDetection: 'UNSUPPORTED' }));
    expect(s.overall).toBe('NOT_REVIEWED');
    expect(s.automaticAlert).toBe('AUTOMATIC_CHECK_UNAVAILABLE');
  });

  it('her iki taraf teyitli → COMPLETE', () => {
    const s = deriveSignatureStatus(ev({ reviews: [confirm('r-buyer'), confirm('r-sup')] }));
    expect(s.overall).toBe('COMPLETE');
    expect(s.canFinalize).toBe(true);
  });

  it('T31/SIG09: eski sürüm hash incelemesi yeni sürüme taşınmaz', () => {
    const s = deriveSignatureStatus(ev({ documentSha256: NEW_SHA, reviews: [confirm('r-buyer'), confirm('r-sup')] }));
    expect(s.overall).toBe('NOT_REVIEWED');
  });

  it('son karar geçerlidir', () => {
    const later = new Date(now.getTime() + 1000);
    const s = deriveSignatureStatus(ev({ reviews: [confirm('r-buyer'), confirm('r-sup'),
      { requirementId: 'r-sup', slot: 1, decision: 'UNCLEAR', observedMark: 'ILLEGIBLE', documentSha256: SHA, reviewedAt: later }] }));
    expect(s.overall).toBe('UNCLEAR');
  });

  it('T34: e-imza yöntemi, ıslak gerekmiyor → yanlış ıslak uyarısı yok; doğrulama ile tamam', () => {
    const e1 = { ...buyer, acceptableMethods: ['QUALIFIED_ELECTRONIC' as const] };
    const e2 = { ...supplier, acceptableMethods: ['QUALIFIED_ELECTRONIC' as const] };
    const pending = deriveSignatureStatus(ev({ method: 'QUALIFIED_ELECTRONIC', requirements: [e1, e2], latestDetection: 'NOT_DETECTED' }));
    expect(pending.automaticAlert).toBeNull();
    expect(pending.blockers.every((b) => b.code === 'ESIGN_NOT_VALIDATED')).toBe(true);
    const ok = deriveSignatureStatus(ev({ method: 'QUALIFIED_ELECTRONIC', requirements: [e1, e2], validations: [
      { requirementId: e1.id, signedFileSha256: SHA, status: 'VALIDATED', validatedAt: now },
      { requirementId: e2.id, signedFileSha256: SHA, status: 'VALIDATED', validatedAt: now }] }));
    expect(ok.overall).toBe('COMPLETE');
  });

  it('T35: doğrulama yok/sonuçsuz → VALIDATED/COMPLETE olmaz', () => {
    const e1 = { ...buyer, acceptableMethods: ['QUALIFIED_ELECTRONIC' as const] };
    const s = deriveSignatureStatus(ev({ method: 'QUALIFIED_ELECTRONIC', requirements: [e1], validations: [
      { requirementId: e1.id, signedFileSha256: SHA, status: 'INDETERMINATE', validatedAt: now }] }));
    expect(s.overall).toBe('UNCLEAR');
    expect(s.requirements[0]!.digital).toBe('INDETERMINATE');
  });

  it('SIG01: belge düzeyi tek doğrulama tüm tarafları tamamlamaz', () => {
    const e1 = { ...buyer, acceptableMethods: ['QUALIFIED_ELECTRONIC' as const] };
    const e2 = { ...supplier, acceptableMethods: ['QUALIFIED_ELECTRONIC' as const] };
    const s = deriveSignatureStatus(ev({ method: 'QUALIFIED_ELECTRONIC', requirements: [e1, e2], validations: [
      { requirementId: null, signedFileSha256: SHA, status: 'VALIDATED', validatedAt: now }] }));
    expect(s.overall).toBe('NOT_REVIEWED');
  });

  it('T36: istisna eksikliği gizlemez; süresi dolunca kalkar', () => {
    const reviews = [confirm('r-buyer'), { requirementId: 'r-sup', slot: 1, decision: 'MISSING' as const, observedMark: 'NONE' as const, documentSha256: SHA, reviewedAt: now }];
    const exc = { id: 'x1', requirementIds: ['r-sup'], status: 'APPROVED' as const, expiresAt: new Date(now.getTime() + 86400000) };
    const s = deriveSignatureStatus(ev({ reviews, exceptions: [exc] }));
    expect(s.overall).toBe('EXCEPTION_ACTIVE');
    expect(s.underlying).toBe('INCOMPLETE');
    expect(s.blockers.length).toBeGreaterThan(0);
    const expired = deriveSignatureStatus(ev({ reviews, exceptions: [exc], now: new Date(now.getTime() + 2 * 86400000) }));
    expect(expired.overall).toBe('INCOMPLETE');
    expect(expired.expiredExceptionIds).toEqual(['x1']);
  });

  it('T39: hibrit çok taraflı; her gereksinim kendi yöntemine göre', () => {
    const wet = buyer;
    const esig = { ...supplier, acceptableMethods: ['QUALIFIED_ELECTRONIC' as const] };
    const s = deriveSignatureStatus(ev({ method: 'HYBRID', requirements: [wet, esig], reviews: [confirm('r-buyer')] }));
    expect(s.overall).toBe('NOT_REVIEWED');
    expect(s.blockers).toEqual([expect.objectContaining({ code: 'ESIGN_NOT_VALIDATED', requirementId: 'r-sup' })]);
  });

  it('T40: asıl bilinmiyor ama görüntü teyitli; yalnız politika zorunluysa blokaj', () => {
    const reviews = [confirm('r-buyer'), confirm('r-sup')];
    expect(deriveSignatureStatus(ev({ reviews })).overall).toBe('COMPLETE');
    const s = deriveSignatureStatus(ev({ reviews, custodyRequired: true }));
    expect(s.overall).toBe('INCOMPLETE');
    expect(s.custody).toBe('UNKNOWN');
    expect(deriveSignatureStatus(ev({ reviews, custodyRequired: true, custodyStatuses: ['CUSTODY_CONFIRMED'] })).overall).toBe('COMPLETE');
  });

  it('yöntem sınıflanmamış veya gereksinim yok → tamamlanamaz; NOT_REQUIRED ayrı', () => {
    expect(deriveSignatureStatus(ev({ method: 'PENDING_CLASSIFICATION', reviews: [confirm('r-buyer'), confirm('r-sup')] })).canFinalize).toBe(false);
    expect(deriveSignatureStatus(ev({ requirements: [] })).blockers[0]!.code).toBe('NO_REQUIREMENTS_DEFINED');
    expect(deriveSignatureStatus(ev({ method: 'NOT_REQUIRED', requirements: [] })).overall).toBe('NOT_REQUIRED');
  });

  it('çok slotlu gereksinim: tüm imzacılar gerekli', () => {
    const two = { ...buyer, requirementCount: 2 };
    const s = deriveSignatureStatus(ev({ requirements: [two], reviews: [confirm('r-buyer')] }));
    expect(s.overall).toBe('NOT_REVIEWED');
  });
});
