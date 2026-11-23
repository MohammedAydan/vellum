/**
 * @vellum/query-engine - SQL Operator Fragments & High-Performance Predicate Evaluation
 *
 * Security & Reliability hardening:
 * - Prototype-pollution protection in `buildNestedJsonObject` and `extractDocFieldValue`.
 * - Strict type-parity for range operators (`<`, `<=`, `>`, `>=`) matching PostgreSQL SQL semantics.
 * - Optional TTL (`expiresAt`) enforcement in `documentMatchesQuery` matching SQL live-read filters.
 * - Single-pass `escapeLikePattern` regex and optional pre-compiled `createQueryEvaluator` fast path.
 */

import { VellumError, wireValuesEqual, compareWireValues, getFieldByPath } from "@vellum/core";
import type {
  WhereClause,
  NormalizedQuery,
  EvaluatableDocumentRecord,
  QueryableDocumentRecord,
  CompiledQueryEvaluator,
} from "./types.js";

const LIKE_ESCAPE_RE = /[\\_%]/g;
const TEXT_SPLIT_RE = /[^\p{L}\p{N}]+/u;
const FORBIDDEN_PATH_SEGMENTS = new Set(["__proto__", "constructor", "prototype"]);
const HAS_OWN = Object.prototype.hasOwnProperty;

type ComparableKind = "number" | "string" | "int" | "ts";

/**
 * Escapes the three characters that are special to SQL `LIKE`/`ILIKE` patterns.
 * The SQL emitted for `contains_ci` / `starts_with_ci` uses `ESCAPE '\'`, so a
 * literal backslash must be doubled first, then `%` and `_` prefixed.
 * Single-pass regex minimizes intermediate string allocations.
 * User input is always bound as a parameter — it is never concatenated into SQL.
 */
export function escapeLikePattern(value: string): string {
  return value.replace(LIKE_ESCAPE_RE, (ch) => `\\${ch}`);
}

/** Splits text into lowercase lexemes, mirroring PostgreSQL's `simple` text-search config. */
function simpleTextTokens(text: string): string[] {
  const raw = text.toLowerCase().split(TEXT_SPLIT_RE);
  const out: string[] = [];
  for (let i = 0; i < raw.length; i++) {
    const token = raw[i]!;
    if (token.length > 0) out.push(token);
  }
  return out;
}

/** Classifies a value into its SQL-comparable kind so cross-type range comparisons return false. */
function comparableKind(value: unknown): ComparableKind | null {
  if (typeof value === "number" && Number.isFinite(value)) return "number";
  if (typeof value === "string") return "string";
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    const tag = (value as Record<string, unknown>)["$t"];
    if (tag === "int") return "int";
    if (tag === "ts") return "ts";
  }
  return null;
}

function isPrimitive(value: unknown): value is string | number | boolean | null {
  return value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean";
}

export function buildNestedJsonObject(dotPath: string, leafValue: unknown): Record<string, unknown> {
  if (typeof dotPath !== "string" || dotPath.length === 0) {
    throw new VellumError("INVALID_ARGUMENT", "Field path must be a non-empty string");
  }
  const parts = dotPath.split(".");
  const root: Record<string, unknown> = Object.create(null);
  let curr = root;
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i]!;
    if (part.length === 0 || FORBIDDEN_PATH_SEGMENTS.has(part)) {
      throw new VellumError("INVALID_ARGUMENT", `Invalid or forbidden field path segment '${part}'`);
    }
    if (i < parts.length - 1) {
      const next: Record<string, unknown> = Object.create(null);
      curr[part] = next;
      curr = next;
    } else {
      curr[part] = leafValue;
    }
  }
  return root;
}

export function extractDocFieldValue(
  docRecord: EvaluatableDocumentRecord,
  fieldPath: string
): unknown {
  if (fieldPath === "documentId" || fieldPath === "__name__") return docRecord.documentId;
  if (fieldPath === "createdAt" || fieldPath === "updatedAt") {
    const iso = fieldPath === "createdAt" ? docRecord.createdAt : docRecord.updatedAt;
    return { $t: "ts", $v: iso, $ms: Date.parse(iso) };
  }
  const data = docRecord.data;
  if (!data || typeof data !== "object") return undefined;

  // Guard against prototype-chain traversal (e.g. `toString`, `constructor`, `__proto__`).
  if (FORBIDDEN_PATH_SEGMENTS.has(fieldPath)) return undefined;

  // Projected query rows carry a FLAT map keyed by full dot path (e.g.
  // { "author.name": "Ada" }). Prefer own-property exact key before walking the path.
  if (HAS_OWN.call(data, fieldPath)) return data[fieldPath];

  // Fast path for single-segment fields (avoids split/loop overhead when key is absent).
  if (fieldPath.indexOf(".") === -1) return undefined;

  return getFieldByPath(data, fieldPath);
}

