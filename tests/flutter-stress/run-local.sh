#!/usr/bin/env bash
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/../.." && pwd)
cd "$ROOT"
DART_BIN=${DART_BIN:-dart}
PG_BIN=${PG_BIN:-$(pg_config --bindir)}
STATE=$(mktemp -d /tmp/vellum-flutter-stress.XXXXXX)
PORT=$(python3 - <<'PY'
import socket
with socket.socket() as s:
    s.bind(('127.0.0.1', 0))
    print(s.getsockname()[1])
PY
)
cleanup() {
  "$PG_BIN/pg_ctl" -D "$STATE/data" -m immediate stop || true
  rm -rf "$STATE"
}
trap cleanup EXIT
"$PG_BIN/initdb" -D "$STATE/data" -U flutter_stress -A trust
"$PG_BIN/pg_ctl" -D "$STATE/data" -l "$STATE/postgres.log" -o "-h 127.0.0.1 -p $PORT -k $STATE" start
psql -h 127.0.0.1 -p "$PORT" -U flutter_stress -d postgres -v ON_ERROR_STOP=1 -c 'CREATE DATABASE control_flutter_stress'
psql -h 127.0.0.1 -p "$PORT" -U flutter_stress -d postgres -v ON_ERROR_STOP=1 -c 'CREATE DATABASE data_flutter_stress'
# Override every database route. Never inherit an app URL or LISTEN endpoint.
export NODE_ENV=test DATABASE_MODE=postgres LOG_LEVEL=error
export CONTROL_DATABASE_URL="postgres://flutter_stress@127.0.0.1:$PORT/control_flutter_stress"
export DATA_DATABASE_URL="postgres://flutter_stress@127.0.0.1:$PORT/data_flutter_stress"
export CONTROL_DATABASE_URL_DIRECT="$CONTROL_DATABASE_URL"
export DATA_DATABASE_URL_DIRECT="$DATA_DATABASE_URL"
export CONTROL_DATABASE_APP_URL="$CONTROL_DATABASE_URL"
export DATA_DATABASE_APP_URL="$DATA_DATABASE_URL"
export DATA_DATABASE_URL_LISTEN="$DATA_DATABASE_URL"
export CONTROL_DATABASE_DRIVER=pg DATA_DATABASE_DRIVER=pg
export DART_BIN
if [[ ${VELLUM_STRESS_SKIP_BUILD:-0} != 1 ]]; then
  pnpm --filter './packages/**' -r build
fi
pnpm exec tsx scripts/migrate.ts
(cd tests/flutter-stress && "$DART_BIN" pub get && "$DART_BIN" analyze)
pnpm exec tsx tests/flutter-stress/run.ts
