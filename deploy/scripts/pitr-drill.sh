#!/usr/bin/env bash
# Noktasal geri dönüş (PITR/WAL) ve seçici yeniden içe alma tatbikatı (Faz 7). Kaynak veritabanına yalnız okuma (pg_dump) yapılır.
# Ayrı, geçici konteynerler kullanılır: WAL arşivli "birincil" ve ondan geri yüklenen "kopya". Sonunda silinir (KEEP=1 ile tutulur).
#
#   PG_CONTAINER=satinalma-db SRC_DB=satinalma deploy/scripts/pitr-drill.sh
#
# İlk açılıştaki geçici sunucu yalnız soketten dinler; hazır olma TCP ile beklenir.
# Senaryo: temel yedek → normal yazma → hedef an → kaza (bir kiracının görevleri silinir) → sonraki meşru yazmalar →
# hedef ana PITR (izole kopya) → kopyada doğrulama → yalnız eksik satırları canlıya seçici içe alma (sonraki yazmalar korunur).
set -euo pipefail
cd "$(dirname "$0")/../.."
C=${PG_CONTAINER:-satinalma-db}
SRC=${SRC_DB:-satinalma}
IMG=${PG_IMAGE:-postgres:17-alpine}
ARCHIVE_TIMEOUT=${ARCHIVE_TIMEOUT:-30}
P=sp-pitr-primary; R=sp-pitr-restore
PP=${PITR_PRIMARY_PORT:-55432}; RP=${PITR_RESTORE_PORT:-55433}
PW=drill-only-local
set -a; [ -f .env ] && . ./.env; set +a
: "${DATABASE_OWNER_URL:?DATABASE_OWNER_URL gerekli}"
OWNER=$(printf '%s' "$DATABASE_OWNER_URL" | sed -E 's#^postgres(ql)?://([^:@/]+).*#\2#')
TMP=$(mktemp -d)
now() { perl -MTime::HiRes=time -e 'printf "%.2f", time'; }
q() { docker exec -i "$1" psql -U "$OWNER" -v ON_ERROR_STOP=1 -X -q -At -d satinalma -c "$2"; }
ready() { for _ in $(seq 1 120); do docker exec "$1" pg_isready -q -h 127.0.0.1 -U "$OWNER" -d satinalma 2>/dev/null && return 0; sleep 0.5; done; return 1; }
drop() {
  docker rm -f "$P" "$R" >/dev/null 2>&1 || true
  docker volume rm sp-pitr-wal sp-pitr-base sp-pitr-rdata >/dev/null 2>&1 || true
}
cleanup() { rm -rf "$TMP"; [ "${KEEP:-0}" = "1" ] || drop; }
report=(); say() { echo "$*"; report+=("$*"); }
drop; trap cleanup EXIT

echo "== 1. WAL arşivli birincil ($IMG, archive_timeout=${ARCHIVE_TIMEOUT}s)"
docker volume create sp-pitr-wal >/dev/null; docker volume create sp-pitr-base >/dev/null
docker run -d --name "$P" -e POSTGRES_USER="$OWNER" -e POSTGRES_PASSWORD="$PW" -e POSTGRES_DB=satinalma \
  -v sp-pitr-wal:/archive -v sp-pitr-base:/base -p 127.0.0.1:$PP:5432 "$IMG" \
  -c wal_level=replica -c archive_mode=on -c archive_timeout="$ARCHIVE_TIMEOUT" \
  -c 'archive_command=test ! -f /archive/%f && cp %p /archive/%f' >/dev/null
docker exec -u root "$P" chown postgres:postgres /archive /base
ready "$P"
q "$P" "CREATE ROLE sp_app LOGIN PASSWORD '$PW' NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE"
docker exec "$C" pg_dump -U "$OWNER" -Fc -d "$SRC" > "$TMP/src.dump"
docker exec -i "$P" pg_restore -U "$OWNER" -d satinalma < "$TMP/src.dump"
TENANT=$(q "$P" "SELECT tenant_id FROM tasks GROUP BY 1 ORDER BY count(*) DESC LIMIT 1")
TASKS=$(q "$P" "SELECT count(*) FROM tasks WHERE tenant_id = '$TENANT'")
say "birincil hazır: kaynak $SRC geri yüklendi; en çok görevi olan kiracıda $TASKS görev"

