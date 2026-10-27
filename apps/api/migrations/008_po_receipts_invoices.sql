-- 008 Faz 4: sipariş, mal/hizmet kabulü, fatura ve satır tahsisi, istisna/onay, tolerans, ERP aktarımı.
-- Ödeme yürütme yok. Tamamlanmış mali kayıt silinmez; iade/ters kabul ters kayıttır (BR11). Limit kontrolü atomik (BR07).

CREATE TABLE purchase_orders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  company_id uuid NOT NULL,
  code text NOT NULL,
  supplier_id uuid NOT NULL,
  contract_version_id uuid,
  project_id uuid,
  currency char(3) NOT NULL,
  status text NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN','CANCELLED')),
  cancel_reason text,
  issued_by uuid NOT NULL REFERENCES users(id),
  issued_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, code),
  FOREIGN KEY (tenant_id, company_id) REFERENCES legal_entities (tenant_id, id),
  FOREIGN KEY (tenant_id, supplier_id) REFERENCES suppliers (tenant_id, id),
  FOREIGN KEY (tenant_id, contract_version_id) REFERENCES contract_versions (tenant_id, id),
  FOREIGN KEY (tenant_id, project_id) REFERENCES projects (tenant_id, id),
  CHECK ((status = 'CANCELLED') = (cancel_reason IS NOT NULL))
);
CREATE TABLE po_lines (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  company_id uuid NOT NULL,
  po_id uuid NOT NULL,
  line_no int NOT NULL,
  kind text NOT NULL CHECK (kind IN ('GOODS','SERVICE')),
  description text NOT NULL,
  unit text NOT NULL,
  quantity numeric(20,6) NOT NULL CHECK (quantity > 0),
  unit_price numeric(20,6) NOT NULL CHECK (unit_price >= 0),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, po_id, line_no),
  FOREIGN KEY (tenant_id, po_id) REFERENCES purchase_orders (tenant_id, id)
);

-- Kabul: pozitif kabul veya negatif ters kabul (özgün kayda bağlı). Kabul görevi kabulün kendisi değildir.
CREATE TABLE receipts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  company_id uuid NOT NULL,
  po_line_id uuid NOT NULL,
  quantity numeric(20,6) NOT NULL CHECK (quantity <> 0),
  period_from date,
  period_to date,
  reverses_id uuid,
  note text NOT NULL CHECK (length(note) >= 3),
  recorded_by uuid NOT NULL REFERENCES users(id),
  recorded_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, po_line_id) REFERENCES po_lines (tenant_id, id),
  FOREIGN KEY (tenant_id, reverses_id) REFERENCES receipts (tenant_id, id),
  CHECK ((quantity < 0) = (reverses_id IS NOT NULL)),
  CHECK (period_to IS NULL OR period_from IS NULL OR period_to >= period_from)
);

CREATE TABLE tolerance_rules (
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  currency char(3) NOT NULL,
  abs_amount numeric(20,2),
  percent numeric(7,4),
  combine text NOT NULL CHECK (combine IN ('LOWER','HIGHER')),
  created_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, currency),
  CHECK (abs_amount IS NOT NULL OR percent IS NOT NULL)
);

