import * as React from "react";
import { Menu, Search, X } from "lucide-react";
import { Dialog, DialogContent, DialogTitle } from "../../components/dialog.js";
import { cn } from "../../lib/cn.js";

/* -------------------------------------------------------------------------- */
/* DocsShell                                                                  */
/* -------------------------------------------------------------------------- */

export interface DocsShellProps {
  children: React.ReactNode;
  sidebar: React.ReactNode;
  toc?: React.ReactNode;
  topbarStart?: React.ReactNode;
  topbarEnd?: React.ReactNode;
  navigationLabel?: string;
}

/**
 * Opens the app-owned search palette in a decoupled way. The docs app listens
 * for this event, or supplies its own trigger through `topbarStart`.
 */
export const DOCS_OPEN_SEARCH_EVENT = "vellum:open-search";

function DefaultSearchTrigger(): React.JSX.Element {
  return (
    <button
      type="button"
      className="search-trigger inline-flex h-9 items-center gap-2 rounded-lg border border-border bg-muted/40 px-3 text-xs text-muted-foreground transition-colors hover:border-primary/40 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      onClick={() => window.dispatchEvent(new Event(DOCS_OPEN_SEARCH_EVENT))}
    >
      <Search className="size-3.5 shrink-0" aria-hidden="true" />
      <span className="hidden sm:inline">Search documentation</span>
      <kbd className="ms-auto rounded border border-border bg-background px-1.5 py-0.5 font-mono text-[10px]">⌘K</kbd>
    </button>
  );
}

/**
 * Documentation application shell: sticky top bar, collapsible start sidebar,
 * a `max-w-3xl` prose container and a sticky end TOC rail.
 *
 * Toggles are intentionally NOT rendered here — the consuming app passes the
 * single theme/locale toggle through `topbarEnd` so QA assertions such as
 * `[data-testid="language-toggle"]` stay unique.
 *
 * Preserved QA hooks: `.search-trigger`, `.toc-rail`, `.nav-link`, `.doc-h1`
 * (the latter is emitted by app page content inside `children`). The app-owned
 * search dialog keeps `#searchInput`, its theme button keeps `#themeToggle`,
 * and its example tabs keep `.et-tab`; none of those are hardcoded here.
 */
export function DocsShell({
  children,
  sidebar,
  toc,
  topbarStart,
  topbarEnd,
  navigationLabel = "Documentation navigation",
}: DocsShellProps): React.JSX.Element {
  const [sidebarOpen, setSidebarOpen] = React.useState(true);
  const [mobileOpen, setMobileOpen] = React.useState(false);
  const [isMobile, setIsMobile] = React.useState(() => typeof window !== "undefined" && window.matchMedia("(max-width: 1023px)").matches);
  const menuRef = React.useRef<HTMLButtonElement>(null);
  React.useEffect(() => {
    const media = window.matchMedia("(max-width: 1023px)");
    const change = () => { setIsMobile(media.matches); setMobileOpen(false); };
    media.addEventListener("change", change);
    return () => media.removeEventListener("change", change);
  }, []);

  return (
    <div className="min-h-screen bg-background text-foreground">
      <header className="sticky top-0 z-40 flex h-15 items-center gap-3 border-b border-border bg-background/90 px-4 backdrop-blur">
        <button
          type="button"
          ref={menuRef}
          onClick={() => isMobile ? setMobileOpen((current) => !current) : setSidebarOpen((current) => !current)}
          aria-label={navigationLabel}
          aria-expanded={isMobile ? mobileOpen : sidebarOpen}
          className="inline-flex size-8 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          {(isMobile ? mobileOpen : sidebarOpen) ? <X className="size-4" aria-hidden="true" /> : <Menu className="size-4" aria-hidden="true" />}
        </button>

        <a href="/" className="flex shrink-0 items-center gap-2 text-sm font-bold tracking-tight">
          <span className="grid size-7 place-items-center rounded-lg bg-primary text-primary-foreground">D</span>
          <span className="hidden sm:inline">Vellum <span className="font-medium text-muted-foreground">/ Docs</span></span>
        </a>
        <span className="version-pill rounded-full border border-primary/30 bg-primary/10 px-2 py-0.5 text-[10px] font-bold tracking-wide text-primary">
          v0.0.8
        </span>

        <div className="ms-1 min-w-0 flex-1 sm:w-64">
          {topbarStart ?? <DefaultSearchTrigger />}
        </div>

        <div className="ms-auto flex shrink-0 items-center gap-2">
          <a
            href="/"
            className="top-link rounded-md px-2 py-1 text-xs font-semibold text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          >
            Dashboard
          </a>
          {topbarEnd}
        </div>
      </header>

      <div className="flex min-w-0 min-h-[calc(100vh-3.75rem)] items-stretch">
        {!isMobile && <aside
          className={cn(
            "sticky top-15 hidden h-[calc(100vh-3.75rem)] w-64 shrink-0 overflow-y-auto border-e border-border bg-muted/20 py-4 lg:block",
            !sidebarOpen && "lg:hidden"
          )}
        >
          {sidebar}
        </aside>}
        {isMobile && <Dialog open={mobileOpen} onOpenChange={setMobileOpen}>
          <DialogContent
            className="docs-mobile-drawer"
            aria-describedby={undefined}
            style={{ left: "auto", insetInlineStart: 0, top: 0, transform: "none", height: "100dvh", width: "min(20rem, calc(100vw - 2rem))", maxWidth: "none", borderRadius: 0, overflowY: "auto", display: "block", paddingTop: "3rem" }}
            onCloseAutoFocus={(event) => { event.preventDefault(); menuRef.current?.focus(); }}
            onClick={(event) => { if ((event.target as HTMLElement).closest("a[href]")) setMobileOpen(false); }}
          >
            <DialogTitle className="sr-only">{navigationLabel}</DialogTitle>
            {sidebar}
          </DialogContent>
        </Dialog>}

        <main className="min-w-0 flex-1 px-5 py-8">
          <div className="mx-auto flex min-w-0 w-full max-w-6xl gap-8">
            <article className="mx-auto min-w-0 w-full max-w-3xl">
              {children}
            </article>
            {toc ? (
              <aside className="hidden w-56 shrink-0 lg:block">{toc}</aside>
            ) : null}
          </div>
        </main>
      </div>
    </div>
  );
}
DocsShell.displayName = "DocsShell";

