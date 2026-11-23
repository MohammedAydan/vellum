/**
 * two independent hub instances (each with its own
 * dedicated LISTEN client and poller) observe the same outbox and both deliver
 * the mutation exactly once. Also proves cross-tenant replay/fan-out isolation.
 */

import { describe, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { createStorageAdapter } from "@vellum/storage";
import type { ServerFrame } from "@vellum/api-contract";
import { createPgRealtimeInfrastructure } from "@vellum/realtime";
import {
  authenticateAndSubscribe,
  applyOutboxNotifyMigration,
  insertOutboxEvent,
  loadDataDatabaseUrl,
  loadListenConnectionString,
  makeHub,
  makeTenant,
  waitFor,
} from "../realtime-pg-common/helpers.js";

describe("multi-instance realtime fan-out (real database)", () => {
  it("two hubs observing the same outbox both deliver one mutation", async () => {
    const connectionString = loadDataDatabaseUrl();
    await applyOutboxNotifyMigration(connectionString);
    const tenant = makeTenant();
    const otherTenant = makeTenant();
    const docPath = `messages/${randomUUID()}`;

    const storeA = createStorageAdapter({ connectionString, driver: "pg" });
    const storeB = createStorageAdapter({ connectionString, driver: "pg" });
    const storeC = createStorageAdapter({ connectionString, driver: "pg" });
    const { hub: hubA } = makeHub(storeA, tenant);
    const { hub: hubB } = makeHub(storeB, tenant);
    const { hub: hubC } = makeHub(storeC, otherTenant);

    const framesA: ServerFrame[] = [];
    const framesB: ServerFrame[] = [];
    const framesC: ServerFrame[] = [];
    await authenticateAndSubscribe(hubA, tenant, "sub_a", docPath, framesA);
    await authenticateAndSubscribe(hubB, tenant, "sub_b", docPath, framesB);
    await authenticateAndSubscribe(hubC, otherTenant, "sub_c", docPath, framesC);

    const listenUrl = loadListenConnectionString(); // session-mode endpoint for dedicated LISTEN clients
    const infraA = createPgRealtimeInfrastructure({ connectionString: listenUrl, dataStore: storeA, hub: hubA, pollIntervalMs: 150 });
    const infraB = createPgRealtimeInfrastructure({ connectionString: listenUrl, dataStore: storeB, hub: hubB, pollIntervalMs: 150 });
    const infraC = createPgRealtimeInfrastructure({ connectionString: listenUrl, dataStore: storeC, hub: hubC, pollIntervalMs: 150 });

    await Promise.all([infraA.start(), infraB.start(), infraC.start()]);
    try {
      const seqId = await insertOutboxEvent(connectionString, tenant, { path: docPath, text: "two-hub-proof" });
      await waitFor(
        () =>
          framesA.some((f) => f.type === "mutation" && f.document.path === docPath) &&
          framesB.some((f) => f.type === "mutation" && f.document.path === docPath),
        12_000,
        "mutations on both hubs"
      );

      await new Promise((resolve) => setTimeout(resolve, 700)); // allow duplicate wake-ups

      const mutationsA = framesA.filter(
        (f): f is Extract<ServerFrame, { type: "mutation" }> => f.type === "mutation" && f.document.path === docPath
      );
      const mutationsB = framesB.filter(
        (f): f is Extract<ServerFrame, { type: "mutation" }> => f.type === "mutation" && f.document.path === docPath
      );
      expect(mutationsA).toHaveLength(1);
      expect(mutationsB).toHaveLength(1);
      expect(mutationsA[0]?.document.data).toEqual({ text: "two-hub-proof" });
      expect(mutationsB[0]?.document.data).toEqual({ text: "two-hub-proof" });
      expect(mutationsA[0]?.seqId).toBe(Number(seqId));
      expect(mutationsB[0]?.seqId).toBe(Number(seqId));

      // A hub authenticated for a different tenant must never see the event.
      expect(framesC.filter((f) => f.type === "mutation")).toHaveLength(0);
    } finally {
      await Promise.all([infraA.stop(), infraB.stop(), infraC.stop()]);
      await Promise.all([storeA.close(), storeB.close(), storeC.close()]);
    }
  }, 30_000);
});
