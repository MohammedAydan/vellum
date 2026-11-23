import * as React from "react";
import { createRoute, Outlet, redirect, useNavigate, useRouterState } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { Route as rootRoute } from "./__root.js";
import { getStoredSession } from "../lib/auth.js";
import { useAuth } from "../providers/auth-provider.js";
import { consoleFetch } from "../lib/api.js";
import {
  Avatar,
  AvatarFallback,
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
  useVellumTheme,
  useI18n,
  type CommandPaletteAction,
  type ConsoleNavSection,
  VellumLogo,
  BetaBadge,
} from "@vellum/ui";
import {
  Database,
  LogOut,
  Building2,
  Search,
  ShieldAlert,
  GitBranch,
  Layers,
  Key,
  BarChart3,
  CreditCard,
  Moon,
  Sun,
  Plus,
  Settings2,
  ShieldCheck,
  Users,
} from "lucide-react";

export const Route = createRoute({
  getParentRoute: () => rootRoute,
  id: "_app",
  beforeLoad: () => {
    const session = getStoredSession();
    if (!session) {
      throw redirect({ to: "/login" });
    }
  },
  component: DashboardAppLayout,
});

type ProjectSubpath = "data" | "query" | "rules" | "relations" | "indexes" | "keys" | "auth";

/** Initials for the avatar: first + last word of the display name, else the email prefix. */
function userInitials(name: string | undefined, email: string | undefined): string {
  const source = (name ?? "").trim();
  if (source) {
    const parts = source.split(/\s+/).filter(Boolean);
    const first = parts[0]?.charAt(0) ?? "";
    const last = parts.length > 1 ? parts[parts.length - 1]?.charAt(0) ?? "" : "";
    if (first || last) return `${first}${last}`;
  }
  return (email ?? "US").slice(0, 2);
}

