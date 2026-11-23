import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ControlPlaneStore } from "../memory-store.js";
import {
  controlPlaneRefreshSessions,
  platformAuthGlobalSettings,
  projectAuthConfigs,
} from "../schema.js";

const testDir = path.dirname(fileURLToPath(import.meta.url));
const migration = fs.readFileSync(
  path.resolve(testDir, "../../migrations/0004_control_auth_configs.sql"),
  "utf8"
);
const isolationMigration = fs.readFileSync(
  path.resolve(testDir, "../../migrations/0005_three_realm_auth_isolation.sql"),
  "utf8"
);
const migrationDir = path.resolve(testDir, "../../migrations");
const cutoverFile = fs.readdirSync(migrationDir).find((name) => name.startsWith("0011_"));
if (!cutoverFile) throw new Error("Missing the 0011 cutover migration");
const cutoverMigration = fs.readFileSync(path.join(migrationDir, cutoverFile), "utf8");

describe("database-control / end-user auth config", () => {
  it("exports both Drizzle auth tables", () => {
    expect(projectAuthConfigs).toBeDefined();
    expect(platformAuthGlobalSettings).toBeDefined();
  });

  it("exports the control-plane refresh-session Drizzle table", () => {
    expect(controlPlaneRefreshSessions).toBeDefined();
  });

  it("creates the three-realm isolation schema idempotently in the migration", () => {
    expect(isolationMigration).toContain(
      "ALTER TABLE users ADD COLUMN IF NOT EXISTS is_platform_super_admin"
    );
    // Migration 0005 is a checksum-protected historical migration and keeps the
    // pre-rebrand seed email; migration 0013_vellum_rebrand.sql renames the row
    // to visual-admin@vellum.dev for existing deployments.
    expect(isolationMigration).toContain("visual-admin@docdb.dev");
    expect(isolationMigration).toContain("platform_role IN ('owner', 'admin')");
    expect(isolationMigration).toContain(
      "CREATE TABLE IF NOT EXISTS control_plane_refresh_sessions"
    );
    expect(isolationMigration).toContain("realm IN ('customer_console', 'super_admin')");
    expect(isolationMigration).toContain("idx_cp_sessions_user_realm");
    expect(isolationMigration).toContain("idx_cp_sessions_refresh");
    expect(isolationMigration).toContain("idx_cp_sessions_prev_refresh");
  });

  it("creates the control-plane tables and seed row in the migration", () => {
    expect(migration).toContain("CREATE TABLE IF NOT EXISTS platform_auth_global_settings");
    expect(migration).toContain("CHECK (id = 1)");
    expect(migration).toContain("ON CONFLICT DO NOTHING");
    expect(migration).toContain("jwt_private_key_encrypted");
  });

  it("renames the auth-config table to a project-only name in the cutover", () => {
    expect(cutoverMigration).toContain("RENAME TO project_auth_configs");
    expect(cutoverMigration).toContain("UNIQUE (project_id)");
    expect(cutoverMigration).toContain("DROP TABLE IF EXISTS");
  });

  it("upserts and reads an auth config with defaults", () => {
    const store = new ControlPlaneStore();
    const projectId = "11111111-1111-4111-8111-111111111111";
    expect(store.getAuthConfig(projectId)).toBeNull();

    const created = store.upsertAuthConfig({
      projectId,
      jwtKeyId: "kid_test",
      jwtPublicKeyPem: "-----BEGIN PUBLIC KEY-----",
      jwtPrivateKeyEncrypted: "v1:iv:tag:ct",
    });
    expect(created.maxUsersQuota).toBe(50000);
    expect(created.maxSignupsPerHour).toBe(1000);
    expect(created.enableEmailPassword).toBe(true);
    expect(created.enableUserProjection).toBe(true);
    expect(created.projectionCollectionPath).toBe("users");
    expect(created.enableTotpMfa).toBe(true);
    expect(created.authServiceSuspended).toBe(false);

    expect(store.getAuthConfig(projectId)?.id).toBe(created.id);
    expect(store.listAuthConfigs()).toHaveLength(1);
  });

  it("updates only supplied auth config fields", () => {
    const store = new ControlPlaneStore();
    const input = {
      projectId: "33333333-3333-4333-8333-333333333333",
      jwtKeyId: "kid_a",
      jwtPublicKeyPem: "pub-a",
      jwtPrivateKeyEncrypted: "enc-a",
    };
    const first = store.upsertAuthConfig(input);
    const second = store.upsertAuthConfig({
      ...input,
      jwtKeyId: "kid_b",
      jwtPublicKeyPem: "pub-b",
      jwtPrivateKeyEncrypted: "enc-b",
      authServiceSuspended: true,
      suspensionReason: "abuse",
      maxUsersQuota: 10,
    });
    expect(second.id).toBe(first.id);
    expect(second.jwtKeyId).toBe("kid_b");
    expect(second.authServiceSuspended).toBe(true);
    expect(second.suspensionReason).toBe("abuse");
    expect(second.maxUsersQuota).toBe(10);
    expect(second.enableEmailPassword).toBe(true);
  });

  it("updates platform auth global settings", () => {
    const store = new ControlPlaneStore();
    expect(store.getPlatformAuthSettings().id).toBe(1);
    const updated = store.updatePlatformAuthSettings({
      globalSignupsEnabled: false,
      defaultMaxUsersPerProProject: 5,
    });
    expect(updated.globalSignupsEnabled).toBe(false);
    expect(updated.defaultMaxUsersPerProProject).toBe(5);
    expect(store.getPlatformAuthSettings()).toEqual(updated);
  });

  describe("control-plane refresh sessions (memory store)", () => {
    const expiresAt = new Date(Date.now() + 60_000).toISOString();

    function seed() {
      const store = new ControlPlaneStore();
      const user = store.createUser({ email: "operator@example.com", name: "Operator" });
      return { store, user };
    }

    it("creates, rotates, and looks up a session by current and previous hash", async () => {
      const { store, user } = seed();
      const session = await store.createControlRefreshSession({
        userId: user.id,
        realm: "customer_console",
        accessTokenHash: "access_hash_1",
        refreshTokenHash: "refresh_hash_1",
        ipAddress: "127.0.0.1",
        userAgent: "unit-test",
        accessExpiresAt: expiresAt,
        refreshExpiresAt: expiresAt,
      });
      expect(session.rotationCounter).toBe(0);
      expect(session.rotatedAt).toBeNull();
      expect(session.revoked).toBe(false);
      expect((await store.getControlRefreshSessionByHash("refresh_hash_1"))?.id).toBe(session.id);
      expect((await store.getControlRefreshSessionByHash("access_hash_1"))?.id).toBe(session.id);

      const rotated = await store.rotateControlRefreshSession(
        session.id,
        "refresh_hash_1",
        "access_hash_2",
        "refresh_hash_2",
        expiresAt,
        expiresAt
      );
      expect(rotated.rotationCounter).toBe(1);
      expect(rotated.previousRefreshTokenHash).toBe("refresh_hash_1");
      expect(typeof rotated.rotatedAt).toBe("string");
      expect((await store.getControlRefreshSessionByHash("refresh_hash_2"))?.id).toBe(session.id);
      expect((await store.getControlRefreshSessionByPreviousHash("refresh_hash_1"))?.id).toBe(
        session.id
      );

      // A stale hash must fail rotation (the memory store throws synchronously).
      let rotationError: unknown;
      try {
        store.rotateControlRefreshSession(
          session.id,
          "refresh_hash_1",
          "access_hash_3",
          "refresh_hash_3",
          expiresAt,
          expiresAt
        );
      } catch (err) {
        rotationError = err;
      }
      expect(rotationError).toMatchObject({ code: "UNAUTHENTICATED" });
    });

    it("keeps realms isolated when revoking by realm", async () => {
      const { store, user } = seed();
      const consoleSession = await store.createControlRefreshSession({
        userId: user.id,
        realm: "customer_console",
        accessTokenHash: "console_access",
        refreshTokenHash: "console_refresh",
        accessExpiresAt: expiresAt,
        refreshExpiresAt: expiresAt,
      });
      const adminSession = await store.createControlRefreshSession({
        userId: user.id,
        realm: "super_admin",
        accessTokenHash: "admin_access",
        refreshTokenHash: "admin_refresh",
        accessExpiresAt: expiresAt,
        refreshExpiresAt: expiresAt,
      });

      // A super-admin session is only returned by its own hash, never by a
      // cross-realm query, and a console-only revoke leaves it intact.
      expect((await store.getControlRefreshSessionByHash("admin_refresh"))?.id).toBe(
        adminSession.id
      );
      expect((await store.getControlRefreshSessionByHash("console_refresh"))?.id).toBe(
        consoleSession.id
      );
      expect((await store.getControlRefreshSessionByHash("admin_refresh"))?.realm).toBe(
        "super_admin"
      );

      expect(
        await store.revokeControlRefreshSessionsForUser(user.id, "logout", "customer_console")
      ).toBe(1);
      expect((await store.getControlRefreshSessionByHash("console_refresh"))?.revoked).toBe(true);
      expect((await store.getControlRefreshSessionByHash("admin_refresh"))?.revoked).toBe(false);
      expect(await store.listControlRefreshSessions()).toHaveLength(2);
    });

    it("never grants platform super-admin on signup; only the explicit setter does", async () => {
      const { store, user } = seed();
      expect(user.isPlatformSuperAdmin).toBe(false);
      expect(store.isPlatformSuperAdmin(user.id)).toBe(false);

      await store.setPlatformSuperAdmin(user.id, true);
      expect(store.isPlatformSuperAdmin(user.id)).toBe(true);
      expect(store.users.get(user.id)?.isPlatformSuperAdmin).toBe(true);

      await store.setPlatformSuperAdmin(user.id, false);
      expect(store.isPlatformSuperAdmin(user.id)).toBe(false);
    });
  });
});
