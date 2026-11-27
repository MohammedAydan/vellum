import { describe, expect, it } from "vitest";
import { createVellumPlatform } from "../index.js";

/**
 * Regression for the 0.0.8 rules-simulate self-DoS: a real-world ruleset
 * compiles to well over 2,200 object keys. Rules routes must carry that
 * payload natively, and repeated compile+simulate cycles must never trip the
 * threat detector's injection/SSRF IP ban.
 */

async function fixture() {
  const platform = createVellumPlatform();
  const res = await platform.fetch(
    new Request("http://localhost/v1/auth/sign-up/email", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Sim Owner", email: "sim@example.invalid", password: "FixtureOnly123!" }),
    })
  );
  expect(res.status).toBe(201);
  const { token, project } = (await res.json()) as { token: string; project: { id: string } };
  const post = (path: string, body: unknown) =>
    platform.fetch(
      new Request(`http://localhost/v1/projects/${project.id}${path}`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
        body: JSON.stringify(body),
      })
    );
  return { post };
}

function countKeys(value: unknown): number {
  if (value === null || typeof value !== "object") return 0;
  if (Array.isArray(value)) return value.reduce((sum, item) => sum + countKeys(item), 0);
  return Object.values(value as Record<string, unknown>).reduce((sum, item) => sum + countKeys(item), Object.keys(value as object).length);
}

// 200 match blocks (the per-ruleset cap) with a two-term predicate compile to
// an AST well past the 2,200 keys a real 20-block messaging ruleset produces.
const DSL_SOURCE = Array.from({ length: 200 }, (_, i) =>
  `match /c${i}/{docId} { allow get: if auth.uid != null && resource.ownerId == auth.uid; allow write: if false; }`
).join("\n");

describe("rules compile + simulate regression", () => {
  it("survives 25 compile+simulate loops of a >2,200-key ruleset with no 400 and no IP block", async () => {
    const { post } = await fixture();

    const firstCompile = await post("/rules/compile", { source: DSL_SOURCE });
    expect(firstCompile.status).toBe(200);
    const { ast } = (await firstCompile.json()) as { ast: unknown };
    const keyCount = countKeys(ast);
    expect(keyCount).toBeGreaterThan(2_200);
    expect(keyCount).toBeLessThan(25_000);

    for (let i = 0; i < 25; i += 1) {
      const compile = await post("/rules/compile", { source: DSL_SOURCE });
      expect(compile.status).toBe(200);
      const compiled = (await compile.json()) as { ast: unknown };
      const simulate = await post("/rules/simulate", {
        rulesAst: compiled.ast,
        operation: "get",
        path: "c0/doc1",
        auth: { uid: "user-1" },
        resourceData: { ownerId: "user-1" },
      });
      expect(simulate.status).toBe(200);
      const result = (await simulate.json()) as { allowed: boolean };
      expect(result.allowed).toBe(true);
    }
  }, 120_000);

  it("simulates raw DSL source passed directly, returning compile diagnostics", async () => {
    const { post } = await fixture();
    const simulate = await post("/rules/simulate", {
      source: "match /c/{id} { allow read: if true; }",
      operation: "get",
      path: "c/d1",
    });
    expect(simulate.status).toBe(200);
    const result = (await simulate.json()) as { allowed: boolean; diagnostics: unknown[] };
    expect(result.allowed).toBe(true);
    expect(Array.isArray(result.diagnostics)).toBe(true);
  });

  it("rejects passing both rulesAst and source", async () => {
    const { post } = await fixture();
    const simulate = await post("/rules/simulate", {
      rulesAst: { version: 1, rules: [{ match: "c/{id}", allow: { read: true } }] },
      source: "match /c/{id} { allow read: if true; }",
      operation: "get",
      path: "c/d1",
    });
    expect(simulate.status).toBe(400);
  });
});
