import { describe, it, expect } from "vitest";
import { compileRulesDsl } from "../index.js";

const compile = (cond: string) =>
  X;

describe("membership syntax in the rules DSL", () => {
  it("compiles `auth.uid in resource.memberIds` and `incoming.memberIds`", () => {
    expect(compile("auth.uid in resource.memberIds")).toEqual({ op: "in", left: { var: "auth.uid" }, right: { var: "resource.data.memberIds" } });
    expect(compile("auth.uid in incoming.memberIds")).toEqual({ op: "in", left: { var: "auth.uid" }, right: { var: "request.data.memberIds" } });
    expect(compile("auth.uid in request.resource.data.memberIds")).toEqual({ op: "in", left: { var: "auth.uid" }, right: { var: "request.data.memberIds" } });
  });
});
