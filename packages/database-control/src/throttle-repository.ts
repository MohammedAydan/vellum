/**
 * @vellum/database-control - Throttle Repository (contract §10)
 *
 * Shared, durable state for authentication throttles: sliding-window rate
 * limits, the per-project hourly signup budget, and MFA bad-code lockouts.
 * Every API instance reads and writes the same PostgreSQL tables, so limits
 * hold across serverless instances, cold starts and redeploys.
 *
 * Two primitives:
 *
 *  - `acquireThrottleSlot` reserves a slot in a sliding window and is atomic:
 *    concurrent callers cannot all pass one free slot. The returned event id
 *    releases the slot again when the attempt turns out not to count (a
 *    successful sign-in in failure-only mode, a rolled-back sign-up).
 *  - `incrementFailureCounter` counts bad codes with a sliding TTL and a hard
 *    cap; reaching the cap is the lockout signal until the TTL expires.
 *
 * Bucket keys are always opaque hashes or ids — never raw credentials, emails
 * or IP addresses — and nothing here is logged.
 */

/** A pooled `pg` connection pool (or anything with an equivalent `query`). */
export interface ThrottleQueryable {
  query(text: string, values?: readonly unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
}

export interface ThrottleSlot {
  /** True when the window had capacity and `eventId` was reserved. */
  acquired: boolean;
  /** Reserved event id; pass to `releaseThrottleSlot` when the attempt must not count. */
  eventId: string | null;
  /** Events inside the window before this attempt. */
  countBefore: number;
}

export interface ThrottleRepository {
  /**
   * Atomically reserve a sliding-window slot. When the window is full the
   * promise resolves with `{ acquired: false }` — no event is recorded.
   */
  acquireThrottleSlot(
    scope: string,
    subject: string,
    windowMs: number,
    max: number
  ): Promise<ThrottleSlot>;
  /** Release a reserved slot (best effort; a lost release simply counts). */
  releaseThrottleSlot(eventId: string): Promise<void>;
  /**
   * Add one failure to a TTL counter and return the live count. The TTL
   * restarts on every failure; the count never exceeds `max`, so the lockout
   * signal (`count >= max`) persists until the counter expires.
   */
  incrementFailureCounter(
    scope: string,
    subject: string,
    ttlMs: number,
    max: number
  ): Promise<number>;
  /** Live failure count; 0 when the counter is missing or expired. */
  getFailureCounter(scope: string, subject: string): Promise<number>;
  /** Reset a failure counter (successful verification). */
  clearFailureCounter(scope: string, subject: string): Promise<void>;
  /**
   * Drop rows that can never count again: throttle events older than
   * `retentionMs` and expired failure counters. Called by the periodic
   * control-plane maintenance flush.
   */
  pruneExpiredThrottleState(retentionMs: number): Promise<void>;
}

/** Throttle scopes used by the API. One namespace keeps buckets isolated. */
export const THROTTLE_SCOPES = Object.freeze({
  /** Per-project hourly sign-up budget (`subject` = projectId). */
  signupBudget: "signup-budget",
  /** MFA bad-code lockouts (`subject` = `${projectId}:${sha256(...)}`). */
  mfaFailures: "mfa-failures",
});

// ---------------------------------------------------------------------------
// PostgreSQL implementation
// ---------------------------------------------------------------------------

/**
 * Durable repository over two tables from migration 0015. The sliding-window
 * reservation runs inside `auth_throttle_acquire(...)`, a PL/pgSQL function
 * that takes a per-bucket advisory transaction lock and then counts with a
 * fresh READ COMMITTED snapshot, so concurrent reservers are fully serialized
 * in one round trip. The failure counter is a single INSERT ... ON CONFLICT,
 * which PostgreSQL executes under a row lock and is therefore race-free.
 */
export class PgThrottleRepository implements ThrottleRepository {
  private readonly queryable: ThrottleQueryable;

