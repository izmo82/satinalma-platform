-- 053 v2 Faz 6 (D111): yıllık tedarikçi risk değerlendirmesi şeması — soru setleri (ağırlıklı Evet/Hayır), kiracı son tarih ayarı,
-- tedarikçi + yıl başına tek değerlendirme, değişmez revizyonlar, aksiyon/kontrol satırları, çeyreklik gözden geçirme, departman
-- görüşleri ve Excel içe aktarım partileri. Departman görünürlüğü ve katkıcı departman 054'tedir.
-- Kurallar:
--  * v1 tabloları (supplier_assessments, assessment_answers, karne) değişmez; bu dosya mevcut hiçbir tabloya dokunmaz.
--  * Her yeni tablo tenant_id + RLS + en dar GRANT; satır silme yok (taslak setin sorusu hariç; yayımlanmış set tetikleyiciyle kapalı).
--  * Kritiklik 6 hane saklanır (Faz 6 Ruling 2; domain riskV2.criticality value), skor 0–100 2 hane, ağırlık 2 hane.
--  * Aksiyon durumları domain completionBlockers ile aynı adlardır: OPEN (açık), DONE (tamamlandı), VERIFIED (doğrulandı), CANCELLED.
--  * Tedarikçi oturumu: risk_assessments, risk_assessment_revisions ve (yalnız supplier_visible) risk_actions'ta kendi kartının satırları;
--    diğer risk tablolarında hiç satır. Tedarikçi bağlamı hiçbir risk tablosuna yazamaz. Portal yalnız seçilmiş alanları döndürür (R13).

-- 1. Matris (Excel `Risk Grafiği`; domain RISK_MATRIX ile birebir). Bant üst sınırı dahil: [0,20], (20,40], (40,60], (60,80], (80,100] (R2).
CREATE OR REPLACE FUNCTION risk_matrix_level(p_score numeric, p_column int) RETURNS smallint
  LANGUAGE sql IMMUTABLE AS $$
  SELECT ((ARRAY[[1,1,2,2,3],[1,2,2,3,3],[2,2,3,3,4],[2,3,3,4,5],[3,3,4,5,5]])
          [CASE WHEN p_score <= 20 THEN 1 WHEN p_score <= 40 THEN 2 WHEN p_score <= 60 THEN 3 WHEN p_score <= 80 THEN 4 ELSE 5 END]
          [p_column])::smallint
$$;
REVOKE ALL ON FUNCTION risk_matrix_level(numeric, int) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION risk_matrix_level(numeric, int) TO sp_app;

-- 2. Soru setleri (R3). Taslak düzenlenir; yayımlanan set ve soruları değişmez (yalnız PUBLISHED → RETIRED). Kod başına tek yayımlanmış sürüm.
CREATE TABLE risk_question_sets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  code text NOT NULL CHECK (code ~ '^[A-Za-z0-9_.-]{2,40}$'),
  version int NOT NULL CHECK (version > 0),
  name text NOT NULL CHECK (length(btrim(name)) BETWEEN 2 AND 200),
  scope_note text CHECK (scope_note IS NULL OR length(scope_note) <= 2000),
  status text NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT','PUBLISHED','RETIRED')),
  created_by uuid NOT NULL REFERENCES users(id),
  published_by uuid REFERENCES users(id),
  published_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, code, version),
  CHECK ((status = 'DRAFT') = (published_at IS NULL) AND (published_at IS NULL) = (published_by IS NULL))
);
CREATE UNIQUE INDEX risk_question_sets_one_published ON risk_question_sets (tenant_id, code) WHERE status = 'PUBLISHED';

CREATE TABLE risk_questions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  set_id uuid NOT NULL,
  ordinal int NOT NULL CHECK (ordinal > 0),
  code text NOT NULL CHECK (code ~ '^[A-Za-z0-9_.-]{1,40}$'),
  text text NOT NULL CHECK (length(btrim(text)) BETWEEN 3 AND 2000),
  weight numeric(8,2) NOT NULL CHECK (weight > 0),
  risk_answer text NOT NULL DEFAULT 'YES' CHECK (risk_answer IN ('YES','NO')),
  guidance text CHECK (guidance IS NULL OR length(guidance) <= 2000),
  UNIQUE (tenant_id, id),
  UNIQUE (set_id, code),
  FOREIGN KEY (tenant_id, set_id) REFERENCES risk_question_sets (tenant_id, id)
);
CREATE INDEX risk_questions_set_idx ON risk_questions (set_id, ordinal);

