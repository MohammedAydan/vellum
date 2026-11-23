import * as React from "react";
import { createRoute, useParams } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { Route as projectRoute } from "./orgs.$orgId.projects.$projectId.js";
import { consoleFetch, consoleProjectsBase, type ConsoleApiKey } from "../../lib/api.js";
import { LoadingState, ErrorState, EmptyState } from "@vellum/ui";
import {
  ConfigurablePageHeader,
  ConsoleDetailSheet,
  ConsoleCopyableField,
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
  DataGrid,
  Dialog,
  DialogTrigger,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
  AlertDialog,
  AlertDialogTrigger,
  AlertDialogContent,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogAction,
  AlertDialogCancel,
  Alert,
  AlertTitle,
  AlertDescription,
  useI18n,
} from "@vellum/ui";
import { type ColumnDef } from "@tanstack/react-table";
import { toast } from "sonner";
import { Plus, Trash2, ShieldAlert, CheckCircle2, Lock, Pencil } from "lucide-react";

export const Route = createRoute({
  getParentRoute: () => projectRoute,
  path: "keys",
  component: ApiKeysManagerPage,
});

/** The control-plane key record also carries the fortress restriction fields. */
interface ConsoleApiKeyWithRestrictions extends ConsoleApiKey {
  allowedOrigins?: string[];
  allowedIps?: string[];
  expiresAt?: string | null;
}

interface ApiKeyItem {
  id: string;
  name: string;
  type: "public" | "secret";
  prefix: string;
  createdAt: string;
  lastUsedAt: string | null;
  status: "active" | "revoked";
  allowedOrigins: string[];
  allowedIps: string[];
  expiresAt: string | null;
}

