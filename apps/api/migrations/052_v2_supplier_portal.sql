-- 052 v2 Faz 5 (D110): tedarikçi portalı şeması — girişsiz başvuru, tedarikçi belgeleri, kart envanteri (R14), pasife alma ve
-- ayrılış kontrol listesi (R13), portal skor görünümü (R15), e-posta kuyruğu ekleri (R6/R8) ve suppliers tedarikçi kapsamı (R17).
-- Kurallar:
--  * Mevcut tedarikçi durumları ve CHECK'i değişmez; bu dosya hiçbir suppliers satırını güncellemez (yalnız boş sütun eklenir).
--  * Her yeni tablo tenant_id + RLS + en dar GRANT; satır silme izni yok (sahip için de tetikleyiciyle kapalı).
--  * Girişsiz uçlar tabloları doğrudan okuyup yazamaz (kiracı bağlamı yok → RLS 0 satır; supplier_applications'a INSERT yetkisi yok).
--    Yalnız aşağıdaki SECURITY DEFINER işlevleri çağrılır; kiracı yalnız public_slug'dan ya da belirteç özetinden çözülür.
--  * İşlev hataları ayrı SQLSTATE taşır (P0001 'immutable_record' ile karışmasın; API ileti metniyle eşler):
--      SP404 applications_closed · SP409 application_exists · SP410 token_invalid · SP422 invalid_application · SP429 rate_limited
--  * Belirteç (32 bayt rastgele) veritabanında yalnız SHA-256 özetiyle (32 bayt) durur; kullanılınca silinir. İstemci adresi yalnız
--    özetlenmiş (sha256(ip + tenant)) saklanır. Bu iki sütun sp_app'e okunur verilmez (sütun düzeyi SELECT).

-- 1. Başvuru ayarı (R3): kiracı başına tek satır; varsayılan kapalı.
CREATE TABLE supplier_application_settings (
  tenant_id uuid PRIMARY KEY REFERENCES tenants(id),
  enabled boolean NOT NULL DEFAULT false,
  public_slug text UNIQUE CHECK (public_slug ~ '^[a-z0-9-]{3,40}$'),
  categories text[] NOT NULL DEFAULT '{}',
  updated_by uuid REFERENCES users(id),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (NOT enabled OR public_slug IS NOT NULL)
);

-- 2. Belge türleri (R3/R12): silinmez, active=false ile kapanır. Kod değişmez (belgeler koda bağlıdır).
CREATE TABLE supplier_document_types (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  code text NOT NULL CHECK (code ~ '^[A-Za-z0-9_.-]{2,40}$'),
  name text NOT NULL CHECK (length(btrim(name)) BETWEEN 2 AND 120),
  required boolean NOT NULL DEFAULT false,
  required_categories text[] NOT NULL DEFAULT '{}',
  expiry_required boolean NOT NULL DEFAULT false,
  active boolean NOT NULL DEFAULT true,
  created_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, code)
);

-- 3. Başvuru (R2). Açık = UNVERIFIED/SUBMITTED/NEEDS_DOCUMENTS; aynı kiracı + kimlik için tek açık başvuru.
CREATE TABLE supplier_applications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  status text NOT NULL DEFAULT 'UNVERIFIED'
    CHECK (status IN ('UNVERIFIED','SUBMITTED','NEEDS_DOCUMENTS','APPROVED','REJECTED','EXPIRED')),
  legal_name text NOT NULL CHECK (length(btrim(legal_name)) BETWEEN 2 AND 300),
  country char(2) NOT NULL DEFAULT 'TR',
  tax_id_type text NOT NULL CHECK (tax_id_type IN ('VKN','TCKN','FOREIGN')),
  tax_id text NOT NULL CHECK (length(tax_id) BETWEEN 1 AND 40),
  contact_name text NOT NULL CHECK (length(btrim(contact_name)) BETWEEN 2 AND 200),
  contact_email text NOT NULL CHECK (length(contact_email) BETWEEN 3 AND 254 AND contact_email ~ '^[^@\s]+@[^@\s]+$'),
  contact_phone text CHECK (contact_phone IS NULL OR length(contact_phone) <= 40),
  address text CHECK (address IS NULL OR length(address) <= 1000),
  categories text[] NOT NULL DEFAULT '{}',
  services text CHECK (services IS NULL OR length(services) <= 4000),
  token_hash bytea UNIQUE CHECK (token_hash IS NULL OR octet_length(token_hash) = 32),
  token_purpose text CHECK (token_purpose IN ('VERIFY','COMPLETE')),
  token_expires_at timestamptz,
  verified_at timestamptz,
  submitted_at timestamptz,
  requested_documents text[] NOT NULL DEFAULT '{}',
  requested_note text CHECK (requested_note IS NULL OR length(requested_note) <= 2000),
  decided_by uuid REFERENCES users(id),
  decided_at timestamptz,
  decision_reason text,
  supplier_id uuid,
  ip_hash bytea CHECK (ip_hash IS NULL OR octet_length(ip_hash) = 32),
  created_at timestamptz NOT NULL DEFAULT now(),
  row_version int NOT NULL DEFAULT 1,
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, supplier_id) REFERENCES suppliers (tenant_id, id),
  CHECK ((token_hash IS NULL) = (token_purpose IS NULL) AND (token_hash IS NULL) = (token_expires_at IS NULL)),
  CHECK (status <> 'REJECTED' OR length(btrim(coalesce(decision_reason, ''))) >= 10),
  CHECK (status NOT IN ('APPROVED','REJECTED') OR (decided_by IS NOT NULL AND decided_at IS NOT NULL)),
  CHECK (status <> 'APPROVED' OR supplier_id IS NOT NULL)
);
CREATE UNIQUE INDEX supplier_applications_one_open ON supplier_applications (tenant_id, country, tax_id_type, tax_id)
  WHERE status IN ('UNVERIFIED','SUBMITTED','NEEDS_DOCUMENTS');
