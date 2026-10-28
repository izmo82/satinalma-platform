// Durum dili: tüm kanallarda aynı anlam (02 §22). Renk tek başına anlam taşımaz; ikon+metin.
export type Tone = 'ok' | 'warn' | 'danger' | 'info' | 'neutral' | 'ai' | 'human';
export interface Label { text: string; tone: Tone; icon: string; hint?: string }

export const overallLabel: Record<string, Label> = {
  NOT_REQUIRED: { text: 'İmza gerekmiyor', tone: 'neutral', icon: 'minus' },
  NOT_REVIEWED: { text: 'İnceleme bekliyor', tone: 'info', icon: 'clock' },
  COMPLETE: { text: 'İmza kanıtları tamam', tone: 'ok', icon: 'check', hint: 'Tanımlı gereksinimler için kayıtlı kanıtlar tamam. Hukuki geçerlilik kararı değildir.' },
  INCOMPLETE: { text: 'Eksik', tone: 'danger', icon: 'x' },
  UNCLEAR: { text: 'Belirsiz', tone: 'warn', icon: 'help' },
  EXCEPTION_ACTIVE: { text: 'Eksik — yetkili istisna ile işlem', tone: 'warn', icon: 'shield' },
};

export const detectionLabel: Record<string, Label> = {
  NOT_PROCESSED: { text: 'Otomatik tarama yapılmadı', tone: 'neutral', icon: 'minus' },
  CANDIDATE_FOUND: { text: 'İmza görüntüsü adayı bulundu', tone: 'ai', icon: 'sparkles', hint: 'Algılayıcı önerisidir; insan teyidi değildir.' },
  NOT_DETECTED: { text: 'İmza görüntüsü bulunamadı — inceleme gerekli', tone: 'warn', icon: 'alert', hint: 'Bulunamaması imzasız olduğu anlamına gelmez.' },
  UNCLEAR: { text: 'Algılama belirsiz', tone: 'warn', icon: 'help' },
  ERROR: { text: 'Otomatik kontrol hata verdi', tone: 'warn', icon: 'alert' },
  UNSUPPORTED: { text: 'Otomatik kontrol yapılamadı', tone: 'neutral', icon: 'minus', hint: 'İmza tespit servisi yapılandırılmadı veya bu bölgede izinli değil. Manuel inceleme çalışır.' },
};

export const custodyLabel: Record<string, Label> = {
  UNKNOWN: { text: 'Fiziksel asıl: bilinmiyor', tone: 'neutral', icon: 'help' },
  RECEIPT_DECLARED: { text: 'Fiziksel asıl: teslim beyan edildi', tone: 'info', icon: 'archive' },
  CUSTODY_CONFIRMED: { text: 'Fiziksel asıl: muhafaza teyit edildi', tone: 'human', icon: 'stamp' },
};

export const digitalLabel: Record<string, Label> = {
  NOT_APPLICABLE: { text: 'E-imza: uygulanamaz', tone: 'neutral', icon: 'minus' },
  NOT_CHECKED: { text: 'E-imza: doğrulanmadı', tone: 'warn', icon: 'clock' },
  VALIDATED: { text: 'E-imza: doğrulayıcı raporu geçerli', tone: 'ok', icon: 'check' },
  INVALID: { text: 'E-imza: geçersiz', tone: 'danger', icon: 'x' },
  INDETERMINATE: { text: 'E-imza: sonuçsuz', tone: 'warn', icon: 'help' },
};

export const requirementLabel: Record<string, Label> = {
  SATISFIED: { text: 'Kanıt tamam', tone: 'ok', icon: 'check' },
  PENDING: { text: 'İnceleme bekliyor', tone: 'info', icon: 'clock' },
  MISSING: { text: 'İmza eksik (insan teyidi)', tone: 'danger', icon: 'x' },
  UNCLEAR: { text: 'Belirsiz', tone: 'warn', icon: 'help' },
  INVALID: { text: 'E-imza geçersiz', tone: 'danger', icon: 'x' },
};

export const decisionLabel: Record<string, string> = {
  IMAGE_CONFIRMED: 'İmza görüntüsü teyit edildi', MISSING: 'İmza eksik', UNCLEAR: 'Belirsiz', PENDING: 'Karar yok',
};
export const markLabel: Record<string, string> = {
  FULL_SIGNATURE: 'Tam imza', STAMP_ONLY: 'Yalnız kaşe', INITIALS_ONLY: 'Yalnız paraf', NAME_ONLY: 'Yalnız yazılı isim', NONE: 'İşaret yok', ILLEGIBLE: 'Okunamıyor',
};
export const methodLabel: Record<string, string> = {
  WET_IMAGE_REVIEW: 'Islak imza (görüntü incelemesi)', QUALIFIED_ELECTRONIC: 'Nitelikli e-imza', ELECTRONIC_OTHER: 'Diğer e-imza',
  HYBRID: 'Hibrit', NOT_REQUIRED: 'İmza gerekmiyor', PENDING_CLASSIFICATION: 'Yöntem sınıflandırılmadı',
};
export const stageLabel: Record<string, string> = { DRAFT: 'Taslak', EXECUTION: 'İmza aşaması', ARCHIVE_IMPORT: 'Arşivden alındı' };
export const partyRoleLabel: Record<string, string> = { BUYER: 'Alıcı', SUPPLIER: 'Tedarikçi', OTHER: 'Diğer taraf' };

