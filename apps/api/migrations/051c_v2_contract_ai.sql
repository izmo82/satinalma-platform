-- v2 Faz 4 (R2–R4, R7–R10, R14) Görev 2: sözleşme yapay zekâ şeması. Dosya adı 051c: temiz veritabanında sıralı uygulamada
-- 048/050/050a/051/051a/051b'den (app_is_contract_approver, app_document_version_blocked_for_write) sonra çalışmalıdır.
-- Defter genişler (istem sürümü, token, yanıt modeli); okuma önerileri, değişmez inceleme kaydı ve bulguları, kanıt okuması ve kiracı
-- eşik ayarı eklenir. Hiçbir okunan değer contract_terms/contract_families'e yazılmaz (insan kaydı Faz 3 alan kaydıyla).
-- Görünürlük (karar 1): sözleşmeye bağlı tablolarda OKUMA = kiracı VE (aile departmanı uygun VEYA app_is_contract_approver(aile))
-- (contract_versions okumasıyla aynı); YAZMA = app_department_all() VEYA aile departmanı uygun (onaycı salt okur, 050 deseni).
-- Uygulanmış migration değiştirilmez; eski veri silinmez.

-- 1. Defter (R3). Görev kodları AI01–AI15; yeni sütunlar boş olabilir (eski satırlar).
ALTER TABLE ai_runs DROP CONSTRAINT ai_runs_task_check;
ALTER TABLE ai_runs ADD CONSTRAINT ai_runs_task_check CHECK (task ~ '^AI(0[1-9]|1[0-5])$');
ALTER TABLE ai_runs ADD COLUMN prompt_version text;
ALTER TABLE ai_runs ADD COLUMN input_tokens int CHECK (input_tokens >= 0);
ALTER TABLE ai_runs ADD COLUMN output_tokens int CHECK (output_tokens >= 0);
ALTER TABLE ai_runs ADD COLUMN response_model text;
-- Kiracı içi bileşik anahtarla bağlanabilsin diye.
ALTER TABLE ai_runs ADD CONSTRAINT ai_runs_tenant_id_id_key UNIQUE (tenant_id, id);
GRANT UPDATE (prompt_version, input_tokens, output_tokens, response_model) ON ai_runs TO sp_app;

-- 2. Platform kataloğu (R2). Anthropic fiyat tablosu, etkinleştirmeden önce platform operasyonu doğrular (verified_at NULL, kapalı).
-- Test sağlayıcısı satırı burada değil; yalnız NODE_ENV≠production seed'inde ve test kurulumunda eklenir.
INSERT INTO ai_models (provider, model_id, model_version, tasks, capabilities, context_tokens, max_output_tokens, approved_regions, retention_days,
                       trains_on_customer_data, price, verified_at, enabled)
VALUES ('anthropic', 'claude-sonnet-5-5', 'claude-sonnet-5-5', ARRAY['AI06','AI14','AI15'], '{"structuredOutput":true,"vision":true}', NULL, 16000,
        ARRAY['anthropic-api'], NULL, false, '{"unit":"TOKEN_1M","input":"2.00","output":"10.00","page":null,"currency":"USD"}', NULL, false)
ON CONFLICT DO NOTHING;

