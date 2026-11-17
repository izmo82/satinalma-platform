# Faz 3 (Sözleşmeler) işlev envanteri: önce / sonra

Tarih: 17.11.2026. Dal: `v2-sadelestirme`. Kural: SIFIR GERİLEME (global CLAUDE.md, 07.11.2026).

**Önce:** `docs/envanter-faz1.md` içindeki sözleşme satırları (M5, M6, R2, R5, R6, W-01-05, W-04-02, W-12, W-13, W-14, W-15, W-18-06, iOS I-00, I-01, I-02, I-05). Faz 1 satır numaraları Faz 3 başlangıç kodu (`5bfb78c`) içindi.
**Sonra:** `HEAD` (`f176f15`) kodu. Satır numaraları bu kodundur.

## Doğrulama yöntemi ve sınırı

Bu envanter **kod okumasıyla** hazırlandı: eski satır, `git show 5bfb78c:<dosya>` ile ve Faz 1 envanteriyle; yeni yer, güncel dosyalar ve `git diff 5bfb78c HEAD` ile karşılaştırıldı. Hiçbir ekran bu belge için çalıştırılmadı. **Canlı yürüyüş kanıtı** (gerçek kullanıcı, TR ve EN, ilgili roller, web + iOS) persona raporundan gelir: `.superpowers/sdd/2026-11-17-v2-faz3-sozlesme/persona-report.md` (bu belge yazılırken henüz yoktu). Rapor gelince "Canlı kanıt" sütunu oradan doldurulur; o zamana dek hiçbir satır "canlıda geçti" sayılmaz.

Durum anlamları: **KALIR** = işlev aynı yerde, aynı dokunuşla; **TAŞINDI** = yeri ya da biçimi değişti, erişim en az eskisi kadar kolay; **YENİ** = Faz 3 ile eklendi.
Dokunuş = sol menüden (web) ya da sekme çubuğundan (iOS) işleve varmak için gereken tıklama/dokunuş. Sözleşme detayında varsayılan sekme hâlâ İmza kontrolü olduğundan eski adresler (`/sozlesmeler/:id`, İşlerim bağlantıları) eskisi gibi açılır.

Not (dil): Faz 3 ekranlarındaki sabit metin Türkçedir; projenin EN katmanı bu dosyada incelenmedi. Çok dilli kural gereği EN eşdeğerleri persona raporunda yürünecek; kod okumasıyla "EN tamam" denmez.

---

## 1. Eski işlevler (önce → sonra)

### 1.1 Menü, yönlendirme ve görev geçişi

