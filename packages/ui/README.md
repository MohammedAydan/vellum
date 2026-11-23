# `@vellum/ui` — World-Class Design System & Component Library

A high-performance, accessible, and extensible React 19 UI component library tailored for multi-tenant database platforms and cloud SaaS applications. Inspired by Firebase Console, Supabase Studio, Vercel Dashboard, and Linear.

---

## Highlights

- **Framework & Engine:** Built on React 19, TypeScript 5.9 (`strict: true`, `noUncheckedIndexedAccess: true`), Tailwind CSS 4 (`@theme inline`), and accessible Radix UI primitives.
- **Official shadcn/ui Default Theme:** The `neutral` base colour, `base-nova` component style and token values are taken verbatim from <https://ui.shadcn.com/docs/theming> — no custom design overrides. Legacy Vellum token names remain as compatibility aliases only.
- **RTL by Design:** Standardized CSS logical properties (`ps-*`, `pe-*`, `ms-*`, `me-*`, `border-inline-*`, `inset-inline-*`) for complete bi-directional and RTL layout support.
- **Zero Technical Debt:** Zero `any` types, zero `@ts-ignore`, 100% typechecked, 100% lint-clean, vitest validated.
- **Full Storybook Showcase:** Pre-configured with Storybook 9 + Vite 6 for rapid component development and isolated visual testing.

---

## Getting Started

### Installation

```bash
pnpm add @vellum/ui
```

### 1. Global CSS Import

Import `@vellum/ui/styles` once at your application root (e.g., `layout.tsx` or `_app.tsx`):

```tsx
import "@vellum/ui/styles";
```

### 2. Theme Provider

Wrap your application in `ThemeProvider` to support dark mode, light mode, and system preference detection:

```tsx
import { ThemeProvider } from "@vellum/ui";

export function App({ children }: { children: React.ReactNode }) {
  return (
    <ThemeProvider attribute="class" defaultTheme="system" enableSystem>
      {children}
    </ThemeProvider>
  );
}
```

---

## Component Catalog

### 1. Foundation Primitives
| Category | Components |
| :--- | :--- |
| **Actions** | `Button`, `Toggle`, `ToggleGroup` |
| **Form & Inputs** | `Input`, `Textarea`, `Select`, `Checkbox`, `RadioGroup`, `RadioGroupItem`, `Switch`, `Slider`, `Label`, `Form`, `FormField`, `useFormField`, `DatePicker` |
| **Surfaces & Layout** | `Card`, `Separator`, `ScrollArea`, `ResizablePanelGroup`, `ResizablePanel`, `ResizableHandle`, `AspectRatio` |
| **Overlays & Dialogs** | `Dialog`, `Sheet`, `AlertDialog`, `Drawer`, `Popover`, `HoverCard`, `Tooltip` |
| **Navigation & Menus** | `DropdownMenu`, `ContextMenu`, `Menubar`, `NavigationMenu`, `Breadcrumb`, `Pagination` |
| **Feedback & Status** | `Alert`, `Skeleton`, `Progress`, `Spinner`, `Sonner` (`Toaster`), `Badge`, `Avatar` |
| **Data & Code** | `Table`, `Tabs`, `Accordion`, `Collapsible`, `Calendar`, `Command` (cmdk), `Carousel`, `CodeEditor` (CodeMirror 6), `JsonViewer` |

### 2. Composed Primitives
- **`AppShell` / `Sidebar` / `Topbar` / `PageHeader` / `PageContent`:** Complete responsive layout shell with collapsible sidebar navigation, breadcrumbs, and actions.
- **`DataGrid`:** Enterprise table wrapper powered by `@tanstack/react-table` with virtualization, sorting, column visibility, and row selection.
- **`ConfirmDialog`:** Accessible confirmation modal for destructive operations (e.g., project deletion, index drops).
- **`StatCard` / `KpiRow`:** Metrics display with percentage trends, semantic status colors, and micro-sparklines.
- **`PropertyList` / `KeyValueList`:** Dense metadata displays for document attributes and tenant configs.
- **`TimestampDisplay`:** Dual-mode timestamp component with relative distance ("5m ago") and ISO 8601 tooltip.
- **`TruncatedText` / `CopyButton`:** Monospace string truncator with one-click clipboard copying.
- **`CommandPalette`:** `Cmd+K` global quick launcher with keyboard shortcuts and search groups.
- **`FieldTypeBadge`:** Color-coded badges for all Vellum Tagged Wire Format types (`string`, `number`, `boolean`, `int64`, `timestamp`, `ref`, `geo`, `bytes`, `map`, `array`).
- **`BadgeGroup`:** Overflow-aware pill group with "+N more" tooltip popovers.
- **`EmptyState` / `ErrorState` / `LoadingState`:** Standardized empty and error fallbacks with retry actions.

### 3. Domain-Specific Database Components
- **`DocumentTree`:** Hierarchical collection and document browser with real-time expand/collapse and count badges.
- **`DocumentCard`:** Summary card for documents with field previews, version chip, and contextual actions.
- **`QueryBuilderGroup` / `QueryBuilderRow` / `OrderByRow`:** Interactive visual query builder supporting composite filters and multi-property ordering.
- **`RulesEditor` / `RulesSimulator`:** CodeMirror-based JSON AST security rules editor and real-time AST authorization simulator.
- **`IndexFieldsRow`:** Drag-reorderable composite index field definition row (field path + ASC/DESC order).
- **`ApiKeyCard` / `ApiKeyRevealDialog`:** Platform API key lifecycle card with secret key reveal modal.
- **`UsageChart`:** Recharts wrapper themed with OKLCH chart series tokens (`--chart-1` to `--chart-6`).
- **`QuotaBar`:** Multi-threshold progress bar for tenant resource limits (reads, writes, storage, connections).
- **`ClusterHealthCard`:** Subsystem health monitor (Control DB, Data DB, Outbox lag).
- **`AuditLogRow`:** Immutable audit log event viewer with actor metadata and status indicators.
- **`TenantCard`:** Admin overview card for platform organizations and tiers.

---

## Verification & Scripts

```bash
# Compile TypeScript declaration files
pnpm --filter @vellum/ui build

# Verify type safety
pnpm --filter @vellum/ui typecheck

# Run ESLint
pnpm --filter @vellum/ui lint

# Run unit tests with Vitest
pnpm --filter @vellum/ui test

# Build production Storybook bundle
pnpm --filter @vellum/ui storybook:build
```
