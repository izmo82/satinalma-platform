# İşlev envanteri: Faz 1 öncesi (v1 mevcut durum)

Tarih: 16.11.2026. Dal: `faz-0-2-ve-dagitim` (HEAD `8a0fa41`). Kaynak: gerçek kod taraması (web `apps/web/src`, iOS `ios/Satinalma/Satinalma/Features`, roller `packages/domain/src/roles.ts`). Kararlar `docs/analiz-v2.md` Bölüm 2 ve 4 ile `docs/devir-v2.md` "Onaylı kaldırma listesi" satırından alındı.

Amaç (sıfır gerileme kuralı): Faz 1 bitince buradaki her satır yeni ekranda tek tek doğrulanır ve kutusu işaretlenir. Kutusu boş kalan satır varsa iş bitmemiştir. **KALKAR** satırlarında doğrulama şudur: ekrandan ve yetkiden çıktı, tablo ve veri duruyor, v1 etiketi var.

Karar kodları: **KALIR** · **SADELEŞİR** · **TAŞINIR** (yeni yeri) · **BİRLEŞİR** · **DÖNÜŞÜR** · **KALKAR (onaylı liste)** · **KARAR GEREKLİ** (onaylı listede yok, analiz tablosunda da açık karşılığı yok; Bölüm 7).

Yöntem notu: küçük sayfalar baştan sona okundu; büyük sayfalarda (ProjectWorkspace, PurchasingPages, EvaluationPages, SignatureWorkspace, GovernancePages, LedgerPages, PortalPages, ContractLifecycle, ContractCommercial, SupplierEvaluation) her düğme, form gönderimi, sekme, süzgeç, bağlantı, boş durum ve API çağrısı satır numarasıyla çıkarıldı; form alanlarının tek tek listesi yalnız okunan bölümlerde verildi. Emin olunamayan yerler Bölüm 8'de.

---

## 1. Özet sayılar

