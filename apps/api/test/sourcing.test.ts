import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import ExcelJS from 'exceljs';
import { withTenant } from '../src/db.ts';
import { makeHarness } from './harness.ts';
import { syntheticPdf } from '../src/devdata.ts';
import { reviewedAssessment, securityTemplate } from './evalHelpers.ts';

// Faz 2 kabul testleri (09: T09–T12) gerçek PostgreSQL + RLS üzerinde. Tüm veri sentetik.
let h: Awaited<ReturnType<typeof makeHarness>>;
beforeAll(async () => { h = await makeHarness(); });
afterAll(async () => { await h.close(); });

const criteria = [
  { code: 'PRICE', name: 'Fiyat', kind: 'PRICE', weight: '60' },
  { code: 'TECH', name: 'Teknik uygunluk', kind: 'SCORE', weight: '40' },
];
const lines = [
  { lot: 'Lot 1', description: 'Sunucu bakımı', unit: 'ay', quantity: '12' },
  { lot: 'Lot 1', description: 'Yerinde destek', unit: 'saat', quantity: '480' },
  { lot: 'Lot 2', description: 'Lisans yenileme', unit: 'kullanıcı', quantity: '250' },
];
const inHours = (n: number) => new Date(Date.now() + n * 3600_000).toISOString();

async function newProject(title = `BT altyapı bakım hizmeti ${randomUUID().slice(0, 4)}`) {
  const r = await h.call('buyer', 'POST', '/api/v1/projects', { body: { companyId: h.world.companyA1.id, title, category: 'BT hizmetleri',
    need: 'Sentetik ihtiyaç', currency: 'TRY', budget: '1900000.00', budgetVerified: false, lines, criteria } });
  expect(r.status).toBe(201);
  return r.body as { id: string; code: string; etag: string };
}
const project = async (id: string, who: 'buyer' | 'legal2' = 'buyer') => (await h.call(who, 'GET', `/api/v1/projects/${id}`)).body;
async function publish(id: string, suppliers: string[]) {
  const p = await project(id);
  const req = await h.call('buyer', 'POST', `/api/v1/projects/${id}/rounds`, { body: { closesAt: inHours(48), supplierIds: suppliers }, headers: { 'if-match': p.project.etag } });
  expect(req.status).toBe(201);
  const dec = await h.call('legal2', 'POST', `/api/v1/rfq-rounds/${req.body.roundId}/decision`, { body: { approve: true } });
  expect(dec.status).toBe(200);
  return req.body.roundId as string;
}
const bidBody = (lineIds: string[], prices: [string, string, string], over: Partial<Record<number, { unit?: string; quantity?: string; scope?: string }>> = {}) => ({
  currency: 'TRY', validityDays: 60,
  lines: lineIds.map((id, i) => ({ projectLineId: id, unit: over[i]?.unit ?? lines[i]!.unit, quantity: over[i]?.quantity ?? lines[i]!.quantity,
    unitPrice: prices[i], scope: over[i]?.scope ?? 'INCLUDED' })),
});
async function uploadFile(who: 'supplier1' | 'supplier2', roundId: string, name: string, mime: string, data: Buffer) {
  const b = '----t' + randomUUID();
  const payload = Buffer.concat([Buffer.from(`--${b}\r\nContent-Disposition: form-data; name="title"\r\n\r\nTeknik föy\r\n`),
    Buffer.from(`--${b}\r\nContent-Disposition: form-data; name="file"; filename="${name}"\r\nContent-Type: ${mime}\r\n\r\n`), data, Buffer.from(`\r\n--${b}--\r\n`)]);
  const res = await h.app.inject({ method: 'POST', url: `/api/v1/portal/rounds/${roundId}/files`, payload,
    headers: { ...(await authHeaders(who)), 'content-type': `multipart/form-data; boundary=${b}` } });
  return { status: res.statusCode, body: JSON.parse(res.body) };
}
async function authHeaders(who: 'supplier1' | 'supplier2') {
  const { DevAuthProvider } = await import('../src/auth.ts');
  const auth = new DevAuthProvider('test-secret-'.padEnd(40, 'x'));
  return { authorization: `Bearer ${await auth.issue(`dev|${h.world.users[who].email}`)}`, 'x-tenant-id': h.world.tenantA };
}
const submit = (who: 'supplier1' | 'supplier2' | 'supplier3', roundId: string, body: unknown, key = randomUUID()) =>
  h.call(who, 'POST', `/api/v1/portal/rounds/${roundId}/bids`, { body, headers: { 'idempotency-key': key } });

