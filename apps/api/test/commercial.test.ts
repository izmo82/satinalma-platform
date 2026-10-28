import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { syntheticPdf } from '../src/devdata.ts';
import { makeHarness } from './harness.ts';

// Faz 3 kalanları: endeksli fiyat revizyonu, SLA kredisi, teminat. Öneren/giren onaylayamaz; hesap deterministik.
let h: Awaited<ReturnType<typeof makeHarness>>;
beforeAll(async () => { h = await makeHarness(); });
afterAll(async () => { await h.close(); });

async function contract() {
  const up = await h.upload('legal', { name: 's.pdf', mime: 'application/pdf', data: syntheticPdf([[`SENTETIK ${randomUUID()}`]]) },
    { companyId: h.world.companyA1.id, kind: 'CONTRACT', title: 'Hizmet Sözleşmesi (SENTETİK)' });
  const c = await h.call('legal', 'POST', '/api/v1/contracts', { body: { title: `Bakım ${randomUUID().slice(0, 4)} (SENTETİK)`, documentVersionId: up.body.documentVersionId,
    stage: 'EXECUTION', signatureMethod: 'NOT_REQUIRED', originalCustodyRequired: false,
    parties: [{ role: 'BUYER', displayName: h.world.companyA1.name, legalEntityId: h.world.companyA1.id }], supplierId: h.world.suppliers.s1 } });
  return c.body.contractVersionId as string;
}
const view = async (cv: string, who: 'legal' | 'legal2' | 'finance' | 'buyer' = 'legal') => (await h.call(who, 'GET', `/api/v1/contract-versions/${cv}/commercial`)).body;

describe('endeksli fiyat revizyonu', () => {
  it('kural + revizyon hesabı (tavanlı); öneren onaylayamaz; onaylı revizyon yürürlükteki katsayı olur; kural değişimi gerekçe ister', async () => {
    const cv = await contract();
    const rule = await h.call('legal', 'POST', `/api/v1/contract-versions/${cv}/price-rules`, { body: { indexName: 'TÜFE (TÜİK)', baseIndex: '2000', basePeriod: '2026-01-01', period: 'YEARLY',
      capPercent: '5', floorPercent: '0', sourceRef: 'Madde 7.2 (sentetik)' } });
    expect(rule.status).toBe(201);
    const rev = await h.call('legal', 'POST', `/api/v1/price-rules/${rule.body.id}/revisions`, { body: { effectiveFrom: '2026-07-01', indexValue: '2150', indexSource: 'TÜİK bülteni (sentetik)' } });
    expect(rev.body).toMatchObject({ rawChangePercent: '7.5000', appliedChangePercent: '5.0000', factor: '1.050000', limitedBy: 'CAP' });
    expect((await h.call('legal', 'POST', `/api/v1/price-revisions/${rev.body.id}/approve`)).body.error.code).toBe('segregation_of_duties');
    expect((await h.call('buyer', 'POST', `/api/v1/price-revisions/${rev.body.id}/approve`)).status).toBe(403);
    expect((await view(cv)).currentFactor).toBeNull();
    expect((await h.call('legal2', 'POST', `/api/v1/price-revisions/${rev.body.id}/approve`)).status).toBe(200);
    expect((await view(cv)).currentFactor).toEqual({ factor: '1.05', effectiveFrom: '2026-07-01' });
    expect((await h.call('legal', 'POST', `/api/v1/price-rules/${rule.body.id}/revisions`, { body: { effectiveFrom: '2026-07-01', indexValue: '2100', indexSource: 'Tekrar (sentetik)' } })).status).toBe(409);
    expect((await h.call('legal', 'POST', `/api/v1/price-rules/${rule.body.id}/revisions`, { body: { effectiveFrom: '2025-12-01', indexValue: '2100', indexSource: 'Eski dönem' } })).body.error.code).toBe('invalid_period');
    const again = await h.call('legal', 'POST', `/api/v1/contract-versions/${cv}/price-rules`, { body: { indexName: 'ÜFE', baseIndex: '3000', basePeriod: '2026-01-01', period: 'YEARLY', capPercent: null, floorPercent: null, sourceRef: 'Zeyilname 1' } });
    expect(again.body.error.code).toBe('reason_required');
    const repl = await h.call('legal', 'POST', `/api/v1/contract-versions/${cv}/price-rules`, { body: { indexName: 'ÜFE', baseIndex: '3000', basePeriod: '2026-01-01', period: 'YEARLY', capPercent: null, floorPercent: null,
      sourceRef: 'Zeyilname 1', replaceReason: 'Zeyilname ile endeks ÜFE olarak değişti (sentetik).' } });
    expect(repl.status).toBe(201);
    expect((await h.call('legal', 'POST', `/api/v1/price-rules/${rule.body.id}/revisions`, { body: { effectiveFrom: '2027-01-01', indexValue: '2200', indexSource: 'x (sentetik)' } })).body.error.code).toBe('rule_retired');
    // Değiştirilen kuralın katsayısı yürürlükte gösterilmez; bekleyen revizyonu da onaylanamaz.
    expect((await view(cv)).currentFactor).toBeNull();
    const r2rev = await h.call('legal', 'POST', `/api/v1/price-rules/${repl.body.id}/revisions`, { body: { effectiveFrom: '2026-02-01', indexValue: '3030', indexSource: 'ÜFE (sentetik)' } });
    expect((await h.call('legal2', 'POST', `/api/v1/price-revisions/${r2rev.body.id}/approve`)).status).toBe(200);
    expect((await view(cv)).currentFactor).toEqual({ factor: '1.01', effectiveFrom: '2026-02-01' });
  });
});

