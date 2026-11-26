/**
 * apps/api/src/ws-rfc6455.ts
 * Native RFC 6455 WebSocket Protocol Upgrade & Frame Codec for Node.js HTTP Server.
 * Allows standard WebSocket clients to connect directly to `ws://<host>/v1/realtime`.
 *
 * Production hardening:
 *  - Strict origin allowlist from CORS_ALLOWED_ORIGINS (never `*` or `null`).
 *  - Global connection cap, per-IP connection cap, and per-tenant (projectId) cap.
 *  - 64 KiB hard cap on frames/payloads, enforced BEFORE any buffer allocation.
 *  - RFC 6455 §5.5 control frame max 125-byte cap & safe JSON prototype-pollution guard.
 *  - 5 s auth timeout, 30 s ping/pong heartbeat + idle timeout cleanup.
 *  - 60 messages/minute/socket rolling window with 1008 policy-close.
 *  - Real socket backpressure via `socket.bufferedAmount` / `socket.writableLength`.
 *  - Graceful 1001 Going Away close frames on shutdown.
 */

import crypto from "node:crypto";
import type http from "node:http";
import type { Socket } from "node:net";
import { SYSTEM_LIMITS } from "@vellum/core";
import type { RealtimeGatewayHub } from "@vellum/realtime";
import { getConfig } from "./config.js";
import { assertSafeJsonStructure, normalizeStrictOrigin } from "./middleware/security.js";

const WS_MAGIC_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

/** Hard cap for a single inbound WS frame/payload (contract §5). */
export const MAX_WS_FRAME_BYTES = 65_536;
/** RFC 6455 §5.5: control frames MUST have payload length <= 125 bytes. */
const MAX_WS_CONTROL_FRAME_BYTES = 125;
/** Rolling-window ceiling on client messages per socket (contract §5). */
export const MAX_WS_MESSAGES_PER_MINUTE = 60;
const MESSAGE_WINDOW_MS = 60_000;
export const DEFAULT_AUTH_TIMEOUT_MS = 5_000;
export const DEFAULT_HEARTBEAT_INTERVAL_MS = 30_000;
export const DEFAULT_IDLE_TIMEOUT_MS = 30_000;
export const DEFAULT_MAX_CONNECTIONS_PER_IP = 50;
export const DEFAULT_MAX_GLOBAL_CONNECTIONS = 10_000;
export const DEFAULT_MAX_CONNECTIONS_PER_TENANT = 1_000;

export class WsFrameTooLargeError extends Error {
  constructor(public readonly declaredBytes: number) {
    super(`WebSocket frame declares ${declaredBytes} bytes; maximum is ${MAX_WS_FRAME_BYTES}`);
    this.name = "WsFrameTooLargeError";
  }
}

export interface RealtimeWebSocketServerOptions {
  /** Parsed once from getConfig().CORS_ALLOWED_ORIGINS by default. */
  allowedOrigins?: Set<string>;
  authTimeoutMs?: number;
  heartbeatIntervalMs?: number;
  idleTimeoutMs?: number;
  maxConnectionsPerIp?: number;
  maxGlobalConnections?: number;
  maxConnectionsPerTenant?: number;
  maxFrameBytes?: number;
  /**
   * Close each connection with 1001 after this many ms (plus up to 10% jitter) so serverless hosts with a
   * function duration limit never cut a live socket. Clients reconnect and resume from their watermark.
   * 0 or undefined disables it.
   */
  maxLifetimeMs?: number;
  /**
   * Origins that are not in the deployment-wide allowlist may still connect when an active API key of
   * the project named in the auth frame lists them. The handshake cannot know the project, so such a
   * socket is accepted provisionally and closed (1008) unless its auth frame passes this check.
   * Leave unset to keep the strict handshake-time allowlist only.
   */
  isProjectOriginAllowed?: (projectId: string, origin: string) => Promise<boolean>;
  /** Called when a socket exceeds the rolling per-socket message-rate ceiling. */
  onPolicyViolation?: (ip: string, reason: string) => void;
}

