#!/usr/bin/env node
/**
 * CANONICAL frontend build for the independent `vellum-console` Vercel project.
 *
 * Builds the three static apps sequentially and assembles a single deployable
 * `dist-frontend/` tree:
 *
 *   dist-frontend/            <- apps/dashboard/dist  (base "/")
 *   dist-frontend/admin/      <- apps/admin/dist      (base "/admin/")
 *   dist-frontend/docs/       <- apps/docs/dist       (static site)
 *
 * Apps are never merged: each keeps its own build and dist output. Builds run
 * one at a time (never in parallel) to stay within constrained memory budgets.
 * This script is strictly frontend-only — it never builds, imports, or touches
 * backend code (`apps/api/**`). Node builtins only; no third-party deps.
 */

import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { buildSite } from "./site/build-site.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const OUT_DIR = path.join(ROOT, "dist-frontend");

// Public site pages are real files. Console routes fall back to the dashboard
// shell (console-shell.html); anything else is a real 404.
const REDIRECTS = `/docs            /docs/                301
/admin           /admin/               301
/admin/assets/*  /admin/assets/:splat  200
/admin/*         /admin/index.html     200
/docs/assets/*   /docs/assets/:splat   200
/docs/*          /docs/index.html      200
/assets/*        /assets/:splat        200
/login           /console-shell.html   200
/signup          /console-shell.html   200
/mfa             /console-shell.html   200
/privacy         /console-shell.html   200
/terms           /console-shell.html   200
/app             /console-shell.html   200
/app/*           /console-shell.html   200
/*               /404.html             404
`;

const HEADERS = `/*
  X-Content-Type-Options: nosniff
  X-Frame-Options: DENY
  Referrer-Policy: strict-origin-when-cross-origin
  Content-Security-Policy: default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https:; font-src 'self' data:; connect-src 'self' https: wss:; frame-ancestors 'none'; object-src 'none'; base-uri 'self'; form-action 'self'

/assets/*
  Cache-Control: public, max-age=31536000, immutable
/admin/assets/*
  Cache-Control: public, max-age=31536000, immutable
/docs/assets/*
  Cache-Control: public, max-age=31536000, immutable
`;

const APPS = [
  { pkg: "@vellum/dashboard", src: "apps/dashboard/dist", dest: ".", label: "dashboard" },
  { pkg: "@vellum/admin", src: "apps/admin/dist", dest: "admin", label: "admin" },
  { pkg: "@vellum/docs", src: "apps/docs/dist", dest: "docs", label: "docs" },
];

function countFiles(dir) {
  let total = 0;
  if (!fs.existsSync(dir)) return total;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) total += countFiles(full);
    else if (entry.isFile()) total += 1;
  }
  return total;
}

function buildApp(app) {
  console.log(`[build:frontend] building ${app.pkg} ...`);
  const corepackCmd = process.platform === "win32" ? "corepack.cmd" : "corepack";
  const result = spawnSync(corepackCmd, ["pnpm", "--filter", app.pkg, "build"], {
    cwd: ROOT,
    stdio: "inherit",
    env: process.env,
    shell: process.platform === "win32",
  });
  if (result.error) {
    throw new Error(`Failed to launch build for ${app.pkg}: ${result.error.message}`);
  }
  if (result.status !== 0) {
    throw new Error(`Build failed for ${app.pkg} (exit code ${result.status}).`);
  }
}

function buildFrontendPackages() {
  // App `tsc` steps resolve sibling packages through their `dist` outputs. On a
  // clean checkout those do not exist yet, so build ONLY the frontend's shared
  // workspace dependencies (never the backend packages or the apps themselves).
  const corepackCmd = process.platform === "win32" ? "corepack.cmd" : "corepack";
  const args = [
    "pnpm", "-r",
    "--filter", "@vellum/dashboard^...",
    "--filter", "@vellum/admin^...",
    "--filter", "@vellum/docs^...",
    "build",
  ];
  console.log(`[build:frontend] $ ${corepackCmd} ${args.join(" ")}`);
  const result = spawnSync(corepackCmd, args, {
    cwd: ROOT,
    stdio: "inherit",
    env: process.env,
    shell: process.platform === "win32",
  });
  if (result.error || result.status !== 0) {
    throw new Error(`Failed to build frontend workspace dependencies (exit ${result.status ?? "launch"}).`);
  }
}

function main() {
  // Fresh output tree — no stale artifacts from previous builds.
  fs.rmSync(OUT_DIR, { recursive: true, force: true });
  fs.mkdirSync(OUT_DIR, { recursive: true });
  buildFrontendPackages();

  const summary = [];
  for (const app of APPS) {
    const src = path.join(ROOT, app.src);
    if (!fs.existsSync(path.join(src, "index.html")) || process.env.FORCE_BUILD === "1") {
      buildApp(app);
    } else {
      console.log(`[build:frontend] using existing build for ${app.pkg} ...`);
    }

    if (!fs.existsSync(path.join(src, "index.html"))) {
      throw new Error(`${app.pkg} build did not produce ${app.src}/index.html`);
    }
    const dest = app.dest === "." ? OUT_DIR : path.join(OUT_DIR, app.dest);
    fs.cpSync(src, dest, { recursive: true });
    summary.push(`${app.label.padEnd(9)} ${String(countFiles(dest)).padStart(4)} file(s)  ->  dist-frontend/${app.dest}`);
  }

  // Root-level llms.txt so agents that probe /llms.txt find the docs index.
  const llms = path.join(OUT_DIR, "docs", "llms.txt");
  if (fs.existsSync(llms)) fs.copyFileSync(llms, path.join(OUT_DIR, "llms.txt"));

  // Public marketing pages, sitemap, robots.txt, 404 and per-page docs shells.
  buildSite();

  fs.writeFileSync(path.join(OUT_DIR, "_redirects"), REDIRECTS);
  fs.writeFileSync(path.join(OUT_DIR, "_headers"), HEADERS);

  console.log("[build:frontend] done. Files copied per app:");
  for (const line of summary) console.log(`  ${line}`);
  console.log("  wrote _redirects and _headers");
}

try {
  main();
} catch (err) {
  console.error(`[build:frontend] ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}
