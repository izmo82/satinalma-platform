// v2 Faz 1 (D93/D95): saklama, hukuki saklama ve imha kaldırıldı (testler atlandı, 403 removed-v1.test.ts'de); kiracı dışa aktarımı korunur
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHash, randomUUID } from 'node:crypto';
import { syntheticPdf } from '../src/devdata.ts';
import { processJobs } from '../src/worker.ts';
import { readZip } from '../src/zip.ts';
import { makeHarness } from './harness.ts';

// Faz 7 / T48: saklama politikası, hukuki saklama, iki kişi onaylı imha ve kiracı dışa aktarımı.
let h: Awaited<ReturnType<typeof makeHarness>>;
beforeAll(async () => { h = await makeHarness(); });
afterAll(async () => { await h.close(); });

const runJobs = async () => { for (let i = 0; i < 10; i++) if (!(await processJobs(h.pool, h.store, null, 20, null))) break; };
const pdf = (label: string) => ({ name: `${label}.pdf`, mime: 'application/pdf', data: syntheticPdf([[`SENTETIK ${label}`, randomUUID()]]) });

async function oldDocument(companyId: string, kind = 'OTHER', label = 'eski belge') {
  const file = pdf(label);
  const up = await h.upload('legal', file, { companyId, kind, title: `${label} (sentetik)` });
  expect(up.status).toBe(201);
  // Test kurulumu: belge 5 yıl önce yüklenmiş gibi (saklama süresi gerçek zamanda beklenemez).
  await h.owner.query(`UPDATE document_versions SET created_at = now() - interval '5 years' WHERE document_id = $1`, [up.body.documentId]);
  return { documentId: up.body.documentId as string, versionId: up.body.documentVersionId as string, sha256: up.body.sha256 as string, file };
}
const keyOf = (sha: string) => `t/${h.world.tenantA}/sha256/${sha}`;

describe('saklama politikası ve hukuki saklama', () => {
  // v2 Faz 1 (D93): işlev onaylı kaldırma listesinde; davranış removed-v1.test.ts ile 403 olarak korunur
  it.skip('politika dayanakla ve yalnız hukuk tarafından tanımlanır; politika yoksa belge aday olmaz', async () => {
    const d = await oldDocument(h.world.companyA1.id, 'QUOTE', 'politikasız teklif');
    let c = await h.call('legal', 'GET', '/api/v1/retention/candidates');
    expect(c.body.candidates.find((x: any) => x.id === d.documentId)).toBeUndefined();
    expect((await h.call('buyer', 'PUT', '/api/v1/retention/policies/QUOTE', { body: { retentionMonths: 24, legalBasis: 'Kurum saklama politikası md. 4' } })).status).toBe(403);
    expect((await h.call('legal', 'PUT', '/api/v1/retention/policies/QUOTE', { body: { retentionMonths: 24, legalBasis: 'x' } })).status).toBe(422);
    expect((await h.call('legal', 'PUT', '/api/v1/retention/policies/QUOTE', { body: { retentionMonths: 24, legalBasis: 'Kurum saklama politikası md. 4 (sentetik)' } })).status).toBe(200);
    c = await h.call('legal', 'GET', '/api/v1/retention/candidates');
    expect(c.body.candidates.find((x: any) => x.id === d.documentId)).toMatchObject({ kind: 'QUOTE' });
    // Kiracı yöneticisi şirket kapsamı olmadan belge listesini görmez.
    expect((await h.call('tenantAdmin', 'GET', '/api/v1/retention/candidates')).body.candidates).toEqual([]);
  });

  // v2 Faz 1 (D93): işlev onaylı kaldırma listesinde; davranış removed-v1.test.ts ile 403 olarak korunur
  it.skip('hukuki saklama süresi dolmuş belgeyi aday listesinden çıkarır; kaldırılınca döner', async () => {
    await h.call('legal', 'PUT', '/api/v1/retention/policies/OTHER', { body: { retentionMonths: 12, legalBasis: 'Kurum saklama politikası md. 7 (sentetik)' } });
    const d = await oldDocument(h.world.companyA2.id, 'OTHER', 'davalı belge');
    const hold = await h.call('legal', 'POST', '/api/v1/legal-holds', { body: { scope: 'COMPANY', companyId: h.world.companyA2.id, matterRef: 'DAVA-2026/1 (sentetik)', reason: 'Devam eden uyuşmazlık nedeniyle saklama.' } });
    expect(hold.status).toBe(201);
    let c = await h.call('legal', 'GET', '/api/v1/retention/candidates');
    expect(c.body.candidates.find((x: any) => x.id === d.documentId)).toBeUndefined();
    expect(c.body.summary.LEGAL_HOLD).toBeGreaterThan(0);
    // Hukuki saklamadaki belge imha partisine de eklenemez.
    const p = await h.call('legal', 'POST', '/api/v1/disposal-batches', { body: { documentIds: [d.documentId], reason: 'Saklama süresi doldu (sentetik).' } });
    expect(p.status).toBe(422);
    expect(p.body.error.details.blocked[0].reason).toBe('LEGAL_HOLD');
    expect((await h.call('buyer', 'POST', `/api/v1/legal-holds/${hold.body.id}/release`, { body: { reason: 'Uyuşmazlık sona erdi (sentetik).' } })).status).toBe(403);
    expect((await h.call('legal', 'POST', `/api/v1/legal-holds/${hold.body.id}/release`, { body: { reason: 'Uyuşmazlık sona erdi (sentetik).' } })).status).toBe(200);
    c = await h.call('legal', 'GET', '/api/v1/retention/candidates');
    expect(c.body.candidates.find((x: any) => x.id === d.documentId)).toBeTruthy();
  });
});