describe('Proje ve yayın onayı', () => {
  it('taslak doğrulanır; yayını başlatan onaylayamaz (BR03); tedarikçi proje iç ekranına giremez', async () => {
    const bad = await h.call('buyer', 'POST', '/api/v1/projects', { body: { companyId: h.world.companyA1.id, title: 'Ağırlık hatalı', category: 'Genel', lines,
      criteria: [{ ...criteria[0], weight: '50' }, criteria[1]] } });
    expect(bad.body.error.code).toBe('invalid_criteria');
    const other = await h.call('buyer', 'POST', '/api/v1/projects', { body: { companyId: h.world.companyA2.id, title: 'Yetkisiz şirket', category: 'Genel', lines, criteria } });
    expect(other.status).toBe(403);

    const p = await newProject();
    expect(p.code).toMatch(/^PRJ-\d{4}-\d{4}$/);
    const snap = await project(p.id);
    const req = await h.call('buyer', 'POST', `/api/v1/projects/${p.id}/rounds`, { body: { closesAt: inHours(24), supplierIds: [h.world.suppliers.s1] }, headers: { 'if-match': snap.project.etag } });
    expect(req.status).toBe(201);
    // Satınalmacının onay yetkisi yok; yönetici de kendi başlattığını onaylayamaz (ayrı proje ile).
    expect((await h.call('buyer', 'POST', `/api/v1/rfq-rounds/${req.body.roundId}/decision`, { body: { approve: true } })).status).toBe(403);
    const p2 = (await h.call('legal2', 'POST', '/api/v1/projects', { body: { companyId: h.world.companyA1.id, title: 'Yönetici projesi', category: 'Genel', budget: '10', lines, criteria } })).body;
    const r2 = await h.call('legal2', 'POST', `/api/v1/projects/${p2.id}/rounds`, { body: { closesAt: inHours(24), supplierIds: [h.world.suppliers.s1] }, headers: { 'if-match': p2.etag } });
    const sod = await h.call('legal2', 'POST', `/api/v1/rfq-rounds/${r2.body.roundId}/decision`, { body: { approve: true } });
    expect(sod.status).toBe(403);
    expect(sod.body.error.code).toBe('segregation_of_duties');
    // Onay görevi yöneticinin İşlerim'inde.
    const tasks = (await h.call('legal2', 'GET', '/api/v1/tasks?view=mine')).body.items;
    expect(tasks.some((t: any) => t.entityId === p.id && t.title.startsWith('Yayın onayı'))).toBe(true);
    expect((await h.call('supplier1', 'GET', `/api/v1/projects/${p.id}`)).status).toBe(403);
    // Başka kiracı göremez (T01).
    expect((await h.call('buyerB', 'GET', `/api/v1/projects/${p.id}`, { tenant: h.world.tenantB })).status).toBe(404);
  });
});

