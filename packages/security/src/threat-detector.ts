/**
 * @vellum/security - In-process threat detection and instant block cache.
 *
 * The sliding windows, event buffer, and block cache are strictly bounded with
 * O(1) insertion-order LRU eviction to prevent memory exhaustion under IP or
 * tenant flooding. Durable blocklist state is owned by the control plane and
 * synced into the synchronous cache via `refreshFromStore()`.
 *
 * Zero external runtime dependencies: only `node:crypto` is used.
 */

import { randomUUID } from "node:crypto";
import type { ThreatCategory } from "./types.js";

// Re-exported so consumers can import the taxonomy from this module directly.
export type { ThreatCategory };

export type BlockTargetType = "ip" | "api_key_id" | "org_id" | "project_id";

export interface BlocklistEntry {
  targetType: BlockTargetType;
  targetValue: string;
  reason: string;
  expiresAt: string | null;
  active: boolean;
}

export interface ThreatEvent {
  id: string;
  severity: "low" | "medium" | "high" | "critical";
  category: ThreatCategory;
  sourceIp?: string;
  actorId?: string;
  orgId?: string;
  projectId?: string;
  summary: string;
  evidence: Record<string, unknown>;
  autoMitigated: boolean;
  createdAt: string;
}

/** Input shape for ThreatDetector.record(), tolerant of explicit undefined under exactOptionalPropertyTypes. */
export interface ThreatEventRecordInput {
  severity: ThreatEvent["severity"];
  category: ThreatCategory;
  sourceIp?: string | undefined;
  actorId?: string | undefined;
  orgId?: string | undefined;
  projectId?: string | undefined;
  summary: string;
  evidence: Record<string, unknown>;
  autoMitigated?: boolean | undefined;
}

export interface BlockDecision {
  blocked: boolean;
  reason?: string;
  expiresAt?: string;
}

const MAX_TRACKED_IPS = 10_000;
const MAX_TRACKED_KEYS = 10_000;
const MAX_CACHED_BLOCKS = 50_000;
const MAX_STORED_EVENTS = 10_000;
const MAX_TIMESTAMPS_PER_BUCKET = 1_000;
const MAX_IDENTIFIER_LENGTH = 256;
const MAX_REASON_LENGTH = 1_024;
const FIVE_MIN_MS = 5 * 60 * 1000;
const TEN_MIN_MS = 10 * 60 * 1000;
const FIFTEEN_MIN_MS = 15 * 60 * 1000;
const SIXTY_MIN_MS = 60 * 60 * 1000;

const BRUTE_FORCE_THRESHOLD = 20;
const PROTOTYPE_SSRF_THRESHOLD = 3;
const CROSS_TENANT_THRESHOLD = 5;

const CONTROL_CHAR_REGEX = /[\x00-\x1f\x7f]/g;

interface IpWindowBucket {
  lastAccess: number;
  bruteForce: number[];
  prototypeSsrf: number[];
  crossTenant: number[];
}

interface KeyWindowBucket {
  lastAccess: number;
  timestamps: number[];
}

interface CachedBlock {
  reason: string;
  expiresAt: string | null;
  expiresAtEpoch: number | null;
}

/** Sanitize untrusted IP/identifier strings: strip control chars and cap length. */
function sanitizeIdentifier(value: string): string {
  const cleaned = value.replace(CONTROL_CHAR_REGEX, "").trim();
  return cleaned.length > MAX_IDENTIFIER_LENGTH
    ? cleaned.slice(0, MAX_IDENTIFIER_LENGTH)
    : cleaned;
}

/** Drop timestamps at or before the window cutoff and cap length. Input is chronological. */
function pruneTimestamps(timestamps: number[], now: number, windowMs: number): number[] {
  const cutoff = now - windowMs;
  let keepFrom = 0;
  while (keepFrom < timestamps.length && (timestamps[keepFrom] ?? 0) <= cutoff) {
    keepFrom++;
  }
  const minKeep = Math.max(keepFrom, timestamps.length - MAX_TIMESTAMPS_PER_BUCKET + 1);
  return minKeep <= 0 ? timestamps : timestamps.slice(minKeep);
}

