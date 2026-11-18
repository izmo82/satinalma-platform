# Faz 6 (Yıllık tedarikçi risk değerlendirmesi) işlev envanteri: önce / sonra

Tarih: 18.11.2026. Dal: `v2-sadelestirme`. Kural: SIFIR GERİLEME (global CLAUDE.md, 07.11.2026).

**Önce:** `docs/envanter-faz1.md` Bölüm 2 (M4, M13, M14, R4, R18, R19), 3.1 (W-01-01..09 İşlerim), 3.6 (W-06 tedarikçi listesi), 3.7 (W-07-01..17 tedarikçi kartı ve alt sekmeleri), 3.8 (W-08 değerlendirme detayı), 3.9 (W-09 anket şablonları), 3.10 (W-10 performans ağırlıkları), 3.21 (W-21-01..04 Raporlar), 3.26 (W-26 portal), `docs/envanter-faz3.md` (N-26, N-27 şablonlar), `docs/envanter-faz5.md` (A5-02, A5-32, N5-15, N5-29) ve iOS İşlerim ile Tedarikçiler. Karşılaştırma tabanı `70bf031` (`git show 70bf031:<dosya>`); `SupplierSummaryView.swift` Faz 5'te doğduğundan iOS tabanı Faz 6 öncesi `b2f2a56^`.
**Sonra:** `HEAD` (`0e0c589`) kodu: `apps/web/src/pages/{RiskPages,RiskQuestionsAdmin,AdminPages,SupplierDetailPage,EvaluationPages,WorkPage,PortalV2Pages}.tsx`, `apps/web/src/lib/risk.tsx`, `apps/web/src/App.tsx`, `ios/Satinalma/Satinalma/Features/{RiskAssessmentView,RiskActionView,TasksView,SupplierSummaryView}.swift`. Satır numaraları bu kodundur.

## Doğrulama yöntemi ve sınırı

Satırlar **kod okumasıyla** hazırlandı: her eski satırın yeni yeri `git show 70bf031:<dosya>` ile güncel dosyanın karşılaştırılmasıyla bulundu. Faz 6 aralığında (`98b0a25`, `b2f2a56`, `65824a1`, `c12d846`) değişen dosyalar: web `App.tsx`, `AdminPages.tsx`, `EvaluationPages.tsx`, `PortalV2Pages.tsx`, `SupplierDetailPage.tsx`, `WorkPage.tsx`, `lib/api.ts`, yeni `RiskPages.tsx`, `RiskQuestionsAdmin.tsx`, `lib/risk.tsx`; iOS `TasksView.swift`, `SupplierSummaryView.swift` (3 satır), `Models.swift`, `Info.plist`, yeni `RiskAssessmentView.swift`, `RiskActionView.swift`. `SupplierEvaluation.tsx`, `TemplatesPage.tsx`, `PortalPages.tsx` ve `SuppliersView.swift` Faz 6'da **hiç değişmedi**. `EvaluationPages.tsx` ve `App.tsx` aynı aralıkta Faz 7 tarafından da değişti (Raporlar'daki "Göstergeler / Uyum denetimleri" sekme çubuğu Faz 7'dir, D112; bu belgede yalnız Faz 6'nın eklediği risk kartı anılır).

- **Güncelleme (2026-11-18):** persona yürüyüşü koşuldu (`.superpowers/sdd/2026-11-17-v2-faz6-risk/persona-report.md`): web akış 1–6 (Satınalma, sorumlu departman, başka departmandan aksiyon sahibi, katkıcı departman, Denetçi, tedarikçi portalı) **PASS**; iOS **kısmi** (aksiyonu notla kapatma NOT_RUN: simülatöre metin girilemedi). Eski satırlar yürüyüşte yerinde görüldü (Tedarikçiler bölüm sekmeleri, kart sekmeleri, Yönetim > Şablonlar, Raporlar, portal Skorum; 390 px taşma yok); sıfır gerileme gözlemi: 0 kayıp. EN katmanı yürünmedi. Persona düzeltmeleri (807b43e, 1ef91fe) ve web ardıl işi sonradan yapıldı; son doğrulama (HEAD `7eebc62`, controller, çalışan ajan yokken): domain 391/391, API 830 geçti / 44 atlandı / 0 kaldı, typecheck, web build, iOS temiz derleme (0 kod uyarısı) ve tam web e2e taze migrate + seed edilmiş veritabanında 213 geçti / 0 kaldı / 99 atlandı (1440/1280/390), hepsi PASS.
- Görev raporlarındaki gözlemler (ben yeniden koşmadım): Görev 7'de 1440/390 ekran görüntüleri e2e sırasında incelendi, Görev 8'de simülatörde İşlerim satırı, risk özeti ve tedarikçi özeti görüldü; aksiyon ekranı simülatörde görüldü, ancak not yazıp "Tamamlandı"ya dokunma ve 422 dönem iletisi simülatörde denenmedi (PATCH `curl` ile doğrulandı).
- Kurumun 26 soruluk risk şablonu **verilmedi**: soru seti boş gelir; "soru seti yok" ekranı geliştirme kiracısında yürünemez (sentetik `E2E-SENTETIK` seti yayımlı, D111 controller kararı 9).
- Dil: Faz 6 ekranlarındaki sabit metin Türkçedir; EN katmanı yürünmedi, kod okumasıyla "EN tamam" denmez (açık kalem, Bölüm 3).
- ~~Web'de yapılmamış kalemler~~ **YAPILDI** (cd9c333, 2590e29, ed69440): aksiyon sahibi ekranı "Risk aksiyonlarım", seviye 4 turuncu, `firstReviewablePeriod` tabanı (Bölüm 3).

