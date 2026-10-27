-- 002 Tedarikçi ana verisi, aday havuzu, banka değişikliği ve asenkron iş/outbox altyapısı.

CREATE TABLE suppliers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  status text NOT NULL DEFAULT 'CANDIDATE'
    CHECK (status IN ('CANDIDATE','CONDITIONAL','ACTIVE','SUSPENDED','ARCHIVED','REJECTED','MERGED')),
  country char(2) NOT NULL DEFAULT 'TR',
  tax_id_type text CHECK (tax_id_type IN ('VKN','TCKN','FOREIGN')),
  -- Normalize edilmiş string; baştaki sıfır korunur. Kimlik doğrulanmadıysa NULL (kesin anahtar yok).
  tax_id text,
  legal_name text NOT NULL,
  identity_review_required boolean NOT NULL DEFAULT false,
  merged_into_id uuid REFERENCES suppliers(id),
  rejection_reason text,
  created_by uuid REFERENCES users(id),
  activated_by uuid REFERENCES users(id),
  activated_at timestamptz,
  row_version int NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  CHECK ((tax_id IS NULL) = (tax_id_type IS NULL)),
  -- BR03/T07: adayı açan kişi aktifleştiremez; uygulama atlansa da DB reddeder.
  CHECK (activated_by IS NULL OR created_by IS NULL OR activated_by <> created_by),
  CHECK (status NOT IN ('ACTIVE','CONDITIONAL') OR (tax_id IS NOT NULL AND activated_by IS NOT NULL))
);
-- T04: aynı kiracıda aynı ülke+tür+kimlik için tek kayıt; eşzamanlı yüklemede atomik.
CREATE UNIQUE INDEX suppliers_identity ON suppliers (tenant_id, country, tax_id_type, tax_id)
  WHERE tax_id IS NOT NULL;

CREATE TABLE supplier_document_links (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  supplier_id uuid NOT NULL,
  company_id uuid NOT NULL,
  document_version_id uuid NOT NULL,
  party_role text NOT NULL CHECK (party_role IN ('SELLER','CONTRACT_PARTY')),
  extracted_name text,
  name_mismatch boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, document_version_id, supplier_id),
  FOREIGN KEY (tenant_id, supplier_id) REFERENCES suppliers (tenant_id, id),
  FOREIGN KEY (tenant_id, document_version_id) REFERENCES document_versions (tenant_id, id)
);

CREATE TABLE supplier_approvals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  supplier_id uuid NOT NULL,
  approval_kind text NOT NULL CHECK (approval_kind IN ('MASTER_DATA','SECURITY','FINANCE')),
  decision text NOT NULL CHECK (decision IN ('APPROVED','REJECTED')),
  approver_id uuid NOT NULL REFERENCES users(id),
  supplier_row_version int NOT NULL,
  rationale text NOT NULL,
  at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, supplier_id) REFERENCES suppliers (tenant_id, id)
);
CREATE TRIGGER supplier_approvals_immutable BEFORE UPDATE OR DELETE ON supplier_approvals
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

CREATE TABLE supplier_bank_accounts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  supplier_id uuid NOT NULL,
  iban text NOT NULL,
  currency char(3) NOT NULL DEFAULT 'TRY',
  status text NOT NULL CHECK (status IN ('VERIFIED','RETIRED')),
  verified_by uuid REFERENCES users(id),
  second_approver_id uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, supplier_id) REFERENCES suppliers (tenant_id, id),
  CHECK (verified_by IS NULL OR second_approver_id IS NULL OR verified_by <> second_approver_id)
);

-- T08: OCR/belge kaynaklı farklı IBAN yalnız değişiklik talebi açar; mevcut hesabı değiştirmez.
CREATE TABLE bank_change_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  supplier_id uuid NOT NULL,
  proposed_iban text NOT NULL,
  source text NOT NULL CHECK (source IN ('DOCUMENT_EXTRACTION','MANUAL')),
  source_document_version_id uuid,
  status text NOT NULL DEFAULT 'PENDING_VERIFICATION'
    CHECK (status IN ('PENDING_VERIFICATION','APPROVED','REJECTED')),
  requested_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, supplier_id) REFERENCES suppliers (tenant_id, id)
);
CREATE UNIQUE INDEX bank_change_pending_unique ON bank_change_requests (tenant_id, supplier_id, proposed_iban)
  WHERE status = 'PENDING_VERIFICATION';

