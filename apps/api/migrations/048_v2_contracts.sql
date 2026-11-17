-- v2 Faz 3 (D108+, analiz-v2 §3.1, R1–R10): sözleşme şeması. Aile alanları (proje, tür, sorumlu, imza tarihi, şablon sürümü,
-- süresiz, isteğe bağlı alanlar), şablon kütüphanesi, onay zinciri ve adımları, hatırlatıcılar ve kiracı süreleri, e-posta kuyruğu,
-- NEW_PROJECT yenileme kararı, TEMPLATE belge türü ve onaycı görünürlüğü (R6). Eski kayıtlar silinmez; yeni sütunlar boş olabilir
-- (eksik alan durumu domain'de türetilir, R1). Durum saklanmaz; zincir ve adım kayıtları tarih olarak kalır.

-- 1. Aile alanları (R2). Proje ve şablon sürümü kiracı içi bileşik anahtarla bağlanır.
ALTER TABLE contract_families ADD COLUMN IF NOT EXISTS project_id uuid;
ALTER TABLE contract_families ADD COLUMN IF NOT EXISTS contract_type text;
ALTER TABLE contract_families ADD COLUMN IF NOT EXISTS owner_user_id uuid REFERENCES users(id);
ALTER TABLE contract_families ADD COLUMN IF NOT EXISTS signed_on date;
ALTER TABLE contract_families ADD COLUMN IF NOT EXISTS template_version_id uuid;
ALTER TABLE contract_families ADD COLUMN IF NOT EXISTS indefinite boolean NOT NULL DEFAULT false;
ALTER TABLE contract_families ADD COLUMN IF NOT EXISTS contract_no text;
ALTER TABLE contract_families ADD COLUMN IF NOT EXISTS governing_court text;
ALTER TABLE contract_families ADD COLUMN IF NOT EXISTS kvkk_clause boolean;
ALTER TABLE contract_families ADD COLUMN IF NOT EXISTS price_escalation text;
ALTER TABLE contract_families ADD CONSTRAINT contract_families_project_fk FOREIGN KEY (tenant_id, project_id) REFERENCES projects (tenant_id, id);
ALTER TABLE contract_families ADD CONSTRAINT contract_families_type_check
  CHECK (contract_type IS NULL OR contract_type IN ('SERVICE','HARDWARE','MAINTENANCE','NDA','CONSULTING','OTHER'));
CREATE INDEX IF NOT EXISTS contract_families_project_idx ON contract_families (project_id);
CREATE INDEX IF NOT EXISTS contract_families_owner_idx ON contract_families (owner_user_id);

-- 2. Belge türü: .docx şablonu.
ALTER TABLE documents DROP CONSTRAINT documents_kind_check;
ALTER TABLE documents ADD CONSTRAINT documents_kind_check CHECK (kind IN ('INVOICE','CONTRACT','QUOTE','OTHER','TEMPLATE'));

-- 3. Şablon kütüphanesi (R8). Yeni sürüm öncekini superseded_at ile geçersiz yapar; sürüm silinmez.
CREATE TABLE contract_templates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  code text NOT NULL CHECK (length(btrim(code)) BETWEEN 1 AND 50),
  name text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 200),
  contract_type text NOT NULL CHECK (contract_type IN ('SERVICE','HARDWARE','MAINTENANCE','NDA','CONSULTING','OTHER')),
  created_by uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, code),
  UNIQUE (tenant_id, id)
);
CREATE TABLE contract_template_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  template_id uuid NOT NULL,
  version_no int NOT NULL CHECK (version_no > 0),
  document_version_id uuid NOT NULL,
  valid_from date NOT NULL,
  superseded_at timestamptz,
  uploaded_by uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (template_id, version_no),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, template_id) REFERENCES contract_templates (tenant_id, id),
  FOREIGN KEY (tenant_id, document_version_id) REFERENCES document_versions (tenant_id, id)
);
-- Bir şablonun aynı anda tek geçerli sürümü olur.
CREATE UNIQUE INDEX contract_template_versions_current ON contract_template_versions (template_id) WHERE superseded_at IS NULL;
CREATE TRIGGER contract_template_versions_no_delete BEFORE DELETE ON contract_template_versions FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
ALTER TABLE contract_families ADD CONSTRAINT contract_families_template_version_fk
  FOREIGN KEY (tenant_id, template_version_id) REFERENCES contract_template_versions (tenant_id, id);

