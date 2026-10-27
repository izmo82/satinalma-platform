-- 005 Faz 2: proje, kalem/lot, kriter, RFQ turu, tedarikçi portalı (davet, mühürlü teklif, soru-cevap),
-- teknik puan, değerlendirme sürümü ve kazanan tahsisi.
-- Kurallar veritabanında da uygulanır: kapanış sunucu saati (T09), teklif içeriği kapanıştan önce alıcıya kapalı (BR06),
-- tedarikçi yalnız kendi teklifini görür (T09), görev ayrılığı (BR03), kayıtlar değişmez; sürüm/ters kayıt kullanılır (BR11).

-- Tedarikçi portal kullanıcısı: kiracı üyeliği SUPPLIER rolü + tek tedarikçi; şirket belgesi kapsamı yok.
ALTER TABLE memberships ADD COLUMN supplier_id uuid;
ALTER TABLE memberships ADD CONSTRAINT memberships_supplier_fk FOREIGN KEY (tenant_id, supplier_id) REFERENCES suppliers (tenant_id, id);
ALTER TABLE memberships ADD CONSTRAINT memberships_supplier_scope CHECK (
  (supplier_id IS NULL AND NOT ('SUPPLIER' = ANY (roles))) OR (supplier_id IS NOT NULL AND roles = ARRAY['SUPPLIER'] AND company_ids = '{}'));

DROP FUNCTION auth_memberships(uuid);
CREATE FUNCTION auth_memberships(p_user_id uuid)
RETURNS TABLE (tenant_id uuid, tenant_name text, roles text[], company_ids uuid[], supplier_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT m.tenant_id, t.name, m.roles, m.company_ids, m.supplier_id
  FROM memberships m JOIN tenants t ON t.id = m.tenant_id
  WHERE m.user_id = p_user_id AND m.status = 'ACTIVE'
    AND m.valid_from <= now() AND (m.valid_to IS NULL OR m.valid_to > now())
$$;
REVOKE ALL ON FUNCTION auth_memberships(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION auth_memberships(uuid) TO sp_app;

CREATE OR REPLACE FUNCTION app_supplier_id() RETURNS uuid
  LANGUAGE sql STABLE AS $$ SELECT nullif(current_setting('app.supplier_id', true), '')::uuid $$;

-- Kiracı içi sıra numarası (proje no). Kiracılar arası hacim sızdırmaz.
CREATE TABLE tenant_counters (
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  name text NOT NULL,
  value bigint NOT NULL DEFAULT 0,
  PRIMARY KEY (tenant_id, name)
);

CREATE TABLE projects (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  company_id uuid NOT NULL,
  code text NOT NULL,
  title text NOT NULL CHECK (length(title) BETWEEN 3 AND 200),
  category text NOT NULL,
  need text NOT NULL DEFAULT '',
  currency char(3) NOT NULL DEFAULT 'TRY',
  budget numeric(20,2) CHECK (budget IS NULL OR budget >= 0),
  budget_verified boolean NOT NULL DEFAULT false,
  cost_center text,
  delivery_location text,
  needed_by date,
  status text NOT NULL DEFAULT 'DRAFT'
    CHECK (status IN ('DRAFT','IN_APPROVAL','OPEN','EVALUATION','AWARD_APPROVAL','CONTRACTING','CANCELLED')),
  owner_user_id uuid NOT NULL REFERENCES users(id),
  created_by uuid NOT NULL REFERENCES users(id),
  cancel_reason text,
  row_version int NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, code),
  FOREIGN KEY (tenant_id, company_id) REFERENCES legal_entities (tenant_id, id)
);

CREATE TABLE project_lines (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  company_id uuid NOT NULL,
  project_id uuid NOT NULL,
  lot text NOT NULL DEFAULT 'Lot 1',
  line_no int NOT NULL,
  description text NOT NULL CHECK (length(description) BETWEEN 2 AND 500),
  unit text NOT NULL,
  quantity numeric(20,6) NOT NULL CHECK (quantity > 0),
  spec text NOT NULL DEFAULT '',
  retired_at timestamptz,
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, project_id) REFERENCES projects (tenant_id, id)
);

