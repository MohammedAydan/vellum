import type { OAuthPopupOptions, OAuthRedirectOptions } from "./auth/oauth-web.js";
import type { DocStore } from "./cache/doc-store.js";
/**
 * @vellumdb/sdk-js - Types and Interfaces
 * Specification Section 12.1
 */

import type {
  VellumAuthClient,
  SignInOAuthPayload,
  SignOutOptions,
  SignUpEmailOptions,
} from "./auth/auth-client.js";
import type { AuthStorage } from "./auth/auth-storage.js";
import type { WebSocketFactory } from "./realtime/realtime-transport.js";

export interface FieldTransformSentinel {
  readonly $op: string;
  [key: string]: unknown;
}

/** Optional opt-in bounded LRU/TTL read cache configuration for `doc.get()`. */
export interface ReadCacheConfig {
  /** Enable bounded LRU/TTL caching for document reads. Defaults to `false`. */
  enabled?: boolean;
  /** Time-to-live for cached entries in milliseconds. Defaults to `30_000`. */
  ttlMs?: number;
  /** Maximum number of cached entries before LRU eviction. Defaults to `1_000`. */
  maxEntries?: number;
  /**
   * Offline/disk store behind `CachePolicy`. Defaults to IndexedDB in browsers
   * and an in-memory LRU elsewhere. Pass `false` to disable, or your own `DocStore`.
   */
  store?: DocStore | false;
  /** Size cap for the default store in bytes. Defaults to 100 MB. */
  maxCacheSizeBytes?: number;
  /** Freshness window for `cacheFirst` in milliseconds. Defaults to 5 minutes. */
  cacheTtlMs?: number;
}

/**
 * How reads use the offline store.
 * - `networkFirst` (default): fetch, and on connectivity failure return the stored copy with `metadata.fromCache = true`.
 * - `cacheFirst`: use a fresh stored copy, otherwise fetch.
 * - `networkOnly`: never read the store.
 * - `cacheOnly`: only the store; a miss gives a non-existent snapshot.
 */
export type CachePolicy = "networkFirst" | "cacheFirst" | "networkOnly" | "cacheOnly";

/** Public realtime connection lifecycle states observable via `VellumClient`. */
export type ConnectionState = "disconnected" | "connecting" | "connected" | "reconnecting";

/** Callback invoked whenever the client's realtime connection state transitions. */
export type ConnectionStateListener = (state: ConnectionState, previousState: ConnectionState) => void;

export interface ClientConfig {
  projectId: string;
  apiKey: string;
  /** Absolute HTTP(S) origin only, without /v1, credentials, query, or fragment. */
  endpoint?: string;
  /** Explicit realtime WS(S) URL override. Defaults to `<endpoint>/v1/realtime`. */
  realtimeUrl?: string;
  getAuthToken?: (() => Promise<string | null> | string | null) | null;
  /**
   * Session persistence. Since 0.0.9 sessions are memory-only by default: a
   * persisted refresh token is readable by any injected script. Pass
   * `authPersistence: "local"` to keep the session in browser `localStorage`
   * (scoped by endpoint and project), or supply a custom `authStorage`.
   * An explicit `authStorage` always wins over `authPersistence`.
   */
  authStorage?: AuthStorage | null;
  /** Opt-in session persistence. `"local"` stores the session in browser `localStorage`. */
  authPersistence?: "local";
  /** Silent token refresh (60 s before expiry and on 401). Defaults to `true`. */
  autoRefresh?: boolean;
  customFetch?: typeof globalThis.fetch;
  /** Per-request HTTP timeout in milliseconds via `AbortController`. Defaults to `30_000`. Set `0` to disable. */
  timeoutMs?: number;
  /** Maximum transient retry attempts on 429/5xx/network errors for idempotent requests. Defaults to `3`. Set `0` to disable. */
  maxRetries?: number;
  /** Base delay in milliseconds for full-jitter HTTP retry backoff. Defaults to `250`. */
  retryBaseDelayMs?: number;
  /** Maximum delay cap in milliseconds for full-jitter HTTP retry backoff. Defaults to `10_000`. */
  retryMaxDelayMs?: number;
  /** Test seam: deterministic RNG for HTTP retry jitter. */
  retryRandomFn?: (() => number) | null;
  /** Optional opt-in bounded LRU/TTL read cache for `doc.get()` reads. */
  cache?: ReadCacheConfig;
  /** Default read policy for the whole client. Defaults to `networkFirst`; overridable per call. */
  cachePolicy?: CachePolicy;
  /**
   * Opt-in single-flight in-flight GET coalescing: duplicate concurrent
   * `doc.get()` calls for the exact same path & options share one HTTP request
   * while returning independent defensive clones to each caller. Defaults to `false`.
   */
  dedupeReads?: boolean;
  /** Test seam only: inject an in-process realtime hub instead of the native WS transport. */
  realtimeHub?: unknown;
  /**
   * Realtime transport. `"auto"` (default) uses a WebSocket and falls back to HTTP streaming
   * (SSE) automatically when WebSocket cannot be used (a proxy or network that blocks upgrades, a runtime without WebSocket). `"websocket"` never falls
   * back; `"sse"` skips WebSocket. Supplying `webSocketFactory` selects that factory as-is.
   */
  realtimeTransport?: "auto" | "websocket" | "sse";
  /** Test seam: override the WebSocket constructor (defaults to `ws` in Node, global in browsers). */
  webSocketFactory?: WebSocketFactory | null;
  /** Test seam: tune transport timing (heartbeat, reconnect jitter, connect timeout, queue cap). */
  realtimeTransportOptions?: {
    randomFn?: (() => number) | null;
    heartbeatIntervalMs?: number;
    pongTimeoutMs?: number;
    connectTimeoutMs?: number;
    maxOutboundQueueSize?: number;
  } | null;
  /**
   * Print a clickable one-line index suggestion when the server reports a
   * slow/unindexed query via `x-vellum-index-*` response headers.
   * Defaults to `true`. Setting `false` disables both the console warning and
   * the module-level fingerprint dedupe set (see `onIndexSuggestion`).
   */
  warnOnMissingIndexes?: boolean;
  /**
   * Advisory hook invoked for every response carrying an index suggestion,
   * even when `warnOnMissingIndexes` is `false`. Never receives API keys or
   * bearer tokens — only the one-click URL and the parsed suggestion payload.
   */
  onIndexSuggestion?: (event: IndexSuggestionEvent) => void;
}

