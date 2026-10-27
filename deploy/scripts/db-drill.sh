#!/usr/bin/env bash
# Yedekleme/geri yükleme ve migration yükseltme/geri dönüş tatbikatı (Faz 7). Kaynak veritabanına yalnız okuma (pg_dump) yapılır;
# tatbikat veritabanları ayrı adlarla oluşturulur ve sonunda silinir (KEEP=1 ile tutulur). Kaynak veritabanı adı asla silinmez.
#
#   PG_CONTAINER=satinalma-db SRC_DB=satinalma deploy/scripts/db-drill.sh
#
# Gereken: docker, çalışan PostgreSQL konteyneri, kök dizinde .env (DATABASE_OWNER_URL), npm bağımlılıkları.
set -euo pipefail
cd "$(dirname "$0")/../.."
C=${PG_CONTAINER:-satinalma-db}
SRC=${SRC_DB:-satinalma}
RESTORE=sp_drill_restore
UPGRADE=sp_drill_upgrade
set -a; [ -f .env ] && . ./.env; set +a
: "${DATABASE_OWNER_URL:?DATABASE_OWNER_URL gerekli}"
OWNER=$(printf '%s' "$DATABASE_OWNER_URL" | sed -E 's#^postgres(ql)?://([^:@/]+).*#\2#')
for d in "$RESTORE" "$UPGRADE"; do [ "$d" = "$SRC" ] && { echo "Tatbikat veritabanı kaynakla aynı ada sahip olamaz: $d" >&2; exit 2; }; done