-- 4. Onay zinciri (R4, R5): gönderimde sabitlenir. Ailede aynı anda tek açık zincir; kapanan zincir değişmez, silinmez.
CREATE TABLE contract_approval_chains (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  family_id uuid NOT NULL,
  version_id uuid NOT NULL,
  terms_id uuid NOT NULL,
  submitted_by uuid NOT NULL REFERENCES users(id),
  submitted_at timestamptz NOT NULL DEFAULT now(),
  note text,
  closed_at timestamptz,
  outcome text CHECK (outcome IN ('APPROVED','REJECTED','CANCELLED')),
  cancel_reason text,
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, family_id) REFERENCES contract_families (tenant_id, id),
  FOREIGN KEY (tenant_id, version_id) REFERENCES contract_versions (tenant_id, id),
  FOREIGN KEY (tenant_id, terms_id) REFERENCES contract_terms (tenant_id, id),
  CHECK ((closed_at IS NULL) = (outcome IS NULL)),
  CHECK ((outcome = 'CANCELLED') = (cancel_reason IS NOT NULL) OR (outcome IS NULL AND cancel_reason IS NULL)),
  CHECK (cancel_reason IS NULL OR length(btrim(cancel_reason)) >= 5)
);
CREATE UNIQUE INDEX contract_approval_chains_open ON contract_approval_chains (family_id) WHERE closed_at IS NULL;
CREATE INDEX contract_approval_chains_family_idx ON contract_approval_chains (family_id);

-- Adım: departman sorumlusu / satınalma sorumlusu / satınalma direktörü / ek onaycı. department_id departman sorumlusu adımında
-- gönderim anındaki departmandır (o anki vekil buradan çözülür); deputy_user_id gönderim anındaki vekil (anlık kayıt).
CREATE TABLE contract_approval_steps (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  chain_id uuid NOT NULL,
  step_order int NOT NULL CHECK (step_order > 0),
  kind text NOT NULL CHECK (kind IN ('DEPARTMENT_HEAD','PROCUREMENT_LEAD','PROCUREMENT_DIRECTOR','EXTRA')),
  department_id uuid,
  assigned_user_id uuid NOT NULL REFERENCES users(id),
  via_deputy boolean NOT NULL DEFAULT false,
  deputy_user_id uuid REFERENCES users(id),
  decided_by uuid REFERENCES users(id),
  decided_at timestamptz,
  decision text CHECK (decision IN ('APPROVED','REJECTED')),
  reason text,
  UNIQUE (tenant_id, id),
  UNIQUE (chain_id, step_order),
  FOREIGN KEY (tenant_id, chain_id) REFERENCES contract_approval_chains (tenant_id, id),
  FOREIGN KEY (tenant_id, department_id) REFERENCES departments (tenant_id, id),
  CHECK ((kind = 'DEPARTMENT_HEAD') = (department_id IS NOT NULL)),
  CHECK ((decision IS NULL) = (decided_by IS NULL) AND (decision IS NULL) = (decided_at IS NULL)),
  -- Red gerekçelidir (R5).
  CHECK (decision IS DISTINCT FROM 'REJECTED' OR length(btrim(coalesce(reason, ''))) >= 10)
);
CREATE INDEX contract_approval_steps_assigned_idx ON contract_approval_steps (assigned_user_id);
CREATE INDEX contract_approval_steps_deputy_idx ON contract_approval_steps (deputy_user_id);
CREATE INDEX contract_approval_steps_decided_idx ON contract_approval_steps (decided_by);

-- Zincir yalnız bir kez kapanır; adım kararı yalnız bir kez yazılır; satır silinmez. Kimlik sütunları değişmez.
CREATE OR REPLACE FUNCTION contract_approval_chains_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' OR OLD.closed_at IS NOT NULL
     OR (NEW.tenant_id, NEW.family_id, NEW.version_id, NEW.terms_id, NEW.submitted_by, NEW.submitted_at, NEW.note)
        IS DISTINCT FROM (OLD.tenant_id, OLD.family_id, OLD.version_id, OLD.terms_id, OLD.submitted_by, OLD.submitted_at, OLD.note) THEN
    RAISE EXCEPTION 'immutable_record: contract_approval_chains' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER contract_approval_chains_guard BEFORE UPDATE OR DELETE ON contract_approval_chains FOR EACH ROW EXECUTE FUNCTION contract_approval_chains_guard();
CREATE OR REPLACE FUNCTION contract_approval_steps_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' OR OLD.decision IS NOT NULL
     OR (NEW.tenant_id, NEW.chain_id, NEW.step_order, NEW.kind, NEW.department_id, NEW.assigned_user_id, NEW.via_deputy, NEW.deputy_user_id)
        IS DISTINCT FROM (OLD.tenant_id, OLD.chain_id, OLD.step_order, OLD.kind, OLD.department_id, OLD.assigned_user_id, OLD.via_deputy, OLD.deputy_user_id) THEN
    RAISE EXCEPTION 'immutable_record: contract_approval_steps' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER contract_approval_steps_guard BEFORE UPDATE OR DELETE ON contract_approval_steps FOR EACH ROW EXECUTE FUNCTION contract_approval_steps_guard();

