/**
 * @vellumdb/sdk-js - DocumentReference
 *
 * Immutable, typed handle to a single document path supporting CRUD,
 * `withConverter<U>()`, bounded read cache + single-flight GET coalescing,
 * `AbortSignal` cancellation, and realtime `onSnapshot()`.
 */

import type { BoundedReadCache } from "../cache/read-cache.js";
import { createAbortError } from "../core/backoff.js";
import { encodePathSegment, encodeResourcePath, sanitizeAndClone } from "../core/safe-json.js";
import type {
  CollectionReferenceInterface,
  DocDataConverter,
  DocumentCreateOptions,
  DocumentDeleteOptions,
  DocumentGetOptions,
  DocumentReferenceInterface,
  DocumentSetOptions,
  DocumentSnapshot,
  DocumentUpdateOptions,
  DocumentUpsertOptions,
  RealtimeSnapshot,
  RealtimeListenOptions,
  ReferencedByOptions,
  ReferencedByPage,
} from "../types.js";
import { buildDocumentSnapshot, normalizeInclude, type WireDocument } from "./snapshots.js";

export interface DocumentReferenceContext {
  request<R = unknown>(
    method: string,
    relativePath: string,
    body?: unknown,
    extraHeaders?: Record<string, string>,
    includeAuth?: boolean,
    signal?: AbortSignal
  ): Promise<R>;
  readonly readCache: BoundedReadCache<WireDocument> | null;
  readonly dedupeReads: boolean;
  readonly inFlightGets: Map<string, Promise<WireDocument>>;
  getPathWriteEpoch(path: string): number;
  getGlobalCacheEpoch(): number;
  invalidateDocCache(path: string): void;
  subscribeRealtime<T>(
    target: { path?: string; query?: unknown; resolveIncludes?: boolean; include?: unknown[] },
    callback: (snapshot: RealtimeSnapshot<T>) => void,
    onError: ((error: unknown) => void) | null,
    converter: DocDataConverter<T> | null
  ): () => void;
  createCollectionRef<SubT = Record<string, unknown>>(collectionPath: string): CollectionReferenceInterface<SubT>;
}

export class DocumentReference<T = Record<string, unknown>> implements DocumentReferenceInterface<T> {
  public readonly path: string;
  public readonly id: string;
  private readonly ctx: DocumentReferenceContext;
  private readonly converter: DocDataConverter<T> | null;

  public constructor(
    ctx: DocumentReferenceContext,
    path: string,
    converter: DocDataConverter<T> | null = null
  ) {
    encodeResourcePath(path, "document path");
    this.ctx = ctx;
    this.path = path;
    const parts = path.split("/");
    this.id = parts[parts.length - 1] ?? "";
    this.converter = converter;
    Object.freeze(this);
  }

  private encodedPath(): string {
    return encodeResourcePath(this.path, "document path");
  }

  private serializeData(data: T): Record<string, unknown> {
    if (this.converter) {
      return this.converter.toDoc(data);
    }
    return data as unknown as Record<string, unknown>;
  }

  public collection<SubT = Record<string, unknown>>(subCollectionName: string): CollectionReferenceInterface<SubT> {
    encodePathSegment(subCollectionName, "subcollection name");
    return this.ctx.createCollectionRef<SubT>(`${this.path}/${subCollectionName}`);
  }

  public withConverter<U>(converter: DocDataConverter<U>): DocumentReferenceInterface<U>;
  public withConverter(converter: null): DocumentReferenceInterface<Record<string, unknown>>;
  public withConverter<U>(
    converter: DocDataConverter<U> | null
  ): DocumentReferenceInterface<U> | DocumentReferenceInterface<Record<string, unknown>> {
    if (converter === null) {
      return new DocumentReference<Record<string, unknown>>(this.ctx, this.path, null);
    }
    return new DocumentReference<U>(this.ctx, this.path, converter);
  }

