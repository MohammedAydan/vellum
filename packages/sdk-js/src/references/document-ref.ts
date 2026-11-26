/**
 * @vellumdb/sdk-js - DocumentReference
 *
 * Immutable, typed handle to a single document path supporting CRUD,
 * `withConverter<U>()`, bounded read cache + single-flight GET coalescing,
 * `AbortSignal` cancellation, and realtime `onSnapshot()`.
 */

import type { DocStore, StoredDoc } from "../cache/doc-store.js";
import { parseJwtSubject } from "../auth/jwt-utils.js";
import type { BoundedReadCache } from "../cache/read-cache.js";
import { reference } from "../core/reference.js";
import { createAbortError } from "../core/backoff.js";
import { encodePathSegment, encodeResourcePath, sanitizeAndClone } from "../core/safe-json.js";
import type {
  CachePolicy,
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
import { buildDocumentSnapshot, buildMissingDocumentSnapshot, normalizeInclude, type WireDocument } from "./snapshots.js";

/** Maps a write option to the Idempotency-Key header the API dedupes on. */
const MAX_REFERENCE_WALK_DEPTH = 32;

/**
 * Replace `DocumentReference` instances found in write data with the tagged
 * reference wire value, so `{ customer: db.doc("users/u1") }` just works.
 * Other values pass through untouched; the input is never mutated.
 */
export function replaceDocumentReferences(value: unknown, depth = 0): unknown {
  if (value instanceof DocumentReference) return reference(value.path);
  if (depth >= MAX_REFERENCE_WALK_DEPTH || value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) {
    let changed = false;
    const out = value.map((item) => {
      const next = replaceDocumentReferences(item, depth + 1);
      if (next !== item) changed = true;
      return next;
    });
    return changed ? out : value;
  }
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) return value;
  let changed = false;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    const next = replaceDocumentReferences(v, depth + 1);
    if (next !== v) changed = true;
    out[k] = next;
  }
  return changed ? out : value;
}

const FORBIDDEN_PATH_PARTS = new Set(["__proto__", "constructor", "prototype"]);

/**
 * `update()` treats a top-level key with dots as a path into a nested object: `{ "profile.name": "Ada" }`
 * changes only `profile.name`. Without this the server would store a literal key named "profile.name"
 * next to the nested object. Other values pass through untouched; the input is never mutated.
 */
export function expandUpdatePaths(data: Record<string, unknown>): Record<string, unknown> {
  if (data === null || typeof data !== "object" || !Object.keys(data).some((k) => k.includes("."))) return data;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(data)) {
    if (!key.includes(".")) {
      const existing = out[key];
      out[key] = isPlainRecord(existing) && isPlainRecord(value) ? mergeNested(existing, value) : value;
      continue;
    }
    const parts = key.split(".");
    if (parts.some((p) => p.length === 0 || FORBIDDEN_PATH_PARTS.has(p))) {
      throw new TypeError(`Invalid field path '${key.slice(0, 64)}' in update()`);
    }
    let cursor = out;
    for (let i = 0; i < parts.length - 1; i += 1) {
      const part = parts[i]!;
      const next = cursor[part];
      if (isPlainRecord(next)) {
        cursor = next;
      } else {
        const created: Record<string, unknown> = {};
        cursor[part] = created;
        cursor = created;
      }
    }
    cursor[parts[parts.length - 1]!] = value;
  }
  return out;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function mergeNested(a: Record<string, unknown>, b: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...a };
  for (const [k, v] of Object.entries(b)) {
    const cur = out[k];
    out[k] = isPlainRecord(cur) && isPlainRecord(v) ? mergeNested(cur, v) : v;
  }
  return out;
}

function idempotencyHeaders(options: { idempotencyKey?: string | undefined }): Record<string, string> {
  return options.idempotencyKey ? { "Idempotency-Key": options.idempotencyKey } : {};
}

