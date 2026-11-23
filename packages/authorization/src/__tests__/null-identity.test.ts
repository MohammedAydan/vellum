import { describe, expect, it } from "vitest";
import { evaluateAstNode, type AstExpression } from "../index.js";

const ctx = (uid: string | null, resourceData: Record<string, unknown> | null) => ({
  auth: { uid, claims: {} },
  pathParams: {},
  resourceData,
  requestData: null,
  requestTimeMs: Date.now(),
});
const ownerIsCaller: AstExpression = { op: "==", left: { var: "resource.data.owner" }, right: { var: "auth.uid" } };
const signedIn: AstExpression = { op: "!=", left: { var: "auth.uid" }, right: { val: null } };

describe("unauthenticated identity never equals null", () => {
  it("does not match a null owner field for an anonymous caller", () => {
    expect(evaluateAstNode(ownerIsCaller, ctx(null, { owner: null }))).toBe(false);
  });
  it("does not match when both sides are the anonymous identity", () => {
    const both: AstExpression = { op: "==", left: { var: "auth.uid" }, right: { var: "request.auth.uid" } };
    expect(evaluateAstNode(both, ctx(null, {}))).toBe(false);
  });
  it("still matches for a signed-in owner and keeps the signed-in idiom working", () => {
    expect(evaluateAstNode(ownerIsCaller, ctx("u1", { owner: "u1" }))).toBe(true);
    expect(evaluateAstNode(ownerIsCaller, ctx("u1", { owner: "u2" }))).toBe(false);
    expect(evaluateAstNode(signedIn, ctx("u1", {}))).toBe(true);
    expect(evaluateAstNode(signedIn, ctx(null, {}))).toBe(false);
  });
});
