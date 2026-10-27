import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { addDays, addMonths } from '@sp/domain';
import { syntheticPdf } from '../src/devdata.ts';
import { processJobs } from '../src/worker.ts';
import { makeHarness } from './harness.ts';

// Faz 3 kalan: koşullar, ihbar (T21), yükümlülük, yenileme. Gerçek PostgreSQL + RLS + iş kuyruğu; veri sentetik.
let h: Awaited<ReturnType<typeof makeHarness>>;
beforeAll(async () => { h = await makeHarness(); });
afterAll(async () => { await h.close(); });

const today = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Istanbul' }).format(new Date());

async function contract() {
  const up = await h.upload('legal', { name: 's.pdf', mime: 'application/pdf', data: syntheticPdf([[`SENTETIK ${randomUUID()}`]]) },
    { companyId: h.world.companyA1.id, kind: 'CONTRACT', title: 'Bakım Sözleşmesi (SENTETİK)' });
  const c = await h.call('legal', 'POST', '/api/v1/contracts', { body: { title: `Bakım Sözleşmesi ${randomUUID().slice(0, 4)} (SENTETİK)`,
    documentVersionId: up.body.documentVersionId, stage: 'EXECUTION', signatureMethod: 'NOT_REQUIRED', originalCustodyRequired: false,
    parties: [{ role: 'BUYER', displayName: h.world.companyA1.name, legalEntityId: h.world.companyA1.id }] } });
  expect(c.status).toBe(201);
  return c.body.contractVersionId as string;
}
const terms = (over: Record<string, unknown> = {}) => ({ currency: 'TRY', valueType: 'CEILING', amount: '1000000.00', paymentTerms: 'Fatura tarihinden itibaren 30 gün',
  startDate: '2027-01-01', endDate: '2027-12-30', autoRenewal: true, renewalMonths: 12, noticeAmount: 60, noticeUnit: 'DAY', nonWorkingDay: 'PREVIOUS_WORKING_DAY',
  sourceRef: 'Madde 4.2 ve 9.1, s. 3', ...over });
const jobs = (cv: string, kind: string) => h.owner.query<{ id: string; run_after: Date; payload: any; status: string; result: any }>(
  `SELECT j.id, j.run_after, j.payload, j.status, j.result FROM jobs j WHERE j.kind = $1 AND (j.payload->>'termsId' IN (SELECT id::text FROM contract_terms WHERE contract_version_id = $2)
     OR j.payload->>'obligationId' IN (SELECT id::text FROM contract_obligations WHERE contract_version_id = $2)) ORDER BY j.run_after`, [kind, cv]);
/** Kuyruk paralel test dosyalarıyla paylaşılır: iş başka bir worker çağrısında işleniyor olabilir; görev görünene kadar bekle. */
async function eventually<T>(fn: () => Promise<T | undefined>, ms = 5000): Promise<T | undefined> {
  const end = Date.now() + ms;
  for (;;) {
    while (await processJobs(h.pool, h.store, null)) { /* */ }
    const v = await fn();
    if (v !== undefined || Date.now() > end) return v;
    await new Promise((r) => setTimeout(r, 100));
  }
}
const tasksFor = async (who: 'legal' | 'legal2', cv: string) => (await h.call(who, 'GET', '/api/v1/tasks?view=all')).body.items.filter((t: any) => t.entityId === cv);

