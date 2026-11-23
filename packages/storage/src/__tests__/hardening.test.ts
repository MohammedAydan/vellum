import { describe, it, expect } from "vitest";
import { VellumError } from "@vellum/core";
import {
  compileAggregateSql,
  validateAggregateRequest,
  aggregateRowsInMemory,
  normalizeAggregateRows,
  stageDeletesInTx,
} from "../aggregates.js";
import {
  createTtlCache,
  createCacheInvalidationBus,
  decodeCacheInvalidation,
  scopedCacheKey,
  invalidateProjectCache,
  getNamedCache,
  type CacheNotifyClient,
} from "../cache.js";
import type {
  createSqlTransactionHandle} from "../tx-context.js";
import {
  runInTenantTransactionAsync,
  SQL_INSERT_OUTBOX_UNNEST,
  type PgClientLike,
  type PgQueryArg,
} from "../tx-context.js";
import { createSqlAuthOperations, decodeUserCursor, type UpdateAuthUserInput } from "../auth-store.js";
import { sqlListCollections, sqlClearCollectionDocuments } from "../pg-adapter.js";
import { DataPlaneStore } from "../memory-adapter.js";
import type { DocumentRecord, TenantContext } from "../types.js";

const TENANT_A: TenantContext = { projectId: "11111111-1111-1111-1111-111111111111" };
const TENANT_B: TenantContext = { projectId: "22222222-2222-2222-2222-222222222222" };

function makeDoc(ctx: TenantContext, id: string, data: Record<string, unknown>, overrides: Partial<DocumentRecord> = {}): DocumentRecord {
  const now = new Date().toISOString();
  return {
    projectId: ctx.projectId,
    path: `orders/${id}`,
    collectionPath: "orders",
    collectionGroup: "orders",
    documentId: id,
    pathDepth: 2,
    data,
    sizeBytes: 64,
    version: 1,
    createdAt: now,
    updatedAt: now,
    deletedAt: null,
    ...overrides,
  };
}

class MockPgClient implements PgClientLike {
  readonly calls: Array<{ text: string; name?: string; params?: unknown[] }> = [];
  released = false;
  releaseErr: Error | boolean | undefined;
  failOnQuery?: (text: string, callCount: number) => unknown;

  async query(arg: PgQueryArg, params?: unknown[]): Promise<{ rows: unknown[]; rowCount?: number | null }> {
    const text = typeof arg === "string" ? arg : arg.text;
    const callIdx = this.calls.length;
    if (typeof arg === "string") {
      this.calls.push({ text, ...(params === undefined ? {} : { params }) });
    } else {
      this.calls.push({
        text: arg.text,
        name: arg.name,
        ...(arg.values === undefined ? {} : { params: [...arg.values] }),
      });
    }
    const err = this.failOnQuery?.(text, callIdx);
    if (err) throw err;
    return { rows: [], rowCount: 0 };
  }

  release(err?: Error | boolean): void {
    this.released = true;
    this.releaseErr = err;
  }
}

