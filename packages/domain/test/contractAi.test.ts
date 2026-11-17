import { describe, expect, it } from 'vitest';
import {
  AI_DISCLAIMER, CRITICAL_AI_FIELDS, CONTRACT_AI_FIELDS, FIELD_KIND, REVIEW_CATEGORIES, REVIEW_RUBRIC_VERSION,
  belowThreshold, checkContractExtraction, checkEvidenceOutput, checkReviewOutput, extractionAccuracy, parseTrAmount, parseTrDate, reviewScore,
  type CheckedFinding,
} from '../src/contractAi.ts';
import { can } from '../src/roles.ts';
import { syntheticVkn } from '../src/taxId.ts';

const vkn = syntheticVkn('123456789');
const pages = [
  `SÖZLEŞME\nİşbu sözleşme 1 Ocak 2027 tarihinde imzalanmıştır.\nTedarikçi: Ege Yazılım A.Ş. VKN: ${vkn}`,
  'Toplam bedel 1.250.000,00 TL (KDV hariç) olup bitiş tarihi 31 Aralık 2028 dir.',
  '', // taranmış sayfa: metin katmanı yok
];
const f = (name: string, value: unknown, page: number, evidence: string, confidence = 0.95) => ({ name, value, page, evidence, confidence });
const get = (r: ReturnType<typeof checkContractExtraction>, name: string) => r.fields.find((x) => x.field === name)!;

describe('tr-TR ayrıştırıcılar', () => {
  it('tarih', () => {
    expect(parseTrDate('31 Aralık 2028')).toBe('2028-12-31');
    expect(parseTrDate('31.12.2028')).toBe('2028-12-31');
    expect(parseTrDate('1 ocak 2027')).toBe('2027-01-01');
    expect(parseTrDate('2028-12-31')).toBe('2028-12-31');
    expect(parseTrDate('31.02.2028')).toBeNull();
    expect(parseTrDate('yarın')).toBeNull();
  });
  it('tutar', () => {
    expect(parseTrAmount('1.250.000,00 TL')).toBe('1250000.00');
    expect(parseTrAmount('1.250.000 TL')).toBe('1250000.00');
    expect(parseTrAmount('1250000.00')).toBe('1250000.00');
    expect(parseTrAmount('₺ 950,5')).toBe('950.50');
    expect(parseTrAmount('abc')).toBeNull();
    expect(parseTrAmount('-5,00')).toBeNull();
  });
});

