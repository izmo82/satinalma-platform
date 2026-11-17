-- v2 Faz 2 (D105) Görev 4: dizin kullanıcısına rol ataması (R3). 040-044 uygulanmış olduğundan değiştirilmez.
-- Kullanıcı tablosu kiracılar arası ortaktır ve RLS (u_same_tenant) yalnız bu kiracıda üyeliği olanı gösterir. Aynı e-postayla
-- başka kiracıda OIDC ile girmiş ya da davet edilmiş kullanıcı görünmediğinden ikinci kullanıcı açılırdı (Review Focus 2).
-- Dar kapı: e-postaya göre var olan kullanıcının YALNIZ kimliğini döndürür (provision user:invite ile aynı eşleme: lower(email) ve
-- 'invite|<e-posta>' ya da 'oidc|...' kimliği); yoksa davetli kullanıcı açar. Başka alan dönmez. Kiracı bağlamı zorunludur.
-- Departman birleştirmesi (R6) için ek GRANT gerekmez: department_id taşıyan bütün tablolarda UPDATE (department_id) 035/040'ta var.
CREATE OR REPLACE FUNCTION directory_invite_user(p_email text, p_display_name text) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_email text := lower(btrim(coalesce(p_email, '')));
  v_id uuid;
BEGIN
  IF app_tenant_id() IS NULL THEN
    RAISE EXCEPTION 'directory_invite_user: tenant context required';
  END IF;
  IF v_email !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$' THEN
    RAISE EXCEPTION 'directory_invite_user: invalid email';
  END IF;
  SELECT u.id INTO v_id FROM users u
   WHERE lower(u.email) = v_email AND (u.auth_subject = 'invite|' || v_email OR u.auth_subject LIKE 'oidc|%')
   ORDER BY u.created_at, u.id LIMIT 1;
  IF v_id IS NULL THEN
    INSERT INTO users (auth_subject, email, display_name)
    VALUES ('invite|' || v_email, v_email, left(coalesce(nullif(btrim(p_display_name), ''), v_email), 200))
    ON CONFLICT (auth_subject) DO NOTHING RETURNING id INTO v_id;
    IF v_id IS NULL THEN
      SELECT u.id INTO v_id FROM users u WHERE u.auth_subject = 'invite|' || v_email;
    END IF;
  END IF;
  RETURN v_id;
END $$;
REVOKE ALL ON FUNCTION directory_invite_user(text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION directory_invite_user(text, text) TO sp_app;
