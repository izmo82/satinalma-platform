// v2 Faz 4 Görev 5 (R14): kanıt belgesi okuma altyapısı (AI15) — Faz 7 kural motoru tüketir; ekran/uç yok.
// requestEvidenceReading → defter (konu belge sürümü) → işçi → ai_evidence_readings (bir kez, değişmez). Alıntısı doğrulanmayan cevap UNCLEAR.
// Sağlayıcı yalnız bu dosyada kayıtlı `test-fixture`: çıktısı GERÇEK OKUMA DEĞİLDİR. Veriler sentetik.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { createSyntheticWorld, ensureTestAiCatalog, ensureTestAiPolicy, syntheticPdf, type SyntheticWorld } from '../src/devdata.ts';
import { DevAuthProvider } from '../src/auth.ts';
import { DEFAULT_AI_MODEL_ID } from '../src/config.ts';
import { withTenant, type TenantContext } from '../src/db.ts';
import { registerAiProvider, type AiProvider } from '../src/ai/provider.ts';
import { testFixtureProvider } from '../src/ai/testProvider.ts';
import { PROMPT_VERSIONS } from '../src/ai/prompts.ts';
import { evidenceReadings, requestEvidenceReading } from '../src/modules/contractAi.ts';
import { processJobs } from '../src/worker.ts';
import { makeHarness } from './harness.ts';

const fixture = testFixtureProvider();
registerAiProvider(fixture);

let h: Awaited<ReturnType<typeof makeHarness>>;
let auth: DevAuthProvider;
beforeAll(async () => {
  h = await makeHarness();
  auth = new DevAuthProvider(h.config.devAuthSecret!);
  await ensureTestAiCatalog(h.owner, DEFAULT_AI_MODEL_ID);
});
afterAll(async () => { registerAiProvider(fixture); await h.close(); });

const fresh = () => createSyntheticWorld(h.owner, `-${randomUUID().slice(0, 8)}`);
const parse = (b: string) => { try { return b ? JSON.parse(b) : null; } catch { return b; } };
const ctxOf = (w: SyntheticWorld, tenantId = w.tenantA, userId = w.users.buyer.id, companyIds = [w.companyA1.id]): TenantContext => ({
  userId, tenantId, roles: ['PROCUREMENT'], companyIds, departmentIds: [], allDepartments: true, correlationId: randomUUID(),
});
async function upload(w: SyntheticWorld, pdf: Buffer): Promise<string> {
  const token = await auth.issue(`dev|${w.users.buyer.email}`);
  const boundary = '----sp' + randomUUID();
  const fields = { companyId: w.companyA1.id, kind: 'OTHER', title: `Kanıt belgesi ${randomUUID().slice(0, 4)} (SENTETİK)` };
  const parts: Buffer[] = [];
  for (const [k, v] of Object.entries(fields)) parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`));
  parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="kanit.pdf"\r\nContent-Type: application/pdf\r\n\r\n`), pdf,
    Buffer.from(`\r\n--${boundary}--\r\n`));
  const res = await h.app.inject({ method: 'POST', url: '/api/v1/documents', payload: Buffer.concat(parts),
    headers: { authorization: `Bearer ${token}`, 'x-tenant-id': w.tenantA, 'content-type': `multipart/form-data; boundary=${boundary}` } });
  expect([200, 201], res.body).toContain(res.statusCode);
  return parse(res.body).documentVersionId;
}
async function runWorker() { for (let i = 0; i < 10; i++) { if (!(await processJobs(h.pool, h.store, null, 10, null))) break; } }
const PDF = () => syntheticPdf([
  ['SENTETIK KANIT BELGESI - gercek degildir', 'Teslimat tutanagi', 'Malzemeler eksiksiz teslim edildi ve kabul edildi.', 'Garanti belgesi teslim edilmedi.'],
  ['Ek sayfa', 'Kurulum egitimi verildi ve katilim listesi imzalandi.'],
]);
const QUESTIONS = [
  { id: 'delivered', text: 'Malzemeler eksiksiz teslim edildi mi?' },
  { id: 'training', text: 'Kurulum egitimi verildi mi?' },
  { id: 'insurance', text: 'Sigorta poliçesi sunuldu mu?' },
];

