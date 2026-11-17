-- v2 Faz 6 (D111) Görev 5: risk döngüsü işçisi için dar kapı. sp_app kiracı bağlamı olmadan kiracıları listeleyemez; işçi
-- (yıllık açılış R6, çeyreklik görev R10, gecikme yükseltmesi R7) iş kuracağı kiracıları bununla bulur. Yalnız kiracı kimlikleri
-- döner (tedarikçili sözleşme ailesi ya da risk değerlendirmesi olan); başka alan dönmez. 053/054/054a değiştirilmez.
CREATE OR REPLACE FUNCTION risk_cycle_tenants() RETURNS SETOF uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT f.tenant_id FROM contract_families f WHERE f.supplier_id IS NOT NULL
  UNION
  SELECT a.tenant_id FROM risk_assessments a
$$;
REVOKE ALL ON FUNCTION risk_cycle_tenants() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION risk_cycle_tenants() TO sp_app;
