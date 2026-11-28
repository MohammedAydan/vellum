/**
 * @vellum/realtime - Realtime Gateway Hub
 * WebSocket Protocol Multiplexer, Subscription Registry, Outbox Poller, and Event Fan-Out.
 * Strictly adheres to §9.2 ServerFrame and ClientFrame specifications.
 *
 * Security, Reliability & Performance Hardening:
 * - O(tenant_connections) fan-out via `connectionsByProject` secondary index (instead of O(global)).
 * - Re-authentication clears prior subscriptions and re-indexes tenant ownership (prevents tenant hijack).
 * - Continuous JWT `exp` & API key expiration/revocation checks on subscribe and live fan-out.
 * - Live active-ruleset re-evaluation on fan-out when a project ruleset is active.
 * - Strict `resumeSeqId` safe-integer validation, mid-replay abort on disconnect/unsubscribe,
 *   and bounded `pendingLiveEvents` / `matchedPaths` / `seenSeqIds` caps (DoS protection).
 * - Tenant-scoped defense-in-depth filtering in `notifyCommittedEvents` and defensive `structuredClone`
 *   on fan-out payloads so broken/mutating client callbacks cannot affect other subscribers.
 */

import { projectDocumentFields } from "@vellum/document-engine";
import { enrichRealtimeDocument, fetchRealtimeReferences, validateRealtimeIncludes } from "./relation-includes.js";
import crypto from "node:crypto";
import { VellumError, SYSTEM_LIMITS, parseDocumentPath, compareWireValues, type ErrorCode } from "@vellum/core";
import { validateClientWsFrame, type ServerFrame, type ClientFrame } from "@vellum/api-contract";
import { verifyEndUserAccessToken } from "@vellum/auth";
import {
  verifyApiKey,
  authorizeOperation,
  type ApiKeyRecord,
  type AuthContext,
  type SecurityRulesetRecord,
  collectRuleLookups,
  rulesetUsesLookups,
  type RuleLookups,
} from "@vellum/authorization";
import { validateAndNormalizeQuery, documentMatchesQuery, extractDocFieldValue, compileQueryToParameterizedSql } from "@vellum/query-engine";
import type { StorageAdapter, OutboxEvent, DocumentRecord, TxHandle } from "@vellum/storage";
import type {
  ConnectionSession,
  ConnectionSessionHandle,
  ControlStoreForRealtime,
  RealtimeHubOptions,
  ResumeCompleteFrame,
  SubscriptionRecord,
} from "./types.js";
import { isOutboxSeqReadable, type RealtimeGatewayPort } from "./contracts/realtime-port.js";

/** Hard cap on events replayed by a single `resumeSeqId` subscribe frame. */
export const MAX_REPLAY_EVENTS = 5_000;
/** Hard cap on live events buffered per subscription during an active replay walk. */
export const MAX_PENDING_LIVE_EVENTS = 10_000;
/** Hard cap on tracked matched document paths per query subscription. */
export const MAX_MATCHED_PATHS_PER_SUB = 50_000;

const REPLAY_QUERY_BATCH = 500;
const MAX_SEEN_SEQ_IDS = 10_000;
const MAX_AUTH_TOKEN_BYTES = 16_384;

function parseSafeSeqBigInt(seqId: string): bigint | null {
  if (typeof seqId !== "string" || !/^[0-9]{1,20}$/.test(seqId)) return null;
  try {
    return BigInt(seqId);
  } catch {
    return null;
  }
}

function pruneOldestHalf(set: Set<string>, maxSize: number): void {
  if (set.size <= maxSize) return;
  let toDelete = set.size - Math.floor(maxSize / 2);
  for (const key of set) {
    if (toDelete <= 0) break;
    set.delete(key);
    toDelete -= 1;
  }
}

/** Upper bound of rows one subscribe window may read before it falls back to the exact full scan. */
const REALTIME_SUBSCRIBE_MAX_FETCH = 5_000;

/**
 * Subscription map that keeps the hub's per-project routing index in step with every set/delete/clear,
 * so an event only visits subscriptions that can match its path or collection.
 */
class IndexedSubscriptionMap extends Map<string, SubscriptionRecord> {
  private readonly routeKeys = new Map<SubscriptionRecord, string>();
  constructor(
    private readonly index: Map<string, Map<SubscriptionRecord, ConnectionSession>>,
    private readonly version: { n: number },
    private readonly owner: () => ConnectionSession,
    private readonly projectOf: () => string | null
  ) {
    super();
  }
  private unindex(record: SubscriptionRecord): void {
    const key = this.routeKeys.get(record);
    if (key === undefined) return;
    this.routeKeys.delete(record);
    const bucket = this.index.get(key);
    if (!bucket) return;
    bucket.delete(record);
    if (bucket.size === 0) this.index.delete(key);
  }
  override set(subId: string, record: SubscriptionRecord): this {
    const prev = super.get(subId);
    if (prev) this.unindex(prev);
    super.set(subId, record);
    this.version.n += 1;
    const projectId = this.projectOf();
    const route = record.path ? `d:${record.path}` : record.normalizedQuery ? `c:${record.normalizedQuery.collectionPath}` : null;
    if (projectId && route) {
      const key = `${projectId}\u0000${route}`;
      let bucket = this.index.get(key);
      if (!bucket) this.index.set(key, (bucket = new Map()));
      bucket.set(record, this.owner());
      this.routeKeys.set(record, key);
    }
    return this;
  }
  override delete(subId: string): boolean {
    const prev = super.get(subId);
    if (prev) this.unindex(prev);
    return super.delete(subId);
  }
  override clear(): void {
    for (const record of [...super.values()]) this.unindex(record);
    super.clear();
  }
}

/** P0-2: maximum sessions checked or delivered to concurrently during one fan-out. */
const FANOUT_SESSION_CONCURRENCY = 32;

/**
 * Run `worker` over `items` with at most `limit` in flight. Items are visited
 * in order and each item starts only after a lane frees up, so per-item side
 * effects for one event stay ordered while independent items overlap.
 */
async function runBounded<T>(items: readonly T[], limit: number, worker: (item: T) => Promise<void>): Promise<void> {
  if (items.length === 0) return;
  let next = 0;
  const lanes = Math.max(1, Math.min(limit, items.length));
  const runners: Promise<void>[] = [];
  for (let lane = 0; lane < lanes; lane += 1) {
    runners.push(
      (async () => {
        for (;;) {
          const index = next;
          next += 1;
          if (index >= items.length) return;
          const item = items[index];
          if (item === undefined && index >= items.length) return;
          await worker(item as T);
        }
      })()
    );
  }
  await Promise.all(runners);
}

export class RealtimeGatewayHub implements RealtimeGatewayPort {
  public readonly controlStore: ControlStoreForRealtime;
  public readonly dataStore: StorageAdapter;
  /** Retained for backwards compatibility only; end-user JWTs are EdDSA. */
  public readonly jwtSecret: string;
  private readonly apiKeyPepper: string | undefined;
  public readonly connections = new Map<string, ConnectionSession>();
  public readonly watermarks = new Map<string, bigint>();
  /** O(1) tenant lookup index for multi-tenant fan-out without scanning unrelated sessions. */
  private readonly deliveryTails = new Map<string, Promise<void>>();
  private readonly connectionsByProject = new Map<string, Set<ConnectionSession>>();
  /** `${projectId}\0d:${path}` or `${projectId}\0c:${collectionPath}` -> subscriptions that can match that event. */
  private readonly subscriptionIndex = new Map<string, Map<SubscriptionRecord, ConnectionSession>>();
  /** Bumped on every index change so an in-flight fan-out can notice a subscription added while it awaited. */
  private readonly subscriptionIndexVersion = { n: 0 };
  /** P0-2: invoked when a session authenticates so the outbox poller initializes the tenant watermark first. */
  private tenantSessionStartHook: ((projectId: string) => void) | null = null;

