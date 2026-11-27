import * as React from "react";
import { createRoute, useSearch, useParams } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { Route as projectRoute } from "./orgs.$orgId.projects.$projectId.js";
import {
  apiFetch,
  consoleFetch,
  consoleProjectsBase,
  type ConsoleIndex,
} from "../../lib/api.js";
import { LoadingState, ErrorState } from "@vellum/ui";
import {
  ConfigurablePageHeader,
  DataTable,
  type DataTableColumn,
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
  DataGrid,
  Dialog,
  DialogTrigger,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
  EmptyState,
  AlertDialog,
  AlertDialogTrigger,
  AlertDialogContent,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogAction,
  AlertDialogCancel,
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectGroup,
  SelectLabel,
  SelectItem,
  useI18n,
} from "@vellum/ui";
import { type ColumnDef } from "@tanstack/react-table";
import { toast } from "sonner";
import {
  Layers,
  Plus,
  Trash2,
  Loader2,
  CheckCircle2,
  AlertTriangle,
  Sparkles,
  Wand2,
  Zap,
} from "lucide-react";
import { z } from "zod";

const indexSearchSchema = z.object({
  fromError: z.string().optional(),
  collection: z.string().optional(),
  fields: z.string().optional(),
  suggest: z.string().optional(),
});

/* -------------------------------------------------------------------------- */
/* Browser-safe `?suggest=` decoder                                           */
/* -------------------------------------------------------------------------- */

/** Mirrors @vellum/core's `MAX_SUGGEST_PAYLOAD_BYTES` (8 KiB). */
const MAX_SUGGEST_PAYLOAD_BYTES = 8 * 1024;
/** Mirrors @vellum/core's defensive field bound. */
const MAX_DECODED_FIELDS = 64;

export interface SuggestField {
  path: string;
  dir: "asc" | "desc";
}

export interface SuggestPayload {
  orgId: string;
  projectId: string;
  /** Wildcard template path for nested subcollections, else the concrete path. */
  collectionPath: string;
  /** Concrete instance path that triggered the suggestion (display only). */
  exampleCollectionPath?: string;
  fields: SuggestField[];
  fingerprint: string;
  reason: string;
}

/** A pending V2 index recommendation returned by the advisor endpoint. */
export interface Recommendation {
  id: string;
  fingerprint: string;
  collectionPath: string;
  recommendedFields: SuggestField[];
  reason: string;
  hitCount: number;
  maxDurationMs: number;
  totalDurationMs: number;
  status: "pending" | "applied" | "dismissed";
  lastSeenAt: string;
}

/** Browser-safe mirror of `@vellum/core`'s isTemplateCollectionPath. */
export function isTemplateCollectionPathLocal(collectionPath: string): boolean {
  const segments = collectionPath.split("/");
  for (let i = 1; i < segments.length; i += 2) {
    if (segments[i] === "*") return true;
  }
  return false;
}

/** Browser-safe mirror of `@vellum/core`'s canonicalizeCollectionPathToTemplate. */
export function canonicalizeCollectionPathToTemplateLocal(collectionPath: string): string {
  const segments = collectionPath.split("/");
  if (segments.length < 3) return collectionPath;
  let changed = false;
  for (let i = 1; i < segments.length; i += 2) {
    if (segments[i] !== "*") {
      segments[i] = "*";
      changed = true;
    }
  }
  return changed ? segments.join("/") : collectionPath;
}

function utf8ByteLength(value: string): number {
  return new TextEncoder().encode(value).length;
}

/** Convert a base64url token to the base64 alphabet expected by `atob`. */
function base64UrlToBinary(payload: string): string {
  let base64 = payload.replace(/-/g, "+").replace(/_/g, "/");
  const remainder = base64.length % 4;
  if (remainder === 1) throw new Error("Invalid base64url payload");
  if (remainder > 0) base64 += "=".repeat(4 - remainder);
  return atob(base64);
}