describe("@vellum/storage hardening - aggregates.ts", () => {
  it("rejects prototype-polluting aliases, NUL bytes, empty collectionPath, and excessive metrics/groupBy", () => {
    expect(() =>
      validateAggregateRequest({
        collectionPath: "",
        metrics: { c: { op: "count" } },
      })
    ).toThrow(VellumError);

    expect(() =>
      validateAggregateRequest({
        collectionPath: "orders",
        metrics: { __proto__: { op: "count" } },
      })
    ).toThrow(VellumError);

    expect(() =>
      validateAggregateRequest({
        collectionPath: "orders",
        groupBy: ["constructor"],
        metrics: { c: { op: "count" } },
      })
    ).toThrow(VellumError);

    expect(() =>
      validateAggregateRequest({
        collectionPath: "orders",
        metrics: { "bad\0alias": { op: "count" } },
      })
    ).toThrow(VellumError);

    const tooManyGroupBy = Array.from({ length: 17 }, (_, i) => `f${i}`);
    expect(() =>
      validateAggregateRequest({
        collectionPath: "orders",
        groupBy: tooManyGroupBy,
        metrics: { c: { op: "count" } },
      })
    ).toThrow(VellumError);
  });

  it("deduplicates bind parameters for repeated metric fields and guards tagged int casts", () => {
    const { sql, params } = compileAggregateSql(TENANT_A, {
      collectionPath: "orders",
      metrics: {
        s: { op: "sum", field: "amount" },
        a: { op: "avg", field: "amount" },
        mn: { op: "min", field: "amount" },
        mx: { op: "max", field: "amount" },
      },
    });
    // $1=projectId, $2=collectionPath, $3=["amount"], $4=["amount","$t"], $5=["amount","$v"]
    expect(params).toHaveLength(5);
    expect(sql).toContain("~ '^-?[0-9]+(\\.[0-9]+)?$'");
  });

  it("supports field-scoped count in SQL and handles large in-memory groups without stack overflow", () => {
    const { sql } = compileAggregateSql(TENANT_A, {
      collectionPath: "orders",
      metrics: { nonNullNotes: { op: "count", field: "note" } },
    });
    expect(sql).toContain("COUNT((d.data #>>");

    const normalized = normalizeAggregateRows(
      [{ count: "5", __proto__: { polluted: true } } as Record<string, unknown>],
      { collectionPath: "orders", metrics: { count: { op: "count" } } }
    );
    expect(({} as Record<string, unknown>)["polluted"]).toBeUndefined();
    expect(normalized[0]?.["count"]).toBe(5);

    const docs = Array.from({ length: 1000 }, (_, i) => makeDoc(TENANT_A, `d${i}`, { amount: i }));
    const rows = aggregateRowsInMemory(docs, {
      collectionPath: "orders",
      metrics: { min: { op: "min", field: "amount" }, max: { op: "max", field: "amount" } },
    });
    expect(rows[0]).toEqual({ min: 0, max: 999 });
  });

  it("uses batched appendOutboxEvents in stageDeletesInTx when supported", async () => {
    const batchedCalls: number[] = [];
    const docs = [makeDoc(TENANT_A, "1", { a: 1 }), makeDoc(TENANT_A, "2", { a: 2 })];
    const result = await stageDeletesInTx(
      {
        putDocumentRow: async () => {},
        putDocumentRows: async () => {},
        appendOutboxEvent: async () => {
          throw new Error("should not call single appendOutboxEvent when batched is available");
        },
        appendOutboxEvents: async (events) => {
          batchedCalls.push(events.length);
          return events.map((e, i) => ({
            ...e,
            projectId: TENANT_A.projectId,
            seqId: String(i + 1),
            committedAt: new Date().toISOString(),
          }));
        },
      },
      docs,
      new Date().toISOString()
    );
    expect(batchedCalls).toEqual([2]);
    expect(result.deletedCount).toBe(2);
  });
});

