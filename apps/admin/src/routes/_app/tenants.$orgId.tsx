import * as React from "react";
import { createRoute, Link, useNavigate, useParams } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { Route as appRoute } from "../_app.js";
import { adminFetch } from "../../lib/api.js";
import {
  ConfigurablePageHeader,
  ConsoleCopyableField,
  ConsoleDetailSheet,
  ConfirmDangerDialog,
  DataTable,
  ErrorAlert,
  LoadingState,
  OrgProjectBreadcrumb,
  PageContent,
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
  CardFooter,
  Button,
  Input,
  Label,
  Badge,
  Alert,
  AlertTitle,
  AlertDescription,
  StatusBadge,
  Tabs,
  TabsList,
  TabsTrigger,
  TabsContent,
  useI18n,
  type DataTableColumn,
} from "@vellum/ui";
import {
  ArrowLeft,
  Building2,
  Lock,
  Save,
  Ban,
  CheckCircle2,
  FolderGit2,
  KeyRound,
  FileCode2,
} from "lucide-react";
import { toast } from "sonner";

export const Route = createRoute({
  getParentRoute: () => appRoute,
  path: "/tenants/$orgId",
  component: TenantDetailPage,
});

interface TenantProjectMeta {
  id: string;
  name: string;
  slug?: string;
  documentCount?: number;
  storageMb?: number;
  compositeIndexesCount?: number;
  rulesetVersion?: number;
}

