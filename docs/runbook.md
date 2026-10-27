# Runbook

## Yerel kurulum (bulut servislerinin yerel karşılıklarıyla)
```bash
cp .env.example .env   # DEV_AUTH_SECRET'i doldurun: openssl rand -hex 32
npm install
docker compose up -d   # PostgreSQL 17 (5544) + S3 emülatörü (9190)
npm run db:migrate
npm run db:seed        # SENTETİK demo verisi (tekrar çalıştırılırsa atlar)
npm run dev:api        # http://localhost:4100  (OpenAPI: /api/openapi.json)
npm run dev:web        # http://localhost:5174
```
Sentetik kullanıcılar giriş ekranında listelenir (`*@example.test`). Dev oturumu üretimde kapalıdır.

## Testler
```bash
npm test -w @sp/domain                 # saf iş kuralları
npm test -w @sp/api                    # gerçek PostgreSQL + RLS + S3 emülatörü (satinalma_test DB'sini sıfırlar)
npm run typecheck
npm run e2e -w @sp/web                 # önce API + web çalışıyor ve seed yapılmış olmalı
npx playwright install chromium        # ilk kez
```
iOS (Xcode 27, simülatör):
```bash
cd ios/Satinalma && xcodebuild -project Satinalma.xcodeproj -scheme Satinalma -destination 'platform=iOS Simulator,name=iPhone 18 Pro' -derivedDataPath build CODE_SIGNING_ALLOWED=NO build
```

## Üretim benzeri yığın (kurum içi veya herhangi bir sunucu)
Ayrıntı: `deploy/README.md`. Özet:
```bash
cd deploy/compose && cp .env.example .env   # CHANGE_ME değerlerini değiştirin
docker compose --profile idp up -d          # kurumun IdP'si varsa --profile idp olmadan
docker compose down                         # durdurma (veri volume'larda kalır)
```
İlk kiracı/yönetici: `node apps/api/dist/provision.js tenant:create …` ve `user:invite …` (owner bağlantısıyla). Kullanıcı IdP'de ilk oturum açtığında davet bağlanır.

## Yedekleme (sağlayıcıdan bağımsız)
| Veri | Yöntem | Not |
|---|---|---|
| PostgreSQL | `pg_dump -Fc` günlük + WAL arşivi (pgBackRest / Barman / CloudNativePG yedekleri) ile PITR | Restore tatbikatı Faz 7'de; NOT_RUN |
| Nesne deposu | Sürümleme + ikinci konuma çoğaltma (Ceph RGW multisite, `rclone sync`, bulut çoğaltma) | Anahtarlar içerik hash'i olduğu için çoğaltma idempotent |
| IdP | IdP'nin kendi yedeği (Keycloak: veritabanı yedeği) | Kullanıcı rolleri uygulamada, kimlik IdP'de |

## Sır gereksinimleri
| Değişken | Nereden | Not |
|---|---|---|
| `DATABASE_URL` | Secret manager | `sp_app` rolü; NOBYPASSRLS |
| `DATABASE_OWNER_URL` | Secret manager, yalnız migration işi | Uygulama bu rolle çalışmaz |
| `OIDC_ISSUER/AUDIENCE/JWKS_URL/CLIENT_ID` | IdP (herhangi bir OIDC sağlayıcı) | Üretimde `AUTH_MODE=oidc` zorunlu; sır değildir |
| `DEV_AUTH_SECRET` | Yalnız yerel | Üretimde tanımlanmaz |
| `AWS_ACCESS_KEY_ID/SECRET_ACCESS_KEY` | Sır yöneticisi (Vault, K8s Secret) veya bulut IAM rolü | Yalnız uygulamanın bucket'ı için yetkili hesap |

## Migration ve rollback
- Migration'lar ileri yönlüdür ve `schema_migrations` içinde checksum ile izlenir; uygulanmış dosya değiştirilirse çalıştırma durur.
- Geri dönüş: yıkıcı `DROP` yerine telafi edici yeni migration (`00N_revert_….sql`). Önce PITR anlık görüntüsü alınır.
- Uygulama sürümü bir önceki şemayla uyumlu kalacak şekilde genişlet→taşı→daralt sırası izlenir.
- Kiracı bazlı geri yükleme: izole anlık görüntüye restore + seçili kiracı verisinin yeniden içe alınması; tüm DB geri alınmaz (Faz 7'de prosedür testi).

## Kuyruk ve tekrar oynatma
- İş durumları: `QUEUED → RUNNING → SUCCEEDED | BLOCKED | QUEUED (geri çekilme) → DEAD`.
- `BLOCKED` işler dış bağımlılık (ör. `NO_PROVIDER_CONFIGURED`) içindir; sağlayıcı bağlanınca yetkili kişi aynı uçtan yeni iş ister (idempotency anahtarı sağlayıcı/model içerdiği için yeni iş açılır).
- `DEAD` işler için yetkili replay: `UPDATE jobs SET status='QUEUED', attempts=0 WHERE id=…` (owner bağlantısı, gerekçe denetim kaydına).

## Sık hatalar
| Belirti | Neden | Çözüm |
|---|---|---|
| API 401 `unauthenticated` | Token süresi doldu / IdP ayarı | Yeniden oturum; `OIDC_*` kontrolü |
| API 403 `not_invited` | Kullanıcı davet edilmemiş veya IdP e-postayı doğrulanmış bildirmiyor | `provision.js user:invite`; IdP'de e-posta doğrulaması ve `email` claim'i |
| Giriş ekranı "Oturum hizmetine ulaşılamadı" (503 `idp_unavailable`) | API IdP keşif belgesine erişemiyor | `OIDC_DISCOVERY_URL` iç ağ adresi, DNS/güvenlik duvarı |
| Tarayıcıda token isteği CSP hatası | `CSP_IDP_ORIGIN` boş/yanlış | IdP kökenini web ortam değişkenine yazın |
| Web konteyneri başlıyor ama 8080 yanıt vermiyor | `/etc/nginx/conf.d` yazılamıyor | Bu dizine yazılabilir tmpfs/emptyDir bağlayın (compose ve manifestlerde hazır) |
| API 403 `tenant_not_selected` | `X-Tenant-Id` üyelik dışı | Kiracı seçicisinden geçerli kiracı |
| 409 `version_conflict` | Başkası değiştirdi | Sayfayı yenileyip yeniden karar verin |
| 422 `unresolved_requirements` | İmza kanıtı eksik | `details.blockers` listesindeki adımlar |
| Web boş sayfa, Vite "moduleType" | Birden çok Vite sürümü | Tek Vite (kökte 8.x) ve `@vitejs/plugin-react` 6.x |
