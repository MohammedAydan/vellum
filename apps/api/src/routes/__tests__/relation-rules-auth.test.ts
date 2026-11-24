import { describe, expect, it } from "vitest";
import type { SessionClaims } from "@vellum/authorization";
import type { ControlPlaneRepository, ProjectRecord } from "@vellum/database-control";
import { createVellumPlatform } from "../../index.js";
import { assertProjectAccess } from "../../middleware/session.js";

function jsonRequest(url: string, body: unknown, headers: Record<string, string> = {}, method = "POST"): Request {
  return new Request(`http://localhost${url}`, {
    method,
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

function bearer(token: string): Record<string, string> {
  return { authorization: `Bearer ${token}` };
}

async function consoleUserFixture() {
  const platform = createVellumPlatform();
  const signUp = await platform.fetch(
    jsonRequest("/v1/auth/sign-up/email", {
      email: "rules-owner@example.com",
      name: "Rules Owner",
      password: "Password123!",
    })
  );
  expect(signUp.status).toBe(201);
  const session = (await signUp.json()) as { accessToken: string };
  // Console sign-up auto-provisions an organization with a default project.
  const project = Array.from(platform.controlStore.projects.values())[0];
  expect(project).toBeDefined();
  return { platform, token: session.accessToken, project: project as ProjectRecord };
}

describe("@vellum/api - relation-rules session auth", () => {
  it("rejects unauthenticated GET and PUT with 401", async () => {
    const { platform, project } = await consoleUserFixture();
    const url = `/v1/projects/${project.id}/relation-rules`;

    const getRes = await platform.fetch(new Request(`http://localhost${url}`));
    expect(getRes.status).toBe(401);

    const putRes = await platform.fetch(
      jsonRequest(url, { rules: [], expectedVersion: null }, {}, "PUT")
    );
    expect(putRes.status).toBe(401);
  });

  it("rejects an invalid bearer token with 401", async () => {
    const { platform, project } = await consoleUserFixture();
    const url = `/v1/projects/${project.id}/relation-rules`;
    const res = await platform.fetch(
      new Request(`http://localhost${url}`, { headers: bearer("not-a-real-token") })
    );
    expect(res.status).toBe(401);
  });

  it("allows an org member to read and replace rules with optimistic concurrency", async () => {
    const { platform, token, project } = await consoleUserFixture();
    const url = `/v1/projects/${project.id}/relation-rules`;

    const getRes = await platform.fetch(new Request(`http://localhost${url}`, { headers: bearer(token) }));
    expect(getRes.status).toBe(200);
    const current = (await getRes.json()) as { version: number };

    const putRes = await platform.fetch(
      jsonRequest(
        url,
        {
          rules: [
            { collection: "orders", field: "userId", targetCollection: "users", onDelete: "cascade" },
          ],
          expectedVersion: current.version,
        },
        bearer(token),
        "PUT"
      )
    );
    expect(putRes.status).toBe(200);
    const saved = (await putRes.json()) as { version: number; rules: unknown[] };
    expect(saved.version).toBe(current.version + 1);
    expect(saved.rules).toHaveLength(1);
  });
});

describe("@vellum/api - assertProjectAccess reads the database", () => {
  const claims = { uid: "user-1", role: "customer" } as unknown as SessionClaims;
  const project = { id: "proj-1", organizationId: "org-1" } as ProjectRecord;

  function stubStore(inDatabase: boolean) {
    let lookups = 0;
    const store = {
      // A stale mirror must never answer: it is empty on purpose.
      projects: new Map<string, ProjectRecord>(),
      organizationMembers: new Map([
        ["org-1:user-1", { organizationId: "org-1", userId: "user-1", role: "owner", joinedAt: "" }],
      ]),
      findProjectById: async (id: string) => {
        lookups += 1;
        return inDatabase && id === project.id ? project : null;
      },
      get lookups() {
        return lookups;
      },
    };
    return store as unknown as ControlPlaneRepository & { lookups: number };
  }

  it("resolves a project that exists only in the database", async () => {
    const store = stubStore(true);
    const resolved = await assertProjectAccess(store, claims, project.id);
    expect(resolved.id).toBe(project.id);
    expect(store.lookups).toBe(1);
  });

  it("throws NOT_FOUND when the database has no such project", async () => {
    const store = stubStore(false);
    await expect(assertProjectAccess(store, claims, "missing")).rejects.toThrowError(/not found/i);
    expect(store.lookups).toBe(1);
  });
});