describe('iki kişi onaylı imha', () => {
  // v2 Faz 1 (D93): işlev onaylı kaldırma listesinde; davranış removed-v1.test.ts ile 403 olarak korunur
  it.skip('öneren onaylayamaz; onayda baytlar silinir, hash ve denetim izi kalır; aynı dosya yeniden yüklenebilir', async () => {
    await h.call('legal', 'PUT', '/api/v1/retention/policies/OTHER', { body: { retentionMonths: 12, legalBasis: 'Kurum saklama politikası md. 7 (sentetik)' } });
    const d = await oldDocument(h.world.companyA1.id, 'OTHER', 'imha edilecek');
    expect(await h.store.exists(keyOf(d.sha256))).toBe(true);
    const p = await h.call('legal', 'POST', '/api/v1/disposal-batches', { body: { documentIds: [d.documentId], reason: 'Saklama süresi doldu (sentetik).' } });
    expect(p.status).toBe(201);
    // Aynı belge ikinci bir açık partiye giremez.
    expect((await h.call('legal', 'POST', '/api/v1/disposal-batches', { body: { documentIds: [d.documentId], reason: 'Mükerrer öneri (sentetik).' } })).status).toBe(409);
    const own = await h.call('legal', 'POST', `/api/v1/disposal-batches/${p.body.id}/decision`, { body: { decision: 'APPROVE', note: 'Kendi önerim.' } });
    expect(own.status).toBe(403);
    expect(own.body.error.code).toBe('segregation_of_duties');
    expect((await h.call('tenantAdmin', 'POST', `/api/v1/disposal-batches/${p.body.id}/decision`, { body: { decision: 'APPROVE', note: 'Yetkisiz.' } })).status).toBe(403);
    const ok = await h.call('legal2', 'POST', `/api/v1/disposal-batches/${p.body.id}/decision`, { body: { decision: 'APPROVE', note: 'Liste incelendi, hukuki saklama yok (sentetik).' } });
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ status: 'EXECUTED', disposed: 1, skipped: [] });
    await runJobs();
    expect(await h.store.exists(keyOf(d.sha256))).toBe(false);
    const content = await h.call('legal', 'GET', `/api/v1/document-versions/${d.versionId}/content`);
    expect(content.status).toBe(410);
    const meta = await h.call('legal', 'GET', `/api/v1/document-versions/${d.versionId}`);
    expect(meta.body).toMatchObject({ sha256: d.sha256 });
    expect(meta.body.disposedAt).toBeTruthy();
    // İmha edilen belgeye yeni sürüm eklenemez; aynı baytlar yeni belge olarak yüklenir ve okunabilir.
    expect((await h.upload('legal', d.file, { companyId: h.world.companyA1.id, kind: 'OTHER', documentId: d.documentId })).body.error.code).toBe('document_disposed');
    const again = await h.upload('legal', d.file, { companyId: h.world.companyA1.id, kind: 'OTHER', title: 'yeniden yüklenen (sentetik)' });
    expect(again.status).toBe(201);
    expect(again.body.documentId).not.toBe(d.documentId);
    expect((await h.call('legal', 'GET', `/api/v1/document-versions/${again.body.documentVersionId}/content`)).status).toBe(200);
    const trail = await h.owner.query(`SELECT action FROM audit_events WHERE entity_id = $1 ORDER BY id`, [p.body.id]);
    expect(trail.rows.map((r) => r.action)).toEqual(['disposal.proposed', 'disposal.executed']);
  });

  // v2 Faz 1 (D93): işlev onaylı kaldırma listesinde; davranış removed-v1.test.ts ile 403 olarak korunur
  it.skip('öneriden sonra gelen hukuki saklama onay anında belgeyi korur; başka canlı kayıt kullanan nesne silinmez', async () => {
    await h.call('legal', 'PUT', '/api/v1/retention/policies/OTHER', { body: { retentionMonths: 12, legalBasis: 'Kurum saklama politikası md. 7 (sentetik)' } });
    const held = await oldDocument(h.world.companyA1.id, 'OTHER', 'sonradan saklanan');
    const shared = await oldDocument(h.world.companyA1.id, 'OTHER', 'ortak içerik');
    // Aynı baytlar başka türde ikinci bir belge olarak da var (aynı nesne anahtarı).
    const twin = await h.upload('legal', shared.file, { companyId: h.world.companyA1.id, kind: 'CONTRACT', title: 'ikiz (sentetik)' });
    expect(twin.status).toBe(201);
    const p = await h.call('legal', 'POST', '/api/v1/disposal-batches', { body: { documentIds: [held.documentId, shared.documentId], reason: 'Saklama süresi doldu (sentetik).' } });
    expect(p.status).toBe(201);
    await h.call('legal', 'POST', '/api/v1/legal-holds', { body: { scope: 'DOCUMENT', documentId: held.documentId, matterRef: 'İNC-77 (sentetik)', reason: 'Denetim talebi nedeniyle saklama.' } });
    const ok = await h.call('legal2', 'POST', `/api/v1/disposal-batches/${p.body.id}/decision`, { body: { decision: 'APPROVE', note: 'Onay (sentetik).' } });
    expect(ok.body.disposed).toBe(1);
    expect(ok.body.skipped).toEqual([{ documentId: held.documentId, reason: 'LEGAL_HOLD' }]);
    await runJobs();
    expect(await h.store.exists(keyOf(held.sha256))).toBe(true);
    expect(await h.store.exists(keyOf(shared.sha256))).toBe(true); // ikiz belge hâlâ kullanıyor
    expect((await h.call('legal', 'GET', `/api/v1/document-versions/${twin.body.documentVersionId}/content`)).status).toBe(200);
    expect((await h.call('legal', 'GET', `/api/v1/document-versions/${shared.versionId}/content`)).status).toBe(410);
  });

  // v2 Faz 1 (D93): işlev onaylı kaldırma listesinde; davranış removed-v1.test.ts ile 403 olarak korunur
  it.skip('şirket kapsamı partinin tamamını görmeyen kişi karar veremez', async () => {
    await h.call('legal', 'PUT', '/api/v1/retention/policies/OTHER', { body: { retentionMonths: 12, legalBasis: 'Kurum saklama politikası md. 7 (sentetik)' } });
    const d = await oldDocument(h.world.companyA2.id, 'OTHER', 'ikinci şirket');
    const p = await h.call('legal', 'POST', '/api/v1/disposal-batches', { body: { documentIds: [d.documentId], reason: 'Saklama süresi doldu (sentetik).' } });
    const r = await h.call('legal2', 'POST', `/api/v1/disposal-batches/${p.body.id}/decision`, { body: { decision: 'APPROVE', note: 'Onay (sentetik).' } });
    expect(r.status).toBe(403);
    expect(r.body.error.code).toBe('scope_incomplete');
    expect((await h.call('legal2', 'POST', `/api/v1/disposal-batches/${p.body.id}/decision`, { body: { decision: 'REJECT', note: 'Kapsam dışı.' } })).status).toBe(403);
  });
});

