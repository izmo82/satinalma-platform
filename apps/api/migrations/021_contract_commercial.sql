-- Faz 3 kalanları (02 §11, FR08–FR09): endeksli fiyat revizyonu, SLA ceza/kredi hesabı, teminat takibi.
-- Hesap kuralları sözleşme maddesinden girilir; hesap sonucu ikinci kişi onayı/doğrulaması olmadan kesinleşmez (görev ayrılığı).
-- Kayıtlar değişmez; yalnız onay/doğrulama/iade alanları bir kez doldurulur.

CREATE TABLE price_revision_rules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  company_id uuid NOT NULL,
  contract_version_id uuid NOT NULL,
  index_name text NOT NULL CHECK (length(btrim(index_name)) BETWEEN 2 AND 120),
  base_index numeric(20,6) NOT NULL CHECK (base_index > 0),
  base_period date NOT NULL,
  period text NOT NULL CHECK (period IN ('MONTHLY','QUARTERLY','YEARLY')),
  cap_percent numeric(9,4) CHECK (cap_percent IS NULL OR cap_percent >= 0),
  floor_percent numeric(9,4) CHECK (floor_percent IS NULL OR floor_percent BETWEEN 0 AND 100),
  source_ref text NOT NULL CHECK (length(btrim(source_ref)) >= 2),
  created_by uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  retired_at timestamptz,
  retired_reason text,
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, company_id) REFERENCES legal_entities(tenant_id, id),
  FOREIGN KEY (tenant_id, contract_version_id) REFERENCES contract_versions(tenant_id, id),
  CHECK ((retired_at IS NULL) = (retired_reason IS NULL))
);
-- Sürüm başına tek yürürlükteki kural.
CREATE UNIQUE INDEX price_revision_rules_active ON price_revision_rules (contract_version_id) WHERE retired_at IS NULL;

CREATE TABLE price_revisions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  company_id uuid NOT NULL,
  rule_id uuid NOT NULL,
  effective_from date NOT NULL,
  index_value numeric(20,6) NOT NULL CHECK (index_value > 0),
  index_source text NOT NULL CHECK (length(btrim(index_source)) >= 2),
  raw_change_percent numeric(12,4) NOT NULL,
  applied_change_percent numeric(12,4) NOT NULL,
  factor numeric(12,6) NOT NULL CHECK (factor > 0),
  proposed_by uuid NOT NULL REFERENCES users(id),
  proposed_at timestamptz NOT NULL DEFAULT now(),
  approved_by uuid REFERENCES users(id),
  approved_at timestamptz,
  UNIQUE (tenant_id, rule_id, effective_from),
  FOREIGN KEY (tenant_id, rule_id) REFERENCES price_revision_rules(tenant_id, id),
  CHECK ((approved_by IS NULL) = (approved_at IS NULL)),
  CHECK (approved_by IS NULL OR approved_by <> proposed_by)
);

CREATE TABLE sla_terms (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  company_id uuid NOT NULL,
  contract_version_id uuid NOT NULL,
  name text NOT NULL CHECK (length(btrim(name)) BETWEEN 2 AND 160),
  unit text NOT NULL CHECK (length(btrim(unit)) BETWEEN 1 AND 30),
  direction text NOT NULL CHECK (direction IN ('MIN','MAX')),
  target numeric(20,6) NOT NULL,
  period_fee numeric(20,2) NOT NULL CHECK (period_fee >= 0),
  currency char(3) NOT NULL,
  tiers jsonb NOT NULL CHECK (jsonb_typeof(tiers) = 'array' AND jsonb_array_length(tiers) BETWEEN 1 AND 10),
  cap_percent numeric(9,4) CHECK (cap_percent IS NULL OR cap_percent BETWEEN 0 AND 100),
  source_ref text NOT NULL CHECK (length(btrim(source_ref)) >= 2),
  created_by uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  retired_at timestamptz,
  retired_reason text,
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, company_id) REFERENCES legal_entities(tenant_id, id),
  FOREIGN KEY (tenant_id, contract_version_id) REFERENCES contract_versions(tenant_id, id),
  CHECK ((retired_at IS NULL) = (retired_reason IS NULL))
);

