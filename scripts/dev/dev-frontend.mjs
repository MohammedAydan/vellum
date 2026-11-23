#!/usr/bin/env node
/**
 * Start ONLY the frontend project locally: the static gateway serving
 * `dist-frontend/` on port 3000. This is the local counterpart of the
 * independent `vellum-console` Vercel project — no API server is started.
 *
 * `frontend-gateway.mjs --mode=prod` serves the built static files directly
 * (dashboard at /, admin at /admin/, docs at /docs/) and does NOT spawn any
 * Vite dev servers. A local `/v1` proxy is available for convenience, but the
 * deployed frontend never proxies `/v1` — see apps/dashboard/AGENTS.md.
 *
 * Build first with `corepack pnpm build:console` (or `build:frontend`).
 */

import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const PORT = process.env.PORT || "3000";

const gateway = spawn(
  process.execPath,
  [path.join(ROOT, "scripts", "dev", "frontend-gateway.mjs"), "--mode=prod"],
  {
    cwd: ROOT,
    stdio: "inherit",
    detached: process.platform !== "win32",
    env: { ...process.env },
  }
);

let shuttingDown = false;
function stop(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`\n[dev:console] ${signal} received — stopping frontend gateway ...`);
  if (gateway.pid) {
    try {
      if (process.platform === "win32") {
        spawn("taskkill", ["/pid", String(gateway.pid), "/f", "/t"]);
      } else {
        process.kill(-gateway.pid, signal); // detached process group: no orphans
      }
    } catch {
      try {
        gateway.kill(signal);
      } catch {
        /* already gone */
      }
    }
  }
}

gateway.on("error", (err) => {
  console.error(`[dev:console] failed to start gateway: ${err.message}`);
  process.exitCode = 1;
});
gateway.on("exit", (code, signal) => {
  if (!shuttingDown) {
    process.exitCode = code ?? (signal ? 1 : 0);
  }
});

process.on("SIGINT", () => stop("SIGTERM"));
process.on("SIGTERM", () => stop("SIGTERM"));

console.log(`[dev:console] frontend gateway starting at http://localhost:${PORT}`);
console.log("[dev:console] dashboard: /  admin: /admin/  docs: /docs/");