/** Alias of `ClientConfig` for ergonomic Firebase/Supabase-style imports. */
export type VellumClientConfig = ClientConfig;

/* -------------------------------------------------------------------------- */
/* Enterprise request, streaming, bulk-write & converter types                */
/* -------------------------------------------------------------------------- */

/** Per-request options supporting cooperative cancellation via `AbortSignal`. */
export interface RequestOptions {
  /** Optional AbortSignal composed with the client's per-request `timeoutMs` controller. */
  signal?: AbortSignal;
}

/** Options accepted by `QueryBuilder.get()`. */
export type QueryGetOptions = RequestOptions;

/** Options accepted by `QueryBuilder.pages()` and `QueryBuilder.stream()`. */
export interface QueryStreamOptions extends RequestOptions {
  /** Optional per-page limit override (defaults to the query's `.limit()`). */
  pageSize?: number;
  /** Safety cap on the maximum number of pages to fetch before stopping. */
  maxPages?: number;
  /** Safety cap on the maximum total documents to yield before stopping. */
  maxDocs?: number;
}

/** Progress event emitted as chunks complete inside `batchWriteChunked`. */
export interface BatchWriteChunkProgress {
  completedChunks: number;
  totalChunks: number;
  completedOperations: number;
  totalOperations: number;
  chunkIndex: number;
}

/** Options accepted by `batchWriteChunked`. */
export interface BatchWriteChunkedOptions extends RequestOptions {
  /** Maximum operations per `batchWrite` HTTP request. Defaults to `100`, which is also the maximum (the server limit). */
  chunkSize?: number;
  /** Maximum concurrent in-flight `batchWrite` requests. Defaults to `4`. */
  concurrency?: number;
  /** Advisory progress callback invoked as each chunk finishes. */
  onProgress?: (progress: BatchWriteChunkProgress) => void;
}

/** Result returned by `batchWriteChunked`. */
export interface BatchWriteChunkedResult {
  totalOperations: number;
  totalChunks: number;
  /** Per-chunk server responses ordered by chunk index. */
  results: unknown[];
}

/**
 * Firestore-style bidirectional data converter for end-to-end TypeScript safety
 * on `CollectionRef.withConverter(converter)` and `DocumentRef.withConverter(converter)`.
 */
export interface DocDataConverter<T> {
  /** Serialize a typed domain object `T` into a plain document payload for writes. */
  toDoc(value: T): Record<string, unknown>;
  /** Hydrate a raw `DocumentSnapshot` into the typed domain object `T` on reads. */
  fromDoc(snapshot: DocumentSnapshot<Record<string, unknown>>): T;
}

/* -------------------------------------------------------------------------- */
/* V2 query / write / index-advisor types                                     */
/* -------------------------------------------------------------------------- */

/** A single normalized relation include on the wire. */
export interface IncludeSpec {
  field: string;
  collection?: string;
  as?: string;
  select?: string[];
  include?: IncludeSpec[];
}

/**
 * Caller-facing relation include. A bare string is shorthand for `{ field }`.
 * Nested `include` entries may themselves be strings or objects.
 */
export interface IncludeSpecInput {
  field: string;
  collection?: string;
  as?: string;
  select?: string[];
  include?: unknown[];
}

/** A normalized filter clause shared by query, aggregate and bulk-delete bodies. */
export interface WhereClause {
  field: string;
  op: string;
  value: unknown;
}