Durum anlamları: **KALIR** = işlev aynı yerde, aynı dokunuşla, aynı davranışla; **DÖNÜŞTÜ** = aynı yerde ama biçimi/içeriği değişti, eski bilginin tamamı erişilebilir; **TAŞINDI** = yeri değişti, erişim en az eskisi kadar kolay. Dokunuş = sol menüden (web) ya da sekme çubuğundan (iOS) işleve varmak için tıklama/dokunuş.

---

## 1. Eski işlevler (önce → sonra)

### 1.1 Tedarikçiler bölümü ve tedarikçi kartı (web iç kullanıcı)

| id | İşlev | Eski yer | Yeni yer | Dokunuş | Durum | Kanıt (dosya:satır) |
|---|---|---|---|---|---|---|
| A6-01 | Tedarikçiler menü girişi ve görev sayacı (M4); menü 7 giriş | Menü > Tedarikçiler | Aynı; yeni giriş eklenmedi | 1→1 | KALIR | `App.tsx` menü (değişmedi); `navigation-v2.spec.ts` 7 giriş |
| A6-02 | Bölüm sekmeleri sırasıyla Liste, Olaylar, Anketler, Performans ağırlıkları | Tedarikçiler üst sekme çubuğu | Aynı dört sekme aynı adreslerle ve aynı sırayla; **sona** "Risk matrisi" eklendi | 1→1 | KALIR | `App.tsx:92-96` |
| A6-03 | Eski adresler `/olaylar`, `/anketler`, `/performans-agirliklari` yeni yerlerine yönlenir; kiracı değişince `KEEP` listesindeki adres korunur | `App.tsx` | Aynı yönlendirmeler; `KEEP`'e `/tedarikciler/risk`, `/tedarikciler/risk/ice-aktar` eklendi, `/tedarikciler/risk/:id` kiracı değişince `/tedarikciler/risk` listesine döner | 0→0 | KALIR | `App.tsx:60`, `:65`, `:279` |
| A6-04 | Tedarikçi kartı sekmeleri "Kayıt ve onay", "Değerlendirme ve risk", "Olaylar", "Performans karnesi" aynı ad ve `?sekme=` adresiyle; varsayılan "Kayıt ve onay" (W-07) | `/tedarikciler/:id` | Aynı dört sekme aynı adla ve adresle; araya "Yıllık risk" (`?sekme=yillik-risk`) eklendi, varsayılan sekme yine "Kayıt ve onay" | 2→2 | KALIR | `SupplierDetailPage.tsx:17-19`, `:127-128` |
| A6-05 | "Değerlendirme ve risk" sekmesi: değerlendirme listesi (içsel risk, kalan risk), "Değerlendirme başlat" (şablon, kapsam, inceleme tarihi, içsel risk etkenleri), boş durum, "Anket şablonları" bağlantısı (W-07-13, 14; A5-32) | Kart sekmesi | Aynı bileşen (`SupplierEvaluation.tsx` **hiç değişmedi**); üstüne yalnız "Anket riski (içsel/kalan)" alt başlığı eklendi (R14) | 2→2 | KALIR | `SupplierDetailPage.tsx:128` |
| A6-06 | Kart "Olaylar" sekmesi: olay listesi, "Olay bildir", olası mükerrer uyarısı + "Olayı aç" (W-07-15) | Kart sekmesi | Aynı | 2→2 | KALIR | `SupplierDetailPage.tsx:129` (`SupplierEvaluation`, değişmedi) |
| A6-07 | "Performans karnesi" sekmesi: yıl, yıl puanı, önceki yıl, düzeltici faaliyetler, olay ve **kalan risk cezası** (`SCORECARD_RISK_PENALTY`), "Performans incelemesi gir", "Ağırlık kuralları" bağlantısı (W-07-16, 17) | Kart sekmesi | Aynı; karne puanı ve `karne-2026-v2` değişmedi, yeni 1–5 seviye karneye **girmez** (R14) | 2→2 | KALIR | `SupplierEvaluation.tsx:230-237` (değişmedi) |
| A6-08 | Kayıt ve onay sekmesindeki "Skor ve risk" paneli ve "Değerlendirmeler" bağlantısı (N5-15) | Kart > Kayıt ve onay | Aynı; bağlantı "Değerlendirme ve risk" sekmesini açar | 2→2 | KALIR | `SupplierDetailPage.tsx:147` |
| A6-09 | Değerlendirme detayı: başlık, soru listesi, "Yanıt gir/değiştir", yanıt inceleme "Kabul / Bulgu yaz", kanıt belgesi, Sonuç paneli + "Değerlendirmeyi tamamla", "Tedarikçiye gönder", kalan risk kabulü (W-08-01..08) | `/degerlendirmeler/:id` | Aynı sayfa ve rota (`EvaluationPages.tsx` bu bölümlerde değişmedi) | 0→0 | KALIR | `App.tsx:259` |
| A6-10 | Anketler sekmesi: anket şablonu tablosu, "Yeni şablon / sürüm", "Taslağı kaydet", "Yayımla", "Performans ağırlıkları" bağlantısı (W-09-01..04) | Tedarikçiler > Anketler | Aynı; yeni **Risk soruları** ayrı yerdedir (Yönetim > Şablonlar), anket şablonlarıyla karıştırılmadı | 2→2 | KALIR | `App.tsx:237`; `EvaluationPages.tsx` şablon bölümü (değişmedi) |
| A6-11 | Performans ağırlıkları: kategori kuralı ekle/değiştir, etkin ve emekli kurallar (W-10-01, 02) | Tedarikçiler > Performans ağırlıkları | Aynı | 2→2 | KALIR | `App.tsx:238` |
| A6-12 | Olay listesi ve olay detayı `/tedarikciler/olaylar/:id` | Tedarikçiler > Olaylar | Aynı | 2→2 | KALIR | `App.tsx:93`, `:243` |
| A6-13 | Tedarikçi listesi, aşama çipleri, başvuru incelemesi, kart bölümleri (Faz 5: A5-04, N5-01..18) | `/tedarikciler`, `/tedarikciler/:id`, `/tedarikciler/basvurular/:id` | Aynı; yeni rota `/tedarikciler/risk/:id` kartın `:id` rotasından **önce** tanımlı, çakışma yok | 1→1 | KALIR | `App.tsx:240-245` |

