-- 057 v2 Faz 8 (D113): Oracle ERP entegrasyonu — özellik başına uç nokta, zarf şifreli sır, çalışma ve hata kaydı, ERP'ye yazma kaydı.
-- Kurallar:
--  * Her özellik varsayılan kapalı (enabled/write_enabled false). ERP'ye yazma yalnız yazan özellikte (SUPPLIER, REQUISITION,
--    CONTRACT_HEADER), özellik açıkken ve "anlıyorum" onayı (kim/ne zaman) saklıyken açık olabilir (R3; 24 saat sınama kuralı uygulamada).
--  * Sır yalnız şifreli: veri anahtarı KEK ile sarılı, sır AES-256-GCM (R5). Düz metin sütunu yoktur; uç nokta adreslerinde
--    kullanıcı bilgisi (kullanici:parola@) CHECK ile reddedilir.
--  * Taklit sağlayıcının çalışması her zaman mock=true; gerçek sağlayıcınınki mock=false (CHECK).
--  * Çalışma kapanınca değişmez; hata kaydı ve çalışma hiç silinmez (R9). Hiçbir tabloda DELETE izni yok.
--  * Tedarikçi bağlamı bu tablolara hiç erişemez; kapsam kiracıdır (yönetim ekranı, R10/R11).

CREATE TABLE integration_endpoints (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  feature text NOT NULL CHECK (feature IN ('SUPPLIER','COST_CENTER','REQUISITION','CONTRACT_HEADER','PURCHASE_ORDER','INVOICE','PAYMENT_STATUS')),
  enabled boolean NOT NULL DEFAULT false,
  write_enabled boolean NOT NULL DEFAULT false,
  write_confirmed_by uuid REFERENCES users(id),
  write_confirmed_at timestamptz,
  provider_kind text NOT NULL DEFAULT 'TAKLIT' CHECK (provider_kind IN ('TAKLIT','ORACLE_EBS')),
  base_url text CHECK (base_url IS NULL OR (length(base_url) BETWEEN 1 AND 500 AND base_url !~ '^[A-Za-z][A-Za-z0-9+.-]*://[^/?#]*@')),
  resource_path text CHECK (resource_path IS NULL OR length(resource_path) BETWEEN 1 AND 200),
  auth_type text CHECK (auth_type IN ('BASIC','OAUTH2_CLIENT_CREDENTIALS')),
  username text CHECK (username IS NULL OR length(username) BETWEEN 1 AND 200),
  client_id text CHECK (client_id IS NULL OR length(client_id) BETWEEN 1 AND 200),
  token_url text CHECK (token_url IS NULL OR (length(token_url) BETWEEN 1 AND 500 AND token_url !~ '^[A-Za-z][A-Za-z0-9+.-]*://[^/?#]*@')),
  schedule_kind text NOT NULL DEFAULT 'MANUAL' CHECK (schedule_kind IN ('MANUAL','INTERVAL','DAILY')),
  schedule_interval_min integer,
  schedule_daily_at time,
  field_map jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(field_map) = 'object'),
  timeout_ms integer NOT NULL DEFAULT 15000 CHECK (timeout_ms BETWEEN 1000 AND 120000),
  last_test_at timestamptz,
  last_test_ok boolean,
  last_test_message text CHECK (last_test_message IS NULL OR length(last_test_message) <= 500),
  last_slot text CHECK (last_slot IS NULL OR length(last_slot) BETWEEN 1 AND 100),
  updated_by uuid REFERENCES users(id),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, feature),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, id, feature),
  -- R3: yazma yalnız yazan özellikte, özellik açıkken ve onay saklıyken.
  CONSTRAINT integration_endpoints_write_check CHECK (
    NOT write_enabled OR (enabled AND feature IN ('SUPPLIER','REQUISITION','CONTRACT_HEADER')
                          AND write_confirmed_by IS NOT NULL AND write_confirmed_at IS NOT NULL)),
  CONSTRAINT integration_endpoints_confirm_pair CHECK ((write_confirmed_by IS NULL) = (write_confirmed_at IS NULL)),
  -- R7: aralık 15–1440 dk; günlükte saat zorunlu. Alanlar yalnız kendi kipinde dolu.
  CONSTRAINT integration_endpoints_schedule_check CHECK (
    (schedule_kind = 'INTERVAL') = (schedule_interval_min IS NOT NULL)
    AND (schedule_interval_min IS NULL OR schedule_interval_min BETWEEN 15 AND 1440)
    AND (schedule_kind = 'DAILY') = (schedule_daily_at IS NOT NULL)),
  -- Açık özellikte adres, kaynak yolu ve kimlik doğrulama türü bilinir (ayrıntılı doğrulama domain validateEndpointConfig).
  CONSTRAINT integration_endpoints_enabled_config CHECK (
    NOT enabled OR (base_url IS NOT NULL AND resource_path IS NOT NULL AND auth_type IS NOT NULL)),
  CONSTRAINT integration_endpoints_last_test_pair CHECK ((last_test_at IS NULL) = (last_test_ok IS NULL))
);