-- Dönem ölçümü: aynı SLA ve dönem için tek kayıt (aynı ihlal iki kez kredi doğurmaz). Kredi doğrulanana kadar taslaktır.
CREATE TABLE sla_measurements (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  company_id uuid NOT NULL,
  sla_term_id uuid NOT NULL,
  period_start date NOT NULL,
  measured numeric(20,6) NOT NULL,
  evidence text NOT NULL CHECK (length(btrim(evidence)) >= 5),
  document_version_id uuid,
  breached boolean NOT NULL,
  credit_percent numeric(9,4) NOT NULL,
  credit_amount numeric(20,2) NOT NULL CHECK (credit_amount >= 0),
  entered_by uuid NOT NULL REFERENCES users(id),
  entered_at timestamptz NOT NULL DEFAULT now(),
  verified_by uuid REFERENCES users(id),
  verified_at timestamptz,
  rejected_by uuid REFERENCES users(id),
  rejected_at timestamptz,
  rejected_reason text,
  FOREIGN KEY (tenant_id, sla_term_id) REFERENCES sla_terms(tenant_id, id),
  FOREIGN KEY (tenant_id, document_version_id) REFERENCES document_versions(tenant_id, id),
  CHECK ((verified_by IS NULL) = (verified_at IS NULL)),
  CHECK (verified_by IS NULL OR verified_by <> entered_by),
  CHECK ((rejected_by IS NULL) = (rejected_at IS NULL) AND (rejected_at IS NULL) = (rejected_reason IS NULL)),
  CHECK (rejected_by IS NULL OR rejected_by <> entered_by),
  CHECK (verified_by IS NULL OR rejected_by IS NULL)
);
-- Reddedilen ölçümün yerine aynı dönem için yeni ölçüm girilebilir; geçerli (reddedilmemiş) ölçüm dönem başına tektir.
CREATE UNIQUE INDEX sla_measurements_one_per_period ON sla_measurements (sla_term_id, period_start) WHERE rejected_at IS NULL;

CREATE TABLE contract_guarantees (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  company_id uuid NOT NULL,
  contract_version_id uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN ('PERFORMANCE','ADVANCE','WARRANTY','CASH','OTHER')),
  amount numeric(20,2) NOT NULL CHECK (amount > 0),
  currency char(3) NOT NULL,
  issuer text NOT NULL CHECK (length(btrim(issuer)) >= 2),
  reference_no text NOT NULL CHECK (length(btrim(reference_no)) >= 1),
  valid_until date,
  document_version_id uuid,
  received_by uuid NOT NULL REFERENCES users(id),
  received_at timestamptz NOT NULL DEFAULT now(),
  returned_by uuid REFERENCES users(id),
  returned_at timestamptz,
  return_note text,
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, company_id) REFERENCES legal_entities(tenant_id, id),
  FOREIGN KEY (tenant_id, contract_version_id) REFERENCES contract_versions(tenant_id, id),
  FOREIGN KEY (tenant_id, document_version_id) REFERENCES document_versions(tenant_id, id),
  CHECK ((returned_at IS NULL) = (returned_by IS NULL) AND (returned_at IS NULL) = (return_note IS NULL))
);

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['price_revision_rules','price_revisions','sla_terms','sla_measurements','contract_guarantees'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY scope ON %I USING (tenant_id = app_tenant_id() AND company_id = ANY (app_company_ids())) '
                   'WITH CHECK (tenant_id = app_tenant_id() AND company_id = ANY (app_company_ids()))', t);
    EXECUTE format('GRANT SELECT, INSERT ON %I TO sp_app', t);
  END LOOP;
END $$;
GRANT UPDATE (retired_at, retired_reason) ON price_revision_rules TO sp_app;
GRANT UPDATE (approved_by, approved_at) ON price_revisions TO sp_app;
GRANT UPDATE (retired_at, retired_reason) ON sla_terms TO sp_app;
GRANT UPDATE (verified_by, verified_at, rejected_by, rejected_at, rejected_reason) ON sla_measurements TO sp_app;
GRANT UPDATE (returned_by, returned_at, return_note) ON contract_guarantees TO sp_app;
