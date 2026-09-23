#!/usr/bin/env bash
# Base PostgreSQL de developpement, locale et jetable.
# Aucun docker requis : cluster autonome dans PGROOT.
set -euo pipefail

PGROOT="${ORSYNE_PGROOT:-/var/lib/postgresql/orsyne}"
PGPORT="${ORSYNE_PGPORT:-5433}"
PGBIN="${ORSYNE_PGBIN:-/usr/lib/postgresql/16/bin}"
export PATH="$PGBIN:$PATH"

as_postgres() { su postgres -c "PATH=$PGBIN:\$PATH $1"; }

start() {
  if [ ! -f "$PGROOT/data/PG_VERSION" ]; then
    mkdir -p "$PGROOT/data" "$PGROOT/run"
    chown -R postgres:postgres "$PGROOT"
    chmod 700 "$PGROOT/data"
    as_postgres "initdb -D $PGROOT/data -A trust -U orsyne" >/dev/null
  fi
  if as_postgres "pg_ctl -D $PGROOT/data status" >/dev/null 2>&1; then
    echo "PostgreSQL deja demarre sur le port $PGPORT."
  else
    as_postgres "pg_ctl -D $PGROOT/data -o '-p $PGPORT -k $PGROOT/run -c listen_addresses=127.0.0.1' -l $PGROOT/pg.log start"
  fi
  for db in orsyne_dev orsyne_test; do
    psql -h 127.0.0.1 -p "$PGPORT" -U orsyne -d postgres -tc \
      "SELECT 1 FROM pg_database WHERE datname='$db'" | grep -q 1 \
      || psql -h 127.0.0.1 -p "$PGPORT" -U orsyne -d postgres -c "CREATE DATABASE $db OWNER orsyne;" >/dev/null
  done
  echo "Bases pretes : orsyne_dev, orsyne_test (port $PGPORT)."
}

stop() { as_postgres "pg_ctl -D $PGROOT/data stop" || true; }

reset_test() {
  psql -h 127.0.0.1 -p "$PGPORT" -U orsyne -d postgres \
    -c "DROP DATABASE IF EXISTS orsyne_test WITH (FORCE);" \
    -c "CREATE DATABASE orsyne_test OWNER orsyne;" >/dev/null
  echo "orsyne_test remise a zero."
}

run_tests() {
  reset_test
  # Tous les tests partagent la meme IP et creent des dizaines de comptes :
  # on releve les quotas ici, la limite elle-meme a son propre test.
  ORSYNE_ADMIN_DATABASE_URL="postgres://orsyne@127.0.0.1:$PGPORT/orsyne_test" \
  ORSYNE_DATABASE_URL="postgres://orsyne_app@127.0.0.1:$PGPORT/orsyne_test" \
  ORSYNE_RATE_LOGIN=100000 ORSYNE_RATE_BOOKING=100000 ORSYNE_RATE_API=1000000 \
  ORSYNE_JOBS_ENABLED=false \
  node --test "test/**/*.test.js"
}

case "${1:-start}" in
  start) start ;;
  stop) stop ;;
  reset) reset_test ;;
  test) run_tests ;;
  *) echo "usage: $0 {start|stop|reset|test}" >&2; exit 1 ;;
esac
