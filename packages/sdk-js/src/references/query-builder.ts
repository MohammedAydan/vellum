/**
 * @vellumdb/sdk-js - Immutable QueryBuilder
 *
 * Supports all 13 filter operators (including V2 `contains_ci`, `starts_with_ci`,
 * `text_search`), disjunctive `or()`, eager `include()`, dot-path `select()`,
 * `orderBy()`, `limit()`, `startAt()`/`startAfter()`, bounded-memory async
 * pagination (`pages()` / `stream()`), server-side `aggregate()` helpers,
 * `deleteWhere()`, `withConverter<U>()`, and realtime `onSnapshot()`.
 */

import { createAbortError } from "../core/backoff.js";
import { encodeResourcePath } from "../core/safe-json.js";
import type {
  AggregateInput,
  AggregateResultPayload,
  AggregateRow,
  BulkDeleteResult,
  DocDataConverter,
  DocumentSnapshot,
  IncludeSpec,
  IncludeSpecInput,
  QueryBuilderInterface,
  QueryGetOptions,
  QuerySnapshot,
  QuerySpecPayload,
  QueryStreamOptions,
  RealtimeSnapshot,
  RealtimeListenOptions,
  RequestOptions,
  WhereClause,
} from "../types.js";
import { buildQuerySnapshot, normalizeInclude, type WireDocument } from "./snapshots.js";

export interface QueryBuilderContext {
  request<R = unknown>(
    method: string,
    relativePath: string,
    body?: unknown,
    extraHeaders?: Record<string, string>,
    includeAuth?: boolean,
    signal?: AbortSignal
  ): Promise<R>;
  invalidateCollectionCache(collectionPath: string): void;
  subscribeRealtime<T>(
    target: { path?: string; query?: unknown; resolveIncludes?: boolean; include?: unknown[] },
    callback: (snapshot: RealtimeSnapshot<T>) => void,
    onError: ((error: unknown) => void) | null,
    converter: DocDataConverter<T> | null
  ): () => void;
}

export interface QueryBuilderState<T = Record<string, unknown>> {
  whereClauses: WhereClause[];
  orderByClauses: Array<{ field: string; dir: "asc" | "desc" }>;
  limitVal: number;
  selectFields: string[] | null;
  startAtCursor: string | null;
  startAfterCursor: string | null;
  includeRelations: IncludeSpec[];
  orGroups: WhereClause[][];
  converter: DocDataConverter<T> | null;
}

export class QueryBuilder<T = Record<string, unknown>> implements QueryBuilderInterface<T> {
  public readonly collectionPath: string;
  public readonly whereClauses: WhereClause[];
  public readonly orderByClauses: Array<{ field: string; dir: "asc" | "desc" }>;
  public readonly limitVal: number;
  public readonly selectFields: string[] | null;
  public readonly startAtCursor: string | null;
  public readonly startAfterCursor: string | null;
  public readonly includeRelations: IncludeSpec[];
  public readonly orGroups: WhereClause[][];
  protected readonly queryCtx: QueryBuilderContext;
  protected readonly converter: DocDataConverter<T> | null;

  public constructor(
    ctx: QueryBuilderContext,
    collectionPath: string,
    state: Partial<QueryBuilderState<T>> = {}
  ) {
    encodeResourcePath(collectionPath, "collection path");
    this.queryCtx = ctx;
    this.collectionPath = collectionPath;
    this.whereClauses = state.whereClauses ?? [];
    this.orderByClauses = state.orderByClauses ?? [];
    this.limitVal = state.limitVal ?? 50;
    this.selectFields = state.selectFields ?? null;
    this.startAtCursor = state.startAtCursor ?? null;
    this.startAfterCursor = state.startAfterCursor ?? null;
    this.includeRelations = state.includeRelations ?? [];
    this.orGroups = state.orGroups ?? [];
    this.converter = state.converter ?? null;
    if (new.target === QueryBuilder) {
      Object.freeze(this);
    }
  }

  public where(field: string, op: string, value: unknown): QueryBuilder<T> {
    // V2 operators (`contains_ci`, `starts_with_ci`, `text_search`) intentionally
    // pass through: validation belongs to the API contract, not the builder.
    return new QueryBuilder<T>(this.queryCtx, this.collectionPath, {
      ...this.state(),
      whereClauses: [...this.whereClauses, { field, op, value }],
    });
  }

  public orderBy(field: string, dir: "asc" | "desc" = "asc"): QueryBuilder<T> {
    return new QueryBuilder<T>(this.queryCtx, this.collectionPath, {
      ...this.state(),
      orderByClauses: [...this.orderByClauses, { field, dir }],
    });
  }

