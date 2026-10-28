import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { makeHarness } from './harness.ts';

// Faz 2: kurallı onay motoru (sürümlü politika, ardışık adımlar, en az davetli/süre) ve kaynak bulma istisnaları.
let h: Awaited<ReturnType<typeof makeHarness>>;
beforeAll(async () => { h = await makeHarness(); });
afterAll(async () => { await h.close(); });

const lines = [{ lot: 'Lot 1', description: 'Sunucu bakımı', unit: 'ay', quantity: '12' }];
const criteria = [{ code: 'PRICE', name: 'Fiyat', kind: 'PRICE', weight: '100' }];
const inDays = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString();
async function newProject() {
  const r = await h.call('buyer', 'POST', '/api/v1/projects', { body: { companyId: h.world.companyA1.id, title: `Bakım ${randomUUID().slice(0, 4)}`, category: 'BT hizmetleri',
    need: 'Sentetik ihtiyaç', currency: 'TRY', budget: '250000.00', budgetVerified: false, lines, criteria } });
  expect(r.status).toBe(201);
  return r.body.id as string;
}
const detail = async (id: string, who: 'buyer' | 'legal2' | 'finance' = 'buyer') => (await h.call(who, 'GET', `/api/v1/projects/${id}`)).body;
const publish = async (id: string, suppliers: string[], days: number) =>
  h.call('buyer', 'POST', `/api/v1/projects/${id}/rounds`, { body: { closesAt: inDays(days), supplierIds: suppliers }, headers: { 'if-match': (await detail(id)).project.etag } });

const PM = { role: 'PROCUREMENT_MANAGER', label: 'Satınalma yöneticisi' };
const FIN = { role: 'FINANCE', label: 'Finans' };

describe('onay politikası', () => {
  it('çakışan kural reddedilir; hazırlayan yayınlayamaz; yayınlanan sürüm simülasyonda açıklanır', async () => {
    const bad = await h.call('legal2', 'POST', '/api/v1/approval-policies', { body: { note: 'Çakışan deneme (sentetik).', rules: [
      { id: 'A', action: 'AWARD', currency: 'TRY', minAmount: '0', maxAmount: '100', steps: [PM] }, { id: 'B', action: 'AWARD', currency: 'TRY', minAmount: '50', maxAmount: null, steps: [PM] }] } });
    expect(bad.body.error.code).toBe('invalid_policy');
    const d = await h.call('legal2', 'POST', '/api/v1/approval-policies', { body: { note: 'İlk kurum politikası (sentetik).', rules: [
      { id: 'YAYIN', action: 'RFQ_PUBLISH', currency: 'TRY', minAmount: '0', maxAmount: null, steps: [PM, FIN], minInvitees: 2, minResponseDays: 3 }] } });
    expect(d.status).toBe(201);
    expect((await h.call('legal2', 'POST', `/api/v1/approval-policies/${d.body.id}/activate`)).body.error.code).toBe('segregation_of_duties');
    expect((await h.call('buyer', 'POST', `/api/v1/approval-policies/${d.body.id}/activate`)).status).toBe(403);
    expect((await h.call('tenantAdmin', 'POST', `/api/v1/approval-policies/${d.body.id}/activate`)).status).toBe(200);
    const sim = await h.call('buyer', 'POST', '/api/v1/approval-policies/simulate', { body: { action: 'RFQ_PUBLISH', companyId: h.world.companyA1.id, category: null, currency: 'TRY', amount: '10' } });
    expect(sim.body).toMatchObject({ ruleId: 'YAYIN', minInvitees: 2, minResponseDays: 3 });
    expect(sim.body.explanation).toContain(`Politika v${d.body.versionNo}, kural YAYIN`);
  });
});

