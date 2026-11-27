import { describe, expect, it } from "vitest";
import { createClient } from "../index.js";
import type { StoredWriteOp } from "../offline/outbox.js";

interface SeenRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

function headerBag(init?: RequestInit): Record<string, string> {
  const out: Record<string, string> = {};
  const h = (init?.headers ?? {}) as Record<string, string>;
  for (const [k, v] of Object.entries(h)) out[k.toLowerCase()] = String(v);
  return out;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("persistent write outbox (offlineWrites)", () => {
  it("queues a write that cannot reach the server and replays it in order with the same Idempotency-Key", async () => {
    const seen: SeenRequest[] = [];
    let online = false;
    const fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      const method = String(init?.method ?? "GET").toUpperCase();
      const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
      const headers = headerBag(init);
      if (!online && method !== "GET") throw new TypeError("fetch failed");
      seen.push({ url: String(url), method, headers, body });
      return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json" } });
    }) as unknown as typeof globalThis.fetch;

    const db = createClient({
      projectId: "p",
      apiKey: "pk_t",
      customFetch: fetch,
      maxRetries: 0,
      offlineWrites: { storage: "memory", flushIntervalMs: 500 },
    });

    const err = (await db.doc("users/u1").set({ n: 1 }).catch((e: unknown) => e)) as {
      code: string;
      queued: boolean;
      outboxId: string;
    };
    expect(err.code).toBe("OFFLINE_QUEUED");
    expect(err.queued).toBe(true);
    expect(typeof err.outboxId).toBe("string");
    expect(await db.offlineWriteQueueSize()).toBe(1);

    await db.doc("users/u2").set({ n: 2 }).catch(() => undefined);
    expect(await db.offlineWriteQueueSize()).toBe(2);

    online = true;
    await sleep(800); // flush timer fires; ordered replay
    expect(await db.offlineWriteQueueSize()).toBe(0);

    const writes = seen.filter((r) => r.method !== "GET");
    expect(writes).toHaveLength(2);
    expect(writes[0]!.url).toContain("users/u1");
    expect(writes[1]!.url).toContain("users/u2");
    // The replay carries the op's stable Idempotency-Key.
    expect(writes[0]!.headers["idempotency-key"]).toBe(err.outboxId);
    db.dispose();
  });

  it("does not queue caller-aborted or permanent 4xx failures", async () => {
    const fetch = (async () =>
      new Response(JSON.stringify({ error: { code: "INVALID_ARGUMENT", message: "bad" } }), {
        status: 400,
        headers: { "content-type": "application/json" },
      })) as unknown as typeof globalThis.fetch;
    const db = createClient({
      projectId: "p",
      apiKey: "pk_t",
      customFetch: fetch,
      maxRetries: 0,
      offlineWrites: { storage: "memory" },
    });
    const err = (await db.doc("users/u1").set({ n: 1 }).catch((e: unknown) => e)) as { code: string; queued?: boolean };
    expect(err.code).toBe("INVALID_ARGUMENT");
    expect(err.queued).toBeUndefined();
    expect(await db.offlineWriteQueueSize()).toBe(0);
    db.dispose();
  });

  it("dead-letters a permanently rejected op and keeps flushing the rest", async () => {
    const dead: Array<{ op: StoredWriteOp; code: string | undefined }> = [];
    let online = false;
    const seen: string[] = [];
    const fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      if (!online) throw new TypeError("fetch failed");
      const u = String(url);
      seen.push(u);
      if (u.includes("users/bad")) {
        return new Response(JSON.stringify({ error: { code: "PERMISSION_DENIED", message: "no" } }), {
          status: 403,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json" } });
    }) as unknown as typeof globalThis.fetch;

    const db = createClient({
      projectId: "p",
      apiKey: "pk_t",
      customFetch: fetch,
      maxRetries: 0,
      offlineWrites: {
        storage: "memory",
        flushIntervalMs: 500,
        onDeadLetter: (op, error) => dead.push({ op, code: (error as { code?: string }).code }),
      },
    });

    await db.doc("users/bad").set({ n: 1 }).catch(() => undefined);
    await db.doc("users/good").set({ n: 2 }).catch(() => undefined);
    expect(await db.offlineWriteQueueSize()).toBe(2);

    online = true;
    await sleep(800);
    expect(dead).toHaveLength(1);
    expect(dead[0]!.code).toBe("PERMISSION_DENIED");
    expect(dead[0]!.op.relativePath).toContain("users/bad");
    expect(await db.offlineWriteQueueSize()).toBe(0);
    expect(seen.some((u) => u.includes("users/good"))).toBe(true);
    db.dispose();
  });
});
