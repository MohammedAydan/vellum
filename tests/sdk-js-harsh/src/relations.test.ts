import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { reference } from "@vellumdb/sdk-js";
import { provision, uid, expectApiError, type Env } from "./harness.js";

let env: Env;
beforeAll(async () => { env = await provision("rel"); });
afterAll(() => env.cleanup());

describe("includes", () => {
  it("single-doc include, query include, as/select, nested depth, dangling refs, cycles", async () => {
    const db = env.secret(); const p = uid("p"), u = uid("u"), cm = uid("cm");
    await db.doc(`${u}/ada`).create({ name: "Ada", secret: "s", boss: reference(`${u}/bob`) });
    await db.doc(`${u}/bob`).create({ name: "Bob", boss: reference(`${u}/ada`) }); // cycle
    await db.doc(`${p}/p1`).create({ title: "T", author: reference(`${u}/ada`), missing: reference(`${u}/ghost`) });
    const s = await db.doc(`${p}/p1`).get({ include: [{ field: "author", select: ["name"] }] });
    // Known wart: `included` carries the internal record envelope (projectId, sizeBytes, deletedAt, non-ISO timestamps), only `.data` is projected.
    expect((s.included as any).author.data).toEqual({ name: "Ada" });
    expect(JSON.stringify(s.included)).not.toContain('"secret"');
    const q = await db.collection(p).include([{ field: "author", as: "writer", select: ["name"] }, "missing"]).get();
    expect(q.docs[0]!.included).toBeTruthy();
    const nested = await db.doc(`${p}/p1`).get({ include: [{ field: "author", include: [{ field: "boss", include: [{ field: "boss" }] }] }] });
    expect(nested.included).toBeTruthy();
    // Observed: 4-level include nesting is accepted (no depth cap enforced at this size).
    await db.doc(`${p}/p1`).get({ include: [{ field: "author", include: [{ field: "boss", include: [{ field: "boss", include: [{ field: "boss" }] }] }] }] });
    await db.doc(`${cm}/c`).create({ post: `${p}/p1` });
    const plain = await db.doc(`${cm}/c`).get({ include: [{ field: "post" }] });
    expect(plain.included).toBeTruthy();
  });
  it("include honours rules: unreadable targets are redacted, not leaked", async () => {
    const en = await provision("rel-rules");
    await en.setRulesDsl(`
match /pub/{id} { allow read: if true; allow write: if false; }
match /priv/{id} { allow read: if false; allow write: if false; }
`);
    const db = en.secret();
    await db.doc("priv/x").create({ secret: "top" });
    await db.doc("pub/y").create({ ref: reference("priv/x"), ok: 1 });
    const s = await en.pub().doc("pub/y").get({ include: [{ field: "ref" }] });
    expect(JSON.stringify(s.included ?? {})).not.toContain("top");
    expect(s.redactedRefs?.length ?? 0).toBeGreaterThan(0);
    en.cleanup();
  });
  it("referencedBy returns reverse refs with pagination", async () => {
    const db = env.secret(); const t = uid("t"), l = uid("l");
    await db.doc(`${t}/target`).create({ a: 1 });
    for (let i = 0; i < 7; i++) await db.doc(`${l}/l${i}`).create({ to: reference(`${t}/target`) });
    const seen = new Set<string>(); let cursor: string | undefined;
    for (let guard = 0; guard < 10; guard++) {
      const page: any = await db.doc(`${t}/target`).referencedBy({ collection: l, field: "to", limit: 3, cursor });
      for (const d of page.docs ?? page.documents ?? []) seen.add(d.id ?? d.path);
      cursor = page.nextCursor ?? undefined; if (!cursor) break;
    }
    expect(seen.size).toBe(7);
  });
});

