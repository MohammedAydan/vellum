#!/bin/sh
# TASK-903 — pre-boot container entrypoint.
#
# Migrations run BEFORE the API process accepts traffic. The advisory lock lives
# inside `runMigrationsOnClient`, so concurrent replicas cannot interleave DDL.
#
# Required Dockerfile wiring (owned by DevOps — see docs/operations/container-startup.md):
#   COPY scripts ./scripts
#   ENTRYPOINT ["/app/scripts/docker-entrypoint.sh"]
#   CMD ["node", "apps/api/dist/node-server.js"]   # unchanged
#
# Runtime configuration is expected to be injected by the orchestrator. We deliberately do
# NOT `source` a .env file here: DATABASE_URL values may contain shell metacharacters.

set -eu

if [ "${DATABASE_MODE:-memory}" = "postgres" ]; then
  : "${CONTROL_DATABASE_URL:?CONTROL_DATABASE_URL is required in postgres mode}"
  : "${DATA_DATABASE_URL:?DATA_DATABASE_URL is required in postgres mode}"
  echo "[vellum-entrypoint] applying pre-boot migrations (control_db + data_db)"

  if [ -f scripts/migrate.ts ]; then
    node --import tsx scripts/migrate.ts
  elif [ -f scripts/migrate.js ]; then
    node scripts/migrate.js
  else
    echo "[vellum-entrypoint] FATAL: migration CLI is absent from the image" >&2
    exit 1
  fi
else
  echo "[vellum-entrypoint] DATABASE_MODE is not 'postgres'; skipping migrations (in-process stores)"
fi

echo "[vellum-entrypoint] starting: $*"
exec "$@"