interface EvaluationContext {
  docTokens?: Set<string>;
}

function getDocTokens(docRecord: EvaluatableDocumentRecord, ctx?: EvaluationContext): Set<string> {
  if (ctx?.docTokens) return ctx.docTokens;
  const tokens = new Set(simpleTextTokens(JSON.stringify(docRecord.data ?? {})));
  if (ctx) ctx.docTokens = tokens;
  return tokens;
}

function evaluateWhereClause(
  docRecord: EvaluatableDocumentRecord,
  clause: WhereClause,
  ctx?: EvaluationContext
): boolean {
  if (clause.op === "text_search") {
    if (typeof clause.value !== "string") return false;
    const queryTokens = simpleTextTokens(clause.value);
    if (queryTokens.length === 0) return false;
    const docTokens = getDocTokens(docRecord, ctx);
    for (let i = 0; i < queryTokens.length; i++) {
      if (!docTokens.has(queryTokens[i]!)) return false;
    }
    return true;
  }

  const fieldVal = extractDocFieldValue(docRecord, clause.field);
  switch (clause.op) {
    case "==":
      return fieldVal !== undefined && wireValuesEqual(fieldVal, clause.value);
    case "!=":
      return fieldVal !== undefined && !wireValuesEqual(fieldVal, clause.value);
    case "<":
    case "<=":
    case ">":
    case ">=": {
      if (fieldVal === undefined || fieldVal === null || clause.value === null) return false;
      // Enforce SQL type-parity: never match across incompatible types (e.g. string vs number).
      const fieldKind = comparableKind(fieldVal);
      const boundKind = comparableKind(clause.value);
      if (fieldKind === null || boundKind === null || fieldKind !== boundKind) return false;
      const cmp = compareWireValues(fieldVal, clause.value, "asc");
      if (clause.op === "<") return cmp < 0;
      if (clause.op === "<=") return cmp <= 0;
      if (clause.op === ">") return cmp > 0;
      return cmp >= 0;
    }
    case "in":
      return (
        fieldVal !== undefined &&
        Array.isArray(clause.value) &&
        clause.value.some((target) => wireValuesEqual(fieldVal, target))
      );
    case "not-in":
      return (
        fieldVal !== undefined &&
        Array.isArray(clause.value) &&
        !clause.value.some((target) => wireValuesEqual(fieldVal, target))
      );
    case "array-contains":
      return Array.isArray(fieldVal) && fieldVal.some((el) => wireValuesEqual(el, clause.value));
    case "array-contains-any":
      return (
        Array.isArray(fieldVal) &&
        Array.isArray(clause.value) &&
        fieldVal.some((el) => (clause.value as unknown[]).some((target) => wireValuesEqual(el, target)))
      );
    case "contains_ci":
      return (
        typeof fieldVal === "string" &&
        typeof clause.value === "string" &&
        fieldVal.toLowerCase().includes(clause.value.toLowerCase())
      );
    case "starts_with_ci":
      return (
        typeof fieldVal === "string" &&
        typeof clause.value === "string" &&
        fieldVal.toLowerCase().startsWith(clause.value.toLowerCase())
      );
    default:
      return false;
  }
}

export function documentMatchesWhereClause(
  docRecord: EvaluatableDocumentRecord,
  clause: WhereClause
): boolean {
  return evaluateWhereClause(docRecord, clause);
}

function isDocumentLive(docRecord: QueryableDocumentRecord, nowMs: number): boolean {
  if (docRecord.deletedAt !== null && docRecord.deletedAt !== undefined) return false;
  if (docRecord.expiresAt !== null && docRecord.expiresAt !== undefined) {
    const expMs = Date.parse(docRecord.expiresAt);
    if (Number.isFinite(expMs) && expMs <= nowMs) return false;
  }
  return true;
}

