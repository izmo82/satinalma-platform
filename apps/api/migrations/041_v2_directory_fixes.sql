-- v2 Faz 2 (D105) düzeltme: 040 uygulanmış olduğundan değiştirilmez; düzeltmeler burada.
-- (1) departments.normalized_name, alan işlevi normalizeDepartmentName (tr-TR) ile aynı katlamayı kullanır:
--     boşluk (NBSP dahil) teke iner, kırpılır, İ->i ve I->ı lower() ÖNCESİNDE çevrilir.
-- (2) directory_users.email boş olabilir (Entra'da mail alanı olmayan kullanıcı saklanır; rol verilemez). email üzerinde tekil dizin yok.

CREATE OR REPLACE FUNCTION sp_normalize_department_name(p_name text) RETURNS text
  LANGUAGE sql IMMUTABLE AS $$
  SELECT lower(replace(replace(btrim(regexp_replace(p_name, '[[:space:]' || chr(160) || ']+', ' ', 'g')), 'İ', 'i'), 'I', 'ı'))
$$;
REVOKE ALL ON FUNCTION sp_normalize_department_name(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION sp_normalize_department_name(text) TO sp_app;

UPDATE departments SET normalized_name = sp_normalize_department_name(name)
 WHERE normalized_name IS DISTINCT FROM sp_normalize_department_name(name);
-- Takma adlar eşitleme/birleştirme ile yazılır (Task 2+); varsa aynı katlamaya çekilir.
UPDATE department_aliases SET normalized_name = sp_normalize_department_name(normalized_name)
 WHERE normalized_name IS DISTINCT FROM sp_normalize_department_name(normalized_name);

ALTER TABLE directory_users ALTER COLUMN email DROP NOT NULL;
