---
name: Satınalma ve Sözleşme
description: Mor Istampa — kâğıt zemin, koyu mürekkep; kanıtın kökeni mürekkebinden okunur.
colors:
  ink: "#1d2230"
  on-ink: "#f8f6f0"
  istampa: "#5b3fa0"
  istampa-soft: "#efeaf8"
  verified: "#2a6a59"
  verified-soft: "#e2efe9"
  ai: "#5f6370"
  danger: "#a8372a"
  danger-soft: "#f8e3de"
  warn: "#855600"
  warn-soft: "#f7ebcd"
  info: "#33415e"
  info-soft: "#e5e8ef"
  focus: "#2f4f8f"
  paper: "#f4f2ec"
  surface: "#fbfaf6"
  field: "#ffffff"
  surface-sunken: "#ece8de"
  rail: "#e9e5da"
  selected: "#e7e2d5"
  rule-faint: "#ebe6da"
  rule-line: "#ddd6c6"
  rule-strong: "#c2b9a5"
  ink-muted: "#4c5262"
  ink-subtle: "#5c6270"
typography:
  headline:
    fontFamily: "'Source Sans 3 Variable', system-ui, -apple-system, 'Segoe UI', sans-serif"
    fontSize: "1.5rem"
    fontWeight: 650
    lineHeight: 1.25
    letterSpacing: "-0.01em"
  title:
    fontFamily: "'Source Sans 3 Variable', system-ui, -apple-system, 'Segoe UI', sans-serif"
    fontSize: "1.25rem"
    fontWeight: 650
    lineHeight: 1.25
  title-sm:
    fontFamily: "'Source Sans 3 Variable', system-ui, -apple-system, 'Segoe UI', sans-serif"
    fontSize: "1.0625rem"
    fontWeight: 650
    lineHeight: 1.25
  body:
    fontFamily: "'Source Sans 3 Variable', system-ui, -apple-system, 'Segoe UI', sans-serif"
    fontSize: "0.875rem"
    fontWeight: 400
    lineHeight: 1.5
  label:
    fontFamily: "'Source Sans 3 Variable', system-ui, -apple-system, 'Segoe UI', sans-serif"
    fontSize: "0.8125rem"
    fontWeight: 600
    lineHeight: 1.25
  column-head:
    fontFamily: "'Source Sans 3 Variable', system-ui, -apple-system, 'Segoe UI', sans-serif"
    fontSize: "0.75rem"
    fontWeight: 600
    lineHeight: 1.5
    letterSpacing: "0.02em"
  mono:
    fontFamily: "'IBM Plex Mono', ui-monospace, monospace"
    fontSize: "0.8125rem"
    fontWeight: 400
    lineHeight: 1.5
rounded:
  sm: "4px"
  md: "6px"
  lg: "8px"
spacing:
  "1": "4px"
  "2": "8px"
  "3": "12px"
  "4": "16px"
  "6": "24px"
  "8": "32px"
  "12": "48px"
components:
  button-primary:
    backgroundColor: "{colors.ink}"
    textColor: "{colors.on-ink}"
    rounded: "{rounded.md}"
    padding: "0 16px"
    height: "36px"
  button-outline:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.ink}"
    rounded: "{rounded.md}"
    padding: "0 16px"
    height: "36px"
  button-outline-hover:
    backgroundColor: "{colors.selected}"
    textColor: "{colors.ink}"
  button-sm:
    rounded: "{rounded.md}"
    padding: "0 12px"
    height: "32px"
  tag-human:
    backgroundColor: "{colors.istampa-soft}"
    textColor: "{colors.istampa}"
    typography: "{typography.label}"
    rounded: "{rounded.sm}"
    padding: "1px 8px"
  tag-verified:
    backgroundColor: "{colors.verified-soft}"
    textColor: "{colors.verified}"
    typography: "{typography.label}"
    rounded: "{rounded.sm}"
    padding: "1px 8px"
  tag-ai:
    textColor: "{colors.ai}"
    typography: "{typography.label}"
    rounded: "{rounded.sm}"
    padding: "1px 8px"
  tag-danger:
    backgroundColor: "{colors.danger-soft}"
    textColor: "{colors.danger}"
    typography: "{typography.label}"
    rounded: "{rounded.sm}"
    padding: "1px 8px"
  tag-warn:
    backgroundColor: "{colors.warn-soft}"
    textColor: "{colors.warn}"
    typography: "{typography.label}"
    rounded: "{rounded.sm}"
    padding: "1px 8px"
  tag-info:
    backgroundColor: "{colors.info-soft}"
    textColor: "{colors.info}"
    typography: "{typography.label}"
    rounded: "{rounded.sm}"
    padding: "1px 8px"
  nav-item:
    textColor: "{colors.ink-muted}"
    rounded: "{rounded.md}"
    padding: "0 10px"
    height: "36px"
  nav-item-active:
    backgroundColor: "{colors.ink}"
    textColor: "{colors.on-ink}"
  filter-chip:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.ink}"
    typography: "{typography.label}"
    rounded: "{rounded.md}"
    padding: "0 12px"
    height: "32px"
  filter-chip-pressed:
    backgroundColor: "{colors.ink}"
    textColor: "{colors.on-ink}"
  input:
    backgroundColor: "{colors.field}"
    textColor: "{colors.ink}"
    rounded: "{rounded.md}"
    padding: "6px 10px"
    height: "36px"
  panel:
    backgroundColor: "{colors.surface}"
    rounded: "{rounded.md}"
    padding: "16px"
  side-rail:
    backgroundColor: "{colors.rail}"
    width: "256px"
  table-head:
    backgroundColor: "{colors.surface-sunken}"
    textColor: "{colors.ink-muted}"
    typography: "{typography.column-head}"
    padding: "8px 12px"