describe("relation rules (referential integrity)", () => {
  async function setup(rules: any[]) {
    const en = await provision("rel-int");
    expect((await en.setRelationRules(rules)).status).toBe(200);
    return en;
  }
  it("cascade deletes dependents (and transitive dependents)", async () => {
    const en = await setup([{ collection: "comments", field: "post", onDelete: "cascade" }, { collection: "likes", field: "comment", onDelete: "cascade" }]);
    const db = en.secret();
    await db.doc("posts/p1").create({}); await db.doc("posts/p2").create({});
    for (let i = 0; i < 5; i++) { await db.doc(`comments/c${i}`).create({ post: reference("posts/p1") }); await db.doc(`likes/l${i}`).create({ comment: reference(`comments/c${i}`) }); }
    await db.doc("comments/other").create({ post: reference("posts/p2") });
    await db.doc("posts/p1").delete();
    expect(await db.collection("comments").count()).toBe(1);
    expect(await db.collection("likes").count()).toBe(0);
    en.cleanup();
  });
  it("set_null nulls the field", async () => {
    const en = await setup([{ collection: "items", field: "owner", onDelete: "set_null" }]);
    const db = en.secret();
    await db.doc("owners/o1").create({}); await db.doc("items/i1").create({ owner: reference("owners/o1"), keep: 1 });
    await db.doc("owners/o1").delete();
    const d: any = (await db.doc("items/i1").get()).data();
    expect(d.keep).toBe(1); expect(d.owner ?? null).toBeNull();
    en.cleanup();
  });
  it("restrict blocks delete with 412 RELATION_RESTRICT_VIOLATION until dependents are gone", async () => {
    const en = await setup([{ collection: "orders", field: "customer", onDelete: "restrict" }]);
    const db = en.secret();
    await db.doc("customers/c1").create({}); await db.doc("orders/o1").create({ customer: reference("customers/c1") });
    const e = await expectApiError(db.doc("customers/c1").delete(), { status: 412 });
    expect(e.code).toBe("RELATION_RESTRICT_VIOLATION");
    expect((await db.doc("customers/c1").get()).exists).toBe(true);
    await db.doc("orders/o1").delete();
    await db.doc("customers/c1").delete();
    en.cleanup();
  });
  it("restrict also protects deleteWhere, batchWrite deletes, transactions, and clear()", async () => {
    const en = await setup([{ collection: "orders", field: "customer", onDelete: "restrict" }]);
    const db = en.secret();
    await db.doc("customers/c1").create({}); await db.doc("orders/o1").create({ customer: reference("customers/c1") });
    await expectApiError(db.collection("customers").deleteWhere(), {});
    await expectApiError(db.batchWrite([{ type: "delete", path: "customers/c1" }] as any), {});
    await expectApiError(db.runTransaction(async (tx) => { tx.delete("customers/c1"); }), {});
    expect((await db.doc("customers/c1").get()).exists).toBe(true);
    en.cleanup();
  });
  it("version-checked relation rule updates (If-Match / expectedVersion conflict)", async () => {
    const en = await provision("rel-ver");
    const r1 = await en.setRelationRules([{ collection: "a", field: "b", onDelete: "cascade" }]);
    expect(r1.status).toBe(200);
    const stale = await fetch(`${process.env.VELLUM_TEST_ENDPOINT ?? "http://127.0.0.1:18080"}/v1/projects/${en.projectId}/relation-rules`, { method: "PUT", headers: { "content-type": "application/json", authorization: `Bearer ${en.consoleToken}` }, body: JSON.stringify({ rules: [], expectedVersion: 0 }) });
    expect(stale.status).toBe(409);
    en.cleanup();
  });
  it("invalid relation rules rejected", async () => {
    const en = await provision("rel-bad");
    expect((await en.setRelationRules([{ collection: "", field: "x", onDelete: "cascade" }])).status).toBe(400);
    expect((await en.setRelationRules([{ collection: "a", field: "x", onDelete: "explode" }])).status).toBe(400);
    en.cleanup();
  });
});
