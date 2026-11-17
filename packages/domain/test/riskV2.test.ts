import { describe, expect, it } from 'vitest';
import {
  RISK_CRITERIA, RISK_CRITERIA_LEVELS, RISK_CRITERIA_TR, RISK_LEVEL_TR, RISK_MATRIX, RISK_METHOD_VERSION,
  changedFields, completionBlockers, criticality, excelRiskToScore, normalizeSupplierName, procedureAcceptable,
  quarterStart, riskBand, riskLevel, riskPeriod, riskScore, scoreToExcelFraction, can,
  type CriteriaValues, type MatrixColumn,
} from '../src/index.js';

const cv = (a: number[]): CriteriaValues => Object.fromEntries(RISK_CRITERIA.map((k, i) => [k, a[i]])) as CriteriaValues;

// [Excel satır, ölçütler, I önbelleği, J (kesir), sütun, seviye]
const ROWS: [number, number[], number, number, MatrixColumn, number][] = [
  [5, [3, 5, 1, 3, 5, 5], 3.224968079727227, 0.15, 3, 2],
  [7, [1, 3, 3, 3, 1, 3], 2.080083823051904, 0.18, 2, 1],
  [9, [5, 3, 5, 5, 3, 5], 4.2171633265087465, 0.24, 4, 3],
  [16, [3, 3, 3, 5, 3, 3], 3.266600666361009, 0.62, 3, 3],
  [17, [5, 5, 5, 5, 5, 5], 5, 0.2, 5, 3],
  [19, [1, 3, 1, 1, 1, 3], 1.4422495703074083, 0.24, 1, 1],
  [26, [5, 5, 3, 3, 5, 3], 3.8729833462074166, 0.2, 4, 2],
  [54, [5, 5, 5, 3, 5, 5], 4.591929510842227, 0.48, 5, 4],
  [56, [3, 3, 3, 3, 1, 3], 2.498049532966813, 0.08, 2, 1],
  [100, [3, 1, 3, 3, 5, 3], 2.7200434229973993, 0.65, 3, 3],
];

describe('riskV2 › Excel örnekleri', () => {
  for (const [row, crit, cache, j, col, lvl] of ROWS) {
    it(`Excel satır ${row}`, () => {
      const c = criticality(cv(crit));
      expect(Math.abs(Number(c.value) - cache)).toBeLessThan(1e-4);
      expect(c.column).toBe(col);
      const score = excelRiskToScore(j, true);
      expect(riskLevel(score, c.column).level).toBe(lvl);
    });
  }
  it('GEOMEAN 3,5,1,3,5,5 → "3,22"; saklanan değer 4 hane', () => {
    const c = criticality(cv([3, 5, 1, 3, 5, 5]));
    expect(c.display).toBe('3,22');
    expect(c.value).toBe('3.2250');
  });
  it('satır 54: 4,59 beşe yuvarlanır; satır 56: 2,498 ikiye', () => {
    expect(criticality(cv([5, 5, 5, 3, 5, 5])).column).toBe(5);
    expect(criticality(cv([3, 3, 3, 3, 1, 3])).column).toBe(2);
  });
  it('1/3/5 dışı değer hata verir', () => {
    expect(() => criticality(cv([2, 3, 3, 3, 3, 3]))).toThrow();
  });
  it('ölçüt başlıkları ve açıklamaları eksiksiz', () => {
    for (const k of RISK_CRITERIA) {
      expect(RISK_CRITERIA_TR[k]).toBeTruthy();
      expect(Object.keys(RISK_CRITERIA_LEVELS[k])).toEqual(['1', '3', '5']);
    }
    expect(RISK_METHOD_VERSION).toBe('khc-it-2100-002-r009/v1');
  });
});

