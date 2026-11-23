/**
 * Shared, dependency-free harness for the engine-hardening regression suites.
 *
 * This file is NOT a `*.test.ts` (vitest will not collect it); it only holds
 * fixtures and small test doubles so every hardening suite uses the exact same
 * tenant ids, key shapes and sink recording conventions.
 */
import { type TenantContext, type TxHandle } from "@vellum/storage";
import { DataPlaneStore } from "@vellum/storage/adapters";
import { DocumentEngine } from "../engine.js";
import type {
  AuditLike,
  DocumentEngineOptions,
  MeteringLike,
  RateLimiterLike,
  RealtimeHubLike,
  TelemetryLike,
} from "../types.js";

/** Stable tenant used by all pre-existing engine unit suites. */
export const TENANT = {
  projectId: "11111111-1111-1111-1111-111111111111",
  /** Trusted test caller: permits the engine's fail-closed synthetic key path. */
  internal: true as const,
};

/** Second tenant for cross-tenant isolation assertions. */
export const OTHER_TENANT = {
  projectId: "33333333-3333-3333-3333-333333333333",
  internal: true as const,
};

export interface UsageEvent {
  projectId: string;
  usage: {
    documentReads?: number;
    documentWrites?: number;
    documentDeletes?: number;
    storageBytesDelta?: number;
    egressBytes?: number;
  };
}

export class RecordingControlStore {
  public readonly usageEvents: UsageEvent[] = [];
  public ruleset: unknown = null;

  public getActiveRuleset(): unknown {
    return this.ruleset;
  }

  public incrementUsage(projectId: string, usage: UsageEvent["usage"]): void {
    this.usageEvents.push({ projectId, usage });
  }
}

export interface SinkCall {
  action: string;
  metadata?: Record<string, unknown> | undefined;
}

export class RecordingAudit implements AuditLike {
  public readonly calls: SinkCall[] = [];

  public log(action: string, input: { metadata?: Record<string, unknown> }): void {
    this.calls.push({ action, metadata: input.metadata });
  }
}

export class RecordingMetering implements MeteringLike {
  public readonly calls: Array<{
    orgId: string;
    projectId: string;
    count: number;
    storageDeltaBytes: number;
  }> = [];

  public recordDeletes(
    orgId: string,
    projectId: string,
    count: number,
    storageDeltaBytes: number
  ): void {
    this.calls.push({ orgId, projectId, count, storageDeltaBytes });
  }
}

export class RecordingRealtime implements RealtimeHubLike {
  public readonly calls: Array<{ projectId: string; events: unknown[] }> = [];

  public notifyCommittedEvents(projectId: string, events: unknown[]): void {
    this.calls.push({ projectId, events });
  }
}

export class RecordingTelemetry implements TelemetryLike {
  public readonly counters = new Map<string, number>();
  public readonly histograms = new Map<string, number[]>();
  public readonly spans: string[] = [];

  public async span<T>(name: string, fn: () => Promise<T> | T): Promise<T> {
    this.spans.push(name);
    return fn();
  }

  public counter(name: string, value = 1): void {
    this.counters.set(name, (this.counters.get(name) ?? 0) + value);
  }

  public histogram(name: string, value: number): void {
    const list = this.histograms.get(name) ?? [];
    list.push(value);
    this.histograms.set(name, list);
  }
}

export interface FixtureOptions {
  dataStore?: DataPlaneStore;
  ruleset?: unknown;
  realtimeHub?: RealtimeHubLike;
  metering?: MeteringLike;
  audit?: AuditLike;
  telemetry?: TelemetryLike;
  rateLimiter?: RateLimiterLike;
  txSecret?: string;
  txSecretPrev?: string;
}

export interface Fixture {
  engine: DocumentEngine;
  store: DataPlaneStore;
  control: RecordingControlStore;
  realtime: RealtimeHubLike | null;
  metering: MeteringLike | null;
  audit: AuditLike | null;
  telemetry: TelemetryLike | null;
}

