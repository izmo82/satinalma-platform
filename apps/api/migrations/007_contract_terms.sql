-- 007 Faz 3 kalan: sözleşme koşulları (bedel/tavan, süre, ihbar kuralı), resmî tatiller, yükümlülükler,
-- yenileme kararı. Kayıtlar değişmez; değişiklik yeni revizyon, karar insan kaydıdır. Durumlar türetilir.

-- Koşullar sözleşme sürümüne bağlıdır; aynı sürümde düzeltme yeni revizyon ve yeniden doğrulama ister.
CREATE TABLE contract_terms (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  company_id uuid NOT NULL,
  contract_version_id uuid NOT NULL,
  revision int NOT NULL,
  currency char(3) NOT NULL,
  value_type text NOT NULL CHECK (value_type IN ('FIXED','CEILING','UNPRICED')),
  amount numeric(20,2),
  payment_terms text NOT NULL DEFAULT '',
  start_date date,
  end_date date,
  auto_renewal boolean NOT NULL DEFAULT false,
  renewal_months int CHECK (renewal_months IS NULL OR renewal_months BETWEEN 1 AND 120),
  notice_amount int CHECK (notice_amount IS NULL OR notice_amount BETWEEN 0 AND 3650),
  notice_unit text CHECK (notice_unit IN ('DAY','MONTH')),
  non_working_day_rule text NOT NULL DEFAULT 'PREVIOUS_WORKING_DAY' CHECK (non_working_day_rule IN ('PREVIOUS_WORKING_DAY','AS_IS')),
  -- Tarihin ve bedelin dayandığı madde/sayfa (UX09 "tarihin kaynak maddesi").
  source_ref text NOT NULL CHECK (length(source_ref) >= 3),
  change_reason text,
  entered_by uuid NOT NULL REFERENCES users(id),
  entered_at timestamptz NOT NULL DEFAULT now(),
  verified_by uuid REFERENCES users(id),
  verified_at timestamptz,
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, contract_version_id, revision),
  FOREIGN KEY (tenant_id, contract_version_id) REFERENCES contract_versions (tenant_id, id),
  CHECK ((value_type = 'UNPRICED') = (amount IS NULL)),
  CHECK ((notice_amount IS NULL) = (notice_unit IS NULL)),
  CHECK (notice_amount IS NULL OR end_date IS NOT NULL),
  CHECK (end_date IS NULL OR start_date IS NULL OR end_date >= start_date),
  -- Hukuk doğrulaması giren kişiden bağımsızdır (BR03).
  CHECK (verified_by IS NULL OR verified_by <> entered_by)
);
-- sp_app yalnız doğrulama sütunlarını güncelleyebilir; doğrulanmış koşul bir daha değişmez, silinmez.
CREATE OR REPLACE FUNCTION contract_terms_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' OR OLD.verified_by IS NOT NULL THEN
    RAISE EXCEPTION 'immutable_record: contract_terms' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER contract_terms_guard BEFORE UPDATE OR DELETE ON contract_terms FOR EACH ROW EXECUTE FUNCTION contract_terms_guard();

-- Resmî tatil ve kurum tatilleri kiracı verisidir (dini bayram tarihleri her yıl değişir; uydurulmaz, girilir).
CREATE TABLE tenant_holidays (
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  day date NOT NULL,
  name text NOT NULL,
  created_by uuid REFERENCES users(id),
  PRIMARY KEY (tenant_id, day)
);

CREATE TABLE contract_obligations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  company_id uuid NOT NULL,
  contract_version_id uuid NOT NULL,
  title text NOT NULL CHECK (length(title) BETWEEN 3 AND 300),
  counterparty text NOT NULL CHECK (counterparty IN ('BUYER','SUPPLIER')),
  -- Sahip yoksa yükümlülük satınalma yöneticisinin iş listesine düşer (02 §31).
  owner_role text,
  first_due date NOT NULL,
  recurrence text NOT NULL DEFAULT 'NONE' CHECK (recurrence IN ('NONE','MONTHLY','QUARTERLY','YEARLY')),
  until date,
  evidence_required boolean NOT NULL DEFAULT true,
  source_ref text NOT NULL CHECK (length(source_ref) >= 3),
  created_by uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  retired_at timestamptz,
  retired_reason text,
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, contract_version_id) REFERENCES contract_versions (tenant_id, id),
  CHECK (until IS NULL OR until >= first_due),
  CHECK ((retired_at IS NULL) = (retired_reason IS NULL))
);

-- Her dönem için tek sonuç; düzeltme ters kayıt değil yeni karar değildir: sonuç değişmez (BR11).
CREATE TABLE obligation_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  company_id uuid NOT NULL,
  obligation_id uuid NOT NULL,
  due_date date NOT NULL,
  outcome text NOT NULL CHECK (outcome IN ('FULFILLED','MISSED','WAIVED')),
  note text NOT NULL CHECK (length(note) >= 5),
  evidence text,
  recorded_by uuid NOT NULL REFERENCES users(id),
  recorded_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, obligation_id, due_date),
  FOREIGN KEY (tenant_id, obligation_id) REFERENCES contract_obligations (tenant_id, id)
);

-- Yenileme/fesih kararı: koşul revizyonuna bağlı insan kararı; ihbar görevlerini kapatır.
CREATE TABLE renewal_decisions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  company_id uuid NOT NULL,
  contract_version_id uuid NOT NULL,
  terms_id uuid NOT NULL,
  decision text NOT NULL CHECK (decision IN ('RENEW','TERMINATE','RENEGOTIATE')),
  rationale text NOT NULL CHECK (length(rationale) >= 10),
  decided_by uuid NOT NULL REFERENCES users(id),
  decided_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, terms_id),
  FOREIGN KEY (tenant_id, terms_id) REFERENCES contract_terms (tenant_id, id)
);

CREATE TRIGGER obligation_events_immutable BEFORE UPDATE OR DELETE ON obligation_events FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
CREATE TRIGGER renewal_decisions_immutable BEFORE UPDATE OR DELETE ON renewal_decisions FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['contract_terms','contract_obligations','obligation_events','renewal_decisions'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY scope ON %I USING (tenant_id = app_tenant_id() AND company_id = ANY (app_company_ids())) '
                   'WITH CHECK (tenant_id = app_tenant_id() AND company_id = ANY (app_company_ids()))', t);
    EXECUTE format('GRANT SELECT, INSERT ON %I TO sp_app', t);
  END LOOP;
END $$;
GRANT UPDATE (verified_by, verified_at) ON contract_terms TO sp_app;
GRANT UPDATE (retired_at, retired_reason) ON contract_obligations TO sp_app;

ALTER TABLE tenant_holidays ENABLE ROW LEVEL SECURITY;
CREATE POLICY scope ON tenant_holidays USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id());
GRANT SELECT, INSERT ON tenant_holidays TO sp_app;
