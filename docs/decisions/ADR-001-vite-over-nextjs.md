# ADR-001: Vite 6 + React 19 SPA over Next.js 15 for Dashboards

## Status
Accepted

## Context
Specification Sections 3, 13, and 14 originally mentioned Next.js 15 (App Router) for both the Customer Developer Dashboard (`apps/dashboard`) and Platform Owner Admin Console (`apps/admin`). However, the project direction explicitly overrides this with:
> "UI / Dashboards — React + Vite + TanStack (overrides spec's Next.js) ... Customer Dashboard — React 19 + Vite 6 + TanStack Router/Query + shadcn/ui + Tailwind 4 (`apps/dashboard`) ... Admin Dashboard — same stack (`apps/admin`). Rule: `apps/dashboard` and `apps/admin` are SPAs served statically. All data operations go through `apps/api` via `@vellum/sdk-js`."

## Decision
We adopt **Vite 6 + React 19 + TanStack Router + TanStack Query + Tailwind CSS 4 + shadcn/ui** for both `apps/dashboard` and `apps/admin`:
1. Both dashboards will be built as client-side Single-Page Applications (SPAs) and output static assets (`dist/`).
2. Routing will be strictly typed and file-based using `@tanstack/react-router`.
3. All asynchronous data fetching, caching, and optimistic mutations will be orchestrated via `@tanstack/react-query`.
4. Dashboards will communicate with the backend exclusively via `apps/api` using `@vellum/sdk-js` and standard HTTP/REST endpoints configured via `VITE_API_BASE_URL`.
5. Next.js 15 runtime and server components are entirely removed from `apps/dashboard` and `apps/admin`.

## Consequences

### Positive
- **Instant Hot Module Replacement (HMR)** and sub-second build times using Vite 6.
- **Pure Static Delivery**: Eliminates the operational overhead and memory consumption of long-running Node.js SSR server containers for dashboards; static bundles can be hosted on Cloudflare Pages, S3/CloudFront, Vercel static, or served from Nginx.
- **Enforced Architectural Separation**: Precludes accidental leakage of backend engine logic or direct database connections into dashboard server actions, preserving the modular monolith boundaries defined in `AGENTS.md`.
- **First-Class TanStack Integration**: TanStack Router provides 100% type-safe search parameters, route params, loaders, and error boundaries.

### Negative / Trade-offs
- No native server-side rendering (SSR) for initial HTML paint; initial page load requires downloading the client JavaScript bundle. Since these are authenticated developer/admin SaaS portals behind login gates, SEO is irrelevant.
- Authentication tokens must be managed client-side in memory or secure cookies rather than Next.js server session cookies.
