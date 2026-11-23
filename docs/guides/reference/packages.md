---
title: Package APIs
order: 9
group: Reference
description: Internal package-by-package API surface for the framework-agnostic @vellum/* libraries in the monorepo.
---

# Package APIs (internal)

This is an internal reference for the monorepo libraries under `packages/*`. Signatures are transcribed from each package's `src/index.ts` and its source files. For the customer-facing libraries use [JavaScript SDK](../sdks/javascript.md) and [Flutter SDK](../sdks/flutter.md) instead.

:::warning Internal packages — not the public SDK
The libraries below are **internal building blocks** used by `apps/api` and the SDKs. They are not a supported public product surface: their exports can change between releases, and some paths (notably `@vellum/core` tagged-value constructors and `@vellum/query-engine` cursors) are wire-format critical. Application code should depend on `@vellumdb/sdk-js` or plain HTTP, not on these packages directly.
:::

## Architectural boundary rules

| Rule | Consequence for these packages |
| :--- | :--- |
| Modular-monolith boundary | All domain logic lives in framework-agnostic `packages/*`. `apps/api`, `apps/dashboard`, `apps/admin` are thin delivery adapters — no AST evaluation, wire serialization or SQL compilation in route handlers/UI. |
| Dual data plane | `database-control` (users, orgs, projects, key hashes, rulesets, metering, audit) and `database-data` (documents, index defs/entries, outbox, transactions) are physically/logically separate. Bootstrap and key verification never depend on the public document API. |
| Tenant isolation | Every Data Plane operation requires `(projectId)` (`TenantContext`). PostgreSQL transactions bind `SET LOCAL statement_timeout='5000ms'`, `app.current_project_id` so RLS fails closed. |
| Zero customer DDL | Tenant composite indexes are rows in `document_indexes` + `document_index_entries` with binary sort keys — never `CREATE INDEX` on `documents`. |
| Deterministic AST | No `eval()`/`new Function()`; `@vellum/authorization` validates and evaluates the v1 rules AST synchronously. |
| Cursor-only pagination | HMAC-SHA256 signed opaque cursors from `@vellum/query-engine`; no `OFFSET`. |
| Zero external stateful services | PostgreSQL only. Realtime = `LISTEN/NOTIFY` + durable outbox; caches/rate limits are in-process TTL plus PostgreSQL-backed state. |

All eight packages below are framework-agnostic (none import Hono, Next.js, or React). Several use Node builtins (`node:crypto`, `pg`) and therefore target the server/runtime, not the browser.

---

## `@vellum/core`

**Responsibility:** locked limits, canonical error hierarchy, path parser, tagged wire format, and order-preserving sort-key encoder. Pure, dependency-light, and the lowest-level package in the graph (`@vellum/api-contract`, `@vellum/authorization`, `@vellum/query-engine`, `@vellum/storage`, `@vellum/realtime` all depend on it). Barrel exports `limits`, `errors`, `paths`, `wire-format`, `sort-key`.

| Export | Signature / shape | Semantics |
| :--- | :--- | :--- |
| `SYSTEM_LIMITS` | `const` object | All v1 quotas (1 MiB docs, path depth 10, batch 100, etc.). |
| `VellumError` | `class extends Error` — `constructor(code: ErrorCode, message: string, details?: ErrorDetails)`; fields `code`, `status`, `details`; `toEnvelope(requestId?: string): ErrorEnvelope` | Canonical throwable; `status` resolved from `ERROR_HTTP_STATUS`. |
| `ERROR_HTTP_STATUS` | `const` map `Record<ErrorCode, number>` | Canonical code → HTTP status (see [Errors](./errors.md)). |
| `parseDocumentPath` | `(rawPath: string): DocumentPathResult` | Validates even 2–10 segments; returns `path`, `collectionPath`, `collectionGroup`, `documentId`, `pathDepth`, `segments`. |
| `parseCollectionPath` | `(rawCollectionPath: string): CollectionPathResult` | Validates odd 1–9 segments. |
| `validatePathSegment` | `(segment: string, fullPath: string): void` | Rejects empty, relative, `__…__`, control chars, >1,500 bytes. |
| `validateWireValue` | `(value: unknown, depth?: number, allowFieldOps?: boolean): void` | Recursive tagged-value/field-op validation, ≤20 nesting. |
| `validateFieldName` | `(fieldName: string): void` | Non-empty, ≤256 chars, no control chars. |
| `normalizeAndValidateDocumentData` | `(data: unknown, allowFieldOps?: boolean): NormalizedDocument` | Canonicalizes timestamps, enforces 1 MiB cap; returns `{data, sizeBytes}`. |
| `WireValue` | `const` with `int64`, `timestamp`, `reference`, `bytes`, `geopoint`, `escapeMap` | Constructors for `$t`/`$v` tagged values. |
| `encodeSortableFloat64` / `encodeSortableInt64` | `(n: number): Buffer` / `(v: bigint\|number\|string): Buffer` | Order-preserving big-endian byte encodings. |
| `TYPE_TAG` | `const` map | Sort-key type bytes (`NULL 0x0a`, `NUMBER 0x20`, `STRING 0x30`, …). |

## `@vellum/api-contract`

**Responsibility:** runtime Zod schemas for control-plane, document, query, transaction, error, limit and WebSocket shapes; OpenAPI 3.1 generator; boundary validators used by the API routes.

| Export | Signature / shape | Semantics |
| :--- | :--- | :--- |
| `generateOpenApiSpec` | `(serverUrl = "https://api.vellum.dev") => object` | Builds the OpenAPI 3.1 document served at `/v1/openapi.json`. |
| `validateProjectParam` | `(name: string): ProjectName` | Accepts a project name; throws `INVALID_ARGUMENT` otherwise. |
| `validateClientWsFrame` | `(frame: unknown): ClientFrame` | Zod-validates inbound WS frames; throws `INVALID_ARGUMENT`. |
| `VALID_PROJECT_NAMES`, `VALID_QUERY_OPERATORS` | `Set<string>` | Backward-compatible sets. |
| `QuerySpecSchema`, `QueryResponseSchema`, `BatchWriteSchema`, `CommitTransactionSchema` | Zod schemas | Runtime validation of public request/response bodies. |
| `CreateOrganizationRequestSchema`, `CreateProjectRequestSchema`, `CreateApiKeyRequestSchema`, `UpdateRulesetRequestSchema` | Zod schemas | Control-plane request validation. |
| `ClientFrameSchema`, `ServerFrameSchema`, `ResumeCompleteFrame` | Zod schema / type | Canonical WebSocket frame union. |
| `TaggedObjectSchema`, `TaggedValueSchema`, `DocumentPayloadSchema` | Zod schemas | Wire-format representation (normalizes ). |
| `ApiErrorSchema`, `ErrorCodeEnum` | Zod schema / enum | Canonical error envelope and code set. |
| types | `QuerySpec`, `QueryFilter`, `QueryOrderBy`, `ClientFrame`, `ServerFrame`, `ApiError`, `PlanTier`, `ProjectName`, … | Inferred TypeScript types. |

## `@vellum/authorization`

**Responsibility:** API-key generation/verification, JWT claim verification, session tokens + revocation, TOTP MFA helpers, and the deterministic security-rules AST evaluator/authorizer. Framework-agnostic security core.

| Export | Signature | Semantics |
| :--- | :--- | :--- |
| `generateProjectApiKey` | `({ keyType: "public"\|"server", pepper?: string }): GeneratedApiKey` | Creates `pk_…` / `sk_…` by default, returns `{fullKey, keyPrefix, secretHash, keyType}`. |
| `hashApiKey` | `(fullKey: string, pepper?: string): string` | SHA-256(`fullKey:pepper`) hex. |
| `verifyApiKey` | `(fullKey: unknown, controlStore: ApiKeyStore, pepper?: string): ApiKeyRecord` | Constant-time digest compare with 30 s in-process cache; throws `UNAUTHENTICATED`. |
| `invalidateApiKeyCache` | `(keyPrefix?: string): void` | Clears one/all verified-key cache entries. |
| `getDefaultPepper` | `(): string` | Lazy `API_KEY_PEPPER` → `PEPPER_HEX` → fallback resolution. |
| `signEndUserJwt` / `verifyEndUserJwt` / `verifyEndUserJwtSync` | `(payload, secret?): string` / `(token, options?): Promise<AuthContext>` / `(token, secret?): AuthContext` | HS256 local JWT helpers; async variant supports remote JWKS via `jose`. |
| `validateSecurityRulesetAst` | `(rulesetAst: unknown): boolean` | Enforces v1 AST schema (depth ≤10, nodes ≤100). |
| `matchRulePathPattern` | `(pattern: string, targetPath: string): Record<string,string> \| null` | Path-pattern matcher returning captured params. |
| `evaluateAstNode` | `(expr: AstExpression, context: RuleEvaluationContext): boolean` | Synchronous, no-`eval` expression evaluator. |
| `authorizeOperation` | `({apiKeyRecord, rulesetRecord, operation, path, authContext?, resourceData?, requestData?, requestTimeMs?}: AuthorizeOperationParams): AuthorizationResult` | Server-key scope check or rules-AST evaluation; throws `PERMISSION_DENIED`. |
| `createSessionService` | `({ secret: string, revocationStore: RevocationStore }): SessionService` | HS256 access/refresh token service with revocation. |
| `createInMemoryRevocationStore` | `(): RevocationStore` | Test/hermetic revocation store. |
| MFA helpers | `generateMfaSecret(byteLength?)`, `generateTotpCode(secret, options?)`, `verifyTotp(secret, token, options?)`, `deriveRecoveryCodes(secret, count?)`, `hashRecoveryCode(code, pepper)`, `hashRecoveryCodes(codes, pepper)`, `consumeRecoveryCode(code, pepper, storedCodes)` | RFC 6238 TOTP and recovery-code lifecycle. |
| types | `Role`, `SessionClaims`, `SessionService`, `AuthContext`, `SecurityRulesetAst`, `RuleEvaluationContext`, `AuthorizationResult`, … | Shared authorization types. |

## `@vellum/storage`

**Responsibility:** the `StorageAdapter` contract plus in-memory, PostgreSQL and Neon adapters; tenant transaction context (`TxHandle`) that binds RLS settings; prepared-SQL constants; TTL caches and the cross-instance `NOTIFY vellum_cache_invalidate` bus. This is where the tenant-isolation and zero-DDL invariants are enforced.

| Export | Signature / shape | Semantics |
| :--- | :--- | :--- |
| `createStorageAdapter` | `(options?: StorageAdapterOptions): StorageAdapter` | Selects `memory` / `pg` / `neon` driver (explicit → env → URL inference). |
| `StorageAdapter` | interface: `withTransaction<T>(ctx, cb)`, `getDocument`, `putDocument`, `listDocumentsInCollection`, `listDocumentsViaIndex`, `appendOutbox`, `createCompositeIndex`, `listCompositeIndexes`, `deleteCompositeIndex`, `queryOutboxSince`, `runIndexBuilderWorker`, `runOutboxCompactionWorker`, `runTombstonePurgeWorker`, `close` | The sole data-plane persistence seam; all methods take `TenantContext`. |
| `TenantContext` | `{ readonly projectId: string; readonly projectId: string }` | Mandatory tenant scope for every operation. |
| `DataPlaneStore`, `PgStorageAdapter`, `NeonStorageAdapter` | `class … implements StorageAdapter` | In-memory (tests), pooled PostgreSQL, Neon serverless. |
| `TxHandle` | interface: `getDocument(path, includeSoftDeleted?, forUpdate?)`, `putDocumentRow`, `appendOutboxEvent`, `createIndex`, `queryDocuments(compiled)`, optional outbox/index helpers | Tenant-bound transaction handle; RLS settings applied on creation. |
| `runInTenantTransactionAsync<T>` | `(pool: {connect(): Promise<PgClientLike>}, ctx: TenantContext, asyncCallback: (tx: TxHandle) => Promise<T>, options?: PreparedStatementOptions): Promise<T>` | Opens a raw PG client, binds tenant context, runs callback. |
| `createSqlTransactionHandle` | `(client: PgClientLike, ctx: TenantContext, options?: PreparedStatementOptions): SqlTxHandle` | Wraps a client as a tenant-bound handle. |
| `SQL_SET_STATEMENT_TIMEOUT`, `SQL_SET_PROJECT` | `const` SQL strings | `SET LOCAL statement_timeout`, `set_config('app.current_project_id'…)`. |
| Other SQL constants | `SQL_GET_INDEXES`, `SQL_INSERT_OUTBOX`, `SQL_QUERY_OUTBOX`, `SQL_CREATE_INDEX`, `SQL_LIST_DOCS_VIA_INDEX`, … | Parameterized statements for index/outbox/query paths. |
| `createTtlCache<V>` | `(options?: TtlCacheOptions): TtlCache<V>` | In-process TTL/LRU cache; `get/set/delete/clear/size/keys/stats/stop`. |
| `getNamedCache`, `invalidateApiKeyCache`, `invalidateRulesetCache`, `invalidateProjectEnvCache`, `invalidateAllCaches` | cache helpers | Named TTL caches (30–60 s) + invalidation. |
| `createCacheInvalidationBus` | `(options: CacheInvalidationBusOptions): CacheInvalidationBus` | `LISTEN/NOTIFY` bus on `vellum_cache_invalidate`; `publish()`, `close()`, `isListening()`. |
| `getCacheInvalidationBus` / `setCacheInvalidationBus` | `(): CacheInvalidationBus \| null` / `(bus): void` | Process-wide bus accessor. |
| types | `DocumentRecord`, `OutboxEvent`, `OutboxMutation`, `CompositeIndexRecord`, `CompositeIndexEntry`, `QueriedDocument`, `StorageAdapterOptions`, … | Data-plane record shapes. |

## `@vellum/query-engine`

**Responsibility:** validate/normalize queries, select a composite index, compile parameterized SQL (no string-built predicates), and encode/decode HMAC-signed opaque cursors. Enforces cursor-only pagination and query complexity limits.

| Export | Signature | Semantics |
| :--- | :--- | :--- |
| `validateAndNormalizeQuery` | `(rawQuery: Record<string, unknown>): NormalizedQuery` | Validates `where`/`orderBy`/`limit`, resolves `collectionPath` vs `collectionGroup`, bounds. |
| `compileQueryToParameterizedSql` | `({projectId, projectId, normalizedQuery, matchedCompositeIndex?, cursor?, cursorMode?}): CompiledQuery` | Emits tenant-scoped parameterized SQL. |
| `selectCompositeIndexForQuery` | `(normalizedQuery: NormalizedQuery, availableIndexes?: CompositeIndexMetadata[]): {matchedIndex, requiresCompositeIndex}` | Index selector. |
| `computeIndexDefinitionHash` | `(collectionPath: string, fields: Array<{path,dir}>): string` | SHA-256 definition hash. |
| `computeQueryShapeHash` | `({projectId, projectId, collectionPath, where, orderBy}): string` | SHA-256 of canonical query shape; bound into cursor. |
| `encodeQueryCursor` | `(payload: CursorPayload, cursorSecret?: string): string` | Base64url JSON + HMAC-SHA256 signature. |
| `decodeAndVerifyQueryCursor` | `(cursorToken: unknown, expectedQHash: string, cursorSecret?: string): CursorPayload` | Verifies signature and shape hash; throws `INVALID_CURSOR`. |
| `documentMatchesQuery`, `documentMatchesWhereClause` | `(docRecord, …): boolean` | In-memory evaluators used by the memory adapter and realtime subscription matcher. |
| `extractDocFieldValue`, `buildNestedJsonObject` | `(docRecord, fieldPath): unknown` / `(dotPath, leafValue): object` | Dotted-path field helpers. |
| types | `QuerySpec`, `WhereClause`, `OrderByClause`, `NormalizedQuery`, `CompiledQuery`, `CursorPayload`, `CursorMode`, `QueryOperator`, … | Query domain types. |

## `@vellum/document-engine`

**Responsibility:** the document business core — CRUD, atomic field transforms, batch write, structured query, and PostgreSQL-backed OCC transactions. Route handlers call this; they never implement rules/SQL/wire logic themselves.

| Export | Signature | Semantics |
| :--- | :--- | :--- |
| `DocumentEngine` | `class` — `constructor(options: DocumentEngineOptions)` | Main engine; properties `controlStore`, `dataStore`, `realtimeHub`, `cursorSecret`, `txSecret`, `transactions`. |
| — methods | `getDocument(ctx: EngineContext & {path}): Promise<PublicDocument>`; `createDocument`, `setDocument` (`merge?`, `ifVersion?`), `updateDocument` (`ifVersion?`), `deleteDocument` (`ifVersion?`) | CRUD; each takes `EngineContext` (project + apiKey/authContext). |
| — methods | `batchWrite(ctx: EngineContext & {writes: BatchMutation[]}): Promise<BatchWriteResult>` | Atomic up-to-100 mutations; validates batch size/payload, rules, outbox writes. |
| — methods | `executeQuery(ctx: EngineContext & {querySpec: QuerySpec}): Promise<QueryResult>` | Compile + authorize + cursor paginate. |
| — methods | `beginTransaction(ctx): Promise<TransactionBeginResult>`; `commitTransaction(ctx: EngineContext & {transactionToken, writes}): Promise<BatchWriteResult>`; `rollbackTransaction`, `cleanupExpiredTransactions` | OCC lifecycle; commits are DB-backed. |
| `applyFieldTransforms` | `(existingObj: Record<string,unknown>\|null\|undefined, patchObj: Record<string,unknown>, txTimestampIso: string): Record<string,unknown>` | Applies `$op` sentinels (`inc`, `arrayUnion`, `arrayRemove`, `serverTimestamp`, `deleteField`). |
| `createTransactionManager` | `(options: TransactionManagerOptions): TransactionManager` | `begin`, `recordRead`, `verifyAndLock`, `markCommitted`, `rollback`, `cleanupExpired`. |
| `decodeAndVerifyTransactionToken` | `(token: string, secret: string, ctx: TenantContext): TxTokenPayload` | Verifies signed OCC token. |
| `transactionTokenHash` | `(token: string): string` | Digest used as the DB row key. |
| `runExpiredTransactionCleanup` | `(client: {query(...)}, batchSize = 1000): Promise<number>` | Maintenance worker for stale `transactions` rows. |
| types | `BatchMutation`, `EngineContext`, `DocumentEngineOptions`, `PublicDocument`, `QueryResult`, `BatchWriteResult`, `TransactionBeginResult`, … | Engine domain types. |

## `@vellum/realtime`

**Responsibility:** PostgreSQL-native realtime — the gateway hub (frame handling, subscription registry, fan-out), the gap-detecting durable outbox poller, and the `LISTEN/NOTIFY` bus/infrastructure factory. No broker; one dedicated non-pooled LISTEN client.

| Export | Signature / shape | Semantics |
| :--- | :--- | :--- |
| `RealtimeGatewayHub` | `class` — `createConnectionSession(sendFrameCallback): ConnectionSessionHandle`; `handleClientFrame(connectionId, rawFrame)`; `notifyCommittedEvents(projectId, projectId, events)` | WebSocket multiplexer, auth, subscribe/resume, fan-out, slow-consumer guard. `MAX_REPLAY_EVENTS = 5000`. |
| `OutboxPoller` | `class` — `start()`, `stop()`, `getWatermark(projectId)`, `handleNotification(payload)`, `discoverTenants()`, `stats` | Polls outbox in 500-row batches (1 s default), detects gaps, dedupes NOTIFY vs poll. |
| `createPgNotifyBus` | `(options: PgNotifyBusOptions): PgNotifyBus` | Dedicated LISTEN connection; `publishCommittedBatch`, `subscribeTenantChannel`. |
| `createPgRealtimeInfrastructure` | `(options: PgRealtimeInfrastructureOptions): PgRealtimeInfrastructure` | Wires bus + poller + hub; requires `connectionString`. |
| `parseOutboxNotification` | `(payload: string): OutboxNotification \| null` | Parses/validates `{seqId, projectId, projectId}` payloads. |
| `PG_OUTBOX_CHANNEL` | `"vellum_outbox"` | Canonical NOTIFY channel. |
| `assertValidNotifyChannel`, `assertValidNotifyPayload`, `quoteNotifyChannel` | channel/payload validators; `(channel: string): string` | Enforce 63-byte channel / 7,999-byte payload limits. |
| types | `ConnectionSession`, `ConnectionSessionHandle`, `SubscriptionRecord`, `PubSubBus`, `PgNotifyBus`, `OutboxFanoutSink`, `RealtimeHubOptions`, `RealtimeServerFrame` | Realtime domain types (server frames come from `@vellum/api-contract`). |

## `@vellum/observability`

**Responsibility:** structured JSON logging with secret redaction, sliding-window rate limiting, and request-ID generation. Every HTTP failure passes through the logger's redaction filters — raw `pk_`/`sk_` keys, bearer JWTs and DB URLs are never logged.

| Export | Signature | Semantics |
| :--- | :--- | :--- |
| `createLogger` | `(config?: LoggerConfig): pino.Logger` | Pino-backed structured logger. |
| `StructuredLogger` | `class` — `constructor({service?, sink?}?: LoggerConfig)` | In-process logger with captured `entries`; used by the API app. |
| `redactSensitiveData` | `(input: unknown): unknown` | Recursively redacts sensitive fields/values before logging. |
| `SlidingWindowRateLimiter` | `class implements RateLimiter` — `checkAndConsume(keyPrefix: string, limitRps = 100, nowMs = Date.now()): {remaining: number}` | Per-key sliding window; used on the public document plane. |
| `generateRequestId` | `(): string` | `req_<24 hex>` identifier attached to every response and error envelope. |
| types | `LoggerConfig`, `LogEntry`, `RateLimiter` | Observability contracts. |

## Quick cross-reference

- [REST Control Plane & Console](./rest-control-plane.md) · [REST Data Plane](./rest-data-plane.md) · [Realtime Protocol](./realtime-protocol.md)
- [Wire Format & Path Grammar](./wire-format.md) · [Errors](./errors.md)
- Architecture narrative: [01 — Architecture](../../01-architecture.md)
