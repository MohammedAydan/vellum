/**
 * @vellum/storage - Native Aggregations & Bulk-Delete Primitives
 *
 * Shared, tenant-safe building blocks used by the PostgreSQL, Neon and
 * in-memory adapters. All SQL is parameterized; every statement is executed
 * inside `withTransaction` so the transaction-local RLS context is always set.
 *
 * The request/response shapes are defined structurally here (never imported
 * from `@vellum/document-engine`) so the two packages remain mutually
 * assignable without a circular dependency.
 */

import { VellumError, SYSTEM_LIMITS, validateFieldName } from "@vellum/core";
import {
  compileWhereClause,
  compileDeleteSelectQuery,
  extractDocFieldValue,
  documentMatchesQuery,
  type CompiledQuery,
  type WhereClause,
  type NormalizedQuery,
} from "@vellum/query-engine";
import type {
  TenantContext,
  DocumentRecord,
  OutboxEvent,
  OutboxMutation,
  QueriedDocument,
} from "./types.js";

export type AggregateMetricOp = "count" | "sum" | "avg" | "min" | "max";

export interface AggregateMetric {
  op: AggregateMetricOp;
  field?: string | undefined;
}

export interface AggregateRequest {
  collectionPath: string;
  where?: WhereClause[] | undefined;
  or?: WhereClause[][] | undefined;
  groupBy?: string[] | undefined;
  metrics: Record<string, AggregateMetric>;
}

export interface AggregateRow {
  [key: string]: unknown;
}

export interface DeleteWhereOptions {
  or?: WhereClause[][] | undefined;
  limit: number;
}

const MAX_GROUP_BY_FIELDS = 16;
const MAX_AGGREGATE_METRICS = 32;
const MAX_ALIAS_LENGTH = 128;
const FORBIDDEN_PROP_NAMES: ReadonlySet<string> = new Set([
  "__proto__",
  "constructor",
  "prototype",
]);
const NUMERIC_LITERAL_RE = "^-?[0-9]+(\\.[0-9]+)?$";

function assertSafePropertyName(name: string, label: string): void {
  if (FORBIDDEN_PROP_NAMES.has(name)) {
    throw new VellumError(
      "INVALID_ARGUMENT",
      `Forbidden ${label} name '${name}'`,
      { label, name }
    );
  }
}

function setSafeProp(target: AggregateRow, key: string, value: unknown): void {
  if (FORBIDDEN_PROP_NAMES.has(key)) return;
  Object.defineProperty(target, key, {
    value,
    enumerable: true,
    writable: true,
    configurable: true,
  });
}

/* -------------------------------------------------------------------------- */
/* Validation                                                                 */
/* -------------------------------------------------------------------------- */

function validateClauses(clauses: WhereClause[], label: string): void {
  if (!Array.isArray(clauses)) {
    throw new VellumError("INVALID_ARGUMENT", `Aggregate ${label} must be an array`);
  }
  if (clauses.length > SYSTEM_LIMITS.MAX_WHERE_CLAUSES) {
    throw new VellumError(
      "QUERY_TOO_COMPLEX",
      `Aggregate ${label} contains ${clauses.length} clauses, exceeding maximum of ${SYSTEM_LIMITS.MAX_WHERE_CLAUSES}`,
      { label, count: clauses.length }
    );
  }
}

function validateGroupFields(fields: string[]): void {
  if (!Array.isArray(fields)) {
    throw new VellumError("INVALID_ARGUMENT", "Aggregate groupBy must be an array of field names");
  }
  if (fields.length > MAX_GROUP_BY_FIELDS) {
    throw new VellumError(
      "QUERY_TOO_COMPLEX",
      `Aggregate groupBy contains ${fields.length} fields, exceeding maximum of ${MAX_GROUP_BY_FIELDS}`,
      { count: fields.length, max: MAX_GROUP_BY_FIELDS }
    );
  }
  for (const field of fields) {
    if (typeof field !== "string" || field.length === 0 || field.includes("\0")) {
      throw new VellumError("INVALID_ARGUMENT", "Aggregate field path must be a non-empty string without NUL bytes");
    }
    assertSafePropertyName(field, "field");
    for (const part of field.split(".")) {
      assertSafePropertyName(part, "field segment");
      validateFieldName(part);
    }
  }
}

