# 11 — Deployment & Hosting / النشر والاستضافة

> Deployment entry point: [primary Vercel runbook and optional adapters](./deployment/README.md). Automatic Vercel Git deployments are paused, including main.

> **Scope / النطاق:** how to run the three-app static frontend (Customer Dashboard at `/`, Platform Admin at `/admin/`, docs at `/docs/`) together with the independent API on `:8080`, across local development, serverless hosts and full self-hosting.
>
> **Golden rule / القاعدة الذهبية:** there are **two independent deployables**. The BACKEND serves `/v1` (REST **and** WebSocket) from its own origin; the FRONTEND is a static site that resolves that origin via `VITE_API_BASE_URL` / `window.__VELLUM_API_BASE_URL__`. They share no runtime state: a frontend outage leaves the API serving customers, and an API outage leaves the static UI rendering with a clear error state. On Vercel this means two projects — `vellum-api` (rootDirectory `apps/api`) and `vellum-console` (repo root). Because the origins differ, the backend must allow the exact frontend origin in `CORS_ALLOWED_ORIGINS` (never `*` with credentials). See `docs/DEPLOYMENT-SPLIT.md` for the full settings table.
>
> **Local convenience / تسهيل محلي:** `pnpm dev:stack` still starts both local servers together and the gateway proxies `/v1` to `:8080`, so cookies stay first-party during development. This proxy is a local-only convenience and is **not** part of the production frontend build.

## 0. One core, three delivery adapters (all platforms)

The domain logic lives in `createVellumApp()` / `createVellumPlatform()` and is
runtime-agnostic. Only the delivery adapter changes:

| Target | Entry point | Realtime | Database |
|---|---|---|---|
| VPS / Docker / Railway / Render / bare Node | `apps/api/src/node-server.ts` | `node:http` + custom RFC 6455 | pg or Neon |
| Vercel Functions | `apps/api/api/server/[...path].ts` → `apps/api/dist/runtime/vercel.js` | native WS on Fluid Compute (`export default http.Server`) | pg or Neon |
| Cloudflare Workers | `wrangler.toml` → `apps/api/dist/runtime/cloudflare.js` | `WebSocketPair` + shared hub | Neon HTTP/WS |

