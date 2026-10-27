-- 017 Zayıf bağlantıda (mobil depo) yanıtı kaybolan istek tekrar gönderilince ikinci kabul/olay açılmaz: istemci anahtarı.
ALTER TABLE receipts ADD COLUMN idempotency_key text;
CREATE UNIQUE INDEX receipts_idempotency ON receipts (tenant_id, idempotency_key) WHERE idempotency_key IS NOT NULL;
ALTER TABLE supplier_incidents ADD COLUMN idempotency_key text;
CREATE UNIQUE INDEX supplier_incidents_idempotency ON supplier_incidents (tenant_id, idempotency_key) WHERE idempotency_key IS NOT NULL;
