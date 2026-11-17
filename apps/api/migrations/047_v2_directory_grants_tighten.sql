-- v2 Faz 2 (D105) dal incelemesi düzeltmesi: 040-046 uygulanmış olduğundan değiştirilmez.
-- (1) 040 sp_app'a users üzerinde INSERT vermişti; 045/046'dan beri davetli kullanıcı yalnız SECURITY DEFINER
--     directory_invite_user ile açılır. Uygulama kodunda sp_app ile users'a INSERT yok (provision, devdata, seedSourcing
--     sahip bağlantısını kullanır). En dar GRANT için geri alınır; memberships INSERT kalır (rol ataması kullanır).
-- (2) directory_sync_tenants (043) SECURITY DEFINER'da search_path'e pg_temp eklenir (046 ile aynı sertleştirme).
REVOKE INSERT ON users FROM sp_app;
ALTER FUNCTION directory_sync_tenants() SET search_path = public, pg_temp;
