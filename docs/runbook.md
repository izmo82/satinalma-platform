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
npm run worker -w @sp/api   # kuyruk işçisi: imza algılama, ihbar/yükümlülük hatırlatma, ERP aktarımı, imha sonrası silme, kiracı dışa aktarımı
```
Sentetik kullanıcılar giriş ekranında listelenir (`*@example.test`). Dev oturumu üretimde kapalıdır.

## Testler
```bash
npm test -w @sp/domain                 # saf iş kuralları
npm test -w @sp/api                    # gerçek PostgreSQL + RLS + S3 emülatörü (satinalma_test DB'sini sıfırlar)
npm run typecheck
npm run e2e -w @sp/web                 # önce API + web + worker çalışıyor ve seed yapılmış olmalı (dışa aktarım testi worker ister)
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
| PostgreSQL | `pg_dump -Fc` günlük + WAL arşivi (pgBackRest / Barman / CloudNativePG yedekleri) ile PITR | Yerel tatbikatlar: `deploy/scripts/db-drill.sh` ve `deploy/scripts/pitr-drill.sh` (aşağıda). Kurum ortamında (gerçek hacim, ayrı depolama) NOT_RUN |
| Nesne deposu | Sürümleme + ikinci konuma çoğaltma (Ceph RGW multisite, `rclone sync`, bulut çoğaltma) | Anahtarlar içerik hash'i olduğu için çoğaltma idempotent |
| IdP | IdP'nin kendi yedeği (Keycloak: veritabanı yedeği) | Kullanıcı rolleri uygulamada, kimlik IdP'de |

**Geri yükleme doğrulaması** (her tatbikatta):
```bash
deploy/scripts/db-drill.sh                                  # yedek → izole kopyaya geri yükleme → satır sayısı + RLS kontrolü → 018→019 yükseltme → yedekten geri dönüş
npx tsx --env-file=.env apps/api/src/verifyStore.ts         # her canlı belge sürümünün nesnesi var mı, SHA-256 tutuyor mu (yalnız sayı ve kimlik yazar)
```
Betik kaynak veritabanına yalnız `pg_dump` ile dokunur; `sp_drill_*` veritabanlarını oluşturup siler (`KEEP=1` ile tutar).
**Yedeklerin zamanla silinmesi** (02 §17): imha edilen belgenin baytları yedeklerde saklama döngüsü bitene kadar kalır. Yedek saklama süresi (ör. 35 gün) kurumca belirlenir ve imha kaydıyla birlikte müşteriye bildirilir; süre dolunca yedek rotasyonu baytları da kaldırır. Kiracı geri yüklemesinde imha kaydı (`document_disposals`) korunduğu için geri gelen bayt kullanıcıya açılmaz; nesne tekrar silinmelidir (`retention.purge` işini yeniden kuyruğa almak).
**Noktasal geri dönüş (PITR) tatbikatı:**
```bash
deploy/scripts/pitr-drill.sh          # WAL arşivli geçici birincil → temel yedek → kaza → hedef ana izole geri dönüş → seçici içe alma
```
Betik geliştirme veritabanına yalnız `pg_dump` ile dokunur; geçici konteynerleri ve birimleri sonunda siler (`KEEP=1` ile tutar). Port çakışırsa `PITR_PRIMARY_PORT`/`PITR_RESTORE_PORT`. Üretimde `archive_timeout` RPO'nun üst sınırıdır (hedef ≤ 15 dk; öneri 60 sn).

**Kiracı bazlı geri yükleme (bütün veritabanı geri döndürülmez):** kazadan önceki ana izole kopyaya PITR → kopyada doğrula → yalnız eksik satırları seçerek içe al:
```bash
# önce deneme (hiçbir şey yazmaz), sonra --apply; owner bağlantıları, kaynak = izole kopya, hedef = canlı
npx tsx apps/api/src/reimport.ts --source postgres://…/kopya --target postgres://…/canli --tenant <kiracı> \
  --tables documents,document_versions [--ids <uuid,…>] --reason "Gerekçe" --operator "Ad Soyad" [--apply]
```
Araç yalnız hedefte olmayan satırları ekler; var olanın üzerine yazmaz (farkı raporlar), silmez; üst kaydı olmayan satırı eklemez; iki şemanın migration sürümü aynı olmalı. Uygulamada kiracının denetim izine `ops.reimport` yazılır. Geri gelen belge sürümlerinin baytları nesne deposu sürümlemesinden geri alınır; sonra `verifyStore.ts` çalıştırılır.

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

