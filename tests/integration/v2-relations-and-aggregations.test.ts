/**
 * V2 relations, aggregations, rules, TTL and index advisor.
 *
 * Runs against the real in-memory `DataPlaneStore` by default. When
 * `PHASE5_REAL=1` and a Neon `DATA_DATABASE_URL` is available it runs the exact
 * same assertions against a real Neon/PostgreSQL data plane via
 * `NeonStorageAdapter` — never a mock of engine logic. Live mode provisions an
 * isolated `projectId` tenant with a random UUID and removes
 * every row it created afterwards. No credential material is ever logged.
 *
 * Usage:
 *   corepack pnpm exec vitest run tests/integration/v2-relations-and-aggregations.test.ts
 *   PHASE5_REAL=1 corepack pnpm exec vitest run tests/integration/v2-relations-and-aggregations.test.ts
 */
import "./_live-env.js";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  analyzeQueryIndexCoverage,
  buildIndexSuggestionHeaders,
  type IndexAdvisorIndex,
} from "@vellum/core";
import { compileRulesDsl, decompileRulesAstToDsl, simulateRuleEvaluation } from "@vellum/authorization";
import type { ApiKeyRecord, SecurityRulesetRecord } from "@vellum/authorization";
import { DocumentEngine } from "@vellum/document-engine";
import { type StorageAdapter, type TenantContext } from "@vellum/storage";
import { DataPlaneStore, PgStorageAdapter } from "@vellum/storage/adapters";
import { createRawPgClient } from "@vellum/database-control";
import { withTenantData } from "../e2e-real/tenant-data-sql.js";

const REAL = process.env.PHASE5_REAL === "1";

const projectId = randomUUID();
const TENANT: TenantContext & { internal: true } = { projectId, internal: true };
const PREFIX = `v2it_${randomUUID().replace(/-/g, "").slice(0, 12)}_`;

/* -------------------------------------------------------------------------- */
/* Harness — memory by default, real Neon under PHASE5_REAL=1                  */
/* -------------------------------------------------------------------------- */

function apiKey(keyType: "public" | "server"): ApiKeyRecord {
  return {
    id: `${keyType}_${PREFIX}`,
    projectId,
    name: `v2-integration-${keyType}`,
    keyType,
    keyPrefix: `${keyType === "public" ? "pk" : "sk"}_v2it`,
    secretHash: "not-a-real-key-in-this-test",
    scopes: keyType === "server" ? ["*"] : ["documents:read"],
    rateLimitRps: 10_000,
    lastUsedAt: null,
    expiresAt: null,
    revokedAt: null,
    createdBy: null,
    createdAt: new Date().toISOString(),
  };
}

const SERVER_KEY = apiKey("server");
const PUBLIC_KEY = apiKey("public");

class MutableControlStore {
  public ruleset: SecurityRulesetRecord | null = null;
  public usage: Array<{ reads: number; writes: number; deletes: number }> = [];

  getActiveRuleset(): SecurityRulesetRecord | null {
    return this.ruleset;
  }
  incrementUsage(
    _projectId: string,
    usage: { documentReads?: number; documentWrites?: number; documentDeletes?: number }
  ): void {
    this.usage.push({
      reads: usage.documentReads ?? 0,
      writes: usage.documentWrites ?? 0,
      deletes: usage.documentDeletes ?? 0,
    });
  }
}

const control = new MutableControlStore();
let store: StorageAdapter;
let engine: DocumentEngine;
let rawClient: Awaited<ReturnType<typeof createRawPgClient>> | undefined;

/** Counting wrapper around the memory adapter's batched relation read. */
class CountingDataPlaneStore extends DataPlaneStore {
  public batchReadCalls = 0;

  override createTxHandle(ctx: TenantContext) {
    const tx = super.createTxHandle(ctx);
    const original = tx.batchGetDocuments?.bind(tx);
    if (!original) return tx;
    return {
      ...tx,
      batchGetDocuments: async (paths: string[]) => {
        this.batchReadCalls += 1;
        return original(paths);
      },
    };
  }
}

