/**
 * @vellum/api - Single Explicit Composition Root
 *
 * Centralizes concrete adapter instantiation, readiness probe wiring,
 * cross-instance cache invalidation, PostgreSQL realtime infrastructure, and
 * service lifetime registration (`singleton` | `request-scoped` | `transient`)
 * so routes and middleware depend only on ports/contracts.
 */

import type { ControlPlanePort, ControlPlaneRepository } from "@vellum/database-control";
import {
  ControlPlaneStore,
  PgControlPlaneStore,
  createNeonControlPlaneStore,
  createRawPgClient,
  type BillingRepository,
  type RawPgClient,
  type SecurityRepository,
} from "@vellum/database-control/adapters";
import {
  setCacheInvalidationBus,
  toSqlQueryClient,
  type StorageAdapter,
  type StorageAdapterPort,
} from "@vellum/storage";
import {
  DataPlaneStore,
  NeonStorageAdapter,
  PgStorageAdapter,
  createCacheInvalidationBus,
} from "@vellum/storage/adapters";
import { DocumentEngine } from "@vellum/document-engine";
import {
  RealtimeGatewayHub,
  createPgRealtimeInfrastructure,
  type PgRealtimeInfrastructure,
} from "@vellum/realtime";

import { createControlInvalidationHandler } from "../workers/control-invalidation.js";

export type ServiceLifetime = "singleton" | "request-scoped" | "transient";

export interface RegisteredServiceDescriptor {
  readonly name: string;
  readonly lifetime: ServiceLifetime;
}

export interface ReadinessProbeOptions {
  readonly connectionString: string;
  readonly connectionTimeoutMillis: number;
  readonly applicationName: string;
}

/**
 * Port used by readiness routes to execute short-lived SQL/LISTEN probes
 * without importing concrete PostgreSQL client factories directly.
 */
export interface ReadinessProbePort {
  withClient<T>(
    options: ReadinessProbeOptions,
    work: (client: RawPgClient) => Promise<T>
  ): Promise<T>;
}

export interface CacheInvalidationHandle {
  close(): Promise<void>;
}

export interface ApiCompositionRootInput {
  readonly apiKeyPepper?: string | undefined;
  readonly controlStore: ControlPlanePort;
  readonly dataStore: StorageAdapterPort;
  readonly jwtSecret?: string | undefined;
  readonly readinessProbe?: ReadinessProbePort | undefined;
}

export interface ApiContainer {
  readonly controlStore: ControlPlanePort;
  readonly dataStore: StorageAdapterPort;
  readonly security: SecurityRepository;
  readonly billing: BillingRepository;
  readonly documentEngine: DocumentEngine;
  readonly realtimeHub: RealtimeGatewayHub;
  readonly readinessProbe: ReadinessProbePort;
  readonly services: readonly RegisteredServiceDescriptor[];
}

export type ApiCompositionRoot = ApiContainer;

export interface MemoryAdapterBundle {
  readonly controlStore: ControlPlaneRepository;
  readonly dataStore: StorageAdapter;
  readonly readinessProbe: ReadinessProbePort;
}

export interface PostgresAdapterOptions {
  readonly controlConnectionString: string;
  readonly dataConnectionString: string;
  readonly storageDriver?: "pg" | "neon" | undefined;
  readonly controlDriver?: "pg" | "neon" | undefined;
}

export interface PostgresAdapterBundle {
  readonly controlStore: PgControlPlaneStore;
  readonly dataStore: StorageAdapter;
  readonly readinessProbe: ReadinessProbePort;
  startCacheInvalidation(): CacheInvalidationHandle;
  stopCacheInvalidation(): void;
  startRealtime(
    connectionString: string,
    hub: RealtimeGatewayHub
  ): Promise<PgRealtimeInfrastructure>;
  closeDataStore(): Promise<void>;
  closeControlStore(): Promise<void>;
}

const SERVICE_REGISTRY: readonly RegisteredServiceDescriptor[] = Object.freeze([
  Object.freeze({ name: "controlStore", lifetime: "singleton" }),
  Object.freeze({ name: "dataStore", lifetime: "singleton" }),
  Object.freeze({ name: "securityRepository", lifetime: "singleton" }),
  Object.freeze({ name: "billingRepository", lifetime: "singleton" }),
  Object.freeze({ name: "documentEngine", lifetime: "singleton" }),
  Object.freeze({ name: "realtimeHub", lifetime: "singleton" }),
  Object.freeze({ name: "readinessProbe", lifetime: "singleton" }),
]);

