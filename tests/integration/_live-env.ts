/**
 * Repo-root-relative live env bootstrap for PHASE 5 integration tests.
 *
 * The recursive runner executes each package script from that package's
 * directory (`apps/api` for `apps/api test:integration`), so CWD-relative
 * `.env*.local` lookups silently miss the repository-root files. Resolve them
 * from this module's own path instead — no secrets are ever logged.
 *
 * Import this module (as a side-effect import) BEFORE any module that reads
 * configuration at import time, e.g. `apps/api/src/config.ts` via node-server.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseEnvFile } from "../../packages/database-control/src/env-file.js";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

/** Absolute, repo-root-anchored path for a live env file. */
export function liveEnvPath(file: string): string {
  return path.join(REPO_ROOT, file);
}

/**
 * Load repo-root `.env` then let `.env.phase5.local` override it, but only for
 * an explicitly requested live run. Idempotent; values are never printed.
 */
export function ensureLiveEnv(): void {
  if (process.env.PHASE5_REAL !== "1") return;

  for (const file of [".env", ".env.phase5.local"]) {
    const full = liveEnvPath(file);
    if (!fs.existsSync(full)) continue;
    const values = parseEnvFile(fs.readFileSync(full, "utf8"));
    for (const [key, value] of Object.entries(values)) {
      // The phase-specific file carries the live Neon URLs and must win over
      // the generic .env (which may point at local/stale databases).
      if (file === ".env.phase5.local" || process.env[key] === undefined) {
        process.env[key] = value;
      }
    }
  }
}

ensureLiveEnv();
