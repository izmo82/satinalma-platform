-- Faz 2 kalanları (02 §5, §13): kurallı onay motoru (sürümlü politika, iş başına sabitlenen plan, ardışık adım kararları) ve
-- kaynak bulma istisnaları (tek kaynak, acil alım, iptal, sonuçsuz kapanış). Kararlar değişmez; durum yalnız ileri gider.

CREATE TABLE approval_policies (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  version_no int NOT NULL CHECK (version_no > 0),
  rules jsonb NOT NULL CHECK (jsonb_typeof(rules) = 'array'),
  note text NOT NULL CHECK (length(btrim(note)) >= 10),
  status text NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT','ACTIVE','RETIRED')),
  created_by uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  activated_by uuid REFERENCES users(id),
  activated_at timestamptz,
  UNIQUE (tenant_id, version_no),
  UNIQUE (tenant_id, id),
  CHECK ((activated_by IS NULL) = (activated_at IS NULL)),
  CHECK (activated_by IS NULL OR activated_by <> created_by),
  CHECK (status = 'DRAFT' OR activated_by IS NOT NULL)
);
CREATE UNIQUE INDEX approval_policies_one_active ON approval_policies (tenant_id) WHERE status = 'ACTIVE';

-- Onay gerektiren her iş için plan: başladığı andaki politika sürümü ve adımlar kopyalanır (sonraki politika değişikliği
-- devam eden işi değiştirmez; göç kararı = "eski sürümle tamamlanır").
CREATE TABLE approval_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  company_id uuid NOT NULL,
  entity_type text NOT NULL CHECK (entity_type IN ('rfq_round','award','sourcing_exception')),
  entity_id uuid NOT NULL,
  action text NOT NULL CHECK (action IN ('RFQ_PUBLISH','AWARD','SOURCING_EXCEPTION')),
  policy_id uuid,
  plan jsonb NOT NULL,
  requested_by uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  status text NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN','APPROVED','REJECTED','CANCELLED')),
  closed_at timestamptz,
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, entity_type, entity_id),
  FOREIGN KEY (tenant_id, company_id) REFERENCES legal_entities(tenant_id, id),
  FOREIGN KEY (tenant_id, policy_id) REFERENCES approval_policies(tenant_id, id),
  CHECK ((status = 'OPEN') = (closed_at IS NULL))
);

CREATE TABLE approval_decisions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  company_id uuid NOT NULL,
  request_id uuid NOT NULL,
  step_no int NOT NULL CHECK (step_no > 0),
  role text NOT NULL,
  decision text NOT NULL CHECK (decision IN ('APPROVE','REJECT')),
  note text,
  decided_by uuid NOT NULL REFERENCES users(id),
  decided_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, request_id, step_no),
  -- Aynı kişi aynı işte iki adım onaylayamaz.
  UNIQUE (tenant_id, request_id, decided_by),
  FOREIGN KEY (tenant_id, request_id) REFERENCES approval_requests(tenant_id, id),
  CHECK (decision = 'APPROVE' OR length(btrim(coalesce(note, ''))) >= 5)
);
CREATE TRIGGER approval_decisions_immutable BEFORE UPDATE OR DELETE ON approval_decisions FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

-- Kaynak bulma istisnası: tek kaynak / acil alım politikadaki en az davetli / en az gün kuralının altına inmeye izin verir
-- (bir yayında kullanılır); iptal ve sonuçsuz kapanış projeyi kapatır.
CREATE TABLE sourcing_exceptions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  company_id uuid NOT NULL,
  project_id uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN ('SINGLE_SOURCE','URGENT','CANCEL','NO_AWARD')),
  reason text NOT NULL CHECK (length(btrim(reason)) >= 20),
  details jsonb NOT NULL DEFAULT '{}',
  requested_by uuid NOT NULL REFERENCES users(id),
  requested_at timestamptz NOT NULL DEFAULT now(),
  status text NOT NULL DEFAULT 'REQUESTED' CHECK (status IN ('REQUESTED','APPROVED','REJECTED','USED')),
  decided_at timestamptz,
  used_round_id uuid,
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, company_id) REFERENCES legal_entities(tenant_id, id),
  FOREIGN KEY (tenant_id, project_id) REFERENCES projects(tenant_id, id),
  CHECK ((status = 'USED') = (used_round_id IS NOT NULL))
);
-- Proje başına aynı türde tek açık (karar bekleyen veya kullanılmamış onaylı) istisna.
CREATE UNIQUE INDEX sourcing_exceptions_one_open ON sourcing_exceptions (project_id, kind) WHERE status IN ('REQUESTED','APPROVED');

-- Sonuçsuz kapanış ayrı durumdur (iptal = ihtiyaç kalktı; sonuçsuz = uygun teklif çıkmadı).
ALTER TABLE projects DROP CONSTRAINT projects_status_check;
ALTER TABLE projects ADD CONSTRAINT projects_status_check CHECK (status IN ('DRAFT','IN_APPROVAL','OPEN','EVALUATION','AWARD_APPROVAL','CONTRACTING','CANCELLED','NO_AWARD'));

ALTER TABLE approval_policies ENABLE ROW LEVEL SECURITY;
CREATE POLICY scope ON approval_policies USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id());
GRANT SELECT, INSERT ON approval_policies TO sp_app;
GRANT UPDATE (status, activated_by, activated_at) ON approval_policies TO sp_app;
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['approval_requests','approval_decisions','sourcing_exceptions'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY scope ON %I USING (tenant_id = app_tenant_id() AND company_id = ANY (app_company_ids())) '
                   'WITH CHECK (tenant_id = app_tenant_id() AND company_id = ANY (app_company_ids()))', t);
    EXECUTE format('GRANT SELECT, INSERT ON %I TO sp_app', t);
  END LOOP;
END $$;
GRANT UPDATE (status, closed_at) ON approval_requests TO sp_app;
GRANT UPDATE (status, decided_at, used_round_id) ON sourcing_exceptions TO sp_app;
