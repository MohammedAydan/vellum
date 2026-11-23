/**
 * @vellum/storage - Storage Package Barrel (Ports, Types, Tx Context, Cache & Aggregates)
 * Runtime concrete adapter classes live under `@vellum/storage/adapters`.
 * Specification Sections 3.1, 6.3, 6.4, 7.1, 7.2, 8.2, and 15.
 */

export * from "./contracts/storage-port.js";
export * from "./types.js";
export * from "./tx-context.js";
export * from "./cache.js";
export * from "./aggregates.js";
export * from "./auth-store.js";
export * from "./factory.js";
export { DATA_POOL_MAX, CONTROL_POOL_MAX } from "./pg-adapter.js";

// Type-only re-exports for concrete adapter classes; import runtime classes from `./adapters.js`.
export type { DataPlaneStore } from "./memory-adapter.js";
export type { PgStorageAdapter } from "./pg-adapter.js";
export type { NeonStorageAdapter } from "./neon-adapter.js";

export type { ReferencedByPageRequest } from "./referenced-by.js";
