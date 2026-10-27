# Ana uygulama talimatı

Kıdemli ürün mühendisi, satınalma/sözleşme iş analisti, kurumsal UI/UX tasarımcısı, backend mimarı, iOS mühendisi ve güvenlik/test uzmanı sorumluluğuyla çalış. Hedef, bu pakette tanımlanan satınalma ve sözleşme platformunu web ve native iOS üzerinde çalışan, çok kiracılı, denetlenebilir bir uygulama olarak üretmektir. Yalnız analiz veya ekran maketi sunarak durma; faz sırasıyla gerçek kodu ve doğrulamayı tamamla. Bu ürün mevcut fitness uygulamasından bağımsızdır.

## Önce kaynakları ve gerçek ortamı incele
- Bu klasördeki 00–12 dosyalarının tamamını, özellikle `02_GUNCEL_ANALIZ.md`, `04_UI_UX_TASARIMI.md`, `06_IMZA_KONTROLU.md` ve `09_KABUL_TESTLERI.md` dosyalarını oku. Analiz 1.2 tüm önceki iş gereksinimlerini içerir. Grafikler `assets/` içindedir.
- Repo varsa AGENTS.md, CLAUDE.md ve yerel talimatları, mevcut branch/diff, mimari, auth/tenant, veri modeli, UI bileşenleri, API, migration ve testleri oku. Dosya yollarıyla mevcut/eksik/değişecek matrisi çıkar. Kullanıcının çalışmalarını silme veya geri alma.
- Kurulu skill, agent ve MCP yeteneklerini keşfet. Varsa UI/UX ve tasarım skill'leri, React/TypeScript ve Swift uzmanlığı, Playwright MCP ve iOS build/simulator araçlarını görevlerine uygun kullan. Hepsini sırf mevcut diye çalıştırma. Kullanamadığın aracı kullanmış gibi yazma. Paket veya plugin kurulumunu zorunlu kılmadan mevcut araçlarla ilerle.
- Stack'i mevcut repoya uydur. Greenfield varsayımı için TypeScript web/API, PostgreSQL ve SwiftUI değerlendir; gerekçeli tek karar ver. Benzer işi yapan iki framework kurma. Mikroservis/Kubernetes zorunluluğu üretme.
- İlk çıktı kısa olsun: kanıta dayalı repo bulguları, uygulanacak fazlar, varsayımlar ve gerçek dış bağımlılıklar. Ardından ilk fazı uygula. Kodlamadan önce bütün ürünün uzun bir raporunu yeniden üretme.

## Ürün kapsamı eksiksizdir
Tenant, şirket, maliyet merkezi, roller ve görev ayrılığı; onaylı/aday tedarikçi; vergi kimliği eşleme; satınalma projesi ve lot/satır; şartname; RFQ/RFP turları; tedarikçi portalı; teklif normalleştirme ve AI karşılaştırma; tek/çoklu kazanan; sözleşme ailesi, zeyilname, yükümlülük, yenileme/ihbar; hafif sipariş ve mal/hizmet kabulü; satır bazlı fatura tahsisi, avans/iade ve ERP durumu; standart referanslı risk/performans değerlendirmesi; yıl içi olay ve düzeltici faaliyet; web/iOS; OCR/AI; imza kontrolü; raporlama, bildirim ve denetim izi.

Özellikle: belgeyi ekleyince satıcı/alıcıyı ayır; aynı tenant'ta ülke+kimlik türü+vergi kimliğiyle tedarikçiyi ara. Varsa bağla, yoksa aday aç. Aynı anda gelen yüklemeler mükerrer aday yaratmamalı. Onaysız aday aktif firma, kesin kazanan veya serbest ödeme alıcısı olamaz. Mevcut banka bilgisi OCR ile sessiz değişemez.

## Islak imza özelliği zorunludur
`06_IMZA_KONTROLU.md` bu konunun bağlayıcı ayrıntısıdır. Her belge sürümünde beklenen taraf/imzacı ve kabul edilen yöntem tanımlanır. Görsel imza adayları bulunur; bulunamazsa otomatik “İmza görüntüsü bulunamadı — inceleme gerekli” işareti ve görev oluşur. İnsan incelemesiyle eksik taraflar kesinleştirilir. Belirsiz/hata/işlenmemiş ayrıdır.

İmza görüntüsü, ıslak mürekkep/asıl, imzalayanın kimliği/yetkisi ve hukuki geçerlilik aynı şey değildir. Bunları tek `isSigned` boolean'a sıkıştırma. Kaşe/paraf/isim tam imza değildir. E-imza yöntemi ayrı doğrulanır; ıslak imza gerekmeyen belgede yanlış uyarı üretme. Yeni belge sürümü eski incelemeyi taşıyamaz. Eksik kanıtla “imza kontrolü tamamlandı” geçişini API de engeller. İstisna gerekçeli, yetkili ve süreli görünür; eksikliği silmez. Tarihsel sözleşmeler ve mevcut borçlar otomatik geçersiz/iptal ilan edilmez.

## Arayüz ve kullanıcı deneyimi
Kurumsal tasarım uzmanının elinden çıkmış, tutarlı ve amaca yönelik bir ürün üret. “AI slop” görünümünü; aynı tip büyük kartlar, gereksiz gradientler, her yerde grafik, gösterişli fakat işlevsiz animasyon ve belirsiz butonlarla üretme. Tasarım kalitesini yalnız renk değişimi sayma.

