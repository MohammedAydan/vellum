/**
 * @vellum/document-engine - Core Document Engine
 * Orchestrates CRUD, Batch Writes, Field Transforms, Queries, and OCC Transactions.
 */

import { formatPublicDocument } from "./document-format.js";
import { evaluateRelationRulesForDelete, groupRelationRulesByCollection } from "./relation-integrity.js";
import { scanReferencedBy, type ReferencedByRequest, type ReferencedByResult } from "./referenced-by.js";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import {
  VellumError,
  SYSTEM_LIMITS,
  parseDocumentPath,
  parseCollectionPath,
  normalizeAndValidateDocumentData,
  getFieldByPath,
  validateCollectionName,
} from "@vellum/core";
import {
  authorizeOperation,
  hasRowLevelGetRule,
  type ApiKeyRecord,
  type SecurityRulesetRecord,
  type AuthContext,
} from "@vellum/authorization";
import {
  validateAndNormalizeQuery,
  extractDocFieldValue,
  computeQueryShapeHash,
  encodeQueryCursor,
  decodeAndVerifyQueryCursor,
  selectCompositeIndexForQuery,
  compileQueryToParameterizedSql,
  compileDeleteSelectQuery,
  type QuerySpec,
  type CompositeIndexMetadata,
  type CursorPayload,
  type CursorMode,
  type WhereClause,
} from "@vellum/query-engine";
import type {
  CollectionConfig,
  CollectionRecord,
  CollectionWithStats,
  CompositeIndexRecord,
  CreateCollectionInput,
  DocumentRecord,
  ListCollectionsOptions,
  QueriedDocument,
  StorageAdapter,
  TxHandle as StorageTxHandle,
  UpdateCollectionInput,
} from "@vellum/storage";
import { applyFieldTransforms } from "./transforms.js";
import { parseFieldPath, setPath, toIsoDate } from "./path-utils.js";
import { resolveTelemetry } from "./telemetry.js";
import { createCircuitBreaker, type CircuitBreaker } from "./circuit-breaker.js";
import {
  createBatchedRelationResolver,
  projectIncludedDoc,
  resolveIncludes,
  type IncludeSpec,
  type RelationDocument,
} from "./relations.js";
import { createTransactionManager, type TransactionManager } from "./transactions.js";
import type { DocumentEnginePort } from "./contracts/engine-port.js";
import type {
  AggregateRequest,
  AggregateResult,
  AuditLike,
  BatchMutation,
  BatchWriteResult,
  ControlStoreLike,
  DeleteResult,
  DocumentEngineOptions,
  EngineContext,
  InternalEngineContext,
  ExportedCollectionDocument,
  ExportCollectionDocumentsOptions,
  ExportCollectionDocumentsResult,
  ImportCollectionDocumentsOptions,
  ImportCollectionDocumentsResult,
  MeteringLike,
  MutationResult,
  PublicDocument,
  QueryResult,
  RateLimiterLike,
  RelationRule,
  RealtimeHubLike,
  TelemetryLike,
  TransactionBeginResult,
} from "./types.js";

/** Parsed document path — mirrors `@vellum/core`'s `DocumentPathResult`. */
type ParsedPath = ReturnType<typeof parseDocumentPath>;

/**
 * `importCollectionDocuments` accepts one extra optional knob beyond the shared
 * `ImportCollectionDocumentsOptions`: a bounded document cap. Declared locally
 * so the cross-package `types.ts` contract stays untouched.
 */
type ImportOptionsWithLimit = ImportCollectionDocumentsOptions & {
  limit?: number | undefined;
};

/**
 * Import writes are chunked to stay within the locked 5 MiB batch payload and
 * MAX_BATCH_OPERATIONS ceilings (500 is the requested upper bound; the engine
 * quota is stricter, so the smaller of the two always wins).
 */
const IMPORT_BATCH_SIZE = Math.min(500, SYSTEM_LIMITS.MAX_BATCH_OPERATIONS);

/** Upper bound for the internal-caller synthetic key cache (oldest evicted first). */
const INTERNAL_API_KEY_CACHE_MAX = 1000;
/** Synthetic keys are scoped to the two document permissions — never `*` or index management. */
const INTERNAL_API_KEY_SCOPES = ["documents:read", "documents:write"];
/** Bounded, insertion-ordered cache: `Map.keys().next()` is always the oldest entry. */
const internalApiKeyCache = new Map<string, ApiKeyRecord>();

/** One-way digest used in error details so raw expiry strings are never echoed. */
function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

/** Narrows the discriminated mutation union to a document result (fails closed). */
function assertPublicDocument(result: MutationResult | undefined): PublicDocument {
  if (!result || result.status !== "ok") {
    throw new VellumError("INTERNAL_ERROR", "Engine mutation did not return a document result");
  }
  return result;
}

/** Narrows the discriminated mutation union to a delete result (fails closed). */
function assertDeleteResult(result: MutationResult | undefined): DeleteResult {
  if (!result || result.status !== "deleted") {
    throw new VellumError("INTERNAL_ERROR", "Engine mutation did not return a delete result");
  }
  return result;
}

/** Page size for cursor-only collection export (one extra lookahead row stays ≤500). */
const EXPORT_PAGE_SIZE = Math.max(1, SYSTEM_LIMITS.MAX_QUERY_LIMIT - 1);

/** Comparator for deterministic `path ASC` ordering. */
function compareByPath(a: { path: string }, b: { path: string }): number {
  return a.path < b.path ? -1 : a.path > b.path ? 1 : 0;
}

/** TxHandle extended with batch upsert / batch get (SQL adapters only). */
interface BatchTxHandle extends StorageTxHandle {
  putDocumentRows?(rows: DocumentRecord[]): Promise<void>;
  /**
   * Single-roundtrip batch getter (Phase 1A). When absent (in-memory/test
   * doubles) the engine falls back to `Promise.all(tx.getDocument(...))`
   * wrapped in one logical batch operation.
   */
  batchGetDocuments?(paths: string[], includeDeleted?: boolean): Promise<DocumentRecord[]>;
}

/**
 * `BatchTxHandle` extended with the optional batch-idempotency ledger hooks.
 * Declared locally so storage types stay untouched; `unknown[]` rest signatures
 * stay compatible with the `TxCapability` shape used by the storage adapters.
 */
interface IdempotentTxHandle extends BatchTxHandle {
  getIdempotencyResult?: (
    ...args: unknown[]
  ) => Promise<{ responseHash: string; responsePayload: unknown } | null>;
  saveIdempotencyResult?: (...args: unknown[]) => Promise<void>;
}

/** Minimal shape used by relation resolution (avoids coupling to storage rows). */
type RelationReadDoc = RelationDocument;

/** Narrows storage composite-index records to query-planner metadata (excludes deleting indexes). */
function isQueryableCompositeIndex(
  index: CompositeIndexRecord
): index is CompositeIndexRecord & CompositeIndexMetadata {
  return index.status === "ready" || index.status === "building" || index.status === "failed";
}

/** Sets a (possibly dotted) field path on a plain object using hardened setPath. */
function setFieldByPath(data: Record<string, unknown>, fieldPath: string, value: unknown): void {
  setPath(data, fieldPath, value);
}

/**
 * Re-export the single hardened `setPath` implementation from `path-utils`.
 * Kept here for backward compatibility with callers importing from `engine.js`;
 * both barrel star-exports resolve to this same symbol, so there is no duplicate
 * declaration and no prototype-pollution gap.
 */
export { setPath };

/**
 * Rebuilds nested JSON from either a flat dot-path projection map (as emitted
 * by the SQL compiler's `projectedData`) or from raw nested document data.
 *
 * `select: ['title', 'author.name', 'stats.views']` therefore yields
 * `{ title, author: { name }, stats: { views } }` — never flat `"author.name"`
 * keys.
 */
export { projectDocumentFields } from "./document-format.js";

/** Validates an EngineContext TTL/expiry configuration at the outer boundary. */
function resolveContextExpiry(
  ctx: { ttlSeconds?: number | undefined; expiresAt?: string | null | undefined },
  existingExpiresAt: string | null | undefined,
  nowMs: number
): string | null {
  if (ctx.expiresAt !== undefined && ctx.expiresAt !== null) {
    if (typeof ctx.expiresAt !== "string" || !Number.isFinite(Date.parse(ctx.expiresAt))) {
      throw new VellumError("INVALID_ARGUMENT", "expiresAt must be a valid ISO date string", {
        expiresAtHash: sha256Hex(String(ctx.expiresAt)).slice(0, 12),
      });
    }
    // A past expiry is a no-op write at best and a silent data-retention bug at
    // worst. Reject it at the boundary; never echo the raw value in the error.
    if (Date.parse(ctx.expiresAt) <= nowMs) {
      throw new VellumError("INVALID_ARGUMENT", "expiresAt must be in the future", {
        expiresAtHash: sha256Hex(ctx.expiresAt).slice(0, 12),
      });
    }
    return ctx.expiresAt;
  }
  if (ctx.ttlSeconds !== undefined) {
    const ttl = ctx.ttlSeconds;
    if (typeof ttl !== "number" || !Number.isFinite(ttl) || ttl <= 0 || ttl > 2 ** 31) {
      throw new VellumError(
        "INVALID_ARGUMENT",
        `ttlSeconds must be a positive finite number <= 2^31, got ${String(ttl)}`,
        { ttlSeconds: typeof ttl === "number" ? ttl : null }
      );
    }
    return new Date(nowMs + ttl * 1000).toISOString();
  }
  return existingExpiresAt ?? null;
}

/** Converts a cached collection's default TTL into an absolute expiry string. */
function defaultTtlExpiry(config: CollectionConfig | null, nowMs: number): string | null {
  const ttl = config?.defaultTtlSeconds;
  if (typeof ttl !== "number" || !Number.isFinite(ttl) || ttl <= 0 || ttl > 2 ** 31) {
    return null;
  }
  return new Date(nowMs + ttl * 1000).toISOString();
}

/** Bounded server-side retries for contended blind (precondition-free) writes. */
const BLIND_WRITE_MAX_ATTEMPTS = 25;

/** Upper bound on extra query batches read to fill a page when some rows are hidden by `get` rules. */
const MAX_ROW_FILTER_SCANS = 5;

export class DocumentEngine implements DocumentEnginePort {
  public readonly controlStore: ControlStoreLike;
  public readonly dataStore: StorageAdapter;
  public readonly realtimeHub: RealtimeHubLike | null;
  public readonly cursorSecret: string;
  private readonly referencedByCursorSecret: string;
  public readonly txSecret: string;
  /** Previous signing secret accepted during key rotation (token verification only). */
  public readonly txSecretPrev?: string;
  public readonly transactions: TransactionManager;
  /** Zero-dependency telemetry; always defined (no-op when no sink is supplied). */
  public readonly telemetry: TelemetryLike;
  /** Optional rate-limit probe; absent means unlimited. */
  public readonly rateLimiter?: RateLimiterLike;
  /** Optional metering sink — wired by Phase 2B; never throws into requests. */
  public readonly metering?: MeteringLike;
  /** Optional audit sink — wired by Phase 2B; never throws into requests. */
  public readonly audit?: AuditLike;

  /** Best-effort sinks are always wrapped so the helpers below are always callable. */
  private readonly realtimeBreaker: CircuitBreaker<[string, unknown[]]>;
  private readonly meteringBreaker: CircuitBreaker<[string, string, number, number]>;
  private readonly auditBreaker: CircuitBreaker<[string, Parameters<AuditLike["log"]>[1]]>;

  constructor(options: DocumentEngineOptions) {
    this.controlStore = options.controlStore;
    this.dataStore = options.dataStore;
    this.realtimeHub = options.realtimeHub ?? null;
    this.cursorSecret = options.cursorSecret ?? "vellum_cursor_secret_v1";
    // The legacy query-cursor default is public. Never use it for ciphertext
    // that can contain an unreadable path. Embedded callers get an ephemeral
    // per-engine key; production's configured secret remains multi-instance.
    this.referencedByCursorSecret = options.cursorSecret && options.cursorSecret !== "vellum_cursor_secret_v1"
      ? options.cursorSecret : randomBytes(32).toString("base64url");
    this.txSecret = options.txSecret ?? "vellum_tx_secret_v1";
    if (options.txSecretPrev !== undefined) this.txSecretPrev = options.txSecretPrev;
    if (options.rateLimiter !== undefined) this.rateLimiter = options.rateLimiter;
    this.telemetry = resolveTelemetry(options.telemetry);
    this.transactions = createTransactionManager({
      dataStore: this.dataStore,
      txSecret: this.txSecret,
      txSecretPrev: options.txSecretPrev,
    });
    if (options.metering) this.metering = options.metering;
    if (options.audit) this.audit = options.audit;

    const realtimeHub = this.realtimeHub;
    this.realtimeBreaker = createCircuitBreaker<[string, unknown[]]>(
      realtimeHub
        ? (projectId, events) => realtimeHub.notifyCommittedEvents(projectId, events)
        : () => undefined
    );
    const metering = this.metering;
    this.meteringBreaker = createCircuitBreaker<[string, string, number, number]>(
      metering
        ? (orgId, projectId, count, storageDeltaBytes) =>
            metering.recordDeletes(orgId, projectId, count, storageDeltaBytes)
        : () => undefined
    );
    const audit = this.audit;
    this.auditBreaker = createCircuitBreaker<[string, Parameters<AuditLike["log"]>[1]]>(
      audit ? (action, input) => audit.log(action, input) : () => undefined
    );
  }

