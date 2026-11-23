import * as React from "react";
import { Menu, X, Moon, Sun, Monitor, Search, type LucideIcon } from "lucide-react";
import { cn } from "../lib/cn.js";
import { Button } from "../components/button.js";
import { Input } from "../components/input.js";
import { Separator } from "../components/separator.js";
import { Skeleton } from "../components/skeleton.js";
import { useTheme } from "../hooks/use-theme.js";
import { useDirection } from "@radix-ui/react-direction";
import { useI18n } from "../i18n/index.js";

/** Close control for the mobile drawer. It lives in its own component so this
 *  framework-agnostic primitive only reaches for i18n while the drawer is open. */
function DrawerCloseButton({ onClose }: { onClose: () => void }) {
  const { t } = useI18n();
  const translated = t("common.closeMenu");
  // Apps that do not own this key (e.g. the admin shell) get a stable English
  // fallback instead of the raw i18n key as the accessible name.
  const label = translated === "common.closeMenu" ? "Close menu" : translated;
  return (
    <Button
      type="button"
      variant="ghost"
      size="icon"
      className="size-9 text-muted-foreground hover:text-foreground"
      onClick={onClose}
      aria-label={label}
    >
      <X className="size-5" aria-hidden="true" />
    </Button>
  );
}

export interface AppShellProps extends React.HTMLAttributes<HTMLDivElement> {
  sidebar?: React.ReactNode;
  topbar?: React.ReactNode;
  mobileOpen?: boolean;
  onMobileClose?: () => void;
  collapsed?: boolean;
}

export function AppShell({
  sidebar,
  topbar,
  mobileOpen = false,
  onMobileClose,
  collapsed = false,
  className,
  children,
  ...props
}: AppShellProps) {
  const direction = useDirection();
  const drawerRef = React.useRef<HTMLDivElement>(null);

  // Every close path (close control, backdrop, Escape) restores focus to the
  // topbar menu button that opened the drawer — including touch, where the
  // trigger is not necessarily document.activeElement after a tap.
  const handleClose = React.useCallback(() => {
    onMobileClose?.();
    document.querySelector<HTMLElement>("[data-vellum-menu-trigger]")?.focus();
  }, [onMobileClose]);

  React.useEffect(() => {
    if (!mobileOpen) return;
    drawerRef.current?.querySelector<HTMLElement>('button, a[href], [tabindex="0"]')?.focus();
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") handleClose();
      if (e.key === "Tab") {
        const items = Array.from(drawerRef.current?.querySelectorAll<HTMLElement>('button:not(:disabled), a[href], [tabindex="0"]') ?? []).filter(el => el.getClientRects().length > 0);
        const first = items[0], last = items[items.length - 1];
        if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last?.focus(); }
        else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first?.focus(); }
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [mobileOpen, handleClose]);

  return (
    // The shell owns the viewport. Without a definite height + a flex column
    // whose body is `min-h-0 flex-1 overflow-y-auto`, the DOCUMENT scrolls
    // instead of the content pane — which drags the fixed sidebar and sticky
    // topbar out of view and detaches popovers from their triggers.
    <div className={cn("flex h-dvh min-h-0 flex-col overflow-hidden bg-background text-foreground", className)} {...props}>
      {/* Desktop Sidebar */}
      <div className="hidden md:block">
        {sidebar}
      </div>

      {/* Mobile drawer. The outer class list is a QA hook — keep it stable. */}
      {mobileOpen ? (
        <div
          ref={drawerRef}
          role="dialog"
          aria-modal="true"
          aria-label="Navigation"
          className="fixed inset-0 z-50 md:hidden"
          onKeyDown={(e) => {
            if (e.key === "Escape") handleClose();
          }}
        >
          <div
            className="fixed inset-0 bg-black/60 backdrop-blur-xs transition-opacity animate-in fade-in-0 duration-200"
            onClick={handleClose}
            aria-hidden="true"
          />
          <div className="fixed inset-y-0 start-0 z-50 w-72 max-w-[85vw] overflow-y-auto border-e border-border bg-card p-4 shadow-2xl animate-in slide-in-from-left duration-200">
            {/* Above the cloned sidebar (z-30) so the control stays tappable. */}
            <div className="absolute end-2 top-2 z-40">
              <DrawerCloseButton onClose={handleClose} />
            </div>
            {/* Sidebar's base `hidden md:block` must be overridden in the
                drawer copy, otherwise the duplicated node renders 0×0. */}
            {React.isValidElement<{ className?: string }>(sidebar)
              ? React.cloneElement(sidebar, {
                  className: cn("block md:block", sidebar.props.className),
                })
              : sidebar}
          </div>
        </div>
      ) : null}

      {/* Main Content Area */}
      {/* The offset must match the sidebar width exactly (ConsoleShell uses
          w-60 / w-12). Keeping it here — and ONLY here — avoids the double
          gutter that made every page look detached from the topbar/sidebar. */}
      <div className={cn("flex min-h-0 min-w-0 flex-1 flex-col", collapsed ? "md:ms-12" : "md:ms-60")}>
        {topbar}
        {/* Browsers place a vertical scrollbar according to `direction`, so in
            RTL it ended up on the far-left edge of the viewport, opposite the
            right-hand sidebar. Keep LTR on the scroll container so the bar
            sits on the right (next to the sidebar) and restore RTL on the
            inner wrapper so all page content still reads right-to-left. */}
        <main dir="ltr" className="mx-auto min-h-0 w-full max-w-[1600px] flex-1 overflow-y-auto px-3 py-4 sm:px-6 sm:py-6 lg:px-8">
          <div dir={direction} className="min-h-full">{children}</div>
        </main>
      </div>
    </div>
  );
}