  /** Wire the outbox poller's tenant bootstrap; called once during composition. */
  public setTenantSessionStartHook(hook: ((projectId: string) => void) | null): void {
    this.tenantSessionStartHook = hook;
  }

  constructor(options: RealtimeHubOptions) {
    this.apiKeyPepper = options.apiKeyPepper;
    this.controlStore = options.controlStore;
    this.dataStore = options.dataStore;
    this.jwtSecret = options.jwtSecret ?? "vellum_jwt_secret_v1";
    const ttl = Number(process.env["REALTIME_KEY_RECHECK_TTL_MS"] ?? 3000);
    this.keyRecheckTtlMs = Number.isFinite(ttl) && ttl >= 0 ? ttl : 3000;
    const sessionTtl = Number(process.env["REALTIME_SESSION_RECHECK_MS"] ?? 5000);
    this.sessionRecheckMs = Number.isFinite(sessionTtl) && sessionTtl >= 0 ? sessionTtl : 5000;
  }

  /** How often a socket's end-user session is confirmed active, both for inbound frames and before each delivered event. */
  private readonly sessionRecheckMs: number;

  /**
   * Active-key results for the per-event credential recheck, kept for a few seconds so an event stream does
   * not hit the control database once per event per key. Only an active key is cached, so a revoked key
   * is dropped from sessions within REALTIME_KEY_RECHECK_TTL_MS (default 3 s, 0 disables).
   */
  private readonly keyRecheckCache = new Map<string, { record: ApiKeyRecord; expiresAt: number }>();
  private readonly keyRecheckTtlMs: number;

  /** Drops cached key rechecks (call after a key is revoked or edited in this process). */
  public invalidateKeyRecheckCache(): void {
    this.keyRecheckCache.clear();
  }

  private indexSessionForProject(session: ConnectionSession, projectId: string): void {
    let bucket = this.connectionsByProject.get(projectId);
    if (!bucket) {
      bucket = new Set();
      this.connectionsByProject.set(projectId, bucket);
    }
    bucket.add(session);
  }

  private unindexSession(session: ConnectionSession): void {
    if (!session.projectId) return;
    const bucket = this.connectionsByProject.get(session.projectId);
    if (!bucket) return;
    bucket.delete(session);
    if (bucket.size === 0) {
      this.connectionsByProject.delete(session.projectId);
    }
  }

  private closeSession(session: ConnectionSession): void {
    session.closed = true;
    session.subscriptions.clear();
    this.unindexSession(session);
    this.connections.delete(session.connectionId);
  }

  /**
   * Returns a VellumError if the session's end-user JWT or API key has expired
   * or been revoked since the initial WS handshake; otherwise returns null.
   */
  private async checkSessionCredentialExpiry(
    session: ConnectionSession,
    nowMs: number = Date.now(),
    keyMemo?: Map<string, Promise<ApiKeyRecord | null | undefined>>
  ): Promise<VellumError | null> {
    const apiKey0 = session.apiKeyRecord;
    if (apiKey0) {
      // Authoritative lookup by identity from PostgreSQL (memoised per dispatch so
      // a fan-out to N sessions sharing a key costs one query, not N).
      let pending = keyMemo?.get(apiKey0.keyPrefix);
      if (!pending) {
        pending = this.lookupKeyForRecheck(apiKey0.keyPrefix);
        keyMemo?.set(apiKey0.keyPrefix, pending);
      }
      const current = await pending;
      if (current !== undefined) {
        if (!current || current.id !== apiKey0.id || current.projectId !== session.projectId) {
          return new VellumError("UNAUTHENTICATED", "API key is no longer active");
        }
        session.apiKeyRecord = current;
      }
    }
    return this.checkLocalCredentialExpiry(session, nowMs);
  }

  private async lookupKeyForRecheck(prefix: string): Promise<ApiKeyRecord | null | undefined> {
    if (this.keyRecheckTtlMs === 0) return this.lookupKeyByPrefix(prefix);
    const hit = this.keyRecheckCache.get(prefix);
    const now = Date.now();
    if (hit && hit.expiresAt > now && !hit.record.revokedAt) return hit.record;
    const record = await this.lookupKeyByPrefix(prefix);
    if (record) {
      if (this.keyRecheckCache.size >= 1000) this.keyRecheckCache.clear();
      this.keyRecheckCache.set(prefix, { record, expiresAt: now + this.keyRecheckTtlMs });
    } else {
      this.keyRecheckCache.delete(prefix);
    }
    return record;
  }

  /** Reads the key from PostgreSQL when the store can; `undefined` = store cannot look up. */
  private async lookupKeyByPrefix(prefix: string): Promise<ApiKeyRecord | null | undefined> {
    const store = this.controlStore;
    if (store.findApiKeyByPrefix) return store.findApiKeyByPrefix(prefix);
    if (store.getApiKeyByPrefix) return store.getApiKeyByPrefix(prefix);
    if ("apiKeysByPrefix" in store && store.apiKeysByPrefix instanceof Map) {
      return (store.apiKeysByPrefix.get(prefix) as ApiKeyRecord | undefined) ?? null;
    }
    return undefined;
  }

  private async rulesetFor(projectId: string): Promise<SecurityRulesetRecord | null> {
    const store = this.controlStore;
    return (store.getActiveRulesetAsync ? await store.getActiveRulesetAsync(projectId) : store.getActiveRuleset(projectId)) ?? null;
  }

  /** Local checks on the session's held credentials (no I/O). */
  private checkLocalCredentialExpiry(session: ConnectionSession, nowMs: number): VellumError | null {
    const apiKey = session.apiKeyRecord;
    if (apiKey) {
    if (apiKey.revokedAt) {
        return new VellumError("UNAUTHENTICATED", "API key has been revoked");
      }
      if (apiKey.expiresAt) {
        const keyExpMs = Date.parse(apiKey.expiresAt);
        if (Number.isFinite(keyExpMs) && keyExpMs <= nowMs) {
          return new VellumError("TOKEN_EXPIRED", "API key has expired");
        }
      }
    }
    const tokenExp = session.authContext.token?.["exp"];
    if (typeof tokenExp === "number" && Number.isFinite(tokenExp)) {
      if (tokenExp * 1000 <= nowMs) {
        return new VellumError("TOKEN_EXPIRED", "End-user access token has expired");
      }
    }
    return null;
  }

