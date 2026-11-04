-- Web oturumu sunucuda (BFF): tarayıcı yalnız HttpOnly çerezde rastgele oturum kimliği taşır; IdP token'ları burada şifreli.
-- Kiracıdan bağımsızdır (kimlik doğrulama kiracı seçiminden önce). Uygulama rolünün tabloya doğrudan yetkisi yok;
-- erişim yalnız aşağıdaki dar fonksiyonlarla ve oturum kimliğinin SHA-256 özetiyle (kimliğin kendisi saklanmaz).
CREATE TABLE web_sessions (
  id_hash bytea PRIMARY KEY CHECK (length(id_hash) = 32),
  user_subject text NOT NULL,
  mode text NOT NULL CHECK (mode IN ('oidc', 'dev')),
  -- AES-256-GCM ile şifreli {access, refresh, id, accessExp}; dev oturumunda yok.
  tokens bytea,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  CHECK ((mode = 'oidc') = (tokens IS NOT NULL))
);
CREATE INDEX web_sessions_expires ON web_sessions (expires_at);
ALTER TABLE web_sessions ENABLE ROW LEVEL SECURITY;
-- Politika yok: sahip dışında doğrudan satır erişimi kapalı. Fonksiyonlar SECURITY DEFINER (sahip) olarak çalışır;
-- FORCE kullanılmaz, yoksa sahip de (süper kullanıcı olmayan üretim kurulumunda) satır göremez.
REVOKE ALL ON web_sessions FROM PUBLIC;

CREATE FUNCTION web_session_create(p_hash bytea, p_subject text, p_mode text, p_tokens bytea, p_expires timestamptz)
RETURNS void LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  -- Süresi dolanlar oturum açılırken temizlenir (ayrı iş gerekmez).
  DELETE FROM web_sessions WHERE expires_at < now() - interval '1 hour';
  INSERT INTO web_sessions (id_hash, user_subject, mode, tokens, expires_at) VALUES (p_hash, p_subject, p_mode, p_tokens, p_expires);
$$;

CREATE FUNCTION web_session_get(p_hash bytea)
RETURNS TABLE (user_subject text, mode text, tokens bytea, last_seen_at timestamptz, expires_at timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT s.user_subject, s.mode, s.tokens, s.last_seen_at, s.expires_at FROM web_sessions s WHERE s.id_hash = p_hash
$$;

CREATE FUNCTION web_session_touch(p_hash bytea)
RETURNS void LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  UPDATE web_sessions SET last_seen_at = now() WHERE id_hash = p_hash
$$;

CREATE FUNCTION web_session_set_tokens(p_hash bytea, p_tokens bytea)
RETURNS void LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  UPDATE web_sessions SET tokens = p_tokens, last_seen_at = now() WHERE id_hash = p_hash AND mode = 'oidc'
$$;

CREATE FUNCTION web_session_delete(p_hash bytea)
RETURNS void LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  DELETE FROM web_sessions WHERE id_hash = p_hash
$$;

REVOKE ALL ON FUNCTION web_session_create(bytea, text, text, bytea, timestamptz), web_session_get(bytea), web_session_touch(bytea),
  web_session_set_tokens(bytea, bytea), web_session_delete(bytea) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION web_session_create(bytea, text, text, bytea, timestamptz), web_session_get(bytea), web_session_touch(bytea),
  web_session_set_tokens(bytea, bytea), web_session_delete(bytea) TO sp_app;