/** Parse ISO expiry into epoch ms, or null if perpetual, or NaN if invalid. */
function parseExpiryEpoch(expiresAt: string | null): number | null {
  if (expiresAt === null) {
    return null;
  }
  return Date.parse(expiresAt);
}

/** Expired or unparsable expiry means the block is no longer in force. */
function isExpiredEpoch(expiresAtEpoch: number | null, now: number): boolean {
  if (expiresAtEpoch === null) {
    return false;
  }
  return Number.isNaN(expiresAtEpoch) || expiresAtEpoch <= now;
}

/** O(1) eviction of the oldest entry in an insertion-ordered Map when at capacity. */
function evictOldestIfFull<K, V>(map: Map<K, V>, cap: number): void {
  while (map.size >= cap) {
    const oldest = map.keys().next();
    if (oldest.done) {
      break;
    }
    map.delete(oldest.value);
  }
}

export class ThreatDetector {
  private readonly events: ThreatEvent[] = [];
  private readonly ipWindows = new Map<string, IpWindowBucket>();
  private readonly keyWindows = new Map<string, KeyWindowBucket>();

  // Kept in sync with the cache so the hot path is a plain O(1) Set.has() lookup.
  private blockCache: Map<string, CachedBlock> = new Map<string, CachedBlock>();
  private blockedKeys: Set<string> = new Set<string>();

  /**
   * Record exactly one threat event, update the relevant sliding windows and
   * apply any locked auto-mitigation threshold that has been reached.
   */
  record(input: ThreatEventRecordInput): ThreatEvent {
    const now = Date.now();
    let severity: ThreatEvent["severity"] = input.severity;
    let autoMitigated = input.autoMitigated ?? false;

    const rawSourceIp = typeof input.sourceIp === "string" ? sanitizeIdentifier(input.sourceIp) : "";
    const sourceIp = rawSourceIp.length > 0 ? rawSourceIp : null;
    const rawActorId = typeof input.actorId === "string" ? sanitizeIdentifier(input.actorId) : "";
    const actorId = rawActorId.length > 0 ? rawActorId : null;
    const rawOrgId = typeof input.orgId === "string" ? sanitizeIdentifier(input.orgId) : "";
    const orgId = rawOrgId.length > 0 ? rawOrgId : null;
    const rawProjectId = typeof input.projectId === "string" ? sanitizeIdentifier(input.projectId) : "";
    const projectId = rawProjectId.length > 0 ? rawProjectId : null;

    let bruteForceCount = 0;
    let prototypeSsrfCount = 0;
    let crossTenantCount = 0;

    if (sourceIp !== null) {
      const bucket = this.touchIpWindow(sourceIp, now);
      bucket.bruteForce = pruneTimestamps(bucket.bruteForce, now, FIVE_MIN_MS);
      bucket.prototypeSsrf = pruneTimestamps(bucket.prototypeSsrf, now, TEN_MIN_MS);
      bucket.crossTenant = pruneTimestamps(bucket.crossTenant, now, FIVE_MIN_MS);

      if (input.category === "brute_force") {
        bucket.bruteForce.push(now);
      } else if (input.category === "prototype_pollution" || input.category === "ssrf_attempt") {
        bucket.prototypeSsrf.push(now);
      } else if (input.category === "cross_tenant_probe") {
        bucket.crossTenant.push(now);
      }

      bruteForceCount = bucket.bruteForce.length;
      prototypeSsrfCount = bucket.prototypeSsrf.length;
      crossTenantCount = bucket.crossTenant.length;
    }

    if (actorId !== null) {
      const keyBucket = this.touchKeyWindow(actorId, now);
      keyBucket.timestamps = pruneTimestamps(keyBucket.timestamps, now, TEN_MIN_MS);
      keyBucket.timestamps.push(now);
    }

