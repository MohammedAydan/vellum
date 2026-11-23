import * as React from "react";
import { createRoute, useNavigate } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { Route as appRoute } from "../_app.js";
import { adminFetch } from "../../lib/api.js";
import {
  ConfigurablePageHeader,
  PageContent,
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
  Button,
  Input,
  Badge,
  DataTable,
  KpiMetricCard,
  StatusBadge,
  Tabs,
  TabsList,
  TabsTrigger,
  TabsContent,
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
  LoadingState,
  ErrorAlert,
  useI18n,
  type DataTableColumn,
} from "@vellum/ui";
import {
  Search,
  ArrowRight,
  Building2,
  Lock,
  Ban,
  CheckCircle2,
  HardDrive,
  Users,
} from "lucide-react";

export const Route = createRoute({
  getParentRoute: () => appRoute,
  path: "/tenants",
  component: TenantDirectoryPage,
});

export interface TenantRecord {
  id: string;
  name: string;
  slug: string;
  billingEmail: string;
  plan: "free" | "pro" | "enterprise";
  status: "active" | "suspended";
  storageMb: number;
  dailyReads: number;
  dailyWrites: number;
  projectsCount: number;
  createdAt: string;
}


function TenantDirectoryPage() {
  const navigate = useNavigate();
  const { t } = useI18n();
  const [search, setSearch] = React.useState("");
  const [planFilter, setPlanFilter] = React.useState<string>("all");
  const [statusTab, setStatusTab] = React.useState<string>("all");

  const {
    data: realTenants = [],
    isLoading,
    isError,
    error,
    refetch,
  } = useQuery({
    queryKey: ["admin", "tenants"],
    queryFn: () => adminFetch<TenantRecord[]>("/v1/admin/tenants"),
  });

  const columns: DataTableColumn<TenantRecord>[] = [
    {
      id: "actions",
      header: t("admin.tenants.thActions"),
      align: "end",
      accessor: (tenant) => (
        <Button
          size="sm"
          variant="outline"
          className="h-7 gap-1 text-xs"
          onClick={() =>
            navigate({ to: "/tenants/$orgId", params: { orgId: tenant.id } })
          }
        >
          <span>{t("common.inspect")}</span>
          <ArrowRight className="size-3" />
        </Button>
      ),
    },
    {
      id: "organization",
      header: t("admin.tenants.thOrganization"),
      accessor: (tenant) => (
        <div className="flex items-center gap-2">
          <span className="flex size-7 shrink-0 items-center justify-center rounded-md bg-rose-500/10 text-rose-700 dark:text-rose-400">
            <Building2 className="size-3.5" />
          </span>
          <span className="flex min-w-0 flex-col">
            <span className="block truncate text-xs font-semibold text-foreground">{tenant.name}</span>
            <span className="block truncate font-mono text-[10px] text-muted-foreground">
              {tenant.slug} &bull; {tenant.billingEmail}
            </span>
          </span>
        </div>
      ),
    },
    {
      id: "plan",
      header: t("admin.tenants.thPlanTier"),
      accessor: (tenant) => (
        <Badge
          variant="outline"
          className={`font-mono text-[10px] uppercase ${
            tenant.plan === "enterprise"
              ? "border-purple-500/30 bg-purple-500/10 text-purple-500"
              : tenant.plan === "pro"
                ? "border-blue-500/30 bg-blue-500/10 text-blue-700 dark:text-blue-400"
                : "bg-muted text-muted-foreground"
          }`}
        >
          {tenant.plan}
        </Badge>
      ),
    },
    {
      id: "status",
      header: t("admin.tenants.thStatus"),
      accessor: (tenant) => (
        <StatusBadge status={tenant.status} label={tenant.status} />
      ),
    },
    {
      id: "storage",
      header: t("admin.tenants.thStorage"),
      mono: true,
      accessor: (tenant) =>
        tenant.storageMb >= 1000
          ? `${(tenant.storageMb / 1024).toFixed(1)} GB`
          : `${tenant.storageMb} MB`,
    },
    {
      id: "reads",
      header: t("admin.tenants.thReads"),
      mono: true,
      align: "end",
      accessor: (tenant) => tenant.dailyReads.toLocaleString(),
    },
    {
      id: "writes",
      header: t("admin.tenants.thWrites"),
      mono: true,
      align: "end",
      accessor: (tenant) => tenant.dailyWrites.toLocaleString(),
    },
    {
      id: "projects",
      header: t("admin.tenants.thProjects"),
      mono: true,
      align: "end",
      accessor: (tenant) => tenant.projectsCount,
    },
  ];

  if (isLoading) return <LoadingState rows={4} columns={4} />;
  if (isError) {
    return (
      <ErrorAlert
        title={t("admin.tenants.title")}
        message={error instanceof Error ? error.message : t("admin.tenants.loadError")}
        onRetry={() => void refetch()}
      />
    );
  }

  const tenantsList = realTenants;

  const filteredTenants = tenantsList.filter((t) => {
    const matchesSearch =
      t.name.toLowerCase().includes(search.toLowerCase()) ||
      t.slug.toLowerCase().includes(search.toLowerCase()) ||
      t.billingEmail.toLowerCase().includes(search.toLowerCase());
    const matchesPlan = planFilter === "all" || t.plan === planFilter;
    const matchesStatus = statusTab === "all" || t.status === statusTab;
    return matchesSearch && matchesPlan && matchesStatus;
  });

  const totalStorageMb = tenantsList.reduce((acc, t) => acc + t.storageMb, 0);
  const activeTenantsCount = tenantsList.filter((t) => t.status === "active").length;
  const suspendedCount = tenantsList.filter((t) => t.status === "suspended").length;

  return (
    <PageContent>
      <ConfigurablePageHeader
        title={t("admin.tenants.title")}
        description={t("admin.tenants.description")}
        actions={
          <div className="flex items-center gap-2">
            <Badge
              variant="outline"
              className="font-mono text-[11px] border-rose-500/30 text-rose-700 dark:text-rose-400 bg-rose-500/5 gap-1 py-1"
            >
              <Lock className="h-3 w-3" />
              {t("common.privacyGuardActive")}
            </Badge>
          </div>
        }
      />

      {/* KPI metric cards */}
      <div className="grid gap-4 md:grid-cols-4">
        <KpiMetricCard
          label={t("admin.tenants.totalRegistered")}
          value={realTenants.length}
          icon={<Users className="size-4" />}
          subtitle={t("admin.tenants.tenantOrganizations")}
          mono
        />
        <KpiMetricCard
          label={t("admin.tenants.activeTenants")}
          value={activeTenantsCount}
          icon={<CheckCircle2 className="size-4" />}
          subtitle={t("admin.tenants.rlsPartitionsActive")}
          mono
        />
        <KpiMetricCard
          label={t("admin.tenants.suspendedTenants")}
          value={suspendedCount}
          icon={<Ban className="size-4" />}
          subtitle={t("admin.tenants.accessFailClosed")}
          mono
        />
        <KpiMetricCard
          label={t("admin.tenants.totalStorage")}
          value={`${(totalStorageMb / 1024).toFixed(2)} GB`}
          icon={<HardDrive className="size-4" />}
          subtitle={t("admin.tenants.postgresHeapIndexes")}
          mono
        />
      </div>

      {/* Directory Filter & Search Header */}
      <Card>
        <CardHeader className="pb-3">
          <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <CardTitle className="text-base font-semibold">{t("admin.tenants.directoryTitle")}</CardTitle>
              <CardDescription className="text-xs">
                {t("admin.tenants.directoryDesc")}
              </CardDescription>
            </div>
            <Tabs value={statusTab} onValueChange={setStatusTab} className="w-auto">
              <TabsList className="h-8">
                <TabsTrigger value="all" className="text-xs">{t("admin.tenants.tabAll")}</TabsTrigger>
                <TabsTrigger value="active" className="text-xs">{t("admin.tenants.tabActive", { count: activeTenantsCount })}</TabsTrigger>
                <TabsTrigger value="suspended" className="text-xs">{t("admin.tenants.tabSuspended", { count: suspendedCount })}</TabsTrigger>
              </TabsList>
              {/* Keep every trigger's aria-controls target mounted; filtering is driven by statusTab. */}
              <TabsContent value="all" forceMount className="hidden" />
              <TabsContent value="active" forceMount className="hidden" />
              <TabsContent value="suspended" forceMount className="hidden" />
            </Tabs>
          </div>

          <div className="flex flex-col sm:flex-row items-center gap-3 pt-3">
            <div className="relative flex-1 w-full">
              <Search className="absolute start-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
              <Input
                placeholder={t("admin.tenants.searchPlaceholder")}
                className="ps-8 text-xs h-9"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
            </div>
            <div className="w-full sm:w-44">
              <Select value={planFilter} onValueChange={setPlanFilter}>
                <SelectTrigger className="h-9 text-xs">
                  <SelectValue placeholder={t("admin.tenants.filterByPlan")} />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">{t("admin.tenants.allPlans")}</SelectItem>
                  <SelectItem value="enterprise">{t("admin.tenants.enterprise")}</SelectItem>
                  <SelectItem value="pro">{t("admin.tenants.proTier")}</SelectItem>
                  <SelectItem value="free">{t("admin.tenants.freeTier")}</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
        </CardHeader>

        <CardContent>
          <DataTable
            rows={filteredTenants}
            columns={columns}
            getRowId={(tenant) => tenant.id}
            emptyState={
              <div className="py-8 text-center text-xs text-muted-foreground">
                {t("admin.tenants.noResults", { search })}
              </div>
            }
          />
        </CardContent>
      </Card>
    </PageContent>
  );
}
