# @vellum/docs

The public documentation site is a **React 19 + TypeScript + Vite** single-page
application. It is the third independent frontend in the monorepo alongside
`apps/dashboard` and `apps/admin`; the three apps are built separately and are
never merged into one source tree.

- **Base path:** `/docs/` (Vite `base: "/docs/"`). Built output lands in
  `apps/docs/dist/` and is copied to `dist-frontend/docs/` by
  `scripts/build-unified-frontend.mjs`.
- **Routing:** pathname-based, language-prefixed. English pages live at
  `/docs/<slug>/`, Arabic pages at `/docs/ar/<slug>/`. Extensionless routes
  fall back to `index.html` in the gateway and in `_redirects`.
- **Bilingual:** every page exists in EN and AR. The shell handles `dir="rtl"`
  and the language toggle; page components contain only their own language.
- **Design:** Firebase/Stripe-inspired docs shell — sticky top bar with `⌘K`
  search, grouped sidebar, right-hand "On this page" rail, code tabs with copy,
  responsive and themeable (dark default).

## Source layout

```
src/
  main.tsx        React root
  App.tsx         shell: routing, sidebar, TOC, command-palette search, theme
  ui.tsx          shared blocks: Doc, Section, P, CodeTabs, Table, Callout, Api…
  nav.ts          25 page slugs, EN/AR titles, descriptions, keywords
  registry.ts     lazy page imports
  styles.css      design tokens, light/dark themes, RTL, responsive rules
  pages/en/*.tsx  English content
  pages/ar/*.tsx  Arabic content
```

Content lives under `src/pages/` (EN) with Arabic mirrors.
for the primitive API, the facts that may be relied on and the quality bar.
Facts come from `AGENTS.md`, the numbered `docs/*.md` specifications and the
actual source under `apps/api/src` and `packages/*` — never from the retired
static HTML generator.

## Commands

```sh
corepack pnpm --filter @vellum/docs dev        # Vite dev on :5175, base /docs/
corepack pnpm --filter @vellum/docs typecheck
corepack pnpm --filter @vellum/docs lint
corepack pnpm --filter @vellum/docs build
corepack pnpm qa:docs                         # browser QA against :3000 gateway
```

`dist/` is a generated artifact and is not committed.
