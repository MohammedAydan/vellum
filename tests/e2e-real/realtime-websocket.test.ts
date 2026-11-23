/**
 * Real Backend E2E Test - RFC 6455 WebSocket Realtime Hub
 * Validates against running Node.js HTTP server and real Neon PostgreSQL:
 * 1. Connection upgrade and auth frame exchange
 * 2. Path & Query subscriptions receive initial_sync and real mutation frames (create, update, delete)
 * 3. Client disconnect, offline mutations, and reconnect with `resumeSeqId` for ordered event replay
 * 4. Slow consumer disconnect enforcement when outbound buffer exceeds 1 MiB
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import path from "node:path";
import { WebSocket } from "ws";
import { startNodeApiServer } from "../../apps/api/src/node-server.js";
import { createRawPgClient, loadEnvFiles } from "../../packages/database-control/src/index.js";
import { withTenantData } from "./tenant-data-sql.js";

process.env.PHASE5_REAL = "1";

const prefix = `ws_${Date.now()}_`;
let server: Awaited<ReturnType<typeof startNodeApiServer>>;
let baseUrl = "";
let wsUrl = "";
let projectId = "";
let organizationId = "";
let apiKey = "";
let dataClient: Awaited<ReturnType<typeof createRawPgClient>>;
let controlClient: Awaited<ReturnType<typeof createRawPgClient>>;

async function json<T>(url: string, init?: RequestInit): Promise<{ status: number; body: T; headers: Headers }> {
  const response = await fetch(url, init);
  return { status: response.status, body: (await response.json()) as T, headers: response.headers };
}

function waitForFrame<T = any>(
  ws: WebSocket,
  predicate: (frame: any) => boolean,
  timeoutMs = 15_000
): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      ws.off("message", onMessage);
      reject(new Error(`Timeout waiting for WebSocket frame after ${timeoutMs}ms`));
    }, timeoutMs);

    function onMessage(data: any) {
      try {
        const frame = JSON.parse(data.toString());
        if (predicate(frame)) {
          clearTimeout(timer);
          ws.off("message", onMessage);
          resolve(frame as T);
        }
      } catch {
        // ignore JSON parse error
      }
    }

    ws.on("message", onMessage);
  });
}

async function openWebSocket(url: string): Promise<WebSocket> {
  const ws = new WebSocket(url);
  await new Promise((resolve, reject) => {
    ws.once("open", resolve);
    ws.once("error", reject);
  });
  return ws;
}

describe("Real WebSocket Replay & Concurrency Hub", () => {
  beforeAll(async () => {
    loadEnvFiles([path.resolve(".env.phase5.local"), path.resolve(".env")]);
    server = await startNodeApiServer({ port: 0 });
    baseUrl = `http://127.0.0.1:${server.port}`;
    wsUrl = `ws://127.0.0.1:${server.port}/v1/realtime`;

    const org = await json<{ id: string }>(`${baseUrl}/v1/organizations`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "WebSocket Test Org", slug: `${prefix}org`.replace(/_/g, "-"), planTier: "enterprise" }),
    });
    expect(org.status).toBe(201);
    organizationId = org.body.id;

    const project = await json<{ project: { id: string } }>(`${baseUrl}/v1/organizations/${org.body.id}/projects`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "WebSocket Project", slug: `${prefix}proj`.replace(/_/g, "-") }),
    });
    expect(project.status).toBe(201);
    projectId = project.body.project.id;

    const keyRes = await json<{ rawKey: string }>(`${baseUrl}/v1/projects/${projectId}/api-keys`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "WebSocket server key", keyType: "secret" }),
    });
    expect(keyRes.status).toBe(201);
    apiKey = keyRes.body.rawKey;

    controlClient = createRawPgClient({
      connectionString: process.env.CONTROL_DATABASE_URL_DIRECT || process.env.CONTROL_DATABASE_URL || "",
      applicationName: "vellum-e2e-ws-control",
    });
    dataClient = createRawPgClient({
      connectionString: process.env.DATA_DATABASE_URL_DIRECT || process.env.DATA_DATABASE_URL || "",
      applicationName: "vellum-e2e-ws-data",
    });
    await controlClient.connect();
    await dataClient.connect();
  }, 30_000);

  afterAll(async () => {
    if (dataClient) {
      await withTenantData(dataClient, projectId, async (tx) => {
        await tx.query("DELETE FROM documents WHERE project_id = $1::uuid", [projectId]);
        await tx.query("DELETE FROM realtime_outbox WHERE project_id = $1::uuid", [projectId]);
      });
      await dataClient.end();
    }
    if (controlClient) {
      if (projectId) {
        await controlClient.query("DELETE FROM audit_logs WHERE project_id = $1", [projectId]);
        await controlClient.query("DELETE FROM api_keys WHERE project_id = $1", [projectId]);
        await controlClient.query("DELETE FROM projects WHERE id = $1", [projectId]);
      }
      await controlClient.query("DELETE FROM audit_logs WHERE organization_id = $1", [organizationId]);
      await controlClient.query("DELETE FROM organizations WHERE id = $1", [organizationId]);
      await controlClient.end();
    }
    if (server) await server.stop();
  }, 30_000);

  it("real WebSocket auth, subscribe, live mutation frames, and replay on reconnect with resumeSeqId", async () => {
    const docPath = `${prefix}feed/doc_stream`;
    const docUrl = `${baseUrl}/v1/projects/${projectId}/documents/${docPath}`;

    // 1. Connect real WebSocket client
    const ws1 = await openWebSocket(wsUrl);

    // 2. Send auth frame
    ws1.send(JSON.stringify({
      type: "auth",
      projectId,
      apiKey,
    }));

    const authAck = await waitForFrame(ws1, (f) => f.type === "auth_ack");
    expect(authAck.status).toBe("authenticated");
    expect(authAck.connectionId).toBeTruthy();

    // 3. Subscribe to document path
    ws1.send(JSON.stringify({
      type: "subscribe",
      subId: "sub_doc_1",
      path: docPath,
    }));

    const pathSync = await waitForFrame(ws1, (f) => f.type === "initial_sync" && f.subId === "sub_doc_1");
    expect(pathSync.type).toBe("initial_sync");
    expect(pathSync.documents).toEqual([]);

    // 4. Subscribe to query on the collection
    ws1.send(JSON.stringify({
      type: "subscribe",
      subId: "sub_query_1",
      query: {
        collectionPath: `${prefix}feed`,
        where: [{ field: "active", op: "==", value: true }],
      },
    }));

    const querySync = await waitForFrame(ws1, (f) => f.type === "initial_sync" && f.subId === "sub_query_1");
    expect(querySync.type).toBe("initial_sync");
    expect(querySync.documents).toEqual([]);

    // 5. Trigger live mutation via HTTP POST (create document)
    const createPromise1 = waitForFrame(ws1, (f) => f.type === "mutation" && f.subId === "sub_doc_1" && f.operation === "create");
    const createPromise2 = waitForFrame(ws1, (f) => f.type === "mutation" && f.subId === "sub_query_1" && f.operation === "create");

    const created = await json(docUrl, {
      method: "PUT",
      headers: { "content-type": "application/json", "x-project-key": apiKey },
      body: JSON.stringify({ data: { active: true, title: "Original Title", count: 1 } }),
    });
    expect(created.status).toBe(200);

    const [createFrameDoc, createFrameQuery] = await Promise.all([createPromise1, createPromise2]);
    expect(createFrameDoc.document.data.title).toBe("Original Title");
    expect(createFrameQuery.document.data.title).toBe("Original Title");
    const firstSeqId = createFrameDoc.seqId;
    expect(firstSeqId).toBeGreaterThan(0);

    // 6. Trigger live mutation via HTTP PATCH (update document)
    const updatePromise = waitForFrame(ws1, (f) => f.type === "mutation" && f.subId === "sub_doc_1" && f.operation === "update");
    const updated = await json(docUrl, {
      method: "PATCH",
      headers: { "content-type": "application/json", "x-project-key": apiKey },
      body: JSON.stringify({ data: { title: "Updated Title", count: 2 } }),
    });
    expect(updated.status).toBe(200);

    const updateFrame = await updatePromise;
    expect(updateFrame.document.data.title).toBe("Updated Title");
    const secondSeqId = updateFrame.seqId;
    expect(secondSeqId).toBeGreaterThan(firstSeqId);

    // 7. Disconnect client 1
    ws1.close();
    await new Promise((r) => setTimeout(r, 100));

    // 8. While client is disconnected, perform two additional mutations via HTTP
    const off1 = await json(docUrl, {
      method: "PATCH",
      headers: { "content-type": "application/json", "x-project-key": apiKey },
      body: JSON.stringify({ data: { title: "Offline Update 1", count: 3 } }),
    });
    expect(off1.status).toBe(200);

    const off2 = await json(docUrl, {
      method: "PATCH",
      headers: { "content-type": "application/json", "x-project-key": apiKey },
      body: JSON.stringify({ data: { title: "Offline Update 2", count: 4 } }),
    });
    expect(off2.status).toBe(200);

    // 9. Connect a new WebSocket client (ws2) and subscribe with resumeSeqId: secondSeqId
    const ws2 = await openWebSocket(wsUrl);

    ws2.send(JSON.stringify({
      type: "auth",
      projectId,
      apiKey,
    }));
    await waitForFrame(ws2, (f) => f.type === "auth_ack");

    // Collect replayed frames
    const replayedFrames: any[] = [];
    const messageListener = (raw: any) => {
      try {
        const parsed = JSON.parse(raw.toString());
        if (parsed.type === "mutation" && parsed.subId === "sub_resume") {
          replayedFrames.push(parsed);
        }
      } catch {}
    };
    ws2.on("message", messageListener);

    ws2.send(JSON.stringify({
      type: "subscribe",
      subId: "sub_resume",
      path: docPath,
      resumeSeqId: secondSeqId,
    }));

    // Wait until both missed events are replayed
    const startWait = Date.now();
    while (replayedFrames.length < 2 && Date.now() - startWait < 10_000) {
      await new Promise((r) => setTimeout(r, 50));
    }

    ws2.off("message", messageListener);
    expect(replayedFrames.length).toBeGreaterThanOrEqual(2);
    expect(replayedFrames[0].document.data.title).toBe("Offline Update 1");
    expect(replayedFrames[1].document.data.title).toBe("Offline Update 2");
    expect(replayedFrames[1].seqId).toBeGreaterThan(replayedFrames[0].seqId);

    // 10. Test delete mutation
    const deletePromise = waitForFrame(ws2, (f) => f.type === "mutation" && f.subId === "sub_resume" && f.operation === "delete");
    const deleted = await json(docUrl, {
      method: "DELETE",
      headers: { "x-project-key": apiKey },
    });
    expect(deleted.status).toBe(200);

    const deleteFrame = await deletePromise;
    expect(deleteFrame.operation).toBe("delete");
    expect(deleteFrame.document.path).toBe(docPath);

    ws2.close();
  });

  it("enforces slow consumer disconnect when client outbound buffer overflows 1 MiB", async () => {
    const wsSlow = await openWebSocket(wsUrl);

    // 1. Authenticate
    wsSlow.send(JSON.stringify({
      type: "auth",
      projectId,
      apiKey,
    }));

    const authAck = await waitForFrame(wsSlow, (f) => f.type === "auth_ack");
    const connId = authAck.connectionId;

    // 2. Locate the active session on the server hub
    const sessionHandle = server.platform.realtimeHub.connections.get(connId);
    expect(sessionHandle).toBeDefined();

    // 3. Set outbound buffered bytes near limit (1 MiB = 1_048_576 bytes)
    sessionHandle!.outboundBufferedBytes = 1_048_570;

    // 4. Trigger a frame from client (ping) which causes server to reply with pong
    // The pong frame serialization exceeds the 1 MiB threshold
    const errorPromise = waitForFrame(wsSlow, (f) => f.type === "error" && f.code === "SLOW_CONSUMER_DISCONNECT");
    const closePromise = new Promise<void>((resolve) => wsSlow.once("close", () => resolve()));

    wsSlow.send(JSON.stringify({ type: "ping", ts: Date.now() }));

    const errorFrame = await errorPromise;
    expect(errorFrame.type).toBe("error");
    expect(errorFrame.code).toBe("SLOW_CONSUMER_DISCONNECT");
    expect(errorFrame.message).toMatch(/exceeded maximum/i);

    // 5. Verify the socket is terminated
    await closePromise;
    expect(wsSlow.readyState).toBe(WebSocket.CLOSED);
  });
});