CREATE INDEX supplier_applications_email_idx ON supplier_applications (tenant_id, lower(contact_email), created_at);
CREATE INDEX supplier_applications_ip_idx ON supplier_applications (tenant_id, ip_hash, created_at);
CREATE INDEX supplier_applications_status_idx ON supplier_applications (tenant_id, status, created_at);

-- Sonuçlanmış başvuru (APPROVED/REJECTED/EXPIRED) değişmez; bağlanan kart sonradan değiştirilemez.
CREATE OR REPLACE FUNCTION supplier_applications_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status IN ('APPROVED','REJECTED','EXPIRED') THEN
    RAISE EXCEPTION 'immutable_record: supplier_applications' USING ERRCODE = 'P0001';
  END IF;
  IF OLD.supplier_id IS NOT NULL AND NEW.supplier_id IS DISTINCT FROM OLD.supplier_id THEN
    RAISE EXCEPTION 'immutable_record: supplier_applications.supplier_id' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER supplier_applications_guard BEFORE UPDATE ON supplier_applications FOR EACH ROW EXECUTE FUNCTION supplier_applications_guard();
CREATE TRIGGER supplier_applications_no_delete BEFORE DELETE ON supplier_applications FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

-- 4. Tedarikçi belgeleri (R12). Başvurudan gelen (application_id), portaldan yenilenen ve Satınalma'nın yüklediği; yenileme eskiyi silmez.
CREATE TABLE supplier_documents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  supplier_id uuid,
  application_id uuid,
  type_code text NOT NULL,
  title text NOT NULL CHECK (length(btrim(title)) BETWEEN 1 AND 300),
  original_filename text NOT NULL CHECK (length(original_filename) BETWEEN 1 AND 255),
  mime_type text NOT NULL CHECK (mime_type IN ('application/pdf','image/jpeg','image/png')),
  size_bytes bigint NOT NULL CHECK (size_bytes > 0 AND size_bytes <= 26214400),
  sha256 text NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  storage_key text NOT NULL UNIQUE,
  basic_check_status text NOT NULL CHECK (basic_check_status IN ('PASSED','QUARANTINED')),
  basic_check_reason text,
  av_scan_status text NOT NULL CHECK (av_scan_status IN ('NOT_CONFIGURED','CLEAN','INFECTED','ERROR')),
  valid_until date,
  uploaded_via text NOT NULL CHECK (uploaded_via IN ('APPLICATION','PORTAL','INTERNAL')),
  uploaded_by uuid REFERENCES users(id),
  superseded_by_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, supplier_id) REFERENCES suppliers (tenant_id, id),
  FOREIGN KEY (tenant_id, application_id) REFERENCES supplier_applications (tenant_id, id),
  FOREIGN KEY (tenant_id, type_code) REFERENCES supplier_document_types (tenant_id, code),
  FOREIGN KEY (tenant_id, superseded_by_id) REFERENCES supplier_documents (tenant_id, id),
  CHECK (supplier_id IS NOT NULL OR application_id IS NOT NULL),
  CHECK (superseded_by_id IS NULL OR superseded_by_id <> id),
  CHECK (uploaded_via <> 'APPLICATION' OR (application_id IS NOT NULL AND uploaded_by IS NULL)),
  CHECK (uploaded_via = 'APPLICATION' OR (supplier_id IS NOT NULL AND uploaded_by IS NOT NULL)),
  -- R5: tarama hatası olan dosya karantinadadır.
  CHECK (av_scan_status <> 'ERROR' OR basic_check_status = 'QUARANTINED')
);
CREATE INDEX supplier_documents_supplier_idx ON supplier_documents (tenant_id, supplier_id, type_code) WHERE supplier_id IS NOT NULL;
CREATE INDEX supplier_documents_application_idx ON supplier_documents (tenant_id, application_id) WHERE application_id IS NOT NULL;
CREATE INDEX supplier_documents_expiry_idx ON supplier_documents (valid_until) WHERE superseded_by_id IS NULL AND valid_until IS NOT NULL;

-- Karta bağlama ve "yerine yenisi yüklendi" bir kez yazılır.
CREATE OR REPLACE FUNCTION supplier_documents_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (OLD.supplier_id IS NOT NULL AND NEW.supplier_id IS DISTINCT FROM OLD.supplier_id)
     OR (OLD.superseded_by_id IS NOT NULL AND NEW.superseded_by_id IS DISTINCT FROM OLD.superseded_by_id) THEN
    RAISE EXCEPTION 'immutable_record: supplier_documents' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER supplier_documents_guard BEFORE UPDATE ON supplier_documents FOR EACH ROW EXECUTE FUNCTION supplier_documents_guard();
CREATE TRIGGER supplier_documents_no_delete BEFORE DELETE ON supplier_documents FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

-- 5. Belge hatırlatmaları (R12): belge + gün farkı başına tek satır (işçi tekrarında çift yok).
CREATE TABLE supplier_document_reminders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  document_id uuid NOT NULL,
  offset_days int NOT NULL CHECK (offset_days BETWEEN 0 AND 365),
  due_on date NOT NULL,
  email_outbox_id uuid REFERENCES email_outbox(id),
  task_id uuid REFERENCES tasks(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (document_id, offset_days),
  FOREIGN KEY (tenant_id, document_id) REFERENCES supplier_documents (tenant_id, id)
);
CREATE TRIGGER supplier_document_reminders_immutable BEFORE UPDATE OR DELETE ON supplier_document_reminders
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

