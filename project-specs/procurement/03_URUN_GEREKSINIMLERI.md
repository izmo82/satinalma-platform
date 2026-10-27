# Ürün gereksinimleri
Ana kaynak: `02_GUNCEL_ANALIZ.md` bölümler 1–42. Bu dosya kontrol listesidir; analizin yerini daraltmaz.

## Ortak kurallar
- Bağımsız kiracı; altında çok tüzel kişi, departman, şube, maliyet merkezi. Kullanıcı birden çok kiracıya üye olabilir; aktif bağlam görünür ve sunucuda doğrulanır.
- Roller: talep sahibi, satınalmacı, satınalma yöneticisi, teknik değerlendirici, hukuk, finans, güvenlik, ana veri, tedarikçi, tenant yöneticisi, platform operasyonu ve denetçi. Tenant yöneticisi otomatik tüm belgeyi göremez.
- Görev ayrılığı; sınırlı/tarihli vekâlet; limit ve risk bazlı onay; yayınlanmış politika sürümü; taslak/tamamlanan işlemin ayrılması; değişiklikte yeniden onay; gerekçeli istisna; değişmez denetim izi.
- Rapor ve içe/dışa aktarma aynı yetki sınırını kullanır. TR/EN, TRY ve yabancı para; tarih/saat dilimi; decimal tutar ve yuvarlama kuralları.

## FR01–FR04 Proje, teklif ve seçim
Proje sahibi, şirket, kategori, bütçe/kur, maliyet merkezi, tarihler, şartname, lot/satır, birim/miktar, teknik kriterler, kanıt ve kurul gereklidir. RFQ/RFP versiyon, tur, kapanış ve açılış yetkisi taşır. Tedarikçi portalında yalnız kendi teklifine erişir. Soru-cevap ve şartname revizyonu bütün uygun katılımcılara tutarlı yayınlanır; ticari sır korunur. Kapanış sunucu saatidir.

Teklif alternatifleri, paket/birim dönüşümü, eksik kapsam, kur ve tarih, vergi, kurulum, nakliye, bakım/yenileme ve TCO ayrı gösterilir. Karşılaştırılamayan kapsam en ucuz diye sıralanmaz. Kriter/ağırlık yayın öncesi kilitlenir. Teknik puan kanıtlıdır; güvenlik engeli ticari ortalamaya gömülmez. Kazanan satır/lot/proje düzeyinde bir veya birçok tedarikçiye tahsis edilir. Minimum teklif, tek kaynak, acil alım ve iptal kuralı yapılandırılabilir.

AI raporu kaynak sürümü/sayfa/hücre taşır. XLSX ve PDF deterministik rapor servisiyle üretilir; kur, formül ve varsayımlar saklanır. Yeni teklif raporu eskimiş işaretler. Kurul belirli değerlendirme sürümüne karar verir.

## FR05–FR07 Tedarikçi ve belge girişi
- Firma anahtarı: tenant+ülke+kimlik türü+normalize kimlik. VKN/TCKN string; baştaki sıfır korunur. Faturada satıcı/alıcı; sözleşmede taraf rolü ayrılır.
- Mevcut aktif firma tam kimlikle eşlenir; ünvan çelişkisi görünür. Belirsiz kimlik manuel inceleme; isim benzerliği yalnız öneri.
- Bulunmazsa aday kayıt; mevcut bekleyen adaya belge ekle. Atomik unique kısıtıyla eşzamanlı mükerrerliği engelle. Gerekli uzman ve bağımsız ana veri onayından sonra aktif yap.
- Aday, koşullu, aktif, askıda/engelli, pasif/arşiv yaşam döngüsü. Engelli firmadaki eski borçlar özel çözüm akışında.
- Banka değişikliği ayrı doğrulama ve çift kontrol; OCR mevcut IBAN üzerine yazamaz. Firma birleştirmesi geçmiş bağlantıları ve yönlendirme izini korur.
- Güvenli yükleme, MIME/uzantı/limit, karantina, hash; XML/okunur metin önceliği, OCR ve şemalı çıkarım; kritik alan ve kaynak incelemesi; otomatik veri doldurma.

