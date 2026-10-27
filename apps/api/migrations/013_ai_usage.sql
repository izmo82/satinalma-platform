-- 013 AI kullanımı kiracı genelinde ölçülür (bütçe/kota kiracı düzeyindedir); çalıştırma kayıtları şirket kapsamlı RLS ile görünse de
-- toplam kullanım tüm şirketlerden hesaplanır. Yalnız toplam döner; kayıt içeriği sızmaz. Gerçekleşen ücret yoksa tahmin sayılır.
CREATE OR REPLACE FUNCTION ai_tenant_usage() RETURNS TABLE (month_spent numeric, today_calls int)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT coalesce(sum(coalesce(actual_cost, estimated_cost)) FILTER (WHERE created_at >= date_trunc('month', now() AT TIME ZONE 'Europe/Istanbul') AT TIME ZONE 'Europe/Istanbul'), 0),
         (count(*) FILTER (WHERE created_at >= date_trunc('day', now() AT TIME ZONE 'Europe/Istanbul') AT TIME ZONE 'Europe/Istanbul'))::int
  FROM ai_runs WHERE tenant_id = app_tenant_id() AND status IN ('QUEUED','RUNNING','SUCCEEDED','FAILED');
$$;
REVOKE ALL ON FUNCTION ai_tenant_usage() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION ai_tenant_usage() TO sp_app;