-- Yayımlanmış/emekli set: kimlik ve içerik değişmez; tek geçiş PUBLISHED → RETIRED. Taslak geri alınamaz, set silinmez.
CREATE OR REPLACE FUNCTION risk_question_sets_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'immutable_record: risk_question_sets' USING ERRCODE = 'P0001';
  END IF;
  IF (NEW.tenant_id, NEW.code, NEW.version, NEW.created_by, NEW.created_at) IS DISTINCT FROM (OLD.tenant_id, OLD.code, OLD.version, OLD.created_by, OLD.created_at) THEN
    RAISE EXCEPTION 'immutable_record: risk_question_sets' USING ERRCODE = 'P0001';
  END IF;
  IF OLD.status = 'RETIRED'
     OR (OLD.status = 'PUBLISHED' AND (NEW.status <> 'RETIRED' OR (NEW.name, NEW.scope_note, NEW.published_by, NEW.published_at)
                                        IS DISTINCT FROM (OLD.name, OLD.scope_note, OLD.published_by, OLD.published_at)))
     OR (OLD.status = 'DRAFT' AND NEW.status = 'RETIRED') THEN
    RAISE EXCEPTION 'immutable_record: risk_question_sets' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER risk_question_sets_guard BEFORE UPDATE OR DELETE ON risk_question_sets FOR EACH ROW EXECUTE FUNCTION risk_question_sets_guard();

-- Soru yalnız taslak sete eklenir, taslakta değişir/silinir; yayımlanmış ya da emekli setin sorusu değişmez, silinmez, yeni soru eklenmez.
CREATE OR REPLACE FUNCTION risk_questions_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE v_status text;
BEGIN
  SELECT s.status INTO v_status FROM risk_question_sets s WHERE s.id = CASE WHEN TG_OP = 'INSERT' THEN NEW.set_id ELSE OLD.set_id END;
  IF v_status IS DISTINCT FROM 'DRAFT' THEN
    RAISE EXCEPTION 'immutable_record: risk_questions (set %)', coalesce(v_status, 'missing') USING ERRCODE = 'P0001';
  END IF;
  IF TG_OP = 'UPDATE' AND (NEW.tenant_id, NEW.set_id) IS DISTINCT FROM (OLD.tenant_id, OLD.set_id) THEN
    RAISE EXCEPTION 'immutable_record: risk_questions' USING ERRCODE = 'P0001';
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END $$;
CREATE TRIGGER risk_questions_guard BEFORE INSERT OR UPDATE OR DELETE ON risk_questions FOR EACH ROW EXECUTE FUNCTION risk_questions_guard();

