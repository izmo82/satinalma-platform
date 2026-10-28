-- Faz 5 kalanları: tedarikçinin portaldan anket yanıtlaması, kategori bazında performans ağırlığı politikası, tasarruf bazı kaydı.

-- 1) Portal anketi: kurum "tedarikçiye gönder" der; tedarikçi yalnız kendine gönderilmiş anketi görür ve yanıtlar, gönderince kilitlenir.
ALTER TABLE supplier_assessments
  ADD COLUMN portal_status text NOT NULL DEFAULT 'NONE' CHECK (portal_status IN ('NONE','SENT','SUBMITTED')),
  ADD COLUMN portal_sent_at timestamptz,
  ADD COLUMN portal_due date,
  ADD COLUMN portal_submitted_at timestamptz,
  ADD CONSTRAINT portal_timestamps CHECK ((portal_status = 'NONE') = (portal_sent_at IS NULL) AND (portal_status = 'SUBMITTED') = (portal_submitted_at IS NOT NULL));
GRANT UPDATE (portal_status, portal_sent_at, portal_due, portal_submitted_at) ON supplier_assessments TO sp_app;

-- Tedarikçi kullanıcısı (app.supplier_id dolu) yalnız kendine gönderilmiş anketi ve yanıtlarını görür; yazma yalnız gönderilmiş (SENT) ankete.
DROP POLICY scope ON supplier_assessments;
CREATE POLICY scope ON supplier_assessments
  USING (tenant_id = app_tenant_id() AND (app_supplier_id() IS NULL OR (supplier_id = app_supplier_id() AND portal_status <> 'NONE')))
  WITH CHECK (tenant_id = app_tenant_id() AND (app_supplier_id() IS NULL OR (supplier_id = app_supplier_id() AND portal_status <> 'NONE')));
DROP POLICY scope ON assessment_answers;
CREATE POLICY scope ON assessment_answers
  USING (tenant_id = app_tenant_id() AND (app_supplier_id() IS NULL OR EXISTS (SELECT 1 FROM supplier_assessments a
    WHERE a.id = assessment_answers.assessment_id AND a.supplier_id = app_supplier_id() AND a.portal_status <> 'NONE')))
  WITH CHECK (tenant_id = app_tenant_id() AND (app_supplier_id() IS NULL OR EXISTS (SELECT 1 FROM supplier_assessments a
    WHERE a.id = assessment_answers.assessment_id AND a.supplier_id = app_supplier_id() AND a.portal_status = 'SENT')));

-- 2) Kategori bazında performans ağırlığı: kategori başına tek yürürlükteki kural; inceleme o anki kuralı kopyalar (geçmiş değişmez).
CREATE TABLE performance_weight_policies (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  category text NOT NULL CHECK (length(btrim(category)) BETWEEN 1 AND 200),
  weights jsonb NOT NULL,
  reason text NOT NULL CHECK (length(btrim(reason)) >= 10),
  set_by uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  retired_at timestamptz
);
CREATE UNIQUE INDEX performance_weight_policies_active ON performance_weight_policies (tenant_id, lower(btrim(category))) WHERE retired_at IS NULL;
ALTER TABLE performance_weight_policies ENABLE ROW LEVEL SECURITY;
CREATE POLICY scope ON performance_weight_policies USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id());
GRANT SELECT, INSERT ON performance_weight_policies TO sp_app;
GRANT UPDATE (retired_at) ON performance_weight_policies TO sp_app;

-- 3) Tasarruf bazı: karşılaştırılabilir baz (bütçe, önceki fiyat, piyasa) önerilir ve ikinci kişi onaylar; onaysız baz rapora girmez.
CREATE TABLE savings_baselines (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  company_id uuid NOT NULL,
  project_id uuid NOT NULL,
  basis text NOT NULL CHECK (basis IN ('BUDGET','PREVIOUS_PRICE','MARKET')),
  amount numeric(20,2) NOT NULL CHECK (amount > 0),
  currency char(3) NOT NULL,
  source text NOT NULL CHECK (length(btrim(source)) >= 10),
  proposed_by uuid NOT NULL REFERENCES users(id),
  proposed_at timestamptz NOT NULL DEFAULT now(),
  status text NOT NULL DEFAULT 'PROPOSED' CHECK (status IN ('PROPOSED','APPROVED','REJECTED')),
  decided_by uuid REFERENCES users(id),
  decided_at timestamptz,
  decision_note text,
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, company_id) REFERENCES legal_entities(tenant_id, id),
  FOREIGN KEY (tenant_id, project_id) REFERENCES projects(tenant_id, id),
  CHECK ((status = 'PROPOSED') = (decided_by IS NULL)),
  CHECK (decided_by IS NULL OR decided_by <> proposed_by)
);
-- Proje başına tek geçerli (önerilmiş veya onaylı) baz.
CREATE UNIQUE INDEX savings_baselines_one ON savings_baselines (project_id) WHERE status IN ('PROPOSED','APPROVED');
ALTER TABLE savings_baselines ENABLE ROW LEVEL SECURITY;
CREATE POLICY scope ON savings_baselines USING (tenant_id = app_tenant_id() AND company_id = ANY (app_company_ids()))
  WITH CHECK (tenant_id = app_tenant_id() AND company_id = ANY (app_company_ids()));
GRANT SELECT, INSERT ON savings_baselines TO sp_app;
GRANT UPDATE (status, decided_by, decided_at, decision_note) ON savings_baselines TO sp_app;
