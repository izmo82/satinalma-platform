import { constants, crc32, deflateRawSync, inflateRawSync } from 'node:zlib';

/** ZIP baytlarının gittiği yer (ör. nesne deposuna parçalı yükleme). `write` beklenir: geri basınç. */
export interface ByteSink { write(chunk: Buffer): Promise<void> }

const U32 = 0xffffffff;

/**
 * Bağımlılıksız, akışlı ZIP üretici (kiracı dışa aktarım paketi). Bellekte yalnız o an yazılan parça ve merkezi dizin tutulur.
 * - Bilinen baytlar (`addFile`): yerel başlıkta CRC ve boyut; sıkıştırılmış belgeler olduğu gibi saklanır.
 * - Boyutu baştan bilinmeyen içerik (`entry`): deflate, parça parça; CRC ve boyut veri tanımlayıcısında (bit 3).
 *   Her parça bağımsız bir deflate dizisidir ve senkron boşaltmayla biter; ardışık bloklar geçerli tek bir deflate akışıdır.
 * - ZIP64: 4 GB üstü konum, 4 GB üstü tek girdi (64 bit veri tanımlayıcısı + merkezi dizinde ZIP64 alanı), 65535 üstü dosya.
 */
export class ZipStreamWriter {
  private central: Buffer[] = [];
  private offset = 0;
  private count = 0;
  private names = new Set<string>();
  private open = false;

  /** `limit` yalnız testte küçültülür (ZIP64 yollarını küçük veriyle sınamak için). */
  constructor(private sink: ByteSink, private date = new Date(), private limit = U32) {}

  get size() { return this.offset; }

  private async out(b: Buffer) { this.offset += b.length; await this.sink.write(b); }

  private name(name: string) {
    if (this.open) throw new Error('previous zip entry not closed');
    if (this.names.has(name)) throw new Error(`duplicate zip entry: ${name}`);
    if (!/^[\w./-]+$/.test(name) || name.includes('..') || name.startsWith('/')) throw new Error(`unsafe zip entry name: ${name}`);
    this.names.add(name);
    return Buffer.from(name, 'utf8');
  }

  private local(nameBuf: Buffer, flags: number, method: number, crc: number, csize: number, usize: number) {
    const { time, date } = dosDateTime(this.date);
    const h = Buffer.alloc(30);
    h.writeUInt32LE(0x04034b50, 0);
    h.writeUInt16LE(20, 4);
    h.writeUInt16LE(flags, 6);
    h.writeUInt16LE(method, 8);
    h.writeUInt16LE(time, 10);
    h.writeUInt16LE(date, 12);
    h.writeUInt32LE(crc, 14);
    h.writeUInt32LE(csize, 18);
    h.writeUInt32LE(usize, 22);
    h.writeUInt16LE(nameBuf.length, 26);
    return h;
  }

  private addCentral(nameBuf: Buffer, flags: number, method: number, crc: number, csize: number, usize: number, at: number) {
    const { time, date } = dosDateTime(this.date);
    // ZIP64 genişletilmiş bilgi: yalnız taşan alanlar, sabit sırayla (boyut, sıkıştırılmış boyut, konum).
    const big = [usize >= this.limit, csize >= this.limit, at >= this.limit];
    const vals = [usize, csize, at].filter((_, i) => big[i]);
    const extra = Buffer.alloc(vals.length ? 4 + 8 * vals.length : 0);
    if (vals.length) {
      extra.writeUInt16LE(0x0001, 0); extra.writeUInt16LE(8 * vals.length, 2);
      vals.forEach((v, i) => extra.writeBigUInt64LE(BigInt(v), 4 + 8 * i));
    }
    const zip64 = vals.length > 0;
    const c = Buffer.alloc(46);
    c.writeUInt32LE(0x02014b50, 0);
    c.writeUInt16LE(zip64 ? 45 : 20, 4);
    c.writeUInt16LE(zip64 ? 45 : 20, 6);
    c.writeUInt16LE(flags, 8);
    c.writeUInt16LE(method, 10);
    c.writeUInt16LE(time, 12);
    c.writeUInt16LE(date, 14);
    c.writeUInt32LE(crc, 16);
    c.writeUInt32LE(big[1] ? U32 : csize, 20);
    c.writeUInt32LE(big[0] ? U32 : usize, 24);
    c.writeUInt16LE(nameBuf.length, 28);
    c.writeUInt16LE(extra.length, 30);
    c.writeUInt32LE(big[2] ? U32 : at, 42);
    this.central.push(c, nameBuf, extra);
    this.count++;
  }