describe('SLA kredisi', () => {
  it('ihlal kademeye göre kredi hesaplar; aynı dönem iki kez girilemez; giren doğrulayamaz; reddedilen yerine yeni ölçüm girilir', async () => {
    const cv = await contract();
    const t = await h.call('legal', 'POST', `/api/v1/contract-versions/${cv}/sla-terms`, { body: { name: 'Aylık erişilebilirlik', unit: '%', direction: 'MIN', target: '99.9', periodFee: '40000.00', currency: 'TRY',
      tiers: [{ threshold: '99.9', creditPercent: '5' }, { threshold: '99.5', creditPercent: '10' }], capPercent: '20', sourceRef: 'Ek-2 SLA (sentetik)' } });
    expect(t.status).toBe(201);
    const bad = await h.call('legal', 'POST', `/api/v1/contract-versions/${cv}/sla-terms`, { body: { name: 'Hatalı', unit: '%', direction: 'MIN', target: '99.9', periodFee: '1', currency: 'TRY',
      tiers: [{ threshold: '99.95', creditPercent: '5' }], capPercent: null, sourceRef: 'x (sentetik)' } });
    expect(bad.body.error.code).toBe('invalid_sla');
    const m = await h.call('finance', 'POST', `/api/v1/sla-terms/${t.body.id}/measurements`, { body: { periodStart: '2026-09-01', measured: '99.4', evidence: 'İzleme raporu Eylül (sentetik)' } });
    expect(m.body).toMatchObject({ breached: true, creditPercent: '10.0000', creditAmount: '4000.00' });
    expect((await h.call('finance', 'POST', `/api/v1/sla-terms/${t.body.id}/measurements`, { body: { periodStart: '2026-09-01', measured: '99.0', evidence: 'İkinci kayıt denemesi' } })).status).toBe(409);
    // Aynı ay farklı günle ikinci ölçüm (ikinci kredi) açılamaz.
    expect((await h.call('finance', 'POST', `/api/v1/sla-terms/${t.body.id}/measurements`, { body: { periodStart: '2026-09-15', measured: '99.0', evidence: 'Ay ortası denemesi' } })).body.error.code).toBe('invalid_period');
    expect((await h.call('finance', 'POST', `/api/v1/sla-measurements/${m.body.id}/decision`, { body: { decision: 'VERIFY' } })).body.error.code).toBe('segregation_of_duties');
    expect((await h.call('legal', 'POST', `/api/v1/sla-measurements/${m.body.id}/decision`, { body: { decision: 'REJECT', reason: 'kısa' } })).body.error.code).toBe('reason_required');
    expect((await h.call('legal', 'POST', `/api/v1/sla-measurements/${m.body.id}/decision`, { body: { decision: 'REJECT', reason: 'Bakım penceresi hariç tutulmamış (sentetik).' } })).status).toBe(200);
    const m2 = await h.call('finance', 'POST', `/api/v1/sla-terms/${t.body.id}/measurements`, { body: { periodStart: '2026-09-01', measured: '99.7', evidence: 'Düzeltilmiş rapor (sentetik)' } });
    expect(m2.body).toMatchObject({ creditAmount: '2000.00' });
    expect((await h.call('legal', 'POST', `/api/v1/sla-measurements/${m2.body.id}/decision`, { body: { decision: 'VERIFY' } })).status).toBe(200);
    const v = await view(cv);
    expect(v.measurements.map((x: any) => [x.creditAmount, !!x.verifiedAt, !!x.rejectedAt])).toEqual([['2000.00', true, false], ['4000.00', false, true]]);
    const task = await h.owner.query(`SELECT status FROM tasks WHERE dedupe_key = $1`, [`sla-measure:${m2.body.id}`]);
    expect(task.rows[0].status).toBe('DONE');
  });
});

