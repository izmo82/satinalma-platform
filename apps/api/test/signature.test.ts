// v2 Faz 1 (D93/D95): satınalmacı Satınalma rolünde kesinleştirir/istisna karar verebilir; yetkisiz rol örneği bölüm kullanıcısı, istisnada talep eden karar veremez
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHash, randomUUID } from 'node:crypto';
import { syntheticPdf } from '../src/devdata.ts';
import { processJobs } from '../src/worker.ts';
import { fixtureOutcomes, makeHarness } from './harness.ts';

let h: Awaited<ReturnType<typeof makeHarness>>;
beforeAll(async () => { h = await makeHarness(); });
afterAll(async () => { await h.close(); });

type Who = 'legal' | 'legal2' | 'buyer' | 'buyerB' | 'multi';

/** Sentetik sözleşme + iki taraf + taraf başına ıslak imza gereksinimi. */
async function setupContract(opts: { method?: string; methods?: string[]; custody?: boolean; pages?: number } = {}) {
  const pdf = syntheticPdf(Array.from({ length: opts.pages ?? 2 }, (_, i) => [`SENTETIK SOZLESME ${randomUUID()}`, `Sayfa ${i + 1}`]));
  const up = await h.upload('legal', { name: 'sozlesme.pdf', mime: 'application/pdf', data: pdf },
    { companyId: h.world.companyA1.id, kind: 'CONTRACT', title: 'Bakım Hizmet Sözleşmesi (SENTETİK)' });
  expect(up.status).toBe(201);
  const c = await h.call('legal', 'POST', '/api/v1/contracts', { body: {
    title: 'Bakım Hizmet Sözleşmesi (SENTETİK)', documentVersionId: up.body.documentVersionId, stage: 'EXECUTION',
    signatureMethod: opts.method ?? 'WET_IMAGE_REVIEW', originalCustodyRequired: opts.custody ?? false,
    parties: [{ role: 'BUYER', displayName: h.world.companyA1.name, legalEntityId: h.world.companyA1.id }, { role: 'SUPPLIER', displayName: 'Sentetik Bakım Ltd.' }],
  } });
  expect(c.status).toBe(201);
  const cv = c.body.contractVersionId as string;
  let st = await status(cv);
  const reqIds: Record<string, string> = {};
  for (const p of st.body.parties) {
    const r = await h.call('legal', 'POST', `/api/v1/contract-versions/${cv}/signature-requirements`, {
      headers: { 'if-match': st.headers.etag as string },
      body: { partyId: p.id, signerRole: 'Yetkili imzacı', acceptableMethods: opts.methods ?? ['WET_IMAGE_REVIEW'] } });
    expect(r.status).toBe(201);
    reqIds[p.role] = r.body.requirementId;
    st = await status(cv);
  }
  return { cv, reqIds, sha: up.body.sha256 as string, pdf, documentVersionId: up.body.documentVersionId as string };
}

const status = (cv: string, who: Who = 'legal', tenant?: string) =>
  h.call(who, 'GET', `/api/v1/contract-versions/${cv}/signature-status`, tenant ? { tenant } : {});

async function review(cv: string, requirementId: string, decision: string, observedMark: string, who: Who = 'legal', etag?: string) {
  const st = await status(cv);
  return h.call(who, 'POST', `/api/v1/contract-versions/${cv}/signature-reviews`, {
    headers: { 'if-match': etag ?? (st.headers.etag as string) },
    body: { requirementId, decision, observedMark, rationale: 'Kaynak sayfa 2 incelendi', documentSha256: st.body.contractVersion.documentSha256, page: 2 } });
}

const finalize = async (cv: string, etag?: string) => {
  const st = await status(cv);
  return h.call('legal', 'POST', `/api/v1/contract-versions/${cv}/finalize-signature-review`, { headers: etag === '' ? {} : { 'if-match': etag ?? (st.headers.etag as string) } });
};

const openTasks = async (cv: string, kind?: string) =>
  (await h.call('legal', 'GET', '/api/v1/tasks?view=all')).body.items.filter((t: any) => t.entityId === cv && (!kind || t.kind === kind));

