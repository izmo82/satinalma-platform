-- v2 Faz 3 (D108) final inceleme düzeltmesi (I1 + M1): hatırlatıcı geri doldurma kapısı.
-- 051b kiracıyı, hatırlatıcısı olmayan her doğrulanmış eski kaydı için seçiyordu; süresi dolmuş sözleşmeler de dahil. Süresi dolmuş
-- sözleşmeye artık hatırlatıcı kurulmadığından (reminderDates) o kiracılar her gün yeniden seçilip boş iş alırdı. Yeni kural
-- (apps/api/src/modules/contractReminders.ts BACKFILL_FAMILY_WHERE ile aynı):
--   * eski kayıt (intake_flow false); onaylı ya da açık zinciri yok (yalnız iptal edilmiş/reddedilmiş zinciri olan eski kayıt dahil: M1);
--   * güncel sürümün son koşulu doğrulanmış ve O KOŞUL için hatırlatıcı yok (eski koşulun hatırlatıcıları yeni koşulu kapsamaz: M1);
--   * süresi dolmamış: süreli sözleşmede bitiş bugün (İstanbul) ya da sonra; süresizde ihbar süresi ve başlangıç var.
-- Yalnız kiracı kimliği döner; sözleşme verisi dönmez. 051b değiştirilmez (uygulanmış dosya). 051c Faz 4'e aittir.
CREATE OR REPLACE FUNCTION contract_reminder_backfill_tenants() RETURNS SETOF uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT DISTINCT f.tenant_id FROM contract_families f
  WHERE NOT f.intake_flow
    AND NOT EXISTS (SELECT 1 FROM contract_approval_chains c
      WHERE c.family_id = f.id AND (c.outcome IS NULL OR c.outcome NOT IN ('CANCELLED','REJECTED')))
    AND EXISTS (
      SELECT 1 FROM contract_versions v
      JOIN LATERAL (SELECT t.id, t.verified_at, t.start_date, t.end_date FROM contract_terms t
        WHERE t.contract_version_id = v.id ORDER BY t.revision DESC LIMIT 1) lt ON true
      WHERE v.family_id = f.id AND v.superseded_by_id IS NULL AND lt.verified_at IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM contract_reminders r WHERE r.terms_id = lt.id)
        AND CASE WHEN f.indefinite THEN f.termination_notice_amount IS NOT NULL AND lt.start_date IS NOT NULL
                 ELSE lt.end_date IS NOT NULL AND lt.end_date >= (now() AT TIME ZONE 'Europe/Istanbul')::date END)
$$;
REVOKE ALL ON FUNCTION contract_reminder_backfill_tenants() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION contract_reminder_backfill_tenants() TO sp_app;
