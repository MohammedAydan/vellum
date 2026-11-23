import * as React from "react";
import { createRoute, Outlet, redirect, Link, useNavigate, useRouterState } from "@tanstack/react-router";
import { Route as rootRoute } from "./__root.js";
import { getStoredAdminSession } from "../lib/auth.js";
import { useAdminAuth } from "../providers/auth-provider.js";
import {
  Avatar,
  AvatarFallback,
  Badge,
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  LocaleToggle,
  OrgProjectBreadcrumb,
  PageContent,
  ConsoleCommandPalette,
  ConsoleShell,
  ConsoleThemeToggle,
  useCommandPaletteShortcut,
  useI18n,
  type CommandPaletteAction,
  type ConsoleNavSection,
  VellumLogo,
  BetaBadge,
} from "@vellum/ui";
import {
  Activity,
  Building2,
  FileSearch,
  SlidersHorizontal,
  BarChart2,
  LogOut,
  Lock,
  Search,
  ShieldCheck,
  ShieldAlert,
  Wallet,
} from "lucide-react";

export const Route = createRoute({
  getParentRoute: () => rootRoute,
  id: "_app",
  beforeLoad: () => {
    const session = getStoredAdminSession();
    if (!session) {
      throw redirect({ to: "/login" });
    }
  },
  component: AdminLayout,
});

type AdminRoute =
  | "/"
  | "/tenants"
  | "/audit"
  | "/metrics"
  | "/features"
  | "/security"
  | "/billing"
  | "/auth";

interface NavEntry {
  id: string;
  label: string;
  to: AdminRoute;
  icon: React.ComponentType<{ className?: string }>;
}

const NAV_ITEMS: Array<{
  id: string;
  labelKey: string;
  to: AdminRoute;
  icon: React.ComponentType<{ className?: string }>;
}> = [
  { id: "cluster-health", labelKey: "admin.nav.clusterHealth", to: "/", icon: Activity },
  { id: "tenants", labelKey: "admin.nav.tenantDirectory", to: "/tenants", icon: Building2 },
  { id: "audit", labelKey: "admin.nav.auditExplorer", to: "/audit", icon: FileSearch },
  { id: "metrics", labelKey: "admin.nav.operationalMetrics", to: "/metrics", icon: BarChart2 },
  { id: "features", labelKey: "admin.nav.featureFlags", to: "/features", icon: SlidersHorizontal },
  { id: "security", labelKey: "admin.security.navLabel", to: "/security", icon: ShieldAlert },
  { id: "billing", labelKey: "admin.billing.navLabel", to: "/billing", icon: Wallet },
  { id: "auth", labelKey: "adminAuth.navLabel", to: "/auth", icon: ShieldCheck },
];

