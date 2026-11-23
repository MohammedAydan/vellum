/**
 * @vellum/document-engine - Relation / `$ref` include resolution.
 *
 * Design notes (V2 1C / Phase 3A hardening):
 * - `resolveIncludes` collects every referenced path across ALL parent docs at a
 *   given depth, dedupes/sorts them, and performs exactly ONE logical batch
 *   fetch per depth. With `getDocumentBatch` supplied (the production path),
 *   that is one `getDocumentBatch(paths)` call → one `tx.batchGetDocuments`
 *   round trip when the storage adapter supports it. The fallback for test
 *   doubles that only expose `getDocument` is wrapped in `Promise.all`, still
 *   counted as one logical batch.
 * - Cycle protection uses `visitedPaths`: paths expanded at a shallower (or
 *   equal) depth are never expanded again; instead a minimal
 *   `{ _ref: path, _circular: true }` stub is attached in reference order.
 *   Hard cap `MAX_RELATION_DEPTH = 3`.
 * - Security: every resolved target goes through the caller-supplied `canRead`
 *   (the engine closes over `authorizeOperation(..., operation: "get")`).
 *   Denied targets are attached as `null` and recorded in `redactedFields` /
 *   `_redactedRefs`; their exact target paths are recorded in
 *   `_redactedRefPaths`. They never leak data and never throw.
 * - Fan-out is bounded at every depth (`MAX_INCLUDES`) and cumulatively across
 *   all depths (`MAX_INCLUDED_TARGETS_PER_PAGE`, `INCLUDE_BUDGET_BYTES`).
 *   Exceeding a bound throws `RESPONSE_TOO_LARGE` — never silent truncation.
 */

import { VellumError, getFieldByPath, parseDocumentPath } from "@vellum/core";
import { assertSafeFieldKey, FORBIDDEN_FIELD_KEYS, setPath } from "./path-utils.js";

/** A relation include specification (max nesting depth = 3). */
export interface IncludeSpec {
  /** Field on the parent holding the reference (dot paths supported). */
  field: string;
  /** Target collection; if absent, inferred from the `$ref` string or field name. */
  collection?: string | undefined;
  /** Attach under this key. When given, also attached to `doc.data[as]`. */
  as?: string | undefined;
  /** Dot-path projection applied on the resolved target. */
  select?: string[] | undefined;
  /** Nested includes (max depth 3). */
  include?: IncludeSpec[] | undefined;
  /** Referential-integrity metadata consumed by `batchWrite`. */
  onDelete?: "cascade" | "set_null" | "restrict" | undefined;
}

/** Hard cap for relation expansion (and cascade recursion). */
export const MAX_RELATION_DEPTH = 3;

/** Max include specs allowed at any single depth. */
export const MAX_INCLUDES = 10;

/** Max cumulative resolved include targets across all depths of one page. */
export const MAX_INCLUDED_TARGETS_PER_PAGE = 1000;

/** Max cumulative serialized bytes of resolved include targets across all depths. */
export const INCLUDE_BUDGET_BYTES = 1_048_576;

/** Pre-fetch ceiling on unique paths queried at a single depth (blocks DB fan-out DoS). */
const MAX_FETCH_PATHS_PER_DEPTH = MAX_INCLUDED_TARGETS_PER_PAGE * 2;

/** Minimal shape `resolveIncludes` needs from a document. */
export interface RelationDocument {
  path: string;
  data: Record<string, unknown>;
}

export type EnrichedRelationDocument<
  Doc extends { data: Record<string, unknown> } = RelationDocument,
> = Doc & {
  _included?: Record<string, unknown>;
  _redactedRefs?: string[];
  /** Exact target paths that were denied by Security Rules `get`. */
  _redactedRefPaths?: string[];
};

type Resolvable<Doc extends { data: Record<string, unknown> }> = EnrichedRelationDocument<Doc>;

/** Minimal stub emitted instead of re-expanding an already-visited path. */
interface CircularStub {
  _ref: string;
  _circular: true;
}

/** A single entry in a binding's resolved-value list, in reference order. */
type ResolvedEntry<Doc> =
  | { readonly kind: "doc"; readonly path: string; readonly doc: Doc }
  | { readonly kind: "stub"; readonly path: string; readonly stub: CircularStub };