now() { perl -MTime::HiRes=time -e 'printf "%.2f", time'; }
q() { docker exec -i "$C" psql -U "$OWNER" -v ON_ERROR_STOP=1 -X -q -At -d "$1" -c "$2"; }
counts() { q "$1" "SELECT string_agg(table_name || '=' || (xpath('/row/c/text()', query_to_xml(format('SELECT count(*) AS c FROM %I', table_name), false, true, '')))[1]::text, ' ' ORDER BY table_name)
  FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE'"; }
fresh() { docker exec "$C" dropdb -U "$OWNER" --if-exists "$1"; docker exec "$C" createdb -U "$OWNER" "$1"; }
report=()
say() { echo "$*"; report+=("$*"); }

echo "== 1. Yedek (pg_dump -Fc) — kaynak: $SRC"
SRC_COUNTS=$(counts "$SRC")
t=$(now); docker exec "$C" pg_dump -U "$OWNER" -Fc -d "$SRC" -f /tmp/drill.dump; t2=$(now)
size=$(docker exec "$C" stat -c %s /tmp/drill.dump)
say "yedek: $(echo "$t2 - $t" | bc) sn, $size bayt (kaynak $(q "$SRC" "SELECT pg_size_pretty(pg_database_size('$SRC'))"))"

echo "== 2. İzole veritabanına geri yükleme ($RESTORE)"
t=$(now); fresh "$RESTORE"; docker exec "$C" pg_restore -U "$OWNER" -j 4 -d "$RESTORE" /tmp/drill.dump; t2=$(now)
say "geri yükleme: $(echo "$t2 - $t" | bc) sn"
RESTORED=$(counts "$RESTORE")
diff_out=$(diff <(tr ' ' '\n' <<<"$SRC_COUNTS") <(tr ' ' '\n' <<<"$RESTORED") || true)
if [ -z "$diff_out" ]; then say "satır sayıları: $(tr ' ' '\n' <<<"$RESTORED" | wc -l | tr -d ' ') tablonun tamamı kaynakla aynı"
else say "satır sayısı farkı (yedek sonrası kaynağa yazılan kayıtlar olabilir):"; say "$diff_out"; fi
say "son migration: $(q "$RESTORE" "SELECT max(name) FROM schema_migrations")"
# RLS geri yüklenen kopyada da etkin: kiracı bağlamı olmadan uygulama rolü belge göremez.
no_ctx=$(q "$RESTORE" "BEGIN; SET LOCAL ROLE sp_app; SELECT count(*) FROM documents; COMMIT;" | tail -1)
tenant=$(q "$RESTORE" "SELECT tenant_id FROM documents GROUP BY 1 ORDER BY count(*) DESC LIMIT 1")
with_ctx=$(q "$RESTORE" "BEGIN; SET LOCAL ROLE sp_app; SELECT set_config('app.tenant_id', '$tenant', true), set_config('app.company_ids', (SELECT '{' || string_agg(id::text, ',') || '}' FROM legal_entities WHERE tenant_id = '$tenant'), true); SELECT count(*) FROM documents; COMMIT;" | tail -1)
own=$(q "$RESTORE" "SELECT count(*) FROM documents WHERE tenant_id = '$tenant'")
other=$(q "$RESTORE" "SELECT count(*) FROM documents WHERE tenant_id <> '$tenant'")
say "RLS: bağlamsız uygulama rolü $no_ctx belge görür; bir kiracının bağlamında $with_ctx/$own belge (kopyada diğer kiracılara ait $other belge var)"
[ "$with_ctx" = "$own" ] || { echo "RLS kapsamı beklenen gibi değil" >&2; exit 1; }
[ "$no_ctx" = "0" ] || { echo "RLS beklenen gibi değil" >&2; exit 1; }

echo "== 3. Yükseltme tatbikatı: 018 durumundaki veriye 019 uygulanır, sonra yükseltme öncesi yedekle geri dönülür"
fresh "$UPGRADE"; docker exec "$C" pg_restore -U "$OWNER" -j 4 -d "$UPGRADE" /tmp/drill.dump
# Gerçek veriyle önceki sürüm şeması: 019'un eklediği nesneler kaldırılır (019 yalnız ekleme yapar).
q "$UPGRADE" "DROP FUNCTION storage_key_in_use(text); DROP TABLE tenant_exports, document_disposals, disposal_items, disposal_batches, legal_holds, retention_policies CASCADE;
  DELETE FROM schema_migrations WHERE name >= '019'" >/dev/null
BEFORE=$(counts "$UPGRADE")
docker exec "$C" pg_dump -U "$OWNER" -Fc -d "$UPGRADE" -f /tmp/drill-pre-upgrade.dump
say "yükseltme öncesi: son migration $(q "$UPGRADE" "SELECT max(name) FROM schema_migrations")"
t=$(now); DATABASE_OWNER_URL="${DATABASE_OWNER_URL%/*}/$UPGRADE" npx tsx apps/api/src/migrate.ts | sed 's/^/  /'; t2=$(now)
say "yükseltme: $(echo "$t2 - $t" | bc) sn, son migration $(q "$UPGRADE" "SELECT max(name) FROM schema_migrations")"
AFTER=$(counts "$UPGRADE" | tr ' ' '\n' | grep -vE '^(tenant_exports|document_disposals|disposal_items|disposal_batches|legal_holds|retention_policies)=' | tr '\n' ' ' | sed 's/ $//')
# schema_migrations'a 019 satırı eklenir (beklenen); diğer bütün tablolar aynı kalmalı.
strip() { tr ' ' '\n' <<<"$1" | grep -v '^schema_migrations=' ; }
if diff <(strip "$BEFORE") <(strip "$AFTER") >/dev/null; then say "yükseltme sonrası mevcut tabloların satır sayıları değişmedi"
else say "UYARI: yükseltme satır sayılarını değiştirdi:"; diff <(strip "$BEFORE") <(strip "$AFTER") || true; exit 1; fi
DATABASE_OWNER_URL="${DATABASE_OWNER_URL%/*}/$UPGRADE" npx tsx apps/api/src/migrate.ts | grep -q . && { echo "ikinci çalıştırma migration uyguladı (beklenmez)" >&2; exit 1; }
say "migration tekrar çalıştırıldı: değişiklik yok (idempotent, checksum tutarlı)"
t=$(now); fresh "$UPGRADE"; docker exec "$C" pg_restore -U "$OWNER" -j 4 -d "$UPGRADE" /tmp/drill-pre-upgrade.dump; t2=$(now)
ROLLED=$(counts "$UPGRADE")
[ "$ROLLED" = "$BEFORE" ] || { say "UYARI: geri dönüş sonrası satır sayıları farklı"; exit 1; }
say "geri dönüş (yükseltme öncesi yedekten): $(echo "$t2 - $t" | bc) sn, son migration $(q "$UPGRADE" "SELECT max(name) FROM schema_migrations"), veri aynı"

if [ "${KEEP:-0}" != "1" ]; then
  docker exec "$C" dropdb -U "$OWNER" --if-exists "$RESTORE"; docker exec "$C" dropdb -U "$OWNER" --if-exists "$UPGRADE"
  docker exec "$C" rm -f /tmp/drill.dump /tmp/drill-pre-upgrade.dump
fi
echo; echo "== Özet"; printf '%s\n' "${report[@]}"
