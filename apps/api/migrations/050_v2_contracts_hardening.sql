-- v2 Faz 3 (D108+) Görev 2 inceleme düzeltmesi. 048 uygulanmış olduğundan değiştirilmez; düzeltmeler burada.
-- (1) R6 onaycı salt okur: sözleşme alt tabloları ve belge yolu (031) WITH CHECK'i ailenin departman kapsamına sıkılaştırılır;
--     okuma (USING) üst kaydı devralmaya devam eder. obligation_events, renewal_decisions ve sla_measurements devre eklenir.
-- (2) email_outbox okuma: tüm departmanı gören bağlam ya da alıcının kendisi.
-- (3) Gönderimdeki vekil anlık kaydı görünürlük vermez (atanan, karar veren, şu anki etkin vekil kalır).
-- (4) Kapanmış zincire adım eklenmez, adımına karar yazılmaz. (5) Zincir/hatırlatıcı tutarlılığı. (6) superseded_at bir kez yazılır.
-- (7) Gönderilmiş (SENT) e-posta satırı değişmez. Veri silinmez.

-- 1. Yazma kapsamı: sözleşme sürümünün ailesi bu oturumun departman kapsamında mı (onaycı görünürlüğü yazma yetkisi vermez).
CREATE OR REPLACE FUNCTION app_contract_version_writable(cv uuid) RETURNS boolean
  LANGUAGE sql STABLE SET search_path = public, pg_temp AS $$
  SELECT app_department_all() OR EXISTS (SELECT 1 FROM contract_versions v JOIN contract_families f ON f.id = v.family_id
                                         WHERE v.id = cv AND app_department_ok(f.department_id))
$$;

DO $$
DECLARE r record;
BEGIN
  FOR r IN SELECT * FROM (VALUES
    -- (alt tablo, okuma için üst tablo, üst anahtar sütunu, yazma için sürüm kimliği ifadesi)
    ('contract_parties', 'contract_versions', 'contract_version_id', 'contract_parties.contract_version_id'),
    ('contract_obligations', 'contract_versions', 'contract_version_id', 'contract_obligations.contract_version_id'),
    ('contract_guarantees', 'contract_versions', 'contract_version_id', 'contract_guarantees.contract_version_id'),
    ('price_revision_rules', 'contract_versions', 'contract_version_id', 'price_revision_rules.contract_version_id'),
    ('sla_terms', 'contract_versions', 'contract_version_id', 'sla_terms.contract_version_id'),
    ('signature_requirements', 'contract_versions', 'contract_version_id', 'signature_requirements.contract_version_id'),
    ('signature_detection_runs', 'contract_versions', 'contract_version_id', 'signature_detection_runs.contract_version_id'),
    ('signature_exceptions', 'contract_versions', 'contract_version_id', 'signature_exceptions.contract_version_id'),
    ('digital_validations', 'contract_versions', 'contract_version_id', 'digital_validations.contract_version_id'),
    ('original_custody_events', 'contract_versions', 'contract_version_id', 'original_custody_events.contract_version_id'),
    ('renewal_decisions', 'contract_versions', 'contract_version_id', 'renewal_decisions.contract_version_id'),
    ('signature_reviews', 'signature_requirements', 'requirement_id',
       '(SELECT x.contract_version_id FROM signature_requirements x WHERE x.id = signature_reviews.requirement_id)'),
    ('obligation_events', 'contract_obligations', 'obligation_id',
       '(SELECT x.contract_version_id FROM contract_obligations x WHERE x.id = obligation_events.obligation_id)'),
    ('sla_measurements', 'sla_terms', 'sla_term_id',
       '(SELECT x.contract_version_id FROM sla_terms x WHERE x.id = sla_measurements.sla_term_id)')
  ) v(child, parent, fk, cv) LOOP
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = r.child AND column_name = r.fk) THEN
      RAISE EXCEPTION 'department policy: %.% does not exist', r.child, r.fk;
    END IF;
    EXECUTE format('DROP POLICY IF EXISTS dept ON %I', r.child);
    EXECUTE format('CREATE POLICY dept ON %1$I AS RESTRICTIVE FOR ALL USING (app_department_all() OR EXISTS (SELECT 1 FROM %2$I p WHERE p.id = %1$I.%3$I)) '
                   'WITH CHECK (app_contract_version_writable(%4$s))', r.child, r.parent, r.fk, r.cv);
  END LOOP;
END $$;

