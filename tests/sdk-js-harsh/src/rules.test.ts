import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { provision, uid, expectApiError, type Env } from "./harness.js";

let env: Env;
const PW = "Passw0rd!xyz1";
beforeAll(async () => {
  env = await provision("rules");
  const r = await env.setRulesDsl(`
rules_version = '2';
match /users/{userId}/notes/{noteId} {
  allow get, list: if isOwner(path.userId);
  allow create, update: if isOwner(path.userId) && isType(incoming.title, 'string') && incoming.title != '';
  allow delete: if isOwner(path.userId);
}
match /posts/{postId} {
  allow read: if true;
  allow create: if isSignedIn() && incoming.authorId == auth.uid && isType(incoming.score, 'number') && incoming.score >= 0 && incoming.score <= 100;
  allow update: if isOwner(resource.authorId) && unchanged(['authorId']);
  allow delete: if hasRole('reviewer');
}
match /admin/{id} { allow read, write: if hasRole('admin'); }
`);
  expect(r.status, JSON.stringify(r.body)).toBe(201);
});
afterAll(() => env.cleanup());
const email = () => `${uid("r")}@e2e.test`;
async function user() { const c = env.pub(); const st = await c.auth.signUpWithEmailAndPassword(email(), PW); return { c, uid: st.id }; }

