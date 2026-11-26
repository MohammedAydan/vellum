import type { OAuthPopupOptions, OAuthRedirectOptions } from "../auth/oauth-web.js";
/**
 * @vellumdb/sdk-js - VellumClient Composition Root
 * Specification Section 12.1 & 9.3
 *
 * Composes `HttpTransport`, `VellumAuthClient`, `BoundedReadCache`,
 * `RealtimeTransport`, `CollectionReference`, `DocumentReference`,
 * `batchWriteChunked`, and OCC `runTransaction` into a tamper-proof,
 * frozen (`Object.freeze`) client facade with redacted `toJSON()`/`toString()`.
 */

import { BrowserLocalStorage, DEFAULT_AUTH_STORAGE_KEY, resolveBrowserLocalStorage } from "../auth/auth-storage.js";
import { VellumAuthClient } from "../auth/auth-client.js";
import type { SignInOAuthPayload, SignOutOptions, SignUpEmailOptions } from "../auth/auth-client.js";
import { isRecord, parseJwtSubject } from "../auth/jwt-utils.js";
import { batchWriteChunked as runBatchWriteChunked } from "../batch/batch-chunked.js";
import { BoundedReadCache } from "../cache/read-cache.js";
import { createDefaultDocStore, DEFAULT_MAX_CACHE_SIZE_BYTES, type DocStore } from "../cache/doc-store.js";
import { computeReconnectBackoffMs, createAbortError, sleepWithSignal } from "../core/backoff.js";
import { normalizeEndpoint, validateProjectConfig } from "../core/config.js";
import { HttpTransport } from "../core/http-transport.js";
import { encodePathSegment, encodeResourcePath, sanitizeAndClone } from "../core/safe-json.js";
import { RealtimeTransport, toRealtimeUrl } from "../realtime/realtime-transport.js";
import { SseSocket } from "../realtime/sse-socket.js";
import { createFallbackSocketFactory } from "../realtime/fallback-socket.js";
import { defaultWebSocketFactory } from "../realtime/realtime-transport.js";
import type { RealtimeFrame, RealtimeTransportState, WebSocketFactory } from "../realtime/realtime-transport.js";
import { CollectionReference, type CollectionReferenceContext } from "../references/collection-ref.js";
import { DocumentReference, expandUpdatePaths } from "../references/document-ref.js";
import { applyConverterToSnapshot, parseWireDocument, type WireDocument } from "../references/snapshots.js";
import type {
  ActionTokenResult,
  AuthState,
  VellumLinkedProvider,
  VellumSessionInfo,
  AuthStateListener,
  BatchWriteChunkedOptions,
  BatchWriteChunkedResult,
  ClientConfig,
  CollectionInfo,
  CollectionReferenceInterface,
  CollectionSchemaValidation,
  ConfirmEmailVerificationInput,
  ConfirmPasswordResetInput,
  ConfirmTotpMfaInput,
  ConnectionState,
  ConnectionStateListener,
  CreateCollectionOptions,
  DocDataConverter,
  VellumAuthUser,
  VellumClientInterface,
  DocumentReferenceInterface,
  DocumentSnapshot,
  EmailVerifyConfirmResult,
  EnrollTotpMfaInput,
  ExportResult,
  ImportDocumentInput,
  ImportResult,
  ListCollectionsOptions,
  MfaRequiredResult,
  RealtimeChange,
  RealtimeSnapshot,
  RequestOptions,
  SendEmailVerificationInput,
  SendPasswordResetEmailInput,
  SignInAnonymouslyInput,
  SignInWithEmailAndPasswordInput,
  SignInWithOAuthInput,
  SignUpWithEmailAndPasswordInput,
  SuccessResult,
  TotpEnrollmentResult,
  TransactionContext,
  UpdateCollectionInput,
  UpdateProfileInput,
  VerifyMfaChallengeInput,
  CachePolicy,
  BatchWriteOperation,
} from "../types.js";

interface HubConnection {
  handleClientFrame: (frame: unknown) => Promise<void> | void;
  close: () => void;
}

interface ActiveSubscription {
  subId: string;
  callback: (snapshot: RealtimeSnapshot<Record<string, unknown>>) => void;
  onError: ((error: unknown) => void) | null;
  lastSeqId: number | null;
  docs: Map<string, DocumentSnapshot<Record<string, unknown>>>;
}

interface CacheInternalState {
  readonly readCache: BoundedReadCache<WireDocument> | null;
  readonly docStore: DocStore | null;
  readonly cachePolicy: CachePolicy;
  readonly cacheTtlMs: number;
  readonly dedupeReads: boolean;
  readonly inFlightGets: Map<string, Promise<WireDocument>>;
  readonly pathWriteEpochs: Map<string, number>;
  globalCacheEpoch: number;
  sessionEpoch: number;
}

interface RealtimeInternalState {
  readonly activeSubscriptions: Map<string, ActiveSubscription>;
  readonly hubConnections: Set<HubConnection>;
  readonly connectionStateListeners: Set<ConnectionStateListener>;
  currentConnectionState: ConnectionState;
  realtimeTransport: RealtimeTransport | null;
  subscriptionSeq: number;
}

function parseSeqNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && /^\d+$/.test(value)) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function mapTransportState(state: RealtimeTransportState): ConnectionState {
  switch (state) {
    case "connecting":
      return "connecting";
    case "authenticated":
      return "connected";
    case "reconnecting":
      return "reconnecting";
    case "idle":
    case "closed":
      return "disconnected";
  }
}

/** Normalize the optional per-collection schema-validation metadata. */
function toSchemaValidation(value: unknown): CollectionSchemaValidation | null {
  if (!isRecord(value)) return null;
  const result: CollectionSchemaValidation = {};
  const requiredFields = value["requiredFields"];
  if (Array.isArray(requiredFields)) {
    result.requiredFields = requiredFields.filter((field): field is string => typeof field === "string");
  }
  if (typeof value["strict"] === "boolean") result.strict = value["strict"];
  return result;
}

/**
 * Tolerant collection mapper. The legacy public endpoint returned a bare
 * `string[]` of collection names, so a string is upgraded to a fully-shaped
 * `CollectionInfo` with zeroed statistics for backwards compatibility.
 */
