import { loadConfig } from './config.ts';
import { createPool } from './db.ts';
import { DevAuthProvider, OidcAuthProvider } from './auth.ts';
import { S3ObjectStore } from './storage.ts';
import { buildApp } from './server.ts';

const config = loadConfig();
const pool = createPool(config.databaseUrl);
const auth = config.authMode === 'oidc' ? new OidcAuthProvider(config.oidc!) : new DevAuthProvider(config.devAuthSecret!);
const app = await buildApp({ config, pool, auth, store: new S3ObjectStore(config.objectStore) });
await app.listen({ port: config.port, host: '0.0.0.0' });

for (const sig of ['SIGTERM', 'SIGINT'] as const) {
  process.on(sig, async () => {
    await app.close();
    await pool.end();
    process.exit(0);
  });
}
