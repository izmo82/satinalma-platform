import { writeFile } from 'node:fs/promises';
import { buildApp } from './server.ts';
import { DevAuthProvider } from './auth.ts';
import { createPool } from './db.ts';

// Rota şemalarından OpenAPI üretir (docs/openapi.json). DB'ye bağlanmaz.
const app = await buildApp({
  config: { env: 'test', port: 0, databaseUrl: '', databaseOwnerUrl: null, authMode: 'dev', oidc: null, devAuthSecret: 'x'.repeat(32),
    dataRegion: 'TR', objectStore: { endpoint: null, region: 'x', bucket: 'x', forcePathStyle: true }, signedUrlTtlSeconds: 60,
    signatureDetectorProvider: null, esignValidatorProvider: null, webOrigin: 'http://localhost' },
  pool: createPool('postgres://unused@localhost/unused', 1),
  auth: new DevAuthProvider('x'.repeat(32)),
  store: { put: async () => {}, get: async () => Buffer.alloc(0), exists: async () => false, signedGetUrl: async () => '' },
});
await app.ready();
await writeFile(new URL('../../../docs/openapi.json', import.meta.url), JSON.stringify(app.swagger(), null, 2));
await app.close();
process.exit(0);
