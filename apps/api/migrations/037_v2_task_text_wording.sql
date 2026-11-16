-- v2 Faz 1 kalan düzeltme (D93/D95): açık görevlerin saklı metinlerinde kalan v1 dili. Uygulama yeni görevleri yeni metinle
-- açar; fatura bulgu görevleri fatura okununca yeniden üretilir. Bu adım okunmamış eski görevlerin saklı metnini düzeltir.
-- Yalnız açık görevlerin metin alanı değişir; görev silinmez, kapanmaz. Yeniden çalıştırmada aynı sonuç.
UPDATE tasks SET reason = replace(reason, 'Fatura iptal edilmez; ödeme politikası Satınalma incelemesine bağlıdır.', 'Fatura iptal edilmez; imza kontrolünü Satınalma tamamlar.')
 WHERE status = 'OPEN' AND kind = 'invoice_issue' AND reason LIKE '%ödeme politikası Satınalma incelemesine bağlıdır.%';
UPDATE tasks SET reason = 'Kimlik doğrulandı; kayıt onayı gerekiyor.'
 WHERE status = 'OPEN' AND kind = 'SUPPLIER_CANDIDATE_APPROVAL' AND reason = 'Kimlik doğrulandı; ana veri onayı gerekiyor.';
UPDATE tasks SET reason = 'Bedel, süre ve ihbar kuralı girildi; ikinci bir Satınalma kullanıcısının doğrulaması olmadan uyarılar planlanmaz.'
 WHERE status = 'OPEN' AND kind = 'contract_terms_verify' AND reason = 'Bedel, süre ve ihbar kuralı girildi; hukuk doğrulaması olmadan uyarılar planlanmaz.';
