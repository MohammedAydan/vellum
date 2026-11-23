#!/usr/bin/env bash
# Cloudflare Multi-Tunnel Supervisor (`scripts/tunnel-supervisor.sh`)
mkdir -p /tmp/vellum-tunnels
rm -f /tmp/vellum-tunnels/*.log

echo "[tunnel-supervisor] Starting 4 Cloudflare tunnels..."

/home/ubuntu/.local/bin/cloudflared tunnel --url http://127.0.0.1:5173 > /tmp/vellum-tunnels/dashboard.log 2>&1 &
PID_DASHBOARD=$!

/home/ubuntu/.local/bin/cloudflared tunnel --url http://127.0.0.1:5174 > /tmp/vellum-tunnels/admin.log 2>&1 &
PID_ADMIN=$!

/home/ubuntu/.local/bin/cloudflared tunnel --url http://127.0.0.1:8080 > /tmp/vellum-tunnels/api.log 2>&1 &
PID_API=$!

/home/ubuntu/.local/bin/cloudflared tunnel --url http://127.0.0.1:6006 > /tmp/vellum-tunnels/storybook.log 2>&1 &
PID_STORYBOOK=$!

echo "[tunnel-supervisor] PIDs: dashboard=${PID_DASHBOARD}, admin=${PID_ADMIN}, api=${PID_API}, storybook=${PID_STORYBOOK}"

cleanup() {
  echo "[tunnel-supervisor] Terminating tunnels..."
  kill -TERM "$PID_DASHBOARD" "$PID_ADMIN" "$PID_API" "$PID_STORYBOOK" 2>/dev/null || true
  exit 0
}

trap cleanup EXIT SIGINT SIGTERM

wait "$PID_DASHBOARD" "$PID_ADMIN" "$PID_API" "$PID_STORYBOOK"