| Ölçü | Sayı | Kaynak |
|---|---|---|
| Web iç kullanıcı sayfa rotası | 29 (+ `/` ve `/portal/*` yönlendirmesi, + `*` "Sayfa bulunamadı") | `App.tsx:155-186` |
| Web tedarikçi portalı sayfa rotası | 4 (+ `*` → `/portal`) | `App.tsx:149-153` |
| Web giriş ekranları (yönlendirici dışı) | 2 (Giriş, OIDC dönüşü) | `App.tsx:56-58` |
| Web menü girişi | 14 (12 iç + 2 portal) | `App.tsx:81-99` |
| Menüde olmayıp düğmeyle ulaşılan iç rota | 8 (`/projeler/onay-politikasi`, `/faturalar/tolerans`, `/faturalar/erp-mutabakati`, `/anketler`, `/performans-agirliklari`, `/ara`, `/belgeler/:id`, `/degerlendirmeler/:id`) | sayfa dosyaları |
| iOS sekme | 4 (İşlerim, Tara, Kayıtlar, Daha fazla) | `RootViews.swift:26-30` |
| iOS ekran / sayfa (sheet dahil) | 13 (Kayıtlar'ın üç listesi ayrı sayılırsa 15) | `Features/*.swift` |
| Rol | 12 | `roles.ts:2-5` |
| Yetki (permission) | 77 | `roles.ts:8-93` |
| API yolu (yalnız `server.ts` içinde sayıldı) | 173 | `apps/api/src/server.ts`; analizde "155" yazıyor, fark doğrulanmadı |

v2 hedefi: 5 rol, 7 menü girişi (İşlerim · Projeler · Sözleşmeler · Tedarikçiler · Faturalar · Raporlar · Yönetim).

---

## 2. Web menü ve rota tablosu

### 2.1 Menü girişleri (eski → v2)

| # | Eski menü girişi | Rota | Görünen roller (`App.tsx`) | Sayaç | v2 kararı | v2 menüdeki yeri |
|---|---|---|---|---|---|---|
| M1 | İşlerim | `/islerim` | tüm iç kullanıcılar (`:85`) | açık görev sayısı | KALIR | İşlerim |
| M2 | Lira Defteri | `/lira-defteri` | BUYER, PROCUREMENT_MANAGER, FINANCE, LEGAL, AUDITOR (`:86`) | `recovery_case` | **KALKAR (onaylı liste)** | yok |
| M3 | Projeler | `/projeler` | REQUESTER, BUYER, PROCUREMENT_MANAGER, TECH_EVALUATOR, FINANCE, SECURITY, AUDITOR, TENANT_ADMIN (`:89`) | `project` | KALIR | Projeler |
| M4 | Tedarikçiler | `/tedarikciler` | REQUESTER, BUYER, PROCUREMENT_MANAGER, TECH_EVALUATOR, LEGAL, FINANCE, SECURITY, MASTER_DATA, AUDITOR (`:90`) | `supplier` | KALIR | Tedarikçiler |
| M5 | Sözleşmeler | `/sozlesmeler` | BUYER, PROCUREMENT_MANAGER, LEGAL, FINANCE, AUDITOR (`:91`) | `contract_version` | KALIR | Sözleşmeler |
| M6 | Belge girişi | `/belge-girisi` | tüm iç kullanıcılar (`:92`) | `document_version` | BİRLEŞİR | Sözleşmeler > "Sözleşme ekle" 1. adım (Yükle). Fatura/teklif/diğer türü için bkz. K-05 |
| M7 | Siparişler | `/siparisler` | REQUESTER, BUYER, PROCUREMENT_MANAGER, FINANCE, AUDITOR (`:93`) | yok | **KALKAR (onaylı liste)** | yok (sipariş ERP'den salt okunur referans; ekranı tanımlı değil, bkz. K-09) |
| M8 | Faturalar | `/faturalar` | BUYER, PROCUREMENT_MANAGER, FINANCE, LEGAL, AUDITOR (`:94`) | `invoice` | SADELEŞİR | Faturalar (liste + eşleştirme kuyruğu) |
| M9 | Olaylar | `/olaylar` | REQUESTER, BUYER, PROCUREMENT_MANAGER, TECH_EVALUATOR, LEGAL, FINANCE, SECURITY, MASTER_DATA, AUDITOR (`:95`) | `incident` | BİRLEŞİR | Tedarikçiler > tedarikçi kartı > "Aksiyon planları" |
| M10 | Raporlar | `/raporlar` | BUYER, PROCUREMENT_MANAGER, FINANCE, AUDITOR (`:96`) | yok | SADELEŞİR | Raporlar (tek pano) |
| M11 | Yapay zekâ | `/yapay-zeka` | TENANT_ADMIN, AUDITOR, PROCUREMENT_MANAGER (`:97`) | `tenant` | DÖNÜŞÜR | Yönetim > Yapay zekâ |
| M12 | Veri yönetimi | `/veri-yonetimi` | LEGAL, TENANT_ADMIN, AUDITOR (`:98`) | `disposal_batch`, `tenant_export` | **KALKAR (onaylı liste)**: saklama, yasal bekletme, imha. Dışa aktarım sekmesi TAŞINIR | Dışa aktarım: Yönetim (alt giriş adı belirsiz, bkz. K-03) |
| M13 | Teklif davetleri (portal) | `/portal` | tedarikçi portalı oturumu (`:82`) | yok | KALIR | Portal: Teklif davetleri |
| M14 | Anketler (portal) | `/portal/anketler` | tedarikçi portalı oturumu (`:83`) | yok | KALIR | Portal: Anketler |

### 2.2 Menüde olmayan rotalar

| # | Rota | Sayfa | Nereden açılır | v2 kararı | v2'deki yeri |
|---|---|---|---|---|---|
| R1 | `/projeler/yeni` | ProjectWizard | Projeler > "Yeni proje" | SADELEŞİR | Projeler > proje oluşturma (tedarikçi seçimi ve davet eklenir) |
| R2 | `/projeler/:id` | ProjectWorkspace | proje satırı | SADELEŞİR | Proje detayı (Özet, Teklifler, Değerlendirme, Sözleşmeler, Faturalar, Uyum denetimi) |
| R3 | `/projeler/onay-politikasi` | ApprovalPolicyPage | Projeler > "Onay politikası" | **KALKAR (onaylı liste)** | yok (sabit üç onaycı; Yönetim > Onaycılar yeni ekran) |
| R4 | `/tedarikciler/:id` | SupplierDetailPage | tedarikçi satırı | KALIR | Tedarikçi kartı |
| R5 | `/belgeler/:id` | DocumentPage | Belge girişi sonucu, tedarikçi belgeleri, fatura, değerlendirme kanıtı, imha partisi, görev | KARAR GEREKLİ (K-05) | Sözleşme için: sözleşme detayı "Belge" sekmesi |
| R6 | `/sozlesmeler/:id` | ContractPage (4 sekme) | sözleşme satırı | KALIR | Sözleşme detayı (Özet, Belge, İnceleme, Onaylar, İmzalar, Faturalar, Hatırlatıcılar, Geçmiş) |
| R7 | `/siparisler/:id` | PurchaseOrderPage | sipariş satırı, fatura tahsisi, olay | **KALKAR (onaylı liste)** | yok |
| R8 | `/faturalar/:id` | InvoicePage | fatura satırı | SADELEŞİR | Fatura detayı (salt okunur + eşleştirme) |
| R9 | `/faturalar/tolerans` | ToleranceRulesPage | Faturalar > "Tolerans kuralları" | **KALKAR (onaylı liste)** | yok |
| R10 | `/faturalar/erp-mutabakati` | ErpReconciliationPage | Faturalar > "ERP mutabakatı" (FINANCE, AUDITOR) | DÖNÜŞÜR | Yönetim > Entegrasyonlar (özellik başına kayıt) |
| R11 | `/ara` | SearchPage | üst çubuk araması | KALIR | üst çubuk |
| R12 | `/lira-defteri/:id` | RecoveryCasePage | bulgu satırı, görev | **KALKAR (onaylı liste)** | yok |
| R13 | `/olaylar/:id` | IncidentPage | olay satırı, karne, görev | BİRLEŞİR | Tedarikçi kartı > Aksiyon planları |
| R14 | `/degerlendirmeler/:id` | AssessmentPage | Tedarikçi > Değerlendirme ve risk sekmesi | KALIR | Tedarikçi > Anketler ve risk |
| R15 | `/anketler` | TemplatesPage | Tedarikçi > Değerlendirme sekmesi > "Anket şablonları" (3 dokunuş) | KALIR | Tedarikçi > Anketler ve risk (dokunuş sayısı artmamalı) |
| R16 | `/performans-agirliklari` | PerformanceWeightsPage | Anketler > "Performans ağırlıkları"; performans formu bağlantısı | KALIR | Tedarikçi > Anketler ve risk |
| R17 | `/veri-yonetimi/imha/:id` | DisposalBatchPage | imha partisi satırı, görev | **KALKAR (onaylı liste)** | yok |
| R18 | `/portal/:id` | PortalRound | portal davet satırı | KALIR | Portal: teklif verme |
| R19 | `/portal/anketler/:id` | PortalAssessment | portal anket satırı | KALIR | Portal: anket doldurma |
| R20 | `*` | NotYetPage "Sayfa bulunamadı" | bilinmeyen adres | KALIR | aynı |

---

## 3. Web: sayfa sayfa işlev tablosu

Sütunlar: # · işlev · dosya:satır · v2 kararı · v2'deki yeri · doğrulama.

### 3.0 Kabuk (Shell) ve oturum — `App.tsx`, `ui/TopBar.tsx`, `pages/LoginPage.tsx`

| # | İşlev | Dosya:satır | v2 kararı | v2'deki yeri | ✓ |
|---|---|---|---|---|---|
| W-00-01 | Oturum kapısı: OIDC dönüşü, "Oturum açılıyor", giriş ekranı, kabuk | `App.tsx:54-60` | KALIR | Giriş (Entra) | [ ] |
| W-00-02 | Kurumsal giriş düğmesi "Kurumsal hesapla giriş yap" + kimlik sağlayıcı adı | `LoginPage.tsx:63-77` | KALIR | Giriş (Entra) | [ ] |
| W-00-03 | Giriş hata durumları: "Erişim verilmedi", "Yeniden giriş gerekiyor", "Oturum hizmetine ulaşılamadı" + Tekrar dene | `LoginPage.tsx:50-56` | KALIR | Giriş | [ ] |
| W-00-04 | OIDC dönüşü: "Oturum doğrulanıyor", hata + "Giriş ekranına dön" | `LoginPage.tsx:79-99` | KALIR | Giriş | [ ] |
| W-00-05 | Geliştirme girişi: 15 sentetik kullanıcı seçimi (`POST /api/v1/dev/session`), yalnız `mode !== 'oidc'` | `LoginPage.tsx:10-26, 101-141` | KALIR (yalnız geliştirme); kullanıcı listesi 5 yeni role göre güncellenir | Giriş (dev) | [ ] |
| W-00-06 | Giriş ekranı kanıt kökeni açıklaması (İnsan kararı / Kural ile doğrulandı / Otomatik öneri) | `LoginPage.tsx:40-47` | KALIR | Giriş | [ ] |
| W-00-07 | "Ana içeriğe geç" atlama bağlantısı; rota değişince ana içeriğe odak | `App.tsx:76, 103` | KALIR | kabuk | [ ] |
| W-00-08 | Kiracı seçici (aktif kiracı); detaydayken kiracı değişince modül listesine dönüş | `App.tsx:71-75, 107-111` | KALIR (analiz Karar 10: altyapı kalsın) | kabuk | [ ] |
| W-00-09 | Ana menü, rol bazlı görünürlük, aktif giriş vurgusu, giriş başına bekleyen iş sayacı (`GET /api/v1/tasks?view=mine`) | `App.tsx:78-99, 114-130` | SADELEŞİR (14 → 7 giriş, 5 rol) | yeni menü | [ ] |
| W-00-10 | Kullanıcı adı ve rol etiketleri (sol alt) | `App.tsx:131-135` | KALIR (yeni rol adlarıyla) | kabuk | [ ] |
| W-00-11 | Çıkış düğmesi (masaüstü sol alt + ≤900px üstte); çıkış hatası bandı + "Tekrar dene" | `App.tsx:112, 134, 142-143` | KALIR | kabuk | [ ] |
| W-00-12 | "Şirket kapsamı" üst bandı (erişilen şirketler / "Tedarikçi portalı" / "Şirket belgesi erişimi yok") | `App.tsx:100, 138-139` | KALIR (departman kapsamı eklenir) | kabuk | [ ] |
| W-00-13 | Genel arama kutusu (en az 2 karakter → `/ara?q=`), portalda gizli | `TopBar.tsx:11-22`, `App.tsx:140` | KALIR | üst çubuk | [ ] |
| W-00-14 | Bildirim zili: okunmamış sayacı, panel, bildirime tıklayınca kayda gitme, "Tümünü görüldü say" (`POST /api/v1/notifications/seen`), "Bütün işler" bağlantısı, boş durum, Esc/dışarı tıkla kapatma | `TopBar.tsx:27-70` | KALIR (kalkan kayıt türlerine giden bağlantılar ayıklanır) | üst çubuk | [ ] |
| W-00-15 | Çevrimdışı bandı ("Çevrimdışısınız…") | `App.tsx:144` | KALIR | kabuk | [ ] |
| W-00-16 | Tedarikçi/iç kullanıcı rota ayrımı: karşı tarafın adresi kendi ana sayfasına döner | `App.tsx:148-156` | KALIR | kabuk | [ ] |
| W-00-17 | "Sayfa bulunamadı" ekranı | `App.tsx:186`, `NotYetPage.tsx` | KALIR | kabuk | [ ] |
| W-00-18 | Dar ekran (≤900px) yatay kaydırmalı menü ve üst bant düzeni | `App.tsx:102-115` | KALIR | kabuk | [ ] |
| W-00-19 | Kayıtlı görünümler bileşeni: kaydet, uygula, sil (`/api/v1/saved-views`); şu an yalnız Projeler ve Faturalar'da kullanılıyor | `ui/SavedViews.tsx:13-48`; `ProjectsPage.tsx:31`; `PurchasingPages.tsx:325` | KALIR | Projeler, Faturalar | [ ] |

### 3.1 İşlerim — `/islerim` — `pages/WorkPage.tsx`

API: `GET /api/v1/tasks?view=mine|overdue|all`.

| # | İşlev | Dosya:satır | v2 kararı | v2'deki yeri | ✓ |
|---|---|---|---|---|---|
| W-01-01 | Görünüm sekmeleri: "Benden beklenen", "Geciken", "Rolümdeki tüm işler" + sayaçlar | `WorkPage.tsx:22, 52-59` | KALIR | İşlerim | [ ] |
| W-01-02 | "Yenile" düğmesi | `WorkPage.tsx:49` | KALIR | İşlerim | [ ] |
| W-01-03 | Görev tablosu: Kayıt no, Önem, İş, Neden bekliyor, Sonraki adım, Sorumlu rol, Son tarih, "İşi aç" | `WorkPage.tsx:82-102` | KALIR (sorumlu rol yerine unvan/rol) | İşlerim | [ ] |
| W-01-04 | Dar ekran kart listesi | `WorkPage.tsx:71-81` | KALIR | İşlerim | [ ] |
| W-01-05 | Görevden kayda geçiş (`entityHref`): supplier (+değerlendirme sekmesi), contract_version, document_version, project, invoice, recovery_case, incident, tenant, disposal_batch, tenant_export | `WorkPage.tsx:15-20` | DÖNÜŞÜR: recovery_case ve disposal_batch hedefleri kalkar; incident → tedarikçi kartı; tenant → Yönetim > Yapay zekâ | İşlerim | [ ] |
| W-01-06 | Klavye: j/k satır seçer, Enter açar; açıklama satırı | `WorkPage.tsx:32-45, 103-106` | KALIR | İşlerim | [ ] |
| W-01-07 | "Gecikti" etiketi, "Son tarih yok", "Açıldı …" | `WorkPage.tsx:97, 114-118` | KALIR | İşlerim | [ ] |
| W-01-08 | Kanıt kökeni açıklama satırı | `WorkPage.tsx:60-66` | KALIR | İşlerim | [ ] |
| W-01-09 | Durumlar: yükleniyor, hata + yeniden dene, boş ("Bekleyen işiniz yok" / "Geciken işiniz yok") | `WorkPage.tsx:67-68` | KALIR | İşlerim | [ ] |

### 3.2 Projeler listesi — `/projeler` — `pages/ProjectsPage.tsx`

API: `GET /api/v1/projects`.

| # | İşlev | Dosya:satır | v2 kararı | v2'deki yeri | ✓ |
|---|---|---|---|---|---|
| W-02-01 | "Yeni proje" düğmesi (REQUESTER, BUYER, PROCUREMENT_MANAGER) | `ProjectsPage.tsx:24, 28` | KALIR (v2: Satınalma) | Projeler | [ ] |
| W-02-02 | "Onay politikası" düğmesi (herkese görünür) | `ProjectsPage.tsx:27` | **KALKAR (onaylı liste)** | yok | [ ] |
| W-02-03 | Kayıtlı görünümler (`page="projects"`) | `ProjectsPage.tsx:31` | KALIR | Projeler | [ ] |
| W-02-04 | Aşama süzgeci (URL `durum`): Tümü, Taslak, Onayda, Teklife açık, Değerlendirmede, Seçim onayında, Sözleşme aşamasında, İptal, Sonuçsuz + sayaçlar | `ProjectsPage.tsx:15-16, 32-35` | SADELEŞİR (v2 akışı: Taslak → Teklif toplama → Değerlendirme → Kazanan seçildi → Sözleşme → Tamamlandı; "Onayda"/"Seçim onayında" bkz. K-01) | Projeler | [ ] |
| W-02-05 | Tablo: Proje no, Proje (şirket · kategori), Aşama, Bütçe (+"Bütçe doğrulanmadı"), Kapanış, Teklif sayısı, Sahip, Güncellendi; satırdan detaya geçiş | `ProjectsPage.tsx:50-72` | KALIR (departman sütunu/süzgeci eklenir) | Projeler | [ ] |
| W-02-06 | Dar ekran kart listesi | `ProjectsPage.tsx:41-49` | KALIR | Projeler | [ ] |
| W-02-07 | Durumlar: yükleniyor, hata, boş ("Henüz proje yok" / "Bu aşamada proje yok"; role göre metin) | `ProjectsPage.tsx:36-38` | KALIR | Projeler | [ ] |

### 3.3 Yeni proje sihirbazı — `/projeler/yeni` — `pages/ProjectWizard.tsx`

API: `POST /api/v1/projects`.

| # | İşlev | Dosya:satır | v2 kararı | v2'deki yeri | ✓ |
|---|---|---|---|---|---|
| W-03-01 | 5 adım: İhtiyaç, Kalemler, Bütçe, Kriterler, Özet; önceki adıma tıklayarak dönüş | `ProjectWizard.tsx:18, 112-122` | SADELEŞİR (v2 zorunlu alanlar: ad, departman, konu/kapsam, yöntem, tahmini tutar + para birimi, teklif son tarihi; tedarikçi seçimi eklenir) | Proje oluşturma | [ ] |
| W-03-02 | Adım 1: Alıcı şirket, Proje adı, Kategori, İhtiyaç açıklaması, Teslimat yeri, İhtiyaç tarihi | `ProjectWizard.tsx:127-139` | SADELEŞİR | Proje oluşturma | [ ] |
| W-03-03 | Adım 2: kalemler (Lot, açıklama, Birim, Miktar, Teknik şartname), Kalem ekle/sil | `ProjectWizard.tsx:140-156` | KARAR GEREKLİ (K-02: kalem/lot yapısı v2 zorunlu alanlarında yok) | — | [ ] |
| W-03-04 | Adım 3: Bütçe, Para birimi, "Bütçe finans tarafından doğrulandı" kutusu, Maliyet merkezi | `ProjectWizard.tsx:157-167` | SADELEŞİR (tahmini tutar + para birimi; "finans doğruladı" kutusu ve maliyet merkezi bkz. K-02) | Proje oluşturma | [ ] |
| W-03-05 | Adım 4: değerlendirme kriterleri (Kod, Kriter, Tür Fiyat/Puan, Ağırlık), Kriter ekle/sil, toplam 100 denetimi, tam bir fiyat kriteri kuralı | `ProjectWizard.tsx:168-185, 71-79` | SADELEŞİR (v2: teknik ve ticari puan) | Proje oluşturma / Değerlendirme | [ ] |
| W-03-06 | Adım 5: özet + "Projeyi oluştur" | `ProjectWizard.tsx:186-202` | KALIR | Proje oluşturma | [ ] |
| W-03-07 | Adım başına doğrulama, hata özeti bandı, ilk hatalı alana odak | `ProjectWizard.tsx:55-90, 123-125` | KALIR | Proje oluşturma | [ ] |
| W-03-08 | Taslağın bu cihazda otomatik saklanması (localStorage) + "Taslak bu cihazda kaydedildi" | `ProjectWizard.tsx:32-48, 109` | KALIR | Proje oluşturma | [ ] |
| W-03-09 | "Geri", "Devam", "Taslağı at" | `ProjectWizard.tsx:200-204` | KALIR | Proje oluşturma | [ ] |
| W-03-10 | Sunucu hatası bandı | `ProjectWizard.tsx:196` | KALIR | Proje oluşturma | [ ] |

### 3.4 Proje çalışma alanı — `/projeler/:id` — `pages/ProjectWorkspace.tsx`

API: `GET /api/v1/projects/:id` ve aşağıdaki uçlar.

| # | İşlev | Dosya:satır | v2 kararı | v2'deki yeri | ✓ |
|---|---|---|---|---|---|
| W-04-01 | Başlık, durum etiketi, kırıntı, 6 aşamalı ilerleme şeridi, "Sonraki adım" cümlesi | `ProjectWorkspace.tsx:177-215` | KALIR (v2 aşamalarıyla) | Proje detayı | [ ] |
| W-04-02 | Sekmeler (URL `sekme`): Özet, Kalemler, Teklifler, Karşılaştırma, Karar | `ProjectWorkspace.tsx:174, 216-218` | DÖNÜŞÜR (v2 sekmeleri: Özet, Teklifler, Değerlendirme, Sözleşmeler, Faturalar, Uyum denetimi) | Proje detayı | [ ] |
| W-04-03 | Özet: Proje kartı (no, kategori, bütçe + doğrulama etiketi, maliyet merkezi, teslimat yeri, ihtiyaç tarihi, ihtiyaç) | `ProjectWorkspace.tsx:244-262` | KALIR | Proje detayı > Özet | [ ] |
| W-04-04 | Özet: Teklif turu paneli; tedarikçi seç + kapanış tarihi ile "Yayın onayına gönder" (`POST /projects/:id/rounds`); yeni tur açma | `ProjectWorkspace.tsx:271-281, 310-327` | DÖNÜŞÜR (tedarikçi seçimi proje oluşturmaya taşınır; davet e-postası eklenir) | Proje oluşturma / Özet | [ ] |
| W-04-05 | Tur yayın onayı: "Yayını onayla" / "Geri gönder" (`POST /rfq-rounds/:id/decision`), politika adımları (ApprovalSteps), "Yayını siz başlattınız" görev ayrılığı | `ProjectWorkspace.tsx:51-72, 292-302` | KARAR GEREKLİ (K-01) | — | [ ] |
| W-04-06 | "Turu şimdi kapat" (gerekçeli, `POST /rfq-rounds/:id/close`) | `ProjectWorkspace.tsx:306` | KALIR (analizde ayrıca anılmıyor; teklif akışının parçası) | Proje detayı | [ ] |
| W-04-07 | Özet: Kaynak bulma istisnaları; "İstisna iste" (tek kaynak, gerekçe ≥20 karakter, tedarikçi seçimi; `POST /projects/:id/exceptions`), istisna kararı (`POST /sourcing-exceptions/:id/decision`) | `ProjectWorkspace.tsx:137-170` | SADELEŞİR | Proje oluşturma: satınalma yöntemi seçeneği + gerekçe alanı | [ ] |
| W-04-08 | Özet: Tasarruf bazı paneli; baz öner (`POST /projects/:id/savings-baselines`), "Bazı onayla" / "Reddet" (`POST /savings-baselines/:id/decision`) | `ProjectWorkspace.tsx:83-133` | KARAR GEREKLİ (K-04) | — | [ ] |
| W-04-09 | Kalemler sekmesi: kalem tablosu, değerlendirme kriterleri + revizyon, "Yayın sonrası değişiklikler" geçmişi | `ProjectWorkspace.tsx:336-357` | KARAR GEREKLİ (K-02; v2'de Kalemler sekmesi yok) | — | [ ] |
| W-04-10 | Teklifler sekmesi: davet edilen tedarikçiler tablosu, tedarikçi kartına bağlantı, "kapanışa kadar mühürlü" bandı, boş durum | `ProjectWorkspace.tsx:359-378` | KALIR | Proje detayı > Teklifler | [ ] |
| W-04-11 | Teklifler: Soru ve cevaplar; "Yanıtla ve yayınla" (`POST /rfq-questions/:id/answer`) | `ProjectWorkspace.tsx:380-405` | KALIR | Proje detayı > Teklifler | [ ] |
| W-04-12 | Karşılaştırma: tur kapanmadan kilit ekranı; teklif karşılaştırma tablosu (`GET /projects/:id/comparison`) | `ProjectWorkspace.tsx:411-495` | KALIR | Proje detayı > Değerlendirme | [ ] |
| W-04-13 | Karşılaştırma: teklif eki indirme (`GET /bid-files/:id/content`) | `ProjectWorkspace.tsx:448` | KALIR | Değerlendirme | [ ] |
| W-04-14 | Karşılaştırma: kriter bazında "Puanla" formu (puan + kanıt; `POST /bids/:id/scores`) | `ProjectWorkspace.tsx:486, 497-503` | KALIR (v2: Departman kullanıcısı / Satınalma) | Değerlendirme | [ ] |
| W-04-15 | Karşılaştırma: "Kur varsayımı" formu, elle kur (`POST /projects/:id/fx-rates`) | `ProjectWorkspace.tsx:507-515` | KARAR GEREKLİ (K-06; TCMB değil, proje içi elle kur) | — | [ ] |
| W-04-16 | Karşılaştırma: "Değerlendirme sürümü oluştur" (`POST /projects/:id/evaluations`) | `ProjectWorkspace.tsx:520` | KALIR | Değerlendirme | [ ] |
| W-04-17 | Karar: değerlendirme sürümleri listesi, "XLSX rapor" ve "PDF karar özeti" indirme | `ProjectWorkspace.tsx:557-575` | KALIR (dışa aktarım analizde anılmıyor; teyit K-07) | Değerlendirme | [ ] |
| W-04-18 | Karar: "Kazanan tahsisi öner" formu (`POST /projects/:id/awards`), kalem bazlı tahsis | `ProjectWorkspace.tsx:604-637` | KALIR (kazanan + gerekçe; en düşük seçilmediyse gerekçe zorunlu) | Değerlendirme | [ ] |
| W-04-19 | Karar: tahsis onayı "Tahsisi onayla" / "Geri gönder" (`POST /awards/:id/decision`), politika adımları, "Bu öneriyi siz yaptınız", "Dayanak eskidi" | `ProjectWorkspace.tsx:583-598` | KARAR GEREKLİ (K-01) | — | [ ] |
| W-04-20 | Karar: onaylanan tahsis görünümü ("Kurul kararı" ıstampası) | `ProjectWorkspace.tsx:646-670` | KALIR | Değerlendirme | [ ] |
| W-04-21 | İşlem geri bildirimi: 409 çakışma uyarısı, başarı bandı | `ProjectWorkspace.tsx:232-241` | KALIR | Proje detayı | [ ] |

### 3.5 Onay politikası — `/projeler/onay-politikasi` — `pages/ApprovalPolicyPage.tsx`

API: `/api/v1/approval-policies` (GET, POST, `/:id/activate`, `/simulate`). Yetki: `approval.policy.manage` (PROCUREMENT_MANAGER, TENANT_ADMIN).

| # | İşlev | Dosya:satır | v2 kararı | v2'deki yeri | ✓ |
|---|---|---|---|---|---|
| W-05-01 | Politika sürümleri listesi, durum etiketi, kural tablosu | `ApprovalPolicyPage.tsx:26-91` | **KALKAR (onaylı liste)** | yok | [ ] |
| W-05-02 | Yeni sürüm taslağı: kural ekle/çıkar, adım ekle/sil, tutar aralığı/kategori/şirket, "Taslağı kaydet" | `ApprovalPolicyPage.tsx:41-48, 92-128` | **KALKAR (onaylı liste)** | yok | [ ] |
| W-05-03 | "Yayınla" (başka yetkili yayınlar) | `ApprovalPolicyPage.tsx:58` | **KALKAR (onaylı liste)** | yok | [ ] |
| W-05-04 | Senaryo simülasyonu ("Simüle et") | `ApprovalPolicyPage.tsx:132-156` | **KALKAR (onaylı liste)** | yok | [ ] |

### 3.6 Tedarikçiler listesi — `/tedarikciler` — `pages/SuppliersPage.tsx`

API: `GET /api/v1/suppliers?status=&q=`.

| # | İşlev | Dosya:satır | v2 kararı | v2'deki yeri | ✓ |
|---|---|---|---|---|---|
| W-06-01 | Durum süzgeci (URL `durum`): Tümü, Aday havuzu, Aktif, Askıda, Reddedilen | `SuppliersPage.tsx:14, 33-35` | DÖNÜŞÜR (v2 durumları: Başvuru, Aday, Onaylı, Pasif, Reddedildi) | Tedarikçiler | [ ] |
| W-06-02 | Ünvan veya VKN/TCKN araması (URL `q`) | `SuppliersPage.tsx:36-40` | KALIR | Tedarikçiler | [ ] |
| W-06-03 | Tablo: Ünvan, Durum, Vergi kimliği, Belge sayısı, Dikkat, Kayıt tarihi; satırdan karta geçiş | `SuppliersPage.tsx:45-68` | KALIR | Tedarikçiler | [ ] |
| W-06-04 | "Kimlik incelemesi" dikkat etiketi | `SuppliersPage.tsx:60` | KALIR | Tedarikçiler | [ ] |
| W-06-05 | "Banka doğrulama" dikkat etiketi (`pendingBankChanges`) | `SuppliersPage.tsx:61` | **KALKAR (onaylı liste)** | yok | [ ] |
| W-06-06 | Durumlar: yükleniyor, hata, boş (aday süzgecinde ayrı metin) | `SuppliersPage.tsx:42-43` | KALIR | Tedarikçiler | [ ] |

### 3.7 Tedarikçi detayı — `/tedarikciler/:id` — `pages/SupplierDetailPage.tsx`, `pages/SupplierEvaluation.tsx`

API: `GET /api/v1/suppliers/:id` ve aşağıdaki uçlar.

| # | İşlev | Dosya:satır | v2 kararı | v2'deki yeri | ✓ |
|---|---|---|---|---|---|
| W-07-01 | Başlık: ünvan, durum, ülke · kimlik türü · vergi kimliği / "Kimlik doğrulanmadı" | `SupplierDetailPage.tsx:52-60` | KALIR | Tedarikçi kartı | [ ] |
| W-07-02 | Sekmeler (URL `sekme`): Kayıt ve onay, Değerlendirme ve risk, Olaylar, Performans karnesi | `SupplierDetailPage.tsx:13, 86-91` | DÖNÜŞÜR (v2 kartı: kimlik ve iletişim, belgeler, sözleşmeler, projeler/teklif geçmişi, anket skorları, yıllık risk, aksiyon planları, sorumlu ekip) | Tedarikçi kartı | [ ] |
| W-07-03 | "Kimliği doğrula" (MASTER_DATA; tür VKN/TCKN/Yabancı, vergi kimliği, gerekçe; aynı kimlik varsa birleştirme; `POST /suppliers/:id/identity`) | `SupplierDetailPage.tsx:63, 154-157, 177-195` | KALIR (v2: Satınalma) | Tedarikçi kartı / başvuru inceleme | [ ] |
| W-07-04 | "Ana veri onayı ver" / "Reddet" (gerekçeli; `POST /suppliers/:id/approvals`); kaydı açan onaylayamaz | `SupplierDetailPage.tsx:64-65, 149-153, 162-175` | DÖNÜŞÜR (v2: Satınalma başvuruyu onaylar; görev ayrılığı kuralı bkz. K-08) | Başvuru inceleme | [ ] |
| W-07-05 | "Aktifleştir" (engeller listesi; `POST /suppliers/:id/activate`, `expectedRowVersion`) | `SupplierDetailPage.tsx:38-42, 66-69` | DÖNÜŞÜR (Aday → Onaylı) | Tedarikçi kartı | [ ] |
| W-07-06 | Aday uyarı bandı ("kesin seçim ve ödeme serbest bırakma engelli" + eksik koşullar) | `SupplierDetailPage.tsx:79-83` | KALIR (ödeme ifadesi çıkar) | Tedarikçi kartı | [ ] |
| W-07-07 | Birleştirilmiş kayıt bandı + "Güncel kayda git" | `SupplierDetailPage.tsx:84` | KALIR | Tedarikçi kartı | [ ] |
| W-07-08 | "Kimlik ve kayıt" paneli (ülke, kimlik, kaydı açan, aktivasyon, ret gerekçesi) | `SupplierDetailPage.tsx:94-106` | KALIR | Tedarikçi kartı | [ ] |
| W-07-09 | "Banka bilgisi" paneli: doğrulanmış hesaplar, "Belgede farklı IBAN okundu — doğrulama bekliyor" bandı | `SupplierDetailPage.tsx:108-119` | **KALKAR (onaylı liste)** | yok | [ ] |
| W-07-10 | "Kaynak belgeler" tablosu (belge, belgedeki ünvan, "Ünvan farkı", bağlanma zamanı; belgeye bağlantı) | `SupplierDetailPage.tsx:122-136` | KALIR | Tedarikçi kartı > Belgeler | [ ] |
| W-07-11 | "Onay geçmişi" zaman çizelgesi | `SupplierDetailPage.tsx:138-146` | KALIR | Tedarikçi kartı | [ ] |
| W-07-12 | İşlem geri bildirimi: başarı, 409'da sayfayı yenileme uyarısı, eksik koşullar | `SupplierDetailPage.tsx:44-48, 74-78` | KALIR | Tedarikçi kartı | [ ] |
| W-07-13 | Değerlendirme sekmesi: değerlendirme listesi, "Değerlendirme başlat" (şablon, kapsam, inceleme tarihi, içsel risk etkenleri; `POST /assessments`), boş durum | `SupplierEvaluation.tsx:44-110` | KALIR (v2 yıllık risk yöntemine uyarlanır) | Tedarikçi > Anketler ve risk | [ ] |
| W-07-14 | Değerlendirme sekmesi: "Anket şablonları" bağlantısı | `SupplierEvaluation.tsx:57` | KALIR | Tedarikçi > Anketler ve risk | [ ] |
| W-07-15 | Olaylar sekmesi: tedarikçinin olay listesi, "Olay bildir" formu (`POST /incidents`), olası mükerrer uyarısı + "Olayı aç" | `SupplierEvaluation.tsx:140-188` | BİRLEŞİR | Tedarikçi kartı > Aksiyon planları | [ ] |
| W-07-16 | Performans karnesi sekmesi: yıl seçimi, yıl puanı, önceki yıl, özet, açık düzeltici faaliyetler, olaylar ve puan etkisi (`GET /suppliers/:id/scorecard?year=`) | `SupplierEvaluation.tsx:204-256` | KALIR (analiz "anket skorları" diyor; karne adı geçmiyor, teyit Bölüm 8) | Tedarikçi > Anketler ve risk | [ ] |
| W-07-17 | "Performans incelemesi gir" formu (boyut puanları, kategori ağırlığı; `POST /suppliers/:id/performance-reviews`) + "Ağırlık kuralları" bağlantısı | `SupplierEvaluation.tsx:217, 260-289` | KALIR | Tedarikçi > Anketler ve risk | [ ] |

### 3.8 Değerlendirme detayı — `/degerlendirmeler/:id` — `pages/EvaluationPages.tsx`

API: `GET /api/v1/assessments/:id` ve aşağıdaki uçlar.

| # | İşlev | Dosya:satır | v2 kararı | v2'deki yeri | ✓ |
|---|---|---|---|---|---|
| W-08-01 | Başlık (kapsam, sonuç etiketi), tedarikçiye dönüş kırıntısı | `EvaluationPages.tsx:58-59` | KALIR | Tedarikçi > Anketler ve risk | [ ] |
| W-08-02 | Soru listesi; "Yanıt gir" / "Yanıtı değiştir" (yanıt, uygulanamaz gerekçesi, not, kanıt belgesi; `PUT /assessments/:id/answers/:q`) | `EvaluationPages.tsx:83, 159-182` | KALIR | Anketler ve risk | [ ] |
| W-08-03 | Yanıt inceleme: "Kabul" / "Bulgu yaz" (önem + not; `POST …/answers/:q/review`); yanıtlayan inceleyemez | `EvaluationPages.tsx:84, 144-156` | KALIR (v2 rolü: Satınalma; SECURITY kalkıyor) | Anketler ve risk | [ ] |
| W-08-04 | Kanıt belgesine bağlantı + geçerlilik tarihi | `EvaluationPages.tsx:76` | KALIR | Anketler ve risk | [ ] |
| W-08-05 | "İçsel risk" paneli | `EvaluationPages.tsx:96` | DÖNÜŞÜR (v2: kritiklik skoru, 6 ölçüt, geometrik ortalama) | Yıllık risk değerlendirmesi | [ ] |
| W-08-06 | "Kalan risk" paneli + "Kalan riski kabul et" (seviye, gerekçe ≥20; `POST /assessments/:id/residual`); oluşturan kabul edemez | `EvaluationPages.tsx:99-102, 186-196` | DÖNÜŞÜR (v2: risk seviyesi matristen; seviye 4-5 aksiyon planı zorunlu) | Yıllık risk değerlendirmesi | [ ] |
| W-08-07 | "Sonuç" paneli + "Değerlendirmeyi tamamla" (`POST /assessments/:id/complete`) | `EvaluationPages.tsx:105-112` | KALIR | Anketler ve risk | [ ] |
| W-08-08 | "Tedarikçi portalı" paneli: son tarihle "Tedarikçiye gönder" (`POST /assessments/:id/send-to-supplier`), gönderim durumu | `EvaluationPages.tsx:119-140` | KALIR | Anketler ve risk | [ ] |

### 3.9 Anket şablonları — `/anketler` — `pages/EvaluationPages.tsx`

API: `/api/v1/questionnaire-templates` (GET, POST, `/:id/publish`). Yetki: `questionnaire.manage` (SECURITY, PROCUREMENT_MANAGER).

| # | İşlev | Dosya:satır | v2 kararı | v2'deki yeri | ✓ |
|---|---|---|---|---|---|
| W-09-01 | Şablon tablosu (kod, sürüm, ad, kategori, durum, soru ve kritik soru sayısı), boş durum | `EvaluationPages.tsx:343-372` | KALIR | Tedarikçi > Anketler ve risk | [ ] |
| W-09-02 | "Yeni şablon / sürüm": taslak formu, soru ekle/kaldır, "Taslağı kaydet" (aynı kod = yeni sürüm) | `EvaluationPages.tsx:350, 376-410` | KALIR (v2: sorular ve ağırlıklar yönetici ekranından girilebilir) | Anketler ve risk | [ ] |
| W-09-03 | "Yayımla" (taslak şablon) | `EvaluationPages.tsx:365-366` | KALIR | Anketler ve risk | [ ] |
| W-09-04 | "Performans ağırlıkları" bağlantısı | `EvaluationPages.tsx:351` | KALIR | Anketler ve risk | [ ] |

### 3.10 Performans ağırlıkları — `/performans-agirliklari` — `pages/EvaluationPages.tsx`

API: `/api/v1/performance-weights` (GET, PUT). Yetki: `performance.weights.manage` (PROCUREMENT_MANAGER).

| # | İşlev | Dosya:satır | v2 kararı | v2'deki yeri | ✓ |
|---|---|---|---|---|---|
| W-10-01 | "Kategori kuralı ekle" / "Değiştir": kategori, boyut ağırlıkları (toplam 100), gerekçe, "Yürürlüğe al" | `EvaluationPages.tsx:565-583, 592` | KALIR | Tedarikçi > Anketler ve risk | [ ] |
| W-10-02 | Etkin kurallar tablosu, boş durum ("örnek ağırlık uygulanır"), "Emekli kurallar" açılır listesi | `EvaluationPages.tsx:586-601` | KALIR | Anketler ve risk | [ ] |

### 3.11 Olaylar — `/olaylar`, `/olaylar/:id` — `pages/EvaluationPages.tsx`, `pages/SupplierEvaluation.tsx`

API: `/api/v1/incidents`, `/incidents/:id`, `/incidents/:id/transitions`, `/incidents/:id/actions`, `/corrective-actions/:id/complete|verify`.

| # | İşlev | Dosya:satır | v2 kararı | v2'deki yeri | ✓ |
|---|---|---|---|---|---|
| W-11-01 | Olay listesi; süzgeç Açık / Tümü; tedarikçi sütunu; boş durum | `EvaluationPages.tsx:327-339`; `SupplierEvaluation.tsx:118-137` | BİRLEŞİR | Tedarikçi kartı > Aksiyon planları (kurum geneli liste ihtiyacı bkz. K-10) | [ ] |
| W-11-02 | Olay detayı: başlık, durum, tedarikçi/sözleşme/sipariş bağlantıları, olay metni, şiddet, mükerrer bağlantısı | `EvaluationPages.tsx:232-246` | BİRLEŞİR (sipariş bağlantısı kalkar) | Aksiyon planları | [ ] |
| W-11-03 | Durum geçişleri: Ön incelemeyi başlat, Doğrula, Doğrulanmadı, Mükerrer, İtirazı sonuçlandır, Kapat, Yeniden aç, Tedarikçi itirazını kaydet (not ≥10) | `EvaluationPages.tsx:221-230, 258-294` | BİRLEŞİR (durum makinesinin ne kadarının kalacağı bkz. K-10) | Aksiyon planları | [ ] |
| W-11-04 | Düzeltici faaliyet: ekle (başlık, sorumlu rol, hedef tarih), "Tamamlandı olarak işaretle" (not), "Bağımsız doğrula" | `EvaluationPages.tsx:247-252, 296-324` | BİRLEŞİR (v2: aksiyon sahibi ve tarihi) | Aksiyon planları | [ ] |
| W-11-05 | Zaman çizelgesi ("Önceki kayıtlar değişmez") | `EvaluationPages.tsx:253-257` | BİRLEŞİR | Aksiyon planları / Geçmiş | [ ] |

### 3.12 Sözleşmeler listesi — `/sozlesmeler` — `pages/ContractsPage.tsx`

API: `GET /api/v1/contracts`, `?offset=`.

| # | İşlev | Dosya:satır | v2 kararı | v2'deki yeri | ✓ |
|---|---|---|---|---|---|
| W-12-01 | İmza süzgeci (URL `filtre`): Tümü, İnceleme bekleyen, Görüntü bulunamadı, Tarafı eksik, Belirsiz, Aslı beklenen, İstisnalı + sayaçlar | `ContractsPage.tsx:19-27, 57-60` | KALIR (v2 listesinde onay/bitiş süzgeçleri eklenir; imza süzgeçleri kaybolmamalı) | Sözleşmeler | [ ] |
| W-12-02 | Tablo: Sözleşme (tedarikçi, sürüm, aşama, yöntem), İmza durumu ("Kesinleşti"), Eksik taraf, Otomatik tarama, Fiziksel asıl, Son inceleme | `ContractsPage.tsx:81-100` | KALIR | Sözleşmeler | [ ] |
| W-12-03 | Dar ekran kart listesi | `ContractsPage.tsx:71-80` | KALIR | Sözleşmeler | [ ] |
| W-12-04 | "Daha fazla yükle" sayfalama + "Süzgeç sayıları yüklenen N sözleşmeye göredir" + yükleme hatası | `ContractsPage.tsx:44-51, 103-107` | KALIR | Sözleşmeler | [ ] |
| W-12-05 | Kanıt kökeni açıklama satırı; durumlar: yükleniyor, hata, boş (kısmi yüklemede ayrı metin) | `ContractsPage.tsx:61-68` | KALIR | Sözleşmeler | [ ] |
| W-12-06 | Not: listede "yeni sözleşme" düğmesi yok; sözleşme Belge girişi (tür: Sözleşme) üzerinden oluşuyor | `ContractsPage.tsx:55-56` | BİRLEŞİR | Sözleşmeler > "Sözleşme ekle" (4 adım) | [ ] |

### 3.13 Sözleşme detayı — `/sozlesmeler/:id` — `pages/ContractLifecycle.tsx`, `pages/SignatureWorkspace.tsx`, `pages/ContractCommercial.tsx`

Sekmeler (`ContractLifecycle.tsx:15`): İmza kontrolü (varsayılan), Koşullar ve ihbar, Yükümlülükler, Fiyat, SLA ve teminat.

| # | İşlev | Dosya:satır | v2 kararı | v2'deki yeri | ✓ |
|---|---|---|---|---|---|
| W-13-01 | Dört sekmeli yapı (URL `sekme`) | `ContractLifecycle.tsx:15-33` | DÖNÜŞÜR (v2: Özet, Belge, İnceleme, Onaylar, İmzalar, Faturalar, Hatırlatıcılar, Geçmiş) | Sözleşme detayı | [ ] |
| **İmza kontrolü** | | | | | |
| W-13-02 | Bölünmüş görünüm: PDF görüntüleyici (yakınlaştır/uzaklaştır, sayfa etiketleri, tespit bölgeleri) + yan panel | `SignatureWorkspace.tsx:84-86`; `ui/DocumentViewer.tsx:68-119`; `ui/SplitPanes.tsx` | TAŞINIR | Sözleşme detayı > İmzalar (belge: "Belge" sekmesi) | [ ] |
| W-13-03 | Başlık: sürüm, aşama, imza yöntemi, SHA-256 | `SignatureWorkspace.tsx:88-94` | TAŞINIR | İmzalar / Özet | [ ] |
| W-13-04 | Uyarı bantları: yeni sürüm geldi (+bağlantı), imza görüntüsü bulunamadı, otomatik kontrol yapılamadı, arşivden alınan sözleşme | `SignatureWorkspace.tsx:97-100` | TAŞINIR | İmzalar | [ ] |
| W-13-05 | "Durum" paneli (genel sonuç, türetilmiş) | `SignatureWorkspace.tsx:106-117` | TAŞINIR | İmzalar | [ ] |
| W-13-06 | "Taraflar ve gereksinimler"; "Gereksinim / yöntem" çekmecesi: belge yöntemi + asıl politikası (`PATCH …/signature-policy`), yeni gereksinim (`POST …/signature-requirements`); boş durum | `SignatureWorkspace.tsx:119-124, 375-410` | TAŞINIR (yetki: LEGAL, PROCUREMENT_MANAGER → bkz. K-11) | İmzalar | [ ] |
| W-13-07 | İmza yuvası başına "İncele" formu: karar, gözlenen işaret, gerekçe, sayfa, AI adayı seçimi (`POST …/signature-reviews`, If-Match + belge SHA) | `SignatureWorkspace.tsx:140, 157, 255-307` | TAŞINIR | İmzalar | [ ] |
| W-13-08 | "E-imza doğrula" isteği (`POST …/digital-validation-jobs`) | `SignatureWorkspace.tsx:147-148` | TAŞINIR | İmzalar | [ ] |
| W-13-09 | "Tamamlanmak için" engel listesi | `SignatureWorkspace.tsx:168-175` | TAŞINIR | İmzalar | [ ] |
| W-13-10 | "Otomatik tarama": AI adayları listesi (sayfaya git), "Taramayı çalıştır" (`POST …/signature-analysis-jobs`) | `SignatureWorkspace.tsx:177-193` | TAŞINIR | İmzalar | [ ] |
| W-13-11 | "İstisnalar": "İstisna talep et" çekmecesi (`POST …/signature-exceptions`), "Onayla"/"Reddet" (`POST /signature-exceptions/:id/decision`; karar yalnız LEGAL) | `SignatureWorkspace.tsx:198-210, 310-349` | TAŞINIR (karar veren rol: bkz. K-11) | İmzalar | [ ] |
| W-13-12 | "Fiziksel asıl": "Kayıt ekle" çekmecesi (`POST …/original-custody-events`; yalnız LEGAL) | `SignatureWorkspace.tsx:215-222, 351-373` | TAŞINIR (rol: K-11) | İmzalar | [ ] |
| W-13-13 | "İnceleme geçmişi" | `SignatureWorkspace.tsx:224-233` | TAŞINIR | İmzalar / Geçmiş | [ ] |
| W-13-14 | "Yeni sürüm / zeyilname" çekmecesi: PDF yükle, tür, zeyilnamede tedarikçi ekleme (`POST /documents` + `POST …/versions`) | `SignatureWorkspace.tsx:236, 413-447` | KALIR (analizde ayrıca anılmıyor; "içerik değişirse onay baştan başlar" ile ilişkili) | Sözleşme detayı | [ ] |
| W-13-15 | "İmza kontrolünü kesinleştir" (`POST …/finalize-signature-review`, If-Match; yalnız LEGAL) | `SignatureWorkspace.tsx:238-242` | TAŞINIR (rol: K-11) | İmzalar | [ ] |
| **Koşullar ve ihbar** | | | | | |
| W-13-16 | "Ticari koşullar" görünümü (bedel türü, tutar, para birimi, ödeme, süre, otomatik yenileme, ihbar, limit esası, kur farkı hükmü, kaynak madde, revizyon) + boş durum | `ContractLifecycle.tsx:92-126` | DÖNÜŞÜR (v2 zorunlu/isteğe bağlı alan seti; yapay zekâ önerir, insan kaydeder) | Sözleşme detayı > Özet | [ ] |
| W-13-17 | "Değiştir" / "Koşulları gir" formu, yeni revizyon (`POST /contract-versions/:id/terms`) | `ContractLifecycle.tsx:105, 139, 185-231` | DÖNÜŞÜR | Sözleşme ekle 3. adım / Özet | [ ] |
| W-13-18 | "Hukuk doğrulaması bekleniyor" + "Doğrula" (`POST /contract-terms/:id/verify`; yalnız LEGAL; giren doğrulayamaz) | `ContractLifecycle.tsx:119-121` | KARAR GEREKLİ (K-11) | — | [ ] |
| W-13-19 | "Değişiklik" paneli (önceki revizyona göre fark) | `ContractLifecycle.tsx:129-136` | KALIR | Sözleşme detayı > Geçmiş | [ ] |
| W-13-20 | "İhbar son günü" + uyarı tarihleri; "Kiracı tatil listesi boş" uyarısı | `ContractLifecycle.tsx:145-159` | KALIR (v2: 90/60/30/7 gün; tatil listesi bkz. K-12) | Sözleşme detayı > Hatırlatıcılar | [ ] |
| W-13-21 | "Yenileme kararı": Yenile / Feshet / Yeniden müzakere + gerekçe (`POST …/renewal-decision`; PROCUREMENT_MANAGER) | `ContractLifecycle.tsx:162-180` | DÖNÜŞÜR (v2: yenilenecek / sonlandırılacak / yeni proje açıldı) | Hatırlatıcılar | [ ] |
| **Yükümlülükler** | | | | | |
| W-13-22 | Yükümlülük listesi + dönemler (Bekliyor, Gecikti, Yerine getirildi, Kaçırıldı, Feragat), boş durum | `ContractLifecycle.tsx:235-259` | KALIR | Hatırlatıcılar | [ ] |
| W-13-23 | "Yükümlülük ekle" formu (`POST …/obligations`) | `ContractLifecycle.tsx:276-292` | KALIR | Hatırlatıcılar | [ ] |
| W-13-24 | Dönem "Sonucu kaydet" (sonuç, not, kanıt; `POST /obligations/:id/events`) | `ContractLifecycle.tsx:257-271` | KALIR | Hatırlatıcılar | [ ] |
| **Fiyat, SLA ve teminat** | | | | | |
| W-13-25 | Fiyat revizyonu: "Kural tanımla/değiştir" (endeks, baz, sınırlar; `POST …/price-rules`), boş durum | `ContractCommercial.tsx:49-86` | SADELEŞİR | Sözleşmede bilgi alanı: fiyat artış koşulu | [ ] |
| W-13-26 | Fiyat revizyonu: "Revizyon öner" / "Hesapla ve öner" (`POST /price-rules/:id/revisions`), "Onayla" (`POST /price-revisions/:id/approve`) | `ContractCommercial.tsx:98-115` | SADELEŞİR (hesap motoru kalkar) | bilgi alanı | [ ] |
| W-13-27 | SLA: "SLA ekle" (hedef, kademeler, üst sınır; `POST …/sla-terms`), boş durum | `ContractCommercial.tsx:122-161` | SADELEŞİR | bilgi alanı: SLA ve ceza koşulu | [ ] |
| W-13-28 | SLA: "Dönem ölçümü gir" / "Hesapla ve kaydet" (`POST /sla-terms/:id/measurements`), ölçüm "Doğrula"/"Reddet" (`POST /sla-measurements/:id/decision`) | `ContractCommercial.tsx:181-200` | SADELEŞİR (kredi hesabı kalkar) | bilgi alanı | [ ] |
| W-13-29 | Teminatlar: "Teminat kaydet" (`POST …/guarantees`), "İade et" (`POST /guarantees/:id/return`), boş durum | `ContractCommercial.tsx:210-251` | SADELEŞİR (takip kalkar) | bilgi alanı: teminat | [ ] |

### 3.14 Belge girişi — `/belge-girisi` — `pages/IntakePage.tsx`

API: `POST /api/v1/documents` (multipart).

| # | İşlev | Dosya:satır | v2 kararı | v2'deki yeri | ✓ |
|---|---|---|---|---|---|
| W-14-01 | Yükleme formu: Şirket, Belge türü (Fatura, Sözleşme, Teklif, Diğer), Dosya (PDF/PNG/JPEG/XML, 25 MB), "Yükle" | `IntakePage.tsx:43-57` | BİRLEŞİR (tür: Sözleşme) | Sözleşme ekle 1. adım (proje seçimi zorunlu) | [ ] |
| W-14-02 | Fatura / Teklif / Diğer türünde belge yükleme | `IntakePage.tsx:45-46` | KARAR GEREKLİ (K-05) | Fatura için: Faturalar (analiz Karar 9 önerisi: elle ekleme yedek) | [ ] |
| W-14-03 | "Belge yükleyebileceğiniz şirket yok" durumu | `IntakePage.tsx:39` | KALIR | Sözleşme ekle | [ ] |
| W-14-04 | Sonuç: işlem mesajı, karantina, tekrar yükleme (aynı dosya yeni kayıt açmaz), antivirüs notu, "Belgeyi aç" | `IntakePage.tsx:66-72` | BİRLEŞİR (v2: aynı dosya uyarısı) | Sözleşme ekle 1. adım | [ ] |
| W-14-05 | Sonuç: tedarikçi eşleşme bandı, ünvan farkı, benzer isim önerileri, "Tedarikçiyi aç" | `IntakePage.tsx:73-80` | BİRLEŞİR (v2: mevcut kartı seç ya da aday kart aç) | Sözleşme ekle 3. adım | [ ] |
| W-14-06 | Sonuç: "Belgede kayıtlı olmayan IBAN okundu… doğrulama görevi açıldı" | `IntakePage.tsx:77` | **KALKAR (onaylı liste)** | yok | [ ] |
| W-14-07 | Sonuç: e-Fatura'dan fatura kaydı açıldı / mükerrer / açılamadı ("Finans görevine düştü"), "Faturayı aç" | `IntakePage.tsx:81-86` | KARAR GEREKLİ (K-05) | Faturalar | [ ] |
| W-14-08 | Sonuç: UBL-TR kural denetimi bulguları | `IntakePage.tsx:87-91`; `ui/UblCheck.tsx:23-55` | KARAR GEREKLİ (K-05) | — | [ ] |

### 3.15 Belge detayı — `/belgeler/:id` — `pages/DocumentPage.tsx`

API: `GET /api/v1/document-versions/:id`, `/content`, `POST …/seller-identity`.

| # | İşlev | Dosya:satır | v2 kararı | v2'deki yeri | ✓ |
|---|---|---|---|---|---|
| W-15-01 | Bölünmüş görünüm: belge görüntüleyici + alanlar; karantina bandı | `DocumentPage.tsx:39-43` | KALIR (sözleşme için) | Sözleşme detayı > Belge; diğer türler K-05 | [ ] |
| W-15-02 | "İmha edildi" bandı (baytlar silindi, SHA korunur) | `DocumentPage.tsx:40-41` | KALIR (v1'de imha edilmiş belgeler için durum gösterimi sürmeli; yeni imha yapılmaz) | Belge | [ ] |
| W-15-03 | Kimlik: başlık, sürüm, dosya adı, SHA-256, yüklenme zamanı, antivirüs durumu | `DocumentPage.tsx:45-49` | KALIR | Belge | [ ] |
| W-15-04 | "Bağlı tedarikçi" (bağlantı, durum, ünvan farkı) | `DocumentPage.tsx:50-54` | KALIR | Belge | [ ] |
| W-15-05 | "Çıkarılan alanlar" tablosu: alan, değer, köken etiketi, "sayfa N" düğmesiyle belgede o sayfaya gitme, XML kaynağı, "Kural hatası" | `DocumentPage.tsx:55-72` | DÖNÜŞÜR (v2: kaynak sayfa + güven düzeyi; fatura alanları K-05) | Sözleşme ekle 2. ve 3. adım | [ ] |
| W-15-06 | UBL-TR kontrol bölümü (e-Fatura XML) | `DocumentPage.tsx:73-78` | KARAR GEREKLİ (K-05) | — | [ ] |
| W-15-07 | "Satıcı kimliğini girin" formu (tür, vergi kimliği, ünvan, kaynak sayfa; `POST …/seller-identity`); fatura belgesi + tedarikçi bağlı değilken | `DocumentPage.tsx:36, 84-114` | KARAR GEREKLİ (K-05) | — | [ ] |
| W-15-08 | Aynı formdaki "IBAN (varsa)" alanı (farklıysa doğrulama görevi açar) | `DocumentPage.tsx:110` | **KALKAR (onaylı liste)** | yok | [ ] |

### 3.16 Siparişler — `/siparisler`, `/siparisler/:id` — `pages/PurchasingPages.tsx`

API: `/api/v1/purchase-orders` (GET, POST, `/:id`, `/:id/changes`, `/:id/close`), `/po-lines/:id/receipts`, `/receipts/:id/reverse`, `/supplier-options`, `/contract-options`.

| # | İşlev | Dosya:satır | v2 kararı | v2'deki yeri | ✓ |
|---|---|---|---|---|---|
| W-16-01 | Sipariş listesi (kod, tedarikçi, sözleşme, tutar, durum), boş durum | `PurchasingPages.tsx:32-58` | **KALKAR (onaylı liste)** | yok | [ ] |
| W-16-02 | "Sipariş ver" formu (şirket, tedarikçi, sözleşme, kalemler, KDV; kalem ekle/sil) | `PurchasingPages.tsx:39, 61-112` | **KALKAR (onaylı liste)** | yok | [ ] |
| W-16-03 | Sipariş detayı: kalemler, sözleşme bağlantısı, değişiklik geçmişi | `PurchasingPages.tsx:129-162, 196-208` | **KALKAR (onaylı liste)** | yok | [ ] |
| W-16-04 | "Siparişi değiştir" (miktar/fiyat/yeni kalem, gerekçe) | `PurchasingPages.tsx:143, 212-260` | **KALKAR (onaylı liste)** | yok | [ ] |
| W-16-05 | "Kapat / iptal et" (gerekçe) | `PurchasingPages.tsx:144, 264-282` | **KALKAR (onaylı liste)** | yok | [ ] |
| W-16-06 | "Kabul kaydet" (miktar, not, hizmet dönemi), "Ters kabul", kabul geçmişi | `PurchasingPages.tsx:163-193` | **KALKAR (onaylı liste)** | yok | [ ] |

### 3.17 Faturalar listesi — `/faturalar` — `pages/PurchasingPages.tsx`

API: `GET /api/v1/invoices`, `POST /api/v1/invoices`.

| # | İşlev | Dosya:satır | v2 kararı | v2'deki yeri | ✓ |
|---|---|---|---|---|---|
| W-17-01 | Fatura tablosu (no, tür, tedarikçi + durum notu, tarih, tutar, ERP/ödeme, mükerrer sayısı), boş durum | `PurchasingPages.tsx:296-357` | SADELEŞİR (proje/sözleşme bağlantısı ve departman süzgeci eklenir) | Faturalar | [ ] |
| W-17-02 | Durum süzgeci (URL `durum`): Tümü, Karar bekliyor, Engelli, Onaylandı, Reddedildi, Hukuken iptal/ret + sayaçlar | `PurchasingPages.tsx:309-311, 327-330` | DÖNÜŞÜR (onay durumları kalkar; v2: eşleşti / eşleşmedi kuyruğu) | Faturalar | [ ] |
| W-17-03 | Para birimi süzgeci (URL `para`) | `PurchasingPages.tsx:331-332` | KALIR | Faturalar | [ ] |
| W-17-04 | Kolon göster/gizle (URL `gizle`): Tedarikçi, ERP / ödeme, Tarih | `PurchasingPages.tsx:305-307, 314, 333-335` | KALIR | Faturalar | [ ] |
| W-17-05 | Kayıtlı görünümler (`page="invoices"`) | `PurchasingPages.tsx:325` | KALIR | Faturalar | [ ] |
| W-17-06 | "Fatura gir" formu (FINANCE): tür (fatura/iade), no, ETTN, tarih, tedarikçi, satırlar, KDV; mükerrer denetimi | `PurchasingPages.tsx:321, 360-410` | KARAR GEREKLİ (K-05; analiz Karar 9: "elle ekleme yedek" öneri, karar verilmedi; FINANCE rolü kalkıyor) | Faturalar | [ ] |
| W-17-07 | "Tolerans kuralları" bağlantısı | `PurchasingPages.tsx:319` | **KALKAR (onaylı liste)** | yok | [ ] |
| W-17-08 | "ERP mutabakatı" bağlantısı (FINANCE, AUDITOR) | `PurchasingPages.tsx:320` | DÖNÜŞÜR | Yönetim > Entegrasyonlar | [ ] |

### 3.18 Fatura detayı — `/faturalar/:id` — `pages/PurchasingPages.tsx`

API: `GET /api/v1/invoices/:id`, `PUT …/allocations`, `POST …/approve|reject|exception-approval`.

| # | İşlev | Dosya:satır | v2 kararı | v2'deki yeri | ✓ |
|---|---|---|---|---|---|
| W-18-01 | Başlık, durum, tedarikçi kaydına bağlantı, ERP durumu, ödeme durumu (ERP teyidi), tekrar gelen fatura uyarısı | `PurchasingPages.tsx:448-459` | SADELEŞİR (salt okunur) | Fatura detayı | [ ] |
| W-18-02 | "Satırlar ve tahsis" tablosu (sipariş/sözleşme bağı ya da "Bağsız") | `PurchasingPages.tsx:464-487` | DÖNÜŞÜR (v2: tedarikçi → sözleşme → proje → departman bağı) | Fatura detayı | [ ] |
| W-18-03 | "Tahsisi düzenle": sipariş kalemlerini yükle, satır böl, avans mahsubu, "Tahsisi kaydet ve kontrol et" (`PUT …/allocations`) | `PurchasingPages.tsx:464, 561-610` | DÖNÜŞÜR (sipariş kalemi/avans tahsisi kalkar; yerine sözleşmeye elle bağlama) | Faturalar > eşleştirme kuyruğu | [ ] |
| W-18-04 | "Tutar" paneli (net, KDV, vergi dahil; satırlardan yeniden hesap), "Kaynak e-Fatura" bağlantısı | `PurchasingPages.tsx:490-500` | KALIR | Fatura detayı | [ ] |
| W-18-05 | UBL-TR kontrol paneli | `PurchasingPages.tsx:504-507` | KARAR GEREKLİ (K-05) | — | [ ] |
| W-18-06 | "Limit · sözleşme" paneli (sözleşme limiti kullanımı) | `PurchasingPages.tsx:510-516` | DÖNÜŞÜR (v2: toplam fatura / sözleşme tutarı kullanım çubuğu, aşım yalnız bilgi) | Sözleşme detayı > Faturalar; Fatura detayı | [ ] |
| W-18-07 | Kontrol bulguları (sipariş/kabul eşleşmesi, tolerans, limit; engel/uyarı, çözen rol) | `PurchasingPages.tsx:519-531, 550-559` | **KALKAR (onaylı liste)**: üçlü eşleştirme ve tolerans bulguları | yok | [ ] |
| W-18-08 | "İstisnayı onayla" (gerekçe ≥10; PROCUREMENT_MANAGER) + "İstisna eskidi" uyarısı | `PurchasingPages.tsx:527, 534` | **KALKAR (onaylı liste)** | yok | [ ] |
| W-18-09 | "Finans onayı" (If-Match parmak izi; FINANCE; giren onaylayamaz) | `PurchasingPages.tsx:536` | **KALKAR (onaylı liste)** | yok | [ ] |
| W-18-10 | "Reddet" (gerekçe ≥10) | `PurchasingPages.tsx:537` | **KALKAR (onaylı liste)** | yok | [ ] |
| W-18-11 | Karar geçmişi (Finans onayı / İstisna onayı / Ret ıstampaları), ERP son hata | `PurchasingPages.tsx:521-523, 541` | KALIR (salt okunur geçmiş; v1'de karar verilmiş faturalarda görünmeli) | Fatura detayı | [ ] |

### 3.19 Tolerans kuralları — `/faturalar/tolerans` — `pages/PurchasingPages.tsx`

API: `/api/v1/tolerance-rules` (GET, PUT, DELETE). Yetki: `tolerance.manage` (FINANCE).

| # | İşlev | Dosya:satır | v2 kararı | v2'deki yeri | ✓ |
|---|---|---|---|---|---|
| W-19-01 | Kural tablosu, boş durum ("sıfır toleransla kontrol edilir") | `PurchasingPages.tsx:619-634, 654-672` | **KALKAR (onaylı liste)** | yok | [ ] |
| W-19-02 | "Kural ekle" / "Değiştir" (para birimi, kategori, mutlak tutar, yüzde, birleştirme) | `PurchasingPages.tsx:631, 635-651, 669` | **KALKAR (onaylı liste)** | yok | [ ] |
| W-19-03 | "Kaldır" (onaylı silme) | `PurchasingPages.tsx:666-670` | **KALKAR (onaylı liste)** | yok | [ ] |

### 3.20 ERP mutabakatı — `/faturalar/erp-mutabakati` — `pages/GovernancePages.tsx`

API: `/api/v1/integration/erp/reconciliation`, `/batch.csv`, `/results`, `/exports/:id/replay`. Yetki: `integration.reconcile` (FINANCE, AUDITOR), `integration.replay` (FINANCE).

| # | İşlev | Dosya:satır | v2 kararı | v2'deki yeri | ✓ |
|---|---|---|---|---|---|
| W-20-01 | Dönem süzgeci (başlangıç, bitiş, "Uygula") | `GovernancePages.tsx:344, 369-373` | DÖNÜŞÜR | Yönetim > Entegrasyonlar: son çalışmalar ve hata kaydı | [ ] |
| W-20-02 | "Durum ve toplamlar" paneli (veri anı, gelen ERP olayı, tekrar sayısı) | `GovernancePages.tsx:377-382` | DÖNÜŞÜR | Entegrasyonlar | [ ] |
| W-20-03 | "İlgilenilmesi gerekenler" tablosu, faturaya bağlantı, "Tekrar gönder" (gerekçe ≥10) | `GovernancePages.tsx:383-399` | DÖNÜŞÜR (onaylı fatura aktarımı v2'de yok; yeniden deneme özellik kartına taşınır) | Entegrasyonlar | [ ] |
| W-20-04 | "Aktarım dosyası (CSV)" indirme | `GovernancePages.tsx:354-356, 403` | DÖNÜŞÜR (bkz. K-07) | Entegrasyonlar | [ ] |
| W-20-05 | Sonuç dosyası (CSV) yükleme: "Önce dene" (kuru çalışma), "Sonuç dosyasını uygula", sonuç özeti | `GovernancePages.tsx:361, 405-411, 422-434` | DÖNÜŞÜR (bkz. K-07) | Entegrasyonlar | [ ] |

### 3.21 Raporlar — `/raporlar` — `pages/EvaluationPages.tsx`

API: `GET /api/v1/reports/summary?from&to&fresh`, `/summary.csv`.

| # | İşlev | Dosya:satır | v2 kararı | v2'deki yeri | ✓ |
|---|---|---|---|---|---|
| W-21-01 | Dönem süzgeci (başlangıç, bitiş, "Uygula") | `EvaluationPages.tsx:441-445` | SADELEŞİR | Raporlar | [ ] |
| W-21-02 | Gösterge tablosu: gösterge + tanım, değer, pay/payda, kaynak; "Veri yok" / "Hesaplanmıyor" | `EvaluationPages.tsx:453-466` | SADELEŞİR (v2 panosu: biten sözleşmeler, risk matrisi, uyum puanları, açık onaylar) | Raporlar | [ ] |
| W-21-03 | "Yeniden hesapla" + veri anı ve kapsam notu | `EvaluationPages.tsx:449-452` | SADELEŞİR | Raporlar | [ ] |
| W-21-04 | "CSV indir" | `EvaluationPages.tsx:428-438` | KARAR GEREKLİ (K-07) | — | [ ] |

### 3.22 Yapay zekâ — `/yapay-zeka` — `pages/EvaluationPages.tsx`

API: `/api/v1/ai/overview`, `/ai/policy` (PUT, DELETE), `/ai/runs/:id/retry`. Yetki: `ai.read`, `ai.policy.manage` (TENANT_ADMIN).

| # | İşlev | Dosya:satır | v2 kararı | v2'deki yeri | ✓ |
|---|---|---|---|---|---|
| W-22-01 | "Görev matrisi" paneli | `EvaluationPages.tsx:499-501` | DÖNÜŞÜR | Yönetim > Yapay zekâ | [ ] |
| W-22-02 | "Son çalıştırmalar" (durum, sebep, maliyet, denetim bayrakları) + "Yeniden dene" | `EvaluationPages.tsx:502-510` | DÖNÜŞÜR | Yönetim > Yapay zekâ (kullanım kaydı) | [ ] |
| W-22-03 | "Kiracı politikası": "Düzenle" (sağlayıcı, bölge, aylık bütçe, günlük çağrı sınırı, yükseltme izni), "Kaldır" | `EvaluationPages.tsx:512-518, 533-548` | DÖNÜŞÜR | Yönetim > Yapay zekâ ayarları | [ ] |
| W-22-04 | "Kullanım" paneli (ay harcaması, bugünkü çağrı) | `EvaluationPages.tsx:520-522` | DÖNÜŞÜR | Yönetim > Yapay zekâ | [ ] |
| W-22-05 | "Model kaydı" paneli | `EvaluationPages.tsx:523-529` | DÖNÜŞÜR (v2: model adı tek ayardan) | Yönetim > Yapay zekâ | [ ] |

### 3.23 Lira Defteri — `/lira-defteri`, `/lira-defteri/:id` — `pages/LedgerPages.tsx`

API: `/api/v1/ledger`, `/recovery/cases`, `/recovery/scan`, `/recovery/settings`, `/recovery/cases/:id/confirm|claim|recover|dismiss`, `/fx-rates`, `/fx-rates/tcmb`.

| # | İşlev | Dosya:satır | v2 kararı | v2'deki yeri | ✓ |
|---|---|---|---|---|---|
| W-23-01 | Altı özet kutusu: Geri alınabilir, Geri alınan, Önlenebilir kayıp, Risk altındaki teminat, Kanıtlı harcama, Kanıtsız harcama | `LedgerPages.tsx:103-114` | **KALKAR (onaylı liste)** | yok | [ ] |
| W-23-02 | "Taramayı çalıştır", son tarama bilgisi, dönem süzgeci, uyarı bantları | `LedgerPages.tsx:85-121` | **KALKAR (onaylı liste)** | yok | [ ] |
| W-23-03 | Sekme "Geri alınacak para": bulgu listesi, süzgeç Açık işler / Geri alınan / Kapanan / Tümü, boş durum | `LedgerPages.tsx:135-158` | **KALKAR (onaylı liste)** | yok | [ ] |
| W-23-04 | Sekme "Kanıtsız harcama": eksik halkalar, en büyük kanıtsız faturalar | `LedgerPages.tsx:161-178` | **KALKAR (onaylı liste)** | yok | [ ] |
| W-23-05 | Sekme "Kur ve ayarlar": kur tablosu, elle kur ekle/sil | `LedgerPages.tsx:181-221` | **KALKAR (onaylı liste)** | yok | [ ] |
| W-23-06 | "TCMB'den al" (tarihli; `POST /fx-rates/tcmb`) | `LedgerPages.tsx:200-203` | **KALKAR (onaylı liste)** | yok | [ ] |
| W-23-07 | "Sermaye maliyeti" ayarı (`PUT /recovery/settings`) | `LedgerPages.tsx:222-229` | **KALKAR (onaylı liste)** | yok | [ ] |
| W-23-08 | Bulgu detayı: hesap dayanağı, talep yazısı taslağı + "Kopyala", geçmiş, tutar, bağlı kayıtlar | `LedgerPages.tsx:279-335` | **KALKAR (onaylı liste)** | yok | [ ] |
| W-23-09 | Bulgu işlemleri: Doğrula, "Talep edildi olarak işaretle", "Tahsil edildi" (tutar), "Kapat" (gerekçe) | `LedgerPages.tsx:337-364` | **KALKAR (onaylı liste)** | yok | [ ] |

### 3.24 Veri yönetimi — `/veri-yonetimi`, `/veri-yonetimi/imha/:id` — `pages/GovernancePages.tsx`

API: `/api/v1/retention`, `/retention/candidates`, `/retention/policies/:kind`, `/legal-holds`, `/disposal-batches`, `/tenant-exports`.

| # | İşlev | Dosya:satır | v2 kararı | v2'deki yeri | ✓ |
|---|---|---|---|---|---|
| W-24-01 | Sekmeler: Saklama ve imha, Hukuki saklama, Dışa aktarım | `GovernancePages.tsx:56-75` | **KALKAR (onaylı liste)**: ilk iki sekme; üçüncü TAŞINIR | bkz. W-24-08 | [ ] |
| W-24-02 | Saklama politikası tablosu: belge türü başına süre + yasal dayanak, "Düzenle/Tanımla", "Kaldır" | `GovernancePages.tsx:92-106, 147-158` | **KALKAR (onaylı liste)** | yok | [ ] |
| W-24-03 | İmha adayları listesi, belge seçimi, "Seçilen N belge için imha öner" (gerekçe ≥10) | `GovernancePages.tsx:108-131` | **KALKAR (onaylı liste)** | yok | [ ] |
| W-24-04 | İmha adayında "Saklamaya al" iletişim kutusu | `GovernancePages.tsx:123, 160-179` | **KALKAR (onaylı liste)** | yok | [ ] |
| W-24-05 | İmha partileri listesi ve parti detayı: belgeler, "Onayla ve imha et" (iki adımlı onay), "Reddet" | `GovernancePages.tsx:134-142, 278-318` | **KALKAR (onaylı liste)** | yok | [ ] |
| W-24-06 | Hukuki saklama: etkin/kaldırılan listeleri, "Yeni hukuki saklama" (kapsam belge/şirket, dosya no, gerekçe) | `GovernancePages.tsx:182-222` | **KALKAR (onaylı liste)** | yok | [ ] |
| W-24-07 | "Saklamayı kaldır" (gerekçe ≥10) | `GovernancePages.tsx:198-201` | **KALKAR (onaylı liste)** | yok | [ ] |
| W-24-08 | Dışa aktarım: "Dışa aktarım iste" (gerekçe; TENANT_ADMIN), talepler listesi + "Yenile", hukuk onayı/ret (not zorunlu), isteyen için "Paketi indir" | `GovernancePages.tsx:228-272` | TAŞINIR (analiz: "denetim izi ve dışa aktarım Yönetici altında kalır"); onaylayan rol ve alt giriş bkz. K-03 | Yönetim | [ ] |

### 3.25 Arama — `/ara` — `pages/SearchPage.tsx`

API: `GET /api/v1/search?q=`.

| # | İşlev | Dosya:satır | v2 kararı | v2'deki yeri | ✓ |
|---|---|---|---|---|---|
| W-25-01 | Türe göre gruplanmış sonuçlar (Projeler, Tedarikçiler, Sözleşmeler, Siparişler, Faturalar, Belgeler, Olaylar), eşleşen alan, kayda bağlantı | `SearchPage.tsx:6-11, 24-36` | KALIR (Siparişler grubu kalkar; Olaylar tedarikçi kartına yönlenir) | üst çubuk araması | [ ] |
| W-25-02 | Durumlar: 2 karakterden kısa, yükleniyor, hata, "Sonuç yok" | `SearchPage.tsx:21-23` | KALIR | Arama | [ ] |

### 3.26 Tedarikçi portalı — `pages/PortalPages.tsx`

API: `/api/v1/portal/rounds`, `/portal/rounds/:id` (+ `/files`, `/bids`, `/questions`), `/portal/assessments` (+ `/:id`, `/answers/:q`, `/submit`).

| # | İşlev | Dosya:satır | v2 kararı | v2'deki yeri | ✓ |
|---|---|---|---|---|---|
| W-26-01 | Teklif davetleri listesi; satırda "Teklif ver" / "Teklifi güncelle" / "Görüntüle"; boş durum | `PortalPages.tsx:17-40` | KALIR | Portal: Teklif davetleri | [ ] |
| W-26-02 | Tur başlığı: alıcı, tur no, kategori, kapanış zamanı, sunucu saatine göre geri sayım, geçerli sürüm | `PortalPages.tsx:59-70, 169-175` | KALIR | Portal: teklif verme | [ ] |
| W-26-03 | Fiyat tablosu: kalem başına kapsam, birim, miktar, birim fiyat; birim farkı uyarısı; önizleme toplamı | `PortalPages.tsx:184-206` | KALIR | Portal: teklif verme | [ ] |
| W-26-04 | Ek maliyetler: ekle/sil | `PortalPages.tsx:209-218` | KALIR | Portal: teklif verme | [ ] |
| W-26-05 | Ekler: dosya yükle (PDF/PNG/JPEG/XML), durum, "İndir" | `PortalPages.tsx:115, 220-233` | KALIR | Portal: teklif verme | [ ] |
| W-26-06 | "Teklifi gönder" / "Yeni sürüm gönder"; alındı bandı (sunucu zamanı, tekrar gönderim), bağlantı koptu uyarısı, form hata özeti | `PortalPages.tsx:151, 176-183, 243` | KALIR | Portal: teklif verme | [ ] |
| W-26-07 | Yan panel: Değerlendirme kriterleri ve ağırlıkları, teslimat/ihtiyaç tarihi, "Gönderimlerim" sürüm listesi | `PortalPages.tsx:249-263` | KALIR | Portal: teklif verme | [ ] |
| W-26-08 | Soru ve cevaplar: soru gönder (tur açıkken), yanıtları gör | `PortalPages.tsx:264-274` | KALIR | Portal: teklif verme | [ ] |
| W-26-09 | Anketler listesi; "Yanıtla" / "Görüntüle"; boş durum | `PortalPages.tsx:285-306` | KALIR | Portal: Anketler | [ ] |
| W-26-10 | Anket yanıtlama: soru başına yanıt, uygulanamaz gerekçesi, "Yanıtı kaydet", "Değiştir" | `PortalPages.tsx:336-343, 360-400` | KALIR | Portal: anket doldurma | [ ] |
| W-26-11 | "Kuruma gönder" + onay adımı ("Evet, gönder" / "Vazgeç"); tüm sorular yanıtlanmadan kapalı | `PortalPages.tsx:329, 345-354` | KALIR | Portal: anket doldurma | [ ] |

Web envanter satırı: 235 (Bölüm 3; Bölüm 2'deki 34 menü/rota satırı ayrıca). Toplam doğrulanacak satır: 235 web + 47 iOS + 34 menü/rota = 316 (roller eşlemesindeki 12 satır hariç).

---

## 4. iOS: ekran ekran işlev tablosu

Dil: yalnız Türkçe sabit metin (yerelleştirme dosyası taranmadı, Bölüm 8).

### 4.0 Kök, giriş ve "Daha fazla" — `Features/RootViews.swift`, `Features/Common.swift`

| # | İşlev | Dosya:satır | v2 kararı | v2'deki yeri | ✓ |
|---|---|---|---|---|---|
| I-00-01 | Oturum kapısı: oturum varsa sekmeler, yoksa giriş; açılışta oturum yenileme | `RootViews.swift:3-17` | KALIR | Giriş (Entra) | [ ] |
| I-00-02 | Bağlantı gelince bekleyen taslakların otomatik yüklenmesi | `RootViews.swift:12-15` | KALIR | Tara | [ ] |
| I-00-03 | Dört sekme: İşlerim, Tara (bekleyen taslak rozeti), Kayıtlar, Daha fazla | `RootViews.swift:20-33` | KALIR (içerik değişir; sekme sayısı ve erişim azalmamalı) | sekmeler | [ ] |
| I-00-04 | Kurumsal giriş "Kurumsal hesapla giriş yap" + açıklama | `RootViews.swift:49-57` | KALIR | Giriş | [ ] |
| I-00-05 | Geliştirme girişi: 7 sentetik kullanıcı (yalnız DEBUG); yayın derlemesinde açıklama | `RootViews.swift:37-43, 58-74` | KALIR (yalnız geliştirme; liste yeni rollere göre güncellenir) | Giriş (dev) | [ ] |
| I-00-06 | Giriş durumları: ayarlar alınıyor, "Tekrar dene", hata metni | `RootViews.swift:75-81` | KALIR | Giriş | [ ] |
| I-00-07 | Daha fazla > Oturum: kullanıcı, roller, kiracı seçici (birden çok üyelikte), şirket kapsamı | `RootViews.swift:94-106` | KALIR (yeni rol adları, departman) | Daha fazla | [ ] |
| I-00-08 | Daha fazla > Cihaz: bağlantı durumu, bekleyen taslak sayısı, anahtar zinciri açıklaması | `RootViews.swift:108-112` | KALIR | Daha fazla | [ ] |
| I-00-09 | "Çıkış" | `RootViews.swift:113` | KALIR | Daha fazla | [ ] |
| I-00-10 | Ortak: çevrimdışı bandı, yükleniyor / "Yüklenemedi" + "Yeniden dene", çakışma (409) ve belirsiz sonuç uyarıları, erişilebilirlik metin boyutunda dikey düzen | `Common.swift:4-84` | KALIR | tüm ekranlar | [ ] |

### 4.1 İşlerim — `Features/TasksView.swift`

API: `GET /api/v1/tasks?view=mine`.

| # | İşlev | Dosya:satır | v2 kararı | v2'deki yeri | ✓ |
|---|---|---|---|---|---|
| I-01-01 | Görev listesi: önem, kayıt no, son tarih, başlık, neden, sonraki adım; aşağı çekerek yenile; boş durum | `TasksView.swift:8-47` | KALIR (v2: onaylar, hatırlatıcılar, risk görevleri) | İşlerim | [ ] |
| I-01-02 | Görevden ekrana geçiş: contract_version → İmza kontrolü; invoice → Fatura; incident → Olay; document_version → Belge önizleme | `TasksView.swift:50-58` | KALIR (v2'de sözleşme onayı ekranı eklenir) | İşlerim | [ ] |
| I-01-03 | Karşılığı olmayan tür için "Bu iş webde yapılır" ekranı | `TasksView.swift:58-61` | KALIR | İşlerim | [ ] |

### 4.2 Tara — `Features/ScanView.swift`

API: `POST /api/v1/documents` (DraftStore üzerinden; `Core/DraftStore.swift` ayrıntısı taranmadı).

| # | İşlev | Dosya:satır | v2 kararı | v2'deki yeri | ✓ |
|---|---|---|---|---|---|
| I-02-01 | "Kamerayla tara" (belge kamerası; yoksa açıklama) | `ScanView.swift:25-28, 57, 197-212` | DÖNÜŞÜR | Sözleşme ekle > tarama | [ ] |
| I-02-02 | "Fotoğraflardan seç" (en çok 30 görsel) | `ScanView.swift:30, 63-69` | DÖNÜŞÜR | Sözleşme ekle > tarama | [ ] |
| I-02-03 | "PDF dosyası seç" | `ScanView.swift:31, 58-62` | DÖNÜŞÜR | Sözleşme ekle > tarama | [ ] |
| I-02-04 | Sayfa önizleme şeridi: döndür, sil, düşük çözünürlük uyarısı | `ScanView.swift:101-117` | KALIR | Sözleşme ekle > tarama | [ ] |
| I-02-05 | Belge bilgisi: Başlık, Tür (Fatura, Sözleşme, Teklif, Diğer), Şirket | `ScanView.swift:119-124` | DÖNÜŞÜR (sözleşme + proje seçimi; diğer türler K-05) | Sözleşme ekle | [ ] |
| I-02-06 | "Taslak olarak kaydet ve yükle" (A4 PDF üretimi, 25 MB sınırı), "Vazgeç" | `ScanView.swift:125-138, 141-163` | KALIR | Sözleşme ekle | [ ] |
| I-02-07 | Şifreli çevrimdışı taslak; bağlantı gelince yükleme; yükleme sonucu mesajı | `ScanView.swift:34-46` | KALIR | Sözleşme ekle | [ ] |
| I-02-08 | "Taslaklar ve yüklemeler" listesi: durum (Yüklenmedi, Yükleniyor, Hata, Yüklendi), sunucu mesajı, mükerrer notu, sahipsiz eski taslak uyarısı | `ScanView.swift:49-54, 166-195` | KALIR | Tara | [ ] |
| I-02-09 | Taslak işlemleri: "Yükle" / "Tekrar yükle", "Listeden kaldır", "Sil" (onaylı; yüklenirken silinemez) | `ScanView.swift:72-77, 181-187` | KALIR | Tara | [ ] |

### 4.3 Kayıtlar — `Features/RecordsView.swift`

| # | İşlev | Dosya:satır | v2 kararı | v2'deki yeri | ✓ |
|---|---|---|---|---|---|
| I-03-01 | Bölüm seçici: Siparişler, Olaylar, Faturalar (Faturalar yalnız FINANCE, BUYER, PROCUREMENT_MANAGER, LEGAL, AUDITOR) | `RecordsView.swift:4-16` | DÖNÜŞÜR (Siparişler bölümü kalkar) | Kayıtlar | [ ] |
| I-03-02 | Sipariş listesi (kod, durum, tedarikçi, tutar), boş durum | `RecordsView.swift:51-78` | **KALKAR (onaylı liste)**: siparişler; analizdeki "iOS kayıtlar kalır" satırıyla çelişki için bkz. K-09 | yok | [ ] |
| I-03-03 | Sipariş detayı: tedarikçi, durum, sözleşme, kalemler (sipariş/kabul/faturalanan), kabul geçmişi | `RecordsView.swift:81-141` | **KALKAR (onaylı liste)** (K-09) | yok | [ ] |
| I-03-04 | "Mal kabulü kaydet" / "Hizmet kabulü kaydet" sayfası: miktar, not, hizmet dönemi; tekrar anahtarı; belirsiz sonuçta "Tekrar gönder" | `RecordsView.swift:106-108, 128-136, 144-197` | **KALKAR (onaylı liste)**: mal/hizmet kabul | yok | [ ] |
| I-03-05 | Olay listesi (kod, durum, "İtiraz açık", tedarikçi, şiddet), boş durum | `RecordsView.swift:200-231` | KALIR (analiz: iOS kayıtlar kalır); web'de olaylar tedarikçi kartına birleşiyor, iOS karşılığı bkz. K-10 | Kayıtlar | [ ] |
| I-03-06 | "Olay bildir" sayfası: tedarikçi, kategori, şiddet, olay tarihi, başlık, açıklama; tekrar anahtarı (`POST /incidents`) | `RecordsView.swift:224-225, 304-356` | KALIR (K-10) | Kayıtlar | [ ] |
| I-03-07 | Olay detayı: durum, tarih, tedarikçi, kategori, şiddet, puan etkisi, olay metni, zaman çizelgesi | `RecordsView.swift:234-281` | KALIR (K-10) | Kayıtlar | [ ] |
| I-03-08 | Düzeltici faaliyet "Tamamlandı olarak işaretle" (not; `POST /corrective-actions/:id/complete`) | `RecordsView.swift:258-268, 285-297` | KALIR (K-10) | Kayıtlar | [ ] |
| I-03-09 | Fatura listesi: no, durum (karar / "Engelli" / "Karar bekliyor"), tedarikçi + durum notu, tutar; boş durum | `RecordsView.swift:21-48` | SADELEŞİR (durum: eşleşti/eşleşmedi; salt okunur) | Kayıtlar > Faturalar | [ ] |

### 4.4 Fatura — `Features/InvoiceView.swift`

API: `GET /api/v1/invoices/:id`, `POST /api/v1/invoices/:id/approve`.

| # | İşlev | Dosya:satır | v2 kararı | v2'deki yeri | ✓ |
|---|---|---|---|---|---|
| I-04-01 | Özet: tedarikçi, tedarikçi durum notu, durum, net, KDV, vergi dahil | `InvoiceView.swift:19-25` | KALIR (salt okunur) | Fatura | [ ] |
| I-04-02 | "Kaynak belgeyi aç" (belge önizleme, hash karşılaştırma) | `InvoiceView.swift:26-28` | KALIR | Fatura | [ ] |
| I-04-03 | "Satırlar" listesi | `InvoiceView.swift:30-31` | KALIR | Fatura | [ ] |
| I-04-04 | "Siparişi aç: …" bağlantısı (kabul kaydına geçiş) | `InvoiceView.swift:32-36` | **KALKAR (onaylı liste)**: siparişler ve kabul | yok | [ ] |
| I-04-05 | "Neden eşleşmedi ve kim çözer" bulgu listesi (engel/uyarı, çözen rol) | `InvoiceView.swift:38-48` | **KALKAR (onaylı liste)**: üçlü eşleştirme/tolerans bulguları; yerine sözleşme eşleşme durumu gösterilir | Fatura (eşleşme bilgisi) | [ ] |
| I-04-06 | "Karar" geçmişi (Finans onayı / Ret / İstisna onayı) | `InvoiceView.swift:49-50` | KALIR (salt okunur geçmiş) | Fatura | [ ] |
| I-04-07 | "Finans onayı" düğmesi + onay iletişim kutusu (tutarla), If-Match; çevrimdışı ve engel açıklamaları; görev ayrılığı metni | `InvoiceView.swift:51-62, 68-79` | **KALKAR (onaylı liste)**: iOS fatura finans onayı | yok | [ ] |

### 4.5 İmza kontrolü — `Features/SignatureView.swift`

API: `GET /api/v1/contract-versions/:id/signature-status`, `POST …/signature-reviews`.

| # | İşlev | Dosya:satır | v2 kararı | v2'deki yeri | ✓ |
|---|---|---|---|---|---|
| I-05-01 | Durum: sonuç, otomatik tarama, fiziksel asıl; uyarı metni | `SignatureView.swift:20-26` | KALIR | İmza | [ ] |
| I-05-02 | "Özgün belgeyi aç" (sürüm no, hash karşılaştırma) | `SignatureView.swift:27-31` | KALIR | İmza | [ ] |
| I-05-03 | Taraflar: gereksinim durumu, imza yuvaları; yuvasız taraf için "web'de yapılır" açıklaması | `SignatureView.swift:32-52` | KALIR | İmza | [ ] |
| I-05-04 | "Karar ver" sayfası: karar (Görüntü teyit / Eksik / Belirsiz), gözlenen işaret, sayfa, gerekçe (≥3); If-Match + belge SHA | `SignatureView.swift:45-47, 69-84, 103-146` | KALIR (inceleyen rol: K-11) | İmza | [ ] |
| I-05-05 | "Tamamlanmak için" engel listesi | `SignatureView.swift:54-59` | KALIR | İmza | [ ] |
| I-05-06 | Salt okunur durumlar: kesinleşti / yerini yeni sürüm aldı; çevrimdışıyken karar kapalı | `SignatureView.swift:61-63, 87-89` | KALIR | İmza | [ ] |

### 4.6 Belge önizleme — `Features/DocumentPreview.swift`

API: `GET /api/v1/document-versions/:id/content`.

| # | İşlev | Dosya:satır | v2 kararı | v2'deki yeri | ✓ |
|---|---|---|---|---|---|
| I-06-01 | PDF (PDFKit) ve görsel önizleme | `DocumentPreview.swift:26-27, 44-50` | KALIR | Belge | [ ] |
| I-06-02 | İstemcide SHA-256 hesaplama ve kayıtlı değerle karşılaştırma (eşleşiyor / eşleşmiyor / karşılaştırılacak değer yok) | `DocumentPreview.swift:19-25, 36` | KALIR | Belge | [ ] |
| I-06-03 | Durumlar: yükleniyor, "Belge açılamadı", XML mobilde önizlenmez | `DocumentPreview.swift:28-29, 38-39` | KALIR | Belge | [ ] |

iOS envanter satırı: 47.

---

## 5. Roller eşlemesi

Kaynak: `packages/domain/src/roles.ts` (12 rol, 77 yetki). Yetki sayısı, rolün adının geçtiği yetki satırı sayısıdır (`task.read` dahil).

| Eski rol | Türkçe etiket (`labels.ts:78-80`) | Yetki sayısı | v2 rolü (analiz 2.1) | Not |
|---|---|---|---|---|
| TENANT_ADMIN | Kiracı yöneticisi | 9 | Yönetici | v1'de belge/proje okuma yetkisi yok; v2'de "her şeyi görür" |
| PLATFORM_OPS | Platform operasyonu | 0 | Yönetici | `roles.ts` içinde hiçbir yetkiye atanmamış; `task.read` dışında |
| BUYER | Satınalmacı | 33 | Satınalma | |
| PROCUREMENT_MANAGER | Satınalma yöneticisi | 49 | Satınalma | onay kararları (`approval.decide`, `award.decide`, `project.publish.approve`) için bkz. K-01 |
| MASTER_DATA | Ana veri | 13 | Satınalma | `supplier.activate`, `supplier.identity.resolve` yalnız bu rolde; görev ayrılığı bkz. K-08 |
| REQUESTER | Talep sahibi | 14 | Departman kullanıcısı | |
| TECH_EVALUATOR | Teknik değerlendirici | 9 | Departman kullanıcısı | |
| SUPPLIER | Tedarikçi | 2 | Tedarikçi | `bid.submit`, `portal.assessment` |
| AUDITOR | Denetçi | 15 | Denetçi (salt okunur) | |
| FINANCE | Finans | 31 | **kaldırıldı** (iş ERP'ye) | yalnız bu rolde olan yetkiler: `invoice.manage`, `invoice.approve`, `integration.ingest`, `tolerance.manage`, `integration.replay`, `recovery.settle`, `recovery.settings` |
| LEGAL | Hukuk | 35 | **kaldırıldı** (yapay zekâ ön incelemesi) | yalnız bu rolde olan yetkiler: `signature.custody.record`, `signature.exception.decide`, `signature.finalize`, `contract.terms.verify`, `retention.manage`, `legal_hold.manage`, `disposal.approve`, `tenant.export.approve` → bkz. K-03, K-11 |
| SECURITY | Bilgi güvenliği | 17 | **kaldırıldı** (iş biriminin risk değerlendirmesi) | `questionnaire.manage`, `assessment.review`, `risk.accept` PROCUREMENT_MANAGER ile ortak |

v2'de rol olmayan üç onaycı unvanı (departman sorumlusu, satınalma sorumlusu, satınalma direktörü) yeni; v1'de karşılığı yok.

Roller satırı: 12.

---

## 6. KALKAR bölümü (yalnız onaylı liste)

Her madde için doğrulama: (a) menü, düğme ve rota kullanıcıya görünmüyor, (b) ilgili yetki hiçbir yeni role verilmiyor, (c) tablo ve veri silinmedi, (d) v1 etiketi atıldı, (e) kalkan ekrana giden bağlantılar (görev, bildirim, arama, başka sayfa) ölü bağlantı bırakmıyor.

| Onaylı madde | Envanter satırları | İlgili yetkiler | Kalkan ekrana dışarıdan gelen bağlantılar (temizlenecek) | ✓ |
|---|---|---|---|---|
| Kurallı onay politikası ekranı | R3, W-02-02, W-05-01..04 | `approval.policy.manage` | Projeler başlığındaki düğme; TENANT_ADMIN'in Projeler menüsünü yalnız bunun için görmesi (`App.tsx:88-89`) | [ ] |
| Banka bilgisi değişikliği doğrulama akışı | W-06-05, W-07-09, W-14-06, W-15-08 | `bank.change.decide` | Tedarikçi listesi "Dikkat" sütunu; belge girişi sonucu; satıcı kimliği formu | [ ] |
| Siparişler ve mal/hizmet kabul | M7, R7, W-16-01..06, I-03-02..04, I-04-04 | `po.read`, `po.manage`, `receipt.record` | Arama sonuç grubu (`SearchPage.tsx:8`); fatura tahsisinde sipariş bağlantısı (`PurchasingPages.tsx:476`); olay detayında sipariş bağlantısı (`EvaluationPages.tsx:236`); sipariş başlığından sözleşmeye bağlantı | [ ] |
| Fatura finans onayı, istisna onayı, tolerans, üçlü eşleştirme | R9, W-17-07, W-18-07..10, W-19-01..03, I-04-05 | `invoice.approve`, `invoice.exception.approve`, `tolerance.manage` | Fatura listesi durum süzgeci (W-17-02); İşlerim'deki fatura görevleri | [ ] |
| Lira Defteri ve TCMB kur alma | M2, R12, W-23-01..09 | `recovery.read`, `recovery.manage`, `recovery.settle`, `recovery.settings` | İşlerim `recovery_case` hedefi (`WorkPage.tsx:18`); menü sayacı | [ ] |
| Veri yönetimi (saklama, yasal bekletme, imha) | M12, R17, W-24-01..07 | `retention.read`, `retention.manage`, `legal_hold.manage`, `disposal.propose`, `disposal.approve` | İşlerim `disposal_batch` hedefi (`WorkPage.tsx:20`); belge detayındaki "imha edildi" bandı kalır (W-15-02) | [ ] |
| iOS fatura finans onayı | I-04-07 | `invoice.approve` | iOS İşlerim'de fatura görevi faturayı salt okunur açar | [ ] |

KALKAR olarak işaretli envanter satırı: 53. Web işlev satırı 39 (W-02-02, W-05-01..04, W-06-05, W-07-09, W-14-06, W-15-08, W-16-01..06, W-17-07, W-18-07..10, W-19-01..03, W-23-01..09, W-24-01..07); menü/rota satırı 8 (M2, M7, M12, R3, R7, R9, R12, R17); iOS 6 (I-03-02..04, I-04-04, I-04-05, I-04-07; I-04-05'te bulgu listesi kalkar, yerine eşleşme bilgisi gelir).

Not: W-24-01 ve M12 karma satırdır (dışa aktarım sekmesi taşınır).

---

## 7. KARAR GEREKLİ bölümü

Onaylı kaldırma listesinde olmayan ve analiz tablosunda açık karşılığı bulunmayan işlevler. Karar verilene kadar sıfır gerileme kuralı gereği **yerinde kalır**.

**Verilen kararlar (16.11.2026, D95):** K-01 → tek Satınalma onayı, öneren onaylayamaz. K-05 → e-Fatura XML, UBL-TR denetimi ve elle fatura girişi kalır, Satınalma yapar (onay/ödeme yok). K-11 → Hukuk'a özgü imza ve koşul doğrulama işleri Satınalma rolüne geçer, görev ayrılığı sürer. Diğer maddeler açık; yerinde kalır.

| # | Konu | Mevcut işlev (satırlar) | Analizde ne deniyor | Sorulacak karar |
|---|---|---|---|---|
| K-01 | Proje içi onay adımları | Teklif turu yayın onayı (W-04-05), kazanan tahsis onayı (W-04-19), kaynak istisnası kararı (W-04-07); yetkiler `project.publish.approve`, `award.decide`, `approval.decide` | Onay politikası ekranı kalkar, "sabit üç onaycı zinciri" gelir; ancak zincir yalnız sözleşme için tarif edilmiş (2.2). 3.1'de yayın ve kazanan için onay adımı anılmıyor | Yayın ve kazanan seçimi onaysız mı olacak, üç onaycı zinciri mi uygulanacak, yoksa tek Satınalma onayı mı kalacak? Görev ayrılığı (öneren onaylayamaz) sürecek mi? |
| K-02 | Proje kalemleri, lot, maliyet merkezi, "bütçe finansça doğrulandı" | W-03-03, W-03-04, W-04-09; portal fiyat tablosu kalemlere dayanıyor (W-26-03) | 3.1 zorunlu alanlar listesinde kalem/lot yok; "sadeleştirilir, yeniden yazılmaz" | Kalem bazlı teklif yapısı ve Kalemler sekmesi kalıyor mu? (Kalkarsa portal teklif formu da değişir.) |
| K-03 | Kiracı dışa aktarımı | W-24-08 (istek: TENANT_ADMIN; onay: LEGAL; indirme) | "Denetim izi ve dışa aktarım Yönetici altında kalır"; yeni Yönetim alt listesinde "Dışa aktarım" adıyla giriş yok; onaylayan LEGAL rolü kalkıyor | Hangi alt girişte duracak (Denetim izi?) ve ikinci kişi onayını kim verecek? |
| K-04 | Tasarruf bazı (proje özeti) | W-04-08; yetki `savings.approve` (PROCUREMENT_MANAGER, FINANCE) | Tabloda "Lira Defteri (tasarruf/geri kazanım)" kalkar; proje içindeki Tasarruf bazı paneli ayrıca anılmıyor | Tasarruf bazı paneli Lira Defteri ile birlikte kalkıyor mu? |
| K-05 | Sözleşme dışı belge girişi ve belge detayı | Belge türü Fatura/Teklif/Diğer (W-14-02, I-02-05), e-Fatura'dan fatura kaydı (W-14-07), UBL-TR denetimi (W-14-08, W-15-06, W-18-05), satıcı kimliği formu (W-15-07), `/belgeler/:id` sayfası (R5), elle "Fatura gir" (W-17-06) | "Belge girişi → Sözleşme ekle'nin ilk adımı". 3.5: fatura "gerekirse elle ya da e-fatura dosyasıyla da eklenebilir"; Karar 9 (elle/e-fatura kalsın mı) açık, öneri "Oracle ana kaynak, elle ekleme yedek" | Fatura XML yükleme ve elle fatura girişi kalıyor mu, kim yapacak (FINANCE kalkıyor)? Teklif ve "diğer" türü belge yükleme nereye gidiyor? UBL-TR denetimi korunuyor mu? |
| K-06 | Proje içi elle kur varsayımı | W-04-15 (`POST /projects/:id/fx-rates`) | Yalnız "TCMB kur alma" ve Lira Defteri kur tablosu kalkıyor; farklı para birimli tekliflerin karşılaştırması için proje içi kur anılmıyor | Karşılaştırmadaki elle kur varsayımı kalıyor mu? |
| K-07 | Dışa aktarımlar | Rapor "CSV indir" (W-21-04), değerlendirme "XLSX rapor" ve "PDF karar özeti" (W-04-17), ERP aktarım CSV'si ve sonuç dosyası yükleme (W-20-04, W-20-05) | Raporlar "tek pano" olarak sadeleşir, CSV anılmıyor; ERP mutabakatı "özellik başına kayıt"a dönüşür; değerlendirme dışa aktarımı anılmıyor. Yeni dışa aktarımlar tarif edilmiş (risk tablosu Excel, uyum raporu PDF) | Mevcut CSV/XLSX/PDF dışa aktarımları aynen kalıyor mu? ERP CSV elle aktarım yolu v2'de (fatura onayı olmadan) neye karşılık gelecek? |
| K-08 | Tedarikçi onayında görev ayrılığı | W-07-04, W-07-05 (kaydı açan onaylayamaz/aktifleştiremez; ayrı MASTER_DATA rolü) | BUYER ve MASTER_DATA tek "Satınalma" rolünde birleşiyor; kural anılmıyor | "Kaydı açan onaylayamaz" kuralı Satınalma rolü içinde sürecek mi? |
| K-09 | Sipariş salt okunur görünümü ve iOS Siparişler | M7, R7, I-03-02, I-03-03 | "Siparişler kalkar; sipariş salt okunur referans olarak gelir" ve "iOS: … kayıtlar … kalır" | ERP'den gelen sipariş için salt okunur bir ekran olacak mı (web ve iOS), yoksa yalnız faturada referans numarası mı? iOS Kayıtlar > Siparişler bölümü tamamen kalkıyor mu? |
| K-10 | Olayların birleşmesinin kapsamı | Kurum geneli olay listesi (W-11-01), 8 durum geçişi ve itiraz (W-11-03), bağımsız doğrulama (W-11-04), iOS olay listesi/bildir/detay/faaliyet tamamla (I-03-05..08), performans karnesine puan etkisi (W-07-16) | "Olaylar, düzeltici faaliyetler → Tedarikçi kartında Aksiyon planları" | Kurum geneli liste, itiraz/mükerrer durum makinesi ve bağımsız doğrulama korunuyor mu? iOS'ta tedarikçi kartı yok: olay bildirimi ve faaliyet tamamlama iOS'ta nerede kalacak? |
| K-11 | LEGAL rolüne bağlı sözleşme işlevleri | İmza kesinleştirme (W-13-15), imza istisnası kararı (W-13-11), fiziksel asıl kaydı (W-13-12), gereksinim tanımı (W-13-06), koşulların hukuk doğrulaması (W-13-18), iOS imza kararı (I-05-04) | "İmza çalışma alanı kalır"; LEGAL rolü kalkar, "hukuk incelemesi yapay zekâ ön incelemesine geçer" | Bu işlemleri v2'de hangi rol ya da unvan yapacak? Koşulların ikinci kişi doğrulaması üç onaycı zincirine mi devrediliyor? |
| K-12 | Tatil listesi | Web'de yönetim ekranı yok; yalnız uyarı metni (W-13-20). API: `GET/POST /api/v1/holidays`, yetki `holiday.manage` (LEGAL, TENANT_ADMIN) | Anılmıyor; hatırlatıcı süreleri "yönetici tarafından değiştirilebilir" deniyor | Tatil listesi korunuyor mu, yönetimi Yönetim altına mı alınacak? (Ekran eklemek yeni iş; kaldırmak ihbar son günü hesabını değiştirir.) |
| K-13 | Yeni sürüm / zeyilname | W-13-14 | Anılmıyor ("içerik değişirse onay baştan başlar" dışında) | Zeyilname ve yeni sürüm yükleme v2 sözleşme detayında nerede duracak? |

Analizde kararı açıkça yazılı olduğu için bu bölüme alınmayanlar: arama, bildirimler, kayıtlı görünümler (Kalır); performans ağırlıkları ve anketler (Kalır); yapay zekâ sayfası (Dönüşür); ERP mutabakatı ekranı (Dönüşür); çok kiracılı/şirketli altyapı (Karar 10: kalsın).

---

## 8. Doğrulanmayan ve emin olunamayan yerler

- **API yolu sayısı**: yalnız `apps/api/src/server.ts` içinde 173 yol sayıldı; analizdeki "155" ile fark incelenmedi, modül dosyalarında ek yol olup olmadığı doğrulanmadı.
- **Büyük sayfalarda alan düzeyi**: ProjectWorkspace, PurchasingPages, EvaluationPages, SignatureWorkspace, GovernancePages, LedgerPages, PortalPages, ContractLifecycle, ContractCommercial ve SupplierEvaluation'da düğme, form gönderimi, sekme, bağlantı ve API çağrıları satır satır çıkarıldı; formların tek tek giriş alanları ve tablo sütunlarının tamamı okunmadı. Bu satırlardaki alan listeleri eksik olabilir.
- **Sunucu tarafı yetki**: hangi düğmenin kime göründüğü çoğu yerde sunucudan gelen `can.*` bayrağına bağlı; bayrakların role eşlemesi `roles.ts` üzerinden çıkarsandı, API kodunda tek tek doğrulanmadı.
- **Banka değişikliği kararı**: `bank.change.decide` yetkisi tanımlı, ancak web'de karar düğmesi ve `server.ts` içinde bu yetkiyi kullanan bir uç bulunamadı. Akışın web tarafı yalnız görüntüleme ve görev açmadan ibaret görünüyor; `modules/suppliers.ts` ayrıntısı okunmadı.
- **Denetim izi**: `GET /api/v1/audit-events` ucu ve `audit.read` yetkisi var; web'de ekranı bulunamadı. v2'deki "Yönetim > Denetim izi" yeni ekran olur, gerileme değildir.
- **Yükümlülük emekliye ayırma**: `POST /api/v1/obligations/:id/retire` ucu var; web'de düğmesi bulunamadı.
- **Kayıtlı görünümler**: bileşen altı sayfa türünü kabul ediyor, yalnız Projeler ve Faturalar'da kullanılıyor.
- **Performans karnesi**: analiz tablosunda adıyla geçmiyor; "Anketler, performans ağırlıkları, değerlendirmeler: Kalır" satırına dayanılarak KALIR işaretlendi.
- **iOS**: `Core/` (DraftStore, SessionStore, OIDC, Models, APIClient, Keychain) ve yerelleştirme kaynakları okunmadı; taslak şifreleme ve yükleme ayrıntıları `ScanView` üzerinden çıkarsandı. `Labels` sözlükleri okunmadı.
- **Çalıştırma**: hiçbir ekran çalıştırılarak görülmedi; bu belge yalnız kod okumasına dayanır. Sunucu başlatılmadı, test koşulmadı.
- **Dil**: web ve iOS metinleri yalnız Türkçe sabit metin olarak görüldü; çok dilli altyapı aranmadı.
- **Genel UI yardımcıları**: `ui/kit.tsx`, `ui/SplitPanes.tsx`, `ui/icons.tsx` ayrıntılı okunmadı.