  /**
   * Loads the active ruleset. Stores that can read PostgreSQL directly expose
   * `getActiveRulesetAsync`; it is preferred so a ruleset change or rollback
   * takes effect on the very next request on every instance.
   */
  private async loadRuleset(projectId: string): Promise<SecurityRulesetRecord | null> {
    const store = this.controlStore as ControlStoreLike & {
      getActiveRulesetAsync?: (id: string) => Promise<unknown>;
    };
    const record = store.getActiveRulesetAsync
      ? await store.getActiveRulesetAsync(projectId)
      : store.getActiveRuleset(projectId);
    return (record as SecurityRulesetRecord | null) ?? null;
  }

  /** Resolves the owning org id for metering/audit without ever throwing. */
  private resolveOrgId(ctx: EngineContext): string {
    if (typeof ctx.orgId === "string" && ctx.orgId.length > 0) return ctx.orgId;
    // `getProject` is not part of ControlStoreLike today; guard structurally so
    // a future platform implementation can supply it without a hard coupling.
    const withProject = this.controlStore as ControlStoreLike & {
      getProject?: (projectId: string) => { organizationId?: string | null; orgId?: string | null } | null;
    };
    if (typeof withProject.getProject === "function") {
      try {
        const project = withProject.getProject(ctx.projectId);
        const id = project ? (project.organizationId ?? project.orgId) : null;
        if (typeof id === "string" && id.length > 0) return id;
      } catch {
        // Hooks must never block the request path.
      }
    }
    return "";
  }

  /**
   * Tenant context for OCC token binding. The caller's key id (when present) is
   * threaded into `begin`/`recordRead`/`verifyAndLock`/`rollback` so a token
   * minted with a binding verifies closed at every call site.
   */
  private txTenant(ctx: EngineContext): {
    projectId: string;
    apiKeyId?: string;
  } {
    const apiKeyId =
      typeof ctx.apiKeyRecord === "object" && ctx.apiKeyRecord !== null
        ? (ctx.apiKeyRecord as { id?: string }).id
        : undefined;
    if (apiKeyId === undefined) {
      return { projectId: ctx.projectId };
    }
    return { projectId: ctx.projectId, apiKeyId };
  }

  /** Fail-closed rate-limit probe; a denial surfaces as canonical `RATE_LIMITED`. */
  private async enforceRateLimit(ctx: EngineContext): Promise<void> {
    const allowed = await this.rateLimiter?.check(ctx.rateLimitKey ?? ctx.projectId);
    if (allowed === false) {
      throw new VellumError("RATE_LIMITED", "Rate limit exceeded");
    }
  }

  /** Fire-and-forget realtime notification through the circuit breaker. */
  private safeRealtime(projectId: string, events: unknown[]): void {
    this.realtimeBreaker.call(projectId, events);
  }

  /** Fire-and-forget metering; the breaker swallows sync and async sink failures. */
  private safeMetering(
    orgId: string,
    projectId: string,
    count: number,
    storageDeltaBytes: number
  ): void {
    this.meteringBreaker.call(orgId, projectId, count, storageDeltaBytes);
  }

  /**
   * Durable metering must never break a committed document operation: a failed
   * increment is counted in telemetry, not thrown back at the caller.
   */
  private async recordUsage(
    projectId: string,
    usage: {
      documentReads?: number;
      documentWrites?: number;
      documentDeletes?: number;
      storageBytesDelta?: number;
      egressBytes?: number;
    }
  ): Promise<void> {
    try {
      await this.controlStore.incrementUsage(projectId, usage);
    } catch {
      this.telemetry.counter("usage.increment_failed", 1);
    }
  }

  /** Fire-and-forget audit; the breaker swallows sync and async sink failures. */
  private safeAudit(action: string, input: Parameters<AuditLike["log"]>[1]): void {
    this.auditBreaker.call(action, input);
  }

  private formatPublicDoc(row: DocumentRecord, selectedFields?: string[] | null): PublicDocument {
    return formatPublicDocument(row, selectedFields);
  }

  /**
   * Single gate for the internal-only rule bypass. `bypassRules` is absent from
   * the public {@link EngineContext}, so the only way it can reach here is via
   * an explicit `internal: true` marker from a trusted system component. A
   * bypass flag without that marker is always a privilege-escalation attempt.
   */
  /**
   * True when the caller may `get` this stored document. Bulk reads (queries, export) use it so a
   * collection-level `list` allow never hands out rows whose own `get` rule would deny the caller.
   * Server keys and system callers pass; only a rule denial hides the row.
   */
  private canReadRow(
    apiKey: ApiKeyRecord | null,
    ruleset: SecurityRulesetRecord | null,
    authCtx: AuthContext,
    bypassRules: boolean,
    row: DocumentRecord
  ): boolean {
    try {
      authorizeOperation({
        apiKeyRecord: apiKey,
        rulesetRecord: ruleset,
        operation: "get",
        path: row.path,
        authContext: authCtx,
        resourceData: row.data,
        bypassRules,
      });
      return true;
    } catch (error) {
      if (error instanceof VellumError && error.code === "PERMISSION_DENIED") {
        // No per-document get rule for this path: `list` was the only gate and it already passed.
        return !hasRowLevelGetRule(ruleset, row.path);
      }
      throw error;
    }
  }

  private resolveBypassRules(ctx: EngineContext): boolean {
    const internal = ctx as InternalEngineContext;
    if (internal.bypassRules !== true) return false;
    if (internal.internal !== true) {
      throw new VellumError(
        "PERMISSION_DENIED",
        "System rule bypass is restricted to internal callers"
      );
    }
    return true;
  }

  /** Recursive include-shape validation; every level is capped at 10 entries. */
  private validateIncludes(includes: unknown, depth: number): void {
    if (depth > 10) {
      throw new VellumError("INVALID_ARGUMENT", "include nesting is too deep", { depth });
    }
    if (!Array.isArray(includes)) {
      throw new VellumError("INVALID_ARGUMENT", "include must be an array", { depth });
    }
    if (includes.length > 10) {
      throw new VellumError("INVALID_ARGUMENT", "include may contain at most 10 entries", {
        count: includes.length,
        depth,
      });
    }
    for (const entry of includes) {
      if (
        entry === null ||
        typeof entry !== "object" ||
        typeof (entry as { field?: unknown }).field !== "string" ||
        (entry as { field: string }).field.trim() === ""
      ) {
        throw new VellumError(
          "INVALID_ARGUMENT",
          "Each include requires a non-empty string 'field'",
          { depth }
        );
      }
      const nested = (entry as { include?: unknown }).include;
      if (nested !== undefined && nested !== null) {
        this.validateIncludes(nested, depth + 1);
      }
    }
  }

  /** Validates TTL/expiry shape without ever echoing a raw expiry value. */
  private validateContextExpiry(ctx: EngineContext): void {
    if (ctx.ttlSeconds !== undefined) {
      const ttl = ctx.ttlSeconds;
      if (typeof ttl !== "number" || !Number.isFinite(ttl) || ttl <= 0 || ttl > 2 ** 31) {
        throw new VellumError(
          "INVALID_ARGUMENT",
          `ttlSeconds must be a positive finite number <= 2^31, got ${String(ttl)}`,
          { ttlSeconds: typeof ttl === "number" ? ttl : null }
        );
      }
    }
    if (ctx.expiresAt !== undefined && ctx.expiresAt !== null) {
      const raw = ctx.expiresAt;
      if (typeof raw !== "string" || !Number.isFinite(Date.parse(raw))) {
        throw new VellumError("INVALID_ARGUMENT", "expiresAt must be a valid ISO date string", {
          expiresAtHash: sha256Hex(String(raw)).slice(0, 12),
        });
      }
      if (Date.parse(raw) <= Date.now()) {
        throw new VellumError("INVALID_ARGUMENT", "expiresAt must be in the future", {
          expiresAtHash: sha256Hex(raw).slice(0, 12),
        });
      }
    }
  }

  /** Centralized boundary validation for every public engine entry point. */
  private validateEngineContext(ctx: EngineContext): void {
    if (typeof ctx.projectId !== "string" || ctx.projectId.trim() === "") {
      throw new VellumError("INVALID_ARGUMENT", "projectId is required");
    }
    if (Array.isArray(ctx.select) && ctx.select.length > 100) {
      throw new VellumError("INVALID_ARGUMENT", "select may contain at most 100 fields", {
        count: ctx.select.length,
        maxFields: 100,
      });
    }
    if (ctx.idempotencyKey !== undefined) {
      if (
        typeof ctx.idempotencyKey !== "string" ||
        ctx.idempotencyKey.length === 0 ||
        ctx.idempotencyKey.length > 256 ||
        ctx.idempotencyKey.includes("\u0000")
      ) {
        throw new VellumError(
          "INVALID_ARGUMENT",
          "idempotencyKey must be a non-empty string of at most 256 characters without NUL bytes"
        );
      }
    }
    if (ctx.relationRules !== undefined) {
      if (!Array.isArray(ctx.relationRules) || ctx.relationRules.length > 50) {
        throw new VellumError(
          "INVALID_ARGUMENT",
          "relationRules must be an array of at most 50 rules"
        );
      }
      for (const rule of ctx.relationRules) {
        if (
          !rule ||
          typeof rule !== "object" ||
          typeof rule.collection !== "string" ||
          rule.collection.trim() === "" ||
          typeof rule.field !== "string" ||
          rule.field.trim() === "" ||
          (rule.onDelete !== "cascade" && rule.onDelete !== "set_null" && rule.onDelete !== "restrict") ||
          (rule.targetCollection !== undefined &&
            (typeof rule.targetCollection !== "string" || rule.targetCollection.trim() === ""))
        ) {
          throw new VellumError(
            "INVALID_ARGUMENT",
            "Each relationRule requires non-empty 'collection', 'field', and valid 'onDelete'"
          );
        }
      }
    }
    if (ctx.include !== undefined) {
      this.validateIncludes(ctx.include, 0);
    }
    this.validateContextExpiry(ctx);
  }

  /**
   * Resolves the relation rules for an operation: an explicit
   * `ctx.relationRules` (trusted server code, tests) always wins; otherwise the
   * rules are read from the control-plane store (`getRelationRules`), which is
   * where the `/v1/projects/:id/relation-rules` management plane persists them.
   */
  private async getProjectRelationRules(ctx: EngineContext): Promise<readonly RelationRule[]> {
    if (ctx.relationRules !== undefined) return ctx.relationRules;
    const store = this.controlStore as ControlStoreLike & {
      getRelationRules?: (projectId: string) => readonly RelationRule[] | null;
      getRelationRulesAsync?: (projectId: string) => Promise<readonly RelationRule[]>;
    };
    const rules = store.getRelationRulesAsync
      ? await store.getRelationRulesAsync(ctx.projectId)
      : store.getRelationRules?.(ctx.projectId);
    if (!Array.isArray(rules)) return [];
    // The control plane persists an omitted targetCollection as SQL NULL. A null
    // must mean "unscoped" (fires for any target collection), exactly like
    // undefined, or the rule silently never fires.
    return rules.map((rule) =>
      (rule as { targetCollection?: string | null }).targetCollection === null
        ? ({ ...rule, targetCollection: undefined } as RelationRule)
        : rule
    );
  }

  private resolveApiKey(ctx: EngineContext): ApiKeyRecord {
    // Fail closed even when a caller supplied a key: this also rejects a
    // `bypassRules` flag smuggled in by a non-internal caller.
    this.resolveBypassRules(ctx);
    if (ctx.apiKeyRecord) {
      return ctx.apiKeyRecord as ApiKeyRecord;
    }
    const internal = ctx as InternalEngineContext;
    if (internal.internal !== true) {
      throw new VellumError("UNAUTHENTICATED", "API key record is required");
    }
    const cacheKey = ctx.projectId;
    const cached = internalApiKeyCache.get(cacheKey);
    if (cached) return cached;
    const synthetic: ApiKeyRecord = {
      id: "internal_system_key",
      projectId: ctx.projectId,
      name: "internal_system",
      keyType: "server",
      keyPrefix: "sk_internal",
      secretHash: "internal",
      scopes: [...INTERNAL_API_KEY_SCOPES],
      rateLimitRps: 10000,
      lastUsedAt: null,
      expiresAt: null,
      revokedAt: null,
      createdBy: null,
      createdAt: new Date().toISOString(),
    };
    if (internalApiKeyCache.size >= INTERNAL_API_KEY_CACHE_MAX) {
      const oldest = internalApiKeyCache.keys().next();
      if (!oldest.done) internalApiKeyCache.delete(oldest.value);
    }
    internalApiKeyCache.set(cacheKey, synthetic);
    return synthetic;
  }

  private resolveAuthContext(ctx: EngineContext): AuthContext {
    return (ctx.authContext as AuthContext) ?? { uid: null, claims: {} };
  }

  /**
   * Builds the security + batched-read closures used by relation resolution.
   * `canRead` fails closed: any authorization error (including PERMISSION_DENIED)
   * becomes `false` so an unauthorized relation target is redacted, never
   * leaked and never thrown into the public request path.
   */
  private createRelationReader(
    apiKey: ApiKeyRecord,
    ruleset: SecurityRulesetRecord | null,
    authCtx: AuthContext,
    bypassRules: boolean,
    tx: StorageTxHandle
  ): {
    canRead: (doc: RelationReadDoc) => boolean;
    getDocumentBatch: (paths: string[]) => Promise<DocumentRecord[]>;
    selectProjector: (doc: RelationReadDoc, select: string[] | null) => RelationReadDoc;
  } {
    const batchTx = tx as BatchTxHandle;
    const getDocumentBatch = async (paths: string[]): Promise<DocumentRecord[]> => {
      if (paths.length === 0) return [];
      if (typeof batchTx.batchGetDocuments === "function") {
        return batchTx.batchGetDocuments(paths);
      }
      // Single logical batch for adapters/test doubles without the batch API.
      const rows = await Promise.all(paths.map((p) => tx.getDocument(p)));
      return rows.filter((row): row is DocumentRecord => row !== null);
    };
    const canRead = (doc: RelationReadDoc): boolean => {
      try {
        authorizeOperation({
          apiKeyRecord: apiKey,
          rulesetRecord: ruleset,
          operation: "get",
          path: doc.path,
          authContext: authCtx,
          resourceData: doc.data,
          bypassRules,
        });
        return true;
      } catch {
        return false;
      }
    };
    return { canRead, getDocumentBatch, selectProjector: projectIncludedDoc };
  }

