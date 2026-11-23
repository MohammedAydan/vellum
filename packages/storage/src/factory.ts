/**
 * @vellum/storage - Storage Adapter Factory
 * Instantiates the appropriate StorageAdapter based on options or process configuration.
 */

import { DataPlaneStore } from "./memory-adapter.js";
import { PgStorageAdapter } from "./pg-adapter.js";
import { NeonStorageAdapter } from "./neon-adapter.js";
import type { StorageAdapter, StorageAdapterOptions } from "./types.js";

export function createStorageAdapter(options: StorageAdapterOptions = {}): StorageAdapter {
  const driver =
    options.driver ??
    (process.env["DATA_DATABASE_DRIVER"] as StorageAdapterOptions["driver"]) ??
    (process.env["DATA_DATABASE_URL"]?.includes("neon.tech")
      ? "neon"
      : process.env["DATA_DATABASE_URL"]
        ? "pg"
        : "memory");

  if (driver === "neon") {
    return new NeonStorageAdapter(
      options.connectionString || options.maxConnections !== undefined
        ? {
            ...(options.connectionString ? { connectionString: options.connectionString } : {}),
            ...(options.maxConnections !== undefined ? { maxConnections: options.maxConnections } : {}),
          }
        : undefined
    );
  }

  if (driver === "pg") {
    return new PgStorageAdapter(
      options.connectionString || options.maxConnections !== undefined
        ? {
            ...(options.connectionString ? { connectionString: options.connectionString } : {}),
            ...(options.maxConnections !== undefined ? { maxConnections: options.maxConnections } : {}),
          }
        : undefined
    );
  }

  return new DataPlaneStore();
}