  constructor(queryable: ThrottleQueryable) {
    this.queryable = queryable;
  }

  public async acquireThrottleSlot(
    scope: string,
    subject: string,
    windowMs: number,
    max: number
  ): Promise<ThrottleSlot> {
    const { rows } = await this.queryable.query(
      `SELECT count_before AS "countBefore", event_id AS "eventId"
         FROM auth_throttle_acquire($1, $2, $3::int, $4::int)`,
      [scope, subject, Math.trunc(windowMs), Math.trunc(max)]
    );
    const row = rows[0] ?? {};
    const eventId = row["eventId"];
    return {
      acquired: eventId !== null && eventId !== undefined,
      eventId: eventId === null || eventId === undefined ? null : String(eventId),
      countBefore: Number(row["countBefore"] ?? 0),
    };
  }

  public async releaseThrottleSlot(eventId: string): Promise<void> {
    await this.queryable.query(`DELETE FROM auth_throttle_events WHERE id = $1::bigint`, [eventId]);
  }

  public async incrementFailureCounter(
    scope: string,
    subject: string,
    ttlMs: number,
    max: number
  ): Promise<number> {
    const { rows } = await this.queryable.query(
      `INSERT INTO auth_failure_counters (scope, subject, failures, expires_at)
       VALUES ($1, $2, 1, now() + $3::float8 * interval '1 millisecond')
       ON CONFLICT (scope, subject) DO UPDATE SET
         failures = CASE
           WHEN auth_failure_counters.expires_at <= now() THEN 1
           ELSE LEAST(auth_failure_counters.failures + 1, $4::int)
         END,
         expires_at = now() + $3::float8 * interval '1 millisecond'
       RETURNING failures`,
      [scope, subject, ttlMs, Math.trunc(max)]
    );
    return Number(rows[0]?.["failures"] ?? 1);
  }

  public async getFailureCounter(scope: string, subject: string): Promise<number> {
    const { rows } = await this.queryable.query(
      `SELECT failures FROM auth_failure_counters
        WHERE scope = $1 AND subject = $2 AND expires_at > now()`,
      [scope, subject]
    );
    return Number(rows[0]?.["failures"] ?? 0);
  }

  public async clearFailureCounter(scope: string, subject: string): Promise<void> {
    await this.queryable.query(
      `DELETE FROM auth_failure_counters WHERE scope = $1 AND subject = $2`,
      [scope, subject]
    );
  }

  public async pruneExpiredThrottleState(retentionMs: number): Promise<void> {
    await this.queryable.query(
      `DELETE FROM auth_throttle_events
        WHERE created_at < now() - $1::float8 * interval '1 millisecond'`,
      [retentionMs]
    );
    await this.queryable.query(`DELETE FROM auth_failure_counters WHERE expires_at <= now()`);
  }
}

// ---------------------------------------------------------------------------
// In-memory implementation (tests and the offline in-memory control store)
// ---------------------------------------------------------------------------

interface MemoryBucket {
  /** Event ids currently inside the sliding window, in insertion order. */
  events: string[];
  lastSeen: number;
}

interface MemoryFailureCounter {
  count: number;
  expiresAt: number;
}

/** Bounded so a flood of random identities can never exhaust process memory. */
const MEMORY_MAX_BUCKETS = 50_000;
const MEMORY_BUCKET_TTL_MS = 60 * 60 * 1000;

/**
 * Semantics match the PostgreSQL repository. Single-threaded execution plus a
 * synchronous check-then-push keeps reservations race-free in-process; the
 * class exists for unit tests and the offline in-memory control store, never
 * for multi-instance deployments.
 */
export class MemoryThrottleRepository implements ThrottleRepository {
  private readonly buckets = new Map<string, MemoryBucket>();
  private readonly counters = new Map<string, MemoryFailureCounter>();
  private readonly eventTs = new Map<string, number>();
  private nextEventId = 0;