-- 5. Hatırlatıcılar (R7). Aynı koşul revizyonunda aynı tür/süre ikinci kez kurulmaz.
CREATE TABLE contract_reminders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  family_id uuid NOT NULL,
  terms_id uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN ('END','NOTICE')),
  offset_days int NOT NULL CHECK (offset_days BETWEEN 0 AND 3650),
  due_on date NOT NULL,
  task_ids uuid[] NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (terms_id, kind, offset_days),
  FOREIGN KEY (tenant_id, family_id) REFERENCES contract_families (tenant_id, id),
  FOREIGN KEY (tenant_id, terms_id) REFERENCES contract_terms (tenant_id, id)
);
CREATE INDEX contract_reminders_family_idx ON contract_reminders (family_id);
CREATE TRIGGER contract_reminders_no_delete BEFORE DELETE ON contract_reminders FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

-- Kiracı ayarı: hatırlatıcı süreleri (gün). Satır yoksa varsayılan 90,60,30,7 (uygulama varsayılanı aynı).
CREATE TABLE contract_reminder_settings (
  tenant_id uuid PRIMARY KEY REFERENCES tenants(id),
  offsets int[] NOT NULL DEFAULT '{90,60,30,7}'
    CHECK (cardinality(offsets) BETWEEN 1 AND 12 AND 1 <= ALL (offsets) AND 3650 >= ALL (offsets)),
  updated_by uuid REFERENCES users(id),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- 6. Yenileme kararı: "Yeni proje açıldı".
ALTER TABLE renewal_decisions DROP CONSTRAINT renewal_decisions_decision_check;
ALTER TABLE renewal_decisions ADD CONSTRAINT renewal_decisions_decision_check CHECK (decision IN ('RENEW','TERMINATE','RENEGOTIATE','NEW_PROJECT'));

-- 7. E-posta kuyruğu. Gerçek kanal bağlı değilse satır NOT_CONFIGURED kalır; gönderilmiş gibi gösterilmez.
CREATE TABLE email_outbox (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  to_user_id uuid REFERENCES users(id),
  to_email text,
  subject text NOT NULL CHECK (length(subject) BETWEEN 1 AND 300),
  body_text text NOT NULL,
  related_type text,
  related_id uuid,
  status text NOT NULL DEFAULT 'QUEUED' CHECK (status IN ('QUEUED','NOT_CONFIGURED','SENT','FAILED')),
  created_at timestamptz NOT NULL DEFAULT now(),
  sent_at timestamptz,
  error text,
  CHECK (to_user_id IS NOT NULL OR to_email IS NOT NULL),
  CHECK ((status = 'SENT') = (sent_at IS NOT NULL))
);
CREATE INDEX email_outbox_related_idx ON email_outbox (tenant_id, related_type, related_id);
CREATE INDEX email_outbox_queued_idx ON email_outbox (status) WHERE status = 'QUEUED';
CREATE TRIGGER email_outbox_no_delete BEFORE DELETE ON email_outbox FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

-- 8. Onaycı görünürlüğü (R6). Çağıran (app.user_id) bu ailenin herhangi bir zincirinde:
--   (a) adıma atanmış kişi, (b) gönderimde adıma yazılmış vekil, (c) adımı karara bağlayan kişi, ya da
--   (d) açık zincirdeki kararsız adımın unvanında (departman sorumlusu / satınalma sorumlusu / direktör) şu anki etkin vekildir.
-- (d) Faz 2 currentApprovers ile aynıdır: approver_assignments satırındaki vekil, üyeliği etkin, tedarikçi değil, Satınalma ya da
-- Departman kullanıcısı rolünde (eski rol kodları LEGACY_ROLE_MAP ile). Yalnız bool döner; RLS'in gizlediği adımları sahip yetkisiyle okur.
CREATE OR REPLACE FUNCTION app_is_contract_approver(p_family_id uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT app_user_id() IS NOT NULL AND app_tenant_id() IS NOT NULL AND EXISTS (
    SELECT 1 FROM contract_approval_chains c JOIN contract_approval_steps s ON s.chain_id = c.id
    WHERE c.family_id = p_family_id AND c.tenant_id = app_tenant_id()
      AND (s.assigned_user_id = app_user_id() OR s.deputy_user_id = app_user_id() OR s.decided_by = app_user_id()
           OR (s.decision IS NULL AND c.closed_at IS NULL AND s.kind <> 'EXTRA'
               AND EXISTS (SELECT 1 FROM approver_assignments a
                           WHERE a.tenant_id = c.tenant_id AND a.kind = s.kind AND a.department_id IS NOT DISTINCT FROM s.department_id
                             AND a.deputy_user_id = app_user_id())
               AND EXISTS (SELECT 1 FROM memberships m
                           WHERE m.tenant_id = c.tenant_id AND m.user_id = app_user_id() AND m.status = 'ACTIVE' AND m.supplier_id IS NULL
                             AND NOT ('SUPPLIER' = ANY (m.roles))
                             AND m.roles && ARRAY['PROCUREMENT','DEPARTMENT_USER','BUYER','PROCUREMENT_MANAGER','MASTER_DATA','LEGAL','FINANCE',
                                                  'REQUESTER','TECH_EVALUATOR','SECURITY'])))
  )
$$;
REVOKE ALL ON FUNCTION app_is_contract_approver(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_is_contract_approver(uuid) TO sp_app;

-- Aile: departman koşuluna OR onaycı (yalnız okuma; WITH CHECK departman koşulunda kalır, onaycı aileyi yazamaz).
DROP POLICY IF EXISTS dept ON contract_families;
CREATE POLICY dept ON contract_families AS RESTRICTIVE FOR ALL
  USING (app_department_ok(department_id) OR app_is_contract_approver(id))
  WITH CHECK (app_department_ok(department_id));
-- Sürüm ve koşullar: okuma üst kaydı (artık onaycıyı da kapsayan aile politikası) devralır; açıkça da OR'lanır.
-- Yazma, ailenin departman kapsamında kalır (onaycı salt okur).
DROP POLICY IF EXISTS dept ON contract_versions;
CREATE POLICY dept ON contract_versions AS RESTRICTIVE FOR ALL
  USING (app_department_all() OR EXISTS (SELECT 1 FROM contract_families p WHERE p.id = contract_versions.family_id)
         OR app_is_contract_approver(contract_versions.family_id))
  WITH CHECK (app_department_all() OR EXISTS (SELECT 1 FROM contract_families p WHERE p.id = contract_versions.family_id AND app_department_ok(p.department_id)));
DROP POLICY IF EXISTS dept ON contract_terms;
CREATE POLICY dept ON contract_terms AS RESTRICTIVE FOR ALL
  USING (app_department_all() OR EXISTS (SELECT 1 FROM contract_versions p WHERE p.id = contract_terms.contract_version_id))
  WITH CHECK (app_department_all() OR EXISTS (SELECT 1 FROM contract_versions p JOIN contract_families f ON f.id = p.family_id
                                              WHERE p.id = contract_terms.contract_version_id AND app_department_ok(f.department_id)));

-- Belge yolu (031): sözleşme dallarında departman kararı "departman uygun VEYA onaycı" olur. Fatura ve değerlendirme dalları aynen kalır.
CREATE OR REPLACE FUNCTION app_document_version_hidden(dv uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT dv IS NOT NULL AND (
    EXISTS (SELECT 1 FROM contract_versions cv JOIN contract_families f ON f.id = cv.family_id
            WHERE cv.document_version_id = dv AND NOT (coalesce(app_department_ok(f.department_id), false) OR app_is_contract_approver(f.id)))
    OR EXISTS (SELECT 1 FROM invoices i WHERE i.document_version_id = dv AND NOT coalesce(app_department_ok(i.department_id), false))
    OR EXISTS (SELECT 1 FROM assessment_answers aa JOIN supplier_assessments a ON a.id = aa.assessment_id
               WHERE aa.evidence_document_version_id = dv AND NOT coalesce(app_department_ok(a.department_id), false))
    OR EXISTS (SELECT 1 FROM signature_requirements x JOIN contract_versions cv ON cv.id = x.contract_version_id JOIN contract_families f ON f.id = cv.family_id
               WHERE x.document_version_id = dv AND NOT (coalesce(app_department_ok(f.department_id), false) OR app_is_contract_approver(f.id)))
    OR EXISTS (SELECT 1 FROM signature_detection_runs x JOIN contract_versions cv ON cv.id = x.contract_version_id JOIN contract_families f ON f.id = cv.family_id
               WHERE x.document_version_id = dv AND NOT (coalesce(app_department_ok(f.department_id), false) OR app_is_contract_approver(f.id)))
    OR EXISTS (SELECT 1 FROM signature_reviews x JOIN signature_requirements r ON r.id = x.requirement_id JOIN contract_versions cv ON cv.id = r.contract_version_id
               JOIN contract_families f ON f.id = cv.family_id WHERE x.document_version_id = dv AND NOT (coalesce(app_department_ok(f.department_id), false) OR app_is_contract_approver(f.id)))
    OR EXISTS (SELECT 1 FROM contract_guarantees x JOIN contract_versions cv ON cv.id = x.contract_version_id JOIN contract_families f ON f.id = cv.family_id
               WHERE x.document_version_id = dv AND NOT (coalesce(app_department_ok(f.department_id), false) OR app_is_contract_approver(f.id)))
    OR EXISTS (SELECT 1 FROM sla_measurements x JOIN sla_terms t ON t.id = x.sla_term_id JOIN contract_versions cv ON cv.id = t.contract_version_id
               JOIN contract_families f ON f.id = cv.family_id WHERE x.document_version_id = dv AND NOT (coalesce(app_department_ok(f.department_id), false) OR app_is_contract_approver(f.id)))
  )
$$;
REVOKE ALL ON FUNCTION app_document_version_hidden(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_document_version_hidden(uuid) TO sp_app;

-- 9. RLS. Zincir, adım ve hatırlatıcı üst sözleşmenin görünürlüğünü (kiracı + şirket + departman + onaycı) devralır; tedarikçi bağlamı
-- sözleşme ailesini göremediği için bunları da göremez. Şablon, ayar ve e-posta kuyruğu kiracı düzeyidir, tedarikçi bağlamına kapalıdır.
ALTER TABLE contract_approval_chains ENABLE ROW LEVEL SECURITY;
CREATE POLICY scope ON contract_approval_chains
  USING (tenant_id = app_tenant_id() AND EXISTS (SELECT 1 FROM contract_families f WHERE f.id = contract_approval_chains.family_id))
  WITH CHECK (tenant_id = app_tenant_id() AND EXISTS (SELECT 1 FROM contract_families f WHERE f.id = contract_approval_chains.family_id));
ALTER TABLE contract_approval_steps ENABLE ROW LEVEL SECURITY;
CREATE POLICY scope ON contract_approval_steps
  USING (tenant_id = app_tenant_id() AND EXISTS (SELECT 1 FROM contract_approval_chains c WHERE c.id = contract_approval_steps.chain_id))
  WITH CHECK (tenant_id = app_tenant_id() AND EXISTS (SELECT 1 FROM contract_approval_chains c WHERE c.id = contract_approval_steps.chain_id));
ALTER TABLE contract_reminders ENABLE ROW LEVEL SECURITY;
CREATE POLICY scope ON contract_reminders
  USING (tenant_id = app_tenant_id() AND EXISTS (SELECT 1 FROM contract_families f WHERE f.id = contract_reminders.family_id))
  WITH CHECK (tenant_id = app_tenant_id() AND EXISTS (SELECT 1 FROM contract_families f WHERE f.id = contract_reminders.family_id));
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['contract_templates','contract_template_versions','contract_reminder_settings','email_outbox'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY scope ON %I USING (tenant_id = app_tenant_id() AND app_supplier_id() IS NULL) '
                   'WITH CHECK (tenant_id = app_tenant_id() AND app_supplier_id() IS NULL)', t);
  END LOOP;
END $$;

-- 10. En dar GRANT.
GRANT UPDATE (project_id, contract_type, owner_user_id, signed_on, template_version_id, indefinite, contract_no, governing_court, kvkk_clause, price_escalation)
  ON contract_families TO sp_app;
GRANT SELECT, INSERT ON contract_templates TO sp_app;
GRANT SELECT, INSERT ON contract_template_versions TO sp_app;
GRANT UPDATE (superseded_at) ON contract_template_versions TO sp_app;
GRANT SELECT, INSERT ON contract_approval_chains TO sp_app;
GRANT UPDATE (closed_at, outcome, cancel_reason) ON contract_approval_chains TO sp_app;
GRANT SELECT, INSERT ON contract_approval_steps TO sp_app;
GRANT UPDATE (decided_by, decided_at, decision, reason) ON contract_approval_steps TO sp_app;
GRANT SELECT, INSERT ON contract_reminders TO sp_app;
GRANT UPDATE (task_ids) ON contract_reminders TO sp_app;
GRANT SELECT, INSERT ON contract_reminder_settings TO sp_app;
GRANT UPDATE (offsets, updated_by, updated_at) ON contract_reminder_settings TO sp_app;
GRANT SELECT, INSERT ON email_outbox TO sp_app;
GRANT UPDATE (status, sent_at, error) ON email_outbox TO sp_app;
