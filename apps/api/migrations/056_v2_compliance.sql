-- 056 v2 Faz 7 (D112): sürümlü satınalma kuralları ve uyum denetimi şeması.
-- Kurallar:
--  * Kural seti DRAFT → PUBLISHED (tek yön); yayımlı set ve kuralları değişmez, silinmez (R6). Kiracı başına tek açık taslak.
--    Yürürlük tarihi kuralı (effective_from ≥ bugün) ve set seçimi API/domain'dedir (activeRuleSet).
--  * Kural alanları domain validateComplianceRule ile aynı sınırlar (R7): ağırlık 1–100 tam sayı; MANUAL kuralın anahtarı ve
--    parametresi yok; DATA/EVIDENCE_AI kuralın anahtarı var; yöntem kapsamı PROJECT_METHODS; tutar eşiği para birimiyle.
--  * Denetim koşusu ve kural sonuçları, elle işaretler ve yapay zekâ önbelleği değişmez kayıttır (yalnız INSERT/SELECT + tetikleyici).
--    Puan ve hüküm kodda hesaplanır (complianceScore); burada yalnız biçim denetlenir.
--  * Kural tabloları kiracı RLS'i; denetim tabloları kiracı + şirket + proje departmanı. Tedarikçi bağlamı hiçbirine erişemez.
--  * Belge yolu (031/048/050): uyum kanıtı ve elle işaret belgesi projenin departmanını taşır; başka departmanın kullanıcısına belge de görünmez.

-- 1. Kural setleri (R6).
CREATE TABLE procurement_rule_sets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  version_no int NOT NULL CHECK (version_no > 0),
  status text NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT','PUBLISHED')),
  effective_from date,
  created_by uuid NOT NULL REFERENCES users(id),
  published_by uuid REFERENCES users(id),
  published_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, version_no),
  CHECK ((status = 'DRAFT') = (published_at IS NULL) AND (published_at IS NULL) = (published_by IS NULL)),
  CHECK (status <> 'PUBLISHED' OR effective_from IS NOT NULL)
);
CREATE UNIQUE INDEX procurement_rule_sets_one_draft ON procurement_rule_sets (tenant_id) WHERE status = 'DRAFT';
CREATE INDEX procurement_rule_sets_effective_idx ON procurement_rule_sets (tenant_id, effective_from DESC) WHERE status = 'PUBLISHED';

-- Set silinmez; kimlik alanları değişmez; yayımlı set hiç değişmez; tek geçiş DRAFT → PUBLISHED.
CREATE OR REPLACE FUNCTION procurement_rule_sets_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' OR OLD.status = 'PUBLISHED'
     OR (NEW.tenant_id, NEW.version_no, NEW.created_by, NEW.created_at) IS DISTINCT FROM (OLD.tenant_id, OLD.version_no, OLD.created_by, OLD.created_at) THEN
    RAISE EXCEPTION 'immutable_record: procurement_rule_sets' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER procurement_rule_sets_guard BEFORE UPDATE OR DELETE ON procurement_rule_sets FOR EACH ROW EXECUTE FUNCTION procurement_rule_sets_guard();

-- 2. Kurallar (R7).
CREATE TABLE procurement_rules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  rule_set_id uuid NOT NULL,
  code text NOT NULL CHECK (length(btrim(code)) BETWEEN 1 AND 40),
  name text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 200),
  description text CHECK (description IS NULL OR length(description) <= 4000),
  check_type text NOT NULL CHECK (check_type IN ('DATA','EVIDENCE_AI','MANUAL')),
  check_key text CHECK (check_key ~ '^[A-Z][A-Z0-9_]{1,59}$'),
  params jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(params) = 'object'),
  scope_methods text[] NOT NULL DEFAULT '{}' CHECK (scope_methods <@ ARRAY['INVITED_BIDS','SINGLE_SOURCE']::text[]),
  min_amount numeric(20,2) CHECK (min_amount IS NULL OR min_amount >= 0),
  min_amount_currency char(3) CHECK (min_amount_currency IS NULL OR min_amount_currency ~ '^[A-Z]{3}$'),
  weight int NOT NULL CHECK (weight BETWEEN 1 AND 100),
  mandatory boolean NOT NULL DEFAULT false,
  sort_order int NOT NULL DEFAULT 0,
  UNIQUE (tenant_id, id),
  UNIQUE (rule_set_id, code),
  FOREIGN KEY (tenant_id, rule_set_id) REFERENCES procurement_rule_sets (tenant_id, id),
  CHECK ((check_type = 'MANUAL') = (check_key IS NULL)),
  CHECK (check_type <> 'MANUAL' OR params = '{}'::jsonb),
  CHECK (min_amount IS NULL OR min_amount_currency IS NOT NULL)
);
CREATE INDEX procurement_rules_set_idx ON procurement_rules (rule_set_id, sort_order);

