import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "../..");

function walkFiles(dir: string, exts: readonly string[], excludeDirs: ReadonlySet<string>): string[] {
  const results: string[] = [];
  if (!fs.existsSync(dir)) return results;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (excludeDirs.has(entry.name)) continue;
      results.push(...walkFiles(full, exts, excludeDirs));
    } else if (exts.some((ext) => entry.name.endsWith(ext))) {
      results.push(full);
    }
  }
  return results;
}

const EXCLUDE_DIRS = new Set(["node_modules", "dist", "coverage", "__tests__", "migrations", "generated", ".next", "public"]);

describe("Architecture & Contract Boundaries (v5)", () => {
  it("has zero explicit `any` in production TypeScript files", () => {
    const files = [
      ...walkFiles(path.join(ROOT, "packages"), [".ts", ".tsx"], EXCLUDE_DIRS),
      ...walkFiles(path.join(ROOT, "apps/api/src"), [".ts", ".tsx"], EXCLUDE_DIRS),
      ...walkFiles(path.join(ROOT, "apps/dashboard/src"), [".ts", ".tsx"], EXCLUDE_DIRS),
      ...walkFiles(path.join(ROOT, "apps/admin/src"), [".ts", ".tsx"], EXCLUDE_DIRS),
    ].filter((f) => !f.endsWith(".test.ts") && !f.endsWith(".test.tsx") && !f.endsWith(".spec.ts") && !f.endsWith(".stories.tsx"));

    const violations: string[] = [];
    for (const file of files) {
      const lines = fs.readFileSync(file, "utf8").split(/\r?\n/);
      lines.forEach((line, idx) => {
        const trimmed = line.trim();
        if (trimmed.startsWith("//") || trimmed.startsWith("*") || trimmed.startsWith("/*")) return;
        if (/(?::\s*any\b|\bas\s+any\b|<any>)/.test(line)) {
          violations.push(`${path.relative(ROOT, file)}:${idx + 1}: ${trimmed}`);
        }
      });
    }
    expect(violations).toEqual([]);
  });

  it("has zero TS/ESLint/Dart compiler suppressions in production code", () => {
    const tsFiles = [
      ...walkFiles(path.join(ROOT, "packages"), [".ts", ".tsx"], EXCLUDE_DIRS),
      ...walkFiles(path.join(ROOT, "apps"), [".ts", ".tsx"], EXCLUDE_DIRS),
    ].filter((f) => !f.endsWith(".test.ts") && !f.endsWith(".test.tsx") && !f.endsWith(".spec.ts"));

    const dartFiles = walkFiles(path.join(ROOT, "sdks/flutter/lib"), [".dart"], new Set(["build", ".dart_tool"]));
    const violations: string[] = [];

    for (const file of tsFiles) {
      const text = fs.readFileSync(file, "utf8");
      if (/@ts-(?:ignore|expect-error|nocheck)|eslint-disable/.test(text)) {
        violations.push(path.relative(ROOT, file));
      }
    }
    for (const file of dartFiles) {
      const text = fs.readFileSync(file, "utf8");
      if (/\/\/\s*ignore(?:_for_file)?:/.test(text)) {
        violations.push(path.relative(ROOT, file));
      }
    }
    expect(violations).toEqual([]);
  });

  it("has zero cross-package dist/ imports", () => {
    const files = [
      ...walkFiles(path.join(ROOT, "packages"), [".ts", ".tsx"], EXCLUDE_DIRS),
      ...walkFiles(path.join(ROOT, "apps"), [".ts", ".tsx"], EXCLUDE_DIRS),
    ];
    const violations: string[] = [];
    for (const file of files) {
      const text = fs.readFileSync(file, "utf8");
      if (/@vellum\/[a-z-]+\/dist(?:\/|["\x27])/.test(text)) {
        violations.push(path.relative(ROOT, file));
      }
    }
    expect(violations).toEqual([]);
  });

  it("isolates concrete adapter imports to apps/api/src/composition/root.ts", () => {
    const apiFiles = walkFiles(path.join(ROOT, "apps/api/src"), [".ts"], EXCLUDE_DIRS).filter(
      (f) => !f.endsWith(".test.ts") && path.relative(ROOT, f) !== "apps/api/src/composition/root.ts"
    );
    const concretePattern = /\b(?:PgControlPlaneStore|ControlPlaneStore|PgStorageAdapter|NeonStorageAdapter|DataPlaneStore|createRawPgClient|createCacheInvalidationBus|createPgRealtimeInfrastructure)\b/;
    const violations: string[] = [];
    for (const file of apiFiles) {
      const lines = fs.readFileSync(file, "utf8").split(/\r?\n/);
      lines.forEach((line, idx) => {
        if (/^\s*import\s+(?!type\b)/.test(line) && concretePattern.test(line)) {
          violations.push(`${path.relative(ROOT, file)}:${idx + 1}: ${line.trim()}`);
        }
      });
    }
    expect(violations).toEqual([]);
  });

  it("has zero raw fetch() calls outside designated HTTP adapters", () => {
    const allowed = new Set([
      "apps/dashboard/src/lib/api.ts",
      "apps/admin/src/lib/api.ts",
      "packages/sdk-js/src/core/http-transport.ts",
      "packages/sdk-js/src/realtime/sse-socket.ts",
    ]);
    const files = [
      ...walkFiles(path.join(ROOT, "apps/dashboard/src"), [".ts", ".tsx"], EXCLUDE_DIRS),
      ...walkFiles(path.join(ROOT, "apps/admin/src"), [".ts", ".tsx"], EXCLUDE_DIRS),
      ...walkFiles(path.join(ROOT, "packages/sdk-js/src"), [".ts", ".tsx"], EXCLUDE_DIRS),
    ].filter((f) => !f.endsWith(".test.ts") && !f.endsWith(".test.tsx"));

    const violations: string[] = [];
    for (const file of files) {
      const rel = path.relative(ROOT, file);
      if (allowed.has(rel)) continue;
      const text = fs.readFileSync(file, "utf8");
      if (/\bfetch\s*\(/.test(text)) {
        violations.push(rel);
      }
    }
    expect(violations).toEqual([]);
  });

  it("enforces zero `dynamic` and zero `dart:io` in sdks/flutter/lib/**", () => {
    const dartFiles = walkFiles(path.join(ROOT, "sdks/flutter/lib"), [".dart"], new Set(["build", ".dart_tool"]));
    const violations: string[] = [];
    // The only file allowed to use dart:io: the desktop loopback redirect listener. It is reached through a
    // conditional import (`if (dart.library.io)`), so the web build never sees it.
    const ioAllowed = path.join(ROOT, "sdks/flutter/lib/src/oauth_launcher/loopback_io.dart");
    for (const file of dartFiles) {
      const lines = fs.readFileSync(file, "utf8").split(/\r?\n/);
      lines.forEach((line, idx) => {
        const trimmed = line.trim();
        if (trimmed.startsWith("//")) return;
        const ioImport = /import\s+['"]dart:io['"]/.test(line) && file !== ioAllowed;
        if (/\bdynamic\b/.test(line) || ioImport) {
          violations.push(`${path.relative(ROOT, file)}:${idx + 1}: ${trimmed}`);
        }
      });
    }
    expect(violations).toEqual([]);
  });

  it("maintains an acyclic @vellum/* workspace dependency graph and removes unused admin control-db dep", () => {
    const pkgJsons = [
      ...fs.readdirSync(path.join(ROOT, "packages")).map((d) => path.join(ROOT, "packages", d, "package.json")),
      ...fs.readdirSync(path.join(ROOT, "apps")).map((d) => path.join(ROOT, "apps", d, "package.json")),
    ].filter((p) => fs.existsSync(p));

    const graph = new Map<string, string[]>();
    for (const p of pkgJsons) {
      const pkg = JSON.parse(fs.readFileSync(p, "utf8")) as { name: string; dependencies?: Record<string, string> };
      const deps = Object.keys(pkg.dependencies ?? {}).filter((d) => d.startsWith("@vellum/"));
      graph.set(pkg.name, deps);
      if (pkg.name === "@vellum/admin") {
        expect(deps).not.toContain("@vellum/database-control");
      }
    }

    expect(graph.size).toBeGreaterThanOrEqual(19);
    const visiting = new Set<string>();
    const visited = new Set<string>();
    const dfs = (node: string): void => {
      if (visited.has(node)) return;
      if (visiting.has(node)) throw new Error(`Dependency cycle detected at ${node}`);
      visiting.add(node);
      for (const dep of graph.get(node) ?? []) dfs(dep);
      visiting.delete(node);
      visited.add(node);
    };
    for (const node of graph.keys()) dfs(node);
  });

  it("keeps canonical ERROR_HTTP_STATUS codes synchronized with Dart generated codes", () => {
    const coreErrors = fs.readFileSync(path.join(ROOT, "packages/core/src/errors.ts"), "utf8");
    const dartErrors = fs.readFileSync(path.join(ROOT, "sdks/flutter/lib/generated/error_codes.g.dart"), "utf8");
    const block = coreErrors.match(/ERROR_HTTP_STATUS\s*=[\s\S]*?\}\s*as\s+const/)?.[0] ?? "";
    const coreCodes = [...block.matchAll(/\b([A-Z][A-Z0-9_]+)\s*:\s*(\d{3})/g)].map((m) => m[1]);
    expect(coreCodes.length).toBeGreaterThanOrEqual(34);
    for (const code of coreCodes) {
      expect(dartErrors).toContain(`'${code}'`);
    }
  });
});