### 1.2 Yönetim > Şablonlar (web, Yönetici)

| id | İşlev | Eski yer | Yeni yer | Dokunuş | Durum | Kanıt |
|---|---|---|---|---|---|---|
| A6-14 | Şablon kütüphanesi: tablo, sürümler, indir, .docx yükle, yeni sürüm yükle ve sürüm geçmişi; yönetici ADMIN, PROCUREMENT (N-27, N-27a) | Yönetim > Şablonlar (`/yonetim/sablonlar`) | Aynı adres, **varsayılan** alt sekme "Sözleşme taslakları"; üstüne iki girişli "Şablon türleri" sekme çubuğu eklendi | 2→2 | DÖNÜŞTÜ (aynı sayfa, aynı adres) | `AdminPages.tsx:87-103` |
| A6-15 | Hatırlatıcı süreleri ayarı (1–6 değer, 1–365 gün; yalnız ADMIN; N-26) | Yönetim > Şablonlar | Aynı sayfada, "Sözleşme taslakları" alt sekmesinin içinde | 2→2 | DÖNÜŞTÜ | `TemplatesPage.tsx:171-200` (değişmedi) |
| A6-16 | Sözleşmeler > Şablonlar (`/sozlesmeler/sablonlar`) kütüphanesi (N-27) | Sözleşmeler başlığı "Şablonlar" düğmesi | Aynı sayfa ve düğme; yalnız Yönetim kabuğu değişti | 2→2 | KALIR | `App.tsx:207` (`TemplatesPage.tsx` değişmedi) |

### 1.3 Raporlar (web)

`EvaluationPages.tsx` Faz 6 payı yalnız `RiskReportCard` içe aktarımı ve `ReportsContent` içine tek satırdır; göstergeler tablosu satırı satırına aynı kalır.

