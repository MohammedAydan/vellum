import { describe, expect, it } from "vitest";
import {
  DEFAULT_RULES_DSL,
  RULE_DSL_TEMPLATES,
  insertTemplateAtCursor,
  isVersionOneAst,
  parseJsonObject,
  parseRulesCompileError,
  safeDslFallback,
} from "../routes/_app/orgs.$orgId.projects.$projectId.rules.js";

describe("rules studio — quick-insert DSL templates", () => {
  it("defines the four documented templates", () => {
    expect(RULE_DSL_TEMPLATES.map((template) => template.id)).toEqual([
      "owner-read-write",
      "role-based-admin",
      "public-read-authenticated-create",
      "multi-tenant-organization-isolation",
    ]);
    for (const template of RULE_DSL_TEMPLATES) {
      expect(template.labelKey).toMatch(/^rules\.dsl\.template\./);
    }
  });

  it("emits valid DSL shape for every template", () => {
    for (const template of RULE_DSL_TEMPLATES) {
      expect(template.source).toContain("rules_version = '2';");
      expect(template.source).toMatch(/match \/[^\n{]+/);
      expect(template.source).toMatch(/allow (read|get|list|create|update|delete): if .+;/);
      expect(template.source).toContain("{");
      expect(template.source).toContain("}");
    }
  });

  it("uses built-in macros instead of dynamic code", () => {
    const [owner, rbac, publicRead, multiTenant] = RULE_DSL_TEMPLATES;
    expect(owner?.source).toContain("isOwner(");
    expect(owner?.source).toContain("isSignedIn()");
    expect(owner?.source).toContain("unchanged([");
    expect(rbac?.source).toContain("hasRole(");
    expect(publicRead?.source).toContain("allow read: if true;");
    expect(publicRead?.source).toContain("isSignedIn()");
    expect(multiTenant?.source).toContain("path.orgId");
    expect(multiTenant?.source).toContain("unchanged([");
    const combined = RULE_DSL_TEMPLATES.map((template) => template.source).join("\n");
    for (const macro of ["isSignedIn()", "isOwner(", "hasRole(", "unchanged(["]) {
      expect(combined).toContain(macro);
    }
    expect(combined).not.toMatch(/\beval\s*\(|new Function\s*\(/);
  });

  it("keeps the default fallback compilable-looking", () => {
    expect(DEFAULT_RULES_DSL).toContain("rules_version = '2';");
    expect(DEFAULT_RULES_DSL).toContain("match /users/{userId}");
  });
});

describe("rules studio — pure editor helpers", () => {
  it("inserts a template at the cursor in an empty editor", () => {
    const template = RULE_DSL_TEMPLATES[0]!.source;
    const result = insertTemplateAtCursor("", template, 0, 0);
    expect(result.value).toBe(template);
    expect(result.selectionStart).toBe(template.length);
    expect(result.selectionEnd).toBe(template.length);
  });

  it("preserves surrounding edits and separates inserted blocks", () => {
    const source = "match /a/{id} { allow read: if true; }";
    const template = "match /b/{id} { allow read: if true; }\n";
    const result = insertTemplateAtCursor(source, template, source.length, source.length);
    expect(result.value).toBe(`${source}\n\n${template}`);
    expect(result.selectionStart).toBe(source.length + 2 + template.length);
    expect(result.selectionStart).toBe(result.selectionEnd);
  });

  it("replaces the selected range only, with block separation", () => {
    const result = insertTemplateAtCursor("abcdef", "XYZ", 1, 4);
    expect(result.value).toBe("a\n\nXYZ\n\nef");
    expect(result.selectionStart).toBe("a\n\nXYZ".length);
  });

  it("clamps out-of-range cursor positions", () => {
    const result = insertTemplateAtCursor("abc", "Z", 99, -4);
    expect(result.value).toBe("abc\n\nZ");
    expect(result.selectionStart).toBe("abc\n\nZ".length);
  });

  it("falls back safely for non-string decompile responses", () => {
    expect(safeDslFallback(null)).toBe(DEFAULT_RULES_DSL);
    expect(safeDslFallback(undefined)).toBe(DEFAULT_RULES_DSL);
    expect(safeDslFallback("   ")).toBe(DEFAULT_RULES_DSL);
    expect(safeDslFallback(42)).toBe(DEFAULT_RULES_DSL);
    expect(safeDslFallback("match /x/{id} { allow read: if true; }")).toBe(
      "match /x/{id} { allow read: if true; }"
    );
  });

  it("reads positioned syntax errors from the 400 response body", () => {
    const issue = parseRulesCompileError(
      {
        error: {
          code: "INVALID_ARGUMENT",
          message: "Unexpected token @",
          line: 7,
          column: 12,
          snippet: "allow read: if @;\n           ^",
        },
      },
      "fallback",
      "match /x/{id} { allow read: if true; }"
    );
    expect(issue).toEqual({
      message: "Unexpected token @",
      line: 7,
      column: 12,
      snippet: "allow read: if @;\n           ^",
    });
  });

  it("derives position and snippet from a plain error message as a fallback", () => {
    const issue = parseRulesCompileError(
      null,
      "Unexpected token (line 3, column 5)",
      "one\ntwo\nbad tokens"
    );
    expect(issue.line).toBe(3);
    expect(issue.column).toBe(5);
    expect(issue.snippet).toContain("bad tokens");
    expect(issue.snippet).toContain("^");
  });

  it("accepts only version 1 ASTs", () => {
    expect(isVersionOneAst({ version: 1, rules: [] })).toBe(true);
    expect(isVersionOneAst({ version: 2, rules: [] })).toBe(false);
    expect(isVersionOneAst({ version: 1 })).toBe(false);
    expect(isVersionOneAst([])).toBe(false);
  });

  it("parses simulator mock JSON with safe fallbacks", () => {
    expect(parseJsonObject("  ")).toEqual({ ok: true, value: {} });
    expect(parseJsonObject('{"role":"admin"}')).toEqual({ ok: true, value: { role: "admin" } });
    expect(parseJsonObject("[1,2]")).toMatchObject({ ok: false });
    expect(parseJsonObject("{oops")).toMatchObject({ ok: false });
  });
});