- Önce tasarım tokenları, typography, spacing, veri tablosu, form, drawer, modal, belge görüntüleyici, durum etiketi ve onay bileşenini oluştur veya mevcut sisteme uyarla.
- Sol navigasyon ve görev merkezli İşlerim; ayrıntılı işlerde tam çalışma alanı; kısa inceleme ve ilişkili kayıtlarda yan panel. Uzun formu dar drawer'a sıkıştırma, modal üstüne modal açma.
- Belge ve çıkarılan alanları yan yana; alan seçildiğinde kaynak sayfa/konum. Karşılaştırmada sabit satır/sütun, kapsam/para birimi/kur/eksik kalem açık. Faturada “neden eşleşmedi ve kim çözer” görünür.
- Satınalma sihirbazı otomatik taslakla çalışır. Kaydet ile Onaya gönder ayrıdır. Onay ekranı güncel sürümde tutar, para birimi, firma, değişiklik, engel ve kanıt gösterir.
- Her ekran için loading, empty, error, partial success, offline, quota, permission denied ve conflict durumlarını tasarla. AI çıktısı ile insan onayı ayrı etiketlidir. Sahte ilerleme yüzdesi veya sahte başarı verme.
- iOS webin küçültülmüş hali olmasın: tarama, görev, kaynaklı onay, saha kabulü ve olay bildirimine odaklan. Çevrimdışı şifreli taslak olabilir; nihai onay çevrimiçi sunucu doğrulaması ister.
- WCAG 2.2 AA hedefi, klavye/odak, ekran okuyucu, Dynamic Type, azaltılmış hareket ve Türkçe/İngilizce biçimlendirme. Ölçüler ve kabul kriterleri dosya 04'te.

## AI ve maliyet
Önce XML/okunur metin ve kurallar, gerekiyorsa OCR, ardından küçük model; yalnız sorunlu kapsamda bir üst model çağrısı. Modelin kendi güven ifadesini doğruluk sayma. Güncel belge testleriyle sağlayıcı seç; fiyat ve model kimliğini config/model registry'de tut. Para hesabı, VKN eşleme, limit tüketimi, onay ve ödeme yetkisi LLM'e verilmez. Kaynaksız bilgi uydurulmaz.

İmza tespiti görsel kanıt gerektirir; OCR metninin varlığı bu işi yapmış sayılmaz. Sağlayıcının desteklemediği capability'yi varmış gibi simüle etme. Test dışındaki mock sonuçları gerçek başarı gibi gösterme. Yeni sağlayıcıya geçiş tenant'ın veri bölgesi ve izin politikasını aşamaz. Bütçe dolunca manuel akış çalışır. Dosya 07'deki model/görev ve maliyet kurallarını uygula.

## Güvenlik ve muhasebe kontrolleri
Tenant kimliğini doğrulanmış üyelikten türet; query, DB/RLS, cache, nesne deposu, kuyruk, arama, AI ve raporda uygula. UI gizlemek yetki kontrolü değildir. Şirket kapsamını ayrıca doğrula. RLS için superuser/BYPASSRLS kullanma; pooled bağlantıda tenant bağlamı sızmasını test et. Kaynak belgeler ve imza kesitleri de aynı yetkilere tabidir. Para için decimal, sürümlü onay, atomik limit, idempotency ve outbox uygula. Loglara belge metni, kimlik veya imza koyma. Güvenli önizleme, malware/karantina, kısa ömürlü yetkili dosya erişimi gerekir.

## Çalışma ve doğrulama disiplini
`11_FAZLAR_VE_TESLIM.md` sırasını izle. Her fazda küçük bir dikey akışı veri→API→web→gerekli iOS→test ile tamamla. Testleri etkilenen iş kurallarına göre seç. Değişiklik yokken bütün testleri tekrar tekrar döndürme; ölçülebilir çıkış kapısı geçince ilerle. Her madde sonunda benden onay bekleme. Geri alınabilir ve kapsam içi uygulama kararlarını gerekçesiyle kaydet. Kimlik/bölge, ödeme yürütme, üretim deploy veya yıkıcı veri göçü gibi önemli kapsam/geri dönüş kararlarında somut seçenek ve etkisiyle sor; bağımsız işlere devam et.

Gerçek tarayıcıda Playwright veya eşdeğeriyle kritik web akışlarını, dar/geniş görünümü, hataları ve kaynak panelini incele; screenshot sadece gözden geçirme içindir. Swift build ve uygun simulator görevlerini çalıştır. Ortam yoksa kontrolü yapıldı sayma; net blokaj ve çalıştırılabilir komut bırak. Testleri geçmek için güvenlik kuralını, assertion'ı veya gereksinimi zayıflatma.

Gereksinim→dosya/API/ekran→test→sonuç izini `docs/implementation-status.md` içinde sürdür. PASS yalnız çalıştırılıp geçen kontrol içindir; NOT_RUN/BLOCKED/FAIL durumları ayrı olsun. Kalan P0 varken “tamamlandı” deme. Dış servis anahtarı eksikse diğer işleri tamamla; sadece adaptör testinin gerçek entegrasyon testi olmadığını belirt.

## Son teslim
Çalışan kaynak, migration ve rollback yaklaşımı, OpenAPI, .env.example (sırsız), kurulum/seed talimatı, test komutları, gerçek sonuçlar, erişilebilirlik ve görsel kontrol bulguları, entegrasyon blokajları ve kapsam matrisi ver. Test/demo verilerini açıkça sentetik yap. Gereksinimler arasında sessiz özellik kaybı olmasın. Ölçüsüz yeniden tasarım/refactor yapma; belirlenen kapıları geçerek uygulamayı tamamla.

Şimdi paketi ve gerçek repo durumunu incele, kısa bulguları sun ve ilk uygulanabilir fazı kodlayarak başla.