-- Kriter revizyonları: yayından sonra ağırlık değişikliği yeni revizyon + gerekçe ister; eski değerlendirme eskir (T11).
CREATE TABLE evaluation_criteria (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  company_id uuid NOT NULL,
  project_id uuid NOT NULL,
  revision int NOT NULL DEFAULT 1,
  code text NOT NULL,
  name text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('PRICE','SCORE')),
  weight numeric(7,4) NOT NULL CHECK (weight > 0 AND weight <= 100),
  reason text,
  created_by uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, project_id, revision, code),
  FOREIGN KEY (tenant_id, project_id) REFERENCES projects (tenant_id, id)
);

CREATE TABLE rfq_rounds (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  company_id uuid NOT NULL,
  project_id uuid NOT NULL,
  round_no int NOT NULL,
  closes_at timestamptz NOT NULL,
  status text NOT NULL DEFAULT 'PENDING_APPROVAL' CHECK (status IN ('PENDING_APPROVAL','OPEN','CLOSED','CANCELLED')),
  requested_by uuid NOT NULL REFERENCES users(id),
  approved_by uuid REFERENCES users(id),
  approved_at timestamptz,
  closed_at timestamptz,
  close_reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, project_id, round_no),
  FOREIGN KEY (tenant_id, project_id) REFERENCES projects (tenant_id, id),
  -- Yayını başlatan tek başına onaylayamaz (BR03).
  CHECK (approved_by IS NULL OR approved_by <> requested_by)
);
-- Bir projede aynı anda tek açık/onay bekleyen tur.
CREATE UNIQUE INDEX rfq_rounds_one_active ON rfq_rounds (tenant_id, project_id) WHERE status IN ('PENDING_APPROVAL','OPEN');

CREATE TABLE rfq_invitations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  company_id uuid NOT NULL,
  project_id uuid NOT NULL,
  round_id uuid NOT NULL,
  supplier_id uuid NOT NULL,
  invited_by uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, round_id, supplier_id),
  FOREIGN KEY (tenant_id, round_id) REFERENCES rfq_rounds (tenant_id, id),
  FOREIGN KEY (tenant_id, supplier_id) REFERENCES suppliers (tenant_id, id)
);

CREATE TABLE bids (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  company_id uuid NOT NULL,
  project_id uuid NOT NULL,
  round_id uuid NOT NULL,
  supplier_id uuid NOT NULL,
  version_no int NOT NULL,
  currency char(3) NOT NULL,
  validity_days int CHECK (validity_days IS NULL OR validity_days > 0),
  note text NOT NULL DEFAULT '',
  status text NOT NULL DEFAULT 'SUBMITTED' CHECK (status IN ('SUBMITTED','SUPERSEDED','WITHDRAWN')),
  idempotency_key text NOT NULL,
  submitted_by uuid NOT NULL REFERENCES users(id),
  -- Alındı zamanı sunucu saatidir; istemci gönderemez.
  submitted_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, round_id, supplier_id, version_no),
  UNIQUE (tenant_id, supplier_id, idempotency_key),
  FOREIGN KEY (tenant_id, round_id) REFERENCES rfq_rounds (tenant_id, id),
  FOREIGN KEY (tenant_id, round_id, supplier_id) REFERENCES rfq_invitations (tenant_id, round_id, supplier_id)
);
CREATE UNIQUE INDEX bids_one_current ON bids (tenant_id, round_id, supplier_id) WHERE status = 'SUBMITTED';

-- Teklif ancak tur açıkken ve sunucu saatine göre kapanıştan önce kaydedilir (T09). API atlansa da geçerli.
CREATE OR REPLACE FUNCTION bids_round_open() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE r rfq_rounds%ROWTYPE;
BEGIN
  SELECT * INTO r FROM rfq_rounds WHERE id = NEW.round_id;
  IF r.status <> 'OPEN' OR now() >= r.closes_at THEN
    RAISE EXCEPTION 'round_closed: bids are accepted only while the round is open' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER bids_round_open BEFORE INSERT ON bids FOR EACH ROW EXECUTE FUNCTION bids_round_open();

