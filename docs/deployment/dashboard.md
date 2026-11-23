# Dashboard & Admin Deployment Architecture

> Optional static-hosting architecture reference. Start with the [primary deployment entry point](README.md). The primary Vercel path uses one console origin and a separate API origin, not a production console proxy.

## 1. Static SPA Architecture (ADR-001)

Per approved Architecture Decision Record `ADR-001`, both `@vellum/dashboard` and `@vellum/admin` are built as static Single Page Applications (SPAs) using Vite 6 and React 19. They contain zero server-side rendering (SSR) code and compile into pure HTML, CSS, and JavaScript bundles.

---

## 2. Production Build Commands

```bash
# Build Customer Developer Dashboard
pnpm --filter @vellum/dashboard build

# Build Platform Admin Dashboard
pnpm --filter @vellum/admin build
```

The output artifacts are written to:
- `apps/dashboard/dist/`
- `apps/admin/dist/`

---

## 3. Serving with Static Web Server / CDN

Both bundles can be served by any static file server, NGINX, Cloudflare Pages, AWS S3 + CloudFront, or `npx serve`:

```bash
# Preview Customer Dashboard locally on port 3000
npx serve -s apps/dashboard/dist -l 3000

# Preview Admin Console locally on port 3001
npx serve -s apps/admin/dist -l 3001
```

### 3.1 NGINX SPA Configuration

```nginx
server {
    listen 80;
    server_name dashboard.vellum.internal;

    root /usr/share/nginx/html/dashboard;
    index index.html;

    location / {
        try_files $uri $uri/ /index.html;
    }

    location ~* \.(js|css|png|jpg|jpeg|gif|ico|svg|woff2)$ {
        expires 1y;
        add_header Cache-Control "public, immutable";
    }
}
```

---

## 4. Environment Variables

| Variable | Target App | Purpose | Default |
| :--- | :--- | :--- | :--- |
| `VITE_API_BASE_URL` | Dashboard & Admin | Base URL of `@vellum/api` HTTP gateway | `http://localhost:8080` |