| id | İşlev | Eski yer | Yeni yer | Dokunuş | Durum | Kanıt |
|---|---|---|---|---|---|---|
| A6-17 | Dönem süzgeci (başlangıç, bitiş, "Uygula") (W-21-01) | Raporlar | Aynı | 1→1 | KALIR | `EvaluationPages.tsx` `ReportsContent` |
| A6-18 | Gösterge tablosu: gösterge ve tanım, değer, pay/payda, kaynak, "Veri yok" / "Hesaplanmıyor" (W-21-02) | Raporlar | Aynı; üstüne risk matrisi kartı eklendi | 1→1 | KALIR | `EvaluationPages.tsx:486` ve altı |
| A6-19 | "Yeniden hesapla", veri anı ve kapsam notu (W-21-03) | Raporlar | Aynı | 1→1 | KALIR | `EvaluationPages.tsx` `ReportsContent` |
| A6-20 | "CSV indir" (W-21-04) | Raporlar | Aynı | 1→1 | KALIR | `EvaluationPages.tsx` `ReportsContent` |

### 1.4 İşlerim (web)

| id | İşlev | Eski yer | Yeni yer | Dokunuş | Durum | Kanıt |
|---|---|---|---|---|---|---|
| A6-21 | Görünümler "Benden beklenen", "Geciken", "Rolümdeki tüm işler", sayaçlar, "Yenile", tablo, dar ekran kartları, j/k/Enter, "Gecikti", boş durum (W-01-01..09) | İşlerim | Aynı | 1→1 | KALIR | `WorkPage.tsx` (değişiklik yalnız `entityHref`) |
| A6-22 | Görevden kayda geçiş: tedarikçi görevi → kart, `assessment_blocker` / `risk_rereview` / `new_business_hold` → Değerlendirme sekmesi, sözleşme, belge, proje, fatura, olay, onay adımı, hatırlatıcı, ret (W-01-05) | `WorkPage.entityHref` | Aynı hedefler; yeni dal: `entityType === 'risk_assessment'` → `/tedarikciler/risk/:id` (çeyreklik görevde `?donem=` önseçili) | 1→1 | KALIR | `WorkPage.tsx:18`, `:24-38` |

### 1.5 Tedarikçi portalı (web)

| id | İşlev | Eski yer | Yeni yer | Dokunuş | Durum | Kanıt |
|---|---|---|---|---|---|---|
| A6-23 | Portal "Skorum ve risk durumum": skor ve yıl, risk durumu etiketi ve kaynağı, risk puanı, "Sizden beklenenler" (N5-29) | `/portal/skorum` | Aynı üç bölüm aynı sırada; risk bölümünün altına yalnız yeni "Risk aksiyonları" listesi ve yeniden açma notu eklendi | 1→1 | KALIR | `PortalV2Pages.tsx:195-214`, `:233-253` |
| A6-24 | Portal Anketler listesi ve yanıtlama, Teklif davetleri, Tekliflerim, Belgelerim, Firma bilgileri (W-26-01..11, N5-25..30) | Portal menüsü | Aynı | 1→1 | KALIR | `PortalPages.tsx` (değişmedi) |

### 1.6 iOS

