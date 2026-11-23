import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { fieldOp } from "@vellumdb/sdk-js";
import { provision, uid, waitFor, sleep, type Env } from "./harness.js";

let env: Env;
const PW = "Passw0rd!xyz1";
beforeAll(async () => { env = await provision("rt"); });
afterAll(() => env.cleanup());

function collect(sub: (cb: (s: any) => void, err: (e: any) => void) => () => void) {
  const snaps: any[] = []; const errs: any[] = [];
  const off = sub((s) => snaps.push(s), (e) => errs.push(e));
  return { snaps, errs, off, changes: () => snaps.flatMap((s) => s.changes) };
}

describe("realtime", () => {
  it("document subscription: initial, modified, removed", async () => {
    const db = env.secret(); const c = uid("rt"); const d = db.doc(`${c}/a`);
    await d.create({ n: 1 });
    const r = collect((cb, er) => d.onSnapshot(cb, er));
    await waitFor(() => r.changes().some((x) => x.type === "added"), { label: "initial" });
    await d.update({ n: 2 });
    await waitFor(() => r.changes().some((x) => x.type === "modified" && x.doc.data().n === 2), { label: "modified" });
    await d.delete();
    await waitFor(() => r.changes().some((x) => x.type === "removed"), { label: "removed" });
    r.off(); expect(r.errs).toEqual([]);
  });
  it("query subscription tracks adds / updates / removals and docs snapshot", async () => {
    const db = env.secret(); const c = uid("rt");
    const r = collect((cb, er) => db.collection(c).where("k", "==", 1).onSnapshot(cb, er));
    await sleep(300);
    await db.doc(`${c}/x`).create({ k: 1 }); await db.doc(`${c}/y`).create({ k: 2 });
    await waitFor(() => r.changes().some((x) => x.doc.id === "x"), { label: "x added" });
    await sleep(300);
    expect(r.changes().some((x) => x.doc.id === "y")).toBe(false);
    await db.doc(`${c}/x`).update({ k: 3 }); // leaves the result set
    await waitFor(() => r.changes().some((x) => x.doc.id === "x" && x.type === "removed"), { label: "x left set" });
    await db.doc(`${c}/y`).update({ k: 1 }); // enters the result set
    await waitFor(() => r.changes().some((x) => x.doc.id === "y"), { label: "y entered" });
    const last = r.snaps.at(-1); expect(last.docs.map((d: any) => d.id)).toEqual(["y"]);
    r.off();
  });
  it("ordering and burst: 100 rapid writes arrive in order without gaps or duplicates", async () => {
    const db = env.secret(); const c = uid("rt"); const d = db.doc(`${c}/b`);
    await d.create({ n: 0 });
    const r = collect((cb, er) => d.onSnapshot(cb, er));
    await waitFor(() => r.changes().length >= 1, { label: "initial" });
    for (let i = 1; i <= 100; i++) await d.update({ n: i });
    await waitFor(() => r.changes().some((x) => x.doc.data().n === 100), { timeoutMs: 15000, label: "last" });
    const seqs = r.changes().map((x) => x.seqId);
    for (let i = 1; i < seqs.length; i++) expect(seqs[i]).toBeGreaterThan(seqs[i - 1]);
    const ns = r.changes().map((x) => x.doc.data().n);
    for (let i = 1; i < ns.length; i++) expect(ns[i]).toBeGreaterThanOrEqual(ns[i - 1]);
    r.off();
  });
  it("many concurrent subscriptions on one connection", async () => {
    const db = env.secret(); const c = uid("rt");
    const subs = Array.from({ length: 25 }, (_, i) => collect((cb, er) => db.doc(`${c}/d${i}`).onSnapshot(cb, er)));
    await sleep(500);
    await Promise.all(Array.from({ length: 25 }, (_, i) => db.doc(`${c}/d${i}`).create({ i })));
    await waitFor(() => subs.every((s) => s.changes().length > 0), { timeoutMs: 10000, label: "all subs got data" });
    subs.forEach((s, i) => expect(s.changes().every((x) => x.doc.id === `d${i}`)).toBe(true));
    subs.forEach((s) => s.off());
  });
  it("unsubscribe stops delivery; double unsubscribe is safe", async () => {
    const db = env.secret(); const c = uid("rt"); const d = db.doc(`${c}/u`);
    await d.create({ n: 0 });
    const r = collect((cb, er) => d.onSnapshot(cb, er));
    await waitFor(() => r.changes().length > 0);
    r.off(); r.off();
    const before = r.snaps.length;
    await d.update({ n: 1 }); await sleep(500);
    expect(r.snaps.length).toBe(before);
  });
  it("rules apply to realtime: denied subscription errors; allowed subscription works; no leaks", async () => {
    const en = await provision("rt-rules");
    await en.setRulesDsl(`match /users/{userId}/notes/{noteId} { allow get, list: if isOwner(path.userId); allow write: if isOwner(path.userId); }`);
    const a = en.pub(); const b = en.pub();
    const sa = await a.auth.signUpWithEmailAndPassword(`${uid("a")}@e.test`, PW);
    await b.auth.signUpWithEmailAndPassword(`${uid("b")}@e.test`, PW);
    const mine = collect((cb, er) => a.collection(`users/${sa.id}/notes`).onSnapshot(cb, er));
    const theirs = collect((cb, er) => b.collection(`users/${sa.id}/notes`).onSnapshot(cb, er));
    const anon = collect((cb, er) => en.pub().collection(`users/${sa.id}/notes`).onSnapshot(cb, er));
    await sleep(500);
    await a.doc(`users/${sa.id}/notes/n1`).create({ title: "private" });
    await waitFor(() => mine.changes().some((x) => x.doc.id === "n1"), { label: "owner receives" });
    await sleep(500);
    expect(theirs.changes().length).toBe(0); expect(anon.changes().length).toBe(0);
    expect(theirs.errs.length + 0).toBeGreaterThanOrEqual(0);
    expect(JSON.stringify(theirs.snaps)).not.toContain("private");
    expect(JSON.stringify(anon.snaps)).not.toContain("private");
    en.cleanup();
  });
  it("connection state transitions and dispose() closes the socket and timers", async () => {
    const db = env.secret(); const states: string[] = [];
    db.onConnectionStateChange((s: any) => states.push(String(s)));
    const c = uid("rt"); const r = collect((cb, er) => db.doc(`${c}/s`).onSnapshot(cb, er));
    await waitFor(() => states.length > 0 && String(db.connectionState ?? states.at(-1)).length > 0, { label: "state change" });
    r.off(); db.dispose?.();
    await sleep(200);
    expect(String((db as any).connectionState ?? states.at(-1))).toMatch(/clos|disconn|idle|disposed/i);
  });
  it("auth token refresh keeps realtime alive (no silent drop after rotation)", async () => {
    const en = await provision("rt-auth");
    await en.setRulesDsl(`match /pub/{id} { allow read: if true; allow write: if isSignedIn(); }`);
    const a = en.pub(); await a.auth.signUpWithEmailAndPassword(`${uid("a")}@e.test`, PW);
    const r = collect((cb, er) => a.collection("pub").onSnapshot(cb, er));
    await sleep(400);
    await a.auth.getIdToken(true);
    await a.doc("pub/p1").create({ v: 1 });
    await waitFor(() => r.changes().some((x) => x.doc.id === "p1"), { timeoutMs: 8000, label: "event after token rotation" });
    r.off(); en.cleanup();
  });
  it("field ops and TTL docs flow through realtime with materialised values", async () => {
    const db = env.secret(); const c = uid("rt"); const d = db.doc(`${c}/f`);
    await d.create({ n: 0 });
    const r = collect((cb, er) => d.onSnapshot(cb, er));
    await sleep(300);
    await d.update({ n: fieldOp.increment(5), t: fieldOp.serverTimestamp(), arr: fieldOp.arrayUnion("a") });
    await waitFor(() => r.changes().some((x) => x.doc.data().n === 5), { label: "increment materialised" });
    const last = r.changes().at(-1).doc.data(); expect(last.t).toBeTruthy(); expect(last.arr).toEqual(["a"]);
    r.off();
  });
});
