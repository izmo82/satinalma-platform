-- Faz 2 kalanları (04: üst çubukta arama ve bildirim; tablo: kaydedilen görünüm, kolon seçimi).
-- Kişisel kayıtlar: yalnız sahibi görür (kiracı + kullanıcı RLS). Bildirim, görevlerden türetilir; yalnız "son görülme" saklanır.

CREATE TABLE notification_reads (
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  user_id uuid NOT NULL REFERENCES users(id),
  last_seen_at timestamptz NOT NULL,
  PRIMARY KEY (tenant_id, user_id)
);

CREATE TABLE saved_views (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  user_id uuid NOT NULL REFERENCES users(id),
  page text NOT NULL CHECK (page IN ('projects','invoices','purchase_orders','tasks','suppliers','contracts')),
  name text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 60),
  params jsonb NOT NULL CHECK (jsonb_typeof(params) = 'object' AND length(params::text) <= 4000),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, user_id, page, name)
);

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['notification_reads','saved_views'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY own ON %I USING (tenant_id = app_tenant_id() AND user_id = app_user_id()) '
                   'WITH CHECK (tenant_id = app_tenant_id() AND user_id = app_user_id())', t);
  END LOOP;
END $$;
GRANT SELECT, INSERT ON notification_reads TO sp_app;
GRANT UPDATE (last_seen_at) ON notification_reads TO sp_app;
GRANT SELECT, INSERT, DELETE ON saved_views TO sp_app;
