/**
 * @vellum/core - Query Index Coverage Advisor
 *
 * Pure, deterministic, zero-dependency implementation of §2.7 of
 * `docs/V2-ENGINE-CONTRACT.md`. It classifies a query into the canonical
 * Equality → Sort → Range (ESR) sequence, decides whether an existing ready
 * composite index covers that sequence (exact or full reverse scan), and —
 * when it does not — produces a deterministic fingerprint, a base64url
 * deep-link payload and the dashboard URL for one-click index creation.
 *
 * No I/O, no mutable global state, no `eval`/`new Function`. Only `node:crypto`
 * is used (SHA-256), which is permitted by the contract.
 */

import crypto from "node:crypto";

/** Canonical index field direction (kept local so this module stays self-contained). */
export type IndexAdvisorDirection = "asc" | "desc";

/** An existing composite index as supplied by the data plane. */
export interface IndexAdvisorIndex {
  collectionPath: string;
  fields: Array<{ path: string; dir: IndexAdvisorDirection }>;
  /** Only `"ready"` (or a missing status) counts as covering. */
  status?: string;
}

/** Decoded, validated form of the `?suggest=` deep-link payload. */
export interface IndexSuggestionPayload {
  orgId: string;
  projectId: string;
  collectionPath: string;
  fields: Array<{ path: string; dir: IndexAdvisorDirection }>;
  fingerprint: string;
  reason: string;
}

/** Result of `analyzeQueryIndexCoverage`. */
export interface IndexCoverageResult {
  covered: boolean;
  collectionPath: string;
  reason: string;
  /** E, sorted alphabetically. */
  equalityFields: string[];
  /** S, in exact query order. */
  sortFields: string[];
  /** R, deduped and sorted alphabetically. */
  rangeFields: string[];
  recommendedFields?: Array<{ path: string; dir: IndexAdvisorDirection }>;
  fingerprint?: string;
  suggestPayload?: string;
  dashboardUrl?: string;
}

/** Query shape accepted by the advisor (a structural subset of NormalizedQuery). */
export interface IndexAdvisorQuery {
  collectionPath: string;
  where: Array<{ field: string; op: string; value?: unknown }>;
  orderBy: Array<{ field: string; dir: IndexAdvisorDirection }>;
}

/** Options for `analyzeQueryIndexCoverage`. */
export interface IndexAdvisorOptions {
  projectId: string;
  orgId: string;
  dashboardBaseUrl: string;
}

type IndexField = { path: string; dir: IndexAdvisorDirection };

const EQUALITY_OPS = new Set<string>(["==", "in", "array-contains", "array-contains-any"]);
const RANGE_OPS = new Set<string>(["<", "<=", ">", ">=", "!=", "not-in", "starts_with_ci"]);

/** Fields with an automatic single-field index in the engine. */
const SINGLE_FIELD_SYSTEM_PATHS = new Set<string>([
  "_id",
  "documentId",
  "__name__",
  "createdAt",
  "updatedAt",
]);

/** 8 KiB hard cap for deep-link payloads (encoded and decoded). */
const MAX_SUGGEST_PAYLOAD_BYTES = 8 * 1024;
/** Defensive bound on the number of fields in a decoded suggestion. */
const MAX_DECODED_FIELDS = 64;

function normalizeDir(value: unknown): IndexAdvisorDirection {
  return typeof value === "string" && value.toLowerCase() === "desc" ? "desc" : "asc";
}

function sameField(a: IndexField, b: IndexField): boolean {
  return a.path === b.path && a.dir === b.dir;
}

/** Prefix match: `indexFields` must start with the full canonical sequence. */
function startsWithSequence(indexFields: IndexField[], canonical: IndexField[]): boolean {
  if (indexFields.length < canonical.length) return false;
  for (let i = 0; i < canonical.length; i += 1) {
    const indexField = indexFields[i];
    const wanted = canonical[i];
    if (!indexField || !wanted || !sameField(indexField, wanted)) return false;
  }
  return true;
}

function invertedFields(fields: IndexField[]): IndexField[] {
  return fields.map((field) => ({
    path: field.path,
    dir: field.dir === "asc" ? "desc" : "asc",
  }));
}

