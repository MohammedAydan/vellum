# Railway — API-only deploy

Use `deploy/railway/railway.api.json` as the service config (copy it to `railway.json` at the
repository root, or select it in the Railway dashboard). Nixpacks detects
`pnpm-lock.yaml` and installs dependencies automatically.

- Build command: `pnpm --filter @vellum/api build`
- Start command: `node apps/api/dist/node-server.js`
- Port: 8080 (see `API_PORT` below)
- Healthcheck: `/v1/health/live`

## Environment variables (names only — set values in Railway)

Required in production:

- `NODE_ENV` = `production`, `DATABASE_MODE` = `postgres`
- `CONTROL_DATABASE_URL`, `DATA_DATABASE_URL` (external Neon/Postgres URLs)
- `PORT` = `8080`, `API_PORT` = `8080`, `API_HOST` = `0.0.0.0`
- `BETTER_AUTH_SECRET`, `JWT_SECRET`, `API_KEY_PEPPER`, `CURSOR_HMAC_SECRET`,
  `SESSION_COOKIE_SECRET`, `MASTER_ENCRYPTION_KEY`
- `CONSOLE_JWT_SECRET` and `SUPER_ADMIN_JWT_SECRET` (distinct; startup refuses
  to run in production without both)
- `CORS_ALLOWED_ORIGINS` — comma-separated browser origins, e.g. the Vercel
  frontend domain. `CORS_ORIGINS` is accepted by hosting configs for parity.

Railway injects its own `PORT`; the API reads `API_PORT`, so keep both at 8080
or set `API_PORT` to the value Railway assigns. There is no cache or broker
service to provision: PostgreSQL is the only stateful dependency.
