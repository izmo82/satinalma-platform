# UI/UX uygulama sözleşmesi

## Ürün estetiği
Sakin fakat donuk olmayan kurumsal arayüz. Nötr açık yüzey, güçlü metin, kontrollü tek vurgu; durumlar ayrı semantik token. Yeni renk seçmeden mevcut marka varsa incele. Gradient/hero/stat-card duvarı yerine görev, veri ve karar önceliği. Özellikleri yalnız çekici dashboard yaparak teslim etme.

Web gövde 14–16 px, tutarlarda tabular numerals, 4 px spacing tabanı ve 8/16/24 ritmi; normal/kompakt tablo. İşlevsel 120–200 ms panel/durum geçişi; reduce motion. Bu sayılar tasarım önerisidir, erişilebilirlik sertifikası değildir.

## Bilgi mimarisi
İşlerim, Projeler, Tedarikçiler, Sözleşmeler, Faturalar, Raporlar. Üstte aktif tenant/şirket, arama, görev/bildirim. Profil ve kişisel ayarlar ikincil menü; global politika ayrı yetkili yönetim alanı. Ana ekranda bekleyen iş, neden, son tarih ve eylem. Kullanıcının yetkisiz iş sayısını sızdırma.

## Ekran sözleşmeleri
| Ekran | Ana davranış | Hata önleme |
|---|---|---|
| UX01 İşlerim | Benden beklenen/geciken/takip; görevden kaynaklı işe git | İşi neden gördüğüm ve sonraki adım açık |
| UX02 Proje listesi | Filtre/kolon/sıralama ve konum korunur | Şirket ve para birimi görünür |
| UX03 Proje sihirbazı | İhtiyaç→kalem→bütçe→kriter→davet; autosave | Adımda doğrulama, yayın öncesi özet |
| UX04 Tedarikçi portalı | Versiyon/kapanış, hücre bazlı fiyat, ekler, alındı | Kopma başarı değildir; kapanış sunucudan |
| UX05 Karşılaştırma | Sabit başlıklar, ortak kapsam/TCO/risk, kaynak | Eksik/alternatif ve kur varsayımı görünür |
| UX06 Belge inceleme | Sol kaynak, sağ alan, tıkla-konuma git | Kritik inceleme sayacı ve doğrudan hata çözümü |
| UX07 Aday havuzu | Kaynak/kimlik/mükerrer/eksik kanıt | Kör toplu onay ve kendi kendine aktivasyon yok |
| UX08 Tedarikçi | Kimlik, risk, performans, olay, anlaşmalar | Risk ve performans ayrı; örneklem/tarih |
| UX09 Sözleşme | Aile/sürüm, ihbar, yükümlülük, imza sekmesi | Eski imza onayı yeni sürüme taşınmaz |
| UX10 Fatura | Satır tahsisi ve PO/kabul; fark/sorumlu | Neden eşleşmedi ve kim çözer aynı yerde |
| UX11 Onay | Tutar, firma, kanıt, fark ve politika | Sürüm değişiminde yeniden incele |
| UX12 Olay | Kanıt, etki, itiraz, faaliyet ve kapanış | İddia/tespit ve tekil sayım |
| UX13 Rapor | Kapsam, kur, kaynak ve veri anı | İhracat da aynı yetkiyi uygular |
| UX14 İmza inceleme | Taraf listesi, kaynak bölge, asıl/e-imza ayrı | Otomatik bulgu ve insan kararı ayrı |

## Etkileşim kuralları
- Kısa inceleme/ilişkili kayıt drawer; çok adımlı iş tam çalışma alanı. Modal yalnız dar ve odaklı karar; iç içe modal yok.
- Proje çalışma alanında özet, kalem, teklifler, karşılaştırma, karar, sözleşme, PO/kabul ve fatura sekmeleri; aşama/sorumlu/sonraki adım kalıcı.
- Tablo: kolon seçimi, kaydedilen görünüm, açık filtre çipleri, sayfalama; toplu işlem bu sayfa/tüm filtre sonucu olarak açık. Satır bazlı işlem sonucu.
- Form: kalıcı etiket, örnek, alan yanında hata + ilk hataya odak, hata özeti. Taslak kaydetme zamanı. Kopya veri girişi yerine doğrulanmış alanı tekrar kullan.
- Eşzamanlı düzenleme: ETag/version çatışması; sessiz üzerine yazma yok. Destructive action açık sonuç, uygun geri al veya ters kayıt.
- Loading/empty/error/partial/permission/quota/offline/conflict ekranları her kritik akışta tasarlanır. OCR aşamaları gerçektir; ölçülmeyen yüzde gösterilmez.
- Öneri etiketleri: AI önerisi / kuralla doğrulandı / insan onaylı. Kaynaksız alan null. Güvenlik ve para hatası doğal dil modelinden değil kontrol sonucundan açıklanır.

## İmza deneyimi
Sözleşme listesi: inceleme bekleyen, görüntü bulunamadı, taraf imzası eksik, belirsiz, aslı beklenen, istisnalı filtreleri. Renk yanında ikon/metin. Taslakta imza yokluğu beklenen durum olabilir. “Islak imza var” yerine uygun bağlamda “İmza görüntüsü teyit edildi; fiziksel asıl doğrulanmadı” yaz.
Belge panelinde taraf/rol/yöntem ve imza adayı. Kaynak sayfa/zoom/bölge. Eylemler: görüntü var, eksik, belirsiz, yeniden belge iste; inceleyen ve gerekçe. Islak imzayı çizmek, kopyalamak veya başka belgeye yapıştırmak bu akışın parçası değildir.

## iOS
SwiftUI native; İşlerim/Tara/Kayıtlar/Daha Fazla. Kamera izni açıklaması, kırp/döndür/çoklu sayfa/kalite kontrolü; şifreli taslak ve tekrar yükleme. Başarı sunucudan gelmeden taslağı silme. Onayda güncel sürüm/kanıt ve kritik fark görünür. Offline nihai onay veya mali kabul yok. QR veya paylaşım bağlantısı yetki yerine geçmez.

## Erişilebilirlik ve ölçüm
WCAG 2.2 AA hedefi; klavye/odak, odak tuzağı yok, etiketler, kontrast, tablo başlıkları, sürükleme alternatifi. Web target en az 24×24 CSS px veya standardın aralık/istisna şartı; native ürün standardı 44×44 pt. VoiceOver/Dynamic Type ve reduce motion. TR/EN, uzun ünvan ve para/tarih formatları.
Prototipte 5–8 hedef kullanıcı görevi; gerçek kullanıcıya erişim yoksa heuristic incelemeyi kullanıcı testi diye yazma. Temel taslak projesi için %85 yardımsız başarı hedefi; fatura farkı ve sorumlusunu 60 saniye içinde bulma; OCR kritik hatasını kaynağa giderek düzeltme; imza eksik tarafını tek yerde görebilme. Bunlar pilot hedefidir.
Playwright ile gerçek tarayıcı: 1440 ve 1280 masaüstü; 390 dar görünüm, taşan tablo/yan panel; klavye ve hata görevleri. iOS'ta küçük/büyük Dynamic Type ile kritik akış. Kanıt dosyaları sentetik veriyle ve sürüm referansıyla tutulur.
