// Entegrasyon testleri gerçek PostgreSQL (RLS, sp_app rolü) ve S3 uyumlu yerel depo kullanır.
export const TEST_OWNER_URL = process.env.TEST_DATABASE_OWNER_URL ?? 'postgres://sp_owner:local_owner_only@localhost:5544/satinalma_test';
export const TEST_APP_URL = process.env.TEST_DATABASE_URL ?? 'postgres://sp_app:local_app_only@localhost:5544/satinalma_test';
export const TEST_S3_ENDPOINT = process.env.TEST_OBJECT_STORE_ENDPOINT ?? 'http://localhost:9190';
