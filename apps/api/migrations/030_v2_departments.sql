-- v2 Faz 1 (D93/D95, analiz-v2 §2.3, §5): departmanlar ve departman kapsamı RLS'de; eski rol kodları v2 rollerine çevrilir.
-- Departman kullanıcısı yalnız kendi departmanlarının kaydını görür; Yönetici, Satınalma ve Denetçi hepsini görür (API bağlamı
-- app.department_scope = 'ALL'). Departmansız eski kayıtlar atanana kadar yalnız tüm departmanı görenlere açıktır.
-- Tedarikçi portalı bağlamı departman kapsamından etkilenmez (mevcut tedarikçi politikaları geçerli kalır).
-- Veri silinmez; yeniden çalıştırmada değişiklik yapmaz.

-- 1. Departmanlar
CREATE TABLE IF NOT EXISTS departments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  name text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 200),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, name),
  UNIQUE (tenant_id, id)
);
ALTER TABLE departments ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS scope ON departments;
CREATE POLICY scope ON departments USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id());
GRANT SELECT, INSERT, UPDATE ON departments TO sp_app;

-- 2. Üyelik departmanları (yönetici ek departman tanımlayabilir) ve kimlik kapısı
ALTER TABLE memberships ADD COLUMN IF NOT EXISTS department_ids uuid[] NOT NULL DEFAULT '{}';

DROP FUNCTION IF EXISTS auth_memberships(uuid);
CREATE FUNCTION auth_memberships(p_user_id uuid)
RETURNS TABLE (tenant_id uuid, tenant_name text, roles text[], company_ids uuid[], supplier_id uuid, department_ids uuid[])
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT m.tenant_id, t.name, m.roles, m.company_ids, m.supplier_id, m.department_ids
  FROM memberships m JOIN tenants t ON t.id = m.tenant_id
  WHERE m.user_id = p_user_id AND m.status = 'ACTIVE'
    AND m.valid_from <= now() AND (m.valid_to IS NULL OR m.valid_to > now())
$$;
REVOKE ALL ON FUNCTION auth_memberships(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION auth_memberships(uuid) TO sp_app;

-- 3. Saklanan eski rol kodları v2'ye (packages/domain/src/roles.ts LEGACY_ROLE_MAP ile aynı). Yalnız bu oturumda geçerli yardımcı.
CREATE FUNCTION pg_temp.v2_role(r text) RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE r
    WHEN 'TENANT_ADMIN' THEN 'ADMIN' WHEN 'PLATFORM_OPS' THEN 'ADMIN'
    WHEN 'BUYER' THEN 'PROCUREMENT' WHEN 'PROCUREMENT_MANAGER' THEN 'PROCUREMENT' WHEN 'MASTER_DATA' THEN 'PROCUREMENT'
    WHEN 'LEGAL' THEN 'PROCUREMENT' WHEN 'FINANCE' THEN 'PROCUREMENT'
    WHEN 'REQUESTER' THEN 'DEPARTMENT_USER' WHEN 'TECH_EVALUATOR' THEN 'DEPARTMENT_USER' WHEN 'SECURITY' THEN 'DEPARTMENT_USER'
    ELSE r END
$$;
CREATE FUNCTION pg_temp.v2_steps(steps jsonb) RETURNS jsonb LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE WHEN jsonb_typeof(steps) = 'array' THEN coalesce((
    SELECT jsonb_agg(CASE WHEN jsonb_typeof(s->'role') = 'string' THEN jsonb_set(s, '{role}', to_jsonb(pg_temp.v2_role(s->>'role'))) ELSE s END ORDER BY o)
    FROM jsonb_array_elements(steps) WITH ORDINALITY x(s, o)), '[]'::jsonb) ELSE steps END
$$;

UPDATE memberships m SET roles = array(SELECT DISTINCT pg_temp.v2_role(r) FROM unnest(m.roles) r ORDER BY 1)
WHERE m.roles && ARRAY['TENANT_ADMIN','PLATFORM_OPS','BUYER','PROCUREMENT_MANAGER','MASTER_DATA','LEGAL','FINANCE','REQUESTER','TECH_EVALUATOR','SECURITY'];

UPDATE tasks SET assignee_role = pg_temp.v2_role(assignee_role) WHERE assignee_role <> pg_temp.v2_role(assignee_role);
UPDATE corrective_actions SET owner_role = pg_temp.v2_role(owner_role) WHERE owner_role <> pg_temp.v2_role(owner_role);
UPDATE contract_obligations SET owner_role = pg_temp.v2_role(owner_role) WHERE owner_role <> pg_temp.v2_role(owner_role);
-- Onay motoru: politika kurallarındaki ve iş başına sabitlenmiş plandaki adım rolleri. approval_decisions.role değişmez kayıttır
-- (forbid_mutation); karşılaştırmada kullanılmaz, tarihsel olarak kalır.
UPDATE approval_policies p SET rules = (
  SELECT jsonb_agg(CASE WHEN jsonb_typeof(rule) = 'object' AND rule ? 'steps' THEN jsonb_set(rule, '{steps}', pg_temp.v2_steps(rule->'steps')) ELSE rule END ORDER BY o)
  FROM jsonb_array_elements(p.rules) WITH ORDINALITY x(rule, o))
WHERE jsonb_array_length(p.rules) > 0 AND p.rules <> (
  SELECT jsonb_agg(CASE WHEN jsonb_typeof(rule) = 'object' AND rule ? 'steps' THEN jsonb_set(rule, '{steps}', pg_temp.v2_steps(rule->'steps')) ELSE rule END ORDER BY o)
  FROM jsonb_array_elements(p.rules) WITH ORDINALITY x(rule, o));
UPDATE approval_requests SET plan = jsonb_set(plan, '{steps}', pg_temp.v2_steps(plan->'steps'))
WHERE jsonb_typeof(plan->'steps') = 'array' AND plan->'steps' <> pg_temp.v2_steps(plan->'steps');
DROP FUNCTION pg_temp.v2_steps(jsonb);
DROP FUNCTION pg_temp.v2_role(text);

-- 4. Departman alanı (zorunluluk Task 3; burada boş olabilir). Kiracı içi bileşik anahtar: başka kiracının departmanı bağlanamaz.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['projects','contract_families','invoices','supplier_assessments'] LOOP
    EXECUTE format('ALTER TABLE %I ADD COLUMN IF NOT EXISTS department_id uuid', t);
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = t || '_department_fk') THEN
      EXECUTE format('ALTER TABLE %I ADD CONSTRAINT %I FOREIGN KEY (tenant_id, department_id) REFERENCES departments (tenant_id, id)', t, t || '_department_fk');
    END IF;
    EXECUTE format('CREATE INDEX IF NOT EXISTS %I ON %I (department_id)', t || '_department_idx', t);
  END LOOP;