  /**
   * Applies include specs to a page of docs inside the current tenant
   * transaction and copies `_included` / `_redactedRefs` onto the public docs.
   */
  private async applyIncludes(
    docs: PublicDocument[],
    includes: IncludeSpec[],
    apiKey: ApiKeyRecord,
    ruleset: SecurityRulesetRecord | null,
    authCtx: AuthContext,
    bypassRules: boolean,
    tx: StorageTxHandle
  ): Promise<void> {
    return this.telemetry.span("engine.applyIncludes", () =>
      this.applyIncludesImpl(docs, includes, apiKey, ruleset, authCtx, bypassRules, tx)
    );
  }

  private async applyIncludesImpl(
    docs: PublicDocument[],
    includes: IncludeSpec[],
    apiKey: ApiKeyRecord,
    ruleset: SecurityRulesetRecord | null,
    authCtx: AuthContext,
    bypassRules: boolean,
    tx: StorageTxHandle
  ): Promise<void> {
    if (docs.length === 0 || includes.length === 0) return;
    const reader = this.createRelationReader(apiKey, ruleset, authCtx, bypassRules, tx);
    const resolver = createBatchedRelationResolver<RelationReadDoc>({
      getDocumentBatch: reader.getDocumentBatch,
    });
    const result = await resolveIncludes<RelationReadDoc>({
      docs,
      includes,
      getDocument: resolver.getDocument,
      getDocumentBatch: resolver.getDocumentBatch,
      canRead: reader.canRead,
      selectProjector: reader.selectProjector,
    });
    this.telemetry.histogram("include.targets", result.includedTargets);
    this.telemetry.counter("db.round_trips", result.batchCallCount);
    this.telemetry.histogram("db.round_trips", result.batchCallCount);
    result.docs.forEach((enriched, i) => {
      const publicDoc = docs[i];
      if (!publicDoc) return;
      if (enriched._included) publicDoc._included = enriched._included;
      if (enriched._redactedRefs && enriched._redactedRefs.length > 0) {
        publicDoc._redactedRefs = enriched._redactedRefs;
      }
      if (enriched._redactedRefPaths && enriched._redactedRefPaths.length > 0) {
        publicDoc._redactedRefPaths = enriched._redactedRefPaths;
      }
    });
  }

  public async getDocument(
    ctx: EngineContext & { path: string; include?: IncludeSpec[] | undefined }
  ): Promise<PublicDocument> {
    this.validateEngineContext(ctx);
    await this.enforceRateLimit(ctx);
    const parsed = parseDocumentPath(ctx.path);
    const ruleset = await this.loadRuleset(ctx.projectId);
    const apiKey = this.resolveApiKey(ctx);
    const authCtx = this.resolveAuthContext(ctx);

    return this.dataStore.withTransaction(
      { projectId: ctx.projectId },
      async (tx) => {
        const existing = await tx.getDocument(parsed.path, false);
        this.telemetry.counter("db.round_trips", 1);
        this.telemetry.histogram("db.round_trips", 1);

        authorizeOperation({
          apiKeyRecord: apiKey,
          rulesetRecord: ruleset,
          operation: "get",
          path: parsed.path,
          authContext: authCtx,
          resourceData: existing ? existing.data : null,
          bypassRules: this.resolveBypassRules(ctx),
        });

        if (ctx.transactionToken) {
          // Persist the observed version into the PG-backed read_set inside the
          // same tenant transaction as the read itself.
          await this.transactions.recordRead(
            tx,
            ctx.transactionToken,
            this.txTenant(ctx),
            parsed.path,
            existing ? existing.version : 0
          );
        }

        if (!existing) {
          throw new VellumError("NOT_FOUND", `Document '${parsed.path}' not found`, { path: parsed.path });
        }

        const publicDoc = this.formatPublicDoc(existing, ctx.select);
        const includes = ctx.include;
        if (Array.isArray(includes) && includes.length > 0) {
          await this.applyIncludes(
            [publicDoc],
            includes,
            apiKey,
            ruleset,
            authCtx,
            this.resolveBypassRules(ctx),
            tx
          );
        }

        const includedBytes = publicDoc._included
          ? Buffer.byteLength(JSON.stringify(publicDoc._included), "utf8")
          : 0;
        await this.recordUsage(ctx.projectId, {
          documentReads: 1,
          egressBytes: existing.sizeBytes + includedBytes,
        });

        return publicDoc;
      }
    );
  }

  /** Public reverse lookup. Never return the internal integrity lookup directly. */
  public async referencedBy(ctx: EngineContext & { request: ReferencedByRequest }): Promise<ReferencedByResult> {
    this.validateEngineContext(ctx);
    await this.enforceRateLimit(ctx);
    const { request } = ctx;
    const target = parseDocumentPath(request.targetPath).path;
    if (request.collection !== undefined) parseCollectionPath(request.collection);
    if (request.field !== undefined) parseFieldPath(request.field);
    if (ctx.transactionToken) throw new VellumError("INVALID_ARGUMENT", "referencedBy does not accept transaction tokens");
    const apiKey = this.resolveApiKey(ctx);
    const authCtx = this.resolveAuthContext(ctx);
    const ruleset = await this.loadRuleset(ctx.projectId);
    const bypassRules = this.resolveBypassRules(ctx);
    const scope = JSON.stringify([ctx.projectId, apiKey.id, authCtx.uid, target, request.collection ?? null, request.field ?? null]);
    return this.dataStore.withTransaction(this.tenantOf(ctx), async (tx) => {
      const targetDoc = await tx.getDocument(target);
      authorizeOperation({ apiKeyRecord: apiKey, rulesetRecord: ruleset, operation: "get", path: target,
        authContext: authCtx, resourceData: targetDoc?.data ?? null, bypassRules });
      if (!targetDoc) throw new VellumError("NOT_FOUND", "Referenced document not found");
      const reader = this.createRelationReader(apiKey, ruleset, authCtx, bypassRules, tx);
      const result = await scanReferencedBy({ request: { ...request, targetPath: target }, tx, scope,
        secret: this.referencedByCursorSecret,
        canRead: (row) => {
          if (!reader.canRead(row)) return false;
          try {
            authorizeOperation({ apiKeyRecord: apiKey, rulesetRecord: ruleset, operation: "list", path: row.path,
              authContext: authCtx, resourceData: row.data, bypassRules });
            return true;
          } catch { return false; }
        },
        format: (row) => this.formatPublicDoc(row, ctx.select),
      });
      if (ctx.include?.length) await this.applyIncludes(result.documents, ctx.include, apiKey, ruleset, authCtx, bypassRules, tx);
      const bytes = Buffer.byteLength(JSON.stringify(result.documents), "utf8");
      if (bytes > SYSTEM_LIMITS.MAX_QUERY_RESPONSE_BYTES) throw new VellumError("RESPONSE_TOO_LARGE", "referencedBy response exceeds 4 MiB");
      await this.recordUsage(ctx.projectId, { documentReads: result.scanned + 1, egressBytes: bytes });
      return { documents: result.documents, nextCursor: result.nextCursor };
    });
  }

  public async createDocument(
    ctx: EngineContext & { path: string; data: Record<string, unknown> }
  ): Promise<PublicDocument> {
    const result = await this.batchWrite({
      ...ctx,
      writes: [{ type: "create", path: ctx.path, data: ctx.data }],
    });
    return assertPublicDocument(result.results[0]);
  }

  public async setDocument(
    ctx: EngineContext & {
      path: string;
      data: Record<string, unknown>;
      merge?: boolean | undefined;
      ifVersion?: number | null | undefined;
    }
  ): Promise<PublicDocument> {
    const result = await this.batchWrite({
      ...ctx,
      writes: [
        {
          type: "set",
          path: ctx.path,
          data: ctx.data,
          merge: ctx.merge,
          ifVersion: ctx.ifVersion,
        },
      ],
    });
    return assertPublicDocument(result.results[0]);
  }

  public async updateDocument(
    ctx: EngineContext & {
      path: string;
      data: Record<string, unknown>;
      ifVersion?: number | null | undefined;
    }
  ): Promise<PublicDocument> {
    const result = await this.batchWrite({
      ...ctx,
      writes: [
        {
          type: "update",
          path: ctx.path,
          data: ctx.data,
          ifVersion: ctx.ifVersion,
        },
      ],
    });
    return assertPublicDocument(result.results[0]);
  }

  public async deleteDocument(
    ctx: EngineContext & {
      path: string;
      ifVersion?: number | null | undefined;
    }
  ): Promise<{ path: string; status: "deleted"; version: number; updatedAt: string }> {
    const result = await this.batchWrite({
      ...ctx,
      writes: [
        {
          type: "delete",
          path: ctx.path,
          ifVersion: ctx.ifVersion,
        },
      ],
    });
    return assertDeleteResult(result.results[0]);
  }

  /**
   * Shared referential-integrity evaluator for `batchWrite` and `deleteWhere`.
   *
   * For every (dependent collection, rule) pair it uses the index-backed
   * `listDependentsByReference` capability — one parameterized statement rather
   * than a full collection scan. Rows staged earlier in the same transaction are
   * merged in so `create A -> B` followed by `delete B` is still detected, and a
   * pending row always overrides its stale DB counterpart. Candidates are visited
   * in `path ASC` order; `restrict` / `set_null` / `cascade` semantics are
   * unchanged. The caller builds the rule-grouping map ONCE per operation.
   *
   * @returns the number of rows newly staged by this evaluation (cascade width).
   */

  public async batchWrite(
    ctx: EngineContext & { writes: BatchMutation[] }
  ): Promise<BatchWriteResult> {
    this.validateEngineContext(ctx);
    await this.enforceRateLimit(ctx);
    // Blind writes (no ifVersion / exists precondition, no OCC token) carry no
    // caller-visible baseline, so losing a compare-and-swap race to another
    // writer is not a conflict the caller can act on. Retry the whole (fully
    // rolled back) batch against the new state, bounded, so contended atomic
    // field ops such as `increment` serialize instead of surfacing 409.
    const blind =
      !(typeof ctx.transactionToken === "string" && ctx.transactionToken.length > 0) &&
      ctx.writes.every(
        (w) => (w.ifVersion === undefined || w.ifVersion === null) && typeof w.exists !== "boolean"
      );
    const maxAttempts = blind ? BLIND_WRITE_MAX_ATTEMPTS : 1;
    return this.telemetry.span("engine.batchWrite", async () => {
      for (let attempt = 1; ; attempt += 1) {
        try {
          return await this.batchWriteImpl(ctx);
        } catch (error) {
          const conflict = error instanceof VellumError && error.code === "ABORTED_CONFLICT";
          if (!conflict || attempt >= maxAttempts) throw error;
          this.telemetry.counter("batch.blind_write_retries", 1);
          await new Promise((resolve) => setTimeout(resolve, Math.floor(Math.random() * 10 * attempt) + 1));
        }
      }
    });
  }

