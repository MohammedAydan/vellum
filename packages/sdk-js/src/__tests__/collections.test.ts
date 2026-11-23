import { describe, it, expect } from "vitest";
import { createClient } from "../index.js";
import type { CollectionInfo } from "../index.js";

type CapturedCall = { url: string; method: string; body?: unknown };

type MockResponse = { status?: number; payload: unknown };

/** Minimal mock-fetch harness matching the style of sdk-js.test.ts. */
function mockFetch(respond: (url: string, method: string, body: unknown) => MockResponse) {
  const calls: CapturedCall[] = [];
  const fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const urlStr = url.toString();
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(init.body as string) : undefined;
    calls.push({ url: urlStr, method, body });
    const { status = 200, payload } = respond(urlStr, method, body);
    return new Response(JSON.stringify(payload), {
      status,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof globalThis.fetch;
  return { fetch, calls };
}

function client(fetch: typeof globalThis.fetch) {
  return createClient({ projectId: "proj_123", apiKey: "pk_test_123", customFetch: fetch });
}

const COLLECTION: CollectionInfo = {
  id: "col_1",
  name: "users",
  description: "User records",
  defaultTtlSeconds: 3600,
  schemaValidation: { requiredFields: ["email"], strict: true },
  documentCount: 12,
  storageBytes: 4096,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-02T00:00:00.000Z",
  lastDocumentAt: "2026-01-03T00:00:00.000Z",
  isSystem: false,
  metadata: { owner: "team" },
};

describe("@vellumdb/sdk-js - Collections lifecycle", () => {
  it("listCollections maps stats and builds the query string", async () => {
    const { fetch, calls } = mockFetch(() => ({ payload: { collections: [COLLECTION], nextCursor: "cur_1" } }));
    const db = client(fetch);

    const result = await db.listCollections({ search: "user", limit: 10, cursor: "prev" });

    expect(result.collections).toHaveLength(1);
    expect(result.collections[0]?.name).toBe("users");
    expect(result.collections[0]?.documentCount).toBe(12);
    expect(result.collections[0]?.storageBytes).toBe(4096);
    expect(result.collections[0]?.schemaValidation).toEqual({ requiredFields: ["email"], strict: true });
    expect(result.nextCursor).toBe("cur_1");
    expect(calls[0]?.method).toBe("GET");
    expect(calls[0]?.url).toContain("/v1/projects/proj_123/collections?");
    expect(calls[0]?.url).toContain("search=user");
    expect(calls[0]?.url).toContain("limit=10");
    expect(calls[0]?.url).toContain("cursor=prev");
  });

  it("listCollections tolerates the legacy string[] shape", async () => {
    const { fetch } = mockFetch(() => ({ payload: { collections: ["users", "orders"], nextCursor: null } }));
    const db = client(fetch);

    const result = await db.listCollections();

    expect(result.collections).toHaveLength(2);
    expect(result.collections[0]).toMatchObject({
      id: "users",
      name: "users",
      documentCount: 0,
      storageBytes: 0,
      lastDocumentAt: null,
    });
    expect(result.collections[1]?.name).toBe("orders");
    expect(result.nextCursor).toBeNull();
  });

  it("createCollection sends a POST body with the name and options", async () => {
    const { fetch, calls } = mockFetch(() => ({ payload: COLLECTION }));
    const db = client(fetch);

    const created = await db.createCollection("users", {
      description: "User records",
      defaultTtlSeconds: 3600,
      ifNotExists: true,
    });

    expect(created.name).toBe("users");
    expect(calls[0]?.method).toBe("POST");
    expect(calls[0]?.url).toContain("/collections");
    expect(calls[0]?.body).toEqual({
      name: "users",
      description: "User records",
      defaultTtlSeconds: 3600,
      ifNotExists: true,
    });
  });

  it("getCollectionInfo maps a single collection and returns null on 404", async () => {
    let notFound = false;
    const { fetch, calls } = mockFetch(() =>
      notFound
        ? { status: 404, payload: { error: { code: "NOT_FOUND", message: "missing" } } }
        : { payload: COLLECTION }
    );
    const db = client(fetch);

    const found = await db.getCollectionInfo("users");
    expect(found?.documentCount).toBe(12);
    expect(found?.lastDocumentAt).toBe("2026-01-03T00:00:00.000Z");
    expect(calls[0]?.method).toBe("GET");
    expect(calls[0]?.url).toContain("/collections/users");

    notFound = true;
    const missing = await db.getCollectionInfo("users");
    expect(missing).toBeNull();
  });

  it("updateCollection sends a PATCH with the supplied patch", async () => {
    const { fetch, calls } = mockFetch(() => ({ payload: { ...COLLECTION, description: "Updated" } }));
    const db = client(fetch);

    const updated = await db.updateCollection("users", { description: "Updated", defaultTtlSeconds: null });

    expect(updated.description).toBe("Updated");
    expect(calls[0]?.method).toBe("PATCH");
    expect(calls[0]?.url).toContain("/collections/users");
    expect(calls[0]?.body).toEqual({ description: "Updated", defaultTtlSeconds: null });
  });

  it("clearCollection returns the delete counts and uses the /clear suffix", async () => {
    const { fetch, calls } = mockFetch(() => ({ payload: { deletedCount: 7, freedBytes: 2048 } }));
    const db = client(fetch);

    const result = await db.clearCollection("users");

    expect(result).toEqual({ deletedCount: 7, freedBytes: 2048 });
    expect(calls[0]?.method).toBe("POST");
    expect(calls[0]?.url).toContain("/collections/users/clear");
  });

  it("deleteCollection returns the drop summary and uses DELETE", async () => {
    const { fetch, calls } = mockFetch(() => ({
      payload: { deletedCollection: true, deletedDocuments: 9, freedBytes: 4096 },
    }));
    const db = client(fetch);

    const result = await db.deleteCollection("users");

    expect(result).toEqual({ deletedCollection: true, deletedDocuments: 9, freedBytes: 4096 });
    expect(calls[0]?.method).toBe("DELETE");
    expect(calls[0]?.url).toContain("/collections/users");
  });

  it("importDocuments forwards documents and mode in the POST body", async () => {
    const { fetch, calls } = mockFetch(() => ({
      payload: { importedCount: 2, skippedCount: 1, errors: [{ index: 1, message: "duplicate id" }] },
    }));
    const db = client(fetch);
    const docs = [
      { id: "u1", data: { name: "Alice" } },
      { data: { name: "Bob" } },
    ];

    const result = await db.importDocuments("users", docs, { mode: "insert_only" });

    expect(result.importedCount).toBe(2);
    expect(result.skippedCount).toBe(1);
    expect(result.errors[0]?.message).toBe("duplicate id");
    expect(calls[0]?.method).toBe("POST");
    expect(calls[0]?.url).toContain("/collections/users/import");
    expect(calls[0]?.body).toEqual({ documents: docs, mode: "insert_only" });
  });

  it("exportDocuments passes query params and maps returned documents", async () => {
    const { fetch, calls } = mockFetch(() => ({
      payload: {
        documents: [
          {
            id: "u1",
            path: "users/u1",
            data: { name: "Alice" },
            version: 3,
            createdAt: "2026-01-01T00:00:00.000Z",
            updatedAt: "2026-01-02T00:00:00.000Z",
          },
        ],
        nextCursor: "next_1",
      },
    }));
    const db = client(fetch);

    const result = await db.exportDocuments("users", { limit: 100, cursor: "prev" });

    expect(result.documents).toHaveLength(1);
    expect(result.documents[0]?.id).toBe("u1");
    expect(result.documents[0]?.data).toEqual({ name: "Alice" });
    expect(result.documents[0]?.version).toBe(3);
    expect(result.nextCursor).toBe("next_1");
    expect(calls[0]?.method).toBe("GET");
    expect(calls[0]?.url).toContain("/collections/users/export?");
    expect(calls[0]?.url).toContain("limit=100");
    expect(calls[0]?.url).toContain("cursor=prev");
  });

  it("CollectionReference convenience methods delegate to the client methods", async () => {
    const { fetch, calls } = mockFetch((url, method) => {
      if (url.endsWith("/collections") && method === "POST") {
        return { payload: COLLECTION };
      }
      if (url.endsWith("/collections/users") && method === "GET") {
        return { payload: COLLECTION };
      }
      if (url.endsWith("/collections/users/clear")) {
        return { payload: { deletedCount: 4, freedBytes: 128 } };
      }
      return { payload: { deletedCollection: true, deletedDocuments: 4, freedBytes: 128 } };
    });
    const db = client(fetch);
    const ref = db.collection("users");

    const created = await ref.create({ description: "from ref" });
    const info = await ref.info();
    const cleared = await ref.clear();
    const dropped = await ref.drop();

    expect(created.name).toBe("users");
    expect(info?.name).toBe("users");
    expect(cleared.deletedCount).toBe(4);
    expect(dropped.deletedCollection).toBe(true);
    expect(calls).toHaveLength(4);
    expect(calls.map((c) => c.method)).toEqual(["POST", "GET", "POST", "DELETE"]);
    expect(calls[0]?.body).toMatchObject({ name: "users", description: "from ref" });
    expect(calls.map((c) => c.url.split("/v1/projects/proj_123")[1])).toEqual([
      "/collections",
      "/collections/users",
      "/collections/users/clear",
      "/collections/users",
    ]);
  });

  it("encodes the collection name segment", async () => {
    const { fetch, calls } = mockFetch(() => ({
      status: 404,
      payload: { error: { code: "NOT_FOUND", message: "missing" } },
    }));
    const db = client(fetch);

    expect(await db.getCollectionInfo("a b")).toBeNull();
    expect(calls[0]?.url).toContain("/collections/a%20b");
  });
});
