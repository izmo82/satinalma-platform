import { AbortMultipartUploadCommand, CompleteMultipartUploadCommand, CreateMultipartUploadCommand, DeleteObjectCommand, GetObjectCommand,
  HeadObjectCommand, PutObjectCommand, S3Client, UploadPartCommand } from '@aws-sdk/client-s3';
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
  /** Büyük nesne: parça parça yükleme; bellekte en çok bir parça tutulur. `abort` yarım nesneyi bırakmaz. */
  putStream(key: string, contentType: string): Promise<ObjectUpload>;
}

export interface ObjectUpload {
  write(chunk: Buffer): Promise<void>;
  finish(): Promise<void>;
  abort(): Promise<void>;
}

/** S3 parça sınırı: en az 5 MB (son parça hariç), en çok 10 000 parça → 16 MB ile ~160 GB. */
export const UPLOAD_PART_BYTES = 16 * 1024 * 1024;

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
  async putStream(key: string, contentType: string): Promise<ObjectUpload> {
    const { Bucket } = { Bucket: this.cfg.bucket };
    const sse = this.cfg.endpoint ? undefined : ('AES256' as const);
    const { UploadId } = await this.s3.send(new CreateMultipartUploadCommand({ Bucket, Key: key, ContentType: contentType, ServerSideEncryption: sse }));
    const parts: { ETag: string; PartNumber: number }[] = [];
    let pending: Buffer[] = []; let pendingBytes = 0;
    const flush = async () => {
      if (!pendingBytes && parts.length) return;
      const PartNumber = parts.length + 1;
      const r = await this.s3.send(new UploadPartCommand({ Bucket, Key: key, UploadId, PartNumber, Body: Buffer.concat(pending) }));
      parts.push({ ETag: r.ETag!, PartNumber });
      pending = []; pendingBytes = 0;
    };
    return {
      write: async (chunk) => {
        pending.push(chunk); pendingBytes += chunk.length;
        if (pendingBytes >= UPLOAD_PART_BYTES) await flush();
      },
      finish: async () => {
        await flush();
        await this.s3.send(new CompleteMultipartUploadCommand({ Bucket, Key: key, UploadId, MultipartUpload: { Parts: parts } }));
      },
      abort: async () => {
        pending = [];
        await this.s3.send(new AbortMultipartUploadCommand({ Bucket, Key: key, UploadId })).catch(() => undefined);
      },
    };
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
