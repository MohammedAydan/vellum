/**
 * `packages/billing/src/metering-engine.ts`
 *
 * O(1), allocation-bounded, synchronous hot-path usage metering (contract §4).
 *
 * Every `record*` method only mutates bounded in-memory maps and sets — there
 * is no DB I/O, no `await`, and no async work on the request path. All numeric
 * counters guard against NaN, Infinity, negative values, and integer overflow.
 * `flush()` atomically swaps the pending-delta map before doing any
 * persistence, so a slow database can never block request handlers.
 */

import type {
  BillingRepository,
  UsageMonthlyInput,
} from "@vellum/database-control";
import { computeChainHash, deriveChainKey } from "@vellum/security";
import type { MeteringPort } from "./contracts/billing-port.js";

/** 64-zero genesis hash, as locked by the hash-chain contract. */
const GENESIS_HASH = "0".repeat(64);
const DEFAULT_LEDGER_MASTER_KEY = "vellum-billing-ledger-master-key-v1";
const MAX_AUTH_USERS_PER_PROJECT = 100_000;
const MAX_GROUP_STATES = 50_000;
const MAX_ORG_STATES = 20_000;
const MAX_ID_LENGTH = 256;
const MIN_FLUSH_INTERVAL_MS = 50;

/** Realtime, org-scoped aggregate of all in-memory usage for the current month. */
export interface UsageTotals {
  docReads: number;
  docWrites: number;
  docDeletes: number;
  storageBytes: number;
  egressBytes: number;
  authMau: number;
  peakConcurrentWs: number;
}

/** Deltas accumulated since the last flush for one (org, project, month). */
export interface PendingDelta {
  docReads: number;
  docWrites: number;
  docDeletes: number;
  storageBytes: number;
  egressBytes: number;
  peakWs: number;
  authUsers: Set<string>;
}

export interface FlushResult {
  flushedGroups: number;
  ledgerSeq: number | null;
}

/** Minimal, no-op-safe logger hook. Logging errors can never break a flush. */
export interface MeteringLogger {
  error?(message: string, error?: unknown): void;
  warn?(message: string, error?: unknown): void;
}

export interface UsageMeteringEngineOptions {
  billing: BillingRepository;
  /** Pre-derived ledger chain key; takes precedence over `masterKey`. */
  chainKey?: Buffer | undefined;
  /** Master key used with HKDF (`billing-ledger-v1`) when `chainKey` is absent. */
  masterKey?: string | undefined;
  /** Injectable clock (epoch ms). Defaults to `Date.now`. */
  now?: (() => number) | undefined;
  logger?: MeteringLogger | undefined;
}

/** Cumulative state for a single (org, project, month) group. */
interface GroupState extends UsageTotals {
  currentWs: number;
  authUsers: Set<string>;
}

interface OrgRealtime extends UsageTotals {
  currentWs: number;
  authUsers: Set<string>;
}

interface OrgFlushAggregate {
  month: string;
  groups: number;
  totals: UsageTotals;
}

function safePositiveInt(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 0;
  return Math.min(Number.MAX_SAFE_INTEGER, Math.trunc(value));
}

function safeSignedDelta(value: number): number {
  if (!Number.isFinite(value) || value === 0) return 0;
  if (value > Number.MAX_SAFE_INTEGER) return Number.MAX_SAFE_INTEGER;
  if (value < -Number.MAX_SAFE_INTEGER) return -Number.MAX_SAFE_INTEGER;
  return Math.trunc(value);
}

function safeAdd(current: number, delta: number): number {
  const base = Number.isFinite(current) && current > 0 ? current : 0;
  const inc = safePositiveInt(delta);
  if (inc === 0) return base;
  if (base >= Number.MAX_SAFE_INTEGER - inc) return Number.MAX_SAFE_INTEGER;
  return base + inc;
}

function safeAddSignedNonNegative(current: number, delta: number): number {
  const base = Number.isFinite(current) && current > 0 ? current : 0;
  const d = safeSignedDelta(delta);
  if (d === 0) return base;
  if (d > 0) {
    return base >= Number.MAX_SAFE_INTEGER - d ? Number.MAX_SAFE_INTEGER : base + d;
  }
  return Math.max(0, base + d);
}

function isValidId(value: string): boolean {
  return typeof value === "string" && value.length > 0 && value.length <= MAX_ID_LENGTH;
}

function evictOldestIfFull<K, V>(map: Map<K, V>, cap: number): void {
  while (map.size >= cap) {
    const oldest = map.keys().next();
    if (oldest.done) break;
    map.delete(oldest.value);
  }
}

