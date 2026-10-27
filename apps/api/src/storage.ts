import { DeleteObjectCommand, GetObjectCommand, HeadObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import type { Config } from './config.ts';

/** Nesne deposu: S3 uyumlu (AWS S3, Cloudflare R2, GCS XML API, MinIO...). Uygulama diske dosya yazmaz. */
export interface ObjectStore {
  put(key: string, body: Buffer, contentType: string): Promise<void>;
  get(key: string): Promise<Buffer>;
  exists(key: string): Promise<boolean>;
  signedGetUrl(key: string, ttlSeconds: number, downloadName: string): Promise<string>;
  /** Yalnız onaylı imha ve süresi dolan dışa aktarım için. Sürümlü bucket'ta silme işareti bırakır; yedeklerden silinme ayrıca belgelenir. */
  delete(key: string): Promise<void>;
}

export class S3ObjectStore implements ObjectStore {
  private s3: S3Client;
  constructor(private cfg: Config['objectStore']) {
    this.s3 = new S3Client({
      region: cfg.region,
      ...(cfg.endpoint ? { endpoint: cfg.endpoint } : {}),
      forcePathStyle: cfg.forcePathStyle,
    });
  }
  async put(key: string, body: Buffer, contentType: string) {
    await this.s3.send(new PutObjectCommand({ Bucket: this.cfg.bucket, Key: key, Body: body, ContentType: contentType,
      ServerSideEncryption: this.cfg.endpoint ? undefined : 'AES256' }));
  }
  async get(key: string) {
    const r = await this.s3.send(new GetObjectCommand({ Bucket: this.cfg.bucket, Key: key }));
    return Buffer.from(await r.Body!.transformToByteArray());
  }
  async exists(key: string) {
    try {
      await this.s3.send(new HeadObjectCommand({ Bucket: this.cfg.bucket, Key: key }));
      return true;
    } catch {
      return false;
    }
  }
  async delete(key: string) {
    await this.s3.send(new DeleteObjectCommand({ Bucket: this.cfg.bucket, Key: key }));
  }
  async signedGetUrl(key: string, ttlSeconds: number, downloadName: string) {
    return getSignedUrl(this.s3, new GetObjectCommand({
      Bucket: this.cfg.bucket, Key: key,
      ResponseContentDisposition: `attachment; filename="${downloadName.replace(/[^\w.\-]/g, '_')}"`,
    }), { expiresIn: ttlSeconds });
  }
}

/** Nesne anahtarı kiracı önekli; tahmin edilen anahtar yetki vermez (erişim yalnız API'den imzalı URL ile). */
export const objectKey = (tenantId: string, sha256: string) => `t/${tenantId}/sha256/${sha256}`;
