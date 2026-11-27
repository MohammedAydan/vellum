import * as React from "react";
import { createRoute, useParams } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { Route as projectRoute } from "./orgs.$orgId.projects.$projectId.js";
import {
  apiFetch,
  compileProjectRules,
  consoleFetch,
  consoleProjectsBase,
  type ConsoleRuleset,
} from "../../lib/api.js";
import {
  ConfigurablePageHeader,
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
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectGroup,
  SelectLabel,
  SelectItem,
  Tabs,
  TabsList,
  TabsTrigger,
  TabsContent,
  KeyValueRow,
  LoadingState,
  ErrorState,
  useI18n,
} from "@vellum/ui";
import { toast } from "sonner";
import {
  Play,
  UploadCloud,
  RotateCcw,
  CheckCircle2,
  XCircle,
  FileCode,
  Terminal,
  ShieldCheck,
  AlertTriangle,
  Braces,
  Sparkles,
} from "lucide-react";

export const Route = createRoute({
  getParentRoute: () => projectRoute,
  path: "rules",
  component: RulesStudioPage,
});

/* -------------------------------------------------------------------------- */
/* Local types (the dashboard is a thin adapter — the server owns semantics)   */
/* -------------------------------------------------------------------------- */

type AllowOperation = "get" | "list" | "create" | "update" | "delete";
type RulesMode = "dsl" | "json";
type AuthMode = "unauthenticated" | "authenticated";

interface RulesAst {
  version: number;
  rules: Array<{ match: string; allow: Record<string, unknown> }>;
}

interface RulesDslIssue {
  message: string;
  line: number;
  column: number;
  snippet: string;
}

interface SimulationResult {
  allowed: boolean;
  matchedRule: string | null;
  evaluationTrace: string[];
}

interface CompileOutcome {
  ok: boolean;
  ast: RulesAst | null;
  error: RulesDslIssue | null;
  /** Non-blocking warning diagnostics (for example WILDCARD_OVERLAP). */
  issues: RulesDslIssue[];
}

export interface DslTemplate {
  id: string;
  labelKey: string;
  source: string;
}

type ParsedJsonObject =
  | { ok: true; value: Record<string, unknown> }
  | { ok: false; error: string };

/* -------------------------------------------------------------------------- */
/* Canonical fallbacks & quick-insert templates                                */
/* -------------------------------------------------------------------------- */

/** Canonical v1 AST: allow keys are exactly get/list/create/update/delete. */
const defaultRulesAst = {
  version: 1,
  rules: [
    {
      match: "/users/{userId}",
      allow: {
        get: {
          op: "==",
          left: { var: "auth.uid" },
          right: { var: "path.userId" },
        },
        list: {
          op: "==",
          left: { var: "auth.uid" },
          right: { var: "path.userId" },
        },
        create: {
          op: "all",
          conditions: [
            { op: "!=", left: { var: "auth.uid" }, right: { val: null } },
            { op: "==", left: { var: "request.data.customerId" }, right: { var: "auth.uid" } },
          ],
        },
        update: {
          op: "==",
          left: { var: "auth.uid" },
          right: { var: "path.userId" },
        },
        delete: {
          op: "==",
          left: { var: "auth.uid" },
          right: { var: "path.userId" },
        },
      },
    },
    {
      match: "/orders/{orderId}",
      allow: {
        get: {
          op: "==",
          left: { var: "auth.uid" },
          right: { var: "resource.data.customerId" },
        },
        list: {
          op: "==",
          left: { var: "auth.uid" },
          right: { var: "resource.data.customerId" },
        },
      },
    },
  ],
};

/** Sensible DSL fallback when the active ruleset cannot be decompiled. */
export const DEFAULT_RULES_DSL = `rules_version = '2';

match /users/{userId} {
  allow get: if isOwner(path.userId);
  allow list: if isOwner(path.userId);
  allow create: if isSignedIn() && incoming.customerId == auth.uid;
  allow update: if isOwner(path.userId) && unchanged(['createdAt']);
  allow delete: if isOwner(path.userId);
}

match /orders/{orderId} {
  allow read: if isSignedIn() && resource.customerId == auth.uid;
}
`;

/**
 * Quick-insert templates. Every source is valid v2 rules DSL: the compiler
 * expands the built-in macros into deterministic v1 AST nodes on the server.
 */
