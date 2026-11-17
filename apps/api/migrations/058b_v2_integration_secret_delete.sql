-- 058b v2 Faz 8 (D113) Görev 4: uç nokta sırrı kaldırılabilir (PUT gövdesinde `secret: null` → "ayarlı değil"; Ruling 5).
-- Kurallar:
--  * Yalnız integration_endpoint_secrets satırı silinir; uç nokta, çalışma, hata kaydı ve ERP yazma kaydı silinemez (057 aynen).
--  * Silme kiracı RLS politikasıyla (scope: tenant_id = app_tenant_id(), tedarikçi bağlamı kapalı) sınırlıdır: başka kiracının
--    ya da tedarikçi bağlamının sırrı silinemez. Denetim uygulamada yazılır (integration.endpoint.updated, secretRemoved; değer yok).
--  * Bu dosya hiçbir satırı değiştirmez.
GRANT DELETE ON integration_endpoint_secrets TO sp_app;
