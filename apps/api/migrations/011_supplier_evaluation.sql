-- 011 Faz 5: tedarikçi değerlendirmesi (02 §8–9). Anket şablonu (sürümlü), değerlendirme ve yanıt/kanıt, içsel/kalan risk,
-- olay (iddia ≠ doğrulanmış bulgu), itiraz, düzeltici faaliyet, dönemsel performans incelemesi. Tedarikçi kiracı düzeyindedir;
-- bu tablolar da kiracı kapsamlıdır (RLS). Standart metinleri kopyalanmaz; yalnız kontrol referansı ve kurum kendi soru metni.

CREATE TABLE questionnaire_templates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  code text NOT NULL,
  version int NOT NULL CHECK (version > 0),
  name text NOT NULL,
  -- Hizmet/kategori: aynı firma temizlik ve ayrıcalıklı BT erişimi için aynı anketi doldurmaz.
  category text NOT NULL,
  status text NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT','PUBLISHED','RETIRED')),
  created_by uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  published_by uuid REFERENCES users(id),
  published_at timestamptz,
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, code, version)
);
CREATE TABLE questionnaire_questions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  template_id uuid NOT NULL,
  ordinal int NOT NULL,
  control_id text NOT NULL,
  -- Standart referansı (ör. "ISO/IEC 27036-2 kapsamında tedarikçi erişimi"); madde eşlemesi uzman onayına tabidir.
  reference text NOT NULL,
  text text NOT NULL,
  critical boolean NOT NULL DEFAULT false,
  evidence_required boolean NOT NULL DEFAULT false,
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, template_id, ordinal),
  FOREIGN KEY (tenant_id, template_id) REFERENCES questionnaire_templates (tenant_id, id)
);

CREATE TABLE supplier_assessments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  supplier_id uuid NOT NULL,
  template_id uuid NOT NULL,
  scope text NOT NULL CHECK (length(scope) >= 3),
  status text NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN','REVIEWED','SUPERSEDED')),
  -- İçsel risk faktörleri (veri hassasiyeti, erişim, kritiklik, ikame edilebilirlik, alt yüklenici bağımlılığı): LOW/MEDIUM/HIGH.
  inherent_factors jsonb NOT NULL,
  -- Kalan risk: risk sahibinin gerekçeyle kabul ettiği seviye; belgesiz yüzde indirimiyle otomatik düşmez.
  residual_level text CHECK (residual_level IN ('LOW','MEDIUM','HIGH','CRITICAL')),
  residual_reason text,
  residual_accepted_by uuid REFERENCES users(id),
  residual_accepted_at timestamptz,
  review_due date,
  created_by uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  reviewed_by uuid REFERENCES users(id),
  reviewed_at timestamptz,
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, supplier_id) REFERENCES suppliers (tenant_id, id),
  FOREIGN KEY (tenant_id, template_id) REFERENCES questionnaire_templates (tenant_id, id),
  CHECK ((residual_level IS NULL) = (residual_accepted_by IS NULL)),
  CHECK (residual_level IS NULL OR length(coalesce(residual_reason, '')) >= 20),
  -- Kalan riski kabul eden, değerlendirmeyi açan kişi olamaz (görev ayrılığı).
  CHECK (residual_accepted_by IS NULL OR residual_accepted_by <> created_by)
);
CREATE TABLE assessment_answers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  assessment_id uuid NOT NULL,
  question_id uuid NOT NULL,
  response text NOT NULL CHECK (response IN ('YES','PARTIAL','NO','NOT_APPLICABLE','UNKNOWN')),
  na_reason text,
  note text,
  evidence_document_version_id uuid,
  evidence_date date,
  evidence_expires date,
  answered_by uuid NOT NULL REFERENCES users(id),
  answered_at timestamptz NOT NULL DEFAULT now(),
  review text CHECK (review IN ('ACCEPTED','FINDING')),
  finding_severity text CHECK (finding_severity IN ('LOW','MEDIUM','HIGH','CRITICAL')),
  finding_note text,
  reviewed_by uuid REFERENCES users(id),
  reviewed_at timestamptz,
  UNIQUE (tenant_id, assessment_id, question_id),
  FOREIGN KEY (tenant_id, assessment_id) REFERENCES supplier_assessments (tenant_id, id),
  FOREIGN KEY (tenant_id, question_id) REFERENCES questionnaire_questions (tenant_id, id),
  -- "Uygulanamaz" gerekçesiz kabul edilmez.
  CHECK (response <> 'NOT_APPLICABLE' OR length(coalesce(na_reason, '')) >= 10),
  CHECK ((review = 'FINDING') = (finding_severity IS NOT NULL)),
  CHECK (evidence_expires IS NULL OR evidence_date IS NULL OR evidence_expires >= evidence_date)
);