/**
 * Creates a ReadinessProbePort backed by the concrete raw PostgreSQL client
 * factory from `@vellum/database-control/adapters`.
 */
export function createReadinessProbe(): ReadinessProbePort {
  return {
    async withClient<T>(
      options: ReadinessProbeOptions,
      work: (client: RawPgClient) => Promise<T>
    ): Promise<T> {
      const client = createRawPgClient({
        connectionString: options.connectionString,
        connectionTimeoutMillis: options.connectionTimeoutMillis,
        applicationName: options.applicationName,
      });
      // pg emits 'error' on idle/failed sockets; without a listener that event
      // is an uncaught exception and can take the whole process down. Probe
      // failures already surface through the awaited work()'s rejection.
      client.on("error", () => undefined);
      await client.connect();
      try {
        return await work(client);
      } finally {
        await client.end().catch(() => undefined);
      }
    },
  };
}

/** Shared process-level readiness probe port for health/readiness routes. */
export const defaultReadinessProbe: ReadinessProbePort = createReadinessProbe();

/** Creates default in-process memory adapters for tests and offline mode. */
export function createMemoryAdapters(): MemoryAdapterBundle {
  return {
    controlStore: new ControlPlaneStore(),
    dataStore: new DataPlaneStore(),
    readinessProbe: defaultReadinessProbe,
  };
}

/**
 * Instantiates and verifies PostgreSQL-backed control and data plane adapters,
 * plus lifecycle helpers for cache invalidation and realtime LISTEN/NOTIFY.
 */
export async function createPostgresAdapters(
  options: PostgresAdapterOptions
): Promise<PostgresAdapterBundle> {
  const controlStore =
    options.controlDriver === "neon"
      ? createNeonControlPlaneStore(options.controlConnectionString)
      : new PgControlPlaneStore({
          connectionString: options.controlConnectionString,
        });
  const dataStore =
    options.storageDriver === "neon"
      ? new NeonStorageAdapter({ connectionString: options.dataConnectionString })
      : new PgStorageAdapter({ connectionString: options.dataConnectionString });

  await controlStore.initialize();
  await toSqlQueryClient(dataStore.pool).query("SELECT 1");

  return {
    controlStore,
    dataStore,
    readinessProbe: defaultReadinessProbe,
    startCacheInvalidation(): CacheInvalidationHandle {
      const cacheBus = createCacheInvalidationBus({
        connectionString: options.controlConnectionString,
        onInvalidate: createControlInvalidationHandler(controlStore),
      });
      setCacheInvalidationBus(cacheBus);
      return cacheBus;
    },
    stopCacheInvalidation(): void {
      setCacheInvalidationBus(null);
    },
    async startRealtime(
      connectionString: string,
      hub: RealtimeGatewayHub
    ): Promise<PgRealtimeInfrastructure> {
      const infra = createPgRealtimeInfrastructure({
        connectionString,
        dataStore,
        hub,
      });
      await infra.start();
      return infra;
    },
    async closeDataStore(): Promise<void> {
      await dataStore.close();
    },
    async closeControlStore(): Promise<void> {
      await controlStore.close();
    },
  };
}

/** Adapter bundle for edge runtimes (Neon for both planes; no TCP `pg`). */
export function createEdgeAdapters(options: {
  controlConnectionString: string;
  dataConnectionString: string;
}): { controlStore: ControlPlaneRepository; dataStore: StorageAdapter } {
  return {
    controlStore: createNeonControlPlaneStore(options.controlConnectionString),
    dataStore: new NeonStorageAdapter({ connectionString: options.dataConnectionString }),
  };
}

/**
 * Constructs and wires the core API ports into an immutable composition root.
 */
export function createApiCompositionRoot(input: ApiCompositionRootInput): ApiContainer {
  const documentEngine = new DocumentEngine({
    controlStore: input.controlStore,
    dataStore: input.dataStore,
  });
  const realtimeHub = new RealtimeGatewayHub({
    apiKeyPepper: input.apiKeyPepper,
    controlStore: input.controlStore,
    dataStore: input.dataStore,
    ...(input.jwtSecret !== undefined ? { jwtSecret: input.jwtSecret } : {}),
  });

  return Object.freeze({
    controlStore: input.controlStore,
    dataStore: input.dataStore,
    security: input.controlStore.security,
    billing: input.controlStore.billing,
    documentEngine,
    realtimeHub,
    readinessProbe: input.readinessProbe ?? defaultReadinessProbe,
    services: SERVICE_REGISTRY,
  });
}
