-- 054 v2 Faz 6 (D111): risk değerlendirmesinin departman görünürlüğü (R5) ve görev departmanı.
--  * Sorumlu departman (risk_assessments.department_id) değerlendirmeyi görür ve yazar; Yönetici/Satınalma/Denetçi (kapsam ALL) hepsini görür.
--  * Katkıcı departman: değerlendirmenin tedarikçisiyle yürürlükte sözleşmesi olan diğer departman yalnız OKUR ve GÖRÜŞ ekler
--    (taslak, aksiyon, revizyon, gözden geçirme yazamaz). Departmansız değerlendirmeyi (D96) yalnız tüm departmanı görenler görür;
--    katkıcı yolu departmansız kayda açılmaz.
--  * "Yürürlükte" (Faz 3 R1, plan notu: APPROVED ya da LEGACY, süresi geçmemiş): ailenin son onay zinciri kapanmış APPROVED ve güncel sürümü
--    (superseded olmayan en yüksek sürüm) ile onun son koşul revizyonunu kapsıyor; ya da Faz 3 geçişinden önce açılmış (intake_flow=false)
--    ve hiç zinciri olmayan eski kayıt. Her iki durumda süresiz ya da bitiş tarihi bugünden (İstanbul) önce değil.
--  * İçe aktarım tabloları yalnız tüm departmanı görenlere (Yönetici/Satınalma işi; ham satırlar her departmanın tedarikçisini içerir).
--  * Soru setleri ve ayar kiracı düzeyidir (departman kullanıcısı formda setin sorularını okur).

