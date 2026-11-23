import * as React from "react";
import { createRoute, Link, useParams } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { Route as appRoute } from "../_app.js";
import { apiFetch } from "../../lib/api.js";
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
  Label,
  Badge,
  Switch,
  UsageProgressMeter,
  KpiMetricCard,
  DataTable,
  type DataTableColumn,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Tabs,
  TabsList,
  TabsTrigger,
  TabsContent,
  LoadingState,
  ErrorState,
  EmptyState,
  Alert,
  AlertTitle,
  AlertDescription,
  useI18n,
} from "@vellum/ui";
import { AlertTriangle, ArrowLeft, CreditCard, ShieldCheck } from "lucide-react";
import { toast } from "sonner";

export const Route = createRoute({
  getParentRoute: () => appRoute,
  path: "/app/orgs/$orgId/billing",
  component: OrgBillingPage,
});

/* Wire shapes returned by the locked `createFortressRoutes` endpoints. */
interface PlanInfo {
  id: string;
  name: string;
  monthlyBasePriceCents: number;
  hardLimitEnforced: boolean;
  includedDocReads: number;
  includedDocWrites: number;
  includedDocDeletes: number;
  includedStorageBytes: number;
  includedEgressBytes: number;
  includedAuthMau: number;
  maxConcurrentWs: number;
}

interface PlanRecord extends PlanInfo {
  createdAt: string;
}

interface UsageTotals {
  docReads: number;
  docWrites: number;
  docDeletes: number;
  storageBytes: number;
  egressBytes: number;
  authMau: number;
  peakConcurrentWs: number;
}

interface DailyUsagePoint {
  usageDate: string;
  docReads: number;
  docWrites: number;
  docDeletes: number;
  egressBytes: number;
}

interface QuotaDecision {
  allowed: boolean;
  statusCode?: number;
  code?: string;
  metric?: string;
  used?: number;
  limit?: number;
  currentCents?: number;
  capCents?: number;
  warningHeader?: "80%" | "95%";
}

interface BillingSummary {
  billingMonth: string;
  plan: PlanInfo | null;
  status: "active" | "past_due" | "suspended" | "canceled";
  billingEmail: string | null;
  usage: UsageTotals;
  quota: Record<string, QuotaDecision>;
  projectedCostCents: number;
  overageCostCents: number;
  spendCapCents: number | null;
  dailySeries: DailyUsagePoint[];
}

interface InvoiceRecord {
  id: string;
  invoiceNumber: string;
  billingMonth: string;
  baseAmountCents: number;
  overageAmountCents: number;
  creditsAppliedCents: number;
  totalAmountCents: number;
  status: "draft" | "open" | "paid" | "void" | "uncollectible";
  issuedAt: string | null;
  createdAt: string;
}

interface AuditLogRecord {
  seq: number;
  createdAt: string;
  action: string;
  actorId: string | null;
  resourceType: string;
  resourceId: string | null;
  outcome: "success" | "denied" | "error";
}

const BYTES_PER_GB = 1_073_741_824;

const moneyFormatters = new Map<string, Intl.NumberFormat>();

function formatMoney(cents: number, locale: string): string {
  let formatter = moneyFormatters.get(locale);
  if (!formatter) {
    formatter = new Intl.NumberFormat(locale, {
      style: "currency",
      currency: "USD",
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    });
    moneyFormatters.set(locale, formatter);
  }
  return formatter.format(cents / 100);
}

const integerFormatter = (value: number): string => value.toLocaleString("en-US");
const gbFormatter = (value: number): string => `${value.toFixed(2)} GB`;

/**
 * Shared usage meter. The visible bar is the canonical `UsageProgressMeter`;
 * the visually-hidden line preserves the locked "current / max (p%)" text that
 * downstream tooling reads from the rendered page.
 */
function BillingMeter({
  label,
  current,
  max,
  formatter = integerFormatter,
}: {
  label: string;
  current: number;
  max: number;
  formatter?: (value: number) => string;
}) {
  const percentage = Math.max(0, Math.min(100, max > 0 ? Math.round((current / max) * 100) : 0));
  return (
    <div className="space-y-1">
      <UsageProgressMeter label={label} used={current} limit={max} format={formatter} />
      <span className="sr-only">
        {formatter(current)} / {formatter(max)} ({percentage}%)
      </span>
    </div>
  );
}

