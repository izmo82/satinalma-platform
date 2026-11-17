-- v2 Faz 2 (D105) düzeltme 2: 041 uygulanmış olduğundan değiştirilmez. Departman adı katlaması veritabanı harmanından (LC_CTYPE)
-- bağımsız ve alan işleviyle (packages/domain/src/directory.ts normalizeDepartmentName) aynı boşluk kümesiyle çalışır:
--   boşluk kümesi = \t \n \v \f \r, boşluk, U+00A0, U+2000-U+200B, U+3000, U+FEFF (JS tarafında aynı küme).
--   Türkçe harfler açıkça çevrilir (ÇĞİIÖŞÜ -> çğiıöşü); kalan harfler ICU "und-x-icu" ile küçülür.
CREATE OR REPLACE FUNCTION sp_normalize_department_name(p_name text) RETURNS text
  LANGUAGE sql IMMUTABLE SET search_path = pg_catalog AS $$
  SELECT lower(translate(
    regexp_replace(regexp_replace(p_name, '[\t\n\v\f\r   -​　﻿]+', ' ', 'g'), '^ | $', '', 'g'),
    'ÇĞİIÖŞÜ', 'çğiıöşü') COLLATE "und-x-icu")
$$;

UPDATE departments SET normalized_name = sp_normalize_department_name(name)
 WHERE normalized_name IS DISTINCT FROM sp_normalize_department_name(name);
UPDATE department_aliases SET normalized_name = sp_normalize_department_name(normalized_name)
 WHERE normalized_name IS DISTINCT FROM sp_normalize_department_name(normalized_name);
