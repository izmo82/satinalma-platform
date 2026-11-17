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
  it('geçersiz kategori/tür/önem düşürülür ve işaretlenir', () => {
    const r = checkReviewOutput({ findings: [fnd({ category: 'NOPE' }), fnd({ severity: 'CRITICAL' })] }, pages, tpl);
    expect(r.findings).toHaveLength(0);
    expect(r.flags.filter((x) => x.startsWith('DROPPED_FINDING'))).toHaveLength(2);
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
      { questionId: 'q2', answer: 'NO', quote: 'uydurma', page: 1, explanation: 'e' },
      { questionId: 'zz', answer: 'YES', quote: 'x', page: 1, explanation: '' },
    ], approve: true }, pages, ['q1', 'q2', 'q3']);
    expect(r.answers.map((a) => [a.questionId, a.answer])).toEqual([['q1', 'YES'], ['q2', 'UNCLEAR'], ['q3', 'UNCLEAR']]);
    expect(r.flags).toEqual(expect.arrayContaining(['IGNORED_KEY:approve', 'IGNORED_ANSWER:zz']));
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
