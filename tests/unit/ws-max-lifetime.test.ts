import { describe, it, expect } from "vitest";
import http from "node:http";
import net from "node:net";
import crypto from "node:crypto";
import type { AddressInfo } from "node:net";
import { DataPlaneStore } from "@vellum/storage/adapters";
import { RealtimeGatewayHub } from "@vellum/realtime";
import { attachRealtimeWebSocketServer } from "../../apps/api/src/ws-rfc6455.js";

async function connectAndWaitForClose(maxLifetimeMs: number | undefined, waitMs: number) {
  const hub = new RealtimeGatewayHub({
    controlStore: { getProject: () => ({ project: { id: "p" } }), getActiveRuleset: () => null, incrementUsage() {} } as never,
    dataStore: new DataPlaneStore(),
  });
  const server = http.createServer();
  const handle = attachRealtimeWebSocketServer(server, hub, {
    allowedOrigins: new Set(["*"]),
    ...(maxLifetimeMs !== undefined ? { maxLifetimeMs } : {}),
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as AddressInfo).port;
  const socket = net.connect(port, "127.0.0.1");
  const chunks: Buffer[] = [];
  socket.on("data", (d) => chunks.push(d));
  await new Promise<void>((r) => socket.on("connect", r));
  socket.write(
    `GET /v1/realtime HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: ${crypto.randomBytes(16).toString("base64")}\r\n\r\n`
  );
  const t0 = Date.now();
  const ended = await Promise.race([
    new Promise<boolean>((r) => socket.on("close", () => r(true))),
    new Promise<boolean>((r) => setTimeout(() => r(false), waitMs)),
  ]);
  const elapsed = Date.now() - t0;
  const buf = Buffer.concat(chunks);
  const idx = buf.indexOf("\r\n\r\n") + 4;
  const frame = buf.subarray(idx);
  const code = frame.length >= 4 && frame[0] === 0x88 ? frame.readUInt16BE(2) : null;
  const reason = frame.length > 4 ? frame.subarray(4, 2 + (frame[1] ?? 0)).toString() : "";
  socket.destroy();
  handle.closeAllWebSockets();
  server.close();
  return { ended, elapsed, code, reason };
}

describe("websocket max lifetime", () => {
  it("closes with 1001 Reconnect after the lifetime", async () => {
    const r = await connectAndWaitForClose(150, 2000);
    expect(r.ended).toBe(true);
    expect(r.code).toBe(1001);
    expect(r.reason).toBe("Reconnect");
    expect(r.elapsed).toBeGreaterThanOrEqual(140);
    expect(r.elapsed).toBeLessThan(1000);
  });
  it("stays open when no lifetime is set", async () => {
    const r = await connectAndWaitForClose(undefined, 400);
    expect(r.ended).toBe(false);
  });
});
