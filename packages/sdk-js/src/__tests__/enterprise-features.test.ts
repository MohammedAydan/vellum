import { afterEach, describe, expect, it, vi } from "vitest";
import {
  BoundedReadCache,
  batchWriteChunked,
  createClient,
  type ConnectionState,
  type DocDataConverter,
  type DocumentSnapshot,
  type WebSocketLike,
} from "../index.js";

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

class MockSocket implements WebSocketLike {
  public readyState = 1;
  public onopen: ((event: unknown) => void) | null = null;
  public onmessage: ((event: { data: unknown }) => void) | null = null;
  public onerror: ((event: unknown) => void) | null = null;
  public onclose: ((event: { code?: number; reason?: unknown }) => void) | null = null;
  public readonly sent: string[] = [];

  public send(data: string): void {
    this.sent.push(data);
  }

  public close(code?: number, reason?: string): void {
    this.readyState = 3;
    this.onclose?.({
      ...(code !== undefined ? { code } : {}),
      ...(reason !== undefined ? { reason } : {}),
    });
  }

  public receive(frame: Record<string, unknown>): void {
    this.onmessage?.({ data: JSON.stringify(frame) });
  }
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("@vellumdb/sdk-js enterprise - streaming pagination (pages & stream)", () => {
  it("streams multi-page query results via cursors without duplicating documents", async () => {
    const receivedCursors: Array<string | null> = [];
    const mockFetch = (async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as { startAfter?: string | null; limit?: number };
      receivedCursors.push(body.startAfter ?? null);

      if (!body.startAfter) {
        return jsonResponse({
          documents: [
            { documentId: "d1", path: "items/d1", version: 1, data: { idx: 1 } },
            { documentId: "d2", path: "items/d2", version: 1, data: { idx: 2 } },
          ],
          nextCursor: "cur_2",
          meta: { page: 1 },
        });
      }
      if (body.startAfter === "cur_2") {
        return jsonResponse({
          documents: [
            { documentId: "d3", path: "items/d3", version: 1, data: { idx: 3 } },
            { documentId: "d4", path: "items/d4", version: 1, data: { idx: 4 } },
          ],
          nextCursor: "cur_4",
          meta: { page: 2 },
        });
      }
      return jsonResponse({
        documents: [{ documentId: "d5", path: "items/d5", version: 1, data: { idx: 5 } }],
        nextCursor: null,
        meta: { page: 3 },
      });
    }) as unknown as typeof globalThis.fetch;

    const db = createClient({
      projectId: "proj_1",
      apiKey: "pk_test",
      customFetch: mockFetch,
    });

    const ids: string[] = [];
    for await (const snap of db.collection<{ idx: number }>("items").limit(2).stream()) {
      ids.push(snap.id);
    }

    expect(ids).toEqual(["d1", "d2", "d3", "d4", "d5"]);
    expect(receivedCursors).toEqual([null, "cur_2", "cur_4"]);
  });

  it("enforces maxPages and maxDocs safety bounds and clamps page limits", async () => {
    const requestedLimits: number[] = [];
    let pageCounter = 0;
    const mockFetch = (async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as { limit: number };
      requestedLimits.push(body.limit);
      pageCounter += 1;
      const docs = Array.from({ length: body.limit }, (_, i) => ({
        documentId: `p${pageCounter}_d${i}`,
        path: `items/p${pageCounter}_d${i}`,
        version: 1,
        data: { page: pageCounter, i },
      }));
      return jsonResponse({
        documents: docs,
        nextCursor: `cur_${pageCounter}`,
        meta: {},
      });
    }) as unknown as typeof globalThis.fetch;

    const db = createClient({
      projectId: "proj_1",
      apiKey: "pk_test",
      customFetch: mockFetch,
    });

    // maxDocs = 5 with pageSize = 2 -> limits [2, 2, 1]
    const collected: string[] = [];
    for await (const doc of db.collection("items").stream({ pageSize: 2, maxDocs: 5 })) {
      collected.push(doc.id);
    }
    expect(collected).toHaveLength(5);
    expect(requestedLimits).toEqual([2, 2, 1]);

    // maxPages = 2 -> stops after 2 pages even though nextCursor is present
    const pages: number[] = [];
    for await (const page of db.collection("items").pages({ pageSize: 3, maxPages: 2 })) {
      pages.push(page.docs.length);
    }
    expect(pages).toEqual([3, 3]);
  });

