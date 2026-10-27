#!/bin/sh
# İlk açılışta: uygulama rolü (RLS'i atlayamaz) ve isteğe bağlı Keycloak veritabanı. Parolalar ortamdan gelir.
set -eu
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" \
  -v app_pw="$APP_DB_PASSWORD" -v kc_pw="${KEYCLOAK_DB_PASSWORD:-}" <<'SQL'
CREATE ROLE sp_app LOGIN PASSWORD :'app_pw' NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
SELECT :'kc_pw' <> '' AS kc \gset
\if :kc
CREATE ROLE keycloak LOGIN PASSWORD :'kc_pw' NOSUPERUSER NOCREATEDB NOCREATEROLE;
CREATE DATABASE keycloak OWNER keycloak;
\endif
SQL
