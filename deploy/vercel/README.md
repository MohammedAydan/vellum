# Vercel — two independent projects

The VELLUM platform is deployed as **two separate Vercel projects from one Git
repository** (`MohammedAydan/vellum`). They share no runtime state and fail
independently.

| Project | rootDirectory | Build command | Output | Responsibility |
|---|---|---|---|---|
| `vellum-api` (BACKEND) | `apps/api` | `node ../../scripts/build-backend.mjs` | none (Functions only) | HTTP REST + WebSocket `/v1`, auth, data plane |
| `vellum-console` (FRONTEND) | repo root | `corepack pnpm build:console` | `dist-frontend` | dashboard `/`, admin `/admin/`, docs `/docs/` |

The full settings table, deploy order, CORS rules, env vars and rollback steps
live in **`docs/DEPLOYMENT-SPLIT.md`**.

## Backend (`vellum-api`)

- Config file: `apps/api/vercel.json` (auto-loaded because rootDirectory is
  `apps/api`).
- Function entry: `apps/api/api/server/[...path].ts`, re-exporting
  `apps/api/dist/runtime/vercel.js` — the same `http.Server` used by the
  standalone Node adapter (Hono REST + RFC 6455 WebSocket on Fluid Compute).
- Rewrites: `/v1/(.*)` → `/api/server/v1/$1` (and `/health`, `/ready`
  passthroughs). The adapter strips the `/api/server` mount prefix before
  handing requests to Hono and before the WebSocket upgrade handler inspects
  the pathname.
- There is deliberately **no** root-level `api/` directory: the frontend
  project would otherwise discover it as a Function and fail its static build.
- Environment variables (Node 22): `DATABASE_MODE=postgres` for production with
  `CONTROL_DATABASE_URL`, `DATA_DATABASE_URL`, plus `JWT_SECRET`,
  `CURSOR_HMAC_SECRET`, `TX_HMAC_SECRET`, `API_KEY_PEPPER`,
  `CONSOLE_JWT_SECRET`, `SUPER_ADMIN_JWT_SECRET` and, critically,
  `CORS_ALLOWED_ORIGINS=<exact frontend origin>`. Use
  `CONTROL_DATABASE_DRIVER=neon` / `DATA_DATABASE_DRIVER=neon` for Neon.
  `DATABASE_MODE=memory` is a demo-only fallback (no durable storage).
- CORS is enforced by the Hono app, never by a wildcard header: only the exact
  canonical frontend origin is echoed back with credentials.

## Frontend (`vellum-console`)

- Config file: root `vercel.json` — **static only**, no `/v1` rewrite and no
  Function directory.
- Build: `corepack pnpm build:console` → `dist-frontend/` (dashboard + admin +
  docs). Install: `corepack pnpm install --frozen-lockfile`.
- The browser calls the backend through the absolute URL baked into
  `VITE_API_BASE_URL` (or overridden at runtime via
  `window.__VELLUM_API_BASE_URL__`). Because the two projects live on different
  origins, the backend's `CORS_ALLOWED_ORIGINS` must include the frontend URL.
- If the API is down, the static UI still renders and shows a clear error state;
  it never attempts a blocking fetch at page load.

## Routing behaviour (frontend project)

Rewrites are evaluated in order, after Vercel's filesystem check:

- `/admin` and `/admin/<extensionless route>` → `/admin/index.html`
- `/docs` → `/docs/index.html`
- extensionless paths not under `admin/`, `docs/` or `assets/` → `/index.html`
  (dashboard SPA)

Docs pages are real HTML files (`dist-frontend/docs/<slug>.html`), so
`cleanUrls: true` serves them at `/docs/<slug>` without an SPA rewrite.

The negative lookaheads (`(?!assets/)` and
`(?!admin/|docs/|assets/)`) deliberately exclude asset directories from the SPA
fallbacks, so a missing asset returns a real 404 instead of `index.html`.
`/assets/(.*)` and `/(.*)/assets/(.*)` receive an immutable one-year
`Cache-Control` header.
