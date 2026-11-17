-- 056a v2 Faz 7 (D112) Görev 2 inceleme düzeltmeleri. 055/056 değiştirilmez; bu dosya 057+ dosyalarına bağlı değildir.
--  1. Kural koruması set durumunu FOR SHARE ile okur: taslağa kural ekleme/değiştirme ile aynı setin yayımlanması yarışamaz
--     (yayımlama, açık kural işlemi bitene kadar bekler; bekleyen kural işlemi yayımlanmış seti görür ve reddedilir).
--  2. R1 veritabanında: faturanın sözleşme bağı çağıranın görebildiği aileye olmalı; proje ve departman ailenin proje ve
--     departmanıyla aynı olmalı (her yazma yolunda: eşleştirici, elle bağlama, departman atama). Çağıranın yetkisiyle çalışır
--     (SECURITY DEFINER değil), böylece RLS'in gizlediği aile bağlanamaz.
--  3. Çıkar çatışması beyanı yalnız oturum kullanıcısının kendi adına yazılır.
--  4. Eşleşme olayı: elle bağlama (LINK + MANUAL) yapanı ister; olaydaki aile yazarken çağırana görünür olmalı.
-- Hiçbir satır güncellenmez.

-- 1.
CREATE OR REPLACE FUNCTION procurement_rules_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE v_status text;
BEGIN
  SELECT s.status INTO v_status FROM procurement_rule_sets s
   WHERE s.id = CASE WHEN TG_OP = 'INSERT' THEN NEW.rule_set_id ELSE OLD.rule_set_id END
   FOR SHARE;
  IF v_status IS DISTINCT FROM 'DRAFT' THEN
    RAISE EXCEPTION 'immutable_record: procurement_rules (set %)', coalesce(v_status, 'missing') USING ERRCODE = 'P0001';
  END IF;
  IF TG_OP = 'UPDATE' AND (NEW.tenant_id, NEW.rule_set_id) IS DISTINCT FROM (OLD.tenant_id, OLD.rule_set_id) THEN
    RAISE EXCEPTION 'immutable_record: procurement_rules' USING ERRCODE = 'P0001';
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END $$;

-- 2.
CREATE OR REPLACE FUNCTION invoices_match_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE v_project uuid; v_department uuid;
BEGIN
  IF NEW.contract_family_id IS NULL THEN
    RETURN NEW;
  END IF;
  SELECT f.project_id, f.department_id INTO v_project, v_department FROM contract_families f WHERE f.id = NEW.contract_family_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'invoice_match_invalid: contract_not_visible' USING ERRCODE = 'P0001';
  END IF;
  IF NEW.project_id IS DISTINCT FROM v_project THEN
    RAISE EXCEPTION 'invoice_match_invalid: project_mismatch' USING ERRCODE = 'P0001';
  END IF;
  IF NEW.department_id IS DISTINCT FROM v_department THEN
    RAISE EXCEPTION 'invoice_match_invalid: department_mismatch' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER invoices_match_guard BEFORE INSERT OR UPDATE OF contract_family_id, project_id, department_id ON invoices
  FOR EACH ROW EXECUTE FUNCTION invoices_match_guard();

-- 3.
DROP POLICY scope ON coi_declarations;
CREATE POLICY scope ON coi_declarations
  USING (tenant_id = app_tenant_id() AND company_id = ANY (app_company_ids()) AND app_supplier_id() IS NULL)
  WITH CHECK (tenant_id = app_tenant_id() AND company_id = ANY (app_company_ids()) AND app_supplier_id() IS NULL
              AND user_id = app_user_id()
              AND EXISTS (SELECT 1 FROM projects p WHERE p.id = coi_declarations.project_id AND p.company_id = coi_declarations.company_id));

-- 4.
ALTER TABLE invoice_match_events ADD CONSTRAINT invoice_match_events_manual_actor_check
  CHECK (action <> 'LINK' OR method IS DISTINCT FROM 'MANUAL' OR actor IS NOT NULL);
DROP POLICY scope ON invoice_match_events;
CREATE POLICY scope ON invoice_match_events
  USING (tenant_id = app_tenant_id() AND company_id = ANY (app_company_ids()) AND app_supplier_id() IS NULL)
  WITH CHECK (tenant_id = app_tenant_id() AND company_id = ANY (app_company_ids()) AND app_supplier_id() IS NULL
              AND EXISTS (SELECT 1 FROM invoices i WHERE i.id = invoice_match_events.invoice_id AND i.company_id = invoice_match_events.company_id)
              AND (invoice_match_events.family_id IS NULL
                   OR EXISTS (SELECT 1 FROM contract_families f WHERE f.id = invoice_match_events.family_id)));