  public async get(options: DocumentGetOptions = {}): Promise<DocumentSnapshot<T>> {
    if (options.signal?.aborted) {
      throw createAbortError(options.signal);
    }

    const params = new URLSearchParams();
    if (options.include !== undefined) {
      params.set("include", JSON.stringify(options.include.map(normalizeInclude)));
    }
    if (options.select !== undefined) {
      params.set("select", JSON.stringify(options.select));
    }
    const query = params.toString();
    const cacheKey = `${this.path}\0${query}`;

    if (this.ctx.readCache && options.bypassCache !== true) {
      const cached = this.ctx.readCache.get(cacheKey);
      if (cached !== undefined) {
        return buildDocumentSnapshot(cached, this.converter);
      }
    }

    const shouldDedupe =
      options.signal === undefined && (options.dedupe !== undefined ? options.dedupe : this.ctx.dedupeReads);

    if (shouldDedupe) {
      const existing = this.ctx.inFlightGets.get(cacheKey);
      if (existing) {
        const sharedDoc = await existing;
        return buildDocumentSnapshot(sharedDoc, this.converter);
      }
    }

    const epochBefore = this.ctx.getPathWriteEpoch(this.path);
    const globalEpochBefore = this.ctx.getGlobalCacheEpoch();
    const relativePath = `/documents/${this.encodedPath()}${query ? `?${query}` : ""}`;

    const fetchPromise = this.ctx
      .request<WireDocument>("GET", relativePath, undefined, {}, true, options.signal)
      .then((doc) => {
        const sanitized = sanitizeAndClone(doc);
        if (
          this.ctx.readCache &&
          options.bypassCache !== true &&
          this.ctx.getPathWriteEpoch(this.path) === epochBefore &&
          this.ctx.getGlobalCacheEpoch() === globalEpochBefore
        ) {
          this.ctx.readCache.set(cacheKey, this.path, sanitized);
        }
        return sanitized;
      });

    if (shouldDedupe) {
      this.ctx.inFlightGets.set(cacheKey, fetchPromise);
      try {
        const doc = await fetchPromise;
        return buildDocumentSnapshot(doc, this.converter);
      } finally {
        if (this.ctx.inFlightGets.get(cacheKey) === fetchPromise) {
          this.ctx.inFlightGets.delete(cacheKey);
        }
      }
    }

    const doc = await fetchPromise;
    return buildDocumentSnapshot(doc, this.converter);
  }

  public async referencedBy<D = Record<string, unknown>>(options: ReferencedByOptions = {}): Promise<ReferencedByPage<D>> {
    if (options.signal?.aborted) throw createAbortError(options.signal);
    const { signal, include, ...query } = options;
    const result = await this.ctx.request<{ documents: WireDocument[]; nextCursor: string | null }>(
      "POST", "/documents:referencedBy", {
        ...query, targetPath: this.path,
        ...(include === undefined ? {} : { include: include.map(normalizeInclude) }),
      }, {}, true, signal
    );
    // Dependents are not the target's type; never apply this reference's converter.
    return { documents: result.documents.map((row) => buildDocumentSnapshot<D>(row, null)), nextCursor: result.nextCursor };
  }

  public async create(data: T, options: DocumentCreateOptions = {}): Promise<unknown> {
    const payload = this.serializeData(data);
    const res = await this.ctx.request(
      "POST",
      `/documents/${this.encodedPath()}`,
      {
        data: payload,
        ...(options.ttlSeconds !== undefined ? { ttlSeconds: options.ttlSeconds } : {}),
        ...(options.expiresAt !== undefined ? { expiresAt: options.expiresAt } : {}),
      },
      {},
      true,
      options.signal
    );
    this.ctx.invalidateDocCache(this.path);
    return res;
  }

  public async set(data: T, options: DocumentSetOptions = {}): Promise<unknown> {
    const payload = this.serializeData(data);
    const res = await this.ctx.request(
      "PUT",
      `/documents/${this.encodedPath()}`,
      {
        data: payload,
        merge: Boolean(options.merge),
        ifVersion: options.ifVersion ?? null,
        ...(options.ttlSeconds !== undefined ? { ttlSeconds: options.ttlSeconds } : {}),
        ...(options.expiresAt !== undefined ? { expiresAt: options.expiresAt } : {}),
        ...(options.upsert !== undefined ? { upsert: options.upsert } : {}),
      },
      {},
      true,
      options.signal
    );
    this.ctx.invalidateDocCache(this.path);
    return res;
  }

  public async upsert(data: T, options: DocumentUpsertOptions = {}): Promise<unknown> {
    return this.set(data, { ...options, upsert: true });
  }

  public async update(
    data: Record<string, unknown>,
    options: DocumentUpdateOptions = {}
  ): Promise<unknown> {
    const res = await this.ctx.request(
      "PATCH",
      `/documents/${this.encodedPath()}`,
      {
        data,
        ifVersion: options.ifVersion ?? null,
      },
      {},
      true,
      options.signal
    );
    this.ctx.invalidateDocCache(this.path);
    return res;
  }

  public async delete(options: DocumentDeleteOptions = {}): Promise<unknown> {
    const qs = options.ifVersion !== undefined ? `?ifVersion=${encodeURIComponent(String(options.ifVersion))}` : "";
    const res = await this.ctx.request(
      "DELETE",
      `/documents/${this.encodedPath()}${qs}`,
      undefined,
      {},
      true,
      options.signal
    );
    this.ctx.invalidateDocCache(this.path);
    return res;
  }

  public onSnapshot(
    callback: (snapshot: RealtimeSnapshot<T>) => void,
    onError?: ((err: unknown) => void) | null,
    options: RealtimeListenOptions = {}
  ): () => void {
    return this.ctx.subscribeRealtime<T>({ path: this.path, ...options, ...(options.include ? { include: options.include.map(normalizeInclude) } : {}) }, callback, onError ?? null, this.converter);
  }
}
