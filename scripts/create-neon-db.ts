import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRawPgClient, loadEnvFiles } from "../packages/database-control/src/index.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
loadEnvFiles([path.join(root, ".env.phase5.local"), path.join(root, ".env")]);
const database = process.argv[2];
if (!database || !/^[a-z][a-z0-9_]{0,62}$/.test(database)) throw new Error("safe database name required");
const base = process.env.CONTROL_DATABASE_URL_DIRECT ?? "";
const url = new URL(base);
url.pathname = "/postgres";
const client = createRawPgClient({ connectionString: url.toString(), applicationName: "vellum-create-db" });
await client.connect();
try {
  const found = await client.query("select 1 from pg_database where datname = $1", [database]);
  if (found.rowCount === 0) await client.query(`CREATE DATABASE "${database}"`);
  console.log(`database ready: ${database}`);
} finally {
  await client.end();
}
