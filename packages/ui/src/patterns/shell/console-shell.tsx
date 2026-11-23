import * as React from "react";
import { PanelLeft } from "lucide-react";
import { useDirection } from "@radix-ui/react-direction";
import { cn } from "../../lib/cn.js";
import { Button } from "../../components/button.js";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "../../components/tooltip.js";
import {
  AppShell,
  Sidebar,
  SidebarItem,
  SidebarSection,
  Topbar,
} from "../../primitives/app-shell.js";

/** A single navigation entry in a {@link ConsoleNavSection}. */
export interface ConsoleNavItem {
  id: string;
  label: string;
  icon?: React.ReactNode;
  href?: string;
  onSelect?: () => void;
  badge?: string | number;
  disabled?: boolean;
}

/** A labelled group of navigation entries. */
export interface ConsoleNavSection {
  id: string;
  label?: string;
  items: ConsoleNavItem[];
}

export interface ConsoleShellProps {
  children: React.ReactNode;
  navSections: ConsoleNavSection[];
  activeNavId?: string;
  onNavigate?: (id: string, href?: string) => void;
  sidebarHeader?: React.ReactNode;
  /** Compact, icon-only header used when the sidebar is collapsed. */
  sidebarHeaderCollapsed?: React.ReactNode;
  sidebarFooter?: React.ReactNode;
  topbarStart?: React.ReactNode;
  topbarEnd?: React.ReactNode;
  accentBanner?: { tone: "amber" | "red"; label: string };
  collapsed?: boolean;
  defaultCollapsed?: boolean;
  /**
   * localStorage key used to persist the collapse state across navigations
   * and reloads (F2). Pass a distinct key per app surface; `false` disables
   * persistence. Defaults to the shared console key.
   */
  collapseStorageKey?: string | false;
  className?: string;
}

const DEFAULT_COLLAPSE_STORAGE_KEY = "vellum:sidebar-collapsed";

function readPersistedCollapsed(key: string | false, fallback: boolean): boolean {
  if (key === false) return fallback;
  try {
    if (typeof window === "undefined") return fallback;
    const raw = window.localStorage.getItem(key);
    if (raw === null) return fallback;
    return raw === "1";
  } catch {
    return fallback;
  }
}

/**
 * Canonical console application shell.
 *
 * Composes the existing `AppShell` / `Sidebar` / `Topbar` primitives so every
 * QA hook they emit (mobile drawer `role=dialog`, `.fixed.inset-0.z-50.md:hidden`,
 * `aria-label="Toggle navigation menu"`, …) stays byte-for-byte stable.
 */
