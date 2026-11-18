# Faz 7 (Fatura eşleştirme, uyum denetimi) işlev envanteri: önce / sonra

Tarih: 18.11.2026. Dal: `v2-sadelestirme`. Kural: SIFIR GERİLEME (global CLAUDE.md, 07.11.2026).

**Önce:** `docs/envanter-faz1.md` Bölüm 2 (M3 Projeler, M8 Faturalar, M10 Raporlar, R2, R8), 3.1 (W-01 İşlerim), 3.2 (W-02 Projeler listesi), 3.4 (W-04 proje çalışma alanı), 3.17 (W-17 Faturalar listesi), 3.18 (W-18 fatura detayı), 3.21 (W-21 Raporlar), `docs/envanter-faz3.md` (sözleşme detayı Faturalar sekmesi), `docs/envanter-faz4.md` (fatura tahsisi) ve iOS Faturalar ile İşlerim. Karşılaştırma tabanı `70bf031` (`git show 70bf031:<dosya>`); web için Faz 7 öncesi son durum `482053b`, iOS için `e353fa4^`. Faz 7 web aralığı `482053b..HEAD` (`b15b7bd`, `0e0c589`), iOS aralığı `e353fa4`, `a6ac440`.
**Sonra:** `HEAD` (`7eb343c`) kodu: `apps/web/src/pages/{PurchasingPages,InvoiceMatching,ProjectWorkspace,ComplianceTab,ProjectsPage,RulesPage,ComplianceAudits,EvaluationPages,AdminPages,ContractOverview,ContractWizard,WorkPage}.tsx`, `apps/web/src/lib/labels.ts`, `ios/Satinalma/Satinalma/Features/{InvoiceView,CoiDeclarationView,TasksView}.swift`, `ios/Satinalma/Satinalma/Core/Models.swift`. Satır numaraları bu kodundur.

## Doğrulama yöntemi ve sınırı

Satırlar **kod okumasıyla** hazırlandı: her eski satırın yeni yeri `git show 70bf031:<dosya>` ile ve Faz 7 öncesi sürümle (`git diff 482053b HEAD`, `git diff e353fa4^ HEAD`) güncel dosyanın karşılaştırılmasıyla bulundu. Faz 7 aralığında değişen web dosyaları: `PurchasingPages.tsx`, `ProjectWorkspace.tsx`, `ProjectsPage.tsx`, `AdminPages.tsx`, `EvaluationPages.tsx`, `ContractOverview.tsx`, `ContractWizard.tsx`, `WorkPage.tsx`, `lib/labels.ts`, yeni `InvoiceMatching.tsx`, `ComplianceTab.tsx`, `RulesPage.tsx`, `ComplianceAudits.tsx`; iOS `InvoiceView.swift`, `TasksView.swift`, `Models.swift`, yeni `CoiDeclarationView.swift`. `App.tsx` **değişmedi** (yeni adres gerekmedi). Faz 6 ve Faz 8 işi bu dosyalarda aynı aralıkta olabilir; bu belge yalnız Faz 7 kalemlerini sayar.

- **Güncelleme (2026-11-18):** persona yürüyüşü koşuldu (`.superpowers/sdd/2026-11-17-v2-faz7-fatura-uyum/persona-report.md`): web Satınalma (fatura gir, elle bağla, süre dışı onayı, demo koruması, otomatik eşleşme ve aşım), Yönetici (Satınalma kuralları), proje tamamlama + beyan + uyum denetimi, Denetçi, Departman kullanıcısı ve iOS (fatura, "yok" beyanı) **PASS**. Sıfır gerileme gözlemleri (departman süzgeci, satır tıklaması, ayrıntı bölümleri, tahsis düzenleyici, fatura yükle, proje sekme adresleri, Projeler süzgeçleri, sözleşme özeti) yerinde görüldü. NOT_RUN: iOS "var" beyanı metin girişi, arayüzden kanıt dosyası ve fatura XML yükleme (kanıt API ile yüklendi), PDF'in tarayıcıda diske inişi, gerçek yapay zekâ, EN katmanı; web yürüyüşü 1024 px panelde, 1440 ve 390 ekran görüntüsü ve taşma ölçümüyle. Persona düzeltmeleri (feefc20) ve web ardıl partisi (3580694) sonradan yapıldı; persona ile yeniden yürünmedi; son doğrulama (HEAD `7eebc62`, controller, çalışan ajan yokken): domain 391/391, API 830 geçti / 44 atlandı / 0 kaldı, typecheck, web build, iOS temiz derleme (0 kod uyarısı) ve tam web e2e taze migrate + seed edilmiş veritabanında 213 geçti / 0 kaldı / 99 atlandı (1440/1280/390), hepsi PASS.
- Görev raporlarındaki gözlemler (ben yeniden koşmadım): Görev 7'de yeni `invoice-compliance-v2.spec.ts` 1440 veri değiştiren test ve 1440/1280/390 salt okunur test PASS; Görev 8'de simülatörde fatura listesi, tahsisli ve eşleşmemiş fatura ayrıntısı (AX5 dahil) ve İşlerim beyan akışı ("yok" ve "var") görüldü. Simülatörde görülmeyenler: beyan sayfasının ağ hatası dalı, 4000 karakter sınırı, ayrıntıdaki "Tahsis kontrolü" satır adı değişikliği (yalnız derlendi).
- Tam test koşusu yapıldı: son doğrulama (HEAD `7eebc62`, controller): domain 391/391, API 830 geçti / 44 atlandı / 0 kaldı, typecheck, web build, iOS temiz derleme 0 kod uyarısı, tam web e2e taze veritabanında 213 geçti / 0 kaldı / 99 atlandı; hepsi PASS (`docs/implementation-status.md` Faz 7 satırı).
- Dil: Faz 7 ekranlarındaki sabit metin Türkçedir; EN katmanı yürünmedi, kod okumasıyla "EN tamam" denmez (açık kalem, Bölüm 3).
- Gerçek Anthropic çağrısı yapılmadı (NOT_RUN); uyum raporu "Test sağlayıcısı — gerçek değil" etiketiyle yalnız test sağlayıcısıyla sınandı.