-- 3. Sözleşme alan okuması (R4–R6): alan başına öneri; karar insanındır. Güveni kod belirler; MISSING'de değer yoktur.
CREATE TABLE contract_extractions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  family_id uuid NOT NULL,
  document_version_id uuid NOT NULL,
  ai_run_id uuid NOT NULL,
  field text NOT NULL CHECK (field IN ('title','contractType','supplierName','supplierVkn','signedOn','startDate','endDate','indefinite',
    'noticePeriodDays','amount','currency','limitBasis','autoRenewal','contractNo','paymentTermDays','guarantee','slaPenalty','kvkkClause',
    'governingCourt','priceEscalation')),
  value text,
  page int CHECK (page > 0),
  evidence text,
  confidence text NOT NULL CHECK (confidence IN ('HIGH','MEDIUM','LOW','MISSING')),
  flags jsonb NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(flags) = 'array'),
  requires_human boolean NOT NULL,
  decision text NOT NULL DEFAULT 'PENDING' CHECK (decision IN ('PENDING','CONFIRMED','CORRECTED','REJECTED')),
  decided_by uuid REFERENCES users(id),
  decided_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (ai_run_id, field),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, family_id) REFERENCES contract_families (tenant_id, id),
  FOREIGN KEY (tenant_id, document_version_id) REFERENCES document_versions (tenant_id, id),
  FOREIGN KEY (tenant_id, ai_run_id) REFERENCES ai_runs (tenant_id, id),
  CHECK (confidence <> 'MISSING' OR value IS NULL),
  CHECK ((decision = 'PENDING') = (decided_by IS NULL) AND (decision = 'PENDING') = (decided_at IS NULL))
);
CREATE INDEX contract_extractions_family_idx ON contract_extractions (family_id);
CREATE INDEX contract_extractions_dv_idx ON contract_extractions (document_version_id);

-- 4. İnceleme (R7–R9): değişmez kayıt; yeni belge/şablon sürümü yeni kayıt açar, eskisi geçmişte kalır.
CREATE TABLE contract_reviews (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  family_id uuid NOT NULL,
  document_version_id uuid NOT NULL,
  template_version_id uuid,
  ai_run_id uuid NOT NULL UNIQUE,
  model_id text,
  prompt_version text NOT NULL,
  rubric_version text NOT NULL,
  score int NOT NULL CHECK (score BETWEEN 0 AND 100),
  sub_scores jsonb NOT NULL CHECK (jsonb_typeof(sub_scores) = 'object'),
  summary text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, family_id) REFERENCES contract_families (tenant_id, id),
  FOREIGN KEY (tenant_id, document_version_id) REFERENCES document_versions (tenant_id, id),
  FOREIGN KEY (tenant_id, template_version_id) REFERENCES contract_template_versions (tenant_id, id),
  FOREIGN KEY (tenant_id, ai_run_id) REFERENCES ai_runs (tenant_id, id)
);
CREATE INDEX contract_reviews_family_idx ON contract_reviews (family_id);
CREATE INDEX contract_reviews_dv_idx ON contract_reviews (document_version_id);

CREATE TABLE contract_review_findings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  review_id uuid NOT NULL,
  category text NOT NULL CHECK (category IN ('TEMPLATE','LIABILITY','PENALTY','TERMINATION','TERM_RENEWAL','CONFIDENTIALITY','IP','JURISDICTION',
    'FORCE_MAJEURE','PAYMENT','UNILATERAL_CHANGE')),
  kind text NOT NULL CHECK (kind IN ('MISSING_CLAUSE','MODIFIED_CLAUSE','UNFAVORABLE','EXTRA_CLAUSE','LEGAL_RISK')),
  severity text NOT NULL CHECK (severity IN ('HIGH','MEDIUM','LOW','INFO')),
  title text NOT NULL CHECK (length(btrim(title)) > 0),
  quote text,
  page int CHECK (page > 0),
  template_ref text,
  suggestion text,
  verified boolean NOT NULL,
  ord int NOT NULL CHECK (ord >= 0),
  UNIQUE (review_id, ord),
  FOREIGN KEY (tenant_id, review_id) REFERENCES contract_reviews (tenant_id, id)
);
CREATE TRIGGER contract_reviews_no_mutation BEFORE UPDATE OR DELETE ON contract_reviews FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
CREATE TRIGGER contract_review_findings_no_mutation BEFORE UPDATE OR DELETE ON contract_review_findings FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

