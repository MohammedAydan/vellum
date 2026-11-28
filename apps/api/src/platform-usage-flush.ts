/**
 * `@vellum/api - Platform usage persistence` (`apps/api/src/platform-usage-flush.ts`)
 *
 * Owns the only writes to the platform cost tables:
 *   - `persistPlatformUsage()`  one batched UNNEST upsert per meter flush (60s)
 *   - `rollupPlatformUsage()`   minute → day, then prune old minute rows (daily)
 *
 * The control plane is the only store: no Redis, no second stateful service.
 * Every statement is parameterised and batched; a failure is reported, never
 * thrown into a request path.
 */

import type { ControlPlaneRepository } from "@vellum/database-control";
import type { PlatformUsageBucket } from "@vellum/observability";
import { getQueryPool } from "./routes/usage.js";

/** True when the control store is backed by a PostgreSQL pool. */
export function hasQueryPool(controlStore: ControlPlaneRepository): boolean {
  return getQueryPool(controlStore) !== null;
}

/** Minute rows are kept this long; daily rows are kept indefinitely. */
export const PLATFORM_USAGE_RAW_RETENTION_DAYS = 90;

/**
 * Upsert one flushed batch. Returns the number of buckets written. Throws when
 * there is no PostgreSQL control store, so the meter keeps the batch for retry.
 */
export async function persistPlatformUsage(
  controlStore: ControlPlaneRepository,
  buckets: readonly PlatformUsageBucket[]
): Promise<number> {
  if (buckets.length === 0) return 0;
  const pool = getQueryPool(controlStore);
  if (pool === null) return 0;

  const bucketStarts: string[] = [];
  const projectIds: string[] = [];
  const requestsRead: number[] = [];
  const requestsWrite: number[] = [];
  const requestsOther: number[] = [];
  const cpuMs: number[] = [];
  const bytesIn: number[] = [];
  const bytesOut: number[] = [];
  const realtimeFrames: number[] = [];

  for (const bucket of buckets) {
    bucketStarts.push(new Date(bucket.bucketStartMs).toISOString());
    projectIds.push(bucket.projectId);
    requestsRead.push(bucket.counts.requests_read);
    requestsWrite.push(bucket.counts.requests_write);
    requestsOther.push(bucket.counts.requests_other);
    cpuMs.push(bucket.counts.cpu_ms);
    bytesIn.push(bucket.counts.bytes_in);
    bytesOut.push(bucket.counts.bytes_out);
    realtimeFrames.push(bucket.counts.realtime_frames);
  }

  await pool.query(
    `INSERT INTO platform_usage_minute
       (bucket_start, project_id, requests_read, requests_write, requests_other,
        cpu_ms, bytes_in, bytes_out, realtime_frames, updated_at)
     SELECT batch.bucket_start, batch.project_id, batch.requests_read, batch.requests_write,
            batch.requests_other, batch.cpu_ms, batch.bytes_in, batch.bytes_out,
            batch.realtime_frames, now()
       FROM UNNEST(
         $1::timestamptz[], $2::uuid[], $3::bigint[], $4::bigint[], $5::bigint[],
         $6::bigint[], $7::bigint[], $8::bigint[], $9::bigint[]
       ) AS batch(bucket_start, project_id, requests_read, requests_write, requests_other,
                  cpu_ms, bytes_in, bytes_out, realtime_frames)
     ON CONFLICT (bucket_start, project_id) DO UPDATE SET
       requests_read = platform_usage_minute.requests_read + EXCLUDED.requests_read,
       requests_write = platform_usage_minute.requests_write + EXCLUDED.requests_write,
       requests_other = platform_usage_minute.requests_other + EXCLUDED.requests_other,
       cpu_ms = platform_usage_minute.cpu_ms + EXCLUDED.cpu_ms,
       bytes_in = platform_usage_minute.bytes_in + EXCLUDED.bytes_in,
       bytes_out = platform_usage_minute.bytes_out + EXCLUDED.bytes_out,
       realtime_frames = platform_usage_minute.realtime_frames + EXCLUDED.realtime_frames,
       updated_at = now()
     RETURNING 1`,
    [bucketStarts, projectIds, requestsRead, requestsWrite, requestsOther, cpuMs, bytesIn, bytesOut, realtimeFrames]
  );
  return buckets.length;
}

/**
 * Roll finished minutes into `platform_usage_daily` and prune minute rows past
 * the retention window. Bounded work: one idempotent INSERT … SELECT per call,
 * so a missed tick simply folds more rows next time.
 */
export async function rollupPlatformUsage(
  controlStore: ControlPlaneRepository,
  now: Date = new Date()
): Promise<{ rolledDays: number; prunedMinutes: number }> {
  const pool = getQueryPool(controlStore);
  if (pool === null) return { rolledDays: 0, prunedMinutes: 0 };

  const rolled = await pool.query(
    `INSERT INTO platform_usage_daily
       (usage_date, project_id, requests_read, requests_write, requests_other,
        cpu_ms, bytes_in, bytes_out, realtime_frames, updated_at)
     SELECT (bucket_start AT TIME ZONE 'UTC')::date AS usage_date,
            project_id,
            SUM(requests_read), SUM(requests_write), SUM(requests_other),
            SUM(cpu_ms), SUM(bytes_in), SUM(bytes_out), SUM(realtime_frames),
            now()
       FROM platform_usage_minute
      WHERE bucket_start < date_trunc('day', $1::timestamptz)
      GROUP BY 1, 2
     ON CONFLICT (usage_date, project_id) DO UPDATE SET
       requests_read = EXCLUDED.requests_read,
       requests_write = EXCLUDED.requests_write,
       requests_other = EXCLUDED.requests_other,
       cpu_ms = EXCLUDED.cpu_ms,
       bytes_in = EXCLUDED.bytes_in,
       bytes_out = EXCLUDED.bytes_out,
       realtime_frames = EXCLUDED.realtime_frames,
       updated_at = now()
     RETURNING 1`,
    [now.toISOString()]
  );

  const pruned = await pool.query(
    `DELETE FROM platform_usage_minute
      WHERE bucket_start < $1::timestamptz
     RETURNING 1`,
    [new Date(now.getTime() - PLATFORM_USAGE_RAW_RETENTION_DAYS * 86_400_000).toISOString()]
  );

  return { rolledDays: rolled.rows.length, prunedMinutes: pruned.rows.length };
}
