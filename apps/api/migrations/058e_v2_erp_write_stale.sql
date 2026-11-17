-- 058e v2 Faz 8 (D113) Görev 6: bayat ERP yazma işleri ve çalışmaları için dar kiracı kapısı.
-- İşçi çöker ya da yazma işi hiç alınmazsa RUNNING kalan `erp.write` işini ve yazma çalışmasını (olay: mode WRITE, "Şimdi çalıştır" yeniden
-- denemesi: mode WRITE_RETRY) dakikalık tıkta kapatmak için, kiracı bağlamı kurmadan önce hangi kiracılarda aday olduğunu bilmek gerekir.
-- 058d deseni: SECURITY DEFINER, yalnız kiracı kimlikleri döner; kapatma kiracı bağlamında (RLS) yapılır. Hiçbir satır değişmez; yeni tablo yok.
CREATE OR REPLACE FUNCTION erp_write_stale_tenants(p_now timestamptz, p_minutes integer) RETURNS SETOF uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT r.tenant_id FROM integration_runs r
   WHERE r.status = 'RUNNING' AND r.counts->>'mode' IN ('WRITE','WRITE_RETRY')
     AND r.started_at < p_now - make_interval(mins => greatest(p_minutes, 1))
  UNION
  SELECT j.tenant_id FROM jobs j
   WHERE j.kind = 'erp.write' AND j.status = 'RUNNING'
     AND j.updated_at < p_now - make_interval(mins => greatest(p_minutes, 1))
$$;
REVOKE ALL ON FUNCTION erp_write_stale_tenants(timestamptz, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION erp_write_stale_tenants(timestamptz, integer) TO sp_app;
