#!/usr/bin/env node
/**
 * Backend project build command for Vercel (`vellum-api`, rootDirectory =
 * `apps/api`). Vercel runs this with cwd = `apps/api`; this script resolves the
 * repo root from `__dirname` (the equivalent of `cd ../..`) so it can drive the
 * workspace build from the monorepo root.
 *
 * Builds ONLY `@vellum/api` and its transitive workspace dependencies — never
 * the dashboard, admin, or docs apps.
 */

import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

const corepackCmd = process.platform === "win32" ? "corepack.cmd" : "corepack";
const args = ["pnpm", "-r", "--filter", "@vellum/api...", "build"];

console.log("[build:backend] building @vellum/api and its workspace dependencies ...");
console.log(`[build:backend] cwd: ${ROOT}`);
console.log(`[build:backend] $ ${corepackCmd} ${args.join(" ")}`);

try {
  execFileSync(corepackCmd, args, {
    cwd: ROOT,
    stdio: "inherit",
    shell: process.platform === "win32",
    env: { ...process.env, COREPACK_ENABLE_AUTO_PIN: "0" },
  });
  console.log("[build:backend] done.");
} catch (err) {
  const status = typeof err?.status === "number" ? err.status : 1;
  console.error(`[build:backend] build failed (exit code ${status}).`);
  process.exit(status);
}
