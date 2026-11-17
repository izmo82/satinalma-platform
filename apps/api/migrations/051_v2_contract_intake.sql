-- v2 Faz 3 (D108+) Görev 4: sözleşme ekleme akışı için dar şema eki. 048/050 uygulanmış olduğundan değiştirilmez.
-- (1) intake_flow: aile yeni ekleme akışıyla (POST /contract-drafts) açıldı mı. Eski kayıt (R1 LEGACY) = bu bayrak false ve hiç onay
--     zinciri yok. Bayrak yalnız INSERT'te yazılır (UPDATE yetkisi yok); mevcut satırlar false kalır (Faz 3 öncesi ya da eski uçtan).
-- (2) Süresiz sözleşmenin ihbar (fesih bildirim) süresi (R2: süresizse bitiş boş ve ihbar süresi zorunlu). contract_terms'te ihbar
--     bitiş tarihine bağlıdır (CHECK notice_amount IS NULL OR end_date IS NOT NULL; mevcut ihbar uyarısı bitişten hesaplanır) ve
--     bu kural değişmez; süresiz kayıtta süre ailede tutulur.
-- (3) Aday tedarikçi kartının iletişim e-postası (R9). (4) Ekleme akışında ailenin tedarikçisi seçilir/değişir.
ALTER TABLE contract_families ADD COLUMN IF NOT EXISTS intake_flow boolean NOT NULL DEFAULT false;
ALTER TABLE contract_families ADD COLUMN IF NOT EXISTS termination_notice_amount int
  CHECK (termination_notice_amount IS NULL OR termination_notice_amount BETWEEN 1 AND 3650);
ALTER TABLE contract_families ADD COLUMN IF NOT EXISTS termination_notice_unit text
  CHECK (termination_notice_unit IS NULL OR termination_notice_unit IN ('DAY','MONTH'));
ALTER TABLE contract_families ADD CONSTRAINT contract_families_termination_notice_pair
  CHECK ((termination_notice_amount IS NULL) = (termination_notice_unit IS NULL));

ALTER TABLE suppliers ADD COLUMN IF NOT EXISTS contact_email text
  CHECK (contact_email IS NULL OR (length(contact_email) BETWEEN 3 AND 254 AND contact_email ~ '^[^@\s]+@[^@\s]+$'));

GRANT UPDATE (supplier_id, termination_notice_amount, termination_notice_unit) ON contract_families TO sp_app;