/** Validates an aggregate request at the storage boundary (defense in depth). */
export function validateAggregateRequest(request: AggregateRequest): void {
  if (
    !request ||
    typeof request !== "object" ||
    typeof request.collectionPath !== "string" ||
    request.collectionPath.trim().length === 0 ||
    request.collectionPath.includes("\0")
  ) {
    throw new VellumError("INVALID_ARGUMENT", "Aggregate request requires a valid non-empty collectionPath");
  }
  const where = request.where ?? [];
  validateClauses(where, "where");
  const or = request.or ?? [];
  if (!Array.isArray(or)) {
    throw new VellumError("INVALID_ARGUMENT", "Aggregate 'or' must be an array of clause groups");
  }
  if (or.length > SYSTEM_LIMITS.MAX_WHERE_CLAUSES) {
    throw new VellumError("QUERY_TOO_COMPLEX", `Aggregate 'or' has ${or.length} groups (maximum 10)`);
  }
  for (const group of or) {
    validateClauses(group, "or group");
  }
  validateGroupFields(request.groupBy ?? []);
  if (!request.metrics || typeof request.metrics !== "object" || Array.isArray(request.metrics)) {
    throw new VellumError("INVALID_ARGUMENT", "Aggregate request requires at least one metric");
  }
  const metricEntries = Object.entries(request.metrics);
  if (metricEntries.length === 0) {
    throw new VellumError("INVALID_ARGUMENT", "Aggregate request requires at least one metric");
  }
  if (metricEntries.length > MAX_AGGREGATE_METRICS) {
    throw new VellumError(
      "QUERY_TOO_COMPLEX",
      `Aggregate request defines ${metricEntries.length} metrics, exceeding maximum of ${MAX_AGGREGATE_METRICS}`,
      { count: metricEntries.length, max: MAX_AGGREGATE_METRICS }
    );
  }
  for (const [alias, metric] of metricEntries) {
    if (alias.length === 0 || alias.length > MAX_ALIAS_LENGTH || alias.includes("\0")) {
      throw new VellumError("INVALID_ARGUMENT", `Invalid aggregate metric alias '${alias}'`);
    }
    assertSafePropertyName(alias, "metric alias");
    if (!metric || !["count", "sum", "avg", "min", "max"].includes(metric.op)) {
      throw new VellumError("INVALID_ARGUMENT", `Invalid aggregate metric '${alias}'`);
    }
    if (metric.op !== "count" && (typeof metric.field !== "string" || metric.field.length === 0)) {
      throw new VellumError(
        "INVALID_ARGUMENT",
        `Metric '${alias}' (${metric.op}) requires a field`,
        { alias, op: metric.op }
      );
    }
    if (metric.field !== undefined) validateGroupFields([metric.field]);
  }
}

/** Validates and bounds a bulk-delete selection. Returns the effective limit. */
export function validateDeleteWhere(
  where: WhereClause[],
  options: DeleteWhereOptions
): number {
  validateClauses(where, "where");
  const or = options.or ?? [];
  if (!Array.isArray(or)) {
    throw new VellumError("INVALID_ARGUMENT", "Bulk delete 'or' must be an array of clause groups");
  }
  if (or.length > SYSTEM_LIMITS.MAX_WHERE_CLAUSES) {
    throw new VellumError("QUERY_TOO_COMPLEX", `Bulk delete 'or' has ${or.length} groups (maximum 10)`);
  }
  for (const group of or) validateClauses(group, "or group");
  const requested = options.limit === undefined ? 1000 : Number(options.limit);
  if (!Number.isInteger(requested) || requested < 1) {
    throw new VellumError("INVALID_ARGUMENT", `Bulk delete limit must be a positive integer, got ${options.limit}`);
  }
  // Hard cap: never allow an unbounded bulk delete.
  return Math.min(requested, 5000);
}

/* -------------------------------------------------------------------------- */
/* SQL compilation                                                            */
/* -------------------------------------------------------------------------- */

function addParam(params: unknown[], value: unknown): string {
  params.push(value);
  return `$${params.length}`;
}

function quoteAlias(name: string): string {
  if (name.length === 0 || name.includes("\0")) {
    throw new VellumError("INVALID_ARGUMENT", "SQL identifier alias must be non-empty and contain no NUL bytes");
  }
  return `"${name.replace(/"/g, '""')}"`;
}

/**
 * Per-compilation parameter & expression cache so repeated references to the
 * same field (e.g. sum/avg/min/max on `amount`) reuse the same bind parameter
 * slots instead of emitting duplicate text[] arrays.
 */
