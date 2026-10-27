-- 018 Aynı tekrar anahtarı farklı içerikle gelirse eski kayıt "başarı" diye dönmez: istek gövdesinin özeti saklanır (017'ye ek).
ALTER TABLE receipts ADD COLUMN idempotency_hash text;
ALTER TABLE supplier_incidents ADD COLUMN idempotency_hash text;
