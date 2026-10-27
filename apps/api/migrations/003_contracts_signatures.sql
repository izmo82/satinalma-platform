-- 003 Sözleşme sürümü ve imza kontrolü (06_IMZA_KONTROLU.md, SIG01–SIG16).
-- Beş gerçek ayrı kayıttadır: görsel tespit, insan incelemesi, fiziksel asıl, e-imza doğrulaması, istisna.
-- Türetilmiş sonuç saklanan serbest bir alan değildir; packages/domain/src/signature.ts hesaplar.

CREATE TABLE contract_families (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  company_id uuid NOT NULL,
  title text NOT NULL,
  supplier_id uuid,
  created_by uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, company_id) REFERENCES legal_entities (tenant_id, id),
  FOREIGN KEY (tenant_id, supplier_id) REFERENCES suppliers (tenant_id, id)
);

CREATE TABLE contract_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  company_id uuid NOT NULL,
  family_id uuid NOT NULL,
  version_no int NOT NULL CHECK (version_no > 0),
  kind text NOT NULL DEFAULT 'MAIN' CHECK (kind IN ('MAIN','AMENDMENT','ANNEX','SOW')),
  document_version_id uuid NOT NULL,
  stage text NOT NULL DEFAULT 'DRAFT' CHECK (stage IN ('DRAFT','EXECUTION','ARCHIVE_IMPORT')),
  signature_method text NOT NULL DEFAULT 'PENDING_CLASSIFICATION'
    CHECK (signature_method IN ('WET_IMAGE_REVIEW','QUALIFIED_ELECTRONIC','ELECTRONIC_OTHER','HYBRID','NOT_REQUIRED','PENDING_CLASSIFICATION')),
  original_custody_required boolean NOT NULL DEFAULT false,
  effective_date date,
  -- Yerine geçen sürüm geldiğinde dolar; eski sürümün delilleri korunur ama güncel değildir.
  superseded_by_id uuid REFERENCES contract_versions(id),
  signature_finalized_at timestamptz,
  signature_finalized_by uuid REFERENCES users(id),
  signature_finalized_status text,
  row_version int NOT NULL DEFAULT 1,
  created_by uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, family_id, version_no),
  FOREIGN KEY (tenant_id, family_id) REFERENCES contract_families (tenant_id, id),
  FOREIGN KEY (tenant_id, document_version_id) REFERENCES document_versions (tenant_id, id),
  CHECK (signature_finalized_status IS NULL OR signature_finalized_status IN ('COMPLETE','EXCEPTION_ACTIVE','NOT_REQUIRED'))
);

CREATE TABLE contract_parties (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  company_id uuid NOT NULL,
  contract_version_id uuid NOT NULL,
  party_role text NOT NULL CHECK (party_role IN ('BUYER','SUPPLIER','OTHER')),
  legal_entity_id uuid,
  supplier_id uuid,
  display_name text NOT NULL,
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, contract_version_id) REFERENCES contract_versions (tenant_id, id)
);

CREATE TABLE signature_requirements (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  company_id uuid NOT NULL,
  contract_version_id uuid NOT NULL,
  document_version_id uuid NOT NULL,
  party_id uuid NOT NULL,
  signer_role text NOT NULL,
  requirement_count int NOT NULL DEFAULT 1 CHECK (requirement_count BETWEEN 1 AND 20),
  acceptable_methods text[] NOT NULL CHECK (array_length(acceptable_methods, 1) >= 1
    AND acceptable_methods <@ ARRAY['WET_IMAGE_REVIEW','QUALIFIED_ELECTRONIC','ELECTRONIC_OTHER']::text[]),
  required boolean NOT NULL DEFAULT true,
  page int,
  region jsonb,
  attachment_scope text NOT NULL DEFAULT 'MAIN_DOCUMENT',
  policy_version text NOT NULL,
  retired_at timestamptz,
  created_by uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, contract_version_id) REFERENCES contract_versions (tenant_id, id),
  FOREIGN KEY (tenant_id, party_id) REFERENCES contract_parties (tenant_id, id),
  FOREIGN KEY (tenant_id, document_version_id) REFERENCES document_versions (tenant_id, id)
);

