-- 012 Faz 5: AI yönetişimi (07). Model kaydı (platform kataloğu), kiracı politikası/bütçesi, çalıştırma defteri.
-- Model adı/fiyat iş kurallarına gömülmez; kayıttan okunur. Bilinmeyen tarife sıfır yazılmaz (NULL). Ödeme/onay kararı AI'a verilmez.

-- Platform kataloğu: kiracıya ait değildir; uygulama yalnız okur. Kayıt platform operasyonu tarafından (sahip rolüyle) girilir.
CREATE TABLE ai_models (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider text NOT NULL,
  model_id text NOT NULL,
  model_version text NOT NULL,
  tasks text[] NOT NULL,
  -- structuredOutput, vision, ocr, signatureDetection: vision ≠ imza tespiti yeteneği (T24).
  capabilities jsonb NOT NULL,
  context_tokens int,
  max_output_tokens int,
  approved_regions text[] NOT NULL,
  retention_days int,
  trains_on_customer_data boolean NOT NULL,
  -- {unit: 'TOKEN_1M'|'PAGE'|'CALL', input, output, page, currency}; bilinmeyen alan NULL.
  price jsonb NOT NULL,
  verified_at timestamptz,
  enabled boolean NOT NULL DEFAULT false,
  UNIQUE (provider, model_id, model_version)
);
GRANT SELECT ON ai_models TO sp_app;

CREATE TABLE ai_tenant_policies (
  tenant_id uuid PRIMARY KEY REFERENCES tenants(id),
  allowed_providers text[] NOT NULL DEFAULT '{}',
  allowed_regions text[] NOT NULL DEFAULT '{}',
  monthly_budget numeric(20,2) CHECK (monthly_budget >= 0),
  budget_currency char(3) NOT NULL DEFAULT 'USD',
  daily_call_limit int CHECK (daily_call_limit >= 0),
  allow_upgrade boolean NOT NULL DEFAULT false,
  updated_by uuid REFERENCES users(id),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Çalıştırma defteri: her AI isteği yönlendirme kararıyla kaydedilir (çalışmasa da). Aynı iş idempotent.
CREATE TABLE ai_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  company_id uuid,
  task text NOT NULL CHECK (task ~ '^AI(0[1-9]|1[0-3])$'),
  entity_type text NOT NULL,
  entity_id uuid NOT NULL,
  document_version_id uuid,
  model_ref uuid REFERENCES ai_models(id),
  status text NOT NULL CHECK (status IN ('QUEUED','RUNNING','SUCCEEDED','FAILED','WAITING_QUOTA','NO_PROVIDER','NOT_ALLOWED')),
  reason text,
  estimated_cost numeric(20,6),
  actual_cost numeric(20,6),
  cost_currency char(3),
  flags jsonb NOT NULL DEFAULT '[]',
  idempotency_key text NOT NULL,
  requested_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  UNIQUE (tenant_id, idempotency_key)
);
CREATE INDEX ai_runs_month ON ai_runs (tenant_id, created_at);

ALTER TABLE ai_tenant_policies ENABLE ROW LEVEL SECURITY;
CREATE POLICY scope ON ai_tenant_policies USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id());
GRANT SELECT, INSERT, UPDATE (allowed_providers, allowed_regions, monthly_budget, budget_currency, daily_call_limit, allow_upgrade, updated_by, updated_at) ON ai_tenant_policies TO sp_app;
ALTER TABLE ai_runs ENABLE ROW LEVEL SECURITY;
CREATE POLICY scope ON ai_runs USING (tenant_id = app_tenant_id() AND (company_id IS NULL OR company_id = ANY (app_company_ids())))
  WITH CHECK (tenant_id = app_tenant_id());
GRANT SELECT, INSERT, UPDATE (status, reason, actual_cost, cost_currency, flags, finished_at, model_ref) ON ai_runs TO sp_app;

-- AI çıkarımı: alan kaynağı (sayfa + kanıt metni) ve hangi çalıştırmadan geldiği. Kaynak doğrulanmadıysa değer NULL kalır.
ALTER TABLE extracted_fields ADD COLUMN ai_run_id uuid REFERENCES ai_runs(id);
