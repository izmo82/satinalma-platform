# Uygulama fazları ve teslim disiplini
Faz kapıları teknik kalite kontrolüdür; her fazda kullanıcıya dönüp “devam edeyim mi” sormak değildir. Açık onay gereken önemli karar hariç yetkili kapsamdaki işe devam et. Dış bağımlılık bloke ederse bağımsız fazlar ilerler. Kesin takvim veya “kusursuz” garanti üretme.

## Faz 0 Gerçek repo keşfi ve kritik prototip
Kanıtlı mevcut/eksik matrisi, stack kararı, veri bölgesi varsayımı, iş kuralları ve tasarım tokenları. Proje, belge/AI alan inceleme, karşılaştırma, fatura farkı ve imza inceleme ekranlarını gerçek routing/state ile prototiple. Onay ve error durumları dahil. Uzun doküman tekrarı yok. Çıkış: bilgi mimarisi ve kullanılabilir dikey iskelet; önemli ürün belirsizlikleri kaydedilmiş.

## Faz 1 Güvenli temel
Tenant/şirket/rol, gerçek auth adaptörü, veri/nesne izolasyonu, audit, belge sürümü, job status ve aday tedarikçi/SoD. Şema, migration ve temel API/web; iOS auth/navigation skeleton. Çıkış: T01–T08, temel upload/retry ve izin kontrolleri. Prod secret ve auth kısayolu yok.

## Faz 2 Proje ve teklif
Proje sihirbazı, satır/lot, şartname, yayın/onay, tedarikçi portalı, tur/soru/cevap, eşleme/kapsam, deterministik TCO, kaynaklı XLSX/PDF ve kazanan tahsisi. Çıkış: T09–T12 ve gerçek browser kritik görev. Mock teklifler yalnız demo seed'dir.

## Faz 3 Sözleşme ve imza
Sözleşme ailesi/zeyilname, fiyat ve yükümlülük; ihbar/yenileme; SIG01–SIG16, imza analizi adapter'i, insan inceleme, kaynak görüntüleme, eksik uyarı/görev, fiziksel asıl, e-imza ayrı doğrulama ve süreli istisna. Çıkış: T21,T24–T40,T46; API bypass/stale version kesin testli. Gerçek sağlayıcı yoksa entegrasyon BLOCKED, manuel yol çalışır; bunu tam otomasyon teslimi diye yazma.

## Faz 4 PO kabul ve fatura
Mal/hizmet kabulü, satır tahsis, önceki tüketim/limit, avans/iade/ters işlem, tolerans, onay ve ERP/e-belge adaptörleri. Çıkış: T13–T18 ve T37. Ödeme gönderimi yok; durum otoritesi doğru.

## Faz 5 Tedarikçi değerlendirme ve AI otomasyonu
Kategori/servis bazlı standart referanslı anket, kanıt/geçerlilik, içsel/artık risk, performans/örneklem, yıl içi olay/itiraz/faaliyet ve yıllık karne. AI01–AI13 kaynak/maliyet/router/quotas. Gerekli AI akışlarının adaptörleri önceki fazlarda kurulur; bu fazda kalan görevler ve kalite ölçümü tamamlanır. Çıkış: T19–T24, golden-set sonuçları/gerçek blokajlar.

## Faz 6 Native iOS ve final bütünleşme
Önceki fazların ortak API'si üzerinde SwiftUI görev, scan, kaynaklı onay, kabul, olay ve imza inceleme görevleri; offline taslak/yeniden yükleme ve Keychain. Web tüm empty/error/conflict/quota durumları; rol/şirket ve erişilebilirlik. Çıkış: T41–T48, uygun simülatör build ve kritik iş akışı. iOS'ı sadece WebView olarak teslim etme.

## Faz 7 Yayın hazırlığı
Gerekli bütün kontroller bir kez tam; performans testi, güvenlik bulguları, backup/restore runbook, entegrasyon mutabakat, export/retention ve migration/rollback. Üretime çıkmak ayrıca ortam ve yetki gerektirir; hazırlık tamamlanmadan izin isteme. Tamamlanmayan P0 veya gerçek entegrasyon varken ürün tümüyle hazır deme.

## Günlük çalışma kaydı
`docs/implementation-status.md`: gereksinim, gerçek dosya/API/ekran, test yolu, komut/sonuç, blokaj. `docs/decisions.md`: seçilen çözüm, alternatif ve gerekçe. `docs/runbook.md`: kurulum, sır gereksinimleri, queue replay, hatalar ve geri dönüş.

## Devam komutu
“Bu paketi, repo talimatlarını ve docs/implementation-status.md dosyasını oku. Gerçek diff ve son test sonuçlarını kontrol et. Tamamlanmış işleri tekrarlamadan ilk eksik/bloke olmayan P0 dikey akıştan devam et. Aynı full-suite'i yeni değişiklik yokken yeniden çalıştırma. Durumları kanıta dayalı güncelle ve ana kapsamı koru.”

## Final rapor biçimi
1. Gerçekleşen kullanıcı davranışları ve önemli tasarım kararları.
2. Testler: komut, sonuç, ortam; browser ve simulator kanıtı.
3. Gereksinim matrisi ve kalan P0/P1.
4. Gerçek sağlayıcı erişimi, region, model kalitesi veya deployment blokajları.
5. Kurulum/çalıştırma, sentetik seed, migration ve rollback.
Rutin logları veya yüzlerce satır test çıktısını rapora yığma. Kısa fakat doğrulanabilir kanıt ver.