| id | İşlev | Eski yer | Yeni yer | Dokunuş | Durum | Kanıt |
|---|---|---|---|---|---|---|
| A6-25 | Sekme çubuğu: İşlerim, Sözleşmeler, Tara, Tedarikçiler, Faturalar | Kök | Aynı | 1→1 | KALIR | `RootViews.swift` (değişmedi) |
| A6-26 | İşlerim: görevden ekrana geçiş (`contract_version` → İmza kontrolü, `invoice`, `incident`, `document_version`, `contract_approval_step`, `contract_rejection`/`contract_family`/`contract_reminder`) (I-01-02) | İşlerim | Aynı sekiz geçiş; iki yeni tür: `risk_assessment`, `risk_action` | 2→2 | KALIR | `TasksView.swift` `TaskDestination` |
| A6-27 | İşlerim: web'de yapılan tedarikçi görevleri "Bu iş web'de yapılır" ekranı (Faz 5) | İşlerim | Aynı | 2→2 | KALIR | `TasksView.swift` `webOnlySupplierKinds` (değişmedi) |
| A6-28 | Tedarikçi özeti: Genel, Ayrılış, İletişim, Belgeler ve geçerlilik, "Düzenleme ve onay işlemleri web uygulamasında yapılır" (Faz 5) | Tedarikçiler > tedarikçi | Aynı bölümler aynı sırada; sona "Yıllık risk" bölümü eklendi | 2→2 | KALIR | `SupplierSummaryView.swift` (+3 satır) |
| A6-29 | Tedarikçiler listesi: aşama etiketi, belge rozeti, aşama süzgeci, arama (Faz 5) | Tedarikçiler | Aynı | 1→1 | KALIR | `SuppliersView.swift` (Faz 6'da değişmedi) |

---

## 2. Yeni işlevler (Faz 6)

### 2.1 Web iç kullanıcı

| id | İşlev | Yer | Kanıt |
|---|---|---|---|
| N6-01 | Risk matrisi: yıl seçici (varsayılan bu yıl), 5×5 matris hücrede sayı, hücreye tıklayınca hücrenin tedarikçileri ve "Seçimi kaldır"; matris tablo başlığıyla erişilebilir etiketli | Tedarikçiler > Risk matrisi (`/tedarikciler/risk`) | `RiskPages.tsx:53-130` |
| N6-02 | Durum sayaçları ve süzgeçleri (Tümü, Açık, Gecikmiş, Tamamlandı, Skorsuz), Seviye 1–5 süzgeci, departman süzgeci; tablo (Tedarikçi, Departman, Kritiklik ve sütun, Risk skoru ve kaynağı, Seviye, Durum, Son tarih, Son gözden geçirme), "Katkıcı: salt okunur, görüş eklenir", açık aksiyon sayısı | Risk matrisi | `RiskPages.tsx:136-190` |
| N6-03 | Departman kullanıcısına "Departmanınızın değerlendirmeleri" notu (yalnız sorumlu olduğu ve yürürlükte sözleşmesi olanlar) | Risk matrisi | `RiskPages.tsx:107-110` |
| N6-04 | "Excel'e aktar" (`BT Tedarikçi Risk Değerlendirme Tablosu {yıl}.xlsx`; ADMIN, PROCUREMENT, AUDITOR) | Risk matrisi başlığı | `RiskPages.tsx:97`, `:70-74` |
| N6-05 | "Excel'den içe aktar" bağlantısı (ADMIN, PROCUREMENT) | Risk matrisi başlığı | `RiskPages.tsx:98` |
| N6-06 | "Yılı başlat" (yıl açma onay penceresi, sonuç sayıları: açılan, zaten var, atlanan pasif, sorumlu departman seçilecekler; ADMIN, PROCUREMENT) | Risk matrisi başlığı | `RiskPages.tsx:99`, `:75-85`, `:213-218` |
| N6-07 | Değerlendirme formu: yıl ve departman başlığı, durum, son tarih, "Salt okunur" bantları (katkıcı, salt okur, başkasının değerlendirmesi), çeyreklik güncelleme sürüyor bandı, "Kaydet" ve "Tamamla" | `/tedarikciler/risk/:id` | `RiskPages.tsx:242-472` |
| N6-08 | "1. Kritiklik ölçütleri": altı ölçüt 1/3/5 açıklamalı seçenek, canlı kritiklik (tr-TR 2 hane) ve matris sütunu, "Geçen yıl: X" ve "Değişti" işaretleri | Değerlendirme formu | `RiskPages.tsx:259-472`, `lib/risk.tsx` |
| N6-09 | "2. Risk skoru": yayımlı soru seti seçimi, soru başına Evet/Hayır ve ağırlık, canlı skor; set yokken boş durum ("Kurumun Tedarikçi Riski Değerlendirme Şablonu henüz girilmedi"), elle sonuç (0–100) ve zorunlu dayanak notu, "Elle girilen şablon sonucu" etiketi; içe aktarım skoru ve Excel notu ("Excel notu: …") | Değerlendirme formu | `RiskPages.tsx:310-440`, `:474-480` |
| N6-10 | "3. Seviye": 5×5 küçük matriste hücre ve seviye etiketi (Seviye 1 "Kabul edilebilir", 2 ve 3 nötr, 4 "Turuncu", 5 "Kırmızı") | Değerlendirme formu | `RiskPages.tsx` seviye bölümü, `lib/risk.tsx:35` |
| N6-11 | "Tamamlamak için" engel listesi (ölçüt, skor, aksiyon, kontrol, sahip, tarih eksikleri) | Değerlendirme formu | `RiskPages.tsx` `block-h` |
| N6-12 | Aksiyon ve kontrol satırları (seviye 4–5'te zorunlu): tür Aksiyon/Kontrol, kontrol yöntemi (Yerinde, Online, Kanıt kontrolü – masabaşı), sahip (etkin iç kullanıcı), hedef tarih, "Tedarikçi görsün", Tamamlandı/Doğrulandı/İptal + not; başka departmandaki sahip yalnız Tamamlandı + not | Değerlendirme formu | `RiskPages.tsx:503-609` |
| N6-13 | "Sorumlu departmanı seçin" (Satınalma; boş departmanlı kayıt) | Değerlendirme formu | `RiskPages.tsx:481-501` |
| N6-14 | Çeyreklik gözden geçirme: "Değişiklik yok" (tek tık, onay penceresi) ve "Güncelle" (yeniden açar, yeni son tarih); aday dönemler kaydı olmayan çeyrekler, en eski varsayılan, `?donem=` ile görevden önseçili | Değerlendirme formu | `RiskPages.tsx:234-240`, `:611-651` |
| N6-15 | Görüşler (katkıcı departman ve sorumlu; iptal edilmiş değerlendirmeye eklenmez) | Değerlendirme formu | `RiskPages.tsx:653-681` |
| N6-16 | Revizyon geçmişi: kaynak (Soru seti, Elle girilen şablon sonucu, Excel içe aktarımı), yöntem sürümü, değişen alanlar | Değerlendirme formu | `RiskPages.tsx:683-723` |
| N6-17 | Excel içe aktarma ekranı: dosya yükleme (.xlsx), başlık uyumsuzluğunda 422 ve bulunan başlıklar, ölçek notu (kesir → ×100), "Ekip → departman eşlemesi", satır kararı (Atla / mevcut kart / yeni aday), birincil satır, satır sorunları, özet, "Bu dosya daha önce uygulandı" bandı, onaylı "Uygula", "Vazgeç", "Başka dosya yükle" | `/tedarikciler/risk/ice-aktar` | `RiskPages.tsx:725-960` |
| N6-18 | Kartta "Yıllık risk" sekmesi: Yıllık risk seviyesi ve skor, yıl yıl tablo, küçük matriste hücre, açık aksiyonlar, görüşler, "Değerlendirmeyi aç" | Kart > Yıllık risk (`?sekme=yillik-risk`) | `RiskPages.tsx:963-1036`, `SupplierDetailPage.tsx:127` |
| N6-19 | Raporlar'da "Yıllık risk matrisi (yıl)" kartı: küçük matris, seviye sayıları, Skorsuz, Açık / gecikmiş, Tamamlandı, "Risk matrisini aç" (matris okunamazsa kart gizlenir) | Raporlar | `RiskPages.tsx:1039-1058`, `EvaluationPages.tsx:486` |
| N6-20 | Yönetim > Şablonlar > Risk soruları: set listesi (kod, sürüm, durum, soru sayısı), set açılır ayrıntısı, "Yeni soru seti", "Yeni sürüm" (temel alınır), "Taslak olarak kaydet", toplam ağırlık, "Yayımla" (onay penceresi), "Soruyu kaldır / Soru ekle", boş durum ("Kurumun 26 soruluk şablonu henüz girilmedi."), "Değerlendirme son tarihi" ayarı (7–365 gün); Yönetici düzenler, diğerleri salt okur | `/yonetim/sablonlar?sekme=risk-sorulari` | `RiskQuestionsAdmin.tsx:20-176`, `AdminPages.tsx:99` |
| N6-21 | İşlerim'den risk görevi: yıllık, departman seçimi, gecikme yükseltmesi, çeyreklik, seviye 4–5 bilgi görevi → değerlendirme formu | İşlerim | `WorkPage.tsx:24-27` |

### 2.2 Web tedarikçi portalı

| id | İşlev | Yer | Kanıt |
|---|---|---|---|
| N6-22 | "Risk aksiyonları (yıl)": yalnız kurumun "Tedarikçi görsün" işaretlediği aksiyonların başlığı, hedef tarihi ve durumu; "Sizinle paylaşılan risk aksiyonu yok"; güncelleme sürerken son tamamlanmış yılın gösterileceği notu. Ölçüt, soru, cevap, görüş, iç not ve sahip yok | `/portal/skorum` | `PortalV2Pages.tsx:233-253` |

### 2.3 iOS

| id | İşlev | Yer | Kanıt |
|---|---|---|---|
| N6-23 | İşlerim'de yıllık risk görevi (`risk_assessment_due`, `risk_assessment_department`, `risk_assessment_escalated`, `risk_high_level` → "Yıllık risk"; `risk_quarterly_review` → "Çeyreklik risk gözden geçirme") → salt okunur özet | İşlerim | `TasksView.swift` |
| N6-24 | Risk özeti: Genel (tedarikçi, yıl, departman, durum, son tarih), Sonuç (kritiklik tr-TR 2 hane, risk skoru ve kaynağı, seviye, 5×5 matriste hücre, VoiceOver etiketi, Dynamic Type), "Geçen yılla fark", "Aksiyonlar ve kontroller" (sahip, tarih, durum; "İptal" etiketi), "Web'de doldurun" bağlantısı | İşlerim > risk görevi | `RiskAssessmentView.swift:35-200` |
| N6-25 | Çeyreklik "Değişiklik yok (dönem)" (onay iletişim kutusu, `POST …/reviews`; dönem kaydı olmayan çeyreklerden, en eski varsayılan, `firstReviewablePeriod` tabanı; sunucu iletisi olduğu gibi gösterilir; "Güncelleme web'de başlatılır") | Risk özeti | `RiskAssessmentView.swift:100-130` |
| N6-26 | "Risk aksiyonu" ekranı (aksiyon sahibine; görev türü `risk_action_owner`): tedarikçi, yıl, tür, yöntem, açıklama, hedef tarih (gecikmişse kırmızı), durum, not alanı ve "Tamamlandı" (onay: "Bu işlem geri alınamaz; ilgili görev kapanır."), değerlendirme bağlantısı yalnız `assessmentVisible` iken | İşlerim > risk aksiyonu görevi | `RiskActionView.swift` |
| N6-27 | Tedarikçi özetinde "Yıllık risk" bölümü (son tamamlanmış yıl, risk skoru, kritiklik; yoksa "Tamamlanmış yıllık risk değerlendirmesi yok") | Tedarikçiler > tedarikçi | `RiskAssessmentView.swift:267-298` |
| N6-28 | `Info.plist` `SPWebBaseURL` ("Web'de doldurun" bağlantısı için web taban adresi) | Uygulama ayarı | `Info.plist` |

### 2.4 API ve arka plan

| id | İşlev | Kanıt |
|---|---|---|
| N6-29 | Risk soru setleri ve ayarı: `GET/POST /risk/question-sets`, `GET /risk/question-sets/:id`, `POST …/publish`, `GET/PUT /settings/risk` (7–365) | `server.ts:822-832` |
| N6-30 | Değerlendirme: `GET /risk/assessments`, `GET /risk/matrix`, `GET /risk/assessments/:id` (+ `firstReviewablePeriod`, `draft.importNote`), `PUT …/draft`, `POST …/complete`, `POST …/actions`, `PATCH /risk/actions/:id`, `POST …/opinions`, `PUT …/department`, `POST …/reviews`, `GET /suppliers/:id/risk-history`, `GET /portal/risk` | `server.ts:873-915` |
| N6-31 | Aksiyon sahibi: `GET /risk/actions/mine` (dar kapı `app_my_risk_actions()`), `risk_action_owner` görevi (kişisel, İşlerim'de yalnız atanana) | `server.ts:897`; migration 054c |
| N6-32 | Yıllık döngü: `POST /risk/cycles/:year/open`; işçi `risk.annual_open`, `risk.quarterly`, `risk.escalate` sistem işleri (kiracı listesi `risk_cycle_tenants()`, 054b) | `server.ts:917`, `worker.ts:18` |
| N6-33 | Excel: `POST /risk/imports`, `GET/PUT /risk/imports/:id`, `POST …/apply`, `POST …/discard`, `GET /risk/export.xlsx` (yükleme kapısı kapalı başarısız olur; 5.000 satır sınırı) | `server.ts:920-941` |
| N6-34 | Faz 7 için `currentRisk(tx, supplierId, asOf)`; `risk.read/assess/opinion/questions.manage/cycle.manage/import/export` izinleri | `riskAssessments.ts`, `roles.ts:176-182` |

---

## 3. Açık kalemler ve eksik kanıt

- ~~Web: aksiyon sahibi ekranı yok~~ **VAR (cd9c333):** `/tedarikciler/risk/aksiyonlarim` "Risk aksiyonlarım" (`GET /risk/actions/mine`: tedarikçi, yıl, tür, yöntem, başlık, hedef tarih ve gecikti, durum, kapanış); OPEN ve yetkiliyse zorunlu kapanış notuyla "Tamamlandı" (`PATCH /risk/actions/:id`); "Değerlendirmeyi aç" yalnız `assessmentVisible`; `?aksiyon=<id>` kartı vurgular; İşlerim `risk_action_owner` görevini buraya açar (`WorkPage`), görev tür etiketi "Risk aksiyonu (sorumlusu sizsiniz)"; girişler İşlerim ve Risk matrisi başlığında (menüye ayrı giriş yok). Persona akış 3'te görüldü: boş notla "Ne yapıldığını yazın.", notla PATCH 200, görev İşlerim'den düştü, başkasının değerlendirmesi 404. Web'de aksiyon kapatma artık çalışır.
- **Web: seviye 4 rengi (kullanıcı 18.11.2026'da onayladı: turuncu).** Etiket "Turuncu" ve matris hücresi artık turuncu (`--orange`, yaklaşık 5:1 AA; iOS ve portal Skorum da turuncu); Figma 16 ise 4 ve 5'i aynı kırmızı gösterir. Bilinçli sapma, **kullanıcı onayı ya da Figma güncellemesi bekliyor** (D111). Kaybolan işlev yok.
- ~~Web: `firstReviewablePeriod` tabanı~~ **UYGULANDI:** aday dönemler `firstReviewablePeriod` ve sonrasıdır; 422 `period_before_assessment` açık iletiyle gösterilir; taban yüzünden aday kalmayınca "tüm çeyrekler gözden geçirildi" yerine ilk değerlendirmenin tamamlandığı dönemi söyleyen metin (web ve iOS, 1ef91fe, D111 kararı 19).
- ~~Web: kaydedilmiş taslakla "Tamamla" öncesi yenileme, portal yeniden açma notu~~ **YAPILDI:** kaydedilen taslak önce yerleşir (hata ve meşguliyet üstte); API'de yeniden açma alanı olmadığından portal notu nötr ("Gösterilen sonuç, kurumun son tamamladığı yıllık risk değerlendirmesidir"). Persona düzeltmeleri de yapıldı: uygulanmış içe aktarımda gerçek satır sonucu, canlı tamamlama engelleri ve afiş, portal seviye 4 turuncu, tek departman adı, iOS matris kontrastı, notsuz Tamamlandı açıklaması, gecikme işareti (807b43e).
- Kurumun 26 soruluk şablonu verilmedi: skor yalnız sentetik setle ve elle sonuçla sınandı.
- Faz 6 persona yürüyüşü koşuldu (yukarıdaki "Güncelleme"); yürünmeyenler: iOS'ta aksiyonu notla kapatma (simülatöre metin girilemedi), içe aktarımda "Vazgeç", Yönetici soru seti yayımlama ve son tarih ayarı, soru seti olmayan "elle sonuç" yolu; düzeltmeler persona ile yeniden yürünmedi; EN katmanı yürünmedi.
- Tam test koşusu yapıldı: son doğrulama (HEAD `7eebc62`, controller, çalışan ajan yokken): domain 391/391, API 830 geçti / 44 atlandı / 0 kaldı, typecheck, web build, iOS temiz derleme (0 kod uyarısı) ve tam web e2e taze migrate + seed edilmiş veritabanında 213 geçti / 0 kaldı / 99 atlandı (1440/1280/390), hepsi PASS (`docs/implementation-status.md` Faz 6 satırı).
- Gerçek Excel dosyası yalnız ayrıştırıldı (104 satır, 63 tam satır, seviye dağılımı {1: 10, 2: 21, 3: 31, 4: 1}); içe aktarma uygulaması gerçek dosyayla yapılmadı ve dosya repoya kopyalanmadı.
- Risk e-postası (gecikme yükseltmesi) `NOT_CONFIGURED`; gönderilmiş gibi gösterilmez.
- Eski aksiyon atamalarına `risk_action_owner` görevi geri doldurulmadı (görevsiz atamalar `/risk/actions/mine` ile görünür).
- Değiştirilen eski testler (neden D111): `roles.test.ts` (`risk.export` AUDITOR istisnası), `riskAssessments.test.ts` R10 testi ve `riskCycle.test.ts` çeyreklik testi (ilk revizyon test yılına çekilir), `navigation-v2.spec.ts` (Tedarikçiler sekme listesi).

## 4. Sonuç

Eski işlev satırları: **29** (A6-01..A6-29). **KALIR 27**, **DÖNÜŞTÜ 2** (A6-14, A6-15: Yönetim > Şablonlar aynı adreste varsayılan "Sözleşme taslakları" alt sekmesine oturdu, dokunuş sayısı artmadı); **TAŞINDI 0**; **kaybolan ya da erişilmez hale gelen işlev: 0**. Yeni işlev satırları: **34** (N6-01..N6-34). Persona: web PASS, iOS kısmi; bu belge kod okumasıyla hazırlandı, canlı kanıt persona raporundadır. Web ardıl işiyle "Risk aksiyonlarım" ekranı eklendi (yeni işlev, Bölüm 3'te anlatıldı; N6-26'daki iOS ekranının web karşılığı).