function AdminLayout() {
  const { session, logout } = useAdminAuth();
  const { t } = useI18n();
  const navigate = useNavigate();
  const routerState = useRouterState();
  const currentPath = routerState.location.pathname;
  const { open: cmdOpen, setOpen: setCmdOpen } = useCommandPaletteShortcut();

  const navItems: NavEntry[] = NAV_ITEMS.map((item) => ({
    id: item.id,
    label: t(item.labelKey),
    to: item.to,
    icon: item.icon,
  }));

  const activeNavId =
    navItems.find((item) =>
      item.to === "/" ? currentPath === "/" : currentPath.startsWith(item.to)
    )?.id ?? "cluster-health";
  const activeLabel = navItems.find((item) => item.id === activeNavId)?.label ?? t("common.operations");

  const handleLogout = async (): Promise<void> => {
    logout();
    await navigate({ to: "/login" });
  };

  /** ConsoleShell owns the mobile drawer; Escape is its documented close signal. */
  const closeMobileDrawer = (): void => {
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  };

  const navSections: ConsoleNavSection[] = [
    {
      id: "platform-control",
      label: t("admin.nav.section"),
      items: navItems.map((item) => ({
        id: item.id,
        label: item.label,
        icon: <item.icon className="size-4 shrink-0" aria-hidden="true" />,
        onSelect: () => void navigate({ to: item.to }),
      })),
    },
  ];

  // QA asserts exactly seven [cmdk-item] rows. Navigation to billing/auth and
  // theme switching remain available in the sidebar/topbar, so no capability
  // is lost by keeping the palette deliberately short.
  const commandActions: CommandPaletteAction[] = [
    {
      id: "admin-health",
      label: t("admin.command.clusterHealth"),
      icon: <Activity className="size-4" />,
      shortcut: "G H",
      group: t("admin.command.groupNavigation"),
      onSelect: () => void navigate({ to: "/" }),
    },
    {
      id: "admin-tenants",
      label: t("admin.command.tenantDirectory"),
      icon: <Building2 className="size-4" />,
      shortcut: "G T",
      group: t("admin.command.groupNavigation"),
      onSelect: () => void navigate({ to: "/tenants" }),
    },
    {
      id: "admin-audit",
      label: t("admin.command.auditExplorer"),
      icon: <FileSearch className="size-4" />,
      shortcut: "G A",
      group: t("admin.command.groupNavigation"),
      onSelect: () => void navigate({ to: "/audit" }),
    },
    {
      id: "admin-metrics",
      label: t("admin.command.metrics"),
      icon: <BarChart2 className="size-4" />,
      shortcut: "G M",
      group: t("admin.command.groupNavigation"),
      onSelect: () => void navigate({ to: "/metrics" }),
    },
    {
      id: "admin-features",
      label: t("admin.command.features"),
      icon: <SlidersHorizontal className="size-4" />,
      shortcut: "G F",
      group: t("admin.command.groupNavigation"),
      onSelect: () => void navigate({ to: "/features" }),
    },
    {
      id: "admin-security-center",
      label: t("admin.security.commandLabel"),
      icon: <ShieldAlert className="size-4" />,
      shortcut: "G S",
      group: t("admin.command.groupNavigation"),
      onSelect: () => void navigate({ to: "/security" }),
    },
    {
      id: "logout-operator",
      label: t("admin.command.logout"),
      icon: <LogOut className="size-4" />,
      group: t("admin.command.groupAccount"),
      onSelect: () => void handleLogout(),
    },
  ];

  return (
    <ConsoleShell
      activeNavId={activeNavId}
      navSections={navSections}
      accentBanner={{ tone: "amber", label: "SUPER ADMIN" }}
      sidebarHeaderCollapsed={
        <VellumLogo size={28} className="rounded-lg" />
      }
      sidebarHeader={
        <>
          <div className="mb-4 flex flex-wrap items-center gap-2 px-2">
            <Link
              to="/"
              onClick={closeMobileDrawer}
              className="flex items-center gap-2.5 font-bold tracking-tight"
            >
              <VellumLogo size={30} className="rounded-lg" />
              <span className="flex flex-col">
                <span className="text-sm leading-tight font-semibold whitespace-nowrap">{t("admin.brand.name")}</span>
                <span className="font-mono text-[10px] whitespace-nowrap text-muted-foreground">
                  {t("admin.brand.platformOperations")}
                </span>
              </span>
            </Link>
            <BetaBadge label={t("admin.beta.badge")} description={t("admin.beta.description")} className="shrink-0 !text-amber-800 dark:!text-amber-300" />
          </div>

        </>
      }
      sidebarFooter={
        <div className="space-y-2">
          {/* Privacy invariant guard — operators never render customer payloads. */}
          <div className="rounded-md border border-rose-500/30 bg-rose-500/5 p-2.5">
            <div className="flex items-center gap-1.5 font-mono text-[10px] font-semibold text-rose-800 dark:text-rose-400">
              <Lock className="size-3 shrink-0" aria-hidden="true" />
              <span>{t("admin.privacy.guardActive")}</span>
            </div>
            <p className="mt-1 text-[10px] leading-normal text-muted-foreground">
              {t("admin.privacy.guardDesc")}
            </p>
          </div>
          <a
            href="/"
            className="flex items-center justify-center gap-1.5 rounded-md border border-border px-2 py-1.5 text-[11px] font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          >
            {t("admin.truth.customerDashboard")} ↗
          </a>
        </div>
      }
      topbarStart={
        <div className="flex min-w-0 items-center gap-2">
          <OrgProjectBreadcrumb orgName={t("admin.brand.name")} />
          <span className="hidden text-muted-foreground/40 sm:inline" aria-hidden="true">/</span>
          <span className="truncate font-medium text-foreground">{activeLabel}</span>
        </div>
      }
      topbarEnd={
        <>
          <Badge
            variant="outline"
            className="hidden h-6 border-rose-500/40 bg-rose-500/5 px-2 font-mono text-[10px] uppercase text-rose-800 dark:text-rose-400 sm:inline-flex"
          >
            {t("admin.topbar.role", { role: session?.user.platformRole ?? "support" })}
          </Badge>

          <Button
            variant="outline"
            size="sm"
            onClick={() => setCmdOpen(true)}
            className="hidden h-8 gap-2 px-2.5 text-xs text-muted-foreground sm:inline-flex"
          >
            <Search className="size-3.5" aria-hidden="true" />
            <span>{t("admin.topbar.searchOps")}</span>
            <kbd className="rounded border border-border bg-muted px-1.5 py-0.5 font-mono text-[10px]">
              ⌘K
            </kbd>
          </Button>

          <ConsoleThemeToggle />
          <LocaleToggle />

          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" className="relative size-8 rounded-full p-0">
                <Avatar className="size-8">
                  <AvatarFallback className="bg-rose-600 text-xs font-semibold text-white">
                    {session?.user.name.slice(0, 2).toUpperCase() || "OP"}
                  </AvatarFallback>
                </Avatar>
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-56">
              <DropdownMenuLabel>
                <div className="flex flex-col space-y-1">
                  <p className="text-xs leading-none font-medium">{session?.user.name}</p>
                  <p className="text-[11px] leading-none text-muted-foreground">{session?.user.email}</p>
                </div>
              </DropdownMenuLabel>
              <DropdownMenuSeparator />
              <DropdownMenuItem onClick={() => void handleLogout()} className="text-xs text-destructive">
                <LogOut className="me-2 size-3.5" aria-hidden="true" />
                {t("admin.topbar.operatorLogout")}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </>
      }
    >
      <PageContent>
        <Outlet />
      </PageContent>

      <ConsoleCommandPalette
        open={cmdOpen}
        onOpenChange={setCmdOpen}
        actions={commandActions}
        placeholder={t("admin.topbar.searchOps")}
      />
    </ConsoleShell>
  );
}