  private async batchWriteImpl(
    ctx: EngineContext & { writes: BatchMutation[] }
  ): Promise<BatchWriteResult> {
    const writes = ctx.writes;
    if (!Array.isArray(writes) || writes.length === 0) {
      throw new VellumError("INVALID_ARGUMENT", "batchWrite requires a non-empty 'writes' array");
    }
    if (writes.length > SYSTEM_LIMITS.MAX_BATCH_OPERATIONS) {
      throw new VellumError(
        "BATCH_SIZE_EXCEEDED",
        `Batch size (${writes.length}) exceeds maximum limit of ${SYSTEM_LIMITS.MAX_BATCH_OPERATIONS} operations`,
        { count: writes.length, maxOperations: SYSTEM_LIMITS.MAX_BATCH_OPERATIONS }
      );
    }
    this.telemetry.histogram("batch.size", writes.length);
    // `upsert: true` routes a `create` mutation through the `set` path, which
    // already upserts (INSERT … ON CONFLICT DO UPDATE) instead of raising
    // ALREADY_EXISTS when the document is present.
    const effectiveWrites: BatchMutation[] = ctx.upsert === true
      ? writes.map((w) => (w.type === "create" ? { ...w, type: "set" as const, merge: false } : w))
      : writes;

    // Incremental accounting over the EFFECTIVE writes avoids a second whole
    // array stringify: JSON.stringify([a,b,c]) == 2 brackets + (n-1) commas +
    // the per-element serializations.
    let totalBatchBytes = 2; // "[" + "]"
    for (let i = 0; i < effectiveWrites.length; i += 1) {
      if (i > 0) totalBatchBytes += 1; // ","
      let serialized: string;
      try {
        serialized = JSON.stringify(effectiveWrites[i]);
      } catch {
        throw new VellumError("INVALID_ARGUMENT", "Batch mutation payload is not valid JSON", {
          index: i,
        });
      }
      if (typeof serialized !== "string") {
        throw new VellumError("INVALID_ARGUMENT", "Batch mutation payload is not valid JSON", {
          index: i,
        });
      }
      totalBatchBytes += Buffer.byteLength(serialized, "utf8");
    }
    if (totalBatchBytes > SYSTEM_LIMITS.MAX_BATCH_PAYLOAD_BYTES) {
      throw new VellumError(
        "PAYLOAD_TOO_LARGE",
        `Batch payload size (${totalBatchBytes} bytes) exceeds 5 MiB limit`,
        { sizeBytes: totalBatchBytes }
      );
    }

    const ruleset = await this.loadRuleset(ctx.projectId);
    const apiKey = this.resolveApiKey(ctx);
    const authCtx = this.resolveAuthContext(ctx);
    const txNowMs = Date.now();
    const txNowIso = new Date(txNowMs).toISOString();
    const committedOutboxEvents: unknown[] = [];
    let batchWasReplayed = false;
    let finalUserWrites = 0;
    let finalUserDeletes = 0;
    let finalCascadeWrites = 0;
    let finalCascadeDeletes = 0;
    let finalStorageBytesDelta = 0;
    let finalMaxCascadeDepth = 0;
    let finalMaxCascadeWidth = 0;

    const batchOutcome = await this.dataStore.withTransaction(
      { projectId: ctx.projectId },
      async (rawTx) => {
        const tx = rawTx as BatchTxHandle;

        // Idempotent replay: a cached successful response short-circuits BEFORE
        // any collection registration, mutation or outbox append. Returning from
        // inside `withTransaction` leaves the transaction with no writes.
        const idempotentTx = tx as IdempotentTxHandle;
        if (ctx.idempotencyKey) {
          const cached = await idempotentTx.getIdempotencyResult?.(ctx.idempotencyKey);
          if (cached) {
            batchWasReplayed = true;
            return JSON.parse(cached.responsePayload as string) as BatchWriteResult;
          }
        }

        const tenant = { projectId: ctx.projectId };

        // Native OCC: lock the transaction row + every read-set document in
        // path ASC order and compare observed versions BEFORE prefetching
        // baseline rows, so a concurrent commit cannot race ahead of our
        // prefetch under READ COMMITTED.
        const verified = ctx.transactionToken
          ? await this.transactions.verifyAndLock(ctx.transactionToken, this.txTenant(ctx), tx)
          : null;

        // Parse every unique mutation path ONCE. `parseDocumentPath` already
        // returns a validated canonical collectionPath, so the former
        // `parseCollectionPath(parseDocumentPath(w.path).collectionPath)` double
        // parse is redundant and removed.
        const parsedByPath = new Map<string, ParsedPath>();
        for (const w of effectiveWrites) {
          if (!parsedByPath.has(w.path)) parsedByPath.set(w.path, parseDocumentPath(w.path));
        }
        const uniquePaths = Array.from(parsedByPath.keys());
        const collectionNames = Array.from(
          new Set(Array.from(parsedByPath.values(), (p) => p.collectionPath))
        ).sort();

        // ONE round trip for every touched path, tombstones included. The
        // fallback keeps adapters/test doubles without the batch API on the
        // same logical single-batch code path.
        const existingByPath = new Map<string, DocumentRecord>();
        if (uniquePaths.length > 0) {
          let fetched: DocumentRecord[];
          if (typeof tx.batchGetDocuments === "function") {
            fetched = await tx.batchGetDocuments(uniquePaths, true);
          } else {
            fetched = (
              await Promise.all(uniquePaths.map((p) => tx.getDocument(p, true, true)))
            ).filter((row): row is DocumentRecord => row !== null);
          }
          for (const row of fetched) existingByPath.set(row.path, row);
        }
        this.telemetry.counter("db.round_trips", 1);
        this.telemetry.histogram("db.round_trips", 1);

        // Collection lifecycle: every write path (create/set/update/delete and
        // OCC commit via `batchWrite`) registers its collection INSIDE the same
        // tenant transaction. `ensureCollectionExists` is O(1) after the first
        // call thanks to the adapter's `knownCollections` cache, so this adds
        // no SQL on the hot path.
        for (const name of collectionNames) {
          await this.dataStore.ensureCollectionExists(tenant, name);
        }

        // Cached per-collection config (getCollectionConfig is itself cached by
        // the adapter). A null config keeps the hot path free of extra work.
        const configByName = new Map<string, CollectionConfig | null>();
        if (typeof this.dataStore.getCollectionConfig === "function") {
          for (const name of collectionNames) {
            configByName.set(name, await this.dataStore.getCollectionConfig(tenant, name));
          }
        }

        const results: MutationResult[] = [];
        // User-originated work is metered separately from cascade side effects.
        let userWrites = 0;
        let userDeletes = 0;
        let cascadeWrites = 0;
        let cascadeDeletes = 0;
        let storageBytesDelta = 0;

        // stage derived document rows and flush them with one
        // UNNEST upsert per batch. The overlay preserves read-your-writes for
        // mutations that touch the same path twice in a single batch.
        const pendingRows = new Map<string, DocumentRecord>();
        const readExisting = async (
          path: string
        ): Promise<{ active: DocumentRecord | null; anyRow: DocumentRecord | null }> => {
          // Read-your-writes first, then the single prefetched batch map. There
          // is deliberately NO per-mutation SQL on this path.
          const pending = pendingRows.get(path);
          if (pending) {
            return {
              active: pending.deletedAt === null ? pending : null,
              anyRow: pending,
            };
          }
          const anyRow = existingByPath.get(path) ?? null;
          return { active: anyRow && anyRow.deletedAt === null ? anyRow : null, anyRow };
        };

        // CAS intent for NON-OCC create/update mutations that consumed a
        // DB-baseline version from the prefetch. OCC (`transactionToken`) writes
        // stay on the full `verifyAndLock` conditional path and never appear
        // here; precondition writes keep their explicit checks and additionally
        // carry the same baseline into the CAS. Re-staging a path
        // (read-your-writes or a cascade side effect) drops its CAS entry so a
        // stale baseline is never used against row content changed in-batch.
        const casByPath = new Map<string, { expectedVersion: number | null }>();

        // Referential integrity (V2 1C): rules are grouped ONCE, then the shared
        // evaluator uses index-backed dependent lookups inside THIS tenant
        // transaction. Derived rows are staged in `pendingRows` so they commit
        // atomically with the original mutation. Deterministic: paths ASC.
        const rulesByCollection = groupRelationRulesByCollection(await this.getProjectRelationRules(ctx));
        const cascadeQueue: Array<{ path: string; depth: number }> = [];
        const visitedCascadePaths = new Set<string>();
        let maxCascadeDepth = 0;
        let maxCascadeWidth = 0;

        const stageSetNull = async (row: DocumentRecord, field: string): Promise<void> => {
          const nextData = structuredClone(row.data);
          setFieldByPath(nextData, field, null);
          const { data: validated, sizeBytes } = normalizeAndValidateDocumentData(nextData, false);
          const nextRow: DocumentRecord = {
            ...row,
            data: validated,
            sizeBytes,
            version: row.version + 1,
            updatedAt: txNowIso,
            deletedAt: null,
          };
          pendingRows.set(nextRow.path, nextRow);
          casByPath.delete(nextRow.path);
          const ev = await tx.appendOutboxEvent({
            collectionPath: nextRow.collectionPath,
            path: nextRow.path,
            documentId: nextRow.documentId,
            opType: "updated",
            version: nextRow.version,
            beforeData: row.data,
            afterData: validated,
          });
          committedOutboxEvents.push(ev);
          cascadeWrites += 1;
          storageBytesDelta += sizeBytes - row.sizeBytes;
        };

        const stageCascadeDelete = async (row: DocumentRecord, depth: number): Promise<void> => {
          const nextVersion = row.version + 1;
          const tombstone: DocumentRecord = {
            ...row,
            version: nextVersion,
            updatedAt: txNowIso,
            deletedAt: txNowIso,
          };
          pendingRows.set(tombstone.path, tombstone);
          casByPath.delete(tombstone.path);
          const ev = await tx.appendOutboxEvent({
            collectionPath: row.collectionPath,
            path: row.path,
            documentId: row.documentId,
            opType: "deleted",
            version: nextVersion,
            beforeData: row.data,
            afterData: null,
          });
          committedOutboxEvents.push(ev);
          cascadeDeletes += 1;
          storageBytesDelta -= row.sizeBytes;
          cascadeQueue.push({ path: row.path, depth: depth + 1 });
        };

        const applyRelationRulesForDelete = async (deletedPath: string, depth: number): Promise<void> => {
          if (rulesByCollection.size === 0) return;
          if (visitedCascadePaths.has(deletedPath)) return;
          visitedCascadePaths.add(deletedPath);
          if (depth > maxCascadeDepth) maxCascadeDepth = depth;
          const width = await evaluateRelationRulesForDelete({
            deletedPath,
            depth,
            rulesByCollection,
            tenant,
            parsedByPath,
            pendingRows,
            tx,
            stageSetNull,
            stageCascadeDelete,
          });
          if (width > maxCascadeWidth) maxCascadeWidth = width;
        };

        for (const mutation of effectiveWrites) {
          // Parsed once during the prefetch phase; no re-parse per mutation.
          const parsed = parsedByPath.get(mutation.path)!;
          const { active: existingActive, anyRow: existingAny } = await readExisting(parsed.path);

          if (mutation.ifVersion !== undefined && mutation.ifVersion !== null) {
            const currentVer = existingActive ? existingActive.version : 0;
            if (currentVer !== mutation.ifVersion) {
              throw new VellumError(
                "FAILED_PRECONDITION",
                `Version precondition failed on '${parsed.path}' (expected ${mutation.ifVersion}, actual ${currentVer})`,
                { path: parsed.path, expectedVersion: mutation.ifVersion, actualVersion: currentVer }
              );
            }
          }
          if (typeof mutation.exists === "boolean") {
            const isPresent = Boolean(existingActive);
            if (mutation.exists !== isPresent) {
              throw new VellumError(
                "FAILED_PRECONDITION",
                `Existence precondition (exists=${mutation.exists}) failed on '${parsed.path}'`,
                { path: parsed.path }
              );
            }
          }

          if (mutation.type === "delete") {
            if (!existingActive) {
              throw new VellumError("NOT_FOUND", `Cannot delete non-existent document '${parsed.path}'`, {
                path: parsed.path,
              });
            }

            authorizeOperation({
              apiKeyRecord: apiKey,
              rulesetRecord: ruleset,
              operation: "delete",
              path: parsed.path,
              authContext: authCtx,
              resourceData: existingActive.data,
              requestData: null,
              bypassRules: this.resolveBypassRules(ctx),
            });

            // Before the parent disappears, enforce configured relation rules.
            await applyRelationRulesForDelete(parsed.path, 1);

            const nextVersion = (existingAny ? existingAny.version : 0) + 1;
            const tombstoneRow: DocumentRecord = {
              ...existingActive,
              version: nextVersion,
              updatedAt: txNowIso,
              deletedAt: txNowIso,
            };
            pendingRows.set(tombstoneRow.path, tombstoneRow);
            casByPath.delete(tombstoneRow.path);

            const ev = await tx.appendOutboxEvent({
              collectionPath: parsed.collectionPath,
              path: parsed.path,
              documentId: parsed.documentId,
              opType: "deleted",
              version: nextVersion,
              beforeData: existingActive.data,
              afterData: null,
            });
            committedOutboxEvents.push(ev);

            userDeletes += 1;
            storageBytesDelta -= existingActive.sizeBytes;
            results.push({ path: parsed.path, status: "deleted", version: nextVersion, updatedAt: txNowIso });
            continue;
          }

          // The final `normalizeAndValidateDocumentData(nextData, false)` below
          // validates the transformed payload, so the former pre-parse of raw
          // `mutation.data` with allowFieldOps=true was a redundant second pass.
          const inputData = mutation.data;

          let nextData: Record<string, unknown>;
          let opKind: "create" | "update";
          if (mutation.type === "create") {
            if (existingActive) {
              throw new VellumError("ALREADY_EXISTS", `Document '${parsed.path}' already exists`, {
                path: parsed.path,
              });
            }
            nextData = applyFieldTransforms({}, inputData, txNowIso);
            opKind = "create";
          } else if (mutation.type === "set") {
            if (mutation.merge && existingActive) {
              nextData = applyFieldTransforms(existingActive.data, inputData, txNowIso);
              opKind = "update";
            } else {
              nextData = applyFieldTransforms({}, inputData, txNowIso);
              opKind = existingActive ? "update" : "create";
            }
          } else if (mutation.type === "update") {
            if (!existingActive) {
              throw new VellumError("NOT_FOUND", `Cannot update non-existent document '${parsed.path}'`, {
                path: parsed.path,
              });
            }
            nextData = applyFieldTransforms(existingActive.data, inputData, txNowIso);
            opKind = "update";
          } else {
            throw new VellumError("INVALID_ARGUMENT", `Unsupported mutation type '${(mutation as { type: string }).type}'`);
          }

          const { data: validatedData, sizeBytes } = normalizeAndValidateDocumentData(nextData, false);

          // Collection schema: required fields are checked against the data
          // that will actually be persisted (after transforms/merges).
          const collectionConfig = configByName.get(parsed.collectionPath) ?? null;
          const requiredFields = collectionConfig?.schemaValidation?.requiredFields;
          if (Array.isArray(requiredFields) && requiredFields.length > 0) {
            const missing = requiredFields.filter(
              (field) => getFieldByPath(validatedData, field) === undefined
            );
            if (missing.length > 0) {
              throw new VellumError(
                "INVALID_ARGUMENT",
                `Missing required field(s): ${missing.join(", ")}`,
                { collection: parsed.collectionPath, missingFields: missing }
              );
            }
          }

          authorizeOperation({
            apiKeyRecord: apiKey,
            rulesetRecord: ruleset,
            operation: opKind,
            path: parsed.path,
            authContext: authCtx,
            resourceData: existingActive ? existingActive.data : null,
            requestData: validatedData,
            bypassRules: this.resolveBypassRules(ctx),
          });

          const nextVersion = (existingAny ? existingAny.version : 0) + 1;
          const createdAt = existingActive ? existingActive.createdAt : txNowIso;
          // An explicit ctx-level expiry always wins; otherwise keep an
          // existing expiry; otherwise fall back to the collection default TTL.
          let expiresAt = resolveContextExpiry(
            ctx,
            existingActive?.expiresAt ?? existingAny?.expiresAt,
            txNowMs
          );
          if (expiresAt === null) {
            expiresAt = defaultTtlExpiry(collectionConfig, txNowMs);
          }
          const docRow: DocumentRecord = {
            projectId: ctx.projectId,
            path: parsed.path,
            collectionPath: parsed.collectionPath,
            collectionGroup: parsed.collectionGroup,
            documentId: parsed.documentId,
            pathDepth: parsed.pathDepth,
            data: validatedData,
            sizeBytes,
            version: nextVersion,
            createdAt,
            updatedAt: txNowIso,
            deletedAt: null,
            // V2 TTL: persisted into the 14th `expires_at` UNNEST array in SQL_INSERT_DOCUMENTS_UNNEST.
            expiresAt,
          };

          const alreadyPending = pendingRows.has(docRow.path);
          pendingRows.set(docRow.path, docRow);

          // NON-OCC create/update committed with a CAS at flush time closes the
          // prefetch→write TOCTOU window. Precondition writes keep their
          // explicit ifVersion/exists checks (which already validated the
          // observed baseline) and additionally carry that baseline into the
          // CAS, so two racing preconditions cannot both win. OCC-token writes
          // stay on the FULL conditional path (`verifyAndLock` + read-set locks)
          // and never use this fast CAS; tombstone rewrites and read-your-writes
          // also stay on the staged-upsert path because their baseline is pending.
          const casMutation = mutation.type === "create" || mutation.type === "update";
          const dbBaseline = existingAny === null || existingAny.deletedAt === null;
          const isOccToken = typeof ctx.transactionToken === "string" && ctx.transactionToken.length > 0;
          if (alreadyPending || !casMutation || !dbBaseline || isOccToken) {
            casByPath.delete(docRow.path);
          } else if (typeof tx.conditionalPutDocument === "function") {
            casByPath.set(docRow.path, {
              expectedVersion: existingAny === null ? null : existingAny.version,
            });
          }

          const ev = await tx.appendOutboxEvent({
            collectionPath: parsed.collectionPath,
            path: parsed.path,
            documentId: parsed.documentId,
            opType: opKind === "create" ? "created" : "updated",
            version: nextVersion,
            beforeData: existingActive ? existingActive.data : null,
            afterData: validatedData,
          });
          committedOutboxEvents.push(ev);

          userWrites += 1;
          storageBytesDelta += sizeBytes - (existingActive ? existingActive.sizeBytes : 0);
          results.push(this.formatPublicDoc(docRow));
        }

        // Bounded cascade worklist. The final boundary checks for remaining edges
        // and fails closed instead of leaving dangling dependents.
        // A head index replaces `shift()`, which is O(n) per removal and made a
        // widening cascade quadratic. Appended work is picked up naturally.
        for (let head = 0; head < cascadeQueue.length; head += 1) {
          const item = cascadeQueue[head]!;
          await applyRelationRulesForDelete(item.path, item.depth);
        }

        // Flush staged rows + derived index entries. CAS-guarded non-OCC
        // create/update writes commit with their prefetched expected version,
        // closing the prefetch→write TOCTOU window; a loss maps to ALREADY_EXISTS
        // (create) / ABORTED_CONFLICT (update). Deletes, set_null, cascades and
        // OCC-token writes keep the one-shot UNNEST upsert (OCC is already
        // serialised by `verifyAndLock`). Without the CAS capability the whole
        // batch falls back to that same upsert.
        const rowsToWrite = Array.from(pendingRows.values());
        const flushUpsert = async (rows: DocumentRecord[]): Promise<void> => {
          if (rows.length === 0) return;
          if (tx.putDocumentRows) {
            await tx.putDocumentRows(rows);
          } else {
            for (const row of rows) await tx.putDocumentRow(row);
          }
        };
        if (casByPath.size > 0 && typeof tx.conditionalPutDocument === "function") {
          const casRows: DocumentRecord[] = [];
          const plainRows: DocumentRecord[] = [];
          for (const row of rowsToWrite) {
            if (casByPath.has(row.path)) casRows.push(row);
            else plainRows.push(row);
          }
          if (typeof tx.conditionalPutDocumentRows === "function") {
            // ONE SQL statement for the whole CAS batch (UNNEST + RETURNING).
            // Keeps the single-round-trip invariant while closing the TOCTOU race.
            const expected = casRows.map((r) => casByPath.get(r.path)!.expectedVersion);
            const appliedPaths = await tx.conditionalPutDocumentRows(casRows, expected);
            const appliedSet = new Set(appliedPaths);
            for (let i = 0; i < casRows.length; i += 1) {
              const row = casRows[i]!;
              if (appliedSet.has(row.path)) {
                this.telemetry.counter("batch.cas_writes", 1);
                continue;
              }
              const expectedVersion = expected[i] ?? null;
              throw new VellumError(
                expectedVersion === null ? "ALREADY_EXISTS" : "ABORTED_CONFLICT",
                expectedVersion === null
                  ? `Document '${row.path}' was created concurrently`
                  : `Concurrent modification of '${row.path}' (expected version ${expectedVersion})`,
                { path: row.path, expectedVersion }
              );
            }
          } else {
            for (const row of casRows) {
              const expectedVersion = casByPath.get(row.path)!.expectedVersion;
              if (!(await tx.conditionalPutDocument(row, expectedVersion)).applied) {
                throw new VellumError(
                  expectedVersion === null ? "ALREADY_EXISTS" : "ABORTED_CONFLICT",
                  expectedVersion === null
                    ? `Document '${row.path}' was created concurrently`
                    : `Concurrent modification of '${row.path}' (expected version ${expectedVersion})`,
                  { path: row.path, expectedVersion }
                );
              }
              this.telemetry.counter("batch.cas_writes", 1);
            }
          }
          await flushUpsert(plainRows);
        } else {
          await flushUpsert(rowsToWrite);
        }

        if (verified) {
          await this.transactions.markCommitted(tx, verified.tokenHash, tenant);
        }

        const outcome: BatchWriteResult = { results, committedAt: txNowIso };
        if (ctx.idempotencyKey) {
          const responsePayload = JSON.stringify(outcome);
          await idempotentTx.saveIdempotencyResult?.(
            ctx.idempotencyKey,
            sha256Hex(responsePayload),
            responsePayload
          );
        }

        finalUserWrites = userWrites;
        finalUserDeletes = userDeletes;
        finalCascadeWrites = cascadeWrites;
        finalCascadeDeletes = cascadeDeletes;
        finalStorageBytesDelta = storageBytesDelta;
        finalMaxCascadeDepth = maxCascadeDepth;
        finalMaxCascadeWidth = maxCascadeWidth;
        return outcome;
      }
    );

    // Emit usage, metering, telemetry, and realtime ONLY after the DB
    // transaction commits so a rollback never leaks side effects.
    if (!batchWasReplayed) {
      await this.recordUsage(ctx.projectId, {
        documentWrites: finalUserWrites,
        documentDeletes: finalUserDeletes,
        storageBytesDelta: finalStorageBytesDelta,
      });
      this.safeMetering(
        this.resolveOrgId(ctx),
        ctx.projectId,
        finalUserDeletes + finalCascadeDeletes,
        finalStorageBytesDelta
      );
      this.telemetry.histogram("cascade.depth", finalMaxCascadeDepth);
      this.telemetry.histogram("cascade.width", finalMaxCascadeWidth);
      this.telemetry.counter("cascade.writes", finalCascadeWrites);
      this.telemetry.counter("cascade.deletes", finalCascadeDeletes);
    }

    if (committedOutboxEvents.length > 0) {
      this.safeRealtime(ctx.projectId, committedOutboxEvents);
    }

    return batchOutcome;
  }

