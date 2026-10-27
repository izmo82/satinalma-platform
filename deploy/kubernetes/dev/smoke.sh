#!/usr/bin/env bash
# kind kümesinde uçtan uca doğrulama (dev/up.sh sonrası). Yalnız sentetik veri.
#   deploy/kubernetes/dev/smoke.sh <örnek-efatura.xml>
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/../../.." && pwd); K="$ROOT/deploy/kubernetes"
INVOICE=$1; CTX=kind-satinalma; kc() { kubectl --context "$CTX" "$@"; }
set -a; . "$K/dev/.env"; set +a
j() { python3 -c "import sys,json;d=json.load(sys.stdin);print($1)"; }
WORK=$(mktemp -d); trap 'kill $(jobs -p) 2>/dev/null; rm -rf "$WORK"' EXIT

kc -n satinalma port-forward svc/satinalma-web 8080:8080 >/dev/null 2>&1 &
kc -n satinalma-deps port-forward svc/keycloak 8180:8080 >/dev/null 2>&1 &
for i in $(seq 1 30); do curl -sf localhost:8080/healthz >/dev/null && curl -sf localhost:8180/realms/satinalma >/dev/null && break; sleep 1; done

# Kurulum: belgelenen ops/provision-job.yaml şablonu, imaj ve argümanlar kustomize ile değiştirilir.
provision() {
  local name=$1; shift
  mkdir -p "$WORK/$name"; cp "$K/ops/provision-job.yaml" "$WORK/$name/"
  local args; args=$(python3 -c 'import json,sys;print(json.dumps(sys.argv[1:]))' "$@")
  cat > "$WORK/$name/kustomization.yaml" <<EOF
resources: [provision-job.yaml]
namespace: satinalma
images: [{ name: registry.example.test/satinalma/api, newName: satinalma/api, newTag: local }]
patches:
  - target: { kind: Job }
    patch: '[{"op":"replace","path":"/spec/template/spec/containers/0/args","value":$args}]'
EOF
  kc -n satinalma delete job satinalma-provision --ignore-not-found >/dev/null
  kc apply -k "$WORK/$name" >/dev/null
  kc -n satinalma wait --for=condition=complete job/satinalma-provision --timeout=120s >/dev/null
  kc -n satinalma logs job/satinalma-provision | tail -1
}
T=$(provision tenant tenant:create --name "Küme Deneme A.Ş." --region TR --company "Küme Deneme A.Ş." --tax-type VKN --tax-id 5000000013)
TID=$(echo "$T" | j "d['tenantId']"); CID=$(echo "$T" | j "d['companyId']"); echo "kurulum Job: kiracı oluşturuldu"
provision invite user:invite --tenant "$TID" --email kume.yonetici@example.test --name "Küme Yöneticisi" --roles BUYER,LEGAL --companies all >/dev/null
echo "kurulum Job: davet oluşturuldu"

# Keycloak kullanıcısı ve yalnız bu test için geçici doğrudan-giriş istemcisi (sonunda silinir).
kcadm() { kc -n satinalma-deps exec -i deploy/keycloak -- /opt/keycloak/bin/kcadm.sh "$@"; }
kcadm config credentials --server http://localhost:8080 --realm master --user kc-admin --password "$KEYCLOAK_ADMIN_PASSWORD" >/dev/null 2>&1
PW=$(openssl rand -hex 16)
kcadm create users -r satinalma -s username=kume.yonetici -s email=kume.yonetici@example.test -s emailVerified=true -s enabled=true -s firstName=Kume -s lastName=Yonetici >/dev/null 2>&1 || true
KUID=$(kcadm get users -r satinalma -q username=kume.yonetici --fields id --format csv --noquotes | tr -d '\r')
kcadm set-password -r satinalma --userid "$KUID" --new-password "$PW"
kcadm update "users/$KUID" -r satinalma -s 'requiredActions=[]'
kcadm create clients -r satinalma -s clientId=sp-smoke -s publicClient=true -s directAccessGrantsEnabled=true -s standardFlowEnabled=false \
  -s 'protocolMappers=[{"name":"aud","protocol":"openid-connect","protocolMapper":"oidc-audience-mapper","config":{"included.custom.audience":"sp-api","access.token.claim":"true"}}]' >/dev/null 2>&1 || true
