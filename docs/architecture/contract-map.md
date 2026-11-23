# 2 — `docs/architecture/contract-map.md`

## 2.1 Complete Port & Contract Registry

| Domain / Package | Contract File (`src/contracts/`) | Port Interfaces / Types | Concrete Adapters (Composition Root Only) | 
| ----- | ----- | ----- | ----- | 
| `@vellum/core` | `src/contracts/branded-ids.ts` (exists), `src/contracts/cache-policy.ts` (exists), `src/contracts/json.ts` (**create**) | `ProjectId`, `OrganizationId`, `UserId`, `DocumentId`, `ApiKeyId`, `IndexId`, `TransactionId`, `SessionId`, `BoundedCachePolicy`, `JsonPrimitive`, `JsonArray`, `JsonObject`, `JsonValue` | Pure value types / constructors | 
| `@vellum/database-control` | `src/contracts/control-port.ts` (exists — tighten methods) | `ControlPlanePort`, `SecurityRepositoryPort`, `BillingRepositoryPort`, `ReadinessProbePort` | `ControlPlaneStore` (`./adapters`), `PgControlPlaneStore` (`./adapters`), `SecurityRepository`, `BillingRepository` | 
| `@vellum/storage` | `src/contracts/storage-port.ts` (exists — tighten methods) | `StorageAdapterPort`, `TxHandlePort`, `OutboxPort`, `BoundedCachePort`, `CacheInvalidationBusPort` | `DataPlaneStore` (`./adapters`), `PgStorageAdapter` (`./adapters`), `NeonStorageAdapter` (`./adapters`) | 
| `@vellum/auth` | `src/contracts/auth-port.ts` (**create**) | `EndUserJwtPort`, `RealmSessionPort`, `MfaServicePort`, `SessionServicePort`, `MailerPort` | `Ed25519JwtService`, `RealmSessionManager`, `MfaService`, `SessionService`, `SmtpMailer` | 
| `@vellum/authorization` | `src/contracts/authorization-port.ts` (**create**) | `ApiKeyVerifierPort`, `RulesEvaluatorPort`, `RevocationStorePort` | `ApiKeyService`, `RulesAstEvaluator`, `InMemoryRevocationStore` | 
| `@vellum/billing` | `src/contracts/billing-port.ts` (**create**) | `MeteringPort`, `QuotaGuardPort`, `InvoiceGeneratorPort`, `WebhookVerifierPort` | `MeteringEngine`, `QuotaGuard`, `BillingCalculator` (DI instance, removing mutable `configuredGenerator`) | 
| `@vellum/realtime` | `src/contracts/realtime-port.ts` (**create**) | `RealtimePubSubPort`, `OutboxPollerPort`, `RealtimeGatewayPort` | `PgNotifyPubSub`, `OutboxPoller`, `RealtimeGatewayHub` | 
| `@vellum/document-engine` | `src/contracts/engine-port.ts` (**create**) | `DocumentEnginePort` | `DocumentEngine` | 
| `@vellum/observability` | `src/contracts/observability-port.ts` (**create**) | `LoggerPort`, `RateLimiterPort` | `StructuredLogger`, `SlidingWindowRateLimiter` | 
| `@vellum/sdk-js` | `src/contracts/sdk-ports.ts` (**create**) | `HttpTransportPort`, `AuthStoragePort`, `RealtimeTransportPort`, `ReadCachePort` | `HttpTransport`, `BrowserAuthStorage`/`MemoryAuthStorage`, `RealtimeTransport`, `ReadCache` | 
| `apps/api` | `src/composition/root.ts` (exists — enforce as sole root) | `ApiContainer` (`singleton` | `request-scoped` | `transient`) | Wires all concrete adapters; `apps/api/src/index.ts` & `routes/health.ts` depend only on `ApiContainer` ports | 
| `apps/dashboard` / `apps/admin` | `src/composition/root.ts` (**create** per app) | `DashboardApiPort`, `AdminApiPort` | Single typed HTTP adapter (`src/lib/api.ts`), zero raw `fetch()` in routes | 
| `sdks/flutter` | `lib/src/contracts/ports.dart` (exists — align to `JsonMap`), `lib/di.dart` (**create**) | `JsonMap`, `VellumResult<T, E>`, `VellumClientPort`, `VellumAuthPort`, `VellumRealtimePort`, `TokenStoragePort`, `HttpClientPort` | `VellumClient`, `VellumAuthClient`, `VellumRealtimeManager`, `MemoryTokenStorage` | 

