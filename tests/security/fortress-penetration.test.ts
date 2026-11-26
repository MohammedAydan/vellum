/**
 * Security Fortress penetration suite (contract §8, tests 1-7).
 *
 * Every assertion exercises the real guards/middleware/routes from
 * `@vellum/security`, `apps/api` and the real control-plane repositories. The
 * PostgreSQL immutability case runs against the live control plane (the live
 * env bootstrap at the top of this file opts the suite in, exactly like
 * `tests/security/live-tenant-isolation.test.ts`). No secret, API key or
 * database URL is ever logged.
 */
// Must be first: opts this suite into the repo-root live Neon fixtures before
// any module that reads configuration at import time is evaluated.
import "./_security-live-env.js";

import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createRealmSessionService } from "@vellum/auth";
import {
  createInMemoryRevocationStore,
  generateProjectApiKey,
} from "@vellum/authorization";
import { createRawPgClient, type RawPgClient } from "@vellum/database-control";
import { ControlPlaneStore } from "@vellum/database-control/adapters";
import {
  assertQueryCost,
  assertSafeExternalUrl,
  assertSafeJsonPayload,
  computeChainHash,
  deriveChainKey,
  verifyHashChain,
  type ChainRow,
} from "@vellum/security";
import { createVellumPlatform } from "../../apps/api/src/index.js";

const JWT_SECRET = "fortress-test-jwt-secret-at-least-32-chars";
const PEPPER = "fortress-test-api-key-pepper-32-chars";

type ErrorEnvelope = {
  error: { code: string; message: string; requestId: string; details?: Record<string, unknown> };
};

/** Mimic a real HTTP request: Hono's `app.request()` does not set content-length. */
function jsonRequest(
  app: ReturnType<typeof createVellumPlatform>["app"],
  path: string,
  method: "GET" | "POST" | "PATCH" | "DELETE",
  body: unknown,
  headers: Record<string, string> = {}
): Promise<Response> {
  const raw = typeof body === "string" ? body : JSON.stringify(body);
  return app.request(path, {
    method,
    headers: {
      "content-type": "application/json",
      "content-length": String(Buffer.byteLength(raw, "utf8")),
      ...headers,
    },
    ...(method === "GET" || method === "DELETE" ? {} : { body: raw }),
  });
}