describe("@vellum/storage hardening - cache.ts", () => {
  it("prevents tenant key collisions via length-prefixed scopedCacheKey and prefix invalidation", () => {
    const k1 = scopedCacheKey("a:b", "c");
    const k2 = scopedCacheKey("a", "b:c");
    expect(k1).not.toBe(k2);

    const projectCache = getNamedCache<string>("project");
    projectCache.clear();
    projectCache.set("p1", "root");
    projectCache.set("p1:meta", "sub");
    projectCache.set(scopedCacheKey("p1", "cfg"), "scoped");
    projectCache.set("p10", "neighbor");

    invalidateProjectCache("p1");
    expect(projectCache.get("p1")).toBeUndefined();
    expect(projectCache.get("p1:meta")).toBeUndefined();
    expect(projectCache.get(scopedCacheKey("p1", "cfg"))).toBeUndefined();
    expect(projectCache.get("p10")).toBe("neighbor");
  });

  it("coalesces concurrent getOrLoad calls and drops stale loads invalidated mid-flight", async () => {
    const cache = createTtlCache<string>({ ttlMs: 10_000, sweepIntervalMs: 0 });
    let loaderCalls = 0;
    let resolveLoader!: (v: string) => void;

    const p1 = cache.getOrLoad!("k", () => {
      loaderCalls += 1;
      return new Promise<string>((r) => {
        resolveLoader = r;
      });
    });
    const p2 = cache.getOrLoad!("k", () => {
      loaderCalls += 1;
      return Promise.resolve("should-not-run");
    });

    // getOrLoad invokes the loader in a microtask so synchronous throws become
    // rejected promises; let that microtask run before asserting single-flight.
    await Promise.resolve();
    expect(loaderCalls).toBe(1);
    // Invalidate while load is still in flight
    cache.delete("k");
    resolveLoader("stale-value");

    expect(await p1).toBe("stale-value");
    expect(await p2).toBe("stale-value");
    // Stale value must NOT have been written back to the cache after delete()
    expect(cache.get("k")).toBeUndefined();
    cache.dispose();
  });

  it("rejects invalid Postgres LISTEN channel identifiers and invalidates locally even on NOTIFY failure", async () => {
    expect(() =>
      createCacheInvalidationBus({
        connectionString: "postgresql://unused:unused@localhost:5432/unused",
        channel: 'bad"; DROP TABLE documents; --',
        onInvalidate: () => {},
      })
    ).toThrow();

    expect(decodeCacheInvalidation('{"kind":"api_key","key":"bad\\u0000key"}')).toEqual({
      kind: "api_key",
    });

    let created = 0;
    const bus = createCacheInvalidationBus({
      connectionString: "postgresql://unused:unused@localhost:5432/unused",
      clientFactory: (): CacheNotifyClient => {
        created += 1;
        const isPublisher = created === 2;
        return {
          connect: async () => {},
          query: async () => {
            if (isPublisher) throw new Error("network down");
            return { rows: [] };
          },
          on: () => {},
          end: async () => {},
        };
      },
      onInvalidate: () => {},
      instanceId: "inst-1",
    });

    getNamedCache<string>("api_key").set("pk_local", "cached");
    await expect(bus.publish({ kind: "api_key", key: "pk_local" })).rejects.toThrow("network down");
    // Local cache MUST still be invalidated despite remote NOTIFY failure
    expect(getNamedCache<string>("api_key").get("pk_local")).toBeUndefined();
    await bus.close();
  });
});

