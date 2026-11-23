/**
 * tests/integration/auth-tenant-isolation
 *
 * LIVE Neon (data_db) proof that the five `project_auth_*` tables fail closed
 * under FORCE ROW LEVEL SECURITY:
 *   1. Cross-project SELECT returns 0 rows.
 *   2. A second cross-project SELECT (third project) returns 0 rows.
 *   3. Cross-tenant INSERT violates the WITH CHECK RLS policy (42501 / 0 rows).
 *   4. Queries with no `app.current_project_id` GUC return 0 rows (and INSERT fails).
 *
 * The direct connection role (`neondb_owner`) carries BYPASSRLS on Neon, so all
 * security assertions run as the non-BYPASSRLS `vellum_app` role via
 * `SET LOCAL ROLE`, exactly like the existing live RLS convention. Tenant
 * contexts are random project UUIDs that need no control-plane rows: the auth
 * tables carry `project_id` directly. Cleanup runs in dependency order.
 * Skipped unless PHASE5_REAL=1. No secrets are logged.
 */
import "./_live-env.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import crypto from "node:crypto";
import {
  createRawPgClient,
  type RawPgClient,
} from "../../packages/database-control/src/index.js";
import { withTenantData } from "../e2e-real/tenant-data-sql.js";
import { ensureLiveEnv } from "./_live-env.js";

const REAL_DATABASE_ENABLED = process.env.PHASE5_REAL === "1";
const prefix = `authiso_${Date.now()}_`;
const RLS_ASSERT_ROLE = "vellum_app";

interface Tenant {
  projectId: string;
}

// Three distinct projects; RLS isolation is keyed on project only.
const projectA: Tenant = { projectId: crypto.randomUUID() };
const projectB: Tenant = { projectId: crypto.randomUUID() };
const projectC: Tenant = { projectId: crypto.randomUUID() };

let dataClient: RawPgClient | undefined;
const userIdByTenant = new Map<string, string>();

const tenantKey = (t: Tenant): string => t.projectId;
const client = (): RawPgClient => dataClient as RawPgClient;

/** Bind the tenant GUC and drop BYPASSRLS for a real policy-enforced assertion. */
async function withAppRole<T>(t: Tenant, work: (tx: RawPgClient) => Promise<T>): Promise<T> {
  return withTenantData(client(), t.projectId, async (tx) => {
    await tx.query(`SET LOCAL ROLE ${RLS_ASSERT_ROLE}`);
    return work(tx);
  });
}

async function insertAuthUser(t: Tenant, email: string): Promise<string> {
  return withTenantData(client(), t.projectId, async (tx) => {
    const { rows } = await tx.query<{ id: string }>(
      `INSERT INTO project_auth_users
         (project_id, email, email_verified, password_hash, display_name)
       VALUES ($1::uuid, $2, FALSE, 'scrypt$fake$hash', $3)
       RETURNING id::text AS id`,
      [t.projectId, email, `${prefix}user`]
    );
    const id = rows[0]?.id;
    if (!id) throw new Error("auth user insert returned no id");
    return id;
  });
}

