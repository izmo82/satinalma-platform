# Task 1 raporu: şema, izinler, alan kuralları (DONE)

Yapılan: migration 040_v2_directory.sql (5 yeni tablo, departments/memberships eklemeleri, RLS + dar GRANT); roles.ts'e 5 izin; packages/domain/src/directory.ts (normalizeDepartmentName, inScope, planMembershipDepartments, validateApprover); index.ts export; directory.test.ts.

RED: `npm test -w @sp/domain` -> 1 failed file (directory.ts yok), 153 test geçti.
GREEN: `npm test -w @sp/domain` -> 15 dosya / 162 test geçti.
`npm run migrate -w @sp/api` -> "applied 040_v2_directory.sql" (dev DB güncel).
`npm test -w @sp/api` -> 23 dosya geçti, 1 atlandı; 234 test geçti, 43 atlandı (atlananlar önceden de var; değiştirilmedi). `npm run typecheck` temiz.
Eski test dosyası değiştirilmedi.

Notlar / öz-inceleme:
- departments.normalized_name mevcut satırlar için SQL'de lower(btrim) ile dolduruldu (SQL lower tr-TR yapmaz; İ/I içeren adlarda alan işlevinden farklı olabilir). Task 2'de eşitleme normalizeDepartmentName ile yazar; gerekirse mevcut elle departmanlar için yeniden normalize edilmeli.
- directory_sync_runs'a created_at eklendi (briefte yok; sıralama için). directory_users/ directory_sync_runs için (tenant_id,id) UNIQUE bileşik FK için.
- users tablosunda RLS yok (001); INSERT ON users yalnız GRANT olarak eklendi. memberships politikası m_tenant (USING) INSERT'te de WITH CHECK işlevi görür.
- planMembershipDepartments: eski = yeni ise üyelikte kalır.
- departments için ek GRANT UPDATE(merged_into, normalized_name) briefte yok ama R6 birleştirme için gerekli; en dar hali.
- Migration ikinci kez çalıştırıldığında idempotent olacak biçimde yazıldı (IF NOT EXISTS/DO blokları); migrate.ts zaten bir kez uygular.

## Düzeltme turu 1 (migration 041)
- 041_v2_directory_fixes.sql: `sp_normalize_department_name(text)` IMMUTABLE (boşluk+NBSP teke, btrim, İ->i, I->ı, sonra lower); GRANT EXECUTE sp_app (Task 2/3 çağırabilir). departments.normalized_name ve department_aliases yeniden hesaplandı. directory_users.email DROP NOT NULL (email üzerinde tekil dizin yok).
- Testler: domain testine İnsan Kaynakları/ISIK/NBSP+tab eklendi; yeni apps/api/test/directorySchema.test.ts (SQL = JS katlaması, backfill formülü, email NULL).
- Çıktı: migrate "applied 041"; domain 15 dosya/163 test geçti; api 24 dosya geçti, 237 test geçti/43 atlandı; typecheck temiz.
