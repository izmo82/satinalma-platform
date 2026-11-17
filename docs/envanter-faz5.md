# Faz 5 (Tedarikçi portalı) işlev envanteri: önce / sonra

Tarih: 18.11.2026. Dal: `v2-sadelestirme`. Kural: SIFIR GERİLEME (global CLAUDE.md, 07.11.2026).

**Önce:** `docs/envanter-faz1.md` Bölüm 2 (M4, M13, M14, R4, R18, R19, W-00-16), 3.6 (W-06-01..06 tedarikçi listesi), 3.7 (W-07-01..17 tedarikçi kartı ve alt sekmeleri), 3.26 (W-26-01..11 tedarikçi portalı) ve iOS Tedarikçiler sekmesi (`SuppliersView.swift`, Faz 1'de ayrı satırı yok; kod taramasıyla eklendi: I-S1..I-S6) ile iOS İşlerim (I-01). Karşılaştırma tabanı Faz 5 başlangıç kodu: `70bf031` (`git show 70bf031:<dosya>`). Not: Faz 1 satır numaraları daha eskidir; bu belgedeki "Eski yer" sütunu Faz 1 satır kimliğini, "Kanıt" sütunu güncel dosya:satırı verir.
**Sonra:** `HEAD` (`b15b7bd`) kodu: `apps/web/src/pages/{SuppliersPage,SupplierDetailPage,SupplierCardV2,SupplierApplicationReview,SupplierApplicationSettings,EmailOutboxPage,PublicApplication,PortalPages,PortalV2Pages,ProjectWorkspace,WorkPage}.tsx`, `apps/web/src/lib/supplierV2.tsx`, `apps/web/src/App.tsx`, `ios/Satinalma/Satinalma/Features/{SuppliersView,SupplierSummaryView,TasksView}.swift`. Satır numaraları bu kodundur.

## Doğrulama yöntemi ve sınırı

Satırlar **kod okumasıyla** hazırlandı: eski yer `git show 70bf031:<dosya>` ve Faz 1 envanteriyle, yeni yer güncel dosyalarla karşılaştırıldı. Kaynak dosyaların Faz 5 aralığı değişikliği: `PortalPages.tsx` yalnız +5 satır (özet kartları ve belge bandı; eski satırlar değişmedi), `SupplierEvaluation.tsx` **hiç değişmedi** (`git diff 70bf031 HEAD --stat` listesinde yok), `SupplierDetailPage.tsx` ve `SuppliersPage.tsx` içinde silinen satırlar bu belgede tek tek anılır (aşağıda "Silinen satırlar"). **Canlı yürüyüş kanıtı** `.superpowers/sdd/2026-11-17-v2-faz5-tedarikci-portali/persona-report.md` dosyasından gelir (18.11.2026; gerçek Chromium + sunucu çağrıları + iPhone simülatörü): web akış 1–4 PASS, iOS akış 5 kısmi. Bu belge için ayrıca hiçbir ekran çalıştırılmadı. Persona raporunun sınırları aynen geçerlidir:

- NOT_RUN: yeni firmanın kendi portal girişi (davetli kullanıcı dev girişinde yok; gerçek giriş Entra B2B ister), iOS'ta aşama süzgecinden seçim, İşlerim'de "Bu iş web'de yapılır" ekranı, iOS özette AX5, açık ayrılış satırı, iOS Departman kullanıcısı; web'de süresi dolmuş tamamlama bağlantısında "Bağlantıyı yeniden gönder", PDF önizlemenin görsel içeriği, belirteç maskesi (yalnız dev/test dışında), PDF dışı dosya türleriyle belge yükleme.
- Gerçek Microsoft Graph gönderimi ve gerçek ClamAV taraması hiç çalışmadı (kanallar yapılandırılmadı): ekranlar "Gönderilmedi — e-posta kanalı yapılandırılmadı" ve "Virüs taraması yapılandırılmadı" der; "gönderildi" ya da "tarandı" hiçbir ekranda görülmedi.
- Dil: Faz 5 ekranlarındaki sabit metin Türkçedir; EN katmanı bu envanterde ve persona raporunda yürünmedi. Kod okumasıyla "EN tamam" denmez (açık kalem, Bölüm 3).
- Persona düzeltmelerinin (`2afc224`, `482053b`, `f0034b5`, `117f7bf`) canlı yeniden yürüyüşü yapılmadı.

Durum anlamları: **KALIR** = işlev aynı yerde, aynı dokunuşla, aynı davranışla; **DÖNÜŞTÜ** = aynı yerde ya da aynı rolle ama biçimi/içeriği değişti, eski bilginin tamamı erişilebilir; **TAŞINDI** = yeri değişti, erişim en az eskisi kadar kolay; **KASITLI DEĞİŞİKLİK** = kullanıcı onaylı kural nedeniyle davranış değişti (D110 R9). Dokunuş = sol menüden işleve varmak için tıklama/dokunuş sayısı.

---

## 1. Eski işlevler (önce → sonra)

### 1.1 Menü, rota ve oturum (web)

| id | İşlev | Eski yer | Yeni yer | Dokunuş | Durum | Kanıt (dosya:satır) |
|---|---|---|---|---|---|---|
| A5-01 | Tedarikçiler menü girişi ve sayacı (görev sayısı) | Menü > Tedarikçiler (M4) | Aynı; sayaç artık `supplier_application` görev türünü de sayar | 1→1 | KALIR | `App.tsx:163` |
| A5-02 | Tedarikçiler alt sekmeleri: Liste, Olaylar, Anketler, Performans ağırlıkları | Tedarikçiler üst sekme çubuğu | Aynı dört sekme aynı adreslerle; sona Faz 6 "Risk matrisi" eklendi | 1→1 | KALIR | `App.tsx:92-96` |
| A5-03 | Eski adresler yönlendirmesi: `/olaylar`, `/olaylar/:id`, `/anketler`, `/performans-agirliklari` | `App.tsx` | Aynı yönlendirmeler | 0→0 | KALIR | `App.tsx:276-279` |
| A5-04 | Tedarikçi kartı rotası `/tedarikciler/:id` (R4) | `SupplierDetailPage` | Aynı rota; yeni `/tedarikciler/basvurular/:id` kardeş rotadır, `:id`'den önce tanımlı (çakışma yok) | 0→0 | KALIR | `App.tsx:244-245` |
| A5-05 | Olay detayı `/tedarikciler/olaylar/:id` | `IncidentPage` | Aynı | 0→0 | KALIR | `App.tsx:243` |
| A5-06 | Portal menüsü: Teklif davetleri (M13), Anketler (M14) | Portal sol menü, 2 giriş | Aynı iki giriş aynı adres ve adlarla; araya Tekliflerim, Skorum ve risk durumum, Belgelerim, Firma bilgileri eklendi | 1→1 | KALIR | `App.tsx:148-155` |
| A5-07 | Portal rotaları `/portal`, `/portal/:id`, `/portal/anketler`, `/portal/anketler/:id` (R18, R19) | `App.tsx` | Aynı dört rota aynı bileşenlerle; yeni rotalar `/portal/tekliflerim`, `/skorum`, `/belgeler`, `/firma` **`/portal/:id`'den önce** tanımlı (`/portal/:id` turu yakalamaz) | 0→0 | KALIR | `App.tsx:218-225` |
| A5-08 | Tedarikçi/iç kullanıcı rota ayrımı (W-00-16): tedarikçi iç adreslerde `/portal`'a, iç kullanıcı `/portal/*`'da `/islerim`'e döner | `App.tsx` | Aynı (`*` → `/portal`; `/portal/*` → `/islerim`) | 0→0 | KALIR | `App.tsx:226`, `:229` |
| A5-09 | "Şirket kapsamı" bandında "Tedarikçi portalı" etiketi; portalda genel arama ve bildirim yok | `App.tsx` | Aynı | 0→0 | KALIR | `App.tsx:169`, `:209` |
| A5-10 | Oturumsuz portal adresi girişe düşer; giriş sonrası portal ana sayfası | `LoginPage` | Giriş sonrası **aynı adrese** döner (`loginReturnPath`), eskiden `/portal`; `/portal/...` dışı adreslerde eski varsayılan `/portal` aynen | 0→0 | DÖNÜŞTÜ (eski varsayılan korunur; daha ileri gider) | `session.tsx:102`, `LoginPage.tsx:93`, `:130` |
| A5-11 | Görevden kayda geçiş: tedarikçi görevi → `/tedarikciler/:id`, `assessment_blocker`/`risk_rereview`/`new_business_hold` → Değerlendirme sekmesi | `WorkPage.entityHref` | Aynı; yeni `supplier_document_*` → Belgeler, `supplier_offboarding` → Ayrılış, `supplier_no_portal_user` → Portal kullanıcıları sekmesi; başvuru görevi → başvuru incelemesi | 1→1 | KALIR | `WorkPage.tsx:17-23` |

### 1.2 Tedarikçi listesi (`/tedarikciler`, W-06-xx)

| id | İşlev | Eski yer | Yeni yer | Dokunuş | Durum | Kanıt |
|---|---|---|---|---|---|---|
| A5-12 | Durum süzgeci: Tümü, Aday havuzu, Aktif, Askıda, Reddedilen (URL `durum`) | Liste üstü 5 çip | Çipler aşamaya göre: Tümü, Başvuru (açık), Aday, Onaylı, Pasif, Reddedildi (URL `asama`). Eski beş çip eşleşmesi: Aday havuzu → Aday (aynı küme), Aktif → Onaylı (Aktif + Koşullu), Askıda → Pasif (Askıda + Arşiv), Reddedilen → Reddedildi (aynı küme). **Eski `?durum=` adresleri aynen çalışır** ve süzgeç satırında eski adla bir çip gösterir (Aday havuzu, Aktif, Askıda, Reddedilen); tek tek eski durumu seçmek (ör. yalnız Askıda) yalnız bu adresle ya da satırın ikincil metniyle yapılır | 1→1 | DÖNÜŞTÜ | `SuppliersPage.tsx:57-58`, `:23-24`; eski: `70bf031:SuppliersPage.tsx:14` |
| A5-13 | Ünvan veya VKN/TCKN arama kutusu + Ara (URL `q`) | Liste üstü | Aynı alan, aynı etiket ve yer | 1→1 | KALIR | `SuppliersPage.tsx:60-64` |
| A5-14 | Tablo sütunları: Ünvan, Durum, Vergi kimliği, Belge, Dikkat, Kayıt tarihi; satırdan karta geçiş | Liste | Tedarikçi, VKN, **Aşama**, Sorumlu ekip (yeni), Belgeler, Dikkat, Kayıt tarihi; ünvan bağlantısı karta gider. "Durum" → "Aşama" (aşağıda A5-15) | 1→1 | DÖNÜŞTÜ | `SuppliersPage.tsx:97-123` |
| A5-15 | Satırda tedarikçi durumu | `supplierStatus[s.status]` etiketi (Aday/Aktif/Askıda/Reddedildi/Arşiv/Koşullu/Birleştirildi) | Aşama etiketi + eski durumun görünür ikincil metni (ör. "Pasif · Askıda", "Pasif · Arşiv"); Onaylı ve Onaylı (koşullu) zaten eski durumu söyler. Eski bilgi yalnız ipucunda kalmaz (e40106f) | 0→0 | DÖNÜŞTÜ | `SuppliersPage.tsx:108`, `supplierV2.tsx:148` |
| A5-16 | VKN sütunu: tür + numara ya da "Doğrulanmadı" | Liste | Aynı | 0→0 | KALIR | `SuppliersPage.tsx:107` |
| A5-17 | Belge sütunu: bağlı fatura ve sözleşme belgesi sayısı (`documentCount`) | Liste, sağa hizalı sayı | Aynı sayı ("Belgeler"; ipucu "Bağlı fatura ve sözleşme belgesi") + belge uyarısı etiketleri. **Bilinen sınır (persona B2):** tedarikçinin kendi belgeleri (başvuru/portal) bu sayıya girmez; API tarafı `supplierDocumentCount` hazır, web sütunu henüz göstermiyor | 0→0 | DÖNÜŞTÜ | `SuppliersPage.tsx:111-117` |
| A5-18 | Dikkat etiketleri: "Kimlik incelemesi" (W-06-04), "Banka doğrulama" (W-06-05, D104 ile salt bilgi) | Liste | Aynı iki etiket | 0→0 | KALIR | `SuppliersPage.tsx:119-120` |
| A5-19 | Yükleniyor, hata (Yeniden dene) ve boş durum ("Bu filtrede tedarikçi yok"; aday süzgecinde ayrı metin) | Liste | Aynı üç durum, aynı metinler | 0→0 | KALIR | `SuppliersPage.tsx:93-94` |

### 1.3 Tedarikçi kartı (`/tedarikciler/:id`, W-07-xx)

`SupplierEvaluation.tsx` (W-07-13..17: Değerlendirme, Olaylar, Karne sekmelerinin içeriği) bu aralıkta **hiç değişmedi**; yalnız barındıran kart sayfası değişti.

| id | İşlev | Eski yer | Yeni yer | Dokunuş | Durum | Kanıt |
|---|---|---|---|---|---|---|
| A5-20 | Başlık: ünvan, durum, ülke · kimlik türü · vergi kimliği / "Kimlik doğrulanmadı" (W-07-01) | Kart başı | Aynı; durum etiketi yerine `StageWithStatus` (aşama + eski durum metni) | 1→1 | DÖNÜŞTÜ | `SupplierDetailPage.tsx:73-79` |
| A5-21 | Sekmeler (URL `sekme`): Kayıt ve onay, Değerlendirme ve risk, Olaylar, Performans karnesi (W-07-02) | 4 sekme | Aynı dört sekme, aynı adlar ve aynı `?sekme=` değerleri (`kayit` varsayılan, `degerlendirme`, `olaylar`, `karne`); araya Belgeler ve geçerlilik, Sözleşmeler ve projeler, Yıllık risk (Faz 6), Portal kullanıcıları, (liste varsa) Ayrılış kontrol listesi eklendi | 2→2 | KALIR | `SupplierDetailPage.tsx:17-19`, `:117-123` |
| A5-22 | "Kimliği doğrula" (W-07-03; aday + MASTER_DATA; tür, vergi kimliği, gerekçe; birleştirme) | Kart başı düğme | Aynı koşul ve düğme | 2→2 | KALIR | `SupplierDetailPage.tsx:87-89` |
| A5-23 | "Kayıt onayı ver" / "Reddet" (W-07-04; gerekçeli; kaydı açan onaylayamaz) | Kart başı | Aynı düğmeler ve kurallar | 2→2 | KALIR | `SupplierDetailPage.tsx:90-91`, `:213-216` |
| A5-24 | "Aktifleştir" (W-07-05; engel listesi; `expectedRowVersion`) | Kart başı | Aynı | 2→2 | KALIR | `SupplierDetailPage.tsx:92-94` |
| A5-25 | Aday uyarı bandı + eksik koşullar (W-07-06) | Kart üstü | Aynı bant (metin değişmedi), üstüne "Onaylı yapmadan önce" kutusu eklendi (bilgi verir, engellemez) | 0→0 | KALIR | `SupplierDetailPage.tsx:110-113` |
| A5-26 | Birleştirilmiş kayıt bandı + "Güncel kayda git" (W-07-07) | Kart üstü | Aynı | 0→0 | KALIR | `SupplierDetailPage.tsx:115` |
| A5-27 | "Kimlik ve kayıt" paneli (W-07-08) | Kayıt ve onay | Aynı panel, aynı sekmede | 2→2 | KALIR | `SupplierDetailPage.tsx:133` |
| A5-28 | "Banka bilgisi" paneli ve "Belgede farklı IBAN okundu" bandı (W-07-09; D104 salt bilgi) | Kayıt ve onay | Aynı panel | 2→2 | KALIR | `SupplierDetailPage.tsx:150-155` |
| A5-29 | "Kaynak belgeler" tablosu: belge, belgedeki ünvan, "Ünvan farkı", bağlanma zamanı, belgeye bağlantı (W-07-10) | Kayıt ve onay | Aynı tablo ve sekme. Tedarikçinin kendi belgeleri **ayrı** Belgeler ve geçerlilik sekmesindedir; kayıt `documents` anahtarı eski şekliyle döner (yeni belgeler `supplierDocuments` anahtarında) | 2→2 | KALIR | `SupplierDetailPage.tsx:164-171` |
| A5-30 | "Onay geçmişi" zaman çizelgesi (W-07-11) | Kayıt ve onay | Aynı | 2→2 | KALIR | `SupplierDetailPage.tsx:180` |
| A5-31 | İşlem geri bildirimi: başarı, 409'da yenileme uyarısı, eksik koşullar (W-07-12) | Kart üstü | Aynı bant ve metinler; v2 bölümleri için ayrı yol (`runV2`: hata diyaloğa döner, yazılan korunur) | 0→0 | KALIR | `SupplierDetailPage.tsx:101-103`, `:60-65` |
| A5-32 | Değerlendirme sekmesi: liste, "Değerlendirme başlat", "Anket şablonları" bağlantısı (W-07-13, 14) | Değerlendirme ve risk | Aynı içerik; üstüne "Anket riski (içsel/kalan)" başlığı eklendi (Faz 6 R14) | 2→2 | KALIR | `SupplierDetailPage.tsx:128`; `SupplierEvaluation.tsx` değişmedi |
| A5-33 | Olaylar sekmesi: liste, "Olay bildir", mükerrer uyarısı (W-07-15) | Olaylar | Aynı | 2→2 | KALIR | `SupplierEvaluation.tsx` değişmedi; `SupplierDetailPage.tsx:129` |
| A5-34 | Performans karnesi: yıl, puan, önceki yıl, açık düzeltici faaliyetler, "Performans incelemesi gir", "Ağırlık kuralları" (W-07-16, 17) | Performans karnesi | Aynı | 2→2 | KALIR | `SupplierEvaluation.tsx` değişmedi; `SupplierDetailPage.tsx:129` |
| A5-35 | Kartta tedarikçi durumları: Aday, Aktif, Koşullu, Askıda, Arşiv, Reddedildi, Birleştirildi eski kayıtlar eskisi gibi açılır, hiçbir satır güncellenmedi | Kart, fatura, sözleşme | Aynı kayıtlar aynı kartla; Faz 1 Review Focus 4: durum eşlemesi veri değiştirmeden türetilir. Arşivlenmiş kayıt için "yeniden açılamaz" açıklaması görünür | 1→1 | KALIR | `SupplierDetailPage.tsx:107-109`; `packages/domain/src/supplierPortal.ts:17` `supplierStage` (`d04a4f9`) |

### 1.4 Proje teklif turu, tedarikçi seçimi ve faturalar/sözleşmeler (kart bağlantıları)

| id | İşlev | Eski yer | Yeni yer | Dokunuş | Durum | Kanıt |
|---|---|---|---|---|---|---|
| A5-36 | Teklif turuna **aday** tedarikçi davet etme ("Teklif verebilir, aktivasyon olmadan kazanan olamaz") | Proje > Özet > tur formu: aday listede seçilebilir | Aday listede kalır ama **seçilemez**, "Aday tedarikçi önce onaylanmalı." nedeniyle gösterilir; API 422 `supplier_not_approved`. **Açık turlar ve verilmiş davetler etkilenmez**; adayın açık turdaki teklif verme ve kazanan engeli (`award_blocked`) davranışı aynı | 2→2 | KASITLI DEĞİŞİKLİK | `ProjectWorkspace.tsx` tur formu (`eligibleForInvite`); `sourcing.ts:172-175`; D110 R9 (kullanıcı kararı: yalnız onaylı tedarikçi davet edilir) |
| A5-37 | Teklifler sekmesi: davetli tedarikçiler tablosu, kartına bağlantı, mühürlü bandı (W-04-10) | Proje > Teklifler | Aynı; davet e-postası olan turlarda ek "Davet e-postası" sütunu | 2→2 | KALIR | `ProjectWorkspace.tsx:404`, `:411` |
| A5-38 | `GET /api/v1/supplier-options` kullanıcıları (sözleşme sihirbazı, imza, satın alma) | Diğer ekranlar | Yanıta yalnız `eligibleForInvite`, `stageLabel` eklendi; R9 yalnız turlara uygulanır, diğer tüketiciler etkilenmedi | 0→0 | KALIR | `sourcing.ts:172` (yalnız tur ucunda) |
| A5-39 | Faz 3 R9: sözleşme ekleme akışında aday tedarikçi kartı açma | Sözleşme sihirbazı | Aynı (`CANDIDATE` kart açılır; v2'de "Aday" aşaması) | 0→0 | KALIR | R1 eşlemesi (D110) |

### 1.5 Tedarikçi portalı (web, W-26-xx)

`PortalPages.tsx`: `git diff 70bf031 HEAD` yalnız **+5 satır** (import, `PortalSummaryCards`, `ExpiredDocumentsBand`); eski satırların hiçbiri silinmedi ya da değişmedi.

| id | İşlev | Eski yer | Yeni yer | Dokunuş | Durum | Kanıt |
|---|---|---|---|---|---|---|
| A5-40 | Teklif davetleri listesi; "Teklif ver" / "Teklifi güncelle" / "Görüntüle"; boş durum (W-26-01) | `/portal` | Aynı sayfa ve tablo; üstüne özet kartları eklendi | 1→1 | KALIR | `PortalPages.tsx:20-40` |
| A5-41 | Tur başlığı: alıcı, tur no, kategori, kapanış, sunucu saatine göre geri sayım, geçerli sürüm (W-26-02) | `/portal/:id` | Aynı; üstüne yalnız süresi dolmuş belge bandı eklendi | 2→2 | KALIR | `PortalPages.tsx:171-180` |
| A5-42 | Fiyat tablosu, birim farkı uyarısı, önizleme toplamı (W-26-03) | Teklif ekranı | Aynı | 2→2 | KALIR | `PortalPages.tsx` (değişmedi) |
| A5-43 | Ek maliyetler: ekle/sil (W-26-04) | Teklif ekranı | Aynı | 2→2 | KALIR | `PortalPages.tsx:214` |
| A5-44 | Ekler: yükle (PDF/PNG/JPEG/XML), durum, "İndir" (W-26-05) | Teklif ekranı | Aynı | 2→2 | KALIR | `PortalPages.tsx` (değişmedi) |
| A5-45 | "Teklifi gönder" / "Yeni sürüm gönder"; alındı bandı, bağlantı koptu uyarısı, hata özeti (W-26-06) | Teklif ekranı | Aynı | 2→2 | KALIR | `PortalPages.tsx:187`, `:248` |
| A5-46 | Yan panel: Değerlendirme kriterleri ve ağırlıkları, teslimat tarihi, "Gönderimlerim" (W-26-07) | Teklif ekranı | Aynı | 2→2 | KALIR | `PortalPages.tsx:257-264` |
| A5-47 | Soru ve cevaplar: soru gönder, yanıtları gör (W-26-08) | Teklif ekranı | Aynı | 2→2 | KALIR | `PortalPages.tsx:270` |
| A5-48 | Anketler listesi: "Yanıtla" / "Görüntüle"; boş durum (W-26-09) | `/portal/anketler` | Aynı | 1→1 | KALIR | `PortalPages.tsx` (değişmedi) |
| A5-49 | Anket yanıtlama: yanıt, uygulanamaz gerekçesi, "Yanıtı kaydet", "Değiştir" (W-26-10) | `/portal/anketler/:id` | Aynı | 2→2 | KALIR | `PortalPages.tsx:395-401` |
| A5-50 | "Kuruma gönder" + onay ("Evet, gönder" / "Vazgeç"); eksik yanıtla kapalı (W-26-11) | Anket yanıtlama | Aynı | 2→2 | KALIR | `PortalPages.tsx:354-357` |

### 1.6 iOS: Tedarikçiler ve İşlerim

| id | İşlev | Eski yer | Yeni yer | Dokunuş | Durum | Kanıt |
|---|---|---|---|---|---|---|
| A5-51 | "Olaylar" girişi (en üstte; olay listesi, bildir, ayrıntı, faaliyet tamamlama) | Tedarikçiler sekmesi, ilk bölüm | Aynı yer ve giriş | 1→1 | KALIR | `SuppliersView.swift:19`, `:36` |
| A5-52 | "Ünvan ara" arama alanı | Liste | Aynı; aşama süzgeciyle birlikte çalışır | 1→1 | KALIR | `SuppliersView.swift:39`, `:48` |
| A5-53 | Çevrimdışı bant, yükleniyor/hata (Yeniden dene), çekerek yenile | Liste | Aynı | 0→0 | KALIR | `SuppliersView.swift:17`, `:22`, `:40` |
| A5-54 | Satır: ünvan, durum etiketi (Aday/Aktif/Askıda/…), VKN son hanesi ya da "Vergi kimliği doğrulanmadı" | Liste satırı | Aynı satır `SupplierListRow`; durum yerine aşama etiketi + eski durum ayrıntısı ("Pasif · Askıda") + belge rozeti | 0→0 | DÖNÜŞTÜ | `SuppliersView.swift:76-95` |
| A5-55 | Boş durum: "Tedarikçi yok" / "Eşleşen tedarikçi yok" | Liste | Aynı; süzgeç seçiliyken de "Eşleşen tedarikçi yok" | 0→0 | KALIR | `SuppliersView.swift:28` |
| A5-56 | Satıra dokunma | Satır düz metindi, dokunuş yoktu | Salt okunur tedarikçi özetine gider (yeni işlev N5-44) | 0→1 | KALIR (yalnız eklendi) | `SuppliersView.swift:30` |
| A5-57 | İşlerim: tedarikçi görevleri liste satırı (başlık, neden, önem) | `TasksView` | Aynı satır; `supplier_*` görev türleri için Türkçe tür etiketi eklendi | 1→1 | KALIR | `TasksView.swift` tür etiketleri |
| A5-58 | İşlerim: eski görev türleri (sözleşme sürümü, fatura, olay, belge sürümü, onay adımı, ret, aile, hatırlatıcı) mobilde açılır | `TaskDestination.opensOnMobile` | Aynı liste; yeni `risk_assessment`, `risk_action` ve `supplier_*` kinds eklendi | 1→1 | KALIR | `TasksView.swift:106-113` |

---

## 2. Yeni işlevler (Faz 5)

### 2.1 Web iç kullanıcı

| id | İşlev | Yer | Kanıt |
|---|---|---|---|
| N5-01 | Aşama çipleri ve sayaçlar (Tümü, Başvuru (açık), Aday, Onaylı, Pasif, Reddedildi; URL `asama`) | Tedarikçiler listesi | `SuppliersPage.tsx:57` |
| N5-02 | "Başvuruları incele (N)" düğmesi ve üst yazıda "N başvuru inceleme bekliyor" | Tedarikçiler listesi | `SuppliersPage.tsx:52` |
| N5-03 | Başvuru tablosu (Firma, VKN, Kategoriler, Gönderim, Durum, İncele) ve "doğrulanmamış, onaylanmış, reddedilmiş ve süresi dolmuş başvuruları da göster" kutusu | `?asama=basvuru` | `SuppliersPage.tsx:72-91` |
| N5-04 | Listede "Sorumlu ekip" sütunu ve belge uyarısı etiketleri (Süresi dolmuş / yaklaşan belge) | Tedarikçiler listesi | `SuppliersPage.tsx:99`, `:113-116` |
| N5-05 | Başvuru inceleme sayfası: Başvuru bilgileri, VKN denetim basamağı notu ("firmanın gerçekliğini kanıtlamaz"), "Bu vergi kimliğiyle kayıtlı tedarikçi kartı var" uyarısı, yüklenen belgeler (geçerlilik, dosya denetimi, virüs etiketi, Önizle/İndir), Geçmiş | `/tedarikciler/basvurular/:id` | `SupplierApplicationReview.tsx:58-132` |
| N5-06 | "Onayla (Aday yap)" penceresi (belgeler karta taşınır, portal kullanıcısı davet edilir, görev ayrılığı notu) | Başvuru incelemesi | `SupplierApplicationReview.tsx:143`, `:176` |
| N5-07 | "Eksik belge iste" (belge türü + not) | Başvuru incelemesi | `SupplierApplicationReview.tsx:144`, `:192` |
| N5-08 | "Bağlantıyı yeniden gönder" (geçerli bağlantıda onay, süresi dolmuşta doğrudan; dürüst e-posta durumu) | Başvuru incelemesi | `SupplierApplicationReview.tsx:145`, `:159` |
| N5-09 | "Başvuruyu reddet" (gerekçe ≥10; "Gerekçe başvurana e-postayla iletilir.") | Başvuru incelemesi | `SupplierApplicationReview.tsx:146`, `:213` |
| N5-10 | Kart: Belgeler ve geçerlilik sekmesi (Belge yükle, Yenile, önceki belgeler, Önizle/İndir, eksik/süresi dolmuş zorunlu belge uyarısı) | Kart sekmesi `belgeler` | `SupplierCardV2.tsx:185-195` |
| N5-11 | Kart: Sözleşmeler ve projeler sekmesi (sözleşmeler, projeler ve teklif geçmişi) | Kart sekmesi `sozlesmeler` | `SupplierCardV2.tsx:247`, `:257` |
| N5-12 | Kart: Portal kullanıcıları (ekle/Davet et, Askıya al, Yeniden aç; kartın e-postası yalnız ipucu, otomatik doldurulmaz) | Kart sekmesi `portal` | `SupplierCardV2.tsx:285-308` |
| N5-13 | Kart: Ayrılış kontrol listesi (6 madde, Yapıldı / Uygulanmaz; Uygulanmaz'da gerekçe zorunlu) | Kart sekmesi `ayrilis` | `SupplierCardV2.tsx:321`, `:349-350` |
| N5-14 | Kart: "İletişim ve envanter" paneli (iletişim, adres, hizmet kategorileri, hizmetler, kapsam, sorumlu ekip, tedarikçi yöneticisi, VPN, SLA, çağrı kanalı; Düzenle; 409'da kaydı ezmez) | Kayıt ve onay | `SupplierCardV2.tsx:76-125` |
| N5-15 | Kart: "Skor ve risk" paneli ve "Değerlendirmeler" bağlantısı | Kayıt ve onay | `SupplierCardV2.tsx:152` |
| N5-16 | Kart: "Onaylı yapmadan önce" kutusu (yanıtsız anket, eksik/süresi dolmuş belge; engellemez) | Kayıt ve onay | `SupplierCardV2.tsx:61` |
| N5-17 | Kart başında "Pasife al" ve "Yeniden aç" (gerekçe ≥10; görev ayrılığı notu yalnız pasife alan kişiye; uyarılar: aktif sözleşme, açık tur) | Kart başı | `SupplierDetailPage.tsx:79-84`, `:193-199` |
| N5-18 | Yaşam döngüsü bandı ve arşiv açıklaması | Kart üstü | `SupplierDetailPage.tsx:106-109` |
| N5-19 | Yönetim > Tedarikçi başvurusu (açık/kapalı, kısaltma, hizmet kategorileri, Kopyala/Aç, belge türleri tablosu, Düzenle, Belge türü ekle) | Yönetim sekmesi (Yönetici düzenler; Satınalma salt okur) | `SupplierApplicationSettings.tsx:17-112`, `App.tsx:266` |
| N5-20 | Yönetim > E-posta kutusu (kanal bandı, durum süzgeci, sayfalama, gövde açılır; yalnız Yönetici) | Yönetim sekmesi | `EmailOutboxPage.tsx:30-64`, `App.tsx:267` |
| N5-21 | Proje turu: davet e-postası durumu sütunu (Gönderilmedi / Kuyrukta / Gönderildi / Gönderilemedi) | Proje > Teklifler | `ProjectWorkspace.tsx:404-411` |

### 2.2 Girişsiz sayfalar (web)

| id | İşlev | Yer | Kanıt |
|---|---|---|---|
| N5-22 | Tedarikçi başvuru formu: firma bilgileri, hizmet kategorileri, kategoriye göre zorunlu belge ve sayaç, kabul edilen tür ve sınırlar, gizli tuzak alanı; kapalıyken "Başvuru şu an kabul edilmiyor" (kurum adı dönmez); gönderimden sonra dürüst "E-posta kanalı yapılandırılmadı" notu | `/basvuru/<kısaltma>` | `PublicApplication.tsx:66`, `:204-242`, `:165-167` |
| N5-23 | E-posta doğrulama (belirteç `#` parçasında, sayfada adres çubuğundan silinir; ikinci kullanım "Doğrulanamadı") | `/basvuru/dogrula` | `PublicApplication.tsx:274` |
| N5-24 | Eksik belgeleri tamamlama ("Kurumun notu", yalnız istenen türler; eski bağlantı "Bağlantı geçersiz") | `/basvuru/tamamla` | `PublicApplication.tsx:312-318` |

### 2.3 Web tedarikçi portalı

| id | İşlev | Yer | Kanıt |
|---|---|---|---|
| N5-25 | Özet kartları (açık davet, yanıt bekleyen anket, eksik belge, skor ve seviye) | `/portal` | `PortalV2Pages.tsx:34`, `PortalPages.tsx:24` |
| N5-26 | "Belgelerinizin süresi dolmuş" bandı (Belgelerim bağlantısı) | Teklif ekranı | `PortalV2Pages.tsx:54`, `PortalPages.tsx:175` |
| N5-27 | Tekliflerim (davetler ve gönderilen son teklif, yalnız kendi tutarı) | `/portal/tekliflerim` | `PortalV2Pages.tsx:66-80` |
| N5-28 | Belgelerim (belge türü başına durum, geçerlilik, Yükle / Yenile, önceki belgeler, dosya ve virüs etiketi) | `/portal/belgeler` | `PortalV2Pages.tsx:138-175` |
| N5-29 | Skorum ve risk durumum (skor, seviye ve kaynak, risk aksiyonları, "Sizden beklenenler"; iç gerekçe, not ve kullanıcı adı yok) | `/portal/skorum` | `PortalV2Pages.tsx:195-246` |
| N5-30 | Firma bilgileri (kayıtlı bilgi, iletişim kişisi/telefon/adres düzenleme, 409'da ezmez, "Değişiklik iste") | `/portal/firma` | `PortalV2Pages.tsx:267-339` |
| N5-31 | Davet e-postasındaki bağlantı oturumsuzken girişe düşer, girişten sonra aynı tura döner; başka tedarikçinin tur adresi 404 | `/portal/<roundId>` | `session.tsx:102`, `LoginPage.tsx:130` |

### 2.4 API ve arka plan

| id | İşlev | Yer |
|---|---|---|
| N5-32 | E-posta kanalı (`MAIL_PROVIDER=none|graph`), işçi `email.dispatch` (3 deneme; `SENT`/`FAILED`), ortak `queueEmail` | `apps/api/src/mail/`, `worker.ts` |
| N5-33 | Virüs taraması bağdaştırıcısı (`AV_SCANNER=none|clamav`; `INFECTED` 422, `ERROR` karantina + görev) | `apps/api/src/av/` |
| N5-34 | Başvuru süre dolumu (başvuru başına 24 saatlik iş) ve belge hatırlatma işi (30/7/0 gün, günlük, tenant listesi 052b) | `worker.ts`, `052b_v2_tasks_supplier_scope.sql` |
| N5-35 | Davet e-postası tur onayında (portal kullanıcısı başına tek satır); pasif davetliye e-posta yok, Satınalma görevi | `portal.ts` `queueRoundInvites` |
| N5-36 | R17 / 052b güvenlik: `suppliers` ve `tasks` üzerinde tedarikçi oturumuna RESTRICTIVE `supplier_scope`; `supplier_documents` dar INSERT/UPDATE politikaları | `052_`, `052a_`, `052b_` |

### 2.5 iOS

| id | İşlev | Yer | Kanıt |
|---|---|---|---|
| N5-37 | Aşama süzgeci menüsü (Tümü, Aday, Onaylı, Pasif, Reddedildi; istemci tarafında; `stage` yoksa durumdan türetilir) | Tedarikçiler | `SuppliersView.swift:24-27`, `:46-68` |
| N5-38 | Belge geçerliliği rozeti ("Belge süresi doldu" / "Belge süresi yaklaşıyor"; simge + metin) | Tedarikçiler satırı | `SuppliersView.swift:89-93`, `:97-105` |
| N5-39 | Salt okunur tedarikçi özeti: Genel, Ayrılış (açık madde sayısı), İletişim, Belgeler ve geçerlilik (virüs/karantina etiketi, eksik zorunlu belge), "Düzenleme ve onay işlemleri web uygulamasında yapılır." | Satır → özet | `SupplierSummaryView.swift:20-66` |
| N5-40 | İşlerim: başvuru incelemesi, belge süresi/yenileme/AV hatası, ayrılış, portal kullanıcısı yok, değişiklik isteği görevleri "Bu iş web'de yapılır" bilgi ekranı açar | İşlerim | `TasksView.swift:106-130` |
| N5-41 | İşlerim bilgi ekranından "Tedarikçi özetini gör" (yalnız kayıt tedarikçiyse) | İşlerim | `TasksView.swift:125-127` |

**Yeni satır sayısı: 41** (N5-01..N5-41).

---

## 3. Gerileme kontrolü

Yöntem: her eski satır (A5-01..A5-58) için yeni yerde işlev, giriş, durum ve rol tek tek kod okumasıyla bulundu (Bölüm 1 kanıt sütunu); eski dosyalar `git show 70bf031:<dosya>` ile karşılaştırıldı. Canlı karşılık: persona raporu "Sıfır gerileme gözlemleri" (eski `?durum=` adresleri satırları listeliyor; eski sekmeler Olaylar, Anketler, Performans ağırlıkları ve kart sekmeleri açılıyor; eski portal sayfaları `/portal`, `/portal/anketler`, `/portal/:roundId` aynı; banka bilgisi, Kaynak belgeler, Onay geçmişi, kimlik bölümleri yerinde; 1440 ve 390'da yatay taşma yok), iOS'ta liste, arama, Olaylar girişi ve aşama etiketi (persona akış 5).

Sayım: **58 eski satır: 50 KALIR, 7 DÖNÜŞTÜ, 1 KASITLI DEĞİŞİKLİK; erişilemez kalan 0.** (Taşınan satır yok; dönüşenlerde eski bilginin tamamı aynı ekrandan erişilebilir.) **41 yeni satır.**

**Faz 5'in neden olduğu gerileme: 0**, tek bilinçli davranış değişikliği dışında:

1. **A5-36 (R9) KASITLI DEĞİŞİKLİK:** yeni teklif turuna aday tedarikçi artık davet edilemez. Bu, kullanıcı onaylı kuraldır (D110 R9, analiz §3.3 madde 3). Eski davranış (adayı turda seçmek) kalktı; ama adayı onaylı yapma yolu (ikinci Satınalma kullanıcısı onayı) aynı, ekran nedeni açıkça yazıyor ve açık turlardaki mevcut davetler çalışmaya devam ediyor. Eski `sourcing.test.ts` bu yüzden gerekçe başlığıyla güncellendi; başka eski test değiştirilmedi (diğerleri: `navigation-v2.spec.ts` iki yeni Yönetim sekmesi, `roles.test.ts` tek istisna, `portalV2.test.ts` `ineligible: []`, üç testte başlık `stringMatching`; D110).

Not edilen, gerileme sayılmayanlar:
1. **Durum süzgeci çipleri (A5-12):** beş eski çip yerine altı aşama çipi. Tıklama sayısı artmadı (1→1) ve eski adresler çalışıyor. İnce fark: "Aktif" ile "Koşullu" ve "Askıda" ile "Arşiv" ayrımı artık çipten değil `?durum=` adresinden ya da satırın ikincil metninden yapılır. Eski ayrımı çipten isteyen bir kullanıcı için bu bir daralmadır; çözüm ihtiyaca göre (örneğin Onaylı çipinin altında koşullu süzgeci) sonraki işe bırakıldı. Kullanıcı kararı gerekmiyor ama bilinsin.
2. **Belgeler sütunu (A5-17):** eski sayı aynen duruyor; tedarikçinin kendi belgelerinin sayısı sütunda yok (persona B2). Eski bilgi kaybolmadı; yeni bilgi eksik. API alanı hazır, web gösterimi yapılmadı.
3. **iOS satır dokunuşu (A5-56):** eskiden dokunuş yoktu, şimdi özet açılır; erişim yalnız arttı.
4. **Portal girişi sonrası dönüş (A5-10):** `/portal/...` adresiyle giren kullanıcı artık aynı adrese döner; `/portal` varsayılanı korunur.

Açık kalemler (iş bitmemiştir listesine girer; gerileme değil, doğrulanmamış ya da yapılmamış):
- **EN katmanı:** Faz 5 ekranları sabit Türkçe; TR+EN eksiksiz kuralı için EN yürüyüşü ve çeviri yapılmadı.
- **Web persona düzeltmeleri:** onaylı başvuruda yanlış "bağlanamaz" uyarısı (D1, API `supplierStateMessage` hazır, web göstermiyor), Belgeler sütunu (D2), çift nokta, "Aktif/Onaylı" söz birliği, tekrarlı e-posta durumu, 390'da Aşama sütunu, bilinmeyen portal yolu iletisi (kusur 5–9) kodda yok.
- **NOT_RUN adımlar:** bu belgenin başındaki liste (yeni firmanın kendi girişi, iOS süzgeç seçimi ve İşlerim bilgi ekranı, iOS AX5 özet, Departman iOS, süresi dolmuş bağlantı düğmesi, PDF önizleme görseli, belirteç maskesi).
- **Düzeltme sonrası yeniden yürüyüş:** `2afc224`, `482053b`, `117f7bf`, `f0034b5` canlı yeniden yürünmedi (testler ve e2e geçti; görevlerin raporuna bakınız).
- Gerçek Graph gönderimi, gerçek ClamAV taraması ve gerçek dış firma girişi (Entra B2B) çalışmadı; "çalışıyor" iddiası yalnız dürüst "yapılandırılmadı" durumları ve sahte taşıyıcı testleri için geçerli.