describe('kiracı dışa aktarımı (T48)', () => {
  it('iki kişi onayıyla üretilir; yalnız bu kiracının verisi ve belgeleri vardır; yalnız talep eden indirir', async () => {
    const mine = await h.upload('legal', pdf('dışa aktarılacak'), { companyId: h.world.companyA2.id, kind: 'CONTRACT', title: 'A kiracısı belgesi (sentetik)' });
    const other = await h.upload('buyerB', pdf('başka kiracı'), { companyId: h.world.companyB1.id, kind: 'OTHER', title: 'B kiracısı belgesi (sentetik)' }, h.world.tenantB);
    expect(other.status).toBe(201);
    expect((await h.call('legal', 'POST', '/api/v1/tenant-exports', { body: { reason: 'Yetkisiz talep denemesi.' } })).status).toBe(403);
    const req = await h.call('tenantAdmin', 'POST', '/api/v1/tenant-exports', { body: { reason: 'Sözleşme sonu veri iadesi (sentetik).' } });
    expect(req.status).toBe(201);
    expect((await h.call('tenantAdmin', 'POST', '/api/v1/tenant-exports', { body: { reason: 'İkinci talep (sentetik).' } })).status).toBe(409);
    expect((await h.call('tenantAdmin', 'POST', `/api/v1/tenant-exports/${req.body.id}/download`)).status).toBe(409);
    const ok = await h.call('legal', 'POST', `/api/v1/tenant-exports/${req.body.id}/decision`, { body: { decision: 'APPROVE', note: 'Gerekçe uygun (sentetik).' } });
    expect(ok.body.status).toBe('APPROVED');
    await runJobs();
    const list = await h.call('tenantAdmin', 'GET', '/api/v1/tenant-exports');
    const e = list.body.items.find((x: any) => x.id === req.body.id);
    expect(e.status).toBe('READY');
    expect((await h.call('legal', 'POST', `/api/v1/tenant-exports/${req.body.id}/download`)).status).toBe(403);
    const dl = await h.call('tenantAdmin', 'POST', `/api/v1/tenant-exports/${req.body.id}/download`);
    expect(dl.status).toBe(200);
    expect(dl.body.url).toContain('exports');

    const key = (await h.owner.query(`SELECT storage_key FROM tenant_exports WHERE id = $1`, [req.body.id])).rows[0].storage_key;
    const packed = await h.store.get(key);
    const rec = (await h.owner.query(`SELECT size_bytes::text, sha256 FROM tenant_exports WHERE id = $1`, [req.body.id])).rows[0];
    // Akışlı üretim: kaydedilen boyut ve özet, depodaki nesnenin kendisiyle aynı.
    expect(rec.size_bytes).toBe(String(packed.length));
    expect(rec.sha256).toBe(createHash('sha256').update(packed).digest('hex'));
    const zip = readZip(packed);
    const manifest = JSON.parse(zip.get('manifest.json')!.toString());
    expect(manifest).toMatchObject({ format: 'sp-tenant-export/1', tenantId: h.world.tenantA });
    for (const [t, m] of Object.entries(manifest.tables as Record<string, { rows: number; sha256: string }>)) {
      const body = zip.get(`data/${t}.jsonl`)!;
      expect(createHash('sha256').update(body).digest('hex')).toBe(m.sha256);
      expect(body.toString().split('\n').filter(Boolean).length).toBe(m.rows);
    }
    // Başka kiracının hiçbir satırı yok: kiracı sütunu olan her kayıt A'ya ait.
    let rows = 0;
    for (const [name, body] of zip) {
      if (!name.startsWith('data/') || name === 'data/users.jsonl' || name === 'data/tenants.jsonl') continue;
      for (const line of body.toString().split('\n').filter(Boolean)) { expect(JSON.parse(line).tenant_id).toBe(h.world.tenantA); rows++; }
    }
    expect(rows).toBeGreaterThan(10);
    expect(zip.get('data/tenants.jsonl')!.toString()).not.toContain(h.world.tenantB);
    expect(zip.get('data/documents.jsonl')!.toString()).toContain(mine.body.documentId);
    expect(zip.get('data/documents.jsonl')!.toString()).not.toContain(other.body.documentId);
    // Tüm şirketlerin belgeleri (talep edenin şirket kapsamı boş olsa da) ve bayt bütünlüğü.
    expect(zip.has(`files/${mine.body.sha256}`)).toBe(true);
    expect(zip.has(`files/${other.body.sha256}`)).toBe(false);
    for (const f of manifest.files) expect(createHash('sha256').update(zip.get(f.path)!).digest('hex')).toBe(f.sha256);
    expect(manifest.tables.audit_events.rows).toBeGreaterThan(0);
    const trail = await h.owner.query(`SELECT action FROM audit_events WHERE entity_id = $1 ORDER BY id`, [req.body.id]);
    expect(trail.rows.map((r) => r.action)).toEqual(['tenant.export.requested', 'tenant.export.approved', 'tenant.export.ready', 'tenant.export.download']);
  });
});

