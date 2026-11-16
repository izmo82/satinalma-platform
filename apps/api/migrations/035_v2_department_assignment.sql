-- v2 Faz 1 düzeltme dalgası (D96, D100): departmansız eski kayıtlara departman atanır; görevler kaydın departmanını izler.
-- (1) Dar yazma izinleri: yalnız department_id sütunu (proje, sözleşme ailesi, tedarikçi değerlendirmesi, görev). Atama ucu
--     Yönetici ve Satınalma'ya açıktır (department.assign), her kayıt için denetim olayı yazar.
-- (2) Olay görevi departmanını bağlı sözleşmeden alır (sözleşme varsa). 'incident' departmanlı tür sayılmaz: sözleşmesiz olay
--     tedarikçi düzeyindedir ve bugünkü gibi rolle kapsanır.
-- (3) Mevcut görevler (yalnız UPDATE; görev silinmez, kapanmaz):
--     - değerlendirme engeli görevleri değerlendirmenin departmanını taşır; departmansız değerlendirmenin eski bölüm görevi Satınalma'ya,
--     - olay görevleri bağlı sözleşmenin departmanını taşır,
--     - merkezi ön inceleme görevleri (belge karantinası, güvenlik/kişisel veri olayı ön incelemesi, risk yeniden incelemesi) Satınalma'ya.
-- Yeniden çalıştırmada aynı sonucu verir. 030–034 değiştirilmez.

GRANT UPDATE (department_id) ON projects TO sp_app;
GRANT UPDATE (department_id) ON contract_families TO sp_app;
GRANT UPDATE (department_id) ON supplier_assessments TO sp_app;
GRANT UPDATE (department_id) ON tasks TO sp_app;

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
    WHEN 'incident' THEN (SELECT f.department_id FROM supplier_incidents x JOIN contract_versions cv ON cv.id = x.contract_version_id
                           JOIN contract_families f ON f.id = cv.family_id WHERE x.id = p_id)
  END
$$;
REVOKE ALL ON FUNCTION app_task_department(text, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_task_department(text, uuid) TO sp_app;

-- Değerlendirme engeli: tekil anahtar `assessment-blocker:<değerlendirme>:<rol>`.
UPDATE tasks t SET department_id = a.department_id
  FROM supplier_assessments a
 WHERE t.kind = 'assessment_blocker' AND a.id::text = split_part(t.dedupe_key, ':', 2)
   AND a.department_id IS NOT NULL AND t.department_id IS DISTINCT FROM a.department_id;
UPDATE tasks t SET assignee_role = 'PROCUREMENT'
  FROM supplier_assessments a
 WHERE t.status = 'OPEN' AND t.kind = 'assessment_blocker' AND t.assignee_role = 'DEPARTMENT_USER'
   AND a.id::text = split_part(t.dedupe_key, ':', 2) AND a.department_id IS NULL;

-- Olay görevleri: bağlı sözleşmenin departmanı.
UPDATE tasks t SET department_id = f.department_id
  FROM supplier_incidents i JOIN contract_versions cv ON cv.id = i.contract_version_id JOIN contract_families f ON f.id = cv.family_id
 WHERE t.entity_type = 'incident' AND t.entity_id = i.id AND f.department_id IS NOT NULL AND t.department_id IS DISTINCT FROM f.department_id;

-- Merkezi ön inceleme görevleri Satınalma'ya (eski SECURITY → göçle DEPARTMENT_USER olmuştu).
UPDATE tasks SET assignee_role = 'PROCUREMENT'
 WHERE status = 'OPEN' AND assignee_role = 'DEPARTMENT_USER' AND kind IN ('DOCUMENT_QUARANTINED', 'incident_review', 'risk_rereview');