  public limit(n: number): QueryBuilder<T> {
    return new QueryBuilder<T>(this.queryCtx, this.collectionPath, { ...this.state(), limitVal: n });
  }

  public select(...fields: string[]): QueryBuilder<T> {
    return new QueryBuilder<T>(this.queryCtx, this.collectionPath, {
      ...this.state(),
      selectFields: fields.flat(),
    });
  }

  public include(relations: Array<string | IncludeSpecInput>): QueryBuilder<T> {
    return new QueryBuilder<T>(this.queryCtx, this.collectionPath, {
      ...this.state(),
      includeRelations: [...this.includeRelations, ...relations.map(normalizeInclude)],
    });
  }

  public or(groups: Array<Array<WhereClause>>): QueryBuilder<T> {
    return new QueryBuilder<T>(this.queryCtx, this.collectionPath, {
      ...this.state(),
      orGroups: [
        ...this.orGroups,
        ...groups.map((group) => group.map((clause) => ({ ...clause }))),
      ],
    });
  }

  public startAt(cursor: string): QueryBuilder<T> {
    return new QueryBuilder<T>(this.queryCtx, this.collectionPath, { ...this.state(), startAtCursor: cursor });
  }

  public startAfter(cursor: string): QueryBuilder<T> {
    return new QueryBuilder<T>(this.queryCtx, this.collectionPath, { ...this.state(), startAfterCursor: cursor });
  }

  public withConverter<U>(converter: DocDataConverter<U>): QueryBuilderInterface<U>;
  public withConverter(converter: null): QueryBuilderInterface<Record<string, unknown>>;
  public withConverter<U>(
    converter: DocDataConverter<U> | null
  ): QueryBuilderInterface<U> | QueryBuilderInterface<Record<string, unknown>> {
    const { converter: _prev, ...rest } = this.state();
    if (converter === null) {
      return new QueryBuilder<Record<string, unknown>>(this.queryCtx, this.collectionPath, {
        ...rest,
        converter: null,
      });
    }
    return new QueryBuilder<U>(this.queryCtx, this.collectionPath, {
      ...rest,
      converter,
    });
  }

  public toQuerySpec(): QuerySpecPayload {
    return {
      collectionPath: this.collectionPath,
      where: this.whereClauses,
      orderBy: this.orderByClauses,
      limit: this.limitVal,
      select: this.selectFields,
      startAt: this.startAtCursor,
      startAfter: this.startAfterCursor,
      ...(this.includeRelations.length > 0 ? { include: this.includeRelations } : {}),
      ...(this.orGroups.length > 0 ? { or: this.orGroups } : {}),
    };
  }

  public async get(options: QueryGetOptions = {}): Promise<QuerySnapshot<T>> {
    const res = await this.queryCtx.request<{
      documents: WireDocument[];
      nextCursor: string | null;
      meta: unknown;
    }>("POST", "/query", this.toQuerySpec(), {}, true, options.signal);
    return buildQuerySnapshot(res.documents, res.nextCursor, res.meta, this.converter);
  }

  public async *pages(options: QueryStreamOptions = {}): AsyncGenerator<QuerySnapshot<T>, void, undefined> {
    const { signal, pageSize, maxPages, maxDocs } = options;
    if (signal?.aborted) {
      throw createAbortError(signal);
    }
    if (maxPages !== undefined && maxPages <= 0) return;
    if (maxDocs !== undefined && maxDocs <= 0) return;

    const basePageSize =
      typeof pageSize === "number" && Number.isFinite(pageSize) && pageSize >= 1
        ? Math.floor(pageSize)
        : this.limitVal;

    let pagesFetched = 0;
    let docsYielded = 0;
    let cursor: string | null = this.startAfterCursor;
    let isFirstPage = true;

    while (true) {
      if (signal?.aborted) {
        throw createAbortError(signal);
      }
      if (maxPages !== undefined && pagesFetched >= maxPages) break;
      if (maxDocs !== undefined && docsYielded >= maxDocs) break;

      const remainingDocs = maxDocs !== undefined ? maxDocs - docsYielded : undefined;
      const effectiveLimit =
        remainingDocs !== undefined ? Math.min(basePageSize, remainingDocs) : basePageSize;

      const pageQuery = new QueryBuilder<T>(this.queryCtx, this.collectionPath, {
        ...this.state(),
        limitVal: effectiveLimit,
        ...(isFirstPage ? {} : { startAtCursor: null, startAfterCursor: cursor }),
      });

      const page = await pageQuery.get(signal ? { signal } : {});
      pagesFetched += 1;

      if (page.docs.length === 0) {
        break;
      }

      const boundedDocs =
        remainingDocs !== undefined && page.docs.length > remainingDocs
          ? page.docs.slice(0, remainingDocs)
          : page.docs;
      docsYielded += boundedDocs.length;

      const yieldedPage: QuerySnapshot<T> =
        boundedDocs === page.docs ? page : Object.freeze({ ...page, docs: boundedDocs });
      yield yieldedPage;

      if (!page.nextCursor) break;
      if (!isFirstPage && page.nextCursor === cursor) break;
      cursor = page.nextCursor;
      isFirstPage = false;
    }
  }

