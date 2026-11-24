import { describe, expect, it, vi } from "vitest";
import { generateProjectApiKey, verifyApiKeyAsync } from "../index.js";
import type { ApiKeyRecord } from "@vellum/database-control";

function record(over: Partial<ApiKeyRecord> = {}): { fullKey: string; rec: ApiKeyRecord } {
  const g = generateProjectApiKey({ keyType: "public" });
  const rec = {
    id: "k1", projectId: "p1", name: "n", keyType: "public", keyPrefix: g.keyPrefix, secretHash: g.secretHash,
    scopes: [], allowedOrigins: [], allowedIps: [], rateLimitRps: 10, lastUsedAt: null, expiresAt: null,
    revokedAt: null, createdBy: null, createdAt: "2026-01-01T00:00:00.000Z", ...over,
  } as ApiKeyRecord;
  return { fullKey: g.fullKey, rec };
}

describe("verifyApiKeyAsync (database read on every call)", () => {
  it("reads the store each time and reflects a revoke on the next call", async () => {
    const { fullKey, rec } = record();
    let current: ApiKeyRecord | null = rec;
    const find = vi.fn(async () => current);
    const store = { findApiKeyByPrefix: find };
    expect((await verifyApiKeyAsync(fullKey, store)).id).toBe("k1");
    expect((await verifyApiKeyAsync(fullKey, store)).id).toBe("k1");
    expect(find).toHaveBeenCalledTimes(2);
    current = null;
    await expect(verifyApiKeyAsync(fullKey, store)).rejects.toThrow(/revoked/i);
  });
  it("rejects a wrong secret that shares the public prefix", async () => {
    const { fullKey, rec } = record();
    const forged = fullKey.slice(0, 16) + "x".repeat(fullKey.length - 16);
    await expect(verifyApiKeyAsync(forged, { findApiKeyByPrefix: async () => rec })).rejects.toThrow(/signature/i);
  });
  it("rejects expired keys and malformed input", async () => {
    const { fullKey, rec } = record({ expiresAt: "2020-01-01T00:00:00.000Z" });
    await expect(verifyApiKeyAsync(fullKey, { findApiKeyByPrefix: async () => rec })).rejects.toThrow(/expired/i);
    await expect(verifyApiKeyAsync("short", { findApiKeyByPrefix: async () => rec })).rejects.toThrow();
    await expect(verifyApiKeyAsync(undefined, { findApiKeyByPrefix: async () => rec })).rejects.toThrow();
  });
  it("touches last-used only when it is older than a minute", async () => {
    const touch = vi.fn(async () => undefined);
    const fresh = record({ lastUsedAt: new Date().toISOString() });
    await verifyApiKeyAsync(fresh.fullKey, { findApiKeyByPrefix: async () => fresh.rec, touchApiKeyLastUsed: touch });
    expect(touch).not.toHaveBeenCalled();
    const stale = record({ lastUsedAt: new Date(Date.now() - 120_000).toISOString() });
    await verifyApiKeyAsync(stale.fullKey, { findApiKeyByPrefix: async () => stale.rec, touchApiKeyLastUsed: touch });
    expect(touch).toHaveBeenCalledTimes(1);
  });
});
