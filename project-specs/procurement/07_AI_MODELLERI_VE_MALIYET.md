# AI görev ve maliyet stratejisi
27 Ekim 2026 tarihli analiz model fiyatlarını içerir. Yeni uygulama anında resmi fiyat/erişim/capability yeniden kontrol edilir; model adı, fiyat ve region kullanıcı iş kurallarına hardcode edilmez.

## Görev matrisi
| Kimlik | Görev | Yöntem | Yetkili kontrol |
|---|---|---|---|
| AI01 | Belge türü | MIME/şema/kural; belirsizde küçük model | Sınıf düzeltilebilir |
| AI02 | Fatura alanları | XML/metin; gerektiğinde OCR + şemalı LLM | Kritik alan insan onayı |
| AI03 | Firma eşleme | Kesin vergi kimliği DB; benzerlik sadece aday | Ana veri aktivasyonu |
| AI04 | Teklif satırları | Küçük model; zor kapsamda yükselt | Teknik uzman |
| AI05 | Karşılaştırma dosyası | Hesap motoru + kaynaklı anlatı; rapor servisi | Satınalmacı/kurul |
| AI06 | Sözleşme metadata/yükümlülük | Kaynaklı çıkarım; çelişkide güçlü model | Hukuk ve sorumlu |
| AI07 | Fatura farkı | Deterministik kontrol; LLM sadece açıklama | Finans |
| AI08 | Güvenlik anketi | Kanıt özeti/eksik listesi; sertifika doğruluğu varsayılmaz | Güvenlik uzmanı |
| AI09 | Olay/faaliyet | Sınıflandırma/özet ve ilişki adayı | İnsan doğrulama |
| AI10 | Belge soruları | Yetki filtreli retrieval; kaynaklı yanıt | Aksiyon yetkisi yok |
| AI11 | Yenileme | Tarih motoru + karar dosyası özeti | Yetkili karar |
| AI12 | Yıllık karne | Doğrulanmış metrik + anlatı | Dönem/örneklem görünür |
| AI13 | İmza görüntüsü | Gerçek sayfa/region görsel algılama veya signature API | Dosya 06; taraf/sürüm bazlı insan |

## İlk aday model politikası
Analiz 1.1 fiyat karşılaştırması: rutin için gpt-6-luna; zor vaka için gpt-6.1-terra; gerekirse izinli Claude Haiku alternatifi; OCR için Mistral OCR 3. Bunlar uygulama başlangıcında erişim ve kaliteyle doğrulanacak adaylardır. Veri çıkışı yasaksa bölgesel özel bulutta PaddleOCR/PP-Structure + Qwen3-8B + BGE-M3 adayları; kalite/operasyon ölçümü olmadan ücretsiz/en iyi diye tanıtma. Google 2.5 modellerin yeni hesap erişim sınırlaması ve 3.1 yaşam döngüsü analizde açıklıdır.

Registry en az provider, exact model id/version, supported_inputs, structured_output/vision/signature capabilities, context/token limits, approved_regions, data retention/training terms, price_unit/input/output/page/tool, verified_at, enabled_for_tenants taşır. `supports_vision` özel signature detection yeteneğiyle aynı değildir.

## Router
Doğrudan veri/kural → gerekiyorsa OCR → küçük model → şema/kaynak/kurallar → insan taslağı. Çözülemeyen problemde yalnız gerekli parça için bir üst model; önce region/permission/budget gate. Teknik retry sınırlı; aynı iş idempotent. OCR bozuksa daha büyük LLM her zaman çözüm değildir; yeniden tarama/manuel inceleme. Uygunsuz sağlayıcıya sessiz failover yok.

Kaynak şeması: entity/field/value/null, document_id/version/hash, page_or_cell/bbox, evidence_span, validation_flags, model_run_id, review_state. Source ref gerçek kapsamı göstermeli; modelin uydurduğu sayfa sunucuda doğrulanmadan kullanıcıya çıkmaz. Para/vergi/TCO/limit/puan ve VKN eşleme deterministik servislerdir. Prompt injection belgede veri kabul edilir; model dış iletişim/onay/ödeme aracı çalıştıramaz.

## Maliyet
Analizdeki 10.000 belge/20.000 sayfa senaryosu: 8.000 OCR sayfası; 6.000 rutin çıkarım; 600 üst model; 500 rapor özeti ve 2.000 soru. Doğrudan OCR/LLM 31,85 USD, %20 kullanım payıyla 38,22 USD. Bu ölçüm değil örnektir; hosting/arama/insan/vergi/araç ve yeni AI13 imza görsel maliyeti hariçtir.

AI13 ayrı hesaplanır: işlenen sayfa veya görüntü tokenı × tarife + varsa tekrar/üst model; OCR sayfa bedeliyle karıştırma. Görseli küçültmek imza izini yok ederse tasarruf kalite kaybıdır. Bölge ve retention koşulu önce gelir. Görsel tespitte tam belgenin her işte tekrar gönderilmesini önle; document hash/policy/modelversion/kapsam bazlı aynı tenant önbellek.

Tenant günlük/aylık bütçe ve token/sayfa/çağrı limitleri, maksimum çıktı, upgrade oranı, concurrency/queue adaleti. %80 uyarı, %100'de yeni ücretli AI bekler; manuel iş devam eder. Tahmini ve gerçekleşen ücret ayrı; bilmediğin tarifeyi sıfır yazma. İmzalama/tespit audit'i kimliği ve hassas görseli loga dökmez.

## Kalite kapısı
Etiketli en az 300 başlangıç belge seti, ayar ve final test ayrımı, Türkçe ve farklı kaliteler. Kritik alan exact match, satır F1, kaynak doğruluğu, yanlış firma eşleme ve insan düzeltme süresi. İmza için taraf/alan düzeyinde false negative/false positive, sayfa kapsamı ve belirsiz oranı ayrıca. Modelin kendi güven skoru tek başına gate değildir. Sıfır hata gözlenmesi üretim garantisi değildir. Yeni sürüm golden set/gölge/canary ve geri alma ile yayınlanır.