export type AggregateOperation = "count" | "sum" | "avg" | "min" | "max";

export interface AggregateMetric {
  op: AggregateOperation;
  field?: string;
}

/** Caller-facing aggregate input (collection/filters come from the builder). */
export interface AggregateInput {
  groupBy?: string[];
  metrics: Record<string, AggregateMetric>;
}

/** Exact body sent to `POST /documents:aggregate`. */
export interface AggregateRequestPayload extends AggregateInput {
  collectionPath: string;
  where: WhereClause[];
  or: WhereClause[][];
}

export interface AggregateRow {
  [key: string]: unknown;
}

export interface AggregateResultPayload {
  rows: AggregateRow[];
  executionTimeMs?: number;
}

export interface BulkDeleteResult {
  deletedCount: number;
}

export interface DocumentGetOptions extends RequestOptions {
  include?: unknown[];
  select?: string[];
  /** Per-call override for single-flight in-flight GET coalescing. */
  dedupe?: boolean;
  /** Skip reading from the bounded read cache for this call when `true`. */
  bypassCache?: boolean;
  /** Per-call override of the client's `cachePolicy`. */
  cachePolicy?: CachePolicy;
}

export interface DocumentSetOptions extends RequestOptions {
  merge?: boolean;
  ifVersion?: number | null;
  ttlSeconds?: number;
  expiresAt?: string;
  upsert?: boolean;
  /** Sent as the Idempotency-Key header: safe retries/replays dedupe server-side (Flutter SDK parity). */
  idempotencyKey?: string;
}

export type DocumentUpsertOptions = Omit<DocumentSetOptions, "upsert">;

export interface DocumentCreateOptions extends RequestOptions {
  ttlSeconds?: number;
  expiresAt?: string;
  /** Sent as the Idempotency-Key header: safe retries/replays dedupe server-side (Flutter SDK parity). */
  idempotencyKey?: string;
}

export interface DocumentUpdateOptions extends RequestOptions {
  ifVersion?: number | null;
  /** Sent as the Idempotency-Key header: safe retries/replays dedupe server-side (Flutter SDK parity). */
  idempotencyKey?: string;
}

export interface DocumentDeleteOptions extends RequestOptions {
  ifVersion?: number;
  /** Sent as the Idempotency-Key header: safe retries/replays dedupe server-side (Flutter SDK parity). */
  idempotencyKey?: string;
}

export interface IndexSuggestionEvent {
  url: string;
  suggestion: unknown;
}

/** A typed realtime document change emitted by `onSnapshot`. */
export interface RealtimeChange<T = Record<string, unknown>> {
  /** `added` (create/initial_sync), `modified` (update), or `removed` (delete). */
  type: "added" | "modified" | "removed" | string;
  seqId: number;
  doc: DocumentSnapshot<T>;
}

/** Typed snapshot delivered to `onSnapshot` callbacks. */
export interface RealtimeSnapshot<T = Record<string, unknown>> {
  changes: RealtimeChange<T>[];
  /** Current materialized result set for query subscriptions (empty for document paths). */
  docs: DocumentSnapshot<T>[];
  /** Highest outbox sequence processed, kept as a string for wire compatibility. */
  watermarkSeqId: string | null;
}

export interface DocumentSnapshot<T = Record<string, unknown>> {
  readonly id: string;
  readonly path: string;
  readonly version: number;
  readonly exists: boolean;
  /** `fromCache` is true when this snapshot was served from the offline store. */
  readonly metadata?: { readonly fromCache: boolean };
  readonly data: () => T;
  readonly raw: unknown;
  /** Resolved relations returned by the server as `_included`, when requested. */
  readonly included?: Record<string, unknown>;
  /** Relation paths the rules engine redacted, returned as `_redactedRefs`. */
  readonly redactedRefs?: string[];
}

export interface QuerySnapshot<T = Record<string, unknown>> {
  readonly docs: DocumentSnapshot<T>[];
  readonly nextCursor: string | null;
  readonly meta: unknown;
}

export interface TransactionContext {
  get<T = Record<string, unknown>>(docRef: string | { path: string }): Promise<DocumentSnapshot<T>>;
  create(docRef: string | { path: string }, data: Record<string, unknown>): void;
  set(
    docRef: string | { path: string },
    data: Record<string, unknown>,
    options?: { merge?: boolean }
  ): void;
  update(docRef: string | { path: string }, data: Record<string, unknown>): void;
  delete(docRef: string | { path: string }): void;
}

export interface QuerySpecPayload {
  collectionPath: string;
  where: WhereClause[];
  orderBy: Array<{ field: string; dir: "asc" | "desc" }>;
  limit: number;
  select: string[] | null;
  startAt: string | null;
  startAfter: string | null;
  /** V2: resolved relations; a bare string shorthand is normalized on the wire. */
  include?: IncludeSpec[];
  /** V2: disjunctive groups (AND inside a group, OR across groups). */
  or?: WhereClause[][];
}