-- 3. Kiracı ayarı: görev son tarihi (gün). Kiracı başına tek satır.
CREATE TABLE risk_settings (
  tenant_id uuid PRIMARY KEY REFERENCES tenants(id),
  due_days int NOT NULL DEFAULT 90 CHECK (due_days BETWEEN 7 AND 365),
  updated_by uuid REFERENCES users(id),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- 4. Değerlendirme (R5): tedarikçi + yıl başına tek satır. Taslak (draft) serbest JSON; tamamlanmış sonuç revizyondadır.
--    draft: { criteria, questionSetId, answers, manualScore, manualNote }.
CREATE TABLE risk_assessments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  supplier_id uuid NOT NULL,
  year int NOT NULL CHECK (year BETWEEN 2000 AND 2100),
  department_id uuid,
  responsible_team text CHECK (responsible_team IS NULL OR length(responsible_team) <= 200),
  services text CHECK (services IS NULL OR length(services) <= 4000),
  status text NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN','COMPLETED','CANCELLED')),
  source text NOT NULL CHECK (source IN ('CYCLE','IMPORT','MANUAL')),
  due_on date,
  draft jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(draft) = 'object'),
  prior_assessment_id uuid,
  opened_by uuid REFERENCES users(id),
  opened_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  completed_by uuid REFERENCES users(id),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, supplier_id, year),
  FOREIGN KEY (tenant_id, supplier_id) REFERENCES suppliers (tenant_id, id),
  FOREIGN KEY (tenant_id, department_id) REFERENCES departments (tenant_id, id),
  FOREIGN KEY (tenant_id, prior_assessment_id) REFERENCES risk_assessments (tenant_id, id),
  CHECK (prior_assessment_id IS NULL OR prior_assessment_id <> id),
  CHECK (status <> 'COMPLETED' OR (completed_at IS NOT NULL AND completed_by IS NOT NULL)),
  CHECK ((completed_at IS NULL) = (completed_by IS NULL))
);
CREATE INDEX risk_assessments_year_idx ON risk_assessments (tenant_id, year, status);
CREATE INDEX risk_assessments_department_idx ON risk_assessments (department_id);
CREATE INDEX risk_assessments_supplier_idx ON risk_assessments (tenant_id, supplier_id, year DESC);
CREATE TRIGGER risk_assessments_no_delete BEFORE DELETE ON risk_assessments FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

-- 5. Revizyon: tamamlanan (ya da güncellenen) sonucun değişmez anlık kaydı. Seviye matristen türetilmiş olmalıdır (domain ile aynı tablo).
CREATE TABLE risk_assessment_revisions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  assessment_id uuid NOT NULL,
  revision_no int NOT NULL CHECK (revision_no > 0),
  criteria jsonb NOT NULL CHECK (jsonb_typeof(criteria) = 'object'),
  criticality numeric(7,6) NOT NULL CHECK (criticality BETWEEN 1 AND 5),
  criticality_column smallint NOT NULL CHECK (criticality_column BETWEEN 1 AND 5),
  question_set_id uuid,
  answers jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(answers) = 'object'),
  score_source text NOT NULL CHECK (score_source IN ('QUESTIONS','MANUAL_RESULT','IMPORT')),
  risk_score numeric(5,2) NOT NULL CHECK (risk_score BETWEEN 0 AND 100),
  score_note text CHECK (score_note IS NULL OR length(score_note) <= 2000),
  level smallint NOT NULL CHECK (level BETWEEN 1 AND 5),
  method_version text NOT NULL CHECK (length(btrim(method_version)) BETWEEN 1 AND 100),
  changed_fields text[] NOT NULL DEFAULT '{}',
  created_by uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (assessment_id, revision_no),
  FOREIGN KEY (tenant_id, assessment_id) REFERENCES risk_assessments (tenant_id, id),
  FOREIGN KEY (tenant_id, question_set_id) REFERENCES risk_question_sets (tenant_id, id),
  CHECK (score_source <> 'QUESTIONS' OR question_set_id IS NOT NULL),
  CHECK (level = risk_matrix_level(risk_score, criticality_column))
);
CREATE INDEX risk_assessment_revisions_assessment_idx ON risk_assessment_revisions (assessment_id, revision_no DESC);
CREATE TRIGGER risk_assessment_revisions_immutable BEFORE UPDATE OR DELETE ON risk_assessment_revisions
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

-- Soru cevabı yalnız yayımlanmış (ya da sonradan emekli) setle revizyona girer; taslak setle sonuç yazılmaz (R3/R4).
CREATE OR REPLACE FUNCTION risk_assessment_revisions_set_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.question_set_id IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM risk_question_sets s WHERE s.id = NEW.question_set_id AND s.status IN ('PUBLISHED','RETIRED')) THEN
    RAISE EXCEPTION 'risk_question_set_not_published' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER risk_assessment_revisions_set_guard BEFORE INSERT ON risk_assessment_revisions
  FOR EACH ROW EXECUTE FUNCTION risk_assessment_revisions_set_guard();

