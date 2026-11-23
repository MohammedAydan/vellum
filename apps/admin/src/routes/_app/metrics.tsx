import * as React from "react";
import { createRoute } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { Route as appRoute } from "../_app.js";
import { adminFetch } from "../../lib/api.js";
import {
  ConfigurablePageHeader,
  DataTable,
  ErrorAlert,
  KpiMetricCard,
  LoadingState,
  PageContent,
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
  Badge,
  Tabs,
  TabsList,
  TabsTrigger,
  TabsContent,
  Button,
  useI18n,
  type DataTableColumn,
} from "@vellum/ui";
import { BarChart2, Clock, Zap, Activity, Lock, RefreshCw } from "lucide-react";
import { toast } from "sonner";

export const Route = createRoute({
  getParentRoute: () => appRoute,
  path: "/metrics",
  component: OperationalMetricsPage,
});

interface Overview {
  tenantsCount: number;
  projectsCount: number;
  keysCount: number;
  usersCount: number;
  metrics: Array<Record<string, unknown>>;
}

interface AuditEntry {
  id: string;
  action: string;
  timestamp: string;
}

interface OperationStat {
  operation: string;
  count: number;
}

function OperationalMetricsPage() {
  const { t } = useI18n();
  const {
    data: overview,
    isLoading,
    isError,
    error,
    refetch,
  } = useQuery({
    queryKey: ["admin", "overview"],
    queryFn: () => adminFetch<Overview>("/v1/admin/overview"),
  });

  const { data: auditLogs = [] } = useQuery({
    queryKey: ["admin", "audit-logs"],
    queryFn: () => adminFetch<AuditEntry[]>("/v1/admin/audit-logs"),
  });

  const [isRefreshing, setIsRefreshing] = React.useState(false);
  const handleRefresh = async () => {
    setIsRefreshing(true);
    await refetch();
    setIsRefreshing(false);
    toast.success(t("admin.metrics.refreshToast"));
  };

  // Operation distribution is derived from immutable audit events — never a fixture.
  const operationStats: OperationStat[] = React.useMemo(() => {
    const counts = new Map<string, number>();
    for (const log of auditLogs) counts.set(log.action, (counts.get(log.action) ?? 0) + 1);
    return Array.from(counts, ([operation, count]) => ({ operation, count })).sort((a, b) => b.count - a.count);
  }, [auditLogs]);

  const operationColumns: DataTableColumn<OperationStat>[] = [
    {
      id: "operation",
      header: t("admin.metrics.thOperation"),
      accessor: (op) => <span className="font-mono text-xs font-semibold">{op.operation}</span>,
    },
    {
      id: "count",
      header: t("admin.metrics.thEventCount"),
      mono: true,
      align: "end",
      accessor: (op) => op.count.toLocaleString(),
    },
  ];

  if (isLoading) return <LoadingState rows={4} columns={4} />;
  if (isError) {
    return (
      <ErrorAlert
        title={t("admin.metrics.title")}
        message={error instanceof Error ? error.message : t("admin.metrics.loadError")}
        onRetry={() => void refetch()}
      />
    );
  }

  const totalEvents = auditLogs.length;

  return (
    <PageContent>
      <ConfigurablePageHeader
        title={t("admin.metrics.title")}
        description={t("admin.metrics.description")}
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant="outline" className="font-mono text-xs text-emerald-700 dark:text-emerald-400 border-emerald-500/30 bg-emerald-500/5">
              {t("admin.metrics.liveControlPlane")}
            </Badge>
            <Badge variant="outline" className="font-mono text-[11px] border-rose-500/30 text-rose-700 dark:text-rose-400 bg-rose-500/5 gap-1 py-1">
              <Lock className="h-3 w-3" />
              {t("common.privacyGuardActive")}
            </Badge>
            <Button
              variant="outline"
              size="sm"
              onClick={handleRefresh}
              disabled={isRefreshing}
              className="h-8 gap-1.5 text-xs"
            >
              <RefreshCw className={`h-3.5 w-3.5 ${isRefreshing ? "animate-spin" : ""}`} />
              {t("common.refresh")}
            </Button>
          </div>
        }
      />

      <div className="grid gap-4 md:grid-cols-4">
        <KpiMetricCard label={t("admin.metrics.tenantOrganizations")} value={overview?.tenantsCount ?? 0} icon={<Clock className="size-4" />} subtitle={t("admin.metrics.controlDbAggregate")} mono />
        <KpiMetricCard label={t("admin.metrics.provisionedProjects")} value={overview?.projectsCount ?? 0} icon={<Activity className="size-4" />} subtitle={t("admin.metrics.acrossAllProjects")} mono />
        <KpiMetricCard label={t("admin.metrics.recordedAuditEvents")} value={totalEvents} icon={<BarChart2 className="size-4" />} subtitle={t("admin.metrics.fromImmutableLog")} mono />
        <KpiMetricCard label={t("admin.metrics.listenNotifyRealtime")} value={t("admin.metrics.active")} icon={<Zap className="size-4" />} subtitle={t("admin.metrics.durableOutbox")} />
      </div>

      <Tabs defaultValue="table" className="w-full space-y-4">
        <TabsList className="grid w-full grid-cols-1 max-w-xs">
          <TabsTrigger value="table">{t("admin.metrics.tabOperationDistribution")}</TabsTrigger>
        </TabsList>
        <TabsContent value="table" className="space-y-4">
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-base font-semibold">{t("admin.metrics.operationCountsTitle")}</CardTitle>
              <CardDescription className="text-xs">
                {t("admin.metrics.operationCountsDesc")}
              </CardDescription>
            </CardHeader>
            <CardContent>
              <DataTable
                rows={operationStats}
                columns={operationColumns}
                getRowId={(op) => op.operation}
                emptyState={
                  <div className="flex flex-col items-center gap-2 py-10 text-center">
                    <BarChart2 className="size-10 text-muted-foreground/60" aria-hidden="true" />
                    <span className="text-sm font-medium">{t("admin.metrics.noOperations")}</span>
                    <span className="text-xs text-muted-foreground">{t("admin.metrics.noOperationsDesc")}</span>
                  </div>
                }
              />
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </PageContent>
  );
}