  /** Baytları bilinen dosya (en çok yükleme sınırı kadar; belgeler zaten sıkıştırılmış olduğundan saklanır). */
  async addFile(name: string, data: Buffer) {
    const nameBuf = this.name(name);
    if (data.length >= U32) throw new Error('zip_entry_too_large'); // yerel başlıkta boyut 32 bit (belgeler 25 MB sınırlı)
    const at = this.offset;
    const crc = crc32(data) >>> 0;
    await this.out(Buffer.concat([this.local(nameBuf, 0x0800, 0, crc, data.length, data.length), nameBuf]));
    await this.out(data);
    this.addCentral(nameBuf, 0x0800, 0, crc, data.length, data.length, at);
  }

  /** Boyutu bilinmeyen, sıkıştırılan girdi. `write` parça parça çağrılır, `close` ile biter. */
  async entry(name: string) {
    const nameBuf = this.name(name);
    const flags = 0x0808; // UTF-8 ad + veri tanımlayıcısı
    const at = this.offset;
    await this.out(Buffer.concat([this.local(nameBuf, flags, 8, 0, 0, 0), nameBuf]));
    this.open = true;
    let crc = 0; let usize = 0; let csize = 0;
    const self = this;
    return {
      async write(chunk: Buffer) {
        if (!chunk.length) return;
        crc = crc32(chunk, crc) >>> 0; usize += chunk.length;
        const z = deflateRawSync(chunk, { finishFlush: constants.Z_SYNC_FLUSH });
        csize += z.length;
        await self.out(z);
      },
      async close() {
        const tail = deflateRawSync(Buffer.alloc(0)); // son (boş) blok
        csize += tail.length;
        await self.out(tail);
        // 4 GB üstü girdi: 64 bit veri tanımlayıcısı (merkezi dizinde ZIP64 alanıyla birlikte; okuyucular boyutu oradan alır).
        const wide = usize >= self.limit || csize >= self.limit;
        const dd = Buffer.alloc(wide ? 24 : 16);
        dd.writeUInt32LE(0x08074b50, 0); dd.writeUInt32LE(crc, 4);
        if (wide) { dd.writeBigUInt64LE(BigInt(csize), 8); dd.writeBigUInt64LE(BigInt(usize), 16); }
        else { dd.writeUInt32LE(csize, 8); dd.writeUInt32LE(usize, 12); }
        await self.out(dd);
        self.open = false;
        self.addCentral(nameBuf, flags, 8, crc, csize, usize, at);
        return { bytes: usize };
      },
    };
  }

  /** Merkezi dizini ve sonu yazar; toplam bayt sayısını döner. */
  async finish() {
    if (this.open) throw new Error('zip entry not closed');
    const cdAt = this.offset;
    const cd = Buffer.concat(this.central);
    this.central = [];
    await this.out(cd);
    const zip64 = this.count >= 0xffff || cdAt >= this.limit || cd.length >= this.limit;
    if (zip64) {
      const eocdAt = this.offset;
      const r = Buffer.alloc(56);
      r.writeUInt32LE(0x06064b50, 0); r.writeBigUInt64LE(44n, 4); r.writeUInt16LE(45, 12); r.writeUInt16LE(45, 14);
      r.writeBigUInt64LE(BigInt(this.count), 24); r.writeBigUInt64LE(BigInt(this.count), 32);
      r.writeBigUInt64LE(BigInt(cd.length), 40); r.writeBigUInt64LE(BigInt(cdAt), 48);
      const loc = Buffer.alloc(20);
      loc.writeUInt32LE(0x07064b50, 0); loc.writeBigUInt64LE(BigInt(eocdAt), 8); loc.writeUInt32LE(1, 16);
      await this.out(Buffer.concat([r, loc]));
    }
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0);
    end.writeUInt16LE(Math.min(this.count, 0xffff), 8);
    end.writeUInt16LE(Math.min(this.count, 0xffff), 10);
    end.writeUInt32LE(zip64 ? U32 : cd.length, 12);
    end.writeUInt32LE(zip64 ? U32 : cdAt, 16);
    await this.out(end);
    return this.offset;
  }
}

