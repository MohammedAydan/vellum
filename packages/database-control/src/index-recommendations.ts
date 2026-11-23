/**
 * `packages/database-control/src/index-recommendations.ts`
 *
 * Standalone, non-blocking recorder for V2 index recommendations (§2.8 of
 * `docs/V2-ENGINE-CONTRACT.md`). It lives in the control plane and never
 * touches customer documents.
 *
 * `record()` never throws into the caller and never awaits I/O: it deduplicates
 * by fingerprint in a bounded in-memory buffer and flushes via a single
 * parameterized UNNEST upsert at most once every `flushIntervalMs` (5s by
 * default). Failed flushes keep the buffer for retry. All timers are unref'd so
 * a pending flush can never keep the process alive.
 *
 * The parent integration pass owns wiring this into the app / control store;
 * this module mounts nothing on its own.
 */

import crypto from "node:crypto";
import pg from "pg";
import { redactConnectionString } from "./env-file.js";

/** Direction of a recommended composite index field. */
export type IndexRecommendationFieldDirection = "asc" | "desc";

/** Lifecycle of a recommendation row. */
export type IndexRecommendationStatus = "pending" | "applied" | "dismissed";

/** Public row shape returned by `list()`. */
export interface IndexRecommendationRecord {
  id: string;
  projectId: string;
  fingerprint: string;
  collectionPath: string;
  recommendedFields: Array<{ path: string; dir: IndexRecommendationFieldDirection }>;
  sampleQuery: unknown;
  reason: string;
  hitCount: number;
  totalDurationMs: number;
  maxDurationMs: number;
  status: IndexRecommendationStatus;
  lastSeenAt: string;
  createdAt: string;
}

/** Input accepted by `record()`. */
export interface RecordIndexRecommendationInput {
  projectId: string;
  fingerprint: string;
  collectionPath: string;
  recommendedFields: Array<{ path: string; dir: IndexRecommendationFieldDirection }>;
  sampleQuery: unknown;
  reason: string;
  durationMs: number;
  /** Accepted for parity with the control-plane repository signature. */
  dashboardBaseUrl?: string;
  /** Accepted for parity with the control-plane repository signature. */
  orgId?: string;
}

/** Minimal structural pool contract (a `pg.Pool` satisfies it). */
export interface IndexRecommendationQueryPool {
  query(text: string, params?: unknown[]): Promise<{ rows: unknown[] }>;
}

/** Optional structured logger; no secrets are ever passed to it. */
export interface IndexRecommendationLogger {
  warn?(message: string, context?: Record<string, unknown>): void;
}

export interface IndexRecommendationRecorderOptions {
  connectionString?: string;
  pool?: IndexRecommendationQueryPool;
  logger?: IndexRecommendationLogger;
  /** Minimum gap between two flushes of the same fingerprint. Default 5000ms. */
  flushIntervalMs?: number;
  /** Injectable clock for deterministic tests. */
  now?: () => number;
}

export interface IndexRecommendationRecorder {
  record(input: RecordIndexRecommendationInput): void;
  list(projectId: string): Promise<IndexRecommendationRecord[]>;
  setStatus(id: string, status: IndexRecommendationStatus | string): Promise<void>;
  flush(): Promise<void>;
  close(): Promise<void>;
  /** Marks all recommendations for a project fingerprint as applied (index created). */
  markAppliedByFingerprint(projectId: string, fingerprint: string): Promise<void>;
}

interface PendingRecommendation {
  id: string;
  projectId: string;
  fingerprint: string;
  collectionPath: string;
  recommendedFields: Array<{ path: string; dir: IndexRecommendationFieldDirection }>;
  sampleQuery: unknown;
  reason: string;
  hitCount: number;
  totalDurationMs: number;
  maxDurationMs: number;
  lastSeenAtMs: number;
}

const DEFAULT_FLUSH_INTERVAL_MS = 5_000;
const MAX_PENDING_ENTRIES = 2_000;
const MAX_TRACKED_FLUSHED = 4_000;
const MAX_RECOMMENDED_FIELDS = 64;
const MAX_REASON_LENGTH = 1_024;
const MAX_IDENTIFIER_LENGTH = 512;
const VALID_STATUSES = new Set<string>(["pending", "applied", "dismissed"]);
const FORBIDDEN_KEYS = new Set(["__proto__", "constructor", "prototype"]);

function iso(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "string") return value;
  return new Date(0).toISOString();
}

function stripDangerousKeys(value: unknown, depth = 0): unknown {
  if (depth > 16 || value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) {
    return value.map((item) => stripDangerousKeys(item, depth + 1));
  }
  const clean: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (FORBIDDEN_KEYS.has(key)) continue;
    clean[key] = stripDangerousKeys(entry, depth + 1);
  }
  return clean;
}

