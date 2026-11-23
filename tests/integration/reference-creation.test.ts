import { describe, expect, it } from "vitest";
import { TaggedReferenceSchema } from "@vellum/api-contract";
import { reference } from "@vellumdb/sdk-js";
import { createFixture, OTHER_TENANT, publicKey, TENANT } from "../../packages/document-engine/src/__tests__/_harness.js";

const tagged = (path: string) => TaggedReferenceSchema.parse(reference(path));

describe("canonical document relationship creation", () => {
  it("creates scalar and array references through normal writes and expands them", async () => {
    const { engine, store } = createFixture();
    await engine.createDocument({ ...TENANT, path: "users/u1", data: { name: "Ada" } });
    await engine.createDocument({ ...TENANT, path: "users/u2", data: { name: "Sam" } });
    await engine.createDocument({ ...TENANT, path: "posts/p1", data: {
      author: tagged("users/u1"), readers: [tagged("users/u2")],
    } });
    const post = await engine.getDocument({ ...TENANT, path: "posts/p1", include: [{ field: "author" }, { field: "readers" }] });
    expect(post._included?.["author"]).toMatchObject({ path: "users/u1", data: { name: "Ada" } });
    expect(post._included?.["readers"]).toMatchObject([{ path: "users/u2" }]);
    const page = await engine.executeQuery({ ...TENANT, querySpec: { collectionPath: "posts", include: [{ field: "author" }] } });
    expect(page.documents[0]?._included?.["author"]).toMatchObject({ path: "users/u1" });
    const reverse = await engine.referencedBy({ ...TENANT, request: { targetPath: "users/u1", collection: "posts", field: "author" } });
    expect(reverse.documents.map((doc) => doc.path)).toEqual(["posts/p1"]);
    expect(store.outbox.some((event) => event.path === "posts/p1" && event.opType === "created")).toBe(true);
  });
  it("reassigns and unlinks a relation without modifying the target", async () => {
    const { engine } = createFixture();
    for (const id of ["u1", "u2"]) await engine.createDocument({ ...TENANT, path: `users/${id}`, data: { id } });
    await engine.createDocument({ ...TENANT, path: "posts/p1", data: { author: tagged("users/u1") } });
    await engine.updateDocument({ ...TENANT, path: "posts/p1", data: { author: tagged("users/u2") } });
    expect((await engine.getDocument({ ...TENANT, path: "posts/p1", include: [{ field: "author" }] }))._included?.["author"]).toMatchObject({ path: "users/u2" });
    await engine.updateDocument({ ...TENANT, path: "posts/p1", data: { author: null } });
    expect((await engine.getDocument({ ...TENANT, path: "posts/p1" })).data["author"]).toBeNull();
    expect((await engine.getDocument({ ...TENANT, path: "users/u1" })).data["id"]).toBe("u1");
  });
  it("never resolves a reference from another project, including missing local targets", async () => {
    const { engine } = createFixture();
    await engine.createDocument({ ...OTHER_TENANT, path: "users/u1", data: { secret: "other-project" } });
    await engine.createDocument({ ...TENANT, path: "posts/p1", data: { author: tagged("users/u1") } });
    const post = await engine.getDocument({ ...TENANT, path: "posts/p1", include: [{ field: "author" }] });
    expect(post._included?.["author"]).toBeNull();
    expect(JSON.stringify(post)).not.toContain("other-project");
  });
  it("redacts a canonical reference when the caller cannot read the target", async () => {
    const { engine, control } = createFixture();
    await engine.createDocument({ ...TENANT, path: "users/u1", data: { secret: "hidden-target" } });
    await engine.createDocument({ ...TENANT, path: "posts/p1", data: { author: tagged("users/u1") } });
    control.ruleset = { rulesAst: { version: 1, rules: [{ match: "posts/{id}", allow: { get: true, list: true } }] } };
    const post = await engine.getDocument({ ...TENANT, path: "posts/p1", apiKeyRecord: publicKey(),
      authContext: { uid: "viewer", claims: {} }, include: [{ field: "author" }] });
    expect(post._included?.["author"]).toBeNull();
    expect(post._redactedRefs).toContain("author");
    expect(JSON.stringify(post)).not.toContain("hidden-target");
  });
  it.each(["restrict", "set_null", "cascade"] as const)("honors existing %s delete rules for canonical values", async (onDelete) => {
    const { engine } = createFixture();
    await engine.createDocument({ ...TENANT, path: "users/u1", data: {} });
    await engine.createDocument({ ...TENANT, path: "posts/p1", data: { author: tagged("users/u1") } });
    const deletion = engine.deleteDocument({ ...TENANT, path: "users/u1", relationRules: [{ collection: "posts", field: "author", targetCollection: "users", onDelete }] });
    if (onDelete === "restrict") {
      await expect(deletion).rejects.toMatchObject({ code: "RELATION_RESTRICT_VIOLATION" });
      expect((await engine.getDocument({ ...TENANT, path: "posts/p1" })).data["author"]).toEqual(tagged("users/u1"));
    } else {
      await deletion;
      if (onDelete === "cascade") await expect(engine.getDocument({ ...TENANT, path: "posts/p1" })).rejects.toMatchObject({ code: "NOT_FOUND" });
      else expect((await engine.getDocument({ ...TENANT, path: "posts/p1" })).data["author"]).toBeNull();
    }
  });
});