-- 5. Kanıt belgesi okuması (R14, Faz 7 altyapısı). Ekran/uç yok; görünürlük belge sürümünden gelir.
CREATE TABLE ai_evidence_readings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  company_id uuid,
  document_version_id uuid NOT NULL,
  ai_run_id uuid NOT NULL UNIQUE,
  purpose text NOT NULL CHECK (length(btrim(purpose)) BETWEEN 1 AND 200),
  question_set jsonb NOT NULL CHECK (jsonb_typeof(question_set) = 'array'),
  result jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, document_version_id) REFERENCES document_versions (tenant_id, id),
  FOREIGN KEY (tenant_id, ai_run_id) REFERENCES ai_runs (tenant_id, id)
);
CREATE INDEX ai_evidence_readings_dv_idx ON ai_evidence_readings (document_version_id);
CREATE TRIGGER ai_evidence_readings_no_mutation BEFORE UPDATE OR DELETE ON ai_evidence_readings FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

-- 6. Kiracı eşik ayarı (R10). Satır yoksa uygulama varsayılanı 60.
CREATE TABLE contract_ai_settings (
  tenant_id uuid PRIMARY KEY REFERENCES tenants(id),
  review_threshold int NOT NULL DEFAULT 60 CHECK (review_threshold BETWEEN 0 AND 100),
  updated_by uuid REFERENCES users(id),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- 7. Tutarlılık: kayıt, kendi görev kodundaki ve aynı belge sürümündeki defter satırına; sözleşme kaydı belge sürümü o ailenin
-- bir sözleşme sürümüne bağlı olmalı. Sahip yetkisiyle okunur (RLS'ten bağımsız).
CREATE OR REPLACE FUNCTION contract_ai_record_consistent() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM ai_runs r WHERE r.id = NEW.ai_run_id AND r.tenant_id = NEW.tenant_id AND r.task = TG_ARGV[0]
                 AND r.document_version_id = NEW.document_version_id) THEN
    RAISE EXCEPTION 'inconsistent_record: %.ai_run_id', TG_TABLE_NAME USING ERRCODE = 'P0001';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM contract_versions v WHERE v.document_version_id = NEW.document_version_id AND v.family_id = NEW.family_id) THEN
    RAISE EXCEPTION 'inconsistent_record: %.document_version_id', TG_TABLE_NAME USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER contract_extractions_consistent BEFORE INSERT OR UPDATE OF tenant_id, family_id, document_version_id, ai_run_id ON contract_extractions
  FOR EACH ROW EXECUTE FUNCTION contract_ai_record_consistent('AI06');
CREATE TRIGGER contract_reviews_consistent BEFORE INSERT ON contract_reviews FOR EACH ROW EXECUTE FUNCTION contract_ai_record_consistent('AI14');
CREATE OR REPLACE FUNCTION ai_evidence_readings_consistent() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM ai_runs r WHERE r.id = NEW.ai_run_id AND r.tenant_id = NEW.tenant_id AND r.task = 'AI15'
                 AND r.document_version_id = NEW.document_version_id) THEN
    RAISE EXCEPTION 'inconsistent_record: ai_evidence_readings.ai_run_id' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER ai_evidence_readings_consistent BEFORE INSERT ON ai_evidence_readings FOR EACH ROW EXECUTE FUNCTION ai_evidence_readings_consistent();

-- 8. RLS. Aile alt sorgusu ailenin kendi politikasını (kiracı + şirket + departman VEYA onaycı; tedarikçi bağlamı kapalı) da uygular.
ALTER TABLE contract_extractions ENABLE ROW LEVEL SECURITY;
CREATE POLICY read ON contract_extractions FOR SELECT
  USING (tenant_id = app_tenant_id() AND EXISTS (SELECT 1 FROM contract_families f WHERE f.id = contract_extractions.family_id
         AND (app_department_ok(f.department_id) OR app_is_contract_approver(f.id))));
CREATE POLICY add ON contract_extractions FOR INSERT
  WITH CHECK (tenant_id = app_tenant_id() AND EXISTS (SELECT 1 FROM contract_families f WHERE f.id = contract_extractions.family_id
              AND (app_department_all() OR coalesce(app_department_ok(f.department_id), false))));