const memoryCounter = new CountingDataPlaneStore();

beforeAll(async () => {
  if (REAL) {
    const url = process.env.DATA_DATABASE_URL_DIRECT ?? process.env.DATA_DATABASE_URL;
    if (!url) throw new Error("PHASE5_REAL=1 requires DATA_DATABASE_URL[_DIRECT]");
    // The `pg` adapter is used for real-mode verification (same driver as every
    // other live suites). Neon's WebSocket driver requires a WASM
    // WebSocketConstructor that is not available in the vitest Node runtime.
    store = new PgStorageAdapter({ connectionString: url });
    rawClient = createRawPgClient({
      connectionString: url,
      applicationName: "vellum-v2-integration-data",
    });
    await rawClient.connect();
  } else {
    store = memoryCounter;
  }
  engine = new DocumentEngine({ controlStore: control, dataStore: store });
}, 60_000);

afterAll(async () => {
  if (REAL && rawClient) {
    await withTenantData(rawClient, projectId, async (tx) => {
      await tx.query("DELETE FROM realtime_outbox WHERE project_id = $1::uuid", [projectId]);
      await tx.query("DELETE FROM document_index_entries WHERE project_id = $1::uuid", [projectId]);
      await tx.query("DELETE FROM document_indexes WHERE project_id = $1::uuid", [projectId]);
      await tx.query("DELETE FROM documents WHERE project_id = $1::uuid", [projectId]);
      await tx.query("DELETE FROM transactions WHERE project_id = $1::uuid", [projectId]);
    });
    await rawClient.end();
  }
  await store.close();
}, 60_000);

async function put(path: string, data: Record<string, unknown>, opts: Record<string, unknown> = {}) {
  return engine.createDocument({ ...TENANT, path, data, ...opts });
}

async function indexFieldsOf(collectionPath: string): Promise<IndexAdvisorIndex[]> {
  const rows = await store.listCompositeIndexes(TENANT);
  return rows
    .filter((row) => row.collectionPath === collectionPath)
    .map((row) => ({
      collectionPath: row.collectionPath,
      fields: row.fields.map((field) => ({ path: field.path, dir: field.dir })),
      status: row.status,
    }));
}

/* -------------------------------------------------------------------------- */
/* 1. N+1-free includes                                                        */
/* -------------------------------------------------------------------------- */

describe("V2 relations", () => {
  it("resolves 20 parents -> 20 referenced users with one batch read per parent", async () => {
    const parents: string[] = [];
    for (let i = 0; i < 20; i += 1) {
      const userPath = `${PREFIX}users/u${i}`;
      await put(userPath, { name: `User ${i}`, email: `u${i}@example.test` });
      const parentPath = `${PREFIX}posts/p${i}`;
      parents.push(parentPath);
      await put(parentPath, { title: `Post ${i}`, authorId: { $ref: userPath } });
    }

    const before = memoryCounter.batchReadCalls;
    for (const path of parents) {
      const doc = await engine.getDocument({
        ...TENANT,
        path,
        include: [{ field: "authorId", collection: `${PREFIX}users`, as: "author" }],
      });
      expect(doc._included?.["author"]).toMatchObject({ path: `${PREFIX}users/u${parents.indexOf(path)}` });
      expect(doc.data["author"]).toMatchObject({ path: `${PREFIX}users/u${parents.indexOf(path)}` });
    }

    if (!REAL) {
      // The engine calls the tx-level batch getter once per relation depth —
      // 20 gets spread over 20 separate parent reads must still collapse there.
      expect(memoryCounter.batchReadCalls - before).toBe(20);
    }
  }, 120_000);

  it("resolves a 20-document query page with exactly ONE batch read for the relation depth", async () => {
    const docsBefore = memoryCounter.batchReadCalls;
    await engine.executeQuery({
      ...TENANT,
      querySpec: {
        collectionPath: `${PREFIX}posts`,
        where: [{ field: "title", op: "starts_with_ci", value: "Post" }],
        orderBy: [{ field: "documentId", dir: "asc" }],
        limit: 50,
        include: [{ field: "authorId", collection: `${PREFIX}users`, as: "author" }],
      },
    });
    if (!REAL) {
      expect(memoryCounter.batchReadCalls - docsBefore).toBe(1);
    }
  }, 60_000);
});