Durum anlamları: **KALIR** = işlev aynı yerde, aynı dokunuşla, aynı davranışla; **DÖNÜŞTÜ** = aynı yerde ama biçimi/içeriği değişti, eski bilginin tamamı erişilebilir; **TAŞINDI** = yeri değişti, erişim en az eskisi kadar kolay. Dokunuş = sol menüden (web) ya da sekme çubuğundan (iOS) işleve varmak için tıklama/dokunuş.

---

## 1. Eski işlevler (önce → sonra)

### 1.1 Faturalar listesi (web) — `/faturalar` — `PurchasingPages.tsx`

| id | İşlev | Eski yer | Yeni yer | Dokunuş | Durum | Kanıt (dosya:satır) |
|---|---|---|---|---|---|---|
| A7-01 | Faturalar menü girişi ve görev sayacı (M8); menü 7 giriş | Menü > Faturalar | Aynı; yeni giriş eklenmedi | 1→1 | KALIR | `App.tsx` menü (değişmedi); `navigation-v2.spec.ts` 7 giriş |
| A7-02 | Başlık eylemleri: "ERP mutabakatı" bağlantısı (Satınalma, Denetçi → Yönetim > Entegrasyonlar), "Fatura yükle" (`/faturalar/yukle`), "Fatura gir" formu (Satınalma) (W-17-06, 08) | Faturalar başlığı | Aynı düğmeler aynı rollerle; yanlarına "Kuyruğu yeniden dene" eklendi (N7-04) | 2→2 | KALIR | `PurchasingPages.tsx:93-97` |
| A7-03 | Fatura tablosu sütunları: Fatura no (+tür, mükerrer "N tekrar geliş"), Tedarikçi (+kayıt durumu notu), Departman, Net, Eşleşme, ERP / ödeme, Tarih (W-17-01) | Liste tablosu | Aynı sütunların hepsi; **sütun sırası değişti**: Fatura no, Tedarikçi, Tarih, Net, [yeni Sözleşme, Proje], Departman, Eşleşme, ERP / ödeme; tür satırına Faz 8 kaynak etiketi eklendi | 1→1 | DÖNÜŞTÜ (sütun sırası; hiçbir bilgi kalkmadı) | `PurchasingPages.tsx:118-125` |
| A7-04 | Eşleşme sütunu: eski tahsis tabanlı çip Eşleşti / Eşleşmedi / Hukuken iptal/ret; v1 karar damgası ("Onaylandı (v1 kaydı)" vb.) | Eşleşme sütunu | Yanıtta v2 eşleşme durumu varken **birincil çip v2 durumudur** (Eşleşti (sözleşmeye bağlı), Tahsisle (eski kayıt), Birden çok sözleşmeye tahsisli, Eşleşmedi); "Hukuken iptal/ret" etiketi her zaman yanında; eski tahsis kontrolü başarısızsa ikincil sönük metin "Tahsis kontrolü: Eşleşmedi"; **eski "Eşleşti" çipi v2 durumu varken gösterilmez** (D112); karar damgası aynen. v2 durumu olmayan yanıtta eski çip aynen | 1→1 | DÖNÜŞTÜ (D112) | `PurchasingPages.tsx:134-142` |
| A7-05 | Durum süzgeci çipleri (URL `durum`): Tümü, Eşleşmedi (`ESLESMEDI`), Eşleşti (`ESLESTI`), Hukuken iptal/ret (`IPTAL`) + sayaçlar (W-17-02) | Süzgeç çubuğu | Tümü aynen; `ESLESMEDI` **aynı URL ve aynı anlamla** "Tahsis kontrolü eksik" adıyla kalır (istemci süzgeci, `!matched`); `IPTAL` aynen; **`ESLESTI` eski anlamıyla kalır** ("Tahsis kontrolü geçti", istemci süzgeci; Faz 7 defteri kararı 17, 3580694); v2 Eşleşti kümesi (bağlı + tahsisle + karma, sunucu `match=MATCHED`) yeni adres `durum=BAGLI` ve çip "Eşleşti (sözleşmeye bağlı)". Yeni çip "Eşleşmedi kuyruğu" (`KUYRUK`). Faz 7 öncesi kayıtlı adresler aynı kümeleri açar | 1→1 | DÖNÜŞTÜ (gerileme riski çözüldü: eski `ESLESTI` anlamı korunuyor) | `PurchasingPages.tsx:40-41`, `:60-68`, `:106` |
| A7-06 | Departman süzgeci (`departmentId` ile sunucu süzgeci) | Süzgeç satırı | Aynı | 1→1 | KALIR | `PurchasingPages.tsx:104` |
| A7-07 | Para birimi süzgeci (URL `para`; yalnız birden çok para birimi varsa) (W-17-03) | Süzgeç satırı | Aynı | 1→1 | KALIR | `PurchasingPages.tsx:109-111` |
| A7-08 | Kolon göster/gizle (URL `gizle`): Tedarikçi, ERP / ödeme, Tarih (W-17-04) | Süzgeç satırı | Aynı üç seçenek; **Sözleşme ve Proje seçenekleri eklendi** | 1→1 | KALIR | `PurchasingPages.tsx:88`, `:113` |
| A7-09 | Kayıtlı görünümler (`page="invoices"`: kaydet, uygula, sil) (W-17-05) | Liste üstü | Aynı; kayıtlı `durum=ESLESMEDI` görünümü **eski anlamını** korur | 1→1 | KALIR | `PurchasingPages.tsx:101` |
| A7-10 | Satır bağlantısı fatura no → `/faturalar/:id`; tedarikçi kaydı durum notu (aday, doğrulanmadı) (D83) | Tablo | Aynı | 1→1 | KALIR | `PurchasingPages.tsx:122`, `:126` |
| A7-11 | Durumlar: yükleniyor, hata ve yeniden dene, boş ("Fatura yok" / "Süzgece uyan fatura yok") | Liste | Aynı; süzgeç seçiliyken de "Süzgece uyan fatura yok" gösterilir | 1→1 | KALIR | `PurchasingPages.tsx:116` |
| A7-12 | Dar ekran: ERP sütunu 900 px altında gizli | Tablo | Aynı; Proje sütunu da 1100 px altında gizli (bilgi Sözleşme sütununda ve detayda) | 1→1 | KALIR | `PurchasingPages.tsx:90`, `:120` |