describe('riskV2 › matris ve bantlar', () => {
  it('bant sınırları üst dahil', () => {
    expect(riskBand('0')).toBe(1);
    expect(riskBand('20')).toBe(1);
    expect(riskBand('20.01')).toBe(2);
    expect(riskBand('40')).toBe(2);
    expect(riskBand('60')).toBe(3);
    expect(riskBand('80')).toBe(4);
    expect(riskBand('80.01')).toBe(5);
    expect(riskBand('100')).toBe(5);
    expect(() => riskBand('100.01')).toThrow();
    expect(() => riskBand('-1')).toThrow();
  });
  it('matris analiz §3.4 ile birebir', () => {
    expect(RISK_MATRIX[4]).toEqual([3, 3, 4, 5, 5]);
    expect(RISK_MATRIX[3]).toEqual([2, 3, 3, 4, 5]);
    expect(RISK_MATRIX[2]).toEqual([2, 2, 3, 3, 4]);
    expect(RISK_MATRIX[1]).toEqual([1, 2, 2, 3, 3]);
    expect(RISK_MATRIX[0]).toEqual([1, 1, 2, 2, 3]);
  });
  it('procedureAcceptable seviye 1 ile 0..100 (0,5 adım) × 5 sütunda eşdeğer', () => {
    for (let i = 0; i <= 200; i++) {
      const score = (i / 2).toFixed(2);
      for (const col of [1, 2, 3, 4, 5] as const) {
        expect(procedureAcceptable(score, col), `${score}/${col}`).toBe(riskLevel(score, col).level === 1);
      }
    }
  });
  it('seviye etiketleri', () => {
    expect(RISK_LEVEL_TR[1]).toBe('Seviye 1 — Kabul edilebilir');
    expect(RISK_LEVEL_TR[4]).toBe('Seviye 4 — Turuncu');
    expect(RISK_LEVEL_TR[5]).toBe('Seviye 5 — Kırmızı');
  });
});

describe('riskV2 › riskScore', () => {
  const qs = [
    { id: 'a', code: 'Q1', weight: '3', riskAnswer: 'YES' as const },
    { id: 'b', code: 'Q2', weight: '2', riskAnswer: 'YES' as const },
    { id: 'c', code: 'Q3', weight: '5', riskAnswer: 'YES' as const },
  ];
  it('ağırlık 3/2/5, cevap E/H/E → 80.00', () => {
    expect(riskScore(qs, { a: 'YES', b: 'NO', c: 'YES' })).toEqual({ score: '80.00', missing: [] });
  });
  it('riskAnswer NO tersine çevirir', () => {
    const r = qs.map((q) => ({ ...q, riskAnswer: 'NO' as const }));
    expect(riskScore(r, { a: 'YES', b: 'NO', c: 'YES' }).score).toBe('20.00');
  });
  it('eksik cevap → score null ve missing', () => {
    expect(riskScore(qs, { a: 'YES' })).toEqual({ score: null, missing: ['b', 'c'] });
  });
  it('2 hane yarım yukarı, ondalıklı ağırlık', () => {
    const r = [{ id: 'x', code: 'X', weight: '1', riskAnswer: 'YES' as const }, { id: 'y', code: 'Y', weight: '2.5', riskAnswer: 'YES' as const }];
    expect(riskScore(r, { x: 'YES', y: 'NO' }).score).toBe('28.57');
    expect(riskScore(r, { x: 'NO', y: 'NO' }).score).toBe('0.00');
    expect(riskScore(r, { x: 'YES', y: 'YES' }).score).toBe('100.00');
  });
});

describe('riskV2 › completionBlockers', () => {
  const full = cv([5, 5, 5, 3, 5, 5]);
  const base = { criteria: full, score: '48.00', level: 4, today: '2026-11-17' };
  const ok = { ownerUserId: 'u1', dueOn: '2026-12-31', status: 'OPEN' };
  const codes = (x: { code: string }[]) => x.map((b) => b.code);
  it('seviye 4 aksiyonsuz → action_plan_required', () => {
    expect(codes(completionBlockers({ ...base, actions: [] }))).toContain('action_plan_required');
  });
  it('yalnız MITIGATION → control_required', () => {
    const r = completionBlockers({ ...base, actions: [{ kind: 'MITIGATION', ...ok }] });
    expect(codes(r)).toEqual(['control_required']);
  });
  it('sahipsiz / tarihsiz / geçmiş tarihli satır', () => {
    const r = completionBlockers({ ...base, actions: [
      { kind: 'MITIGATION', ownerUserId: null, dueOn: '2026-12-31', status: 'OPEN' },
      { kind: 'CONTROL', ownerUserId: 'u', dueOn: null, status: 'OPEN' },
      { kind: 'CONTROL', ownerUserId: 'u', dueOn: '2026-11-17', status: 'OPEN' },
    ] });
    expect(codes(r)).toEqual(['action_owner_required', 'action_due_required', 'action_due_past']);
  });
  it('tam plan → []; seviye 3 → []', () => {
    expect(completionBlockers({ ...base, level: 5, actions: [{ kind: 'MITIGATION', ...ok }, { kind: 'CONTROL', ...ok }] })).toEqual([]);
    expect(completionBlockers({ ...base, level: 3, actions: [] })).toEqual([]);
  });
  it('eksik ölçüt ve skor', () => {
    const r = completionBlockers({ criteria: { businessImpact: 1 }, score: null, level: null, actions: [], today: '2026-11-17' });
    expect(codes(r)).toEqual(['criteria_missing', 'score_missing']);
  });
});

