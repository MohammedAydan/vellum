# Deployment Split — Two Independent Vercel Projects

One GitHub repository (`MohammedAydan/vellum`, team `MAG-1`) produces **two
independently deployed Vercel projects**. They share source and the public `/v1`
contract, but they do not share a build, a deploy lifecycle, or a failure domain.

| Deployable | Vercel project | Contains |
| --- | --- | --- |
| BACKEND | `vellum-api` | Hono REST API + WebSocket realtime, serverless functions only |
| FRONTEND | `vellum-console` | Static dashboard, admin console, and docs site |

The only integration point is the public `/v1` REST + WebSocket contract. The
frontend resolves it with `VITE_API_BASE_URL` at build time, with an optional
`window.__VELLUM_API_BASE_URL__` runtime override. There is **no** production
`/v1` proxy in the frontend project.

## 1. Architecture and failure-domain isolation

```
                      public /v1 (REST + WS, CORS)
   Browser ────────────────────────────────────────────►  vellum-api
     │                                                   (apps/api, functions)
     │ static assets only                                  │
     └──────────────────────────────────────────────►  vellum-console
                                                        (static dist-frontend)
```

- **A frontend outage must not take down the API.** `vellum-api` serves Hono REST
  and WebSocket traffic from its own functions; it never imports UI code
  (`packages/ui`, `apps/dashboard`, `apps/admin`, `apps/docs`) and does not depend
  on any frontend asset being present.
- **An API outage must not blank the UI.** `vellum-console` is static HTML/JS/CSS
  with no server-side rendering dependency on the backend. If the API is down,
  the UI still renders and surfaces a clear error state.
- **The frontend is static-only.** It does not ship database drivers or server
  secrets, and its source may not import `apps/api`, `packages/database-control`,
  `packages/database-data`, `packages/storage`, or `packages/document-engine`.
  It may import `@vellum/api-contract`, `@vellum/core`, `@vellumdb/sdk-js`,
  `@vellum/ui`, and `@vellum/authorization`.
- **The legacy root-level `api/` function directory must stay absent.** Because
  `vellum-console` uses the repository root as its `rootDirectory`, a root `api/`
  directory would be auto-discovered as a serverless Function and fail to bundle
  (the frontend build does not produce `apps/api/dist/runtime/vercel.js`). The
  canonical function entry lives at `apps/api/api/server/index.js`.
- **SPA deep links need a platform fallback.** All three frontends are
  client-side-routed SPAs; only `/index.html`, `/admin/index.html` and
  `/docs/index.html` exist as built files. `vercel.json` rewrites `/admin/*` and
  `/docs/*` to their own shells and every other path to `/`, so direct
  navigation and reload on routes such as `/login` work. Two Vercel-specific
  rules matter here:
  1. `path-to-regexp` accepts a negative lookahead only inside a **named**
     parameter — write `/:path((?!admin/|docs/|assets/|v1/).*)`, never
     `/((?!...).*)`. A bare group silently fails to match and returns
     `404 NOT_FOUND` on every sub-route.
  2. With `cleanUrls: true`, rewrite destinations must be **extensionless**
     (`/`, `/admin`, `/docs`). A destination ending in `.html` is stripped by
     `cleanUrls`, fails Vercel's `check: true` filesystem probe, and the route
     404s (or 308-redirects away from the original deep link).

Guardrails: `corepack pnpm verify:split` (script `scripts/verify-split.mjs`) and
the CI jobs `split-boundaries`, `backend-build`, and `frontend-build`.

## 2. Exact Vercel settings

| Setting | `vellum-api` (BACKEND) | `vellum-console` (FRONTEND) |
| --- | --- | --- |
| Repository | `MohammedAydan/vellum` | `MohammedAydan/vellum` |
| Team | `MAG-1` | `MAG-1` |
| `rootDirectory` | `apps/api` | repository root (`.`) |
| Framework preset | Other | Vite / Static |
| Install command | `cd ../.. && corepack pnpm install --frozen-lockfile` | `corepack pnpm install --frozen-lockfile` |
| Build command | `node ../../scripts/build-backend.mjs && cd ../.. && corepack pnpm db:migrate` | `corepack pnpm build:console` |
| Output directory | `public` (required static output for the build) | `dist-frontend` |
| Function entry | `apps/api/api/server/index.js` | none — static only |
| Node.js version | 22.x | 22.x |
| Clean URLs / trailing slash | n/a | `cleanUrls: true`, `trailingSlash: false` |

