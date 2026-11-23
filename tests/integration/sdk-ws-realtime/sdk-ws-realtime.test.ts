/**
 * Integration tests  — real RFC 6455 WebSocket server, in-memory mode.
 * Proves subscribe -> write -> mutation frame delivery, and reconnect resume.
 * No Redis, no external database.
 */
import http from "node:http";
import type { Socket } from "node:net";
import type { AddressInfo } from "node:net";
import { describe, it, expect } from "vitest";
import { createVellumPlatform } from "../../../apps/api/src/index.js";
import { attachRealtimeWebSocketServer } from "../../../apps/api/src/ws-rfc6455.js";
import { CustomerDashboardService } from "../../../apps/dashboard/src/index.js";
import { createClient } from "../../../packages/sdk-js/src/index.js";
import type { RealtimeSnapshot } from "../../../packages/sdk-js/src/index.js";

type Platform = ReturnType<typeof createVellumPlatform>;

interface LocalServer {
  port: number;
  platform: Platform;
  projectId: string;
  apiKey: string;
  /** Forcibly drop every live socket (simulates a network interruption). */
  dropConnections: () => void;
  stop: () => Promise<void>;
}

async function startLocalServer(): Promise<LocalServer> {
  const platform = createVellumPlatform();
  const dashboard = new CustomerDashboardService({ platform });
  const user = platform.controlStore.createUser({
    email: "sdk-ws@vellum.dev",
    name: "SDK WS Test",
    platformRole: "customer",
  });
  const org = platform.controlStore.createOrganization({
    slug: "sdk-ws-org",
    name: "SDK WS Org",
    billingEmail: "sdk-ws@vellum.dev",
    ownerUserId: user.id,
  });
  const { project } = platform.controlStore.createProject({
    organizationId: org.id,
    slug: "sdk-ws-proj",
    name: "SDK WS Project",
    actorUserId: user.id,
  });
  const { plaintextKeyOnce: apiKey } = dashboard.createProjectApiKey({
    projectId: project.id,
    name: "SDK WS Server Key",
    keyType: "server",
    scopes: ["documents:read", "documents:write"],
    actorUserId: user.id,
  });

  const httpServer = http.createServer((_req, res) => {
    res.writeHead(404);
    res.end();
  });
  // Track raw connections so teardown can force-close upgraded sockets (Node's
  // http.Server.close() waits for upgraded sockets even after socket.destroy()).
  const connections = new Set<Socket>();
  httpServer.on("connection", (socket) => {
    connections.add(socket);
    socket.on("close", () => connections.delete(socket));
  });
  attachRealtimeWebSocketServer(httpServer, platform.realtimeHub);
  await new Promise<void>((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
  const port = (httpServer.address() as AddressInfo).port;

  const dropConnections = (): void => {
    for (const socket of connections) socket.destroy();
  };

  return {
    port,
    platform,
    projectId: project.id,
    apiKey,
    dropConnections,
    stop: () =>
      new Promise<void>((resolve) => {
        dropConnections();
        httpServer.close(() => resolve());
      }),
  };
}

async function waitFor(predicate: () => boolean, timeoutMs = 8000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error(`waitFor timed out after ${timeoutMs}ms`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function snapshotHasValue(snapshots: RealtimeSnapshot<Record<string, unknown>>[], value: number): boolean {
  return snapshots.some((snap) =>
    snap.changes.some((change) => {
      const data = change.doc.data();
      return change.doc.path === "tickets/t1" && data["n"] === value;
    })
  );
}

describe("tests/integration/sdk-ws-realtime (native WebSocket transport)", () => {
  it("subscribe -> write -> mutation frame delivery over a real local WS server", async () => {
    const server = await startLocalServer();
    try {
      const client = createClient({
        projectId: server.projectId,
        apiKey: server.apiKey,
        endpoint: `http://127.0.0.1:${server.port}`,
        customFetch: (url, init) => server.platform.fetch(new Request(url, init)),
        realtimeTransportOptions: { heartbeatIntervalMs: 60_000, connectTimeoutMs: 5000 },
      });

      const snapshots: RealtimeSnapshot<Record<string, unknown>>[] = [];
      const docRef = client.collection("tickets").doc("t1");
      const unsubscribe = docRef.onSnapshot((snap) => snapshots.push(snap));

      await waitFor(() => snapshots.length > 0);
      expect(snapshots[0]?.watermarkSeqId).not.toBeNull();

      await docRef.create({ status: "open", n: 1 });
      await waitFor(() => snapshotHasValue(snapshots, 1));

      const delivering = snapshots.find((snap) => snapshotHasValue([snap], 1));
      const change = delivering?.changes.find((c) => c.doc.path === "tickets/t1");
      expect(change?.doc.id).toBe("t1");
      expect(change?.doc.version).toBeGreaterThanOrEqual(1);
      expect(change?.seqId).toBeGreaterThan(0);
      expect(change?.doc.data()).toMatchObject({ status: "open", n: 1 });

      unsubscribe();
    } finally {
      await server.stop();
    }
  }, 20_000);

  it("reconnects after a server-side drop and resumes missed mutations via resumeSeqId", async () => {
    const server = await startLocalServer();
    try {
      const client = createClient({
        projectId: server.projectId,
        apiKey: server.apiKey,
        endpoint: `http://127.0.0.1:${server.port}`,
        customFetch: (url, init) => server.platform.fetch(new Request(url, init)),
        realtimeTransportOptions: {
          // Longer reconnect delay so the offline write lands while disconnected.
          randomFn: () => 0.9,
          heartbeatIntervalMs: 60_000,
          connectTimeoutMs: 5000,
        },
      });

      const snapshots: RealtimeSnapshot<Record<string, unknown>>[] = [];
      const docRef = client.collection("tickets").doc("t1");
      const unsubscribe = docRef.onSnapshot((snap) => snapshots.push(snap));

      await waitFor(() => snapshots.length > 0);
      await docRef.create({ status: "open", n: 1 });
      await waitFor(() => snapshotHasValue(snapshots, 1));

      const firstSeq = snapshots
        .flatMap((snap) => snap.changes)
        .filter((change) => change.doc.path === "tickets/t1")
        .map((change) => change.seqId)
        .reduce((max, value) => Math.max(max, value), 0);
      expect(firstSeq).toBeGreaterThan(0);

      // Force the server to drop the socket (the SDK must reconnect by itself).
      server.dropConnections();
      // Write while offline — no live socket to deliver this mutation.
      await docRef.update({ n: 2 });

      await waitFor(() => snapshotHasValue(snapshots, 2), 12_000);
      const replayed = snapshots
        .flatMap((snap) => snap.changes)
        .filter((change) => change.doc.path === "tickets/t1" && change.doc.data()["n"] === 2);
      expect(replayed.length).toBeGreaterThan(0);
      expect(replayed[0]!.seqId).toBeGreaterThan(firstSeq);

      unsubscribe();
    } finally {
      await server.stop();
    }
  }, 25_000);
});
