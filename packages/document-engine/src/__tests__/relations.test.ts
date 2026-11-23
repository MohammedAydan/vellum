import { describe, it, expect } from "vitest";
import { VellumError } from "@vellum/core";
import { DataPlaneStore } from "@vellum/storage/adapters";
import {
  createBatchedRelationResolver,
  parseReference,
  resolveIncludes,
  MAX_RELATION_DEPTH,
  type IncludeSpec,
  type RelationDocument,
} from "../relations.js";
import { DocumentEngine } from "../engine.js";

type Enriched = RelationDocument & {
  _included?: Record<string, unknown>;
  _redactedRefs?: string[];
};

function doc(path: string, data: Record<string, unknown>): Enriched {
  return { path, data };
}

function batchFrom(map: Map<string, RelationDocument>) {
  let calls = 0;
  const getDocumentBatch = async (paths: string[]): Promise<RelationDocument[]> => {
    calls += 1;
    return paths.map((p) => map.get(p)).filter((d): d is RelationDocument => d !== undefined);
  };
  return { getDocumentBatch, calls: () => calls };
}

const TENANT = {
  projectId: "11111111-1111-1111-1111-111111111111",
  // Trusted test caller: permits the engine's fail-closed synthetic key path.
  internal: true as const,
};

class NullControlStore {
  getActiveRuleset() {
    return null;
  }
  incrementUsage() {
    /* no-op */
  }
}

// ---------------------------------------------------------------------------
// parseReference
// ---------------------------------------------------------------------------