-- Sır: zarf şifreleme (R5). AES-256-GCM: IV 12 bayt; doğrulama etiketi (16 bayt) şifreli metnin / sarılı anahtarın sonundadır.
CREATE TABLE integration_endpoint_secrets (
  endpoint_id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  kek_id text NOT NULL CHECK (kek_id ~ '^[0-9a-f]{8}$'),
  wrapped_dek bytea NOT NULL CHECK (octet_length(wrapped_dek) BETWEEN 32 AND 64),
  dek_iv bytea NOT NULL CHECK (octet_length(dek_iv) = 12),
  secret_iv bytea NOT NULL CHECK (octet_length(secret_iv) = 12),
  ciphertext bytea NOT NULL CHECK (octet_length(ciphertext) BETWEEN 17 AND 8192),
  updated_by uuid NOT NULL REFERENCES users(id),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, endpoint_id) REFERENCES integration_endpoints (tenant_id, id)
);

-- Çalışma (R9). Uç nokta satırı yokken "yapılandırılmamış" çalışma da kaydedilir (endpoint_id NULL, sağlayıcı NULL).
CREATE TABLE integration_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  endpoint_id uuid,
  feature text NOT NULL CHECK (feature IN ('SUPPLIER','COST_CENTER','REQUISITION','CONTRACT_HEADER','PURCHASE_ORDER','INVOICE','PAYMENT_STATUS')),
  trigger text NOT NULL CHECK (trigger IN ('MANUAL','SCHEDULE','EVENT','TEST')),
  provider_kind text CHECK (provider_kind IN ('TAKLIT','ORACLE_EBS')),
  mock boolean NOT NULL,
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  status text NOT NULL DEFAULT 'RUNNING' CHECK (status IN ('RUNNING','SUCCESS','PARTIAL','FAILED','NOT_CONFIGURED')),
  counts jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(counts) = 'object'),
  requested_by uuid REFERENCES users(id),
  UNIQUE (tenant_id, id),
  -- Özellik uç noktanınkiyle aynıdır (kiracı-bileşik FK).
  FOREIGN KEY (tenant_id, endpoint_id, feature) REFERENCES integration_endpoints (tenant_id, id, feature),
  -- Taklit sonucu gerçek gibi görünmez: TAKLIT ⇒ mock, ORACLE_EBS ⇒ mock değil; sağlayıcısız çalışma yalnız NOT_CONFIGURED.
  CONSTRAINT integration_runs_mock_check CHECK (CASE WHEN provider_kind IS NULL THEN NOT mock AND status = 'NOT_CONFIGURED'
                                                     ELSE mock = (provider_kind = 'TAKLIT') END),
  CONSTRAINT integration_runs_finished_check CHECK ((status = 'RUNNING') = (finished_at IS NULL)),
  CONSTRAINT integration_runs_requester_check CHECK (trigger NOT IN ('MANUAL','TEST') OR requested_by IS NOT NULL)
);
CREATE INDEX integration_runs_feature_idx ON integration_runs (tenant_id, feature, started_at DESC);
CREATE INDEX integration_runs_endpoint_idx ON integration_runs (endpoint_id);

-- Kapanmış çalışma değişmez; çalışma silinmez.
CREATE FUNCTION integration_runs_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'immutable_record: DELETE on integration_runs is not allowed' USING ERRCODE = 'P0001';
  END IF;
  IF OLD.status <> 'RUNNING' THEN
    RAISE EXCEPTION 'immutable_record: finished integration run cannot change' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER integration_runs_guard BEFORE UPDATE OR DELETE ON integration_runs FOR EACH ROW EXECUTE FUNCTION integration_runs_guard();

