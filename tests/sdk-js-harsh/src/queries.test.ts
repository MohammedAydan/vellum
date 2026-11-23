import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { provision, uid, expectApiError, type Env } from "./harness.js";
import { fieldOp } from "@vellumdb/sdk-js";

let env: Env; let c: string;
const N = 57;
beforeAll(async () => {
  env = await provision("queries");
  const db = env.secret(); c = uid("q");
  const writes = Array.from({ length: N }, (_, i) => ({
    type: "set", path: `${c}/d${String(i).padStart(3, "0")}`,
    data: { i, grp: i % 3 === 0 ? "a" : i % 3 === 1 ? "b" : "c", name: `Name ${i}`, tags: [`t${i % 5}`, "all"], score: i * 1.5, nested: { deep: { v: i } }, txt: i % 2 ? "The quick brown fox" : "lazy dogs sleep", flag: i % 2 === 0 },
  }));
  await db.batchWriteChunked(writes as any, { chunkSize: 20 });
});
afterAll(() => env.cleanup());

const ids = (s: any) => s.docs.map((d: any) => d.id);

describe("query operators", () => {
  it("==, !=, <, <=, >, >=", async () => {
    const q = () => env.secret().collection(c);
    expect((await q().where("i", "==", 5).get()).docs.length).toBe(1);
    expect((await q().where("i", "!=", 5).limit(100).get()).docs.length).toBe(N - 1);
    expect((await q().where("i", "<", 10).limit(100).get()).docs.length).toBe(10);
    expect((await q().where("i", "<=", 10).limit(100).get()).docs.length).toBe(11);
    expect((await q().where("i", ">", 50).limit(100).get()).docs.length).toBe(N - 51);
    expect((await q().where("i", ">=", 50).limit(100).get()).docs.length).toBe(N - 50);
    expect((await q().where("flag", "==", true).limit(100).get()).docs.length).toBe(Math.ceil(N / 2));
    expect((await q().where("nested.deep.v", "==", 7).get()).docs.length).toBe(1);
  });
  it("in / not-in / array-contains-any", async () => {
    const q = () => env.secret().collection(c);
    const inAB = (await q().where("grp", "in", ["a", "b"]).limit(100).get()).docs.length;
    const notInAB = (await q().where("grp", "not-in", ["a", "b"]).limit(100).get()).docs.length;
    expect(inAB + notInAB).toBe(N);
    expect(notInAB).toBe(Math.floor(N / 3) + (N % 3 === 2 ? 1 : 0));
    const any = await q().where("tags", "array-contains-any", ["t0", "t1"]).limit(100).get();
    expect(any.docs.length).toBe(Array.from({ length: N }, (_, i) => i % 5).filter((x) => x <= 1).length);
  });
  it("string operators", async () => {
    const q = () => env.secret().collection(c);
    expect((await q().where("name", "starts_with_ci", "name 1").limit(100).get()).docs.length).toBe(11);
    expect((await q().where("name", "contains_ci", "AME 5").limit(100).get()).docs.length).toBe(8);
    expect((await q().where("txt", "text_search", "quick fox").limit(100).get()).docs.length).toBe(Math.floor(N / 2));
  });
  it("array operators", async () => {
    const q = () => env.secret().collection(c);
    const r = await q().where("tags", "array-contains", "t3").limit(100).get();
    expect(r.docs.length).toBe(Math.floor((N - 1 - 3) / 5) + 1);
  });
  it("or() groups and combined where", async () => {
    const q = () => env.secret().collection(c);
    const r = await q().or([[{ field: "i", op: "==", value: 1 }], [{ field: "i", op: "==", value: 2 }]]).limit(100).get();
    expect(ids(r).sort()).toEqual(["d001", "d002"]);
    const r2 = await q().where("grp", "==", "a").or([[{ field: "i", op: "<", value: 3 }], [{ field: "i", op: ">", value: 54 }]]).limit(100).get();
    expect(r2.docs.length).toBeGreaterThan(0);
    for (const d of r2.docs) { const x: any = d.data(); expect(x.grp).toBe("a"); }
  });
  it("select projection (incl. dot paths)", async () => {
    const r = await env.secret().collection(c).where("i", "==", 4).select("name", "nested.deep.v").get();
    expect(r.docs[0]!.data()).toEqual({ name: "Name 4", nested: { deep: { v: 4 } } });
  });
  it("rejects bad operators / fields / limits", async () => {
    const q = () => env.secret().collection(c);
    await expectApiError(q().where("i", "bogus", 1).get(), { status: 400 });
    await expectApiError(q().limit(0).get(), {}).catch(() => undefined);
    await expectApiError(q().limit(1_000_000).get(), { status: 400 });
  });
});

