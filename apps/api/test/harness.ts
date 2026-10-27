import pg from 'pg';
import { randomUUID } from 'node:crypto';
import { buildApp } from '../src/server.ts';
import { DevAuthProvider } from '../src/auth.ts';
import { createPool } from '../src/db.ts';
import { S3ObjectStore } from '../src/storage.ts';
import type { Config } from '../src/config.ts';
import { createSyntheticWorld, type SyntheticWorld } from '../src/devdata.ts';
import { registerDetector, type DetectionOutcome } from '../src/signature/detector.ts';
import { ErpTimeout, registerErpAdapter } from '../src/erp/adapter.ts';
import { TEST_APP_URL, TEST_OWNER_URL, TEST_S3_ENDPOINT } from './env.ts';

/** YALNIZ TEST: belge hash'ine göre önceden belirlenmiş sonuç döner. Canlı algılama başarısı değildir. */
export const fixtureOutcomes = new Map<string, DetectionOutcome>();
registerDetector({
  capability: { provider: 'test-fixture', modelVersion: 'fixture-1', signatureDetection: true, approvedRegions: ['TR'] },
  async detect({ bytes, pageCount }) {
    const { createHash } = await import('node:crypto');
    const sha = createHash('sha256').update(bytes).digest('hex');
    return fixtureOutcomes.get(sha) ?? { status: 'NOT_DETECTED', processedPages: Array.from({ length: pageCount ?? 1 }, (_, i) => i + 1), totalPages: pageCount, candidates: [] };
  },
});

/** YALNIZ TEST: bellekteki sahte ERP. `timeoutOnce` anahtarları ilk gönderimde kaydı oluşturup zaman aşımı verir (T18). */
export const fakeErp = { records: new Map<string, string>(), timeoutOnce: new Set<string>(), posts: new Map<string, number>() };
registerErpAdapter({
  name: 'test-erp',
  async find(key) { const id = fakeErp.records.get(key); return id ? { externalId: id } : null; },
  async post(p) {
    fakeErp.posts.set(p.idempotencyKey, (fakeErp.posts.get(p.idempotencyKey) ?? 0) + 1);
    const id = `ERP-${fakeErp.records.size + 1}`;
    fakeErp.records.set(p.idempotencyKey, id);
    if (fakeErp.timeoutOnce.delete(p.idempotencyKey)) throw new ErpTimeout();
    return { externalId: id };
  },
});

const secret = 'test-secret-'.padEnd(40, 'x');

export async function makeHarness() {
  const config: Config = {
    env: 'test', port: 0, databaseUrl: TEST_APP_URL, databaseOwnerUrl: TEST_OWNER_URL, authMode: 'dev', oidc: null,
    devAuthSecret: secret, dataRegion: 'TR',
    objectStore: { endpoint: TEST_S3_ENDPOINT, region: 'us-east-1', bucket: 'sp-documents-test', forcePathStyle: true },
    signedUrlTtlSeconds: 60, signatureDetectorProvider: null, esignValidatorProvider: null, erpAdapter: 'test-erp', webOrigin: 'http://localhost:5174',
  };
  process.env.AWS_ACCESS_KEY_ID ??= 'test';
  process.env.AWS_SECRET_ACCESS_KEY ??= 'test';
  const pool = createPool(TEST_APP_URL, 10);
  const owner = new pg.Pool({ connectionString: TEST_OWNER_URL, max: 3 });
  const auth = new DevAuthProvider(secret);
  const store = new S3ObjectStore(config.objectStore);
  const app = await buildApp({ config, pool, auth, store });
  const world: SyntheticWorld = await createSyntheticWorld(owner, `-${randomUUID().slice(0, 8)}`);
  const tokens = new Map<string, string>();
  for (const [k, u] of Object.entries(world.users)) tokens.set(k, await auth.issue(`dev|${u.email}`));

  type UserKey = keyof SyntheticWorld['users'];
  const headers = (who: UserKey, tenant: string, extra: Record<string, string> = {}) =>
    ({ authorization: `Bearer ${tokens.get(who)}`, 'x-tenant-id': tenant, ...extra });

  async function call(who: UserKey, method: string, url: string, opts: { tenant?: string; body?: unknown; headers?: Record<string, string> } = {}) {
    const res = await app.inject({ method: method as any, url, headers: headers(who, opts.tenant ?? world.tenantA, opts.headers),
      ...(opts.body !== undefined ? { payload: opts.body as any } : {}) });
    return { status: res.statusCode, body: res.body ? safeJson(res.body) : null, headers: res.headers, raw: res.rawPayload };
  }

  async function upload(who: UserKey, file: { name: string; mime: string; data: Buffer }, fields: Record<string, string>, tenant?: string) {
    const boundary = '----sp' + randomUUID();
    const parts: Buffer[] = [];
    for (const [k, v] of Object.entries(fields)) {
      parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`));
    }
    parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${file.name}"\r\nContent-Type: ${file.mime}\r\n\r\n`));
    parts.push(file.data, Buffer.from(`\r\n--${boundary}--\r\n`));
    const res = await app.inject({ method: 'POST', url: '/api/v1/documents', payload: Buffer.concat(parts),
      headers: { ...headers(who, tenant ?? world.tenantA), 'content-type': `multipart/form-data; boundary=${boundary}` } });
    return { status: res.statusCode, body: safeJson(res.body) };
  }

  async function close() {
    await app.close();
    await pool.end();
    await owner.end();
  }
  return { app, config, pool, owner, store, world, call, upload, close };
}

function safeJson(s: string) {
  try { return JSON.parse(s); } catch { return s; }
}
