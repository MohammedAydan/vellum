#!/usr/bin/env node
/**
 * Local development runner for the BACKEND ONLY.
 *
 * Spawns the standalone Node server (`apps/api/dist/node-server.js`) from the
 * repo root, so the backend can run and be verified entirely on its own — it
 * does NOT depend on the dashboard, admin, docs, or any frontend gateway.
 */

import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

// Forward the full environment; default only the storage mode when unset.
const env = { ...process.env };
if (env.DATABASE_MODE === undefined || env.DATABASE_MODE === "") {
  env.DATABASE_MODE = "memory";
}

const child = spawn(process.execPath, ["apps/api/dist/node-server.js"], {
  cwd: ROOT,
  env,
  stdio: "inherit",
});

const forwardSignal = (signal) => {
  if (child.exitCode === null && !child.killed) child.kill(signal);
};
process.on("SIGINT", () => forwardSignal("SIGINT"));
process.on("SIGTERM", () => forwardSignal("SIGTERM"));

child.on("error", (err) => {
  console.error(`[dev:backend] failed to start: ${err.message}`);
  process.exit(1);
});
child.on("exit", (code) => {
  // Exit when the child exits so signals and early failures propagate cleanly.
  process.exit(code ?? 0);
});

console.log("[dev:backend] listening at http://localhost:8080");