CREATE POLICY change ON contract_extractions FOR UPDATE
  USING (tenant_id = app_tenant_id() AND EXISTS (SELECT 1 FROM contract_families f WHERE f.id = contract_extractions.family_id
         AND (app_department_all() OR coalesce(app_department_ok(f.department_id), false))))
  WITH CHECK (tenant_id = app_tenant_id() AND EXISTS (SELECT 1 FROM contract_families f WHERE f.id = contract_extractions.family_id
              AND (app_department_all() OR coalesce(app_department_ok(f.department_id), false))));

ALTER TABLE contract_reviews ENABLE ROW LEVEL SECURITY;
CREATE POLICY read ON contract_reviews FOR SELECT
  USING (tenant_id = app_tenant_id() AND EXISTS (SELECT 1 FROM contract_families f WHERE f.id = contract_reviews.family_id
         AND (app_department_ok(f.department_id) OR app_is_contract_approver(f.id))));
CREATE POLICY add ON contract_reviews FOR INSERT
  WITH CHECK (tenant_id = app_tenant_id() AND EXISTS (SELECT 1 FROM contract_families f WHERE f.id = contract_reviews.family_id
              AND (app_department_all() OR coalesce(app_department_ok(f.department_id), false))));

ALTER TABLE contract_review_findings ENABLE ROW LEVEL SECURITY;
CREATE POLICY read ON contract_review_findings FOR SELECT
  USING (tenant_id = app_tenant_id() AND EXISTS (SELECT 1 FROM contract_reviews r WHERE r.id = contract_review_findings.review_id));
CREATE POLICY add ON contract_review_findings FOR INSERT
  WITH CHECK (tenant_id = app_tenant_id() AND EXISTS (SELECT 1 FROM contract_reviews r JOIN contract_families f ON f.id = r.family_id
              WHERE r.id = contract_review_findings.review_id AND (app_department_all() OR coalesce(app_department_ok(f.department_id), false))));

-- Kanıt okuması: kiracı + şirket + iç bağlam; okuma belge sürümünün görünürlüğünü (document_versions politikası, onaycı dahil) devralır,
-- yazma 050'deki belge yolu yazma kuralıyla (onaycı OR'u olmadan).
ALTER TABLE ai_evidence_readings ENABLE ROW LEVEL SECURITY;
CREATE POLICY read ON ai_evidence_readings FOR SELECT
  USING (tenant_id = app_tenant_id() AND app_supplier_id() IS NULL AND (company_id IS NULL OR company_id = ANY (app_company_ids()))
         AND EXISTS (SELECT 1 FROM document_versions v WHERE v.id = ai_evidence_readings.document_version_id));
CREATE POLICY add ON ai_evidence_readings FOR INSERT
  WITH CHECK (tenant_id = app_tenant_id() AND app_supplier_id() IS NULL AND (company_id IS NULL OR company_id = ANY (app_company_ids()))
              AND EXISTS (SELECT 1 FROM document_versions v WHERE v.id = ai_evidence_readings.document_version_id)
              AND (app_department_all() OR NOT app_document_version_blocked_for_write(document_version_id)));

ALTER TABLE contract_ai_settings ENABLE ROW LEVEL SECURITY;
CREATE POLICY scope ON contract_ai_settings USING (tenant_id = app_tenant_id() AND app_supplier_id() IS NULL)
  WITH CHECK (tenant_id = app_tenant_id() AND app_supplier_id() IS NULL);

-- 9. En dar GRANT. İnceleme, bulgu ve kanıt okuması değişmez (yalnız SELECT, INSERT).
GRANT SELECT, INSERT ON contract_extractions TO sp_app;
GRANT UPDATE (decision, decided_by, decided_at) ON contract_extractions TO sp_app;
GRANT SELECT, INSERT ON contract_reviews TO sp_app;
GRANT SELECT, INSERT ON contract_review_findings TO sp_app;
GRANT SELECT, INSERT ON ai_evidence_readings TO sp_app;
GRANT SELECT, INSERT ON contract_ai_settings TO sp_app;
GRANT UPDATE (review_threshold, updated_by, updated_at) ON contract_ai_settings TO sp_app;