## FR08–FR09 Sözleşme
Sözleşme ailesi, ana belge, iş tanımı, ek/zeyilname ve öncelik/yürürlük tarihleri. İmzalı eski arşivden kayıt ve metadata doğrulama. Bedel/tavan, para birimi, ödeme koşulu, fiyat dönemi, SLA, hak/ceza, teminat, garanti; yükümlülük sahibi, tarih ve kanıt. İhbar tarihine göre görev/eskalasyon. Yenileme/fesih ve çıkışta veri/erişim/borç kontrolü. Islak/e-imza ve asıl takibi dosya 06'daki SIG01–SIG16 zorunlu kapsamdır.

## FR10 Fatura, sipariş ve kabul
Hafif PO veya ERP siparişi; mal kabul veya dönem/kilometre taşı hizmet kabulü; bunlar olmadan yalnız belge toplamı eşliği yeterli değildir. Fatura satırı çok proje/sözleşme/PO'ya dağıtılabilir. Tahsis toplamı fatura tutarını; kabul tüketimi miktarı aşamaz. Ürün/birim/fiyat/para birimi/vergi/dönem ve limit kontrolleri. Önceki fatura tüketimi, açık taahhüt, kısmi teslimat, taksit, avans/mahsup, iade/alacak, iptal ve ters kabul desteklenir.

Kullanılabilir limit = onaylı tavan − net tüketim − tüketilmemiş açık taahhüt; faturalanmış siparişi iki kez düşme. Kontrol atomik olmalı. Tolerans kategori/para birimi/politikaya bağlı; kimlik veya kur birimi sorunu toleransla geçmez. Mükerrer ETTN/fatura no/hash. Sözleşmesiz fatura gerekçeli istisna. Hukuki e-belge durumu ile kurum içi durum ayrı. ERP aktarımı/muhasebeleşme/ödeme ayrı teyitler. Bankadan ödeme yürütme ve tam muhasebe kapsam dışı.

## FR11–FR12 Risk, performans ve olaylar
ISO 9001 dış sağlayıcı yaklaşımı; ISO/IEC 27001/27002, 27036-2 ve BT için NIST 800-161 referanslı sürümlü anket. Standart metni lisanssız kopyalama; sertifika/uyum garantisi verme. Hizmete özel içsel/artık risk, kanıt, geçerlilik, N/A gerekçesi, bulgu/faaliyet ve risk kabulü. Sertifika varlığı otomatik uygunluk sayılmaz.

Performans kalite, teslimat, SLA, iletişim/ticari uyum; kategori ağırlıkları ve örneklem görünür. Bilinmeyen veri olumlu sayılmaz. Yıl içi sorun: bildirim→doğrulama→etki/kök neden→tedarikçi yanıtı→faaliyet→bağımsız kapanış→itiraz/yeniden inceleme. Doğrulanmayan iddia kesin ceza değil. Aynı SLA etkisini iki kez düşme. Kritik olay yeniden güvenlik incelemesi; otomatik yasal bildirim yok. Yıllık karne ve dönemsel eğilim.

## FR13–FR15 Kanallar ve işletim
Web tam operasyon, iOS görev/scan/kabul/onay/olay; aynı API/yetki. ERP ve e-belge adaptörü; idempotency, outbox, retry/DLQ ve mutabakat. Tenant kurulumu, kota, dışa aktarma, kapatma ve saklama. Uyarılar, sahiplik, eskalasyon, rapor güncelliği, kaynaklı arama. Kritik bildirim hassas veri içermez. Tam kaynak için bölüm 14 veri modeli ve bölüm 18 entegrasyon otoritelerini uygula.