-- 6. Kart envanteri (R14), başvuru bağı, pasife alma / yeniden açma (R13). Mevcut sütunlar, durumlar ve CHECK'ler değişmez.
-- Not: yeniden pasife almada uygulama reactivated_* sütunlarını boşaltır (aksi halde aşağıdaki görev ayrılığı CHECK'i ikinci döngüyü engeller).
ALTER TABLE suppliers
  ADD COLUMN contact_name text CHECK (contact_name IS NULL OR length(btrim(contact_name)) BETWEEN 1 AND 200),
  ADD COLUMN contact_phone text CHECK (contact_phone IS NULL OR length(contact_phone) <= 40),
  ADD COLUMN address text CHECK (address IS NULL OR length(address) <= 1000),
  ADD COLUMN service_categories text[] NOT NULL DEFAULT '{}',
  ADD COLUMN services_offered text CHECK (services_offered IS NULL OR length(services_offered) <= 4000),
  ADD COLUMN service_scope text CHECK (service_scope IS NULL OR length(service_scope) <= 4000),
  ADD COLUMN responsible_department_id uuid,
  ADD COLUMN supplier_manager_user_id uuid REFERENCES users(id),
  ADD COLUMN vpn_access text NOT NULL DEFAULT 'UNKNOWN' CHECK (vpn_access IN ('YES','NO','UNKNOWN')),
  ADD COLUMN sla_summary text CHECK (sla_summary IS NULL OR length(sla_summary) <= 2000),
  ADD COLUMN support_channel text CHECK (support_channel IS NULL OR length(support_channel) <= 500),
  ADD COLUMN application_id uuid,
  ADD COLUMN deactivated_at timestamptz,
  ADD COLUMN deactivated_by uuid REFERENCES users(id),
  ADD COLUMN deactivation_reason text,
  ADD COLUMN reactivated_by uuid REFERENCES users(id),
  ADD COLUMN reactivated_at timestamptz,
  ADD COLUMN reactivation_reason text;
ALTER TABLE suppliers
  ADD CONSTRAINT suppliers_responsible_department_fk FOREIGN KEY (tenant_id, responsible_department_id) REFERENCES departments (tenant_id, id),
  ADD CONSTRAINT suppliers_application_fk FOREIGN KEY (tenant_id, application_id) REFERENCES supplier_applications (tenant_id, id),
  ADD CONSTRAINT suppliers_deactivation_pair CHECK ((deactivated_at IS NULL) = (deactivated_by IS NULL)),
  ADD CONSTRAINT suppliers_deactivation_reason CHECK (deactivated_at IS NULL OR length(btrim(coalesce(deactivation_reason, ''))) >= 10),
  ADD CONSTRAINT suppliers_reactivation_pair CHECK ((reactivated_at IS NULL) = (reactivated_by IS NULL)),
  ADD CONSTRAINT suppliers_reactivation_reason CHECK (reactivated_at IS NULL OR length(btrim(coalesce(reactivation_reason, ''))) >= 10),
  -- R13 görev ayrılığı: pasife alan kişi yeniden açamaz; uygulama atlansa da DB reddeder.
  ADD CONSTRAINT suppliers_reactivation_sod CHECK (reactivated_by IS NULL OR deactivated_by IS NULL OR reactivated_by <> deactivated_by);
CREATE UNIQUE INDEX suppliers_application_once ON suppliers (tenant_id, application_id) WHERE application_id IS NOT NULL;

-- 7. Ayrılış kontrol listesi (R13). Kararlar bir kez yazılır; liste tamamlanınca kapanış değişmez.
CREATE TABLE supplier_offboardings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  supplier_id uuid NOT NULL,
  reason text NOT NULL CHECK (length(btrim(reason)) >= 10),
  started_by uuid NOT NULL REFERENCES users(id),
  started_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, supplier_id) REFERENCES suppliers (tenant_id, id)
);
CREATE INDEX supplier_offboardings_supplier_idx ON supplier_offboardings (tenant_id, supplier_id, started_at DESC);
CREATE TABLE supplier_offboarding_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  offboarding_id uuid NOT NULL,
  code text NOT NULL CHECK (code ~ '^[A-Z0-9_]{2,40}$'),
  label text NOT NULL CHECK (length(btrim(label)) BETWEEN 2 AND 300),
  done_by uuid REFERENCES users(id),
  done_at timestamptz,
  not_applicable boolean NOT NULL DEFAULT false,
  note text CHECK (note IS NULL OR length(note) <= 2000),
  UNIQUE (offboarding_id, code),
  FOREIGN KEY (tenant_id, offboarding_id) REFERENCES supplier_offboardings (tenant_id, id),
  CHECK ((done_at IS NULL) = (done_by IS NULL)),
  CHECK (NOT not_applicable OR done_at IS NOT NULL),
  -- "Uygulanmaz" gerekçesiz olmaz.
  CHECK (NOT not_applicable OR length(btrim(coalesce(note, ''))) >= 3)
);
CREATE OR REPLACE FUNCTION supplier_offboarding_items_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.done_at IS NOT NULL AND (NEW.done_at, NEW.done_by, NEW.not_applicable, NEW.note)
       IS DISTINCT FROM (OLD.done_at, OLD.done_by, OLD.not_applicable, OLD.note) THEN
    RAISE EXCEPTION 'immutable_record: supplier_offboarding_items' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER supplier_offboarding_items_guard BEFORE UPDATE ON supplier_offboarding_items FOR EACH ROW EXECUTE FUNCTION supplier_offboarding_items_guard();
CREATE OR REPLACE FUNCTION supplier_offboardings_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.completed_at IS NOT NULL AND NEW.completed_at IS DISTINCT FROM OLD.completed_at THEN
    RAISE EXCEPTION 'immutable_record: supplier_offboardings' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER supplier_offboardings_guard BEFORE UPDATE ON supplier_offboardings FOR EACH ROW EXECUTE FUNCTION supplier_offboardings_guard();
