import { describe, it, expect } from "vitest";
import { createVellumPlatform } from "../index.js";

describe("@vellum/api - Control Plane REST & Hono Router", () => {
  it("GET /v1/health returns 200 with dual data-plane status", async () => {
    const platform = createVellumPlatform();
    const req = new Request("http://localhost:8080/v1/health");
    const res = await platform.fetch(req);

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe("ok");
    expect(body.planes.controlDb).toBe("connected");
    expect(body.planes.dataDb).toBe("connected");
    expect(res.headers.get("x-request-id")).toBeDefined();
  });

  it("GET /v1/openapi.json returns 200 with OpenAPI 3.1.0 spec", async () => {
    const platform = createVellumPlatform();
    const req = new Request("http://localhost:8080/v1/openapi.json");
    const res = await platform.fetch(req);

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.openapi).toBe("3.1.0");
    expect(body.paths["/v1/health"]).toBeDefined();
  });

  it("executes full Control Plane lifecycle with audit logging", async () => {
    const platform = createVellumPlatform();

    // 1. Create Organization
    const createOrgReq = new Request("http://localhost:8080/v1/organizations", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "Acme Cloud",
        slug: "acme-cloud",
        planTier: "pro",
      }),
    });
    const orgRes = await platform.fetch(createOrgReq);
    expect(orgRes.status).toBe(201);
    const org = await orgRes.json();
    expect(org.id).toBeDefined();
    expect(org.slug).toBe("acme-cloud");

    // Check audit log for organization.created
    expect(platform.controlStore.auditLogs.some((l: { action: string }) => l.action === "organization.created")).toBe(true);

    // List Organizations
    const listOrgsRes = await platform.fetch(new Request("http://localhost:8080/v1/organizations"));
    expect(listOrgsRes.status).toBe(200);
    const orgs = await listOrgsRes.json();
    expect(orgs.length).toBe(1);

    // 2. Create Project under Organization
    const createProjReq = new Request(`http://localhost:8080/v1/organizations/${org.id}/projects`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "Main Platform",
        slug: "main-platform",
      }),
    });
    const projRes = await platform.fetch(createProjReq);
    expect(projRes.status).toBe(201);
    const { project } = await projRes.json();
    expect(project.id).toBeDefined();

    // Check audit log for project.created
    expect(platform.controlStore.auditLogs.some((l: { action: string }) => l.action === "project.created")).toBe(true);

    // 3. Create API Key
    const createKeyReq = new Request(
      `http://localhost:8080/v1/projects/${project.id}/api-keys`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "Publishable Key",
          keyType: "publishable",
        }),
      }
    );
    const keyRes = await platform.fetch(createKeyReq);
    expect(keyRes.status).toBe(201);
    const { apiKey, rawKey } = await keyRes.json();
    expect(rawKey.startsWith("pk_")).toBe(true);
    expect(apiKey.id).toBeDefined();

    // Check audit log for api_key.created
    expect(platform.controlStore.auditLogs.some((l: { action: string }) => l.action === "api_key.created")).toBe(true);

    // List API keys
    const listKeysRes = await platform.fetch(
      new Request(`http://localhost:8080/v1/projects/${project.id}/api-keys`)
    );
    expect(listKeysRes.status).toBe(200);
    const keys = await listKeysRes.json();
    expect(keys.length).toBe(1);

    // Revoke API Key
    const revokeRes = await platform.fetch(
      new Request(`http://localhost:8080/v1/projects/${project.id}/api-keys/${apiKey.id}`, {
        method: "DELETE",
      })
    );
    expect(revokeRes.status).toBe(200);

    // Check audit log for api_key.revoked
    expect(platform.controlStore.auditLogs.some((l: { action: string }) => l.action === "api_key.revoked")).toBe(true);

    // 4. Publish Security Ruleset
    const rulesetPayload = {
      rulesAst: {
        version: 1,
        rules: [
          {
            match: "users/{userId}",
            allow: {
              read: true,
              write: { op: "==", left: { var: "auth.uid" }, right: { var: "path.userId" } },
            },
          },
        ],
      },
    };
    const publishRes = await platform.fetch(
      new Request(`http://localhost:8080/v1/projects/${project.id}/rulesets`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(rulesetPayload),
      })
    );
    expect(publishRes.status).toBe(201);
    const published = await publishRes.json();
    expect(published.version).toBe(1);

    // Check audit log for ruleset.published
    expect(platform.controlStore.auditLogs.some((l: { action: string }) => l.action === "ruleset.published")).toBe(true);

    // Get Active Ruleset
    const getRulesetRes = await platform.fetch(
      new Request(`http://localhost:8080/v1/projects/${project.id}/rulesets`)
    );
    expect(getRulesetRes.status).toBe(200);
    const activeRuleset = await getRulesetRes.json();
    expect(activeRuleset.version).toBe(1);
  });

  it("formats errors with §11.2 ErrorEnvelope and canonical status codes", async () => {
    const platform = createVellumPlatform();

    // 404 Not Found
    const notFoundRes = await platform.fetch(new Request("http://localhost:8080/v1/nonexistent"));
    expect(notFoundRes.status).toBe(404);
    const notFoundBody = await notFoundRes.json();
    expect(notFoundBody.error.code).toBe("NOT_FOUND");
    expect(notFoundBody.error.requestId).toBeDefined();

    // 400 Invalid Argument (bad organization slug)
    const badOrgRes = await platform.fetch(
      new Request("http://localhost:8080/v1/organizations", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "Bad Org",
          slug: "INVALID SLUG!",
        }),
      })
    );
    expect(badOrgRes.status).toBe(400);
    const badOrgBody = await badOrgRes.json();
    expect(badOrgBody.error.code).toBe("INVALID_ARGUMENT");
  });
});
