#!/usr/bin/env bash
echo "=== Stopping Document Database SaaS Services ==="
for svc in api dashboard admin storybook; do
  if [ -f "/tmp/vellum-${svc}.pid" ]; then
    PID=$(cat "/tmp/vellum-${svc}.pid")
    if kill -0 "$PID" 2>/dev/null; then
      echo "Stopping ${svc} (PID ${PID})..."
      kill "$PID" 2>/dev/null || true
    fi
    rm -f "/tmp/vellum-${svc}.pid"
  fi
done

# Ensure ports are freed if any hung processes remain
fuser -k 8080/tcp 2>/dev/null || true
fuser -k 5173/tcp 2>/dev/null || true
fuser -k 5174/tcp 2>/dev/null || true
fuser -k 6006/tcp 2>/dev/null || true

echo "=== All services stopped ==="