-- Asenkron iş kuyruğu (OCR, imza tespiti, önizleme, entegrasyon). Bulutta worker konteynerleri
-- FOR UPDATE SKIP LOCKED ile çeker; idempotency anahtarı aynı işin iki kez açılmasını engeller.
CREATE TABLE jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  company_id uuid,
  kind text NOT NULL,
  idempotency_key text NOT NULL,
  status text NOT NULL DEFAULT 'QUEUED'
    CHECK (status IN ('QUEUED','RUNNING','SUCCEEDED','FAILED','BLOCKED','DEAD')),
  payload jsonb NOT NULL DEFAULT '{}',
  result jsonb,
  error_code text,
  attempts int NOT NULL DEFAULT 0,
  max_attempts int NOT NULL DEFAULT 3,
  run_after timestamptz NOT NULL DEFAULT now(),
  requested_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, kind, idempotency_key)
);
CREATE INDEX jobs_ready ON jobs (status, run_after) WHERE status = 'QUEUED';

-- Transactional outbox: dış sistemlere giden olaylar iş kaydıyla aynı transaction'da yazılır.
CREATE TABLE outbox_events (
  id bigserial PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  topic text NOT NULL,
  dedupe_key text NOT NULL,
  payload jsonb NOT NULL,
  published_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, topic, dedupe_key)
);

ALTER TABLE suppliers ENABLE ROW LEVEL SECURITY;
CREATE POLICY s_tenant ON suppliers USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id());
ALTER TABLE supplier_document_links ENABLE ROW LEVEL SECURITY;
CREATE POLICY sdl_scope ON supplier_document_links
  USING (tenant_id = app_tenant_id() AND company_id = ANY (app_company_ids()))
  WITH CHECK (tenant_id = app_tenant_id() AND company_id = ANY (app_company_ids()));
ALTER TABLE supplier_approvals ENABLE ROW LEVEL SECURITY;
CREATE POLICY sa_tenant ON supplier_approvals USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id());
ALTER TABLE supplier_bank_accounts ENABLE ROW LEVEL SECURITY;
CREATE POLICY sba_tenant ON supplier_bank_accounts USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id());
ALTER TABLE bank_change_requests ENABLE ROW LEVEL SECURITY;
CREATE POLICY bcr_tenant ON bank_change_requests USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id());
ALTER TABLE jobs ENABLE ROW LEVEL SECURITY;
CREATE POLICY j_scope ON jobs
  USING (tenant_id = app_tenant_id() AND (company_id IS NULL OR company_id = ANY (app_company_ids())))
  WITH CHECK (tenant_id = app_tenant_id() AND (company_id IS NULL OR company_id = ANY (app_company_ids())));
ALTER TABLE outbox_events ENABLE ROW LEVEL SECURITY;
CREATE POLICY ob_tenant ON outbox_events USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id());

GRANT SELECT, INSERT ON suppliers TO sp_app;
GRANT UPDATE (status, legal_name, identity_review_required, activated_by, activated_at, rejection_reason,
              merged_into_id, row_version, tax_id, tax_id_type, country) ON suppliers TO sp_app;
GRANT SELECT, INSERT ON supplier_document_links, supplier_approvals TO sp_app;
GRANT SELECT, INSERT ON supplier_bank_accounts TO sp_app;
GRANT SELECT, INSERT, UPDATE (status) ON bank_change_requests TO sp_app;
GRANT SELECT, INSERT, UPDATE (status, result, error_code, attempts, run_after, updated_at) ON jobs TO sp_app;
GRANT SELECT, INSERT, UPDATE (published_at) ON outbox_events TO sp_app;
GRANT USAGE ON SEQUENCE outbox_events_id_seq TO sp_app;
