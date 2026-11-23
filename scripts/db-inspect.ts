#!/usr/bin/env node
/**
 * `scripts/db-inspect.ts`
 * Read-only inspection helper for the Phase 5 databases.
 *
 * Usage:
 *   npx tsx scripts/db-inspect.ts tables [control|data]
 *   npx tsx scripts/db-inspect.ts policies [control|data]
 *   npx tsx scripts/db-inspect.ts rls [control|data]
 *   npx tsx scripts/db-inspect.ts migrations [control|data]
 *   npx tsx scripts/db-inspect.ts counts [control|data]
 *   npx tsx scripts/db-inspect.ts sql "<query>" [control|data]
 *
 * Never prints connection strings or credentials.
 */

import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRawPgClient, loadEnvFiles, redactConnectionString } from "../packages/database-control/src/index.js";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, "..");

function resolveUrl(plane: string): string {
  const url =
    plane === "data"
      ? process.env.DATA_DATABASE_URL_DIRECT ?? process.env.DATA_DATABASE_URL
      : process.env.CONTROL_DATABASE_URL_DIRECT ?? process.env.CONTROL_DATABASE_URL;
  if (!url) {
    throw new Error(`Missing URL env var for plane '${plane}'.`);
  }
  return url;
}

async function withClient<T>(plane: string, fn: (c: Awaited<ReturnType<typeof createRawPgClient>>) => Promise<T>): Promise<T> {
  const client = createRawPgClient({ connectionString: resolveUrl(plane), applicationName: "vellum-inspect" });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

const COMMANDS: Record<string, string> = {
  tables: "select tablename from pg_tables where schemaname='public' order by 1",
  policies:
    "select tablename, policyname, cmd, roles from pg_policies where schemaname='public' order by tablename, policyname",
  rls: "select relname, relrowsecurity, relforcerowsecurity from pg_class where relkind='r' and relnamespace='public'::regnamespace order by relname",
  migrations: "select filename, applied_at from schema_migrations order by filename",
  counts:
    "select 'documents' t, count(*) n from documents union all select 'document_index_entries', count(*) from document_index_entries union all select 'document_indexes', count(*) from document_indexes union all select 'realtime_outbox', count(*) from realtime_outbox",
};

async function main(): Promise<void> {
  loadEnvFiles([path.join(REPO_ROOT, ".env.phase5.local"), path.join(REPO_ROOT, ".env")]);

  const [, , command, arg2] = process.argv;
  if (!command) {
    console.error("Usage: npx tsx scripts/db-inspect.ts <command> [control|data]");
    process.exit(1);
  }

  if (command === "sql") {
    const queryIndex = process.argv.indexOf("sql");
    const query = process.argv[queryIndex + 1];
    if (!query) {
      console.error("Missing SQL query after 'sql'.");
      process.exit(1);
    }
    const plane = process.argv[queryIndex + 2] ?? "data";
    const rows = await withClient(plane, (c) => c.query(query));
    console.log(JSON.stringify(rows.rows, null, 2));
    return;
  }

  const plane = (arg2 as string) ?? "data";
  const query = COMMANDS[command];
  if (!query) {
    console.error(`Unknown command '${command}'. Known: ${Object.keys(COMMANDS).join(", ")}, sql`);
    process.exit(1);
  }

  console.log(`${plane}: ${redactConnectionString(resolveUrl(plane))}`);
  const rows = await withClient(plane, (c) => c.query(query));
  console.table(rows.rows);
}

main().catch((err: unknown) => {
  console.error(`db-inspect failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
