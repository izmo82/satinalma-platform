-- v2 Faz 1 Görev 3 (D93, analiz-v2 §2.3, §5): görevler departman kapsamına girer; departman ataması için dar yazma izinleri.
-- Görev, bağlı olduğu kaydın (proje, sözleşme, fatura, değerlendirme ve alt kayıtları) departmanını taşır. Departmansız görev
-- (tedarikçi, olay, kiracı işleri ya da departmanı atanmamış eski kayıt) bugünkü gibi yalnız rolle kapsanır.
-- Veri silinmez; yeniden çalıştırmada değişiklik yapmaz.

-- 1. Görev departmanı (kiracı içi bileşik anahtar: başka kiracının departmanı bağlanamaz).
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS department_id uuid;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tasks_department_fk') THEN
    ALTER TABLE tasks ADD CONSTRAINT tasks_department_fk FOREIGN KEY (tenant_id, department_id) REFERENCES departments (tenant_id, id);
  END IF;
END $$;
CREATE INDEX IF NOT EXISTS tasks_department_idx ON tasks (department_id);

-- 2. Görev varlığının departmanı. Çağıranın yetkisiyle (RLS altında) çalışır: görünmeyen kayıt için NULL döner.
CREATE OR REPLACE FUNCTION app_task_departmental(p_type text) RETURNS boolean
  LANGUAGE sql IMMUTABLE AS $$
  SELECT p_type IN ('project','rfq_round','award','evaluation','sourcing_exception','contract_family','contract_version','invoice','supplier_assessment')
$$;
CREATE OR REPLACE FUNCTION app_task_department(p_type text, p_id uuid) RETURNS uuid
  LANGUAGE sql STABLE AS $$
  SELECT CASE p_type
    WHEN 'project' THEN (SELECT x.department_id FROM projects x WHERE x.id = p_id)
    WHEN 'rfq_round' THEN (SELECT p.department_id FROM rfq_rounds x JOIN projects p ON p.id = x.project_id WHERE x.id = p_id)
    WHEN 'award' THEN (SELECT p.department_id FROM awards x JOIN projects p ON p.id = x.project_id WHERE x.id = p_id)
    WHEN 'evaluation' THEN (SELECT p.department_id FROM evaluations x JOIN projects p ON p.id = x.project_id WHERE x.id = p_id)
    WHEN 'sourcing_exception' THEN (SELECT p.department_id FROM sourcing_exceptions x JOIN projects p ON p.id = x.project_id WHERE x.id = p_id)
    WHEN 'contract_family' THEN (SELECT x.department_id FROM contract_families x WHERE x.id = p_id)
    WHEN 'contract_version' THEN (SELECT f.department_id FROM contract_versions x JOIN contract_families f ON f.id = x.family_id WHERE x.id = p_id)
    WHEN 'invoice' THEN (SELECT x.department_id FROM invoices x WHERE x.id = p_id)
    WHEN 'supplier_assessment' THEN (SELECT x.department_id FROM supplier_assessments x WHERE x.id = p_id)
  END
$$;
REVOKE ALL ON FUNCTION app_task_departmental(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION app_task_department(text, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_task_departmental(text), app_task_department(text, uuid) TO sp_app;

-- 3. Mevcut (açık ve kapalı) görevlerin departmanı kayıttan doldurulur. Yalnız UPDATE; çözülemeyen görev boş kalır.
UPDATE tasks t SET department_id = app_task_department(t.entity_type, t.entity_id)
WHERE t.department_id IS NULL AND app_task_departmental(t.entity_type) AND app_task_department(t.entity_type, t.entity_id) IS NOT NULL;

-- 4. Departman kapsamı: departmanlı görev yalnız o departmanı görene; departmansız görev yalnız rol kapsamında.
DROP POLICY IF EXISTS dept ON tasks;
CREATE POLICY dept ON tasks AS RESTRICTIVE FOR ALL
  USING (department_id IS NULL OR app_department_ok(department_id))
  WITH CHECK (department_id IS NULL OR app_department_ok(department_id));

-- 5. Dar yazma izinleri: üyelik departmanları (Yönetici ucu; m_tenant politikası kiracı dışını kapatır) ve faturanın sözleşmeden
-- devraldığı departman. Başka sütun açılmaz.
GRANT UPDATE (department_ids) ON memberships TO sp_app;
GRANT UPDATE (department_id) ON invoices TO sp_app;
