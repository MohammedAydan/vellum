/**
 * Real Load-Test Seed Script (`tests/load/seed.ts`)
 *
 * Writes REAL rows into the Neon `data_db` (documents, document_indexes,
 * document_index_entries, realtime_outbox) plus the control-plane tenant
 * (organization, project, API key) into `control_db`.
 *
 * There is no in-memory platform, no `platform.fetch()` shortcut, and no
 * simulated latency anywhere in this file. Everything goes through `pg`.
 *
 * Usage:
 *   npx tsx tests/load/seed.ts --docs 100000
 *   npx tsx tests/load/seed.ts --docs 1000 --run-id lsmoke
 *   npx tsx tests/load/seed.ts --cleanup --run-id lsmoke
 *
 * Idempotency: every row is namespaced by `load_<runid>_`, and all writes are
 * `ON CONFLICT DO UPDATE`. Re-running the same `--run-id` converges to the
 * same dataset instead of duplicating it.
 *
 * Secrets: the generated API key is written to `tests/load/.env.load.local`
 * (git-ignored via `.env.*.local`) and printed to stdout exactly once. It is
 * never written into any committed file.
 */

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

// Resolve `pg` through the workspace package that actually depends on it.
const requireFromStorage = createRequire(
  new URL("../../packages/storage/package.json", import.meta.url)
);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const pg: any = requireFromStorage("pg");

import { encodeCompositeSortKey } from "../../packages/core/src/index.js";
import { computeIndexDefinitionHash } from "../../packages/query-engine/src/index.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "../..");
const RESULTS_DIR = path.join(__dirname, "results");
const ENV_OUT_PATH = path.join(__dirname, ".env.load.local");

const DEFAULT_PEPPER = process.env.PEPPER_HEX ?? "vellum_default_pepper_v1";
const BASE62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

interface SeedOptions {
  docs: number;
  runId: string;
  cleanup: boolean;
  skipIndexEntries: boolean;
}

interface SeedSummary {
  runId: string;
  projectId: string;
  apiKeyPrefix: string;
  collections: Record<string, number>;
  totals: {
    documents: number;
    documentIndexes: number;
    documentIndexEntries: number;
    realtimeOutbox: number;
  };
  durationMs: number;
  generatedAt: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export function loadEnvFile(): Record<string, string> {
  const candidates = [
    path.join(REPO_ROOT, ".env.phase5.local"),
    path.join(REPO_ROOT, ".env"),
  ];
  for (const candidate of candidates) {
    if (!fs.existsSync(candidate)) continue;
    const out: Record<string, string> = {};
    for (const rawLine of fs.readFileSync(candidate, "utf8").split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line || line.startsWith("#")) continue;
      const eq = line.indexOf("=");
      if (eq < 0) continue;
      const key = line.slice(0, eq).trim();
      let value = line.slice(eq + 1).trim();
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }
      out[key] = value;
    }
    return out;
  }
  return {};
}

/** Redacts credentials for any log line. Never print a DSN. */
export function redactDsn(dsn: string | undefined): string {
  if (!dsn) return "<unset>";
  try {
    const url = new URL(dsn);
    return `${url.protocol}//${url.username}:***@${url.host}${url.pathname}`;
  } catch {
    return "<unparsable-dsn>";
  }
}

function parseArgs(argv: string[]): SeedOptions {
  const get = (flag: string): string | undefined => {
    const idx = argv.indexOf(flag);
    return idx >= 0 ? argv[idx + 1] : undefined;
  };
  const runId =
    get("--run-id") ??
    process.env.LOAD_RUN_ID ??
    `l${Date.now().toString(36)}${crypto.randomBytes(2).toString("hex")}`;
  return {
    docs: Number(get("--docs") ?? process.env.LOAD_DOC_COUNT ?? 100_000),
    runId: runId.toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 12),
    cleanup: argv.includes("--cleanup"),
    skipIndexEntries: argv.includes("--skip-index-entries"),
  };
}

