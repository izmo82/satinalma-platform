// v2 Faz 3 (R8) Görev 3: sözleşme şablon kütüphanesi API'si. Gerçek PostgreSQL + nesne deposu; veriler sentetik.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { createSyntheticWorld, type SyntheticWorld } from '../src/devdata.ts';
import { DevAuthProvider } from '../src/auth.ts';
import { ZipStreamWriter } from '../src/zip.ts';
import { DOCX_MIME } from '../src/modules/templates.ts';
import { makeHarness } from './harness.ts';

let h: Awaited<ReturnType<typeof makeHarness>>;
let auth: DevAuthProvider;
beforeAll(async () => { h = await makeHarness(); auth = new DevAuthProvider(h.config.devAuthSecret!); });
afterAll(async () => { await h.close(); });

type UserKey = keyof SyntheticWorld['users'];
const fresh = () => createSyntheticWorld(h.owner, `-${randomUUID().slice(0, 8)}`);

async function zip(files: Record<string, string>): Promise<Buffer> {
  const chunks: Buffer[] = [];
  const z = new ZipStreamWriter({ write: async (c) => { chunks.push(c); } });
  for (const [n, c] of Object.entries(files)) await z.addFile(n, Buffer.from(c));
  await z.finish();
  return Buffer.concat(chunks);
}
const docx = (text = 'x') => zip({ 'word/document.xml': `<w:document>${text}</w:document>` });

