/**
 * @vellum/realtime - Durable Outbox Poller (PostgreSQL-only)
 *
 * LISTEN/NOTIFY is a *wake-up* mechanism only. Every notification identifies
 * (seqId, projectId); the poller then fetches the full rows from the durable
 * outbox through the tenant-scoped StorageAdapter and fans them out to a
 * RealtimeGatewayHub. A plain polling loop runs even when LISTEN is
 * unavailable, so the system degrades to polling instead of losing events.
 *
 * Invariants:
 *  - one monotonically increasing watermark per projectId;
 *  - delivery is gated on the commit-order-safe watermark (P0-2): only rows
 *    whose writing transaction was resolved at read time are fetched, so a
 *    late-committing transaction can never be skipped by the watermark and no
 *    wall-clock cutoff or grace window is involved;
 *  - events with seqId <= watermark are never fetched again (NOTIFY + poll
 *    observing the same row therefore yields exactly one fetch);
 *  - catch-up is capped at 500 rows per SQL query (the outbox index page size);
 *  - cross-tenant rows are filtered out before fan-out;
 *  - tracked tenants map is bounded to prevent unbounded memory growth.
 */

import type { OutboxEvent, StorageAdapter, TenantContext } from "@vellum/storage";
import { PG_OUTBOX_CHANNEL, type PgNotifyBus } from "./pg-notify-pubsub.js";
import { rtLog } from "./diag.js";
import type { OutboxPollerPort, RealtimeEventSink } from "./contracts/realtime-port.js";

/** Minimal sink contract; `RealtimeGatewayHub` satisfies it structurally. */
export type OutboxFanoutSink = RealtimeEventSink;