/**
 * Browser-safe mirror of `@vellum/core`'s `decodeSuggestPayload`. We deliberately
 * do NOT import from `@vellum/core` here: that barrel pulls `node:crypto` /
 * `Buffer` into the browser bundle. Only `atob` + `TextDecoder` are used.
 * Validation mirrors the core decoder's caps and strict `"asc" | "desc"`
 * direction check.
 */
export function decodeSuggestPayloadLocal(payload: string): SuggestPayload | null {
  if (typeof payload !== "string" || payload.length === 0) return null;
  if (utf8ByteLength(payload) > MAX_SUGGEST_PAYLOAD_BYTES) return null;

  let json: string;
  try {
    const binary = base64UrlToBinary(payload);
    const bytes = Uint8Array.from(binary, (ch) => ch.charCodeAt(0));
    json = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
  if (utf8ByteLength(json) > MAX_SUGGEST_PAYLOAD_BYTES) return null;

  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    return null;
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const obj = raw as Record<string, unknown>;

  const readString = (key: string): string | null => {
    const value = obj[key];
    return typeof value === "string" && value.length > 0 ? value : null;
  };
  const orgId = readString("orgId");
  const projectId = readString("projectId");
  const collectionPath = readString("collectionPath");
  const fingerprint = readString("fingerprint");
  if (
    orgId === null ||
    projectId === null ||
    collectionPath === null ||
    fingerprint === null ||
    typeof obj["reason"] !== "string"
  ) {
    return null;
  }

  const rawFields = obj["fields"];
  if (!Array.isArray(rawFields) || rawFields.length > MAX_DECODED_FIELDS) return null;
  const fields: SuggestField[] = [];
  for (const item of rawFields) {
    if (!item || typeof item !== "object" || Array.isArray(item)) return null;
    const fieldObj = item as Record<string, unknown>;
    if (typeof fieldObj["path"] !== "string" || fieldObj["path"].length === 0) return null;
    if (fieldObj["dir"] !== "asc" && fieldObj["dir"] !== "desc") return null;
    fields.push({ path: fieldObj["path"], dir: fieldObj["dir"] });
  }

  const exampleCollectionPath = readString("exampleCollectionPath");

  const decoded: SuggestPayload = {
    orgId,
    projectId,
    collectionPath,
    ...(exampleCollectionPath !== null ? { exampleCollectionPath } : {}),
    fields,
    fingerprint,
    reason: obj["reason"],
  };
  return decoded;
}

export const Route = createRoute({
  getParentRoute: () => projectRoute,
  path: "indexes",
  validateSearch: (search) => indexSearchSchema.parse(search),
  component: IndexManagerPage,
});

interface IndexField {
  id: string;
  field: string;
  direction: "ASC" | "DESC";
}

interface IndexRecord {
  id: string;
  collection: string;
  fields: Array<{ field: string; direction?: "ASC" | "DESC" }>;
  status: "BUILDING" | "READY" | "FAILED";
  entriesCount: number;
  createdAt: string;
}

function IndexManagerPage() {
  const { projectId } = useParams({ from: Route.id });
  const { t } = useI18n();
  const search = useSearch({ from: Route.id });
  const base = consoleProjectsBase(projectId);
  // V2 advisor endpoints are mounted at /v1 and accept the console session
  // bearer (via apiFetch), unlike the /v1/console data-plane proxy above.
  const v2Base = `/v1/projects/${encodeURIComponent(projectId)}`;

  const {
    data: realIndexes = [],
    isLoading,
    isError,
    error,
    refetch,
  } = useQuery({
    queryKey: ["indexes", projectId],
    queryFn: async () => {
      const res = await consoleFetch<{ indexes?: ConsoleIndex[] }>(`${base}/indexes`);
      const list = res.indexes ?? [];
      return list.map((idx) => ({
        id: idx.id,
        collection: idx.collectionPath ?? idx.collection ?? "collection",
        fields: (idx.fields ?? []).map((field) => ({ field: field.path, direction: field.dir === "desc" ? "DESC" as const : "ASC" as const })),
        status: (String(idx.status ?? "READY").toUpperCase() as "BUILDING" | "READY" | "FAILED"),
        entriesCount: idx.entriesCount ?? 0,
        createdAt: idx.createdAt ?? new Date().toISOString(),
      }));
    },
    // Poll while any index is building so BUILDING -> READY resolves in-place.
    refetchInterval: (query) =>
      query.state.data?.some((idx) => idx.status === "BUILDING") ? 1_500 : false,
  });

  // Live Smart Index Advisor recommendations. This is a secondary panel, so a
  // failure is rendered inline rather than taking down the whole indexes page.
  const {
    data: recommendations = [],
    isLoading: recommendationsLoading,
    isError: recommendationsError,
    refetch: refetchRecommendations,
  } = useQuery({
    queryKey: ["index-recommendations", projectId],
    queryFn: async () => {
      const res = await apiFetch<{ recommendations: Recommendation[] }>(
        `${v2Base}/indexes/recommendations`
      );
      return Array.isArray(res.recommendations) ? res.recommendations : [];
    },
  });
  const pendingRecommendations = recommendations.filter((r) => r.status === "pending");

  // Real persisted collections for quick-picking a target. This never replaces
  // the free-text #idxColl input: QA and users can still type a custom name.
  const { data: collectionsResponse } = useQuery({
    queryKey: ["collections", projectId],
    queryFn: () =>
      consoleFetch<{ collections: Array<{ name: string; documentCount: number }> }>(
        `${consoleProjectsBase(projectId)}/collections?limit=500`
      ),
  });
  const collections = collectionsResponse?.collections ?? [];

  const indexes = realIndexes;
  const [isCreateOpen, setIsCreateOpen] = React.useState<boolean>(false);
  const [targetCollection, setTargetCollection] = React.useState<string>("");
  const [fields, setFields] = React.useState<IndexField[]>([
    { id: "1", field: "", direction: "ASC" },
  ]);
  const [suggestion, setSuggestion] = React.useState<SuggestPayload | null>(null);
  // After "generalize to template" succeeds: the concrete index it replaced,
  // shown in a banner that offers to drop it (ADR-006 migration step).
  const [generalizedSource, setGeneralizedSource] = React.useState<IndexRecord | null>(null);
  const [activeFingerprint, setActiveFingerprint] = React.useState<string | null>(null);
  const processedSuggestRef = React.useRef<string | null>(null);

  // Handle deep-link from Query Playground error
  React.useEffect(() => {
    if (search.fromError === "missing_index") {
      setTargetCollection(search.collection ?? "users");
      if (search.fields) {
        const parsedFields: IndexField[] = search.fields
          .split(",")
          .map((part, i) => {
            const trimmed = part.trim();
            const [f, d] = trimmed.split(" ");
            return {
              id: String(i + 1),
              field: f ?? "",
              direction: (d?.toUpperCase() === "DESC" ? "DESC" : "ASC") as "ASC" | "DESC",
            };
          })
          .slice(0, 3);
        setFields(parsedFields);
      }
      setIsCreateOpen(true);
    }
  }, [search.fromError, search.collection, search.fields]);

  // Deep-link from the query advisor (?suggest=<base64url>). The ref guard makes
  // this idempotent across re-renders and locale changes.
  React.useEffect(() => {
    const raw = search.suggest;
    if (!raw || processedSuggestRef.current === raw) return;
    processedSuggestRef.current = raw;
    const decoded = decodeSuggestPayloadLocal(raw);
    if (!decoded) {
      toast.error(t("indexes.advisor.suggestDecodeFailed"));
      return;
    }
    setTargetCollection(decoded.collectionPath);
    setFields(
      decoded.fields.map((field, index) => ({
        id: `suggest-${index}`,
        field: field.path,
        direction: field.dir.toUpperCase() as "ASC" | "DESC",
      }))
    );
    setSuggestion(decoded);
    setActiveFingerprint(decoded.fingerprint);
    setIsCreateOpen(true);
  }, [search.suggest, t]);

  const handleAddField = () => {
    if (fields.length >= 3) {
      toast.error(t("indexes.maxFields"));
      return;
    }
    setFields((prev) => [
      ...prev,
      { id: Math.random().toString(), field: "", direction: "ASC" },
    ]);
  };

  const handleRemoveField = (id: string) => {
    if (fields.length <= 1) {
      toast.error(t("indexes.minFields"));
      return;
    }
    setFields((prev) => prev.filter((f) => f.id !== id));
  };

  const handleCreateIndex = async () => {
    const coll = targetCollection.trim();
    if (!coll) {
      toast.error(t("indexes.collectionRequired"));
      return;
    }
    const validFields = fields.filter((f) => f.field.trim() !== "");
    if (validFields.length === 0) {
      toast.error(t("indexes.fieldRequired"));
      return;
    }

    try {
      await consoleFetch(`${base}/indexes`, {
        method: "POST",
        body: JSON.stringify({
          collectionPath: coll,
          fields: validFields.map((f) => ({
            field: f.field.trim(),
            direction: f.direction,
          })),
          // The server marks the matching recommendation applied when present.
          ...(activeFingerprint ? { fingerprint: activeFingerprint } : {}),
        }),
      });
      await Promise.all([refetch(), refetchRecommendations()]);
      setIsCreateOpen(false);
      setSuggestion(null);
      setActiveFingerprint(null);
      toast.success(t("indexes.createdToast", { collection: coll }));
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : t("indexes.createFailed"));
    }
  };

  const handleDeleteIndex = async (id: string) => {
    // Guard: an index that is still building cannot be dropped safely.
    const target = indexes.find((idx) => idx.id === id);
    if (target?.status === "BUILDING") {
      toast.error(t("indexes.buildingGuard"));
      return;
    }
    try {
      await consoleFetch(`${base}/indexes/${id}`, {
        method: "DELETE",
      });
      await refetch();
      toast.success(t("indexes.droppedToast", { id }));
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : t("indexes.dropFailed"));
    }
  };

  // ADR-006 console migration: create the wildcard-template equivalent of a
  // nested concrete index, then offer to drop the now-redundant concrete one.
  const handleGeneralizeIndex = async (index: IndexRecord) => {
    const template = canonicalizeCollectionPathToTemplateLocal(index.collection);
    if (template === index.collection) return;
    try {
      await consoleFetch(`${base}/indexes`, {
        method: "POST",
        body: JSON.stringify({
          collectionPath: template,
          fields: index.fields.map((f) => ({
            field: f.field,
            direction: f.direction === "DESC" ? "desc" : "asc",
          })),
        }),
      });
      await refetch();
      setGeneralizedSource(index);
      toast.success(t("indexes.generalize.createdToast", { template }));
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : t("indexes.generalize.createFailed"));
    }
  };

  const handleApplyRecommendation = async (rec: Recommendation) => {
    try {
      await apiFetch(
        `${v2Base}/indexes/recommendations/${encodeURIComponent(rec.id)}/apply`,
        { method: "POST" }
      );
      toast.success(t("indexes.advisor.appliedToast"));
      await Promise.all([refetchRecommendations(), refetch()]);
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : t("indexes.advisor.applyFailed"));
    }
  };

  const handleDismissRecommendation = async (rec: Recommendation) => {
    try {
      await apiFetch(
        `${v2Base}/indexes/recommendations/${encodeURIComponent(rec.id)}/dismiss`,
        { method: "POST" }
      );
      toast.success(t("indexes.advisor.dismissedToast"));
      await Promise.all([refetchRecommendations(), refetch()]);
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : t("indexes.advisor.dismissFailed"));
    }
  };

  const advisorColumns: DataTableColumn<Recommendation>[] = [
    {
      id: "actions",
      header: t("common.actions"),
      align: "end",
      accessor: (rec) => (
        <div className="flex flex-wrap items-center justify-end gap-2">
          <Button size="sm" onClick={() => void handleApplyRecommendation(rec)}>
            <Zap className="h-3.5 w-3.5 me-1.5" />
            {t("indexes.advisor.createOneClick")}
          </Button>
          <Button variant="ghost" size="sm" onClick={() => void handleDismissRecommendation(rec)}>
            {t("indexes.advisor.dismiss")}
          </Button>
        </div>
      ),
    },
    {
      id: "collection",
      header: t("common.collection"),
      accessor: (rec) => (
        <div className="space-y-1">
          <span className="font-mono text-xs text-muted-foreground">/{rec.collectionPath}</span>
          <div className="flex flex-wrap items-center gap-1">
            {rec.recommendedFields.map((field, index) => (
              <Badge
                key={`${field.path}-${index}`}
                variant="outline"
                className="gap-1 font-mono text-[11px]"
              >
                <span>{field.path}</span>
                <span
                  className={
                    field.dir === "asc"
                      ? "font-semibold text-info"
                      : "font-semibold text-warning"
                  }
                >
                  {field.dir.toUpperCase()}
                </span>
              </Badge>
            ))}
          </div>
        </div>
      ),
    },
    {
      id: "hitCount",
      header: t("indexes.advisor.hits", { count: "—" }),
      mono: true,
      accessor: (rec) => (
        <Badge variant="outline" className="font-mono tabular-nums">
          {t("indexes.advisor.hits", { count: rec.hitCount })}
        </Badge>
      ),
    },
    {
      id: "maxDurationMs",
      header: t("indexes.advisor.maxLatency", { ms: "—" }),
      mono: true,
      align: "end",
      accessor: (rec) => (
        <Badge variant="outline" className="font-mono tabular-nums">
          {t("indexes.advisor.maxLatency", { ms: Math.round(rec.maxDurationMs) })}
        </Badge>
      ),
    },
    {
      id: "reason",
      header: t("indexes.advisor.description"),
      accessor: (rec) => (
        <div className="space-y-0.5">
          <p className="text-xs text-muted-foreground">{rec.reason}</p>
          <p className="text-[11px] text-muted-foreground/70">
            {t("indexes.advisor.lastSeen", { at: rec.lastSeenAt })}
          </p>
        </div>
      ),
    },
  ];

  const columns: ColumnDef<IndexRecord, unknown>[] = [
        {
      accessorKey: "id",
      header: t("indexes.columnId"),
      cell: ({ row }) => (
        <span className="font-mono text-xs font-semibold">{row.original.id}</span>
      ),
    },
    {
      accessorKey: "collection",
      header: t("common.collection"),
      cell: ({ row }) => (
        <span className="font-mono text-xs text-muted-foreground inline-flex items-center gap-1.5">
          /{row.original.collection}
          {isTemplateCollectionPathLocal(row.original.collection) ? (
            <Badge variant="outline" className="font-mono text-[10px] text-info border-info/40">
              {t("indexes.templateBadge")}
            </Badge>
          ) : null}
        </span>
      ),
    },
    {
      accessorKey: "fields",
      header: t("indexes.columnFields"),
      cell: ({ row }) => (
        <div className="flex flex-wrap items-center gap-1">
          {row.original.fields.map((f, i) => (
            <Badge key={i} variant="outline" className="font-mono text-[11px] gap-1">
              <span>{f.field}</span>
              <span className={f.direction === "ASC" ? "text-info font-semibold" : "text-warning font-semibold"}>
                {f.direction}
              </span>
            </Badge>
          ))}
        </div>
      ),
    },
    {
      accessorKey: "status",
      header: t("common.status"),
      cell: ({ row }) => {
        const s = row.original.status;
        if (s === "BUILDING") {
          return (
            <Badge className="bg-warning/10 text-warning border-warning/30 gap-1 font-mono text-[11px]">
              <Loader2 className="h-3 w-3 animate-spin" />
              {t("common.building")}
            </Badge>
          );
        }
        if (s === "READY") {
          return (
            <Badge className="bg-success/10 text-success border-success/30 gap-1 font-mono text-[11px]">
              <CheckCircle2 className="h-3 w-3" />
              {t("common.ready")}
            </Badge>
          );
        }
        return (
          <Badge variant="destructive" className="gap-1 font-mono text-[11px]">
            <AlertTriangle className="h-3 w-3" />
            {t("common.failed")}
          </Badge>
        );
      },
    },
    {
      accessorKey: "entriesCount",
      header: () => <span className="block text-right">{t("indexes.columnEntries")}</span>,
      cell: ({ row }) => (
        <span className="block text-right font-mono text-xs tabular-nums">{row.original.entriesCount.toLocaleString()}</span>
      ),
    },
    {
      id: "actions",
      header: () => <span className="block text-right">{t("common.actions")}</span>,
      cell: ({ row }) => {
        const isBuilding = row.original.status === "BUILDING";
        const canGeneralize =
          !isBuilding &&
          !isTemplateCollectionPathLocal(row.original.collection) &&
          canonicalizeCollectionPathToTemplateLocal(row.original.collection) !== row.original.collection;
        return (
        <div className="flex justify-end gap-1">
        {canGeneralize ? (
          <Button
            variant="ghost"
            size="sm"
            title={t("indexes.generalize.title")}
            className="h-7 w-7 p-0 text-muted-foreground hover:text-primary"
            onClick={() => void handleGeneralizeIndex(row.original)}
          >
            <Wand2 className="h-3.5 w-3.5" />
          </Button>
        ) : null}
        <AlertDialog>
          <AlertDialogTrigger asChild>
            <Button
              variant="ghost"
              size="sm"
              disabled={isBuilding}
              title={isBuilding ? t("indexes.buildingTitle") : t("indexes.dropIndexTitle")}
              className="h-7 w-7 p-0 text-muted-foreground hover:text-destructive"
            >
              <Trash2 className="h-3.5 w-3.5" />
            </Button>
          </AlertDialogTrigger>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>{t("indexes.dropTitle")}</AlertDialogTitle>
              <AlertDialogDescription>
                {t("indexes.dropDescription", { id: row.original.id })}
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>{t("common.cancel")}</AlertDialogCancel>
              <AlertDialogAction
                className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                onClick={() => handleDeleteIndex(row.original.id)}
              >
                {t("indexes.dropConfirm")}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
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
        message={error instanceof Error ? error.message : t("indexes.loadFailed")}
        onRetry={() => void refetch()}
      />
    );
  }

  return (
    <PageContent>
      <ConfigurablePageHeader
        title={t("indexes.title")}
        description={t("indexes.description")}
        actions={
          <Dialog open={isCreateOpen} onOpenChange={setIsCreateOpen}>
            <DialogTrigger asChild>
              <Button>
                <Plus className="h-4 w-4 me-2 rtl:rotate-180" />
                {t("indexes.create")}
              </Button>
            </DialogTrigger>
            <DialogContent className="max-w-md">
              <DialogHeader>
                <DialogTitle>{t("indexes.createTitle")}</DialogTitle>
                <DialogDescription>
                  {t("indexes.createDescription")}
                </DialogDescription>
              </DialogHeader>

              <div className="space-y-4 py-2">
                <div className="space-y-1.5">
                  <Label htmlFor="idxColl" className="text-xs">{t("common.collection")}</Label>
                  <Input
                    id="idxColl"
                    placeholder={t("indexes.collectionPlaceholder")}
                    value={targetCollection}
                    onChange={(e) => setTargetCollection(e.target.value)}
                    className="font-mono text-xs h-8"
                  />
                  <div className="flex flex-wrap items-center gap-2 pt-1">
                    <Label htmlFor="idxQuickCollections" className="text-[11px] text-muted-foreground">
                      {t("indexes.quickCollections")}
                    </Label>
                    <Select value="" onValueChange={setTargetCollection}>
                      <SelectTrigger id="idxQuickCollections" className="h-8 w-full text-xs sm:w-52">
                        <SelectValue placeholder={t("indexes.collectionPlaceholder")} />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectGroup>
                          <SelectLabel>{t("indexes.quickCollections")}</SelectLabel>
                          {collections.length === 0 ? (
                            <SelectItem value="__no_collections__" disabled>
                              {t("collections.noCollections")}
                            </SelectItem>
                          ) : (
                            collections.map((item) => (
                              <SelectItem key={item.name} value={item.name} className="font-mono text-xs">
                                <span dir="auto">{item.name}</span>
                                <Badge
                                  variant="secondary"
                                  className="ms-auto font-mono text-[10px] tabular-nums"
                                >
                                  {t("collections.documents", { count: item.documentCount })}
                                </Badge>
                              </SelectItem>
                            ))
                          )}
                        </SelectGroup>
                      </SelectContent>
                    </Select>
                  </div>
                </div>

                <div className="space-y-2 border-t pt-3">
                  <div className="flex items-center justify-between">
                    <Label className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                      {t("indexes.fieldsLabel", { count: fields.length })}
                    </Label>
                    <Button
                      variant="outline"
                      size="sm"
                      className="h-7 text-xs"
                      onClick={handleAddField}
                      disabled={fields.length >= 3}
                    >
                      <Plus className="h-3 w-3 me-1 rtl:rotate-180" />
                      {t("indexes.addField")}
                    </Button>
                  </div>

                  <div className="space-y-2">
                    {fields.map((f, idx) => (
                      <div key={f.id} className="flex items-center gap-2">
                        <span className="font-mono text-xs text-muted-foreground w-4">{idx + 1}.</span>
                        <Input
                          placeholder={t("indexes.fieldPlaceholder")}
                          value={f.field}
                          onChange={(e) =>
                            setFields((prev) =>
                              prev.map((item) =>
                                item.id === f.id ? { ...item, field: e.target.value } : item
                              )
                            )
                          }
                          className="h-8 font-mono text-xs flex-1"
                        />
                          <div className="w-28">
                            <Select
                              value={f.direction}
                              onValueChange={(val) =>
                                setFields((prev) =>
                                  prev.map((item) =>
                                    item.id === f.id
                                      ? { ...item, direction: val as "ASC" | "DESC" }
                                      : item
                                  )
                                )
                              }
                            >
                              <SelectTrigger className="h-8 font-mono text-xs">
                                <SelectValue placeholder={t("indexes.dirPlaceholder")} />
                              </SelectTrigger>
                              <SelectContent>
                                <SelectItem value="ASC" className="font-mono text-xs">ASC</SelectItem>
                                <SelectItem value="DESC" className="font-mono text-xs">DESC</SelectItem>
                              </SelectContent>
                            </Select>
                          </div>
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-8 w-8 p-0 text-muted-foreground hover:text-destructive"
                          onClick={() => handleRemoveField(f.id)}
                          disabled={fields.length <= 1}
                        >
                          <Trash2 className="h-4 w-4" />
                        </Button>
                      </div>
                    ))}
                  </div>
                </div>
              </div>

              <DialogFooter className="mt-4">
                <Button variant="outline" onClick={() => setIsCreateOpen(false)}>
                  {t("common.cancel")}
                </Button>
                <Button onClick={handleCreateIndex}>{t("indexes.build")}</Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
        }
      />

      {suggestion ? (
        <Card className="border-primary/40 bg-primary/5">
          <CardHeader className="pb-2">
            <CardTitle className="flex items-center gap-2 text-sm font-semibold">
              <Sparkles className="h-4 w-4 text-primary" />
              {t("indexes.advisor.suggestBannerTitle")}
            </CardTitle>
            <CardDescription className="text-xs">
              {t("indexes.advisor.suggestBannerDescription")}
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-2">
            <p className="text-xs text-muted-foreground">{suggestion.reason}</p>
            {suggestion.exampleCollectionPath ? (
              <p className="text-[11px] text-muted-foreground/70 font-mono">
                {t("indexes.advisor.exampleLabel")}: /{suggestion.exampleCollectionPath}
              </p>
            ) : null}
            <div className="flex flex-wrap items-center gap-2">
              <Badge variant="outline" className="font-mono text-[11px]">
                {t("indexes.advisor.collectionLabel")}: /{suggestion.collectionPath}
              </Badge>
              {suggestion.fields.map((field, index) => (
                <Badge
                  key={`${field.path}-${index}`}
                  variant="outline"
                  className="font-mono text-[11px] gap-1"
                >
                  <span>{field.path}</span>
                  <span
                    className={
                      field.dir === "asc"
                        ? "text-info font-semibold"
                        : "text-warning font-semibold"
                    }
                  >
                    {field.dir.toUpperCase()}
                  </span>
                </Badge>
              ))}
            </div>
          </CardContent>
        </Card>
      ) : null}

      {generalizedSource ? (
        <div className="rounded-md border border-info/40 bg-info/10 p-3 text-xs flex flex-wrap items-center justify-between gap-2">
          <p className="text-info-700 dark:text-info-400">
            {t("indexes.generalize.offerDrop", { collection: generalizedSource.collection })}
          </p>
          <div className="flex items-center gap-2">
            <Button size="sm" variant="outline" onClick={() => setGeneralizedSource(null)}>
              {t("indexes.generalize.keepConcrete")}
            </Button>
            <Button
              size="sm"
              variant="destructive"
              onClick={() => {
                void handleDeleteIndex(generalizedSource.id);
                setGeneralizedSource(null);
              }}
            >
              {t("indexes.generalize.dropConcrete")}
            </Button>
          </div>
        </div>
      ) : null}

      <Card>
        <CardHeader className="pb-3">
          <div className="flex items-start justify-between gap-2">
            <div>
              <CardTitle className="flex items-center gap-2 text-base font-semibold">
                <Sparkles className="h-4 w-4 text-primary" />
                {t("indexes.advisor.title")}
              </CardTitle>
              <CardDescription className="text-xs">
                {t("indexes.advisor.description")}
              </CardDescription>
            </div>
            {pendingRecommendations.length > 0 ? (
              <Badge variant="secondary" className="font-mono text-[11px]">
                {t("indexes.advisor.pendingCount", { count: pendingRecommendations.length })}
              </Badge>
            ) : null}
          </div>
        </CardHeader>
        <CardContent>
          {recommendationsLoading ? (
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
              {t("indexes.advisor.loading")}
            </div>
          ) : recommendationsError ? (
            <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs text-destructive">
              <span>{t("indexes.advisor.loadFailed")}</span>
              <Button
                variant="outline"
                size="sm"
                className="h-7 text-xs"
                onClick={() => void refetchRecommendations()}
              >
                {t("indexes.advisor.retry")}
              </Button>
            </div>
          ) : pendingRecommendations.length === 0 ? (
            <p className="text-xs text-muted-foreground">{t("indexes.advisor.empty")}</p>
          ) : (
            <DataTable
              rows={pendingRecommendations}
              columns={advisorColumns}
              getRowId={(rec) => rec.id}
            />
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base font-semibold">{t("indexes.activeTitle")}</CardTitle>
          <CardDescription className="text-xs">
            {t("indexes.activeDescription")}
          </CardDescription>
        </CardHeader>
        <CardContent>
          {indexes.length === 0 ? (
            <EmptyState
              icon={<Layers className="h-10 w-10 text-muted-foreground/60" />}
              title={t("indexes.emptyTitle")}
              description={t("indexes.emptyDescription")}
              action={
                <Button onClick={() => setIsCreateOpen(true)}>
                  <Plus className="h-4 w-4 me-1.5 rtl:rotate-180" />
                  {t("indexes.create")}
                </Button>
              }
            />
          ) : (
            <DataGrid
              columns={columns}
              data={indexes}
              pageSize={10}
              getRowId={(row) => row.id}
            />
          )}
        </CardContent>
      </Card>
    </PageContent>
  );
}
