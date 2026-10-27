// Geri yükleme doğrulaması (Faz 7): veritabanındaki her canlı belge sürümü ve teklif dosyası için nesne deposunda bayt var mı,
// SHA-256 tutuyor mu. İmha edilmiş belgeler atlanır. Yalnız sayıları ve sorunlu kayıtların kimliklerini yazar (içerik/başlık yazmaz).
//   npx tsx --env-file=.env apps/api/src/verifyStore.ts
import { createHash } from 'node:crypto';
import pg from 'pg';
import { loadConfig } from './config.ts';
import { S3ObjectStore } from './storage.ts';

const config = loadConfig();
const owner = new pg.Pool({ connectionString: config.databaseOwnerUrl!, max: 2 });
const store = new S3ObjectStore(config.objectStore);
const rows = (await owner.query<{ kind: string; id: string; storage_key: string; sha256: string }>(`
  SELECT 'document_version' AS kind, dv.id, dv.storage_key, dv.sha256 FROM document_versions dv
   WHERE NOT EXISTS (SELECT 1 FROM document_disposals x WHERE x.document_id = dv.document_id)
  UNION ALL SELECT 'bid_file', b.id, b.storage_key, b.sha256 FROM bid_files b`)).rows;
const seen = new Map<string, 'ok' | 'missing' | 'mismatch'>();
const problems: { kind: string; id: string; problem: string }[] = [];
for (const r of rows) {
  let state = seen.get(r.storage_key);
  if (!state) {
    try { state = createHash('sha256').update(await store.get(r.storage_key)).digest('hex') === r.sha256 ? 'ok' : 'mismatch'; }
    catch { state = 'missing'; }
    seen.set(r.storage_key, state);
  }
  if (state !== 'ok') problems.push({ kind: r.kind, id: r.id, problem: state });
}
console.log(JSON.stringify({ records: rows.length, objects: seen.size, ok: [...seen.values()].filter((s) => s === 'ok').length, problems }, null, 2));
await owner.end();
process.exit(problems.length ? 1 : 0);