-- 6. Aksiyon ve denetim/kontrol satırları (R9). CONTROL'de yöntem zorunlu, MITIGATION'da yok. Kapanan satırın kapanış alanları bir kez yazılır:
--    DONE yalnız VERIFIED'e geçer; VERIFIED ve CANCELLED değişmez. Satır silinmez (iptal edilir).
CREATE TABLE risk_actions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  assessment_id uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN ('MITIGATION','CONTROL')),
  control_method text CHECK (control_method IN ('ON_SITE','ONLINE','DESK')),
  title text NOT NULL CHECK (length(btrim(title)) BETWEEN 2 AND 500),
  description text CHECK (description IS NULL OR length(description) <= 4000),
  owner_user_id uuid REFERENCES users(id),
  owner_text text CHECK (owner_text IS NULL OR length(owner_text) <= 200),
  due_on date,
  supplier_visible boolean NOT NULL DEFAULT false,
  status text NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN','DONE','VERIFIED','CANCELLED')),
  completed_at timestamptz,
  completed_by uuid REFERENCES users(id),
  completion_note text CHECK (completion_note IS NULL OR length(completion_note) <= 2000),
  source text NOT NULL DEFAULT 'MANUAL' CHECK (source IN ('MANUAL','IMPORT')),
  created_by uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, assessment_id) REFERENCES risk_assessments (tenant_id, id),
  CHECK ((kind = 'CONTROL') = (control_method IS NOT NULL)),
  CHECK ((completed_at IS NULL) = (completed_by IS NULL)),
  CHECK (status NOT IN ('DONE','VERIFIED') OR completed_at IS NOT NULL)
);
CREATE INDEX risk_actions_assessment_idx ON risk_actions (assessment_id, created_at);
CREATE INDEX risk_actions_owner_idx ON risk_actions (owner_user_id) WHERE owner_user_id IS NOT NULL;

CREATE OR REPLACE FUNCTION risk_actions_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'immutable_record: risk_actions' USING ERRCODE = 'P0001';
  END IF;
  IF (NEW.tenant_id, NEW.assessment_id, NEW.kind, NEW.source, NEW.created_by, NEW.created_at)
     IS DISTINCT FROM (OLD.tenant_id, OLD.assessment_id, OLD.kind, OLD.source, OLD.created_by, OLD.created_at) THEN
    RAISE EXCEPTION 'immutable_record: risk_actions' USING ERRCODE = 'P0001';
  END IF;
  IF OLD.status IN ('VERIFIED','CANCELLED')
     OR (OLD.status = 'DONE' AND (NEW.status <> 'VERIFIED'
         OR (NEW.control_method, NEW.title, NEW.description, NEW.owner_user_id, NEW.owner_text, NEW.due_on, NEW.supplier_visible,
             NEW.completed_at, NEW.completed_by, NEW.completion_note)
            IS DISTINCT FROM (OLD.control_method, OLD.title, OLD.description, OLD.owner_user_id, OLD.owner_text, OLD.due_on, OLD.supplier_visible,
                              OLD.completed_at, OLD.completed_by, OLD.completion_note))) THEN
    RAISE EXCEPTION 'immutable_record: risk_actions (status %)', OLD.status USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER risk_actions_guard BEFORE UPDATE OR DELETE ON risk_actions FOR EACH ROW EXECUTE FUNCTION risk_actions_guard();

-- 7. Çeyreklik gözden geçirme (R10): değerlendirme + dönem ('YYYY-Ç') başına tek karar; değişmez.
CREATE TABLE risk_reviews (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  assessment_id uuid NOT NULL,
  period text NOT NULL CHECK (period ~ '^[0-9]{4}-[1-4]$'),
  outcome text NOT NULL CHECK (outcome IN ('NO_CHANGE','UPDATED')),
  revision_id uuid,
  decided_by uuid NOT NULL REFERENCES users(id),
  decided_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (assessment_id, period),
  FOREIGN KEY (tenant_id, assessment_id) REFERENCES risk_assessments (tenant_id, id),
  FOREIGN KEY (tenant_id, revision_id) REFERENCES risk_assessment_revisions (tenant_id, id),
  CHECK (outcome <> 'UPDATED' OR revision_id IS NOT NULL)
);
CREATE TRIGGER risk_reviews_immutable BEFORE UPDATE OR DELETE ON risk_reviews FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

