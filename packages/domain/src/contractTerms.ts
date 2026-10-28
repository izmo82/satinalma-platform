/**
 * Sözleşme süresi, ihbar ve yükümlülük kuralları (FR08–FR09, 02 §11, T21).
 * Tarihler takvim tarihi (YYYY-MM-DD) olarak işlenir; saat dilimi kayması olmaz.
 * Hesap kuralı sözleşmeden girilir ve hukuk tarafından doğrulanır; bu modül yalnız girilen kuralı uygular.
 */

export type NoticeUnit = 'DAY' | 'MONTH';
export type NonWorkingDayRule = 'PREVIOUS_WORKING_DAY' | 'AS_IS';
export interface NoticeRule { amount: number; unit: NoticeUnit; nonWorkingDay: NonWorkingDayRule }
export type Recurrence = 'NONE' | 'MONTHLY' | 'QUARTERLY' | 'YEARLY';

const ISO = /^\d{4}-\d{2}-\d{2}$/;
const toDate = (s: string) => {
  if (!ISO.test(s)) throw new Error(`invalid date: ${s}`);
  const [y, m, d] = s.split('-').map(Number) as [number, number, number];
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCMonth() !== m - 1) throw new Error(`invalid date: ${s}`);
  return dt;
};
const fmt = (d: Date) => d.toISOString().slice(0, 10);

export function addDays(date: string, days: number): string {
  const d = toDate(date);
  d.setUTCDate(d.getUTCDate() + days);
  return fmt(d);
}

/** Ay ekleme: hedef ayda gün yoksa ayın son günü (31 Ocak + 1 ay = 28/29 Şubat). */
export function addMonths(date: string, months: number): string {
  const d = toDate(date);
  const day = d.getUTCDate();
  const target = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + months, 1));
  const last = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  target.setUTCDate(Math.min(day, last));
  return fmt(target);
}

export const isWeekend = (date: string) => [0, 6].includes(toDate(date).getUTCDay());
export const isWorkingDay = (date: string, holidays: ReadonlySet<string>) => !isWeekend(date) && !holidays.has(date);

export interface NoticeDeadline {
  /** İhbarın en geç yapılabileceği gün. */
  deadline: string;
  /** Kural uygulanmadan önceki ham tarih. */
  raw: string;
  adjusted: boolean;
  explanation: string;
}

/**
 * Son ihbar günü: bitiş tarihinden ihbar süresi kadar geriye gidilir. Hesaplanan gün hafta sonu veya tatilse ve
 * sözleşme "önceki iş günü" diyorsa geriye kaydırılır (ihbar geç kalmaz). Örnek: 31.12 bitiş, 60 gün → 01.11.
 */
export function noticeDeadline(endDate: string, rule: NoticeRule, holidays: Iterable<string> = []): NoticeDeadline {
  if (!Number.isInteger(rule.amount) || rule.amount < 0 || rule.amount > 3650) throw new Error('invalid notice amount');
  const h = new Set(holidays);
  const raw = rule.unit === 'DAY' ? addDays(endDate, -rule.amount) : addMonths(endDate, -rule.amount);
  let deadline = raw;
  if (rule.nonWorkingDay === 'PREVIOUS_WORKING_DAY') {
    let guard = 0;
    while (!isWorkingDay(deadline, h) && guard++ < 30) deadline = addDays(deadline, -1);
  }
  const unitText = rule.unit === 'DAY' ? 'gün' : 'ay';
  const tr = (d: string) => d.split('-').reverse().join('.');
  const explanation = deadline === raw
    ? `Bitiş ${tr(endDate)} − ${rule.amount} ${unitText} = ${tr(raw)}.`
    : `Bitiş ${tr(endDate)} − ${rule.amount} ${unitText} = ${tr(raw)} (iş günü değil); sözleşme kuralı gereği önceki iş günü ${tr(deadline)}.`;
  return { deadline, raw, adjusted: deadline !== raw, explanation };
}

export const DEFAULT_REMINDER_OFFSETS = [90, 60, 30] as const;

/** Uyarılar bitiş tarihine değil ihbar son gününe göre planlanır. Geçmişte kalan uyarı "hemen" çalışır. */
export function reminderSchedule(deadline: string, today: string, offsets: readonly number[] = DEFAULT_REMINDER_OFFSETS) {
  return [...offsets].sort((a, b) => b - a).map((offset) => {
    const date = addDays(deadline, -offset);
    return { offset, date, due: date <= today };
  });
}