describe('Otomatik tespit ve sağlayıcı yokluğu', () => {
  it('T24/SIG16: sağlayıcı yoksa otomatik kontrol yapılmış gösterilmez; manuel görev açılır; tekrar istek idempotent (T30)', async () => {
    const { cv } = await setupContract();
    h.config.signatureDetectorProvider = null;
    const a = await h.call('legal', 'POST', `/api/v1/contract-versions/${cv}/signature-analysis-jobs`);
    expect(a.status).toBe(202);
    expect(a.body).toMatchObject({ status: 'BLOCKED', errorCode: 'NO_PROVIDER_CONFIGURED' });
    const b = await h.call('legal', 'POST', `/api/v1/contract-versions/${cv}/signature-analysis-jobs`);
    expect(b.status).toBe(200);
    expect(b.body.reused).toBe(true);
    expect(b.body.jobId).toBe(a.body.jobId);
    expect(await openTasks(cv, 'SIGNATURE_AUTO_CHECK_UNAVAILABLE')).toHaveLength(1);
    const st = await status(cv);
    expect(st.body.status.automaticCheck).toBe('UNSUPPORTED');
    expect(st.body.status.automaticAlert).toBe('AUTOMATIC_CHECK_UNAVAILABLE');
    expect(st.body.status.overall).toBe('NOT_REVIEWED');
  });

  it('T25: algılayıcı imza bulamadı → uyarı + tek görev; insan kararı olmadan MISSING yok', async () => {
    const { cv, sha } = await setupContract();
    h.config.signatureDetectorProvider = 'test-fixture';
    fixtureOutcomes.set(sha, { status: 'NOT_DETECTED', processedPages: [1, 2], totalPages: 2, candidates: [] });
    const a = await h.call('legal', 'POST', `/api/v1/contract-versions/${cv}/signature-analysis-jobs`);
    expect(a.body.status).toBe('QUEUED');
    await processJobs(h.pool, h.store, 'test-fixture');
    await h.call('legal', 'POST', `/api/v1/contract-versions/${cv}/signature-analysis-jobs`);
    await processJobs(h.pool, h.store, 'test-fixture');
    const st = await status(cv);
    expect(st.body.status.automaticAlert).toBe('IMAGE_NOT_FOUND_REVIEW_REQUIRED');
    expect(st.body.status.requirements.every((r: any) => r.state === 'PENDING')).toBe(true);
    const tasks = await openTasks(cv, 'SIGNATURE_IMAGE_NOT_FOUND');
    expect(tasks).toHaveLength(1);
    expect(tasks[0].title).toContain('İmza görüntüsü bulunamadı — inceleme gerekli');
    expect(st.body.detectionRuns[0].provider).toBe('test-fixture'); // test sağlayıcısı açıkça etiketli
    h.config.signatureDetectorProvider = null;
  });

  it('aday bulunduğunda kaynak sayfa/konum ve hash ile saklanır (SIG05)', async () => {
    const { cv, sha } = await setupContract();
    h.config.signatureDetectorProvider = 'test-fixture';
    fixtureOutcomes.set(sha, { status: 'CANDIDATE_FOUND', processedPages: [1, 2], totalPages: 2,
      candidates: [{ page: 2, bbox: { x: 0.1, y: 0.8, w: 0.25, h: 0.06 }, rawConfidence: 0.71, status: 'CANDIDATE_FOUND' }] });
    await h.call('legal', 'POST', `/api/v1/contract-versions/${cv}/signature-analysis-jobs`);
    await processJobs(h.pool, h.store, 'test-fixture');
    const st = await status(cv);
    expect(st.body.detections).toEqual([expect.objectContaining({ page: 2, rawConfidence: '0.7100' })]);
    // T29: görüntü adayı insan kararı değildir
    expect(st.body.status.overall).toBe('NOT_REVIEWED');
    expect(await openTasks(cv, 'SIGNATURE_IMAGE_NOT_FOUND')).toHaveLength(0);
    h.config.signatureDetectorProvider = null;
  });
});

