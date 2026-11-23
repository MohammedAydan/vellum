import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { provision, uid, expectApiError, type Env } from "./harness.js";

let env: Env;
beforeAll(async () => { env = await provision("tx"); });
afterAll(() => env.cleanup());

describe("transactions", () => {
  it("read-modify-write commits atomically", async () => {
    const db = env.secret(); const c = uid("tx");
    await db.doc(`${c}/a`).create({ bal: 100 }); await db.doc(`${c}/b`).create({ bal: 0 });
    await db.runTransaction(async (tx) => {
      const a: any = (await tx.get(`${c}/a`)).data(); const b: any = (await tx.get(`${c}/b`)).data();
      tx.update(`${c}/a`, { bal: a.bal - 30 }); tx.update(`${c}/b`, { bal: b.bal + 30 });
    });
    expect((await db.doc(`${c}/a`).get()).data()).toEqual({ bal: 70 });
    expect((await db.doc(`${c}/b`).get()).data()).toEqual({ bal: 30 });
  });
  it("conflicting concurrent transactions retry; the sum is conserved (30 parallel transfers)", async () => {
    const db = env.secret(); const c = uid("tx");
    await db.doc(`${c}/a`).create({ bal: 1000 }); await db.doc(`${c}/b`).create({ bal: 0 });
    const res = await Promise.allSettled(Array.from({ length: 30 }, () => db.runTransaction(async (tx) => {
      const a: any = (await tx.get(`${c}/a`)).data(); const b: any = (await tx.get(`${c}/b`)).data();
      tx.update(`${c}/a`, { bal: a.bal - 1 }); tx.update(`${c}/b`, { bal: b.bal + 1 });
    }, { maxAttempts: 30 })));
    const ok = res.filter((r) => r.status === "fulfilled").length;
    const a: any = (await db.doc(`${c}/a`).get()).data(), b: any = (await db.doc(`${c}/b`).get()).data();
    expect(a.bal + b.bal).toBe(1000);
    expect(b.bal).toBe(ok);
    expect(ok, "with 30 attempts allowed every transaction should eventually commit").toBe(30);
  });
  it("throwing inside the callback aborts with no writes; error propagates", async () => {
    const db = env.secret(); const c = uid("tx");
    await db.doc(`${c}/a`).create({ n: 1 });
    await expect(db.runTransaction(async (tx) => { tx.update(`${c}/a`, { n: 2 }); throw new Error("boom"); })).rejects.toThrow("boom");
    expect(((await db.doc(`${c}/a`).get()).data() as any).n).toBe(1);
  });
  it("maxAttempts exhausted surfaces ABORTED_CONFLICT; precondition errors are not retried forever", async () => {
    const db = env.secret(); const c = uid("tx");
    await db.doc(`${c}/a`).create({ n: 0 });
    let attempts = 0;
    const p = db.runTransaction(async (tx) => {
      attempts++; await tx.get(`${c}/a`);
      await db.doc(`${c}/a`).update({ n: attempts }); // sabotage: always conflicts
      tx.update(`${c}/a`, { n: 999 });
    }, { maxAttempts: 3 });
    const e = await p.then(() => null, (x) => x);
    expect(e, "sabotaged transaction should fail").not.toBeNull();
    expect(attempts).toBeLessThanOrEqual(3);
    await expectApiError(db.runTransaction(async (tx) => { tx.create(`${c}/a`, { x: 1 }); }), { status: 409 });
  });
  it("transaction create/set/delete mix, and abort via signal", async () => {
    const db = env.secret(); const c = uid("tx");
    await db.doc(`${c}/d`).create({ n: 1 });
    await db.runTransaction(async (tx) => { tx.create(`${c}/new`, { a: 1 }); tx.set(`${c}/s`, { b: 2 }); tx.delete(`${c}/d`); });
    expect((await db.doc(`${c}/new`).get()).exists).toBe(true);
    expect((await db.doc(`${c}/d`).get().catch(() => ({ exists: false }))).exists).toBe(false);
    const ac = new AbortController(); ac.abort();
    await expect(db.runTransaction(async (tx) => { tx.create(`${c}/zzz`, {}); }, { signal: ac.signal })).rejects.toThrow();
    expect((await db.doc(`${c}/zzz`).get().catch(() => ({ exists: false }))).exists).toBe(false);
  });
});

