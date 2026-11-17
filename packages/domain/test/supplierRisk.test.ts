import { describe, expect, it } from 'vitest';
import { assessmentOutcome, criticalBlock, DEFAULT_WEIGHTS, incidentImpact, inherentRisk, performanceScore, SCORECARD_RISK_PENALTY, scorecardScore, validateResidual, validateWeights, type IncidentState, type QuestionDef } from '../src/supplierRisk.ts';

const q = (id: string, critical = false, evidenceRequired = false): QuestionDef => ({ id, controlId: `C-${id}`, text: id, critical, evidenceRequired });

describe('içsel risk', () => {
  it('hassas veri + ayrıcalıklı erişim kritik; tek yüksek faktör yüksek; gerekçeyle döner', () => {
    const base = { dataSensitivity: 'LOW', accessLevel: 'LOW', criticality: 'LOW', substitutability: 'LOW', subcontractorDependence: 'LOW' } as const;
    expect(inherentRisk({ ...base, dataSensitivity: 'HIGH', accessLevel: 'HIGH' }).level).toBe('CRITICAL');
    expect(inherentRisk({ ...base, criticality: 'HIGH' })).toMatchObject({ level: 'HIGH', reasons: ['Hizmet kritikliği yüksek'] });
    expect(inherentRisk({ ...base, substitutability: 'MEDIUM', subcontractorDependence: 'MEDIUM' }).level).toBe('MEDIUM');
    expect(inherentRisk(base).level).toBe('LOW');
  });
  it('kalan risk belgesiz yüzdeyle düşmez: kontrol kanıtı yoksa içsel riskin altına inemez', () => {
    expect(validateResidual('HIGH', 'LOW', 'Erişim MFA ve zaman sınırlı; yıllık test', 0)).toContain('kontrol');
    expect(validateResidual('HIGH', 'MEDIUM', 'Erişim MFA ve zaman sınırlı; yıllık test', 3)).toBeNull();
    expect(validateResidual('HIGH', 'HIGH', 'kısa', 3)).toContain('gerekçe');
  });
});

describe('T20 kritik engel ortalamayla aşılmaz', () => {
  const qs = [q('a', true), q('b'), q('c'), q('d'), q('e')];
  const yes = (id: string) => ({ questionId: id, response: 'YES' as const, review: 'ACCEPTED' as const });
  it('dört kontrol tam, kritik kontrol "hayır": uyum %80 ama sonuç BLOCKED; seçim engeli gerekçeli', () => {
    const r = assessmentOutcome(qs, [{ questionId: 'a', response: 'NO', review: 'ACCEPTED' }, yes('b'), yes('c'), yes('d'), yes('e')], '2026-10-27');
    expect(r.complianceRate).toBe(80);
    expect(r.outcome).toBe('BLOCKED');
    expect(criticalBlock({ outcome: r.outcome, scope: 'Uzak erişimli BT bakımı' })).toContain('ticari puan bu engeli aşmaz');
  });
  it('eksik yanıt başarılı sayılmaz; kritik kontrolde bilinmiyor da engeldir; gerekçesiz "uygulanamaz" geçmez', () => {
    expect(assessmentOutcome(qs, [yes('a'), yes('b'), yes('c'), yes('d')], '2026-10-27').outcome).toBe('INCOMPLETE');
    expect(assessmentOutcome(qs, [{ questionId: 'a', response: 'UNKNOWN' }, yes('b'), yes('c'), yes('d'), yes('e')], '2026-10-27').outcome).toBe('BLOCKED');
    const na = assessmentOutcome(qs, [yes('a'), { questionId: 'b', response: 'NOT_APPLICABLE', naReason: 'yok' }, yes('c'), yes('d'), yes('e')], '2026-10-27');
    expect(na.items.map((x) => x.message)).toContain('C-b: "uygulanamaz" gerekçesiz.');
  });
  it('kanıt zorunluysa eksik veya süresi dolmuş kanıt tamamlanmış sayılmaz; yüksek bulgu kritik kontrolde engeldir', () => {
    const ev = [q('a', false, true)];
    expect(assessmentOutcome(ev, [{ questionId: 'a', response: 'YES', review: 'ACCEPTED' }], '2026-10-27').items[0]!.kind).toBe('EVIDENCE');
    expect(assessmentOutcome(ev, [{ questionId: 'a', response: 'YES', review: 'ACCEPTED', evidenceDocumentVersionId: 'x', evidenceExpires: '2026-01-01' }], '2026-10-27').items[0]!.message).toContain('süresi');
    expect(assessmentOutcome([q('a', true)], [{ questionId: 'a', response: 'PARTIAL', review: 'FINDING', findingSeverity: 'HIGH' }], '2026-10-27').outcome).toBe('BLOCKED');
    expect(assessmentOutcome([q('a')], [{ questionId: 'a', response: 'PARTIAL', review: 'FINDING', findingSeverity: 'MEDIUM' }], '2026-10-27').outcome).toBe('CONDITIONAL');
    expect(assessmentOutcome([q('a')], [{ questionId: 'a', response: 'YES', review: 'ACCEPTED' }], '2026-10-27').outcome).toBe('ACCEPTABLE');
  });
});

