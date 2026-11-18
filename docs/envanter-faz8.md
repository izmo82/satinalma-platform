# Faz 8 (Oracle ERP: özellik başına uç nokta kartı) işlev envanteri: önce / sonra

Tarih: 18.11.2026. Dal: `v2-sadelestirme`. Kural: SIFIR GERİLEME (global CLAUDE.md, 07.11.2026).

**Önce:** `docs/envanter-faz1.md` Bölüm 2 (R10), 3.20 (W-20-01..05 ERP mutabakatı), 3.17 ve 3.18 (W-17-08 "ERP mutabakatı" bağlantısı, W-18-01 ERP durumu), `docs/envanter-faz7.md` (A7-02, A7-03, A7-13, A7-18 fatura listesi ve detayı), `docs/envanter-faz5.md` (tedarikçi kartı Kayıt ve onay sekmesi), Faz 3 sözleşme Özet sekmesi, Faz 1 Yönetim > Kullanıcılar ve Entra ve iOS Faturalar. ERP mutabakatı ve eski Entegrasyonlar sekmesi için taban `70bf031` (Faz 1 sonu).
**Sonra:** `HEAD` (`b21a7cd`) kodu: `apps/web/src/pages/{IntegrationsPage,ErpEndpointCard,ErpManual,AdminPages,PurchasingPages,SupplierDetailPage,ProjectWorkspace,ContractOverview}.tsx`, `apps/web/src/App.tsx`, `apps/web/e2e/{erp-v2,navigation-v2}.spec.ts`, `ios/Satinalma/Satinalma/Core/Models.swift`, `ios/Satinalma/Satinalma/Features/InvoiceView.swift`, API `apps/api/src/{modules/integrationEndpoints,erpRead,erpWrite,erpManual,integrationSecrets}.ts`, `apps/api/src/erp/*`. Satır başı `A8-` eski, `N8-` yeni işlevdir.

## Doğrulama yöntemi ve sınırı