export const RULE_DSL_TEMPLATES: readonly DslTemplate[] = [
  {
    id: "owner-read-write",
    labelKey: "rules.dsl.template.ownerReadWrite",
    source: `rules_version = '2';

match /posts/{postId} {
  allow read: if isSignedIn() && isOwner(resource.ownerId);
  allow create: if isSignedIn() && incoming.ownerId == auth.uid;
  allow update: if isOwner(resource.ownerId) && unchanged(['ownerId', 'createdAt']);
  allow delete: if isOwner(resource.ownerId);
}
`,
  },
  {
    id: "role-based-admin",
    labelKey: "rules.dsl.template.rbac",
    source: `rules_version = '2';

match /admin/{documentId} {
  allow read: if hasRole('admin') || hasAnyRole(['admin', 'owner']);
  allow create: if isSignedIn() && hasRole('admin');
  allow update: if hasRole('admin') && unchanged(['createdAt']);
  allow delete: if hasRole('admin');
}
`,
  },
  {
    id: "public-read-authenticated-create",
    labelKey: "rules.dsl.template.publicReadAuthenticatedCreate",
    source: `rules_version = '2';

match /posts/{postId} {
  allow read: if true;
  allow create: if isSignedIn() && hasKey(incoming, 'title');
  allow update: if isSignedIn();
  allow delete: if hasRole('admin');
}
`,
  },
  {
    id: "multi-tenant-organization-isolation",
    labelKey: "rules.dsl.template.multiTenant",
    source: `rules_version = '2';

match /orgs/{orgId}/documents/{documentId} {
  allow read: if isSignedIn() && auth.claims.orgId == path.orgId;
  allow create: if isSignedIn() && incoming.orgId == path.orgId && auth.claims.orgId == path.orgId;
  allow update: if auth.claims.orgId == path.orgId && unchanged(['orgId']);
  allow delete: if auth.claims.orgId == path.orgId;
}
`,
  },
] as const;

/* -------------------------------------------------------------------------- */
/* Pure helpers (exported for deterministic unit tests)                        */
/* -------------------------------------------------------------------------- */

/**
 * Never render a non-string, empty, or structurally incomplete decompile
 * response as the editor value. The compiler requires at least one `match`
 * block; a ruleset with zero rules decompiles to just the version header,
 * which would otherwise trigger a permanent inline syntax error and a 400 on
 * every debounced compile (and break the publish flow).
 */
export function safeDslFallback(value: unknown): string {
  if (typeof value !== "string" || value.trim().length === 0) return DEFAULT_RULES_DSL;
  return /match\s+\//.test(value) ? value : DEFAULT_RULES_DSL;
}

/** Insert (or replace the selected) template text without losing other edits. */
export function insertTemplateAtCursor(
  source: string,
  template: string,
  selectionStart: number,
  selectionEnd: number
): { value: string; selectionStart: number; selectionEnd: number } {
  const versionHeader = source.match(/^\s*rules_version\s*=\s*["'][^"']*["']\s*;?[ \t]*\r?\n?/);
  const headerEnd = versionHeader ? versionHeader[0].length : 0;
  let start = Math.max(0, Math.min(source.length, selectionStart));
  let end = Math.max(start, Math.min(source.length, selectionEnd));
  // A template must never be inserted above the mandatory `rules_version`
  // declaration: the DSL grammar requires it as the first statement.
  if (versionHeader && end === start && start < headerEnd) {
    start = headerEnd;
    end = headerEnd;
  }
  const before = source.slice(0, start);
  const after = source.slice(end);
  // Templates carry their own `rules_version` so they compile as standalone
  // snippets in unit tests. When inserted into an editor that already declares
  // it, strip the duplicate declaration — the DSL grammar allows it only once.
  const hasVersion = versionHeader !== null;
  const normalizedTemplate = hasVersion
    ? template.replace(/^\s*rules_version\s*=\s*["'][^"']*["']\s*;?\s*\r?\n?/, "")
    : template;
  const leading = before.length > 0 && !before.endsWith("\n") ? "\n\n" : "";
  const trailing = after.length > 0 && !after.startsWith("\n") ? "\n\n" : "";
  const insertion = `${leading}${normalizedTemplate}${trailing}`;
  const value = `${before}${insertion}${after}`;
  // Leave the caret at the end of the template itself (before trailing blanks).
  const cursor = before.length + leading.length + normalizedTemplate.length;
  return { value, selectionStart: cursor, selectionEnd: cursor };
}

/** Only version 1 ASTs are publishable (DSL sugar still compiles to v1). */
export function isVersionOneAst(value: unknown): value is RulesAst {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return record["version"] === 1 && Array.isArray(record["rules"]);
}

export function isRulesDslIssue(value: unknown): value is RulesDslIssue {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record["message"] === "string" &&
    typeof record["line"] === "number" &&
    typeof record["column"] === "number"
  );
}

function buildLocalSnippet(source: string, line: number, column: number): string {
  if (!source) return "";
  const lines = source.split(/\r?\n/);
  const index = Math.max(0, Math.min(lines.length - 1, line - 1));
  const text = lines[index] ?? "";
  return `${text}\n${" ".repeat(Math.max(0, column - 1))}^`;
}

/**
 * Extract the positioned 400 error body (`error.line/column/snippet`).
 * `apiFetch` surfaces only `error.message` on failure, so the raw body is read
 * once on the error path; the local source is used only as a last-resort
 * snippet fallback so the block is never blank.
 */
