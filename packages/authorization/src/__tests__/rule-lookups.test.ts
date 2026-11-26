import { describe, expect, it } from "vitest";
import {
  authorizeOperation,
  collectRuleLookups,
  compileRulesDsl,
  decompileRulesAstToDsl,
  rulesetUsesLookups,
  type SecurityRulesetRecord,
  type ApiKeyRecord,
} from "../index.js";

const DSL = `rules_version = '2';
match /chats/{chatId} {
  allow get: if isSignedIn() && auth.uid in resource.memberIds;
}
match /chats/{chatId}/messages/{messageId} {
  allow create: if isSignedIn()
    && incoming.senderId == auth.uid
    && auth.uid in get('chats', path.chatId).data.memberIds;
  allow get: if exists('chats', path.chatId);
  allow delete: if !(auth.uid in get('chats', path.chatId).data.banned);
}`;

const ruleset = (): SecurityRulesetRecord => ({
  id: "r", projectId: "p", version: 1, isActive: true, createdBy: null, createdAt: "",
  rulesAst: compileRulesDsl(DSL).ast as unknown as Record<string, unknown>,
});
const key = {
  id: "k", projectId: "p", name: "n", keyType: "public", keyPrefix: "pk_x", secretHash: "h", scopes: [], rateLimitRps: 1,
  lastUsedAt: null, expiresAt: null, revokedAt: null, createdBy: null, createdAt: "",
} as unknown as ApiKeyRecord;

const create = (uid: string | null, lookups?: Map<string, Record<string, unknown> | null>) =>
  authorizeOperation({
    apiKeyRecord: key, rulesetRecord: ruleset(), operation: "create", path: "chats/c1/messages/m1",
    authContext: { uid, claims: {} }, requestData: { senderId: uid }, lookups,
  });

describe("rules get() / exists()", () => {
  it("collects exactly the document the matching rule reads", () => {
    const paths = collectRuleLookups({
      rulesetRecord: ruleset(), operation: "create", path: "chats/c1/messages/m1",
      authContext: { uid: "u1", claims: {} }, requestData: { senderId: "u1" },
    });
    expect(paths).toEqual(["chats/c1"]);
    expect(collectRuleLookups({ rulesetRecord: ruleset(), operation: "get", path: "chats/c1" })).toEqual([]);
    expect(rulesetUsesLookups(ruleset())).toBe(true);
  });

  it("allows a member and denies a non-member", () => {
    const lookups = new Map([["chats/c1", { memberIds: ["u1", "u2"] }]]);
    expect(create("u1", lookups).allowed).toBe(true);
    expect(() => create("u3", lookups)).toThrow(/denied/);
  });

  it("denies when the document is missing or was not read", () => {
    expect(() => create("u1", new Map([["chats/c1", null]]))).toThrow(/denied/);
    expect(() => create("u1", new Map())).toThrow(/denied/);
    expect(() => create("u1")).toThrow(/denied/);
  });

  it("a missing document never passes through a negation", () => {
    const del = (lookups?: Map<string, Record<string, unknown> | null>) =>
      authorizeOperation({
        apiKeyRecord: key, rulesetRecord: ruleset(), operation: "delete", path: "chats/c1/messages/m1",
        authContext: { uid: "u1", claims: {} }, lookups,
      });
    expect(del(new Map([["chats/c1", { banned: [] }]])).allowed).toBe(true);
    expect(() => del(new Map([["chats/c1", { banned: ["u1"] }]]))).toThrow(/denied/);
    expect(() => del(new Map([["chats/c1", null]]))).toThrow(/denied/);
    expect(() => del()).toThrow(/denied/);
  });

  it("exists() reflects the lookup result", () => {
    const get = (v: Record<string, unknown> | null) =>
      authorizeOperation({
        apiKeyRecord: key, rulesetRecord: ruleset(), operation: "get", path: "chats/c1/messages/m1",
        authContext: { uid: "u1", claims: {} }, lookups: new Map([["chats/c1", v]]),
      });
    expect(get({}).allowed).toBe(true);
    expect(() => get(null)).toThrow(/denied/);
  });

  it("refuses an id that could escape the collection", () => {
    const r = compileRulesDsl(`match /a/{x} { allow get: if exists('b', incoming.ref); }`);
    const paths = collectRuleLookups({
      rulesetRecord: { rulesAst: r.ast }, operation: "get", path: "a/1",
      authContext: { uid: "u", claims: {} }, requestData: { ref: "../secret/x" },
    });
    expect(paths).toEqual([]);
  });

  it("rejects lookups in list and read rules, and round-trips through decompile", () => {
    expect(() => compileRulesDsl(`match /a/{x} { allow list: if exists('b', x); }`)).toThrow(/list/);
    expect(() => compileRulesDsl(`match /a/{x} { allow read: if exists('b', x); }`)).toThrow(/list/);
    expect(() => compileRulesDsl(`match /a/{x} { allow get: if exists(b, x); }`)).toThrow(/collection path in quotes/);
    const again = compileRulesDsl(decompileRulesAstToDsl(ruleset().rulesAst as never)).ast;
    expect(again).toEqual(ruleset().rulesAst);
  });
});