CREATE TABLE bid_lines (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  company_id uuid NOT NULL,
  bid_id uuid NOT NULL,
  project_line_id uuid NOT NULL,
  unit text NOT NULL,
  quantity numeric(20,6) NOT NULL CHECK (quantity >= 0),
  unit_price numeric(20,6) NOT NULL CHECK (unit_price >= 0),
  scope text NOT NULL CHECK (scope IN ('INCLUDED','EXCLUDED','ALTERNATIVE')),
  note text NOT NULL DEFAULT '',
  UNIQUE (tenant_id, bid_id, project_line_id),
  FOREIGN KEY (tenant_id, bid_id) REFERENCES bids (tenant_id, id),
  FOREIGN KEY (tenant_id, project_line_id) REFERENCES project_lines (tenant_id, id)
);

CREATE TABLE bid_costs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  company_id uuid NOT NULL,
  bid_id uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN ('SHIPPING','INSTALLATION','MAINTENANCE','RENEWAL','OTHER')),
  amount numeric(20,2) NOT NULL CHECK (amount >= 0),
  note text NOT NULL DEFAULT '',
  FOREIGN KEY (tenant_id, bid_id) REFERENCES bids (tenant_id, id)
);

-- Soru-cevap: soran tedarikçinin kimliği diğer katılımcılara gösterilmez; yanıt yayınlanınca tüm davetlilere aynı metin.
CREATE TABLE rfq_questions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  company_id uuid NOT NULL,
  project_id uuid NOT NULL,
  round_id uuid NOT NULL,
  supplier_id uuid NOT NULL,
  question text NOT NULL CHECK (length(question) BETWEEN 3 AND 4000),
  asked_by uuid NOT NULL REFERENCES users(id),
  asked_at timestamptz NOT NULL DEFAULT now(),
  answer text,
  answered_by uuid REFERENCES users(id),
  answered_at timestamptz,
  FOREIGN KEY (tenant_id, round_id, supplier_id) REFERENCES rfq_invitations (tenant_id, round_id, supplier_id)
);

-- Teknik puan: kanıtlı, değişmez; güncel puan en son kayıttır.
CREATE TABLE bid_scores (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  company_id uuid NOT NULL,
  project_id uuid NOT NULL,
  bid_id uuid NOT NULL,
  criterion_code text NOT NULL,
  score numeric(5,2) NOT NULL CHECK (score >= 0 AND score <= 100),
  evidence text NOT NULL CHECK (length(evidence) >= 10),
  scored_by uuid NOT NULL REFERENCES users(id),
  scored_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, bid_id) REFERENCES bids (tenant_id, id)
);

CREATE TABLE project_fx_rates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  company_id uuid NOT NULL,
  project_id uuid NOT NULL,
  currency char(3) NOT NULL,
  rate numeric(20,8) NOT NULL CHECK (rate > 0),
  source text NOT NULL,
  as_of date NOT NULL,
  created_by uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, project_id) REFERENCES projects (tenant_id, id)
);

-- Değerlendirme sürümü: hesaplanan karşılaştırmanın anlık görüntüsü ve dayanağının parmak izi.
-- "Eski" durumu saklanmaz; güncel dayanakla karşılaştırılarak türetilir (T11).
CREATE TABLE evaluations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  company_id uuid NOT NULL,
  project_id uuid NOT NULL,
  version_no int NOT NULL,
  basis_hash text NOT NULL,
  snapshot jsonb NOT NULL,
  created_by uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, project_id, version_no),
  FOREIGN KEY (tenant_id, project_id) REFERENCES projects (tenant_id, id)
);

CREATE TABLE awards (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  company_id uuid NOT NULL,
  project_id uuid NOT NULL,
  evaluation_id uuid NOT NULL,
  version_no int NOT NULL,
  rationale text NOT NULL CHECK (length(rationale) >= 10),
  total numeric(20,2) NOT NULL,
  status text NOT NULL DEFAULT 'PROPOSED' CHECK (status IN ('PROPOSED','APPROVED','REJECTED','SUPERSEDED')),
  proposed_by uuid NOT NULL REFERENCES users(id),
  proposed_at timestamptz NOT NULL DEFAULT now(),
  decided_by uuid REFERENCES users(id),
  decided_at timestamptz,
  decision_note text,
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, project_id, version_no),
  FOREIGN KEY (tenant_id, evaluation_id) REFERENCES evaluations (tenant_id, id),
  CHECK (decided_by IS NULL OR decided_by <> proposed_by)
);
CREATE UNIQUE INDEX awards_one_open ON awards (tenant_id, project_id) WHERE status IN ('PROPOSED','APPROVED');