---

# Design System: Satınalma ve Sözleşme

## Overview

**Creative North Star: "Mor Istampa"**

Bir satınalma dosyası, evrak masasında açılmış gibi okunur: kâğıt beyazı zemin, koyu mürekkep metin, çizgiyle ayrılmış paneller. Sistemin tek fikri, bir kanıtın kimden geldiğinin rengiyle değil mürekkebiyle okunmasıdır. İnsan kararı (onay, kurul kararı, imza teyidi) mor ıstampa olarak basılır; hafifçe eğik, kalın çerçeveli bir kaşe. Kural doğrulaması ince yeşil çerçeve taşır. Otomatik öneri kesik çizgili gri bir taslaktır ve asla mürekkep sayılmaz.

Yoğunluk bir çalışma aracının yoğunluğudur: 14px gövde, 4px ızgara, tabular rakamlar, satır içinde birincil eylem. Kart duvarı, gri zemin + mavi vurgu ve rozet yığını bu dünyanın reddettiği kategori varsayılanlarıdır; durum tek bir etiketle, ikon ve metinle birlikte söylenir. Gölge yoktur; derinlik zemin tonları (kâğıt, yüzey, çökük zemin, menü rayı) ve 1px çizgilerle kurulur.

**Key Characteristics:**
- Kâğıt zemin üzerinde koyu mürekkep; birincil eylem mürekkep zeminli düğme.
- Üç köken mürekkebi: mor ıstampa (insan), yeşil çerçeve (kural), kesik gri (otomatik öneri).
- Kart yerine çizgiyle bölünmüş paneller; gölgesiz, tonla katmanlanmış yüzeyler.
- Source Sans 3, tabular rakam; evrak numarası, hash, IBAN ve VKN için IBM Plex Mono.
- Sol 256px açık kâğıt menü rayı, üstte şirket kapsamı şeridi.

## Colors

Sıcak kâğıt nötrleri ve tek bir koyu mürekkep; renkli tonların her biri bir anlam taşır, hiçbiri süs değildir.

### Primary
- **Koyu Mürekkep** (ink): metin, birincil düğme zemini, etkin menü öğesi, basılı filtre çipi, seçili satır çerçevesi. Sistemin tek "vurgu" rengi budur.
- **Mürekkep Üstü Kâğıt** (on-ink): mürekkep zeminli düğme ve menü öğesi üzerindeki metin.

### Secondary
- **Istampa Moru** (istampa) ve **Istampa Pembesi** (istampa-soft): yalnız insan kararı. Kaşe etiketi, inceleme geçmişinde insan kararının sol çizgisi ve karar metni. Metin seçimi zemini ve yazı imleci de bu mürekkebi taşır; bunlar kullanıcının kendi elinin izidir.
- **Kural Yeşili** (verified) ve **Kural Yeşili Zemin** (verified-soft): kural veya doğrulayıcı tarafından geçilmiş kontrol (VKN sağlaması, e-Fatura XML, e-imza doğrulayıcı raporu, kanıt tamam). Değer, yumuşak zemin üzerinde AA için sözleşmedeki #2f6f5e'den koyulaştırıldı.
- **Öneri Grisi** (ai): otomatik öneri ve algılayıcı adayı; yalnız kesik çerçeve ve metin, dolgu yok. Belge görüntüleyicide önerilen bölge de aynı kesik griyle çizilir.