  /**
   * Verifies a realtime `authToken` exactly like the document-plane middleware
   * (`apps/api/src/middleware/tenant-auth.ts`): EdDSA-only against the project's
   * Ed25519 public key, with the same project-scoped issuer and audience rules.
   * There is deliberately no HMAC/HS256 fallback and no anonymous bypass for a
   * supplied token.
   */
  private async resolveAuthenticatedContext(
    rawToken: string,
    projectId: string
  ): Promise<AuthContext> {
    if (typeof rawToken !== "string" || rawToken.length > MAX_AUTH_TOKEN_BYTES) {
      throw new VellumError("UNAUTHENTICATED", "Invalid end-user access token");
    }
    const token = rawToken.replace(/^Bearer\s+/i, "").trim();
    if (!token) throw new VellumError("UNAUTHENTICATED", "Empty end-user access token");
    const config = this.controlStore.getAuthConfigAsync
      ? await this.controlStore.getAuthConfigAsync(projectId)
      : this.controlStore.getAuthConfig?.(projectId);
    if (!config?.jwtPublicKeyPem) {
      throw new VellumError(
        "UNAUTHENTICATED",
        "End-user authentication is not configured for this project"
      );
    }
    let payload;
    try {
      payload = verifyEndUserAccessToken(token, config.jwtPublicKeyPem, {
        projectId,
        issuer: `https://api.vellum.dev/v1/projects/${projectId}/auth`,
      });
    } catch (err) {
      if (err instanceof VellumError && err.code === "TOKEN_EXPIRED") throw err;
      // Never echo token material or verifier internals to the client.
      throw new VellumError("UNAUTHENTICATED", "Invalid end-user access token");
    }
    if (typeof payload.sid === "string") {
      const active = await this.isSessionStillActive(projectId, payload.sid, payload.sub);
      if (!active) throw new VellumError("UNAUTHENTICATED", "Invalid end-user access token");
    }
    return {
      uid: payload.sub,
      claims: payload.claims ?? {},
      email: payload.email ?? null,
      email_verified: payload.email_verified === true,
      is_anonymous: payload.is_anonymous === true,
      token: { ...payload },
    };
  }

  /** Last time each socket's auth session was confirmed active (re-checked at most every `sessionRecheckMs`, 5 s by default). */
  private readonly sessionCheckedAt = new WeakMap<ConnectionSession, number>();

  private async isSessionStillActive(projectId: string, sid: string, uid: string): Promise<boolean> {
    const store = this.dataStore as { isAuthSessionActive?: (ctx: { projectId: string }, s: string, u: string) => Promise<boolean> };
    if (typeof store.isAuthSessionActive !== "function") return true;
    return store.isAuthSessionActive({ projectId }, sid, uid);
  }

  /** Closes a socket whose end-user session was revoked or whose user was disabled after it connected. */
  private async checkSessionStillActive(session: ConnectionSession): Promise<VellumError | null> {
    const sid = session.authContext.token?.["sid"];
    const uid = session.authContext.uid;
    if (typeof sid !== "string" || !uid || !session.projectId) return null;
    const now = Date.now();
    if (this.sessionRecheckMs > 0 && now - (this.sessionCheckedAt.get(session) ?? 0) < this.sessionRecheckMs) return null;
    this.sessionCheckedAt.set(session, now);
    if (await this.isSessionStillActive(session.projectId, sid, uid)) return null;
    return new VellumError("UNAUTHENTICATED", "End-user session is no longer active");
  }

  public createConnectionSession(
    sendFrameCallback: (frame: ServerFrame) => void
  ): ConnectionSessionHandle {
    const connectionId = `conn_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`;
    const session: ConnectionSession = {
      connectionId,
      connectedAt: Date.now(),
      authenticated: false,
      projectId: null,
      apiKeyRecord: null,
      authContext: { uid: null, claims: {} },
      subscriptions: new IndexedSubscriptionMap(this.subscriptionIndex, this.subscriptionIndexVersion, () => session, () => session.projectId),
      outboundBufferedBytes: 0,
      closed: false,
      sendFrame: (frame: ServerFrame) => {
        if (session.closed) return;
        const serialized = JSON.stringify(frame);
        const bytes = Buffer.byteLength(serialized, "utf8");
        if (session.outboundBufferedBytes + bytes > SYSTEM_LIMITS.MAX_WS_OUTBOUND_BUFFER_BYTES) {
          this.closeSession(session);
          try {
            sendFrameCallback({
              type: "error",
              code: "SLOW_CONSUMER_DISCONNECT",
              message: `Outbound buffered bytes exceeded maximum ${SYSTEM_LIMITS.MAX_WS_OUTBOUND_BUFFER_BYTES} bytes`,
            });
          } catch {
            // Consumer socket already broken; session is already removed.
          }
          return;
        }
        try {
          sendFrameCallback(frame);
        } catch {
          // Isolate broken consumer callbacks so fan-out to healthy clients continues.
          this.closeSession(session);
        }
      },
    };
    this.connections.set(connectionId, session);

    return {
      connectionId,
      handleClientFrame: async (rawFrame: unknown) => this.handleClientFrame(connectionId, rawFrame),
      setSimulatedBackpressureBytes: (bytes: number) => {
        session.outboundBufferedBytes = Number.isFinite(bytes) && bytes >= 0 ? bytes : 0;
      },
      close: () => {
        this.closeSession(session);
      },
    };
  }