function humanReason(
  equality: string[],
  sort: string[],
  range: string[],
  sortDirs: Map<string, IndexAdvisorDirection>,
  allFields: string[]
): string {
  const parts: string[] = [];
  if (equality.length > 0) parts.push(`equality filter on [${equality.join(", ")}]`);
  if (sort.length > 0) {
    parts.push(
      `sort on [${sort.map((field) => `${field} ${normalizeDir(sortDirs.get(field)).toUpperCase()}`).join(", ")}]`
    );
  }
  if (range.length > 0) parts.push(`range filter on [${range.join(", ")}]`);
  if (parts.length === 0) {
    parts.push(`indexed predicates on [${Array.from(allFields).sort().join(", ")}]`);
  }
  return `Composite index needed for ${parts.join(" + ")}`;
}

/**
 * Classifies the query, checks ready composite indexes and returns either a
 * `covered` result or a deterministic, one-click index suggestion.
 */
export function analyzeQueryIndexCoverage(
  query: IndexAdvisorQuery,
  existingIndexes: IndexAdvisorIndex[],
  options: IndexAdvisorOptions
): IndexCoverageResult {
  const collectionPath = query.collectionPath;
  const whereClauses = Array.isArray(query.where) ? query.where : [];
  const orderByClauses = Array.isArray(query.orderBy) ? query.orderBy : [];

  const allFields = new Set<string>();
  const equalitySet = new Set<string>();
  const rangeRaw: string[] = [];

  for (const clause of whereClauses) {
    if (!clause || typeof clause.field !== "string" || clause.field.length === 0) continue;
    const field = clause.field;
    allFields.add(field);
    const op = String(clause.op);
    if (EQUALITY_OPS.has(op)) {
      equalitySet.add(field);
    } else if (RANGE_OPS.has(op)) {
      rangeRaw.push(field);
    }
    // Unrecognised V2 ops (contains_ci, text_search, ...) are intentionally not
    // classified into E/S/R, but still count toward the conservative field count.
  }

  const equalityFields = Array.from(equalitySet).sort();
  const equalityLookup = new Set(equalityFields);

  const sortFields: string[] = [];
  const sortLookup = new Set<string>();
  const sortDirs = new Map<string, IndexAdvisorDirection>();
  for (const clause of orderByClauses) {
    if (!clause || typeof clause.field !== "string" || clause.field.length === 0) continue;
    const field = clause.field;
    // The engine appends documentId as a tie-breaker to every ordering. It never needs its own index entry.
    if (field === "documentId" || field === "__name__") continue;
    allFields.add(field);
    if (equalityLookup.has(field) || sortLookup.has(field)) continue;
    sortLookup.add(field);
    sortFields.push(field);
    sortDirs.set(field, normalizeDir(clause.dir));
  }

  const rangeFields = Array.from(new Set(rangeRaw))
    .filter((field) => !equalityLookup.has(field) && !sortLookup.has(field))
    .sort();

  let canonical: IndexField[] = [
    ...equalityFields.map((path): IndexField => ({ path, dir: "asc" })),
    ...sortFields.map((path): IndexField => ({ path, dir: sortDirs.get(path) ?? "asc" })),
    ...rangeFields.map((path): IndexField => ({ path, dir: "asc" })),
  ];
  // Degenerate guard: multiple distinct fields with only unclassified ops.
  if (canonical.length === 0 && allFields.size > 1) {
    canonical = Array.from(allFields)
      .sort()
      .map((path): IndexField => ({ path, dir: "asc" }));
  }

  let covered = false;
  let reason = "";

  // Single-field fast path. Queries touching at most one distinct field are
  // served by the engine's automatic single-field indexes.
  if (allFields.size <= 1) {
    covered = true;
    const onlyField = Array.from(allFields)[0];
    if (onlyField === undefined) {
      reason = "No indexed predicates require a composite index (unfiltered query)";
    } else if (SINGLE_FIELD_SYSTEM_PATHS.has(onlyField)) {
      reason = `Single-field predicate on [${onlyField}] is served by the built-in single-field index`;
    } else {
      reason = `Single-field predicate on [${onlyField}] is served by an automatic single-field index; no composite index required`;
    }
  }

  if (!covered) {
    for (const index of existingIndexes) {
      if (!index || index.collectionPath !== collectionPath) continue;
      if (index.status !== undefined && index.status !== "ready") continue;
      const indexFields: IndexField[] = Array.isArray(index.fields)
        ? index.fields.map((field) => ({
            path: typeof field?.path === "string" ? field.path : "",
            dir: normalizeDir(field?.dir),
          }))
        : [];
      const exact = startsWithSequence(indexFields, canonical);
      const reversed = startsWithSequence(invertedFields(indexFields), canonical);
      if (exact || reversed) {
        covered = true;
        reason = `Existing composite index on [${indexFields.map((f) => `${f.path} ${f.dir.toUpperCase()}`).join(", ")}] covers the E/S/R prefix${reversed && !exact ? " via a full reverse scan" : ""}`;
        break;
      }
    }
  }

  const result: IndexCoverageResult = {
    covered,
    collectionPath,
    reason,
    equalityFields,
    sortFields,
    rangeFields,
  };

  if (covered) return result;

  reason = humanReason(equalityFields, sortFields, rangeFields, sortDirs, Array.from(allFields));
  result.reason = reason;

  const fingerprint = crypto
    .createHash("sha256")
    .update(`${options.projectId}:${collectionPath}:${JSON.stringify(canonical)}`, "utf8")
    .digest("hex");

  const payload: IndexSuggestionPayload = {
    orgId: options.orgId,
    projectId: options.projectId,
    collectionPath,
    fields: canonical,
    fingerprint,
    reason,
  };
  const suggestPayload = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  const base = options.dashboardBaseUrl.replace(/\/+$/, "");
  // No configured dashboard origin: give the payload but no link (a relative or localhost link helps nobody).
  const dashboardUrl =
    base === ""
      ? undefined
      : `${base}/app/orgs/${options.orgId}/projects/${options.projectId}/indexes?suggest=${suggestPayload}`;

  result.recommendedFields = canonical;
  result.fingerprint = fingerprint;
  result.suggestPayload = suggestPayload;
  if (dashboardUrl !== undefined) result.dashboardUrl = dashboardUrl;
  return result;
}