There is **no second backend implementation**. On Vercel, `apps/api/vercel.json`
(the backend project's config) rewrites `/v1/*` to the function; the adapter
strips its `/api/server` mount prefix. The root `vercel.json` belongs to the
static frontend project and has no API rewrite. On
Cloudflare, `WebSocketPair` is bridged into `RealtimeGatewayHub` and both planes
use Neon; `LISTEN/NOTIFY` is replaced by the durable outbox polling path.
Cross-instance state remains PostgreSQL-only (Zero-Redis), so every platform
sees the same events. CI verifies the Worker bundle with `wrangler deploy
--dry-run`.

---

## 1. Local development / التطوير المحلي

### One command, two URLs

```bash
# Build once (the stack never builds on startup):
corepack pnpm build
corepack pnpm build:frontend

# Then start API + unified frontend gateway:
corepack pnpm dev:stack
```

`dev:stack` launches exactly two processes and exposes **only two public URLs**:

| URL | Serves | Notes |
| :-- | :----- | :---- |
| `http://localhost:3000` | Unified frontend gateway | `/` = Customer Dashboard, `/admin/` = Platform Admin, `/docs/` = docs, `/v1/*` = API proxy (HTTP + WS) |
| `http://localhost:8080` | API (REST + WebSocket + workers) | Direct access for SDKs, `curl`, `test:e2e-real`; liveness `/v1/health/live`, readiness `/v1/health/ready` |

The three development-only Vite ports (`5173` dashboard, `5174` admin, `5175` docs) still exist **internally** in `--mode=dev`: the gateway starts them as detached children and proxies to them. They are never meant to be used by a browser directly — opening them defeats single-origin cookie scoping and re-introduces CORS. For a production-like check use the built tree:

```bash
corepack pnpm build:frontend
node scripts/dev/frontend-gateway.mjs --mode=prod   # serves dist-frontend/ on :3000
```

### Why the apps stay separate / لماذا تبقى التطبيقات منفصلة

- `apps/dashboard` and `apps/admin` are built as independent Vite bundles with their own routers and design-system instances; `scripts/build-unified-frontend.mjs` merges their `dist` trees under `/` and `/admin/` into a single `dist-frontend/`. They are **not** one React app and must never share a router, store, or token bucket.
- Each app is a thin delivery adapter. Business logic stays in `packages/*` (framework-agnostic), never in route handlers or UI components.
- The admin router uses `basepath: "/admin"` (`apps/admin/src/main.tsx`), so a route declared as `to="/tenants"` resolves to `/admin/tenants` on the unified origin. Never hardcode `/admin/` inside admin route definitions.

### Why the API stays independent / لماذا تبقى الـ API مستقلة

- The API is a standalone Hono service on `:8080` with its **own** database connections and workers. Bootstrapping, operator login, API-key verification and outage recovery never depend on the public document API or on any frontend.
- The gateway is a stateless `node:*`-only reverse proxy. Killing or restarting it does not stop the API; point another proxy (Caddy, Vercel rewrite, Cloudflare Function) at `:8080` and the same API works unchanged.

---

## 2. Storage & cookie isolation / عزل التخزين والملفات تعريف الارتباط

Both consoles run on one origin, so `localStorage` is shared. Isolation is achieved by **disjoint key prefixes** and **strict cookie paths** — never by hostname.

### `localStorage` keys (browser-owned session)

| Realm | Access token | Refresh token | User blob |
| :---- | :----------- | :------------ | :-------- |
| Customer Console (`/`) | `vellum_console_access_token` | `vellum_console_refresh_token` | `vellum_console_user` |
| Platform Super Admin (`/admin/`) | `vellum_super_admin_access_token` | `vellum_super_admin_refresh_token` | `vellum_super_admin_user` |

- Each realm's storage module reads/writes **only** its own prefix (`apps/dashboard/src/lib/auth.ts`, `apps/admin/src/lib/auth.ts`). No shared JSON blob, no cross-realm fallback.
- The user blob stores `{ user, expiresAt }`; tokens live in their own keys so the silent-refresh interceptor can rotate just the access token.
- Shared-but-harmless key: `vellum.locale` (UI language preference). It is not a credential.

### Refresh cookies (HttpOnly, server-set)

| Realm | Cookie name | `Path` | Purpose |
| :---- | :---------- | :----- | :------ |
| Customer Console | `vellum_console_rt` | `/v1/console/auth` | Silent refresh for `/v1/console/*` |
| Platform Super Admin | `vellum_admin_rt` | `/v1/admin/auth` | Silent refresh for `/v1/admin/*` |

The historically shared `vellum_refresh_token` name is **deprecated** and kept only as a symbol alias. Strict paths mean a console refresh cookie is never sent to an admin endpoint and vice versa, even though both are first-party on the same host.

> **Verification / التحقق:** `node scripts/qa-unified-gateway.mjs` proves, in one browser context, that logging into `/admin/` leaves all three `vellum_console_*` keys byte-identical and that no admin page writes a console key..

---

## 3. Option A — Vercel frontend + Railway/Render API

Best when you want a managed static frontend and a managed API, with a custom domain on each.

### 3.1 Frontend (Vercel)

The root [`vercel.json`](../vercel.json) is already configured:

- **Build command:** `corepack pnpm build:frontend`
- **Output directory:** `dist-frontend`
- **Framework preset:** Other / none

It rewrites `/admin`/`/admin/*` and `/docs` to their `index.html`, forwards extensionless paths to the dashboard SPA, and gives asset directories a one-year immutable `Cache-Control`. The negative lookaheads in the rewrites guarantee a missing `/assets/...` or `/admin/assets/...` returns a real **404**, never `index.html` with HTTP 200.

**Replace the API placeholder before deploying** — `vercel.json` contains:

```json
{ "source": "/v1/(.*)", "destination": "https://api.yourdomain.com/v1/$1" }
```

Vercel cannot interpolate environment variables into rewrite destinations, so `api.yourdomain.com` is documentation-only. Edit the file to your real API host. Keep `VITE_API_BASE_URL` **empty at build time**: the `/v1` rewrite makes API calls same-origin, which also keeps WebSocket upgrades on the page's own origin.

### 3.2 API (Railway or Render)

- **Railway:** use [`deploy/railway/railway.api.json`](../deploy/railway/railway.api.json) (or copy to `railway.json`). Build `pnpm --filter @vellum/api build`, start `node apps/api/dist/node-server.js`, healthcheck `/v1/health/live`. See [`deploy/railway/README.md`](../deploy/railway/README.md).
- **Render:** use [`deploy/render/render.yaml`](../deploy/render/render.yaml). Same build/start commands, `PORT`/`API_PORT` pinned to `8080`, secrets declared with `sync: false`. See the file comments.

Required production env vars (set values in the host dashboard, never in source):

| Variable | Meaning |
| :------- | :------ |
| `NODE_ENV=production`, `DATABASE_MODE=postgres` | Production mode; disable in-memory test DB |
| `CONTROL_DATABASE_URL`, `DATA_DATABASE_URL` | External Neon/Postgres URLs for the two planes |
| `DATA_DATABASE_URL_LISTEN` | Session-mode (non-`-pooler`) URL for the dedicated LISTEN client; omit for polling-only realtime |
| `PORT=8080`, `API_PORT=8080`, `API_HOST=0.0.0.0` | Listener configuration |
| `BETTER_AUTH_SECRET`, `JWT_SECRET`, `API_KEY_PEPPER`, `CURSOR_HMAC_SECRET`, `SESSION_COOKIE_SECRET`, `MASTER_ENCRYPTION_KEY` | Replace **all** development defaults |
| `CONSOLE_JWT_SECRET`, `SUPER_ADMIN_JWT_SECRET` | Distinct realm secrets; startup refuses to run in production without both |
| `CORS_ALLOWED_ORIGINS` | Comma-separated frontend origins, e.g. `https://vellum.example.com` (`CORS_ORIGINS` accepted for config parity) |

### 3.3 Custom domains & CORS

1. Attach `vellum.example.com` to Vercel and `api.example.com` to Railway/Render.
2. Set `CORS_ALLOWED_ORIGINS=https://vellum.example.com` on the API. If clients also use a second frontend domain, include it too (comma-separated).
3. Update the `/v1/(.*)` rewrite in `vercel.json` to `https://api.example.com/v1/$1` and redeploy.
4. Verify: `curl -fsS https://api.example.com/v1/health/live` returns 200; `https://vellum.example.com/` shows the dashboard; `https://vellum.example.com/admin/` the admin console.

---

## 4. Option B — Cloudflare Pages + external API

See [`deploy/cloudflare/README.md`](../deploy/cloudflare/README.md).

1. **Connect to Git** → build command `corepack pnpm build:frontend`, output `dist-frontend`, **Node 22** (`NODE_VERSION=22`), root directory empty.
2. The build writes two routing artifacts into `dist-frontend/` — **do not hand-edit them**:
   - `_redirects` — SPA fallbacks for `/admin/*` and `/*`, pass-through rules for `/assets/*`, `/admin/assets/*`, `/docs/assets/*`.
   - `_headers` — `X-Content-Type-Options`, `X-Frame-Options`, `Referrer-Policy`, plus immutable caching for hashed assets.

   Both are regenerated by `scripts/build-unified-frontend.mjs` on every build; change the generator, not the output.
3. **API traffic:** static Pages does not proxy `/v1`. Either add a Pages Function forwarding `/v1/*` (including WebSocket upgrades) to the API, **or** set the build-time variable `VITE_API_BASE_URL=https://api.example.com` and add `https://<your-pages-domain>` to the API's `CORS_ALLOWED_ORIGINS`. The first option keeps everything same-origin and is preferred.
4. Use the Railway/Render API config from Option A for the backend. No broker or cache service to provision.

---

## 5. Option C — Full self-hosted Docker Compose + Caddy

Best when you control the host and want automatic HTTPS with no external proxy configuration.

```bash
# Ports 80 and 443 must be publicly reachable for ACME certificate issuance.
VELLUM_DOMAIN=example.com \
  docker compose -f deploy/docker/docker-compose.prod.yml up -d --build
```

The stack ([`deploy/docker/docker-compose.prod.yml`](../deploy/docker/docker-compose.prod.yml)) contains **three containers and no database or broker container**:

| Service | Image / build | Role |
| :------ | :------------ | :--- |
| `api` | [`deploy/docker/Dockerfile.api`](../deploy/docker/Dockerfile.api) | Hono API on `:8080`; healthcheck `/v1/health/live` |
| `frontend` | [`deploy/docker/Dockerfile.frontend`](../deploy/docker/Dockerfile.frontend) | Builds `dist-frontend/` and runs the gateway on `:3000` with `API_UPSTREAM=http://api:8080` |
| `caddy` | `caddy:2-alpine` | Automatic HTTPS on `:80`/`:443` |

[`deploy/caddy/Caddyfile`](../deploy/caddy/Caddyfile) defines two sites using `VELLUM_DOMAIN`:

- `api.{$VELLUM_DOMAIN}` → `reverse_proxy api:8080`
- `{$VELLUM_DOMAIN}` → `/v1/*` proxied to `api:8080` (WebSocket upgrades pass through), everything else to `frontend:3000`

So the public URLs are:

- `https://example.com/` — Customer Dashboard
- `https://example.com/admin/` — Platform Admin
- `https://example.com/docs/` — documentation
- `https://api.example.com/v1/...` — direct API (optional; the main site already proxies `/v1`)

The API reads all secrets and both database URLs from the root `.env` via `env_file` — see [`.env.example`](../.env.example). **External PostgreSQL/Neon only:** `CONTROL_DATABASE_URL` and `DATA_DATABASE_URL` must point outside the Compose network. This is the Zero-Redis doctrine in practice — no `redis:` service, no broker, no second cache.

---

## 6. Troubleshooting / استكشاف الأخطاء

### Missing assets must 404, never serve HTML

The gateway and both host configs deliberately exclude asset directories from SPA fallbacks. A missing `.js`/`.css` must return **404 with a non-HTML content type**, otherwise the browser reports `Unexpected token '<'`.

```bash
curl -sSI http://localhost:3000/assets/__missing__.js        # -> 404, text/plain
curl -sSI http://localhost:3000/admin/assets/__missing__.js  # -> 404, text/plain
```

If you see `200 text/html`, check the rewrite order in `vercel.json` / `_redirects` / Caddy `handle` blocks and make sure the negative lookaheads are present.

### `/docs` vs `/docs/`

The docs are a React SPA built with Vite `base: "/docs/"`; all emitted asset URLs are absolute (`/docs/assets/...`), so the old relative-path caveat no longer applies. The canonical root is `/docs/` and the gateway redirects a bare `/docs` there with `301`. English pages use `/docs/<slug>/`, Arabic pages `/docs/ar/<slug>/`, and both are client-side routes backed by `apps/docs/dist/index.html`.

### CORS origins

- Local development: the API allows `http://localhost:3000` by default (alongside the historical `5173`/`5174`). If you override `CORS_ALLOWED_ORIGINS`, include `:3000` or dashboard logins will fail with a CORS error.
- Production: `CORS_ALLOWED_ORIGINS` must contain the **exact** browser origin (scheme + host + port). `https://vellum.example.com` and `https://www.vellum.example.com` are different origins — list both if both serve the app.
- Prefer the `/v1` rewrite/proxy so browser calls are same-origin and CORS never applies.

### Refresh cookie paths

If silent refresh stops working after login but manual login succeeds, the refresh cookie is probably being sent to the wrong path. Confirm `Set-Cookie` shows `Path=/v1/console/auth` for the customer console and `Path=/v1/admin/auth` for the super admin. Cookies are `HttpOnly`; JavaScript never reads them — the three realm-prefixed `localStorage` keys hold the access tokens.

### Deep-link refresh on `/admin/*` and `/docs/*`

- The gateway serves `dist-frontend/admin/index.html` for `/admin/<extensionless route>`, and `dist-frontend/docs/index.html` for `/docs/<route>`. A hard refresh on those URLs must return 200 with a rendered page, not 404.
- Vercel uses `cleanUrls: true` and rewrites `/admin/((?!assets/).*)` → `/admin/index.html`.
- Cloudflare `_redirects` maps `/admin/*` → `/admin/index.html` and `/docs/*` → `/docs/index.html` (the React SPA entry), with asset pass-through lines placed **first**. Missing `/docs/assets/*` and `/admin/assets/*` still return a real 404.
- The admin router's `basepath: "/admin"` means hard navigation to `/admin/auth` runs the admin auth guard; losing the admin session there redirects to `/admin/login` (still 200, not 404).

### Node ≥ 22 requirement

`package.json` declares `engines.node >= 22`, and both production Dockerfiles use `node:22-alpine` and hard-fail on any other major version. Local environments running Node 20 (such as some CI sandboxes) can still execute the zero-dependency gateway and Playwright scripts, but **production builds and images must use Node 22**. Set `NODE_VERSION=22` in Vercel/Cloudflare and use the provided Dockerfiles for self-hosting.

### Health checks & migrations

- Liveness: `GET /v1/health/live` (no DB dependency). Readiness: `GET /v1/health/ready`.
- Run `corepack pnpm db:migrate` against both planes before cutting traffic; never rely on the API to create schema at runtime.
- Never print database URLs, API keys, session tokens or bearer JWTs in logs — `@vellum/observability` redacts known secret shapes, but host-level logs must also avoid echoing `.env`.

---

## 7. Related documents / وثائق ذات صلة

- [`docs/06-deployment-and-operations.md`](./06-deployment-and-operations.md) — workers, observability, backups and DR.
- [`docs/guides/production-checklist.md`](./guides/production-checklist.md) — generated-site production checklist.
