// Tedarikçi seçim listesi etiketi: aynı adlı kayıtlar (ör. kimliği doğrulanmamış aday ile aktif firma) karışmasın.
// Aktif ve adı tek olan tedarikçinin etiketi yalnız ünvandır; ayrım gerekmediğinde etikete ek yapılmaz.
export interface SupplierOptionInput {
  id: string; legalName: string; status: string;
  taxIdType: string | null; taxId: string | null; identityReviewRequired: boolean;
  createdAt?: string | Date | null;
}

const STATUS_NOTE: Record<string, string> = { CANDIDATE: 'Aday', CONDITIONAL: 'Koşullu' };
const STAMP = new Intl.DateTimeFormat('tr-TR', { timeZone: 'Europe/Istanbul', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
const nameKey = (s: string) => s.toLocaleLowerCase('tr-TR').replace(/\s+/g, ' ').trim();

/** Vergi kimliğinin yalnız son 4 hanesi gösterilir (liste çok kişiye açık). */
export const taxIdTail = (type: string | null, id: string | null) => (type && id ? `${type} …${id.slice(-4)}` : null);

export function supplierOptionLabels(items: SupplierOptionInput[]): Map<string, string> {
  const unverifiedOf = (s: SupplierOptionInput) => s.identityReviewRequired || !s.taxId;
  // Kimliği doğrulanmamış kayıt zaten "vergi kimliği doğrulanmadı" ekiyle ayrılır; vergi kimliği eki yalnız kimliği belli aynı adlı kayıtlar arasında gerekir.
  const count = new Map<string, number>();
  const unverifiedCount = new Map<string, number>();
  for (const s of items) {
    const m = unverifiedOf(s) ? unverifiedCount : count;
    m.set(nameKey(s.legalName), (m.get(nameKey(s.legalName)) ?? 0) + 1);
  }
  const out = new Map<string, string>();
  for (const s of items) {
    const notes: string[] = [];
    const status = STATUS_NOTE[s.status];
    if (status) notes.push(status);
    const unverified = unverifiedOf(s);
    if (unverified) notes.push('vergi kimliği doğrulanmadı');
    // Kimliği belirsiz aynı adlı adaylar yalnız kayıt anıyla ayrılabilir.
    if (unverified && (unverifiedCount.get(nameKey(s.legalName)) ?? 0) > 1 && s.createdAt) notes.push(`kayıt ${STAMP.format(new Date(s.createdAt))}`);
    if ((count.get(nameKey(s.legalName)) ?? 0) > 1 && !unverified) notes.push(taxIdTail(s.taxIdType, s.taxId)!);
    out.set(s.id, notes.length ? `${s.legalName} · ${notes.join(', ')}` : s.legalName);
  }
  // Son geçiş: hâlâ aynı kalan etiketler (aynı dakikada açılmış adaylar, son 4 hanesi aynı VKN) liste sırasıyla #2, #3… alır.
  // İlk kaydın etiketi değişmez; böylece tek aktif kaydın etiketi korunur.
  const seen = new Map<string, number>();
  for (const s of items) {
    const label = out.get(s.id)!;
    const n = (seen.get(label) ?? 0) + 1;
    seen.set(label, n);
    if (n > 1) out.set(s.id, `${label} #${n}`);
  }
  return out;
}
