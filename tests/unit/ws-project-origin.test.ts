import { describe, it, expect } from "vitest";
import http from "node:http";
import net from "node:net";
import crypto from "node:crypto";
import type { AddressInfo } from "node:net";
import { DataPlaneStore } from "@vellum/storage/adapters";
import { RealtimeGatewayHub } from "@vellum/realtime";
import { attachRealtimeWebSocketServer } from "../../apps/api/src/ws-rfc6455.js";

const GLOBAL = "https://console.example";
const SHOP = "https://shop.example";

function maskedText(text: string): Buffer {
  const payload = Buffer.from(text);
  const mask = crypto.randomBytes(4);
  const body = Buffer.from(payload.map((b, i) => b ^ mask[i % 4]!));
  return Buffer.concat([Buffer.from([0x81, 0x80 | payload.length]), mask, body]);
}

async function run(opts: { origin: string; withCheck: boolean; frame?: unknown }) {
  const hub = new RealtimeGatewayHub({
    controlStore: { getProject: () => null, getActiveRuleset: () => null, incrementUsage() {} } as never,
    dataStore: new DataPlaneStore(),
  });
  const server = http.createServer();
  const checked: Array<[string, string]> = [];
  const handle = attachRealtimeWebSocketServer(server, hub, {
    allowedOrigins: new Set([GLOBAL]),
    ...(opts.withCheck
      ? {
          isProjectOriginAllowed: async (projectId: string, origin: string) => {
            checked.push([projectId, origin]);
            return projectId === "p1" && origin === SHOP;
          },
        }
      : {}),
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as AddressInfo).port;
  const socket = net.connect(port, "127.0.0.1");
  const chunks: Buffer[] = [];
  socket.on("data", (d) => chunks.push(d));
  await new Promise<void>((r) => socket.on("connect", r));
  socket.write(
    `GET /v1/realtime HTTP/1.1\r\nHost: x\r\nOrigin: ${opts.origin}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: ${crypto.randomBytes(16).toString("base64")}\r\n\r\n`
  );
  await new Promise((r) => setTimeout(r, 150));
  if (opts.frame !== undefined) {
    socket.write(maskedText(JSON.stringify(opts.frame)));
    await new Promise((r) => setTimeout(r, 300));
  }
  const buf = Buffer.concat(chunks);
  const head = buf.subarray(0, buf.indexOf("\r\n\r\n")).toString();
  const rest = buf.subarray(buf.indexOf("\r\n\r\n") + 4);
  const closeAt = rest.indexOf(0x88);
  const closeCode = closeAt >= 0 ? rest.readUInt16BE(closeAt + 2) : null;
  socket.destroy();
  handle.closeAllWebSockets();
  server.close();
  return { status: head.split("\r\n")[0], closeCode, checked };
}

describe("WebSocket origin for third-party web apps", () => {
  it("still rejects an unknown origin at the handshake when no project check is configured", async () => {
    const r = await run({ origin: SHOP, withCheck: false });
    expect(r.status).toContain("403");
  });

  it("rejects null and malformed origins at the handshake even with the project check", async () => {
    for (const origin of ["null", "https://*.example", "not a url"]) {
      const r = await run({ origin, withCheck: true });
      expect(r.status).toContain("403");
      expect(r.checked).toHaveLength(0);
    }
  });

  it("accepts an origin listed on a key of the project named in the auth frame", async () => {
    const r = await run({ origin: SHOP, withCheck: true, frame: { type: "auth", projectId: "p1", apiKey: "pk_x" } });
    expect(r.status).toContain("101");
    expect(r.checked).toEqual([["p1", SHOP]]);
    expect(r.closeCode).not.toBe(1008);
  });

  it("closes 1008 when the origin is not listed for the project in the auth frame", async () => {
    const r = await run({ origin: SHOP, withCheck: true, frame: { type: "auth", projectId: "p2", apiKey: "pk_x" } });
    expect(r.status).toContain("101");
    expect(r.closeCode).toBe(1008);
  });

  it("closes 1008 when the first frame is not an auth frame", async () => {
    const r = await run({ origin: SHOP, withCheck: true, frame: { type: "subscribe", subId: "s", query: { collectionPath: "c" } } });
    expect(r.closeCode).toBe(1008);
    expect(r.checked).toHaveLength(0);
  });

  it("does not run the project check for globally allowed origins", async () => {
    const r = await run({ origin: GLOBAL, withCheck: true, frame: { type: "auth", projectId: "p2", apiKey: "pk_x" } });
    expect(r.status).toContain("101");
    expect(r.checked).toHaveLength(0);
  });
});