END $$;

-- 5. Departman kapsamı. Bağlam withTenant'ta her zaman kurulur (ALL veya LIST); kurulmamış bağlam kapalıdır.
CREATE OR REPLACE FUNCTION app_department_all() RETURNS boolean
  LANGUAGE sql STABLE AS $$
  SELECT current_setting('app.department_scope', true) = 'ALL' OR coalesce(current_setting('app.supplier_id', true), '') <> ''
$$;
CREATE OR REPLACE FUNCTION app_department_ok(dep uuid) RETURNS boolean
  LANGUAGE sql STABLE AS $$
  SELECT current_setting('app.department_scope', true) = 'ALL' OR coalesce(current_setting('app.supplier_id', true), '') <> ''
      OR dep = ANY(coalesce(nullif(current_setting('app.department_ids', true), ''), '{}')::uuid[])
$$;

-- 6. Departman alanlı tablolar: RESTRICTIVE (mevcut kiracı/şirket/tedarikçi politikasıyla VE'lenir).
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['projects','contract_families','invoices','supplier_assessments'] LOOP
    EXECUTE format('DROP POLICY IF EXISTS dept ON %I', t);
    EXECUTE format('CREATE POLICY dept ON %I AS RESTRICTIVE FOR ALL USING (app_department_ok(department_id)) WITH CHECK (app_department_ok(department_id))', t);
  END LOOP;
END $$;

-- 7. Alt tablolar üst kaydın departmanını devralır: üst kayıt (kendi RLS'iyle) görünmüyorsa alt kayıt da görünmez.
-- Tüm departmanı gören ve tedarikçi bağlamında alt sorgu çalışmaz. Sütunlar \d ile doğrulandı (yabancı anahtar sütunları).
DO $$
DECLARE r record;
BEGIN
  FOR r IN SELECT * FROM (VALUES
    ('project_lines', 'projects', 'project_id'),
    ('evaluation_criteria', 'projects', 'project_id'),
    ('rfq_rounds', 'projects', 'project_id'),
    ('rfq_invitations', 'projects', 'project_id'),
    ('bids', 'projects', 'project_id'),
    ('rfq_questions', 'projects', 'project_id'),
    ('bid_scores', 'projects', 'project_id'),
    ('bid_files', 'projects', 'project_id'),
    ('project_fx_rates', 'projects', 'project_id'),
    ('evaluations', 'projects', 'project_id'),
    ('awards', 'projects', 'project_id'),
    ('sourcing_exceptions', 'projects', 'project_id'),
    ('bid_lines', 'bids', 'bid_id'),
    ('bid_costs', 'bids', 'bid_id'),
    ('bid_attachments', 'bids', 'bid_id'),
    ('award_lines', 'awards', 'award_id'),
    ('contract_versions', 'contract_families', 'family_id'),
    ('contract_parties', 'contract_versions', 'contract_version_id'),
    ('contract_terms', 'contract_versions', 'contract_version_id'),
    ('contract_obligations', 'contract_versions', 'contract_version_id'),
    ('contract_guarantees', 'contract_versions', 'contract_version_id'),
    ('price_revision_rules', 'contract_versions', 'contract_version_id'),
    ('sla_terms', 'contract_versions', 'contract_version_id'),
    ('signature_requirements', 'contract_versions', 'contract_version_id'),
    ('signature_detection_runs', 'contract_versions', 'contract_version_id'),
    ('signature_exceptions', 'contract_versions', 'contract_version_id'),
    ('digital_validations', 'contract_versions', 'contract_version_id'),
    ('original_custody_events', 'contract_versions', 'contract_version_id'),
    ('signature_reviews', 'signature_requirements', 'requirement_id'),
    ('invoice_lines', 'invoices', 'invoice_id'),
    ('invoice_allocations', 'invoices', 'invoice_id'),
    ('assessment_answers', 'supplier_assessments', 'assessment_id')
  ) v(child, parent, fk) LOOP
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = r.child AND column_name = r.fk) THEN
      RAISE EXCEPTION 'department policy: %.% does not exist', r.child, r.fk;
    END IF;
    EXECUTE format('DROP POLICY IF EXISTS dept ON %I', r.child);
    EXECUTE format('CREATE POLICY dept ON %1$I AS RESTRICTIVE FOR ALL USING (app_department_all() OR EXISTS (SELECT 1 FROM %2$I p WHERE p.id = %1$I.%3$I)) '
                   'WITH CHECK (app_department_all() OR EXISTS (SELECT 1 FROM %2$I p WHERE p.id = %1$I.%3$I))', r.child, r.parent, r.fk);
  END LOOP;
END $$;
