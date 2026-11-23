# `@vellum/ui` — Design System & Component Library Architecture

**Version:** 2.0 (Phase 5 Production-Ready Design System)
**Package:** `@vellum/ui`
**Dependencies:** React 19, Tailwind CSS 4, Radix UI Primitives, Lucide React, CodeMirror 6, Recharts, TanStack Table, Vaul, Embla Carousel.

---

## 1. Architectural Blueprint & Philosophy

`@vellum/ui` is the central design system and UI component library for the Document Database SaaS platform. It powers both customer-facing applications (`apps/dashboard`) and operator tools (`apps/admin`).

The system is designed with five foundational pillars:
1. **Developer Experience Inspired by Industry Leaders:** High aesthetic polish and density inspired by Vercel Dashboard, Supabase Studio, Firebase Console, and Linear.
2. **Official shadcn/ui Default Theme (Tailwind 4 + OKLCH):** `packages/ui/src/theme.css` contains the verbatim `neutral` / `base-nova` default theme from <https://ui.shadcn.com/docs/theming> — token values, radius scale and `@theme inline` mapping are not customised. Legacy VELLUM token names survive only as compatibility aliases. Zero hardcoded hex colours in component source.
3. **Radix Primitives & Accessibility First:** Accessible ARIA roles, full keyboard navigation (`Tab`, arrow keys, `Cmd+K`), focus visible rings, and automatic reduced motion respect.
4. **Bi-Directional RTL Support:** Built strictly using CSS logical properties (`ps-*`, `pe-*`, `ms-*`, `me-*`, `border-inline-*`, `start-*`, `end-*`), eliminating layout flips for RTL locales.
5. **Domain-Driven SaaS Components:** Ready-to-use compositions specifically tailored for document database workflows: hierarchical document trees, visual query builders, security rules simulator, composite index creators, and cluster health monitors.

```text
packages/ui/
├── src/
│   ├── components/         # 44 Atomic Radix & Shadcn Foundation Primitives
│   │   ├── button.tsx, input.tsx, textarea.tsx, select.tsx, checkbox.tsx
│   │   ├── radio-group.tsx, switch.tsx, slider.tsx, label.tsx, form.tsx
│   │   ├── card.tsx, separator.tsx, scroll-area.tsx, resizable.tsx, aspect-ratio.tsx
│   │   ├── dialog.tsx, sheet.tsx, alert-dialog.tsx, drawer.tsx, popover.tsx
│   │   ├── hover-card.tsx, tooltip.tsx, dropdown-menu.tsx, context-menu.tsx
│   │   ├── menubar.tsx, navigation-menu.tsx, alert.tsx, skeleton.tsx, progress.tsx
│   │   ├── spinner.tsx, sonner.tsx, badge.tsx, avatar.tsx, calendar.tsx
│   │   ├── date-picker.tsx, table.tsx, tabs.tsx, accordion.tsx, collapsible.tsx
│   │   ├── toggle.tsx, toggle-group.tsx, breadcrumb.tsx, pagination.tsx
│   │   ├── command.tsx, carousel.tsx, code-editor.tsx, json-viewer.tsx
│   │   └── theme-provider.tsx
│   ├── primitives/         # 13 Composed High-Level Application Primitives
│   │   ├── app-shell.tsx (AppShell, Sidebar, Topbar, PageHeader, PageContent, StatCard, KpiRow, ThemeToggle)
│   │   ├── data-grid.tsx, confirm-dialog.tsx, property-list.tsx, timestamp-display.tsx
│   │   ├── truncated-text.tsx, command-palette.tsx, badge-group.tsx, copy-button.tsx
│   │   ├── empty-state.tsx, loading-state.tsx, error-state.tsx, field-badge.tsx
│   ├── domain/             # 12 Database SaaS Domain Components
│   │   ├── document-tree.tsx, document-card.tsx, query-builder.tsx
│   │   ├── rules-editor.tsx (RulesEditor, RulesSimulator), index-fields-row.tsx
│   │   ├── api-key.tsx (ApiKeyCard, ApiKeyRevealDialog), usage-chart.tsx
│   │   ├── quota-bar.tsx, cluster-health.tsx, audit-log.tsx
│   │   ├── tenant-card.tsx, project-context.tsx
│   ├── tokens/             # Canonical OKLCH Design Tokens
│   │   ├── theme.css (Light/Dark ramps, semantic roles, @theme mappings)
│   │   ├── base.css (Global resets, focus rings, reduced motion, CM6 & Recharts overrides)
│   │   ├── colors.css, typography.css, spacing.css
│   ├── hooks/              # useTheme, useToast, useMediaQuery
│   ├── lib/                # cn (clsx + tailwind-merge)
│   ├── ui.stories.tsx      # Comprehensive Storybook 9 Showcase
│   └── __tests__/          # Vitest Unit & Export Verification Suite
```

---

## 2. Design Tokens & Styling Architecture

The design token system is separated into three tiers:

1. **Primitive Scales (11 stops):**
   - Neutral (`--neutral-50` to `--neutral-950`): Cool slate with hue 275 and low chroma.
   - Brand (`--brand-50` to `--brand-950`): Deep indigo-violet with hue 274.
   - Semantic Statuses: Emerald (`--success-*`), Amber (`--warning-*`), Red (`--danger-*`), Sky (`--info-*`).
