import { describe, expect, it } from "vitest";
import type { OutboxEvent } from "@vellum/storage";
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

  it("delivers committed rows to a connected client with LISTEN skipped", async () => {
    const mk = (n: number): OutboxEvent => ({
      seqId: String(n), projectId: "p1", collectionPath: "items", path: `items/i${n}`, documentId: `i${n}`,
      opType: "updated", version: 1, beforeData: null, afterData: { n }, committedAt: new Date().toISOString(),
    });
    const rows: OutboxEvent[] = [mk(1)];
    const delivered: string[] = [];
    const connections = new Map([["c1", { authenticated: true, closed: false, projectId: "p1" }]]);
    const infra = createPgRealtimeInfrastructure({
      connectionString: "postgres://user:pw@CHANGE_ME_HOST:5432/db",
      dataStore: {
        async queryOutboxSince(_ctx: unknown, after = "0", upTo?: string) {
          const cap = upTo === undefined ? null : BigInt(upTo);
          return rows.filter((r) => BigInt(r.seqId) > BigInt(after) && (cap === null || BigInt(r.seqId) <= cap));
        },
        // P0-2: the safe watermark tracks the rows that have "resolved".
        async queryOutboxSafeWatermark() { return rows[rows.length - 1]?.seqId ?? "0"; },
      } as never,
      hub: { connections, async notifyCommittedEvents(_p: string, evs: OutboxEvent[]) { for (const e of evs) delivered.push(e.seqId); } } as never,
      pollIntervalMs: 50,
    });
    await infra.start();
    await new Promise((r) => setTimeout(r, 300));
    rows.push(mk(2));
    await new Promise((r) => setTimeout(r, 400));
    await infra.stop();
    expect(delivered).toContain("2");
    expect(new Set(delivered).size).toBe(delivered.length);
  });
});
