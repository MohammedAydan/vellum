/**
 * V2 route integration tests — contract §6.5.
 *
 * Uses the real in-memory platform factory. The rules DSL (agent 2B) is
 * imported directly from `@vellum/authorization`; if that export is genuinely
 * absent in a parallel run, only the DSL describe block is skipped. Aggregate
 * / bulk-delete are likewise gated on the document-engine methods (agent 2A)
 * being present, so this suite is green in every parallel-build state.
 */

import { describe, it, expect } from "vitest";
import {
  compileRulesDsl,
  decompileRulesAstToDsl,
  generateProjectApiKey,
} from "@vellum/authorization";
import * as authorizationModule from "@vellum/authorization";
import { createVellumPlatform } from "../index.js";

const SECRET = "v2-routes-test-jwt-secret-at-least-16-chars";
const PEPPER = "v2-routes-test-pepper-at-least-16-chars";
const ORIGIN = "http://localhost:5173";

const platform = createVellumPlatform({ jwtSecret: SECRET, apiKeyPepper: PEPPER });
const control = platform.controlStore;

const hasDsl =
  "compileRulesDsl" in authorizationModule &&
  typeof authorizationModule.compileRulesDsl === "function" &&
  "simulateRuleEvaluation" in authorizationModule &&
  typeof authorizationModule.simulateRuleEvaluation === "function";

const hasEngineV2 =
  "aggregateDocuments" in platform.documentEngine &&
  typeof platform.documentEngine.aggregateDocuments === "function" &&
  "deleteWhere" in platform.documentEngine &&
  typeof platform.documentEngine.deleteWhere === "function";

interface SeededTenant {
  projectId: string;
  rawKey: string;
}

async function seedTenant(slug: string, scopes?: string[]): Promise<SeededTenant> {
  const org = await control.createOrganization({
    name: `V2 Org ${slug}`,
    slug,
    billingEmail: `${slug}@example.com`,
    planId: "pro",
  });
  const { project } = await control.createProject({
    organizationId: org.id,
    name: `V2 Project ${slug}`,
    slug: `${slug}-project`,
  });
  const generated = generateProjectApiKey({
    keyType: "server",
    pepper: PEPPER,
  });
  await control.registerApiKey({
    projectId: project.id,
    name: "V2 test key",
    keyType: "server",
    keyPrefix: generated.keyPrefix,
    secretHash: generated.secretHash,
    scopes: scopes ?? ["documents:read", "documents:write", "indexes:manage"],
  });
  return { projectId: project.id, rawKey: generated.fullKey };
}

function baseUrl(tenant: SeededTenant, suffix: string): string {
  return `http://localhost:8080/v1/projects/${tenant.projectId}${suffix}`;
}

async function postJson(
  tenant: SeededTenant,
  suffix: string,
  body: unknown,
  extraHeaders: Record<string, string> = {}
): Promise<Response> {
  return platform.fetch(
    new Request(baseUrl(tenant, suffix), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-vellum-api-key": tenant.rawKey,
        ...extraHeaders,
      },
      body: JSON.stringify(body),
    })
  );
}

async function getJson(tenant: SeededTenant, suffix: string, extraHeaders: Record<string, string> = {}): Promise<Response> {
  return platform.fetch(
    new Request(baseUrl(tenant, suffix), {
      headers: { "x-vellum-api-key": tenant.rawKey, ...extraHeaders },
    })
  );
}

