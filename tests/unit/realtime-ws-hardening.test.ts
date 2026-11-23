/** focused tests for WebSocket upgrade/frame hardening. */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import http from "node:http";
import net, { type Socket } from "node:net";
import type { AddressInfo } from "node:net";
import crypto from "node:crypto";
import { DataPlaneStore } from "@vellum/storage/adapters";
import { hashApiKey, type ApiKeyRecord } from "@vellum/authorization";
import { RealtimeGatewayHub } from "@vellum/realtime";
import {
  MAX_WS_FRAME_BYTES,
  WsFrameTooLargeError,
  attachRealtimeWebSocketServer,
  encodeWsCloseFrame,
  encodeWsFrame,
  isOriginAllowed,
  parseAllowedOrigins,
  tryDecodeWsFrame,
  type WebSocketServerHandle,
} from "../../apps/api/src/ws-rfc6455.js";

const ALLOWED_ORIGIN = "http://allowed.example";
const API_KEY = "pk_ws_hardening_1234567890abcdef";
const TENANT = {
  projectId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
};

class ControlStore {
  public readonly apiKeysByPrefix = new Map<string, ApiKeyRecord>();
  constructor() {
    const prefix = API_KEY.slice(0, 16);
    this.apiKeysByPrefix.set(prefix, {
      id: "key_ws",
      projectId: TENANT.projectId,
      name: "WS Test",
      keyType: "server",
      keyPrefix: prefix,
      secretHash: hashApiKey(API_KEY),
      scopes: ["*"],
      rateLimitRps: 1000,
      lastUsedAt: null,
      expiresAt: null,
      revokedAt: null,
      createdBy: null,
      createdAt: new Date().toISOString(),
    });
  }
  getProject(projectId: string) {
    return {
      project: { id: projectId, name: "P" },
    };
  }
  getActiveRuleset(): unknown {
    return null;
  }
  incrementUsage(): void {}
}

function maskedClientFrame(json: unknown): Buffer {
  const payload = Buffer.from(JSON.stringify(json), "utf8");
  const mask = crypto.randomBytes(4);
  const masked = Buffer.allocUnsafe(payload.length);
  for (let i = 0; i < payload.length; i += 1) {
    masked[i] = (payload[i] ?? 0) ^ (mask[i % 4] ?? 0);
  }
  const header =
    payload.length < 126
      ? Buffer.from([0x81, 0x80 | payload.length])
      : Buffer.from([0x81, 0xfe, (payload.length >> 8) & 0xff, payload.length & 0xff]);
  return Buffer.concat([header, mask, masked]);
}

interface Client {
  socket: Socket;
  frames: Array<Record<string, unknown>>;
  handshake: Promise<string>;
  setAutoPong: (value: boolean) => void;
}

describe("WebSocket hardening helpers", () => {
  it("parses and matches the CORS origin allowlist", () => {
    const allowed = parseAllowedOrigins(" http://a.example/, https://b.example , ");
    expect([...allowed]).toEqual(["http://a.example", "https://b.example"]);
    expect(isOriginAllowed("http://A.EXAMPLE/", allowed)).toBe(true);
    expect(isOriginAllowed("https://evil.example", allowed)).toBe(false);
    expect(isOriginAllowed(undefined, allowed)).toBe(true); // native clients
    expect(isOriginAllowed("http://a.example", new Set())).toBe(false); // fail closed
  });

  it("rejects oversized frame declarations before allocating a payload", () => {
    // The inbound frame ceiling is hardened from 1 MiB to 64 KiB.
    expect(MAX_WS_FRAME_BYTES).toBe(65_536);
    // Declared 2 MiB, but only a 10-byte header is supplied.
    const header = Buffer.alloc(10);
    header[0] = 0x81;
    header[1] = 127;
    header.writeBigUInt64BE(2_097_152n, 2);
    expect(() => tryDecodeWsFrame(header)).toThrow(WsFrameTooLargeError);
    const closeFrame = encodeWsCloseFrame(1009, "Message too big");
    expect((closeFrame[0] ?? 0) & 0x0f).toBe(0x08);
  });
});

