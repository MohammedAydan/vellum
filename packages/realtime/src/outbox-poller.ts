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
 *  - one monotonically increasing watermark per projectId (never fast-forwarded
 *    past unread rows on out-of-order or bursty NOTIFY wake-ups);
 *  - events with seqId <= watermark are never delivered again (NOTIFY + poll
 *    observing the same row therefore yields exactly one delivery);
 *  - catch-up is capped at 500 rows per SQL query (the outbox index page size);
 *  - cross-tenant rows are filtered out before fan-out;
 *  - tracked tenants map is bounded to prevent unbounded memory growth.
 */

import type { OutboxEvent, StorageAdapter, TenantContext } from "@vellum/storage";
import { PG_OUTBOX_CHANNEL, type PgNotifyBus } from "./pg-notify-pubsub.js";
import { rtDiagEnabled, rtLog } from "./diag.js";
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
  /** A drain running longer than this is replaced. Defaults to 8000. */
  drainStuckMs?: number | undefined;
  retryBaseMs?: number | undefined;
  retryMaxMs?: number | undefined;
  onError?: ((error: Error) => void) | undefined;
}

/** How often a failed LISTEN subscription is retried. */
const LISTEN_RETRY_MS = 15_000;

/** A drain running longer than this is treated as stuck (for example on a connection that died) and replaced. */
const DRAIN_STUCK_MS = 8_000;

/** Margin for clock differences between the API instance and the database when bootstrapping a tenant. */
const CONNECT_SKEW_MARGIN_MS = 2_000;

/** How long a delivered row stays in the re-read window so a transaction that committed late is not skipped. */
const LATE_COMMIT_GRACE_MS = 3_000;

/** Safety-net poll cadence for tenants that have no connected realtime client. */
const IDLE_TENANT_POLL_MS = 30_000;

