import net from 'node:net';
import type { AvScanner, ScanResult } from './index.ts';

/**
 * v2 Faz 5 (R5): clamd `zINSTREAM` bağdaştırıcısı (varsayılan kapalı, `AV_SCANNER=clamav`). Dosya 64 KB parçalar hâlinde
 * (4 bayt büyük uçlu uzunluk + veri) gönderilir, sıfır uzunluklu parça akışı bitirir. Yanıt: `stream: OK` → CLEAN,
 * `stream: <imza> FOUND` → INFECTED; bağlantı hatası, kopma, `ERROR` ya da 15 sn zaman aşımı → ERROR (dosya "temiz" sayılmaz).
 */
export const CLAMAV_TIMEOUT_MS = 15_000;
const CHUNK = 64 * 1024;

export class ClamAvScanner implements AvScanner {
  readonly kind = 'clamav' as const;
  constructor(readonly host: string, readonly port: number, private readonly timeoutMs = CLAMAV_TIMEOUT_MS) {}

  scan(body: Buffer): Promise<ScanResult> {
    return new Promise<ScanResult>((resolve) => {
      let done = false;
      let reply = '';
      const finish = (r: ScanResult) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        socket.destroy();
        resolve(r);
      };
      const socket = net.createConnection({ host: this.host, port: this.port });
      const timer = setTimeout(() => finish('ERROR'), this.timeoutMs);
      socket.on('error', () => finish('ERROR'));
      socket.on('data', (d) => {
        reply += d.toString('utf8');
        if (reply.includes('\0')) finish(classify(reply));
      });
      socket.on('end', () => finish(reply ? classify(reply) : 'ERROR'));
      socket.on('close', () => finish(reply ? classify(reply) : 'ERROR'));
      socket.on('connect', () => {
        socket.write('zINSTREAM\0');
        for (let i = 0; i < body.length; i += CHUNK) {
          const part = body.subarray(i, i + CHUNK);
          const len = Buffer.alloc(4);
          len.writeUInt32BE(part.length, 0);
          socket.write(len);
          socket.write(part);
        }
        socket.write(Buffer.alloc(4));
      });
    });
  }
}

/** clamd yanıtı: yalnız tam `OK` temizdir; `FOUND` virüslü; geri kalan her şey (ERROR, boş, beklenmeyen) hata. */
export function classify(reply: string): ScanResult {
  const line = reply.replace(/\0/g, '').trim();
  if (/^(stream|\S+):\s*OK$/.test(line)) return 'CLEAN';
  if (/\sFOUND$/.test(line)) return 'INFECTED';
  return 'ERROR';
}
