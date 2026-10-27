# Kabul ve doğrulama senaryoları
PASS yalnız çalıştırılmış test; diğer durumlar FAIL / BLOCKED / NOT_RUN. Gerçek API testini mock testinden ayır. Aşağıdaki senaryoları mevcut test framework'ünde karşılayan testler ve uygun E2E akışları üret. Aynı kuralı gereksiz tekrar test ederek süreyi uzatma.

| Test | Senaryo | Beklenen sonuç |
|---|---|---|
| T01 | Tenant A kullanıcısı B resource ID/API/file/search/AI/export/queue sonucunu ister | İçerik ve metadata erişimi reddedilir |
| T02 | Aynı tenant'ta yetkisiz şirket verisi | Yetki reddi; global admin UI gizlemesi yeterli değil |
| T03 | Pool bağlantısı iki tenant arasında tekrar kullanılır | Tenant context sızıntısı yok |
| T04 | Aynı VKN iki belgeyle eşzamanlı gelir | Tek firma/adaya iki kaynak, mükerrer yok |
| T05 | Alıcı şirket VKN'si belgede belirgindir | Satıcı diye eşlenmez |
| T06 | VKN düşük güvenli/eksik, ünvan benzer | Kesin otomatik firma kararı yok; inceleme |
| T07 | Adayı açan tek başına aktivasyon dener | SoD engeli |
| T08 | OCR mevcut IBAN'dan farklı değer okur | Banka değişmez; ayrı doğrulama görevi |
| T09 | Tedarikçi diğer teklif ID'sini/son tarih sonrası revizyonu dener | Yetki ve zaman kuralı sunucuda |
| T10 | Fiyat düşük ama kapsam eksik/yanlış birim | Karşılaştırılamıyor; eksik kapsam görünür |
| T11 | Teklif veya ağırlık onaydan sonra değişir | Eski rapor/karar güncel sayılmaz |
| T12 | Kazanan iki tedarikçiye bölünür | Tahsis miktar/toplam ve aktif firma kontrolü |
| T13 | PO'nun yarısı kabul, tamamı fatura | Eksik kabul istisnası; yetkisiz onay engelli |
| T14 | 1 milyon tavan, 400 bin tüketim, 300 bin kalan açık taahhüt | Kullanılabilir 300 bin; double count yok |
| T15 | Aynı limit için eşzamanlı iki onay | Atomik aşım engeli |
| T16 | Avans mahsup, kısmi fatura, iade ve ters kabul | Net tüketim ve önceki tahsis doğru |
| T17 | Aynı ETTN veya integration event tekrar gelir | Tek mali kayıt ve görünür tekrar izi |
| T18 | ERP timeout fakat işlem dışarıda oluştu | Sorgu/mutabakat; ikinci borç yaratma yok |
| T19 | SLA olayı doğrulanmadı veya itirazlı | Kesinleşmiş ceza sayılmaz; double scoring yok |
| T20 | Güvenlik kritik engeli + yüksek ticari puan | Kritik engel ortalamayla aşılmaz |
| T21 | İhbar son günü bitişten önce | Görev bitişe değil doğru ihbar son gününe dayanır |
| T22 | AI kaynaksız alan veya belge içi zararlı talimat | Null/uyarı; yetki/dış işlem yok |
| T23 | AI kota doldu veya izinli sağlayıcı yok | Ücretli iş bekler; manuel akış ve belge korunur |
| T24 | Model registry capability vision/signature yok | Otomatik imza tamamlandı gösterilmez |
| T25 | İmzasız, okunur sözleşme | NOT_DETECTED + dedupe görev; insan sonrası MISSING |
| T26 | İki taraflı sözleşmede tek taraf imzalı | Eksik taraf görünür, COMPLETE olmaz |
| T27 | Sadece kaşe/paraf/yazılı isim | Tam imza diye otomatik teyit yok |
| T28 | Bulanık/kırpık/şifreli/eksik sayfa veya OCR/algılayıcı hatası | UNCLEAR/ERROR; imzasız veya tam diye gösterilmez |
| T29 | Model görüntü buldu fakat yapıştırılmış imza/kimlik belirsiz | Yalnız görüntü adayı; ıslak asıl/yetki geçerliliği iddiası yok |
| T30 | Aynı dosya hash tekrar işlendi | Tek job/görev veya mevcut sonuca idempotent dönüş |
| T31 | Yeni sözleşme sürümü eski imzalı sürümün yerini aldı | Yeni inceleme; eski delil korunur, yeniye taşınmaz |
| T32 | İmza inceleyeni eski ETag ile karar verir | 409/uygun conflict; yeni sürümü incele |
| T33 | API'den eksik imzayla finalize denemesi | Gereksinim bazlı hata; UI bypass mümkün değil |
| T34 | E-imza yöntemli belge, wet gerekmiyor | Yönteme göre gerçek doğrulama; eksik wet uyarısı yok |
| T35 | PDF'de sadece e-imza görseli veya doğrulama servisi yok | VALIDATED olmaz; NOT_CHECKED/INDETERMINATE |
| T36 | İstisna onaylandı ve süresi doldu | EXCEPTION_ACTIVE eksikliği gizlemez; bitince kontrol/görev yenilenir |
| T37 | Arşiv sözleşmesinde imza bilinmiyor, mevcut fatura var | Eski borç otomatik iptal edilmez; policy review |
| T38 | İmza kesiti başka tenant veya yetkisiz kişi tarafından istenir | Aynı belge/alan yetkisi; hassas log yok |
| T39 | Çok taraflı/ekli/hibrit yöntemli sözleşme | Her gereksinim ve belge sürümü ayrı değerlendirilir |
| T40 | Original custody bilinmiyor ama görüntü teyitli | Durumlar ayrı; yalnız politika zorunlu kılıyorsa blokaj |
| T41 | Kullanıcı kritik akışı klavye/ekran okuyucuyla yapar | Odak/etiket/hata/source navigation çalışır |
| T42 | Geniş/dar görünüm, uzun ünvan, TR/EN tutarlar | Kritik içerik ve para birimi görünür; kontrol kaybı yok |
| T43 | iOS offline scan sonrası kopma/yeniden yükleme | Taslak korunur, aynı kayıt tekrar oluşmaz |
| T44 | iOS eski sürüm/offline nihai onay dener | Sunucu güncel sürüm/online gate |
| T45 | Mal/hizmet kabulü, olay ve imza görevleri iOS'ta | Aynı API/yetki/durum; kaynak belge erişilebilir |
| T46 | Signed orijinal önizleme için render edilir | Orijinal bytes/hash değişmez; preview ayrı |
| T47 | Kötü dosya/prompt injection/formula injection | Karantina/escape ve bounded parser; iş onayı yok |
| T48 | Tenant export/retention/legal hold/restore | Politika uygulanır; başka tenant verisi dahil değil |

## Demo veri seti
Açıkça sentetik iki tenant ve iki şirket; normal ve aday/mükerrer firma; 3 teklifli proje (eksik kapsam dahil); bölünmüş seçim; imzaları tam/eksik/belirsiz sözleşmeler; e-imza doğrulaması yapılmamış örnek; yeni zeyilname; kısmi kabul/avans/iade faturaları; bir güvenlik olayı. Sahte imzalı örnekler yalnız sentetik test etiketiyle; gerçek kişi imzası kopyalama. Fixture sonucunu canlı algılama başarısı gibi sunma.

## Test bütçesi
Her faz etkilenen unit/integration + bir veya birkaç kritik E2E çalıştırır. Faz kapanışında modül regresyonu; finalde tam gerekli kontroller bir kez. Yeni değişiklik/fail yokken aynı full-suite'i tekrarlama. Hata varsa kök nedeni düzelt; assertion/requirement silme. Ücretli sağlayıcı testleri açık onaylı ortam/kota ve sentetik belgeyle yapılır; dış erişim yoksa BLOCKED.