  public async handleClientFrame(connectionId: string, rawFrame: unknown): Promise<void> {
    const session = this.connections.get(connectionId);
    if (!session || session.closed) {
      throw new VellumError("FAILED_PRECONDITION", "WebSocket connection is closed");
    }

    const frame: ClientFrame = validateClientWsFrame(rawFrame);

    if (frame.type === "ping") {
      session.sendFrame({ type: "pong", ts: frame.ts, serverTs: Date.now() });
      return;
    }

    if (frame.type === "auth") {
      // The control plane may return either a bare project record or a
      // `{ project }` wrapper; accept both defensively and verify the id.
      const lookup = this.controlStore.getProjectAsync
        ? await this.controlStore.getProjectAsync(frame.projectId)
        : this.controlStore.getProject(frame.projectId);
      const project = lookup && "project" in lookup ? lookup.project : lookup;
      if (!project || project.id !== frame.projectId) {
        throw new VellumError("NOT_FOUND", "Project not found");
      }
      const storeForApiKey = {
        apiKeysByPrefix:
          "apiKeysByPrefix" in this.controlStore && this.controlStore.apiKeysByPrefix instanceof Map
            ? this.controlStore.apiKeysByPrefix
            : new Map<string, ApiKeyRecord>(),
      };
      if (
        storeForApiKey.apiKeysByPrefix.size === 0 &&
        (this.controlStore.findApiKeyByPrefix || this.controlStore.getApiKeyByPrefix) &&
        typeof frame.apiKey === "string"
      ) {
        const prefix = frame.apiKey.slice(0, 16);
        const rec = await this.lookupKeyByPrefix(prefix);
        if (rec) {
          storeForApiKey.apiKeysByPrefix.set(prefix, rec);
        }
      }

      const apiKeyRecord = verifyApiKey(frame.apiKey, storeForApiKey, this.apiKeyPepper);
      if (apiKeyRecord.projectId !== frame.projectId) {
        throw new VellumError("PERMISSION_DENIED", "API key does not belong to target project");
      }

      const authContext = frame.authToken
        ? await this.resolveAuthenticatedContext(frame.authToken, frame.projectId)
        : { uid: null, claims: {} };

      if (session.closed) {
        throw new VellumError("FAILED_PRECONDITION", "WebSocket connection is closed");
      }

      // On re-authentication, tear down all prior subscriptions and tenant index
      // bindings so stale credentials or cross-tenant subscriptions never persist.
      if (session.authenticated) {
        session.subscriptions.clear();
        this.unindexSession(session);
      }

      session.authenticated = true;
      session.projectId = frame.projectId;
      session.apiKeyRecord = apiKeyRecord;
      session.authContext = authContext;
      this.indexSessionForProject(session, frame.projectId);

      // P0-2: the tenant's poller watermark must exist before any subscribe
      // snapshot below, so a write landing between snapshot and first drain is
      // fanned out live instead of skipped. Never fail auth over the hook.
      try {
        this.tenantSessionStartHook?.(frame.projectId);
      } catch {
        /* poller warm-up only */
      }

      session.sendFrame({
        type: "auth_ack",
        status: "authenticated",
        connectionId,
      });
      return;
    }

    if (!session.authenticated) {
      throw new VellumError("UNAUTHENTICATED", "WebSocket connection must authenticate with an 'auth' frame first");
    }

    const expiryErr = (await this.checkSessionCredentialExpiry(session)) ?? (await this.checkSessionStillActive(session));
    if (expiryErr) {
      session.sendFrame({
        type: "error",
        code: expiryErr.code,
        message: expiryErr.message,
      });
      this.closeSession(session);
      throw expiryErr;
    }

    if (frame.type === "unsubscribe") {
      session.subscriptions.delete(frame.subId);
      return;
    }

    if (frame.type === "subscribe") {
      if (
        !session.subscriptions.has(frame.subId) &&
        session.subscriptions.size >= SYSTEM_LIMITS.MAX_WS_SUBSCRIPTIONS_PER_CONN
      ) {
        session.sendFrame({
          type: "error",
          subId: frame.subId,
          code: "SUBSCRIPTION_LIMIT_EXCEEDED",
          message: `Maximum of ${SYSTEM_LIMITS.MAX_WS_SUBSCRIPTIONS_PER_CONN} active subscriptions per connection exceeded`,
        });
        return;
      }

      try {
        await this.setupSubscription(session, frame);
      } catch (err: unknown) {
        const docErr = err as { code?: ErrorCode; message?: string };
        session.sendFrame({
          type: "error",
          subId: frame.subId,
          code: docErr.code ?? "INTERNAL",
          message: docErr.message ?? "Subscription failed",
        });
      }
    }
  }