/**
 * Validates and decodes a `?suggest=` base64url payload. Returns `null` for
 * malformed, oversized (> 8 KiB) or structurally invalid input.
 */
export function decodeSuggestPayload(payload: string): IndexSuggestionPayload | null {
  if (typeof payload !== "string" || payload.length === 0) return null;
  if (Buffer.byteLength(payload, "utf8") > MAX_SUGGEST_PAYLOAD_BYTES) return null;

  let json: string;
  try {
    json = Buffer.from(payload, "base64url").toString("utf8");
  } catch {
    return null;
  }
  if (Buffer.byteLength(json, "utf8") > MAX_SUGGEST_PAYLOAD_BYTES) return null;

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
  const fields: IndexField[] = [];
  for (const item of rawFields) {
    if (!item || typeof item !== "object" || Array.isArray(item)) return null;
    const fieldObj = item as Record<string, unknown>;
    if (typeof fieldObj["path"] !== "string" || fieldObj["path"].length === 0) return null;
    if (fieldObj["dir"] !== "asc" && fieldObj["dir"] !== "desc") return null;
    fields.push({ path: fieldObj["path"], dir: fieldObj["dir"] });
  }

  const decoded: IndexSuggestionPayload = {
    orgId,
    projectId,
    collectionPath,
    fields,
    fingerprint,
    reason: obj["reason"],
  };
  return decoded;
}

/**
 * Response headers for the API layer (§4 of the contract). When the query is
 * uncovered the suggestion is exposed as a JSON string plus the one-click URL;
 * covered queries yield no headers.
 */
export function buildIndexSuggestionHeaders(
  result: IndexCoverageResult
): Record<string, string> {
  if (result.covered || !result.suggestPayload) return {};
  const payload = decodeSuggestPayload(result.suggestPayload);
  return {
    "x-vellum-index-suggestion": payload ? JSON.stringify(payload) : result.suggestPayload,
    ...(result.dashboardUrl ? { "x-vellum-index-url": result.dashboardUrl } : {}),
  };
}
