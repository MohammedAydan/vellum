import { describe, it, expect } from "vitest";
import { compileRulesDsl, evaluateAstNode } from "../index.js";

function rule(cond: string) {
  const r = compileRulesDsl(`rules_version = '2';\nmatch /g/{id} {\n allow update: if ${cond};\n}`);
  const allow = (r.ast as unknown as { rules: Array<{ allow: Record<string, never> }> }).rules[0]!.allow;
  return allow.update ?? allow.write;
}
type C = { auth?: { uid: string | null }; request?: { data: Record<string, unknown> }; resource?: { data: Record<string, unknown> } };
const run = (cond: string, c: C) =>
  evaluateAstNode(rule(cond), {
    auth: (c.auth ?? { uid: null }) as never,
    pathParams: {},
    requestData: c.request?.data ?? null,
    resourceData: c.resource?.data ?? null,
    requestTimeMs: Date.now(),
  });

describe("unchanged()", () => {
  const c = "unchanged(['a'])";
  it("treats a field missing on both sides as unchanged", () => {
    expect(run(c, { request: { data: {} }, resource: { data: {} } })).toBe(true);
  });
  it("treats null on both sides as unchanged", () => {
    expect(run(c, { request: { data: { a: null } }, resource: { data: { a: null } } })).toBe(true);
  });
  it("treats equal values as unchanged and different values as changed", () => {
    expect(run(c, { request: { data: { a: 1 } }, resource: { data: { a: 1 } } })).toBe(true);
    expect(run(c, { request: { data: { a: 2 } }, resource: { data: { a: 1 } } })).toBe(false);
  });
  it("treats a field added or removed as changed", () => {
    expect(run(c, { request: { data: { a: 1 } }, resource: { data: {} } })).toBe(false);
    expect(run(c, { request: { data: {} }, resource: { data: { a: 1 } } })).toBe(false);
  });
});

describe("membership in an array field", () => {
  const c = "auth.uid in resource.data.memberIds";
  it("allows a member and refuses a non-member", () => {
    expect(run(c, { auth: { uid: "u1" }, resource: { data: { memberIds: ["u1", "u2"] } } })).toBe(true);
    expect(run(c, { auth: { uid: "u3" }, resource: { data: { memberIds: ["u1", "u2"] } } })).toBe(false);
  });
  it("never lets an anonymous caller match a null entry", () => {
    expect(run(c, { auth: { uid: null }, resource: { data: { memberIds: [null, "u1"] } } })).toBe(false);
  });
  it("refuses when the field is missing", () => {
    expect(run(c, { auth: { uid: "u1" }, resource: { data: {} } })).toBe(false);
  });
});