export interface DocumentReferenceContext {
  request<R = unknown>(
    method: string,
    relativePath: string,
    body?: unknown,
    extraHeaders?: Record<string, string>,
    includeAuth?: boolean,
    signal?: AbortSignal
  ): Promise<R>;
  getSessionEpoch?(): number;
  prepareRead?(): Promise<string | null>;
  readonly readCache: BoundedReadCache<WireDocument> | null;
  readonly dedupeReads: boolean;
  /** Offline store behind `CachePolicy`; null when disabled. */
  readonly docStore?: DocStore | null;
  readonly cachePolicy?: CachePolicy;
  readonly cacheTtlMs?: number;
  readonly inFlightGets: Map<string, Promise<WireDocument | null>>;
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

/** True for network-level failures and gateway/availability errors, not for 4xx answers from the server. */
function isConnectivityError(err: unknown): boolean {
  if (err === null || typeof err !== "object") return false;
  const e = err as { name?: string; status?: number; code?: unknown };
  if (e.name === "AbortError") return false;
  if (typeof e.status === "number") return e.status === 0 || e.status === 502 || e.status === 503 || e.status === 504;
  if (e.code === "REQUEST_TIMEOUT") return true;
  // Raw fetch/network failures carry no API code; SDK-raised errors (SESSION_CHANGED, ...) do.
  return e.code === undefined;
}

export class DocumentReference<T = Record<string, unknown>> implements DocumentReferenceInterface<T> {
  public readonly path: string;
  public readonly id: string;
  private readonly ctx: DocumentReferenceContext;
  private readonly converter: DocDataConverter<T> | null;
  /** True when the ID was generated locally by `collection.doc()`; reading before the first save yields a non-existent snapshot. */
  private readonly autoId: boolean;

  public constructor(
    ctx: DocumentReferenceContext,
    path: string,
    converter: DocDataConverter<T> | null = null,
    autoId = false
  ) {
    encodeResourcePath(path, "document path");
    const parts = path.split("/");
    if (parts.length < 2 || parts.length % 2 !== 0) {
      throw new Error(
        `@vellumdb/sdk-js: invalid document path "${path}" (a document path needs an even number of segments: collection/docId[/subcollection/docId...])`
      );
    }
    this.ctx = ctx;
    this.path = path;
    this.id = parts[parts.length - 1] ?? "";
    this.converter = converter;
    this.autoId = autoId;
    Object.freeze(this);
  }

  private encodedPath(): string {
    return encodeResourcePath(this.path, "document path");
  }

  private serializeData(data: T): Record<string, unknown> {
    const plain = this.converter ? this.converter.toDoc(data) : (data as unknown as Record<string, unknown>);
    return replaceDocumentReferences(plain) as Record<string, unknown>;
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
    const store = this.ctx.docStore ?? null;
    const policy = options.cachePolicy ?? this.ctx.cachePolicy ?? "networkFirst";
    if (store === null || policy === "networkOnly") return this.fetchSnapshot(options);

    const bearer = await this.ctx.prepareRead?.();
    const scope = parseJwtSubject(bearer ?? null) ?? "anon";
    const key = `${scope}\0${this.path}\0${JSON.stringify(options.include?.map(normalizeInclude) ?? null)}\0${JSON.stringify(options.select ?? null)}`;
    const ttl = this.ctx.cacheTtlMs ?? 300_000;
    const readStored = async (checkFresh: boolean): Promise<StoredDoc | null> => {
      try {
        const entry = await store.get(key);
        if (!entry) return null;
        if (checkFresh && Date.now() - entry.storedAt > ttl) return null;
        return entry;
      } catch {
        return null;
      }
    };
    const fromStore = (entry: StoredDoc): DocumentSnapshot<T> => {
      const base = buildDocumentSnapshot<T>(entry.value as WireDocument, this.converter);
      return Object.freeze({ ...base, metadata: Object.freeze({ fromCache: true }) });
    };

    if (policy === "cacheOnly") {
      const entry = await readStored(false);
      return entry ? fromStore(entry) : buildMissingDocumentSnapshot<T>(this.path, this.id, true);
    }
    if (policy === "cacheFirst") {
      const entry = await readStored(true);
      if (entry) return fromStore(entry);
    }

    const epochBefore = this.ctx.getPathWriteEpoch(this.path);
    try {
      const snap = await this.fetchSnapshot(options);
      // Skip the write when a local write/realtime change invalidated this path mid-flight.
      if (snap.exists && this.ctx.getPathWriteEpoch(this.path) === epochBefore) {
        void store
          .set(key, { path: this.path, value: snap.raw, storedAt: Date.now() })
          .catch(() => undefined);
      }
      return snap;
    } catch (err) {
      if (policy === "networkFirst" && isConnectivityError(err)) {
        const entry = await readStored(false);
        if (entry) return fromStore(entry);
      }
      throw err;
    }
  }