function toCollectionInfo(value: unknown): CollectionInfo | null {
  if (typeof value === "string") {
    return {
      id: value,
      name: value,
      description: null,
      defaultTtlSeconds: null,
      schemaValidation: null,
      documentCount: 0,
      storageBytes: 0,
      createdAt: "",
      updatedAt: "",
      lastDocumentAt: null,
    };
  }
  if (!isRecord(value)) return null;
  const name = value["name"];
  if (typeof name !== "string" || name.length === 0) return null;

  const id = value["id"];
  const description = value["description"];
  const defaultTtlSeconds = value["defaultTtlSeconds"];
  const documentCount = value["documentCount"];
  const storageBytes = value["storageBytes"];
  const createdAt = value["createdAt"];
  const updatedAt = value["updatedAt"];
  const lastDocumentAt = value["lastDocumentAt"];
  const isSystem = value["isSystem"];
  const metadata = value["metadata"];
  const projectId = value["projectId"];

  return {
    id: typeof id === "string" && id.length > 0 ? id : name,
    name,
    description: typeof description === "string" ? description : null,
    defaultTtlSeconds:
      typeof defaultTtlSeconds === "number" && Number.isFinite(defaultTtlSeconds) ? defaultTtlSeconds : null,
    schemaValidation: toSchemaValidation(value["schemaValidation"]),
    documentCount: typeof documentCount === "number" && Number.isFinite(documentCount) ? documentCount : 0,
    storageBytes: typeof storageBytes === "number" && Number.isFinite(storageBytes) ? storageBytes : 0,
    createdAt: typeof createdAt === "string" ? createdAt : "",
    updatedAt: typeof updatedAt === "string" ? updatedAt : "",
    lastDocumentAt: typeof lastDocumentAt === "string" ? lastDocumentAt : null,
    ...(typeof isSystem === "boolean" ? { isSystem } : {}),
    ...(isRecord(metadata) ? { metadata: sanitizeAndClone(metadata) } : {}),
    ...(typeof projectId === "string" ? { projectId } : {}),
  };
}

/** Strict variant used where the server is contractually expected to return a row. */
function mapCollectionInfo(value: unknown): CollectionInfo {
  const info = toCollectionInfo(value);
  if (!info) throw new Error("@vellumdb/sdk-js: invalid collection response");
  return info;
}

/** Build a URL query string, skipping null/undefined values. */
function toQueryString(params: Record<string, string | number | null | undefined>): string {
  const searchParams = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === null || value === undefined) continue;
    searchParams.set(key, String(value));
  }
  const serialized = searchParams.toString();
  return serialized.length > 0 ? `?${serialized}` : "";
}

/**
 * The WS `subscribe` schema (`QuerySpecSchema`) rejects null members and
 * opaque string cursors, and expects `orderBy[].direction` rather than `dir`.
 */
function realtimeSafeQuery(query: unknown): unknown {
  if (!query || typeof query !== "object" || Array.isArray(query)) return query;
  const safe: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(query as Record<string, unknown>)) {
    if (value === null || value === undefined) continue;
    if (key === "startAt" || key === "startAfter") continue;
    if (key === "orderBy" && Array.isArray(value)) {
      safe[key] = value.map((clause: unknown) => {
        if (!isRecord(clause)) return clause;
        const direction = clause["direction"] ?? clause["dir"];
        const { dir: _legacyDir, ...rest } = clause;
        return {
          ...rest,
          ...(typeof direction === "string" ? { direction } : {}),
        };
      });
      continue;
    }
    safe[key] = value;
  }
  return safe;
}

export class VellumClient implements VellumClientInterface {
  private readonly projectId: string;
  private readonly apiKey: string;
  private readonly endpoint: string;
  private readonly realtimeUrl: string | null;
  private readonly realtimeHub: unknown;
  private readonly webSocketFactory: WebSocketFactory | null;
  private readonly realtimeTransportKind: "auto" | "websocket" | "sse";
  private readonly customFetch: typeof globalThis.fetch | null;
  private readonly realtimeTransportOptions: ClientConfig["realtimeTransportOptions"];
  private readonly transport: HttpTransport;
  private readonly cacheState: CacheInternalState;
  private readonly realtimeState: RealtimeInternalState;
  private readonly refContext: CollectionReferenceContext;

  /** The dedicated auth facade; all top-level auth methods delegate to it. */
  public readonly auth: VellumAuthClient;

