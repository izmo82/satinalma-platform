import { describe, expect, it } from 'vitest';
import { supplierOptionLabels, type SupplierOptionInput } from '../src/supplierOption.ts';

const s = (id: string, legalName: string, status: string, taxId: string | null, identityReviewRequired = false): SupplierOptionInput =>
  ({ id, legalName, status, taxIdType: taxId ? 'VKN' : null, taxId, identityReviewRequired });

describe('tedarikçi seçim etiketi', () => {
  it('aktif ve adı tek olan tedarikçi yalnız ünvanla görünür (mevcut etiket değişmez)', () => {
    expect(supplierOptionLabels([s('a', 'Anadolu Bilişim A.Ş.', 'ACTIVE', '1234567890')]).get('a')).toBe('Anadolu Bilişim A.Ş.');
  });

  it('aynı adlı kimliği doğrulanmamış aday aktif firmadan ayrılır; aktif firmanın etiketi korunur', () => {
    const m = supplierOptionLabels([
      s('a', 'Anadolu Bilişim A.Ş.', 'ACTIVE', '1234567890'),
      s('b', 'Anadolu Bilişim A.Ş.', 'CANDIDATE', null, true),
    ]);
    expect(m.get('a')).toBe('Anadolu Bilişim A.Ş.');
    expect(m.get('b')).toBe('Anadolu Bilişim A.Ş. · Aday, vergi kimliği doğrulanmadı');
  });

  it('kimliği belli iki aynı adlı kayıt vergi kimliğinin son 4 hanesiyle ayrılır; büyük/küçük harf ve boşluk farkı aynı ad sayılır', () => {
    const m = supplierOptionLabels([
      s('a', 'Ege Yazılım', 'ACTIVE', '1111111111'),
      s('b', ' ege  YAZILIM', 'CANDIDATE', '2222222222'),
    ]);
    expect(m.get('a')).toBe('Ege Yazılım · VKN …1111');
    expect(m.get('b')).toBe(' ege  YAZILIM · Aday, VKN …2222');
    expect(new Set(m.values()).size).toBe(2);
  });

  it('koşullu ve tek adlı aday durumuyla etiketlenir; tam vergi kimliği etikette yer almaz', () => {
    const m = supplierOptionLabels([s('a', 'Kuzey', 'CANDIDATE', '9300000003'), s('b', 'Güney', 'CONDITIONAL', '9300000004')]);
    expect(m.get('a')).toBe('Kuzey · Aday');
    expect(m.get('b')).toBe('Güney · Koşullu');
    expect([...m.values()].join()).not.toContain('9300000003');
  });

  it('kimliği belirsiz iki aynı adlı aday kayıt anıyla ayrılır (İstanbul saati)', () => {
    const m = supplierOptionLabels([
      { ...s('a', 'Kimliği belirsiz satıcı', 'CANDIDATE', null, true), createdAt: '2026-11-08T09:15:00Z' },
      { ...s('b', 'Kimliği belirsiz satıcı', 'CANDIDATE', null, true), createdAt: '2026-11-08T11:40:00Z' },
    ]);
    expect(m.get('a')).toBe('Kimliği belirsiz satıcı · Aday, vergi kimliği doğrulanmadı, kayıt 08.11.2026 12:15');
    expect(m.get('b')).toBe('Kimliği belirsiz satıcı · Aday, vergi kimliği doğrulanmadı, kayıt 08.11.2026 14:40');
  });

  it('aynı dakikada açılan kimliği belirsiz iki aday da ayrı etiket alır; ilk kaydın etiketi değişmez', () => {
    const t = '2026-11-08T09:15:10Z';
    const m = supplierOptionLabels([
      { ...s('a', 'X', 'CANDIDATE', null, true), createdAt: t },
      { ...s('b', 'X', 'CANDIDATE', null, true), createdAt: '2026-11-08T09:15:40Z' },
      { ...s('c', 'X', 'CANDIDATE', null, true), createdAt: t },
    ]);
    expect(m.get('a')).toBe('X · Aday, vergi kimliği doğrulanmadı, kayıt 08.11.2026 12:15');
    expect(m.get('b')).toBe('X · Aday, vergi kimliği doğrulanmadı, kayıt 08.11.2026 12:15 #2');
    expect(m.get('c')).toBe('X · Aday, vergi kimliği doğrulanmadı, kayıt 08.11.2026 12:15 #3');
  });

  it('son 4 hanesi aynı iki doğrulanmış aynı adlı kayıt da ayrılır', () => {
    const m = supplierOptionLabels([s('a', 'Y', 'ACTIVE', '1111110000'), s('b', 'Y', 'ACTIVE', '2222220000')]);
    expect(new Set(m.values()).size).toBe(2);
  });
});
