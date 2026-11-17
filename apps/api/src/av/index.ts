import type { AvConfig } from '../config.ts';
import { ClamAvScanner } from './clamav.ts';

/**
 * v2 Faz 5 (R5): virüs taraması. `AV_SCANNER=none` (varsayılan) → tarayıcı yok, dosya durumu `NOT_CONFIGURED` ve ekranda
 * "Virüs taraması yapılandırılmadı" (taranmamış dosya "temiz" gösterilmez). `clamav` → clamd `zINSTREAM`.
 * Durumun dosya kaydına yazılması ve INFECTED/ERROR kararları yükleme uçlarındadır (Görev 4–6).
 */
export type ScanResult = 'CLEAN' | 'INFECTED' | 'ERROR';
export type AvScanStatus = 'NOT_CONFIGURED' | ScanResult;

export interface AvScanner {
  readonly kind: string;
  scan(body: Buffer): Promise<ScanResult>;
}

export const AV_NOT_CONFIGURED_LABEL = 'Virüs taraması yapılandırılmadı';
export const AV_STATUS_LABEL: Record<AvScanStatus, string> = {
  NOT_CONFIGURED: AV_NOT_CONFIGURED_LABEL, CLEAN: 'Virüs taraması temiz', INFECTED: 'Virüs bulundu', ERROR: 'Virüs taraması yapılamadı (karantinada)',
};

export function avScanner(cfg: AvConfig | undefined | null): AvScanner | null {
  return cfg?.kind === 'clamav' ? new ClamAvScanner(cfg.host, cfg.port) : null;
}

/** Tarayıcı yoksa `NOT_CONFIGURED`; tarayıcı beklenmedik biçimde hata fırlatırsa `ERROR` (asla CLEAN varsayılmaz). */
export async function scanStatus(scanner: AvScanner | null, body: Buffer): Promise<AvScanStatus> {
  if (!scanner) return 'NOT_CONFIGURED';
  try { return await scanner.scan(body); } catch { return 'ERROR'; }
}