-- Kural yalnız taslak sete eklenir, taslakta değişir/silinir; set ve kiracı bağı değişmez.
CREATE OR REPLACE FUNCTION procurement_rules_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE v_status text;
BEGIN
  SELECT s.status INTO v_status FROM procurement_rule_sets s WHERE s.id = CASE WHEN TG_OP = 'INSERT' THEN NEW.rule_set_id ELSE OLD.rule_set_id END;
  IF v_status IS DISTINCT FROM 'DRAFT' THEN
    RAISE EXCEPTION 'immutable_record: procurement_rules (set %)', coalesce(v_status, 'missing') USING ERRCODE = 'P0001';
  END IF;
  IF TG_OP = 'UPDATE' AND (NEW.tenant_id, NEW.rule_set_id) IS DISTINCT FROM (OLD.tenant_id, OLD.rule_set_id) THEN
    RAISE EXCEPTION 'immutable_record: procurement_rules' USING ERRCODE = 'P0001';
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END $$;
CREATE TRIGGER procurement_rules_guard BEFORE INSERT OR UPDATE OR DELETE ON procurement_rules FOR EACH ROW EXECUTE FUNCTION procurement_rules_guard();

-- 3. Denetim koşusu (R10): proje başına artan run_no; NO_RULESET puansız ve setsiz, DONE setli ve hükümlü.
CREATE TABLE compliance_audits (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  company_id uuid NOT NULL,
  project_id uuid NOT NULL,
  run_no int NOT NULL CHECK (run_no > 0),
  rule_set_id uuid,
  trigger text NOT NULL CHECK (trigger IN ('COMPLETED','RERUN')),
  status text NOT NULL CHECK (status IN ('NO_RULESET','DONE','FAILED')),
  score int CHECK (score BETWEEN 0 AND 100),
  verdict text CHECK (verdict IN ('COMPLIANT','NONCOMPLIANT','NO_RULES')),
  summary text CHECK (summary IS NULL OR length(summary) <= 20000),
  summary_source text CHECK (summary_source IN ('AUTO','AI')),
  ai_provider text CHECK (ai_provider IS NULL OR length(btrim(ai_provider)) BETWEEN 1 AND 200),
  ai_provider_is_test boolean NOT NULL DEFAULT false,
  run_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (project_id, run_no),
  FOREIGN KEY (tenant_id, company_id) REFERENCES legal_entities (tenant_id, id),
  FOREIGN KEY (tenant_id, project_id) REFERENCES projects (tenant_id, id),
  FOREIGN KEY (tenant_id, rule_set_id) REFERENCES procurement_rule_sets (tenant_id, id),
  CHECK (status <> 'NO_RULESET' OR (rule_set_id IS NULL AND score IS NULL AND verdict IS NULL)),
  CHECK (status <> 'DONE' OR (rule_set_id IS NOT NULL AND verdict IS NOT NULL)),
  CHECK (status <> 'FAILED' OR (score IS NULL AND verdict IS NULL)),
  CHECK (verdict IS DISTINCT FROM 'NO_RULES' OR score IS NULL),
  CHECK (summary_source IS DISTINCT FROM 'AI' OR ai_provider IS NOT NULL),
  CHECK (NOT ai_provider_is_test OR ai_provider IS NOT NULL)
);
CREATE INDEX compliance_audits_project_idx ON compliance_audits (project_id, run_no DESC);
CREATE INDEX compliance_audits_tenant_idx ON compliance_audits (tenant_id, created_at DESC);
CREATE TRIGGER compliance_audits_immutable BEFORE UPDATE OR DELETE ON compliance_audits FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