-- 8. Görüş (R5): sorumlu ya da katkıcı departmanın yorumu; değişmez.
CREATE TABLE risk_opinions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  assessment_id uuid NOT NULL,
  department_id uuid,
  author_id uuid NOT NULL REFERENCES users(id),
  body text NOT NULL CHECK (length(btrim(body)) BETWEEN 3 AND 4000),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, assessment_id) REFERENCES risk_assessments (tenant_id, id),
  FOREIGN KEY (tenant_id, department_id) REFERENCES departments (tenant_id, id)
);
CREATE INDEX risk_opinions_assessment_idx ON risk_opinions (assessment_id, created_at);
CREATE TRIGGER risk_opinions_immutable BEFORE UPDATE OR DELETE ON risk_opinions FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

-- 9. İçe aktarım (R11): yükle → önizle → uygula. Aynı dosya (sha256) bir kez uygulanır. Ham satır her hücreyi saklar (veri kaybı yok).
CREATE TABLE risk_import_batches (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  file_sha256 text NOT NULL CHECK (file_sha256 ~ '^[0-9a-f]{64}$'),
  file_name text NOT NULL CHECK (length(file_name) BETWEEN 1 AND 255),
  period text CHECK (period IS NULL OR period ~ '^[0-9]{4}-[1-4]$'),
  year int NOT NULL CHECK (year BETWEEN 2000 AND 2100),
  fraction_scale boolean NOT NULL,
  status text NOT NULL DEFAULT 'PREVIEW' CHECK (status IN ('PREVIEW','APPLIED','DISCARDED')),
  team_mapping jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(team_mapping) = 'object'),
  summary jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(summary) = 'object'),
  uploaded_by uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  applied_by uuid REFERENCES users(id),
  applied_at timestamptz,
  UNIQUE (tenant_id, id),
  CHECK ((status = 'APPLIED') = (applied_at IS NOT NULL) AND (applied_at IS NULL) = (applied_by IS NULL))
);
CREATE UNIQUE INDEX risk_import_batches_applied_once ON risk_import_batches (tenant_id, file_sha256) WHERE status = 'APPLIED';
CREATE INDEX risk_import_batches_created_idx ON risk_import_batches (tenant_id, created_at DESC);

CREATE OR REPLACE FUNCTION risk_import_batches_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' OR OLD.status <> 'PREVIEW'
     OR (NEW.tenant_id, NEW.file_sha256, NEW.file_name, NEW.uploaded_by, NEW.created_at)
        IS DISTINCT FROM (OLD.tenant_id, OLD.file_sha256, OLD.file_name, OLD.uploaded_by, OLD.created_at) THEN
    RAISE EXCEPTION 'immutable_record: risk_import_batches' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER risk_import_batches_guard BEFORE UPDATE OR DELETE ON risk_import_batches FOR EACH ROW EXECUTE FUNCTION risk_import_batches_guard();

