-- v2 Faz 3 (D108+) Görev 4 inceleme düzeltmesi. 051 uygulanmış olduğundan değiştirilmez.
-- Eski kayıt (R1 LEGACY) = Faz 3 geçişinden ÖNCE var olan aile. 051 sütunu false varsayılanla ekledi: mevcut satırlar false (eski) kalır.
-- Bundan sonra açılan her aile (yeni ekleme akışı ya da eski POST /contracts ucu) varsayılanla true olur; uygulama sütunu yazmaz,
-- UPDATE yetkisi yoktur. Böylece geçişten sonra eski uçla açılan sözleşme LEGACY değil, alanlarına göre Eksik alan/Taslak görünür.
ALTER TABLE contract_families ALTER COLUMN intake_flow SET DEFAULT true;
COMMENT ON COLUMN contract_families.intake_flow IS 'false = Faz 3 (051a) öncesi açılmış eski kayıt; yalnız varsayılanla yazılır.';
