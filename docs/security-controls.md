# Güvenlik kontrol matrisi (Faz 7)

Kaynak: `project-specs/procurement/08_MIMARI_VE_GUVENLIK.md` "İşletim ve güvenlik kapısı" — ASVS web/API, MASVS iOS, bağımlılık/sır/SAST/DAST ve yetki testleri; kritik/yüksek açık kapanmadan yayın yok.
Durum anahtarı `implementation-status.md` ile aynıdır: **PASS** yalnız çalıştırılıp geçen kontrol; **GAP** = bilinen eksik (yayın öncesi karar gerekir); **N/A** = bu üründe uygulanmaz.

## Otomatik taramalar (2026-10-28, yerel)

| Tarama | Araç / komut | Sonuç |
|---|---|---|
| Bağımlılık açıkları | `npm audit` ve `npm audit --omit=dev` | PASS: 0 açık |
| Sır taraması (çalışma ağacı + 21 commit) | `docker run zricethezav/gitleaks:v8.21.2 git /repo --redact` | 1 bulgu, yanlış pozitif: `.claude/skills/media-use/scripts/lib/telemetry.mjs` içinde üçüncü taraf skill'in PostHog **proje** anahtarı (`phc_`, yalnız olay yazar, istemcide açık kullanılmak üzere tasarlanmıştır); uygulama kodu veya bizim sırrımız değil. Uygulama kodunda sır yok |
| SAST | `semgrep/semgrep:1.101.0`, kural setleri `p/typescript p/nodejs p/react p/secrets p/sql-injection p/owasp-top-ten p/javascript p/jwt` (`--metrics=off`) | PASS: `apps/` ve `packages/` altında 135 dosya, 0 bulgu |
| DAST — web (pasif taban taraması) | `ghcr.io/zaproxy/zaproxy:2.16.1 zap-baseline.py`, üretim web imajına (nginx) karşı | İlk tarama 0 FAIL / 7 WARN. Bulunan gerçek sorun: `/assets/` ve `/api/` yanıtlarında CSP/HSTS/Referrer-Policy **yoktu** (nginx'te location düzeyindeki `add_header` sunucu düzeyindekileri devralmaz); `Permissions-Policy`, COOP, CORP eksikti. Düzeltildi (`infra/web/security-headers.conf` her location'da). Yeniden tarama: **0 FAIL, 61 PASS, 6 WARN**, kalanlar kabul edilen/bilgi: küçültülmüş üçüncü taraf JS'te yorum, değişmez varlıkların önbelleklenmesi (kasıtlı), `style-src 'unsafe-inline'`, "modern web uygulaması", ZAP sürümü, COEP yok (PDF worker uyumu doğrulanmadı) |
| DAST — API (aktif, kimlik doğrulamalı) | `zap-api-scan.py`, OpenAPI (113 yol), hukuk+satınalma yöneticisi oturumuyla, geliştirme veritabanının **izole kopyasına** bağlı üretim derlemesine karşı | **0 FAIL, 111 PASS**. Bulunan gerçek sorunlar: NUL baytlı sorgu dizesi ve çok parçalı olmayan yükleme isteği 500 dönüyordu → 400/415 (`foundation.test.ts` "Faz 7 DAST bulguları"); API doğrudan erişildiğinde `nosniff` yoktu → eklendi. Kalan: Spectre yalıtımı uyarısı (API önünde nginx CORP/COOP ekler) |
| Yetki ve kiracı yalıtımı testleri | `npm test -w @sp/api` (T01–T03, RLS, görev ayrılığı, iki kişi onayı) | PASS (sayı `implementation-status.md`) |
| Erişilebilirlik (kalite kapısı) | `npm run e2e -w @sp/web` içinde axe, WCAG 2.2 AA | PASS: ciddi/kritik ihlal 0 |

## ASVS (web/API) — uygulanabilir kontroller