interface TenantState extends TenantContext {
  key: string;
  watermark: bigint;
  /**
   * Sequence numbers above `watermark` that were already delivered, with the delivery time. A row's
   * seq is assigned at INSERT, but it becomes visible at COMMIT, so a row with a lower seq can commit
   * after a higher one was already read. Those rows are still fetched (the query starts at
   * `watermark`) and delivered once; `watermark` only moves past rows delivered at least
   * `LATE_COMMIT_GRACE_MS` ago.
   */
  delivered: Map<bigint, number>;
  initialized: boolean;
  inFlight: boolean;
  /** Start time and generation of the running drain, so a drain stuck on a dead connection can be replaced. */
  drainStartedAt: number;
  drainGen: number;
  currentTask: Promise<void> | null;
  /** Set when a NOTIFY arrives while drain() is already in flight so we re-drain immediately. */
  pendingRescan: boolean;
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
  private readonly lastIdlePollAt = new Map<string, number>();
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
    if (!entry) return null;
    let high = entry.watermark;
    for (const seq of entry.delivered.keys()) if (seq > high) high = seq;
    return high;
  }

  /** Feed a raw NOTIFY payload into the poller (also used by tests). */
  public handleNotification(payload: string): void {
    if (this.closed) return;
    const note = parseOutboxNotification(payload);
    if (!note) return;
    this.stats.notifications += 1;
    const observed = BigInt(note.seqId);
    const entry = this.registerTenant(note, observed);
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
      if (!live.has(key) && now - (this.lastIdlePollAt.get(key) ?? 0) < IDLE_TENANT_POLL_MS) continue;
      if (!live.has(key)) this.lastIdlePollAt.set(key, now);
      void this.drain(this.registerTenant(ctx));
    }
    if (this.lastIdlePollAt.size > MAX_TRACKED_TENANTS * 2) this.lastIdlePollAt.clear();
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

  private registerTenant(ctx: TenantContext, observedSeq?: bigint): TenantState {
    const key = this.keyFor(ctx.projectId);
    let entry = this.tenants.get(key);
    if (!entry) {
      this.evictIdleTenantsIfNeeded();
      entry = {
        key,
        projectId: ctx.projectId,
        watermark: 0n,
        delivered: new Map(),
        initialized: false,
        inFlight: false,
        drainStartedAt: 0,
        drainGen: 0,
        currentTask: null,
        pendingRescan: false,
        attempts: 0,
        retryTimer: null,
      };
      this.tenants.set(key, entry);
    }
    if (observedSeq !== undefined && observedSeq > 0n && !entry.initialized) {
      // The notification carries the exact inserted seq; start one before it
      // so the triggering row is fetched on the first catch-up query.
      entry.watermark = observedSeq - 1n;
      entry.initialized = true;
    }
    return entry;
  }

  /** Earliest open-time of a live session on this tenant, or null when unknown or none. */
  private earliestLiveConnectedAt(projectId: string): number | null {
    let min: number | null = null;
    const sessions = this.sink.connections;
    if (!sessions) return null;
    for (const session of sessions.values()) {
      if (!session.authenticated || session.closed || session.projectId !== projectId) continue;
      if (typeof session.connectedAt !== "number") continue;
      if (min === null || session.connectedAt < min) min = session.connectedAt;
    }
    return min;
  }

  /**
   * Poll-only tenant bootstrap: skip history, but not what happened since a client connected.
   * Starting at the current head would drop a write made between a client subscribing and the
   * first poll (up to one poll interval), so the watermark starts at the newest row committed
   * before the earliest live connection (minus a clock-skew margin) when one is known.
   */
  private async initializeEntry(entry: TenantState): Promise<void> {
    if (entry.initialized) return;
    const connectedAt = this.earliestLiveConnectedAt(entry.projectId);
    const cutoff = connectedAt === null ? null : connectedAt - CONNECT_SKEW_MARGIN_MS;
    let after = "0";
    let last: bigint = 0n;
    let beforeCutoff: bigint = 0n;
    let reachedEnd = false;
    for (let i = 0; i < 10; i += 1) {
      if (this.closed) return;
      const rows = await this.dataStore.queryOutboxSince(entry, after);
      if (rows.length === 0) { reachedEnd = true; break; }
      const tail = rows[rows.length - 1];
      if (!tail) break;
      for (const row of rows) {
        try {
          const seq = BigInt(row.seqId);
          if (seq > last) last = seq;
          if (cutoff !== null) {
            const at = Date.parse(row.committedAt);
            if (Number.isFinite(at) && at < cutoff && seq > beforeCutoff) beforeCutoff = seq;
          }
        } catch {
          /* ignore malformed seq */
        }
      }
      if (rows.length < this.batchSize) { reachedEnd = true; break; }
      after = tail.seqId;
    }
    if (!entry.initialized) {
      // A history longer than the scan cap cannot be compared by time; keep the head-based start.
      entry.watermark = cutoff === null || !reachedEnd ? last : beforeCutoff;
      entry.initialized = true;
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
      // Page through everything after the watermark. `cursor` pages; `watermark` only advances past
      // rows that have been delivered for longer than the late-commit grace period.
      let cursor = entry.watermark;
      while (!this.closed && entry.drainGen === gen) {
        const rows = await this.dataStore.queryOutboxSince(entry, cursor.toString());
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
          if (seq > pageMax) pageMax = seq;
          if (seq > entry.watermark && !entry.delivered.has(seq)) fresh.push(ev);
        }
        if (fresh.length > 0) {
          if (rtDiagEnabled(entry.projectId)) rtLog("poll_deliver", { project: entry.projectId, seqs: fresh.map((e) => e.seqId), versions: fresh.map((e) => e.version) });
          await this.sink.notifyCommittedEvents(entry.projectId, fresh);
          const now = Date.now();
          for (const ev of fresh) entry.delivered.set(BigInt(ev.seqId), now);
          this.stats.batchesDelivered += 1;
          this.stats.eventsDelivered += fresh.length;
        }
        entry.attempts = 0;
        if (pageMax <= cursor) break;
        cursor = pageMax;
        if (rows.length < this.batchSize) break;
      }
      this.advanceWatermark(entry);
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

  /** Move the watermark past rows delivered more than the grace period ago, and forget them. */
  private advanceWatermark(entry: TenantState): void {
    const cutoff = Date.now() - LATE_COMMIT_GRACE_MS;
    let next = entry.watermark;
    for (const [seq, at] of entry.delivered) {
      if (at <= cutoff && seq > next) next = seq;
    }
    if (next === entry.watermark) return;
    entry.watermark = next;
    for (const seq of entry.delivered.keys()) {
      if (seq <= next) entry.delivered.delete(seq);
    }
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