-- 1. Katkıcı departman. Yalnız bool döner; RLS'in gizlediği sözleşme ve değerlendirme satırlarını sahip yetkisiyle okur.
CREATE OR REPLACE FUNCTION app_is_risk_contributor(p_assessment uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT app_tenant_id() IS NOT NULL AND app_user_id() IS NOT NULL AND app_supplier_id() IS NULL AND EXISTS (
    SELECT 1
    FROM risk_assessments a
    JOIN contract_families f ON f.tenant_id = a.tenant_id AND f.supplier_id = a.supplier_id
    LEFT JOIN LATERAL (SELECT v.id FROM contract_versions v WHERE v.family_id = f.id AND v.superseded_by_id IS NULL
                       ORDER BY v.version_no DESC LIMIT 1) cv ON true
    LEFT JOIN LATERAL (SELECT t.id, t.end_date FROM contract_terms t WHERE t.contract_version_id = cv.id
                       ORDER BY t.revision DESC LIMIT 1) t ON true
    LEFT JOIN LATERAL (SELECT c.closed_at, c.outcome, c.version_id, c.terms_id FROM contract_approval_chains c WHERE c.family_id = f.id
                       ORDER BY c.submitted_at DESC, c.id DESC LIMIT 1) lc ON true
    WHERE a.id = p_assessment AND a.tenant_id = app_tenant_id() AND a.department_id IS NOT NULL
      AND f.department_id = ANY (coalesce(nullif(current_setting('app.department_ids', true), ''), '{}')::uuid[])
      AND ((lc.closed_at IS NOT NULL AND lc.outcome = 'APPROVED' AND lc.version_id = cv.id AND lc.terms_id = t.id)
           OR (NOT f.intake_flow AND NOT EXISTS (SELECT 1 FROM contract_approval_chains c2 WHERE c2.family_id = f.id)))
      AND (f.indefinite OR t.end_date IS NULL OR t.end_date >= (now() AT TIME ZONE 'Europe/Istanbul')::date)
  )
$$;
REVOKE ALL ON FUNCTION app_is_risk_contributor(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_is_risk_contributor(uuid) TO sp_app;

-- 2. Değerlendirme: okuma departman VEYA katkıcı; ekleme ve güncelleme yalnız departman (katkıcı UPDATE 0 satır).
CREATE POLICY dept_read ON risk_assessments AS RESTRICTIVE FOR SELECT
  USING (app_department_ok(department_id) OR app_is_risk_contributor(id));
CREATE POLICY dept_add ON risk_assessments AS RESTRICTIVE FOR INSERT
  WITH CHECK (app_department_ok(department_id));
CREATE POLICY dept_change ON risk_assessments AS RESTRICTIVE FOR UPDATE
  USING (app_department_ok(department_id))
  WITH CHECK (app_department_ok(department_id));

-- 3. Alt tablolar üst kaydı devralır: okuma, üst kayıt (kendi RLS'iyle; katkıcı dahil) görünüyorsa; yazma, üst kaydın departmanı
--    çağıranın kapsamındaysa. Tümünü gören ve tedarikçi bağlamında alt sorgu çalışmaz (tedarikçi 053 politikalarıyla sınırlıdır).
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['risk_assessment_revisions','risk_actions','risk_reviews','risk_opinions'] LOOP
    EXECUTE format('CREATE POLICY dept_read ON %1$I AS RESTRICTIVE FOR SELECT '
                   'USING (app_department_all() OR EXISTS (SELECT 1 FROM risk_assessments p WHERE p.id = %1$I.assessment_id))', t);
    EXECUTE format('CREATE POLICY dept_change ON %1$I AS RESTRICTIVE FOR UPDATE '
                   'USING (app_department_all() OR EXISTS (SELECT 1 FROM risk_assessments p WHERE p.id = %1$I.assessment_id AND app_department_ok(p.department_id))) '
                   'WITH CHECK (app_department_all() OR EXISTS (SELECT 1 FROM risk_assessments p WHERE p.id = %1$I.assessment_id AND app_department_ok(p.department_id)))', t);
  END LOOP;
  FOREACH t IN ARRAY ARRAY['risk_assessment_revisions','risk_actions','risk_reviews'] LOOP
    EXECUTE format('CREATE POLICY dept_add ON %1$I AS RESTRICTIVE FOR INSERT '
                   'WITH CHECK (app_department_all() OR EXISTS (SELECT 1 FROM risk_assessments p WHERE p.id = %1$I.assessment_id AND app_department_ok(p.department_id)))', t);
  END LOOP;
END $$;

-- Görüş: sorumlu departman ya da katkıcı ekler; yazar çağıranın kendisidir; görüşün departmanı çağıranın departmanlarından biridir
-- (departmansız görüşü yalnız tümünü gören yazar).
CREATE POLICY dept_add ON risk_opinions AS RESTRICTIVE FOR INSERT
  WITH CHECK (author_id = app_user_id()
              AND ((department_id IS NULL AND app_department_all()) OR (department_id IS NOT NULL AND app_department_ok(department_id)))
              AND (app_department_all()
                   OR EXISTS (SELECT 1 FROM risk_assessments p WHERE p.id = risk_opinions.assessment_id AND app_department_ok(p.department_id))
                   OR app_is_risk_contributor(assessment_id)));

-- 4. İçe aktarım yalnız tüm departmanı görenlere.
CREATE POLICY dept ON risk_import_batches AS RESTRICTIVE FOR ALL USING (app_department_all()) WITH CHECK (app_department_all());
CREATE POLICY dept ON risk_import_rows AS RESTRICTIVE FOR ALL USING (app_department_all()) WITH CHECK (app_department_all());

-- 5. Görev departmanı: 'risk_assessment' dalı eklenir; diğer dallar 032/035 ile birebir. Departmansız risk görevi (ör. "Sorumlu departmanı
--    seçin") departman kullanıcısına açılmaz (033 politikası: departmanlı tür + boş departman → yalnız tümünü gören).
CREATE OR REPLACE FUNCTION app_task_departmental(p_type text) RETURNS boolean
  LANGUAGE sql IMMUTABLE AS $$
  SELECT p_type IN ('project','rfq_round','award','evaluation','sourcing_exception','contract_family','contract_version','invoice','supplier_assessment',
                    'risk_assessment')
$$;
CREATE OR REPLACE FUNCTION app_task_department(p_type text, p_id uuid) RETURNS uuid
  LANGUAGE sql STABLE AS $$
  SELECT CASE p_type
    WHEN 'project' THEN (SELECT x.department_id FROM projects x WHERE x.id = p_id)
    WHEN 'rfq_round' THEN (SELECT p.department_id FROM rfq_rounds x JOIN projects p ON p.id = x.project_id WHERE x.id = p_id)
    WHEN 'award' THEN (SELECT p.department_id FROM awards x JOIN projects p ON p.id = x.project_id WHERE x.id = p_id)
    WHEN 'evaluation' THEN (SELECT p.department_id FROM evaluations x JOIN projects p ON p.id = x.project_id WHERE x.id = p_id)
    WHEN 'sourcing_exception' THEN (SELECT p.department_id FROM sourcing_exceptions x JOIN projects p ON p.id = x.project_id WHERE x.id = p_id)
    WHEN 'contract_family' THEN (SELECT x.department_id FROM contract_families x WHERE x.id = p_id)
    WHEN 'contract_version' THEN (SELECT f.department_id FROM contract_versions x JOIN contract_families f ON f.id = x.family_id WHERE x.id = p_id)
    WHEN 'invoice' THEN (SELECT x.department_id FROM invoices x WHERE x.id = p_id)
    WHEN 'supplier_assessment' THEN (SELECT x.department_id FROM supplier_assessments x WHERE x.id = p_id)
    WHEN 'incident' THEN (SELECT f.department_id FROM supplier_incidents x JOIN contract_versions cv ON cv.id = x.contract_version_id
                           JOIN contract_families f ON f.id = cv.family_id WHERE x.id = p_id)
    WHEN 'risk_assessment' THEN (SELECT x.department_id FROM risk_assessments x WHERE x.id = p_id)
  END
$$;
REVOKE ALL ON FUNCTION app_task_departmental(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION app_task_department(text, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_task_departmental(text), app_task_department(text, uuid) TO sp_app;
