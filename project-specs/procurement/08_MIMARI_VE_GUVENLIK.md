# Teknik çerçeve

## Önce mevcut kod
Repo varsa yeniden yazma kararı vermeden modül, bağımlılık ve test kanıtını çıkar. Greenfield'de öneri: React/TypeScript web (gerekirse Next.js), modüler monolit TypeScript API (ör. NestJS), PostgreSQL, yönetilen nesne deposu/kuyruk ve SwiftUI iOS. Aynı gereksinimi daha iyi karşılayan mevcut stack korunur. Mikroservis/Kubernetes veya özel identity provider yazmak şart değildir.

Web/iOS aynı sürümlü API ve OpenAPI kullanır. OCR/AI/preview/rapor/entegrasyon worker'ları asenkron ve ayrı kotalı; status endpoint ve correlation ID. Yönetilen identity/OIDC/SAML, MFA ve kritik işlem step-up; doğrulanmış üyelik, ABAC/RBAC, şirket ve nesne yetkisi. Mobil secret yok, Keychain ve revocable session.

## Veri alanları
Tenant, LegalEntity, Department, CostCenter, UserMembership, Role/PolicyVersion; SupplierCandidate/Supplier/SupplierBank; Project/ProjectLine/Lot; RFx/Round/BidVersion/BidLine; EvaluationVersion/Criterion/AwardLine; ContractFamily/ContractVersion/Amendment/PriceTerm; Obligation/Milestone; PurchaseOrder/Receipt; Invoice/InvoiceLine/Allocation/MatchException; Assessment/ControlEvidence/Incident/CorrectiveAction; DocumentVersion/ExtractedField/AIJob; Approval/AuditEvent; imza için dosya 06'daki altı ayrı kayıt. Değişmez belge sürümü ve hash bütün kanıtlara bağlanır.

Multi-project invoice/contract many-to-many ilişkiyi allocation tablosuyla kur. Decimal+currency, effective dated prices, net/gross vergi politikası. Unique constraints tenant kapsamlı. Atomic limit reservation, transaction ve isolation seçimini yarış senaryosuyla kanıtla. Onay sürüme bağlı ve stale request reddedilir. Completed mali kayıt soft delete ile yok sayılamaz; ters/iptal kaydı.

## Tenant izolasyonu
Tenant_id istemci header'ına güvenilmez; session+current membership/service identity. DB/RLS veya uygun ayrı DB; API yetkisiyle birlikte savunma. RLS bağlantısı superuser/BYPASSRLS olamaz. Pooled bağlantıda transaction-local tenant scope ve connection reuse negatif testi. Composite FK tenant şirket tutarlılığı; object ID tahmin edilse dahi erişim yok.

Nesne, preview, imza bölgesi, cache, export, search/vector, queue, event, quota, notification ve support access tenant izole. Worker tenant id'yi tek başına yetki saymaz; üretici/işlem yetkisini doğrular. Kiracılar arası ortak firma olayı/model eğitimi veya cache yok. Platform support süreli/gerekçeli özel erişim; tenant admin'e otomatik tüm belge yetkisi yok.

## Dosya ve AI güvenliği
Upload allowlist gerçek MIME/size/parse limits, virus scan/quarantine, parser sandbox/resource limit, SSRF ve zip bomb önlemleri; signed dosyayı OCR/yeniden kaydetmeyle bozma. Preview kopyası ile orijinal ayrıdır. Kısa ömürlü, yetki kontrolü sonrası URL; logda belge/PII/imza yok. HTML/CSV/XLSX/PDF export injection ve güvenli metin escape. Kötü niyetli doküman talimatı çalıştırılmaz.

## Entegrasyon ve kayıt otoritesi
Platform operasyonel onay/eşleştirme; ERP muhasebe ve ödeme gerçekleşmesi. Dış ID, idempotency, outbox, bounded retry, DLQ, timeout reconciliation ve yetkili replay. Aynı event beş kez işlenince tek kayıt. Bir ERP ve bir e-belge sağlayıcısını pilotta doğrula; Logo/Mikro/Netsis/Paraşüt/SAP/Oracle/Dynamics hazır entegrasyon diye tanıtılmaz. API yoksa kontrollü CSV mapping; hata sayısı/toplam mutabakatı.

## İşletim ve güvenlik kapısı
TLS, managed keys/secrets, least privilege, env separation, audit tamper resistance, encryption/backups/restore. Tenant recovery izole snapshot restore+selected reimport; bütün DB'yi geriye döndürme. KVKK rolleri, amaç/retention/legal hold, export/exit ve veri/AI bölgesi policy. Bölgesel özel bulut seçeneği cloud hedefini korur. Otomatik ücretli kaynak veya production deploy yapma; IaC/env/runbook hazırlayıp bilinmeyenleri açık bırak.

ASVS web/API ve MASVS iOS uygulanabilir kontrol matrisi; dependency/secrets/SAST/DAST ve yetki testleri. Kritik/yüksek açıklar kapatılmadan yayın yok. Erişilebilirlik ve belge kaynak bütünlüğü de kalite kapısıdır. Analizdeki p95≤2 sn, %99,9, RPO≤15 dk/RTO≤4 saat pilot hedefidir; ölçmeden SLA iddiası verme.
