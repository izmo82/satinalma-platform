import { loadConfig } from './config.ts';
import { createPool } from './db.ts';
import { DevAuthProvider, OidcAuthProvider } from './auth.ts';
import { S3ObjectStore } from './storage.ts';
import { buildApp } from './server.ts';
import { registerConfiguredAiProvider } from './ai/register.ts';

const config = loadConfig();
// v2 Faz 4 (R1): yapılandırılmış yapay zekâ sağlayıcısı (none/test/anthropic); ağ çağrısı yapılmaz.
registerConfiguredAiProvider(config.ai);
const pool = createPool(config.databaseUrl);
const auth = config.authMode === 'oidc' ? new OidcAuthProvider(config.oidc!) : new DevAuthProvider(config.devAuthSecret!);
const app = await buildApp({ config, pool, auth, store: new S3ObjectStore(config.objectStore) });
// Konteynerde tüm arayüzler (varsayılan); yerel geliştirmede API_HOST=127.0.0.1 ile yalnız bu makine.
await app.listen({ port: config.port, host: process.env.API_HOST || '0.0.0.0' });

for (const sig of ['SIGTERM', 'SIGINT'] as const) {
  process.on(sig, async () => {
    await app.close();
    await pool.end();
    process.exit(0);
  });
}