echo "== 2. Temel yedek (pg_basebackup)"
t=$(now); docker exec "$P" pg_basebackup -U "$OWNER" -D /base/data -Fp -X stream -c fast; t2=$(now)
say "temel yedek: $(echo "$t2 - $t" | bc) sn, $(docker exec "$P" du -sh /base/data | cut -f1)"

echo "== 3. Yazma → hedef an → kaza → sonraki yazmalar"
q "$P" "INSERT INTO audit_events (tenant_id, action, entity_type, data) SELECT '$TENANT', 'drill.pitr.before', 'tenant', '{}' FROM generate_series(1,5)"
sleep 1
TARGET=$(q "$P" "SELECT to_char(clock_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS.US') || '+00'")
sleep 1
HOL=$(q "$P" "SELECT count(*) FROM tenant_holidays WHERE tenant_id = '$TENANT'")
q "$P" "DELETE FROM tasks WHERE tenant_id = '$TENANT'; DELETE FROM tenant_holidays WHERE tenant_id = '$TENANT'"
q "$P" "INSERT INTO audit_events (tenant_id, action, entity_type, data) SELECT '$TENANT', 'drill.pitr.after', 'tenant', '{}' FROM generate_series(1,3)"
say "hedef an $TARGET; kazada $TASKS görev ve $HOL tatil günü (tarih sütunu) silindi; sonrasında 3 meşru kayıt yazıldı"

# RPO: zorla WAL değişimi yapmadan son yazmanın arşive ulaşma süresi (archive_timeout ile sınırlı).
t=$(now); MARK=$(q "$P" "SELECT pg_walfile_name(pg_current_wal_lsn())")
for _ in $(seq 1 $((ARCHIVE_TIMEOUT * 4 + 20))); do
  last=$(q "$P" "SELECT coalesce(last_archived_wal, '') FROM pg_stat_archiver")
  [[ -n "$last" && ! "$last" < "$MARK" ]] && break; sleep 0.5
done; t2=$(now)
say "RPO ölçümü: son yazmayı içeren WAL dosyası $(echo "$t2 - $t" | bc) sn sonra arşivde (üst sınır archive_timeout=${ARCHIVE_TIMEOUT}s + kopyalama)"

echo "== 4. Hedef ana geri dönüş (izole kopya)"
t=$(now)
docker volume create sp-pitr-rdata >/dev/null
docker run --rm -v sp-pitr-base:/base:ro -v sp-pitr-rdata:/r "$IMG" sh -c 'cp -a /base/data/. /r/ && touch /r/recovery.signal && rm -f /r/postmaster.pid'
docker run --rm -v sp-pitr-rdata:/r "$IMG" sh -c "printf \"restore_command = 'cp /archive/%%f %%p'\nrecovery_target_time = '$TARGET'\nrecovery_target_action = 'promote'\narchive_mode = off\n\" >> /r/postgresql.auto.conf && chown -R postgres:postgres /r && chmod 700 /r"
docker run -d --name "$R" -v sp-pitr-rdata:/var/lib/postgresql/data -v sp-pitr-wal:/archive:ro -p 127.0.0.1:$RP:5432 "$IMG" >/dev/null
ready "$R"
for _ in $(seq 1 240); do [ "$(q "$R" "SELECT pg_is_in_recovery()" 2>/dev/null || echo t)" = "f" ] && break; sleep 0.5; done
t2=$(now)
say "RTO ölçümü (kopyalama + WAL yeniden oynatma + yükseltme): $(echo "$t2 - $t" | bc) sn"
before=$(q "$R" "SELECT count(*) FROM audit_events WHERE action = 'drill.pitr.before'")
after=$(q "$R" "SELECT count(*) FROM audit_events WHERE action = 'drill.pitr.after'")
rtasks=$(q "$R" "SELECT count(*) FROM tasks WHERE tenant_id = '$TENANT'")
say "kopyada: hedef öncesi kayıt $before/5, hedef sonrası kayıt $after/0, görev $rtasks/$TASKS"
[ "$before" = 5 ] && [ "$after" = 0 ] && [ "$rtasks" = "$TASKS" ] || { echo "PITR beklenen anı vermedi" >&2; exit 1; }

