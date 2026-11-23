# Deployment entry point

## Primary path: two independent Vercel projects

Use the [two-project runbook](../DEPLOYMENT-SPLIT.md) for this repository's primary deployment path:

- `vellum-api`: root `apps/api`, backend-only build and runtime.
- `vellum-console`: repository root, static dashboard, admin and docs build.
- The console calls the API's absolute origin. There is no production frontend `/v1` proxy in this path.

**Automatic Git deployments are enabled for production/main in both Vercel configs.** A merge to `main` deploys. Changing hosting/account settings requires a separate operator decision. The repository helper `pnpm deploy:plan` only prints a plan and environment-name audit; it does not deploy.

The settings, CORS requirements, verification and rollback instructions have one canonical home: [DEPLOYMENT-SPLIT.md](../DEPLOYMENT-SPLIT.md). [Deployment and hosting architecture](../11-deployment-and-hosting.md) explains runtime adapters and local development rather than selecting another primary host.

## Optional adapters and self-hosting

These are alternatives, not parallel release requirements. Keeping their config files does not activate a deployment or create an account.

| Alternative | Guide | Retained configuration |
| --- | --- | --- |
| Self-hosted Node, Docker Compose and Caddy | [Container operations](../06-deployment-and-operations.md) | `deploy/docker/`, `deploy/caddy/` |
| Cloudflare Pages and Workers | [Cloudflare](cloudflare.md) | `wrangler.toml`, shared Worker runtime adapter |
| Railway API | [Railway](railway.md) | `deploy/railway/railway.api.json` |
| Render API | [Hosting architecture](../11-deployment-and-hosting.md) | `deploy/render/render.yaml` |
| Static dashboard internals | [Dashboard architecture](dashboard.md) | Existing console build artifacts |

Host-specific operating notes belong in this directory. Runtime source, host-discovered configuration, Docker build contexts and working CI adapters stay in their current paths to avoid breaking existing consumers. The duplicate API Dockerfile was removed in Phase A; `deploy/docker/Dockerfile.api` is the retained container build entry.

## Before changing a path

Check `package.json`, `.github/workflows/`, both Vercel configs, `wrangler.toml`, Docker Compose build contexts, host manifests and scripts for references. Do not move an auto-discovered root config merely to organize documentation. Alternative adapters remain covered by the current build/edge checks; this documentation consolidation does not remove that coverage.
