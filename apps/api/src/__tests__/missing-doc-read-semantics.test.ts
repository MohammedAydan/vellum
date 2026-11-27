import { describe, expect, it } from "vitest";
import { createVellumPlatform } from "../index.js";

/**
 * Three-valued read semantics for missing / TTL-expired documents (0.0.9).
 *
 * A doc.get on an absent row returns 404 NOT_FOUND (snap.exists === false)
 * only when the caller is authenticated, passes the collection-level list
 * gate, and the row-level get rule fails solely because `resource` is absent
 * (optimistic `resource.*`). Unauthenticated or collection-unauthorized
 * callers still get 403 PERMISSION_DENIED so the 404/403 split cannot act as
 * an existence oracle. Reads of existing rows are unchanged.
 */

const MEMBER_GET = { op: "in", left: { var: "auth.uid" }, right: { var: "resource.data.memberIds" } };
const AUTHENTICATED = { op: "!=", left: { var: "auth.uid" }, right: { val: null } };
const OWNER_GET = { op: "==", left: { var: "auth.uid" }, right: { var: "resource.data.ownerId" } };

const RULESET = {
  version: 1,
  rules: [
    { match: "chats/{docId}", allow: { get: MEMBER_GET, list: AUTHENTICATED, write: AUTHENTICATED } },
    { match: "open/{docId}", allow: { read: true, write: true } },
    { match: "locked/{docId}", allow: { get: OWNER_GET, list: false, write: AUTHENTICATED } },
  ],
};

async function fixture() {
  const platform = createVellumPlatform();
  const signUp = await platform.fetch(
    new Request("http://localhost/v1/auth/sign-up/email", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Owner", email: "owner@example.invalid", password: "FixtureOnly123!" }),
    })
  );
  expect(signUp.status).toBe(201);
  const { token, project } = (await signUp.json()) as { token: string; project: { id: string } };

  const keyRes = await platform.fetch(
    new Request(`http://localhost/v1/projects/${project.id}/api-keys`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify({ name: "web", keyType: "publishable" }),
    })
  );
  expect(keyRes.status).toBe(201);
  const { rawKey } = (await keyRes.json()) as { rawKey: string };

  const publish = await platform.fetch(
    new Request(`http://localhost/v1/projects/${project.id}/rulesets`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify({ rulesAst: RULESET }),
    })
  );
  expect(publish.status).toBeLessThan(300);

  const endUserSignUp = await platform.fetch(
    new Request(`http://localhost/v1/projects/${project.id}/auth/sign-up/email`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-project-key": rawKey },
      body: JSON.stringify({ email: "member@example.invalid", password: "FixtureOnly123!" }),
    })
  );
  expect(endUserSignUp.status).toBe(201);
  const session = (await endUserSignUp.json()) as { accessToken: string; user: { id: string } };

  const doc = (path: string, init?: RequestInit, userToken?: string) =>
    platform.fetch(
      new Request(`http://localhost/v1/projects/${project.id}/documents/${path}`, {
        ...init,
        headers: {
          "content-type": "application/json",
          "x-project-key": rawKey,
          ...(userToken ? { authorization: `Bearer ${userToken}` } : {}),
        },
      })
    );
  return { doc, uid: session.user.id, userToken: session.accessToken };
}

describe("missing / TTL-expired document read semantics", () => {
  it("returns 404 for a missing doc under member-scoped rules when the caller is authenticated and list passes", async () => {
    const { doc, userToken } = await fixture();
    const res = await doc("chats/missing", {}, userToken);
    expect(res.status).toBe(404);
  });

  it("returns 403 for a missing doc when the caller is unauthenticated (no existence oracle)", async () => {
    const { doc } = await fixture();
    const res = await doc("chats/missing");
    expect(res.status).toBe(403);
  });

  it("returns 403 for a missing doc when the collection-level list gate fails", async () => {
    const { doc, userToken } = await fixture();
    const res = await doc("locked/missing", {}, userToken);
    expect(res.status).toBe(403);
  });

  it("still returns 403 for an existing doc the caller may not read", async () => {
    const { doc, userToken } = await fixture();
    const create = await doc("chats/c1", {
      method: "PUT",
      body: JSON.stringify({ data: { memberIds: ["someone-else"] } }),
    }, userToken);
    expect(create.status).toBeLessThan(300);
    const res = await doc("chats/c1", {}, userToken);
    expect(res.status).toBe(403);
  });

  it("returns 200 for an existing doc the caller may read", async () => {
    const { doc, uid, userToken } = await fixture();
    const create = await doc("chats/c2", {
      method: "PUT",
      body: JSON.stringify({ data: { memberIds: [uid] } }),
    }, userToken);
    expect(create.status).toBeLessThan(300);
    const res = await doc("chats/c2", {}, userToken);
    expect(res.status).toBe(200);
  });

  it("returns 404 immediately after TTL expiry under member-scoped rules (never 403)", async () => {
    const { doc, uid, userToken } = await fixture();
    const create = await doc("chats/ephemeral", {
      method: "PUT",
      body: JSON.stringify({ data: { memberIds: [uid] }, ttlSeconds: 1 }),
    }, userToken);
    expect(create.status).toBeLessThan(300);
    const before = await doc("chats/ephemeral", {}, userToken);
    expect(before.status).toBe(200);
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    const after = await doc("chats/ephemeral", {}, userToken);
    expect(after.status).toBe(404);
  }, 30_000);

  it("returns 404 for a missing doc under open rules", async () => {
    const { doc } = await fixture();
    const res = await doc("open/missing");
    expect(res.status).toBe(404);
  });

  it("evaluates hasKey against the final merged state on merge writes", async () => {
    const { doc, uid, userToken } = await fixture();
    const create = await doc("chats/merged", {
      method: "PUT",
      body: JSON.stringify({ data: { memberIds: [uid], senderId: uid } }),
    }, userToken);
    expect(create.status).toBeLessThan(300);
    // merge: true with a patch that omits senderId must not fail required-key
    // checks: request.data is the final merged state, not the raw patch.
    const merge = await doc("chats/merged", {
      method: "PUT",
      body: JSON.stringify({ data: { lastMessage: "hi" }, merge: true }),
    }, userToken);
    expect(merge.status).toBeLessThan(300);
    const res = await doc("chats/merged", {}, userToken);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: Record<string, unknown> };
    expect(body.data["senderId"]).toBe(uid);
    expect(body.data["lastMessage"]).toBe("hi");
  });
});
