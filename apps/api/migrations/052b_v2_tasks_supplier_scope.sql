-- 052b v2 Faz 5 (D110) Görev 6 inceleme düzeltmeleri. 052/052a uygulanmış olduğundan değiştirilmez.
-- (1) tasks: 001 t_scope yalnız kiracı + şirket süzer; tedarikçi oturumu (app_supplier_id() dolu) kiracının bütün şirketsiz görevlerini
--     okuyup güncelleyebiliyordu. Artık tedarikçi oturumu yalnız kendi kartına bağlı, portal akışlarının yazdığı/kapattığı görev türlerini
--     görür ve yazar: bilgi değişikliği isteği, portaldan belge yükleme bilgisi, belge virüs taraması hatası, belge süresi doldu (yenilemede
--     kapanır). İç oturumlar değişmez.
-- (2) supplier_document_reminder_tenants(): belge hatırlatma işçisi için dar kapı (054b risk_cycle_tenants deseni). Yalnız kiracı kimlikleri
--     döner: tedarikçi kartına bağlı, yenilenmemiş, geçerlilik tarihli belgesi olan kiracılar.

CREATE POLICY supplier_scope ON tasks AS RESTRICTIVE FOR ALL
  USING (app_supplier_id() IS NULL OR (entity_type = 'supplier' AND entity_id = app_supplier_id()
         AND kind IN ('supplier_profile_change_request', 'supplier_document_renewed', 'supplier_document_av_error', 'supplier_document_expired')))
  WITH CHECK (app_supplier_id() IS NULL OR (entity_type = 'supplier' AND entity_id = app_supplier_id()
         AND kind IN ('supplier_profile_change_request', 'supplier_document_renewed', 'supplier_document_av_error', 'supplier_document_expired')));

CREATE OR REPLACE FUNCTION supplier_document_reminder_tenants() RETURNS SETOF uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT DISTINCT d.tenant_id FROM supplier_documents d
   WHERE d.supplier_id IS NOT NULL AND d.superseded_by_id IS NULL AND d.valid_until IS NOT NULL
$$;
REVOKE ALL ON FUNCTION supplier_document_reminder_tenants() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION supplier_document_reminder_tenants() TO sp_app;
