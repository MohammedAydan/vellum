/**
 * @vellum/query-engine - Query Spec Validator, Index Matcher, and SQL Compiler
 *
 * Every supported operator compiles to parameterized SQL executed inside the
 * tenant transaction (RLS + statement_timeout). No operator is ever silently
 * degraded to `TRUE` and no query path performs a full-collection in-memory
 * load on the PostgreSQL adapters.
 *
 * Hardening & Optimization Highlights:
 * - Strict validation on all query inputs (`where`, `or`, `orderBy`, `select`,
 *   `startAt`/`startAfter`, `limit`, `projectId`, `compileDeleteSelectQuery`).
 * - Prototype-pollution, nesting-depth, text-length, and clause-explosion DoS guards.
 * - Native `timestamptz` & `document_id` B-Tree comparisons for system fields.
 * - Exact structural JSONB equality for objects/arrays paired with GIN `@>` pre-filtering.
 * - Row-value tuple keyset pagination `(col, document_id) > ($1, $2)` fixing `startAt`
 *   tie-breaker bugs and `documentId DESC` direction inversion while unlocking B-Tree seeks.
 * - Commutative equality-prefix & cost-ranked composite index selection.
 * - Bounded LRU caching for index-definition hashes and field path splits.
 */

import crypto from "node:crypto";
import {
  VellumError,
  SYSTEM_LIMITS,
  normalizeIndexFieldSpec,
  parseCollectionPath,
  validateFieldName,
  validateWireValue,
} from "@vellum/core";
import { buildNestedJsonObject, escapeLikePattern } from "./operators.js";
import type {
  NormalizedQuery,
  CompiledQuery,
  CompositeIndexMetadata,
  CursorPayload,
  CursorMode,
  QueryOperator,
  WhereClause,
  OrderByClause,
} from "./types.js";

const SUPPORTED_OPS = new Set<QueryOperator>([
  "==",
  "!=",
  "<",
  "<=",
  ">",
  ">=",
  "in",
  "not-in",
  "array-contains",
  "array-contains-any",
  "contains_ci",
  "starts_with_ci",
  "text_search",
]);

const RANGE_OPS = new Set<QueryOperator>(["<", "<=", ">", ">="]);
const FORBIDDEN_PATH_SEGMENTS = new Set(["__proto__", "constructor", "prototype"]);
const INT64_RE = /^-?\d+$/;
const EVEN_HEX_RE = /^(?:[0-9a-f]{2})+$/i;

/** Safety ceiling for unindexed fallback scans. Never silently truncate. */
export const UNINDEXED_SCAN_CAP = 1000;

/** Max projected fields (50 key-value pairs = 100 args, PostgreSQL's jsonb_build_object cap). */
export const MAX_SELECT_FIELDS = 50;

/** Max dot-path nesting depth for any query field. */
export const MAX_FIELD_DEPTH = 16;

/** Max string length for text-search / ILIKE operands (prevents CPU DoS). */
export const MAX_TEXT_FILTER_LENGTH = 1024;

/** Max total `array-contains-any` OR-branch expansions across a single query. */
export const MAX_TOTAL_DISJUNCTIVE_EXPANSIONS = 120;

/** Bounded LRU cache cap for immutable pure computations. */
const LRU_CACHE_LIMIT = 512;
const indexDefHashCache = new Map<string, string>();
const splitPathCache = new Map<string, readonly string[]>();

function lruGet<K, V>(cache: Map<K, V>, key: K): V | undefined {
  const val = cache.get(key);
  if (val !== undefined) {
    cache.delete(key);
    cache.set(key, val);
  }
  return val;
}

function lruSet<K, V>(cache: Map<K, V>, key: K, value: V): void {
  if (cache.size >= LRU_CACHE_LIMIT) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  cache.set(key, value);
}

function splitFieldPath(field: string): string[] {
  const cached = lruGet(splitPathCache, field);
  if (cached) return [...cached];
  const parts = field.split(".");
  lruSet(splitPathCache, field, parts);
  return [...parts];
}

/** CamelCase projection matching `DocumentRecord`, shared by both query plans. */
const DOCUMENT_COLUMNS = [
  'd.project_id AS "projectId"',
  "d.path",
  'd.collection_path AS "collectionPath"',
  'd.collection_group AS "collectionGroup"',
  'd.document_id AS "documentId"',
  'd.path_depth AS "pathDepth"',
  "d.data",
  'd.size_bytes AS "sizeBytes"',
  'd.version::int AS "version"',
  'd.created_at::text AS "createdAt"',
  'd.updated_at::text AS "updatedAt"',
  'd.deleted_at::text AS "deletedAt"',
].join(", ");

type ComparisonKind = "number" | "string" | "int" | "ts";

function addParam(params: unknown[], value: unknown): string {
  params.push(value);
  return `$${params.length}`;
}

function isSystemField(field: string): boolean {
  return field === "documentId" || field === "__name__" || field === "createdAt" || field === "updatedAt";
}

function isTimestampSystemField(field: string): boolean {
  return field === "createdAt" || field === "updatedAt";
}

function isIdSystemField(field: string): boolean {
  return field === "documentId" || field === "__name__";
}

function isPrimitiveJsonValue(value: unknown): boolean {
  return value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean";
}

function validateFieldPath(field: string, allowSystemField: boolean): void {
  if (typeof field !== "string" || field.length === 0) {
    throw new VellumError("INVALID_ARGUMENT", "Field path must be a non-empty string");
  }
  if (allowSystemField && isSystemField(field)) {
    return;
  }
  const parts = field.split(".");
  if (parts.length > MAX_FIELD_DEPTH) {
    throw new VellumError(
      "QUERY_TOO_COMPLEX",
      `Field path '${field}' exceeds maximum nesting depth of ${MAX_FIELD_DEPTH}`
    );
  }
  for (const part of parts) {
    if (part.length === 0 || FORBIDDEN_PATH_SEGMENTS.has(part)) {
      throw new VellumError("INVALID_ARGUMENT", `Invalid or forbidden field path segment in '${field}'`);
    }
    validateFieldName(part);
  }
}