  /** Begins an OCC transaction by persisting an active row in the Data Plane. */
  public async beginTransaction(ctx: EngineContext): Promise<TransactionBeginResult> {
    this.validateEngineContext(ctx);
    return this.transactions.begin(this.txTenant(ctx));
  }

  public async commitTransaction(
    ctx: EngineContext & { transactionToken: string; writes: BatchMutation[] }
  ): Promise<BatchWriteResult> {
    return this.batchWrite(ctx);
  }

  /** Marks a transaction rolled back; releases its terminal state in the DB. */
  public async rollbackTransaction(
    ctx: EngineContext & { transactionToken: string }
  ): Promise<void> {
    this.validateEngineContext(ctx);
    return this.transactions.rollback(ctx.transactionToken, this.txTenant(ctx));
  }

  /** Purges expired active transaction rows for this tenant. */
  public async cleanupExpiredTransactions(ctx: EngineContext): Promise<number> {
    this.validateEngineContext(ctx);
    return this.transactions.cleanupExpired(
      { projectId: ctx.projectId },
      1000
    );
  }

  public async executeQuery(
    ctx: EngineContext & { querySpec: QuerySpec }
  ): Promise<QueryResult> {
    this.validateEngineContext(ctx);
    await this.enforceRateLimit(ctx);
    return this.telemetry.span("engine.query", () => this.executeQueryImpl(ctx));
  }

