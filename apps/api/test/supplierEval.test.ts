// v2 Faz 1 (D93/D95): değerlendirme bölüm kullanıcısının departmanında; yetkisiz rol örnekleri v2'ye göre; sipariş/kabul adımları kaldırıldı (kabul örneği test verisi)
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withTenant, type TenantContext } from '../src/db.ts';
import { createPo, recordReceipt } from '../src/modules/invoices.ts';
import { makeHarness } from './harness.ts';
import { reviewedAssessment, securityTemplate } from './evalHelpers.ts';

// Faz 5 kabul testleri (T19–T20) ve değerlendirme kuralları; gerçek PostgreSQL + RLS. Tüm veri sentetik.
let h: Awaited<ReturnType<typeof makeHarness>>;
let tpl: string;
beforeAll(async () => { h = await makeHarness(); tpl = await securityTemplate(h); });
afterAll(async () => { await h.close(); });

type Who = 'buyer' | 'finance' | 'legal' | 'legal2' | 'security' | 'masterData' | 'auditor' | 'techEval';
const call = (who: Who, method: string, url: string, body?: unknown) => h.call(who, method, url, body === undefined ? {} : { body });
const s1 = () => h.world.suppliers.s1;
const s2 = () => h.world.suppliers.s2;

describe('anket şablonu ve değerlendirme', () => {
  it('yayımlanmış şablon değişmez; değişiklik yeni sürümdür; taslakla değerlendirme başlatılmaz', async () => {
    const draft = await call('security', 'POST', '/api/v1/questionnaire-templates', { code: 'TEMIZLIK', name: 'Temizlik hizmeti anketi', category: 'Tesis hizmeti',
      questions: [{ controlId: 'ISG-01', reference: 'İSG mevzuatı', text: 'Personel İSG eğitimi belgeli mi?', critical: false, evidenceRequired: true }] });
    expect(draft.body.version).toBe(1);
    const early = await call('buyer', 'POST', '/api/v1/assessments', { supplierId: s1(), templateId: draft.body.id, scope: 'Ofis temizliği',
      inherentFactors: { dataSensitivity: 'LOW', accessLevel: 'LOW', criticality: 'LOW', substitutability: 'LOW', subcontractorDependence: 'LOW' } });
    expect(early.body.error.code).toBe('template_not_published');
    await call('legal2', 'POST', `/api/v1/questionnaire-templates/${draft.body.id}/publish`);
    const v2 = await call('security', 'POST', '/api/v1/questionnaire-templates', { code: 'TEMIZLIK', name: 'Temizlik hizmeti anketi', category: 'Tesis hizmeti',
      questions: [{ controlId: 'ISG-01', reference: 'İSG mevzuatı', text: 'Personel İSG eğitimi belgeli mi?', critical: true, evidenceRequired: true }] });
    expect(v2.body.version).toBe(2);
    expect((await call('buyer', 'POST', '/api/v1/questionnaire-templates', { code: 'X1', name: 'Yetkisiz', category: 'x', questions: [] })).status).toBe(400);
    // v2: satınalmacı (Satınalma) şablon yönetir; yönetim yetkisi olmayan rol denetçidir.
    expect((await call('auditor', 'POST', '/api/v1/questionnaire-templates', { code: 'X1', name: 'Yetkisiz', category: 'xx', questions: [{ controlId: 'A', reference: 'ab', text: 'abcde', critical: false, evidenceRequired: false }] })).status).toBe(403);
  });

  it('eksik yanıt başarılı sayılmaz; gerekçesiz "uygulanamaz" reddedilir; yanıtı giren kendi yanıtını inceleyemez', async () => {
    // v2: inceleyen güvenlik kullanıcısı bölüm kullanıcısıdır; değerlendirme onun departmanında açılır.
    const a = await call('buyer', 'POST', '/api/v1/assessments', { supplierId: s2(), templateId: tpl, scope: 'Yedekleme hizmeti (sentetik)', departmentId: h.world.departments.bt,
      inherentFactors: { dataSensitivity: 'HIGH', accessLevel: 'HIGH', criticality: 'MEDIUM', substitutability: 'LOW', subcontractorDependence: 'LOW' } });
    const d = (await call('buyer', 'GET', `/api/v1/assessments/${a.body.id}`)).body;
    expect(d.inherent.level).toBe('CRITICAL');
    expect(d.outcome).toBe('BLOCKED'); // kritik kontrol yanıtsız = bilinmiyor = engel
    const q = d.questions as { id: string }[];
    expect((await call('buyer', 'PUT', `/api/v1/assessments/${a.body.id}/answers/${q[1]!.id}`, { response: 'NOT_APPLICABLE', naReason: 'yok' })).body.error.code).toBe('na_reason_required');
    await call('buyer', 'PUT', `/api/v1/assessments/${a.body.id}/answers/${q[0]!.id}`, { response: 'YES' });
    expect((await call('buyer', 'POST', `/api/v1/assessments/${a.body.id}/answers/${q[0]!.id}/review`, { review: 'ACCEPTED' })).status).toBe(403);
    expect((await call('legal2', 'POST', `/api/v1/assessments/${a.body.id}/answers/${q[0]!.id}/review`, { review: 'ACCEPTED' })).status).toBe(200);
    const mid = (await call('buyer', 'GET', `/api/v1/assessments/${a.body.id}`)).body;
    expect(mid.outcome).toBe('INCOMPLETE');
    expect(mid.items.filter((x: any) => x.kind === 'UNKNOWN')).toHaveLength(3);
    expect((await call('security', 'POST', `/api/v1/assessments/${a.body.id}/complete`)).body.error.code).toBe('review_incomplete');
  });

  it('kalan risk: açan kişi kabul edemez; kanıtsız indirim yok; gerekçeyle risk sahibi kabul eder', async () => {
    const id = await reviewedAssessment(h, s2(), tpl, {}, { dataSensitivity: 'HIGH', accessLevel: 'MEDIUM', criticality: 'LOW', substitutability: 'LOW', subcontractorDependence: 'LOW' });
    const reason = 'MFA, erişim kayıtları ve yıllık geri dönüş testi kanıtlandı (sentetik).';
    expect((await call('buyer', 'POST', `/api/v1/assessments/${id}/residual`, { level: 'LOW', reason })).status).toBe(403);
    expect((await call('security', 'POST', `/api/v1/assessments/${id}/residual`, { level: 'LOW', reason: 'kısa' })).body.error.code).toBe('invalid_residual');
    // Yalnız beyan (kanıt belgesi yok): kalan risk içsel riskin altına indirilemez.
    expect((await call('security', 'POST', `/api/v1/assessments/${id}/residual`, { level: 'MEDIUM', reason })).body.error.code).toBe('invalid_residual');
    const ok = await call('security', 'POST', `/api/v1/assessments/${id}/residual`, { level: 'HIGH', reason });
    expect(ok.status).toBe(200);
    const d = (await call('auditor', 'GET', `/api/v1/assessments/${id}`)).body;
    expect(d).toMatchObject({ outcome: 'ACCEPTABLE', inherent: { level: 'HIGH' }, assessment: { residual: { level: 'HIGH', reason } } });
  });
});