CREATE TABLE invoices (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  company_id uuid NOT NULL,
  supplier_id uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN ('INVOICE','CREDIT_NOTE','ADVANCE')),
  invoice_no text NOT NULL,
  ettn uuid,
  issue_date date NOT NULL,
  currency char(3) NOT NULL,
  document_version_id uuid,
  original_invoice_id uuid,
  -- Avans mahsubu: aynı tedarikçinin onaylı avans faturasından düşülen tutar (ödenecek tutarı azaltır, tüketimi değil).
  advance_invoice_id uuid,
  advance_offset numeric(20,2) NOT NULL DEFAULT 0 CHECK (advance_offset >= 0),
  -- Hukuki e-belge durumu kurum içi onaydan ayrıdır.
  legal_status text NOT NULL DEFAULT 'RECEIVED' CHECK (legal_status IN ('RECEIVED','LEGALLY_CANCELLED','LEGALLY_REJECTED')),
  payment_status text NOT NULL DEFAULT 'NOT_PAID' CHECK (payment_status IN ('NOT_PAID','PAID')),
  created_by uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, supplier_id, invoice_no),
  FOREIGN KEY (tenant_id, supplier_id) REFERENCES suppliers (tenant_id, id),
  FOREIGN KEY (tenant_id, company_id) REFERENCES legal_entities (tenant_id, id),
  FOREIGN KEY (tenant_id, original_invoice_id) REFERENCES invoices (tenant_id, id),
  FOREIGN KEY (tenant_id, advance_invoice_id) REFERENCES invoices (tenant_id, id),
  CHECK ((kind = 'CREDIT_NOTE') = (original_invoice_id IS NOT NULL))
);
-- Mükerrer ETTN (T17): aynı tedarikçi ve ETTN için tek mali kayıt.
CREATE UNIQUE INDEX invoices_ettn ON invoices (tenant_id, supplier_id, ettn) WHERE ettn IS NOT NULL;

CREATE TABLE invoice_lines (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  company_id uuid NOT NULL,
  invoice_id uuid NOT NULL,
  line_no int NOT NULL,
  description text NOT NULL,
  quantity numeric(20,6) NOT NULL CHECK (quantity > 0),
  unit text NOT NULL,
  unit_price numeric(20,6) NOT NULL CHECK (unit_price >= 0),
  net_amount numeric(20,2) NOT NULL CHECK (net_amount >= 0),
  tax_rate numeric(5,2) NOT NULL DEFAULT 20 CHECK (tax_rate >= 0),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, invoice_id, line_no),
  FOREIGN KEY (tenant_id, invoice_id) REFERENCES invoices (tenant_id, id)
);

-- Satır tahsisi: sipariş satırına veya doğrudan sözleşmeye. Onaydan sonra değişmez.
CREATE TABLE invoice_allocations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  company_id uuid NOT NULL,
  invoice_id uuid NOT NULL,
  line_no int NOT NULL,
  po_line_id uuid,
  contract_version_id uuid,
  quantity numeric(20,6) NOT NULL CHECK (quantity > 0),
  amount numeric(20,2) NOT NULL CHECK (amount > 0),
  created_by uuid NOT NULL REFERENCES users(id),
  FOREIGN KEY (tenant_id, invoice_id) REFERENCES invoices (tenant_id, id),
  FOREIGN KEY (tenant_id, invoice_id, line_no) REFERENCES invoice_lines (tenant_id, invoice_id, line_no),
  FOREIGN KEY (tenant_id, po_line_id) REFERENCES po_lines (tenant_id, id),
  FOREIGN KEY (tenant_id, contract_version_id) REFERENCES contract_versions (tenant_id, id)
);

-- Karar kaydı: istisna onayı (kontrol parmak izine bağlı), finans onayı, ret. Değişmez.
CREATE TABLE invoice_decisions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  company_id uuid NOT NULL,
  invoice_id uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN ('EXCEPTION_APPROVAL','APPROVAL','REJECTION')),
  check_hash text NOT NULL,
  issues jsonb NOT NULL DEFAULT '[]',
  reason text,
  decided_by uuid NOT NULL REFERENCES users(id),
  decided_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, invoice_id) REFERENCES invoices (tenant_id, id),
  CHECK (kind = 'APPROVAL' OR length(coalesce(reason, '')) >= 10)
);
CREATE UNIQUE INDEX invoice_one_final ON invoice_decisions (tenant_id, invoice_id) WHERE kind IN ('APPROVAL','REJECTION');

