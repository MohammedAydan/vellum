/**
 * Shared test helpers for the PostgreSQL-only realtime integration suite.
 * Reads DATA_DATABASE_URL from .env.phase5.local via dotenv. NEVER logs the URL.
 */

import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { hashApiKey, type ApiKeyRecord } from "@vellum/authorization";
import { RealtimeGatewayHub } from "@vellum/realtime";
import type { StorageAdapter, TenantContext } from "@vellum/storage";
import type { ServerFrame } from "@vellum/api-contract";

/**
 * Dependencies are installed for @vellum/realtime (not for the root test dir),
 * so resolve them from that package without ever printing their values.
 */
const requireFromRealtime = createRequire(
  new URL("../../../packages/realtime/package.json", import.meta.url)
);

interface DotenvLike {
  config(options: { path: string }): { error?: Error; parsed?: Record<string, string> };
}
interface PgQueryResult<T> {
  rows: T[];
}
export interface PgClientLike {
  connect(): Promise<void>;
  query<T>(sql: string, params?: unknown[]): Promise<PgQueryResult<T>>;
  end(): Promise<void>;
}
interface PgLike {
  Client: new (options: { connectionString: string; connectionTimeoutMillis?: number }) => PgClientLike;
}

const dotenv = requireFromRealtime("dotenv") as DotenvLike;
const pg = requireFromRealtime("pg") as PgLike;

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const ENV_PATH = path.resolve(ROOT, ".env.phase5.local");
const MIGRATION_PATH = path.resolve(
  ROOT,
  "packages/database-data/migrations/0011_drop_environments.sql"
);

export function loadDataDatabaseUrl(): string {
  // dotenv populates process.env from the local env file; no value is printed.
  dotenv.config({ path: ENV_PATH });
  const url = process.env["DATA_DATABASE_URL"];
  if (!url) throw new Error("DATA_DATABASE_URL is not configured in .env.phase5.local");
  return url;
}

/**
 * Neon's `-pooler` endpoint uses transaction-mode pooling, which does not keep
 * a session-level LISTEN subscription alive. Derive the direct (session-mode)
 * endpoint from the same DATA_DATABASE_URL for the dedicated listener only.
 * No credential value is ever printed.
 */
export function loadListenConnectionString(): string {
  const url = new URL(loadDataDatabaseUrl());
  if (url.hostname.includes("-pooler.")) {
    url.hostname = url.hostname.replace("-pooler.", ".");
  }
  return url.toString();
}

export function newPgClient(connectionString: string): PgClientLike {
  return new pg.Client({ connectionString, connectionTimeoutMillis: 15_000 });
}

export async function applyOutboxNotifyMigration(connectionString: string): Promise<void> {
  const sql = readFileSync(MIGRATION_PATH, "utf8");
  const client = newPgClient(connectionString);
  await client.connect();
  try {
    await client.query(sql);
  } finally {
    await client.end();
  }
}

export interface TestTenant extends TenantContext {
  /** Unique per tenant: authorization caches verified keys globally by prefix. */
  apiKey: string;
}

export function makeTenant(): TestTenant {
  return {
    projectId: randomUUID(),
    apiKey: `pk_${randomUUID().replace(/-/g, "")}`,
  };
}

/** Insert an outbox row in a tenant-scoped transaction. The 0003 trigger emits
 * the NOTIFY on COMMIT; the full row remains in realtime_outbox. */
export async function insertOutboxEvent(
  connectionString: string,
  tenant: TenantContext,
  opts: { path?: string; text?: string } = {}
): Promise<string> {
  const docPath = opts.path ?? `messages/${randomUUID()}`;
  const documentId = docPath.split("/").pop() ?? docPath;
  const client = newPgClient(connectionString);
  await client.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.current_project_id', $1, true)", [tenant.projectId]);
    const result = await client.query<{ seqId: string }>(
      `INSERT INTO realtime_outbox
         (project_id, collection_path, path, document_id, op_type, version, before_data, after_data)
       VALUES ($1::uuid, 'messages', $2, $3, 'created', 1, NULL, $4::jsonb)
       RETURNING seq_id::text AS "seqId"`,
      [tenant.projectId, docPath, documentId, JSON.stringify({ text: opts.text ?? "hello" })]
    );
    await client.query("COMMIT");
    const seqId = result.rows[0]?.seqId;
    if (!seqId) throw new Error("Outbox INSERT returned no seqId");
    return seqId;
  } catch (err) {
    try {
      await client.query("ROLLBACK");
    } catch {
      /* ignore */
    }
    throw err;
  } finally {
    await client.end();
  }
}

export class MockControlStore {
  public readonly apiKeysByPrefix = new Map<string, ApiKeyRecord>();
  public realtimeMessagesSent = 0;

  constructor(private readonly tenant: TestTenant) {
    const keyPrefix = tenant.apiKey.slice(0, 16);
    this.apiKeysByPrefix.set(keyPrefix, {
      id: `key_${randomUUID().slice(0, 8)}`,
      projectId: tenant.projectId,
      name: "Integration Key",
      keyType: "server",
      keyPrefix,
      secretHash: hashApiKey(tenant.apiKey),
      scopes: ["documents:read", "documents:write", "*"],
      rateLimitRps: 1000,
      lastUsedAt: null,
      expiresAt: null,
      revokedAt: null,
      createdBy: null,
      createdAt: new Date().toISOString(),
    });
  }

  getProject(projectId: string) {
    return {
      project: { id: projectId, name: "Integration Project" },
    };
  }

  getActiveRuleset(): unknown {
    return null;
  }

  incrementUsage(
    _projectId: string,
    usage: { realtimeMessagesSent?: number }
  ): void {
    if (usage.realtimeMessagesSent) this.realtimeMessagesSent += usage.realtimeMessagesSent;
  }
}

export function makeHub(
  dataStore: StorageAdapter,
  tenant: TestTenant
): { hub: RealtimeGatewayHub; controlStore: MockControlStore } {
  const controlStore = new MockControlStore(tenant);
  const hub = new RealtimeGatewayHub({ controlStore, dataStore });
  return { hub, controlStore };
}

export async function authenticateAndSubscribe(
  hub: RealtimeGatewayHub,
  tenant: TestTenant,
  subId: string,
  docPath: string,
  frames: ServerFrame[]
): Promise<void> {
  const client = hub.createConnectionSession((frame) => {
    frames.push(frame);
  });
  await client.handleClientFrame({
    type: "auth",
    projectId: tenant.projectId,
    apiKey: tenant.apiKey,
  });
  await client.handleClientFrame({
    type: "subscribe",
    subId,
    path: docPath,
  });
}

export async function waitFor(
  predicate: () => boolean,
  timeoutMs = 8_000,
  label = "condition"
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate() && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  if (!predicate()) throw new Error(`Timed out waiting for ${label}`);
}