    if (bruteForceCount >= BRUTE_FORCE_THRESHOLD) {
      severity = "high";
      autoMitigated = true;
      if (sourceIp !== null) {
        this.block("ip", sourceIp, `brute_force:${bruteForceCount}_failures_5m`, FIFTEEN_MIN_MS);
      }
    } else if (prototypeSsrfCount >= PROTOTYPE_SSRF_THRESHOLD) {
      severity = "critical";
      autoMitigated = true;
      if (sourceIp !== null) {
        this.block("ip", sourceIp, `injection_or_ssrf:${prototypeSsrfCount}_events_10m`, SIXTY_MIN_MS);
      }
    } else if (crossTenantCount >= CROSS_TENANT_THRESHOLD) {
      // Alert surfaces through getOpenThreats(); no automatic IP block here.
      severity = "critical";
      autoMitigated = true;
    }

    const safeEvidence: Record<string, unknown> =
      input.evidence !== null && typeof input.evidence === "object" && !Array.isArray(input.evidence)
        ? { ...input.evidence }
        : {};

    const event: ThreatEvent = {
      id: randomUUID(),
      severity,
      category: input.category,
      ...(sourceIp === null ? {} : { sourceIp }),
      ...(actorId === null ? {} : { actorId }),
      ...(orgId === null ? {} : { orgId }),
      ...(projectId === null ? {} : { projectId }),
      summary: typeof input.summary === "string" ? input.summary.slice(0, MAX_REASON_LENGTH) : "",
      evidence: safeEvidence,
      autoMitigated,
      createdAt: new Date(now).toISOString(),
    };

    if (this.events.length >= MAX_STORED_EVENTS) {
      // Drop the oldest 10% in one amortized slice to keep memory strictly bounded.
      this.events.splice(0, Math.max(1, Math.floor(MAX_STORED_EVENTS / 10)));
    }
    this.events.push(event);
    return { ...event, evidence: { ...event.evidence } };
  }

  /** Synchronous O(1) block check. Lazily removes an entry once it expires. */
  isBlocked(targetType: BlockTargetType, value: string): BlockDecision {
    if (typeof value !== "string") {
      return { blocked: false };
    }
    const sanitized = sanitizeIdentifier(value);
    if (sanitized.length === 0) {
      return { blocked: false };
    }
    const key = `${targetType}|${sanitized}`;
    if (!this.blockedKeys.has(key)) {
      return { blocked: false };
    }
    const cached: CachedBlock | undefined = this.blockCache.get(key);
    if (cached === undefined) {
      // Defensive: the Set and cache must stay in sync.
      this.blockedKeys.delete(key);
      return { blocked: false };
    }
    if (isExpiredEpoch(cached.expiresAtEpoch, Date.now())) {
      this.blockedKeys.delete(key);
      this.blockCache.delete(key);
      return { blocked: false };
    }
    return {
      blocked: true,
      reason: cached.reason,
      ...(cached.expiresAt === null ? {} : { expiresAt: cached.expiresAt }),
    };
  }

  /** Add or replace a block immediately, with an optional TTL in milliseconds. */
  block(targetType: BlockTargetType, value: string, reason: string, ttlMs: number | null): void {
    if (typeof value !== "string") {
      return;
    }
    const sanitized = sanitizeIdentifier(value);
    if (sanitized.length === 0) {
      return;
    }
    let expiresAt: string | null = null;
    let expiresAtEpoch: number | null = null;
    if (ttlMs !== null) {
      if (!Number.isFinite(ttlMs) || ttlMs <= 0) {
        return;
      }
      expiresAtEpoch = Date.now() + ttlMs;
      if (!Number.isFinite(expiresAtEpoch)) {
        return;
      }
      expiresAt = new Date(expiresAtEpoch).toISOString();
    }

    const key = `${targetType}|${sanitized}`;
    const safeReason = typeof reason === "string"
      ? reason.replace(CONTROL_CHAR_REGEX, "").slice(0, MAX_REASON_LENGTH)
      : "blocked";

    if (this.blockCache.has(key)) {
      this.blockCache.delete(key);
    } else if (this.blockCache.size >= MAX_CACHED_BLOCKS) {
      const oldest = this.blockCache.keys().next();
      if (!oldest.done) {
        this.blockCache.delete(oldest.value);
        this.blockedKeys.delete(oldest.value);
      }
    }

    this.blockCache.set(key, { reason: safeReason, expiresAt, expiresAtEpoch });
    this.blockedKeys.add(key);
  }