describe('İnsan incelemesi ve kesinleştirme', () => {
  it('T26/T33: tek taraf imzalı → INCOMPLETE; API finalize gereksinim bazlı 422', async () => {
    const { cv, reqIds } = await setupContract();
    expect((await review(cv, reqIds.BUYER!, 'IMAGE_CONFIRMED', 'FULL_SIGNATURE')).status).toBe(201);
    expect((await review(cv, reqIds.SUPPLIER!, 'MISSING', 'NONE')).status).toBe(201);
    const st = await status(cv);
    expect(st.body.status.overall).toBe('INCOMPLETE');
    expect(await openTasks(cv, 'SIGNATURE_MISSING')).toEqual([expect.objectContaining({ title: expect.stringContaining('Sentetik Bakım Ltd. tarafı imza eksik') })]);
    const f = await finalize(cv);
    expect(f.status).toBe(422);
    expect(f.body.error.code).toBe('unresolved_requirements');
    expect(f.body.error.details.blockers).toEqual([expect.objectContaining({ code: 'SIGNATURE_MISSING', requirementId: reqIds.SUPPLIER, partyName: 'Sentetik Bakım Ltd.' })]);
    expect((await finalize(cv, '')).status).toBe(428);
  });

  it('T27: kaşe/paraf/isim tam imza olarak teyit edilemez (API ve DB)', async () => {
    const { cv, reqIds } = await setupContract();
    for (const mark of ['STAMP_ONLY', 'INITIALS_ONLY', 'NAME_ONLY']) {
      const r = await review(cv, reqIds.SUPPLIER!, 'IMAGE_CONFIRMED', mark);
      expect(r.status).toBe(422);
    }
    const st = await status(cv);
    await expect(h.owner.query(
      `INSERT INTO signature_reviews (tenant_id, company_id, requirement_id, document_version_id, document_sha256, reviewer_id, decision, observed_mark, rationale)
       VALUES ($1,$2,$3,$4,$5,$6,'IMAGE_CONFIRMED','STAMP_ONLY','x x x')`,
      [h.world.tenantA, h.world.companyA1.id, reqIds.SUPPLIER, st.body.contractVersion.documentVersionId, st.body.contractVersion.documentSha256, h.world.users.legal.id],
    )).rejects.toThrow(/check constraint/);
    expect((await review(cv, reqIds.SUPPLIER!, 'MISSING', 'STAMP_ONLY')).status).toBe(201);
  });

  it('T32: eski ETag ile karar 409; kural değişince ETag değişir', async () => {
    const { cv, reqIds } = await setupContract();
    const before = await status(cv);
    const oldEtag = before.headers.etag as string;
    const third = await h.call('legal', 'POST', `/api/v1/contract-versions/${cv}/signature-requirements`, {
      headers: { 'if-match': oldEtag }, body: { partyId: before.body.parties[0].id, signerRole: 'İkinci imzacı', acceptableMethods: ['WET_IMAGE_REVIEW'] } });
    expect(third.status).toBe(201);
    const r = await review(cv, reqIds.BUYER!, 'IMAGE_CONFIRMED', 'FULL_SIGNATURE', 'legal', oldEtag);
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe('version_conflict');
  });

  it('tam kanıtla kesinleşir; kesinleşmiş sürüme karar ve gereksinim eklenemez; kayıtlar değişmez', async () => {
    const { cv, reqIds } = await setupContract();
    await review(cv, reqIds.BUYER!, 'IMAGE_CONFIRMED', 'FULL_SIGNATURE');
    await review(cv, reqIds.SUPPLIER!, 'IMAGE_CONFIRMED', 'FULL_SIGNATURE');
    const st = await status(cv);
    expect(st.body.status.overall).toBe('COMPLETE');
    expect(st.body.status.custody).toBe('UNKNOWN'); // görüntü teyidi asıl teyidi değildir
    const f = await finalize(cv);
    expect(f.status).toBe(200);
    expect(f.body.finalizedStatus).toBe('COMPLETE');
    expect((await review(cv, reqIds.BUYER!, 'MISSING', 'NONE')).status).toBe(409);
    expect(await openTasks(cv)).toHaveLength(0);
    await expect(h.owner.query(`UPDATE signature_reviews SET decision = 'MISSING' WHERE requirement_id = $1`, [reqIds.BUYER])).rejects.toThrow(/immutable_record/);
  });

  it('yetki: satınalmacı kesinleştiremez; istek UI dışından da reddedilir', async () => {
    const { cv } = await setupContract();
    const st = await status(cv);
    // v2 (D93): Satınalma kesinleştirir; kesinleştirme yetkisi olmayan rol bölüm kullanıcısıdır.
    const r = await h.call('techEval', 'POST', `/api/v1/contract-versions/${cv}/finalize-signature-review`, { headers: { 'if-match': st.headers.etag as string } });
    expect(r.status).toBe(403);
  });
});

