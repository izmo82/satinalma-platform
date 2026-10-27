# Gereksinim izlenebilirliği
Claude uygulama sırasında bu tablonun kopyasına gerçek dosya/API/test yollarını, commit veya sürüm ve PASS/FAIL/BLOCKED/NOT_RUN durumunu eklemelidir. Bu pakette hiçbir yazılım testi yapılmış iddiası yoktur.

| Kaynak | Kapsam | Tasarım/teknik dosya | Kabul senaryoları |
|---|---|---|---|
| FR01–FR04 | Proje, RFQ, karşılaştırma, seçim | 03,04,05 | T09–T12 |
| FR05–FR07 | Aday, eşleme, OCR | 03,07,08 | T04–T08,T22–T24 |
| FR08–FR09 | Sözleşme, sürüm, yenileme | 03,05,06 | T21,T25–T40,T46 |
| FR10 | PO/kabul/fatura/limit | 03,08 | T13–T18 |
| FR11–FR12 | Risk, performans, olay | 03,07 | T19–T20 |
| FR13 | Web/iOS | 04,08 | T41–T45 |
| FR14 | ERP ve tekrarlar | 03,08 | T17–T18 |
| FR15 | Tenant yaşam döngüsü | 08 | T01–T03,T48 |
| BR01–BR12 | İzolasyon, SoD, sürüm, limit, tekrar ve istisna | 02 bölüm 13; 08 | T01–T03,T07,T11,T15,T17,T22,T33,T36 |
| UX01–UX14 | Ekranlar, durumlar ve erişilebilirlik | 04 | T25–T28,T32,T41–T45 |
| AI01–AI13 | Model, kaynak, maliyet ve imza tespiti | 07,06 | T22–T24,T25–T29 |
| SIG01–SIG04 | Taraf ve eksik imza semantiği | 06 | T25–T29,T39 |
| SIG05–SIG09 | Kanıt, asıl/e-imza, sürüm | 06,08 | T29–T32,T34–T35,T40,T46 |
| SIG10–SIG12 | Sunucu blokajı, istisna, eski kayıtlar | 06 | T33,T36–T37 |
| SIG13–SIG16 | UX/iOS, erişim, tekrar, servis yokluğu | 04,06,08 | T24,T30,T38,T43–T45 |

## Kritik teslim kanıtları
- Her gereksinim için gerçekten çalışan dikey akış ve test karşılığı.
- Analizdeki bütün tablolar ve özelliklerin dahil/ertelenen/bloke durumu. Erteleme ürün kapsamı değişikliği gerektiriyorsa sessiz yapılmaz.
- Üretim yayın öncesi bağımsız güvenlik/doğruluk/hukuk doğrulaması gereken noktalar ayrı listelenir; uygulama içi kontroller tamamlanmış gibi gösterilmez.
- Ana dosyanın model fiyatları zaman damgalıdır; uygulama model registry gerçek erişimi ve güncel fiyatı doğrulamalıdır.