export const supplierStatus: Record<string, Label> = {
  CANDIDATE: { text: 'Aday', tone: 'warn', icon: 'clock' },
  CONDITIONAL: { text: 'Koşullu', tone: 'info', icon: 'info' },
  ACTIVE: { text: 'Aktif', tone: 'human', icon: 'stamp' },
  SUSPENDED: { text: 'Askıda', tone: 'danger', icon: 'lock' },
  ARCHIVED: { text: 'Arşiv', tone: 'neutral', icon: 'archive' },
  REJECTED: { text: 'Reddedildi', tone: 'neutral', icon: 'x' },
  MERGED: { text: 'Birleştirildi', tone: 'neutral', icon: 'minus' },
};
export const severityLabel: Record<string, Label> = {
  CRITICAL: { text: 'Kritik', tone: 'danger', icon: 'alert' },
  HIGH: { text: 'Yüksek', tone: 'warn', icon: 'alert' },
  NORMAL: { text: 'Normal', tone: 'neutral', icon: 'minus' },
};
export const originLabel: Record<string, Label> = {
  RULE: { text: 'Kural ile doğrulandı', tone: 'ok', icon: 'check' },
  AI: { text: 'AI önerisi', tone: 'ai', icon: 'sparkles' },
  HUMAN: { text: 'İnsan onaylı', tone: 'human', icon: 'stamp' },
};
export const roleLabel: Record<string, string> = {
  REQUESTER: 'Talep sahibi', BUYER: 'Satınalmacı', PROCUREMENT_MANAGER: 'Satınalma yöneticisi', TECH_EVALUATOR: 'Teknik değerlendirici',
  LEGAL: 'Hukuk', FINANCE: 'Finans', SECURITY: 'Bilgi güvenliği', MASTER_DATA: 'Ana veri', SUPPLIER: 'Tedarikçi', TENANT_ADMIN: 'Kiracı yöneticisi',
  PLATFORM_OPS: 'Platform operasyonu', AUDITOR: 'Denetçi',
};

// Faz 2: proje aşaması (02 §5 durum tablosu) ve teklif satırı karşılaştırma durumu.
export const projectStatus: Record<string, Label> = {
  DRAFT: { text: 'Taslak', tone: 'neutral', icon: 'pen' },
  IN_APPROVAL: { text: 'Yayın onayında', tone: 'info', icon: 'clock' },
  OPEN: { text: 'Teklife açık', tone: 'info', icon: 'inbox' },
  EVALUATION: { text: 'Değerlendirmede', tone: 'warn', icon: 'chart' },
  AWARD_APPROVAL: { text: 'Seçim onayında', tone: 'info', icon: 'clock' },
  CONTRACTING: { text: 'Sözleşme aşamasında', tone: 'human', icon: 'stamp' },
  CANCELLED: { text: 'İptal', tone: 'neutral', icon: 'x' },
  NO_AWARD: { text: 'Sonuçsuz kapandı', tone: 'neutral', icon: 'minus' },
};
export const PROJECT_STAGES = ['DRAFT', 'IN_APPROVAL', 'OPEN', 'EVALUATION', 'AWARD_APPROVAL', 'CONTRACTING'] as const;
export const lineState: Record<string, Label> = {
  COMPARABLE: { text: 'Karşılaştırılabilir', tone: 'ok', icon: 'check' },
  MISSING: { text: 'Teklif edilmedi', tone: 'danger', icon: 'x' },
  EXCLUDED: { text: 'Kapsam dışı', tone: 'danger', icon: 'x' },
  ALTERNATIVE: { text: 'Alternatif', tone: 'warn', icon: 'help' },
  UNIT_MISMATCH: { text: 'Birim farklı', tone: 'danger', icon: 'alert' },
  QUANTITY_SHORT: { text: 'Miktar eksik', tone: 'danger', icon: 'alert' },
  NO_FX_RATE: { text: 'Kur yok', tone: 'warn', icon: 'alert' },
};
export const scopeLabel: Record<string, string> = { INCLUDED: 'Dahil', EXCLUDED: 'Kapsam dışı', ALTERNATIVE: 'Alternatif' };
export const costKindLabel: Record<string, string> = { SHIPPING: 'Nakliye', INSTALLATION: 'Kurulum', MAINTENANCE: 'Bakım', RENEWAL: 'Yenileme', OTHER: 'Diğer' };
