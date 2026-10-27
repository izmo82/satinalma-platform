-- 001 Güvenli temel: kiracı, şirket, üyelik, denetim izi, belge sürümü, görev.
-- Tablolar sp_owner'a aittir; uygulama sp_app (NOBYPASSRLS) ile çalışır ve RLS'e tabidir.
-- Kiracı/şirket bağlamı yalnız transaction-local set_config ile verilir (bkz. src/db.ts).

CREATE OR REPLACE FUNCTION app_tenant_id() RETURNS uuid
  LANGUAGE sql STABLE AS $$ SELECT nullif(current_setting('app.tenant_id', true), '')::uuid $$;
CREATE OR REPLACE FUNCTION app_user_id() RETURNS uuid
  LANGUAGE sql STABLE AS $$ SELECT nullif(current_setting('app.user_id', true), '')::uuid $$;
CREATE OR REPLACE FUNCTION app_company_ids() RETURNS uuid[]
  LANGUAGE sql STABLE AS $$ SELECT coalesce(nullif(current_setting('app.company_ids', true), ''), '{}')::uuid[] $$;

CREATE OR REPLACE FUNCTION forbid_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'immutable_record: % on % is not allowed', TG_OP, TG_TABLE_NAME
    USING ERRCODE = 'P0001';
END $$;

CREATE TABLE tenants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  data_region text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE legal_entities (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  name text NOT NULL,
  country char(2) NOT NULL,
  tax_id_type text NOT NULL CHECK (tax_id_type IN ('VKN','TCKN','FOREIGN')),
  tax_id text NOT NULL,
  default_currency char(3) NOT NULL DEFAULT 'TRY',
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, country, tax_id_type, tax_id)
);

-- Kimlik sağlayıcıdan gelen global kullanıcı. Kiracıya erişim yalnız memberships ile.
CREATE TABLE users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  auth_subject text NOT NULL UNIQUE,
  email text NOT NULL,
  display_name text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE memberships (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  user_id uuid NOT NULL REFERENCES users(id),
  roles text[] NOT NULL,
  -- Şirket kapsamı açıkça listelenir; kiracı yöneticisi otomatik tüm şirket belgesini görmez.
  company_ids uuid[] NOT NULL DEFAULT '{}',
  status text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','SUSPENDED','REVOKED')),
  valid_from timestamptz NOT NULL DEFAULT now(),
  valid_to timestamptz,
  UNIQUE (tenant_id, user_id)
);

-- Kimlik doğrulandıktan sonra, kiracı bağlamı kurulmadan önce üyelikleri çözmek için tek dar kapı.
CREATE OR REPLACE FUNCTION auth_memberships(p_user_id uuid)
RETURNS TABLE (tenant_id uuid, tenant_name text, roles text[], company_ids uuid[])
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT m.tenant_id, t.name, m.roles, m.company_ids
  FROM memberships m JOIN tenants t ON t.id = m.tenant_id
  WHERE m.user_id = p_user_id AND m.status = 'ACTIVE'
    AND m.valid_from <= now() AND (m.valid_to IS NULL OR m.valid_to > now())
$$;

CREATE OR REPLACE FUNCTION auth_user_by_subject(p_subject text)
RETURNS TABLE (id uuid, email text, display_name text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT u.id, u.email, u.display_name FROM users u WHERE u.auth_subject = p_subject
$$;

CREATE TABLE audit_events (
  id bigserial PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  actor_user_id uuid,
  action text NOT NULL,
  entity_type text NOT NULL,
  entity_id uuid,
  -- Belge metni, kimlik görüntüsü veya imza kesiti buraya yazılmaz; yalnız kimlik/hash/karar.
  data jsonb NOT NULL DEFAULT '{}',
  reason text,
  correlation_id text,
  at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_events_entity ON audit_events (tenant_id, entity_type, entity_id);
CREATE TRIGGER audit_events_immutable BEFORE UPDATE OR DELETE ON audit_events
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

CREATE TABLE documents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  company_id uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN ('INVOICE','CONTRACT','QUOTE','OTHER')),
  title text NOT NULL,
  created_by uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, company_id) REFERENCES legal_entities (tenant_id, id)
);

-- Değişmez belge sürümü. Düzeltme yeni sürüm veya ayrı çıkarım kaydıdır.
CREATE TABLE document_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  company_id uuid NOT NULL,
  document_id uuid NOT NULL,
  version_no int NOT NULL CHECK (version_no > 0),
  sha256 char(64) NOT NULL,
  mime_type text NOT NULL,
  size_bytes bigint NOT NULL CHECK (size_bytes > 0),
  storage_key text NOT NULL,
  original_filename text NOT NULL,
  -- Yerleşik kontroller (MIME/imza baytı/aktif içerik) ile gerçek AV taraması ayrı tutulur.
  basic_check_status text NOT NULL CHECK (basic_check_status IN ('PASSED','QUARANTINED')),
  basic_check_reason text,
  av_scan_status text NOT NULL DEFAULT 'NOT_AVAILABLE'
    CHECK (av_scan_status IN ('NOT_AVAILABLE','PENDING','CLEAN','INFECTED','ERROR')),
  page_count int,
  created_by uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, document_id, version_no),
  -- Aynı belgeye aynı içerik ikinci sürüm olamaz (idempotent yükleme).
  UNIQUE (tenant_id, document_id, sha256),
  FOREIGN KEY (tenant_id, document_id) REFERENCES documents (tenant_id, id),
  FOREIGN KEY (tenant_id, company_id) REFERENCES legal_entities (tenant_id, id)
);
CREATE INDEX document_versions_sha ON document_versions (tenant_id, sha256);

