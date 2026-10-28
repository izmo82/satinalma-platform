import { cmp, dec } from './money.ts';

/**
 * Kurallı onay motoru (02 §13 "Onay motoru"). Şirket, kategori, tutar ve para birimine göre ardışık onay adımları üretir ve
 * kimin, hangi veriyle, hangi politika sürümünde onaylaması gerektiğini açıklar. Kurallar kurum politikasıdır ("en az üç teklif"
 * evrensel zorunluluk değildir): kural yoksa varsayılan tek adım (satınalma yöneticisi) — önceki sabit davranış.
 * Başlayan iş, başladığı andaki politika sürümüyle bağlanır (adımlar kayda kopyalanır); yeni sürüm yalnız yeni işlere uygulanır.
 */

export type ApprovalAction = 'RFQ_PUBLISH' | 'AWARD' | 'SOURCING_EXCEPTION';
export interface ApprovalStep { role: string; label: string }
export interface ApprovalRule {
  id: string;
  action: ApprovalAction;
  /** Boş/yok = bütün şirketler / kategoriler. Kategori karşılaştırması büyük/küçük harf ve boşluk duyarsız. */
  companyId?: string | null;
  category?: string | null;
  currency: string;
  /** [min, max) tutar aralığı; max null = üst sınır yok. */
  minAmount: string;
  maxAmount: string | null;
  steps: ApprovalStep[];
  /** Yalnız RFQ_PUBLISH: en az davetli sayısı ve teklif için en az gün. Altında kalmak onaylı istisna ister (tek kaynak / acil alım). */
  minInvitees?: number | null;
  minResponseDays?: number | null;
}
export interface ApprovalPolicy { version: number; rules: ApprovalRule[] }
export interface ApprovalContext { action: ApprovalAction; companyId: string; category: string | null; currency: string; amount: string | null }
export interface ApprovalPlan {
  policyVersion: number | null;
  ruleId: string | null;
  steps: ApprovalStep[];
  minInvitees: number | null;
  minResponseDays: number | null;
  /** İnsan okunur açıklama: hangi kural, hangi veriyle seçildi. */
  explanation: string;
}

export const DEFAULT_STEPS: Record<ApprovalAction, ApprovalStep[]> = {
  RFQ_PUBLISH: [{ role: 'PROCUREMENT_MANAGER', label: 'Satınalma yöneticisi' }],
  AWARD: [{ role: 'PROCUREMENT_MANAGER', label: 'Satınalma yöneticisi' }],
  SOURCING_EXCEPTION: [{ role: 'PROCUREMENT_MANAGER', label: 'Satınalma yöneticisi' }],
};
const ACTION_TEXT: Record<ApprovalAction, string> = { RFQ_PUBLISH: 'teklif turu yayını', AWARD: 'seçim kararı', SOURCING_EXCEPTION: 'kaynak bulma istisnası' };
const norm = (s: string | null | undefined) => (s ?? '').trim().toLocaleLowerCase('tr-TR');

export function validateRule(r: ApprovalRule): string | null {
  if (!/^[A-Z]{3}$/.test(r.currency)) return 'Para birimi ISO kodu olmalı.';
  if (!/^\d{1,18}(\.\d{1,2})?$/.test(r.minAmount) || (r.maxAmount !== null && !/^\d{1,18}(\.\d{1,2})?$/.test(r.maxAmount))) return 'Tutar aralığı sıfır veya pozitif, en fazla 2 ondalık olmalı.';
  if (r.maxAmount !== null && cmp(dec(r.maxAmount), dec(r.minAmount)) <= 0) return 'Üst sınır alt sınırdan büyük olmalı.';
  if (!r.steps.length || r.steps.length > 6) return 'Kuralda 1–6 onay adımı olmalı.';
  if (r.steps.some((s) => !s.role || !s.label.trim())) return 'Her adımın rolü ve adı olmalı.';
  if (r.action !== 'RFQ_PUBLISH' && (r.minInvitees != null || r.minResponseDays != null)) return 'En az davetli ve en az gün yalnız yayın kuralında tanımlanır.';
  if (r.minInvitees != null && (!Number.isInteger(r.minInvitees) || r.minInvitees < 1 || r.minInvitees > 20)) return 'En az davetli 1–20 olmalı.';
  if (r.minResponseDays != null && (!Number.isInteger(r.minResponseDays) || r.minResponseDays < 0 || r.minResponseDays > 90)) return 'En az teklif süresi 0–90 gün olmalı.';
  return null;
}

/** Aynı kapsam ve aynı tutar aralığında iki kural olamaz (hangi kuralın geçerli olduğu her zaman tektir). */
export function validatePolicy(rules: ApprovalRule[]): string | null {
  for (const r of rules) { const e = validateRule(r); if (e) return `${r.id}: ${e}`; }
  for (let i = 0; i < rules.length; i++) for (let j = i + 1; j < rules.length; j++) {
    const a = rules[i]!; const b = rules[j]!;
    if (a.action !== b.action || a.currency !== b.currency || (a.companyId ?? '') !== (b.companyId ?? '') || norm(a.category) !== norm(b.category)) continue;
    const aMax = a.maxAmount === null ? null : dec(a.maxAmount); const bMax = b.maxAmount === null ? null : dec(b.maxAmount);
    const overlap = (aMax === null || dec(b.minAmount) < aMax) && (bMax === null || dec(a.minAmount) < bMax);
    if (overlap) return `${a.id} ve ${b.id} aynı kapsamda çakışan tutar aralığına sahip.`;
  }
  return null;
}

