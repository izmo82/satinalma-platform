-- 006 Faz 2 açıkları: kiracı içi kayıt numaraları (belge, sözleşme) ve teklif ekleri.

-- Kayıt numarası: kiracı içinde sıralı, değişmez. Var olan kayıtlar oluşturulma sırasıyla numaralanır.
ALTER TABLE documents ADD COLUMN code text;
ALTER TABLE contract_families ADD COLUMN code text;

UPDATE documents d SET code = 'BLG-' || to_char(x.created_at, 'YYYY') || '-' || lpad(x.rn::text, 4, '0')
FROM (SELECT id, created_at, row_number() OVER (PARTITION BY tenant_id ORDER BY created_at, id) AS rn FROM documents) x WHERE x.id = d.id;
UPDATE contract_families f SET code = 'SZL-' || to_char(x.created_at, 'YYYY') || '-' || lpad(x.rn::text, 4, '0')
FROM (SELECT id, created_at, row_number() OVER (PARTITION BY tenant_id ORDER BY created_at, id) AS rn FROM contract_families) x WHERE x.id = f.id;

INSERT INTO tenant_counters (tenant_id, name, value) SELECT tenant_id, 'document', count(*) FROM documents GROUP BY tenant_id
  ON CONFLICT (tenant_id, name) DO UPDATE SET value = greatest(tenant_counters.value, EXCLUDED.value);
INSERT INTO tenant_counters (tenant_id, name, value) SELECT tenant_id, 'contract', count(*) FROM contract_families GROUP BY tenant_id
  ON CONFLICT (tenant_id, name) DO UPDATE SET value = greatest(tenant_counters.value, EXCLUDED.value);

ALTER TABLE documents ALTER COLUMN code SET NOT NULL;
ALTER TABLE contract_families ALTER COLUMN code SET NOT NULL;
ALTER TABLE documents ADD CONSTRAINT documents_code_unique UNIQUE (tenant_id, code);
ALTER TABLE contract_families ADD CONSTRAINT contract_families_code_unique UNIQUE (tenant_id, code);

-- Teklif ekleri: tedarikçinin tura yüklediği dosyalar (değişmez) ve teklif sürümüne bağlantısı.
-- Alıcı, teklif içeriği gibi ekleri de tur kapanana kadar göremez (BR06).
CREATE TABLE bid_files (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  company_id uuid NOT NULL,
  project_id uuid NOT NULL,
  round_id uuid NOT NULL,
  supplier_id uuid NOT NULL,
  title text NOT NULL CHECK (length(title) BETWEEN 1 AND 200),
  original_filename text NOT NULL,
  mime_type text NOT NULL,
  size_bytes bigint NOT NULL CHECK (size_bytes > 0),
  sha256 char(64) NOT NULL,
  storage_key text NOT NULL,
  basic_check_status text NOT NULL CHECK (basic_check_status IN ('PASSED','QUARANTINED')),
  basic_check_reason text,
  uploaded_by uuid NOT NULL REFERENCES users(id),
  uploaded_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, round_id, supplier_id, sha256),
  FOREIGN KEY (tenant_id, round_id, supplier_id) REFERENCES rfq_invitations (tenant_id, round_id, supplier_id)
);
CREATE TABLE bid_attachments (
  tenant_id uuid NOT NULL,
  company_id uuid NOT NULL,
  bid_id uuid NOT NULL,
  file_id uuid NOT NULL,
  PRIMARY KEY (bid_id, file_id),
  FOREIGN KEY (tenant_id, bid_id) REFERENCES bids (tenant_id, id),
  FOREIGN KEY (tenant_id, file_id) REFERENCES bid_files (tenant_id, id)
);
CREATE TRIGGER bid_files_immutable BEFORE UPDATE OR DELETE ON bid_files FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
CREATE TRIGGER bid_attachments_immutable BEFORE UPDATE OR DELETE ON bid_attachments FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
-- Ek yükleme de yalnız tur açıkken (sunucu saati).
CREATE OR REPLACE FUNCTION bid_files_round_open() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE r rfq_rounds%ROWTYPE;
BEGIN
  SELECT * INTO r FROM rfq_rounds WHERE id = NEW.round_id;
  IF r.status <> 'OPEN' OR now() >= r.closes_at THEN
    RAISE EXCEPTION 'round_closed: files are accepted only while the round is open' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER bid_files_round_open BEFORE INSERT ON bid_files FOR EACH ROW EXECUTE FUNCTION bid_files_round_open();

CREATE OR REPLACE FUNCTION app_round_closed(p_round uuid) RETURNS boolean
  LANGUAGE sql STABLE AS $$
  SELECT EXISTS (SELECT 1 FROM rfq_rounds r WHERE r.id = p_round AND (r.status = 'CLOSED' OR r.closes_at <= now()))
$$;

ALTER TABLE bid_files ENABLE ROW LEVEL SECURITY;
CREATE POLICY scope ON bid_files
  USING (tenant_id = app_tenant_id() AND (supplier_id = app_supplier_id()
    OR (company_id = ANY (app_company_ids()) AND app_round_closed(round_id))))
  WITH CHECK (tenant_id = app_tenant_id() AND supplier_id = app_supplier_id());
GRANT SELECT, INSERT ON bid_files TO sp_app;

ALTER TABLE bid_attachments ENABLE ROW LEVEL SECURITY;
CREATE POLICY scope ON bid_attachments
  USING (tenant_id = app_tenant_id() AND app_bid_visible(bid_id))
  WITH CHECK (tenant_id = app_tenant_id() AND app_own_bid(bid_id));
GRANT SELECT, INSERT ON bid_attachments TO sp_app;
