# Faz 4 (Yapay zekâ) işlev envanteri: önce / sonra

Tarih: 17.11.2026. Dal: `v2-sadelestirme`. Kural: SIFIR GERİLEME (global CLAUDE.md, 07.11.2026).

**Önce:**
- v1 yapay zekâ işlevleri: `docs/envanter-faz1.md` bölüm 3.22 (W-22-01..05) ve menü satırı M11; belge girişinde fatura alan okuma (AI02) ve `GET /document-versions/:id/ai-fields` (v1 kodu; Faz 1 envanterinde ayrı satırı yok, kod taramasıyla eklendi: A-06, A-07).
- Faz 3 yapay zekâ boş durumları: `docs/envanter-faz3.md` N-10b (Oku adımı), N-12 (ön inceleme notu), N-15 (İnceleme sekmesi), N-34 (iOS onay ekranı).

**Sonra:** Faz 4 sonu kodu: `apps/web/src/pages/{EvaluationPages,ContractWizard,ContractReview,ContractOverview,ContractLifecycle}.tsx`, `ios/Satinalma/Satinalma/Features/{ContractFieldsView,ContractApprovalView,ContractReviewView}.swift`, `apps/api/src/modules/{ai,contractAi}.ts`. Satır numaraları bu kodundur.

## Doğrulama yöntemi ve sınırı

Satırlar **kod okumasıyla** hazırlandı (eski yer: Faz 1/3 envanterleri ve `git show 5bfb78c:<dosya>`; yeni yer: güncel dosyalar). **Canlı yürüyüş kanıtı** `.superpowers/sdd/2026-11-17-v2-faz4-yapay-zeka/persona-report.md` dosyasından gelir: A1–A8 senaryolarının hepsi PASS (web + iOS, rol başına: departman kullanıcısı, onaycı, yönetici, denetçi). Aynı raporun sınırları aynen geçerlidir:
- Tüm yapay zekâ çıktıları **test sağlayıcısı** (`test-fixture`) çıktısıdır; gerçek okuma/inceleme değildir, doğruluk ölçümü NOT_RUN.
- NOT_RUN: web "Dosya" seçici otomasyonu (aynı uçlar API ile çağrıldı), önizlemenin hedef sayfaya kaydığının görsel doğrulaması ve "Onaycı ekle" odak taşıması, iOS'ta alan kaydetme/gönderme, onay zincirinin 3. adımı ve kesinleşme.
- Dil: Faz 4 ekranlarındaki sabit metin Türkçedir; EN katmanı bu envanterde ve persona raporunda yürünmedi. Kod okumasıyla "EN tamam" denmez (açık kalem, aşağıda "Gerileme kontrolü").
- Persona raporundaki K1–K3, K5–K7 düzeltmeleri `83bdb47` ile kodda; bu envanter o koda göre yazıldı. Düzeltmelerin canlı yeniden yürüyüşü yapılmadı (K4 test sağlayıcısı sınırı, düzeltilmedi).

Durum anlamları: **KALIR** = işlev aynı yerde, aynı dokunuşla, aynı davranışla; **DÖNÜŞTÜ** = aynı yerde ya da aynı rolle ama biçimi/içeriği değişti, eski bilginin tamamı erişilebilir; **TAŞINDI** = yeri değişti, erişim en az eskisi kadar kolay. Dokunuş = sol menüden işleve varmak için tıklama sayısı.

---

## 1. Eski işlevler (önce → sonra)

### 1.1 Yönetim > Yapay zekâ (v1 `/yapay-zeka`)

Rota: `/yapay-zeka` → `/yonetim/yapay-zeka` yönlendirmesi (`App.tsx:244`); sekme `AdminPages.tsx:27` (ADMIN, PROCUREMENT, AUDITOR); sayfa `AiPage` (`EvaluationPages.tsx:548`). Sol menü "Yönetim" girişi `App.tsx:147`. Yönetim'e giriş ve sekme Faz 1'de (M11, DÖNÜŞÜR kararı) yapıldı; Faz 4 bu yolu değiştirmedi. Dokunuş "v1 → Faz 4": v1'de menüden 1, şimdi Yönetim + "Yapay zekâ" sekmesi 2 (Faz 1'in onaylı taşıması; eski adres yönlenir).