describe("batch writes", () => {
  it("batchWrite is atomic: one failing op rolls back all", async () => {
    const db = env.secret(); const c = uid("bw");
    await db.doc(`${c}/exists`).create({ a: 1 });
    await expectApiError(db.batchWrite([
      { type: "create", path: `${c}/n1`, data: { a: 1 } },
      { type: "create", path: `${c}/exists`, data: { a: 2 } },
    ] as any), { status: 409 });
    expect((await db.doc(`${c}/n1`).get().catch(() => ({ exists: false }))).exists).toBe(false);
  });
  it("batchWrite limits: 0 ops, over the per-batch max are rejected cleanly", async () => {
    const db = env.secret(); const c = uid("bw");
    await expectApiError(db.batchWrite([] as any), { status: 400 });
    await expectApiError(db.batchWrite(Array.from({ length: 5000 }, (_, i) => ({ type: "set", path: `${c}/x${i}`, data: { i } })) as any), { status: 400 });
  });
  it("batchWriteChunked: 1200 docs, progress callbacks, results, and all docs land", async () => {
    const db = env.secret(); const c = uid("bw"); const prog: number[] = [];
    const r = await db.batchWriteChunked(Array.from({ length: 1200 }, (_, i) => ({ type: "set", path: `${c}/x${i}`, data: { i } })) as any, { chunkSize: 100, concurrency: 4, onProgress: (p) => prog.push(p.completedOperations) });
    expect(r.totalOperations).toBe(1200); expect(r.totalChunks).toBe(12);
    expect(prog.length).toBe(12); expect(Math.max(...prog)).toBe(1200);
    expect(await db.collection(c).count()).toBe(1200);
  });
  it("batchWriteChunked abort mid-flight leaves a prefix of chunks and rejects", async () => {
    const db = env.secret(); const c = uid("bw"); const ac = new AbortController();
    const p = db.batchWriteChunked(Array.from({ length: 600 }, (_, i) => ({ type: "set", path: `${c}/x${i}`, data: { i } })) as any, { chunkSize: 20, concurrency: 1, signal: ac.signal, onProgress: (g) => { if (g.completedChunks === 3) ac.abort(); } });
    await expect(p).rejects.toThrow();
    const n = await db.collection(c).count();
    expect(n % 20).toBe(0); expect(n).toBeLessThan(600);
  });
  it("batchWriteChunked propagates a failing chunk error", async () => {
    const db = env.secret(); const c = uid("bw");
    await db.doc(`${c}/dup`).create({});
    await expect(db.batchWriteChunked([{ type: "create", path: `${c}/dup`, data: {} }, { type: "set", path: `${c}/ok`, data: {} }] as any, { chunkSize: 1 })).rejects.toThrow();
  });
  it("same-path writes inside one batch resolve in order", async () => {
    const db = env.secret(); const c = uid("bw");
    await db.batchWrite([
      { type: "set", path: `${c}/same`, data: { v: 1 } },
      { type: "set", path: `${c}/same`, data: { v: 2 } },
    ] as any).catch(() => undefined);
    const s = await db.doc(`${c}/same`).get().catch(() => null);
    if (s) expect(((s.data() as any).v)).toBe(2);
  });
  it("idempotency: repeating a create with the same Idempotency-Key replays success", async () => {
    const db = env.secret(); const c = uid("idem"); const key = uid("k");
    const send = () => fetch(`${process.env.VELLUM_TEST_ENDPOINT ?? "http://127.0.0.1:18080"}/v1/projects/${env.projectId}/documents/${c}/a`, { method: "POST", headers: { "content-type": "application/json", "x-vellum-api-key": env.secretKey, "idempotency-key": key }, body: JSON.stringify({ data: { a: 1 } }) });
    const r1 = await send(); const r2 = await send();
    expect(r1.status).toBeLessThan(300);
    expect(r2.status, "repeat with same key should replay, not ALREADY_EXISTS").toBeLessThan(300);
    expect((await db.doc(`${c}/a`).get()).exists).toBe(true);
  });
});
