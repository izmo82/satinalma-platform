-- 058a v2 Faz 8 (D113) Görev 2 düzeltme: ERP değerlerinde kaynak koruması ve ERP yazma kaydının uç durumları.
-- Kurallar:
--  * Fatura ERP sözleşme/sipariş referansı (055 sütunları) kaynak taşır: erp_contract_ref_source, erp_order_ref_source (ERP|MANUAL).
--    Mevcut satırlar güncellenmez (demo faturalar dahil): 058a öncesi yazılmış referansın kaynağı NULL = "kaynağı bilinmiyor" kalır
--    ve o referans değişmez (055 davranışı). Kaynaksız referansla INSERT de geçerli kalır (055/Faz 7 yolu aynen çalışır).
--    Referans yalnız NULL → değer yazılır ya da elle (MANUAL) değer elle düzeltilir; ERP değeri ve kaynaksız değer değişmez/silinmez;
--    ERP hiçbir zaman elle değerin üzerine yazmaz.
--  * Tedarikçi ERP kodu, masraf merkezi kodu ve ERP ödeme durumu: ERP kaynağı elle (MANUAL) girilmiş değerin yerine geçemez.
--  * erp_outbound_records: external_ref bir kez yazılır; CONFIRMED ve MANUAL son durumdur (satır değişmez).
--  * Bu dosya hiçbir satırı UPDATE/DELETE etmez.

-- 1. Fatura referans kaynakları.
ALTER TABLE invoices ADD COLUMN erp_contract_ref_source text;
ALTER TABLE invoices ADD COLUMN erp_order_ref_source text;
ALTER TABLE invoices ADD CONSTRAINT invoices_erp_ref_source_check CHECK (
  (erp_contract_ref_source IS NULL OR (erp_contract_ref_source IN ('ERP','MANUAL') AND erp_contract_ref IS NOT NULL))
  AND (erp_order_ref_source IS NULL OR (erp_order_ref_source IN ('ERP','MANUAL') AND erp_order_ref IS NOT NULL)));

CREATE FUNCTION invoices_erp_ref_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  o jsonb := to_jsonb(OLD);
  n jsonb := to_jsonb(NEW);
  ref text;
  src text;
BEGIN
  FOREACH ref IN ARRAY ARRAY['erp_contract_ref','erp_order_ref'] LOOP
    src := ref || '_source';
    IF o->>ref IS NULL OR (n->>ref IS NOT DISTINCT FROM o->>ref AND n->>src IS NOT DISTINCT FROM o->>src) THEN
      CONTINUE;   -- NULL → değer serbest; değişiklik yoksa sorun yok
    END IF;
    -- Dolu referans: yalnız elle değer elle düzeltilir (silinemez); ERP ya da kaynağı bilinmeyen değer değişmez.
    IF o->>src = 'MANUAL' AND n->>src = 'MANUAL' AND n->>ref IS NOT NULL THEN
      CONTINUE;
    END IF;
    RAISE EXCEPTION 'erp_source_conflict: % (%) cannot change to % (%)', ref, coalesce(o->>src, 'UNKNOWN'), coalesce(n->>ref, 'NULL'),
      coalesce(n->>src, 'NULL') USING ERRCODE = 'P0001';
  END LOOP;
  RETURN NEW;
END $$;
CREATE TRIGGER invoices_erp_ref_guard BEFORE UPDATE OF erp_contract_ref, erp_contract_ref_source, erp_order_ref, erp_order_ref_source ON invoices
  FOR EACH ROW EXECUTE FUNCTION invoices_erp_ref_guard();

GRANT INSERT (erp_contract_ref_source, erp_order_ref_source) ON invoices TO sp_app;
GRANT UPDATE (erp_contract_ref, erp_contract_ref_source, erp_order_ref, erp_order_ref_source) ON invoices TO sp_app;

-- 2. ERP elle değerin yerine geçemez (kaynak sütunları argüman olarak verilir).
CREATE FUNCTION erp_manual_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  src text;
BEGIN
  FOREACH src IN ARRAY TG_ARGV LOOP
    IF to_jsonb(OLD)->>src = 'MANUAL' AND to_jsonb(NEW)->>src = 'ERP' THEN
      RAISE EXCEPTION 'erp_source_conflict: ERP value cannot replace MANUAL value (% on %)', src, TG_TABLE_NAME USING ERRCODE = 'P0001';
    END IF;
  END LOOP;
  RETURN NEW;
END $$;
CREATE TRIGGER suppliers_erp_manual_guard BEFORE UPDATE OF erp_supplier_code, erp_supplier_code_source ON suppliers
  FOR EACH ROW EXECUTE FUNCTION erp_manual_guard('erp_supplier_code_source');
CREATE TRIGGER departments_erp_manual_guard BEFORE UPDATE OF cost_center_code, cost_center_source ON departments
  FOR EACH ROW EXECUTE FUNCTION erp_manual_guard('cost_center_source');
CREATE TRIGGER invoices_erp_payment_manual_guard BEFORE UPDATE OF erp_payment_status, erp_payment_status_at, erp_payment_source ON invoices
  FOR EACH ROW EXECUTE FUNCTION erp_manual_guard('erp_payment_source');

-- 3. ERP yazma kaydı: dış referans bir kez yazılır; CONFIRMED ve MANUAL son durumdur.
CREATE FUNCTION erp_outbound_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status IN ('CONFIRMED','MANUAL') AND to_jsonb(NEW) IS DISTINCT FROM to_jsonb(OLD) THEN
    RAISE EXCEPTION 'immutable_record: % outbound record cannot change', OLD.status USING ERRCODE = 'P0001';
  END IF;
  IF OLD.external_ref IS NOT NULL AND NEW.external_ref IS DISTINCT FROM OLD.external_ref THEN
    RAISE EXCEPTION 'immutable_record: outbound external_ref is write-once' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER erp_outbound_records_guard BEFORE UPDATE ON erp_outbound_records FOR EACH ROW EXECUTE FUNCTION erp_outbound_guard();
