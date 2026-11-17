-- v2 Faz 2 (D105) Görev 3 düzeltme: 040-043 uygulanmış olduğundan değiştirilmez.
-- Eşitleme, kiracının son etkin Yönetici üyeliğini askıya almaz; atlanan her durum çalıştırmada uyarı olarak sayılır (ekranda gösterilir).
ALTER TABLE directory_sync_runs ADD COLUMN IF NOT EXISTS warnings integer NOT NULL DEFAULT 0;
GRANT UPDATE (warnings) ON directory_sync_runs TO sp_app;