2. **Semantic Role Tokens:**
   - Evaluated dynamically in `:root` and overridden in `.dark`:
     `--background`, `--foreground`, `--surface`, `--surface-raised`, `--surface-sunken`, `--surface-overlay`, `--muted`, `--muted-foreground`, `--border`, `--border-strong`, `--input`, `--ring`, `--primary`, `--secondary`, `--accent`, `--destructive`, `--success`, `--warning`, `--info`.
3. **Tailwind CSS 4 Inline Theme Mapping:**
   - Using `@theme inline`, Tailwind maps `--color-*` to CSS custom property references. This allows instant runtime theme swapping without re-evaluating or regenerating CSS stylesheets.

---

## 3. High-Level Composed Primitives

### 3.1 `AppShell`
Responsive application shell designed for modern SaaS dashboards:
- Fixed collapsible sidebar with semantic section headers and navigation items.
- Topbar with sticky positioning, mobile drawer trigger, breadcrumb navigation, project context display (the former project switcher now shows only the project), and theme toggle.
- Constrained main content container (`max-w-[1600px]`) with standardized vertical rhythm (`space-y-6`).

### 3.2 `DataGrid`
A virtualization-ready data table built on `@tanstack/react-table`:
- Automatic column sorting with visual direction indicators.
- Client-side pagination with selectable page sizes.
- Single and multi-row selection with checkbox integration.
- Deterministic click handlers for drawer inspection.

### 3.3 `ConfirmDialog`
A high-trust destructive action modal built on `AlertDialog`:
- Asynchronous confirmation handler supporting promise-based loading states with embedded spinner.
- Destructive and default visual variants.

### 3.4 `CodeEditor` & `JsonViewer`
- `CodeEditor`: CodeMirror 6 with `@codemirror/lang-json`, syntax highlighting matching design tokens, line numbers, and theme auto-synchronization.
- `JsonViewer`: Collapsible, interactive JSON tree viewer with color-coded primitives and one-click copy.

---

## 4. Domain-Specific Database SaaS Components

### 4.1 Document Explorer (`DocumentTree` & `DocumentCard`)
- **`DocumentTree`:** Recursive tree representing nested collections and subcollections (e.g. `users/usr_01/orders/ord_99`). Supports document count chips, active node highlight, and inline "+ Add Document" buttons.
- **`DocumentCard`:** Dense document preview showing ID, path, version (`v1`, `v2`), update timestamp, and field badges.

### 4.2 Query Engine (`QueryBuilderGroup`, `QueryBuilderRow`, `OrderByRow`)
- Visual filter construction supporting all VELLUM operations: `==`, `!=`, `<`, `<=`, `>`, `>=`, `in`, `not-in`, `array-contains`, `array-contains-any`.
- Multi-property sorting with directional toggle (`ASC` / `DESC`).
- Limits enforcement (maximum 10 filter clauses, maximum 3 order by fields).

### 4.3 Security Rules (`RulesEditor` & `RulesSimulator`)
- **`RulesEditor`:** Specialized JSON AST rules editor with syntax validation and instant format action.
- **`RulesSimulator`:** In-memory simulation interface to test security rules against mock auth contexts (`auth.uid`, `auth.token.role`) and target document paths. Returns instantaneous ALLOW / DENY decisions with evaluation duration and node execution traces.

### 4.4 Index Definition (`IndexFieldsRow`)
- Interactive definition row for tenant composite indexes stored in `document_index_entries`.
- Configures field path and sort direction (`ASC` / `DESC`) with drag handles and deletion affordances.

### 4.5 Observability & Quotas (`UsageChart`, `QuotaBar`, `ClusterHealthCard`, `AuditLogRow`)
- **`UsageChart`:** Responsive Recharts wrapper with SVG gradient fills mapped to CSS OKLCH tokens (`--color-chart-1` to `--color-chart-6`).
- **`QuotaBar`:** Visual meter that automatically transitions between primary, warning (amber >= 75%), and danger (red >= 90%) thresholds.
- **`ClusterHealthCard`:** Platform health dashboard inspecting Control Plane DB, Data Plane Neon RLS, Redis broker, and outbox poller lag.
- **`AuditLogRow`:** Immutable audit trail component displaying timestamp, actor type (`user` or `api_key`), target resource, IP address, and status badge.

---

## 5. Quality & Verification Standards

`@vellum/ui` complies with strict CI quality gates:
- **Build:** `pnpm --filter @vellum/ui build` compiles cleanly into `dist/` with `.d.ts` types.
- **Typecheck:** `pnpm --filter @vellum/ui typecheck` runs TypeScript in strict mode with 0 errors.
- **Lint:** `pnpm --filter @vellum/ui lint` runs ESLint 9 with 0 errors and 0 warnings.
- **Test:** Vitest verifies component utilities, semantic variants, and 100% of exported symbols.
- **Storybook:** Storybook 9 builds standalone production bundles (`storybook-static`) with zero unresolved dependencies.
