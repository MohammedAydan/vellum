import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  projectAuthIdentities,
  projectAuthMfa,
  projectAuthSessions,
  projectAuthTokens,
  projectAuthUsers,
} from "../schema.js";

const testDir = path.dirname(fileURLToPath(import.meta.url));
const authMigration = fs.readFileSync(
  path.resolve(testDir, "../../migrations/0005_project_auth.sql"),
  "utf8"
);
const cutoverMigration = fs.readFileSync(
  path.resolve(testDir, "../../migrations/0011_drop_environments.sql"),
  "utf8"
);

describe("database-data / end-user auth schema", () => {
  it("exports all five Drizzle auth tables", () => {
    expect(projectAuthUsers).toBeDefined();
    expect(projectAuthIdentities).toBeDefined();
    expect(projectAuthSessions).toBeDefined();
    expect(projectAuthMfa).toBeDefined();
    expect(projectAuthTokens).toBeDefined();
  });

  it("creates all five tables with replay-detection columns", () => {
    for (const table of [
      "project_auth_users",
      "project_auth_identities",
      "project_auth_sessions",
      "project_auth_mfa",
      "project_auth_tokens",
    ]) {
      expect(authMigration).toContain(`CREATE TABLE IF NOT EXISTS ${table}`);
      // The cutover migration drops the legacy tenant column from every table.
      expect(cutoverMigration).toContain(`'${table}'`);
    }
    expect(authMigration).toContain("previous_refresh_token_hash TEXT UNIQUE");
    expect(authMigration).toContain("rotation_counter INTEGER NOT NULL DEFAULT 0");
  });

  it("rebuilds FORCE RLS and per-table policies on project_id only", () => {
    expect(cutoverMigration).toContain("FORCE ROW LEVEL SECURITY");
    for (const table of [
      "project_auth_users",
      "project_auth_identities",
      "project_auth_sessions",
      "project_auth_mfa",
      "project_auth_tokens",
    ]) {
      expect(cutoverMigration).toContain(`'${table}'`);
      expect(cutoverMigration).toContain(`'tenant_rls_' || t`);
    }
    expect(cutoverMigration).toContain("DROP COLUMN IF EXISTS environment_id CASCADE");
    expect(cutoverMigration).toContain("app.current_project_id");
    expect(cutoverMigration).toContain("WITH CHECK");
    // 0011 is a checksum-protected historical migration and still grants to the
    // pre-rebrand role docdb_app; migration 0013_vellum_rebrand.sql renames the
    // role to vellum_app for existing deployments.
    expect(cutoverMigration).toContain("TO docdb_app");
    // Effective state has no environment tenant column / GUC.
    expect(cutoverMigration).not.toContain("app.current_environment_id");
  });
});