  it("cancels streaming cleanly via AbortSignal", async () => {
    const controller = new AbortController();
    let calls = 0;
    const mockFetch = (async () => {
      calls += 1;
      return jsonResponse({
        documents: [{ documentId: `d${calls}`, path: `items/d${calls}`, version: 1, data: { n: calls } }],
        nextCursor: `cur_${calls}`,
        meta: {},
      });
    }) as unknown as typeof globalThis.fetch;

    const db = createClient({
      projectId: "proj_1",
      apiKey: "pk_test",
      customFetch: mockFetch,
    });

    const seen: string[] = [];
    await expect(async () => {
      for await (const doc of db.collection("items").stream({ pageSize: 1, signal: controller.signal })) {
        seen.push(doc.id);
        controller.abort("user cancelled");
      }
    }).rejects.toMatchObject({ code: "REQUEST_ABORTED" });

    expect(seen).toEqual(["d1"]);
    expect(calls).toBe(1);
  });
});

describe("@vellumdb/sdk-js enterprise - auto-chunked bulk writes", () => {
  it("chunks large write arrays with bounded concurrency and preserves result order", async () => {
    let inFlight = 0;
    let peakInFlight = 0;
    const chunkSizes: number[] = [];

    const mockFetch = (async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as { writes: Array<{ path: string; idx: number }> };
      inFlight += 1;
      peakInFlight = Math.max(peakInFlight, inFlight);
      chunkSizes.push(body.writes.length);
      // Slight stagger so later chunks could finish out of order if results weren't indexed
      await new Promise((resolve) => setTimeout(resolve, 10));
      inFlight -= 1;
      return jsonResponse({ committed: body.writes.length, firstIdx: body.writes[0]?.idx });
    }) as unknown as typeof globalThis.fetch;

    const db = createClient({
      projectId: "proj_1",
      apiKey: "pk_test",
      customFetch: mockFetch,
    });

    const ops = Array.from({ length: 125 }, (_, idx) => ({
      type: "set",
      path: `records/r_${idx}`,
      data: { idx },
      idx,
    }));

    const progressEvents: number[] = [];
    const result = await db.batchWriteChunked(ops, {
      chunkSize: 50,
      concurrency: 2,
      onProgress: (p) => progressEvents.push(p.completedOperations),
    });

    expect(result.totalOperations).toBe(125);
    expect(result.totalChunks).toBe(3);
    expect(chunkSizes).toEqual([50, 50, 25]);
    expect(peakInFlight).toBeLessThanOrEqual(2);
    expect(result.results).toEqual([
      { committed: 50, firstIdx: 0 },
      { committed: 50, firstIdx: 50 },
      { committed: 25, firstIdx: 100 },
    ]);
    expect(progressEvents).toHaveLength(3);
    expect(progressEvents[progressEvents.length - 1]).toBe(125);
  });

  it("defaults to the server limit of 100 operations and never exceeds it", async () => {
    const sizes: number[] = [];
    const executor = {
      batchWrite: async (writes: unknown[]) => {
        sizes.push(writes.length);
        return {};
      },
    };
    const ops = Array.from({ length: 250 }, (_, idx) => ({ type: "set", path: `r/${idx}`, data: { idx } }));
    await batchWriteChunked(executor, ops);
    expect(sizes).toEqual([100, 100, 50]);
    sizes.length = 0;
    await batchWriteChunked(executor, ops, { chunkSize: 500 });
    expect(sizes).toEqual([100, 100, 50]);
  });

  it("supports standalone batchWriteChunked helper and AbortSignal cancellation", async () => {
    const controller = new AbortController();
    let calls = 0;
    const executor = {
      batchWrite: async (writes: unknown[]) => {
        calls += 1;
        if (calls === 1) {
          controller.abort();
        }
        return { count: writes.length };
      },
    };

    const empty = await batchWriteChunked(executor, []);
    expect(empty).toEqual({ totalOperations: 0, totalChunks: 0, results: [] });

    const ops = Array.from({ length: 10 }, (_, i) => ({ path: `docs/d${i}` }));
    await expect(
      batchWriteChunked(executor, ops, { chunkSize: 2, concurrency: 1, signal: controller.signal })
    ).rejects.toMatchObject({ code: "REQUEST_ABORTED" });
    expect(calls).toBe(1);
  });
});