  public constructor(config: ClientConfig) {
    validateProjectConfig(config.projectId, config.apiKey);

    this.projectId = config.projectId;
    this.apiKey = config.apiKey;
    this.endpoint = normalizeEndpoint(config.endpoint);
    this.realtimeUrl = config.realtimeUrl ?? null;
    this.realtimeHub = config.realtimeHub ?? null;
    this.webSocketFactory = config.webSocketFactory ?? null;
    this.realtimeTransportKind = config.realtimeTransport ?? "auto";
    this.customFetch = config.customFetch ?? null;
    this.realtimeTransportOptions = config.realtimeTransportOptions
      ? Object.freeze({ ...config.realtimeTransportOptions })
      : null;

    this.transport = new HttpTransport({
      projectId: this.projectId,
      apiKey: this.apiKey,
      endpoint: this.endpoint,
      ...(config.customFetch !== undefined ? { customFetch: config.customFetch } : {}),
      ...(config.timeoutMs !== undefined ? { timeoutMs: config.timeoutMs } : {}),
      ...(config.maxRetries !== undefined ? { maxRetries: config.maxRetries } : {}),
      ...(config.retryBaseDelayMs !== undefined ? { retryBaseDelayMs: config.retryBaseDelayMs } : {}),
      ...(config.retryMaxDelayMs !== undefined ? { retryMaxDelayMs: config.retryMaxDelayMs } : {}),
      ...(config.retryRandomFn !== undefined ? { retryRandomFn: config.retryRandomFn } : {}),
      ...(config.warnOnMissingIndexes !== undefined ? { warnOnMissingIndexes: config.warnOnMissingIndexes } : {}),
      ...(config.onIndexSuggestion !== undefined ? { onIndexSuggestion: config.onIndexSuggestion } : {}),
    });

    const readCache =
      config.cache?.enabled === true
        ? new BoundedReadCache<WireDocument>({
            ...(config.cache.ttlMs !== undefined ? { ttlMs: config.cache.ttlMs } : {}),
            ...(config.cache.maxEntries !== undefined ? { maxEntries: config.cache.maxEntries } : {}),
          })
        : null;

    const docStore: DocStore | null =
      config.cache?.store === false
        ? null
        : (config.cache?.store ??
          createDefaultDocStore(
            `${this.endpoint}|${this.projectId}`,
            config.cache?.maxCacheSizeBytes ?? DEFAULT_MAX_CACHE_SIZE_BYTES
          ));

    this.cacheState = {
      readCache,
      docStore,
      cachePolicy: config.cachePolicy ?? "networkFirst",
      cacheTtlMs: config.cache?.cacheTtlMs ?? 300_000,
      dedupeReads: config.dedupeReads ?? false,
      inFlightGets: new Map<string, Promise<WireDocument>>(),
      pathWriteEpochs: new Map<string, number>(),
      globalCacheEpoch: 0,
      sessionEpoch: 0,
    };

    this.realtimeState = {
      activeSubscriptions: new Map<string, ActiveSubscription>(),
      hubConnections: new Set<HubConnection>(),
      connectionStateListeners: new Set<ConnectionStateListener>(),
      currentConnectionState: "disconnected",
      realtimeTransport: null,
      subscriptionSeq: 0,
    };

    this.auth = new VellumAuthClient({
      request: (method, relativePath, body, extraHeaders, includeAuth) =>
        this.transport.request(method, relativePath, body, extraHeaders, includeAuth),
      getAuthToken: config.getAuthToken ?? null,
      oauth: { baseUrl: `${this.endpoint}/v1/projects/${encodeURIComponent(this.projectId)}`, apiKey: this.apiKey },
      autoRefresh: config.autoRefresh !== false,
      authStorage: config.authStorage ?? (resolveBrowserLocalStorage() ? new BrowserLocalStorage(
        `${DEFAULT_AUTH_STORAGE_KEY}:${encodeURIComponent(this.endpoint)}:${encodeURIComponent(this.projectId)}`
      ) : null),
      onTokenChanged: (previousToken, nextToken) => {
        this.resetCaches(false);
        if (nextToken !== null && (nextToken === this.auth.currentUser?.accessToken ||
          (parseJwtSubject(previousToken) !== null && parseJwtSubject(previousToken) === parseJwtSubject(nextToken)))) {
          this.reauthenticateRealtime(nextToken);
        } else {
          this.cacheState.sessionEpoch += 1;
          this.endSessionSubscriptions();
        }
      },
      onSessionChanged: () => {
        this.cacheState.sessionEpoch += 1;
        this.clearCache();
        this.endSessionSubscriptions();
      },
    });

    this.transport.setAuthHooks({
      getSessionEpoch: () => this.cacheState.sessionEpoch,
      getValidAccessToken: () => this.auth.getValidAccessToken(),
      hasRefreshToken: () => Boolean(this.auth.currentUser?.refreshToken),
      refreshIfMatching: (staleAccessToken) => this.auth.refreshIfMatching(staleAccessToken),
    });

    this.refContext = Object.freeze({
      request: <R = unknown>(
        method: string,
        relativePath: string,
        body?: unknown,
        extraHeaders?: Record<string, string>,
        includeAuth?: boolean,
        signal?: AbortSignal
      ) => this.transport.request<R>(method, relativePath, body, extraHeaders, includeAuth, signal),
      prepareRead: () => this.auth.getValidAccessToken(),
      getSessionEpoch: () => this.cacheState.sessionEpoch,
      readCache: this.cacheState.readCache,
      docStore: this.cacheState.docStore,
      cachePolicy: this.cacheState.cachePolicy,
      cacheTtlMs: this.cacheState.cacheTtlMs,
      dedupeReads: this.cacheState.dedupeReads,
      inFlightGets: this.cacheState.inFlightGets,
      getPathWriteEpoch: (path: string) => this.getPathWriteEpoch(path),
      getGlobalCacheEpoch: () => this.cacheState.globalCacheEpoch,
      invalidateDocCache: (path: string) => this.invalidateDocCache(path),
      invalidateCollectionCache: (collectionPath: string) => this.invalidateCollectionCache(collectionPath),
      subscribeRealtime: <T>(
        target: { path?: string; query?: unknown; resolveIncludes?: boolean; include?: unknown[] },
        callback: (snapshot: RealtimeSnapshot<T>) => void,
        onError: ((error: unknown) => void) | null,
        converter: DocDataConverter<T> | null
      ) => this.subscribeRealtime(target, callback, onError, converter),
      createCollectionRef: <SubT = Record<string, unknown>>(collectionPath: string) =>
        new CollectionReference<SubT>(this.refContext, collectionPath),
      createCollection: (name: string, options?: CreateCollectionOptions) => this.createCollection(name, options),
      getCollectionInfo: (name: string, options?: RequestOptions) => this.getCollectionInfo(name, options),
      clearCollection: (name: string, options?: RequestOptions) => this.clearCollection(name, options),
      deleteCollection: (name: string, options?: RequestOptions) => this.deleteCollection(name, options),
      importDocuments: (
        collection: string,
        docs: ImportDocumentInput[],
        options?: { mode?: "upsert" | "insert_only"; signal?: AbortSignal }
      ) => this.importDocuments(collection, docs, options),
      exportDocuments: (
        collection: string,
        options?: { limit?: number; cursor?: string | null; signal?: AbortSignal }
      ) => this.exportDocuments(collection, options),
    });

    Object.freeze(this);
  }

  /** Safe JSON representation that never exposes API keys or auth tokens. */
  public toJSON(): { projectId: string; endpoint: string; connectionState: ConnectionState } {
    return {
      projectId: this.projectId,
      endpoint: this.endpoint,
      connectionState: this.realtimeState.currentConnectionState,
    };
  }

  /** Safe string representation that never exposes API keys or auth tokens. */
  public toString(): string {
    return `VellumClient(projectId=${this.projectId}, endpoint=${this.endpoint}, connectionState=${this.realtimeState.currentConnectionState})`;
  }

  public get connectionState(): ConnectionState {
    return this.realtimeState.currentConnectionState;
  }

  public get currentUser(): AuthState | null {
    return this.auth.currentUser;
  }

  /* --------------------------------------------------------------------- */
  /* Cache helpers                                                          */
  /* --------------------------------------------------------------------- */

  private getPathWriteEpoch(path: string): number {
    return this.cacheState.pathWriteEpochs.get(path) ?? 0;
  }

  private invalidateDocCache(path: string): void {
    this.cacheState.pathWriteEpochs.set(path, (this.cacheState.pathWriteEpochs.get(path) ?? 0) + 1);
    this.cacheState.readCache?.invalidatePath(path);
    void this.cacheState.docStore?.deletePath(path).catch(() => undefined);
    const keyPrefix = `${path}\0`;
    for (const key of this.cacheState.inFlightGets.keys()) {
      if (key.startsWith(keyPrefix)) {
        this.cacheState.inFlightGets.delete(key);
      }
    }
  }