export function documentMatchesQuery(
  docRecord: QueryableDocumentRecord,
  normalizedQuery: NormalizedQuery
): boolean {
  if (!isDocumentLive(docRecord, Date.now())) return false;
  if (docRecord.collectionPath !== normalizedQuery.collectionPath) return false;
  if (normalizedQuery.search && !`${docRecord.documentId} ${JSON.stringify(docRecord.data)}`
    .toLowerCase().includes(normalizedQuery.search.toLowerCase())) return false;

  const ctx: EvaluationContext = {};
  const where = normalizedQuery.where;
  for (let i = 0; i < where.length; i++) {
    if (!evaluateWhereClause(docRecord, where[i]!, ctx)) return false;
  }

  const orGroups = normalizedQuery.or ?? [];
  if (orGroups.length === 0) return true;

  for (let g = 0; g < orGroups.length; g++) {
    const group = orGroups[g]!;
    let allMatch = true;
    for (let c = 0; c < group.length; c++) {
      if (!evaluateWhereClause(docRecord, group[c]!, ctx)) {
        allMatch = false;
        break;
      }
    }
    if (allMatch) return true;
  }
  return false;
}

/**
 * Pre-compiles a `NormalizedQuery` into a reusable high-throughput in-memory predicate.
 * Pre-lowercases text needles, pre-tokenizes `text_search` queries, and indexes primitive
 * `in` / `not-in` / `array-contains-any` sets into O(1) `Set` lookups.
 */
export function createQueryEvaluator(normalizedQuery: NormalizedQuery): CompiledQueryEvaluator {
  type CompiledClause = (doc: EvaluatableDocumentRecord, ctx: EvaluationContext) => boolean;

  const compileOne = (clause: WhereClause): CompiledClause => {
    const { field, op, value } = clause;
    switch (op) {
      case "contains_ci": {
        if (typeof value !== "string") return () => false;
        const needle = value.toLowerCase();
        return (doc) => {
          const v = extractDocFieldValue(doc, field);
          return typeof v === "string" && v.toLowerCase().includes(needle);
        };
      }
      case "starts_with_ci": {
        if (typeof value !== "string") return () => false;
        const prefix = value.toLowerCase();
        return (doc) => {
          const v = extractDocFieldValue(doc, field);
          return typeof v === "string" && v.toLowerCase().startsWith(prefix);
        };
      }
      case "text_search": {
        if (typeof value !== "string") return () => false;
        const queryTokens = simpleTextTokens(value);
        if (queryTokens.length === 0) return () => false;
        return (doc, ctx) => {
          const docTokens = getDocTokens(doc, ctx);
          for (let i = 0; i < queryTokens.length; i++) {
            if (!docTokens.has(queryTokens[i]!)) return false;
          }
          return true;
        };
      }
      case "in":
      case "not-in": {
        if (!Array.isArray(value)) return () => false;
        const negated = op === "not-in";
        const allPrim = value.every(isPrimitive);
        if (allPrim) {
          const set = new Set<unknown>(value);
          return (doc) => {
            const v = extractDocFieldValue(doc, field);
            if (v === undefined) return false;
            const found = isPrimitive(v) && set.has(v);
            return negated ? !found : found;
          };
        }
        return (doc, ctx) => evaluateWhereClause(doc, clause, ctx);
      }
      case "array-contains-any": {
        if (!Array.isArray(value)) return () => false;
        const allPrim = value.every(isPrimitive);
        if (allPrim) {
          const set = new Set<unknown>(value);
          return (doc) => {
            const v = extractDocFieldValue(doc, field);
            if (!Array.isArray(v)) return false;
            for (let i = 0; i < v.length; i++) {
              if (isPrimitive(v[i]) && set.has(v[i])) return true;
            }
            return false;
          };
        }
        return (doc, ctx) => evaluateWhereClause(doc, clause, ctx);
      }
      default:
        return (doc, ctx) => evaluateWhereClause(doc, clause, ctx);
    }
  };

  const compiledWhere = normalizedQuery.where.map(compileOne);
  const compiledOr = (normalizedQuery.or ?? []).map((group) => group.map(compileOne));
  const targetCollection = normalizedQuery.collectionPath;

  return (docRecord: QueryableDocumentRecord): boolean => {
    if (!isDocumentLive(docRecord, Date.now())) return false;
    if (docRecord.collectionPath !== targetCollection) return false;
    if (normalizedQuery.search && !`${docRecord.documentId} ${JSON.stringify(docRecord.data)}`
      .toLowerCase().includes(normalizedQuery.search.toLowerCase())) return false;

    const ctx: EvaluationContext = {};
    for (let i = 0; i < compiledWhere.length; i++) {
      if (!compiledWhere[i]!(docRecord, ctx)) return false;
    }

    if (compiledOr.length === 0) return true;
    for (let g = 0; g < compiledOr.length; g++) {
      const group = compiledOr[g]!;
      let matched = true;
      for (let c = 0; c < group.length; c++) {
        if (!group[c]!(docRecord, ctx)) {
          matched = false;
          break;
        }
      }
      if (matched) return true;
    }
    return false;
  };
}
