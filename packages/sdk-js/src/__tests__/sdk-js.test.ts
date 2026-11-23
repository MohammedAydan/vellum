import { describe, it, expect } from "vitest";
import { createClient, fieldOp, computeReconnectBackoffMs } from "../index.js";

describe("@vellumdb/sdk-js - Field Operations", () => {
  it("generates correct atomic field transform payloads", () => {
    expect(fieldOp.serverTimestamp()).toEqual({ $op: "serverTimestamp" });
    expect(fieldOp.increment(5)).toEqual({ $op: "inc", by: 5 });
    expect(fieldOp.increment()).toEqual({ $op: "inc", by: 1 });
    expect(fieldOp.arrayUnion("a", "b")).toEqual({ $op: "arrayUnion", elements: ["a", "b"] });
    expect(fieldOp.arrayUnion(["x", "y"])).toEqual({ $op: "arrayUnion", elements: ["x", "y"] });
    expect(fieldOp.arrayRemove("c")).toEqual({ $op: "arrayRemove", elements: ["c"] });
    expect(fieldOp.deleteField()).toEqual({ $op: "deleteField" });
  });
});

describe("@vellumdb/sdk-js - Full-Jitter Reconnect Backoff", () => {
  it("scales with attempt number and respects maximum cap", () => {
    const fixedRandom = () => 1.0; // returns maximum jitter for deterministic testing
    const b0 = computeReconnectBackoffMs(0, 500, 30_000, fixedRandom);
    expect(b0).toBe(500);

    const b1 = computeReconnectBackoffMs(1, 500, 30_000, fixedRandom);
    expect(b1).toBe(1000);

    const b2 = computeReconnectBackoffMs(2, 500, 30_000, fixedRandom);
    expect(b2).toBe(2000);

    const bMax = computeReconnectBackoffMs(10, 500, 30_000, fixedRandom);
    expect(bMax).toBe(30_000);
  });
});

describe("@vellumdb/sdk-js - Client API", () => {
  it("throws if projectId or apiKey are missing", () => {
    expect(() => createClient({ projectId: "", apiKey: "k" })).toThrow("required");
    expect(() => createClient({ projectId: "p", apiKey: "" })).toThrow("required");
  });

  it("builds fluent requests and routes via customFetch", async () => {
    const calls: Array<{ url: string; method: string; body?: unknown }> = [];
    const mockFetch = (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({
        url: url.toString(),
        method: init?.method ?? "GET",
        body: init?.body ? JSON.parse(init.body as string) : undefined,
      });
      return new Response(
        JSON.stringify({
          documentId: "doc_1",
          path: "users/doc_1",
          version: 1,
          data: { name: "Alice" },
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    }) as unknown as typeof globalThis.fetch;

    const db = createClient({
      projectId: "proj_123",
      apiKey: "pk_test_123",
      customFetch: mockFetch,
    });

    // 1. Get
    const docRef = db.doc("users/doc_1");
    expect(docRef.id).toBe("doc_1");
    expect(docRef.path).toBe("users/doc_1");

    const snap = await docRef.get();
    expect(snap.id).toBe("doc_1");
    expect(snap.data()).toEqual({ name: "Alice" });
    expect(calls[0]?.url).toContain("/v1/projects/proj_123/documents/users/doc_1");
    expect(calls[0]?.method).toBe("GET");

    // 2. Set with merge
    await docRef.set({ name: "Alice Updated" }, { merge: true });
    expect(calls[1]?.method).toBe("PUT");
    expect(calls[1]?.body).toEqual({ data: { name: "Alice Updated" }, merge: true, ifVersion: null });
  });

  it("retries OCC transactions on ABORTED_CONFLICT", async () => {
    let attempt = 0;
    const mockFetch = (async (url: string | URL | Request, _init?: RequestInit) => {
      const urlStr = url.toString();
      if (urlStr.endsWith("/transactions:begin")) {
        return new Response(JSON.stringify({ transactionToken: `tok_${attempt}` }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (urlStr.includes("/documents/")) {
        return new Response(
          JSON.stringify({ documentId: "acc_1", path: "accounts/acc_1", version: 1, data: { balance: 100 } }),
          { status: 200, headers: { "content-type": "application/json" } }
        );
      }
      if (urlStr.endsWith("/transactions:commit")) {
        attempt++;
        if (attempt === 1) {
          return new Response(
            JSON.stringify({
              error: { code: "ABORTED_CONFLICT", message: "Concurrent modification" },
            }),
            { status: 409, headers: { "content-type": "application/json" } }
          );
        }
        return new Response(JSON.stringify({ results: [{ status: "ok" }] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response("{}", { status: 200 });
    }) as unknown as typeof globalThis.fetch;

    const db = createClient({
      projectId: "proj_123",
      apiKey: "pk_test_123",
      customFetch: mockFetch,
    });

    const txRes = await db.runTransaction(async (tx) => {
      const snap = await tx.get("accounts/acc_1");
      tx.set("accounts/acc_1", { balance: 200 });
      return snap.data();
    });

    expect(attempt).toBe(2);
    expect(txRes.result).toEqual({ balance: 100 });
  });
});

describe("@vellumdb/sdk-js - Realtime subscribe frames", () => {
  it("omits null spec members and opaque cursors from WS query subscriptions", async () => {
    const frames: Array<Record<string, unknown>> = [];
    const db = createClient({
      projectId: "proj_123",
      apiKey: "pk_test_123",
      realtimeHub: {
        createConnectionSession: () => ({
          handleClientFrame: (frame: unknown) => {
            frames.push(frame as Record<string, unknown>);
          },
          close: () => undefined,
        }),
      },
    });

    const unsubscribe = db
      .collection("users")
      .where("active", "==", true)
      .select("name")
      .startAfter("opaque-hmac-cursor")
      .onSnapshot(() => undefined);
    await new Promise((resolve) => setTimeout(resolve, 10));

    const subscribe = frames.find((f) => f["type"] === "subscribe");
    expect(subscribe).toBeDefined();
    const query = subscribe?.["query"] as Record<string, unknown>;
    expect(query["collectionPath"]).toBe("users");
    expect(query["select"]).toEqual(["name"]);
    expect(query["startAfter"]).toBeUndefined();
    expect(query["startAt"]).toBeUndefined();
    expect(Object.values(query).every((v) => v !== null)).toBe(true);
    unsubscribe();
  });
});
