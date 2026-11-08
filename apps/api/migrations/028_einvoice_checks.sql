-- D81: e-Fatura (UBL-TR 1.2) temel kural denetimi. Her XML belge sürümü için bir kayıt; değişmez (yalnız SELECT/INSERT).
-- Denetim onayı engellemez; bulgular belge ve fatura ekranında gösterilir. `bill_refs`: BillingReference fatura numaraları
-- (kur farkı faturasının ait olduğu döviz faturaları ve iade bağı için kanıt).
CREATE TABLE einvoice_checks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  company_id uuid NOT NULL,
  document_version_id uuid NOT NULL,
  profile_id text,
  type_code text,
  customization_id text,
  bill_refs text[] NOT NULL DEFAULT '{}',
  findings jsonb NOT NULL DEFAULT '[]',
  error_count int NOT NULL CHECK (error_count >= 0),
  warning_count int NOT NULL CHECK (warning_count >= 0),
  rule_set text NOT NULL,
  checked_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, document_version_id),
  FOREIGN KEY (tenant_id, company_id) REFERENCES legal_entities (tenant_id, id),
  FOREIGN KEY (tenant_id, document_version_id) REFERENCES document_versions (tenant_id, id)
);

ALTER TABLE einvoice_checks ENABLE ROW LEVEL SECURITY;
CREATE POLICY scope ON einvoice_checks USING (tenant_id = app_tenant_id() AND company_id = ANY (app_company_ids()))
  WITH CHECK (tenant_id = app_tenant_id() AND company_id = ANY (app_company_ids()));
GRANT SELECT, INSERT ON einvoice_checks TO sp_app;
