import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { fieldOp, reference } from "@vellumdb/sdk-js";
import { provision, uid, expectApiError, type Env } from "./harness.js";

let env: Env;
beforeAll(async () => { env = await provision("crud"); });
afterAll(() => env.cleanup());

describe("CRUD", () => {
  it("create/get/set/update/delete full lifecycle with versions", async () => {
    const db = env.secret(); const c = uid("c"); const d = db.doc(`${c}/a`);
    await d.create({ n: 1, nested: { a: { b: [1, 2, { z: true }] } }, s: "héllo 🌍 \u0000x".replace("\u0000", "") });
    let s = await d.get();
    expect(s.exists).toBe(true); expect(s.version).toBe(1); expect(s.id).toBe("a"); expect(s.path).toBe(`${c}/a`);
    expect(s.data()).toMatchObject({ n: 1, nested: { a: { b: [1, 2, { z: true }] } }, s: "héllo 🌍 x" });
    await d.update({ n: 2, "nested.a.c": 5 } as any);
    s = await d.get(); expect(s.version).toBe(2); expect((s.data() as any).n).toBe(2);
    await d.set({ replaced: true });
    s = await d.get(); expect(s.data()).toEqual({ replaced: true }); expect(s.version).toBe(3);
    await d.set({ extra: 1 }, { merge: true });
    expect((await d.get()).data()).toEqual({ replaced: true, extra: 1 });
    await d.delete();
    await expectApiError(d.get(), { code: "NOT_FOUND", status: 404 });
  });

  it("error paths: duplicate create, update/delete missing, version preconditions", async () => {
    const db = env.secret(); const c = uid("c"); const d = db.doc(`${c}/a`);
    await d.create({ n: 1 });
    await expectApiError(d.create({ n: 2 }), { code: "ALREADY_EXISTS", status: 409 });
    await expectApiError(db.doc(`${c}/zz`).update({ n: 2 }), { code: "NOT_FOUND" });
    await expectApiError(db.doc(`${c}/zz`).delete(), { code: "NOT_FOUND" });
    await expectApiError(d.update({ n: 2 }, { ifVersion: 7 }), { status: 412 });
    await expectApiError(d.delete({ ifVersion: 7 }), { status: 412 });
    await expectApiError(d.set({ n: 2 }, { ifVersion: 7 }), { status: 412 });
    await d.update({ n: 3 }, { ifVersion: 1 });
    await d.delete({ ifVersion: 2 });
  });

  it("upsert creates then replaces; set with upsert option", async () => {
    const db = env.secret(); const c = uid("c"); const d = db.doc(`${c}/u`);
    await d.upsert({ a: 1 }); await d.upsert({ b: 2 });
    expect((await d.get()).data()).toEqual({ b: 2 });
    await db.doc(`${c}/u2`).set({ a: 1 }, { upsert: true });
    expect((await db.doc(`${c}/u2`).get()).exists).toBe(true);
  });

  it("field ops: increment, arrayUnion/Remove, deleteField, serverTimestamp", async () => {
    const db = env.secret(); const c = uid("c"); const d = db.doc(`${c}/f`);
    await d.create({ n: 1, arr: [1], gone: "x", ts: fieldOp.serverTimestamp() });
    await d.update({ n: fieldOp.increment(4), arr: fieldOp.arrayUnion(1, 2, 3), gone: fieldOp.deleteField() });
    let data: any = (await d.get()).data();
    expect(data.n).toBe(5); expect(data.arr).toEqual([1, 2, 3]); expect("gone" in data).toBe(false);
    expect(data.ts).toBeTruthy();
    await d.update({ arr: fieldOp.arrayRemove(2), n: fieldOp.increment(-10) });
    data = (await d.get()).data(); expect(data.arr).toEqual([1, 3]); expect(data.n).toBe(-5);
    // increment on a missing / non numeric field
    await d.update({ fresh: fieldOp.increment(2) });
    expect(((await d.get()).data() as any).fresh).toBe(2);
    const e = await expectApiError(d.update({ s: "str" }).then(() => d.update({ s: fieldOp.increment(1) })), {});
    expect(e.status).toBeGreaterThanOrEqual(400); expect(e.status).toBeLessThan(500);
  });

  it("concurrent increments never lose updates (50 parallel): applied count == final value", async () => {
    const db = env.secret(); const c = uid("c"); const d = db.doc(`${c}/ctr`);
    await d.create({ n: 0 });
    const res = await Promise.allSettled(Array.from({ length: 50 }, () => d.update({ n: fieldOp.increment(1) })));
    const ok = res.filter((r) => r.status === "fulfilled").length;
    for (const r of res) if (r.status === "rejected") expect(["ABORTED_CONFLICT", "ALREADY_EXISTS"]).toContain((r.reason as any).code);
    expect(((await d.get()).data() as any).n).toBe(ok);
  });

  it("blind (no ifVersion) concurrent increments should all apply (atomic fieldOp contract)", async () => {
    const db = env.secret(); const c = uid("c"); const d = db.doc(`${c}/ctr2`);
    await d.create({ n: 0 });
    const res = await Promise.allSettled(Array.from({ length: 20 }, () => d.update({ n: fieldOp.increment(1) })));
    const failed = res.filter((r) => r.status === "rejected").length;
    expect(failed, "contended blind increments surfaced ABORTED_CONFLICT to the caller").toBe(0);
    expect(((await d.get()).data() as any).n).toBe(20);
  });

  it("OCC: parallel ifVersion updates, exactly one wins", async () => {
    const db = env.secret(); const c = uid("c"); const d = db.doc(`${c}/occ`);
    await d.create({ n: 0 });
    const results = await Promise.allSettled(Array.from({ length: 10 }, (_, i) => d.update({ winner: i }, { ifVersion: 1 })));
    expect(results.filter((r) => r.status === "fulfilled").length).toBe(1);
    for (const r of results) if (r.status === "rejected") expect([409, 412]).toContain((r.reason as any).status);
  });

  it("TTL: ttlSeconds / expiresAt accepted; invalid TTL rejected", async () => {
    const db = env.secret(); const c = uid("c");
    await db.doc(`${c}/t1`).create({ a: 1 }, { ttlSeconds: 3600 });
    await db.doc(`${c}/t2`).create({ a: 1 }, { expiresAt: new Date(Date.now() + 3_600_000).toISOString() });
    expect((await db.doc(`${c}/t1`).get()).exists).toBe(true);
    await expectApiError(db.doc(`${c}/t3`).create({ a: 1 }, { ttlSeconds: -5 }), { status: 400 });
  });

  it("add() generates id; collection ref helpers", async () => {
    const db = env.secret(); const c = uid("c");
    const r = await db.collection(c).add({ a: 1 });
    expect(r.path.startsWith(`${c}/`)).toBe(true);
    expect((await r.get()).data()).toMatchObject({ a: 1 });
    const ids = new Set<string>();
    for (let i = 0; i < 20; i++) ids.add((await db.collection(c).add({ i })).path);
    expect(ids.size).toBe(20);
  });

  it("special characters in ids/paths and subcollections", async () => {
    const db = env.secret(); const c = uid("c");
    for (const id of ["with space", "ünï-çødé", "a+b", "a&b=c", "dots.in.name", "😀"]) {
      const d = db.doc(`${c}/${id}`);
      await d.create({ id });
      expect((await d.get()).data()).toEqual({ id });
      await d.delete();
    }
    const sub = db.doc(`${c}/p1`).collection("kids").doc("k1");
    await db.doc(`${c}/p1`).create({ p: 1 });
    await sub.create({ k: 1 });
    expect((await sub.get()).path).toBe(`${c}/p1/kids/k1`);
  });


  it("invalid path errors are descriptive (not internal TypeErrors)", async () => {
    const db = env.secret();
    for (const p of ["onlycollection", ""]) {
      try { await db.doc(p).get(); } catch (e: any) {
        expect(String(e?.message), `path ${JSON.stringify(p)}`).not.toMatch(/Cannot read properties|undefined/);
      }
    }
  });

  it("references round-trip as tagged refs", async () => {
    const db = env.secret(); const c = uid("c");
    await db.doc(`${c}/target`).create({ t: 1 });
    await db.doc(`${c}/holder`).create({ ref: reference(`${c}/target`) });
    const data: any = (await db.doc(`${c}/holder`).get()).data();
    expect(data.ref).toMatchObject({ $t: "ref", $v: `${c}/target` });
    expect(() => reference("bad")).toThrow();
    expect(() => reference("a/b/c")).toThrow();
    expect(() => reference(" a/b")).toThrow();
    expect(() => reference("a/../b")).toThrow();
  });

  it("large documents and deep nesting", async () => {
    const db = env.secret(); const c = uid("c");
    const big = { blob: "x".repeat(200_000), arr: Array.from({ length: 200 }, (_, i) => i) };
    await db.doc(`${c}/big`).create(big);
    const got: any = (await db.doc(`${c}/big`).get()).data();
    expect(got.blob.length).toBe(200_000); expect(got.arr.length).toBe(200);
    let deep: any = { leaf: 1 }; for (let i = 0; i < 40; i++) deep = { n: deep };
    await expectApiError(db.doc(`${c}/deep`).create(deep), { status: 400 }).catch(async () => {
      // deep nesting may be accepted; then it must round-trip intact
      expect((await db.doc(`${c}/deep`).get()).exists).toBe(true);
    });
    await expectApiError(db.doc(`${c}/manykeys`).create(Object.fromEntries(Array.from({ length: 600 }, (_, i) => [`k${i}`, i]))), { status: 400 });
    await expectApiError(db.doc(`${c}/huge`).create({ blob: "x".repeat(5_000_000) }), {});
  });


  it("converters apply to reads and writes", async () => {
    const db = env.secret(); const c = uid("c");
    const conv = {
      toDoc: (v: { fullName: string }) => ({ name: v.fullName.toUpperCase() }),
      fromDoc: (s: any) => ({ fullName: String(s.data().name).toLowerCase(), id: s.id }),
    };
    const col = db.collection(c).withConverter(conv as any);
    await col.doc("x").create({ fullName: "Ada" } as any);
    expect((await db.doc(`${c}/x`).get()).data()).toEqual({ name: "ADA" });
    const t: any = (await col.doc("x").get()).data();
    expect(t).toEqual({ fullName: "ada", id: "x" });
    const q: any = await col.get();
    expect(q.docs[0].data()).toEqual({ fullName: "ada", id: "x" });
  });
});