echo "== 5. Seçici yeniden içe alma (yalnız eksik satırlar; canlıdaki sonraki yazmalar korunur)"
SRC_URL="postgres://$OWNER:$PW@127.0.0.1:$RP/satinalma"; DST_URL="postgres://$OWNER:$PW@127.0.0.1:$PP/satinalma"
args=(--source "$SRC_URL" --target "$DST_URL" --tenant "$TENANT" --tables tasks,tenant_holidays --reason "PITR tatbikatı: kazayla silinen görevler ve tatiller" --operator "tatbikat betiği")
TZ=Europe/Istanbul npx tsx apps/api/src/reimport.ts "${args[@]}" > "$TMP/dry.json" || { cat "$TMP/dry.json"; exit 1; }
dry=$(node -e "const r=JSON.parse(require('fs').readFileSync('$TMP/dry.json','utf8').split('\nDeneme')[0]); console.log(r.results[0].missing)")
[ "$(q "$P" "SELECT count(*) FROM tasks WHERE tenant_id = '$TENANT'")" = 0 ] || { echo "deneme yazdı" >&2; exit 1; }
t=$(now); TZ=Europe/Istanbul npx tsx apps/api/src/reimport.ts "${args[@]}" --apply > "$TMP/apply.json"; t2=$(now)
ins=$(node -e "console.log(JSON.parse(require('fs').readFileSync('$TMP/apply.json','utf8')).results[0].inserted)")
ptasks=$(q "$P" "SELECT count(*) FROM tasks WHERE tenant_id = '$TENANT'")
pafter=$(q "$P" "SELECT count(*) FROM audit_events WHERE action = 'drill.pitr.after'")
trail=$(q "$P" "SELECT count(*) FROM audit_events WHERE action = 'ops.reimport' AND tenant_id = '$TENANT'")
again=$(TZ=Europe/Istanbul npx tsx apps/api/src/reimport.ts "${args[@]}" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>console.log(JSON.parse(s.split('\nDeneme')[0]).results[0].missing))")
say "içe alma: deneme $dry eksik satır (yazılmadı) → uygulama $(echo "$t2 - $t" | bc) sn, $ins eklendi; canlıda görev $ptasks/$TASKS, sonraki meşru kayıt $pafter/3 korundu, denetim izi $trail, ikinci deneme $again eksik"
[ "$ptasks" = "$TASKS" ] && [ "$pafter" = 3 ] && [ "$again" = 0 ] && [ "$trail" = 1 ] || { echo "seçici içe alma beklenen sonucu vermedi" >&2; exit 1; }
# Alan alan aynı mı (araç UTC+3 saat diliminde çalıştı; tarih/saat ve ondalık kaymamalı).
fp() { q "$1" "SELECT md5(coalesce(string_agg(t::text, '|' ORDER BY t::text), '')) FROM $2 t WHERE tenant_id = '$TENANT'"; }
for t in tasks tenant_holidays; do
  [ "$(fp "$R" $t)" = "$(fp "$P" $t)" ] || { echo "$t: içe alınan satırlar kopyadakiyle alan alan aynı değil" >&2; exit 1; }
done
say "içe alınan $TASKS görev ve $HOL tatil günü kopyadakiyle alan alan aynı (TZ=Europe/Istanbul; tarih ve zaman damgası kaymadı)"

echo; echo "== Özet"; printf '%s\n' "${report[@]}"