describe('yayın: politika kuralları, istisna ve ardışık adımlar', () => {
  it('az davetli tek kaynak istisnası ister; onaylı istisna bir kez kullanılır; iki adım farklı kişi ve rolle onaylanır', async () => {
    const id = await newProject();
    const few = await publish(id, [h.world.suppliers.s1], 5);
    expect(few.body.error.code).toBe('min_invitees');
    const short = await publish(id, [h.world.suppliers.s1, h.world.suppliers.s2], 1);
    expect(short.body.error.code).toBe('min_response_days');
    const ex = await h.call('buyer', 'POST', `/api/v1/projects/${id}/exceptions`, { body: { kind: 'SINGLE_SOURCE', supplierId: h.world.suppliers.s1,
      reason: 'Yazılımın tek yetkili bakım firması; üretici yazısı ekte (sentetik).' } });
    expect(ex.status).toBe(201);
    expect((await h.call('buyer', 'POST', `/api/v1/sourcing-exceptions/${ex.body.id}/decision`, { body: { approve: true } })).status).toBe(403);
    expect((await h.call('legal2', 'POST', `/api/v1/sourcing-exceptions/${ex.body.id}/decision`, { body: { approve: true } })).body.status).toBe('APPROVED');
    const ok = await publish(id, [h.world.suppliers.s1], 5);
    expect(ok.status).toBe(201);
    expect(ok.body.approval.steps.map((s: any) => s.role)).toEqual(['PROCUREMENT_MANAGER', 'FINANCE']);
    expect((await detail(id)).exceptions[0].status).toBe('USED');

    const round = ok.body.roundId;
    // Sıra: önce satınalma yöneticisi. Finans ilk adımı onaylayamaz.
    const early = await h.call('finance', 'POST', `/api/v1/rfq-rounds/${round}/decision`, { body: { approve: true } });
    expect(early.body.error.code).toBe('approval_step');
    expect((await h.call('legal2', 'POST', `/api/v1/rfq-rounds/${round}/decision`, { body: { approve: true } })).body.status).toBe('PENDING_APPROVAL');
    const fin = (await h.call('finance', 'GET', '/api/v1/tasks?view=mine')).body.items;
    expect(fin.some((t: any) => t.entityId === id && /adım 2\/2: Finans/.test(t.title))).toBe(true);
    const st = (await detail(id, 'finance')).round.approval;
    expect(st).toMatchObject({ status: 'OPEN', nextStepNo: 2, canDecide: true });
    expect(st.decisions).toHaveLength(1);
    expect((await h.call('finance', 'POST', `/api/v1/rfq-rounds/${round}/decision`, { body: { approve: true } })).body.status).toBe('OPEN');
    expect((await detail(id)).project.status).toBe('OPEN');
  });

  it('iptal istisnası onaylanınca proje kapanır, bekleyen tur iptal olur; sonuçsuz kapanış yalnız değerlendirmede', async () => {
    const id = await newProject();
    expect((await h.call('buyer', 'POST', `/api/v1/projects/${id}/exceptions`, { body: { kind: 'NO_AWARD', reason: 'Uygun teklif çıkmadı; bütçe aşıldı (sentetik).' } })).body.error.code).toBe('invalid_state');
    const r = await publish(id, [h.world.suppliers.s1, h.world.suppliers.s2], 5);
    expect(r.status).toBe(201);
    const ex = await h.call('buyer', 'POST', `/api/v1/projects/${id}/exceptions`, { body: { kind: 'CANCEL', reason: 'İhtiyaç ortadan kalktı; birim kapatıldı (sentetik).' } });
    const rej = await h.call('legal2', 'POST', `/api/v1/sourcing-exceptions/${ex.body.id}/decision`, { body: { approve: false } });
    expect(rej.body.error.code).toBe('note_required');
    expect((await h.call('legal2', 'POST', `/api/v1/sourcing-exceptions/${ex.body.id}/decision`, { body: { approve: true } })).body.status).toBe('APPROVED');
    const d = await detail(id);
    expect(d.project.status).toBe('CANCELLED');
    const rounds = await h.owner.query(`SELECT status FROM rfq_rounds WHERE id = $1`, [r.body.roundId]);
    expect(rounds.rows[0].status).toBe('CANCELLED');
    const req = await h.owner.query(`SELECT status FROM approval_requests WHERE entity_id = $1`, [r.body.roundId]);
    expect(req.rows[0].status).toBe('CANCELLED');
  });
});

