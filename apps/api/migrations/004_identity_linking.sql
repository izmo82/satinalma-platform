-- 004 Sağlayıcıdan bağımsız kimlik bağlama.
-- Kullanıcı önce davet edilir (auth_subject = 'invite|<e-posta>'). Kurumsal IdP'den (Keycloak, Entra ID, Okta, ADFS...)
-- ilk girişte, IdP e-postayı doğrulanmış bildirirse davet satırı IdP subject'ine bağlanır. Davetsiz kullanıcı içeri giremez.
-- Subject biçimi 'oidc|<issuer>|<sub>': aynı sub farklı IdP'de başka kişiyi gösterebilir.

CREATE OR REPLACE FUNCTION auth_link_invited_user(p_subject text, p_email text)
RETURNS TABLE (id uuid, email text, display_name text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_user users%ROWTYPE;
BEGIN
  IF p_subject IS NULL OR p_subject NOT LIKE 'oidc|%' OR coalesce(p_email, '') = '' THEN
    RETURN;
  END IF;
  UPDATE users u SET auth_subject = p_subject
   WHERE u.auth_subject = 'invite|' || lower(p_email)
  RETURNING u.* INTO v_user;
  IF NOT FOUND THEN
    RETURN;
  END IF;
  INSERT INTO audit_events (tenant_id, actor_user_id, action, entity_type, entity_id, data)
  SELECT m.tenant_id, v_user.id, 'user.identity_linked', 'user', v_user.id,
         jsonb_build_object('issuer', split_part(p_subject, '|', 2))
    FROM memberships m WHERE m.user_id = v_user.id;
  RETURN QUERY SELECT v_user.id, v_user.email, v_user.display_name;
END $$;

REVOKE ALL ON FUNCTION auth_link_invited_user(text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION auth_link_invited_user(text, text) TO sp_app;