## 2.2 Pure-Utility Barrels (No Concrete Adapters, Direct Barrel Import Allowed)

* `@vellum/core` (`packages/core/src/index.ts`)

* `@vellum/api-contract` (`packages/api-contract/src/index.ts`)

* `@vellum/security` (`packages/security/src/index.ts`)

* `@vellum/query-engine` (`packages/query-engine/src/index.ts`)

* `@vellum/ui` (`packages/ui/src/index.ts`)

## 2.3 Verified Dart Public Barrel Path

* **Canonical Barrel:** `sdks/flutter/lib/vellum_flutter.dart` (`package:vellum_flutter/vellum_flutter.dart`), enclosing 14 `part` files under `sdks/flutter/lib/src/{core,models,auth,realtime,client,contracts}/`.

* **Composition Root (to create in Checkpoint 9):** `sdks/flutter/lib/di.dart` (`package:vellum_flutter/di.dart`).

## 2.4 Allowed Bounded-Cache Registry (Governed by `BoundedCachePolicy`)

| Cache Name | File & Line | Max Entries | TTL / Eviction | Status | 
| ----- | ----- | ----- | ----- | ----- | 
| `DOC_PATH_CACHE`, `COL_PATH_CACHE` | `packages/core/src/paths.ts:L26-L45` | 4,096 each | FIFO/LRU | Verified bounded | 
| `FIELD_PATH_CACHE` | `packages/core/src/sort-key.ts:L53-L54` | 4,096 | FIFO/LRU | Verified bounded | 
| `DERIVED_KEY_CACHE` | `packages/auth/src/crypto/encrypt.ts:L22-L42` | 16 | FIFO/LRU | Verified bounded | 
| `PUBKEY_CACHE` | `packages/auth/src/crypto/jwt.ts:L16-L40` | 256 | FIFO/LRU | Verified bounded | 
| `VERIFIED_KEY_CACHE` | `packages/authorization/src/api-keys.ts:L91-L92` | `VERIFIED_CACHE_MAX_ENTRIES` | 30s TTL + eviction | Verified bounded | 
| `JWKS_CACHE` | `packages/authorization/src/jwt.ts:L44,L61-L65` | `JWKS_CACHE_MAX` | LRU + TTL | Verified bounded | 
| `PATTERN_CACHE` | `packages/authorization/src/rules-ast.ts:L33-L34` | 4,096 | FIFO/LRU | Verified bounded | 
| `namedCaches` (`TtlCache`) | `packages/storage/src/cache.ts:L276-L286` | 4,096 per kind (3 kinds) | 30s–60s TTL + PG `NOTIFY` | Verified bounded | 
| `indexDefHashCache`, `splitPathCache` | `packages/query-engine/src/compiler.ts:L78-L97` | 512 each | LRU | Verified bounded | 
| `internalApiKeyCache` | `packages/document-engine/src/engine.ts:L109-L113` | 1,000 | FIFO | Verified bounded | 
| `parsedPathCache` | `packages/document-engine/src/path-utils.ts:L26-L32` | 2,048 | FIFO | Verified bounded | 
| `memoryTransactions` (test/memory only) | `packages/document-engine/src/transactions.ts:L69-L81` | 10,000 | Eviction | Verified bounded | 
| `ReadCache` | `packages/sdk-js/src/cache/read-cache.ts:L14-L153` | 1,000 (default) | 30s TTL + O(1) LRU | Verified bounded | 

*(Unbounded or process-global mutable maps in `apps/api` — `buckets`, `pgMembershipCache`, `operatorPasswords`, `inMemoryPasswords`, `mfaFailureCounts`, `projectIndexCache` — and `seenIndexFingerprints` in `packages/sdk-js/src/core/http-transport.ts:L29` will be migrated to instance-scoped `BoundedCachePolicy` containers in Checkpoints 6–8.)*