/* -------------------------------------------------------------------------- */
/* End-user auth                                                              */
/* -------------------------------------------------------------------------- */

/** Public, safely-serializable end-user record returned by the auth API. */
export interface VellumAuthUser {
  id: string;
  email: string | null;
  emailVerified: boolean;
  displayName: string | null;
  photoUrl: string | null;
  phoneNumber: string | null;
  phoneVerified: boolean;
  isDisabled: boolean;
  isAnonymous: boolean;
  customClaims: Record<string, unknown>;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
  lastSignInAt: string | null;
}

/**
 * The SDK's signed-in user snapshot: the public user fields plus the token
 * material the SDK holds on the client. This is the value delivered to
 * `onAuthStateChanged` listeners and returned by the sign-in methods.
 */
/** One signed-in device or browser of the current user. */
export interface VellumSessionInfo {
  id: string;
  userAgent: string | null;
  ipAddress: string | null;
  createdAt: string;
  lastRefreshedAt: string | null;
  expiresAt: string;
}

/** A sign-in method linked to the current user. */
export interface VellumLinkedProvider {
  provider: string;
  email: string | null;
  lastSignInAt: string;
  createdAt: string;
}

export interface AuthState extends VellumAuthUser {
  accessToken: string;
  refreshToken: string;
  tokenType: string;
  sessionId: string;
  expiresAt: string;
}

/** Called whenever a user signs in, signs out, or their profile changes. */
export type AuthStateListener = (user: AuthState | null) => void;

/** Returned by sign-in when the account has an enrolled second factor. No session is established. */
export interface MfaRequiredResult {
  mfaRequired: true;
  mfaTicket: string;
  factors: string[];
  expiresAt: string;
}

export interface TotpEnrollmentResult {
  secret: string;
  otpauthUri: string;
  recoveryCodes: string[];
}

export interface SuccessResult {
  success: true;
}

/** Dev-mode password reset / email verification may return a one-time token. */
export interface ActionTokenResult {
  success: true;
  devToken?: string;
  expiresAt?: string;
}

export interface EmailVerifyConfirmResult {
  success: true;
  user?: VellumAuthUser;
}

export interface SignUpWithEmailAndPasswordInput {
  email: string;
  password: string;
  displayName?: string;
  photoUrl?: string | null;
  phoneNumber?: string | null;
  metadata?: Record<string, unknown>;
}

export interface SignInWithEmailAndPasswordInput {
  email: string;
  password: string;
}

export interface SignInAnonymouslyInput {
  displayName?: string;
  metadata?: Record<string, unknown>;
}

export interface SignInWithOAuthInput {
  provider: string;
  idToken?: string;
  accessToken?: string;
  providerUserId?: string;
  email?: string;
  emailVerified?: boolean;
  displayName?: string;
  photoUrl?: string | null;
  metadata?: Record<string, unknown>;
}

export interface VerifyMfaChallengeInput {
  mfaTicket: string;
  code: string;
  factorType?: "totp" | "recovery_code";
}

export interface EnrollTotpMfaInput {
  issuer?: string;
}

/** `disableMfa` accepts this object or a bare code string. */
export interface DisableMfaInput {
  code: string;
}

export interface ConfirmTotpMfaInput {
  code: string;
}

export interface SendPasswordResetEmailInput {
  email: string;
}

export interface ConfirmPasswordResetInput {
  token: string;
  newPassword: string;
}

export interface SendEmailVerificationInput {
  email?: string;
}

export interface ConfirmEmailVerificationInput {
  token: string;
}

export type UpdateProfileInput = {
  email?: string;
  displayName?: string | null;
  photoUrl?: string | null;
  phoneNumber?: string | null;
  phoneVerified?: boolean;
  metadata?: Record<string, unknown>;
  /**
   * Required when changing `email` on an account that has a password: the
   * account's current password. Not needed for Google/GitHub-only accounts.
   */
  currentPassword?: string;
  /**
   * Not supported here: `updateProfile` throws when supplied. Use
   * `changePassword(currentPassword, newPassword)` instead.
   */
  password?: string;
};

/* -------------------------------------------------------------------------- */
/* Collections lifecycle (docs/COLLECTIONS-CONTRACT.md §2.2-2.5)              */
/* -------------------------------------------------------------------------- */

/** Optional per-collection schema enforcement metadata. */
export interface CollectionSchemaValidation {
  requiredFields?: string[];
  strict?: boolean;
}

/**
 * A registered collection joined with its live document/storage statistics.
 * Mirrors the wire `CollectionWithStats` shape; a few identity fields are kept
 * optional so older servers that only reported the collection name can still
 * be mapped without losing type safety.
 */
export interface CollectionInfo {
  id: string;
  name: string;
  description: string | null;
  defaultTtlSeconds: number | null;
  schemaValidation: CollectionSchemaValidation | null;
  documentCount: number;
  storageBytes: number;
  createdAt: string;
  updatedAt: string;
  lastDocumentAt: string | null;
  isSystem?: boolean;
  metadata?: Record<string, unknown>;
  projectId?: string;
}