describe('Faz 4 düzeltme turu 1', () => {
  const p = ['Sözleşme otomatik olarak yenilenmez. KDV hariç bedel. Süresiz değildir. Hizmet alımı. Teknik destek ve bakım. Bedel USD cinsindendir.'];
  it('bool/enum değeri alıntıyla çelişirse UNDERIVABLE: LOW, önceden doldurulmaz', () => {
    const r = checkContractExtraction({ fields: [f('autoRenewal', true, 1, 'Sözleşme otomatik olarak yenilenmez.')] }, p);
    expect(get(r, 'autoRenewal')).toMatchObject({ confidence: 'LOW', requiresHuman: true, prefill: false });
    expect(get(r, 'autoRenewal').flags).toContain('UNDERIVABLE');
    const ok = checkContractExtraction({ fields: [f('autoRenewal', false, 1, 'Sözleşme otomatik olarak yenilenmez.')] }, p);
    expect(get(ok, 'autoRenewal')).toMatchObject({ value: 'false', confidence: 'HIGH', prefill: false, requiresHuman: true });
  });
  it('limitBasis ve contractType anahtar sözcükle doğrulanır', () => {
    const r = checkContractExtraction({ fields: [f('limitBasis', 'GROSS', 1, 'KDV hariç bedel.'), f('contractType', 'MAINTENANCE', 1, 'Teknik destek ve bakım.'), f('contractType', 'OTHER', 1, 'Hizmet alımı.')] }, p);
    expect(get(r, 'limitBasis').flags).toContain('UNDERIVABLE');
    expect(get(r, 'contractType')).toMatchObject({ value: 'MAINTENANCE', prefill: false, requiresHuman: true });
    const n = checkContractExtraction({ fields: [f('limitBasis', 'NET', 1, 'KDV hariç bedel.')] }, p);
    expect(get(n, 'limitBasis')).toMatchObject({ value: 'NET', prefill: false, requiresHuman: true });
  });
  it('ISO para birimi alıntıda aynen geçerse kabul', () => {
    const r = checkContractExtraction({ fields: [f('currency', 'usd', 1, 'Bedel USD cinsindendir.'), f('currency', 'CHF', 1, 'Bedel USD cinsindendir.')] }, p);
    expect(get(r, 'currency').value).toBe('USD');
    const c = checkContractExtraction({ fields: [f('currency', 'CHF', 1, 'Bedel CHF cinsindendir.')] }, ['Bedel CHF cinsindendir.']);
    expect(get(c, 'currency')).toMatchObject({ value: 'CHF', requiresHuman: true, prefill: false });
  });
  it('olumsuz kalıplar UNDERIVABLE: yenilenmeyecektir, yenilenmemektedir, KDV dahil değildir, süresiz değildir', () => {
    const cases: [string, unknown, string][] = [
      ['autoRenewal', true, 'Sözleşme otomatik yenilenmeyecektir.'],
      ['autoRenewal', true, 'Sözleşme otomatik olarak yenilenmemektedir.'],
      ['autoRenewal', false, 'Sözleşme otomatik olarak yenilenmemektedir.'],
      ['limitBasis', 'GROSS', 'Bedele KDV dahil değildir.'],
      ['indefinite', true, 'Sözleşme süresiz değildir.'],
      ['indefinite', false, 'Sözleşme süresiz değildir.'],
    ];
    for (const [name, v, q] of cases) {
      const r = checkContractExtraction({ fields: [f(name, v, 1, q)] }, [q]);
      expect(get(r, name), q).toMatchObject({ confidence: 'LOW', prefill: false, requiresHuman: true });
      expect(get(r, name).flags, q).toContain('UNDERIVABLE');
    }
    const net = checkContractExtraction({ fields: [f('limitBasis', 'NET', 1, 'Bedele KDV dahil değildir.')] }, ['Bedele KDV dahil değildir.']);
    expect(get(net, 'limitBasis')).toMatchObject({ value: 'NET', confidence: 'HIGH', prefill: false, requiresHuman: true });
  });
  it('kısa alıntı değeri içeriyorsa (tutar/tarih/tam sayı) kabul', () => {
    const a = checkContractExtraction({ fields: [f('amount', '5000.00', 1, '5.000 TL'), f('noticePeriodDays', '30', 1, '30 gün')] }, ['Ceza 5.000 TL, ihbar 30 gün.']);
    expect(get(a, 'amount').value).toBe('5000.00');
    expect(get(a, 'noticePeriodDays').value).toBe('30');
  });
  it('kısa alıntı doğrulanmaz', () => {
    const r = checkContractExtraction({ fields: [f('title', 'SÖZ', 1, 'SÖZ')] }, ['SÖZ']);
    expect(get(r, 'title')).toMatchObject({ value: null, confidence: 'MISSING' });
    expect(get(r, 'title').flags).toContain('SHORT_QUOTE');
  });
  it('belirsiz tutar biçimleri null', () => {
    expect(parseTrAmount('1,250')).toBeNull();
    expect(parseTrAmount('1250.000')).toBeNull();
    expect(parseTrAmount('12.345,678')).toBeNull();
    expect(parseTrAmount('1,250,000')).toBe('1250000.00');
    expect(parseTrAmount('1,250.50')).toBe('1250.50');
    expect(parseTrAmount('1250,5')).toBe('1250.50');
  });
  it('tarih deseninde sol sınır: 131.12.2028 içinden tarih çıkmaz', () => {
    const r = checkContractExtraction({ fields: [f('endDate', '2028-12-31', 1, 'Bitiş no 131.12.2028 tarihli')] }, ['Bitiş no 131.12.2028 tarihli']);
    expect(get(r, 'endDate').value).toBeNull();
  });
  it('kanıt cevabında kısa alıntı UNCLEAR, fazla anahtar işaretli', () => {
    const r = checkEvidenceOutput({ answers: [{ questionId: 'q1', answer: 'YES', quote: 'Ege', page: 1, extra: 1 }] }, pages, ['q1']);
    expect(r.answers[0]).toMatchObject({ answer: 'UNCLEAR' });
    expect(r.answers[0]!.flags).toContain('SHORT_QUOTE');
    expect(r.flags).toContain('IGNORED_KEY:extra');
  });
});