-- Denetim yalnız yayımlı setle koşar (taslak setle sonuç yazılmaz).
CREATE OR REPLACE FUNCTION compliance_audits_set_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.rule_set_id IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM procurement_rule_sets s WHERE s.id = NEW.rule_set_id AND s.status = 'PUBLISHED') THEN
    RAISE EXCEPTION 'compliance_rule_set_not_published' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER compliance_audits_set_guard BEFORE INSERT ON compliance_audits FOR EACH ROW EXECUTE FUNCTION compliance_audits_set_guard();

-- 4. Kural sonuçları: koşunun anlık görüntüsü (ağırlık ve zorunluluk koşu anındaki kuraldan kopyalanır). Kural koşunun setinden olmalı.
CREATE TABLE compliance_rule_results (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  audit_id uuid NOT NULL,
  rule_id uuid NOT NULL,
  result text NOT NULL CHECK (result IN ('PASS','FAIL','NO_DATA','PENDING','NOT_APPLICABLE')),
  method text CHECK (method IN ('DATA','AI','MANUAL')),
  finding text CHECK (finding IS NULL OR length(finding) <= 8000),
  evidence jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(evidence) IN ('array','object')),
  weight int NOT NULL CHECK (weight BETWEEN 1 AND 100),
  mandatory boolean NOT NULL,
  UNIQUE (tenant_id, id),
  UNIQUE (audit_id, rule_id),
  FOREIGN KEY (tenant_id, audit_id) REFERENCES compliance_audits (tenant_id, id),
  FOREIGN KEY (tenant_id, rule_id) REFERENCES procurement_rules (tenant_id, id)
);
CREATE INDEX compliance_rule_results_rule_idx ON compliance_rule_results (rule_id);
CREATE TRIGGER compliance_rule_results_immutable BEFORE UPDATE OR DELETE ON compliance_rule_results FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

CREATE OR REPLACE FUNCTION compliance_rule_results_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM compliance_audits a JOIN procurement_rules r ON r.rule_set_id = a.rule_set_id
                 WHERE a.id = NEW.audit_id AND r.id = NEW.rule_id) THEN
    RAISE EXCEPTION 'compliance_rule_not_in_audit_set' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER compliance_rule_results_guard BEFORE INSERT ON compliance_rule_results FOR EACH ROW EXECUTE FUNCTION compliance_rule_results_guard();

-- 5. Elle işaret (R8): Satınalma, not ≥ 10 karakter + kanıt belgesi. Değişmez; son işaret geçerlidir.
CREATE TABLE compliance_manual_marks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  company_id uuid NOT NULL,
  project_id uuid NOT NULL,
  rule_code text NOT NULL CHECK (length(btrim(rule_code)) BETWEEN 1 AND 40),
  result text NOT NULL CHECK (result IN ('PASS','FAIL')),
  note text NOT NULL CHECK (length(btrim(note)) >= 10 AND length(note) <= 4000),
  document_version_id uuid NOT NULL,
  marked_by uuid NOT NULL REFERENCES users(id),
  marked_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, company_id) REFERENCES legal_entities (tenant_id, id),
  FOREIGN KEY (tenant_id, project_id) REFERENCES projects (tenant_id, id),
  FOREIGN KEY (tenant_id, document_version_id) REFERENCES document_versions (tenant_id, id)
);
CREATE INDEX compliance_manual_marks_project_idx ON compliance_manual_marks (project_id, rule_code, marked_at DESC);
CREATE INDEX compliance_manual_marks_document_version_idx ON compliance_manual_marks (document_version_id);
CREATE TRIGGER compliance_manual_marks_immutable BEFORE UPDATE OR DELETE ON compliance_manual_marks FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