describe("@vellumdb/sdk-js enterprise - typed data converters (withConverter<T>)", () => {
  interface UserModel {
    id: string;
    fullName: string;
    createdAt: Date;
  }

  const userConverter: DocDataConverter<UserModel> = {
    toDoc(user: UserModel): Record<string, unknown> {
      return {
        full_name: user.fullName,
        created_at: user.createdAt.toISOString(),
      };
    },
    fromDoc(snap: DocumentSnapshot<Record<string, unknown>>): UserModel {
      const raw = snap.data();
      return {
        id: snap.id,
        fullName: String(raw["full_name"] ?? ""),
        createdAt: new Date(String(raw["created_at"] ?? "1970-01-01T00:00:00.000Z")),
      };
    },
  };

  it("converts writes via toDoc and reads/queries/streams via fromDoc end-to-end", async () => {
    const writtenBodies: unknown[] = [];
    const mockFetch = (async (url: string | URL | Request, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      const urlStr = String(url);
      if (method === "PUT") {
        writtenBodies.push(JSON.parse(String(init?.body ?? "{}")));
        return jsonResponse({ ok: true });
      }
      if (method === "GET" && urlStr.includes("/documents/users/u1")) {
        return jsonResponse({
          documentId: "u1",
          path: "users/u1",
          version: 2,
          data: { full_name: "Ada Lovelace", created_at: "2026-01-15T12:00:00.000Z" },
        });
      }
      if (method === "POST" && urlStr.endsWith("/query")) {
        return jsonResponse({
          documents: [
            {
              documentId: "u1",
              path: "users/u1",
              version: 2,
              data: { full_name: "Ada Lovelace", created_at: "2026-01-15T12:00:00.000Z" },
            },
          ],
          nextCursor: null,
          meta: {},
        });
      }
      return jsonResponse({});
    }) as unknown as typeof globalThis.fetch;

    const db = createClient({
      projectId: "proj_1",
      apiKey: "pk_test",
      customFetch: mockFetch,
    });

    const users = db.collection("users").withConverter(userConverter);
    const createdAt = new Date("2026-01-15T12:00:00.000Z");

    await users.doc("u1").set({ id: "u1", fullName: "Ada Lovelace", createdAt });
    expect(writtenBodies[0]).toMatchObject({
      data: {
        full_name: "Ada Lovelace",
        created_at: "2026-01-15T12:00:00.000Z",
      },
    });

    const snap = await users.doc("u1").get();
    const user = snap.data();
    expect(user.id).toBe("u1");
    expect(user.fullName).toBe("Ada Lovelace");
    expect(user.createdAt).toBeInstanceOf(Date);
    expect(user.createdAt.toISOString()).toBe("2026-01-15T12:00:00.000Z");

    const querySnap = await users.where("full_name", "==", "Ada Lovelace").get();
    expect(querySnap.docs[0]?.data().fullName).toBe("Ada Lovelace");
    expect(querySnap.docs[0]?.data().createdAt).toBeInstanceOf(Date);

    // Stripping converter with null returns raw document payload
    const rawSnap = await users.doc("u1").withConverter(null).get();
    expect(rawSnap.data()["full_name"]).toBe("Ada Lovelace");
  });
});

