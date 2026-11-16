-- v2 Faz 1 kalan düzeltme (D93/D95): 037'den sonra iOS yürüyüşünde görülen, açık görevlerde saklı kalmış eski rol dili. Uygulama
-- bu görevleri yeni metinle açar (suppliers.ts, contracts.ts, contractTerms.ts); bu adım eski kayıtların saklı metnini düzeltir.
-- Yalnız açık görevlerin metin alanı değişir; görev silinmez, kapanmaz. Yeniden çalıştırmada aynı sonuç.
UPDATE tasks SET next_action = replace(next_action, 'ana veri onayı verin', 'kayıt onayı verin')
 WHERE status = 'OPEN' AND next_action LIKE '%ana veri onayı verin%';
UPDATE tasks SET next_action = replace(next_action, 'hukuk yetkilisi karar verir', 'Satınalma karar verir')
 WHERE status = 'OPEN' AND next_action LIKE '%hukuk yetkilisi karar verir%';
UPDATE tasks SET reason = replace(reason, 'Sahipsiz yükümlülük: satınalma yöneticisine düştü.', 'Sahipsiz yükümlülük: Satınalma''ya düştü.')
 WHERE status = 'OPEN' AND reason LIKE '%Sahipsiz yükümlülük: satınalma yöneticisine düştü.%';
