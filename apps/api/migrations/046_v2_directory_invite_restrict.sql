-- v2 Faz 2 (D105) Görev 4 düzeltme: 045 uygulanmış olduğundan değiştirilmez; directory_invite_user burada daraltılır.
-- Güvenlik: Graph `mail` alanı Entra yöneticisince yazılabilir ve doğrulanmış değildir. 045 herhangi bir IdP'nin `oidc|` kullanıcısını
-- e-postayla döndürüyordu; bir kurum yöneticisi başka kurumun kullanıcısını kendi kurumuna bağlayabiliyordu (varlık/ad sızıntısı,
-- görev ve rol ataması, kurban için tenant_not_selected). Kontrolcü kararı (kısıtlayıcı):
--   (a) e-postası eşleşen ve BU kiracıda (herhangi durumda) üyeliği olan kullanıcı yeniden kullanılır;
--   (b) hiçbir kiracıda üyeliği olmayan `invite|<e-posta>` kullanıcısı yeniden kullanılır;
--   (c) e-postayla hiçbir kullanıcı yoksa yeni davetli kullanıcı açılır;
--   aksi halde (başka kurumda üyeliği olan ya da bu kiracıda üyeliği olmayan OIDC vb. kullanıcı) NULL döner: kimlik ya da ad
--   döndürülmez, hiçbir şey oluşturulmaz. Uygulama NULL'u 409 `user_in_other_tenant` olarak döndürür.
CREATE OR REPLACE FUNCTION directory_invite_user(p_email text, p_display_name text) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_tenant uuid := app_tenant_id();
  v_email text := lower(btrim(coalesce(p_email, '')));
  v_id uuid;
BEGIN
  IF v_tenant IS NULL THEN
    RAISE EXCEPTION 'directory_invite_user: tenant context required';
  END IF;
  IF v_email !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$' THEN
    RAISE EXCEPTION 'directory_invite_user: invalid email';
  END IF;
  -- (a) Bu kiracıda üyeliği olan kullanıcı.
  SELECT u.id INTO v_id FROM users u
   WHERE lower(u.email) = v_email AND EXISTS (SELECT 1 FROM memberships m WHERE m.user_id = u.id AND m.tenant_id = v_tenant)
   ORDER BY u.created_at, u.id LIMIT 1;
  IF v_id IS NOT NULL THEN RETURN v_id; END IF;
  -- (b) Hiçbir kiracıda üyeliği olmayan davetli kullanıcı.
  SELECT u.id INTO v_id FROM users u
   WHERE u.auth_subject = 'invite|' || v_email AND NOT EXISTS (SELECT 1 FROM memberships m WHERE m.user_id = u.id);
  IF v_id IS NOT NULL THEN RETURN v_id; END IF;
  -- Başka bir kullanıcı bu e-postayı taşıyorsa: yeniden kullanılmaz, yenisi de açılmaz.
  IF EXISTS (SELECT 1 FROM users u WHERE lower(u.email) = v_email OR u.auth_subject = 'invite|' || v_email) THEN
    RETURN NULL;
  END IF;
  -- (c) Yeni davetli kullanıcı. Eşzamanlı aynı davette ON CONFLICT: diğerinin açtığı satır, üyeliği yoksa (b) ile kullanılır.
  INSERT INTO users (auth_subject, email, display_name)
  VALUES ('invite|' || v_email, v_email, left(coalesce(nullif(btrim(p_display_name), ''), v_email), 200))
  ON CONFLICT (auth_subject) DO NOTHING RETURNING id INTO v_id;
  IF v_id IS NULL THEN
    SELECT u.id INTO v_id FROM users u
     WHERE u.auth_subject = 'invite|' || v_email AND NOT EXISTS (SELECT 1 FROM memberships m WHERE m.user_id = u.id AND m.tenant_id <> v_tenant);
  END IF;
  RETURN v_id;
END $$;
REVOKE ALL ON FUNCTION directory_invite_user(text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION directory_invite_user(text, text) TO sp_app;
