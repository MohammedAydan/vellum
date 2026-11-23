/**
 * @vellum/api - Cloudflare Workers runtime adapter.
 *
 * Runs the exact same Hono app and RealtimeGatewayHub as Node/Vercel. Cloudflare
 * exposes `WebSocketPair` directly in the Worker runtime, so realtime is served
 * without a separate socket server and without Redis: the durable PostgreSQL
 * outbox remains the cross-instance source of truth.
 */

import { createEdgePlatform, type EdgeBindings } from "./edge-platform.js";
import { isOriginAllowed, parseAllowedOrigins } from "../ws-rfc6455.js";

/** Minimal structural type for the Worker-side `WebSocket` returned by `WebSocketPair`. */
interface WorkerWebSocket {
  accept(): void;
  send(message: string): void;
  close(code?: number, reason?: string): void;
  addEventListener(type: "message", listener: (event: { data: string | ArrayBuffer }) => void): void;
  addEventListener(type: "close", listener: () => void): void;
}

interface WorkerWebSocketPair {
  0: WorkerWebSocket;
  1: WorkerWebSocket;
}

interface WorkerWebSocketPairConstructor {
  new (): WorkerWebSocketPair;
}

interface WorkerExecutionContext {
  waitUntil(promise: Promise<unknown>): void;
}

type EdgePlatform = ReturnType<typeof createEdgePlatform>;

/** One platform per Worker isolate (bounded by the isolate lifetime). */
let cached: { env: EdgeBindings; platform: EdgePlatform } | null = null;

function getPlatform(env: EdgeBindings): EdgePlatform {
  if (cached?.env === env) return cached.platform;
  const platform = createEdgePlatform(env);
  cached = { env, platform };
  return platform;
}

function webSocketPair(): WorkerWebSocketPair {
  const ctor = (globalThis as unknown as { WebSocketPair?: WorkerWebSocketPairConstructor })
    .WebSocketPair;
  if (typeof ctor !== "function") {
    throw new Error("Cloudflare Workers require the global WebSocketPair API");
  }
  return new ctor();
}

/** Handle a `/v1/realtime` upgrade with the shared hub and a Worker WebSocketPair. */
export function handleWorkerRealtimeUpgrade(
  request: Request,
  env: EdgeBindings,
  platform: EdgePlatform
): Response {
  const origin = request.headers.get("Origin") ?? undefined;
  if (!isOriginAllowed(origin, parseAllowedOrigins(env.CORS_ALLOWED_ORIGINS ?? ""))) {
    return new Response("Forbidden", { status: 403 });
  }

  const pair = webSocketPair();
  const client = pair[0];
  const server = pair[1];
  server.accept();

  const session = platform.realtimeHub.createConnectionSession((frame) => {
    try {
      server.send(JSON.stringify(frame));
    } catch {
      session.close();
    }
  });

  server.addEventListener("message", (event) => {
    const text =
      typeof event.data === "string" ? event.data : new TextDecoder().decode(event.data);
    void Promise.resolve()
      .then(() => session.handleClientFrame(JSON.parse(text) as unknown))
      .catch(() => session.close());
  });
  server.addEventListener("close", () => session.close());

  // Workers require status 101 for an upgrade. Node's global Response rejects
  // 101, so local/unit execution uses 200 while still exposing the webSocket
  // handle; deployment always runs in the Worker branch.
  const isNode =
    typeof process !== "undefined" && typeof process.versions?.node === "string";
  return new Response(null, {
    status: isNode ? 200 : 101,
    webSocket: client,
  } as unknown as ResponseInit);
}

/** Cloudflare Worker default export: REST via Hono, WS via WebSocketPair. */
export default {
  async fetch(request: Request, env: EdgeBindings, _ctx: WorkerExecutionContext): Promise<Response> {
    const platform = getPlatform(env);
    const url = new URL(request.url);
    if (
      url.pathname === "/v1/realtime" &&
      request.headers.get("Upgrade")?.toLowerCase() === "websocket"
    ) {
      return handleWorkerRealtimeUpgrade(request, env, platform);
    }
    return platform.fetch(request);
  },
};