describe.skipIf(!REAL_DATABASE_ENABLED)("tests/integration/auth-tenant-isolation", () => {
  beforeAll(async () => {
    ensureLiveEnv();
    const dataUrl = process.env.DATA_DATABASE_URL_DIRECT ?? process.env.DATA_DATABASE_URL ?? "";
    if (!dataUrl) throw new Error("PHASE5_REAL=1 requires DATA_DATABASE_URL[_DIRECT]");
    if ((process.env.DATABASE_MODE ?? "memory") !== "postgres") {
      throw new Error("PHASE5_REAL=1 requires DATABASE_MODE=postgres");
    }
    dataClient = createRawPgClient({
      connectionString: dataUrl,
      applicationName: "vellum-authisolation-live-data",
    });
    await dataClient.connect();

    // The direct Neon role has BYPASSRLS. Grant ourselves the non-bypass role
    // used for assertions (mirrors the existing live RLS test convention).
    await client().query(`GRANT ${RLS_ASSERT_ROLE} TO CURRENT_USER`).catch(() => undefined);

    // FORCE RLS is asserted here too: a mis-configured DB (RLS disabled) must
    // fail the suite rather than silently pass every "zero rows" assertion.
    const rls = await client().query<{
      relname: string;
      relrowsecurity: boolean;
      relforcerowsecurity: boolean;
    }>(
      "SELECT relname, relrowsecurity, relforcerowsecurity FROM pg_class " +
        "WHERE relname IN ('project_auth_users','project_auth_identities','project_auth_sessions'," +
        "'project_auth_mfa','project_auth_tokens')"
    );
    expect(rls.rows).toHaveLength(5);
    for (const row of rls.rows) {
      expect(row.relrowsecurity, `RLS disabled on ${row.relname}`).toBe(true);
      expect(row.relforcerowsecurity, `FORCE RLS disabled on ${row.relname}`).toBe(true);
    }

    userIdByTenant.set(tenantKey(projectA), await insertAuthUser(projectA, `${prefix}aproj@example.com`));
    userIdByTenant.set(tenantKey(projectB), await insertAuthUser(projectB, `${prefix}bproj@example.com`));
    userIdByTenant.set(tenantKey(projectC), await insertAuthUser(projectC, `${prefix}cproj@example.com`));
  }, 60_000);

  afterAll(async () => {
    if (!dataClient) return;
    const tenants = [projectA, projectB, projectC];
    for (const tenant of tenants) {
      const id = userIdByTenant.get(tenantKey(tenant));
      await withTenantData(dataClient, tenant.projectId, async (tx) => {
        // Children first, then the parent (FK ON DELETE CASCADE also covers this).
        await tx.query("DELETE FROM project_auth_tokens WHERE user_id = $1::uuid", [id]);
        await tx.query("DELETE FROM project_auth_mfa WHERE user_id = $1::uuid", [id]);
        await tx.query("DELETE FROM project_auth_sessions WHERE user_id = $1::uuid", [id]);
        await tx.query("DELETE FROM project_auth_identities WHERE user_id = $1::uuid", [id]);
        await tx.query("DELETE FROM project_auth_users WHERE id = $1::uuid", [id]);
      });
    }
    await dataClient.end();
  }, 60_000);

  it("cross-project SELECT returns zero rows even when the target id is known", async () => {
    const targetA = userIdByTenant.get(tenantKey(projectA));
    const targetB = userIdByTenant.get(tenantKey(projectB));
    expect(targetA).toBeTruthy();
    expect(targetB).toBeTruthy();

    await withAppRole(projectB, async (tx) => {
      const rows = await tx.query<{ id: string }>(
        "SELECT id::text AS id FROM project_auth_users WHERE id = $1::uuid",
        [targetA]
      );
      expect(rows.rows).toHaveLength(0);

      const count = await tx.query<{ n: number }>(
        "SELECT count(*)::int AS n FROM project_auth_users WHERE project_id = $1::uuid",
        [projectA.projectId]
      );
      expect(Number(count.rows[0]?.n ?? -1)).toBe(0);
    });

    // Symmetric direction: A cannot read B.
    await withAppRole(projectA, async (tx) => {
      const rows = await tx.query<{ id: string }>(
        "SELECT id::text AS id FROM project_auth_users WHERE id = $1::uuid",
        [targetB]
      );
      expect(rows.rows).toHaveLength(0);
    });
  }, 60_000);

  it("a second cross-project SELECT (third project) returns zero rows", async () => {
    const targetC = userIdByTenant.get(tenantKey(projectC));
    expect(targetC).toBeTruthy();

    // Bound to project A, ask for project C's row by exact id and by project id.
    await withAppRole(projectA, async (tx) => {
      const rows = await tx.query<{ id: string }>(
        "SELECT id::text AS id FROM project_auth_users WHERE id = $1::uuid",
        [targetC]
      );
      expect(rows.rows).toHaveLength(0);

      const byProject = await tx.query<{ n: number }>(
        "SELECT count(*)::int AS n FROM project_auth_users WHERE project_id = $1::uuid",
        [projectC.projectId]
      );
      expect(Number(byProject.rows[0]?.n ?? -1)).toBe(0);
    });
  }, 60_000);

  it("cross-tenant INSERT violates the WITH CHECK policy (42501 or zero rows)", async () => {
    const email = `${prefix}crossinsert@example.com`;
    let thrownCode = "";
    let inserted = 0;
    try {
      await withAppRole(projectB, async (tx) => {
        const res = await tx.query(
          `INSERT INTO project_auth_users
             (project_id, email, email_verified)
           VALUES ($1::uuid, $2, FALSE)`,
          [projectA.projectId, email]
        );
        inserted = res.rowCount ?? 0;
      });
    } catch (error: unknown) {
      thrownCode =
        typeof error === "object" && error !== null && "code" in error
          ? String((error as { code: unknown }).code)
          : "";
    }
    if (thrownCode) expect(thrownCode).toBe("42501");
    else expect(inserted).toBe(0);

    // Defense in depth: confirm the row truly does not exist in project A.
    await withTenantData(client(), projectA.projectId, async (tx) => {
      const rows = await tx.query("SELECT id FROM project_auth_users WHERE email = $1", [email]);
      expect(rows.rows).toHaveLength(0);
    });
  }, 60_000);

  it("queries with NO tenant GUC fail closed (zero rows / RLS error)", async () => {
    const c = client();
    await c.query("BEGIN");
    try {
      // Drop BYPASSRLS and explicitly blank the tenant GUC inside the tx.
      await c.query(`SET LOCAL ROLE ${RLS_ASSERT_ROLE}`);
      await c.query("SELECT set_config('app.current_project_id', '', true)");

      const all = await c.query<{ n: number }>("SELECT count(*)::int AS n FROM project_auth_users");
      expect(Number(all.rows[0]?.n ?? -1)).toBe(0);

      const targetA = userIdByTenant.get(tenantKey(projectA));
      const direct = await c.query("SELECT id FROM project_auth_users WHERE id = $1::uuid", [targetA]);
      expect(direct.rows).toHaveLength(0);

      // Insert with no context must also be blocked.
      let thrownCode = "";
      let inserted = 0;
      try {
        const res = await c.query(
          `INSERT INTO project_auth_users
             (project_id, email, email_verified)
           VALUES ($1::uuid, $2, FALSE)`,
          [projectA.projectId, `${prefix}nocontext@example.com`]
        );
        inserted = res.rowCount ?? 0;
      } catch (error: unknown) {
        thrownCode =
          typeof error === "object" && error !== null && "code" in error
            ? String((error as { code: unknown }).code)
            : "";
      }
      if (thrownCode) expect(thrownCode).toBe("42501");
      else expect(inserted).toBe(0);
    } finally {
      await c.query("ROLLBACK");
    }
  }, 60_000);

  it("a correctly-bound tenant context still sees exactly its own rows", async () => {
    const targetA = userIdByTenant.get(tenantKey(projectA));
    await withAppRole(projectA, async (tx) => {
      const rows = await tx.query<{ id: string }>(
        "SELECT id::text AS id FROM project_auth_users WHERE id = $1::uuid",
        [targetA]
      );
      expect(rows.rows).toHaveLength(1);
      expect(rows.rows[0]?.id).toBe(targetA);
    });
  }, 60_000);
});
