/**
 * @vellum/database-control - Concrete Control Plane Adapters & Infrastructure Factories
 */

import { Pool as NeonPool } from "@neondatabase/serverless";
import type { Pool as PgPool } from "pg";
import { PgControlPlaneStore, type PgControlPlaneStoreOptions } from "./pg-store.js";

export { ControlPlaneStore } from "./memory-store.js";
export {
  PgControlPlaneStore,
  type PgControlPlaneStoreOptions,
  type PgStoreLogger,
} from "./pg-store.js";
export {
  createInMemorySecurityRepository,
  createPgSecurityRepository,
  type SecurityRepository,
} from "./security-repository.js";
export {
  createInMemoryBillingRepository,
  createPgBillingRepository,
  type BillingRepository,
} from "./billing-repository.js";
export {
  PgPool,
  PgClient,
  createRawPgPool,
  createRawPgClient,
  type RawPgPool,
  type RawPgClient,
  type RawPgQueryResult,
  type RawPoolOptions,
} from "./raw-sql.js";
export {
  createControlDb,
  createControlDb as createControlDbClient,
  getControlDb,
  closeControlDb,
  type ControlDb,
  type ControlDbOptions,
} from "./client.js";

/**
 * Neon-backed control plane store for Workers/edge runtimes where a TCP `pg`
 * connection is unavailable. Neon's Pool is structurally compatible with the
 * `pg.Pool` surface used by `PgControlPlaneStore` (query/connect/on/end), so the
 * store keeps the exact same SQL, RLS and cache semantics.
 */
export function createNeonControlPlaneStore(
  connectionString: string,
  options: Omit<PgControlPlaneStoreOptions, "pool" | "connectionString"> = {}
): PgControlPlaneStore {
  // BOUNDARY-ADAPTER: NeonPool implements the query/connect/on/end subset that
  // PgControlPlaneStore actually uses; it is not a full pg.Pool (it lacks
  // expiredCount/ending/ended/options), so bridge the type at this boundary.
  const pool = new NeonPool({ connectionString }) as unknown as PgPool;
  return new PgControlPlaneStore({ ...options, pool });
}