function dosDateTime(d: Date) {
  return {
    time: (d.getUTCHours() << 11) | (d.getUTCMinutes() << 5) | Math.floor(d.getUTCSeconds() / 2),
    date: ((Math.max(d.getUTCFullYear(), 1980) - 1980) << 9) | ((d.getUTCMonth() + 1) << 5) | d.getUTCDate(),
  };
}

/**
 * Testler ve geri yükleme tatbikatı için: merkezi dizinden dosyaları okur (ZIP64 konumu dahil).
 * `opts` (v2 Faz 4, docxText): `only` yalnız o girdiyi açar (diğerleri hiç açılmaz); `maxOutputLength` açılmış boyutu sınırlar
 * (sıkıştırma bombası). Sınır aşılırsa `ZipEntryTooLargeError`. Seçeneksiz çağrı eski davranıştır.
 */
export class ZipEntryTooLargeError extends Error { constructor(readonly entry: string) { super(`zip entry too large: ${entry}`); this.name = 'ZipEntryTooLargeError'; } }
export function readZip(buf: Buffer, opts: { only?: string; maxOutputLength?: number } = {}): Map<string, Buffer> {
  const endAt = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (endAt < 0) throw new Error('not a zip');
  let count = buf.readUInt16LE(endAt + 10);
  let p = buf.readUInt32LE(endAt + 16);
  if (p === U32) {
    const eocd64 = Number(buf.readBigUInt64LE(endAt - 20 + 8));
    count = Number(buf.readBigUInt64LE(eocd64 + 32));
    p = Number(buf.readBigUInt64LE(eocd64 + 48));
  }
  const out = new Map<string, Buffer>();
  for (let i = 0; i < count; i++) {
    const method = buf.readUInt16LE(p + 10);
    const crc = buf.readUInt32LE(p + 16);
    let csize = buf.readUInt32LE(p + 20);
    let usize = buf.readUInt32LE(p + 24);
    const nlen = buf.readUInt16LE(p + 28);
    const elen = buf.readUInt16LE(p + 30);
    const clen = buf.readUInt16LE(p + 32);
    let off = buf.readUInt32LE(p + 42);
    // ZIP64 alanı: taşan değerler sırayla (boyut, sıkıştırılmış boyut, konum).
    let x = p + 46 + nlen + 4;
    if (usize === U32) { usize = Number(buf.readBigUInt64LE(x)); x += 8; }
    if (csize === U32) { csize = Number(buf.readBigUInt64LE(x)); x += 8; }
    if (off === U32) off = Number(buf.readBigUInt64LE(x));
    const name = buf.subarray(p + 46, p + 46 + nlen).toString('utf8');
    if (opts.only !== undefined && name !== opts.only) { p += 46 + nlen + elen + clen; continue; }
    const max = opts.maxOutputLength;
    if (max !== undefined && usize > max) throw new ZipEntryTooLargeError(name);
    const lnlen = buf.readUInt16LE(off + 26);
    const lelen = buf.readUInt16LE(off + 28);
    const raw = buf.subarray(off + 30 + lnlen + lelen, off + 30 + lnlen + lelen + csize);
    let data: Buffer;
    try {
      // Bildirilen boyut yalan olabilir: açma da sınırla yapılır.
      data = method === 8 ? inflateRawSync(raw, max !== undefined ? { maxOutputLength: max } : {}) : Buffer.from(raw);
    } catch (e) {
      if (max !== undefined && (e as NodeJS.ErrnoException).code === 'ERR_BUFFER_TOO_LARGE') throw new ZipEntryTooLargeError(name);
      throw e;
    }
    if (max !== undefined && data.length > max) throw new ZipEntryTooLargeError(name);
    if ((crc32(data) >>> 0) !== crc || data.length !== usize) throw new Error(`crc/size mismatch: ${name}`);
    out.set(name, data);
    p += 46 + nlen + elen + clen;
  }
  return out;
}