describe("§8 — Security Fortress penetration tests", () => {
  /* ---------------------------------------------------------------- *
   * 1. Prototype pollution
   * ---------------------------------------------------------------- */
  it("1. rejects __proto__ / constructor.prototype pollution at the guard and at HTTP, leaving Object.prototype untouched", async () => {
    const viaParse = JSON.parse('{"__proto__":{"isAdmin":true}}') as Record<string, unknown>;
    const nested = JSON.parse(
      '{"nested":{"constructor":{"prototype":{"isAdmin":true}}}}'
    ) as Record<string, unknown>;

    for (const payload of [viaParse, nested]) {
      const outcome = assertSafeJsonPayload(payload);
      expect(outcome.ok).toBe(false);
      if (!outcome.ok) {
        expect(outcome.threatCategory).toBe("prototype_pollution");
        expect(outcome.code).toBe("INVALID_ARGUMENT");
      }
    }
    expect(Object.prototype).not.toHaveProperty("isAdmin");
    expect(Object.prototype).not.toHaveProperty("polluted");

    const platform = createVellumPlatform({ jwtSecret: JWT_SECRET, apiKeyPepper: PEPPER });
    const beforeEvents = platform.threatDetector.stats().events;
    const res = await jsonRequest(
      platform.app,
      "/v1/projects/00000000-0000-4000-8000-000000000001/documents/probe/polluted",
      "POST",
      viaParse
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as ErrorEnvelope;
    expect(body.error.code).toBe("INVALID_ARGUMENT");
    expect(platform.threatDetector.stats().events).toBeGreaterThan(beforeEvents);
    expect(Object.prototype).not.toHaveProperty("isAdmin");
  });

  /* ---------------------------------------------------------------- *
   * 2. JSON depth + oversized document
   * ---------------------------------------------------------------- */
  it("2. rejects 30-level JSON and >1 MiB documents before engine execution", async () => {
    let deep: unknown = { leaf: true };
    for (let level = 0; level < 30; level += 1) deep = { child: deep };
    const deepOutcome = assertSafeJsonPayload(deep);
    expect(deepOutcome.ok).toBe(false);
    if (!deepOutcome.ok) expect(deepOutcome.code).toBe("MAX_NESTING_EXCEEDED");

    const platform = createVellumPlatform({ jwtSecret: JWT_SECRET, apiKeyPepper: PEPPER });
    const documentPath =
      "/v1/projects/00000000-0000-4000-8000-000000000002/documents/probe/deep";

    const deepRes = await jsonRequest(platform.app, documentPath, "POST", deep);
    expect(deepRes.status).toBe(400);
    expect(((await deepRes.json()) as ErrorEnvelope).error.code).toBe("INVALID_ARGUMENT");

    // The byte cap is enforced by the request-size middleware (content-length),
    // so set it exactly as a real HTTP adapter would. The guard itself has the
    // same locked ceiling in `PAYLOAD_LIMITS.maxDocumentBytes`.
    const oversized = JSON.stringify({ data: { blob: "x".repeat(1_048_577) } });
    expect(Buffer.byteLength(oversized, "utf8")).toBeGreaterThan(1_048_576);
    const bigRes = await jsonRequest(platform.app, documentPath, "POST", oversized);
    expect(bigRes.status).toBe(413);
    // AGENTS.md §4: MAX_DOCUMENT_BYTES maps to DOCUMENT_TOO_LARGE. The batch
    // ceiling (5 MiB) still reports PAYLOAD_TOO_LARGE.
    expect(((await bigRes.json()) as ErrorEnvelope).error.code).toBe("DOCUMENT_TOO_LARGE");
  });

  /* ---------------------------------------------------------------- *
   * 3. Query cost exhaustion
   * ---------------------------------------------------------------- */
  it("3. rejects 25 where clauses, 15 OR branches and include depth 5", async () => {
    const where = Array.from({ length: 25 }, (_, i) => ({ field: `f${i}`, op: "==", value: i }));
    const or = Array.from({ length: 15 }, (_, i) => ({ field: `f${i}`, op: "==", value: i }));
    const include = { depth: 5, totalDocs: 1, include: { depth: 5, totalDocs: 1 } };

    for (const query of [{ where }, { or }, { include }]) {
      const outcome = assertQueryCost(query);
      expect(outcome.ok).toBe(false);
      if (!outcome.ok) expect(outcome.code).toBe("QUERY_TOO_COMPLEX");
    }

    // Same shape through the real query route: the guard runs before the engine.
    const platform = createVellumPlatform({ jwtSecret: JWT_SECRET, apiKeyPepper: PEPPER });
    const res = await jsonRequest(
      platform.app,
      "/v1/projects/00000000-0000-4000-8000-000000000003/query",
      "POST",
      { collectionPath: "probe", where }
    );
    expect(res.status).toBe(400);
    expect(((await res.json()) as ErrorEnvelope).error.code).toBe("QUERY_TOO_COMPLEX");
  });

  /* ---------------------------------------------------------------- *
   * 4. SSRF
   * ---------------------------------------------------------------- */
  it("4. blocks loopback, RFC1918, link-local/metadata and IPv4-mapped loopback hosts", async () => {
    // Implementation note: `assertSafeExternalUrl` short-circuits *all* address
    // checks when `{allowHttpInTests:true}` is used under NODE_ENV=test (the
    // source is authoritative here, see contract §3). To make this test assert
    // IP ranges rather than the scheme, the targets use `https:` so the full
    // numeric-host/DNS checks run. Scheme-only rejection is asserted separately.
    const targets = [
      "https://127.0.0.1:8080/",
      "https://169.254.169.254/latest/meta-data/",
      "https://10.0.0.5/",
      "https://[::1]/",
      "https://[::ffff:127.0.0.1]/",
      "https://[::ffff:7f00:1]/",
    ];
    for (const url of targets) {
      await expect(assertSafeExternalUrl(url)).rejects.toMatchObject({
        code: "SSRF_BLOCKED",
      });
    }
    // HTTP is rejected without the test-only allowance (scheme guard).
    await expect(assertSafeExternalUrl("http://127.0.0.1:8080/")).rejects.toMatchObject({
      code: "SSRF_BLOCKED",
    });
  });

  /* ---------------------------------------------------------------- *
   * 5. API key origin restriction
   * ---------------------------------------------------------------- */
  it("5. returns 403 ORIGIN_NOT_ALLOWED for a restricted key used from a foreign origin", async () => {
    const control = new ControlPlaneStore();
    const org = control.createOrganization({
      name: "Fortress Restriction Org",
      slug: `fortress-restrict-${randomUUID().slice(0, 8)}`,
      billingEmail: "billing@fortress.test",
    });
    const created = control.createProject({
      organizationId: org.id,
      name: "Fortress Restriction Project",
      slug: `fortress-restrict-proj-${randomUUID().slice(0, 8)}`,
    });
    const generated = generateProjectApiKey({
      keyType: "public",
      pepper: PEPPER,
    });
    const key = control.registerApiKey({
      projectId: created.project.id,
      name: "Origin-restricted key",
      keyType: "public",
      keyPrefix: generated.keyPrefix,
      secretHash: generated.secretHash,
    });
    await control.security.updateApiKeyRestrictions(key.id, {
      allowedOrigins: ["https://allowed.app"],
    });

    const platform = createVellumPlatform({
      controlStore: control,
      jwtSecret: JWT_SECRET,
      apiKeyPepper: PEPPER,
    });
    const path = `/v1/projects/${created.project.id}/documents/probe/restricted`;

    const evil = await platform.app.request(path, {
      headers: { "x-project-key": generated.fullKey, origin: "https://evil.app" },
    });
    expect(evil.status).toBe(403);
    const evilBody = (await evil.json()) as ErrorEnvelope;
    expect(evilBody.error.code).toBe("PERMISSION_DENIED");
    expect(evilBody.error.message).toBe("ORIGIN_NOT_ALLOWED");

    const allowed = await platform.app.request(path, {
      headers: { "x-project-key": generated.fullKey, origin: "https://allowed.app" },
    });
    // The origin restriction middleware must not block this request. The
    // downstream document authorization is independent (with no ruleset the
    // engine can still deny the read), so assert on the *reason*, not the code:
    // a genuine origin block always carries the ORIGIN_NOT_ALLOWED message.
    const allowedBody = (await allowed.json()) as ErrorEnvelope;
    expect(allowedBody.error?.message ?? "").not.toBe("ORIGIN_NOT_ALLOWED");

    // Same-origin GET: browsers send no Origin, only Sec-Fetch-Site. The request's own origin counts, once.
    const blocked = async (init: { method?: string; headers: Record<string, string> }) => {
      const res = await platform.app.request(path, { method: "GET", ...init });
      const body = (await res.json()) as ErrorEnvelope;
      return body.error?.message === "ORIGIN_NOT_ALLOWED";
    };
    const k = { "x-project-key": generated.fullKey };
    expect(await blocked({ headers: { ...k, host: "allowed.app", "x-forwarded-proto": "https", "sec-fetch-site": "same-origin" } })).toBe(false);
    expect(await blocked({ headers: { ...k, host: "evil.app", "x-forwarded-proto": "https", "sec-fetch-site": "same-origin" } })).toBe(true);
    expect(await blocked({ headers: { ...k, host: "allowed.app", "x-forwarded-proto": "https" } })).toBe(true);
    expect(await blocked({ headers: { ...k, host: "allowed.app", "x-forwarded-proto": "https", "sec-fetch-site": "cross-site" } })).toBe(true);
    expect(await blocked({ headers: { ...k, host: "allowed.app", "x-forwarded-proto": "https", "sec-fetch-site": "same-origin" }, method: "POST" })).toBe(true);
    expect(await blocked({ headers: { ...k, host: "allowed.app", "sec-fetch-site": "same-origin" } })).toBe(true);
  });

  /* ---------------------------------------------------------------- *
   * 6. PostgreSQL immutability + hash chain
   * ---------------------------------------------------------------- */
  it.skipIf(
    (process.env.CONTROL_DATABASE_URL_DIRECT ?? process.env.CONTROL_DATABASE_URL ?? "") === ""
  )(
    "6. real PostgreSQL triggers reject UPDATE/DELETE and verifyHashChain detects a one-bit tamper",
    async () => {
      const controlUrl =
        process.env.CONTROL_DATABASE_URL_DIRECT ?? process.env.CONTROL_DATABASE_URL ?? "";
      expect(controlUrl).not.toBe("");

      const client: RawPgClient = createRawPgClient({
        connectionString: controlUrl,
        applicationName: "vellum-task5a-fortress-penetration",
      });
      await client.connect();
      try {
        // One explicit transaction pins a single physical connection (a
        // transaction pooler may otherwise hop between implicit transactions,
        // which would make the session-local TEMP table disappear).
        await client.query("BEGIN");
        // Uniquely-named TEMP table uses the SAME real trigger function that
        // protects the two append-only control-plane tables.
        const table = `fortress_immutable_${randomUUID().replace(/-/g, "")}`;
        await client.query(`CREATE TEMP TABLE ${table} (
          seq BIGSERIAL PRIMARY KEY,
          payload JSONB NOT NULL DEFAULT '{}'::jsonb,
          prev_hash TEXT NOT NULL DEFAULT repeat('0', 64),
          entry_hash TEXT NOT NULL,
          created_at TIMESTAMPTZ NOT NULL DEFAULT now()
        ) ON COMMIT DROP`);
        await client.query(
          `CREATE TRIGGER trg_fortress_temp_immutable BEFORE UPDATE OR DELETE ON ${table}
           FOR EACH ROW EXECUTE FUNCTION prevent_immutable_table_mutation()`
        );
        await client.query(`INSERT INTO ${table} (entry_hash) VALUES ($1)`, ["a".repeat(64)]);

        // Each rejected mutation aborts its savepoint; rolling back to it keeps
        // the outer transaction usable for the next assertion.
        await client.query("SAVEPOINT before_update");
        await expect(
          client.query(`UPDATE ${table} SET payload = '{"changed":true}'::jsonb WHERE seq = 1`)
        ).rejects.toThrow(/SECURITY_VIOLATION/);
        await client.query("ROLLBACK TO SAVEPOINT before_update");
        await client.query("RELEASE SAVEPOINT before_update");

        await client.query("SAVEPOINT before_delete");
        await expect(client.query(`DELETE FROM ${table} WHERE seq = 1`)).rejects.toThrow(
          /SECURITY_VIOLATION/
        );
        await client.query("ROLLBACK TO SAVEPOINT before_delete");
        await client.query("RELEASE SAVEPOINT before_delete");

        const triggerRows = await client.query<{ tgname: string }>(
          `SELECT tgname FROM pg_trigger
           WHERE tgrelid IN ('security_audit_logs'::regclass, 'billing_ledger_entries'::regclass)
             AND NOT tgisinternal`
        );
        const names = triggerRows.rows.map((row) => row.tgname);
        expect(names).toContain("trg_immutable_security_audit_logs");
        expect(names).toContain("trg_immutable_billing_ledger");

        // Genuine chain: every link validates, then flip one bit of row 2's
        // payload while keeping its stored hash — exact seq must be reported.
        const key = deriveChainKey("fortress-chain-master-key-v1", "security-audit-v1");
        const genesis = "0".repeat(64);
        const rows: ChainRow[] = [];
        let prevHash = genesis;
        for (let seq = 1; seq <= 4; seq += 1) {
          const timestampIso = `2026-11-19T00:00:0${seq}.000Z`;
          const payload = { action: `audit.event.${seq}`, outcome: "success" };
          const entryHash = computeChainHash(key, seq, prevHash, timestampIso, payload);
          rows.push({ seq, prevHash, entryHash, timestampIso, payload });
          prevHash = entryHash;
        }
        expect(verifyHashChain(key, rows)).toEqual({
          valid: true,
          totalChecked: 4,
          firstCorruptedSeq: null,
          reason: null,
        });

        const tampered: ChainRow[] = rows.map((row) =>
          row.seq === 2
            ? { ...row, payload: { action: "audit.event.2", outcome: "denied" } }
            : row
        );
        const result = verifyHashChain(key, tampered);
        expect(result.valid).toBe(false);
        expect(result.firstCorruptedSeq).toBe(2);
        expect(result.totalChecked).toBe(1);
      } finally {
        await client.query("ROLLBACK").catch(() => undefined);
        await client.end();
      }
    },
    60_000
  );

  /* ---------------------------------------------------------------- *
   * 7. Cross-realm isolation on every super-admin fortress endpoint
   * ---------------------------------------------------------------- */
  it("7. a customer console token gets 403 (not 401) on every /v1/admin/security/* and /v1/admin/billing/* endpoint", async () => {
    const platform = createVellumPlatform({
      jwtSecret: JWT_SECRET,
      apiKeyPepper: PEPPER,
      consoleJwtSecret: "fortress-console-realm-secret-32-chars",
      superAdminJwtSecret: "fortress-superadmin-realm-secret-32-chars",
    });
    const org = platform.controlStore.createOrganization({
      name: "Fortress Customer Org",
      slug: `fortress-customer-${randomUUID().slice(0, 8)}`,
      billingEmail: "billing@fortress.test",
    });

    // Realm-bound console session, minted exactly as the customer dashboard's
    // session service would mint it.
    const consoleSession = createRealmSessionService({
      realm: "customer_console",
      secret: "fortress-console-realm-secret-32-chars",
      revocationStore: createInMemoryRevocationStore(),
    });
    const token = consoleSession.signAccess({
      sub: "usr_fortress_customer",
      uid: "usr_fortress_customer",
      role: "customer",
      orgIds: [org.id],
    });
    const headers = {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    };

    // Contract §6.2 — every super-admin endpoint, with representative ids.
    const endpoints: ReadonlyArray<{ method: "GET" | "POST" | "PATCH" | "DELETE"; path: string }> = [
      { method: "GET", path: "/v1/admin/security/overview" },
      { method: "GET", path: "/v1/admin/security/threats" },
      { method: "PATCH", path: "/v1/admin/security/threats/thr_00000000-0000-4000-8000-000000000001" },
      { method: "GET", path: "/v1/admin/security/blocklist" },
      { method: "POST", path: "/v1/admin/security/blocklist" },
      { method: "DELETE", path: "/v1/admin/security/blocklist/blk_00000000-0000-4000-8000-000000000001" },
      { method: "GET", path: "/v1/admin/security/audit-logs" },
      { method: "POST", path: "/v1/admin/security/audit-logs/verify-chain" },
      { method: "GET", path: "/v1/admin/billing/overview" },
      { method: "GET", path: "/v1/admin/billing/orgs" },
      { method: "PATCH", path: `/v1/admin/billing/orgs/${org.id}/override` },
      { method: "POST", path: "/v1/admin/billing/invoices/generate" },
      { method: "POST", path: "/v1/admin/billing/ledger/verify-chain" },
    ];

    for (const endpoint of endpoints) {
      const res = await platform.app.request(endpoint.path, {
        method: endpoint.method,
        headers,
        ...(endpoint.method === "GET" || endpoint.method === "DELETE"
          ? {}
          : { body: "{}" }),
      });
      expect(res.status, `${endpoint.method} ${endpoint.path}`).toBe(403);
      const body = (await res.json()) as ErrorEnvelope;
      expect(body.error.code, `${endpoint.method} ${endpoint.path}`).toBe("PERMISSION_DENIED");
    }
  });
});