async function send(w: SyntheticWorld, who: UserKey, method: string, url: string, fields: Record<string, string> = {}, file?: { name: string; data: Buffer }, tenant?: string) {
  const token = await auth.issue(`dev|${w.users[who].email}`);
  const boundary = '----sp' + randomUUID();
  const parts: Buffer[] = [];
  if (file) parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${file.name}"\r\nContent-Type: ${DOCX_MIME}\r\n\r\n`), file.data, Buffer.from('\r\n'));
  for (const [k, v] of Object.entries(fields)) parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`)); // alanlar dosyadan sonra da okunur
  parts.push(Buffer.from(`--${boundary}--\r\n`));
  const res = await h.app.inject({ method: method as any, url, payload: Buffer.concat(parts),
    headers: { authorization: `Bearer ${token}`, 'x-tenant-id': tenant ?? w.tenantA, 'content-type': `multipart/form-data; boundary=${boundary}` } });
  let body: any = null;
  try { body = res.body ? JSON.parse(res.body) : null; } catch { body = res.body; }
  return { status: res.statusCode, body, res };
}
async function get(w: SyntheticWorld, who: UserKey, url: string, tenant?: string) {
  const token = await auth.issue(`dev|${w.users[who].email}`);
  const res = await h.app.inject({ method: 'GET', url, headers: { authorization: `Bearer ${token}`, 'x-tenant-id': tenant ?? w.tenantA } });
  let body: any = null;
  try { body = res.body ? JSON.parse(res.body) : null; } catch { body = res.body; }
  return { status: res.statusCode, body, res };
}
const T = '/api/v1/contract-templates';
const create = async (w: SyntheticWorld, who: UserKey = 'masterData', over: Record<string, string> = {}, data?: Buffer) =>
  send(w, who, 'POST', T, { code: 'HZM-STD', name: 'Hizmet Sözleşmesi', contractType: 'SERVICE', validFrom: '2026-01-01', ...over }, { name: 'sablon.docx', data: data ?? await docx() });

describe('yükleme ve doğrulama', () => {
  it('.docx kabul edilir; şablon, ilk sürüm ve denetim kaydı oluşur', async () => {
    const w = await fresh();
    const r = await create(w);
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ code: 'HZM-STD', versionNo: 1, contractType: 'SERVICE' });
    const a = await h.owner.query(`SELECT action FROM audit_events WHERE tenant_id = $1 AND action = 'template.created'`, [w.tenantA]);
    expect(a.rowCount).toBe(1);
    const l = await get(w, 'masterData', T);
    expect(l.body.items).toHaveLength(1);
    expect(l.body.items[0]).toMatchObject({ code: 'HZM-STD', usageCount: 0, currentVersion: { versionNo: 1, validFrom: '2026-01-01', supersededAt: null, filename: 'sablon.docx' } });
    const doc = await h.owner.query(`SELECT d.kind FROM contract_template_versions tv JOIN document_versions dv ON dv.id = tv.document_version_id JOIN documents d ON d.id = dv.document_id WHERE tv.id = $1`, [r.body.versionId]);
    expect(doc.rows[0].kind).toBe('TEMPLATE');
  });

  it('ZIP olmayan, word/document.xml olmayan ve .docx olmayan dosya 422 invalid_docx; kayıt oluşmaz', async () => {
    const w = await fresh();
    for (const data of [Buffer.from('düz metin değil zip'), await zip({ 'xl/workbook.xml': '<x/>' })]) {
      const r = await create(w, 'masterData', {}, data);
      expect(r.status).toBe(422);
      expect(r.body.error.code).toBe('invalid_docx');
    }
    const r = await send(w, 'masterData', 'POST', T, { code: 'A', name: 'A', contractType: 'SERVICE', validFrom: '2026-01-01' }, { name: 'sablon.pdf', data: await docx() });
    expect(r.status).toBe(422);
    expect(r.body.error.code).toBe('invalid_docx');
    expect((await get(w, 'masterData', T)).body.items).toHaveLength(0);
  });

  it('aynı kod 409 template_exists; tür ve tarih doğrulanır', async () => {
    const w = await fresh();
    expect((await create(w)).status).toBe(201);
    const dup = await create(w, 'buyer', {}, await docx('başka'));
    expect(dup.status).toBe(409);
    expect(dup.body.error.code).toBe('template_exists');
    expect((await create(w, 'masterData', { code: 'X1', contractType: 'YOK' })).status).toBe(422);
    expect((await create(w, 'masterData', { code: 'X2', validFrom: '2026-13-45' })).status).toBe(422);
  });
});

describe('sürümler', () => {
  it('yeni sürüm öncekini superseded_at ile kapatır; eski sürüm indirilebilir ve baytları değişmez', async () => {
    const w = await fresh();
    const first = await docx('birinci'), second = await docx('ikinci');
    const c = await create(w, 'masterData', {}, first);
    const v2 = await send(w, 'buyer', 'POST', `${T}/${c.body.id}/versions`, { validFrom: '2026-06-01' }, { name: 'sablon-v2.docx', data: second });
    expect(v2.status).toBe(201);
    expect(v2.body.versionNo).toBe(2);
    const l = (await get(w, 'auditor', T)).body.items[0];
    expect(l.currentVersion).toMatchObject({ versionNo: 2, supersededAt: null, validFrom: '2026-06-01' });
    expect(l.versions).toHaveLength(2);
    const old = l.versions.find((v: any) => v.versionNo === 1);
    expect(old.supersededAt).not.toBeNull();
    const d1 = await get(w, 'security', `/api/v1/contract-template-versions/${old.id}/download`);
    expect(d1.status).toBe(200);
    expect(Buffer.from(d1.res.rawPayload).equals(first)).toBe(true);
    expect(d1.res.headers['content-disposition']).toContain('sablon.docx');
    const d2 = await get(w, 'security', `/api/v1/contract-template-versions/${v2.body.versionId}/download`);
    expect(Buffer.from(d2.res.rawPayload).equals(second)).toBe(true);
    expect((await h.owner.query(`SELECT 1 FROM audit_events WHERE tenant_id = $1 AND action = 'template.version_added'`, [w.tenantA])).rowCount).toBe(1);
  });

  it('aynı içerikli sürüm 409; geçersiz dosya 422; olmayan şablon 404', async () => {
    const w = await fresh();
    const data = await docx('a');
    const c = await create(w, 'masterData', {}, data);
    const same = await send(w, 'masterData', 'POST', `${T}/${c.body.id}/versions`, { validFrom: '2026-02-01' }, { name: 'a.docx', data });
    expect(same.status).toBe(409);
    const bad = await send(w, 'masterData', 'POST', `${T}/${c.body.id}/versions`, { validFrom: '2026-02-01' }, { name: 'a.docx', data: Buffer.from('zip değil') });
    expect(bad.status).toBe(422);
    const none = await send(w, 'masterData', 'POST', `${T}/${randomUUID()}/versions`, { validFrom: '2026-02-01' }, { name: 'a.docx', data: await docx('z') });
    expect(none.status).toBe(404);
  });
});

describe('yetki ve kiracı', () => {
  it('Departman kullanıcısı ve Denetçi indirir/okur ama yükleyemez (403); tedarikçi hiçbirini yapamaz', async () => {
    const w = await fresh();
    const c = await create(w);
    for (const who of ['security', 'auditor'] as const) {
      expect((await create(w, who, { code: 'Z' })).status, who).toBe(403);
      expect((await send(w, who, 'POST', `${T}/${c.body.id}/versions`, { validFrom: '2026-02-01' }, { name: 'a.docx', data: await docx('q') })).status, who).toBe(403);
      expect((await get(w, who, T)).status, who).toBe(200);
      expect((await get(w, who, `/api/v1/contract-template-versions/${c.body.versionId}/download`)).status, who).toBe(200);
    }
    expect((await get(w, 'supplier1', T)).status).toBe(403);
    expect((await get(w, 'supplier1', `/api/v1/contract-template-versions/${c.body.versionId}/download`)).status).toBe(403);
  });

  it('başka kiracı şablonu göremez, indiremez, sürüm ekleyemez (404)', async () => {
    const w = await fresh();
    const c = await create(w);
    expect((await get(w, 'buyerB', T, w.tenantB)).body.items).toHaveLength(0);
    expect((await get(w, 'buyerB', `/api/v1/contract-template-versions/${c.body.versionId}/download`, w.tenantB)).status).toBe(404);
    expect((await send(w, 'buyerB', 'POST', `${T}/${c.body.id}/versions`, { validFrom: '2026-02-01' }, { name: 'a.docx', data: await docx('k') }, w.tenantB)).status).toBe(404);
  });
});

describe('şirket kapsamı (R8 düzeltme)', () => {
  it('yalnız A2 kapsamlı kullanıcı yükler; A1 ve A2 deki Departman/Denetçi listeler ve indirir; Yönetici de yükleyebilir', async () => {
    const w = await fresh();
    const data = await docx('a2');
    const c = await create(w, 'multi', {}, data);
    expect(c.status).toBe(201);
    await h.owner.query(`UPDATE memberships SET company_ids = ARRAY[$1]::uuid[] WHERE tenant_id = $2 AND user_id = $3`, [w.companyA2.id, w.tenantA, w.users.auditor.id]);
    for (const who of ['security', 'auditor', 'buyer'] as const) { // security/buyer A1, auditor A2
      const l = await get(w, who, T);
      expect(l.body.items, who).toHaveLength(1);
      expect(l.body.items[0].currentVersion.filename).toBe('sablon.docx');
      const d = await get(w, who, `/api/v1/contract-template-versions/${c.body.versionId}/download`);
      expect(d.status, who).toBe(200);
      expect(Buffer.from(d.res.rawPayload).equals(data), who).toBe(true);
    }
    // farklı şirketteki kullanıcı yeni sürüm ekleyebilir
    const v2 = await send(w, 'masterData', 'POST', `${T}/${c.body.id}/versions`, { validFrom: '2026-07-01' }, { name: 'v2.docx', data: await docx('a2-v2') });
    expect(v2.status).toBe(201);
    const adm = await create(w, 'tenantAdmin', { code: 'ADM' });
    expect(adm.status).toBe(201); // Yönetici bağlamı kiracının şirketlerini taşır
  });

  it('kullanım sayısı çağıranın görebildiği sözleşmelerle sınırlı: A1 kullanıcısı A2 sözleşmesini saymaz', async () => {
    const w = await fresh();
    const c = await create(w, 'multi');
    await h.owner.query(`INSERT INTO contract_families (tenant_id, company_id, title, created_by, code, template_version_id) VALUES ($1,$2,'A2 sözleşme',$3,$4,$5)`,
      [w.tenantA, w.companyA2.id, w.users.multi.id, `T-${randomUUID().slice(0, 8)}`, c.body.versionId]);
    expect((await get(w, 'multi', T)).body.items[0].usageCount).toBe(1);
    expect((await get(w, 'masterData', T)).body.items[0].usageCount).toBe(1); // A1+A2
    expect((await get(w, 'security', T)).body.items[0].usageCount).toBe(0); // yalnız A1
  });
});

describe('çok parçalı sınırlar', () => {
  it('25 MB üstü dosya 413; ikinci dosya 413', async () => {
    const w = await fresh();
    const big = Buffer.concat([await docx('b'), Buffer.alloc(26 * 1024 * 1024)]);
    expect((await create(w, 'masterData', { code: 'BIG' }, big)).status).toBe(413);
    const token = await auth.issue(`dev|${w.users.masterData.email}`);
    const b = '----sp' + randomUUID();
    const f = async (n: string) => `--${b}\r\nContent-Disposition: form-data; name="file"; filename="${n}"\r\nContent-Type: ${DOCX_MIME}\r\n\r\n`;
    const payload = Buffer.concat([Buffer.from(await f('a.docx')), await docx('1'), Buffer.from('\r\n' + await f('b.docx')), await docx('2'), Buffer.from(`\r\n--${b}--\r\n`)]);
    const res = await h.app.inject({ method: 'POST', url: T, payload, headers: { authorization: `Bearer ${token}`, 'x-tenant-id': w.tenantA, 'content-type': `multipart/form-data; boundary=${b}` } });
    expect(res.statusCode).toBe(413);
  });
});
