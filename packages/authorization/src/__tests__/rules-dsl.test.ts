import { describe, it, expect } from "vitest";
import {
  compileRulesDsl,
  decompileRulesAstToDsl,
  simulateRuleEvaluation,
  RulesDslSyntaxError,
  validateSecurityRulesetAst,
  type SecurityRulesetAst,
  type AstExpression,
} from "../index.js";

/** Compile one boolean expression wrapped in a minimal rule. */
function compileExpr(expression: string): AstExpression {
  const { ast } = compileRulesDsl(`match /x/{id} { allow read: if ${expression}; }`);
  return ast.rules[0]!.allow["get"]!;
}

/**
 * Canonical form for semantic equivalence: `all([x])`/`any([x])` evaluate
 * identically to `x`, so decompiling those wrappers back into a bare
 * expression is a valid round-trip.
 */
function canonicalAst(ast: SecurityRulesetAst): string {
  const normExpr = (value: unknown): unknown => {
    if (typeof value !== "object" || value === null) return value;
    const node = value as Record<string, unknown>;
    const op = node["op"];
    if (op === "all" || op === "any") {
      const conditions = (node["conditions"] as unknown[] | undefined) ?? [];
      if (conditions.length === 1) return normExpr(conditions[0]);
      return { op, conditions: conditions.map(normExpr) };
    }
    if (op === "not") return { op: "not", condition: normExpr(node["condition"]) };
    const result: Record<string, unknown> = { op };
    if (node["left"] !== undefined) result["left"] = normOperand(node["left"]);
    if (node["right"] !== undefined) result["right"] = normOperand(node["right"]);
    return result;
  };
  const normOperand = (value: unknown): unknown => {
    if (value && typeof value === "object" && "op" in (value as object)) return normExpr(value);
    return value;
  };
  return JSON.stringify({
    version: ast.version,
    rules: ast.rules.map((rule) => ({
      match: rule.match,
      allow: Object.fromEntries(
        Object.entries(rule.allow)
          .filter(([, expr]) => expr !== undefined)
          .map(([op, expr]) => [op, normExpr(expr)])
      ),
    })),
  });
}

const FULL_EXAMPLE = `
rules_version = '2';

function isSignedIn() { return auth != null; }
function isOwner(userId) { return isSignedIn() && auth.uid == userId; }
function hasRole(role) { return auth.claims.role == role; }

match /posts/{postId} {
  allow read: if true;
  allow create: if isSignedIn() && incoming.authorId == auth.uid;
  allow update: if isOwner(resource.authorId) && unchanged(['authorId', 'createdAt']);
  allow delete: if isOwner(resource.authorId) || hasRole('admin');
}
`;