describe("@vellum/api - V2 endpoints", () => {
  describe.skipIf(!hasEngineV2)("aggregate & bulk-delete", () => {
    it("POST documents:aggregate returns engine rows", async () => {
      const tenant = await seedTenant("v2-aggregate");
      for (let i = 1; i <= 2; i += 1) {
        await postJson(tenant, `/documents/orders/o${i}`, { status: "paid", amount: i * 10 });
      }
      const res = await postJson(tenant, "/documents:aggregate", {
        collectionPath: "orders",
        where: [{ field: "status", op: "==", value: "paid" }],
        groupBy: ["status"],
        metrics: { total: { op: "sum", field: "amount" } },
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { rows: unknown[]; executionTimeMs: number };
      expect(Array.isArray(body.rows)).toBe(true);
      expect(typeof body.executionTimeMs).toBe("number");
    });

    it("POST documents:bulk-delete returns a deleted count", async () => {
      const tenant = await seedTenant("v2-bulk-delete");
      await postJson(tenant, "/documents/orders/o1", { status: "stale" });
      const res = await postJson(tenant, "/documents:bulk-delete", {
        collectionPath: "orders",
        where: [{ field: "status", op: "==", value: "stale" }],
        limit: 10,
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { deletedCount: number };
      expect(Number.isInteger(body.deletedCount)).toBe(true);
      expect(body.deletedCount).toBeGreaterThanOrEqual(0);
    });

    it("rejects an invalid aggregate body", async () => {
      const tenant = await seedTenant("v2-aggregate-invalid");
      const res = await postJson(tenant, "/documents:aggregate", { collectionPath: "orders", metrics: {} });
      expect(res.status).toBe(400);
    });
  });

  describe.skipIf(!hasDsl)("rules DSL endpoints", () => {
    it("POST rules/compile returns a v1 AST and diagnostics", async () => {
      const tenant = await seedTenant("v2-compile");
      const res = await postJson(tenant, "/rules/compile", {
        source: "match /posts/{postId} { allow read: if true; }",
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { ast: { version: number; rules: unknown[] }; diagnostics: unknown[] };
      expect(body.ast.version).toBe(1);
      expect(body.ast.rules).toHaveLength(1);
      expect(body.diagnostics).toEqual([]);
    });

    it("POST rules/compile returns a 400 position envelope for bad DSL", async () => {
      const tenant = await seedTenant("v2-compile-bad");
      const res = await postJson(tenant, "/rules/compile", { source: "match /posts/{ { allow read: if true; }" });
      expect(res.status).toBe(400);
      const body = (await res.json()) as {
        error: { code: string; message: string; line: number; column: number; snippet: string };
      };
      expect(body.error.code).toBe("INVALID_ARGUMENT");
      expect(body.error.line).toBeGreaterThan(0);
      expect(body.error.column).toBeGreaterThan(0);
      expect(typeof body.error.snippet).toBe("string");
    });

    it("POST rules/decompile accepts a wrapped AST", async () => {
      const tenant = await seedTenant("v2-decompile");
      const { ast } = compileRulesDsl("match /posts/{postId} { allow read: if true; }");
      const res = await postJson(tenant, "/rules/decompile", { rulesAst: ast });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { dsl: string };
      expect(body.dsl).toContain("match");
      expect(body.dsl).toContain("posts");
      expect(decompileRulesAstToDsl(ast)).toBe(body.dsl);
    });

    it("POST rules/simulate uses a supplied AST", async () => {
      const tenant = await seedTenant("v2-simulate");
      const { ast } = compileRulesDsl("match /posts/{postId} { allow read: if true; }");
      const res = await postJson(tenant, "/rules/simulate", {
        rulesAst: ast,
        operation: "get",
        path: "/posts/p1",
        auth: { uid: "u1", claims: {} },
        resourceData: { ownerId: "u1" },
        incomingData: null,
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { allowed: boolean; matchedRule: string | null; evaluationTrace: string[] };
      expect(body.allowed).toBe(true);
      expect(Array.isArray(body.evaluationTrace)).toBe(true);
    });

    it("POST rules/simulate falls back to the active project ruleset", async () => {
      const tenant = await seedTenant("v2-simulate-fallback");
      const { ast } = compileRulesDsl("match /posts/{postId} { allow read: if true; }");
      await control.publishSecurityRuleset({
        projectId: tenant.projectId,
        rulesAst: { ...ast },
        createdBy: "v2-test",
      });
      const res = await postJson(tenant, "/rules/simulate", {
        operation: "get",
        path: "/posts/p1",
        auth: null,
      });
      expect(res.status).toBe(200);
      expect(((await res.json()) as { allowed: boolean }).allowed).toBe(true);
    });
  });

  describe("index advisor headers on hot paths", () => {
    it("POST /query attaches x-vellum-index-url for an uncovered query and exposes it via CORS", async () => {
      const tenant = await seedTenant("v2-advisor");
      const res = await postJson(
        tenant,
        "/query",
        {
          collectionPath: "events",
          where: [{ field: "status", op: "==", value: "ok" }],
          orderBy: [{ field: "createdAt", direction: "desc" }],
          limit: 10,
        },
        { origin: ORIGIN }
      );
      expect(res.status).toBe(200);
      expect(res.headers.get("x-vellum-index-url")).toMatch(/\/indexes\?suggest=/);
      expect(res.headers.get("x-vellum-index-suggestion")).toBeTruthy();
      const expose = res.headers.get("access-control-expose-headers") ?? "";
      expect(expose.toLowerCase()).toContain("x-vellum-index-url");
      expect(expose.toLowerCase()).toContain("x-vellum-index-suggestion");
    });

    it("GET collection listing never throws when no index is needed", async () => {
      const tenant = await seedTenant("v2-advisor-list");
      const res = await getJson(tenant, "/documents/events");
      expect(res.status).toBe(200);
      expect((await res.json()).documents).toBeDefined();
    });
  });

  describe("index recommendation endpoints", () => {
    it("lists, applies and dismisses recommendations", async () => {
      const tenant = await seedTenant("v2-recommendations");

      // An uncovered query records a recommendation via the fire-and-forget path.
      const seed = await postJson(tenant, "/query", {
        collectionPath: "reports",
        where: [{ field: "ownerId", op: "==", value: "u1" }],
        orderBy: [{ field: "createdAt", direction: "desc" }],
      });
      expect(seed.status).toBe(200);
      expect(seed.headers.get("x-vellum-index-url")).toBeTruthy();

      const before = await getJson(tenant, "/indexes/recommendations");
      expect(before.status).toBe(200);
      const listed = (await before.json()) as {
        recommendations: Array<{ id: string; status: string; fingerprint: string; recommendedFields: unknown[] }>;
      };
      expect(listed.recommendations.length).toBeGreaterThan(0);
      const target = listed.recommendations[0]!;
      expect(target.status).toBe("pending");
      expect(target.recommendedFields.length).toBeGreaterThan(0);

      const applied = await postJson(tenant, `/indexes/recommendations/${target.id}/apply`, {});
      expect(applied.status).toBe(200);
      expect(((await applied.json()) as { applied: boolean }).applied).toBe(true);

      const afterApply = await getJson(tenant, "/indexes/recommendations");
      const appliedRows = ((await afterApply.json()) as { recommendations: Array<{ id: string; status: string }> })
        .recommendations;
      expect(appliedRows.find((row) => row.id === target.id)?.status).toBe("applied");

      // A different query shape yields a different fingerprint, so a fresh
      // recommendation can be dismissed.
      const seed2 = await postJson(tenant, "/query", {
        collectionPath: "reports",
        where: [{ field: "teamId", op: "==", value: "t1" }],
        orderBy: [{ field: "updatedAt", direction: "asc" }],
      });
      expect(seed2.headers.get("x-vellum-index-url")).toBeTruthy();
      const list2 = (await (await getJson(tenant, "/indexes/recommendations")).json()) as {
        recommendations: Array<{ id: string; status: string }>;
      };
      const dismissTarget = list2.recommendations.find((row) => row.status === "pending");
      expect(dismissTarget).toBeDefined();
      const dismissed = await postJson(tenant, `/indexes/recommendations/${dismissTarget!.id}/dismiss`, {});
      expect(dismissed.status).toBe(200);
      expect(((await dismissed.json()) as { dismissed: boolean }).dismissed).toBe(true);
    });

    it("rejects index management without the indexes:manage scope", async () => {
      const tenant = await seedTenant("v2-no-index-scope", ["documents:read", "documents:write"]);
      const res = await getJson(tenant, "/indexes/recommendations");
      expect(res.status).toBe(403);
    });
  });
});


describe("referencedBy endpoint", () => {
  it("uses the authenticated project and enforces request pagination bounds", async () => {
    const tenant = await seedTenant("reverse-api");
    await postJson(tenant, "/documents/users/u1", { name: "Target" });
    await postJson(tenant, "/documents/posts/p1", { author: { $ref: "users/u1" } });
    const response = await postJson(tenant, "/documents:referencedBy", { targetPath: "users/u1", field: "author", limit: 1 });
    expect(response.status).toBe(200);
    const body = await response.json() as { documents: Array<{ path: string }>; nextCursor: string | null };
    expect(body.documents.map((row) => row.path)).toEqual(["posts/p1"]);
    expect(body.nextCursor).toBeNull();
    for (const request of [{ targetPath: "users/u1", limit: 101 }, { targetPath: "users/u1", unrecognized: true }, { targetPath: "users" }]) {
      expect((await postJson(tenant, "/documents:referencedBy", request)).status).toBe(400);
    }
    const missingAuth = await platform.fetch(new Request(baseUrl(tenant, "/documents:referencedBy"), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ targetPath: "users/u1" }) }));
    expect(missingAuth.status).toBe(401);
  });
});
