import { describe, expect, it } from 'vitest';
import { isValidIban, normalizeTaxId, syntheticVkn } from '../src/index.ts';

describe('normalizeTaxId', () => {
  it('baştaki sıfırı korur ve string döner', () => {
    const vkn = syntheticVkn('012345678');
    const r = normalizeTaxId('TR', 'VKN', ` ${vkn.slice(0, 3)}-${vkn.slice(3)} `);
    expect(r).toEqual({ ok: true, type: 'VKN', country: 'TR', normalized: vkn });
    expect(vkn.startsWith('0')).toBe(true);
  });
  it('kontrol basamağı hatalı VKN kesin anahtar üretmez', () => {
    const vkn = syntheticVkn('123456789');
    const wrong = vkn.slice(0, 9) + ((Number(vkn[9]) + 1) % 10);
    expect(normalizeTaxId('TR', 'VKN', wrong)).toEqual({ ok: false, reason: 'CHECKSUM' });
  });
  it('TCKN algoritmasını uygular', () => {
    expect(normalizeTaxId('TR', 'TCKN', '10000000146').ok).toBe(true);
    expect(normalizeTaxId('TR', 'TCKN', '10000000147').ok).toBe(false);
    expect(normalizeTaxId('TR', 'TCKN', '01000000146').ok).toBe(false);
  });
  it('boş veya eksik değeri reddeder', () => {
    expect(normalizeTaxId('TR', 'VKN', '').ok).toBe(false);
    expect(normalizeTaxId('TR', 'VKN', '12345').ok).toBe(false);
  });
});

describe('IBAN', () => {
  it('mod-97 kontrolü', () => {
    expect(isValidIban('TR33 0006 1005 1978 6457 8413 26')).toBe(true);
    expect(isValidIban('TR34 0006 1005 1978 6457 8413 26')).toBe(false);
  });
});
