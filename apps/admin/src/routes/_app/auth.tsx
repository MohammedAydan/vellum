import * as React from "react";
import { createRoute } from "@tanstack/react-router";
import { useQuery, useQueryClient, type UseQueryResult } from "@tanstack/react-query";
import { type ColumnDef } from "@tanstack/react-table";
import { Route as appRoute } from "../_app.js";
import { adminFetch } from "../../lib/api.js";
import {
  LoadingState,
  ErrorState,
  EmptyState,
  DataGrid,
  PageContent,
  PageHeader,
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
  Separator,
  Alert,
  AlertTitle,
  AlertDescription,
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
  AlertDialog,
  AlertDialogContent,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogAction,
  AlertDialogCancel,
  useI18n,
} from "@vellum/ui";
import { toast } from "sonner";
import {
  Lock,
  Users,
  ShieldAlert,
  KeyRound,
  RefreshCw,
  Search,
  SlidersHorizontal,
  Activity,
  Globe2,
  Gauge,
  CheckCircle2,
  RotateCw,
} from "lucide-react";

export const Route = createRoute({
  getParentRoute: () => appRoute,
  path: "/auth",
  component: AuthControlCenterPage,
});

/* -------------------------------------------------------------------------- */
/* Types                                                                      */
/* -------------------------------------------------------------------------- */

type UnknownRecord = Record<string, unknown>;

interface AuthOverview {
  projectsWithAuth: number;
  suspendedProjects: number;
  totalEndUsers: number;
  globalSignupsEnabled: boolean;
  generatedAt: string;
}

interface AuthConfigView {
  id: string;
  projectId: string;
  authServiceSuspended: boolean;
  suspensionReason: string | null;
  maxUsersQuota: number;
  maxSignupsPerHour: number;
  enableEmailPassword: boolean;
  requireEmailVerification: boolean;
  enableAnonymousAuth: boolean;
  enableTotpMfa: boolean;
  enableUserProjection: boolean;
  projectionCollectionPath: string;
  passwordMinLength: number;
  passwordRequireUppercase: boolean;
  passwordRequireNumber: boolean;
  passwordRequireSymbol: boolean;
  accessTokenTtlSeconds: number;
  refreshTokenTtlDays: number;
  jwtKeyId: string;
  jwtPublicKeyPem: string;
  oauthProviders: UnknownRecord;
  hasCustomSmtpConfig: boolean;
  createdAt: string;
  updatedAt: string;
}

interface AuthProjectRow {
  projectId: string;
  projectName: string | null;
  projectSlug: string | null;
  organizationId: string | null;
  projectStatus: string | null;
  auth: AuthConfigView;
  /** Current user count from the project user directory; null when unavailable. */
  currentUsers: number | null;
  currentUsersApproximate: boolean;
}

interface ProjectsPayload {
  rows: AuthProjectRow[];
}

interface PlatformSettings {
  id: number;
  globalSignupsEnabled: boolean;
  defaultMaxUsersPerFreeProject: number;
  defaultMaxUsersPerProProject: number;
  platformSmtpHost: string | null;
  platformSmtpPort: number | null;
  platformSmtpUser: string | null;
  platformSmtpFromEmail: string;
  platformSmtpConfigured: boolean;
  updatedAt: string;
}

type RowAction =
  | { kind: "quota"; row: AuthProjectRow }
  | { kind: "suspend"; row: AuthProjectRow; suspend: boolean }
  | { kind: "rotate"; row: AuthProjectRow };

/* -------------------------------------------------------------------------- */
/* Helpers                                                                    */
/* -------------------------------------------------------------------------- */

function errorMessage(err: unknown, fallback: string): string {
  return err instanceof Error && err.message ? err.message : fallback;
}

function formatDate(value: string | null): string {
  if (!value) return "-";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "-" : date.toLocaleString();
}

/* -------------------------------------------------------------------------- */
/* Page                                                                       */
/* -------------------------------------------------------------------------- */

