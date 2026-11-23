/**
 * Security rules AST (REST) — publish a deny-by-default v1 ruleset.
 *
 * What you'll build: a versioned ruleset with one explicit scoped allow,
 * verified through the Console API, then restored.
 * Real-world scenario: locking down a collection means publishing only the
 * operations that should be allowed; everything else is denied by default. A
 * malformed (version 2) AST is rejected and the original ruleset is restored.
 */
import { harness, check } from "./_harness.mjs";

const h = await harness("rules");
const rulesPath = `/projects/${h.projectId}/rulesets`;
const original = await h.api.console("GET", rulesPath);
let originalAst = original.body?.rulesAst ?? { version: 1, rules: [] };

try {
  h.log("=== Security Rules AST ===");
  const beforeVersion = original.body?.version ?? 0;
  h.log({
    before: {
      hasRuleset: beforeVersion > 0,
      ruleCount: Array.isArray(original.body?.rulesAst?.rules) ? original.body.rulesAst.rules.length : 0,
    },
  });

  const ast = {
    version: 1,
    rules: [
      {
        match: `${h.prefix}/{docId}`,
        allow: {
          read: true,
          create: { op: "==", left: { var: "request.data.team" }, right: { val: "red" } },
        },
      },
    ],
  };
  const published = await h.api.console("POST", rulesPath, { rulesAst: ast });
  check(published.status === 201, "valid AST publishes with HTTP 201");
  h.log({
    publish: "ok",
    versionAdvancedBy: published.body.version - beforeVersion,
    ruleCount: ast.rules.length,
  });

  const active = await h.api.console("GET", rulesPath);
  check(active.body.rulesAst.rules.length === 1, "published rule is active");
  check(active.body.version >= published.body.version, "active version did not regress");
  h.log({
    activeVersionMatchesPublished: active.body.version === published.body.version,
    astVersion: active.body.rulesAst.version,
    match: active.body.rulesAst.rules[0]?.match,
    operations: Object.keys(active.body.rulesAst.rules[0]?.allow ?? {}),
  });

  const invalid = await h.api.console("POST", rulesPath, { rulesAst: { version: 2, rules: [] } });
  check(invalid.status === 400 && invalid.body?.error?.code === "INVALID_ARGUMENT", "unsupported AST version rejected");
  h.log({ invalidAst: { status: invalid.status, code: invalid.body.error.code } });
} finally {
  try {
    await h.api.console("POST", rulesPath, { rulesAst: originalAst });
  } catch {
    // Best effort restoration.
  }
  await h.cleanup();
}