### Tertiary
- **Kiremit** (danger) / danger-soft: eksik, geçersiz, gecikmiş; hata alanı ve hata bandı. Değer, yumuşak zemin üzerinde AA için sözleşmedeki #b8402e'den koyulaştırıldı.
- **Okru** (warn) / warn-soft: belirsiz, inceleme gerekli, istisna ile işlem.
- **Arduvaz** (info) / info-soft: bekleyen inceleme, bilgi bandı.
- **Odak Mavisi** (focus): yalnız klavye odağı, seçili belge sayfası ve seçili bölge. Vurgu rengi olarak kullanılmaz.

### Neutral
- **Kâğıt** (paper): uygulama zemini.
- **Yüzey** (surface): paneller, tablolar, çekmece ve diyalog.
- **Alan Beyazı** (field): form alanları, radyo listesi satırları, taraf kutuları; yazının yazıldığı yer en açık tondur.
- **Çökük Zemin** (surface-sunken): tablo başlığı, nötr etiket, düğme üzerine gelme.
- **Menü Rayı** (rail): sol menü ve giriş ekranının açıklama yarısı.
- **Seçili** (selected): seçili radyo satırı, outline düğme üzerine gelme.
- **Çizgiler**: rule-faint satır ayırıcı, rule-line panel ve bölüm sınırı, rule-strong form alanı ve düğme çerçevesi.
- **Soluk Mürekkep** (ink-muted) ikincil metin, tanım terimleri; **Silik Mürekkep** (ink-subtle) zaman damgası ve yardımcı not, yalnız kâğıt veya yüzey üzerinde.

### Named Rules
**The Three-Ink Rule.** Mor ıstampa yalnız insan kararını, yeşil çerçeve yalnız kural doğrulamasını, kesik gri yalnız otomatik öneriyi basar. Bu üç mürekkep sistemin imzasıdır; dekoratif, marka veya genel "başarılı" anlamında kullanılmaz. Test: bu öğeyi bir insan mı onayladı, bir kural mı geçti, bir algılayıcı mı önerdi? Cevap yoksa mürekkep de yoktur.

**The Never-Purple-For-Machines Rule.** Bir otomatik öneri, ne kadar emin olursa olsun, mor taşımaz; insan teyidi gelene kadar kesik gri kalır.

**The Color-Never-Alone Rule.** Her durum rengi bir ikon ve bir metinle birlikte gelir; renk tek başına anlam taşımaz.

## Typography

**Display Font:** yok; başlıklar gövde ailesinin ağır kesimidir.
**Body Font:** Source Sans 3 Variable (system-ui, -apple-system, Segoe UI yedekleriyle), yerel paket.
**Label/Mono Font:** IBM Plex Mono, yerel paket.

**Character:** Tek bir insani grotesk, iş evrakı netliğinde; mono yalnız makinece okunacak kimlikler için.

### Hierarchy
- **Headline** (650, 1.5rem, 1.25): sayfa başlığı; dengeli satır kırma.
- **Title** (650, 1.25rem, 1.25): bölüm başlığı.
- **Title-sm** (650, 1.0625rem, 1.25): çekmece ve diyalog başlığı.
- **Body** (400, 0.875rem, 1.5): tüm gövde, tablo hücresi, form. Açıklama paragrafları 75ch ile sınırlı; boş durum metni 60ch.
- **Label** (600, 0.8125rem): etiketler, alan adları, filtre çipleri, menü sayıları.
- **Column-head** (600, 0.75rem, 0.02em): tablo sütun başlığı; büyük harf değil, cümle düzeni.
- **Mono** (400, 0.8125rem): SHA-256 özeti, IBAN, VKN, evrak kimliği.

### Named Rules
**The Tabular Figures Rule.** Tutarlar, tarihler, sayaçlar ve tablo hücreleri tabular rakamla dizilir; sütunlar hizada okunur.

**The Sentence-Case Rule.** Başlıklar, sütun başlıkları ve etiketler cümle düzenindedir; büyük harfli üst başlık (eyebrow) kullanılmaz.

## Layout

