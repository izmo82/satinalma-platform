// Saklama, hukuki saklama ve imha kuralları (02 §17, 08 "İşletim ve güvenlik kapısı", T48).
// Tek bir evrensel süre yoktur: politika belge türü bazında kiracı tarafından gerekçesiyle tanımlanır; politika yoksa belge süresiz saklanır.
// Hukuki saklama imhayı her koşulda durdurur. İmha kararını bu modül vermez; yalnız aday olup olmadığını ve neden olmadığını söyler.
import { addMonths } from './contractTerms.ts';

export type HoldScope = 'TENANT' | 'COMPANY' | 'DOCUMENT';
export interface LegalHold { scope: HoldScope; companyId: string | null; documentId: string | null; releasedAt: string | null }
export interface RetentionPolicy { documentKind: string; retentionMonths: number }
export interface RetentionDocument { id: string; companyId: string; kind: string; lastVersionAt: string; disposed: boolean }

export type RetentionVerdict =
  | { eligible: true; dueOn: string }
  | { eligible: false; reason: 'NO_POLICY' | 'NOT_DUE' | 'LEGAL_HOLD' | 'ALREADY_DISPOSED'; dueOn: string | null };

/** Aktif (kaldırılmamış) hukuki saklama belgeyi kapsıyor mu. */
export function holdCovers(h: LegalHold, d: { id: string; companyId: string }): boolean {
  if (h.releasedAt) return false;
  if (h.scope === 'TENANT') return true;
  if (h.scope === 'COMPANY') return h.companyId === d.companyId;
  return h.documentId === d.id;
}

/**
 * Süre, belgenin SON sürümünün tarihinden işler (yeni sürüm saklamayı uzatır). Süre dolduğu gün dahil değildir:
 * `today` vade gününden sonra ise adaydır.
 */
export function retentionVerdict(d: RetentionDocument, policies: RetentionPolicy[], holds: LegalHold[], today: string): RetentionVerdict {
  if (d.disposed) return { eligible: false, reason: 'ALREADY_DISPOSED', dueOn: null };
  const p = policies.find((x) => x.documentKind === d.kind);
  if (!p) return { eligible: false, reason: 'NO_POLICY', dueOn: null };
  if (!Number.isInteger(p.retentionMonths) || p.retentionMonths <= 0) throw new Error('retentionMonths must be a positive integer');
  const dueOn = addMonths(d.lastVersionAt.slice(0, 10), p.retentionMonths); // ay sonu taşması ayın son gününe çekilir
  if (holds.some((h) => holdCovers(h, d))) return { eligible: false, reason: 'LEGAL_HOLD', dueOn };
  if (today <= dueOn) return { eligible: false, reason: 'NOT_DUE', dueOn };
  return { eligible: true, dueOn };
}