CREATE TABLE award_lines (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  company_id uuid NOT NULL,
  award_id uuid NOT NULL,
  project_line_id uuid NOT NULL,
  supplier_id uuid NOT NULL,
  bid_id uuid NOT NULL,
  quantity numeric(20,6) NOT NULL CHECK (quantity > 0),
  unit_price numeric(20,6) NOT NULL,
  amount numeric(20,2) NOT NULL,
  FOREIGN KEY (tenant_id, award_id) REFERENCES awards (tenant_id, id),
  FOREIGN KEY (tenant_id, project_line_id) REFERENCES project_lines (tenant_id, id),
  FOREIGN KEY (tenant_id, bid_id) REFERENCES bids (tenant_id, id)
);

-- Teklif içeriği, puan ve değerlendirmeler değişmez.
CREATE TRIGGER bid_lines_immutable BEFORE UPDATE OR DELETE ON bid_lines FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
CREATE TRIGGER bid_costs_immutable BEFORE UPDATE OR DELETE ON bid_costs FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
CREATE TRIGGER bid_scores_immutable BEFORE UPDATE OR DELETE ON bid_scores FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
CREATE TRIGGER evaluations_immutable BEFORE UPDATE OR DELETE ON evaluations FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
CREATE TRIGGER award_lines_immutable BEFORE UPDATE OR DELETE ON award_lines FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
CREATE TRIGGER criteria_immutable BEFORE UPDATE OR DELETE ON evaluation_criteria FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

-- RLS ---------------------------------------------------------------------------------------------
-- Alıcı tarafı: kiracı + şirket kapsamı. Tedarikçi portalı: yalnız davet edildiği proje ve kendi kayıtları.
CREATE OR REPLACE FUNCTION app_invited_project(p_project uuid) RETURNS boolean
  LANGUAGE sql STABLE AS $$
  SELECT app_supplier_id() IS NOT NULL AND EXISTS (
    SELECT 1 FROM rfq_invitations i WHERE i.project_id = p_project AND i.supplier_id = app_supplier_id() AND i.tenant_id = app_tenant_id())
$$;

ALTER TABLE tenant_counters ENABLE ROW LEVEL SECURITY;
CREATE POLICY scope ON tenant_counters USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id());
GRANT SELECT, INSERT, UPDATE (value) ON tenant_counters TO sp_app;

DO $$
DECLARE t text;
BEGIN
  -- Yalnız alıcı kapsamı (tedarikçi hiç göremez).
  FOREACH t IN ARRAY ARRAY['bid_scores','project_fx_rates','evaluations','awards','award_lines'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY scope ON %I USING (tenant_id = app_tenant_id() AND company_id = ANY (app_company_ids())) '
                   'WITH CHECK (tenant_id = app_tenant_id() AND company_id = ANY (app_company_ids()))', t);
    EXECUTE format('GRANT SELECT, INSERT ON %I TO sp_app', t);
  END LOOP;
END $$;

ALTER TABLE projects ENABLE ROW LEVEL SECURITY;
CREATE POLICY scope ON projects
  USING (tenant_id = app_tenant_id() AND (company_id = ANY (app_company_ids()) OR app_invited_project(id)))
  WITH CHECK (tenant_id = app_tenant_id() AND company_id = ANY (app_company_ids()));
GRANT SELECT, INSERT ON projects TO sp_app;
GRANT UPDATE (title, category, need, currency, budget, budget_verified, cost_center, delivery_location, needed_by, status,
  cancel_reason, row_version, updated_at) ON projects TO sp_app;

ALTER TABLE project_lines ENABLE ROW LEVEL SECURITY;
CREATE POLICY scope ON project_lines
  USING (tenant_id = app_tenant_id() AND (company_id = ANY (app_company_ids()) OR app_invited_project(project_id)))
  WITH CHECK (tenant_id = app_tenant_id() AND company_id = ANY (app_company_ids()));
GRANT SELECT, INSERT ON project_lines TO sp_app;
GRANT UPDATE (retired_at) ON project_lines TO sp_app;