interface CompileFieldCache {
  textExprs: Map<string, string>;
  numericExprs: Map<string, string>;
}

/** Text expression for a group field (system columns or a JSONB dot path). */
function aggregateTextExpr(field: string, params: unknown[], cache: CompileFieldCache): string {
  const cached = cache.textExprs.get(field);
  if (cached !== undefined) return cached;

  let expr: string;
  if (field === "documentId" || field === "__name__") {
    expr = "d.document_id::text";
  } else if (field === "createdAt" || field === "updatedAt") {
    expr = `d.${field === "createdAt" ? "created_at" : "updated_at"}::text`;
  } else {
    const p = addParam(params, field.split("."));
    expr = `(d.data #>> ${p}::text[])`;
  }
  cache.textExprs.set(field, expr);
  return expr;
}

/**
 * Numeric expression that ignores non-numeric JSON values (including tagged
 * timestamps and malformed tagged ints) instead of throwing on a `::numeric`
 * cast. Tagged int64 values (`{ $t: 'int', $v: '…' }`) are validated before
 * coercion so crafted documents cannot DoS aggregate queries with 22P02 errors.
 */
function aggregateNumericExpr(field: string, params: unknown[], cache: CompileFieldCache): string {
  const cached = cache.numericExprs.get(field);
  if (cached !== undefined) return cached;

  let expr: string;
  if (field === "documentId" || field === "__name__") {
    expr = "NULL::numeric";
  } else if (field === "createdAt" || field === "updatedAt") {
    expr = `extract(epoch from d.${field === "createdAt" ? "created_at" : "updated_at"})`;
  } else {
    const parts = field.split(".");
    const p = addParam(params, parts);
    const t = addParam(params, [...parts, "$t"]);
    const v = addParam(params, [...parts, "$v"]);
    expr =
      `(CASE WHEN jsonb_typeof(d.data #> ${p}::text[]) = 'number' THEN (d.data #>> ${p}::text[])::numeric ` +
      `WHEN d.data #>> ${t}::text[] = 'int' AND (d.data #>> ${v}::text[]) ~ '${NUMERIC_LITERAL_RE}' ` +
      `THEN (d.data #>> ${v}::text[])::numeric ELSE NULL END)`;
  }
  cache.numericExprs.set(field, expr);
  return expr;
}

/**
 * Builds the complete parameterized aggregate SELECT. The project id and the
 * collection path occupy $1..$2; where/or predicates and field paths follow.
 */
export function compileAggregateSql(
  ctx: TenantContext,
  request: AggregateRequest
): { sql: string; params: unknown[] } {
  validateAggregateRequest(request);
  const params: unknown[] = [ctx.projectId, request.collectionPath];
  const fieldCache: CompileFieldCache = {
    textExprs: new Map(),
    numericExprs: new Map(),
  };
  const predicates: string[] = [
    "d.project_id = $1::uuid",
    "d.collection_path = $2",
    "d.deleted_at IS NULL",
    "(d.expires_at IS NULL OR d.expires_at > now())",
  ];

  for (const clause of request.where ?? []) {
    predicates.push(compileWhereClause(clause, params));
  }
  const orGroups = request.or ?? [];
  if (orGroups.length > 0) {
    const groupSql = orGroups.map((group) => {
      const parts = group.map((clause) => compileWhereClause(clause, params));
      return `(${parts.join(" AND ")})`;
    });
    predicates.push(`(${groupSql.join(" OR ")})`);
  }

  const selectParts: string[] = [];
  const groupByParts: string[] = [];
  for (const field of request.groupBy ?? []) {
    const expr = aggregateTextExpr(field, params, fieldCache);
    selectParts.push(`${expr} AS ${quoteAlias(field)}`);
    groupByParts.push(expr);
  }

  for (const [alias, metric] of Object.entries(request.metrics)) {
    let expr: string;
    switch (metric.op) {
      case "count":
        expr =
          metric.field !== undefined
            ? `COUNT(${aggregateTextExpr(metric.field, params, fieldCache)})`
            : "COUNT(*)";
        break;
      case "sum":
        expr = `SUM(${aggregateNumericExpr(metric.field!, params, fieldCache)})`;
        break;
      case "avg":
        expr = `AVG(${aggregateNumericExpr(metric.field!, params, fieldCache)})`;
        break;
      case "min":
        expr = `MIN(${aggregateNumericExpr(metric.field!, params, fieldCache)})`;
        break;
      case "max":
        expr = `MAX(${aggregateNumericExpr(metric.field!, params, fieldCache)})`;
        break;
    }
    selectParts.push(`${expr} AS ${quoteAlias(alias)}`);
  }

  const sql =
    `SELECT ${selectParts.join(", ")} FROM documents d WHERE ${predicates.join(" AND ")}` +
    (groupByParts.length > 0 ? ` GROUP BY ${groupByParts.join(", ")}` : "") +
    ";";
  return { sql, params };
}