export function parseRulesCompileError(
  payload: unknown,
  fallbackMessage: string,
  source = ""
): RulesDslIssue {
  let message = fallbackMessage;
  let line = 1;
  let column = 1;
  let snippet = "";
  let positioned = false;

  if (payload !== null && typeof payload === "object" && "error" in payload) {
    const error = (payload as { error: unknown }).error;
    if (error !== null && typeof error === "object") {
      const record = error as Record<string, unknown>;
      if (typeof record["message"] === "string" && record["message"].length > 0) {
        message = record["message"];
      }
      if (typeof record["line"] === "number" && Number.isFinite(record["line"]) && record["line"] > 0) {
        line = Math.floor(record["line"]);
        positioned = true;
      }
      if (typeof record["column"] === "number" && Number.isFinite(record["column"]) && record["column"] > 0) {
        column = Math.floor(record["column"]);
      }
      if (typeof record["snippet"] === "string") snippet = record["snippet"];
    }
  }

  if (!positioned) {
    const match = message.match(/line (\d+), column (\d+)/);
    if (match?.[1] && match[2]) {
      line = Number.parseInt(match[1], 10);
      column = Number.parseInt(match[2], 10);
    }
  }
  if (snippet.length === 0 && source.length > 0) {
    snippet = buildLocalSnippet(source, line, column);
  }
  return { message, line, column, snippet };
}

/** Strict-ish JSON object parsing for simulator mock payloads. */
export function parseJsonObject(text: string): ParsedJsonObject {
  const trimmed = text.trim();
  if (trimmed.length === 0) return { ok: true, value: {} };
  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { ok: false, error: "JSON object expected" };
    }
    return { ok: true, value: parsed as Record<string, unknown> };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Invalid JSON" };
  }
}

/* -------------------------------------------------------------------------- */
/* Component                                                                   */
/* -------------------------------------------------------------------------- */

const DEBOUNCE_MS = 400;