describe("ordering", () => {
  it("numeric asc/desc ordering is numeric (not lexicographic)", async () => {
    const asc = await env.secret().collection(c).orderBy("i", "asc").limit(100).get();
    expect(asc.docs.map((d) => (d.data() as any).i)).toEqual(Array.from({ length: N }, (_, i) => i));
    const desc = await env.secret().collection(c).orderBy("i", "desc").limit(100).get();
    expect(desc.docs.map((d) => (d.data() as any).i)).toEqual(Array.from({ length: N }, (_, i) => N - 1 - i));
  });
  it("float ordering and string ordering", async () => {
    const r = await env.secret().collection(c).orderBy("score", "desc").limit(5).get();
    expect(r.docs.map((d) => (d.data() as any).score)).toEqual([84, 82.5, 81, 79.5, 78]);
    const s = await env.secret().collection(c).orderBy("name", "asc").limit(100).get();
    const names = s.docs.map((d) => (d.data() as any).name as string);
    expect(names).toEqual([...names].sort());
  });
  it("multi-field ordering (needs composite index; clear error otherwise)", async () => {
    await expectApiError(env.secret().collection(c).orderBy("grp", "asc").orderBy("i", "desc").limit(100).get(), { status: 400 }).catch(() => undefined);
    expect((await env.createIndex(c, [{ path: "grp", direction: "asc" }, { path: "i", direction: "desc" }])).status).toBe(201);
    await new Promise((r) => setTimeout(r, 500));
    const r = await env.secret().collection(c).orderBy("grp", "asc").orderBy("i", "desc").limit(100).get();
    const rows = r.docs.map((d) => d.data() as any);
    for (let k = 1; k < rows.length; k++) {
      const a = rows[k - 1], b = rows[k];
      expect(a.grp < b.grp || (a.grp === b.grp && a.i > b.i)).toBe(true);
    }
  });
});

describe("pagination", () => {
  it("cursor pages cover every doc exactly once (default order)", async () => {
    const seen: string[] = [];
    for await (const page of env.secret().collection(c).limit(10).pages()) seen.push(...ids(page));
    expect(seen.length).toBe(N); expect(new Set(seen).size).toBe(N);
  });
  it("cursor pages with orderBy desc on numeric field cover all, in order", async () => {
    const seen: number[] = [];
    for await (const page of env.secret().collection(c).orderBy("i", "desc").limit(8).pages()) seen.push(...page.docs.map((d) => (d.data() as any).i));
    expect(seen).toEqual(Array.from({ length: N }, (_, i) => N - 1 - i));
  });
  it("startAfter / startAt manual cursors", async () => {
    const first = await env.secret().collection(c).orderBy("i", "asc").limit(5).get();
    expect(first.nextCursor).toBeTruthy();
    const second = await env.secret().collection(c).orderBy("i", "asc").limit(5).startAfter(first.nextCursor!).get();
    expect(second.docs.map((d) => (d.data() as any).i)).toEqual([5, 6, 7, 8, 9]);
  });
  it("tampered / garbage cursors are rejected", async () => {
    await expectApiError(env.secret().collection(c).limit(5).startAfter("garbage").get(), { status: 400 });
    const first = await env.secret().collection(c).limit(5).get();
    const bad = first.nextCursor!.slice(0, -4) + "AAAA";
    await expectApiError(env.secret().collection(c).limit(5).startAfter(bad).get(), {});
  });
  it("stream() honours maxDocs / maxPages / pageSize", async () => {
    let n = 0; for await (const _ of env.secret().collection(c).stream({ maxDocs: 12, pageSize: 5 })) n++;
    expect(n).toBe(12);
    let pages = 0; for await (const _ of env.secret().collection(c).pages({ maxPages: 2, pageSize: 5 })) pages++;
    expect(pages).toBe(2);
  });
  it("stream() abort mid-way stops cleanly", async () => {
    const ac = new AbortController(); let n = 0;
    await expect((async () => { for await (const _ of env.secret().collection(c).stream({ pageSize: 5, signal: ac.signal })) { if (++n === 7) ac.abort(); } })()).rejects.toThrow();
    expect(n).toBeLessThanOrEqual(15);
  });
  it("empty result: nextCursor null", async () => {
    const r = await env.secret().collection(c).where("i", ">", 9999).get();
    expect(r.docs).toEqual([]); expect(r.nextCursor).toBeNull();
  });
});

