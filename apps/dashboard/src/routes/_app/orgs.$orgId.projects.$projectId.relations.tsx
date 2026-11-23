import * as React from "react";
import { createRoute, useParams } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Route as projectRoute } from "./orgs.$orgId.projects.$projectId.js";
import {
  fetchRelationRules,
  replaceRelationRules,
  type ConsoleRelationRule,
  type RelationRuleOnDelete,
} from "../../lib/api.js";
import {
  Alert,
  AlertDescription,
  AlertTitle,
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  ConfigurablePageHeader,
  EmptyState,
  ErrorState,
  Input,
  Label,
  LoadingState,
  PageContent,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  useI18n,
} from "@vellum/ui";
import { toast } from "sonner";
import { AlertTriangle, GitBranch, Info, Plus, RefreshCw, Trash2 } from "lucide-react";

export const Route = createRoute({
  getParentRoute: () => projectRoute,
  path: "relations",
  component: RelationsManagerPage,
});

/** Mirrors the engine + control-plane cap (G4). */
export const MAX_RELATION_RULES_PER_PROJECT = 50;

export const ON_DELETE_ACTIONS: readonly RelationRuleOnDelete[] = [
  "cascade",
  "set_null",
  "restrict",
] as const;

export interface RelationRuleDraft {
  collection: string;
  field: string;
  targetCollection: string;
  onDelete: RelationRuleOnDelete;
}

export function toDraft(rule: ConsoleRelationRule): RelationRuleDraft {
  return {
    collection: rule.collection,
    field: rule.field,
    targetCollection: rule.targetCollection ?? "",
    onDelete: rule.onDelete,
  };
}

export function draftsToPayload(rules: RelationRuleDraft[]) {
  return rules.map((rule) => ({
    collection: rule.collection.trim(),
    field: rule.field.trim(),
    ...(rule.targetCollection.trim()
      ? { targetCollection: rule.targetCollection.trim() }
      : {}),
    onDelete: rule.onDelete,
  }));
}

/**
 * Client-side validation mirroring the server validator. Returns i18n keys;
 * an empty list means the draft set is saveable.
 */
export function validateRelationRuleDrafts(rules: RelationRuleDraft[]): string[] {
  const errors: string[] = [];
  if (rules.length > MAX_RELATION_RULES_PER_PROJECT) {
    errors.push("relations.errors.tooMany");
  }
  const seen = new Set<string>();
  rules.forEach((rule) => {
    if (!rule.collection.trim() || !rule.field.trim()) {
      errors.push("relations.errors.missingFields");
      return;
    }
    const key = JSON.stringify([rule.collection.trim(), rule.field.trim()]);
    if (seen.has(key)) {
      errors.push("relations.errors.duplicate");
    }
    seen.add(key);
  });
  return [...new Set(errors)];
}

/**
 * Self-referential rules (categories.parentId -> categories): legal, informational.
 * A rule without a target fires on every delete, so it is not a self-tree;
 * only an explicit target matching the rule's own collection counts.
 */
export function findSelfReferentialRules(rules: RelationRuleDraft[]): RelationRuleDraft[] {
  return rules.filter(
    (rule) =>
      rule.collection.trim() &&
      rule.targetCollection.trim() !== "" &&
      rule.targetCollection.trim() === rule.collection.trim()
  );
}

/**
 * Detect multi-collection cascade cycles (A -> B -> A). A rule is an edge from
 * its own collection to its target collection; a rule without a target fans
 * out to every collection named by any rule. Only cycles whose edges are ALL
 * cascade are dangerous (a cascade loop can amplify deletes).
 */
export function findCascadeCycles(rules: RelationRuleDraft[]): string[][] {
  const cascadeRules = rules.filter((rule) => rule.onDelete === "cascade" && rule.collection.trim());
  const collections = [
    ...new Set(
      rules.flatMap((rule) => [rule.collection.trim(), rule.targetCollection.trim()]).filter(Boolean)
    ),
  ];
  const edges = new Map<string, Set<string>>();
  for (const rule of cascadeRules) {
    const from = rule.collection.trim();
    const targets = rule.targetCollection.trim() ? [rule.targetCollection.trim()] : collections;
    const set = edges.get(from) ?? new Set<string>();
    for (const target of targets) set.add(target);
    edges.set(from, set);
  }

  // A DFS back-edge identifies a cycle in O(V + E). Do not enumerate all
  // simple paths: target-less rules can create a dense graph of 50 nodes.
  const cycles: string[][] = [];
  const visited = new Set<string>();
  const active = new Set<string>();
  const path: string[] = [];
  const visit = (node: string): void => {
    visited.add(node);
    active.add(node);
    path.push(node);
    for (const next of edges.get(node) ?? []) {
      if (!visited.has(next)) visit(next);
      else if (active.has(next) && next !== node) {
        cycles.push(path.slice(path.indexOf(next)));
      }
    }
    path.pop();
    active.delete(node);
  };
  for (const node of edges.keys()) if (!visited.has(node)) visit(node);
  return cycles;
}

