-- v2 Faz 6 (D111) bütün faz incelemesi düzeltmeleri. 053/054/054a/054b uygulanmış olduğundan değiştirilmez.
-- (1) M4 app_contract_in_force(family): tedarikçi oturumunda (app_supplier_id() dolu) her zaman false. SECURITY DEFINER işlev RLS'i
--     atladığından tedarikçi oturumu başka tedarikçilerin sözleşme ailelerinin yürürlük durumunu sorgulayabiliyordu. Gövde 054a ile birebir;
--     yalnız tedarikçi koşulu eklendi. İç oturumlar değişmez.
-- (2) I2 app_my_risk_actions(): aksiyon sahibi (Ruling 6) başka departmandaysa değerlendirmeyi göremez (054 dept_read); kendi aksiyon
--     satırlarını 054a ile görür ama tedarikçi adı ve değerlendirme yılı için değerlendirme satırına ihtiyaç var. Bu dar kapı yalnız
--     çağıranın sahibi olduğu, iptal edilmemiş değerlendirmelerdeki aksiyonları ve bu iki üst alanı döner; kriter, cevap, görüş dönmez.

CREATE OR REPLACE FUNCTION app_contract_in_force(p_family uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT app_supplier_id() IS NULL AND coalesce((
    SELECT
      -- missingRequired (eksik alan → INCOMPLETE)
      f.project_id IS NOT NULL AND f.supplier_id IS NOT NULL AND coalesce(btrim(f.contract_type), '') <> ''
      AND f.owner_user_id IS NOT NULL AND f.signed_on IS NOT NULL
      AND t.id IS NOT NULL
      AND (t.value_type = 'UNPRICED' OR t.amount IS NOT NULL)
      AND coalesce(btrim(t.currency), '') <> '' AND t.limit_basis IS NOT NULL AND t.start_date IS NOT NULL
      AND (f.indefinite OR t.end_date IS NOT NULL)
      AND (NOT (f.indefinite OR t.auto_renewal)
           OR (CASE WHEN f.indefinite THEN f.termination_notice_amount IS NOT NULL AND f.termination_notice_unit IS NOT NULL
                    ELSE t.notice_amount IS NOT NULL AND t.notice_unit IS NOT NULL END))
      -- APPROVED (son zincir güncel içeriği onaylamış) ya da LEGACY (Faz 3 öncesi, hiç zincir yok)
      AND ((lc.closed_at IS NOT NULL AND lc.outcome = 'APPROVED' AND lc.version_id = cv.id AND lc.terms_id = t.id)
           OR (NOT f.intake_flow AND NOT EXISTS (SELECT 1 FROM contract_approval_chains c2 WHERE c2.family_id = f.id)))
      -- süresi dolmamış
      AND (f.indefinite OR t.end_date IS NULL OR t.end_date >= (now() AT TIME ZONE 'Europe/Istanbul')::date)
    FROM contract_families f
    LEFT JOIN LATERAL (SELECT v.id FROM contract_versions v WHERE v.family_id = f.id AND v.superseded_by_id IS NULL
                       ORDER BY v.version_no DESC LIMIT 1) cv ON true
    LEFT JOIN LATERAL (SELECT x.* FROM contract_terms x WHERE x.contract_version_id = cv.id ORDER BY x.revision DESC LIMIT 1) t ON true
    LEFT JOIN LATERAL (SELECT c.closed_at, c.outcome, c.version_id, c.terms_id FROM contract_approval_chains c WHERE c.family_id = f.id
                       ORDER BY c.submitted_at DESC, c.id DESC LIMIT 1) lc ON true
    WHERE f.id = p_family AND f.tenant_id = app_tenant_id()), false)
$$;
REVOKE ALL ON FUNCTION app_contract_in_force(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_contract_in_force(uuid) TO sp_app;

CREATE OR REPLACE FUNCTION app_my_risk_actions()
RETURNS TABLE (id uuid, assessment_id uuid, supplier_id uuid, supplier_name text, year int, kind text, control_method text, title text,
               description text, due_on date, status text, completion_note text, completed_at timestamptz, created_at timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT x.id, x.assessment_id, a.supplier_id, s.legal_name::text, a.year, x.kind::text, x.control_method::text, x.title, x.description, x.due_on,
         x.status::text, x.completion_note, x.completed_at, x.created_at
  FROM risk_actions x
  JOIN risk_assessments a ON a.id = x.assessment_id AND a.tenant_id = x.tenant_id
  JOIN suppliers s ON s.id = a.supplier_id
  WHERE app_tenant_id() IS NOT NULL AND app_user_id() IS NOT NULL AND app_supplier_id() IS NULL
    AND x.tenant_id = app_tenant_id() AND x.owner_user_id = app_user_id() AND a.status <> 'CANCELLED'
  ORDER BY CASE WHEN x.status = 'OPEN' THEN 0 ELSE 1 END, x.due_on NULLS LAST, x.created_at, x.id
$$;
REVOKE ALL ON FUNCTION app_my_risk_actions() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_my_risk_actions() TO sp_app;