export interface SidebarProps extends React.HTMLAttributes<HTMLElement> {
  collapsed?: boolean;
  children?: React.ReactNode;
}
export function Sidebar({ collapsed = false, className, children, ...props }: SidebarProps) {
  return (
    <aside
      className={cn(
        "fixed inset-y-0 start-0 z-30 hidden w-64 border-e border-border bg-sidebar px-3 py-4 transition-all duration-200 md:block",
        collapsed && "w-12",
        className
      )}
      {...props}
    >
      {children}
    </aside>
  );
}

export interface SidebarSectionProps extends React.HTMLAttributes<HTMLDivElement> { label?: string }
export function SidebarSection({ label, className, children, ...props }: SidebarSectionProps) {
  return <div className={cn("mb-6 space-y-1", className)} {...props}>{label ? <p className="px-3 pb-2 text-2xs font-semibold uppercase tracking-wider text-muted-foreground">{label}</p> : null}{children}</div>;
}

export interface SidebarItemProps extends React.ButtonHTMLAttributes<HTMLButtonElement> { icon?: React.ReactNode; badge?: React.ReactNode; active?: boolean }
export function SidebarItem({ icon, badge, active = false, className, children, ...props }: SidebarItemProps) {
  // 30px rows, quiet neutral active state with a 2px accent bar on the
  // inline-start edge — the single accent use for active navigation.
  return <button type="button" className={cn("relative flex w-full items-center gap-2 rounded-md px-3 py-1.5 text-start text-sm text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring", active && "bg-accent font-medium text-foreground before:absolute before:inset-y-1.5 before:start-0 before:w-0.5 before:rounded-full before:bg-primary", className)} {...props}>{icon}<span className="min-w-0 flex-1 truncate">{children}</span>{badge}</button>;
}

export interface TopbarProps extends React.HTMLAttributes<HTMLElement> { breadcrumbs?: React.ReactNode; actions?: React.ReactNode; onMenuClick?: () => void }
export function Topbar({ breadcrumbs, actions, onMenuClick, className, ...props }: TopbarProps) {
  return (
    <header
      className={cn(
        "sticky top-0 z-20 flex h-12 items-center gap-2 border-b border-border bg-background/95 px-3 backdrop-blur sm:gap-3 sm:px-6",
        className
      )}
      {...props}
    >
      <Button
        variant="ghost"
        size="icon"
        className="size-9 shrink-0 text-muted-foreground hover:text-foreground md:hidden"
        onClick={onMenuClick}
        aria-label="Toggle navigation menu"
        data-vellum-menu-trigger
      >
        <Menu className="size-5" />
      </Button>
      <div className="min-w-0 flex-1 truncate">{breadcrumbs}</div>
      <div className="flex shrink-0 items-center gap-1.5 sm:gap-2">{actions}</div>
    </header>
  );
}

