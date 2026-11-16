-- v2 Faz 1 kalan düzeltme (D100): 035 departmansız değerlendirmenin eski bölüm (SECURITY → DEPARTMENT_USER) "Kritik engel"
-- görevini Satınalma'ya taşıdı. Aynı değerlendirmenin `assessment-blocker:<id>:PROCUREMENT_MANAGER` görevi de Satınalma'da
-- açık olduğundan Satınalma aynı bulgu için iki özdeş görev görüyordu. Taşınan kopya (anahtarı `:SECURITY`) kapatılır
-- (CANCELLED, yalnız UPDATE; görev silinmez). İkizi olmayan taşınmış görev açık kalır. Yeniden çalıştırmada aynı sonuç.
UPDATE tasks moved SET status = 'CANCELLED', closed_at = now()
  FROM tasks twin
 WHERE moved.kind = 'assessment_blocker' AND moved.status = 'OPEN' AND moved.dedupe_key LIKE 'assessment-blocker:%:SECURITY'
   AND twin.kind = 'assessment_blocker' AND twin.status = 'OPEN' AND twin.id <> moved.id
   AND twin.tenant_id = moved.tenant_id
   AND twin.dedupe_key = 'assessment-blocker:' || split_part(moved.dedupe_key, ':', 2) || ':PROCUREMENT_MANAGER'
   AND twin.assignee_role = moved.assignee_role
   AND twin.reason IS NOT DISTINCT FROM moved.reason;
