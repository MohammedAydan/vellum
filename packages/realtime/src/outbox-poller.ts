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
  retryBaseMs?: number | undefined;
  retryMaxMs?: number | undefined;
  onError?: ((error: Error) => void) | undefined;
}

/** Safety-net poll cadence for tenants that have no connected realtime client. */
const IDLE_TENANT_POLL_MS = 30_000;

interface TenantState extends TenantContext {
  key: string;
  watermark: bigint;
  initialized: boolean;
  inFlight: boolean;
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
  private readonly lastIdlePollAt = new Map<string, number>();
  private readonly retryBaseMs: number;
  private readonly retryMaxMs: number;
  private readonly onError: ((error: Error) => void) | undefined;
  private readonly tenants = new Map<string, TenantState>();
  private readonly inFlightTasks = new Set<Promise<void>>();

  private unsubscribe: (() => void) | null = null;
  private pollTimer: NodeJS.Timeout | null = null;
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
    this.retryBaseMs = Math.max(1, Math.trunc(rawRetryBase));
    this.retryMaxMs = Math.max(this.retryBaseMs, Math.trunc(rawRetryMax));
    this.onError = options.onError;
  }

  public async start(): Promise<void> {
    if (this.started || this.closed) return;
    this.started = true;
    const unsub = await this.bus.subscribe(this.channel, (payload: string) => {
      this.handleNotification(payload);
    });
    // Guard against stop() being called while subscribe() was awaiting.
    if (this.closed || !this.started) {
      unsub();
      return;
    }
    this.unsubscribe = unsub;
    this.pollTimer = setInterval(() => {
      this.pollAll();
    }, this.pollIntervalMs);
    this.pollTimer.unref();
    this.pollAll();
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
    return this.tenants.get(this.keyFor(projectId))?.watermark ?? null;
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
        initialized: false,
        inFlight: false,
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

  /** Poll-only tenant bootstrap: skip pre-existing history, start at HEAD. */
  private async initializeEntry(entry: TenantState): Promise<void> {
    if (entry.initialized) return;
    let after = "0";
    let last: bigint = 0n;
    for (let i = 0; i < 10; i += 1) {
      if (this.closed) return;
      const rows = await this.dataStore.queryOutboxSince(entry, after);
      if (rows.length === 0) break;
      const tail = rows[rows.length - 1];
      if (!tail) break;
      for (const row of rows) {
        try {
          const seq = BigInt(row.seqId);
          if (seq > last) last = seq;
        } catch {
          /* ignore malformed seq */
        }
      }
      if (rows.length < this.batchSize) break;
      after = tail.seqId;
    }
    if (!entry.initialized) {
      entry.watermark = last;
      entry.initialized = true;
    }
  }

  private drain(entry: TenantState): void {
    if (!this.started || this.closed || entry.inFlight) return;
    entry.inFlight = true;
    entry.pendingRescan = false;

    const task = (async () => {
      await this.initializeEntry(entry);
      while (!this.closed) {
        const rows = await this.dataStore.queryOutboxSince(entry, entry.watermark.toString());
        if (rows.length === 0) {
          entry.attempts = 0;
          return;
        }
        const fresh: OutboxEvent[] = [];
        let maxFreshSeq = entry.watermark;
        for (const ev of rows) {
          if (ev.projectId !== entry.projectId) continue;
          let seq: bigint;
          try {
            seq = BigInt(ev.seqId);
          } catch {
            continue;
          }
          if (seq > entry.watermark) {
            fresh.push(ev);
            if (seq > maxFreshSeq) maxFreshSeq = seq;
          }
        }
        if (fresh.length === 0) {
          // All fetched rows were already seen; advance past them to guarantee progress.
          let max = entry.watermark;
          for (const ev of rows) {
            try {
              const seq = BigInt(ev.seqId);
              if (seq > max) max = seq;
            } catch {
              /* ignore malformed seq */
            }
          }
          entry.watermark = max;
          entry.attempts = 0;
          return;
        }
        await this.sink.notifyCommittedEvents(entry.projectId, fresh);
        if (maxFreshSeq > entry.watermark) {
          entry.watermark = maxFreshSeq;
        }
        entry.attempts = 0;
        this.stats.batchesDelivered += 1;
        this.stats.eventsDelivered += fresh.length;
        if (fresh.length < this.batchSize) return;
      }
    })();

    this.inFlightTasks.add(task);
    void task
      .catch((err: unknown) => {
        this.stats.errors += 1;
        this.reportError(err);
        this.scheduleRetry(entry);
      })
      .finally(() => {
        entry.inFlight = false;
        this.inFlightTasks.delete(task);
        if (entry.pendingRescan && this.started && !this.closed) {
          entry.pendingRescan = false;
          this.drain(entry);
        }
      });
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