/* -------------------------------------------------------------------------- */
/* 2. Unauthorized referenced document redaction                               */
/* -------------------------------------------------------------------------- */

describe("V2 relation redaction", () => {
  it("nulls a reference hidden by public rules and records _redactedRefs", async () => {
    const allowed = `${PREFIX}users/public`;
    const denied = `${PREFIX}users/private`;
    const parent = `${PREFIX}posts/redaction`;
    await put(allowed, { name: "Public User", secret: "none" });
    await put(denied, { name: "Private User", secret: "TOP-SECRET-DO-NOT-LEAK" });
    await put(parent, { title: "Redaction", refs: [{ $ref: allowed }, { $ref: denied }] });

    control.ruleset = {
      rulesAst: {
        version: 1,
        rules: [
          {
            match: `${PREFIX}posts/{postId}`,
            allow: { get: true, list: true },
          },
          {
            match: `${PREFIX}users/{uid}`,
            allow: {
              get: { op: "==", left: { var: "path.uid" }, right: { val: "public" } },
            },
          },
        ],
      },
    } as unknown as SecurityRulesetRecord;

    const singleParent = `${PREFIX}posts/redaction-single`;
    await put(singleParent, { title: "Redaction single", authorId: { $ref: denied } });

    const fetched = await engine.getDocument({
      ...TENANT,
      path: parent,
      apiKeyRecord: PUBLIC_KEY,
      authContext: { uid: "viewer", claims: {} },
      include: [{ field: "refs", collection: `${PREFIX}users`, as: "targets" }],
    });

    const singleFetched = await engine.getDocument({
      ...TENANT,
      path: singleParent,
      apiKeyRecord: PUBLIC_KEY,
      authContext: { uid: "viewer", claims: {} },
      include: [{ field: "authorId", collection: `${PREFIX}users`, as: "author" }],
    });
    expect(singleFetched._included?.["author"]).toBeNull();
    expect(singleFetched._redactedRefs).toContain("author");
    expect(JSON.stringify(singleFetched)).not.toContain("TOP-SECRET-DO-NOT-LEAK");

    expect(fetched._redactedRefs).toContain("targets");
    const included = fetched._included?.["targets"] as Array<{ path: string }>;
    expect(Array.isArray(included)).toBe(true);
    expect(included.map((row) => row.path)).toEqual([allowed]);
    expect(JSON.stringify(fetched)).not.toContain("TOP-SECRET-DO-NOT-LEAK");
    control.ruleset = null;
  }, 60_000);
});

/* -------------------------------------------------------------------------- */
/* 3. Aggregations + groupBy                                                   */
/* -------------------------------------------------------------------------- */

describe("V2 aggregations", () => {
  it("computes count/sum/avg/min/max and a grouped result", async () => {
    const collection = `${PREFIX}metrics`;
    const rows = [
      { team: "red", score: 10 },
      { team: "red", score: 20 },
      { team: "blue", score: 4 },
      { team: "blue", score: 6 },
    ];
    for (const [i, row] of rows.entries()) await put(`${collection}/m${i}`, row);

    const totals = await engine.aggregateDocuments({
      ...TENANT,
      request: {
        collectionPath: collection,
        metrics: {
          count: { op: "count" },
          sum: { op: "sum", field: "score" },
          avg: { op: "avg", field: "score" },
          min: { op: "min", field: "score" },
          max: { op: "max", field: "score" },
        },
      },
    });
    expect(totals.rows).toHaveLength(1);
    const total = totals.rows[0]!;
    expect(Number(total["count"])).toBe(4);
    expect(Number(total["sum"])).toBe(40);
    expect(Number(total["avg"])).toBe(10);
    expect(Number(total["min"])).toBe(4);
    expect(Number(total["max"])).toBe(20);

    const grouped = await engine.aggregateDocuments({
      ...TENANT,
      request: {
        collectionPath: collection,
        groupBy: ["team"],
        metrics: { count: { op: "count" }, sum: { op: "sum", field: "score" } },
      },
    });
    const byTeam = new Map(grouped.rows.map((row) => [String(row["team"]), row]));
    expect(byTeam.size).toBe(2);
    expect(Number(byTeam.get("red")?.["count"])).toBe(2);
    expect(Number(byTeam.get("red")?.["sum"])).toBe(30);
    expect(Number(byTeam.get("blue")?.["sum"])).toBe(10);
  }, 60_000);
});