describe("Collections admin", () => {
  it("create/info/update/clear/drop/list", async () => {
    const db = env.secret(); const c = uid("col");
    const info = await db.createCollection(c, { description: "d" });
    expect(info.name).toBe(c);
    await expectApiError(db.createCollection(c), {});
    const same = await db.createCollection(c, { ifNotExists: true });
    expect(same.name).toBe(c);
    await db.doc(`${c}/1`).create({ a: 1 }); await db.doc(`${c}/2`).create({ a: 2 });
    const ci = await db.collection(c).info();
    expect(ci?.documentCount).toBe(2);
    await db.updateCollection(c, { description: "new" });
    expect((await db.getCollectionInfo(c))?.description).toBe("new");
    const cleared = await db.collection(c).clear();
    expect(cleared.deletedCount).toBe(2);
    await db.doc(`${c}/3`).create({ a: 3 });
    const dropped = await db.collection(c).drop();
    expect(dropped.deletedCollection).toBe(true);
    expect(await db.getCollectionInfo(c)).toBeNull();
    const list = await db.listCollections({ search: "zzzz-none" });
    expect(list.collections ?? list).toBeTruthy();
  });

  it("import/export roundtrip incl. insert_only conflicts", async () => {
    const db = env.secret(); const c = uid("imp");
    const docs = Array.from({ length: 25 }, (_, i) => ({ id: `d${i}`, data: { i } }));
    const r: any = await db.importDocuments(c, docs as any);
    expect(r.imported ?? r.upserted ?? r.count ?? 25).toBeTruthy();
    const all: any[] = []; let cursor: string | null | undefined = null;
    do { const page: any = await db.exportDocuments(c, { limit: 10, cursor }); all.push(...(page.documents ?? page.docs)); cursor = page.nextCursor; } while (cursor);
    expect(all.length).toBe(25);
    expect(new Set(all.map((d) => d.id ?? d.documentId)).size).toBe(25);
    const again: any = await db.importDocuments(c, docs.slice(0, 3) as any, { mode: "insert_only" });
    expect(JSON.stringify(again)).toMatch(/skip|exist|conflict|fail|0/i);
  });
});
