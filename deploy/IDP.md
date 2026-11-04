# Kurumsal kimlik sağlayıcısı (IdP) bağlantısı

Uygulama standart OpenID Connect (yetkilendirme kodu + PKCE) kullanır; IdP'ye özel kod yoktur. Web girişi sunucu tarafındadır (BFF, `docs/decisions.md` D78): kodu API token'a çevirir, token'lar şifreli olarak sunucuda kalır, tarayıcıda yalnız HttpOnly oturum çerezi bulunur. Kullanıcı önce kurulum aracıyla **davet edilir**, IdP'den ilk girişte davet o IdP hesabına bir kez bağlanır. Rol ve şirket yetkileri uygulamada tutulur (IdP grupları henüz role eşlenmez).

## Ortak gereksinimler
| Gereksinim | Değer |
|---|---|
| İstemci türü | Public client + PKCE S256 (önerilen), ya da gizli istemci: sır yalnız API'de `OIDC_CLIENT_SECRET` |
| Yönlendirme adresi | `https://<alan>/auth/callback` |
| Çıkış dönüş adresi | `https://<alan>/` |
| Erişim token'ı | JWT, RS256/ES256, `aud` = API tanımlayıcısı (`OIDC_AUDIENCE`) |
| Kalıcı kullanıcı anahtarı | Değişmeyen bir claim (`sub`, `oid` veya objectGUID); e-posta veya UPN anahtar olarak kullanılmaz |
| E-posta | İlk girişte davetle eşleşmek için; doğrulanmış olmalı (aşağıya bakın) |
| Sunucudan erişim | API keşif belgesine, JWKS'e, token ve iptal uç noktalarına erişebilmeli (tarayıcı token uç noktasını çağırmaz; CORS gerekmez) |
| Oturum sırrı | `SESSION_SECRET` (≥32 karakter, `openssl rand -hex 32`): sunucudaki token'ları şifreler; değişirse açık oturumlar biter |
| Sertifika | IdP iç CA ile imzalıysa `components/internal-ca` (Kubernetes) veya `NODE_EXTRA_CA_CERTS` |

**iOS istemcisi (ayrı public client):** PKCE S256 zorunlu; yönlendirme ve çıkış dönüş adresi `<paket kimliği>:/oauth/callback` (varsayılan `com.example.satinalma:/oauth/callback`, paket kimliği değişirse ikisi birlikte değişir); erişim token'ına web istemcisiyle aynı `aud` eklenir; yenileme belirteci verilir ve iptal uç noktası (`revocation_endpoint`, RFC 7009) public istemciye açıktır. Uygulama giriş için sistem tarayıcı oturumunu (`ASWebAuthenticationSession`, çerez tutmayan geçici oturum) kullanır; parola uygulamaya girilmez, MDM ile dağıtılan kurumsal SSO uzantısı bu oturumda da çalışır. Çıkışta yenileme belirteci IdP'de iptal edilir. Keycloak 26.8.1 ile simülatörde denendi (giriş, süresi dolan belirtecin sessiz yenilenmesi); ADFS ve Entra ID ile NOT_RUN.

