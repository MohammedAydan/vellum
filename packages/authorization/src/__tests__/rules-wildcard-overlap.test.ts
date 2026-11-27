import { describe, expect, it } from "vitest";
import { compileRulesDsl } from "../rules-dsl.js";

/**
 * WILDCARD_OVERLAP compiler diagnostic (0.0.9): a parameterized wildcard match
 * that also covers a stricter explicit sibling path must warn, because rules
 * OR together and the broader block silently bypasses the sibling.
 */

describe("wildcard overlap diagnostics", () => {
  it("warns when a wildcard match overlaps a stricter explicit sibling", () => {
    const { diagnostics } = compileRulesDsl(`
match /chats/{chatId}/{sub}/{docId} { allow create: if auth.uid != null; }
match /chats/{chatId}/messages/{msgId} { allow create: if auth.uid == incoming.senderId && auth.uid in incoming.memberIds; }
`);
    const warnings = diagnostics.filter((d) => d.message.includes("WILDCARD_OVERLAP"));
    expect(warnings.length).toBe(1);
    expect(warnings[0]!.message).toContain("'create'");
    expect(warnings[0]!.message).toContain("sub != 'messages'");
  });

  it("clears the warning when the wildcard is guarded", () => {
    const { diagnostics } = compileRulesDsl(`
match /chats/{chatId}/{sub}/{docId} { allow create: if auth.uid != null && sub != 'messages'; }
match /chats/{chatId}/messages/{msgId} { allow create: if auth.uid == incoming.senderId; }
`);
    expect(diagnostics.filter((d) => d.message.includes("WILDCARD_OVERLAP"))).toHaveLength(0);
  });

  it("does not warn when the wildcard predicate is at least as strict as the sibling", () => {
    const { diagnostics } = compileRulesDsl(`
match /chats/{chatId}/{sub}/{docId} { allow create: if auth.uid == incoming.senderId && auth.uid in incoming.memberIds; }
match /chats/{chatId}/messages/{msgId} { allow create: if auth.uid != null; }
`);
    expect(diagnostics.filter((d) => d.message.includes("WILDCARD_OVERLAP"))).toHaveLength(0);
  });

  it("does not warn for disjoint paths", () => {
    const { diagnostics } = compileRulesDsl(`
match /chats/{chatId} { allow read: if true; }
match /users/{userId} { allow read: if auth.uid != null; }
`);
    expect(diagnostics.filter((d) => d.message.includes("WILDCARD_OVERLAP"))).toHaveLength(0);
  });

  it("warns when a recursive wildcard swallows a stricter nested sibling", () => {
    const { diagnostics } = compileRulesDsl(`
match /chats/{chatId}/{rest=**} { allow read: if auth.uid != null; }
match /chats/{chatId}/messages/{msgId} { allow read: if auth.uid in resource.memberIds; }
`);
    const warnings = diagnostics.filter((d) => d.message.includes("WILDCARD_OVERLAP"));
    expect(warnings.length).toBe(1);
  });
});