describe('teminat', () => {
  it('kayıt, türetilen durum, bitişi yaklaşan için görev, iade notlu ve tek kez', async () => {
    const cv = await contract();
    const soon = new Date(Date.now() + 10 * 86_400_000).toISOString().slice(0, 10);
    const g = await h.call('finance', 'POST', `/api/v1/contract-versions/${cv}/guarantees`, { body: { kind: 'PERFORMANCE', amount: '150000.00', currency: 'TRY', issuer: 'Sentetik Bank A.Ş.', referenceNo: 'TM-001', validUntil: soon } });
    expect(g.status).toBe(201);
    expect((await h.call('buyer', 'POST', `/api/v1/contract-versions/${cv}/guarantees`, { body: { kind: 'CASH', amount: '1.00', currency: 'TRY', issuer: 'x', referenceNo: 'y', validUntil: null } })).status).toBe(403);
    const v = await view(cv, 'finance');
    expect(v.guarantees[0]).toMatchObject({ status: 'EXPIRING', referenceNo: 'TM-001' });
    const task = await h.owner.query(`SELECT count(*)::int AS n FROM tasks WHERE dedupe_key = $1 AND status = 'OPEN'`, [`guarantee:${g.body.id}:EXPIRING`]);
    expect(task.rows[0].n).toBe(1);
    await view(cv, 'finance'); // tekrar açılış ikinci görev açmaz
    expect((await h.owner.query(`SELECT count(*)::int AS n FROM tasks WHERE dedupe_key = $1`, [`guarantee:${g.body.id}:EXPIRING`])).rows[0].n).toBe(1);
    expect((await h.call('finance', 'POST', `/api/v1/guarantees/${g.body.id}/return`, { body: { note: 'kısa' } })).body.error.code).toBe('reason_required');
    expect((await h.call('finance', 'POST', `/api/v1/guarantees/${g.body.id}/return`, { body: { note: 'İş bitti; banka yazısıyla iade edildi (sentetik).' } })).status).toBe(200);
    expect((await h.call('finance', 'POST', `/api/v1/guarantees/${g.body.id}/return`, { body: { note: 'İkinci iade denemesi (sentetik).' } })).status).toBe(409);
    expect((await view(cv, 'finance')).guarantees[0].status).toBe('RETURNED');
  });
});