/** Mutable budget counters shared by every depth of one `resolveIncludes` call. */
interface IncludeBudgetContext {
  includedTargets: number;
  includedBytes: number;
}

export interface IncludeResolutionResult<Doc extends { data: Record<string, unknown> }> {
  docs: EnrichedRelationDocument<Doc>[];
  /** Attachment keys whose target was denied by Security Rules. */
  redactedFields: string[];
  /** Exact target paths denied by Security Rules at any depth (deduped). */
  redactedRefPaths: string[];
  /** Paths actually fetched at any depth (deduped). */
  fetchedPaths: string[];
  /** Number of logical batch fetches issued (exactly one per depth). */
  batchCallCount: number;
  /** Cumulative serialized bytes of resolved targets across all depths. */
  includedBytes: number;
  /** Cumulative count of resolved targets across all depths. */
  includedTargets: number;
}

export interface ResolveIncludesParams<Doc extends { data: Record<string, unknown> }> {
  docs: Doc[];
  includes: IncludeSpec[];
  depth?: number | undefined;
  visitedPaths?: Set<string> | undefined;
  /** Single-path getter (used when `getDocumentBatch` is absent). */
  getDocument: (path: string) => Promise<Doc | null>;
  /** Logical batch getter — called exactly ONCE per depth when supplied. */
  getDocumentBatch?: ((paths: string[]) => Promise<Doc[]>) | undefined;
  /** Caller-supplied Security Rules `get` check. Must never leak or throw on deny. */
  canRead: (doc: Doc) => boolean;
  /** Optional dot-path projector; defaults to `projectIncludedDoc`. */
  selectProjector?: ((doc: Doc, select: string[] | null) => Doc) | undefined;
  /**
   * @internal Shared, mutable cross-depth budget counters. Supplied by the
   * recursion itself; callers never need to provide this.
   */
  _budget?: IncludeBudgetContext | undefined;
}

export interface RelationBatchStats {
  batchCallCount: number;
  fetchedPaths: string[];
}