/** Options accepted by `createCollection` (the name is passed separately). */
export interface CreateCollectionOptions extends RequestOptions {
  description?: string;
  defaultTtlSeconds?: number;
  schemaValidation?: CollectionSchemaValidation;
  metadata?: Record<string, unknown>;
  ifNotExists?: boolean;
}

/** Mutable fields accepted by `updateCollection`. */
export interface UpdateCollectionInput {
  description?: string | null;
  defaultTtlSeconds?: number | null;
  schemaValidation?: CollectionSchemaValidation | null;
  metadata?: Record<string, unknown>;
}

/** One document in a bulk import. */
export interface ImportDocumentInput {
  id?: string;
  data: Record<string, unknown>;
}

/** A single per-document failure inside a bulk collection write. */
export interface CollectionWriteResult {
  index: number;
  message: string;
}

export interface ImportResult {
  importedCount: number;
  skippedCount: number;
  errors: CollectionWriteResult[];
}

export interface ExportResult {
  documents: Array<{
    id: string;
    path: string;
    data: Record<string, unknown>;
    version: number;
    createdAt: string;
    updatedAt: string;
  }>;
  nextCursor: string | null;
}

export interface ListCollectionsOptions extends RequestOptions {
  search?: string;
  limit?: number;
  cursor?: string;
}

/* -------------------------------------------------------------------------- */
/* Public client & reference interfaces                                       */
/* -------------------------------------------------------------------------- */

/**
 * One write inside `batchWrite`. `ifVersion` and `exists` make the batch conditional: the server
 * checks every precondition before it writes anything, so if one document is stale none are
 * changed (HTTP 412, `FAILED_PRECONDITION`). All operations commit in one round trip.
 */
export interface BatchWriteOperation {
  type: "create" | "set" | "update" | "delete";
  path: string;
  data?: Record<string, unknown>;
  /** `set` only: merge into the existing document instead of replacing it. */
  merge?: boolean;
  /** Require the document to be at exactly this version (`0` means it must not exist). */
  ifVersion?: number | null;
  /** Require the document to exist (`true`) or not exist (`false`). */
  exists?: boolean;
}

export interface VellumClientInterface {
  collection<T = Record<string, unknown>>(collectionPath: string): CollectionReferenceInterface<T>;
  doc<T = Record<string, unknown>>(documentPath: string): DocumentReferenceInterface<T>;
  batchWrite(writes: Array<BatchWriteOperation | Record<string, unknown>>, options?: RequestOptions): Promise<unknown>;
  /**
   * Automatically chunk large write arrays into server-safe `batchWrite` calls
   * (default and maximum 100 ops/batch) with bounded concurrency (default 4) and AbortSignal support.
   */
  batchWriteChunked(
    operations: readonly unknown[],
    options?: BatchWriteChunkedOptions
  ): Promise<BatchWriteChunkedResult>;
  /** Clear all entries from the optional bounded read cache. */
  clearCache(): void;
  /** Current realtime connection state (`disconnected`, `connecting`, `connected`, or `reconnecting`). */
  readonly connectionState: ConnectionState;
  /** Subscribe to realtime connection state transitions. Returns an unsubscribe function. */
  onConnectionStateChange(listener: ConnectionStateListener): () => void;

  /** List registered collections with live document/storage statistics. */
  listCollections(
    options?: ListCollectionsOptions
  ): Promise<{ collections: CollectionInfo[]; nextCursor: string | null }>;
  /** Register a new collection. */
  createCollection(name: string, options?: CreateCollectionOptions): Promise<CollectionInfo>;
  /** Fetch one collection's metadata/stats, or `null` when it does not exist. */
  getCollectionInfo(name: string, options?: RequestOptions): Promise<CollectionInfo | null>;
  /** Patch a collection's mutable settings. */
  updateCollection(
    name: string,
    patch: UpdateCollectionInput,
    options?: RequestOptions
  ): Promise<CollectionInfo>;
  /** Delete all documents in a collection while keeping the registration. */
  clearCollection(
    name: string,
    options?: RequestOptions
  ): Promise<{ deletedCount: number; freedBytes: number }>;
  /** Delete the collection registration and all of its documents. */
  deleteCollection(
    name: string,
    options?: RequestOptions
  ): Promise<{ deletedCollection: boolean; deletedDocuments: number; freedBytes: number }>;
  /** Bulk-import documents into a collection. */
  importDocuments(
    collection: string,
    docs: ImportDocumentInput[],
    options?: { mode?: "upsert" | "insert_only"; signal?: AbortSignal }
  ): Promise<ImportResult>;
  /** Page through a collection's documents for export. */
  exportDocuments(
    collection: string,
    options?: { limit?: number; cursor?: string | null; signal?: AbortSignal }
  ): Promise<ExportResult>;

