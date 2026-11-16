-- v2 Faz 1 Görev 6 düzeltme (D93/D95): açık fatura bulgusu görevlerinin metinleri v2 diline. Fatura onayı ve istisna onayı kalktı;
-- çözen Satınalma'dır. Bulgu görevleri fatura okunduğunda yeniden üretilir; bu adım okunmamış eski görevlerin saklı metnini düzeltir.
-- Yalnız açık invoice_issue görevlerinin metin alanları değişir; görev silinmez, kapanmaz. Kaldırılan bulgu kodlarının görevleri
-- (üçlü eşleştirme, tolerans, sözleşmesiz istisna) uygulamada listelenmez (tasks.ts visibleTaskSql). Yeniden çalıştırmada aynı sonuç.
UPDATE tasks SET next_action = 'Faturayı açıp bulguyu düzeltin (tahsis, tutar veya sözleşme); düzelince görev kendiliğinden kapanır.'
 WHERE status = 'OPEN' AND kind = 'invoice_issue' AND entity_type = 'invoice'
   AND next_action IN ('Bulguyu çözün veya yetkili istisna isteyin.', 'Teslim aldıysanız kabul kaydını girin; almadıysanız finansa bildirin.');
UPDATE tasks SET reason = replace(reason, 'sipariş veya sözleşmeye tahsis edilmedi', 'sözleşmeye tahsis edilmedi')
 WHERE status = 'OPEN' AND kind = 'invoice_issue' AND reason LIKE '%sipariş veya sözleşmeye tahsis edilmedi%';
UPDATE tasks SET reason = replace(reason, 'ödeme politikası hukuk/finans incelemesine bağlıdır', 'ödeme politikası Satınalma incelemesine bağlıdır')
 WHERE status = 'OPEN' AND kind = 'invoice_issue' AND reason LIKE '%hukuk/finans incelemesine%';
UPDATE tasks SET reason = replace(reason, 'aday firmaya ödeme onayı verilemez', 'aday firmanın faturası işlenmeden önce tedarikçi kaydı aktifleştirilmeli')
 WHERE status = 'OPEN' AND kind = 'invoice_issue' AND reason LIKE '%aday firmaya ödeme onayı verilemez%';
