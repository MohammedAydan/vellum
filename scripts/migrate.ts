#!/usr/bin/env node
/**
 * `scripts/migrate.ts`
 * Idempotent PostgreSQL migration runner for the Document Database SaaS control plane
 * (`control_db`) and data plane (`data_db`).
 *
 * Usage:
 *   npx tsx scripts/migrate.ts                     # apply both planes
 *   npx tsx scripts/migrate.ts --status            # print applied migrations only
 *   npx tsx scripts/migrate.ts --dry-run           # list pending migrations, change nothing
 *   npx tsx scripts/migrate.ts --only=control      # single plane
 *   npx tsx scripts/migrate.ts --env-file=.env.phase5.local
 *
 * Exit codes: 0 = success, 1 = failure.
 * Never prints connection strings or credentials.
 */

import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  controlMigrationsDir,
  createRawPgClient,
  dataMigrationsDir,
  getMigrationStatus,
  loadEnvFiles,
  redactConnectionString,
  runMigrationsOnClient,
  type MigrationRunResult,
} from "../packages/database-control/src/index.js";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, "..");

interface CliOptions {
  statusOnly: boolean;
  dryRun: boolean;
  only: "control" | "data" | "both";
  envFiles: string[];
}

function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = {
    statusOnly: false,
    dryRun: false,
    only: "both",
    // Resolved against the repository root so the script works from any cwd
    // (including `pnpm --filter <pkg> migrate`).
    envFiles: [path.join(REPO_ROOT, ".env.phase5.local"), path.join(REPO_ROOT, ".env")],
  };

  for (const arg of argv) {
    if (arg === "--status") {
      options.statusOnly = true;
      continue;
    }
    if (arg === "--dry-run") {
      options.dryRun = true;
      continue;
    }
    if (arg.startsWith("--only=")) {
      const value = arg.slice("--only=".length);
      if (value !== "control" && value !== "data" && value !== "both") {
        throw new Error(`Invalid --only value '${value}'. Expected 'control', 'data' or 'both'.`);
      }
      options.only = value;
      continue;
    }
    if (arg.startsWith("--env-file=")) {
      options.envFiles = [arg.slice("--env-file=".length)];
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      console.log(
        "Usage: tsx scripts/migrate.ts [--status] [--dry-run] [--only=control|data|both] [--env-file=<path>]"
      );
      process.exit(0);
    }
    throw new Error(`Unknown argument '${arg}'`);
  }
  return options;
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value || value.trim().length === 0) {
    throw new Error(
      `Missing required environment variable ${name}. ` +
        `Provide it in .env.phase5.local, .env, or the process configuration.`
    );
  }
  return value;
}

interface PlaneSpec {
  label: string;
  directUrlEnv: string;
  pooledUrlEnv: string;
  directory: string;
}

const PLANES: PlaneSpec[] = [
  {
    label: "control_db",
    directUrlEnv: "CONTROL_DATABASE_URL_DIRECT",
    pooledUrlEnv: "CONTROL_DATABASE_URL",
    directory: controlMigrationsDir(),
  },
  {
    label: "data_db",
    directUrlEnv: "DATA_DATABASE_URL_DIRECT",
    pooledUrlEnv: "DATA_DATABASE_URL",
    directory: dataMigrationsDir(),
  },
];

async function runPlane(spec: PlaneSpec, options: CliOptions): Promise<MigrationRunResult | null> {
  // DDL must run on a direct (non-pooled) connection when available. Ignore
  // placeholder values so a not-yet-configured DIRECT var never shadows a real
  // pooled URL (e.g. during a Vercel build where only the runtime URLs are set).
  const direct = process.env[spec.directUrlEnv];
  const usableDirect = direct && !direct.includes("CHANGE_ME") ? direct : undefined;
  const url = usableDirect ?? process.env[spec.pooledUrlEnv];
  if (!url) {
    throw new Error(
      `Missing ${spec.directUrlEnv} / ${spec.pooledUrlEnv}. Cannot migrate '${spec.label}'.`
    );
  }

  console.log(`\n── ${spec.label} ─────────────────────────────────────────────`);
  console.log(`   connection : ${redactConnectionString(url)}`);
  console.log(`   migrations : ${spec.directory}`);

  const client = createRawPgClient({ connectionString: url, applicationName: "vellum-migrate" });
  await client.connect();
  try {
    if (options.statusOnly) {
      const rows = await getMigrationStatus(client);
      if (rows.length === 0) {
        console.log("   status     : no migrations recorded (database is unmigrated)");
      } else {
        console.log(`   status     : ${rows.length} applied`);
        for (const row of rows) {
          console.log(`     ✔ ${row.filename}  (${row.appliedAt})`);
        }
      }
      return null;
    }

    return await runMigrationsOnClient({
      client,
      directory: spec.directory,
      label: spec.label,
      dryRun: options.dryRun,
      onProgress: (message) => console.log(`   ${message}`),
    });
  } finally {
    await client.end();
  }
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));

  const loaded = loadEnvFiles(options.envFiles);
  if (loaded) {
    console.log(`Loaded configuration from ${loaded.path}`);
  } else {
    console.log("No .env file found; relying on the process configuration.");
  }

  // `--only=control|data` are the documented aliases for the `*_db` plane labels.
  const selected = PLANES.filter(
    (plane) => options.only === "both" || plane.label === `${options.only}_db`
  );

  const results: MigrationRunResult[] = [];
  for (const plane of selected) {
    const result = await runPlane(plane, options);
    if (result) results.push(result);
  }

  if (options.statusOnly) {
    console.log("\nMigration status check complete.");
    return;
  }

  console.log("\n── summary ──────────────────────────────────────────────────");
  let totalApplied = 0;
  for (const result of results) {
    totalApplied += result.applied.filter((m) => m.applied).length;
    console.log(
      `   ${result.label}: ${result.applied.filter((m) => m.applied).length} applied, ` +
        `${result.alreadyApplied.length} already applied`
    );
  }
  console.log(
    options.dryRun
      ? `\nDry run complete. ${totalApplied} migration(s) pending.`
      : `\nDone. ${totalApplied} migration(s) applied.`
  );
}

main().catch((err: unknown) => {
  console.error(`\n✖ Migration failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