  private async setupSubscription(
    session: ConnectionSession,
    frame: Extract<ClientFrame, { type: "subscribe" }>
  ): Promise<void> {
    const projectId = session.projectId!;
    const apiKeyRecord = session.apiKeyRecord!;
    const authContext = session.authContext;
    const ruleset = await this.rulesetFor(projectId);
    const includes = frame.resolveIncludes ? (frame.include ?? frame.query?.include ?? []) : [];
    validateRealtimeIncludes(includes);

    if (frame.resumeSeqId !== undefined && frame.resumeSeqId !== null) {
      if (
        typeof frame.resumeSeqId !== "number" ||
        !Number.isSafeInteger(frame.resumeSeqId) ||
        frame.resumeSeqId < 0
      ) {
        throw new VellumError("INVALID_ARGUMENT", "resumeSeqId must be a non-negative safe integer");
      }
    }

    // Fallback watermark for adapters whose transactions cannot read the
    // outbox; the in-transaction safe watermark below replaces it whenever
    // available. In-memory adapters commit atomically, so the head is safe.
    let currentWatermark = "0";
    if (isOutboxSeqReadable(this.dataStore)) {
      currentWatermark = this.dataStore.outboxSeq.toString();
    } else {
      if (typeof this.dataStore.queryOutboxMaxSeq === "function") {
        currentWatermark = await this.dataStore.queryOutboxMaxSeq({ projectId });
      } else {
        // Adapters without a max query: the first page is ascending, so this is only a lower bound.
        const recent = await this.dataStore.queryOutboxSince({ projectId });
        const last = recent[recent.length - 1];
        if (last) currentWatermark = last.seqId;
      }
    }

    let normalizedQuery = null;
    let targetPath: string | null = null;

    if (frame.path) {
      const parsed = parseDocumentPath(frame.path);
      targetPath = parsed.path;
    } else if (frame.query) {
      const queryPayload: Record<string, unknown> = { ...frame.query };
      normalizedQuery = validateAndNormalizeQuery(queryPayload);
      authorizeOperation({
        apiKeyRecord,
        rulesetRecord: ruleset,
        operation: "list",
        path: `${normalizedQuery.collectionPath}/__ws_sub__`,
        authContext,
      });
    } else {
      throw new VellumError("INVALID_ARGUMENT", "Subscribe frame requires either 'path' or 'query'");
    }

    if (session.closed) return;

    const subRecord: SubscriptionRecord = {
      subId: frame.subId,
      includes,
      path: targetPath,
      normalizedQuery,
      matchedPaths: new Set(),
      seenSeqIds: new Set(),
    };
    session.subscriptions.set(frame.subId, subRecord);

    if (frame.resumeSeqId !== undefined && frame.resumeSeqId !== null) {
      await this.replayFromSeqId(session, subRecord, projectId, frame.resumeSeqId, ruleset);
      return;
    }

    // The subscription is already registered, so a write that commits while the initial snapshot is being
    // read would be fanned out immediately and then overwritten by the older `initial_sync` that follows.
    // Defer live events until `initial_sync` has been sent, then flush those newer than the snapshot.
    subRecord.replaying = true;
    const snapshotVersions = new Map<string, number>();
    try {
      await this.dataStore.withTransaction({ projectId }, async (tx: TxHandle) => {
      if (session.closed || session.subscriptions.get(frame.subId) !== subRecord) return;
      // P0-2: the watermark travels with the snapshot. Read inside the same
      // transaction, every row at or below the safe watermark was committed
      // before this transaction's first statement, so the documents read below
      // reflect everything the watermark claims - no wall-clock cutoff, and a
      // client resuming from it can never miss a late-committing row.
      if (typeof tx.outboxSafeWatermark === "function") {
        currentWatermark = await tx.outboxSafeWatermark();
      }
      const initialDocs: DocumentRecord[] = [];
      if (targetPath) {
        const doc = await tx.getDocument(targetPath, false);
        let snapshotLookups: RuleLookups | undefined;
        if (rulesetUsesLookups(ruleset)) {
          const found = new Map<string, Record<string, unknown> | null>();
          for (const p of collectRuleLookups({ rulesetRecord: ruleset, operation: "get", path: targetPath, authContext, resourceData: doc?.data ?? null })) {
            const ref = await tx.getDocument(p, false);
            found.set(p, ref ? (ref.data as Record<string, unknown>) : null);
          }
          snapshotLookups = found;
        }
        try {
          authorizeOperation({ apiKeyRecord, rulesetRecord: ruleset,
            operation: "get", path: targetPath, authContext, resourceData: doc?.data ?? null, lookups: snapshotLookups });
        } catch (error) {
          // Missing or TTL-expired target: same three-valued semantics as REST `doc.get()`. An authenticated
          // caller that passes the collection `list` gate, and whose `get` rule denies only because `resource`
          // is absent, gets an empty initial_sync (exists:false) instead of PERMISSION_DENIED. Everything else
          // stays denied so the subscribe cannot be used as an existence oracle.
          if (doc || !(error instanceof VellumError && error.code === "PERMISSION_DENIED") || authContext.uid === null) throw error;
          const collectionPath = targetPath.split("/").slice(0, -1).join("/");
          try {
            authorizeOperation({ apiKeyRecord, rulesetRecord: ruleset, operation: "list",
              path: `${collectionPath}/__collection_check__`, authContext, collectionLevel: true, resourceData: null });
            authorizeOperation({ apiKeyRecord, rulesetRecord: ruleset, operation: "get", path: targetPath,
              authContext, resourceData: null, optimisticResource: true, lookups: snapshotLookups });
          } catch {
            throw error;
          }
        }
        if (doc) {
          subRecord.matchedPaths.add(doc.path);
          initialDocs.push(doc);
        }
      } else if (normalizedQuery) {
        // Let the database filter, order and cap the initial page instead of reading the whole
        // collection (O(collection size) per subscribe). Rows denied by their own `get` rule are
        // dropped after the fetch, so when a window comes back short we widen it (x4 each round,
        // at most REALTIME_SUBSCRIBE_MAX_FETCH rows). If the window is still short and the database
        // had more rows, we fall back to the exact full scan, so the result never differs from it.
        // Rules that read other documents: the documents candidate rows ask for are read up front.
        const rowLookups = new Map<string, Record<string, unknown> | null>();
        const prefetchRows = async (candidates: DocumentRecord[]): Promise<void> => {
          if (!rulesetUsesLookups(ruleset)) return;
          for (const d of candidates) {
            if (!documentMatchesQuery(d, normalizedQuery)) continue;
            for (const p of collectRuleLookups({ rulesetRecord: ruleset, operation: "get", path: d.path, authContext, resourceData: d.data })) {
              if (rowLookups.has(p) || rowLookups.size >= 200) continue;
              const ref = await tx.getDocument(p, false);
              rowLookups.set(p, ref ? (ref.data as Record<string, unknown>) : null);
            }
          }
        };
        const accept = (d: DocumentRecord): boolean => {
          if (!documentMatchesQuery(d, normalizedQuery)) return false;
          try {
            authorizeOperation({ apiKeyRecord, rulesetRecord: ruleset,
              operation: "get", path: d.path, authContext, resourceData: d.data, lookups: rowLookups });
            return true;
          } catch { return false; }
        };
        const order = (a: DocumentRecord, b: DocumentRecord): number => {
          for (const o of normalizedQuery.orderBy) {
            const compared = compareWireValues(extractDocFieldValue(a, o.field), extractDocFieldValue(b, o.field), o.dir);
            if (compared !== 0) return compared;
          }
          return 0;
        };
        const want = normalizedQuery.limit;
        let docs: DocumentRecord[] | null = null;
        if (tx.queryDocuments) {
          let fetchLimit = Math.max(want * 4, want);
          for (;;) {
            fetchLimit = Math.min(fetchLimit, REALTIME_SUBSCRIBE_MAX_FETCH);
            const compiled = compileQueryToParameterizedSql({
              projectId,
              normalizedQuery: { ...normalizedQuery, limit: fetchLimit, select: null, startAfter: null, startAt: null } as typeof normalizedQuery,
              matchedCompositeIndex: null,
            });
            const rows = ((await tx.queryDocuments(compiled)) as DocumentRecord[]).slice(0, fetchLimit);
            await prefetchRows(rows);
            const accepted = rows.filter(accept).sort(order);
            if (accepted.length >= want || rows.length < fetchLimit) { docs = accepted.slice(0, want); break; }
            if (fetchLimit >= REALTIME_SUBSCRIBE_MAX_FETCH) break;
            fetchLimit *= 4;
          }
        }
        if (docs === null) {
          const all = (await tx.listActiveDocumentsInCollection?.(normalizedQuery.collectionPath)) ?? [];
          await prefetchRows(all);
          docs = all.filter(accept).sort(order).slice(0, want);
        }
        for (const doc of docs) {
          subRecord.matchedPaths.add(doc.path);
          initialDocs.push(doc);
        }
      }

      if (session.closed || session.subscriptions.get(frame.subId) !== subRecord) return;
      for (const d of initialDocs) snapshotVersions.set(d.path, d.version);
      const references = includes.length ? await fetchRealtimeReferences(projectId, initialDocs, includes, this.dataStore, tx) : new Map<string, DocumentRecord>();
      const payloads = await Promise.all(initialDocs.map(async (doc) => {
        const payload = this.toDocPayload(doc);
        const enriched = includes.length ? await enrichRealtimeDocument(payload, includes, references, apiKeyRecord, authContext, ruleset) : payload;
        return this.projectSubscriptionDocument(enriched, subRecord);
      }));
      if (session.closed || session.subscriptions.get(frame.subId) !== subRecord) return;
      session.sendFrame({
        type: "initial_sync",
        subId: frame.subId,
        seqId: Number(currentWatermark),
        documents: payloads,
      });
      });
    } catch (error) {
      subRecord.replaying = false;
      subRecord.pendingLiveEvents = [];
      if (session.subscriptions.get(frame.subId) === subRecord) session.subscriptions.delete(frame.subId);
      throw error;
    }
    // Events the snapshot already reflects (same path, version not newer) are skipped; the rest are delivered.
    await this.flushDeferredLiveEvents(session, subRecord, projectId, ruleset, snapshotVersions);
  }

  /** Stop deferring live events for a subscription and deliver the buffered ones in ascending seq order. */
  private async flushDeferredLiveEvents(
    session: ConnectionSession,
    subRecord: SubscriptionRecord,
    projectId: string,
    ruleset: SecurityRulesetRecord | null,
    snapshotVersions: Map<string, number>
  ): Promise<void> {
    // Drain until nothing new was buffered, so an event arriving mid-flush cannot be reordered or lost.
    // The deferral gate is always released, also when the flush stops early or throws.
    try {
      for (;;) {
        const deferred = subRecord.pendingLiveEvents ?? [];
        subRecord.pendingLiveEvents = [];
        if (deferred.length === 0) return;
        deferred.sort((a, b) => {
          const sa = parseSafeSeqBigInt(a.seqId) ?? 0n;
          const sb = parseSafeSeqBigInt(b.seqId) ?? 0n;
          return sa < sb ? -1 : sa > sb ? 1 : 0;
        });
        for (const ev of deferred) {
          if (session.closed || session.subscriptions.get(subRecord.subId) !== subRecord) return;
          const have = snapshotVersions.get(ev.path);
          if (have !== undefined && ev.opType !== "deleted" && ev.version <= have) {
            // Already reflected in the snapshot: remember it so a later duplicate (NOTIFY plus poll) is dropped too.
            subRecord.seenSeqIds.add(ev.seqId);
            continue;
          }
          const documents = await this.prepareIncludedEvent(projectId, ev, [{ session, subRecord }]);
          const liveRuleset = (await this.rulesetFor(projectId)) ?? ruleset;
          this.deliverEventToSubscription(session, subRecord, ev, {
            duringReplay: true,
            ruleset: liveRuleset,
            lookups: await this.lookupsFor(projectId, liveRuleset, session, ev, new Map()),
            document: documents.get(subRecord),
          });
        }
      }
    } finally {
      subRecord.replaying = false;
      subRecord.pendingLiveEvents = [];
    }
  }

