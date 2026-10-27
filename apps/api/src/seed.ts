// Sentetik demo verisi (09 Demo veri seti). Aynı API yolunu kullanır; doğrudan tablo yazmaz.
// Tekrar çalıştırılırsa demo kiracısı zaten varsa çıkar. Tüm kişi/firma/kimlikler sentetiktir.
import pg from 'pg';
import { randomUUID } from 'node:crypto';
import { syntheticVkn } from '@sp/domain';
import { loadConfig } from './config.ts';
import { createPool } from './db.ts';
import { DevAuthProvider } from './auth.ts';
import { S3ObjectStore } from './storage.ts';
import { buildApp } from './server.ts';
import { createSyntheticWorld, DEMO_TENANT_A, syntheticPdf, ublInvoiceXml } from './devdata.ts';
import { ensureEvaluationDemo, ensureLifecycleDemo, ensurePurchasingDemo, ensureSourcingDemo } from './seedSourcing.ts';
import { processJobs } from './worker.ts';

const config = loadConfig();
if (config.env === 'production' || config.authMode !== 'dev') throw new Error('Seed only runs in development with AUTH_MODE=dev');
const owner = new pg.Pool({ connectionString: config.databaseOwnerUrl! });
const exists = await owner.query<{ id: string }>(`SELECT id FROM tenants WHERE name = $1`, [DEMO_TENANT_A]);
if (exists.rows[0]) {
  // Temel demo var: yalnız eksik Faz 2 demo verisi eklenir (mevcut kayıtlar silinmez).
  const pool0 = createPool(config.databaseUrl, 4);
  const auth0 = new DevAuthProvider(config.devAuthSecret!);
  const app0 = await buildApp({ config: { ...config, env: 'test' }, pool: pool0, auth: auth0, store: new S3ObjectStore(config.objectStore) });
  await ensureSourcingDemo(owner, app0, auth0, exists.rows[0].id);
  await ensureLifecycleDemo(owner, app0, auth0, exists.rows[0].id, () => processJobs(pool0, new S3ObjectStore(config.objectStore), null));
  await ensurePurchasingDemo(owner, app0, auth0, exists.rows[0].id);
  await ensureEvaluationDemo(owner, app0, auth0, exists.rows[0].id);
  await app0.close(); await pool0.end(); await owner.end();
  process.exit(0);
}
const world = await createSyntheticWorld(owner);
const pool = createPool(config.databaseUrl, 4);
const auth = new DevAuthProvider(config.devAuthSecret!);
const app = await buildApp({ config: { ...config, env: 'test' }, pool, auth, store: new S3ObjectStore(config.objectStore) });
const token = async (k: keyof typeof world.users) => auth.issue(`dev|${world.users[k].email}`);

async function call(who: keyof typeof world.users, method: string, url: string, body?: unknown, headers: Record<string, string> = {}) {
  const r = await app.inject({ method: method as any, url, payload: body as any,
    headers: { authorization: `Bearer ${await token(who)}`, 'x-tenant-id': world.tenantA, ...headers } });
  if (r.statusCode >= 400) throw new Error(`${method} ${url} → ${r.statusCode} ${r.body}`);
  return { body: r.body ? JSON.parse(r.body) : null, etag: r.headers.etag as string };
}
async function upload(who: keyof typeof world.users, name: string, mime: string, data: Buffer, kind: string, title: string, company = world.companyA1.id) {
  const b = '----seed' + randomUUID();
  const payload = Buffer.concat([
    Buffer.from(`--${b}\r\nContent-Disposition: form-data; name="companyId"\r\n\r\n${company}\r\n--${b}\r\nContent-Disposition: form-data; name="kind"\r\n\r\n${kind}\r\n--${b}\r\nContent-Disposition: form-data; name="title"\r\n\r\n${title}\r\n`),
    Buffer.from(`--${b}\r\nContent-Disposition: form-data; name="file"; filename="${name}"\r\nContent-Type: ${mime}\r\n\r\n`), data, Buffer.from(`\r\n--${b}--\r\n`),
  ]);
  const r = await app.inject({ method: 'POST', url: '/api/v1/documents', payload,
    headers: { authorization: `Bearer ${await token(who)}`, 'x-tenant-id': world.tenantA, 'content-type': `multipart/form-data; boundary=${b}` } });
  return JSON.parse(r.body);
}