describe("@vellumdb/sdk-js enterprise - bounded LRU/TTL read cache & invalidation", () => {
  it("evicts least-recently-used entries and expires entries past TTL", () => {
    let now = 1_000;
    const cache = new BoundedReadCache<{ v: number }>({
      ttlMs: 500,
      maxEntries: 2,
      now: () => now,
    });

    cache.set("users/a\0", "users/a", { v: 1 });
    cache.set("users/b\0", "users/b", { v: 2 });
    // Access 'a' so 'b' becomes LRU
    expect(cache.get("users/a\0")).toEqual({ v: 1 });

    // Inserting 'c' evicts 'b'
    cache.set("users/c\0", "users/c", { v: 3 });
    expect(cache.get("users/b\0")).toBeUndefined();
    expect(cache.get("users/a\0")).toEqual({ v: 1 });
    expect(cache.get("users/c\0")).toEqual({ v: 3 });

    // Advance past TTL -> expired
    now += 600;
    expect(cache.get("users/a\0")).toBeUndefined();
    expect(cache.get("users/c\0")).toBeUndefined();
  });

  it("caches doc.get() with defensive clones and invalidates on writes, realtime mutations, and clearCache()", async () => {
    let version = 1;
    let getCalls = 0;
    const sockets: MockSocket[] = [];

    const mockFetch = (async (_url: string | URL | Request, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      if (method === "GET") {
        getCalls += 1;
        return jsonResponse({
          documentId: "u1",
          path: "users/u1",
          version,
          data: { nested: { score: version * 10 } },
        });
      }
      version += 1;
      return jsonResponse({ ok: true, version });
    }) as unknown as typeof globalThis.fetch;

    const db = createClient({
      projectId: "proj_1",
      apiKey: "pk_test",
      customFetch: mockFetch,
      cache: { enabled: true, ttlMs: 60_000, maxEntries: 100 },
      webSocketFactory: () => {
        const sock = new MockSocket();
        sockets.push(sock);
        return sock;
      },
    });

    const ref = db.doc<{ nested: { score: number } }>("users/u1");

    // 1st GET hits network
    const snap1 = await ref.get();
    expect(getCalls).toBe(1);
    expect(snap1.data().nested.score).toBe(10);

    // Mutate caller's clone; 2nd GET must hit cache and remain uncorrupted
    const d1 = snap1.data();
    d1.nested.score = 9999;
    const snap2 = await ref.get();
    expect(getCalls).toBe(1);
    expect(snap2.data().nested.score).toBe(10);

    // Local update invalidates cache
    await ref.update({ nested: { score: 20 } });
    const snap3 = await ref.get();
    expect(getCalls).toBe(2);
    expect(snap3.data().nested.score).toBe(20);

    // batchWrite invalidates cache for affected path
    await db.batchWrite([{ type: "set", path: "users/u1", data: { nested: { score: 30 } } }]);
    const snap4 = await ref.get();
    expect(getCalls).toBe(3);
    expect(snap4.data().nested.score).toBe(30);

    // Incoming realtime mutation invalidates cache
    const unsub = ref.onSnapshot(() => undefined);
    await Promise.resolve();
    const sock = sockets[0]!;
    sock.onopen?.({});
    await Promise.resolve();
    sock.receive({ type: "auth_ack" });
    const subFrame = sock.sent.map((s) => JSON.parse(s) as Record<string, unknown>).find((f) => f["type"] === "subscribe");
    const subId = String(subFrame?.["subId"] ?? "");

    version = 4;
    sock.receive({
      type: "mutation",
      subId,
      seqId: 10,
      operation: "update",
      document: { documentId: "u1", path: "users/u1", version: 4, data: { nested: { score: 40 } } },
    });

    const snap5 = await ref.get();
    expect(getCalls).toBe(4);
    expect(snap5.data().nested.score).toBe(40);
    unsub();

    // Manual clearCache forces refetch
    db.clearCache();
    await ref.get();
    expect(getCalls).toBe(5);
  });
});

describe("@vellumdb/sdk-js enterprise - single-flight in-flight read coalescing", () => {
  it("coalesces duplicate concurrent doc.get() calls into one HTTP GET with independent clones", async () => {
    let getCalls = 0;
    let releaseFetch!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseFetch = resolve;
    });

    const mockFetch = (async () => {
      getCalls += 1;
      await gate;
      return jsonResponse({
        documentId: "u1",
        path: "users/u1",
        version: 1,
        data: { profile: { name: "Grace", tags: ["admin"] } },
      });
    }) as unknown as typeof globalThis.fetch;

    const db = createClient({
      projectId: "proj_1",
      apiKey: "pk_test",
      customFetch: mockFetch,
      dedupeReads: true,
    });

    const ref = db.doc<{ profile: { name: string; tags: string[] } }>("users/u1");
    const p1 = ref.get();
    const p2 = ref.get();
    const p3 = ref.get();

    releaseFetch();
    const [s1, s2, s3] = await Promise.all([p1, p2, p3]);

    expect(getCalls).toBe(1);
    const d1 = s1.data();
    const d2 = s2.data();
    const d3 = s3.data();

    // Mutate caller 1's copy; callers 2 and 3 must receive untouched independent clones
    d1.profile.name = "MUTATED";
    d1.profile.tags.push("injected");
    expect(d2.profile.name).toBe("Grace");
    expect(d2.profile.tags).toEqual(["admin"]);
    expect(d3.profile.name).toBe("Grace");
  });
});

