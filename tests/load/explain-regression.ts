/**
 * strict EXPLAIN regression guard for indexed collections.
 *
 * Extends the Query agent's `tests/integration/query/query-sql.test.ts` (which
 * asserts an Index Scan for one compiled shape) with two differences:
 *   1. Structured `EXPLAIN (FORMAT JSON)` analysis that fails on ANY Seq Scan
 *      node, recursively, across both the composite-index and GIN paths.
 *   2. No `SET LOCAL enable_seqscan = off` — planner hints are forbidden here,
 *      because they would hide a missing-index regression.
 *
 * Run: `corepack pnpm bench:explain`. Uses the direct PostgreSQL URL from
 * `.env.phase5.local` (loaded via dotenv-compatible `loadEnvFiles`). Never
 * prints a connection string or secret.
 */
import crypto from "node:crypto";
import path from "node:path";
import { createRawPgClient, loadEnvFiles } from "../../packages/database-control/src/index.js";
import { encodeCompositeSortKey } from "../../packages/core/src/index.js";
import { assertNoSeqScan } from "./explain-guard.js";

const DOC_COUNT = 2_000;
const CHUNK = 500;

async function main(connectionString: string): Promise<void> {
  const client = createRawPgClient({
    connectionString,
    applicationName: "vellum-task804-explain-regression",
  });
  const projectId = crypto.randomUUID();
  const collectionPath = `explain_guard_${Date.now()}`;
  const indexId = crypto.randomUUID();
  const indexFields = [
    { path: "status", dir: "asc" as const },
    { path: "score", dir: "desc" as const },
  ];

  await client.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      `INSERT INTO document_indexes (id, project_id, collection_path, fields, definition_hash, status)
       VALUES ($1::uuid, $2::uuid, $3, $4::jsonb, $5, 'ready')`,
      [indexId, projectId, collectionPath, JSON.stringify(indexFields), crypto.randomUUID().replace(/-/g, "")]
    );

    for (let offset = 0; offset < DOC_COUNT; offset += CHUNK) {
      const paths: string[] = [];
      const collectionPaths: string[] = [];
      const documentIds: string[] = [];
      const dataJson: string[] = [];
      const sortKeys: Buffer[] = [];

      for (let index = offset; index < offset + CHUNK; index += 1) {
        const documentId = `doc_${String(index).padStart(6, "0")}`;
        const docPath = `${collectionPath}/${documentId}`;
        const now = new Date().toISOString();
        const data = {
          status: index % 2 === 0 ? "active" : "pending",
          country: index % 10 === 0 ? "DE" : "XX",
          score: index * 7,
          tags: ["city", index % 10 === 0 ? "major" : "regional"],
        };
        paths.push(docPath);
        collectionPaths.push(collectionPath);
        documentIds.push(documentId);
        dataJson.push(JSON.stringify(data));
        sortKeys.push(
          encodeCompositeSortKey(
            { documentId, createdAt: now, updatedAt: now, data },
            indexFields
          )
        );
      }

      await client.query(
        `INSERT INTO documents (
           project_id, path, collection_path, collection_group,
           document_id, path_depth, data, size_bytes, version, created_at, updated_at
         )
         SELECT $1::uuid, u.path, u.collection_path, u.collection_path,
                u.document_id, 2, u.data::jsonb, 256, 1, now(), now()
           FROM unnest($2::text[], $3::text[], $4::text[], $5::text[])
             AS u(path, collection_path, document_id, data)`,
        [projectId, paths, collectionPaths, documentIds, dataJson]
      );
      await client.query(
        `INSERT INTO document_index_entries (
           index_id, project_id, collection_path, sort_key, document_id, path
         )
         SELECT $1::uuid, $2::uuid, u.collection_path, u.sort_key, u.document_id, u.path
           FROM unnest($3::text[], $4::bytea[], $5::text[], $6::text[])
             AS u(collection_path, sort_key, document_id, path)
         ON CONFLICT (index_id, sort_key, document_id) DO NOTHING`,
        [indexId, projectId, collectionPaths, sortKeys, documentIds, paths]
      );
    }

    await client.query("ANALYZE documents");
    await client.query("ANALYZE document_index_entries");

    const composite = await client.query(
      `EXPLAIN (FORMAT JSON)
       SELECT d.path
         FROM document_index_entries e
         JOIN documents d
           ON d.project_id = e.project_id AND d.path = e.path
        WHERE e.index_id = $1::uuid AND e.project_id = $2::uuid
          AND d.deleted_at IS NULL
        ORDER BY e.sort_key ASC, e.document_id ASC
        LIMIT 10`,
      [indexId, projectId]
    );
    const compositeAnalysis = assertNoSeqScan(composite.rows, "composite-index sort_key scan");
    // eslint-disable-next-line no-console
    console.log(
      `[load] composite EXPLAIN OK: nodes=${compositeAnalysis.nodeTypes.join(",")} indexScans=${compositeAnalysis.indexScans.length}`
    );

    const gin = await client.query(
      `EXPLAIN (FORMAT JSON)
       SELECT d.path
         FROM documents d
        WHERE d.project_id = $1::uuid
          AND d.deleted_at IS NULL
          AND d.data @> $2::jsonb
        LIMIT 10`,
      [projectId, JSON.stringify({ country: "DE", status: "active" })]
    );
    const ginAnalysis = assertNoSeqScan(gin.rows, "GIN jsonb containment scan");
    // eslint-disable-next-line no-console
    console.log(
      `[load] GIN EXPLAIN OK: nodes=${ginAnalysis.nodeTypes.join(",")} indexScans=${ginAnalysis.indexScans.length}`
    );

    await client.query("COMMIT");
    // eslint-disable-next-line no-console
    console.log(`[load] EXPLAIN regression PASS (${DOC_COUNT} indexed documents, no Seq Scan, no planner hints)`);
  } catch (error: unknown) {
    try {
      await client.query("ROLLBACK");
    } catch {
      /* best effort */
    }
    throw error;
  } finally {
    try {
      await client.query(
        `DELETE FROM document_index_entries WHERE project_id = $1::uuid`,
        [projectId]
      );
      await client.query(`DELETE FROM document_indexes WHERE project_id = $1::uuid`, [projectId]);
      await client.query(`DELETE FROM documents WHERE project_id = $1::uuid`, [projectId]);
    } catch (error: unknown) {
      // eslint-disable-next-line no-console
      console.error(`[load] cleanup warning: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      await client.end();
    }
  }
}

loadEnvFiles([path.resolve(".env.phase5.local"), path.resolve(".env")]);
const connectionString = process.env.DATA_DATABASE_URL_DIRECT ?? process.env.DATA_DATABASE_URL;
if (connectionString === undefined || connectionString === "") {
  // eslint-disable-next-line no-console
  console.log("[load] SKIP EXPLAIN regression: no DATA_DATABASE_URL_DIRECT / DATA_DATABASE_URL configured. Set one of them to enable the strict Seq Scan gate.");
} else {
  await main(connectionString);
}
