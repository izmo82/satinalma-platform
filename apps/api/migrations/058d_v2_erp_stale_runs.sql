-- 058d v2 Faz 8 (D113) Görev 5 düzeltme 1: bayat ERP okuma çalışmaları için dar kiracı kapısı.
-- İşçi çöker ya da iş hiç alınmazsa RUNNING kalan okuma çalışmasını dakikalık tıkta kapatmak için, kiracı bağlamı kurmadan önce
-- hangi kiracılarda aday çalışma olduğunu bilmek gerekir (elle çalışma zamanlanmış özelliği olmayan kiracıda da olabilir; 058c yetmez).
-- 054b/058c deseni: SECURITY DEFINER, yalnız kiracı kimlikleri döner; kapatma kiracı bağlamında (RLS) yapılır. Hiçbir satır değişmez.
-- Aday: başlangıcı p_now − p_minutes'tan eski RUNNING, sınama olmayan okuma çalışması (nabız başlangıçtan eski olamaz; kesin süzgeç RLS altında).
CREATE OR REPLACE FUNCTION erp_stale_run_tenants(p_now timestamptz, p_minutes integer) RETURNS SETOF uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT DISTINCT r.tenant_id FROM integration_runs r
   WHERE r.status = 'RUNNING' AND r.trigger <> 'TEST' AND coalesce(r.counts->>'mode', 'READ') = 'READ'
     AND r.started_at < p_now - make_interval(mins => greatest(p_minutes, 1))
$$;
REVOKE ALL ON FUNCTION erp_stale_run_tenants(timestamptz, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION erp_stale_run_tenants(timestamptz, integer) TO sp_app;
