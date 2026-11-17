// v2 Faz 4 (R13): sözleşme alan okuma doğruluk ölçüm düzeneği.
// Etiketli klasördeki (`<ad>.pdf` + `<ad>.labels.json`) sözleşmeleri YAPILANDIRILMIŞ sağlayıcıyla (AI_PROVIDER) okur, alan bazında ve kritik
// alan doğruluğunu hesaplar, raporu repo dışına yazar. Belge metni rapora yazılmaz (yalnız sayılar ve alan adları).
// Test sağlayıcısıyla koşulan rapor "Düzenek sınaması — gerçek ölçüm değil" başlığını taşır. Testler gerçek sağlayıcıyı ÇAĞIRMAZ.
// `<ad>.pdf` yoksa ve etikette `synthetic` seçenekleri varsa sentetik PDF o seçeneklerle üretilir (repoda ikili dosya tutulmaz).
import { mkdirSync, readdirSync, readFileSync, existsSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { checkContractExtraction, CONTRACT_AI_FIELDS, CRITICAL_AI_FIELDS, extractionAccuracy } from '@sp/domain';
import { loadAi } from '../src/config.ts';
import { anthropicProvider } from '../src/ai/anthropic.ts';
import { testFixtureProvider, isTestProvider } from '../src/ai/testProvider.ts';
import { PROMPT_VERSIONS } from '../src/ai/prompts.ts';
import { pageTexts } from '../src/ai/text.ts';
import { syntheticContractPdf, type SyntheticContractOpts } from '../src/devdata.ts';
import type { AiProvider } from '../src/ai/provider.ts';

export interface EvalReport {
  provider: string;
  isTestProvider: boolean;
  modelId: string;
  promptVersion: string;
  documents: number;
  /** Sağlayıcı hatası nedeniyle okunamayan belge sayısı; etiketli alanları yanlış sayılır. */
  failedDocuments: number;
  perField: Record<string, { correct: number; total: number }>;
  /** 0–1; etiketli tüm alan-belge çiftleri üzerinden. */
  overall: number;
  /** 0–1; yalnız kritik alanlar üzerinden (kritik etiket yoksa 0). */
  critical: number;
  createdAt: string;
}

interface Labels { fields: Record<string, string | null>; synthetic?: SyntheticContractOpts }

const ratio = (c: number, t: number) => (t === 0 ? 0 : Math.round((c / t) * 10000) / 10000);

export async function runEval(o: { dir: string; provider: AiProvider; modelId: string; out?: string }): Promise<EvalReport> {
  const names = readdirSync(o.dir).filter((f) => f.endsWith('.labels.json')).map((f) => f.slice(0, -'.labels.json'.length)).sort();
  if (names.length === 0) throw new Error('Etiketli belge yok (<ad>.labels.json)');
  const perField: EvalReport['perField'] = {};
  const critKeys = CRITICAL_AI_FIELDS as readonly string[];
  let c = 0, t = 0, cc = 0, ct = 0, failed = 0;
  for (const name of names) {
    const labels = JSON.parse(readFileSync(join(o.dir, `${name}.labels.json`), 'utf8')) as Labels;
    const pdfPath = join(o.dir, `${name}.pdf`);
    const body = existsSync(pdfPath) ? readFileSync(pdfPath) : labels.synthetic ? syntheticContractPdf(labels.synthetic) : null;
    if (!body) throw new Error(`${name}: PDF yok ve etikette synthetic seçenekleri yok`);
    let got: Record<string, string | null> | null = null;
    try {
      const pages = await pageTexts(body, 'application/pdf');
      const res = await o.provider.run(o.modelId, {
        task: 'AI06', pages, mimeType: 'application/pdf', allowedFields: CONTRACT_AI_FIELDS,
        document: { bytes: body, mimeType: 'application/pdf', pageCount: pages.length }, promptVersion: PROMPT_VERSIONS.AI06,
      });
      got = {};
      for (const f of checkContractExtraction(res.output, pages).fields) got[f.field] = f.value;
    } catch { failed++; }
    // Başarısız belge: her etiketli alan yanlış sayılır (yok sayılmaz; doğruluk şişmez).
    const acc = got ? extractionAccuracy(labels.fields, got) : { perField: Object.fromEntries(Object.keys(labels.fields).map((k) => [k, false])) };
    for (const [k, ok] of Object.entries(acc.perField)) {
      const e = (perField[k] ??= { correct: 0, total: 0 });
      e.total++; t++; if (critKeys.includes(k)) ct++;
      if (ok) { e.correct++; c++; if (critKeys.includes(k)) cc++; }
    }
  }
  const report: EvalReport = {
    provider: o.provider.name, isTestProvider: isTestProvider(o.provider.name), modelId: o.modelId, promptVersion: PROMPT_VERSIONS.AI06,
    documents: names.length, failedDocuments: failed, perField, overall: ratio(c, t), critical: ratio(cc, ct), createdAt: new Date().toISOString(),
  };
  if (o.out) writeReport(o.out, report);
  return report;
}

const pct = (x: number) => `%${(x * 100).toFixed(1)}`;
export function renderReport(r: EvalReport): string {
  const L: string[] = [];
  L.push(r.isTestProvider ? '# Düzenek sınaması — gerçek ölçüm değil' : '# Sözleşme alan okuma doğruluğu');
  if (r.isTestProvider) L.push('', 'Sonuçlar test sağlayıcısından (etiket okuyucu) gelir; gerçek model doğruluğu hakkında bilgi vermez.');
  L.push('', `- Sağlayıcı: ${r.provider}`, `- Model: ${r.modelId}`, `- İstem sürümü: ${r.promptVersion}`, `- Belge sayısı: ${r.documents}`, `- Okunamayan belge (sağlayıcı hatası): ${r.failedDocuments}`,
    `- Genel doğruluk: ${pct(r.overall)}`, `- Kritik alan doğruluğu: ${pct(r.critical)}`, `- Tarih: ${r.createdAt}`, '',
    '| Alan | Doğru | Toplam | Oran |', '|---|---|---|---|');
  for (const [k, v] of Object.entries(r.perField)) L.push(`| ${k}${(CRITICAL_AI_FIELDS as readonly string[]).includes(k) ? ' (kritik)' : ''} | ${v.correct} | ${v.total} | ${pct(ratio(v.correct, v.total))} |`);
  return L.join('\n') + '\n';
}
function writeReport(out: string, r: EvalReport) {
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, renderReport(r));
  writeFileSync(out.slice(0, -3) + '.json', JSON.stringify(r, null, 2));
}