| Alan | Kontrol | Durum | Kanıt / not |
|---|---|---|---|
| V2 Kimlik doğrulama | Kurumsal IdP, OIDC + PKCE; parola uygulamada tutulmaz; MFA IdP politikası | PASS (Keycloak ile) | `apps/api/src/auth.ts`, `apps/web/src/lib/oidc.ts`, `deploy/IDP.md`. Geliştirme girişi üretimde açılamaz (`config.ts`: `AUTH_MODE=dev` + production hata verir) |
| V3 Oturum | Web: sunucu taraflı oturum (BFF, D78); tarayıcıda yalnız HttpOnly + SameSite=Strict (+ üretimde `__Host-`/Secure) çerez, token yok. Şifreli token deposu (AES-256-GCM), özetle arama, oturum sabitlemeye karşı her girişte yeni kimlik, boşta kalma/mutlak süre, CSRF başlığı + Origin, sunucuda tek yenileme (kopyalar arası kilit), çıkışta IdP iptali. iOS: Keychain + Bearer | PASS | `webSession.test.ts` (13 test: ortak çerezde kullanıcı değişince eski ekranın isteği yürütülmez (409), yeni girişte önceki oturum silinir, kayan boşta kalma, sahte standart IdP ile PKCE, state/akış çerezi, davetsiz hesap, açık yönlendirme, eşzamanlı ve kopyalar arası yenileme, geçici IdP hatası, ret, çıkış, mod eşleşmesi, CSRF, süreler, tabloya doğrudan erişim yok); Keycloak 26.8.1 ile elle: giriş, sunucuda yenileme, çıkışta IdP oturumunun kapanması (2026-11-04) |
| V4 Erişim denetimi | Her uçta izin tablosu (`packages/domain/src/roles.ts`); kiracı bağlamı üyelikten, başlık yalnız seçim; PostgreSQL RLS, `sp_app` NOBYPASSRLS; görev ayrılığı ve iki kişi onayı (fatura, imza istisnası, imha, kiracı dışa aktarımı) | PASS | API testleri; T01–T03; `governance.test.ts` (öneren onaylayamaz, kapsam dışı belge içeren partiye karar verilemez) |
| V4 Tedarikçi portalı | Tedarikçi kullanıcısı (`app_supplier_id`) yalnız davetli olduğu turu, kendi teklifini ve kendine gönderilmiş anketi görür; anket yanıtı yalnız gönderilmiş (SENT) ankete yazılır, gönderince kilitlenir; kurum incelemesi/bulgu/risk portal yanıtında yok | PASS | RLS `025_faz5_portal_weights_savings.sql`, `faz5.test.ts` (başka tedarikçi 404, kurum ucu 403, gönderilmemiş anket görünmez, kilit), E2E `evaluation.spec.ts` portal anketi |
| V4 Onay ve görev ayrılığı | Kurallı onay motoru: talep eden onaylayamaz, bir adımı onaylayan sonrakini onaylayamaz, kişi başına tek karar (DB unique); politika yayını ikinci kişiyle; tasarruf bazını öneren onaylayamaz (API + DB CHECK) | PASS | `approvals.test.ts`, `faz5.test.ts`, `sourcing.test.ts` |
| V5 Girdi doğrulama | Fastify JSON şema (ek alan reddi, tüm hatalar), gövde sınırı 1 MB (sonuç CSV 5 MB), yükleme 25 MB, gerçek MIME/imza baytı kontrolü, sınırlı XML ayrıştırıcı (DTD/entity kapalı) | PASS | `server.ts`, `files.ts`, `modules/einvoice.ts` |
| V5 Çıktı kodlama | React kaçışı; CSV/XLSX formül enjeksiyonu kaçışı (rapor, ERP aktarım dosyası, değerlendirme XLSX) | PASS | `kpi.ts csvCell`, `integration.test.ts` (`=HYPERLINK` metne çevrilir) |
| V7 Hata ve günlük | Genel hata gövdesi, ayrıntı sızdırmaz; günlükte `authorization`/`cookie` maskeli, URL sorgusuz; belge metni/kimlik/imza günlüğe yazılmaz; denetim kaydı değişmez (trigger) | PASS | `server.ts` hata işleyici ve logger ayarı; `audit_events_immutable` |
| V8 Veri koruma | Belge içeriği `no-store`, `nosniff`, belge yanıtında `sandbox` CSP; nesne anahtarı kiracı önekli ve tahmin edilse de yetki vermez; imzalı URL kısa ömürlü | PASS | `server.ts` içerik uçları, `storage.ts` |
| V8 Saklama/silme | Belge türü bazında politika (dayanaklı), hukuki saklama imhayı durdurur, iki kişi onaylı imha; hash ve denetim izi kalır | PASS | T48 satırı, `governance.test.ts` |
| V9 İletişim | TLS ingress/yük dengeleyicide; HSTS; iç ağda HTTP | PASS (yapılandırma) / NOT_RUN (kurum ortamında TLS) | `infra/web/default.conf.template` |
| V10 Kötü niyetli kod | Bağımlılık taraması; SAST | PASS | yukarıdaki tablo |
| V11 İş mantığı | Sürüme bağlı onay (If-Match), tekrar anahtarı, belirsiz sonucun "başarısız" sayılmaması, para için ondalık | PASS | T44, `invoiceIntake.test.ts`, `money.ts` |
| V11/V13 Otomasyon kötüye kullanımı | İstek sınırlama: oturum başına (600/dk, pahalı uçlar 30/dk), adres başına başarısız kimlik doğrulaması (60/dk; geçerli token etkilenmez), `429` + `Retry-After`; sınıf rota kalıbından; `X-Forwarded-For` yalnız `TRUST_PROXY` CIDR'larından okunur; ingress'te paylaşılan ilk katman | PASS (API testi) / NOT_RUN (kurum ingress'i) | `apps/api/src/rateLimit.ts`, `rateLimit.test.ts` (6 test); `deploy/kubernetes/base/ingress.yaml`. Sınır kopya başınadır |
| V12 Dosya | Karantina, aktif içerikli PDF reddi, özgün bayt değişmez, önizleme ayrı | PASS / **GAP** (AV) | Gerçek virüs taraması bağlı değil (BLOCKED); `av_scan_status = NOT_AVAILABLE` açıkça gösterilir |
| V13 API | CORS yalnız web kökeni; ETag/If-Match; OpenAPI (`docs/openapi.json`) | PASS | |
| V14 Yapılandırma | Sırlar ortamdan/sır yöneticisinden; uygulama rolü en dar GRANT; CSP, HSTS, Permissions-Policy, COOP/CORP her yanıtta, `server_tokens off` | PASS (ZAP ile doğrulandı) | `docs/runbook.md` "Sır gereksinimleri"; geliştirme konteynerinde `sp_owner` süper kullanıcıdır — üretimde migration rolü süper kullanıcı olmamalı |

## MASVS (iOS)

| Kategori | Kontrol | Durum | Not |
|---|---|---|---|
| STORAGE | Oturum token'ı Keychain (`WhenUnlockedThisDeviceOnly`); taslaklar AES-GCM, anahtar Keychain'de, dosya koruması `complete`; taslak kullanıcı ve kiracıya bağlı | PASS (simülatörde elle) | `Core/Keychain.swift`, `Core/DraftStore.swift`; düz metin taraması 0 |
| CRYPTO | Platform kriptosu (CryptoKit), kendi algoritma yok | PASS | |
| AUTH | Kurumsal OIDC (ASWebAuthenticationSession geçici oturum + PKCE S256, nonce, state), ayrı public istemci, belirteçler Keychain'de, sessiz yenileme, çıkışta iptal (RFC 7009); geliştirme girişi yayın derlemesinde yok | PASS (simülatör + Keycloak) / NOT_RUN (kurum IdP'si) | `Core/OIDC.swift`, `Core/SessionStore.swift`; yayın ikilisinde `dev/token` ifadesi 0. Geçici oturum + iptal sürümünün girişi simülatörde metin girişi sınırı yüzünden yeniden yürütülemedi; iptal protokol düzeyinde (curl) doğrulandı |
| NETWORK | ATS varsayılan (yalnız `NSAllowsLocalNetworking` geliştirme için); sertifika sabitleme | PASS / N/A | Sabitleme kurum PKI'sı ve MDM politikasına göre karar verilmeli |
| PLATFORM | WebView yok; derin bağlantı yok; panoya hassas veri yazılmaz | PASS | |
| CODE | Swift 6 katı eşzamanlılık, uyarısız derleme | PASS | |
| RESILIENCE | Jailbreak/hata ayıklayıcı tespiti | N/A (L1 dışı) | MDM ile yönetilen cihaz varsayımı; kurum isterse ayrı iş |
| PRIVACY | Kamera izni gerekçesi; telemetri yok | PASS | `Info.plist` |

## Yayın öncesi açık kalanlar (kritik/yüksek olarak sınıflanmadı, karar gerektirir)

1. İstek sınırlama — uygulamada PASS; kurum ingress'inde ve çok kopyada ölçüm NOT_RUN.
2. iOS kurumsal OIDC — Keycloak ile PASS; kurumun IdP'si (ADFS/Entra) ve gerçek cihaz NOT_RUN.
3. Gerçek virüs taraması — BLOCKED (sağlayıcı seçimi).
4. ~~Token'ın `sessionStorage`'da tutulması~~ — kapandı: web oturumu sunucuda (BFF, D78). Kurum IdP'sinde (ADFS/Entra) BFF girişi NOT_RUN.