-- Olay: iddia ile doğrulanmış bulgu ayrı statüdür. Puan etkisi yalnız doğrulanmış, itirazı açık olmayan, mükerrer olmayan olaylara.
CREATE TABLE supplier_incidents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  code text NOT NULL,
  supplier_id uuid NOT NULL,
  contract_version_id uuid,
  po_id uuid,
  category text NOT NULL CHECK (category IN ('QUALITY','DELAY','OUTAGE','SLA','INVOICE_DISPUTE','SECURITY','PERSONAL_DATA','ETHICS')),
  severity text NOT NULL CHECK (severity IN ('LOW','MEDIUM','HIGH','CRITICAL')),
  title text NOT NULL CHECK (length(title) >= 5),
  description text NOT NULL,
  impact text,
  location text,
  occurred_on date NOT NULL,
  status text NOT NULL DEFAULT 'REPORTED' CHECK (status IN ('REPORTED','UNDER_REVIEW','VERIFIED','REJECTED','CLOSED')),
  -- Tedarikçi itirazı açıkken olay kesinleşmiş sayılmaz (T19).
  dispute_open boolean NOT NULL DEFAULT false,
  duplicate_of_id uuid,
  -- SLA ölçümüne zaten yansımış olay ayrıca puan cezası almaz (çift sayım yok, T19).
  counted_in_metric boolean NOT NULL DEFAULT false,
  reported_by uuid NOT NULL REFERENCES users(id),
  reported_at timestamptz NOT NULL DEFAULT now(),
  verified_by uuid REFERENCES users(id),
  verified_at timestamptz,
  closed_by uuid REFERENCES users(id),
  closed_at timestamptz,
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, code),
  FOREIGN KEY (tenant_id, supplier_id) REFERENCES suppliers (tenant_id, id),
  FOREIGN KEY (tenant_id, contract_version_id) REFERENCES contract_versions (tenant_id, id),
  FOREIGN KEY (tenant_id, po_id) REFERENCES purchase_orders (tenant_id, id),
  FOREIGN KEY (tenant_id, duplicate_of_id) REFERENCES supplier_incidents (tenant_id, id),
  -- Bildiren kendi bildirimini doğrulayamaz.
  CHECK (verified_by IS NULL OR verified_by <> reported_by),
  CHECK (duplicate_of_id IS NULL OR duplicate_of_id <> id)
);
-- Olay zaman çizelgesi: değişmez. İtiraz ve yeniden inceleme önceki kaydı silmez.
CREATE TABLE incident_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  incident_id uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN ('REPORTED','REVIEW_STARTED','VERIFIED','REJECTED','DISPUTED','DISPUTE_RESOLVED','DUPLICATE','CLOSED','REOPENED','NOTE')),
  from_status text,
  to_status text,
  note text,
  evidence_document_version_id uuid,
  actor uuid NOT NULL REFERENCES users(id),
  at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, incident_id) REFERENCES supplier_incidents (tenant_id, id)
);
CREATE TABLE corrective_actions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  incident_id uuid NOT NULL,
  title text NOT NULL CHECK (length(title) >= 5),
  owner_role text NOT NULL,
  due_date date NOT NULL,
  status text NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN','DONE','VERIFIED')),
  done_note text,
  done_by uuid REFERENCES users(id),
  done_at timestamptz,
  verified_by uuid REFERENCES users(id),
  verified_at timestamptz,
  created_by uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, incident_id) REFERENCES supplier_incidents (tenant_id, id),
  -- Bağımsız kapanış: faaliyeti tamamlayan kişi doğrulayamaz.
  CHECK (verified_by IS NULL OR verified_by <> done_by)
);

-- Dönemsel performans incelemesi: boyut puanları (0–100) ve gerekçe; ağırlıklar politika sürümüyle saklanır.
CREATE TABLE performance_reviews (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  supplier_id uuid NOT NULL,
  period_start date NOT NULL,
  period_end date NOT NULL,
  category text NOT NULL,
  policy_version text NOT NULL,
  weights jsonb NOT NULL,
  scores jsonb NOT NULL,
  basis text NOT NULL CHECK (length(basis) >= 10),
  reviewed_by uuid NOT NULL REFERENCES users(id),
  reviewed_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, supplier_id) REFERENCES suppliers (tenant_id, id),
  CHECK (period_end >= period_start)
);

CREATE TRIGGER incident_events_immutable BEFORE UPDATE OR DELETE ON incident_events FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
CREATE TRIGGER performance_reviews_immutable BEFORE UPDATE OR DELETE ON performance_reviews FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
CREATE TRIGGER questionnaire_questions_immutable BEFORE UPDATE OR DELETE ON questionnaire_questions FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

-- Yayımlanmış şablona soru eklenemez (sürüm değişmez; değişiklik yeni sürümdür).
CREATE OR REPLACE FUNCTION questions_template_draft() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (SELECT status FROM questionnaire_templates WHERE id = NEW.template_id) <> 'DRAFT' THEN
    RAISE EXCEPTION 'template_not_draft' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER questions_template_draft BEFORE INSERT ON questionnaire_questions FOR EACH ROW EXECUTE FUNCTION questions_template_draft();

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['questionnaire_templates','questionnaire_questions','supplier_assessments','assessment_answers',
    'supplier_incidents','incident_events','corrective_actions','performance_reviews'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY scope ON %I USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id())', t);
    EXECUTE format('GRANT SELECT, INSERT ON %I TO sp_app', t);
  END LOOP;
END $$;
GRANT UPDATE (status, published_by, published_at) ON questionnaire_templates TO sp_app;
GRANT UPDATE (status, residual_level, residual_reason, residual_accepted_by, residual_accepted_at, review_due, reviewed_by, reviewed_at) ON supplier_assessments TO sp_app;
GRANT UPDATE (response, na_reason, note, evidence_document_version_id, evidence_date, evidence_expires, answered_by, answered_at,
  review, finding_severity, finding_note, reviewed_by, reviewed_at) ON assessment_answers TO sp_app;
GRANT UPDATE (status, dispute_open, duplicate_of_id, counted_in_metric, severity, verified_by, verified_at, closed_by, closed_at) ON supplier_incidents TO sp_app;
GRANT UPDATE (status, done_note, done_by, done_at, verified_by, verified_at) ON corrective_actions TO sp_app;