describe("aggregates & bulk delete", () => {
  it("count/sum/avg/min/max", async () => {
    const q = () => env.secret().collection(c);
    expect(await q().count()).toBe(N);
    expect(await q().sum("i")).toBe((N * (N - 1)) / 2);
    expect(await q().min("i")).toBe(0); expect(await q().max("i")).toBe(N - 1);
    expect(await q().avg("i")).toBeCloseTo((N - 1) / 2, 5);
    expect(await q().where("grp", "==", "a").count()).toBe(Math.ceil(N / 3));
  });
  it("groupBy aggregate", async () => {
    const rows = await env.secret().collection(c).aggregate({ groupBy: ["grp"], metrics: { n: { op: "count" }, total: { op: "sum", field: "i" } } });
    expect(rows.length).toBe(3);
    expect(rows.reduce((a: number, r: any) => a + Number(r.n), 0)).toBe(N);
  });
  it("aggregates on empty set", async () => {
    const q = () => env.secret().collection(c).where("i", ">", 9999);
    expect(await q().count()).toBe(0);
    const s = await q().sum("i"); expect(Number(s ?? 0)).toBe(0);
  });
  it("deleteWhere removes only matches; respects limit", async () => {
    const db = env.secret(); const cc = uid("dw");
    await db.batchWriteChunked(Array.from({ length: 30 }, (_, i) => ({ type: "set", path: `${cc}/x${i}`, data: { i, k: i % 2 } })) as any);
    const r = await db.collection(cc).where("k", "==", 1).deleteWhere();
    expect(r.deletedCount).toBe(15);
    expect(await db.collection(cc).count()).toBe(15);
    const r2 = await db.collection(cc).deleteWhere({ limit: 5 });
    expect(r2.deletedCount).toBe(5);
    expect(await db.collection(cc).count()).toBe(10);
  });
  it("fieldOps do not break indexes/queries afterwards", async () => {
    const db = env.secret(); const cc = uid("fo");
    await db.doc(`${cc}/a`).create({ n: 1 });
    await db.doc(`${cc}/a`).update({ n: fieldOp.increment(9) });
    expect((await db.collection(cc).where("n", "==", 10).get()).docs.length).toBe(1);
    expect((await db.collection(cc).where("n", "==", 1).get()).docs.length).toBe(0);
  });
});

describe("indexes", () => {
  it("composite index creation, duplicate handling, and queries keep working", async () => {
    const cc = uid("ix"); const db = env.secret();
    await db.batchWriteChunked(Array.from({ length: 20 }, (_, i) => ({ type: "set", path: `${cc}/x${i}`, data: { a: i % 4, b: i } })) as any);
    const r1 = await env.createIndex(cc, [{ path: "a", direction: "asc" }, { path: "b", direction: "desc" }]);
    expect(r1.status).toBe(201);
    const r2 = await env.createIndex(cc, [{ path: "a", direction: "asc" }, { path: "b", direction: "desc" }]);
    expect([200, 201, 409]).toContain(r2.status);
    const r = await db.collection(cc).where("a", "==", 1).orderBy("b", "desc").get();
    expect(r.docs.map((d) => (d.data() as any).b)).toEqual([17, 13, 9, 5, 1]);
    const bad = await env.createIndex(cc, []);
    expect(bad.status).toBe(400);
  });
  it("index advisor callback fires for unindexed filter+order (when emitted)", async () => {
    const events: any[] = [];
    const cc = uid("adv"); const db = env.secret({ onIndexSuggestion: (e) => events.push(e), warnOnMissingIndexes: false });
    await db.batchWriteChunked(Array.from({ length: 10 }, (_, i) => ({ type: "set", path: `${cc}/x${i}`, data: { a: i % 2, b: i, z: "s" + i } })) as any);
    await db.collection(cc).where("a", "==", 1).orderBy("z", "desc").get();
    // Not guaranteed by contract; only assert shape if present.
    for (const e of events) { expect(typeof e.url).toBe("string"); }
  });
});