function AuthControlCenterPage() {
  const { t } = useI18n();
  const queryClient = useQueryClient();
  const [search, setSearch] = React.useState("");
  const [action, setAction] = React.useState<RowAction | null>(null);

  const invalidateAll = React.useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: ["admin-auth"] });
  }, [queryClient]);

  const overviewQuery = useQuery({
    queryKey: ["admin-auth", "overview"],
    queryFn: () => adminFetch<AuthOverview>("/v1/admin/auth/overview"),
  });

  const projectsQuery = useQuery({
    queryKey: ["admin-auth", "projects"],
    queryFn: async (): Promise<ProjectsPayload> => {
      const response = await adminFetch<{ projects: AuthProjectRow[] }>("/v1/admin/auth/projects");
      const projects = Array.isArray(response.projects) ? response.projects : [];

      const rows: AuthProjectRow[] = await Promise.all(
        projects.map(async (item) => {
          let currentUsers: number | null = null;
          let currentUsersApproximate = false;
          try {
            const params = new URLSearchParams({ limit: "500" });
            const directory = await adminFetch<{ users: unknown[]; nextCursor: string | null }>(
              `/v1/projects/${encodeURIComponent(item.projectId)}/auth/admin/users?${params.toString()}`
            );
            currentUsers = Array.isArray(directory.users) ? directory.users.length : 0;
            currentUsersApproximate = Boolean(directory.nextCursor);
          } catch {
            currentUsers = null;
          }
          return { ...item, currentUsers, currentUsersApproximate };
        })
      );
      return { rows };
    },
  });

  const settingsQuery = useQuery({
    queryKey: ["admin-auth", "settings"],
    queryFn: () => adminFetch<PlatformSettings>("/v1/admin/auth/settings"),
  });

  const rows = projectsQuery.data?.rows ?? [];
  const filteredRows = React.useMemo(() => {
    const needle = search.trim().toLowerCase();
    if (!needle) return rows;
    return rows.filter((row) =>
      [row.projectName, row.projectSlug, row.projectId, row.organizationId]
        .some((value) => (value ?? "").toLowerCase().includes(needle))
    );
  }, [rows, search]);

  const patchControl = async (row: AuthProjectRow, patch: UnknownRecord, successMessage: string) => {
    try {
      await adminFetch(
        `/v1/admin/auth/projects/${encodeURIComponent(row.projectId)}/control`,
        { method: "PATCH", body: JSON.stringify(patch) }
      );
      toast.success(successMessage);
      setAction(null);
      invalidateAll();
    } catch (err: unknown) {
      toast.error(errorMessage(err, t("adminAuth.quota.controlFailed")));
    }
  };

  const rotateKey = async (row: AuthProjectRow) => {
    try {
      const result = await adminFetch<{ jwtKeyId: string }>(
        `/v1/admin/auth/projects/${encodeURIComponent(row.projectId)}/rotate-signing-key`,
        { method: "POST" }
      );
      toast.success(t("adminAuth.quota.rotateToast", { keyId: result.jwtKeyId }));
      setAction(null);
      invalidateAll();
    } catch (err: unknown) {
      toast.error(errorMessage(err, t("adminAuth.quota.rotateFailed")));
    }
  };

  const columns: ColumnDef<AuthProjectRow, unknown>[] = [
    {
      id: "actions",
      header: t("adminAuth.common.actions"),
      cell: ({ row }) => {
        const item = row.original;
        return (
          <div className="flex flex-wrap items-center gap-1">
            <Button
              variant="outline"
              size="sm"
              className="h-7 px-2 text-[11px]"
              onClick={() => setAction({ kind: "quota", row: item })}
            >
              <Gauge className="me-1 h-3 w-3" />
              {t("adminAuth.quota.editQuota")}
            </Button>
            <Button
              variant={item.auth.authServiceSuspended ? "secondary" : "outline"}
              size="sm"
              className="h-7 px-2 text-[11px]"
              onClick={() => setAction({ kind: "suspend", row: item, suspend: !item.auth.authServiceSuspended })}
            >
              <ShieldAlert className="me-1 h-3 w-3" />
              {item.auth.authServiceSuspended ? t("adminAuth.quota.unsuspend") : t("adminAuth.quota.suspend")}
            </Button>
            <Button
              variant="outline"
              size="sm"
              className="h-7 px-2 text-[11px]"
              onClick={() => setAction({ kind: "rotate", row: item })}
            >
              <RotateCw className="me-1 h-3 w-3" />
              {t("adminAuth.quota.rotateKeys")}
            </Button>
          </div>
        );
      },
    },
    {
      accessorKey: "projectName",
      header: t("adminAuth.quota.thProject"),
      cell: ({ row }) => (
        <div className="min-w-0">
          <span className="block truncate text-xs font-medium text-foreground">
            {row.original.projectName ?? t("adminAuth.common.unknown")}
          </span>
          <span className="block truncate font-mono text-[10px] text-muted-foreground">
            {row.original.projectSlug ?? row.original.projectId}
          </span>
        </div>
      ),
    },
    {
      accessorKey: "organizationId",
      header: t("adminAuth.quota.thOrganization"),
      cell: ({ row }) => (
        <span className="font-mono text-[11px] text-muted-foreground">
          {row.original.organizationId ?? "-"}
        </span>
      ),
    },
    {
      id: "users",
      header: t("adminAuth.quota.thUsers"),
      cell: ({ row }) => {
        const { currentUsers, currentUsersApproximate, auth } = row.original;
        const current = currentUsers === null
          ? t("adminAuth.common.unknown")
          : `${currentUsersApproximate ? "≥" : ""}${currentUsers}`;
        return (
          <div>
            <span className="font-mono text-xs font-medium text-foreground">
              {t("adminAuth.quota.usersValue", { current, max: auth.maxUsersQuota.toLocaleString() })}
            </span>
            <span className="block text-[10px] text-muted-foreground">
              {Math.min(100, Math.round(((currentUsers ?? 0) / Math.max(1, auth.maxUsersQuota)) * 100))}% · {t("adminAuth.quota.currentUsersNote")}
            </span>
          </div>
        );
      },
    },
    {
      id: "signups",
      header: t("adminAuth.quota.thSignups"),
      cell: ({ row }) => (
        <span className="font-mono text-xs text-foreground">
          {row.original.auth.maxSignupsPerHour.toLocaleString()}
        </span>
      ),
    },
    {
      id: "status",
      header: t("adminAuth.quota.thStatus"),
      cell: ({ row }) => {
        const suspended = row.original.auth.authServiceSuspended;
        return (
          <Badge variant={suspended ? "destructive" : "secondary"} className="font-mono text-[10px] uppercase">
            {suspended ? t("adminAuth.quota.suspended") : t("adminAuth.quota.active")}
          </Badge>
        );
      },
    },
    {
      id: "key",
      header: t("adminAuth.quota.thKey"),
      cell: ({ row }) => (
        <span className="font-mono text-[10px] text-muted-foreground" title={row.original.auth.jwtKeyId}>
          {row.original.auth.jwtKeyId.slice(0, 14)}
        </span>
      ),
    },
  ];

  return (
    <PageContent>
      <PageHeader
        title={t("adminAuth.title")}
        description={t("adminAuth.description")}
        actions={
          <div className="flex items-center gap-2">
            <Badge
              variant="outline"
              className="gap-1 border-rose-500/30 bg-rose-500/5 py-1 font-mono text-[11px] text-rose-700 dark:text-rose-400"
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
                toast.success(t("adminAuth.metrics.refreshToast"));
              }}
            >
              <RefreshCw className="h-3.5 w-3.5" />
              {t("adminAuth.common.refresh")}
            </Button>
          </div>
        }
      />

      <Alert className="mb-4 border-rose-500/30 bg-rose-500/5">
        <Lock className="h-4 w-4 text-rose-700 dark:text-rose-400" />
        <AlertTitle className="text-xs font-semibold">{t("admin.privacy.guardActive")}</AlertTitle>
        <AlertDescription className="text-xs text-muted-foreground">{t("adminAuth.privacyNote")}</AlertDescription>
      </Alert>

      {/* 1. Global metrics */}
      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
        {overviewQuery.isLoading ? (
          <LoadingState rows={2} columns={4} />
        ) : overviewQuery.isError ? (
          <ErrorState
            message={errorMessage(overviewQuery.error, t("adminAuth.metrics.loadError"))}
            onRetry={() => void overviewQuery.refetch()}
          />
        ) : (
          <>
            <MetricCard
              icon={<Globe2 className="h-4 w-4 text-emerald-700 dark:text-emerald-400" />}
              label={t("adminAuth.metrics.projectsWithAuth")}
              value={overviewQuery.data?.projectsWithAuth ?? 0}
              description={t("adminAuth.metrics.projectsDesc")}
            />
            <MetricCard
              icon={<ShieldAlert className="h-4 w-4 text-amber-700 dark:text-amber-400" />}
              label={t("adminAuth.metrics.suspendedProjects")}
              value={overviewQuery.data?.suspendedProjects ?? 0}
              description={t("adminAuth.metrics.suspendedDesc")}
            />
            <MetricCard
              icon={<Users className="h-4 w-4 text-blue-700 dark:text-blue-400" />}
              label={t("adminAuth.metrics.totalEndUsers")}
              value={overviewQuery.data?.totalEndUsers ?? 0}
              description={t("adminAuth.metrics.totalEndUsersDesc")}
            />
            <Card>
              <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                <CardTitle className="text-sm font-medium">{t("adminAuth.metrics.globalSignups")}</CardTitle>
                <Activity className="h-4 w-4 text-muted-foreground" />
              </CardHeader>
              <CardContent>
                <Badge
                  variant={overviewQuery.data?.globalSignupsEnabled ? "secondary" : "destructive"}
                  className="font-mono text-[11px] uppercase"
                >
                  {overviewQuery.data?.globalSignupsEnabled ? t("adminAuth.common.enabled") : t("adminAuth.common.disabled")}
                </Badge>
                <p className="mt-2 text-xs text-muted-foreground">{t("adminAuth.metrics.globalSignupsDesc")}</p>
                {overviewQuery.data?.generatedAt ? (
                  <p className="mt-1 font-mono text-[10px] text-muted-foreground">
                    {t("adminAuth.metrics.generatedAt", { value: formatDate(overviewQuery.data.generatedAt) })}
                  </p>
                ) : null}
              </CardContent>
            </Card>
          </>
        )}
      </div>

      {/* 2. Quota manager */}
      <Card className="mt-4">
        <CardHeader className="pb-3">
          <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
            <div>
              <CardTitle className="text-base font-semibold">{t("adminAuth.quota.title")}</CardTitle>
              <CardDescription className="text-xs">{t("adminAuth.quota.description")}</CardDescription>
            </div>
            <div className="relative w-full lg:w-72">
              <Search className="absolute start-2.5 top-2.5 h-3.5 w-3.5 text-muted-foreground" />
              <Input
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder={t("adminAuth.quota.searchPlaceholder")}
                className="h-8 ps-8 text-xs"
                aria-label={t("adminAuth.quota.searchPlaceholder")}
              />
            </div>
          </div>
        </CardHeader>
        <CardContent>
          {projectsQuery.isLoading ? (
            <LoadingState rows={6} columns={8} />
          ) : projectsQuery.isError ? (
            <ErrorState
              message={errorMessage(projectsQuery.error, t("adminAuth.quota.loadError"))}
              onRetry={() => void projectsQuery.refetch()}
            />
          ) : filteredRows.length === 0 ? (
            <EmptyState
              icon={<KeyRound className="h-10 w-10 text-muted-foreground/60" />}
              title={t("adminAuth.quota.emptyTitle")}
              description={t("adminAuth.quota.emptyDescription")}
            />
          ) : (
            <DataGrid columns={columns} data={filteredRows} pageSize={10} getRowId={(row) => row.projectId} />
          )}
        </CardContent>
      </Card>

      {/* 3. Global settings */}
      <PlatformSettingsCard query={settingsQuery} onSaved={invalidateAll} />

      {/* Action dialogs */}
      {action?.kind === "quota" ? (
        <QuotaDialog
          row={action.row}
          onClose={() => setAction(null)}
          onSave={(maxUsersQuota, maxSignupsPerHour) =>
            patchControl(
              action.row,
              { maxUsersQuota, maxSignupsPerHour },
              t("adminAuth.quota.quotaSavedToast")
            )
          }
        />
      ) : null}

      {action?.kind === "suspend" ? (
        <SuspendDialog
          row={action.row}
          suspend={action.suspend}
          onClose={() => setAction(null)}
          onConfirm={(reason) =>
            patchControl(
              action.row,
              { authServiceSuspended: action.suspend, suspensionReason: action.suspend ? reason.trim() || null : null },
              t(action.suspend ? "adminAuth.quota.suspendToast" : "adminAuth.quota.unsuspendToast", {
                project: action.row.projectName ?? action.row.projectId,
              })
            )
          }
        />
      ) : null}

      {action?.kind === "rotate" ? (
        <AlertDialog open onOpenChange={(open) => { if (!open) setAction(null); }}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>{t("adminAuth.quota.rotateTitle")}</AlertDialogTitle>
              <AlertDialogDescription>{t("adminAuth.quota.rotateDescription")}</AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>{t("adminAuth.common.cancel")}</AlertDialogCancel>
              <AlertDialogAction onClick={() => void rotateKey(action.row)}>
                {t("adminAuth.quota.rotateConfirm")}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      ) : null}
    </PageContent>
  );
}