describe('Sürümler', () => {
  it('T31/SIG09: yeni sürüm eski incelemeyi taşımaz; eski delil korunur; eski sürüme karar 409', async () => {
    const { cv, reqIds } = await setupContract();
    await review(cv, reqIds.BUYER!, 'IMAGE_CONFIRMED', 'FULL_SIGNATURE');
    await review(cv, reqIds.SUPPLIER!, 'IMAGE_CONFIRMED', 'FULL_SIGNATURE');
    const pdf2 = syntheticPdf([[`SENTETIK ZEYILNAME ${randomUUID()}`]]);
    const up2 = await h.upload('legal', { name: 'zeyil.pdf', mime: 'application/pdf', data: pdf2 }, { companyId: h.world.companyA1.id, kind: 'CONTRACT' });
    const old = await status(cv);
    const nv = await h.call('legal', 'POST', `/api/v1/contract-versions/${cv}/versions`, {
      headers: { 'if-match': old.headers.etag as string }, body: { documentVersionId: up2.body.documentVersionId, kind: 'AMENDMENT', stage: 'EXECUTION' } });
    expect(nv.status).toBe(201);
    const ns = await status(nv.body.contractVersionId);
    expect(ns.body.status.overall).toBe('NOT_REVIEWED');
    expect(ns.body.requirements).toHaveLength(2);
    expect(ns.body.reviews).toHaveLength(0);
    const os = await status(cv);
    expect(os.body.reviews).toHaveLength(2);
    expect(os.body.contractVersion.supersededById).toBe(nv.body.contractVersionId);
    const late = await review(cv, reqIds.BUYER!, 'MISSING', 'NONE', 'legal', os.headers.etag as string);
    expect(late.status).toBe(409);
    expect(late.body.error.code).toBe('version_superseded');
  });

  it('aynı hash yeni sürüm olarak eklenemez (T30)', async () => {
    const { cv, documentVersionId } = await setupContract();
    const st = await status(cv);
    const r = await h.call('legal', 'POST', `/api/v1/contract-versions/${cv}/versions`, {
      headers: { 'if-match': st.headers.etag as string }, body: { documentVersionId, kind: 'MAIN', stage: 'EXECUTION' } });
    expect(r.status).toBe(409);
  });
});

describe('E-imza, hibrit ve fiziksel asıl', () => {
  it('T34/T35: e-imza yönteminde ıslak uyarısı yok; doğrulayıcı yoksa NOT_CHECKED, VALIDATED/COMPLETE olmaz', async () => {
    const { cv, reqIds, sha } = await setupContract({ method: 'QUALIFIED_ELECTRONIC', methods: ['QUALIFIED_ELECTRONIC'] });
    h.config.signatureDetectorProvider = 'test-fixture';
    fixtureOutcomes.set(sha, { status: 'NOT_DETECTED', processedPages: [1, 2], totalPages: 2, candidates: [] });
    await h.call('legal', 'POST', `/api/v1/contract-versions/${cv}/signature-analysis-jobs`);
    await processJobs(h.pool, h.store, 'test-fixture');
    h.config.signatureDetectorProvider = null;
    const v = await h.call('legal', 'POST', `/api/v1/contract-versions/${cv}/digital-validation-jobs`, { body: { requirementId: reqIds.SUPPLIER } });
    expect(v.body).toEqual({ status: 'NOT_CHECKED', blockedReason: 'NO_VALIDATOR_CONFIGURED' });
    const st = await status(cv);
    expect(st.body.status.automaticAlert).toBeNull();
    expect(st.body.status.overall).toBe('NOT_REVIEWED');
    expect(st.body.status.requirements.every((r: any) => r.digital === 'NOT_CHECKED')).toBe(true);
    // Görsel inceleme e-imza gereksinimini karşılayamaz
    expect((await review(cv, reqIds.SUPPLIER!, 'IMAGE_CONFIRMED', 'FULL_SIGNATURE')).status).toBe(422);
    // Raporsuz VALIDATED DB'de de reddedilir
    await expect(h.owner.query(
      `INSERT INTO digital_validations (tenant_id, company_id, contract_version_id, requirement_id, signed_file_sha256, validator, status)
       VALUES ($1,$2,$3,$4,$5,'x','VALIDATED')`, [h.world.tenantA, h.world.companyA1.id, cv, reqIds.SUPPLIER, sha])).rejects.toThrow(/check constraint/);
  });

  it('T40: asıl bilinmiyor ama görüntü teyitli; yalnız politika zorunluysa blokaj', async () => {
    const { cv, reqIds } = await setupContract({ custody: true });
    await review(cv, reqIds.BUYER!, 'IMAGE_CONFIRMED', 'FULL_SIGNATURE');
    await review(cv, reqIds.SUPPLIER!, 'IMAGE_CONFIRMED', 'FULL_SIGNATURE');
    let st = await status(cv);
    expect(st.body.status.overall).toBe('INCOMPLETE');
    expect(st.body.status.blockers).toEqual([expect.objectContaining({ code: 'ORIGINAL_CUSTODY_NOT_CONFIRMED' })]);
    await h.call('legal', 'POST', `/api/v1/contract-versions/${cv}/original-custody-events`, { body: {
      status: 'RECEIPT_DECLARED', location: 'Merkez arşiv dolap 4', responsibleUserId: h.world.users.legal.id, occurredAt: '2026-10-20T09:00:00Z' } });
    expect((await status(cv)).body.status.overall).toBe('INCOMPLETE');
    await h.call('legal', 'POST', `/api/v1/contract-versions/${cv}/original-custody-events`, { body: {
      status: 'CUSTODY_CONFIRMED', location: 'Merkez arşiv dolap 4', responsibleUserId: h.world.users.legal.id, occurredAt: '2026-10-21T09:00:00Z' } });
    st = await status(cv);
    expect(st.body.status.overall).toBe('COMPLETE');
  });
});

