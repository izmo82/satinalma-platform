// v2 Faz 1 (D93/D95): anket bölüm kullanıcısı (güvenlik) için departmanlı açılır; ağırlık politikasında yetkisiz rol örneği bölüm kullanıcısı
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { makeHarness } from './harness.ts';
import { securityTemplate } from './evalHelpers.ts';

// Faz 5 kalanları: tedarikçi portalından anket yanıtlama, kategori bazında ağırlık politikası, iki kişi onaylı tasarruf bazı.
let h: Awaited<ReturnType<typeof makeHarness>>;
beforeAll(async () => { h = await makeHarness(); });
afterAll(async () => { await h.close(); });
const lowFactors = { dataSensitivity: 'LOW', accessLevel: 'LOW', criticality: 'LOW', substitutability: 'LOW', subcontractorDependence: 'LOW' };

describe('portal anketi', () => {
  it('gönderilmeyen anket görünmez; tedarikçi yalnız kendine gönderileni yanıtlar; eksik yanıtla gönderemez; gönderince kilitlenir; kurum incelemesi bulgu göstermez', async () => {
    const tpl = await securityTemplate(h);
    // v2: inceleyen güvenlik kullanıcısı bölüm kullanıcısıdır; değerlendirme onun departmanında (Bilgi Teknolojileri) açılır.
    const a = await h.call('buyer', 'POST', '/api/v1/assessments', { body: { supplierId: h.world.suppliers.s1, templateId: tpl, scope: 'Uzak erişimli bakım (sentetik)', inherentFactors: lowFactors,
      departmentId: h.world.departments.bt } });
    expect(a.status).toBe(201);
    expect((await h.call('supplier1', 'GET', `/api/v1/portal/assessments/${a.body.id}`)).status).toBe(404);
    expect((await h.call('supplier1', 'GET', '/api/v1/portal/assessments')).body.items).toEqual([]);
    expect((await h.call('buyer', 'POST', `/api/v1/assessments/${a.body.id}/send-to-supplier`, { body: { due: '2026-12-31' } })).status).toBe(200);
    // Başka tedarikçi göremez (RLS + API).
    expect((await h.call('supplier2', 'GET', `/api/v1/portal/assessments/${a.body.id}`)).status).toBe(404);
    expect((await h.call('supplier1', 'GET', `/api/v1/assessments/${a.body.id}`)).status).toBe(403);
    const view = (await h.call('supplier1', 'GET', `/api/v1/portal/assessments/${a.body.id}`)).body;
    expect(view.questions).toHaveLength(4);
    expect(view).not.toHaveProperty('residual');
    const [q1, q2] = view.questions;
    // Gönderilen ankette kurum yanıt yazamaz; tedarikçi göndermeden inceleme tamamlanamaz.
    expect((await h.call('buyer', 'PUT', `/api/v1/assessments/${a.body.id}/answers/${q1.id}`, { body: { response: 'YES' } })).body.error.code).toBe('supplier_answers');
    expect((await h.call('security', 'POST', `/api/v1/assessments/${a.body.id}/complete`)).body.error.code).toBe('awaiting_supplier');
    expect((await h.call('supplier1', 'PUT', `/api/v1/portal/assessments/${a.body.id}/answers/${q1.id}`, { body: { response: 'YES', note: 'Tüm uzak erişim MFA ile (sentetik).' } })).status).toBe(200);
    expect((await h.call('supplier1', 'POST', `/api/v1/portal/assessments/${a.body.id}/submit`)).body.error.code).toBe('unanswered');
    for (const q of view.questions.slice(1)) {
      expect((await h.call('supplier1', 'PUT', `/api/v1/portal/assessments/${a.body.id}/answers/${q.id}`, { body: { response: q.id === q2.id ? 'NOT_APPLICABLE' : 'PARTIAL', naReason: q.id === q2.id ? 'Yedekleme hizmet kapsamında değil (sentetik).' : null } })).status).toBe(200);
    }
    expect((await h.call('supplier1', 'POST', `/api/v1/portal/assessments/${a.body.id}/submit`)).status).toBe(200);
    expect((await h.call('supplier1', 'PUT', `/api/v1/portal/assessments/${a.body.id}/answers/${q1.id}`, { body: { response: 'NO' } })).body.error.code).toBe('portal_locked');
    expect((await h.call('buyer', 'PUT', `/api/v1/assessments/${a.body.id}/answers/${q1.id}`, { body: { response: 'NO' } })).body.error.code).toBe('supplier_answers');
    // Kurum görür: yanıtı tedarikçi kullanıcısı girdi; güvenlik inceler (giren tedarikçi, görev ayrılığı sağlanır).
    const internal = (await h.call('security', 'GET', `/api/v1/assessments/${a.body.id}`)).body;
    expect(internal.answers.find((x: any) => x.questionId === q1.id)).toMatchObject({ response: 'YES', answeredByMe: false });
    expect((await h.call('security', 'POST', `/api/v1/assessments/${a.body.id}/answers/${q1.id}/review`, { body: { review: 'FINDING', findingSeverity: 'MEDIUM', findingNote: 'MFA kanıtı istenecek (sentetik).' } })).status).toBe(200);
    const again = (await h.call('supplier1', 'GET', `/api/v1/portal/assessments/${a.body.id}`)).body;
    expect(JSON.stringify(again)).not.toContain('MFA kanıtı istenecek');
  });
});

