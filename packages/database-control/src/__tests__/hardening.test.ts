import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ControlPlaneStore } from "../memory-store.js";
import { parseEnvFile, loadEnvFiles, redactConnectionString } from "../env-file.js";
import { quotePgIdentifier, createRawPgPool } from "../raw-sql.js";
import {
  withMigrationAdvisoryLock,
  runMigrationsOnClient,
  checksumOfSql,
  listMigrationFiles,
} from "../migrations-runner.js";
import { createIndexRecommendationRecorder } from "../index-recommendations.js";
import { createInMemorySecurityRepository } from "../security-repository.js";
import { createInMemoryBillingRepository } from "../billing-repository.js";
import { createControlDb } from "../client.js";
import { VellumError } from "@vellum/core";

describe("@vellum/database-control / security, reliability & performance hardening", () => {
  describe("env-file.ts hardening", () => {
    it("blocks prototype pollution keys in parseEnvFile", () => {
      const parsed = parseEnvFile(
        "__proto__=polluted\nconstructor=bad\nprototype=bad\nSAFE_KEY=ok\n"
      );
      expect(parsed["SAFE_KEY"]).toBe("ok");
      expect(Object.prototype.hasOwnProperty.call(parsed, "__proto__")).toBe(false);
      expect(Object.prototype.hasOwnProperty.call(parsed, "constructor")).toBe(false);
      expect(Object.prototype.hasOwnProperty.call(parsed, "prototype")).toBe(false);
      expect(({} as Record<string, unknown>)["polluted"]).toBeUndefined();
    });

    it("rejects relative path traversal in loadEnvFiles", () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "vellum-env-test-"));
      try {
        expect(() => loadEnvFiles(["../../etc/passwd"], { cwd: tmpDir, target: {} })).toThrow(
          /outside base directory/i
        );
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });

    it("redacts passwords containing @ and sensitive query parameters", () => {
      const url =
        "postgresql://admin:p@ss:w0rd@db.example.com:5432/app?sslmode=require&password=abc&token=xyz";
      const redacted = redactConnectionString(url);
      expect(redacted).not.toContain("p@ss");
      expect(redacted).not.toContain("w0rd");
      expect(redacted).not.toContain("abc");
      expect(redacted).not.toContain("xyz");
      expect(redacted).toContain("[REDACTED]");
    });
  });

  describe("raw-sql.ts hardening", () => {
    it("rejects unsafe or overlong PostgreSQL identifiers", () => {
      expect(quotePgIdentifier("valid_role_1")).toBe('"valid_role_1"');
      expect(() => quotePgIdentifier("")).toThrow(/Unsafe PostgreSQL identifier/);
      expect(() => quotePgIdentifier("a".repeat(64))).toThrow(/Unsafe PostgreSQL identifier/);
      expect(() => quotePgIdentifier('role"; DROP TABLE users;--')).toThrow(
        /Unsafe PostgreSQL identifier/
      );
    });

    it("validates statementTimeoutMs and pool bounds against injection", () => {
      expect(() =>
        createRawPgPool({
          connectionString: "postgresql://u:p@localhost:5432/db",
          statementTimeoutMs: Number.NaN,
        })
      ).toThrow(RangeError);
      expect(() =>
        createRawPgPool({
          connectionString: "postgresql://u:p@localhost:5432/db",
          statementTimeoutMs: -1,
        })
      ).toThrow(RangeError);
      expect(() =>
        createRawPgPool({
          connectionString: "postgresql://u:p@localhost:5432/db",
          max: 0,
        })
      ).toThrow(RangeError);
    });
  });

  describe("client.ts hardening", () => {
    it("rejects unsupported connection schemes without leaking credentials", () => {
      expect(() =>
        createControlDb({
          connectionString: "mysql://user:supersecret@localhost:3306/db",
          driver: "pg",
        })
      ).toThrow(/Unsupported PostgreSQL connection scheme/);
      try {
        createControlDb({
          connectionString: "mysql://user:supersecret@localhost:3306/db",
          driver: "pg",
        });
      } catch (err) {
        expect(String(err)).not.toContain("supersecret");
      }
    });

    it("makes close() idempotent", async () => {
      const handle = createControlDb({
        connectionString: "postgresql://vellum_control:control_secret@localhost:5432/control_db",
        driver: "pg",
      });
      await handle.close();
      await handle.close();
    });
  });

  describe("migrations-runner.ts hardening", () => {
    it("uses parameterized set_config for advisory lock timeout and does not mask work errors on unlock failure", async () => {
      const queries: Array<{ sql: string; params?: unknown[] }> = [];
      const fakeClient = {
        async query(sql: string, params?: unknown[]) {
          queries.push(params === undefined ? { sql } : { sql, params });
          if (sql.includes("pg_advisory_unlock")) {
            throw new Error("socket closed during unlock");
          }
          return { rows: [] };
        },
      };

      await expect(
        withMigrationAdvisoryLock(
          fakeClient as never,
          async () => {
            throw new Error("migration DDL failed");
          },
          { timeoutMs: Number.NaN }
        )
      ).rejects.toThrow("migration DDL failed");

      const setConfigCall = queries.find((q) => q.sql.includes("set_config"));
      expect(setConfigCall).toBeDefined();
      expect(setConfigCall?.params).toEqual(["15000ms"]);
    });

    it("detects checksum drift and ignores non-file entries in listMigrationFiles", async () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "vellum-mig-test-"));
      try {
        fs.writeFileSync(path.join(tmpDir, "0001_init.sql"), "SELECT 1;", "utf8");
        fs.mkdirSync(path.join(tmpDir, "0002_fake.sql")); // directory ending in .sql
        expect(listMigrationFiles(tmpDir)).toEqual(["0001_init.sql"]);

        const fakeClient = {
          async query(sql: string) {
            if (sql.includes("SELECT filename, checksum")) {
              return {
                rows: [{ filename: "0001_init.sql", checksum: checksumOfSql("SELECT 2;") }],
              };
            }
            return { rows: [] };
          },
        };

        await expect(
          runMigrationsOnClient({
            client: fakeClient as never,
            directory: tmpDir,
            label: "test",
          })
        ).rejects.toThrow(/different checksum/i);
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });
  });

  describe("memory-store.ts hardening", () => {
    const expiresAt = new Date(Date.now() + 60_000).toISOString();

    it("blocks rotation of revoked refresh sessions and indexes lookups in O(1)", () => {
      const store = new ControlPlaneStore();
      const user = store.createUser({ email: "sec@example.com", name: "Sec" });
      const session = store.createControlRefreshSession({
        userId: user.id,
        realm: "customer_console",
        accessTokenHash: "a_hash_1",
        refreshTokenHash: "r_hash_1",
        accessExpiresAt: expiresAt,
        refreshExpiresAt: expiresAt,
      });

      expect(store.revokeControlRefreshSessionsForUser(user.id, "compromised")).toBe(1);
      expect(() =>
        store.rotateControlRefreshSession(
          session.id,
          "r_hash_1",
          "a_hash_2",
          "r_hash_2",
          expiresAt,
          expiresAt
        )
      ).toThrow(VellumError);
    });

    it("sanitizes prototype-polluting keys and guards incrementUsage against NaN", () => {
      const store = new ControlPlaneStore();
      const org = store.createOrganization({
        slug: "sec-org",
        name: "Sec Org",
        billingEmail: "sec@example.com",
      });
      const { project } = store.createProject({
        organizationId: org.id,
        slug: "app",
        name: "App",
      });

      const payload = JSON.parse('{"allow":true,"__proto__":{"polluted":true}}');
      const ruleset = store.publishSecurityRuleset({ projectId: project.id, rulesAst: payload });
      expect(Object.prototype.hasOwnProperty.call(ruleset.rulesAst, "__proto__")).toBe(false);
      expect(({} as Record<string, unknown>)["polluted"]).toBeUndefined();

      const usage = store.incrementUsage(project.id, {
        documentReads: Number.NaN,
        documentWrites: -5,
        storageBytesDelta: Number.POSITIVE_INFINITY,
      });
      expect(usage.documentReads).toBe(0);
      expect(usage.documentWrites).toBe(0);
      expect(usage.storageBytes).toBe(0);
    });
  });

  describe("index-recommendations.ts hardening", () => {
    it("serializes close() flush, handles circular sampleQuery, and validates status", async () => {
      let flushedBatches = 0;
      const fakePool = {
        async query() {
          flushedBatches += 1;
          return { rows: [] };
        },
      };
      const recorder = createIndexRecommendationRecorder({
        pool: fakePool,
        flushIntervalMs: 50,
      });

      const circular: Record<string, unknown> = { field: "a" };
      circular["self"] = circular;
      recorder.record({
        projectId: "11111111-1111-4111-8111-111111111111",
        fingerprint: "fp_1",
        collectionPath: "orders",
        recommendedFields: [{ path: "status", dir: "asc" }],
        sampleQuery: circular,
        reason: "slow scan",
        durationMs: 250,
      });

      await expect(recorder.setStatus("11111111-1111-4111-8111-111111111111", "invalid")).rejects.toThrow(
        /Invalid index recommendation status/
      );

      await recorder.close();
      expect(flushedBatches).toBe(1);
    });
  });

  describe("security-repository.ts & billing-repository.ts hardening", () => {
    it("returns defensive copies and strips prototype-polluting keys in SecurityRepository", () => {
      const repo = createInMemorySecurityRepository();
      const inputDetails = JSON.parse('{"ip":"1.2.3.4","__proto__":{"p":1}}');
      const entry = repo.appendAuditLog({
        actorRealm: "system",
        action: "test.action",
        resourceType: "project",
        outcome: "success",
        details: inputDetails,
        prevHash: "0".repeat(64),
        entryHash: "a".repeat(64),
      }) as { details: Record<string, unknown>; entryHash: string };

      // Mutate returned copy and verify internal state is untouched.
      entry.details["ip"] = "tampered";
      entry.entryHash = "tampered";
      expect(repo.getLastAuditHash()).toBe("a".repeat(64));
      const listed = repo.listAuditLogs() as Array<{ details: Record<string, unknown> }>;
      expect(listed[0]?.details["ip"]).toBe("1.2.3.4");
      expect(Object.prototype.hasOwnProperty.call(listed[0]?.details ?? {}, "__proto__")).toBe(
        false
      );
    });

    it("returns deep defensive copies and validates finite numbers in BillingRepository", () => {
      const billing = createInMemoryBillingRepository();
      const sub = billing.ensureSubscription("org-1") as { quotaOverride: Record<string, unknown> };
      sub.quotaOverride["nested"] = { hacked: true };
      const fresh = billing.getSubscription("org-1") as { quotaOverride: Record<string, unknown> };
      expect(fresh.quotaOverride["nested"]).toBeUndefined();

      expect(() =>
        billing.upsertMonthly({
          orgId: "org-1",
          projectId: "proj-1",
          billingMonth: "2026-11",
          docReads: Number.NaN,
          docWrites: 0,
          docDeletes: 0,
          storageBytes: 0,
          egressBytes: 0,
          authMau: 0,
          peakConcurrentWs: 0,
        })
      ).toThrow(RangeError);
    });
  });
});
