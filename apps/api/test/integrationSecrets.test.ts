// v2 Faz 8 (D113) Görev 3: sır kutusu (R5 zarf şifreleme) ve ERP yapılandırması (ERP_PROVIDER, INTEGRATION_SECRET_KEY,
// INTEGRATION_ALLOWED_HOSTS). Anahtar ve sırlar sentetiktir; hiçbir hata iletisi anahtar ya da sır değeri içermez.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHash, randomBytes } from 'node:crypto';
import { withTenant, type TenantContext } from '../src/db.ts';
import { loadErp } from '../src/config.ts';
import {
  SecretBox, SecretKekMismatch, SecretKeyNotConfigured, SecretOpenFailed, endpointSecretStatus, loadEndpointSecret, secretAad, storeEndpointSecret,
} from '../src/integrationSecrets.ts';
import { makeHarness } from './harness.ts';

const KEY = Buffer.alloc(32, 7);
const OTHER_KEY = Buffer.alloc(32, 9);
const PLAIN = 'Sentetik-Parola-ÇĞŞ-öü-9f8e7d';

describe('SecretBox (R5)', () => {
  it('seal/open gidiş-dönüş; GCM etiketi şifreli metnin ve sarılı anahtarın sonunda, IV 12 bayt', () => {
    const box = new SecretBox(KEY);
    const aad = secretAad('t1', 'e1', 'INVOICE');
    const s = box.seal(PLAIN, aad);
    expect(s.kekId).toBe(createHash('sha256').update(KEY).digest('hex').slice(0, 8));
    expect(box.kekId).toBe(s.kekId);
    expect(s.dekIv.length).toBe(12);
    expect(s.secretIv.length).toBe(12);
    expect(s.wrappedDek.length).toBe(48); // 32 bayt veri anahtarı + 16 bayt etiket
    expect(s.ciphertext.length).toBe(Buffer.byteLength(PLAIN) + 16);
    expect(s.ciphertext.includes(Buffer.from(PLAIN))).toBe(false);
    expect(box.open(s, aad)).toBe(PLAIN);
  });

  it('aynı düz metin iki kez farklı şifreli metin (rastgele veri anahtarı ve IV)', () => {
    const box = new SecretBox(KEY);
    const a = box.seal(PLAIN, 'x|y|INVOICE');
    const b = box.seal(PLAIN, 'x|y|INVOICE');
    expect(a.ciphertext.equals(b.ciphertext)).toBe(false);
    expect(a.wrappedDek.equals(b.wrappedDek)).toBe(false);
    expect(a.secretIv.equals(b.secretIv)).toBe(false);
  });

  it('başka kiracı / uç nokta / özellik AAD ile open hata verir; ileti sır içermez', () => {
    const box = new SecretBox(KEY);
    const s = box.seal(PLAIN, secretAad('t1', 'e1', 'INVOICE'));
    for (const aad of [secretAad('t2', 'e1', 'INVOICE'), secretAad('t1', 'e2', 'INVOICE'), secretAad('t1', 'e1', 'SUPPLIER')]) {
      const err = (() => { try { box.open(s, aad); return null; } catch (e) { return e as Error; } })();
      expect(err).toBeInstanceOf(SecretOpenFailed);
      expect(err!.message).not.toContain(PLAIN);
    }
  });

  it('kurcalanmış şifreli metin ya da sarılı anahtar açılmaz', () => {
    const box = new SecretBox(KEY);
    const aad = secretAad('t1', 'e1', 'INVOICE');
    const s = box.seal(PLAIN, aad);
    const ct = Buffer.from(s.ciphertext); ct[0]! ^= 1;
    expect(() => box.open({ ...s, ciphertext: ct }, aad)).toThrow(SecretOpenFailed);
    const wd = Buffer.from(s.wrappedDek); wd[wd.length - 1]! ^= 1;
    expect(() => box.open({ ...s, wrappedDek: wd }, aad)).toThrow(SecretOpenFailed);
  });

  it('yanlış anahtar: kek_id uyuşmaz, çözme denenmez', () => {
    const s = new SecretBox(KEY).seal(PLAIN, 'a|b|INVOICE');
    const other = new SecretBox(OTHER_KEY);
    expect(other.kekId).not.toBe(s.kekId);
    expect(() => other.open(s, 'a|b|INVOICE')).toThrow(SecretKekMismatch);
  });

  it('anahtar yoksa seal/open secret_key_not_configured; kısa anahtar reddedilir; boş sır reddedilir', () => {
    const none = new SecretBox(null);
    expect(none.kekId).toBeNull();
    expect(() => none.seal(PLAIN, 'a')).toThrow(SecretKeyNotConfigured);
    expect(new SecretKeyNotConfigured().message).toBe('secret_key_not_configured');
    expect(() => new SecretBox(Buffer.alloc(16, 1))).toThrow(/32/);
    expect(() => new SecretBox(KEY).seal('', 'a')).toThrow();
  });
});