function formatDate(value: string): string {
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? value : parsed.toLocaleDateString();
}

const KNOWN_PLAN_IDS = ["free", "pro", "enterprise"] as const;

function planLabel(plan: PlanRecord | undefined, id: string): string {
  if (plan !== undefined && plan.name !== "") return `${plan.name} (${id})`;
  return id;
}

function quotaMetricKey(operation: string): string {
  switch (operation) {
    case "read":
      return "billing.op.read";
    case "write":
      return "billing.op.write";
    case "delete":
      return "billing.op.delete";
    case "ws_connect":
      return "billing.op.ws_connect";
    case "auth_signup":
      return "billing.op.auth_signup";
    default:
      return operation;
  }
}

function OrgBillingPage() {
  const { orgId } = useParams({ from: Route.id });
  const { t, locale } = useI18n();
  const encodedOrgId = encodeURIComponent(orgId);
  const base = `/v1/console/orgs/${encodedOrgId}`;

  const [chartDays, setChartDays] = React.useState<14 | 30>(14);
  const [capEnabled, setCapEnabled] = React.useState(false);
  const [capDollars, setCapDollars] = React.useState("");
  const [capSaving, setCapSaving] = React.useState(false);
  const [planSaving, setPlanSaving] = React.useState(false);

  const summaryQuery = useQuery({
    queryKey: ["billing", "summary", orgId],
    queryFn: () => apiFetch<BillingSummary>(`${base}/billing/summary`),
  });

  const plansQuery = useQuery({
    queryKey: ["billing", "plans", orgId],
    queryFn: async () => {
      const res = await apiFetch<{ plans: PlanRecord[] }>(`${base}/billing/plans`);
      return Array.isArray(res.plans) ? res.plans : [];
    },
  });

  const invoicesQuery = useQuery({
    queryKey: ["billing", "invoices", orgId],
    queryFn: async () => {
      const res = await apiFetch<{ invoices: InvoiceRecord[] }>(`${base}/billing/invoices`);
      return Array.isArray(res.invoices) ? res.invoices : [];
    },
  });

  const auditQuery = useQuery({
    queryKey: ["billing", "audit-logs", orgId],
    queryFn: async () => {
      const res = await apiFetch<{ auditLogs: AuditLogRecord[] }>(
        `${base}/security/audit-logs`
      );
      return Array.isArray(res.auditLogs) ? res.auditLogs : [];
    },
  });

  React.useEffect(() => {
    const cap = summaryQuery.data?.spendCapCents ?? null;
    setCapEnabled(cap !== null);
    setCapDollars(cap === null ? "" : (cap / 100).toFixed(2));
  }, [summaryQuery.data?.spendCapCents]);

  // The shared DataTable renders its horizontal scroller as
  // `div[data-slot="table-container"]`, which is not in the tab order. At
  // 390px the invoice/audit tables scroll horizontally, so keyboard users
  // otherwise cannot reveal the hidden columns. DataTable exposes no prop for
  // that element, so add the tab stop here — no markup or layout is changed.
  const tablesRef = React.useRef<HTMLDivElement>(null);
  React.useEffect(() => {
    const root = tablesRef.current;
    if (!root) return;
    const scrollers = root.querySelectorAll<HTMLElement>('[data-slot="table-container"]');
    scrollers.forEach((scroller, index) => {
      scroller.setAttribute("tabindex", "0");
      scroller.setAttribute("role", "region");
      scroller.setAttribute(
        "aria-label",
        index === 0 ? t("billing.invoicesTitle") : t("billing.auditTitle")
      );
    });
  }, [t, invoicesQuery.data, auditQuery.data]);

  const data = summaryQuery.data;
  const plan = data?.plan ?? null;

  const series = React.useMemo(
    () => (data?.dailySeries ?? []).slice(-chartDays),
    [data?.dailySeries, chartDays]
  );
  const peak = React.useMemo(
    () =>
      Math.max(
        1,
        ...series.map((point) =>
          Math.max(point.docReads, point.docWrites, point.docDeletes)
        )
      ),
    [series]
  );

  const quota: Record<string, QuotaDecision> = data?.quota ?? {};
  const quotaEntries: Array<[string, QuotaDecision]> = Object.entries(quota);
  const blockedDecisions = quotaEntries.filter(([, decision]) => !decision.allowed);
  const thresholdDecisions = quotaEntries.filter(
    ([, decision]) => decision.allowed && decision.warningHeader !== undefined
  );

  const patchSubscription = async (body: Record<string, unknown>): Promise<void> => {
    await apiFetch(`${base}/billing/subscription`, {
      method: "PATCH",
      body: JSON.stringify(body),
    });
    await summaryQuery.refetch();
  };

  const saveCap = async () => {
    const amount = Number(capDollars);
    if (capEnabled && (capDollars.trim() === "" || !Number.isFinite(amount) || amount < 0)) {
      toast.error(t("billing.invalidCap"));
      return;
    }
    const monthlySpendCapCents: number | null = capEnabled ? Math.round(amount * 100) : null;
    setCapSaving(true);
    try {
      await patchSubscription({ monthlySpendCapCents });
      toast.success(
        capEnabled ? t("billing.spendCapSavedToast") : t("billing.spendCapRemovedToast")
      );
    } catch (error: unknown) {
      toast.error(error instanceof Error ? error.message : t("billing.spendCapFailed"));
    } finally {
      setCapSaving(false);
    }
  };

  const changePlan = async (planId: string) => {
    if (planId === plan?.id) return;
    setPlanSaving(true);
    try {
      await patchSubscription({ planId });
      toast.success(t("billing.planChangedToast", { plan: planId }));
    } catch (error: unknown) {
      toast.error(error instanceof Error ? error.message : t("billing.planChangeFailed"));
    } finally {
      setPlanSaving(false);
    }
  };

  if (summaryQuery.isLoading) return <LoadingState rows={6} columns={4} />;
  if (summaryQuery.isError || !data) {
    return (
      <ErrorState
        title={t("common.errorTitle")}
        message={t("billing.loadFailed")}
        onRetry={() => void summaryQuery.refetch()}
      />
    );
  }

  const planOptions = KNOWN_PLAN_IDS.map((id) => ({
    id,
    record: plansQuery.data?.find((candidate) => candidate.id === id),
  }));

  const invoiceColumns: DataTableColumn<InvoiceRecord>[] = [
    {
      id: "invoiceNumber",
      header: t("billing.invoiceNumber"),
      accessor: (invoice) => <span className="font-mono">{invoice.invoiceNumber}</span>,
      mono: true,
    },
    {
      id: "billingMonth",
      header: t("billing.invoiceMonth"),
      accessor: (invoice) => <span className="font-mono">{invoice.billingMonth}</span>,
      mono: true,
    },
    {
      id: "baseAmountCents",
      header: t("billing.invoiceBase"),
      accessor: (invoice) => <span className="font-mono">{formatMoney(invoice.baseAmountCents, locale)}</span>,
      mono: true,
    },
    {
      id: "overageAmountCents",
      header: t("billing.invoiceOverage"),
      accessor: (invoice) => <span className="font-mono">{formatMoney(invoice.overageAmountCents, locale)}</span>,
      mono: true,
    },
    {
      id: "totalAmountCents",
      header: t("billing.invoiceTotal"),
      accessor: (invoice) => (
        <span className="font-mono font-semibold">{formatMoney(invoice.totalAmountCents, locale)}</span>
      ),
      mono: true,
    },
    {
      id: "status",
      header: t("common.status"),
      accessor: (invoice) => (
        <Badge variant="outline" className="font-mono text-[10px] uppercase">
          {invoice.status}
        </Badge>
      ),
    },
    {
      id: "issuedAt",
      header: t("billing.invoiceIssued"),
      accessor: (invoice) => (
        <span className="font-mono">
          {invoice.issuedAt !== null ? formatDate(invoice.issuedAt) : "—"}
        </span>
      ),
      mono: true,
    },
  ];

  const auditColumns: DataTableColumn<AuditLogRecord>[] = [
    {
      id: "seq",
      header: t("billing.auditSeq"),
      accessor: (entry) => <span className="font-mono">{entry.seq}</span>,
      mono: true,
    },
    {
      id: "createdAt",
      header: t("billing.auditTime"),
      accessor: (entry) => <span className="font-mono">{formatDate(entry.createdAt)}</span>,
      mono: true,
    },
    {
      id: "action",
      header: t("billing.auditAction"),
      accessor: (entry) => <span className="font-mono">{entry.action}</span>,
      mono: true,
    },
    {
      id: "actorId",
      header: t("billing.auditActor"),
      accessor: (entry) => <span className="font-mono">{entry.actorId ?? "—"}</span>,
      mono: true,
    },
    {
      id: "resource",
      header: t("billing.auditResource"),
      accessor: (entry) => <span className="font-mono">{entry.resourceId ?? entry.resourceType}</span>,
      mono: true,
    },
    {
      id: "outcome",
      header: t("billing.auditOutcome"),
      accessor: (entry) => (
        <Badge
          variant={entry.outcome === "success" ? "secondary" : "destructive"}
          className="font-mono text-[10px] uppercase"
        >
          {t(`billing.outcome.${entry.outcome}`)}
        </Badge>
      ),
    },
  ];

  return (
    <PageContent>
      <div className="mb-1 flex items-center gap-2 text-xs text-muted-foreground">
        <Link to="/app" className="inline-flex items-center hover:text-foreground">
          <ArrowLeft className="me-1 h-3.5 w-3.5 rtl:rotate-180" />
          {t("billing.backOrgs")}
        </Link>
      </div>

      <ConfigurablePageHeader
        title={t("billing.title")}
        description={t("billing.description")}
        actions={
          <div className="flex items-center gap-2">
            <Badge variant="outline" className="font-mono text-xs">
              {t("billing.orgBadge", { id: orgId.slice(0, 8) })}
            </Badge>
            <Badge variant="secondary" className="font-mono text-xs">
              {t("billing.liveData")}
            </Badge>
          </div>
        }
      />

      {blockedDecisions.length > 0 && (
        <Alert className="mb-4 border-destructive/40 bg-destructive/10">
          <AlertTriangle className="h-4 w-4 text-destructive" />
          <AlertTitle className="text-xs font-semibold text-destructive">
            {t("billing.blockedTitle")}
          </AlertTitle>
          <AlertDescription className="space-y-1 text-xs text-muted-foreground">
            {blockedDecisions.map(([operation, decision]) => (
              <div key={operation}>
                {t("billing.blockedDetail", {
                  metric: t(quotaMetricKey(operation)),
                  code: decision.code ?? "QUOTA_EXCEEDED",
                  used: decision.used ?? 0,
                  limit: decision.limit ?? 0,
                })}
              </div>
            ))}
          </AlertDescription>
        </Alert>
      )}

      {thresholdDecisions.length > 0 && (
        <Alert className="mb-4 border-warning/40 bg-warning/10">
          <AlertTriangle className="h-4 w-4 text-warning" />
          <AlertTitle className="text-xs font-semibold text-warning-600 dark:text-warning-400">
            {t("billing.warningTitle")}
          </AlertTitle>
          <AlertDescription className="space-y-1 text-xs text-muted-foreground">
            {thresholdDecisions.map(([operation, decision]) => (
              <div key={operation}>
                {t("billing.warningDetail", {
                  metric: t(quotaMetricKey(operation)),
                  level: decision.warningHeader ?? "",
                  used: decision.used ?? 0,
                  limit: decision.limit ?? 0,
                })}
              </div>
            ))}
          </AlertDescription>
        </Alert>
      )}

      <div className="grid gap-6 lg:grid-cols-3">
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="flex items-center gap-2 text-base font-semibold">
              <CreditCard className="h-4 w-4 text-primary" />
              {t("billing.planCardTitle")}
            </CardTitle>
            <CardDescription className="text-xs">{t("billing.planCardDescription")}</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4 text-xs">
            <div className="flex items-center justify-between gap-3">
              <span className="text-muted-foreground">{t("billing.planName")}</span>
              <span className="font-mono font-semibold text-foreground">
                {plan !== null ? plan.name : t("billing.planNoName")}
              </span>
            </div>
            <div className="flex items-center justify-between gap-3">
              <span className="text-muted-foreground">{t("billing.statusLabel")}</span>
              <Badge variant="outline" className="font-mono text-[10px] uppercase">
                {t(`billing.status.${data.status}`)}
              </Badge>
            </div>
            <div className="flex items-center justify-between gap-3">
              <span className="text-muted-foreground">{t("billing.planBasePrice")}</span>
              <span className="font-mono font-semibold text-foreground">
                {formatMoney(plan?.monthlyBasePriceCents ?? 0, locale)}
              </span>
            </div>
            <div className="flex items-center justify-between gap-3">
              <span className="text-muted-foreground">{t("orgs.billingEmail")}</span>
              <span className="font-mono text-foreground">
                {data.billingEmail ?? t("billing.billingEmailMissing")}
              </span>
            </div>
            <div className="space-y-1.5 border-t border-border/60 pt-3">
              <Label htmlFor="billing-plan" className="text-xs">
                {t("billing.planSelectorLabel")}
              </Label>
              <Select
                value={plan?.id ?? ""}
                onValueChange={(value) => void changePlan(value)}
                disabled={planSaving}
              >
                <SelectTrigger id="billing-plan" className="h-8 text-xs">
                  <SelectValue placeholder={t("billing.planNoName")} />
                </SelectTrigger>
                <SelectContent>
                  {planOptions.map((option) => (
                    <SelectItem key={option.id} value={option.id} className="text-xs">
                      {planLabel(option.record, option.id)}
                      {option.record !== undefined
                        ? ` — ${formatMoney(option.record.monthlyBasePriceCents, locale)}`
                        : ""}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base font-semibold">{t("billing.projectedCost")}</CardTitle>
            <CardDescription className="text-xs">{t("billing.projectedDescription")}</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <span className="font-mono text-3xl font-bold text-foreground">
              {formatMoney(data.projectedCostCents, locale)}
            </span>
            <div className="flex items-center justify-between border-t border-border/60 pt-3 text-xs">
              <span className="text-muted-foreground">{t("billing.overageCost")}</span>
              <span className="font-mono font-semibold text-foreground">
                {formatMoney(data.overageCostCents, locale)}
              </span>
            </div>
            <p className="text-[11px] text-muted-foreground">{t("billing.overageDescription")}</p>
            <p className="font-mono text-[11px] text-muted-foreground">
              {t("billing.billingMonth", { month: data.billingMonth })}
            </p>
          </CardContent>
        </Card>
        <KpiMetricCard
          label={t("billing.overageCost")}
          value={formatMoney(data.overageCostCents, locale)}
          subtitle={t("billing.overageDescription")}
          icon={<CreditCard className="h-4 w-4 text-primary" />}
          mono
        />

        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="flex items-center gap-2 text-base font-semibold">
              <ShieldCheck className="h-4 w-4 text-primary" />
              {t("billing.spendCapTitle")}
            </CardTitle>
            <CardDescription className="text-xs">{t("billing.spendCapDescription")}</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="flex items-center justify-between gap-3">
              <Label htmlFor="billing-cap-enabled" className="text-xs">
                {t("billing.spendCapToggle")}
              </Label>
              <Switch
                id="billing-cap-enabled"
                checked={capEnabled}
                onCheckedChange={setCapEnabled}
                disabled={capSaving}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="billing-cap-amount" className="text-xs">
                {t("billing.spendCapAmount")}
              </Label>
              <Input
                id="billing-cap-amount"
                type="number"
                min="0"
                step="0.01"
                inputMode="decimal"
                placeholder={t("billing.spendCapAmountPlaceholder")}
                value={capDollars}
                onChange={(event) => setCapDollars(event.target.value)}
                disabled={!capEnabled || capSaving}
                className="h-8 text-xs"
              />
            </div>
            <div className="flex gap-2">
              <Button size="sm" onClick={() => void saveCap()} disabled={capSaving}>
                {capSaving
                  ? t("billing.saving")
                  : capEnabled
                    ? t("billing.spendCapSave")
                    : t("billing.spendCapRemove")}
              </Button>
            </div>
          </CardContent>
        </Card>
      </div>

      <Card className="mt-6">
        <CardHeader className="pb-3">
          <CardTitle className="text-base font-semibold">{t("billing.usageTitle")}</CardTitle>
          <CardDescription className="text-xs">
            {t("billing.usageDescription", { month: data.billingMonth })}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-5 md:grid-cols-2">
            <BillingMeter
              label={t("billing.metric.reads")}
              current={data.usage.docReads}
              max={plan?.includedDocReads ?? 0}
              formatter={integerFormatter}
            />
            <BillingMeter
              label={t("billing.metric.writes")}
              current={data.usage.docWrites}
              max={plan?.includedDocWrites ?? 0}
              formatter={integerFormatter}
            />
            <BillingMeter
              label={t("billing.metric.deletes")}
              current={data.usage.docDeletes}
              max={plan?.includedDocDeletes ?? 0}
              formatter={integerFormatter}
            />
            <BillingMeter
              label={t("billing.metric.storage")}
              current={data.usage.storageBytes / BYTES_PER_GB}
              max={(plan?.includedStorageBytes ?? 0) / BYTES_PER_GB}
              formatter={gbFormatter}
            />
            <BillingMeter
              label={t("billing.metric.egress")}
              current={data.usage.egressBytes / BYTES_PER_GB}
              max={(plan?.includedEgressBytes ?? 0) / BYTES_PER_GB}
              formatter={gbFormatter}
            />
            <BillingMeter
              label={t("billing.metric.mau")}
              current={data.usage.authMau}
              max={plan?.includedAuthMau ?? 0}
              formatter={integerFormatter}
            />
            <BillingMeter
              label={t("billing.metric.ws")}
              current={data.usage.peakConcurrentWs}
              max={plan?.maxConcurrentWs ?? 0}
              formatter={integerFormatter}
            />
          </div>
          {plan === null && (
            <p className="text-xs text-muted-foreground">{t("billing.noPlanQuota")}</p>
          )}
        </CardContent>
      </Card>

      <Card className="mt-6">
        <CardHeader className="pb-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <CardTitle className="text-base font-semibold">
                {t("billing.chartTitle", { days: chartDays })}
              </CardTitle>
              <CardDescription className="text-xs">{t("billing.chartDescription")}</CardDescription>
            </div>
            <div className="flex gap-1">
              <Button
                size="sm"
                variant={chartDays === 14 ? "default" : "outline"}
                onClick={() => setChartDays(14)}
                className="h-7 text-[11px]"
              >
                {t("billing.chartDays14")}
              </Button>
              <Button
                size="sm"
                variant={chartDays === 30 ? "default" : "outline"}
                onClick={() => setChartDays(30)}
                className="h-7 text-[11px]"
              >
                {t("billing.chartDays30")}
              </Button>
            </div>
          </div>
        </CardHeader>
        <CardContent>
          {series.length === 0 ? (
            <EmptyState
              title={t("billing.chartEmptyTitle")}
              description={t("billing.chartEmptyDescription")}
            />
          ) : (
            <div className="space-y-3">
              <div className="flex h-56 items-end gap-1 overflow-x-auto rounded-md border border-border/60 bg-muted/10 p-3">
                {series.map((point, index) => (
                  <div
                    key={`${point.usageDate}-${index}`}
                    className="flex h-full min-w-[12px] flex-1 items-end justify-center gap-px"
                    title={t("billing.chartTooltip", {
                      date: point.usageDate,
                      reads: point.docReads,
                      writes: point.docWrites,
                      deletes: point.docDeletes,
                    })}
                  >
                    <div
                      className="w-1/3 rounded-t-sm bg-primary"
                      style={{ height: `${(point.docReads / peak) * 100}%` }}
                    />
                    <div
                      className="w-1/3 rounded-t-sm bg-success"
                      style={{ height: `${(point.docWrites / peak) * 100}%` }}
                    />
                    <div
                      className="w-1/3 rounded-t-sm bg-warning"
                      style={{ height: `${(point.docDeletes / peak) * 100}%` }}
                    />
                  </div>
                ))}
              </div>
              <div className="flex flex-wrap gap-4 text-[11px] text-muted-foreground">
                <span className="inline-flex items-center gap-1.5">
                  <span className="h-2 w-2 rounded-sm bg-primary" />
                  {t("billing.chartReads")}
                </span>
                <span className="inline-flex items-center gap-1.5">
                  <span className="h-2 w-2 rounded-sm bg-success" />
                  {t("billing.chartWrites")}
                </span>
                <span className="inline-flex items-center gap-1.5">
                  <span className="h-2 w-2 rounded-sm bg-warning" />
                  {t("billing.chartDeletes")}
                </span>
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      <Card className="mt-6">
        <CardHeader className="pb-3">
          <CardTitle className="text-base font-semibold">{t("billing.quotaTitle")}</CardTitle>
          <CardDescription className="text-xs">{t("billing.quotaDescription")}</CardDescription>
        </CardHeader>
        <CardContent>
          {quotaEntries.length === 0 ? (
            <p className="text-xs text-muted-foreground">{t("billing.noPlanQuota")}</p>
          ) : (
            <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
              {quotaEntries.map(([operation, decision]) => (
                <div
                  key={operation}
                  className="flex items-center justify-between gap-2 rounded-md border border-border/60 bg-muted/20 p-2 text-xs"
                >
                  <span className="font-medium text-foreground">
                    {t(quotaMetricKey(operation))}
                  </span>
                  <div className="flex items-center gap-2">
                    <span className="font-mono text-[11px] text-muted-foreground">
                      {decision.used === undefined || decision.limit === undefined
                        ? t("billing.quotaNotReported")
                        : t("billing.quotaUsedLimit", { used: decision.used, limit: decision.limit })}
                    </span>
                    <Badge
                      variant={decision.allowed ? "secondary" : "destructive"}
                      className="font-mono text-[10px]"
                    >
                      {decision.allowed
                        ? t("billing.quotaAllowed")
                        : t("billing.quotaBlocked")}
                    </Badge>
                  </div>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      <Tabs ref={tablesRef} defaultValue="invoices" className="mt-6 space-y-4">
        <TabsList>
          <TabsTrigger value="invoices">{t("billing.invoicesTab")}</TabsTrigger>
          <TabsTrigger value="audit">{t("billing.auditTab")}</TabsTrigger>
        </TabsList>

        <TabsContent value="invoices" forceMount className="data-[state=inactive]:hidden">
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-base font-semibold">{t("billing.invoicesTitle")}</CardTitle>
              <CardDescription className="text-xs">{t("billing.invoicesDescription")}</CardDescription>
            </CardHeader>
            <CardContent>
              {invoicesQuery.isLoading ? (
                <LoadingState rows={3} columns={5} />
              ) : invoicesQuery.isError ? (
                <ErrorState
                  title={t("common.errorTitle")}
                  message={t("billing.loadFailedSection")}
                  onRetry={() => void invoicesQuery.refetch()}
                />
              ) : (invoicesQuery.data ?? []).length === 0 ? (
                <EmptyState
                  title={t("billing.invoiceEmptyTitle")}
                  description={t("billing.invoiceEmptyDescription")}
                />
              ) : (
                <DataTable
                  rows={invoicesQuery.data ?? []}
                  columns={invoiceColumns}
                  getRowId={(invoice) => invoice.id}
                />
              )}
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="audit" forceMount className="data-[state=inactive]:hidden">
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-base font-semibold">{t("billing.auditTitle")}</CardTitle>
              <CardDescription className="text-xs">{t("billing.auditDescription")}</CardDescription>
            </CardHeader>
            <CardContent>
              {auditQuery.isLoading ? (
                <LoadingState rows={4} columns={5} />
              ) : auditQuery.isError ? (
                <ErrorState
                  title={t("common.errorTitle")}
                  message={t("billing.loadFailedSection")}
                  onRetry={() => void auditQuery.refetch()}
                />
              ) : (auditQuery.data ?? []).length === 0 ? (
                <EmptyState
                  icon={<ShieldCheck className="h-10 w-10 text-muted-foreground/60" />}
                  title={t("billing.auditEmptyTitle")}
                  description={t("billing.auditEmptyDescription")}
                />
              ) : (
                <DataTable
                  rows={auditQuery.data ?? []}
                  columns={auditColumns}
                  getRowId={(entry) => `${entry.seq}-${entry.createdAt}`}
                />
              )}
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </PageContent>
  );
}