describe('checkContractExtraction (R4/R5)', () => {
  it('kanıtla doğrulanan tutar HIGH, yine de kritik: insan şart, önceden doldurulmaz', () => {
    const r = checkContractExtraction({ fields: [f('amount', '1250000.00', 2, 'Toplam bedel 1.250.000,00 TL (KDV hariç)')] }, pages);
    expect(get(r, 'amount')).toMatchObject({ value: '1250000.00', page: 2, confidence: 'HIGH', requiresHuman: true, prefill: false });
    expect(r.fields).toHaveLength(CONTRACT_AI_FIELDS.length);
  });
  it('kanıt sayfada yok → NULL + MISSING', () => {
    const r = checkContractExtraction({ fields: [f('amount', '1250000.00', 1, 'Toplam bedel 1.250.000,00 TL')] }, pages);
    expect(get(r, 'amount')).toMatchObject({ value: null, confidence: 'MISSING', prefill: false });
    expect(get(r, 'amount').flags).toContain('MISSING');
    expect(get(r, 'signedOn')).toMatchObject({ value: null, confidence: 'MISSING' });
  });
  it('değer kanıttan türetilemiyorsa NULL', () => {
    const r = checkContractExtraction({ fields: [f('amount', '999.00', 2, 'Toplam bedel 1.250.000,00 TL')] }, pages);
    expect(get(r, 'amount')).toMatchObject({ value: null, confidence: 'MISSING' });
    expect(get(r, 'amount').flags).toContain('VALUE_NOT_IN_SOURCE');
  });
  it('taranmış sayfa → LOW + UNVERIFIED_SCAN, önceden doldurulmaz', () => {
    const r = checkContractExtraction({ fields: [f('guarantee', 'Teminat mektubu', 3, 'Teminat mektubu'), f('endDate', '31.12.2028', 3, '31 Aralık 2028')] }, pages);
    expect(get(r, 'guarantee')).toMatchObject({ confidence: 'LOW', prefill: false });
    expect(get(r, 'guarantee').flags).toContain('UNVERIFIED_SCAN');
    expect(get(r, 'endDate')).toMatchObject({ value: '2028-12-31', confidence: 'LOW', requiresHuman: true, prefill: false });
  });
  it('kritik olmayan MEDIUM önceden doldurulur; düşük beyan LOW boş kalır', () => {
    const r = checkContractExtraction({ fields: [
      f('supplierName', 'Ege Yazılım A.Ş.', 1, 'Tedarikçi: Ege Yazılım A.Ş.', 0.7),
      f('title', 'SÖZLEŞME', 1, 'SÖZLEŞME', 0.3),
    ] }, pages);
    expect(get(r, 'supplierName')).toMatchObject({ confidence: 'MEDIUM', requiresHuman: false, prefill: true });
    expect(get(r, 'title')).toMatchObject({ confidence: 'LOW', prefill: false, requiresHuman: true });
  });
  it('tarih normalleşir, güven eşikleri', () => {
    const r = checkContractExtraction({ fields: [f('endDate', '31 Aralık 2028', 2, 'bitiş tarihi 31 Aralık 2028', 0.85), f('signedOn', '2027-01-01', 1, 'imzalanmıştır', 0.9)] }, pages);
    expect(get(r, 'endDate')).toMatchObject({ value: '2028-12-31', confidence: 'HIGH', prefill: false });
    expect(get(r, 'signedOn').value).toBeNull(); // kanıtta tarih yok
  });
  it('hatalı VKN NULL; geçerli VKN kanıttan doğrulanır', () => {
    const wrong = vkn.slice(0, 9) + String((Number(vkn[9]) + 1) % 10);
    const bad = checkContractExtraction({ fields: [f('supplierVkn', wrong, 1, `VKN: ${wrong}`)] }, [`VKN: ${wrong}`]);
    expect(get(bad, 'supplierVkn')).toMatchObject({ value: null });
    const ok = checkContractExtraction({ fields: [f('supplierVkn', vkn, 1, `VKN: ${vkn}`)] }, pages);
    expect(get(ok, 'supplierVkn')).toMatchObject({ value: vkn, confidence: 'HIGH', requiresHuman: true, prefill: false });
  });
  it('izinsiz anahtar ve bilinmeyen alan yok sayılıp işaretlenir', () => {
    const r = checkContractExtraction({ approve: true, actions: ['pay'], fields: [{ ...f('title', 'SÖZLEŞME', 1, 'SÖZLEŞME'), approve: true }, f('bankIban', 'TR00', 1, 'x')] }, pages);
    expect(r.flags).toEqual(expect.arrayContaining(['IGNORED_KEY:approve', 'IGNORED_KEY:actions', 'IGNORED_FIELD:bankIban']));
    expect(get(r, 'title').value).toBe('SÖZLEŞME');
    expect(r.fields.map((x) => x.field)).not.toContain('bankIban');
  });
  it('sabitler', () => {
    expect([...CRITICAL_AI_FIELDS].sort()).toEqual(['amount', 'currency', 'endDate', 'signedOn', 'startDate', 'supplierVkn']);
    expect(FIELD_KIND.amount).toBe('money');
    expect(CONTRACT_AI_FIELDS).toHaveLength(20);
  });
  it('çöp girdi çökmez', () => {
    expect(checkContractExtraction(null, pages).fields.every((x) => x.value === null)).toBe(true);
  });
});