-- 6. Yapay zekâ kanıt önbelleği: aynı anahtar (kural, parametre, belge sha256'ları, model, istem sürümü) aynı çıktıyı verir. Değişmez.
CREATE TABLE compliance_ai_cache (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  cache_key text NOT NULL CHECK (length(cache_key) BETWEEN 16 AND 200),
  output jsonb NOT NULL CHECK (jsonb_typeof(output) = 'object'),
  provider text NOT NULL CHECK (length(btrim(provider)) BETWEEN 1 AND 200),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, cache_key)
);
CREATE TRIGGER compliance_ai_cache_immutable BEFORE UPDATE OR DELETE ON compliance_ai_cache FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

-- 7. RLS. Kural tabloları ve önbellek: kiracı, tedarikçi bağlamına kapalı.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['procurement_rule_sets','procurement_rules','compliance_ai_cache'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY scope ON %I USING (tenant_id = app_tenant_id() AND app_supplier_id() IS NULL) '
                   'WITH CHECK (tenant_id = app_tenant_id() AND app_supplier_id() IS NULL)', t);
  END LOOP;
END $$;

-- Proje kapsamlı denetim tabloları: kiracı + şirket (yazarken projenin şirketi), proje departmanı RESTRICTIVE.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['compliance_audits','compliance_manual_marks'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY scope ON %1$I '
                   'USING (tenant_id = app_tenant_id() AND company_id = ANY (app_company_ids()) AND app_supplier_id() IS NULL) '
                   'WITH CHECK (tenant_id = app_tenant_id() AND company_id = ANY (app_company_ids()) AND app_supplier_id() IS NULL '
                   'AND EXISTS (SELECT 1 FROM projects p WHERE p.id = %1$I.project_id AND p.company_id = %1$I.company_id))', t);
    EXECUTE format('CREATE POLICY dept ON %1$I AS RESTRICTIVE FOR ALL '
                   'USING (app_department_all() OR EXISTS (SELECT 1 FROM projects p WHERE p.id = %1$I.project_id)) '
                   'WITH CHECK (app_department_all() OR EXISTS (SELECT 1 FROM projects p WHERE p.id = %1$I.project_id))', t);
  END LOOP;
END $$;

-- Kural sonucu koşusunun görünürlüğünü devralır (koşu kendi kiracı/şirket/departman politikasıyla).
ALTER TABLE compliance_rule_results ENABLE ROW LEVEL SECURITY;
CREATE POLICY scope ON compliance_rule_results
  USING (tenant_id = app_tenant_id() AND app_supplier_id() IS NULL
         AND EXISTS (SELECT 1 FROM compliance_audits a WHERE a.id = compliance_rule_results.audit_id))
  WITH CHECK (tenant_id = app_tenant_id() AND app_supplier_id() IS NULL
              AND EXISTS (SELECT 1 FROM compliance_audits a WHERE a.id = compliance_rule_results.audit_id));

-- 8. En dar GRANT. Silme yalnız taslak setin kuralında (tetikleyici yayımlıyı reddeder).
GRANT SELECT, INSERT ON procurement_rule_sets TO sp_app;
GRANT UPDATE (status, effective_from, published_by, published_at) ON procurement_rule_sets TO sp_app;
GRANT SELECT, INSERT, DELETE ON procurement_rules TO sp_app;
GRANT UPDATE (code, name, description, check_type, check_key, params, scope_methods, min_amount, min_amount_currency, weight, mandatory, sort_order)
  ON procurement_rules TO sp_app;
GRANT SELECT, INSERT ON compliance_audits TO sp_app;
GRANT SELECT, INSERT ON compliance_rule_results TO sp_app;
GRANT SELECT, INSERT ON compliance_manual_marks TO sp_app;
GRANT SELECT, INSERT ON compliance_ai_cache TO sp_app;