function RulesStudioPage() {
  const { projectId } = useParams({ from: Route.id });
  const { t } = useI18n();
  const base = consoleProjectsBase(projectId);
  const v1Base = `/v1/projects/${encodeURIComponent(projectId)}`;

  const [mode, setMode] = React.useState<RulesMode>("dsl");
  const [dslSource, setDslSource] = React.useState<string>(DEFAULT_RULES_DSL);
  const [rulesJson, setRulesJson] = React.useState<string>(
    JSON.stringify(defaultRulesAst, null, 2)
  );
  const [compiledAst, setCompiledAst] = React.useState<RulesAst | null>(null);
  const [diagnostics, setDiagnostics] = React.useState<RulesDslIssue[]>([]);
  const [compileError, setCompileError] = React.useState<RulesDslIssue | null>(null);
  const [dslStatus, setDslStatus] = React.useState<"idle" | "checking" | "valid" | "invalid">("idle");
  const [decompileError, setDecompileError] = React.useState<string | null>(null);

  const [selection, setSelection] = React.useState<{ start: number; end: number }>({ start: 0, end: 0 });
  const [pendingTemplate, setPendingTemplate] = React.useState<{
    template: DslTemplate;
    start: number;
    end: number;
  } | null>(null);
  const dslEditorRef = React.useRef<HTMLTextAreaElement | null>(null);

  const [authMode, setAuthMode] = React.useState<AuthMode>("authenticated");
  const [authUid, setAuthUid] = React.useState<string>("usr_123");
  const [claimsJson, setClaimsJson] = React.useState<string>('{\n  "role": "admin"\n}');
  const [resourceJson, setResourceJson] = React.useState<string>('{\n  "ownerId": "usr_123"\n}');
  const [incomingJson, setIncomingJson] = React.useState<string>('{\n  "ownerId": "usr_123"\n}');
  const [path, setPath] = React.useState<string>("/users/usr_123");
  const [operation, setOperation] = React.useState<AllowOperation>("get");
  const [simulating, setSimulating] = React.useState(false);
  const [simulationResult, setSimulationResult] = React.useState<SimulationResult | null>(null);

  const compileSeq = React.useRef(0);
  const lastErrorSignature = React.useRef("");

  const {
    data: ruleset,
    isLoading,
    isError,
    error,
    refetch,
  } = useQuery({
    queryKey: ["ruleset", projectId],
    queryFn: () => consoleFetch<ConsoleRuleset>(`${base}/rulesets`),
  });

  // Real persisted collections for the simulator quick-pick. The #simPath
  // input stays authoritative: selecting a collection only pre-fills a path.
  const { data: collectionsResponse } = useQuery({
    queryKey: ["collections", projectId],
    queryFn: () =>
      consoleFetch<{ collections: Array<{ name: string; documentCount: number }> }>(
        `${consoleProjectsBase(projectId)}/collections?limit=500`
      ),
  });
  const collections = collectionsResponse?.collections ?? [];

  const runCompile = React.useCallback(
    async (source: string, seq: number, notify: boolean): Promise<CompileOutcome> => {
      const endpoint = `${v1Base}/rules/compile`;
      setDslStatus("checking");
      try {
        const result = await compileProjectRules(endpoint, source);
        if (!result.ok) {
          const fallback = result.errorMessage ?? t("rules.studio.compileFailed");
          const issue = parseRulesCompileError(result.errorPayload, fallback, source);
          if (seq !== compileSeq.current) return { ok: false, ast: null, error: issue, issues: [] };
          setCompiledAst(null);
          setDiagnostics([]);
          setCompileError(issue);
          setDslStatus("invalid");
          const signature = `${issue.line}:${issue.column}:${issue.message}`;
          if (notify && signature !== lastErrorSignature.current) {
            lastErrorSignature.current = signature;
            toast.error(t("rules.studio.syntaxErrorToast"));
          }
          return { ok: false, ast: null, error: issue, issues: [] };
        }
        const issues = Array.isArray(result.diagnostics)
          ? result.diagnostics.filter(isRulesDslIssue)
          : [];
        if (!isVersionOneAst(result.ast)) {
          throw new Error(t("rules.invalidAst"));
        }
        if (seq !== compileSeq.current) return { ok: true, ast: result.ast, error: null, issues };
        setCompiledAst(result.ast);
        setDiagnostics(issues);
        setCompileError(null);
        setDslStatus("valid");
        lastErrorSignature.current = "";
        return { ok: true, ast: result.ast, error: null, issues };
      } catch (err) {
        const message = err instanceof Error ? err.message : t("rules.studio.compileFailed");
        const issue = parseRulesCompileError(null, message, source);
        if (seq !== compileSeq.current) return { ok: false, ast: null, error: issue, issues: [] };
        setCompiledAst(null);
        setDiagnostics([]);
        setCompileError(issue);
        setDslStatus("invalid");
        const signature = `${issue.line}:${issue.column}:${issue.message}`;
        if (notify && signature !== lastErrorSignature.current) {
          lastErrorSignature.current = signature;
          toast.error(t("rules.studio.syntaxErrorToast"));
        }
        return { ok: false, ast: null, error: issue, issues: [] };
      }
    },
    [t, v1Base]
  );

  /** Load the active ruleset into BOTH editors (single source of truth). */
  React.useEffect(() => {
    if (!isVersionOneAst(ruleset?.rulesAst)) return;
    const ast = ruleset.rulesAst;
    setRulesJson(JSON.stringify(ast, null, 2));
    setDecompileError(null);
    const endpoint = `${v1Base}/rules/decompile`;
    const seq = ++compileSeq.current;
    void apiFetch<{ dsl?: unknown }>(endpoint, {
      method: "POST",
      body: JSON.stringify({ rulesAst: ast }),
    })
      .then((result) => {
        if (seq !== compileSeq.current) return;
        setDslSource(safeDslFallback(result?.dsl));
      })
      .catch((err: unknown) => {
        if (seq !== compileSeq.current) return;
        const message = err instanceof Error ? err.message : t("rules.studio.decompileFailed");
        setDslSource(DEFAULT_RULES_DSL);
        setDecompileError(message);
        toast.error(t("rules.studio.decompileFailed"));
      });
  }, [ruleset, t, v1Base]);

  /** Debounced, server-authoritative syntax check for DSL edits. */
  React.useEffect(() => {
    if (mode !== "dsl") return;
    const seq = ++compileSeq.current;
    setDslStatus("checking");
    const timer = setTimeout(() => {
      void runCompile(dslSource, seq, true);
    }, DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [dslSource, mode, runCompile]);

  const applyTemplate = (template: DslTemplate, start: number, end: number) => {
    const result = insertTemplateAtCursor(dslSource, template.source, start, end);
    setDslSource(result.value);
    setPendingTemplate(null);
    requestAnimationFrame(() => {
      const el = dslEditorRef.current;
      if (!el) return;
      el.focus();
      el.setSelectionRange(result.selectionStart, result.selectionEnd);
      setSelection({ start: result.selectionStart, end: result.selectionEnd });
    });
  };

  const handleTemplateClick = (template: DslTemplate) => {
    const el = dslEditorRef.current;
    const start = el?.selectionStart ?? selection.start;
    const end = el?.selectionEnd ?? selection.end;
    if (end > start) {
      // Replacing an explicit selection is destructive — ask first.
      setPendingTemplate({ template, start, end });
      return;
    }
    applyTemplate(template, start, end);
  };

  const handleReset = () => {
    ++compileSeq.current;
    setDslSource(DEFAULT_RULES_DSL);
    setRulesJson(JSON.stringify(defaultRulesAst, null, 2));
    setCompiledAst(null);
    setDiagnostics([]);
    setCompileError(null);
    setDecompileError(null);
    setDslStatus("idle");
    lastErrorSignature.current = "";
    toast.info(t("rules.resetToast"));
  };

  const handleModeChange = async (next: RulesMode) => {
    if (next === mode) return;
    if (next === "json") {
      const seq = ++compileSeq.current;
      const outcome = await runCompile(dslSource, seq, true);
      if (!outcome.ok || !outcome.ast) {
        toast.error(t("rules.studio.switchToJsonFailed"));
        return; // stay on DSL — never discard invalid edits
      }
      setRulesJson(JSON.stringify(outcome.ast, null, 2));
      setDecompileError(null);
      setMode("json");
      return;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(rulesJson);
    } catch {
      toast.error(t("rules.studio.jsonParseFailed"));
      return;
    }
    if (!isVersionOneAst(parsed)) {
      toast.error(t("rules.invalidAst"));
      return;
    }
    try {
      const result = await apiFetch<{ dsl?: unknown }>(`${v1Base}/rules/decompile`, {
        method: "POST",
        body: JSON.stringify({ rulesAst: parsed }),
      });
      ++compileSeq.current;
      setDslSource(safeDslFallback(result?.dsl));
      setDecompileError(null);
      setMode("dsl");
    } catch (err) {
      const message = err instanceof Error ? err.message : t("rules.studio.decompileFailed");
      setDecompileError(message);
      toast.error(t("rules.studio.decompileFailed"));
      // stay on JSON so the user's edits are not lost
    }
  };

  // Overlap warnings never block a publish silently: the first click surfaces
  // them (and shows them in the diagnostics panel), the second click on an
  // unchanged source publishes anyway. The key resets after any successful
  // publish so edited rules are re-checked.
  const publishAckRef = React.useRef<string>("");

  const handlePublish = async () => {
    try {
      let ast: RulesAst;
      let warnings: RulesDslIssue[] = [];
      let ackKey = "";
      if (mode === "dsl") {
        const outcome = await runCompile(dslSource, ++compileSeq.current, true);
        if (!outcome.ok || !outcome.ast) {
          toast.error(t("rules.studio.publishCompileFailed"));
          return;
        }
        ast = outcome.ast;
        warnings = outcome.issues;
        ackKey = `dsl:${dslSource}`;
      } else {
        let parsed: unknown;
        try {
          parsed = JSON.parse(rulesJson);
        } catch {
          toast.error(t("rules.studio.jsonParseFailed"));
          return;
        }
        if (!isVersionOneAst(parsed)) {
          toast.error(t("rules.invalidAst"));
          return;
        }
        ast = parsed;
        // Raw-AST publishes skip the DSL compile, so run the same static
        // analysis here: decompile the AST, compile the DSL, surface warnings.
        // Best-effort only; the publish call itself stays authoritative.
        try {
          const dec = await apiFetch<{ dsl?: unknown }>(`${v1Base}/rules/decompile`, {
            method: "POST",
            body: JSON.stringify({ rulesAst: ast }),
          });
          if (typeof dec?.dsl === "string" && dec.dsl.length > 0) {
            const compiled = await compileProjectRules(`${v1Base}/rules/compile`, dec.dsl);
            if (compiled.ok && Array.isArray(compiled.diagnostics)) {
              warnings = compiled.diagnostics.filter(isRulesDslIssue);
              ackKey = `json:${rulesJson}`;
            }
          }
        } catch {
          warnings = [];
        }
      }
      if (warnings.length > 0 && ackKey !== "" && publishAckRef.current !== ackKey) {
        publishAckRef.current = ackKey;
        setDiagnostics(warnings);
        toast.warning(t("rules.studio.publishWarningsConfirm", { count: warnings.length }));
        return;
      }
      await consoleFetch(`${base}/rulesets`, {
        method: "POST",
        body: JSON.stringify({ rulesAst: ast }),
      });
      publishAckRef.current = "";
      await refetch();
      toast.success(t("rules.publishedToast"));
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t("rules.publishFailed"));
    }
  };

  const handleSimulate = async () => {
    const resource = parseJsonObject(resourceJson);
    if (!resource.ok) {
      toast.error(`${t("rules.studio.resourceData")}: ${resource.error}`);
      return;
    }
    const incoming = parseJsonObject(incomingJson);
    if (!incoming.ok) {
      toast.error(`${t("rules.studio.incomingData")}: ${incoming.error}`);
      return;
    }
    const claims = parseJsonObject(claimsJson);
    if (!claims.ok) {
      toast.error(`${t("rules.studio.customClaims")}: ${claims.error}`);
      return;
    }

    let rulesAst: RulesAst | undefined;
    if (mode === "json") {
      try {
        const parsed: unknown = JSON.parse(rulesJson);
        if (isVersionOneAst(parsed)) rulesAst = parsed;
      } catch {
        // fall through to the last successfully compiled AST
      }
    }
    rulesAst = rulesAst ?? compiledAst ?? undefined;

    const payload: Record<string, unknown> = {
      ...(rulesAst ? { rulesAst } : {}),
      operation,
      path,
      auth:
        authMode === "authenticated"
          ? { uid: authUid.trim() || null, claims: claims.value }
          : null,
      resourceData: resource.value,
      incomingData: incoming.value,
    };

    setSimulating(true);
    try {
      const result = await apiFetch<SimulationResult>(`${v1Base}/rules/simulate`, {
        method: "POST",
        body: JSON.stringify(payload),
      });
      setSimulationResult({
        allowed: result.allowed === true,
        matchedRule: typeof result.matchedRule === "string" ? result.matchedRule : null,
        evaluationTrace: Array.isArray(result.evaluationTrace)
          ? result.evaluationTrace.filter((line): line is string => typeof line === "string")
          : [],
      });
      toast.success(result.allowed ? t("rules.allowedToast") : t("rules.deniedToast"));
    } catch (err) {
      setSimulationResult(null);
      toast.error(err instanceof Error ? err.message : t("rules.studio.simulateFailed"));
    } finally {
      setSimulating(false);
    }
  };

  if (isLoading) return <LoadingState rows={4} columns={2} />;
  if (isError) {
    return (
      <ErrorState
        title={t("common.errorTitle")}
        message={error instanceof Error ? error.message : t("rules.loadFailed")}
        onRetry={() => void refetch()}
      />
    );
  }

  return (
    <PageContent>
      <ConfigurablePageHeader
        title={t("rules.title")}
        description={t("rules.description")}
        actions={
          <div className="flex items-center gap-2">
            <Button variant="outline" size="sm" onClick={handleReset} className="h-8 text-xs">
              <RotateCcw className="h-3.5 w-3.5 me-1" />
              {t("rules.reset")}
            </Button>
            <Button size="sm" onClick={() => void handlePublish()} className="h-8 text-xs gap-1.5">
              <UploadCloud className="h-3.5 w-3.5" />
              {t("rules.publish")}
            </Button>
          </div>
        }
      />

      <div className="grid gap-6 lg:grid-cols-2">
        <Card className="flex flex-col">
          <CardHeader className="pb-3 border-b bg-card">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <FileCode className="h-4 w-4 text-primary" />
                <CardTitle className="text-sm font-semibold">{t("rules.definition")}</CardTitle>
              </div>
              <div className="flex items-center gap-2">
                <Badge variant="outline" className="font-mono text-[10px]">{t("rules.schemaBadge")}</Badge>
                <Badge variant="secondary" className="gap-1 font-mono text-[10px]">
                  <ShieldCheck className="h-3 w-3 text-success" />
                  {t("rules.zeroEval")}
                </Badge>
              </div>
            </div>
            <CardDescription className="text-xs">
              {mode === "dsl" ? t("rules.studio.dslDescription") : t("rules.studio.jsonDescription")}
            </CardDescription>
            <Tabs variant="underline" value={mode} onValueChange={(val) => void handleModeChange(val as RulesMode)}>
              <TabsList className="w-full justify-start">
                <TabsTrigger
                  value="dsl"
                  id="rules-mode-trigger-dsl"
                  aria-controls="rules-mode-content-dsl"
                  className="flex-none text-xs gap-1.5"
                >
                  <Sparkles className="h-3.5 w-3.5" />
                  {t("rules.studio.tabDsl")}
                </TabsTrigger>
                <TabsTrigger
                  value="json"
                  id="rules-mode-trigger-json"
                  aria-controls="rules-mode-content-json"
                  className="flex-none text-xs gap-1.5"
                >
                  <Braces className="h-3.5 w-3.5" />
                  {t("rules.studio.tabJson")}
                </TabsTrigger>
              </TabsList>
            </Tabs>
          </CardHeader>
          <CardContent className="p-0 flex-1 min-h-[460px]">
            <Tabs variant="underline" value={mode} onValueChange={(val) => void handleModeChange(val as RulesMode)}>
              <TabsContent
                value="dsl"
                id="rules-mode-content-dsl"
                aria-labelledby="rules-mode-trigger-dsl"
                forceMount
                className="m-0 p-4 space-y-3 data-[state=inactive]:hidden"
              >
                <div className="space-y-2">
                  <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                    <Sparkles className="h-3 w-3" />
                    {t("rules.studio.quickInsert")}
                  </div>
                  <div className="flex flex-wrap gap-2">
                    {RULE_DSL_TEMPLATES.map((template) => (
                      <Button
                        key={template.id}
                        type="button"
                        variant="outline"
                        size="sm"
                        className="h-7 text-[11px]"
                        onClick={() => handleTemplateClick(template)}
                      >
                        {t(template.labelKey)}
                      </Button>
                    ))}
                  </div>
                  {pendingTemplate && (
                    <div className="flex items-center justify-between gap-2 rounded-md border border-warning/40 bg-warning/10 px-3 py-2 text-xs">
                      <span>{t("rules.studio.replaceSelectionConfirm")}</span>
                      <div className="flex gap-2">
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          className="h-6 text-[11px]"
                          onClick={() => setPendingTemplate(null)}
                        >
                          {t("common.cancel")}
                        </Button>
                        <Button
                          type="button"
                          size="sm"
                          className="h-6 text-[11px]"
                          onClick={() =>
                            applyTemplate(pendingTemplate.template, pendingTemplate.start, pendingTemplate.end)
                          }
                        >
                          {t("rules.studio.replaceSelectionConfirmAction")}
                        </Button>
                      </div>
                    </div>
                  )}
                </div>

                <textarea
                  id="rules-dsl-editor"
                  dir="ltr"
                  ref={dslEditorRef}
                  aria-label={t("rules.studio.editorLabel")}
                  spellCheck={false}
                  value={dslSource}
                  onChange={(event) => {
                    setDslSource(event.target.value);
                    setSelection({
                      start: event.target.selectionStart,
                      end: event.target.selectionEnd,
                    });
                  }}
                  onSelect={(event) => {
                    const target = event.currentTarget;
                    setSelection({ start: target.selectionStart, end: target.selectionEnd });
                  }}
                  className="w-full h-[400px] resize-y rounded-md border border-input bg-surface p-3 font-mono text-xs leading-relaxed text-foreground shadow-2xs outline-none focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/30"
                  placeholder={t("rules.studio.editorPlaceholder")}
                />

                <div className="flex flex-wrap items-center gap-2">
                  {dslStatus === "valid" && (
                    <Badge className="gap-1.5 border-success/30 bg-success/15 text-success-700 dark:text-success-400">
                      <CheckCircle2 className="h-3.5 w-3.5" />
                      {t("rules.studio.valid")}
                    </Badge>
                  )}
                  {dslStatus === "checking" && (
                    <Badge variant="outline" className="font-mono text-[10px]">
                      {t("rules.studio.checking")}
                    </Badge>
                  )}
                  {dslStatus === "invalid" && compileError && (
                    <Badge variant="destructive" className="gap-1.5 font-mono text-[10px]">
                      <XCircle className="h-3.5 w-3.5" />
                      {t("rules.studio.invalid")}
                    </Badge>
                  )}
                </div>

                {compileError && (
                  <div role="alert" className="rounded-md border border-destructive/40 bg-destructive/10 p-3 text-xs">
                    <div className="flex items-center gap-2 font-semibold text-destructive">
                      <AlertTriangle className="h-3.5 w-3.5" />
                      {t("rules.studio.syntaxErrorTitle")}
                    </div>
                    <p className="mt-1.5 font-mono text-[11px]">
                      {t("rules.studio.errorAt", { line: compileError.line, column: compileError.column })}
                      {" — "}
                      {compileError.message}
                    </p>
                    {compileError.snippet.length > 0 && (
                      <pre className="mt-2 overflow-x-auto rounded bg-background/60 p-2 font-mono text-[11px] whitespace-pre">
                        {compileError.snippet}
                      </pre>
                    )}
                  </div>
                )}

                {diagnostics.length > 0 && (
                  <div role="status" className="rounded-md border border-warning/40 bg-warning/10 p-3 text-xs">
                    <p className="font-semibold text-warning-700 dark:text-warning-400">
                      {t("rules.studio.diagnostics")}
                    </p>
                    <ul className="mt-1.5 space-y-1 list-disc ps-5 font-mono text-[11px]">
                      {diagnostics.map((issue, index) => (
                        <li key={`${index}-${issue.message}`}>
                          {issue.message} ({t("rules.studio.errorAt", { line: issue.line, column: issue.column })})
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
              </TabsContent>

              <TabsContent
                value="json"
                id="rules-mode-content-json"
                aria-labelledby="rules-mode-trigger-json"
                forceMount
                className="m-0 p-4 space-y-3 data-[state=inactive]:hidden"
              >
                <CodeEditor
                  value={rulesJson}
                  onChange={(value) => setRulesJson(value)}
                  language="json"
                  label={t("rules.studio.jsonEditorLabel")}
                  className="h-[400px] min-h-[400px]"
                />
                {decompileError && (
                  <div role="alert" className="rounded-md border border-destructive/40 bg-destructive/10 p-3 text-xs text-destructive">
                    <p className="font-semibold">{t("rules.studio.decompileFailed")}</p>
                    <p className="mt-1 font-mono text-[11px]">{decompileError}</p>
                  </div>
                )}
              </TabsContent>
            </Tabs>
          </CardContent>
        </Card>

        <div className="space-y-6">
          <Card>
            <CardHeader className="pb-3 border-b bg-card">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <Terminal className="h-4 w-4 text-primary" />
                  <CardTitle className="text-sm font-semibold">{t("rules.simulator")}</CardTitle>
                </div>
                <Badge variant="outline" className="font-mono text-[10px]">{t("rules.dryRun")}</Badge>
              </div>
              <CardDescription className="text-xs">
                {t("rules.simulatorDescription")}
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4 pt-4">
              <div className="flex flex-wrap items-center gap-2 border-b pb-3">
                <Label htmlFor="rulesQuickCollections" className="text-[11px] text-muted-foreground">
                  {t("rules.quickCollections")}
                </Label>
                <Select
                  value=""
                  onValueChange={(name) =>
                    setPath(`/${name}/${authUid.trim() || "usr_123"}`)
                  }
                >
                  <SelectTrigger id="rulesQuickCollections" className="h-8 w-56 max-w-full text-xs">
                    <SelectValue placeholder={t("common.collections")} />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectGroup>
                      <SelectLabel>{t("rules.quickCollections")}</SelectLabel>
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

              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-1.5">
                  <Label htmlFor="simOp" className="text-xs">{t("rules.operation")}</Label>
                  <Select value={operation} onValueChange={(val) => setOperation(val as AllowOperation)}>
                    <SelectTrigger id="simOp" className="h-9 font-mono text-xs">
                      <SelectValue placeholder={t("rules.selectOperation")} />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="get" className="font-mono text-xs">get</SelectItem>
                      <SelectItem value="list" className="font-mono text-xs">list</SelectItem>
                      <SelectItem value="create" className="font-mono text-xs">create</SelectItem>
                      <SelectItem value="update" className="font-mono text-xs">update</SelectItem>
                      <SelectItem value="delete" className="font-mono text-xs">delete</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="simPath" className="text-xs">{t("rules.path")}</Label>
                  <Input
                    id="simPath"
                    value={path}
                    onChange={(e) => setPath(e.target.value)}
                    className="h-9 font-mono text-xs"
                    placeholder="/users/usr_123"
                  />
                </div>
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="simAuthMode" className="text-xs">{t("rules.studio.simulateAuth")}</Label>
                <Select value={authMode} onValueChange={(val) => setAuthMode(val as AuthMode)}>
                  <SelectTrigger id="simAuthMode" className="h-9 text-xs">
                    <SelectValue placeholder={t("rules.studio.simulateAuth")} />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="unauthenticated" className="text-xs">
                      {t("rules.studio.unauthenticated")}
                    </SelectItem>
                    <SelectItem value="authenticated" className="text-xs">
                      {t("rules.studio.authenticated")}
                    </SelectItem>
                  </SelectContent>
                </Select>
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="authUid" className="text-xs">{t("rules.studio.authUid")}</Label>
                <Input
                  id="authUid"
                  value={authUid}
                  onChange={(e) => setAuthUid(e.target.value)}
                  disabled={authMode === "unauthenticated"}
                  className="h-9 font-mono text-xs disabled:opacity-50"
                  placeholder="usr_123"
                />
              </div>

              <div className="grid gap-4 sm:grid-cols-3">
                <div className="space-y-1.5">
                  <Label htmlFor="simClaims" className="text-xs">{t("rules.studio.customClaims")}</Label>
                  <textarea
                    id="simClaims"
                  dir="ltr"
                    spellCheck={false}
                    value={claimsJson}
                    onChange={(e) => setClaimsJson(e.target.value)}
                    disabled={authMode === "unauthenticated"}
                    className="h-24 w-full resize-y rounded-md border border-input bg-surface p-2 font-mono text-[11px] disabled:opacity-50"
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="simResource" className="text-xs">{t("rules.studio.resourceData")}</Label>
                  <textarea
                    id="simResource"
                  dir="ltr"
                    spellCheck={false}
                    value={resourceJson}
                    onChange={(e) => setResourceJson(e.target.value)}
                    className="h-24 w-full resize-y rounded-md border border-input bg-surface p-2 font-mono text-[11px]"
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="simIncoming" className="text-xs">{t("rules.studio.incomingData")}</Label>
                  <textarea
                    id="simIncoming"
                  dir="ltr"
                    spellCheck={false}
                    value={incomingJson}
                    onChange={(e) => setIncomingJson(e.target.value)}
                    className="h-24 w-full resize-y rounded-md border border-input bg-surface p-2 font-mono text-[11px]"
                  />
                </div>
              </div>

              <Button onClick={() => void handleSimulate()} disabled={simulating} className="w-full gap-2 mt-2">
                <Play className="h-3.5 w-3.5 fill-current" />
                {simulating ? t("rules.studio.simulating") : t("rules.simulate")}
              </Button>

              <div className="flex items-start gap-2 rounded-md border bg-muted/40 p-2.5 text-[11px] text-muted-foreground">
                <ShieldCheck className="mt-0.5 h-3.5 w-3.5 shrink-0 text-success" />
                <div>
                  <span className="font-semibold">{t("rules.invariantLabel")}: </span>
                  <span className="font-mono">{t("rules.invariantValue")}</span>
                </div>
              </div>
            </CardContent>
          </Card>

          {simulationResult && (
            <Card className="border">
              <CardHeader className="pb-3 border-b bg-card">
                <div className="flex items-center justify-between">
                  <CardTitle className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                    {t("rules.result")}
                  </CardTitle>
                  <Badge
                    className={
                      simulationResult.allowed
                        ? "gap-1.5 border-success/30 bg-success/15 font-mono text-xs px-2.5 py-0.5 text-success-700 dark:text-success-400"
                        : "gap-1.5 border-destructive/30 bg-destructive/15 font-mono text-xs px-2.5 py-0.5 text-destructive"
                    }
                  >
                    {simulationResult.allowed ? (
                      <><CheckCircle2 className="h-3.5 w-3.5" /><span>{t("rules.studio.allowed")}</span></>
                    ) : (
                      <><XCircle className="h-3.5 w-3.5" /><span>{t("rules.studio.denied")}</span></>
                    )}
                  </Badge>
                </div>
              </CardHeader>
              <CardContent className="space-y-3 pt-4 text-xs font-mono">
                <KeyValueRow
                  label={t("rules.matchedRule")}
                  value={<span className="font-mono font-semibold">{simulationResult.matchedRule ?? "—"}</span>}
                />
                <KeyValueRow
                  label={t("rules.invariantLabel")}
                  value={<span className="font-mono text-xs text-success-600 dark:text-success-400">{t("rules.invariantValue")}</span>}
                />
                <div className="space-y-1.5">
                  <p className="text-[10px] uppercase tracking-wider text-muted-foreground">
                    {t("rules.studio.evaluationTrace")}
                  </p>
                  <ol className="space-y-1 rounded-md border bg-muted/30 p-2.5">
                    {simulationResult.evaluationTrace.length === 0 ? (
                      <li className="text-[11px] text-muted-foreground">{t("rules.studio.traceEmpty")}</li>
                    ) : (
                      simulationResult.evaluationTrace.map((lineText, index) => (
                        <li key={`${index}-${lineText}`} className="flex gap-2 text-[11px] leading-relaxed">
                          <span className="shrink-0 text-muted-foreground">{index + 1}.</span>
                          <span className="break-words">{lineText}</span>
                        </li>
                      ))
                    )}
                  </ol>
                </div>
              </CardContent>
            </Card>
          )}
        </div>
      </div>
    </PageContent>
  );
}
