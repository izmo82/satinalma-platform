-- 054a v2 Faz 6 (D111) Görev 2 inceleme düzeltmeleri. 053/054 uygulanmış olduğundan değiştirilmez; bu dosya telafi eder ve sıkılaştırır.
-- (1) R13: tedarikçi oturumu risk tablolarını hiç okuyamaz (RESTRICTIVE no_supplier). Portal yalnız app_portal_risk() ile son tamamlanmış
--     yılın seviyesini, skorunu ve tedarikçiye görünür aksiyonlarını (başlık, tarih, durum) alır.
-- (2) Seviye 4–5 güvencesi her yoldan: denetim risk_check_completion()'a taşındı; tamamlanmış değerlendirmeye yeni revizyon eklenmesi ve
--     aksiyon durumunun değişmesi (ör. tek MITIGATION/CONTROL satırının iptali) de işlem sonunda yeniden denetlenir.
-- (3) app_contract_in_force(family): domain contractStatus ile aynı "Yürürlükte" (APPROVED ya da LEGACY): zorunlu alan eksikse yürürlükte değil
--     (missingRequired), son zincir kapanmış APPROVED ve güncel sürüm + son koşul revizyonunu kapsar ya da Faz 3 öncesi kayıt
--     (intake_flow=false, hiç zincir yok); süresiz değilse bitiş bugünden (İstanbul) önce değil. Katkıcı departman bu yardımcıyı kullanır.
-- (4) Aksiyon sahibi (owner_user_id) başka departmanda olsa da kendi aksiyon satırını görür ve günceller (API sahibin güncellemesini
--     durum/kapanış alanlarıyla sınırlar). Değerlendirmenin kendisini görmez.
-- (5) Küçükler: gözden geçirmenin revizyonu aynı değerlendirmenin olmalı; önceki yıl değerlendirmesi aynı tedarikçinin olmalı;
--     içe aktarım satırı yalnız önizlemedeki partiye eklenir; contract_families (tenant_id, supplier_id) dizini.

-- 1. Tedarikçi oturumu ham risk tablolarına kapalı.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['risk_assessments','risk_assessment_revisions','risk_actions'] LOOP
    EXECUTE format('CREATE POLICY no_supplier ON %I AS RESTRICTIVE FOR ALL USING (app_supplier_id() IS NULL) WITH CHECK (app_supplier_id() IS NULL)', t);
  END LOOP;
END $$;

-- R13 portal görünümü. Yalnız şu anahtarlar döner: year, level, riskScore ("15.00"), actions [{title, dueOn, status}].
-- Kaynak: tedarikçinin en yeni yıllı COMPLETED değerlendirmesinin son revizyonu; aksiyonlardan yalnız supplier_visible ve iptal edilmemiş olanlar.
-- Tamamlanmış değerlendirme yoksa year/level/riskScore null, actions []. Dönmeyenler: ölçütler, kritiklik, sorular, cevaplar, notlar,
-- görüşler, sahipler, açıklamalar, departman.
CREATE OR REPLACE FUNCTION app_portal_risk() RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_tenant uuid := app_tenant_id();
  v_supplier uuid := app_supplier_id();
  v_id uuid;
  v_year int;
  v_level smallint;
  v_score text;
BEGIN
  IF v_tenant IS NULL OR v_supplier IS NULL THEN
    RAISE EXCEPTION 'portal_context_required' USING ERRCODE = '42501';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM suppliers s WHERE s.id = v_supplier AND s.tenant_id = v_tenant) THEN
    RAISE EXCEPTION 'portal_context_required' USING ERRCODE = '42501';
  END IF;
  SELECT a.id, a.year INTO v_id, v_year FROM risk_assessments a
   WHERE a.tenant_id = v_tenant AND a.supplier_id = v_supplier AND a.status = 'COMPLETED'
   ORDER BY a.year DESC LIMIT 1;
  IF v_id IS NULL THEN
    RETURN jsonb_build_object('year', NULL, 'level', NULL, 'riskScore', NULL, 'actions', '[]'::jsonb);
  END IF;
  SELECT r.level, r.risk_score::text INTO v_level, v_score FROM risk_assessment_revisions r
   WHERE r.assessment_id = v_id ORDER BY r.revision_no DESC LIMIT 1;
  RETURN jsonb_build_object(
    'year', v_year,
    'level', v_level,
    'riskScore', v_score,
    'actions', coalesce((
      SELECT jsonb_agg(jsonb_build_object('title', x.title, 'dueOn', x.due_on::text, 'status', x.status) ORDER BY x.due_on NULLS LAST, x.created_at, x.id)
      FROM risk_actions x WHERE x.assessment_id = v_id AND x.supplier_visible AND x.status <> 'CANCELLED'), '[]'::jsonb));
END $$;
REVOKE ALL ON FUNCTION app_portal_risk() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_portal_risk() TO sp_app;