const inv = (sellerVkn: string | null, sellerName: string, iban?: string) => ublInvoiceXml({
  invoiceNo: `SNT2026${Math.floor(Math.random() * 1e9).toString().padStart(9, '0')}`, ettn: randomUUID(), sellerVkn, sellerName,
  buyerVkn: world.companyA1.vkn, buyerName: world.companyA1.name, iban });

// Tedarikçiler: aktif, aday, kimliği belirsiz, eşzamanlı aday
const activeVkn = syntheticVkn('410000001');
const a = await upload('buyer', 'fatura-anadolu.xml', 'application/xml', inv(activeVkn, 'Anadolu Endüstriyel Bakım Ltd. Şti. (SENTETİK)'), 'INVOICE', 'Ekim bakım faturası');
const s = await call('masterData', 'GET', `/api/v1/suppliers/${a.supplier.supplierId}`);
await call('masterData', 'POST', `/api/v1/suppliers/${s.body.id}/approvals`, { kind: 'MASTER_DATA', decision: 'APPROVED', rationale: 'Sentetik demo: kimlik ve kanıt incelendi', expectedRowVersion: s.body.rowVersion });
await call('masterData', 'POST', `/api/v1/suppliers/${s.body.id}/activate`, { expectedRowVersion: s.body.rowVersion });
await upload('buyer', 'fatura-anadolu-2.xml', 'application/xml', inv(activeVkn, 'Anadolu Endüstriyel Bakım ve Servis Ltd. Şti. (SENTETİK)', 'TR330006100519786457841326'), 'INVOICE', 'Kasım bakım faturası');
await upload('buyer', 'fatura-yeni.xml', 'application/xml', inv(syntheticVkn('410000002'), 'Marmara Kablo Sistemleri A.Ş. (SENTETİK)'), 'INVOICE', 'Kablo alımı faturası');
await upload('finance', 'fatura-kimliksiz.xml', 'application/xml', inv(null, 'Marmara Kablo Sistemleri (SENTETİK)'), 'INVOICE', 'Kimliği okunamayan fatura');

// Sözleşmeler: farklı imza durumları
async function contract(title: string, opts: { method: string; methods: string[]; stage?: string; custody?: boolean }) {
  const pdf = syntheticPdf([
    [`${title}`, 'SENTETIK TEST BELGESI - gercek sozlesme degildir', '', 'Madde 1 - Konu', 'Madde 2 - Bedel: 1.000.000,00 TRY tavan'],
    ['Madde 9 - Imzalar', '', 'ALICI: Ornek Holding Uretim A.S.        TEDARIKCI: Anadolu Endustriyel Bakim Ltd.', '', '[imza alani]                                  [imza alani]'],
  ]);
  const up = await upload('legal', `${title}.pdf`, 'application/pdf', pdf, 'CONTRACT', title);
  const c = await call('legal', 'POST', '/api/v1/contracts', {
    title, documentVersionId: up.documentVersionId, stage: opts.stage ?? 'EXECUTION', signatureMethod: opts.method, originalCustodyRequired: !!opts.custody,
    supplierId: s.body.id,
    parties: [{ role: 'BUYER', displayName: world.companyA1.name, legalEntityId: world.companyA1.id },
      { role: 'SUPPLIER', displayName: 'Anadolu Endüstriyel Bakım Ltd. Şti. (SENTETİK)', supplierId: s.body.id }],
  });
  const cv = c.body.contractVersionId;
  let st = await call('legal', 'GET', `/api/v1/contract-versions/${cv}/signature-status`);
  const req: Record<string, string> = {};
  for (const p of st.body.parties) {
    const r = await call('legal', 'POST', `/api/v1/contract-versions/${cv}/signature-requirements`,
      { partyId: p.id, signerRole: 'Yetkili imzacı', acceptableMethods: opts.methods }, { 'if-match': st.etag });
    req[p.role] = r.body.requirementId;
    st = await call('legal', 'GET', `/api/v1/contract-versions/${cv}/signature-status`);
  }
  return { cv, req };
}
async function rev(cv: string, requirementId: string, decision: string, observedMark: string, who: 'legal' | 'legal2' = 'legal') {
  const st = await call(who, 'GET', `/api/v1/contract-versions/${cv}/signature-status`);
  await call(who, 'POST', `/api/v1/contract-versions/${cv}/signature-reviews`,
    { requirementId, decision, observedMark, rationale: 'Sentetik demo incelemesi — sayfa 2 imza alanı', documentSha256: st.body.contractVersion.documentSha256, page: 2 },
    { 'if-match': st.etag });
}