/* -------------------------------------------------------------------------- */
/* 4. Dot-path select projection                                               */
/* -------------------------------------------------------------------------- */

describe("V2 dot-path projection", () => {
  it("rebuilds nested JSON from select dot paths", async () => {
    const path = `${PREFIX}profiles/proj`;
    await put(path, {
      title: "Projected",
      author: { name: "Ada", email: "private@example.test" },
      stats: { views: 7, hidden: true },
    });

    const doc = await engine.getDocument({
      ...TENANT,
      path,
      select: ["title", "author.name", "stats.views"],
    });
    expect(doc.data).toEqual({
      title: "Projected",
      author: { name: "Ada" },
      stats: { views: 7 },
    });
    expect(JSON.stringify(doc.data)).not.toContain("private@example.test");

    const queried = await engine.executeQuery({
      ...TENANT,
      querySpec: {
        collectionPath: `${PREFIX}profiles`,
        where: [{ field: "title", op: "==", value: "Projected" }],
        select: ["title", "author.name"],
        orderBy: [{ field: "documentId", dir: "asc" }],
      },
    });
    expect(queried.documents[0]?.data).toEqual({ title: "Projected", author: { name: "Ada" } });
  }, 60_000);
});

/* -------------------------------------------------------------------------- */
/* 5. OR groups + CI operators                                                 */
/* -------------------------------------------------------------------------- */

describe("V2 query operators", () => {
  it("matches multi-field OR groups and contains_ci / starts_with_ci / text_search", async () => {
    const collection = `${PREFIX}search`;
    await put(`${collection}/a`, { title: "Hello WORLD", tag: "alpha", region: "eu" });
    await put(`${collection}/b`, { title: "Prefix Card", tag: "beta", region: "us" });
    await put(`${collection}/c`, { title: "Unrelated", tag: "gamma", region: "eu" });

    const orResult = await engine.executeQuery({
      ...TENANT,
      querySpec: {
        collectionPath: collection,
        or: [
          [
            { field: "tag", op: "==", value: "alpha" },
            { field: "region", op: "==", value: "eu" },
          ],
          [{ field: "tag", op: "==", value: "beta" }],
        ],
        orderBy: [{ field: "documentId", dir: "asc" }],
        limit: 50,
      },
    });
    // Group 1 (alpha AND eu) -> a; group 2 (beta) -> b; gamma/eu matches neither.
    expect(orResult.documents.map((doc) => doc.documentId).sort()).toEqual(["a", "b"]);

    const contains = await engine.executeQuery({
      ...TENANT,
      querySpec: {
        collectionPath: collection,
        where: [{ field: "title", op: "contains_ci", value: "world" }],
        orderBy: [{ field: "documentId", dir: "asc" }],
      },
    });
    expect(contains.documents.map((doc) => doc.documentId)).toEqual(["a"]);

    const starts = await engine.executeQuery({
      ...TENANT,
      querySpec: {
        collectionPath: collection,
        where: [{ field: "title", op: "starts_with_ci", value: "pReFiX" }],
        orderBy: [{ field: "documentId", dir: "asc" }],
      },
    });
    expect(starts.documents.map((doc) => doc.documentId)).toEqual(["b"]);

    const text = await engine.executeQuery({
      ...TENANT,
      querySpec: {
        collectionPath: collection,
        where: [{ field: "title", op: "text_search", value: "unrelated" }],
        orderBy: [{ field: "documentId", dir: "asc" }],
      },
    });
    expect(text.documents.map((doc) => doc.documentId)).toEqual(["c"]);
  }, 60_000);
});

