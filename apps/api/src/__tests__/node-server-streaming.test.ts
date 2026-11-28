import { afterEach, describe, expect, it } from "vitest";
import { startNodeApiServer } from "../node-server.js";

/**
 * Regression: the standalone Node transport must STREAM response bodies.
 * It used to `Buffer.from(await webRes.arrayBuffer())` every response, so a
 * long-lived stream such as POST /v1/realtime/stream never flushed: the
 * client saw zero bytes (not even `: stream-open`) until the stream ended,
 * i.e. SSE realtime was dead on the Docker/self-hosted image while the
 * Vercel fetch handler was unaffected.
 *
 * This test runs against a REAL listening server (ephemeral port, actual
 * HTTP round trip), not an in-process fetch of the app.
 */

function streamingPlatform() {
  return {
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    controlStore: {},
    realtimeHub: {
      // attachRealtimeWebSocketServer only touches the hub on upgrade events.
    },
    async runMaintenanceWorkers() {},
    metering: { async stop() {} },
    async flushIndexRecommendations() {},
    async fetch(_req: Request): Promise<Response> {
      const encoder = new TextEncoder();
      const stream = new ReadableStream<Uint8Array>({
        async start(controller) {
          controller.enqueue(encoder.encode(": stream-open\n\n"));
          // Hold the stream open; the second chunk lands later.
          await new Promise((resolve) => setTimeout(resolve, 300));
          controller.enqueue(encoder.encode(": keep-alive\n\n"));
          controller.close();
        },
      });
      return new Response(stream, {
        status: 200,
        headers: { "Content-Type": "text/event-stream" },
      });
    },
  };
}

describe("node-server streaming transport", () => {
  let stop: (() => Promise<void>) | undefined;
  afterEach(async () => {
    if (stop) await stop();
    stop = undefined;
  });

  it("flushes the first bytes of a long-lived stream before the body completes", async () => {
    const started = await startNodeApiServer({
      port: 0,
      platform: streamingPlatform() as never,
      workerIntervalMs: 3_600_000,
    });
    stop = started.stop;
    const port = started.port;
    expect(port).toBeGreaterThan(0);

    const res = await fetch(`http://127.0.0.1:${port}/v1/realtime/stream`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ frames: [{ type: "auth" }] }),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");

    const reader = res.body!.getReader();
    const t0 = performance.now();
    const first = await reader.read();
    const firstByteMs = performance.now() - t0;
    expect(first.done).toBe(false);
    expect(new TextDecoder().decode(first.value)).toContain("stream-open");
    // The body completes after ~300ms; the old buffering transport delivered
    // the first byte only at completion. Leave generous headroom for CI.
    expect(firstByteMs).toBeLessThan(250);

    let rest = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      rest += new TextDecoder().decode(value);
    }
    expect(rest).toContain("keep-alive");
  }, 15_000);

  it("still delivers ordinary JSON responses correctly", async () => {
    const platform = streamingPlatform();
    platform.fetch = async () =>
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    const started = await startNodeApiServer({
      port: 0,
      platform: platform as never,
      workerIntervalMs: 3_600_000,
    });
    stop = started.stop;
    const res = await fetch(`http://127.0.0.1:${started.port}/v1/health`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  }, 15_000);
});