CREATE TRIGGER supplier_offboardings_no_delete BEFORE DELETE ON supplier_offboardings FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
CREATE TRIGGER supplier_offboarding_items_no_delete BEFORE DELETE ON supplier_offboarding_items FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

-- 8. E-posta kuyruğu (048/050): to_user_id zaten NULL olabilir (dış alıcı to_email ile), işçi UPDATE (status, sent_at, error) 048'de verildi.
-- R8: aynı tur daveti aynı alıcıya ikinci kez yazılmaz (yalnız davet türünde; diğer satır türleri etkilenmez).
CREATE UNIQUE INDEX email_outbox_round_invite_once ON email_outbox (related_type, related_id, to_email)
  WHERE related_type IN ('rfq_round_invite');

-- 9. RLS.
ALTER TABLE supplier_application_settings ENABLE ROW LEVEL SECURITY;
CREATE POLICY scope ON supplier_application_settings
  USING (tenant_id = app_tenant_id() AND app_supplier_id() IS NULL)
  WITH CHECK (tenant_id = app_tenant_id() AND app_supplier_id() IS NULL);
-- Belge türleri: portal (Belgelerim) türleri okur; yazma yalnız iç bağlamda.
ALTER TABLE supplier_document_types ENABLE ROW LEVEL SECURITY;
CREATE POLICY read ON supplier_document_types FOR SELECT USING (tenant_id = app_tenant_id());
CREATE POLICY add ON supplier_document_types FOR INSERT WITH CHECK (tenant_id = app_tenant_id() AND app_supplier_id() IS NULL);
CREATE POLICY change ON supplier_document_types FOR UPDATE
  USING (tenant_id = app_tenant_id() AND app_supplier_id() IS NULL)
  WITH CHECK (tenant_id = app_tenant_id() AND app_supplier_id() IS NULL);
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['supplier_applications','supplier_document_reminders','supplier_offboardings','supplier_offboarding_items'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY scope ON %I USING (tenant_id = app_tenant_id() AND app_supplier_id() IS NULL) '
                   'WITH CHECK (tenant_id = app_tenant_id() AND app_supplier_id() IS NULL)', t);
  END LOOP;
END $$;
-- Tedarikçi kullanıcısı yalnız kendi kartının belgelerini görür ve yazar; başvuru belgeleri (supplier_id boş) ona kapalıdır.
ALTER TABLE supplier_documents ENABLE ROW LEVEL SECURITY;
CREATE POLICY scope ON supplier_documents
  USING (tenant_id = app_tenant_id() AND (app_supplier_id() IS NULL OR supplier_id = app_supplier_id()))
  WITH CHECK (tenant_id = app_tenant_id() AND (app_supplier_id() IS NULL OR supplier_id = app_supplier_id()));

-- R17: 002 s_tenant yalnız kiracı süzer; tedarikçi oturumu artık yalnız kendi kartını görür ve yazar. İç oturum değişmez.
CREATE POLICY supplier_scope ON suppliers AS RESTRICTIVE FOR ALL
  USING (app_supplier_id() IS NULL OR id = app_supplier_id())
  WITH CHECK (app_supplier_id() IS NULL OR id = app_supplier_id());

-- 10. En dar GRANT. Silme yok.
GRANT SELECT, INSERT ON supplier_application_settings TO sp_app;
GRANT UPDATE (enabled, public_slug, categories, updated_by, updated_at) ON supplier_application_settings TO sp_app;
GRANT SELECT, INSERT ON supplier_document_types TO sp_app;
GRANT UPDATE (name, required, required_categories, expiry_required, active, updated_at) ON supplier_document_types TO sp_app;
-- Başvuru yalnız işlevle açılır (INSERT yok); belirteç ve adres özeti okunamaz.
GRANT SELECT (id, tenant_id, status, legal_name, country, tax_id_type, tax_id, contact_name, contact_email, contact_phone, address,
              categories, services, token_purpose, token_expires_at, verified_at, submitted_at, requested_documents, requested_note,
              decided_by, decided_at, decision_reason, supplier_id, created_at, row_version) ON supplier_applications TO sp_app;
GRANT UPDATE (status, token_hash, token_purpose, token_expires_at, submitted_at, requested_documents, requested_note,
              decided_by, decided_at, decision_reason, supplier_id, row_version) ON supplier_applications TO sp_app;
GRANT SELECT, INSERT ON supplier_documents TO sp_app;
GRANT UPDATE (supplier_id, superseded_by_id) ON supplier_documents TO sp_app;
GRANT SELECT, INSERT ON supplier_document_reminders TO sp_app;
GRANT SELECT, INSERT ON supplier_offboardings TO sp_app;
GRANT UPDATE (completed_at) ON supplier_offboardings TO sp_app;
GRANT SELECT, INSERT ON supplier_offboarding_items TO sp_app;
GRANT UPDATE (done_by, done_at, not_applicable, note) ON supplier_offboarding_items TO sp_app;
GRANT UPDATE (contact_name, contact_email, contact_phone, address, service_categories, services_offered, service_scope,
              responsible_department_id, supplier_manager_user_id, vpn_access, sla_summary, support_channel, application_id,
              deactivated_at, deactivated_by, deactivation_reason, reactivated_by, reactivated_at, reactivation_reason) ON suppliers TO sp_app;

-- 11. Girişsiz işlevler. ---------------------------------------------------------------------------------------------------