export interface PageHeaderProps extends React.HTMLAttributes<HTMLDivElement> { title: string; description?: string; actions?: React.ReactNode; eyebrow?: string }
export function PageHeader({ title, description, actions, eyebrow, className, ...props }: PageHeaderProps) {
  return <div className={cn("mb-6 flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between", className)} {...props}><div className="min-w-0">{eyebrow ? <p className="mb-1 text-2xs font-medium uppercase tracking-wider text-muted-foreground">{eyebrow}</p> : null}<h1 className="text-xl font-semibold tracking-tight">{title}</h1>{description ? <p className="mt-1 max-w-2xl text-sm text-muted-foreground">{description}</p> : null}</div>{actions ? <div className="flex shrink-0 items-center gap-2">{actions}</div> : null}</div>;
}

export function PageContent({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) { return <div className={cn("space-y-6", className)} {...props} />; }

export interface KpiMetricCardProps extends React.HTMLAttributes<HTMLDivElement> {
  label: string;
  value: React.ReactNode;
  delta?: React.ReactNode;
  trend?: "up" | "down" | "neutral";
  icon?: LucideIcon | React.ReactNode;
  description?: string;
  loading?: boolean;
  /** Render metric text with tabular numerals (default: true). */
  tabularNums?: boolean;
}

/** Backwards-compatible alias — `StatCard` is the original KPI surface. */
export type StatCardProps = KpiMetricCardProps;

export function StatCard({
  label,
  value,
  delta,
  trend = "neutral",
  icon,
  description,
  loading = false,
  tabularNums = true,
  className,
  ...props
}: StatCardProps) {
  const isNode =
    React.isValidElement(icon) ||
    typeof icon === "string" ||
    typeof icon === "number" ||
    typeof icon === "boolean" ||
    Array.isArray(icon) ||
    icon === null ||
    icon === undefined;
  const Icon = !isNode ? (icon as LucideIcon) : null;
  return (
    <div className={cn("rounded-lg border border-border bg-surface p-4", className)} {...props}>
      <div className="flex items-start justify-between gap-2">
        <p className="text-sm text-muted-foreground">{label}</p>
        {icon ? (
          <span className="shrink-0 text-muted-foreground">
            {Icon ? <Icon className="size-4" aria-hidden="true" /> : (icon as React.ReactNode)}
          </span>
        ) : null}
      </div>
      {loading ? (
        <div className="mt-2 space-y-2">
          <Skeleton className="h-8 w-24" />
          {description ? <Skeleton className="h-3 w-32" /> : null}
        </div>
      ) : (
        <>
          <p className={cn("mt-2 text-2xl font-semibold tracking-tight", tabularNums && "tabular-nums")}>{value}</p>
          {description ? <p className="mt-1 text-xs text-muted-foreground">{description}</p> : null}
          {delta ? (
            <p className={cn("mt-2 text-xs", trend === "up" && "text-success", trend === "down" && "text-destructive", trend === "neutral" && "text-muted-foreground")}>{delta}</p>
          ) : null}
        </>
      )}
    </div>
  );
}

/** Canonical name for the KPI card; `StatCard` remains as an alias. */
export const KpiMetricCard = StatCard;

export function KpiRow({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) { return <div className={cn("grid gap-4 sm:grid-cols-2 lg:grid-cols-4", className)} {...props} />; }

export interface ThemeToggleProps { className?: string; showLabel?: boolean }

export function ThemeToggle({ className, showLabel = false }: ThemeToggleProps) {
  const { theme, setTheme } = useTheme();
  const next = theme === "dark" ? "light" : theme === "light" ? "system" : "dark";
  return (
    <Button
      variant="outline"
      size="icon"
      className={cn(showLabel && "w-auto gap-1.5 px-2.5", className)}
      onClick={() => setTheme(next)}
      aria-label={`Switch theme (current: ${theme})`}
    >
      {theme === "dark" ? <Moon className="size-4" /> : theme === "light" ? <Sun className="size-4" /> : <Monitor className="size-4" />}
      {showLabel ? <span className="text-xs">{theme === "dark" ? "Dark" : theme === "light" ? "Light" : "System"}</span> : null}
    </Button>
  );
}

export function SearchField({ className, ...props }: React.ComponentProps<typeof Input>) { return <div className="relative"><Search className="pointer-events-none absolute start-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" /><Input className={cn("ps-9", className)} {...props} /></div>; }

export function Divider() { return <Separator className="my-4" />; }