function extractIsoTimestamp(value: unknown, contextLabel: string): string {
  if (typeof value === "string") {
    const ms = Date.parse(value);
    if (!Number.isFinite(ms)) {
      throw new VellumError("INVALID_ARGUMENT", `${contextLabel} requires a valid ISO-8601 timestamp`);
    }
    return new Date(ms).toISOString();
  }
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    const rec = value as Record<string, unknown>;
    if (rec["$t"] === "ts") {
      const ms = typeof rec["$ms"] === "number"
        ? rec["$ms"]
        : typeof rec["$v"] === "string"
          ? Date.parse(rec["$v"])
          : NaN;
      if (!Number.isFinite(ms)) {
        throw new VellumError("INVALID_ARGUMENT", `${contextLabel} contains an invalid tagged timestamp`);
      }
      return new Date(ms).toISOString();
    }
  }
  throw new VellumError(
    "INVALID_ARGUMENT",
    `${contextLabel} requires an ISO-8601 string or tagged timestamp value`
  );
}

function canonicalizeTaggedValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalizeTaggedValue);
  if (value === null || typeof value !== "object") return value;
  const rec = value as Record<string, unknown>;
  if (rec["$t"] === "ts") {
    const v = rec["$v"];
    if (typeof v === "string") {
      const ms = typeof rec["$ms"] === "number" ? rec["$ms"] : Date.parse(v);
      if (!Number.isFinite(ms)) {
        throw new VellumError("INVALID_ARGUMENT", `Invalid tagged timestamp value '${v}'`);
      }
      return { ...rec, $v: new Date(ms).toISOString(), $ms: ms };
    }
  }
  if (rec["$t"] === "int") {
    const raw = String(rec["$v"] ?? "");
    if (!INT64_RE.test(raw)) {
      throw new VellumError("INVALID_ARGUMENT", `Invalid tagged int64 value '${raw}'`);
    }
  }
  const out: Record<string, unknown> = Object.create(null);
  for (const [k, child] of Object.entries(rec)) {
    if (FORBIDDEN_PATH_SEGMENTS.has(k)) continue;
    out[k] = canonicalizeTaggedValue(child);
  }
  return out;
}

function classifyComparisonValue(value: unknown): ComparisonKind | null {
  if (typeof value === "number" && Number.isFinite(value)) return "number";
  if (typeof value === "string") return "string";
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    const tag = (value as Record<string, unknown>)["$t"];
    if (tag === "int") return "int";
    if (tag === "ts") return "ts";
  }
  return null;
}

function nestedJsonLiteral(field: string, value: unknown): string {
  return JSON.stringify(buildNestedJsonObject(field, canonicalizeTaggedValue(value)));
}

function canonicalJsonLiteral(value: unknown): string {
  return JSON.stringify(canonicalizeTaggedValue(value));
}

function deduplicateValues(values: unknown[]): unknown[] {
  if (values.length <= 1) return values;
  const seen = new Set<string>();
  const out: unknown[] = [];
  for (const v of values) {
    const key = JSON.stringify(canonicalizeTaggedValue(v));
    if (!seen.has(key)) {
      seen.add(key);
      out.push(v);
    }
  }
  return out;
}

interface FieldAccess {
  json: string;
  text: string;
  exists: string;
  dataPath: string[] | null;
}

function fieldAccess(field: string, params: unknown[]): FieldAccess {
  if (isIdSystemField(field)) {
    return {
      json: "to_jsonb(d.document_id)",
      text: "d.document_id::text",
      exists: "d.document_id IS NOT NULL",
      dataPath: null,
    };
  }
  if (isTimestampSystemField(field)) {
    const col = field === "createdAt" ? "created_at" : "updated_at";
    return {
      json: `to_jsonb(d.${col}::text)`,
      text: `d.${col}::text`,
      exists: `d.${col} IS NOT NULL`,
      dataPath: null,
    };
  }
  const parts = splitFieldPath(field);
  const p = addParam(params, parts);
  return {
    json: `(d.data #> ${p}::text[])`,
    text: `(d.data #>> ${p}::text[])`,
    exists: `(d.data #> ${p}::text[]) IS NOT NULL`,
    dataPath: parts,
  };
}

function sqlComparisonOp(op: QueryOperator): string {
  switch (op) {
    case "<": return "<";
    case "<=": return "<=";
    case ">": return ">";
    case ">=": return ">=";
    default: throw new VellumError("INVALID_ARGUMENT", `Not a range operator: ${op}`);
  }
}

function compileRangeClause(clause: WhereClause, params: unknown[]): string {
  if (clause.value === null) {
    throw new VellumError("INVALID_ARGUMENT", "Range filters cannot use null as a bound");
  }
  const kind = classifyComparisonValue(clause.value);
  if (kind === null) {
    throw new VellumError(
      "INVALID_ARGUMENT",
      `Range filter on field '${clause.field}' requires a finite number, string, tagged int64 or tagged timestamp value`
    );
  }
  const op = sqlComparisonOp(clause.op);

  // Native B-Tree index-friendly comparisons for system columns.
  if (isTimestampSystemField(clause.field)) {
    const col = clause.field === "createdAt" ? "created_at" : "updated_at";
    const iso = extractIsoTimestamp(clause.value, `Range filter on '${clause.field}'`);
    const bound = addParam(params, iso);
    return `(d.${col} ${op} ${bound}::timestamptz)`;
  }

  if (isIdSystemField(clause.field)) {
    if (kind !== "string") {
      throw new VellumError("INVALID_ARGUMENT", `Range filter on '${clause.field}' requires a string value`);
    }
    const bound = addParam(params, clause.value);
    return `(d.document_id COLLATE "C" ${op} ${bound}::text)`;
  }

  const access = fieldAccess(clause.field, params);

  if (kind === "number") {
    const bound = addParam(params, clause.value);
    return `(jsonb_typeof(${access.json}) = 'number' AND ${access.text}::numeric ${op} ${bound}::numeric)`;
  }

  if (kind === "string") {
    const bound = addParam(params, clause.value);
    return `(jsonb_typeof(${access.json}) = 'string' AND ${access.text} COLLATE "C" ${op} ${bound}::text)`;
  }

  // Tagged int64 / timestamp live inside a JSONB object; guard the $t discriminator
  // and compare a canonical numeric representation so cross-type ordering is impossible.
  const typePath = addParam(params, [...access.dataPath!, "$t"]);
  if (kind === "int") {
    const rawInt = String((clause.value as { $v: string }).$v ?? "");
    if (!INT64_RE.test(rawInt)) {
      throw new VellumError("INVALID_ARGUMENT", `Invalid tagged int64 value on field '${clause.field}'`);
    }
    const vPath = addParam(params, [...access.dataPath!, "$v"]);
    const bound = addParam(params, rawInt);
    return `((d.data #>> ${typePath}::text[]) = 'int' AND (d.data #>> ${vPath}::text[])::numeric ${op} ${bound}::numeric)`;
  }

  const msPath = addParam(params, [...access.dataPath!, "$ms"]);
  const ts = clause.value as { $ms?: number; $v: string };
  const msValue = typeof ts.$ms === "number" ? ts.$ms : Date.parse(ts.$v);
  if (!Number.isFinite(msValue)) {
    throw new VellumError("INVALID_ARGUMENT", `Invalid tagged timestamp value on field '${clause.field}'`);
  }
  const bound = addParam(params, msValue);
  return `((d.data #>> ${typePath}::text[]) = 'ts' AND (d.data #>> ${msPath}::text[])::bigint ${op} ${bound}::bigint)`;
}