/* -------------------------------------------------------------------------- */
/* 6. deleteWhere with rules enforcement                                       */
/* -------------------------------------------------------------------------- */

describe("V2 bulk delete", () => {
  it("enforces delete rules per document and reports deletedCount", async () => {
    const collection = `${PREFIX}bulk`;
    for (let i = 0; i < 5; i += 1) {
      await put(`${collection}/d${i}`, { owner: i % 2 === 0 ? "alice" : "bob", keep: false });
    }

    control.ruleset = {
      rulesAst: {
        version: 1,
        rules: [
          { match: `${collection}/{docId}`, allow: { list: true } },
          {
            match: `${collection}/{docId}`,
            allow: {
              delete: { op: "==", left: { var: "resource.data.owner" }, right: { val: "alice" } },
            },
          },
        ],
      },
    } as unknown as SecurityRulesetRecord;

    const result = await engine.deleteWhere({
      ...TENANT,
      collectionPath: collection,
      // The selection is narrowed to the docs the rule permits, so the
      // per-document `delete` check succeeds for the whole batch.
      where: [{ field: "owner", op: "==", value: "alice" }],
      apiKeyRecord: PUBLIC_KEY,
      authContext: { uid: "alice", claims: {} },
      limit: 10,
    });
    expect(result.deletedCount).toBe(3);

    const remaining = await engine.executeQuery({
      ...TENANT,
      querySpec: { collectionPath: collection, orderBy: [{ field: "documentId", dir: "asc" }] },
    });
    expect(remaining.documents.map((doc) => doc.documentId).sort()).toEqual(["d1", "d3"]);

    control.ruleset = null;
  }, 60_000);

  it("denies the whole bulk delete when a matched document fails its delete rule", async () => {
    const collection = `${PREFIX}bulkdeny`;
    await put(`${collection}/x`, { owner: "alice" });
    control.ruleset = {
      rulesAst: {
        version: 1,
        rules: [
          { match: `${collection}/{docId}`, allow: { list: true, delete: false } },
        ],
      },
    } as unknown as SecurityRulesetRecord;

    await expect(
      engine.deleteWhere({
        ...TENANT,
        collectionPath: collection,
        apiKeyRecord: PUBLIC_KEY,
        limit: 10,
      })
    ).rejects.toMatchObject({ code: "PERMISSION_DENIED" });
    control.ruleset = null;
  }, 60_000);
});

/* -------------------------------------------------------------------------- */
/* 7. TTL auto-expiration + sweeper                                            */
/* -------------------------------------------------------------------------- */

