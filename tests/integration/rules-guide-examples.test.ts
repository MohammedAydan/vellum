import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  authorizeOperation, compileRulesDsl, evaluateAstNode, simulateRuleEvaluation,
  validateSecurityRulesetAst,
  type ApiKeyRecord, type AuthContext, type SecurityRulesetAst, type SecurityRulesetRecord,
} from "@vellum/authorization";
import { createFixture, publicKey, serverKey, TENANT } from "../../packages/document-engine/src/__tests__/_harness.js";

const guide = (lang: string, slug: string) => readFileSync(
  new URL(`../../docs/guides/${lang === "ar" ? "ar/" : ""}${slug}.md`, import.meta.url), "utf8",
);
const blocks = (source: string, language: string) => [...source.matchAll(
  new RegExp("```" + language + "\\n([\\s\\S]*?)```", "g"),
)].map((match) => match[1]!);
const astExamples = blocks(guide("en", "security-rules"), "json").map((text) => JSON.parse(text) as SecurityRulesetAst);
const sources = blocks(guide("en", "security-rules-dsl"), "text");
const asRecord = (ast: SecurityRulesetAst) => ({ rulesAst: ast }) as SecurityRulesetRecord;
const key: ApiKeyRecord = publicKey();
const owner = { uid: "alice", claims: {} };
const outsider = { uid: "bob", claims: {} };
const guest = { uid: null, claims: {} };

function allowed(ast: SecurityRulesetAst, operation: "get" | "list" | "create" | "update" | "delete",
  path: string, authContext: AuthContext = owner, resourceData: Record<string, unknown> | null = null,
  requestData: Record<string, unknown> | null = null): boolean {
  try {
    return authorizeOperation({ apiKeyRecord: key, rulesetRecord: asRecord(ast), operation, path,
      authContext, resourceData, requestData }).allowed;
  } catch (error) {
    expect(error).toMatchObject({ code: "PERMISSION_DENIED" });
    return false;
  }
}

// No simulator-only permission checks: the documented policies go through the
// production authorizer and actual DocumentEngine with an isolated memory adapter.
describe("rules guide code is shared across languages and website pages", () => {
  for (const slug of ["security-rules", "security-rules-dsl"]) {
    for (const language of ["json", "text"]) {
      it(`${slug}: ${language} examples match in English and Arabic`, () => {
        const en = blocks(guide("en", slug), language);
        expect(blocks(guide("ar", slug), language)).toEqual(en);
        for (const lang of ["en", "ar"]) {
          const page = readFileSync(new URL(`../../apps/docs/src/pages/${lang}/${slug}.tsx`, import.meta.url), "utf8");
          for (const code of en) expect(page).toContain(JSON.stringify(code.trimEnd()));
        }
      });
    }
  }
});

describe("all complete documented policies compile and validate", () => {
  it("validates JSON and the simulation payload through real authorization", () => {
    for (const ast of astExamples) expect(validateSecurityRulesetAst(ast)).toBe(true);
    const payload = JSON.parse(blocks(guide("en", "security-rules-dsl"), "json")[0]!);
    expect(simulateRuleEvaluation({ ruleset: payload.rulesAst, ...payload }).allowed).toBe(true);
    expect(allowed(payload.rulesAst, "get", payload.path, owner, payload.resourceData)).toBe(true);
    expect(allowed(payload.rulesAst, "get", payload.path, outsider, payload.resourceData)).toBe(false);
    expect(allowed(payload.rulesAst, "get", payload.path, guest, payload.resourceData)).toBe(false);
  });
  for (const [index, source] of sources.entries()) {
    it(`DSL policy ${index + 1} has no diagnostics and reaches the real authorizer`, () => {
      const result = compileRulesDsl(source);
      expect(result.diagnostics).toEqual([]);
      expect(validateSecurityRulesetAst(result.ast)).toBe(true);
      const path = index === 1 ? "posts/one" : index === 3 ? "users/alice/tickets/one" : "users/alice/notes/one";
      expect(allowed(result.ast, "get", path)).toBe(true);
      if (index !== 1) {
        expect(allowed(result.ast, "get", path, outsider)).toBe(false);
        expect(allowed(result.ast, "get", path, guest)).toBe(false);
      }
    });
  }
});

