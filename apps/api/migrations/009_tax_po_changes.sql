-- 009 Faz 4 açıkları: vergi aritmetiği için beyan edilen tutarlar, sipariş değişikliği/kapatma/iptal, tolerans kuralı silme.
-- Sipariş satırları değişmez kalır; değişiklik revizyon kaydıdır (BR11). Güncel miktar/fiyat görünümden okunur.

-- Belgede beyan edilen vergi: kontrol satırlardan hesaplananla karşılaştırır, beyanı doğru kabul etmez.
ALTER TABLE invoice_lines ADD COLUMN tax_amount numeric(20,2) CHECK (tax_amount >= 0);
ALTER TABLE invoices
  ADD COLUMN declared_tax_total numeric(20,2) CHECK (declared_tax_total >= 0),
  ADD COLUMN declared_withholding numeric(20,2) CHECK (declared_withholding >= 0),
  ADD COLUMN declared_payable numeric(20,2) CHECK (declared_payable >= 0);

-- Kapatma: kalan (kabul edilmemiş ve faturalanmamış) miktar serbest kalır; iptal: hiç tüketim yokken tüm sipariş.
ALTER TABLE purchase_orders DROP CONSTRAINT purchase_orders_status_check;
ALTER TABLE purchase_orders DROP CONSTRAINT purchase_orders_check;
ALTER TABLE purchase_orders ADD CONSTRAINT purchase_orders_status_check CHECK (status IN ('OPEN','CLOSED','CANCELLED'));
ALTER TABLE purchase_orders ADD CONSTRAINT purchase_orders_reason_check CHECK ((status = 'OPEN') = (cancel_reason IS NULL));

CREATE TABLE po_changes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  company_id uuid NOT NULL,
  po_id uuid NOT NULL,
  change_no int NOT NULL CHECK (change_no > 0),
  kind text NOT NULL CHECK (kind IN ('CHANGE','CLOSE','CANCEL')),
  reason text NOT NULL CHECK (length(reason) >= 10),
  -- Önce/sonra özeti (kalem, miktar, birim fiyat, tutar farkı). Onay ekranı ve denetim için.
  details jsonb NOT NULL,
  changed_by uuid NOT NULL REFERENCES users(id),
  changed_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, po_id, change_no),
  FOREIGN KEY (tenant_id, po_id) REFERENCES purchase_orders (tenant_id, id)
);
CREATE TABLE po_line_revisions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  company_id uuid NOT NULL,
  po_line_id uuid NOT NULL,
  change_id uuid NOT NULL,
  change_no int NOT NULL,
  quantity numeric(20,6) NOT NULL CHECK (quantity >= 0),
  unit_price numeric(20,6) NOT NULL CHECK (unit_price >= 0),
  UNIQUE (tenant_id, po_line_id, change_no),
  FOREIGN KEY (tenant_id, po_line_id) REFERENCES po_lines (tenant_id, id),
  FOREIGN KEY (tenant_id, change_id) REFERENCES po_changes (tenant_id, id)
);
-- Değişiklikle eklenen kalem: hangi değişiklikte eklendiği.
ALTER TABLE po_lines ADD COLUMN added_by_change_id uuid;
ALTER TABLE po_lines ADD CONSTRAINT po_lines_added_change_fk FOREIGN KEY (tenant_id, added_by_change_id) REFERENCES po_changes (tenant_id, id);

CREATE TRIGGER po_changes_immutable BEFORE UPDATE OR DELETE ON po_changes FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
CREATE TRIGGER po_line_revisions_immutable BEFORE UPDATE OR DELETE ON po_line_revisions FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['po_changes','po_line_revisions'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY scope ON %I USING (tenant_id = app_tenant_id() AND company_id = ANY (app_company_ids())) '
                   'WITH CHECK (tenant_id = app_tenant_id() AND company_id = ANY (app_company_ids()))', t);
    EXECUTE format('GRANT SELECT, INSERT ON %I TO sp_app', t);
  END LOOP;
END $$;

-- Güncel kalem: son revizyon yoksa özgün değer. security_invoker: alttaki tabloların RLS'i çağıranla uygulanır.
CREATE VIEW po_lines_current WITH (security_invoker = true) AS
SELECT pl.id, pl.tenant_id, pl.company_id, pl.po_id, pl.line_no, pl.kind, pl.description, pl.unit,
       coalesce(r.quantity, pl.quantity) AS quantity, coalesce(r.unit_price, pl.unit_price) AS unit_price,
       pl.quantity AS original_quantity, pl.unit_price AS original_unit_price, coalesce(r.change_no, 0) AS revision
FROM po_lines pl
LEFT JOIN LATERAL (SELECT quantity, unit_price, change_no FROM po_line_revisions x WHERE x.po_line_id = pl.id ORDER BY change_no DESC LIMIT 1) r ON true;
GRANT SELECT ON po_lines_current TO sp_app;

-- "Kural yoksa tolerans sıfır": kural kaldırılabilir (denetim kaydıyla).
GRANT DELETE ON tolerance_rules TO sp_app;
