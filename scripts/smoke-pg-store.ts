#!/usr/bin/env node
/**
 * `scripts/smoke-pg-store.ts`
 * Quick end-to-end proof that `PgControlPlaneStore` round-trips real rows in PostgreSQL.
 * Not part of the E2E suite; used by the operator to confirm the wiring.
 *
 * Usage: npx tsx scripts/smoke-pg-store.ts [--keep]
 */

import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  PgControlPlaneStore,
  loadEnvFiles,
  type ControlPlaneRepository,
} from "../packages/database-control/src/index.js";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, "..");

async function main(): Promise<void> {
  const keep = process.argv.includes("--keep");
  loadEnvFiles([path.join(REPO_ROOT, ".env.phase5.local"), path.join(REPO_ROOT, ".env")]);

  const runId = process.env.PHASE5_RUN_ID ?? `smoke_${Date.now()}`;
  console.log(`run id: ${runId}`);

  const store: ControlPlaneRepository = new PgControlPlaneStore({
    connectionString: process.env.CONTROL_DATABASE_URL,
    logger: {
      info: (m) => console.log("  [store]", m),
      warn: (m) => console.warn("  [store]", m),
      error: (m) => console.error("  [store]", m),
    },
  });

  await (store as unknown as { initialize(): Promise<void> }).initialize();
  console.log("initialized: SELECT 1 ok, cache hydrated");

  const user = await store.createUser({ email: `${runId}@example.com`, name: "Phase 5 Smoke" });
  const org = await store.createOrganization({
    slug: `${runId}-org`.replace(/_/g, "-"),
    name: "Phase 5 Smoke Org",
    billingEmail: `${runId}@billing.example.com`,
  });
  const created = await store.createProject({
    organizationId: org.id,
    slug: `${runId}-proj`.replace(/_/g, "-"),
    name: "Phase 5 Smoke Project",
  });

  console.log(`created user=${user.id.slice(0, 8)} org=${org.id.slice(0, 8)} project=${created.project.id.slice(0, 8)}`);

  const ruleset = await store.publishSecurityRuleset({
    projectId: created.project.id,
    rulesAst: { match: "/users/{uid}", allow: ["read", "write"] },
  });
  console.log(`published ruleset v${ruleset.version}, active=${store.getActiveRuleset(created.project.id)?.version}`);

  if (!keep) {
    // Hard-delete the smoke rows so repeated runs stay clean.
    const pool = (store as unknown as { pool: { query: Function } }).pool;
    await pool.query("DELETE FROM audit_logs WHERE organization_id = $1 OR project_id = $2", [org.id, created.project.id]);
    await pool.query("DELETE FROM security_rulesets WHERE project_id = $1", [created.project.id]);
    await pool.query("DELETE FROM api_keys WHERE project_id = $1", [created.project.id]);
    await pool.query("DELETE FROM project_usage_daily WHERE project_id = $1", [created.project.id]);
    await pool.query("DELETE FROM projects WHERE id = $1", [created.project.id]);
    await pool.query("DELETE FROM organization_members WHERE organization_id = $1", [org.id]);
    await pool.query("DELETE FROM organizations WHERE id = $1", [org.id]);
    await pool.query("DELETE FROM users WHERE id = $1", [user.id]);
    console.log("cleaned up smoke rows");
  }

  const closer = store as unknown as { close?: () => Promise<void> };
  if (typeof closer.close === "function") await closer.close();
  console.log("OK");
}

main().catch((err: unknown) => {
  console.error("smoke failed:", err instanceof Error ? err.message : String(err));
  process.exit(1);
});