describe("@vellumdb/sdk-js enterprise - per-request AbortSignal composition", () => {
  it("aborts in-flight requests via caller AbortSignal without retrying and preserves timeoutMs", async () => {
    let fetchCalls = 0;
    const mockFetch = ((_url: string | URL | Request, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        fetchCalls += 1;
        init?.signal?.addEventListener("abort", () => {
          reject(new Error("aborted"));
        });
      })) as unknown as typeof globalThis.fetch;

    const db = createClient({
      projectId: "proj_1",
      apiKey: "pk_test",
      customFetch: mockFetch,
      timeoutMs: 5_000,
      maxRetries: 3,
      retryBaseDelayMs: 1,
    });

    // 1. Caller aborts mid-flight -> REQUEST_ABORTED, zero retries
    const controller = new AbortController();
    const pending = db.doc("users/u1").get({ signal: controller.signal });
    setTimeout(() => controller.abort(), 10);
    await expect(pending).rejects.toMatchObject({ code: "REQUEST_ABORTED" });
    expect(fetchCalls).toBe(1);

    // 2. Pre-aborted signal fails immediately without invoking fetch
    const preAborted = new AbortController();
    preAborted.abort();
    await expect(db.collection("users").count({ signal: preAborted.signal })).rejects.toMatchObject({
      code: "REQUEST_ABORTED",
    });
    expect(fetchCalls).toBe(1);
  });
});

describe("@vellumdb/sdk-js enterprise - realtime connection-state observability", () => {
  it("tracks disconnected -> connecting -> connected -> reconnecting -> connected -> disconnected", async () => {
    const sockets: MockSocket[] = [];
    const db = createClient({
      projectId: "proj_1",
      apiKey: "pk_test",
      webSocketFactory: () => {
        const sock = new MockSocket();
        sockets.push(sock);
        return sock;
      },
      realtimeTransportOptions: {
        randomFn: () => 0,
      },
    });

    expect(db.connectionState).toBe("disconnected");

    const transitions: Array<{ state: ConnectionState; prev: ConnectionState }> = [];
    const unsubState = db.onConnectionStateChange((state, prev) => {
      transitions.push({ state, prev });
    });

    // Throwing listener must never break other listeners
    db.onConnectionStateChange(() => {
      throw new Error("listener boom");
    });

    const unsubDoc = db.doc("users/u1").onSnapshot(() => undefined);
    await Promise.resolve();
    expect(db.connectionState).toBe("connecting");

    const sock1 = sockets[0]!;
    sock1.onopen?.({});
    await Promise.resolve();
    sock1.receive({ type: "auth_ack" });
    expect(db.connectionState).toBe("connected");

    // Simulate network drop -> reconnecting
    sock1.close(1006, "network drop");
    expect(db.connectionState).toBe("reconnecting");

    // Unsubscribing last listener closes transport -> disconnected
    unsubDoc();
    expect(db.connectionState).toBe("disconnected");

    expect(transitions).toEqual([
      { state: "connecting", prev: "disconnected" },
      { state: "connected", prev: "connecting" },
      { state: "reconnecting", prev: "connected" },
      { state: "disconnected", prev: "reconnecting" },
    ]);

    // Unsubscribe stops further callbacks
    unsubState();
    const beforeCount = transitions.length;
    const unsub2 = db.doc("users/u2").onSnapshot(() => undefined);
    await Promise.resolve();
    unsub2();
    expect(transitions.length).toBe(beforeCount);

    db.dispose?.();
  });
});