-- Belge yolu: yazma kontrolü 031'deki departman kuralıyla (onaycı OR'u olmadan) yapılır; okuma 048'deki işlevle kalır.
CREATE OR REPLACE FUNCTION app_document_version_hidden_for_write(dv uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT dv IS NOT NULL AND (
    EXISTS (SELECT 1 FROM contract_versions cv JOIN contract_families f ON f.id = cv.family_id
            WHERE cv.document_version_id = dv AND NOT coalesce(app_department_ok(f.department_id), false))
    OR EXISTS (SELECT 1 FROM invoices i WHERE i.document_version_id = dv AND NOT coalesce(app_department_ok(i.department_id), false))
    OR EXISTS (SELECT 1 FROM assessment_answers aa JOIN supplier_assessments a ON a.id = aa.assessment_id
               WHERE aa.evidence_document_version_id = dv AND NOT coalesce(app_department_ok(a.department_id), false))
    OR EXISTS (SELECT 1 FROM signature_requirements x JOIN contract_versions cv ON cv.id = x.contract_version_id JOIN contract_families f ON f.id = cv.family_id
               WHERE x.document_version_id = dv AND NOT coalesce(app_department_ok(f.department_id), false))
    OR EXISTS (SELECT 1 FROM signature_detection_runs x JOIN contract_versions cv ON cv.id = x.contract_version_id JOIN contract_families f ON f.id = cv.family_id
               WHERE x.document_version_id = dv AND NOT coalesce(app_department_ok(f.department_id), false))
    OR EXISTS (SELECT 1 FROM signature_reviews x JOIN signature_requirements r ON r.id = x.requirement_id JOIN contract_versions cv ON cv.id = r.contract_version_id
               JOIN contract_families f ON f.id = cv.family_id WHERE x.document_version_id = dv AND NOT coalesce(app_department_ok(f.department_id), false))
    OR EXISTS (SELECT 1 FROM contract_guarantees x JOIN contract_versions cv ON cv.id = x.contract_version_id JOIN contract_families f ON f.id = cv.family_id
               WHERE x.document_version_id = dv AND NOT coalesce(app_department_ok(f.department_id), false))
    OR EXISTS (SELECT 1 FROM sla_measurements x JOIN sla_terms t ON t.id = x.sla_term_id JOIN contract_versions cv ON cv.id = t.contract_version_id
               JOIN contract_families f ON f.id = cv.family_id WHERE x.document_version_id = dv AND NOT coalesce(app_department_ok(f.department_id), false))
  )
$$;
CREATE OR REPLACE FUNCTION app_document_hidden_for_write(doc uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT EXISTS (SELECT 1 FROM document_versions v WHERE v.document_id = doc AND app_document_version_hidden_for_write(v.id))
$$;
CREATE OR REPLACE FUNCTION app_document_version_blocked_for_write(dv uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT dv IS NOT NULL AND EXISTS (SELECT 1 FROM document_versions v WHERE v.id = dv AND app_document_hidden_for_write(v.document_id))
$$;
REVOKE ALL ON FUNCTION app_document_version_hidden_for_write(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION app_document_hidden_for_write(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION app_document_version_blocked_for_write(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_document_version_hidden_for_write(uuid) TO sp_app;
GRANT EXECUTE ON FUNCTION app_document_hidden_for_write(uuid) TO sp_app;
GRANT EXECUTE ON FUNCTION app_document_version_blocked_for_write(uuid) TO sp_app;

DROP POLICY IF EXISTS dept ON documents;
CREATE POLICY dept ON documents AS RESTRICTIVE FOR ALL
  USING (app_department_all() OR NOT app_document_hidden(id)) WITH CHECK (app_department_all() OR NOT app_document_hidden_for_write(id));
DROP POLICY IF EXISTS dept ON document_versions;
CREATE POLICY dept ON document_versions AS RESTRICTIVE FOR ALL
  USING (app_department_all() OR NOT app_document_hidden(document_id)) WITH CHECK (app_department_all() OR NOT app_document_hidden_for_write(document_id));
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['extracted_fields','einvoice_checks','supplier_document_links','ai_runs','signature_detections'] LOOP
    EXECUTE format('DROP POLICY IF EXISTS dept ON %I', t);
    EXECUTE format('CREATE POLICY dept ON %I AS RESTRICTIVE FOR ALL USING (app_department_all() OR NOT app_document_version_blocked(document_version_id)) '
                   'WITH CHECK (app_department_all() OR NOT app_document_version_blocked_for_write(document_version_id))', t);
  END LOOP;
END $$;

-- 2. E-posta kuyruğu: okuma ve güncelleme tüm departmanı gören bağlamda ya da alıcının kendisine; ekleme kiracı içi iç bağlamda.
DROP POLICY IF EXISTS scope ON email_outbox;
CREATE POLICY read ON email_outbox FOR SELECT
  USING (tenant_id = app_tenant_id() AND app_supplier_id() IS NULL AND (app_department_all() OR to_user_id = app_user_id()));
CREATE POLICY add ON email_outbox FOR INSERT
  WITH CHECK (tenant_id = app_tenant_id() AND app_supplier_id() IS NULL);
CREATE POLICY change ON email_outbox FOR UPDATE
  USING (tenant_id = app_tenant_id() AND app_supplier_id() IS NULL AND (app_department_all() OR to_user_id = app_user_id()))
  WITH CHECK (tenant_id = app_tenant_id() AND app_supplier_id() IS NULL);

-- 7. Gönderilmiş satır değişmez.
CREATE OR REPLACE FUNCTION email_outbox_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status = 'SENT' THEN
    RAISE EXCEPTION 'immutable_record: email_outbox' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER email_outbox_guard BEFORE UPDATE ON email_outbox FOR EACH ROW EXECUTE FUNCTION email_outbox_guard();

-- 3. Onaycı görünürlüğü: atanmış kişi, karar veren ya da açık adımın şu anki etkin vekili (anlık vekil kaydı sütunu kalır, görünürlük vermez).
CREATE OR REPLACE FUNCTION app_is_contract_approver(p_family_id uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT app_user_id() IS NOT NULL AND app_tenant_id() IS NOT NULL AND EXISTS (
    SELECT 1 FROM contract_approval_chains c JOIN contract_approval_steps s ON s.chain_id = c.id
    WHERE c.family_id = p_family_id AND c.tenant_id = app_tenant_id()
      AND (s.assigned_user_id = app_user_id() OR s.decided_by = app_user_id()
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

-- 4. Adım koruması: kapanmış zincire adım eklenmez, adımına karar yazılmaz (zincir RLS'den bağımsız okunur).
CREATE OR REPLACE FUNCTION contract_approval_steps_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'immutable_record: contract_approval_steps' USING ERRCODE = 'P0001';
  END IF;
  IF EXISTS (SELECT 1 FROM contract_approval_chains c WHERE c.id = NEW.chain_id AND c.closed_at IS NOT NULL) THEN
    RAISE EXCEPTION 'immutable_record: contract_approval_chains closed' USING ERRCODE = 'P0001';
  END IF;
  IF TG_OP = 'UPDATE' AND (OLD.decision IS NOT NULL
     OR (NEW.tenant_id, NEW.chain_id, NEW.step_order, NEW.kind, NEW.department_id, NEW.assigned_user_id, NEW.via_deputy, NEW.deputy_user_id)
        IS DISTINCT FROM (OLD.tenant_id, OLD.chain_id, OLD.step_order, OLD.kind, OLD.department_id, OLD.assigned_user_id, OLD.via_deputy, OLD.deputy_user_id)) THEN
    RAISE EXCEPTION 'immutable_record: contract_approval_steps' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS contract_approval_steps_guard ON contract_approval_steps;
CREATE TRIGGER contract_approval_steps_guard BEFORE INSERT OR UPDATE OR DELETE ON contract_approval_steps FOR EACH ROW EXECUTE FUNCTION contract_approval_steps_guard();

-- 5. Tutarlılık: zincirin sürümü aileye, koşul revizyonu o sürüme; hatırlatıcının koşul revizyonu aileye ait olmalı.
CREATE OR REPLACE FUNCTION contract_approval_chains_consistent() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM contract_versions v WHERE v.id = NEW.version_id AND v.family_id = NEW.family_id) THEN
    RAISE EXCEPTION 'inconsistent_record: contract_approval_chains.version_id' USING ERRCODE = 'P0001';
  END IF;
  IF NEW.terms_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM contract_terms t WHERE t.id = NEW.terms_id AND t.contract_version_id = NEW.version_id) THEN
    RAISE EXCEPTION 'inconsistent_record: contract_approval_chains.terms_id' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER contract_approval_chains_consistent BEFORE INSERT ON contract_approval_chains FOR EACH ROW EXECUTE FUNCTION contract_approval_chains_consistent();
CREATE OR REPLACE FUNCTION contract_reminders_consistent() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM contract_terms t JOIN contract_versions v ON v.id = t.contract_version_id
                 WHERE t.id = NEW.terms_id AND v.family_id = NEW.family_id) THEN
    RAISE EXCEPTION 'inconsistent_record: contract_reminders.terms_id' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER contract_reminders_consistent BEFORE INSERT OR UPDATE OF terms_id, family_id ON contract_reminders FOR EACH ROW EXECUTE FUNCTION contract_reminders_consistent();

-- 6. Şablon sürümü: superseded_at yalnız NULL → değer; başka sütun değişmez.
CREATE OR REPLACE FUNCTION contract_template_versions_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.superseded_at IS NOT NULL
     OR (NEW.tenant_id, NEW.template_id, NEW.version_no, NEW.document_version_id, NEW.valid_from, NEW.uploaded_by, NEW.created_at)
        IS DISTINCT FROM (OLD.tenant_id, OLD.template_id, OLD.version_no, OLD.document_version_id, OLD.valid_from, OLD.uploaded_by, OLD.created_at) THEN
    RAISE EXCEPTION 'immutable_record: contract_template_versions' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER contract_template_versions_guard BEFORE UPDATE ON contract_template_versions FOR EACH ROW EXECUTE FUNCTION contract_template_versions_guard();
