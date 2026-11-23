#!/usr/bin/env bash
mkdir -p /tmp/vellum-tunnels
rm -f /tmp/vellum-tunnels/*.log

echo "Launching Cloudflare Tunnels for all services..."

# Kill any existing quick tunnels
killall cloudflared 2>/dev/null || true
sleep 1

nohup cloudflared tunnel --url http://127.0.0.1:5173 > /tmp/vellum-tunnels/dashboard.log 2>&1 &
echo $! > /tmp/vellum-tunnels/dashboard.pid

nohup cloudflared tunnel --url http://127.0.0.1:5174 > /tmp/vellum-tunnels/admin.log 2>&1 &
echo $! > /tmp/vellum-tunnels/admin.pid

nohup cloudflared tunnel --url http://127.0.0.1:8080 > /tmp/vellum-tunnels/api.log 2>&1 &
echo $! > /tmp/vellum-tunnels/api.pid

nohup cloudflared tunnel --url http://127.0.0.1:6006 > /tmp/vellum-tunnels/storybook.log 2>&1 &
echo $! > /tmp/vellum-tunnels/storybook.pid

echo "Waiting for tunnels to initialize..."
sleep 10

echo "=== TUNNEL URLS ==="
for svc in dashboard admin api storybook; do
  url=$(grep -o 'https://[-a-zA-Z0-9@:%._\+~#=]*\.trycloudflare\.com' /tmp/vellum-tunnels/${svc}.log | head -n 1)
  echo "${svc}: ${url}"
done
