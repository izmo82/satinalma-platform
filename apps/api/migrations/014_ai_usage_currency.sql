-- 014 AI kullanımı bütçe para biriminde ölçülür; farklı para birimindeki ücretler toplanmaz (kur varsayımı yok).
DROP FUNCTION ai_tenant_usage();
CREATE FUNCTION ai_tenant_usage(p_currency char(3)) RETURNS TABLE (month_spent numeric, today_calls int)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT coalesce(sum(coalesce(actual_cost, estimated_cost)) FILTER (WHERE cost_currency = p_currency
           AND created_at >= date_trunc('month', now() AT TIME ZONE 'Europe/Istanbul') AT TIME ZONE 'Europe/Istanbul'), 0),
         (count(*) FILTER (WHERE created_at >= date_trunc('day', now() AT TIME ZONE 'Europe/Istanbul') AT TIME ZONE 'Europe/Istanbul'))::int
  FROM ai_runs WHERE tenant_id = app_tenant_id() AND status IN ('QUEUED','RUNNING','SUCCEEDED','FAILED');
$$;
REVOKE ALL ON FUNCTION ai_tenant_usage(char) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION ai_tenant_usage(char) TO sp_app;