/**
 * En özel kural seçilir: şirket+kategori > kategori > şirket > genel; aynı özgüllükte tutar aralığı belirler.
 * Tutar bilinmiyorsa (bütçe girilmemiş) aralık kuralı uygulanamaz → en sıkı (en çok adımlı) kural seçilir; açıklamada yazılır.
 */
export function planApproval(policy: ApprovalPolicy | null, c: ApprovalContext): ApprovalPlan {
  const base = { policyVersion: policy?.version ?? null, minInvitees: null, minResponseDays: null };
  const candidates = (policy?.rules ?? []).filter((r) => r.action === c.action && r.currency === c.currency
    && (!r.companyId || r.companyId === c.companyId) && (!norm(r.category) || norm(r.category) === norm(c.category)));
  const spec = (r: ApprovalRule) => (r.companyId ? 1 : 0) + (norm(r.category) ? 2 : 0);
  // Önce tutar aralığı, sonra en özel kapsam: büyük tutarlar için eklenen özel kural, küçük tutarlarda genel kuralın korumasını kaldırmaz.
  let rule: ApprovalRule | undefined;
  let note = '';
  if (c.amount === null) {
    // Tutar bilinmiyor: kapsamdaki bütün kurallar içinden en sıkı (en çok adımlı, eşitse en özel) kural.
    rule = [...candidates].sort((a, b) => b.steps.length - a.steps.length || spec(b) - spec(a))[0];
    if (rule) note = ' Tutar bilinmediği için kapsamın en sıkı kuralı uygulandı.';
  } else {
    const amt = dec(c.amount);
    rule = candidates.filter((r) => amt >= dec(r.minAmount) && (r.maxAmount === null || amt < dec(r.maxAmount))).sort((a, b) => spec(b) - spec(a))[0];
  }
  if (!rule) {
    return { ...base, ruleId: null, steps: DEFAULT_STEPS[c.action],
      explanation: `${policy ? `Politika v${policy.version} içinde` : 'Yayınlanmış politika yok;'} bu ${ACTION_TEXT[c.action]} için (${c.currency}${c.amount ? ` ${c.amount}` : ''}${c.category ? `, ${c.category}` : ''}) kural bulunmadı; varsayılan tek onay: satınalma yöneticisi.` };
  }
  const scope = [rule.companyId ? 'şirkete özel' : null, norm(rule.category) ? `"${rule.category}" kategorisi` : null].filter(Boolean).join(', ') || 'genel';
  const band = `${rule.minAmount}${rule.maxAmount ? `–${rule.maxAmount}` : ' ve üstü'} ${rule.currency}`;
  return { ...base, ruleId: rule.id, steps: rule.steps, minInvitees: rule.minInvitees ?? null, minResponseDays: rule.minResponseDays ?? null,
    explanation: `Politika v${policy!.version}, kural ${rule.id} (${scope}, ${band}): ${rule.steps.map((s, i) => `${i + 1}. ${s.label}`).join(' → ')}.${note}` };
}

export interface StepDecision { stepNo: number; decidedBy: string; decision: 'APPROVE' | 'REJECT' }
/**
 * Ardışık adım ilerlemesi: sıradaki adım = onaylanmış adım sayısı + 1. Aynı kişi iki adımı onaylayamaz, talep eden hiçbir adımı.
 * `canDecide` kullanıcının rolleri ve önceki kararlarına göre şu anki adımı karara bağlayıp bağlayamayacağını söyler.
 */
export function approvalProgress(steps: ApprovalStep[], decisions: StepDecision[], requestedBy: string) {
  const rejected = decisions.some((d) => d.decision === 'REJECT');
  const approved = decisions.filter((d) => d.decision === 'APPROVE').length;
  const next = rejected || approved >= steps.length ? null : steps[approved]!;
  return {
    done: !rejected && approved >= steps.length, rejected, nextStepNo: next ? approved + 1 : null, nextStep: next,
    canDecide: (userId: string, roles: string[]) => {
      if (!next) return { ok: false, reason: 'Karar verilecek adım yok.' };
      if (userId === requestedBy) return { ok: false, reason: 'Talep eden kişi onaylayamaz (görev ayrılığı).' };
      if (decisions.some((d) => d.decidedBy === userId)) return { ok: false, reason: 'Önceki bir adımı onaylayan kişi sonraki adımı onaylayamaz.' };
      if (!roles.includes(next.role)) return { ok: false, reason: `Bu adım "${next.label}" rolündeki bir kişinin onayını bekliyor.` };
      return { ok: true, reason: null };
    },
  };
}