Because the backend is deployed with `rootDirectory: apps/api`, every command
runs relative to that folder: the install/build commands `cd ../..` to the
monorepo root, while the build script emits `apps/api/dist` and
`apps/api/public`. Migrations run as part of the backend build (`db:migrate`),
so a successful deployment always has a migrated schema — there is no separate
manual migration step in production.

`apps/api/vercel.json` rewrites `/v1/:path*` to
`/api/server?path=/v1/:path*`. Vercel cannot route a multi-segment rewrite
destination to a single-segment Function, so the original request path is
carried in the `path` query parameter. The Function calls
`platform.fetch(new Request(new URL(target, "http://localhost"), init))`
directly: Vercel pre-parses POST bodies into `req.body` without ending the Node
request stream, so Hono's Node adaptor would otherwise wait forever and the
request would fail with `FUNCTION_INVOCATION_TIMEOUT`. Do not replace this with
the standard `app.fetch(req, res)` Node adaptor or a `c.req.json()` read.

### Backend environment variables (`vellum-api`)

| Variable | Purpose |
| --- | --- |
| `DATABASE_MODE` | `memory` or `postgres` (default `memory`) |
| `CONTROL_DATABASE_URL` | Control-plane Postgres URL — **required in postgres mode** |
| `DATA_DATABASE_URL` | Data-plane Postgres URL — **required in postgres mode** |
| `CORS_ALLOWED_ORIGINS` | Exact browser origin(s) allowed for REST + WebSocket |
| `NODE_ENV` | `production` (refuses hardcoded development secrets) |
| `JWT_SECRET` | Console session token signing |
| `CONSOLE_JWT_SECRET` | Console-realm session secret (distinct, production) |
| `SUPER_ADMIN_JWT_SECRET` | Admin-realm session secret (distinct, production) |
| `BETTER_AUTH_SECRET` | Auth library secret |
| `SESSION_COOKIE_SECRET` | Session cookie signing |
| `API_KEY_PEPPER` | API key hashing pepper |
| `CURSOR_HMAC_SECRET` | HMAC-SHA256 pagination cursor signing |
| `MASTER_ENCRYPTION_KEY` | AES-256-GCM master key for end-user auth secrets |
| `ADMIN_SETUP_TOKEN` | One-time bootstrap secret required by `/v1/admin/setup-owner` in production — generate 32+ random chars, remove after the Master Owner is created |

`CONTROL_DATABASE_DRIVER` and `DATA_DATABASE_DRIVER` select the storage adapter;
set both to `pg` when using Neon pooled `postgresql://…` URLs (the deployed
configuration). Optional `*_DIRECT` and `DATA_DATABASE_URL_LISTEN` variants may
be supplied for migrations and the dedicated `LISTEN` client; unfilled
`CHANGE_ME` placeholders are ignored so readiness does not fail on them.

Production refuses to start while any development default secret is still in
use, while realm secrets are missing, or while the two realm secrets are
identical. Secrets are never logged; values are redacted by
`@vellum/observability`.

### Frontend environment variables (`vellum-console`)

| Variable | Purpose |
| --- | --- |
| `VITE_API_BASE_URL` | Build-time API origin, e.g. `https://api.example.com` |
| `window.__VELLUM_API_BASE_URL__` | Optional runtime override injected into the static HTML |

The frontend holds **no** `DATABASE_*` URL and **no** server-side secret. Do not
set CORS headers in `vercel.json`; CORS is enforced by the backend.

## 3. CORS configuration

The backend allows **only the exact frontend origin** via `CORS_ALLOWED_ORIGINS`
on `vellum-api`. Example (replace with the real Vercel-assigned console URL):

```
CORS_ALLOWED_ORIGINS=https://console.example.com
```

- Multiple exact origins are comma-separated; every entry must be a full
  `scheme://host[:port]` origin.
- **Never use `*` with credentials**, and never use `null`. Wildcards and `null`
  are rejected by the origin allowlist.
- The same allowlist governs the WebSocket upgrade on `/v1/realtime`: a browser
  upgrade with a disallowed origin receives `403 Forbidden`, while a native
  client without an `Origin` header is permitted.
- An empty allowlist fails closed for browser clients.

## 4. Deploy order

1. **Deploy the frontend first.** Deploy `vellum-console` with
   `VITE_API_BASE_URL=https://api.example.com` so it has a stable public URL,
   e.g. `https://console.example.com`. It needs no backend configuration to
   build and serve static assets.
2. **Set backend CORS.** Add or update `CORS_ALLOWED_ORIGINS` on `vellum-api` to
   the exact origin from step 1.
3. **Redeploy the backend.** Deploy `vellum-api` (`corepack pnpm build:api`).
   If the console origin changed, redeploy the console too so its build-time
   `VITE_API_BASE_URL` is current.