/** Tekrarlanan yükümlülüğün [from, to] aralığındaki tarihleri. */
export function occurrences(firstDue: string, recurrence: Recurrence, from: string, to: string, until: string | null = null, max = 400): string[] {
  const step = recurrence === 'MONTHLY' ? 1 : recurrence === 'QUARTERLY' ? 3 : recurrence === 'YEARLY' ? 12 : 0;
  const out: string[] = [];
  for (let i = 0; out.length < max; i++) {
    const d = step ? addMonths(firstDue, step * i) : firstDue;
    if ((until && d > until) || d > to) break;
    if (d >= from) out.push(d);
    if (!step) break;
  }
  return out;
}

export interface CommercialTerms {
  currency: string; valueType: 'FIXED' | 'CEILING' | 'UNPRICED'; amount: string | null; paymentTerms: string;
  startDate: string | null; endDate: string | null; autoRenewal: boolean; renewalMonths: number | null;
  noticeAmount: number | null; noticeUnit: NoticeUnit | null; nonWorkingDay: NonWorkingDayRule; sourceRef: string;
  /** Tavanın vergi yöntemi: NET (vergi hariç, varsayılan) veya GROSS (KDV ve KDV dışı vergiler dahil). */
  limitBasis?: 'NET' | 'GROSS';
}

export function validateTerms(t: CommercialTerms): string | null {
  if (!/^[A-Z]{3}$/.test(t.currency)) return 'Para birimi ISO kodu olmalı.';
  if (t.valueType === 'UNPRICED') { if (t.amount !== null) return 'Bedelsiz sözleşmede tutar girilmez.'; }
  else if (t.amount === null || !/^\d{1,18}(\.\d{1,2})?$/.test(t.amount)) return 'Bedel veya tavan tutarı gerekli (en fazla 2 ondalık).';
  for (const [k, v] of [['Başlangıç', t.startDate], ['Bitiş', t.endDate]] as const) if (v !== null && !ISO.test(v)) return `${k} tarihi geçersiz.`;
  if (t.startDate && t.endDate && t.endDate < t.startDate) return 'Bitiş başlangıçtan önce olamaz.';
  if (t.limitBasis != null && t.limitBasis !== 'NET' && t.limitBasis !== 'GROSS') return 'Limit yöntemi vergi hariç veya vergi dahil olmalı.';
  if ((t.noticeAmount === null) !== (t.noticeUnit === null)) return 'İhbar süresi ve birimi birlikte girilir.';
  if (t.noticeAmount !== null && !t.endDate) return 'Süresiz sözleşmede ihbar son günü bitişe göre hesaplanamaz; fesih bildirimi ayrı kuralla izlenir.';
  if (t.autoRenewal && !t.renewalMonths) return 'Otomatik yenilemede yenileme süresi gerekli.';
  if (t.sourceRef.trim().length < 3) return 'Tarihlerin ve bedelin dayandığı madde/sayfa gerekli (ör. Madde 4.2, s. 3).';
  return null;
}

const FIELD_LABEL: Record<keyof CommercialTerms, string> = {
  currency: 'Para birimi', valueType: 'Bedel türü', amount: 'Bedel/tavan', paymentTerms: 'Ödeme koşulu', startDate: 'Başlangıç', endDate: 'Bitiş',
  autoRenewal: 'Otomatik yenileme', renewalMonths: 'Yenileme süresi', noticeAmount: 'İhbar süresi', noticeUnit: 'İhbar birimi',
  nonWorkingDay: 'Tatil kuralı', sourceRef: 'Kaynak madde', limitBasis: 'Limit yöntemi',
};
/** Önemli değişiklik farkı: onay ekranı eski ve yeni değeri birlikte gösterir (02 §11). */
export function termsDiff(prev: CommercialTerms | null, next: CommercialTerms) {
  if (!prev) return [];
  return (Object.keys(FIELD_LABEL) as (keyof CommercialTerms)[])
    .filter((k) => String(prev[k] ?? '') !== String(next[k] ?? ''))
    .map((k) => ({ field: k, label: FIELD_LABEL[k], before: prev[k], after: next[k] }));
}
