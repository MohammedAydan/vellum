#!/usr/bin/env node
/**
 * Convenience "both projects locally" launcher: starts the two INDEPENDENT
 * local servers side by side — the backend API (:8080) and the frontend
 * static gateway (:3000). They are separate deployables and each can be run
 * alone with `dev:backend` (API only) or `dev:console` (frontend only).
 *
 * Child output is line-prefixed with [api] / [web]. On SIGINT/SIGTERM both
 * children (and their process groups) are terminated so no servers are orphaned.
 * This script does not build anything; it assumes `dist`/`dist-frontend` exist.
 */

import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { waitForPort } from "./frontend-gateway.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

const children = [];
let shuttingDown = false;

function writeLine(label, line, isError) {
  const text = line.endsWith("\r") ? line.slice(0, -1) : line;
  (isError ? process.stderr : process.stdout).write(`[${label}] ${text}\n`);
}

function prefixStream(stream, label, isError) {
  let buffer = "";
  stream.setEncoding("utf8");
  stream.on("data", (chunk) => {
    buffer += chunk;
    let index;
    while ((index = buffer.indexOf("\n")) >= 0) {
      writeLine(label, buffer.slice(0, index), isError);
      buffer = buffer.slice(index + 1);
    }
  });
  stream.on("end", () => {
    if (buffer) writeLine(label, buffer, isError);
  });
}

function killAll() {
  for (const child of children) {
    if (!child.pid) continue;
    if (process.platform === "win32") {
      try {
        spawn("taskkill", ["/pid", String(child.pid), "/f", "/t"]);
      } catch {
        try { child.kill("SIGKILL"); } catch {}
      }
    } else {
      try {
        process.kill(-child.pid, "SIGTERM"); // detached group: kill descendants too
      } catch {
        try {
          child.kill("SIGTERM");
        } catch {
          /* already gone */
        }
      }
    }
  }
}

function shutdown(reason) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`\n[stack] ${reason} — stopping api and web ...`);
  killAll();
  const force = setTimeout(() => process.exit(0), 4000);
  force.unref();
}

function launch(cmd, args, label) {
  const child = spawn(cmd, args, {
    cwd: ROOT,
    stdio: ["ignore", "pipe", "pipe"],
    detached: process.platform !== "win32",
    env: { ...process.env },
  });
  prefixStream(child.stdout, label, false);
  prefixStream(child.stderr, label, true);
  child.on("error", (err) => {
    console.error(`[${label}] failed to start: ${err.message}`);
    if (!shuttingDown) shutdown("child start failure");
  });
  child.on("exit", (code, signal) => {
    if (!shuttingDown) {
      console.error(`[${label}] exited unexpectedly (code=${code}, signal=${signal}).`);
      shutdown("child exit");
      process.exitCode = 1;
    }
  });
  children.push(child);
  return child;
}

async function main() {
  const isDevMode = process.argv.includes("--mode=dev");
  const mode = isDevMode ? "--mode=dev" : "--mode=prod";

  launch(process.execPath, [path.join(ROOT, "apps", "api", "dist", "node-server.js")], "api");
  launch(process.execPath, [path.join(ROOT, "scripts", "dev", "frontend-gateway.mjs"), mode], "web");

  console.log("[stack] waiting for api (8080) and web (3000) to come up ...");
  await Promise.all([
    waitForPort("127.0.0.1", 8080, 60000, "api server"),
    waitForPort("127.0.0.1", 3000, 60000, "frontend gateway"),
  ]);

  if (!shuttingDown) {
    console.log("\n[stack] ready:");
    console.log("  Frontend gateway : http://localhost:3000");
    console.log("  API (REST + WS)  : http://localhost:8080\n");
  }
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

main().catch((err) => {
  console.error(`[stack] ${err instanceof Error ? err.message : String(err)}`);
  killAll();
  process.exit(1);
});
