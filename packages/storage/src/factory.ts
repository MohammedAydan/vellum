/**
 * @vellum/storage - Storage Adapter Factory
 * Instantiates the appropriate StorageAdapter based on options or process configuration.
 */

import { DataPlaneStore } from "./memory-adapter.js";
import { PgStorageAdapter } from "./pg-adapter.js";
import { NeonStorageAdapter } from "./neon-adapter.js";
import type { StorageAdapter, StorageAdapterOptions } from "./types.js";

export function createStorageAdapter(options: StorageAdapterOptions = {}): StorageAdapter {
  const connectionString = options.connectionString ?? process.env["DATA_DATABASE_URL"] ?? process.env["DATABASE_URL"];
  let inferredDriver: "pg" | "neon" | "memory" = "memory";
  if (connectionString) {
    let parsed: URL;
    try { parsed = new URL(connectionString); } catch {
      throw new Error("Storage connectionString must be a valid PostgreSQL URL");
    }
    if (!["postgres:", "postgresql:"].includes(parsed.protocol)) throw new Error("Storage connectionString must use PostgreSQL");
    const host = parsed.hostname.toLowerCase();
    inferredDriver = host === "neon.tech" || host.endsWith(".neon.tech") ? "neon" : "pg";
  }
  const driver = options.driver ?? process.env["DATA_DATABASE_DRIVER"] ?? inferredDriver;
  if (!["memory", "pg", "neon"].includes(driver)) throw new Error("Unsupported storage driver");
  if (driver === "memory" && process.env["NODE_ENV"] === "production") {
    throw new Error("In-memory storage is not allowed in production; configure PostgreSQL");
  }

  if (driver === "neon") {
    return new NeonStorageAdapter(
      connectionString || options.maxConnections !== undefined
        ? {
            ...(connectionString ? { connectionString } : {}),
            ...(options.maxConnections !== undefined ? { maxConnections: options.maxConnections } : {}),
          }
        : undefined
    );
  }

  if (driver === "pg") {
    return new PgStorageAdapter(
      connectionString || options.maxConnections !== undefined
        ? {
            ...(connectionString ? { connectionString } : {}),
            ...(options.maxConnections !== undefined ? { maxConnections: options.maxConnections } : {}),
          }
        : undefined
    );
  }

  return new DataPlaneStore();
}