describe('T20 kritik engel', () => {
  // v2 Faz 1 (D93): işlev onaylı kaldırma listesinde; davranış removed-v1.test.ts ile 403 olarak korunur
  it.skip('kritik kontrol "hayır": uyum %75 ama sonuç BLOCKED; sipariş verilemez; sorumlulara görev düşer', async () => {
    const id = await reviewedAssessment(h, s1(), tpl, { 'ERS-01': 'NO' });
    const d = (await call('buyer', 'GET', `/api/v1/assessments/${id}`)).body;
    expect(d.complianceRate).toBe(75);
    expect(d.outcome).toBe('BLOCKED');
    const po = await call('buyer', 'POST', '/api/v1/purchase-orders', { companyId: h.world.companyA1.id, supplierId: s1(), contractVersionId: null, currency: 'TRY',
      lines: [{ kind: 'SERVICE', description: 'Uzak bakım', unit: 'ay', quantity: '1', unitPrice: '1000' }] });
    expect(po.status).toBe(422);
    expect(po.body.error.code).toBe('critical_blocker');
    const tasks = (await call('security', 'GET', '/api/v1/tasks?view=all')).body.items as { title: string; entityId: string }[];
    expect(tasks.some((t) => t.entityId === s1() && t.title.startsWith('Kritik engel'))).toBe(true);
    // Yeni ama incelenmemiş değerlendirme engeli kaldırmaz (boş taslakla T20 aşılamaz).
    const draft = await call('buyer', 'POST', '/api/v1/assessments', { supplierId: s1(), templateId: tpl, scope: 'Yeniden değerlendirme taslağı',
      inherentFactors: { dataSensitivity: 'LOW', accessLevel: 'LOW', criticality: 'LOW', substitutability: 'LOW', subcontractorDependence: 'LOW' } });
    expect(draft.status).toBe(201);
    expect((await call('buyer', 'POST', '/api/v1/purchase-orders', { companyId: h.world.companyA1.id, supplierId: s1(), contractVersionId: null, currency: 'TRY',
      lines: [{ kind: 'SERVICE', description: 'Uzak bakım', unit: 'ay', quantity: '1', unitPrice: '1000' }] })).body.error.code).toBe('critical_blocker');
    // Engel, bağımsız incelemesi tamamlanan yeni değerlendirmeyle giderilir; eski kayıt silinmez, yerini alır.
    await reviewedAssessment(h, s1(), tpl);
    const list = (await call('buyer', 'GET', `/api/v1/suppliers/${s1()}/assessments`)).body.items;
    expect(list.find((x: any) => x.id === id).status).toBe('SUPERSEDED');
    expect((await call('buyer', 'POST', '/api/v1/purchase-orders', { companyId: h.world.companyA1.id, supplierId: s1(), contractVersionId: null, currency: 'TRY',
      lines: [{ kind: 'SERVICE', description: 'Uzak bakım', unit: 'ay', quantity: '1', unitPrice: '1000' }] })).status).toBe(201);
  });

  // Görev 4 ayrımı: kritik engel, görev ve yerine geçme korunur; sipariş adımları (kaldırıldı) çıkarıldı. Seçim engeli sourcing T20'de.
  it('kritik kontrol "hayır": uyum %75 ama sonuç BLOCKED; sorumlulara görev düşer; incelenmemiş taslak engeli kaldırmaz, tamamlanan yeni değerlendirme yerini alır', async () => {
    const id = await reviewedAssessment(h, s1(), tpl, { 'ERS-01': 'NO' });
    const d = (await call('buyer', 'GET', `/api/v1/assessments/${id}`)).body;
    expect(d.complianceRate).toBe(75);
    expect(d.outcome).toBe('BLOCKED');
    const tasks = (await call('security', 'GET', '/api/v1/tasks?view=all')).body.items as { title: string; entityId: string }[];
    expect(tasks.some((t) => t.entityId === s1() && t.title.startsWith('Kritik engel'))).toBe(true);
    const draft = await call('buyer', 'POST', '/api/v1/assessments', { supplierId: s1(), templateId: tpl, scope: 'Yeniden değerlendirme taslağı', departmentId: h.world.departments.bt,
      inherentFactors: { dataSensitivity: 'LOW', accessLevel: 'LOW', criticality: 'LOW', substitutability: 'LOW', subcontractorDependence: 'LOW' } });
    expect(draft.status).toBe(201);
    expect((await call('buyer', 'GET', `/api/v1/suppliers/${s1()}/assessments`)).body.items.find((x: any) => x.id === id).status).not.toBe('SUPERSEDED');
    await reviewedAssessment(h, s1(), tpl);
    const list = (await call('buyer', 'GET', `/api/v1/suppliers/${s1()}/assessments`)).body.items;
    expect(list.find((x: any) => x.id === id).status).toBe('SUPERSEDED');
  });
});

