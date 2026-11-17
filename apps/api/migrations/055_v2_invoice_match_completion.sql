-- 055 v2 Faz 7 (D112): fatura → sözleşme eşleşmesi, proje "Tamamlandı" durumu, çıkar çatışması beyanı ve uyum kanıtı.
-- Kurallar:
--  * v1 tahsisi (invoice_allocations) aynen kalır; v2 eşleşmesi fatura başlığında tutulur (R1). Bu dosya hiçbir satırı UPDATE etmez.
--  * auto_match önce DEFAULT false NOT NULL ile eklenir: 055 öncesi açılmış her fatura (demo ANB2026000101, ANB2026000102,
--    EGE2026000877 dahil) satırı yeniden yazılmadan false okunur; ardından varsayılan true yapılır, yalnız yeni faturalar otomatik
--    eşleştiriciye girer (R2). auto_match sonradan değiştirilemez (UPDATE izni yok).
--  * ERP referans sütunları yalnız kayıt anında yazılır (UPDATE izni yok).
--  * Yeni tablolar tenant_id + RLS + en dar GRANT; beyan, kanıt ve eşleşme olayları değişmez (yalnız INSERT/SELECT + tetikleyici).
--  * Tedarikçi bağlamı yeni tablolara hiç erişemez; departman kapsamı üst kayıttan (fatura, proje) devralınır (030 alt tablo deseni).

-- 1. Fatura eşleşmesi (R1). Eşleşme durumu türetilir (domain invoiceLinking); burada yalnız saklı bağ.
ALTER TABLE invoices ADD COLUMN contract_family_id uuid;
ALTER TABLE invoices ADD COLUMN project_id uuid;
ALTER TABLE invoices ADD COLUMN match_method text;
ALTER TABLE invoices ADD COLUMN match_note text;
ALTER TABLE invoices ADD COLUMN matched_by uuid REFERENCES users(id);
ALTER TABLE invoices ADD COLUMN matched_at timestamptz;
ALTER TABLE invoices ADD COLUMN erp_contract_ref text;
ALTER TABLE invoices ADD COLUMN erp_order_ref text;
ALTER TABLE invoices ADD COLUMN auto_match boolean NOT NULL DEFAULT false;
ALTER TABLE invoices ALTER COLUMN auto_match SET DEFAULT true;

ALTER TABLE invoices ADD CONSTRAINT invoices_contract_family_fk FOREIGN KEY (tenant_id, contract_family_id) REFERENCES contract_families (tenant_id, id);
ALTER TABLE invoices ADD CONSTRAINT invoices_project_fk FOREIGN KEY (tenant_id, project_id) REFERENCES projects (tenant_id, id);
ALTER TABLE invoices ADD CONSTRAINT invoices_match_method_check CHECK (match_method IN ('ERP_REF','SUPPLIER_DATE','MANUAL'));
-- Bağ, yöntem ve zaman birlikte var ya da yok; proje yalnız bağlı faturada; elle bağın yapanı bilinir.
ALTER TABLE invoices ADD CONSTRAINT invoices_match_shape_check CHECK (
  (contract_family_id IS NULL) = (match_method IS NULL)
  AND (contract_family_id IS NULL) = (matched_at IS NULL)
  AND (contract_family_id IS NOT NULL OR (project_id IS NULL AND matched_by IS NULL))
  AND (match_method IS DISTINCT FROM 'MANUAL' OR matched_by IS NOT NULL));
ALTER TABLE invoices ADD CONSTRAINT invoices_match_note_check CHECK (match_note IS NULL OR length(match_note) <= 2000);
ALTER TABLE invoices ADD CONSTRAINT invoices_erp_refs_check CHECK (
  (erp_contract_ref IS NULL OR length(btrim(erp_contract_ref)) BETWEEN 1 AND 60)
  AND (erp_order_ref IS NULL OR length(btrim(erp_order_ref)) BETWEEN 1 AND 60));

