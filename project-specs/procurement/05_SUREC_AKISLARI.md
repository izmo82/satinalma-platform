# Süreç grafikleri
Analizdeki grafikler `assets/` altında, aşağıdaki kaynaklar düzenlenebilirdir. Sade iş akışı gösterimidir, eksiksiz BPMN motor tanımı değildir. Her ok API durum geçişi ve yetki kontrolüyle eşlenir.

## Satınalma
```mermaid
flowchart TD
 A[İhtiyaç ve proje] --> B{Bütçe ve yayın onayı}
 B -->|Düzelt| A
 B -->|Uygun| C[RFQ ve tedarikçi daveti]
 C --> D[Teklif turu ve revizyon]
 D --> E{Geçerli kapsam yeterli mi}
 E -->|Hayır| F[Yeni tur veya gerekçeli istisna]
 F --> C
 E -->|Evet| G[Normalleştirme ve kaynaklı karşılaştırma]
 G --> H{Risk ve kriterler uygun mu}
 H -->|Hayır| I[Bilgi veya risk çözümü]
 I --> G
 H -->|Evet| J[Kurul seçim onayı]
 J --> K[Sözleşme ve sipariş]
```

## Belge ve firma
```mermaid
flowchart TD
 A[Yükleme ve güvenlik taraması] --> B{Yapılandırılmış veri var mı}
 B -->|Evet| C[XML veya metin ayrıştır]
 B -->|Hayır| D[Gerekli sayfalarda OCR]
 C --> E[Kritik alan incelemesi]
 D --> E
 E --> F{Satıcı kimliği doğrulanmış mı}
 F -->|Hayır| E
 F -->|Evet| G{Tenant içinde firma var mı}
 G -->|Aktif| H[Belgeyi mevcut firmaya bağla]
 G -->|Aday| I[Mevcut adaya belge ekle]
 G -->|Yok| J[Benzersiz aday oluştur]
 I --> K[Ana veri ve risk onayı]
 J --> K
 K --> L{Onaylandı mı}
 L -->|Evet| H
 L -->|Hayır| M[Eksik veya reddedildi]
 H --> N[Belge ve işlem onayı]
```

## Fatura
```mermaid
flowchart TD
 A[Fatura ve mükerrerlik kontrolü] --> B[Satır bazlı PO ve sözleşme tahsisi]
 B --> C{Kabul ve dönem yeterli mi}
 C -->|Hayır| D[Kabul sorumlusuna görev]
 D --> C
 C -->|Evet| E{Fiyat vergi limit uygun mu}
 E -->|Hayır| F[Düzeltme veya yetkili istisna]
 F --> E
 E -->|Evet| G[Finans onayı]
 G --> H[ERP aktarımı ve teyit]
 H --> I[Muhasebe ve ödeme durumu]
```

## İmza
```mermaid
flowchart TD
 A[Yeni belge sürümü] --> B[Taraf imzacı ve yöntem gereksinimi]
 B --> C{Islak imza görüntüsü gerekli mi}
 C -->|Evet| D[Görsel tespit ve kapsam kaydı]
 D --> E{Görüntü adayı bulundu mu}
 E -->|Hayır veya belirsiz| F[Otomatik uyarı ve görev]
 E -->|Evet| G[Kaynak ve taraf incelemesi]
 F --> G
 C -->|E imza| H[Ayrı kriptografik doğrulama]
 C -->|İmza gerekmiyor| I[Yetkili yöntem ve N A gerekçesi]
 G --> J{Gerekli kontroller tamam mı}
 H --> J
 I --> J
 J -->|Evet| K[Sürüme bağlı kontrol tamam]
 J -->|Hayır| L[Eksik veya belirsiz]
 L --> M[Yeni belge veya süreli istisna]
 M -->|Yeni sürüm| A
 M -->|İstisna onayı| N[Eksik durumuyla sınırlı işlem]
```

## Sözleşme ve olay
```mermaid
flowchart TD
 A[İnceleme ve imza kontrolü] --> B[Yükümlülük ve kabul takibi]
 B --> C{Olay veya ihlal var mı}
 C -->|Var| D[Kanıt ve doğrulama]
 D --> E[Faaliyet ve bağımsız kapanış]
 E --> B
 C -->|Dönemsel| F[Performans ve risk incelemesi]
 F --> G[İhbar öncesi yenileme kararı]
 G -->|Yenile| H[Yeni proje veya zeyilname]
 H --> A
 G -->|Bitir| I[Veri erişim borç çıkış kontrolü]
```

## AI yönlendirme
```mermaid
flowchart TD
 A[Yetki ve veri politikası] --> B{Kural veya parser yeterli mi}
 B -->|Evet| C[Deterministik çıktı]
 B -->|Hayır| D[İzinli küçük model]
 D --> E{Şema ve kaynak kontrolü}
 E -->|Geçti| F[İnsan incelemesi]
 E -->|Kaldı| G{Bütçe ve bölge izinli mi}
 G -->|Evet| H[Sorunlu kapsamda bir üst model]
 H --> F
 G -->|Hayır| I[Manuel inceleme]
 C --> F
 F --> J[Yetkili işlem onayı]
 I --> J
```