  /**
   * Replay committed outbox rows after `resumeSeqId`, then send an explicit
   * `resume_complete` confirmation. The data store query is already
   * tenant-scoped; the explicit predicate below is defense in depth.
   */
  private async replayFromSeqId(
    session: ConnectionSession,
    subRecord: SubscriptionRecord,
    projectId: string,
    resumeSeqId: number,
    ruleset: SecurityRulesetRecord | null
  ): Promise<void> {
    let after = String(resumeSeqId);
    let lastSeq = BigInt(resumeSeqId);
    let delivered = 0;
    let truncated = false;

    // The subscription is already registered so no live event can be dropped;
    // the gate defers those events until the historical gap has been emitted.
    subRecord.replaying = true;

    try {
      while (delivered < MAX_REPLAY_EVENTS) {
        if (session.closed || session.subscriptions.get(subRecord.subId) !== subRecord) {
          return;
        }
        const batch = await this.dataStore.queryOutboxSince({ projectId }, after);
        if (session.closed || session.subscriptions.get(subRecord.subId) !== subRecord) {
          return;
        }
        if (batch.length === 0) break;
        for (const ev of batch) {
          if (session.closed || session.subscriptions.get(subRecord.subId) !== subRecord) {
            return;
          }
          if (ev.projectId !== projectId) continue;
          const seq = parseSafeSeqBigInt(ev.seqId);
          if (seq === null || seq <= lastSeq) continue;
          if (delivered >= MAX_REPLAY_EVENTS) {
            truncated = true;
            break;
          }
          const documents = await this.prepareIncludedEvent(projectId, ev, [{ session, subRecord }]);
          const replayRuleset = (await this.rulesetFor(projectId)) ?? ruleset;
          this.deliverEventToSubscription(session, subRecord, ev, {
            duringReplay: true,
            ruleset: replayRuleset,
            lookups: await this.lookupsFor(projectId, replayRuleset, session, ev, new Map()),
            document: documents.get(subRecord),
          });
          lastSeq = seq;
          delivered += 1;
        }
        const tail = batch[batch.length - 1];
        if (!tail) break;
        after = tail.seqId;
        if (batch.length < REPLAY_QUERY_BATCH) break;
      }
    } finally {
      subRecord.replaying = false;
    }

    if (session.closed || session.subscriptions.get(subRecord.subId) !== subRecord) {
      subRecord.pendingLiveEvents = [];
      return;
    }

    const confirmation: ResumeCompleteFrame = {
      type: "resume_complete",
      subId: subRecord.subId,
      seqId: lastSeq.toString(),
      count: delivered,
      truncated,
    };
    session.sendFrame(confirmation);

    // Replay boundary has been announced; now emit everything that went live
    // mid-walk, still in strict seq order (duplicates are dropped by seenSeqIds).
    const deferred = subRecord.pendingLiveEvents ?? [];
    subRecord.pendingLiveEvents = [];
    deferred.sort((a, b) => {
      const sa = parseSafeSeqBigInt(a.seqId) ?? 0n;
      const sb = parseSafeSeqBigInt(b.seqId) ?? 0n;
      return sa < sb ? -1 : sa > sb ? 1 : 0;
    });
    for (const ev of deferred) {
      if (session.closed || session.subscriptions.get(subRecord.subId) !== subRecord) break;
      const documents = await this.prepareIncludedEvent(projectId, ev, [{ session, subRecord }]);
      const flushRuleset = (await this.rulesetFor(projectId)) ?? ruleset;
      this.deliverEventToSubscription(session, subRecord, ev, {
        ruleset: flushRuleset,
        lookups: await this.lookupsFor(projectId, flushRuleset, session, ev, new Map()),
        document: documents.get(subRecord),
      });
    }
  }

  public async notifyCommittedEvents(projectId: string, events: OutboxEvent[]): Promise<void> {
    const previous = this.deliveryTails.get(projectId) ?? Promise.resolve();
    const current = previous.catch(() => undefined).then(() => this.notifyCommittedEventsInOrder(projectId, events));
    this.deliveryTails.set(projectId, current);
    try { await current; } finally { if (this.deliveryTails.get(projectId) === current) this.deliveryTails.delete(projectId); }
  }

  private async notifyCommittedEventsInOrder(projectId: string, events: OutboxEvent[]): Promise<void> {
    if (!projectId || !Array.isArray(events) || events.length === 0) return;
    const key = projectId;
    for (const ev of events) {
      if (!ev || ev.projectId !== projectId) continue;
      const incomingSeq = parseSafeSeqBigInt(ev.seqId);
      if (incomingSeq === null) continue;

      // seq_id is a global bigserial shared by every project, so a per-project gap is normal and is not
      // a missed event. The poller already reads each project's rows in ascending order and fills late
      // commits, so no extra catch-up query is needed here (it also replayed old history on a cold instance).
      await this.fanOutSingleEvent(projectId, ev);
      const prevSeq = this.watermarks.get(key) ?? 0n;
      if (incomingSeq > prevSeq) this.watermarks.set(key, incomingSeq);
    }
  }

  private async fanOutSingleEvent(projectId: string, ev: OutboxEvent): Promise<void> {
    const tenantSessions = this.connectionsByProject.get(projectId);
    if (!tenantSessions || tenantSessions.size === 0) return;

    const collectCandidates = (): Map<SubscriptionRecord, ConnectionSession> => {
      const out = new Map<SubscriptionRecord, ConnectionSession>();
      for (const route of [`d:${ev.path}`, `c:${ev.collectionPath}`]) {
        const bucket = this.subscriptionIndex.get(`${projectId} ${route}`);
        if (bucket) for (const [record, owner] of bucket) out.set(record, owner);
      }
      return out;
    };
    // P0-2: decide *synchronously* whether any subscription can match this
    // event (same document path, or a query on the same collection). With no
    // candidate the event costs zero awaits: no include expansion, no ruleset
    // read, no credential checks for uninvolved sessions.
    let candidates = collectCandidates();
    if (candidates.size === 0) return;

    // Only subscriptions that can match this event (same document path, or a query on the same collection).
    const recipients = [...candidates].map(([subRecord, session]) => ({ session, subRecord }));
    const documents = await this.prepareIncludedEvent(projectId, ev, recipients);
    const nowMs = Date.now();
    const ruleset = await this.rulesetFor(projectId);
    const keyMemo = new Map<string, Promise<ApiKeyRecord | null | undefined>>();
    // Re-read after the awaits above: a subscription added meanwhile must still see this event.
    candidates = collectCandidates();
    let candidatesVersion = this.subscriptionIndexVersion.n;

    // P0-2: credential expiry and end-user revocation are checked once per
    // *candidate* session (not once per connected session), with the per-key
    // lookup memoised across them, and the batch runs with bounded concurrency
    // instead of one sequential round-trip per session per event.
    const candidateSessions = [
      ...new Set(
        [...candidates.values()].filter(
          (session) => session.authenticated && !session.closed && session.projectId === projectId
        )
      ),
    ];
    const admitted = new Set<ConnectionSession>();
    await runBounded(candidateSessions, FANOUT_SESSION_CONCURRENCY, async (session) => {
      const expiryErr = await this.checkSessionCredentialExpiry(session, nowMs, keyMemo);
      // A session revoked after connect (sign-out, disabled user) must stop receiving data, not only stop sending.
      const revokedErr = expiryErr ?? (await this.checkSessionStillActive(session));
      if (revokedErr) {
        session.sendFrame({ type: "error", code: revokedErr.code, message: revokedErr.message });
        this.closeSession(session);
        return;
      }
      admitted.add(session);
    });

    const lookupCache = new Map<string, Record<string, unknown> | null>();
    // P0-2: bounded concurrency across sessions; each session's own
    // subscriptions are still visited in order and events reach the hub in
    // ascending seq order, so per-subscription delivery order is preserved.
    await runBounded(candidateSessions, FANOUT_SESSION_CONCURRENCY, async (session) => {
      if (!admitted.has(session) || session.closed) return;
      if (candidatesVersion !== this.subscriptionIndexVersion.n) {
        candidates = collectCandidates();
        candidatesVersion = this.subscriptionIndexVersion.n;
      }
      for (const subRecord of [...session.subscriptions.values()]) {
        if (session.closed) break;
        if (!candidates.has(subRecord)) continue;
        this.deliverEventToSubscription(session, subRecord, ev, {
          ruleset,
          lookups: await this.lookupsFor(projectId, ruleset, session, ev, lookupCache),
          document: documents.get(subRecord),
        });
      }
    });
  }

