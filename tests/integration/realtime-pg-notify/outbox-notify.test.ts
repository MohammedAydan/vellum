/**
 * real PostgreSQL proof:
 *  1. an outbox INSERT emits a tiny NOTIFY on `vellum_outbox`;
 *  2. a dedicated listener receives it;
 *  3. the poller fetches the full row and fans it out to a hub session.
 *
 * Uses DATA_DATABASE_URL from .env.phase5.local (never printed).
 */

import { describe, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { createStorageAdapter } from "@vellum/storage";
import type { ServerFrame } from "@vellum/api-contract";
import {
  PG_OUTBOX_CHANNEL,
  createPgNotifyBus,
  createPgRealtimeInfrastructure,
  parseOutboxNotification,
} from "@vellum/realtime";
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

describe("PostgreSQL outbox NOTIFY + poller fan-out (real database)", () => {
  it("a committed outbox row wakes a dedicated LISTEN client with a tiny payload", async () => {
    const connectionString = loadDataDatabaseUrl();
    await applyOutboxNotifyMigration(connectionString);
    const tenant = makeTenant();

    // LISTEN requires a session-mode (non-pooler) endpoint; the outbox writes
    // still go through the ordinary DATA_DATABASE_URL pooler endpoint.
    const listenConnectionString = loadListenConnectionString();
    const bus = createPgNotifyBus({ connectionString: listenConnectionString, channels: [PG_OUTBOX_CHANNEL] });
    const received: string[] = [];
    const unsubscribe = await bus.subscribe(PG_OUTBOX_CHANNEL, (payload) => {
      received.push(payload);
    });

    try {
      const seqId = await insertOutboxEvent(connectionString, tenant, { text: "notify-proof" });
      await waitFor(() => received.length > 0, 8_000, "outbox NOTIFY");

      const note = parseOutboxNotification(received[0] ?? "");
      expect(note).not.toBeNull();
      expect(note?.seqId).toBe(seqId);
      expect(note?.projectId).toBe(tenant.projectId);
      // The notification must NOT embed document data.
      expect(received[0]).not.toContain("notify-proof");
      expect(received[0]).not.toContain("messages/");

      // Full row is fetched from the durable outbox, not the notification.
      const store = createStorageAdapter({ connectionString, driver: "pg" });
      try {
        const rows = await store.queryOutboxSince(tenant, String(BigInt(seqId) - 1n));
        const row = rows.find((r) => r.seqId === seqId);
        expect(row).toBeDefined();
        expect(row?.afterData).toEqual({ text: "notify-proof" });
      } finally {
        await store.close();
      }
    } finally {
      unsubscribe();
      await bus.close();
    }
  }, 30_000);

  it("the poller fetches the row and fans it out to a subscribed hub session exactly once", async () => {
    const connectionString = loadDataDatabaseUrl();
    await applyOutboxNotifyMigration(connectionString);
    const tenant = makeTenant();
    const docPath = `messages/${randomUUID()}`;

    const dataStore = createStorageAdapter({ connectionString, driver: "pg" });
    const { hub } = makeHub(dataStore, tenant);
    const frames: ServerFrame[] = [];
    await authenticateAndSubscribe(hub, tenant, "sub_notify", docPath, frames);

    const infra = createPgRealtimeInfrastructure({
      connectionString: loadListenConnectionString(),
      dataStore,
      hub,
      pollIntervalMs: 150,
    });
    await infra.start();
    try {
      const seqId = await insertOutboxEvent(connectionString, tenant, { path: docPath, text: "fanout-proof" });
      await waitFor(
        () => frames.some((f) => f.type === "mutation" && f.document.path === docPath),
        10_000,
        "hub mutation frame"
      );

      // Extra time lets both NOTIFY and the plain poll loop observe the row.
      await new Promise((resolve) => setTimeout(resolve, 700));
      const mutations = frames.filter(
        (f): f is Extract<ServerFrame, { type: "mutation" }> => f.type === "mutation" && f.document.path === docPath
      );
      expect(mutations).toHaveLength(1);
      expect(mutations[0]?.document.data).toEqual({ text: "fanout-proof" });
      expect(mutations[0]?.seqId).toBe(Number(seqId));
      expect(infra.poller.stats.eventsDelivered).toBeGreaterThanOrEqual(1);
    } finally {
      await infra.stop();
      await dataStore.close();
    }
  }, 30_000);
});