describe('T09 tedarikçi portalı: yalnız kendi teklifi, kapanış sunucu saati', () => {
  let projectId: string; let roundId: string; let lineIds: string[]; let fileId: string;
  beforeAll(async () => {
    projectId = (await newProject()).id;
    roundId = await publish(projectId, [h.world.suppliers.s1, h.world.suppliers.s2]);
    lineIds = (await project(projectId)).lines.map((l: any) => l.id);
  });

  it('davetli tedarikçi kalemleri görür, bütçeyi görmez; davetsiz tedarikçi turu göremez', async () => {
    const r = await h.call('supplier1', 'GET', `/api/v1/portal/rounds/${roundId}`);
    expect(r.status).toBe(200);
    expect(r.body.lines).toHaveLength(3);
    expect(JSON.stringify(r.body)).not.toContain('1900000');
    expect(r.body.round.open).toBe(true);
    expect((await h.call('supplier3', 'GET', `/api/v1/portal/rounds/${roundId}`)).status).toBe(404);
    expect((await h.call('supplier3', 'GET', '/api/v1/portal/rounds')).body.items.some((x: any) => x.roundId === roundId)).toBe(false);
  });

  it('gönderim sürümlenir; aynı anahtarla tekrar ikinci kayıt açmaz; alındı zamanı sunucudan', async () => {
    const key = randomUUID();
    const a = await submit('supplier1', roundId, bidBody(lineIds, ['42000', '450', '1250']), key);
    expect(a.status).toBe(201);
    expect(a.body.versionNo).toBe(1);
    expect(Math.abs(new Date(a.body.submittedAt).getTime() - Date.now())).toBeLessThan(60_000);
    const replay = await submit('supplier1', roundId, bidBody(lineIds, ['1', '1', '1']), key);
    expect(replay.status).toBe(200);
    expect(replay.body.bidId).toBe(a.body.bidId);
    const v2 = await submit('supplier1', roundId, bidBody(lineIds, ['41500', '450', '1250']));
    expect(v2.body.versionNo).toBe(2);
    const mine = (await h.call('supplier1', 'GET', `/api/v1/portal/rounds/${roundId}`)).body;
    expect(mine.myBids.map((b: any) => b.status)).toEqual(['SUBMITTED', 'SUPERSEDED']);
  });

  it('başka tedarikçinin teklif kimliğiyle içerik okunamaz; alıcı kapanıştan önce içeriği göremez (RLS)', async () => {
    const s1Bid = (await h.call('supplier1', 'GET', `/api/v1/portal/rounds/${roundId}`)).body.current.id;
    const ctx = (userId: string, supplierId: string | null, companyIds: string[]) =>
      ({ tenantId: h.world.tenantA, userId, roles: [], companyIds, supplierId, correlationId: 't09' });
    const asS2 = await withTenant(h.pool, ctx(h.world.users.supplier2.id, h.world.suppliers.s2, []), async (tx) => ({
      bids: (await tx.query('SELECT id FROM bids WHERE id = $1', [s1Bid])).rowCount,
      lines: (await tx.query('SELECT id FROM bid_lines WHERE bid_id = $1', [s1Bid])).rowCount,
      budget: (await tx.query('SELECT 1 FROM projects WHERE id = $1', [projectId])).rowCount,
    }));
    expect(asS2).toEqual({ bids: 0, lines: 0, budget: 1 });
    const asBuyer = await withTenant(h.pool, ctx(h.world.users.buyer.id, null, [h.world.companyA1.id]), async (tx) => ({
      bids: (await tx.query('SELECT id FROM bids WHERE id = $1', [s1Bid])).rowCount,
      lines: (await tx.query('SELECT id FROM bid_lines WHERE bid_id = $1', [s1Bid])).rowCount,
    }));
    expect(asBuyer).toEqual({ bids: 1, lines: 0 });
    expect((await h.call('buyer', 'GET', `/api/v1/projects/${projectId}/comparison`)).body.error.code).toBe('bids_sealed');
    expect((await h.call('supplier2', 'POST', `/api/v1/bids/${s1Bid}/scores`, { body: { criterionCode: 'TECH', score: '0', evidence: 'rakip teklifi düşürme denemesi' } })).status).toBe(403);
  });

  it('teklif ekleri: kontrol, tekrar yüklemede tek kayıt, sürüme bağlanır; alıcı ve rakip kapanıştan önce indiremez', async () => {
    const pdf = syntheticPdf([['Teknik föy (SENTETİK)', 'Kapasite ve SLA']]);
    const up = await uploadFile('supplier1', roundId, 'teknik.pdf', 'application/pdf', pdf);
    expect(up.status).toBe(201);
    expect(up.body.status).toBe('PASSED');
    const again = await uploadFile('supplier1', roundId, 'teknik-kopya.pdf', 'application/pdf', pdf);
    expect(again.status).toBe(200);
    expect(again.body.id).toBe(up.body.id);
    expect((await uploadFile('supplier1', roundId, 'kotu.pdf', 'application/pdf', Buffer.from('MZ not a pdf'))).status).toBe(422);
    const v = await submit('supplier1', roundId, { ...bidBody(lineIds, ['41500', '450', '1250']), attachmentIds: [up.body.id] });
    expect(v.status).toBe(201);
    const mine = (await h.call('supplier1', 'GET', `/api/v1/portal/rounds/${roundId}`)).body;
    expect(mine.current.attachmentIds).toEqual([up.body.id]);
    expect(mine.files).toHaveLength(1);
    // Başka tedarikçinin dosyası sürüme eklenemez; içerik mühürlü.
    expect((await submit('supplier2', roundId, { ...bidBody(lineIds, ['1', '1', '1']), attachmentIds: [up.body.id] })).body.error.code).toBe('unknown_attachment');
    expect((await h.call('supplier2', 'GET', `/api/v1/bid-files/${up.body.id}/content`)).status).toBe(404);
    expect((await h.call('buyer', 'GET', `/api/v1/bid-files/${up.body.id}/content`)).status).toBe(404);
    const own = await h.call('supplier1', 'GET', `/api/v1/bid-files/${up.body.id}/content`);
    expect(own.status).toBe(200);
    expect(Buffer.compare(own.raw as Buffer, pdf)).toBe(0);
    fileId = up.body.id;
  });

  it('aynı tedarikçinin eşzamanlı gönderimleri çakışmaz: her biri ayrı sürüm, tek geçerli', async () => {
    const rs = await Promise.all(Array.from({ length: 5 }, () => submit('supplier2', roundId, bidBody(lineIds, ['40000', '400', '1100']))));
    expect(rs.map((r) => r.status)).toEqual([201, 201, 201, 201, 201]);
    expect(new Set(rs.map((r) => r.body.versionNo)).size).toBe(5);
    const mine = (await h.call('supplier2', 'GET', `/api/v1/portal/rounds/${roundId}`)).body;
    expect(mine.myBids.filter((b: any) => b.status === 'SUBMITTED')).toHaveLength(1);
  });

  it('kapanış sunucu saatine göre: süre dolunca API ve veritabanı reddeder', async () => {
    await h.owner.query(`UPDATE rfq_rounds SET closes_at = now() - interval '1 second' WHERE id = $1`, [roundId]);
    const late = await submit('supplier2', roundId, bidBody(lineIds, ['1', '1', '1']));
    expect(late.status).toBe(409);
    expect(late.body.error.code).toBe('round_closed');
    // API atlansa da tetikleyici reddeder.
    await expect(withTenant(h.pool, { tenantId: h.world.tenantA, userId: h.world.users.supplier2.id, roles: [], companyIds: [], supplierId: h.world.suppliers.s2, correlationId: 't09' },
      (tx) => tx.query(`INSERT INTO bids (tenant_id, company_id, project_id, round_id, supplier_id, version_no, currency, idempotency_key, submitted_by)
        VALUES ($1,$2,$3,$4,$5,1,'TRY',$6,$7)`, [h.world.tenantA, h.world.companyA1.id, projectId, roundId, h.world.suppliers.s2, randomUUID(), h.world.users.supplier2.id])))
      .rejects.toThrow(/round_closed/);
    expect((await h.call('supplier2', 'POST', `/api/v1/portal/rounds/${roundId}/questions`, { body: { question: 'Geç soru' } })).status).toBe(409);
    // Kapanıştan sonra: ek yüklenemez; alıcı eki indirebilir (okuma denetim kaydına yazılır).
    expect((await uploadFile('supplier1', roundId, 'gec.pdf', 'application/pdf', syntheticPdf([['Geç']]))).status).toBe(409);
    expect((await h.call('buyer', 'GET', `/api/v1/bid-files/${fileId}/content`)).status).toBe(200);
    const read = await h.owner.query(`SELECT 1 FROM audit_events WHERE action = 'bid.file_read' AND entity_id = $1`, [fileId]);
    expect(read.rowCount).toBeGreaterThanOrEqual(2);
    const cmp = (await h.call('buyer', 'GET', `/api/v1/projects/${projectId}/comparison`)).body;
    expect(cmp.bids.find((b: any) => b.attachments.length)?.attachments[0].id).toBe(fileId);
  });
});