TOKEN=$(curl -s -d grant_type=password -d client_id=sp-smoke -d username=kume.yonetici --data-urlencode "password=$PW" -d scope=openid \
  http://localhost:8180/realms/satinalma/protocol/openid-connect/token | j "d['access_token']")
SCID=$(kcadm get clients -r satinalma -q clientId=sp-smoke --fields id --format csv --noquotes | tr -d '\r'); kcadm delete "clients/$SCID" -r satinalma
printf 'KUSER=kume.yonetici\nKPW=%s\nTID=%s\n' "$PW" "$TID" > "$K/dev/.smoke.env"; chmod 600 "$K/dev/.smoke.env"

H=(-H "Authorization: Bearer $TOKEN")
echo "--- /auth/config (keşif belgesi iç adresten)"; curl -s localhost:8080/api/v1/auth/config | j "d['mode'], d['authorizationEndpoint']"
echo "--- /me (ilk giriş: davet bağlanır)"; curl -s localhost:8080/api/v1/me "${H[@]}" | j "d['user']['email'], d['roles']"
echo "--- e-Fatura yükleme -> nesne deposu"
UP=$(curl -s localhost:8080/api/v1/documents "${H[@]}" -H "X-Tenant-Id: $TID" -F companyId="$CID" -F kind=INVOICE -F title=kume.xml -F "file=@$INVOICE;type=application/xml")
DV=$(echo "$UP" | j "d['documentVersionId']"); echo "$UP" | j "d.get('supplier',{}).get('outcome')"
A=$(curl -s "localhost:8080/api/v1/document-versions/$DV/content" "${H[@]}" -H "X-Tenant-Id: $TID" | shasum -a 256 | cut -c1-16)
B=$(shasum -a 256 "$INVOICE" | cut -c1-16); echo "içerik hash: $([ "$A" = "$B" ] && echo EŞİT || echo FARKLI)"
echo "--- olumsuz"
curl -s -o /dev/null -w "token yok %{http_code}\n" localhost:8080/api/v1/me
# İmzanın ortasındaki bir karakter değiştirilir (son karakterin bazı bitleri kullanılmaz; orayı bozmak imzayı değiştirmeyebilir).
BAD=$(python3 -c "import sys;t=sys.argv[1];h,p,s=t.split('.');i=len(s)//2;print('.'.join([h,p,s[:i]+('A' if s[i]!='A' else 'B')+s[i+1:]]))" "$TOKEN")
curl -s -o /dev/null -w "bozuk imzalı token %{http_code}\n" localhost:8080/api/v1/me -H "Authorization: Bearer $BAD"
curl -s -o /dev/null -w "dev token ucu %{http_code}\n" -X POST localhost:8080/api/v1/dev/token -H 'content-type: application/json' -d '{"email":"x@example.test"}'

echo "--- ağ politikası"
RUN='{"spec":{"securityContext":{"runAsNonRoot":true,"runAsUser":101,"seccompProfile":{"type":"RuntimeDefault"}},"containers":[{"name":"probe","image":"satinalma/web:local","command":["sh","-c","wget -T 4 -qO- http://satinalma-api:4100/health >/dev/null && echo ACIK || echo KAPALI"],"securityContext":{"allowPrivilegeEscalation":false,"capabilities":{"drop":["ALL"]}}}]}}'
echo "etiketsiz pod -> API: $(kc -n satinalma run np-probe --rm -i --restart=Never --image=satinalma/web:local --overrides="$RUN" -q 2>/dev/null | tail -1)"
echo "API pod -> internet: $(kc -n satinalma exec deploy/satinalma-api -- node -e "fetch('https://example.com',{signal:AbortSignal.timeout(4000)}).then(()=>console.log('ACIK')).catch(()=>console.log('KAPALI'))")"
echo "API pod -> PostgreSQL: $(kc -n satinalma exec deploy/satinalma-api -- node -e "require('net').connect(5432,'postgres.satinalma-deps.svc').on('connect',function(){console.log('ACIK');this.end()}).on('error',()=>console.log('KAPALI'))")"
echo "--- Pod Security (restricted) ve rol"
kc get ns satinalma -o jsonpath='{.metadata.labels.pod-security\.kubernetes\.io/enforce}{"\n"}'
kc -n satinalma-deps exec statefulset/postgres -- psql -U sp_owner -d satinalma -tAc "select rolname, rolsuper, rolbypassrls from pg_roles where rolname='sp_app'"

echo "--- kesintisiz güncelleme (rollout restart sırasında /api/v1/auth/config)"
ok=0; fail=0; LOG="$WORK/rollout.log"
( while :; do curl -sf -m 3 -o /dev/null localhost:8080/api/v1/auth/config && echo ok || echo fail; sleep 0.2; done ) > "$LOG" &
PROBE=$!
kc -n satinalma rollout restart deployment/satinalma-api >/dev/null
kc -n satinalma rollout status deployment/satinalma-api --timeout=180s >/dev/null
sleep 2; kill $PROBE
ok=$(grep -c '^ok' "$LOG" || true); fail=$(grep -c '^fail' "$LOG" || true)
echo "başarılı $ok, başarısız $fail"
echo "--- denetim kayıtları"
kc -n satinalma-deps exec statefulset/postgres -- psql -U sp_owner -d satinalma -tAc "select action from audit_events where action in ('tenant.provisioned','membership.provisioned','user.identity_linked') order by id"
