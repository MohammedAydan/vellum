import { describe, it, expect } from "vitest";
import { evaluateAstNode, type RuleEvaluationContext } from "../rules-ast.js";
import type { AuthContext } from "../jwt.js";

describe("Security Rules AST - request.auth aliases", () => {
  const auth: AuthContext = {
    uid: "user_1",
    claims: { role: "editor", team: { tier: "gold" } },
    email: "user@example.com",
    email_verified: true,
    is_anonymous: false,
    token: { sid: "session_1" },
  };
  const context: RuleEvaluationContext = {
    auth,
    pathParams: {},
    resourceData: null,
    requestData: null,
    requestTimeMs: 0,
  };

  it("evaluates auth.uid and request.auth.uid identically", () => {
    const legacy = evaluateAstNode(
      { op: "==", left: { var: "auth.uid" }, right: { val: "user_1" } },
      context
    );
    const aliased = evaluateAstNode(
      { op: "==", left: { var: "request.auth.uid" }, right: { val: "user_1" } },
      context
    );
    expect(legacy).toBe(true);
    expect(aliased).toBe(true);
    expect(aliased).toBe(legacy);

    // Both aliases resolve to null for an unauthenticated context.
    const anonymous: RuleEvaluationContext = { ...context, auth: { uid: null, claims: {} } };
    expect(
      evaluateAstNode(
        { op: "==", left: { var: "auth.uid" }, right: { val: "user_1" } },
        anonymous
      )
    ).toBe(
      evaluateAstNode(
        { op: "==", left: { var: "request.auth.uid" }, right: { val: "user_1" } },
        anonymous
      )
    );
  });

  it("evaluates auth.claims and request.auth.claims identically", () => {
    for (const path of ["auth.claims.role", "request.auth.claims.role"]) {
      expect(
        evaluateAstNode({ op: "==", left: { var: path }, right: { val: "editor" } }, context)
      ).toBe(true);
    }
    for (const path of ["auth.claims.team.tier", "request.auth.claims.team.tier"]) {
      expect(
        evaluateAstNode({ op: "==", left: { var: path }, right: { val: "gold" } }, context)
      ).toBe(true);
    }
    expect(
      evaluateAstNode(
        { op: "==", left: { var: "auth.claims.role" }, right: { val: "editor" } },
        context
      )
    ).toBe(
      evaluateAstNode(
        { op: "==", left: { var: "request.auth.claims.role" }, right: { val: "editor" } },
        context
      )
    );
  });

  it("exposes the whole auth object and the optional identity fields", () => {
    expect(
      evaluateAstNode({ op: "==", left: { var: "request.auth" }, right: { var: "auth" } }, context)
    ).toBe(true);
    expect(
      evaluateAstNode(
        { op: "==", left: { var: "request.auth.email" }, right: { val: "user@example.com" } },
        context
      )
    ).toBe(true);
    expect(
      evaluateAstNode(
        { op: "==", left: { var: "request.auth.email" }, right: { val: "user@example.com" } },
        context
      )
    ).toBe(
      evaluateAstNode(
        { op: "==", left: { var: "auth.email" }, right: { val: "user@example.com" } },
        context
      )
    );
    expect(
      evaluateAstNode(
        { op: "==", left: { var: "request.auth.email_verified" }, right: { val: true } },
        context
      )
    ).toBe(true);
    expect(
      evaluateAstNode(
        { op: "==", left: { var: "request.auth.is_anonymous" }, right: { val: false } },
        context
      )
    ).toBe(true);
  });
});