describe("Rules DSL compiler", () => {
  it("compiles the full documented example into a v1 AST with expanded operations", () => {
    const { ast, diagnostics } = compileRulesDsl(FULL_EXAMPLE);
    expect(ast.version).toBe(1);
    expect(ast.rules).toHaveLength(1);
    expect(ast.rules[0]!.match).toBe("/posts/{postId}");
    expect(Object.keys(ast.rules[0]!.allow).sort()).toEqual(
      ["create", "delete", "get", "list", "update"].sort()
    );
    expect(diagnostics).toEqual([]);
    expect(() => validateSecurityRulesetAst(ast)).not.toThrow();
  });

  it("expands `read` into get+list and `write` into create+update+delete", () => {
    const readAst = compileRulesDsl("match /x/{id} { allow read: if true; }").ast;
    expect(readAst.rules[0]!.allow["get"]).toBe(true);
    expect(readAst.rules[0]!.allow["list"]).toBe(true);

    const writeAst = compileRulesDsl("match /x/{id} { allow write: if auth.uid != null; }").ast;
    for (const op of ["create", "update", "delete"]) {
      expect(writeAst.rules[0]!.allow[op]).toEqual({
        op: "!=",
        left: { var: "auth.uid" },
        right: { val: null },
      });
    }
  });

  it("expands built-in isSignedIn() and isAuth() to auth.uid != null", () => {
    const expected = { op: "!=", left: { var: "auth.uid" }, right: { val: null } };
    expect(compileExpr("isSignedIn()")).toEqual(expected);
    expect(compileExpr("isAuth()")).toEqual(expected);
  });

  it("expands built-in isOwner(expr) to an authenticated + equality conjunction", () => {
    expect(compileExpr("isOwner(resource.authorId)")).toEqual({
      op: "all",
      conditions: [
        { op: "!=", left: { var: "auth.uid" }, right: { val: null } },
        { op: "==", left: { var: "auth.uid" }, right: { var: "resource.data.authorId" } },
      ],
    });
  });

  it("expands built-in hasRole(role)", () => {
    expect(compileExpr("hasRole('admin')")).toEqual({
      op: "==",
      left: { var: "auth.claims.role" },
      right: { val: "admin" },
    });
  });

  it("expands built-in hasAnyRole([...]) to an `in` node", () => {
    expect(compileExpr('hasAnyRole(["admin", "editor"])')).toEqual({
      op: "in",
      left: { var: "auth.claims.role" },
      right: { val: ["admin", "editor"] },
    });
  });

  it("expands built-in isEmailVerified()", () => {
    expect(compileExpr("isEmailVerified()")).toEqual({
      op: "==",
      left: { var: "auth.email_verified" },
      right: { val: true },
    });
  });

  it("expands built-in unchanged([...]) into field-by-field equality in `all`", () => {
    const field = (f: string) => ({
      op: "any",
      conditions: [
        { op: "==", left: { var: `request.data.${f}` }, right: { var: `resource.data.${f}` } },
        {
          op: "all",
          conditions: [
            { op: "not", condition: { op: "hasKey", left: { var: "request.data" }, right: { val: f } } },
            { op: "not", condition: { op: "hasKey", left: { var: "resource.data" }, right: { val: f } } },
          ],
        },
      ],
    });
    expect(compileExpr("unchanged(['authorId', 'createdAt'])")).toEqual({
      op: "all",
      conditions: [field("authorId"), field("createdAt")],
    });
    expect(compileExpr("unchanged([])")).toBe(true);
  });

  it("expands built-in onlyChanged([...]) and emits a limitation diagnostic", () => {
    const result = compileRulesDsl("match /x/{id} { allow update: if onlyChanged(['a','b']); }");
    expect(result.ast.rules[0]!.allow["update"]).toEqual({
      op: "all",
      conditions: [
        {
          op: "not",
          condition: { op: "==", left: { var: "request.data.a" }, right: { var: "resource.data.a" } },
        },
        {
          op: "not",
          condition: { op: "==", left: { var: "request.data.b" }, right: { var: "resource.data.b" } },
        },
      ],
    });
    expect(result.diagnostics.some((d) => d.message.includes("onlyChanged"))).toBe(true);
  });

  it("supports hasKey / isType both as infix operators and as function calls", () => {
    const infix = compileExpr("resource hasKey 'title'");
    const call = compileExpr("hasKey(resource, 'title')");
    expect(infix).toEqual({ op: "hasKey", left: { var: "resource.data" }, right: { val: "title" } });
    expect(call).toEqual(infix);

    expect(compileExpr("resource.data.score isType 'number'")).toEqual({
      op: "isType",
      left: { var: "resource.data.score" },
      right: { val: "number" },
    });
  });

  it("normalizes all documented variable aliases", () => {
    expect(compileExpr("auth.uid == path.id")).toEqual({
      op: "==",
      left: { var: "auth.uid" },
      right: { var: "path.id" },
    });
    expect(compileExpr("resource.authorId == incoming.authorId")).toEqual({
      op: "==",
      left: { var: "resource.data.authorId" },
      right: { var: "request.data.authorId" },
    });
    expect(compileExpr("request.auth.uid == auth.uid")).toEqual({
      op: "==",
      left: { var: "auth.uid" },
      right: { var: "auth.uid" },
    });
    expect(compileExpr("request.resource.data.title == resource.data.title")).toEqual({
      op: "==",
      left: { var: "request.data.title" },
      right: { var: "resource.data.title" },
    });
    expect(compileExpr("resource.data.nested.deep == incoming.data.nested.deep")).toEqual({
      op: "==",
      left: { var: "resource.data.nested.deep" },
      right: { var: "request.data.data.nested.deep" },
    });
  });

  it("supports comments, both string quote styles, arrays and numbers", () => {
    const result = compileRulesDsl(`
      // line comment
      rules_version = '2';
      /* block
         comment */
      match /x/{id} {
        allow read: if auth.claims.level >= 3 && auth.claims.tag in ['a', "b"];
      }
    `);
    expect(result.ast.rules[0]!.allow["get"]).toEqual({
      op: "all",
      conditions: [
        { op: ">=", left: { var: "auth.claims.level" }, right: { val: 3 } },
        { op: "in", left: { var: "auth.claims.tag" }, right: { val: ["a", "b"] } },
      ],
    });
  });

  it("compiles every comparison operator, `not` and parenthesis grouping", () => {
    expect(compileExpr("resource.data.score < 10")).toEqual({
      op: "<", left: { var: "resource.data.score" }, right: { val: 10 },
    });
    expect(compileExpr("resource.data.score <= 10")).toEqual({
      op: "<=", left: { var: "resource.data.score" }, right: { val: 10 },
    });
    expect(compileExpr("resource.data.score > 10")).toEqual({
      op: ">", left: { var: "resource.data.score" }, right: { val: 10 },
    });
    expect(compileExpr("resource.data.score != 10")).toEqual({
      op: "!=", left: { var: "resource.data.score" }, right: { val: 10 },
    });
    expect(compileExpr("!(auth.uid == 'x')")).toEqual({
      op: "not",
      condition: { op: "==", left: { var: "auth.uid" }, right: { val: "x" } },
    });
    expect(compileExpr("(auth.uid == 'x' || auth.uid == 'y') && true")).toEqual({
      op: "all",
      conditions: [
        {
          op: "any",
          conditions: [
            { op: "==", left: { var: "auth.uid" }, right: { val: "x" } },
            { op: "==", left: { var: "auth.uid" }, right: { val: "y" } },
          ],
        },
        true,
      ],
    });
  });

  it("inlines nested user functions (no call nodes remain)", () => {
    const dsl = `
      function isAdmin() { return auth.claims.role == 'admin'; }
      function canManage() { return isAdmin() && auth.uid != null; }
      match /x/{id} { allow write: if canManage(); }
    `;
    const { ast } = compileRulesDsl(dsl);
    const expr = ast.rules[0]!.allow["create"]!;
    expect(expr).toEqual({
      op: "all",
      conditions: [
        { op: "==", left: { var: "auth.claims.role" }, right: { val: "admin" } },
        { op: "!=", left: { var: "auth.uid" }, right: { val: null } },
      ],
    });
    expect(JSON.stringify(ast)).not.toContain('"call"');
  });

  it("inlines user functions with multiple substituted parameters", () => {
    const dsl = `
      function eq(a, b) { return a == b; }
      match /x/{id} { allow read: if eq(incoming.title, resource.title); }
    `;
    const { ast } = compileRulesDsl(dsl);
    expect(ast.rules[0]!.allow["get"]).toEqual({
      op: "==",
      left: { var: "request.data.title" },
      right: { var: "resource.data.title" },
    });
  });

  it("gives user-defined functions precedence over same-named built-ins", () => {
    // The example redefines isSignedIn() as `auth != null`, not the built-in.
    const { ast } = compileRulesDsl(FULL_EXAMPLE);
    const createExpr = ast.rules[0]!.allow["create"]! as { conditions: AstExpression[] };
    const first = createExpr.conditions[0]! as { op: string; left: { var: string } };
    expect(first.op).toBe("!=");
    expect(first.left.var).toBe("auth"); // user's `auth != null`, NOT `auth.uid != null`
  });

  it("flattens nested match blocks and preserves recursive wildcards", () => {
    const { ast } = compileRulesDsl(`
      match /orgs/{orgId} {
        match /docs/{path=**} {
          allow read: if auth.uid != null;
        }
      }
    `);
    expect(ast.rules[0]!.match).toBe("/orgs/{orgId}/docs/{path=**}");
    expect(validateSecurityRulesetAst(ast)).toBe(true);
  });

  it("rejects recursive user functions with a positioned syntax error", () => {
    expect(() =>
      compileRulesDsl(`
        function bad() { return bad(); }
        match /x/{id} { allow read: if bad(); }
      `)
    ).toThrow(RulesDslSyntaxError);
  });

  it("returns a diagnostic for unknown functions instead of throwing", () => {
    const result = compileRulesDsl("match /x/{id} { allow read: if notDefined(); }");
    expect(result.ast.rules[0]!.allow["get"]).toBe(false);
    expect(result.diagnostics.some((d) => d.message.includes("notDefined"))).toBe(true);
  });

  it("returns a diagnostic for unknown variables instead of throwing", () => {
    const result = compileRulesDsl("match /x/{id} { allow read: if mystery.foo == 1; }");
    expect(result.diagnostics.some((d) => d.message.includes("mystery.foo"))).toBe(true);
    expect(() => validateSecurityRulesetAst(result.ast)).not.toThrow();
  });

  it("returns a diagnostic for a non-'2' rules_version declaration", () => {
    const result = compileRulesDsl("rules_version = '9';\nmatch /x/{id} { allow read: if true; }");
    expect(result.ast.version).toBe(1);
    expect(result.diagnostics.some((d) => d.message.includes("rules_version"))).toBe(true);
  });

  it("throws a positioned syntax error for a missing colon", () => {
    const source = "match /posts/{postId} {\n  allow read if true;\n}";
    try {
      compileRulesDsl(source);
      throw new Error("expected a syntax error");
    } catch (err) {
      expect(err).toBeInstanceOf(RulesDslSyntaxError);
      const e = err as RulesDslSyntaxError;
      expect(e.line).toBe(2);
      expect(e.column).toBe(14); // the `if` token
      expect(e.snippet).toContain("allow read if true;");
      expect(e.snippet).toContain("^");
    }
  });

  it("throws a positioned syntax error for an unterminated string", () => {
    const source = "match /x/{id} {\n  allow read: if 'oops;\n}";
    try {
      compileRulesDsl(source);
      throw new Error("expected a syntax error");
    } catch (err) {
      const e = err as RulesDslSyntaxError;
      expect(e.line).toBe(2);
      expect(e.column).toBe(18); // opening quote
      expect(e.snippet).toContain("'oops;");
      expect(e.snippet).toContain("^");
    }
  });

  it("throws a positioned syntax error for an unexpected token in an expression", () => {
    const source = "match /x/{id} {\n  allow read: if ;\n}";
    try {
      compileRulesDsl(source);
      throw new Error("expected a syntax error");
    } catch (err) {
      const e = err as RulesDslSyntaxError;
      expect(e.line).toBe(2);
      expect(e.column).toBe(18); // the `;` token
      expect(e.snippet).toContain("allow read: if ;");
    }
  });

  it("throws a positioned syntax error for an unknown character", () => {
    const source = "match /x/{id} {\n  allow read: if @;\n}";
    try {
      compileRulesDsl(source);
      throw new Error("expected a syntax error");
    } catch (err) {
      const e = err as RulesDslSyntaxError;
      expect(e.line).toBe(2);
      expect(e.column).toBe(18);
      expect(e.snippet).toContain("@");
    }
  });

  it("enforces the v1 AST depth limit", () => {
    const dsl = `match /x/{id} { allow read: if ${"!".repeat(12)}true; }`;
    expect(() => compileRulesDsl(dsl)).toThrow(RulesDslSyntaxError);
  });

  it("enforces the v1 AST node limit", () => {
    const dsl = `match /x/{id} { allow read: if ${Array.from({ length: 101 }, () => "true").join(" || ")}; }`;
    expect(() => compileRulesDsl(dsl)).toThrow(RulesDslSyntaxError);
  });

  it("rejects an empty ruleset", () => {
    expect(() => compileRulesDsl("rules_version = '2';")).toThrow(RulesDslSyntaxError);
  });
});