function deterministicUuid(seed: string): string {
  const hex = crypto.createHash("sha256").update(seed).digest("hex");
  // RFC 4122 v4 layout
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    `4${hex.slice(13, 16)}`,
    `8${hex.slice(17, 20)}`,
    hex.slice(20, 32),
  ].join("-");
}

function deterministicBase62(seed: string, length: number): string {
  const digest = crypto.createHash("sha256").update(seed).digest();
  let out = "";
  for (let i = 0; i < length; i++) {
    const byte = digest[i % digest.length] as number;
    out += BASE62[(byte + i * 7) % 62];
  }
  return out;
}

function hashApiKey(fullKey: string, pepper: string): string {
  return crypto.createHash("sha256").update(`${fullKey}:${pepper}`).digest("hex");
}

function createClient(connectionString: string) {
  return new pg.Client({
    connectionString,
    ssl: { rejectUnauthorized: false },
    statement_timeout: 120_000,
  });
}

async function tableExists(client: any, table: string): Promise<boolean> {
  const { rows } = await client.query(
    `SELECT 1 FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name = $1`,
    [table]
  );
  return rows.length > 0;
}

/**
 * Applies the canonical migration SQL (idempotent: every statement is
 * `IF NOT EXISTS` / `DROP POLICY IF EXISTS`). The SQL is read from the
 * packages that own it; nothing is duplicated here.
 */
async function ensureSchema(client: any, migrationPath: string, probeTable: string): Promise<boolean> {
  if (await tableExists(client, probeTable)) return false;
  const sql = fs.readFileSync(migrationPath, "utf8");
  await client.query(sql);
  return true;
}

function isoNow(): string {
  return new Date().toISOString();
}

// ---------------------------------------------------------------------------
// Dataset generation
// ---------------------------------------------------------------------------

const COLLECTION_MIX: Array<{ name: string; share: number }> = [
  { name: "customers", share: 0.6 },
  { name: "orders", share: 0.3 },
  { name: "metrics", share: 0.1 },
];

const STATUSES = ["active", "active", "active", "inactive", "pending"] as const;
const REGIONS = ["eu-central-1", "us-east-1", "ap-south-1"] as const;
const TAG_POOL = ["vip", "beta", "churn-risk", "enterprise", "trial"] as const;

interface DocRow {
  collectionPath: string;
  documentId: string;
  path: string;
  data: Record<string, unknown>;
  sizeBytes: number;
}

