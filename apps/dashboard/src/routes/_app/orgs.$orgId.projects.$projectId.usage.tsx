import { createRoute, useParams } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { Route as appRoute } from "../_app.js";
import {
  consoleFetch,
  consoleProjectsBase,
  type ConsoleQueryResponse,
  type ConsoleIndex,
  type ConsoleApiKey,
} from "../../lib/api.js";
import {
  ConfigurablePageHeader,
  PageContent,
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
  Badge,
  KpiMetricCard,
  UsageProgressMeter,
  UsageChart,
  type UsageMetricPoint,
  LoadingState,
  ErrorState,
  EmptyState,
  useI18n,
} from "@vellum/ui";
import { Database, HardDrive, Layers, KeyRound } from "lucide-react";

export const Route = createRoute({
  getParentRoute: () => appRoute,
  path: "/app/orgs/$orgId/projects/$projectId/usage",
  component: ProjectUsagePage,
});

const PLAN_DOC_LIMIT = 100_000;

function ProjectUsagePage() {
  const { projectId } = useParams({ from: Route.id });
  const { t } = useI18n();
  const base = consoleProjectsBase(projectId);

  // Live document count pulled through the session-authenticated Console API.
  const documentsQuery = useQuery({
    queryKey: ["usage", "docs", projectId],
    queryFn: async () => {
      const res = await consoleFetch<ConsoleQueryResponse<Record<string, unknown>>>(
        `${base}/documents/users?limit=500`
      );
      return res.documents?.length ?? 0;
    },
  });

  const infraQuery = useQuery({
    queryKey: ["usage", "infra", projectId],
    queryFn: async () => {
      const [indexes, keys] = await Promise.all([
        consoleFetch<{ indexes?: ConsoleIndex[] }>(`${base}/indexes`),
        consoleFetch<ConsoleApiKey[]>(`${base}/api-keys`),
      ]);
      return {
        indexes: indexes.indexes?.length ?? 0,
        keys: Array.isArray(keys) ? keys.filter((k) => !k.revokedAt).length : 0,
      };
    },
  });

  const isLoading = documentsQuery.isLoading || infraQuery.isLoading;
  const isError = documentsQuery.isError || infraQuery.isError;
  const refetchAll = () => {
    void documentsQuery.refetch();
    void infraQuery.refetch();
  };

  const totalDocuments = documentsQuery.data ?? 0;
  const totalIndexes = infraQuery.data?.indexes ?? 0;
  const totalKeys = infraQuery.data?.keys ?? 0;
  const hasAnyData = totalDocuments > 0 || totalIndexes > 0 || totalKeys > 0;

  const distribution: UsageMetricPoint[] = [
    {
      timestamp: projectId.slice(0, 8),
      reads: totalDocuments,
      writes: totalIndexes,
    },
  ];

  if (isLoading) return <LoadingState rows={4} columns={4} />;
  if (isError) {
    return (
      <ErrorState
        title={t("common.errorTitle")}
        message={t("usage.error")}
        onRetry={refetchAll}
      />
    );
  }

  return (
    <PageContent>
      <ConfigurablePageHeader
        title={t("usage.title")}
        description={t("usage.description")}
        actions={
          <div className="flex items-center gap-2">
            <Badge variant="outline" className="font-mono text-xs">{t("usage.projectBadge", { id: projectId.slice(0, 8) })}</Badge>
            <Badge variant="secondary" className="font-mono text-xs">{t("usage.liveData")}</Badge>
          </div>
        }
      />

      {!hasAnyData ? (
        <EmptyState
          icon={<HardDrive className="h-10 w-10 text-muted-foreground/60" />}
          title={t("usage.emptyTitle")}
          description={t("usage.emptyDescription")}
        />
      ) : (
        <>
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
            <KpiMetricCard
              label={t("usage.documentsSample")}
              value={totalDocuments.toLocaleString()}
              delta={t("usage.documentsDelta")}
              deltaTone="neutral"
              mono
            />
            <KpiMetricCard
              label={t("nav.compositeIndexes")}
              value={totalIndexes.toLocaleString()}
              delta={t("usage.indexesDelta")}
              deltaTone="neutral"
              mono
            />
            <KpiMetricCard
              label={t("usage.activeKeys")}
              value={totalKeys.toLocaleString()}
              delta={t("usage.keysDelta")}
              deltaTone="neutral"
              mono
            />
          </div>

          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-base font-semibold">{t("usage.quotaTitle")}</CardTitle>
              <CardDescription className="text-xs">
                {t("usage.quotaDescription", { limit: PLAN_DOC_LIMIT.toLocaleString() })}
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="grid gap-4 md:grid-cols-2">
                <div className="space-y-2 rounded-lg bg-muted/30 p-3">
                  <div className="flex items-center gap-2 text-xs font-semibold text-foreground">
                    <Database className="size-4 text-primary" />
                    <span>{t("usage.documentOperations")}</span>
                  </div>
                  <UsageProgressMeter label={t("usage.sampledDocuments")} used={totalDocuments} limit={PLAN_DOC_LIMIT} />
                  <UsageProgressMeter label={t("usage.compositeIndexesQuota")} used={totalIndexes} limit={500} />
                </div>
                <div className="space-y-2 rounded-lg bg-muted/30 p-3">
                  <div className="flex items-center gap-2 text-xs font-semibold text-foreground">
                    <KeyRound className="size-4 text-primary" />
                    <span>{t("usage.credentials")}</span>
                  </div>
                  <UsageProgressMeter label={t("usage.activeKeysQuota")} used={totalKeys} limit={200} />
                </div>
              </div>
            </CardContent>
          </Card>

          <div className="grid gap-6 lg:grid-cols-2">
            <UsageChart
              title={t("usage.chartTitle")}
              data={distribution}
              type="area"
              metrics={[
                { key: "reads", label: t("usage.chartDocuments"), color: "var(--chart-2)" },
                { key: "writes", label: t("usage.chartIndexes"), color: "var(--chart-1)" },
              ]}
              height={260}
            />
            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="text-base font-semibold flex items-center gap-2">
                  <Layers className="h-4 w-4 text-primary" /> {t("usage.breakdown")}
                </CardTitle>
                <CardDescription className="text-xs">{t("usage.breakdownDescription")}</CardDescription>
              </CardHeader>
              <CardContent className="space-y-2 text-xs">
                <div className="flex items-center justify-between border-b border-border/60 py-1.5">
                  <span className="font-mono font-medium">{projectId.slice(0, 8)}</span>
                  <span className="font-mono text-muted-foreground">
                    {t("usage.rowSummary", { docs: totalDocuments, indexes: totalIndexes, keys: totalKeys })}
                  </span>
                </div>
              </CardContent>
            </Card>
          </div>
        </>
      )}
    </PageContent>
  );
}
