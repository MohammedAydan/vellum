import { describe, expect, it, vi } from "vitest";
import {
  INIT_DATA_PLANE_SQL,
  RLS_GUC_PROJECT_ID,
  RLS_TENANT_TABLES,
  RlsValidationError,
  applyTenantContext,
  assertValidProjectId,
  assertValidUserId,
  buildTenantContextQuery,
  ensureRlsPolicies,
  isValidUuid,
  resetTenantContext,
  sanitizeClaims,
  sanitizeRoleName,
  withTenantContext,
} from "../rls.js";

const VALID_PROJECT_ID = "123e4567-e89b-12d3-a456-426614174000";

describe("@vellum/database-data / RLS security & tenant isolation", () => {
  it("validates canonical UUIDs and rejects SQLi payloads, whitespace, and nil UUID", () => {
    expect(isValidUuid(VALID_PROJECT_ID)).toBe(true);
    expect(assertValidProjectId(VALID_PROJECT_ID.toUpperCase())).toBe(VALID_PROJECT_ID);

    const maliciousInputs = [
      "",
      "not-a-uuid",
      "00000000-0000-0000-0000-000000000000",
      `${VALID_PROJECT_ID}'; DROP TABLE documents; --`,
      ` ${VALID_PROJECT_ID}`,
      `${VALID_PROJECT_ID}\n`,
      `${VALID_PROJECT_ID}\u0000`,
      null,
      undefined,
      12345,
    ];

    for (const input of maliciousInputs) {
      expect(() => assertValidProjectId(input)).toThrow(RlsValidationError);
    }
  });

  it("sanitizes PostgreSQL role identifiers and blocks privileged roles", () => {
    expect(sanitizeRoleName("vellum_app")).toBe("vellum_app");
    expect(sanitizeRoleName("vellum_app", ["vellum_app"])).toBe("vellum_app");

    for (const badRole of [
      "postgres",
      "pg_read_all_data",
      "neon_superuser",
      "rdsadmin",
      "vellum_app; DROP TABLE documents",
      "Vellum_App",
      "123invalid",
      "",
    ]) {
      expect(() => sanitizeRoleName(badRole)).toThrow(RlsValidationError);
    }

    expect(() => sanitizeRoleName("vellum_reader", ["vellum_app"])).toThrow(RlsValidationError);
  });

  it("sanitizes claims against prototype pollution, control chars, depth, and byte bloat", () => {
    const clean = sanitizeClaims({ role: "editor", tier: 2, active: true, tags: ["a", "b"] });
    expect(clean).toEqual({ role: "editor", tier: 2, active: true, tags: ["a", "b"] });

    // Prototype pollution key via JSON.parse
    const polluted = JSON.parse('{"__proto__":{"admin":true}}');
    expect(() => sanitizeClaims(polluted)).toThrow(RlsValidationError);
    expect(() => sanitizeClaims({ constructor: "bad" })).toThrow(RlsValidationError);
    expect(() => sanitizeClaims({ note: "bad\u0000value" })).toThrow(RlsValidationError);
    expect(() => sanitizeClaims({ a: { b: { c: { d: 1 } } } }, { maxDepth: 2 })).toThrow(
      RlsValidationError
    );
    expect(() => sanitizeClaims({ big: "x".repeat(5000) }, { maxBytes: 1024 })).toThrow(
      RlsValidationError
    );
  });

  it("batches all transaction-local GUCs into a single parameterized set_config(..., true) statement", () => {
    const q = buildTenantContextQuery({
      projectId: VALID_PROJECT_ID,
      userId: "user_123",
      appRole: "member",
      dbRole: "vellum_app",
      allowedDbRoles: ["vellum_app"],
      claims: { org: "acme" },
      statementTimeoutMs: 4000,
      lockTimeoutMs: 1500,
      idleInTransactionTimeoutMs: 10000,
    });

    // Single SELECT statement, zero raw interpolation, every set_config uses is_local = true
    expect(q.text.startsWith("SELECT ")).toBe(true);
    expect(q.text).not.toContain(VALID_PROJECT_ID);
    expect(q.text).not.toContain("user_123");
    expect(q.text).not.toContain("vellum_app");
    expect(q.text).not.toContain("false");
    expect(q.text).toContain(`set_config('${RLS_GUC_PROJECT_ID}', $1, true)`);
    expect(q.text).toContain("set_config('statement_timeout', $2, true)");
    expect(q.text).toContain("set_config('lock_timeout', $3, true)");
    expect(q.text).toContain("set_config('idle_in_transaction_session_timeout', $4, true)");
    expect(q.text).toContain("set_config('role', $8, true)");
    expect(q.values).toEqual([
      VALID_PROJECT_ID,
      "4000ms",
      "1500ms",
      "10000ms",
      "user_123",
      "member",
      '{"org":"acme"}',
      "vellum_app",
    ]);
  });

  it("rejects disabling timeouts (0ms) or invalid timeout bounds", () => {
    expect(() =>
      buildTenantContextQuery({ projectId: VALID_PROJECT_ID, statementTimeoutMs: 0 })
    ).toThrow(RlsValidationError);
    expect(() =>
      buildTenantContextQuery({ projectId: VALID_PROJECT_ID, lockTimeoutMs: -10 })
    ).toThrow(RlsValidationError);
    expect(() =>
      buildTenantContextQuery({ projectId: VALID_PROJECT_ID, statementTimeoutMs: 999_999 })
    ).toThrow(RlsValidationError);
  });

  it("validates inputs fail-fast before acquiring a pooled connection", async () => {
    const connect = vi.fn();
    await expect(
      withTenantContext({ connect }, { projectId: "bad-id" }, async () => "never")
    ).rejects.toThrow(RlsValidationError);
    expect(connect).not.toHaveBeenCalled();
  });

  it("executes BEGIN -> single set_config -> work -> COMMIT and releases pooled client", async () => {
    const queries: Array<{ sql: string; params?: unknown[] }> = [];
    const release = vi.fn();
    const client = {
      query: vi.fn(async (sql: string, params?: unknown[]) => {
        queries.push(params === undefined ? { sql } : { sql, params });
        return { rows: [] };
      }),
      release,
    };
    const pool = { connect: vi.fn(async () => client) };

    const out = await withTenantContext(
      pool,
      { projectId: VALID_PROJECT_ID, isolationLevel: "REPEATABLE READ", readOnly: true },
      async (tx) => {
        await tx.query("SELECT * FROM documents");
        return 42;
      }
    );

    expect(out).toBe(42);
    expect(queries.map((q) => q.sql)).toEqual([
      "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY",
      expect.stringContaining("set_config('app.current_project_id', $1, true)"),
      "SELECT * FROM documents",
      "COMMIT",
    ]);
    expect(release).toHaveBeenCalledTimes(1);
    expect(release).toHaveBeenCalledWith();
  });

  it("rolls back on error and destroys pooled client if ROLLBACK itself fails", async () => {
    const release = vi.fn();
    const client = {
      query: vi.fn(async (sql: string) => {
        if (sql === "ROLLBACK") throw new Error("socket closed");
        return { rows: [] };
      }),
      release,
    };
    const pool = { connect: vi.fn(async () => client) };

    await expect(
      withTenantContext(pool, { projectId: VALID_PROJECT_ID }, async () => {
        throw new Error("boom");
      })
    ).rejects.toThrow("boom");

    expect(release).toHaveBeenCalledTimes(1);
    expect(release.mock.calls[0]?.[0]).toBeInstanceOf(Error);
  });

  it("applies and resets tenant context cleanly and covers all 12 tenant tables in INIT_DATA_PLANE_SQL", async () => {
    const query = vi.fn(async () => ({}));
    await applyTenantContext({ query }, { projectId: VALID_PROJECT_ID });
    await resetTenantContext({ query });
    await ensureRlsPolicies({ query });

    expect(query).toHaveBeenCalledTimes(3);
    expect(assertValidUserId("usr_abc-123")).toBe("usr_abc-123");
    expect(() => assertValidUserId("bad user; --")).toThrow(RlsValidationError);

    for (const table of RLS_TENANT_TABLES) {
      expect(INIT_DATA_PLANE_SQL).toContain(table);
    }
    expect(INIT_DATA_PLANE_SQL).not.toContain("environment");
  });
});
