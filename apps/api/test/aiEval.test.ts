// v2 Faz 4 Görev 6 (R13): doğruluk ölçüm düzeneği. Gerçek sağlayıcı ÇAĞRILMAZ; test sağlayıcısıyla koşar, sonuç "gerçek ölçüm değil" etiketlidir.
import { cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { runEval, renderReport } from '../scripts/ai-eval.ts';
import { testFixtureProvider } from '../src/ai/testProvider.ts';

const FIX = join(import.meta.dirname, 'fixtures', 'ai-eval');
const tmp = mkdtempSync(join(tmpdir(), 'ai-eval-test-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

describe('AI doğruluk ölçüm düzeneği (R13)', () => {
  it('repoda 5 sentetik etiketli sözleşme vardır ve hepsi sentetiktir', () => {
    const labels = readdirSync(FIX).filter((f) => f.endsWith('.labels.json'));
    expect(labels).toHaveLength(5);
    for (const f of labels) expect(readFileSync(join(FIX, f), 'utf8')).toContain('SENTETIK');
  });

  it('test sağlayıcısıyla koşar: rapor alanları dolu, isTestProvider true, başlık "gerçek ölçüm değil", rapor dışarı yazılır', async () => {
    const out = join(tmp, 'rapor', 'r.md');
    const r = await runEval({ dir: FIX, provider: testFixtureProvider(), modelId: 'claude-sonnet-5-5', out });
    expect(r).toMatchObject({ provider: 'test-fixture', isTestProvider: true, modelId: 'claude-sonnet-5-5', documents: 5 });
    expect(r.promptVersion).toMatch(/^sozlesme-alan-/);
    expect(Date.parse(r.createdAt)).not.toBeNaN();
    expect(Object.keys(r.perField).length).toBeGreaterThanOrEqual(10);
    for (const k of ['amount', 'currency', 'signedOn', 'startDate', 'endDate', 'supplierVkn']) expect(r.perField[k]!.total).toBeGreaterThan(0);
    expect(r.overall).toBe(1); expect(r.critical).toBe(1);
    const md = readFileSync(out, 'utf8');
    expect(md.split('\n')[0]).toBe('# Düzenek sınaması — gerçek ölçüm değil');
    expect(JSON.parse(readFileSync(out.replace(/\.md$/, '') + '.json', 'utf8')).isTestProvider).toBe(true);
  });

  it('belge metni rapora yazılmaz (unvan, numara, VKN, tutar yok)', async () => {
    const r = await runEval({ dir: FIX, provider: testFixtureProvider(), modelId: 'm' });
    const md = renderReport(r) + JSON.stringify(r);
    for (const s of ['Anadolu', 'Bogazici', 'SNT-2026', 'Sozlesmesi', '1250000', '87500', 'Ankara']) expect(md).not.toContain(s);
    expect(md).not.toMatch(/\b\d{10}\b/);
  });

  it('bir etiket bozulunca o alanın doğruluğu düşer, diğerleri etkilenmez; kritik alan düşünce critical düşer', async () => {
    const dir = join(tmp, 'bozuk');
    cpSync(FIX, dir, { recursive: true });
    const f = join(dir, 'sozlesme-01-bakim.labels.json');
    const l = JSON.parse(readFileSync(f, 'utf8'));
    l.fields.noticePeriodDays = '31'; // yanlış etiket
    writeFileSync(f, JSON.stringify(l));
    const r = await runEval({ dir, provider: testFixtureProvider(), modelId: 'm' });
    expect(r.perField.noticePeriodDays).toEqual({ correct: 4, total: 5 });
    expect(r.perField.title!.correct).toBe(5);
    expect(r.critical).toBe(1);
    expect(r.overall).toBeLessThan(1);

    l.fields.amount = '1.00';
    writeFileSync(f, JSON.stringify(l));
    const r2 = await runEval({ dir, provider: testFixtureProvider(), modelId: 'm' });
    expect(r2.perField.amount).toEqual({ correct: 4, total: 5 });
    expect(r2.critical).toBeLessThan(1);
  });

  it('okunamayan alan null etiketle doğru sayılır; yanlış null etiketi yakalanır', async () => {
    const dir = join(tmp, 'null');
    cpSync(FIX, dir, { recursive: true });
    const f = join(dir, 'sozlesme-03-eksik.labels.json');
    const l = JSON.parse(readFileSync(f, 'utf8'));
    expect(l.fields.supplierVkn).toBeNull();
    l.fields.signedOn = null; // belgede var; okuyucu okur -> etiket yanlış sayılır
    writeFileSync(f, JSON.stringify(l));
    const r = await runEval({ dir, provider: testFixtureProvider(), modelId: 'm' });
    expect(r.perField.supplierVkn).toEqual({ correct: 5, total: 5 });
    expect(r.perField.signedOn).toEqual({ correct: 4, total: 5 });
  });

  it('etiket yoksa hata verir; gerçek sağlayıcı çağrılmaz (yalnız verilen sağlayıcı)', async () => {
    const empty = join(tmp, 'bos');
    mkdirSync(empty);
    await expect(runEval({ dir: empty, provider: testFixtureProvider(), modelId: 'm' })).rejects.toThrow(/Etiketli belge yok/);
    let calls = 0;
    const counting = { name: 'test-count', async run(...a: Parameters<ReturnType<typeof testFixtureProvider>['run']>) { calls++; return testFixtureProvider().run(...a); } };
    const r = await runEval({ dir: FIX, provider: counting, modelId: 'm' });
    expect(calls).toBe(5); expect(r.isTestProvider).toBe(true);
  });
});
