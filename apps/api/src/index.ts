/**
 * @vellum/api - Public HTTP REST & Realtime API Router
 */

import { adminRuntimeTelemetry } from "./admin-runtime-telemetry.js";
import type { PgRealtimeInfrastructure } from "@vellum/realtime";
import { createPostgresAdapters } from "./composition/root.js";
import { getConfig } from "./config.js";
import { createVellumPlatform } from "./platform.js";
export { createVellumPlatform, type CreatePlatformOptions } from "./platform.js";
import {
  flushOnShutdown,
  startControlMaintenance,
  stopControlMaintenance,
} from "./workers/control-maintenance.js";


const PROCESS_HANDLERS_INSTALLED = Symbol.for("vellum.api.processErrorHandlers");
const SHUTDOWN_STEP_TIMEOUT_MS = 5_000;

/** Run an async shutdown step with a bounded timeout so one stalled dependency cannot block others. */
async function runBoundedShutdownStep(
  label: string,
  fn: () => Promise<unknown>,
  timeoutMs: number = SHUTDOWN_STEP_TIMEOUT_MS
): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      fn(),
      new Promise<void>((resolve) => {
        timer = setTimeout(() => {
          process.stderr.write(`[vellum-api] shutdown step '${label}' timed out after ${timeoutMs}ms\n`);
          resolve();
        }, timeoutMs);
        timer.unref?.();
      }),
    ]);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`[vellum-api] shutdown step '${label}' failed: ${message.slice(0, 256)}\n`);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * catch unhandled rejections at the process boundary so a rejected
 * background task cannot crash the server silently. Logged via stderr with no
 * request/header data (secret hygiene).
 */
export function installProcessErrorHandlers(): void {
  if (Reflect.get(globalThis, PROCESS_HANDLERS_INSTALLED) === true) return;
  Reflect.set(globalThis, PROCESS_HANDLERS_INSTALLED, true);

  process.on("unhandledRejection", (reason: unknown) => {
    const message =
      reason instanceof Error ? reason.message : typeof reason === "string" ? reason : "unknown rejection";
    process.stderr.write(`[vellum-api] unhandled rejection: ${message.slice(0, 512)}\n`);
  });
}

export * from "./app.js";
export * from "./auth/config.js";
export {
  createApiCompositionRoot,
  createMemoryAdapters,
  createPostgresAdapters,
  createReadinessProbe,
  defaultReadinessProbe,
  type ApiCompositionRoot,
  type ApiCompositionRootInput,
  type ApiContainer,
  type ReadinessProbeOptions,
  type ReadinessProbePort,
} from "./composition/root.js";