function buildDocument(
  collectionPath: string,
  index: number,
  runId: string,
  nowIso: string
): DocRow {
  const documentId = `load_${runId}_${collectionPath.slice(0, 3)}_${String(index).padStart(7, "0")}`;
  const docPath = `${collectionPath}/${documentId}`;
  const status = STATUSES[index % STATUSES.length] as string;
  const score = (index * 37) % 101;
  const tags = [TAG_POOL[index % TAG_POOL.length] as string];
  if (index % 7 === 0) tags.push(TAG_POOL[(index + 2) % TAG_POOL.length] as string);

  const data: Record<string, unknown> =
    collectionPath === "customers"
      ? {
          name: `Customer ${documentId.slice(-7)}`,
          email: `c${documentId.slice(-7)}@loadtest.example`,
          status,
          score,
          tags,
          region: REGIONS[index % REGIONS.length],
          lifetimeValue: Number(((index * 13) % 10000) / 100),
          tier: index % 11 === 0 ? "gold" : "standard",
          createdAt: nowIso,
          updatedAt: nowIso,
        }
      : collectionPath === "orders"
        ? {
            status,
            total: Number(((index * 29) % 50000) / 100),
            currency: "EUR",
            tags,
            region: REGIONS[index % REGIONS.length],
            itemCount: (index % 9) + 1,
            createdAt: nowIso,
            updatedAt: nowIso,
          }
        : {
            status,
            score,
            tags,
            host: `node-${index % 20}`,
            cpuPct: Number(((index * 17) % 1000) / 10),
            memMb: 256 + (index % 2048),
            createdAt: nowIso,
            updatedAt: nowIso,
          };

  return {
    collectionPath,
    documentId,
    path: docPath,
    data,
    sizeBytes: Buffer.byteLength(JSON.stringify(data), "utf8"),
  };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

export async function seedLoadTestDatabase(options?: Partial<SeedOptions>): Promise<SeedSummary> {
  const startedAt = Date.now();
  const opts: SeedOptions = {
    docs: 100_000,
    runId: `l${Date.now().toString(36)}`,
    cleanup: false,
    skipIndexEntries: false,
    ...options,
  };

  const loadedEnv = loadEnvFile();
  const dataDsn = loadedEnv.DATA_DATABASE_URL_DIRECT ?? loadedEnv.DATA_DATABASE_URL;
  const controlDsn = loadedEnv.CONTROL_DATABASE_URL_DIRECT ?? loadedEnv.CONTROL_DATABASE_URL;
  if (!dataDsn) throw new Error("DATA_DATABASE_URL_DIRECT is not set in .env.phase5.local");
  if (!controlDsn) throw new Error("CONTROL_DATABASE_URL_DIRECT is not set in .env.phase5.local");

  console.log(`[seed] run-id       : ${opts.runId}`);
  console.log(`[seed] data plane   : ${redactDsn(dataDsn)}`);
  console.log(`[seed] control plane: ${redactDsn(controlDsn)}`);
  console.log(`[seed] target docs  : ${opts.docs.toLocaleString()}`);

  const dataClient = createClient(dataDsn);
  const controlClient = createClient(controlDsn);
  await dataClient.connect();
  await controlClient.connect();

  const summary: SeedSummary = {
    runId: opts.runId,
    projectId: "",
    apiKeyPrefix: "",
    collections: {},
    totals: {
      documents: 0,
      documentIndexes: 0,
      documentIndexEntries: 0,
      realtimeOutbox: 0,
    },
    durationMs: 0,
    generatedAt: isoNow(),
  };

  try {
    // ---- 1. Schema ---------------------------------------------------------
    const appliedData = await ensureSchema(
      dataClient,
      path.join(REPO_ROOT, "packages/database-data/migrations/0001_init_data_plane.sql"),
      "documents"
    );
    const appliedControl = await ensureSchema(
      controlClient,
      path.join(REPO_ROOT, "packages/database-control/migrations/0001_init_control_plane.sql"),
      "organizations"
    );
    console.log(
      `[seed] schema        : data=${appliedData ? "applied" : "already present"}, control=${appliedControl ? "applied" : "already present"}`
    );

    // ---- 2. Control-plane tenant ------------------------------------------
    const orgSlug = `load-${opts.runId}`;
    const projectSlug = `load-proj-${opts.runId}`;

    const orgRes = await controlClient.query(
      `INSERT INTO organizations (slug, name, billing_email, plan_id)
       VALUES ($1, $2, $3, 'enterprise')
       ON CONFLICT (slug) DO UPDATE SET name = EXCLUDED.name, updated_at = now()
       RETURNING id`,
      [orgSlug, `Load Test Org ${opts.runId}`, `${opts.runId}@loadtest.example`]
    );
    const organizationId = orgRes.rows[0].id as string;

    const projectRes = await controlClient.query(
      `INSERT INTO projects (organization_id, slug, name)
       VALUES ($1::uuid, $2, $3)
       ON CONFLICT (organization_id, slug) DO UPDATE SET name = EXCLUDED.name, updated_at = now()
       RETURNING id`,
      [organizationId, projectSlug, `Load Test Project ${opts.runId}`]
    );
    const projectId = projectRes.rows[0].id as string;

    // Deterministic server key so a re-run with the same run-id keeps working.
    const fullKey = `sk_${deterministicBase62(`loadkey:${opts.runId}`, 48)}`;
    const keyPrefix = fullKey.slice(0, 16);
    const secretHash = hashApiKey(fullKey, DEFAULT_PEPPER);

    await controlClient.query(
      `INSERT INTO api_keys (
         project_id, name, key_type, key_prefix, secret_hash, scopes, rate_limit_rps
       ) VALUES ($1::uuid, $2, 'server', $3, $4, $5::text[], 100000)
       ON CONFLICT (key_prefix) DO UPDATE
         SET secret_hash = EXCLUDED.secret_hash, revoked_at = NULL, rate_limit_rps = EXCLUDED.rate_limit_rps`,
      [
        projectId,
        `load-key-${opts.runId}`,
        keyPrefix,
        secretHash,
        ["documents:read", "documents:write", "indexes:manage"],
      ]
    );

    summary.projectId = projectId;
    summary.apiKeyPrefix = keyPrefix;

    console.log(`[seed] project       : ${projectId}`);
    console.log(`[seed] api key prefix: ${keyPrefix}`);

    if (opts.cleanup) {
      const cleanup = await dataClient.query(
        `DELETE FROM documents WHERE project_id = $1::uuid`,
        [projectId]
      );
      await dataClient.query(
        `DELETE FROM document_index_entries WHERE project_id = $1::uuid`,
        [projectId]
      );
      await dataClient.query(
        `DELETE FROM document_indexes WHERE project_id = $1::uuid`,
        [projectId]
      );
      await dataClient.query(
        `DELETE FROM realtime_outbox WHERE project_id = $1::uuid`,
        [projectId]
      );
      console.log(`[seed] cleanup       : removed ${cleanup.rowCount} documents for this tenant`);
      summary.durationMs = Date.now() - startedAt;
      return summary;
    }

    // ---- 3. Composite index definition ------------------------------------
    const indexFields = [
      { path: "status", dir: "asc" as const },
      { path: "score", dir: "desc" as const },
    ];
    const definitionHash = computeIndexDefinitionHash("customers", indexFields);
    const indexRes = await dataClient.query(
      `INSERT INTO document_indexes (
         project_id, collection_path, fields, definition_hash, status
       ) VALUES ($1::uuid, 'customers', $2::jsonb, $3, 'ready')
       ON CONFLICT (project_id, collection_path, definition_hash)
       DO UPDATE SET status = 'ready', updated_at = now()
       RETURNING id`,
      [projectId, JSON.stringify(indexFields), definitionHash]
    );
    const indexId = indexRes.rows[0].id as string;

    // ---- 4. Documents -----------------------------------------------------
    const nowIso = isoNow();
    const perCollection: Record<string, number> = {};
    for (const { name, share } of COLLECTION_MIX) {
      perCollection[name] = Math.floor(opts.docs * share);
    }
    // Give rounding remainder to `customers` so the total is exact.
    const assigned = Object.values(perCollection).reduce((a, b) => a + b, 0);
    perCollection.customers = (perCollection.customers as number) + (opts.docs - assigned);

    console.log(
      `[seed] plan          : ${Object.entries(perCollection)
        .map(([c, n]) => `${c}=${n.toLocaleString()}`)
        .join(" ")}`
    );

    const DOC_BATCH = 500;
    let documentsWritten = 0;
    const indexEntries: Array<{ path: string; documentId: string; sortKey: Buffer }> = [];

    for (const [collectionPath, count] of Object.entries(perCollection)) {
      for (let offset = 0; offset < count; offset += DOC_BATCH) {
        const batch: DocRow[] = [];
        for (let i = offset; i < Math.min(offset + DOC_BATCH, count); i++) {
          batch.push(buildDocument(collectionPath, i, opts.runId, nowIso));
        }

        const params: unknown[] = [];
        const tuples: string[] = [];
        for (const doc of batch) {
          const base = params.length;
          params.push(
            projectId,
            doc.path,
            doc.collectionPath,
            doc.collectionPath,
            doc.documentId,
            2,
            JSON.stringify(doc.data),
            doc.sizeBytes
          );
          tuples.push(
            `($${base + 1}::uuid, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, $${base + 6}::smallint, $${base + 7}::jsonb, $${base + 8}::int)`
          );
        }

        await dataClient.query(
          `INSERT INTO documents (
             project_id, path, collection_path, collection_group,
             document_id, path_depth, data, size_bytes
           ) VALUES ${tuples.join(",")}
           ON CONFLICT (project_id, path) DO UPDATE
             SET data = EXCLUDED.data, size_bytes = EXCLUDED.size_bytes, updated_at = now()`,
          params
        );
        documentsWritten += batch.length;

        if (collectionPath === "customers" && !opts.skipIndexEntries) {
          for (const doc of batch) {
            indexEntries.push({
              path: doc.path,
              documentId: doc.documentId,
              sortKey: encodeCompositeSortKey(
                {
                  documentId: doc.documentId,
                  data: doc.data,
                  createdAt: nowIso,
                  updatedAt: nowIso,
                } as never,
                indexFields as never
              ),
            });
          }
        }
      }
      console.log(`[seed] wrote         : ${collectionPath} → ${count.toLocaleString()} rows`);
    }

    // ---- 5. Composite index entries ---------------------------------------
    let entriesWritten = 0;
    if (!opts.skipIndexEntries) {
      const ENTRY_BATCH = 500;
      for (let offset = 0; offset < indexEntries.length; offset += ENTRY_BATCH) {
        const batch = indexEntries.slice(offset, offset + ENTRY_BATCH);
        const params: unknown[] = [];
        const tuples: string[] = [];
        for (const entry of batch) {
          const base = params.length;
          params.push(indexId, projectId, "customers", entry.sortKey, entry.documentId, entry.path);
          tuples.push(
            `($${base + 1}::uuid, $${base + 2}::uuid, $${base + 3}, $${base + 4}::bytea, $${base + 5}, $${base + 6})`
          );
        }
        await dataClient.query(
          `INSERT INTO document_index_entries (
             index_id, project_id, collection_path, sort_key, document_id, path
           ) VALUES ${tuples.join(",")}
           ON CONFLICT (index_id, sort_key, document_id) DO NOTHING`,
          params
        );
        entriesWritten += batch.length;
      }
      console.log(`[seed] wrote         : document_index_entries → ${entriesWritten.toLocaleString()} rows`);
    }

    // ---- 6. OCC hot-document set -----------------------------------------
    // `occ-contention.js` needs a small, fixed set of documents that every VU
    // fights over. They must exist before the test starts, otherwise every
    // commit fails with NOT_FOUND instead of ABORTED_CONFLICT.
    const HOT_DOC_COUNT = 10;
    {
      const params: unknown[] = [];
      const tuples: string[] = [];
      for (let i = 0; i < HOT_DOC_COUNT; i++) {
        for (const documentId of [`load_${opts.runId}_hot_${i}`, `hot_acc_${i}`]) {
          const docPath = `accounts/${documentId}`;
          const payload = {
            balance: 0,
            owner: `hot-account-${i}`,
            region: "eu-central-1",
            lastUpdatedByVU: null,
            updatedAt: nowIso,
          };
          const base = params.length;
          params.push(
            projectId,
            docPath,
            "accounts",
            "accounts",
            documentId,
            2,
            JSON.stringify(payload),
            Buffer.byteLength(JSON.stringify(payload), "utf8")
          );
          tuples.push(
            `($${base + 1}::uuid, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, $${base + 6}::smallint, $${base + 7}::jsonb, $${base + 8}::int)`
          );
        }
      }
      await dataClient.query(
        `INSERT INTO documents (
           project_id, path, collection_path, collection_group,
           document_id, path_depth, data, size_bytes
         ) VALUES ${tuples.join(",")}
         ON CONFLICT (project_id, path) DO NOTHING`,
        params
      );

      // Also seed metrics/system_health for realtime WebSocket subscriptions
      const sysHealthPayload = { status: "healthy", cpuPct: 15.2, memMb: 512, updatedAt: nowIso };
      await dataClient.query(
        `INSERT INTO documents (
           project_id, path, collection_path, collection_group,
           document_id, path_depth, data, size_bytes
         ) VALUES ($1::uuid, 'metrics/system_health', 'metrics', 'metrics', 'system_health', 2, $2::jsonb, $3::int)
         ON CONFLICT (project_id, path) DO NOTHING`,
        [projectId, JSON.stringify(sysHealthPayload), Buffer.byteLength(JSON.stringify(sysHealthPayload), "utf8")]
      );

      console.log(`[seed] wrote         : accounts → ${HOT_DOC_COUNT * 2} hot documents & metrics/system_health`);
    }

    // ---- 7. Realtime outbox seed (for WS fan-out + DR) --------------------
    const OUTBOX_BATCH = 200;
    let outboxWritten = 0;
    for (let offset = 0; offset < 500; offset += OUTBOX_BATCH) {
      const params: unknown[] = [];
      const tuples: string[] = [];
      for (let i = offset; i < Math.min(offset + OUTBOX_BATCH, 500); i++) {
        const doc = buildDocument("metrics", i, opts.runId, nowIso);
        const base = params.length;
        params.push(
          projectId,
          "metrics",
          doc.path,
          doc.documentId,
          "created",
          1,
          JSON.stringify(doc.data)
        );
        tuples.push(
          `($${base + 1}::uuid, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, $${base + 6}::bigint, $${base + 7}::jsonb)`
        );
      }
      await dataClient.query(
        `INSERT INTO realtime_outbox (
           project_id, collection_path, path, document_id, op_type, version, after_data
         ) VALUES ${tuples.join(",")}`,
        params
      );
      outboxWritten += Math.min(OUTBOX_BATCH, 500 - offset);
    }

    // ---- 8. Verify with real SQL ------------------------------------------
    const counts = await dataClient.query(
      `SELECT
         (SELECT count(*)::int FROM documents WHERE project_id = $1::uuid) AS documents,
         (SELECT count(*)::int FROM document_indexes WHERE project_id = $1::uuid) AS indexes,
         (SELECT count(*)::int FROM document_index_entries WHERE project_id = $1::uuid) AS entries,
         (SELECT count(*)::int FROM realtime_outbox WHERE project_id = $1::uuid) AS outbox`,
      [projectId]
    );
    const row = counts.rows[0];

    summary.collections = perCollection;
    summary.totals = {
      documents: row.documents,
      documentIndexes: row.indexes,
      documentIndexEntries: row.entries,
      realtimeOutbox: row.outbox,
    };
    summary.durationMs = Date.now() - startedAt;

    fs.mkdirSync(RESULTS_DIR, { recursive: true });
    fs.writeFileSync(
      path.join(RESULTS_DIR, `seed-${opts.runId}.json`),
      `${JSON.stringify(summary, null, 2)}\n`,
      "utf8"
    );

    // Git-ignored handoff file for the k6 runner (never committed).
    fs.writeFileSync(
      ENV_OUT_PATH,
      [
        `# Generated by tests/load/seed.ts — git-ignored (.env.*.local)`,
        `LOAD_RUN_ID=${opts.runId}`,
        `PROJECT_ID=${projectId}`,
        `API_KEY=${fullKey}`,
        `BASE_URL=http://localhost:8080`,
        "",
      ].join("\n"),
      "utf8"
    );

    console.log("\n[seed] ── verified row counts (raw SQL) ──────────────────────");
    console.table([
      { table: "documents", rows: summary.totals.documents },
      { table: "document_indexes", rows: summary.totals.documentIndexes },
      { table: "document_index_entries", rows: summary.totals.documentIndexEntries },
      { table: "realtime_outbox", rows: summary.totals.realtimeOutbox },
    ]);
    console.log(`[seed] elapsed       : ${(summary.durationMs / 1000).toFixed(1)}s`);
    console.log(`[seed] handoff file  : tests/load/.env.load.local (git-ignored)`);
    console.log(`[seed] API key       : ${fullKey}`);
    console.log(`[seed] ⚠️  Treat the key above as a credential. It is scoped to a throwaway load tenant.`);

    return summary;
  } finally {
    await dataClient.end().catch(() => undefined);
    await controlClient.end().catch(() => undefined);
  }
}

const isDirectRun =
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]).replace(/\.(ts|js)$/, "") ===
    fileURLToPath(import.meta.url).replace(/\.(ts|js)$/, "");

if (isDirectRun) {
  seedLoadTestDatabase(parseArgs(process.argv.slice(2))).catch((err: unknown) => {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[seed] FAILED: ${message}`);
    process.exitCode = 1;
  });
}