  public acquireThrottleSlot(
    scope: string,
    subject: string,
    windowMs: number,
    max: number
  ): Promise<ThrottleSlot> {
    const key = `${scope}:${subject}`;
    const now = Date.now();
    const cutoff = now - windowMs;

    let bucket = this.buckets.get(key);
    if (!bucket) {
      this.pruneBucketsIfNeeded(now);
      bucket = { events: [], lastSeen: now };
      this.buckets.set(key, bucket);
    } else {
      bucket.lastSeen = now;
    }
    bucket.events = bucket.events.filter((id) => (this.eventTs.get(id) ?? 0) > cutoff);

    if (bucket.events.length >= max) {
      return Promise.resolve({ acquired: false, eventId: null, countBefore: bucket.events.length });
    }
    // No await between the check above and this push: concurrent in-flight
    // attempts reserve distinct slots and cannot all pass one free slot.
    this.nextEventId += 1;
    const eventId = `mem-${this.nextEventId}`;
    bucket.events.push(eventId);
    this.eventTs.set(eventId, now);
    bucket.lastSeen = now;
    return Promise.resolve({ acquired: true, eventId, countBefore: bucket.events.length - 1 });
  }

  public releaseThrottleSlot(eventId: string): Promise<void> {
    this.eventTs.delete(eventId);
    for (const bucket of this.buckets.values()) {
      const index = bucket.events.indexOf(eventId);
      if (index !== -1) {
        bucket.events.splice(index, 1);
        break;
      }
    }
    return Promise.resolve();
  }

  public incrementFailureCounter(
    scope: string,
    subject: string,
    ttlMs: number,
    max: number
  ): Promise<number> {
    const key = `${scope}:${subject}`;
    const now = Date.now();
    const existing = this.counters.get(key);
    const live = existing !== undefined && existing.expiresAt > now;
    const count = live ? Math.min(existing.count + 1, max) : 1;
    this.counters.set(key, { count, expiresAt: now + ttlMs });
    return Promise.resolve(count);
  }

  public getFailureCounter(scope: string, subject: string): Promise<number> {
    const existing = this.counters.get(`${scope}:${subject}`);
    if (!existing || existing.expiresAt <= Date.now()) return Promise.resolve(0);
    return Promise.resolve(existing.count);
  }

  public clearFailureCounter(scope: string, subject: string): Promise<void> {
    this.counters.delete(`${scope}:${subject}`);
    return Promise.resolve();
  }

  public pruneExpiredThrottleState(retentionMs: number): Promise<void> {
    const cutoff = Date.now() - retentionMs;
    for (const [key, bucket] of this.buckets) {
      bucket.events = bucket.events.filter((id) => {
        const ts = this.eventTs.get(id);
        if (ts === undefined || ts <= cutoff) {
          this.eventTs.delete(id);
          return false;
        }
        return true;
      });
      if (bucket.events.length === 0) this.buckets.delete(key);
    }
    const now = Date.now();
    for (const [key, counter] of this.counters) {
      if (counter.expiresAt <= now) this.counters.delete(key);
    }
    return Promise.resolve();
  }

  /** Test helper: drop all throttle state between cases. */
  public clearAll(): void {
    this.buckets.clear();
    this.counters.clear();
    this.eventTs.clear();
  }

  private pruneBucketsIfNeeded(now: number): void {
    if (this.buckets.size < MEMORY_MAX_BUCKETS) return;
    const cutoff = now - MEMORY_BUCKET_TTL_MS;
    for (const [key, bucket] of this.buckets) {
      if (bucket.lastSeen <= cutoff || bucket.events.length === 0) {
        this.buckets.delete(key);
      }
    }
    // If still above cap, evict oldest entries (Map preserves insertion order).
    while (this.buckets.size >= MEMORY_MAX_BUCKETS) {
      const oldestKey = this.buckets.keys().next().value;
      if (oldestKey === undefined) break;
      this.buckets.delete(oldestKey);
    }
  }
}