-- Kayıt başına hata: sırdan arındırılmış ileti (≤500) ve yük özeti; ham yük saklanmaz. Değişmez.
CREATE TABLE integration_run_errors (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  run_id uuid NOT NULL,
  record_key text CHECK (record_key IS NULL OR length(record_key) BETWEEN 1 AND 200),
  code text NOT NULL CHECK (code ~ '^[A-Za-z0-9_.:-]{1,80}$'),
  message varchar(500) NOT NULL,
  payload_sha256 text CHECK (payload_sha256 IS NULL OR payload_sha256 ~ '^[0-9a-f]{64}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, run_id) REFERENCES integration_runs (tenant_id, id)
);
CREATE INDEX integration_run_errors_run_idx ON integration_run_errors (run_id, created_at);
CREATE TRIGGER integration_run_errors_immutable BEFORE UPDATE OR DELETE ON integration_run_errors FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

-- ERP'ye yazma kaydı (R3/R7): olay güdümlü gönderim ya da "ERP'ye elle iletildi" (MANUAL). Zaman aşımında UNKNOWN → önce sorgula.
-- provider_kind gönderen sağlayıcıyı tutar (taklit gönderim gerçek gibi görünmesin); elle kayıtta NULL.
CREATE TABLE erp_outbound_records (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  feature text NOT NULL CHECK (feature IN ('SUPPLIER','REQUISITION','CONTRACT_HEADER')),
  entity_type text NOT NULL CHECK (entity_type ~ '^[A-Z_]{1,40}$'),
  entity_id uuid NOT NULL,
  idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 1 AND 200),
  status text NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','SENT','CONFIRMED','FAILED','UNKNOWN','MANUAL')),
  provider_kind text CHECK (provider_kind IN ('TAKLIT','ORACLE_EBS')),
  external_ref text CHECK (external_ref IS NULL OR length(btrim(external_ref)) BETWEEN 1 AND 120),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  last_error text CHECK (last_error IS NULL OR length(last_error) <= 500),
  manual_by uuid REFERENCES users(id),
  manual_at timestamptz,
  manual_note text CHECK (manual_note IS NULL OR length(manual_note) <= 1000),
  created_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, idempotency_key),
  UNIQUE (tenant_id, id),
  CONSTRAINT erp_outbound_manual_check CHECK (
    (status = 'MANUAL') = (manual_by IS NOT NULL) AND (manual_by IS NULL) = (manual_at IS NULL)
    AND (status <> 'MANUAL' OR (external_ref IS NOT NULL AND provider_kind IS NULL))),
  CONSTRAINT erp_outbound_ref_check CHECK (status NOT IN ('SENT','CONFIRMED') OR (external_ref IS NOT NULL AND provider_kind IS NOT NULL))
);
CREATE INDEX erp_outbound_entity_idx ON erp_outbound_records (tenant_id, entity_type, entity_id, created_at DESC);
CREATE TRIGGER erp_outbound_records_no_delete BEFORE DELETE ON erp_outbound_records FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

-- RLS: kiracı; tedarikçi bağlamı kapalı.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['integration_endpoints','integration_endpoint_secrets','integration_runs','integration_run_errors','erp_outbound_records'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY scope ON %I USING (tenant_id = app_tenant_id() AND app_supplier_id() IS NULL) '
                   'WITH CHECK (tenant_id = app_tenant_id() AND app_supplier_id() IS NULL)', t);
  END LOOP;
END $$;

-- En dar GRANT; hiçbirinde DELETE yok.
GRANT SELECT ON integration_endpoints TO sp_app;
GRANT INSERT (id, tenant_id, feature, enabled, write_enabled, write_confirmed_by, write_confirmed_at, provider_kind, base_url, resource_path,
              auth_type, username, client_id, token_url, schedule_kind, schedule_interval_min, schedule_daily_at, field_map, timeout_ms,
              last_test_at, last_test_ok, last_test_message, last_slot, updated_by, updated_at) ON integration_endpoints TO sp_app;
GRANT UPDATE (enabled, write_enabled, write_confirmed_by, write_confirmed_at, provider_kind, base_url, resource_path, auth_type, username,
              client_id, token_url, schedule_kind, schedule_interval_min, schedule_daily_at, field_map, timeout_ms, last_test_at, last_test_ok,
              last_test_message, last_slot, updated_by, updated_at) ON integration_endpoints TO sp_app;
GRANT SELECT, INSERT ON integration_endpoint_secrets TO sp_app;
GRANT UPDATE (kek_id, wrapped_dek, dek_iv, secret_iv, ciphertext, updated_by, updated_at) ON integration_endpoint_secrets TO sp_app;
GRANT SELECT, INSERT ON integration_runs TO sp_app;
GRANT UPDATE (status, finished_at, counts) ON integration_runs TO sp_app;
GRANT SELECT, INSERT ON integration_run_errors TO sp_app;
GRANT SELECT, INSERT ON erp_outbound_records TO sp_app;
GRANT UPDATE (status, provider_kind, external_ref, attempts, last_error, manual_by, manual_at, manual_note, updated_at) ON erp_outbound_records TO sp_app;
