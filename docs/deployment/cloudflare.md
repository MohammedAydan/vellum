# Cloudflare Pages — unified frontend

Cloudflare Pages hosts the static `dist-frontend/` tree (dashboard at `/`, admin
console at `/admin/`, docs at `/docs/`). The API runs separately; see the
Railway/Render API-only configs or the Docker stack for the backend.

## Connect the repository

1. In Cloudflare Dashboard → **Workers & Pages** → **Create** → **Pages** →
   **Connect to Git**, and select this repository (branch `main`).
2. Set the build configuration:
   - **Framework preset:** None (or Vite — the build command below overrides it).
   - **Root directory:** repository root (leave empty).
   - **Build command:** `corepack pnpm build:frontend`
   - **Build output directory:** `dist-frontend`
   - **Node.js version:** 22 (set the `NODE_VERSION` environment variable to
     `22`, or select Node 22 in the build settings).
3. Deploy. Each push to `main` triggers a fresh build.

## Generated routing files — do not hand-edit

`scripts/build-unified-frontend.mjs` writes two files into `dist-frontend/`
during every build:

- `_redirects` — SPA fallbacks (`/admin/*`, `/docs/*`, `/*`) plus pass-through
  rules for `/admin/assets/*`, `/docs/assets/*` and `/assets/*`.
- `_headers` — `X-Content-Type-Options`, `X-Frame-Options`, `Referrer-Policy`,
  and `Cache-Control: public, max-age=31536000, immutable` for hashed assets.

Both are build artifacts. **Never create or edit `_redirects` / `_headers` in
source or in `dist-frontend`** — the next `corepack pnpm build:frontend`
overwrites them. Change the templates in `scripts/build-unified-frontend.mjs`
instead.

## API traffic

The frontends default to same-origin `/v1`. Static Pages does not proxy `/v1` by
itself, so either add a Pages Function that forwards `/v1/*` (including
WebSocket upgrades) to the API, or set the build-time variable
`VITE_API_BASE_URL=https://api.<domain>` in the Pages project and allow that
origin through the API's `CORS_ALLOWED_ORIGINS`. Do not put a real host into the
build command — keep it in project environment variables.

## Full-stack deploy (API on Cloudflare Workers)

The same Hono app also runs as a Worker. `wrangler.toml` in the repository root
points at `apps/api/dist/runtime/cloudflare.js`:

```bash
corepack pnpm build
npx wrangler deploy
```

The Worker entry (`apps/api/src/runtime/cloudflare.ts`) uses `WebSocketPair`
for `/v1/realtime` and the `RealtimeGatewayHub` from the shared core. Both planes
use Neon's driver (`createNeonControlPlaneStore` + `NeonStorageAdapter`), so no
TCP `pg` connection is needed. Cross-instance realtime stays correct through the
durable `realtime_outbox` in PostgreSQL — no Redis or external broker.

Secrets: `wrangler secret put CONTROL_DATABASE_URL` (and `DATA_DATABASE_URL`,
`JWT_SECRET`, `CURSOR_HMAC_SECRET`, `TX_HMAC_SECRET`, `API_KEY_PEPPER`,
`CONSOLE_JWT_SECRET`, `SUPER_ADMIN_JWT_SECRET`, `CORS_ALLOWED_ORIGINS`).

Validate a build without deploying (also run in CI):

```bash
npx wrangler deploy --dry-run --outdir /tmp/vellum-wrangler-out
```