function TenantDetailPage() {
  const { orgId } = useParams({ from: Route.id });
  const navigate = useNavigate();
  const { t } = useI18n();

  interface TenantDetail {
    id: string;
    name: string;
    slug: string;
    billingEmail: string;
    plan: string;
    status: "active" | "suspended";
    storageMb: number;
    dailyReads: number;
    dailyWrites: number;
    projectsCount: number;
    createdAt: string;
    projects: TenantProjectMeta[];
  }

  const {
    data: tenant,
    isLoading,
    isError,
    error,
    refetch,
  } = useQuery({
    queryKey: ["admin", "tenant", orgId],
    queryFn: () => adminFetch<TenantDetail>(`/v1/admin/tenants/${orgId}`),
  });

  React.useEffect(() => {
    if (tenant) {
      setStatus(tenant.status);
    }
  }, [tenant]);

  const [status, setStatus] = React.useState<"active" | "suspended">("active");
  const security = useQuery({
    queryKey: ["admin", "tenant-security", orgId],
    queryFn: () => adminFetch<{ observedAt: string; source: string; projects: Array<{id: string; publishableKeys: number; secretKeys: number; rulesetVersion: number | null; rulesPublishedAt: string | null}> }>(`/v1/admin/tenants/${orgId}/security-metadata`),
  });
  const [confirmOpen, setConfirmOpen] = React.useState(false);
  const [inspectedProject, setInspectedProject] = React.useState<TenantProjectMeta | null>(null);

  const handleToggleSuspend = async () => {
    const next = status === "active" ? "suspended" : "active";
    const action = next === "suspended" ? "suspend" : "reactivate";
    try {
      await adminFetch(`/v1/admin/tenants/${orgId}/${action}`, { method: "POST" });
      setStatus(next);
      await refetch();
      toast.success(
        next === "suspended"
          ? t("admin.tenantDetail.suspendToast", { name: tenant?.name ?? "" })
          : t("admin.tenantDetail.restoreToast", { name: tenant?.name ?? "" })
      );
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : t("admin.tenantDetail.updateError"));
    }
  };

  if (isLoading) return <LoadingState rows={4} columns={3} />;
  if (isError || !tenant) {
    return (
      <ErrorAlert
        title={t("admin.tenantDetail.title", { name: orgId })}
        message={error instanceof Error ? error.message : t("admin.tenantDetail.notFound")}
        onRetry={() => void refetch()}
      />
    );
  }

  const projects: TenantProjectMeta[] = tenant.projects ?? [];

  const projectColumns: DataTableColumn<TenantProjectMeta>[] = [
    {
      id: "project",
      header: t("admin.tenantDetail.thProject"),
      accessor: (project) => (
        <Badge variant="outline" className="font-mono text-[10px]">
          {project.name}
        </Badge>
      ),
    },
    {
      id: "documents",
      header: t("admin.tenantDetail.thDocumentCount"),
      mono: true,
      align: "end",
      accessor: (project) => `${(project.documentCount ?? 0).toLocaleString()}${t("admin.tenantDetail.docsSuffix")}`,
    },
    {
      id: "storage",
      header: t("admin.tenantDetail.thStorage"),
      mono: true,
      align: "end",
      accessor: (project) =>
        (project.storageMb ?? 0) >= 1000
          ? `${((project.storageMb ?? 0) / 1024).toFixed(2)} GB`
          : `${project.storageMb ?? 0} MB`,
    },
    {
      id: "indexes",
      header: t("admin.tenantDetail.thCompositeIndexes"),
      mono: true,
      align: "end",
      accessor: (project) => `${project.compositeIndexesCount ?? 0}${t("admin.tenantDetail.definedSuffix")}`,
    },
    {
      id: "ruleset",
      header: t("admin.tenantDetail.thRulesetVersion"),
      mono: true,
      align: "end",
      accessor: (project) => security.isError ? t("admin.truth.unknown") : (() => { const version = security.data?.projects.find(p => p.id === project.id)?.rulesetVersion; return version ? `v${version}` : security.isLoading ? t("admin.truth.unknown") : t("admin.truth.notConfigured"); })(),
    },
  ];


  return (
    <PageContent>
      <div className="flex items-center space-x-2 text-xs text-muted-foreground mb-1">
        <Link
          to="/tenants"
          className="hover:text-foreground inline-flex items-center transition-colors"
        >
          <ArrowLeft className="h-3.5 w-3.5 me-1" />
          {t("admin.tenantDetail.back")}
        </Link>
      </div>

      <ConfigurablePageHeader
        breadcrumb={
          <OrgProjectBreadcrumb
            orgName={t("admin.tenants.title")}
            orgId={orgId}
            onSelectOrg={() => void navigate({ to: "/tenants" })}
          />
        }
        title={t("admin.tenantDetail.title", { name: tenant.name })}
        description={t("admin.tenantDetail.description")}
        actions={
          <div className="flex items-center gap-2">
            <StatusBadge status={status} label={t("admin.tenantDetail.status", { status })} />
            <Badge variant="outline" className="font-mono text-xs uppercase">
              {t("admin.tenantDetail.plan", { plan: tenant.plan })}
            </Badge>
          </div>
        }
      />

      {/* Strict Privacy Guard Banner */}
      <Alert className="border-rose-500/40 bg-rose-500/5">
        <Lock className="h-4 w-4 text-rose-700 dark:text-rose-400" />
        <AlertTitle className="text-xs font-semibold text-rose-700 dark:text-rose-400">
          {t("admin.tenantDetail.privacyTitle")}
        </AlertTitle>
        <AlertDescription className="text-xs text-muted-foreground">
          {t("admin.tenantDetail.privacyDesc")}
        </AlertDescription>
      </Alert>

      {/* Tabs Layout */}
      <Tabs defaultValue="quotas" className="w-full space-y-4">
        <TabsList className="grid w-full grid-cols-3 max-w-md">
          <TabsTrigger value="quotas">{t("admin.tenantDetail.tabQuotas")}</TabsTrigger>
          <TabsTrigger value="projects">{t("admin.tenantDetail.tabProjects")}</TabsTrigger>
          <TabsTrigger value="security">{t("admin.tenantDetail.tabSecurity")}</TabsTrigger>
        </TabsList>

        {/* Tab 1: Quotas & Metadata */}
        <TabsContent value="quotas" className="space-y-4">
          <div className="grid gap-6 md:grid-cols-2">
            <Card>
              <CardHeader>
                <CardTitle className="text-base font-semibold flex items-center gap-2">
                  <Building2 className="h-4 w-4 text-primary" />
                  <span>{t("admin.tenantDetail.orgMetadata")}</span>
                </CardTitle>
                <CardDescription className="text-xs">
                  {t("admin.tenantDetail.orgMetadataDesc")}
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-3 text-xs">
                <div className="py-1.5">
                  <ConsoleCopyableField label={t("admin.tenantDetail.orgId")} value={tenant.id} />
                </div>
                <div className="flex justify-between py-1.5 border-b border-border/60">
                  <span className="text-muted-foreground">{t("admin.tenantDetail.displayName")}</span>
                  <span className="font-medium">{tenant.name}</span>
                </div>
                <div className="flex justify-between py-1.5 border-b border-border/60">
                  <span className="text-muted-foreground">{t("admin.tenantDetail.slug")}</span>
                  <span className="font-mono font-medium">{tenant.slug}</span>
                </div>
                <div className="flex justify-between py-1.5 border-b border-border/60">
                  <span className="text-muted-foreground">{t("admin.tenantDetail.billingContact")}</span>
                  <span className="font-medium">{tenant.billingEmail}</span>
                </div>
                <div className="flex justify-between py-1.5 border-b border-border/60">
                  <span className="text-muted-foreground">{t("admin.tenantDetail.registered")}</span>
                  <span className="font-mono text-muted-foreground">
                    {new Date(tenant.createdAt).toLocaleDateString()}
                  </span>
                </div>
                <div className="flex justify-between py-1.5">
                  <span className="text-muted-foreground">{t("admin.tenantDetail.provisionedProjects")}</span>
                  <span className="font-medium">{tenant.projectsCount}{t("admin.tenantDetail.projectsSuffix")}</span>
                </div>
              </CardContent>
            </Card>

            {/* Quota Management & Suspension */}
            <Card>
              <CardHeader>
                <CardTitle className="text-base font-semibold">{t("admin.tenantDetail.quotaTitle")}</CardTitle>
                <CardDescription className="text-xs">
                  {t("admin.tenantDetail.quotaDesc")}
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-4 text-xs">
                <div className="space-y-1.5">
                  <Label htmlFor="qReads" className="text-xs">{t("admin.tenantDetail.dailyReadsLimit")}</Label>
                  <Input
                    id="qReads"
                    value={tenant.dailyReads} readOnly
                    className="font-mono text-xs h-8"
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="qWrites" className="text-xs">{t("admin.tenantDetail.dailyWritesLimit")}</Label>
                  <Input
                    id="qWrites"
                    value={tenant.dailyWrites} readOnly
                    className="font-mono text-xs h-8"
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="qStorage" className="text-xs">{t("admin.tenantDetail.storageLimitGb")}</Label>
                  <Input
                    id="qStorage"
                    value={tenant.storageMb} readOnly
                    className="font-mono text-xs h-8"
                  />
                </div>
              </CardContent>
              <CardFooter className="flex flex-wrap gap-2 justify-between border-t border-border/60 pt-3">
                <Button asChild variant="outline" size="sm"><Link to="/billing">{t("admin.billing.navLabel")}</Link></Button>
                <Button
                  variant={status === "active" ? "destructive" : "outline"}
                  size="sm"
                  aria-haspopup="dialog"
                  className="text-xs text-red-700 dark:text-red-300"
                  onClick={() => setConfirmOpen(true)}
                >
                  {status === "active" ? (
                    <>
                      <Ban className="me-1 size-3.5" />
                      {t("admin.tenantDetail.suspendTenant")}
                    </>
                  ) : (
                    <>
                      <CheckCircle2 className="me-1 size-3.5" />
                      {t("admin.tenantDetail.activateTenant")}
                    </>
                  )}
                </Button>

                <Button size="sm" onClick={() => void refetch()} className="text-xs">
                  <Save className="me-1 size-3.5" />
                  {t("common.refresh")}
                </Button>
              </CardFooter>
            </Card>
          </div>
        </TabsContent>

        {/* Tab 2: Project metadata */}
        <TabsContent value="projects" className="space-y-4">
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-base font-semibold flex items-center gap-2">
                <FolderGit2 className="h-4 w-4 text-primary" />
                <span>{t("admin.tenantDetail.projectsTitle")}</span>
              </CardTitle>
              <CardDescription className="text-xs">
                {t("admin.tenantDetail.projectsDesc")}
              </CardDescription>
            </CardHeader>
            <CardContent>
              <div className="space-y-6">
                {projects.length === 0 ? (
                  <div className="p-8 text-center text-sm text-muted-foreground">
                    {t("admin.tenantDetail.noProjects")}
                  </div>
                ) : (
                  projects.map((project) => (
                    <div key={project.id} className="space-y-2">
                      <div className="flex items-center justify-between border-b border-border/60 pb-1">
                        <div className="font-semibold text-xs flex items-center gap-1.5">
                          <button
                            type="button"
                            className="text-foreground underline-offset-4 hover:underline"
                            onClick={() => setInspectedProject(project)}
                          >
                            {project.name}
                          </button>
                          <span className="font-mono text-[10px] text-muted-foreground">({project.id})</span>
                        </div>
                      </div>

                      <DataTable
                        rows={[project]}
                        columns={projectColumns}
                        getRowId={(project) => project.id}
                      />
                    </div>
                  ))
                )}
              </div>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="security" className="space-y-4">
          <Card><CardHeader><CardTitle>{t("admin.tenantDetail.tabSecurity")}</CardTitle>
            <CardDescription>{t("admin.truth.metadataOnly")}</CardDescription></CardHeader>
            <CardContent className="space-y-4 text-xs">
              {security.isError || security.isLoading ? <p role="status">{t("admin.truth.unknown")}</p> : <>
                <p className="text-muted-foreground">{security.data?.source} · {security.data?.observedAt}</p>
                {security.data?.projects.map(project => <div key={project.id} className="space-y-2 rounded border p-3">
                  <p className="font-semibold">{projects.find(p=>p.id===project.id)?.name ?? project.id}</p>
                  <p><FileCode2 className="inline size-4 me-2" />{t("admin.tenantDetail.activeRulesetVersion")}: {project.rulesetVersion ? `v${project.rulesetVersion}` : t("admin.truth.notConfigured")}</p>
                  <p>{t("admin.truth.publishedAt")}: {project.rulesPublishedAt ?? t("admin.truth.notConfigured")}</p>
                  <p><KeyRound className="inline size-4 me-2" />{t("admin.tenantDetail.activePublishableKeys")}: {project.publishableKeys}</p>
                  <p>{t("admin.tenantDetail.activeSecretKeys")}: {project.secretKeys}</p>
                </div>)}
                {!projects.length && <p>{t("admin.tenantDetail.noProjects")}</p>}
              </>}
              <Button variant="outline" size="sm" onClick={()=>void security.refetch()}>{t("common.refresh")}</Button>
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>

      <ConfirmDangerDialog
        open={confirmOpen}
        onOpenChange={setConfirmOpen}
        title={
          status === "active"
            ? t("admin.tenantDetail.suspendTitle")
            : t("admin.tenantDetail.reactivateTitle")
        }
        description={
          status === "active"
            ? t("admin.tenantDetail.suspendDesc")
            : t("admin.tenantDetail.reactivateDesc")
        }
        confirmLabel={t("common.confirm")}
        onConfirm={() => void handleToggleSuspend()}
      />

      <ConsoleDetailSheet
        open={inspectedProject !== null}
        onOpenChange={(open) => {
          if (!open) setInspectedProject(null);
        }}
        title={inspectedProject?.name ?? ""}
        description={t("admin.tenantDetail.projectsDesc")}
      >
        <div className="space-y-3">
          <ConsoleCopyableField label={t("admin.tenantDetail.orgId")} value={inspectedProject?.id ?? ""} />
          <DataTable
            rows={inspectedProject ? [inspectedProject] : []}
            columns={projectColumns}
            getRowId={(project) => project.id}
          />
        </div>
      </ConsoleDetailSheet>
    </PageContent>
  );
}
