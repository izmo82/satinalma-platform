-- 058c v2 Faz 8 (D113) Görev 5: zamanlanmış ERP okumaları için dar kiracı kapısı (R7).
-- İşçi dakikada bir, kiracı bağlamı kurmadan önce hangi kiracıların zamanlanmış (INTERVAL/DAILY) ve açık okuyan bir ERP özelliği
-- olduğunu bilmelidir. 054b risk_cycle_tenants / 052b deseni: SECURITY DEFINER, yalnız kiracı kimlikleri döner (uç nokta ayarı,
-- adres ya da sır dönmez); ayrıntı kiracı bağlamında (RLS altında) okunur. Hiçbir satır değişmez; yeni tablo yok.
CREATE OR REPLACE FUNCTION erp_read_schedule_tenants() RETURNS SETOF uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT DISTINCT e.tenant_id FROM integration_endpoints e
   WHERE e.enabled AND e.schedule_kind IN ('INTERVAL','DAILY')
     AND e.feature IN ('SUPPLIER','COST_CENTER','PURCHASE_ORDER','INVOICE','PAYMENT_STATUS')
$$;
REVOKE ALL ON FUNCTION erp_read_schedule_tenants() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION erp_read_schedule_tenants() TO sp_app;
