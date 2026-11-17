import { describe, expect, it } from 'vitest';
import {
  COMPLIANCE_CHECKS, DEFAULT_RULESET, RESULT_TR, VERDICT_TR, activeRuleSet, complianceScore, ruleApplies, validateComplianceRule,
  type ComplianceRule, type RuleResult,
} from '../src/index.js';

const R = (weight: number, mandatory: boolean, result: RuleResult) => ({ weight, mandatory, result });

describe('complianceScore (R8)', () => {
  it('10/20/30 PASS/FAIL/NOT_APPLICABLE → 33', () => {
    const r = complianceScore([R(10, false, 'PASS'), R(20, false, 'FAIL'), R(30, false, 'NOT_APPLICABLE')]);
    expect(r).toEqual({ score: 33, verdict: 'COMPLIANT', failedMandatory: [] });
  });
  it('2/3 → 67 (yarım yukarı); 1/2 → 50; 1/8 → 13', () => {
    expect(complianceScore([R(2, false, 'PASS'), R(1, false, 'FAIL')]).score).toBe(67);
    expect(complianceScore([R(1, false, 'PASS'), R(1, false, 'FAIL')]).score).toBe(50);
    expect(complianceScore([R(1, false, 'PASS'), R(7, false, 'FAIL')]).score).toBe(13);
  });
  it('zorunlu NO_DATA → Uyumsuz, puan yine hesaplanır', () => {
    const r = complianceScore([R(10, true, 'NO_DATA'), R(30, false, 'PASS')]);
    expect(r).toEqual({ score: 75, verdict: 'NONCOMPLIANT', failedMandatory: [0] });
  });
  it('zorunlu FAIL ve PENDING de Uyumsuz; yüksek puan kurtarmaz', () => {
    const r = complianceScore([R(1, true, 'FAIL'), R(99, false, 'PASS'), R(5, true, 'PENDING')]);
    expect(r.verdict).toBe('NONCOMPLIANT');
    expect(r.failedMandatory).toEqual([0, 2]);
    expect(r.score).toBe(94);
  });
  it('zorunlu uygulanmaz kural hükmü bozmaz', () => {
    expect(complianceScore([R(10, true, 'NOT_APPLICABLE'), R(10, false, 'PASS')]).verdict).toBe('COMPLIANT');
  });
  it('hepsi uygulanmaz ya da boş → puansız NO_RULES', () => {
    expect(complianceScore([R(10, true, 'NOT_APPLICABLE')])).toEqual({ score: null, verdict: 'NO_RULES', failedMandatory: [] });
    expect(complianceScore([])).toEqual({ score: null, verdict: 'NO_RULES', failedMandatory: [] });
  });
  it('belirlenimci: aynı girdi aynı çıktı; Türkçe etiketler', () => {
    const x = [R(7, false, 'PASS'), R(3, true, 'PASS')];
    expect(complianceScore(x)).toEqual(complianceScore([...x]));
    expect(RESULT_TR.PASS).toBe('Karşılandı');
    expect(RESULT_TR.NO_DATA).toBe('Veri yok');
    expect(RESULT_TR.PENDING).toBe('Elle işaret bekliyor');
    expect(VERDICT_TR.NONCOMPLIANT).toBe('Uyumsuz');
    expect(VERDICT_TR.COMPLIANT).toBe('Uyumlu');
    expect(VERDICT_TR.NO_RULES).toBeTruthy();
  });
});

describe('activeRuleSet (R6)', () => {
  const sets = [
    { id: 'a', status: 'PUBLISHED', effectiveFrom: '2026-01-01' },
    { id: 'b', status: 'PUBLISHED', effectiveFrom: '2026-07-01' },
    { id: 'c', status: 'DRAFT', effectiveFrom: '2026-03-01' },
  ];
  it('aynı gün yeni set; bir gün önce eski set', () => {
    expect(activeRuleSet(sets, '2026-07-01')?.id).toBe('b');
    expect(activeRuleSet(sets, '2026-06-30')?.id).toBe('a');
  });
  it('taslak sayılmaz; yürürlükte set yoksa null', () => {
    expect(activeRuleSet(sets, '2026-03-15')?.id).toBe('a');
    expect(activeRuleSet(sets, '2025-12-31')).toBeNull();
    expect(activeRuleSet([sets[2]!], '2026-12-31')).toBeNull();
  });
  it('girdi sırasından bağımsız', () => {
    expect(activeRuleSet([...sets].reverse(), '2026-08-01')?.id).toBe('b');
  });
});

