/**
 * Real Backend E2E Test - Query Engine Execution Plans (EXPLAIN ANALYZE)
 * Validates real PostgreSQL Neon execution plans for:
 * 1. Composite queries: sort_key B-Tree scan on document_index_entries
 * 2. Equality queries: GIN scan on documents (idx_docs_data_gin_active)
 *
 * Saves full execution plans to `tests/e2e-real/results/explain-analyze.log`.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import path from "node:path";
import fs from "node:fs";
import crypto from "node:crypto";
import { createRawPgClient, loadEnvFiles } from "../../packages/database-control/src/index.js";
import { encodeCompositeSortKey, type DocumentRecordForIndex } from "../../packages/core/src/index.js";
import { withTenantData } from "./tenant-data-sql.js";

process.env.PHASE5_REAL = "1";

describe("Real PostgreSQL Query Engine EXPLAIN ANALYZE", () => {
  let dataClient: Awaited<ReturnType<typeof createRawPgClient>>;
  const projectId = crypto.randomUUID();
  const collectionPath = `explain_col_${Date.now()}`;
  const indexId = crypto.randomUUID();
  const indexFields = [
    { path: "status", dir: "asc" as const },
    { path: "population", dir: "desc" as const },
  ];
  const resultsDir = path.resolve("tests/e2e-real/results");
  const logFilePath = path.join(resultsDir, "explain-analyze.log");

  beforeAll(async () => {
    loadEnvFiles([path.resolve(".env.phase5.local"), path.resolve(".env")]);
    if (!fs.existsSync(resultsDir)) {
      fs.mkdirSync(resultsDir, { recursive: true });
    }

    dataClient = createRawPgClient({
      connectionString: process.env.DATA_DATABASE_URL_DIRECT || process.env.DATA_DATABASE_URL || "",
      applicationName: "vellum-e2e-explain-analyze",
    });
    await dataClient.connect();

    // FORCE ROW LEVEL SECURITY is active on data_db: the whole seed must run
    // inside a tenant-bound transaction (no RLS bypass role is used).
    await withTenantData(dataClient, projectId, async (tx) => {
      // 1. Create composite index record in document_indexes
      await tx.query(
        `INSERT INTO document_indexes (
          id, project_id, collection_path, fields, definition_hash, status
        ) VALUES ($1::uuid, $2::uuid, $3, $4::jsonb, $5, 'ready')`,
        [
          indexId,
          projectId,
          collectionPath,
          JSON.stringify(indexFields),
          crypto.randomUUID().slice(0, 32),
        ]
      );

      // 2. Populate 50 test documents and their composite index entries
      for (let i = 0; i < 50; i++) {
        const documentId = `doc_${String(i).padStart(3, "0")}`;
        const docPath = `${collectionPath}/${documentId}`;
        const data = {
          status: i % 2 === 0 ? "active" : "pending",
          country: "DE",
          population: 100_000 + i * 2_500,
          tags: ["city", i % 2 === 0 ? "major" : "regional"],
        };

        await tx.query(
          `INSERT INTO documents (
            project_id, path, collection_path, collection_group,
            document_id, path_depth, data, size_bytes, version, created_at, updated_at
          ) VALUES (
            $1::uuid, $2, $3, $4, $5, 2, $6::jsonb, 256, 1, now(), now()
          )`,
          [projectId, docPath, collectionPath, collectionPath, documentId, JSON.stringify(data)]
        );

        const now = new Date().toISOString();
        const indexRecord: DocumentRecordForIndex = {
          documentId,
          createdAt: now,
          updatedAt: now,
          data,
        };
        const sortKey = encodeCompositeSortKey(indexRecord, indexFields);

        await tx.query(
          `INSERT INTO document_index_entries (
            index_id, project_id, collection_path, sort_key, document_id, path
          ) VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6)`,
          [indexId, projectId, collectionPath, sortKey, documentId, docPath]
        );
      }
    });
  }, 30_000);

  afterAll(async () => {
    if (dataClient) {
      await withTenantData(dataClient, projectId, async (tx) => {
        await tx.query("DELETE FROM document_index_entries WHERE project_id = $1::uuid", [projectId]);
        await tx.query("DELETE FROM document_indexes WHERE project_id = $1::uuid", [projectId]);
        await tx.query("DELETE FROM documents WHERE project_id = $1::uuid", [projectId]);
      });
      await dataClient.end();
    }
  }, 30_000);

  it("captures real EXPLAIN ANALYZE for B-Tree sort_key composite scan", async () => {
    await dataClient.query("BEGIN");
    await dataClient.query(`SET LOCAL app.current_project_id = '${projectId}'`);
    await dataClient.query("SET LOCAL enable_seqscan = off");

    const explainSql = `
      EXPLAIN (ANALYZE, BUFFERS, VERBOSE)
      SELECT d.*
        FROM document_index_entries ie
        JOIN documents d
          ON d.project_id = ie.project_id
         AND d.path = ie.path
       WHERE ie.index_id = $1::uuid
         AND d.project_id = $2::uuid
         AND d.collection_path = $3
         AND d.deleted_at IS NULL
       ORDER BY ie.sort_key ASC, ie.document_id ASC
       LIMIT 10;
    `;

    const res = await dataClient.query(explainSql, [indexId, projectId, collectionPath]);
    await dataClient.query("COMMIT");

    const planText = res.rows.map((r: { "QUERY PLAN": string }) => r["QUERY PLAN"]).join("\n");

    // Must verify the plan uses B-Tree Index Scan on document_index_entries
    expect(planText).toMatch(/Index Scan.*document_index_entries/i);
    expect(planText).toMatch(/sort_key/i);

    const logEntry = [
      "================================================================================",
      `TIMESTAMP: ${new Date().toISOString()}`,
      `DATABASE: PostgreSQL (Neon Serverless)`,
      `TEST: Composite Index B-Tree Scan on document_index_entries`,
      `INDEX ID: ${indexId}`,
      `FIELDS: ${JSON.stringify(indexFields)}`,
      "--------------------------------------------------------------------------------",
      "QUERY:",
      explainSql.trim(),
      "--------------------------------------------------------------------------------",
      "EXPLAIN (ANALYZE, BUFFERS, VERBOSE) PLAN:",
      planText,
      "================================================================================\n\n",
    ].join("\n");

    fs.writeFileSync(logFilePath, logEntry, { flag: "w" });
  });

  it("captures real EXPLAIN ANALYZE for GIN scan on documents (idx_docs_data_gin_active)", async () => {
    await dataClient.query("BEGIN");
    await dataClient.query(`SET LOCAL app.current_project_id = '${projectId}'`);
    await dataClient.query("SET LOCAL enable_seqscan = off");
    await dataClient.query("SET LOCAL enable_indexscan = off");
    await dataClient.query("SET LOCAL enable_bitmapscan = on");

    const explainSql = `
      EXPLAIN (ANALYZE, BUFFERS, VERBOSE)
      SELECT d.*
        FROM documents d
       WHERE d.deleted_at IS NULL
         AND d.data @> $1::jsonb
       LIMIT 10;
    `;

    const filterObj = JSON.stringify({ country: "DE", status: "active" });
    const res = await dataClient.query(explainSql, [filterObj]);
    await dataClient.query("COMMIT");

    const planText = res.rows.map((r: { "QUERY PLAN": string }) => r["QUERY PLAN"]).join("\n");

    // Must verify the plan uses GIN scan on idx_docs_data_gin_active
    expect(planText).toMatch(/idx_docs_data_gin_active/i);
    expect(planText).toMatch(/Bitmap Index Scan/i);

    const logEntry = [
      "================================================================================",
      `TIMESTAMP: ${new Date().toISOString()}`,
      `DATABASE: PostgreSQL (Neon Serverless)`,
      `TEST: GIN Index Scan on documents (idx_docs_data_gin_active)`,
      `FILTER: ${filterObj}`,
      "--------------------------------------------------------------------------------",
      "QUERY:",
      explainSql.trim(),
      "--------------------------------------------------------------------------------",
      "EXPLAIN (ANALYZE, BUFFERS, VERBOSE) PLAN:",
      planText,
      "================================================================================\n\n",
    ].join("\n");

    fs.appendFileSync(logFilePath, logEntry);
  });
});