CREATE OR REPLACE FUNCTION document_versions_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.sha256 IS DISTINCT FROM OLD.sha256 OR NEW.storage_key IS DISTINCT FROM OLD.storage_key
     OR NEW.document_id IS DISTINCT FROM OLD.document_id OR NEW.version_no IS DISTINCT FROM OLD.version_no
     OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id OR NEW.company_id IS DISTINCT FROM OLD.company_id THEN
    RAISE EXCEPTION 'immutable_record: document version content is immutable' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER document_versions_immutable BEFORE UPDATE ON document_versions
  FOR EACH ROW EXECUTE FUNCTION document_versions_guard();
CREATE TRIGGER document_versions_nodelete BEFORE DELETE ON document_versions
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

-- Çıkarılan alanlar: kaynak (sayfa/hücre/xpath), köken (RULE/AI/HUMAN) ve inceleme durumu.
CREATE TABLE extracted_fields (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  company_id uuid NOT NULL,
  document_version_id uuid NOT NULL,
  field text NOT NULL,
  value text,
  origin text NOT NULL CHECK (origin IN ('RULE','AI','HUMAN')),
  source_ref jsonb NOT NULL DEFAULT '{}',
  confidence text NOT NULL CHECK (confidence IN ('HIGH','LOW','MISSING')),
  review_state text NOT NULL DEFAULT 'UNREVIEWED' CHECK (review_state IN ('UNREVIEWED','CONFIRMED','CORRECTED','REJECTED')),
  supersedes_id uuid REFERENCES extracted_fields(id),
  created_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, document_version_id) REFERENCES document_versions (tenant_id, id)
);
CREATE INDEX extracted_fields_dv ON extracted_fields (tenant_id, document_version_id);

CREATE TABLE tasks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  -- null: kiracı düzeyi ana veri işi (ör. aday tedarikçi)
  company_id uuid,
  kind text NOT NULL,
  entity_type text NOT NULL,
  entity_id uuid NOT NULL,
  title text NOT NULL,
  reason text NOT NULL,
  next_action text NOT NULL,
  assignee_role text NOT NULL,
  assignee_user_id uuid REFERENCES users(id),
  due_at timestamptz,
  severity text NOT NULL DEFAULT 'NORMAL' CHECK (severity IN ('NORMAL','HIGH','CRITICAL')),
  status text NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN','DONE','CANCELLED')),
  dedupe_key text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  closed_at timestamptz
);
-- Aynı açık iş ikinci kez oluşmaz (BR12, SIG15).
CREATE UNIQUE INDEX tasks_open_dedupe ON tasks (tenant_id, dedupe_key) WHERE status = 'OPEN';

-- RLS ------------------------------------------------------------------------
ALTER TABLE tenants ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_self ON tenants USING (id = app_tenant_id());

ALTER TABLE legal_entities ENABLE ROW LEVEL SECURITY;
CREATE POLICY le_tenant ON legal_entities USING (tenant_id = app_tenant_id());

ALTER TABLE memberships ENABLE ROW LEVEL SECURITY;
CREATE POLICY m_tenant ON memberships USING (tenant_id = app_tenant_id());

ALTER TABLE users ENABLE ROW LEVEL SECURITY;
-- Kullanıcı yalnız aynı kiracıdaki üyeleri ad/e-posta düzeyinde görebilir.
CREATE POLICY u_same_tenant ON users USING (
  id = app_user_id() OR EXISTS (SELECT 1 FROM memberships m WHERE m.user_id = users.id AND m.tenant_id = app_tenant_id())
);

ALTER TABLE audit_events ENABLE ROW LEVEL SECURITY;
CREATE POLICY ae_tenant ON audit_events USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id());

ALTER TABLE documents ENABLE ROW LEVEL SECURITY;
CREATE POLICY d_scope ON documents
  USING (tenant_id = app_tenant_id() AND company_id = ANY (app_company_ids()))
  WITH CHECK (tenant_id = app_tenant_id() AND company_id = ANY (app_company_ids()));

ALTER TABLE document_versions ENABLE ROW LEVEL SECURITY;
CREATE POLICY dv_scope ON document_versions
  USING (tenant_id = app_tenant_id() AND company_id = ANY (app_company_ids()))
  WITH CHECK (tenant_id = app_tenant_id() AND company_id = ANY (app_company_ids()));

ALTER TABLE extracted_fields ENABLE ROW LEVEL SECURITY;
CREATE POLICY ef_scope ON extracted_fields
  USING (tenant_id = app_tenant_id() AND company_id = ANY (app_company_ids()))
  WITH CHECK (tenant_id = app_tenant_id() AND company_id = ANY (app_company_ids()));

ALTER TABLE tasks ENABLE ROW LEVEL SECURITY;
CREATE POLICY t_scope ON tasks
  USING (tenant_id = app_tenant_id() AND (company_id IS NULL OR company_id = ANY (app_company_ids())))
  WITH CHECK (tenant_id = app_tenant_id() AND (company_id IS NULL OR company_id = ANY (app_company_ids())));

GRANT EXECUTE ON FUNCTION auth_memberships(uuid), auth_user_by_subject(text) TO sp_app;
GRANT SELECT ON tenants, legal_entities, memberships, users TO sp_app;
GRANT SELECT, INSERT ON audit_events TO sp_app;
GRANT USAGE ON SEQUENCE audit_events_id_seq TO sp_app;
GRANT SELECT, INSERT ON documents, document_versions TO sp_app;
GRANT UPDATE (av_scan_status, page_count) ON document_versions TO sp_app;
GRANT SELECT, INSERT, UPDATE (review_state) ON extracted_fields TO sp_app;
GRANT SELECT, INSERT, UPDATE (status, closed_at, assignee_user_id) ON tasks TO sp_app;