  private eventPayload(ev: OutboxEvent): ReturnType<RealtimeGatewayHub["toDocPayload"]> {
    const committedAt = typeof ev.committedAt === "string" ? ev.committedAt : (ev.committedAt as Date).toISOString();
    return { path: ev.path, collectionPath: ev.collectionPath,
      collectionGroup: ev.collectionPath.split("/").pop() ?? ev.collectionPath, documentId: ev.documentId,
      data: structuredClone(ev.afterData ?? ev.beforeData ?? {}), version: ev.version,
      createdAt: committedAt, updatedAt: committedAt };
  }

  private async prepareIncludedEvent(projectId: string, ev: OutboxEvent,
    recipients: Array<{ session: ConnectionSession; subRecord: SubscriptionRecord }>
  ): Promise<Map<SubscriptionRecord, ReturnType<RealtimeGatewayHub["toDocPayload"]>>> {
    const result = new Map<SubscriptionRecord, ReturnType<RealtimeGatewayHub["toDocPayload"]>>();
    const parent = this.eventPayload(ev);
    const pseudo = { ...parent, projectId, pathDepth: ev.path.split("/").length, sizeBytes: 0, deletedAt: null };
    const interested = recipients.filter(({ session, subRecord }) => !session.closed && !this.checkLocalCredentialExpiry(session, Date.now())
      && subRecord.includes?.length && !subRecord.seenSeqIds.has(ev.seqId)
      && (subRecord.path === ev.path || (subRecord.normalizedQuery?.collectionPath === ev.collectionPath
        && documentMatchesQuery(pseudo, subRecord.normalizedQuery))));
    if (!interested.length || ev.opType === "deleted") return result;
    try {
      const specs = interested.flatMap(({ subRecord }) => subRecord.includes ?? []);
      const references = await fetchRealtimeReferences(projectId, [parent], specs, this.dataStore);
      for (const { session, subRecord } of interested) {
        if (session.closed || session.subscriptions.get(subRecord.subId) !== subRecord || !session.apiKeyRecord) continue;
        result.set(subRecord, await enrichRealtimeDocument(parent, subRecord.includes!, references,
          session.apiKeyRecord, session.authContext, (await this.rulesetFor(projectId))));
      }
    } catch (error) {
      for (const { session, subRecord } of interested) {
        session.sendFrame({ type: "error", subId: subRecord.subId, code: error instanceof VellumError ? error.code : "INTERNAL_ERROR", message: "Realtime include expansion failed; resubscribe without includes or narrow the reference fields" });
        // Never silently substitute an unresolved successful mutation.
        session.subscriptions.delete(subRecord.subId);
      }

    }
    return result;
  }

  /**
   * Documents that `get()` / `exists()` in the rules ask for on this event, read once per delivery round
   * through `cache`. Rulesets without lookups skip this entirely.
   */
  private async lookupsFor(
    projectId: string,
    ruleset: SecurityRulesetRecord | null,
    session: ConnectionSession,
    ev: OutboxEvent,
    cache: Map<string, Record<string, unknown> | null>
  ): Promise<RuleLookups | undefined> {
    if (!rulesetUsesLookups(ruleset)) return undefined;
    const paths = new Set<string>();
    for (const resource of [ev.afterData ?? null, ev.beforeData ?? null]) {
      for (const p of collectRuleLookups({
        rulesetRecord: ruleset,
        operation: "get",
        path: ev.path,
        authContext: session.authContext,
        resourceData: (resource as Record<string, unknown> | null) ?? null,
      })) {
        paths.add(p);
      }
    }
    const out = new Map<string, Record<string, unknown> | null>();
    for (const path of paths) {
      let data = cache.get(path);
      if (data === undefined) {
        const doc = await this.dataStore.getDocument({ projectId }, path);
        data = doc ? (doc.data as Record<string, unknown>) : null;
        cache.set(path, data);
      }
      out.set(path, data);
    }
    return out;
  }

