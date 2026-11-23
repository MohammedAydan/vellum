#!/usr/bin/env bash
set -e
PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$PROJECT_ROOT"

export PATH="$HOME/.local/bin:$PATH"

echo "=== Starting Document Database SaaS Services ==="

# 1. API Server (Port 8080)
if ! ss -tulpn | grep -q ":8080 "; then
  echo "Starting API Server on port 8080..."
  nohup node apps/api/dist/node-server.js > /tmp/vellum-api.log 2>&1 &
  echo $! > /tmp/vellum-api.pid
else
  echo "API Server already running on port 8080."
fi

# 2. Customer Dashboard SPA (Port 5173)
if ! ss -tulpn | grep -q ":5173 "; then
  echo "Starting Customer Dashboard on port 5173..."
  nohup pnpm --filter @vellum/dashboard preview --port 5173 --host 0.0.0.0 > /tmp/vellum-dashboard.log 2>&1 &
  echo $! > /tmp/vellum-dashboard.pid
else
  echo "Customer Dashboard already running on port 5173."
fi

# 3. Platform Admin Console (Port 5174)
if ! ss -tulpn | grep -q ":5174 "; then
  echo "Starting Platform Admin Console on port 5174..."
  nohup pnpm --filter @vellum/admin preview --port 5174 --host 0.0.0.0 > /tmp/vellum-admin.log 2>&1 &
  echo $! > /tmp/vellum-admin.pid
else
  echo "Platform Admin Console already running on port 5174."
fi

# 4. Storybook UI System (Port 6006)
if ! ss -tulpn | grep -q ":6006 "; then
  echo "Starting Storybook Catalog on port 6006..."
  nohup python3 -m http.server 6006 --directory packages/ui/storybook-static --bind 0.0.0.0 > /tmp/vellum-storybook.log 2>&1 &
  echo $! > /tmp/vellum-storybook.pid
else
  echo "Storybook Catalog already running on port 6006."
fi

sleep 2
echo "=== All services launched ==="
