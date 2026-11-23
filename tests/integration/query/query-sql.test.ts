/**
 * Real PostgreSQL verification of compiled query SQL.
 *
 * Gated on DATA_DATABASE_URL (from `.env.phase5.local` or the environment).
 * When available, the exact SQL produced by `compileQueryToParameterizedSql` is
 * executed inside the tenant transaction via `PgStorageAdapter.queryDocuments`
 * and its result is compared with the in-memory evaluator. An EXPLAIN assertion
 * verifies that composite-index queries produce an Index Scan, not a Seq Scan.
 *
 * Secrets are never logged; the env file is parsed locally.
 */

import "../_live-env.js";
import fs from "node:fs";
import crypto from "node:crypto";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { type DocumentRecord } from "@vellum/storage";
import { DataPlaneStore, PgStorageAdapter } from "@vellum/storage/adapters";
import {
  validateAndNormalizeQuery,
  compileQueryToParameterizedSql,
  selectCompositeIndexForQuery,
  type CompiledQuery,
  type CompositeIndexMetadata,
} from "@vellum/query-engine";
import type { IndexFieldSpec } from "@vellum/core";
import { withTenantData } from "../../e2e-real/tenant-data-sql.js";
import { liveEnvPath } from "../_live-env.js";

function readEnvUrl(): string | null {
  if (process.env["DATA_DATABASE_URL"]) return process.env["DATA_DATABASE_URL"]!;
  const candidates = [
    liveEnvPath(".env.phase5.local"),
    liveEnvPath(".env"),
  ];
  for (const file of candidates) {
    if (!fs.existsSync(file)) continue;
    const text = fs.readFileSync(file, "utf8");
    const match = text.match(/^DATA_DATABASE_URL=(.*)$/m);
    if (match?.[1]) {
      return match[1].trim().replace(/^["']|["']$/g, "");
    }
  }
  return null;
}

const URL = readEnvUrl();
const PID = crypto.randomUUID();
const COLLECTION = "query_sql_it";
const INDEX_FIELDS: IndexFieldSpec[] = [{ path: "score", dir: "asc" }];

function makePgDoc(i: number): DocumentRecord {
  return {
    projectId: PID,
    path: `${COLLECTION}/d_${String(i).padStart(4, "0")}`,
    collectionPath: COLLECTION,
    collectionGroup: COLLECTION,
    documentId: `d_${String(i).padStart(4, "0")}`,
    pathDepth: 2,
    data: {
      score: i % 50,
      label: i % 3 === 0 ? "alpha" : i % 3 === 1 ? "beta" : "gamma",
      tags: i % 2 === 0 ? ["red"] : ["blue"],
    },
    sizeBytes: 96,
    version: 1,
    createdAt: new Date(Date.UTC(2026, 0, 1)).toISOString(),
    updatedAt: new Date(Date.UTC(2026, 0, 1)).toISOString(),
    deletedAt: null,
  };
}

function compileFor(spec: Record<string, unknown>, index: CompositeIndexMetadata | null): CompiledQuery {
  const normalized = validateAndNormalizeQuery({ collectionPath: COLLECTION, ...spec });
  return compileQueryToParameterizedSql({
    projectId: PID,
    normalizedQuery: normalized,
    matchedCompositeIndex: index,
  });
}

describe.skipIf(!URL)("real SQL execution + EXPLAIN", () => {
  let pgAdapter: PgStorageAdapter;
  let memory: DataPlaneStore;
  let pgIndex: CompositeIndexMetadata;
  let memIndex: CompositeIndexMetadata;

  beforeAll(async () => {
    pgAdapter = new PgStorageAdapter({ connectionString: URL! });
    memory = new DataPlaneStore();

    const docs = Array.from({ length: 120 }, (_, i) => makePgDoc(i));
    for (const doc of docs) {
      await pgAdapter.putDocument({ projectId: PID }, doc);
      await memory.putDocument({ projectId: PID }, doc);
    }

    const pgRecord = await pgAdapter.createCompositeIndex(
      { projectId: PID },
      COLLECTION,
      INDEX_FIELDS
    );
    // Runtime status transition only (no migration edits).
    await pgAdapter.pool.query(
      "UPDATE document_indexes SET status = 'ready' WHERE id = $1::uuid AND project_id = $2::uuid",
      [pgRecord.id, PID]
    );
    pgIndex = {
      id: pgRecord.id,
      collectionPath: COLLECTION,
      fields: INDEX_FIELDS,
      status: "ready",
    };

    const memRecord = await memory.createCompositeIndex({ projectId: PID }, {
      collectionPath: COLLECTION,
      fields: INDEX_FIELDS,
    });
    await memory.runIndexBuilderWorker();
    memIndex = {
      id: memRecord.id,
      collectionPath: COLLECTION,
      fields: INDEX_FIELDS,
      status: "ready",
    };
  }, 120_000);

  afterAll(async () => {
    if (pgAdapter) {
      // FORCE RLS: bind tenant GUCs in a transaction-scoped client before cleanup.
      const client = await pgAdapter.pool.connect();
      try {
        await withTenantData(client, PID, async (tx) => {
          await tx.query("DELETE FROM document_index_entries WHERE project_id = $1::uuid", [PID]);
          await tx.query("DELETE FROM document_indexes WHERE project_id = $1::uuid", [PID]);
          await tx.query("DELETE FROM documents WHERE project_id = $1::uuid", [PID]);
        });
      } finally {
        client.release();
      }
      await pgAdapter.close();
    }
  }, 60_000);

  it("SQL result equals the in-memory evaluator for an indexed range query", async () => {
    const spec = {
      where: [{ field: "score", op: ">", value: 10 }],
      orderBy: [{ field: "score", dir: "asc" }],
      limit: 30,
    };
    const { matchedIndex } = selectCompositeIndexForQuery(
      validateAndNormalizeQuery({ collectionPath: COLLECTION, ...spec }),
      [pgIndex]
    );
    expect(matchedIndex?.id).toBe(pgIndex.id);

    const compiled = compileFor(spec, matchedIndex);
    const sqlRows = await pgAdapter.queryDocuments({ projectId: PID }, compiled);
    const memRows = await memory.withTransaction({ projectId: PID }, (tx) =>
      tx.queryDocuments(compileFor(spec, memIndex))
    );
    expect(sqlRows.map((r) => r.documentId)).toEqual(memRows.map((r) => r.documentId));
  }, 60_000);

  it("SQL result equals the in-memory evaluator for an unindexed equality query", async () => {
    const spec = {
      where: [{ field: "label", op: "==", value: "beta" }],
      limit: 25,
    };
    const compiled = compileFor(spec, null);
    const sqlRows = await pgAdapter.queryDocuments({ projectId: PID }, compiled);
    const memRows = await memory.withTransaction({ projectId: PID }, (tx) =>
      tx.queryDocuments(compileFor(spec, null))
    );
    expect(sqlRows.map((r) => r.documentId)).toEqual(memRows.map((r) => r.documentId));
  }, 60_000);

  it("EXPLAIN shows an Index Scan (never a Seq Scan) for the composite-index plan", async () => {
    const compiled = compileFor(
      { where: [{ field: "score", op: ">", value: 10 }], orderBy: [{ field: "score", dir: "asc" }], limit: 30 },
      pgIndex
    );
    const client = await pgAdapter.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SET LOCAL statement_timeout = '5000ms'");
      await client.query("SELECT set_config('app.current_project_id', $1, true)", [PID]);
      await client.query("ANALYZE document_index_entries");
      // Test tenants hold only a handful of index rows, so the planner is
      // entitled to prefer a Seq Scan even though the index is valid. Force
      // the alternative path to prove the composite-index plan is indexable.
      await client.query("SET LOCAL enable_seqscan = off");
      const explained = await client.query(`EXPLAIN (FORMAT JSON) ${compiled.sql}`, compiled.params);
      const planText = JSON.stringify(explained.rows);
      expect(planText).toContain("Index Scan");
      expect(planText).not.toContain("Seq Scan");
      await client.query("ROLLBACK");
    } finally {
      client.release();
    }
  }, 60_000);
});
