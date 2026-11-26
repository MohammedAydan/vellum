import { describe, expect, it } from "vitest";
import { createPgRealtimeInfrastructure } from "../pg-realtime.js";

describe("createPgRealtimeInfrastructure", () => {
  it("skips LISTEN for a placeholder connection string without throwing", async () => {
    const infra = createPgRealtimeInfrastructure({
      connectionString: "postgres://user:pw@CHANGE_ME_HOST:5432/db",
      dataStore: { async queryOutboxSince() { return []; } } as never,
      hub: { async notifyCommittedEvents() {}, connections: new Map() } as never,
      pollIntervalMs: 50,
    });
    await expect(infra.start()).resolves.toBeUndefined();
    await infra.stop();
  });
});
