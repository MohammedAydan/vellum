/**
 * Retention for serverless hosts.
 *
 * `node-server.ts` runs the purge workers every 30s, but the Vercel entry has no long-lived
 * process and no cron, so on Vercel `realtime_outbox` (which stores before/after copies of every
 * written document), soft-deleted tombstones and expired TTL rows were never removed and grew
 * without bound. This module gives the Vercel entry two ways to run them:
 *   - an authenticated HTTP endpoint for Vercel Cron (or any scheduler), and
 *   - a low-frequency in-process tick while an instance is alive (Fluid compute keeps instances up under traffic).
 * Purges are batched deletes that are safe to run concurrently on several instances.
 */

import crypto from "node:crypto";

export const MAINTENANCE_PATH = "/v1/internal/maintenance";
export const MAINTENANCE_OUTBOX_BATCH = 10_000;
export const MAINTENANCE_TOMBSTONE_BATCH = 5_000;
export const MAINTENANCE_TTL_BATCH = 500;

export interface PurgeStore {
  runOutboxCompactionWorker(retentionHours?: number): Promise<{ purgedCount: number }>;
  runTombstonePurgeWorker(retentionDays?: number): Promise<{ purgedCount: number }>;
  runTtlSweeperWorker?(limit?: number): Promise<{ purgedCount: number }>;
}

export interface PurgeResult {
  outboxEventsPurged: number;
  tombstonesPurged: number;
  ttlPurged: number;
  rounds: number;
}

/** Runs the purge workers, repeating while a batch came back full, until the time budget ends. */
export async function runPurgeRounds(store: PurgeStore, budgetMs = 20_000, now: () => number = Date.now): Promise<PurgeResult> {
  const deadline = now() + budgetMs;
  const total: PurgeResult = { outboxEventsPurged: 0, tombstonesPurged: 0, ttlPurged: 0, rounds: 0 };
  for (;;) {
    total.rounds += 1;
    const outbox = await store.runOutboxCompactionWorker();
    const tombs = await store.runTombstonePurgeWorker();
    const ttl = (await store.runTtlSweeperWorker?.(MAINTENANCE_TTL_BATCH)) ?? { purgedCount: 0 };
    total.outboxEventsPurged += outbox.purgedCount;
    total.tombstonesPurged += tombs.purgedCount;
    total.ttlPurged += ttl.purgedCount;
    const more =
      outbox.purgedCount >= MAINTENANCE_OUTBOX_BATCH ||
      tombs.purgedCount >= MAINTENANCE_TOMBSTONE_BATCH ||
      ttl.purgedCount >= MAINTENANCE_TTL_BATCH;
    if (!more || now() >= deadline) return total;
  }
}

function secretMatches(provided: string, expected: string): boolean {
  const a = crypto.createHash("sha256").update(provided).digest();
  const b = crypto.createHash("sha256").update(expected).digest();
  return crypto.timingSafeEqual(a, b);
}

/**
 * Handles `GET|POST /v1/internal/maintenance`. Returns null for any other path.
 * Without CRON_SECRET configured the endpoint does not exist (404); with a wrong or
 * missing bearer token it also answers 404 so it cannot be probed.
 */
export async function handleMaintenanceRequest(
  request: Request,
  store: PurgeStore,
  env: Record<string, string | undefined> = process.env
): Promise<Response | null> {
  const url = new URL(request.url);
  if (url.pathname !== MAINTENANCE_PATH) return null;
  const notFound = () => new Response(JSON.stringify({ error: { code: "NOT_FOUND", message: "Not found" } }), {
    status: 404,
    headers: { "content-type": "application/json" },
  });
  if (request.method !== "GET" && request.method !== "POST") return notFound();
  const secret = env["CRON_SECRET"];
  if (!secret || secret.length < 16) return notFound();
  const header = request.headers.get("authorization") ?? "";
  const provided = header.startsWith("Bearer ") ? header.slice(7) : "";
  if (!provided || !secretMatches(provided, secret)) return notFound();
  const result = await runPurgeRounds(store);
  return new Response(JSON.stringify(result), { status: 200, headers: { "content-type": "application/json" } });
}

/** Starts the low-frequency in-process purge tick. Returns a stop function. */
export function startPurgeTick(
  store: PurgeStore,
  onError: (err: unknown) => void,
  intervalMs = 60_000
): () => void {
  let running = false;
  const timer = setInterval(() => {
    if (running) return;
    running = true;
    void runPurgeRounds(store, 10_000)
      .catch(onError)
      .finally(() => {
        running = false;
      });
  }, intervalMs);
  timer.unref?.();
  return () => clearInterval(timer);
}