describe('T19 olay: iddia ≠ doğrulanmış; itiraz; çift sayım yok', () => {
  const report = async (o: Record<string, unknown> = {}) => (await call('buyer', 'POST', '/api/v1/incidents', { supplierId: s2(), category: 'SLA', severity: 'HIGH',
    title: 'Ağ kesintisi 6 saat', description: 'SLA 4 saatlik müdahale süresi aşıldı (sentetik).', occurredOn: '2026-06-10', ...o })).body;
  const move = (id: string, action: string, extra: Record<string, unknown> = {}, who: Who = 'legal2') => call(who, 'POST', `/api/v1/incidents/${id}/transitions`, { action, note: 'Kayıtlar ve tedarikçi yanıtı incelendi (sentetik).', ...extra });

  it('bildiren doğrulayamaz; doğrulanmamış veya itirazlı olay puana yansımaz; SLA ölçümüne yansımış olay ayrıca ceza almaz; mükerrer tek sayılır', async () => {
    const a = await report();
    expect(a.code).toMatch(/^OLY-/);
    const dup = await report({ title: 'Ağ kesintisi (ikinci bildirim)', occurredOn: '2026-06-11' });
    expect(dup.possibleDuplicates.map((x: any) => x.id)).toContain(a.id);
    expect((await call('buyer', 'GET', `/api/v1/incidents/${a.id}`)).body.scoreImpact).toMatchObject({ counted: false, reason: 'İddia; doğrulanmadı.' });
    expect((await move(a.id, 'VERIFY')).status).toBe(409); // önce inceleme
    await move(a.id, 'START_REVIEW');
    expect((await move(a.id, 'VERIFY', {}, 'buyer')).status).toBe(403);
    expect((await move(a.id, 'VERIFY', { countedInMetric: false })).body.status).toBe('VERIFIED');
    expect((await call('buyer', 'GET', `/api/v1/incidents/${a.id}`)).body.scoreImpact).toMatchObject({ counted: true, penalty: 7 });
    expect((await move(a.id, 'DISPUTE', {}, 'auditor')).status).toBe(403); // itiraz cezayı askıya alır: yalnız doğrulama yetkisi (v2: denetçide yok)
    expect((await move(a.id, 'DISPUTE')).body.disputeOpen).toBe(true);
    expect(((await call('legal2', 'GET', '/api/v1/tasks?view=all')).body.items as { title: string }[]).some((t) => t.title === `İtiraz sonuçlandırma: ${a.code}`)).toBe(true);
    expect((await call('buyer', 'GET', `/api/v1/incidents/${a.id}`)).body.scoreImpact).toMatchObject({ counted: false, reason: 'Tedarikçi itirazı açık; kesinleşmedi.' });
    expect((await move(a.id, 'CLOSE')).status).toBe(409);
    await move(a.id, 'RESOLVE_DISPUTE', { upheld: true });
    expect((await move(dup.id, 'MARK_DUPLICATE', { duplicateOfId: a.id })).status).toBe(200);
    // Doğrulanmış olay sonradan mükerrer işaretlenip cezadan düşürülemez.
    expect((await move(a.id, 'MARK_DUPLICATE', { duplicateOfId: dup.id })).status).toBe(409);
    // Ölçüme yansımış SLA olayı: doğrulanır ama ayrıca ceza almaz.
    const m = await report({ title: 'Aylık SLA raporunda gecikme', occurredOn: '2026-07-02' });
    await move(m.id, 'START_REVIEW');
    await move(m.id, 'VERIFY', { countedInMetric: true });
    const sc = (await call('buyer', 'GET', `/api/v1/suppliers/${s2()}/scorecard?year=2026`)).body;
    const byId = Object.fromEntries(sc.incidents.items.map((x: any) => [x.id, x]));
    expect(byId[a.id].counted).toBe(true);
    expect(byId[dup.id]).toMatchObject({ counted: false, reason: 'Mükerrer kayıt; asıl olayda sayılır.' });
    expect(byId[m.id]).toMatchObject({ counted: false, reason: 'SLA ölçümüne zaten yansıdı; ayrıca ceza puanı yok.' });
    expect(sc.incidents.penalty).toBe(7);
  });

  it('itiraz haklı bulunursa olay reddedilir ve puandan düşer; geçmiş zaman çizelgesinde kalır', async () => {
    const a = await report({ severity: 'MEDIUM', occurredOn: '2026-08-01', title: 'Teslim gecikmesi iddiası', category: 'DELAY' });
    await move(a.id, 'START_REVIEW'); await move(a.id, 'VERIFY'); await move(a.id, 'DISPUTE', {}, 'security');
    expect((await move(a.id, 'RESOLVE_DISPUTE', { upheld: false })).body.status).toBe('REJECTED');
    const d = (await call('buyer', 'GET', `/api/v1/incidents/${a.id}`)).body;
    expect(d.scoreImpact.counted).toBe(false);
    expect(d.events.map((e: any) => e.kind)).toEqual(['REPORTED', 'REVIEW_STARTED', 'VERIFIED', 'DISPUTED', 'DISPUTE_RESOLVED']);
  });

  it('düzeltici faaliyet bağımsız doğrulanmadan olay kapanmaz; ciddi güvenlik olayı yeniden inceleme ve yeni işlem kararı görevi açar', async () => {
    const a = await report({ category: 'SECURITY', severity: 'CRITICAL', occurredOn: '2026-09-01', title: 'Yetkisiz uzak erişim', description: 'Paylaşılan hesapla erişim tespit edildi (sentetik).' });
    await move(a.id, 'START_REVIEW', {}, 'security'); await move(a.id, 'VERIFY', {}, 'security');
    const act = await call('security', 'POST', `/api/v1/incidents/${a.id}/actions`, { title: 'Paylaşılan hesapları kapat ve MFA zorunlu kıl', ownerRole: 'SECURITY', dueDate: '2026-11-30' });
    expect((await move(a.id, 'CLOSE', {}, 'security')).body.error.code).toBe('actions_open');
    // Yalnız sorumlu rol (SECURITY → v2 DEPARTMENT_USER) tamamlar: bölüm kullanıcısı rolü olmayan Satınalma kullanıcısı (legal) tamamlayamaz.
    const notOwner = await call('legal', 'POST', `/api/v1/corrective-actions/${act.body.id}/complete`, { note: 'Tedarikçi erişim listesini güncelledi (sentetik).' });
    expect(notOwner.status).toBe(403);
    expect(notOwner.body.error.code).toBe('not_owner');
    await call('security', 'POST', `/api/v1/corrective-actions/${act.body.id}/complete`, { note: 'Hesaplar kapatıldı, MFA raporu eklendi (sentetik).' });
    expect((await call('security', 'POST', `/api/v1/corrective-actions/${act.body.id}/verify`)).status).toBe(403);
    expect((await call('legal2', 'POST', `/api/v1/corrective-actions/${act.body.id}/verify`)).status).toBe(200);
    expect((await move(a.id, 'CLOSE', {}, 'security')).body.status).toBe('CLOSED');
    const tasks = (await call('security', 'GET', '/api/v1/tasks?view=all')).body.items as { title: string }[];
    expect(tasks.some((t) => t.title === `Risk yeniden incelemesi: ${a.code}`)).toBe(true);
    const pm = (await call('legal2', 'GET', '/api/v1/tasks?view=all')).body.items as { title: string }[];
    expect(pm.some((t) => t.title === `Yeni işlem kararı: ${a.code}`)).toBe(true);
  });
});