/** Ops that require a plain string operand (no tagged values, no arrays). */
function requireStringValue(clause: WhereClause): string {
  if (typeof clause.value !== "string") {
    throw new VellumError(
      "INVALID_ARGUMENT",
      `Operator '${clause.op}' on field '${clause.field}' requires a string value`,
      { op: clause.op, field: clause.field }
    );
  }
  if (clause.value.length > MAX_TEXT_FILTER_LENGTH) {
    throw new VellumError(
      "QUERY_TOO_COMPLEX",
      `Operator '${clause.op}' on field '${clause.field}' exceeds maximum text length of ${MAX_TEXT_FILTER_LENGTH}`,
      { op: clause.op, field: clause.field, length: clause.value.length }
    );
  }
  return clause.value;
}

/**
 * Compiles a single where clause into parameterized SQL. Exported so the
 * storage layer can reuse the exact same operator semantics for native
 * aggregations and bulk-delete selection (never a second, divergent compiler).
 */
export function compileWhereClause(clause: WhereClause, params: unknown[]): string {
  switch (clause.op) {
    case "==": {
      if (isTimestampSystemField(clause.field)) {
        const col = clause.field === "createdAt" ? "created_at" : "updated_at";
        const bound = addParam(params, extractIsoTimestamp(clause.value, `Filter on '${clause.field}'`));
        return `d.${col} = ${bound}::timestamptz`;
      }
      if (isIdSystemField(clause.field)) {
        const bound = addParam(params, String(clause.value));
        return `d.document_id = ${bound}::text`;
      }
      const literal = addParam(params, nestedJsonLiteral(clause.field, clause.value));
      // Primitives: GIN jsonb_path_ops `@>` is exact equality.
      // Objects/arrays: combine GIN `@>` pre-filter with exact structural equality
      // so `{ a: 1 }` never falsely matches `{ a: 1, b: 2 }` and `[1]` never matches `[1, 2]`.
      if (isPrimitiveJsonValue(clause.value)) {
        return `d.data @> ${literal}::jsonb`;
      }
      const access = fieldAccess(clause.field, params);
      const exactVal = addParam(params, canonicalJsonLiteral(clause.value));
      return `(d.data @> ${literal}::jsonb AND ${access.json} = ${exactVal}::jsonb)`;
    }
    case "array-contains": {
      const literal = addParam(params, nestedJsonLiteral(clause.field, [clause.value]));
      return `d.data @> ${literal}::jsonb`;
    }
    case "!=": {
      if (isTimestampSystemField(clause.field)) {
        const col = clause.field === "createdAt" ? "created_at" : "updated_at";
        const bound = addParam(params, extractIsoTimestamp(clause.value, `Filter on '${clause.field}'`));
        return `(d.${col} IS NOT NULL AND d.${col} <> ${bound}::timestamptz)`;
      }
      if (isIdSystemField(clause.field)) {
        const bound = addParam(params, String(clause.value));
        return `(d.document_id IS NOT NULL AND d.document_id <> ${bound}::text)`;
      }
      const access = fieldAccess(clause.field, params);
      if (isPrimitiveJsonValue(clause.value)) {
        const literal = addParam(params, nestedJsonLiteral(clause.field, clause.value));
        return `(${access.exists} AND NOT (d.data @> ${literal}::jsonb))`;
      }
      const exactVal = addParam(params, canonicalJsonLiteral(clause.value));
      return `(${access.exists} AND ${access.json} <> ${exactVal}::jsonb)`;
    }
    case "in":
    case "not-in": {
      const values = deduplicateValues(clause.value as unknown[]);
      const negated = clause.op === "not-in";
      if (values.length === 0) return negated ? "TRUE" : "FALSE";

      if (isTimestampSystemField(clause.field)) {
        const col = clause.field === "createdAt" ? "created_at" : "updated_at";
        const isoValues = values.map((v) => extractIsoTimestamp(v, `Filter on '${clause.field}'`));
        const bound = addParam(params, isoValues);
        return negated
          ? `(d.${col} IS NOT NULL AND NOT (d.${col} = ANY(${bound}::timestamptz[])))`
          : `(d.${col} IS NOT NULL AND d.${col} = ANY(${bound}::timestamptz[]))`;
      }
      if (isIdSystemField(clause.field)) {
        const bound = addParam(params, values.map((v) => String(v)));
        return negated
          ? `(d.document_id IS NOT NULL AND NOT (d.document_id = ANY(${bound}::text[])))`
          : `(d.document_id IS NOT NULL AND d.document_id = ANY(${bound}::text[]))`;
      }

      const access = fieldAccess(clause.field, params);
      const allPrimitives = values.every(isPrimitiveJsonValue);
      if (allPrimitives) {
        const bound = addParam(params, values.map((v) => nestedJsonLiteral(clause.field, v)));
        const containment = `d.data @> ANY(${bound}::jsonb[])`;
        return negated ? `(${access.exists} AND NOT (${containment}))` : `(${access.exists} AND ${containment})`;
      }
      const exactList = addParam(params, values.map((v) => canonicalJsonLiteral(v)));
      const exactMatch = `${access.json} = ANY(${exactList}::jsonb[])`;
      return negated ? `(${access.exists} AND NOT (${exactMatch}))` : `(${access.exists} AND ${exactMatch})`;
    }
    case "array-contains-any": {
      const values = deduplicateValues(clause.value as unknown[]);
      if (values.length === 0) return "FALSE";
      const parts = values.map((v) => {
        const literal = addParam(params, nestedJsonLiteral(clause.field, [v]));
        return `d.data @> ${literal}::jsonb`;
      });
      return `(${parts.join(" OR ")})`;
    }
    case "contains_ci": {
      const value = requireStringValue(clause);
      const access = fieldAccess(clause.field, params);
      // The parameter is the already-escaped literal; the surrounding wildcards
      // are SQL literals, so a user-supplied `%`/`_`/`\` can never widen the match.
      const escaped = addParam(params, escapeLikePattern(value));
      return `(jsonb_typeof(${access.json}) = 'string' AND ${access.text} ILIKE '%' || ${escaped} || '%' ESCAPE '\\')`;
    }
    case "starts_with_ci": {
      const value = requireStringValue(clause);
      const access = fieldAccess(clause.field, params);
      const escaped = addParam(params, escapeLikePattern(value));
      return `(jsonb_typeof(${access.json}) = 'string' AND ${access.text} ILIKE ${escaped} || '%' ESCAPE '\\')`;
    }
    case "text_search": {
      const value = requireStringValue(clause);
      const bound = addParam(params, value);
      return `(to_tsvector('simple', coalesce(d.data::text,'')) @@ plainto_tsquery('simple', ${bound}))`;
    }
    default:
      if (RANGE_OPS.has(clause.op)) return compileRangeClause(clause, params);
      throw new VellumError("INVALID_ARGUMENT", `Unsupported query operator '${String(clause.op)}'`);
  }
}

