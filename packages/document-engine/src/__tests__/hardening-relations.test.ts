/**
 * ENGINE-HARDENING §6 & §10 — cascade semantics and relation projection/i18n.
 */
import { describe, it, expect } from "vitest";
import { VellumError } from "@vellum/core";
import {
  createBatchedRelationResolver,
  parseReference,
  projectIncludedDoc,
  resolveIncludes,
  type RelationDocument,
} from "../relations.js";
import { createFixture, publicKey, TENANT } from "./_harness.js";

const CASCADE = [{ collection: "posts", field: "authorId", onDelete: "cascade" as const }];
const RESTRICT = [{ collection: "posts", field: "authorId", onDelete: "restrict" as const }];
const SET_NULL = [{ collection: "posts", field: "authorId", onDelete: "set_null" as const }];

describe("hardening/relations — cascade inside a single batch (read-your-writes)", () => {
  it("cascade observes a dependent CREATED earlier in the same batch", async () => {
    const { engine, store } = createFixture();
    await engine.createDocument({ ...TENANT, path: "users/u1", data: { name: "Alice" } });

    await engine.batchWrite({
      ...TENANT,
      relationRules: CASCADE,
      writes: [
        {
          type: "create",
          path: "posts/p1",
          data: { title: "New", authorId: { $ref: "users/u1" } },
        },
        { type: "delete", path: "users/u1" },
      ],
    });

    // Both the target and the just-created dependent must be tombstoned
    // atomically — the staged row must participate in dependent discovery.
    const deletedPaths = store.outbox.filter((e) => e.opType === "deleted").map((e) => e.path);
    expect(deletedPaths).toContain("users/u1");
    expect(deletedPaths).toContain("posts/p1");
    await expect(engine.getDocument({ ...TENANT, path: "posts/p1" })).rejects.toThrow(VellumError);
  });

  it("a staged set_null removes the reference before a restrict delete", async () => {
    const { engine, store } = createFixture();
    await engine.createDocument({ ...TENANT, path: "users/u1", data: { name: "Alice" } });
    await engine.createDocument({
      ...TENANT,
      path: "posts/p1",
      data: { authorId: { $ref: "users/u1" } },
    });

    await engine.batchWrite({
      ...TENANT,
      relationRules: RESTRICT,
      writes: [
        { type: "update", path: "posts/p1", data: { authorId: null } },
        { type: "delete", path: "users/u1" },
      ],
    });

    expect((await engine.getDocument({ ...TENANT, path: "posts/p1" })).data["authorId"]).toBeNull();
    expect(store.outbox.some((e) => e.path === "users/u1" && e.opType === "deleted")).toBe(true);
  });

  it("restrict blocks the delete and rolls back the whole batch", async () => {
    const { engine, store } = createFixture();
    await engine.createDocument({ ...TENANT, path: "users/u1", data: { name: "Alice" } });
    await engine.createDocument({
      ...TENANT,
      path: "posts/p1",
      // NOTE: the memory adapter's listDependentsByReference matches plain
      // strings and `{_ref}`; dollar-tagged `{$ref}` is an in-flight 1B/4A gap.
      data: { authorId: "users/u1" },
    });
    const before = store.outbox.length;

    await expect(
      engine.batchWrite({
        ...TENANT,
        relationRules: RESTRICT,
        writes: [
          { type: "create", path: "posts/p2", data: { ok: true } },
          { type: "delete", path: "users/u1" },
        ],
      })
    ).rejects.toMatchObject({ code: "RELATION_RESTRICT_VIOLATION" });

    expect(store.outbox).toHaveLength(before);
    expect(await engine.getDocument({ ...TENANT, path: "posts/p2" }).catch(() => null)).toBeNull();
  });

  it("set_null nulls dependents and emits an updated outbox event", async () => {
    const { engine, store } = createFixture();
    await engine.createDocument({ ...TENANT, path: "users/u1", data: { name: "Alice" } });
    await engine.createDocument({
      ...TENANT,
      path: "posts/p1",
      data: { title: "Post", authorId: "users/u1" },
    });

    await engine.deleteDocument({
      ...TENANT,
      path: "users/u1",
      relationRules: SET_NULL,
    });

    const post = await engine.getDocument({ ...TENANT, path: "posts/p1" });
    expect(post.data["authorId"]).toBeNull();
    expect(post.version).toBe(2);
    expect(store.outbox.some((e) => e.path === "posts/p1" && e.opType === "updated")).toBe(true);
  });

  it("cascade writes tombstones with bumped versions and deleted outbox events", async () => {
    const { engine, store } = createFixture();
    await engine.createDocument({ ...TENANT, path: "users/u1", data: { name: "Alice" } });
    await engine.createDocument({
      ...TENANT,
      path: "posts/p1",
      data: { authorId: "users/u1" },
    });

    await engine.deleteDocument({ ...TENANT, path: "users/u1", relationRules: CASCADE });

    const tombstone = await store.getDocument(TENANT, "posts/p1", { includeSoftDeleted: true });
    expect(tombstone?.deletedAt).toBeTruthy();
    expect(tombstone?.version).toBe(2);
    expect(store.outbox.some((e) => e.path === "posts/p1" && e.opType === "deleted")).toBe(true);
  });
});