const tpl = 'Madde 7 Sorumluluk sınırı sözleşme bedeliyle sınırlıdır. Madde 9 Mücbir sebep halleri.';
const fnd = (o: Record<string, unknown> = {}) => ({ category: 'TEMPLATE', kind: 'MODIFIED_CLAUSE', severity: 'HIGH', title: 't', quote: 'Toplam bedel 1.250.000,00 TL', page: 2, templateRef: 'Madde 3', recommendation: 'r', ...o });
describe('checkReviewOutput ve reviewScore (R7/R8)', () => {
  it('model puanı/kararı yok sayılır; alıntı sayfada doğrulanır', () => {
    const r = checkReviewOutput({ score: 99, approve: true, summary: 'Genel yorum.', findings: [{ ...fnd(), score: 1 }] }, pages, tpl);
    expect(r.flags).toEqual(expect.arrayContaining(['IGNORED_KEY:score', 'IGNORED_KEY:approve']));
    expect(r.summary).toBe('Genel yorum.');
    expect(r.findings[0]).toMatchObject({ verified: true, category: 'TEMPLATE', severity: 'HIGH' });
  });
  it('MISSING_CLAUSE alıntısı şablon metninden doğrulanır; sözleşme sayfasında aranmaz', () => {
    const ok = checkReviewOutput({ findings: [fnd({ kind: 'MISSING_CLAUSE', quote: 'Sorumluluk sınırı sözleşme bedeliyle sınırlıdır', page: null })] }, pages, tpl);
    expect(ok.findings[0]!.verified).toBe(true);
    const bad = checkReviewOutput({ findings: [fnd({ kind: 'MISSING_CLAUSE', quote: 'Uydurma madde', page: null })] }, pages, tpl);
    expect(bad.findings[0]!.verified).toBe(false);
    const noTpl = checkReviewOutput({ findings: [fnd({ kind: 'MISSING_CLAUSE', quote: 'Madde 7', page: null })] }, pages, null);
    expect(noTpl.findings[0]!.verified).toBe(false);
  });
  it('bulunmayan alıntı ya da taranmış sayfa doğrulanmaz', () => {
    const r = checkReviewOutput({ findings: [fnd({ quote: 'olmayan metin' }), fnd({ page: 3, quote: 'x' }), fnd({ page: 9 })] }, pages, tpl);
    expect(r.findings.map((x) => x.verified)).toEqual([false, false, false]);
  });
  it('geçersiz kategori düşürülür; geçersiz tür/önem verified=false INVALID_FORMAT ile kalır, puana girmez', () => {
    const r = checkReviewOutput({ findings: [fnd({ category: 'NOPE' }), fnd({ severity: 'CRITICAL' }), fnd({ kind: 'X' })] }, pages, tpl);
    expect(r.findings).toHaveLength(2);
    expect(r.findings.every((x) => !x.verified && x.flags.includes('INVALID_FORMAT'))).toBe(true);
    expect(r.flags).toContain('DROPPED_FINDING:category');
    expect(reviewScore(r.findings, true).score).toBe(100);
  });
  it('kısa alıntı (<8 karakter) doğrulanmaz', () => {
    const r = checkReviewOutput({ findings: [fnd({ quote: 'bedel', page: 2 }), fnd({ kind: 'MISSING_CLAUSE', quote: 'Madde 7', page: null })] }, pages, tpl);
    expect(r.findings.map((x) => x.verified)).toEqual([false, false]);
    expect(r.findings[0]!.flags).toContain('SHORT_QUOTE');
  });
  const mk = (category: string, severity: string, verified = true): CheckedFinding => ({ category, kind: 'UNFAVORABLE', severity, title: '', quote: '', page: 1, templateRef: null, recommendation: null, verified, flags: [] }) as CheckedFinding;
  it('bulgusuz 100; sürüm sabiti', () => {
    expect(reviewScore([], true).score).toBe(100);
    expect(reviewScore([], false).score).toBe(100);
    expect(REVIEW_RUBRIC_VERSION).toBe('inceleme-puan-2026-v1');
    expect(REVIEW_CATEGORIES).toHaveLength(11);
  });
  it('1 HIGH TEMPLATE + 1 MEDIUM PAYMENT → 65/85, toplam 85', () => {
    const r = reviewScore([mk('TEMPLATE', 'HIGH'), mk('PAYMENT', 'MEDIUM')], true);
    expect(r.subScores.TEMPLATE).toBe(65);
    expect(r.subScores.PAYMENT).toBe(85);
    expect(r.subScores.LIABILITY).toBe(100);
    expect(r.score).toBe(85);
  });
  it('şablonsuz: TEMPLATE null, toplam hukuk ortalaması', () => {
    const r = reviewScore([mk('TEMPLATE', 'HIGH'), mk('PAYMENT', 'MEDIUM')], false);
    expect(r.subScores.TEMPLATE).toBeNull();
    expect(r.score).toBe(99); // (900+85)/10=98.5 → 99
  });
  it('doğrulanmamış bulgu puana girmez; taban 0; INFO ceza yok', () => {
    expect(reviewScore([mk('TEMPLATE', 'HIGH', false)], true).score).toBe(100);
    expect(reviewScore([mk('IP', 'HIGH'), mk('IP', 'HIGH'), mk('IP', 'HIGH')], true).subScores.IP).toBe(0);
    expect(reviewScore([mk('IP', 'INFO')], true).score).toBe(100);
  });
  it('belowThreshold ve uyarı metni', () => {
    expect(belowThreshold(59, 60)).toBe(true);
    expect(belowThreshold(60, 60)).toBe(false);
    expect(AI_DISCLAIMER).toBe('Yapay zekâ ön incelemesidir, hukuki görüş değildir.');
  });
});