  runTransaction<R>(
    updateFunction: (tx: TransactionContext) => Promise<R> | R,
    options?: { maxAttempts?: number; signal?: AbortSignal }
  ): Promise<{ result: R; commit: unknown }>;

  /** The dedicated auth facade; all auth methods below delegate to it. */
  readonly auth: VellumAuthClient;
  /** Current signed-in session (or `null`). */
  readonly currentUser: AuthState | null;

  /** Create an email/password end-user and establish a session. */
  signUpWithEmailAndPassword(input: SignUpWithEmailAndPasswordInput): Promise<AuthState>;
  signUpWithEmailAndPassword(email: string, password: string, options?: SignUpEmailOptions): Promise<AuthState>;
  /** Sign in. Resolves to `MfaRequiredResult` when a second factor is required. */
  signInWithEmailAndPassword(input: SignInWithEmailAndPasswordInput): Promise<AuthState | MfaRequiredResult>;
  signInWithEmailAndPassword(email: string, password: string): Promise<AuthState | MfaRequiredResult>;
  signInAnonymously(input?: SignInAnonymouslyInput): Promise<AuthState>;
  signInWithOAuth(input: SignInWithOAuthInput): Promise<AuthState>;
  signInWithOAuth(provider: string, payload?: SignInOAuthPayload): Promise<AuthState>;
  /** Google / GitHub sign-in in a popup (call from a click). Resolves to `MfaRequiredResult` when a second factor is required. */
  signInWithPopup(provider: string, options?: OAuthPopupOptions): Promise<AuthState | MfaRequiredResult>;
  /** Link Google or GitHub to the signed-in user's account in a popup. */
  linkWithPopup(provider: string, options?: OAuthPopupOptions): Promise<AuthState | MfaRequiredResult>;
  /** Full-page redirect sign-in; finish with `getRedirectResult()` when your app loads again. */
  signInWithRedirect(provider: string, options?: OAuthRedirectOptions): Promise<void>;
  getRedirectResult(): Promise<AuthState | MfaRequiredResult | null>;
  /** Sign in with a Google ID token from Google Identity Services or `google_sign_in`. Verified by the server. */
  signInWithGoogleIdToken(idToken: string, options?: { nonce?: string }): Promise<AuthState | MfaRequiredResult>;
  /**
   * Sign in with the identityToken from Sign in with Apple (native or Apple's JS). `nonce` is the raw nonce you gave Apple
   * (or its SHA-256, as Apple's native sheet expects); `authorizationCode` lets Vellum revoke the grant when the account is deleted;
   * Apple sends the name only the first time, so pass `givenName`/`familyName` from that first response.
   */
  signInWithAppleIdToken(
    idToken: string,
    options?: { nonce?: string; authorizationCode?: string; givenName?: string; familyName?: string }
  ): Promise<AuthState | MfaRequiredResult>;
  /** Complete an MFA challenge with the ticket returned by a sign-in. */
  verifyMfaChallenge(input: VerifyMfaChallengeInput): Promise<AuthState>;
  verifyMfaChallenge(
    mfaTicket: string,
    code: string,
    factorType?: "totp" | "recovery_code"
  ): Promise<AuthState>;
  /** Begin TOTP enrollment (requires a signed-in user). */
  enrollTotpMfa(input?: EnrollTotpMfaInput): Promise<TotpEnrollmentResult>;
  /** Confirm TOTP enrollment with a one-time code. */
  confirmTotpMfa(input: ConfirmTotpMfaInput): Promise<SuccessResult>;
  confirmTotpMfa(code: string): Promise<SuccessResult>;
  /** Turn MFA off for the signed-in user. Needs a current TOTP or recovery code. */
  disableMfa(input: DisableMfaInput): Promise<void>;
  disableMfa(code: string): Promise<void>;
  sendPasswordResetEmail(input: SendPasswordResetEmailInput): Promise<ActionTokenResult>;
  sendPasswordResetEmail(email: string): Promise<ActionTokenResult>;
  confirmPasswordReset(input: ConfirmPasswordResetInput): Promise<SuccessResult>;
  confirmPasswordReset(token: string, newPassword: string): Promise<SuccessResult>;
  /** Active sessions (devices) of the signed-in user. */
  listSessions(): Promise<VellumSessionInfo[]>;
  /** Sign one of the user's other sessions out. */
  revokeSession(sessionId: string): Promise<void>;
  /** Sign-in methods linked to the account, and whether it has a password. */
  /** Canonical identity listing. */
  listIdentities(): Promise<{ providers: VellumLinkedProvider[]; hasPassword: boolean }>;
  /** @deprecated Use {@link listIdentities}. */
  listLinkedProviders(): Promise<{ providers: VellumLinkedProvider[]; hasPassword: boolean }>;
  /** Remove a linked sign-in method ("google", "github", "apple" or "password"). Refused when it is the last one. */
  unlinkProvider(provider: string, options?: { currentPassword?: string }): Promise<void>;
  /** Change the signed-in user's password (needs the current one); other sessions are ended. */
  changePassword(currentPassword: string, newPassword: string): Promise<AuthState>;
  /** Permanently delete the signed-in account. Password accounts must pass `password`. */
  deleteAccount(options?: { password?: string }): Promise<void>;
  sendEmailVerification(input?: SendEmailVerificationInput): Promise<ActionTokenResult>;
  confirmEmailVerification(input: ConfirmEmailVerificationInput): Promise<EmailVerifyConfirmResult>;
  confirmEmailVerification(token: string): Promise<EmailVerifyConfirmResult>;
  /** Fetch the latest public end-user record. */
  getUser(): Promise<VellumAuthUser>;
  /** Patch the signed-in user's profile and refresh the local snapshot. */
  updateProfile(patch: UpdateProfileInput): Promise<VellumAuthUser>;
  /** Inject an externally issued bearer token; `null` removes it. Wins over `getAuthToken` and the SDK session. */
  setCustomToken(token: string | null): void;
  /** Valid access token, refreshing it when it is close to expiry. */
  getIdToken(forceRefresh?: boolean): Promise<string | null>;
  /** Revoke the session remotely and clear all local auth state. */
  signOut(options?: SignOutOptions): Promise<void>;
  /** Subscribe to sign-in / sign-out / profile updates. Returns an unsubscribe fn. */
  onAuthStateChanged(cb: AuthStateListener): () => void;
  /** Cleanly close realtime connections, clear auth timers, and release listeners. */
  dispose(): void;
}

