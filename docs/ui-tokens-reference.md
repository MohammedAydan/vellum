# UI Token Reference — `@vellum/ui`

**Canonical Source:** `packages/ui/src/theme.css`
**Entry Point:** `packages/ui/src/index.css` (also `@vellum/ui/tokens` for apps that own Tailwind)
**Theme:** the **official shadcn/ui default theme**, `neutral` base colour, `base-nova` style — used verbatim from <https://ui.shadcn.com/docs/theming>.
**Colour Space:** OKLCH (as published by shadcn).

> The previous custom indigo/violet design system and its 11-stop brand ramps were removed. A small "compatibility aliases" block in `theme.css` maps  (`--surface`, `--success`, `--chart-6`, …) onto the official tokens so existing utilities keep resolving. It introduces no new design decisions.

---

## 1. Official Semantic Tokens

| Token | Light (`:root`) | Dark (`.dark`) | Used by |
| :--- | :--- | :--- | :--- |
| `--background` | `oklch(1 0 0)` | `oklch(0.145 0 0)` | Page shell |
| `--foreground` | `oklch(0.145 0 0)` | `oklch(0.985 0 0)` | Default text |
| `--card` / `--card-foreground` | `oklch(1 0 0)` / `oklch(0.145 0 0)` | `oklch(0.205 0 0)` / `oklch(0.985 0 0)` | Cards, dashboard panels |
| `--popover` / `--popover-foreground` | `oklch(1 0 0)` / `oklch(0.145 0 0)` | `oklch(0.205 0 0)` / `oklch(0.985 0 0)` | Menus, overlays |
| `--primary` / `--primary-foreground` | `oklch(0.205 0 0)` / `oklch(0.985 0 0)` | `oklch(0.922 0 0)` / `oklch(0.205 0 0)` | Default button, active accents |
| `--secondary` / `--secondary-foreground` | `oklch(0.97 0 0)` / `oklch(0.205 0 0)` | `oklch(0.269 0 0)` / `oklch(0.985 0 0)` | Secondary buttons |
| `--muted` / `--muted-foreground` | `oklch(0.97 0 0)` / `oklch(0.556 0 0)` | `oklch(0.269 0 0)` / `oklch(0.708 0 0)` | Helper text, subdued surfaces |
| `--accent` / `--accent-foreground` | `oklch(0.97 0 0)` / `oklch(0.205 0 0)` | `oklch(0.269 0 0)` / `oklch(0.985 0 0)` | Hover / selected states |
| `--destructive` | `oklch(0.577 0.245 27.325)` | `oklch(0.704 0.191 22.216)` | Destructive actions |
| `--border` | `oklch(0.922 0 0)` | `oklch(1 0 0 / 10%)` | Borders, dividers |
| `--input` | `oklch(0.922 0 0)` | `oklch(1 0 0 / 15%)` | Form control borders |
| `--ring` | `oklch(0.708 0 0)` | `oklch(0.556 0 0)` | Focus rings |
| `--sidebar` / `--sidebar-foreground` | `oklch(0.985 0 0)` / `oklch(0.145 0 0)` | `oklch(0.205 0 0)` / `oklch(0.985 0 0)` | Sidebar surface |
| `--sidebar-primary` | `oklch(0.205 0 0)` | `oklch(0.488 0.243 264.376)` | Sidebar active accents |
| `--sidebar-accent` | `oklch(0.97 0 0)` | `oklch(0.269 0 0)` | Sidebar hover |

`--destructive-foreground` and all `--surface-*`, `--subtle-foreground`, `--border-strong`, `--success`, `--warning`, `--info`, `--chart-6`, `--neutral-*`, `--brand-*` and `*-50…950` ramps are compatibility aliases only.

---

## 2. Chart Series (official shadcn palette)

| Token | Light | Dark |
| :--- | :--- | :--- |
| `--chart-1` | `oklch(0.646 0.222 41.116)` | `oklch(0.488 0.243 264.376)` |
| `--chart-2` | `oklch(0.6 0.118 184.704)` | `oklch(0.696 0.17 162.48)` |
| `--chart-3` | `oklch(0.398 0.07 227.392)` | `oklch(0.769 0.188 70.08)` |
| `--chart-4` | `oklch(0.828 0.189 84.429)` | `oklch(0.627 0.265 303.9)` |
| `--chart-5` | `oklch(0.769 0.188 70.08)` | `oklch(0.645 0.246 16.439)` |

---

## 3. Radius Scale (official)

`--radius: 0.625rem` is the single source; every step is derived in `@theme inline`:

| Token | Value |
| :--- | :--- |
| `--radius-sm` | `calc(var(--radius) * 0.6)` = `0.375rem` |
| `--radius-md` | `calc(var(--radius) * 0.8)` = `0.5rem` |
| `--radius-lg` | `var(--radius)` = `0.625rem` |
| `--radius-xl` | `calc(var(--radius) * 1.4)` = `0.875rem` |
| `--radius-2xl` | `calc(var(--radius) * 1.8)` = `1.125rem` |
| `--radius-3xl` | `calc(var(--radius) * 2.2)` = `1.375rem` |
| `--radius-4xl` | `calc(var(--radius) * 2.6)` = `1.625rem` |

---

## 4. Typography

Tailwind's default type scale is used (no custom `text-sm`/`text-base` overrides). Only `--font-sans`, `--font-mono`, `--font-display`, `text-2xs` and `text-md` remain as small compatibility utilities used by dense developer-console tables.

---

## 5. Verification

```bash
corepack pnpm --filter @vellum/dashboard build   # emits the official tokens
node scripts/visual-shadcn-default.mjs          # real-browser screenshots + computed-style probe
```

Expected probe output in dark mode: `bodyBg=oklch(0.145 0 0)`, `bodyColor=oklch(0.985 0 0)`, `radius=.625rem`.