async function main() {
  const a = process.argv.slice(2);
  const arg = (n: string) => { const i = a.indexOf(n); return i >= 0 ? a[i + 1] : undefined; };
  const dir = arg('--dir');
  if (!dir) throw new Error('Kullanım: ai:eval -- --dir <klasör> [--out <dosya.md>]');
  const ai = loadAi((process.env.NODE_ENV ?? 'development') as 'development');
  if (ai.provider === 'none') throw new Error('AI_PROVIDER yapılandırılmamış (none): ölçüm için test ya da anthropic seçin');
  if (ai.provider === 'anthropic' && !ai.externalTransferApproved) {
    throw new Error('AI_EXTERNAL_TRANSFER_APPROVED=true gerekli: gerçek sağlayıcıyla ölçüm sözleşme metnini kurum dışına gönderir (KVKK/kurum onayı)');
  }
  const provider = ai.provider === 'test' ? testFixtureProvider() : anthropicProvider(ai);
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  let out = resolve(arg('--out') ?? join(homedir(), 'ai-eval-raporlari', `ai-eval-${provider.name}-${stamp}.md`));
  if (!out.endsWith('.md')) out += '.md'; // .json eşi .md'nin üstüne yazılmaz
  const r = await runEval({ dir: resolve(dir), provider, modelId: ai.modelId, out });
  console.log(`${r.isTestProvider ? 'Düzenek sınaması — gerçek ölçüm değil\n' : ''}sağlayıcı=${r.provider} belge=${r.documents} genel=${pct(r.overall)} kritik=${pct(r.critical)}\nrapor: ${out}`);
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch((e) => { console.error((e as Error).message); process.exit(1); });
