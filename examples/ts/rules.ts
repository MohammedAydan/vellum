/**
 * Security rules AST — publish a deny-by-default v1 ruleset.
 *
 * What you'll build: a versioned ruleset that grants exactly one scoped
 * permission (read plus a conditional create) and denies everything else.
 * Real-world scenario: locking down a new collection means publishing a rule
 * whose only `allow` clauses are explicit; any operation not matched is denied
 * by default. The example verifies the active version, rejects a malformed AST,
 * and restores the original ruleset in `finally` so no policy change leaks.
 */
import { harness, check } from "./_harness.js";

const h = await harness("rules");
const rulesPath = `/projects/${h.projectId}/rulesets`;
const original = await h.api.console<{ rulesAst?: unknown }>("GET", rulesPath);
let originalAst: unknown = original.body.rulesAst ?? { version: 1, rules: [] };

try {
  h.log("=== Security Rules AST ===");
  const beforeVersion = (original.body as { version?: number }).version ?? 0;
  h.log({
    before: {
      hasRuleset: beforeVersion > 0,
      ruleCount: Array.isArray((original.body as { rulesAst?: { rules?: unknown[] } }).rulesAst?.rules)
        ? (original.body as { rulesAst: { rules: unknown[] } }).rulesAst.rules.length
        : 0,
    },
  });

  // Deny by default: only `read` and a conditional `create` are allowed for
  // this one collection. update/delete (and all other paths) are not listed.
  const ast = {
    version: 1,
    rules: [
      {
        match: `${h.prefix}/{docId}`,
        allow: {
          read: true,
          create: {
            op: "==",
            left: { var: "request.data.team" },
            right: { val: "red" },
          },
        },
      },
    ],
  };
  const published = await h.api.console("POST", rulesPath, { rulesAst: ast });
  check(published.status === 201, "valid AST publishes with HTTP 201");
  const publishedBody = published.body as { id: string; version: number };
  h.log({ publish: "ok", versionAdvancedBy: publishedBody.version - beforeVersion, ruleCount: ast.rules.length });

  const active = await h.api.console<{
    version: number;
    rulesAst: { version: number; rules: Array<{ match: string; allow: Record<string, unknown> }> };
  }>("GET", rulesPath);
  check(active.body.rulesAst.rules.length === 1, "published rule is the active ruleset");
  check(active.body.version >= publishedBody.version, "active version did not regress");
  h.log({
    activeVersionMatchesPublished: active.body.version === publishedBody.version,
    astVersion: active.body.rulesAst.version,
    match: active.body.rulesAst.rules[0]?.match,
    operations: Object.keys(active.body.rulesAst.rules[0]?.allow ?? {}),
  });

  const invalid = await h.api.console("POST", rulesPath, { rulesAst: { version: 2, rules: [] } });
  const invalidCode = (invalid.body as { error?: { code?: string } })?.error?.code;
  check(invalid.status === 400 && invalidCode === "INVALID_ARGUMENT", "unsupported AST version is rejected");
  h.log({ invalidAst: { status: invalid.status, code: invalidCode } });
} finally {
  try {
    await h.api.console("POST", rulesPath, { rulesAst: originalAst });
  } catch {
    // Best effort restoration.
  }
  await h.cleanup();
}
