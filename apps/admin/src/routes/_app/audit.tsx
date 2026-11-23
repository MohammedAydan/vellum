import * as React from "react";
import { createRoute, Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { Route as appRoute } from "../_app.js";
import { adminFetch } from "../../lib/api.js";
import {
  ConfigurablePageHeader,
  ConsoleCopyableField,
  ConsoleDetailSheet,
  ConsoleKeyValueList,
  DataTable,
  ErrorAlert,
  JsonInspector,
  KpiMetricCard,
  LoadingState,
  PageContent,
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
  Button,
  Input,
  Badge,
  Tabs,
  TabsList,
  TabsTrigger,
  TabsContent,
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
  useI18n,
  type DataTableColumn,
} from "@vellum/ui";
import {
  Search,
  FileSearch,
  ShieldCheck,
  Lock,
  UserCheck,
  KeyRound,
  Download,
} from "lucide-react";
import { toast } from "sonner";

export const Route = createRoute({
  getParentRoute: () => appRoute,
  path: "/audit",
  component: AuditExplorerPage,
});

interface AuditLogEntry {
  id: string;
  timestamp: string;
  actorUserId: string;
  actorType: "operator" | "tenant_owner" | "system";
  action: string;
  category: "operator" | "security" | "lifecycle";
  organizationId: string;
  projectId: string;
  targetId: string;
  metadata: Record<string, unknown>;
}


function AuditExplorerPage() {
  const { t } = useI18n();
  const [exporting,setExporting]=React.useState(false);
  const exportLock=React.useRef(false);
  const [from,setFrom]=React.useState("");
  const [to,setTo]=React.useState("");
  const [filterQuery, setFilterQuery] = React.useState("");
  const [actorFilter, setActorFilter] = React.useState<string>("all");
  const [categoryTab, setCategoryTab] = React.useState<string>("all");
  const [selectedLog, setSelectedLog] = React.useState<AuditLogEntry | null>(null);

  const {
    data: realLogs = [],
    isLoading,
    isError,
    error,
    refetch,
  } = useQuery({
    queryKey: ["admin", "audit-logs"],
    queryFn: () => adminFetch<AuditLogEntry[]>("/v1/admin/audit-logs"),
  });

  const columns: DataTableColumn<AuditLogEntry>[] = [
    {
      id: "details",
      header: t("admin.audit.thDetails"),
      align: "end",
      accessor: (log) => (
        <Button
          size="sm"
          variant="outline"
          className="h-7 gap-1 text-xs"
          onClick={() => setSelectedLog(log)}
        >
          <span>{t("common.inspect")}</span>
        </Button>
      ),
    },
    {
      id: "timestamp",
      header: t("admin.audit.thTimestamp"),
      mono: true,
      accessor: (log) => (
        <span className="whitespace-nowrap text-[11px] text-muted-foreground">
          {new Date(log.timestamp).toLocaleString()}
        </span>
      ),
    },
    {
      id: "action",
      header: t("admin.audit.thAction"),
      accessor: (log) => (
        <Badge
          variant="outline"
          className={`font-mono text-[10px] ${
            log.action.includes("suspend")
              ? "border-rose-500/30 bg-rose-500/10 text-rose-700 dark:text-rose-400"
              : log.action.includes("override")
                ? "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-400"
                : "border-blue-500/30 bg-blue-500/10 text-blue-700 dark:text-blue-400"
          }`}
        >
          {log.action}
        </Badge>
      ),
    },
    {
      id: "actor",
      header: t("admin.audit.thActor"),
      accessor: (log) => (
        <span className="flex flex-col">
          <span className="font-mono text-xs font-semibold text-foreground">{log.actorUserId}</span>
          <span className="h-4 px-1 py-0 text-[9px] font-mono uppercase text-muted-foreground">
            {log.actorType}
          </span>
        </span>
      ),
    },
    {
      id: "orgProject",
      header: t("admin.audit.thOrgProject"),
      mono: true,
      accessor: (log) => (
        <span className="flex flex-col font-mono text-xs">
          <span className="font-medium text-foreground">{log.organizationId}</span>
          <span className="text-[10px] text-muted-foreground">{log.projectId}</span>
        </span>
      ),
    },
    {
      id: "target",
      header: t("admin.audit.thTarget"),
      mono: true,
      accessor: (log) => <span className="text-muted-foreground">{log.targetId}</span>,
    },
  ];

  if (isLoading) return <LoadingState rows={4} columns={4} />;
  if (isError) {
    return (
      <ErrorAlert
        title={t("admin.audit.title")}
        message={error instanceof Error ? error.message : t("admin.audit.loadError")}
        onRetry={() => void refetch()}
      />
    );
  }

  const logsList = realLogs;

  const filteredLogs = logsList.filter((log) => {
    const matchesQuery =
      log.action.toLowerCase().includes(filterQuery.toLowerCase()) ||
      log.organizationId.toLowerCase().includes(filterQuery.toLowerCase()) ||
      log.actorUserId.toLowerCase().includes(filterQuery.toLowerCase()) ||
      log.targetId.toLowerCase().includes(filterQuery.toLowerCase());
    const matchesActor = actorFilter === "all" || log.actorType === actorFilter;
    const matchesCategory = categoryTab === "all" || log.category === categoryTab;
    return matchesQuery && matchesActor && matchesCategory;
  });

  const handleExport = async () => {
    if (exportLock.current) return;
    exportLock.current = true; setExporting(true);
    try {
      const params = new URLSearchParams({q:filterQuery,actor:actorFilter,category:categoryTab});
      if (from) params.set("from",new Date(from).toISOString());
      if (to) params.set("to",new Date(to).toISOString());
      const payload = await adminFetch<Record<string,unknown>>(`/v1/admin/audit-export?${params}`);
      const blob = new Blob([JSON.stringify(payload,null,2)],{type:"application/json"});
      const url = URL.createObjectURL(blob);
      const anchor=document.createElement("a");anchor.href=url;anchor.download="audit_trail.json";
      document.body.append(anchor);anchor.click();anchor.remove();
      setTimeout(()=>URL.revokeObjectURL(url),30000);
      // The browser exposes dispatch, not completion/cancelation of a download.
      toast.success(t("admin.truth.exportStarted",{file:"audit_trail.json"}));
    } catch(err) { toast.error(err instanceof Error ? err.message : t("admin.truth.exportError")); }
    finally { exportLock.current=false;setExporting(false); }
  };

  const operatorEventsCount = realLogs.filter((l) => l.actorType === "operator" || l.actorType === "tenant_owner").length;
  const securityEventsCount = realLogs.filter((l) => l.action.includes("security") || l.action.includes("auth")).length;

  return (
    <PageContent>
      <ConfigurablePageHeader
        title={t("admin.audit.title")}
        description={t("admin.audit.description")}
        actions={
          <div className="flex items-center gap-2">
            <Badge
              variant="outline"
              className="font-mono text-[11px] border-rose-500/30 text-rose-700 dark:text-rose-400 bg-rose-500/5 gap-1 py-1"
            >
              <Lock className="h-3 w-3" />
              {t("common.privacyGuardActive")}
            </Badge>
            <Button variant="outline" size="sm" onClick={()=>void handleExport()} disabled={exporting} aria-busy={exporting} className="h-8 gap-1.5 text-xs">
              <Download className="h-3.5 w-3.5" />
              <span>{t("admin.audit.export")}</span>
            </Button>
          </div>
        }
      />

      {/* KPI metric cards */}
      <div className="grid gap-4 md:grid-cols-4">
        <KpiMetricCard label={t("admin.audit.recordedEvents")} value={realLogs.length} icon={<FileSearch className="size-4" />} subtitle={t("admin.audit.appendOnly")} mono />
        <KpiMetricCard label={t("admin.audit.operatorActions")} value={operatorEventsCount} icon={<UserCheck className="size-4" />} subtitle={t("admin.audit.quotaSuspensionEvents")} mono />
        <KpiMetricCard label={t("admin.audit.securityKeys")} value={securityEventsCount} icon={<KeyRound className="size-4" />} subtitle={t("admin.audit.rulesApiKeyMutations")} mono />
        <KpiMetricCard label={t("admin.audit.integrityVerification")} value={t("admin.truth.unknown")} icon={<ShieldCheck className="size-4" />} subtitle={t("admin.truth.exportScope")} mono />
      </div>

      <p className="text-xs text-muted-foreground">{t("admin.truth.exportScope")}</p>
      <div className="flex flex-wrap gap-4 text-xs">
        <label className="space-y-1">{t("admin.truth.from")}<Input aria-label={t("admin.truth.from")} type="datetime-local" value={from} onChange={e=>setFrom(e.target.value)} /></label>
        <label className="space-y-1">{t("admin.truth.to")}<Input aria-label={t("admin.truth.to")} type="datetime-local" value={to} onChange={e=>setTo(e.target.value)} /></label>
      </div>
      {/* Audit Log Table Card */}
      <Card>
        <CardHeader className="pb-3">
          <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <CardTitle className="text-base font-semibold">{t("admin.audit.trailTitle")}</CardTitle>
              <CardDescription className="text-xs">
                {t("admin.audit.trailDesc")}
              </CardDescription>
            </div>
            <Tabs value={categoryTab} onValueChange={setCategoryTab} className="w-auto">
              <TabsList className="h-8">
                <TabsTrigger value="all" className="text-xs">{t("admin.audit.tabAll")}</TabsTrigger>
                <TabsTrigger value="operator" className="text-xs">{t("admin.audit.tabOperator")}</TabsTrigger>
                <TabsTrigger value="security" className="text-xs">{t("admin.audit.tabSecurity")}</TabsTrigger>
                <TabsTrigger value="lifecycle" className="text-xs">{t("admin.audit.tabLifecycle")}</TabsTrigger>
              </TabsList>
              {/* Keep every trigger's aria-controls target mounted; filtering is driven by categoryTab. */}
              <TabsContent value="all" forceMount className="hidden" />
              <TabsContent value="operator" forceMount className="hidden" />
              <TabsContent value="security" forceMount className="hidden" />
              <TabsContent value="lifecycle" forceMount className="hidden" />
            </Tabs>
          </div>

          <div className="flex flex-col sm:flex-row items-center gap-3 pt-3">
            <div className="relative flex-1 w-full">
              <Search className="absolute start-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
              <Input
                placeholder={t("admin.audit.searchPlaceholder")}
                className="ps-8 text-xs h-9"
                value={filterQuery}
                onChange={(e) => setFilterQuery(e.target.value)}
              />
            </div>
            <div className="w-full sm:w-44">
              <Select value={actorFilter} onValueChange={setActorFilter}>
                <SelectTrigger className="h-9 text-xs">
                  <SelectValue placeholder={t("admin.audit.actorType")} />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">{t("admin.audit.allActorTypes")}</SelectItem>
                  <SelectItem value="operator">{t("admin.audit.operatorOnly")}</SelectItem>
                  <SelectItem value="tenant_owner">{t("admin.audit.tenantOwner")}</SelectItem>
                  <SelectItem value="system">{t("admin.audit.systemSentinel")}</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
        </CardHeader>

        <CardContent>
          <DataTable
            rows={filteredLogs}
            columns={columns}
            getRowId={(log) => log.id}
            emptyState={
              <div className="py-8 text-center text-xs text-muted-foreground">
                {t("admin.audit.noResults", { filter: filterQuery })}
              </div>
            }
          />
        </CardContent>
      </Card>

      {/* Immutable audit event inspector */}
      <ConsoleDetailSheet
        open={selectedLog !== null}
        onOpenChange={(open) => {
          if (!open) setSelectedLog(null);
        }}
        title={t("admin.audit.event", { action: selectedLog?.action ?? "" })}
        description={t("admin.audit.initiatedBy", {
          actor: selectedLog?.actorUserId ?? "",
          type: selectedLog?.actorType ?? "",
        })}
        footer={
          <Button size="sm" onClick={() => setSelectedLog(null)}>
            {t("common.close")}
          </Button>
        }
      >
        <div className="space-y-3 text-xs">
          <div className="flex flex-wrap items-center gap-2">
            {selectedLog ? (
              <ConsoleCopyableField label={t("admin.audit.eventMetadata")} value={selectedLog.id} />
            ) : null}
            <Badge variant="outline" className="border-emerald-500/30 bg-emerald-500/5 font-mono text-[10px] text-emerald-700 dark:text-emerald-400">
              <Link to="/security">{t("admin.truth.verifySecurity")}</Link>
            </Badge>
          </div>
          <ConsoleKeyValueList
            columns={2}
            items={[
              { label: t("admin.audit.organization"), value: selectedLog?.organizationId ?? "" },
              { label: t("admin.audit.project"), value: selectedLog?.projectId ?? "" },
              { label: t("admin.audit.targetResource"), value: selectedLog?.targetId ?? "" },
              { label: t("admin.audit.recordedAt"), value: selectedLog ? new Date(selectedLog.timestamp).toLocaleString() : "" },
            ]}
          />
          <div>
            <span className="mb-1 block text-xs font-semibold text-muted-foreground">
              {t("admin.audit.eventMetadata")}
            </span>
            <div className="rounded-lg border border-border/60 bg-muted/20 p-3">
              <JsonInspector value={selectedLog?.metadata ?? {}} />
            </div>
          </div>
          <div className="flex items-center gap-1.5 rounded-md border border-rose-500/20 bg-rose-500/5 p-2 font-mono text-[11px] text-rose-700 dark:text-rose-400">
            <Lock className="size-3.5 shrink-0" aria-hidden="true" />
            <span>{t("admin.audit.zeroCustomerData")}</span>
          </div>
        </div>
      </ConsoleDetailSheet>
    </PageContent>
  );
}