describe('inceleme bulguları (regresyon)', () => {
  it('tek kaynak istisnası onaylandığı tedarikçiye bağlı; onay gecikmesi en az teklif süresini kısaltamaz', async () => {
    const id = await newProject();
    const ex = await h.call('buyer', 'POST', `/api/v1/projects/${id}/exceptions`, { body: { kind: 'SINGLE_SOURCE', supplierId: h.world.suppliers.s1, reason: 'Tek yetkili servis firması; üretici yazısı var (sentetik).' } });
    await h.call('legal2', 'POST', `/api/v1/sourcing-exceptions/${ex.body.id}/decision`, { body: { approve: true } });
    expect((await publish(id, [h.world.suppliers.s2], 5)).body.error.code).toBe('single_source_mismatch');
    const ok = await publish(id, [h.world.suppliers.s1], 3.01);
    expect(ok.status).toBe(201);
    // Onay sürerken zaman geçti: kapanışa 3 günden az kaldı.
    await h.owner.query(`UPDATE rfq_rounds SET closes_at = now() + interval '2 days' WHERE id = $1`, [ok.body.roundId]);
    expect((await h.call('legal2', 'POST', `/api/v1/rfq-rounds/${ok.body.roundId}/decision`, { body: { approve: true } })).body.status).toBe('PENDING_APPROVAL');
    const fin = await h.call('finance', 'POST', `/api/v1/rfq-rounds/${ok.body.roundId}/decision`, { body: { approve: true } });
    expect(fin.body.error.code).toBe('closes_at_too_short');
  });

  it('iptal onaylanınca bekleyen diğer istisnanın onayı ve görevi kapanır; eski taslak yürürlüktekini geri alamaz', async () => {
    const id = await newProject();
    const single = await h.call('buyer', 'POST', `/api/v1/projects/${id}/exceptions`, { body: { kind: 'SINGLE_SOURCE', supplierId: h.world.suppliers.s1, reason: 'Tek yetkili servis firması (sentetik gerekçe).' } });
    const cancel = await h.call('buyer', 'POST', `/api/v1/projects/${id}/exceptions`, { body: { kind: 'CANCEL', reason: 'İhtiyaç kalktı; bütçe geri çekildi (sentetik).' } });
    await h.call('legal2', 'POST', `/api/v1/sourcing-exceptions/${cancel.body.id}/decision`, { body: { approve: true } });
    const req = await h.owner.query(`SELECT id, status FROM approval_requests WHERE entity_id = $1`, [single.body.id]);
    expect(req.rows[0].status).toBe('CANCELLED');
    const open = await h.owner.query(`SELECT count(*)::int AS n FROM tasks WHERE dedupe_key LIKE $1 AND status = 'OPEN'`, [`approval:${req.rows[0].id}:%`]);
    expect(open.rows[0].n).toBe(0);
    const pol = (rules: unknown[]) => h.call('legal2', 'POST', '/api/v1/approval-policies', { body: { note: 'Sürüm denemesi (sentetik).', rules } });
    const old = await pol([]);
    const newer = await pol([{ id: 'S', action: 'AWARD', currency: 'TRY', minAmount: '0', maxAmount: null, steps: [PM] }]);
    expect((await h.call('tenantAdmin', 'POST', `/api/v1/approval-policies/${newer.body.id}/activate`)).status).toBe(200);
    expect((await h.call('tenantAdmin', 'POST', `/api/v1/approval-policies/${old.body.id}/activate`)).body.error.code).toBe('stale_draft');
  });
});
