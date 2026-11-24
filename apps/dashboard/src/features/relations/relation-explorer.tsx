import * as React from "react";
import { useMutation } from "@tanstack/react-query";
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Input,
  Label,
  useI18n,
} from "@vellum/ui";
import { Eye, Play } from "lucide-react";
import { consoleFetch, consoleProjectsBase, type ConsoleQueryResponse } from "../../lib/api.js";

export interface ExplorerRule {
  collection: string;
  field: string;
  targetCollection: string;
}

type ExplorerDoc = Record<string, unknown> & {
  id?: string;
  documentId?: string;
  data?: Record<string, unknown>;
  _included?: Record<string, unknown>;
  _redactedRefs?: string[];
};

export type RelationState = "resolved" | "dangling" | "empty" | "hidden";

/** The value stored in the reference field, whether the doc is flat or wrapped in `data`. */
export function referenceValue(doc: ExplorerDoc, field: string): unknown {
  const source = doc.data && typeof doc.data === "object" ? doc.data : doc;
  return field.split(".").reduce<unknown>((acc, key) => {
    if (acc && typeof acc === "object") return (acc as Record<string, unknown>)[key];
    return undefined;
  }, source);
}

export function relationState(doc: ExplorerDoc, field: string): RelationState {
  const value = referenceValue(doc, field);
  if (value === undefined || value === null || value === "") return "empty";
  if (doc._redactedRefs?.some((ref) => ref === field || ref.startsWith(`${field}.`))) return "hidden";
  const included = doc._included?.[field];
  if (included === undefined || included === null) return "dangling";
  return "resolved";
}

export function buildIncludeQuery(rule: ExplorerRule, limit: number) {
  return {
    collection: rule.collection,
    limit: Math.min(Math.max(Math.trunc(limit) || 1, 1), 25),
    include: [rule.field],
  };
}

function preview(value: unknown): string {
  const text = JSON.stringify(value);
  if (text === undefined) return "";
  return text.length > 160 ? `${text.slice(0, 157)}...` : text;
}

export function RelationExplorer({
  projectId,
  rules,
}: {
  projectId: string;
  rules: ExplorerRule[];
}): React.ReactElement | null {
  const { t } = useI18n();
  const [selected, setSelected] = React.useState(0);
  const [limit, setLimit] = React.useState(5);
  const rule = rules[Math.min(selected, Math.max(rules.length - 1, 0))];
  const queryBody = rule ? buildIncludeQuery(rule, limit) : null;

  const run = useMutation({
    mutationFn: () =>
      consoleFetch<ConsoleQueryResponse<ExplorerDoc>>(`${consoleProjectsBase(projectId)}/query`, {
        method: "POST",
        body: JSON.stringify(queryBody),
      }),
  });

  if (rules.length === 0 || !rule || !queryBody) return null;
  const docs = run.data?.documents ?? [];

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Eye className="h-4 w-4" />
          {t("relations.explorer.title")}
        </CardTitle>
        <CardDescription>{t("relations.explorer.description")}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-[1fr_120px_auto]">
          <div className="space-y-1">
            <Label htmlFor="relExplorerRule" className="text-[11px]">
              {t("relations.explorer.rule")}
            </Label>
            <select
              id="relExplorerRule"
              className="h-8 w-full rounded-md border bg-background px-2 font-mono text-xs"
              value={selected}
              onChange={(e) => {
                setSelected(Number(e.target.value));
                run.reset();
              }}
            >
              {rules.map((r, index) => (
                <option key={`${r.collection}.${r.field}.${index}`} value={index}>
                  {r.collection}.{r.field}
                  {r.targetCollection ? ` -> ${r.targetCollection}` : ""}
                </option>
              ))}
            </select>
          </div>
          <div className="space-y-1">
            <Label htmlFor="relExplorerLimit" className="text-[11px]">
              {t("relations.explorer.limit")}
            </Label>
            <Input
              id="relExplorerLimit"
              type="number"
              min={1}
              max={25}
              className="h-8 font-mono text-xs"
              value={limit}
              onChange={(e) => setLimit(Number(e.target.value))}
            />
          </div>
          <div className="flex items-end">
            <Button size="sm" variant="outline" onClick={() => run.mutate()} disabled={run.isPending}>
              <Play className="h-3.5 w-3.5" />
              {run.isPending ? t("relations.explorer.running") : t("relations.explorer.run")}
            </Button>
          </div>
        </div>

        <div>
          <p className="mb-1 text-[11px] text-muted-foreground">{t("relations.explorer.request")}</p>
          <pre className="overflow-x-auto rounded-md border bg-muted/40 p-2 font-mono text-[11px]" dir="ltr">
            {JSON.stringify(queryBody, null, 2)}
          </pre>
        </div>

        {run.isError ? (
          <p className="text-sm text-destructive" role="alert">
            {run.error instanceof Error ? run.error.message : t("relations.explorer.failed")}
          </p>
        ) : null}

        {run.isSuccess && docs.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t("relations.explorer.noDocs", { collection: rule.collection })}</p>
        ) : null}

        {docs.length > 0 ? (
          <div className="overflow-x-auto rounded-md border">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b bg-muted/50">
                  <th className="px-3 py-2 text-start font-medium">{t("relations.explorer.document")}</th>
                  <th className="px-3 py-2 text-start font-medium">{rule.field}</th>
                  <th className="px-3 py-2 text-start font-medium">{t("relations.explorer.related")}</th>
                  <th className="px-3 py-2 text-start font-medium">{t("relations.explorer.status")}</th>
                </tr>
              </thead>
              <tbody>
                {docs.map((doc, index) => {
                  const state = relationState(doc, rule.field);
                  const related = doc._included?.[rule.field];
                  return (
                    <tr key={String(doc.id ?? doc.documentId ?? index)} className="border-b align-top last:border-0">
                      <td className="px-3 py-2 font-mono text-xs" dir="auto">{String(doc.id ?? doc.documentId ?? "")}</td>
                      <td className="px-3 py-2 font-mono text-xs" dir="auto">{preview(referenceValue(doc, rule.field))}</td>
                      <td className="px-3 py-2 font-mono text-xs" dir="auto">{related === undefined ? "" : preview(related)}</td>
                      <td className="px-3 py-2">
                        <Badge variant={state === "resolved" ? "outline" : "secondary"} className="font-mono text-[11px]">
                          {t(`relations.explorer.state.${state}`)}
                        </Badge>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : null}
        {run.data?.meta ? (
          <p className="text-[11px] text-muted-foreground">
            {t("relations.explorer.meta", { count: run.data.meta.count, ms: run.data.meta.executionTimeMs })}
          </p>
        ) : null}
      </CardContent>
    </Card>
  );
}