-- 2. Tamamlanma denetimi (işlem sonunda). Değerlendirme o anda COMPLETED değilse bir şey yapmaz.
CREATE OR REPLACE FUNCTION risk_check_completion(p_assessment uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_level smallint;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM risk_assessments a WHERE a.id = p_assessment AND a.status = 'COMPLETED') THEN
    RETURN;
  END IF;
  SELECT r.level INTO v_level FROM risk_assessment_revisions r WHERE r.assessment_id = p_assessment ORDER BY r.revision_no DESC LIMIT 1;
  IF v_level IS NULL THEN
    RAISE EXCEPTION 'risk_completion_blocked: revision_missing' USING ERRCODE = 'P0001';
  END IF;
  IF v_level >= 4 AND (
       NOT EXISTS (SELECT 1 FROM risk_actions x WHERE x.assessment_id = p_assessment AND x.kind = 'MITIGATION' AND x.status <> 'CANCELLED')
       OR NOT EXISTS (SELECT 1 FROM risk_actions x WHERE x.assessment_id = p_assessment AND x.kind = 'CONTROL' AND x.status <> 'CANCELLED')) THEN
    RAISE EXCEPTION 'risk_completion_blocked: action_plan_required' USING ERRCODE = 'P0001';
  END IF;
END $$;
REVOKE ALL ON FUNCTION risk_check_completion(uuid) FROM PUBLIC;

-- 053'teki değerlendirme tetikleyicisi aynı denetimi çağırır (tetikleyici tanımı değişmez).
CREATE OR REPLACE FUNCTION risk_assessments_completion_check() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  PERFORM risk_check_completion(NEW.id);
  RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION risk_assessments_completion_check() FROM PUBLIC;

CREATE OR REPLACE FUNCTION risk_child_completion_check() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  PERFORM risk_check_completion(NEW.assessment_id);
  RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION risk_child_completion_check() FROM PUBLIC;
CREATE CONSTRAINT TRIGGER risk_assessment_revisions_completion_check AFTER INSERT ON risk_assessment_revisions
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION risk_child_completion_check();
CREATE CONSTRAINT TRIGGER risk_actions_completion_check AFTER UPDATE OF status ON risk_actions
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION risk_child_completion_check();

-- 3. Sözleşme yürürlükte mi (domain contractV2.contractStatus code ∈ {APPROVED, LEGACY}; API contractIntake.statusOf girdileriyle).
--    Güncel sürüm: superseded olmayan en yüksek sürüm; koşul: o sürümün son revizyonu; zincirler submitted_at, id sırasıyla, sonuncusu geçerli.
--    Yalnız bool döner; RLS'in gizlediği satırları sahip yetkisiyle okur; yalnız çağıranın kiracısındaki aile için true olabilir.
CREATE OR REPLACE FUNCTION app_contract_in_force(p_family uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT coalesce((
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

CREATE INDEX IF NOT EXISTS contract_families_supplier_idx ON contract_families (tenant_id, supplier_id);

CREATE OR REPLACE FUNCTION app_is_risk_contributor(p_assessment uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT app_tenant_id() IS NOT NULL AND app_user_id() IS NOT NULL AND app_supplier_id() IS NULL AND EXISTS (
    SELECT 1
    FROM risk_assessments a
    JOIN contract_families f ON f.tenant_id = a.tenant_id AND f.supplier_id = a.supplier_id
    WHERE a.id = p_assessment AND a.tenant_id = app_tenant_id() AND a.department_id IS NOT NULL
      AND f.department_id = ANY (coalesce(nullif(current_setting('app.department_ids', true), ''), '{}')::uuid[])
      AND app_contract_in_force(f.id)
  )
$$;
REVOKE ALL ON FUNCTION app_is_risk_contributor(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_is_risk_contributor(uuid) TO sp_app;

-- 4. Aksiyon sahibi kendi satırını görür ve günceller.
DROP POLICY dept_read ON risk_actions;
CREATE POLICY dept_read ON risk_actions AS RESTRICTIVE FOR SELECT
  USING (app_department_all() OR EXISTS (SELECT 1 FROM risk_assessments p WHERE p.id = risk_actions.assessment_id)
         OR owner_user_id = app_user_id());
DROP POLICY dept_change ON risk_actions;
CREATE POLICY dept_change ON risk_actions AS RESTRICTIVE FOR UPDATE
  USING (app_department_all() OR EXISTS (SELECT 1 FROM risk_assessments p WHERE p.id = risk_actions.assessment_id AND app_department_ok(p.department_id))
         OR owner_user_id = app_user_id())
  WITH CHECK (app_department_all() OR EXISTS (SELECT 1 FROM risk_assessments p WHERE p.id = risk_actions.assessment_id AND app_department_ok(p.department_id))
              OR owner_user_id = app_user_id());

-- 5. Küçükler.
ALTER TABLE risk_assessment_revisions ADD CONSTRAINT risk_assessment_revisions_assessment_id_key UNIQUE (assessment_id, id);
ALTER TABLE risk_reviews ADD CONSTRAINT risk_reviews_revision_same_assessment
  FOREIGN KEY (assessment_id, revision_id) REFERENCES risk_assessment_revisions (assessment_id, id);
ALTER TABLE risk_assessments ADD CONSTRAINT risk_assessments_supplier_id_key UNIQUE (tenant_id, supplier_id, id);
ALTER TABLE risk_assessments ADD CONSTRAINT risk_assessments_prior_same_supplier
  FOREIGN KEY (tenant_id, supplier_id, prior_assessment_id) REFERENCES risk_assessments (tenant_id, supplier_id, id);

CREATE OR REPLACE FUNCTION risk_import_rows_insert_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM risk_import_batches b WHERE b.id = NEW.batch_id AND b.status = 'PREVIEW') THEN
    RAISE EXCEPTION 'immutable_record: risk_import_rows (batch not in preview)' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER risk_import_rows_insert_guard BEFORE INSERT ON risk_import_rows FOR EACH ROW EXECUTE FUNCTION risk_import_rows_insert_guard();
