import * as React from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { apiFetch } from "../../lib/api.js";
import {
  LoadingState,
  ErrorState,
  EmptyState,
  DataTable,
  type DataTableColumn,
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
  Dialog,
  DialogTrigger,
  useI18n,
} from "@vellum/ui";
import { Users, Plus, Upload, Search, ChevronLeft, ChevronRight } from "lucide-react";
import type { AuthUser, UserFilter } from "./types.js";
import { errorMessage, formatDate } from "./helpers.js";
import { CreateUserDialog } from "./create-user-dialog.js";
import { ImportUsersDialog } from "./import-users-dialog.js";
import { UserInspector } from "./user-inspector.js";

export function UsersDirectory({ projectId }: { projectId: string }) {
  const { t } = useI18n();
  const queryClient = useQueryClient();
  const [searchInput, setSearchInput] = React.useState("");
  const [search, setSearch] = React.useState("");
  const [filter, setFilter] = React.useState<UserFilter>("all");
  const [cursorHistory, setCursorHistory] = React.useState<Array<string | null>>([null]);
  const [pageIndex, setPageIndex] = React.useState(0);
  const [createOpen, setCreateOpen] = React.useState(false);
  const [importOpen, setImportOpen] = React.useState(false);
  const [selectedUid, setSelectedUid] = React.useState<string | null>(null);

  React.useEffect(() => {
    const handle = window.setTimeout(() => {
      setSearch(searchInput.trim());
      setCursorHistory([null]);
      setPageIndex(0);
    }, 300);
    return () => window.clearTimeout(handle);
  }, [searchInput]);

  const cursor = cursorHistory[pageIndex] ?? null;

  const queryFn = React.useCallback(async (): Promise<{ users: AuthUser[]; nextCursor: string | null }> => {
    const base = `/v1/projects/${encodeURIComponent(projectId)}/auth/admin`;
    const params = new URLSearchParams();
    params.set("limit", "25");
    if (search) params.set("search", search);
    if (filter === "disabled") params.set("isDisabled", "true");
    if (filter === "anonymous") params.set("isAnonymous", "true");
    if (filter === "unverified") params.set("emailVerified", "false");
    if (filter === "active") params.set("isDisabled", "false");
    if (cursor) params.set("cursor", cursor);
    const res = await apiFetch<{ users: AuthUser[]; nextCursor: string | null }>(`${base}/users?${params.toString()}`);
    return { users: Array.isArray(res.users) ? res.users : [], nextCursor: res.nextCursor ?? null };
  }, [projectId, search, filter, cursor]);

  const {
    data = { users: [], nextCursor: null },
    isLoading,
    isError,
    error,
    refetch,
  } = useQuery({
    queryKey: ["auth-studio-users", projectId, search, filter, cursor],
    queryFn,
  });

  const invalidate = React.useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: ["auth-studio-users", projectId] });
    if (selectedUid) {
      void queryClient.invalidateQueries({ queryKey: ["auth-studio-user-detail", projectId, selectedUid] });
    }
  }, [queryClient, projectId, selectedUid]);

  const changeFilter = (next: UserFilter) => {
    setFilter(next);
    setCursorHistory([null]);
    setPageIndex(0);
  };

  const columns: DataTableColumn<AuthUser>[] = [
    {
      id: "email",
      header: t("authStudio.users.colUser"),
      accessor: (user) => (
        <div className="min-w-0">
          <span className="block truncate text-xs font-medium text-foreground">
            {user.displayName || user.email || t("authStudio.common.unknown")}
          </span>
          <span className="block truncate font-mono text-[10px] text-muted-foreground">
            {user.email ?? t("authStudio.users.filter.anonymous")}
          </span>
        </div>
      ),
    },
    {
      id: "status",
      header: t("authStudio.users.colStatus"),
      accessor: (user) => (
        <div className="flex flex-wrap gap-1">
          <Badge
            variant={user.isDisabled ? "destructive" : "secondary"}
            className="font-mono text-[10px] uppercase"
          >
            {user.isDisabled ? t("authStudio.users.status.disabled") : t("authStudio.users.status.active")}
          </Badge>
          {user.isAnonymous ? (
            <Badge variant="outline" className="font-mono text-[10px] uppercase">
              {t("authStudio.users.status.anonymous")}
            </Badge>
          ) : null}
          {!user.emailVerified ? (
            <Badge
              variant="outline"
              className="border-warning/40 bg-warning/10 font-mono text-[10px] uppercase text-warning"
            >
              {t("authStudio.users.status.unverified")}
            </Badge>
          ) : (
            <Badge
              variant="outline"
              className="border-success/40 bg-success/10 font-mono text-[10px] uppercase text-success"
            >
              {t("authStudio.users.status.verified")}
            </Badge>
          )}
        </div>
      ),
    },
    {
      id: "createdAt",
      header: t("authStudio.users.colCreated"),
      mono: true,
      accessor: (user) => (
        <span className="text-[11px] tabular-nums text-muted-foreground">{formatDate(user.createdAt)}</span>
      ),
    },
    {
      id: "lastSignInAt",
      header: t("authStudio.users.colLastSignIn"),
      mono: true,
      accessor: (user) => (
        <span className="text-[11px] tabular-nums text-muted-foreground">{formatDate(user.lastSignInAt)}</span>
      ),
    },
    {
      id: "actions",
      header: t("authStudio.common.actions"),
      align: "end",
      accessor: (user) => (
        <Button
          variant="outline"
          size="sm"
          className="h-7 gap-1.5 px-2 text-[11px]"
          onClick={() => setSelectedUid(user.id)}
        >
          <Search className="h-3 w-3" />
          {t("authStudio.users.inspect")}
        </Button>
      ),
    },
  ];

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader className="pb-3">
          <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
            <div>
              <CardTitle className="text-base font-semibold">{t("authStudio.tab.users")}</CardTitle>
              <CardDescription className="text-xs">{t("authStudio.users.subtitle")}</CardDescription>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <div className="relative w-full sm:w-64">
                <Search className="absolute start-2.5 top-2.5 h-3.5 w-3.5 text-muted-foreground" />
                <Input
                  value={searchInput}
                  onChange={(event) => setSearchInput(event.target.value)}
                  placeholder={t("authStudio.users.searchPlaceholder")}
                  className="h-8 ps-8 text-xs"
                  aria-label={t("authStudio.users.searchPlaceholder")}
                />
              </div>
              <Dialog open={importOpen} onOpenChange={setImportOpen}>
                <DialogTrigger asChild>
                  <Button variant="outline" size="sm" className="h-8 gap-1.5 text-xs">
                    <Upload className="h-3.5 w-3.5" />
                    {t("authStudio.users.import")}
                  </Button>
                </DialogTrigger>
                <ImportUsersDialog
                  projectId={projectId}
                  onDone={() => {
                    setImportOpen(false);
                    invalidate();
                  }}
                />
              </Dialog>
              <Dialog open={createOpen} onOpenChange={setCreateOpen}>
                <DialogTrigger asChild>
                  <Button size="sm" className="h-8 gap-1.5 text-xs">
                    <Plus className="h-3.5 w-3.5" />
                    {t("authStudio.users.create")}
                  </Button>
                </DialogTrigger>
                <CreateUserDialog
                  projectId={projectId}
                  onDone={() => {
                    setCreateOpen(false);
                    invalidate();
                  }}
                />
              </Dialog>
            </div>
          </div>
          <Tabs variant="underline" value={filter} onValueChange={(value) => changeFilter(value as UserFilter)} className="mt-3">
            <TabsList className="h-8">
              {(["all", "active", "disabled", "anonymous", "unverified"] as const).map((key) => (
                <TabsTrigger key={key} value={key} className="px-2.5 text-[11px]">
                  {t(`authStudio.users.filter.${key}`)}
                </TabsTrigger>
              ))}
            </TabsList>
            {/* Filter triggers need matching panels so their aria-controls
                IDREFs resolve; the filtering itself is handled by the query. */}
            {(["all", "active", "disabled", "anonymous", "unverified"] as const).map((key) => (
              <TabsContent key={key} value={key} forceMount className="hidden" />
            ))}
          </Tabs>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <LoadingState rows={5} columns={5} />
          ) : isError ? (
            <ErrorState
              title={t("common.errorTitle")}
              message={errorMessage(error, t("authStudio.users.loadFailed"))}
              onRetry={() => void refetch()}
            />
          ) : data.users.length === 0 ? (
            <EmptyState
              icon={<Users className="h-10 w-10 text-muted-foreground/60" />}
              title={t("authStudio.users.emptyTitle")}
              description={t("authStudio.users.emptyDescription")}
            />
          ) : (
            <DataTable rows={data.users} columns={columns} getRowId={(row) => row.id} />
          )}

          {!isLoading && !isError && (pageIndex > 0 || data.nextCursor) ? (
            <div className="mt-3 flex items-center justify-between gap-2 border-t pt-3">
              <span className="font-mono text-[11px] text-muted-foreground">
                {t("authStudio.users.pageInfo", { page: pageIndex + 1 })}
              </span>
              <div className="flex items-center gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  className="h-7 gap-1 text-[11px]"
                  disabled={pageIndex === 0}
                  onClick={() => setPageIndex((index) => Math.max(0, index - 1))}
                >
                  <ChevronLeft className="h-3 w-3 rtl:rotate-180" />
                  {t("authStudio.users.prev")}
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  className="h-7 gap-1 text-[11px]"
                  disabled={!data.nextCursor}
                  onClick={() => {
                    const next = data.nextCursor;
                    if (!next) return;
                    setCursorHistory((history) => [...history.slice(0, pageIndex + 1), next]);
                    setPageIndex((index) => index + 1);
                  }}
                >
                  {t("authStudio.users.next")}
                  <ChevronRight className="h-3 w-3 rtl:rotate-180" />
                </Button>
              </div>
            </div>
          ) : null}
        </CardContent>
      </Card>

      {selectedUid ? (
        <UserInspector
          projectId={projectId}
          uid={selectedUid}
          onClose={() => setSelectedUid(null)}
          onChanged={invalidate}
        />
      ) : null}
    </div>
  );
}