function zeroTotals(): UsageTotals {
  return {
    docReads: 0,
    docWrites: 0,
    docDeletes: 0,
    storageBytes: 0,
    egressBytes: 0,
    authMau: 0,
    peakConcurrentWs: 0,
  };
}

function zeroPending(): PendingDelta {
  return {
    docReads: 0,
    docWrites: 0,
    docDeletes: 0,
    storageBytes: 0,
    egressBytes: 0,
    peakWs: 0,
    authUsers: new Set<string>(),
  };
}

function newGroupState(): GroupState {
  return { ...zeroTotals(), currentWs: 0, authUsers: new Set<string>() };
}

/**
 * Adds to a bounded insertion-ordered set; evicts the oldest entry at capacity
 * so a single project can never grow the MAU set without limit.
 * Returns true only when the user was actually new this month.
 */
function addBounded(set: Set<string>, value: string, cap: number): boolean {
  if (set.has(value)) return false;
  if (set.size >= cap) {
    const oldest = set.values().next();
    if (!oldest.done && oldest.value !== undefined) set.delete(oldest.value);
  }
  set.add(value);
  return true;
}

function groupKey(orgId: string, projectId: string, month: string): string {
  return `${orgId}|${projectId}|${month}`;
}


function resolveChainKey(options: UsageMeteringEngineOptions): Buffer {
  if (options.chainKey !== undefined) return Buffer.from(options.chainKey);
  const masterKey =
    options.masterKey ??
    process.env["VELLUM_BILLING_LEDGER_MASTER_KEY"] ??
    process.env["VELLUM_BILLING_LEDGER_MASTER_KEY"] ??
    DEFAULT_LEDGER_MASTER_KEY;
  return deriveChainKey(masterKey, "billing-ledger-v1");
}

export class UsageMeteringEngine implements MeteringPort {
  private readonly billing: BillingRepository;
  private readonly chainKey: Buffer;
  private readonly now: () => number;
  private readonly logger: MeteringLogger | undefined;

  /** The ONLY map the hot path writes. Swapped atomically at flush start. */
  private pendingDeltas: Map<string, PendingDelta> = new Map<string, PendingDelta>();

  /** Cumulative absolute totals, keyed by the same composite key as pending. */
  private readonly groupStates = new Map<string, GroupState>();
  private readonly orgTotals = new Map<string, OrgRealtime>();

  private cachedMonth = "";
  private cachedDate = "";
  private periodCachedAt = Number.NEGATIVE_INFINITY;

  private timer: ReturnType<typeof setInterval> | null = null;
  private inFlight: Promise<FlushResult> | null = null;
  private flushSeq = 0;
  private lastFlushAt = 0;
  private ledgerSeq: number | null = null;
  private nextLedgerSeq = 1;
  private ledgerSeqSeeded = false;

  constructor(options: UsageMeteringEngineOptions) {
    this.billing = options.billing;
    this.chainKey = resolveChainKey(options);
    this.now = options.now ?? Date.now;
    this.logger = options.logger;
  }

  // -------------------------------------------------------------------------
  // Hot path — synchronous, O(1), zero DB I/O.
  // -------------------------------------------------------------------------

  public recordReads(orgId: string, projectId: string, count: number): void {
    const safeCount = safePositiveInt(count);
    if (safeCount === 0 || !isValidId(orgId) || !isValidId(projectId)) return;
    const context = this.contextFor(orgId, projectId);
    context.group.docReads = safeAdd(context.group.docReads, safeCount);
    context.org.docReads = safeAdd(context.org.docReads, safeCount);
    context.pending.docReads = safeAdd(context.pending.docReads, safeCount);
  }

  public recordWrites(
    orgId: string,
    projectId: string,
    count: number,
    storageDeltaBytes: number
  ): void {
    const safeCount = safePositiveInt(count);
    const safeDelta = safeSignedDelta(storageDeltaBytes);
    if ((safeCount === 0 && safeDelta === 0) || !isValidId(orgId) || !isValidId(projectId)) return;
    const context = this.contextFor(orgId, projectId);
    if (safeCount > 0) {
      context.group.docWrites = safeAdd(context.group.docWrites, safeCount);
      context.org.docWrites = safeAdd(context.org.docWrites, safeCount);
      context.pending.docWrites = safeAdd(context.pending.docWrites, safeCount);
    }
    this.applyStorageDelta(context, safeDelta);
  }

