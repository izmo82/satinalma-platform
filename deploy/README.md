# Dağıtım

Aynı iki imaj (`Dockerfile.api`, `Dockerfile.web`) her ortamda kullanılır. Bileşen seçenekleri ve ilkeler: `docs/architecture.md`.

## İmajları derleme
```bash
docker build -f Dockerfile.api -t registry.kurum.local/satinalma/api:0.1.0 .
docker build -f Dockerfile.web -t registry.kurum.local/satinalma/web:0.1.0 .
```
Podman ile de aynı komutlar çalışır. API imajı derlenmiş JS çalıştırır (`apps/api/dist`); çalışma anında TypeScript veya tsx yoktur.

## A. Tek sunucu: Docker Compose (`deploy/compose`)
Kurum içi bir VM veya fiziksel sunucu için. PostgreSQL ve SeaweedFS (S3 uyumlu) yığının içindedir; kimlik için kurumun IdP'si veya isteğe bağlı Keycloak kullanılır.
```bash
cd deploy/compose
cp .env.example .env        # CHANGE_ME değerlerini güçlü rastgele değerlerle değiştirin
docker compose --profile idp up -d     # kurumun IdP'si varsa: docker compose up -d
```
- Web `127.0.0.1:8080` üzerinde dinler; TLS kurumun ters vekilinde sonlanır (`WEB_BIND`, `WEB_PORT`).
- Harici PostgreSQL veya S3 kullanmak için ilgili servisi kaldırıp `DATABASE_URL`/`OBJECT_STORE_ENDPOINT` değerlerini değiştirin.
- Kurumun IdP'si için: public client (PKCE S256), yönlendirme `https://<alan>/auth/callback`, access token'da `aud=sp-api` ve doğrulanmış `email` claim'i. API, IdP'nin token uç noktasına sunucudan erişebilmeli (web oturumu sunucuda, BFF).

İlk kiracı ve ilk yönetici:
```bash
docker compose run --rm --no-deps -e DATABASE_OWNER_URL="postgres://sp_owner:<OWNER_DB_PASSWORD>@db:5432/satinalma" \
  api node apps/api/dist/provision.js tenant:create --name "Kurum A.Ş." --region TR --company "Kurum A.Ş." --tax-type VKN --tax-id <VKN>
docker compose run --rm --no-deps -e DATABASE_OWNER_URL=... api node apps/api/dist/provision.js \
  user:invite --tenant <tenantId> --email yonetici@kurum.com.tr --name "Ad Soyad" --roles TENANT_ADMIN --companies all
```
Tedarikçi portalı kullanıcısı (yalnız davet edildiği teklif turlarını görür):
```bash
docker compose run --rm --no-deps -e DATABASE_OWNER_URL=... api node apps/api/dist/provision.js \
  user:invite --tenant <tenantId> --email teklif@tedarikci.com.tr --name "Ad Soyad" --roles SUPPLIER --supplier <supplierId>
```
Kullanıcı IdP'de oturum açtığında davet bağlanır. Parola uygulamada tutulmaz.

## B. Kurum içi Kubernetes: Kustomize (`deploy/kubernetes`)
Vanilla Kubernetes 1.29+, OpenShift, RKE2/k3s, Tanzu. Yalnız `kubectl` gerekir (Helm gerekmez).

**Ön koşullar (kurumun sağladığı):**
| Bileşen | Gereksinim |
|---|---|
| PostgreSQL 15+ | Uygulama veritabanı ve owner rolü; `sp_app` rolü: `CREATE ROLE sp_app LOGIN PASSWORD '...' NOSUPERUSER NOBYPASSRLS;` (CloudNativePG/Patroni veya mevcut küme) |
| S3 uyumlu depo | Ceph RGW, MinIO, StorageGRID; bir bucket ve erişim anahtarı (path-style destekli) |
| OIDC IdP | ADFS 2019+, Keycloak (AD/LDAP federasyonlu) veya Entra ID; ayrıntı: [IDP.md](IDP.md) |
| Ingress | Kümenin ingress denetleyicisi ve TLS sertifikası (`satinalma-tls`) |
| İmaj kayıt defteri | Kurum içi kayıt defteri (Harbor, Nexus, Artifactory) |
| İç CA | Gerekirse `satinalma-ca` ConfigMap'i (`components/internal-ca`) |

**Kurulum sırası:**
```bash
# 1. Ortam katmanı: overlays/example kopyalanır; kayıt defteri, alan adı, IdP, S3 ve egress CIDR'ları düzenlenir.
cp -r deploy/kubernetes/overlays/example deploy/kubernetes/overlays/kurum
# 2. Ad alanı (restricted Pod Security) ve sırlar (tercihen Vault / External Secrets / Sealed Secrets)
kubectl apply -f deploy/kubernetes/overlays/kurum/namespace.yaml
kubectl -n satinalma create secret generic satinalma-secrets \
  --from-literal=DATABASE_URL='postgres://sp_app:...@pg.kurum.local:5432/satinalma' \
  --from-literal=OBJECT_STORE_ACCESS_KEY=... --from-literal=OBJECT_STORE_SECRET_KEY=... \
  --from-literal=SESSION_SECRET="$(openssl rand -hex 32)"   # web oturum token'larını şifreler (BFF)
kubectl -n satinalma create secret generic satinalma-migrate-secrets \
  --from-literal=DATABASE_OWNER_URL='postgres://sp_owner:...@pg.kurum.local:5432/satinalma'
kubectl -n satinalma create configmap satinalma-ca --from-file=ca.crt=kurum-kok-ca.pem   # iç CA varsa
# 3. Uygulama ve ağ politikaları, ardından her sürümde: migration, sonra rollout
kubectl apply -k deploy/kubernetes/overlays/kurum
kubectl -n satinalma delete job satinalma-migrate --ignore-not-found
kubectl -n satinalma apply -k deploy/kubernetes/migrate      # migrate/kustomization.yaml'daki imajı da ayarlayın
kubectl -n satinalma wait --for=condition=complete job/satinalma-migrate --timeout=300s
kubectl -n satinalma rollout status deployment/satinalma-api
# 4. İlk kiracı ve yönetici daveti: ops/provision-job.yaml (argümanları düzenleyip uygulayın)
```
- Pod'lar `restricted` Pod Security standardına uygundur (root değil, salt okunur kök, yetenek yok, seccomp).
- Gelen trafik kapalıdır: web dışarıdan, API yalnız web'den. Giden trafik `egress-networkpolicy.yaml` ile yalnız DNS, PostgreSQL, S3 ve IdP'ye açıktır.
- Kurum vekil sunucusu: ConfigMap'e `NODE_USE_ENV_PROXY=1`, `HTTPS_PROXY`, `NO_PROXY` (iç servisleri NO_PROXY'ye ekleyin). NOT_RUN.
- Owner bağlantısı yalnız migration ve kurulum Job'larında bulunur.

**Yerel doğrulama (kind):** `deploy/kubernetes/dev/up.sh` kümeyi, bağımlılıkları (yalnız doğrulama amaçlı PostgreSQL, SeaweedFS, Keycloak) ve uygulamayı kurar; `dev/smoke.sh <efatura.xml>` uçtan uca kontrolleri çalıştırır. Sırlar `dev/.env` dosyasında rastgele üretilir (git dışı). Silmek: `kind delete cluster --name satinalma`.
