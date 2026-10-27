---
version: 1
slug: "apps-web-src"
primary_target: "apps/web/src"
related_targets: []
---

# Web uygulaması (apps/web)

Kapsam: kurumsal web uygulamasının tamamı (Operate). Kitle ve iş: PRODUCT.md. Birincil görev: satınalmacının proje → teklif → karşılaştırma → seçim zinciri; hukuk, finans, ana veri ekranları aynı kabukta.
Kısıtlar: project-specs 04 UI/UX sözleşmesi; WCAG 2.2 AA; Tailwind 4 + shadcn/ui; yazı tipi yerel paket (CSP, harici CDN yok).
Akılda kalan an: insan kararının mor kaşe damgası; otomatik öneri asla o mürekkebi taşımaz.

## Direction contract
THESIS: Kanıtın kökeni mürekkebinden okunur. Mor ıstampa yalnız insan kararını (onay, kurul kararı, imza teyidi) basar; kural doğrulaması yeşil çerçeve, AI önerisi kesik çizgili gri. Kategori varsayılanı olan "gri zemin + mavi vurgu + rozet duvarı"nı reddeder.
OWN-WORLD: Kâğıt beyazı zemin (#f4f2ec) ve daha açık çalışma yüzeyi (#fbfaf6); koyu mürekkep (#1d2230) metin ve birincil düğme; ıstampa moru (#5b3fa0) yalnız insan kararı; kural yeşili (#2f6f5e); hata kiremidi (#b8402e); uyarı okru. Source Sans 3, tabular rakam; evrak numaraları ve tutarlar tabular. Kart yerine çizgiyle ayrılmış paneller, 4px ızgara.
STORY: Kullanıcı açtığı her kayıtta ne beklendiğini, kimin karar verdiğini ve kararın hangi mürekkeple (insan/kural/AI) geldiğini tek bakışta ayırır; sonra sıradaki eylemi yapar.
FIRST VIEWPORT: Sol 232px açık kâğıt menü (modül adı + bekleyen iş sayısı), üstte kiracı ve şirket bağlamı; İşlerim başlığı, üç sekme (Benden beklenen, Geciken, Takip), köken açıklaması satırı, evrak numaralı iş tablosu. Birincil eylem satırda.
FORM: Mor Istampa, kendi listemde 1. sıra (IMPECCABLE'S PICK). seed:c053423aa20762b7
FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance
