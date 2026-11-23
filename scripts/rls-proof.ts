import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRawPgClient, loadEnvFiles, quotePgIdentifier } from "../packages/database-control/src/index.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
loadEnvFiles([path.join(root, ".env.phase5.local"), path.join(root, ".env")]);

const role = "vellum_phase5_rls";
const client = createRawPgClient({ connectionString: process.env.DATA_DATABASE_URL_DIRECT ?? "", applicationName: "vellum-rls-proof" });
await client.connect();
try {
  await client.query(`DO $$ BEGIN CREATE ROLE ${quotePgIdentifier(role)} LOGIN PASSWORD 'phase5_rls_local_only'; EXCEPTION WHEN duplicate_object THEN NULL; END $$`);
  await client.query(`GRANT USAGE ON SCHEMA public TO ${quotePgIdentifier(role)}`);
  await client.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON documents, document_indexes, document_index_entries, realtime_outbox TO ${quotePgIdentifier(role)}`);
  await client.query(`GRANT ${quotePgIdentifier(role)} TO CURRENT_USER`);
  const rows = await client.query("select count(*)::int as count from documents");
  console.log(`owner without tenant context: ${rows.rows[0]?.count ?? "unknown"}`);
  const tenant = await client.query("select project_id from documents limit 1");
  const projectId = tenant.rows[0]?.project_id as string | undefined;
  await client.query("BEGIN");
  await client.query("SET LOCAL ROLE vellum_phase5_rls");
  const noContext = await client.query("select count(*)::int as count from documents");
  await client.query("SELECT set_config('app.current_project_id', $1, true)", ["00000000-0000-0000-0000-000000000000"]);
  const mismatched = await client.query("select count(*)::int as count from documents");
  await client.query("SELECT set_config('app.current_project_id', $1, true)", [projectId ?? "00000000-0000-0000-0000-000000000000"]);
  const correct = await client.query("select count(*)::int as count from documents");
  await client.query("ROLLBACK");
  console.log(`non-owner without context: ${noContext.rows[0]?.count ?? "unknown"}`);
  console.log(`non-owner mismatched context: ${mismatched.rows[0]?.count ?? "unknown"}`);
  console.log(`non-owner correct context: ${correct.rows[0]?.count ?? "unknown"}`);
} finally {
  await client.end();
}
