# Dağıtım mimarisi: sağlayıcıdan bağımsız

Uygulama belirli bir bulut veya ürün sağlayıcısına bağlı değildir. Aynı imajlar kurum içi veri merkezinde, sanal makinede, herhangi bir Kubernetes dağıtımında veya herhangi bir bulutta çalışır. Her dış bağımlılık açık bir standart üzerinden kullanılır; sağlayıcı değişikliği kod değil, yapılandırma değişikliğidir.

```
 Tarayıcı / iOS
   │ HTTPS (kurumun TLS sonlandırıcısı: F5, HAProxy, ingress, bulut LB...)
   ▼
 web (nginx, ayrıcalıksız) ── /api ──▶ api (N kopya, durumsuz) ──▶ PostgreSQL 15+ (RLS)
   │                                     │       ▲                       ▲
   │ PKCE ile token                      │       │ jobs/outbox           │
   ▼                                     ▼       │ (aynı transaction)    │
 OIDC IdP (kurumun mevcut IdP'si)       S3 API ◀─┴── worker (N kopya) ───┘
                                        (tarayıcıya açılmaz)
```

## Standart arayüzler ve değiştirilebilir bileşenler

| Bağımlılık | Kullanılan standart | Kurum içi seçenekler | Bulut seçenekleri | Uygulamadaki yapılandırma |
|---|---|---|---|---|
| Çalışma ortamı | OCI imajı, ayrıcalıksız, salt okunur kök dosya sistemi | Kubernetes, OpenShift, RKE2/k3s, Docker/Podman, tek VM | EKS/AKS/GKE, Cloud Run, Container Apps, ECS | `Dockerfile.api`, `Dockerfile.web` |
| Veritabanı | PostgreSQL 15+ (RLS, `SKIP LOCKED`) | PostgreSQL + Patroni, CloudNativePG, Crunchy | RDS/Aurora, Azure Flexible, Cloud SQL | `DATABASE_URL`, `DATABASE_OWNER_URL` |
| Nesne deposu | S3 API (path-style destekli) | Ceph RGW, SeaweedFS, MinIO, NetApp StorageGRID, Dell ECS | S3, R2, GCS (XML API) | `OBJECT_STORE_*`, `AWS_ACCESS_KEY_ID/SECRET` |
| Kimlik | OpenID Connect + PKCE, JWKS | Keycloak, ADFS 2019+, Authentik, Gluu | Entra ID, Okta, Auth0, Cognito | `OIDC_ISSUER`, `OIDC_JWKS_URL`, `OIDC_AUDIENCE`, `OIDC_CLIENT_ID` |
| Kuyruk | PostgreSQL tablosu (`jobs`, `outbox_events`) | Ek bileşen gerekmez | Ek bileşen gerekmez | — |
| Sırlar | Ortam değişkeni / Kubernetes Secret | Vault, Sealed Secrets, External Secrets | Secret Manager, Key Vault | — |
| Gözlemlenebilirlik | stdout JSON log, `/health` | Loki/ELK, Prometheus | Bulut log servisleri | NOT_RUN: metrik/iz |

Uygulama kodunda sağlayıcıya özel SDK yalnız S3 istemcisidir ve yalnız S3 protokolünü konuşur (`apps/api/src/storage.ts`). Dosya içerikleri tarayıcıya imzalı URL ile değil API üzerinden, yetki kontrolünden sonra akar; nesne deposu iç ağda kalabilir.

## Dağıtım seçenekleri

| Seçenek | Ne zaman | Dosyalar | Doğrulama |
|---|---|---|---|
| Tek sunucu (Docker Compose) | Pilot, küçük kurum, tek VM, kurum içi | `deploy/compose/` (PostgreSQL, SeaweedFS, isteğe bağlı Keycloak) | PASS: yığın ayağa kalktı, uçtan uca duman testi ve tarayıcı girişi |
| Kubernetes (Kustomize) | Yüksek erişilebilirlik, kurum Kubernetes'i veya yönetilen Kubernetes | `deploy/kubernetes/` (temel + migration Job + örnek katman) | PASS: kubeconform şema doğrulaması (K8s 1.33). Gerçek kümeye uygulama NOT_RUN |
| Yerel geliştirme | Geliştirici makinesi | kök `docker-compose.yml` + `npm run dev:*` | PASS |

Helm yerine Kustomize seçildi: `kubectl` içinde yerleşik, ek araç ve şablon dili gerektirmez, OpenShift dahil her dağıtımda aynı çalışır (bkz. `docs/decisions.md` D18).

## Tasarım ilkeleri
- **Durumsuzluk:** Diske dosya yazılmaz (kök dosya sistemi salt okunur); oturum token tabanlı; her kopya eşdeğer.
- **Kiracı izolasyonu:** Kiracı üyelikten türetilir; DB'de RLS (şirket kapsamı dahil), nesne anahtarı kiracı önekli.
- **Kimlik:** Kullanıcı önce kurulum aracıyla davet edilir; IdP'den ilk girişte, IdP e-postayı doğrulanmış bildirirse davet o IdP hesabına (`oidc|issuer|sub`) bağlanır. Davetsiz hesap içeri giremez; bağlanmış daveti başka bir IdP hesabı ele geçiremez.
- **En az yetki:** Uygulama `sp_app` (NOBYPASSRLS) ile çalışır; owner bağlantısı yalnız migration ve kurulum işinde bulunur.
- **Asenkron işler:** `jobs` + `claim_jobs()` (SKIP LOCKED); worker işi isteyen kullanıcının güncel üyeliğiyle yeniden yetkilendirir.
- **Veri bölgesi:** `DATA_REGION` kiracı politikası; AI/OCR sağlayıcı seçimi bu bölgeyi aşamaz (`selectDetector`). Kurum içi kurulumda veri kurumdan çıkmaz.

## Karar bekleyenler (kullanıcı)
1. İlk hedef ortam (kurum içi Kubernetes, tek sunucu veya belirli bir bulut) ve kullanılacak kurumsal IdP.
2. Veri bölgesi: Türkiye içi zorunlu mu (KVKK yurt dışı aktarım). Kurum içi kurulumda varsayılan TR.
3. Yedekleme ve felaket kurtarma hedefleri (RPO/RTO); bkz. `docs/runbook.md`.
