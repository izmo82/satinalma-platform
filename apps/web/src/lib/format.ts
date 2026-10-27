const dt = new Intl.DateTimeFormat('tr-TR', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Europe/Istanbul' });
const d = new Intl.DateTimeFormat('tr-TR', { dateStyle: 'medium', timeZone: 'Europe/Istanbul' });
export const fmtDateTime = (v: string | Date | null | undefined) => (v ? dt.format(new Date(v)) : '—');
export const fmtDate = (v: string | Date | null | undefined) => (v ? d.format(new Date(v)) : '—');
/** Tutar decimal string olarak gelir; görüntüde para birimi her zaman yazılır. */
export const fmtMoney = (amount: string | null | undefined, currency: string | null | undefined) => {
  if (amount == null) return '—';
  const n = Number(amount);
  if (!Number.isFinite(n)) return `${amount} ${currency ?? ''}`;
  return new Intl.NumberFormat('tr-TR', { style: 'currency', currency: currency ?? 'TRY', minimumFractionDigits: 2 }).format(n);
};
export const shortHash = (h: string) => `${h.slice(0, 8)}…${h.slice(-6)}`;
export function relative(v: string | Date) {
  const diff = Date.now() - new Date(v).getTime();
  const m = Math.round(diff / 60000);
  if (m < 1) return 'şimdi';
  if (m < 60) return `${m} dk önce`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} sa önce`;
  return fmtDate(v);
}

/** Kullanıcının yerel takvim günü (YYYY-MM-DD). `toISOString()` UTC'dir; Türkiye'de gece yarısından sonra bir gün geride kalır. */
export const todayLocal = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
