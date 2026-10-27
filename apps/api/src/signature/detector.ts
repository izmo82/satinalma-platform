// İmza görüntüsü tespit adaptörleri (AI13). OCR metninde "imza" kelimesi tespit sayılmaz.
// Gerçek sağlayıcı (ör. Azure Document Intelligence özel model, AWS Textract SIGNATURES) bağlanana kadar
// registry boştur ve iş UNSUPPORTED/BLOCKED olarak dürüstçe kaydedilir (SIG16).

export interface DetectorCapability {
  provider: string;
  modelVersion: string;
  /** supports_vision ile aynı şey değildir; özel imza tespiti yeteneği. */
  signatureDetection: boolean;
  approvedRegions: string[];
}

export interface DetectionCandidate {
  page: number;
  bbox: { x: number; y: number; w: number; h: number };
  rawConfidence: number | null;
  status: 'CANDIDATE_FOUND' | 'UNCLEAR';
}

export type DetectionOutcome =
  | { status: 'CANDIDATE_FOUND' | 'NOT_DETECTED' | 'UNCLEAR'; processedPages: number[]; totalPages: number | null; candidates: DetectionCandidate[] }
  | { status: 'ERROR'; errorCode: string; processedPages: number[]; totalPages: number | null; candidates: [] };

export interface SignatureDetector {
  capability: DetectorCapability;
  detect(input: { bytes: Buffer; mimeType: string; pageCount: number | null }): Promise<DetectionOutcome>;
}

const registry = new Map<string, SignatureDetector>();

export function registerDetector(d: SignatureDetector) {
  // Test sabitleri yalnız test ortamında kayıt edilebilir; canlı sonuç gibi görünemez.
  if (d.capability.provider.startsWith('test-') && process.env.NODE_ENV !== 'test') {
    throw new Error('Test detector cannot be registered outside NODE_ENV=test');
  }
  registry.set(d.capability.provider, d);
}

export type DetectorSelection =
  | { ok: true; detector: SignatureDetector }
  | { ok: false; provider: string; modelVersion: string; reason: 'NO_PROVIDER_CONFIGURED' | 'CAPABILITY_MISSING' | 'REGION_NOT_ALLOWED' };

export function selectDetector(configured: string | null, tenantRegion: string): DetectorSelection {
  if (!configured) return { ok: false, provider: 'none', modelVersion: 'none', reason: 'NO_PROVIDER_CONFIGURED' };
  const d = registry.get(configured);
  if (!d) return { ok: false, provider: configured, modelVersion: 'unregistered', reason: 'NO_PROVIDER_CONFIGURED' };
  if (!d.capability.signatureDetection) return { ok: false, provider: configured, modelVersion: d.capability.modelVersion, reason: 'CAPABILITY_MISSING' };
  if (!d.capability.approvedRegions.includes(tenantRegion)) {
    return { ok: false, provider: configured, modelVersion: d.capability.modelVersion, reason: 'REGION_NOT_ALLOWED' };
  }
  return { ok: true, detector: d };
}