CREATE INDEX invoices_contract_family_idx ON invoices (contract_family_id);
CREATE INDEX invoices_project_idx ON invoices (project_id);
-- "Kuyruğu yeniden dene" adayları: otomatik eşleştirmeye açık ve bağı olmayan faturalar.
CREATE INDEX invoices_match_queue_idx ON invoices (tenant_id, created_at) WHERE auto_match AND contract_family_id IS NULL;

-- Eşleşme sütunları güncellenebilir; ERP referansları ve auto_match yalnız INSERT'te yazılır.
GRANT UPDATE (contract_family_id, project_id, match_method, match_note, matched_by, matched_at) ON invoices TO sp_app;

-- 2. Eşleşme olayları (R3): bağlama, bağ kaldırma (gerekçeli) ve otomatik eşleştirme başarısızlığı. Değişmez kayıt.
CREATE TABLE invoice_match_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  company_id uuid NOT NULL,
  invoice_id uuid NOT NULL,
  action text NOT NULL CHECK (action IN ('LINK','UNLINK','AUTO_FAILED')),
  family_id uuid,
  method text CHECK (method IN ('ERP_REF','SUPPLIER_DATE','MANUAL')),
  reason text CHECK (reason IS NULL OR length(reason) <= 2000),
  actor uuid REFERENCES users(id),
  at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, company_id) REFERENCES legal_entities (tenant_id, id),
  FOREIGN KEY (tenant_id, invoice_id) REFERENCES invoices (tenant_id, id),
  FOREIGN KEY (tenant_id, family_id) REFERENCES contract_families (tenant_id, id),
  CHECK (action <> 'LINK' OR (family_id IS NOT NULL AND method IS NOT NULL)),
  CHECK (action <> 'UNLINK' OR (family_id IS NOT NULL AND length(btrim(coalesce(reason, ''))) >= 10 AND actor IS NOT NULL)),
  CHECK (action <> 'AUTO_FAILED' OR reason IS NOT NULL)
);
CREATE INDEX invoice_match_events_invoice_idx ON invoice_match_events (invoice_id, at);
CREATE TRIGGER invoice_match_events_immutable BEFORE UPDATE OR DELETE ON invoice_match_events FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

ALTER TABLE invoice_match_events ENABLE ROW LEVEL SECURITY;
CREATE POLICY scope ON invoice_match_events
  USING (tenant_id = app_tenant_id() AND company_id = ANY (app_company_ids()) AND app_supplier_id() IS NULL)
  WITH CHECK (tenant_id = app_tenant_id() AND company_id = ANY (app_company_ids()) AND app_supplier_id() IS NULL
              AND EXISTS (SELECT 1 FROM invoices i WHERE i.id = invoice_match_events.invoice_id AND i.company_id = invoice_match_events.company_id));
CREATE POLICY dept ON invoice_match_events AS RESTRICTIVE FOR ALL
  USING (app_department_all() OR EXISTS (SELECT 1 FROM invoices p WHERE p.id = invoice_match_events.invoice_id))
  WITH CHECK (app_department_all() OR EXISTS (SELECT 1 FROM invoices p WHERE p.id = invoice_match_events.invoice_id));
GRANT SELECT, INSERT ON invoice_match_events TO sp_app;

-- 3. Proje "Tamamlandı" (R5). Mevcut durumlar aynen geçerli; COMPLETED eklenir. Tamamlanma günü (Europe/Istanbul) ve yapan birlikte.
ALTER TABLE projects DROP CONSTRAINT projects_status_check;
ALTER TABLE projects ADD CONSTRAINT projects_status_check
  CHECK (status IN ('DRAFT','IN_APPROVAL','OPEN','EVALUATION','AWARD_APPROVAL','CONTRACTING','CANCELLED','NO_AWARD','COMPLETED'));