4. **Verify** with the checklist in §8.

Deployments are per project. Never add a deployment step that requires secrets
not present in CI; the `split-boundaries`, `backend-build`, and
`frontend-build` CI jobs prove correctness without deploying.

A local dry run of the plan and environment audit is available:

```bash
node scripts/deploy-vercel.mjs           # print plan + env audit + verification commands
node scripts/deploy-vercel.mjs --check   # env audit only; non-zero if required vars are missing
```

The helper never prints secret values and does not deploy anything itself.

## 5. Local development

```bash
corepack pnpm install --frozen-lockfile

corepack pnpm dev:backend   # standalone API at http://127.0.0.1:8080
corepack pnpm dev:console   # frontend dev servers (dashboard/admin/docs)
corepack pnpm dev:stack     # both sides together
```

By default `DATABASE_MODE=memory`, so no database is needed locally. The
backend serves `/v1/health` and `/v1/ready`; the frontend's dev gateway targets
`http://127.0.0.1:8080` unless `VITE_API_BASE_URL` is overridden.

## 6. Switching from memory mode to Postgres

Memory mode is stateless and for local development only. To move `vellum-api`
to Postgres:

1. Provision **two separate** Postgres databases: `control_db` (users, orgs,
   projects, key hashes, rulesets, metering, audit) and `data_db` (documents,
   indexes, outbox, transactions). The project is the sole tenant dimension.
2. Set on `vellum-api`:
   `DATABASE_MODE=postgres`, `CONTROL_DATABASE_URL=postgresql://…`,
   `DATA_DATABASE_URL=postgresql://…`, `NODE_ENV=production`, and strong,
   distinct values for every secret in the backend table above.
3. Run migrations **before boot** (the advisory-lock runner is safe for
   concurrent instances): `corepack pnpm db:migrate`.
4. Confirm the four RLS-protected data-plane tables
   (`documents`, `document_indexes`, `document_index_entries`,
   `realtime_outbox`) exist and have row-level security enabled.
5. Redeploy `vellum-api` and run the §8 checklist. Realtime uses PostgreSQL
   `LISTEN/NOTIFY` plus the durable outbox — no Redis, broker, or cache service
   is introduced.

Never log the database URLs; the observability layer redacts them.

## 7. Rollback

Because the projects are independent, roll back only the failing side.

1. In the Vercel dashboard, open the affected project (`vellum-api` or
   `vellum-console`) → **Deployments**, select the last known-good deployment,
   and choose **Promote to Production**. Equivalently, use the Vercel CLI
   rollback command with the team scope `MAG-1`.
2. If the backend was rolled back to a build with a different CORS allowlist,
   re-apply `CORS_ALLOWED_ORIGINS` for the *current* console origin and
   redeploy the backend; a stale allowlist is the most common cause of
   post-rollback login failures.
3. If the frontend was rolled back, confirm its `VITE_API_BASE_URL` still points
   at the live API origin. Static rollback does not affect API availability.
4. Do **not** automatically reverse a database migration against live data.
   Migrations are forward-only under an advisory lock; if a schema change must be
   undone, restore the affected plane (`control_db` or `data_db`) from a backup
   first and coordinate with the migration owner.
5. Re-run the §8 verification after any rollback.

## 8. Verification checklist

- [ ] `node scripts/verify-split.mjs` (or `corepack pnpm verify:split`) passes —
      no cross-boundary imports, no production `/v1` proxy, no root `api/` dir.
- [ ] CI jobs `split-boundaries`, `backend-build`, and `frontend-build` are green.
- [ ] `backend-build` asserts `apps/api/dist/runtime/vercel.js` and
      `apps/api/api/server/[...path].ts`.
- [ ] `frontend-build` asserts `dist-frontend/{index.html,admin/index.html,docs/index.html}`
      and contains **no** `/api/server` function files.
- [ ] `curl -fsS https://api.example.com/v1/health` returns success.
- [ ] `https://console.example.com/`, `/admin/`, and `/docs/` all load.
- [ ] CORS check returns the exact console origin (never `*`):
      `curl -sS -D - -o /dev/null -H 'Origin: https://console.example.com' https://api.example.com/v1/health`
- [ ] WebSocket `/v1/realtime` accepts the exact console origin and rejects a
      disallowed origin with `403 Forbidden`.
- [ ] In postgres mode: both planes migrated, 4 RLS tables verified, and no
      development default secret remains in production.

Run `node scripts/deploy-vercel.mjs` to print this plan, the env audit, and the
verification commands. All domains in this document are `example.com`
placeholders; never commit real credentials.