describe("hardening/relations — projection, plural inference and cycle stubs", () => {
  it("projectIncludedDoc rebuilds nested select paths", () => {
    const doc: RelationDocument = {
      path: "posts/p1",
      data: {
        title: "Post",
        author: { name: "Ada", email: "secret@x" },
        stats: { views: 7, likes: 9 },
      },
    };
    const projected = projectIncludedDoc(doc, ["title", "author.name", "stats.views"]);
    expect(projected.data).toEqual({
      title: "Post",
      author: { name: "Ada" },
      stats: { views: 7 },
    });
    expect(JSON.stringify(projected)).not.toContain("secret@x");
  });

  it("inferCollectionFromField handles irregular and -s/-x/-z/-ch plurals", () => {
    const cases: Array<[string, string]> = [
      ["childId", "children"],
      ["person_ref", "people"],
      ["addressId", "addresses"],
      ["statusId", "statuses"],
      ["categoryId", "categories"],
      ["companyId", "companies"],
      ["entryId", "entries"],
      ["boxId", "boxes"],
      ["watchId", "watches"],
      ["buzzId", "buzzes"],
      ["authorId", "authors"],
      ["booksId", "books"],
    ];
    for (const [field, collection] of cases) {
      expect(parseReference("sample", { field })).toBe(`${collection}/sample`);
    }
  });

  it("cycles emit a { _ref, _circular: true } stub, never null", async () => {
    const a: RelationDocument = { path: "users/a", data: { friendId: "users/b" } };
    const b: RelationDocument = { path: "users/b", data: { friendId: "users/a" } };
    const byPath = new Map([
      ["users/a", a],
      ["users/b", b],
    ]);
    const parent: RelationDocument = { path: "posts/p1", data: { authorId: "users/a" } };
    const deepest = { field: "friendId", collection: "users", as: "friend" };
    const middle = { field: "friendId", collection: "users", as: "friend", include: [deepest] };
    const top = { field: "authorId", collection: "users", as: "author", include: [middle] };

    await resolveIncludes({
      docs: [parent],
      includes: [top],
      getDocument: async () => null,
      getDocumentBatch: async (paths) =>
        paths.map((p) => byPath.get(p)).filter((d): d is RelationDocument => d !== undefined),
      canRead: () => true,
    });

    const bWithIncludes = b as RelationDocument & { _included?: Record<string, unknown> };
    expect(bWithIncludes._included?.["friend"]).toEqual({ _ref: "users/a", _circular: true });
  });

  it("denied targets populate _redactedRefPaths with exact paths (no data leak)", async () => {
    const ruleset = {
      rulesAst: {
        version: 1,
        rules: [
          { match: "posts/{p}", allow: { get: true } },
          {
            match: "users/{uid}",
            allow: { get: { op: "==", left: { var: "path.uid" }, right: { val: "allowed" } } },
          },
        ],
      },
    };
    const { engine } = createFixture({ ruleset });
    await engine.createDocument({ ...TENANT, path: "users/allowed", data: { name: "Visible" } });
    await engine.createDocument({ ...TENANT, path: "users/secret", data: { name: "Forbidden", ssn: "000" } });
    await engine.createDocument({
      ...TENANT,
      path: "posts/p1",
      data: { authorId: { $ref: "users/secret" } },
    });

    const doc = await engine.getDocument({
      ...TENANT,
      apiKeyRecord: publicKey(),
      path: "posts/p1",
      include: [{ field: "authorId", collection: "users", as: "author" }],
    });
    expect(doc._redactedRefs).toContain("author");
    expect(doc._redactedRefPaths).toContain("users/secret");
    expect(JSON.stringify(doc)).not.toContain("Forbidden");
    expect(JSON.stringify(doc)).not.toContain("000");
  });

  it("createBatchedRelationResolver issues one batch call for shared targets", async () => {
    let calls = 0;
    const resolver = createBatchedRelationResolver<RelationDocument>({
      getDocumentBatch: async (paths) => {
        calls += 1;
        return paths.map((p) => ({ path: p, data: { id: p } }));
      },
    });
    const rows = await resolver.getDocumentBatch(["users/a", "users/b", "users/a"]);
    expect(rows).toHaveLength(2);
    expect(calls).toBe(1);
    expect(resolver.getStats().batchCallCount).toBe(1);
  });
});


describe("relation path contract", () => {
  it("accepts an API-valid reference path longer than 1536 characters", () => {
    const path = `${"c".repeat(1023)}/${"d".repeat(1024)}`;
    expect(path).toHaveLength(2048);
    expect(parseReference({ $ref: path }, { field: "author" })).toBe(path);
    expect(parseReference({ $ref: path + "x" }, { field: "author" })).toBeNull();
  });
});