describe("documented private namespace through the real document engine", () => {
  for (const [label, ast] of [["JSON", astExamples[0]!], ["DSL", compileRulesDsl(sources[0]!).ast]] as const) {
    it(`${label}: create/read/query/update/delete and cross-user denial`, async () => {
      const { engine } = createFixture({ ruleset: asRecord(ast) });
      const ctx = { projectId: TENANT.projectId, apiKeyRecord: key, authContext: owner };
      const path = "users/alice/notes/one";
      await engine.createDocument({ ...ctx, path, data: { title: "Private" } });
      expect((await engine.getDocument({ ...ctx, path })).data.title).toBe("Private");
      const querySpec = { collectionPath: "users/alice/notes", limit: 10 };
      expect((await engine.executeQuery({ ...ctx, querySpec })).documents).toHaveLength(1);
      for (const authContext of [outsider, guest]) {
        await expect(engine.getDocument({ ...ctx, authContext, path })).rejects.toMatchObject({ code: "PERMISSION_DENIED" });
        await expect(engine.executeQuery({ ...ctx, authContext, querySpec })).rejects.toMatchObject({ code: "PERMISSION_DENIED" });
        await expect(engine.updateDocument({ ...ctx, authContext, path, data: { title: "Stolen" } })).rejects.toMatchObject({ code: "PERMISSION_DENIED" });
        await expect(engine.deleteDocument({ ...ctx, authContext, path })).rejects.toMatchObject({ code: "PERMISSION_DENIED" });
      }
      await expect(engine.updateDocument({ ...ctx, path, data: { title: 2 } })).rejects.toMatchObject({ code: "PERMISSION_DENIED" });
      await engine.updateDocument({ ...ctx, path, data: { title: "Changed" } });
      await engine.deleteDocument({ ...ctx, path });
    });
  }

  it("public posts: validates full merged data and prevents ownership transfer", async () => {
    const { engine } = createFixture({ ruleset: asRecord(compileRulesDsl(sources[1]!).ast) });
    const ctx = { projectId: TENANT.projectId, apiKeyRecord: key, authContext: owner };
    const path = "posts/one";
    await engine.createDocument({ ...ctx, path, data: { authorId: "alice", title: "First", score: 20 } });
    await engine.updateDocument({ ...ctx, path, data: { title: "Patch omits authorId" } });
    expect((await engine.getDocument({ ...ctx, authContext: guest, path })).data.score).toBe(20);
    for (const data of [{ authorId: "bob" }, { score: 101 }, { score: "20" }, { title: null }]) {
      await expect(engine.updateDocument({ ...ctx, path, data })).rejects.toMatchObject({ code: "PERMISSION_DENIED" });
    }
    await expect(engine.updateDocument({ ...ctx, path, authContext: outsider, data: { title: "Stolen" } }))
      .rejects.toMatchObject({ code: "PERMISSION_DENIED" });
    await expect(engine.deleteDocument({ ...ctx, path })).rejects.toMatchObject({ code: "PERMISSION_DENIED" });
    await engine.deleteDocument({ ...ctx, path, authContext: { uid: "reviewer", claims: { role: "reviewer" } } });
  });

  it("reference policy checks the trusted target path and preserves it on patch", async () => {
    const { engine } = createFixture({ ruleset: asRecord(compileRulesDsl(sources[2]!).ast) });
    const ctx = { projectId: TENANT.projectId, apiKeyRecord: key,
      authContext: { uid: "alice", claims: { profilePath: "profiles/alice" } } };
    const path = "users/alice/notes/one";
    await engine.createDocument({ ...ctx, path, data: { author: { $t: "ref", $v: "profiles/alice" } } });
    await engine.updateDocument({ ...ctx, path, data: { title: "Keep author" } });
    await expect(engine.updateDocument({ ...ctx, path, data: { author: { $t: "ref", $v: "profiles/bob" } } }))
      .rejects.toMatchObject({ code: "PERMISSION_DENIED" });
    await expect(engine.createDocument({ ...ctx, path: "users/alice/notes/two", data: { author: "profiles/alice" } }))
      .rejects.toMatchObject({ code: "PERMISSION_DENIED" });
  });

  it("a readable source cannot expose a private included target", async () => {
    const ast = compileRulesDsl(sources[2]!).ast;
    const { engine } = createFixture({ ruleset: asRecord(ast) });
    const seed = { projectId: TENANT.projectId, apiKeyRecord: serverKey("seed") };
    await engine.createDocument({ ...seed, path: "profiles/alice", data: { secret: "Never expose" } });
    await engine.createDocument({ ...seed, path: "users/alice/notes/one",
      data: { author: { $t: "ref", $v: "profiles/alice" } } });
    const result = await engine.getDocument({ projectId: TENANT.projectId, apiKeyRecord: key, authContext: owner,
      path: "users/alice/notes/one", include: [{ field: "author", collection: "profiles", as: "profile" }] });
    expect(result._included?.["profile"]).toBeNull();
    expect(result._redactedRefs).toContain("profile");
    expect(JSON.stringify(result)).not.toContain("Never expose");
  });

  it("list is a collection gate, not per-row get filtering", async () => {
    const ast: SecurityRulesetAst = { version: 1, rules: [{ match: "mixed/{id}", allow: {
      list: true, get: { op: "==", left: { var: "resource.data.ownerId" }, right: { var: "auth.uid" } },
    } }] };
    const { engine } = createFixture({ ruleset: asRecord(ast) });
    await engine.createDocument({ projectId: TENANT.projectId, apiKeyRecord: serverKey("seed"),
      path: "mixed/private", data: { ownerId: "bob" } });
    const ctx = { projectId: TENANT.projectId, apiKeyRecord: key, authContext: owner };
    await expect(engine.getDocument({ ...ctx, path: "mixed/private" })).rejects.toMatchObject({ code: "PERMISSION_DENIED" });
    expect((await engine.executeQuery({ ...ctx, querySpec: { collectionPath: "mixed", limit: 10 } })).documents).toHaveLength(1);
  });
});