describe('performans ve yıllık karne', () => {
  it('örneklem yetersizse puan yok; inceleme ağırlıkları doğrulanır; karne kaynak ve veri anını gösterir', async () => {
    const future = await call('buyer', 'POST', `/api/v1/suppliers/${s2()}/performance-reviews`, { periodStart: '2026-01-01', periodEnd: '2099-12-31', category: 'BT hizmeti',
      scores: { quality: 90, delivery: 80, sla: 70, communication: 100, commercial: 60 }, basis: 'Gelecek dönem denemesi (sentetik).' });
    expect(future.body.error.code).toBe('invalid_period');
    const bad = await call('buyer', 'POST', `/api/v1/suppliers/${s2()}/performance-reviews`, { periodStart: '2026-01-01', periodEnd: '2026-06-30', category: 'BT hizmeti',
      weights: { quality: 50, delivery: 50, sla: 10, communication: 0, commercial: 0 }, scores: { quality: 90 }, basis: 'Kabul kayıtları ve SLA raporları (sentetik).' });
    expect(bad.body.error.code).toBe('invalid_weights');
    expect((await call('techEval', 'POST', `/api/v1/suppliers/${s2()}/performance-reviews`, { periodStart: '2026-01-01', periodEnd: '2026-06-30', category: 'BT', scores: {}, basis: 'Yetkisiz deneme (sentetik).' })).status).toBe(403); // v2: bölüm kullanıcısının yetkisi yok
    expect((await call('buyer', 'POST', `/api/v1/suppliers/${s2()}/performance-reviews`, { periodStart: '2026-01-01', periodEnd: new Date().toISOString().slice(0, 10), category: 'BT hizmeti',
      scores: { quality: 90, delivery: 80, sla: 70, communication: 100, commercial: 60 }, basis: 'Kabul kayıtları ve SLA raporları (sentetik).' })).status).toBe(201);
    const sc = (await call('auditor', 'GET', `/api/v1/suppliers/${s2()}/scorecard?year=2026`)).body;
    expect(sc.performance).toMatchObject({ score: null, insufficient: true });
    expect(sc.performance.reason).toMatch(/en az 5/);
    expect(sc.narrative[0]).toContain('puan verilmedi');
    expect(sc.dataAsOf).toBeTruthy();
    expect(sc.sources.length).toBeGreaterThan(0);
  });

  // v2 Faz 1 (D93): işlev onaylı kaldırma listesinde; davranış removed-v1.test.ts ile 403 olarak korunur
  it.skip('yeterli kabul örneğinde puan = ağırlıklı ortalama − doğrulanmış olay cezası', async () => {
    const po = await call('buyer', 'POST', '/api/v1/purchase-orders', { companyId: h.world.companyA1.id, supplierId: s2(), contractVersionId: null, currency: 'TRY',
      lines: [{ kind: 'GOODS', description: 'Sarf malzeme', unit: 'adet', quantity: '10', unitPrice: '10' }] });
    const line = (await call('buyer', 'GET', `/api/v1/purchase-orders/${po.body.id}`)).body.lines[0].poLineId;
    for (let i = 0; i < 5; i++) await call('buyer', 'POST', `/api/v1/po-lines/${line}/receipts`, { quantity: '1', note: `Teslim ${i + 1} (sentetik)` });
    const sc = (await call('buyer', 'GET', `/api/v1/suppliers/${s2()}/scorecard?year=${new Date().getFullYear()}`)).body;
    expect(sc.performance.sample).toBeGreaterThanOrEqual(5);
    expect(sc.performance.base).toBe(80);
    expect(sc.performance.score).toBe(80 - sc.incidents.penalty);
  });

  // Görev 4 ayrımı: karne puanı korunur. Sipariş ve mal kabul v2'de kaldırıldı; örneklem için eski (v1) kabul kayıtları test verisi olarak
  // modül işleviyle yazılır (API ucu değil). Bkz. rapor: yeni kabul kaydı oluşmadığı için örneklem yalnız eski kayıtlardan gelir.
  it('yeterli kabul örneğinde puan = ağırlıklı ortalama − doğrulanmış olay cezası (kabul kayıtları test verisi)', async () => {
    const ctx: TenantContext = { tenantId: h.world.tenantA, userId: h.world.users.buyer.id, roles: ['PROCUREMENT'], companyIds: [h.world.companyA1.id],
      departmentIds: [], allDepartments: true, correlationId: 'v2-legacy-receipts' };
    await withTenant(h.pool, ctx, async (tx) => {
      const po = await createPo(tx, ctx, { companyId: h.world.companyA1.id, supplierId: s2(), contractVersionId: null, currency: 'TRY',
        lines: [{ kind: 'GOODS', description: 'Sarf malzeme', unit: 'adet', quantity: '10', unitPrice: '10' }] } as never);
      const line = (await tx.query<{ id: string }>(`SELECT id FROM po_lines WHERE po_id = $1`, [po.id])).rows[0]!.id;
      for (let i = 0; i < 5; i++) await recordReceipt(tx, ctx, line, { quantity: '1', note: `Teslim ${i + 1} (sentetik)` });
    });
    const sc = (await call('buyer', 'GET', `/api/v1/suppliers/${s2()}/scorecard?year=${new Date().getFullYear()}`)).body;
    expect(sc.performance.sample).toBeGreaterThanOrEqual(5);
    expect(sc.performance.base).toBe(80);
    expect(sc.performance.score).toBe(80 - sc.incidents.penalty);
  });
});
