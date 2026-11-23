import * as React from "react";
import { createRoute, useNavigate, useParams, useSearch } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { z } from "zod";
import { Route as projectRoute } from "./orgs.$orgId.projects.$projectId.js";
import {
  consoleFetch,
  consoleProjectsBase,
  type ConsoleDocument,
  type ConsoleQueryResponse,
} from "../../lib/api.js";
import { parseDashboardImport, batchDashboardImport } from "../../lib/import.js";
import { VirtualTable } from "../../components/virtual-table.js";
import {
  ConfigurablePageHeader,
  ConsoleCopyableField,
  JsonInspector,
  PageContent,
  Card,
  Button,
  Input,
  Textarea,
  Label,
  Badge,
  CodeEditor,
  FieldTypeBadge,
  EmptyState,
  LoadingState,
  ErrorState,
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
  Tabs,
  TabsList,
  TabsTrigger,
  TabsContent,
  ResizablePanelGroup,
  ResizablePanel,
  ResizableHandle,
  KeyValueRow,
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  ConsoleDetailSheet as DetailSheet,
  ConfirmDangerDialog,
  useI18n,
} from "@vellum/ui";
import { toast } from "sonner";
import {
  FolderPlus,
  Folder,
  FileText,
  Plus,
  Save,
  Trash2,
  Layers,
  Code2,
  ListTree,
  Info,
  Search,
  ChevronLeft,
  ChevronRight,
  ChevronDown,
  Clock,
  MoreHorizontal,
  Settings,
  Download,
  Upload,
  Eraser,
  RefreshCw,
} from "lucide-react";

const dataSearchSchema = z.object({
  collection: z.string().optional(),
});

export const Route = createRoute({
  getParentRoute: () => projectRoute,
  path: "data",
  validateSearch: (search) => dataSearchSchema.parse(search),
  component: DataExplorerPage,
});

interface DocumentRow {
  id: string;
  version: number;
  createdAt: string;
  updatedAt: string;
  data: Record<string, unknown>;
}

interface CollectionSchemaValidation {
  requiredFields?: string[];
  strict?: boolean;
}

/** Console projection of `project_collections` including live statistics. */
interface CollectionWithStats {
  id: string;
  name: string;
  description: string | null;
  defaultTtlSeconds: number | null;
  schemaValidation: CollectionSchemaValidation | null;
  documentCount: number;
  storageBytes: number;
  /** Legacy alias some API revisions emit instead of `lastDocumentAt`. */
  lastDocumentAfter?: string | null;
  lastDocumentAt: string | null;
  createdAt: string;
  updatedAt: string;
}

interface ImportResult {
  importedCount: number;
  skippedCount: number;
  errors: unknown[];
}

interface ClearResult {
  deletedCount: number;
  freedBytes: number;
}

function parseNonNegativeInt(raw: string): number | null {
  const value = Number.parseInt(raw.trim(), 10);
  return Number.isFinite(value) && value > 0 ? value : null;
}

function parseRequiredFields(raw: string): string[] {
  return raw
    .split(",")
    .map((field) => field.trim())
    .filter((field) => field.length > 0);
}

function inferWireType(val: unknown): string {
  if (val === null) return "null";
  if (Array.isArray(val)) return "array";
  if (typeof val === "boolean") return "boolean";
  if (typeof val === "number") return Number.isInteger(val) ? "int64" : "number";
  if (typeof val === "string") {
    if (val.startsWith("projects/") || val.startsWith("/")) return "reference";
    if (/^\d{4}-\d{2}-\d{2}T/.test(val)) return "timestamp";
    return "string";
  }
  if (typeof val === "object") return "map";
  return "string";
}

const PAGE_SIZE = 25;

/**
 * Desktop keeps the original three resizable panes. Below `lg` the very same
 * markup is rendered as plain blocks, with only the active master/detail step
 * visible — the others are removed from layout with an inline `display: none`.
 * Defining these at module scope keeps the element types stable across renders
 * (so CodeMirror and the virtual table never remount while typing).
 */
function ExplorerGroup({
  isNarrow,
  className,
  children,
}: {
  isNarrow: boolean;
  className?: string;
  children?: React.ReactNode;
}) {
  if (!isNarrow) {
    return (
      <ResizablePanelGroup direction="horizontal" className={className}>
        {children}
      </ResizablePanelGroup>
    );
  }
  return (
    <div className={`flex min-h-0 min-w-0 flex-col ${className ?? ""}`}>{children}</div>
  );
}

function ExplorerPane({
  isNarrow,
  visible,
  className,
  children,
  ...panelProps
}: React.ComponentProps<typeof ResizablePanel> & {
  isNarrow: boolean;
  visible: boolean;
}) {
  if (!isNarrow) {
    return (
      <ResizablePanel {...panelProps} className={className}>
        {children}
      </ResizablePanel>
    );
  }
  return (
    <div
      className={`${className ?? ""} min-h-0 min-w-0 flex-1`}
      style={visible ? undefined : { display: "none" }}
    >
      {children}
    </div>
  );
}

function ExplorerHandle({ isNarrow }: { isNarrow: boolean }) {
  return isNarrow ? null : <ResizableHandle withHandle />;
}