  public recordDeletes(
    orgId: string,
    projectId: string,
    count: number,
    storageDeltaBytes: number
  ): void {
    const safeCount = safePositiveInt(count);
    const safeDelta = safeSignedDelta(storageDeltaBytes);
    if ((safeCount === 0 && safeDelta === 0) || !isValidId(orgId) || !isValidId(projectId)) return;
    const context = this.contextFor(orgId, projectId);
    if (safeCount > 0) {
      context.group.docDeletes = safeAdd(context.group.docDeletes, safeCount);
      context.org.docDeletes = safeAdd(context.org.docDeletes, safeCount);
      context.pending.docDeletes = safeAdd(context.pending.docDeletes, safeCount);
    }
    this.applyStorageDelta(context, safeDelta);
  }

  public recordEgress(orgId: string, projectId: string, bytes: number): void {
    const safeBytes = safePositiveInt(bytes);
    if (safeBytes === 0 || !isValidId(orgId) || !isValidId(projectId)) return;
    const context = this.contextFor(orgId, projectId);
    context.group.egressBytes = safeAdd(context.group.egressBytes, safeBytes);
    context.org.egressBytes = safeAdd(context.org.egressBytes, safeBytes);
    context.pending.egressBytes = safeAdd(context.pending.egressBytes, safeBytes);
  }

  public recordActiveAuthUser(orgId: string, projectId: string, userId: string): void {
    if (!isValidId(userId) || !isValidId(orgId) || !isValidId(projectId)) return;
    const context = this.contextFor(orgId, projectId);
    if (addBounded(context.group.authUsers, userId, MAX_AUTH_USERS_PER_PROJECT)) {
      context.group.authMau = context.group.authUsers.size;
      addBounded(context.pending.authUsers, userId, MAX_AUTH_USERS_PER_PROJECT);
    }
    if (addBounded(context.org.authUsers, userId, MAX_AUTH_USERS_PER_PROJECT)) {
      context.org.authMau = context.org.authUsers.size;
    }
  }

  public recordWsConnectionDelta(orgId: string, projectId: string, delta: 1 | -1): void {
    if ((delta !== 1 && delta !== -1) || !isValidId(orgId) || !isValidId(projectId)) return;
    const context = this.contextFor(orgId, projectId);
    context.group.currentWs = safeAddSignedNonNegative(context.group.currentWs, delta);
    context.org.currentWs = safeAddSignedNonNegative(context.org.currentWs, delta);
    if (context.group.currentWs > context.group.peakConcurrentWs) {
      context.group.peakConcurrentWs = context.group.currentWs;
    }
    if (context.org.currentWs > context.org.peakConcurrentWs) {
      context.org.peakConcurrentWs = context.org.currentWs;
    }
    context.pending.peakWs = context.group.peakConcurrentWs;
  }

  /** Read-only snapshot copy of the live org totals. */
  public totalsFor(orgId: string): Readonly<UsageTotals> {
    const totals = this.orgTotals.get(orgId);
    return totals ? { ...totalsToPlain(totals) } : zeroTotals();
  }

  // -------------------------------------------------------------------------
  // Flush path — persistence, ledger chain, lifecycle.
  // -------------------------------------------------------------------------

  public flush(): Promise<FlushResult> {
    if (this.inFlight !== null) {
      return this.inFlight.then(() => this.flush());
    }
    const run = this.flushCycle();
    this.inFlight = run;
    return run.finally(() => {
      if (this.inFlight === run) this.inFlight = null;
    });
  }

  /**
   * Request-driven flush for runtimes that suspend idle processes (serverless): when the last
   * flush is older than `intervalMs`, start one in the background. Never throws, never awaits.
   */
  public flushIfDue(intervalMs = 5000): void {
    const now = this.now();
    if (this.inFlight !== null || now - this.lastFlushAt < intervalMs) return;
    this.lastFlushAt = now;
    void this.flush().catch((error: unknown) => {
      this.logError("billing metering flush failed", error);
    });
  }

  public start(intervalMs = 5000): void {
    this.stopTimer();
    const safeInterval = Number.isFinite(intervalMs) && intervalMs >= MIN_FLUSH_INTERVAL_MS
      ? Math.trunc(intervalMs)
      : 5000;
    const timer = setInterval(() => {
      void this.flush().catch((error: unknown) => {
        this.logError("billing metering flush failed", error);
      });
    }, safeInterval);
    const unref = (timer as { unref?: () => void }).unref;
    if (typeof unref === "function") unref.call(timer);
    this.timer = timer;
  }

