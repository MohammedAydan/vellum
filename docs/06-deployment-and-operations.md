# 06 — Deployment, Hardened Containers, Probes & Operations

> Deployment entry point: [primary Vercel runbook and optional adapters](./deployment/README.md). Automatic Vercel Git deployments are paused, including main.

> **Scope:** Authoritative production deployment, container hardening, graceful shutdown, health/readiness probing, configuration validation, and maintenance worker reference.  
> **Grounded in:** `deploy/docker/docker-compose.prod.yml`, `deploy/docker/Dockerfile.api`, `deploy/caddy/Caddyfile`, `apps/api/src/node-server.ts`, `apps/api/src/routes/health.ts`, `apps/api/src/config.ts`, `package.json`.

VELLUM follows the **PostgreSQL-Only (Zero-Redis) Doctrine**: PostgreSQL is the sole stateful runtime dependency across every deployment topology. There is no Redis, message broker, or external cache cluster to provision, patch, or fail over.

---

## 1. Production Deployment Topologies

### 1.1 Self-Hosted Hardened Docker Compose + Caddy (`deploy/docker/docker-compose.prod.yml`)
Recommended for single-node or VM production deployments with automatic ACME HTTPS:

```bash
VELLUM_DOMAIN=example.com docker compose -f deploy/docker/docker-compose.prod.yml up -d --build
```

```text
Internet (80 / 443)
   │
   ▼
┌────────────────────────────────────────────────────────────────┐
│ Caddy 2 (caddy:2-alpine) — Auto ACME HTTPS, HSTS, CSP, Headers │
│   • api.<domain>  ───────────────▶ api:8080                    │
│   • <domain>/v1/* (HTTP + WS) ───▶ api:8080                    │
│   • <domain>/* (/, /admin/, /docs/) ──▶ frontend:3000          │
└────────────────────────────────────────────────────────────────┘
          │                                       │
          ▼                                       ▼
┌───────────────────────────┐       ┌────────────────────────────┐
│ api (127.0.0.1:8080)      │       │ frontend (127.0.0.1:3000)  │
│ Node 22 + tini + non-root │       │ Unified Frontend Gateway   │
│ read_only + cap_drop: ALL │       │ read_only + cap_drop: ALL  │
└─────────────┬─────────────┘       └────────────────────────────┘
              │
              ▼
   External PostgreSQL / Neon (control_db + data_db + LISTEN)
```

#### Container Security Controls (`deploy/docker/docker-compose.prod.yml` & `Dockerfile.api`)

| Control | Configuration | Purpose |
| :--- | :--- | :--- |
| **Non-root UID/GID** | `vellum` (`uid: 1001`, `gid: 1001`) | API and frontend never execute as root. |
| **PID 1 Signal Reaping** | `init: true` + `ENTRYPOINT ["/sbin/tini", "--"]` | Proper `SIGTERM`/`SIGINT` forwarding and zombie reaping. |
| **Read-Only Root FS** | `read_only: true` + `tmpfs: /tmp:rw,noexec,nosuid,size=64m` | Prevents runtime filesystem tampering and executable drops. |
| **Dropped Capabilities** | `cap_drop: [ALL]`, `security_opt: [no-new-privileges:true]` | Zero Linux capabilities for `api`/`frontend`; Caddy adds only `NET_BIND_SERVICE`. |
| **Loopback-Only Ports** | `127.0.0.1:8080:8080`, `127.0.0.1:3000:3000` | Prevents direct bypass of Caddy TLS/security headers on public interfaces. |
| **Graceful Stop Window** | `STOPSIGNAL SIGTERM`, `stop_grace_period: 30s` | Gives the API server ample time to drain HTTP + WS connections cleanly. |

### 1.2 Managed PaaS / Split Edge Topologies
- **API:** Deploy `deploy/docker/Dockerfile.api` to Railway (`deploy/railway/railway.api.json`), Render (`deploy/render/render.yaml`), Fly.io, AWS ECS, or Kubernetes.
- **Unified Frontend:** Build with `corepack pnpm build:frontend` (`dist-frontend/`) and serve via `node scripts/dev/frontend-gateway.mjs --mode=prod`, Vercel (`vercel.json`), or Cloudflare Pages (`deploy/cloudflare/README.md`).
- **PostgreSQL:** Neon Serverless PostgreSQL or standard PostgreSQL 16+. Supply `DATA_DATABASE_URL_LISTEN` (a session-mode, non-pooler URL) for `LISTEN/NOTIFY` when using Neon's transaction pooler.