CREATE TABLE risk_import_rows (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  batch_id uuid NOT NULL,
  row_no int NOT NULL CHECK (row_no > 0),
  raw jsonb NOT NULL CHECK (jsonb_typeof(raw) = 'object'),
  supplier_id uuid,
  decision text NOT NULL DEFAULT 'SKIP' CHECK (decision IN ('CREATE','SKIP','MERGE','NEW_CANDIDATE')),
  primary_row boolean NOT NULL DEFAULT false,
  issues text[] NOT NULL DEFAULT '{}',
  assessment_id uuid,
  UNIQUE (tenant_id, id),
  UNIQUE (batch_id, row_no),
  FOREIGN KEY (tenant_id, batch_id) REFERENCES risk_import_batches (tenant_id, id),
  FOREIGN KEY (tenant_id, supplier_id) REFERENCES suppliers (tenant_id, id),
  FOREIGN KEY (tenant_id, assessment_id) REFERENCES risk_assessments (tenant_id, id)
);
-- Ham satır ve satır no değişmez; bağlanan değerlendirme bir kez yazılır; uygulanmış/vazgeçilmiş partinin satırları değişmez.
CREATE OR REPLACE FUNCTION risk_import_rows_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE'
     OR (NEW.tenant_id, NEW.batch_id, NEW.row_no, NEW.raw) IS DISTINCT FROM (OLD.tenant_id, OLD.batch_id, OLD.row_no, OLD.raw)
     OR (OLD.assessment_id IS NOT NULL AND NEW.assessment_id IS DISTINCT FROM OLD.assessment_id)
     OR EXISTS (SELECT 1 FROM risk_import_batches b WHERE b.id = OLD.batch_id AND b.status <> 'PREVIEW') THEN
    RAISE EXCEPTION 'immutable_record: risk_import_rows' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER risk_import_rows_guard BEFORE UPDATE OR DELETE ON risk_import_rows FOR EACH ROW EXECUTE FUNCTION risk_import_rows_guard();