describe("@vellum/storage hardening - tx-context.ts", () => {
  it("uses SAVEPOINT for nested same-tenant tx and rejects nested cross-tenant tx", async () => {
    const client = new MockPgClient();
    const pool = { connect: async () => client };

    await runInTenantTransactionAsync(
      pool,
      TENANT_A,
      async () => {
        // Same-tenant nested tx uses SAVEPOINT on the same client
        await runInTenantTransactionAsync(pool, TENANT_A, async () => "inner", {
          preparedStatements: true,
        });

        // Cross-tenant nested tx fails closed
        await expect(
          runInTenantTransactionAsync(pool, TENANT_B, async () => "forbidden", {
            preparedStatements: true,
          })
        ).rejects.toMatchObject({ code: "PERMISSION_DENIED" });
      },
      { preparedStatements: true }
    );

    const texts = client.calls.map((c) => c.text);
    expect(texts).toContain("SAVEPOINT vellum_sp_1");
    expect(texts).toContain("RELEASE SAVEPOINT vellum_sp_1");
    expect(texts.at(-1)).toBe("COMMIT");
  });

  it("retries transient 40001 serialization failures and destroys client if ROLLBACK fails", async () => {
    let attempts = 0;
    const clients: MockPgClient[] = [];
    const pool = {
      connect: async () => {
        const c = new MockPgClient();
        clients.push(c);
        return c;
      },
    };

    const result = await runInTenantTransactionAsync(
      pool,
      TENANT_A,
      async () => {
        attempts += 1;
        if (attempts === 1) {
          throw Object.assign(new Error("serialization failure"), { code: "40001" });
        }
        return "recovered";
      },
      { preparedStatements: true, maxRetries: 2, retryBaseDelayMs: 1 }
    );

    expect(result).toBe("recovered");
    expect(attempts).toBe(2);
    expect(clients).toHaveLength(2);

    // Broken rollback destroys client via client.release(err)
    const brokenClient = new MockPgClient();
    brokenClient.failOnQuery = (text) => (text === "ROLLBACK" ? new Error("socket closed") : undefined);
    await expect(
      runInTenantTransactionAsync(
        { connect: async () => brokenClient },
        TENANT_A,
        async () => {
          throw new Error("boom");
        },
        { preparedStatements: true, maxRetries: 0 }
      )
    ).rejects.toThrow("boom");
    expect(brokenClient.released).toBe(true);
    expect(brokenClient.releaseErr).toBeInstanceOf(Error);
  });

  it("blocks use-after-close on escaped tx handles and enforces tenant check on batch writes", async () => {
    const client = new MockPgClient();
    let escapedTx!: ReturnType<typeof createSqlTransactionHandle>;
    await runInTenantTransactionAsync(
      { connect: async () => client },
      TENANT_A,
      async (tx) => {
        escapedTx = tx as ReturnType<typeof createSqlTransactionHandle>;
        await expect(
          escapedTx.putDocumentRows([makeDoc(TENANT_B, "x", {})])
        ).rejects.toMatchObject({ code: "PERMISSION_DENIED" });
      },
      { preparedStatements: true }
    );
    await expect(escapedTx.getDocument("orders/1")).rejects.toMatchObject({
      code: "FAILED_PRECONDITION",
    });
    expect(SQL_INSERT_OUTBOX_UNNEST).toContain("unnest(");
  });
});