const rule = (o: Partial<ComplianceRule> = {}): ComplianceRule => ({
  code: 'K1', name: 'Kural', description: null, checkType: 'DATA', checkKey: 'MIN_BIDS', params: { minBids: 3 },
  methods: [], amountThreshold: null, currency: null, weight: 10, mandatory: false, ...o,
});

describe('ruleApplies (R7)', () => {
  it('kapsam boşsa her proje', () => {
    expect(ruleApplies(rule(), { method: 'INVITED_BIDS', amount: '10', currency: 'TRY' })).toBe(true);
  });
  it('yöntem kapsamı', () => {
    const r = rule({ methods: ['INVITED_BIDS'] });
    expect(ruleApplies(r, { method: 'INVITED_BIDS', amount: '10', currency: 'TRY' })).toBe(true);
    expect(ruleApplies(r, { method: 'SINGLE_SOURCE', amount: '10', currency: 'TRY' })).toBe(false);
  });
  it('tutar eşiği: eşik ve üstü uygulanır, altı uygulanmaz; para birimi farklıysa uygulanmaz', () => {
    const r = rule({ amountThreshold: '100000.00', currency: 'TRY' });
    expect(ruleApplies(r, { method: 'INVITED_BIDS', amount: '100000.00', currency: 'TRY' })).toBe(true);
    expect(ruleApplies(r, { method: 'INVITED_BIDS', amount: '99999.99', currency: 'TRY' })).toBe(false);
    expect(ruleApplies(r, { method: 'INVITED_BIDS', amount: '500000', currency: 'USD' })).toBe(false);
  });
  it('tutar bilinmiyorsa eşikli kural uygulanır (gizlenmez)', () => {
    expect(ruleApplies(rule({ amountThreshold: '1', currency: 'TRY' }), { method: 'INVITED_BIDS', amount: null, currency: 'TRY' })).toBe(true);
  });
});

describe('COMPLIANCE_CHECKS ve varsayılan set', () => {
  it('13 sabit anahtar; DATA 11, EVIDENCE_AI 2; Türkçe ad', () => {
    const ks = Object.keys(COMPLIANCE_CHECKS);
    expect(ks).toHaveLength(13);
    expect(ks.filter((k) => COMPLIANCE_CHECKS[k as keyof typeof COMPLIANCE_CHECKS].type === 'DATA')).toHaveLength(11);
    for (const k of ks) expect(COMPLIANCE_CHECKS[k as keyof typeof COMPLIANCE_CHECKS].name).toMatch(/\S/);
    expect(COMPLIANCE_CHECKS.MIN_BIDS.defaultParams).toEqual({ minBids: 3 });
    expect(COMPLIANCE_CHECKS.TEMPLATE_SCORE_ABOVE.defaultParams).toEqual({ threshold: '70' });
    expect(COMPLIANCE_CHECKS.WINNER_RISK_CURRENT.defaultParams).toEqual({ maxAgeMonths: 12 });
    expect(COMPLIANCE_CHECKS.WINNER_RISK_LEVEL.defaultParams).toEqual({ maxLevel: 3 });
    expect(COMPLIANCE_CHECKS.CONTRACT_AMOUNT_MATCHES_AWARD.defaultParams).toEqual({ tolerancePercent: '0' });
  });
  it('varsayılan set geçerli, kodlar tekil, her anahtar bir kez, §3.6 elle kural içerir', () => {
    expect(DEFAULT_RULESET.length).toBeGreaterThanOrEqual(13);
    for (const r of DEFAULT_RULESET) expect(validateComplianceRule(r), r.code).toEqual([]);
    expect(new Set(DEFAULT_RULESET.map((r) => r.code)).size).toBe(DEFAULT_RULESET.length);
    for (const k of Object.keys(COMPLIANCE_CHECKS)) expect(DEFAULT_RULESET.some((r) => r.checkKey === k), k).toBe(true);
    expect(DEFAULT_RULESET.some((r) => r.checkType === 'MANUAL')).toBe(true);
    expect(DEFAULT_RULESET.some((r) => r.mandatory)).toBe(true);
  });
});

