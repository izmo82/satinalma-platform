-- v2 Faz 1 Görev 3 düzeltme (D93, analiz-v2 §2.3): departmanı boş (NULL) kayıt yalnız tüm departmanları gören rollere görünür.
-- 032'deki görev politikası her departmansız görevi geçiriyordu; departmanlı türdeki (proje, sözleşme, fatura, değerlendirme ve alt
-- kayıtları) departmansız kaydın görevi (ör. yayın onayı başlığı) böylece bütün bölüm kullanıcılarına görünüyordu. Artık:
--   departmanlı görev → departmanı gören; departmansız görev → tüm departmanı gören ya da departmansız türde (tedarikçi, olay, kiracı) iş.
-- 032 değiştirilmez (kayıtlı sağlama toplamı geçerli kalır). Veri değişmez; yeniden çalıştırmada aynı sonucu verir.
DROP POLICY IF EXISTS dept ON tasks;
CREATE POLICY dept ON tasks AS RESTRICTIVE FOR ALL
  USING ((department_id IS NOT NULL AND app_department_ok(department_id))
         OR (department_id IS NULL AND (app_department_all() OR NOT app_task_departmental(entity_type))))
  WITH CHECK ((department_id IS NOT NULL AND app_department_ok(department_id))
              OR (department_id IS NULL AND (app_department_all() OR NOT app_task_departmental(entity_type))));
