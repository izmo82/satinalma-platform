-- 058 v2 Faz 8 (D113): ERP'den okunan veri ve elle girilen ERP değerleri (R6).
-- Kurallar:
--  * Yeni sütunlar NULL, varsayılansız eklenir; bu dosya hiçbir satırı UPDATE/DELETE etmez (demo ANB2026000101, ANB2026000102,
--    EGE2026000877 dahil mevcut faturalar aynen kalır).
--  * Her değer kaynağını taşır: ERP | MANUAL; değer ve kaynak birlikte var ya da yok.
--  * Fatura ERP sözleşme/sipariş referansı için Faz 7 (055) sütunları kullanılır: erp_contract_ref ve erp_order_ref (= sipariş
--    referansı, plandaki erp_po_ref). Yeniden eklenmez; 055 kuralı gereği yalnız kayıt anında yazılır.
--  * erp_provider_kind faturanın ERP'den hangi sağlayıcıyla geldiğini tutar (Kaynak: Oracle ERP / Taklit Oracle (gerçek değil));
--    erp_invoice_id ile birlikte var ya da yok, bir kez yazılınca değişmez.
--  * v1 purchase_orders kullanılmaz (kaldırılan akış geri gelmesin); ERP siparişleri salt okunur ayrı tabloda.
--  * Yeni tablolar tenant_id + RLS (tedarikçi bağlamı kapalı) + en dar GRANT; DELETE yok.

-- 1. Tedarikçi ERP kodu (SUPPLIER).
ALTER TABLE suppliers ADD COLUMN erp_supplier_code text;
ALTER TABLE suppliers ADD COLUMN erp_supplier_code_source text;
ALTER TABLE suppliers ADD CONSTRAINT suppliers_erp_code_check CHECK (
  (erp_supplier_code IS NULL OR (length(btrim(erp_supplier_code)) BETWEEN 1 AND 60 AND erp_supplier_code = btrim(erp_supplier_code)))
  AND (erp_supplier_code_source IS NULL OR erp_supplier_code_source IN ('ERP','MANUAL'))
  AND (erp_supplier_code IS NULL) = (erp_supplier_code_source IS NULL));
CREATE INDEX suppliers_erp_code_idx ON suppliers (tenant_id, erp_supplier_code) WHERE erp_supplier_code IS NOT NULL;
GRANT UPDATE (erp_supplier_code, erp_supplier_code_source) ON suppliers TO sp_app;

-- 2. Departman masraf merkezi (COST_CENTER). Departman ana kaynağı Entra kalır; kod ERP listesinden seçilir ya da elle girilir.
ALTER TABLE departments ADD COLUMN cost_center_code text;
ALTER TABLE departments ADD COLUMN cost_center_source text;
ALTER TABLE departments ADD CONSTRAINT departments_cost_center_check CHECK (
  (cost_center_code IS NULL OR (length(btrim(cost_center_code)) BETWEEN 1 AND 60 AND cost_center_code = btrim(cost_center_code)))
  AND (cost_center_source IS NULL OR cost_center_source IN ('ERP','MANUAL'))
  AND (cost_center_code IS NULL) = (cost_center_source IS NULL));
-- departments tablo düzeyinde UPDATE taşıyordu; sütun bazlıya çevrilir. Mevcut sütunların hepsi aynen güncellenebilir kalır.
REVOKE UPDATE ON departments FROM sp_app;
GRANT UPDATE (id, tenant_id, name, created_at, source, normalized_name, merged_into, cost_center_code, cost_center_source) ON departments TO sp_app;

CREATE TABLE erp_cost_centers (
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  code text NOT NULL CHECK (length(btrim(code)) BETWEEN 1 AND 60 AND code = btrim(code)),
  name text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 200),
  active boolean NOT NULL DEFAULT true,
  provider_kind text NOT NULL CHECK (provider_kind IN ('TAKLIT','ORACLE_EBS')),
  synced_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, code)
);

