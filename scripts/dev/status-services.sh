#!/usr/bin/env bash
echo "=== Document Database SaaS Service Status ==="
services=("8080:API Server" "5173:Customer Dashboard" "5174:Admin Console" "6006:Storybook")

for item in "${services[@]}"; do
  IFS=":" read -r port name <<< "$item"
  if ss -tulpn | grep -q ":${port} "; then
    echo "  [RUNNING] ${name} (Port ${port})"
  else
    echo "  [STOPPED] ${name} (Port ${port})"
  fi
done