describe('v2 son doğrulama: aynı içerik birden çok anahtarda', () => {
  it('aynı özetli iki nesne pakete bir kez girer; iş "duplicate zip entry" ile düşmez', async () => {
    // v2 Faz 5'ten beri yüklemeler rastgele anahtarla saklanır: aynı baytlar iki ayrı anahtarda bulunabilir.
    const file = pdf('ikiz içerik');
    const a = await h.upload('legal', file, { companyId: h.world.companyA1.id, kind: 'OTHER', title: 'ikiz A (sentetik)' });
    const b = await h.upload('legal', file, { companyId: h.world.companyA1.id, kind: 'CONTRACT', title: 'ikiz B (sentetik)' });
    expect(a.body.sha256).toBe(b.body.sha256);
    const altKey = `t/${h.world.tenantA}/supplier-documents/${randomUUID()}`;
    await h.store.put(altKey, file.data, 'application/pdf');
    // Test kurulumu (sahip oturumu, tetikleyiciler kapalı): ikinci sürüm aynı baytları başka anahtarda tutar.
    const c = await h.owner.connect();
    try {
      await c.query('BEGIN'); await c.query(`SET LOCAL session_replication_role = replica`);
      await c.query(`UPDATE document_versions SET storage_key = $2 WHERE id = $1`, [b.body.documentVersionId, altKey]);
      await c.query('COMMIT');
    } finally { c.release(); }
    await h.owner.query(`UPDATE tenant_exports SET status = 'FAILED' WHERE tenant_id = $1 AND status NOT IN ('READY','FAILED','REJECTED','EXPIRED')`, [h.world.tenantA]).catch(() => undefined);
    const req = await h.call('tenantAdmin', 'POST', '/api/v1/tenant-exports', { body: { reason: 'İkiz içerik denemesi (sentetik).' } });
    expect(req.status).toBe(201);
    await h.call('legal', 'POST', `/api/v1/tenant-exports/${req.body.id}/decision`, { body: { decision: 'APPROVE', note: 'Gerekçe uygun (sentetik).' } });
    await runJobs();
    const e = (await h.call('tenantAdmin', 'GET', '/api/v1/tenant-exports')).body.items.find((x: any) => x.id === req.body.id);
    expect(e.status).toBe('READY');
    const key = (await h.owner.query(`SELECT storage_key FROM tenant_exports WHERE id = $1`, [req.body.id])).rows[0].storage_key;
    const manifest = JSON.parse(readZip(await h.store.get(key)).get('manifest.json')!.toString());
    expect(manifest.files.filter((f: any) => f.sha256 === a.body.sha256)).toHaveLength(1);
  });
});