export function hasCascadeRules(rules: RelationRuleDraft[]): boolean {
  return rules.some((rule) => rule.onDelete === "cascade");
}

/** apiFetch collapses status codes into the message; match the server text. */
export function isVersionConflictError(error: unknown): boolean {
  return error instanceof Error && /conflict/i.test(error.message);
}

function RelationsManagerPage() {
  const { projectId } = useParams({ from: Route.id });
  const { t } = useI18n();
  const queryClient = useQueryClient();

  const query = useQuery({
    queryKey: ["relation-rules", projectId],
    queryFn: () => fetchRelationRules(projectId),
  });

  const [drafts, setDrafts] = React.useState<RelationRuleDraft[] | null>(null);
  const [draftVersion, setDraftVersion] = React.useState<number | null>(null);
  const [form, setForm] = React.useState<RelationRuleDraft>({
    collection: "",
    field: "",
    targetCollection: "",
    onDelete: "cascade",
  });

  React.useEffect(() => {
    if (query.data && drafts === null) {
      setDrafts(query.data.rules.map(toDraft));
      setDraftVersion(query.data.version);
    }
  }, [query.data, drafts]);

  const rules = drafts ?? [];
  const validationErrors = validateRelationRuleDrafts(rules);
  const selfReferential = findSelfReferentialRules(rules);
  const cascadeCycles = findCascadeCycles(rules);
  const cascadeImpact = hasCascadeRules(rules);

  const saveMutation = useMutation({
    mutationFn: () =>
      replaceRelationRules(projectId, {
        rules: draftsToPayload(rules),
        expectedVersion: draftVersion,
      }),
    onSuccess: (data) => {
      toast.success(t("relations.savedToast", { version: data.version }));
      queryClient.setQueryData(["relation-rules", projectId], data);
      setDrafts(data.rules.map(toDraft));
      setDraftVersion(data.version);
    },
    onError: (error) => {
      if (isVersionConflictError(error)) {
        toast.error(t("relations.conflictToast"));
      } else {
        toast.error(error instanceof Error ? error.message : t("relations.saveFailed"));
      }
    },
  });

  const addRule = () => {
    const next = [...rules, { ...form }];
    if (validateRelationRuleDrafts(next).length > 0) {
      toast.error(t("relations.errors.invalidNewRule"));
      return;
    }
    setDrafts(next);
    setForm({ collection: "", field: "", targetCollection: "", onDelete: "cascade" });
  };

  const removeRule = (index: number) => {
    setDrafts(rules.filter((_, i) => i !== index));
  };

  const reload = async () => {
    const result = await query.refetch();
    if (result.data && !result.isError) {
      setDrafts(result.data.rules.map(toDraft));
      setDraftVersion(result.data.version);
    }
  };

  if (query.isLoading) {
    return <LoadingState />;
  }
  if (query.isError) {
    return (
      <ErrorState
        message={query.error instanceof Error ? query.error.message : t("relations.loadFailed")}
        onRetry={reload}
      />
    );
  }

  return (
    <PageContent>
      <ConfigurablePageHeader
        title={t("relations.title")}
        description={t("relations.description")}
        actions={
          <div className="flex items-center gap-2">
            <Badge variant="secondary" className="font-mono text-[11px]">
              {t("relations.version", { version: draftVersion ?? 0 })}
            </Badge>
            <Button variant="outline" size="sm" onClick={reload}>
              <RefreshCw className="h-3.5 w-3.5" />
              {t("relations.reload")}
            </Button>
            <Button
              size="sm"
              disabled={draftVersion === null || validationErrors.length > 0 || saveMutation.isPending || query.isFetching}
              onClick={() => saveMutation.mutate()}
            >
              {saveMutation.isPending ? t("relations.saving") : t("relations.save")}
            </Button>
          </div>
        }
      />

      {cascadeImpact && (
        <Alert>
          <AlertTriangle className="h-4 w-4" />
          <AlertTitle>{t("relations.warnings.cascadeImpactTitle")}</AlertTitle>
          <AlertDescription>{t("relations.warnings.cascadeImpactBody")}</AlertDescription>
        </Alert>
      )}

      {cascadeCycles.map((cycle) => (
        <Alert key={cycle.join("->")} variant="destructive">
          <AlertTriangle className="h-4 w-4" />
          <AlertTitle>{t("relations.warnings.cycleTitle")}</AlertTitle>
          <AlertDescription>
            {t("relations.warnings.cycleBody", { cycle: [...cycle, cycle[0]].join(" → ") })}
          </AlertDescription>
        </Alert>
      ))}

      {selfReferential.length > 0 && (
        <Alert>
          <Info className="h-4 w-4" />
          <AlertTitle>{t("relations.warnings.selfRefTitle")}</AlertTitle>
          <AlertDescription>
            {t("relations.warnings.selfRefBody", {
              rules: selfReferential
                .map((rule) => `${rule.collection.trim()}.${rule.field.trim()}`)
                .join(", "),
            })}
          </AlertDescription>
        </Alert>
      )}

      {validationErrors.length > 0 && (
        <Alert variant="destructive">
          <AlertTriangle className="h-4 w-4" />
          <AlertTitle>{t("relations.errors.title")}</AlertTitle>
          <AlertDescription>
            <ul className="list-disc ps-4">
              {validationErrors.map((key) => (
                <li key={key}>
                  {t(key, { max: MAX_RELATION_RULES_PER_PROJECT })}
                </li>
              ))}
            </ul>
          </AlertDescription>
        </Alert>
      )}

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <GitBranch className="h-4 w-4" />
            {t("relations.listTitle")}
          </CardTitle>
          <CardDescription>{t("relations.listDescription")}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {rules.length === 0 ? (
            <EmptyState
              title={t("relations.emptyTitle")}
              description={t("relations.emptyDescription")}
            />
          ) : (
            <div className="overflow-x-auto rounded-md border">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b bg-muted/50 text-start">
                    <th className="px-3 py-2 text-start font-medium">{t("relations.columns.collection")}</th>
                    <th className="px-3 py-2 text-start font-medium">{t("relations.columns.field")}</th>
                    <th className="px-3 py-2 text-start font-medium">{t("relations.columns.target")}</th>
                    <th className="px-3 py-2 text-start font-medium">{t("relations.columns.onDelete")}</th>
                    <th className="px-3 py-2 text-end font-medium">{t("relations.columns.actions")}</th>
                  </tr>
                </thead>
                <tbody>
                  {rules.map((rule, index) => (
                    <tr key={`${rule.collection}.${rule.field}.${index}`} className="border-b last:border-0">
                      <td className="px-3 py-2 font-mono text-xs" dir="auto">{rule.collection}</td>
                      <td className="px-3 py-2 font-mono text-xs" dir="auto">{rule.field}</td>
                      <td className="px-3 py-2 font-mono text-xs" dir="auto">
                        {rule.targetCollection || (
                          <span className="text-muted-foreground">{t("relations.anyCollection")}</span>
                        )}
                      </td>
                      <td className="px-3 py-2">
                        <Badge
                          variant={rule.onDelete === "restrict" ? "secondary" : "outline"}
                          className={
                            rule.onDelete === "cascade"
                              ? "border-warning/40 bg-warning/10 font-mono text-[11px] text-warning"
                              : "font-mono text-[11px]"
                          }
                        >
                          {rule.onDelete === "cascade" ? (
                            <AlertTriangle className="h-3 w-3" />
                          ) : null}
                          {rule.onDelete}
                        </Badge>
                      </td>
                      <td className="px-3 py-2 text-end">
                        <Button
                          variant="ghost"
                          size="sm"
                          aria-label={t("relations.removeRule")}
                          onClick={() => removeRule(index)}
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </Button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          <div className="rounded-md border border-dashed p-3">
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-[1fr_1fr_1fr_160px_auto]">
              <div className="space-y-1">
                <Label htmlFor="relCollection" className="text-[11px]">
                  {t("relations.columns.collection")}
                </Label>
                <Input
                  id="relCollection"
                  className="h-8 font-mono text-xs"
                  placeholder={t("relations.placeholders.collection")}
                  value={form.collection}
                  onChange={(e) => setForm({ ...form, collection: e.target.value })}
                />
              </div>
              <div className="space-y-1">
                <Label htmlFor="relField" className="text-[11px]">
                  {t("relations.columns.field")}
                </Label>
                <Input
                  id="relField"
                  className="h-8 font-mono text-xs"
                  placeholder={t("relations.placeholders.field")}
                  value={form.field}
                  onChange={(e) => setForm({ ...form, field: e.target.value })}
                />
              </div>
              <div className="space-y-1">
                <Label htmlFor="relTarget" className="text-[11px]">
                  {t("relations.columns.target")}
                </Label>
                <Input
                  id="relTarget"
                  className="h-8 font-mono text-xs"
                  placeholder={t("relations.placeholders.target")}
                  value={form.targetCollection}
                  onChange={(e) => setForm({ ...form, targetCollection: e.target.value })}
                />
              </div>
              <div className="space-y-1">
                <Label htmlFor="relOnDelete" className="text-[11px]">
                  {t("relations.columns.onDelete")}
                </Label>
                <Select
                  value={form.onDelete}
                  onValueChange={(value) =>
                    setForm({ ...form, onDelete: value as RelationRuleOnDelete })
                  }
                >
                  <SelectTrigger id="relOnDelete" className="h-8 w-full text-xs">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {ON_DELETE_ACTIONS.map((action) => (
                      <SelectItem key={action} value={action} className="font-mono text-xs">
                        {action}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="flex items-end">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={addRule}
                  disabled={!form.collection.trim() || !form.field.trim()}
                >
                  <Plus className="h-3.5 w-3.5" />
                  {t("relations.addRule")}
                </Button>
              </div>
            </div>
          </div>
        </CardContent>
      </Card>
    </PageContent>
  );
}