export interface WebSocketServerHandle {
  closeAllWebSockets: () => void;
  getConnectionStats?: () => {
    total: number;
    uniqueIps: number;
    uniqueTenants: number;
  };
}

/** Parse the comma-separated CORS origin allowlist into normalized strict origins. */
export function parseAllowedOrigins(raw: string): Set<string> {
  const result = new Set<string>();
  for (const value of raw.split(",")) {
    const normalized = normalizeStrictOrigin(value);
    if (normalized) result.add(normalized);
  }
  return result;
}

/**
 * A missing Origin is accepted for native/non-browser clients (browsers always
 * send it for WebSocket handshakes, so browser-origin CSRF is still blocked).
 * A present Origin must exactly match the allowlist; `*` and `null` are always
 * rejected and an empty allowlist fails closed for browser clients.
 */
export function isOriginAllowed(
  origin: string | undefined,
  allowedOrigins: Set<string>
): boolean {
  if (origin === undefined) return true;
  const normalized = normalizeStrictOrigin(origin);
  if (!normalized) return false;
  return allowedOrigins.has(normalized);
}

/** Node `net.Socket` has no `bufferedAmount`; use it when a transport provides
 * one and fall back to the real kernel-side writable queue length. */
export function getBufferedAmount(socket: Socket): number {
  const extended = socket as Socket & { bufferedAmount?: unknown };
  const value = extended.bufferedAmount;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  return socket.writableLength;
}

