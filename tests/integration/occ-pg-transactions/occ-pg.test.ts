/**
 * native PostgreSQL OCC correctness against REAL Neon.
 *
 * Proves the locked design end to end:
 *   - N overlapping transactions on one document => exactly 1 commit and
 *     N-1 ABORTED_CONFLICT (SELECT ... FOR UPDATE, deterministic path ASC order).
 *     N is deliberately below the 50-connection pool: Neon's transaction
 *     pooler times out a 100-way commit burst even when the OCC logic is sound.
 *   - Two separate DocumentEngine instances share the read set via the PG
 *     `transactions` table (no in-memory Map).
 *   - rollback marks the row terminal and releases the document for other writers.
 *   - expired tokens are rejected with TRANSACTION_TIMEOUT.
 *   - aborted commits write neither documents nor outbox rows (atomicity).
 *
 * Connection strings come from .env.phase5.local via the repo's own loader and
 * are never logged.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { VellumError } from "@vellum/core";
import {
  createRawPgClient,
  loadEnvFiles,
  type RawPgClient,
} from "@vellum/database-control";
import { PgStorageAdapter } from "@vellum/storage/adapters";
import { DocumentEngine, transactionTokenHash } from "@vellum/document-engine";
import type { ControlStoreLike } from "@vellum/document-engine";
import { withTenantData } from "../../e2e-real/tenant-data-sql.js";

// The per-package `test:integration` script runs vitest with CWD=apps/api, so
// `process.cwd()` is NOT the repository root. Derive it from this test file.
const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(TEST_DIR, "../../..");
const MIGRATION = path.join(REPO_ROOT, "packages/database-data/migrations/0011_drop_environments.sql");

loadEnvFiles([path.join(REPO_ROOT, ".env.phase5.local"), path.join(REPO_ROOT, ".env")]);
const REAL_DATABASE_ENABLED = Boolean(
  process.env.DATA_DATABASE_URL_DIRECT || process.env.DATA_DATABASE_URL
);

const controlStore: ControlStoreLike = {
  getActiveRuleset: () => null,
  incrementUsage: () => undefined,
};

const OVERLAP = 24;
const prefix = `occpg_${crypto.randomUUID().replace(/-/g, "").slice(0, 12)}`;
const projectId = crypto.randomUUID();
const tenant = { projectId, internal: true as const };
const TX_SECRET = "occ_pg_test_tx_secret_v1";

let adminClient: RawPgClient;
let adapterA: PgStorageAdapter;
let adapterB: PgStorageAdapter;
let engineA: DocumentEngine;
let engineB: DocumentEngine;

function codeOf(err: unknown): string {
  return err instanceof VellumError ? err.code : `UNKNOWN:${String(err)}`;
}

async function countOutboxFor(documentPath: string): Promise<number> {
  const { rows } = await adminClient.query(
    `SELECT count(*)::int AS n FROM realtime_outbox
      WHERE project_id = $1::uuid AND path = $2`,
    [projectId, documentPath]
  );
  return Number((rows[0] as { n: number } | undefined)?.n ?? 0);
}

describe.skipIf(!REAL_DATABASE_ENABLED)(" native PostgreSQL OCC (real Neon)", () => {
  beforeAll(async () => {
    const dataUrl = process.env.DATA_DATABASE_URL_DIRECT ?? process.env.DATA_DATABASE_URL;
    if (!dataUrl) throw new Error("Missing DATA_DATABASE_URL[_DIRECT]; cannot run real OCC tests");

    adminClient = createRawPgClient({ connectionString: dataUrl, applicationName: "vellum-occ-pg-admin" });
    await adminClient.connect();

    // Idempotently apply only the OCC migration. (The repo-wide runner would also
    // apply unrelated pending migrations to the shared Neon database.)
    await adminClient.query(fs.readFileSync(MIGRATION, "utf8"));

    // Two engine instances over ONE shared pool: still two independent engines
    // (separate state/caches), but connection warm-up is not paid 200x.
    adapterA = new PgStorageAdapter({ connectionString: dataUrl });
    adapterB = new PgStorageAdapter({ pool: adapterA.pool });
    engineA = new DocumentEngine({ controlStore, dataStore: adapterA, txSecret: TX_SECRET });
    engineB = new DocumentEngine({ controlStore, dataStore: adapterB, txSecret: TX_SECRET });

    // Warm the pool before starting the 5s-clock test: Neon cold connects would
    // otherwise consume most of the locked MAX_TRANSACTION_DURATION_MS budget.
    await Promise.all(
      Array.from({ length: 50 }, async () => {
        const client = await adapterA.pool.connect();
        client.release();
      })
    );
  }, 30_000);

  afterAll(async () => {
    if (adminClient) {
      await withTenantData(adminClient, projectId, async (tx) => {
        await tx.query("DELETE FROM transactions WHERE project_id = $1::uuid", [projectId]);
        await tx.query("DELETE FROM realtime_outbox WHERE project_id = $1::uuid", [projectId]);
        await tx.query("DELETE FROM document_index_entries WHERE project_id = $1::uuid", [projectId]);
        await tx.query("DELETE FROM document_indexes WHERE project_id = $1::uuid", [projectId]);
        await tx.query("DELETE FROM documents WHERE project_id = $1::uuid", [projectId]);
      });
      await adminClient.end();
    }
    // Both adapters share adapterA's pool; closing it once is sufficient.
    if (adapterA) await adapterA.close();
  }, 30_000);

  it(`${OVERLAP} overlapping transactions on one document: exactly 1 success, ${OVERLAP - 1} ABORTED_CONFLICT`, async () => {
    const docPath = `${prefix}_accounts/hot`;
    await engineA.createDocument({ ...tenant, path: docPath, data: { count: 0 } });
    const outboxBefore = await countOutboxFor(docPath);
    const t0 = Date.now();

    // All transactions begin and read version 1 before ANY commit.
    const begins = await Promise.all(
      Array.from({ length: OVERLAP }, () => engineA.beginTransaction(tenant))
    );
    const t1 = Date.now();
    expect(new Set(begins.map((b) => b.transactionToken)).size).toBe(OVERLAP);

    await Promise.all(
      begins.map((b) =>
        engineA.getDocument({ ...tenant, path: docPath, transactionToken: b.transactionToken })
      )
    );
    const t2 = Date.now();

    // Commit from the *other* engine instance: the read set lives in PG.
    const outcomes = await Promise.allSettled(
      begins.map((b) =>
        engineB.commitTransaction({
          ...tenant,
          transactionToken: b.transactionToken,
          writes: [{ type: "update", path: docPath, data: { count: 1 } }],
        })
      )
    );
    const t3 = Date.now();
    console.log(`OCC ${OVERLAP}-way timings(ms):`, { begins: t1 - t0, reads: t2 - t1, commits: t3 - t2, total: t3 - t0 });

    const successes = outcomes.filter((o) => o.status === "fulfilled");
    const conflicts = outcomes.filter((o) => o.status === "rejected");
    expect(successes).toHaveLength(1);
    expect(conflicts).toHaveLength(OVERLAP - 1);
    for (const conflict of conflicts) {
      if (conflict.status === "rejected") {
        expect(codeOf(conflict.reason)).toBe("ABORTED_CONFLICT");
      }
    }

    // Exactly one writer's version + one outbox event were persisted.
    const finalDoc = await engineA.getDocument({ ...tenant, path: docPath });
    expect(finalDoc.version).toBe(2);
    expect((await countOutboxFor(docPath)) - outboxBefore).toBe(1);
  }, 120_000);

  it("two engine instances share the read set via the PostgreSQL transactions table", async () => {
    const docPath = `${prefix}_accounts/shared`;
    await engineA.createDocument({ ...tenant, path: docPath, data: { value: "initial" } });

    const begun = await engineA.beginTransaction(tenant);
    const read = await engineA.getDocument({
      ...tenant,
      path: docPath,
      transactionToken: begun.transactionToken,
    });
    expect(read.version).toBe(1);

    // The read set MUST be durable in PG, not inside engine A's heap.
    const { rows } = await adminClient.query(
      `SELECT read_set FROM transactions WHERE token_hash = $1`,
      [transactionTokenHash(begun.transactionToken)]
    );
    expect(rows[0]).toBeDefined();
    expect((rows[0] as { read_set: Record<string, number> }).read_set[docPath]).toBe(1);

    // Engine B (fresh instance, different pool) mutates the document.
    await engineB.setDocument({ ...tenant, path: docPath, data: { value: "changed" } });

    // Engine A's commit observes engine B's write through the PG read set.
    const commit = await engineA.commitTransaction({
      ...tenant,
      transactionToken: begun.transactionToken,
      writes: [{ type: "update", path: docPath, data: { value: "stale" } }],
    }).then(
      () => "committed" as const,
      (err: unknown) => codeOf(err)
    );
    expect(commit).toBe("ABORTED_CONFLICT");

    const finalDoc = await engineB.getDocument({ ...tenant, path: docPath });
    expect(finalDoc.data["value"]).toBe("changed");
  }, 60_000);

  it("rollback marks the transaction terminal and releases the document", async () => {
    const docPath = `${prefix}_accounts/rolled`;
    await engineA.createDocument({ ...tenant, path: docPath, data: { value: "before" } });

    const begun = await engineA.beginTransaction(tenant);
    await engineA.getDocument({ ...tenant, path: docPath, transactionToken: begun.transactionToken });
    await engineA.rollbackTransaction({ ...tenant, transactionToken: begun.transactionToken });

    const { rows } = await adminClient.query(
      `SELECT status FROM transactions WHERE token_hash = $1`,
      [transactionTokenHash(begun.transactionToken)]
    );
    expect((rows[0] as { status: string } | undefined)?.status).toBe("rolled_back");

    // The same token can never be committed again.
    const secondCommit = await engineA.commitTransaction({
      ...tenant,
      transactionToken: begun.transactionToken,
      writes: [{ type: "update", path: docPath, data: { value: "no" } }],
    }).then(
      () => "committed" as const,
      (err: unknown) => codeOf(err)
    );
    // Distinct terminal-state errors are intentional: a second
    // commit on a rolled-back ledger row reports ALREADY_ROLLED_BACK.
    expect(secondCommit).toBe("ALREADY_ROLLED_BACK");

    // No lock is retained: another engine can still write the document.
    const ok = await engineB.setDocument({ ...tenant, path: docPath, data: { value: "after" } });
    expect(ok.version).toBe(2);
  }, 60_000);

  it("expired token is rejected with TRANSACTION_TIMEOUT", async () => {
    const docPath = `${prefix}_accounts/expired`;
    await engineA.createDocument({ ...tenant, path: docPath, data: { value: 1 } });

    const begun = await engineA.beginTransaction(tenant);
    await engineA.getDocument({ ...tenant, path: docPath, transactionToken: begun.transactionToken });

    // Force expiry in the durable row instead of sleeping 5 seconds.
    await adminClient.query(
      `UPDATE transactions SET expires_at = now() - interval '1 second' WHERE token_hash = $1`,
      [transactionTokenHash(begun.transactionToken)]
    );

    const result = await engineA.commitTransaction({
      ...tenant,
      transactionToken: begun.transactionToken,
      writes: [{ type: "update", path: docPath, data: { value: 2 } }],
    }).then(
      () => "committed" as const,
      (err: unknown) => codeOf(err)
    );
    expect(result).toBe("TRANSACTION_TIMEOUT");
    expect((await engineA.getDocument({ ...tenant, path: docPath })).version).toBe(1);
  }, 60_000);

  it("one composite-index-definition lookup and one UNNEST upsert per batch", async () => {
    const collectionPath = `${prefix}_batches`;
    await adapterA.createCompositeIndex(tenant, collectionPath, [{ path: "seq", dir: "asc" }]);

    const sqlLog: string[] = [];
    const countingAdapter = new PgStorageAdapter({
      pool: {
        connect: async () => {
          const client = await adapterA.pool.connect();
          return {
            // Named prepared statements call query({ name, text, values }), so
            // normalize both call shapes before recording / forwarding.
            query: (sql: string | { name?: string; text?: string; values?: unknown[] }, params?: unknown[]) => {
              if (typeof sql === "string") {
                sqlLog.push(sql);
                return client.query(sql, params);
              }
              const text = sql.text ?? "";
              sqlLog.push(text);
              return client.query({ ...sql, text, values: sql.values ?? params ?? [] });
            },
            release: () => client.release(),
          };
        },
        end: async () => undefined,
      } as never,
    });
    const countingEngine = new DocumentEngine({
      controlStore,
      dataStore: countingAdapter,
      txSecret: TX_SECRET,
    });

    const result = await countingEngine.batchWrite({
      ...tenant,
      writes: Array.from({ length: 10 }, (_unused, i) => ({
        type: "create" as const,
        path: `${collectionPath}/doc_${i}`,
        data: { seq: i },
      })),
    });
    expect(result.results).toHaveLength(10);

    const indexSelects = sqlLog.filter(
      (sql) => sql.includes("FROM document_indexes") && !sql.includes("INSERT INTO")
    ).length;
    const documentInserts = sqlLog.filter((sql) => sql.includes("INSERT INTO documents")).length;
    const indexEntryInserts = sqlLog.filter((sql) => sql.includes("INSERT INTO document_index_entries")).length;
    expect(indexSelects).toBe(1);
    expect(documentInserts).toBe(1);
    expect(indexEntryInserts).toBe(1);

    const { rows } = await adminClient.query(
      `SELECT count(*)::int AS n FROM document_index_entries
        WHERE project_id = $1::uuid AND collection_path = $2`,
      [projectId, collectionPath]
    );
    expect(Number((rows[0] as { n: number } | undefined)?.n ?? 0)).toBe(10);
    await countingAdapter.close();
  }, 60_000);

  it("cleanupExpired purges expired active rows without touching live ones", async () => {
    const live = await engineA.beginTransaction(tenant);
    const stale = await engineA.beginTransaction(tenant);
    await adminClient.query(
      `UPDATE transactions SET expires_at = now() - interval '1 second' WHERE token_hash = $1`,
      [transactionTokenHash(stale.transactionToken)]
    );

    const purged = await engineA.cleanupExpiredTransactions(tenant);
    expect(purged).toBeGreaterThanOrEqual(1);

    const { rows } = await adminClient.query(
      `SELECT status FROM transactions WHERE token_hash = $1`,
      [transactionTokenHash(live.transactionToken)]
    );
    expect((rows[0] as { status: string } | undefined)?.status).toBe("active");
  }, 60_000);
});
