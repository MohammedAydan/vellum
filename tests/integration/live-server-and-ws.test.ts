/**
 * Live HTTP + RFC 6455 WebSocket Server Integration Test (`tests/integration/live-server-and-ws.test.ts`)
 * Boots `startNodeApiServer` on a real TCP port and verifies:
 * 1. Live HTTP GET /v1/health and GET /v1/openapi.json over network sockets
 * 2. Live HTTP CRUD & Query execution over fetch
 * 3. Live TCP Upgrade to RFC 6455 WebSocket (GET /v1/realtime with Upgrade: websocket)
 */

import { describe, it, expect } from "vitest";
import net, { type Socket } from "node:net";
import crypto from "node:crypto";
import { EventEmitter } from "node:events";
import { startNodeApiServer } from "../../apps/api/src/node-server.js";
import { createVellumPlatform } from "../../apps/api/src/index.js";
import { CustomerDashboardService } from "../../apps/dashboard/src/index.js";
import { tryDecodeWsFrame } from "../../apps/api/src/ws-rfc6455.js";

function encodeMaskedClientFrame(jsonObj: unknown): Buffer {
  const payload = Buffer.from(JSON.stringify(jsonObj), "utf8");
  const maskKey = crypto.randomBytes(4);
  const maskedPayload = Buffer.allocUnsafe(payload.length);
  for (let i = 0; i < payload.length; i++) {
    const keyByte = maskKey[i % 4];
    const payloadByte = payload[i];
    if (keyByte !== undefined && payloadByte !== undefined) {
      maskedPayload[i] = payloadByte ^ keyByte;
    }
  }
  const len = payload.length;
  let header: Buffer;
  if (len < 126) {
    header = Buffer.from([0x81, 0x80 | len]);
  } else {
    header = Buffer.allocUnsafe(4);
    header[0] = 0x81;
    header[1] = 0x80 | 126;
    header.writeUInt16BE(len, 2);
  }
  return Buffer.concat([header, maskKey, maskedPayload]);
}