/* -------------------------------------------------------------------------- */
/* DocsSidebar                                                                */
/* -------------------------------------------------------------------------- */

export interface DocsSidebarProps {
  groups: Array<{
    id: string;
    label: string;
    items: Array<{ id: string; label: string; href: string; active?: boolean }>;
  }>;
  activeId?: string;
  label?: string;
}

export function DocsSidebar({ groups, activeId, label = "Documentation" }: DocsSidebarProps): React.JSX.Element {
  return (
    <nav className="space-y-6 px-3" aria-label={label}>
      {groups.map((group) => (
        <div className="nav-group" key={group.id}>
          <div className="nav-group-title mb-2 px-2 text-[10.5px] font-extrabold uppercase tracking-widest text-muted-foreground">
            {group.label}
          </div>
          {group.items.map((item) => {
            const active = item.active ?? item.id === activeId;
            return (
              <a
                key={item.id}
                href={item.href}
                aria-current={active ? "page" : undefined}
                className={cn(
                  "nav-link block rounded-md border-s-2 border-transparent px-3 py-1.5 text-sm text-muted-foreground transition-colors hover:bg-muted hover:text-foreground",
                  active && "is-active border-s-primary bg-primary/10 font-semibold text-primary"
                )}
              >
                {item.label}
              </a>
            );
          })}
        </div>
      ))}
    </nav>
  );
}
DocsSidebar.displayName = "DocsSidebar";

/* -------------------------------------------------------------------------- */
/* DocsToc                                                                    */
/* -------------------------------------------------------------------------- */

export interface DocsTocProps {
  items: Array<{ id: string; label: string; level?: 2 | 3 }>;
  activeId?: string;
}

export function DocsToc({ items, activeId }: DocsTocProps): React.JSX.Element {
  return (
    <div className="toc-rail sticky top-20 max-h-[calc(100vh-6rem)] overflow-y-auto border-s border-border ps-4 text-sm">
      <div className="toc-title mb-3 text-[10.5px] font-extrabold uppercase tracking-widest text-muted-foreground">
        On this page
      </div>
      {items.length === 0 ? (
        <div className="toc-empty text-muted-foreground">—</div>
      ) : (
        <nav aria-label="On this page">
          {items.map((item) => (
            <a
              key={item.id}
              href={`#${item.id}`}
              className={cn(
                "toc-link block py-1 text-muted-foreground transition-colors hover:text-primary",
                item.level === 3 && "toc-sub ps-3 text-xs",
                item.id === activeId && "is-active font-medium text-primary"
              )}
            >
              {item.label}
            </a>
          ))}
        </nav>
      )}
    </div>
  );
}
DocsToc.displayName = "DocsToc";

/* -------------------------------------------------------------------------- */
/* DocsCallout                                                                */
/* -------------------------------------------------------------------------- */

export interface DocsCalloutProps {
  tone: "info" | "tip" | "warning" | "danger";
  title?: string;
  children: React.ReactNode;
}

const CALLOUT_TONES: Record<DocsCalloutProps["tone"], { label: string; className: string }> = {
  info: { label: "Note", className: "border-s-info bg-info/5" },
  tip: { label: "Tip", className: "border-s-success bg-success/5" },
  warning: { label: "Caution", className: "border-s-warning bg-warning/5" },
  danger: { label: "Important", className: "border-s-destructive bg-destructive/5" },
};

export function DocsCallout({ tone, title, children }: DocsCalloutProps): React.JSX.Element {
  const config = CALLOUT_TONES[tone];
  return (
    <aside className={cn("callout my-4 rounded-lg border border-border border-s-[3px] p-4", config.className)}>
      <div className="callout-title mb-1 text-xs font-extrabold uppercase tracking-wide">
        {title ?? config.label}
      </div>
      <div className="callout-body text-sm text-muted-foreground">{children}</div>
    </aside>
  );
}
DocsCallout.displayName = "DocsCallout";

/* -------------------------------------------------------------------------- */
/* HttpMethodBadge                                                            */
/* -------------------------------------------------------------------------- */

export interface HttpMethodBadgeProps {
  method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE";
}

const METHOD_TONES: Record<HttpMethodBadgeProps["method"], string> = {
  GET: "bg-info/10 text-info",
  POST: "bg-success/10 text-success",
  PATCH: "bg-warning/10 text-warning",
  PUT: "bg-warning/10 text-warning",
  DELETE: "bg-destructive/10 text-destructive",
};

export function HttpMethodBadge({ method }: HttpMethodBadgeProps): React.JSX.Element {
  return (
    <span
      dir="ltr"
      className={cn(
        "api-method inline-flex items-center rounded-md px-2 py-0.5 font-mono text-[10.5px] font-extrabold tracking-wide",
        `api-${method.toLowerCase()}`,
        METHOD_TONES[method]
      )}
    >
      {method}
    </span>
  );
}
HttpMethodBadge.displayName = "HttpMethodBadge";