describe("Rules AST decompiler", () => {
  it("emits rules_version '2', one match block per rule and one allow line per operation", () => {
    const { ast } = compileRulesDsl(FULL_EXAMPLE);
    const dsl = decompileRulesAstToDsl(ast);
    expect(dsl).toContain("rules_version = '2';");
    expect(dsl).toContain("match /posts/{postId} {");
    expect(dsl).toContain("allow get: if true;");
    expect(dsl).toContain("allow list: if true;");
    expect(dsl).toContain("allow create: if");
    expect(dsl).toContain("allow update: if");
    expect(dsl).toContain("allow delete: if");
  });

  it("round-trips compile -> decompile -> compile to a semantically equal AST", () => {
    const original = compileRulesDsl(FULL_EXAMPLE).ast;
    const roundTripped = compileRulesDsl(decompileRulesAstToDsl(original)).ast;
    expect(canonicalAst(roundTripped)).toBe(canonicalAst(original));
  });

  it("round-trips macro-heavy and function-inlined rulesets", () => {
    const dsl = `
      function owner(u) { return isOwner(u); }
      match /docs/{docId} {
        allow read: if hasAnyRole(['admin','editor']) || isEmailVerified();
        allow update: if owner(resource.ownerId) && unchanged(['x']);
        allow delete: if resource hasKey 'locked' && isType(resource.data.locked, 'bool');
      }
    `;
    const original = compileRulesDsl(dsl).ast;
    const roundTripped = compileRulesDsl(decompileRulesAstToDsl(original)).ast;
    expect(canonicalAst(roundTripped)).toBe(canonicalAst(original));
  });
});