/* -------------------------------------------------------------------------- */
/* Supporting components                                                      */
/* -------------------------------------------------------------------------- */

function MetricCard({
  icon,
  label,
  value,
  description,
}: {
  icon: React.ReactNode;
  label: string;
  value: number;
  description: string;
}) {
  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
        <CardTitle className="text-sm font-medium">{label}</CardTitle>
        {icon}
      </CardHeader>
      <CardContent>
        <div className="text-2xl font-bold font-mono">{value.toLocaleString()}</div>
        <p className="mt-1 text-xs text-muted-foreground">{description}</p>
      </CardContent>
    </Card>
  );
}

function QuotaDialog({
  row,
  onClose,
  onSave,
}: {
  row: AuthProjectRow;
  onClose: () => void;
  onSave: (maxUsersQuota: number, maxSignupsPerHour: number) => void;
}) {
  const { t } = useI18n();
  const [maxUsers, setMaxUsers] = React.useState(String(row.auth.maxUsersQuota));
  const [maxSignups, setMaxSignups] = React.useState(String(row.auth.maxSignupsPerHour));

  const save = () => {
    const users = Number(maxUsers);
    const signups = Number(maxSignups);
    if (!Number.isInteger(users) || users < 1 || users > 10_000_000 ||
        !Number.isInteger(signups) || signups < 1 || signups > 1_000_000) {
      toast.error(t("adminAuth.quota.invalidQuota"));
      return;
    }
    onSave(users, signups);
  };

  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="text-base font-semibold">{t("adminAuth.quota.editQuotaTitle")}</DialogTitle>
          <DialogDescription className="text-xs">
            {t("adminAuth.quota.editQuotaDescription", {
              project: row.projectName ?? row.projectId,
            })}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3.5 py-2">
          <div className="space-y-1.5">
            <Label htmlFor="quota-max-users" className="text-xs">{t("adminAuth.quota.fieldMaxUsers")}</Label>
            <Input
              id="quota-max-users"
              type="number"
              min={1}
              max={10_000_000}
              value={maxUsers}
              onChange={(event) => setMaxUsers(event.target.value)}
              className="h-8 font-mono text-xs"
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="quota-max-signups" className="text-xs">{t("adminAuth.quota.fieldMaxSignups")}</Label>
            <Input
              id="quota-max-signups"
              type="number"
              min={1}
              max={1_000_000}
              value={maxSignups}
              onChange={(event) => setMaxSignups(event.target.value)}
              className="h-8 font-mono text-xs"
            />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" size="sm" onClick={onClose}>{t("adminAuth.common.cancel")}</Button>
          <Button size="sm" onClick={save}>{t("adminAuth.quota.saveQuota")}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function SuspendDialog({
  row,
  suspend,
  onClose,
  onConfirm,
}: {
  row: AuthProjectRow;
  suspend: boolean;
  onClose: () => void;
  onConfirm: (reason: string) => void;
}) {
  const { t } = useI18n();
  const [reason, setReason] = React.useState("");

  return (
    <AlertDialog open onOpenChange={(open) => { if (!open) onClose(); }}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>
            {t(suspend ? "adminAuth.quota.suspendTitle" : "adminAuth.quota.unsuspendTitle")}
          </AlertDialogTitle>
          <AlertDialogDescription>
            {t(suspend ? "adminAuth.quota.suspendDescription" : "adminAuth.quota.unsuspendDescription")}
          </AlertDialogDescription>
        </AlertDialogHeader>
        {suspend ? (
          <div className="space-y-1.5">
            <Label htmlFor="suspension-reason" className="text-xs">{t("adminAuth.quota.suspensionReason")}</Label>
            <Input
              id="suspension-reason"
              value={reason}
              onChange={(event) => setReason(event.target.value)}
              placeholder={t("adminAuth.quota.suspensionReasonPlaceholder")}
              className="h-8 text-xs"
            />
            <p className="font-mono text-[10px] text-muted-foreground">
              {row.projectName ?? row.projectId}
            </p>
          </div>
        ) : null}
        <AlertDialogFooter>
          <AlertDialogCancel>{t("adminAuth.common.cancel")}</AlertDialogCancel>
          <AlertDialogAction
            className={suspend ? "bg-destructive text-destructive-foreground hover:bg-destructive/90" : undefined}
            onClick={() => onConfirm(reason)}
          >
            {t(suspend ? "adminAuth.quota.suspendConfirm" : "adminAuth.quota.unsuspendConfirm")}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

function PlatformSettingsCard({
  query,
  onSaved,
}: {
  query: UseQueryResult<PlatformSettings, Error>;
  onSaved: () => void;
}) {
  const { t } = useI18n();
  const [draft, setDraft] = React.useState<PlatformSettings | null>(null);
  const [smtpPassword, setSmtpPassword] = React.useState("");
  const [saving, setSaving] = React.useState(false);

  React.useEffect(() => {
    if (query.data) {
      setDraft({ ...query.data });
      setSmtpPassword("");
    }
  }, [query.data]);

  const save = async () => {
    if (!draft) return;
    const patch: UnknownRecord = {
      globalSignupsEnabled: draft.globalSignupsEnabled,
      defaultMaxUsersPerFreeProject: draft.defaultMaxUsersPerFreeProject,
      defaultMaxUsersPerProProject: draft.defaultMaxUsersPerProProject,
      platformSmtpHost: draft.platformSmtpHost?.trim() || null,
      platformSmtpPort: draft.platformSmtpPort === null ? null : Number(draft.platformSmtpPort),
      platformSmtpUser: draft.platformSmtpUser?.trim() || null,
      platformSmtpFromEmail: draft.platformSmtpFromEmail.trim(),
    };
    if (smtpPassword) patch["platformSmtpPass"] = smtpPassword;
    setSaving(true);
    try {
      await adminFetch("/v1/admin/auth/settings", {
        method: "PATCH",
        body: JSON.stringify(patch),
      });
      toast.success(t("adminAuth.settings.savedToast"));
      setSmtpPassword("");
      onSaved();
      await query.refetch();
    } catch (err: unknown) {
      toast.error(errorMessage(err, t("adminAuth.settings.saveFailed")));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card className="mt-4">
      <CardHeader className="pb-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <CardTitle className="text-base font-semibold">{t("adminAuth.settings.title")}</CardTitle>
            <CardDescription className="text-xs">{t("adminAuth.settings.description")}</CardDescription>
          </div>
          <Badge
            variant="outline"
            className={`font-mono text-[10px] uppercase ${
              query.data?.platformSmtpConfigured
                ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400"
                : "text-muted-foreground"
            }`}
          >
            {query.data?.platformSmtpConfigured ? t("adminAuth.settings.smtpConfigured") : t("adminAuth.settings.smtpNotConfigured")}
          </Badge>
        </div>
      </CardHeader>
      <CardContent>
        {query.isLoading ? (
          <LoadingState rows={5} columns={3} />
        ) : query.isError ? (
          <ErrorState
            message={errorMessage(query.error, t("adminAuth.settings.loadError"))}
            onRetry={() => void query.refetch()}
          />
        ) : draft ? (
          <div className="space-y-5">
            <label className="flex items-center justify-between gap-4 rounded-lg border bg-muted/20 p-3">
              <div>
                <p className="text-xs font-medium text-foreground">{t("adminAuth.settings.killSwitch")}</p>
                <p className="text-[11px] text-muted-foreground">{t("adminAuth.settings.killSwitchDesc")}</p>
              </div>
              <Switch
                checked={draft.globalSignupsEnabled}
                onCheckedChange={(value) => setDraft({ ...draft, globalSignupsEnabled: value })}
              />
            </label>

            <Separator />

            <div className="space-y-2">
              <h2 className="flex items-center gap-1.5 text-xs font-semibold uppercase text-muted-foreground">
                <SlidersHorizontal className="h-3.5 w-3.5" />
                {t("adminAuth.settings.sectionDefaults")}
              </h2>
              <div className="grid gap-3 sm:grid-cols-2">
                <div className="space-y-1.5">
                  <Label htmlFor="settings-free-quota" className="text-xs">{t("adminAuth.settings.defaultFreeQuota")}</Label>
                  <Input
                    id="settings-free-quota"
                    type="number"
                    min={1}
                    value={draft.defaultMaxUsersPerFreeProject}
                    onChange={(event) => setDraft({ ...draft, defaultMaxUsersPerFreeProject: Number(event.target.value) })}
                    className="h-8 font-mono text-xs"
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="settings-pro-quota" className="text-xs">{t("adminAuth.settings.defaultProQuota")}</Label>
                  <Input
                    id="settings-pro-quota"
                    type="number"
                    min={1}
                    value={draft.defaultMaxUsersPerProProject}
                    onChange={(event) => setDraft({ ...draft, defaultMaxUsersPerProProject: Number(event.target.value) })}
                    className="h-8 font-mono text-xs"
                  />
                </div>
              </div>
            </div>

            <Separator />

            <div className="space-y-2">
              <h2 className="flex items-center gap-1.5 text-xs font-semibold uppercase text-muted-foreground">
                <KeyRound className="h-3.5 w-3.5" />
                {t("adminAuth.settings.sectionSmtp")}
              </h2>
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                <div className="space-y-1.5">
                  <Label htmlFor="settings-smtp-host" className="text-xs">{t("adminAuth.settings.smtpHost")}</Label>
                  <Input
                    id="settings-smtp-host"
                    value={draft.platformSmtpHost ?? ""}
                    onChange={(event) => setDraft({ ...draft, platformSmtpHost: event.target.value })}
                    className="h-8 font-mono text-xs"
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="settings-smtp-port" className="text-xs">{t("adminAuth.settings.smtpPort")}</Label>
                  <Input
                    id="settings-smtp-port"
                    type="number"
                    min={1}
                    max={65_535}
                    value={draft.platformSmtpPort ?? ""}
                    onChange={(event) => setDraft({
                      ...draft,
                      platformSmtpPort: event.target.value === "" ? null : Number(event.target.value),
                    })}
                    className="h-8 font-mono text-xs"
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="settings-smtp-user" className="text-xs">{t("adminAuth.settings.smtpUser")}</Label>
                  <Input
                    id="settings-smtp-user"
                    value={draft.platformSmtpUser ?? ""}
                    onChange={(event) => setDraft({ ...draft, platformSmtpUser: event.target.value })}
                    className="h-8 font-mono text-xs"
                    autoComplete="off"
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="settings-smtp-from" className="text-xs">{t("adminAuth.settings.smtpFrom")}</Label>
                  <Input
                    id="settings-smtp-from"
                    type="email"
                    value={draft.platformSmtpFromEmail}
                    onChange={(event) => setDraft({ ...draft, platformSmtpFromEmail: event.target.value })}
                    className="h-8 font-mono text-xs"
                  />
                </div>
                <div className="space-y-1.5 sm:col-span-2 lg:col-span-4">
                  <Label htmlFor="settings-smtp-pass" className="text-xs">{t("adminAuth.settings.smtpPassword")}</Label>
                  <Input
                    id="settings-smtp-pass"
                    type="password"
                    value={smtpPassword}
                    onChange={(event) => setSmtpPassword(event.target.value)}
                    placeholder={t("adminAuth.settings.smtpPasswordPlaceholder")}
                    className="h-8 font-mono text-xs"
                    autoComplete="new-password"
                  />
                  <p className="text-[10px] text-muted-foreground">{t("adminAuth.settings.passwordWriteOnly")}</p>
                </div>
              </div>
            </div>

            <div className="flex flex-wrap items-center justify-between gap-2 border-t pt-3">
              <span className="font-mono text-[10px] text-muted-foreground">
                {t("adminAuth.settings.updatedAt", { value: formatDate(draft.updatedAt) })}
              </span>
              <Button size="sm" className="h-8 gap-1.5 text-xs" onClick={() => void save()} disabled={saving}>
                <CheckCircle2 className="h-3.5 w-3.5" />
                {saving ? t("adminAuth.settings.saving") : t("adminAuth.settings.save")}
              </Button>
            </div>
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}