  public async stop(): Promise<void> {
    this.stopTimer();
    await this.flush();
  }

  private stopTimer(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private async flushCycle(): Promise<FlushResult> {
    // Atomic swap: from this instant all record* calls write to the new map.
    const pending = this.pendingDeltas;
    this.pendingDeltas = new Map<string, PendingDelta>();

    if (pending.size === 0) {
      return { flushedGroups: 0, ledgerSeq: this.ledgerSeq };
    }

    const cycleId = `${++this.flushSeq}:${this.now()}`;
    const { date: usageDate } = this.periodSnapshot();
    const orgAggregates = new Map<string, OrgFlushAggregate>();
    let flushed = 0;

    for (const [key, delta] of pending) {
      const [orgId = "", projectId = "", month = ""] = key.split("|");
      if (orgId === "" || month === "") continue;

      // Additive, atomic in the database: instances never overwrite each other's usage.
      let monthly: UsageMonthlyInput;
      try {
        const result = await this.billing.applyUsageDelta({
          orgId,
          projectId,
          billingMonth: month,
          usageDate,
          docReads: delta.docReads,
          docWrites: delta.docWrites,
          docDeletes: delta.docDeletes,
          storageBytes: delta.storageBytes,
          egressBytes: delta.egressBytes,
          peakConcurrentWs: delta.peakWs,
          authUserIds: [...delta.authUsers],
        });
        monthly = result.monthly;
      } catch (error) {
        // Nothing was written for this group: put its delta back so the next cycle retries it.
        this.requeue(key, delta);
        this.logError("billing metering group flush failed", error);
        continue;
      }
      flushed += 1;

      const aggregateKey = `${orgId}|${month}`;
      let aggregate = orgAggregates.get(aggregateKey);
      if (!aggregate) {
        aggregate = { month, groups: 0, totals: zeroTotals() };
        orgAggregates.set(aggregateKey, aggregate);
      }
      aggregate.groups += 1;
      aggregate.totals.docReads = safeAdd(aggregate.totals.docReads, monthly.docReads);
      aggregate.totals.docWrites = safeAdd(aggregate.totals.docWrites, monthly.docWrites);
      aggregate.totals.docDeletes = safeAdd(aggregate.totals.docDeletes, monthly.docDeletes);
      aggregate.totals.storageBytes = safeAdd(aggregate.totals.storageBytes, monthly.storageBytes);
      aggregate.totals.egressBytes = safeAdd(aggregate.totals.egressBytes, monthly.egressBytes);
      aggregate.totals.authMau = safeAdd(aggregate.totals.authMau, monthly.authMau);
      aggregate.totals.peakConcurrentWs = Math.max(
        aggregate.totals.peakConcurrentWs,
        monthly.peakConcurrentWs
      );
    }

    await this.appendFlushLedgerEntries(orgAggregates, cycleId);
    return { flushedGroups: flushed, ledgerSeq: this.ledgerSeq };
  }

  private requeue(key: string, delta: PendingDelta): void {
    const current = this.pendingDeltas.get(key);
    if (!current) {
      this.pendingDeltas.set(key, delta);
      return;
    }
    current.docReads = safeAdd(current.docReads, delta.docReads);
    current.docWrites = safeAdd(current.docWrites, delta.docWrites);
    current.docDeletes = safeAdd(current.docDeletes, delta.docDeletes);
    current.egressBytes = safeAdd(current.egressBytes, delta.egressBytes);
    current.storageBytes = safeSignedDelta(current.storageBytes + delta.storageBytes);
    current.peakWs = Math.max(current.peakWs, delta.peakWs);
    for (const id of delta.authUsers) current.authUsers.add(id);
  }

  private async appendFlushLedgerEntries(
    aggregates: Map<string, OrgFlushAggregate>,
    cycleId: string
  ): Promise<void> {
    if (aggregates.size === 0) return;
    await this.seedLedgerSeq();

    let prevHash = (await this.billing.getLastLedgerHash()) ?? GENESIS_HASH;
    let seq = this.nextLedgerSeq;

    for (const [key, aggregate] of aggregates) {
      const [orgId = "", month = ""] = key.split("|");
      if (orgId === "" || month === "") continue;
      const timestampIso = new Date(this.now()).toISOString();
      const payload: Record<string, unknown> = {
        kind: "usage_flush",
        orgId,
        billingMonth: month,
        groups: aggregate.groups,
        totals: { ...aggregate.totals },
      };
      const entryHash = computeChainHash(this.chainKey, seq, prevHash, timestampIso, payload);
      const entry = await this.billing.appendLedgerEntry({
        orgId,
        billingMonth: month,
        entryType: "usage_flush",
        amountCents: 0,
        metricSnapshot: { ...payload, timestampIso },
        idempotencyKey: `flush:${month}:${orgId}:${cycleId}`,
        description: `Usage flush ${month} (${aggregate.groups} group(s))`,
        prevHash,
        entryHash,
      });
      prevHash = entry.entryHash;
      this.ledgerSeq = entry.seq;
      // Never move the counter backwards on an idempotent replay.
      this.nextLedgerSeq = Math.max(this.nextLedgerSeq, entry.seq + 1);
      seq = this.nextLedgerSeq;
    }
  }

  /**
   * Re-read the authoritative maximum sequence before EVERY flush cycle.
   * Seeding only once lets the local counter drift behind the database's
   * BIGSERIAL (e.g. after an idempotent duplicate or a second writer), which
   * produces entries whose stored `seq` differs from the `seq` that was
   * signed — an entry_hash_mismatch in the chain verifier.
   */
  private async seedLedgerSeq(): Promise<void> {
    const rows = await this.billing.listLedger();
    let maxSeq = 0;
    for (const row of rows) {
      if (row.seq > maxSeq) maxSeq = row.seq;
    }
    this.nextLedgerSeq = Math.max(this.nextLedgerSeq, maxSeq + 1);
    this.ledgerSeqSeeded = true;
  }

  // -------------------------------------------------------------------------
  // Internal helpers
  // -------------------------------------------------------------------------

  private applyStorageDelta(
    context: { group: GroupState; org: OrgRealtime; pending: PendingDelta },
    storageDeltaBytes: number
  ): void {
    const safeDelta = safeSignedDelta(storageDeltaBytes);
    if (safeDelta === 0) return;
    const before = context.group.storageBytes;
    const after = safeAddSignedNonNegative(before, safeDelta);
    const applied = after - before;
    if (applied === 0) return;
    context.group.storageBytes = after;
    context.org.storageBytes = safeAddSignedNonNegative(context.org.storageBytes, applied);
    context.pending.storageBytes = safeSignedDelta(context.pending.storageBytes + applied);
  }

  private contextFor(
    orgId: string,
    projectId: string
  ): { group: GroupState; org: OrgRealtime; pending: PendingDelta } {
    const { month } = this.periodSnapshot();
    const key = groupKey(orgId, projectId, month);

    let group = this.groupStates.get(key);
    if (!group) {
      evictOldestIfFull(this.groupStates, MAX_GROUP_STATES);
      group = newGroupState();
      this.groupStates.set(key, group);
    }
    let pending = this.pendingDeltas.get(key);
    if (!pending) {
      pending = zeroPending();
      this.pendingDeltas.set(key, pending);
    }
    let org = this.orgTotals.get(orgId);
    if (!org) {
      evictOldestIfFull(this.orgTotals, MAX_ORG_STATES);
      org = { ...zeroTotals(), currentWs: 0, authUsers: new Set<string>() };
      this.orgTotals.set(orgId, org);
    }
    return { group, org, pending };
  }

  /** Cached UTC YYYY-MM / YYYY-MM-DD snapshot; still O(1) per hot-path call. */
  private periodSnapshot(): { month: string; date: string } {
    const rawNow = this.now();
    const now = Number.isFinite(rawNow) ? rawNow : Date.now();
    if (now < this.periodCachedAt || now - this.periodCachedAt >= 1000) {
      const iso = new Date(now).toISOString();
      this.cachedMonth = iso.slice(0, 7);
      this.cachedDate = iso.slice(0, 10);
      this.periodCachedAt = now;
    }
    return { month: this.cachedMonth, date: this.cachedDate };
  }

  private logError(message: string, error: unknown): void {
    try {
      this.logger?.error?.(message, error);
    } catch {
      // A broken logger must never break metering or shutdown.
    }
  }
}

function totalsToPlain(totals: OrgRealtime): UsageTotals {
  return {
    docReads: totals.docReads,
    docWrites: totals.docWrites,
    docDeletes: totals.docDeletes,
    storageBytes: totals.storageBytes,
    egressBytes: totals.egressBytes,
    authMau: totals.authMau,
    peakConcurrentWs: totals.peakConcurrentWs,
  };
}