describe('kanıt okuma (AI15, R14)', () => {
  it('istek defterde (konu belge sürümü, istem sürümü); işçi sonrası kayıt bir kez açılır; doğrulanmış alıntı YES, eşleşme yok UNCLEAR', async () => {
    const w = await fresh();
    await ensureTestAiPolicy(h.owner, w.tenantA);
    const dv = await upload(w, PDF());
    const r = await withTenant(h.pool, ctxOf(w), (tx) => requestEvidenceReading(tx, ctxOf(w), { documentVersionId: dv, purpose: 'Kabul kuralı K1 (sentetik)', questions: QUESTIONS }));
    expect(r.status).toBe('QUEUED');
    const run = (await h.owner.query(`SELECT * FROM ai_runs WHERE id = $1`, [r.runId])).rows[0];
    expect(run).toMatchObject({ task: 'AI15', entity_type: 'document_version', entity_id: dv, document_version_id: dv, prompt_version: PROMPT_VERSIONS.AI15,
      requested_by: w.users.buyer.id, company_id: w.companyA1.id });
    expect(run.idempotency_key).toMatch(new RegExp(`^AI15:document_version:${dv}:${dv}:q-[0-9a-f]{20}:${PROMPT_VERSIONS.AI15}$`));
    // Defterde soru/belge metni yok; sorular yalnız iş yükünde.
    expect(JSON.stringify(run)).not.toContain('Malzemeler');
    // Aynı soru kümesi → aynı satır (yeni ücret yok); farklı küme → ayrı satır.
    const again = await withTenant(h.pool, ctxOf(w), (tx) => requestEvidenceReading(tx, ctxOf(w), { documentVersionId: dv, purpose: 'Kabul kuralı K1 (sentetik)', questions: QUESTIONS }));
    expect(again.runId).toBe(r.runId);
    expect((await withTenant(h.pool, ctxOf(w), (tx) => evidenceReadings(tx, dv)))).toEqual([]);

    await runWorker();
    expect((await h.owner.query(`SELECT status, actual_cost::text, response_model FROM ai_runs WHERE id = $1`, [r.runId])).rows[0])
      .toEqual({ status: 'SUCCEEDED', actual_cost: '0.010000', response_model: 'test-fixture' });
    const list = await withTenant(h.pool, ctxOf(w), (tx) => evidenceReadings(tx, dv));
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ runId: r.runId, documentVersionId: dv, purpose: 'Kabul kuralı K1 (sentetik)', questions: QUESTIONS, modelId: 'test-fixture',
      promptVersion: PROMPT_VERSIONS.AI15, isTestProvider: true, providerLabel: 'Test sağlayıcısı — gerçek değil' });
    const a = Object.fromEntries(list[0]!.answers.map((x) => [x.questionId, x]));
    expect(a.delivered).toMatchObject({ answer: 'YES', page: 1, quote: expect.stringContaining('eksiksiz teslim edildi') });
    expect(a.training).toMatchObject({ answer: 'YES', page: 2 });
    expect(a.insurance).toMatchObject({ answer: 'UNCLEAR', quote: null });
    // Değişmez kayıt.
    await expect(h.owner.query(`UPDATE ai_evidence_readings SET purpose = 'x' WHERE id = $1`, [list[0]!.id])).rejects.toThrow();
    // Yapay zekâ sayfasındaki "Yeniden dene" AI15'i yeniden yönlendirmez (sorular isteyen kuraldan gelir).
    const token = await auth.issue(`dev|${w.users.buyer.email}`);
    const retry = await h.app.inject({ method: 'POST', url: `/api/v1/ai/runs/${r.runId}/retry`, headers: { authorization: `Bearer ${token}`, 'x-tenant-id': w.tenantA } });
    expect(retry.statusCode).toBe(422);
  });

  it('alıntı doğrulanmazsa UNCLEAR; model anahtarları yok sayılır; başka kiracı göremez; geçersiz girdi reddedilir', async () => {
    const w = await fresh();
    await ensureTestAiPolicy(h.owner, w.tenantA);
    const dv = await upload(w, PDF());
    const liar: AiProvider = {
      name: 'test-fixture',
      async run(modelId, input) {
        const res = await fixture.run(modelId, input);
        return { ...res, output: { decision: 'APPROVE', answers: [
          { questionId: 'delivered', answer: 'YES', quote: 'Tum malzemeler fazlasiyla teslim edildi.', page: 1, explanation: 'uydurma alıntı' },
          { questionId: 'training', answer: 'NO', quote: 'Kurulum egitimi verildi', page: 1, explanation: 'yanlış sayfa' },
        ] } };
      },
    };
    const ctx = ctxOf(w);
    const r = await withTenant(h.pool, ctx, (tx) => requestEvidenceReading(tx, ctx, { documentVersionId: dv, purpose: 'Kural K2', questions: QUESTIONS.slice(0, 2) }));
    registerAiProvider(liar);
    try { await runWorker(); } finally { registerAiProvider(fixture); }
    const run = (await h.owner.query(`SELECT status, flags FROM ai_runs WHERE id = $1`, [r.runId])).rows[0];
    expect(run.status).toBe('SUCCEEDED');
    expect(run.flags).toEqual(expect.arrayContaining(['IGNORED_KEY:decision', 'delivered:SOURCE_NOT_FOUND', 'training:SOURCE_NOT_FOUND']));
    const [reading] = await withTenant(h.pool, ctx, (tx) => evidenceReadings(tx, dv));
    expect(reading!.answers.map((x) => x.answer)).toEqual(['UNCLEAR', 'UNCLEAR']);

    // Başka kiracı (B) aynı belge sürümünü göremez, isteyemez.
    const ctxB = ctxOf(w, w.tenantB, w.users.buyerB.id, [w.companyB1.id]);
    expect(await withTenant(h.pool, ctxB, (tx) => evidenceReadings(tx, dv))).toEqual([]);
    await expect(withTenant(h.pool, ctxB, (tx) => requestEvidenceReading(tx, ctxB, { documentVersionId: dv, purpose: 'Kural', questions: QUESTIONS })))
      .rejects.toMatchObject({ status: 404 });
    // Aynı kiracıda belgenin şirketine erişimi olmayan kullanıcı da göremez.
    const ctxA2 = ctxOf(w, w.tenantA, w.users.multi.id, [w.companyA2.id]);
    expect(await withTenant(h.pool, ctxA2, (tx) => evidenceReadings(tx, dv))).toEqual([]);

    await expect(withTenant(h.pool, ctx, (tx) => requestEvidenceReading(tx, ctx, { documentVersionId: dv, purpose: '', questions: QUESTIONS }))).rejects.toMatchObject({ status: 422 });
    await expect(withTenant(h.pool, ctx, (tx) => requestEvidenceReading(tx, ctx, { documentVersionId: dv, purpose: 'K', questions: [] }))).rejects.toMatchObject({ status: 422 });
    await expect(withTenant(h.pool, ctx, (tx) => requestEvidenceReading(tx, ctx, { documentVersionId: dv, purpose: 'K',
      questions: [{ id: 'a', text: 'Bir?' }, { id: 'a', text: 'İki?' }] }))).rejects.toMatchObject({ status: 422 });
  });

  it('politika yoksa NOT_ALLOWED (iş yok, kayıt yok); bütçe gelince aynı istek aynı satırı soru yüküyle kuyruğa alır', async () => {
    const w = await fresh();
    const dv = await upload(w, PDF());
    const ctx = ctxOf(w);
    const input = { documentVersionId: dv, purpose: 'Kural K3', questions: QUESTIONS.slice(0, 1) };
    const r = await withTenant(h.pool, ctx, (tx) => requestEvidenceReading(tx, ctx, input));
    expect(r.status).toBe('NOT_ALLOWED');
    expect((await h.owner.query(`SELECT count(*)::int AS n FROM jobs WHERE idempotency_key = $1`, [`ai-run-${r.runId}`])).rows[0].n).toBe(0);
    await ensureTestAiPolicy(h.owner, w.tenantA);
    const r2 = await withTenant(h.pool, ctx, (tx) => requestEvidenceReading(tx, ctx, input));
    expect(r2).toMatchObject({ runId: r.runId, status: 'QUEUED' });
    const job = (await h.owner.query(`SELECT payload FROM jobs WHERE idempotency_key = $1`, [`ai-run-${r.runId}`])).rows[0];
    expect(job.payload).toMatchObject({ runId: r.runId, purpose: 'Kural K3', questions: QUESTIONS.slice(0, 1) });
    await runWorker();
    const [reading] = await withTenant(h.pool, ctx, (tx) => evidenceReadings(tx, dv));
    expect(reading!.answers[0]).toMatchObject({ questionId: 'delivered', answer: 'YES' });
  });
});
