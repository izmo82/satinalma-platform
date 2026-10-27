import { crc32, deflateRawSync } from 'node:zlib';

/**
 * Bağımlılıksız, bellekte ZIP üretici (dışa aktarım paketi için). Metin dosyaları sıkıştırılır (deflate), zaten sıkıştırılmış
 * belgeler (PDF, görüntü) olduğu gibi saklanır. ZIP64 yoktur: toplam 4 GB ve 65535 dosya sınırı aşılırsa hata verir.
 */
export class ZipWriter {
  private parts: Buffer[] = [];
  private central: Buffer[] = [];
  private offset = 0;
  private count = 0;
  private names = new Set<string>();

  add(name: string, data: Buffer, opts: { compress?: boolean; date?: Date } = {}) {
    if (this.names.has(name)) throw new Error(`duplicate zip entry: ${name}`);
    if (!/^[\w./-]+$/.test(name) || name.includes('..') || name.startsWith('/')) throw new Error(`unsafe zip entry name: ${name}`);
    this.names.add(name);
    const nameBuf = Buffer.from(name, 'utf8');
    const crc = crc32(data) >>> 0;
    const deflated = opts.compress ? deflateRawSync(data) : null;
    const useDeflate = !!deflated && deflated.length < data.length;
    const body = useDeflate ? deflated! : data;
    const { time, date } = dosDateTime(opts.date ?? new Date());
    if (this.offset + body.length + 30 + nameBuf.length > 0xfffffff0 || this.count >= 0xffff) throw new Error('zip_too_large');

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);              // gereken sürüm
    local.writeUInt16LE(0x0800, 6);          // UTF-8 dosya adı
    local.writeUInt16LE(useDeflate ? 8 : 0, 8);
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);

    const cen = Buffer.alloc(46);
    cen.writeUInt32LE(0x02014b50, 0);
    cen.writeUInt16LE(20, 4);
    cen.writeUInt16LE(20, 6);
    cen.writeUInt16LE(0x0800, 8);
    cen.writeUInt16LE(useDeflate ? 8 : 0, 10);
    cen.writeUInt16LE(time, 12);
    cen.writeUInt16LE(date, 14);
    cen.writeUInt32LE(crc, 16);
    cen.writeUInt32LE(body.length, 20);
    cen.writeUInt32LE(data.length, 24);
    cen.writeUInt16LE(nameBuf.length, 28);
    cen.writeUInt32LE(this.offset, 42);

    this.parts.push(local, nameBuf, body);
    this.central.push(cen, nameBuf);
    this.offset += local.length + nameBuf.length + body.length;
    this.count++;
  }

  finish(): Buffer {
    const cd = Buffer.concat(this.central);
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0);
    end.writeUInt16LE(this.count, 8);
    end.writeUInt16LE(this.count, 10);
    end.writeUInt32LE(cd.length, 12);
    end.writeUInt32LE(this.offset, 16);
    return Buffer.concat([...this.parts, cd, end]);
  }

  get size() { return this.offset; }
}

function dosDateTime(d: Date) {
  return {
    time: (d.getUTCHours() << 11) | (d.getUTCMinutes() << 5) | Math.floor(d.getUTCSeconds() / 2),
    date: ((Math.max(d.getUTCFullYear(), 1980) - 1980) << 9) | ((d.getUTCMonth() + 1) << 5) | d.getUTCDate(),
  };
}

/** Testler ve geri yükleme tatbikatı için: merkezi dizinden dosyaları okur (yalnız bu üreticinin yazdığı biçim). */
export async function readZip(buf: Buffer): Promise<Map<string, Buffer>> {
  const { inflateRawSync } = await import('node:zlib');
  const endAt = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (endAt < 0) throw new Error('not a zip');
  const count = buf.readUInt16LE(endAt + 10);
  let p = buf.readUInt32LE(endAt + 16);
  const out = new Map<string, Buffer>();
  for (let i = 0; i < count; i++) {
    const method = buf.readUInt16LE(p + 10);
    const crc = buf.readUInt32LE(p + 16);
    const csize = buf.readUInt32LE(p + 20);
    const nlen = buf.readUInt16LE(p + 28);
    const elen = buf.readUInt16LE(p + 30);
    const clen = buf.readUInt16LE(p + 32);
    const off = buf.readUInt32LE(p + 42);
    const name = buf.subarray(p + 46, p + 46 + nlen).toString('utf8');
    const lnlen = buf.readUInt16LE(off + 26);
    const lelen = buf.readUInt16LE(off + 28);
    const raw = buf.subarray(off + 30 + lnlen + lelen, off + 30 + lnlen + lelen + csize);
    const data = method === 8 ? inflateRawSync(raw) : Buffer.from(raw);
    if ((crc32(data) >>> 0) !== crc) throw new Error(`crc mismatch: ${name}`);
    out.set(name, data);
    p += 46 + nlen + elen + clen;
  }
  return out;
}
