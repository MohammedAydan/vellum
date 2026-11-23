import * as React from "react";
import { createRoute } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Route as appRoute } from "../_app.js";
import { adminFetch } from "../../lib/api.js";
import {
  PageHeader,
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
  Table,
  TableHeader,
  TableBody,
  TableHead,
  TableRow,
  TableCell,
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
  JsonViewer,
  LoadingState,
  ErrorState,
  useI18n,
  type Locale,
} from "@vellum/ui";
import {
  Wallet,
  TrendingUp,
  CreditCard,
  Database,
  Activity,
  ArrowUpRight,
  Search,
  RefreshCw,
  FileText,
  Ban,
  CheckCircle2,
  Pencil,
  Coins,
  Lock,
} from "lucide-react";
import { toast } from "sonner";

export const Route = createRoute({
  getParentRoute: () => appRoute,
  path: "/billing",
  component: BillingControlCenterPage,
});

/* -------------------------------------------------------------------------- */
/* Wire shapes — exact responses from apps/api/src/routes/fortress.ts §6.2     */
/* -------------------------------------------------------------------------- */

type SubscriptionStatus = "active" | "past_due" | "suspended" | "canceled";

interface UsageTotals {
  docReads: number;
  docWrites: number;
  docDeletes: number;
  storageBytes: number;
  egressBytes: number;
  authMau: number;
  peakConcurrentWs: number;
}

interface TopOrgMetric {
  orgId: string;
  orgName: string;
  value: number;
}

interface BillingOverview {
  billingMonth: string;
  mrrCents: number;
  projectedOverageCents: number;
  activeSubscriptions: number;
  topOrgs: {
    reads: TopOrgMetric[];
    writes: TopOrgMetric[];
    egress: TopOrgMetric[];
  };
  nearCapOrgs: Array<{
    orgId: string;
    projectedCostCents: number;
    spendCapCents: number;
  }>;
}

interface BillingOrg {
  orgId: string;
  orgName: string;
  planId: string;
  planName: string;
  status: SubscriptionStatus;
  monthlySpendCapCents: number | null;
  quotaOverride: Record<string, unknown>;
  usage: UsageTotals;
  totalCents: number;
  overageCents: number;
}

interface InvoiceSummary {
  id: string;
  invoiceNumber: string;
  orgId: string;
  billingMonth: string;
  planId: string;
  baseAmountCents: number;
  overageAmountCents: number;
  creditsAppliedCents: number;
  totalAmountCents: number;
  status: "draft" | "open" | "paid" | "void" | "uncollectible";
  issuedAt: string | null;
}

interface InvoiceGenerationResult {
  billingMonth: string;
  invoices: InvoiceSummary[];
  failed: Array<{ orgId: string; reason: string }>;
}

type OrgMutationKind = "credit" | "quota";

interface OrgMutationTarget {
  kind: OrgMutationKind;
  org: BillingOrg;
}

/* -------------------------------------------------------------------------- */
/* Helpers                                                                    */
/* -------------------------------------------------------------------------- */

function errorMessage(err: unknown, fallback: string): string {
  return err instanceof Error && err.message ? err.message : fallback;
}

function createFormatters(locale: Locale) {
  const moneyFormatter = new Intl.NumberFormat(locale, {
    style: "currency",
    currency: "USD",
  });
  const integerFormatter = new Intl.NumberFormat(locale);
  const decimalFormatter = new Intl.NumberFormat(locale, { maximumFractionDigits: 2 });

  return {
    money: (cents: number): string => moneyFormatter.format(cents / 100),
    count: (value: number): string => integerFormatter.format(value),
    egress: (bytes: number): string => `${decimalFormatter.format(bytes / 1_073_741_824)} GB`,
  };
}

function statusClass(status: SubscriptionStatus): string {
  if (status === "active") return "text-emerald-700 dark:text-emerald-400 border-emerald-500/30 bg-emerald-500/5";
  if (status === "past_due") return "text-amber-700 dark:text-amber-400 border-amber-500/30 bg-amber-500/5";
  if (status === "suspended") return "text-rose-700 dark:text-rose-400 border-rose-500/30 bg-rose-500/5";
  return "text-muted-foreground border-border/60 bg-muted/30";
}

