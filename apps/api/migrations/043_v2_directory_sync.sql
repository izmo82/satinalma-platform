-- v2 Faz 2 (D105) Görev 3: dizin eşitleme işi. 040-042 uygulanmış olduğundan değiştirilmez.
-- (1) Kiracı başına en fazla bir açık (QUEUED/RUNNING) eşitleme çalıştırması: eşzamanlı iki istek yarışında ikincisi tekil dizine takılır (409).
-- (2) Gece eşitlemesi (R8) için dar kapı: bağlantısı açık kiracıların YALNIZ kimliklerini döndürür (kapsam ayarı ya da başka alan dönmez).

CREATE UNIQUE INDEX IF NOT EXISTS directory_sync_runs_one_open ON directory_sync_runs (tenant_id) WHERE status IN ('QUEUED','RUNNING');

CREATE OR REPLACE FUNCTION directory_sync_tenants()
RETURNS TABLE (tenant_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT dc.tenant_id FROM directory_connections dc WHERE dc.enabled ORDER BY dc.tenant_id
$$;
REVOKE ALL ON FUNCTION directory_sync_tenants() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION directory_sync_tenants() TO sp_app;
