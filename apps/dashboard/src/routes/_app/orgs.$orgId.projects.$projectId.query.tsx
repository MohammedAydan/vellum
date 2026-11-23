import * as React from "react";
import { createRoute, useNavigate, useParams } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { Route as projectRoute } from "./orgs.$orgId.projects.$projectId.js";
import {
  consoleFetch,
  consoleProjectsBase,
  type ConsoleQueryResponse,
} from "../../lib/api.js";
import { KeyValueRow } from "@vellum/ui";
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
  CodeEditor,
  Tabs,
  TabsList,
  TabsTrigger,
  TabsContent,
  Alert,
  AlertTitle,
  AlertDescription,
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectGroup,
  SelectLabel,
  SelectItem,
  useI18n,
} from "@vellum/ui";
import { toast } from "sonner";
import {
  Play,
  Plus,
  Trash2,
  Clock,
  AlertCircle,
  ArrowRight,
  Code,
  Sliders,
  CheckCircle2,
} from "lucide-react";

export const Route = createRoute({
  getParentRoute: () => projectRoute,
  path: "query",
  component: QueryPlaygroundPage,
});

interface WhereClause {
  id: string;
  field: string;
  op: "==" | "!=" | "<" | "<=" | ">" | ">=" | "in" | "array-contains";
  value: string;
}

interface OrderClause {
  id: string;
  field: string;
  direction: "asc" | "desc";
}

interface QueryResultDoc {
  id: string;
  data: Record<string, unknown>;
  createdAt: string;
}

