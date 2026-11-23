---
title: Deployment & Hosting
order: 15
group: Operations
description: Primary two-project Vercel path, the repository deployment pause, and optional self-hosting adapters.
---

# Deployment & Hosting

## Primary path

The repository's primary path is two independent Vercel projects: the API rooted at `apps/api`, and the static web frontend rooted at the repository root, which serves the web application at `/` and the documentation at `/docs/`. It calls the separate API origin configured by `VITE_API_BASE_URL`; the API allows the exact frontend origin in `CORS_ALLOWED_ORIGINS`.

Automatic Git deployments are paused in both `vercel.json` files, including production/main. Build and test CI still runs. Merging a PR does not deploy. Do not re-enable automation or issue a manual deployment as part of routine code cleanup.

From the repository checkout, start at `docs/deployment/README.md`. The full settings table, CORS rules, checks and rollback procedure live in `docs/DEPLOYMENT-SPLIT.md`. `corepack pnpm deploy:plan` prints an environment-name audit and plan only; it does not deploy or change account settings.

## Local development is different

```bash
corepack pnpm build
corepack pnpm build:frontend
corepack pnpm dev:stack
```

The local gateway at `http://localhost:3000` serves the web frontend and proxies `/v1` HTTP/WebSocket requests to the API at `http://localhost:8080`. This same-origin proxy is a development convenience, not the primary Vercel production topology.

For a production-like local preview, run `node scripts/dev/frontend-gateway.mjs --mode=prod` after building `dist-frontend/`.

## Optional alternatives

Alternative host instructions are consolidated under `docs/deployment/`:

- `cloudflare.md`: Pages/Workers adapter notes.
- `railway.md`: API-only Railway configuration.
- `dashboard.md`: static web frontend architecture, not a separate primary host choice.
- `docs/06-deployment-and-operations.md`: self-hosted Docker Compose, Caddy, probes and container operations.
- `docs/11-deployment-and-hosting.md`: runtime adapters and hosting architecture, including Render.

Runtime and host configuration files stay in their existing paths so working Docker contexts, provider discovery and CI checks keep resolving them. Choosing an alternative is an operator decision, not a requirement to deploy the same release everywhere.