function parseJsonb(value: unknown): unknown {
  if (typeof value === "string") {
    try {
      return stripDangerousKeys(JSON.parse(value) as unknown);
    } catch {
      return null;
    }
  }
  return value === undefined ? null : stripDangerousKeys(value);
}

function safeJsonStringify(value: unknown): string {
  try {
    return JSON.stringify(stripDangerousKeys(value ?? null)) ?? "null";
  } catch {
    return "null";
  }
}

function setBoundedMap<K, V>(map: Map<K, V>, key: K, value: V, maxEntries: number): void {
  if (map.has(key)) {
    map.delete(key);
  } else if (map.size >= maxEntries) {
    const oldest = map.keys().next();
    if (!oldest.done) map.delete(oldest.value);
  }
  map.set(key, value);
}

function normalizeFields(value: unknown): Array<{ path: string; dir: IndexRecommendationFieldDirection }> {
  const parsed = parseJsonb(value);
  if (!Array.isArray(parsed)) return [];
  const out: Array<{ path: string; dir: IndexRecommendationFieldDirection }> = [];
  for (const item of parsed) {
    if (out.length >= MAX_RECOMMENDED_FIELDS) break;
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const field = item as Record<string, unknown>;
    if (typeof field["path"] !== "string" || field["path"].length === 0) continue;
    out.push({
      path: field["path"].slice(0, MAX_IDENTIFIER_LENGTH),
      dir: field["dir"] === "desc" ? "desc" : "asc",
    });
  }
  return out;
}

function mapRow(row: Record<string, unknown>): IndexRecommendationRecord {
  const status = typeof row["status"] === "string" ? row["status"] : "pending";
  return {
    id: String(row["id"] ?? ""),
    projectId: String(row["projectId"] ?? ""),
    fingerprint: String(row["fingerprint"] ?? ""),
    collectionPath: String(row["collectionPath"] ?? ""),
    recommendedFields: normalizeFields(row["recommendedFields"]),
    sampleQuery: parseJsonb(row["sampleQuery"]),
    reason: typeof row["reason"] === "string" ? row["reason"] : "",
    hitCount: Number(row["hitCount"] ?? 0),
    totalDurationMs: Number(row["totalDurationMs"] ?? 0),
    maxDurationMs: Number(row["maxDurationMs"] ?? 0),
    status:
      status === "applied" || status === "dismissed" || status === "pending"
        ? status
        : "pending",
    lastSeenAt: iso(row["lastSeenAt"]),
    createdAt: iso(row["createdAt"]),
  };
}

/**
 * Creates a recommendation recorder. Supply a pool to share an existing
 * control-db connection; otherwise one is created from `connectionString` /
 * `CONTROL_DATABASE_URL` and owned (and closed) by the recorder.
 */
