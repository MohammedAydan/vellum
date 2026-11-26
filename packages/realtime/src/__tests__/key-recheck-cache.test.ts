import { describe, expect, it } from "vitest";
import { RealtimeGatewayHub } from "../hub.js";
import { DataPlaneStore } from "@vellum/storage/adapters";

const key = { id: "k1", projectId: "p1", keyPrefix: "pk_aaaaaaaaaaaaaa", revokedAt: null, expiresAt: null } as never;

function setup(ttl: string) {
  process.env["REALTIME_KEY_RECHECK_TTL_MS"] = ttl;
  let lookups = 0;
  let current: unknown = key;
  const controlStore = {
    findApiKeyByPrefix: async () => {
      lookups += 1;
      return current;
    },
    getProject: () => ({ project: { id: "p1" } }),
    getActiveRuleset: () => null,
  } as never;
  const hub = new RealtimeGatewayHub({ controlStore, dataStore: new DataPlaneStore() });
  const session = { projectId: "p1", apiKeyRecord: key, authContext: { uid: null, claims: {} } } as never;
  const check = () => (hub as unknown as { checkSessionCredentialExpiry(s: unknown, n?: number, m?: Map<string, unknown>): Promise<unknown> })
    .checkSessionCredentialExpiry(session, Date.now(), new Map());
  return { check, lookups: () => lookups, revoke: () => { current = null; } };
}

describe("per-event API key recheck cache", () => {
  it("hits the control store once per TTL, not once per event", async () => {
    const t = setup("300");
    for (let i = 0; i < 100; i += 1) expect(await t.check()).toBeNull();
    expect(t.lookups()).toBe(1);
  });
  it("drops a revoked key from sessions after the TTL", async () => {
    const t = setup("150");
    expect(await t.check()).toBeNull();
    t.revoke();
    expect(await t.check()).toBeNull(); // still inside the TTL
    await new Promise((r) => setTimeout(r, 200));
    expect(await t.check()).not.toBeNull();
  });
  it("TTL 0 checks every time", async () => {
    const t = setup("0");
    await t.check(); await t.check();
    expect(t.lookups()).toBe(2);
  });
});
