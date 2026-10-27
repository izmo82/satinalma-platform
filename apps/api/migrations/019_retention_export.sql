-- 019 Faz 7 / T48: saklama politikası, hukuki saklama, iki kişi onaylı imha ve kiracı dışa aktarımı.
-- Belge sürümü değişmez kalır; imha ayrı bir kayıt (mezar taşı) ve nesne baytlarının silinmesidir. Hash, üst veri ve denetim izi korunur.

CREATE TABLE retention_policies (
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  document_kind text NOT NULL CHECK (document_kind IN ('INVOICE','CONTRACT','QUOTE','OTHER')),
  retention_months int NOT NULL CHECK (retention_months BETWEEN 1 AND 1200),
  -- Süre bir dayanağa bağlanır (mevzuat maddesi, kurum politikası); dayanaksız süre girilmez.
  legal_basis text NOT NULL CHECK (length(legal_basis) >= 5),
  updated_by uuid NOT NULL REFERENCES users(id),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, document_kind)
);

CREATE TABLE legal_holds (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  scope text NOT NULL CHECK (scope IN ('TENANT','COMPANY','DOCUMENT')),
  company_id uuid,
  document_id uuid,
  matter_ref text NOT NULL,
  reason text NOT NULL,
  created_by uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  released_by uuid REFERENCES users(id),
  released_at timestamptz,
  release_reason text,
  CHECK ((scope = 'TENANT' AND company_id IS NULL AND document_id IS NULL)
      OR (scope = 'COMPANY' AND company_id IS NOT NULL AND document_id IS NULL)
      OR (scope = 'DOCUMENT' AND document_id IS NOT NULL)),
  CHECK ((released_at IS NULL) = (released_by IS NULL)),
  FOREIGN KEY (tenant_id, company_id) REFERENCES legal_entities (tenant_id, id),
  FOREIGN KEY (tenant_id, document_id) REFERENCES documents (tenant_id, id)
);

CREATE TABLE disposal_batches (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  status text NOT NULL DEFAULT 'PROPOSED' CHECK (status IN ('PROPOSED','REJECTED','APPROVED','EXECUTED')),
  reason text NOT NULL,
  proposed_by uuid NOT NULL REFERENCES users(id),
  proposed_at timestamptz NOT NULL DEFAULT now(),
  decided_by uuid REFERENCES users(id),
  decided_at timestamptz,
  decision_note text,
  executed_at timestamptz,
  -- İmha anında yeniden kontrol: bu arada hukuki saklama gelen veya yeni sürüm alan belge atlanır.
  result jsonb,
  UNIQUE (tenant_id, id),
  -- Öneren onaylayamaz (görev ayrılığı).
  CHECK (decided_by IS NULL OR decided_by <> proposed_by)
);

CREATE TABLE disposal_items (
  tenant_id uuid NOT NULL,
  batch_id uuid NOT NULL,
  document_id uuid NOT NULL,
  company_id uuid NOT NULL,
  due_on date NOT NULL,
  PRIMARY KEY (batch_id, document_id),
  FOREIGN KEY (tenant_id, batch_id) REFERENCES disposal_batches (tenant_id, id),
  FOREIGN KEY (tenant_id, document_id) REFERENCES documents (tenant_id, id)
);

-- İmha kaydı: bir kez yazılır, değişmez. Belge ve sürüm satırları silinmez (hash ve denetim izi kalır).
CREATE TABLE document_disposals (
  document_id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  company_id uuid NOT NULL,
  batch_id uuid NOT NULL,
  disposed_at timestamptz NOT NULL DEFAULT now(),
  disposed_by uuid NOT NULL REFERENCES users(id),
  FOREIGN KEY (tenant_id, document_id) REFERENCES documents (tenant_id, id),
  FOREIGN KEY (tenant_id, batch_id) REFERENCES disposal_batches (tenant_id, id)
);
CREATE TRIGGER document_disposals_immutable BEFORE UPDATE OR DELETE ON document_disposals
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

CREATE TABLE tenant_exports (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  status text NOT NULL DEFAULT 'REQUESTED' CHECK (status IN ('REQUESTED','REJECTED','APPROVED','READY','FAILED')),
  reason text NOT NULL,
  requested_by uuid NOT NULL REFERENCES users(id),
  requested_at timestamptz NOT NULL DEFAULT now(),
  decided_by uuid REFERENCES users(id),
  decided_at timestamptz,
  decision_note text,
  storage_key text,
  size_bytes bigint,
  sha256 char(64),
  manifest jsonb,
  error text,
  ready_at timestamptz,
  expires_at timestamptz,
  CHECK (decided_by IS NULL OR decided_by <> requested_by)
);

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['retention_policies','legal_holds','disposal_batches','disposal_items','document_disposals','tenant_exports'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY scope ON %I USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id())', t);
    EXECUTE format('GRANT SELECT, INSERT ON %I TO sp_app', t);
  END LOOP;
END $$;
GRANT UPDATE (retention_months, legal_basis, updated_by, updated_at) ON retention_policies TO sp_app;
GRANT DELETE ON retention_policies TO sp_app;
GRANT UPDATE (released_by, released_at, release_reason) ON legal_holds TO sp_app;
GRANT UPDATE (status, decided_by, decided_at, decision_note, executed_at, result) ON disposal_batches TO sp_app;
GRANT UPDATE (status, decided_by, decided_at, decision_note, storage_key, size_bytes, sha256, manifest, error, ready_at, expires_at) ON tenant_exports TO sp_app;

-- Nesne baytları, kiracı içinde başka bir canlı kayıt (imha edilmemiş belge sürümü, teklif dosyası, dışa aktarım) aynı anahtarı
-- kullanıyorsa silinmez. Teklif dosyaları zarf kapalıyken alıcıya RLS ile görünmediği için kontrol bu dar kapıdan yapılır.
CREATE OR REPLACE FUNCTION storage_key_in_use(p_key text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (SELECT 1 FROM document_versions dv WHERE dv.tenant_id = app_tenant_id() AND dv.storage_key = p_key
                   AND NOT EXISTS (SELECT 1 FROM document_disposals x WHERE x.document_id = dv.document_id))
      OR EXISTS (SELECT 1 FROM bid_files b WHERE b.tenant_id = app_tenant_id() AND b.storage_key = p_key)
      OR EXISTS (SELECT 1 FROM tenant_exports e WHERE e.tenant_id = app_tenant_id() AND e.storage_key = p_key);
$$;
REVOKE ALL ON FUNCTION storage_key_in_use(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION storage_key_in_use(text) TO sp_app;