describe("simulateRuleEvaluation", () => {
  const ast = compileRulesDsl(`
    match /posts/{postId} {
      allow get: if true;
      allow list: if auth.uid != null;
      allow create: if isSignedIn() && incoming.authorId == auth.uid;
      allow update: if isOwner(resource.authorId) && unchanged(['authorId', 'createdAt']);
      allow delete: if hasRole('admin');
    }
  `).ast;

  it("ALLOWs a public read and traces the tested path pattern and decision", () => {
    const result = simulateRuleEvaluation({
      ruleset: ast,
      operation: "get",
      path: "/posts/p1",
      auth: null,
    });
    expect(result.allowed).toBe(true);
    expect(result.matchedRule).toBe("/posts/{postId}");
    expect(result.evaluationTrace.some((l) => l.includes("path pattern tested"))).toBe(true);
    expect(result.evaluationTrace.some((l) => l.includes("MATCH"))).toBe(true);
    expect(result.evaluationTrace.some((l) => l.includes("literal true → true"))).toBe(true);
    expect(result.evaluationTrace.some((l) => l.includes("DECISION: ALLOW"))).toBe(true);
  });

  it("ALLOWs create for the document owner and traces every AST node result", () => {
    const result = simulateRuleEvaluation({
      ruleset: ast,
      operation: "create",
      path: "/posts/p1",
      auth: { uid: "u1", claims: {} },
      incomingData: { authorId: "u1" },
    });
    expect(result.allowed).toBe(true);
    expect(result.evaluationTrace.some((l) => l.includes("all[0]"))).toBe(true);
    expect(result.evaluationTrace.some((l) => l.includes("all[1]"))).toBe(true);
    expect(result.evaluationTrace.some((l) => l.includes("all → true"))).toBe(true);
    expect(result.evaluationTrace.at(-1)).toContain("DECISION: ALLOW");
  });

  it("DENIES create for an unauthenticated caller", () => {
    const result = simulateRuleEvaluation({
      ruleset: ast,
      operation: "create",
      path: "/posts/p1",
      auth: { uid: null, claims: {} },
      incomingData: { authorId: "u1" },
    });
    expect(result.allowed).toBe(false);
    expect(result.matchedRule).toBeNull();
    expect(result.evaluationTrace.some((l) => l.includes("all[0]") && l.includes("→ false"))).toBe(true);
    expect(result.evaluationTrace.at(-1)).toContain("DECISION: DENY");
  });

  it("ALLOWs delete for an admin role and DENIES it for a normal user", () => {
    const admin = simulateRuleEvaluation({
      ruleset: ast,
      operation: "delete",
      path: "/posts/p1",
      auth: { uid: "u2", claims: { role: "admin" } },
    });
    const member = simulateRuleEvaluation({
      ruleset: ast,
      operation: "delete",
      path: "/posts/p1",
      auth: { uid: "u2", claims: { role: "member" } },
    });
    expect(admin.allowed).toBe(true);
    expect(member.allowed).toBe(false);
  });

  it("DENIES when no rule pattern matches and records NO MATCH", () => {
    const result = simulateRuleEvaluation({
      ruleset: ast,
      operation: "get",
      path: "/comments/c1",
      auth: null,
    });
    expect(result.allowed).toBe(false);
    expect(result.evaluationTrace.some((l) => l.includes("NO MATCH"))).toBe(true);
  });

  it("accepts a ruleset wrapped as { rulesAst }", () => {
    const result = simulateRuleEvaluation({
      ruleset: { rulesAst: ast as SecurityRulesetAst },
      operation: "get",
      path: "posts/p1",
      auth: null,
    });
    expect(result.allowed).toBe(true);
  });

  it("uses the read/write fallback when a specific operation is absent", () => {
    const fallbackAst = compileRulesDsl("match /x/{id} { allow read: if auth.uid != null; }").ast;
    const denied = simulateRuleEvaluation({ ruleset: fallbackAst, operation: "get", path: "/x/1", auth: null });
    const allowed = simulateRuleEvaluation({
      ruleset: fallbackAst,
      operation: "get",
      path: "/x/1",
      auth: { uid: "u1", claims: {} },
    });
    expect(denied.allowed).toBe(false);
    expect(allowed.allowed).toBe(true);
  });

  it("round-trips the V2 relations testbed ruleset through compile -> decompile -> compile", () => {
    const dsl = `rules_version = '2';
match /v2posts/{postId} {
  allow read: if auth.uid != null;
  allow write: if auth.uid != null;
}
match /v2users/{uid} {
  allow get: if auth.uid == path.uid;
}
match /v2metrics/{docId} {
  allow read: if true;
  allow write: if true;
}`;
    const compiled = compileRulesDsl(dsl);
    expect(compiled.ast.version).toBe(1);
    expect(compiled.ast.rules.map((rule) => rule.match)).toEqual([
      "/v2posts/{postId}",
      "/v2users/{uid}",
      "/v2metrics/{docId}",
    ]);
    const decompiled = decompileRulesAstToDsl(compiled.ast);
    expect(decompiled).toContain("rules_version = '2';");
    const roundTripped = compileRulesDsl(decompiled).ast;
    expect(canonicalAst(roundTripped)).toBe(canonicalAst(compiled.ast));
  });

  it("simulates the V2 public-key relation redaction rules deterministically", () => {
    const ast = compileRulesDsl(`
      match /v2posts/{postId} { allow get: if true; }
      match /v2users/{uid} { allow get: if auth.uid == path.uid; }
    `).ast;
    const readable = simulateRuleEvaluation({
      ruleset: ast,
      operation: "get",
      path: "/v2users/alice",
      auth: { uid: "alice", claims: {} },
    });
    const redacted = simulateRuleEvaluation({
      ruleset: ast,
      operation: "get",
      path: "/v2users/bob",
      auth: { uid: "alice", claims: {} },
    });
    expect(readable.allowed).toBe(true);
    expect(redacted.allowed).toBe(false);
    expect(redacted.evaluationTrace.at(-1)).toContain("DENY");
  });

  it("evaluates unchanged() against resource and incoming data during simulation", () => {
    const updateAst = compileRulesDsl(
      "match /posts/{postId} { allow update: if unchanged(['title']); }"
    ).ast;
    const ok = simulateRuleEvaluation({
      ruleset: updateAst,
      operation: "update",
      path: "/posts/p1",
      auth: null,
      resourceData: { title: "same" },
      incomingData: { title: "same" },
    });
    const bad = simulateRuleEvaluation({
      ruleset: updateAst,
      operation: "update",
      path: "/posts/p1",
      auth: null,
      resourceData: { title: "before" },
      incomingData: { title: "after" },
    });
    expect(ok.allowed).toBe(true);
    expect(bad.allowed).toBe(false);
  });
});