it('kurumca yanıt girilmiş anket tedarikçiye gönderilmez (beyanlar karışmaz)', async () => {
  const tpl = await securityTemplate(h);
  const a = await h.call('buyer', 'POST', '/api/v1/assessments', { body: { supplierId: h.world.suppliers.s1, templateId: tpl, scope: 'Kurum yanıtlı anket (sentetik)', inherentFactors: lowFactors } });
  const q = (await h.call('buyer', 'GET', `/api/v1/assessments/${a.body.id}`)).body.questions[0];
  await h.call('buyer', 'PUT', `/api/v1/assessments/${a.body.id}/answers/${q.id}`, { body: { response: 'YES' } });
  expect((await h.call('buyer', 'POST', `/api/v1/assessments/${a.body.id}/send-to-supplier`, { body: {} })).body.error.code).toBe('answers_exist');
});

describe('kategori ağırlık politikası', () => {
  it('inceleme kategorinin yürürlükteki ağırlığını kopyalar; yeni kural eskisini emekliye ayırır; geçersiz toplam reddedilir', async () => {
    const cat = `Lojistik ${randomUUID().slice(0, 4)}`;
    expect((await h.call('legal2', 'PUT', '/api/v1/performance-weights', { body: { category: cat, weights: { quality: 50, delivery: 50, sla: 10, communication: 0, commercial: 0 }, reason: 'Toplamı yanlış (sentetik).' } })).body.error.code).toBe('invalid_weights');
    expect((await h.call('techEval', 'PUT', '/api/v1/performance-weights', { body: { category: cat, weights: { quality: 20, delivery: 50, sla: 20, communication: 5, commercial: 5 }, reason: 'Yetkisiz deneme.' } })).status).toBe(403);
    const w = { quality: 20, delivery: 50, sla: 20, communication: 5, commercial: 5 };
    expect((await h.call('legal2', 'PUT', '/api/v1/performance-weights', { body: { category: cat, weights: w, reason: 'Lojistikte teslimat belirleyici (sentetik).' } })).status).toBe(200);
    const r = await h.call('buyer', 'POST', `/api/v1/suppliers/${h.world.suppliers.s1}/performance-reviews`, { body: { periodStart: '2026-01-01', periodEnd: '2026-03-31', category: ` ${cat.toUpperCase()} `,
      scores: { quality: 80, delivery: 60, sla: 70, communication: 90, commercial: 80 }, basis: 'Çeyrek teslim kayıtları (sentetik).' } });
    expect(r.status).toBe(201);
    const row = (await h.owner.query(`SELECT weights, policy_version FROM performance_reviews WHERE id = $1`, [r.body.id])).rows[0];
    expect(row.weights).toEqual(w);
    expect(row.policy_version).toMatch(/^kategori:/);
    await h.call('legal2', 'PUT', '/api/v1/performance-weights', { body: { category: cat, weights: { quality: 40, delivery: 30, sla: 20, communication: 5, commercial: 5 }, reason: 'Kalite ağırlığı artırıldı (sentetik).' } });
    const list = (await h.call('security', 'GET', '/api/v1/performance-weights')).body.items.filter((x: any) => x.category === cat);
    expect(list.map((x: any) => !!x.retiredAt)).toEqual([false, true]);
    // Eski inceleme kendi kopyaladığı ağırlıkla kalır.
    expect((await h.owner.query(`SELECT weights FROM performance_reviews WHERE id = $1`, [r.body.id])).rows[0].weights).toEqual(w);
  });
});