describe('İstisna', () => {
  it('T36: SoD; istisna eksikliği gizlemez; süre dolunca kesinleşme geri alınır ve görev açılır', async () => {
    const { cv, reqIds } = await setupContract();
    await review(cv, reqIds.BUYER!, 'IMAGE_CONFIRMED', 'FULL_SIGNATURE');
    await review(cv, reqIds.SUPPLIER!, 'MISSING', 'NONE');
    const exp = new Date(Date.now() + 7 * 86400000).toISOString();
    const x = await h.call('legal', 'POST', `/api/v1/contract-versions/${cv}/signature-exceptions`, { body: {
      requirementIds: [reqIds.SUPPLIER], reason: 'Tedarikçi imzalı nüshayı kargoya verdi', residualRisk: 'Teslim gecikebilir',
      scope: 'Yalnız ilk ay hizmet başlangıcı', expiresAt: exp } });
    expect(x.status).toBe(201);
    const self = await h.call('legal', 'POST', `/api/v1/signature-exceptions/${x.body.exceptionId}/decision`, { body: { decision: 'APPROVED', rationale: 'ok' } });
    expect(self.status).toBe(403);
    expect((await h.call('techEval', 'POST', `/api/v1/signature-exceptions/${x.body.exceptionId}/decision`, { body: { decision: 'APPROVED', rationale: 'ok' } })).status).toBe(403);
    expect((await h.call('legal2', 'POST', `/api/v1/signature-exceptions/${x.body.exceptionId}/decision`, { body: { decision: 'APPROVED', rationale: 'Risk kabul edildi' } })).status).toBe(204);
    let st = await status(cv);
    expect(st.body.status.overall).toBe('EXCEPTION_ACTIVE');
    expect(st.body.status.underlying).toBe('INCOMPLETE');
    expect(st.body.status.blockers.length).toBeGreaterThan(0);
    const f = await finalize(cv);
    expect(f.body.finalizedStatus).toBe('EXCEPTION_ACTIVE');
    // Süre dolumu simülasyonu (yalnız test; owner bağlantısıyla)
    await h.owner.query(`UPDATE signature_exceptions SET expires_at = now() - interval '1 minute' WHERE id = $1`, [x.body.exceptionId]);
    st = await status(cv);
    expect(st.body.status.overall).toBe('INCOMPLETE');
    expect(st.body.contractVersion.finalizedAt).toBeNull();
    expect(await openTasks(cv, 'SIGNATURE_EXCEPTION_EXPIRED')).toHaveLength(1);
    await status(cv);
    expect(await openTasks(cv, 'SIGNATURE_EXCEPTION_EXPIRED')).toHaveLength(1);
  });
});

describe('T38 imza kayıtlarına erişim', () => {
  it('başka kiracı veya yetkisiz şirket kullanıcısı imza durumu ve belgeye erişemez', async () => {
    const { cv, documentVersionId } = await setupContract();
    expect((await status(cv, 'buyerB', h.world.tenantB)).status).toBe(404);
    // Aynı kiracı, okuma rolü var ama şirket kapsamı dışında (yalnız A2) → kayıt yok gibi.
    expect((await status(cv, 'multi', h.world.tenantA)).status).toBe(404);
    const content = await h.call('buyerB', 'GET', `/api/v1/document-versions/${documentVersionId}/content`, { tenant: h.world.tenantB });
    expect(content.status).toBe(404);
  });
});

describe('Belge içeriği bütünlüğü', () => {
  it('sözleşme PDF baytları değişmeden saklanır (T46)', async () => {
    const { documentVersionId, pdf } = await setupContract();
    const c = await h.call('legal', 'GET', `/api/v1/document-versions/${documentVersionId}/content`);
    expect(createHash('sha256').update(c.raw).digest('hex')).toBe(createHash('sha256').update(pdf).digest('hex'));
  });
});
