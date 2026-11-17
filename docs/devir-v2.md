# v2 devir notu (16.11.2026)

Bu not, önceki oturumun bağlamını yeni oturuma taşır. Önce bunu, sonra `docs/analiz-v2.md`, `docs/implementation-status.md`, `docs/decisions.md`, `DESIGN.md` oku.

Önceki oturumun tam dökümü (ayrıntı gerekirse aranır, baştan okunmaz):
`/Users/server/.claude/projects/-Users-server-projects-satinalma-platform/2c4c80fe-82c0-473a-a7f6-8185667019e5.jsonl`

## Nerede kaldık

1. D83–D92 düzeltmeleri `faz-0-2-ve-dagitim` dalında, gönderildi (PR: https://github.com/izmo82/satinalma-platform/pull/1, son commit 8a0fa41).
2. Kullanıcı uygulamayı sadeleştirme kararı verdi ("ERP'ye yaklaşmış, bu kadar rol ve özelliğe gerek yok"). Yeni kapsam `docs/analiz-v2.md` içinde; kullanıcı 16.11.2026'da **"Onaylıyorum"** dedi. Dosyanın başlığı hâlâ "ONAY BEKLİYOR" yazıyor, güncellenmeli.
3. Faz 0 (Figma) sürüyor: 33 ekranın hepsi çizildi, yalnız 01 ve 02 gözle doğrulandı.

4. **16.11.2026 ikinci oturum:** kalan 31 çerçeve görüldü, kusurlar düzeltildi (liste `docs/implementation-status.md` "v2 yeniden kapsam" bölümünde). `docs/analiz-v2.md` başlığı ONAYLANDI yapıldı, D93 yazıldı, Faz 1 envanteri `docs/envanter-faz1.md`. Kullanıcıdan beklenen: tasarım onayı, `v1` etiketi + v2 dalı onayı. Aşağıdaki 1. ve 4. maddeler tamam.

5. **16.11.2026, Faz 1 uygulandı (dal `v2-sadelestirme`, push yok):** tasarım onayı D94, kararlar D95–D100. Görev başına inceleme ile 8 görev + bütün dal incelemesi + tek düzeltme dalgası. Web ve iOS persona testi ve web işlev envanteri yürüyüşü yapıldı (`docs/envanter-faz1.md`: web 245/269, iOS 31 satır işaretli). Faz 1 durumu **PARTIAL**: kalan küçük düzeltmeler ve kullanıcı kararları `docs/implementation-status.md` v2 bölümünde. Ayrıntılı defter (git dışı): `.superpowers/sdd/2026-11-16-v2-faz1-sadelestirme/progress.md`. Geliştirme veritabanının 030 öncesi yedeği aynı klasörde `devdb-before-030.sql`.

6. **17.11.2026:** Faz 1 kapandı (D102–D104, e2e 155/1/63, kalan UX04 önceden var). Faz 2 (Entra) planı `docs/superpowers/plans/2026-11-17-v2-faz2-entra.md`, kullanıcı onayı bekliyor.

## Sıradaki işler (sırayla)

1. Figma'da kalan 31 ekranı ekran görüntüsüyle denetle, kusurları düğüm kimliğiyle hedefli düzelt.
2. Figma bağlantısını kullanıcıya sun ve tasarım onayı iste (Faz 0 = Figma + tasarım onayı).
3. Mevcut HEAD'i `v1` olarak etiketle, v2 için yeni dal aç. Commit/push yalnız kullanıcı isteyince.
4. `docs/analiz-v2.md` başlığını "ONAYLANDI 16.11.2026" yap; kararı `docs/decisions.md` ve `docs/implementation-status.md`'ye işle.
5. Tasarım onayından sonra Faz 1–8 (web + iOS birlikte).

## Figma

- Dosya: https://www.figma.com/design/V6jh1q5ZK11eRhVeKgHe6O (fileKey `V6jh1q5ZK11eRhVeKgHe6O`)
- Yeni oturumda `create_session` ile yeni sessionId al; `use_figma` çağrılarında `skillNames: "figma-use,figma-generate-design"`.
- Sayfalar: "Web – Uygulama" `0:1`, "Tedarikçi portalı ve e-posta" `2:2`, "iOS" `2:3`, "Bileşenler" `2:4`.
- Değişken koleksiyonu "Mor Istampa"; metin stilleri display, headline, title, title-sm, body, body-strong, label, small, colhead, mono.
- Bileşenler: Btn/Primary `2:43`, Btn/Outline `2:45`, Btn/Danger `2:47`, Btn/Small `2:49`, Tag/Human `2:52`, Tag/Verified `2:58`, Tag/AI `2:63`, Tag/Warn `2:67`, Tag/Danger `2:73`, Tag/Info `2:79`, Tag/Neutral `2:85`.
- Web çerçeveleri (1440 geniş):
  `3:2` 01 Giriş (Entra) ✔, `3:20` 02 İşlerim ✔, `4:46` 03 Proje listesi, `4:278` 04 Proje oluşturma – tedarikçi seçimi ve davet, `4:467` 05 Proje detayı, `4:728` 06 Teklif karşılaştırma ve değerlendirme, `4:999` 07 Sözleşme listesi, `4:1253` 08 Sözleşme ekleme – Oku, tamamla ve doğrula, `5:141` 09 Sözleşme ekleme – İncele ve gönder, `5:371` 10 Sözleşme detayı – İnceleme, `5:657` 11 Sözleşme detayı – Özet, `5:934` 12 Sözleşme taslakları, `5:1160` 13 Tedarikçi listesi, `5:1419` 14 Tedarikçi kartı, `5:1690` 15 Tedarikçi başvurusu inceleme, `5:1901` 16 Yıllık risk değerlendirmesi ve risk matrisi, `5:2205` 17 Faturalar – eşleştirme, `5:2390` 18 Proje – Uyum denetimi raporu, `5:2654` 19 Yönetim – Satınalma kuralları, `5:2875` 20 Yönetim – Kullanıcılar ve Entra, `5:3118` 21 Yönetim – Onaycı ataması, `5:3335` 22 Yönetim – Oracle ERP entegrasyonu, `5:3581` 23 Yönetim – Yapay zekâ
- Portal: `4:1485` P1 Başvuru ve belge yükleme, `4:1619` P2 Portal ana sayfa, `4:1764` P3 Teklif verme, `4:1890` P4 Anket doldurma, `4:1970` P5 E-posta – teklif daveti, `4:1999` P6 E-posta – sözleşme bitiş hatırlatması
- iOS (393×852): `4:2032` İşlerim, `4:2125` Sözleşme tarama, `4:2175` Doğrulama, `4:2264` Sözleşme onayı
- Denetimde bakılacaklar: sabit genişlikli tablo hücrelerinde kırpılan/taşan metin, dar panelde taşan ilerleme çubuğu, uzun mono değerler, sütundan geniş etiketler.
- Ekran görüntüsü: `get_screenshot` → `image_url` → `curl` ile scratchpad'e indir → oku. Adresler kısa ömürlü ve gizli tutulur.
- Figma `generate_image` yapay zekâ kredisi harcar; önce sor.

## Onaylı v2 tasarımının özeti (ayrıntı `docs/analiz-v2.md`)

- 5 rol: Yönetici, Satınalma, Departman kullanıcısı, Tedarikçi, Denetçi (salt okunur).
- 3 onaycı, sıralı: departman sorumlusu → satınalma sorumlusu → satınalma direktörü; yönetici Entra kullanıcı listesinden atar.
- Menü (7): İşlerim · Projeler · Sözleşmeler · Tedarikçiler · Faturalar · Raporlar · Yönetim.
- Her kayıtta `department_id`, RLS ile zorlanır; yönetici ve satınalma hepsini görür.
- Sözleşme ekleme 4 adım (Yükle → Oku → Tamamla ve doğrula → İncele ve gönder); proje ve tedarikçi kartı zorunlu; docx taslak kütüphanesi; taslak karşılaştırma + hukuk ön incelemesi 0–100 (tavsiye niteliğinde, "hukuki görüş değildir" etiketi); hatırlatıcı 90/60/30/7 gün.
- Tedarikçi portalı: başvuru + belge → Aday → Onaylı → Pasif; davet e-postasında giriş bağlantısı; teklif, anket, skor ve risk görünümü.
- Yıllık risk: kritiklik = altı ölçütün (1/3/5) geometrik ortalaması; risk puanı 0–100; 5×5 matris; seviye 4–5 eylem planı ister. 26 soruluk şablon dosyası verilmedi → yönetici girebilir biçimde kurulur.
- Uyum denetimi: yöneticinin girdiği kural kataloğu, puan deterministik; yapay zekâ yalnız kanıt okur ve rapor yazar.
- Entra (Graph): grup / yönetim birimi / OU süzgeci; departman `department` özniteliğinden.
- Oracle ERP: özellik başına uç nokta kartı (EBS varsayıldı).
- Yapay zekâ modeli: Sonnet (`claude-sonnet-5-5`). Gerçek sağlayıcı ücretli kaynak; sağlayıcı/bütçe/KVKK kararı kullanıcıdan gelmeden bağlanmaz, test sağlayıcısı etiketli kalır.
- Onaylı kaldırma listesi (sıfır gerileme kuralının tek istisnası): onay politikası ekranı, banka değişikliği akışı, siparişler/mal kabul, fatura finans onayı/tolerans/üçlü eşleştirme, Lira Defteri + TCMB kuru, veri yönetimi saklama/imha, iOS fatura finans onayı (`ios/Satinalma/Satinalma/Features/InvoiceView.swift`; geri kalanı salt okunur kalır). Tablo ve veri silinmez.
- Yeni tablolar: departments, directory_users, approver_assignments, contract_templates, contract_extractions, contract_reviews, contract_approvals, supplier_applications, risk_assessments, risk_actions, procurement_rules, compliance_audits, integration_endpoints, email_outbox. Her biri RLS + en dar GRANT.
- Fazlar: 0 Figma + tasarım onayı; 1 sadeleştirme; 2 Entra; 3 sözleşme; 4 yapay zekâ; 5 tedarikçi portalı; 6 risk; 7 fatura eşleştirme + uyum denetimi; 8 Oracle.

## Süregelen kurallar (CLAUDE.md'lere ek, oturumdan)

- Demo faturalar ANB2026000101, ANB2026000102, EGE2026000877 onaylanmaz, reddedilmez.
- Onaysız canlıya alma ya da ücretli kaynak yok.
- Test kimlik bilgileri yanıtlarda tekrarlanmaz.
- Kullanıcının işi silinmez, geri alınmaz. İzlenmeyen `reports/`, `research_notes/`, `docs/analiz-v2.md` yerinde kalır.
- Raporlar Türkçe. Commit/push yalnız istenince.
- Geliştirme sunucuları (web önizleme, API, worker) önceki oturumda çalışıyordu; yeniden başlatmadan önce çalışıp çalışmadığını denetle.

## Girdi dosyaları

- `/Users/server/Desktop/BT Tedarikçi Risk Değerlendirme Tablosu ve Risk Grafiği v2_2026_Q1.xlsx`
- `/Users/server/Desktop/KHC.IT.2100.002.TEDARİKÇİDEN ALINAN HİZMETLERİN YÖNETİMİ.009.Önizleme.tr.pdf`