/** Opt-in depth-1 snapshots of refs when the parent changes, not live joins. */
export interface RealtimeListenOptions {
  resolveIncludes?: boolean;
  include?: Array<string | IncludeSpecInput>;
}

export interface ReferencedByOptions {
  collection?: string;
  field?: string;
  limit?: number;
  cursor?: string;
  select?: string[];
  include?: Array<string | IncludeSpecInput>;
  signal?: AbortSignal;
}

export interface ReferencedByPage<T = Record<string, unknown>> {
  documents: DocumentSnapshot<T>[];
  nextCursor: string | null;
}

export interface DocumentReferenceInterface<T = Record<string, unknown>> {
  readonly path: string;
  readonly id: string;
  collection<SubT = Record<string, unknown>>(subCollectionName: string): CollectionReferenceInterface<SubT>;
  /** Attach a typed bidirectional data converter, or pass `null` to strip an existing converter. */
  withConverter<U>(converter: DocDataConverter<U>): DocumentReferenceInterface<U>;
  withConverter(converter: null): DocumentReferenceInterface<Record<string, unknown>>;
  /**
   * Fetch the document. `include` entries (strings or objects) are normalized
   * and JSON-encoded into the `include` query param; `select` dot paths are
   * JSON-encoded into the `select` query param.
   */
  get(options?: DocumentGetOptions): Promise<DocumentSnapshot<T>>;
  /** Permission-filtered reverse references. Continue while nextCursor is non-null, even after an empty page. */
  referencedBy<D = Record<string, unknown>>(options?: ReferencedByOptions): Promise<ReferencedByPage<D>>;
  create(data: T, options?: DocumentCreateOptions): Promise<unknown>;
  /** `upsert: true` sends an INSERT … ON CONFLICT DO UPDATE write to the server. */
  set(data: T, options?: DocumentSetOptions): Promise<unknown>;
  /** Convenience for `set(data, { ...options, upsert: true })`. */
  upsert(data: T, options?: DocumentUpsertOptions): Promise<unknown>;
  update(data: Record<string, unknown>, options?: DocumentUpdateOptions): Promise<unknown>;
  delete(options?: DocumentDeleteOptions): Promise<unknown>;
  /**
   * BREAKING (0.0.9): the callback receives a `DocumentSnapshot<T>` (not the
   * query-shaped `RealtimeSnapshot`). Missing/deleted documents emit
   * `exists: false` and `data() === null`; state replays are deduped.
   */
  onSnapshot(
    callback: (snapshot: DocumentSnapshot<T>) => void,
    onError?: ((err: unknown) => void) | null,
    options?: RealtimeListenOptions
  ): () => void;
}