const c1 = await contract('Yıllık Bakım Sözleşmesi 2026', { method: 'WET_IMAGE_REVIEW', methods: ['WET_IMAGE_REVIEW'] });
await call('legal', 'POST', `/api/v1/contract-versions/${c1.cv}/signature-analysis-jobs`);
await rev(c1.cv, c1.req.BUYER!, 'IMAGE_CONFIRMED', 'FULL_SIGNATURE');
await rev(c1.cv, c1.req.SUPPLIER!, 'MISSING', 'STAMP_ONLY');

const c2 = await contract('Yedek Parça Çerçeve Sözleşmesi', { method: 'WET_IMAGE_REVIEW', methods: ['WET_IMAGE_REVIEW'], custody: true });
await rev(c2.cv, c2.req.BUYER!, 'IMAGE_CONFIRMED', 'FULL_SIGNATURE');
await rev(c2.cv, c2.req.SUPPLIER!, 'IMAGE_CONFIRMED', 'FULL_SIGNATURE');

const c3 = await contract('Yazılım Lisans Sözleşmesi (e-imza)', { method: 'QUALIFIED_ELECTRONIC', methods: ['QUALIFIED_ELECTRONIC'] });
await call('legal', 'POST', `/api/v1/contract-versions/${c3.cv}/digital-validation-jobs`, { requirementId: c3.req.SUPPLIER });

const c4 = await contract('Depo Kiralama Sözleşmesi', { method: 'WET_IMAGE_REVIEW', methods: ['WET_IMAGE_REVIEW'] });
await rev(c4.cv, c4.req.BUYER!, 'IMAGE_CONFIRMED', 'FULL_SIGNATURE');
await rev(c4.cv, c4.req.SUPPLIER!, 'UNCLEAR', 'ILLEGIBLE');

const c5 = await contract('Nakliye Hizmet Sözleşmesi', { method: 'WET_IMAGE_REVIEW', methods: ['WET_IMAGE_REVIEW'] });
await rev(c5.cv, c5.req.BUYER!, 'IMAGE_CONFIRMED', 'FULL_SIGNATURE');
await rev(c5.cv, c5.req.SUPPLIER!, 'MISSING', 'NONE');
const x = await call('legal', 'POST', `/api/v1/contract-versions/${c5.cv}/signature-exceptions`, {
  requirementIds: [c5.req.SUPPLIER], reason: 'İmzalı nüsha kargoda (sentetik)', residualRisk: 'Teslim gecikmesi', scope: 'İlk 30 gün hizmet başlangıcı',
  expiresAt: new Date(Date.now() + 20 * 86400000).toISOString() });
await call('legal2', 'POST', `/api/v1/signature-exceptions/${x.body.exceptionId}/decision`, { decision: 'APPROVED', rationale: 'Sentetik demo: risk kabul' });

await contract('Eski Temizlik Sözleşmesi (arşiv)', { method: 'PENDING_CLASSIFICATION', methods: ['WET_IMAGE_REVIEW'], stage: 'ARCHIVE_IMPORT' });

await ensureSourcingDemo(owner, app, auth, world.tenantA);
await ensureLifecycleDemo(owner, app, auth, world.tenantA, () => processJobs(pool, new S3ObjectStore(config.objectStore), null));
await ensurePurchasingDemo(owner, app, auth, world.tenantA);
await ensureEvaluationDemo(owner, app, auth, world.tenantA);
console.log('Sentetik demo verisi oluşturuldu. Kullanıcılar (dev oturumu):');
for (const [k, u] of Object.entries(world.users)) console.log(`  ${k.padEnd(12)} ${u.email}`);
await app.close();
await pool.end();
await owner.end();