### 1.2 Fatura detayı (web) — `/faturalar/:id` — `PurchasingPages.tsx`

| id | İşlev | Eski yer | Yeni yer | Dokunuş | Durum | Kanıt (dosya:satır) |
|---|---|---|---|---|---|---|
| A7-13 | Başlık: tür, fatura no, tedarikçi, durum etiketi; Departman, Hukuki durum, ERP durumu, Ödeme, tedarikçi bağlantısı, tekrar geliş uyarısı (W-18-01) | Detay başlığı | Aynı alanlar; durum etiketi v2 desenine döndü (A7-04: birincil v2 durumu, iptal/ret yanında, başarısız tahsis kontrolü ikincil metin) | 1→1 | DÖNÜŞTÜ | `PurchasingPages.tsx:249-258` |
| A7-14 | "Satırlar ve tahsis" tablosu (sipariş/sözleşme bağı ya da "Bağsız") ve satır bulguları (W-18-02) | Sol sütun | Aynı; tahsissiz ama sözleşmeye bağlı faturada "fatura sözleşmeye bütün olarak bağlı" açıklaması eklendi | 1→1 | KALIR | `PurchasingPages.tsx:264`, `:269` |
| A7-15 | "Tahsisi düzenle": sipariş kalemlerini yükle, satır böl, avans mahsubu, "Tahsisi kaydet ve kontrol et" (W-18-03, D84) | Satırlar paneli | Aynı; sunucu 409 `invoice_matched` dönerse ileti "Eşleşme kartındaki “Bağı kaldır” ile gerekçeyle kaldırabilirsiniz." ile uzar (bağlı faturada tahsis, bağ kaldırılmadan yazılamaz) | 2→2 | KALIR | `PurchasingPages.tsx:264`, `:384` (`invoice_matched` iletisi) |
| A7-16 | "Tutar" paneli (net, diğer vergiler, KDV, tevkifat, ödenecek, avans mahsubu, net sonrası), "Kaynak e-Fatura" bağlantısı (W-18-04) | Sağ sütun | Aynı | 1→1 | KALIR | `PurchasingPages.tsx:292-302` |
| A7-17 | UBL-TR kontrol paneli (W-18-05, D81) | Sağ sütun | Aynı | 1→1 | KALIR | `PurchasingPages.tsx:305-309` |
| A7-18 | "Limit · sözleşme" panelleri (tavan, net tüketim, açık taahhüt, kullanılabilir; "Aşım yalnız bilgidir") (W-18-06) | Sağ sütun | Aynı; yanına yeni "Eşleşme" kartı kullanımı eklendi (N7-08) | 1→1 | KALIR | `PurchasingPages.tsx:310-318` |
| A7-19 | Kontrol bulguları (engel/uyarı, çözen rol), kaldırılan bulgu türleri gizli (W-18-07) | Sol sütun | Aynı | 1→1 | KALIR | `PurchasingPages.tsx:246` (`REMOVED_ISSUES`) |
| A7-20 | Karar geçmişi (v1 kaydı: Onaylandı / Reddedildi / İstisna onaylandı) ve ERP son hata (W-18-11) | Sağ sütun | Aynı | 1→1 | KALIR | `PurchasingPages.tsx:322-326` |
| A7-21 | Fatura detayına görevden geçiş (`invoice` görevi → `/faturalar/:id`) | İşlerim | Aynı | 2→2 | KALIR | `WorkPage.tsx:37-38` |

### 1.3 Projeler listesi (web) — `/projeler` — `ProjectsPage.tsx`