Uygulama kabuğu iki sütunlu bir ızgaradır: solda 256px menü rayı (kiracı adlarının sığması için sözleşmedeki 232px'ten genişletildi), sağda içerik. Ray; ürün adı, kiracı seçici, modül listesi (sağda bekleyen iş sayısı veya "Faz N"), altta kullanıcı ve çıkış taşır. İçeriğin üstünde 48px yüksekliğinde şirket kapsamı şeridi durur.

Sayfa iç boşluğu 24px üst, 32px yan, 40px alt; içerik en fazla 1440px. Sayfa başlığı solda başlık + açıklama, sağda eylemlerle alt kenara hizalanır. İmza çalışma alanı gibi belge ekranları iki sütunludur: esnek belge görüntüleyici + 440px karar paneli, her biri kendi içinde kayar.

Aralık 4px ızgarasını izler (4, 8, 12, 16, 24, 32, 48). Panel başlığı 12×16, panel gövdesi 16; tablo hücresi 10×12 (sıkı tabloda 6×12).

900px altında ray, üstte kiracı şeridi + yatay kayan menü satırına dönüşür (sağ kenarı soluklaşan maske), çalışma alanı tek sütuna iner, görüntüleyici 70vh olur ve tablolar yığılmış liste görünümüne geçer. 1360px altında ikincil sütunlar (sorumlu rol) gizlenir.

## Elevation & Depth

Sistem gölgesizdir. Derinlik dört zemin tonuyla (kâğıt, yüzey, çökük zemin, ray) ve 1px çizgilerle kurulur; paneller zemine çizgiyle oturur, havada durmaz. Gölge yalnız gerçek bir kâğıt nesnesini temsil eden iki yerde vardır.

### Shadow Vocabulary
- **Belge sayfası** (`box-shadow: 0 1px 2px rgba(29,34,48,.12), 0 6px 18px rgba(29,34,48,.10)`): görüntüleyicide koyu masa zemini üzerindeki PDF sayfası.
- **Giriş kâğıdı** (`box-shadow: 0 1px 2px rgba(29,34,48,.06), 0 12px 32px rgba(29,34,48,.08)`): giriş ekranının tek kâğıt yaprağı.

### Named Rules
**The Paper-Only Shadow Rule.** Gölge yalnız fiziksel bir evrakı temsil eden yüzeye düşer; panel, tablo, düğme ve etiket düz kalır.

## Shapes

Hafif yumuşatılmış köşeler: düğme, panel, form alanı ve band 6px; etiket ve klavye tuşu 4px; giriş kâğıdı 8px. Biçim dili cetvel çizgisidir: panel kenarları, bölüm ayırıcıları ve zaman çizelgesinin sol çizgisi 1px. Tek istisna kaşedir: insan kararı etiketi 1.5px çerçeveyle ve -1.5° eğimle basılır; bu eğim yalnız ıstampaya aittir.

## Components

### Buttons
- **Shape:** 6px köşe, 36px yükseklik (küçük boy 32px).
- **Primary:** koyu mürekkep zemin, mürekkep üstü kâğıt metin; ekranda tek ve satır içinde. İş tablosunda klavye ile seçili satırın eylemi primary olur, diğerleri outline kalır.
- **Outline:** yüzey zemin, 1px çerçeve, üzerine gelince seçili ton. Varsayılan ikincil eylem.
- **Ghost / Danger:** ghost çerçevesiz; danger kiremit metin ve açık kiremit çerçeve, dolgusuz.
- **Focus:** 2px odak mavisi dış çizgi, 2px boşluk.

### Tags (köken ve durum etiketleri)
- **Style:** 4px köşe, 1px×8px iç boşluk, 13px yarı kalın metin, solda 14px ikon. Her etiket ikon + metin + isteğe bağlı açıklama (title) taşır.
- **Köken tonları:** insan = mor 1.5px çerçeve, mor açık zemin, kalın, -1.5° eğik, kaşe ikonu; kural = yeşil 1.5px çerçeve, yeşil açık zemin; otomatik öneri = 1.5px kesik gri çerçeve, dolgusuz, kıvılcım ikonu.
- **Durum tonları:** uyarı, hata, bilgi çerçevesiz yumuşak zemin + koyu metin.
- **Köken açıklaması:** iş ve sözleşme listelerinin başında üç köken etiketi tek satırlık bir lejant olarak yan yana durur.

### Non-events
Olmamış bir şey (karar yok, tarama yapılmadı, uygulanamaz, son tarih yok) etiket değil, soluk veya silik metin olarak yazılır. Etiket yalnız bir şey olduğunda basılır.

### Banners
Tam genişlik, 6px köşe, yumuşak ton zemin + aynı tonun açık çerçevesi, solda 18px ikon, kalın başlık ve soluk mürekkep açıklama, sağda isteğe bağlı eylem. Yalnız bilgi, uyarı, hata ve nötr; köken mürekkepleri banda taşınmaz.

### Filter Chips
32px, 6px köşe, yüzey zemin ve form çerçevesi; basılı durumda koyu mürekkep zemin. Sayı tabular ve silik.

### Tabs
Alt çizgili sekmeler: 40px yükseklik, yarı kalın metin, etkin sekmede 2px mürekkep alt çizgi, diğerleri soluk mürekkep. Hap biçimli sekme kullanılmaz.

### Tables
Yüzey zeminli, çizgi çerçeveli kap; yapışkan çökük-zemin başlık, cümle düzeninde sütun başlıkları, soluk satır ayırıcılar, tabular hücreler. Satır bağlantısı yarı kalın mürekkep, üzerine gelince altı çizili. Klavye ile seçili satır 2px odak çerçevesi alır (j/k, Enter).

### Inputs / Fields
- **Style:** alan beyazı zemin, 1px güçlü çizgi çerçeve, 6px köşe, 36px; etiket üstte yarı kalın, ipucu altta küçük soluk.
- **Focus:** 2px odak mavisi dış çizgi; yazı imleci mor.
- **Error:** kiremit çerçeve ve ikonlu kiremit hata satırı.
- **Radyo listesi:** her seçenek çerçeveli satır; seçilende mürekkep çerçeve ve seçili zemin.

### Panels, Drawer, Modal
Panel: yüzey zemin, çizgi çerçeve, başlık şeridi alt çizgiyle ayrılır. Çekmece sağdan, en fazla 480px; diyalog en fazla 520px. İkisinde de başlık ve alt eylem şeridi çizgiyle ayrılır, iç içe açılmaz.

### Navigation
Sol ray: 36px öğeler, lucide ikon + yarı kalın etiket, sağda bekleyen iş sayısı (tabular) veya sonraki fazın adı. Etkin öğe koyu mürekkep zemin; üzerine gelince çökük zemin. Dar ekranda yatay kayan satır.

### Mor Istampa (signature)
İnsan kararının kaşesi: eğik, mor çerçeveli etiket ve inceleme geçmişinde mor sol çizgili karar kaydı. Bir ekranın "kim karar verdi" sorusunu tek bakışta yanıtlayan tek öğedir.

### Icons
Tek set: lucide, 2px çizgi, 16px (etiketlerde 14px, bant ve boş durumda 18–28px). Dekoratif ikonlar ekran okuyucudan gizlenir.

## Do's and Don'ts

### Do:
- **Do** mor ıstampayı yalnız insan kararına (onay, kurul kararı, imza teyidi) bas.
- **Do** kural doğrulamasını yeşil çerçeveyle, otomatik öneriyi kesik griyle göster ve kökeni lejantla açıkla.
- **Do** olmamış olayları (karar yok, uygulanamaz, tarama yapılmadı) etiket değil soluk metin olarak yaz.
- **Do** derinliği zemin tonu ve 1px çizgiyle kur; gölgeyi yalnız evrak sayfasına ver.
- **Do** tutar, tarih ve sayaçları tabular rakamla, kimlikleri IBM Plex Mono ile diz.
- **Do** her durum renginin yanına ikon ve metin koy.

### Don't:
- **Don't** ıstampa morunu, kural yeşilini veya kesik griyi süs, marka vurgusu ya da genel "aktif/başarılı" anlamında kullanma.
- **Don't** otomatik öneriyi mor veya dolgulu göster; öneri insan teyidine kadar taslaktır.
- **Don't** gri zemin + mavi vurgu + rozet duvarı kategori varsayılanına dön; odak mavisi vurgu rengi değildir.
- **Don't** kart duvarı ve gölgeli kart kullan; paneller çizgiyle ayrılır.
- **Don't** büyük harfli üst başlık (eyebrow) veya sayfa üstü etiket ekle.
- **Don't** silik mürekkebi menü rayı veya çökük zemin üzerinde küçük metin için kullan; orada soluk mürekkep kullan.