-- 9. Belge yolu: uyum kanıtı (055) ve elle işaret belgesi projenin departmanını taşır. 048 (okuma, onaycı OR'lu) ve 050 (yazma)
--    işlevlerinin gövdesi aynen korunur; yalnız iki proje dalı eklenir.
CREATE OR REPLACE FUNCTION app_document_version_hidden(dv uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT dv IS NOT NULL AND (
    EXISTS (SELECT 1 FROM contract_versions cv JOIN contract_families f ON f.id = cv.family_id
            WHERE cv.document_version_id = dv AND NOT (coalesce(app_department_ok(f.department_id), false) OR app_is_contract_approver(f.id)))
    OR EXISTS (SELECT 1 FROM invoices i WHERE i.document_version_id = dv AND NOT coalesce(app_department_ok(i.department_id), false))
    OR EXISTS (SELECT 1 FROM assessment_answers aa JOIN supplier_assessments a ON a.id = aa.assessment_id
               WHERE aa.evidence_document_version_id = dv AND NOT coalesce(app_department_ok(a.department_id), false))
    OR EXISTS (SELECT 1 FROM signature_requirements x JOIN contract_versions cv ON cv.id = x.contract_version_id JOIN contract_families f ON f.id = cv.family_id
               WHERE x.document_version_id = dv AND NOT (coalesce(app_department_ok(f.department_id), false) OR app_is_contract_approver(f.id)))
    OR EXISTS (SELECT 1 FROM signature_detection_runs x JOIN contract_versions cv ON cv.id = x.contract_version_id JOIN contract_families f ON f.id = cv.family_id
               WHERE x.document_version_id = dv AND NOT (coalesce(app_department_ok(f.department_id), false) OR app_is_contract_approver(f.id)))
    OR EXISTS (SELECT 1 FROM signature_reviews x JOIN signature_requirements r ON r.id = x.requirement_id JOIN contract_versions cv ON cv.id = r.contract_version_id
               JOIN contract_families f ON f.id = cv.family_id WHERE x.document_version_id = dv AND NOT (coalesce(app_department_ok(f.department_id), false) OR app_is_contract_approver(f.id)))
    OR EXISTS (SELECT 1 FROM contract_guarantees x JOIN contract_versions cv ON cv.id = x.contract_version_id JOIN contract_families f ON f.id = cv.family_id
               WHERE x.document_version_id = dv AND NOT (coalesce(app_department_ok(f.department_id), false) OR app_is_contract_approver(f.id)))
    OR EXISTS (SELECT 1 FROM sla_measurements x JOIN sla_terms t ON t.id = x.sla_term_id JOIN contract_versions cv ON cv.id = t.contract_version_id
               JOIN contract_families f ON f.id = cv.family_id WHERE x.document_version_id = dv AND NOT (coalesce(app_department_ok(f.department_id), false) OR app_is_contract_approver(f.id)))
    OR EXISTS (SELECT 1 FROM compliance_evidence x JOIN projects p ON p.id = x.project_id
               WHERE x.document_version_id = dv AND NOT coalesce(app_department_ok(p.department_id), false))
    OR EXISTS (SELECT 1 FROM compliance_manual_marks x JOIN projects p ON p.id = x.project_id
               WHERE x.document_version_id = dv AND NOT coalesce(app_department_ok(p.department_id), false))
  )
$$;
REVOKE ALL ON FUNCTION app_document_version_hidden(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_document_version_hidden(uuid) TO sp_app;

CREATE OR REPLACE FUNCTION app_document_version_hidden_for_write(dv uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
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
    OR EXISTS (SELECT 1 FROM compliance_evidence x JOIN projects p ON p.id = x.project_id
               WHERE x.document_version_id = dv AND NOT coalesce(app_department_ok(p.department_id), false))
    OR EXISTS (SELECT 1 FROM compliance_manual_marks x JOIN projects p ON p.id = x.project_id
               WHERE x.document_version_id = dv AND NOT coalesce(app_department_ok(p.department_id), false))
  )
$$;
REVOKE ALL ON FUNCTION app_document_version_hidden_for_write(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_document_version_hidden_for_write(uuid) TO sp_app;