ALTER TABLE evaluation_criteria ENABLE ROW LEVEL SECURITY;
CREATE POLICY scope ON evaluation_criteria
  USING (tenant_id = app_tenant_id() AND (company_id = ANY (app_company_ids()) OR app_invited_project(project_id)))
  WITH CHECK (tenant_id = app_tenant_id() AND company_id = ANY (app_company_ids()));
GRANT SELECT, INSERT ON evaluation_criteria TO sp_app;

ALTER TABLE rfq_rounds ENABLE ROW LEVEL SECURITY;
CREATE POLICY scope ON rfq_rounds
  USING (tenant_id = app_tenant_id() AND (company_id = ANY (app_company_ids()) OR app_invited_project(project_id)))
  WITH CHECK (tenant_id = app_tenant_id() AND company_id = ANY (app_company_ids()));
GRANT SELECT, INSERT ON rfq_rounds TO sp_app;
GRANT UPDATE (status, approved_by, approved_at, closed_at, close_reason) ON rfq_rounds TO sp_app;

ALTER TABLE rfq_invitations ENABLE ROW LEVEL SECURITY;
CREATE POLICY scope ON rfq_invitations
  USING (tenant_id = app_tenant_id() AND (company_id = ANY (app_company_ids()) OR supplier_id = app_supplier_id()))
  WITH CHECK (tenant_id = app_tenant_id() AND company_id = ANY (app_company_ids()));
GRANT SELECT, INSERT ON rfq_invitations TO sp_app;

-- Teklif başlığı: alıcı kapsamı (alındı bilgisi) veya kendi teklifi. Ekleme yalnız tedarikçinin kendisi.
ALTER TABLE bids ENABLE ROW LEVEL SECURITY;
CREATE POLICY scope ON bids
  USING (tenant_id = app_tenant_id() AND (company_id = ANY (app_company_ids()) OR supplier_id = app_supplier_id()))
  WITH CHECK (tenant_id = app_tenant_id() AND supplier_id = app_supplier_id());
GRANT SELECT, INSERT ON bids TO sp_app;
GRANT UPDATE (status) ON bids TO sp_app;

-- Teklif içeriği: tedarikçi kendi teklifini her zaman; alıcı yalnız tur kapandıktan sonra (mühür, BR06).
CREATE OR REPLACE FUNCTION app_bid_visible(p_bid uuid) RETURNS boolean
  LANGUAGE sql STABLE AS $$
  SELECT EXISTS (
    SELECT 1 FROM bids b JOIN rfq_rounds r ON r.id = b.round_id
    WHERE b.id = p_bid AND b.tenant_id = app_tenant_id() AND (
      b.supplier_id = app_supplier_id()
      OR (b.company_id = ANY (app_company_ids()) AND (r.status = 'CLOSED' OR r.closes_at <= now()))))
$$;
CREATE OR REPLACE FUNCTION app_own_bid(p_bid uuid) RETURNS boolean
  LANGUAGE sql STABLE AS $$
  SELECT EXISTS (SELECT 1 FROM bids b WHERE b.id = p_bid AND b.tenant_id = app_tenant_id() AND b.supplier_id = app_supplier_id())
$$;
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['bid_lines','bid_costs'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY scope ON %I USING (tenant_id = app_tenant_id() AND app_bid_visible(bid_id)) '
                   'WITH CHECK (tenant_id = app_tenant_id() AND app_own_bid(bid_id))', t);
    EXECUTE format('GRANT SELECT, INSERT ON %I TO sp_app', t);
  END LOOP;
END $$;

ALTER TABLE rfq_questions ENABLE ROW LEVEL SECURITY;
CREATE POLICY scope ON rfq_questions
  USING (tenant_id = app_tenant_id() AND (company_id = ANY (app_company_ids()) OR supplier_id = app_supplier_id()
    OR (answered_at IS NOT NULL AND app_invited_project(project_id))))
  WITH CHECK (tenant_id = app_tenant_id() AND (supplier_id = app_supplier_id() OR company_id = ANY (app_company_ids())));
GRANT SELECT, INSERT ON rfq_questions TO sp_app;
GRANT UPDATE (answer, answered_by, answered_at) ON rfq_questions TO sp_app;

GRANT UPDATE (status, decided_by, decided_at, decision_note) ON awards TO sp_app;