describe('riskV2 › yardımcılar', () => {
  it('riskPeriod / quarterStart', () => {
    expect(riskPeriod('2026-11-17')).toBe('2026-4');
    expect(riskPeriod('2026-01-01')).toBe('2026-1');
    expect(riskPeriod('2026-03-31')).toBe('2026-1');
    expect(riskPeriod('2026-04-01')).toBe('2026-2');
    expect(riskPeriod('2026-09-30')).toBe('2026-3');
    expect(quarterStart('2026-4')).toBe('2026-10-01');
    expect(quarterStart('2026-1')).toBe('2026-01-01');
    expect(() => quarterStart('2026-5')).toThrow();
  });
  it('changedFields', () => {
    expect(changedFields({ a: 1, b: 'x', c: null }, { a: 1, b: 'y', d: 3 })).toEqual(['b', 'd']);
    expect(changedFields(null, { a: 1 })).toEqual(['a']);
    expect(changedFields({ a: undefined }, { a: null })).toEqual([]);
  });
  it('excelRiskToScore / scoreToExcelFraction: kayan nokta hatası yok, gidiş-dönüş', () => {
    expect(excelRiskToScore(0.15, true)).toBe('15.00');
    expect(excelRiskToScore(0.29, true)).toBe('29.00');
    expect(excelRiskToScore(0.07, true)).toBe('7.00');
    expect(excelRiskToScore(65, false)).toBe('65.00');
    for (let i = 0; i <= 100; i++) {
      const f = i / 100;
      expect(scoreToExcelFraction(excelRiskToScore(f, true))).toBe(f);
    }
  });
  it('normalizeSupplierName', () => {
    expect(normalizeSupplierName('Koç Sistem A.S.')).toBe(normalizeSupplierName('KOÇ SİSTEM A.Ş.'));
    expect(normalizeSupplierName('Örnek Yazılım Ltd. Şti.')).toBe(normalizeSupplierName('ÖRNEK YAZILIM LTD ŞTİ'));
    expect(normalizeSupplierName('Atlas Bilişim')).toBe('atlas bilişim');
    expect(normalizeSupplierName('Atlas Bilişim A.Ş.')).toBe('atlas bilişim');
  });
});

describe('riskV2 › izinler', () => {
  it('rol dağılımı', () => {
    const want: Record<string, string[]> = {
      'risk.read': ['ADMIN', 'PROCUREMENT', 'DEPARTMENT_USER', 'AUDITOR'],
      'risk.assess': ['PROCUREMENT', 'DEPARTMENT_USER'],
      'risk.opinion': ['PROCUREMENT', 'DEPARTMENT_USER'],
      'risk.questions.manage': ['ADMIN'],
      'risk.cycle.manage': ['ADMIN', 'PROCUREMENT'],
      'risk.import': ['ADMIN', 'PROCUREMENT'],
      'risk.export': ['ADMIN', 'PROCUREMENT', 'AUDITOR'],
    };
    for (const [p, roles] of Object.entries(want)) {
      for (const r of ['ADMIN', 'PROCUREMENT', 'DEPARTMENT_USER', 'SUPPLIER', 'AUDITOR']) {
        expect(can([r], p as never), `${r} ${p}`).toBe(roles.includes(r));
      }
    }
  });
});