export interface BatchedRelationResolver<Doc extends { data: Record<string, unknown> }> {
  /** Single-path callback compatible with `ResolveIncludesParams.getDocument`. */
  getDocument(path: string): Promise<Doc | null>;
  /** Batched callback compatible with `ResolveIncludesParams.getDocumentBatch`. */
  getDocumentBatch(paths: string[]): Promise<Doc[]>;
  getStats(): RelationBatchStats;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Returns true if any dot-separated segment is a prototype-pollution gadget. */
function hasForbiddenSegment(fieldPath: string): boolean {
  if (fieldPath.includes("\u0000")) return true;
  const parts = fieldPath.split(".");
  for (let i = 0; i < parts.length; i += 1) {
    if (FORBIDDEN_FIELD_KEYS.has(parts[i]!)) return true;
  }
  return false;
}

/**
 * Irregular plural forms checked before any generic suffix rule. Keys are the
 * lower-cased base field name after suffix stripping.
 */
const IRREGULAR_PLURALS: Readonly<Record<string, string>> = {
  child: "children",
  person: "people",
  address: "addresses",
  status: "statuses",
  category: "categories",
  company: "companies",
  entry: "entries",
};

/** "authorId" -> "authors", "owner_ref" -> "owners", "child" -> "children". */
function inferCollectionFromField(field: string): string {
  if (field.length > 256) return "documents";
  const base = field.replace(/[_-]?(ids?|refs?|keys?)$/i, "").trim();
  if (base.length === 0) return "documents";

  const irregular = IRREGULAR_PLURALS[base.toLowerCase()];
  if (irregular !== undefined) return irregular;

  if (/y$/i.test(base)) return `${base.slice(0, -1)}ies`;
  // Plain plural `s` must stay unchanged: check it before the `es` suffix rule
  // so "books" stays "books" while "box"/"buzz"/"watch"/"wish" get "es".
  if (/s$/i.test(base)) return base;
  if (/(s|x|z|ch|sh)$/i.test(base)) return `${base}es`;
  return `${base}s`;
}

/**
 * Parses a reference value into a canonical document path.
 * Accepts `{ $ref: "users/u1" }`, tagged `{ $t: "ref", $v: "users/u1" }`,
 * plain `"users/u1"` strings, and bare ids (`"u1"`) when a collection can be
 * resolved from the spec or inferred from the parent field name.
 */
export function parseReference(value: unknown, spec: IncludeSpec): string | null {
  let raw: string | null = null;
  if (typeof value === "string") {
    raw = value;
  } else if (isPlainObject(value)) {
    const taggedRef = Object.prototype.hasOwnProperty.call(value, "$ref") ? value["$ref"] : undefined;
    if (typeof taggedRef === "string") raw = taggedRef;
    else if (
      Object.prototype.hasOwnProperty.call(value, "$t") &&
      value["$t"] === "ref" &&
      typeof value["$v"] === "string"
    ) {
      raw = value["$v"];
    }
  }
  if (raw === null) return null;
  const trimmed = raw.trim();
  if (trimmed.length === 0 || trimmed.length > 2048) return null;

  let path = trimmed;
  if (!trimmed.includes("/")) {
    const collection = spec.collection ?? inferCollectionFromField(spec.field);
    if (collection.length === 0) return null;
    path = `${collection.replace(/\/$/, "")}/${trimmed}`;
  }

  try {
    return parseDocumentPath(path).path;
  } catch {
    return null;
  }
}

/**
 * Creates a batched relation getter. `getDocumentBatch` is invoked once per
 * unique set of paths; results are cached by path so repeated references at a
 * deeper level never issue redundant fetches. `batchCallCount` counts logical
 * batch invocations (not individual documents). Lookups are O(1) via a
 * `Map<string, Doc>` keyed by path, and fetched paths are tracked in a Set.
 */
export function createBatchedRelationResolver<Doc extends { data: Record<string, unknown> }>(params: {
  getDocumentBatch: (paths: string[]) => Promise<Doc[]>;
  canRead?: ((doc: Doc) => boolean) | undefined;
  selectProjector?: ((doc: Doc, select: string[] | null) => Doc) | undefined;
}): BatchedRelationResolver<Doc> {
  let batchCallCount = 0;
  const fetchedPaths = new Set<string>();
  const cache = new Map<string, Doc | null>();

  const getDocumentBatch = async (paths: string[]): Promise<Doc[]> => {
    const uniqueSet = new Set<string>();
    for (let i = 0; i < paths.length; i += 1) {
      const p = paths[i];
      if (typeof p === "string" && p.length > 0) uniqueSet.add(p);
    }
    const unique = Array.from(uniqueSet).sort();
    if (unique.length === 0) return [];
    const missing: string[] = [];
    for (let i = 0; i < unique.length; i += 1) {
      const p = unique[i]!;
      if (!cache.has(p)) missing.push(p);
    }
    if (missing.length > 0) {
      batchCallCount += 1;
      const rows = await params.getDocumentBatch(missing);
      const rowsByPath = new Map<string, Doc>();
      for (const row of rows) {
        const p = (row as { path?: unknown }).path;
        if (typeof p === "string") rowsByPath.set(p, row);
      }
      for (const path of missing) {
        const row = rowsByPath.get(path) ?? null;
        cache.set(path, row);
        if (row !== null) fetchedPaths.add(path);
      }
    }
    const resolved: Doc[] = [];
    for (let i = 0; i < unique.length; i += 1) {
      const doc = cache.get(unique[i]!);
      if (doc !== null && doc !== undefined) resolved.push(doc);
    }
    return resolved;
  };

  const getDocument = async (path: string): Promise<Doc | null> => {
    const docs = await getDocumentBatch([path]);
    const doc = docs[0] ?? null;
    if (doc === null) return null;
    // Standalone use of the single-path callback enforces the same read check.
    if (params.canRead && !params.canRead(doc)) return null;
    return params.selectProjector ? params.selectProjector(doc, null) : doc;
  };

  return {
    getDocument,
    getDocumentBatch,
    getStats: (): RelationBatchStats => ({ batchCallCount, fetchedPaths: Array.from(fetchedPaths) }),
  };
}

/**
 * Default dot-path projector. Each select segment is validated by `setPath`
 * (via `assertSafeFieldKey`), nested paths rebuild nested objects, and
 * `_included` / `_redactedRefs` / `_redactedRefPaths` survive the object spread.
 */
export function projectIncludedDoc<Doc extends { data: Record<string, unknown> }>(
  doc: Doc,
  select: string[] | null
): Doc {
  if (!Array.isArray(select) || select.length === 0) return doc;
  const projected: Record<string, unknown> = {};
  for (const field of select) {
    if (typeof field !== "string" || field.length === 0) continue;
    const value = getFieldByPath(doc.data, field);
    if (value !== undefined) setPath(projected, field, structuredClone(value));
  }
  return { ...doc, data: projected } as Doc;
}

function markResolvable<Doc extends { data: Record<string, unknown> }>(doc: Doc): Resolvable<Doc> {
  const result = doc as Resolvable<Doc>;
  if (!result._included) result._included = {};
  return result;
}

function defineSafeProp(obj: Record<string, unknown>, key: string, value: unknown): void {
  assertSafeFieldKey(key);
  Object.defineProperty(obj, key, {
    value,
    writable: true,
    enumerable: true,
    configurable: true,
  });
}

function attach<Doc extends { data: Record<string, unknown> }>(
  doc: Doc,
  spec: IncludeSpec,
  alias: string,
  value: unknown
): void {
  const target = markResolvable(doc);
  defineSafeProp(target._included!, alias, value);
  if (spec.as !== undefined && spec.as.length > 0) {
    defineSafeProp(target.data, spec.as, value);
  }
}

function recordRedaction<Doc extends { data: Record<string, unknown> }>(doc: Doc, alias: string): void {
  const target = doc as Resolvable<Doc>;
  if (!target._redactedRefs) target._redactedRefs = [];
  if (!target._redactedRefs.includes(alias)) target._redactedRefs.push(alias);
}

/** Records the exact target path denied by Security Rules on the parent doc. */
function recordRedactionPath<Doc extends { data: Record<string, unknown> }>(doc: Doc, path: string): void {
  const target = doc as Resolvable<Doc>;
  if (!target._redactedRefPaths) target._redactedRefPaths = [];
  if (!target._redactedRefPaths.includes(path)) target._redactedRefPaths.push(path);
}

interface ReferenceBinding<Doc> {
  doc: Doc;
  spec: IncludeSpec;
  alias: string;
  isArray: boolean;
  refs: string[];
  /** Populated in Phase 3 in reference order; attached (projected) in Phase 5. */
  resolved: ResolvedEntry<Doc>[];
}

/**
 * Resolves all include specs for a page of parent documents.
 *
 * Exactly ONE logical batch fetch is issued per depth, regardless of how many
 * parents or references exist at that depth. Nested includes recurse with an
 * incremented depth (capped at `MAX_RELATION_DEPTH`); `visitedPaths` prevents
 * cycles by emitting a minimal stub for a path already expanded at a shallower
 * depth. Include specs per depth, resolved target count and serialized bytes
 * are bounded; violations throw instead of silently truncating.
 */
export async function resolveIncludes<Doc extends { data: Record<string, unknown> }>(
  params: ResolveIncludesParams<Doc>
): Promise<IncludeResolutionResult<Doc>> {
  const rawDepth = params.depth ?? 1;
  const depth = Number.isInteger(rawDepth) && rawDepth >= 1 ? rawDepth : 1;
  const docs = params.docs;
  const specs = params.includes;
  const budget: IncludeBudgetContext = params._budget ?? { includedTargets: 0, includedBytes: 0 };
  const redactedFieldSet = new Set<string>();
  const redactedRefPathSet = new Set<string>();
  const fetchedPathSet = new Set<string>();
  let batchCallCount = 0;

  // Enforced at EVERY depth (this function is re-entered by the recursion).
  if (Array.isArray(specs) && specs.length > MAX_INCLUDES) {
    throw new VellumError(
      "INVALID_ARGUMENT",
      `Include count ${specs.length} exceeds the maximum of ${MAX_INCLUDES} at depth ${depth}`,
      { count: specs.length, max: MAX_INCLUDES, depth }
    );
  }

  const visited = new Set<string>(params.visitedPaths ?? []);
  for (const doc of docs) {
    const p = (doc as { path?: unknown }).path;
    if (typeof p === "string") visited.add(p);
  }

  if (
    docs.length === 0 ||
    !Array.isArray(specs) ||
    specs.length === 0 ||
    depth > MAX_RELATION_DEPTH
  ) {
    return {
      docs,
      redactedFields: [],
      redactedRefPaths: [],
      fetchedPaths: [],
      batchCallCount,
      includedBytes: budget.includedBytes,
      includedTargets: budget.includedTargets,
    };
  }

  // Validate attachment aliases upfront so a gadget `as` (e.g. "__proto__") is
  // rejected before any DB fetch or object mutation occurs.
  for (const spec of specs) {
    if (!spec || typeof spec.field !== "string" || spec.field.length === 0) continue;
    const alias = spec.as && spec.as.length > 0 ? spec.as : spec.field;
    assertSafeFieldKey(alias);
    if (spec.as !== undefined && spec.as.length > 0) {
      assertSafeFieldKey(spec.as);
    }
  }

  // Phase 1: collect EVERY referenced path across ALL parents at this depth.
  const bindings: Array<ReferenceBinding<Doc>> = [];
  const uniquePaths: string[] = [];
  const seenPaths = new Set<string>();

  for (const doc of docs) {
    for (const spec of specs) {
      if (!spec || typeof spec.field !== "string" || spec.field.length === 0) continue;
      const alias = spec.as && spec.as.length > 0 ? spec.as : spec.field;
      // Never traverse prototype-gadget field paths when reading from `doc.data`.
      const raw = hasForbiddenSegment(spec.field) ? undefined : getFieldByPath(doc.data, spec.field);
      const isArray = Array.isArray(raw);
      const values: unknown[] = isArray ? raw : [raw];
      const refs: string[] = [];
      for (const value of values) {
        const path = parseReference(value, spec);
        if (path !== null) {
          refs.push(path);
          if (!visited.has(path) && !seenPaths.has(path)) {
            if (uniquePaths.length >= MAX_FETCH_PATHS_PER_DEPTH) {
              throw new VellumError(
                "RESPONSE_TOO_LARGE",
                `Include expansion exceeded ${MAX_FETCH_PATHS_PER_DEPTH} unique reference paths at depth ${depth}`,
                { uniquePaths: uniquePaths.length + 1, max: MAX_FETCH_PATHS_PER_DEPTH, depth }
              );
            }
            seenPaths.add(path);
            uniquePaths.push(path);
          }
        }
      }
      bindings.push({ doc, spec, alias, isArray, refs, resolved: [] });
    }
  }

  uniquePaths.sort();

  // Phase 2: exactly ONE logical batch call for this depth.
  const byPath = new Map<string, Doc>();
  if (uniquePaths.length > 0) {
    batchCallCount += 1;
    if (params.getDocumentBatch) {
      const fetched = await params.getDocumentBatch(uniquePaths);
      for (const doc of fetched) {
        const p = (doc as { path?: unknown }).path;
        if (typeof p === "string") {
          byPath.set(p, doc);
          fetchedPathSet.add(p);
        }
      }
    } else {
      const fetched = await Promise.all(uniquePaths.map((p) => params.getDocument(p)));
      uniquePaths.forEach((path, i) => {
        const doc = fetched[i];
        if (doc !== null && doc !== undefined) {
          byPath.set(path, doc);
          fetchedPathSet.add(path);
        }
      });
    }
  }

  // Phase 3: security-filter targets, account for the shared budget, and
  // schedule nested expansion grouped by nested include spec so depth d+1
  // executes as a single batched fetch rather than N+1 per-target calls.
  const expanded = new Set<string>(visited);
  const byteLengthByPath = new Map<string, number>();
  interface RecursionGroup {
    includes: IncludeSpec[];
    targets: Doc[];
    seenTargetPaths: Set<string>;
  }
  const recursionGroups = new Map<string, RecursionGroup>();

  for (const binding of bindings) {
    let wasRedacted = false;
    for (const path of binding.refs) {
      if (visited.has(path)) {
        // Cycle / already expanded: emit a stub instead of silently skipping.
        binding.resolved.push({ kind: "stub", path, stub: { _ref: path, _circular: true } });
        continue;
      }
      const target = byPath.get(path);
      if (!target) continue;
      let allowed = false;
      try {
        allowed = params.canRead(target) === true;
      } catch {
        allowed = false;
      }
      if (!allowed) {
        wasRedacted = true;
        recordRedaction(binding.doc, binding.alias);
        recordRedactionPath(binding.doc, path);
        redactedRefPathSet.add(path);
        continue;
      }

      let targetBytes = byteLengthByPath.get(path);
      if (targetBytes === undefined) {
        targetBytes = Buffer.byteLength(JSON.stringify(target.data), "utf8");
        byteLengthByPath.set(path, targetBytes);
      }

      budget.includedTargets += 1;
      budget.includedBytes += targetBytes;
      if (budget.includedTargets > MAX_INCLUDED_TARGETS_PER_PAGE) {
        throw new VellumError(
          "RESPONSE_TOO_LARGE",
          `Include expansion exceeded ${MAX_INCLUDED_TARGETS_PER_PAGE} resolved targets`,
          { includedTargets: budget.includedTargets, max: MAX_INCLUDED_TARGETS_PER_PAGE }
        );
      }
      if (budget.includedBytes > INCLUDE_BUDGET_BYTES) {
        throw new VellumError(
          "RESPONSE_TOO_LARGE",
          `Include expansion exceeded ${INCLUDE_BUDGET_BYTES} bytes`,
          { includedBytes: budget.includedBytes, max: INCLUDE_BUDGET_BYTES }
        );
      }

      expanded.add(path);
      binding.resolved.push({ kind: "doc", path, doc: target });

      const nested = binding.spec.include ?? [];
      if (depth < MAX_RELATION_DEPTH && nested.length > 0) {
        const specKey = JSON.stringify(nested);
        let group = recursionGroups.get(specKey);
        if (!group) {
          group = { includes: nested, targets: [], seenTargetPaths: new Set<string>() };
          recursionGroups.set(specKey, group);
        }
        if (!group.seenTargetPaths.has(path)) {
          group.seenTargetPaths.add(path);
          group.targets.push(target);
        }
      }
    }

    if (wasRedacted) redactedFieldSet.add(binding.alias);
  }

  // Phase 4: nested recursion (batched across all targets sharing a nested
  // include spec, eliminating N+1 fetches at depth >= 2). The same mutable
  // budget context is threaded through so totals are cumulative.
  for (const group of recursionGroups.values()) {
    const nested = await resolveIncludes<Doc>({
      docs: group.targets,
      includes: group.includes,
      depth: depth + 1,
      visitedPaths: expanded,
      getDocument: params.getDocument,
      getDocumentBatch: params.getDocumentBatch,
      canRead: params.canRead,
      selectProjector: params.selectProjector,
      _budget: budget,
    });
    batchCallCount += nested.batchCallCount;
    for (const p of nested.fetchedPaths) fetchedPathSet.add(p);
    for (const f of nested.redactedFields) redactedFieldSet.add(f);
    for (const p of nested.redactedRefPaths) redactedRefPathSet.add(p);
  }

  // Phase 5: attach (with projection) to parents, preserving reference order.
  const projector = params.selectProjector ?? projectIncludedDoc;
  for (const binding of bindings) {
    const projected: unknown[] = binding.resolved.map((entry) =>
      entry.kind === "stub"
        ? entry.stub
        : binding.spec.select && binding.spec.select.length > 0
          ? projector(entry.doc, binding.spec.select)
          : entry.doc
    );
    const value = binding.isArray
      ? projected
      : projected.length > 0
        ? projected[0] ?? null
        : null;
    attach(binding.doc, binding.spec, binding.alias, value);
  }

  return {
    docs,
    redactedFields: Array.from(redactedFieldSet),
    redactedRefPaths: Array.from(redactedRefPathSet),
    fetchedPaths: Array.from(fetchedPathSet),
    batchCallCount,
    includedBytes: budget.includedBytes,
    includedTargets: budget.includedTargets,
  };
}
