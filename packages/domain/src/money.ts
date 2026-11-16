/**
 * Sabit ölçekli ondalık (BigInt, 6 basamak). Para ve miktar asla float ile hesaplanmaz; giriş/çıkış decimal string.
 * Yuvarlama: yarım yukarı (sıfırdan uzağa), yalnız gösterim/saklama sınırında.
 */
export const SCALE = 6;
const ONE = 10n ** BigInt(SCALE);

export type Dec = bigint;

const RE = /^-?\d{1,18}(\.\d{1,6})?$/;

export function isDecimal(s: string): boolean {
  return RE.test(s);
}

export function dec(s: string): Dec {
  if (!RE.test(s)) throw new Error(`invalid decimal: ${s}`);
  const neg = s.startsWith('-');
  const [i, f = ''] = (neg ? s.slice(1) : s).split('.');
  const v = BigInt(i!) * ONE + BigInt((f + '000000').slice(0, SCALE));
  return neg ? -v : v;
}

export const add = (...xs: Dec[]): Dec => xs.reduce((a, b) => a + b, 0n);
export const mul = (a: Dec, b: Dec): Dec => roundDiv(a * b, ONE);
export const div = (a: Dec, b: Dec): Dec => {
  if (b === 0n) throw new Error('division by zero');
  return roundDiv(a * ONE, b);
};
export const cmp = (a: Dec, b: Dec): number => (a < b ? -1 : a > b ? 1 : 0);
export const min = (xs: Dec[]): Dec => xs.reduce((a, b) => (b < a ? b : a));

function roundDiv(n: bigint, d: bigint): bigint {
  const neg = (n < 0n) !== (d < 0n);
  const an = n < 0n ? -n : n;
  const ad = d < 0n ? -d : d;
  const q = an / ad;
  const r = an % ad;
  const out = r * 2n >= ad ? q + 1n : q;
  return neg ? -out : out;
}

/** `places` basamağa yuvarlanmış decimal string (ör. tutar için 2). */
export function str(v: Dec, places = 2): string {
  const factor = 10n ** BigInt(SCALE - places);
  const r = roundDiv(v, factor);
  const neg = r < 0n;
  const a = neg ? -r : r;
  const p = 10n ** BigInt(places);
  const i = a / p;
  const f = (a % p).toString().padStart(places, '0');
  return `${neg ? '-' : ''}${i}${places ? `.${f}` : ''}`;
}

/**
 * Kullanıcıya giden metinde tutar Türkçe biçimde (binlik nokta, ondalık virgül, 2 basamak): "1500.00" → "1.500,00".
 * Geçersiz girdi (ör. bozuk belge değeri) olduğu gibi döner; uydurma değer gösterilmez.
 */
export function trAmount(v: Dec | string): string {
  if (typeof v === 'string' && !isDecimal(v)) return v;
  const s = str(typeof v === 'string' ? dec(v) : v);
  const neg = s.startsWith('-');
  const [i, f] = (neg ? s.slice(1) : s).split('.');
  return `${neg ? '-' : ''}${i!.replace(/\B(?=(\d{3})+(?!\d))/g, '.')},${f}`;
}

/** Oran (yüzde) Türkçe biçimde: "20.00" → "20", "7.50" → "7,5". */
export function trRate(v: string): string {
  if (!isDecimal(v)) return v;
  return str(dec(v)).replace(/\.?0+$/, '').replace('.', ',');
}
