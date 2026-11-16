# Satınalma, Sözleşme ve Tedarikçi Platformu: Analiz v2

Durum: **ONAYLANDI 16.11.2026** (kullanıcı: "Onaylıyorum"). Bölüm 4'teki kaldırma listesi bu onayın parçasıdır. Uygulama kodu, Figma ekran tasarımları onaylandıktan sonra başlar (Faz 0).
Tarih: 16.11.2026. Kaynaklar: kullanıcı talebi (16.11.2026), `KHC.IT.2100.002 Tedarikçiden Alınan Hizmetlerin Yönetimi` (rev 009), `BT Tedarikçi Risk Değerlendirme Tablosu ve Risk Grafiği v2_2026_Q1.xlsx`, mevcut kod ve `docs/implementation-status.md`.

`project-specs/procurement/` altındaki eski gereksinimler değiştirilmedi. Bu doküman onaylanırsa kapsam bakımından onların yerine geçer; çeliştiği yerde bu doküman geçerli olur.

---

## 1. Özet

Mevcut uygulama sipariş, mal kabul, üçlü eşleştirme, tolerans, finans onayı, kur, tasarruf defteri, saklama ve imha gibi ERP işlerine girmiş durumda: 12 rol, yaklaşık 75 yetki, 14 menü girişi, 155 API yolu. Yeni hedef daha dar ve daha net:

> Uygulama finansal süreci işletmez. Satınalma, sözleşme ve tedarikçi süreçlerini işletir ve akıllı hale getirir. Finansal kayıt Oracle ERP'de kalır.

Yeni yapı altı iş alanından oluşur:

| # | Alan | Tek cümleyle |
|---|---|---|
| 1 | Satınalma projesi | Departman talebi, davet edilen tedarikçiler, teklifler, değerlendirme, kazanan |
| 2 | Sözleşme | Belgeden okunan zorunlu alanlar, şablonla karşılaştırma, hukuk gözüyle inceleme, 3 onay, hatırlatıcı |
| 3 | Tedarikçi | Portal başvurusu, tedarikçi kartı, anket, skor, yıllık risk değerlendirmesi |
| 4 | Fatura eşleştirme | ERP'den gelen fatura proje ve sözleşmeye bağlanır; onay ve ödeme yok |
| 5 | Uyum denetimi | Tamamlanan proje, girilen satınalma kurallarına göre denetçi gözüyle puanlanır |
| 6 | Entegrasyon | Azure Entra (kullanıcı, departman, giriş), Oracle ERP (özellik başına API ayarı) |

Roller 12'den 5'e iner. Menü 14 girişten 7'ye iner.

---

## 2. Roller ve görünürlük

### 2.1 Roller

| Yeni rol | Kim | Ne yapar | Eski karşılığı |
|---|---|---|---|
| Yönetici | BT/uygulama yöneticisi | Entra bağlantısı, onaycı ataması, şablonlar, satınalma kuralları, ERP API ayarları. Her şeyi görür. | TENANT_ADMIN, PLATFORM_OPS |
| Satınalma | Satınalma ekibi | Proje açar, tedarikçi davet eder, başvuru onaylar, anket gönderir. Her şeyi görür. | BUYER, PROCUREMENT_MANAGER, MASTER_DATA |
| Departman kullanıcısı | İş birimi çalışanı | Kendi departmanının proje, sözleşme, fatura, teklif ve değerlendirmelerini görür. Sözleşme ekler, yıllık risk değerlendirmesi yapar. | REQUESTER, TECH_EVALUATOR |
| Tedarikçi | Dış firma kullanıcısı | Yalnız portal: başvuru, belge, teklif, anket, kendi skoru ve riski. | SUPPLIER |
| Denetçi (önerim) | İç denetim | Salt okunur. Uyum puanlarını ve denetim izini görür. | AUDITOR |

Kaldırılan roller: FINANCE, LEGAL, SECURITY. Hukuk incelemesi yapay zekâ ön incelemesine, finans işi ERP'ye, güvenlik değerlendirmesi iş biriminin risk değerlendirmesine geçer.

### 2.2 Onaycılar (rol değil, unvan ataması)

Yönetici, Entra'dan gelen kullanıcı listesinden üç unvanı atar:

1. **Departman sorumlusu**: her departman için bir kişi (ve bir vekil).
2. **Satınalma sorumlusu**: kurum genelinde.
3. **Satınalma direktörü**: kurum genelinde.

Talepteki iki ifade ("ekleyen kişinin yönlendireceği onaycılar" ve "3 onaycı") şöyle birleştirildi: zincir varsayılan olarak bu üç unvandan sırayla oluşur. Sözleşmeyi ekleyen kişi göndermeden önce zinciri görür, departman sorumlusu birden fazla ise hangisine gideceğini seçer ve isterse listeden ek onaycı ekler. Üç unvanı zincirden çıkaramaz.

Kurallar: kişi kendi eklediği sözleşmeyi onaylayamaz (vekile düşer); ret gerekçelidir ve sözleşme ekleyene döner; içerik değişirse onay baştan başlar.

