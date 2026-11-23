/**
 * Deep audit regression suite — covers security, concurrency, reliability, and
 * performance hardening across path-utils, transforms, circuit-breaker,
 * telemetry, transactions, relations, and engine.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { VellumError } from "@vellum/core";
import { parseFieldPath, setPath, toIsoDate } from "../path-utils.js";
import { applyFieldTransforms } from "../transforms.js";
import { createCircuitBreaker } from "../circuit-breaker.js";
import { resolveTelemetry } from "../telemetry.js";
import {
  computeRetryDelayMs,
  decodeAndVerifyTransactionToken,
} from "../transactions.js";
import { resolveIncludes, type RelationDocument } from "../relations.js";
import { projectDocumentFields } from "../engine.js";
import { createFixture, TENANT } from "./_harness.js";

const NOW = "2026-11-20T12:00:00.000Z";

afterEach(() => {
  vi.useRealTimers();
});

describe("audit/path-utils — atomic validation, caching, and bounds", () => {
  it("setPath is atomic on invalid paths (no partial intermediate mutation)", () => {
    const target: Record<string, unknown> = {};
    expect(() => setPath(target, "safe.__proto__.x", 1)).toThrow(VellumError);
    expect(Object.keys(target)).toEqual([]);
    expect(Object.prototype).not.toHaveProperty("x");
  });

  it("rejects empty segments and excessive nesting depth", () => {
    expect(() => parseFieldPath("")).toThrow(VellumError);
    expect(() => parseFieldPath("a..b")).toThrow(VellumError);
    expect(() => parseFieldPath(".a")).toThrow(VellumError);
    expect(() => parseFieldPath("a.")).toThrow(VellumError);
    const deep = Array.from({ length: 65 }, (_, i) => `k${i}`).join(".");
    expect(() => parseFieldPath(deep)).toThrow(VellumError);
  });

  it("caches parsed paths and returns identical frozen segment tuples", () => {
    const first = parseFieldPath("profile.address.city");
    const second = parseFieldPath("profile.address.city");
    expect(first).toBe(second);
    expect(Object.isFrozen(first)).toBe(true);
  });

  it("toIsoDate fails closed on oversized strings", () => {
    expect(toIsoDate("2026-01-01T00:00:00.000Z")).toBe("2026-01-01T00:00:00.000Z");
    expect(toIsoDate("2026-01-01" + " ".repeat(500))).toBeNull();
  });
});

describe("audit/transforms — deep prototype guards, overflow checks, O(N+M) arrays", () => {
  it("rejects prototype-pollution keys inside newly inserted nested objects and arrayUnion elements", () => {
    const nestedGadget = JSON.parse('{"profile":{"__proto__":{"polluted":true}}}') as Record<
      string,
      unknown
    >;
    expect(() => applyFieldTransforms({}, nestedGadget, NOW)).toThrowError(
      expect.objectContaining({ code: "INVALID_FIELD_NAME" })
    );
    expect(() => applyFieldTransforms({}, nestedGadget, NOW)).toThrow(VellumError);

    const arrGadget = JSON.parse('{"__proto__":{"polluted":true}}') as Record<string, unknown>;
    expect(() =>
      applyFieldTransforms({}, { items: { $op: "arrayUnion", elements: [arrGadget] } }, NOW)
    ).toThrow(VellumError);
    expect(Object.prototype).not.toHaveProperty("polluted");
  });

  it("does not read Object.prototype properties such as toString during inc", () => {
    const res = applyFieldTransforms({}, { toString: { $op: "inc", by: 3 } }, NOW);
    expect(res["toString"]).toBe(3);
  });

  it("rejects non-finite increments, float overflow, and unsafe integer increments on tagged ints", () => {
    expect(() =>
      applyFieldTransforms({ n: 1 }, { n: { $op: "inc", by: Number.NaN } }, NOW)
    ).toThrow(VellumError);
    expect(() =>
      applyFieldTransforms({ n: 1 }, { n: { $op: "inc", by: Number.POSITIVE_INFINITY } }, NOW)
    ).toThrow(VellumError);
    expect(() =>
      applyFieldTransforms({ n: Number.MAX_VALUE }, { n: { $op: "inc", by: Number.MAX_VALUE } }, NOW)
    ).toThrow(VellumError);
    expect(() =>
      applyFieldTransforms(
        { counter: { $t: "int", $v: "1" } },
        { counter: { $op: "inc", by: Number.MAX_SAFE_INTEGER + 2 } },
        NOW
      )
    ).toThrow(VellumError);
  });

  it("enforces maximum nesting depth on recursive merges", () => {
    let existing: Record<string, unknown> = { leaf: 1 };
    let patch: Record<string, unknown> = { leaf: 2 };
    for (let i = 0; i < 70; i += 1) {
      existing = { n: existing };
      patch = { n: patch };
    }
    expect(() => applyFieldTransforms(existing, patch, NOW)).toThrow(VellumError);
  });

  it("handles 5,000-element arrayUnion and arrayRemove in linear time", () => {
    const base = Array.from({ length: 5_000 }, (_, i) => `tag_${i}`);
    const add = Array.from({ length: 5_000 }, (_, i) => `tag_${i + 2_500}`);
    const t0 = performance.now();
    const unioned = applyFieldTransforms(
      { tags: base },
      { tags: { $op: "arrayUnion", elements: add } },
      NOW
    );
    const removed = applyFieldTransforms(
      unioned,
      { tags: { $op: "arrayRemove", elements: base } },
      NOW
    );
    const elapsedMs = performance.now() - t0;
    expect((unioned["tags"] as unknown[]).length).toBe(7_500);
    expect((removed["tags"] as unknown[]).length).toBe(2_500);
    expect(elapsedMs).toBeLessThan(1_000);
  });
});

describe("audit/circuit-breaker — stale settlements and hung half-open probes", () => {
  it("ignores stale async settlements from prior generations", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(100_000);
    let resolveStale!: () => void;
    let callIdx = 0;
    const breaker = createCircuitBreaker(
      () => {
        callIdx += 1;
        if (callIdx === 1) {
          return new Promise<void>((r) => {
            resolveStale = r;
          });
        }
        return Promise.reject(new Error("boom"));
      },
      { failureThreshold: 2, cooldownMs: 10_000 }
    );

    breaker.call(); // #1 slow in-flight from generation 0
    breaker.call(); // #2 fails
    breaker.call(); // #3 fails -> opens breaker (generation 1)
    await Promise.resolve();
    await Promise.resolve();
    expect(breaker.isOpen).toBe(true);

    // Stale call #1 resolves now — must NOT close the open breaker.
    resolveStale();
    await Promise.resolve();
    await Promise.resolve();
    expect(breaker.isOpen).toBe(true);
  });

  it("recovers automatically if a half-open probe hangs past probeTimeoutMs", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(200_000);
    let mode: "fail" | "hang" | "ok" = "fail";
    const breaker = createCircuitBreaker(
      () => {
        if (mode === "fail") return Promise.reject(new Error("down"));
        if (mode === "hang") return new Promise<void>(() => undefined);
        return Promise.resolve();
      },
      { failureThreshold: 1, cooldownMs: 1_000, probeTimeoutMs: 2_000 }
    );

    breaker.call();
    await Promise.resolve();
    expect(breaker.isOpen).toBe(true);

    vi.setSystemTime(201_500);
    mode = "hang";
    breaker.call(); // starts hung half-open probe
    expect(breaker.isOpen).toBe(true); // blocks concurrent calls while probe is in flight

    vi.setSystemTime(204_000); // past probeTimeoutMs
    mode = "ok";
    breaker.call(); // supersedes hung probe and succeeds
    await Promise.resolve();
    await Promise.resolve();
    expect(breaker.isOpen).toBe(false);
  });
});

describe("audit/telemetry — failure isolation and cardinality bounds", () => {
  it("swallows throwing counters/histograms and collapses overflow tags", async () => {
    const recordedTags: Array<Record<string, string> | undefined> = [];
    const safe = resolveTelemetry({
      span: async (_name, fn) => fn(),
      counter: (_name, _val, tags) => {
        recordedTags.push(tags);
        throw new Error("sink exploded");
      },
      histogram: () => {
        throw new Error("hist exploded");
      },
    });

    expect(() => safe.counter("req", 1, { id: "1" })).not.toThrow();
    expect(() => safe.histogram("lat", 10)).not.toThrow();
    expect(() => safe.histogram("lat", Number.NaN)).not.toThrow();

    for (let i = 0; i < 1_050; i += 1) {
      safe.counter("high_card", 1, { docId: `d_${i}` });
    }
    const lastTag = recordedTags[recordedTags.length - 1];
    expect(lastTag).toEqual({ _cardinality: "overflow" });
  });
});

describe("audit/transactions — token hardening, first-read preservation, jitter", () => {
  it("rejects null JSON token payloads and oversized tokens with INVALID_ARGUMENT", () => {
    const nullToken = Buffer.from("null", "utf8").toString("base64url");
    expect(() => decodeAndVerifyTransactionToken(nullToken, "sec", TENANT)).toThrow(VellumError);
    expect(() =>
      decodeAndVerifyTransactionToken("a".repeat(5_000), "sec", TENANT)
    ).toThrow(VellumError);
  });

  it("preserves the first observed version in read_set across repeated reads", async () => {
    const { engine } = createFixture();
    await engine.createDocument({ ...TENANT, path: "accounts/a1", data: { balance: 10 } });
    const tx = await engine.beginTransaction(TENANT);

    // First read observes version 1
    await engine.getDocument({ ...TENANT, path: "accounts/a1", transactionToken: tx.transactionToken });
    // Concurrent update bumps version to 2
    await engine.updateDocument({ ...TENANT, path: "accounts/a1", data: { balance: 20 } });
    // Second read in the same transaction sees version 2, but must NOT overwrite version 1 in read_set
    await engine.getDocument({ ...TENANT, path: "accounts/a1", transactionToken: tx.transactionToken });

    await expect(
      engine.commitTransaction({
        ...TENANT,
        transactionToken: tx.transactionToken,
        writes: [{ type: "set", path: "accounts/a1", data: { balance: 30 } }],
      })
    ).rejects.toMatchObject({ code: "ABORTED_CONFLICT" });
  });

  it("computeRetryDelayMs stays bounded within [0, maxMs]", () => {
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const delay = computeRetryDelayMs(attempt, 25, 500);
      expect(delay).toBeGreaterThanOrEqual(0);
      expect(delay).toBeLessThanOrEqual(500);
    }
  });
});

describe("audit/relations — alias gadget rejection and depth-2 batching", () => {
  it("rejects prototype-pollution include aliases", async () => {
    const parent: RelationDocument = { path: "posts/p1", data: { authorId: "users/u1" } };
    await expect(
      resolveIncludes({
        docs: [parent],
        includes: [{ field: "authorId", collection: "users", as: "__proto__" }],
        getDocument: async () => null,
        canRead: () => true,
      })
    ).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
  });

  it("batches depth-2 nested includes across multiple parents in ONE batch call", async () => {
    const db = new Map<string, RelationDocument>();
    const parents: RelationDocument[] = [];
    for (let i = 0; i < 10; i += 1) {
      db.set(`orgs/o${i}`, { path: `orgs/o${i}`, data: { name: `Org ${i}` } });
      db.set(`users/u${i}`, { path: `users/u${i}`, data: { name: `User ${i}`, orgId: `orgs/o${i}` } });
      parents.push({ path: `posts/p${i}`, data: { authorId: `users/u${i}` } });
    }
    let batchCalls = 0;
    const res = await resolveIncludes({
      docs: parents,
      includes: [
        {
          field: "authorId",
          collection: "users",
          as: "author",
          include: [{ field: "orgId", collection: "orgs", as: "org" }],
        },
      ],
      getDocument: async () => null,
      getDocumentBatch: async (paths) => {
        batchCalls += 1;
        return paths.map((p) => db.get(p)).filter((d): d is RelationDocument => d !== undefined);
      },
      canRead: () => true,
    });
    expect(batchCalls).toBe(2);
    expect(res.batchCallCount).toBe(2);
  });
});

describe("audit/engine — set_null prototype guard, projectDocumentFields, querySpec.include", () => {
  it("projectDocumentFields ignores prototype properties like toString", () => {
    const out = projectDocumentFields({ title: "Hi" }, ["title", "toString"]);
    expect(out).toEqual({ title: "Hi" });
  });

  it("executeQuery rejects deeply nested / oversized querySpec.include", async () => {
    const { engine } = createFixture();
    const tooMany = Array.from({ length: 11 }, (_, i) => ({ field: `ref_${i}` }));
    await expect(
      engine.executeQuery({
        ...TENANT,
        querySpec: { collection: "posts", include: tooMany } as never,
      })
    ).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
  });

  it("set_null relation rule rejects prototype-pollution field paths", async () => {
    const { engine } = createFixture();
    await engine.createDocument({ ...TENANT, path: "users/u1", data: { name: "Alice" } });
    await engine.createDocument({
      ...TENANT,
      path: "posts/p1",
      data: { authorId: "users/u1" },
    });
    await expect(
      engine.deleteDocument({
        ...TENANT,
        path: "users/u1",
        relationRules: [{ collection: "posts", field: "__proto__.polluted", onDelete: "set_null" }],
      })
    ).resolves.toBeDefined();
    expect(Object.prototype).not.toHaveProperty("polluted");
  });
});