describe('Faz 7 inceleme bulguları', () => {
  it('işi ölen dışa aktarım "Hata" olur ve yeni talebi kalıcı olarak engellemez', async () => {
    // Önceki testlerdeki açık talepler varsa sonuçlansın.
    await runJobs();
    const req = await h.call('tenantAdmin', 'POST', '/api/v1/tenant-exports', { body: { reason: 'Takılan iş denemesi (sentetik).' } });
    expect(req.status).toBe(201);
    await h.call('legal', 'POST', `/api/v1/tenant-exports/${req.body.id}/decision`, { body: { decision: 'APPROVE', note: 'Onay (sentetik).' } });
    // Worker çökmesi/tekrar denemelerin bitmesi: iş DEAD, dışa aktarım satırı APPROVED'da kaldı.
    await h.owner.query(`UPDATE jobs SET status = 'DEAD' WHERE idempotency_key = $1`, [`export:${req.body.id}`]);
    const list = await h.call('tenantAdmin', 'GET', '/api/v1/tenant-exports');
    expect(list.body.items.find((x: any) => x.id === req.body.id)).toMatchObject({ status: 'FAILED' });
    expect((await h.call('tenantAdmin', 'POST', '/api/v1/tenant-exports', { body: { reason: 'Yeniden deneme (sentetik).' } })).status).toBe(201);
  });

  // v2 Faz 1 (D93): işlev onaylı kaldırma listesinde; davranış removed-v1.test.ts ile 403 olarak korunur
  it.skip('onaylayan kiracıdan ayrılsa da imha edilen belgenin baytları silinir; sonuç partide görünür', async () => {
    await h.call('legal', 'PUT', '/api/v1/retention/policies/OTHER', { body: { retentionMonths: 12, legalBasis: 'Kurum saklama politikası md. 7 (sentetik)' } });
    const d = await oldDocument(h.world.companyA1.id, 'OTHER', 'ayrılan onaylayan');
    const p = await h.call('legal', 'POST', '/api/v1/disposal-batches', { body: { documentIds: [d.documentId], reason: 'Saklama süresi doldu (sentetik).' } });
    expect((await h.call('legal2', 'POST', `/api/v1/disposal-batches/${p.body.id}/decision`, { body: { decision: 'APPROVE', note: 'Onay (sentetik).' } })).body.disposed).toBe(1);
    await h.owner.query(`UPDATE memberships SET status = 'REVOKED' WHERE user_id = $1 AND tenant_id = $2`, [h.world.users.legal2.id, h.world.tenantA]);
    try {
      await runJobs();
      expect(await h.store.exists(keyOf(d.sha256))).toBe(false);
      const batch = await h.call('legal', 'GET', `/api/v1/disposal-batches/${p.body.id}`);
      expect(batch.body.result.purge).toMatchObject({ deleted: 1, kept: 0 });
    } finally {
      await h.owner.query(`UPDATE memberships SET status = 'ACTIVE' WHERE user_id = $1 AND tenant_id = $2`, [h.world.users.legal2.id, h.world.tenantA]);
    }
  });
});