/**
 * Builds an engine on an isolated in-memory data plane. All optional sinks are
 * recorded so best-effort failure injection can be asserted deterministically.
 */
export function createFixture(options: FixtureOptions = {}): Fixture {
  const store = options.dataStore ?? new DataPlaneStore();
  const control = new RecordingControlStore();
  if (options.ruleset !== undefined) control.ruleset = options.ruleset;

  const realtime = options.realtimeHub ?? new RecordingRealtime();
  const metering = options.metering ?? new RecordingMetering();
  const audit = options.audit ?? new RecordingAudit();
  const telemetry = options.telemetry ?? new RecordingTelemetry();

  const engineOptions: DocumentEngineOptions = {
    controlStore: control,
    dataStore: store,
    realtimeHub: realtime,
    metering,
    audit,
    telemetry,
    ...(options.rateLimiter !== undefined ? { rateLimiter: options.rateLimiter } : {}),
    ...(options.txSecret !== undefined ? { txSecret: options.txSecret } : {}),
    ...(options.txSecretPrev !== undefined ? { txSecretPrev: options.txSecretPrev } : {}),
  };

  return {
    engine: new DocumentEngine(engineOptions),
    store,
    control,
    realtime: options.realtimeHub === undefined ? realtime : null,
    metering: options.metering === undefined ? metering : null,
    audit: options.audit === undefined ? audit : null,
    telemetry: options.telemetry === undefined ? telemetry : null,
  };
}

/** A structurally-valid server key record for scope / tenant tests. */
export function serverKey(
  id: string,
  scopes: string[] = ["documents:read", "documents:write"]
): {
  id: string;
  projectId: string;
  name: string;
  keyType: "server";
  keyPrefix: string;
  secretHash: string;
  scopes: string[];
  rateLimitRps: number;
  lastUsedAt: string | null;
  expiresAt: string | null;
  revokedAt: string | null;
  createdBy: string | null;
  createdAt: string;
} {
  return {
    id,
    projectId: TENANT.projectId,
    name: `server-${id}`,
    keyType: "server",
    keyPrefix: "sk_test",
    secretHash: "hash",
    scopes,
    rateLimitRps: 1000,
    lastUsedAt: null,
    expiresAt: null,
    revokedAt: null,
    createdBy: null,
    createdAt: "2026-01-01T00:00:00.000Z",
  };
}

/** A structurally-valid public key record (Security Rules are always evaluated). */
export function publicKey(id = "pk_test"): {
  id: string;
  projectId: string;
  name: string;
  keyType: "public";
  keyPrefix: string;
  secretHash: string;
  scopes: string[];
  rateLimitRps: number;
  lastUsedAt: string | null;
  expiresAt: string | null;
  revokedAt: string | null;
  createdBy: string | null;
  createdAt: string;
} {
  return {
    id,
    projectId: TENANT.projectId,
    name: "public",
    keyType: "public",
    keyPrefix: id,
    secretHash: "hash",
    scopes: ["documents:read"],
    rateLimitRps: 1000,
    lastUsedAt: null,
    expiresAt: null,
    revokedAt: null,
    createdBy: null,
    createdAt: "2026-01-01T00:00:00.000Z",
  };
}

/**
 * Serializing `DataPlaneStore` used only where true parallel commits must be
 * deterministic. PostgreSQL serialises conflicting row locks; the in-memory
 * adapter has no row locks, so we emulate them by chaining `withTransaction`
 * calls behind a promise mutex. This is a TEST HARNESS, not production code.
 */
export class SerializedDataPlaneStore extends DataPlaneStore {
  private tail: Promise<void> = Promise.resolve();

  public override async withTransaction<T>(
    ctx: TenantContext,
    callback: (tx: TxHandle) => Promise<T>
  ): Promise<T> {
    const run = this.tail.then(() => super.withTransaction(ctx, callback));
    this.tail = run.then(
      () => undefined,
      () => undefined
    );
    return run;
  }
}