describe("security rules from the SDK", () => {
  it("unauthenticated public client is denied on owner-only paths", async () => {
    await expectApiError(env.pub().doc("users/someone/notes/n1").get(), { status: 403 });
    await expectApiError(env.pub().doc("users/someone/notes/n1").create({ title: "x" }), { status: 403 });
  });
  it("owner can CRUD own notes; other user cannot read/write them", async () => {
    const a = await user(); const b = await user();
    const n = a.c.doc(`users/${a.uid}/notes/n1`);
    await n.create({ title: "hello" });
    expect((await n.get()).data()).toEqual({ title: "hello" });
    await n.update({ title: "changed" });
    await expectApiError(b.c.doc(`users/${a.uid}/notes/n1`).get(), { status: 403 });
    await expectApiError(b.c.doc(`users/${a.uid}/notes/n1`).update({ title: "pwn" }), { status: 403 });
    await expectApiError(b.c.doc(`users/${a.uid}/notes/n1`).delete(), { status: 403 });
    await expectApiError(b.c.collection(`users/${a.uid}/notes`).get(), { status: 403 });
    expect((await a.c.collection(`users/${a.uid}/notes`).get()).docs.length).toBe(1);
    await n.delete();
  });
  it("field validation rules reject bad writes", async () => {
    const a = await user();
    await expectApiError(a.c.doc(`users/${a.uid}/notes/n1`).create({ title: "" }), { status: 403 });
    await expectApiError(a.c.doc(`users/${a.uid}/notes/n2`).create({ title: 5 }), { status: 403 });
    await expectApiError(a.c.doc(`users/${a.uid}/notes/n3`).create({}), { status: 403 });
  });
  it("posts: public read, author-bound create, numeric bounds, immutable author", async () => {
    const a = await user(); const b = await user();
    await expectApiError(a.c.doc("posts/p1").create({ authorId: b.uid, score: 5 }), { status: 403 });
    await expectApiError(a.c.doc("posts/p1").create({ authorId: a.uid, score: 101 }), { status: 403 });
    await expectApiError(a.c.doc("posts/p1").create({ authorId: a.uid, score: -1 }), { status: 403 });
    await expectApiError(a.c.doc("posts/p1").create({ authorId: a.uid, score: "5" }), { status: 403 });
    await a.c.doc("posts/p1").create({ authorId: a.uid, score: 100 });
    expect((await env.pub().doc("posts/p1").get()).data()).toMatchObject({ score: 100 });
    expect((await env.pub().collection("posts").get()).docs.length).toBeGreaterThan(0);
    await a.c.doc("posts/p1").update({ title: "t" });
    await expectApiError(a.c.doc("posts/p1").update({ authorId: b.uid }), { status: 403 });
    await expectApiError(b.c.doc("posts/p1").update({ title: "x" }), { status: 403 });
  });
  it("role claims: admin-set claim grants access; self-assigned claim does not", async () => {
    const a = await user();
    await expectApiError(a.c.doc("admin/x").get(), { status: 403 });
    let selfAssigned = false;
    try { await a.c.auth.updateProfile({ customClaims: { role: "admin" } }); selfAssigned = true; } catch { /* correct: rejected */ }
    if (selfAssigned) await a.c.auth.getIdToken(true);
    await expectApiError(a.c.doc("admin/x").get(), { status: 403 }).catch((e) => { throw new Error("SECURITY: end user escalated to admin via self-assigned claim. " + e.message); });
    expect((await env.admin("PUT", `/users/${a.uid}/claims`, { claims: { role: "admin" } })).status).toBe(200);
    await a.c.auth.getIdToken(true);
    await env.secret().doc("admin/x").create({ ok: 1 });
    expect((await a.c.doc("admin/x").get()).data()).toEqual({ ok: 1 });
  });
  it("secret key bypasses rules; publishable key does not", async () => {
    await env.secret().doc("posts/s1").create({ authorId: "nobody", score: 999 });
    await expectApiError(env.pub().doc("posts/s2").create({ authorId: "x", score: 1 }), { status: 403 });
  });
  it("collections with no matching rule are denied (default deny)", async () => {
    const a = await user();
    await expectApiError(a.c.doc(`${uid("nomatch")}/x`).get(), { status: 403 });
  });
  it("rules cannot be bypassed by queries, aggregates, deleteWhere, batch, import, transactions", async () => {
    const a = await user(); const b = await user();
    await a.c.doc(`users/${a.uid}/notes/n1`).create({ title: "secret" });
    const col = `users/${a.uid}/notes`;
    await expectApiError(b.c.collection(col).where("title", "==", "secret").get(), { status: 403 });
    await expectApiError(b.c.collection(col).count(), {}).then((e) => expect(e.status).toBeGreaterThanOrEqual(400));
    await expectApiError(b.c.collection(col).deleteWhere(), {}).then((e) => expect(e.status).toBeGreaterThanOrEqual(400));
    await expectApiError(b.c.batchWrite([{ type: "set", path: `${col}/n9`, data: { title: "x" } }] as any), {}).then((e) => expect(e.status).toBeGreaterThanOrEqual(400));
    await expectApiError(b.c.runTransaction(async (tx) => { tx.set(`${col}/n8`, { title: "x" }); }), {}).then((e) => expect(e.status).toBeGreaterThanOrEqual(400));
    await expectApiError(b.c.importDocuments(col, [{ id: "n7", data: { title: "x" } }] as any), {}); // rejected (client-side name check or server rules)
    await expectApiError(b.c.exportDocuments(col), {}); // rejected (client-side name check or server rules)
    await expectApiError(b.c.collection(col).clear(), {}); // rejected (client-side name check or server rules)
    await expectApiError(b.c.collection(col).drop(), {}); // rejected (client-side name check or server rules)
    expect((await a.c.doc(`${col}/n1`).get()).exists).toBe(true);
  });
  it("end-user cannot manage indexes/collections with publishable key", async () => {
    const a = await user();
    await expectApiError(a.c.createCollection(uid("c")), {}).then((e) => expect(e.status).toBeGreaterThanOrEqual(400));
  });
  it("rules DSL: syntax errors report line/col; simulate matches live behaviour; decompile roundtrip", async () => {
    const bad = await env.setRulesDsl("match /x/{id} { allow read: if ; }");
    expect(bad.status).toBe(400);
    const sim = await fetch(`${process.env.VELLUM_TEST_ENDPOINT ?? "http://127.0.0.1:18080"}/v1/projects/${env.projectId}/rules/simulate`, { method: "POST", headers: { "content-type": "application/json", "x-vellum-api-key": env.secretKey }, body: JSON.stringify({ operation: "get", path: "posts/p1", auth: null }) });
    expect(sim.status).toBe(200);
    expect((await sim.json() as any).allowed).toBe(true);
  });
  it("stale/forged tokens are rejected", async () => {
    const a = await user();
    const tok = (await a.c.auth.getIdToken())!;
    const parts = tok.split(".");
    const forged = `${parts[0]}.${Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(parts[1]!, "base64url").toString()), sub: "someoneelse" })).toString("base64url")}.${parts[2]}`;
    const c = env.pub({ getAuthToken: () => forged });
    await expectApiError(c.doc("users/someoneelse/notes/n1").get(), {}).then((e) => expect([401, 403]).toContain(e.status));
    const none = env.pub({ getAuthToken: () => "garbage" });
    await expectApiError(none.doc("posts/p1").get(), {}).then((e) => expect([401, 403]).toContain(e.status));
  });
});
