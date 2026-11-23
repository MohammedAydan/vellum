/**
 * @vellum/database-control - Dual-Mode Drizzle PostgreSQL Client
 * Supports Neon Serverless (HTTP / WebSockets) and Node pg (TCP / Docker / Local).
 */

import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { drizzle as drizzlePg } from "drizzle-orm/node-postgres";
import type { NeonDatabase } from "drizzle-orm/neon-serverless";
import { drizzle as drizzleNeon } from "drizzle-orm/neon-serverless";
import pg from "pg";
import { Pool as NeonPool } from "@neondatabase/serverless";
import * as schema from "./schema.js";
import { redactConnectionString } from "./env-file.js";

export type ControlDb = NodePgDatabase<typeof schema> | NeonDatabase<typeof schema>;

let cachedClient: { db: ControlDb; close: () => Promise<void> } | null = null;

export interface ControlDbOptions {
  connectionString?: string;
  driver?: "auto" | "pg" | "neon";
}

interface ErrorEventEmitterLike {
  on(event: string, listener: () => void): unknown;
}

function isErrorEventEmitter(candidate: object): candidate is ErrorEventEmitterLike {
  return "on" in candidate && typeof candidate.on === "function";
}

const DEFAULT_DEV_CONNECTION_STRING =
  "postgresql://vellum_control:control_secret@localhost:5432/control_db";

function parseConnectionUrl(connectionString: string): URL | null {
  try {
    const parsed = new URL(connectionString);
    if (parsed.protocol !== "postgres:" && parsed.protocol !== "postgresql:") {
      throw new Error(
        `Unsupported PostgreSQL connection scheme in ${redactConnectionString(connectionString)}`
      );
    }
    return parsed;
  } catch (err: unknown) {
    if (err instanceof Error && err.message.startsWith("Unsupported PostgreSQL")) {
      throw err;
    }
    return null;
  }
}

function isNeonHost(parsed: URL | null): boolean {
  if (!parsed) return false;
  const host = parsed.hostname.toLowerCase();
  return host === "neon.tech" || host.endsWith(".neon.tech");
}

function resolveSslConfig(parsed: URL | null): pg.PoolConfig["ssl"] | undefined {
  const mode = (parsed?.searchParams.get("sslmode") ?? process.env["PGSSLMODE"] ?? "").toLowerCase();
  if (mode === "verify-full" || mode === "verify-ca") {
    return { rejectUnauthorized: true };
  }
  return undefined;
}

export function createControlDb(options: ControlDbOptions = {}): { db: ControlDb; close: () => Promise<void> } {
  const configuredConnectionString =
    options.connectionString ??
    process.env["CONTROL_DATABASE_URL"] ??
    process.env["DATABASE_URL"];

  if (!configuredConnectionString && process.env["NODE_ENV"] === "production") {
    throw new Error(
      "CONTROL_DATABASE_URL or DATABASE_URL must be configured in production"
    );
  }

  const connectionString = configuredConnectionString ?? DEFAULT_DEV_CONNECTION_STRING;
  const parsedUrl = parseConnectionUrl(connectionString);

  const requestedDriver = options.driver ?? "auto";
  const driver =
    requestedDriver !== "auto"
      ? requestedDriver
      : (process.env["CONTROL_DATABASE_DRIVER"] === "neon" ||
          process.env["DATABASE_DRIVER"] === "neon" ||
          isNeonHost(parsedUrl)
          ? "neon"
          : "pg");

  if (driver === "neon") {
    const pool = new NeonPool({ connectionString });
    if (isErrorEventEmitter(pool)) {
      pool.on("error", () => undefined);
    }
    const db = drizzleNeon(pool, { schema });
    let closed = false;
    return {
      db,
      close: async () => {
        if (closed) return;
        closed = true;
        await pool.end();
      },
    };
  }

  const ssl = resolveSslConfig(parsedUrl);
  const pool = new pg.Pool({
    connectionString,
    max: 10,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 5000,
    ...(ssl !== undefined ? { ssl } : {}),
  });
  pool.on("error", () => undefined);

  const db = drizzlePg(pool, { schema });
  let closed = false;
  return {
    db,
    close: async () => {
      if (closed) return;
      closed = true;
      await pool.end();
    },
  };
}

export function getControlDb(options?: ControlDbOptions): ControlDb {
  if (!cachedClient) {
    cachedClient = createControlDb(options);
  }
  return cachedClient.db;
}

export async function closeControlDb(): Promise<void> {
  const current = cachedClient;
  cachedClient = null;
  if (current) {
    await current.close();
  }
}