/** Durable config-driven platform factory. Memory mode remains explicit for tests/offline use. */
export async function createVellumPlatformFromEnv() {
  installProcessErrorHandlers();

  const mode = process.env["DATABASE_MODE"] ?? "memory";
  if (mode === "memory") return createVellumPlatform();
  if (mode !== "postgres") throw new Error(`Unsupported DATABASE_MODE '${mode}'`);

  const controlUrl = process.env["CONTROL_DATABASE_URL"];
  const dataUrl = process.env["DATA_DATABASE_URL"];
  if (!controlUrl || !dataUrl) {
    throw new Error("DATABASE_MODE=postgres requires CONTROL_DATABASE_URL and DATA_DATABASE_URL");
  }

  // resolve every secret from validated configuration. Never fall back
  // to a shared default in postgres (production) mode.
  const config = getConfig();
  const jwtSecret = process.env["JWT_SECRET"] ?? config.SESSION_COOKIE_SECRET ?? config.BETTER_AUTH_SECRET;
  const txSecret = process.env["TX_HMAC_SECRET"] ?? config.CURSOR_HMAC_SECRET;

  // Migrations run as the owner; runtime uses the non-superuser `vellum_app` role
  // when the dedicated URLs are configured (RLS FORCE is enforced there).
  const controlRuntimeUrl = process.env["CONTROL_DATABASE_APP_URL"] ?? controlUrl;
  const dataRuntimeUrl = process.env["DATA_DATABASE_APP_URL"] ?? dataUrl;
  const adapters = await createPostgresAdapters({
    controlConnectionString: controlRuntimeUrl,
    dataConnectionString: dataRuntimeUrl,
    controlDriver: config.CONTROL_DATABASE_DRIVER,
    storageDriver: config.DATA_DATABASE_DRIVER,
  });

  const platform = createVellumPlatform({
    controlStore: adapters.controlStore,
    dataStore: adapters.dataStore,
    jwtSecret,
    cursorSecret: config.CURSOR_HMAC_SECRET,
    txSecret,
    apiKeyPepper: config.API_KEY_PEPPER,
    ...(config.CONSOLE_JWT_SECRET ? { consoleJwtSecret: config.CONSOLE_JWT_SECRET } : {}),
    ...(config.SUPER_ADMIN_JWT_SECRET
      ? { superAdminJwtSecret: config.SUPER_ADMIN_JWT_SECRET }
      : {}),
    corsOrigins: config.CORS_ALLOWED_ORIGINS.split(",")
      .map((origin) => origin.trim())
      .filter(Boolean),
  });

  // cross-instance cache invalidation over PostgreSQL NOTIFY only.
  const cacheBus = adapters.startCacheInvalidation();

  // durable metering flush + mirrored metadata refresh.
  startControlMaintenance(adapters.controlStore);

  // PostgreSQL-only realtime. Neon's -pooler host cannot carry
  // LISTEN; prefer a dedicated session-mode endpoint and degrade to outbox
  // polling if it is unreachable.
  const listenUrl =
    process.env["DATA_DATABASE_URL_LISTEN"] ??
    config.DATA_DATABASE_URL_LISTEN ??
    dataRuntimeUrl.replace("-pooler.", ".");
  let realtimeInfra: PgRealtimeInfrastructure | null = null;
  try {
    realtimeInfra = await adapters.startRealtime(listenUrl, platform.realtimeHub);
    adminRuntimeTelemetry.realtimeConnected = true;
    adminRuntimeTelemetry.realtimeChannel = "vellum_outbox";
  } catch (err) {
    platform.logger.warn("Realtime LISTEN/NOTIFY unavailable; using durable outbox polling fallback", {
      reason: err instanceof Error ? err.message : String(err),
    });
    realtimeInfra = null;
    adminRuntimeTelemetry.realtimeConnected = false;
  }

  let stopping = false;
  const stop = async (): Promise<void> => {
    if (stopping) return;
    stopping = true;
    stopControlMaintenance();
    adapters.stopCacheInvalidation();

    // Isolate every shutdown step with a bounded timeout so a single hung
    // dependency never prevents flushing telemetry or closing DB pools.
    await runBoundedShutdownStep("cacheBus.close", () => cacheBus.close());
    await runBoundedShutdownStep("controlMaintenance.flush", () =>
      flushOnShutdown(adapters.controlStore)
    );
    await runBoundedShutdownStep("metering.stop", () => platform.metering.stop());
    await runBoundedShutdownStep("platformUsage.stop", () => platform.platformUsage.stop());
    await runBoundedShutdownStep("indexRecommendations.flush", () =>
      platform.flushIndexRecommendations()
    );
    if (realtimeInfra) {
      const infra = realtimeInfra;
      await runBoundedShutdownStep("realtimeInfra.stop", () => infra.stop());
    }
    await runBoundedShutdownStep("dataStore.close", () => adapters.closeDataStore());
    await runBoundedShutdownStep("controlStore.close", () => adapters.closeControlStore());
  };
  // Signal handling belongs to the delivery adapter (node-server.ts): it must
  // close the HTTP listener BEFORE stopping the platform. Closing the data pool
  // first leaves a still-listening server that answers with "Cannot use a pool
  // after calling end on the pool" during a rolling restart. Libraries/tests
  // that embed this factory call `stop()` explicitly instead.

  return { ...platform, realtimeInfra, stop };
}