---

## 2. Fail-Fast Configuration & Production Guards (`apps/api/src/config.ts`)

`loadAndValidateConfig()` parses all environment variables with Zod on startup and logs a redacted summary (`getRedactedConfigSummary()` masks credentials in URLs and redacts all secrets).

When `NODE_ENV=production`, the server **refuses to start** if:
1. Any of `BETTER_AUTH_SECRET`, `API_KEY_PEPPER`, `CURSOR_HMAC_SECRET`, `JWT_SECRET`, or `MASTER_ENCRYPTION_KEY` matches its development default or is shorter than 16 characters.
2. Either `CONSOLE_JWT_SECRET` or `SUPER_ADMIN_JWT_SECRET` is missing.
3. `CONSOLE_JWT_SECRET === SUPER_ADMIN_JWT_SECRET` (the two control-plane auth realms must have cryptographically distinct signing keys).

### Essential Production Environment Variables

| Variable | Required in Prod | Purpose |
| :--- | :---: | :--- |
| `NODE_ENV` | Yes (`production`) | Enables fail-closed secret guards, production HSTS, and redacted probe output. |
| `DATABASE_MODE` | Yes (`postgres`) | Selects durable PostgreSQL control + data planes (default `memory` is for tests). |
| `CONTROL_DATABASE_URL` | Yes | Control Plane PostgreSQL URL (migrations always use this or `CONTROL_DATABASE_URL_DIRECT`). |
| `DATA_DATABASE_URL` | Yes | Data Plane PostgreSQL URL (migrations always use this or `DATA_DATABASE_URL_DIRECT`). |
| `DATA_DATABASE_URL_LISTEN` | Recommended (Neon) | Session-mode (non-pooler) URL dedicated to `LISTEN/NOTIFY`. Falls back to stripping `-pooler.` from `DATA_DATABASE_URL`. |
| `CONTROL_DATABASE_APP_URL` / `DATA_DATABASE_APP_URL` | Optional | Least-privilege `vellum_app` (`NOBYPASSRLS`) runtime URLs for request-time queries. |
| `CONSOLE_JWT_SECRET` & `SUPER_ADMIN_JWT_SECRET` | Yes (distinct) | Realm-isolated signing secrets for Customer Console vs. Super-Admin sessions. |
| `BETTER_AUTH_SECRET`, `JWT_SECRET`, `API_KEY_PEPPER`, `CURSOR_HMAC_SECRET`, `MASTER_ENCRYPTION_KEY` | Yes (unique, >=16 chars) | Core cryptographic keys (HKDF audit/billing chain keys derive from `MASTER_ENCRYPTION_KEY`). |
| `CORS_ALLOWED_ORIGINS` | Yes | Comma-separated exact origins (`https://example.com`). Wildcards (`*`) and `null` are rejected. |
| `TRUST_PROXY_HOPS` | Optional (default `1`) | Number of trusted reverse-proxy hops for spoof-resistant IP extraction (`0` if exposed directly). |
| `TRUST_CLOUDFLARE_IP` | Optional (default unset) | Set to `true` only when every request passes through Cloudflare. Then `cf-connecting-ip` is trusted. Ignored on Vercel. |

---

## 3. Liveness, Readiness & Graceful Draining Shutdown

### 3.1 Health & Readiness Probes (`apps/api/src/routes/health.ts`)

| Endpoint | Touches PG? | Production Info Disclosure | Behavior |
| :--- | :---: | :--- | :--- |
| `GET /health` | No | Minimal (`status`, `uptimeMs`, `timestamp`) | Kubernetes/LB liveness probe. Always `200` while event loop is responsive. |
| `GET /ready` | Yes (3 s cache) | Minimal (`status`, `ready`, `timestamp`) | Kubernetes/LB readiness probe. Returns `200` (`ready`), `503` (`unready`), or `503` (`draining`). |
| `GET /v1/health/live` | No | Process-only | Docker `HEALTHCHECK` target (`interval: 15s`, `timeout: 3s`, `retries: 3`). |
| `GET /v1/health/ready` | Yes (3 s cache) | Masks PG version & PID in prod | Runs 5 real parallel probes: `controlDb` (`SELECT 1`), `dataDb` (`SELECT 1`), `controlMigrations` (table + missing + SHA-256 checksum drift), `dataMigrations`, and `realtimeListen` (`LISTEN`/`UNLISTEN`). |

