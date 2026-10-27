# Satınalma ve sözleşme platformu Claude uygulama paketi
Sürüm 1.2 • 27 Ekim 2026

Bu paket ayrı bir satınalma ve sözleşme yönetimi ürününü tanımlar. Fitness/GymTipsPro projesine özellik ekleme talimatı değildir. Web ve native iOS, çok kiracılı bulut, teklif, tedarikçi, sözleşme, fatura, OCR/AI ve imza kontrolünü birlikte kapsar.

## Kullanım
1. ZIP'i hedef projenin çalışma dizininde `project-specs/procurement/` altına aç. Mevcut kaynak dosyalarını veya CLAUDE.md'yi üzerine yazma.
2. Claude Code'u hedef repoda aç. Yeni projeyse bu paketle aynı çalışma dizininde başlat.
3. `01_MASTER_CLAUDE_PROMPT.md` dosyasının tamamını Claude'a ver. Son cümleyi de dahil et; yalnız bölüm başlıklarını gönderme.
4. Paket içindeki Markdown gereksinimler Claude için doğrudan okunabilir. Güncel Word analizinin tam içerik aktarımı `02_GUNCEL_ANALIZ.md` içindedir. Word ve grafikler de pakettedir.
5. Sonraki oturumda `11_FAZLAR_VE_TESLIM.md` içindeki devam talimatını kullan. Claude gerçek kod durumundan devam etmeli; biten işi yeniden yapmamalı.

## Dosyalar
- 01: uygulamayı yaptıran ana komut.
- 02: güncel analizin bütün paragrafları, tabloları, kaynakları ve diyagram bağlantıları.
- 03: eksiksiz fonksiyonel ürün kuralları.
- 04: tasarım sistemi, ekranlar ve UX kalite kapıları.
- 05: grafik süreçlerin düzenlenebilir Mermaid kaynakları.
- 06: imza kontrolünün ayrıntılı durum, veri ve API sözleşmesi.
- 07: AI görevleri, model yönlendirme ve maliyet kontrolleri.
- 08: mimari, tenant izolasyonu ve entegrasyonlar.
- 09: kabul ve güvenlik senaryoları.
- 10: gereksinim izlenebilirlik matrisi.
- 11: fazlar, çalışma disiplini ve teslim.
- `analysis/`: güncel Word analizi.
- `assets/`: analize gömülü gerçek diyagramlar ve ekran yerleşimi.
- `12_KAYNAKLAR.md`: teknik dayanaklar ve fiyat notları.

## Bilinen sınırlar
Bu paket gereksinim ve uygulama talimatıdır; çalışan yazılım teslimi değildir. Kaynak kod bu çalışma sırasında incelenmedi. Gerçek OCR/AI, ERP, e-imza ve mobil dağıtım için erişimler hedef ortamda sağlanır. Erişim yoksa Claude entegrasyonu hazır sanmamalı; adaptör ve testleri hazırlayıp gerçek bağlantıyı blokaj olarak raporlamalıdır. “Mükemmel” hedefi, ölçülebilir kabul kapılarına çevrilmiştir; sıfır hata garantisi verilmez.
