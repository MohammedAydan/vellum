import * as React from "react";
import { createRoute } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Route as appRoute } from "../_app.js";
import { adminFetch } from "../../lib/api.js";
import {
  ConfigurablePageHeader,
  ErrorAlert,
  JsonInspector,
  LoadingState,
  PageContent,
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
  Button,
  Input,
  Textarea,
  Label,
  Badge,
  Tabs,
  TabsList,
  TabsTrigger,
  TabsContent,
  Table,
  TableHeader,
  TableBody,
  TableHead,
  TableRow,
  TableCell,
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
  useI18n,
  KpiMetricCard,
} from "@vellum/ui";
import {
  ShieldAlert,
  ShieldCheck,
  Ban,
  Link2,
  RefreshCw,
  Search,
  Eye,
  EyeOff,
  CheckCircle2,
  XCircle,
  Lock,
  ChevronRight,
} from "lucide-react";
import { toast } from "sonner";

export const Route = createRoute({
  getParentRoute: () => appRoute,
  path: "/security",
  component: SecurityCommandCenterPage,
});

/* -------------------------------------------------------------------------- */
/* Wire shapes — exact responses from apps/api/src/routes/fortress.ts §6.2     */
/* -------------------------------------------------------------------------- */

type Severity = "low" | "medium" | "high" | "critical";
type ThreatStatus = "open" | "acknowledged" | "resolved";
type BlockTargetType = "ip" | "api_key_id" | "org_id" | "project_id";
type AuditOutcome = "success" | "denied" | "error";

interface ChainVerification {
  valid: boolean;
  totalChecked: number;
  firstCorruptedSeq: number | null;
  reason: string | null;
}

interface SecurityOverview {
  threatsBySeverity: Record<Severity, number>;
  openThreats: number;
  activeBlocks: number;
  chainHealth: {
    audit: { lastSeq: number | null; lastHashPresent: boolean };
    ledger: { lastHashPresent: boolean };
    healthy: boolean;
  };
  topRateLimitedIps: Array<{ ip: string; events: number }>;
}

interface ThreatEvent {
  id: string;
  severity: Severity;
  category: string;
  sourceIp: string | null;
  actorId: string | null;
  orgId: string | null;
  projectId: string | null;
  summary: string;
  evidence: Record<string, unknown>;
  autoMitigated: boolean;
  status: ThreatStatus;
  createdAt: string;
}

interface BlocklistEntry {
  id: string;
  targetType: BlockTargetType;
  targetValue: string;
  reason: string;
  createdBy: string;
  createdAt: string;
  expiresAt: string | null;
  active: boolean;
}

interface SecurityAuditLog {
  seq: number;
  id: string;
  createdAt: string;
  actorRealm: string;
  actorId: string | null;
  orgId: string | null;
  projectId: string | null;
  action: string;
  resourceType: string;
  resourceId: string | null;
  outcome: AuditOutcome;
  ipAddress: string | null;
  userAgent: string | null;
  details: Record<string, unknown>;
  prevHash: string;
  entryHash: string;
}

interface ChainProofState {
  audit: ChainVerification;
  billing: ChainVerification;
}

interface AuditFilters {
  orgId: string;
  action: string;
  outcome: string;
}

/* -------------------------------------------------------------------------- */
/* Helpers                                                                    */
/* -------------------------------------------------------------------------- */

function errorMessage(err: unknown, fallback: string): string {
  return err instanceof Error && err.message ? err.message : fallback;
}

