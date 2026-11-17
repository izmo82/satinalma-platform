-- v2 (D102, kullanıcı kararı 17.11.2026 "Evet, versin"): analiz-v2 §2.1 "Yönetici her şeyi görür".
-- Yönetici rolündeki üyelik, kiracının bütün şirketlerini kapsar (v1 D59/T02 "kiracı yöneticisi belge görmez" kuralı v2'de kalktı).
-- Kapsam saklanmaz, her girişte türetilir: sonradan eklenen şirket de kapsama girer, Yönetici rolü kalkınca kapsam da kalkar.
-- Saklanan memberships.company_ids değişmez. Yönetici rolü yazma izni kazanmaz; izinler packages/domain/src/roles.ts'te.
-- Eski kodlar (TENANT_ADMIN, PLATFORM_OPS) 030'da ADMIN'e çevrildi; yine de normalizeRoles ile aynı eşleme burada da tanınır.
CREATE OR REPLACE FUNCTION auth_memberships(p_user_id uuid)
RETURNS TABLE (tenant_id uuid, tenant_name text, roles text[], company_ids uuid[], supplier_id uuid, department_ids uuid[])
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT m.tenant_id, t.name, m.roles,
    CASE WHEN m.supplier_id IS NULL AND m.roles && ARRAY['ADMIN','TENANT_ADMIN','PLATFORM_OPS']
      THEN coalesce((SELECT array_agg(le.id ORDER BY le.id) FROM legal_entities le WHERE le.tenant_id = m.tenant_id), '{}')
      ELSE m.company_ids END,
    m.supplier_id, m.department_ids
  FROM memberships m JOIN tenants t ON t.id = m.tenant_id
  WHERE m.user_id = p_user_id AND m.status = 'ACTIVE'
    AND m.valid_from <= now() AND (m.valid_to IS NULL OR m.valid_to > now())
$$;
REVOKE ALL ON FUNCTION auth_memberships(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION auth_memberships(uuid) TO sp_app;