### 2.3 Departman bazlı görünürlük

Şu kayıtların hepsinde zorunlu **ilgili departman** alanı olur: proje, teklif, teklif değerlendirmesi, sözleşme, fatura, tedarikçi risk değerlendirmesi.

- Departman kullanıcısı yalnız kendi departmanının kayıtlarını görür. Departman Entra'daki `department` alanından gelir; yönetici bir kullanıcıya ek departman tanımlayabilir.
- Yönetici, Satınalma ve Denetçi hepsini görür.
- Onaycı, kendisine gelen kaydı departmanı farklı olsa da görür.
- Teklif ve değerlendirme, bağlı olduğu projenin departmanını devralır. Fatura, eşleştiği sözleşmenin departmanını devralır.
- Kural veritabanında (RLS) uygulanır, yalnız ekranda değil. Mevcut şirket bazlı RLS'e departman koşulu eklenir.

---

## 3. İş alanları

### 3.1 Satınalma projesi

Akış: Taslak → Teklif toplama → Değerlendirme → Kazanan seçildi → Sözleşme → Tamamlandı.

- Zorunlu alanlar: ad, ilgili departman, konu/kapsam, satınalma yöntemi (davetli teklif, tek kaynak, doğrudan alım), tahmini tutar ve para birimi, teklif son tarihi.
- Satınalmacı projeyi oluştururken **teklif isteyeceği tedarikçileri onaylı tedarikçi listesinden seçer**.
- Seçilen tedarikçilere konu, kapsam özeti, son tarih ve **giriş bağlantısı** içeren e-posta gider. Bağlantı tedarikçiyi girişten sonra doğrudan o projenin teklif ekranına götürür.
- Teklifler son tarihe kadar kapalıdır; satınalmacı son tarihten önce tutarları göremez (mevcut davranış korunur).
- Değerlendirme: teknik ve ticari puan, karşılaştırma tablosu, kazanan ve gerekçe. En düşük teklif seçilmediyse gerekçe zorunludur.
- Kazanan seçilince proje "Sözleşme" adımına geçer; sözleşme bu projeye bağlanarak eklenir.
- Proje detayında sekmeler: Özet, Teklifler, Değerlendirme, Sözleşmeler, Faturalar, Uyum denetimi.

Mevcut `sourcing` modülü bunun büyük kısmını karşılıyor; sadeleştirilir, yeniden yazılmaz.

### 3.2 Sözleşme yönetimi

**Ekleme akışı (4 adım)**

1. **Yükle**: PDF veya taranmış belge (web sürükle bırak, iOS kamera taraması). Proje seçimi zorunludur; projesiz sözleşme kaydedilemez. Aynı dosya daha önce yüklendiyse uyarı verilir.
2. **Oku**: Sonnet belgeyi okur ve alanları doldurur. Her alanın yanında kaynak sayfa ve güven düzeyi görünür; tıklayınca belgede o satır açılır.
3. **Tamamla ve doğrula**: Okunamayan ya da güveni düşük alanlar boş ve işaretli gelir, kullanıcıya **sorulur**. Zorunlu alanlar dolmadan ilerlenemez. Tutar, para birimi, tarihler ve vergi numarası her durumda insan onayı ister (yapay zekâ önerir, insan kaydeder).
4. **İncele ve gönder**: Şablon karşılaştırması ve hukuk incelemesi sonucu gösterilir, onay zinciri onaylanır, gönderilir.

**Zorunlu alanlar**: sözleşme adı/konusu, sözleşme türü (hizmet, donanım, bakım-destek, gizlilik, danışmanlık, diğer), tedarikçi, ilgili proje, ilgili departman, sözleşme sorumlusu, imza tarihi, başlangıç, bitiş (ya da "süresiz" + fesih ihbar süresi), tutar, para birimi, KDV dahil/hariç, otomatik yenileme var/yok.
**İsteğe bağlı**: sözleşme no, ödeme vadesi, fesih ihbar süresi, teminat, SLA ve ceza koşulu, KVKK/gizlilik maddesi var/yok, yetkili mahkeme, fiyat artış koşulu.

**Tedarikçi kartı zorunluluğu**: sözleşme mutlaka bir tedarikçi kartına bağlanır. Okunan firma kayıtlı değilse kullanıcı ya mevcut kartı seçer ya da en az alanla (unvan, vergi no, iletişim) "aday" kart açar; Satınalma sonradan tamamlar.

**Şablon (taslak) kütüphanesi**
- Yönetici ve Satınalma, kurumun taslak sözleşmelerini **.docx** olarak yükler: tür, ad, sürüm, geçerlilik tarihi. Prosedürdeki şablonlar başlangıç setidir: Hizmet (KHC.F.2100.016), Donanım (.028), Bakım-Destek (.021), Gizlilik (.020), Danışmanlık (.078).
- Yetkili herkes şablonu **indirebilir** ve yeni sözleşme hazırlarken kullanır. Eski sürüm silinmez, "geçersiz" olur.