function formatDate(value: string | null): string {
  if (value === null || value === "") return "-";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

function severityClass(severity: Severity): string {
  if (severity === "critical") return "bg-rose-500/10 text-rose-700 dark:text-rose-400 border-rose-500/30";
  if (severity === "high") return "bg-orange-500/10 text-orange-500 border-orange-500/30";
  if (severity === "medium") return "bg-amber-500/10 text-amber-700 dark:text-amber-400 border-amber-500/30";
  return "bg-blue-500/10 text-blue-700 dark:text-blue-400 border-blue-500/30";
}

/* -------------------------------------------------------------------------- */
/* Page                                                                       */
/* -------------------------------------------------------------------------- */

function SecurityCommandCenterPage() {
  const { t } = useI18n();
  const queryClient = useQueryClient();

  const [threatTab, setThreatTab] = React.useState<string>("open");
  const [expanded, setExpanded] = React.useState<Record<string, boolean>>({});
  const [blockDialogOpen, setBlockDialogOpen] = React.useState(false);
  const [selectedLog, setSelectedLog] = React.useState<SecurityAuditLog | null>(null);
  const [proof, setProof] = React.useState<ChainProofState | null>(null);
  const [filters, setFilters] = React.useState<AuditFilters>({ orgId: "", action: "", outcome: "all" });
  const [appliedFilters, setAppliedFilters] = React.useState<AuditFilters>(filters);

  // Blocklist creation form state.
  const [targetType, setTargetType] = React.useState<BlockTargetType>("ip");
  const [targetValue, setTargetValue] = React.useState("");
  const [blockReason, setBlockReason] = React.useState("");
  const [expiresAt, setExpiresAt] = React.useState("");

  const invalidateAll = React.useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: ["admin-security"] });
  }, [queryClient]);

  const overviewQuery = useQuery({
    queryKey: ["admin-security", "overview"],
    queryFn: () => adminFetch<SecurityOverview>("/v1/admin/security/overview"),
  });

  const threatsQuery = useQuery({
    queryKey: ["admin-security", "threats"],
    queryFn: async (): Promise<ThreatEvent[]> => {
      const response = await adminFetch<{ threats: ThreatEvent[] }>("/v1/admin/security/threats");
      return response.threats;
    },
  });

  const blocklistQuery = useQuery({
    queryKey: ["admin-security", "blocklist"],
    queryFn: async (): Promise<BlocklistEntry[]> => {
      const response = await adminFetch<{ blocklist: BlocklistEntry[] }>(
        "/v1/admin/security/blocklist?activeOnly=false"
      );
      return response.blocklist;
    },
  });

  const auditQuery = useQuery({
    queryKey: ["admin-security", "audit-logs", appliedFilters],
    queryFn: async (): Promise<SecurityAuditLog[]> => {
      const params = new URLSearchParams();
      if (appliedFilters.orgId.trim() !== "") params.set("orgId", appliedFilters.orgId.trim());
      if (appliedFilters.action.trim() !== "") params.set("action", appliedFilters.action.trim());
      if (appliedFilters.outcome !== "all") params.set("outcome", appliedFilters.outcome);
      const query = params.toString();
      const response = await adminFetch<{ auditLogs: SecurityAuditLog[] }>(
        `/v1/admin/security/audit-logs${query === "" ? "" : `?${query}`}`
      );
      return response.auditLogs;
    },
  });

  const statusMutation = useMutation({
    mutationFn: async ({ id, status }: { id: string; status: "acknowledged" | "resolved" }): Promise<void> => {
      await adminFetch<{ threat: ThreatEvent }>(
        `/v1/admin/security/threats/${encodeURIComponent(id)}`,
        { method: "PATCH", body: JSON.stringify({ status }) }
      );
    },
    onSuccess: () => {
      toast.success(t("admin.security.threatUpdatedToast"));
      invalidateAll();
    },
    onError: (err) => toast.error(errorMessage(err, t("admin.security.threatUpdateError"))),
  });

  const unblockMutation = useMutation({
    mutationFn: async (id: string): Promise<void> => {
      await adminFetch<{ deleted: boolean; id: string }>(
        `/v1/admin/security/blocklist/${encodeURIComponent(id)}`,
        { method: "DELETE" }
      );
    },
    onSuccess: () => {
      toast.success(t("admin.security.unblockToast"));
      invalidateAll();
    },
    onError: (err) => toast.error(errorMessage(err, t("admin.security.unblockError"))),
  });

  const blockMutation = useMutation({
    mutationFn: async (): Promise<void> => {
      const body: {
        targetType: BlockTargetType;
        targetValue: string;
        reason: string;
        expiresAt?: string;
      } = {
        targetType,
        targetValue: targetValue.trim(),
        reason: blockReason.trim(),
        ...(expiresAt !== "" ? { expiresAt: new Date(expiresAt).toISOString() } : {}),
      };
      await adminFetch<{ block: BlocklistEntry }>("/v1/admin/security/blocklist", {
        method: "POST",
        body: JSON.stringify(body),
      });
    },
    onSuccess: () => {
      setBlockDialogOpen(false);
      setTargetValue("");
      setBlockReason("");
      setExpiresAt("");
      toast.success(t("admin.security.blockCreatedToast"));
      invalidateAll();
    },
    onError: (err) => toast.error(errorMessage(err, t("admin.security.blockCreateError"))),
  });

  const verifyMutation = useMutation({
    mutationFn: async (): Promise<ChainProofState> => {
      const [audit, billing] = await Promise.all([
        adminFetch<ChainVerification>("/v1/admin/security/audit-logs/verify-chain", { method: "POST" }),
        adminFetch<ChainVerification>("/v1/admin/billing/ledger/verify-chain", { method: "POST" }),
      ]);
      return { audit, billing };
    },
    onSuccess: (result) => {
      setProof(result);
      if (result.audit.valid && result.billing.valid) {
        toast.success(t("admin.security.verifySuccess"));
      } else {
        toast.error(t("admin.security.verifyFailed"));
      }
    },
    onError: (err) => toast.error(errorMessage(err, t("admin.security.verifyError"))),
  });

  const overview = overviewQuery.data;
  const threats = threatsQuery.data ?? [];
  const blocklist = blocklistQuery.data ?? [];
  const auditLogs = auditQuery.data ?? [];

  const visibleThreats = threats.filter((threat) => threatTab === "all" || threat.status === threatTab);
  const allValid = proof !== null && proof.audit.valid && proof.billing.valid;

  const handleCreateBlock = () => {
    if (targetValue.trim() === "" || blockReason.trim() === "") {
      toast.error(t("admin.security.requiredFields"));
      return;
    }
    if (expiresAt !== "") {
      const parsed = new Date(expiresAt);
      if (Number.isNaN(parsed.getTime()) || parsed.getTime() <= Date.now()) {
        toast.error(t("admin.security.invalidExpiry"));
        return;
      }
    }
    blockMutation.mutate();
  };

  if (overviewQuery.isLoading) return <LoadingState rows={6} columns={4} />;
  if (overviewQuery.isError) {
    return (
      <ErrorAlert
        title={t("admin.security.title")}
        message={errorMessage(overviewQuery.error, t("admin.security.loadError"))}
        onRetry={() => void overviewQuery.refetch()}
      />
    );
  }
  if (overview === undefined) return <LoadingState rows={6} columns={4} />;

  return (
    <PageContent>
      <ConfigurablePageHeader
        title={t("admin.security.title")}
        description={t("admin.security.description")}
        actions={
          <div className="flex items-center gap-2">
            <Badge
              variant="outline"
              className="font-mono text-[11px] border-rose-500/30 text-rose-700 dark:text-rose-400 bg-rose-500/5 gap-1 py-1"
            >
              <Lock className="h-3 w-3" />
              {t("common.privacyGuardActive")}
            </Badge>
            <Button
              variant="outline"
              size="sm"
              className="h-8 gap-1.5 text-xs"
              onClick={() => {
                invalidateAll();
                void overviewQuery.refetch();
              }}
            >
              <RefreshCw className="h-3.5 w-3.5" />
              {t("common.refresh")}
            </Button>
          </div>
        }
      />

      {/* Threat overview KPI cards */}
      <div className="grid gap-4 md:grid-cols-4">
        <KpiMetricCard label={t("admin.security.criticalOpen")} value={overview.threatsBySeverity.critical} icon={<ShieldAlert className="size-4 text-rose-500" />} subtitle={t("admin.security.openThreats")} mono />
        <KpiMetricCard label={t("admin.security.highOpen")} value={overview.threatsBySeverity.high} icon={<ShieldAlert className="size-4 text-orange-500" />} subtitle={t("admin.security.openThreats")} mono />
        <KpiMetricCard label={t("admin.security.activeBlocks")} value={overview.activeBlocks} icon={<Ban className="size-4 text-amber-500" />} subtitle={t("admin.security.blocklistDesc")} mono />
        <KpiMetricCard label={t("admin.security.chainIntegrity")} value={overview.chainHealth.healthy ? t("admin.security.chainHealthy") : overview.chainHealth.audit.lastSeq !== null && overview.chainHealth.ledger.lastHashPresent ? t("admin.security.chainDegraded") : t("admin.security.chainNotEstablished")} icon={<ShieldCheck className="size-4 text-emerald-500" />} subtitle={overview.chainHealth.audit.lastSeq === null ? t("admin.security.chainAuditNoSeq") : t("admin.security.chainAuditSeq", { seq: overview.chainHealth.audit.lastSeq })} />
      </div>

      {/* Live hash-chain verification */}
      <Card className="mt-4">
        <CardHeader className="pb-3">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <CardTitle className="text-base font-semibold flex items-center gap-2">
                <Link2 className="h-4 w-4 text-emerald-700 dark:text-emerald-400" />
                {t("admin.security.verifyTitle")}
              </CardTitle>
              <CardDescription className="text-xs">{t("admin.security.verifyDesc")}</CardDescription>
            </div>
            <Button
              size="sm"
              className="h-8 gap-1.5 text-xs"
              disabled={verifyMutation.isPending}
              onClick={() => verifyMutation.mutate()}
            >
              {verifyMutation.isPending ? (
                <RefreshCw className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <ShieldCheck className="h-3.5 w-3.5" />
              )}
              {verifyMutation.isPending
                ? t("admin.security.verifying")
                : t("admin.security.verifyChains")}
            </Button>
          </div>
        </CardHeader>
        <CardContent>
          {proof === null ? (
            <p className="text-xs text-muted-foreground">{t("admin.security.verifyIdle")}</p>
          ) : (
            <div className="space-y-3">
              <div
                className={`flex items-center gap-2 rounded-md border p-2.5 text-xs font-mono ${
                  allValid
                    ? "border-emerald-500/30 bg-emerald-500/5 text-emerald-700 dark:text-emerald-400"
                    : "border-rose-500/30 bg-rose-500/5 text-rose-700 dark:text-rose-400"
                }`}
              >
                {allValid ? (
                  <CheckCircle2 className="h-4 w-4 shrink-0" />
                ) : (
                  <XCircle className="h-4 w-4 shrink-0" />
                )}
                <span>{allValid ? t("admin.security.verifySuccess") : t("admin.security.verifyFailed")}</span>
              </div>
              <div className="grid gap-3 md:grid-cols-2">
                <ChainProofPanel
                  title={t("admin.security.proofAuditChain")}
                  proof={proof.audit}
                  validLabel={t("admin.security.proofValid")}
                  invalidLabel={t("admin.security.proofInvalid")}
                  checkedLabel={t("admin.security.proofChecked")}
                  corruptLabel={t("admin.security.proofFirstCorrupt")}
                  reasonLabel={t("admin.security.proofReason")}
                  noneLabel={t("admin.security.proofNone")}
                />
                <ChainProofPanel
                  title={t("admin.security.proofBillingChain")}
                  proof={proof.billing}
                  validLabel={t("admin.security.proofValid")}
                  invalidLabel={t("admin.security.proofInvalid")}
                  checkedLabel={t("admin.security.proofChecked")}
                  corruptLabel={t("admin.security.proofFirstCorrupt")}
                  reasonLabel={t("admin.security.proofReason")}
                  noneLabel={t("admin.security.proofNone")}
                />
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Top rate-limited sources */}
      <Card className="mt-4">
        <CardHeader className="pb-2">
          <CardTitle className="text-sm font-medium">{t("admin.security.topIpsTitle")}</CardTitle>
          <CardDescription className="text-xs">{t("admin.security.topIpsDesc")}</CardDescription>
        </CardHeader>
        <CardContent>
          {overview.topRateLimitedIps.length === 0 ? (
            <p className="text-xs text-muted-foreground">{t("admin.security.noTopIps")}</p>
          ) : (
            <div className="flex flex-wrap gap-2">
              {overview.topRateLimitedIps.map((item) => (
                <Badge key={item.ip} variant="outline" className="font-mono text-[11px] gap-1.5 py-1">
                  <span>{item.ip}</span>
                  <span className="text-rose-700 dark:text-rose-400">
                    {item.events}
                    {t("admin.security.eventsSuffix")}
                  </span>
                </Badge>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Active threat feed */}
      <Card className="mt-4">
        <CardHeader className="pb-3">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <CardTitle className="text-base font-semibold">{t("admin.security.threatFeedTitle")}</CardTitle>
              <CardDescription className="text-xs">{t("admin.security.threatFeedDesc")}</CardDescription>
            </div>
            <Tabs value={threatTab} onValueChange={setThreatTab} className="w-auto">
              <TabsList className="h-8">
                <TabsTrigger value="open" className="text-xs">{t("admin.security.tabOpen")}</TabsTrigger>
                <TabsTrigger value="acknowledged" className="text-xs">
                  {t("admin.security.tabAcknowledged")}
                </TabsTrigger>
                <TabsTrigger value="resolved" className="text-xs">{t("admin.security.tabResolved")}</TabsTrigger>
                <TabsTrigger value="all" className="text-xs">{t("common.all")}</TabsTrigger>
              </TabsList>
              {/* Keep every trigger's aria-controls target mounted; these panels are presentational only. */}
              <TabsContent value="open" forceMount className="hidden" />
              <TabsContent value="acknowledged" forceMount className="hidden" />
              <TabsContent value="resolved" forceMount className="hidden" />
              <TabsContent value="all" forceMount className="hidden" />
            </Tabs>
          </div>
        </CardHeader>
        <CardContent>
          {threatsQuery.isError ? (
            <ErrorAlert
        title={t("admin.security.title")}
              message={errorMessage(threatsQuery.error, t("admin.security.loadError"))}
              onRetry={() => void threatsQuery.refetch()}
            />
          ) : (
            <div className="space-y-2">
              {visibleThreats.length === 0 ? (
                <p className="text-xs text-muted-foreground py-6 text-center">
                  {t("admin.security.noThreats")}
                </p>
              ) : (
                visibleThreats.map((threat) => {
                  const isExpanded = expanded[threat.id] === true;
                  return (
                    <div key={threat.id} className="rounded-lg border border-border/60 bg-muted/10 p-3">
                      <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
                        <div className="min-w-0 space-y-2">
                          <div className="flex flex-wrap items-center gap-2">
                            <Badge variant="outline" className={`font-mono text-[10px] ${severityClass(threat.severity)}`}>
                              {threat.severity}
                            </Badge>
                            <Badge variant="outline" className="font-mono text-[10px] uppercase">
                              {threat.category}
                            </Badge>
                            <Badge variant="outline" className="font-mono text-[10px]">
                              {t(`admin.security.status.${threat.status}`)}
                            </Badge>
                            {threat.autoMitigated ? (
                              <Badge variant="outline" className="font-mono text-[10px] text-emerald-700 dark:text-emerald-400 border-emerald-500/30">
                                {t("admin.security.autoMitigated")}
                              </Badge>
                            ) : null}
                            <span className="font-mono text-[10px] text-muted-foreground">
                              {formatDate(threat.createdAt)}
                            </span>
                          </div>
                          <p className="text-xs font-medium text-foreground">{threat.summary}</p>
                          <p className="font-mono text-[10px] text-muted-foreground break-all">
                            {t("admin.security.threatSource")}: {threat.sourceIp ?? "-"} · {threat.actorId ?? "-"} ·{" "}
                            {threat.orgId ?? "-"} · {threat.projectId ?? "-"}
                          </p>
                        </div>
                        <div className="flex shrink-0 flex-wrap gap-1.5">
                          <Button
                            variant="ghost"
                            size="sm"
                            className="h-7 text-xs gap-1"
                            onClick={() =>
                              setExpanded((prev) => ({ ...prev, [threat.id]: !isExpanded }))
                            }
                          >
                            {isExpanded ? (
                              <EyeOff className="h-3 w-3" />
                            ) : (
                              <Eye className="h-3 w-3" />
                            )}
                            {isExpanded
                              ? t("admin.security.hideEvidence")
                              : t("admin.security.showEvidence")}
                          </Button>
                          {threat.status !== "resolved" ? (
                            <>
                              {threat.status === "open" ? (
                                <Button
                                  variant="outline"
                                  size="sm"
                                  className="h-7 text-xs"
                                  disabled={statusMutation.isPending}
                                  onClick={() =>
                                    statusMutation.mutate({ id: threat.id, status: "acknowledged" })
                                  }
                                >
                                  {t("admin.security.acknowledge")}
                                </Button>
                              ) : null}
                              <Button
                                variant="outline"
                                size="sm"
                                className="h-7 text-xs"
                                disabled={statusMutation.isPending}
                                onClick={() => statusMutation.mutate({ id: threat.id, status: "resolved" })}
                              >
                                {t("admin.security.resolve")}
                              </Button>
                            </>
                          ) : null}
                        </div>
                      </div>
                      {isExpanded ? (
                        <div className="mt-3 border-t border-border/60 pt-3">
                          <p className="text-[10px] font-semibold text-muted-foreground mb-1.5 uppercase">
                            {t("admin.security.evidenceJson")}
                          </p>
                          <JsonInspector value={threat.evidence} />
                        </div>
                      ) : null}
                    </div>
                  );
                })
              )}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Blocklist manager */}
      <Card className="mt-4">
        <CardHeader className="pb-3">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <CardTitle className="text-base font-semibold">{t("admin.security.blocklistTitle")}</CardTitle>
              <CardDescription className="text-xs">{t("admin.security.blocklistDesc")}</CardDescription>
            </div>
            <Button
              size="sm"
              className="h-8 gap-1.5 text-xs"
              onClick={() => setBlockDialogOpen(true)}
            >
              <Ban className="h-3.5 w-3.5" />
              {t("admin.security.addBlock")}
            </Button>
          </div>
        </CardHeader>
        <CardContent>
          {blocklistQuery.isError ? (
            <ErrorAlert
        title={t("admin.security.title")}
              message={errorMessage(blocklistQuery.error, t("admin.security.loadError"))}
              onRetry={() => void blocklistQuery.refetch()}
            />
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="text-xs">{t("admin.security.thTarget")}</TableHead>
                  <TableHead className="text-xs">{t("admin.security.thReason")}</TableHead>
                  <TableHead className="text-xs">{t("admin.security.thExpires")}</TableHead>
                  <TableHead className="text-xs">{t("admin.security.thCreated")}</TableHead>
                  <TableHead className="text-xs text-end">{t("admin.security.thActions")}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {blocklist.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={5} className="text-center py-8 text-muted-foreground text-xs">
                      {t("admin.security.noBlocks")}
                    </TableCell>
                  </TableRow>
                ) : (
                  blocklist.map((entry) => (
                    <TableRow key={entry.id} className="hover:bg-muted/30 transition-colors">
                      <TableCell>
                        <div className="flex flex-col gap-1">
                          <Badge variant="outline" className="font-mono text-[10px] w-fit">
                            {t(`admin.security.targetType.${entry.targetType}`)}
                          </Badge>
                          <span className="font-mono text-xs break-all">{entry.targetValue}</span>
                          <span className="text-[10px] text-muted-foreground font-mono">
                            {t("admin.security.thStatus")}:{" "}
                            <span className={entry.active ? "text-emerald-700 dark:text-emerald-400" : "text-muted-foreground"}>
                              {entry.active ? t("common.active") : t("admin.security.status.inactive")}
                            </span>
                          </span>
                        </div>
                      </TableCell>
                      <TableCell className="text-xs text-muted-foreground max-w-xs">{entry.reason}</TableCell>
                      <TableCell className="font-mono text-[11px] text-muted-foreground whitespace-nowrap">
                        {formatDate(entry.expiresAt)}
                      </TableCell>
                      <TableCell className="font-mono text-[11px] text-muted-foreground whitespace-nowrap">
                        {formatDate(entry.createdAt)}
                      </TableCell>
                      <TableCell className="text-end">
                        <Button
                          variant="outline"
                          size="sm"
                          className="h-7 text-xs"
                          disabled={unblockMutation.isPending}
                          onClick={() => unblockMutation.mutate(entry.id)}
                        >
                          {t("admin.security.unblock")}
                        </Button>
                      </TableCell>
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      {/* Global immutable audit log explorer */}
      <Card className="mt-4">
        <CardHeader className="pb-3">
          <CardTitle className="text-base font-semibold">{t("admin.security.auditTitle")}</CardTitle>
          <CardDescription className="text-xs">{t("admin.security.auditDesc")}</CardDescription>
          <div className="flex flex-col gap-2 pt-3 sm:flex-row sm:items-center">
            <div className="relative flex-1">
              <Search className="absolute start-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
              <Input
                className="ps-8 h-9 text-xs"
                placeholder={t("admin.security.auditSearch")}
                value={filters.orgId}
                onChange={(e) => setFilters((prev) => ({ ...prev, orgId: e.target.value }))}
              />
            </div>
            <Input
              className="h-9 text-xs sm:w-48"
              placeholder={t("admin.security.actionPlaceholder")}
              value={filters.action}
              onChange={(e) => setFilters((prev) => ({ ...prev, action: e.target.value }))}
            />
            <div className="w-full sm:w-36">
              <Select
                value={filters.outcome}
                onValueChange={(value) => setFilters((prev) => ({ ...prev, outcome: value }))}
              >
                <SelectTrigger className="h-9 text-xs">
                  <SelectValue placeholder={t("admin.security.outcome")} />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">{t("admin.security.allOutcomes")}</SelectItem>
                  <SelectItem value="success">{t("admin.security.outcome.success")}</SelectItem>
                  <SelectItem value="denied">{t("admin.security.outcome.denied")}</SelectItem>
                  <SelectItem value="error">{t("admin.security.outcome.error")}</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <Button size="sm" className="h-9 text-xs" onClick={() => setAppliedFilters(filters)}>
              {t("admin.security.applyFilters")}
            </Button>
            <Button
              size="sm"
              variant="outline"
              className="h-9 text-xs"
              onClick={() => {
                const empty: AuditFilters = { orgId: "", action: "", outcome: "all" };
                setFilters(empty);
                setAppliedFilters(empty);
              }}
            >
              {t("admin.security.clearFilters")}
            </Button>
          </div>
        </CardHeader>
        <CardContent>
          {auditQuery.isError ? (
            <ErrorAlert
        title={t("admin.security.title")}
              message={errorMessage(auditQuery.error, t("admin.security.auditLoadError"))}
              onRetry={() => void auditQuery.refetch()}
            />
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="text-xs">{t("admin.security.thSeq")}</TableHead>
                  <TableHead className="text-xs">{t("admin.security.thTimestamp")}</TableHead>
                  <TableHead className="text-xs">{t("admin.security.thAction")}</TableHead>
                  <TableHead className="text-xs">{t("admin.security.thActor")}</TableHead>
                  <TableHead className="text-xs">{t("admin.security.thOrg")}</TableHead>
                  <TableHead className="text-xs">{t("admin.security.thOutcome")}</TableHead>
                  <TableHead className="text-xs text-end">{t("admin.security.thDetails")}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {auditLogs.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={7} className="text-center py-8 text-muted-foreground text-xs">
                      {t("admin.security.noAuditLogs")}
                    </TableCell>
                  </TableRow>
                ) : (
                  auditLogs.map((log) => (
                    <TableRow key={log.id} className="hover:bg-muted/30 transition-colors">
                      <TableCell className="font-mono text-[11px] text-muted-foreground">#{log.seq}</TableCell>
                      <TableCell className="font-mono text-[11px] text-muted-foreground whitespace-nowrap">
                        {formatDate(log.createdAt)}
                      </TableCell>
                      <TableCell>
                        <Badge variant="outline" className="font-mono text-[10px]">
                          {log.action}
                        </Badge>
                      </TableCell>
                      <TableCell>
                        <div className="flex flex-col">
                          <span className="font-mono text-[11px]">{log.actorId ?? "-"}</span>
                          <span className="text-[10px] text-muted-foreground">{log.actorRealm}</span>
                        </div>
                      </TableCell>
                      <TableCell className="font-mono text-[11px] text-muted-foreground">
                        {log.orgId ?? "-"}
                      </TableCell>
                      <TableCell>
                        <Badge
                          variant="outline"
                          className={`font-mono text-[10px] ${
                            log.outcome === "success"
                              ? "text-emerald-700 dark:text-emerald-400 border-emerald-500/30 bg-emerald-500/5"
                              : log.outcome === "denied"
                                ? "text-amber-700 dark:text-amber-400 border-amber-500/30 bg-amber-500/5"
                                : "text-rose-700 dark:text-rose-400 border-rose-500/30 bg-rose-500/5"
                          }`}
                        >
                          {t(`admin.security.outcome.${log.outcome}`)}
                        </Badge>
                      </TableCell>
                      <TableCell className="text-end">
                        <Button
                          size="sm"
                          variant="ghost"
                          className="h-7 text-xs gap-1"
                          onClick={() => setSelectedLog(log)}
                        >
                          <ChevronRight className="h-3 w-3" />
                          {t("admin.security.viewDetails")}
                        </Button>
                      </TableCell>
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      {/* Block creation dialog */}
      <Dialog open={blockDialogOpen} onOpenChange={setBlockDialogOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle className="text-base font-semibold">{t("admin.security.createBlockTitle")}</DialogTitle>
            <DialogDescription className="text-xs">{t("admin.security.createBlockDesc")}</DialogDescription>
          </DialogHeader>
          <div className="space-y-3 py-2">
            <div className="space-y-1.5">
              <Label className="text-xs" htmlFor="block-target-type">{t("admin.security.targetType")}</Label>
              <Select value={targetType} onValueChange={(value) => setTargetType(value as BlockTargetType)}>
                <SelectTrigger id="block-target-type" className="h-9 text-xs">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="ip">{t("admin.security.targetType.ip")}</SelectItem>
                  <SelectItem value="api_key_id">{t("admin.security.targetType.api_key_id")}</SelectItem>
                  <SelectItem value="org_id">{t("admin.security.targetType.org_id")}</SelectItem>
                  <SelectItem value="project_id">{t("admin.security.targetType.project_id")}</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs" htmlFor="block-target-value">{t("admin.security.targetValue")}</Label>
              <Input
                id="block-target-value"
                className="h-9 text-xs"
                placeholder={t("admin.security.targetPlaceholder")}
                value={targetValue}
                onChange={(e) => setTargetValue(e.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs" htmlFor="block-reason">{t("admin.security.reason")}</Label>
              <Textarea
                id="block-reason"
                className="text-xs min-h-20"
                placeholder={t("admin.security.reasonPlaceholder")}
                value={blockReason}
                onChange={(e) => setBlockReason(e.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs" htmlFor="block-expiry">{t("admin.security.expiresAt")}</Label>
              <Input
                id="block-expiry"
                type="datetime-local"
                className="h-9 text-xs"
                value={expiresAt}
                onChange={(e) => setExpiresAt(e.target.value)}
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" size="sm" onClick={() => setBlockDialogOpen(false)}>
              {t("common.cancel")}
            </Button>
            <Button size="sm" disabled={blockMutation.isPending} onClick={handleCreateBlock}>
              {t("admin.security.createBlock")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Audit event detail dialog */}
      {selectedLog !== null ? (
        <Dialog open onOpenChange={(open) => { if (!open) setSelectedLog(null); }}>
          <DialogContent className="max-w-lg">
            <DialogHeader>
              <DialogTitle className="font-mono text-sm">
                {t("admin.security.auditEventTitle", { seq: selectedLog.seq })}
              </DialogTitle>
              <DialogDescription className="text-xs">
                {t("admin.security.thAction")}: {selectedLog.action} · {selectedLog.resourceType} ·{" "}
                {selectedLog.resourceId ?? "-"}
              </DialogDescription>
            </DialogHeader>
            <div className="space-y-3 py-2 text-xs">
              <div className="grid grid-cols-2 gap-2 rounded-lg border border-border/60 bg-muted/30 p-3 font-mono">
                <div>
                  <span className="block text-[10px] text-muted-foreground">{t("admin.security.thActor")}</span>
                  <span className="font-semibold">{selectedLog.actorId ?? "-"}</span>
                </div>
                <div>
                  <span className="block text-[10px] text-muted-foreground">{t("admin.security.thOrg")}</span>
                  <span className="font-semibold">{selectedLog.orgId ?? "-"}</span>
                </div>
                <div>
                  <span className="block text-[10px] text-muted-foreground">{t("admin.security.prevHash")}</span>
                  <span className="font-semibold break-all">{selectedLog.prevHash}</span>
                </div>
                <div>
                  <span className="block text-[10px] text-muted-foreground">{t("admin.security.entryHash")}</span>
                  <span className="font-semibold break-all">{selectedLog.entryHash}</span>
                </div>
              </div>
              <div>
                <span className="mb-1.5 block text-xs font-semibold text-muted-foreground">
                  {t("admin.security.auditDetails")}
                </span>
                <JsonInspector value={selectedLog.details} />
              </div>
              <div className="flex items-center gap-1.5 rounded-md border border-rose-500/20 bg-rose-500/5 p-2 font-mono text-[11px] text-rose-700 dark:text-rose-400">
                <Lock className="h-3.5 w-3.5 shrink-0" />
                <span>{t("admin.security.zeroCustomerData")}</span>
              </div>
            </div>
            <DialogFooter>
              <Button size="sm" onClick={() => setSelectedLog(null)}>{t("common.close")}</Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      ) : null}
    </PageContent>
  );
}

/* -------------------------------------------------------------------------- */
/* Chain proof sub-panel                                                      */
/* -------------------------------------------------------------------------- */

interface ChainProofPanelProps {
  title: string;
  proof: ChainVerification;
  validLabel: string;
  invalidLabel: string;
  checkedLabel: string;
  corruptLabel: string;
  reasonLabel: string;
  noneLabel: string;
}

function ChainProofPanel({
  title,
  proof,
  validLabel,
  invalidLabel,
  checkedLabel,
  corruptLabel,
  reasonLabel,
  noneLabel,
}: ChainProofPanelProps): React.JSX.Element {
  return (
    <div className="rounded-lg border border-border/60 bg-muted/20 p-3 space-y-1.5">
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs font-semibold">{title}</span>
        <Badge
          variant="outline"
          className={`font-mono text-[10px] ${
            proof.valid
              ? "text-emerald-700 dark:text-emerald-400 border-emerald-500/30 bg-emerald-500/5"
              : "text-rose-700 dark:text-rose-400 border-rose-500/30 bg-rose-500/5"
          }`}
        >
          {proof.valid ? validLabel : invalidLabel}
        </Badge>
      </div>
      <p className="font-mono text-[11px] text-muted-foreground">
        {tChecked(checkedLabel, proof.totalChecked)}
      </p>
      <p className="font-mono text-[11px] text-muted-foreground">
        {corruptLabel}: {proof.firstCorruptedSeq === null ? noneLabel : `#${proof.firstCorruptedSeq}`}
      </p>
      <p className="font-mono text-[11px] text-muted-foreground">
        {reasonLabel}: {proof.reason ?? noneLabel}
      </p>
    </div>
  );
}

/** Keeps the proof panel free of i18n context so it stays a pure presentational component. */
function tChecked(label: string, count: number): string {
  return label.replace("{count}", String(count));
}