describe("@vellum/storage hardening - auth-store.ts, pg-adapter.ts & memory-adapter.ts", () => {
  it("blocks prototype keys in SQL updateAuthUser and escapes ILIKE wildcards", async () => {
    const queries: Array<{ sql: string; params?: unknown[] }> = [];
    const auth = createSqlAuthOperations(async (_ctx, cb) =>
      cb({
        query: async (sql, params) => {
          queries.push({ sql, ...(params ? { params } : {}) });
          return { rows: [] };
        },
      })
    );

    await expect(
      auth.updateAuthUser(TENANT_A, "user-1", { toString: "injected" } as unknown as UpdateAuthUserInput)
    ).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });

    await auth.listAuthUsers(TENANT_A, { search: "100%_admin\\test" });
    expect(queries[0]?.sql).toContain("ESCAPE '\\'");
    expect(queries[0]?.params?.[1]).toBe("%100\\%\\_admin\\\\test%");

    // Also verify pg-adapter sqlListCollections escapes LIKE wildcards & CTE delete
    const colQueries: Array<{ sql: string; params?: unknown[] }> = [];
    const fakeClient = {
      query: async <T,>(sql: string, params?: unknown[]) => {
        colQueries.push({ sql, ...(params ? { params } : {}) });
        return { rows: [] as T[], rowCount: 0 };
      },
    };
    await sqlListCollections(fakeClient, TENANT_A, { search: "a%b_c" });
    expect(colQueries[1]?.sql).toContain("ESCAPE '\\'");
    expect(colQueries[1]?.params?.[1]).toBe("a\\%b\\_c");

    await sqlClearCollectionDocuments(fakeClient, TENANT_A, "orders");
    expect(colQueries[2]?.sql).toContain("WITH deleted AS");

    expect(() => decodeUserCursor("a".repeat(600))).toThrow(VellumError);
  });

  it("prevents rotating revoked/expired sessions, deep-clones auth records, and cascades deleteAuthUser", async () => {
    const store = new DataPlaneStore();
    const user = await store.createAuthUser(TENANT_A, {
      email: "sec@example.com",
      customClaims: { role: "viewer" },
    });
    // Mutating returned object must NOT mutate stored state
    user.customClaims["role"] = "superadmin";
    expect((await store.getAuthUserById(TENANT_A, user.id))?.customClaims).toEqual({ role: "viewer" });

    const session = await store.createAuthSession(TENANT_A, {
      userId: user.id,
      refreshTokenHash: "hash_1",
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });
    // Same-hash rotation is rejected
    await expect(
      store.rotateAuthSession(TENANT_A, session.id, "hash_1", "hash_1", new Date(Date.now() + 60_000).toISOString())
    ).rejects.toMatchObject({ code: "UNAUTHENTICATED" });

    // Revoked session cannot be rotated
    await store.revokeAuthSession(TENANT_A, session.id, "logout");
    await expect(
      store.rotateAuthSession(TENANT_A, session.id, "hash_1", "hash_2", new Date(Date.now() + 60_000).toISOString())
    ).rejects.toMatchObject({ code: "UNAUTHENTICATED" });

    // Expired session cannot be rotated
    const expiredSession = await store.createAuthSession(TENANT_A, {
      userId: user.id,
      refreshTokenHash: "hash_exp",
      expiresAt: new Date(Date.now() - 10_000).toISOString(),
    });
    await expect(
      store.rotateAuthSession(TENANT_A, expiredSession.id, "hash_exp", "hash_new", new Date(Date.now() + 60_000).toISOString())
    ).rejects.toMatchObject({ code: "UNAUTHENTICATED" });

    // Deleting user cascades sessions & tokens
    await store.saveAuthToken(TENANT_A, {
      userId: user.id,
      tokenHash: "tok_1",
      tokenType: "verify_email",
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });
    expect(await store.deleteAuthUser(TENANT_A, user.id)).toBe(true);
    expect(await store.listUserSessions(TENANT_A, user.id)).toHaveLength(0);
    await expect(store.consumeAuthToken(TENANT_A, "tok_1", "verify_email")).rejects.toMatchObject({
      code: "UNAUTHENTICATED",
    });
  });

  it("isolates tenants during TTL sweep, rolls back indexes on tx error, and prevents prototype pollution in memory adapter", async () => {
    const store = new DataPlaneStore();
    const idxA = await store.createCompositeIndex(TENANT_A, "orders", [{ path: "amount", dir: "asc" }]);
    const idxB = await store.createCompositeIndex(TENANT_B, "orders", [{ path: "amount", dir: "asc" }]);

    await store.putDocument(TENANT_A, makeDoc(TENANT_A, "shared_id", { amount: 10 }, { expiresAt: "2000-01-01T00:00:00.000Z" }));
    await store.putDocument(TENANT_B, makeDoc(TENANT_B, "shared_id", { amount: 20 }));

    // Sweeping Tenant A's expired doc must NOT remove Tenant B's index entry for the same path
    const swept = await store.runTtlSweeperWorker(100);
    expect(swept.purgedCount).toBe(1);
    const docsB = await store.listDocumentsViaIndex(TENANT_B, idxB.id);
    expect(docsB.map((d) => d.documentId)).toEqual(["shared_id"]);
    expect(await store.listDocumentsViaIndex(TENANT_A, idxA.id)).toHaveLength(0);

    // Failed transaction rolls back createIndex
    await expect(
      store.withTransaction(TENANT_A, async (tx) => {
        await tx.createIndex({ collectionPath: "orders", fields: [{ path: "status", dir: "asc" }] });
        throw new Error("abort");
      })
    ).rejects.toThrow("abort");
    expect(await store.listCompositeIndexes(TENANT_A)).toHaveLength(1);

    // Prototype field lookup in listDependentsByReference returns empty safely
    const deps = await store.listDependentsByReference(TENANT_B, "orders", "toString", "orders/shared_id", 10);
    expect(deps).toEqual([]);
  });
});