describe("@vellum/document-engine/relations - parseReference", () => {
  const spec: IncludeSpec = { field: "authorId", collection: "users" };

  it("accepts $ref objects, tagged refs, plain paths and bare ids", () => {
    expect(parseReference({ $ref: "users/uid_123" }, spec)).toBe("users/uid_123");
    expect(parseReference({ $t: "ref", $v: "users/uid_123" }, spec)).toBe("users/uid_123");
    expect(parseReference("users/uid_123", spec)).toBe("users/uid_123");
    expect(parseReference("uid_123", spec)).toBe("users/uid_123");
    expect(parseReference({ $ref: "orgs/o1/users/uid_9" }, spec)).toBe("orgs/o1/users/uid_9");
  });

  it("infers the collection from the field name when no collection is given", () => {
    expect(parseReference("uid_123", { field: "authorId" })).toBe("authors/uid_123");
    expect(parseReference("uid_123", { field: "owner_ref" })).toBe("owners/uid_123");
  });

  it("returns null for non-reference values and malformed paths", () => {
    expect(parseReference(null, spec)).toBeNull();
    expect(parseReference(42, spec)).toBeNull();
    expect(parseReference("", spec)).toBeNull();
    expect(parseReference("/users/x", spec)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Batched resolution
// ---------------------------------------------------------------------------

describe("@vellum/document-engine/relations - batched resolveIncludes", () => {
  it("resolves 20 parents -> 20 targets with exactly ONE logical batch call", async () => {
    const targets = new Map<string, RelationDocument>();
    const parents: Enriched[] = [];
    for (let i = 0; i < 20; i += 1) {
      targets.set(`users/u${i}`, doc(`users/u${i}`, { name: `User ${i}` }));
      parents.push(doc(`posts/p${i}`, { authorId: { $ref: `users/u${i}` } }));
    }
    const batch = batchFrom(targets);
    const resolver = createBatchedRelationResolver({ getDocumentBatch: batch.getDocumentBatch });

    const result = await resolveIncludes({
      docs: parents,
      includes: [{ field: "authorId", collection: "users", as: "author" }],
      getDocument: resolver.getDocument,
      getDocumentBatch: resolver.getDocumentBatch,
      canRead: () => true,
    });

    expect(batch.calls()).toBe(1);
    expect(result.batchCallCount).toBe(1);
    expect(resolver.getStats().batchCallCount).toBe(1);
    expect(result.fetchedPaths).toHaveLength(20);
    expect(parents[0]!._included?.["author"]).toMatchObject({ path: "users/u0" });
    expect(parents[0]!.data["author"]).toMatchObject({ path: "users/u0" });
  });

  it("redacts unauthorized targets without throwing or leaking data", async () => {
    const target = doc("users/secret", { name: "Secret", ssn: "123" });
    const parent = doc("posts/p1", { authorId: { $ref: "users/secret" } });
    const batch = batchFrom(new Map([["users/secret", target]]));

    const result = await resolveIncludes({
      docs: [parent],
      includes: [{ field: "authorId", collection: "users", as: "author" }],
      getDocument: async () => null,
      getDocumentBatch: batch.getDocumentBatch,
      canRead: () => false,
    });

    expect(parent._included?.["author"]).toBeNull();
    expect(parent.data["author"]).toBeNull();
    expect(parent._redactedRefs).toContain("author");
    expect(result.redactedFields).toContain("author");
    expect(JSON.stringify(parent)).not.toContain("Secret");
  });

  it("caps nested expansion at MAX_RELATION_DEPTH", async () => {
    const targets = new Map<string, RelationDocument>([
      ["users/u1", doc("users/u1", { name: "U1", managerId: "users/u2" })],
      ["users/u2", doc("users/u2", { name: "U2", managerId: "users/u3" })],
      ["users/u3", doc("users/u3", { name: "U3", managerId: "users/u4" })],
      ["users/u4", doc("users/u4", { name: "U4" })],
    ]);
    const parent = doc("posts/p1", { authorId: "users/u1" });
    const batch = batchFrom(targets);
    const level3: IncludeSpec = { field: "managerId", collection: "users", as: "manager" };
    const level2: IncludeSpec = { field: "managerId", collection: "users", as: "manager", include: [level3] };
    const level1: IncludeSpec = { field: "authorId", collection: "users", as: "author", include: [level2] };

    const result = await resolveIncludes({
      docs: [parent],
      includes: [level1],
      getDocument: async () => null,
      getDocumentBatch: batch.getDocumentBatch,
      canRead: () => true,
    });

    expect(MAX_RELATION_DEPTH).toBe(3);
    expect(batch.calls()).toBe(3);
    expect(result.batchCallCount).toBe(3);
    const u3 = targets.get("users/u3") as Enriched;
    expect(u3._included).toBeUndefined();
    expect(targets.get("users/u4")).toBeDefined();
  });

  it("stops cycles at the first repeated path", async () => {
    const a = doc("users/a", { friendId: "users/b" });
    const b = doc("users/b", { friendId: "users/a" });
    const batch = batchFrom(
      new Map([
        ["users/a", a],
        ["users/b", b],
      ])
    );
    const parent = doc("posts/p1", { authorId: "users/a" });
    const deepest: IncludeSpec = { field: "friendId", collection: "users", as: "friend" };
    const middle: IncludeSpec = { field: "friendId", collection: "users", as: "friend", include: [deepest] };
    const top: IncludeSpec = { field: "authorId", collection: "users", as: "author", include: [middle] };

    await resolveIncludes({
      docs: [parent],
      includes: [top],
      getDocument: async () => null,
      getDocumentBatch: batch.getDocumentBatch,
      canRead: () => true,
    });

    // Depth 1 fetches users/a, depth 2 fetches users/b, depth 3 sees the
    // repeated users/a and attaches a stub WITHOUT a third fetch.
    expect(batch.calls()).toBe(2);
    expect((parent._included?.["author"] as Enriched)._included?.["friend"]).toMatchObject({ path: "users/b" });
    // 3A: a path expanded at a shallower depth becomes a minimal cycle stub —
    // never `null` — so callers can still see which reference closed the cycle.
    expect(b._included?.["friend"]).toEqual({ _ref: "users/a", _circular: true });
  });

  it("applies select dot-path projection on resolved targets", async () => {
    const target = doc("users/u1", { name: "Alice", email: "secret@x", profile: { city: "Cairo" } });
    const parent = doc("posts/p1", { authorId: "users/u1" });
    const batch = batchFrom(new Map([["users/u1", target]]));

    await resolveIncludes({
      docs: [parent],
      includes: [{ field: "authorId", collection: "users", as: "author", select: ["name", "profile.city"] }],
      getDocument: async () => null,
      getDocumentBatch: batch.getDocumentBatch,
      canRead: () => true,
    });

    // 3A: dot-path selects rebuild nested JSON instead of flat `"a.b"` keys.
    expect((parent._included?.["author"] as Enriched).data).toEqual({
      name: "Alice",
      profile: { city: "Cairo" },
    });
    expect(JSON.stringify(parent)).not.toContain("secret@x");
  });
});

// ---------------------------------------------------------------------------
// Engine integration: security redaction + referential integrity
// ---------------------------------------------------------------------------

describe("@vellum/document-engine/relations - engine integration", () => {
  it("redacts a relation target denied by Security Rules", async () => {
    const publicKey = {
      id: "pk_test",
      projectId: TENANT.projectId,
      name: "public",
      keyType: "public",
      keyPrefix: "pk_test",
      secretHash: "hash",
      scopes: ["documents:read"],
      rateLimitRps: 100,
      lastUsedAt: null,
      expiresAt: null,
      revokedAt: null,
      createdBy: null,
      createdAt: new Date().toISOString(),
    };
    const ruleset = {
      rulesAst: {
        version: 1,
        rules: [
          { match: "posts/{postId}", allow: { get: true } },
          {
            match: "users/{uid}",
            allow: {
              get: { op: "==", left: { var: "path.uid" }, right: { val: "u1" } },
            },
          },
        ],
      },
    };
    const controlStore = {
      getActiveRuleset: () => ruleset,
      incrementUsage: () => undefined,
    };
    const engine = new DocumentEngine({ controlStore, dataStore: new DataPlaneStore() });

    // Setup uses the internal server key (write rules are not defined).
    await engine.createDocument({ ...TENANT, path: "users/u1", data: { name: "Allowed" } });
    await engine.createDocument({ ...TENANT, path: "users/u2", data: { name: "Forbidden" } });
    await engine.createDocument({ ...TENANT, path: "posts/p1", data: { authorId: { $ref: "users/u2" } } });

    const fetched = await engine.getDocument({
      ...TENANT,
      apiKeyRecord: publicKey,
      path: "posts/p1",
      include: [{ field: "authorId", collection: "users", as: "author" }],
    });

    expect(fetched._included?.["author"]).toBeNull();
    expect(fetched._redactedRefs).toContain("author");
    expect(JSON.stringify(fetched)).not.toContain("Forbidden");
  });

  it("resolves include supplied inside a query spec", async () => {
    const engine = new DocumentEngine({ controlStore: new NullControlStore(), dataStore: new DataPlaneStore() });
    await engine.createDocument({ ...TENANT, path: "users/u1", data: { name: "Alice" } });
    await engine.createDocument({
      ...TENANT,
      path: "posts/p1",
      data: { title: "Post", authorId: { $ref: "users/u1" } },
    });

    const result = await engine.executeQuery({
      ...TENANT,
      querySpec: {
        collection: "posts",
        where: [{ field: "title", op: "==", value: "Post" }],
        include: [{ field: "authorId", collection: "users", as: "author" }],
      } as never,
    });

    expect(result.documents).toHaveLength(1);
    expect(result.documents[0]!._included?.["author"]).toMatchObject({ path: "users/u1" });
  });

  it("restrict refuses to delete a referenced document", async () => {
    const engine = new DocumentEngine({ controlStore: new NullControlStore(), dataStore: new DataPlaneStore() });
    await engine.createDocument({ ...TENANT, path: "users/u1", data: { name: "Alice" } });
    await engine.createDocument({
      ...TENANT,
      path: "posts/p1",
      data: { title: "Post", authorId: { $ref: "users/u1" } },
    });

    await expect(
      engine.deleteDocument({
        ...TENANT,
        path: "users/u1",
        relationRules: [{ collection: "posts", field: "authorId", onDelete: "restrict" }],
      })
    ).rejects.toMatchObject({ code: "RELATION_RESTRICT_VIOLATION" });

    const stillThere = await engine.getDocument({ ...TENANT, path: "posts/p1" });
    expect(stillThere.data["authorId"]).toEqual({ $ref: "users/u1" });
  });

  it("restrict errors are sanitized: no paths or fields leak (G1.5)", async () => {
    const engine = new DocumentEngine({ controlStore: new NullControlStore(), dataStore: new DataPlaneStore() });
    await engine.createDocument({ ...TENANT, path: "users/u1", data: { name: "Alice" } });
    await engine.createDocument({
      ...TENANT,
      path: "posts/p1",
      data: { title: "Post", authorId: { $ref: "users/u1" } },
    });

    const failure = await engine
      .deleteDocument({
        ...TENANT,
        path: "users/u1",
        relationRules: [{ collection: "posts", field: "authorId", onDelete: "restrict" }],
      })
      .catch((error: unknown) => error);

    expect(failure).toMatchObject({ code: "RELATION_RESTRICT_VIOLATION" });
    const serialized = JSON.stringify(failure);
    expect(serialized).not.toContain("users/u1");
    expect(serialized).not.toContain("posts/p1");
    expect(serialized).not.toContain("authorId");
  });

  it("rules persisted on the control store apply without explicit ctx.relationRules", async () => {
    const controlStore = new NullControlStore() as NullControlStore & {
      getRelationRules?: () => Array<{ collection: string; field: string; onDelete: "restrict" }>;
    };
    controlStore.getRelationRules = () => [
      { collection: "posts", field: "authorId", onDelete: "restrict" },
    ];
    const engine = new DocumentEngine({ controlStore, dataStore: new DataPlaneStore() });
    await engine.createDocument({ ...TENANT, path: "users/u1", data: { name: "Alice" } });
    await engine.createDocument({
      ...TENANT,
      path: "posts/p1",
      data: { title: "Post", authorId: { $ref: "users/u1" } },
    });

    await expect(engine.deleteDocument({ ...TENANT, path: "users/u1" })).rejects.toMatchObject({
      code: "RELATION_RESTRICT_VIOLATION",
    });
  });

  it("targetCollection scopes a rule to deletes in that collection only", async () => {
    const controlStore = new NullControlStore() as NullControlStore & {
      getRelationRules?: () => Array<{
        collection: string;
        field: string;
        onDelete: "restrict";
        targetCollection: string;
      }>;
    };
    // Rule only fires when the DELETED document is in 'teams', not 'users'.
    controlStore.getRelationRules = () => [
      { collection: "posts", field: "authorId", onDelete: "restrict", targetCollection: "teams" },
    ];
    const engine = new DocumentEngine({ controlStore, dataStore: new DataPlaneStore() });
    await engine.createDocument({ ...TENANT, path: "users/u1", data: { name: "Alice" } });
    await engine.createDocument({
      ...TENANT,
      path: "posts/p1",
      data: { title: "Post", authorId: { $ref: "users/u1" } },
    });

    // Deleting a user must NOT trigger the teams-scoped rule.
    const deleted = await engine.deleteDocument({ ...TENANT, path: "users/u1" });
    expect(deleted.status).toBe("deleted");
  });

  it("set_null nulls dependent references and increments versions", async () => {
    const store = new DataPlaneStore();
    const engine = new DocumentEngine({ controlStore: new NullControlStore(), dataStore: store });
    await engine.createDocument({ ...TENANT, path: "users/u1", data: { name: "Alice" } });
    await engine.createDocument({
      ...TENANT,
      path: "posts/p1",
      data: { title: "Post", authorId: { $ref: "users/u1" } },
    });

    await engine.deleteDocument({
      ...TENANT,
      path: "users/u1",
      relationRules: [{ collection: "posts", field: "authorId", onDelete: "set_null" }],
    });

    const post = await engine.getDocument({ ...TENANT, path: "posts/p1" });
    expect(post.data["authorId"]).toBeNull();
    expect(post.data["title"]).toBe("Post");
    expect(post.version).toBe(2);
    expect(store.outbox.some((e) => e.path === "posts/p1" && e.opType === "updated")).toBe(true);
  });

  it("cascade deletes dependents with tombstones and outbox events", async () => {
    const store = new DataPlaneStore();
    const engine = new DocumentEngine({ controlStore: new NullControlStore(), dataStore: store });
    await engine.createDocument({ ...TENANT, path: "users/u1", data: { name: "Alice" } });
    await engine.createDocument({
      ...TENANT,
      path: "posts/p1",
      data: { title: "Post", authorId: { $ref: "users/u1" } },
    });

    await engine.deleteDocument({
      ...TENANT,
      path: "users/u1",
      relationRules: [{ collection: "posts", field: "authorId", onDelete: "cascade" }],
    });

    await expect(engine.getDocument({ ...TENANT, path: "posts/p1" })).rejects.toThrowError(VellumError);
    expect(store.outbox.some((e) => e.path === "posts/p1" && e.opType === "deleted")).toBe(true);
  });
});
