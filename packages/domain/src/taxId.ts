// Vergi kimliği normalizasyonu. Biçim/kontrol basamağı geçerliliği firmanın gerçekliğini,
// mükellefiyetini veya banka hesabı sahipliğini kanıtlamaz; yalnız eşleme anahtarı üretir.

export type TaxIdType = 'VKN' | 'TCKN' | 'FOREIGN';

export type TaxIdResult =
  | { ok: true; type: TaxIdType; country: string; normalized: string }
  | { ok: false; reason: 'EMPTY' | 'BAD_LENGTH' | 'NON_DIGIT' | 'CHECKSUM' | 'UNSUPPORTED_COUNTRY' };

export function normalizeTaxId(country: string, type: TaxIdType, raw: string | null | undefined): TaxIdResult {
  // String olarak kalır; baştaki sıfır korunur. Sadece boşluk, nokta ve tire atılır.
  const value = (raw ?? '').replace(/[\s.\-]/g, '');
  if (!value) return { ok: false, reason: 'EMPTY' };
  const c = country.toUpperCase();
  if (type === 'FOREIGN') {
    if (!/^[A-Z0-9]{2,32}$/i.test(value)) return { ok: false, reason: 'NON_DIGIT' };
    return { ok: true, type, country: c, normalized: value.toUpperCase() };
  }
  if (c !== 'TR') return { ok: false, reason: 'UNSUPPORTED_COUNTRY' };
  if (!/^\d+$/.test(value)) return { ok: false, reason: 'NON_DIGIT' };
  if (type === 'VKN') {
    if (value.length !== 10) return { ok: false, reason: 'BAD_LENGTH' };
    return vknChecksum(value) ? { ok: true, type, country: c, normalized: value } : { ok: false, reason: 'CHECKSUM' };
  }
  if (value.length !== 11) return { ok: false, reason: 'BAD_LENGTH' };
  return tcknChecksum(value) ? { ok: true, type, country: c, normalized: value } : { ok: false, reason: 'CHECKSUM' };
}

function vknChecksum(v: string): boolean {
  const d = [...v].map(Number);
  let sum = 0;
  for (let i = 0; i < 9; i++) {
    const tmp = (d[i]! + 9 - i) % 10;
    let r = (tmp * 2 ** (9 - i)) % 9;
    if (tmp !== 0 && r === 0) r = 9;
    sum += r;
  }
  return (10 - (sum % 10)) % 10 === d[9];
}

function tcknChecksum(v: string): boolean {
  const d = [...v].map(Number);
  if (d[0] === 0) return false;
  const odd = d[0]! + d[2]! + d[4]! + d[6]! + d[8]!;
  const even = d[1]! + d[3]! + d[5]! + d[7]!;
  const d10 = (((odd * 7 - even) % 10) + 10) % 10;
  const d11 = d.slice(0, 10).reduce((a, b) => a + b, 0) % 10;
  return d[9] === d10 && d[10] === d11;
}

/** Test/demo için geçerli kontrol basamaklı sentetik VKN üretir (gerçek firma değildir). */
export function syntheticVkn(prefix9: string): string {
  if (!/^\d{9}$/.test(prefix9)) throw new Error('prefix must be 9 digits');
  for (let c = 0; c <= 9; c++) if (vknChecksum(prefix9 + c)) return prefix9 + c;
  throw new Error('unreachable');
}

export function normalizeIban(raw: string): string {
  return raw.replace(/\s/g, '').toUpperCase();
}

export function isValidIban(raw: string): boolean {
  const iban = normalizeIban(raw);
  if (!/^[A-Z]{2}\d{2}[A-Z0-9]{10,30}$/.test(iban)) return false;
  const rearranged = iban.slice(4) + iban.slice(0, 4);
  let rem = 0;
  for (const ch of rearranged) {
    const n = /\d/.test(ch) ? ch : String(ch.charCodeAt(0) - 55);
    for (const digit of n) rem = (rem * 10 + Number(digit)) % 97;
  }
  return rem === 1;
}