## Ayarlar
| Değişken | Varsayılan | Ne zaman değişir |
|---|---|---|
| `OIDC_ISSUER` | — | Keşif belgesindeki `issuer`; kullanıcı anahtarının ad alanıdır, sonradan değiştirilmez |
| `OIDC_DISCOVERY_URL` | `<issuer>/.well-known/openid-configuration` | API IdP'ye farklı (iç) adresten erişiyorsa |
| `OIDC_JWKS_URL` | — | Keşif belgesindeki `jwks_uri` (iç adres olabilir) |
| `OIDC_AUDIENCE` | — | Erişim token'ının `aud` değeri |
| `OIDC_CLIENT_ID` | — | Web için açılan istemci |
| `OIDC_CLIENT_SECRET` | boş | Web istemcisi gizli tanımlandıysa (yalnız API'de) |
| `SESSION_SECRET` | — | Zorunlu (OIDC modu); sır yöneticisinden |
| `SESSION_IDLE_MINUTES` / `SESSION_MAX_HOURS` | `30` / `12` | Kurum oturum politikası |
| `OIDC_NATIVE_CLIENT_ID` | boş | iOS için açılan ayrı public client; boşsa uygulama "mobil giriş yapılandırılmadı" der |
| `OIDC_SCOPE` | `openid profile email` | Entra ID'de API kapsamı eklenir |
| `OIDC_RESOURCE` | boş | ADFS: Web API tanımlayıcısı; istekte `resource` parametresi olarak gider |
| `OIDC_TOKEN_ISSUER` | `OIDC_ISSUER` | Erişim token'ının `iss` değeri farklıysa (ADFS) |
| `OIDC_SUBJECT_CLAIM` | `sub` | Entra ID: `oid`; ADFS: kural ile eklenen değişmez claim |
| `OIDC_EMAIL_CLAIM` | `email` | ADFS: `upn`; Entra ID: `preferred_username` |
| `OIDC_TRUSTED_EMAIL_DOMAINS` | boş | `email_verified` göndermeyen kurum dizini için kurumun alan adları |
| `OIDC_CLOCK_TOLERANCE_SECONDS` | `30` | Sunucu saatleri arasında fark varsa |

**E-posta güveni:** `email_verified: true` ise e-posta kullanılır. Claim hiç yoksa e-posta yalnız `OIDC_TRUSTED_EMAIL_DOMAINS` listesindeki bir alan adındaysa doğrulanmış sayılır. Bu, e-postayı yalnız kurumun kendi dizininin atadığı durumlar içindir. Kullanıcının kendi e-postasını yazabildiği bir IdP'de bu listeyi kullanmayın. `email_verified: false` her durumda reddedilir.

## Keycloak (Active Directory / LDAP federasyonuyla)
1. Realm içe aktarma şablonu: `deploy/compose/keycloak/realm-satinalma.json` (public client `sp-web` ve iOS için `sp-ios`, PKCE S256, `sp-api` audience eşleyicisi, kayıt kapalı). iOS yönlendirmesi `SP_IOS_REDIRECT_URI` (varsayılan `com.example.satinalma:/oauth/callback`; uygulama paket kimliği değişirse ikisi birlikte değişir).
2. User Federation → LDAP: AD bağlantısı, `Edit mode: READ_ONLY`, **Trust Email: açık** (e-posta dizinden gelir, `email_verified=true`).
3. Kullanıcı anahtarı varsayılan `sub` (Keycloak kullanıcı kimliği); LDAP'tan içe aktarılan kullanıcıda değişmez.
4. Ayarlar: `OIDC_ISSUER=https://sso.kurum/realms/satinalma`, `OIDC_JWKS_URL=<issuer>/protocol/openid-connect/certs`, `OIDC_AUDIENCE=sp-api`, `OIDC_CLIENT_ID=sp-web`, `OIDC_NATIVE_CLIENT_ID=sp-ios`.

Durum: Keycloak 26.8.1 ile tek sunucu ve Kubernetes (kind) kurulumlarında uçtan uca denendi. LDAP federasyonu denenmedi.

## AD FS (Windows Server 2019 veya sonrası)
1. Application Group: **Native application** (public client, yönlendirme adresi) + **Web API** (tanımlayıcı ör. `sp-api`, erişim politikası).
2. Web API → Issuance Transform Rules:
   - LDAP: `User-Principal-Name` → `UPN`.
   - Değişmez anahtar için özel kural, örneğin:
     `c:[Type == "http://schemas.microsoft.com/ws/2008/06/identity/claims/windowsaccountname"] => issue(store = "Active Directory", types = ("oid"), query = ";objectGUID;{0}", param = c.Value);`
3. Client Permissions: native uygulamaya `openid`, `profile`, `email` kapsamları.
4. CORS (2019+): `Set-AdfsResponseHeaders -EnableCORS $true` ve `Set-AdfsResponseHeaders -CORSTrustedOrigins https://<alan>`.
5. Ayarlar:
   ```
   OIDC_ISSUER=https://adfs.kurum.com.tr/adfs
   OIDC_DISCOVERY_URL=https://adfs.kurum.com.tr/adfs/.well-known/openid-configuration
   OIDC_JWKS_URL=https://adfs.kurum.com.tr/adfs/discovery/keys
   OIDC_TOKEN_ISSUER=http://adfs.kurum.com.tr/adfs/services/trust
   OIDC_RESOURCE=sp-api
   OIDC_AUDIENCE=sp-api
   OIDC_CLIENT_ID=<native uygulama client id>
   OIDC_SUBJECT_CLAIM=oid
   OIDC_EMAIL_CLAIM=upn
   OIDC_TRUSTED_EMAIL_DOMAINS=kurum.com.tr
   ```
   `OIDC_TOKEN_ISSUER` için, kurumun ADFS'inden alınan gerçek bir erişim token'ındaki `iss` değerini kullanın.

Durum: NOT_RUN. Claim seti (farklı `iss`, `oid`, `upn`, `email_verified` yok) otomatik testle doğrulandı (`apps/api/test/identity.test.ts`). Kurumun gerçek ADFS'iyle denenmedi.

## Microsoft Entra ID (hibrit kurumlar için)
1. API uygulaması: Expose an API → `api://satinalma-api`, kapsam `access_as_user`. Manifest: `requestedAccessTokenVersion: 2`.
2. Web uygulaması: platform **Single-page application**, yönlendirme adresi; API kapsamına izin.
3. Ayarlar:
   ```
   OIDC_ISSUER=https://login.microsoftonline.com/<tenant-id>/v2.0
   OIDC_JWKS_URL=https://login.microsoftonline.com/<tenant-id>/discovery/v2.0/keys
   OIDC_AUDIENCE=<API uygulamasının client id'si>
   OIDC_CLIENT_ID=<SPA client id>
   OIDC_SCOPE=openid profile email offline_access api://satinalma-api/access_as_user
   OIDC_SUBJECT_CLAIM=oid
   OIDC_EMAIL_CLAIM=preferred_username
   OIDC_TRUSTED_EMAIL_DOMAINS=kurum.com.tr
   ```

Durum: NOT_RUN.

## Sorun giderme
| Belirti | Neden | Çözüm |
|---|---|---|
| Giriş sonrası 401 | `aud`/`iss` uyuşmuyor veya saat farkı | Token'ı çözüp `iss`, `aud` değerlerini `OIDC_TOKEN_ISSUER`, `OIDC_AUDIENCE` ile karşılaştırın |
| 403 `not_invited` | Davet yok, e-posta doğrulanmamış veya alan adı listede değil | Kurulum aracıyla davet edin; `OIDC_EMAIL_CLAIM` ve `OIDC_TRUSTED_EMAIL_DOMAINS` değerlerini kontrol edin |
| 503 `idp_unavailable` | API keşif belgesine ulaşamıyor | Giden ağ politikası, DNS, iç CA (`NODE_EXTRA_CA_CERTS`), vekil (`NODE_USE_ENV_PROXY=1`) |
| Geri dönüşte "token vermedi" | Yönlendirme adresi, istemci türü veya API'nin token uç noktasına erişimi | Yönlendirme adresinin birebir eşleşmesi; gizli istemcide `OIDC_CLIENT_SECRET`; API'den token uç noktasına ağ erişimi (Keycloak iç ağda: `KC_HOSTNAME_BACKCHANNEL_DYNAMIC=true`) |
| Geri dönüşte "Oturum isteği eşleşmedi" | Akış çerezi yok/süresi geçti (10 dk) veya farklı kökenden dönüldü | `WEB_ORIGIN` kullanıcıların açtığı adresle aynı olmalı; girişi yeniden başlatın |