| id | İşlev | Eski yer | Yeni yer | Dokunuş | Durum | Kanıt (dosya:satır) |
|---|---|---|---|---|---|---|
| A7-22 | Projeler menü girişi (M3); "Yeni proje" (Satınalma, Departman kullanıcısı) (W-02-01) | Menü > Projeler | Aynı | 1→1 | KALIR | `ProjectsPage.tsx:44` |
| A7-23 | Aşama süzgeci (URL `durum`): Tümü, Taslak, Onayda, Teklife açık, Değerlendirmede, Seçim onayında, Sözleşme aşamasında, İptal, Sonuçsuz + sayaçlar (W-02-04) | Süzgeç çubuğu | Aynı dokuz çip aynı adreslerle; **"Tamamlandı" (`COMPLETED`) eklendi** (Sözleşme aşamasında'dan sonra) | 1→1 | KALIR | `ProjectsPage.tsx:17-18` |
| A7-24 | Tablo: Proje no, Proje (şirket · kategori), Departman, Aşama, Bütçe (+"Bütçe doğrulanmadı"), Kapanış, Teklif sayısı, Sahip, Güncellendi (W-02-05) | Liste | Aynı sütunlar; Aşama'dan sonra **"Uyum puanı" sütunu eklendi** (yalnız `compliance.read` rollerinde) | 1→1 | KALIR | `ProjectsPage.tsx:70-85` |
| A7-25 | Departman süzgeci, kayıtlı görünümler (`page="projects"`), dar ekran kart listesi, boş ve hata durumları (W-02-02, 03, 06, 07) | Liste | Aynı; kartta tamamlanmış projeye "Uyum puanı" satırı eklendi | 1→1 | KALIR | `ProjectsPage.tsx:47-60` |

### 1.4 Proje çalışma alanı (web) — `/projeler/:id` — `ProjectWorkspace.tsx`

| id | İşlev | Eski yer | Yeni yer | Dokunuş | Durum | Kanıt (dosya:satır) |
|---|---|---|---|---|---|---|
| A7-26 | Başlık, durum etiketi, kırıntı, 6 aşamalı ilerleme şeridi, "Sonraki adım" cümlesi (W-04-01) | Üst bölüm | Aynı altı adım aynen; **7. adım "Tamamlandı" eklendi** (şerit 7 sütun; 1100 px altında 4, 640 px altında 2 sütun); CONTRACTING cümlesi tamamlanabilirse "Proje tamamlanabilir." diye uzar | 1→1 | KALIR | `ProjectWorkspace.tsx:193-195`, `:231` |
| A7-27 | Sekmeler (URL `sekme`): Özet, Kalemler, Teklifler, Karşılaştırma, Karar, Sözleşmeler (Faz 3) (W-04-02) | Sekme çubuğu | Aynı altı sekme aynı adreslerle ve aynı sırayla; **sona Faturalar, Beyanlar, Uyum denetimi eklendi** (Faturalar `invoice.read`/`contract.read` ile, Uyum denetimi `compliance.read` ile; yetkiyle gizlenen sekmenin adresi Özet'i açar) | 1→1 | KALIR | `ProjectWorkspace.tsx:190-191`, `:219-220`, `:244-258` |
| A7-28 | Özet: Proje kartı, Teklif turu paneli, Kaynak bulma istisnaları ve "İstisna iste", Tasarruf bazı ve baz kararları (W-04-03, 04, 07, 08) | Özet sekmesi | Aynı; **yalnız yeni COMPLETED durumunda** "İstisna iste" ve baz kararları gizli (var olan hiçbir durumda davranış değişmedi) | 1→1 | KALIR | `ProjectWorkspace.tsx:104`, `:160` |
| A7-29 | Kalemler, Teklifler (davetliler, mühürlü bandı, soru ve cevaplar) (W-04-09..11) | Sekmeler | Aynı (`Lines`, `Bids` değişmedi) | 2→2 | KALIR | `ProjectWorkspace.tsx:251-252` |
| A7-30 | Karşılaştırma ve Karar: kilit ekranı, karşılaştırma tablosu, puanla, kur, değerlendirme sürümü, XLSX/PDF, tahsis öner/onayla, Kurul kararı (W-04-12..20) | Sekmeler | Aynı; karşılaştırma tamamlanmış projede de açıktır (`COMPLETED` listeye eklendi) | 2→2 | KALIR | `ProjectWorkspace.tsx:253-254`, karşılaştırma `useResource` koşulu |
| A7-31 | Sözleşmeler sekmesi: projeye bağlı sözleşmeler, "Bu projeye sözleşme ekle" (Faz 3) | Sekme | Aynı; sözleşme ekleme sihirbazında tamamlanmış proje "kapalı" sayılır (yeni sözleşme seçeneği olarak sunulmaz, kayıtlı bağ görünür kalır) | 2→2 | KALIR | `ProjectWorkspace.tsx:255`; `ContractWizard.tsx` `CLOSED` |
| A7-32 | Eylem geri bildirimi: 409 çakışma uyarısı, başarı bandı (W-04-21) | Üst bölüm | Aynı | 1→1 | KALIR | `ProjectWorkspace.tsx` |

### 1.5 Sözleşme detayı > Faturalar (web) — `/sozlesmeler/aile/:id?sekme=faturalar` — `ContractOverview.tsx`

| id | İşlev | Eski yer | Yeni yer | Dokunuş | Durum | Kanıt (dosya:satır) |
|---|---|---|---|---|---|---|
| A7-33 | Sözleşmeye tahsis edilmiş faturalar tablosu: fatura no, tarih, tutar, para birimi, durum, tedarikçi; boş durum "Bu sözleşmeye tahsis edilmiş fatura yok." | Sözleşme > Faturalar | Aynı alanlar ve aynı boş durum metni; **sütun "Eşleşme" (durum + yöntem) ve "Eşleşen faturalarla kullanım" çubuğu eklendi** | 3→3 | KALIR | `ContractOverview.tsx` `FamilyInvoice`, `usage` |

### 1.6 Yönetim > Satınalma kuralları (web, Yönetici, Satınalma)

| id | İşlev | Eski yer | Yeni yer | Dokunuş | Durum | Kanıt (dosya:satır) |
|---|---|---|---|---|---|---|
| A7-34 | Yönetim sekmesi "Satınalma kuralları" (`/yonetim/satinalma-kurallari`; Yönetici, Satınalma): "Satınalma kuralları kataloğu Faz 7'de gelir" boş durumu | Yönetim sekme çubuğu | Aynı sekme, aynı adres, aynı konum; boş durum yerine gerçek ekran (N7-19..N7-24); sekme artık **Denetçiye de** açık (salt okunur) | 2→2 | DÖNÜŞTÜ (yer tutucu gerçek ekran oldu; Faz 1 kararı gereği) | `AdminPages.tsx:28`, `:~100` (`RulesTab`) |

### 1.7 Raporlar (web) — `/raporlar` — `EvaluationPages.tsx`

| id | İşlev | Eski yer | Yeni yer | Dokunuş | Durum | Kanıt (dosya:satır) |
|---|---|---|---|---|---|---|
| A7-35 | Raporlar menü girişi; Göstergeler ekranı (W-21-01..04: tasarruf, döngü süreleri, uyumluluk, risk matrisi kartı vb.) | Menü > Raporlar | Aynı adres ve **varsayılan** içerik; üstüne iki girişli "Rapor türleri" sekme çubuğu eklendi (Göstergeler, Uyum denetimleri) | 1→1 | DÖNÜŞTÜ (aynı sayfa, aynı adres, varsayılan değişmedi) | `EvaluationPages.tsx:425-451` |

### 1.8 İşlerim (web) — `/islerim` — `WorkPage.tsx`

| id | İşlev | Eski yer | Yeni yer | Dokunuş | Durum | Kanıt (dosya:satır) |
|---|---|---|---|---|---|---|
| A7-36 | Görevden kayda geçiş (`entityHref`): tedarikçi, sözleşme, belge, proje, fatura, olay, sözleşme onay adımı, risk, vb. (W-01-05) | İşlerim satırı ve Enter | Aynı eşleme; **yalnız Faz 7 görev türleri öne alınır** (N7-26); diğer bütün türlerin adresi değişmedi | 2→2 | KALIR | `WorkPage.tsx:30-38` |

### 1.9 iOS

| id | İşlev | Eski yer | Yeni yer | Dokunuş | Durum | Kanıt (dosya:satır) |
|---|---|---|---|---|---|---|
| A7-37 | Faturalar sekmesi: liste (salt okunur), arama "Fatura no veya tedarikçi", eşleşmeyenler önce sonra tarih sırası, yenileme, satır: fatura no, eşleşme metni, tedarikçi, tedarikçi durum notu, "Departman: …", tutar · tarih | Faturalar sekmesi | Aynı sıra, arama ve satırlar; eşleşme metni v2 durum etiketine döndü (hukuken iptal/ret her zaman eski etiketle); yeni "Sözleşme: kod · ad" satırı ve başarısız tahsis için "Tahsis kontrolü: Eşleşmedi" satırı | 1→1 | DÖNÜŞTÜ | `InvoiceView.swift:16-37`, `:45`, `:54` |
| A7-38 | Fatura ayrıntısı: Tür, Tedarikçi, Tedarikçi durumu, Departman, Tarih, Eşleşme, Net, KDV, Vergi dahil, "Kaynak belgeyi aç"; "Satırlar ve eşleştirme"; "Bulgular" (çözen rol); "Karar geçmişi" (v1 kaydı) | Ayrıntı | Aynı bölümlerin hepsi; eski "Eşleşme" satırı v2 bölümü varken **"Tahsis kontrolü" adını alır** (değer aynı); yeni "Eşleşme" bölümü (N7-29). Dipnot "Eşleştirme (tahsis) düzenleme web uygulamasında yapılır." aynen | 2→2 | DÖNÜŞTÜ | `InvoiceView.swift:78-122` |
| A7-39 | İşlerim görev satırı: tür etiketi, önem, "Bu iş web uygulamasında yapılır", görevden fatura ayrıntısı | İşlerim | Aynı; yeni tür etiketleri eklendi (N7-31), `invoice` görevi hâlâ fatura ayrıntısını açar | 2→2 | KALIR | `TasksView.swift:70-90`, `:138` |

---

## 2. Yeni işlevler (Faz 7)

### 2.1 Faturalar (web)

| id | İşlev | Yer | Kanıt |
|---|---|---|---|
| N7-01 | "Eşleşmedi kuyruğu" ve "Eşleşti" çipleri sunucu sayaçlarıyla (`counts`); URL `durum=KUYRUK` (sunucu `match=UNMATCHED`) ve `durum=BAGLI` (sunucu `match=MATCHED`; ilk kayıtta `ESLESTI` yazılmıştı, Ruling 17 ile değişti; `ESLESTI` eski anlamında) | Faturalar | `PurchasingPages.tsx:40-41`, `:60-68` |
| N7-02 | Sözleşme ve Proje sütunları (kod bağlantısı, başlık ipucu; proje bağlantısı projenin Faturalar sekmesini açar); kolon seçicide | Faturalar | `PurchasingPages.tsx:128-131` |
| N7-03 | Satırda "Elle bağla" (yetki `can.match`, durum Eşleşmedi, hukuken alınmış, kararsız) → bağlama çekmecesi | Faturalar | `PurchasingPages.tsx:139-140` |
| N7-04 | "Kuyruğu yeniden dene" (`can.retryQueue`): sonuç bandı "N fatura denendi, N eşleşti, N eşleşmedi, N atlandı" | Faturalar başlığı | `PurchasingPages.tsx:97`, `:73-76` |
| N7-05 | Bağlama çekmecesi: aday sözleşmeler (durum, süre, proje, kullanım, `canLink` / `cannotLinkReason`), `blocked` açıklaması (karar verilmiş, tahsisli, zaten eşleşmiş), tarih aralığı dışı onay kutusu ve 422 `out_of_range_ack_required` onay penceresi, not; 403 `department_forbidden`, 409, 422 sunucu iletisiyle; 409 sonrası adaylar yeniden yüklenir | Faturalar > Elle bağla, fatura detayı | `InvoiceMatching.tsx:61-130` |
| N7-06 | Eşleşme durumu etiketi (Eşleşti, Tahsisle (eski kayıt), Birden çok sözleşmeye tahsisli, Eşleşmedi); ham `ERP_REF`, `MANUAL` kodu görünmez | Liste, detay, sözleşme sekmesi | `InvoiceMatching.tsx:17-21` |
| N7-07 | Fatura girişinde `erpContractRef` ve `erpOrderRef` isteğe bağlı alanları (API; kaynak `MANUAL`); web formunda alan yok | API | `invoices.ts` (`POST /invoices`) |

### 2.2 Fatura detayı (web)

| id | İşlev | Yer | Kanıt |
|---|---|---|---|
| N7-08 | "Eşleşme" kartı: durum, sözleşme ve proje bağlantıları, yöntem ("ERP referansı", "Tedarikçi + tarih", "Elle"; taklit ERP'de "ERP referansı (taklit ERP)"), bağlayan ve zaman, not, ERP sözleşme/sipariş referansları, son otomatik başarısızlık nedeni, kullanım (seviye, uyarı, "kur çevrilmedi" listesi) | Fatura detayı, sağ sütun | `InvoiceMatching.tsx:133-178` |
| N7-09 | "Elle bağla" (kartta) ve "Bağı kaldır" (gerekçe ≥10 karakter; yetki `can.match`, hukuken alınmış fatura) | Eşleşme kartı | `InvoiceMatching.tsx:133-178` |
| N7-10 | Sözleşme kullanımı çubuğu (`role="meter"`): kullanılan / sözleşme tutarı, "Sınıra yakın" (≥%90), "Aşım: X ₺" (>%100) uyarısı; engel değil | Eşleşme kartı, proje Faturalar sekmesi, sözleşme Faturalar sekmesi | `InvoiceMatching.tsx:31-58` |

### 2.3 Projeler (web)

| id | İşlev | Yer | Kanıt |
|---|---|---|---|
| N7-11 | Proje durumu "Tamamlandı" (etiket, çip, 7. aşama); tamamlanmış projede karşılaştırma açık, "İstisna iste" ve baz kararları gizli | Projeler, proje | `labels.ts:98-101`, `ProjectWorkspace.tsx` |
| N7-12 | Tamamlama bandı (Satınalma, CONTRACTING): "Projeyi tamamla" → onay penceresi → `POST /projects/:id/complete`; tamamlanamıyorsa `blockedReason`; 409 iletisi banner; tamamlanınca tarih ve kişi; "Uyum denetimini aç" yalnız `compliance.read` ile | Proje üstü | `ComplianceTab.tsx:21-72` |
| N7-13 | Çıkar çatışması bandı (katılımcı, `canDeclare`, beyan yok): "Çıkar çatışmam yok" tek tık; "Çıkar çatışmam var" açıklama ≥10 karakter olmadan gönderilmez | Proje üstü | `ComplianceTab.tsx:73-117` |
| N7-14 | **Faturalar** sekmesi (`?sekme=faturalar`): sözleşme başına kullanım çubuğu ve aşım/yakınlık uyarısı, fatura listesi, sözleşme yoksa boş durum | Proje | `InvoiceMatching.tsx:180-219` |
| N7-15 | **Beyanlar** sekmesi (`?sekme=beyanlar`): katılımcılar ve rolleri, son beyan, eksik ve çatışma listeleri, yeniden beyan; projeyi okuyan herkese görünür (D112) | Proje | `ComplianceTab.tsx:118-185` |
| N7-16 | **Uyum denetimi** sekmesi (`?sekme=uyum`): puan halkası 0–100, hüküm (Uyumlu / Uyumsuz / Kural yok), sağlayıcı etiketi ("Test sağlayıcısı — gerçek değil" dahil), kural seti sürümü ve yürürlük, tamamlanma tarihi, kural seti notu (yürürlükte set yoksa en eski yayımlı), zorunlu ihlaller, "Özet · Otomatik özet" (yapay zekâ yazdı denmez), kural tablosu (Kural, Tür, Ağırlık, Zorunlu, Sonuç, Bulgu ve alıntılar), PDF indir, "Yeniden denetle" (202, tekrar isteğinde ileti), koşu geçmişi + PDF, sırada/sürüyor bandı (3 sn'de tazelenir), BLOCKED/DEAD → "Denetim işi çalıştırılamadı", yapay zekâ bağlı değil notu; tamamlanmamış projede boş durum | Proje | `ComplianceTab.tsx:186-308` |
| N7-17 | Kanıt yükleme (PDF/PNG/JPEG ≤25 MB; kural, tür, başlık) ve elle işaret (Satınalma; not ≥10 + kanıt belgesi); karantinadaki kanıtta bağlantı yok | Uyum denetimi | `ComplianceTab.tsx:310-388` |
| N7-18 | Projeler listesinde "Tamamlandı" süzgeci ve "Uyum puanı" sütunu (son koşu puanı + hüküm; puan yüklenemezse "Puan yüklenemedi") | Projeler | `ProjectsPage.tsx:17-18`, `:73` |

### 2.4 Yönetim ve Raporlar (web)

| id | İşlev | Yer | Kanıt |
|---|---|---|---|
| N7-19 | Sürüm seçici (Yürürlükte / Taslak / İleri tarihte yürürlüğe girecek / Yerini yenisine bıraktı) ve özet (kural, zorunlu, ağırlık toplamı olduğu gibi; "toplamın 100 olması gerekmez") | Yönetim > Satınalma kuralları | `RulesPage.tsx:30-80` |
| N7-20 | Kural tablosu: Kod, Ad, Kontrol türü (Otomatik (veri), Kanıt + yapay zekâ, Elle), Kapsam, Ağırlık, Zorunlu | Yönetim > Satınalma kuralları | `RulesPage.tsx:80-166` |
| N7-21 | Kural formu: tür, katalog kontrolü (13 anahtar, Türkçe ad), parametreler (ondalıklar metin, tamsayılar sayı; tr-TR "1.000,50" → "1000.50"), yöntemler (Davetli teklif, Tek kaynak), tutar eşiği + para birimi, ağırlık 1–100, zorunlu; 422 `invalid_rule` hata listesi | Yönetim > Satınalma kuralları | `RulesPage.tsx:167-220` |
| N7-22 | "Varsayılan kataloğu yükle" (14 satırlık taslak v1), "Yeni sürüm taslağı (kopya)", kural çıkarma (onaylı), taslak silme düğmesi yok | Yönetim > Satınalma kuralları (Yönetici) | `RulesPage.tsx` |
| N7-23 | "Yayımla": yürürlük tarihi ≥ bugün, geri alınamaz uyarısı (onay penceresi), ileri tarihli set uyarısı, 422 `effective_before_scheduled` iletisi, yanıttaki `rerunQueued` → "N proje yeniden denetlenecek" | Yönetim > Satınalma kuralları (Yönetici) | `RulesPage.tsx` |
| N7-24 | Salt okunur görünüm: "Salt okunur" bandı, düzenleme düğmesi yok (Satınalma, Denetçi) | Yönetim > Satınalma kuralları | `RulesPage.tsx:30-80` |
| N7-25 | Raporlar > "Uyum denetimleri" alt sekmesi (`?sekme=uyum`; menü 7 giriş kalır): hüküm süzgeci (Uyumlu, Uyumsuz, Kural yok, Kural seti yok, Denetim yapılamadı), departman süzgeci, satırdan projenin uyum sekmesine bağlantı, puan, hüküm, kural seti sürümü + not, sağlayıcı etiketi, PDF indir; 390 px'te liste görünümü | Raporlar | `ComplianceAudits.tsx:17-73`; `EvaluationPages.tsx:439-451` |

### 2.5 İşlerim (web)

| id | İşlev | Yer | Kanıt |
|---|---|---|---|
| N7-26 | Görev bağlantıları: `coi_declaration` → proje Beyanlar, `compliance_noncompliant` → proje Uyum denetimi, `compliance_no_ruleset` → Yönetim > Satınalma kuralları, `contract_overrun` → sözleşme Özet, `invoice_unmatched` → fatura. Başlıklar sunucu metni | İşlerim | `WorkPage.tsx:30-38` |

### 2.6 iOS

| id | İşlev | Yer | Kanıt |
|---|---|---|---|
| N7-27 | Fatura listesinde "Sözleşme: kod · ad" satırı (varsa) | Faturalar | `InvoiceView.swift:29-31` |
| N7-28 | Eşleşme etiketi sunucunun `matchStateLabel` değerinden; renk etikete değil duruma bakar (`UNMATCHED` turuncu; kod yoksa eski `matched` bayrağı); hukuken iptal/ret eski etiketle | Faturalar | `InvoiceView.swift:21-27`; `Models.swift` `needsMatchAttention` |
| N7-29 | Fatura ayrıntısında "Eşleşme" bölümü (salt okunur): Durum, Sözleşme, Proje, Yöntem, Not, otomatik başarısızlık nedeni, Kullanım (tutar, seviye, uyarı); dipnot "Elle bağlama web uygulamasında yapılır."; her alan isteğe bağlıdır (eski sunucuda ya da bozuk alanda bölüm yok, liste ve ayrıntı düşmez) | Fatura ayrıntısı | `InvoiceView.swift:92`, `:138-160`; `Models.swift` `MatchInfo`, `Lossy` |
| N7-30 | Çıkar çatışması beyanı ekranı (`coi_declaration` görevi): proje adı, "Çıkar çatışmam yok" / "Çıkar çatışmam var" (açıklama ≥10 karakter, gönder pasif kalır, 4000 üst sınır, VoiceOver ipucu), önceki beyan, yetkisizse açıklama, bilgi alınamazsa hata + "Yeniden dene", başarıda İşlerim yenilenir ve sayfa kapanır | İşlerim > beyan görevi | `CoiDeclarationView.swift` |
| N7-31 | İşlerim tür etiketleri: "Çıkar çatışması beyanı", "Eşleşmeyen fatura", "Sözleşme tutarı aşıldı", "Uyum denetimi: uyumsuz", "Uyum denetimi: kural seti yok" | İşlerim | `TasksView.swift:78-80`, `:110`, `:116` |

### 2.7 API ve arka plan

| id | İşlev | Kanıt |
|---|---|---|
| N7-32 | Şema: `invoices` eşleşme sütunları, `invoice_match_events`, `projects.completed_on/by` + `COMPLETED`, `coi_declarations`, `compliance_evidence`, `procurement_rule_sets`, `procurement_rules`, `compliance_audits`, `compliance_rule_results`, `compliance_manual_marks`, `compliance_ai_cache`; `invoices_match_guard` tetikleyicisi (056a) | migration 055, 056, 056a |
| N7-33 | Eşleştirme: `autoMatchInvoice` (yalnız `auto_match` faturalar; demo faturalar korunur, `demo_invoice_protected`), `GET /invoices?match=`, `GET /invoices/:id` + `match`, `GET /invoices/:id/match-candidates`, `POST|DELETE /invoices/:id/match`, `POST /invoices/match-queue/retry`, `GET /contracts/:id/invoices` (+ `usage`), `GET /projects/:id/invoices` | `invoiceMatching.ts`, `invoices.ts` |
| N7-34 | Aşım görevi `contract_overrun` (ilk aşımda bir kez, sözleşme sorumlusuna; `email_outbox` `NOT_CONFIGURED`), kuyruk görevi `invoice_unmatched`, bağlı faturanın departman ve proje kaymasını önleyen `resyncFamilyInvoices` | `invoiceMatching.ts` |
| N7-35 | Tamamlama ve beyan: `POST /projects/:id/complete`, `GET|POST /projects/:id/coi`, `GET|POST /projects/:id/compliance-evidence`; `coi_declaration` görevi (katılımcı olunca ve tamamlamada) | `projectCompletion.ts` |
| N7-36 | Kural kataloğu: `GET /compliance-checks`, `GET|POST /procurement-rule-sets`, `GET /procurement-rule-sets/:id`, `POST|PUT|DELETE …/rules`, `POST …/publish` (yayımda NO_RULESET projeleri yeniden kuyruğa) | `procurementRules.ts` |
| N7-37 | Uyum denetimi: `GET /projects/:id/compliance`, `POST /projects/:id/compliance-audits` (202), `POST /projects/:id/compliance-marks`, `GET /compliance-audits`, `GET /compliance-audits/:id/pdf`; işçi `compliance.audit` işi; puan ve hüküm kodda; `compliance_noncompliant` ve `compliance_no_ruleset` görevleri | `compliance.ts`, `complianceChecks.ts`, `worker.ts`, `reports.ts` |
| N7-38 | Domain: `matchInvoice`, `contractUsage`, `complianceScore`, `ruleScope`, `validateComplianceRule`, `DEFAULT_RULESET`; izinler `invoice.match`, `project.complete`, `coi.declare`, `rule.read`, `rule.manage`, `compliance.read`, `compliance.run`, `compliance.mark` | `packages/domain/src/{invoiceLinking,compliance,roles}.ts` |

---

## 3. Açık kalemler ve eksik kanıt

1. ~~Eski "Eşleşti" süzgecinin anlamı genişledi (gerileme riski)~~ **ÇÖZÜLDÜ (3580694, Faz 7 defteri kararı 17):** `durum=ESLESTI` eski anlamında ("Tahsis kontrolü geçti", çip "Tahsis kontrolü geçti"); v2 eşleşti kümesi `durum=BAGLI` (çip "Eşleşti (sözleşmeye bağlı)"); `ESLESMEDI`, `IPTAL`, `KUYRUK` aynen. Kayıtlı görünümü `durum=ESLESTI` olan kullanıcı eski kümeyi görür. Kalan ince nokta: v2 durumu olan yanıtta eski "Eşleşti" çipi satırda gösterilmez (D112; bilgi "Tahsis kontrolü geçti" süzgecinde ve başarısızsa ikincil metinde); `invoice-compliance-v2` elle bağlama adımı `BAGLI` adresine alındı.
2. ~~Faturalar listesi 300 satırı geçince kesilir ve ekran bunu söylemez~~ **YAPILDI (3580694):** kesilince "İlk N fatura gösteriliyor (toplam M)" notu çıkar ve istemci çip sayaçları gizlenir; sunucu süzgeçli listede (`KUYRUK`, `BAGLI`) yanlış kesinti notu persona D3 ile düzeltildi (feefc20). Kural tutar eşiğinde tr-TR "1.000" ipucu eklendi (binlik ayracı nokta, ondalık virgül).
3. **Persona yürüyüşü koşuldu** (yukarıdaki "Güncelleme"); NOT_RUN adımları orada. Bulgular D1–D12: D1–D8 ve D10 düzeltildi (feefc20); **düzeltilmeyenler:** D9 (adayda gelecek başlangıçlı sözleşme "Yürürlükte" etiketiyle, Faz 3 etiketi), D11 (`hukum`/`departmentId` URL parametre karışıklığı, yeniden adlandırma kayıtlı bağlantıları kırar), D12 (Departman ve Satınalma sonraki adım metni, rol farkı belirsiz). EN katmanı yürünmedi.
4. **Tam test koşusu ve taze veritabanında e2e yapıldı:** son doğrulama (HEAD `7eebc62`, controller, çalışan ajan yokken): domain 391/391, API 830 geçti / 44 atlandı / 0 kaldı, typecheck, web build, iOS temiz derleme (0 kod uyarısı) ve tam web e2e taze migrate + seed edilmiş veritabanında 213 geçti / 0 kaldı / 99 atlandı (1440/1280/390), hepsi PASS. Görev raporlarında kalan e2e hataları (`purchasing:266`, `contracts-v2:354/:474`, `a11y`, `projects` UX04/UX09, `removed-v2:101`) taze veritabanı tanısında testin birikmiş geliştirme verisine ya da sıraya dayanmasından çıktı; testler kendi verisini kurar hâle getirildi (5937541, Faz 6 defteri kararı 18), ürün gerilemesi değildi.
5. **Gerçek Anthropic çağrısı NOT_RUN;** kanıt okuması yalnız test sağlayıcısıyla sınandı, özet yapay zekâyla yazılmaz.
6. **iOS'ta elle bağlama, bağ kaldırma, proje tamamlama ve uyum raporu yok** (R11; Figma'da iOS çerçevesi yok, bağlama web'de). iOS fatura ayrıntısında eski satırın "Tahsis kontrolü" adı değişikliği simülatörde görülmedi (yalnız derlendi); beyan sayfasında ağ hatası dalı ve 4000 sınırı denenmedi; İşlerim'de `coi_declaration` görevi önem NORMAL olduğundan büyük listede 200'lük sayfa arkasında kalabilir (keşfedilebilirlik).
7. **Departman kullanıcısı Yönetim > Satınalma kuralları ekranını görmez** (API'de `rule.read` var, menü açılmadı); kuralları ekranda gezemez, uyum raporunu ve beyanları proje sekmesinden görür.
8. **Dev işçisi:** 4100'e bağlı iki eski işçi süreci `compliance.audit` işini almıyor; dev'de tamamlanan projelerin raporu için işçinin güncel kodla yeniden başlatılması gerekir (başkasının süreçlerine dokunulmadı).
9. API boşluğu: `GET /projects` uyum puanı döndürmez; Projeler sütunu `/compliance-audits` ile istemcide birleştirilir (sayfasız).
10. Değiştirilen eski testler (neden D112): `apps/web/e2e/purchasing.spec.ts` (tahsis sonrası beklenen etiket "Tahsisle (eski kayıt)", başarısız tahsis kontrolü ikincil metinde: v2 durumu olan yanıtta eski çip gösterilmez) ve `apps/web/e2e/navigation-v2.spec.ts` (Denetçinin Yönetim sekme listesine "Satınalma kuralları" eklendi; "Faz 7'de gelir" boş durumu yerine gerçek ekran). Faz 7 öncesi başka test dosyası değişmedi.
11. Faz 8 arayüzü (ERP ödeme durumu, kaynak etiketleri) bu belgenin kapsamı dışındadır; liste tür satırındaki kaynak etiketi Faz 8'dendir.

## 4. Sonuç

Eski işlev satırları: **39** (A7-01..A7-39). **KALIR 31**, **DÖNÜŞTÜ 8** (A7-03, A7-04, A7-05, A7-13, A7-34, A7-35, A7-37, A7-38; hiçbirinde bilgi kalkmadı); **TAŞINDI 0**; **kaybolan ya da erişilmez hale gelen işlev: 0**, madde 1'deki tek dikkat noktası (eski `durum=ESLESTI` anlamı) 3580694 ile çözüldü: `ESLESTI` eski anlamında, v2 eşleşti kümesi `BAGLI`. Yeni işlev satırları: **38** (N7-01..N7-38). Persona: web ve iOS PASS (NOT_RUN adımları Güncelleme notunda); bu belge kod okumasıyla hazırlandı, canlı kanıt persona raporundadır.