ALTER TABLE projects ADD COLUMN completed_on date;
ALTER TABLE projects ADD COLUMN completed_by uuid REFERENCES users(id);
ALTER TABLE projects ADD CONSTRAINT projects_completed_check CHECK (
  (completed_on IS NULL) = (completed_by IS NULL) AND (status <> 'COMPLETED' OR completed_on IS NOT NULL));
GRANT UPDATE (completed_on, completed_by) ON projects TO sp_app;

-- 4. Çıkar çatışması beyanı (R9): proje × kullanıcı başına son kayıt geçerlidir; kayıt değişmez, yenisi eklenir.
CREATE TABLE coi_declarations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  company_id uuid NOT NULL,
  project_id uuid NOT NULL,
  user_id uuid NOT NULL REFERENCES users(id),
  kind text NOT NULL CHECK (kind IN ('NONE','DECLARED')),
  statement text CHECK (statement IS NULL OR length(statement) <= 4000),
  declared_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, company_id) REFERENCES legal_entities (tenant_id, id),
  FOREIGN KEY (tenant_id, project_id) REFERENCES projects (tenant_id, id),
  CHECK (kind <> 'DECLARED' OR length(btrim(coalesce(statement, ''))) >= 10)
);
CREATE INDEX coi_declarations_project_idx ON coi_declarations (project_id, user_id, declared_at DESC);
CREATE TRIGGER coi_declarations_immutable BEFORE UPDATE OR DELETE ON coi_declarations FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

-- 5. Uyum kanıtı (R8): projeye yüklenen kanıt belgesi (firma araştırması, ticaret sicil gazetesi, diğer). Değişmez kayıt.
CREATE TABLE compliance_evidence (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  company_id uuid NOT NULL,
  project_id uuid NOT NULL,
  check_key text NOT NULL CHECK (check_key ~ '^[A-Za-z0-9_.-]{1,60}$'),
  document_version_id uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN ('RESEARCH','TRADE_REGISTRY','OTHER')),
  uploaded_by uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, company_id) REFERENCES legal_entities (tenant_id, id),
  FOREIGN KEY (tenant_id, project_id) REFERENCES projects (tenant_id, id),
  FOREIGN KEY (tenant_id, document_version_id) REFERENCES document_versions (tenant_id, id)
);
CREATE INDEX compliance_evidence_project_idx ON compliance_evidence (project_id, check_key, created_at);
CREATE INDEX compliance_evidence_document_version_idx ON compliance_evidence (document_version_id);
CREATE TRIGGER compliance_evidence_immutable BEFORE UPDATE OR DELETE ON compliance_evidence FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

-- 6. RLS: kiracı + şirket, tedarikçi bağlamına kapalı; yazarken satırın şirketi projeninkiyle aynı olmalı (proje çağıranın RLS'iyle
--    görünür olmalı). Departman: proje görünmüyorsa (030 projeler politikası) satır da görünmez/yazılamaz.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['coi_declarations','compliance_evidence'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY scope ON %1$I '
                   'USING (tenant_id = app_tenant_id() AND company_id = ANY (app_company_ids()) AND app_supplier_id() IS NULL) '
                   'WITH CHECK (tenant_id = app_tenant_id() AND company_id = ANY (app_company_ids()) AND app_supplier_id() IS NULL '
                   'AND EXISTS (SELECT 1 FROM projects p WHERE p.id = %1$I.project_id AND p.company_id = %1$I.company_id))', t);
    EXECUTE format('CREATE POLICY dept ON %1$I AS RESTRICTIVE FOR ALL '
                   'USING (app_department_all() OR EXISTS (SELECT 1 FROM projects p WHERE p.id = %1$I.project_id)) '
                   'WITH CHECK (app_department_all() OR EXISTS (SELECT 1 FROM projects p WHERE p.id = %1$I.project_id))', t);
    EXECUTE format('GRANT SELECT, INSERT ON %I TO sp_app', t);
  END LOOP;
END $$;
