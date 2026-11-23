/**
 * Runs every documented TypeScript example against the live API and captures
 * its real stdout. The generated files are consumed by scripts/build-docs.mjs,
 * which embeds them as STATIC text — the docs site never executes code.
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";

const root = resolve(dirname(new URL(import.meta.url).pathname), "..");
const manifestPath = resolve(root, "examples/ts/manifest.json");
const outDir = resolve(root, "docs/generated/examples");
const envPath = resolve(root, ".env.phase5.local");

function loadEnv() {
  const env = { ...process.env };
  try {
    for (const line of readFileSync(envPath, "utf8").split("\n")) {
      const match = /^\s*([A-Z0-9_]+)=(.*)$/.exec(line);
      if (match && !(match[1] in env)) env[match[1]] = match[2].replace(/^["']|["']$/g, "");
    }
  } catch {
    // Local env file is optional; the harness has safe defaults.
  }
  return env;
}

const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
const entries = Array.isArray(manifest) ? manifest : manifest.examples;
mkdirSync(outDir, { recursive: true });

const redact = (text) =>
  String(text)
    .replace(/pk_[A-Za-z0-9_-]+/g, "pk_<redacted>")
    .replace(/sk_[A-Za-z0-9_-]+/g, "sk_<redacted>")
    .replace(/Bearer\s+[A-Za-z0-9._-]+/gi, "Bearer <redacted>");

function runCommand(command, args, timeout = 180_000) {
  return spawnSync(command, args, { cwd: root, env: loadEnv(), encoding: "utf8", timeout });
}

const results = [];
let failed = 0;
for (const entry of entries) {
  const started = Date.now();
  const run = runCommand("corepack", ["pnpm", "exec", "tsx", `examples/ts/${entry.file}`]);
  const safeOutput = redact(`${run.stdout ?? ""}${run.stderr ?? ""}`);
  writeFileSync(resolve(outDir, `${entry.id}.txt`), safeOutput.trimEnd() + "\n");

  const restRel = entry.rest || `rest/${entry.id}.mjs`;
  const restPath = resolve(root, "examples", restRel);
  let restCode = null;
  let restLines = 0;
  let restError = null;
  if (existsSync(restPath)) {
    const restRun = runCommand("node", [restPath]);
    const restOut = redact(`${restRun.stdout ?? ""}${restRun.stderr ?? ""}`);
    writeFileSync(resolve(outDir, `${entry.id}.rest.txt`), restOut.trimEnd() + "\n");
    restCode = restRun.status;
    restLines = restOut.trim().split("\n").filter(Boolean).length;
    restError = restRun.status === 0 ? null : restOut.split("\n").slice(-12).join("\n");
  } else {
    restError = `missing REST example: ${restRel}`;
  }

  const ok = run.status === 0 && restCode === 0;
  if (!ok) failed++;
  results.push({
    id: entry.id,
    title: entry.title,
    file: entry.file,
    restFile: restRel,
    group: entry.group,
    description: entry.description,
    exitCode: run.status,
    restExitCode: restCode,
    outputLines: safeOutput.trim().split("\n").filter(Boolean).length,
    restOutputLines: restLines,
    durationMs: Date.now() - started,
  });
  console.log(
    `${ok ? "PASS" : "FAIL"} ${entry.id.padEnd(18)} ts=${run.status} rest=${restCode} lines=${results.at(-1).outputLines}/${restLines} ${Date.now() - started}ms`
  );
  if (run.status !== 0) console.log(safeOutput.split("\n").slice(-20).join("\n"));
  if (restError) console.log(`  REST: ${restError}`);
}

writeFileSync(
  resolve(outDir, "index.json"),
  JSON.stringify({ generatedBy: "scripts/run-examples.mjs", results }, null, 2) + "\n"
);
console.log(`\nVerified ${results.length - failed}/${results.length} examples. Outputs: docs/generated/examples/`);
process.exit(failed === 0 ? 0 : 1);