describe('ERP yapılandırması (loadErp)', () => {
  const k64 = randomBytes(32).toString('base64');
  it('varsayılan none; anahtar ve izinli adresler okunur', () => {
    expect(loadErp('development', {})).toEqual({ provider: 'none', secretKey: null, allowedHosts: [] });
    const c = loadErp('development', { ERP_PROVIDER: 'taklit', INTEGRATION_SECRET_KEY: k64, INTEGRATION_ALLOWED_HOSTS: ' ebs.kurum.local , 10.0.0.0/8,' });
    expect(c.provider).toBe('taklit');
    expect(c.secretKey!.equals(Buffer.from(k64, 'base64'))).toBe(true);
    expect(c.allowedHosts).toEqual(['ebs.kurum.local', '10.0.0.0/8']);
  });

  it('ERP_PROVIDER=taklit üretimde reddedilir; iletide anahtar değeri yok', () => {
    const err = (() => { try { loadErp('production', { ERP_PROVIDER: 'taklit', INTEGRATION_SECRET_KEY: k64 }); return null; } catch (e) { return e as Error; } })();
    expect(err!.message).toMatch(/ERP_PROVIDER=taklit/);
    expect(err!.message).not.toContain(k64);
  });

  it('oracle-ebs üretimde anahtarsız ya da kısa anahtarla açılmaz; değer iletiye yazılmaz', () => {
    expect(() => loadErp('production', { ERP_PROVIDER: 'oracle-ebs' })).toThrow(/INTEGRATION_SECRET_KEY/);
    const short = Buffer.alloc(16, 3).toString('base64');
    const err = (() => { try { loadErp('production', { ERP_PROVIDER: 'oracle-ebs', INTEGRATION_SECRET_KEY: short }); return null; } catch (e) { return e as Error; } })();
    expect(err!.message).toMatch(/INTEGRATION_SECRET_KEY/);
    expect(err!.message).not.toContain(short);
    const bad = 'not base64 !!secret-value';
    const err2 = (() => { try { loadErp('development', { INTEGRATION_SECRET_KEY: bad }); return null; } catch (e) { return e as Error; } })();
    expect(err2!.message).not.toContain(bad);
    expect(loadErp('production', { ERP_PROVIDER: 'oracle-ebs', INTEGRATION_SECRET_KEY: k64 }).provider).toBe('oracle-ebs');
  });

  it('geçersiz sağlayıcı değeri iletiye kopyalanmaz', () => {
    const err = (() => { try { loadErp('development', { ERP_PROVIDER: 'gizli-deger-xyz' }); return null; } catch (e) { return e as Error; } })();
    expect(err!.message).not.toContain('gizli-deger-xyz');
  });
});

