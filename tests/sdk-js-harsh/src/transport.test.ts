import { afterAll, beforeAll, describe, expect, it } from "vitest";
import http from "node:http";
import { provision, uid, expectApiError, type Env } from "./harness.js";
import { HttpTransport } from "@vellumdb/sdk-js";

/**
 * Transport fault-injection suite: a programmable local proxy sits between the
 * SDK and the local API, injecting 5xx, 429+Retry-After, socket drops, delays
 * and malformed bodies while counting upstream hits.
 */

type Plan =
  | { kind: "forward" }
  | { kind: "status"; status: number; headers?: Record<string, string>; body?: string }
  | { kind: "drop" }
  | { kind: "lose-response" }
  | { kind: "delay"; ms: number };

const API_ORIGIN = `http://127.0.0.1:${process.env.API_PORT ?? 18080}`;

class FaultProxy {
  server: http.Server;
  plans: Plan[] = [];
  upstreamHits = 0;
  port = 0;
  constructor() {
    this.server = http.createServer((req, res) => this.handle(req, res));
  }
  async start(): Promise<void> {
    await new Promise<void>((resolve) => this.server.listen(0, "127.0.0.1", resolve));
    this.port = (this.server.address() as any).port;
  }
  stop(): void { this.server.closeAllConnections?.(); this.server.close(); }
  reset(plans: Plan[]): void { this.plans = [...plans]; this.upstreamHits = 0; }
  get url(): string { return `http://127.0.0.1:${this.port}`; }
  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const plan = this.plans.length > 0 ? this.plans.shift()! : { kind: "forward" as const };
    if (plan.kind === "drop") { req.socket.destroy(); return; }
    if (plan.kind === "delay") { await new Promise((r) => setTimeout(r, plan.ms)); }
    if (plan.kind === "status") {
      res.writeHead(plan.status, { "content-type": "application/json", ...(plan.headers ?? {}) });
      res.end(plan.body ?? JSON.stringify({ error: { code: "INJECTED", message: "fault injected" } }));
      return;
    }
    // forward / lose-response
    this.upstreamHits += 1;
    const chunks: Buffer[] = [];
    for await (const ch of req) chunks.push(ch as Buffer);
    let upstream: Response;
    try {
      upstream = await fetch(`${API_ORIGIN}${req.url}`, {
        method: req.method,
        headers: Object.fromEntries(
          Object.entries(req.headers).filter(([k]) => !["host", "content-length", "connection"].includes(k))
        ) as Record<string, string>,
        body: ["GET", "HEAD"].includes(req.method ?? "GET") ? undefined : Buffer.concat(chunks),
      } as any);
    } catch {
      if (!res.destroyed) { res.writeHead(502); res.end(); }
      return;
    }
    if (plan.kind === "lose-response") { res.socket?.destroy(); return; }
    const buf = Buffer.from(await upstream.arrayBuffer());
    const headers: Record<string, string> = {};
    // fetch() already decoded the body, so drop framing AND content-encoding:
    // forwarding the original gzip header with a decoded body corrupts clients.
    upstream.headers.forEach((v, k) => { if (!["content-length", "transfer-encoding", "connection", "content-encoding"].includes(k)) headers[k] = v; });
    res.writeHead(upstream.status, headers);
    res.end(buf);
  }
}

let env: Env; let proxy: FaultProxy; let c: string;
beforeAll(async () => {
  env = await provision("transport");
  proxy = new FaultProxy();
  await proxy.start();
  c = uid("t");
  // Seed some docs through a direct (non-proxied) client.
  const db = env.secret();
  for (let i = 0; i < 5; i++) await db.doc(`${c}/d${i}`).set({ i });
});
afterAll(() => { proxy.stop(); env.cleanup(); });

// The harness default is maxRetries: 0 (stress suites want raw behavior);
// this suite tests the retry machinery, so it opts back in.
const proxied = (cfg: any = {}) => env.secret({ endpoint: proxy.url, maxRetries: 3, retryBaseDelayMs: 50, retryMaxDelayMs: 400, ...cfg });

