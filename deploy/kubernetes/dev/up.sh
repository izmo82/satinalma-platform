#!/usr/bin/env bash
# Yerel kind kümesinde tam kurulum: imajlar, bağımlılıklar (yalnız doğrulama), migration Job, uygulama.
# Kurum içi kümede aynı sıralama deploy/README.md'de; bağımlılıklar orada kurumun kendi servisleridir.
#   deploy/kubernetes/dev/up.sh [--no-build]
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/../../.." && pwd); K="$ROOT/deploy/kubernetes"; cd "$ROOT"
CLUSTER=satinalma; CTX=kind-$CLUSTER; kc() { kubectl --context "$CTX" "$@"; }

kind get clusters 2>/dev/null | grep -qx "$CLUSTER" || kind create cluster --config "$K/dev/kind.yaml"
if [ "${1:-}" != "--no-build" ]; then
  docker build -q -f Dockerfile.api -t satinalma/api:local . && docker build -q -f Dockerfile.web -t satinalma/web:local .
fi
kind load docker-image --name "$CLUSTER" satinalma/api:local satinalma/web:local

# Sırlar: ilk çalıştırmada rastgele üretilir, git'e girmez (.env).
S="$K/dev/.env"
if [ ! -f "$S" ]; then
  r() { openssl rand -hex 24; }
  printf 'OWNER_DB_PASSWORD=%s\nAPP_DB_PASSWORD=%s\nKEYCLOAK_DB_PASSWORD=%s\nKEYCLOAK_ADMIN_PASSWORD=%s\nOBJECT_STORE_ACCESS_KEY=%s\nOBJECT_STORE_SECRET_KEY=%s\n' \
    "$(r)" "$(r)" "$(r)" "$(r)" "sp$(openssl rand -hex 8)" "$(r)" > "$S"; chmod 600 "$S"
fi
set -a; . "$S"; set +a
apply_secret() { kc -n "$1" create "${@:2}" --dry-run=client -o yaml | kc apply -f - >/dev/null; }

kc apply -f - >/dev/null <<<'{"apiVersion":"v1","kind":"Namespace","metadata":{"name":"satinalma-deps"}}'
apply_secret satinalma-deps secret generic deps-secrets --from-env-file="$S"
apply_secret satinalma-deps configmap db-init --from-file="$ROOT/deploy/compose/db-init/01_roles.sh"
apply_secret satinalma-deps configmap kc-realm --from-file="$ROOT/deploy/compose/keycloak/realm-satinalma.json"
kc apply -f "$K/dev/deps.yaml" >/dev/null
kc -n satinalma-deps rollout status statefulset/postgres --timeout=180s
kc -n satinalma-deps rollout status deployment/objectstore --timeout=180s
kc -n satinalma-deps wait --for=condition=complete job/bucket-init --timeout=180s
kc -n satinalma-deps rollout status deployment/keycloak --timeout=300s

PG=postgres.satinalma-deps.svc:5432/satinalma
kc apply -f "$K/overlays/kind/namespace.yaml" >/dev/null
apply_secret satinalma secret generic satinalma-secrets --from-literal=DATABASE_URL="postgres://sp_app:$APP_DB_PASSWORD@$PG" \
  --from-literal=OBJECT_STORE_ACCESS_KEY="$OBJECT_STORE_ACCESS_KEY" --from-literal=OBJECT_STORE_SECRET_KEY="$OBJECT_STORE_SECRET_KEY"
apply_secret satinalma secret generic satinalma-migrate-secrets --from-literal=DATABASE_OWNER_URL="postgres://sp_owner:$OWNER_DB_PASSWORD@$PG"

# Belgelenen sıra: önce ağ politikaları ve migration, sonra uygulama.
kc apply -k "$K/overlays/kind" >/dev/null
kc -n satinalma delete job satinalma-migrate --ignore-not-found >/dev/null
kc -n satinalma apply -k "$K/migrate" >/dev/null
kc -n satinalma wait --for=condition=complete job/satinalma-migrate --timeout=300s
kc -n satinalma logs job/satinalma-migrate | tail -3
for d in api worker web; do kc -n satinalma rollout restart deployment/satinalma-$d >/dev/null; done
for d in api worker web; do kc -n satinalma rollout status deployment/satinalma-$d --timeout=240s; done