describe("tests/integration/live-server-and-ws", () => {
  it("Live Node HTTP + RFC 6455 WebSocket Server handles network REST and WebSocket upgrade end-to-end", async () => {
    // Inject a memory platform: this suite verifies the real TCP HTTP server and
    // RFC 6455 upgrade, not cross-run Neon persistence. Avoids depending on live
    // DB state (stale slugs/schemas) and async PG-store registration races.
    const { port, platform, stop, server } = await startNodeApiServer({
      port: 0,
      platform: createVellumPlatform(),
    });
    // Node's http.Server.close() waits for upgraded sockets even after
    // socket.destroy(). Track raw connections so teardown can force-close them.
    const rawSockets = new Set<Socket>();
    server.on("connection", (socket) => {
      rawSockets.add(socket);
      socket.on("close", () => rawSockets.delete(socket));
    });

    try {
      const dashboard = new CustomerDashboardService({ platform });
      // Use per-run unique slugs so repeated runs can never collide with rows
      // left by earlier runs against a persistent plane.
      const runId = crypto.randomUUID().slice(0, 8);
      // Store methods are MaybePromise; await before reading `.id` (destructuring
      // an un-awaited Promise yields an undefined `project`).
      const org = await platform.controlStore.createOrganization({
        slug: `live-org-${runId}`,
        name: "Live Network Org",
        billingEmail: "ops@live.org",
      });
      const { project } = await platform.controlStore.createProject({
        organizationId: org.id,
        slug: `live-proj-${runId}`,
        name: "Live Project",
      });
      const { plaintextKeyOnce: serverKey } = dashboard.createProjectApiKey({
        projectId: project.id,
        name: "Live Server Key",
        keyType: "server",
        scopes: ["documents:read", "documents:write"],
      });

      // 1. Verify /v1/health and /v1/openapi.json over real TCP HTTP
      const healthRes = await fetch(`http://127.0.0.1:${port}/v1/health`);
      expect(healthRes.status).toBe(200);
      const healthJson = (await healthRes.json()) as { status: string };
      expect(healthJson.status).toBe("ok");

      const openApiRes = await fetch(`http://127.0.0.1:${port}/v1/openapi.json`);
      expect(openApiRes.status).toBe(200);
      const openApiJson = (await openApiRes.json()) as { openapi: string };
      expect(openApiJson.openapi).toBe("3.1.0");

      // 2. Connect a real TCP socket and perform RFC 6455 WebSocket handshake on /v1/realtime
      const frameEvents = new EventEmitter();
      const socket = net.connect(port, "127.0.0.1");
      let handshakeDone = false;
      let wsBuf = Buffer.alloc(0);

      socket.on("data", (chunk: Buffer) => {
        wsBuf = Buffer.concat([wsBuf, chunk]);
        if (!handshakeDone) {
          const headerEnd = wsBuf.indexOf("\r\n\r\n");
          if (headerEnd !== -1) {
            const headerStr = wsBuf.subarray(0, headerEnd).toString("utf8");
            expect(headerStr).toContain("101 Switching Protocols");
            handshakeDone = true;
            wsBuf = wsBuf.subarray(headerEnd + 4);
            frameEvents.emit("handshake");
          }
        }
        if (handshakeDone) {
          while (wsBuf.length >= 2) {
            const frame = tryDecodeWsFrame(wsBuf);
            if (!frame) break;
            wsBuf = wsBuf.subarray(frame.totalFrameBytes);
            if (frame.opcode === 0x1) {
              const parsed = JSON.parse(frame.payload.toString("utf8")) as Record<string, unknown>;
              frameEvents.emit("frame", parsed);
            }
          }
        }
      });

      const initialSyncPromise = new Promise<Record<string, unknown>>((resolve) => {
        frameEvents.on("frame", (f: Record<string, unknown>) => {
          if (f.type === "initial_sync" || f.type === "sync_complete") resolve(f);
        });
      });

      frameEvents.once("handshake", () => {
        socket.write(
          encodeMaskedClientFrame({
            type: "auth",
            projectId: project.id,
            apiKey: serverKey,
          })
        );
        socket.write(
          encodeMaskedClientFrame({
            type: "subscribe",
            subId: "live_sub_1",
            path: "sensors/s_1",
          })
        );
      });

      const secKey = crypto.randomBytes(16).toString("base64");
      socket.write(
        [
          "GET /v1/realtime HTTP/1.1",
          `Host: 127.0.0.1:${port}`,
          "Upgrade: websocket",
          "Connection: Upgrade",
          `Sec-WebSocket-Key: ${secKey}`,
          "Sec-WebSocket-Version: 13",
          "\r\n",
        ].join("\r\n")
      );

      await initialSyncPromise;

      // 3. Trigger an HTTP PUT mutation and confirm the live WebSocket receives mutation event
      const mutationPromise = new Promise<Record<string, unknown>>((resolve) => {
        frameEvents.on("frame", (f: Record<string, unknown>) => {
          if (f.type === "mutation" || f.type === "change") resolve(f);
        });
      });

      const putRes = await fetch(
        `http://127.0.0.1:${port}/v1/projects/${project.id}/documents/sensors/s_1`,
        {
          method: "PUT",
          headers: { "x-project-key": serverKey, "content-type": "application/json" },
          body: JSON.stringify({ data: { temperatureC: 26.4, location: "Mansoura" } }),
        }
      );
      expect(putRes.status).toBe(200);

      const liveChange = await mutationPromise;
      const op = liveChange.operation ?? liveChange.changeType;
      expect(op === "create" || op === "added").toBe(true);
      const doc = (liveChange.document ?? liveChange.doc) as { data: { temperatureC: number } };
      expect(doc.data.temperatureC).toBe(26.4);

      socket.destroy();
    } finally {
      // Force-close every raw connection (including the upgraded WS socket)
      // before stop(), otherwise http.Server.close() never resolves.
      for (const raw of rawSockets) raw.destroy();
      await stop();
    }
  }, 30_000);
});