export function createIndexRecommendationRecorder(
  options: IndexRecommendationRecorderOptions = {}
): IndexRecommendationRecorder {
  let pool: IndexRecommendationQueryPool;
  const ownsPool = options.pool === undefined;
  if (options.pool) {
    pool = options.pool;
  } else {
    const configuredConnStr = options.connectionString ?? process.env["CONTROL_DATABASE_URL"];
    if (!configuredConnStr && process.env["NODE_ENV"] === "production") {
      throw new Error("CONTROL_DATABASE_URL must be configured in production");
    }
    const ownedPool = new pg.Pool({
      connectionString:
        configuredConnStr ??
        "postgresql://vellum_control:control_secret@localhost:5432/control_db",
      max: 5,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 15_000,
      application_name: "vellum-index-recommendations",
    });
    ownedPool.on("error", () => undefined);
    pool = ownedPool;
  }

  const logger = options.logger;
  const now = options.now ?? Date.now;
  const rawFlushInterval = options.flushIntervalMs ?? DEFAULT_FLUSH_INTERVAL_MS;
  const flushIntervalMs = Number.isFinite(rawFlushInterval)
    ? Math.max(1, Math.floor(rawFlushInterval))
    : DEFAULT_FLUSH_INTERVAL_MS;

  const pending = new Map<string, PendingRecommendation>();
  const lastFlushedAt = new Map<string, number>();
  let timer: ReturnType<typeof setTimeout> | null = null;
  let closed = false;
  let pendingChain: Promise<void> = Promise.resolve();

  const warn = (message: string, context?: Record<string, unknown>): void => {
    try {
      if (context === undefined) logger?.warn?.(message);
      else logger?.warn?.(message, context);
    } catch {
      // Logging must never break the fire-and-forget path.
    }
  };

  const enqueueFlush = (force = false): Promise<void> => {
    const work = pendingChain.then(() => runFlush(force));
    pendingChain = work.then(
      () => undefined,
      () => undefined
    );
    return work;
  };

  const scheduleTimer = (): void => {
    if (timer !== null || closed || pending.size === 0) return;
    const handle = setTimeout(() => {
      timer = null;
      void enqueueFlush(false);
    }, flushIntervalMs);
    if (typeof handle.unref === "function") handle.unref();
    timer = handle;
  };

  const upsertSql = `
    INSERT INTO project_index_recommendations (
      id, project_id, fingerprint, collection_path, recommended_fields,
      sample_query, reason, hit_count, total_duration_ms, max_duration_ms,
      status, last_seen_at, created_at
    )
    SELECT
      t.id,
      t.project_id::uuid,
      t.fingerprint,
      t.collection_path,
      t.recommended_fields::jsonb,
      t.sample_query::jsonb,
      t.reason,
      t.hit_count,
      t.total_duration_ms,
      t.max_duration_ms,
      'pending',
      to_timestamp(t.last_seen_at_ms::double precision / 1000.0),
      to_timestamp(t.last_seen_at_ms::double precision / 1000.0)
    FROM unnest(
      $1::uuid[], $2::uuid[], $3::text[], $4::text[],
      $5::jsonb[], $6::jsonb[], $7::text[], $8::bigint[],
      $9::double precision[], $10::double precision[], $11::bigint[]
    ) AS t(
      id, project_id, fingerprint, collection_path,
      recommended_fields, sample_query, reason, hit_count,
      total_duration_ms, max_duration_ms, last_seen_at_ms
    )
    ON CONFLICT (project_id, fingerprint) DO UPDATE SET
      hit_count = project_index_recommendations.hit_count + EXCLUDED.hit_count,
      total_duration_ms =
        project_index_recommendations.total_duration_ms + EXCLUDED.total_duration_ms,
      max_duration_ms = GREATEST(
        project_index_recommendations.max_duration_ms, EXCLUDED.max_duration_ms
      ),
      last_seen_at = now(),
      reason = EXCLUDED.reason,
      sample_query = EXCLUDED.sample_query,
      status = 'pending'
    WHERE project_index_recommendations.status <> 'applied'
  `;

  async function flushEntries(entries: PendingRecommendation[]): Promise<void> {
    if (entries.length === 0) return;
    await pool.query(upsertSql, [
      entries.map((entry) => entry.id),
      entries.map((entry) => entry.projectId),
      entries.map((entry) => entry.fingerprint),
      entries.map((entry) => entry.collectionPath),
      entries.map((entry) => safeJsonStringify(entry.recommendedFields)),
      entries.map((entry) => safeJsonStringify(entry.sampleQuery ?? null)),
      entries.map((entry) => entry.reason),
      entries.map((entry) => entry.hitCount),
      entries.map((entry) => entry.totalDurationMs),
      entries.map((entry) => entry.maxDurationMs),
      entries.map((entry) => entry.lastSeenAtMs),
    ]);
  }

  async function runFlush(force = false): Promise<void> {
    const currentMs = now();
    const taken: PendingRecommendation[] = [];
    for (const [key, entry] of pending) {
      const previousFlush = lastFlushedAt.get(key);
      const elapsed = currentMs - (previousFlush ?? 0);
      // A fingerprint that has never been flushed is always eligible for an
      // explicit flush; once flushed, it is rate-limited to one write per
      // flushIntervalMs. `force` (close) is the only path that bypasses this.
      if (force || previousFlush === undefined || elapsed >= flushIntervalMs) {
        taken.push(entry);
        pending.delete(key);
      }
    }
    try {
      await flushEntries(taken);
      for (const entry of taken) {
        setBoundedMap(
          lastFlushedAt,
          `${entry.projectId}:${entry.fingerprint}`,
          currentMs,
          MAX_TRACKED_FLUSHED
        );
      }
    } catch (err: unknown) {
      // Keep the buffer for retry and merge with anything recorded meanwhile.
      for (const entry of taken) {
        const key = `${entry.projectId}:${entry.fingerprint}`;
        const existing = pending.get(key);
        if (existing) {
          existing.hitCount += entry.hitCount;
          existing.totalDurationMs += entry.totalDurationMs;
          existing.maxDurationMs = Math.max(existing.maxDurationMs, entry.maxDurationMs);
          // Only overwrite metadata if the retried entry is newer than what arrived during flush.
          if (entry.lastSeenAtMs > existing.lastSeenAtMs) {
            existing.reason = entry.reason;
            existing.sampleQuery = entry.sampleQuery;
            existing.recommendedFields = entry.recommendedFields;
            existing.lastSeenAtMs = entry.lastSeenAtMs;
          }
        } else {
          setBoundedMap(pending, key, entry, MAX_PENDING_ENTRIES);
        }
      }
      warn("Index recommendation flush failed; buffered for retry", {
        reason: redactConnectionString(err instanceof Error ? err.message : String(err)),
        count: taken.length,
      });
    } finally {
      scheduleTimer();
    }
  }

  const recorder: IndexRecommendationRecorder = {
    record(input: RecordIndexRecommendationInput): void {
      if (closed) return;
      try {
        if (
          !input ||
          typeof input.projectId !== "string" ||
          input.projectId.length === 0 ||
          typeof input.fingerprint !== "string" ||
          input.fingerprint.length === 0 ||
          typeof input.collectionPath !== "string" ||
          input.collectionPath.length === 0
        ) {
          warn("Ignoring index recommendation with missing tenant or fingerprint context");
          return;
        }
        const fingerprint = input.fingerprint.slice(0, MAX_IDENTIFIER_LENGTH);
        const collectionPath = input.collectionPath.slice(0, MAX_IDENTIFIER_LENGTH);
        const reason = typeof input.reason === "string" ? input.reason.slice(0, MAX_REASON_LENGTH) : "";
        const key = `${input.projectId}:${fingerprint}`;
        const duration = Number.isFinite(input.durationMs) ? Math.max(0, input.durationMs) : 0;
        const seenAt = now();
        const fields = Array.isArray(input.recommendedFields)
          ? input.recommendedFields.slice(0, MAX_RECOMMENDED_FIELDS).map((field) => ({
              path: typeof field?.path === "string" ? field.path.slice(0, MAX_IDENTIFIER_LENGTH) : "",
              dir: field?.dir === "desc" ? ("desc" as const) : ("asc" as const),
            }))
          : [];
        const existing = pending.get(key);
        if (existing) {
          existing.hitCount += 1;
          existing.totalDurationMs += duration;
          existing.maxDurationMs = Math.max(existing.maxDurationMs, duration);
          existing.reason = reason;
          existing.sampleQuery = input.sampleQuery;
          existing.lastSeenAtMs = seenAt;
          existing.recommendedFields = fields;
          // Refresh insertion order for LRU eviction.
          pending.delete(key);
          pending.set(key, existing);
        } else {
          setBoundedMap(
            pending,
            key,
            {
              id: crypto.randomUUID(),
              projectId: input.projectId,
              fingerprint,
              collectionPath,
              recommendedFields: fields,
              sampleQuery: input.sampleQuery,
              reason,
              hitCount: 1,
              totalDurationMs: duration,
              maxDurationMs: duration,
              lastSeenAtMs: seenAt,
            },
            MAX_PENDING_ENTRIES
          );
        }
        scheduleTimer();
      } catch (err: unknown) {
        warn("Failed to buffer index recommendation", {
          reason: redactConnectionString(err instanceof Error ? err.message : String(err)),
        });
      }
    },

    async list(projectId: string): Promise<IndexRecommendationRecord[]> {
      const { rows } = await pool.query(
        `SELECT id, project_id AS "projectId",
                fingerprint, collection_path AS "collectionPath",
                recommended_fields AS "recommendedFields", sample_query AS "sampleQuery",
                reason, hit_count AS "hitCount", total_duration_ms AS "totalDurationMs",
                max_duration_ms AS "maxDurationMs", status,
                last_seen_at AS "lastSeenAt", created_at AS "createdAt"
           FROM project_index_recommendations
          WHERE project_id = $1::uuid
          ORDER BY hit_count DESC, last_seen_at DESC`,
        [projectId]
      );
      return rows.map((row) => mapRow(row as Record<string, unknown>));
    },

    async setStatus(id: string, status: IndexRecommendationStatus | string): Promise<void> {
      if (typeof status !== "string" || !VALID_STATUSES.has(status)) {
        throw new Error(`Invalid index recommendation status: ${String(status)}`);
      }
      await pool.query(
        `UPDATE project_index_recommendations
            SET status = $2, last_seen_at = now()
          WHERE id = $1::uuid`,
        [id, status]
      );
    },

    async markAppliedByFingerprint(projectId: string, fingerprint: string): Promise<void> {
      const key = `${projectId}:${fingerprint}`;
      pending.delete(key);
      await pool.query(
        `UPDATE project_index_recommendations
            SET status = 'applied', last_seen_at = now()
          WHERE project_id = $1::uuid
            AND fingerprint = $2`,
        [projectId, fingerprint]
      );
    },

    async flush(): Promise<void> {
      await enqueueFlush(false);
    },

    async close(): Promise<void> {
      if (closed) return;
      closed = true;
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
      try {
        await enqueueFlush(true);
      } finally {
        if (ownsPool) await (pool as pg.Pool).end();
      }
    },
  };

  return recorder;
}