All PostgreSQL readiness probes share a **single-flight in-flight promise** and a **3-second TTL cache** (`PROBE_CACHE_TTL_MS = 3_000`, `PROBE_TIMEOUT_MS = 3_000`) so rapid load-balancer checks or unauthenticated probe floods can never exhaust database connections.

### 3.2 Graceful Draining Shutdown Sequence (`apps/api/src/node-server.ts`)

On `SIGTERM` or `SIGINT`, `node-server.ts` executes an ordered drain with a `15,000 ms` hard exit safety timer (`SIGNAL_SHUTDOWN_HARD_TIMEOUT_MS`):

1. **Enter Draining State:** Sets `draining = true` and `setShuttingDown(true)` (clears readiness cache so `/ready` and `/v1/health/ready` immediately return `503 draining`, signaling load balancers to stop routing traffic). Stops the background maintenance worker interval.
2. **Close WebSockets Cleanly:** `wsManager.closeAllWebSockets()` sends RFC 6455 **`1001 Going Away`** close frames to all connected realtime clients.
3. **Drain In-Flight HTTP Requests:** Sets `Connection: close` on active responses, calls `server.close()` + `server.closeIdleConnections()`, and waits up to `10,000 ms` (`DEFAULT_SHUTDOWN_DRAIN_TIMEOUT_MS`) for in-flight requests to complete before forcing remaining sockets closed.
4. **Flush Buffers & Close Pools:** Flushes in-memory metering counters and pending Smart Index Advisor recommendations, stops the realtime `OutboxPoller` and `LISTEN` client, and closes PostgreSQL pools cleanly before exiting `0`.

### 3.3 HTTP Transport Timeouts (`apps/api/src/node-server.ts`)
- `server.headersTimeout = 15_000` ms (slowloris defense)
- `server.requestTimeout = 30_000` ms
- `server.keepAliveTimeout = 65_000` ms (exceeds standard 60 s LB idle timeout to prevent race resets)
- `MAX_RAW_BODY_BYTES = 5_242_880` bytes (5 MiB, enforced both on `Content-Length` and chunked stream accumulation)

---

## 4. Background Maintenance Workers & Migrations

`node-server.ts` schedules `activePlatform.runMaintenanceWorkers()` every `30,000 ms` (`workerIntervalMs`, `.unref()`'d and guarded by `maintenanceInFlight` so slow ticks never overlap):

1. **Composite Index Backfill Worker:** Claims `document_indexes` rows in `building` status, scans active documents in deterministic `document_id ASC` batches, computes `sort_key BYTEA` via `encodeCompositeSortKey`, batch-inserts via `UNNEST` (`batchInsertIndexEntries`), and transitions status to `ready` (or `failed`).
2. **Realtime Outbox Compaction Worker:** Purges `realtime_outbox` rows older than `OUTBOX_RETENTION_HOURS = 24`.
3. **Tombstone & TTL / Idempotency Cleanup:** Reaps expired `documents` (`expires_at`), soft-deleted tombstones past retention (`TOMBSTONE_RETENTION_DAYS_DEFAULT = 7`), and expired `batch_idempotency_keys` (`24 h` TTL).

### Runnable Operations Commands (`package.json`)

```bash
# Verify Node >= 22 and environment variables
corepack pnpm check:node
corepack pnpm dev:env-check

# Run checksum-verified Control Plane + Data Plane migrations
corepack pnpm db:migrate

# Local full-stack development (unified frontend :3000 + API :8080)
corepack pnpm dev:stack

# Build & verify full monorepo (typecheck + lint + test)
corepack pnpm build
corepack pnpm verify

# Live PostgreSQL HTTP smoke test
corepack pnpm smoke
```

---

## Related Guides

- [11 — Deployment & Hosting (Unified Frontend, Vercel, Railway, Render, Docker)](./11-deployment-and-hosting.md)
- [15 — Security, Threat Detection & Defense in Depth](./15-security-and-defense.md)