describe('uç nokta sırrı veritabanında (loadEndpointSecret)', () => {
  let h: Awaited<ReturnType<typeof makeHarness>>;
  const box = new SecretBox(KEY);
  beforeAll(async () => { h = await makeHarness(); });
  afterAll(async () => { await h?.close(); });
  const admin = (): TenantContext => ({ tenantId: h.world.tenantA, userId: h.world.users.tenantAdmin.id, roles: ['TENANT_ADMIN'],
    companyIds: [h.world.companyA1.id], departmentIds: [], allDepartments: true, correlationId: 'v2-faz8-secrets' });
  const adminB = (): TenantContext => ({ tenantId: h.world.tenantB, userId: h.world.users.buyerB.id, roles: ['PROCUREMENT'],
    companyIds: [h.world.companyB1.id], departmentIds: [], allDepartments: true, correlationId: 'v2-faz8-secrets-b' });
  async function endpoint(ctx: TenantContext, feature: string) {
    return withTenant(h.pool, ctx, async (tx) => {
      const ex = await tx.query<{ id: string }>(`SELECT id FROM integration_endpoints WHERE feature = $1`, [feature]);
      if (ex.rows[0]) return ex.rows[0].id;
      return (await tx.query<{ id: string }>(`INSERT INTO integration_endpoints (tenant_id, feature, updated_by) VALUES ($1,$2,$3) RETURNING id`,
        [ctx.tenantId, feature, ctx.userId])).rows[0]!.id;
    });
  }

  it('saklanır, durum yalnız ayarlı/tarih döner, sağlayıcı çağrısı için açılır; satırda düz metin yok', async () => {
    const ep = await endpoint(admin(), 'PURCHASE_ORDER');
    expect(await withTenant(h.pool, admin(), (tx) => loadEndpointSecret(tx, ep, box))).toBeNull();
    await withTenant(h.pool, admin(), (tx) => storeEndpointSecret(tx, box, ep, PLAIN, admin().userId));
    const status = await withTenant(h.pool, admin(), (tx) => endpointSecretStatus(tx, box, ep));
    expect(status.secretSet).toBe(true);
    expect(status.secretUpdatedAt).toBeTruthy();
    expect(status.needsReentry).toBe(false);
    expect(JSON.stringify(status)).not.toContain(PLAIN);
    expect(await withTenant(h.pool, admin(), (tx) => loadEndpointSecret(tx, ep, box))).toBe(PLAIN);
    const row = (await h.owner.query(`SELECT * FROM integration_endpoint_secrets WHERE endpoint_id = $1`, [ep])).rows[0];
    expect(JSON.stringify(row)).not.toContain(PLAIN);
    expect(Buffer.concat([row.ciphertext, row.wrapped_dek]).includes(Buffer.from(PLAIN))).toBe(false);
    // Üzerine yazma: yeni sır, yeni veri anahtarı
    await withTenant(h.pool, admin(), (tx) => storeEndpointSecret(tx, box, ep, PLAIN + '-2', admin().userId));
    expect(await withTenant(h.pool, admin(), (tx) => loadEndpointSecret(tx, ep, box))).toBe(PLAIN + '-2');
  });

  it('anahtar değişince kek_id uyuşmaz: durum "yeniden girilmeli", açma denenmez', async () => {
    const ep = await endpoint(admin(), 'COST_CENTER');
    await withTenant(h.pool, admin(), (tx) => storeEndpointSecret(tx, box, ep, PLAIN, admin().userId));
    const rotated = new SecretBox(OTHER_KEY);
    const st = await withTenant(h.pool, admin(), (tx) => endpointSecretStatus(tx, rotated, ep));
    expect(st).toMatchObject({ secretSet: true, needsReentry: true });
    await expect(withTenant(h.pool, admin(), (tx) => loadEndpointSecret(tx, ep, rotated))).rejects.toBeInstanceOf(SecretKekMismatch);
  });

  it('başka kiracının uç noktasına kopyalanan şifreli metin çözülmez (AAD)', async () => {
    const epA = await endpoint(admin(), 'INVOICE');
    const epB = await endpoint(adminB(), 'INVOICE');
    await withTenant(h.pool, admin(), (tx) => storeEndpointSecret(tx, box, epA, PLAIN, admin().userId));
    await h.owner.query(`INSERT INTO integration_endpoint_secrets (endpoint_id, tenant_id, kek_id, wrapped_dek, dek_iv, secret_iv, ciphertext, updated_by)
      SELECT $1, $2, kek_id, wrapped_dek, dek_iv, secret_iv, ciphertext, $3 FROM integration_endpoint_secrets WHERE endpoint_id = $4
      ON CONFLICT (endpoint_id) DO UPDATE SET kek_id = EXCLUDED.kek_id, wrapped_dek = EXCLUDED.wrapped_dek, dek_iv = EXCLUDED.dek_iv,
        secret_iv = EXCLUDED.secret_iv, ciphertext = EXCLUDED.ciphertext`, [epB, h.world.tenantB, h.world.users.buyerB.id, epA]);
    await expect(withTenant(h.pool, adminB(), (tx) => loadEndpointSecret(tx, epB, box))).rejects.toBeInstanceOf(SecretOpenFailed);
    // Kiracı A bağlamından kiracı B uç noktası görünmez (RLS): sır yok sayılır.
    expect(await withTenant(h.pool, admin(), (tx) => loadEndpointSecret(tx, epB, box))).toBeNull();
  });

  it('anahtar yoksa saklama secret_key_not_configured', async () => {
    const ep = await endpoint(admin(), 'PAYMENT_STATUS');
    await expect(withTenant(h.pool, admin(), (tx) => storeEndpointSecret(tx, new SecretBox(null), ep, PLAIN, admin().userId)))
      .rejects.toBeInstanceOf(SecretKeyNotConfigured);
  });
});