  private async fetchSnapshot(options: DocumentGetOptions = {}): Promise<DocumentSnapshot<T>> {
    if (options.signal?.aborted) {
      throw createAbortError(options.signal);
    }

    const bearer = await this.ctx.prepareRead?.();
    if (options.signal?.aborted) throw createAbortError(options.signal);
    const readEpoch = this.ctx.getSessionEpoch?.();
    const assertCurrent = (): void => {
      if (readEpoch !== this.ctx.getSessionEpoch?.()) {
        throw Object.assign(new Error("Document read invalidated; retry with the current session"), { code: "READ_INVALIDATED" });
      }
    };

    const params = new URLSearchParams();
    if (options.include !== undefined) {
      params.set("include", JSON.stringify(options.include.map(normalizeInclude)));
    }
    if (options.select !== undefined) {
      params.set("select", JSON.stringify(options.select));
    }
    const query = params.toString();
    const cacheKey = `${this.path}\0${query}\0${bearer ?? ""}`;

    if (this.ctx.readCache && options.bypassCache !== true) {
      const cached = this.ctx.readCache.get(cacheKey);
      if (cached !== undefined) {
        const hit = buildDocumentSnapshot<T>(cached, this.converter);
        return Object.freeze({ ...hit, metadata: Object.freeze({ fromCache: true }) });
      }
    }

    const shouldDedupe =
      options.signal === undefined && (options.dedupe !== undefined ? options.dedupe : this.ctx.dedupeReads);

    if (shouldDedupe) {
      const existing = this.ctx.inFlightGets.get(cacheKey);
      if (existing) {
        const sharedDoc = await existing;
        assertCurrent();
        return sharedDoc === null ? buildMissingDocumentSnapshot(this.path, this.id) : buildDocumentSnapshot(sharedDoc, this.converter);
      }
    }

    const epochBefore = this.ctx.getPathWriteEpoch(this.path);
    const globalEpochBefore = this.ctx.getGlobalCacheEpoch();
    const relativePath = `/documents/${this.encodedPath()}${query ? `?${query}` : ""}`;

    const fetchPromise = this.ctx
      .request<WireDocument>("GET", relativePath, undefined, {}, true, options.signal)
      .catch((err: unknown): WireDocument | null => {
        const e = err as { status?: number; code?: string; message?: string } | null | undefined;
        // A missing document is a normal result (exists=false), like Firestore. A missing project
        // is a real error and still throws.
        if (e?.status === 404 && (this.autoId || (e.code === "NOT_FOUND" && !/^Project\b/i.test(e.message ?? "")))) {
          return null;
        }
        throw err;
      })
      .then((doc) => {
        if (doc === null) return null;
        assertCurrent();
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
        return doc === null ? buildMissingDocumentSnapshot(this.path, this.id) : buildDocumentSnapshot(doc, this.converter);
      } finally {
        if (this.ctx.inFlightGets.get(cacheKey) === fetchPromise) {
          this.ctx.inFlightGets.delete(cacheKey);
        }
      }
    }

    const doc = await fetchPromise;
    return doc === null ? buildMissingDocumentSnapshot(this.path, this.id) : buildDocumentSnapshot(doc, this.converter);
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
      idempotencyHeaders(options),
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
      idempotencyHeaders(options),
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
        data: replaceDocumentReferences(expandUpdatePaths(data)),
        ifVersion: options.ifVersion ?? null,
      },
      idempotencyHeaders(options),
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
      idempotencyHeaders(options),
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