export interface OutboxNotification {
  seqId: string;
  projectId: string;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DIGITS_RE = /^[0-9]{1,20}$/;
const MAX_NOTIFICATION_BYTES = 1_024;
const MAX_TRACKED_TENANTS = 10_000;

/** Parse a trigger payload. Returns null for malformed or foreign payloads. */
export function parseOutboxNotification(payload: string): OutboxNotification | null {
  if (typeof payload !== "string" || payload.length === 0 || payload.length > MAX_NOTIFICATION_BYTES) {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(payload);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
  const obj = parsed as Record<string, unknown>;
  const rawSeqId = obj["seqId"];
  const projectId = obj["projectId"];
  // json_build_object emits BIGINT as a JSON number; accept both representations.
  const seqId =
    typeof rawSeqId === "number" && Number.isSafeInteger(rawSeqId) && rawSeqId >= 0
      ? String(rawSeqId)
      : typeof rawSeqId === "string"
        ? rawSeqId
        : null;
  if (seqId === null || !DIGITS_RE.test(seqId)) return null;
  if (typeof projectId !== "string" || !UUID_RE.test(projectId)) return null;
  return { seqId, projectId };
}

export interface OutboxPollerOptions {
  bus: PgNotifyBus;
  dataStore: StorageAdapter;
  sink: OutboxFanoutSink;
  /** Defaults to the canonical `vellum_outbox` channel. */
  channel?: string | undefined;
  /** Rows fetched per catch-up query. Defaults to 500. */
  batchSize?: number | undefined;
  /** Plain-polling interval in ms. Defaults to 1000. */
  pollIntervalMs?: number | undefined;
  /** Safety-net poll for tenants with no connected client, in ms. Defaults to 0 (never): idle tenants cost no database work. */
  idleTenantPollMs?: number | undefined;
  /**
   * LISTEN-healthy poll for tenants WITH a connected client, in ms. Defaults
   * to 0 (poll every cycle). With LISTEN up the poll is only a missed-notify
   * net, so production wiring sets this to a slow cadence (10000): live
   * tenants are drained on that cadence instead of every poll interval. A
   * pending rescan or an unhealthy LISTEN connection drains every cycle.
   */
  healthyTenantPollMs?: number | undefined;
  /** A drain running longer than this is replaced. Defaults to 8000. */
  drainStuckMs?: number | undefined;
  retryBaseMs?: number | undefined;
  retryMaxMs?: number | undefined;
  onError?: ((error: Error) => void) | undefined;
}

/** How often a failed LISTEN subscription is retried. */
/** Delay before re-draining a tenant whose notified seq is still above the safe watermark. */
const GAP_REDRAIN_MS = 100;

const LISTEN_RETRY_MS = 15_000;

/** A drain running longer than this is treated as stuck (for example on a connection that died) and replaced. */
const DRAIN_STUCK_MS = 8_000;

interface TenantState extends TenantContext {
  key: string;
  /** Highest delivered seq; only ever advances to the commit-order-safe watermark or below. */
  watermark: bigint;
  initialized: boolean;
  inFlight: boolean;
  /** Start time and generation of the running drain, so a drain stuck on a dead connection can be replaced. */
  drainStartedAt: number;
  drainGen: number;
  currentTask: Promise<void> | null;
  /** Set when a NOTIFY arrives while drain() is already in flight so we re-drain immediately. */
  pendingRescan: boolean;
  /** Highest seq a NOTIFY announced; a drain that ends below it re-drains soon (commit-gap follow-up). */
  highestNotified: bigint;
  gapTimer: NodeJS.Timeout | null;
  attempts: number;
  retryTimer: NodeJS.Timeout | null;
}

export interface OutboxPollerStats {
  notifications: number;
  gapsDetected: number;
  batchesDelivered: number;
  eventsDelivered: number;
  polls: number;
  errors: number;
}

export class OutboxPoller implements OutboxPollerPort {
  private readonly bus: PgNotifyBus;
  private readonly dataStore: StorageAdapter;
  private readonly sink: OutboxFanoutSink;
  private readonly channel: string;
  private readonly batchSize: number;
  private readonly pollIntervalMs: number;
  private readonly drainStuckMs: number;
  private readonly idleTenantPollMs: number;
  private readonly healthyTenantPollMs: number;
  private readonly skippedIdle = new Set<string>();
  private readonly lastIdlePollAt = new Map<string, number>();
  private readonly lastHealthyPollAt = new Map<string, number>();
  private readonly retryBaseMs: number;
  private readonly retryMaxMs: number;
  private readonly onError: ((error: Error) => void) | undefined;
  private readonly tenants = new Map<string, TenantState>();
  private readonly inFlightTasks = new Set<Promise<void>>();

  private unsubscribe: (() => void) | null = null;
  private pollTimer: NodeJS.Timeout | null = null;
  private listenRetryTimer: NodeJS.Timeout | null = null;
  private started = false;
  private closed = false;

  public readonly stats: OutboxPollerStats = {
    notifications: 0,
    gapsDetected: 0,
    batchesDelivered: 0,
    eventsDelivered: 0,
    polls: 0,
    errors: 0,
  };

  constructor(options: OutboxPollerOptions) {
    this.bus = options.bus;
    this.dataStore = options.dataStore;
    this.sink = options.sink;
    this.channel = options.channel ?? PG_OUTBOX_CHANNEL;
    const rawBatch = Number.isFinite(options.batchSize) ? options.batchSize! : 500;
    const rawPoll = Number.isFinite(options.pollIntervalMs) ? options.pollIntervalMs! : 1_000;
    const rawRetryBase = Number.isFinite(options.retryBaseMs) ? options.retryBaseMs! : 250;
    const rawRetryMax = Number.isFinite(options.retryMaxMs) ? options.retryMaxMs! : 10_000;
    this.batchSize = Math.max(1, Math.min(5_000, Math.trunc(rawBatch)));
    this.pollIntervalMs = Math.max(50, Math.trunc(rawPoll));
    this.idleTenantPollMs = Number.isFinite(options.idleTenantPollMs) ? Math.max(0, options.idleTenantPollMs!) : 0;
    this.healthyTenantPollMs = Number.isFinite(options.healthyTenantPollMs)
      ? Math.max(0, options.healthyTenantPollMs!)
      : 0;
    this.drainStuckMs = Number.isFinite(options.drainStuckMs) ? Math.max(50, options.drainStuckMs!) : DRAIN_STUCK_MS;
    this.retryBaseMs = Math.max(1, Math.trunc(rawRetryBase));
    this.retryMaxMs = Math.max(this.retryBaseMs, Math.trunc(rawRetryMax));
    this.onError = options.onError;
  }

  public async start(): Promise<void> {
    if (this.started || this.closed) return;
    this.started = true;
    // LISTEN is only a wake-up. When it cannot connect (a pooled or blocked database endpoint, a cold
    // serverless instance), polling must still run, otherwise this instance never sees rows that other
    // instances wrote. The subscription is retried in the background.
    await this.trySubscribe();
    if (this.closed || !this.started) return;
    this.pollTimer = setInterval(() => {
      this.pollAll();
    }, this.pollIntervalMs);
    this.pollTimer.unref();
    this.pollAll();
  }

  private async trySubscribe(): Promise<void> {
    if (this.unsubscribe || this.closed) return;
    try {
      const unsub = await this.bus.subscribe(this.channel, (payload: string) => {
        this.handleNotification(payload);
      });
      // Guard against stop() being called while subscribe() was awaiting.
      if (this.closed || !this.started) {
        unsub();
        return;
      }
      this.unsubscribe = unsub;
      if (this.listenRetryTimer) {
        clearInterval(this.listenRetryTimer);
        this.listenRetryTimer = null;
      }
      rtLog("poller_listen", { listening: true });
    } catch (err) {
      this.stats.errors += 1;
      this.reportError(err);
      rtLog("poller_listen", { listening: false, reason: err instanceof Error ? err.message.slice(0, 200) : String(err).slice(0, 200) });
      if (!this.listenRetryTimer && !this.closed) {
        this.listenRetryTimer = setInterval(() => {
          void this.trySubscribe();
        }, LISTEN_RETRY_MS);
        this.listenRetryTimer.unref();
      }
    }
  }

  public async stop(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.started = false;
    if (this.unsubscribe) {
      this.unsubscribe();
      this.unsubscribe = null;
    }
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    if (this.listenRetryTimer) {
      clearInterval(this.listenRetryTimer);
      this.listenRetryTimer = null;
    }
    for (const tenant of this.tenants.values()) {
      tenant.pendingRescan = false;
      if (tenant.gapTimer) {
        clearTimeout(tenant.gapTimer);
        tenant.gapTimer = null;
      }
      if (tenant.retryTimer) {
        clearTimeout(tenant.retryTimer);
        tenant.retryTimer = null;
      }
    }
    await Promise.allSettled([...this.inFlightTasks]);
  }

  /** Current committed watermark for a tenant, or null when never observed. */
  public getWatermark(projectId: string): bigint | null {
    const entry = this.tenants.get(this.keyFor(projectId));
    if (!entry || !entry.initialized) return null;
    return entry.watermark;
  }

  /**
   * P0-2: the gateway hub calls this when a session authenticates so the
   * tenant's watermark is initialized from the commit-order-safe watermark
   * *before* any subscribe snapshot is taken. That ordering guarantees a write
   * that lands between a subscription's snapshot and this instance's first
   * drain is above the tenant watermark and therefore fanned out live instead
   * of being skipped.
   */
  public initializeTenantNow(projectId: string): void {
    if (this.closed) return;
    const entry = this.registerTenant({ projectId });
    if (entry.initialized) return;
    const task = (async () => {
      await this.initializeEntry(entry);
    })();
    this.inFlightTasks.add(task);
    void task
      .catch((err: unknown) => {
        this.stats.errors += 1;
        this.reportError(err);
      })
      .finally(() => {
        this.inFlightTasks.delete(task);
      });
  }

  /** Feed a raw NOTIFY payload into the poller (also used by tests). */
  public handleNotification(payload: string): void {
    if (this.closed) return;
    const note = parseOutboxNotification(payload);
    if (!note) return;
    this.stats.notifications += 1;
    // Only projects with a live client on this instance need a drain; others would cost a transaction per write per instance.
    if (!this.hasLiveSession(note.projectId)) return;
    const observed = BigInt(note.seqId);
    const entry = this.registerTenant(note);
    if (observed > entry.highestNotified) entry.highestNotified = observed;
    if (entry.initialized && observed > entry.watermark + 1n) {
      // Explicit gap detection: the wake-up skipped at least one sequence.
      // Never fast-forward watermark here — drain() will fetch every row > watermark
      // in strict ascending order so bursty notifications never drop intermediate events.
      this.stats.gapsDetected += 1;
    }
    if (entry.inFlight) {
      entry.pendingRescan = true;
      return;
    }
    void this.drain(entry);
  }

  /** Discover tenants from authenticated hub sessions plus previously seen ones. */
  public discoverTenants(): TenantContext[] {
    const discovered = new Map<string, TenantContext>();
    for (const entry of this.tenants.values()) {
      discovered.set(entry.key, { projectId: entry.projectId });
    }
    const sessions = this.sink.connections;
    if (sessions) {
      for (const session of sessions.values()) {
        if (!session.authenticated || session.closed || !session.projectId) continue;
        const ctx: TenantContext = { projectId: session.projectId };
        discovered.set(this.keyFor(ctx.projectId), ctx);
      }
    }
    return [...discovered.values()];
  }

  private pollAll(): void {
    if (!this.started || this.closed) return;
    this.stats.polls += 1;
    const now = Date.now();
    const live = new Set<string>();
    const sessions = this.sink.connections;
    if (sessions) {
      for (const session of sessions.values()) {
        if (session.authenticated && !session.closed && session.projectId) live.add(this.keyFor(session.projectId));
      }
    }
    for (const ctx of this.discoverTenants()) {
      const key = this.keyFor(ctx.projectId);
      // A tenant with no connected client is only a safety net for a missed NOTIFY. Polling it
      // every second costs a full transaction (BEGIN, set_config, SELECT, COMMIT) per tenant per
      // instance and keeps the database busy for nothing, so it gets a slow cadence.
      // With nobody connected to this tenant on this instance there is nothing to deliver, and a client that
      // connects later starts from the database's current position. Skipping those tenants means an instance
      // with no realtime clients never touches the database from here, so an idle database can suspend.
      if (live.has(key) && this.skippedIdle.delete(key)) {
        // The tenant had no client for a while, so its watermark is stale. Start it again from the database's
        // current position instead of replaying everything written in the meantime to the new client.
        const stale = this.tenants.get(key);
        if (stale && !stale.inFlight) {
          if (stale.retryTimer) clearTimeout(stale.retryTimer);
          this.tenants.delete(key);
        }
      }
      if (!live.has(key) && this.idleTenantPollMs <= 0) {
        this.skippedIdle.add(key);
        continue;
      }
      if (!live.has(key) && now - (this.lastIdlePollAt.get(key) ?? 0) < this.idleTenantPollMs) continue;
      if (!live.has(key)) this.lastIdlePollAt.set(key, now);
      // LISTEN-healthy back-off (P1-4): with LISTEN up, the poll is only a
      // missed-notify net for live tenants, so drain them on a slow cadence.
      const known = this.tenants.get(key);
      if (
        live.has(key) &&
        this.healthyTenantPollMs > 0 &&
        this.unsubscribe !== null &&
        !(known && known.pendingRescan) &&
        now - (this.lastHealthyPollAt.get(key) ?? 0) < this.healthyTenantPollMs
      ) continue;
      if (live.has(key)) this.lastHealthyPollAt.set(key, now);
      void this.drain(this.registerTenant(ctx));
    }
    if (this.lastIdlePollAt.size > MAX_TRACKED_TENANTS * 2) this.lastIdlePollAt.clear();
    if (this.lastHealthyPollAt.size > MAX_TRACKED_TENANTS * 2) this.lastHealthyPollAt.clear();
  }

  private hasLiveSession(projectId: string): boolean {
    const sessions = this.sink.connections;
    if (!sessions) return true;
    for (const s of sessions.values()) if (s.authenticated && !s.closed && s.projectId === projectId) return true;
    return false;
  }

  private keyFor(projectId: string): string {
    return projectId;
  }

  private evictIdleTenantsIfNeeded(): void {
    if (this.tenants.size < MAX_TRACKED_TENANTS) return;
    const activeProjects = new Set<string>();
    const sessions = this.sink.connections;
    if (sessions) {
      for (const s of sessions.values()) {
        if (s.authenticated && !s.closed && s.projectId) activeProjects.add(s.projectId);
      }
    }
    for (const [key, entry] of this.tenants) {
      if (this.tenants.size < MAX_TRACKED_TENANTS) break;
      if (!entry.inFlight && !activeProjects.has(entry.projectId)) {
        if (entry.retryTimer) {
          clearTimeout(entry.retryTimer);
          entry.retryTimer = null;
        }
        this.tenants.delete(key);
      }
    }
  }

  private registerTenant(ctx: TenantContext): TenantState {
    const key = this.keyFor(ctx.projectId);
    let entry = this.tenants.get(key);
    if (!entry) {
      this.evictIdleTenantsIfNeeded();
      entry = {
        key,
        projectId: ctx.projectId,
        watermark: 0n,
        initialized: false,
        inFlight: false,
        drainStartedAt: 0,
        drainGen: 0,
        currentTask: null,
        pendingRescan: false,
        highestNotified: 0n,
        gapTimer: null,
        attempts: 0,
        retryTimer: null,
      };
      this.tenants.set(key, entry);
    }
    return entry;
  }

  /**
   * Poll-only tenant bootstrap: start at the commit-order-safe watermark (P0-2).
   * Every row at or below it belongs to a resolved transaction, so nothing a
   * live session could observe is skipped; rows still in flight are picked up
   * by later drains as their transactions resolve. Adapters without xid8
   * gating fall back to the head (in-memory adapters commit atomically, so the
   * head is safe there). No wall-clock cutoffs are involved.
   */
  private async initializeEntry(entry: TenantState): Promise<void> {
    if (entry.initialized) return;
    let watermark = "0";
    if (typeof this.dataStore.queryOutboxSafeWatermark === "function") {
      watermark = await this.dataStore.queryOutboxSafeWatermark(entry);
    } else if (typeof this.dataStore.queryOutboxMaxSeq === "function") {
      watermark = await this.dataStore.queryOutboxMaxSeq(entry);
    } else {
      // Adapters without a max query: page to the head (bounded scan).
      let after = "0";
      for (let i = 0; i < 10; i += 1) {
        if (this.closed) return;
        const rows = await this.dataStore.queryOutboxSince(entry, after);
        const tail = rows[rows.length - 1];
        if (!tail) break;
        watermark = tail.seqId;
        if (rows.length < this.batchSize) break;
        after = tail.seqId;
      }
    }
    if (!entry.initialized) {
      let seq: bigint;
      try {
        seq = BigInt(watermark);
      } catch {
        seq = 0n;
      }
      entry.watermark = seq;
      entry.initialized = true;
    }
  }

  /** Commit-order-safe upper bound for this drain, or null when the adapter cannot provide one. */
  private async safeUpperBound(entry: TenantState): Promise<bigint | null> {
    let raw: string | null = null;
    if (typeof this.dataStore.queryOutboxSafeWatermark === "function") {
      raw = await this.dataStore.queryOutboxSafeWatermark(entry);
    } else if (typeof this.dataStore.queryOutboxMaxSeq === "function") {
      raw = await this.dataStore.queryOutboxMaxSeq(entry);
    }
    if (raw === null) return null;
    try {
      return BigInt(raw);
    } catch {
      return null;
    }
  }

  private drain(entry: TenantState): void {
    if (!this.started || this.closed) return;
    if (entry.inFlight) {
      const age = Date.now() - entry.drainStartedAt;
      if (age < this.drainStuckMs) return;
      // A drain that never finishes would silence this tenant on this instance for good.
      if (entry.currentTask) this.inFlightTasks.delete(entry.currentTask);
      rtLog("drain_stuck_replaced", { project: entry.projectId, ageMs: age, watermark: String(entry.watermark) });
    }
    entry.inFlight = true;
    entry.pendingRescan = false;
    entry.drainStartedAt = Date.now();
    const gen = ++entry.drainGen;
    const startedAt = entry.drainStartedAt;

    const task = (async () => {
      await this.initializeEntry(entry);
      // P0-2: deliver only rows up to the commit-order-safe watermark. Every seq
      // at or below `upper` belongs to a transaction that was resolved when the
      // bound was read, so the capped fetch sees exactly the committed rows in
      // (watermark, upper] and the watermark can advance straight to each
      // delivered page tail - a late-committing transaction is never skipped,
      // it is simply delivered by a later drain once it resolves.
      const safe = await this.safeUpperBound(entry);
      // Adapters without any max query (the bounded-scan bootstrap fallback)
      // page unbounded: every row the fetch returns is committed, so the
      // per-page watermark advance stays safe.
      let upper: bigint | null = entry.watermark;
      if (safe !== null && safe > upper) upper = safe;
      if (safe === null) upper = null;
      let cursor = entry.watermark;
      while (!this.closed && entry.drainGen === gen && (upper === null || cursor < upper)) {
        const rows = await this.dataStore.queryOutboxSince(entry, cursor.toString(), upper === null ? undefined : upper.toString());
        if (entry.drainGen !== gen) return;
        if (rows.length === 0) break;
        const fresh: OutboxEvent[] = [];
        let pageMax = cursor;
        for (const ev of rows) {
          if (ev.projectId !== entry.projectId) continue;
          let seq: bigint;
          try {
            seq = BigInt(ev.seqId);
          } catch {
            continue;
          }
          if (upper !== null && seq > upper) continue;
          if (seq > pageMax) pageMax = seq;
          if (seq > entry.watermark) fresh.push(ev);
        }
        if (fresh.length > 0) {
          await this.sink.notifyCommittedEvents(entry.projectId, fresh);
          this.stats.batchesDelivered += 1;
          this.stats.eventsDelivered += fresh.length;
        }
        entry.attempts = 0;
        if (pageMax <= cursor) break;
        cursor = pageMax;
        // Advance per delivered page: the page is at or below the safe upper
        // bound, so nothing skipped here can still be in flight.
        entry.watermark = pageMax;
        if (rows.length < this.batchSize) break;
      }
      // Commit-gap follow-up: a NOTIFY announced a seq above the safe watermark (a lower-seq
      // transaction was still in flight). Nothing else would wake this tenant until the next
      // poll, so re-drain on a short bounded delay until the watermark covers it.
      if (entry.drainGen === gen && entry.highestNotified > entry.watermark) this.scheduleGapRedrain(entry);
    })();

    this.inFlightTasks.add(task);
    entry.currentTask = task;
    void task
      .catch((err: unknown) => {
        if (entry.drainGen !== gen) return;
        this.stats.errors += 1;
        rtLog("drain_error", { project: entry.projectId, reason: err instanceof Error ? err.message.slice(0, 200) : String(err).slice(0, 200) });
        this.reportError(err);
        this.scheduleRetry(entry);
      })
      .finally(() => {
        const took = Date.now() - startedAt;
        if (took > 3_000) rtLog("drain_slow", { project: entry.projectId, ms: took });
        if (entry.drainGen !== gen) { this.inFlightTasks.delete(task); return; }
        entry.inFlight = false;
        this.inFlightTasks.delete(task);
        if (entry.pendingRescan && this.started && !this.closed) {
          entry.pendingRescan = false;
          this.drain(entry);
        }
      });
  }

  private scheduleGapRedrain(entry: TenantState): void {
    if (!this.started || this.closed || entry.gapTimer) return;
    entry.gapTimer = setTimeout(() => {
      entry.gapTimer = null;
      this.drain(entry);
    }, GAP_REDRAIN_MS);
    entry.gapTimer.unref();
  }

  private scheduleRetry(entry: TenantState): void {
    if (!this.started || this.closed || entry.retryTimer) return;
    const expDelay = Math.min(this.retryBaseMs * 2 ** Math.min(entry.attempts, 20), this.retryMaxMs);
    const jitteredDelay = Math.max(1, Math.floor(expDelay * (0.5 + Math.random() * 0.5)));
    entry.attempts += 1;
    entry.retryTimer = setTimeout(() => {
      entry.retryTimer = null;
      this.drain(entry);
    }, jitteredDelay);
    entry.retryTimer.unref();
  }

  private reportError(value: unknown): void {
    if (!this.onError) return;
    try {
      this.onError(value instanceof Error ? value : new Error(String(value)));
    } catch {
      // Never allow an error sink callback to crash the poller.
    }
  }
}