/** Keep native JSON numbers numeric, including tagged int64, on fallback scans.
 * The leading rank also makes missing/null values deterministic for keyset seeks.
 * Use the exact same key for ORDER BY and cursor predicates.
 */
function fallbackOrderKey(json: string): string {
  return `(CASE
    WHEN ${json} IS NULL THEN jsonb_build_array(0)
    WHEN jsonb_typeof(${json}) = 'null' THEN jsonb_build_array(1)
    WHEN jsonb_typeof(${json}) = 'boolean' THEN jsonb_build_array(2, ${json})
    WHEN jsonb_typeof(${json}) = 'number' THEN jsonb_build_array(3, ${json})
    WHEN ${json} ->> '$t' = 'int' THEN jsonb_build_array(3, (${json} ->> '$v')::numeric)
    WHEN jsonb_typeof(${json}) = 'string' THEN jsonb_build_array(4, ${json})
    ELSE jsonb_build_array(5, ${json}) END)`;
}

function buildOrderBySql(orderBy: OrderByClause[], params: unknown[]): string {
  const parts: string[] = [];
  for (const o of orderBy) {
    const dir = o.dir === "desc" ? "DESC" : "ASC";
    if (isIdSystemField(o.field)) {
      parts.push(`d.document_id ${dir}`);
    } else if (isTimestampSystemField(o.field)) {
      parts.push(`d.${o.field === "createdAt" ? "created_at" : "updated_at"} ${dir}`);
    } else {
      const p = addParam(params, splitFieldPath(o.field));
      parts.push(`${fallbackOrderKey(`(d.data #> ${p}::text[])`)} ${dir}`);
    }
  }
  return `ORDER BY ${parts.join(", ")}`;
}

function resolveDocIdTieBreakerDir(orderBy: OrderByClause[]): "asc" | "desc" {
  const docIdOrder = orderBy.find((o) => isIdSystemField(o.field));
  return docIdOrder ? docIdOrder.dir : "asc";
}

function buildCursorPredicate(
  cursor: CursorPayload,
  cursorMode: CursorMode,
  normalizedQuery: NormalizedQuery,
  matchedCompositeIndex: CompositeIndexMetadata | null,
  params: unknown[]
): string | null {
  if (!cursorMode) return null;
  const inclusive = cursorMode === "startAt";

  if (matchedCompositeIndex) {
    if (!cursor.sortKey || !EVEN_HEX_RE.test(cursor.sortKey)) {
      throw new VellumError(
        "INVALID_CURSOR",
        "Composite-index cursor is missing its signed sort key; cannot resume an indexed query"
      );
    }
    const key = addParam(params, Buffer.from(cursor.sortKey, "hex"));
    const id = addParam(params, cursor.docId);
    // Row-value tuple comparison enables direct PostgreSQL B-Tree Index Scan
    // AND guarantees exact tie-breaker semantics for both startAt and startAfter.
    const tupleOp = inclusive ? ">=" : ">";
    return `(ie.sort_key, ie.document_id) ${tupleOp} (${key}::bytea, ${id})`;
  }

  const primary = normalizedQuery.orderBy[0];
  if (!primary) return null;

  if (isIdSystemField(primary.field)) {
    const id = addParam(params, cursor.docId);
    const op = primary.dir === "desc"
      ? (inclusive ? "<=" : "<")
      : (inclusive ? ">=" : ">");
    return `d.document_id ${op} ${id}`;
  }

  const tieDir = resolveDocIdTieBreakerDir(normalizedQuery.orderBy);
  const tieOp = tieDir === "desc"
    ? (inclusive ? "<=" : "<")
    : (inclusive ? ">=" : ">");

  if (isTimestampSystemField(primary.field)) {
    const col = primary.field === "createdAt" ? "created_at" : "updated_at";
    const iso = extractIsoTimestamp(cursor.vals[0], "System-field cursor");
    const bound = addParam(params, iso);
    const id = addParam(params, cursor.docId);

    // Same direction on both columns -> native PostgreSQL tuple B-Tree seek.
    if (primary.dir === tieDir) {
      const tupleOp = primary.dir === "asc"
        ? (inclusive ? ">=" : ">")
        : (inclusive ? "<=" : "<");
      return `(d.${col}, d.document_id) ${tupleOp} (${bound}::timestamptz, ${id})`;
    }
    // Mixed directions -> first branch MUST be strict (`>` / `<`) so `startAt`
    // never leaks rows with equal timestamp and earlier tie-breaker documentId.
    const strictPrimaryOp = primary.dir === "asc" ? ">" : "<";
    return `(d.${col} ${strictPrimaryOp} ${bound}::timestamptz OR (d.${col} = ${bound}::timestamptz AND d.document_id ${tieOp} ${id}))`;
  }

  // Unindexed values and cursor values share the same typed JSONB key.
  const raw = cursor.vals[0];
  const p = addParam(params, splitFieldPath(primary.field));
  const id = addParam(params, cursor.docId);
  const strictPrimaryOp = primary.dir === "asc" ? ">" : "<";
  const bound = addParam(params, JSON.stringify(raw ?? null));
  const key = fallbackOrderKey(`(d.data #> ${p}::text[])`);
  const cursorKey = fallbackOrderKey(`${bound}::jsonb`);

  if (primary.dir === tieDir) {
    const tupleOp = primary.dir === "asc"
      ? (inclusive ? ">=" : ">")
      : (inclusive ? "<=" : "<");
    return `(${key}, d.document_id) ${tupleOp} (${cursorKey}, ${id})`;
  }
  return `(${key} ${strictPrimaryOp} ${cursorKey} OR (${key} = ${cursorKey} AND d.document_id ${tieOp} ${id}))`;
}

/**
 * Validates one list of where clauses (the base `where` or a single `or` group).
 * Shared so both paths enforce identical field-name, operator, cardinality and
 * wire-value rules — including the string-only requirement of the V2 text ops.
 * Returns the number of `array-contains-any` disjunctive expansions for budget tracking.
 */
function validateWhereClauses(clauses: WhereClause[], label: string): number {
  if (clauses.length > SYSTEM_LIMITS.MAX_WHERE_CLAUSES) {
    throw new VellumError(
      "QUERY_TOO_COMPLEX",
      `Query ${label} contains ${clauses.length} clauses, exceeding maximum of ${SYSTEM_LIMITS.MAX_WHERE_CLAUSES}`,
      { label, whereCount: clauses.length, maxWhere: SYSTEM_LIMITS.MAX_WHERE_CLAUSES }
    );
  }
  let disjunctiveExpansions = 0;
  for (const clause of clauses) {
    if (!clause || typeof clause !== "object" || typeof clause.field !== "string" || !SUPPORTED_OPS.has(clause.op)) {
      throw new VellumError("INVALID_ARGUMENT", `Invalid query filter clause on field '${clause?.field}'`);
    }
    validateFieldPath(clause.field, true);

    if (clause.op === "contains_ci" || clause.op === "starts_with_ci" || clause.op === "text_search") {
      if (typeof clause.value !== "string") {
        throw new VellumError(
          "INVALID_ARGUMENT",
          `Operator '${clause.op}' on field '${clause.field}' requires a string value`,
          { op: clause.op, field: clause.field }
        );
      }
      if (clause.value.length > MAX_TEXT_FILTER_LENGTH) {
        throw new VellumError(
          "QUERY_TOO_COMPLEX",
          `Operator '${clause.op}' on field '${clause.field}' exceeds maximum text length of ${MAX_TEXT_FILTER_LENGTH}`,
          { op: clause.op, field: clause.field, length: clause.value.length }
        );
      }
    } else if (clause.op === "in" || clause.op === "not-in" || clause.op === "array-contains-any") {
      if (
        !Array.isArray(clause.value) ||
        clause.value.length === 0 ||
        clause.value.length > SYSTEM_LIMITS.MAX_DISJUNCTIVE_VALUES
      ) {
        throw new VellumError(
          "QUERY_TOO_COMPLEX",
          `Operator '${clause.op}' requires a non-empty array of at most ${SYSTEM_LIMITS.MAX_DISJUNCTIVE_VALUES} values`,
          { op: clause.op, count: Array.isArray(clause.value) ? clause.value.length : 0 }
        );
      }
      if (clause.op === "array-contains-any") {
        disjunctiveExpansions += clause.value.length;
      }
      for (const v of clause.value) {
        validateWireValue(v, 1, false);
      }
    } else {
      validateWireValue(clause.value, 1, false);
    }
  }
  return disjunctiveExpansions;
}

export function validateAndNormalizeQuery(rawQuery: Record<string, unknown>): NormalizedQuery {
  if (!rawQuery || typeof rawQuery !== "object" || Array.isArray(rawQuery)) {
    throw new VellumError("INVALID_ARGUMENT", "Query payload must be a JSON object");
  }
  const rawCol = (rawQuery["collectionPath"] ?? rawQuery["collection"]) as string;
  const { collectionPath } = parseCollectionPath(rawCol);

  if (rawQuery["where"] !== undefined && rawQuery["where"] !== null && !Array.isArray(rawQuery["where"])) {
    throw new VellumError("INVALID_ARGUMENT", "Query 'where' must be an array of filter clauses");
  }
  const rawWhere = Array.isArray(rawQuery["where"]) ? (rawQuery["where"] as WhereClause[]) : [];
  let totalDisjunctiveExpansions = validateWhereClauses(rawWhere, "where");

  // Disjunctive groups: each group is ANDed internally, groups are ORed.
  const rawOr = rawQuery["or"];
  let whereOr: WhereClause[][] = [];
  if (rawOr !== undefined && rawOr !== null) {
    if (!Array.isArray(rawOr)) {
      throw new VellumError("INVALID_ARGUMENT", "Query 'or' must be an array of groups");
    }
    if (rawOr.length > SYSTEM_LIMITS.MAX_WHERE_CLAUSES) {
      throw new VellumError(
        "QUERY_TOO_COMPLEX",
        `Query contains ${rawOr.length} 'or' groups, exceeding maximum of ${SYSTEM_LIMITS.MAX_WHERE_CLAUSES}`,
        { orGroups: rawOr.length, maxOrGroups: SYSTEM_LIMITS.MAX_WHERE_CLAUSES }
      );
    }
    whereOr = rawOr.map((group, groupIndex) => {
      if (!Array.isArray(group) || group.length === 0) {
        throw new VellumError(
          "INVALID_ARGUMENT",
          `Query 'or' group ${groupIndex} must be a non-empty array of clauses`
        );
      }
      totalDisjunctiveExpansions += validateWhereClauses(group as WhereClause[], `or[${groupIndex}]`);
      return (group as WhereClause[]).map((c) => ({ field: c.field, op: c.op, value: c.value }));
    });
  }

  if (totalDisjunctiveExpansions > MAX_TOTAL_DISJUNCTIVE_EXPANSIONS) {
    throw new VellumError(
      "QUERY_TOO_COMPLEX",
      `Query exceeds maximum total disjunctive expansions (${MAX_TOTAL_DISJUNCTIVE_EXPANSIONS})`,
      { disjunctiveExpansions: totalDisjunctiveExpansions, maxExpansions: MAX_TOTAL_DISJUNCTIVE_EXPANSIONS }
    );
  }

  if (rawQuery["orderBy"] !== undefined && rawQuery["orderBy"] !== null && !Array.isArray(rawQuery["orderBy"])) {
    throw new VellumError("INVALID_ARGUMENT", "Query 'orderBy' must be an array");
  }
  const rawOrderBy = Array.isArray(rawQuery["orderBy"])
    ? (rawQuery["orderBy"] as Array<{ field: string; dir?: "asc" | "desc"; direction?: "asc" | "desc" }>)
    : [];
  if (rawOrderBy.length > SYSTEM_LIMITS.MAX_ORDER_BY_FIELDS) {
    throw new VellumError(
      "QUERY_TOO_COMPLEX",
      `Query contains ${rawOrderBy.length} orderBy fields, exceeding maximum of ${SYSTEM_LIMITS.MAX_ORDER_BY_FIELDS}`,
      { orderByCount: rawOrderBy.length }
    );
  }

  const seenOrderByFields = new Set<string>();
  const orderBy: OrderByClause[] = rawOrderBy.map((o) => {
    if (!o || typeof o !== "object" || typeof o.field !== "string") {
      throw new VellumError("INVALID_ARGUMENT", "Invalid orderBy specification");
    }
    const dir = o.dir ?? o.direction ?? "asc";
    if (dir !== "asc" && dir !== "desc") {
      throw new VellumError("INVALID_ARGUMENT", "Invalid orderBy specification");
    }
    validateFieldPath(o.field, true);
    const canonicalField = o.field === "__name__" ? "documentId" : o.field;
    if (seenOrderByFields.has(canonicalField)) {
      throw new VellumError("INVALID_ARGUMENT", `Duplicate orderBy field '${o.field}'`);
    }
    seenOrderByFields.add(canonicalField);
    return { field: o.field, dir };
  });

  if (!orderBy.some((o) => isIdSystemField(o.field))) {
    orderBy.push({ field: "documentId", dir: "asc" });
  }

  const limit = rawQuery["limit"] === undefined ? SYSTEM_LIMITS.DEFAULT_QUERY_LIMIT : Number(rawQuery["limit"]);
  if (!Number.isInteger(limit) || limit < 1 || limit > SYSTEM_LIMITS.MAX_QUERY_LIMIT) {
    throw new VellumError(
      "LIMIT_EXCEEDED",
      `Query limit (${rawQuery["limit"]}) must be an integer between 1 and ${SYSTEM_LIMITS.MAX_QUERY_LIMIT}`,
      { limit: rawQuery["limit"], maxLimit: SYSTEM_LIMITS.MAX_QUERY_LIMIT }
    );
  }

  let select: string[] | null = null;
  if (rawQuery["select"] !== undefined && rawQuery["select"] !== null) {
    if (!Array.isArray(rawQuery["select"])) {
      throw new VellumError("INVALID_ARGUMENT", "Query 'select' must be an array of field paths");
    }
    const dedupedSelect: string[] = [];
    const seenSelect = new Set<string>();
    for (const item of rawQuery["select"]) {
      if (typeof item !== "string") {
        throw new VellumError("INVALID_ARGUMENT", "Query 'select' entries must be non-empty field path strings");
      }
      validateFieldPath(item, true);
      if (!seenSelect.has(item)) {
        seenSelect.add(item);
        dedupedSelect.push(item);
      }
    }
    if (dedupedSelect.length > MAX_SELECT_FIELDS) {
      throw new VellumError(
        "QUERY_TOO_COMPLEX",
        `Query 'select' contains ${dedupedSelect.length} fields, exceeding maximum of ${MAX_SELECT_FIELDS}`,
        { selectCount: dedupedSelect.length, maxSelect: MAX_SELECT_FIELDS }
      );
    }
    select = dedupedSelect;
  }

  const startAt = (rawQuery["startAt"] as unknown[] | undefined) ?? null;
  const startAfter = (rawQuery["startAfter"] as unknown[] | undefined) ?? null;
  if (startAt !== null && startAfter !== null) {
    throw new VellumError("INVALID_ARGUMENT", "Query cannot specify both 'startAt' and 'startAfter'");
  }

  const search = rawQuery["search"];
  if (search !== undefined && (typeof search !== "string" || search.length > 200)) {
    throw new VellumError("INVALID_ARGUMENT", "search must be a string of at most 200 characters");
  }
  return {
    ...(typeof search === "string" && search.trim() ? { search: search.trim() } : {}),
    collectionPath,
    where: rawWhere.map((c) => ({ field: c.field, op: c.op, value: c.value })),
    or: whereOr,
    orderBy,
    limit,
    select,
    startAt,
    startAfter,
  };
}

export function compileQueryToParameterizedSql({
  projectId,
  normalizedQuery,
  matchedCompositeIndex = null,
  cursor = null,
  cursorMode = null,
  scanCap,
}: {
  projectId: string;
  normalizedQuery: NormalizedQuery;
  matchedCompositeIndex?: CompositeIndexMetadata | null | undefined;
  cursor?: CursorPayload | null | undefined;
  cursorMode?: CursorMode | undefined;
  /**
   * Override the safety cap for unindexed scans. `null` disables it (used by
   * bounded maintenance reads such as bulk-delete selection). Omitted keeps the
   * public-query default of `UNINDEXED_SCAN_CAP`.
   */
  scanCap?: number | null | undefined;
}): CompiledQuery {
  if (typeof projectId !== "string" || projectId.length === 0) {
    throw new VellumError("INVALID_ARGUMENT", "projectId must be a non-empty string");
  }
  if (matchedCompositeIndex && (typeof matchedCompositeIndex.id !== "string" || matchedCompositeIndex.id.length === 0)) {
    throw new VellumError("INVALID_ARGUMENT", "matchedCompositeIndex.id must be a non-empty string");
  }
  if (scanCap !== undefined && scanCap !== null && (!Number.isInteger(scanCap) || scanCap < 1)) {
    throw new VellumError("INVALID_ARGUMENT", "scanCap must be a positive integer or null");
  }

  const params: unknown[] = [projectId, normalizedQuery.collectionPath];
  const predicates: string[] = [
    "d.project_id = $1::uuid",
    "d.collection_path = $2",
    "d.deleted_at IS NULL",
    // V2 TTL: live reads never see an expired row. No bind params are added,
    // so existing cursor/shape-hash and parameter indices stay unchanged.
    "(d.expires_at IS NULL OR d.expires_at > now())",
  ];

  if (normalizedQuery.search) {
    const escaped = normalizedQuery.search.replace(/[\\%_]/g, "\\$&");
    const pattern = addParam(params, `%${escaped}%`);
    predicates.push(`(d.document_id ILIKE ${pattern} ESCAPE '\\' OR d.data::text ILIKE ${pattern} ESCAPE '\\')`);
  }

  const projectionFields = normalizedQuery.select && normalizedQuery.select.length > 0
    ? [...normalizedQuery.select]
    : null;

  let selectList = DOCUMENT_COLUMNS;
  if (projectionFields) {
    if (projectionFields.length > MAX_SELECT_FIELDS) {
      throw new VellumError(
        "QUERY_TOO_COMPLEX",
        `Query projection exceeds maximum of ${MAX_SELECT_FIELDS} fields`
      );
    }
    const pairs: string[] = [];
    for (const field of projectionFields) {
      const key = addParam(params, field);
      const access = fieldAccess(field, params);
      pairs.push(`${key}::text, ${access.json}`);
    }
    selectList += `, jsonb_build_object(${pairs.join(", ")}) AS "projectedData"`;
  }

  for (const clause of normalizedQuery.where) {
    predicates.push(compileWhereClause(clause, params));
  }

  // Disjunctive groups compile to `((g1) OR (g2) …)` ANDed with the base filters.
  const orGroups = normalizedQuery.or ?? [];
  if (orGroups.length > 0) {
    const groupSql = orGroups.map((group) => {
      const parts = group.map((clause) => compileWhereClause(clause, params));
      return `(${parts.join(" AND ")})`;
    });
    predicates.push(`(${groupSql.join(" OR ")})`);
  }

  const cursorPredicate = cursor
    ? buildCursorPredicate(cursor, cursorMode, normalizedQuery, matchedCompositeIndex, params)
    : null;
  if (cursorPredicate) predicates.push(cursorPredicate);

  const maxScanRows = matchedCompositeIndex
    ? null
    : scanCap === undefined
      ? UNINDEXED_SCAN_CAP
      : scanCap;
  const fetchLimit = Math.min(
    normalizedQuery.limit + 1,
    maxScanRows === null ? Number.MAX_SAFE_INTEGER : maxScanRows + 1
  );
  const limitParam = addParam(params, fetchLimit);

  let sql: string;
  if (matchedCompositeIndex) {
    const idxParam = addParam(params, matchedCompositeIndex.id);
    sql =
      `SELECT ${selectList}, encode(ie.sort_key, 'hex') AS "sortKeyHex" ` +
      `FROM document_index_entries ie ` +
      `JOIN documents d ON d.project_id = ie.project_id AND d.path = ie.path ` +
      `WHERE ie.index_id = ${idxParam}::uuid AND ie.project_id = $1::uuid AND ${predicates.join(" AND ")} ` +
      `ORDER BY ie.sort_key ASC, ie.document_id ASC LIMIT ${limitParam};`;
  } else {
    sql =
      `SELECT ${selectList} FROM documents d WHERE ${predicates.join(" AND ")} ` +
      `${buildOrderBySql(normalizedQuery.orderBy, params)} LIMIT ${limitParam};`;
  }

  const hasFilters = normalizedQuery.where.length > 0 || orGroups.length > 0;

  return {
    sql,
    params,
    indexUsed: matchedCompositeIndex
      ? `composite:${matchedCompositeIndex.id}`
      : hasFilters
        ? "idx_docs_data_gin_active"
        : "idx_docs_collection_id_active",
    normalizedQuery,
    cursor,
    cursorMode,
    fetchLimit,
    maxScanRows,
    projectionFields,
    compositeIndexId: matchedCompositeIndex ? matchedCompositeIndex.id : null,
  };
}

/**
 * Compiles a bounded, deterministic select of live documents for maintenance
 * operations (bulk delete). Reuses the exact public where/or/TTL compiler but
 * disables the unindexed scan cap so up to `limit` rows can be selected. The
 * result is always ordered by `documentId ASC`.
 */
export function compileDeleteSelectQuery({
  projectId,
  collectionPath,
  where,
  or = [],
  limit,
}: {
  projectId: string;
  collectionPath: string;
  where: WhereClause[];
  or?: WhereClause[][] | undefined;
  limit: number;
}): CompiledQuery {
  const { collectionPath: normalizedCollection } = parseCollectionPath(collectionPath);
  if (!Number.isInteger(limit) || limit < 1 || limit > Number.MAX_SAFE_INTEGER - 1) {
    throw new VellumError("INVALID_ARGUMENT", `Delete select limit (${limit}) must be a positive integer`);
  }
  if (!Array.isArray(where)) {
    throw new VellumError("INVALID_ARGUMENT", "Delete select 'where' must be an array");
  }
  let totalDisjunctiveExpansions = validateWhereClauses(where, "where");

  if (!Array.isArray(or)) {
    throw new VellumError("INVALID_ARGUMENT", "Delete select 'or' must be an array of groups");
  }
  if (or.length > SYSTEM_LIMITS.MAX_WHERE_CLAUSES) {
    throw new VellumError(
      "QUERY_TOO_COMPLEX",
      `Delete select contains ${or.length} 'or' groups, exceeding maximum of ${SYSTEM_LIMITS.MAX_WHERE_CLAUSES}`
    );
  }
  const normalizedOr = or.map((group, idx) => {
    if (!Array.isArray(group) || group.length === 0) {
      throw new VellumError("INVALID_ARGUMENT", `Delete select 'or' group ${idx} must be a non-empty array`);
    }
    totalDisjunctiveExpansions += validateWhereClauses(group, `or[${idx}]`);
    return group.map((c) => ({ field: c.field, op: c.op, value: c.value }));
  });
  if (totalDisjunctiveExpansions > MAX_TOTAL_DISJUNCTIVE_EXPANSIONS) {
    throw new VellumError(
      "QUERY_TOO_COMPLEX",
      `Delete select exceeds maximum total disjunctive expansions (${MAX_TOTAL_DISJUNCTIVE_EXPANSIONS})`
    );
  }

  const normalizedQuery: NormalizedQuery = {
    collectionPath: normalizedCollection,
    where: where.map((c) => ({ field: c.field, op: c.op, value: c.value })),
    or: normalizedOr,
    orderBy: [{ field: "documentId", dir: "asc" }],
    limit,
    select: null,
    startAt: null,
    startAfter: null,
  };
  return compileQueryToParameterizedSql({
    projectId,
    normalizedQuery,
    scanCap: null,
  });
}

export function computeIndexDefinitionHash(
  collectionPath: string,
  fields: Array<{ path: string; dir: "asc" | "desc" }>
): string {
  const key = JSON.stringify({ collectionPath, fields });
  const cached = lruGet(indexDefHashCache, key);
  if (cached !== undefined) return cached;
  const hash = crypto
    .createHash("sha256")
    .update(key)
    .digest("hex")
    .slice(0, 32);
  lruSet(indexDefHashCache, key, hash);
  return hash;
}

function unique(list: string[]): string[] {
  return Array.from(new Set(list));
}

export function selectCompositeIndexForQuery(
  normalizedQuery: NormalizedQuery,
  availableIndexes: CompositeIndexMetadata[] = []
): { matchedIndex: CompositeIndexMetadata | null; requiresCompositeIndex: boolean } {
  const customOrderBy = normalizedQuery.orderBy.filter((o) => !isIdSystemField(o.field));
  const equalityFields = unique(
    normalizedQuery.where.filter((w) => w.op === "==").map((w) => w.field)
  );
  const equalitySet = new Set(equalityFields);
  const rangeFields = unique(
    normalizedQuery.where
      .filter((w) => ["<", "<=", ">", ">=", "!=", "not-in"].includes(w.op))
      .map((w) => w.field)
  );

  const requiresCompositeIndex =
    customOrderBy.length > 1 ||
    rangeFields.length > 1 ||
    (rangeFields.length > 0 && customOrderBy.length > 0 && customOrderBy[0]!.field !== rangeFields[0]);

  // Equality-constrained fields that also appear in orderBy enforce their orderBy direction.
  const orderByDirMap = new Map<string, "asc" | "desc">();
  for (const o of customOrderBy) {
    orderByDirMap.set(o.field, o.dir);
  }

  // Remaining orderBy fields (not already covered by equality) must appear in exact
  // order immediately after the equality prefix, with matching sort directions.
  const suffixOrderBy: Array<{ path: string; dir: "asc" | "desc"; enforceDir: boolean }> = [];
  for (const o of customOrderBy) {
    if (!equalitySet.has(o.field)) {
      suffixOrderBy.push({ path: o.field, dir: o.dir, enforceDir: true });
    }
  }
  // If there is a range filter not in equality or orderBy, prefer an index covering it right after equality.
  if (suffixOrderBy.length === 0 && rangeFields.length === 1 && !equalitySet.has(rangeFields[0]!)) {
    suffixOrderBy.push({ path: rangeFields[0]!, dir: "asc", enforceDir: false });
  }

  const requiredCount = equalityFields.length + suffixOrderBy.length;
  if (requiredCount === 0 && !requiresCompositeIndex) {
    return { matchedIndex: null, requiresCompositeIndex };
  }

  let bestMatch: CompositeIndexMetadata | null = null;
  let bestExtraFields = Number.POSITIVE_INFINITY;

  for (const idx of availableIndexes) {
    if (
      !idx ||
      idx.collectionPath !== normalizedQuery.collectionPath ||
      idx.status !== "ready" ||
      !Array.isArray(idx.fields) ||
      idx.fields.length < requiredCount
    ) {
      continue;
    }
    // Stored index rows may carry the legacy field shape ({ path, direction })
    // from clients that bypass the console route's normalization; normalize here
    // so direction comparisons below see a canonical `dir`.
    const idxFields = idx.fields.map((f) => normalizeIndexFieldSpec(f));

    // 1. Leading equality prefix is commutative (any permutation of equalityFields is valid in B-Tree).
    let equalityOk = true;
    const matchedEq = new Set<string>();
    for (let i = 0; i < equalityFields.length; i++) {
      const actual = idxFields[i]!;
      if (!equalitySet.has(actual.path) || matchedEq.has(actual.path)) {
        equalityOk = false;
        break;
      }
      const enforcedDir = orderByDirMap.get(actual.path);
      if (enforcedDir !== undefined && actual.dir !== enforcedDir) {
        equalityOk = false;
        break;
      }
      matchedEq.add(actual.path);
    }
    if (!equalityOk || matchedEq.size !== equalityFields.length) continue;

    // 2. Suffix (orderBy / range) must match strictly in order and direction.
    let suffixOk = true;
    for (let j = 0; j < suffixOrderBy.length; j++) {
      const desired = suffixOrderBy[j]!;
      const actual = idxFields[equalityFields.length + j]!;
      if (actual.path !== desired.path || (desired.enforceDir && actual.dir !== desired.dir)) {
        suffixOk = false;
        break;
      }
    }
    if (!suffixOk) continue;

    // 3. Cost ranking: prefer the tightest (narrowest) index with fewest unused trailing fields.
    const extraFields = idx.fields.length - requiredCount;
    if (extraFields < bestExtraFields) {
      bestExtraFields = extraFields;
      bestMatch = idx;
      if (extraFields === 0) break; // Optimal exact-width match found.
    }
  }

  return { matchedIndex: bestMatch, requiresCompositeIndex };
}

/** Collection size above which a query that no index can serve is refused (env override below). */
export const DEFAULT_UNINDEXED_QUERY_MAX_DOCS = 50_000;

/** Reads VELLUM_UNINDEXED_QUERY_MAX_DOCS. 0 disables the guard; unset or invalid uses the default. */
export function resolveUnindexedQueryMaxDocs(env: Record<string, string | undefined> = process.env): number {
  const raw = env["VELLUM_UNINDEXED_QUERY_MAX_DOCS"];
  if (raw === undefined || raw.trim() === "") return DEFAULT_UNINDEXED_QUERY_MAX_DOCS;
  const n = Number(raw);
  return Number.isInteger(n) && n >= 0 ? n : DEFAULT_UNINDEXED_QUERY_MAX_DOCS;
}

const GIN_SERVED_OPS = new Set(["==", "in", "array-contains", "array-contains-any"]);

/**
 * True when no index can serve the query, so the database has to read the collection:
 * a range, "!=", "not-in" or text filter, a full-text `search`, or an order on a field that
 * is not documentId/createdAt/updatedAt. Equality, "in" and array-contains are served by the
 * GIN index, and system-field orders by btrees.
 */
export function isScanRiskQuery(q: NormalizedQuery): boolean {
  if (q.search) return true;
  const groups = [q.where, ...(q.or ?? [])];
  for (const group of groups) {
    for (const clause of group ?? []) {
      if (isIdSystemField(clause.field)) continue;
      if (isTimestampSystemFieldName(clause.field) && q.orderBy[0]?.field === clause.field) continue;
      if (!GIN_SERVED_OPS.has(clause.op)) return true;
    }
  }
  return q.orderBy.some((o) => !isIdSystemField(o.field) && !isTimestampSystemFieldName(o.field));
}

function isTimestampSystemFieldName(field: string): boolean {
  return field === "createdAt" || field === "updatedAt";
}

/** The composite index that would serve this query: equality fields, then the order or range field. */
export function suggestCompositeIndex(q: NormalizedQuery): Array<{ path: string; dir: "asc" | "desc" }> {
  const fields: Array<{ path: string; dir: "asc" | "desc" }> = [];
  const seen = new Set<string>();
  const add = (path: string, dir: "asc" | "desc") => {
    if (isIdSystemField(path) || seen.has(path)) return;
    seen.add(path);
    fields.push({ path, dir });
  };
  for (const w of q.where) if (w.op === "==") add(w.field, "asc");
  for (const o of q.orderBy) add(o.field, o.dir);
  for (const w of q.where) if (!GIN_SERVED_OPS.has(w.op)) add(w.field, "asc");
  return fields;
}