-- İç yardımcı: başvuru belgelerini doğrular ve yazar (yalnız aşağıdaki SECURITY DEFINER işlevlerinden çağrılır; sp_app'e kapalı).
-- p_documents: [{ typeCode, title, originalFilename, mimeType, sizeBytes, sha256, storageKey, basicCheckStatus, basicCheckReason,
--                avScanStatus, validUntil }]. R4c: en çok 10 dosya, dosya başına 10 MB, toplam 40 MB; virüslü dosya kaydedilmez.
CREATE OR REPLACE FUNCTION supplier_application_add_documents(p_tenant uuid, p_application uuid, p_documents jsonb, p_allowed text[])
RETURNS int LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
DECLARE
  d jsonb;
  v_type supplier_document_types%ROWTYPE;
  v_total bigint := 0;
  v_n int := 0;
  v_size bigint;
  v_valid date;
BEGIN
  IF p_documents IS NULL OR jsonb_typeof(p_documents) <> 'array' THEN
    RAISE EXCEPTION 'invalid_application: documents' USING ERRCODE = 'SP422';
  END IF;
  IF jsonb_array_length(p_documents) > 10 THEN
    RAISE EXCEPTION 'invalid_application: too_many_files' USING ERRCODE = 'SP422';
  END IF;
  FOR d IN SELECT * FROM jsonb_array_elements(p_documents) LOOP
    SELECT * INTO v_type FROM supplier_document_types WHERE tenant_id = p_tenant AND code = d->>'typeCode' AND active;
    IF NOT FOUND OR (p_allowed IS NOT NULL AND NOT (v_type.code = ANY (p_allowed))) THEN
      RAISE EXCEPTION 'invalid_application: document_type' USING ERRCODE = 'SP422';
    END IF;
    v_size := (d->>'sizeBytes')::bigint;
    IF v_size IS NULL OR v_size <= 0 OR v_size > 10485760 THEN
      RAISE EXCEPTION 'invalid_application: file_size' USING ERRCODE = 'SP422';
    END IF;
    v_total := v_total + v_size;
    IF d->>'avScanStatus' = 'INFECTED' THEN
      RAISE EXCEPTION 'invalid_application: file_infected' USING ERRCODE = 'SP422';
    END IF;
    v_valid := nullif(d->>'validUntil', '')::date;
    IF v_type.expiry_required AND v_valid IS NULL THEN
      RAISE EXCEPTION 'invalid_application: valid_until_required' USING ERRCODE = 'SP422';
    END IF;
    INSERT INTO supplier_documents (tenant_id, application_id, type_code, title, original_filename, mime_type, size_bytes, sha256,
                                    storage_key, basic_check_status, basic_check_reason, av_scan_status, valid_until, uploaded_via)
    VALUES (p_tenant, p_application, v_type.code, coalesce(nullif(btrim(d->>'title'), ''), v_type.name), d->>'originalFilename',
            d->>'mimeType', v_size, d->>'sha256', d->>'storageKey', d->>'basicCheckStatus', d->>'basicCheckReason',
            d->>'avScanStatus', v_valid, 'APPLICATION');
    v_n := v_n + 1;
  END LOOP;
  IF v_total > 41943040 THEN
    RAISE EXCEPTION 'invalid_application: total_size' USING ERRCODE = 'SP422';
  END IF;
  RETURN v_n;
END $$;
REVOKE ALL ON FUNCTION supplier_application_add_documents(uuid, uuid, jsonb, text[]) FROM PUBLIC;

-- Başvuru sayfası yapılandırması. Kapalı, bilinmeyen ya da hiç ayarlanmamış kısaltma aynı yanıtı verir: {"enabled": false}.
-- Açıkken "internal" alanı (kiracı kimliği) yalnız sunucu içindir; API istemciye döndürmeden önce çıkarır.
CREATE OR REPLACE FUNCTION public_application_config(p_slug text) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT coalesce((
    SELECT jsonb_build_object(
      'enabled', true,
      'organizationName', t.name,
      'categories', to_jsonb(s.categories),
      'documentTypes', coalesce((SELECT jsonb_agg(jsonb_build_object('code', d.code, 'name', d.name, 'required', d.required,
                                   'requiredCategories', to_jsonb(d.required_categories), 'expiryRequired', d.expiry_required) ORDER BY d.name, d.code)
                                 FROM supplier_document_types d WHERE d.tenant_id = s.tenant_id AND d.active), '[]'::jsonb),
      'internal', jsonb_build_object('tenantId', s.tenant_id))
    FROM supplier_application_settings s JOIN tenants t ON t.id = s.tenant_id
    WHERE s.public_slug = p_slug AND s.enabled), jsonb_build_object('enabled', false))
$$;
REVOKE ALL ON FUNCTION public_application_config(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public_application_config(text) TO sp_app;

-- Başvuru açar (UNVERIFIED + VERIFY belirteci 24 saat), belgeleri ve doğrulama e-postası satırını tek işlemde yazar.
-- p_app: { legalName, country?, taxIdType, taxId, contactName, contactEmail, contactPhone?, address?, categories?, services? }
-- p_mail: { subject, body, status: 'NOT_CONFIGURED'|'QUEUED' }. R4b: e-posta başına 24 saatte 3, adres özeti başına saatte 10 başvuru.
CREATE OR REPLACE FUNCTION public_application_create(p_slug text, p_app jsonb, p_documents jsonb, p_token_hash bytea, p_ip_hash bytea, p_mail jsonb)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_tenant uuid;
  v_allowed_categories text[];
  v_email text := lower(btrim(coalesce(p_app->>'contactEmail', '')));
  v_country text := upper(coalesce(nullif(btrim(p_app->>'country'), ''), 'TR'));
  v_categories text[];
  v_id uuid;
BEGIN
  SELECT s.tenant_id, s.categories INTO v_tenant, v_allowed_categories
    FROM supplier_application_settings s WHERE s.public_slug = p_slug AND s.enabled;
  IF v_tenant IS NULL THEN
    RAISE EXCEPTION 'applications_closed' USING ERRCODE = 'SP404';
  END IF;
  IF p_token_hash IS NULL OR octet_length(p_token_hash) <> 32 OR p_ip_hash IS NULL OR octet_length(p_ip_hash) <> 32 THEN
    RAISE EXCEPTION 'invalid_application: hash' USING ERRCODE = 'SP422';
  END IF;
  IF p_mail IS NULL OR coalesce(p_mail->>'status', '') NOT IN ('NOT_CONFIGURED','QUEUED') THEN
    RAISE EXCEPTION 'invalid_application: mail' USING ERRCODE = 'SP422';
  END IF;
  IF v_email !~ '^[^@\s]+@[^@\s]+$' THEN
    RAISE EXCEPTION 'invalid_application: contact_email' USING ERRCODE = 'SP422';
  END IF;
  IF p_app ? 'categories' AND jsonb_typeof(p_app->'categories') <> 'array' THEN
    RAISE EXCEPTION 'invalid_application: categories' USING ERRCODE = 'SP422';
  END IF;
  v_categories := coalesce(ARRAY(SELECT jsonb_array_elements_text(p_app->'categories')), '{}');
  IF NOT (v_categories <@ v_allowed_categories) THEN
    RAISE EXCEPTION 'invalid_application: categories' USING ERRCODE = 'SP422';
  END IF;

  -- Sayım ve açık başvuru denetimi aynı kiracıda sıralı yapılır (eşzamanlı isteklerde sınır aşılmaz).
  PERFORM pg_advisory_xact_lock(hashtextextended('supplier_application:' || v_tenant::text, 0));
  IF (SELECT count(*) FROM supplier_applications a
       WHERE a.tenant_id = v_tenant AND lower(a.contact_email) = v_email AND a.created_at > now() - interval '24 hours') >= 3
     OR (SELECT count(*) FROM supplier_applications a
       WHERE a.tenant_id = v_tenant AND a.ip_hash = p_ip_hash AND a.created_at > now() - interval '1 hour') >= 10 THEN
    RAISE EXCEPTION 'rate_limited' USING ERRCODE = 'SP429';
  END IF;
  IF EXISTS (SELECT 1 FROM supplier_applications a
              WHERE a.tenant_id = v_tenant AND a.country = v_country AND a.tax_id_type = p_app->>'taxIdType' AND a.tax_id = p_app->>'taxId'
                AND a.status IN ('UNVERIFIED','SUBMITTED','NEEDS_DOCUMENTS')) THEN
    RAISE EXCEPTION 'application_exists' USING ERRCODE = 'SP409';
  END IF;

  BEGIN
    INSERT INTO supplier_applications (tenant_id, legal_name, country, tax_id_type, tax_id, contact_name, contact_email, contact_phone,
                                       address, categories, services, token_hash, token_purpose, token_expires_at, ip_hash)
    VALUES (v_tenant, btrim(p_app->>'legalName'), v_country, p_app->>'taxIdType', p_app->>'taxId', btrim(p_app->>'contactName'), v_email,
            nullif(btrim(p_app->>'contactPhone'), ''), nullif(btrim(p_app->>'address'), ''), v_categories, nullif(btrim(p_app->>'services'), ''),
            p_token_hash, 'VERIFY', now() + interval '24 hours', p_ip_hash)
    RETURNING id INTO v_id;
  EXCEPTION
    WHEN unique_violation THEN RAISE EXCEPTION 'application_exists' USING ERRCODE = 'SP409';
    WHEN check_violation OR not_null_violation THEN RAISE EXCEPTION 'invalid_application: fields' USING ERRCODE = 'SP422';
  END;

  PERFORM supplier_application_add_documents(v_tenant, v_id, coalesce(p_documents, '[]'::jsonb), NULL);

  INSERT INTO email_outbox (tenant_id, to_email, subject, body_text, related_type, related_id, status)
  VALUES (v_tenant, v_email, p_mail->>'subject', p_mail->>'body', 'supplier_application', v_id, p_mail->>'status');
  RETURN v_id;
END $$;
REVOKE ALL ON FUNCTION public_application_create(text, jsonb, jsonb, bytea, bytea, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public_application_create(text, jsonb, jsonb, bytea, bytea, jsonb) TO sp_app;

-- E-posta doğrulaması: VERIFY amaçlı, süresi geçmemiş, kullanılmamış belirteç → SUBMITTED; belirteç silinir, inceleme işi kuyruğa girer.
-- Geçersiz, kullanılmış, süresi geçmiş ya da başka amaçlı belirteç aynı hatayı verir (ayrım sızmaz).
CREATE OR REPLACE FUNCTION public_application_verify(p_token_hash bytea) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v supplier_applications%ROWTYPE;
BEGIN
  UPDATE supplier_applications
     SET status = 'SUBMITTED', verified_at = now(), submitted_at = now(),
         token_hash = NULL, token_purpose = NULL, token_expires_at = NULL, row_version = row_version + 1
   WHERE token_hash = p_token_hash AND token_purpose = 'VERIFY' AND token_expires_at > now() AND status = 'UNVERIFIED'
  RETURNING * INTO v;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'token_invalid' USING ERRCODE = 'SP410';
  END IF;
  INSERT INTO jobs (tenant_id, kind, idempotency_key, payload)
  VALUES (v.tenant_id, 'supplier_application.submitted', 'application:' || v.id || ':' || v.row_version, jsonb_build_object('applicationId', v.id))
  ON CONFLICT (tenant_id, kind, idempotency_key) DO NOTHING;
  RETURN jsonb_build_object('status', 'SUBMITTED', 'internal', jsonb_build_object('tenantId', v.tenant_id, 'applicationId', v.id));
END $$;
REVOKE ALL ON FUNCTION public_application_verify(bytea) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public_application_verify(bytea) TO sp_app;

-- Eksik belge tamamlama sayfası: istenen belgeler ve not (belirteci tüketmez).
CREATE OR REPLACE FUNCTION public_application_complete_info(p_token_hash bytea) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v supplier_applications%ROWTYPE;
BEGIN
  SELECT * INTO v FROM supplier_applications
   WHERE token_hash = p_token_hash AND token_purpose = 'COMPLETE' AND token_expires_at > now() AND status = 'NEEDS_DOCUMENTS';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'token_invalid' USING ERRCODE = 'SP410';
  END IF;
  RETURN jsonb_build_object(
    'legalName', v.legal_name,
    'note', v.requested_note,
    'requestedDocuments', coalesce((SELECT jsonb_agg(jsonb_build_object('code', d.code, 'name', d.name, 'expiryRequired', d.expiry_required) ORDER BY d.name, d.code)
                                    FROM supplier_document_types d WHERE d.tenant_id = v.tenant_id AND d.code = ANY (v.requested_documents)), '[]'::jsonb),
    'internal', jsonb_build_object('tenantId', v.tenant_id, 'applicationId', v.id));
END $$;
REVOKE ALL ON FUNCTION public_application_complete_info(bytea) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public_application_complete_info(bytea) TO sp_app;

-- Eksik belge tamamlama: yalnız istenen türler kabul edilir ve istenen her tür gelmelidir → SUBMITTED + yeni inceleme işi.
CREATE OR REPLACE FUNCTION public_application_complete(p_token_hash bytea, p_documents jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v supplier_applications%ROWTYPE;
  v_codes text[];
BEGIN
  SELECT * INTO v FROM supplier_applications
   WHERE token_hash = p_token_hash AND token_purpose = 'COMPLETE' AND token_expires_at > now() AND status = 'NEEDS_DOCUMENTS'
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'token_invalid' USING ERRCODE = 'SP410';
  END IF;
  IF p_documents IS NULL OR jsonb_typeof(p_documents) <> 'array' OR jsonb_array_length(p_documents) = 0 THEN
    RAISE EXCEPTION 'invalid_application: documents' USING ERRCODE = 'SP422';
  END IF;
  v_codes := ARRAY(SELECT DISTINCT x->>'typeCode' FROM jsonb_array_elements(p_documents) x);
  IF NOT (v.requested_documents <@ v_codes) THEN
    RAISE EXCEPTION 'invalid_application: documents_missing' USING ERRCODE = 'SP422';
  END IF;
  PERFORM supplier_application_add_documents(v.tenant_id, v.id, p_documents, v.requested_documents);
  UPDATE supplier_applications
     SET status = 'SUBMITTED', submitted_at = now(), token_hash = NULL, token_purpose = NULL, token_expires_at = NULL,
         row_version = row_version + 1
   WHERE id = v.id
  RETURNING * INTO v;
  INSERT INTO jobs (tenant_id, kind, idempotency_key, payload)
  VALUES (v.tenant_id, 'supplier_application.submitted', 'application:' || v.id || ':' || v.row_version, jsonb_build_object('applicationId', v.id))
  ON CONFLICT (tenant_id, kind, idempotency_key) DO NOTHING;
  RETURN jsonb_build_object('status', 'SUBMITTED', 'internal', jsonb_build_object('tenantId', v.tenant_id, 'applicationId', v.id));
END $$;
REVOKE ALL ON FUNCTION public_application_complete(bytea, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public_application_complete(bytea, jsonb) TO sp_app;

-- 12. Portal işlevleri (tedarikçi oturumu; kapsam yalnız app_supplier_id()). ------------------------------------------------

-- R15: tedarikçinin gördüğü skor ve risk girdileri. Yalnız şu anahtarlar döner (domain portalStanding girdisi):
--   surveys [{ratio}], review {score}|null, verifiedIncidents [{severity}], residualLevel, actions [{title, dueDate, status}],
--   pendingSurveys, missingDocs.
-- Dönmeyenler: içsel risk faktörleri, kalan risk gerekçesi, yanıt/bulgu notları, olay açıklamaları, performans gerekçesi, iç kullanıcı adları.
-- Hesap D103 ile aynı kaynaktan: bu yıl (İstanbul) incelemesi tamamlanmış anketlerin uyum oranı (EVET 2, KISMEN 1; "uygulanamaz" paydada
-- yok; yanıtsız/bilinmiyor paydada), dönemi bu yılla kesişen son performans incelemesinin ağırlıklı puanı (beş boyut da puanlıysa),
-- bu yıl doğrulanmış, mükerrer olmayan, itirazı açık olmayan ve ölçüme yansımamış olayların şiddeti, son tamamlanmış değerlendirmenin
-- kalan riski. Puan TS'de scorecardScore ile hesaplanır.
CREATE OR REPLACE FUNCTION app_portal_standing() RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_tenant uuid := app_tenant_id();
  v_supplier uuid := app_supplier_id();
  v_today date := (now() AT TIME ZONE 'Europe/Istanbul')::date;
  v_year int := extract(year FROM (now() AT TIME ZONE 'Europe/Istanbul'))::int;
  v_from date;
  v_to date;
  v_categories text[];
BEGIN
  IF v_tenant IS NULL OR v_supplier IS NULL THEN
    RAISE EXCEPTION 'portal_context_required' USING ERRCODE = '42501';
  END IF;
  SELECT s.service_categories INTO v_categories FROM suppliers s WHERE s.id = v_supplier AND s.tenant_id = v_tenant;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'portal_context_required' USING ERRCODE = '42501';
  END IF;
  v_from := make_date(v_year, 1, 1);
  v_to := make_date(v_year, 12, 31);
  RETURN jsonb_build_object(
    'surveys', coalesce((
      SELECT jsonb_agg(jsonb_build_object('ratio', x.ratio) ORDER BY x.reviewed_at)
      FROM (
        SELECT a.reviewed_at,
               round(sum(CASE r.response WHEN 'YES' THEN 2 WHEN 'PARTIAL' THEN 1 ELSE 0 END)::numeric * 100
                     / (count(*) FILTER (WHERE r.response IS DISTINCT FROM 'NOT_APPLICABLE') * 2), 1)::text AS ratio
        FROM supplier_assessments a
        JOIN questionnaire_questions q ON q.template_id = a.template_id AND q.tenant_id = a.tenant_id
        LEFT JOIN assessment_answers r ON r.assessment_id = a.id AND r.question_id = q.id
        WHERE a.tenant_id = v_tenant AND a.supplier_id = v_supplier AND a.reviewed_at IS NOT NULL
          AND extract(year FROM (a.reviewed_at AT TIME ZONE 'Europe/Istanbul'))::int = v_year
        GROUP BY a.id, a.reviewed_at
        HAVING count(*) FILTER (WHERE r.response IS DISTINCT FROM 'NOT_APPLICABLE') > 0
      ) x), '[]'::jsonb),
    'review', (
      SELECT CASE WHEN (SELECT bool_and(p.scores ? d AND p.weights ? d) FROM unnest(ARRAY['quality','delivery','sla','communication','commercial']) d)
                  THEN jsonb_build_object('score', (round((SELECT sum((p.scores->>d)::numeric * (p.weights->>d)::numeric)
                                                         FROM unnest(ARRAY['quality','delivery','sla','communication','commercial']) d) / 100, 1))::text)
                  ELSE NULL END
      FROM performance_reviews p
      WHERE p.tenant_id = v_tenant AND p.supplier_id = v_supplier AND p.period_end >= v_from AND p.period_start <= v_to
      ORDER BY p.reviewed_at DESC LIMIT 1),
    'verifiedIncidents', coalesce((
      SELECT jsonb_agg(jsonb_build_object('severity', i.severity) ORDER BY i.occurred_on, i.code)
      FROM supplier_incidents i
      WHERE i.tenant_id = v_tenant AND i.supplier_id = v_supplier AND i.occurred_on BETWEEN v_from AND v_to
        AND (i.status = 'VERIFIED' OR (i.status = 'CLOSED' AND i.verified_at IS NOT NULL))
        AND i.duplicate_of_id IS NULL AND NOT i.dispute_open AND NOT i.counted_in_metric), '[]'::jsonb),
    'residualLevel', (
      SELECT a.residual_level FROM supplier_assessments a
      WHERE a.tenant_id = v_tenant AND a.supplier_id = v_supplier AND a.status = 'REVIEWED' AND a.reviewed_at IS NOT NULL
      ORDER BY a.reviewed_at DESC LIMIT 1),
    'actions', coalesce((
      SELECT jsonb_agg(jsonb_build_object('title', c.title, 'dueDate', c.due_date::text, 'status', c.status) ORDER BY c.due_date, c.created_at)
      FROM corrective_actions c JOIN supplier_incidents i ON i.id = c.incident_id
      WHERE c.tenant_id = v_tenant AND i.supplier_id = v_supplier AND c.status <> 'VERIFIED'
        AND i.status <> 'REJECTED' AND i.duplicate_of_id IS NULL), '[]'::jsonb),
    'pendingSurveys', (
      SELECT count(*)::int FROM supplier_assessments a
      WHERE a.tenant_id = v_tenant AND a.supplier_id = v_supplier AND a.portal_status = 'SENT'),
    'missingDocs', (
      SELECT count(*)::int FROM supplier_document_types t
      WHERE t.tenant_id = v_tenant AND t.active AND (t.required OR t.required_categories && v_categories)
        AND NOT EXISTS (SELECT 1 FROM supplier_documents d
                        WHERE d.tenant_id = v_tenant AND d.supplier_id = v_supplier AND d.type_code = t.code AND d.superseded_by_id IS NULL
                          AND (d.valid_until >= v_today OR (d.valid_until IS NULL AND NOT t.expiry_required))))
  );
END $$;
REVOKE ALL ON FUNCTION app_portal_standing() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_portal_standing() TO sp_app;

-- R14: tedarikçi portalda yalnız iletişim kişisi, telefon ve adresi değiştirir (unvan, VKN, durum bu yoldan değişmez).
CREATE OR REPLACE FUNCTION portal_update_contact(p_name text, p_phone text, p_address text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_tenant uuid := app_tenant_id();
  v_supplier uuid := app_supplier_id();
  v_name text := btrim(coalesce(p_name, ''));
  v_phone text := nullif(btrim(coalesce(p_phone, '')), '');
  v_address text := nullif(btrim(coalesce(p_address, '')), '');
  r record;
BEGIN
  IF v_tenant IS NULL OR v_supplier IS NULL THEN
    RAISE EXCEPTION 'portal_context_required' USING ERRCODE = '42501';
  END IF;
  IF length(v_name) NOT BETWEEN 2 AND 200 OR length(coalesce(v_phone, '')) > 40 OR length(coalesce(v_address, '')) > 1000 THEN
    RAISE EXCEPTION 'invalid_contact' USING ERRCODE = 'SP422';
  END IF;
  UPDATE suppliers SET contact_name = v_name, contact_phone = v_phone, address = v_address, row_version = row_version + 1
   WHERE id = v_supplier AND tenant_id = v_tenant
  RETURNING contact_name, contact_phone, address, row_version INTO r;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'portal_context_required' USING ERRCODE = '42501';
  END IF;
  RETURN jsonb_build_object('contactName', r.contact_name, 'contactPhone', r.contact_phone, 'address', r.address, 'rowVersion', r.row_version);
END $$;
REVOKE ALL ON FUNCTION portal_update_contact(text, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION portal_update_contact(text, text, text) TO sp_app;
