// v2 Faz 8 (D113, R5): ERP uç noktası sırları için zarf şifreleme.
// INTEGRATION_SECRET_KEY (≥32 bayt) → HKDF-SHA256 (info 'sp-integration-kek-v1') anahtar şifreleme anahtarı (KEK); kek_id = anahtarın
// SHA-256 özetinin ilk 8 hex'i. Her kayıtta rastgele 32 baytlık veri anahtarı (DEK); sır AES-256-GCM ile şifrelenir, DEK de KEK ile
// AES-256-GCM sarılır. İkisinde de AAD = `tenant_id|endpoint_id|feature`; IV 12 bayt; GCM etiketi (16 bayt) şifreli metnin sonundadır.
// Hiçbir hata iletisi sır, anahtar ya da şifreli metin içermez. Düz metin yalnız sağlayıcı çağrısı anında açılır (loadEndpointSecret).
import { createCipheriv, createDecipheriv, createHash, hkdfSync, randomBytes } from 'node:crypto';
import type { Tx } from './db.ts';

export type SealedSecret = { kekId: string; wrappedDek: Buffer; dekIv: Buffer; secretIv: Buffer; ciphertext: Buffer };

export class SecretKeyNotConfigured extends Error { constructor() { super('secret_key_not_configured'); this.name = 'SecretKeyNotConfigured'; } }
/** Sır başka bir anahtarla mühürlenmiş: çözme denenmez, sır yeniden girilmeli. */
export class SecretKekMismatch extends Error { constructor() { super('secret_kek_mismatch'); this.name = 'SecretKekMismatch'; } }
/** Kimlik doğrulama etiketi tutmadı (başka kiracı/uç nokta/özellik AAD'si ya da kurcalanmış veri). */
export class SecretOpenFailed extends Error { constructor() { super('secret_open_failed'); this.name = 'SecretOpenFailed'; } }

const KEK_INFO = 'sp-integration-kek-v1';
const TAG = 16;
const MAX_PLAIN_BYTES = 4096;

export const secretAad = (tenantId: string, endpointId: string, feature: string) => `${tenantId}|${endpointId}|${feature}`;

function gcmSeal(key: Buffer, iv: Buffer, plain: Buffer, aad: string): Buffer {
  const c = createCipheriv('aes-256-gcm', key, iv);
  c.setAAD(Buffer.from(aad, 'utf8'));
  return Buffer.concat([c.update(plain), c.final(), c.getAuthTag()]);
}

function gcmOpen(key: Buffer, iv: Buffer, sealed: Buffer, aad: string): Buffer {
  if (iv.length !== 12 || sealed.length <= TAG) throw new SecretOpenFailed();
  try {
    const d = createDecipheriv('aes-256-gcm', key, iv);
    d.setAAD(Buffer.from(aad, 'utf8'));
    d.setAuthTag(sealed.subarray(sealed.length - TAG));
    return Buffer.concat([d.update(sealed.subarray(0, sealed.length - TAG)), d.final()]);
  } catch {
    throw new SecretOpenFailed();
  }
}

export class SecretBox {
  readonly kekId: string | null;
  readonly #kek: Buffer | null;

  constructor(key: Buffer | null) {
    if (key && key.length < 32) throw new Error('INTEGRATION_SECRET_KEY en az 32 bayt olmalı');
    this.#kek = key ? Buffer.from(hkdfSync('sha256', key, Buffer.alloc(0), KEK_INFO, 32)) : null;
    this.kekId = key ? createHash('sha256').update(key).digest('hex').slice(0, 8) : null;
  }

