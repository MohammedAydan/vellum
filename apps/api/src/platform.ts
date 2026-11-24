/**
 * @vellum/api - Runtime-agnostic platform factory.
 *
 * Contains no `node:fs` / dotenv imports so the exact same assembly can be
 * used by the Node server, Vercel Functions and Cloudflare Workers. Environment
 * loading remains the responsibility of the delivery adapter.
 */

import type { ControlPlaneRepository } from "@vellum/database-control";
import type { StorageAdapter } from "@vellum/storage";
import { DocumentEngine } from "@vellum/document-engine";
import { RealtimeGatewayHub } from "@vellum/realtime";
import { StructuredLogger, SlidingWindowRateLimiter } from "@vellum/observability";
import {
  createInMemoryRevocationStore,
  getDefaultPepper,
  type SessionService,
} from "@vellum/authorization";
import { createRealmSessionService, realmConfig } from "@vellum/auth";
import { createPgRevocationStore } from "@vellum/database-control/adapters";
import { createMemoryAdapters } from "./composition/root.js";
import { createVellumApp, type VellumPlatformContext } from "./app.js";
import { createPlatformIndexRecommendationRecorder } from "./routes/v2.js";
import { createFortressServices } from "./middleware/fortress.js";

export interface CreatePlatformOptions {
  controlStore?: ControlPlaneRepository;
  dataStore?: StorageAdapter;
  logger?: StructuredLogger;
  rateLimiter?: SlidingWindowRateLimiter;
  jwtSecret?: string;
  /** HMAC secret for query cursors (wired from CURSOR_HMAC_SECRET in env mode). */
  cursorSecret?: string;
  /** HMAC secret for OCC transaction tokens. */
  txSecret?: string;
  /** HMAC pepper for API key digests (wired from API_KEY_PEPPER in env mode). */
  apiKeyPepper?: string;
  /** Shared session service. Defaults to one bound to `jwtSecret`. */
  sessionService?: SessionService;
  /** Realm-bound Customer Console session service (HS256). */
  consoleSessionService?: SessionService;
  /** Realm-bound Platform Super Admin session service (HS256). */
  superAdminSessionService?: SessionService;
  /** Secret for the Customer Console realm (falls back to JWT_SECRET). */
  consoleJwtSecret?: string;
  /** Secret for the Platform Super Admin realm (falls back to JWT_SECRET). */
  superAdminJwtSecret?: string;
  /** Explicit CORS allowlist. */
  corsOrigins?: string[];
}