Satırlar **kod okumasıyla** hazırlandı: her eski satırın yeni yeri `git show 70bf031:<dosya>` ile ve Faz 8 öncesi sürümle (`git diff 462a97c HEAD -- apps/web/src`, `git diff cda25ab HEAD -- apps/api/src ios packages`) güncel dosyanın karşılaştırılmasıyla bulundu. Eski web dosyalarındaki Faz 8 değişikliği yalnız şunlardır: `AdminPages.tsx` (`IntegrationsTab` ve `Planned` yerine `IntegrationsPage`; Kullanıcılar sekmesine panel eklendi), `App.tsx` (`/faturalar/erp-mutabakati` hedefi ve `Moved`), `PurchasingPages.tsx` (ERP / ödeme hücresine satır, Fatura gir'e iki alan, detaya panel), `SupplierDetailPage.tsx`, `ProjectWorkspace.tsx`, `ContractOverview.tsx` (birer panel eklendi). `ErpReconciliationPage` (`GovernancePages.tsx`) ve `apps/api/src/modules/integration.ts`, `apps/api/src/erp/adapter.ts` Faz 8'de **değişmedi** (diff boş).

- **Güncelleme (2026-11-18):** persona yürüyüşü koşuldu (`.superpowers/sdd/2026-11-17-v2-faz8-oracle/persona-report.md`; hiçbir istek gerçek Oracle'a gitmedi): web Yönetici (Bağlantılar, SUPPLIER kartı kurulumu, sına, okuma), yazma aşaması, Satınalma, Denetçi ve Departman kullanıcısı **PASS**, **1024 px panelde** (390 spot-check **NOT_RUN**); iOS **kısmi** (fatura ayrıntısında "Kaynak · Elle" ve "ERP ödeme durumu" PASS; taklit etiketli Kaynak satırı NOT_RUN). Sıfır gerileme: ERP mutabakatı içeriği ve ilk ekranı (A8-02..A8-13), Faz 7 fatura etiketleri ve kolonları, sözleşme özeti, tedarikçi kartı, Kullanıcılar ve Entra bölümleri yerinde görüldü. Persona düzeltmeleri (85cf269, API b21a7cd, 33843f8) ve web ardıl partisi (12162f2) sonradan yapıldı; persona ile yeniden yürünmedi; son doğrulama (HEAD `7eebc62`, controller, çalışan ajan yokken): domain 391/391, API 830 geçti / 44 atlandı / 0 kaldı, typecheck, web build, iOS temiz derleme (0 kod uyarısı) ve tam web e2e taze migrate + seed edilmiş veritabanında 213 geçti / 0 kaldı / 99 atlandı (1440/1280/390), hepsi PASS.
- **Hiçbir ERP işlevi gerçek Oracle'a karşı görülmedi (NOT_RUN).** Aşağıdaki bütün "yeni" satırlar taklit sağlayıcıyla ("Taklit Oracle (gerçek değil)") ya da yerel `node:http` test sunucusuyla (Oracle EBS bağdaştırıcısı) denendi.
- Görev raporlarındaki gözlemler (ben yeniden koşmadım): Görev 7'de `erp-v2.spec.ts` 42 geçti / 6 atlandı (1440/1280/390), tedarikçi ERP paneli, proje ve sözleşme ERP aktarımı, fatura "Kaynak ve ERP" ve masraf merkezi paneli 1440 ve 390 ekran görüntüleriyle açılıp denetlendi; iOS görevinde simülatörde fatura ayrıntısında Kaynak ve ERP ödeme durumu satırları görüldü.
- Tam test koşusu yapıldı: son doğrulama (HEAD `7eebc62`, controller): domain 391/391, API 830 geçti / 44 atlandı / 0 kaldı, typecheck, web build, iOS temiz derleme 0 kod uyarısı, tam web e2e taze veritabanında 213 geçti / 0 kaldı / 99 atlandı; hepsi PASS (`docs/implementation-status.md` Faz 8 satırı).
- Dil: Faz 8 ekranlarındaki sabit metin Türkçedir; EN katmanı yürünmedi, kod okumasıyla "EN tamam" denmez (açık kalem, Bölüm 3). Sunucu etiketleri (kaynak, ödeme durumu, `statusLabel`, `modeLabel`) Türkçe gelir, istemci olduğu gibi gösterir.
- Web ardıl partisi (küçük kalemler, Bölüm 3 madde 5) bu belge yazılırken yapılmamıştı; **sonradan yapıldı (12162f2).**

Durum anlamları: **KALIR** = işlev aynı yerde, aynı dokunuşla, aynı davranışla; **DÖNÜŞTÜ** = aynı yerde ama biçimi/içeriği değişti, eski bilginin tamamı erişilebilir; **TAŞINDI** = yeri değişti, erişim en az eskisi kadar kolay. Dokunuş = sol menüden (web) ya da sekme çubuğundan (iOS) işleve varmak için tıklama/dokunuş.

---

## 1. Eski işlevler (önce → sonra)

### 1.1 Yönetim > Entegrasyonlar: ERP mutabakatı (web) — `/yonetim/entegrasyonlar` — `ErpReconciliationPage`, `IntegrationsPage.tsx`

| id | İşlev | Eski yer | Yeni yer | Dokunuş | Durum | Kanıt (dosya:satır) |
|---|---|---|---|---|---|---|
| A8-01 | Yönetim > Entegrasyonlar sekmesi (Yönetici, Satınalma, Denetçi görür; sekme adı ve sırası) (R10) | Yönetim sekme çubuğu | Aynı sekme, aynı roller, aynı sıra | 2→2 | KALIR | `AdminPages.tsx:32` |
| A8-02 | Satınalma ve Denetçi sekmeyi açınca ERP mutabakatını ilk ekranda görür (başlık "ERP mutabakatı", adrese sorgu eklenmez) (R10, global kısıt) | Sekmenin tek içeriği | Varsayılan bölüm bu roller için "Fatura aktarım mutabakatı"; sayfa aynı bileşendir. **Üstüne bölüm çubuğu eklendi** ("Bağlantılar", "Fatura aktarım mutabakatı") | 2→2 | DÖNÜŞTÜ | `IntegrationsPage.tsx:23-37`; `erp-v2.spec.ts` (Satınalma ve Denetçi ilk ekran) |
| A8-03 | Başlık eylemi "Faturalar" bağlantısı (`/faturalar`) | Mutabakat başlığı | Aynı | 1→1 | KALIR | `GovernancePages.tsx` `ErpReconciliationPage` (değişmedi) |
| A8-04 | Dönem süzgeci: "Onay tarihi başı", "Onay tarihi sonu", "Uygula" (W-20-01) | Mutabakat sayfası | Aynı | 1→1 | KALIR | `GovernancePages.tsx` (değişmedi) |
| A8-05 | "Durum ve toplamlar" paneli: veri anı, gelen ERP olayı, tekrar sayısı, durum × para birimi toplamları (W-20-02) | Mutabakat sayfası | Aynı | 1→1 | KALIR | `GovernancePages.tsx` (değişmedi) |
| A8-06 | "İlgilenilmesi gerekenler" tablosu: fatura no bağlantısı (`/faturalar/:id`), onay tarihi, durum etiketi, son hata, kesilmiş liste notu (W-20-03) | Mutabakat sayfası | Aynı | 1→1 | KALIR | `GovernancePages.tsx` (değişmedi) |
| A8-07 | "Tekrar gönder" (gerekçe ≥ 10 karakter, "Gönder"; Satınalma, `integration.replay`) (W-20-03) | Tablo satırı | Aynı | 2→2 | KALIR | `GovernancePages.tsx` (değişmedi); `POST /integration/erp/exports/:id/replay` değişmedi |
| A8-08 | "Aktarım dosyası (CSV)" indirme (Satınalma) (W-20-04) | "CSV ile aktarım ve sonuç dosyası" paneli | Aynı | 1→1 | KALIR | `GovernancePages.tsx`; `GET /integration/erp/batch.csv` değişmedi |
| A8-09 | Sonuç dosyası (CSV) yükleme: "Önce dene" (kuru çalışma), "Sonuç dosyasını uygula", sonuç özeti (Satınalma) (W-20-05) | Aynı panel | Aynı | 2→2 | KALIR | `GovernancePages.tsx`; `POST /integration/erp/results` değişmedi |
| A8-10 | Denetçi mutabakatı salt okunur görür (CSV, tekrar gönderim yok) | Mutabakat sayfası | Aynı | 2→2 | KALIR | `GovernancePages.tsx` `finance = hasRole(me, 'PROCUREMENT')`; `erp-v2.spec.ts` Denetçi |
| A8-11 | Yönetici Entegrasyonlar sekmesinde "ERP mutabakatı Satınalma ve Denetçi rollerine açık" açıklamasını görür (işlevsiz yer tutucu; mutabakat uçlarına yetkisi yok) | Sekmenin içeriği | Yönetici varsayılan olarak "Bağlantılar" görür ve **ilk ekranda**, bölüm seçicinin altında "ERP mutabakatı Satınalma ve Denetçi rollerine açık: …" açıklama satırını görür (12162f2; önceki ilk ekran açıklaması aynı dokunuşla geri geldi); "Fatura aktarım mutabakatı" bölümündeki açıklama da durur ("Oracle ERP bağlantı ayarları 'Bağlantılar' bölümündedir") | 2→2 | DÖNÜŞTÜ | `IntegrationsPage.tsx:33-37`, `AdminPages.tsx:90-92` |
| A8-12 | Eski adres `/faturalar/erp-mutabakati` yönlenir (R10) | → `/yonetim/entegrasyonlar` | → `/yonetim/entegrasyonlar?bolum=mutabakat` (eski sorgu korunur); aynı sayfa, aynı "ERP mutabakatı" başlığı | 0→0 | DÖNÜŞTÜ | `App.tsx:76`, `:277-278`; `navigation-v2.spec.ts:117` (beklenti genişletildi, D113) |
| A8-13 | Faturalar başlığında "ERP mutabakatı" bağlantısı (Satınalma, Denetçi) (W-17-08, A7-02) | Faturalar başlığı | Aynı bağlantı, aynı hedef sayfa (sorgusuz adres; bu roller için varsayılan bölüm mutabakattır) | 2→2 | KALIR | `PurchasingPages.tsx:94` |
| A8-14 | ERP aktarım sözleşmesi: `POST /integration/erp/status-events`, `erp.export` işi, `GET /integration/erp/reconciliation`, `ERP_ADAPTER` ayarı, `integration.*` izinleri | API | Aynı; dosyalar değişmedi (`modules/integration.ts`, `erp/adapter.ts`), `ERP_PROVIDER` ayrı yeni ayardır | n/a | KALIR | `git diff cda25ab HEAD` bu iki dosyada boş |

### 1.2 Faturalar listesi, Fatura gir ve fatura detayı (web) — `PurchasingPages.tsx`

| id | İşlev | Eski yer | Yeni yer | Dokunuş | Durum | Kanıt (dosya:satır) |
|---|---|---|---|---|---|---|
| A8-15 | Fatura listesi "ERP / ödeme" sütunu: ERP durumu, "ödendi (ERP)" notu (A7-03) | Liste hücresi | Aynı metin; altına "ERP ödeme: <etiket>" satırı eklendi (varsa) | 1→1 | KALIR | `PurchasingPages.tsx:140-142` |
| A8-16 | Tür satırındaki kaynak etiketi (Faz 7'de gelen `sourceLabel`) (A7-03) | Liste, tür satırı | Aynı | 1→1 | KALIR | `PurchasingPages.tsx:48` (alan Faz 7'den) |
| A8-17 | "Fatura gir" formunun bütün alanları (şirket, tedarikçi, tür, no, ETTN, tarih, para birimi, özgün fatura, satırlar, beyan edilen vergi/tevkifat/ödenecek) (A7-02) | Satınalma, Faturalar başlığı | Aynı alanlar ve aynı gönderim; iki isteğe bağlı alan eklendi (N8-24). Boş bırakılırsa istek gövdesine girmez | 2→2 | KALIR | `PurchasingPages.tsx:157-185` |
| A8-18 | Fatura detayı başlığındaki ERP durumu, Ödeme (v1 ödeme durumu), "ERP son hata" ve karar geçmişi (A7-13, A7-20, W-18-01, W-18-11) | Detay | Aynı; v1 ödeme durumu ile yeni "ERP ödeme durumu" ayrı alandır, v1 değeri değişmez | 1→1 | KALIR | `PurchasingPages.tsx` detay (değişmedi); `erpRead` PAYMENT_STATUS v1 `payment_status`'a dokunmaz |
| A8-19 | Fatura detayı sağ sütun sırası: Eşleşme kartı, Tutar, UBL-TR, Limit · sözleşme, Karar geçmişi (A7-13..A7-20) | Detay | Aynı sıra; Eşleşme kartının altına yeni "Kaynak ve ERP" paneli eklendi | 1→1 | KALIR | `PurchasingPages.tsx:298-301` |
| A8-20 | Faz 7 Eşleşme kartı ve `durum=` süzgeçleri; ERP referansı (`erp_contract_ref`, `erp_order_ref`) ile otomatik eşleştirme (A7-04, A7-05) | Liste ve detay | Aynı; ERP fatura okuması eşleştiriciyi çağırır ve eşleştirici ERP siparişinden sözleşme referansını da çözer (D113 karar 6). Faz 7 testleri değişmedi | 1→1 | KALIR | `invoiceMatching.ts` (UNION, v1 satırı önce); Görev 5 raporu |
| A8-21 | Demo faturalar ANB2026000101, ANB2026000102, EGE2026000877: ERP okuması hiçbirini değiştirmez; ERP ödeme durumu girilemez (409) | Faz 7 koruması | Aynı koruma ERP içe aktarımına ve ödeme durumu ucuna da uzatıldı | n/a | KALIR | `erpRead.ts` `importErpInvoice`; `erp-v2.spec.ts` ("Demo fatura değiştirilmez.") |

### 1.3 Tedarikçi kartı, proje ve sözleşme ekranları (web)

| id | İşlev | Eski yer | Yeni yer | Dokunuş | Durum | Kanıt (dosya:satır) |
|---|---|---|---|---|---|---|
| A8-22 | Tedarikçi kartı "Kayıt ve onay" sekmesi: Kimlik ve kayıt, Banka bilgisi, Kaynak belgeler, Onay geçmişi panelleri; "Kimliği doğrula", "Kayıt onayı ver" / "Reddet" (A5-20..A5-23) | `/tedarikciler/:id` | Aynı paneller aynı sırada; **Kimlik ve kayıt / Banka bilgisi satırının altına** yeni "ERP" paneli eklendi | 2→2 | KALIR | `SupplierDetailPage.tsx:133-162` |
| A8-23 | Proje çalışma alanı Özet sekmesi: Tur, İstisnalar, Tasarruf panelleri (Faz 1–7) | `/projeler/:id` | Aynı; sonuna "ERP aktarımı" paneli eklendi (yalnız `integration.endpoint.read` izinli rolde çizilir) | 2→2 | KALIR | `ProjectWorkspace.tsx:296-299` |
| A8-24 | Sözleşme Özet sekmesi (Faz 3): sağ sütun panelleri | `/sozlesmeler/aile/:id` | Aynı; sonuna "ERP aktarımı" paneli eklendi | 3→3 | KALIR | `ContractOverview.tsx:130-131` |
| A8-25 | Yönetim > Kullanıcılar ve Entra: Entra bağlantı kartı, "Şimdi eşitle", Departmanlar, Kullanıcılar, Departmansız kayıtlar (Faz 1–2) | Yönetim sekmesi | Aynı; Departmansız kayıtlar panelinin üstüne Yönetici için "Masraf merkezi kodları" paneli eklendi | 2→2 | KALIR | `AdminPages.tsx:412-416` |

### 1.4 iOS — Faturalar — `InvoiceView.swift`

| id | İşlev | Eski yer | Yeni yer | Dokunuş | Durum | Kanıt (dosya:satır) |
|---|---|---|---|---|---|---|
| A8-26 | Fatura ayrıntısı üst bölümü: Tür, Tedarikçi, Tedarikçi durumu, Departman, Tarih, Eşleşme / Tahsis kontrolü, Net, KDV, Vergi dahil | Faturalar > ayrıntı | Aynı satırlar aynı sırada; Tarih ile Eşleşme arasına "Kaynak" ve "ERP ödeme durumu" eklendi (alan yoksa satır yok) | 2→2 | KALIR | `InvoiceView.swift:74-87` |
| A8-27 | Fatura listesi satırı (fatura no, eşleşme etiketi, tedarikçi, sözleşme, tahsis notu, tedarikçi notu, departman, tutar · tarih) | Faturalar listesi | Aynı; liste değişmedi | 1→1 | KALIR | `InvoiceView.swift:20-38` (diff boş) |
| A8-28 | Satırlar ve sözleşme bağı, Bulgular, Karar geçmişi, Eşleşme bölümü (salt okunur) | Ayrıntı | Aynı | 2→2 | KALIR | `InvoiceView.swift:96-157` (değişmedi) |
| A8-29 | Eski sunucu / bozuk alan: ayrıntı yine açılır (`Lossy` çözme) | Ayrıntı çözümü | `erpSource` da `Lossy` isteğe bağlıdır; eksik ya da bozuksa satır yok, ayrıntı açılır | 2→2 | KALIR | `Models.swift` `lossyErp` |

---

## 2. Yeni işlevler (Faz 8)

Hepsi **taklit sağlayıcıyla denendi** (gerçek Oracle NOT_RUN); persona yürüyüşü koşuldu (yukarıdaki "Güncelleme": web PASS, iOS kısmi).

### 2.1 Yönetim > Entegrasyonlar > Bağlantılar (web) — `IntegrationsPage.tsx`, `ErpEndpointCard.tsx`

| id | İşlev | Yer | Rol | Kanıt (dosya) |
|---|---|---|---|---|
| N8-01 | Bölüm çubuğu "Bağlantılar" / "Fatura aktarım mutabakatı", `?bolum=baglantilar|mutabakat`; Satınalma ve Denetçi varsayılan mutabakat, Yönetici varsayılan bağlantılar (R10) | Entegrasyonlar | Yönetici, Satınalma, Denetçi | `IntegrationsPage.tsx` |
| N8-02 | Sağlayıcı şeridi: "Taklit Oracle (gerçek değil)" (uyarı tonu), gerçek Oracle (bilgi tonu), "Sağlayıcı: Bağlı değil"; sır anahtarı yoksa uyarı | Bağlantılar | Hepsi | `IntegrationsPage.tsx:41-55` |
| N8-03 | 7 özellik listesi iki grupta ("1. aşama — okuma", "2. aşama — ERP'ye yazma (kapalı varsayılan)"): ad, yön rozeti, Açık/Kapalı, "ERP'ye yazma açık", "Sır yeniden girilmeli", son çalışma özeti ve sayılar; seçim `?ozellik=`, dar ekranda kartın altında açılıp kaydırılır | Bağlantılar | Hepsi | `IntegrationsPage.tsx:57-110` |
| N8-04 | Aç/kapa anahtarı; 422 `mapping_incomplete` (eksik alanların Türkçe adı), 422 `endpoint_invalid` (alan alan), 409 `provider_not_configured` ve `writeDisabled` bildirimi ("ERP'ye yazma kapatıldı, son sınama silindi") | Kart | Yönetici | `ErpEndpointCard.tsx` |
| N8-05 | Kapalıyken elle giriş yolu metni ve ilgili ekrana bağlantı (R6) | Kart | Hepsi | `ErpEndpointCard.tsx` |
| N8-06 | Adres: taban adres ve kaynak yolu (izinli ana bilgisayar listesi, üretimde https) | Kart | Yönetici yazar; diğerleri okur | `ErpEndpointCard.tsx`; `validateEndpointConfig` |
| N8-07 | Kimlik doğrulama: BASIC (kullanıcı adı) ve OAuth2 istemci kimliği (token adresi); sır alanı `type=password`, `autocomplete=off`, hiç doldurulmaz; "Ayarlı · tarih" / "Ayarlı değil"; "Değiştir", özellik kapalıyken "Kaldır"; "Sır yeniden girilmeli"; anahtar yapılandırılmamışsa alan kapalı | Kart | Yönetici | `ErpEndpointCard.tsx`; `erp-v2.spec.ts` (sır DOM'da ve yanıtlarda yok) |
| N8-08 | Yön (özellikten gelir, salt okunur) | Kart | Hepsi | `ErpEndpointCard.tsx` |
| N8-09 | Zamanlama: Yalnız elle / Aralıkla (15–1440 dk) / Her gün (İstanbul saati); yazan özellikte "Olay anında" | Kart | Yönetici | `ErpEndpointCard.tsx` |
| N8-10 | Alan eşlemesi tablosu (uygulama alanı, zorunlu, ERP yolu, dönüşüm; tutar DECIMAL, tarih DATE_YMD sabit), "EBS varsayılanını yükle", INVOICE `companyTaxId` çok şirketli notu, eksik zorunlu alan listesi | Kart | Yönetici yazar; diğerleri okur | `ErpEndpointCard.tsx` |
| N8-11 | "Bağlantıyı sına": 429 bekleme süresi, sınama sırasında ayar değiştiyse `staleNote`, taklitte "Sonuç taklit sağlayıcıyla denendi; gerçek Oracle bağlantısı sınanmadı", son sınama kalıcı görünür | Kart | Yönetici | `ErpEndpointCard.tsx`; `POST /integration/endpoints/:feature/test` |
| N8-12 | "Şimdi çalıştır": okuyan özellikte READ, yazan özellikte "Bekleyen yazmaları yeniden dene" (WRITE_RETRY), SUPPLIER'da ikisi; 202 `NOT_CONFIGURED` nedeni, 409 `run_in_progress` | Kart | Yönetici | `ErpEndpointCard.tsx` |
| N8-13 | "ERP'ye yazmayı aç" iletişimi (koşul listesi, "ERP'ye kayıt yazılacağını anlıyorum" kutusu; karar sunucuda; red nedeni ve "Yazma açılmadı; hiçbir kayıt ERP'ye gönderilmedi"); açıkken onaylayan ve tarih, "ERP'ye yazmayı kapat" | Kart | Yönetici | `ErpEndpointCard.tsx`; `POST/DELETE .../write-enable` |
| N8-14 | Son 20 çalışma (tarih, tetikleyen ve kişi, durum etiketi, "Taklit" rozeti, sayılar, "Hata kaydı (n)"), süren çalışmada 3 sn yenileme, hata ayrıntısı (Türkçe ileti, ham kod yok) | Kart | Yönetici, Satınalma, Denetçi | `ErpEndpointCard.tsx`; `GET .../runs`, `GET /integration/runs/:id/errors` |
| N8-15 | Satınalma ve Denetçi için kartlar salt okunur (anahtar, kaydet, sına, çalıştır, parola alanı yok; sır yalnız "ayarlı/ayarlı değil") | Kart | Satınalma, Denetçi | `erp-v2.spec.ts` |

### 2.2 Elle giriş ve ERP aktarımı (web) — `ErpManual.tsx`

| id | İşlev | Yer | Rol | Kanıt (dosya) |
|---|---|---|---|---|
| N8-16 | "ERP tedarikçi kodu" kaynak rozetiyle (Elle / ERP / ERP (taklit) / ERP (kaynağı doğrulanamadı)); girme, düzenleme, temizleme; 409 `supplier_code_duplicate` (diğer karta bağlantı) ve `supplier_merged`; taklit ve doğrulanamayan kod için not | Tedarikçi kartı > Kayıt ve onay > "ERP" | Satınalma yazar (`canEdit`); diğerleri okur | `ErpManual.tsx:30-60` |
| N8-17 | Tedarikçi "ERP'ye aktarım" bölümü (SUPPLIER yazma durumu, ERP referansı, elle iletildi) | Aynı panel | Satınalma; `integration.endpoint.read` | `ErpManual.tsx:131` |
| N8-18 | Proje Özet "ERP aktarımı" (talep): durum (`statusLabel`), ERP referansı, elle iletim kişi/tarih/not, `modeLabel`, önceki kayıtlar, çok kazananlı talep notu | Proje çalışma alanı > Özet | `integration.endpoint.read` olan roller görür | `ErpManual.tsx:134`; `ProjectWorkspace.tsx:298` |
| N8-19 | Sözleşme Özet "ERP aktarımı" (sözleşme başlığı), aynı alanlar | Sözleşme > Özet | Aynı | `ContractOverview.tsx:131` |
| N8-20 | "ERP'ye elle iletildi" iletişimi: ERP referansı ve not; kayıttan önce "elle kayıt sonradan düzeltilemez" uyarısı; 409 `already_sent`, `already_recorded`, `write_in_progress` (`retryAfterMinutes`); "ERP'de zaten kayıtlı" ve "Kartta ERP kodu var (…; ERP'de doğrulanmadı)" etiketleri | ERP aktarımı panelleri | Satınalma | `ErpManual.tsx`; `POST /erp/outbound/manual` |
| N8-21 | Fatura detayı "Kaynak ve ERP" paneli: Kaynak (Oracle ERP / Taklit Oracle (gerçek değil) / Elle / e-Fatura) ve taklit notu, ERP fatura kimliği ve sağlayıcı, ERP sözleşme ve sipariş referansı, ERP ödeme durumu ve kaynak rozeti | Fatura detayı | Hepsi okur | `ErpManual.tsx:197`; `PurchasingPages.tsx:300` |
| N8-22 | ERP ödeme durumu elle girişi ve temizleme (Ödendi / Kısmi / Ödenmedi / Bilinmiyor, tarih; uygulama ödeme yapmaz); demo faturada 409 | Aynı panel | Satınalma | `PUT /invoices/:id/erp-payment-status` |
| N8-23 | Fatura listesinde "ERP ödeme: <etiket>" satırı | Faturalar | Hepsi | `PurchasingPages.tsx:140-142` |
| N8-24 | "Fatura gir"de isteğe bağlı "ERP sözleşme referansı" ve "ERP sipariş referansı" (PURCHASE_ORDER elle yolu) | Fatura gir | Satınalma | `PurchasingPages.tsx:157-181` |
| N8-25 | "Masraf merkezi kodları": departman başına kod, kaynak rozeti, ERP listesindeki ad ("ERP listesinde yok"), "Düzenle" ile `/integration/erp/cost-centers` listesinden seçim ya da elle giriş, `knownInErp` bildirimi, taklit liste notu | Yönetim > Kullanıcılar ve Entra | Yönetici | `ErpManual.tsx:240`; `AdminPages.tsx:415` |

### 2.3 iOS

| id | İşlev | Yer | Kanıt (dosya) |
|---|---|---|---|
| N8-26 | "Kaynak" satırı (etiket sunucudan olduğu gibi; taklit dahil); alan yoksa satır yok | Fatura ayrıntısı | `InvoiceView.swift:82` |
| N8-27 | "ERP ödeme durumu" satırı (varsa); yönetim yüzeyi yoktur (R11) | Fatura ayrıntısı | `InvoiceView.swift:83` |

### 2.4 API, işçi ve veri

| id | İşlev | Yer | Kanıt (dosya) |
|---|---|---|---|
| N8-28 | Uç nokta ayarı: `GET /integration/endpoints` (7 kart; satırı yoksa varsayılan kapalı; sır yalnız `secretSet`/`secretUpdatedAt`/`secretNeedsReentry`), `PUT /integration/endpoints/:feature` (sır mühürlenir, `secret:null` siler; denetim yalnız alan adları), sınama, Şimdi çalıştır, çalışmalar ve hata kaydı uçları, `write-enable` POST/DELETE | `apps/api/src/modules/integrationEndpoints.ts` | `integrationEndpoints.test.ts` |
| N8-29 | Okuma işi `erp.read` (`processErpRead`): SUPPLIER (VKN ile kart, yeni kart açılmaz), COST_CENTER, PURCHASE_ORDER, INVOICE (`importErpInvoice` CREATED/LINKED/UNCHANGED + Faz 7 eşleştirici), PAYMENT_STATUS; kayıt başına SAVEPOINT, hata kaydı, çalışma her yolda kapanır | `modules/erpRead.ts` | `erpRead.test.ts` |
| N8-30 | Okuma uçları `GET /integration/erp/cost-centers`, `GET /integration/erp/purchase-orders` | `server.ts`, `erpRead.ts` | `erpRead.test.ts` |
| N8-31 | Yazan akışlar (kapalı varsayılan): `enqueueErpOutbound` (kazanan seçildi, sözleşme zinciri APPROVED, tedarikçi onaylandı; SAVEPOINT içinde `enqueueErpOutboundSafe`), `processErpWrite` (önce deneme kaydı, sonra `find`, tam bir kez; UNKNOWN; SENT + dış referans), `WRITE_RETRY` | `modules/erpWrite.ts` | `erpWrite.test.ts` |
| N8-32 | Elle uçlar: `GET/PUT /suppliers/:id/erp-code`, `GET /departments/cost-centers`, `PUT /departments/:id/cost-center`, `PUT /invoices/:id/erp-payment-status`, `GET /erp/outbound`, `POST /erp/outbound/manual` | `modules/erpManual.ts` | `erpManual.test.ts` |
| N8-33 | Zamanlayıcı (`enqueueDueErpReads`, dakikada bir, idempotency `erp.read:<özellik>:<kiracı>:<yuva>`), bayat çalışma temizleyicisi (nabız 15 dk, kuyrukta 240 dk, alınmadan 60 dk), ayrı seri `erp` şeridi (`erp.read` / `erp.write` birer birer) | `worker.ts`, `erpRead.ts`, `erpWrite.ts`; migration 058c, 058d, 058e | `erpRead.test.ts`, `erpWrite.test.ts` |
| N8-34 | Sır kutusu: `INTEGRATION_SECRET_KEY` → HKDF-SHA256 KEK, uç nokta başına veri anahtarı, AES-256-GCM, AAD `tenant|endpoint|feature`; `redactSecrets`; migration 058b ile yalnız sır tablosunda DELETE | `integrationSecrets.ts` | `integrationSecrets.test.ts` |
| N8-35 | Sağlayıcılar: `ERP_PROVIDER` none / taklit / oracle-ebs (taklit üretimde açılış hatası), "Taklit Oracle (gerçek değil)" (hata-401, zaman-asimi, bozuk-tutar kipleri; üretimde yazma reddi), Oracle EBS bağdaştırıcısı (https, yönlendirme izlenmez, yanıt boyutu sınırı, sayfalama döngü koruması, Idempotency-Key) yalnız yerel test sunucusuna karşı | `config.ts`, `erp/*` | `erpProviders.test.ts` |
| N8-36 | Domain: `ERP_FEATURE_CATALOG`, `validateEndpointConfig`, `applyFieldMap`, `canEnableWrite`, `isDue`, `redactSecrets`, `reconcileManual`; izinler `integration.endpoint.read` (Yönetici, Satınalma, Denetçi), `integration.endpoint.manage`, `integration.endpoint.run` (Yönetici), `erp.manual.record` (Satınalma), `department.cost_center` (Yönetici) | `packages/domain/src/{erpV2,roles}.ts` | `erpV2.test.ts` |
| N8-37 | Şema: 057 (`integration_endpoints`, `integration_endpoint_secrets`, `integration_runs`, `integration_run_errors`), 058 (`erp_outbound_records`, `erp_cost_centers`, `erp_purchase_orders`, tedarikçi/departman/fatura ERP sütunları), 058a düzeltmeleri (fatura referans kaynağı, elle/ERP koruması, yazma kaydı yaşam döngüsü), 058b–058e; RLS + DELETE'siz en dar GRANT | `apps/api/migrations` | `integrationSchema.test.ts` |
| N8-38 | Fatura yanıtlarında `erpSource` (detay) ve `sourceLabel`, `erpPaymentStatusLabel`, `erpProviderKind` (liste); taklit kökeni denetim kaydından türetilir ("ERP (taklit)", "(taklit ERP)") | `modules/invoices.ts` | `invoices.test.ts` |

---

## 3. Açık kalemler ve eksik kanıt

1. **Gerçek Oracle EBS NOT_RUN.** Test ortamı ve kimlik bilgisi yok; EBS varsayımı (analiz §9 #4) teyit bekliyor. Alan yolları, sayfalama, `find` yanıtının idempotency anahtarını yansıtması (D113), gerçek ağda zaman aşımı ve belirsiz yazma davranışı yalnız yerel `node:http` sunucusuyla sınandı.
2. **Persona yürüyüşü koşulmadı:** web (Yönetici, Satınalma, Denetçi, Departman kullanıcısı) ve iOS; EN katmanı yürünmedi. Dev `.env`'de `ERP_PROVIDER=taklit` ve yalnız geliştirme için rastgele `INTEGRATION_SECRET_KEY` var; çok şirketli dev kiracısında INVOICE kartında "EBS varsayılanını yükle" gerekir (kayıtlı eşleme `companyTaxId` kazanmaz), yoksa taklit fatura okuması `company_unresolved` olur.
3. ~~Yönetici için "mutabakat açıklaması" bir dokunuş daha uzakta (A8-11)~~ **ÇÖZÜLDÜ (12162f2):** Yönetici'nin varsayılan Bağlantılar görünümünde bölüm seçicinin altına "ERP mutabakatı Satınalma ve Denetçi rollerine açık: …" satırı eklendi; açıklama ilk ekranda, dokunuş 2'de kaldı (eski davranışla aynı); karar gerekmiyor.
4. **Tam test koşusu ve taze veritabanında e2e yapıldı:** son doğrulama (HEAD `7eebc62`, controller, çalışan ajan yokken): domain 391/391, API 830 geçti / 44 atlandı / 0 kaldı, typecheck, web build, iOS temiz derleme (0 kod uyarısı) ve tam web e2e taze migrate + seed edilmiş veritabanında 213 geçti / 0 kaldı / 99 atlandı (1440/1280/390), hepsi PASS. Önceki veri kaynaklı e2e başarısızları (`a11y:60`, `removed-v2:101`, `contracts-v2:354/:474/:443`, `projects` UX04/UX09) taze veritabanında testlerin kendi verisini kurmasıyla kapandı (5937541); `governance:103` kiracı dışa aktarımı kusuru ürün hatası çıktı ve düzeltildi (7eebc62).
5. ~~Web ardıl partisi (küçük kalemler) yapılmadı~~ **YAPILDI (12162f2):** `canEdit` yerine `hasPermission(erp.manual.record)`, kimlik türü değişince girilmiş sırrın temizlenmesi, 429 çift bekleme metni, sır satırı `role=group`, ödeme durumu kaynak etiketinin sunucudan gösterilmesi (taklitte uyarı tonu). Persona düzeltmeleri (85cf269): iOS taklit ödeme durumu etiketli, fatura başlığında dışa aktarım kaydı net, mutabakat bağdaştırıcı notu ayrımı, Hata kaydı ve kayıt bildirimi görünür alana kayar, tekrarlı cümleler kaldırıldı.
6. **Figma'daki "Tümünü sına" düğmesi yok** (toplu sınama ucu yok; sınama uç nokta başına 10 sn hız sınırlı).
7. **Taklit kod rozetinin ekranda görülmesi e2e'de NOT_RUN:** taklit tedarikçi VKN'leri (930000001–3) demo tedarikçilerle eşleşmiyor; "ERP (taklit)" rozeti yalnız elle eşleşen kart açılırsa görülür. iOS'ta taklit etiketli ödeme ve Kaynak satırı persona yürüyüşünde de görülmedi (dev'de taklit fatura yok; kod 85cf269 ile eklendi, yalnız derlendi ve kod okumasıyla doğrulandı).
8. **iOS:** yönetim yüzeyi yok (R11); fatura listesi değişmedi (Kaynak yalnız ayrıntıda). iOS ayrıntısında yeni iki satırın büyük yazı boyutunda (AX5) görünümü bu görevde ayrıca belgelenmedi.
9. **Bırakılan sınırlamalar (D113):** noktalı yazma yolları düz; izinli adres listesi bağlantı noktasını yok sayar; sınama hata metni (≤ 300 karakter) Satınalma ve Denetçi'ye görünür; Digest kimlik doğrulaması yok; çalışma sürerken kısmi ilerleme görünür; tedarikçi kodu tekilliği yalnız uygulamada; sipariş listesi kiracı genelinde; paylaşılan seri `erp` şeridi (okuma yazmayı geciktirir); kuyruğa alma hatası yalnız günlüğe yazılır; REQUISITION olay noktası e2e'de yok; MANUAL giden kayıt değişmez (yazım hatası uygulama içinde düzeltilemez).
10. **Değiştirilen eski testler:** `apps/web/e2e/navigation-v2.spec.ts:117` (yönlendirme beklentisi `?bolum=mutabakat`, R10; dosya başında not); `erpRead.test.ts` I2 vakası bilerek yeniden kuruldu; API'de iki beklenti (tedarikçi kodu etiketi, MANUAL ödeme `toEqual` + mock/provider null; neden D113). `governance.spec.ts` ve `a11y.spec.ts` değişmedi.

## 4. Sonuç

Eski işlev satırları: **29** (A8-01..A8-29). **KALIR 26**, **DÖNÜŞTÜ 3** (A8-02, A8-11, A8-12; hiçbirinde bilgi kalkmadı); **TAŞINDI 0**; **kaybolan ya da erişilmez hale gelen işlev: 0**, Bölüm 3 madde 3'teki tek dikkat noktası (Yönetici açıklaması) 12162f2 ile çözüldü. Yeni işlev satırları: **38** (N8-01..N8-38). Hiçbir ERP işlevi gerçek Oracle'a karşı görülmedi (NOT_RUN); persona web PASS, iOS kısmi; bu belge kod okumasıyla hazırlandı, canlı kanıt persona raporundadır.
