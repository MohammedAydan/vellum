#!/usr/bin/env bash
# Runs each test file against a freshly restarted LOCAL API (the threat detector keeps in-memory IP strikes
# that would otherwise leak between files). Requires LOCAL_ENV (an env file pointing at disposable local Postgres).
set -u
cd "$(dirname "$0")"
ENV_FILE="${LOCAL_ENV:?set LOCAL_ENV to an env file with local CONTROL/DATA database URLs}"
for f in src/*.test.ts; do
  pkill -f start-local-api.mjs 2>/dev/null; sleep 1
  node --env-file="$ENV_FILE" start-local-api.mjs > /tmp/harsh-api.log 2>&1 &
  for i in $(seq 1 40); do curl -fs "http://127.0.0.1:${API_PORT:-18080}/health" >/dev/null 2>&1 && break; sleep 0.5; done
  echo "=== $f"; ../../node_modules/.bin/vitest run "$f" 2>&1 | grep -E "✓|×|→|Tests "
done
pkill -f start-local-api.mjs 2>/dev/null
