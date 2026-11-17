// v2 Faz 5 (R5) Görev 3: virüs taraması bağdaştırıcısı. clamd YALNIZ yerel TCP üzerindeki sahte sunucuyla sınanır — gerçek tarama
// değildir (gerçek ClamAV taraması NOT_RUN). Veri sentetik.
import { afterEach, describe, expect, it } from 'vitest';
import net from 'node:net';
import { loadAv } from '../src/config.ts';
import { ClamAvScanner, classify } from '../src/av/clamav.ts';
import { AV_NOT_CONFIGURED_LABEL, AV_STATUS_LABEL, avScanner, scanStatus, type AvScanner } from '../src/av/index.ts';

type Mode = 'ok' | 'found' | 'error' | 'drop' | 'silent';
const servers: net.Server[] = [];
afterEach(async () => { await Promise.all(servers.splice(0).map((s) => new Promise((r) => s.close(r)))); });

/** Sahte clamd: `zINSTREAM\0` + parçaları okur, sıfır uzunluklu parçada kipine göre yanıt verir. Alınan dosya `received`'ta. */
async function fakeClamd(mode: Mode) {
  const state = { command: '', received: Buffer.alloc(0), chunks: 0 };
  const server = net.createServer((sock) => {
    let buf = Buffer.alloc(0);
    let headerDone = false;
    sock.on('data', (d) => {
      buf = Buffer.concat([buf, d]);
      if (!headerDone) {
        const z = buf.indexOf(0);
        if (z < 0) return;
        state.command = buf.subarray(0, z).toString();
        buf = buf.subarray(z + 1);
        headerDone = true;
      }
      while (buf.length >= 4) {
        const len = buf.readUInt32BE(0);
        if (len === 0) {
          if (mode === 'ok') sock.end('stream: OK\0');
          else if (mode === 'found') sock.end('stream: Eicar-Test-Signature FOUND\0');
          else if (mode === 'error') sock.end('INSTREAM size limit exceeded. ERROR\0');
          else if (mode === 'drop') sock.destroy();
          return; // silent: hiç yanıt yok
        }
        if (buf.length < 4 + len) return;
        state.received = Buffer.concat([state.received, buf.subarray(4, 4 + len)]);
        state.chunks++;
        buf = buf.subarray(4 + len);
      }
    });
    sock.on('error', () => {});
  });
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  return { port: (server.address() as net.AddressInfo).port, state };
}

describe('Yapılandırma (AV_SCANNER)', () => {
  it('defaults_to_none_and_requires_host_for_clamav', () => {
    expect(loadAv({})).toEqual({ kind: 'none' });
    expect(loadAv({ AV_SCANNER: 'none' })).toEqual({ kind: 'none' });
    expect(() => loadAv({ AV_SCANNER: 'clamav' })).toThrow(/CLAMAV_HOST/);
    expect(loadAv({ AV_SCANNER: 'clamav', CLAMAV_HOST: 'clamd.local' })).toEqual({ kind: 'clamav', host: 'clamd.local', port: 3310 });
    expect(loadAv({ AV_SCANNER: 'clamav', CLAMAV_HOST: 'clamd.local', CLAMAV_PORT: '13310' })).toEqual({ kind: 'clamav', host: 'clamd.local', port: 13310 });
    expect(() => loadAv({ AV_SCANNER: 'clamav', CLAMAV_HOST: 'h', CLAMAV_PORT: '99999' })).toThrow(/CLAMAV_PORT/);
    expect(() => loadAv({ AV_SCANNER: 'sophos' })).toThrow(/AV_SCANNER geçersiz/);
    expect(avScanner({ kind: 'none' })).toBeNull();
    expect(avScanner(undefined)).toBeNull();
    expect(avScanner({ kind: 'clamav', host: 'h', port: 1 })).toBeInstanceOf(ClamAvScanner);
  });
  it('not_configured_is_honest', async () => {
    expect(await scanStatus(null, Buffer.from('%PDF-1.4 sentetik'))).toBe('NOT_CONFIGURED');
    expect(AV_STATUS_LABEL.NOT_CONFIGURED).toBe('Virüs taraması yapılandırılmadı');
    expect(AV_NOT_CONFIGURED_LABEL).toBe('Virüs taraması yapılandırılmadı');
    // Tarayıcı beklenmedik biçimde hata fırlatırsa dosya temiz sayılmaz.
    const broken: AvScanner = { kind: 'broken', scan: async () => { throw new Error('x'); } };
    expect(await scanStatus(broken, Buffer.from('x'))).toBe('ERROR');
  });
});

describe('ClamAvScanner (sahte clamd, yerel TCP)', () => {
  it('stream_ok_is_clean_and_bytes_arrive_chunked', async () => {
    const { port, state } = await fakeClamd('ok');
    const body = Buffer.alloc(150 * 1024, 7); // 64 KB parçalarla: 3 parça
    body.write('%PDF-1.4 sentetik', 0);
    expect(await scanStatus(new ClamAvScanner('127.0.0.1', port), body)).toBe('CLEAN');
    expect(state.command).toBe('zINSTREAM');
    expect(state.chunks).toBe(3);
    expect(state.received.equals(body)).toBe(true);
  });
  it('found_is_infected', async () => {
    const { port } = await fakeClamd('found');
    expect(await new ClamAvScanner('127.0.0.1', port).scan(Buffer.from('X5O!P%@AP sentetik'))).toBe('INFECTED');
  });
  it('error_reply_drop_refused_and_timeout_are_error', async () => {
    const e = await fakeClamd('error');
    expect(await new ClamAvScanner('127.0.0.1', e.port).scan(Buffer.from('a'))).toBe('ERROR');
    const d = await fakeClamd('drop');
    expect(await new ClamAvScanner('127.0.0.1', d.port).scan(Buffer.from('a'))).toBe('ERROR');
    const s = await fakeClamd('silent');
    const t0 = Date.now();
    expect(await new ClamAvScanner('127.0.0.1', s.port, 200).scan(Buffer.from('a'))).toBe('ERROR');
    expect(Date.now() - t0).toBeLessThan(5_000);
    // Kapalı bağlantı noktası: bağlantı reddedilir.
    const closed = await fakeClamd('ok');
    await new Promise((r) => servers.pop()!.close(r));
    expect(await new ClamAvScanner('127.0.0.1', closed.port).scan(Buffer.from('a'))).toBe('ERROR');
  });
  it('classify_only_exact_ok_is_clean', () => {
    expect(classify('stream: OK\0')).toBe('CLEAN');
    expect(classify('stream: Win.Test.EICAR_HDB-1 FOUND\0')).toBe('INFECTED');
    expect(classify('stream: OKAY\0')).toBe('ERROR');
    expect(classify('')).toBe('ERROR');
    expect(classify('UNKNOWN COMMAND\0')).toBe('ERROR');
  });
});
