import { afterEach, describe, expect, it } from "vitest";
import { createClient, RealtimeTransport, type WebSocketLike } from "../index.js";

describe("network failures are typed", () => {
  it("wraps a raw 'Failed to fetch' TypeError in a NETWORK_ERROR with status 0", async () => {
    const db = createClient({
      projectId: "p", apiKey: "pk_t", maxRetries: 0,
      customFetch: (async () => { throw new TypeError("Failed to fetch"); }) as unknown as typeof fetch,
    } as never);
    const err = (await db.doc("a/b").set({ x: 1 }).catch((e: unknown) => e)) as Error & { code: string; status: number; details: { reason: string } };
    expect(err.code).toBe("NETWORK_ERROR");
    expect(err.status).toBe(0);
    expect(err.details.reason).toBe("Failed to fetch");
    expect(err.message).toContain("offline");
  });

  it("does not turn a caller abort into a network error", async () => {
    const ctl = new AbortController();
    const db = createClient({
      projectId: "p", apiKey: "pk_t", maxRetries: 0,
      customFetch: (async (_u: string, init: RequestInit) => new Promise((_r, rej) => {
        init.signal?.addEventListener("abort", () => rej(Object.assign(new Error("aborted"), { name: "AbortError" })));
      })) as unknown as typeof fetch,
    } as never);
    const p = db.doc("a/b").get({ signal: ctl.signal } as never).catch((e: unknown) => e);
    ctl.abort();
    const err = (await p) as { code?: string };
    expect(err.code).not.toBe("NETWORK_ERROR");
  });
});

class AckSocket implements WebSocketLike {
  public readyState = 1;
  public onopen: ((e: unknown) => void) | null = null;
  public onmessage: ((e: { data: unknown }) => void) | null = null;
  public onerror: ((e: unknown) => void) | null = null;
  public onclose: ((e: { code?: number; reason?: unknown }) => void) | null = null;
  public closed = false;
  send(data: string): void {
    const f = JSON.parse(data) as { type: string };
    if (f.type === "auth") setTimeout(() => this.onmessage?.({ data: JSON.stringify({ type: "auth_ack", status: "authenticated", connectionId: "c" }) }), 0);
  }
  close(): void { this.closed = true; }
}

describe("realtime follows the browser's online/offline events", () => {
  const listeners = new Map<string, Set<() => void>>();
  const g = globalThis as unknown as Record<string, unknown>;
  g["addEventListener"] = (t: string, l: () => void) => { (listeners.get(t) ?? listeners.set(t, new Set()).get(t)!).add(l); };
  g["removeEventListener"] = (t: string, l: () => void) => { listeners.get(t)?.delete(l); };
  const fire = (t: string) => { for (const l of [...(listeners.get(t) ?? [])]) l(); };
  afterEach(() => listeners.clear());

  it("flips to reconnecting on offline and reconnects right away on online", async () => {
    const sockets: AckSocket[] = [];
    const states: string[] = [];
    const t = new RealtimeTransport({
      url: "ws://x/v1/realtime",
      auth: () => ({ projectId: "p", apiKey: "k" }),
      onFrame: () => {},
      onStateChange: (s) => states.push(s),
      webSocketFactory: () => { const s = new AckSocket(); sockets.push(s); setTimeout(() => s.onopen?.({}), 0); return s; },
    });
    await t.connect();
    expect(t.state).toBe("authenticated");
    fire("offline");
    expect(t.state).toBe("reconnecting");
    expect(sockets[0]!.closed).toBe(true);
    fire("online");
    await new Promise((r) => setTimeout(r, 30));
    expect(t.state).toBe("authenticated");
    expect(sockets).toHaveLength(2);
    t.close();
    expect(listeners.get("offline")?.size ?? 0).toBe(0);
  });
});