-- Aynı fatura/olay tekrar geldiğinde görünür iz (T17).
CREATE TABLE invoice_intake_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  company_id uuid NOT NULL,
  invoice_id uuid NOT NULL,
  source text NOT NULL,
  duplicate boolean NOT NULL,
  received_by uuid REFERENCES users(id),
  received_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, invoice_id) REFERENCES invoices (tenant_id, id)
);

-- ERP aktarımı: dış sistemin durumu (saklanır). Zaman aşımı "başarısız" değil "belirsiz"dir; önce sorgulanır (T18).
CREATE TABLE erp_exports (
  invoice_id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  company_id uuid NOT NULL,
  idempotency_key text NOT NULL,
  status text NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','UNKNOWN','CONFIRMED','FAILED','NOT_CONFIGURED')),
  external_id text,
  attempts int NOT NULL DEFAULT 0,
  post_calls int NOT NULL DEFAULT 0,
  last_error text,
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, idempotency_key),
  FOREIGN KEY (tenant_id, invoice_id) REFERENCES invoices (tenant_id, id)
);

-- Gelen entegrasyon olayları (ERP muhasebe/ödeme durumu). Aynı olay tekrar gelirse tek değişiklik + tekrar sayacı.
CREATE TABLE integration_inbox (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  company_id uuid NOT NULL,
  source text NOT NULL,
  event_id text NOT NULL,
  payload jsonb NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(),
  repeat_count int NOT NULL DEFAULT 0,
  last_repeat_at timestamptz,
  UNIQUE (tenant_id, source, event_id)
);

CREATE OR REPLACE FUNCTION allocations_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM invoice_decisions d WHERE d.invoice_id = coalesce(OLD.invoice_id, NEW.invoice_id) AND d.kind IN ('APPROVAL','REJECTION')) THEN
    RAISE EXCEPTION 'immutable_record: allocations of a decided invoice' USING ERRCODE = 'P0001';
  END IF;
  RETURN coalesce(NEW, OLD);
END $$;
CREATE TRIGGER allocations_guard BEFORE INSERT OR DELETE ON invoice_allocations FOR EACH ROW EXECUTE FUNCTION allocations_guard();
CREATE TRIGGER receipts_immutable BEFORE UPDATE OR DELETE ON receipts FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
CREATE TRIGGER po_lines_immutable BEFORE UPDATE OR DELETE ON po_lines FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
CREATE TRIGGER invoice_lines_immutable BEFORE UPDATE OR DELETE ON invoice_lines FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
CREATE TRIGGER invoice_decisions_immutable BEFORE UPDATE OR DELETE ON invoice_decisions FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
CREATE TRIGGER invoice_intake_immutable BEFORE UPDATE OR DELETE ON invoice_intake_events FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['purchase_orders','po_lines','receipts','invoices','invoice_lines','invoice_allocations','invoice_decisions',
    'invoice_intake_events','erp_exports','integration_inbox'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY scope ON %I USING (tenant_id = app_tenant_id() AND company_id = ANY (app_company_ids())) '
                   'WITH CHECK (tenant_id = app_tenant_id() AND company_id = ANY (app_company_ids()))', t);
    EXECUTE format('GRANT SELECT, INSERT ON %I TO sp_app', t);
  END LOOP;
END $$;
GRANT DELETE ON invoice_allocations TO sp_app;
GRANT UPDATE (status, cancel_reason) ON purchase_orders TO sp_app;
GRANT UPDATE (legal_status, payment_status, advance_invoice_id, advance_offset) ON invoices TO sp_app;
GRANT UPDATE (status, external_id, attempts, post_calls, last_error, updated_at) ON erp_exports TO sp_app;
GRANT UPDATE (repeat_count, last_repeat_at) ON integration_inbox TO sp_app;

ALTER TABLE tolerance_rules ENABLE ROW LEVEL SECURITY;
CREATE POLICY scope ON tolerance_rules USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id());
GRANT SELECT, INSERT ON tolerance_rules TO sp_app;
GRANT UPDATE (abs_amount, percent, combine, created_by, created_at) ON tolerance_rules TO sp_app;