describe('T10–T12 karşılaştırma, eskime ve bölünmüş tahsis', () => {
  let projectId: string; let roundId: string; let lineIds: string[]; const bidOf: Record<string, string> = {};
  beforeAll(async () => {
    projectId = (await newProject()).id;
    roundId = await publish(projectId, [h.world.suppliers.s1, h.world.suppliers.s2, h.world.suppliers.s3]);
    // Tasarruf bazı teklifler açılmadan önerilir ve ikinci kişi (finans) onaylar; rapor yalnız onaylı bazla seçim tutarını karşılaştırır.
    const base = await h.call('buyer', 'POST', `/api/v1/projects/${projectId}/savings-baselines`, { body: { basis: 'PREVIOUS_PRICE', amount: '1100000.00', source: 'Önceki dönem sözleşme bedeli (sentetik).' } });
    expect((await h.call('finance', 'POST', `/api/v1/savings-baselines/${base.body.id}/decision`, { body: { approve: true } })).body.status).toBe('APPROVED');
    lineIds = (await project(projectId)).lines.map((l: any) => l.id);
    bidOf.s1 = (await submit('supplier1', roundId, bidBody(lineIds, ['42000', '450', '1250']))).body.bidId;
    // En ucuz görünen ama lisansı "paket" biriminde veren teklif (T10).
    bidOf.s2 = (await submit('supplier2', roundId, bidBody(lineIds, ['30000', '300', '100000'], { 2: { unit: 'paket', quantity: '1' } }))).body.bidId;
    bidOf.s3 = (await submit('supplier3', roundId, bidBody(lineIds, ['41000', '440', '1200']))).body.bidId;
    // Soru-cevap: yanıt tüm davetlilere aynı metinle, soranın kimliği olmadan.
    const q = await h.call('supplier2', 'POST', `/api/v1/portal/rounds/${roundId}/questions`, { body: { question: 'Lisanslar kullanıcı başına mı?' } });
    expect((await h.call('buyer', 'POST', `/api/v1/rfq-questions/${q.body.id}/answer`, { body: { answer: 'Evet, adlandırılmış kullanıcı başına.' } })).status).toBe(200);
    const seen = (await h.call('supplier1', 'GET', `/api/v1/portal/rounds/${roundId}`)).body.questions;
    expect(seen).toEqual([expect.objectContaining({ question: 'Lisanslar kullanıcı başına mı?', answer: 'Evet, adlandırılmış kullanıcı başına.', mine: false })]);
    expect(JSON.stringify(seen)).not.toContain('Ege');
    // Yetkili erken kapanış gerekçe ister.
    expect((await h.call('legal2', 'POST', `/api/v1/rfq-rounds/${roundId}/close`, { body: { reason: 'kısa' } })).status).toBe(422);
    expect((await h.call('legal2', 'POST', `/api/v1/rfq-rounds/${roundId}/close`, { body: { reason: 'Tüm davetliler teklif verdi; kurul tarihi öne alındı.' } })).status).toBe(200);
  });

  it('T10: düşük fiyat ama yanlış birim karşılaştırılamaz; eksik kapsam görünür, sıralamaya girmez', async () => {
    const c = (await h.call('buyer', 'GET', `/api/v1/projects/${projectId}/comparison`)).body;
    const s2 = c.comparison.bids.find((b: any) => b.bidId === bidOf.s2);
    expect(s2.complete).toBe(false);
    expect(s2.lines[2].state).toBe('UNIT_MISMATCH');
    expect(s2.tco).toBeNull();
    expect(s2.rank).toBeNull();
    expect(c.comparison.lowestTco).toBe('1003200.00'); // Kuzey: 492000 + 211200 + 300000
  });

  it('teknik puan kanıt ister ve tedarikçi puanlayamaz; fiyat puanı elle girilemez', async () => {
    expect((await h.call('techEval', 'POST', `/api/v1/bids/${bidOf.s1}/scores`, { body: { criterionCode: 'TECH', score: '80', evidence: 'kısa' } })).status).toBe(422);
    expect((await h.call('techEval', 'POST', `/api/v1/bids/${bidOf.s1}/scores`, { body: { criterionCode: 'PRICE', score: '100', evidence: 'fiyat puanını elle verme denemesi' } })).status).toBe(422);
    for (const [b, s] of [[bidOf.s1, '85'], [bidOf.s3, '70']] as const) {
      expect((await h.call('techEval', 'POST', `/api/v1/bids/${b}/scores`, { body: { criterionCode: 'TECH', score: s, evidence: 'Referans ziyareti ve SLA ekine göre değerlendirildi (sentetik).' } })).status).toBe(200);
    }
  });

  it('T20: kritik güvenlik engeli olan tedarikçiye seçim önerilemez; yüksek ağırlıklı puan engeli aşmaz', async () => {
    const tpl = await securityTemplate(h);
    await reviewedAssessment(h, h.world.suppliers.s1, tpl, { 'ERS-01': 'NO' });
    const ev = await h.call('buyer', 'POST', `/api/v1/projects/${projectId}/evaluations`);
    const all = [{ projectLineId: lineIds[0], supplierId: h.world.suppliers.s1, quantity: '12' }, { projectLineId: lineIds[1], supplierId: h.world.suppliers.s1, quantity: '480' },
      { projectLineId: lineIds[2], supplierId: h.world.suppliers.s3, quantity: '250' }];
    const r = await h.call('buyer', 'POST', `/api/v1/projects/${projectId}/awards`, { body: { evaluationId: ev.body.id, rationale: 'En yüksek ağırlıklı puan (sentetik).', allocations: all } });
    expect(r.status).toBe(422);
    expect(r.body.error.code).toBe('critical_blocker');
    expect(r.body.error.message).toContain('ticari puan bu engeli aşmaz');
    // Engel giderildiğinde (yeni değerlendirme önceki sonucu geçersiz kılar) seçim akışı devam eder.
    await reviewedAssessment(h, h.world.suppliers.s1, tpl);
  });

  it('T11 + T12: ağırlık değişince eski değerlendirme güncel sayılmaz; bölünmüş tahsis miktar ve aktif firma kontrolünden geçer', async () => {
    const ev1 = await h.call('buyer', 'POST', `/api/v1/projects/${projectId}/evaluations`);
    expect(ev1.status).toBe(201);
    const split = (q1: string, q3: string) => [
      { projectLineId: lineIds[0], supplierId: h.world.suppliers.s1, quantity: '12' },
      { projectLineId: lineIds[1], supplierId: h.world.suppliers.s1, quantity: q1 },
      { projectLineId: lineIds[1], supplierId: h.world.suppliers.s3, quantity: q3 },
      { projectLineId: lineIds[2], supplierId: h.world.suppliers.s3, quantity: '250' },
    ];
    // Ağırlık değişikliği gerekçesiz olmaz; olunca değerlendirme v1 eskir.
    const p = await project(projectId);
    expect((await h.call('buyer', 'POST', `/api/v1/projects/${projectId}/criteria-revisions`, { body: { criteria, reason: 'kısa' }, headers: { 'if-match': p.project.etag } })).status).toBe(422);
    const rev = await h.call('buyer', 'POST', `/api/v1/projects/${projectId}/criteria-revisions`, {
      body: { criteria: [{ ...criteria[0], weight: '50' }, { ...criteria[1], weight: '50' }], reason: 'Kurul teknik ağırlığı artırdı (sentetik gerekçe).' }, headers: { 'if-match': p.project.etag } });
    expect(rev.status).toBe(200);
    const after = await project(projectId);
    expect(after.evaluations.find((e: any) => e.id === ev1.body.id).current).toBe(false);
    const stale = await h.call('buyer', 'POST', `/api/v1/projects/${projectId}/awards`, { body: { evaluationId: ev1.body.id, rationale: 'En yüksek ağırlıklı puan ve kapasite bölüşümü.', allocations: split('300', '180') } });
    expect(stale.status).toBe(409);
    expect(stale.body.error.code).toBe('evaluation_stale');

    const ev2 = (await h.call('buyer', 'POST', `/api/v1/projects/${projectId}/evaluations`)).body;
    expect(ev2.versionNo).toBe(ev1.body.versionNo + 1);
    const over = await h.call('buyer', 'POST', `/api/v1/projects/${projectId}/awards`, { body: { evaluationId: ev2.id, rationale: 'Aşım denemesi (sentetik).', allocations: split('300', '200') } });
    expect(over.body.error.details.issues.map((i: any) => i.code)).toContain('over_allocated');
    const notComparable = await h.call('buyer', 'POST', `/api/v1/projects/${projectId}/awards`, { body: { evaluationId: ev2.id, rationale: 'Karşılaştırılamayan kalem (sentetik).',
      allocations: [{ projectLineId: lineIds[2], supplierId: h.world.suppliers.s2, quantity: '250' }] } });
    expect(notComparable.body.error.details.issues.map((i: any) => i.code)).toEqual(['not_comparable']);

    const award = await h.call('buyer', 'POST', `/api/v1/projects/${projectId}/awards`, { body: { evaluationId: ev2.id, rationale: 'Teknik puan ve kapasite nedeniyle destek saatleri iki tedarikçiye bölündü (sentetik).', allocations: split('300', '180') } });
    expect(award.status).toBe(201);
    expect(award.body.total).toBe('1018200.00'); // 12×42000 + 300×450 + 180×440 + 250×1200
    expect(award.body.warnings[0]).toMatch(/aktif değil/);
    // Aday firma (Kuzey) aktivasyon olmadan kesin kazanan olamaz (BR02).
    const blocked = await h.call('legal2', 'POST', `/api/v1/awards/${award.body.id}/decision`, { body: { approve: true } });
    expect(blocked.status).toBe(422);
    expect(blocked.body.error.code).toBe('award_blocked');
    await h.owner.query(`UPDATE suppliers SET status = 'ACTIVE', activated_by = $2, activated_at = now() WHERE id = $1`, [h.world.suppliers.s3, h.world.users.masterData.id]);
    // Seçim önerisi verildikten sonra (teklif tutarı biliniyor) baz önerilemez.
    expect((await h.call('buyer', 'POST', `/api/v1/projects/${projectId}/savings-baselines`, { body: { basis: 'MARKET', amount: '1.00', source: 'Öneri sonrası baz denemesi.' } })).status).toBe(409);
    expect((await h.call('buyer', 'POST', `/api/v1/awards/${award.body.id}/decision`, { body: { approve: true } })).status).toBe(403);
    const ok = await h.call('legal2', 'POST', `/api/v1/awards/${award.body.id}/decision`, { body: { approve: true, note: 'Kurul onayı (sentetik).' } });
    expect(ok.status).toBe(200);
    const final = await project(projectId);
    expect(final.project.status).toBe('CONTRACTING');
    expect(final.awards[0].lines).toHaveLength(4);
    expect((await h.call('buyer', 'POST', `/api/v1/projects/${projectId}/savings-baselines`, { body: { basis: 'MARKET', amount: '1.00', source: 'Karar sonrası baz denemesi.' } })).status).toBe(409);
    const year = new Date().getFullYear();
    const rep = await h.call('auditor', 'GET', `/api/v1/reports/summary?from=${year}-01-01&to=${year}-12-31&fresh=true`);
    expect(rep.body.indicators.find((i: any) => i.key === 'savings')).toMatchObject({ status: 'OK', values: [{ currency: 'TRY', numerator: '81800.00', denominator: '1100000.00' }] });
  });

  it('XLSX raporu deterministik: kaynak teklif sürümü, formül, kur varsayımı; metin hücreleri formül olarak çalışmaz', async () => {
    const ev = (await project(projectId)).evaluations[0];
    const r = await h.call('buyer', 'GET', `/api/v1/evaluations/${ev.id}/report.xlsx`);
    expect(r.status).toBe(200);
    expect(String(r.headers['content-type'])).toContain('spreadsheetml');
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(r.raw as any);
    const sum = wb.getWorksheet('Özet')!;
    expect(String(sum.getCell('A1').value)).toBe('Proje');
    expect(String(sum.getCell('B5').value)).toBe('Evet');
    const d = wb.getWorksheet('Kalemler')!;
    const formulas = [] as string[];
    d.eachRow((row, n) => { if (n > 1) { const v = row.getCell(12).value as any; if (v?.formula) formulas.push(v.formula); } });
    expect(formulas.length).toBeGreaterThan(0);
    expect(formulas[0]).toMatch(/^ROUND\(C\d+\*K\d+,2\)$/);
    expect(String(d.getCell('M2').value)).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('PDF karar özeti: tahsis ve onay bilgisiyle üretilir', async () => {
    const ev = (await project(projectId)).evaluations[0];
    const r = await h.call('buyer', 'GET', `/api/v1/evaluations/${ev.id}/decision.pdf`);
    expect(r.status).toBe(200);
    expect(String(r.headers['content-type'])).toBe('application/pdf');
    const buf = r.raw as Buffer;
    expect(buf.subarray(0, 5).toString('latin1')).toBe('%PDF-');
    // Boş sayfa üretilmez (altbilgi yeni sayfa açmamalı): bu küçük projede içerik 1–2 sayfa.
    const pages = (buf.toString('latin1').match(/\/Type \/Page\b/g) ?? []).length;
    expect(pages).toBeGreaterThanOrEqual(1);
    expect(pages).toBeLessThanOrEqual(2);
    expect((await h.call('supplier1', 'GET', `/api/v1/evaluations/${ev.id}/decision.pdf`)).status).toBe(403);
  });

  it('İşlerim: kayıt no görevin kaydından gelir; sekme sayıları aynı yetki sınırıyla', async () => {
    const r = (await h.call('legal2', 'GET', '/api/v1/tasks?view=all')).body;
    expect(r.counts).toEqual(expect.objectContaining({ mine: expect.any(Number), overdue: expect.any(Number), all: r.items.length }));
    const projectTask = r.items.find((t: any) => t.entityType === 'project');
    expect(projectTask?.refNo).toMatch(/^PRJ-\d{4}-\d{4}$/);
    // Tedarikçi portal kullanıcısı İşlerim'e erişemez.
    expect((await h.call('supplier1', 'GET', '/api/v1/tasks')).status).toBe(403);
  });
});