  private invalidateCollectionCache(collectionPath: string): void {
    this.cacheState.globalCacheEpoch += 1;
    this.cacheState.readCache?.invalidateCollection(collectionPath);
    const prefix = collectionPath.endsWith("/") ? collectionPath : `${collectionPath}/`;
    void this.cacheState.docStore?.deletePrefix(prefix).catch(() => undefined);
    for (const key of this.cacheState.inFlightGets.keys()) {
      if (key.startsWith(prefix)) {
        this.cacheState.inFlightGets.delete(key);
      }
    }
    for (const path of this.cacheState.pathWriteEpochs.keys()) {
      if (path.startsWith(prefix)) {
        this.cacheState.pathWriteEpochs.set(path, (this.cacheState.pathWriteEpochs.get(path) ?? 0) + 1);
      }
    }
  }

  public clearCache(): void {
    this.resetCaches(true);
  }

  /** Token rotation keeps the offline store (entries are scoped per user); sign-in/out and explicit clears wipe it. */
  private resetCaches(clearStore: boolean): void {
    this.cacheState.globalCacheEpoch += 1;
    this.cacheState.readCache?.clear();
    if (clearStore) void this.cacheState.docStore?.clear().catch(() => undefined);
    this.cacheState.inFlightGets.clear();
  }

  /* --------------------------------------------------------------------- */
  /* Realtime session manager                                               */
  /* --------------------------------------------------------------------- */

  private setConnectionState(next: ConnectionState): void {
    if (this.realtimeState.currentConnectionState === next) return;
    const previous = this.realtimeState.currentConnectionState;
    this.realtimeState.currentConnectionState = next;
    for (const listener of [...this.realtimeState.connectionStateListeners]) {
      try {
        listener(next, previous);
      } catch {
        // A throwing listener must never break realtime state transitions.
      }
    }
  }

  public onConnectionStateChange(listener: ConnectionStateListener): () => void {
    this.realtimeState.connectionStateListeners.add(listener);
    return () => {
      this.realtimeState.connectionStateListeners.delete(listener);
    };
  }

  private handleRealtimeFrame(frame: RealtimeFrame): void {
    const subId = typeof frame["subId"] === "string" ? frame["subId"] : null;
    if (subId === null) return;
    const sub = this.realtimeState.activeSubscriptions.get(subId);
    if (!sub) return;

    const seqNum = parseSeqNumber(frame["seqId"]);

    if (frame["type"] === "initial_sync") {
      if (seqNum !== null) sub.lastSeqId = seqNum;
      sub.docs.clear();
      const rawDocs = Array.isArray(frame["documents"]) ? (frame["documents"] as unknown[]) : [];
      const changes: RealtimeChange<Record<string, unknown>>[] = [];
      for (const raw of rawDocs) {
        const snap = parseWireDocument(raw);
        if (!snap) continue;
        this.invalidateDocCache(snap.path);
        sub.docs.set(snap.path, snap);
        changes.push({ type: "added", seqId: seqNum ?? 0, doc: snap });
      }
      sub.callback({
        changes,
        docs: [...sub.docs.values()],
        watermarkSeqId: sub.lastSeqId === null ? null : String(sub.lastSeqId),
      });
      return;
    }

    if (frame["type"] === "mutation") {
      if (seqNum !== null && (sub.lastSeqId === null || seqNum > sub.lastSeqId)) {
        sub.lastSeqId = seqNum;
      }
      const operation = frame["operation"];
      const changeType = operation === "create" ? "added" : operation === "delete" ? "removed" : "modified";
      const snap = parseWireDocument(frame["document"]);
      if (!snap) return;
      // Events from concurrent writes can arrive out of order. An update that carries an older
      // version than the document already held must not overwrite it.
      // A replay of the same version (an SSE reconnect or an overlapping catch-up) is a duplicate and
      // is not delivered again.
      if (operation === "update" || operation === "create") {
        const held = sub.docs.get(snap.path);
        if (held && snap.version > 0 && held.version >= snap.version) return;
      }
      // Keep the optional bounded read cache consistent with incoming realtime writes.
      this.invalidateDocCache(snap.path);
      if (changeType === "removed") {
        sub.docs.delete(snap.path);
      } else {
        sub.docs.set(snap.path, snap);
      }
      sub.callback({
        changes: [{ type: changeType, seqId: seqNum ?? 0, doc: snap }],
        docs: [...sub.docs.values()],
        watermarkSeqId: sub.lastSeqId === null ? null : String(sub.lastSeqId),
      });
      return;
    }

    if (frame["type"] === "resume_complete") {
      if (seqNum !== null && (sub.lastSeqId === null || seqNum > sub.lastSeqId)) {
        sub.lastSeqId = seqNum;
      }
      return;
    }

    if (frame["type"] === "error" || frame["type"] === "sub_error") {
      if (sub.onError) {
        const error = new Error(String(frame["message"] ?? "Realtime subscription error")) as Error & {
          code?: string;
        };
        error.code = typeof frame["code"] === "string" ? frame["code"] : "REALTIME_ERROR";
        sub.onError(error);
      }
    }
  }

  /** WebSocket first; SSE fallback when WebSocket cannot be used (auto); or a forced transport. */
  private resolveSocketFactory(): WebSocketFactory | null {
    if (this.webSocketFactory) return this.webSocketFactory;
    if (this.realtimeTransportKind === "websocket") return null;
    const sseOptions = this.customFetch ? { fetchFn: this.customFetch as never } : {};
    if (this.realtimeTransportKind === "sse") {
      return (url: string) => new SseSocket(url, sseOptions);
    }
    return createFallbackSocketFactory({
      webSocketFactory: defaultWebSocketFactory,
      sse: sseOptions,
    });
  }

  private ensureTransport(): RealtimeTransport {
    if (this.realtimeState.realtimeTransport) return this.realtimeState.realtimeTransport;
    const opts = this.realtimeTransportOptions;
    this.realtimeState.realtimeTransport = new RealtimeTransport({
      url: this.realtimeUrl ?? toRealtimeUrl(this.endpoint),
      auth: async () => {
        const token = await this.auth.getValidAccessToken(false);
        return {
          projectId: this.projectId,
          apiKey: this.apiKey,
          ...(token ? { authToken: token } : {}),
        };
      },
      onFrame: (frame) => this.handleRealtimeFrame(frame),
      onStateChange: (transportState) => {
        this.setConnectionState(mapTransportState(transportState));
      },
      onError: (error: unknown) => {
        for (const sub of this.realtimeState.activeSubscriptions.values()) {
          if (sub.onError) sub.onError(error);
        }
      },
      webSocketFactory: this.resolveSocketFactory(),
      ...(opts?.randomFn ? { randomFn: opts.randomFn } : {}),
      ...(opts?.heartbeatIntervalMs !== undefined ? { heartbeatIntervalMs: opts.heartbeatIntervalMs } : {}),
      ...(opts?.pongTimeoutMs !== undefined ? { pongTimeoutMs: opts.pongTimeoutMs } : {}),
      ...(opts?.connectTimeoutMs !== undefined ? { connectTimeoutMs: opts.connectTimeoutMs } : {}),
      ...(opts?.maxOutboundQueueSize !== undefined ? { maxOutboundQueueSize: opts.maxOutboundQueueSize } : {}),
    });
    return this.realtimeState.realtimeTransport;
  }