-- 10. Seviye 4–5 güvencesi (R9, Review Focus 3): değerlendirme COMPLETED olduğunda (işlem sonunda denetlenir) son revizyonu bulunmalı;
--     son revizyon seviyesi 4–5 ise iptal edilmemiş en az bir MITIGATION ve bir CONTROL satırı bulunmalı. Sahip ve tarih kuralları
--     (gelecek tarih "bugün"e bağlıdır) API'de domain completionBlockers ile denetlenir; bu tetikleyici her yoldan (API, içe aktarım,
--     "Değişiklik yok", doğrudan SQL) planı olmayan seviye 4–5 kaydın tamamlanmasını reddeder.
--     Sahip yetkisiyle okur (çağıranın RLS'i revizyon/aksiyon satırını gizlese de karar aynı olur); yalnız hata ya da hiçbir şey döner.
CREATE OR REPLACE FUNCTION risk_assessments_completion_check() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_level smallint;
BEGIN
  -- Ertelenmiş denetim: satırın işlem sonundaki hâline bakılır.
  IF NOT EXISTS (SELECT 1 FROM risk_assessments a WHERE a.id = NEW.id AND a.status = 'COMPLETED') THEN
    RETURN NULL;
  END IF;
  SELECT r.level INTO v_level FROM risk_assessment_revisions r WHERE r.assessment_id = NEW.id ORDER BY r.revision_no DESC LIMIT 1;
  IF v_level IS NULL THEN
    RAISE EXCEPTION 'risk_completion_blocked: revision_missing' USING ERRCODE = 'P0001';
  END IF;
  IF v_level >= 4 AND (
       NOT EXISTS (SELECT 1 FROM risk_actions x WHERE x.assessment_id = NEW.id AND x.kind = 'MITIGATION' AND x.status <> 'CANCELLED')
       OR NOT EXISTS (SELECT 1 FROM risk_actions x WHERE x.assessment_id = NEW.id AND x.kind = 'CONTROL' AND x.status <> 'CANCELLED')) THEN
    RAISE EXCEPTION 'risk_completion_blocked: action_plan_required' USING ERRCODE = 'P0001';
  END IF;
  RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION risk_assessments_completion_check() FROM PUBLIC;
CREATE CONSTRAINT TRIGGER risk_assessments_completion_check AFTER INSERT OR UPDATE OF status ON risk_assessments
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION risk_assessments_completion_check();

-- 11. RLS (kiracı + tedarikçi). Departman kapsamı ve katkıcı 054'te RESTRICTIVE olarak eklenir.
--     Tedarikçi bağlamı yalnız okur: değerlendirme ve revizyon kendi kartında; aksiyon kendi kartında ve supplier_visible ise.
ALTER TABLE risk_assessments ENABLE ROW LEVEL SECURITY;
CREATE POLICY read ON risk_assessments FOR SELECT
  USING (tenant_id = app_tenant_id() AND (app_supplier_id() IS NULL OR supplier_id = app_supplier_id()));
CREATE POLICY add ON risk_assessments FOR INSERT WITH CHECK (tenant_id = app_tenant_id() AND app_supplier_id() IS NULL);
CREATE POLICY change ON risk_assessments FOR UPDATE
  USING (tenant_id = app_tenant_id() AND app_supplier_id() IS NULL)
  WITH CHECK (tenant_id = app_tenant_id() AND app_supplier_id() IS NULL);

ALTER TABLE risk_assessment_revisions ENABLE ROW LEVEL SECURITY;
CREATE POLICY read ON risk_assessment_revisions FOR SELECT
  USING (tenant_id = app_tenant_id() AND (app_supplier_id() IS NULL OR EXISTS (
    SELECT 1 FROM risk_assessments a WHERE a.id = risk_assessment_revisions.assessment_id AND a.supplier_id = app_supplier_id())));
CREATE POLICY add ON risk_assessment_revisions FOR INSERT WITH CHECK (tenant_id = app_tenant_id() AND app_supplier_id() IS NULL);

ALTER TABLE risk_actions ENABLE ROW LEVEL SECURITY;
CREATE POLICY read ON risk_actions FOR SELECT
  USING (tenant_id = app_tenant_id() AND (app_supplier_id() IS NULL OR (supplier_visible AND EXISTS (
    SELECT 1 FROM risk_assessments a WHERE a.id = risk_actions.assessment_id AND a.supplier_id = app_supplier_id()))));
CREATE POLICY add ON risk_actions FOR INSERT WITH CHECK (tenant_id = app_tenant_id() AND app_supplier_id() IS NULL);
CREATE POLICY change ON risk_actions FOR UPDATE
  USING (tenant_id = app_tenant_id() AND app_supplier_id() IS NULL)
  WITH CHECK (tenant_id = app_tenant_id() AND app_supplier_id() IS NULL);

-- Tedarikçi bağlamına tamamen kapalı tablolar.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['risk_question_sets','risk_questions','risk_settings','risk_reviews','risk_opinions',
                           'risk_import_batches','risk_import_rows'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY scope ON %I USING (tenant_id = app_tenant_id() AND app_supplier_id() IS NULL) '
                   'WITH CHECK (tenant_id = app_tenant_id() AND app_supplier_id() IS NULL)', t);
  END LOOP;
END $$;

-- 12. En dar GRANT. Silme yalnız taslak setin sorusunda (tetikleyici yayımlanmışı reddeder).
GRANT SELECT, INSERT ON risk_question_sets TO sp_app;
GRANT UPDATE (name, scope_note, status, published_by, published_at) ON risk_question_sets TO sp_app;
GRANT SELECT, INSERT, DELETE ON risk_questions TO sp_app;
GRANT UPDATE (ordinal, code, text, weight, risk_answer, guidance) ON risk_questions TO sp_app;
GRANT SELECT, INSERT ON risk_settings TO sp_app;
GRANT UPDATE (due_days, updated_by, updated_at) ON risk_settings TO sp_app;
GRANT SELECT, INSERT ON risk_assessments TO sp_app;
GRANT UPDATE (department_id, responsible_team, services, status, draft, due_on, completed_at, completed_by) ON risk_assessments TO sp_app;
GRANT SELECT, INSERT ON risk_assessment_revisions TO sp_app;
GRANT SELECT, INSERT ON risk_actions TO sp_app;
GRANT UPDATE (control_method, title, description, owner_user_id, owner_text, due_on, supplier_visible, status, completed_at, completed_by,
              completion_note) ON risk_actions TO sp_app;
GRANT SELECT, INSERT ON risk_reviews TO sp_app;
GRANT SELECT, INSERT ON risk_opinions TO sp_app;
GRANT SELECT, INSERT ON risk_import_batches TO sp_app;
GRANT UPDATE (year, period, fraction_scale, status, team_mapping, summary, applied_by, applied_at) ON risk_import_batches TO sp_app;
GRANT SELECT, INSERT ON risk_import_rows TO sp_app;
GRANT UPDATE (supplier_id, decision, primary_row, issues, assessment_id) ON risk_import_rows TO sp_app;