function DashboardAppLayout() {
  const { session, logout } = useAuth();
  const { theme, setTheme } = useVellumTheme();
  const { t } = useI18n();
  const navigate = useNavigate();
  const routerState = useRouterState();
  const pathname = routerState.location.pathname;
  const { open: cmdOpen, setOpen: setCmdOpen } = useCommandPaletteShortcut();

  // Fetch real organizations from control DB
  const { data: realOrgs = [] } = useQuery({
    queryKey: ["organizations"],
    queryFn: async () => {
      const res = await consoleFetch<Array<{ id: string; name?: string; slug?: string }>>("/organizations");
      return Array.isArray(res) ? res : [];
    },
  });

  // Extract tenant context from URL pathname
  const orgMatch = pathname.match(/\/orgs\/([^/]+)/);
  const projMatch = pathname.match(/\/projects\/([^/]+)/);

  const activeOrg = realOrgs.find((o) => o.id === orgMatch?.[1]) ?? realOrgs[0];
  const currentOrgId = orgMatch?.[1] ?? activeOrg?.id ?? "none";

  // Fetch real projects for current organization
  const { data: realProjects = [] } = useQuery({
    queryKey: ["projects", currentOrgId],
    queryFn: async () => {
      if (!currentOrgId || currentOrgId === "none") return [];
      try {
        const res = await consoleFetch<Array<{ id: string; name?: string; slug?: string }>>(
          `/organizations/${encodeURIComponent(currentOrgId)}/projects`
        );
        return Array.isArray(res) ? res : [];
      } catch {
        return [];
      }
    },
    enabled: currentOrgId !== "none",
  });

  const activeProject = realProjects.find((p) => p.id === projMatch?.[1]) ?? realProjects[0];
  const currentProjectId = projMatch?.[1] ?? activeProject?.id ?? "none";

  const isDark = theme === "dark";

  const handleLogout = async () => {
    logout();
    await navigate({ to: "/login" });
  };

  const projectHref = (subpath: ProjectSubpath) =>
    `/app/orgs/${currentOrgId}/projects/${currentProjectId}/${subpath}`;

  const navigateToSubpath = (subpath: ProjectSubpath) =>
    void navigate({
      to: `/app/orgs/$orgId/projects/$projectId/${subpath}`,
      params: { orgId: currentOrgId, projectId: currentProjectId },
    });

  const navSections: ConsoleNavSection[] = [
    {
      id: "database",
      label: t("nav.sectionDatabase"),
      items: [
        {
          id: "db-data",
          label: t("nav.dbExplorer"),
          icon: <Database className="size-4 shrink-0" aria-hidden="true" />,
          href: projectHref("data"),
          onSelect: () => navigateToSubpath("data"),
        },
        {
          id: "db-query",
          label: t("nav.queryPlayground"),
          icon: <Search className="size-4 shrink-0" aria-hidden="true" />,
          href: projectHref("query"),
          onSelect: () => navigateToSubpath("query"),
        },
        {
          id: "db-rules",
          label: t("nav.securityRules"),
          icon: <ShieldAlert className="size-4 shrink-0" aria-hidden="true" />,
          href: projectHref("rules"),
          onSelect: () => navigateToSubpath("rules"),
        },
        {
          id: "db-relations",
          label: t("nav.relations"),
          icon: <GitBranch className="size-4 shrink-0" aria-hidden="true" />,
          href: projectHref("relations"),
          onSelect: () => navigateToSubpath("relations"),
        },
        {
          id: "db-indexes",
          label: t("nav.indexes"),
          icon: <Layers className="size-4 shrink-0" aria-hidden="true" />,
          href: projectHref("indexes"),
          onSelect: () => navigateToSubpath("indexes"),
        },
        {
          id: "db-keys",
          label: t("nav.apiKeys"),
          icon: <Key className="size-4 shrink-0" aria-hidden="true" />,
          href: projectHref("keys"),
          onSelect: () => navigateToSubpath("keys"),
        },
        {
          id: "db-auth",
          label: t("authStudio.navLabel"),
          icon: <Users className="size-4 shrink-0" aria-hidden="true" />,
          href: projectHref("auth"),
          onSelect: () => navigateToSubpath("auth"),
        },
      ],
    },
    {
      id: "platform",
      label: t("nav.sectionPlatform"),
      items: [
        {
          id: "platform-orgs",
          label: t("nav.orgs"),
          icon: <Building2 className="size-4 shrink-0" aria-hidden="true" />,
          href: "/app",
          onSelect: () => void navigate({ to: "/app" }),
        },
        {
          id: "platform-usage",
          label: t("nav.usageQuotas"),
          icon: <BarChart3 className="size-4 shrink-0" aria-hidden="true" />,
          href: `/app/orgs/${currentOrgId}/projects/${currentProjectId}/usage`,
          onSelect: () =>
            void navigate({
              to: "/app/orgs/$orgId/projects/$projectId/usage",
              params: { orgId: currentOrgId, projectId: currentProjectId },
            }),
        },
        {
          id: "platform-billing",
          label: t("nav.billing"),
          icon: <CreditCard className="size-4 shrink-0" aria-hidden="true" />,
          href: `/app/orgs/${currentOrgId}/billing`,
          onSelect: () =>
            void navigate({
              to: "/app/orgs/$orgId/billing",
              params: { orgId: currentOrgId },
            }),
        },
      ],
    },
  ];

  const activeNavId = pathname.includes("/data")
    ? "db-data"
    : pathname.includes("/query")
      ? "db-query"
      : pathname.includes("/rules")
        ? "db-rules"
        : pathname.includes("/relations")
        ? "db-relations"
        : pathname.includes("/indexes")
          ? "db-indexes"
          : pathname.includes("/keys")
            ? "db-keys"
            : pathname.includes("/auth")
              ? "db-auth"
              : pathname.includes("/usage")
                ? "platform-usage"
                : pathname.includes("/billing")
                  ? "platform-billing"
                  : "platform-orgs";

  const commandActions: CommandPaletteAction[] = [
    {
      id: "nav-orgs",
      label: t("nav.orgDirectory"),
      icon: <Building2 className="size-4" />,
      shortcut: "G O",
      group: t("cmd.groupNavigation"),
      onSelect: () => void navigate({ to: "/app" }),
    },
    {
      id: "nav-data",
      label: t("nav.dbExplorer"),
      icon: <Database className="size-4" />,
      shortcut: "G D",
      group: t("cmd.groupNavigation"),
      onSelect: () => navigateToSubpath("data"),
    },
    {
      id: "nav-query",
      label: t("nav.queryPlayground"),
      icon: <Search className="size-4" />,
      shortcut: "G Q",
      group: t("cmd.groupNavigation"),
      onSelect: () => navigateToSubpath("query"),
    },
    {
      id: "nav-rules",
      label: t("nav.rulesStudio"),
      icon: <ShieldAlert className="size-4" />,
      shortcut: "G R",
      group: t("cmd.groupNavigation"),
      onSelect: () => navigateToSubpath("rules"),
    },
    {
      id: "nav-relations",
      label: t("nav.relations"),
      icon: <GitBranch className="size-4" />,
      shortcut: "G L",
      group: t("cmd.groupNavigation"),
      onSelect: () => navigateToSubpath("relations"),
    },
    {
      id: "nav-indexes",
      label: t("nav.compositeIndexes"),
      icon: <Layers className="size-4" />,
      shortcut: "G I",
      group: t("cmd.groupNavigation"),
      onSelect: () => navigateToSubpath("indexes"),
    },
    {
      id: "nav-keys",
      label: t("nav.apiKeyManagement"),
      icon: <Key className="size-4" />,
      shortcut: "G K",
      group: t("cmd.groupNavigation"),
      onSelect: () => navigateToSubpath("keys"),
    },
    {
      id: "nav-auth-studio",
      label: t("authStudio.navLabel"),
      icon: <Users className="size-4" />,
      shortcut: "G A",
      group: t("cmd.groupNavigation"),
      onSelect: () => navigateToSubpath("auth"),
    },
    {
      id: "nav-usage",
      label: t("nav.usageQuotas"),
      icon: <BarChart3 className="size-4" />,
      shortcut: "G U",
      group: t("cmd.groupNavigation"),
      onSelect: () =>
        void navigate({
          to: "/app/orgs/$orgId/projects/$projectId/usage",
          params: { orgId: currentOrgId, projectId: currentProjectId },
        }),
    },
    {
      id: "nav-billing",
      label: t("nav.billing"),
      icon: <CreditCard className="size-4" />,
      shortcut: "G B",
      group: t("cmd.groupNavigation"),
      onSelect: () =>
        void navigate({
          to: "/app/orgs/$orgId/billing",
          params: { orgId: currentOrgId },
        }),
    },
    {
      id: "act-create-doc",
      label: t("nav.createDocument"),
      icon: <Plus className="size-4" />,
      shortcut: "C D",
      group: t("cmd.groupActions"),
      onSelect: () => navigateToSubpath("data"),
    },
    {
      id: "act-new-key",
      label: t("nav.newApiKey"),
      icon: <Key className="size-4" />,
      shortcut: "N K",
      group: t("cmd.groupActions"),
      onSelect: () => navigateToSubpath("keys"),
    },
    {
      id: "pref-theme",
      label: t("nav.toggleTheme"),
      icon: isDark ? <Sun className="size-4" /> : <Moon className="size-4" />,
      shortcut: "T T",
      group: t("cmd.groupPreferences"),
      onSelect: () => setTheme(isDark ? "light" : "dark"),
    },
  ];

  return (
    <ConsoleShell
      activeNavId={activeNavId}
      navSections={navSections}
      sidebarHeaderCollapsed={
        <VellumLogo size={28} className="rounded-lg" />
      }
      sidebarHeader={
        <>
          <div className="mb-4 flex flex-wrap items-center gap-2 px-2">
            <a
              href="/app"
              onClick={(event) => {
                event.preventDefault();
                void navigate({ to: "/app" });
              }}
              className="flex items-center gap-2.5 font-bold tracking-tight"
            >
              <VellumLogo size={30} className="rounded-lg" />
              <span className="flex flex-col">
                <span className="text-sm leading-tight font-semibold whitespace-nowrap">{t("nav.brandConsole")}</span>
                <span className="font-mono text-[10px] text-muted-foreground">{t("nav.customerStudio")}</span>
              </span>
            </a>
            <BetaBadge label={t("beta.badge")} description={t("beta.description")} className="shrink-0" />
          </div>
        </>
      }
      topbarStart={
        <OrgProjectBreadcrumb
          orgName={activeOrg?.name ?? t("nav.orgs")}
          orgId={currentOrgId}
          onSelectOrg={() => void navigate({ to: "/app" })}
          {...(projMatch
            ? {
                projectName: activeProject?.name ?? currentProjectId.slice(0, 8),
                projectId: currentProjectId,
                onSelectProject: () =>
                  void navigate({
                    to: "/app/orgs/$orgId/projects/$projectId/data",
                    params: { orgId: currentOrgId, projectId: currentProjectId },
                  }),
              }
            : {})}
        />
      }
      topbarEnd={
        <>
          <Button
            variant="outline"
            size="sm"
            onClick={() => setCmdOpen(true)}
            className="h-8 gap-2 px-2.5 text-xs text-muted-foreground"
            aria-label={t("common.search")}
          >
            <Search className="size-3.5" />
            <span className="hidden sm:inline">{t("common.search")}</span>
            <kbd className="pointer-coarse:hidden rounded border border-border bg-muted px-1.5 py-0.5 font-mono text-[10px]">
              ⌘K
            </kbd>
          </Button>

          <ConsoleThemeToggle />

          <LocaleToggle />

          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" className="relative size-8 rounded-full p-0">
                <Avatar className="size-8">
                  <AvatarFallback className="bg-primary/10 font-semibold text-primary text-xs uppercase">
                    {userInitials(session?.user.name, session?.user.email)}
                  </AvatarFallback>
                </Avatar>
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent className="w-56" align="end" forceMount>
              <DropdownMenuLabel className="font-normal">
                <div className="flex flex-col space-y-1">
                  <p className="text-sm leading-none font-medium">{session?.user.name}</p>
                  <p className="text-xs leading-none text-muted-foreground">{session?.user.email}</p>
                </div>
              </DropdownMenuLabel>
              <DropdownMenuSeparator />
              <DropdownMenuItem onClick={() => void navigate({ to: "/app/settings" })}>
                <Settings2 className="me-2 size-4" />
                <span>{t("menu.settingsSecurity")}</span>
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => void navigate({ to: "/mfa" })}>
                <ShieldCheck className="me-2 size-4" />
                <span>{t("menu.twoFactor")}</span>
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem onClick={handleLogout} className="text-destructive focus:text-destructive">
                <LogOut className="me-2 size-4" />
                <span>{t("menu.logout")}</span>
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
        placeholder={t("common.search")}
      />
    </ConsoleShell>
  );
}