| id | İşlev | Eski yer | Yeni yer | Dokunuş önce→sonra | Durum | Kanıt (dosya:satır) |
|---|---|---|---|---|---|---|
| A-01 | "Görev matrisi" (görev kodu + ad, önce kural, insan kontrolü) | v1 `/yapay-zeka`, `EvaluationPages.tsx:499-501` (W-22-01) | Yönetim > Yapay zekâ, aynı panel; matris AI01–AI15'i listeler | 1→2 (Faz 1 taşıması; Faz 4'te +0) | KALIR | `EvaluationPages.tsx:588-590` |
| A-02 | "Son çalıştırmalar" (tarih, kim, görev, belge sürümü bağlantısı, model, durum, sebep, ücret, denetim bayrakları) | W-22-02, `:502-510` | Aynı yer; panel "Çağrı defteri · son çalıştırmalar" oldu, sütunlar eklendi (istem sürümü, token giriş/çıkış, test sağlayıcısı etiketi). Eski sütunların hepsi duruyor | 1→2 (Faz 1; Faz 4'te +0) | DÖNÜŞTÜ | `EvaluationPages.tsx:591-617` (sütunlar `:597`) |
| A-03 | "Yeniden dene" (bekleyen kota/sağlayıcı/izin işi) | W-22-02 | Aynı hücrede; koşul genişledi: AI15 hariç, sözleşme görevlerinde (AI06/AI14) yalnız `contract.ai.request` rolü (Satınalma, Departman kullanıcısı) | 1→2 (Faz 1; Faz 4'te +0) | KALIR (v1 görevleri için birebir) | `EvaluationPages.tsx:562`, `:612-613`; `ai.ts:101-112`; `server.ts:1393` |
| A-04 | Kiracı politikası: görüntüle (sağlayıcı, bölge, aylık bütçe, günlük çağrı), "Düzenle" (+ yükseltme izni) | W-22-03, `:512-518, 533-548` | Aynı panel (sağ sütun) | 1→2 (Faz 1; +0) | KALIR | `EvaluationPages.tsx:623-630`; `ai.ts:347`; `server.ts:1387` |
| A-05 | Kiracı politikası "Kaldır" (politika yokken ücretli AI kapalı) | W-22-03 | Aynı düğme, yalnız politika varken | 1→2 (Faz 1; +0) | KALIR | `EvaluationPages.tsx:624`; `ai.ts:359`; `server.ts:1392` |
| A-06 | "Kullanım" paneli (bu ay harcama, bugünkü çağrı, %80/%100 uyarı notu) | W-22-04, `:520-522` | Aynı panel; ay harcaması 2 ondalıkla (kesin değer `title`'da, persona K7) | 1→2 (Faz 1; +0) | DÖNÜŞTÜ | `EvaluationPages.tsx:647-649` |
| A-07 | "Model kaydı" (sağlayıcı/model, sürüm, kapalı, bağdaştırıcı yok, görevler, yetenekler, bölge, eğitim durumu) | W-22-05, `:523-529` | Aynı panel; test sağlayıcısı satırında etiket eklendi | 1→2 (Faz 1; +0) | KALIR | `EvaluationPages.tsx:650-657` |
| A-08 | Yetki: `ai.read` herkes görür; `ai.policy.manage` yalnız yönetici düzenler | `server.ts` v1 uçları | Aynı | — | KALIR | `server.ts:1379`, `:1387`, `:1392`; `d.can.manage` `:623` |
| A-09 | Eski adres `/yapay-zeka` ve görevden "tenant" hedefi (W-01-05) | `/yapay-zeka`, İşlerim `entityHref` | `/yonetim/yapay-zeka`'ya yönlenir | 1→1 (bağlantıdan) | KALIR | `App.tsx:244` |

### 1.2 Belge girişinde fatura alan okuma (AI02)

| id | İşlev | Eski yer | Yeni yer | Dokunuş önce→sonra | Durum | Kanıt |
|---|---|---|---|---|---|---|
| A-10 | Fatura PDF'i yüklenince AI02 isteği yönlendirme kapısından geçerse kuyruğa girer; kapı kapalıysa "manuel alan girişi" görevi sürer; sonuç iletisi "AI okuması kuyrukta…" / "Otomatik okuma yapılamadı…" | v1 belge girişi (kind FATURA), `documents.ts` | Aynı kod yolu; sonuç iletisi Fatura yükle ekranında (Faz 1/3 konumu `/faturalar/yukle`, `IntakePage kind="INVOICE"`). Faz 4 bu yolu değiştirmedi | 0 (Faz 4 dokunuşu değiştirmedi) | KALIR | `documents.ts:152-165`; `ai.ts:23` (AI02 alanları); `App.tsx:227`; `IntakePage.tsx:121` |
| A-11 | `GET /document-versions/:id/ai-fields` (belge sürümünün AI alanları: alan, değer, güven, inceleme durumu, kaynak, görev, çalışma durumu) | v1 API (arayüzde çağıran yoktu) | Aynı uç, aynı yetki (`document.read`) | API 1→1 | KALIR | `server.ts:1395`; `ai.ts:365-369` |

### 1.3 Faz 3 yapay zekâ boş durumları

| id | İşlev | Eski yer (Faz 3 boş durumu) | Yeni yer (Faz 4 gerçek içerik) | Dokunuş önce→sonra | Durum | Kanıt |
|---|---|---|---|---|---|---|
| A-12 | Oku adımı: "Bağlı değil", sahte okuma yok (N-10b) | Sihirbaz 2. adım, `ContractWizard.tsx:23,156-163` (Faz 3) | Aynı adım: okuma çalışırsa "Okunan alanlar" (değer, güven, 1. sayfa, alıntı, "siz onaylarsınız"); çalışmazsa sebep metni (`aiReadLine`: politika yok, sağlayıcı yok, başarısız, durum alınamadı) ve "Alanları elle girin" düğmesi; "Yeniden oku". Boş durumun söylediği her şey (sahte değer yok, elle akış açık) korunur | 2→2 | DÖNÜŞTÜ | `ContractWizard.tsx:27-35` (`aiReadLine`), `:186-285` (ReadStep), `:168` (adım çubuğunda "okunmadı") |
| A-13 | Ön inceleme notu 4. adımda "Faz 4" (N-12) | Sihirbaz 4. adım | Aynı adım: `ReviewCard` (puan, alt puanlar, bulgular, eşik uyarısı + "Onaycı ekle", sağlayıcı/model/istem, yoksa durum etiketi "Çalışmayacak"/"Bekliyor"); gönderim her durumda açık, yalnız karar bekleyen kritik öneri engeller | 3→3 | DÖNÜŞTÜ | `ContractWizard.tsx:703-707`, `:738`; `ContractReview.tsx:198-260` |
| A-14 | İnceleme sekmesi: sahte puan/bulgu yok, açık boş durum (N-15) | Sözleşme > İnceleme, `ContractOverview.tsx:217-227` (Faz 3) | Aynı sekme: `ReviewDetail` (puan, alt puanlar, bulgu listesi + önem süzgeci, alıntı, şablon atfı, sayfa bağlantısı, geçmiş incelemeler); inceleme yoksa/çalışmıyorsa `RunState` ve sebep (boş durum ilkesi sürer) | Sözleşme > İnceleme: 2→2 | DÖNÜŞTÜ | `ContractOverview.tsx:225-231`; `ContractReview.tsx:276-375`; sekme `ContractLifecycle.tsx:19,49` |
| A-15 | iOS onay ekranı ön inceleme boş durumu (N-34) | `ContractApprovalView.swift` (Faz 3 boş durum) | Aynı ekranda "Ön inceleme" bölümü: `ReviewInfoCard` (puan, en önemli 3 bulgu, uyarı metni, "Tüm bulgular (N)", "Geçmiş incelemeler"); alınamazsa "Ön inceleme alınamadı… Belgeyi kendiniz inceleyin." ve onay/ret düğmeleri etkilenmez | İşlerim > görev > onay ekranı: aynı | DÖNÜŞTÜ | `ContractApprovalView.swift:40`, `:81`; `ContractReviewView.swift:187-262` |

**Eski satır sayısı: 15** (A-01..A-15).

---

## 2. Yeni Faz 4 işlevleri

| id | İşlev | Yer | Kanıt (dosya:satır) |
|---|---|---|---|
| N4-01 | Sözleşme alan okuma isteği (AI06): taslak açılınca kuyruğa girer; "Yeniden oku" (yalnız başarısız/bekleyen iş; çalışmış iş yeni ücret yaratmaz); `contract.ai.request` yetkisi | Web Sihirbaz 2; API | `contractAi.ts:47-58`; `server.ts:784-786`; `ContractWizard.tsx:196-199` |
| N4-02 | Okunan alanlar: değer, güven, kaynak sayfa, alıntı; okunamayan "Okunamadı"; kritik alanda "siz onaylarsınız"; sayfa bağlantısı belge önizlemesini o sayfaya götürür + alıntı bandı | Web Sihirbaz 2; API `GET …/extractions` | `ContractWizard.tsx:205-212`, `:224-232`; `contractAi.ts:123`; `server.ts:781` |
| N4-03 | "Test sağlayıcısı — gerçek değil" etiketi her AI çıktısında (okuma, inceleme, defter, sağlayıcı kartı) | Web + iOS | `ContractReview.tsx:102`; `ContractReviewView.swift:86-98`; `EvaluationPages.tsx:506`; `ai.ts:302` |
| N4-04 | Tamamla ve doğrula'da öneri satırı: öneri + sayfa + güven, "Öneriyi kullan", "Yoksay"; kritik alanlar (tutar, para birimi, tarihler, VKN) forma yazılmaz; kritik olmayan öneri "Yapay zekâ" etiketiyle önceden dolar; "N kritik öneri kararınızı bekliyor" | Web Sihirbaz 3 | `ContractWizard.tsx:401`, `:494-527`, `:545-546` |
| N4-05 | Karar kaydı: Onaylandı / Düzeltildi / Yoksayıldı alan kaydıyla yazılır (karar veren kullanıcı, sayfa) | API `applyAiDecisions`, `reconcileConfirmed` | `contractAi.ts:207`, `:241`; `ContractWizard.tsx:381-399` |
| N4-06 | Göndermeden önce karar bekleyen kritik öneri engeli: istemci notu + sunucu `ai_suggestions_pending` 422 + "Önerilere karar ver" düğmesi | Web Sihirbaz 4; API | `ContractWizard.tsx:703-707`, `:732`; `contractAi.ts:260-267` |
| N4-07 | VKN önerisi: aday tedarikçi formunu VKN ile açar; kayıtlı kart varsa düğme "Mevcut kartı seç" (persona K6) | Web Sihirbaz 3; iOS; API `existingSupplier` | `ContractWizard.tsx:426`, `:569`; `contractAi.ts:139`; `ContractFieldsView.swift:857-887` |
| N4-08 | K1: ihbar süresi, bitiş boşken ve süresiz değilken önceden doldurulmaz; "önce bitiş tarihini girin ya da süresiz işaretleyin" notu | Web + iOS; domain | `83bdb47` (commit); `ContractWizard.tsx:343-345`, `:371-372`; `ContractFieldsView.swift:372`, `:670` |
| N4-09 | Sözleşme ön incelemesi (AI14): puan, 11 alt puan, bulgu (önem, tür, kategori, alıntı, sayfa, şablon atfı, öneri), genel yorum, köken (model, istem, puan kuralı); kaynağı doğrulanamayan bulgu ayrı işaretlenir | Web İnceleme sekmesi + 4. adım kartı; API | `ContractReview.tsx:198-262`, `:276-375`; `contractAi.ts:313`, `:429` |
| N4-10 | "İncele" / "Yeniden incele" (çalışmış iş yeni ücret yaratmaz); eski belge/şablon sürümünde "Bu inceleme güncel değil" bandı | Web İnceleme sekmesi, 4. adım kartı; API | `ContractReview.tsx:253`, `:299-302`; `server.ts:791-793` |
| N4-11 | Bulgu süzgeci (önem) ve bulgudan belge sayfasına geçiş (`?sekme=belge&sayfa=N`) | Web İnceleme → Belge sekmesi; iOS bulgu satırı | `ContractReview.tsx:329-347`; `ContractOverview.tsx:208-210`; `ContractReviewView.swift:131-160`, `:316-324` |
| N4-12 | Geçmiş incelemeler tablosu (tarih, şablon, model, güncel/güncel değil) | Web İnceleme sekmesi; iOS "Geçmiş incelemeler" | `ContractReview.tsx:353-366`; `ContractReviewView.swift:218` |
| N4-13 | Eşik (kiracı ayarı, varsayılan 60): puan eşik altındaysa "ek onaycı önerilir" + "Onaycı ekle" kısayolu; öneri zorunlu değil, gönderim engellenmez, puan onay vermez | Web 4. adım; iOS gönderim kartı; API | `ContractReview.tsx:225-227`; `ContractWizard.tsx:738`; `ContractReviewView.swift:229`, `:388-418`; `ai.ts:311-319` |
| N4-14 | Yönetim > Yapay zekâ: "İnceleme eşiği" formu (0–100, "Eşiği kaydet"; yalnız yönetici; son değiştiren/zaman) | Web Yönetim | `EvaluationPages.tsx:632-646`; `server.ts:1382-1386`; `ai.ts:312-327` |
| N4-15 | Yönetim > Yapay zekâ: "Model ve sağlayıcı" kartı (model adı salt okunur `AI_MODEL_ID`, sağlayıcı etiketi, dış API uyarısı, bu ay harcanan/bütçe), "Etkin AI sağlayıcısı yok" / "Yalnız test sağlayıcısı etkin" bandı | Web Yönetim | `EvaluationPages.tsx:566-571`, `:573-584`; `ai.ts:304`, `:329` |
| N4-16 | Yönetim > Yapay zekâ: "Doğruluk ölçümü: Ölçülmedi (NOT_RUN)" paneli ve "Kalite ölçümü yapılamadı" bandı; "okuyor" demek ölçüme bağlı | Web Yönetim | `EvaluationPages.tsx:571`, `:618-622`; `ai.ts:310` |
| N4-17 | Çağrı defterinde sözleşme görevleri (AI06/AI14) ve "izin yok" satırları (politika tanımlı değil) sebebiyle; defter işaretleri Türkçe (persona K7: alan:KOD, findingN:KOD) | Web Yönetim | `EvaluationPages.tsx:591-617` |
| N4-18 | Onaycıya ön inceleme bilgisi: "Ön inceleme (bilgi)", puan/eşik, "Onay kararınızı etkilemez", "Bulguları gör" | Web Onaylar sekmesi; iOS onay ekranı | `ContractOverview.tsx:268`; `ContractReview.tsx:385-399`; `ContractApprovalView.swift:40` |
| N4-19 | K3: eşik altı puanla gönderen kişinin onayı kayda geçer (puan, o anki eşik, gönderen, zaman); onaycı "Gönderen, eşik altı puanı … onaylayarak gönderdi." görür | Web Onaylar/İnceleme; iOS; API | `contractAi.ts:391`, `:480`; `ContractReview.tsx:376-384`; `ContractReviewView.swift:239` |
| N4-20 | K2: şablon seçilmeden türün güncel şablonuyla yapılan incelemede "Kullanılan şablon" ve otomatik seçim notu | Web özet/inceleme kartı; iOS; API | `contractAi.ts:383`; `ContractWizard.tsx:664`; `ContractReview.tsx:235` |
| N4-21 | K5: politika/sağlayıcı yokken inceleme etiketi "Çalışmayacak", metin "Ön inceleme çalışmayacak: …"; gönderim açık | Web + iOS | `ContractReview.tsx:61-80`; `ContractReviewView.swift:47`, `:259` |
| N4-22 | Salt okur rol (denetçi): İnceleme ve okuma sonuçlarını görür; isteme/yeniden isteme/eşik değiştirme sunucuda 403 | Web + API | `server.ts:788-793`; `contractAi.ts:313`; persona A7 |
| N4-23 | iOS Alanları doğrula: "Yapay zekâ okuması" kartı (durum, test etiketi, "N kritik öneri kararınızı bekliyor"), öneri satırı (değer, sayfa, güven, alıntı), "Öneriyi kullan", "Yoksay", "Geri al", "N. sayfa" önizlemesi | iOS Tara/Özet > Alanları doğrula | `ContractFieldsView.swift:379-420`, `:579-605`, `:618-680` |
| N4-24 | iOS İncele ve gönder: ön inceleme kartı (`ReviewSubmitCard`), gönderimde karar bekleyen kritik öneri notu | iOS 4. ekran | `ContractFieldsView.swift:360-362`, `:807`, `:816`; `ContractReviewView.swift:388-418` |
| N4-25 | iOS "Ön inceleme" tam ekranı: puan, alt puanlar, bulgu listesi + önem süzgeci, genel yorum, köken, geçmiş; özet satırı "Ön inceleme: N / 100" | iOS Özet > Ön inceleme; Onay > "Tüm bulgular" | `ContractReviewView.swift:266-351`; `ContractApprovalView.swift:314`, `:347-362` |
| N4-26 | Sözleşme dışı kanıt okuma (AI15 kanıt okuması) kayıt ucu | API | `contractAi.ts:497`, `:541` |

**Yeni satır sayısı: 26** (N4-01..N4-26).

---

## 3. Gerileme kontrolü

Yöntem: her eski satır (A-01..A-15) için yeni yerde işlev, giriş, durum ve rol tek tek kod okumasıyla bulundu (Bölüm 1 kanıt sütunu). Canlı karşılık: persona raporu A5 (v1 öğeleri duruyor: Görev matrisi AI01–AI15, Kiracı politikası Düzenle/Kaldır, Kullanım, Model kaydı), A6 (politika kapalıyken elle akış sürer), A3/A4 (ön inceleme gönderimi/onayı engellemez), A8 (iOS).

**Faz 4'ün neden olduğu gerileme: 0.** Erişilemez ya da dokunuşu artan eski işlev yok.

Not edilen, gerileme sayılmayanlar:
1. **Yapay zekâ sayfasına dokunuş 1→2** (A-01..A-07, A-09): v1'de menüden doğrudan, şimdi Yönetim > Yapay zekâ. Bu **Faz 1'in onaylı taşıması** (M11, DÖNÜŞÜR; Faz 1 envanteri 3.22). Faz 4 ek dokunuş katmadı; eski adres yönleniyor (`App.tsx:244`). Faz 1 envanterinde zaten kayıtlıdır; yeni karar gerektirmez, ama "dokunuş artmaz" kuralının harfiyen istisnası olarak bilinsin.
2. **Faz 3 boş durumları (A-12..A-15)** gerçek içerikle değişti; boş durumun garantileri korunuyor: sahte değer/puan yok, elle akış her zaman açık, ön inceleme alınamazsa onay ve gönderim düğmeleri etkilenmez (`ContractApprovalView.swift:81`, `ContractWizard.tsx:706`).
3. **"Yeniden dene" koşulu (A-03)** sözleşme görevleri için role bağlandı (AI06/AI14 yalnız Satınalma/Departman kullanıcısı; AI15 buradan yok). Bu görevler Faz 4'te doğdu; v1'de var olan hiçbir görev (AI02 vb.) için erişim daralmadı.
4. **Eski sütun/panel içerikleri**: A-02, A-06 yalnız genişledi ya da sayı biçimi değişti (2 ondalık; kesin değer `title`'da); hiçbir eski alan çıkarılmadı.

Açık kalemler (iş bitmemiştir listesine girer; gerileme değil, doğrulanmamış):
- **EN katmanı**: Faz 4 ekranları sabit Türkçe; TR+EN eksiksiz kuralı için EN yürüyüşü ve çeviri yapılmadı (persona raporunda da yok).
- **NOT_RUN adımlar** (persona raporu): web dosya seçici, önizleme sayfa kaydırmasının görsel doğrulaması, "Onaycı ekle" odak taşıması, iOS kaydet/gönder, 3. adım ve kesinleşme.
- **Düzeltme sonrası yeniden yürüyüş**: K1–K3, K5–K7 (`83bdb47`) canlı yeniden yürünmedi; K4 (test sağlayıcısı satır birleştirme, kritik olmayan önerinin CONFIRMED yazılması) açık.
- **A-10/A-11** (AI02, `ai-fields`) bu fazda canlı yürünmedi; yalnız kodun değişmediği doğrulandı.
- Gerçek sağlayıcıyla hiçbir ölçüm yok (NOT_RUN); "çalışıyor" iddiası yalnız test sağlayıcısı için geçerli.
