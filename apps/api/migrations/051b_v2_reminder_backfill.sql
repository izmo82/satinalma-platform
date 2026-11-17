-- v2 Faz 3 (D108+, R7) Görev 6 düzeltme: eski kayıtların hatırlatıcı geri doldurması (gece/başlangıç sistem işi).
-- İşçi kiracı bağlamı olmadan hangi kiracıda iş açacağını bilemez (tenants RLS'i yalnız kendi kiracısını gösterir). Bu kapı yalnız
-- kiracı kimliklerini döner: eski kayıt (intake_flow false, onay zinciri yok), güncel sürümün son koşulu doğrulanmış ve hiç
-- hatırlatıcısı olmayan sözleşmesi bulunan kiracılar. Sözleşme verisi dönmez. 048/050/051/051a değiştirilmez; 052 Faz 5'e ayrılmıştır.
CREATE OR REPLACE FUNCTION contract_reminder_backfill_tenants() RETURNS SETOF uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT DISTINCT f.tenant_id FROM contract_families f
  WHERE NOT f.intake_flow
    AND NOT EXISTS (SELECT 1 FROM contract_approval_chains c WHERE c.family_id = f.id)
    AND NOT EXISTS (SELECT 1 FROM contract_reminders r WHERE r.family_id = f.id)
    AND EXISTS (
      SELECT 1 FROM contract_versions v
      JOIN LATERAL (SELECT t.verified_at FROM contract_terms t WHERE t.contract_version_id = v.id ORDER BY t.revision DESC LIMIT 1) lt ON true
      WHERE v.family_id = f.id AND v.superseded_by_id IS NULL AND lt.verified_at IS NOT NULL)
$$;
REVOKE ALL ON FUNCTION contract_reminder_backfill_tenants() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION contract_reminder_backfill_tenants() TO sp_app;