/* -------------------------------------------------------------------------- */
/* Page                                                                       */
/* -------------------------------------------------------------------------- */

function BillingControlCenterPage() {
  const { t, locale } = useI18n();
  const queryClient = useQueryClient();
  const format = React.useMemo(() => createFormatters(locale), [locale]);

  const [search, setSearch] = React.useState("");
  const [orgAction, setOrgAction] = React.useState<OrgMutationTarget | null>(null);
  const [creditAmount, setCreditAmount] = React.useState("");
  const [creditDescription, setCreditDescription] = React.useState("");
  const [quotaJson, setQuotaJson] = React.useState("{}");
  const [invoiceDialogOpen, setInvoiceDialogOpen] = React.useState(false);
  const [invoiceResult, setInvoiceResult] = React.useState<InvoiceGenerationResult | null>(null);

  const invalidateAll = React.useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: ["admin-billing"] });
  }, [queryClient]);

  const overviewQuery = useQuery({
    queryKey: ["admin-billing", "overview"],
    queryFn: () => adminFetch<BillingOverview>("/v1/admin/billing/overview"),
  });

  const orgsQuery = useQuery({
    queryKey: ["admin-billing", "orgs"],
    queryFn: async (): Promise<BillingOrg[]> => {
      const response = await adminFetch<{ billingMonth: string; orgs: BillingOrg[] }>(
        "/v1/admin/billing/orgs"
      );
      return response.orgs;
    },
  });

  const statusMutation = useMutation({
    mutationFn: async ({ orgId, status }: { orgId: string; status: "suspended" | "active" }): Promise<void> => {
      await adminFetch<{ subscription: unknown }>(
        `/v1/admin/billing/orgs/${encodeURIComponent(orgId)}/override`,
        { method: "PATCH", body: JSON.stringify({ status }) }
      );
    },
    onSuccess: () => {
      toast.success(t("admin.billing.statusUpdatedToast"));
      invalidateAll();
    },
    onError: (err) => toast.error(errorMessage(err, t("admin.billing.statusUpdateError"))),
  });

  const creditMutation = useMutation({
    mutationFn: async (org: BillingOrg): Promise<void> => {
      const amount = Number(creditAmount);
      if (!Number.isInteger(amount) || amount === 0) {
        throw new Error(t("admin.billing.creditInvalid"));
      }
      const body: {
        adjustmentAmountCents: number;
        adjustmentDescription?: string;
      } = {
        adjustmentAmountCents: amount,
        ...(creditDescription.trim() !== ""
          ? { adjustmentDescription: creditDescription.trim() }
          : {}),
      };
      await adminFetch<{ subscription: unknown; adjustmentAppended: boolean }>(
        `/v1/admin/billing/orgs/${encodeURIComponent(org.orgId)}/override`,
        { method: "PATCH", body: JSON.stringify(body) }
      );
    },
    onSuccess: () => {
      setOrgAction(null);
      setCreditAmount("");
      setCreditDescription("");
      toast.success(t("admin.billing.creditToast"));
      invalidateAll();
    },
    onError: (err) => toast.error(errorMessage(err, t("admin.billing.creditError"))),
  });

  const quotaMutation = useMutation({
    mutationFn: async (org: BillingOrg): Promise<void> => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(quotaJson) as unknown;
      } catch {
        throw new Error(t("admin.billing.quotaInvalid"));
      }
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
        throw new Error(t("admin.billing.quotaInvalid"));
      }
      await adminFetch<{ subscription: unknown; adjustmentAppended: boolean }>(
        `/v1/admin/billing/orgs/${encodeURIComponent(org.orgId)}/override`,
        { method: "PATCH", body: JSON.stringify({ quotaOverride: parsed as Record<string, unknown> }) }
      );
    },
    onSuccess: () => {
      setOrgAction(null);
      toast.success(t("admin.billing.quotaToast"));
      invalidateAll();
    },
    onError: (err) => toast.error(errorMessage(err, t("admin.billing.quotaError"))),
  });

  const invoiceMutation = useMutation({
    mutationFn: async (billingMonth: string): Promise<InvoiceGenerationResult> => {
      return adminFetch<InvoiceGenerationResult>("/v1/admin/billing/invoices/generate", {
        method: "POST",
        body: JSON.stringify({ billingMonth }),
      });
    },
    onSuccess: (result) => {
      setInvoiceDialogOpen(false);
      setInvoiceResult(result);
      toast.success(
        t("admin.billing.generateToast", {
          count: format.count(result.invoices.length),
          month: result.billingMonth,
        })
      );
      invalidateAll();
    },
    onError: (err) => toast.error(errorMessage(err, t("admin.billing.generateError"))),
  });

  const overview = overviewQuery.data;
  const orgs = orgsQuery.data ?? [];
  const isLoading = overviewQuery.isLoading || orgsQuery.isLoading;
  const queryError = overviewQuery.error ?? orgsQuery.error;

  const totalReads = orgs.reduce((sum, org) => sum + org.usage.docReads, 0);
  const totalWrites = orgs.reduce((sum, org) => sum + org.usage.docWrites, 0);
  const totalEgress = orgs.reduce((sum, org) => sum + org.usage.egressBytes, 0);

  const filteredOrgs = orgs.filter((org) => {
    const query = search.trim().toLowerCase();
    if (query === "") return true;
    return (
      org.orgName.toLowerCase().includes(query) ||
      org.orgId.toLowerCase().includes(query) ||
      org.planName.toLowerCase().includes(query)
    );
  });

  const openOrgAction = (kind: OrgMutationKind, org: BillingOrg): void => {
    setOrgAction({ kind, org });
    if (kind === "credit") {
      setCreditAmount("");
      setCreditDescription("");
    } else {
      setQuotaJson(JSON.stringify(org.quotaOverride, null, 2));
    }
  };

  if (isLoading) return <LoadingState rows={6} columns={5} />;
  if (queryError !== null && queryError !== undefined) {
    return (
      <ErrorState
        message={errorMessage(queryError, t("admin.billing.loadError"))}
        onRetry={() => {
          void overviewQuery.refetch();
          void orgsQuery.refetch();
        }}
      />
    );
  }
  if (overview === undefined) return <LoadingState rows={6} columns={5} />;

  return (
    <PageContent>
      <PageHeader
        title={t("admin.billing.title")}
        description={t("admin.billing.description")}
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <Badge
              variant="outline"
              className="font-mono text-[11px] border-rose-500/30 text-rose-700 dark:text-rose-400 bg-rose-500/5 gap-1 py-1"
            >
              <Lock className="h-3 w-3" />
              {t("common.privacyGuardActive")}
            </Badge>
            <Button
              size="sm"
              className="h-8 gap-1.5 text-xs"
              disabled={invoiceMutation.isPending}
              onClick={() => setInvoiceDialogOpen(true)}
            >
              <FileText className="h-3.5 w-3.5" />
              {t("admin.billing.generateInvoices")}
            </Button>
            <Button
              variant="outline"
              size="sm"
              className="h-8 gap-1.5 text-xs"
              onClick={() => {
                invalidateAll();
                void overviewQuery.refetch();
                void orgsQuery.refetch();
              }}
            >
              <RefreshCw className="h-3.5 w-3.5" />
              {t("common.refresh")}
            </Button>
          </div>
        }
      />

      <p className="text-xs text-muted-foreground font-mono mb-4">
        {t("admin.billing.billingMonth", { month: overview.billingMonth })} ·{" "}
        {t("admin.billing.activeSubscriptions")}: {format.count(overview.activeSubscriptions)}
      </p>

      {/* KPI cards */}
      <div className="grid gap-4 md:grid-cols-3 2xl:grid-cols-5">
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">{t("admin.billing.mrr")}</CardTitle>
            <Wallet className="h-4 w-4 text-emerald-700 dark:text-emerald-400" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold font-mono text-emerald-700 dark:text-emerald-400">
              {format.money(overview.mrrCents)}
            </div>
            <p className="text-xs text-muted-foreground mt-1">{t("admin.billing.mrrDesc")}</p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">{t("admin.billing.projectedOverage")}</CardTitle>
            <TrendingUp className="h-4 w-4 text-amber-700 dark:text-amber-400" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold font-mono text-amber-700 dark:text-amber-400">
              {format.money(overview.projectedOverageCents)}
            </div>
            <p className="text-xs text-muted-foreground mt-1">{t("admin.billing.overageDesc")}</p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">{t("admin.billing.platformReads")}</CardTitle>
            <Activity className="h-4 w-4 text-blue-700 dark:text-blue-400" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold font-mono">{format.count(totalReads)}</div>
            <p className="text-xs text-muted-foreground mt-1">{t("admin.billing.fromAllOrgs")}</p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">{t("admin.billing.platformWrites")}</CardTitle>
            <Database className="h-4 w-4 text-violet-500" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold font-mono">{format.count(totalWrites)}</div>
            <p className="text-xs text-muted-foreground mt-1">{t("admin.billing.fromAllOrgs")}</p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">{t("admin.billing.platformEgress")}</CardTitle>
            <ArrowUpRight className="h-4 w-4 text-cyan-500" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold font-mono">{format.egress(totalEgress)}</div>
            <p className="text-xs text-muted-foreground mt-1">{t("admin.billing.fromAllOrgs")}</p>
          </CardContent>
        </Card>
      </div>

      {/* Near-cap organizations and top consumers */}
      <div className="grid gap-4 md:grid-cols-2 mt-4">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium flex items-center gap-2">
              <CreditCard className="h-4 w-4 text-amber-700 dark:text-amber-400" />
              {t("admin.billing.nearCapOrgs")}
            </CardTitle>
            <CardDescription className="text-xs">{t("admin.billing.nearCapDesc")}</CardDescription>
          </CardHeader>
          <CardContent>
            {overview.nearCapOrgs.length === 0 ? (
              <p className="text-xs text-muted-foreground">{t("admin.billing.noNearCap")}</p>
            ) : (
              <div className="space-y-1.5">
                {overview.nearCapOrgs.map((org) => (
                  <div
                    key={org.orgId}
                    className="flex items-center justify-between gap-3 rounded-md border border-border/60 bg-muted/10 px-2.5 py-1.5"
                  >
                    <span className="font-mono text-[11px] truncate">{org.orgId}</span>
                    <span className="font-mono text-[11px] text-amber-700 dark:text-amber-400 whitespace-nowrap">
                      {format.money(org.projectedCostCents)} / {format.money(org.spendCapCents)}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium flex items-center gap-2">
              <TrendingUp className="h-4 w-4 text-blue-700 dark:text-blue-400" />
              {t("admin.billing.topOrgsTitle")}
            </CardTitle>
            <CardDescription className="text-xs">{t("admin.billing.topOrgsDesc")}</CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            <TopMetricList
              title={t("admin.billing.topReads")}
              rows={overview.topOrgs.reads}
              emptyLabel={t("admin.billing.noTopOrgs")}
              formatValue={format.count}
            />
            <TopMetricList
              title={t("admin.billing.topWrites")}
              rows={overview.topOrgs.writes}
              emptyLabel={t("admin.billing.noTopOrgs")}
              formatValue={format.count}
            />
            <TopMetricList
              title={t("admin.billing.topEgress")}
              rows={overview.topOrgs.egress}
              emptyLabel={t("admin.billing.noTopOrgs")}
              formatValue={format.egress}
            />
          </CardContent>
        </Card>
      </div>

      {/* Organization billing / quota table */}
      <Card className="mt-4">
        <CardHeader className="pb-3">
          <CardTitle className="text-base font-semibold">{t("admin.billing.orgsTitle")}</CardTitle>
          <CardDescription className="text-xs">{t("admin.billing.orgsDesc")}</CardDescription>
          <div className="relative pt-3">
            <Search className="absolute start-2.5 top-5.5 h-4 w-4 text-muted-foreground" />
            <Input
              className="ps-8 h-9 text-xs"
              placeholder={t("admin.billing.searchPlaceholder")}
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>
        </CardHeader>
        <CardContent>
          {orgsQuery.isError ? (
            <ErrorState
              message={errorMessage(orgsQuery.error, t("admin.billing.loadError"))}
              onRetry={() => void orgsQuery.refetch()}
            />
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="text-xs">{t("admin.billing.thOrg")}</TableHead>
                  <TableHead className="text-xs">{t("admin.billing.thPlan")}</TableHead>
                  <TableHead className="text-xs">{t("admin.billing.thStatus")}</TableHead>
                  <TableHead className="text-xs">{t("admin.billing.thUsage")}</TableHead>
                  <TableHead className="text-xs">{t("admin.billing.thSpend")}</TableHead>
                  <TableHead className="text-xs">{t("admin.billing.thQuota")}</TableHead>
                  <TableHead className="text-xs text-end">{t("admin.billing.thActions")}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {filteredOrgs.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={7} className="text-center py-8 text-muted-foreground text-xs">
                      {t("admin.billing.noOrgs")}
                    </TableCell>
                  </TableRow>
                ) : (
                  filteredOrgs.map((org) => (
                    <TableRow key={org.orgId} className="hover:bg-muted/30 transition-colors">
                      <TableCell>
                        <div className="flex flex-col">
                          <span className="text-xs font-semibold">{org.orgName}</span>
                          <span className="font-mono text-[10px] text-muted-foreground">{org.orgId}</span>
                        </div>
                      </TableCell>
                      <TableCell>
                        <Badge variant="outline" className="font-mono text-[10px] uppercase">
                          {org.planName}
                        </Badge>
                      </TableCell>
                      <TableCell>
                        <Badge variant="outline" className={`font-mono text-[10px] ${statusClass(org.status)}`}>
                          {t(`admin.billing.status.${org.status}`)}
                        </Badge>
                      </TableCell>
                      <TableCell className="font-mono text-[10px] text-muted-foreground whitespace-nowrap">
                        {t("admin.billing.usageValue", {
                          reads: format.count(org.usage.docReads),
                          writes: format.count(org.usage.docWrites),
                          egress: format.egress(org.usage.egressBytes),
                        })}
                      </TableCell>
                      <TableCell>
                        <div className="flex flex-col">
                          <span className="font-mono text-xs font-semibold">{format.money(org.totalCents)}</span>
                          <span className="font-mono text-[10px] text-amber-700 dark:text-amber-400">
                            +{format.money(org.overageCents)} {t("admin.billing.overageShort")}
                          </span>
                          {org.monthlySpendCapCents !== null ? (
                            <span className="font-mono text-[10px] text-muted-foreground">
                              {t("admin.billing.capShort")}: {format.money(org.monthlySpendCapCents)}
                            </span>
                          ) : null}
                        </div>
                      </TableCell>
                      <TableCell>
                        {Object.keys(org.quotaOverride).length === 0 ? (
                          <span className="text-[11px] text-muted-foreground">{t("admin.billing.noOverride")}</span>
                        ) : (
                          <Badge variant="outline" className="font-mono text-[10px] text-blue-700 dark:text-blue-400 border-blue-500/30">
                            {t("admin.billing.overrideNote")}
                          </Badge>
                        )}
                      </TableCell>
                      <TableCell>
                        <div className="flex flex-wrap justify-end gap-1.5">
                          <Button
                            variant="outline"
                            size="sm"
                            className="h-7 text-xs"
                            disabled={statusMutation.isPending}
                            onClick={() =>
                              statusMutation.mutate({
                                orgId: org.orgId,
                                status: org.status === "suspended" ? "active" : "suspended",
                              })
                            }
                          >
                            {org.status === "suspended" ? (
                              <CheckCircle2 className="h-3 w-3 me-1" />
                            ) : (
                              <Ban className="h-3 w-3 me-1" />
                            )}
                            {org.status === "suspended"
                              ? t("admin.billing.reactivate")
                              : t("admin.billing.suspend")}
                          </Button>
                          <Button
                            variant="outline"
                            size="sm"
                            className="h-7 text-xs"
                            onClick={() => openOrgAction("credit", org)}
                          >
                            <Coins className="h-3 w-3 me-1" />
                            {t("admin.billing.grantCredits")}
                          </Button>
                          <Button
                            variant="outline"
                            size="sm"
                            className="h-7 text-xs"
                            onClick={() => openOrgAction("quota", org)}
                          >
                            <Pencil className="h-3 w-3 me-1" />
                            {t("admin.billing.editQuota")}
                          </Button>
                        </div>
                      </TableCell>
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      {/* Invoice generation results */}
      {invoiceResult !== null ? (
        <Card className="mt-4">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium flex items-center gap-2">
              <FileText className="h-4 w-4 text-emerald-700 dark:text-emerald-400" />
              {t("admin.billing.invoicesTitle")}
            </CardTitle>
            <CardDescription className="text-xs">
              {t("admin.billing.invoicesDesc")} ·{" "}
              {t("admin.billing.billingMonth", { month: invoiceResult.billingMonth })}
            </CardDescription>
          </CardHeader>
          <CardContent>
            {invoiceResult.invoices.length === 0 ? (
              <p className="text-xs text-muted-foreground">{t("admin.billing.noInvoices")}</p>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="text-xs">{t("admin.billing.thInvoice")}</TableHead>
                    <TableHead className="text-xs">{t("admin.billing.thInvoiceOrg")}</TableHead>
                    <TableHead className="text-xs">{t("admin.billing.thBase")}</TableHead>
                    <TableHead className="text-xs">{t("admin.billing.thOverage")}</TableHead>
                    <TableHead className="text-xs">{t("admin.billing.thCredits")}</TableHead>
                    <TableHead className="text-xs">{t("admin.billing.thTotal")}</TableHead>
                    <TableHead className="text-xs">{t("admin.billing.thInvoiceStatus")}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {invoiceResult.invoices.map((invoice) => (
                    <TableRow key={invoice.id}>
                      <TableCell className="font-mono text-[11px]">{invoice.invoiceNumber}</TableCell>
                      <TableCell className="font-mono text-[11px] text-muted-foreground">{invoice.orgId}</TableCell>
                      <TableCell className="font-mono text-[11px]">{format.money(invoice.baseAmountCents)}</TableCell>
                      <TableCell className="font-mono text-[11px]">
                        {format.money(invoice.overageAmountCents)}
                      </TableCell>
                      <TableCell className="font-mono text-[11px]">
                        {format.money(invoice.creditsAppliedCents)}
                      </TableCell>
                      <TableCell className="font-mono text-xs font-semibold">
                        {format.money(invoice.totalAmountCents)}
                      </TableCell>
                      <TableCell>
                        <Badge variant="outline" className="font-mono text-[10px]">
                          {invoice.status}
                        </Badge>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
            {invoiceResult.failed.length > 0 ? (
              <div className="mt-3 rounded-md border border-rose-500/20 bg-rose-500/5 p-2.5">
                <p className="text-xs font-semibold text-rose-700 dark:text-rose-400 mb-1.5">{t("admin.billing.failedTitle")}</p>
                {invoiceResult.failed.map((failure) => (
                  <p key={failure.orgId} className="font-mono text-[11px] text-muted-foreground">
                    {t("admin.billing.failureReason", { orgId: failure.orgId, reason: failure.reason })}
                  </p>
                ))}
              </div>
            ) : null}
          </CardContent>
        </Card>
      ) : null}

      {/* Credit / quota dialogs */}
      {orgAction !== null ? (
        <Dialog open onOpenChange={(open) => { if (!open) setOrgAction(null); }}>
          <DialogContent className="max-w-md">
            <DialogHeader>
              <DialogTitle className="text-base font-semibold">
                {orgAction.kind === "credit"
                  ? t("admin.billing.creditTitle")
                  : t("admin.billing.quotaTitle")}
              </DialogTitle>
              <DialogDescription className="text-xs">
                {(orgAction.kind === "credit"
                  ? t("admin.billing.creditDesc")
                  : t("admin.billing.quotaDesc")) + ` ${orgAction.org.orgName}`}
              </DialogDescription>
            </DialogHeader>
            {orgAction.kind === "credit" ? (
              <div className="space-y-3 py-2">
                <div className="space-y-1.5">
                  <Label className="text-xs" htmlFor="credit-amount">
                    {t("admin.billing.creditAmount")}
                  </Label>
                  <Input
                    id="credit-amount"
                    type="number"
                    step={1}
                    className="h-9 text-xs font-mono"
                    placeholder="0"
                    value={creditAmount}
                    onChange={(e) => setCreditAmount(e.target.value)}
                  />
                </div>
                <div className="space-y-1.5">
                  <Label className="text-xs" htmlFor="credit-description">
                    {t("admin.billing.creditDescription")}
                  </Label>
                  <Textarea
                    id="credit-description"
                    className="text-xs min-h-20"
                    placeholder={t("admin.billing.creditDescriptionPlaceholder")}
                    value={creditDescription}
                    onChange={(e) => setCreditDescription(e.target.value)}
                  />
                </div>
                <div className="rounded-md border border-emerald-500/20 bg-emerald-500/5 p-2 font-mono text-[11px] text-emerald-700 dark:text-emerald-400">
                  {t("admin.billing.ledgerNote")}
                </div>
              </div>
            ) : (
              <div className="space-y-3 py-2">
                <div className="space-y-1.5">
                  <Label className="text-xs" htmlFor="quota-json">
                    {t("admin.billing.quotaField")}
                  </Label>
                  <Textarea
                    id="quota-json"
                    className="font-mono text-xs min-h-32"
                    value={quotaJson}
                    onChange={(e) => setQuotaJson(e.target.value)}
                  />
                </div>
                <div className="rounded-lg border border-border/60 bg-muted/20 p-2">
                  <p className="mb-1.5 text-[10px] font-semibold text-muted-foreground">
                    {t("admin.billing.currentQuota")}
                  </p>
                  <JsonViewer data={orgAction.org.quotaOverride} initialExpandedDepth={2} />
                </div>
              </div>
            )}
            <DialogFooter>
              <Button variant="outline" size="sm" onClick={() => setOrgAction(null)}>
                {t("common.cancel")}
              </Button>
              <Button
                size="sm"
                disabled={creditMutation.isPending || quotaMutation.isPending}
                onClick={() => {
                  if (orgAction.kind === "credit") creditMutation.mutate(orgAction.org);
                  else quotaMutation.mutate(orgAction.org);
                }}
              >
                {orgAction.kind === "credit"
                  ? t("admin.billing.creditConfirm")
                  : t("admin.billing.quotaConfirm")}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      ) : null}

      {/* Invoice generation confirmation */}
      <Dialog open={invoiceDialogOpen} onOpenChange={setInvoiceDialogOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle className="text-base font-semibold">
              {t("admin.billing.generateTitle", { month: overview.billingMonth })}
            </DialogTitle>
            <DialogDescription className="text-xs">{t("admin.billing.generateDesc")}</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" size="sm" onClick={() => setInvoiceDialogOpen(false)}>
              {t("common.cancel")}
            </Button>
            <Button
              size="sm"
              disabled={invoiceMutation.isPending}
              onClick={() => invoiceMutation.mutate(overview.billingMonth)}
            >
              {t("admin.billing.generateConfirm")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </PageContent>
  );
}

/* -------------------------------------------------------------------------- */
/* Top consumer sub-list                                                      */
/* -------------------------------------------------------------------------- */

interface TopMetricListProps {
  title: string;
  rows: TopOrgMetric[];
  emptyLabel: string;
  formatValue: (value: number) => string;
}

function TopMetricList({ title, rows, emptyLabel, formatValue }: TopMetricListProps): React.JSX.Element {
  return (
    <div>
      <p className="mb-1.5 text-[11px] font-semibold text-muted-foreground uppercase">{title}</p>
      {rows.length === 0 ? (
        <p className="text-xs text-muted-foreground">{emptyLabel}</p>
      ) : (
        <div className="space-y-1">
          {rows.slice(0, 5).map((row) => (
            <div key={row.orgId} className="flex items-center justify-between gap-2 text-xs">
              <span className="font-mono text-[10px] text-muted-foreground truncate">{row.orgName}</span>
              <span className="font-mono text-[11px] whitespace-nowrap">{formatValue(row.value)}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