-- 3. ERP siparişleri (PURCHASE_ORDER), salt okunur kopya. Tutar decimal string; yuvarlanmaz.
CREATE TABLE erp_purchase_orders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  erp_po_id text NOT NULL CHECK (length(btrim(erp_po_id)) BETWEEN 1 AND 120),
  po_no text NOT NULL CHECK (length(btrim(po_no)) BETWEEN 1 AND 60),
  supplier_id uuid,
  erp_supplier_code text CHECK (erp_supplier_code IS NULL OR length(btrim(erp_supplier_code)) BETWEEN 1 AND 60),
  contract_ref text CHECK (contract_ref IS NULL OR length(btrim(contract_ref)) BETWEEN 1 AND 60),
  currency text CHECK (currency IS NULL OR currency ~ '^[A-Z]{3}$'),
  amount text CHECK (amount IS NULL OR amount ~ '^-?\d+(\.\d{1,4})?$'),
  status text CHECK (status IS NULL OR length(btrim(status)) BETWEEN 1 AND 40),
  order_date date,
  provider_kind text NOT NULL CHECK (provider_kind IN ('TAKLIT','ORACLE_EBS')),
  synced_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, erp_po_id),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, supplier_id) REFERENCES suppliers (tenant_id, id)
);
CREATE INDEX erp_purchase_orders_po_no_idx ON erp_purchase_orders (tenant_id, po_no);
CREATE INDEX erp_purchase_orders_supplier_idx ON erp_purchase_orders (supplier_id);

-- 4. Fatura: ERP fatura kimliği, kaynak sağlayıcı ve ERP ödeme durumu (bilgi; uygulama ödeme yapmaz).
ALTER TABLE invoices ADD COLUMN erp_invoice_id text;
ALTER TABLE invoices ADD COLUMN erp_provider_kind text;
ALTER TABLE invoices ADD COLUMN erp_payment_status text;
ALTER TABLE invoices ADD COLUMN erp_payment_status_at date;
ALTER TABLE invoices ADD COLUMN erp_payment_source text;
ALTER TABLE invoices ADD CONSTRAINT invoices_erp_invoice_check CHECK (
  (erp_invoice_id IS NULL OR length(btrim(erp_invoice_id)) BETWEEN 1 AND 120)
  AND (erp_provider_kind IS NULL OR erp_provider_kind IN ('TAKLIT','ORACLE_EBS'))
  AND (erp_invoice_id IS NULL) = (erp_provider_kind IS NULL));
ALTER TABLE invoices ADD CONSTRAINT invoices_erp_payment_check CHECK (
  (erp_payment_status IS NULL OR erp_payment_status IN ('PAID','PARTIAL','UNPAID','UNKNOWN'))
  AND (erp_payment_source IS NULL OR erp_payment_source IN ('ERP','MANUAL'))
  AND (erp_payment_status IS NULL) = (erp_payment_source IS NULL)
  AND (erp_payment_status IS NOT NULL OR erp_payment_status_at IS NULL));
CREATE UNIQUE INDEX invoices_erp_invoice_id ON invoices (tenant_id, erp_invoice_id) WHERE erp_invoice_id IS NOT NULL;

-- ERP fatura kimliği ve kaynağı bir kez yazılır (elle faturaya bağlama NULL → değer); sonra değişmez.
CREATE FUNCTION invoices_erp_link_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.erp_invoice_id IS NOT NULL AND (NEW.erp_invoice_id IS DISTINCT FROM OLD.erp_invoice_id
                                         OR NEW.erp_provider_kind IS DISTINCT FROM OLD.erp_provider_kind) THEN
    RAISE EXCEPTION 'immutable_record: invoice ERP link cannot change' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER invoices_erp_link_guard BEFORE UPDATE OF erp_invoice_id, erp_provider_kind ON invoices
  FOR EACH ROW EXECUTE FUNCTION invoices_erp_link_guard();

GRANT INSERT (erp_invoice_id, erp_provider_kind, erp_payment_status, erp_payment_status_at, erp_payment_source) ON invoices TO sp_app;
GRANT UPDATE (erp_invoice_id, erp_provider_kind, erp_payment_status, erp_payment_status_at, erp_payment_source) ON invoices TO sp_app;

-- 5. RLS ve GRANT (yeni tablolar). Tedarikçi bağlamı kapalı; DELETE yok.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['erp_cost_centers','erp_purchase_orders'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY scope ON %I USING (tenant_id = app_tenant_id() AND app_supplier_id() IS NULL) '
                   'WITH CHECK (tenant_id = app_tenant_id() AND app_supplier_id() IS NULL)', t);
  END LOOP;
END $$;
GRANT SELECT, INSERT ON erp_cost_centers TO sp_app;
GRANT UPDATE (name, active, provider_kind, synced_at) ON erp_cost_centers TO sp_app;
GRANT SELECT, INSERT ON erp_purchase_orders TO sp_app;
GRANT UPDATE (po_no, supplier_id, erp_supplier_code, contract_ref, currency, amount, status, order_date, provider_kind, synced_at) ON erp_purchase_orders TO sp_app;