  private async executeQueryImpl(
    ctx: EngineContext & { querySpec: QuerySpec }
  ): Promise<QueryResult> {
    const startTime = performance.now();
    // `include` is a document-engine concern (2C/SDK may forward it inside the
    // query spec). Strip it before query validation, which knows nothing about
    // relation expansion, then resolve it after formatting.
    const rawSpec = ctx.querySpec as Record<string, unknown>;
    const rawInclude = rawSpec["include"];
    if (rawInclude !== undefined && rawInclude !== null) {
      this.validateIncludes(rawInclude, 0);
    }
    const includes: IncludeSpec[] | null =
      Array.isArray(rawInclude) ? (rawInclude as IncludeSpec[]) : null;
    const { include: _strippedInclude, ...validationSpec } = rawSpec;
    const normalizedQuery = validateAndNormalizeQuery(validationSpec);
    // A request that supplies both cursors is ambiguous: `startAfter ?? startAt`
    // would silently ignore one of them. Reject before any cursor is decoded.
    if (normalizedQuery.startAfter != null && normalizedQuery.startAt != null) {
      throw new VellumError(
        "INVALID_ARGUMENT",
        "startAfter and startAt cannot be used together"
      );
    }
    const ruleset = await this.loadRuleset(ctx.projectId);
    const apiKey = this.resolveApiKey(ctx);
    const authCtx = this.resolveAuthContext(ctx);

    authorizeOperation({
      apiKeyRecord: apiKey,
      rulesetRecord: ruleset,
      operation: "list",
      path: `${normalizedQuery.collectionPath}/__collection_check__`,
      collectionLevel: true,
      authContext: authCtx,
      bypassRules: this.resolveBypassRules(ctx),
    });

    const qHash = computeQueryShapeHash({
      projectId: ctx.projectId,
      collectionPath: normalizedQuery.collectionPath,
      where: normalizedQuery.where,
      orderBy: normalizedQuery.orderBy,
      or: normalizedQuery.or,
      search: normalizedQuery.search,
    });

    const startAfterCursor = normalizedQuery.startAfter
      ? decodeAndVerifyQueryCursor(normalizedQuery.startAfter, qHash, this.cursorSecret)
      : null;
    const startAtCursor = normalizedQuery.startAt
      ? decodeAndVerifyQueryCursor(normalizedQuery.startAt, qHash, this.cursorSecret)
      : null;

    const activeCursor: CursorPayload | null = startAfterCursor ?? startAtCursor;
    const cursorMode: CursorMode = startAfterCursor ? "startAfter" : startAtCursor ? "startAt" : null;

    return this.dataStore.withTransaction(
      { projectId: ctx.projectId },
      async (tx) => {
        const availableIndexes: CompositeIndexMetadata[] = ((await tx.listIndexes?.()) ?? []).filter(
          isQueryableCompositeIndex
        );
        const { matchedIndex, requiresCompositeIndex } = selectCompositeIndexForQuery(
          normalizedQuery,
          availableIndexes
        );

        if (requiresCompositeIndex && !matchedIndex) {
          throw new VellumError(
            "FAILED_PRECONDITION",
            `Query on '${normalizedQuery.collectionPath}' requires a composite index for the requested filters and sort order.`,
            {
              collectionPath: normalizedQuery.collectionPath,
              suggestedIndex: {
                collectionPath: normalizedQuery.collectionPath,
                fields: normalizedQuery.orderBy
                  .filter((o) => o.field !== "documentId" && o.field !== "__name__")
                  .map((o) => ({ path: o.field, dir: o.dir })),
              },
            }
          );
        }

        const compiledPlan = compileQueryToParameterizedSql({
          projectId: ctx.projectId,
          normalizedQuery,
          matchedCompositeIndex: matchedIndex,
          cursor: activeCursor,
          cursorMode,
        });

        // Execute the compiled plan inside the tenant transaction. On Postgres/Neon
        // this is real SQL; on the in-memory adapter it is the equivalent evaluator.
        const queryBypass = this.resolveBypassRules(ctx);
        const pageDocs: DocumentRecord[] = [];
        let pageHasMore = false;
        let pageCursorDoc: QueriedDocument | null = null;
        let batch = await tx.queryDocuments(compiledPlan);
        let scans = 1;
        // A collection-level `list` allow does not mean every row is readable. Each row also has to pass its
        // own `get` rule. Denied rows are skipped and the scan continues (bounded) so pages stay full and the
        // cursor stays valid. Server keys and system callers see every row.
        for (;;) {
          const more = batch.length > normalizedQuery.limit;
          const rows = batch.slice(0, normalizedQuery.limit);
          let stoppedAt = -1;
          for (let i = 0; i < rows.length; i += 1) {
            const row = rows[i] as DocumentRecord;
            if (!this.canReadRow(apiKey, ruleset, authCtx, queryBypass, row)) continue;
            pageDocs.push(row);
            if (pageDocs.length >= normalizedQuery.limit) {
              stoppedAt = i;
              break;
            }
          }
          const lastRaw = rows[rows.length - 1];
          if (stoppedAt >= 0) {
            pageHasMore = stoppedAt < rows.length - 1 || more;
            pageCursorDoc = rows[stoppedAt] as QueriedDocument;
            break;
          }
          if (!more || !lastRaw) break;
          if (scans >= MAX_ROW_FILTER_SCANS) {
            pageHasMore = true;
            pageCursorDoc = lastRaw;
            break;
          }
          const resumeCursor: CursorPayload = {
            qHash,
            vals: normalizedQuery.orderBy.map((o) => extractDocFieldValue(lastRaw, o.field)),
            docId: lastRaw.documentId,
            sortKey: lastRaw.sortKeyHex,
          };
          const nextPlan = compileQueryToParameterizedSql({
            projectId: ctx.projectId,
            normalizedQuery,
            matchedCompositeIndex: matchedIndex,
            cursor: resumeCursor,
            cursorMode: "startAfter",
          });
          batch = await tx.queryDocuments(nextPlan);
          scans += 1;
        }
        this.telemetry.counter("db.round_trips", scans);
        this.telemetry.histogram("db.round_trips", scans);

        const formattedDocs = pageDocs.map((d) => this.formatPublicDoc(d, normalizedQuery.select));

        // Short-circuit BEFORE relation expansion: the base page alone already
        // exceeds the 4 MiB response ceiling, so including more can only make it
        // worse. Serialize the formatted page once and reuse the exact byte
        // count below (a plain sum of `sizeBytes` would false-positive on narrow
        // `select` projections that shrink the response).
        const baseResponseBytes = Buffer.byteLength(JSON.stringify(formattedDocs), "utf8");
        if (baseResponseBytes > SYSTEM_LIMITS.MAX_QUERY_RESPONSE_BYTES) {
          throw new VellumError(
            "RESPONSE_TOO_LARGE",
            `Query response (${baseResponseBytes} bytes) exceeds 4 MiB limit`,
            { responseBytes: baseResponseBytes }
          );
        }

        if (includes && includes.length > 0) {
          await this.applyIncludes(
            formattedDocs,
            includes,
            apiKey,
            ruleset,
            authCtx,
            this.resolveBypassRules(ctx),
            tx
          );
        }

        // Reuse the pre-include measurement when there was no expansion; only
        // re-serialize when includes actually mutated the documents.
        const responseBytes =
          includes && includes.length > 0
            ? Buffer.byteLength(JSON.stringify(formattedDocs), "utf8")
            : baseResponseBytes;
        if (responseBytes > SYSTEM_LIMITS.MAX_QUERY_RESPONSE_BYTES) {
          throw new VellumError(
            "RESPONSE_TOO_LARGE",
            `Query response (${responseBytes} bytes) exceeds 4 MiB limit`,
            { responseBytes }
          );
        }

        let nextCursor: string | null = null;
        if (pageHasMore) {
          const lastDoc = pageCursorDoc;
          if (lastDoc) {
            const vals = normalizedQuery.orderBy.map((o) => extractDocFieldValue(lastDoc, o.field));
            nextCursor = encodeQueryCursor(
              { qHash, vals, docId: lastDoc.documentId, sortKey: lastDoc.sortKeyHex },
              this.cursorSecret
            );
          }
        }

        await this.recordUsage(ctx.projectId, {
          documentReads: Math.max(1, formattedDocs.length),
          egressBytes: responseBytes,
        });

        const rawMs = performance.now() - startTime;
        const debug = ctx.debug === true;
        // Non-debug responses hide precise timing and the compiled SQL plan.
        const executionTimeMs = debug ? Number(rawMs.toFixed(3)) : Math.round(rawMs / 5) * 5;
        return {
          documents: formattedDocs,
          nextCursor,
          meta: {
            count: formattedDocs.length,
            indexUsed: compiledPlan.indexUsed ?? "primary_btree",
            executionTimeMs,
            ...(debug ? { compiledSql: compiledPlan.sql } : {}),
          },
        };
      }
    );
  }

  /**
   * V2 native aggregation. Enforces `list` Security Rules and the canonical
   * query-complexity ceiling before delegating to the storage adapter, which
   * runs a fully parameterized SQL (or equivalent in-memory) GROUP BY inside
   * the tenant transaction.
   */
  public async aggregateDocuments(
    ctx: EngineContext & { request: AggregateRequest }
  ): Promise<AggregateResult> {
    this.validateEngineContext(ctx);
    await this.enforceRateLimit(ctx);
    return this.telemetry.span("engine.aggregateDocuments", () => this.aggregateDocumentsImpl(ctx));
  }

  private async aggregateDocumentsImpl(
    ctx: EngineContext & { request: AggregateRequest }
  ): Promise<AggregateResult> {
    const startTime = performance.now();
    const request = ctx.request;
    if (!request || typeof request.collectionPath !== "string") {
      throw new VellumError("INVALID_ARGUMENT", "Aggregate request requires a collectionPath");
    }
    const { collectionPath } = parseCollectionPath(request.collectionPath);
    const where = request.where ?? [];
    const orGroups = request.or ?? [];
    if (where.length > SYSTEM_LIMITS.MAX_WHERE_CLAUSES) {
      throw new VellumError(
        "QUERY_TOO_COMPLEX",
        `Aggregate contains ${where.length} where clauses (maximum ${SYSTEM_LIMITS.MAX_WHERE_CLAUSES})`,
        { whereCount: where.length }
      );
    }
    if (orGroups.length > SYSTEM_LIMITS.MAX_WHERE_CLAUSES) {
      throw new VellumError(
        "QUERY_TOO_COMPLEX",
        `Aggregate contains ${orGroups.length} 'or' groups (maximum ${SYSTEM_LIMITS.MAX_WHERE_CLAUSES})`,
        { orGroups: orGroups.length }
      );
    }
    for (const group of orGroups) {
      if (!Array.isArray(group) || group.length === 0 || group.length > SYSTEM_LIMITS.MAX_WHERE_CLAUSES) {
        throw new VellumError("QUERY_TOO_COMPLEX", "Each 'or' group must have 1..10 clauses");
      }
    }
    if (!request.metrics || Object.keys(request.metrics).length === 0) {
      throw new VellumError("INVALID_ARGUMENT", "Aggregate request requires at least one metric");
    }

    const ruleset = await this.loadRuleset(ctx.projectId);
    const apiKey = this.resolveApiKey(ctx);
    const authCtx = this.resolveAuthContext(ctx);
    authorizeOperation({
      apiKeyRecord: apiKey,
      rulesetRecord: ruleset,
      operation: "list",
      path: `${collectionPath}/__collection_check__`,
      collectionLevel: true,
      authContext: authCtx,
      bypassRules: this.resolveBypassRules(ctx),
    });

    // A SQL GROUP BY cannot be filtered row by row, so an aggregate is only allowed when `get` is also
    // granted for the whole collection, not per document. Otherwise it would count rows the caller cannot read.
    try {
      authorizeOperation({
        apiKeyRecord: apiKey,
        rulesetRecord: ruleset,
        operation: "get",
        path: `${collectionPath}/__collection_check__`,
        collectionLevel: true,
        authContext: authCtx,
        bypassRules: this.resolveBypassRules(ctx),
      });
    } catch (error) {
      if (
        error instanceof VellumError &&
        error.code === "PERMISSION_DENIED" &&
        hasRowLevelGetRule(ruleset, `${collectionPath}/__collection_check__`)
      ) {
        throw new VellumError(
          "PERMISSION_DENIED",
          `Aggregates and counts on '${collectionPath}' are not allowed because its get rule depends on each document. Read the documents with a query or use a server key.`,
          { collectionPath }
        );
      }
      throw error;
    }

    if (typeof this.dataStore.aggregateDocuments !== "function") {
      throw new VellumError(
        "FAILED_PRECONDITION",
        "The configured storage adapter does not support native aggregations"
      );
    }
    const rows = await this.dataStore.aggregateDocuments(
      { projectId: ctx.projectId },
      { ...request, collectionPath }
    );
    this.telemetry.counter("db.round_trips", 1);
    this.telemetry.histogram("db.round_trips", 1);
    await this.recordUsage(ctx.projectId, {
      documentReads: Math.max(1, rows.length),
    });
    return {
      rows,
      executionTimeMs: Number((performance.now() - startTime).toFixed(3)),
    };
  }

  /**
   * V2 bulk delete. Verifies `list` at the collection level and `delete` for
   * every matched document (with its resourceData) BEFORE staging tombstones.
   * Selection, tombstones and outbox events all commit in ONE tenant
   * transaction, so RLS can never be bypassed.
   */
  public async deleteWhere(
    ctx: EngineContext & {
      collectionPath: string;
      where?: WhereClause[] | undefined;
      or?: WhereClause[][] | undefined;
      limit?: number | undefined;
    }
  ): Promise<{ deletedCount: number }> {
    this.validateEngineContext(ctx);
    await this.enforceRateLimit(ctx);
    return this.telemetry.span("engine.deleteWhere", () => this.deleteWhereImpl(ctx));
  }