## Veri yönetimi (saklama, hukuki saklama, imha, dışa aktarım)
- Saklama süresi belge türü bazında ve dayanağıyla hukuk tarafından tanımlanır (Web: Veri yönetimi). Tanımsız tür **süresiz** saklanır.
- İmha: hukuk önerir → **başka** bir hukuk yetkilisi (partideki bütün şirketlere erişimi olan) onaylar. Onay anında her belge yeniden kontrol edilir (yeni hukuki saklama veya yeni sürüm gelen atlanır). Belge kaydı, hash ve denetim izi kalır; `retention.purge` işi kiracıda başka canlı kayıt kullanmıyorsa nesneyi siler. Silme işi onaylayanın üyeliğine bağlı değildir; sonucu imha partisinde görünür ("Baytlar silindi"). Kuyrukta kalırsa `jobs` içinde `retention.purge` durumuna bakın.
- Kiracı dışa aktarımı: kiracı yöneticisi ister → hukuk onaylar → worker paketi üretir (`exports/<kiracı>/<id>.zip`, en çok 50 GB; akışlı üretilir: satırlar imleçle okunur, paket 16 MB'lık parçalarla yüklenir, worker belleği paket boyutundan bağımsızdır — 96 MB yığınla denendi; nesne deposu S3 çok parçalı yüklemeyi desteklemeli) → yalnız talep eden 7 gün içinde kısa ömürlü bağlantıyla indirir. Paket: `manifest.json` (tablo satır sayıları, her dosyanın SHA-256), `data/*.jsonl`, `files/<sha256>`. Süresi dolan paketlerin nesneleri için bucket yaşam döngüsü kuralı tanımlayın (`exports/` öneki, 8 gün); uygulama süresi dolan paketi indirtmez ama nesneyi kendisi silmez.

## ERP mutabakatı ve CSV aktarımı
ERP bağdaştırıcısı yoksa onaylı faturalar "Yapılandırılmadı" görünür (başarı sayılmaz). Finans (Web: Faturalar → ERP mutabakatı):
1. **Aktarım dosyası (CSV)** indirilir: `aktarim_anahtari;fatura_no;…;odenecek;…` — anahtar değişmez, ERP içe aktarımında dış referans olarak kullanılmalı.
2. ERP'nin sonuç dosyası `aktarim_anahtari;erp_kimligi;durum;odenecek;mesaj` (durum `OK`/`ERROR`) yüklenir, önce **deneme** yapılır: eşleşen, tutar farkı, bilinmeyen anahtar, mükerrer satır, ERP reddi ve dosyada olmayan bekleyenler toplamlarıyla görünür.
3. Uygulanınca yalnız tutarı tutan `OK` satırları ERP'de kayıtlı sayılır; `ERROR` satırları "Hata" olur. Aynı dosyayı tekrar uygulamak değişiklik yapmaz. Dosya özeti (SHA-256) ve sayılar denetim kaydına yazılır.
Bağdaştırıcı varsa başarısız/belirsiz aktarım ekrandan gerekçeyle **tekrar gönderilir**; belirsiz kayıt önce ERP'de aynı anahtarla sorgulanır.

## Performans ölçümü
```bash
# 1) ölçüm kopyası (geliştirme veritabanına dokunmaz) ve hacim büyütme
docker exec satinalma-db pg_dump -U sp_owner -Fc -d satinalma -f /tmp/perf.dump
docker exec satinalma-db createdb -U sp_owner sp_perf && docker exec satinalma-db pg_restore -U sp_owner -d sp_perf /tmp/perf.dump
docker exec -i satinalma-db psql -U sp_owner -d sp_perf < deploy/scripts/perf-prepare.sql
# 2) üretim derlemesi ölçüm kopyasına bağlı (4200) ve yük
npm run build -w @sp/api && (set -a; . ./.env; set +a; DATABASE_URL=${DATABASE_URL%/*}/sp_perf API_PORT=4200 RATE_LIMIT_ENABLED=false node apps/api/dist/index.js &)
PERF_BASE=http://localhost:4200 PERF_SECONDS=15 PERF_CONCURRENCY=10 npx tsx apps/api/src/perf.ts
# 3) temizlik
docker exec satinalma-db dropdb -U sp_owner sp_perf
```
Ölçüm tek makinedir; SLA iddiası değildir. Son sonuçlar `docs/implementation-status.md`.

## Güvenlik taramaları
```bash
npm audit
docker run --rm -v "$PWD:/repo" zricethezav/gitleaks:v8.21.2 git /repo --no-banner --redact
docker run --rm -v "$PWD:/src" semgrep/semgrep:1.101.0 semgrep scan --metrics=off --config p/typescript --config p/nodejs --config p/react --config p/secrets --config p/sql-injection --config p/owasp-top-ten --exclude node_modules --exclude dist /src/apps /src/packages
```
DAST (ZAP) yalnız izole kopyaya karşı çalıştırılır (aktif tarama veri yazar/siler). Kontrol matrisi: `docs/security-controls.md`.

## İstek sınırlama
- API (süreç içi, kopya başına): oturum başına dakikada 600 istek, pahalı uçlarda (rapor, dosya üretimi, yükleme, dışa aktarım, ERP toplu) 30; adres başına dakikada 60 başarısız kimlik doğrulaması (kova boşsa başarısız istek 429 alır; geçerli token hiç etkilenmez) ve geliştirme girişi. Aşımda `429 rate_limited` ve `Retry-After`. `/api/v1/auth/config` sınırlanmaz. Sınıf rota kalıbından belirlenir.
- Ayarlar: `RATE_LIMIT_ENABLED` (üretimde varsayılan `true`, geliştirmede `false`), `RATE_LIMIT_PER_MINUTE`, `RATE_LIMIT_HEAVY_PER_MINUTE`, `RATE_LIMIT_AUTH_PER_MINUTE`. Ölçüm (`perf.ts`) çalıştırılırken kapatılır veya yükseltilir.
- `TRUST_PROXY`: `X-Forwarded-For` başlığına güvenilecek vekillerin adres/CIDR listesi (web nginx, ingress, kurum TLS ters vekili). Atlama sayısı kabul edilmez. Yanlışsa bütün istemciler vekilin adresiyle görünür: oturum sınırı etkilenmez, yalnız adres kovası paylaşılır. Compose varsayılanı yığın ağı `172.30.0.0/24`; Kubernetes'te pod CIDR'ı (örnek `10.244.0.0/16`). Vekil yoksa `TRUST_PROXY=none`.
- Paylaşılan ilk katman ingress'tedir (`deploy/kubernetes/base/ingress.yaml`: adres başına 100 istek/sn, 5× patlama, 100 bağlantı). Çok kopyada API sınırı kopya başına uygulanır (etkin sınır ≈ kopya × sınır).

## Kuyruk ve tekrar oynatma
- İş durumları: `QUEUED → RUNNING → SUCCEEDED | BLOCKED | QUEUED (geri çekilme) → DEAD`.
- `BLOCKED` işler dış bağımlılık (ör. `NO_PROVIDER_CONFIGURED`) içindir; sağlayıcı bağlanınca yetkili kişi aynı uçtan yeni iş ister (idempotency anahtarı sağlayıcı/model içerdiği için yeni iş açılır).
- `DEAD` işler için yetkili replay: `UPDATE jobs SET status='QUEUED', attempts=0 WHERE id=…` (owner bağlantısı, gerekçe denetim kaydına).
- ERP aktarımı için veritabanına dokunmadan: Web → ERP mutabakatı → "Tekrar gönder" (finans, gerekçeli, denetimli).
- Worker iki şeritte çalışır: kiracı dışa aktarımı tek tek ayrı şeritte, diğer işler birlikte (uzun dışa aktarım ihbar/imza işlerini bekletmez).
- İş türleri: `signature.detect`, `contract.notice_reminder`, `contract.obligation_due`, `erp.export` (yalnız `ERP_ADAPTER` tanımlıysa), `ai.run` (yalnız AI sağlayıcısı varsa), `retention.purge`, `tenant.export`.

## Onay politikası, istisnalar ve tasarruf bazı

- Onay politikası: Projeler → Onay politikası (`/projeler/onay-politikasi`). Satınalma yöneticisi taslak hazırlar, başka bir yönetici yayınlar. Yeni sürüm yalnız yeni işlere uygulanır; başlamış onaylar kopyaladıkları planla sürer. Kural yoksa tek adım: satınalma yöneticisi.
- Tek kaynak / acil alım / iptal / sonuçsuz kapanış: proje Özet → "İstisna iste"; politika adımlarıyla onaylanır. Tek kaynak istisnası yalnız seçilen tedarikçiyle yayında kullanılır.
- Tasarruf bazı: proje Özet → "Baz öner" (teklifler açılmadan: taslak, onay veya teklife açık aşamada); satınalma yöneticisi veya finans seçim önerisinden önce onaylar. Raporlar → Tasarruf yalnız onaylı bazlı ve dönemde onaylanan seçimleri sayar.
- Performans ağırlığı: `/performans-agirliklari` (satınalma yöneticisi). Kategori adı incelemedeki kategoriyle aynı yazılmalı.
- Tedarikçi anketi: değerlendirme sayfası → "Tedarikçiye gönder"; tedarikçi Portal → Anketler'den yanıtlar ve gönderir. Gönderilen ankette kurum yanıt yazamaz, yalnız inceler/bulgu yazar; tedarikçi gönderdikten sonra yanıt değişmez. İnceleme tedarikçi gönderince tamamlanır. Farklı beyan gerekiyorsa yeni değerlendirme açılır.

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
