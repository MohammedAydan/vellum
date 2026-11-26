/**
 * V2 SDK surface tests (contract §6.2 / §6.5 and the index advisor brief).
 *
 * All HTTP is intercepted by a `customFetch` that returns real `Response`
 * objects, including the `x-vellum-index-*` headers the advisor reads.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { createClient } from "../index.js";
import type { IndexSuggestionEvent } from "../index.js";

interface Call {
  url: string;
  method: string;
  body: unknown;
  headers: Record<string, string>;
}

interface ResponseSpec {
  body: unknown;
  status?: number;
  headers?: Record<string, string>;
}

type Handler = (url: string, init: RequestInit | undefined) => ResponseSpec;

interface AdvisorOptions {
  warnOnMissingIndexes?: boolean;
  onIndexSuggestion?: (event: IndexSuggestionEvent) => void;
}

const apiKey = "pk_SUPER_SECRET_DO_NOT_LOG_123";
const projectId = "proj_v2";
const okDoc = { documentId: "d1", path: "users/d1", version: 1, data: { name: "Ada" } };
const okQuery = { documents: [], nextCursor: null, meta: {} };
const okAggregate = { rows: [{ count: 42 }], executionTimeMs: 3 };

function bodyOf(calls: Call[], index: number): Record<string, unknown> {
  const body = calls[index]?.body;
  if (body !== null && typeof body === "object" && !Array.isArray(body)) {
    return body as Record<string, unknown>;
  }
  return {};
}

function makeClient(handler: Handler, advisor: AdvisorOptions = {}): { db: ReturnType<typeof createClient>; calls: Call[] } {
  const calls: Call[] = [];
  const customFetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = input.toString();
    const headers: Record<string, string> = {};
    if (init?.headers) {
      for (const [key, value] of Object.entries(init.headers as Record<string, string>)) {
        headers[key] = value;
      }
    }
    calls.push({
      url,
      method: init?.method ?? "GET",
      body: typeof init?.body === "string" ? (JSON.parse(init.body) as unknown) : undefined,
      headers,
    });
    const spec = handler(url, init);
    return new Response(JSON.stringify(spec.body), {
      status: spec.status ?? 200,
      headers: { "content-type": "application/json", ...(spec.headers ?? {}) },
    });
  }) as unknown as typeof globalThis.fetch;

  const db = createClient({
    projectId,
    apiKey,
    customFetch,
    ...advisor,
  });
  return { db, calls };
}

const defaultHandler: Handler = (url) => {
  if (url.includes("/documents:aggregate")) return { body: okAggregate };
  if (url.includes("/documents:bulk-delete")) return { body: { deletedCount: 3 } };
  if (url.includes("/query")) return { body: okQuery };
  return { body: okDoc };
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe("@vellumdb/sdk-js V2 - QueryBuilder relations and filters", () => {
  it("serializes shorthand include entries as { field }", async () => {
    const { db, calls } = makeClient(defaultHandler);
    await db.collection("orders").include(["authorId"]).get();
    expect(bodyOf(calls, 0)["include"]).toEqual([{ field: "authorId" }]);
  });

  it("serializes detailed include entries including nested relations", async () => {
    const { db, calls } = makeClient(defaultHandler);
    await db
      .collection("orders")
      .include([
        {
          field: "authorId",
          collection: "users",
          as: "author",
          select: ["name", "profile.avatar"],
          include: ["orgId", { field: "teamId", as: "team" }],
        },
      ])
      .get();
    expect(bodyOf(calls, 0)["include"]).toEqual([
      {
        field: "authorId",
        collection: "users",
        as: "author",
        select: ["name", "profile.avatar"],
        include: [{ field: "orgId" }, { field: "teamId", as: "team" }],
      },
    ]);
  });

  it("keeps the builder immutable across include/or/where", () => {
    const base = dbBase();
    const withInclude = base.include(["authorId"]);
    const withOr = base.or([[{ field: "status", op: "==", value: "open" }]]);
    expect(base.toQuerySpec()).not.toHaveProperty("include");
    expect(base.toQuerySpec()).not.toHaveProperty("or");
    expect(withInclude.toQuerySpec()["include"]).toEqual([{ field: "authorId" }]);
    expect(withOr.toQuerySpec()["or"]).toEqual([[{ field: "status", op: "==", value: "open" }]]);
    expect(base.where("x", "contains_ci", "y").toQuerySpec()["where"]).toHaveLength(1);
    expect(base.toQuerySpec()["where"]).toHaveLength(0);
  });

  it("serializes OR groups into the query spec", async () => {
    const { db, calls } = makeClient(defaultHandler);
    await db
      .collection("orders")
      .where("status", "==", "open")
      .or([
        [
          { field: "priority", op: ">=", value: 5 },
          { field: "region", op: "in", value: ["eu", "us"] },
        ],
        [{ field: "flagged", op: "==", value: true }],
      ])
      .get();
    expect(bodyOf(calls, 0)["or"]).toEqual([
      [
        { field: "priority", op: ">=", value: 5 },
        { field: "region", op: "in", value: ["eu", "us"] },
      ],
      [{ field: "flagged", op: "==", value: true }],
    ]);
  });

  it("passes V2 case-insensitive and text-search operators through unchanged", async () => {
    const { db, calls } = makeClient(defaultHandler);
    await db
      .collection("orders")
      .where("name", "contains_ci", "ann")
      .where("name", "starts_with_ci", "a")
      .where("body", "text_search", "invoice")
      .get();
    expect(bodyOf(calls, 0)["where"]).toEqual([
      { field: "name", op: "contains_ci", value: "ann" },
      { field: "name", op: "starts_with_ci", value: "a" },
      { field: "body", op: "text_search", value: "invoice" },
    ]);
  });

  it("preserves dot paths in select", async () => {
    const { db, calls } = makeClient(defaultHandler);
    await db.collection("orders").select("author.name", "meta.score").get();
    expect(bodyOf(calls, 0)["select"]).toEqual(["author.name", "meta.score"]);
  });
});

function dbBase() {
  return createClient({ projectId, apiKey, customFetch: (async () => new Response("{}")) as unknown as typeof fetch }).collection("orders");
}

describe("@vellumdb/sdk-js V2 - Aggregations", () => {
  it("count() posts documents:aggregate with a single count metric and returns a number", async () => {
    const { db, calls } = makeClient(defaultHandler);
    const result = await db.collection("orders").where("status", "==", "open").count();
    expect(result).toBe(42);
    expect(calls[0]?.url).toContain("/v1/projects/proj_v2/documents:aggregate");
    expect(calls[0]?.method).toBe("POST");
    const body = bodyOf(calls, 0);
    expect(body["collectionPath"]).toBe("orders");
    expect(body["where"]).toEqual([{ field: "status", op: "==", value: "open" }]);
    expect(body["or"]).toEqual([]);
    expect(body["metrics"]).toEqual({ count: { op: "count" } });
    expect(body).not.toHaveProperty("groupBy");
  });

  it("sum/avg/min/max use named metrics with their field dot paths", async () => {
    const cases: Array<{ op: "sum" | "avg" | "min" | "max"; run: (c: ReturnType<typeof createClient>) => Promise<number> }> = [
      { op: "sum", run: (c) => c.collection("orders").sum("amount.total") },
      { op: "avg", run: (c) => c.collection("orders").avg("amount.total") },
      { op: "min", run: (c) => c.collection("orders").min("amount.total") },
      { op: "max", run: (c) => c.collection("orders").max("amount.total") },
    ];
    for (const { op, run } of cases) {
      const { db, calls } = makeClient(defaultHandler);
      await run(db);
      expect(bodyOf(calls, 0)["metrics"]).toEqual({ [op]: { op, field: "amount.total" } });
    }
  });

  it("aggregate() returns the rows array when groupBy is present", async () => {
    const { db, calls } = makeClient(() => ({
      body: { rows: [{ status: "open", count: 7 }, { status: "paid", count: 9 }], executionTimeMs: 4 },
    }));
    const rows = await db
      .collection("orders")
      .aggregate({ groupBy: ["status"], metrics: { count: { op: "count" } } });
    expect(rows).toEqual([{ status: "open", count: 7 }, { status: "paid", count: 9 }]);
    expect(bodyOf(calls, 0)["groupBy"]).toEqual(["status"]);
  });

  it("aggregate() includes OR groups in its request body", async () => {
    const { db, calls } = makeClient(defaultHandler);
    await db
      .collection("orders")
      .or([[{ field: "status", op: "==", value: "open" }]])
      .aggregate({ metrics: { count: { op: "count" } } });
    expect(bodyOf(calls, 0)["or"]).toEqual([[{ field: "status", op: "==", value: "open" }]]);
  });

  it("aggregate() resolves to 0 when the server returns no rows", async () => {
    const { db } = makeClient(() => ({ body: { rows: [] } }));
    await expect(db.collection("orders").count()).resolves.toBe(0);
  });
});

describe("@vellumdb/sdk-js V2 - Bulk delete", () => {
  it("deleteWhere() posts filters and an optional limit and returns deletedCount", async () => {
    const { db, calls } = makeClient(defaultHandler);
    const result = await db
      .collection("orders")
      .where("status", "==", "expired")
      .or([[{ field: "region", op: "==", value: "eu" }]])
      .deleteWhere({ limit: 25 });
    expect(result).toEqual({ deletedCount: 3 });
    expect(calls[0]?.url).toContain("/documents:bulk-delete");
    expect(calls[0]?.method).toBe("POST");
    const body = bodyOf(calls, 0);
    expect(body["collectionPath"]).toBe("orders");
    expect(body["where"]).toEqual([{ field: "status", op: "==", value: "expired" }]);
    expect(body["or"]).toEqual([[{ field: "region", op: "==", value: "eu" }]]);
    expect(body["limit"]).toBe(25);
  });

  it("deleteWhere() omits limit when not supplied", async () => {
    const { db, calls } = makeClient(defaultHandler);
    await db.collection("orders").deleteWhere();
    expect(bodyOf(calls, 0)).not.toHaveProperty("limit");
  });
});

describe("@vellumdb/sdk-js V2 - DocumentReference writes and reads", () => {
  it("set() sends merge, ifVersion, ttlSeconds, expiresAt and upsert", async () => {
    const { db, calls } = makeClient(defaultHandler);
    await db
      .doc("users/d1")
      .set(
        { name: "Ada" },
        {
          merge: true,
          ifVersion: 4,
          ttlSeconds: 3600,
          expiresAt: "2030-01-01T00:00:00.000Z",
          upsert: false,
        }
      );
    expect(bodyOf(calls, 0)).toEqual({
      data: { name: "Ada" },
      merge: true,
      ifVersion: 4,
      ttlSeconds: 3600,
      expiresAt: "2030-01-01T00:00:00.000Z",
      upsert: false,
    });
  });

  it("set() keeps the legacy body shape when V2 options are absent", async () => {
    const { db, calls } = makeClient(defaultHandler);
    await db.doc("users/d1").set({ name: "Ada" }, { merge: true });
    expect(bodyOf(calls, 0)).toEqual({ data: { name: "Ada" }, merge: true, ifVersion: null });
  });

  it("create() sends ttlSeconds and expiresAt in the POST body", async () => {
    const { db, calls } = makeClient(defaultHandler);
    await db.doc("users/d1").create({ name: "Ada" }, { ttlSeconds: 60, expiresAt: "2031-01-01T00:00:00.000Z" });
    expect(calls[0]?.method).toBe("POST");
    expect(bodyOf(calls, 0)).toEqual({
      data: { name: "Ada" },
      ttlSeconds: 60,
      expiresAt: "2031-01-01T00:00:00.000Z",
    });
  });

  it("upsert() is a convenience for set(..., { upsert: true })", async () => {
    const { db, calls } = makeClient(defaultHandler);
    await db.doc("users/d1").upsert({ name: "Ada" }, { ttlSeconds: 90 });
    expect(calls[0]?.method).toBe("PUT");
    expect(bodyOf(calls, 0)).toEqual({
      data: { name: "Ada" },
      merge: false,
      ifVersion: null,
      ttlSeconds: 90,
      upsert: true,
    });
  });

  it("get() sends include and select as JSON-encoded query params", async () => {
    const { db, calls } = makeClient(defaultHandler);
    await db.doc("users/d1").get({ include: ["authorId", { field: "orgId", as: "org" }], select: ["name", "meta.role"] });
    const url = new URL(calls[0]?.url ?? "");
    expect(url.searchParams.get("include")).toBe(
      JSON.stringify([{ field: "authorId" }, { field: "orgId", as: "org" }])
    );
    expect(url.searchParams.get("select")).toBe(JSON.stringify(["name", "meta.role"]));
  });

  it("get() adds no query string when no options are given", async () => {
    const { db, calls } = makeClient(defaultHandler);
    await db.doc("users/d1").get();
    expect(calls[0]?.url).not.toContain("?");
  });

  it("document snapshots expose included and redactedRefs", async () => {
    const { db } = makeClient(() => ({
      body: {
        ...okDoc,
        _included: { author: { name: "Grace" } },
        _redactedRefs: ["users/hidden"],
      },
    }));
    const snap = await db.doc("users/d1").get({ include: ["authorId"] });
    expect(snap.included).toEqual({ author: { name: "Grace" } });
    expect(snap.redactedRefs).toEqual(["users/hidden"]);
  });

  it("query snapshots expose included and redactedRefs", async () => {
    const { db } = makeClient(() => ({
      body: {
        documents: [
          {
            ...okDoc,
            _included: { author: { name: "Grace" } },
            _redactedRefs: ["users/hidden"],
          },
        ],
        nextCursor: null,
        meta: {},
      },
    }));
    const snap = await db.collection("users").include(["authorId"]).get();
    expect(snap.docs[0]?.included).toEqual({ author: { name: "Grace" } });
    expect(snap.docs[0]?.redactedRefs).toEqual(["users/hidden"]);
  });
});

const suggestionUrl = (token: string): string =>
  `https://dashboard.example.test/orgs/org_1/projects/proj_v2/indexes?suggest=${token}`;

function suggestionHeaders(fingerprint?: string): Record<string, string> {
  const payload: Record<string, unknown> = {
    collectionPath: "orders",
    reason: "Composite index needed for equality filter on [status] + sort on [createdAt DESC].",
  };
  if (fingerprint !== undefined) payload["fingerprint"] = fingerprint;
  return {
    "x-vellum-index-url": suggestionUrl(fingerprint ?? "nofp"),
    "x-vellum-index-suggestion": JSON.stringify(payload),
  };
}

describe("@vellumdb/sdk-js V2 - Index suggestion logger", () => {
  it("warns once for two responses with the same fingerprint", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const fingerprint = "fp-once-3a-001";
    const { db } = makeClient(() => ({ body: okDoc, headers: suggestionHeaders(fingerprint) }));
    await db.doc("users/d1").get();
    await db.doc("users/d2").get();
    expect(warn).toHaveBeenCalledTimes(1);
    const message = String(warn.mock.calls[0]?.[0]);
    expect(message).toContain('[Vellum] Missing index on "orders"');
    expect(message).toContain("Composite index needed for equality filter on [status] + sort on [createdAt DESC].");
    expect(message).toContain(`Create it: ${suggestionUrl(fingerprint)}`);
  });

  it("prints a single-line warning", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { db } = makeClient(() => ({ body: okDoc, headers: suggestionHeaders("fp-once-3a-lines") }));
    await db.doc("users/d1").get();
    const message = String(warn.mock.calls[0]?.[0]);
    expect(message.split("\n")).toHaveLength(1);
  });

  it("never warns or grows the dedupe set when warnOnMissingIndexes is false", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const fingerprint = "fp-disabled-3a-002";
    const handler: Handler = () => ({ body: okDoc, headers: suggestionHeaders(fingerprint) });
    const disabled = makeClient(handler, { warnOnMissingIndexes: false });
    await disabled.db.doc("users/d1").get();
    expect(warn).not.toHaveBeenCalled();

    // Re-enabling with the same fingerprint must still warn: the disabled
    // client did not add it to the module-level dedupe set.
    const enabled = makeClient(handler, { warnOnMissingIndexes: true });
    await enabled.db.doc("users/d1").get();
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("invokes the onIndexSuggestion hook with the parsed payload and URL", async () => {
    const events: IndexSuggestionEvent[] = [];
    const { db } = makeClient(() => ({ body: okDoc, headers: suggestionHeaders("fp-hook-3a-003") }), {
      warnOnMissingIndexes: false,
      onIndexSuggestion: (event) => events.push(event),
    });
    await db.doc("users/d1").get();
    expect(events).toHaveLength(1);
    expect(events[0]?.url).toBe(suggestionUrl("fp-hook-3a-003"));
    expect(events[0]?.suggestion).toMatchObject({ collectionPath: "orders", fingerprint: "fp-hook-3a-003" });
  });

  it("never prints API keys or bearer tokens in the warning", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { db } = makeClient(() => ({ body: okDoc, headers: suggestionHeaders("fp-secrets-3a-004") }));
    await db.doc("users/d1").get();
    const message = String(warn.mock.calls[0]?.[0]);
    expect(message).not.toContain(apiKey);
    expect(message).not.toContain("Bearer");
    expect(message).not.toContain("authorization");
  });

  it("falls back to hashing the URL when the suggestion has no fingerprint", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    // Two distinct URLs so this test cannot collide with another test's hash.
    const urlA = `${suggestionUrl("fallback")}&a=3aA`;
    const urlB = `${suggestionUrl("fallback")}&a=3aA`;
    const handler: Handler = () => ({
      body: okDoc,
      headers: {
        "x-vellum-index-url": urlA,
        "x-vellum-index-suggestion": JSON.stringify({ collectionPath: "orders", reason: "needs index" }),
      },
    });
    expect(urlB).toBe(urlA);
    const { db } = makeClient(handler);
    await db.doc("users/d1").get();
    await db.doc("users/d2").get();
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("ignores malformed suggestion JSON without failing the request", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { db } = makeClient(() => ({
      body: okDoc,
      headers: {
        "x-vellum-index-url": suggestionUrl("malformed-3a-005"),
        "x-vellum-index-suggestion": "{not json",
      },
    }));
    const snap = await db.doc("users/d1").get();
    expect(snap.data()).toEqual({ name: "Ada" });
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("tolerates a minimal Response-like object without header accessors", async () => {
    const customFetch = (async () => ({
      status: 200,
      ok: true,
      json: async () => okDoc,
    })) as unknown as typeof globalThis.fetch;
    const db = createClient({ projectId, apiKey, customFetch });
    const snap = await db.doc("users/d1").get();
    expect(snap.id).toBe("d1");
  });
});


describe("document referencedBy", () => {
  it("sends normalized reverse lookup options and builds dependent snapshots", async () => {
    const { db, calls } = makeClient(() => ({ body: { documents: [{ ...okDoc, path: "posts/p1", data: { title: "Dependent" } }], nextCursor: "opaque-next" } }));
    const result = await db.doc("users/u1").referencedBy({ collection: "posts", field: "author", limit: 4, cursor: "opaque", include: ["owner"], select: ["title"] });
    expect(calls[0]?.method).toBe("POST");
    expect(calls[0]?.url).toContain("/documents:referencedBy");
    expect(bodyOf(calls, 0)).toEqual({ targetPath: "users/u1", collection: "posts", field: "author", limit: 4, cursor: "opaque", select: ["title"], include: [{ field: "owner" }] });
    expect(result.documents[0]?.data()).toEqual({ title: "Dependent" });
    expect(result.documents[0]?.path).toBe("posts/p1");
    expect(result.nextCursor).toBe("opaque-next");
  });
  it("honors an already aborted signal without HTTP", async () => {
    const { db, calls } = makeClient(defaultHandler);
    const abort = new AbortController(); abort.abort();
    await expect(db.doc("users/u1").referencedBy({ signal: abort.signal })).rejects.toMatchObject({ name: "AbortError" });
    expect(calls).toHaveLength(0);
  });
});

describe("@vellumdb/sdk-js - non-finite numbers", () => {
  it("rejects NaN and Infinity before sending", async () => {
    const { db } = makeClient(() => ({ body: okDoc }));
    await expect(db.doc("users/d1").set({ score: Number.NaN })).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
    await expect(db.doc("users/d1").set({ n: { x: Infinity } })).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
  });
});