  public async *stream(options: QueryStreamOptions = {}): AsyncGenerator<DocumentSnapshot<T>, void, undefined> {
    for await (const page of this.pages(options)) {
      for (const doc of page.docs) {
        if (options.signal?.aborted) {
          throw createAbortError(options.signal);
        }
        yield doc;
      }
    }
  }

  public aggregate(input: AggregateInput & { groupBy: string[] }, options?: RequestOptions): Promise<AggregateRow[]>;
  public aggregate(input: AggregateInput, options?: RequestOptions): Promise<number>;
  public async aggregate(
    input: AggregateInput,
    options: RequestOptions = {}
  ): Promise<number | AggregateRow[]> {
    const grouped = input.groupBy !== undefined && input.groupBy.length > 0;
    const res = await this.queryCtx.request<AggregateResultPayload>(
      "POST",
      "/documents:aggregate",
      {
        collectionPath: this.collectionPath,
        where: this.whereClauses,
        or: this.orGroups,
        ...(grouped ? { groupBy: input.groupBy } : {}),
        metrics: input.metrics,
      },
      {},
      true,
      options.signal
    );
    if (grouped) return res.rows;
    const firstRow = res.rows[0];
    if (!firstRow) return 0;
    const metricName = Object.keys(input.metrics)[0];
    if (metricName === undefined) return 0;
    const value = firstRow[metricName];
    const numeric = typeof value === "number" ? value : Number(value);
    return Number.isFinite(numeric) ? numeric : 0;
  }

  public async count(options: RequestOptions = {}): Promise<number> {
    return this.aggregate({ metrics: { count: { op: "count" } } }, options);
  }

  public async sum(field: string, options: RequestOptions = {}): Promise<number> {
    return this.aggregate({ metrics: { sum: { op: "sum", field } } }, options);
  }

  public async avg(field: string, options: RequestOptions = {}): Promise<number> {
    return this.aggregate({ metrics: { avg: { op: "avg", field } } }, options);
  }

  public async min(field: string, options: RequestOptions = {}): Promise<number> {
    return this.aggregate({ metrics: { min: { op: "min", field } } }, options);
  }

  public async max(field: string, options: RequestOptions = {}): Promise<number> {
    return this.aggregate({ metrics: { max: { op: "max", field } } }, options);
  }

  public async deleteWhere(options: { limit?: number; signal?: AbortSignal } = {}): Promise<BulkDeleteResult> {
    const res = await this.queryCtx.request<BulkDeleteResult>(
      "POST",
      "/documents:bulk-delete",
      {
        collectionPath: this.collectionPath,
        where: this.whereClauses,
        or: this.orGroups,
        ...(options.limit !== undefined ? { limit: options.limit } : {}),
      },
      {},
      true,
      options.signal
    );
    this.queryCtx.invalidateCollectionCache(this.collectionPath);
    return res;
  }

  public onSnapshot(
    callback: (snapshot: RealtimeSnapshot<T>) => void,
    onError?: ((err: unknown) => void) | null,
    options: RealtimeListenOptions = {}
  ): () => void {
    return this.queryCtx.subscribeRealtime<T>({ query: this.toQuerySpec(), ...options, ...(options.include ? { include: options.include.map(normalizeInclude) } : {}) }, callback, onError ?? null, this.converter);
  }

  protected state(): QueryBuilderState<T> {
    return {
      whereClauses: this.whereClauses,
      orderByClauses: this.orderByClauses,
      limitVal: this.limitVal,
      selectFields: this.selectFields,
      startAtCursor: this.startAtCursor,
      startAfterCursor: this.startAfterCursor,
      includeRelations: this.includeRelations,
      orGroups: this.orGroups,
      converter: this.converter,
    };
  }
}