-- Görsel tespit işi: belge hash + sağlayıcı/model sürümü + politika + kapsam bazında idempotent (T30).
CREATE TABLE signature_detection_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  company_id uuid NOT NULL,
  contract_version_id uuid NOT NULL,
  document_version_id uuid NOT NULL,
  document_sha256 char(64) NOT NULL,
  provider text NOT NULL,
  model_version text NOT NULL,
  policy_version text NOT NULL,
  status text NOT NULL CHECK (status IN ('NOT_PROCESSED','CANDIDATE_FOUND','NOT_DETECTED','UNCLEAR','ERROR','UNSUPPORTED')),
  processed_pages int[] NOT NULL DEFAULT '{}',
  total_pages int,
  error_code text,
  job_id uuid REFERENCES jobs(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, contract_version_id, document_sha256, provider, model_version, policy_version),
  FOREIGN KEY (tenant_id, contract_version_id) REFERENCES contract_versions (tenant_id, id)
);

CREATE TABLE signature_detections (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  company_id uuid NOT NULL,
  run_id uuid NOT NULL,
  requirement_id uuid,
  document_version_id uuid NOT NULL,
  document_sha256 char(64) NOT NULL,
  page int NOT NULL CHECK (page >= 1),
  -- Normalize koordinat [0..1]: {x,y,w,h}
  bbox jsonb NOT NULL,
  raw_confidence numeric(5,4),
  detection_status text NOT NULL CHECK (detection_status IN ('CANDIDATE_FOUND','UNCLEAR')),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, run_id) REFERENCES signature_detection_runs (tenant_id, id)
);
CREATE TRIGGER signature_detections_immutable BEFORE UPDATE OR DELETE ON signature_detections
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

-- İnsan incelemesi: değişmez; son karar (requirement, slot) bazında geçerlidir.
CREATE TABLE signature_reviews (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  company_id uuid NOT NULL,
  requirement_id uuid NOT NULL,
  slot int NOT NULL DEFAULT 1 CHECK (slot >= 1),
  detection_id uuid,
  document_version_id uuid NOT NULL,
  document_sha256 char(64) NOT NULL,
  reviewer_id uuid NOT NULL REFERENCES users(id),
  decision text NOT NULL CHECK (decision IN ('IMAGE_CONFIRMED','MISSING','UNCLEAR')),
  -- T27: kaşe/paraf/isim tam imza değildir; IMAGE_CONFIRMED yalnız FULL_SIGNATURE ile.
  observed_mark text NOT NULL CHECK (observed_mark IN ('FULL_SIGNATURE','STAMP_ONLY','INITIALS_ONLY','NAME_ONLY','NONE','ILLEGIBLE')),
  rationale text NOT NULL CHECK (length(btrim(rationale)) >= 3),
  page int,
  evidence_reference text,
  reviewed_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, requirement_id) REFERENCES signature_requirements (tenant_id, id),
  FOREIGN KEY (tenant_id, detection_id) REFERENCES signature_detections (tenant_id, id),
  CHECK (decision <> 'IMAGE_CONFIRMED' OR observed_mark = 'FULL_SIGNATURE')
);
CREATE TRIGGER signature_reviews_immutable BEFORE UPDATE OR DELETE ON signature_reviews
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

CREATE TABLE original_custody_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  company_id uuid NOT NULL,
  contract_version_id uuid NOT NULL,
  status text NOT NULL CHECK (status IN ('RECEIPT_DECLARED','CUSTODY_CONFIRMED')),
  location text NOT NULL,
  responsible_user_id uuid NOT NULL REFERENCES users(id),
  occurred_at timestamptz NOT NULL,
  evidence_reference text,
  recorded_by uuid NOT NULL REFERENCES users(id),
  recorded_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, contract_version_id) REFERENCES contract_versions (tenant_id, id)
);
CREATE TRIGGER original_custody_immutable BEFORE UPDATE OR DELETE ON original_custody_events
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