describe("V2 TTL", () => {
  it("hides an expired document on get and query, then physically purges it", async () => {
    const collection = `${PREFIX}ttl`;
    const expiredPath = `${collection}/expired`;
    const livePath = `${collection}/live`;
    // The engine now rejects a past `expiresAt` at the boundary (no attacker-
    // controlled backdated writes). Seed a near-future expiry instead and let
    // the short wait elapse so the row is expired for the read/sweep assertions.
    const nearlyExpired = new Date(Date.now() + 100).toISOString();

    await put(expiredPath, { note: "expired" }, { expiresAt: nearlyExpired });
    await put(livePath, { note: "live" }, { ttlSeconds: 600 });
    await new Promise((resolve) => setTimeout(resolve, 250));

    await expect(engine.getDocument({ ...TENANT, path: expiredPath })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    const visible = await engine.executeQuery({
      ...TENANT,
      querySpec: {
        collectionPath: collection,
        orderBy: [{ field: "documentId", dir: "asc" }],
      },
    });
    expect(visible.documents.map((doc) => doc.documentId)).toEqual(["live"]);

    expect(store.runTtlSweeperWorker).toBeDefined();
    const swept = await store.runTtlSweeperWorker!(1000);
    expect(swept.purgedCount).toBeGreaterThanOrEqual(1);

    const afterSweep = await engine.executeQuery({
      ...TENANT,
      querySpec: {
        collectionPath: collection,
        orderBy: [{ field: "documentId", dir: "asc" }],
      },
    });
    expect(afterSweep.documents.map((doc) => doc.documentId)).toEqual(["live"]);
  }, 60_000);
});

/* -------------------------------------------------------------------------- */
/* 8. Rules DSL compile -> publish -> simulate round trip                      */
/* -------------------------------------------------------------------------- */

describe("V2 Rules DSL round trip", () => {
  it("compiles DSL to a v1 AST, validates it, decompiles and simulates ALLOW/DENY", () => {
    const source = `rules_version = '2';
match /articles/{articleId} {
  allow read: if true;
  allow create: if isSignedIn() && incoming.authorId == auth.uid;
  allow delete: if hasRole('admin');
}`;
    const compiled = compileRulesDsl(source);
    expect(compiled.diagnostics).toEqual([]);
    expect(compiled.ast.version).toBe(1);
    const rule = compiled.ast.rules[0]!;
    expect(rule.match).toBe("/articles/{articleId}");
    expect(Object.keys(rule.allow).sort()).toEqual(["create", "delete", "get", "list"]);

    // "publish" the compiled AST into the control store used by the engine.
    control.ruleset = { rulesAst: compiled.ast } as unknown as SecurityRulesetRecord;
    const roundTripped = compileRulesDsl(decompileRulesAstToDsl(compiled.ast)).ast;
    expect(roundTripped.version).toBe(1);

    const allowed = simulateRuleEvaluation({
      ruleset: control.ruleset.rulesAst as never,
      operation: "create",
      path: "/articles/a1",
      auth: { uid: "u1", claims: {} },
      incomingData: { authorId: "u1" },
    });
    expect(allowed.allowed).toBe(true);
    expect(allowed.matchedRule).toBe("/articles/{articleId}");
    expect(allowed.evaluationTrace.at(-1)).toContain("ALLOW");

    const denied = simulateRuleEvaluation({
      ruleset: control.ruleset.rulesAst as never,
      operation: "create",
      path: "/articles/a1",
      auth: { uid: "u2", claims: {} },
      incomingData: { authorId: "u1" },
    });
    expect(denied.allowed).toBe(false);
    expect(denied.evaluationTrace.at(-1)).toContain("DENY");
    control.ruleset = null;
  });
});

/* -------------------------------------------------------------------------- */
/* 9. Index advisor — suggestion header then covered after applying            */
/* -------------------------------------------------------------------------- */

describe("V2 index advisor", () => {
  it("emits x-vellum-index-url for an uncovered query and none after the index is built", async () => {
    const collection = `${PREFIX}advised`;
    for (let i = 0; i < 10; i += 1) {
      await put(`${collection}/a${i}`, { status: i % 2 === 0 ? "open" : "closed", type: "ticket" });
    }

    const query = {
      collectionPath: collection,
      where: [
        { field: "status", op: "==" },
        { field: "type", op: "==" },
      ],
      orderBy: [] as Array<{ field: string; dir: "asc" | "desc" }>,
    };
    const options = {
      projectId,
      orgId: `org_${PREFIX}`,
      dashboardBaseUrl: "http://127.0.0.1:3000",
    };

    const before = analyzeQueryIndexCoverage(query, await indexFieldsOf(collection), options);
    expect(before.covered).toBe(false);
    expect(before.fingerprint).toMatch(/^[0-9a-f]{64}$/);
    const headers = buildIndexSuggestionHeaders(before);
    expect(headers["x-vellum-index-url"]).toContain("/indexes?suggest=");
    expect(headers["x-vellum-index-suggestion"]).toContain(before.fingerprint!);

    const recommended = before.recommendedFields!;
    expect(recommended).toEqual([
      { path: "status", dir: "asc" },
      { path: "type", dir: "asc" },
    ]);
    await store.createCompositeIndex(TENANT, collection, recommended);
    await store.runIndexBuilderWorker();

    const after = analyzeQueryIndexCoverage(query, await indexFieldsOf(collection), options);
    expect(after.covered).toBe(true);
    expect(buildIndexSuggestionHeaders(after)).toEqual({});
  }, 60_000);
});
