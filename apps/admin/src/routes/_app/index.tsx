import * as React from "react";
import { createRoute, Link } from "@tanstack/react-router";
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
  Badge,
  Tabs,
  TabsList,
  TabsTrigger,
  TabsContent,
  Button,
  DataTable,
  StatusBadge,
  LoadingState,
  ErrorAlert,
  useI18n,
  cn,
  type DataTableColumn,
} from "@vellum/ui";
import {
  Database,
  Radio,
  Server,
  Zap,
  ShieldCheck,
  RefreshCw,
  HardDrive,
  Cpu,
} from "lucide-react";
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  ResponsiveContainer,
} from "recharts";
import { toast } from "sonner";

export const Route = createRoute({
  getParentRoute: () => appRoute,
  path: "/",
  component: ClusterOverviewPage,
});

interface ClusterNode {
  id: string;
  role: string;
  type: "control" | "data" | "realtime" | "cache";
  endpoint: string;
  status: "healthy" | "warning" | "error";
  cpuUsage: number;
  memoryUsage: number;
  activeConnections: number;
  maxConnections: number;
  uptime: string;
}

function ClusterOverviewPage() {
  const { t } = useI18n();

  // Presentation labels for the architectural invariants enforced by the
  // control plane. They are translated here (not module scope) so locale
  // changes re-render them immediately.
  const isolationPolicies = [
    {
      layer: t("admin.cluster.policy.layerSession"),
      policy: t("admin.cluster.policy.sessionPolicy"),
      enforcement: t("admin.cluster.policy.everyClientTx"),
      status: t("admin.truth.design"),
    },
    {
      layer: t("admin.cluster.policy.layerRls"),
      policy: t("admin.cluster.policy.rlsPolicy"),
      enforcement: t("admin.cluster.policy.failClosedTenant"),
      status: t("admin.truth.design"),
    },
    {
      layer: t("admin.cluster.policy.layerSafeguard"),
      policy: t("admin.cluster.policy.statementTimeout"),
      enforcement: t("admin.cluster.policy.abortOnTimeout"),
      status: t("admin.truth.design"),
    },
    {
      layer: t("admin.cluster.policy.layerPrivacy"),
      policy: t("admin.cluster.policy.zeroAccess"),
      enforcement: t("admin.cluster.policy.privacyGuard"),
      status: t("admin.truth.design"),
    },
    {
      layer: t("admin.cluster.policy.layerIndexing"),
      policy: t("admin.cluster.policy.zeroDdlLocks"),
      enforcement: t("admin.cluster.policy.binarySortKeys"),
      status: t("admin.truth.design"),
    },
  ];

  const {
    data: overview,
    isLoading,
    isError,
    error,
    refetch,
  } = useQuery({
    queryKey: ["admin", "overview"],
    queryFn: () =>
      adminFetch<{
        tenantsCount: number;
        projectsCount: number;
        keysCount: number;
        usersCount: number;
        planes: { controlDb: string; dataDb: string };
        metrics: Array<{ time: string; qps: number; p95Ms: number; outboxLag: number }>;
        nodes: ClusterNode[];
        telemetry?: {
          controlDb: { activeConnections: number; maxConnections: number };
          dataDb: { activeConnections: number; maxConnections: number };
          outboxLagSeqId: number;
          runtime?: { maintenanceIntervalMs: number | null; realtimeChannel: string | null; realtimeConnected: boolean | null };
          pool?: { control: { total: number; idle: number; waiting: number }; data: { total: number; idle: number; waiting: number } };
          usageTotals: { realtimeMessagesSent: number; documentReads: number; documentWrites: number };
        };
      }>("/v1/admin/overview"),
    refetchInterval: 15000,
  });

  const [isRefreshing, setIsRefreshing] = React.useState(false);

  const handleRefresh = async () => {
    setIsRefreshing(true);
    await refetch();
    setIsRefreshing(false);
    toast.success(t("admin.cluster.refreshToast"));
  };

  const activeNodes = overview?.nodes ?? [];
  const activeMetrics = overview?.metrics ?? [];
  const tenantsCount = overview?.tenantsCount ?? 0;
  const projectsCount = overview?.projectsCount ?? 0;
  const keysCount = overview?.keysCount ?? 0;
  const usersCount = overview?.usersCount ?? 0;
  const telemetry = overview?.telemetry;
  const outboxGap = telemetry?.outboxLagSeqId ?? 0;
  const unknown = t("admin.truth.unknown");
  const dataPool = telemetry?.pool?.data;
  const db = telemetry?.dataDb;

  const nodeColumns: DataTableColumn<ClusterNode>[] = [
    {
      id: "node",
      header: t("admin.cluster.thNode"),
      accessor: (node) => (
        <div className="flex flex-col">
          <span className="flex items-center gap-1.5 font-medium">
            {node.type === "data" ? (
              <Database className="size-3.5 text-blue-700 dark:text-blue-400" />
            ) : node.type === "control" ? (
              <Server className="size-3.5 text-rose-700 dark:text-rose-400" />
            ) : node.type === "realtime" ? (
              <Radio className="size-3.5 text-emerald-700 dark:text-emerald-400" />
            ) : (
              <Zap className="size-3.5 text-amber-700 dark:text-amber-400" />
            )}
            <span className="font-mono">{node.id}</span>
          </span>
          <span className="block font-mono text-[10px] text-muted-foreground">{node.endpoint}</span>
        </div>
      ),
    },
    { id: "role", header: t("admin.cluster.thRole"), accessor: (node) => node.role },
    {
      id: "status",
      header: t("admin.cluster.thStatus"),
      accessor: (node) => (
        <StatusBadge
          status={node.status === "healthy" ? "active" : node.status === "warning" ? "pending" : "suspended"}
          label={node.status}
        />
      ),
    },
    {
      id: "cpuMem",
      header: t("admin.cluster.thCpuMem"),
      mono: true,
      accessor: (_node) => (
        <span className="flex items-center gap-2 text-[10px] text-muted-foreground">
          <span className="flex items-center gap-0.5"><Cpu className="size-3" /> {unknown}</span>
          <span className="flex items-center gap-0.5"><HardDrive className="size-3" /> {unknown}</span>
        </span>
      ),
    },
    {
      id: "connections",
      header: t("admin.cluster.thConnections"),
      mono: true,
      accessor: (node) => (
        <span className="tabular-nums">{node.activeConnections} / {node.maxConnections}</span>
      ),
    },
    { id: "uptime", header: t("admin.cluster.thUptime"), mono: true, accessor: (node) => node.uptime },
  ];

  const isolationColumns: DataTableColumn<(typeof isolationPolicies)[number]>[] = [
    { id: "layer", header: t("admin.cluster.thLayer"), accessor: (row) => <span className="text-xs font-semibold">{row.layer}</span> },
    { id: "policy", header: t("admin.cluster.thEnforcement"), mono: true, accessor: (row) => <span className="text-xs text-muted-foreground">{row.policy}</span> },
    { id: "trigger", header: t("admin.cluster.thTrigger"), accessor: (row) => <span className="text-xs">{row.enforcement}</span> },
    {
      id: "status",
      header: t("admin.cluster.thInvariantStatus"),
      accessor: (row) => <Badge variant="outline">{row.status}</Badge>,
    },
  ];

  if (isLoading) return <LoadingState rows={4} columns={4} />;
  if (isError) {
    return (
      <ErrorAlert
        title={t("admin.cluster.title")}
        message={error instanceof Error ? error.message : t("admin.cluster.loadError")}
        onRetry={() => void refetch()}
      />
    );
  }

  return (
    <PageContent>
      <ConfigurablePageHeader
        title={t("admin.cluster.title")}
        description={t("admin.cluster.description")}
        actions={
          <div className="flex flex-wrap items-center justify-end gap-1.5 sm:gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={handleRefresh}
              disabled={isRefreshing || isLoading}
              className="h-8 gap-1.5 text-xs"
            >
              <RefreshCw className={`h-3.5 w-3.5 ${isRefreshing || isLoading ? "animate-spin" : ""}`} />
              <span>{t("common.refresh")}</span>
            </Button>
          </div>
        }
      />

      {/* KPI summary strip */}
      <Card>
        <CardContent className="grid grid-cols-2 gap-y-4 p-4 md:grid-cols-4">
          {[
            {
              label: t("admin.cluster.kpiTenantOrganizations"),
              value: tenantsCount,
              subtitle: `${projectsCount} ${t("admin.cluster.activeProjectsProvisioned")}`,
            },
            {
              label: t("admin.cluster.provisionedApiKeys"),
              value: keysCount,
              subtitle: t("admin.cluster.multiTenantKeys"),
            },
            {
              label: t("admin.cluster.operatorsAndUsers"),
              value: usersCount,
              subtitle: t("admin.cluster.registeredInControlDb"),
            },
            {
              label: t("admin.cluster.dualDataPlaneStatus"),
              value: overview?.planes.controlDb === "connected" && overview?.planes.dataDb === "connected" ? t("admin.cluster.connected") : unknown,
              subtitle: t("admin.cluster.neonServerlessPostgres"),
            },
          ].map((stat, index) => (
            <div
              key={stat.label}
              className={cn("min-w-0", index > 0 && "md:border-s md:border-border md:ps-4")}
            >
              <div className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                {stat.label}
              </div>
              <div className="mt-0.5 truncate font-mono text-xl font-semibold tabular-nums">
                {stat.value}
              </div>
              <div className="truncate text-xs text-muted-foreground">{stat.subtitle}</div>
            </div>
          ))}
        </CardContent>
      </Card>

      {/* Telemetry Tabs */}
      <Tabs defaultValue="overview" className="w-full space-y-4">
        <TabsList className="w-full flex-wrap justify-start">
          <TabsTrigger value="overview">{t("admin.cluster.tabOverview")}</TabsTrigger>
          <TabsTrigger value="fleet">{t("admin.cluster.tabFleet", { count: activeNodes.length })}</TabsTrigger>
          <TabsTrigger value="isolation">{t("admin.cluster.tabIsolation")}</TabsTrigger>
        </TabsList>

        {/* Tab 1: Overview */}
        <TabsContent value="overview" className="space-y-4">
          <Card><CardHeader><CardTitle>{t("admin.cluster.clusterName")}</CardTitle>
          <CardDescription>{t("admin.truth.liveSource")}</CardDescription></CardHeader><CardContent className="text-xs space-y-2">
          <p>{t("admin.cluster.controlPlaneDb", {active:telemetry?.controlDb.activeConnections??unknown,max:telemetry?.controlDb.maxConnections??unknown})}: {overview?.planes.controlDb === "connected" ? t("admin.cluster.connected") : unknown}</p>
          <p>{t("admin.cluster.dataPlaneDb", {active:telemetry?.dataDb.activeConnections??unknown,max:telemetry?.dataDb.maxConnections??unknown})}: {overview?.planes.dataDb === "connected" ? t("admin.cluster.connected") : unknown}</p>
          <p>{t("admin.cluster.realtimeListenNotify")}: {telemetry?.runtime?.realtimeConnected === true ? t("admin.cluster.connected") : unknown}</p>
          </CardContent></Card>

          {/* Cluster Load & Latency Chart */}
          <Card>
            <CardHeader>
              <div className="flex items-center justify-between">
                <div>
                  <CardTitle className="text-base font-semibold">{t("admin.cluster.chartTitle")}</CardTitle>
                  <CardDescription className="text-xs">
                    {t("admin.truth.chartDesc")}
                  </CardDescription>
                </div>
                <Badge variant="outline" className="font-mono text-xs">
                  {t("admin.cluster.daysObserved", { count: activeMetrics.length })}
                </Badge>
              </div>
            </CardHeader>
            <CardContent>
              <div className="h-[280px] w-full">
                <ResponsiveContainer width="100%" height="100%">
                  <LineChart data={activeMetrics} margin={{ top: 10, right: 30, left: 0, bottom: 0 }}>
                    <CartesianGrid strokeDasharray="3 3" opacity={0.15} />
                    <XAxis dataKey="time" stroke="#888888" fontSize={12} tickLine={false} />
                    <YAxis yAxisId="left" stroke="#888888" fontSize={12} tickLine={false} />
                    <YAxis yAxisId="right" orientation="right" stroke="#888888" fontSize={12} tickLine={false} />
                    <Tooltip
                      contentStyle={{
                        backgroundColor: "hsl(var(--card))",
                        borderColor: "hsl(var(--border))",
                        borderRadius: "0.5rem",
                        fontSize: "0.75rem",
                      }}
                    />
                    <Legend />
                    <Line
                      yAxisId="left"
                      type="monotone"
                      dataKey="qps"
                      stroke="#f43f5e"
                      strokeWidth={2}
                      name={t("admin.cluster.legendQps")}
                      dot={{ r: 3 }}
                    />

                  </LineChart>
                </ResponsiveContainer>
              </div>
            </CardContent>
          </Card>

          {/* Infrastructure Subsystems */}
          <div className="grid gap-4 md:grid-cols-3">
            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="text-sm font-semibold flex items-center gap-2">
                  <Server className="h-4 w-4 text-primary" />
                  <span>{t("admin.cluster.subsystemDataPlane")}</span>
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-3 text-xs">
                <div className="flex justify-between py-1 border-b border-border/60">
                  <span className="text-muted-foreground">{t("admin.truth.poolCounts")}</span>
                  <span className="font-mono font-medium">{dataPool ? `${dataPool.total} / ${dataPool.idle} / ${dataPool.waiting}` : unknown}</span>
                </div>
                <div className="flex justify-between py-1 border-b border-border/60">
                  <span className="text-muted-foreground">{t("admin.cluster.poolSaturation")}</span>
                  <span className="font-mono font-medium text-emerald-700 dark:text-emerald-400">{db && db.maxConnections > 0 ? `${Math.round(100*db.activeConnections/db.maxConnections)}% (${db.activeConnections}/${db.maxConnections})` : unknown}</span>
                </div>
                <div className="flex justify-between py-1">
                  <span className="text-muted-foreground">{t("admin.cluster.rlsPolicyState")}</span>
                  <Badge variant="secondary" className="font-mono text-[10px] text-emerald-700 dark:text-emerald-400">
                    {t("admin.truth.design")}
                  </Badge>
                </div>
              </CardContent>
            </Card>

            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="text-sm font-semibold flex items-center gap-2">
                  <Zap className="h-4 w-4 text-amber-700 dark:text-amber-400" />
                  <span>{t("admin.cluster.outboxWorker")}</span>
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-3 text-xs">
                <div className="flex justify-between py-1 border-b border-border/60">
                  <span className="text-muted-foreground">{t("admin.truth.outboxWatermark")}</span>
                  <span className="font-mono font-medium text-emerald-700 dark:text-emerald-400">
                    {telemetry ? outboxGap : unknown}
                  </span>
                </div>
                <div className="flex justify-between py-1 border-b border-border/60">
                  <span className="text-muted-foreground">{t("admin.cluster.workerPollFrequency")}</span>
                  <span className="font-mono font-medium">{telemetry?.runtime?.maintenanceIntervalMs != null ? `${telemetry.runtime.maintenanceIntervalMs} ms` : unknown}</span>
                </div>
                <div className="flex justify-between py-1">
                  <span className="text-muted-foreground">{t("admin.cluster.notifyChannel")}</span>
                  <span className="font-mono font-medium text-muted-foreground">
                    {telemetry?.runtime?.realtimeChannel ?? unknown}
                  </span>
                </div>
              </CardContent>
            </Card>

            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="text-sm font-semibold flex items-center gap-2">
                  <ShieldCheck className="h-4 w-4 text-rose-700 dark:text-rose-400" />
                  <span>{t("admin.truth.design")}</span>
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-3 text-xs">
                <div className="flex justify-between py-1 border-b border-border/60">
                  <span className="text-muted-foreground">{t("admin.cluster.customerPayloadAccess")}</span>
                  <Badge variant="destructive" className="font-mono text-[10px]">
                    {t("admin.cluster.blockedZeroAccess")}
                  </Badge>
                </div>
                <div className="flex justify-between py-1 border-b border-border/60">
                  <span className="text-muted-foreground">{t("admin.cluster.metadataVisibility")}</span>
                  <span className="font-mono font-medium text-emerald-700 dark:text-emerald-400">
                    {t("admin.cluster.permittedAggregates")}
                  </span>
                </div>
                <div className="flex justify-between py-1">
                  <span className="text-muted-foreground">{t("admin.cluster.auditLogTrail")}</span>
                  <span className="font-mono font-medium"><Link to="/security" className="underline">{t("admin.truth.verifySecurity")}</Link></span>
                </div>
              </CardContent>
            </Card>
          </div>
        </TabsContent>

        {/* Tab 2: Node Fleet Table */}
        <TabsContent value="fleet" className="space-y-4">
          <Card>
            <CardHeader className="pb-3">
              <div className="flex items-center justify-between">
                <div>
                  <CardTitle className="text-base font-semibold">{t("admin.cluster.fleetTitle")}</CardTitle>
                  <CardDescription className="text-xs">
                    {t("admin.cluster.fleetDesc")}
                  </CardDescription>
                </div>
                <Badge variant="outline" className="font-mono text-xs">
                  {t("admin.cluster.nodesOnline", { current: 6, total: 6 })}
                </Badge>
              </div>
            </CardHeader>
            <CardContent>
              <DataTable
                rows={activeNodes}
                columns={nodeColumns}
                getRowId={(node) => node.id}
                emptyState={
                  <div className="py-10 text-center text-xs text-muted-foreground">
                    {t("admin.cluster.noNodeTelemetry")}
                  </div>
                }
              />
            </CardContent>
          </Card>
        </TabsContent>

        {/* Tab 3: Isolation & Privacy Guard */}
        <TabsContent value="isolation" className="space-y-4">
          <Card>
            <CardHeader className="pb-3">
              <div className="flex items-center justify-between">
                <div>
                  <CardTitle className="text-base font-semibold">{t("admin.cluster.isolationTitle")}</CardTitle>
                  <CardDescription className="text-xs">
                    {t("admin.cluster.isolationDesc")}
                  </CardDescription>
                </div>
                <Badge
                  variant="outline"
                  className="font-mono text-xs border-emerald-500/30 text-emerald-700 dark:text-emerald-400 bg-emerald-500/5 gap-1"
                >
                  <ShieldCheck className="h-3 w-3" />
                  {t("admin.cluster.compliant")}
                </Badge>
              </div>
            </CardHeader>
            <CardContent>
              <DataTable
                rows={isolationPolicies}
                columns={isolationColumns}
                getRowId={(row) => row.layer}
              />
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </PageContent>
  );
}