/** Coerces PostgreSQL `numeric`/`bigint` string results into JS numbers/null. */
export function normalizeAggregateRows(
  rows: AggregateRow[],
  request: AggregateRequest
): AggregateRow[] {
  const metricEntries = Object.entries(request.metrics);
  return rows.map((raw) => {
    const row: AggregateRow = {};
    for (const [k, v] of Object.entries(raw)) {
      setSafeProp(row, k, v);
    }
    for (const [alias, metric] of metricEntries) {
      if (FORBIDDEN_PROP_NAMES.has(alias)) continue;
      const value = Object.prototype.hasOwnProperty.call(row, alias) ? row[alias] : undefined;
      if (value === null || value === undefined) {
        setSafeProp(row, alias, null);
      } else {
        const num = typeof value === "number" ? value : Number(value);
        setSafeProp(row, alias, metric.op === "count" || Number.isFinite(num) ? num : null);
      }
    }
    return row;
  });
}

/* -------------------------------------------------------------------------- */
/* In-memory equivalents (same semantics as the SQL above)                   */
/* -------------------------------------------------------------------------- */

function toNumeric(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    const rec = value as Record<string, unknown>;
    if (rec["$t"] === "int" && typeof rec["$v"] === "string") {
      const n = Number(rec["$v"]);
      return Number.isFinite(n) ? n : null;
    }
    if (rec["$t"] === "ts" && typeof rec["$ms"] === "number") {
      return rec["$ms"] / 1000;
    }
  }
  if (typeof value === "string" && value.trim() !== "") {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/** Single-pass, allocation-free metric evaluator (safe for >100k docs without call-stack overflow). */
function computeMetric(metric: AggregateMetric, docs: DocumentRecord[]): number | null {
  if (metric.op === "count") {
    if (metric.field === undefined) return docs.length;
    let count = 0;
    const field = metric.field;
    for (let i = 0; i < docs.length; i++) {
      const value = extractDocFieldValue(docs[i]!, field);
      if (value !== undefined && value !== null) count += 1;
    }
    return count;
  }
  const field = metric.field!;
  let count = 0;
  let sum = 0;
  let min = Infinity;
  let max = -Infinity;
  for (let i = 0; i < docs.length; i++) {
    const n = toNumeric(extractDocFieldValue(docs[i]!, field));
    if (n === null) continue;
    count += 1;
    if (metric.op === "sum" || metric.op === "avg") sum += n;
    else if (metric.op === "min") {
      if (n < min) min = n;
    } else if (metric.op === "max") {
      if (n > max) max = n;
    }
  }
  if (count === 0) return null;
  switch (metric.op) {
    case "sum":
      return sum;
    case "avg":
      return sum / count;
    case "min":
      return min;
    case "max":
      return max;
  }
}

function groupKeyOf(keyValues: unknown[]): string {
  if (keyValues.length === 1) {
    const v = keyValues[0];
    if (v === null) return "null";
    const t = typeof v;
    if (t === "string") return `s:${v as string}`;
    if (t === "number") return `n:${v as number}`;
    if (t === "boolean") return v ? "b:1" : "b:0";
  }
  return JSON.stringify(keyValues);
}

/** Aggregates an already-filtered set of documents with SQL-equivalent semantics. */
export function aggregateRowsInMemory(
  docs: DocumentRecord[],
  request: AggregateRequest
): AggregateRow[] {
  const groupFields = request.groupBy ?? [];
  const metricEntries = Object.entries(request.metrics);
  const buildRow = (keyValues: unknown[], groupDocs: DocumentRecord[]): AggregateRow => {
    const row: AggregateRow = {};
    for (let i = 0; i < groupFields.length; i++) {
      setSafeProp(row, groupFields[i]!, keyValues[i] ?? null);
    }
    for (let i = 0; i < metricEntries.length; i++) {
      const [alias, metric] = metricEntries[i]!;
      setSafeProp(row, alias, computeMetric(metric, groupDocs));
    }
    return row;
  };

  if (groupFields.length === 0) return [buildRow([], docs)];

  const groups = new Map<string, { keyValues: unknown[]; docs: DocumentRecord[] }>();
  for (let i = 0; i < docs.length; i++) {
    const doc = docs[i]!;
    const keyValues = new Array<unknown>(groupFields.length);
    for (let j = 0; j < groupFields.length; j++) {
      keyValues[j] = extractDocFieldValue(doc, groupFields[j]!) ?? null;
    }
    const key = groupKeyOf(keyValues);
    let group = groups.get(key);
    if (!group) {
      group = { keyValues, docs: [] };
      groups.set(key, group);
    }
    group.docs.push(doc);
  }
  const result: AggregateRow[] = [];
  for (const group of groups.values()) {
    result.push(buildRow(group.keyValues, group.docs));
  }
  return result;
}

/** Applies where/or filtering to live documents for the in-memory adapter. */
export function filterDocumentsForAggregate(
  docs: DocumentRecord[],
  request: AggregateRequest
): DocumentRecord[] {
  const query: NormalizedQuery = {
    collectionPath: request.collectionPath,
    where: request.where ?? [],
    or: request.or ?? [],
    orderBy: [{ field: "documentId", dir: "asc" }],
    limit: Number.MAX_SAFE_INTEGER,
    select: null,
    startAt: null,
    startAfter: null,
  };
  return docs.filter((doc) => documentMatchesQuery(doc, query));
}

/* -------------------------------------------------------------------------- */
/* Bulk delete staging                                                        */
/* -------------------------------------------------------------------------- */

/** Minimal tx surface needed to stage tombstones + outbox events atomically. */
export interface DeleteStageTx {
  putDocumentRows?(rows: DocumentRecord[]): Promise<void>;
  putDocumentRow(row: DocumentRecord): Promise<void>;
  appendOutboxEvents?(events: OutboxMutation[]): Promise<OutboxEvent[]>;
  appendOutboxEvent(event: OutboxMutation): Promise<OutboxEvent>;
}

export interface DeleteStageResult {
  deletedCount: number;
  events: OutboxEvent[];
}

/**
 * Tombstones the given live documents and emits one `deleted` outbox event per
 * row. All writes are issued on the SAME transaction handle, so they commit
 * atomically with the selection and never bypass RLS. Uses batched outbox
 * insertion when supported by the transaction handle to avoid N+1 round trips.
 */
export async function stageDeletesInTx(
  tx: DeleteStageTx,
  docs: DocumentRecord[],
  nowIso: string
): Promise<DeleteStageResult> {
  if (docs.length === 0) return { deletedCount: 0, events: [] };

  const tombstones: DocumentRecord[] = [];
  const mutations: OutboxMutation[] = [];
  for (const doc of docs) {
    const version = doc.version + 1;
    tombstones.push({
      ...doc,
      version,
      updatedAt: nowIso,
      deletedAt: nowIso,
    });
    mutations.push({
      collectionPath: doc.collectionPath,
      path: doc.path,
      documentId: doc.documentId,
      opType: "deleted",
      version,
      beforeData: doc.data,
      afterData: null,
    });
  }

  let events: OutboxEvent[];
  if (typeof tx.appendOutboxEvents === "function") {
    events = await tx.appendOutboxEvents(mutations);
  } else {
    events = [];
    for (const mutation of mutations) {
      events.push(await tx.appendOutboxEvent(mutation));
    }
  }

  if (typeof tx.putDocumentRows === "function") {
    await tx.putDocumentRows(tombstones);
  } else {
    for (const row of tombstones) await tx.putDocumentRow(row);
  }
  return { deletedCount: tombstones.length, events };
}

/** Selects matching live docs (bounded, TTL-safe) and stages their tombstones. */
export async function executeDeleteWhereInTx(
  tx: DeleteStageTx & { queryDocuments(compiled: CompiledQuery): Promise<QueriedDocument[]> },
  ctx: TenantContext,
  collectionPath: string,
  where: WhereClause[],
  options: DeleteWhereOptions,
  nowIso: string
): Promise<DeleteStageResult> {
  const limit = validateDeleteWhere(where, options);
  const compiled = compileDeleteSelectQuery({
    projectId: ctx.projectId,
    collectionPath,
    where,
    or: options.or ?? [],
    limit,
  });
  const docs = await tx.queryDocuments(compiled);
  return stageDeletesInTx(tx, docs.slice(0, limit), nowIso);
}