describe('checkEvidenceOutput (R14)', () => {
  it('doğrulanmayan alıntı UNCLEAR\'a düşer; eksik soru UNCLEAR', () => {
    const r = checkEvidenceOutput({ answers: [
      { questionId: 'q1', answer: 'YES', quote: 'Tedarikçi: Ege Yazılım A.Ş.', page: 1, explanation: 'e' },
      { questionId: 'q2', answer: 'NO', quote: 'uydurma metin', page: 1, explanation: 'e' },
      { questionId: 'zz', answer: 'YES', quote: 'x', page: 1, explanation: '' },
    ], approve: true }, pages, ['q1', 'q2', 'q3']);
    expect(r.answers.map((a) => [a.questionId, a.answer])).toEqual([['q1', 'YES'], ['q2', 'UNCLEAR'], ['q3', 'UNCLEAR']]);
    expect(r.flags).toEqual(expect.arrayContaining(['IGNORED_KEY:approve', 'IGNORED_ANSWER']));
    // Final inceleme M3: model kaynaklı soru kimliği işarete yazılmaz.
    expect(r.flags.join(' ')).not.toContain('zz');
    expect(r.answers[1]!.flags).toContain('SOURCE_NOT_FOUND');
  });
});

describe('extractionAccuracy (R13)', () => {
  it('alan ve kritik doğruluk', () => {
    const r = extractionAccuracy(
      { amount: '1250000.00', endDate: '2028-12-31', title: 'A', guarantee: null },
      { amount: '1250000.00', endDate: '2028-12-30', title: 'A', guarantee: null },
    );
    expect(r.perField).toEqual({ amount: true, endDate: false, title: true, guarantee: true });
    expect(r.overall).toBe(0.75);
    expect(r.critical).toBe(0.5);
  });
});

describe('izinler (R15)', () => {
  it('contract.ai.request ve contract.review.read', () => {
    expect(can(['PROCUREMENT'], 'contract.ai.request')).toBe(true);
    expect(can(['DEPARTMENT_USER'], 'contract.ai.request')).toBe(true);
    expect(can(['ADMIN'], 'contract.ai.request')).toBe(false);
    expect(can(['AUDITOR'], 'contract.ai.request')).toBe(false);
    for (const r of ['ADMIN', 'PROCUREMENT', 'DEPARTMENT_USER', 'AUDITOR'] as const) expect(can([r], 'contract.review.read')).toBe(true);
  });
});