describe('tasarruf bazı', () => {
  it('baz karar öncesi önerilir, öneren onaylayamaz; onaysız baz rapora girmez', async () => {
    const p = await h.call('buyer', 'POST', '/api/v1/projects', { body: { companyId: h.world.companyA1.id, title: `Tasarruf ${randomUUID().slice(0, 4)}`, category: 'BT', budget: '120000.00', currency: 'TRY',
      lines: [{ lot: 'L', description: 'Bakım', unit: 'ay', quantity: '12' }], criteria: [{ code: 'PRICE', name: 'Fiyat', kind: 'PRICE', weight: '100' }] } });
    expect((await h.call('buyer', 'POST', `/api/v1/projects/${p.body.id}/savings-baselines`, { body: { basis: 'PREVIOUS_PRICE', amount: '-5', source: 'Geçen yılın sözleşmesi (sentetik).' } })).body.error.code).toBe('invalid_number');
    const b = await h.call('buyer', 'POST', `/api/v1/projects/${p.body.id}/savings-baselines`, { body: { basis: 'PREVIOUS_PRICE', amount: '130000.00', source: 'SZL-2025-0004 yıllık bedeli (sentetik).' } });
    expect(b.status).toBe(201);
    expect((await h.call('buyer', 'POST', `/api/v1/projects/${p.body.id}/savings-baselines`, { body: { basis: 'MARKET', amount: '1.00', source: 'İkinci baz denemesi (sentetik).' } })).status).toBe(409);
    expect((await h.call('buyer', 'POST', `/api/v1/savings-baselines/${b.body.id}/decision`, { body: { approve: true } })).status).toBe(403);
    expect((await h.call('legal2', 'POST', `/api/v1/savings-baselines/${b.body.id}/decision`, { body: { approve: true } })).body.status).toBe('APPROVED');
    const d = (await h.call('buyer', 'GET', `/api/v1/projects/${p.body.id}`)).body;
    expect(d.savingsBaselines[0]).toMatchObject({ status: 'APPROVED', amount: '130000.00', proposedByMe: true });
    // Seçim kararı aşamasına geçen projede bekleyen baz onaylanamaz ve yeni baz önerilemez.
    const p2 = await h.call('buyer', 'POST', '/api/v1/projects', { body: { companyId: h.world.companyA1.id, title: `Geç baz ${randomUUID().slice(0, 4)}`, category: 'BT', budget: '50000.00', currency: 'TRY',
      lines: [{ lot: 'L', description: 'Bakım', unit: 'ay', quantity: '12' }], criteria: [{ code: 'PRICE', name: 'Fiyat', kind: 'PRICE', weight: '100' }] } });
    const late = await h.call('buyer', 'POST', `/api/v1/projects/${p2.body.id}/savings-baselines`, { body: { basis: 'BUDGET', amount: '50000.00', source: 'Onaylı bütçe (sentetik).' } });
    await h.owner.query(`UPDATE projects SET status = 'AWARD_APPROVAL' WHERE id = $1`, [p2.body.id]);
    expect((await h.call('legal2', 'POST', `/api/v1/savings-baselines/${late.body.id}/decision`, { body: { approve: true } })).body.error.code).toBe('project_closed');
    expect((await h.call('buyer', 'POST', `/api/v1/projects/${p2.body.id}/savings-baselines`, { body: { basis: 'MARKET', amount: '1.00', source: 'Geç baz denemesi.' } })).status).toBe(409);
    const rep = await h.call('auditor', 'GET', '/api/v1/reports/summary?from=2026-01-01&to=2026-12-31');
    // Bu proje henüz karar almadı: tasarrufa sayılmaz.
    const s = rep.body.indicators.find((i: any) => i.key === 'savings');
    expect(['OK', 'NO_DATA']).toContain(s.status);
    expect(s.source).toContain('iki kişi onaylı');
  });
});