| id | İşlev | Eski yer | Yeni yer | Dokunuş önce→sonra | Durum | Kanıt (dosya:satır) |
|---|---|---|---|---|---|---|
| M5 | Sözleşmeler menü girişi | Menü > Sözleşmeler (`/sozlesmeler`) | Aynı; sayaç artık onay adımı, hatırlatıcı, ret, aile görevlerini de sayar | 1→1 | KALIR | `App.tsx:127`, `App.tsx:204` |
| M6 | Belge girişi | Menü > Belge girişi (`/belge-girisi`) | `/belge-girisi` yönlenir: Sözleşmeler > Sözleşme ekle (sihirbaz 1. adım) | 1→2 (Sözleşmeler, Sözleşme ekle); Faz 1'de menüden kalkmıştı (BİRLEŞİR kararı) | TAŞINDI | `App.tsx:235`, `ContractWizard.tsx:56-127`, `ContractsPage.tsx:97` |
| R2 | Proje detayı (Faz 3'ün dokunduğu kısım) | 5 sekme: Özet, Kalemler, Teklifler, Karşılaştırma, Karar | Aynı 5 sekme + altıncı "Sözleşmeler" | eskiler 2→2 | KALIR | `ProjectWorkspace.tsx:179`, `:233` |
| R5 | `/belgeler/:id` belge sayfası | Belge kaydı | Aynı rota duruyor; sözleşme detayı Belge sekmesinden "Belge kaydını aç" bağlantısı | 1→1 (görevden); sözleşmeden 0→3 yeni ek yol | KALIR | `ContractOverview.tsx:206-209`, `App.tsx` (R5 rotası değişmedi) |
| R6 | `/sozlesmeler/:id` sözleşme detayı | 4 sekme | 10 sekme (4 eski + 6 yeni), varsayılan hâlâ İmza kontrolü | 2→2 | KALIR | `ContractLifecycle.tsx:19-21`, `:26` |
| W-01-05 | Görevden kayda geçiş: contract_version → sözleşme | `entityHref` | Aynı; yeni türler eklendi (aşağıda N-30) | 1→1 | KALIR | `WorkPage.tsx:14-26` |
| W-04-02 | Proje detay sekmeleri (URL `sekme`) | 5 sekme | Aynı 5 + `sozlesmeler` | 2→2 | KALIR | `ProjectWorkspace.tsx:179` |

### 1.2 Sözleşmeler listesi (`/sozlesmeler`)

| id | İşlev | Eski yer | Yeni yer | Dokunuş | Durum | Kanıt |
|---|---|---|---|---|---|---|
| W-12-01 | İmza süzgeci: Tümü, İnceleme bekleyen, Görüntü bulunamadı, Tarafı eksik, Belirsiz, Aslı beklenen, İstisnalı + sayaçlar (URL `filtre`) | Liste, süzgeç satırı | Aynı yedi süzgeç ve sayaç; üstüne ayrı "Durum süzgeci" satırı eklendi (N-04) | 1→1 | KALIR | `ContractsPage.tsx:29-37`, `:104-107` |
| W-12-02 | Tablo sütunları: Sözleşme, Departman, İmza durumu, Eksik taraf, Otomatik tarama, Fiziksel asıl, Son inceleme | 7 sütun | Tablo 7 sütun (Sözleşme, Tedarikçi, Proje, Departman, Bitiş, Tutar, "Durum ve imza kontrolü"). Eksik taraf, Otomatik tarama, Fiziksel asıl, Son inceleme ayrı sütun olmaktan çıktı; **hepsi son hücrede** görünür (aynı bilgi, aynı koşullu vurgu) | 1→1 | TAŞINDI | `ContractsPage.tsx:131-164` (özellikle `:149-160`) |
| W-12-03 | Dar ekran kart listesi (≤640 px) | Kart listesi | Aynı kartlar (eksik imza satırı dahil) + kod, proje, bitiş, tutar, durum etiketi | 1→1 | KALIR | `ContractsPage.tsx:118-130` |
| W-12-04 | "Daha fazla yükle", "Süzgeç sayıları yüklenen N sözleşmeye göredir", yükleme hatası | Liste altı | Aynı; sunucu tarafı durum süzgecine uyarlandı | 2→2 | KALIR | `ContractsPage.tsx:83-90`, `:167-171` |
| W-12-05 | Kanıt kökeni satırı; yükleniyor/hata/boş durumları | Liste | Aynı | 0→0 | KALIR | `ContractsPage.tsx:108-116` |
| W-12-06 | Listeden "Sözleşme ekle" (PROCUREMENT, DEPARTMENT_USER) | Liste başlığı | Aynı düğme, aynı roller; hedef artık 4 adımlı sihirbaz. Yanına "Şablonlar" düğmesi eklendi | 2→2 | KALIR | `ContractsPage.tsx:95-97` |

### 1.3 Sözleşme detayı: imza çalışma alanı (sekme "İmza kontrolü", varsayılan)

`SignatureWorkspace.tsx` Faz 3 aralığında **değişmedi** (`git diff 5bfb78c HEAD --stat` listesinde yok). Satır numaraları Faz 1 ile aynıdır.

| id | İşlev | Eski yer | Yeni yer | Dokunuş | Durum | Kanıt |
|---|---|---|---|---|---|---|
| W-13-01 | Sekmeli yapı (URL `sekme`: imza, kosullar, yukumlulukler, ticari) | 4 sekme | Aynı 4 sekme, aynı URL değerleri; 6 yeni sekme eklendi | 2→2 | KALIR | `ContractLifecycle.tsx:19-21`, `:46-52` |
| W-13-02 | Bölünmüş görünüm: belge görüntüleyici + yan panel | İmza kontrolü | Aynı | 2→2 | KALIR | `SignatureWorkspace.tsx:84-86` |
| W-13-03 | Başlık: sürüm, aşama, yöntem, SHA-256 | İmza kontrolü | Aynı; üstüne kompakt kod/durum başlığı eklendi (N-06) | 2→2 | KALIR | `SignatureWorkspace.tsx:88-94` |
| W-13-04 | Uyarı bantları (yeni sürüm, görüntü bulunamadı, kontrol yapılamadı, arşiv) | İmza kontrolü | Aynı | 2→2 | KALIR | `SignatureWorkspace.tsx:97-100` |
| W-13-05 | "Durum" paneli | İmza kontrolü | Aynı | 2→2 | KALIR | `SignatureWorkspace.tsx:106-117` |
| W-13-06 | Taraflar ve gereksinimler; "Gereksinim / yöntem" çekmecesi | İmza kontrolü | Aynı | 2→3 (çekmece) → aynı | KALIR | `SignatureWorkspace.tsx:119-124`, `:375-410` |
| W-13-07 | Yuva başına "İncele" formu (karar, işaret, gerekçe, sayfa, AI adayı) | İmza kontrolü | Aynı | 2→3 → aynı | KALIR | `SignatureWorkspace.tsx:140`, `:157`, `:255-307` |
| W-13-08 | "E-imzayı doğrula" | İmza kontrolü | Aynı | 2→3 → aynı | KALIR | `SignatureWorkspace.tsx:147-151` |
| W-13-09 | "Tamamlanmak için" engel listesi | İmza kontrolü | Aynı | 2→2 | KALIR | `SignatureWorkspace.tsx:168-175` |
| W-13-10 | "Otomatik tarama" paneli, "Otomatik tarama iste" | İmza kontrolü | Aynı | 2→3 → aynı | KALIR | `SignatureWorkspace.tsx:177-195` |
| W-13-11 | "İstisnalar": talep çekmecesi, Onayla/Reddet | İmza kontrolü | Aynı | 2→3 → aynı | KALIR | `SignatureWorkspace.tsx:198-210`, `:310-349` |
| W-13-12 | "Fiziksel asıl" kayıt çekmecesi | İmza kontrolü | Aynı | 2→3 → aynı | KALIR | `SignatureWorkspace.tsx:215-222`, `:351-373` |
| W-13-13 | "İnceleme geçmişi" | İmza kontrolü | Aynı (Geçmiş sekmesi ayrıca denetim olaylarını gösterir, N-22) | 2→2 | KALIR | `SignatureWorkspace.tsx:224-233` |
| W-13-14 | "Yeni sürüm / zeyilname" çekmecesi | İmza kontrolü | Aynı | 2→3 → aynı | KALIR | `SignatureWorkspace.tsx:236`, `:413-447` |
| W-13-15 | "İmza kontrolünü kesinleştir" | İmza kontrolü | Aynı | 2→2 | KALIR | `SignatureWorkspace.tsx:238-246` |

### 1.4 Sözleşme detayı: Koşullar ve ihbar, Yükümlülükler, Fiyat/SLA/teminat

`ContractCommercial.tsx` değişmedi. `ContractLifecycle.tsx` yalnız sekme listesi, varsayılan sekme ve `NEW_PROJECT` kararı için değişti (`git diff --stat`: 33 satır değişti).

| id | İşlev | Eski yer | Yeni yer | Dokunuş | Durum | Kanıt |
|---|---|---|---|---|---|---|
| W-13-16 | "Ticari koşullar" görünümü (bedel, ödeme, süre, yenileme, ihbar, kaynak, revizyon) + boş durum | Koşullar ve ihbar | Aynı sekme; aynı alanlar ek olarak Özet'te "Sözleşme bilgileri" altında gösterilir (N-08) | 3→3 | KALIR | `ContractLifecycle.tsx:113-146` |
| W-13-17 | "Değiştir" / "Koşulları gir" formu → yeni revizyon | Koşullar ve ihbar | Aynı; ek yol: sihirbaz 3. adım "Tamamla ve doğrula" ve Özet "Alanları düzenle" (N-11) | 3→3 | KALIR | `ContractLifecycle.tsx:124-126`, `:206-254` |
| W-13-18 | Koşul doğrulaması "Doğrula" (ikinci kişi; giren doğrulayamaz) | Koşullar ve ihbar | Aynı | 3→3 | KALIR | `ContractLifecycle.tsx:139-145` |
| W-13-19 | "Değişiklik" paneli (önceki revizyona göre fark) | Koşullar ve ihbar | Aynı yerde (Faz 1 planı Geçmiş'e taşımayı öngörmüştü; taşınmadı, geriletmez) | 3→3 | KALIR | `ContractLifecycle.tsx:148-157` |
| W-13-20 | "İhbar son günü", uyarı tarihleri, "tatil listesi boş" uyarısı | Koşullar ve ihbar | Aynı + Hatırlatıcılar sekmesinde plan/gerçekleşen (N-23) | 3→3 | KALIR | `ContractLifecycle.tsx:165-181` |
| W-13-21 | "Yenileme kararı" (Yenile, Feshet, Yeniden müzakere + gerekçe) | Koşullar ve ihbar | Aynı kart; seçeneklere "Yeni proje açıldı" eklendi (eskiler aynen). Ayrıca Hatırlatıcılar sekmesinde aynı uca giden ikinci form (N-24) | 3→3 | KALIR | `ContractLifecycle.tsx:76`, `:182-200` |
| W-13-22 | Yükümlülük listesi + dönemler + boş durum | Yükümlülükler | Aynı sekme, aynı içerik (Faz 1 planı Hatırlatıcılar'a taşımayı öngörmüştü; taşınmadı) | 3→3 | KALIR | `ContractLifecycle.tsx:256-295` |
| W-13-23 | "Yükümlülük ekle" formu | Yükümlülükler | Aynı | 3→4 → aynı | KALIR | `ContractLifecycle.tsx:296-313` |
| W-13-24 | Dönem "Sonucu kaydet" (sonuç, not, kanıt) | Yükümlülükler | Aynı | 3→4 → aynı | KALIR | `ContractLifecycle.tsx:278`, `:279-292` |
| W-13-25 | Fiyat revizyonu: "Kural tanımla/değiştir" | Fiyat, SLA ve teminat | Aynı (Faz 1: SADELEŞİR; Faz 3 dokunmadı) | 3→3 | KALIR | `ContractCommercial.tsx:49-86` |
| W-13-26 | Fiyat revizyonu: "Revizyon öner" / "Onayla" | Fiyat, SLA ve teminat | Aynı | 3→3 | KALIR | `ContractCommercial.tsx:98-115` |
| W-13-27 | SLA: "SLA ekle" | Fiyat, SLA ve teminat | Aynı | 3→3 | KALIR | `ContractCommercial.tsx:122-161` |
| W-13-28 | SLA: "Dönem ölçümü gir", ölçüm Doğrula/Reddet | Fiyat, SLA ve teminat | Aynı | 3→3 | KALIR | `ContractCommercial.tsx:181-200` |
| W-13-29 | Teminat: "Teminat kaydet", "İade et" | Fiyat, SLA ve teminat | Aynı | 3→3 | KALIR | `ContractCommercial.tsx:210-251` |

### 1.5 Belge girişi ve belge detayı (sözleşme yönünden)

| id | İşlev | Eski yer | Yeni yer | Dokunuş | Durum | Kanıt |
|---|---|---|---|---|---|---|
| W-14-01 | Yükleme formu: Şirket, Belge türü, Dosya, "Yükle" | `/belge-girisi` | Sihirbaz 1. adım "Yükle": aynı `IntakeForm` (Şirket, Tür, Dosya) + Proje (zorunlu) + Şablon (isteğe bağlı) | 1→2 (Faz 1'de menüden kalkmıştı) | TAŞINDI | `ContractWizard.tsx:56-127`, `IntakePage.tsx` (`IntakeForm`) |
| W-14-02 | Fatura / Teklif / Diğer türünde yükleme | `/belge-girisi` | Aynı form türleri sihirbaz 1. adımında seçilebilir ve eskisi gibi çalışır; Fatura için ayrıca `/faturalar/yukle` duruyor | 1→2 / 1 | KALIR | `ContractWizard.tsx:77`, `App.tsx:50` |
| W-14-03 | "Belge yükleyebileceğiniz şirket yok" durumu | `/belge-girisi` | Sihirbazda aynı mesaj | 1→2 | TAŞINDI | `ContractWizard.tsx:67` |
| W-14-04 | Yükleme sonucu: mesaj, karantina, tekrar yükleme, antivirüs notu, "Belgeyi aç" | Sonuç kartı | Güvenlik kontrolü geçen sözleşme: taslak açılır, 3. adımda mesaj + antivirüs notu bandı; **geçmeyen belge**: eski sonuç kartı (karantina nedeni) aynen; aynı dosya ikinci kez yüklenirse yeni uyarı | 2→2 | TAŞINDI | `ContractWizard.tsx:105-120`, `:153-155` |
| W-14-05 | Tedarikçi eşleşme bandı, ünvan farkı, benzer isimler, "Tedarikçiyi aç" | Sonuç kartı | 3. adımda eşleşme bandı + tedarikçi seçici + "aday tedarikçi aç" | 2→2 | TAŞINDI | `ContractWizard.tsx:113-114`, `:154`, `:313-327` |
| W-15-01 | Belge sayfası: görüntüleyici + alanlar | `/belgeler/:id` | Rota aynı; sözleşme detayına Belge sekmesi eklendi (tam ekran görüntüleyici) | 1→1 | KALIR | `ContractOverview.tsx:202-214` |
| W-15-05 | "Çıkarılan alanlar" (alan, değer, köken, sayfa N) | `/belgeler/:id` | Aynı sayfa durur; sözleşme alanları sihirbaz 3. adımda belgeyle yan yana elle girilir (yapay zekâ okuması Faz 4) | 1→1 | KALIR | `ContractWizard.tsx:300-309` |
| W-18-06 | "Limit · sözleşme" paneli (tavan, tüketim, kullanılabilir) | Fatura detayı | Aynı; ayrıca sözleşme Özet'inde "Eşleşen faturalar" altında tüketim çubuğu (N-09) | 2→2 | KALIR | `ContractOverview.tsx:157-178`, `:104-111` |

### 1.6 iOS

| id | İşlev | Eski yer | Yeni yer | Dokunuş | Durum | Kanıt |
|---|---|---|---|---|---|---|
| I-00-02 | Bağlantı gelince bekleyen taslakların yüklenmesi | Tara | Aynı | 1→1 | KALIR | `ScanView.swift` (değişmeyen blok; fark yalnız `verifying`) |
| I-00-03 | Sekme çubuğu: İşlerim, Sözleşmeler, Tara (rozet), Tedarikçiler, Faturalar | Kök | Aynı | 1→1 | KALIR | `RootViews.swift:21-31` (değişmedi) |
| I-05-00 | Sözleşmeler listesi → imza kontrolü (Faz 1'de ayrı satırı yok; I-05-01 kanıtı) | Satır dokunuşu → `SignatureView` | Satır gövdesi özeti açar; **"İmza incelemesi" düğmesi satırın altında, tek dokunuşla** `SignatureView`'a gider. Aile kimliği yoksa (eski sunucu) satır eskisi gibi imzaya gider | 2→2 | TAŞINDI | `ContractsView.swift:21-38`, `:51-52` |
| I-01-02 | Görevden ekrana geçiş: contract_version → İmza kontrolü, invoice, incident, document_version | İşlerim | Aynı dört geçiş; dört yeni tür eklendi (N-37) | 2→2 | KALIR | `TasksView.swift:68-79` |
| I-02-01 | "Kamerayla tara" | Tara | Aynı | 1→1 | KALIR | `ScanView.swift` |
| I-02-02 | "Fotoğraflardan seç" | Tara | Aynı | 1→1 | KALIR | `ScanView.swift` |
| I-02-03 | "PDF dosyası seç" | Tara | Aynı | 1→1 | KALIR | `ScanView.swift` |
| I-02-04 | Önizleme şeridi: döndür, sil, düşük çözünürlük uyarısı | Tara | Aynı | 1→1 | KALIR | `ScanView.swift` |
| I-02-05 | Belge bilgisi: Başlık, Tür, Şirket | Tara | Aynı; sözleşme türünde yükleme sonrası "Alanları doğrula" çıkar (N-38) | 1→1 | KALIR | `ScanView.swift` |
| I-02-06 | "Taslak olarak kaydet ve yükle", "Vazgeç" | Tara | Aynı | 1→1 | KALIR | `ScanView.swift` |
| I-02-07 | Şifreli çevrimdışı taslak; yükleme sonucu mesajı | Tara | Aynı | 1→1 | KALIR | `ScanView.swift` |
| I-02-08 | "Taslaklar ve yüklemeler" listesi | Tara | Aynı; yüklenmiş sözleşme taslağı satırına düğme eklendi | 1→1 | KALIR | `ScanView.swift` |
| I-02-09 | Taslak işlemleri: Yükle/Tekrar yükle, Listeden kaldır, Sil | Tara | Aynı | 1→1 | KALIR | `ScanView.swift` |
| I-05-01 | İmza: durum, otomatik tarama, fiziksel asıl; uyarı metni | `SignatureView` | Aynı (dosya değişmedi) | 2→2 | KALIR | `SignatureView.swift` (fark yok) |
| I-05-02 | "Özgün belgeyi aç" (sürüm, hash) | `SignatureView` | Aynı | 2→2 | KALIR | `SignatureView.swift` |
| I-05-03 | Taraflar, imza yuvaları, "web'de yapılır" açıklaması | `SignatureView` | Aynı | 2→2 | KALIR | `SignatureView.swift` |
| I-05-04 | "Karar ver" sayfası (karar, işaret, sayfa, gerekçe ≥3; If-Match + belge SHA) | `SignatureView` | Aynı | 2→3 → aynı | KALIR | `SignatureView.swift` |
| I-05-05 | "Tamamlanmak için" engel listesi | `SignatureView` | Aynı | 2→2 | KALIR | `SignatureView.swift` |
| I-05-06 | Salt okunur durumlar; çevrimdışı karar kapalı | `SignatureView` | Aynı | 2→2 | KALIR | `SignatureView.swift` |

---

## 2. Yeni Faz 3 işlevleri (YENİ)

Eski envanterde karşılığı olmayan, Faz 3 ile eklenenler. Hepsi eskilere **ek** yoldur; hiçbiri eskinin yerine geçmez.

### 2.1 Liste ve başlık

| id | İşlev | Yer | Durum | Kanıt |
|---|---|---|---|---|
| N-01 | Listede kod, proje bağlantısı, bitiş, tutar sütunları ve v2 durum etiketi | Sözleşmeler | YENİ | `ContractsPage.tsx:133-148` |
| N-02 | "Şablonlar" düğmesi → şablon kütüphanesi | Sözleşmeler başlığı | YENİ | `ContractsPage.tsx:96` |
| N-03 | Departman süzgeci sunucuda uygulanır (sayfalamadan önce) | Sözleşmeler | YENİ (davranış) | `ContractsPage.tsx:72`, `:99` |
| N-04 | Durum süzgeci: Tümü, Onayda, Yürürlükte, 90 gün içinde biten, Eksik alan (sunucu sayılı, URL `durum`) | Sözleşmeler | YENİ | `ContractsPage.tsx:25-26`, `:53-65`, `:100-103` |
| N-05 | Proje detayında "Sözleşmeler" sekmesi: bağlı sözleşmeler (en çok 100), "Bu projeye sözleşme ekle" (proje dolu gelir), yetkisizde açıklama | Projeler > proje > Sözleşmeler | YENİ | `ProjectWorkspace.tsx:233`, `:693-722` |
| N-06 | Sözleşme başlığı: kod, durum etiketi, tedarikçi · proje · departman, "Belgeyi indir" | Sözleşme detayı (her sekmenin üstü) | YENİ | `ContractOverview.tsx:24-45` |

### 2.2 Ekleme sihirbazı (`/sozlesmeler/ekle`, 4 adım)

| id | İşlev | Yer | Durum | Kanıt |
|---|---|---|---|---|
| N-07 | Adım göstergesi: Yükle, Oku, Tamamla ve doğrula, İncele ve gönder; her adımda sıra ve odak başlığı | Sihirbaz | YENİ | `ContractWizard.tsx:22`, `:32-49`, `:152` |
| N-10 | 1. adım Yükle: proje (zorunlu, kapalı projeler hariç), kullanılan şablon (yalnız güncel sürüm), proje yoksa gönderim kapalı + neden | Sihirbaz 1 | YENİ | `ContractWizard.tsx:61-127` |
| N-10a | Taslak oluşturma (`/contract-drafts`); güvenlik kontrolü geçmeyen belgede taslak açılmaz | Sihirbaz 1→2 | YENİ | `ContractWizard.tsx:105-124` |
| N-10b | 2. adım Oku: yapay zekâ "Bağlı değil" açık durumu; sahte okuma yok | Sihirbaz 2 | YENİ | `ContractWizard.tsx:23`, `:156-163` |
| N-11 | 3. adım Tamamla ve doğrula: belge önizleme + alanlar yan yana; tedarikçi, aday tedarikçi (VKN denetimli), tür, sorumlu, departman; tarih, süresiz, yenileme, ihbar, para birimi, KDV esası, vade, ödeme; "belgeyle karşılaştırdım" onayı; Kaydet / Devam | Sihirbaz 3 | YENİ | `ContractWizard.tsx:233-387` |
| N-11a | Tutar biçimi 120.000,00 doğrulanır, decimal string olarak gönderilir | Sihirbaz 3 | YENİ | `ContractWizard.tsx:201`, `:343` |
| N-11b | Aynı belge başka sözleşmede varsa uyarı | Sihirbaz 3 | YENİ | `ContractWizard.tsx:155` |
| N-12 | 4. adım İncele ve gönder: sözleşme özeti, ön inceleme (Faz 4 notu), hatırlatıcı planı, onaycı sırası, ek onaycı ekle/çıkar, gönderim notu, "Taslağı kaydet", "Onaya gönder"; engel nedeni yazılır | Sihirbaz 4 | YENİ | `ContractWizard.tsx:428-522` |
| N-13 | Taslağa devam: `?taslak=<aile>&adim=3`; Özet ve Onaylar sekmelerinden "Alanları tamamla", "Doğrula ve gönder", "Düzenle ve yeniden gönder" | Özet, Onaylar | YENİ | `ContractOverview.tsx:76-98`, `:259-260` |

### 2.3 Sözleşme detayı: yeni sekmeler

| id | İşlev | Yer | Durum | Kanıt |
|---|---|---|---|---|
| N-08 | Özet sekmesi: sözleşme bilgileri, eksik alan bandı ("Alanları tamamla"), onaya gönder bandı, eski kayıt (LEGACY) bandı, taslak kaydedildi bandı, onay sonrası değişiklik notu | Sözleşme > Özet | YENİ | `ContractOverview.tsx:66-130` |
| N-09 | Özet: "Eşleşen faturalar" (aileye tahsisli faturalar, onay durumu) + tüketim/limit çubuğu; Faturalar listesine bağlantı | Sözleşme > Özet | YENİ | `ContractOverview.tsx:104-111`, `:132-178` |
| N-09a | Özet: onay zinciri özeti ("Onaylar" bağlantısı), hatırlatıcı planı ("Ayrıntı"), tedarikçi kartı ("Tedarikçi kartını aç") | Sözleşme > Özet | YENİ | `ContractOverview.tsx:113-127` |
| N-14 | Belge sekmesi: tam ekran görüntüleyici, dosya adı, sürüm, sayfa sayısı, "Belge kaydını aç" | Sözleşme > Belge | YENİ | `ContractOverview.tsx:202-214` |
| N-15 | İnceleme sekmesi: yapay zekâ ön incelemesi **Faz 4**; sahte puan/bulgu yok, açık boş durum | Sözleşme > İnceleme | YENİ (yer tutucu) | `ContractOverview.tsx:217-227` |
| N-16 | Onaylar sekmesi: onay zinciri (adım, durum, kim), önceki turlar (Geçmiş'te), gönderim notu, iptal nedeni | Sözleşme > Onaylar | YENİ | `ContractOverview.tsx:231-298` |
| N-17 | Onayla / Reddet (red gerekçesi ≥10 karakter), 409/403 hatasında güncel durum yeniden yüklenir | Sözleşme > Onaylar | YENİ | `ContractOverview.tsx:235-262`, `:272-290` |
| N-18 | Görev ayrılığı açıklaması: gönderen/ekleyen karar veremez; karar düğmeleri yalnız sıradaki onaycıya ve etkin vekiline | Sözleşme > Onaylar | YENİ | `ContractOverview.tsx:291` |
| N-19 | Reddedilince "Düzenle ve yeniden gönder" | Sözleşme > Onaylar | YENİ | `ContractOverview.tsx:292` |
| N-20 | "Onaya gönderildi" bandı (gönderimden sonra) | Sözleşme > Onaylar | YENİ | `ContractOverview.tsx:253` |
| N-21 | Onay sonrası koşul/sürüm değişirse kayıt Taslak'a döner; eski onaylı koşullarla hatırlatıcılar sürer (bilgi bandı) | Özet, Hatırlatıcılar | YENİ | `ContractOverview.tsx:55-64` |
| N-22 | Geçmiş sekmesi: zaman çizelgesi + denetim olayları (kim, ne, neden) | Sözleşme > Geçmiş | YENİ | `ContractOverview.tsx:416-463` |

### 2.4 Hatırlatıcılar

| id | İşlev | Yer | Durum | Kanıt |
|---|---|---|---|---|
| N-23 | Hatırlatıcılar sekmesi: dayanak (bitiş, ihbar son günü, süreler), plan listesi, gerçekleşen hatırlatıcılar (durum, atlama nedeni, görev, e-posta satırı), önceki koşullar için soluk gösterim | Sözleşme > Hatırlatıcılar | YENİ | `ContractOverview.tsx:300-392` |
| N-24 | Yenileme kararı formu (Yenilenecek, Feshet, Yeniden müzakere, Yeni proje açıldı; gerekçe ≥10 karakter; karar girilince açık hatırlatıcılar kapanır) | Sözleşme > Hatırlatıcılar | YENİ (W-13-21 ile aynı uç; eski form yerinde) | `ContractOverview.tsx:366-388` |
| N-25 | E-posta kanalı bağlı değilse açık bant: hatırlatıcı İşlerim'e görev düşer, e-posta kuyrukta | Sözleşme > Hatırlatıcılar | YENİ | `ContractOverview.tsx:332` |
| N-26 | Hatırlatıcı süreleri ayarı (varsayılan sürelerle; 1–6 değer, 1–365 gün, tekrarsız; kaydeden ve tarih görünür) | Yönetim > Şablonlar (yalnız ADMIN) | YENİ | `TemplatesPage.tsx:81`, `:171-200` |

### 2.5 Şablonlar

| id | İşlev | Yer | Durum | Kanıt |
|---|---|---|---|---|
| N-27 | Şablon kütüphanesi: tablo/kart, sürümler, indir | Sözleşmeler > Şablonlar (`/sozlesmeler/sablonlar`) | YENİ | `TemplatesPage.tsx:19-84`, `App.tsx:207` |
| N-27a | Şablon yükle (.docx), yeni sürüm yükle (sürüm formu, sürüm geçmişi); yönetici: ADMIN, PROCUREMENT | Şablonlar | YENİ | `TemplatesPage.tsx:78`, `:121-170`, `:22` |
| N-27b | "Yeni sözleşmede kullan" → sihirbaz 1. adımı şablon dolu açılır | Şablonlar | YENİ | `TemplatesPage.tsx:100`, `ContractWizard.tsx:91-97` |
| N-28 | Yönetim > Şablonlar sekmesi: Faz 1'deki "Faz 3'te gelir" yer tutucusu yerine aynı kütüphane (yönetici görünümü) | Yönetim > Şablonlar | YENİ (yer tutucuyu doldurur) | `AdminPages.tsx:81`, `App.tsx:221` |

### 2.6 İşlerim yönlendirmesi

| id | İşlev | Yer | Durum | Kanıt |
|---|---|---|---|---|
| N-29 | Menü sayacı yeni görev türlerini sayar | Menü > Sözleşmeler | YENİ | `App.tsx:127` |
| N-30 | `contract_approval_step` → `/sozlesmeler/onay-adimi/:id` (güncel onaycıysa Onaylar sekmesi; adım artık sizi beklemiyorsa açıklama + İşlerim'e dön) | İşlerim | YENİ | `WorkPage.tsx:22`, `ContractOverview.tsx:465-491`, `App.tsx:209` |
| N-31 | `contract_reminder` → `/sozlesmeler/aile/:id?sekme=hatirlaticilar` | İşlerim | YENİ | `WorkPage.tsx:23`, `App.tsx:208` |
| N-32 | `contract_rejection`, `contract_family` → `?sekme=onaylar` (ret, yeniden gönderim) | İşlerim | YENİ | `WorkPage.tsx:24` |

### 2.7 iOS

| id | İşlev | Yer | Durum | Kanıt |
|---|---|---|---|---|
| N-33 | Sözleşme özeti (`ContractSummaryView`): başlık kartı, durum, eksik alanlar, onay zinciri, belgeyi aç, "İmza incelemesi", "Onay kararı ver", "Düzelt ve yeniden gönder / Alanları tamamla ve onaya gönder"; koşul/yükümlülük/ticari/hatırlatıcı için "web'de" notu | Sözleşmeler > satır | YENİ | `ContractApprovalView.swift:287-335`, `ContractsView.swift:24-33` |
| N-34 | Sözleşme onayı (`ContractApprovalView`): ön inceleme boş durumu (Faz 4), onay zinciri, belge, Onayla (onay penceresiyle), Reddet (gerekçe sayfası) | İşlerim > onay görevi; özet > "Onay kararı ver" | YENİ | `ContractApprovalView.swift:7-160` |
| N-35 | Alanları doğrula (`ContractFieldsView`): proje (zorunlu), departman, tedarikçi/aday tedarikçi, tür, sorumlu, tarihler, süresiz, yenileme, ihbar, para birimi, KDV esası, "belgeyle karşılaştırdım" | Tara > yüklenen sözleşme taslağı; özet > düzelt | YENİ | `ContractFieldsView.swift:6-155` |
| N-36 | İncele ve gönder (iOS): eksikler, onay zinciri, vekile gönder anahtarı, "Onaya gönder" | `ContractFieldsView` 4. ekran | YENİ | `ContractFieldsView.swift:287-334` |
| N-37 | İşlerim: görev türü etiketi (Sözleşme onayı, Reddedilen sözleşme, Yeniden onaya gönderin, Sözleşme bitişi), "Onayınızı bekliyor" rozeti; yeni türler ekranı açar (contract_approval_step, contract_rejection, contract_family, contract_reminder) | İşlerim | YENİ | `TasksView.swift:41-55`, `:68-79` |
| N-38 | Tara: yüklenen sözleşme için "Alanları doğrula" / "Sözleşme taslağına devam et" düğmesi (yalnız `contract.manage` rollerinde; diğerlerinde eski davranış) | Tara > taslak satırı | YENİ | `ScanView.swift` (fark: `canManageContracts`, `onVerify`) |

---

## 3. Gerileme kontrolü

### 3.1 Sonuç

**Bulunan gerileme: 0** (kod okumasıyla). Kaldırılan, gizlenen ya da ek dokunuş isteyen eski işlev yok. Sözleşme ile ilgili 0 satır "KALKAR" olarak işaretlendi.

### 3.2 Bilinçli ve kabul edilmiş sapmalar (gerileme sayılmaz)

| # | Sapma | Neden gerileme değil |
|---|---|---|
| S-1 | Sözleşme detayında varsayılan sekme **İmza kontrolü** kalır; Figma ilk sekme olarak **Özet**'i gösterir. | Kullanıcı tarafından kabul edildi. Eski adresler ve İşlerim bağlantıları eskisi gibi imza çalışma alanını açar (`ContractLifecycle.tsx:26`). Özet 1 tıkla erişilir. Sekme sırası Özet ilk, İmza kontrolü beşinci ama varsayılan değil. |
| S-2 | Faz 1 planındaki "İmzalar" adı yerine sekme **"İmza kontrolü"** adı korundu; ayrı "Faturalar" sekmesi yok, faturalar Özet'in içinde. | Eski sekme adı ve `?sekme=` değerleri aynen kaldı; faturalar Özet'te 1 tık ve `/faturalar` bağlantısıyla erişilir. Plan sapması, işlev kaybı değil. |
| S-3 | Faz 1'in "Yükümlülükler → Hatırlatıcılar" ve "Değişiklik paneli → Geçmiş" taşıma önerileri uygulanmadı. | Her iki işlev kendi v1 sekmesinde duruyor (dokunuş sayısı değişmedi). Sonraki fazda taşınırsa bu envanter yeniden doğrulanmalı. |
| S-4 | Liste tablosunda dört imza sütunu tek hücrede. | Aynı veri ve aynı vurgu (asıl bekleniyorsa uyarı rengi); dar ekran kartı zaten eskiden de özet göstermişti. Bilgi kaybı yok. |
| S-5 | iOS listesinde satır dokunuşu artık özeti açar; imza ekranı satır altı düğmeyle açılır. | İmzaya hâlâ tek dokunuş; aile kimliği olmayan satır eskisi gibi doğrudan imzaya gider. |
| S-6 | Yenileme kararı iki yerde (Koşullar ve ihbar, Hatırlatıcılar). | Aynı uç; karar bir kez girilir, iki yerde de görünür. Eski yer korundu. |

### 3.3 Risk notları (gerileme değil, canlıda doğrulanacak)

1. **EN dili:** Faz 3 ekranlarının İngilizce karşılığı kod okumasıyla doğrulanmadı; persona yürüyüşünde TR ve EN ayrı ayrı bakılacak.
2. **Rol bazlı görünürlük:** Onay düğmeleri, "Sözleşme ekle", Şablon yönetimi ve hatırlatıcı süre ayarı rol ve yetkiyle kapılı (`ContractOverview.tsx:272`, `ContractsPage.tsx:97`, `TemplatesPage.tsx:22-23`, `:81`). Her rolün eski erişimini koruduğu persona yürüyüşünde (LEGAL kalktı; K-11 kararı Satınalma) doğrulanacak.
3. **İmza çalışma alanı** dosyası değişmediği için kod düzeyinde risk yok; ancak yeni başlık (`ContractHeader`) üstüne eklendiğinden dikey alan daraldı: dar ekran ve yakınlaştırmada bölünmüş görünüm taşması canlı bakılacak.
4. **iOS:** simülatör yürüyüşü (Tara → "Alanları doğrula", onay görevi, özet, imza düğmesi) henüz yok; eski satırların `[x]` kanıtı Faz 1 yürüyüşünden gelir, Faz 3 sonrası yeniden görülmedi.
5. **Testler:** Bu belge test çalıştırmadı. "Bitti" için `npm test -w @sp/domain`, `npm test -w @sp/api`, `npm run typecheck`, `npm run e2e -w @sp/web` sonuçları ayrıca kanıtlanmalı.

### 3.4 Sayım

Sayılar tablolardaki satırlardan betikle sayıldı.

| Küme | Adet |
|---|---|
| Eski satır (önce) | 69 |
| KALIR | 62 |
| TAŞINDI | 7 (M6, W-12-02, W-14-01, W-14-03, W-14-04, W-14-05, I-05-00) |
| KALKAR / erişilemez / daha çok dokunuş | 0 |
| Yeni satır (N-, alt harfliler ayrı satır) | 45 |
| Bulunan gerileme | 0 |