describe("transport fault injection", () => {
  it("retries idempotent GET on 503 and succeeds", async () => {
    proxy.reset([{ kind: "status", status: 503 }, { kind: "status", status: 500 }]);
    const r = await proxied().doc(`${c}/d1`).get();
    expect((r.data() as any).i).toBe(1);
  });

  it("honors Retry-After on 429 before retrying", async () => {
    proxy.reset([{ kind: "status", status: 429, headers: { "retry-after": "1" } }]);
    const t0 = Date.now();
    const r = await proxied().doc(`${c}/d2`).get();
    expect((r.data() as any).i).toBe(2);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(900);
  });

  it("surfaces 429 after retries are exhausted", async () => {
    proxy.reset([]);
    proxy.plans = Array.from({ length: 10 }, () => ({ kind: "status", status: 429 }));
    const err = await proxied({ maxRetries: 2 }).doc(`${c}/d2`).get().then(() => null, (e: any) => e);
    expect(err?.status).toBe(429);
  });

  it("NEVER retries a non-idempotent write (POST create) on 503", async () => {
    proxy.reset([{ kind: "status", status: 503 }, { kind: "status", status: 503 }]);
    const err = await proxied().doc(`${c}/w1`).create({ v: 1 }).then(() => null, (e: any) => e);
    expect(err?.status).toBe(503);
    // Both injected plans were consumed by the SDK? No: only one request may
    // have been made. A retry would have consumed the second plan and then hit
    // the upstream, which would have created the doc.
    await expectApiError(env.secret().doc(`${c}/w1`).get(), {});
  });

  it("retries idempotent GET after a socket drop", async () => {
    proxy.reset([{ kind: "drop" }]);
    const r = await proxied().doc(`${c}/d3`).get();
    expect((r.data() as any).i).toBe(3);
  });

  it("times out a hung response with REQUEST_TIMEOUT", async () => {
    proxy.reset([{ kind: "delay", ms: 2000 }]);
    const err = await proxied({ timeoutMs: 300, maxRetries: 0 }).doc(`${c}/d1`).get().then(() => null, (e: any) => e);
    expect(err?.code).toBe("REQUEST_TIMEOUT");
  });

  it("caller abort stops a pending request promptly", async () => {
    proxy.reset([{ kind: "delay", ms: 2000 }]);
    const ac = new AbortController();
    const t0 = Date.now();
    setTimeout(() => ac.abort(), 100);
    const err = await proxied({ timeoutMs: 10000, maxRetries: 0 }).doc(`${c}/d1`).get({ signal: ac.signal } as any).then(() => null, (e: any) => e);
    expect(err).toBeTruthy();
    expect(Date.now() - t0).toBeLessThan(1500);
  });

  it("malformed JSON in a 200 response throws instead of returning empty success", async () => {
    proxy.reset([{ kind: "status", status: 200, body: "this is not json{{{" }]);
    const err = await proxied({ maxRetries: 0 }).doc(`${c}/d1`).get().then(() => null, (e: any) => e);
    expect(err?.code).toBe("MALFORMED_RESPONSE");
  });

  it("idempotent replay: lost response + Idempotency-Key retries safely and creates exactly one doc", async () => {
    proxy.reset([{ kind: "lose-response" }]); // upstream processes it, response never arrives
    const t = new HttpTransport({
      projectId: env.projectId,
      apiKey: env.secretKey,
      endpoint: proxy.url,
      maxRetries: 2,
      retryBaseDelayMs: 50,
      retryMaxDelayMs: 200,
    });
    const key = `harsh-${uid("ik")}`;
    const res: any = await t.request("POST", `/documents/${encodeURIComponent(`${c}/idem1`).replaceAll("%2F", "/")}`, { data: { v: 42 } }, { "Idempotency-Key": key });
    expect(res).toBeTruthy();
    expect(proxy.upstreamHits).toBe(2); // retried after the lost response
    const got = await env.secret().doc(`${c}/idem1`).get();
    expect(got.exists).toBe(true);
    expect((got.data() as any).v).toBe(42);
    // A literal replay with the same key returns the recorded response, not a 409 conflict.
    const replay: any = await t.request("POST", `/documents/${encodeURIComponent(`${c}/idem1`).replaceAll("%2F", "/")}`, { data: { v: 42 } }, { "Idempotency-Key": key });
    expect(replay).toBeTruthy();
  });

  it("idempotencyKey option (Flutter parity): lost response on PUT set retries safely", async () => {
    proxy.reset([{ kind: "lose-response" }]);
    const key = `harsh-${uid("ik")}`;
    await proxied().doc(`${c}/ik1`).set({ v: 7 }, { idempotencyKey: key });
    expect(proxy.upstreamHits).toBe(2); // retried after the lost response, deduped server-side
    const got = await env.secret().doc(`${c}/ik1`).get();
    expect((got.data() as any).v).toBe(7);
  });

  it("dedupe: 20 parallel identical reads all succeed through a flaky proxy", async () => {
    // Only 3 injected faults (fewer than maxRetries+1 per request) so every
    // request recovers through retry; concurrent faulted requests must not
    // interfere with each other.
    proxy.reset(Array.from({ length: 3 }, () => ({ kind: "status", status: 503 })));
    const rs = await Promise.all(Array.from({ length: 20 }, () => proxied().doc(`${c}/d4`).get()));
    for (const r of rs) expect((r.data() as any).i).toBe(4);
  });
});
