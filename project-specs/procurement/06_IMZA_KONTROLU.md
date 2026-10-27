# Islak imza ve eksik imza uygulama spesifikasyonu
Bu özellik P0'dır. Analiz bölümler 39–42, SIG01–SIG16 ile birlikte uygulanır.

## Birbirinden ayrılacak beş gerçek
1. Görsel algılayıcının belgede imzaya benzer görüntü bulması.
2. İnsanın gerekli taraf/rol için imza görüntüsünü kaynak belge üzerinde teyit etmesi.
3. Islak imzalı fiziksel aslın teslim/muhafaza kaydı.
4. Elektronik imzanın ayrı kriptografik doğrulaması.
5. Hukuk veya yetkili birimin imzalayan yetkisi, yöntem ve istisnaya ilişkin kararı.

Tarama bu beş gerçeğin hepsini ispatlamaz. `isSigned: true` tek başına veri modeli olamaz. Kullanıcıya “Islak imza kesin doğrulandı” veya “Hukuken geçerli” sonucunu bir görsel modelden üretme.

## Kapsam ve durumlar
- `signature_method`: WET_IMAGE_REVIEW | QUALIFIED_ELECTRONIC | ELECTRONIC_OTHER | HYBRID | NOT_REQUIRED. Hukuki sınıflandırma kesinleştirilmediyse yöntemi inceleme bekler olarak bırak. E-imza türlerinin kabulü tenant/hukuk politikasına bağlıdır.
- Her `SignatureRequirement`: tenant, company, contract, document_version, party_id, signer_role, requirement_count, acceptable_methods, required, page/region (biliniyorsa), attachment_scope ve policy_version.
- Görsel sonuç: NOT_PROCESSED, CANDIDATE_FOUND, NOT_DETECTED, UNCLEAR, ERROR, UNSUPPORTED. NOT_DETECTED kesin imzasız değildir.
- İnsan: PENDING, IMAGE_CONFIRMED, MISSING, UNCLEAR. Kontrol “imzalayanın gerçek kimliği doğrulandı” anlamını taşımaz. Bağımsız hukuki inceleme gerekiyorsa ayrı alan ve görev.
- Fiziksel asıl: UNKNOWN, RECEIPT_DECLARED, CUSTODY_CONFIRMED. Yer, sorumlu, tarih ve kanıt; mürekkep/özgünlük analizi değildir.
- E-imza: NOT_APPLICABLE, NOT_CHECKED, VALIDATED, INVALID, INDETERMINATE. VALIDATED ancak gerçek doğrulayıcı raporuyla; e-imza görseliyle değil.
- İstisna: NONE, REQUESTED, APPROVED, REJECTED, EXPIRED. Eksikliği “tamam” yapmaz.
- Türetilen sonuç: NOT_REQUIRED / NOT_REVIEWED / COMPLETE / INCOMPLETE / UNCLEAR / EXCEPTION_ACTIVE. Kanıt ve gereksinimden hesapla; serbestçe patch edilebilir olmasın. Fiziksel asıl zorunlu değilse bilinmiyor olması görsel incelemeyi otomatik başarısız yapmaz.

## Veri ve kaynak kanıtı
`SignatureDetection`: requirement bağı (bilinmiyorsa boş), immutable document_version/hash, page, normalized bbox/polygon, method/provider/model_version, raw_confidence, detection_status, processed_page_scope, created_at, job_id. Skor kalibre edilmeden iş kuralında mutlak güven sayılmaz.
`SignatureReview`: requirement/detection, document_hash, reviewer, reviewed_at, decision, rationale, evidence_reference. Otomatik tespit kaydını değiştirmez.
`OriginalCustody`, `DigitalValidation`, `SignatureException` ayrı kayıtlar. Exception'da yetkili, kapsam, bitiş ve risk; doğrulamada tam imzalı dosya hash ve rapor. Sertifika anahtarları uygulama DB'sine düz metin konmaz.