**Şablon uygunluğu ve hukuk incelemesi (Sonnet)**
- Sözleşme, türüne uyan güncel şablonla madde madde karşılaştırılır: eksik madde, değiştirilmiş madde, kurum aleyhine değişiklik, şablonda olmayan ek madde.
- Hukukçu gözüyle inceleme: sorumluluk sınırı, cezai şart, fesih, süre ve yenileme, gizlilik/KVKK, fikri haklar, yetkili mahkeme, mücbir sebep, ödeme koşulları, tek taraflı değişiklik yetkisi.
- Çıktı: **0–100 uygunluk puanı**, alt başlık puanları, bulgu listesi (önem derecesi, madde alıntısı, sayfa, öneri) ve bir paragraf genel yorum.
- Ekranda açıkça "Yapay zekâ ön incelemesidir, hukuki görüş değildir" yazar. Puan onayı otomatik vermez ya da engellemez; onaycıya bilgi olarak gider. Eşiğin altındaki puanda ek onaycı eklenmesi önerilir (bkz. Öneri 3).

**Hatırlatıcılar**
- Bitişe 90, 60, 30 ve 7 gün kala; otomatik yenilemeli sözleşmede fesih ihbar süresinin son gününden 30 gün önce.
- Alıcılar: sözleşme sorumlusu ve departman sorumlusu; 30 günde Satınalma da eklenir. Kanallar: e-posta ve uygulama içi görev (iOS'ta "İşlerim").
- Hatırlatıcı "yenilenecek / sonlandırılacak / yeni proje açıldı" kararı girilene kadar kapanmaz. Süreler yönetici tarafından değiştirilebilir.

**Sözleşme detayı**: Özet, Belge, İnceleme (şablon + hukuk), Onaylar, İmzalar, Faturalar (toplam fatura / sözleşme tutarı kullanım çubuğu), Hatırlatıcılar, Geçmiş.

### 3.3 Tedarikçi kartı ve tedarikçi portalı

**Durumlar**: Başvuru → Aday → Onaylı → Pasif (ya da Reddedildi). Prosedüre uygun olarak pasife alınan tedarikçinin verisi silinmez.

**Portal (ayrı adres, ayrı giriş)**
1. **Başvuru (girişsiz)**: firma bilgileri, vergi no, iletişim kişisi, hizmet kategorileri ve zorunlu belgeler (vergi levhası, imza sirküleri, ticaret sicil gazetesi, faaliyet belgesi; kategoriye göre ISO 27001 vb.). Belge listesi yönetici tarafından ayarlanır. E-posta doğrulandıktan sonra başvuru kaydedilir.
2. Satınalma başvuruyu inceler: onaylarsa **Aday** olur, eksik belge isterse tedarikçiye geri döner.
3. Aday tedarikçi gönderilen anketleri doldurur. Satınalma onayıyla **Onaylı** olur; yalnız onaylı tedarikçi teklife davet edilebilir.
4. **Giriş sonrası tedarikçi ekranları**: Teklif davetleri, Tekliflerim, Anketler, Skorum ve risk durumum, Belgelerim (süresi dolan belge için yenileme), Firma bilgileri.
5. Tedarikçi anket sonrası **skorunu** ve **risk seviyesini** görür; kendisinden beklenen aksiyonları görür. Kurum içi yorumları ve kritiklik girdilerini görmez.

**Tedarikçi kartı (kurum içi)**: kimlik ve iletişim, durum, belgeler ve geçerlilik tarihleri, sözleşmeler, projeler ve teklif geçmişi, anket skorları, yıllara göre risk değerlendirmeleri, aksiyon planları, sorumlu ekip. Prosedürdeki envanter alanları da burada tutulur: sunulan hizmetler, hizmet kapsamı, sorumlu ekip, tedarikçi yöneticisi, VPN erişimi var/yok, SLA, çağrı kanalı.

### 3.4 Yıllık tedarikçi risk değerlendirmesi (ekteki yöntem)

Tedarikçiyle çalışan iş birimi her yıl değerlendirme yapar. Hesap, Excel'deki ve prosedürdeki yöntemle **aynıdır**.

**Adım 1: Kritiklik skoru (1–5).** Altı ölçüt, her biri 1, 3 ya da 5:

| Ölçüt | 1 (Düşük) | 3 (Orta) | 5 (Yüksek) |
|---|---|---|---|
| Hizmetin iş süreçlerine etkisi | Yardımcı hizmet | Önemli ama yedeklenebilir | Kritik süreç bu tedarikçiye bağlı |
| Veri hassasiyeti | Genel/halka açık | Kurumsal hassas | Kişisel, finansal, regülasyona tabi |
| Süreklilik ve bağımlılık | Alternatif var, geçici | Orta bağımlılık, dönemsel | Alternatifsiz, sistemik |
| Entegrasyon derinliği | Sistem erişimi yok | Sınırlı entegrasyon/VPN | Sürekli erişim, yüksek entegrasyon |
| Regülasyon uyumu gerekliliği | Tabi değil | Dolaylı (iç politika, denetim) | KVKK, ISO vb. zorunlu |
| Hizmet tipi ve süresi | Kısa, tek seferlik | Orta vadeli, proje bazlı | Sürekli, SLA'lı uzun dönem |

Kritiklik = altı puanın **geometrik ortalaması** (Excel: `GEOMEAN`). Örnek: 3, 5, 1, 3, 5, 5 → 3,22.

**Adım 2: Risk skoru (0–100).** Evet/Hayır sorularından oluşan Tedarikçi Riski Değerlendirme Şablonu; Evet = 1, Hayır = 0, her sorunun ağırlığı var; sorular ve ağırlıklar hizmet kapsamına göre değişir. Skor = ağırlıklı toplam / toplam ağırlık × 100.

**Adım 3: Risk seviyesi (1–5).** Excel'deki "Risk Grafiği" matrisi birebir kullanılır. Kritiklik en yakın tam sayıya yuvarlanarak sütun seçilir:

| Risk skoru \ Kritiklik | 1 | 2 | 3 | 4 | 5 |
|---|---|---|---|---|---|
| 80–100 | 3 | 3 | 4 | 5 | 5 |
| 60–80 | 2 | 3 | 3 | 4 | 5 |
| 40–60 | 2 | 2 | 3 | 3 | 4 |
| 20–40 | 1 | 2 | 2 | 3 | 3 |
| 0–20 | 1 | 1 | 2 | 2 | 3 |

Seviye 1 kabul edilebilir risktir (prosedür: risk ≤ 40 ve kritiklik 1, ya da risk ≤ 20 ve kritiklik ≤ 2). Seviye 4 ve 5 için **aksiyon planı** ve denetim/kontrol zorunludur; aksiyon sahibi ve tarihi girilmeden değerlendirme kapanmaz.

**İşleyiş**
- Her yılın başında, aktif sözleşmesi olan her tedarikçi için ilgili departmana görev açılır. Geciken görev departman sorumlusuna yükselir.
- Önceki yılın cevapları hazır gelir; değişen işaretlenir.
- Çıktılar: tedarikçi kartında yıl yıl geçmiş, kurum geneli 5×5 risk matrisi ekranı (hücreye tıklayınca tedarikçiler), Excel'deki "Risk Tablosu" biçiminde dışa aktarım (holding raporlaması için).
- Hesap kodda yapılır, yapay zekâ skor üretmez. Yöntemin sürümü kayıtla birlikte saklanır; şablon değişirse eski değerlendirmeler eski sürümle kalır.

Mevcut `supplierEval` modülü (sürümlü anket şablonları, ağırlıklar) bu iş için uyarlanır.

### 3.5 Fatura eşleştirme

- Fatura bu uygulamada **onaylanmaz ve ödenmez**. Kaynak Oracle ERP'dir (gerekirse elle ya da e-fatura dosyasıyla da eklenebilir).
- Her fatura bir tedarikçiye, bir **sözleşmeye** ve onun üzerinden bir **projeye** ve departmana bağlanır.
- Otomatik eşleştirme sırası: ERP'den gelen sözleşme/sipariş referansı → tedarikçi + tarih aralığı + tek aktif sözleşme → eşleşmedi kuyruğu. Eşleşmeyenleri Satınalma ya da ilgili departman elle bağlar.
- Proje ve sözleşme detayında faturalar listelenir; sözleşme tutarına göre kullanım ve aşım uyarısı gösterilir. Aşım yalnız bilgidir, engel değildir.

### 3.6 Uyum denetimi (denetçi gözüyle)

Proje "Tamamlandı" olduğunda uygulama projeyi denetler ve **0–100 uyum puanı** üretir.

**Satınalma kuralları kataloğu**: Yönetici kuralları uygulama içinden girer. Her kural: ad, açıklama, kapsam (yöntem, tutar eşiği), kontrol türü, ağırlık, zorunlu mu.

| Kontrol türü | Örnek kural | Nasıl bakılır |
|---|---|---|
| Otomatik (veri) | En az 3 teklif alınmış mı | Geçerli teklif sayısı |
| Otomatik (veri) | En düşük teklif seçilmediyse gerekçe var mı | Değerlendirme kaydı |
| Otomatik (veri) | Kazanan tedarikçi onaylı mı, risk değerlendirmesi güncel mi, risk seviyesi kaç | Tedarikçi kartı |
| Otomatik (veri) | Sözleşme üç onayı tamamlamış mı; sözleşme tarihi karardan sonra mı | Onay ve tarih kayıtları |
| Otomatik (veri) | Sözleşme tutarı kazanan teklifle uyumlu mu; faturalar sözleşmeyi aşıyor mu | Tutar karşılaştırması |
| Otomatik (veri) | Sözleşmenin şablon uygunluk puanı eşiğin üstünde mi | 3.2'deki puan |
| Kanıt + yapay zekâ | Kazanan firma araştırması yapılmış mı | Yüklenen araştırma belgesi okunur, içerik kuralı karşılıyor mu |
| Kanıt + yapay zekâ | Sahiplik / ilişkili taraf araştırması yapılmış mı | Ticaret sicil gazetesi ve çıkar çatışması beyanı okunur |
| Elle | Kuruma özel diğer kurallar | Satınalmacı işaretler, kanıt ekler |

- **Puan kodda hesaplanır** (kural sonucu × ağırlık). Sonnet yalnız belgeye dayalı kuralları değerlendirir ve denetçi diliyle özet rapor yazar: bulgular, kanıt alıntıları, öneriler. Böylece aynı proje her seferinde aynı puanı alır.
- Zorunlu bir kural karşılanmadıysa puan ne olursa olsun proje "Uyumsuz" işaretlenir.
- Rapor proje detayında "Uyum denetimi" sekmesinde ve Denetçi ekranında görünür; PDF olarak indirilebilir.
- Kurallar sürümlüdür; proje, tamamlandığı gündeki kural setiyle değerlendirilir.

### 3.7 Azure Entra entegrasyonu

- **Giriş**: kurum kullanıcıları Entra ile tek oturum açar (web ve iOS). Mevcut OIDC + PKCE altyapısı kullanılır; yerel şifre yoktur.
- **Kapsam**: yönetici hangi kullanıcıların alınacağını seçer; tüm dizin çekilmez.
  - Teknik not: bulut Entra'da "OU" kavramı yoktur; OU şirket içi AD'ye aittir. Aynı sonucu veren üç yol var: (a) Entra **grubu**, (b) Entra **yönetim birimi** (administrative unit), (c) AD'den eşitlenen kullanıcılarda OU yolu (`onPremisesDistinguishedName`) süzgeci. Yönetici ekranı üçünü de destekler; önerim (a).
- **Çekilen alanlar**: ad, e-posta, kullanıcı adı, `department`, unvan, yönetici (`manager`), hesap etkin mi.
- **Departman listesi**: alınan kullanıcıların `department` değerlerinden türetilir. Yazım farkları için yönetici iki departmanı birleştirebilir.
- **Eşitleme**: gece otomatik ve "şimdi eşitle" düğmesi. Entra'da kapatılan kullanıcı uygulamada da kapanır; üzerindeki onay görevleri vekile ya da yöneticiye düşer.
- **Rol ataması**: yönetici kullanıcı listesinden yapar. Onaycılar da aynı listeden seçilir. Departman sorumlusu için Entra'daki `manager` alanı öneri olarak gösterilir.
- Gereken: kurum Entra'sında uygulama kaydı ve yönetici onayı (salt okuma: kullanıcı ve grup).

### 3.8 Oracle ERP entegrasyonu

Her özelliğin kendi API ayar kartı olur: adres, kimlik doğrulama, yön, zamanlama, alan eşlemesi, "bağlantıyı sına" düğmesi, son çalışmalar ve hata kaydı. Bir özellik kapalıyken uygulama o veriyi elle girişle çalıştırır.

| Özellik | Yön | Açıklama |
|---|---|---|
| Tedarikçi ana verisi | ERP ↔ Uygulama | Onaylı tedarikçi ERP'ye gider; ERP tedarikçi kodu geri alınır |
| Departman / masraf merkezi | ERP → Uygulama | İsteğe bağlı eşleme; ana kaynak Entra |
| Satınalma projesi / talep | Uygulama → ERP | Kazanan ve tutar ERP'ye talep olarak gider |
| Sözleşme | Uygulama → ERP | Onaylanan sözleşmenin başlık bilgisi (prosedür: sözleşmeler satınalmaya Oracle üzerinden iletilir) |
| Sipariş | ERP → Uygulama | Salt okunur; fatura eşleştirmede referans |
| Fatura | ERP → Uygulama | Fatura başlığı ve sözleşme/sipariş referansı |
| Ödeme durumu | ERP → Uygulama | İsteğe bağlı, salt okunur bilgi |

Mevcut kuyruk, yeniden deneme ve mutabakat altyapısı (`modules/integration.ts`) korunur. API parolaları veritabanında düz metin tutulmaz. Gerçek Oracle ile deneme yapılana kadar bu bölümün durumu "taklit sağlayıcıyla denendi" olarak raporlanır, PASS denmez.

### 3.9 Yapay zekâ

- Tüm yapay zekâ işlemleri **Sonnet** ile yapılır (`claude-sonnet-5-5`). Model adı tek ayardan gelir.
- Kullanım yerleri: sözleşme alan okuma, şablon karşılaştırma, hukuk incelemesi, uyum denetimi raporu, kanıt belgesi okuma.
- Ayrı bir OCR motoru gerekmez; Sonnet taranmış PDF'i doğrudan okur. Çok düşük kaliteli taramada kullanıcıya alanlar sorulur.
- İlke değişmez: yapay zekâ **öneri** üretir; tutar, vergi no, onay ve ödeme kararını insan verir. Her çıktıda kaynak sayfa gösterilir, her çağrı kayıt altına alınır (kim, hangi belge, hangi sürüm).
- Bu ücretli bir dış hizmettir ve sözleşme metinleri kurum dışına çıkar. Başlamak için onayınız ve sağlayıcı kanalı kararı gerekir (bkz. Karar 3).

---

## 4. Mevcut uygulamadan ne kalıyor, ne sadeleşiyor, ne kalkıyor

Genel "sıfır gerileme" kuralınız var; bu talep ise bilerek özellik azaltmayı istiyor. Bu yüzden kaldırılacak her şey aşağıda tek tek yazıldı ve **açık onayınıza** bağlı. Onaylamadığınız satır yerinde kalır.

| Mevcut ekran / işlev | Karar | Yeni yeri / gerekçe |
|---|---|---|
| İşlerim | **Kalır** | Onaylar, hatırlatıcılar, risk değerlendirme görevleri |
| Projeler, proje sihirbazı, teklif, değerlendirme, kazanan | **Kalır, sadeleşir** | 3.1 |
| Tek kaynak istisnası | **Sadeleşir** | Satınalma yöntemi seçeneği + gerekçe alanı |
| Kurallı onay politikası ekranı (tutar/kategori kuralları) | **Kalkar** | Sabit üç onaycı zinciri |
| Tedarikçiler, tedarikçi detayı | **Kalır, genişler** | Tedarikçi kartı (3.3) |
| Banka bilgisi değişikliği doğrulama akışı | **Kalkar** | Banka verisi ERP'de |
| Sözleşmeler listesi ve detayı | **Kalır, genişler** | 3.2 |
| Belge girişi | **Birleşir** | "Sözleşme ekle" akışının ilk adımı |
| İmza çalışma alanı (imza doğrulama) | **Kalır** | Sözleşme detayında "İmzalar" sekmesi |
| Yenileme/fesih hatırlatıcıları, yükümlülükler | **Kalır** | Hatırlatıcılar |
| Fiyat revizyonu/endeks hesabı, SLA kredisi hesabı, teminat takibi | **Sadeleşir** | Hesap motorları kalkar; sözleşmede bilgi alanı olarak kalır |
| Siparişler, mal/hizmet kabul | **Kalkar** | ERP'de; sipariş salt okunur referans olarak gelir |
| Fatura finans onayı, istisna onayı, tolerans, üçlü eşleştirme | **Kalkar** | Fatura yalnız eşleştirilir (3.5) |
| Faturalar listesi ve detayı | **Kalır, sadeleşir** | Proje ve sözleşme bağlantısı, departman süzgeci |
| ERP mutabakatı ekranı | **Dönüşür** | Yönetici > Entegrasyonlar, özellik başına kayıt |
| Lira Defteri (tasarruf/geri kazanım), TCMB kur alma | **Kalkar** | Finansal kapsam |
| Olaylar, düzeltici faaliyetler | **Birleşir** | Tedarikçi kartında "Aksiyon planları" |
| Anketler, performans ağırlıkları, değerlendirmeler | **Kalır** | Tedarikçi > Anketler ve risk |
| Raporlar (KPI) | **Sadeleşir** | Tek pano: biten sözleşmeler, risk matrisi, uyum puanları, açık onaylar |
| Yapay zekâ sayfası | **Dönüşür** | Yönetici > Yapay zekâ ayarları ve kullanım kaydı |
| Veri yönetimi (saklama, yasal bekletme, imha) | **Kalkar** | Denetim izi ve dışa aktarım Yönetici altında kalır |
| Arama, bildirimler, kayıtlı görünümler | **Kalır** | |
| Tedarikçi portalı (teklif davetleri, anketler) | **Kalır, genişler** | 3.3 |
| iOS: görevler, belge tarama, kayıtlar, imza | **Kalır** | Tarama "Sözleşme ekle"ye bağlanır |
| iOS: fatura finans onayı | **Kalkar** | Fatura salt okunur görünür |

**Güvence**: kaldırma, ekrandan ve yetkiden çıkarma demektir. Veritabanı tabloları ve mevcut veriler silinmez; mevcut sürüm `v1` etiketiyle saklanır ve yeni çalışma ayrı dalda yapılır. Karar değişirse geri alınabilir. Bekleyen üç deneme faturasına (ANB2026000101, ANB2026000102, EGE2026000877) dokunulmaz.

**Yeni menü (7 giriş)**: İşlerim · Projeler · Sözleşmeler · Tedarikçiler · Faturalar · Raporlar · Yönetim (Kullanıcılar ve Entra, Onaycılar, Şablonlar, Satınalma kuralları, Entegrasyonlar, Yapay zekâ, Denetim izi).

---

## 5. Veri modeli değişiklikleri (özet)

- **Yeni**: `departments`, `directory_users` (Entra eşitlemesi), `approver_assignments`, `contract_templates` (+ sürümler, docx), `contract_extractions` (alan, değer, kaynak sayfa, güven, onaylayan), `contract_reviews` (puan, bulgular, model ve şablon sürümü), `contract_approvals`, `supplier_applications` (+ belgeler), `risk_assessments` (yıl, ölçütler, cevaplar, skorlar, seviye, yöntem sürümü), `risk_actions`, `procurement_rules` (+ sürümler), `compliance_audits` (+ kural sonuçları), `integration_endpoints` (özellik başına ayar), `email_outbox` (davet, hatırlatıcı).
- **Değişen**: proje, sözleşme, fatura, teklif, değerlendirme tablolarına `department_id`; sözleşmeye zorunlu `project_id` ve `supplier_id`; faturaya `contract_id` ve `project_id`.
- Her yeni tabloda RLS politikası ve en dar yetki verilir; para alanları ondalık metin olarak tutulur; imza durumu saklanmaz, türetilir (mevcut kurallar aynen).
- Eski kayıtların taşınması: departmanı olmayan mevcut kayıtlara yönetici toplu departman atar; atanana kadar yalnız Yönetici ve Satınalma görür.

---

## 6. Ekranlar (Figma'da sunulacak)

Onay sonrası Figma'da web için şu ekranlar çizilir; iOS için işaretliler ayrıca:

1. Giriş (Entra) ve ana kabuk, yeni menü
2. İşlerim (iOS)
3. Proje listesi, proje oluşturma (tedarikçi seçimi ve davet), proje detayı ve sekmeleri
4. Teklif karşılaştırma ve değerlendirme
5. Sözleşme listesi; sözleşme ekleme 4 adım (yükle, okunan alanlar ve soru sorulan alanlar, inceleme sonucu, onay zinciri) (iOS: tarama ve doğrulama)
6. Sözleşme detayı: inceleme puanı ve bulgular, onaylar, faturalar, hatırlatıcılar
7. Onay ekranı (iOS)
8. Şablon kütüphanesi
9. Tedarikçi listesi, tedarikçi kartı, başvuru inceleme
10. Risk değerlendirme formu (6 ölçüt + sorular), 5×5 risk matrisi
11. Fatura listesi ve eşleştirme kuyruğu
12. Uyum denetimi raporu; satınalma kuralları kataloğu
13. Yönetim: Entra kapsam seçimi ve kullanıcılar, onaycı ataması, ERP entegrasyon kartları, yapay zekâ ayarları
14. Tedarikçi portalı: başvuru, belge yükleme, teklif verme, anket, skor ve risk
15. Davet ve hatırlatma e-posta şablonları

Mevcut "Mor Istampa" tasarım dili (`DESIGN.md`) korunur.

---

## 7. Önerilerim

1. **Tedarikçi girişi için şifresiz, tek kullanımlık e-posta bağlantısı.** Tedarikçiler Entra'da değildir; şifre saklamamak hem güvenli hem de "maildeki linke tıklayıp teklif ver" isteğinize birebir uyar. Bağlantı kısa ömürlü ve tek kullanımlık olur.
2. **Puanları kod hesaplasın, yapay zekâ açıklasın.** Risk skoru ve uyum puanı denetime konu olur; aynı girdinin her zaman aynı sonucu vermesi gerekir.
3. **Düşük hukuk puanında ek onaycı.** Uygunluk puanı belirlenen eşiğin altındaysa zincire kurumun hukuk danışmanı ek onaycı olarak önerilsin. Hukuk rolünü kaldırırken tek güvenlik ağı bu olur.
4. **Onayda vekâlet ve süre aşımı.** Onaycı izindeyse vekile düşsün; belirli gün bekleyen onay hatırlatılsın ve bir üst unvana bildirilsin. Yoksa üç kişilik zincir tek kişide tıkanır.
5. **OU yerine Entra grubu.** Daha basit, bulut Entra ile doğal uyumlu ve kullanıcı eklemek BT'nin zaten bildiği bir iş.
6. **Mevcut Excel'i başlangıç verisi olarak içe al.** Tabloda yaklaşık 104 tedarikçi var; kritiklik puanları ve aksiyon planlarıyla birlikte alınırsa ilk gün boş ekranla başlanmaz.
7. **Yıllık değerlendirme + çeyreklik gözden geçirme.** Siz yıllık istediniz, prosedür çeyreklik gözden geçirme ve holding'e Excel raporu istiyor. Önerim: yıllık tam değerlendirme zorunlu, çeyreklik "değişiklik yok / güncelle" tek tıkla; dışa aktarım aynı Excel biçiminde.
8. **ERP'de önce okuma, sonra yazma.** Önce tedarikçi ve fatura okuma devreye alınsın; ERP'ye yazan akışlar (sözleşme, talep) ikinci adımda. Hata riski düşük olandan başlanır.
9. **Okuma doğruluğunu canlıdan önce ölçelim.** 20–30 gerçek sözleşmeyle alan bazında doğruluk ölçülsün; sonuç size raporlansın. Ölçülmeden "okuyor" denmesin.
10. **Tedarikçi belgelerinde geçerlilik takibi.** ISO sertifikası, faaliyet belgesi gibi belgelerin bitiş tarihi tutulsun; biten belge için tedarikçiye otomatik hatırlatma gitsin.
11. **Ayrılış kontrol listesi.** Prosedürdeki tedarikçi işten çıkarma adımları (erişim kapatma, veri iadesi) tedarikçi pasife alınırken kontrol listesi olarak çıksın.
12. **Yüklenen dosyalar için virüs taraması.** Portal dışarıya açık olacağı için ücretsiz ClamAV ile tarama zorunlu olsun.
13. **E-postayı Microsoft Graph üzerinden gönderelim.** Entra zaten bağlanıyor; ayrı posta sunucusu ayarı gerekmez, gönderen adres kurumsal olur.
14. **Çıkar çatışması beyanı.** Değerlendirmeye katılan herkes proje başına tek tıkla beyan versin; sahiplik araştırması kuralının en sağlam kanıtı budur.

---

## 8. Uygulama sırası

| Faz | İçerik | Bitti ölçütü |
|---|---|---|
| 0 | Figma ekran tasarımları, onayınız | Tasarım onayı |
| 1 | Sadeleştirme: yeni roller, menü, departman alanı ve görünürlük, eski modüllerin ekrandan kaldırılması | Envanter karşılaştırması, mevcut testler |
| 2 | Entra: giriş, kapsam seçimi, eşitleme, onaycı ataması | Gerçek Entra kiracısıyla deneme |
| 3 | Sözleşme: ekleme akışı, zorunlu alanlar, şablon kütüphanesi, üç onay, hatırlatıcılar | Uçtan uca persona testi (web + iOS) |
| 4 | Yapay zekâ: alan okuma, şablon karşılaştırma, hukuk incelemesi | Gerçek sözleşmelerle doğruluk ölçümü |
| 5 | Tedarikçi portalı: başvuru, belgeler, davet e-postası ve bağlantıyla teklif, skor/risk görünümü | Dış kullanıcıyla uçtan uca |
| 6 | Risk değerlendirmesi: yöntem, matris, Excel içe/dışa aktarım | Excel'deki örneklerle aynı sonuç |
| 7 | Fatura eşleştirme ve uyum denetimi, kural kataloğu | Örnek projelerde tekrarlanabilir puan |
| 8 | Oracle ERP: özellik başına API kartları | Gerçek Oracle test ortamıyla deneme |

Her fazda web ve iOS birlikte ilerler; faz sonunda persona testi ve kod incelemesi yapılır. Taklit sağlayıcıyla geçen kontrol "gerçek başarı" olarak raporlanmaz.

---

## 9. Sizden beklenen kararlar ve bilgiler

| # | Konu | Önerim |
|---|---|---|
| 1 | **Bölüm 4'teki kaldırma listesi** (sıfır gerileme kuralına bilinçli istisna) | Listeyi olduğu gibi onaylamanız |
| 2 | **Tedarikçi Riski Değerlendirme Şablonu** (26 soru ve ağırlıklar). Excel'de yok, prosedür ekinde ayrı dosya; "Evet"in riski artırıp artırmadığı da orada | Dosyayı iletmeniz. Gelene kadar sorular yönetici ekranından girilebilir yapılır |
| 3 | **Yapay zekâ sağlayıcı kanalı ve bütçe.** Sözleşme metinleri kurum dışına çıkacak (KVKK). Seçenekler: doğrudan Anthropic API, ya da kurumun bulut sözleşmesi üzerinden (AWS Bedrock, Microsoft Foundry) | Kurumun mevcut bulut sözleşmesi üzerinden, veri saklamama koşuluyla; hukuk/KVKK birimine danışılması |
| 4 | **Oracle sürümü**: E-Business Suite mi, Fusion Cloud mu? API dokümanı ve test ortamı | Excel'deki "Oracle EBS Ekibi" ifadesinden EBS varsayıyorum; teyit edin |
| 5 | **Entra kapsamı**: grup mu, yönetim birimi mi, OU süzgeci mi? Uygulama kaydı için yetkili kişi | Grup |
| 6 | **Onay sırası**: sıralı mı (departman → satınalma sorumlusu → direktör), paralel mi? | Sıralı |
| 7 | **Tedarikçi risk sonucunu ne kadar görsün?** | Seviye, skor ve beklenen aksiyonlar; iç yorumlar hariç |
| 8 | **Birden çok departman aynı tedarikçiyle çalışıyorsa** değerlendirmeyi kim yapar? | Tedarikçi kartındaki sorumlu ekip yapar, diğerleri görüş ekler; tedarikçi başına yılda tek değerlendirme |
| 9 | **Fatura kaynağı**: yalnız Oracle mı, elle/e-fatura yükleme de kalsın mı? | Oracle ana kaynak, elle ekleme yedek |
| 10 | **Çoklu şirket** (hastaneler ayrı şirket mi?) | Altyapı kalsın, tek şirketle başlansın |
| 11 | **Denetçi rolü** kalsın mı? | Kalsın (salt okunur) |
