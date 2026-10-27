import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

// İleri yönlü, sürüm kayıtlı migration. Uygulanmış dosya değişirse checksum hatası verir.
// Geri dönüş: yıkıcı DROP yerine telafi edici yeni migration (docs/runbook.md "Migration ve rollback").
const dir = fileURLToPath(new URL('../migrations/', import.meta.url));

export async function migrate(url: string, log = console.log) {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())`);
    await client.query(`SELECT pg_advisory_lock(728311)`);
    const applied = new Map((await client.query<{ name: string; checksum: string }>('SELECT name, checksum FROM schema_migrations')).rows.map((r) => [r.name, r.checksum]));
    for (const file of (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort()) {
      const sql = await readFile(dir + file, 'utf8');
      const sum = createHash('sha256').update(sql).digest('hex');
      if (applied.has(file)) {
        if (applied.get(file) !== sum) throw new Error(`Migration ${file} was modified after being applied`);
        continue;
      }
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations (name, checksum) VALUES ($1, $2)', [file, sum]);
        await client.query('COMMIT');
        log(`applied ${file}`);
      } catch (e) {
        await client.query('ROLLBACK');
        throw e;
      }
    }
  } finally {
    await client.query(`SELECT pg_advisory_unlock(728311)`).catch(() => {});
    await client.end();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const url = process.env.DATABASE_OWNER_URL;
  if (!url) throw new Error('DATABASE_OWNER_URL required');
  await migrate(url);
}
