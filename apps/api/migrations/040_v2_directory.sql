-- v2 Faz 2 (D105, analiz-v2 §2.1-2.3, §3.7): Entra dizini kapsamı, eşitleme sonuçları, onaycı atamaları, departman takma adları.
-- Sırlar (ENTRA_CLIENT_SECRET) veritabanına yazılmaz; yalnız kapsam ayarı ve eşitlenen kullanıcı bilgisi tutulur.
-- Her tabloda RLS (tenant_id = app_tenant_id()) ve en dar GRANT. 030-039 değiştirilmez; yeniden çalıştırmada değişiklik yapmaz.

-- 1. Kapsam ayarı (kiracı başına tek satır)
CREATE TABLE IF NOT EXISTS directory_connections (
  tenant_id uuid PRIMARY KEY REFERENCES tenants(id),
  scope_type text NOT NULL DEFAULT 'GROUP' CHECK (scope_type IN ('GROUP','ADMIN_UNIT','OU_FILTER')),
  scope_value text NOT NULL DEFAULT '',
  enabled boolean NOT NULL DEFAULT false,
  updated_by uuid REFERENCES users(id),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- 2. Eşitleme çalıştırmaları
CREATE TABLE IF NOT EXISTS directory_sync_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  provider_kind text NOT NULL CHECK (provider_kind IN ('graph','test')),
  status text NOT NULL DEFAULT 'QUEUED' CHECK (status IN ('QUEUED','RUNNING','SUCCEEDED','FAILED')),
  trigger text NOT NULL CHECK (trigger IN ('MANUAL','NIGHTLY')),
  fetched integer NOT NULL DEFAULT 0,
  created integer NOT NULL DEFAULT 0,
  updated integer NOT NULL DEFAULT 0,
  suspended integer NOT NULL DEFAULT 0,
  reactivated integer NOT NULL DEFAULT 0,
  error_code text,
  error_message text,
  requested_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  finished_at timestamptz,
  UNIQUE (tenant_id, id)
);
CREATE INDEX IF NOT EXISTS directory_sync_runs_tenant_idx ON directory_sync_runs (tenant_id, created_at DESC);

-- 3. Departman eklemeleri: kaynak, normalize ad, birleştirme izi
ALTER TABLE departments ADD COLUMN IF NOT EXISTS source text NOT NULL DEFAULT 'MANUAL';
ALTER TABLE departments ADD COLUMN IF NOT EXISTS normalized_name text;
ALTER TABLE departments ADD COLUMN IF NOT EXISTS merged_into uuid;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'departments_source_check') THEN
    ALTER TABLE departments ADD CONSTRAINT departments_source_check CHECK (source IN ('MANUAL','ENTRA'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'departments_merged_into_fk') THEN
    ALTER TABLE departments ADD CONSTRAINT departments_merged_into_fk FOREIGN KEY (tenant_id, merged_into) REFERENCES departments (tenant_id, id);
  END IF;
END $$;
UPDATE departments SET normalized_name = lower(regexp_replace(btrim(name), '\s+', ' ', 'g')) WHERE normalized_name IS NULL;
GRANT UPDATE (merged_into, normalized_name) ON departments TO sp_app;

-- 4. Departman takma adları (Entra adı -> yerel departman; birleştirmeden sonra da hedefe yazar)
CREATE TABLE IF NOT EXISTS department_aliases (
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  normalized_name text NOT NULL,
  department_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, normalized_name),
  FOREIGN KEY (tenant_id, department_id) REFERENCES departments (tenant_id, id)
);

-- 5. Eşitlenen dizin kullanıcıları
CREATE TABLE IF NOT EXISTS directory_users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  entra_object_id text NOT NULL,
  email text NOT NULL,
  display_name text NOT NULL,
  user_principal_name text,
  department_name text,
  department_id uuid,
  job_title text,
  manager_object_id text,
  account_enabled boolean NOT NULL DEFAULT true,
  in_scope boolean NOT NULL DEFAULT true,
  user_id uuid REFERENCES users(id),
  last_run_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, entra_object_id),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, department_id) REFERENCES departments (tenant_id, id),
  FOREIGN KEY (tenant_id, last_run_id) REFERENCES directory_sync_runs (tenant_id, id)
);
CREATE INDEX IF NOT EXISTS directory_users_user_idx ON directory_users (user_id);

-- 6. Onaycı atamaları (bölüm sorumlusu / satınalma sorumlusu / satınalma direktörü; vekil isteğe bağlı, R2)
CREATE TABLE IF NOT EXISTS approver_assignments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  kind text NOT NULL CHECK (kind IN ('DEPARTMENT_HEAD','PROCUREMENT_LEAD','PROCUREMENT_DIRECTOR')),
  department_id uuid,
  primary_user_id uuid REFERENCES users(id),
  deputy_user_id uuid REFERENCES users(id),
  updated_by uuid REFERENCES users(id),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, department_id) REFERENCES departments (tenant_id, id),
  CONSTRAINT approver_assignments_kind_dept CHECK ((kind = 'DEPARTMENT_HEAD') = (department_id IS NOT NULL)),
  CONSTRAINT approver_assignments_distinct CHECK (primary_user_id IS NULL OR deputy_user_id IS NULL OR primary_user_id <> deputy_user_id),
  CONSTRAINT approver_assignments_unique UNIQUE NULLS NOT DISTINCT (tenant_id, kind, department_id)
);

-- 7. Üyelik eklemeleri: eşitlemenin askıya aldığı ve dizinden gelen departman (R4, R5)
ALTER TABLE memberships ADD COLUMN IF NOT EXISTS suspended_by_directory boolean NOT NULL DEFAULT false;
ALTER TABLE memberships ADD COLUMN IF NOT EXISTS directory_department_id uuid;

-- 8. RLS + en dar GRANT
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['directory_connections','directory_sync_runs','department_aliases','directory_users','approver_assignments'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS scope ON %I', t);
    EXECUTE format('CREATE POLICY scope ON %I USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id())', t);
  END LOOP;
END $$;

GRANT SELECT, INSERT, UPDATE ON directory_connections TO sp_app;
GRANT SELECT, INSERT, UPDATE ON directory_users TO sp_app;
GRANT SELECT, INSERT, UPDATE ON approver_assignments TO sp_app;
GRANT SELECT, INSERT ON directory_sync_runs TO sp_app;
GRANT UPDATE (status, fetched, created, updated, suspended, reactivated, error_code, error_message, started_at, finished_at) ON directory_sync_runs TO sp_app;
GRANT SELECT, INSERT ON department_aliases TO sp_app;
GRANT UPDATE (department_id) ON department_aliases TO sp_app;
GRANT UPDATE (status, roles, department_ids, suspended_by_directory, directory_department_id) ON memberships TO sp_app;
GRANT INSERT ON memberships, users TO sp_app;