  /** Remove a block from the hot cache immediately. */
  unblock(targetType: BlockTargetType, value: string): void {
    if (typeof value !== "string") {
      return;
    }
    const sanitized = sanitizeIdentifier(value);
    if (sanitized.length === 0) {
      return;
    }
    const key = `${targetType}|${sanitized}`;
    this.blockCache.delete(key);
    this.blockedKeys.delete(key);
  }

  /** Atomically swap the cache with active, unexpired rows from the store. */
  refreshFromStore(entries: readonly BlocklistEntry[]): void {
    const now = Date.now();
    const nextCache = new Map<string, CachedBlock>();
    for (const entry of entries) {
      if (!entry.active || typeof entry.targetValue !== "string") {
        continue;
      }
      const sanitized = sanitizeIdentifier(entry.targetValue);
      if (sanitized.length === 0) {
        continue;
      }
      const expiresAtEpoch = parseExpiryEpoch(entry.expiresAt);
      if (isExpiredEpoch(expiresAtEpoch, now)) {
        continue;
      }
      const key = `${entry.targetType}|${sanitized}`;
      if (nextCache.has(key)) {
        nextCache.delete(key);
      } else if (nextCache.size >= MAX_CACHED_BLOCKS) {
        const oldest = nextCache.keys().next();
        if (!oldest.done) {
          nextCache.delete(oldest.value);
        }
      }
      nextCache.set(key, {
        reason: typeof entry.reason === "string"
          ? entry.reason.replace(CONTROL_CHAR_REGEX, "").slice(0, MAX_REASON_LENGTH)
          : "blocked",
        expiresAt: entry.expiresAt,
        expiresAtEpoch,
      });
    }
    this.blockCache = nextCache;
    this.blockedKeys = new Set<string>(nextCache.keys());
  }

  /** All recorded threats, including the ones that crossed an alert threshold. */
  getOpenThreats(): ThreatEvent[] {
    return this.events.map((event) => ({ ...event, evidence: { ...event.evidence } }));
  }

  stats(): { trackedIps: number; cachedBlocks: number; events: number } {
    return {
      trackedIps: this.ipWindows.size,
      cachedBlocks: this.blockCache.size,
      events: this.events.length,
    };
  }

  /** Get or create an IP window with O(1) LRU promotion and eviction. */
  private touchIpWindow(ip: string, now: number): IpWindowBucket {
    const existing = this.ipWindows.get(ip);
    if (existing !== undefined) {
      existing.lastAccess = now;
      // O(1) LRU promotion via Map insertion order.
      this.ipWindows.delete(ip);
      this.ipWindows.set(ip, existing);
      return existing;
    }
    evictOldestIfFull(this.ipWindows, MAX_TRACKED_IPS);
    const created: IpWindowBucket = {
      lastAccess: now,
      bruteForce: [],
      prototypeSsrf: [],
      crossTenant: [],
    };
    this.ipWindows.set(ip, created);
    return created;
  }

  /** Get or create a per-key window with O(1) LRU promotion and eviction. */
  private touchKeyWindow(actorId: string, now: number): KeyWindowBucket {
    const existing = this.keyWindows.get(actorId);
    if (existing !== undefined) {
      existing.lastAccess = now;
      this.keyWindows.delete(actorId);
      this.keyWindows.set(actorId, existing);
      return existing;
    }
    evictOldestIfFull(this.keyWindows, MAX_TRACKED_KEYS);
    const created: KeyWindowBucket = { lastAccess: now, timestamps: [] };
    this.keyWindows.set(actorId, created);
    return created;
  }
}