## İş akışı
1. Belge sürümünü güvenle kaydet; hash ve idempotency. Gerekli taraflar ve imzaya tabi ekleri çıkar/insanla doğrula.
2. Belge yöntemi ve aşamasına göre imza gereksinimi belirle. Taslakta imza bulunmaması beklenen durum olabilir; yine görünür durum tutulur.
3. İmza aday tespiti görsel sayfa veya native signature detector kullanır. OCR text'te “imza” kelimesi görmek tespit değildir. Son sayfayla sınırlama; kontrol edilen sayfa kapsamını kaydet. Maliyet için aday bölgeyle başla ama bulunmazsa yeterli kapsam veya belirsiz inceleme gerekir.
4. NOT_DETECTED/UNCLEAR için dedupe edilmiş uyarı ve görev; ERROR/UNSUPPORTED için “otomatik kontrol yapılamadı”. PENDING insan incelemesi. İnsan teyidi olmadan MISSING final kararı verme.
5. İnceleyen taraf/sayfa/adayı görür, görüntü var/eksik/belirsiz kararını gerekçesiyle verir. Tek imza çok taraflı gereksinimleri kendiliğinden karşılamaz. Paraf/kaşe/isim ayrı.
6. Zorunlu kontroller tamamlanmadan signature-review completion ve verified execution geçişini sunucuda engelle. İstisna varsa sonuç EXCEPTION_ACTIVE; görünür eksikliği koru. İstisna bitiminde görevi ve kontrolleri yeniden aç.
7. Yeni dosya sürümünde önceki onayları güncele taşıma. Önceki delilleri sakla. Exact same hash tekrar yüklemesi yeni iş/görev yaratmamalı. Taraf/kural değişiminde sonuç yeniden hesaplanır.
8. Eski arşiv ithalatı NOT_REVIEWED olabilir. Yürürlük tarihi, iş yaşam döngüsü ve imza inceleme sonucu ayrı alanlardır. İmza uyarısı eski borcu otomatik hukuken iptal etmez. Fatura blokajı yapılandırılmış politika ve finans/hukuk kararıdır.

## E-imza
Uygulama içi onay hukuki e-imza değildir. PDF veya ilgili imzalı kapsayıcıyı uygun doğrulayıcıyla doğrula; belge bütünlüğü, sertifika zinciri, zaman/iptal bilgisi ve raporu yetenek/servis kapsamına göre sakla. Bilinmeyeni VALIDATED yapma. Ülke ve imza türü kabulünü hukuk belirler. Bu entegrasyon yoksa NOT_CHECKED/INDETERMINATE ve blokaj açıkça görünür. Islak imza gerekmeyen doğru yöntemli belgede yanlış eksik ıslak uyarısı yok.

## Önerilen API davranışları
- GET contract-version/signature-requirements ve signature-status
- POST signature-requirements (yetkili politika/insan tanımı)
- POST signature-analysis-jobs (idempotency, yetki, capability, region/quota)
- POST signature-reviews (version/ETag, karar/gerekçe, yetki; immutable kayıt)
- POST signature-exceptions/request ve approve/reject (SoD, süre/kapsam)
- POST original-custody-events (yetkili teyit, tarih/yer)
- POST digital-validation-jobs (gerçek adapter)
- POST finalize-signature-review (türetilmiş kontrol; 409 conflict veya 422 unresolved_requirements gibi yapılandırılmış hata)
Bu rotalar semantiktir; mevcut API adlandırmasını koru. Hata cevapları requirement_id, party ve çözüm eylemi içerir; yetkisiz alana bilgi sızdırmaz.

## Teknik adaylar ve maliyet
Mistral OCR'dan doğrudan özel imza tespit alanı bekleme. Görsel model kullanacaksan model registry capability, görüntü token maliyeti, bölge ve Türkçe belge testiyle doğrula. Azure Document Intelligence uygun custom model veya Textract signature detection teknik adaydır; fiyat/yerleşim onayı olmadan varsayılan yapma. Üretim imza kontrolünü “LLM imzayı doğru tanır” varsayımına bağlama. İlk sürüm insan incelemesi her durumda çalışır; otomatik servis anahtarı yoksa adapter BLOCKED, UI NOT_PROCESSED/UNSUPPORTED olarak dürüsttür. Test mock'ları sadece test ve açık demo içindir.

## Gizlilik
İmza kesiti yeni kullanıcı kimlik doğrulama/biometrik karşılaştırma özelliği değildir. Kimlik benzetme, örnek imza depolama, kopyalama/yapıştırma veya imza üretimi yapma. Kesitler varsa aynı belge yetkisi ve saklama politikası; tenant izole signed URL, logda görüntü yok. Audit actor/hash/sayfa/kural/karar taşır.