  get configured(): boolean { return this.#kek !== null; }

  seal(plain: string, aad: string): SealedSecret {
    if (!this.#kek || !this.kekId) throw new SecretKeyNotConfigured();
    const bytes = Buffer.from(plain, 'utf8');
    if (bytes.length === 0 || bytes.length > MAX_PLAIN_BYTES) throw new Error('secret_length_invalid');
    const dek = randomBytes(32);
    const secretIv = randomBytes(12);
    const dekIv = randomBytes(12);
    try {
      return { kekId: this.kekId, ciphertext: gcmSeal(dek, secretIv, bytes, aad), secretIv, dekIv, wrappedDek: gcmSeal(this.#kek, dekIv, dek, aad) };
    } finally { dek.fill(0); }
  }

  open(s: SealedSecret, aad: string): string {
    if (!this.#kek) throw new SecretKeyNotConfigured();
    if (s.kekId !== this.kekId) throw new SecretKekMismatch();
    const dek = gcmOpen(this.#kek, s.dekIv, s.wrappedDek, aad);
    try {
      if (dek.length !== 32) throw new SecretOpenFailed();
      return gcmOpen(dek, s.secretIv, s.ciphertext, aad).toString('utf8');
    } finally { dek.fill(0); }
  }
}

type SecretRow = { tenant_id: string; feature: string; kek_id: string; wrapped_dek: Buffer; dek_iv: Buffer; secret_iv: Buffer; ciphertext: Buffer; updated_at: Date };

async function secretRow(tx: Tx, endpointId: string): Promise<SecretRow | null> {
  const r = await tx.query<SecretRow>(
    `SELECT s.tenant_id, e.feature, s.kek_id, s.wrapped_dek, s.dek_iv, s.secret_iv, s.ciphertext, s.updated_at
       FROM integration_endpoint_secrets s JOIN integration_endpoints e ON e.tenant_id = s.tenant_id AND e.id = s.endpoint_id
      WHERE s.endpoint_id = $1`, [endpointId]);
  return r.rows[0] ?? null;
}

/**
 * Sırrı yalnız sağlayıcı çağrısı anında açar (RLS: yalnız bağlamdaki kiracı). Sır yoksa null.
 * Anahtar değiştiyse SecretKekMismatch, AAD/etiket tutmazsa SecretOpenFailed; ikisi de sır içermez.
 */
export async function loadEndpointSecret(tx: Tx, endpointId: string, box: SecretBox): Promise<string | null> {
  const row = await secretRow(tx, endpointId);
  if (!row) return null;
  return box.open({ kekId: row.kek_id, wrappedDek: row.wrapped_dek, dekIv: row.dek_iv, secretIv: row.secret_iv, ciphertext: row.ciphertext },
    secretAad(row.tenant_id, endpointId, row.feature));
}

/** Sırrı mühürleyip yazar (üzerine yazma = yeni veri anahtarı). Anahtar yoksa SecretKeyNotConfigured (API: 409 secret_key_not_configured). */
export async function storeEndpointSecret(tx: Tx, box: SecretBox, endpointId: string, plain: string, userId: string): Promise<void> {
  if (!box.configured) throw new SecretKeyNotConfigured();
  const ep = (await tx.query<{ tenant_id: string; feature: string }>(`SELECT tenant_id, feature FROM integration_endpoints WHERE id = $1`, [endpointId])).rows[0];
  if (!ep) throw new Error('endpoint_not_found');
  const s = box.seal(plain, secretAad(ep.tenant_id, endpointId, ep.feature));
  await tx.query(
    `INSERT INTO integration_endpoint_secrets (endpoint_id, tenant_id, kek_id, wrapped_dek, dek_iv, secret_iv, ciphertext, updated_by, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8, now())
     ON CONFLICT (endpoint_id) DO UPDATE SET kek_id = EXCLUDED.kek_id, wrapped_dek = EXCLUDED.wrapped_dek, dek_iv = EXCLUDED.dek_iv,
       secret_iv = EXCLUDED.secret_iv, ciphertext = EXCLUDED.ciphertext, updated_by = EXCLUDED.updated_by, updated_at = now()`,
    [endpointId, ep.tenant_id, s.kekId, s.wrappedDek, s.dekIv, s.secretIv, s.ciphertext, userId]);
}

/** Ekran/GET için tek bilgi: ayarlı mı, ne zaman, anahtar değiştiği için yeniden girilmeli mi. Sır ve şifreli metin dönmez. */
export async function endpointSecretStatus(tx: Tx, box: SecretBox, endpointId: string): Promise<{ secretSet: boolean; secretUpdatedAt: string | null; needsReentry: boolean }> {
  const r = await tx.query<{ kek_id: string; updated_at: Date }>(`SELECT kek_id, updated_at FROM integration_endpoint_secrets WHERE endpoint_id = $1`, [endpointId]);
  const row = r.rows[0];
  if (!row) return { secretSet: false, secretUpdatedAt: null, needsReentry: false };
  return { secretSet: true, secretUpdatedAt: row.updated_at.toISOString(), needsReentry: row.kek_id !== box.kekId };
}
