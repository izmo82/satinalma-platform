-- v2 Faz 1 (D93, analiz-v2 §2.3) düzeltme: belge yolu departman kapsamı. Belge kendi başına departman taşımaz; onu kullanan
-- departman kapsamlı kayıt (sözleşme sürümü, fatura, değerlendirme kanıtı, imza/teminat/SLA kanıtı) bölüm kullanıcısına
-- görünmüyorsa belge, sürümleri ve sürüm başına alt kayıtlar da görünmez. Hiçbir kapsamlı kaydın kullanmadığı belge (yeni
-- yükleme) bugünkü gibi görünür. Tüm departmanı gören ve tedarikçi bağlamında kontrol çalışmaz (app_department_all()).
-- Veri değişmez; yeniden çalıştırmada aynı sonucu verir.

-- Kontrol, RLS'in gizlediği kayıtları da görebilmek için sahip yetkisiyle (SECURITY DEFINER) çalışır; departman kararı
-- yine oturumun kapsamından (app_department_ok) gelir. Departmansız (NULL) kapsamlı kayıt bölüm kullanıcısına kapalıdır.
CREATE OR REPLACE FUNCTION app_document_version_hidden(dv uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT dv IS NOT NULL AND (
    EXISTS (SELECT 1 FROM contract_versions cv JOIN contract_families f ON f.id = cv.family_id
            WHERE cv.document_version_id = dv AND NOT coalesce(app_department_ok(f.department_id), false))
    OR EXISTS (SELECT 1 FROM invoices i WHERE i.document_version_id = dv AND NOT coalesce(app_department_ok(i.department_id), false))
    OR EXISTS (SELECT 1 FROM assessment_answers aa JOIN supplier_assessments a ON a.id = aa.assessment_id
               WHERE aa.evidence_document_version_id = dv AND NOT coalesce(app_department_ok(a.department_id), false))
    OR EXISTS (SELECT 1 FROM signature_requirements x JOIN contract_versions cv ON cv.id = x.contract_version_id JOIN contract_families f ON f.id = cv.family_id
               WHERE x.document_version_id = dv AND NOT coalesce(app_department_ok(f.department_id), false))
    OR EXISTS (SELECT 1 FROM signature_detection_runs x JOIN contract_versions cv ON cv.id = x.contract_version_id JOIN contract_families f ON f.id = cv.family_id
               WHERE x.document_version_id = dv AND NOT coalesce(app_department_ok(f.department_id), false))
    OR EXISTS (SELECT 1 FROM signature_reviews x JOIN signature_requirements r ON r.id = x.requirement_id JOIN contract_versions cv ON cv.id = r.contract_version_id
               JOIN contract_families f ON f.id = cv.family_id WHERE x.document_version_id = dv AND NOT coalesce(app_department_ok(f.department_id), false))
    OR EXISTS (SELECT 1 FROM contract_guarantees x JOIN contract_versions cv ON cv.id = x.contract_version_id JOIN contract_families f ON f.id = cv.family_id
               WHERE x.document_version_id = dv AND NOT coalesce(app_department_ok(f.department_id), false))
    OR EXISTS (SELECT 1 FROM sla_measurements x JOIN sla_terms t ON t.id = x.sla_term_id JOIN contract_versions cv ON cv.id = t.contract_version_id
               JOIN contract_families f ON f.id = cv.family_id WHERE x.document_version_id = dv AND NOT coalesce(app_department_ok(f.department_id), false))
  )
$$;
-- Belge, sürümlerinden biri gizliyse bütünüyle gizlidir (aynı belgenin başka sürümü kimlikle açılamaz).
CREATE OR REPLACE FUNCTION app_document_hidden(doc uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (SELECT 1 FROM document_versions v WHERE v.document_id = doc AND app_document_version_hidden(v.id))
$$;
CREATE OR REPLACE FUNCTION app_document_version_blocked(dv uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT dv IS NOT NULL AND EXISTS (SELECT 1 FROM document_versions v WHERE v.id = dv AND app_document_hidden(v.document_id))
$$;
REVOKE ALL ON FUNCTION app_document_version_hidden(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION app_document_hidden(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION app_document_version_blocked(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_document_version_hidden(uuid) TO sp_app;
GRANT EXECUTE ON FUNCTION app_document_hidden(uuid) TO sp_app;
GRANT EXECUTE ON FUNCTION app_document_version_blocked(uuid) TO sp_app;

-- Kontrolün aradığı belge sütunlarında indeks (bölüm kullanıcısı başına satır başına bir arama).
CREATE INDEX IF NOT EXISTS contract_versions_document_version_idx ON contract_versions (document_version_id);
CREATE INDEX IF NOT EXISTS invoices_document_version_idx ON invoices (document_version_id);
CREATE INDEX IF NOT EXISTS assessment_answers_evidence_dv_idx ON assessment_answers (evidence_document_version_id);
CREATE INDEX IF NOT EXISTS signature_requirements_document_version_idx ON signature_requirements (document_version_id);
CREATE INDEX IF NOT EXISTS signature_detection_runs_document_version_idx ON signature_detection_runs (document_version_id);
CREATE INDEX IF NOT EXISTS signature_reviews_document_version_idx ON signature_reviews (document_version_id);
CREATE INDEX IF NOT EXISTS contract_guarantees_document_version_idx ON contract_guarantees (document_version_id);
CREATE INDEX IF NOT EXISTS sla_measurements_document_version_idx ON sla_measurements (document_version_id);

DROP POLICY IF EXISTS dept ON documents;
CREATE POLICY dept ON documents AS RESTRICTIVE FOR ALL
  USING (app_department_all() OR NOT app_document_hidden(id)) WITH CHECK (app_department_all() OR NOT app_document_hidden(id));
DROP POLICY IF EXISTS dept ON document_versions;
CREATE POLICY dept ON document_versions AS RESTRICTIVE FOR ALL
  USING (app_department_all() OR NOT app_document_hidden(document_id)) WITH CHECK (app_department_all() OR NOT app_document_hidden(document_id));

-- Sürüm başına alt tablolar (sütun adı \d ile doğrulandı; migration da doğrular).
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['extracted_fields','einvoice_checks','supplier_document_links','ai_runs','signature_detections'] LOOP
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = t AND column_name = 'document_version_id') THEN
      RAISE EXCEPTION 'department policy: %.document_version_id does not exist', t;
    END IF;
    EXECUTE format('DROP POLICY IF EXISTS dept ON %I', t);
    EXECUTE format('CREATE POLICY dept ON %I AS RESTRICTIVE FOR ALL USING (app_department_all() OR NOT app_document_version_blocked(document_version_id)) '
                   'WITH CHECK (app_department_all() OR NOT app_document_version_blocked(document_version_id))', t);
  END LOOP;
END $$;