function QueryPlaygroundPage() {
  const { orgId, projectId } = useParams({ from: Route.id });
  const navigate = useNavigate();
  const { t } = useI18n();

  const [mode, setMode] = React.useState<"visual" | "raw">("visual");
  const [collection, setCollection] = React.useState<string>("users");
  const [wheres, setWheres] = React.useState<WhereClause[]>([
    { id: "1", field: "role", op: "==", value: "admin" },
  ]);
  const [orders, setOrders] = React.useState<OrderClause[]>([
    { id: "1", field: "createdAt", direction: "desc" },
  ]);
  const [limit, setLimit] = React.useState<number>(50);
  const [includePaths, setIncludePaths] = React.useState<string>("");
  const [selectFields, setSelectFields] = React.useState<string>("");

  const [rawJson, setRawJson] = React.useState<string>(
    JSON.stringify(
      {
        collection: "users",
        where: [{ field: "role", op: "==", value: "admin" }],
        orderBy: [{ field: "createdAt", direction: "desc" }],
        include: [],
        select: [],
        limit: 50,
      },
      null,
      2
    )
  );

  const [isRunning, setIsRunning] = React.useState<boolean>(false);
  const [executionTimeMs, setExecutionTimeMs] = React.useState<number | null>(null);
  const [results, setResults] = React.useState<QueryResultDoc[] | null>(null);
  const [missingIndexError, setMissingIndexError] = React.useState<{
    collection: string;
    fields: string;
  } | null>(null);
  const [queryMeta, setQueryMeta] = React.useState<{
    indexUsed: string;
    executionTimeMs: number;
    compiledSql: string;
  } | null>(null);
  const [queryError, setQueryError] = React.useState<string | null>(null);
  const base = consoleProjectsBase(projectId);

  // Real persisted collections (same cache key as the Data Explorer). This is
  // an additional quick-pick only — the free-text #colSelect input remains the
  // source of truth and still accepts custom collection paths.
  const { data: collectionsResponse } = useQuery({
    queryKey: ["collections", projectId],
    queryFn: () =>
      consoleFetch<{ collections: Array<{ name: string; documentCount: number }> }>(
        `${consoleProjectsBase(projectId)}/collections?limit=500`
      ),
  });
  const collections = collectionsResponse?.collections ?? [];

  const switchMode = (next: string) => {
    if (next === mode) return;
    try {
      if (next === "raw") {
        setRawJson(JSON.stringify({ collection, where: wheres.filter((w) => w.field && w.value !== "").map((w) => ({
          field: w.field, op: w.op, value: w.value.trim() !== "" && Number.isFinite(Number(w.value)) ? Number(w.value) : w.value,
        })), orderBy: orders.map(({ field, direction }) => ({ field, direction })),
          limit, include: includePaths.split(",").map((s) => s.trim()).filter(Boolean),
          select: selectFields.split(",").map((s) => s.trim()).filter(Boolean) }, null, 2));
      } else {
        const parsed = JSON.parse(rawJson);
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)
          || Object.keys(parsed).some((key) => !["collection", "where", "orderBy", "limit", "include", "select"].includes(key))
          || typeof parsed.collection !== "string"
          || (parsed.where !== undefined && (!Array.isArray(parsed.where) || parsed.where.some((w: WhereClause) =>
            !w || typeof w.field !== "string" || typeof w.op !== "string" || !["string", "number"].includes(typeof w.value)
            || !["==", "!=", "<", "<=", ">", ">=", "in", "array-contains"].includes(w.op)
            || (typeof w.value === "string" && w.value.trim() !== "" && Number.isFinite(Number(w.value))))))
          || (parsed.orderBy !== undefined && (!Array.isArray(parsed.orderBy) || parsed.orderBy.some((o: OrderClause) =>
            !o || typeof o.field !== "string" || !["asc", "desc"].includes(o.direction))))
          || (parsed.limit !== undefined && (!Number.isInteger(parsed.limit) || parsed.limit < 1))
          || [parsed.include, parsed.select].some((fields) => fields !== undefined && (!Array.isArray(fields) || fields.some((f: unknown) => typeof f !== "string")))) {
          throw new Error(t("query.invalidRawJson"));
        }
        setCollection(parsed.collection);
        setWheres((parsed.where ?? []).map((w: WhereClause, i: number) => ({ ...w, id: String(i), value: String(w.value) })));
        setOrders((parsed.orderBy ?? []).map((o: OrderClause, i: number) => ({ ...o, id: String(i) })));
        setLimit(parsed.limit ?? 50);
        setIncludePaths((parsed.include ?? []).join(","));
        setSelectFields((parsed.select ?? []).join(","));
      }
      setResults(null); setQueryMeta(null); setQueryError(null); setExecutionTimeMs(null); setMissingIndexError(null);
      setMode(next as "visual" | "raw");
    } catch { toast.error(t("query.invalidRawJson")); }
  };

  // Results describe a query snapshot, never the edited query.
  React.useEffect(() => {
    setResults(null); setQueryMeta(null); setExecutionTimeMs(null); setMissingIndexError(null); setQueryError(null);
  }, [collection, wheres, orders, limit, includePaths, selectFields, rawJson, mode]);

  const applyQuickCollection = (name: string): void => {
    setCollection(name);
    if (mode !== "raw") return;
    // Raw mode reads rawJson, so keep its `collection` field in sync without
    // clobbering a payload the user is still editing.
    try {
      const parsed: unknown = JSON.parse(rawJson);
      if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
        setRawJson(
          JSON.stringify({ ...(parsed as Record<string, unknown>), collection: name }, null, 2)
        );
      }
    } catch {
      toast.error(t("query.invalidRawJson"));
    }
  };

  const handleAddWhere = () => {
    if (wheres.length >= 10) {
      toast.error(t("query.maxWhere"));
      return;
    }
    setWheres((prev) => [
      ...prev,
      { id: Math.random().toString(), field: "age", op: "==", value: "" },
    ]);
  };

  const handleRemoveWhere = (id: string) => {
    setWheres((prev) => prev.filter((w) => w.id !== id));
  };

  const handleUpdateWhere = (
    id: string,
    key: "field" | "op" | "value",
    val: string
  ) => {
    setWheres((prev) =>
      prev.map((w) =>
        w.id === id
          ? {
              ...w,
              [key]: val,
            }
          : w
      )
    );
  };

  const handleAddOrder = () => {
    if (orders.length >= 3) {
      toast.error(t("query.maxOrderBy"));
      return;
    }
    setOrders((prev) => [
      ...prev,
      { id: Math.random().toString(), field: "score", direction: "asc" },
    ]);
  };

  const handleRemoveOrder = (id: string) => {
    setOrders((prev) => prev.filter((o) => o.id !== id));
  };

  const handleRunQuery = async () => {
    setIsRunning(true);
    setMissingIndexError(null);
    setQueryError(null);
    setExecutionTimeMs(null);
    const start = performance.now();

    try {
      let targetCollection = collection;
      let targetWheres = wheres;
      let targetOrders = orders;
      let targetLimit = limit;
      let targetInclude = includePaths;
      let targetSelect = selectFields;

      if (mode === "raw") {
        const parsed = JSON.parse(rawJson) as {
          collection?: string;
          where?: WhereClause[];
          orderBy?: OrderClause[];
          include?: string[] | string;
          select?: string[] | string;
          limit?: number;
        };
        targetCollection = parsed.collection ?? "users";
        targetWheres = parsed.where ?? [];
        targetOrders = parsed.orderBy ?? [];
        targetLimit = parsed.limit ?? limit;
        targetInclude = Array.isArray(parsed.include) ? parsed.include.join(",") : (parsed.include ?? "");
        targetSelect = Array.isArray(parsed.select) ? parsed.select.join(",") : (parsed.select ?? "");
      }

      const toFieldList = (raw: string): string[] =>
        raw
          .split(",")
          .map((field) => field.trim())
          .filter((field) => field.length > 0);

      const queryPayload: Record<string, unknown> = {
        collectionPath: targetCollection,
        limit: targetLimit,
      };
      const includeList = toFieldList(targetInclude);
      const selectList = toFieldList(targetSelect);
      if (includeList.length > 0) queryPayload["include"] = includeList;
      if (selectList.length > 0) queryPayload["select"] = selectList;
      if (targetWheres.length > 0) {
        queryPayload["where"] = targetWheres
          .filter((w) => w.field && w.value !== "")
          .map((w) => ({
            field: w.field,
            op: w.op,
            value: typeof w.value === "string" && w.value.trim() !== "" && Number.isFinite(Number(w.value)) ? Number(w.value) : w.value,
          }));
      }
      if (targetOrders.length > 0) {
        queryPayload["orderBy"] = targetOrders
          .filter((o) => o.field)
          .map((o) => ({
            field: o.field,
            dir: o.direction,
          }));
      }

      try {
        const queryRes = await consoleFetch<ConsoleQueryResponse<Record<string, unknown> & {
          id?: string;
          documentId?: string;
          createdAt?: string;
        }>>(`${base}/query`, {
          method: "POST",
          body: JSON.stringify(queryPayload),
        });

        const docs = queryRes.documents ?? [];
        const mapped: QueryResultDoc[] = docs.map((d) => ({
          id: String(d.id ?? d.documentId ?? ""),
          createdAt: d.createdAt ?? new Date().toISOString(),
          data: d as Record<string, unknown>,
        }));
        setResults(mapped);
        setQueryMeta(queryRes.meta ?? null);
        // Prefer the engine-measured duration; fall back to client RTT.
        setExecutionTimeMs(queryRes.meta?.executionTimeMs ?? Math.round((performance.now() - start) * 10) / 10);
        toast.success(t("query.returned", { count: mapped.length, index: queryRes.meta?.indexUsed ?? "primary_btree" }));
      } catch (apiErr: unknown) {
        const errMsg = apiErr instanceof Error ? apiErr.message : String(apiErr);
        setQueryMeta(null);
        setQueryError(errMsg);
        if (errMsg.toLowerCase().includes("index") || errMsg.toLowerCase().includes("composite")) {
          setMissingIndexError({
            collection: targetCollection,
            fields: `${targetWheres[0]?.field || "field"} ASC, ${targetOrders[0]?.field || "created"} ASC`,
          });
          setResults(null);
          toast.error(t("query.indexRequired"));
        } else {
          setResults([]);
          toast.error(errMsg);
        }
      }
    } catch {
      toast.error(t("query.invalidRawJson"));
    } finally {
      setExecutionTimeMs((prev) => prev ?? Math.round((performance.now() - start) * 10) / 10);
      setIsRunning(false);
    }
  };

  const columns: DataTableColumn<QueryResultDoc>[] = [
    {
      id: "id",
      header: t("data.tableDocumentId"),
      accessor: (row) => <span className="font-mono text-xs font-semibold">{row.id}</span>,
      mono: true,
    },
    {
      id: "data",
      header: t("query.payloadColumn"),
      accessor: (row) => (
        <span className="block max-w-md truncate font-mono text-xs text-muted-foreground">
          {JSON.stringify(row.data)}
        </span>
      ),
      mono: true,
    },
    {
      id: "createdAt",
      header: t("query.indexedAt"),
      accessor: (row) => (
        <span className="font-mono text-[11px] text-muted-foreground">
          {new Date(row.createdAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
        </span>
      ),
    },
  ];

  return (
    <PageContent>
      <ConfigurablePageHeader
        title={t("query.title")}
        description={t("query.description")}
        actions={
          <div className="flex items-center space-x-3">
            <Tabs value={mode} onValueChange={switchMode}>
              <TabsList>
                <TabsTrigger value="visual" className="text-xs">
                  <Sliders className="size-3.5 me-1" />
                  {t("query.visualBuilder")}
                </TabsTrigger>
                <TabsTrigger value="raw" className="text-xs">
                  <Code className="size-3.5 me-1" />
                  {t("query.rawJson")}
                </TabsTrigger>
              </TabsList>
              <TabsContent value="visual" forceMount className="hidden" />
              <TabsContent value="raw" forceMount className="hidden" />
            </Tabs>

            <Button onClick={handleRunQuery} disabled={isRunning} className="gap-1.5">
              <Play className="h-4 w-4 fill-current" />
              {isRunning ? t("query.running") : t("query.run")}
            </Button>
          </div>
        }
      />

      {/* Query Editor Box */}
      <Card>
        <CardHeader className="pb-3 border-b bg-card">
          <div className="flex items-center justify-between">
            <CardTitle className="text-base font-semibold">{t("query.params")}</CardTitle>
            <div className="flex items-center gap-2">
              <Badge variant="outline" className="font-mono text-[10px]">
                {mode === "visual" ? t("query.visualAst") : t("query.jsonWire")}
              </Badge>
              <Badge variant="secondary" className="font-mono text-[10px]">
                {t("query.deterministicSort")}
              </Badge>
            </div>
          </div>
          <CardDescription className="text-xs">
            {t("query.paramsDescription")}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4 pt-4">
          <div className="flex flex-wrap items-center gap-2 border-b pb-3">
            <Label htmlFor="queryQuickCollections" className="text-[11px] text-muted-foreground">
              {t("query.quickCollections")}
            </Label>
            <Select value="" onValueChange={applyQuickCollection}>
              <SelectTrigger id="queryQuickCollections" className="h-8 w-56 max-w-full text-xs">
                <SelectValue placeholder={t("query.collectionPlaceholder")} />
              </SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  <SelectLabel>{t("query.quickCollections")}</SelectLabel>
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

          {mode === "visual" ? (
            <div className="space-y-4">
              <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
                <div className="space-y-1.5 md:col-span-3">
                  <Label htmlFor="colSelect" className="text-xs">{t("common.collection")}</Label>
                  <Input
                    id="colSelect"
                    value={collection}
                    onChange={(e) => setCollection(e.target.value)}
                    placeholder={t("query.collectionPlaceholder")}
                    className="font-mono text-xs h-9"
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="queryLimit" className="text-xs">{t("query.limit")}</Label>
                  <Input
                    id="queryLimit"
                    type="number"
                    value={limit}
                    onChange={(e) => setLimit(Number(e.target.value))}
                    className="font-mono text-xs h-9"
                    min={1}
                    max={500}
                  />
                </div>
              </div>

              {/* Include / Select projection controls */}
              <div className="grid grid-cols-1 gap-4 border-t pt-3 md:grid-cols-2">
                <div className="space-y-1.5">
                  <Label htmlFor="queryInclude" className="text-xs">{t("query.includeLabel")}</Label>
                  <Input
                    id="queryInclude"
                    value={includePaths}
                    onChange={(e) => setIncludePaths(e.target.value)}
                    placeholder={t("query.fieldPlaceholder")}
                    className="h-9 font-mono text-xs"
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="querySelect" className="text-xs">{t("query.selectLabel")}</Label>
                  <Input
                    id="querySelect"
                    value={selectFields}
                    onChange={(e) => setSelectFields(e.target.value)}
                    placeholder={t("query.fieldPlaceholder")}
                    className="h-9 font-mono text-xs"
                  />
                </div>
              </div>

              {/* Where Filters */}
              <div className="space-y-2 border-t pt-3">
                <div className="flex items-center justify-between">
                  <Label className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">
                    {t("query.whereLabel", { count: wheres.length })}
                  </Label>
                  <Button
                    variant="outline"
                    size="sm"
                    className="h-7 text-xs"
                    onClick={handleAddWhere}
                    disabled={wheres.length >= 10}
                  >
                    <Plus className="size-3 me-1" />
                    {t("query.addFilter")}
                  </Button>
                </div>

                <div className="space-y-2">
                  {wheres.map((clause) => (
                    <div key={clause.id} className="flex items-center space-x-2">
                      <Input
                        placeholder={t("query.fieldPlaceholder")}
                        value={clause.field}
                        onChange={(e) => handleUpdateWhere(clause.id, "field", e.target.value)}
                        className="h-9 font-mono text-xs w-48"
                      />
                      <div className="w-36">
                        <Select
                          value={clause.op}
                          onValueChange={(val) =>
                            handleUpdateWhere(clause.id, "op", val as WhereClause["op"])
                          }
                        >
                          <SelectTrigger className="h-9 font-mono text-xs">
                            <SelectValue placeholder={t("common.operator")} />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="==" className="font-mono text-xs">==</SelectItem>
                            <SelectItem value="!=" className="font-mono text-xs">!=</SelectItem>
                            <SelectItem value="<" className="font-mono text-xs">&lt;</SelectItem>
                            <SelectItem value="<=" className="font-mono text-xs">&lt;=</SelectItem>
                            <SelectItem value=">" className="font-mono text-xs">&gt;</SelectItem>
                            <SelectItem value=">=" className="font-mono text-xs">&gt;=</SelectItem>
                            <SelectItem value="in" className="font-mono text-xs">in</SelectItem>
                            <SelectItem value="array-contains" className="font-mono text-xs">array-contains</SelectItem>
                          </SelectContent>
                        </Select>
                      </div>
                      <Input
                        placeholder={t("query.valuePlaceholder")}
                        value={clause.value}
                        onChange={(e) => handleUpdateWhere(clause.id, "value", e.target.value)}
                        className="h-9 font-mono text-xs flex-1"
                      />
                      <Button
                        variant="ghost"
                        size="sm"
                        aria-label={t("common.delete")}
                        className="h-9 w-9 p-0 text-muted-foreground hover:text-destructive"
                        onClick={() => handleRemoveWhere(clause.id)}
                      >
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    </div>
                  ))}
                </div>
              </div>

              {/* Order By */}
              <div className="space-y-2 border-t pt-3">
                <div className="flex items-center justify-between">
                  <Label className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">
                    {t("query.sortLabel", { count: orders.length })}
                  </Label>
                  <Button
                    variant="outline"
                    size="sm"
                    className="h-7 text-xs"
                    onClick={handleAddOrder}
                    disabled={orders.length >= 3}
                  >
                    <Plus className="size-3 me-1" />
                    {t("query.addOrderBy")}
                  </Button>
                </div>

                <div className="space-y-2">
                  {orders.map((clause) => (
                    <div key={clause.id} className="flex items-center space-x-2">
                      <Input
                        placeholder={t("query.fieldPlaceholder")}
                        value={clause.field}
                        onChange={(e) =>
                          setOrders((prev) =>
                            prev.map((o) => (o.id === clause.id ? { ...o, field: e.target.value } : o))
                          )
                        }
                        className="h-9 font-mono text-xs w-48"
                      />
                      <div className="w-32">
                        <Select
                          value={clause.direction}
                          onValueChange={(val) =>
                            setOrders((prev) =>
                              prev.map((o) =>
                                o.id === clause.id ? { ...o, direction: val as "asc" | "desc" } : o
                              )
                            )
                          }
                        >
                          <SelectTrigger className="h-9 font-mono text-xs">
                            <SelectValue placeholder={t("common.direction")} />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="asc" className="font-mono text-xs">ASC</SelectItem>
                            <SelectItem value="desc" className="font-mono text-xs">DESC</SelectItem>
                          </SelectContent>
                        </Select>
                      </div>
                      <Button
                        variant="ghost"
                        size="sm"
                        aria-label={t("common.delete")}
                        className="h-9 w-9 p-0 text-muted-foreground hover:text-destructive"
                        onClick={() => handleRemoveOrder(clause.id)}
                      >
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          ) : (
            <div className="space-y-2">
              <CodeEditor
                value={rawJson}
                onChange={(v) => setRawJson(v)}
                className="h-[220px]"
              />
            </div>
          )}
        </CardContent>
      </Card>

      {/* Missing Composite Index Warning Callout */}
      {missingIndexError && (
        <Alert variant="destructive" className="border-warning/40 bg-warning/10 text-warning-900 dark:text-warning-200">
          <AlertCircle className="h-4 w-4 text-warning" />
          <AlertTitle className="text-sm font-semibold flex items-center justify-between">
            <span>{t("query.missingIndexTitle")}</span>
          </AlertTitle>
          <AlertDescription className="mt-2 space-y-2 text-xs">
            <p>
              {t("query.missingIndexIntro")}{" "}
              <code className="font-mono bg-background/50 px-1 py-0.5 rounded">
                /{missingIndexError.collection}
              </code>{" "}
              {t("query.missingIndexMatching")}{" "}
              <code className="font-mono bg-background/50 px-1 py-0.5 rounded">
                {missingIndexError.fields}
              </code>
            </p>
            <div className="pt-2">
              <Button
                variant="outline"
                size="sm"
                className="text-xs bg-background"
                onClick={() =>
                  void navigate({
                    to: "/app/orgs/$orgId/projects/$projectId/indexes",
                    params: { orgId, projectId },
                    search: {
                      fromError: "missing_index",
                      collection: missingIndexError.collection,
                      fields: missingIndexError.fields,
                    },
                  })
                }
              >
                <span>{t("query.createIndexInManager")}</span>
                <ArrowRight className="size-3 ms-1" />
              </Button>
            </div>
          </AlertDescription>
        </Alert>
      )}

      {/* Query Results */}
      {results && (
        <Card>
          <CardHeader className="flex flex-row items-center justify-between pb-3 border-b bg-card">
            <div>
              <CardTitle className="text-base font-semibold">{t("query.results")}</CardTitle>
              <CardDescription className="text-xs">
                {t("query.resultsDescription")}
              </CardDescription>
            </div>
            {executionTimeMs !== null && (
              <div className="flex items-center gap-2">
                <Badge variant="secondary" className="gap-1 font-mono text-xs">
                  <CheckCircle2 className="h-3 w-3 text-success" />
                  <span>{t("query.matched", { count: results.length })}</span>
                </Badge>
                <div className="flex items-center text-xs font-mono text-muted-foreground bg-muted/60 px-2.5 py-1 rounded-md border border-border/60">
                  <Clock className="size-3.5 me-1 text-primary" />
                  <span>{executionTimeMs} ms</span>
                </div>
              </div>
            )}
          </CardHeader>
          <CardContent className="p-4">
            <DataTable
              columns={columns}
              rows={results}
              getRowId={(row) => row.id}
            />
          </CardContent>
        </Card>
      )}

      {/* Real engine execution metadata */}
      {queryMeta && (
        <Card>
          <CardHeader className="pb-3 border-b bg-card">
            <div className="flex items-center justify-between">
              <CardTitle className="text-base font-semibold">{t("query.executionPlan")}</CardTitle>
              <Badge variant="outline" className="font-mono text-[10px]">{t("query.engineReported")}</Badge>
            </div>
            <CardDescription className="text-xs">
              {t("query.executionDescription")}
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3 pt-4">
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
              <KeyValueRow
                label={t("query.indexUsed")}
                value={<span className="font-mono text-xs text-success-600 dark:text-success-400">{queryMeta.indexUsed}</span>}
              />
              <KeyValueRow
                label={t("query.executionTime")}
                value={<span className="font-mono text-xs">{queryMeta.executionTimeMs} ms</span>}
              />
              <KeyValueRow
                label={t("query.matchedRows")}
                value={<span className="font-mono text-xs">{results?.length ?? 0}</span>}
              />
            </div>
            <div className="space-y-1.5">
              <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">{t("query.compiledSql")}</span>
              <pre className="overflow-x-auto rounded-md border bg-muted/30 p-3 font-mono text-[11px] leading-relaxed whitespace-pre-wrap">
                {queryMeta.compiledSql}
              </pre>
            </div>
          </CardContent>
        </Card>
      )}

      {queryError && !missingIndexError && (
        <Alert variant="destructive">
          <AlertCircle className="h-4 w-4" />
          <AlertTitle>{t("query.queryFailed")}</AlertTitle>
          <AlertDescription className="font-mono text-xs">{queryError}</AlertDescription>
        </Alert>
      )}
    </PageContent>
  );
}
