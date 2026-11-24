/**
 * Realtime over Server-Sent Events.
 *
 * Hosts, proxies and runtimes that cannot use WebSocket still need realtime. `POST /v1/realtime/stream` carries the same
 * protocol frames over a single streaming HTTP response:
 *
 *  - The request body is `{ "frames": [auth, subscribe, ...] }` (the same
 *    frames the WebSocket accepts). Being stateless, any instance can serve it.
 *  - The response is `text/event-stream`. Every server frame is one `data:`
 *    line of JSON. Frames that carry a `seqId` also set the SSE `id:` field.
 *  - To change subscriptions or resume, the client opens a new stream with the
 *    last seen `seqId` as `resumeSeqId`; the hub replays the missed events.
 *  - The server ends each stream after a bounded lifetime with an
 *    `event: reconnect` message so the client reconnects before the platform
 *    kills the function.
 */

import { Hono } from "hono";
import { VellumError } from "@vellum/core";
import type { ServerFrame } from "@vellum/api-contract";
import type { RealtimeGatewayHub } from "@vellum/realtime";

export const SSE_MAX_FRAMES_PER_REQUEST = 64;
/**
 * Streams end after 55 s (override: REALTIME_SSE_MAX_LIFETIME_MS) so they finish before common
 * serverless function limits; clients renew seamlessly with resume.
 */
export const SSE_DEFAULT_MAX_LIFETIME_MS = 55_000;
export const SSE_DEFAULT_KEEPALIVE_MS = 15_000;

export interface RealtimeSseOptions {
  maxLifetimeMs?: number;
  keepAliveMs?: number;
}

/** Serializes one server frame as an SSE message. */
export function encodeSseFrame(frame: ServerFrame): string {
  const seq = (frame as { seqId?: unknown }).seqId;
  const idLine = typeof seq === "number" || typeof seq === "string" ? `id: ${String(seq)}\n` : "";
  return `${idLine}data: ${JSON.stringify(frame)}\n\n`;
}

export function createRealtimeSseRoutes(
  platform: { realtimeHub: RealtimeGatewayHub },
  options: RealtimeSseOptions = {}
): Hono {
  const routes = new Hono();
  const envLifetime = Number(process.env["REALTIME_SSE_MAX_LIFETIME_MS"]);
  const maxLifetimeMs =
    options.maxLifetimeMs ??
    (Number.isFinite(envLifetime) && envLifetime >= 5_000 ? envLifetime : SSE_DEFAULT_MAX_LIFETIME_MS);
  const keepAliveMs = options.keepAliveMs ?? SSE_DEFAULT_KEEPALIVE_MS;

  routes.post("/realtime/stream", async (c) => {
    const body = (await c.req.json().catch(() => null)) as { frames?: unknown } | null;
    const frames = body?.frames;
    if (!Array.isArray(frames) || frames.length === 0) {
      throw new VellumError("INVALID_ARGUMENT", "Request body must be { frames: [...] } with at least an auth frame");
    }
    if (frames.length > SSE_MAX_FRAMES_PER_REQUEST) {
      throw new VellumError("INVALID_ARGUMENT", `At most ${SSE_MAX_FRAMES_PER_REQUEST} frames per stream request`);
    }
    const first = frames[0] as { type?: unknown } | null;
    if (!first || first.type !== "auth") {
      throw new VellumError("UNAUTHENTICATED", "The first frame must be an 'auth' frame");
    }

    const encoder = new TextEncoder();
    const hub = platform.realtimeHub;
    let cleanup: () => void = () => {};

    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        let closed = false;
        const write = (text: string): void => {
          if (closed) return;
          try {
            controller.enqueue(encoder.encode(text));
          } catch {
            finish();
          }
        };
        const session = hub.createConnectionSession((frame) => write(encodeSseFrame(frame)));
        const keepAlive = setInterval(() => write(`: keep-alive ${Date.now()}\n\n`), keepAliveMs);
        const lifetime = setTimeout(() => {
          write("event: reconnect\ndata: {}\n\n");
          finish();
        }, maxLifetimeMs);
        keepAlive.unref?.();
        lifetime.unref?.();

        function finish(): void {
          if (closed) return;
          closed = true;
          clearInterval(keepAlive);
          clearTimeout(lifetime);
          session.close();
          try {
            controller.close();
          } catch {
            // already closed
          }
        }
        cleanup = finish;
        c.req.raw.signal.addEventListener("abort", finish, { once: true });

        write(": stream-open\n\n");
        for (let i = 0; i < frames.length; i++) {
          try {
            await session.handleClientFrame(frames[i]);
          } catch (err: unknown) {
            const error = err as { code?: string; message?: string };
            const subId = (frames[i] as { subId?: unknown } | null)?.subId;
            write(
              encodeSseFrame({
                type: "error",
                ...(typeof subId === "string" ? { subId } : {}),
                code: (error.code ?? "INVALID_ARGUMENT") as never,
                message: error.message ?? "Frame handling failed",
              })
            );
            // A failed auth frame ends the stream: nothing else can succeed.
            if (i === 0) {
              finish();
              return;
            }
          }
        }
      },
      cancel() {
        cleanup();
      },
    });

    return new Response(stream, {
      status: 200,
      headers: {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
      },
    });
  });

  return routes;
}
