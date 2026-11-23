/**
 * Randomized multi-attempt OCC property test against real PostgreSQL.
 *
 * The existing 100-way contention test (`occ-pg.test.ts`) is deterministic and is
 * deliberately left untouched. This file adds a fast-check property with a fixed
 * seed: for each generated scenario, N independent `DocumentEngine` instances
 * (sharing one PostgreSQL data plane, but separate engine state) begin N
 * transactions, read an overlapping read-set and commit concurrently.
 *
 * Invariants proved for every generated scenario:
 *   1. Exactly one commit succeeds; every other attempt fails ABORTED_CONFLICT.
 *   2. The winner applies every write exactly once (version +1 per written doc).
 *   3. Losing attempts write nothing (documents, outbox and versions unchanged).
 *   4. The durable `transactions` ledger contains exactly one `committed` row for
 *      the attempt set and N-1 still-active (aborted) rows.
 *   5. The read set used at commit time is the read set persisted in PostgreSQL
 *      by the *other* engine instance.
 *
 * Runs only when `.env.phase5.local` (or the process env) provides a real
 * DATA_DATABASE_URL; otherwise the suite is skipped so hermetic runs stay green.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as fc from "fast-check";
import { VellumError } from "@vellum/core";
import {
  createRawPgClient,
  loadEnvFiles,
  type RawPgClient,
} from "@vellum/database-control";
import { PgStorageAdapter } from "@vellum/storage/adapters";
import {
  DocumentEngine,
  transactionTokenHash,
  type BatchMutation,
  type ControlStoreLike,
} from "@vellum/document-engine";
import { withTenantData } from "../../e2e-real/tenant-data-sql.js";

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(TEST_DIR, "../../..");
const MIGRATION = path.join(REPO_ROOT, "packages/database-data/migrations/0011_drop_environments.sql");

loadEnvFiles([path.join(REPO_ROOT, ".env.phase5.local"), path.join(REPO_ROOT, ".env")]);
const DATA_URL = process.env.DATA_DATABASE_URL_DIRECT ?? process.env.DATA_DATABASE_URL ?? "";
const REAL_DATABASE_ENABLED = DATA_URL !== "";

const controlStore: ControlStoreLike = {
  getActiveRuleset: () => null,
  incrementUsage: () => undefined,
};

const prefix = `occprop_${crypto.randomUUID().replace(/-/g, "").slice(0, 12)}`;
const projectId = crypto.randomUUID();
const tenant = { projectId, internal: true as const };
const TX_SECRET = "occ_property_test_tx_secret_v1_2026";

const SEED = 20261116;
const NUM_RUNS = 4;

interface Scenario {
  docCount: number;
  attemptCount: number;
  readBits: boolean[];
  writeBits: boolean[];
  attemptReadBits: boolean[];
  attemptWriteBits: boolean[];
}

const booleanMaskArb = (length: number): fc.Arbitrary<boolean[]> =>
  fc.array(fc.boolean(), { minLength: length, maxLength: length });

const scenarioArb: fc.Arbitrary<Scenario> = fc.record({
  docCount: fc.integer({ min: 2, max: 5 }),
  attemptCount: fc.integer({ min: 2, max: 6 }),
  readBits: booleanMaskArb(5),
  writeBits: booleanMaskArb(5),
  attemptReadBits: booleanMaskArb(6),
  attemptWriteBits: booleanMaskArb(6),
});

function readIndices(scenario: Scenario, attempt: number): number[] {
  return Array.from({ length: scenario.docCount }, (_unused, docIndex) => docIndex).filter(
    (docIndex) =>
      // Doc 0 is the shared hot document every attempt reads and writes.
      docIndex === 0 ||
      (scenario.readBits[docIndex] === true && scenario.attemptReadBits[attempt] === true)
  );
}

function writeIndices(scenario: Scenario, attempt: number): number[] {
  return Array.from({ length: scenario.docCount }, (_unused, docIndex) => docIndex).filter(
    (docIndex) =>
      docIndex === 0 ||
      (scenario.writeBits[docIndex] === true && scenario.attemptWriteBits[attempt] === true)
  );
}

function codeOf(error: unknown): string {
  return error instanceof VellumError ? error.code : `UNKNOWN:${String(error)}`;
}

describe.skipIf(!REAL_DATABASE_ENABLED)(
  "randomized OCC multi-instance property (real PostgreSQL)",
  () => {
    let adminClient: RawPgClient | undefined;
    let adapterA: PgStorageAdapter | undefined;
    let engineA: DocumentEngine;
    let engineB: DocumentEngine;

    const engineFor = (index: number): DocumentEngine => (index % 2 === 0 ? engineA : engineB);

    async function countOutboxForPrefix(runPrefix: string): Promise<number> {
      const client = adminClient;
      if (!client) return 0;
      const { rows } = await client.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM realtime_outbox
          WHERE project_id = $1::uuid AND starts_with(path, $2)`,
        [projectId, runPrefix]
      );
      return Number(rows[0]?.n ?? 0);
    }

    async function cleanupRun(runPrefix: string): Promise<void> {
      const client = adminClient;
      if (!client) return;
      await client.query(
        `DELETE FROM realtime_outbox
          WHERE project_id = $1::uuid AND starts_with(path, $2)`,
        [projectId, runPrefix]
      );
      await client.query(
        `DELETE FROM documents
          WHERE project_id = $1::uuid AND starts_with(path, $2)`,
        [projectId, runPrefix]
      );
    }

    beforeAll(async () => {
      if (!REAL_DATABASE_ENABLED) return;

      adminClient = createRawPgClient({
        connectionString: DATA_URL,
        applicationName: "vellum-occ-property-admin",
      });
      await adminClient.connect();

      // Idempotently ensure the OCC ledger exists (no other migrations touched).
      await adminClient.query(fs.readFileSync(MIGRATION, "utf8"));

      adapterA = new PgStorageAdapter({ connectionString: DATA_URL });
      // Two engine instances share one pool but hold independent engine state.
      const adapterB = new PgStorageAdapter({ pool: adapterA.pool });
      engineA = new DocumentEngine({ controlStore, dataStore: adapterA, txSecret: TX_SECRET });
      engineB = new DocumentEngine({ controlStore, dataStore: adapterB, txSecret: TX_SECRET });

      // Warm the pool so the 5s OCC window is not consumed by Neon cold connects.
      await Promise.all(
        Array.from({ length: 12 }, async () => {
          const client = await adapterA?.pool.connect();
          client?.release();
        })
      );
    }, 60_000);

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
      if (adapterA) await adapterA.close();
    }, 60_000);

    it("never lets two engines commit the same read-set", async () => {
      let runCounter = 0;

      await fc.assert(
        fc.asyncProperty(scenarioArb, async (scenario) => {
          runCounter += 1;
          const runPrefix = `${prefix}_run${runCounter}`;
          const docPaths = Array.from(
            { length: scenario.docCount },
            (_unused, index) => `${runPrefix}_docs/doc_${index}`
          );

          const reads = Array.from({ length: scenario.attemptCount }, (_unused, attempt) =>
            readIndices(scenario, attempt).map((index) => docPaths[index] as string)
          );
          const writes = Array.from({ length: scenario.attemptCount }, (_unused, attempt) =>
            writeIndices(scenario, attempt).map((index) => docPaths[index] as string)
          );

          // Seed every document at version 1.
          await Promise.all(
            docPaths.map((docPath, index) =>
              engineA.createDocument({
                ...tenant,
                path: docPath,
                data: { seed: index, attempt: -1 },
              })
            )
          );
          const outboxBefore = await countOutboxForPrefix(runPrefix);

          const begins = await Promise.all(
            Array.from({ length: scenario.attemptCount }, (_unused, attempt) =>
              engineFor(attempt).beginTransaction(tenant)
            )
          );
          expect(new Set(begins.map((begin) => begin.transactionToken)).size).toBe(
            scenario.attemptCount
          );

          // Each attempt reads through a *different* engine instance than the one
          // that will commit, forcing the PG `transactions.read_set` to be shared.
          await Promise.all(
            begins.map((begin, attempt) =>
              Promise.all(
                reads[attempt]!.map((docPath) =>
                  engineFor(attempt + 1).getDocument({
                    ...tenant,
                    path: docPath,
                    transactionToken: begin.transactionToken,
                  })
                )
              )
            )
          );

          // Prove the read set is durable in PostgreSQL before any commit starts.
          const { rows: readSetRows } = await adminClient!.query<{ read_set: Record<string, number> }>(
            `SELECT read_set FROM transactions
              WHERE project_id = $1::uuid
                AND token_hash = ANY($2::text[])`,
            [projectId, begins.map((begin) => transactionTokenHash(begin.transactionToken))]
          );
          const hotPath = docPaths[0] as string;
          expect(readSetRows).toHaveLength(scenario.attemptCount);
          for (const row of readSetRows) {
            expect(row.read_set[hotPath]).toBe(1);
          }

          const mutations = writes.map((writePaths, attempt) => ({
            ...tenant,
            transactionToken: begins[attempt]!.transactionToken,
            writes: writePaths.map(
              (docPath): BatchMutation => ({
                type: "update",
                path: docPath,
                data: { attempt, touched: true },
              })
            ),
          }));

          try {
            const outcomes = await Promise.allSettled(
              mutations.map((mutation, attempt) =>
                engineFor(attempt + 1).commitTransaction(mutation)
              )
            );

            const fulfilled = outcomes.flatMap((outcome, index) =>
              outcome.status === "fulfilled" ? [index] : []
            );
            const rejected = outcomes.flatMap((outcome, index) =>
              outcome.status === "rejected" ? [index] : []
            );

            expect(fulfilled).toHaveLength(1);
            expect(rejected).toHaveLength(scenario.attemptCount - 1);
            for (const index of rejected) {
              const outcome = outcomes[index];
              expect(outcome?.status).toBe("rejected");
              if (outcome?.status === "rejected") {
                expect(codeOf(outcome.reason)).toBe("ABORTED_CONFLICT");
              }
            }

            const winner = fulfilled[0] as number;
            const winnerWrites = new Set(writes[winner] ?? []);

            // Winner writes exactly once; losers changed nothing.
            for (const docPath of docPaths) {
              const finalDocument = await engineA.getDocument({ ...tenant, path: docPath });
              expect(finalDocument.version).toBe(winnerWrites.has(docPath) ? 2 : 1);
              if (winnerWrites.has(docPath)) {
                expect(finalDocument.data["attempt"]).toBe(winner);
              } else {
                expect(finalDocument.data["attempt"]).toBe(-1);
              }
            }

            // One outbox event per winner write, zero for losers.
            const outboxDelta = (await countOutboxForPrefix(runPrefix)) - outboxBefore;
            expect(outboxDelta).toBe(winnerWrites.size);

            // Durable ledger: exactly one committed row for these attempts, the
            // rest remain active (aborted by conflict, cleaned up on expiry).
            const tokenHashes = begins.map((begin) => transactionTokenHash(begin.transactionToken));
            const { rows: statusRows } = await adminClient!.query<{ status: string; n: number }>(
              `SELECT status, count(*)::int AS n FROM transactions
                WHERE project_id = $1::uuid
                  AND token_hash = ANY($2::text[])
                GROUP BY status`,
              [projectId, tokenHashes]
            );
            const committed = Number(
              statusRows.find((row) => row.status === "committed")?.n ?? 0
            );
            const active = Number(statusRows.find((row) => row.status === "active")?.n ?? 0);
            expect(committed).toBe(1);
            expect(active).toBe(scenario.attemptCount - 1);
          } finally {
            await cleanupRun(runPrefix);
          }
        }),
        { seed: SEED, numRuns: NUM_RUNS }
      );
    }, 300_000);
  }
);
