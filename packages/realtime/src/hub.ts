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
} from "@vellum/authorization";
import { validateAndNormalizeQuery, documentMatchesQuery, extractDocFieldValue } from "@vellum/query-engine";
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

  constructor(options: RealtimeHubOptions) {
    this.apiKeyPepper = options.apiKeyPepper;
    this.controlStore = options.controlStore;
    this.dataStore = options.dataStore;
    this.jwtSecret = options.jwtSecret ?? "vellum_jwt_secret_v1";
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
        pending = this.lookupKeyByPrefix(apiKey0.keyPrefix);
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
    return {
      uid: payload.sub,
      claims: payload.claims ?? {},
      email: payload.email ?? null,
      email_verified: payload.email_verified === true,
      is_anonymous: payload.is_anonymous === true,
      token: { ...payload },
    };
  }

  public createConnectionSession(
    sendFrameCallback: (frame: ServerFrame) => void
  ): ConnectionSessionHandle {
    const connectionId = `conn_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`;
    const session: ConnectionSession = {
      connectionId,
      authenticated: false,
      projectId: null,
      apiKeyRecord: null,
      authContext: { uid: null, claims: {} },
      subscriptions: new Map(),
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

    const expiryErr = await this.checkSessionCredentialExpiry(session);
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

    let currentWatermark = "0";
    if (isOutboxSeqReadable(this.dataStore)) {
      currentWatermark = this.dataStore.outboxSeq.toString();
    } else {
      const recent = await this.dataStore.queryOutboxSince({ projectId });
      const last = recent[recent.length - 1];
      if (last) currentWatermark = last.seqId;
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

    try {
      await this.dataStore.withTransaction({ projectId }, async (tx: TxHandle) => {
      if (session.closed || session.subscriptions.get(frame.subId) !== subRecord) return;
      const initialDocs: DocumentRecord[] = [];
      if (targetPath) {
        const doc = await tx.getDocument(targetPath, false);
        authorizeOperation({ apiKeyRecord, rulesetRecord: ruleset,
          operation: "get", path: targetPath, authContext, resourceData: doc?.data ?? null });
        if (doc) {
          subRecord.matchedPaths.add(doc.path);
          initialDocs.push(doc);
        }
      } else if (normalizedQuery) {
        const activeDocs = (await tx.listActiveDocumentsInCollection?.(normalizedQuery.collectionPath)) ?? [];
        const docs = activeDocs
          .filter((d: DocumentRecord) => {
            if (!documentMatchesQuery(d, normalizedQuery)) return false;
            try {
              authorizeOperation({ apiKeyRecord, rulesetRecord: ruleset,
                operation: "get", path: d.path, authContext, resourceData: d.data });
              return true;
            } catch { return false; }
          })
          .sort((a, b) => {
            for (const order of normalizedQuery.orderBy) {
              const compared = compareWireValues(extractDocFieldValue(a, order.field), extractDocFieldValue(b, order.field), order.dir);
              if (compared !== 0) return compared;
            }
            return 0;
          })
          .slice(0, normalizedQuery.limit);
        for (const doc of docs) {
          subRecord.matchedPaths.add(doc.path);
          initialDocs.push(doc);
        }
      }

      if (session.closed || session.subscriptions.get(frame.subId) !== subRecord) return;
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
      if (session.subscriptions.get(frame.subId) === subRecord) session.subscriptions.delete(frame.subId);
      throw error;
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
          this.deliverEventToSubscription(session, subRecord, ev, { duringReplay: true, ruleset: (await this.rulesetFor(projectId)) ?? ruleset, document: documents.get(subRecord) });
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
      this.deliverEventToSubscription(session, subRecord, ev, { ruleset: (await this.rulesetFor(projectId)) ?? ruleset, document: documents.get(subRecord) });
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

      const prevSeq = this.watermarks.get(key) ?? 0n;

      if (incomingSeq > prevSeq + 1n) {
        const catchup = await this.dataStore.queryOutboxSince(
          { projectId },
          prevSeq.toString()
        );
        let foundIncoming = false;
        for (const missed of catchup) {
          if (!missed || missed.projectId !== projectId) continue;
          const missedSeq = parseSafeSeqBigInt(missed.seqId);
          if (missedSeq === null) continue;
          await this.fanOutSingleEvent(projectId, missed);
          const curWm = this.watermarks.get(key) ?? 0n;
          if (missedSeq > curWm) {
            this.watermarks.set(key, missedSeq);
          }
          if (missed.seqId === ev.seqId) {
            foundIncoming = true;
          }
        }
        if (!foundIncoming) {
          await this.fanOutSingleEvent(projectId, ev);
          const curWm = this.watermarks.get(key) ?? 0n;
          if (incomingSeq > curWm) {
            this.watermarks.set(key, incomingSeq);
          }
        }
      } else {
        await this.fanOutSingleEvent(projectId, ev);
        if (incomingSeq > prevSeq) {
          this.watermarks.set(key, incomingSeq);
        }
      }
    }
  }

  private async fanOutSingleEvent(projectId: string, ev: OutboxEvent): Promise<void> {
    const tenantSessions = this.connectionsByProject.get(projectId);
    if (!tenantSessions || tenantSessions.size === 0) return;

    const recipients = [...tenantSessions].flatMap((session) => [...session.subscriptions.values()].map((subRecord) => ({ session, subRecord })));
    const documents = await this.prepareIncludedEvent(projectId, ev, recipients);
    const nowMs = Date.now();
    const ruleset = await this.rulesetFor(projectId);
    const keyMemo = new Map<string, Promise<ApiKeyRecord | null | undefined>>();

    for (const session of [...tenantSessions]) {
      if (!session.authenticated || session.closed || session.projectId !== projectId) {
        continue;
      }
      const expiryErr = await this.checkSessionCredentialExpiry(session, nowMs, keyMemo);
      if (expiryErr) {
        session.sendFrame({
          type: "error",
          code: expiryErr.code,
          message: expiryErr.message,
        });
        this.closeSession(session);
        continue;
      }
      for (const subRecord of [...session.subscriptions.values()]) {
        if (session.closed) break;
        this.deliverEventToSubscription(session, subRecord, ev, { ruleset, document: documents.get(subRecord) });
      }
    }
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

  private isAuthorizedForLiveEvent(
    session: ConnectionSession,
    ev: OutboxEvent,
    ruleset: SecurityRulesetRecord | null
  ): boolean {
    if (!session.apiKeyRecord) return false;
    try {
      authorizeOperation({
        apiKeyRecord: session.apiKeyRecord,
        rulesetRecord: ruleset,
        operation: "get",
        path: ev.path,
        authContext: session.authContext,
        resourceData: ev.afterData ?? ev.beforeData ?? null,
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
    options?: { duringReplay?: boolean | undefined; ruleset?: SecurityRulesetRecord | null | undefined; document?: ReturnType<RealtimeGatewayHub["toDocPayload"]> | undefined }
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
    if (!this.isAuthorizedForLiveEvent(session, ev, options?.ruleset ?? this.controlStore.getActiveRuleset(session.projectId!) ?? null)) {
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