CREATE TABLE digital_validations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  company_id uuid NOT NULL,
  contract_version_id uuid NOT NULL,
  requirement_id uuid,
  signed_file_sha256 char(64) NOT NULL,
  validator text NOT NULL,
  status text NOT NULL CHECK (status IN ('NOT_CHECKED','VALIDATED','INVALID','INDETERMINATE')),
  report_reference text,
  blocked_reason text,
  validated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, contract_version_id) REFERENCES contract_versions (tenant_id, id),
  -- T35: VALIDATED yalnız gerçek doğrulayıcı raporuyla.
  CHECK (status <> 'VALIDATED' OR report_reference IS NOT NULL)
);
CREATE TRIGGER digital_validations_immutable BEFORE UPDATE OR DELETE ON digital_validations
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

CREATE TABLE signature_exceptions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  company_id uuid NOT NULL,
  contract_version_id uuid NOT NULL,
  requirement_ids uuid[] NOT NULL CHECK (array_length(requirement_ids, 1) >= 1),
  status text NOT NULL DEFAULT 'REQUESTED' CHECK (status IN ('REQUESTED','APPROVED','REJECTED')),
  reason text NOT NULL,
  residual_risk text NOT NULL,
  scope text NOT NULL,
  expires_at timestamptz NOT NULL,
  requested_by uuid NOT NULL REFERENCES users(id),
  decided_by uuid REFERENCES users(id),
  decided_at timestamptz,
  decision_rationale text,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, contract_version_id) REFERENCES contract_versions (tenant_id, id),
  CHECK (decided_by IS NULL OR decided_by <> requested_by)
);

-- RLS: imza kayıtları ve kesitleri belge ile aynı şirket kapsamına tabidir (SIG14, T38).
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['contract_families','contract_versions','contract_parties','signature_requirements',
    'signature_detection_runs','signature_detections','signature_reviews','original_custody_events',
    'digital_validations','signature_exceptions'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY scope ON %I USING (tenant_id = app_tenant_id() AND company_id = ANY (app_company_ids())) '
                   'WITH CHECK (tenant_id = app_tenant_id() AND company_id = ANY (app_company_ids()))', t);
    EXECUTE format('GRANT SELECT, INSERT ON %I TO sp_app', t);
  END LOOP;
END $$;
GRANT UPDATE (stage, signature_method, original_custody_required, superseded_by_id, signature_finalized_at,
              signature_finalized_by, signature_finalized_status, row_version, effective_date) ON contract_versions TO sp_app;
GRANT UPDATE (retired_at) ON signature_requirements TO sp_app;
GRANT UPDATE (status, decided_by, decided_at, decision_rationale) ON signature_exceptions TO sp_app;

-- Worker'ın kiracılar arası kuyruktan iş çekmesi için dar kapı. Dönen iş daha sonra
-- yalnız kendi kiracı bağlamında ve isteyen kullanıcının güncel üyeliği doğrulanarak işlenir.
CREATE OR REPLACE FUNCTION claim_jobs(p_kinds text[], p_limit int)
RETURNS TABLE (id uuid, tenant_id uuid, company_id uuid, kind text, requested_by uuid)
LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = public AS $$
  UPDATE jobs j SET status = 'RUNNING', attempts = j.attempts + 1, updated_at = now()
  WHERE j.id IN (
    SELECT id FROM jobs WHERE status = 'QUEUED' AND run_after <= now() AND kind = ANY (p_kinds)
    ORDER BY run_after FOR UPDATE SKIP LOCKED LIMIT least(p_limit, 50)
  )
  RETURNING j.id, j.tenant_id, j.company_id, j.kind, j.requested_by
$$;
GRANT EXECUTE ON FUNCTION claim_jobs(text[], int) TO sp_app;
