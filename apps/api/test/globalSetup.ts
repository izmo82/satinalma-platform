import pg from 'pg';
import { migrate } from '../src/migrate.ts';
import { TEST_OWNER_URL } from './env.ts';

export default async function setup() {
  await migrate(TEST_OWNER_URL, () => {});
  const c = new pg.Client({ connectionString: TEST_OWNER_URL });
  await c.connect();
  // TRUNCATE satır trigger'larını tetiklemez; yalnız test veritabanında kullanılır.
  const t = await c.query<{ tablename: string }>(`SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename <> 'schema_migrations'`);
  await c.query(`TRUNCATE ${t.rows.map((r) => `"${r.tablename}"`).join(', ')} RESTART IDENTITY CASCADE`);
  await c.end();
}
