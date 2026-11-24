import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createRealmSessionService } from "@vellum/auth";
import { createPgRevocationStore, PgControlPlaneStore } from "@vellum/database-control/adapters";
import { createRawPgClient, type RawPgClient } from "@vellum/database-control";
import { getUserOrgMemberships } from "../../apps/api/src/middleware/session.js";

const controlUrl = process.env.CONTROL_DATABASE_URL;
const enabled = process.env.SESSION_STATE_PG_TEST === "1";
const orgId = randomUUID();
const userId = randomUUID();
let raw: RawPgClient;
let a: PgControlPlaneStore;
let b: PgControlPlaneStore;

function percentile(sorted: number[], p: number): number {
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))] ?? 0;
}

// Two independent pools stand in for two API instances. Nothing is shared except PostgreSQL.
describe.skipIf(!enabled)("session revocations and memberships are read from PostgreSQL", () => {
  beforeAll(async () => {
    if (!controlUrl) throw new Error("session state PG tests require CONTROL_DATABASE_URL");
    raw = createRawPgClient({ connectionString: controlUrl });
    await raw.connect();
    await raw.query("INSERT INTO organizations(id,slug,name,billing_email) VALUES($1,$2,'Sess PG','sess@example.invalid')", [orgId, `sp-${orgId}`]);
    await raw.query("INSERT INTO users(id,email,name) VALUES($1,$2,'Sess')", [userId, `${userId}@example.invalid`]);
    a = new PgControlPlaneStore({ connectionString: controlUrl });
    b = new PgControlPlaneStore({ connectionString: controlUrl });
  }, 30000);

  afterAll(async () => {
    await raw.query("DELETE FROM session_revocations WHERE realm='customer_console' AND jti LIKE 'pgtest-%'");
    await raw.query("DELETE FROM organization_members WHERE organization_id=$1", [orgId]);
    await raw.query("DELETE FROM users WHERE id=$1", [userId]);
    await raw.query("DELETE FROM organizations WHERE id=$1", [orgId]);
    await raw.end();
    await Promise.all([a.close(), b.close()]);
  });

  it("a sign-out on instance A is rejected by instance B at once, across a real token", async () => {
    const secret = "pg-shared-secret-0123456789-0123456789";
    const svcA = createRealmSessionService({ realm: "customer_console", secret, revocationStore: createPgRevocationStore(a.pool, "customer_console") });
    const svcB = createRealmSessionService({ realm: "customer_console", secret, revocationStore: createPgRevocationStore(b.pool, "customer_console") });
    const token = svcA.signAccess({ sub: userId, uid: userId, role: "owner", orgIds: [orgId] });
    const claims = await svcB.verifyAccessChecked(token);
    await svcA.revoke(claims.jti, claims.exp * 1000);
    await expect(svcB.verifyAccessChecked(token)).rejects.toThrow(/revoked/);
    // Realm scoped: the same jti under the other realm's store is not revoked.
    expect(await createPgRevocationStore(b.pool, "super_admin").isRevoked(claims.jti)).toBe(false);
  });

  it("revocations expire and are not returned after expiry", async () => {
    await raw.query("INSERT INTO session_revocations(jti,realm,expires_at) VALUES('pgtest-expired','customer_console', now() - interval '1 minute')");
    expect(await createPgRevocationStore(a.pool, "customer_console").isRevoked("pgtest-expired")).toBe(false);
  });

  it("membership changes made through one instance apply on the next call elsewhere", async () => {
    expect(await getUserOrgMemberships(a, userId)).toEqual([]);
    await raw.query("INSERT INTO organization_members(organization_id,user_id,role) VALUES($1,$2,'developer')", [orgId, userId]);
    expect(await getUserOrgMemberships(b, userId)).toEqual([{ organizationId: orgId, role: "developer" }]);
    await raw.query("DELETE FROM organization_members WHERE organization_id=$1 AND user_id=$2", [orgId, userId]);
    expect(await getUserOrgMemberships(a, userId)).toEqual([]);
  });

  it("lookups use indexes and report latency", async () => {
    const plan = await raw.query("EXPLAIN SELECT 1 FROM session_revocations WHERE jti='x' AND realm='customer_console' AND expires_at > now()");
    expect(JSON.stringify(plan.rows)).toMatch(/Index/);
    // Tiny test tables would otherwise choose a sequential scan; we are checking an index exists.
    await raw.query("SET enable_seqscan=off");
    const plan3 = await raw.query("EXPLAIN SELECT organization_id, role FROM organization_members WHERE user_id='" + userId + "'");
    expect(JSON.stringify(plan3.rows)).toMatch(/Index/);
    const store = createPgRevocationStore(a.pool, "customer_console");
    const samples: number[] = [];
    for (let i = 0; i < 200; i += 1) {
      const t = performance.now();
      await store.isRevoked(`pgtest-${i}`);
      samples.push(performance.now() - t);
    }
    samples.sort((x, y) => x - y);
    console.log(`session_revocations isRevoked ms p50=${percentile(samples, 50).toFixed(2)} p95=${percentile(samples, 95).toFixed(2)} p99=${percentile(samples, 99).toFixed(2)}`);
    expect(percentile(samples, 99)).toBeLessThan(250);
  });

  it("user lookup by email is authoritative: a user created or suspended elsewhere is seen at once", async () => {
    const email = `${userId}@example.invalid`;
    const found = await b.findUserByEmail(email.toUpperCase());
    expect(found?.id).toBe(userId);
    expect(found?.isSuspended).toBe(false);
    await raw.query("UPDATE users SET is_suspended = true WHERE id=$1", [userId]);
    expect((await a.findUserByEmail(email))?.isSuspended).toBe(true);
    expect(await a.findUserByEmail(`nobody-${userId}@example.invalid`)).toBeNull();
    await raw.query("UPDATE users SET is_suspended = false WHERE id=$1", [userId]);
  });
});