describe('T21 ihbar son günü ve uyarılar', () => {
  let cv: string;
  beforeAll(async () => {
    cv = await contract();
    // Kiracı tatil verisi (sentetik): 29 Ekim.
    expect((await h.call('legal', 'POST', '/api/v1/holidays', { body: { day: '2027-10-29', name: 'Cumhuriyet Bayramı' } })).status).toBe(201);
  });

  it('kaynak madde zorunlu; giren doğrulayamaz; doğrulanmadan uyarı planlanmaz', async () => {
    expect((await h.call('legal', 'POST', `/api/v1/contract-versions/${cv}/terms`, { body: terms({ sourceRef: '' }) })).status).toBe(422);
    const t = await h.call('legal', 'POST', `/api/v1/contract-versions/${cv}/terms`, { body: terms() });
    expect(t.status).toBe(201);
    expect((await jobs(cv, 'contract.notice_reminder')).rowCount).toBe(0);
    const sod = await h.call('legal', 'POST', `/api/v1/contract-terms/${t.body.id}/verify`);
    expect(sod.status).toBe(403);
    expect(sod.body.error.code).toBe('segregation_of_duties');
    expect((await h.call('buyer', 'POST', `/api/v1/contract-terms/${t.body.id}/verify`)).status).toBe(403);
    expect((await h.call('legal2', 'POST', `/api/v1/contract-terms/${t.body.id}/verify`)).status).toBe(200);
  });

  it('son gün: 30.12 bitiş − 60 gün = 31.10 pazar; 30.10 cumartesi, 29.10 tatil → 28.10; uyarılar 90/60/30 gün öncesine', async () => {
    const lc = (await h.call('legal', 'GET', `/api/v1/contract-versions/${cv}/lifecycle`)).body;
    expect(lc.notice).toMatchObject({ raw: '2027-10-31', deadline: '2027-10-28', adjusted: true });
    expect(lc.terms.verifiedBy).toBeTruthy();
    const j = (await jobs(cv, 'contract.notice_reminder')).rows;
    expect(j.map((x) => x.payload.offset)).toEqual([90, 60, 30]);
    expect(j.map((x) => x.payload.deadline)).toEqual(['2027-10-28', '2027-10-28', '2027-10-28']);
    expect(new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Istanbul' }).format(j[0]!.run_after)).toBe(addDays('2027-10-28', -90));
  });

  it('uyarı görevi bitişe değil ihbar son gününe dayanır; yükselen uyarı öncekini kapatır', async () => {
    const j = (await jobs(cv, 'contract.notice_reminder')).rows;
    await h.owner.query(`UPDATE jobs SET run_after = now() - interval '2 minutes' WHERE id = $1`, [j[0]!.id]);
    await h.owner.query(`UPDATE jobs SET run_after = now() - interval '1 minute' WHERE id = $1`, [j[2]!.id]);
    await eventually(async () => (await tasksFor('legal2', cv)).find((t: any) => t.kind === 'contract_notice' && t.severity === 'CRITICAL'));
    const open = (await tasksFor('legal2', cv)).filter((t: any) => t.kind === 'contract_notice');
    expect(open).toHaveLength(1);
    expect(open[0].severity).toBe('CRITICAL');
    expect(new Date(open[0].dueAt).toISOString()).toBe('2027-10-28T20:59:59.000Z');
    expect(open[0].title).toContain('28.10.2027');
    expect(open[0].title).not.toContain('30.12.2027');
  });

  it('önemli değişiklik gerekçe ister, farkı gösterir ve eski uyarıları geçersiz kılar', async () => {
    expect((await h.call('legal', 'POST', `/api/v1/contract-versions/${cv}/terms`, { body: terms({ endDate: '2028-06-30' }) })).body.error.code).toBe('reason_required');
    const r = await h.call('legal', 'POST', `/api/v1/contract-versions/${cv}/terms`, { body: terms({ endDate: '2028-06-30', amount: '1200000.00', changeReason: 'Zeyilname ile süre ve tavan uzatıldı (sentetik).' }) });
    expect(r.status).toBe(201);
    expect(r.body.diff.map((d: any) => d.field)).toEqual(['amount', 'endDate']);
    expect((await tasksFor('legal2', cv)).some((t: any) => t.kind === 'contract_notice')).toBe(false);
    const lc = (await h.call('legal', 'GET', `/api/v1/contract-versions/${cv}/lifecycle`)).body;
    expect(lc.terms.verifiedBy).toBeNull();
    expect(lc.diff).toHaveLength(2);
    // Bekleyen eski 60 günlük iş çalışırsa sessizce eskir.
    const old = (await jobs(cv, 'contract.notice_reminder')).rows.find((x) => x.payload.offset === 60 && x.status === 'QUEUED')!;
    await h.owner.query(`UPDATE jobs SET run_after = now() - interval '1 minute' WHERE id = $1`, [old.id]);
    const res = await eventually(async () => (await h.owner.query(`SELECT result FROM jobs WHERE id = $1`, [old.id])).rows[0].result ?? undefined);
    expect(res).toEqual({ skipped: 'obsolete' });
    expect((await tasksFor('legal2', cv)).some((t: any) => t.kind === 'contract_notice')).toBe(false);
    await h.call('legal2', 'POST', `/api/v1/contract-terms/${r.body.id}/verify`);
  });

  it('fesih kararı yetkili insan kararıdır; ihbar görevini kapatır, çıkış kontrolü görevleri açar', async () => {
    expect((await h.call('buyer', 'POST', `/api/v1/contract-versions/${cv}/renewal-decision`, { body: { decision: 'TERMINATE', rationale: 'Performans yetersiz (sentetik).' } })).status).toBe(403);
    const d = await h.call('legal2', 'POST', `/api/v1/contract-versions/${cv}/renewal-decision`, { body: { decision: 'TERMINATE', rationale: 'Performans yetersiz; yeni ihale açılacak (sentetik).' } });
    expect(d.status).toBe(201);
    const exit = (await h.owner.query(`SELECT assignee_role FROM tasks WHERE entity_id = $1 AND kind = 'contract_exit' AND status = 'OPEN' ORDER BY assignee_role`, [cv])).rows.map((r) => r.assignee_role);
    expect(exit).toEqual(['FINANCE', 'FINANCE', 'SECURITY', 'SECURITY']);
    expect((await h.owner.query(`SELECT 1 FROM tasks WHERE entity_id = $1 AND kind = 'contract_notice' AND status = 'OPEN'`, [cv])).rowCount).toBe(0);
    // Karar verilen koşul değiştirilemez; değişiklik yeni sürüm (zeyilname) ister.
    expect((await h.call('legal', 'POST', `/api/v1/contract-versions/${cv}/terms`, { body: terms({ changeReason: 'Karar sonrası değişiklik denemesi.' }) })).status).toBe(409);
    expect((await h.call('buyerB', 'GET', `/api/v1/contract-versions/${cv}/lifecycle`, { tenant: h.world.tenantB })).status).toBe(404);
  });
});

describe('sırasız veya geç işlenen ihbar uyarısı', () => {
  it('önce 30 gün, sonra 90 gün uyarısı işlenirse kritik görev geri alınmaz', async () => {
    const cv = await contract();
    const t = await h.call('legal', 'POST', `/api/v1/contract-versions/${cv}/terms`, { body: terms() });
    await h.call('legal2', 'POST', `/api/v1/contract-terms/${t.body.id}/verify`);
    const j = (await jobs(cv, 'contract.notice_reminder')).rows;
    const by = (o: number) => j.find((x) => x.payload.offset === o)!.id;
    await h.owner.query(`UPDATE jobs SET run_after = now() - interval '2 minutes' WHERE id = $1`, [by(30)]);
    await eventually(async () => (await h.owner.query(`SELECT result FROM jobs WHERE id = $1`, [by(30)])).rows[0].result ?? undefined);
    await h.owner.query(`UPDATE jobs SET run_after = now() - interval '1 minute' WHERE id = $1`, [by(90)]);
    await eventually(async () => (await h.owner.query(`SELECT result FROM jobs WHERE id = $1`, [by(90)])).rows[0].result ?? undefined);
    const open = (await tasksFor('legal2', cv)).filter((x: any) => x.kind === 'contract_notice');
    expect(open.map((x: any) => x.severity)).toEqual(['CRITICAL']);
    expect((await h.owner.query(`SELECT result FROM jobs WHERE id = $1`, [by(90)])).rows[0].result.skipped).toBe('more_urgent_reminder_open');
  });
});

describe('yükümlülükler', () => {
  it('sahipsiz yükümlülük yöneticiye düşer; kanıtla kapanır; sıradaki dönem planlanır', async () => {
    const cv = await contract();
    const first = addDays(today(), 5);
    const o = await h.call('legal', 'POST', `/api/v1/contract-versions/${cv}/obligations`, { body: { title: 'Üç aylık bakım raporu', counterparty: 'SUPPLIER', ownerRole: null,
      firstDue: first, recurrence: 'QUARTERLY', until: null, evidenceRequired: true, sourceRef: 'Ek-2 madde 3' } });
    expect(o.status).toBe(201);
    const t = await eventually(async () => (await tasksFor('legal2', cv)).find((x: any) => x.kind === 'contract_obligation'));
    expect(t.assigneeRole).toBe('PROCUREMENT_MANAGER');
    expect(t.reason).toContain('Sahipsiz');
    expect((await h.call('legal', 'POST', `/api/v1/obligations/${o.body.id}/events`, { body: { dueDate: addDays(first, 1), outcome: 'FULFILLED', note: 'Rapor alındı' } })).body.error.code).toBe('invalid_period');
    expect((await h.call('legal', 'POST', `/api/v1/obligations/${o.body.id}/events`, { body: { dueDate: first, outcome: 'FULFILLED', note: 'Rapor alındı' } })).body.error.code).toBe('evidence_required');
    const ok = await h.call('legal', 'POST', `/api/v1/obligations/${o.body.id}/events`, { body: { dueDate: first, outcome: 'FULFILLED', note: 'Rapor alındı', evidence: 'BR-2027-Q1 (sentetik)' } });
    expect(ok.status).toBe(201);
    expect(ok.body.next).toBe(addMonths(first, 3));
    expect((await tasksFor('legal2', cv)).some((x: any) => x.kind === 'contract_obligation' && x.title.includes(first.split('-').reverse().join('.')))).toBe(false);
    const lc = (await h.call('legal', 'GET', `/api/v1/contract-versions/${cv}/lifecycle`)).body;
    expect(lc.obligations[0].periods.find((p: any) => p.dueDate === first).state).toBe('FULFILLED');
    expect((await h.call('legal', 'POST', `/api/v1/obligations/${o.body.id}/events`, { body: { dueDate: first, outcome: 'MISSED', note: 'Değiştirme denemesi' } })).status).toBe(409);
  });
});
