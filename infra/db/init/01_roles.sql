-- Uygulama rolü: RLS'i atlayamaz (NOSUPERUSER, NOBYPASSRLS). Şifre yalnız yerel geliştirme içindir.
CREATE ROLE sp_app LOGIN PASSWORD 'local_app_only' NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
-- Test veritabanı: entegrasyon testleri ayrı DB'de çalışır.
CREATE DATABASE satinalma_test OWNER sp_owner;
