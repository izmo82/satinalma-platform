# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

(Ayrı native iOS uygulaması `ios/` altında; görev, tarama, kabul ve onay için. Bu kayıt web arayüzünü kapsar.)

## Users
- **Birincil: satınalmacı.** Ofiste, geniş ekranda, gün boyu çok sayıda proje, teklif ve tedarikçi kaydıyla çalışır. İşi: ihtiyaçtan RFQ'ya, tekliflerin normalleştirilmesi ve karşılaştırılmasından gerekçeli seçim önerisine kadar götürmek.
- İkincil, tam destekli: hukuk (sözleşme ve imza incelemesi), finans (fatura, tahsis, limit), ana veri sorumlusu (aday tedarikçi, banka doğrulama), satınalma yöneticisi ve kurul (karar), teknik değerlendirici, bilgi güvenliği, denetçi (salt okunur), kiracı yöneticisi (kullanıcı ve politika; işlem verisine otomatik erişimi yok).
- Dış kullanıcı: davetli tedarikçi, yalnız kendi teklifini görür (tedarikçi portalı).
- Telefon kullanımı iOS uygulamasındadır; web masaüstü yoğun kullanım içindir ama 390 px dar görünümde kritik içerik ve kontrol kaybolmaz.

## Product Purpose
Proje, teklif, tedarikçi, sözleşme ve faturayı tek işlem zincirinde birleştiren çok kiracılı platform. Değeri belge saklamak değil, her harcamanın hangi onaylı karara, sürüme ve yükümlülüğe dayandığını kanıtlayabilmektir. Başarı: kullanıcı neyin beklediğini, nedenini, dayandığı kanıtı ve sonraki adımı tek yerde görür; hata (eksik kapsam, eksik imza, kabulsüz fatura) erken ve sorumlusuyla görünür.

## Positioning
Türkiye belge akışlarını (e-Fatura UBL-TR, VKN/TCKN, KDV/tevkifat, Türkçe tarih ve tutar) kaynağa dayalı karşılaştırma ve kanıtla birleştiren sade bir deneyim. AI alan doldurur ve taslak üretir; kazananı, hukuki geçerliliği, limiti veya ödemeyi kesinleştirmez. Bu bir ürün hipotezidir; rakiplerde olmadığı iddia edilmez.

## Operating Context
- Kurum içi Kubernetes ilk hedef ortam; kurumsal IdP ile giriş (ADFS/Keycloak/Entra).
- Hedef müşteri: birden fazla lokasyonu, tekrarlayan hizmet sözleşmeleri ve dağınık PDF/Excel arşivi olan orta-büyük kurum; ilk pilot kategorisi BT hizmetleri, bakım veya tesis yönetimi.
- Belgeler: e-Fatura XML, PDF sözleşme ve zeyilname, şartname, teklif tabloları, XLSX/PDF karar raporu.
- Bilgi mimarisi: İşlerim, Projeler, Tedarikçiler, Sözleşmeler, Faturalar, Raporlar; üstte aktif kiracı/şirket.

## Capabilities and Constraints
- Ayrıntılı gereksinim: `project-specs/procurement/` (03 ürün, 04 UI/UX sözleşmesi, 06 imza, 09 kabul testleri). Bunlar bağlayıcıdır, değiştirilmez.
- Durumlar sunucudan türetilir; imza durumu saklanmaz. Arayüz bir kuralı gizlemekle kuralı uygulamış sayılmaz.
- Para decimal string ve özgün para birimiyle; tabular rakam ve görünür para birimi.
- Her kritik akışta loading, empty, error, partial, permission, quota, offline, conflict durumları.
- Öneri etiketleri: AI önerisi / kuralla doğrulandı / insan onaylı.
- Teknik yığın: React 19 + Vite, Tailwind CSS 4 + shadcn/ui (kullanıcı kararı); yazı tipleri yerel paket, harici CDN yok (CSP).
- Açık karar: ürün adı ve marka varlıkları yok; arayüz nötr "Satınalma ve Sözleşme" adını kullanır.

## Evidence on Hand
- Yalnız sentetik demo veri (`apps/api/src/devdata.ts`, "(SENTETİK)" etiketli). Gerçek müşteri, referans, kullanıcı alıntısı, ölçüm veya SLA yok; uydurulmaz.
- Süreç grafikleri: `project-specs/procurement/assets/`.

## Product Principles
1. Görev birimdir: her ekran ne oldu, benden ne bekleniyor, hangi kanıt, sonraki adım sorularını yanıtlar.
2. Kanıt kararın yanındadır: her alan ve rakam kaynağına (belge, sürüm, sayfa/hücre) götürür.
3. Karşılaştırılamayan karşılaştırılmaz: eksik kapsam, birim farkı ve kur varsayımı en ucuz sıralamanın önündedir.
4. Otomasyon taslak üretir, insan ve kural karar verir; ikisi görsel olarak ayrıdır.
5. Sessiz değişiklik yok: sürüm, çakışma ve eskimiş rapor açıkça gösterilir.

## Accessibility & Inclusion
WCAG 2.2 AA hedefi: klavye ve odak, kalıcı etiketler, ilk hataya odak ve hata özeti, tablo başlıkları, renk yanında ikon ve metin, 24×24 CSS px hedef, reduce motion. TR/EN, uzun ünvan ve para/tarih biçimleri.