describe("built-ins and pitfalls from the guide", () => {
  const expression = (source: string, resourceData: Record<string, unknown> | null = null,
    requestData: Record<string, unknown> | null = null) => {
    const { ast, diagnostics } = compileRulesDsl(`match /x/{id} { allow get: if ${source}; }`);
    return { allowed: allowed(ast, "get", "x/one", owner, resourceData, requestData), diagnostics };
  };
  it("all identity/role helpers behave as documented", () => {
    for (const expr of ["isSignedIn()", "isAuth()", "isOwner('alice')", "!isOwner('bob')"]) {
      expect(expression(expr).allowed).toBe(true);
    }
    const ast = compileRulesDsl("match /x/{id} { allow get: if isEmailVerified() && hasRole('reviewer') && hasAnyRole(['reviewer','support']); }").ast;
    expect(allowed(ast, "get", "x/one", { ...owner, email_verified: true, claims: { role: "reviewer" } })).toBe(true);
    expect(allowed(ast, "get", "x/one", owner)).toBe(false);
  });
  it("hasKey checks direct keys, membership and the documented operators work", () => {
    expect(expression("hasKey(incoming, 'nested') && hasKey(incoming.nested, 'title')", null,
      { nested: { title: "Yes" } }).allowed).toBe(true);
    expect(expression("hasKey(incoming, 'nested.title')", null, { nested: { title: "No" } }).allowed).toBe(false);
    expect(expression("'a' in ['a','b'] && 1 < 2 && 2 <= 2 && 3 > 2 && 3 >= 3 && 1 != 2").allowed).toBe(true);
  });
  it("type predicates cover every documented accepted type", () => {
    const values = [["null", null], ["bool", true], ["boolean", false], ["string", "text"],
      ["number", 2], ["array", []], ["map", {}], ["int", { $t: "int", $v: "1" }],
      ["ts", { $t: "ts", $v: "2026-01-01T00:00:00.000Z" }], ["ref", { $t: "ref", $v: "x/one" }],
      ["bytes", { $t: "bytes", $v: "YQ==" }], ["geo", { $t: "geo", $v: { lat: 1, lng: 2 } }]];
    for (const [type, value] of values) expect(expression(`isType(incoming.value, '${type}')`, null, { value }).allowed, String(type)).toBe(true);
    expect(expression("isType(incoming.value, 'number')", null, { value: { $t: "int", $v: "1" } }).allowed).toBe(false);
  });
  it("unchanged sees full fields, onlyChanged is not an allowlist", () => {
    expect(expression("unchanged(['ownerId'])", { ownerId: "alice" }, { ownerId: "alice", title: "New" }).allowed).toBe(true);
    expect(expression("unchanged(['missing'])", {}, {}).allowed).toBe(false);
    const result = expression("onlyChanged(['title'])", { title: "Old", ownerId: "alice" }, { title: "New", ownerId: "bob" });
    expect(result.allowed).toBe(true);
    expect(result.diagnostics.length).toBeGreaterThan(0);
    expect(expression("unchanged([])").allowed).toBe(true);
    expect(expression("onlyChanged([])").allowed).toBe(true);
  });
  it("undefined and unknown functions can become grants under negation", () => {
    expect(expression("incoming.missing == null", null, {}).allowed).toBe(false);
    expect(expression("incoming.missing != null", null, {}).allowed).toBe(false);
    expect(expression("!(incoming.missing == null)", null, {}).allowed).toBe(true);
    expect(expression("!unknownFunction()").allowed).toBe(true);
    const ctx = { auth: guest, pathParams: {}, resourceData: null, requestData: null, requestTimeMs: 1 };
    expect(evaluateAstNode({ op: "!=", left: { var: "auth" }, right: { val: null } }, ctx)).toBe(true);
  });
});