  /** Never carry a prior identity's documents or resume watermarks forward. */
  private endSessionSubscriptions(): void {
    const subscriptions = [...this.realtimeState.activeSubscriptions.values()];
    this.realtimeState.activeSubscriptions.clear();
    this.realtimeState.realtimeTransport?.close();
    this.realtimeState.realtimeTransport = null;
    for (const connection of this.realtimeState.hubConnections) {
      try { connection.close(); } catch { /* already closed */ }
    }
    this.realtimeState.hubConnections.clear();
    this.setConnectionState("disconnected");
    const error = Object.assign(new Error("Authentication session changed; subscribe again"), { code: "SESSION_CHANGED" });
    for (const sub of subscriptions) {
      try { sub.onError?.(error); } catch { /* listener isolation */ }
    }
  }

  private reauthenticateRealtime(nextToken: string): void {
    const transport = this.realtimeState.realtimeTransport;
    if (transport && transport.state === "authenticated") {
      transport.reauthenticate();
    }
    for (const conn of this.realtimeState.hubConnections) {
      try {
        void conn.handleClientFrame({
          type: "auth",
          projectId: this.projectId,
          apiKey: this.apiKey,
          authToken: nextToken,
          userToken: nextToken,
        });
      } catch {
        // Best effort: a closed test-hub session is simply skipped.
      }
    }
  }

  private subscribeRealtime<T>(
    target: { path?: string; query?: unknown; resolveIncludes?: boolean; include?: unknown[] },
    callback: (snapshot: RealtimeSnapshot<T>) => void,
    onError: ((error: unknown) => void) | null,
    converter: DocDataConverter<T> | null = null
  ): () => void {
    this.realtimeState.subscriptionSeq += 1;
    const subId = `sub_${this.realtimeState.subscriptionSeq}_${Math.random().toString(36).slice(2, 10)}`;
    const adaptedCallback = (snapshot: RealtimeSnapshot<Record<string, unknown>>): void => {
      if (!converter) {
        callback(snapshot as unknown as RealtimeSnapshot<T>);
        return;
      }
      callback({
        changes: snapshot.changes.map((change) => ({
          ...change,
          doc: applyConverterToSnapshot(change.doc, converter),
        })),
        docs: snapshot.docs.map((doc) => applyConverterToSnapshot(doc, converter)),
        watermarkSeqId: snapshot.watermarkSeqId,
      });
    };
    const safeTarget =
      target.query === undefined ? target : { ...target, query: realtimeSafeQuery(target.query) };

    const hub = this.realtimeHub as
      | {
          createConnectionSession?: (onFrame: (frame: Record<string, unknown>) => void) => HubConnection;
        }
      | null;
    if (hub && typeof hub.createConnectionSession === "function") {
      if (this.realtimeState.hubConnections.size === 0) {
        this.setConnectionState("connecting");
      }
      const conn = hub.createConnectionSession((frame: Record<string, unknown>) => {
        if (frame["type"] === "auth_ack" || frame["type"] === "initial_sync") {
          this.setConnectionState("connected");
        }
        this.handleRealtimeFrame(frame as unknown as RealtimeFrame);
      });
      this.realtimeState.activeSubscriptions.set(subId, {
        subId,
        callback: adaptedCallback,
        onError,
        lastSeqId: null,
        docs: new Map(),
      });
      this.realtimeState.hubConnections.add(conn);
      void this.auth.getValidAccessToken(false).then((token) => {
        if (!this.realtimeState.activeSubscriptions.has(subId)) return;
        void conn.handleClientFrame({
          type: "auth",
          projectId: this.projectId,
          apiKey: this.apiKey,
          ...(token ? { authToken: token, userToken: token } : {}),
        });
        this.setConnectionState("connected");
        void conn.handleClientFrame({ type: "subscribe", subId, ...safeTarget });
      });
      return () => {
        this.realtimeState.activeSubscriptions.delete(subId);
        this.realtimeState.hubConnections.delete(conn);
        void conn.handleClientFrame({ type: "unsubscribe", subId });
        conn.close();
        if (this.realtimeState.hubConnections.size === 0 && !this.realtimeState.realtimeTransport) {
          this.setConnectionState("disconnected");
        }
      };
    }

    this.realtimeState.activeSubscriptions.set(subId, {
      subId,
      callback: adaptedCallback,
      onError,
      lastSeqId: null,
      docs: new Map(),
    });
    const transport = this.ensureTransport();
    transport.subscribe(subId, safeTarget);
    return () => {
      this.realtimeState.activeSubscriptions.delete(subId);
      transport.unsubscribe(subId);
      if (this.realtimeState.activeSubscriptions.size === 0 && this.realtimeState.realtimeTransport === transport) {
        transport.close();
        this.realtimeState.realtimeTransport = null;
      }
    };
  }

  /* --------------------------------------------------------------------- */
  /* References                                                             */
  /* --------------------------------------------------------------------- */

  public collection<T = Record<string, unknown>>(collectionPath: string): CollectionReferenceInterface<T> {
    return new CollectionReference<T>(this.refContext, collectionPath);
  }

  public doc<T = Record<string, unknown>>(documentPath: string): DocumentReferenceInterface<T> {
    return new DocumentReference<T>(this.refContext, documentPath);
  }

  /* --------------------------------------------------------------------- */
  /* Batch writes & Transactions                                            */
  /* --------------------------------------------------------------------- */

  public async batchWrite(
    writes: Array<BatchWriteOperation | Record<string, unknown>>,
    options: RequestOptions = {}
  ): Promise<unknown> {
    const expanded = writes.map((op) =>
      isRecord(op) && op["type"] === "update" && isRecord(op["data"])
        ? { ...op, data: expandUpdatePaths(op["data"] as Record<string, unknown>) }
        : op
    );
    const res = await this.transport.request("POST", "/batchWrite", { writes: expanded }, {}, true, options.signal);
    for (const op of writes) {
      if (isRecord(op) && typeof op["path"] === "string" && op["path"].length > 0) {
        this.invalidateDocCache(op["path"]);
      }
    }
    return res;
  }