  private async deleteWhereImpl(
    ctx: EngineContext & {
      collectionPath: string;
      where?: WhereClause[] | undefined;
      or?: WhereClause[][] | undefined;
      limit?: number | undefined;
    }
  ): Promise<{ deletedCount: number }> {
    const { collectionPath } = parseCollectionPath(ctx.collectionPath);
    const where = ctx.where ?? [];
    const orGroups = ctx.or ?? [];
    if (where.length > SYSTEM_LIMITS.MAX_WHERE_CLAUSES) {
      throw new VellumError(
        "QUERY_TOO_COMPLEX",
        `Bulk delete contains ${where.length} where clauses (maximum ${SYSTEM_LIMITS.MAX_WHERE_CLAUSES})`
      );
    }
    if (orGroups.length > SYSTEM_LIMITS.MAX_WHERE_CLAUSES) {
      throw new VellumError(
        "QUERY_TOO_COMPLEX",
        `Bulk delete contains ${orGroups.length} 'or' groups (maximum ${SYSTEM_LIMITS.MAX_WHERE_CLAUSES})`
      );
    }
    for (const group of orGroups) {
      if (!Array.isArray(group) || group.length === 0 || group.length > SYSTEM_LIMITS.MAX_WHERE_CLAUSES) {
        throw new VellumError("QUERY_TOO_COMPLEX", "Each 'or' group must have 1..10 clauses");
      }
    }
    const requestedLimit = ctx.limit === undefined ? 1000 : Number(ctx.limit);
    if (!Number.isInteger(requestedLimit) || requestedLimit < 1) {
      throw new VellumError("INVALID_ARGUMENT", "Bulk delete limit must be a positive integer");
    }
    const limit = Math.min(requestedLimit, 5000);

    const ruleset = await this.loadRuleset(ctx.projectId);
    const apiKey = this.resolveApiKey(ctx);
    const authCtx = this.resolveAuthContext(ctx);
    authorizeOperation({
      apiKeyRecord: apiKey,
      rulesetRecord: ruleset,
      operation: "list",
      path: `${collectionPath}/__collection_check__`,
      collectionLevel: true,
      authContext: authCtx,
      bypassRules: this.resolveBypassRules(ctx),
    });

    // Rule grouping is shared with the cascade evaluator and built ONCE here.
    const rulesByCollection = groupRelationRulesByCollection(await this.getProjectRelationRules(ctx));
    const tenant = { projectId: ctx.projectId };
    const committedOutboxEvents: unknown[] = [];
    let cascadeWrites = 0;
    let cascadeDeletes = 0;
    let storageBytesDelta = 0;
    let finalMaxCascadeDepth = 0;
    let finalMaxCascadeWidth = 0;

    const deletedCount = await this.dataStore.withTransaction(
      tenant,
      async (rawTx) => {
        const tx = rawTx as BatchTxHandle;
        const compiled = compileDeleteSelectQuery({
          projectId: ctx.projectId,
          collectionPath,
          where,
          or: orGroups,
          limit,
        });
        const matched = (await tx.queryDocuments(compiled)).slice(0, limit);
        this.telemetry.counter("db.round_trips", 1);
        this.telemetry.histogram("db.round_trips", 1);

        // Per-document authorization uses the matched document's own data so a
        // rule like `resource.data.owner == auth.uid` is enforced on delete.
        for (const doc of matched) {
          authorizeOperation({
            apiKeyRecord: apiKey,
            rulesetRecord: ruleset,
            operation: "delete",
            path: doc.path,
            authContext: authCtx,
            resourceData: doc.data,
            requestData: null,
            bypassRules: this.resolveBypassRules(ctx),
          });
        }

        // Deterministic cascade order and same-transaction overwrite overlay.
        // This is the SAME evaluator used by `batchWrite`, so referential
        // integrity cannot diverge between single and bulk deletes.
        const docs = matched.slice().sort(compareByPath);
        const nowIso = new Date().toISOString();
        const pendingRows = new Map<string, DocumentRecord>();
        const parsedByPath = new Map<string, ParsedPath>();
        const cascadeQueue: Array<{ path: string; depth: number }> = [];
        const visitedCascadePaths = new Set<string>();
        let userDeletes = 0;
        let maxCascadeDepth = 0;
        let maxCascadeWidth = 0;

        const evaluate = async (deletedPath: string, depth: number): Promise<void> => {
          if (rulesByCollection.size === 0) return;
          if (visitedCascadePaths.has(deletedPath)) return;
          visitedCascadePaths.add(deletedPath);
          if (depth > maxCascadeDepth) maxCascadeDepth = depth;
          const width = await evaluateRelationRulesForDelete({
            deletedPath,
            depth,
            rulesByCollection,
            tenant,
            parsedByPath,
            pendingRows,
            tx,
            stageSetNull,
            stageCascadeDelete,
          });
          if (width > maxCascadeWidth) maxCascadeWidth = width;
        };

        const stageSetNull = async (row: DocumentRecord, field: string): Promise<void> => {
          const nextData = structuredClone(row.data);
          setFieldByPath(nextData, field, null);
          const { data: validated, sizeBytes } = normalizeAndValidateDocumentData(nextData, false);
          const nextRow: DocumentRecord = {
            ...row,
            data: validated,
            sizeBytes,
            version: row.version + 1,
            updatedAt: nowIso,
            deletedAt: null,
          };
          pendingRows.set(nextRow.path, nextRow);
          const ev = await tx.appendOutboxEvent({
            collectionPath: nextRow.collectionPath,
            path: nextRow.path,
            documentId: nextRow.documentId,
            opType: "updated",
            version: nextRow.version,
            beforeData: row.data,
            afterData: validated,
          });
          committedOutboxEvents.push(ev);
          cascadeWrites += 1;
          storageBytesDelta += sizeBytes - row.sizeBytes;
        };

        const stageCascadeDelete = async (row: DocumentRecord, depth: number): Promise<void> => {
          const nextVersion = row.version + 1;
          const tombstone: DocumentRecord = {
            ...row,
            version: nextVersion,
            updatedAt: nowIso,
            deletedAt: nowIso,
          };
          pendingRows.set(tombstone.path, tombstone);
          const ev = await tx.appendOutboxEvent({
            collectionPath: row.collectionPath,
            path: row.path,
            documentId: row.documentId,
            opType: "deleted",
            version: nextVersion,
            beforeData: row.data,
            afterData: null,
          });
          committedOutboxEvents.push(ev);
          cascadeDeletes += 1;
          storageBytesDelta -= row.sizeBytes;
          cascadeQueue.push({ path: row.path, depth: depth + 1 });
        };

        for (const doc of docs) {
          // A doc already cascade-deleted earlier in this batch needs no second
          // tombstone; the pending overlay also supplies the latest version and
          // data for set_null side effects.
          const before = pendingRows.get(doc.path) ?? doc;
          if (before.deletedAt !== null) continue;
          await evaluate(before.path, 1);
          const target = pendingRows.get(doc.path) ?? doc;
          if (target.deletedAt !== null) continue;
          const version = target.version + 1;
          const tombstone: DocumentRecord = {
            ...target,
            version,
            updatedAt: nowIso,
            deletedAt: nowIso,
          };
          pendingRows.set(tombstone.path, tombstone);
          const ev = await tx.appendOutboxEvent({
            collectionPath: target.collectionPath,
            path: target.path,
            documentId: target.documentId,
            opType: "deleted",
            version,
            beforeData: target.data,
            afterData: null,
          });
          committedOutboxEvents.push(ev);
          userDeletes += 1;
          storageBytesDelta -= target.sizeBytes;
        }

        // Head-index worklist (no `shift()`), mirroring batchWrite.
        for (let head = 0; head < cascadeQueue.length; head += 1) {
          const item = cascadeQueue[head]!;
          await evaluate(item.path, item.depth);
        }

        const rowsToWrite = Array.from(pendingRows.values());
        if (rowsToWrite.length > 0) {
          if (tx.putDocumentRows) {
            await tx.putDocumentRows(rowsToWrite);
          } else {
            for (const row of rowsToWrite) await tx.putDocumentRow(row);
          }
        }

        finalMaxCascadeDepth = maxCascadeDepth;
        finalMaxCascadeWidth = maxCascadeWidth;
        return userDeletes;
      }
    );

    // Emit usage, metering, telemetry, and realtime ONLY after commit.
    await this.recordUsage(ctx.projectId, {
      documentDeletes: deletedCount,
      storageBytesDelta,
    });
    this.safeMetering(
      this.resolveOrgId(ctx),
      ctx.projectId,
      deletedCount + cascadeDeletes,
      storageBytesDelta
    );
    this.telemetry.histogram("cascade.depth", finalMaxCascadeDepth);
    this.telemetry.histogram("cascade.width", finalMaxCascadeWidth);
    this.telemetry.counter("cascade.writes", cascadeWrites);
    this.telemetry.counter("cascade.deletes", cascadeDeletes);

    if (committedOutboxEvents.length > 0) {
      this.safeRealtime(ctx.projectId, committedOutboxEvents);
    }
    // Counts only — no document payload ever reaches the audit sink.
    this.safeAudit("document.delete.where", {
      organizationId: this.resolveOrgId(ctx) || null,
      projectId: ctx.projectId,
      targetId: collectionPath,
      metadata: {
        deletedCount,
        cascadeDeletes,
        cascadeWrites,
        freedBytes: -storageBytesDelta,
      },
    });
    return { deletedCount };
  }

  /* ------------------------------------------------------------------------ */
  /* Phase 4B — batched reads, streaming export, restore                      */
  /* ------------------------------------------------------------------------ */

  /**
   * Reads up to MAX_BATCH_OPERATIONS documents in ONE batch round trip.
   * Unauthorized documents are omitted silently (never thrown), and results
   * are returned in the caller's requested path order.
   */
  public async getDocuments(
    ctx: EngineContext & {
      paths: string[];
      include?: IncludeSpec[] | undefined;
      select?: string[] | undefined;
    }
  ): Promise<PublicDocument[]> {
    this.validateEngineContext(ctx);
    await this.enforceRateLimit(ctx);
    const paths = ctx.paths;
    if (!Array.isArray(paths)) {
      throw new VellumError("INVALID_ARGUMENT", "getDocuments requires a 'paths' array");
    }
    if (paths.length > SYSTEM_LIMITS.MAX_BATCH_OPERATIONS) {
      throw new VellumError(
        "BATCH_SIZE_EXCEEDED",
        `getDocuments paths (${paths.length}) exceeds maximum limit of ${SYSTEM_LIMITS.MAX_BATCH_OPERATIONS}`,
        { count: paths.length, maxOperations: SYSTEM_LIMITS.MAX_BATCH_OPERATIONS }
      );
    }

    const parsed = paths.map((path) => parseDocumentPath(path));
    const ruleset = await this.loadRuleset(ctx.projectId);
    const apiKey = this.resolveApiKey(ctx);
    const authCtx = this.resolveAuthContext(ctx);
    const bypassRules = this.resolveBypassRules(ctx);

    // One `list` authorization per unique collection path (deduped + sorted).
    const uniqueCollections = Array.from(new Set(parsed.map((p) => p.collectionPath))).sort();
    for (const collectionPath of uniqueCollections) {
      authorizeOperation({
        apiKeyRecord: apiKey,
        rulesetRecord: ruleset,
        operation: "list",
        path: `${collectionPath}/__collection_check__`,
        collectionLevel: true,
        authContext: authCtx,
        bypassRules,
      });
    }

    const uniquePaths = Array.from(new Set(parsed.map((p) => p.path))).sort();
    const docs = await this.dataStore.withTransaction(
      { projectId: ctx.projectId },
      async (tx) => {
        const batchTx = tx as BatchTxHandle;
        const rows: DocumentRecord[] =
          uniquePaths.length === 0
            ? []
            : typeof batchTx.batchGetDocuments === "function"
              ? await batchTx.batchGetDocuments(uniquePaths, false)
              : (await Promise.all(uniquePaths.map((path) => tx.getDocument(path, false)))).filter(
                  (row): row is DocumentRecord => row !== null
                );
        this.telemetry.counter("db.round_trips", 1);
        this.telemetry.histogram("db.round_trips", 1);

        const rowsByPath = new Map<string, DocumentRecord>();
        for (const row of rows) rowsByPath.set(row.path, row);

        const publicDocs: PublicDocument[] = [];
        for (const path of uniquePaths) {
          const row = rowsByPath.get(path);
          if (!row) continue;
          try {
            authorizeOperation({
              apiKeyRecord: apiKey,
              rulesetRecord: ruleset,
              operation: "get",
              path: row.path,
              authContext: authCtx,
              resourceData: row.data,
              bypassRules,
            });
          } catch {
            continue; // A denied document is omitted silently, never leaked.
          }
          publicDocs.push(this.formatPublicDoc(row, ctx.select));
        }

        const includes = ctx.include;
        if (publicDocs.length > 0 && Array.isArray(includes) && includes.length > 0) {
          await this.applyIncludes(publicDocs, includes, apiKey, ruleset, authCtx, bypassRules, tx);
        }

        const includedBytes = publicDocs.reduce(
          (sum, doc) =>
            sum + (doc._included ? Buffer.byteLength(JSON.stringify(doc._included), "utf8") : 0),
          0
        );
        const egressBytes = publicDocs.reduce((sum, doc) => sum + doc.sizeBytes, 0) + includedBytes;
        await this.recordUsage(ctx.projectId, {
          documentReads: publicDocs.length,
          egressBytes,
        });
        return publicDocs;
      }
    );

    // Preserve the requested order (and duplicates) by filtering the fetched map.
    const byPath = new Map(docs.map((doc) => [doc.path, doc]));
    const ordered: PublicDocument[] = [];
    for (const p of parsed) {
      const doc = byPath.get(p.path);
      if (doc) ordered.push(doc);
    }
    return ordered;
  }

  /**
   * Cursor-only streaming export. Keeps at most one 1,000-row page in memory
   * and uses one tenant transaction per page (never SQL OFFSET / full scan).
   */
  public async *exportCollectionDocumentsStream(
    ctx: EngineContext,
    name: string,
    opts?: ExportCollectionDocumentsOptions | undefined
  ): AsyncIterable<ExportedCollectionDocument> {
    this.validateEngineContext(ctx);
    // Async generators run this body on first `next()`; authenticate eagerly so
    // a missing key fails before any page is fetched.
    this.resolveApiKey(ctx);
    await this.enforceRateLimit(ctx);
    const collectionName = validateCollectionName(name);
    const tenant = this.tenantOf(ctx);
    const pageSize = 1000;
    const maxLimit =
      opts?.limit === undefined ? Number.POSITIVE_INFINITY : Math.max(0, Math.floor(opts.limit));
    let afterDocumentId: string | null = opts?.cursor ?? null;
    let emitted = 0;

    while (emitted < maxLimit) {
      const page = await this.dataStore.withTransaction(tenant, async (tx) => {
        const pageLoader = tx.listDocumentsInCollectionPage;
        if (typeof pageLoader !== "function") {
          throw new VellumError(
            "FAILED_PRECONDITION",
            "The configured storage adapter does not support cursor-only collection streaming"
          );
        }
        return pageLoader(collectionName, {
          ...(afterDocumentId !== null ? { afterDocumentId } : {}),
          limit: pageSize,
        });
      });
      this.telemetry.counter("db.round_trips", 1);
      this.telemetry.histogram("db.round_trips", 1);
      if (page.length === 0) break;

      for (const row of page) {
        if (emitted >= maxLimit) break;
        yield {
          id: row.documentId,
          path: row.path,
          data: structuredClone(row.data),
          version: row.version,
          createdAt: toIsoDate(row.createdAt) ?? "",
          updatedAt: toIsoDate(row.updatedAt) ?? "",
        };
        emitted += 1;
        afterDocumentId = row.documentId;
      }
      if (page.length < pageSize) break;
    }
  }