export interface QueryBuilderInterface<T = Record<string, unknown>> {
  /**
   * Add a filter. `op` is intentionally open-ended so V2 operators
   * `contains_ci`, `starts_with_ci` and `text_search` pass through unchanged;
   * the server validates the operator against the current contract schema.
   */
  where(field: string, op: string, value: unknown): QueryBuilderInterface<T>;
  orderBy(field: string, dir?: "asc" | "desc"): QueryBuilderInterface<T>;
  limit(n: number): QueryBuilderInterface<T>;
  /** Dot paths are preserved verbatim (e.g. `select("author.name", "meta.score")`). */
  select(...fields: string[]): QueryBuilderInterface<T>;
  /** Eagerly load relations; strings are shorthand for `{ field: string }`. */
  include(relations: Array<string | IncludeSpecInput>): QueryBuilderInterface<T>;
  /** Disjunctive groups: AND within each group, OR across groups. */
  or(groups: Array<Array<WhereClause>>): QueryBuilderInterface<T>;
  startAt(cursor: string): QueryBuilderInterface<T>;
  startAfter(cursor: string): QueryBuilderInterface<T>;
  /** Attach a typed bidirectional data converter, or pass `null` to strip an existing converter. */
  withConverter<U>(converter: DocDataConverter<U>): QueryBuilderInterface<U>;
  withConverter(converter: null): QueryBuilderInterface<Record<string, unknown>>;
  toQuerySpec(): QuerySpecPayload;
  get(options?: QueryGetOptions): Promise<QuerySnapshot<T>>;
  /**
   * Cursor-based async generator yielding one `QuerySnapshot<T>` page at a time
   * without buffering the entire dataset in memory.
   */
  pages(options?: QueryStreamOptions): AsyncGenerator<QuerySnapshot<T>, void, undefined>;
  /**
   * Cursor-based async generator yielding individual `DocumentSnapshot<T>` records
   * across all pages with bounded memory usage and optional `maxPages` / `maxDocs` / `signal`.
   */
  stream(options?: QueryStreamOptions): AsyncGenerator<DocumentSnapshot<T>, void, undefined>;
  /**
   * Terminal aggregation. Without a (non-empty) `groupBy` the numeric value of
   * the first named metric in the first returned row is resolved; with a
   * `groupBy` the full rows array is returned so callers can read every group.
   */
  aggregate(input: AggregateInput & { groupBy: string[] }, options?: RequestOptions): Promise<AggregateRow[]>;
  aggregate(input: AggregateInput, options?: RequestOptions): Promise<number>;
  /** `aggregate({ metrics: { count: { op: "count" } } })` → numeric count. */
  count(options?: RequestOptions): Promise<number>;
  sum(field: string, options?: RequestOptions): Promise<number>;
  avg(field: string, options?: RequestOptions): Promise<number>;
  min(field: string, options?: RequestOptions): Promise<number>;
  max(field: string, options?: RequestOptions): Promise<number>;
  /** Terminal bulk delete using the builder's collection/filters. */
  deleteWhere(options?: { limit?: number; signal?: AbortSignal }): Promise<BulkDeleteResult>;
  onSnapshot(
    callback: (snapshot: RealtimeSnapshot<T>) => void,
    onError?: ((err: unknown) => void) | null,
    options?: RealtimeListenOptions
  ): () => void;
}

export interface CollectionReferenceInterface<T = Record<string, unknown>> extends QueryBuilderInterface<T> {
  /** Address a document. Omit `docId` to generate a unique ID locally (no network request). */
  doc(docId?: string): DocumentReferenceInterface<T>;
  /** Create a new document in this collection with an auto-generated ID. */
  add(data: T, options?: DocumentCreateOptions): Promise<DocumentReferenceInterface<T>>;
  /**
   * Create a document plus related documents in one atomic request. The parent
   * receives `field: [refs]`; children get a `parentField` reference back when set.
   */
  addWithRelated(
    data: T,
    related: Record<string, { collection: string; docs: Record<string, unknown>[]; parentField?: string }>,
    options?: RequestOptions & { idempotencyKey?: string }
  ): Promise<DocumentReferenceInterface<T>>;
  /** Attach a typed bidirectional data converter, or pass `null` to strip an existing converter. */
  withConverter<U>(converter: DocDataConverter<U>): CollectionReferenceInterface<U>;
  withConverter(converter: null): CollectionReferenceInterface<Record<string, unknown>>;
  /** Register this collection. */
  create(options?: CreateCollectionOptions): Promise<CollectionInfo>;
  /** Fetch this collection's metadata/stats (or `null`). */
  info(options?: RequestOptions): Promise<CollectionInfo | null>;
  /** Delete every document in this collection. */
  clear(options?: RequestOptions): Promise<{ deletedCount: number; freedBytes: number }>;
  /** Alias of `deleteCollection` for this collection. */
  drop(options?: RequestOptions): Promise<{ deletedCollection: boolean; deletedDocuments: number; freedBytes: number }>;
  /** Alias of `drop()` for deleting this collection and all of its documents. */
  delete(
    options?: RequestOptions
  ): Promise<{ deletedCollection: boolean; deletedDocuments: number; freedBytes: number }>;
  /** Bulk-import documents into this collection. */
  import(
    docs: ImportDocumentInput[],
    options?: { mode?: "upsert" | "insert_only"; signal?: AbortSignal }
  ): Promise<ImportResult>;
  /** Page through this collection's documents for export. */
  export(
    options?: { limit?: number; cursor?: string | null; signal?: AbortSignal }
  ): Promise<ExportResult>;
}
