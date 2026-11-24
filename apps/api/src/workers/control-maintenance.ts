/**
 * @vellum/api - Control Plane maintenance worker (`apps/api/src/workers/control-maintenance.ts`)
 *
 * the `PgControlPlaneStore` mirrors control-plane metadata in a read cache.
 * This worker owns the two periodic jobs that keep that cache fresh and the
 * write-behind timestamps durable:
 *
 *   - `flush()`  every 5 seconds  → writes dirty `api_keys.last_used_at`
 *     timestamps to PostgreSQL and prunes expired auth-throttle rows. Usage
 *     metering is written on every call; there is no buffered delta to flush.
 *   - `refresh()` every 30 seconds → re-hydrates the read cache so metadata
 *     written by another API instance becomes visible.
 *
 * IMPORTANT: this module deliberately does NOT import `apps/api/src/index.ts`
 * and does not install itself. The orchestrator owns process boot/shutdown and
 * must call `startControlMaintenance(controlStore)` plus register
 * `flushOnShutdown()` on SIGTERM/SIGINT. Persistence is PostgreSQL only.
 */

/** Structural contract: both methods already exist on `PgControlPlaneStore`. */
export interface ControlMaintenanceStore {
  flush(): Promise<void>;
  refresh(): Promise<void>;
}

export interface ControlMaintenanceOptions {
  /** Defaults to 5000ms — the locked metering flush cadence. */
  flushIntervalMs?: number;
  /** Defaults to 30000ms — the control-plane mirror refresh cadence. */
  refreshIntervalMs?: number;
  /** Optional observer for background failures (must never throw). */
  onError?: (phase: "flush" | "refresh", error: unknown) => void;
}

interface ActiveMaintenance {
  store: ControlMaintenanceStore;
  flushTimer: ReturnType<typeof setInterval>;
  refreshTimer: ReturnType<typeof setInterval>;
  onError: (phase: "flush" | "refresh", error: unknown) => void;
}

type ErrorReporter = (phase: "flush" | "refresh", error: unknown) => void;

const DEFAULT_FLUSH_INTERVAL_MS = 5_000;
const DEFAULT_REFRESH_INTERVAL_MS = 30_000;

let active: ActiveMaintenance | null = null;

/** Default reporter writes a short, secret-free message to stderr. */
function defaultReportError(phase: "flush" | "refresh", error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`[vellum-api] control maintenance ${phase} failed: ${message.slice(0, 512)}\n`);
}

/** Prevent an async background job from producing an unhandled rejection. */
function reportError(phase: "flush" | "refresh", error: unknown, onError: ErrorReporter): void {
  try {
    onError(phase, error);
  } catch {
    // A broken observer must not crash the process either.
  }
}

/**
 * Start the periodic flush/refresh jobs. Calling this twice stops and replaces
 * the previous schedule (idempotent re-entry). Returns a disposer that is
 * equivalent to `stopControlMaintenance()`.
 */
export function startControlMaintenance(
  controlStore: ControlMaintenanceStore,
  options: ControlMaintenanceOptions = {}
): () => void {
  stopControlMaintenance();

  const flushIntervalMs = options.flushIntervalMs ?? DEFAULT_FLUSH_INTERVAL_MS;
  const refreshIntervalMs = options.refreshIntervalMs ?? DEFAULT_REFRESH_INTERVAL_MS;
  const onError: ErrorReporter = options.onError ?? defaultReportError;

  const flushTimer = setInterval(() => {
    void controlStore.flush().catch((err: unknown) => reportError("flush", err, onError));
  }, flushIntervalMs);

  const refreshTimer = setInterval(() => {
    void controlStore.refresh().catch((err: unknown) => reportError("refresh", err, onError));
  }, refreshIntervalMs);

  // A maintenance timer must not, by itself, keep a test runner or a shutting
  // down process alive. The HTTP server holds the event loop open in production.
  flushTimer.unref?.();
  refreshTimer.unref?.();

  active = { store: controlStore, flushTimer, refreshTimer, onError };

  return stopControlMaintenance;
}

/** Clear both timers. Does not flush; call `flushOnShutdown()` for that. */
export function stopControlMaintenance(): void {
  if (!active) return;
  clearInterval(active.flushTimer);
  clearInterval(active.refreshTimer);
  active = null;
}

/**
 * Flush every pending metering delta. Intended for SIGTERM/SIGINT/`beforeExit`.
 * An explicit store may be supplied for shutdown paths that run after
 * `stopControlMaintenance()` has cleared the active schedule.
 */
export async function flushOnShutdown(store?: ControlMaintenanceStore): Promise<void> {
  const target = store ?? active?.store;
  if (!target) return;
  await target.flush();
}

/** Test/observability helper. */
export function isControlMaintenanceRunning(): boolean {
  return active !== null;
}
