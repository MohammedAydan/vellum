import { describe, expect, it } from "vitest";
import { asObject, iso, isoOrNull, mapAuthConfigRow, mapControlRefreshSession, mapPlatformAuthSettings } from "../pg-row-mappers.js";

describe("PostgreSQL control row mappers", () => {
  it("preserves date strings and normalizes Date/null inputs", () => {
    const date = new Date("2026-01-02T03:04:05.000Z");
    expect(iso(date)).toBe("2026-01-02T03:04:05.000Z");
    expect(iso("stored timestamp")).toBe("stored timestamp");
    expect(iso(undefined)).toBe("1970-01-01T00:00:00.000Z");
    expect(isoOrNull(null)).toBeNull();
    expect(isoOrNull(undefined)).toBeNull();
    expect(isoOrNull(date)).toBe(date.toISOString());
  });
  it("clones JSON object rows and removes prototype gadget keys recursively", () => {
    const source: unknown = JSON.parse('{"ok":{"constructor":"blocked","value":2},"items":[{"__proto__":{"bad":true},"safe":3}],"prototype":"blocked"}');
    expect(asObject(source)).toEqual({ ok: { value: 2 }, items: [{ safe: 3 }] });
    expect(asObject([])).toEqual({});
    expect(asObject(null)).toEqual({});
    expect(asObject({ at: new Date("2026-01-01T00:00:00Z") })).toEqual({ at: "2026-01-01T00:00:00.000Z" });
  });
  it("normalizes refresh session fields without dropping rotation metadata", () => {
    const row = {
      id: "session", userId: "user", realm: "super_admin", accessTokenHash: "test-access-hash",
      refreshTokenHash: "test-refresh-hash", previousRefreshTokenHash: "test-previous-hash",
      rotatedAt: new Date("2026-01-01T00:00:00Z"), rotationCounter: "4", ipAddress: null,
      userAgent: "test-agent", revoked: false, revokedReason: null,
      accessExpiresAt: "access-expiry", refreshExpiresAt: "refresh-expiry", createdAt: "created", lastUsedAt: "used",
    };
    const mapped = mapControlRefreshSession(row);
    expect(mapped).toMatchObject({ realm: "super_admin", rotationCounter: 4, previousRefreshTokenHash: "test-previous-hash", rotatedAt: "2026-01-01T00:00:00.000Z", ipAddress: null, revoked: false });
    expect(mapControlRefreshSession({ ...row, realm: "customer_console", rotatedAt: null, previousRefreshTokenHash: null })).toMatchObject({ realm: "customer_console", rotatedAt: null, previousRefreshTokenHash: null });
  });
  it("maps auth config quotas, flags and nullable encrypted settings", () => {
    const row = {
      id: "config", projectId: "project", maxUsersQuota: "100", maxSignupsPerHour: "25",
      passwordMinLength: "12", accessTokenTtlSeconds: "900", refreshTokenTtlDays: "30",
      enableEmailPassword: true, enableAnonymousAuth: false, enableTotpMfa: true,
      oauthProviders: { github: { enabled: true } }, customSmtpConfigEncrypted: null,
      createdAt: new Date("2026-01-01T00:00:00Z"), updatedAt: "updated",
    };
    expect(mapAuthConfigRow(row)).toMatchObject({ projectId: "project", maxUsersQuota: 100, maxSignupsPerHour: 25, passwordMinLength: 12, accessTokenTtlSeconds: 900, refreshTokenTtlDays: 30, enableEmailPassword: true, enableAnonymousAuth: false, enableTotpMfa: true, customSmtpConfigEncrypted: null, oauthProviders: { github: { enabled: true } } });
  });
  it("keeps optional SMTP port and encrypted settings nullable", () => {
    const row = { id: "1", globalSignupsEnabled: true, defaultMaxUsersPerFreeProject: "50", defaultMaxUsersPerProProject: "500", platformSmtpPort: null, platformSmtpHost: null, platformSmtpUser: null, platformSmtpPassEncrypted: null, platformSmtpFromEmail: "noreply@example.invalid", updatedAt: "updated" };
    expect(mapPlatformAuthSettings(row)).toMatchObject({ id: 1, defaultMaxUsersPerFreeProject: 50, defaultMaxUsersPerProProject: 500, platformSmtpPort: null, platformSmtpHost: null, platformSmtpPassEncrypted: null });
    expect(mapPlatformAuthSettings({ ...row, platformSmtpPort: "587" }).platformSmtpPort).toBe(587);
  });
});
