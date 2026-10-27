# Uygulama durumu ve izlenebilirlik

Son güncelleme: 2026-10-27 · Kapsam kaynağı: `project-specs/procurement/` (paket v1.2)
Durum anahtarı: **PASS** = bu oturumda çalıştırılıp geçti · **FAIL** · **BLOCKED** = dış bağımlılık yok · **NOT_RUN** = test yazılmadı/çalıştırılmadı · **PARTIAL** = kısmen uygulandı (açıklama zorunlu).
Kalan P0 varken ürün "tamamlandı" sayılmaz. Şu an **Faz 0–2 + Faz 3 (imza çekirdeği, koşullar/ihbar/yükümlülük/yenileme) + Faz 4 çekirdeği (sipariş, kabul, fatura tahsisi, eşleştirme, limit, ERP aktarım sözleşmesi) + sağlayıcıdan bağımsız dağıtım + web arayüzünün yeniden tasarımı (Tailwind 4 + shadcn/ui, "Mor Istampa")** uygulandı.

## Çalıştırılan kontroller (2026-10-27, macOS, Node 24.14, PostgreSQL 17 Docker, S3 emülatörü adobe/s3mock 4.6.0)

| Kontrol | Komut | Sonuç |
|---|---|---|
| Domain birim testleri | `npm test -w @sp/domain` | PASS 45/45 (Faz 2: ondalık, karşılaştırma/TCO, eskime, tahsis; Faz 3: ihbar son günü, tatil kuralı, 90/60/30, yükümlülük dönemleri, koşul farkı; Faz 4: kullanılabilir limit, net tüketim, tolerans, eksik kabul, limit aşımı ve çift sayım yok, avans/iade) |
| API entegrasyon (gerçek PostgreSQL + RLS + S3 emülatörü) | `npm test -w @sp/api` | PASS 65/65 (Faz 2: 13; Faz 3: 7 — T21, görev ayrılıklı doğrulama, değişiklik farkı, eskiyen uyarı, sırasız uyarı, fesih/çıkış görevleri, yükümlülük; Faz 4: 7 — T13–T18, T37; ERP için yalnız testte kayıtlı `test-erp` bağdaştırıcısı). |
| TypeScript (domain, api, web) | `npm run typecheck` | PASS |
| Web üretim derlemesi | `npm run build -w @sp/web` | PASS |
| Playwright E2E (1440, 1280, 390) | `npm run e2e -w @sp/web` | PASS 33, 6 bilinçli atlandı (veri değiştiren testler yalnız 1440'ta); art arda 2 tam koşu yeşil (Faz 4: sipariş → kabul → fatura → tahsis → ikinci finans onayı, tekrar gelen fatura, istisna bulgusu ve çözen rol, taşma). Faz 3 öncesi: art arda 3 tam koşu yeşil; portal testi 4 eşzamanlı tekrarla 40/40. Önceki kararsızlığın kök nedenleri bulundu ve düzeltildi: (1) portal formu her yeniden yüklemede kullanıcının yazdığını eziyordu, (2) aynı tedarikçinin eşzamanlı iki gönderimi aynı sürüm numarasında çakışıyordu, (3) aynı dosyanın eşzamanlı yüklemesi benzersizlik hatası veriyordu, (4) ek sayısı 20 sınırını aşınca genel doğrulama hatası görünüyordu |
| Web arayüzü yeniden tasarımı (impeccable) | `impeccable detect` + bağımsız son inceleme ajanı | detect 0 bulgu. İnceleme: 1. tur `fix` (8 düzeltme), 2. tur 4 çözüldü / 4 kısmi + 2 gerileme → gerilemeler düzeltildi, yeniden incelenmedi. Sonradan kapatıldı: İşlerim'de kayıt no ve sekme sayıları. Açık: global arama/bildirim (backend yok; sahte kontrol eklenmedi). `DESIGN.md` + `.impeccable/design.json` yazıldı |
| iOS simülatör derlemesi | `xcodebuild … -destination 'platform=iOS Simulator,name=iPhone 18 Pro' build` | PASS |
| iOS simülatörde kritik akış (giriş → İşlerim → imza durumu) | elle, simülatör ekran görüntüsüyle | PASS (otomatik UI testi yok → NOT_RUN) |
| `npm audit` | | 0 açık (`npm audit --omit=dev`, Faz 4 sonrası; pdfjs-dist 6.4.299'a yükseltildi: GHSA-hq66-cqwq-w95j) |
| Konteyner imajları | `docker build -f Dockerfile.api/.web` | PASS (Faz 2 sonrası yeniden derlendi; imaj içinde XLSX üretimi denendi). kind kümesi Faz 2 öncesi imajla çalışıyor; Faz 2'nin kümede denenmesi NOT_RUN |
| Tek sunucu yığını (PostgreSQL 17, SeaweedFS 4.51, Keycloak 26.8.1, api, worker, web) | `deploy/compose`: `docker compose --profile idp up -d` | PASS: migration 4/4, bucket oluşturma, tüm servisler sağlıklı |
| Uçtan uca duman testi (gerçek Keycloak token'ı) | kurulum aracı → davet → `/me` → e-Fatura yükleme → içerik geri okuma | PASS: davet ilk girişte bağlandı, hash eşit, token yok/bozuk 401, üretimde dev ucu 404, denetim kayıtları var |
| Tarayıcıda OIDC PKCE girişi (Keycloak, `localhost:8080`) | elle, uygulama içi tarayıcı | PASS: yönlendirme S256, derin bağlantıya dönüş, bozuk token'da sessiz yenileme, IdP üzerinden çıkış |
| Kubernetes manifestleri | `kubectl kustomize` + kubeconform (K8s 1.33, strict) | PASS 16/16 kaynak |
| Gerçek Kubernetes kümesi (yerel kind v0.33, tek düğüm) | `deploy/kubernetes/dev/up.sh` + `dev/smoke.sh` | PASS: restricted Pod Security altında tüm pod'lar çalıştı; migration Job 4/4; kurulum Job'u (ops şablonu) kiracı + davet; gerçek Keycloak token'ıyla davet bağlandı; e-Fatura yükleme ve içerik hash eşit; token yok/bozuk imza 401; dev ucu 404; `sp_app` süper değil/BYPASSRLS değil |
| NetworkPolicy uygulanması (kind) | `dev/smoke.sh` | PASS: etiketsiz pod → API kapalı; API pod → internet kapalı; API → PostgreSQL açık |
| Kesintisiz API güncellemesi (kind) | rollout restart sırasında `/api/v1/auth/config` | PASS sınırlı kanıt: 4 sn'lik güncellemede 9/9 istek başarılı; yük altında ölçülmedi |
| Kurum içi Kubernetes (gerçek veri merkezi, Ingress/TLS, kurum IdP'si) | — | NOT_RUN: yerel kind'de Ingress denetleyicisi yok, port-forward ile denendi |

Not: Test sağlayıcısı `test-fixture` yalnız `NODE_ENV=test`'te kaydedilebilir; canlı imza algılama başarısı değildir.

## Kabul senaryoları (09_KABUL_TESTLERI.md)

| Test | Durum | Kanıt (dosya) | Not |
|---|---|---|---|
| T01 kiracı izolasyonu | PASS | `apps/api/test/foundation.test.ts` "T01", E2E "başka kiracı" | ID/dosya/liste; arama/AI/export/kuyruk henüz yok → o yüzeyler NOT_RUN |
| T02 şirket kapsamı | PASS | foundation "T02" | RLS `company_ids` + API; kiracı yöneticisi belge görmez |
| T03 havuzlanmış bağlantı | PASS | foundation "T03" | transaction-local `set_config`, `sp_app` NOSUPERUSER NOBYPASSRLS, WITH CHECK |
| T04 eşzamanlı aynı VKN | PASS | foundation "T04" (5 eşzamanlı) | kısmi unique index + `ON CONFLICT` |
| T05 alıcı/satıcı | PASS | foundation "T05" | UBL rolleri + kendi şirket VKN koruması |
| T06 düşük güvenli kimlik | PASS | foundation "T06" (2 test) | anahtarsız aday, öneri, birleştirme izi |
| T07 SoD aktivasyon | PASS | foundation "T07" | API + DB CHECK |
| T08 IBAN sessiz değişmez | PASS | foundation "T08" | tek talep, `sp_app`'in UPDATE yetkisi yok |
| T09 tedarikçi başka teklif / süre sonrası | PASS | `apps/api/test/sourcing.test.ts` "T09" (4 test), E2E portal | RLS: başka tedarikçinin teklif başlığı/içeriği 0 satır; alıcı kapanıştan önce içerik 0 satır (mühür, DB'de); süre dolunca API 409 + DB tetikleyicisi reddeder; sunucu saatiyle alındı; idempotent tekrar |
| T10 düşük fiyat, eksik kapsam/yanlış birim | PASS | domain `sourcing.test.ts` "T10", API "T10", E2E karşılaştırma | "paket" birimi dönüştürülmez → karşılaştırılamaz, TCO yok, sıralamaya girmez; eksik kalem görünür |
| T11 ağırlık/teklif değişince eski karar | PASS | domain "T11", API "T11 + T12" | Değerlendirme dayanağı parmak izi (teklif sürümleri + kriter + puan + kur); değişince sürüm eskir, tahsis önerisi ve onayı 409 |
| T12 iki tedarikçiye bölünmüş kazanan | PASS | domain "T12", API "T11 + T12", E2E karar | Satır toplamı ihtiyacı aşamaz (422), karşılaştırılamayan satıra tahsis yok, aday firma onayda engellenir (BR02), öneren onaylayamaz (BR03) |
| T13 yarı kabul, tam fatura | PASS | api invoices "T13", domain "eksik kabul", E2E purchasing "istisna gereken fatura" | Eksik kabul istisnası (kaç birim, çözen rol); fatura giren onaylayamaz; istisna kontrol parmak izine bağlı, tahsis değişince eskir |
| T14 tavan/tüketim/açık taahhüt | PASS | api invoices "T14", domain "1M tavan" | Kullanılabilir 300 bin; siparişe bağlı fatura açık taahhüdün üstüne tekrar düşülmez (`limitImpact`) |
| T15 eşzamanlı iki onay | PASS | api invoices "aynı limit için iki onay" | Sözleşme başına advisory lock + kilit altında yeniden kontrol |
| T16 avans/kısmi/iade/ters kabul | PASS | api invoices "net tüketim ve önceki tahsis", domain "T16 parçaları" | Faturalanmış kabul geri alınamaz; iade özgün faturayı, mahsup avans bakiyesini aşamaz |
| T17 aynı ETTN / entegrasyon olayı | PASS | api invoices "aynı ETTN", E2E purchasing (tekrar giriş aynı kayda gider) | Tek mali kayıt, `invoice_intake_events` tekrar izi; ERP olayı `integration_inbox` ile tekilleşir |
| T18 ERP zaman aşımı | PASS (sözleşme) / BLOCKED (gerçek ERP) | api invoices "T18" (test bağdaştırıcısı) | Belirsiz durumda önce sorgu, ikinci kayıt yok. Gerçek ERP bağdaştırıcısı yok: onayda durum `NOT_CONFIGURED` görünür, başarı gibi gösterilmez |
| T19–T20 olay/risk | NOT_RUN | — | Faz 5 |
| T21 ihbar günü | PASS | domain `contractTerms.test.ts` "T21", API `lifecycle.test.ts` "T21" (5 test + sırasız uyarı), E2E sözleşme | Son gün bitişten ihbar süresi geri; hafta sonu/kiracı tatilinde sözleşme kuralına göre önceki iş günü; uyarı işleri 90/60/30 gün öncesine; görevin son tarihi ihbar son günü (bitiş değil); doğrulanmamış koşulda uyarı yok; koşul değişince eski uyarı eskir; daha acil uyarı geri alınmaz. Dini bayram tarihleri kiracı verisidir (seed yalnız sabit tarihli resmî tatiller) |
| T22 AI kaynaksız alan/zararlı talimat | NOT_RUN | — | LLM entegrasyonu yok; XML ayrıştırıcı talimat çalıştırmaz |
| T23 AI kota | NOT_RUN | — | Faz 5 |
| T24 capability yok | PASS | `signature.test.ts` "T24/SIG16" | `UNSUPPORTED` + manuel görev |
| T25 imzasız okunur sözleşme | PASS | signature "T25" + domain | NOT_DETECTED + tek görev; insan sonrası MISSING |
| T26 tek taraf imzalı | PASS | signature "T26/T33" | |
| T27 kaşe/paraf/isim | PASS | signature "T27" + domain | API 422 + DB CHECK |
| T28 hata/belirsiz | PASS | domain "T28", web etiketleri | |
| T29 aday ≠ kimlik/ıslak | PASS | signature "SIG05" | aday insan kararı değildir |
| T30 aynı hash tekrar | PASS | foundation "aynı dosya", signature "T24", "aynı hash yeni sürüm" | |
| T31 yeni sürüm | PASS | signature "T31/SIG09" | |
| T32 eski ETag | PASS | signature "T32" | |
| T33 API finalize bypass | PASS | signature "T26/T33", "yetki" | 422 gereksinim bazlı, 428 If-Match yok |
| T34 e-imza, ıslak gerekmiyor | PASS | signature "T34/T35" | |
| T35 e-imza servisi yok | PASS | signature "T34/T35" | VALIDATED raporsuz DB'de reddedilir |
| T36 istisna süre | PASS | signature "T36" | SoD, bitişte kesinleşme geri alınır + görev |
| T37 arşiv + mevcut fatura | PASS | api invoices "imza durumu bilinmeyen arşiv", domain "limit aşımı engeller…" | Fatura iptal edilmez; REVIEW bulgusu (hukuk) ve görev açılır |
| T38 imza kesitine erişim | PASS | signature "T38" | Kesit görüntüsü üretilmiyor; bölge orijinal üzerinde çizilir |
| T39 hibrit/çok taraflı | PASS | domain "T39" | API düzeyi ayrı test NOT_RUN |
| T40 asıl bilinmiyor | PASS | signature "T40" + domain | |
| T41 klavye/ekran okuyucu | PARTIAL | E2E "inceleme formu" (ilk hataya odak, klavye) | Gerçek ekran okuyucu oturumu NOT_RUN |
| T42 geniş/dar, uzun ünvan | PASS | E2E 1440/1280/390 taşma testi | TR biçimleri; EN çevirisi NOT_RUN |
| T43–T45 iOS offline/kabul/olay | NOT_RUN | — | Faz 6 |
| T46 orijinal bayt değişmez | PASS | foundation "T46", signature "T46" | |
| T47 kötü dosya | PARTIAL | foundation "aktif içerikli PDF…" | Formula injection export yok; gerçek AV BLOCKED |
| T48 export/retention/restore | NOT_RUN | — | Faz 7 |

## Gereksinim → uygulama

| Kaynak | Durum | Dosya / API / ekran |
|---|---|---|
| Tenant/şirket/rol/SoD temel | PARTIAL | `apps/api/migrations/001_foundation.sql`, `packages/domain/src/roles.ts`, `apps/api/src/auth.ts`; vekâlet/politika sürümü NOT_RUN |
| Gerçek auth adaptörü | PASS (web) / PARTIAL (iOS, kurum IdP'si) | Standart OIDC + PKCE, `apps/api/src/auth.ts`, `apps/web/src/lib/oidc.ts`, davet bağlama `004_identity_linking.sql`, kurulum `apps/api/src/provision.ts`; Keycloak ile uçtan uca denendi. Kurumsal dizin farkları ayarla (`deploy/IDP.md`: ADFS, Entra ID, Keycloak+AD); kurumun gerçek IdP'siyle deneme NOT_RUN; iOS hâlâ dev oturumu (ASWebAuthenticationSession NOT_RUN); MFA IdP politikasıdır (referans realm TOTP zorunlu) |
| Denetim izi (değişmez) | PASS | `audit_events` + trigger; `GET /api/v1/audit-events` |
| Belge sürümü/hash/idempotent yükleme | PASS | `POST /api/v1/documents`, `apps/api/src/files.ts` |
| Malware/karantina | PARTIAL / BLOCKED | Yerleşik kontroller (sihirli bayt, PDF aktif içerik/şifre, XML DTD); gerçek AV servisi BLOCKED |
| FR05–FR07 aday tedarikçi, VKN eşleme, IBAN | PASS (çekirdek) | `modules/suppliers.ts`, `modules/einvoice.ts`; UX07/UX08 web |
| OCR/AI çıkarım | BLOCKED | Sağlayıcı yok; PDF faturada manuel giriş görevi ve `POST /document-versions/:id/seller-identity` |
| FR08–FR09 sözleşme ailesi/sürüm | PASS (çekirdek) / PARTIAL | `contract_families` (SZL no), `contract_versions`, zeyilname; `migrations/007_contract_terms.sql`, `modules/contractTerms.ts`: bedel/tavan/bedelsiz, ödeme koşulu, süre/süresiz, otomatik yenileme, ihbar kuralı + kaynak madde, hukuk doğrulaması (görev ayrılığı), revizyon farkı ve gerekçe, yükümlülük ve dönem kaydı (kanıtlı, değişmez), yenileme/fesih/yeniden müzakere kararı, fesihte çıkış kontrolü görevleri. NOT_RUN: fiyat dönemi/endeks revizyonu, SLA ceza/kredi hesabı, teminat takibi, kazanan teklif → sözleşme bağı. Tavan Faz 4'te fatura/sipariş tüketimine bağlandı (yalnız doğrulanmış koşul) |
| SIG01–SIG16 imza | PASS (çekirdek) / BLOCKED (gerçek algılayıcı, e-imza doğrulayıcı) | `003_contracts_signatures.sql`, `packages/domain/src/signature.ts`, `modules/contracts.ts`, `signature/detector.ts`, web `SignatureWorkspace.tsx`, iOS `SignatureStatusView` |
| Asenkron iş/outbox | PARTIAL | `jobs`, `outbox_events`, `claim_jobs()`, `apps/api/src/worker.ts` (imza tespiti, ihbar uyarısı, yükümlülük vadesi; aynı aile için uyarılar advisory lock ile seri); outbox yayımcısı NOT_RUN |
| UX01 İşlerim | PASS | `pages/WorkPage.tsx`: kayıt no (PRJ/SZL/BLG veya VKN; erişim yoksa boş), sekme sayıları aynı yetki sınırıyla, son tarih, satır eylemi, j/k |
| UX06 Belge inceleme | PARTIAL | `pages/DocumentPage.tsx` (kaynak + alanlar + köken etiketi); alan→koordinat vurgusu OCR olmadan yalnız sayfa |
| UX07/UX08 Aday havuzu/tedarikçi | PARTIAL | risk/performans/olay sekmeleri Faz 5 |
| UX09/UX14 Sözleşme/imza | PASS | `ContractsPage.tsx`, `ContractLifecycle.tsx` (sekmeler: İmza kontrolü, Koşullar ve ihbar, Yükümlülükler), `SignatureWorkspace.tsx`; değişiklik farkı ve tarihin kaynak maddesi görünür |
| UX02 Proje listesi | PASS | `pages/ProjectsPage.tsx`: aşama filtresi (URL'de korunur), şirket ve para birimi görünür; kayıtlı görünüm/kolon seçimi NOT_RUN |
| UX03 Proje sihirbazı | PASS (çekirdek) | `pages/ProjectWizard.tsx`: ihtiyaç → kalem → bütçe → kriter → özet; adım doğrulaması, ilk hataya odak, taslak bu cihazda otomatik saklanır (sunucu taslağı "oluştur" ile) |
| UX04 Tedarikçi portalı | PASS (çekirdek) | `pages/PortalPages.tsx`: sunucu saatli geri sayım, satır bazlı fiyat, kapsam/birim uyarısı, sürüm ve alındı, soru-cevap; ek dosya yükleme NOT_RUN |
| UX05 Karşılaştırma | PASS | `ProjectWorkspace.tsx` Karşılaştırma: sabit başlık/ilk kolon, kapsam farkı taraması, kur varsayımı, kanıtlı puan, ağırlıklı puan |
| FR10 sipariş/kabul/fatura/limit | PASS (çekirdek) / PARTIAL | `migrations/008_po_receipts_invoices.sql`, `modules/invoices.ts`, `packages/domain/src/invoiceMatch.ts`, `src/erp/adapter.ts`. Sipariş (aktif tedarikçi, sözleşme limiti kilit altında), mal/hizmet (dönem) kabulü ve ters kabul, fatura/iade/avans, satır→sipariş kalemi veya sözleşme tahsisi (bölme), tolerans kuralı, bulgu → sorumlu role görev, istisna onayı (satınalma yöneticisi, parmak izi), görev ayrılıklı finans onayı, outbox + ERP aktarım işi (sorgu-önce-tekrar), ERP durum olayları. NOT_RUN: e-Fatura XML'den otomatik fatura oluşturma (Faz 1 ayrıştırıcısı var, bağlanmadı), vergi hesabı kontrolü, sipariş iptali/değişikliği, tolerans ayar ekranı (yalnız API). BLOCKED: gerçek ERP bağdaştırıcısı, ödeme durumu kaynağı |
| UX10 Fatura | PASS (çekirdek) | `pages/PurchasingPages.tsx`: liste (onay, ERP/ödeme ayrı, tekrar sayısı), detay (satır + tahsis, bulgu + çözen rol, limit paneli, istisna/onay/ret, hukuki/ERP/ödeme durumu ayrı), tahsis düzenleyici; Siparişler: liste, sipariş verme, kabul/ters kabul geçmişi |
| UX11–UX13 | NOT_RUN | Faz 5 |
| Faz 2 proje/RFQ/değerlendirme/tahsis | PASS (çekirdek) / PARTIAL | `migrations/005_projects_sourcing.sql`, `modules/sourcing.ts`, `packages/domain/src/sourcing.ts`, `src/reports.ts`. XLSX rapor deterministik (formül + kaynak sürüm + formül enjeksiyonu kaçışı); PDF karar özeti PASS (`decisionSummaryPdf`, gömülü Türkçe yazı tipi, eskimiş sürüm uyarısı, onaylayan kişiler; imaj içinde denendi); teklif ekleri PASS (`bid_files`/`bid_attachments`, yerleşik dosya kontrolü, tur açıkken yükleme, sürüme bağlama, alıcıya kapanıştan önce RLS ile kapalı, okuma denetim kaydı; gerçek AV taraması BLOCKED); tek kaynak/acil alım/iptal akışları NOT_RUN; kurum içi onay motoru (tutar/kategori kuralları) NOT_RUN — yayın ve seçim onayı sabit rol + görev ayrılığıyla |
| iOS | PARTIAL | `ios/Satinalma` SwiftUI: Keychain oturum, İşlerim, salt okunur imza durumu; tarama/offline/kabul Faz 6 |
| Dağıtım (sağlayıcıdan bağımsız) | PASS (compose, kind) / PARTIAL (kurum içi küme) | `deploy/compose`, `deploy/kubernetes` (iç CA bileşeni, egress politikası, kurulum Job'u, kind doğrulaması), `deploy/IDP.md`; kurum veri merkezinde kurulum ve yedek/restore tatbikatı NOT_RUN |
| OpenAPI | PASS | `docs/openapi.json` (`npm run openapi -w @sp/api`, 71 yol) |

## Bilinen açıklar ve sonraki adımlar (öncelik sırası)
1. **P0** İlk hedef: kurum içi Kubernetes (kullanıcı kararı). Kalan: kurumun kümesinde kurulum ve kurumun IdP'siyle (ADFS/Keycloak) giriş denemesi; iOS OIDC girişi.
2. **P0** Faz 2 kalanları: tek kaynak/acil/iptal akışları, kurallı onay motoru (tutar/kategori), global arama ve bildirim (spec 04 §9), kayıtlı tablo görünümleri.
3. **P0** Faz 3 kalan küçük kısımlar: fiyat revizyonu/endeks, SLA ceza/kredi hesabı, teminat; dar ekranda belge/alan sekmeleri.
4. **P0** Faz 4 kalanları: gerçek ERP bağdaştırıcısı (kurumun ERP'si seçilmeli), e-Fatura XML → fatura otomatik girişi, vergi kontrolü, sipariş değişikliği/iptali, tolerans ayar ekranı.
5. Gerçek AV taraması, OCR ve imza algılayıcı sağlayıcı seçimi (Türkçe golden set ile).
6. İngilizce arayüz metinleri; gerçek ekran okuyucu ve Dynamic Type testi.
7. Metrik/iz (OpenTelemetry), yedek/restore tatbikatı (Faz 7).