describe('validateComplianceRule', () => {
  it('geçerli kural boş liste', () => expect(validateComplianceRule(rule())).toEqual([]));
  it('ağırlık 1–100 tam sayı', () => {
    for (const w of [0, 101, 2.5, -1, NaN]) expect(validateComplianceRule(rule({ weight: w })).length, String(w)).toBeGreaterThan(0);
    expect(validateComplianceRule(rule({ weight: 100 }))).toEqual([]);
    expect(validateComplianceRule(rule({ weight: 1 }))).toEqual([]);
  });
  it('anahtar türle uyumlu', () => {
    expect(validateComplianceRule(rule({ checkKey: 'YOK' as never })).length).toBeGreaterThan(0);
    expect(validateComplianceRule(rule({ checkType: 'EVIDENCE_AI', checkKey: 'MIN_BIDS' })).length).toBeGreaterThan(0);
    expect(validateComplianceRule(rule({ checkType: 'DATA', checkKey: 'WINNER_RESEARCH', params: {} })).length).toBeGreaterThan(0);
    expect(validateComplianceRule(rule({ checkType: 'EVIDENCE_AI', checkKey: 'WINNER_RESEARCH', params: {} }))).toEqual([]);
    expect(validateComplianceRule(rule({ checkType: 'DATA', checkKey: null })).length).toBeGreaterThan(0);
    expect(validateComplianceRule(rule({ checkType: 'MANUAL', checkKey: null, params: {} }))).toEqual([]);
    expect(validateComplianceRule(rule({ checkType: 'MANUAL', checkKey: 'MIN_BIDS' })).length).toBeGreaterThan(0);
  });
  it('parametre aralıkları', () => {
    expect(validateComplianceRule(rule({ params: { minBids: 0 } })).length).toBeGreaterThan(0);
    expect(validateComplianceRule(rule({ params: { minBids: 2.5 } })).length).toBeGreaterThan(0);
    expect(validateComplianceRule(rule({ params: { minBids: 21 } })).length).toBeGreaterThan(0);
    expect(validateComplianceRule(rule({ params: {} })).length).toBeGreaterThan(0);
    expect(validateComplianceRule(rule({ params: { minBids: 3, fazla: 1 } })).length).toBeGreaterThan(0);
    expect(validateComplianceRule(rule({ checkKey: 'WINNER_RISK_LEVEL', params: { maxLevel: 6 } })).length).toBeGreaterThan(0);
    expect(validateComplianceRule(rule({ checkKey: 'WINNER_RISK_CURRENT', params: { maxAgeMonths: 0 } })).length).toBeGreaterThan(0);
  });
  it('eşik ve tolerans ondalık string', () => {
    expect(validateComplianceRule(rule({ checkKey: 'TEMPLATE_SCORE_ABOVE', params: { threshold: '70' } }))).toEqual([]);
    expect(validateComplianceRule(rule({ checkKey: 'TEMPLATE_SCORE_ABOVE', params: { threshold: '70.5' } }))).toEqual([]);
    expect(validateComplianceRule(rule({ checkKey: 'TEMPLATE_SCORE_ABOVE', params: { threshold: 'x' } })).length).toBeGreaterThan(0);
    expect(validateComplianceRule(rule({ checkKey: 'TEMPLATE_SCORE_ABOVE', params: { threshold: '101' } })).length).toBeGreaterThan(0);
    expect(validateComplianceRule(rule({ checkKey: 'CONTRACT_AMOUNT_MATCHES_AWARD', params: { tolerancePercent: '-1' } })).length).toBeGreaterThan(0);
  });
  it('kapsam: tutar eşiği ondalık ve para birimi ile birlikte; yöntem bilinen', () => {
    expect(validateComplianceRule(rule({ amountThreshold: 'abc', currency: 'TRY' })).length).toBeGreaterThan(0);
    expect(validateComplianceRule(rule({ amountThreshold: '5', currency: null })).length).toBeGreaterThan(0);
    expect(validateComplianceRule(rule({ amountThreshold: '5', currency: 'TRY' }))).toEqual([]);
    expect(validateComplianceRule(rule({ methods: ['UCUNCU'] })).length).toBeGreaterThan(0);
    expect(validateComplianceRule(rule({ code: ' ' })).length).toBeGreaterThan(0);
  });
});