  public async batchWriteChunked(
    operations: readonly unknown[],
    options: BatchWriteChunkedOptions = {}
  ): Promise<BatchWriteChunkedResult> {
    return runBatchWriteChunked(
      { batchWrite: (writes, reqOpts) => this.batchWrite(writes as Parameters<VellumClient["batchWrite"]>[0], reqOpts) },
      operations,
      options
    );
  }

  public async runTransaction<R>(
    updateFunction: (tx: TransactionContext) => Promise<R> | R,
    options: { maxAttempts?: number; signal?: AbortSignal } = {}
  ): Promise<{ result: R; commit: unknown }> {
    const maxAttempts = options.maxAttempts ?? 5;
    if (!Number.isSafeInteger(maxAttempts) || maxAttempts < 1) {
      throw new Error("@vellumdb/sdk-js: maxAttempts must be a positive safe integer");
    }
    await this.auth.getValidAccessToken();
    const sessionEpoch = this.cacheState.sessionEpoch;
    const assertSession = (): void => {
      if (sessionEpoch !== this.cacheState.sessionEpoch) {
        throw Object.assign(new Error("Authentication session changed during transaction"), { code: "SESSION_CHANGED" });
      }
    };
    const { signal } = options;
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      assertSession();
      if (signal?.aborted) {
        throw createAbortError(signal);
      }
      const { transactionToken } = await this.transport.request<{ transactionToken: string }>(
        "POST",
        "/transactions:begin",
        {},
        {},
        true,
        signal
      );
      const stagedWrites: Array<{
        type: "create" | "set" | "update" | "delete";
        path: string;
        data?: Record<string, unknown>;
        merge?: boolean;
      }> = [];

      const transport = this.transport;
      const txContext: TransactionContext = {
        async get<DocT = Record<string, unknown>>(docRef: string | { path: string }): Promise<DocumentSnapshot<DocT>> {
          const path = typeof docRef === "string" ? docRef : docRef.path;
          const encoded = encodeResourcePath(path, "document path");
          let doc: { documentId: string; path: string; version: number; data: DocT };
          try {
            doc = await transport.request<{
              documentId: string;
              path: string;
              version: number;
              data: DocT;
            }>(
              "GET",
              `/documents/${encoded}?transactionToken=${encodeURIComponent(transactionToken)}`,
              undefined,
              {},
              true,
              signal
            );
          } catch (err) {
            // A missing document is a normal read inside a transaction (create-if-absent
            // patterns). Return a non-existing snapshot instead of aborting the transaction.
            if ((err as { status?: number }).status === 404) {
              const segments = path.split("/");
              return Object.freeze({
                id: segments[segments.length - 1] ?? "",
                path,
                version: 0,
                exists: false,
                data: () => undefined as unknown as DocT,
                raw: Object.freeze({}),
              });
            }
            throw err;
          }
          return Object.freeze({
            id: doc.documentId,
            path: doc.path,
            version: doc.version,
            exists: true,
            data: () => sanitizeAndClone(doc.data),
            raw: Object.freeze(sanitizeAndClone(doc)),
          });
        },
        create(docRef: string | { path: string }, data: Record<string, unknown>) {
          const path = typeof docRef === "string" ? docRef : docRef.path;
          encodeResourcePath(path, "document path");
          stagedWrites.push({
            type: "create",
            path,
            data,
          });
        },
        set(docRef: string | { path: string }, data: Record<string, unknown>, setOpts: { merge?: boolean } = {}) {
          const path = typeof docRef === "string" ? docRef : docRef.path;
          encodeResourcePath(path, "document path");
          stagedWrites.push({
            type: "set",
            path,
            data,
            merge: Boolean(setOpts.merge),
          });
        },
        update(docRef: string | { path: string }, data: Record<string, unknown>) {
          const path = typeof docRef === "string" ? docRef : docRef.path;
          encodeResourcePath(path, "document path");
          stagedWrites.push({
            type: "update",
            path,
            data: expandUpdatePaths(data),
          });
        },
        delete(docRef: string | { path: string }) {
          const path = typeof docRef === "string" ? docRef : docRef.path;
          encodeResourcePath(path, "document path");
          stagedWrites.push({
            type: "delete",
            path,
          });
        },
      };

      try {
        const userReturn = await updateFunction(txContext);
        assertSession();
        const commitRes = await this.transport.request(
          "POST",
          "/transactions:commit",
          {
            transactionToken,
            writes: stagedWrites,
          },
          {},
          true,
          signal
        );
        for (const write of stagedWrites) {
          this.invalidateDocCache(write.path);
        }
        return { result: userReturn, commit: commitRes };
      } catch (err: unknown) {
        const errCode = (err as { code?: string } | null | undefined)?.code;
        // Release the server-side transaction instead of leaving it to expire. Best effort:
        // the original error is what the caller needs to see.
        if (errCode !== "SESSION_CHANGED") {
          await this.transport
            .request("POST", "/transactions:rollback", { transactionToken }, {}, true)
            .catch(() => undefined);
        }
        if (signal?.aborted || errCode === "REQUEST_ABORTED") {
          throw err;
        }
        if (errCode === "ABORTED_CONFLICT" && attempt + 1 < maxAttempts) {
          const backoff = computeReconnectBackoffMs(attempt, 25, 500);
          await sleepWithSignal(backoff, signal);
          continue;
        }
        throw err;
      }
    }
    throw new Error("@vellumdb/sdk-js: runTransaction reached max attempts without commit");
  }

  /* --------------------------------------------------------------------- */
  /* Collections lifecycle                                                  */
  /* --------------------------------------------------------------------- */

  public async listCollections(
    options: ListCollectionsOptions = {}
  ): Promise<{ collections: CollectionInfo[]; nextCursor: string | null }> {
    const query = toQueryString({ search: options.search, limit: options.limit, cursor: options.cursor });
    const res: unknown = await this.transport.request("GET", `/collections${query}`, undefined, {}, true, options.signal);
    const record = isRecord(res) ? res : {};
    const rawCollections = Array.isArray(record["collections"]) ? record["collections"] : [];
    const collections: CollectionInfo[] = [];
    for (const raw of rawCollections) {
      const info = toCollectionInfo(raw);
      if (info) collections.push(info);
    }
    const nextCursorValue = record["nextCursor"];
    return {
      collections,
      nextCursor: typeof nextCursorValue === "string" ? nextCursorValue : null,
    };
  }

  public async createCollection(name: string, options: CreateCollectionOptions = {}): Promise<CollectionInfo> {
    encodePathSegment(name, "collection name");
    const { signal, ...bodyOptions } = options;
    const res: unknown = await this.transport.request("POST", "/collections", { name, ...bodyOptions }, {}, true, signal);
    return mapCollectionInfo(res);
  }

  public async getCollectionInfo(name: string, options: RequestOptions = {}): Promise<CollectionInfo | null> {
    const encoded = encodePathSegment(name, "collection name");
    try {
      const res: unknown = await this.transport.request(
        "GET",
        `/collections/${encoded}`,
        undefined,
        {},
        true,
        options.signal
      );
      return toCollectionInfo(res);
    } catch (err: unknown) {
      const status = (err as { status?: number } | null | undefined)?.status;
      if (status === 404) return null;
      throw err;
    }
  }

  public async updateCollection(
    name: string,
    patch: UpdateCollectionInput,
    options: RequestOptions = {}
  ): Promise<CollectionInfo> {
    const encoded = encodePathSegment(name, "collection name");
    const res: unknown = await this.transport.request(
      "PATCH",
      `/collections/${encoded}`,
      patch,
      {},
      true,
      options.signal
    );
    return mapCollectionInfo(res);
  }

  public async clearCollection(
    name: string,
    options: RequestOptions = {}
  ): Promise<{ deletedCount: number; freedBytes: number }> {
    const encoded = encodePathSegment(name, "collection name");
    const res = await this.transport.request<{ deletedCount: number; freedBytes: number }>(
      "POST",
      `/collections/${encoded}/clear`,
      {},
      {},
      true,
      options.signal
    );
    this.invalidateCollectionCache(name);
    return res;
  }

  public async deleteCollection(
    name: string,
    options: RequestOptions = {}
  ): Promise<{ deletedCollection: boolean; deletedDocuments: number; freedBytes: number }> {
    const encoded = encodePathSegment(name, "collection name");
    const res = await this.transport.request<{ deletedCollection: boolean; deletedDocuments: number; freedBytes: number }>(
      "DELETE",
      `/collections/${encoded}`,
      undefined,
      {},
      true,
      options.signal
    );
    this.invalidateCollectionCache(name);
    return res;
  }

  public async importDocuments(
    collection: string,
    docs: ImportDocumentInput[],
    options: { mode?: "upsert" | "insert_only"; signal?: AbortSignal } = {}
  ): Promise<ImportResult> {
    const encoded = encodePathSegment(collection, "collection name");
    const res = await this.transport.request<ImportResult>(
      "POST",
      `/collections/${encoded}/import`,
      {
        documents: docs,
        ...(options.mode !== undefined ? { mode: options.mode } : {}),
      },
      {},
      true,
      options.signal
    );
    this.invalidateCollectionCache(collection);
    return res;
  }

  public async exportDocuments(
    collection: string,
    options: { limit?: number; cursor?: string | null; signal?: AbortSignal } = {}
  ): Promise<ExportResult> {
    const encoded = encodePathSegment(collection, "collection name");
    const query = toQueryString({ limit: options.limit, cursor: options.cursor });
    const res: unknown = await this.transport.request(
      "GET",
      `/collections/${encoded}/export${query}`,
      undefined,
      {},
      true,
      options.signal
    );
    const record = isRecord(res) ? res : {};
    const rawDocuments = Array.isArray(record["documents"]) ? record["documents"] : [];
    const documents: ExportResult["documents"] = [];
    for (const raw of rawDocuments) {
      if (!isRecord(raw)) continue;
      const idValue = raw["id"];
      const documentIdValue = raw["documentId"];
      const pathValue = raw["path"];
      const dataValue = raw["data"];
      const versionValue = raw["version"];
      const createdAtValue = raw["createdAt"];
      const updatedAtValue = raw["updatedAt"];
      documents.push({
        id: typeof idValue === "string" ? idValue : typeof documentIdValue === "string" ? documentIdValue : "",
        path: typeof pathValue === "string" ? pathValue : "",
        data: isRecord(dataValue) ? sanitizeAndClone(dataValue) : {},
        version: typeof versionValue === "number" && Number.isFinite(versionValue) ? versionValue : 0,
        createdAt: typeof createdAtValue === "string" ? createdAtValue : "",
        updatedAt: typeof updatedAtValue === "string" ? updatedAtValue : "",
      });
    }
    const nextCursorValue = record["nextCursor"];
    return {
      documents,
      nextCursor: typeof nextCursorValue === "string" ? nextCursorValue : null,
    };
  }

  /* --------------------------------------------------------------------- */
  /* Auth delegation                                                        */
  /* --------------------------------------------------------------------- */

  public signUpWithEmailAndPassword(input: SignUpWithEmailAndPasswordInput): Promise<AuthState>;
  public signUpWithEmailAndPassword(
    email: string,
    password: string,
    options?: SignUpEmailOptions
  ): Promise<AuthState>;
  public signUpWithEmailAndPassword(
    inputOrEmail: SignUpWithEmailAndPasswordInput | string,
    password?: string,
    options?: SignUpEmailOptions
  ): Promise<AuthState> {
    return typeof inputOrEmail === "string"
      ? this.auth.signUpWithEmailAndPassword(inputOrEmail, password ?? "", options)
      : this.auth.signUpWithEmailAndPassword(inputOrEmail);
  }

  public signInWithEmailAndPassword(
    input: SignInWithEmailAndPasswordInput
  ): Promise<AuthState | MfaRequiredResult>;
  public signInWithEmailAndPassword(
    email: string,
    password: string
  ): Promise<AuthState | MfaRequiredResult>;
  public signInWithEmailAndPassword(
    inputOrEmail: SignInWithEmailAndPasswordInput | string,
    password?: string
  ): Promise<AuthState | MfaRequiredResult> {
    return typeof inputOrEmail === "string"
      ? this.auth.signInWithEmailAndPassword(inputOrEmail, password ?? "")
      : this.auth.signInWithEmailAndPassword(inputOrEmail);
  }

  public signInAnonymously(input?: SignInAnonymouslyInput): Promise<AuthState> {
    return this.auth.signInAnonymously(input);
  }

  public signInWithOAuth(input: SignInWithOAuthInput): Promise<AuthState>;
  public signInWithOAuth(provider: string, payload?: SignInOAuthPayload): Promise<AuthState>;
  public signInWithOAuth(
    providerOrInput: string | SignInWithOAuthInput,
    payload?: SignInOAuthPayload
  ): Promise<AuthState> {
    return typeof providerOrInput === "string"
      ? this.auth.signInWithOAuth(providerOrInput, payload)
      : this.auth.signInWithOAuth(providerOrInput);
  }

  public signInWithPopup(provider: string, options?: OAuthPopupOptions): Promise<AuthState | MfaRequiredResult> {
    return this.auth.signInWithPopup(provider, options);
  }

  public linkWithPopup(provider: string, options?: OAuthPopupOptions): Promise<AuthState | MfaRequiredResult> {
    return this.auth.linkWithPopup(provider, options);
  }

  public signInWithRedirect(provider: string, options?: OAuthRedirectOptions): Promise<void> {
    return this.auth.signInWithRedirect(provider, options);
  }

  public getRedirectResult(): Promise<AuthState | MfaRequiredResult | null> {
    return this.auth.getRedirectResult();
  }

  public signInWithGoogleIdToken(idToken: string, options?: { nonce?: string }): Promise<AuthState | MfaRequiredResult> {
    return this.auth.signInWithGoogleIdToken(idToken, options);
  }

  public signInWithAppleIdToken(
    idToken: string,
    options?: { nonce?: string; authorizationCode?: string; givenName?: string; familyName?: string }
  ): Promise<AuthState | MfaRequiredResult> {
    return this.auth.signInWithAppleIdToken(idToken, options);
  }

  public verifyMfaChallenge(input: VerifyMfaChallengeInput): Promise<AuthState>;
  public verifyMfaChallenge(
    mfaTicket: string,
    code: string,
    factorType?: "totp" | "recovery_code"
  ): Promise<AuthState>;
  public verifyMfaChallenge(
    ticketOrInput: string | VerifyMfaChallengeInput,
    code?: string,
    factorType?: "totp" | "recovery_code"
  ): Promise<AuthState> {
    return typeof ticketOrInput === "string"
      ? this.auth.verifyMfaChallenge(ticketOrInput, code ?? "", factorType)
      : this.auth.verifyMfaChallenge(ticketOrInput);
  }

  public enrollTotpMfa(input?: EnrollTotpMfaInput): Promise<TotpEnrollmentResult> {
    return this.auth.enrollTotpMfa(input);
  }

  public confirmTotpMfa(input: ConfirmTotpMfaInput): Promise<SuccessResult>;
  public confirmTotpMfa(code: string): Promise<SuccessResult>;
  public confirmTotpMfa(codeOrInput: string | ConfirmTotpMfaInput): Promise<SuccessResult> {
    return typeof codeOrInput === "string"
      ? this.auth.confirmTotpMfa(codeOrInput)
      : this.auth.confirmTotpMfa(codeOrInput);
  }

  public disableMfa(code: string): Promise<void> {
    return this.auth.disableMfa(code);
  }

  public sendPasswordResetEmail(input: SendPasswordResetEmailInput): Promise<ActionTokenResult>;
  public sendPasswordResetEmail(email: string): Promise<ActionTokenResult>;
  public sendPasswordResetEmail(
    emailOrInput: string | SendPasswordResetEmailInput
  ): Promise<ActionTokenResult> {
    return typeof emailOrInput === "string"
      ? this.auth.sendPasswordResetEmail(emailOrInput)
      : this.auth.sendPasswordResetEmail(emailOrInput);
  }

  public confirmPasswordReset(input: ConfirmPasswordResetInput): Promise<SuccessResult>;
  public confirmPasswordReset(token: string, newPassword: string): Promise<SuccessResult>;
  public confirmPasswordReset(
    tokenOrInput: string | ConfirmPasswordResetInput,
    newPassword?: string
  ): Promise<SuccessResult> {
    return typeof tokenOrInput === "string"
      ? this.auth.confirmPasswordReset(tokenOrInput, newPassword ?? "")
      : this.auth.confirmPasswordReset(tokenOrInput);
  }

  public sendEmailVerification(input?: SendEmailVerificationInput): Promise<ActionTokenResult> {
    return this.auth.sendEmailVerification(input);
  }

  public confirmEmailVerification(
    input: ConfirmEmailVerificationInput
  ): Promise<EmailVerifyConfirmResult>;
  public confirmEmailVerification(token: string): Promise<EmailVerifyConfirmResult>;
  public confirmEmailVerification(
    tokenOrInput: string | ConfirmEmailVerificationInput
  ): Promise<EmailVerifyConfirmResult> {
    return typeof tokenOrInput === "string"
      ? this.auth.confirmEmailVerification(tokenOrInput)
      : this.auth.confirmEmailVerification(tokenOrInput);
  }

  public getUser(): Promise<VellumAuthUser> {
    return this.auth.getUser();
  }

  public updateProfile(patch: UpdateProfileInput): Promise<VellumAuthUser> {
    return this.auth.updateProfile(patch);
  }

  public listSessions(): Promise<VellumSessionInfo[]> {
    return this.auth.listSessions();
  }

  public revokeSession(sessionId: string): Promise<void> {
    return this.auth.revokeSession(sessionId);
  }

  public listLinkedProviders(): Promise<{ providers: VellumLinkedProvider[]; hasPassword: boolean }> {
    return this.auth.listLinkedProviders();
  }

  public unlinkProvider(provider: string, options?: { currentPassword?: string }): Promise<void> {
    return this.auth.unlinkProvider(provider, options);
  }

  public changePassword(currentPassword: string, newPassword: string): Promise<AuthState> {
    return this.auth.changePassword(currentPassword, newPassword);
  }

  public deleteAccount(options?: { password?: string }): Promise<void> {
    return this.auth.deleteAccount(options);
  }

  public setCustomToken(token: string | null): void {
    this.auth.setCustomToken(token);
  }

  public getIdToken(forceRefresh?: boolean): Promise<string | null> {
    return this.auth.getIdToken(forceRefresh);
  }

  public signOut(options?: SignOutOptions): Promise<void> {
    return this.auth.signOut(options);
  }

  public onAuthStateChanged(cb: AuthStateListener): () => void {
    return this.auth.onAuthStateChanged(cb);
  }

  /* --------------------------------------------------------------------- */
  /* Lifecycle disposal                                                     */
  /* --------------------------------------------------------------------- */

  public dispose(): void {
    this.auth.dispose();
    this.realtimeState.activeSubscriptions.clear();
    if (this.realtimeState.realtimeTransport) {
      this.realtimeState.realtimeTransport.close();
      this.realtimeState.realtimeTransport = null;
    }
    for (const conn of this.realtimeState.hubConnections) {
      try {
        conn.close();
      } catch {
        // best effort
      }
    }
    this.realtimeState.hubConnections.clear();
    this.setConnectionState("disconnected");
    this.realtimeState.connectionStateListeners.clear();
    this.clearCache();
    this.cacheState.inFlightGets.clear();
    this.cacheState.pathWriteEpochs.clear();
  }
}

/**
 * Create a VELLUM client. All requests are addressed to the project directly.
 */
export function createClient(config: ClientConfig): VellumClient {
  return new VellumClient(config);
}