export function createVellumPlatform({
  controlStore,
  dataStore,
  logger = new StructuredLogger({ service: "@vellum/api" }),
  rateLimiter = new SlidingWindowRateLimiter(),
  jwtSecret = process.env["JWT_SECRET"] ?? "vellum_jwt_secret_v1",
  cursorSecret = process.env["CURSOR_HMAC_SECRET"] ?? "vellum_cursor_secret_v1",
  txSecret = process.env["TX_HMAC_SECRET"] ?? "vellum_tx_secret_v1",
  apiKeyPepper = getDefaultPepper(),
  sessionService,
  consoleSessionService,
  superAdminSessionService,
  consoleJwtSecret,
  superAdminJwtSecret,
  corsOrigins,
}: CreatePlatformOptions = {}) {
  const defaultAdapters =
    controlStore === undefined || dataStore === undefined ? createMemoryAdapters() : null;
  const activeControlStore = controlStore ?? defaultAdapters!.controlStore;
  const activeDataStore = dataStore ?? defaultAdapters!.dataStore;

  // Production requires realm secrets to be supplied explicitly (or explicit
  // pre-built services). Never print their values — only field names.
  if (process.env["NODE_ENV"] === "production") {
    const consoleConfigured =
      consoleSessionService ?? consoleJwtSecret ?? process.env["CONSOLE_JWT_SECRET"];
    const superAdminConfigured =
      superAdminSessionService ?? superAdminJwtSecret ?? process.env["SUPER_ADMIN_JWT_SECRET"];
    if (!consoleConfigured || !superAdminConfigured) {
      throw new Error(
        `[CONFIGURATION ERROR] Production requires distinct CONSOLE_JWT_SECRET ` +
          `(${realmConfig("customer_console").realm}) and SUPER_ADMIN_JWT_SECRET ` +
          `(${realmConfig("super_admin").realm}) ` +
          "(or explicit consoleSessionService / superAdminSessionService options)."
      );
    }
  }

  const activeConsoleSecret =
    consoleJwtSecret ?? process.env["CONSOLE_JWT_SECRET"] ?? process.env["JWT_SECRET"] ?? "vellum_jwt_secret_v1";
  const activeSuperAdminSecret =
    superAdminJwtSecret ??
    process.env["SUPER_ADMIN_JWT_SECRET"] ??
    process.env["JWT_SECRET"] ??
    "vellum_jwt_secret_v1";

  // createRealmSessionService applies the locked typ/iss/aud for each realm to
  // every token it signs and verifies (SECURITY-HARDENING-CONTRACT §4).
  // Revocations live in PostgreSQL whenever the control store has a SQL pool, so a sign-out
  // is seen by every API instance. The in-memory store is only for offline/test adapters.
  const revocationPool = (activeControlStore as { pool?: { query: unknown } }).pool;
  const revocationStoreFor = (realm: string) =>
    revocationPool && typeof revocationPool.query === "function"
      ? createPgRevocationStore(revocationPool as Parameters<typeof createPgRevocationStore>[0], realm)
      : createInMemoryRevocationStore();

  const activeConsoleSessionService =
    consoleSessionService ??
    sessionService ??
    createRealmSessionService({
      realm: "customer_console",
      secret: activeConsoleSecret,
      revocationStore: revocationStoreFor("customer_console"),
    });
  const activeSuperAdminSessionService =
    superAdminSessionService ??
    createRealmSessionService({
      realm: "super_admin",
      secret: activeSuperAdminSecret,
      revocationStore: revocationStoreFor("super_admin"),
    });

  const realtimeHub = new RealtimeGatewayHub({
    apiKeyPepper,
    controlStore: activeControlStore,
    dataStore: activeDataStore,
    jwtSecret,
  });

  // Fortress services are built before the engine so its optional collection
  // lifecycle hooks reuse the SAME O(1) metering engine and the tamper-evident
  // control-plane audit sink — no second stateful service (Zero-Redis doctrine).
  const fortress = createFortressServices({ controlStore: activeControlStore, logger });
  const documentEngine = new DocumentEngine({
    controlStore: activeControlStore,
    dataStore: activeDataStore,
    realtimeHub,
    cursorSecret,
    txSecret,
    // Metering is wired here so the engine's O(1) counters stay authoritative.
    // Audit is intentionally NOT wired globally: both the public (API-key) and
    // console (session) route handlers already emit one USER-ATTRIBUTED entry
    // per mutation; a global "system" hook would double-count every action.
    metering: fortress.metering,
  });

  // Built once and shared with the app: buffered index recommendations are
  // flushed on shutdown via the returned `flushIndexRecommendations()`.
  const indexRecommendationRecorder = createPlatformIndexRecommendationRecorder(
    activeControlStore,
    logger
  );

  const context: VellumPlatformContext = {
    controlStore: activeControlStore,
    dataStore: activeDataStore,
    realtimeHub,
    documentEngine,
    logger,
    indexRecommendationRecorder,
    rateLimiter,
    jwtSecret,
    sessionService: activeConsoleSessionService,
    consoleSessionService: activeConsoleSessionService,
    superAdminSessionService: activeSuperAdminSessionService,
    apiKeyPepper,
    ...(corsOrigins ? { corsOrigins } : {}),
    threatDetector: fortress.threatDetector,
    metering: fortress.metering,
    quota: fortress.quota,
    chainKeys: fortress.chainKeys,
  };

  const app = createVellumApp(context);

  async function runMaintenanceWorkers({
    tombstoneCutoffMs,
  }: {
    outboxCutoffMs?: number;
    tombstoneCutoffMs?: number;
  } = {}): Promise<{
    indexesBuilt: number;
    outboxEventsPurged: number;
    tombstonesPurged: number;
    ttlPurged: number;
  }> {
    const indexResult = await activeDataStore.runIndexBuilderWorker();
    const outboxResult = await activeDataStore.runOutboxCompactionWorker();
    const tombstoneResult = await activeDataStore.runTombstonePurgeWorker(tombstoneCutoffMs);
    // V2 Document TTL: expired live rows are purged in bounded 500-row batches
    // from a dedicated maintenance tick (never from the request path).
    const ttlResult = (await activeDataStore.runTtlSweeperWorker?.(500)) ?? { purgedCount: 0 };
    return {
      indexesBuilt: indexResult.builtCount,
      outboxEventsPurged: outboxResult.purgedCount,
      tombstonesPurged: tombstoneResult.purgedCount,
      ttlPurged: ttlResult.purgedCount,
    };
  }

  return {
    controlStore: activeControlStore,
    dataStore: activeDataStore,
    documentEngine,
    realtimeHub,
    logger,
    rateLimiter,
    sessionService: activeConsoleSessionService,
    consoleSessionService: activeConsoleSessionService,
    superAdminSessionService: activeSuperAdminSessionService,
    app,
    fetch: (request: Request) => app.fetch(request),
    runMaintenanceWorkers,
    /** Durable shutdown hook for buffered index telemetry. */
    flushIndexRecommendations: () => indexRecommendationRecorder.flush(),
    threatDetector: fortress.threatDetector,
    metering: fortress.metering,
    quota: fortress.quota,
    chainKeys: fortress.chainKeys,
  };
}


