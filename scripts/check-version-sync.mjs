#!/usr/bin/env node
/**
 * Verifies every version field in the repo matches the root package.json
 * version, so the project and all SDKs stay on one version.
 *
 * Usage: node scripts/check-version-sync.mjs
 * Exit 0 = all in sync. Exit 1 = mismatches (printed to stderr).
 */
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const rootVersion = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version;
const failures = [];

function expect(label, actual) {
  if (actual !== rootVersion) {
    failures.push(`${label}: ${JSON.stringify(actual)} (expected ${rootVersion})`);
  }
}

function readJsonVersion(file) {
  try {
    return JSON.parse(readFileSync(file, "utf8")).version;
  } catch {
    return "<unreadable>";
  }
}

// 1. Every package.json under the managed workspace roots.
const pkgFiles = ["package.json"];
for (const dir of ["apps", "packages", "examples", "sdks"]) {
  const base = join(root, dir);
  if (!existsSync(base)) continue;
  for (const entry of readdirSync(base, { withFileTypes: true })) {
    const candidate = join(base, entry.name, "package.json");
    if (entry.isDirectory() && existsSync(candidate)) pkgFiles.push(join(dir, entry.name, "package.json"));
  }
}
for (const rel of pkgFiles) expect(`${rel} version`, readJsonVersion(join(root, rel)));

// 2. Every pubspec.yaml and the pubspec.lock entries of our path packages.
function pubspecVersion(file) {
  const m = readFileSync(file, "utf8").match(/^version:\s*(\S+)\s*$/m);
  return m ? m[1] : "<missing>";
}
const pubspecs = [
  "sdks/flutter/pubspec.yaml",
  "sdks/flutter_secure_storage/pubspec.yaml",
  "examples/flutter_compat_app/pubspec.yaml",
  "apps/vellum-e2e-app/pubspec.yaml",
  "examples/flutter_testbed_app/pubspec.yaml",
  "tests/dart-verify/pubspec.yaml",
];
for (const rel of pubspecs) {
  if (existsSync(join(root, rel))) expect(`${rel} version`, pubspecVersion(join(root, rel)));
}
const lockFiles = [
  "tests/dart-verify/pubspec.lock",
  "examples/flutter_testbed_app/pubspec.lock",
  "apps/vellum-e2e-app/pubspec.lock",
];
for (const rel of lockFiles) {
  if (!existsSync(join(root, rel))) continue;
  const text = readFileSync(join(root, rel), "utf8");
  for (const pkg of ["vellum_flutter", "flutter_testbed_app"]) {
    const m = text.match(new RegExp(`^  ${pkg}:\\n(?:    .+\\n)*?    version: "([^"]+)"`, "m"));
    if (m) expect(`${rel} -> ${pkg}`, m[1]);
  }
}

// 3. API runtime + contract versions.
function literalVersion(file, pattern, label) {
  const text = readFileSync(join(root, file), "utf8");
  const m = text.match(pattern);
  if (!m) return expect(label, "<missing>");
  expect(label, m[1]);
}
literalVersion("apps/api/src/routes/health.ts", /SERVICE_VERSION = "([^"]+)"/, "health.ts SERVICE_VERSION");
literalVersion("apps/api/src/routes/admin.ts", /version: "([^"]+)"/, "admin.ts overview version");
literalVersion("packages/api-contract/src/openapi.ts", /info:[\s\S]*?version: "([^"]+)"/, "openapi.ts info.version");
literalVersion("docs/api/openapi.generated.json", /"info":\s*\{[\s\S]*?"version": "([^"]+)"/, "openapi.generated.json info.version");

if (failures.length) {
  console.error(`Version mismatch against root package.json (${rootVersion}):`);
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
console.log(`All version fields are in sync at ${rootVersion} (${pkgFiles.length} package.json, ${pubspecs.length} pubspec.yaml, locks, API + OpenAPI contract).`);