/** Split on commas/newlines/whitespace; a bare domain is stored as an https URL. */
function parseOrigins(raw: string): string[] {
  const entries = raw
    .split(/[\s,]+/)
    .map((entry) => entry.trim())
    .filter((entry) => entry !== "")
    .map((entry) => (/^https?:\/\//i.test(entry) ? entry : `https://${entry}`));
  return Array.from(new Set(entries));
}

function parseIps(raw: string): string[] {
  const entries = raw
    .split(/[\s,]+/)
    .map((entry) => entry.trim())
    .filter((entry) => entry !== "");
  return Array.from(new Set(entries));
}

function ApiKeysManagerPage() {
  const { orgId, projectId } = useParams({ from: Route.id });
  const { t } = useI18n();
  const base = consoleProjectsBase(projectId);

  const {
    data: realKeys = [],
    isLoading,
    isError,
    error,
    refetch,
  } = useQuery({
    queryKey: ["api-keys", projectId],
    queryFn: async () => {
      const res = await consoleFetch<ConsoleApiKeyWithRestrictions[]>(`${base}/api-keys`);
      if (!Array.isArray(res)) return [];
      return res.map((k) => ({
        id: k.id,
        name: k.name,
        type: (k.keyType === "server" ? "secret" : "public") as "public" | "secret",
        prefix: k.keyPrefix,
        createdAt: k.createdAt,
        lastUsedAt: k.lastUsedAt,
        status: (k.revokedAt ? "revoked" : "active") as "active" | "revoked",
        allowedOrigins: Array.isArray(k.allowedOrigins) ? k.allowedOrigins : [],
        allowedIps: Array.isArray(k.allowedIps) ? k.allowedIps : [],
        expiresAt: typeof k.expiresAt === "string" ? k.expiresAt : null,
      }));
    },
  });

  const keys = realKeys;
  const [isCreateOpen, setIsCreateOpen] = React.useState<boolean>(false);
  const [keyName, setKeyName] = React.useState<string>("");
  const [keyType, setKeyType] = React.useState<"public" | "secret">("secret");

  // "Copy Once" modal state
  const [newlyCreatedKey, setNewlyCreatedKey] = React.useState<{
    name: string;
    key: string;
    type: "public" | "secret";
  } | null>(null);

  // Origin / IP / expiry restrictions editor state.
  const [restrictionKey, setRestrictionKey] = React.useState<ApiKeyItem | null>(null);
  const [originsInput, setOriginsInput] = React.useState("");
  const [ipsInput, setIpsInput] = React.useState("");
  const [expiresInput, setExpiresInput] = React.useState("");
  const [savingRestrictions, setSavingRestrictions] = React.useState(false);

  const openRestrictions = (item: ApiKeyItem) => {
    setRestrictionKey(item);
    setOriginsInput(item.allowedOrigins.join("\n"));
    setIpsInput(item.allowedIps.join("\n"));
    setExpiresInput((item.expiresAt ?? "").slice(0, 10));
  };

  const handleSaveRestrictions = async () => {
    if (restrictionKey === null) return;
    let expiresAt: string | null = null;
    if (expiresInput !== "") {
      const timestamp = Date.parse(`${expiresInput}T23:59:59.000Z`);
      if (Number.isNaN(timestamp)) {
        toast.error(t("keys.restrictions.invalidDate"));
        return;
      }
      expiresAt = new Date(timestamp).toISOString();
    }

    setSavingRestrictions(true);
    try {
      await consoleFetch(
        `/orgs/${encodeURIComponent(orgId)}/projects/${encodeURIComponent(projectId)}/keys/${encodeURIComponent(restrictionKey.id)}/restrictions`,
        {
          method: "PATCH",
          body: JSON.stringify({
            allowedOrigins: parseOrigins(originsInput),
            allowedIps: parseIps(ipsInput),
            expiresAt,
          }),
        }
      );
      setRestrictionKey(null);
      await refetch();
      toast.success(t("keys.restrictions.savedToast"));
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : t("keys.restrictions.saveFailed"));
    } finally {
      setSavingRestrictions(false);
    }
  };

  const handleCreateKey = async () => {
    const trimmed = keyName.trim();
    if (!trimmed) {
      toast.error(t("keys.nameRequired"));
      return;
    }

    try {
      const res = await consoleFetch<{ apiKey: ConsoleApiKey; rawKey: string }>(
        `${base}/api-keys`,
        {
          method: "POST",
          body: JSON.stringify({
            name: trimmed,
            keyType: keyType === "public" ? "public" : "secret",
          }),
        }
      );

      setIsCreateOpen(false);
      setKeyName("");
      setNewlyCreatedKey({
        name: trimmed,
        key: res.rawKey,
        type: keyType,
      });
      await refetch();
      toast.success(t("keys.createdToast"));
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : t("keys.createFailed"));
    }
  };

  const handleRevokeKey = async (id: string) => {
    try {
      await consoleFetch(`${base}/api-keys/${id}`, {
        method: "DELETE",
      });
      await refetch();
      toast.success(t("keys.revokedToast"));
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : t("keys.revokeFailed"));
    }
  };

  const columns: ColumnDef<ApiKeyItem, unknown>[] = [
    {
      accessorKey: "name",
      header: t("keys.columnName"),
      cell: ({ row }) => (
        <div>
          <span className="font-medium text-xs text-foreground block">
            {row.original.name}
          </span>
          <span className="font-mono text-[10px] text-muted-foreground">
            {row.original.id}
          </span>
        </div>
      ),
    },
    {
      accessorKey: "type",
      header: t("keys.typeLabel"),
      cell: ({ row }) => {
        const isPublic = row.original.type === "public";
        return (
          <Badge
            variant="outline"
            className={`font-mono text-[10px] uppercase ${
              isPublic
                ? "bg-info/10 text-info border-info/30"
                : "bg-purple-500/10 text-purple-700 dark:text-purple-300 border-purple-500/30"
            }`}
          >
            {row.original.type}
          </Badge>
        );
      },
    },
    {
      accessorKey: "prefix",
      header: t("keys.columnPrefix"),
      cell: ({ row }) => (
        <ConsoleCopyableField
          value={row.original.prefix}
          className="max-w-48"
        />
      ),
    },
    {
      accessorKey: "status",
      header: t("common.status"),
      cell: ({ row }) => {
        const isActive = row.original.status === "active";
        return (
          <Badge
            variant={isActive ? "secondary" : "danger"}
            className="font-mono text-[10px] uppercase gap-1"
          >
            {isActive ? (
              <>
                <CheckCircle2 className="h-3 w-3 text-success" />
                {t("common.active")}
              </>
            ) : (
              t("common.revoked")
            )}
          </Badge>
        );
      },
    },
    {
      id: "restrictions",
      header: t("keys.restrictions.title"),
      cell: ({ row }) => {
        const item = row.original;
        const hasRestrictions =
          item.allowedOrigins.length > 0 ||
          item.allowedIps.length > 0 ||
          item.expiresAt !== null;
        if (!hasRestrictions) {
          return (
            <span className="text-[11px] italic text-muted-foreground">
              {t("keys.restrictions.none")}
            </span>
          );
        }
        return (
          <div className="space-y-0.5 text-[10px] text-muted-foreground">
            {item.allowedOrigins.length > 0 && (
              <div className="font-mono">
                {t("keys.restrictions.originsCount", { count: item.allowedOrigins.length })}
              </div>
            )}
            {item.allowedIps.length > 0 && (
              <div className="font-mono">
                {t("keys.restrictions.ipsCount", { count: item.allowedIps.length })}
              </div>
            )}
            {item.expiresAt !== null && (
              <div className="font-mono">
                {t("keys.restrictions.expiresShort", { date: item.expiresAt.slice(0, 10) })}
              </div>
            )}
          </div>
        );
      },
    },
    {
      accessorKey: "createdAt",
      header: t("keys.columnCreated"),
      cell: ({ row }) => (
        <span className="font-mono text-[11px] tabular-nums text-muted-foreground">
          {new Date(row.original.createdAt).toLocaleDateString()}
        </span>
      ),
    },
    {
      id: "actions",
      header: t("common.actions"),
      cell: ({ row }) => {
        const isRevoked = row.original.status === "revoked";
        return (
          <div className="flex items-center justify-end gap-1">
            <Button
              variant="ghost"
              size="sm"
              aria-label={t("keys.restrictions.edit")}
              title={t("keys.restrictions.edit")}
              className="h-7 w-7 p-0 text-muted-foreground hover:text-primary"
              onClick={() => openRestrictions(row.original)}
            >
              <Pencil className="h-3.5 w-3.5" />
            </Button>
            {isRevoked ? (
              <span className="text-[11px] italic text-muted-foreground">
                {t("keys.revokedCell")}
              </span>
            ) : (
              <AlertDialog>
                <AlertDialogTrigger asChild>
                  <Button
                    variant="ghost"
                    size="sm"
                    aria-label={t("keys.revokeConfirm")}
                    className="h-7 w-7 p-0 text-muted-foreground hover:text-destructive"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </Button>
                </AlertDialogTrigger>
                <AlertDialogContent>
                  <AlertDialogHeader>
                    <AlertDialogTitle>{t("keys.revokeTitle")}</AlertDialogTitle>
                    <AlertDialogDescription>
                      {t("keys.revokeDescription", { name: row.original.name })}
                    </AlertDialogDescription>
                  </AlertDialogHeader>
                  <AlertDialogFooter>
                    <AlertDialogCancel>{t("common.cancel")}</AlertDialogCancel>
                    <AlertDialogAction
                      className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                      onClick={() => handleRevokeKey(row.original.id)}
                    >
                      {t("keys.revokeConfirm")}
                    </AlertDialogAction>
                  </AlertDialogFooter>
                </AlertDialogContent>
              </AlertDialog>
            )}
          </div>
        );
      },
    },
  ];

  if (isLoading) return <LoadingState rows={4} columns={4} />;
  if (isError) {
    return (
      <ErrorState
        title={t("common.errorTitle")}
        message={error instanceof Error ? error.message : t("keys.loadFailed")}
        onRetry={() => void refetch()}
      />
    );
  }

  return (
    <PageContent>
      <ConfigurablePageHeader
        title={t("keys.title")}
        description={t("keys.description")}
        actions={
          <Dialog open={isCreateOpen} onOpenChange={setIsCreateOpen}>
            <DialogTrigger asChild>
              <Button>
                <Plus className="h-4 w-4 me-2 rtl:rotate-180" />
                {t("keys.generate")}
              </Button>
            </DialogTrigger>
            <DialogContent className="max-w-md">
              <DialogHeader>
                <DialogTitle>{t("keys.generateTitle")}</DialogTitle>
                <DialogDescription>
                  {t("keys.generateDescription")}
                </DialogDescription>
              </DialogHeader>

              <div className="space-y-4 py-2">
                <div className="space-y-1.5">
                  <Label htmlFor="keyName" className="text-xs">{t("keys.nameLabel")}</Label>
                  <Input
                    id="keyName"
                    placeholder={t("keys.namePlaceholder")}
                    value={keyName}
                    onChange={(e) => setKeyName(e.target.value)}
                    className="text-xs h-8"
                  />
                </div>

                <div className="space-y-1.5">
                  <Label className="text-xs">{t("keys.typeLabel")}</Label>
                  <div className="grid grid-cols-2 gap-3">
                    <button
                      type="button"
                      onClick={() => setKeyType("secret")}
                      className={`flex flex-col items-start p-3 rounded-lg border text-start transition-all ${
                        keyType === "secret"
                          ? "border-primary bg-primary/5 ring-1 ring-primary"
                          : "border-border hover:bg-muted/50"
                      }`}
                    >
                      <div className="flex items-center gap-1.5 font-semibold text-xs text-foreground">
                        <Lock className="h-3.5 w-3.5 text-purple-500" />
                        <span>{t("keys.secretLabel")}</span>
                      </div>
                      <p className="text-[10px] text-muted-foreground mt-1">
                        {t("keys.secretDescription")}
                      </p>
                    </button>

                    <button
                      type="button"
                      onClick={() => setKeyType("public")}
                      className={`flex flex-col items-start p-3 rounded-lg border text-start transition-all ${
                        keyType === "public"
                          ? "border-primary bg-primary/5 ring-1 ring-primary"
                          : "border-border hover:bg-muted/50"
                      }`}
                    >
                      <div className="flex items-center gap-1.5 font-semibold text-xs text-foreground">
                        <ShieldAlert className="h-3.5 w-3.5 text-info" />
                        <span>{t("keys.publicLabel")}</span>
                      </div>
                      <p className="text-[10px] text-muted-foreground mt-1">
                        {t("keys.publicDescription")}
                      </p>
                    </button>
                  </div>
                </div>
              </div>

              <DialogFooter className="mt-4">
                <Button variant="outline" onClick={() => setIsCreateOpen(false)}>
                  {t("common.cancel")}
                </Button>
                <Button onClick={handleCreateKey}>{t("keys.generateCredential")}</Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
        }
      />

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base font-semibold">{t("keys.activeTitle")}</CardTitle>
          <CardDescription className="text-xs">
            {t("keys.activeDescription")}
          </CardDescription>
        </CardHeader>
        <CardContent>
          {keys.length === 0 ? (
            <EmptyState
              icon={<ShieldAlert className="h-10 w-10 text-muted-foreground/60" />}
              title={t("keys.emptyTitle")}
              description={t("keys.emptyDescription")}
            />
          ) : (
            <>
              {/* Mobile: stacked cards keep copy / restriction / revoke controls
                  inside the viewport instead of a horizontally scrolling table. */}
              <div className="space-y-3 md:hidden">
                {keys.map((item) => {
                  const isRevoked = item.status === "revoked";
                  const hasRestrictions =
                    item.allowedOrigins.length > 0 ||
                    item.allowedIps.length > 0 ||
                    item.expiresAt !== null;
                  return (
                    <div key={item.id} className="space-y-3 rounded-md border bg-card p-3">
                      <div className="flex items-start justify-between gap-2">
                        <div className="min-w-0">
                          <span className="block truncate text-xs font-medium text-foreground">
                            {item.name}
                          </span>
                          <span className="block truncate font-mono text-[10px] text-muted-foreground">
                            {item.id}
                          </span>
                        </div>
                        <Badge
                          variant="outline"
                          className={`shrink-0 font-mono text-[10px] uppercase ${
                            item.type === "public"
                              ? "bg-info/10 text-info border-info/30"
                              : "bg-purple-500/10 text-purple-700 dark:text-purple-300 border-purple-500/30"
                          }`}
                        >
                          {item.type}
                        </Badge>
                      </div>

                      <ConsoleCopyableField
                        label={t("keys.columnPrefix")}
                        value={item.prefix}
                      />

                      <div className="flex flex-wrap items-center gap-2">
                        <Badge
                          variant={isRevoked ? "danger" : "secondary"}
                          className="font-mono text-[10px] uppercase gap-1"
                        >
                          {isRevoked ? (
                            t("common.revoked")
                          ) : (
                            <>
                              <CheckCircle2 className="h-3 w-3 text-success" />
                              {t("common.active")}
                            </>
                          )}
                        </Badge>
                        <span className="font-mono text-[11px] text-muted-foreground">
                          {t("keys.columnCreated")}: {new Date(item.createdAt).toLocaleDateString()}
                        </span>
                      </div>

                      <div className="text-[10px] text-muted-foreground">
                        {!hasRestrictions ? (
                          <span className="italic">{t("keys.restrictions.none")}</span>
                        ) : (
                          <div className="space-y-0.5">
                            {item.allowedOrigins.length > 0 && (
                              <div className="font-mono">
                                {t("keys.restrictions.originsCount", { count: item.allowedOrigins.length })}
                              </div>
                            )}
                            {item.allowedIps.length > 0 && (
                              <div className="font-mono">
                                {t("keys.restrictions.ipsCount", { count: item.allowedIps.length })}
                              </div>
                            )}
                            {item.expiresAt !== null && (
                              <div className="font-mono">
                                {t("keys.restrictions.expiresShort", { date: item.expiresAt.slice(0, 10) })}
                              </div>
                            )}
                          </div>
                        )}
                      </div>

                      <div className="flex items-center justify-end gap-1 border-t pt-2">
                        <Button
                          variant="ghost"
                          size="sm"
                          aria-label={t("keys.restrictions.edit")}
                          title={t("keys.restrictions.edit")}
                          className="h-7 w-7 p-0 text-muted-foreground hover:text-primary"
                          onClick={() => openRestrictions(item)}
                        >
                          <Pencil className="h-3.5 w-3.5" />
                        </Button>
                        {isRevoked ? (
                          <span className="text-[11px] italic text-muted-foreground">
                            {t("keys.revokedCell")}
                          </span>
                        ) : (
                          <AlertDialog>
                            <AlertDialogTrigger asChild>
                              <Button
                                variant="ghost"
                                size="sm"
                                aria-label={t("keys.revokeConfirm")}
                                className="h-7 w-7 p-0 text-muted-foreground hover:text-destructive"
                              >
                                <Trash2 className="h-3.5 w-3.5" />
                              </Button>
                            </AlertDialogTrigger>
                            <AlertDialogContent>
                              <AlertDialogHeader>
                                <AlertDialogTitle>{t("keys.revokeTitle")}</AlertDialogTitle>
                                <AlertDialogDescription>
                                  {t("keys.revokeDescription", { name: item.name })}
                                </AlertDialogDescription>
                              </AlertDialogHeader>
                              <AlertDialogFooter>
                                <AlertDialogCancel>{t("common.cancel")}</AlertDialogCancel>
                                <AlertDialogAction
                                  className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                                  onClick={() => handleRevokeKey(item.id)}
                                >
                                  {t("keys.revokeConfirm")}
                                </AlertDialogAction>
                              </AlertDialogFooter>
                            </AlertDialogContent>
                          </AlertDialog>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>

              <div className="hidden md:block">
                <DataGrid
                  columns={columns}
                  data={keys}
                  pageSize={10}
                  getRowId={(row) => row.id}
                />
              </div>
            </>
          )}
        </CardContent>
      </Card>

      {/* Reveal Dialog: Copy Once */}
      {newlyCreatedKey && (
        <Dialog
          open={!!newlyCreatedKey}
          onOpenChange={(open) => {
            if (!open) setNewlyCreatedKey(null);
          }}
        >
          <DialogContent className="max-w-md">
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2 text-success-600 dark:text-success-400">
                <CheckCircle2 className="h-5 w-5" />
                <span>{t("keys.revealTitle")}</span>
              </DialogTitle>
              <DialogDescription>
                {t("keys.revealDescription")}
              </DialogDescription>
            </DialogHeader>

            <div className="space-y-4 py-2">
              <Alert className="border-warning/40 bg-warning/10">
                <ShieldAlert className="h-4 w-4 text-warning" />
                <AlertTitle className="text-xs font-semibold text-warning-600 dark:text-warning-400">
                  {t("keys.storeTitle")}
                </AlertTitle>
                <AlertDescription className="text-xs text-muted-foreground">
                  {t("keys.storeDescription")}
                </AlertDescription>
              </Alert>

              <div className="space-y-1.5">
                <ConsoleCopyableField
                  label={t("keys.generatedCredential")}
                  value={newlyCreatedKey.key}
                />
              </div>
            </div>

            <DialogFooter>
              <Button onClick={() => setNewlyCreatedKey(null)}>
                {t("keys.storedConfirm")}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}

      {/* Restrictions editor: origins, IPs and expiry */}
      {restrictionKey !== null && (
        <ConsoleDetailSheet
          open={restrictionKey !== null}
          onOpenChange={(open) => {
            if (!open) setRestrictionKey(null);
          }}
          title={t("keys.restrictions.edit")}
          description={t("keys.restrictions.description", { name: restrictionKey.name })}
          footer={
            <>
              <Button variant="outline" onClick={() => setRestrictionKey(null)}>
                {t("common.cancel")}
              </Button>
              <Button
                onClick={() => void handleSaveRestrictions()}
                disabled={savingRestrictions}
              >
                {savingRestrictions
                  ? t("keys.restrictions.saving")
                  : t("keys.restrictions.save")}
              </Button>
            </>
          }
        >
            <div className="space-y-4">
              <div className="space-y-1.5">
                <Label htmlFor="key-origins" className="text-xs">
                  {t("keys.restrictions.originsLabel")}
                </Label>
                <Textarea
                  id="key-origins"
                  rows={3}
                  placeholder={t("keys.restrictions.originsPlaceholder")}
                  value={originsInput}
                  onChange={(event) => setOriginsInput(event.target.value)}
                  className="text-xs font-mono"
                />
                <p className="text-[10px] text-muted-foreground">
                  {t("keys.restrictions.originsHelp")}
                </p>
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="key-ips" className="text-xs">
                  {t("keys.restrictions.ipsLabel")}
                </Label>
                <Textarea
                  id="key-ips"
                  rows={3}
                  placeholder={t("keys.restrictions.ipsPlaceholder")}
                  value={ipsInput}
                  onChange={(event) => setIpsInput(event.target.value)}
                  className="text-xs font-mono"
                />
                <p className="text-[10px] text-muted-foreground">
                  {t("keys.restrictions.ipsHelp")}
                </p>
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="key-expires" className="text-xs">
                  {t("keys.restrictions.expiresLabel")}
                </Label>
                <Input
                  id="key-expires"
                  type="date"
                  value={expiresInput}
                  onChange={(event) => setExpiresInput(event.target.value)}
                  className="h-8 text-xs"
                />
                <p className="text-[10px] text-muted-foreground">
                  {t("keys.restrictions.expiresHelp")}
                </p>
              </div>
            </div>
        </ConsoleDetailSheet>
      )}
    </PageContent>
  );
}