  /**
   * Restores a soft-deleted document. `ifVersion` MUST equal the tombstone
   * version (Decision 9), so a concurrent restore or rewrite cannot be lost.
   */
  public async restoreDocument(
    ctx: EngineContext & { path: string; ifVersion: number }
  ): Promise<PublicDocument> {
    this.validateEngineContext(ctx);
    this.resolveApiKey(ctx);
    await this.enforceRateLimit(ctx);
    const ifVersion = ctx.ifVersion;
    if (!Number.isInteger(ifVersion) || !Number.isFinite(ifVersion) || ifVersion < 1) {
      throw new VellumError(
        "INVALID_ARGUMENT",
        "restoreDocument requires ifVersion to be a finite integer >= 1"
      );
    }
    const parsed = parseDocumentPath(ctx.path);
    const ruleset = await this.loadRuleset(ctx.projectId);
    const apiKey = this.resolveApiKey(ctx);
    const authCtx = this.resolveAuthContext(ctx);
    const nowIso = new Date().toISOString();
    const committedOutboxEvents: unknown[] = [];

    const restored = await this.dataStore.withTransaction(
      { projectId: ctx.projectId },
      async (rawTx): Promise<DocumentRecord> => {
        const tx = rawTx as BatchTxHandle;
        const row = await tx.getDocument(parsed.path, true, true);
        if (!row) {
          throw new VellumError("NOT_FOUND", `Document '${parsed.path}' not found`, { path: parsed.path });
        }
        if (row.deletedAt === null) {
          throw new VellumError(
            "FAILED_PRECONDITION",
            `Document '${parsed.path}' is not soft-deleted`,
            { path: parsed.path }
          );
        }
        if (row.version !== ifVersion) {
          throw new VellumError(
            "FAILED_PRECONDITION",
            `Tombstone version precondition failed on '${parsed.path}' ` +
              `(expected ${ifVersion}, actual ${row.version})`,
            { path: parsed.path, expectedVersion: ifVersion, actualVersion: row.version }
          );
        }

        authorizeOperation({
          apiKeyRecord: apiKey,
          rulesetRecord: ruleset,
          operation: "create",
          path: parsed.path,
          authContext: authCtx,
          resourceData: null,
          requestData: row.data,
          bypassRules: this.resolveBypassRules(ctx),
        });

        const restored: DocumentRecord = {
          ...row,
          deletedAt: null,
          version: row.version + 1,
          updatedAt: nowIso,
        };
        await tx.putDocumentRow(restored);
        committedOutboxEvents.push(
          await tx.appendOutboxEvent({
            collectionPath: parsed.collectionPath,
            path: parsed.path,
            documentId: parsed.documentId,
            opType: "created",
            version: restored.version,
            beforeData: row.data,
            afterData: row.data,
          })
        );
        return restored;
      }
    );

    await this.recordUsage(ctx.projectId, {
      documentWrites: 1,
      storageBytesDelta: restored.sizeBytes,
    });
    this.safeRealtime(ctx.projectId, committedOutboxEvents);
    this.safeAudit("document.restore", {
      organizationId: this.resolveOrgId(ctx) || null,
      projectId: ctx.projectId,
      targetId: parsed.path,
      metadata: { version: restored.version },
    });
    return this.formatPublicDoc(restored);
  }

  /* ------------------------------------------------------------------------ */
  /* Collections lifecycle (docs/COLLECTIONS-CONTRACT.md §2.4)                 */
  /* ------------------------------------------------------------------------ */

  private tenantOf(ctx: EngineContext): { projectId: string } {
    return { projectId: ctx.projectId };
  }

  public async listCollections(
    ctx: EngineContext,
    opts?: ListCollectionsOptions
  ): Promise<{ collections: CollectionWithStats[]; nextCursor: string | null }> {
    return this.dataStore.listCollections(this.tenantOf(ctx), opts);
  }

  public async getCollection(ctx: EngineContext, name: string): Promise<CollectionWithStats | null> {
    return this.dataStore.getCollection(this.tenantOf(ctx), name);
  }

  public async createCollection(
    ctx: EngineContext,
    input: CreateCollectionInput
  ): Promise<CollectionRecord> {
    const created = await this.dataStore.createCollection(this.tenantOf(ctx), input);
    this.safeAudit("collection.create", {
      organizationId: this.resolveOrgId(ctx) || null,
      projectId: ctx.projectId,
      targetId: created.name,
      metadata: { name: created.name, description: created.description },
    });
    return created;
  }

  public async updateCollection(
    ctx: EngineContext,
    name: string,
    patch: UpdateCollectionInput
  ): Promise<CollectionWithStats> {
    const updated = await this.dataStore.updateCollection(this.tenantOf(ctx), name, patch);
    this.safeAudit("collection.update", {
      organizationId: this.resolveOrgId(ctx) || null,
      projectId: ctx.projectId,
      targetId: updated.name,
      metadata: {
        name: updated.name,
        defaultTtlSeconds: updated.defaultTtlSeconds,
        requiredFields: updated.schemaValidation?.requiredFields ?? null,
      },
    });
    return updated;
  }

  public async clearCollection(
    ctx: EngineContext,
    name: string
  ): Promise<{ deletedCount: number; freedBytes: number }> {
    const result = await this.dataStore.clearCollectionDocuments(this.tenantOf(ctx), name);
    const orgId = this.resolveOrgId(ctx);
    this.safeMetering(orgId, ctx.projectId, result.deletedCount, -result.freedBytes);
    this.safeAudit("collection.clear", {
      organizationId: orgId || null,
      projectId: ctx.projectId,
      targetId: name,
      metadata: { deletedCount: result.deletedCount, freedBytes: result.freedBytes },
    });
    return result;
  }

  public async deleteCollection(
    ctx: EngineContext,
    name: string
  ): Promise<{ deletedCollection: boolean; deletedDocuments: number; freedBytes: number }> {
    const result = await this.dataStore.deleteCollection(this.tenantOf(ctx), name);
    const orgId = this.resolveOrgId(ctx);
    this.safeMetering(
      orgId,
      ctx.projectId,
      result.deletedDocuments,
      -result.freedBytes
    );
    this.safeAudit("collection.delete", {
      organizationId: orgId || null,
      projectId: ctx.projectId,
      targetId: name,
      metadata: {
        deletedCollection: result.deletedCollection,
        deletedDocuments: result.deletedDocuments,
        freedBytes: result.freedBytes,
      },
    });
    return result;
  }

  /**
   * Imports raw documents into a collection. Payloads are validated with the
   * same safe-JSON checks used by `batchWrite`; invalid entries are skipped and
   * reported without leaking secrets. Valid entries are written in batches of
   * at most {@link IMPORT_BATCH_SIZE}.
   */
  public async importCollectionDocuments(
    ctx: EngineContext,
    name: string,
    docs: Record<string, unknown>[],
    opts?: ImportOptionsWithLimit
  ): Promise<ImportCollectionDocumentsResult> {
    this.validateEngineContext(ctx);
    // Import is a privileged bulk write; batchWrite re-checks per document, but
    // the entry point itself must fail closed even for an empty payload.
    this.resolveApiKey(ctx);
    const collectionName = validateCollectionName(name);
    if (!Array.isArray(docs)) {
      throw new VellumError("INVALID_ARGUMENT", "importCollectionDocuments requires a 'docs' array");
    }
    // Optional cap (clamped to MAX_QUERY_LIMIT). NaN / non-integer / negative
    // values are rejected at the boundary rather than silently truncating.
    const requestedLimit = opts?.limit;
    if (
      requestedLimit !== undefined &&
      (!Number.isInteger(requestedLimit) || requestedLimit < 0)
    ) {
      throw new VellumError("INVALID_ARGUMENT", "Import limit must be a non-negative integer", {
        limit: Number.isFinite(requestedLimit) ? requestedLimit : null,
      });
    }
    const tenant = this.tenantOf(ctx);
    await this.dataStore.ensureCollectionExists(tenant, collectionName);

    const errors: Array<{ index: number; message: string }> = [];
    const valid: Array<{ index: number; path: string; data: Record<string, unknown> }> = [];
    for (let i = 0; i < docs.length; i += 1) {
      const doc = docs[i];
      try {
        if (!doc || typeof doc !== "object" || Array.isArray(doc)) {
          throw new VellumError("INVALID_ARGUMENT", "Document payload must be a plain JSON object");
        }
        const { data } = normalizeAndValidateDocumentData(doc, false);
        const rawId = data["id"];
        const documentId =
          typeof rawId === "string" && rawId.length > 0 ? rawId : randomUUID();
        const path = `${collectionName}/${documentId}`;
        // Reject a derived path that cannot be addressed before we try to write.
        parseDocumentPath(path);
        valid.push({ index: i, path, data });
      } catch (error) {
        errors.push({
          index: i,
          message: error instanceof Error ? error.message : "Invalid document payload",
        });
      }
    }

    const insertOnly = opts?.mode === "insert_only";
    const importLimit =
      requestedLimit === undefined
        ? valid.length
        : Math.min(requestedLimit, SYSTEM_LIMITS.MAX_QUERY_LIMIT);
    const toImport = valid.slice(0, importLimit);

    // Imports are atomic per chunk but deliberately NON-transactional across
    // chunks: an OCC token from the caller must not bind independent batches.
    // Strip it once here rather than on every chunk.
    const { transactionToken: _drop, ...batchCtx } = ctx;
    void _drop;

    let importedCount = 0;
    for (let start = 0; start < toImport.length; start += IMPORT_BATCH_SIZE) {
      const batch = toImport.slice(start, start + IMPORT_BATCH_SIZE);
      const writes: BatchMutation[] = batch.map((entry) =>
        insertOnly
          ? { type: "create", path: entry.path, data: entry.data }
          : { type: "set", path: entry.path, data: entry.data, merge: false }
      );
      try {
        await this.batchWrite({ ...batchCtx, writes });
        importedCount += batch.length;
      } catch (error) {
        // A whole-batch failure marks each of its entries as skipped; errors
        // carry only a safe message (never request headers, keys or secrets).
        const message = error instanceof Error ? error.message : "Import failed";
        for (const entry of batch) errors.push({ index: entry.index, message });
      }
    }

    return { importedCount, skippedCount: errors.length, errors };
  }

  public async exportCollectionDocuments(
    ctx: EngineContext,
    name: string,
    opts?: ExportCollectionDocumentsOptions
  ): Promise<ExportCollectionDocumentsResult> {
    this.validateEngineContext(ctx);
    const collectionName = validateCollectionName(name);
    // Export is a bulk read: it must authenticate AND enforce collection-level
    // `list` rules before any row is materialised (same gate as executeQuery).
    const apiKey = this.resolveApiKey(ctx);
    const ruleset = await this.loadRuleset(ctx.projectId);
    const authCtx = this.resolveAuthContext(ctx);
    authorizeOperation({
      apiKeyRecord: apiKey,
      rulesetRecord: ruleset,
      operation: "list",
      path: `${collectionName}/__collection_check__`,
      collectionLevel: true,
      authContext: authCtx,
      bypassRules: this.resolveBypassRules(ctx),
    });
    const exportBypass = this.resolveBypassRules(ctx);
    const tenant = this.tenantOf(ctx);
    const cursor = opts?.cursor ?? null;
    const requestedLimit = opts?.limit;
    if (
      requestedLimit !== undefined &&
      (!Number.isInteger(requestedLimit) || requestedLimit < 0)
    ) {
      throw new VellumError("INVALID_ARGUMENT", "Export limit must be a non-negative integer", {
        limit: Number.isFinite(requestedLimit) ? requestedLimit : null,
      });
    }
    // No limit means "all documents"; an explicit limit is clamped to the locked
    // MAX_QUERY_LIMIT. Both are paged with a cursor — never SQL OFFSET in public
    // APIs — so 2,500+ documents paginate without gaps or duplicates.
    let remaining =
      requestedLimit === undefined
        ? Number.POSITIVE_INFINITY
        : Math.min(requestedLimit, SYSTEM_LIMITS.MAX_QUERY_LIMIT);

    const documents: ExportedCollectionDocument[] = [];
    let afterDocumentId: string | null = cursor;
    let nextCursor: string | null = null;

    await this.dataStore.withTransaction(tenant, async (tx) => {
      const pageLoader = (tx as BatchTxHandle).listDocumentsInCollectionPage;

      const loadPage = async (after: string | null, limit: number): Promise<DocumentRecord[]> => {
        if (typeof pageLoader === "function") {
          // One parameterized, cursor-only statement ordered by documentId ASC.
          // Bare argument form matches `exportCollectionDocumentsStream`; the
          // transaction already carries the tenant for RLS.
          return pageLoader(collectionName, {
            ...(after !== null ? { afterDocumentId: after } : {}),
            limit,
          });
        }
        // Test doubles / legacy adapters: keep the old full-scan + in-memory
        // sort with a deterministic path ASC / documentId tie-breaker.
        const rows = await this.dataStore.listDocumentsInCollection(tenant, collectionName);
        const sorted = rows.slice().sort(compareByPath);
        const filtered = after === null ? sorted : sorted.filter((row) => row.documentId > after);
        return filtered.slice(0, limit);
      };

      for (;;) {
        const take = Math.min(remaining, EXPORT_PAGE_SIZE);
        if (take <= 0) break;
        // One lookahead row determines whether a further cursor is needed, all
        // within the adapter's 500-row cap (EXPORT_PAGE_SIZE + 1 === 500).
        const rows = await loadPage(afterDocumentId, take + 1);
        this.telemetry.counter("db.round_trips", 1);
        this.telemetry.histogram("db.round_trips", 1);
        if (rows.length === 0) break;

        const kept = rows.slice(0, take);
        for (const row of kept) {
          if (!this.canReadRow(apiKey, ruleset, authCtx, exportBypass, row)) {
            afterDocumentId = row.documentId;
            if (Number.isFinite(remaining)) remaining -= 1;
            continue;
          }
          documents.push({
            id: row.documentId,
            path: row.path,
            data: structuredClone(row.data),
            version: row.version,
            createdAt: toIsoDate(row.createdAt) ?? "",
            updatedAt: toIsoDate(row.updatedAt) ?? "",
          });
          afterDocumentId = row.documentId;
          if (Number.isFinite(remaining)) remaining -= 1;
        }
        if (rows.length <= take) break; // collection exhausted (no lookahead)
        if (Number.isFinite(remaining) && remaining <= 0) {
          // Exact cap reached with more rows available: expose a stable cursor.
          nextCursor = kept[kept.length - 1]?.documentId ?? null;
          break;
        }
        // Otherwise continue with the next cursor-only page.
      }
    });

    return { documents, nextCursor };
  }
}
