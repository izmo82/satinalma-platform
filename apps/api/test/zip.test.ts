import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { readZip, ZipStreamWriter } from '../src/zip.ts';

async function build(fn: (z: ZipStreamWriter) => Promise<void>, limit?: number) {
  const chunks: Buffer[] = [];
  const z = new ZipStreamWriter({ write: async (b) => { chunks.push(b); } }, new Date(), limit);
  await fn(z);
  const size = await z.finish();
  const buf = Buffer.concat(chunks);
  expect(buf.length).toBe(size);
  return buf;
}

/** Bağımsız okuyucuyla (sistem `unzip`) bütünlük denetimi; yoksa atlanır. */
function unzipTest(buf: Buffer) {
  try { execFileSync('unzip', ['-v'], { stdio: 'ignore' }); } catch { return null; }
  const dir = mkdtempSync(join(tmpdir(), 'sp-zip-'));
  try {
    writeFileSync(join(dir, 'a.zip'), buf);
    return execFileSync('unzip', ['-tq', join(dir, 'a.zip')]).toString();
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

describe('Akışlı ZIP', () => {
  it('parça parça sıkıştırılan girdi ve saklanan dosya geri okunur; bağımsız okuyucu doğrular', async () => {
    const rows = Array.from({ length: 5000 }, (_, i) => JSON.stringify({ id: i, tutar: '1234.50', ad: `Satır ${i} ğüşiöç` }) + '\n');
    const bin = randomBytes(300_000);
    const buf = await build(async (z) => {
      const e = await z.entry('data/rows.jsonl');
      for (let i = 0; i < rows.length; i += 700) await e.write(Buffer.from(rows.slice(i, i + 700).join('')));
      await e.close();
      await z.addFile('files/abc', bin);
      const empty = await z.entry('data/bos.jsonl');
      await empty.close();
    });
    const m = readZip(buf);
    expect(m.get('data/rows.jsonl')!.toString()).toBe(rows.join(''));
    expect(m.get('files/abc')!.equals(bin)).toBe(true);
    expect(m.get('data/bos.jsonl')!.length).toBe(0);
    const t = unzipTest(buf);
    if (t !== null) expect(t).toContain('No errors detected');
  });

  it('65535 üstü dosyada ZIP64 sonu yazılır ve okunur', async () => {
    const buf = await build(async (z) => { for (let i = 0; i < 66_000; i++) await z.addFile(`f/${i}`, Buffer.from(String(i))); });
    expect(buf.includes(Buffer.from([0x50, 0x4b, 0x06, 0x06]))).toBe(true);
    const m = readZip(buf);
    expect(m.size).toBe(66_000);
    expect(m.get('f/65999')!.toString()).toBe('65999');
    const t = unzipTest(buf);
    if (t !== null) expect(t).toContain('No errors detected');
  });

  it('4 GB üstü tek girdi ve konum yolu (eşik küçültülerek): 64 bit veri tanımlayıcısı ve ZIP64 alanları okunur', async () => {
    const body = Buffer.from('x'.repeat(50_000));
    const buf = await build(async (z) => {
      await z.addFile('files/a', Buffer.from('ilk dosya'));
      const e = await z.entry('data/buyuk.jsonl');
      for (let i = 0; i < 5; i++) await e.write(body);
      await e.close();
      await z.addFile('files/b', Buffer.from('son dosya'));
    }, 1000);
    const m = readZip(buf);
    expect(m.get('data/buyuk.jsonl')!.length).toBe(250_000);
    expect(m.get('files/b')!.toString()).toBe('son dosya');
    const t = unzipTest(buf);
    if (t !== null) expect(t).toContain('No errors detected');
  });

  it('güvensiz ad, mükerrer ad ve kapanmamış girdi reddedilir', async () => {
    const z = new ZipStreamWriter({ write: async () => {} });
    await expect(z.addFile('../x', Buffer.from('a'))).rejects.toThrow('unsafe');
    await z.addFile('a', Buffer.from('a'));
    await expect(z.addFile('a', Buffer.from('a'))).rejects.toThrow('duplicate');
    await z.entry('b');
    await expect(z.addFile('c', Buffer.from('c'))).rejects.toThrow('not closed');
  });
});