  private isAuthorizedForLiveEvent(
    session: ConnectionSession,
    ev: OutboxEvent,
    ruleset: SecurityRulesetRecord | null,
    resource: Record<string, unknown> | null = ev.afterData ?? ev.beforeData ?? null,
    lookups?: RuleLookups
  ): boolean {
    if (!session.apiKeyRecord) return false;
    try {
      authorizeOperation({
        apiKeyRecord: session.apiKeyRecord,
        rulesetRecord: ruleset,
        operation: "get",
        path: ev.path,
        authContext: session.authContext,
        resourceData: resource,
        lookups,
      });
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Durable metering must never delay or break realtime delivery. Delivery
   * order is preserved by sendFrame above; a failed increment is dropped
   * rather than buffered (PostgreSQL is the only state store).
   */
  private recordUsage(projectId: string): void {
    void Promise.resolve(
      this.controlStore.incrementUsage(projectId, { realtimeMessagesSent: 1 })
    ).catch(() => undefined);
  }

  private deliverEventToSubscription(
    session: ConnectionSession,
    subRecord: SubscriptionRecord,
    ev: OutboxEvent,
    options?: { duringReplay?: boolean | undefined; ruleset?: SecurityRulesetRecord | null | undefined; lookups?: RuleLookups | undefined; document?: ReturnType<RealtimeGatewayHub["toDocPayload"]> | undefined }
  ): void {
    if (session.closed || session.subscriptions.get(subRecord.subId) !== subRecord) return;

    // Exactly-once at the subscription boundary: NOTIFY and the plain poll loop
    // can both surface the same outbox row, and replay can overlap live events.
    if (subRecord.seenSeqIds.has(ev.seqId)) return;

    // While a `resumeSeqId` replay is in progress, live fan-out must not overtake
    // the older replayed rows: buffer it and flush in ascending seq order once the
    // historical walk finishes. Dedupe happens at flush time.
    if (subRecord.replaying === true && options?.duringReplay !== true) {
      const pending = (subRecord.pendingLiveEvents ??= []);
      if (pending.length >= MAX_PENDING_LIVE_EVENTS) {
        session.sendFrame({
          type: "error",
          subId: subRecord.subId,
          code: "SLOW_CONSUMER_DISCONNECT",
          message: `Pending live event buffer exceeded maximum ${MAX_PENDING_LIVE_EVENTS} events during replay`,
        });
        this.closeSession(session);
        return;
      }
      pending.push(ev);
      return;
    }

    // Re-check active security ruleset if present so ruleset revocations apply immediately.
    const activeRuleset = options?.ruleset ?? this.controlStore.getActiveRuleset(session.projectId!) ?? null;
    if (!this.isAuthorizedForLiveEvent(session, ev, activeRuleset, undefined, options?.lookups)) {
      // The new state is no longer readable by this subscriber (for example they were removed from
      // the document's member list). If the document was in their live result and they could read the
      // previous state, tell them it left the result instead of leaving a stale row on screen.
      if (
        subRecord.normalizedQuery &&
        ev.collectionPath === subRecord.normalizedQuery.collectionPath &&
        subRecord.matchedPaths.has(ev.path) &&
        ev.beforeData &&
        this.isAuthorizedForLiveEvent(session, ev, activeRuleset, ev.beforeData as Record<string, unknown>, options?.lookups)
      ) {
        subRecord.seenSeqIds.add(ev.seqId);
        subRecord.matchedPaths.delete(ev.path);
        const at = typeof ev.committedAt === "string" ? ev.committedAt : (ev.committedAt as Date).toISOString();
        session.sendFrame({
          type: "mutation",
          subId: subRecord.subId,
          seqId: Number(ev.seqId),
          operation: "delete",
          document: this.projectSubscriptionDocument(options?.document ?? {
            path: ev.path,
            collectionPath: ev.collectionPath,
            collectionGroup: ev.collectionPath.split("/").pop() ?? ev.collectionPath,
            documentId: ev.documentId,
            data: structuredClone(ev.beforeData as Record<string, unknown>),
            version: ev.version,
            createdAt: at,
            updatedAt: at,
          }, subRecord),
        });
        if (!session.closed) this.recordUsage(session.projectId!);
      }
      return;
    }

    subRecord.seenSeqIds.add(ev.seqId);
    if (subRecord.seenSeqIds.size > MAX_SEEN_SEQ_IDS) {
      pruneOldestHalf(subRecord.seenSeqIds, MAX_SEEN_SEQ_IDS);
    }

    const committedAtIso =
      typeof ev.committedAt === "string" ? ev.committedAt : (ev.committedAt as Date).toISOString();
    const seqNum = Number(ev.seqId);

    if (subRecord.path) {
      if (ev.path !== subRecord.path) return;
      const operation =
        ev.opType === "deleted" ? "delete" : ev.opType === "created" ? "create" : "update";
      session.sendFrame({
        type: "mutation",
        subId: subRecord.subId,
        seqId: seqNum,
        operation,
        document: this.projectSubscriptionDocument(options?.document ?? {
          path: ev.path,
          collectionPath: ev.collectionPath,
          collectionGroup: ev.collectionPath.split("/").pop() ?? ev.collectionPath,
          documentId: ev.documentId,
          data: structuredClone((ev.afterData ?? ev.beforeData ?? {}) as Record<string, unknown>),
          version: ev.version,
          createdAt: committedAtIso,
          updatedAt: committedAtIso,
        }, subRecord),
      });
      if (!session.closed) {
        this.recordUsage(session.projectId!);
      }
      return;
    }

    if (subRecord.normalizedQuery) {
      if (ev.collectionPath !== subRecord.normalizedQuery.collectionPath) return;
      const pseudoAfterDoc: DocumentRecord | null =
        ev.opType === "deleted"
          ? null
          : {
              projectId: session.projectId!,
              path: ev.path,
              collectionPath: ev.collectionPath,
              collectionGroup: ev.collectionPath.split("/").pop() ?? ev.collectionPath,
              documentId: ev.documentId,
              pathDepth: ev.path.split("/").length,
              data: ev.afterData ?? {},
              sizeBytes: 0,
              version: ev.version,
              createdAt: committedAtIso,
              updatedAt: committedAtIso,
              deletedAt: null,
            };

      const matchesNow = pseudoAfterDoc ? documentMatchesQuery(pseudoAfterDoc, subRecord.normalizedQuery) : false;
      const matchedBefore = subRecord.matchedPaths.has(ev.path);

      if (matchesNow && !matchedBefore) {
        if (subRecord.matchedPaths.size >= MAX_MATCHED_PATHS_PER_SUB) {
          pruneOldestHalf(subRecord.matchedPaths, MAX_MATCHED_PATHS_PER_SUB);
        }
        subRecord.matchedPaths.add(ev.path);
        session.sendFrame({
          type: "mutation",
          subId: subRecord.subId,
          seqId: seqNum,
          operation: "create",
          document: this.projectSubscriptionDocument(options?.document ?? this.toDocPayload(pseudoAfterDoc!), subRecord),
        });
        if (!session.closed) {
          this.recordUsage(session.projectId!);
        }
      } else if (matchesNow && matchedBefore) {
        session.sendFrame({
          type: "mutation",
          subId: subRecord.subId,
          seqId: seqNum,
          operation: "update",
          document: this.projectSubscriptionDocument(options?.document ?? this.toDocPayload(pseudoAfterDoc!), subRecord),
        });
        if (!session.closed) {
          this.recordUsage(session.projectId!);
        }
      } else if (!matchesNow && matchedBefore) {
        subRecord.matchedPaths.delete(ev.path);
        session.sendFrame({
          type: "mutation",
          subId: subRecord.subId,
          seqId: seqNum,
          operation: "delete",
          document: this.projectSubscriptionDocument(options?.document ?? {
            path: ev.path,
            collectionPath: ev.collectionPath,
            collectionGroup: ev.collectionPath.split("/").pop() ?? ev.collectionPath,
            documentId: ev.documentId,
            data: structuredClone((ev.beforeData ?? {}) as Record<string, unknown>),
            version: ev.version,
            createdAt: committedAtIso,
            updatedAt: committedAtIso,
          }, subRecord),
        });
        if (!session.closed) {
          this.recordUsage(session.projectId!);
        }
      }
    }
  }

  private projectSubscriptionDocument<T extends { data: Record<string, unknown> }>(document: T, sub: SubscriptionRecord): T {
    const selected = sub.normalizedQuery?.select;
    return selected?.length ? { ...document, data: projectDocumentFields(document.data, selected) } : document;
  }

  private toDocPayload(doc: DocumentRecord): {
    path: string;
    collectionPath: string;
    collectionGroup: string;
    documentId: string;
    data: Record<string, unknown>;
    version: number;
    createdAt: string;
    updatedAt: string;
  } {
    return {
      path: doc.path,
      collectionPath: doc.collectionPath,
      collectionGroup: doc.collectionGroup,
      documentId: doc.documentId,
      data: structuredClone(doc.data),
      version: doc.version,
      createdAt: typeof doc.createdAt === "string" ? doc.createdAt : (doc.createdAt as Date).toISOString(),
      updatedAt: typeof doc.updatedAt === "string" ? doc.updatedAt : (doc.updatedAt as Date).toISOString(),
    };
  }
}