describe('T19 olay etkisi: iddia, itiraz ve çift sayım', () => {
  const inc = (o: Partial<IncidentState>): IncidentState => ({ id: o.id ?? 'x', severity: 'HIGH', category: 'SLA', status: 'VERIFIED', verifiedAt: '2026-05-01', disputeOpen: false, duplicateOfId: null, countedInMetric: false, ...o });
  it('doğrulanmamış, itirazlı, mükerrer ve ölçüme yansımış olay ceza almaz; yalnız doğrulanmış tekil olay sayılır', () => {
    const r = incidentImpact([inc({ id: 'iddia', status: 'REPORTED', verifiedAt: null }), inc({ id: 'itiraz', disputeOpen: true }), inc({ id: 'kopya', duplicateOfId: 'asil' }),
      inc({ id: 'sla', countedInMetric: true }), inc({ id: 'asil', severity: 'MEDIUM', category: 'QUALITY' }), inc({ id: 'kapali', status: 'CLOSED', severity: 'LOW' })]);
    expect(r.counted).toEqual([{ id: 'asil', penalty: 3 }, { id: 'kapali', penalty: 1 }]);
    expect(r.penalty).toBe(4);
    expect(Object.fromEntries(r.excluded.map((x) => [x.id, x.reason]))).toMatchObject({ iddia: 'İddia; doğrulanmadı.', itiraz: 'Tedarikçi itirazı açık; kesinleşmedi.', sla: 'SLA ölçümüne zaten yansıdı; ayrıca ceza puanı yok.' });
  });
});

describe('performans puanı', () => {
  it('ağırlıklı ortalama − doğrulanmış olay cezası; örneklem azsa puan yerine yetersiz veri', () => {
    const s = { quality: 90, delivery: 80, sla: 70, communication: 100, commercial: 60 };
    expect(performanceScore(s, DEFAULT_WEIGHTS, 12, 4)).toMatchObject({ score: 76, base: 80, insufficient: false });
    expect(performanceScore(s, DEFAULT_WEIGHTS, 1, 0)).toMatchObject({ score: null, insufficient: true });
    expect(performanceScore({ quality: 90 }, DEFAULT_WEIGHTS, 12, 0).reason).toContain('Puanlanmamış');
    expect(validateWeights({ quality: 50, delivery: 50, sla: 0, communication: 0, commercial: 10 })).toContain('100');
    expect(validateWeights(DEFAULT_WEIGHTS)).toBeNull();
  });
});

describe('inceleme bulguları (regresyon)', () => {
  it('kritik kontrol "uygulanamaz": değerlendirici kabul etmeden engeldir ve inceleme tamam sayılmaz', () => {
    const qs = [q('a', true)];
    const na = { questionId: 'a', response: 'NOT_APPLICABLE' as const, naReason: 'Bu hizmette uygulanmaz' };
    const r = assessmentOutcome(qs, [na], '2026-10-27');
    expect(r).toMatchObject({ outcome: 'BLOCKED', reviewedAll: false });
    expect(assessmentOutcome(qs, [{ ...na, review: 'ACCEPTED' }], '2026-10-27')).toMatchObject({ outcome: 'ACCEPTABLE', reviewedAll: true });
  });
  it('kritik şiddetli bulgu kritik olmayan kontrolde de engeldir; yüksek bulgu yalnız kritik kontrolde', () => {
    expect(assessmentOutcome([q('a')], [{ questionId: 'a', response: 'PARTIAL', review: 'FINDING', findingSeverity: 'CRITICAL' }], '2026-10-27').outcome).toBe('BLOCKED');
    expect(assessmentOutcome([q('a')], [{ questionId: 'a', response: 'PARTIAL', review: 'FINDING', findingSeverity: 'HIGH' }], '2026-10-27').outcome).toBe('CONDITIONAL');
  });
});

// v2 (D103, kullanıcı kararı 17.11.2026): mal kabul kalktı; karne puanı anket, risk ve olaylardan hesaplanır.
describe('karne puanı (v2: anket, risk, olay)', () => {
  const s = { quality: 90, delivery: 80, sla: 70, communication: 100, commercial: 60 };
  it('taban anket uyum ortalaması; inceleme varsa eşit ağırlıkla ortalanır; risk ve olay cezası düşülür', () => {
    expect(scorecardScore({ surveyRates: [70, 90], review: null, riskLevel: null, incidentPenalty: 0 })).toMatchObject({ score: 80, base: 80, surveyMean: 80, reviewScore: null, riskPenalty: 0, insufficient: false });
    expect(scorecardScore({ surveyRates: [70], review: { scores: s, weights: DEFAULT_WEIGHTS }, riskLevel: 'HIGH', incidentPenalty: 3 })).toMatchObject({ base: 75, reviewScore: 80, riskPenalty: 7, score: 65 });
    expect(scorecardScore({ surveyRates: [], review: { scores: s, weights: DEFAULT_WEIGHTS }, riskLevel: 'CRITICAL', incidentPenalty: 70 })).toMatchObject({ base: 80, riskPenalty: 15, score: 0 });
    expect(SCORECARD_RISK_PENALTY).toEqual({ LOW: 0, MEDIUM: 3, HIGH: 7, CRITICAL: 15 });
  });
  it('anket ve inceleme yoksa puan yerine yetersiz veri; uyum oranı olmayan anket sayılmaz; eksik boyutlu inceleme reddedilir', () => {
    const none = scorecardScore({ surveyRates: [null], review: null, riskLevel: 'LOW', incidentPenalty: 0 });
    expect(none).toMatchObject({ score: null, insufficient: true });
    expect(none.reason).toContain('anket');
    expect(scorecardScore({ surveyRates: [80], review: { scores: { quality: 90 }, weights: DEFAULT_WEIGHTS }, riskLevel: null, incidentPenalty: 0 }).reason).toContain('Puanlanmamış');
  });
});