describe("live WS server", () => {
  let server: http.Server;
  let handle: WebSocketServerHandle;
  let port: number;

  beforeAll(async () => {
    const hub = new RealtimeGatewayHub({
      controlStore: new ControlStore(),
      dataStore: new DataPlaneStore(),
    });
    server = http.createServer((_req, res) => res.end("ok"));
    handle = attachRealtimeWebSocketServer(server, hub, {
      allowedOrigins: new Set([ALLOWED_ORIGIN]),
      authTimeoutMs: 150,
      heartbeatIntervalMs: 80,
      idleTimeoutMs: 120,
      maxConnectionsPerIp: 1,
      maxFrameBytes: 1024,
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    port = (server.address() as AddressInfo).port;
  });

  afterAll(async () => {
    handle.closeAllWebSockets();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  function connect(opts: { origin?: string; autoPong?: boolean } = {}): Client {
    const socket = net.connect(port, "127.0.0.1");
    const frames: Array<Record<string, unknown>> = [];
    let raw = Buffer.alloc(0);
    let handshakeDone = false;
    let resolveHandshake: (value: string) => void = () => {};
    let autoPong = opts.autoPong ?? false;
    const handshake = new Promise<string>((resolve) => {
      resolveHandshake = resolve;
    });
    socket.on("close", () => resolveHandshake(""));
    socket.on("error", () => resolveHandshake(""));
    socket.on("data", (chunk: Buffer) => {
      raw = Buffer.concat([raw, chunk]);
      if (!handshakeDone) {
        const end = raw.indexOf("\r\n\r\n");
        if (end === -1) return;
        const text = raw.subarray(0, end).toString("utf8");
        raw = raw.subarray(end + 4);
        handshakeDone = true;
        resolveHandshake(text);
      }
      while (raw.length >= 2) {
        let frame: ReturnType<typeof tryDecodeWsFrame>;
        try {
          frame = tryDecodeWsFrame(raw, 1024);
        } catch {
          break;
        }
        if (!frame) break;
        raw = raw.subarray(frame.totalFrameBytes);
        if (frame.opcode === 0x9 && autoPong && !socket.destroyed) {
          socket.write(encodeWsFrame(0x0a, frame.payload));
        }
        if (frame.opcode === 0x1) {
          try {
            frames.push(JSON.parse(frame.payload.toString("utf8")) as Record<string, unknown>);
          } catch {
            /* ignore non-JSON */
          }
        }
      }
    });

    const lines = [
      "GET /v1/realtime HTTP/1.1",
      `Host: 127.0.0.1:${port}`,
      "Upgrade: websocket",
      "Connection: Upgrade",
      `Sec-WebSocket-Key: ${crypto.randomBytes(16).toString("base64")}`,
      "Sec-WebSocket-Version: 13",
    ];
    if (opts.origin !== undefined) lines.push(`Origin: ${opts.origin}`);
    socket.write([...lines, "\r\n"].join("\r\n"));
    return { socket, frames, handshake, setAutoPong: (value: boolean) => { autoPong = value; } };
  }

  async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!predicate() && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    if (!predicate()) throw new Error("Timed out waiting for WS condition");
  }

  it("rejects a disallowed browser Origin", async () => {
    const client = connect({ origin: "https://evil.example" });
    try {
      expect(await client.handshake).toContain("403 Forbidden");
    } finally {
      client.socket.destroy();
    }
  });

  it("enforces the per-IP connection limit", async () => {
    const first = connect({ origin: ALLOWED_ORIGIN });
    expect(await first.handshake).toContain("101 Switching Protocols");
    const second = connect({ origin: ALLOWED_ORIGIN });
    try {
      expect(await second.handshake).toContain("429 Too Many Requests");
    } finally {
      first.socket.destroy();
      second.socket.destroy();
    }
    await new Promise((resolve) => setTimeout(resolve, 350)); // let auth/idle timers + IP counter drain
  });

  it("closes unauthenticated connections after the 5s-equivalent auth timeout", async () => {
    const client = connect({ origin: ALLOWED_ORIGIN });
    try {
      expect(await client.handshake).toContain("101 Switching Protocols");
      await waitFor(() => client.frames.some((f) => f["code"] === "UNAUTHENTICATED"));
      expect(client.frames[0]?.["type"]).toBe("error");
      await waitFor(() => client.socket.destroyed);
    } finally {
      client.socket.destroy();
    }
    await new Promise((resolve) => setTimeout(resolve, 350)); // allow server-side close + IP counter decrement
  });

  it("rejects oversized frames with 1009 before allocating the payload", async () => {
    const client = connect({ origin: ALLOWED_ORIGIN });
    try {
      expect(await client.handshake).toContain("101 Switching Protocols");
      const header = Buffer.alloc(10);
      header[0] = 0x81;
      header[1] = 255; // masked + 127 extended length
      header.writeBigUInt64BE(5_000n, 2); // > maxFrameBytes=1024
      header[2 + 8] = 0;
      client.socket.write(header);
      await waitFor(() => client.frames.some((f) => f["code"] === "PAYLOAD_TOO_LARGE"));
      await waitFor(() => client.socket.destroyed);
    } finally {
      client.socket.destroy();
    }
    await new Promise((resolve) => setTimeout(resolve, 350)); // allow server-side close + IP counter decrement
  });

  it("catches auth rejections (no unhandled promise rejections)", async () => {
    const unhandled: unknown[] = [];
    const listener = (reason: unknown) => unhandled.push(reason);
    process.on("unhandledRejection", listener);
    const client = connect({ origin: ALLOWED_ORIGIN });
    try {
      expect(await client.handshake).toContain("101 Switching Protocols");
      client.socket.write(maskedClientFrame({
        type: "auth", projectId: TENANT.projectId, apiKey: "pk_wrong_key_value_1234567890",
      }));
      await waitFor(() => client.frames.length > 0);
      expect(client.frames[0]?.["type"]).toBe("error");
      expect(unhandled).toHaveLength(0);
    } finally {
      process.off("unhandledRejection", listener);
      client.socket.destroy();
    }
    await new Promise((resolve) => setTimeout(resolve, 350)); // allow server-side close + IP counter decrement
  });

  it("keeps responsive connections alive via ping/pong and closes idle ones", async () => {
    const responsive = connect({ origin: ALLOWED_ORIGIN, autoPong: true });
    expect(await responsive.handshake).toContain("101 Switching Protocols");
    responsive.socket.write(maskedClientFrame({
      type: "auth", projectId: TENANT.projectId, apiKey: API_KEY,
    }));
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(responsive.socket.destroyed).toBe(false);
    responsive.setAutoPong(false);
    await waitFor(() => responsive.socket.destroyed, 2_000);
    responsive.socket.destroy();
    await new Promise((resolve) => setTimeout(resolve, 350)); // allow server-side close + IP counter decrement
  });
});