export function attachRealtimeWebSocketServer(
  httpServer: http.Server,
  realtimeHub: RealtimeGatewayHub,
  options: RealtimeWebSocketServerOptions = {}
): WebSocketServerHandle {
  const allowedOrigins = options.allowedOrigins ?? parseAllowedOrigins(getConfig().CORS_ALLOWED_ORIGINS);
  const authTimeoutMs = options.authTimeoutMs ?? DEFAULT_AUTH_TIMEOUT_MS;
  const heartbeatIntervalMs = options.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS;
  const idleTimeoutMs = options.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
  const maxConnectionsPerIp = options.maxConnectionsPerIp ?? DEFAULT_MAX_CONNECTIONS_PER_IP;
  const maxGlobalConnections = options.maxGlobalConnections ?? DEFAULT_MAX_GLOBAL_CONNECTIONS;
  const maxConnectionsPerTenant = options.maxConnectionsPerTenant ?? DEFAULT_MAX_CONNECTIONS_PER_TENANT;
  const maxFrameBytes = options.maxFrameBytes ?? MAX_WS_FRAME_BYTES;
  const maxLifetimeMs = options.maxLifetimeMs ?? 0;

  const activeSockets = new Set<Socket>();
  const connections = new Map<Socket, { cleanup: () => void; closeGracefully: () => void }>();
  const connectionsByIp = new Map<string, number>();
  const connectionsByTenant = new Map<string, number>();

  httpServer.on("upgrade", (req: http.IncomingMessage, socket: Socket, head: Buffer) => {
    let url: URL;
    try {
      url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    } catch {
      socket.write("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }

    if (url.pathname !== "/v1/realtime") {
      socket.write("HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }

    const originHeader = req.headers.origin;
    const origin = Array.isArray(originHeader) ? originHeader[0] : originHeader;
    // A browser origin outside the global allowlist is held "pending" until the auth frame names a
    // project whose active keys list it (see isProjectOriginAllowed). No origin is trusted before that.
    let pendingOrigin: string | null = null;
    if (!isOriginAllowed(origin, allowedOrigins)) {
      const strict = origin === undefined ? null : normalizeStrictOrigin(origin);
      if (options.isProjectOriginAllowed && strict) {
        pendingOrigin = strict;
      } else {
        socket.write("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
        socket.destroy();
        return;
      }
    }

    const secKey = req.headers["sec-websocket-key"];
    const secVersion = req.headers["sec-websocket-version"];
    if (
      !secKey ||
      typeof secKey !== "string" ||
      Buffer.from(secKey, "base64").length !== 16 ||
      (secVersion !== undefined && secVersion !== "13")
    ) {
      socket.write("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }

    // Enforce global connection cap before accepting the socket.
    if (activeSockets.size >= maxGlobalConnections) {
      socket.write("HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }

    const clientIp = req.socket.remoteAddress ?? "unknown";
    const ipCount = connectionsByIp.get(clientIp) ?? 0;
    if (ipCount >= maxConnectionsPerIp) {
      socket.write("HTTP/1.1 429 Too Many Requests\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }
    connectionsByIp.set(clientIp, ipCount + 1);

    activeSockets.add(socket);

    const acceptKey = crypto
      .createHash("sha1")
      .update(secKey + WS_MAGIC_GUID)
      .digest("base64");

    socket.write(
      [
        "HTTP/1.1 101 Switching Protocols",
        "Upgrade: websocket",
        "Connection: Upgrade",
        `Sec-WebSocket-Accept: ${acceptKey}`,
        "\r\n",
      ].join("\r\n")
    );

    let authenticated = false;
    let boundTenantId: string | null = null;
    let closed = false;
    let cleaned = false;
    let lastActivityAt = Date.now();
    let lastPingAt = Date.now();
    let awaitingPong = false;
    let buffer = Buffer.alloc(0);
    // Rolling 60 s window of inbound text-frame arrivals for this socket only.
    const messageTimestamps: number[] = [];

    const writeDirect = (text: string): void => {
      if (closed || socket.destroyed) return;
      socket.write(encodeWsTextFrame(text));
    };

    const sendError = (code: string, message: string): void => {
      writeDirect(
        JSON.stringify({ type: "error", subId: "connection", code, message })
      );
    };

    const closeWith = (code: number, reason: string): void => {
      if (closed) return;
      closed = true;
      if (!socket.destroyed) {
        try {
          socket.end(encodeWsCloseFrame(code, reason));
        } catch {
          socket.destroy();
        }
        setTimeout(() => {
          if (!socket.destroyed) socket.destroy();
        }, 100).unref();
      }
    };

    const claimTenantSlot = (tenantId: string): boolean => {
      if (boundTenantId === tenantId) return true;
      if (boundTenantId !== null) {
        const prev = connectionsByTenant.get(boundTenantId) ?? 0;
        if (prev <= 1) connectionsByTenant.delete(boundTenantId);
        else connectionsByTenant.set(boundTenantId, prev - 1);
        boundTenantId = null;
      }
      const current = connectionsByTenant.get(tenantId) ?? 0;
      if (current >= maxConnectionsPerTenant) {
        return false;
      }
      connectionsByTenant.set(tenantId, current + 1);
      boundTenantId = tenantId;
      return true;
    };

    const cleanup = (): void => {
      if (cleaned) return;
      cleaned = true;
      closed = true;
      clearTimeout(authTimer);
      clearInterval(heartbeatTimer);
      if (lifetimeTimer) clearTimeout(lifetimeTimer);
      activeSockets.delete(socket);
      connections.delete(socket);
      const remainingIp = connectionsByIp.get(clientIp) ?? 0;
      if (remainingIp <= 1) connectionsByIp.delete(clientIp);
      else connectionsByIp.set(clientIp, remainingIp - 1);
      if (boundTenantId !== null) {
        const remainingTenant = connectionsByTenant.get(boundTenantId) ?? 0;
        if (remainingTenant <= 1) connectionsByTenant.delete(boundTenantId);
        else connectionsByTenant.set(boundTenantId, remainingTenant - 1);
        boundTenantId = null;
      }
      session.close();
    };

    const session = realtimeHub.createConnectionSession((serverFrame) => {
      if (closed || socket.destroyed) return;
      const encoded = encodeWsTextFrame(JSON.stringify(serverFrame));
      // Real backpressure: never queue more than the locked outbound cap.
      if (getBufferedAmount(socket) + encoded.length > SYSTEM_LIMITS.MAX_WS_OUTBOUND_BUFFER_BYTES) {
        writeDirect(
          JSON.stringify({
            type: "error",
            code: "SLOW_CONSUMER_DISCONNECT",
            message: `Outbound buffered bytes exceeded maximum ${SYSTEM_LIMITS.MAX_WS_OUTBOUND_BUFFER_BYTES} bytes`,
          })
        );
        closeWith(1008, "Slow consumer");
        return;
      }
      socket.write(encoded);
      // The hub may reject a frame through its own buffer accounting. Keep the
      // transport contract: a slow consumer is always terminated after the error.
      if (serverFrame.type === "error" && serverFrame.code === "SLOW_CONSUMER_DISCONNECT") {
        closeWith(1008, "Slow consumer");
      }
    });

    const authTimer = setTimeout(() => {
      if (authenticated || closed) return;
      sendError("UNAUTHENTICATED", "Authentication timeout");
      closeWith(1008, "Authentication timeout");
    }, authTimeoutMs);
    authTimer.unref();

    const heartbeatTimer = setInterval(() => {
      if (closed || socket.destroyed) return;
      const now = Date.now();
      if (awaitingPong) {
        // One ping is outstanding; the peer must answer within the idle window.
        if (now - lastPingAt >= idleTimeoutMs) closeWith(1000, "Idle timeout");
        return;
      }
      if (now - lastActivityAt >= heartbeatIntervalMs) {
        // Check outbound buffer before queuing a ping on a stalled socket.
        if (getBufferedAmount(socket) > SYSTEM_LIMITS.MAX_WS_OUTBOUND_BUFFER_BYTES) {
          closeWith(1008, "Slow consumer");
          return;
        }
        socket.write(encodeWsFrame(0x09, Buffer.from(String(now), "utf8")));
        awaitingPong = true;
        lastPingAt = now;
      }
    }, heartbeatIntervalMs);
    heartbeatTimer.unref();
    const lifetimeTimer =
      maxLifetimeMs > 0
        ? setTimeout(() => closeWith(1001, "Reconnect"), maxLifetimeMs + Math.floor(Math.random() * maxLifetimeMs * 0.1))
        : null;
    lifetimeTimer?.unref();

    connections.set(socket, {
      cleanup,
      closeGracefully: () => closeWith(1001, "Server shutting down"),
    });

    const rejectOversizedFrame = (): void => {
      sendError("PAYLOAD_TOO_LARGE", `WebSocket frame exceeds ${maxFrameBytes} bytes`);
      closeWith(1009, "Message too big");
    };

    const handleFrame = async (frame: unknown): Promise<void> => {
      try {
        if (pendingOrigin !== null) {
          const projectForOrigin = isAuthFrame(frame) ? extractTenantId(frame) : null;
          const allowedForProject =
            projectForOrigin !== null && (await options.isProjectOriginAllowed!(projectForOrigin, pendingOrigin).catch(() => false));
          if (!allowedForProject) {
            sendError("PERMISSION_DENIED", "Origin is not allowed for this project");
            closeWith(1008, "Origin not allowed");
            return;
          }
          pendingOrigin = null;
        }
        if (isAuthFrame(frame)) {
          const tenantId = extractTenantId(frame);
          if (tenantId && !claimTenantSlot(tenantId)) {
            sendError(
              "RATE_LIMITED",
              `Tenant WebSocket connection limit (${maxConnectionsPerTenant}) exceeded`
            );
            closeWith(1008, "Tenant connection limit exceeded");
            options.onPolicyViolation?.(clientIp, "WS_TENANT_CONNECTION_LIMIT");
            return;
          }
        }
        await session.handleClientFrame(frame);
        if (!authenticated && isAuthFrame(frame)) {
          authenticated = true;
          clearTimeout(authTimer);
        }
      } catch (err: unknown) {
        const error = err as { code?: string; message?: string };
        sendError(error.code ?? "INVALID_ARGUMENT", error.message ?? "Frame handling failed");
      }
    };

    const processIncomingChunk = (chunk: Buffer): void => {
      if (closed) return;
      lastActivityAt = Date.now();
      awaitingPong = false;

      // Enforce the cap BEFORE Buffer.concat or any payload allocation.
      if (chunk.length > maxFrameBytes || buffer.length + chunk.length > maxFrameBytes) {
        rejectOversizedFrame();
        return;
      }
      buffer = Buffer.concat([buffer, chunk]);

      while (buffer.length >= 2) {
        let decoded: ReturnType<typeof tryDecodeWsFrame>;
        try {
          decoded = tryDecodeWsFrame(buffer, maxFrameBytes);
        } catch (err: unknown) {
          if (err instanceof WsFrameTooLargeError) {
            rejectOversizedFrame();
            return;
          }
          sendError("INVALID_ARGUMENT", "Malformed WebSocket frame");
          closeWith(1002, "Protocol error");
          return;
        }
        if (!decoded) break;
        buffer = buffer.subarray(decoded.totalFrameBytes);

        // RFC 6455 §5.5: control frames (opcode >= 0x8) MUST NOT exceed 125 bytes.
        if (decoded.opcode >= 0x8 && decoded.payload.length > MAX_WS_CONTROL_FRAME_BYTES) {
          closeWith(1002, "Control frame too large");
          return;
        }

        if (decoded.opcode === 0x8) {
          session.close();
          closeWith(1000, "Client closed");
          return;
        }
        if (decoded.opcode === 0x9) {
          if (getBufferedAmount(socket) <= SYSTEM_LIMITS.MAX_WS_OUTBOUND_BUFFER_BYTES) {
            socket.write(encodeWsFrame(0x0a, decoded.payload));
          }
          continue;
        }
        if (decoded.opcode === 0xa) {
          awaitingPong = false;
          lastActivityAt = Date.now();
          continue;
        }
        if (decoded.opcode !== 0x1) continue;

        // Enforce the per-socket message-rate ceiling before parsing/handling
        // the frame so a flood cannot reach the realtime hub.
        const now = Date.now();
        while (
          messageTimestamps.length > 0 &&
          (messageTimestamps[0] ?? 0) <= now - MESSAGE_WINDOW_MS
        ) {
          messageTimestamps.shift();
        }
        messageTimestamps.push(now);
        if (messageTimestamps.length > MAX_WS_MESSAGES_PER_MINUTE) {
          sendError(
            "WS_POLICY_VIOLATION",
            `WebSocket message rate exceeds ${MAX_WS_MESSAGES_PER_MINUTE} messages per minute`
          );
          closeWith(1008, "WS_POLICY_VIOLATION");
          options.onPolicyViolation?.(clientIp, "WS_MESSAGE_RATE_EXCEEDED");
          socket.destroy();
          return;
        }

        let clientFrame: unknown;
        try {
          let forbiddenKey: string | null = null;
          clientFrame = JSON.parse(decoded.payload.toString("utf8"), (key, val: unknown) => {
            if (key === "__proto__" || key === "constructor" || key === "prototype") {
              forbiddenKey = key;
            }
            return val;
          }) as unknown;
          if (forbiddenKey !== null) {
            sendError("INVALID_ARGUMENT", "Forbidden key in frame payload");
            continue;
          }
          const safety = assertSafeJsonStructure(clientFrame);
          if (!safety.ok) {
            sendError("INVALID_ARGUMENT", safety.message);
            continue;
          }
        } catch {
          sendError("INVALID_ARGUMENT", "Invalid frame payload");
          continue;
        }
        // Deliberately not awaited: every rejection is handled inside handleFrame.
        void handleFrame(clientFrame);
      }
    };

    if (head && head.length > 0) processIncomingChunk(head);

    socket.on("data", (dataChunk: Buffer) => processIncomingChunk(dataChunk));
    socket.on("close", cleanup);
    socket.on("error", cleanup);
  });

  return {
    closeAllWebSockets(): void {
      for (const entry of [...connections.values()]) {
        entry.closeGracefully();
        entry.cleanup();
      }
      for (const sock of activeSockets) sock.destroy();
      activeSockets.clear();
      connectionsByIp.clear();
      connectionsByTenant.clear();
    },
    getConnectionStats() {
      return {
        total: activeSockets.size,
        uniqueIps: connectionsByIp.size,
        uniqueTenants: connectionsByTenant.size,
      };
    },
  };
}

function isAuthFrame(frame: unknown): boolean {
  return (
    typeof frame === "object" &&
    frame !== null &&
    (frame as { type?: unknown }).type === "auth"
  );
}

function extractTenantId(frame: unknown): string | null {
  if (typeof frame !== "object" || frame === null) return null;
  const record = frame as Record<string, unknown>;
  const candidate = record["projectId"] ?? record["tenantId"];
  if (typeof candidate === "string" && candidate.trim().length > 0) {
    return candidate.trim();
  }
  return null;
}

export function encodeWsTextFrame(text: string): Buffer {
  return encodeWsFrame(0x01, Buffer.from(text, "utf8"));
}

/** RFC 6455 close frame: 2-byte status code followed by an optional reason. */
export function encodeWsCloseFrame(code: number, reason = ""): Buffer {
  const reasonBytes = Buffer.from(reason, "utf8");
  const payload = Buffer.allocUnsafe(2 + reasonBytes.length);
  payload.writeUInt16BE(code, 0);
  reasonBytes.copy(payload, 2);
  return encodeWsFrame(0x08, payload);
}

export function encodeWsFrame(opcode: number, payloadBuf: Buffer): Buffer {
  const len = payloadBuf.length;
  let header: Buffer;
  if (len < 126) {
    header = Buffer.allocUnsafe(2);
    header[0] = 0x80 | opcode;
    header[1] = len;
  } else if (len < 65536) {
    header = Buffer.allocUnsafe(4);
    header[0] = 0x80 | opcode;
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.allocUnsafe(10);
    header[0] = 0x80 | opcode;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  return Buffer.concat([header, payloadBuf]);
}

export function tryDecodeWsFrame(
  buf: Buffer,
  maxPayloadBytes: number = MAX_WS_FRAME_BYTES
): { opcode: number; payload: Buffer; totalFrameBytes: number } | null {
  if (buf.length < 2) return null;
  const firstByte = buf[0];
  const secondByte = buf[1];
  if (firstByte === undefined || secondByte === undefined) return null;

  const opcode = firstByte & 0x0f;
  const isMasked = (secondByte & 0x80) !== 0;
  let payloadLen = secondByte & 0x7f;
  let offset = 2;

  if (payloadLen === 126) {
    if (buf.length < 4) return null;
    payloadLen = buf.readUInt16BE(2);
    offset = 4;
  } else if (payloadLen === 127) {
    if (buf.length < 10) return null;
    payloadLen = Number(buf.readBigUInt64BE(2));
    offset = 10;
  }

  // Reject oversized frames before allocating the payload buffer.
  if (!Number.isSafeInteger(payloadLen) || payloadLen < 0 || payloadLen > maxPayloadBytes) {
    throw new WsFrameTooLargeError(payloadLen);
  }

  const maskKeyLen = isMasked ? 4 : 0;
  const totalFrameBytes = offset + maskKeyLen + payloadLen;
  if (buf.length < totalFrameBytes) return null;

  const payload = Buffer.from(buf.subarray(offset + maskKeyLen, totalFrameBytes));
  if (isMasked) {
    const maskKey = buf.subarray(offset, offset + 4);
    for (let i = 0; i < payload.length; i++) {
      const keyByte = maskKey[i % 4];
      const payloadByte = payload[i];
      if (keyByte !== undefined && payloadByte !== undefined) {
        payload[i] = payloadByte ^ keyByte;
      }
    }
  }

  return { opcode, payload, totalFrameBytes };
}