function DataExplorerPage() {
  const { t } = useI18n();
  // Three resizable panes only work side by side on a real desktop viewport.
  // Below the `lg` breakpoint we show one pane at a time (master -> detail).
  const [isNarrow, setIsNarrow] = React.useState(false);
  React.useEffect(() => {
    const mq = window.matchMedia("(max-width: 1023px)");
    const update = (): void => setIsNarrow(mq.matches);
    update();
    mq.addEventListener("change", update);
    return () => mq.removeEventListener("change", update);
  }, []);
  // Which single pane is visible in the mobile master/detail flow.
  const [mobileStep, setMobileStep] = React.useState<
    "collections" | "documents" | "editor"
  >("collections");
  const { orgId, projectId } = useParams({ from: Route.id });
  const base = consoleProjectsBase(projectId);
  const navigate = useNavigate();
  const search = useSearch({ from: Route.id });
  const queryClient = useQueryClient();

  const invalidateCollections = (): Promise<void> =>
    queryClient.invalidateQueries({ queryKey: ["collections", projectId] });

  const {
    data: collectionsPage,
    isLoading: isCollectionsLoading,
    isError: isCollectionsError,
    refetch: refetchCollections,
  } = useQuery({
    queryKey: ["collections", projectId],
    queryFn: () =>
      // The registry can hold more than the API's default page of 50; request
      // the maximum so empty/legacy/SDK-created collections are never hidden
      // (which would break ?collection= deep links and F5 persistence).
      consoleFetch<{ collections: CollectionWithStats[]; nextCursor: string | null }>(
        `${base}/collections?limit=500`
      ),
  });

  const collections = collectionsPage?.collections ?? [];
  const collectionNames = React.useMemo(
    () => collections.map((collection) => collection.name),
    [collections]
  );

  const urlCollection = typeof search.collection === "string" ? search.collection : "";

  // A freshly created collection is selected before the refetch makes it appear
  // in the list. The pending value pins the selection until it is visible.
  const [pendingSelection, setPendingSelection] = React.useState<string | null>(null);

  const selectedCollection =
    pendingSelection ??
    (urlCollection && collectionNames.includes(urlCollection)
      ? urlCollection
      : (collectionNames[0] ?? ""));

  // Auto-select the first collection on first load, and keep `?collection=`
  // authoritative so F5 / deep links restore the exact selection.
  React.useEffect(() => {
    if (pendingSelection !== null) {
      if (collectionNames.includes(pendingSelection)) setPendingSelection(null);
      return;
    }
    if (isCollectionsLoading || isCollectionsError) return;
    if (selectedCollection !== urlCollection) {
      void navigate({
        to: "/app/orgs/$orgId/projects/$projectId/data",
        params: { orgId, projectId },
        search: { collection: selectedCollection || undefined },
        replace: true,
      });
    }
  }, [
    pendingSelection,
    collectionNames,
    isCollectionsLoading,
    isCollectionsError,
    selectedCollection,
    urlCollection,
    navigate,
    orgId,
    projectId,
  ]);

  const [collectionFilter, setCollectionFilter] = React.useState<string>("");
  const filteredCollections = React.useMemo(() => {
    const needle = collectionFilter.trim().toLowerCase();
    if (!needle) return collections;
    return collections.filter((collection) =>
      collection.name.toLowerCase().includes(needle)
    );
  }, [collections, collectionFilter]);

  const [selectedDocId, setSelectedDocId] = React.useState<string | null>(null);
  const [editorJson, setEditorJson] = React.useState<string>("");
  const [editorError, setEditorError] = React.useState<string | null>(null);
  const [inspectorTab, setInspectorTab] = React.useState<"editor" | "fields" | "meta">("editor");
  const [newCollectionName, setNewCollectionName] = React.useState<string>("");
  const [newCollectionDescription, setNewCollectionDescription] = React.useState<string>("");
  const [newCollectionTtl, setNewCollectionTtl] = React.useState<string>("");
  const [newCollectionRequiredFields, setNewCollectionRequiredFields] = React.useState<string>("");
  const [showAdvancedFields, setShowAdvancedFields] = React.useState<boolean>(false);
  const [isAddCollectionOpen, setIsAddCollectionOpen] = React.useState<boolean>(false);
  const [settingsCollection, setSettingsCollection] = React.useState<string | null>(null);
  const [isSettingsOpen, setIsSettingsOpen] = React.useState<boolean>(false);
  const [settingsDescription, setSettingsDescription] = React.useState<string>("");
  const [settingsTtl, setSettingsTtl] = React.useState<string>("");
  const [settingsRequiredFields, setSettingsRequiredFields] = React.useState<string>("");
  const [importCollection, setImportCollection] = React.useState<string | null>(null);
  const [isImportOpen, setIsImportOpen] = React.useState<boolean>(false);
  const [isImporting, setIsImporting] = React.useState(false);
  const importInFlight = React.useRef(false);
  const [importText, setImportText] = React.useState<string>("");
  const [importResult, setImportResult] = React.useState<ImportResult | null>(null);
  const [clearCollection, setClearCollection] = React.useState<string | null>(null);
  const [deleteCollection, setDeleteCollection] = React.useState<string | null>(null);
  const [newDocId, setNewDocId] = React.useState<string>("");
  const [isAddDocOpen, setIsAddDocOpen] = React.useState<boolean>(false);
  const [isCreatingCollection, setIsCreatingCollection] = React.useState<boolean>(false);
  const [isCreatingDoc, setIsCreatingDoc] = React.useState<boolean>(false);
  const [isSavingDoc, setIsSavingDoc] = React.useState<boolean>(false);
  const [isDeletingDoc, setIsDeletingDoc] = React.useState<boolean>(false);
  const [docFilter, setDocFilter] = React.useState<string>("");

  const [debouncedFilter, setDebouncedFilter] = React.useState("");
  React.useEffect(() => {
    const timer = window.setTimeout(() => {
      setDebouncedFilter(docFilter.trim());
      setCursor(null);
      setCursorHistory([null]);
      setSelectedDocId(null);
    }, 300);
    return () => window.clearTimeout(timer);
  }, [docFilter]);

  // Server-side cursor pagination. `cursorHistory[i]` is the cursor used for
  // page i; the stack lets us walk backwards without OFFSET.
  const [cursor, setCursor] = React.useState<string | null>(null);
  const [cursorHistory, setCursorHistory] = React.useState<Array<string | null>>([null]);

  const {
    data: page,
    isLoading,
    isError,
    error,
    refetch,
  } = useQuery({
    queryKey: ["documents", projectId, selectedCollection, cursor, PAGE_SIZE, debouncedFilter],
    queryFn: async () => {
      const params = new URLSearchParams({ limit: String(PAGE_SIZE) });
      if (cursor) params.set("startAfter", cursor);
      if (debouncedFilter) params.set("search", debouncedFilter);
      return consoleFetch<ConsoleQueryResponse<ConsoleDocument>>(
        `${base}/documents/${encodeURIComponent(selectedCollection)}?${params.toString()}`
      );
    },
    enabled: Boolean(selectedCollection),
  });

  const currentDocs: DocumentRow[] = React.useMemo(() => {
    return (page?.documents ?? []).map((d) => ({
      id: String(d.id ?? d.path?.split("/").pop() ?? ""),
      version: d.version ?? 1,
      createdAt: d.createdAt ?? new Date().toISOString(),
      updatedAt: d.updatedAt ?? new Date().toISOString(),
      data: d.data ?? {},
    }));
  }, [page]);

  const filteredDocs = currentDocs;

  const selectedDoc = currentDocs.find((d) => d.id === selectedDocId) ?? currentDocs[0] ?? null;
  const nextCursor = page?.nextCursor ?? null;

  // Live, read-only structured view of whatever is currently in the editor.
  const parsedEditorValue = React.useMemo<unknown>(() => {
    try {
      return JSON.parse(editorJson) as unknown;
    } catch {
      return selectedDoc?.data ?? {};
    }
  }, [editorJson, selectedDoc]);

  React.useEffect(() => {
    if (selectedDoc) {
      setSelectedDocId(selectedDoc.id);
      setEditorJson(JSON.stringify(selectedDoc.data, null, 2));
      setEditorError(null);
    } else {
      setEditorJson("");
    }
  }, [selectedDoc]);

  const handleCollectionChange = (name: string) => {
    setSelectedDocId(null);
    setCursor(null);
    setCursorHistory([null]);
    // Selecting a collection reveals its documents on the mobile flow.
    if (isNarrow) setMobileStep("documents");
    void navigate({
      to: "/app/orgs/$orgId/projects/$projectId/data",
      params: { orgId, projectId },
      search: { collection: name || undefined },
      replace: true,
    });
  };

  const handleNextPage = () => {
    if (!nextCursor) return;
    setCursorHistory((prev) => [...prev, nextCursor]);
    setCursor(nextCursor);
    setSelectedDocId(null);
  };

  const handlePrevPage = () => {
    if (cursorHistory.length <= 1) return;
    const nextHistory = cursorHistory.slice(0, -1);
    setCursorHistory(nextHistory);
    setCursor(nextHistory[nextHistory.length - 1] ?? null);
    setSelectedDocId(null);
  };

  const handleCreateCollection = async () => {
    if (isCreatingCollection) return;
    const trimmed = newCollectionName.trim().toLowerCase();
    if (!trimmed) return;
    if (collectionNames.includes(trimmed)) {
      toast.error(t("data.collectionExists"));
      return;
    }
    setIsCreatingCollection(true);
    const previousSelection = selectedCollection;
    const ttl = parseNonNegativeInt(newCollectionTtl);
    const requiredFields = parseRequiredFields(newCollectionRequiredFields);
    setPendingSelection(trimmed);
    handleCollectionChange(trimmed);
    const toastId = toast.loading(t("data.collectionSelected", { name: trimmed }));
    try {
      await consoleFetch(`${base}/collections`, {
        method: "POST",
        body: JSON.stringify({
          name: trimmed,
          ...(newCollectionDescription.trim()
            ? { description: newCollectionDescription.trim() }
            : {}),
          ...(ttl !== null ? { defaultTtlSeconds: ttl } : {}),
          ...(requiredFields.length > 0 ? { schemaValidation: { requiredFields } } : {}),
        }),
      });
      await invalidateCollections();
      setNewCollectionName("");
      setNewCollectionDescription("");
      setNewCollectionTtl("");
      setNewCollectionRequiredFields("");
      setShowAdvancedFields(false);
      setIsAddCollectionOpen(false);
      toast.success(t("data.collectionCreated", { name: trimmed }), { id: toastId });
    } catch (err: unknown) {
      setPendingSelection(null);
      handleCollectionChange(previousSelection || collectionNames[0] || "");
      toast.error(err instanceof Error ? err.message : t("data.collectionCreateFailed"), { id: toastId });
    } finally {
      setIsCreatingCollection(false);
    }
  };

  const openSettings = (collection: CollectionWithStats) => {
    setSettingsCollection(collection.name);
    setSettingsDescription(collection.description ?? "");
    setSettingsTtl(
      collection.defaultTtlSeconds !== null ? String(collection.defaultTtlSeconds) : ""
    );
    setSettingsRequiredFields((collection.schemaValidation?.requiredFields ?? []).join(", "));
    setIsSettingsOpen(true);
  };

  const handleSaveSettings = async () => {
    if (!settingsCollection) return;
    const ttl = parseNonNegativeInt(settingsTtl);
    const requiredFields = parseRequiredFields(settingsRequiredFields);
    try {
      await consoleFetch(
        `${base}/collections/${encodeURIComponent(settingsCollection)}`,
        {
          method: "PATCH",
          body: JSON.stringify({
            description: settingsDescription.trim() || null,
            defaultTtlSeconds: ttl,
            schemaValidation:
              requiredFields.length > 0 ? { requiredFields } : null,
          }),
        }
      );
      await invalidateCollections();
      setIsSettingsOpen(false);
      toast.success(t("data.collectionUpdated", { name: settingsCollection }));
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : t("data.collectionUpdateFailed"));
    }
  };

  const handleExportCollection = async (name: string) => {
    try {
      const payload = await consoleFetch<{ documents: unknown[] }>(
        `${base}/collections/${encodeURIComponent(name)}/export`
      );
      const blob = new Blob([JSON.stringify(payload, null, 2)], {
        type: "application/json",
      });
      const objectUrl = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = objectUrl;
      anchor.download = `${name}.json`;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      URL.revokeObjectURL(objectUrl);
      toast.success(t("data.collectionExported", { name }));
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : t("data.collectionExportFailed"));
    }
  };

  const openImport = (name: string) => {
    setImportCollection(name);
    setImportText("");
    setImportResult(null);
    setIsImportOpen(true);
  };

  const handleImportFile = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;
    setImportText(await file.text());
  };

  const handleImportCollection = async () => {
    if (!importCollection || importInFlight.current) return;
    let documents: unknown;
    try {
      const parsed: unknown = JSON.parse(importText);
      documents = parsed && typeof parsed === "object" && !Array.isArray(parsed)
        && "documents" in parsed ? parsed.documents : parsed;
    } catch {
      toast.error(t("data.invalidJsonToast"));
      return;
    }
    if (!Array.isArray(documents)) {
      toast.error(t("data.importMustBeArray"));
      return;
    }
    try {
      importInFlight.current = true;
      setIsImporting(true);
      // Export rows carry read-only metadata. Import only their ID and data.
      const rows = parseDashboardImport(documents);
      // Small sequential batches preserve transport key-count/size guards.
      const result: ImportResult = { importedCount: 0, skippedCount: 0, errors: [] };
      for (const documents of batchDashboardImport(rows)) {
        const batch = await consoleFetch<ImportResult>(
          `${base}/collections/${encodeURIComponent(importCollection)}/import`,
          { method: "POST", body: JSON.stringify({ documents: documents, mode: "upsert" }) }
        );
        result.importedCount += batch.importedCount;
        result.skippedCount += batch.skippedCount;
        result.errors.push(...batch.errors);
      }
      setImportResult(result);
      await invalidateCollections();
      toast.success(
        t("data.collectionImported", {
          name: importCollection,
          imported: result.importedCount,
          skipped: result.skippedCount,
        })
      );
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : t("data.collectionImportFailed"));
    } finally {
      importInFlight.current = false;
      setIsImporting(false);
    }
  };

  const handleClearCollection = async () => {
    if (!clearCollection) return;
    try {
      const result = await consoleFetch<ClearResult>(
        `${base}/collections/${encodeURIComponent(clearCollection)}/clear`,
        { method: "POST" }
      );
      await invalidateCollections();
      await refetch();
      setClearCollection(null);
      toast.success(t("data.collectionCleared", { count: result.deletedCount }));
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : t("data.collectionClearFailed"));
    }
  };

  const handleDeleteCollection = async () => {
    if (!deleteCollection) return;
    const name = deleteCollection;
    try {
      await consoleFetch(`${base}/collections/${encodeURIComponent(name)}`, {
        method: "DELETE",
      });
      await invalidateCollections();
      if (selectedCollection === name) {
        setPendingSelection(null);
        const remaining = collectionNames.filter((candidate) => candidate !== name);
        handleCollectionChange(remaining[0] ?? "");
      }
      setDeleteCollection(null);
      toast.success(t("data.collectionDeleted", { name }));
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : t("data.collectionDeleteFailed"));
    }
  };

  const handleCreateDocument = async () => {
    if (isCreatingDoc) return;
    if (!selectedCollection) {
      toast.error(t("data.selectCollectionFirst"));
      return;
    }
    setIsCreatingDoc(true);
    const docId = newDocId.trim() || `doc_${Date.now()}`;
    try {
      await consoleFetch(`${base}/documents/${selectedCollection}/${docId}`, {
        method: "POST",
        body: JSON.stringify({ data: { createdAt: new Date().toISOString() } }),
      });
      await refetch();
      await invalidateCollections();
      setSelectedDocId(docId);
      setNewDocId("");
      setIsAddDocOpen(false);
      toast.success(t("data.documentCreated", { id: docId }));
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : t("data.documentCreateFailed"));
    } finally {
      setIsCreatingDoc(false);
    }
  };

  const handleSaveDocument = async () => {
    if (isSavingDoc) return;
    if (!selectedDoc) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(editorJson);
    } catch (err: unknown) {
      setEditorError(err instanceof Error ? err.message : t("data.invalidJson"));
      toast.error(t("data.invalidJsonToast"));
      return;
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      setEditorError(t("data.mustBeObject"));
      toast.error(t("data.mustBeObject"));
      return;
    }
    setEditorError(null);
    setIsSavingDoc(true);
    try {
      const saved = await consoleFetch<ConsoleDocument>(`${base}/documents/${selectedCollection}/${selectedDoc.id}`, {
        method: "PUT",
        body: JSON.stringify({ data: parsed, ifVersion: selectedDoc.version }),
      });
      await refetch();
      await invalidateCollections();
      toast.success(t("data.documentSaved", { version: saved.version }));
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : t("data.documentSaveFailed");
      if (/version|conflict|occ/i.test(msg)) {
        await refetch();
        toast.error(t("data.concurrentEdit"));
      } else {
        toast.error(msg);
      }
    } finally {
      setIsSavingDoc(false);
    }
  };

  const handleDeleteDocument = async () => {
    if (isDeletingDoc) return;
    if (!selectedDoc) return;
    setIsDeletingDoc(true);
    try {
      await consoleFetch(
        `${base}/documents/${selectedCollection}/${selectedDoc.id}?ifVersion=${selectedDoc.version}`,
        { method: "DELETE" }
      );
      await refetch();
      await invalidateCollections();
      setSelectedDocId(null);
      toast.success(t("data.documentDeleted"));
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : t("data.documentDeleteFailed"));
    } finally {
      setIsDeletingDoc(false);
    }
  };

  return (
    <PageContent>
      <ConfigurablePageHeader
        title={t("data.title")}
        description={t("data.description")}
      />

      <Card className={`overflow-hidden p-0 ${isNarrow ? "min-w-0 h-[calc(100dvh-12rem)] min-h-[420px]" : "h-[750px]"}`}>
        <ExplorerGroup isNarrow={isNarrow} className="h-full">
          {/* Pane 1: Collections Tree */}
          <ExplorerPane
            isNarrow={isNarrow}
            visible={mobileStep === "collections"}
            defaultSize={20}
            minSize={16}
            maxSize={30}
            className="flex flex-col bg-muted/20"
          >
            <div className="space-y-2 border-b bg-card p-3">
              <div className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-1.5 font-semibold text-xs uppercase tracking-wider text-muted-foreground">
                  <Layers className="size-4 text-primary" />
                  <span>{t("common.collections")}</span>
                </div>
                <div className="flex items-center gap-1">
                  <Button
                    variant="ghost"
                    size="sm"
                    className="size-7 p-0"
                    title={t("data.collectionsRefresh")}
                    aria-label={t("data.collectionsRefresh")}
                    onClick={() => void refetchCollections()}
                  >
                    <RefreshCw className="size-3.5" />
                  </Button>
                  <Dialog open={isAddCollectionOpen} onOpenChange={setIsAddCollectionOpen}>
                    <DialogTrigger asChild>
                      <Button
                        variant="ghost"
                        size="sm"
                        className="size-7 p-0"
                        title={t("data.addCollection")}
                        aria-label={t("data.addCollectionTrigger")}
                      >
                        <FolderPlus className="size-4" />
                      </Button>
                    </DialogTrigger>
                    <DialogContent>
                      <DialogHeader>
                        <DialogTitle>{t("data.addCollection")}</DialogTitle>
                        <DialogDescription>{t("data.addCollectionDescription")}</DialogDescription>
                      </DialogHeader>
                      <div className="space-y-4 py-2">
                        <div className="space-y-1.5">
                          <Label htmlFor="colName">{t("data.collectionName")}</Label>
                          <Input
                            id="colName"
                            placeholder={t("data.collectionNamePlaceholder")}
                            value={newCollectionName}
                            onChange={(e) => setNewCollectionName(e.target.value)}
                          />
                        </div>
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          className="h-7 w-full justify-start px-2 text-xs text-muted-foreground"
                          aria-expanded={showAdvancedFields}
                          onClick={() => setShowAdvancedFields((prev) => !prev)}
                        >
                          <ChevronDown
                            className={`size-3.5 me-1 transition-transform ${showAdvancedFields ? "rotate-180" : ""}`}
                          />
                          {t("data.advancedOptions")}
                        </Button>
                        {showAdvancedFields ? (
                          <div className="space-y-3 rounded-md border bg-muted/20 p-3">
                            <div className="space-y-1.5">
                              <Label htmlFor="newColDescription">{t("data.collectionDescription")}</Label>
                              <Input
                                id="newColDescription"
                                value={newCollectionDescription}
                                onChange={(e) => setNewCollectionDescription(e.target.value)}
                                placeholder={t("data.collectionDescriptionPlaceholder")}
                              />
                            </div>
                            <div className="space-y-1.5">
                              <Label htmlFor="newColTtl">{t("data.defaultTtl")}</Label>
                              <Input
                                id="newColTtl"
                                type="number"
                                min={0}
                                value={newCollectionTtl}
                                onChange={(e) => setNewCollectionTtl(e.target.value)}
                                placeholder={t("data.defaultTtlPlaceholder")}
                              />
                            </div>
                            <div className="space-y-1.5">
                              <Label htmlFor="newColRequired">{t("data.requiredFields")}</Label>
                              <Input
                                id="newColRequired"
                                value={newCollectionRequiredFields}
                                onChange={(e) => setNewCollectionRequiredFields(e.target.value)}
                                placeholder={t("data.requiredFieldsPlaceholder")}
                              />
                            </div>
                          </div>
                        ) : null}
                      </div>
                      <DialogFooter>
                        <Button variant="outline" onClick={() => setIsAddCollectionOpen(false)} disabled={isCreatingCollection}>{t("common.cancel")}</Button>
                        <Button onClick={() => void handleCreateCollection()} disabled={isCreatingCollection}>{isCreatingCollection ? t("common.saving") : t("data.addCollection")}</Button>
                      </DialogFooter>
                    </DialogContent>
                  </Dialog>
                </div>
              </div>
              <div className="relative">
                <Search
                  className="pointer-events-none absolute start-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground"
                  aria-hidden="true"
                />
                <Input
                  value={collectionFilter}
                  onChange={(event) => setCollectionFilter(event.target.value)}
                  placeholder={t("data.collectionsSearch")}
                  aria-label={t("data.collectionsSearch")}
                  className="h-8 ps-8 text-xs"
                />
              </div>
            </div>
            <div className="flex-1 overflow-y-auto p-2 space-y-1">
              {isCollectionsLoading ? (
                <LoadingState rows={5} columns={1} />
              ) : isCollectionsError ? (
                <ErrorState
                  title={t("common.errorTitle")}
                  message={t("data.collectionLoadFailed")}
                  onRetry={() => void refetchCollections()}
                />
              ) : null}
              {!isCollectionsLoading && !isCollectionsError && filteredCollections.map((collection) => (
                <div
                  key={collection.id || collection.name}
                  className={`group flex items-center justify-between gap-1 rounded-md px-2 py-1.5 text-xs transition-colors ${
                    selectedCollection === collection.name
                      ? "border-s-2 border-primary bg-primary/10 text-foreground font-medium"
                      : "text-muted-foreground hover:bg-muted hover:text-foreground"
                  }`}
                >
                  <button
                    type="button"
                    onClick={() => handleCollectionChange(collection.name)}
                    className="flex min-w-0 flex-1 items-center gap-2 text-start"
                  >
                    <Folder className="size-4 shrink-0" />
                    <span className="truncate font-mono">{collection.name}</span>
                  </button>
                  <div className="flex shrink-0 items-center gap-1">
                    {collection.defaultTtlSeconds !== null ? (
                      <Badge
                        variant="outline"
                        className="h-5 gap-1 px-1.5 text-[10px]"
                        title={t("data.defaultTtl")}
                      >
                        <Clock className="size-3" />
                        {collection.defaultTtlSeconds}s
                      </Badge>
                    ) : null}
                    <Badge variant="secondary" className="h-5 tabular-nums px-1.5 text-[10px]">
                      {collection.documentCount}
                    </Badge>
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button
                          variant="ghost"
                          size="icon-xs"
                          className="p-0"
                          aria-label={t("data.collectionActions", { name: collection.name })}
                        >
                          <MoreHorizontal className="size-3.5" />
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end" className="w-52">
                        <DropdownMenuItem onSelect={() => openSettings(collection)}>
                          <Settings className="size-3.5 me-2" /> {t("data.collectionSettings", { name: collection.name })}
                        </DropdownMenuItem>
                        <DropdownMenuItem onSelect={() => void handleExportCollection(collection.name)}>
                          <Download className="size-3.5 me-2" /> {t("data.exportJson")}
                        </DropdownMenuItem>
                        <DropdownMenuItem onSelect={() => openImport(collection.name)}>
                          <Upload className="size-3.5 me-2" /> {t("data.importJson")}
                        </DropdownMenuItem>
                        <DropdownMenuSeparator />
                        <DropdownMenuItem onSelect={() => setClearCollection(collection.name)}>
                          <Eraser className="size-3.5 me-2" /> {t("data.clearDocuments")}
                        </DropdownMenuItem>
                        <DropdownMenuItem
                          variant="destructive"
                          onSelect={() => setDeleteCollection(collection.name)}
                        >
                          <Trash2 className="size-3.5 me-2" /> {t("data.deleteCollection")}
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </div>
                </div>
              ))}
            </div>
          </ExplorerPane>

          <ExplorerHandle isNarrow={isNarrow} />

          {/* Pane 2: Documents (virtualized, server-paginated) */}
          <ExplorerPane
            isNarrow={isNarrow}
            visible={mobileStep === "documents"}
            defaultSize={34}
            minSize={26}
            maxSize={44}
            className="flex flex-col bg-background"
          >
            <div className="space-y-2 border-b bg-card p-3">
              <div className="flex items-center justify-between gap-2">
                <div className={`flex items-center gap-2 ${isNarrow ? "min-w-0" : ""}`}>
                  {isNarrow ? (
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-7 shrink-0 px-1.5 text-xs"
                      onClick={() => setMobileStep("collections")}
                    >
                      <ChevronLeft className="size-4 me-0.5 rtl:rotate-180" />
                      <span className="max-w-[7rem] truncate">{t("common.collections")}</span>
                    </Button>
                  ) : null}
                  <span className="font-mono text-xs text-muted-foreground">/</span>
                  <span className={`font-mono text-sm font-semibold ${isNarrow ? "min-w-0 truncate" : ""}`}>
                    {selectedCollection}
                  </span>
                  <Badge variant="outline" className="h-4 shrink-0 font-mono text-[10px]">
                    {page?.meta?.count ?? currentDocs.length}
                  </Badge>
                </div>
                <Dialog open={isAddDocOpen} onOpenChange={setIsAddDocOpen}>
                  <DialogTrigger asChild>
                    <Button
                      size="sm"
                      variant="outline"
                      className={`h-7 text-xs ${isNarrow ? "shrink-0" : ""}`}
                    >
                      <Plus className="size-3.5 me-1" /> {t("data.newDocumentShort")}
                    </Button>
                  </DialogTrigger>
                  <DialogContent>
                    <DialogHeader>
                      <DialogTitle>{t("data.newDocument")}</DialogTitle>
                      <DialogDescription>{t("data.newDocumentDescription", { collection: selectedCollection })}</DialogDescription>
                    </DialogHeader>
                    <div className="space-y-4 py-2">
                      <div className="space-y-1.5">
                        <Label htmlFor="docId">{t("data.documentIdLabel")}</Label>
                        <Input
                          id="docId"
                          placeholder="e.g. doc_usr_456"
                          value={newDocId}
                          onChange={(e) => setNewDocId(e.target.value)}
                        />
                      </div>
                    </div>
                    <DialogFooter>
                      <Button variant="outline" onClick={() => setIsAddDocOpen(false)} disabled={isCreatingDoc}>{t("common.cancel")}</Button>
                      <Button onClick={handleCreateDocument} disabled={isCreatingDoc}>{isCreatingDoc ? t("common.saving") : t("data.create")}</Button>
                    </DialogFooter>
                  </DialogContent>
                </Dialog>
              </div>
              <div className="relative">
                <Search
                  className="pointer-events-none absolute start-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground"
                  aria-hidden="true"
                />
                <Input
                  value={docFilter}
                  onChange={(event) => setDocFilter(event.target.value)}
                  placeholder={t("common.search")}
                  aria-label={t("common.search")}
                  className="h-8 ps-8 text-xs"
                />
              </div>
            </div>

            <div className="flex-1 overflow-hidden p-2 flex flex-col">
              {isLoading ? (
                <LoadingState rows={6} columns={2} />
              ) : isError ? (
                <ErrorState
                  title={t("common.errorTitle")}
                  message={error instanceof Error ? error.message : t("data.documentLoadFailed")}
                  onRetry={() => void refetch()}
                />
              ) : filteredDocs.length === 0 ? (
                <div className="h-full flex items-center justify-center p-4">
                  <EmptyState
                    icon={<FileText className="h-10 w-10 text-muted-foreground/60" />}
                    title={docFilter ? t("common.noRows") : t("data.emptyTitle")}
                    description={debouncedFilter ? t("data.noSearchMatches", { search: debouncedFilter }) : t("data.emptyDescription", { collection: selectedCollection })}
                  />
                </div>
              ) : (
                <>
                  <div className="min-h-0 flex-1">
                    <VirtualTable
                      rows={filteredDocs}
                      height={isNarrow ? 300 : 520}
                      getRowKey={(row) => row.id}
                      selectedKey={selectedDocId}
                      onRowClick={(row) => {
                        setSelectedDocId(row.id);
                        if (isNarrow) setMobileStep("editor");
                      }}
                      columns={[
                        {
                          header: t("data.tableDocumentId"),
                          render: (row) => <span className="font-mono text-xs font-semibold">{row.id}</span>,
                        },
                        {
                          header: t("data.tableVersion"),
                          className: "max-w-[60px]",
                          render: (row) => <Badge variant="outline" className="font-mono text-[10px]">v{row.version}</Badge>,
                        },
                        {
                          header: t("data.tableUpdated"),
                          render: (row) => (
                            <span className="font-mono text-[11px] tabular-nums text-muted-foreground">
                              {new Date(row.updatedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                            </span>
                          ),
                        },
                      ]}
                    />
                  </div>
                  <div className="flex items-center justify-between px-1 pt-2 text-[11px] text-muted-foreground">
                    <span>{t("data.pageInfo", { page: cursorHistory.length, rows: filteredDocs.length })}</span>
                    <div className="flex items-center gap-1">
                      <Button
                        variant="outline"
                        size="sm"
                        className="h-7 text-xs"
                        disabled={cursorHistory.length <= 1}
                        onClick={handlePrevPage}
                      >
                        <ChevronLeft className="size-3 me-0.5" /> {t("data.prev")}
                      </Button>
                      <Button
                        variant="outline"
                        size="sm"
                        className="h-7 text-xs"
                        disabled={!nextCursor}
                        onClick={handleNextPage}
                      >
                        {t("data.next")} <ChevronRight className="size-3 ms-0.5" />
                      </Button>
                    </div>
                  </div>
                </>
              )}
            </div>
          </ExplorerPane>

          <ExplorerHandle isNarrow={isNarrow} />

          {/* Pane 3: Inspector & Editor */}
          <ExplorerPane
            isNarrow={isNarrow}
            visible={mobileStep === "editor"}
            defaultSize={46}
            minSize={30}
            className="flex flex-col bg-background"
          >
            {selectedDoc ? (
              <>
                <div className={`p-3 border-b flex items-center justify-between bg-muted/10 ${isNarrow ? "flex-wrap gap-2 shrink-0" : ""}`}>
                  <div className={`flex items-center gap-2 ${isNarrow ? "min-w-0 flex-1" : ""}`}>
                    {isNarrow ? (
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-7 shrink-0 px-1.5 text-xs"
                        onClick={() => setMobileStep("documents")}
                      >
                        <ChevronLeft className="size-4 me-0.5 rtl:rotate-180" />
                        <span className="max-w-[6.5rem] truncate">{t("common.documents")}</span>
                      </Button>
                    ) : null}
                    <FileText className="h-4 w-4 shrink-0 text-primary" />
                    <span className={`font-mono text-xs text-muted-foreground ${isNarrow ? "hidden sm:inline" : ""}`}>
                      /{selectedCollection}/
                    </span>
                    <span className={`font-mono text-sm font-semibold ${isNarrow ? "min-w-0 truncate" : ""}`}>
                      {selectedDoc.id}
                    </span>
                    <Badge variant="secondary" className={`font-mono text-xs ${isNarrow ? "shrink-0" : ""}`}>
                      v{selectedDoc.version}
                    </Badge>
                  </div>
                  <div className="flex shrink-0 items-center gap-2">
                    <AlertDialog>
                      <AlertDialogTrigger asChild>
                        <Button variant="ghost" size="sm" className="h-7 text-xs text-red-700 hover:text-red-700 dark:text-destructive dark:hover:text-destructive">
                          <Trash2 className="size-3.5 me-1" /> {t("common.delete")}
                        </Button>
                      </AlertDialogTrigger>
                      <AlertDialogContent>
                        <AlertDialogHeader>
                          <AlertDialogTitle>{t("data.deleteDocument")}</AlertDialogTitle>
                          <AlertDialogDescription>
                            {t("data.deleteDocumentDescription", { collection: selectedCollection, id: selectedDoc.id })}
                          </AlertDialogDescription>
                        </AlertDialogHeader>
                        <AlertDialogFooter>
                          <AlertDialogCancel>{t("common.cancel")}</AlertDialogCancel>
                          <AlertDialogAction
                            className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                            onClick={handleDeleteDocument}
                            disabled={isDeletingDoc}
                          >
                            {isDeletingDoc ? t("common.saving") : t("common.delete")}
                          </AlertDialogAction>
                        </AlertDialogFooter>
                      </AlertDialogContent>
                    </AlertDialog>
                    <Button size="sm" onClick={handleSaveDocument} className="h-7 text-xs" disabled={isSavingDoc || isDeletingDoc}>
                      <Save className="size-3.5 me-1" /> {isSavingDoc ? t("common.saving") : t("common.save")}
                    </Button>
                  </div>
                </div>

                <Tabs
                  value={inspectorTab}
                  onValueChange={(v) => setInspectorTab(v as "editor" | "fields" | "meta")}
                  className={`flex-1 flex flex-col overflow-hidden ${isNarrow ? "min-w-0" : ""}`}
                >
                  <div className={`border-b px-3 py-1.5 bg-muted/5 flex items-center justify-between ${isNarrow ? "gap-2" : ""}`}>
                    <TabsList className={`h-7 p-0.5 bg-muted/60 ${isNarrow ? "min-w-0 overflow-x-auto" : ""}`}>
                      <TabsTrigger value="editor" className="text-[11px] gap-1 px-2.5 h-6">
                        <Code2 className="h-3 w-3" /> {t("data.jsonEditor")}
                      </TabsTrigger>
                      <TabsTrigger value="fields" className="text-[11px] gap-1 px-2.5 h-6">
                        <ListTree className="h-3 w-3" /> {t("data.fieldsTab", { count: Object.keys(selectedDoc.data).length })}
                      </TabsTrigger>
                      <TabsTrigger value="meta" className="text-[11px] gap-1 px-2.5 h-6">
                        <Info className="h-3 w-3" /> {t("common.metadata")}
                      </TabsTrigger>
                    </TabsList>
                    <span className={`text-[10px] font-mono text-muted-foreground ${isNarrow ? "hidden sm:inline" : ""}`}>
                      {t("data.bytes", { size: new Blob([editorJson]).size })}
                    </span>
                  </div>

                  <TabsContent value="editor" forceMount className="flex-1 m-0 p-0 overflow-auto data-[state=inactive]:hidden">
                    <CodeEditor
                      value={editorJson}
                      onChange={(val) => { setEditorJson(val); setEditorError(null); }}
                      height="100%"
                      label={t("data.jsonEditor")}
                    />
                    {editorError && (
                      <div className="px-3 py-2 text-[11px] font-mono text-destructive bg-destructive/5 border-t">
                        {t("data.invalidJsonInline", { error: editorError })}
                      </div>
                    )}
                    <div className="border-t bg-muted/10 px-3 py-3">
                      <JsonInspector
                        value={parsedEditorValue}
                        initialText={editorJson}
                        className="[&_.text-emerald-600]:text-success-800 dark:[&_.text-emerald-600]:text-success-400"
                      />
                    </div>
                  </TabsContent>

                  <TabsContent value="fields" forceMount className="flex-1 m-0 p-4 overflow-auto space-y-3 data-[state=inactive]:hidden">
                    <div className="text-xs text-muted-foreground">{t("data.structuredView")}</div>
                    <div className="space-y-1.5">
                      {Object.entries(selectedDoc.data).map(([key, val]) => (
                        <div key={key} className={`flex items-center justify-between p-2.5 rounded-md border bg-card/60 text-xs ${isNarrow ? "gap-2" : ""}`}>
                          <div className={`flex items-center gap-2 font-mono ${isNarrow ? "min-w-0 flex-1" : ""}`}>
                            <span className="font-semibold text-foreground">{key}</span>
                            <span className="text-muted-foreground">:</span>
                            <span className="text-muted-foreground truncate max-w-xs">
                              {typeof val === "object" ? JSON.stringify(val) : String(val)}
                            </span>
                          </div>
                          <FieldTypeBadge type={inferWireType(val)} />
                        </div>
                      ))}
                    </div>
                  </TabsContent>

                  <TabsContent value="meta" forceMount className="flex-1 m-0 p-4 overflow-auto space-y-3 data-[state=inactive]:hidden">
                    <div className="rounded-lg border bg-card/60 p-3 space-y-2">
                      <ConsoleCopyableField
                        label={t("data.fullPath")}
                        value={`projects/${projectId}/documents/${selectedCollection}/${selectedDoc.id}`}
                      />
                      <KeyValueRow label={t("data.occVersion")} value={<Badge variant="outline" className="font-mono text-xs">v{selectedDoc.version}</Badge>} />
                      <KeyValueRow label={t("data.createdAt")} value={<span className="font-mono text-xs text-muted-foreground">{selectedDoc.createdAt}</span>} />
                      <KeyValueRow label={t("data.lastUpdatedAt")} value={<span className="font-mono text-xs text-muted-foreground">{selectedDoc.updatedAt}</span>} />
                      <KeyValueRow label={t("data.tenantContext")} value={<span className="font-mono text-xs text-muted-foreground">org={orgId}, project={projectId}</span>} />
                    </div>
                  </TabsContent>
                </Tabs>
              </>
            ) : (
              <div className={`h-full flex items-center justify-center p-6 ${isNarrow ? "flex-col gap-3" : ""}`}>
                {isNarrow ? (
                  <Button variant="outline" size="sm" onClick={() => setMobileStep("documents")}>
                    <ChevronLeft className="size-4 me-1 rtl:rotate-180" />
                    {t("common.documents")}
                  </Button>
                ) : null}
                <EmptyState
                  icon={<FileText className="h-10 w-10 text-muted-foreground/60" />}
                  title={t("data.noDocumentSelected")}
                  description={t("data.noDocumentSelectedDescription")}
                />
              </div>
            )}
          </ExplorerPane>
        </ExplorerGroup>
      </Card>

      {/* Collection settings */}
      <DetailSheet
        open={isSettingsOpen}
        onOpenChange={setIsSettingsOpen}
        title={t("data.collectionSettings", { name: settingsCollection ?? "" })}
        description={t("data.collectionSettingsDescription", { name: settingsCollection ?? "" })}
        footer={
          <>
            <Button variant="outline" onClick={() => setIsSettingsOpen(false)}>{t("common.cancel")}</Button>
            <Button onClick={() => void handleSaveSettings()}>{t("common.save")}</Button>
          </>
        }
      >
        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="settingsDescription">{t("data.collectionDescription")}</Label>
            <Input
              id="settingsDescription"
              value={settingsDescription}
              onChange={(event) => setSettingsDescription(event.target.value)}
              placeholder={t("data.collectionDescriptionPlaceholder")}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="settingsTtl">{t("data.defaultTtl")}</Label>
            <Input
              id="settingsTtl"
              type="number"
              min={0}
              value={settingsTtl}
              onChange={(event) => setSettingsTtl(event.target.value)}
              placeholder={t("data.defaultTtlPlaceholder")}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="settingsRequired">{t("data.requiredFields")}</Label>
            <Input
              id="settingsRequired"
              value={settingsRequiredFields}
              onChange={(event) => setSettingsRequiredFields(event.target.value)}
              placeholder={t("data.requiredFieldsPlaceholder")}
            />
          </div>
        </div>
      </DetailSheet>

      {/* Import JSON */}
      <Dialog
        open={isImportOpen}
        onOpenChange={(open) => {
          setIsImportOpen(open);
          if (!open) setImportResult(null);
        }}
      >
        <DialogContent className="sm:max-w-lg max-h-[calc(100dvh-2rem)] flex flex-col overflow-hidden">
          <DialogHeader>
            <DialogTitle>{t("data.importJsonTitle", { name: importCollection ?? "" })}</DialogTitle>
            <DialogDescription>{t("data.importJsonHint")}</DialogDescription>
          </DialogHeader>
          <div className="space-y-3 py-2 min-h-0 overflow-y-auto">
            <Textarea
              value={importText}
              dir="ltr"
              onChange={(event) => setImportText(event.target.value)}
              placeholder={t("data.importJsonPlaceholder")}
              aria-label={t("data.importJson")}
              className="h-40 min-h-20 max-h-[35dvh] resize-none overflow-y-auto font-mono text-xs"
            />
            <div className="space-y-1.5">
              <Label htmlFor="importFile">{t("data.importJsonFile")}</Label>
              <Input
                id="importFile"
                type="file"
                accept="application/json,.json"
                onChange={(event) => void handleImportFile(event)}
                className="h-8 text-xs"
              />
            </div>
            {importResult ? (
              <div className="space-y-1 rounded-md border bg-muted/30 p-2 text-xs">
                <p>{t("data.importImported", { count: importResult.importedCount })}</p>
                <p>{t("data.importSkipped", { count: importResult.skippedCount })}</p>
                {importResult.errors.length > 0 ? (
                  <pre className="max-h-32 overflow-auto font-mono text-[10px] text-destructive">
                    {JSON.stringify(importResult.errors, null, 2)}
                  </pre>
                ) : null}
              </div>
            ) : null}
          </div>
          <DialogFooter>
            <Button variant="outline" disabled={isImporting} onClick={() => setIsImportOpen(false)}>{t("common.cancel")}</Button>
            <Button disabled={isImporting} onClick={() => void handleImportCollection()}>{t("data.import")}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Clear all documents */}
      <ConfirmDangerDialog
        open={clearCollection !== null}
        onOpenChange={(open) => {
          if (!open) setClearCollection(null);
        }}
        title={t("data.clearDocuments")}
        description={t("data.clearDocumentsDescription", { name: clearCollection ?? "" })}
        confirmLabel={t("data.clearDocuments")}
        onConfirm={handleClearCollection}
      />

      {/* Delete collection */}
      <ConfirmDangerDialog
        open={deleteCollection !== null}
        onOpenChange={(open) => {
          if (!open) setDeleteCollection(null);
        }}
        title={t("data.deleteCollection")}
        description={t("data.deleteCollectionDescription", { name: deleteCollection ?? "" })}
        confirmLabel={t("data.deleteCollection")}
        {...(deleteCollection !== null
          ? { requireTypeToConfirm: deleteCollection }
          : {})}
        onConfirm={handleDeleteCollection}
      />
    </PageContent>
  );
}
