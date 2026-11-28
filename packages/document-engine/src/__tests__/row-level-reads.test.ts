import { describe, it, expect, beforeEach } from "vitest";
import { DocumentEngine } from "../engine.js";
import { DataPlaneStore } from "@vellum/storage/adapters";
import { VellumError } from "@vellum/core";

const TENANT = { projectId: "11111111-1111-1111-1111-111111111111", internal: true as const };

class Control {
  public ruleset: unknown = null;
  getActiveRuleset() { return this.ruleset; }
  incrementUsage() {}
}

const key = (keyType: "public" | "server") => ({
  id: `${keyType}_test`, projectId: TENANT.projectId, name: keyType, keyType, keyPrefix: `${keyType}_t`, secretHash: "h",
  scopes: ["documents:read", "documents:write"], rateLimitRps: 100, lastUsedAt: null, expiresAt: null, revokedAt: null,
  createdBy: null, createdAt: new Date().toISOString(),
});
const PUBLIC = key("public");
const SERVER = key("server");

const signedIn = { op: "!=", left: { var: "auth.uid" }, right: { val: null } };
const participant = { op: "in", left: { var: "auth.uid" }, right: { var: "resource.data.participantIds" } };

describe("row-level reads: list allow does not expose rows whose get denies", () => {
  let engine: DocumentEngine;
  let control: Control;
  const asC = { ...TENANT, apiKeyRecord: PUBLIC, authContext: { uid: "c", claims: {} } };
  const asA = { ...TENANT, apiKeyRecord: PUBLIC, authContext: { uid: "a", claims: {} } };

  beforeEach(async () => {
    const dataStore = new DataPlaneStore();
    control = new Control();
    engine = new DocumentEngine({ controlStore: control, dataStore });
    for (let i = 0; i < 12; i += 1) {
      await engine.createDocument({ ...TENANT, path: `conversations/c${String(i).padStart(2, "0")}`, data: { n: i, participantIds: i % 3 === 0 ? ["a", "b"] : ["x", "y"] } });
    }
    control.ruleset = { rulesAst: { version: 1, rules: [{ match: "conversations/{id}", allow: { list: signedIn, get: participant } }] } };
  });

  it("a non-participant lists nothing, a participant lists only their rows", async () => {
    const outsider = await engine.executeQuery({ ...asC, querySpec: { collection: "conversations" } });
    expect(outsider.documents).toHaveLength(0);
    const a = await engine.executeQuery({ ...asA, querySpec: { collection: "conversations" } });
    expect(a.documents.map((d) => d.data["n"])).toEqual([0, 3, 6, 9]);
  });

  it("pages stay full and the cursor continues across hidden rows", async () => {
    const seen: number[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < 10; page += 1) {
      const res = (await engine.executeQuery({ ...asA, querySpec: { collection: "conversations", limit: 3, ...(cursor ? { startAfter: cursor } : {}) } })) as { documents: { data: Record<string, unknown> }[]; nextCursor?: string | null };
      for (const d of res.documents) seen.push(d.data["n"] as number);
      cursor = res.nextCursor ?? null;
      if (!cursor) break;
    }
    expect(seen).toEqual([0, 3, 6, 9]);
  });

  it("a server key still sees every row", async () => {
    const res = await engine.executeQuery({ ...TENANT, apiKeyRecord: SERVER, querySpec: { collection: "conversations", limit: 50 } });
    expect(res.documents).toHaveLength(12);
  });

  it("P1-2: member-scoped get rules aggregate over visible rows instead of a blanket 403", async () => {
    // Outsider: no visible rows, count is 0 (not an error).
    const outsider = await engine.aggregateDocuments({
      ...asC,
      request: { collectionPath: "conversations", metrics: { count: { op: "count" } } },
    });
    expect(outsider.rows[0]).toMatchObject({ count: 0 });

    // Participant: count and sum cover exactly the rows a query would return.
    const a = await engine.aggregateDocuments({
      ...asA,
      request: {
        collectionPath: "conversations",
        metrics: { count: { op: "count" }, total: { op: "sum", field: "n" }, biggest: { op: "max", field: "n" } },
      },
    });
    expect(a.rows[0]).toMatchObject({ count: 4, total: 18, biggest: 9 });

    // Filters apply before visibility, exactly like a query.
    const filtered = await engine.aggregateDocuments({
      ...asA,
      request: {
        collectionPath: "conversations",
        where: [{ field: "n", op: ">=", value: 6 }],
        metrics: { count: { op: "count" } },
      },
    });
    expect(filtered.rows[0]).toMatchObject({ count: 2 });

    // A server key still uses the native SQL path and sees every row.
    const server = await engine.aggregateDocuments({ ...TENANT, apiKeyRecord: SERVER, request: { collectionPath: "conversations", metrics: { count: { op: "count" } } } });
    expect(server.rows[0]).toMatchObject({ count: 12 });
  });

  it("P1-2: group-by fallback groups only visible rows", async () => {
    const res = await engine.aggregateDocuments({
      ...asA,
      request: {
        collectionPath: "conversations",
        groupBy: ["participantIds"],
        metrics: { count: { op: "count" } },
      },
    });
    expect(res.rows).toHaveLength(1);
    expect(res.rows[0]).toMatchObject({ count: 4 });
  });

  it("P1-2: the fallback refuses collections past the row-filter cap, and 0 disables it", async () => {
    process.env["VELLUM_AGGREGATE_ROW_FILTER_MAX"] = "2";
    try {
      // Recipe 6 (P1-1.2): a row-limit error, not PERMISSION_DENIED.
      await expect(
        engine.aggregateDocuments({ ...asA, request: { collectionPath: "conversations", metrics: { count: { op: "count" } } } })
      ).rejects.toMatchObject({ code: "FAILED_PRECONDITION", details: { reason: "SCOPED_AGGREGATE_ROW_LIMIT" } });
    } finally {
      delete process.env["VELLUM_AGGREGATE_ROW_FILTER_MAX"];
    }
    process.env["VELLUM_AGGREGATE_ROW_FILTER_MAX"] = "0";
    try {
      await expect(
        engine.aggregateDocuments({ ...asA, request: { collectionPath: "conversations", metrics: { count: { op: "count" } } } })
      ).rejects.toThrow(VellumError);
    } finally {
      delete process.env["VELLUM_AGGREGATE_ROW_FILTER_MAX"];
    }
  });

  it("aggregate is allowed when get does not depend on the document", async () => {
    control.ruleset = { rulesAst: { version: 1, rules: [{ match: "conversations/{id}", allow: { list: signedIn, get: signedIn } }] } };
    const res = await engine.aggregateDocuments({ ...asC, request: { collectionPath: "conversations", metrics: { count: { op: "count" } } } });
    expect(res.rows[0]).toMatchObject({ count: 12 });
  });

  it("a list-only ruleset behaves as before", async () => {
    control.ruleset = { rulesAst: { version: 1, rules: [{ match: "conversations/{id}", allow: { list: signedIn } }] } };
    const res = await engine.executeQuery({ ...asC, querySpec: { collection: "conversations", limit: 50 } });
    expect(res.documents).toHaveLength(12);
  });

  it("export skips rows the caller cannot get", async () => {
    const outsider = await engine.exportCollectionDocuments(asC, "conversations");
    expect(outsider.documents).toHaveLength(0);
    const a = await engine.exportCollectionDocuments(asA, "conversations");
    expect(a.documents).toHaveLength(4);
  });
});

describe("query spec strictness", () => {
  const mk = async () => {
    const engine = new DocumentEngine({ controlStore: new Control(), dataStore: new DataPlaneStore() });
    await engine.createDocument({ ...TENANT, path: "things/a", data: { n: 1 } });
    await engine.createDocument({ ...TENANT, path: "things/b", data: { n: 2 } });
    return engine;
  };
  it("rejects a misspelled key instead of returning every row", async () => {
    const engine = await mk();
    await expect(
      engine.executeQuery({ ...TENANT, querySpec: { collectionPath: "things", wher: [{ field: "n", op: "==", value: 1 }], limit: 10 } as never })
    ).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
  });
  it("rejects collectionGroup with a clear error", async () => {
    const engine = await mk();
    await expect(
      engine.executeQuery({ ...TENANT, querySpec: { collectionGroup: "things", limit: 10 } as never })
    ).rejects.toThrow(/collectionGroup queries are not supported/);
  });
  it("still accepts valid keys", async () => {
    const engine = await mk();
    const res = await engine.executeQuery({ ...TENANT, querySpec: { collectionPath: "things", where: [{ field: "n", op: "==", value: 1 }], limit: 10 } });
    expect(res.documents).toHaveLength(1);
  });
});