export function ConsoleShell({
  children,
  navSections,
  activeNavId,
  onNavigate,
  sidebarHeader,
  sidebarHeaderCollapsed,
  sidebarFooter,
  topbarStart,
  topbarEnd,
  accentBanner,
  collapsed,
  defaultCollapsed = false,
  collapseStorageKey = DEFAULT_COLLAPSE_STORAGE_KEY,
  className,
}: ConsoleShellProps): React.JSX.Element {
  const direction = useDirection();
  const [mobileOpen, setMobileOpen] = React.useState(false);
  const [internalCollapsed, setInternalCollapsed] = React.useState(() =>
    readPersistedCollapsed(collapseStorageKey, defaultCollapsed)
  );
  const isCollapsed = collapsed ?? internalCollapsed;

  const toggleCollapsed = React.useCallback((): void => {
    setInternalCollapsed((value) => {
      const next = !value;
      if (collapseStorageKey !== false) {
        try {
          window.localStorage.setItem(collapseStorageKey, next ? "1" : "0");
        } catch {
          /* Storage unavailable (private mode, SSR) — state still toggles. */
        }
      }
      return next;
    });
  }, [collapseStorageKey]);

  const closeMobile = React.useCallback((): void => {
    setMobileOpen(false);
  }, []);

  const renderItem = (item: ConsoleNavItem): React.ReactNode => {
    const active = activeNavId === item.id;
    const node = (
      <SidebarItem
        icon={item.icon}
        badge={isCollapsed ? undefined : item.badge}
        active={active}
        disabled={item.disabled ?? false}
        title={isCollapsed ? item.label : undefined}
        aria-current={active ? "page" : undefined}
        className={isCollapsed ? "justify-center px-0 before:start-0" : undefined}
        onClick={() => {
          item.onSelect?.();
          onNavigate?.(item.id, item.href);
          closeMobile();
        }}
      >
        {isCollapsed ? null : item.label}
      </SidebarItem>
    );

    if (!isCollapsed) return node;
    return (
      <Tooltip>
        <TooltipTrigger asChild>{node}</TooltipTrigger>
        {/* Physical Radix `side` must mirror with direction: the rail sits on
            the inline-start edge, so tooltips open on its inline-end side. */}
        <TooltipContent side={direction === "rtl" ? "left" : "right"}>
          {item.label}
        </TooltipContent>
      </Tooltip>
    );
  };

  const sidebar = (
    <Sidebar
      collapsed={isCollapsed}
      aria-label="Primary navigation"
      className={cn("w-60", isCollapsed && "w-12 px-1.5")}
    >
      <TooltipProvider delayDuration={200}>
        <div className="flex h-full min-h-0 flex-col gap-2">
          <div className="min-h-0 flex-1 overflow-y-auto">
            {/* The full header contains brand text and descriptive copy; at
                w-14 those wrap into unreadable vertical letters. Render the
                icon-only variant while collapsed, or nothing when absent. */}
            {isCollapsed
              ? sidebarHeaderCollapsed
                ? <div className="flex justify-center px-1 pb-2">{sidebarHeaderCollapsed}</div>
                : null
              : sidebarHeader
                ? <div className="px-2 pb-2">{sidebarHeader}</div>
                : null}
            {navSections.map((section, sectionIndex) => (
              <SidebarSection
                key={section.id}
                className={cn(isCollapsed && "mb-2 space-y-0.5")}
                {...(isCollapsed || section.label === undefined ? {} : { label: section.label })}
              >
                {/* Collapsed rails have no room for section labels; a hairline
                    divider keeps the group structure visible instead. */}
                {isCollapsed && sectionIndex > 0 ? (
                  <div aria-hidden="true" className="mx-2 mb-2 border-t border-border" />
                ) : null}
                {section.items.map((item) => (
                  <React.Fragment key={item.id}>{renderItem(item)}</React.Fragment>
                ))}
              </SidebarSection>
            ))}
          </div>
          <div className="space-y-1">
            {/* Textual footer links wrap into unreadable stacks at w-14. */}
            {isCollapsed ? null : sidebarFooter}
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="hidden size-9 w-full text-muted-foreground hover:text-foreground md:inline-flex"
              onClick={toggleCollapsed}
              aria-label={isCollapsed ? "Expand sidebar" : "Collapse sidebar"}
              title={isCollapsed ? "Expand sidebar" : "Collapse sidebar"}
            >
              <PanelLeft className="size-4" aria-hidden="true" />
            </Button>
          </div>
        </div>
      </TooltipProvider>
    </Sidebar>
  );

  const topbar = (
    <Topbar
      className="h-12"
      onMenuClick={() => setMobileOpen(true)}
      breadcrumbs={
        <div className="flex min-w-0 items-center gap-2">
          <div className="min-w-0 truncate">{topbarStart}</div>
        </div>
      }
      actions={
        <>
          {accentBanner ? (
            <span
              className={cn(
                "hidden h-6 shrink-0 items-center rounded-md border px-2 text-[10px] font-bold tracking-wider sm:inline-flex",
                accentBanner.tone === "amber"
                  ? "border-amber-500/40 bg-amber-500/10 text-amber-800 dark:text-amber-400"
                  : "border-red-500/40 bg-red-500/10 text-red-700 dark:text-red-400"
              )}
            >
              {accentBanner.label}
            </span>
          ) : null}
          {topbarEnd}
        </>
      }
    />
  );

  return (
    <div
      className={cn(
        "vellum-console-shell h-dvh overflow-hidden",
        // AppShell owns the full flex/height chain and the sidebar offset.
        // Arbitrary child selectors here used to target a non-existent direct
        // `main` (it is nested inside AppShell's inner div), so the scroll
        // clipping rules never applied. Do not reintroduce them.
        // NOTE: do not add an `ms-*` offset here. AppShell already pushes its
        // inner content clear of the fixed sidebar. Offsetting both the root
        // and the inner div double-counts it and leaves a ~256px dead gutter
        // between the sidebar/topbar and the page content.
        className
      )}
    >
      {accentBanner ? (
        <div
          className={cn(
            "flex h-0.5 w-full shrink-0 items-center justify-center",
            accentBanner.tone === "amber" ? "bg-amber-500" : "bg-red-500"
          )}
          role="status"
          aria-label={accentBanner.label}
          title={accentBanner.label}
        >
          <span className="sr-only">{accentBanner.label}</span>
        </div>
      ) : null}
      <AppShell
        sidebar={sidebar}
        topbar={topbar}
        collapsed={isCollapsed}
        mobileOpen={mobileOpen}
        onMobileClose={closeMobile}
      >
        <div className="min-w-0">{children}</div>
      </AppShell>
    </div>
  );
}
