#!/usr/bin/env node
/**
 * Guardrail for the two-independent-project split.
 *
 * One GitHub repo (`MohammedAydan/vellum`) deploys TWO Vercel projects:
 *
 *   - backend  -> `vellum-api`       (rootDirectory: apps/api, functions only)
 *   - frontend -> `vellum-console`   (rootDirectory: repo root, static dist-frontend)
 *
 * This script FAILS (exit 1) if the two deployables become entangled: if the
 * Vercel entry point moves back to the repo root, if the frontend proxies `/v1`
 * in production, if a build helper disappears, or if source imports cross the
 * backend/frontend boundary. Node builtins only (fs, path) — no install needed.
 *
 * Usage: node scripts/verify-split.mjs
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const results = [];
let failed = 0;

function check(name, fn) {
  let ok = false;
  let detail = "";
  try {
    const outcome = fn();
    if (typeof outcome === "boolean") {
      ok = outcome;
    } else {
      ok = Boolean(outcome.ok);
      detail = outcome.detail || "";
    }
  } catch (err) {
    detail = err instanceof Error ? err.message : String(err);
  }
  if (!ok) failed += 1;
  results.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  ->  ${detail}` : ""}`);
}

const exists = (p) => fs.existsSync(p);
const isFile = (p) => exists(p) && fs.statSync(p).isFile();
const read = (p) => fs.readFileSync(p, "utf8");

function readJson(p) {
  try {
    return JSON.parse(read(p));
  } catch {
    return null;
  }
}

/** Recursively walk a directory and return source file paths. */
function walkSource(dir) {
  const out = [];
  if (!exists(dir)) return out;
  const exts = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"]);
  const stack = [dir];
  while (stack.length) {
    const current = stack.pop();
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== "node_modules" && entry.name !== "dist") stack.push(full);
      } else if (entry.isFile() && exts.has(path.extname(entry.name))) {
        out.push(full);
      }
    }
  }
  return out;
}

// Extract module specifiers from import/export/require/dynamic-import statements.
const SPECIFIER_RE =
  /(?:from\s*|import\s*\(\s*|require\s*\(\s*|import\s+|export\s*\*\s*from\s*)["']([^"']+)["']/g;

function specifiers(text) {
  const found = new Set();
  for (const match of text.matchAll(SPECIFIER_RE)) found.add(match[1]);
  return [...found];
}

function normalize(p) {
  return path.normalize(p).split(path.sep).join("/");
}

/**
 * Given a specifier and the importing file's directory, return the strings we
 * can meaningfully test against a forbidden target: the raw specifier and the
 * normalized absolute path for relative imports.
 */
function specifierVariants(spec, fileDir) {
  const variants = [spec];
  if (spec.startsWith(".")) {
    variants.push(normalize(path.resolve(fileDir, spec)));
  }
  return variants;
}

/** Does the specifier resolve to a forbidden physical dir or package alias? */
function isForbidden(spec, fileDir, physicalDirs, packageNames) {
  const variants = specifierVariants(spec, fileDir);
  for (const dir of physicalDirs) {
    const abs = normalize(path.join(ROOT, dir));
    for (const v of variants) {
      if (v === dir || v.startsWith(`${dir}/`) || v.includes(`/${dir}/`)) return true;
      if (v.startsWith(`${abs}/`) || v === abs) return true;
    }
  }
  for (const pkg of packageNames) {
    if (spec === pkg || spec.startsWith(`${pkg}/`)) return true;
  }
  return false;
}

/** Scan source files under `dir` for forbidden import specifiers. */
function scanImports(dir, forbidden) {
  const offenders = [];
  for (const file of walkSource(dir)) {
    const text = read(file);
    const fileDir = path.dirname(file);
    const rel = normalize(path.relative(ROOT, file));
    for (const spec of specifiers(text)) {
      const hit = isForbidden(
        spec,
        fileDir,
        forbidden.physicalDirs || [],
        forbidden.packages || []
      );
      if (hit) offenders.push(`${rel}: ${spec}`);
    }
  }
  return offenders;
}

// --- Check 1: backend Vercel entry point ---------------------------------
check("apps/api/api/server/[...path].ts exists and re-exports the Vercel runtime", () => {
  const entry = path.join(ROOT, "apps/api/api/server/[...path].ts");
  if (!isFile(entry)) return { ok: false, detail: "missing entry file" };
  const text = read(entry);
  const hasExport = /\bexport\b/.test(text);
  const hasDefault = /\bdefault\b/.test(text);
  const hasVercel = /vercel/i.test(text);
  return {
    ok: hasExport && hasDefault && hasVercel,
    detail: hasExport && hasDefault && hasVercel ? "" : "expected `export { default } ... vercel`",
  };
});

check("legacy root api/ function directory is absent (frontend stays static-only)", () => {
  const legacy = path.join(ROOT, "api");
  return {
    ok: !exists(legacy),
    detail: exists(legacy)
      ? "root api/ would be discovered as a Vercel Function by vellum-console; delete it"
      : "no root api/ directory",
  };
});

// --- Check 2: rewrite ownership ------------------------------------------
check("apps/api/vercel.json has a /v1 rewrite", () => {
  const cfg = readJson(path.join(ROOT, "apps/api/vercel.json"));
  if (!cfg) return { ok: false, detail: "missing or invalid apps/api/vercel.json" };
  const rewrites = Array.isArray(cfg.rewrites) ? cfg.rewrites : [];
  const hasV1 = rewrites.some((r) => typeof r?.source === "string" && r.source.includes("/v1"));
  return { ok: hasV1, detail: hasV1 ? "" : "no rewrite source containing /v1" };
});

check("root vercel.json does NOT proxy /v1/(.*) to the API", () => {
  const cfgPath = path.join(ROOT, "vercel.json");
  if (!isFile(cfgPath)) return { ok: true, detail: "no root vercel.json (nothing to proxy)" };
  const cfg = readJson(cfgPath);
  if (!cfg) return { ok: false, detail: "invalid root vercel.json" };
  const rewrites = Array.isArray(cfg.rewrites) ? cfg.rewrites : [];
  const proxy = rewrites.find(
    (r) => typeof r?.source === "string" && /\/v1\/\(\.\*\)/.test(r.source)
  );
  return {
    ok: !proxy,
    detail: proxy ? `production proxy still present: ${proxy.source}` : "",
  };
});

check("root vercel.json provides SPA deep-link fallbacks for dashboard, admin and docs", () => {
  const cfg = readJson(path.join(ROOT, "vercel.json"));
  if (!cfg) return { ok: false, detail: "invalid root vercel.json" };
  const rewrites = Array.isArray(cfg.rewrites) ? cfg.rewrites : [];
  const hasFallback = (destination) =>
    rewrites.some(
      (r) =>
        r?.destination === destination &&
        typeof r?.source === "string" &&
        r.source.includes(":path")
    );
  // cleanUrls strips .html from the served filesystem, so a rewrite whose
  // destination ends in .html fails Vercel's `check: true` filesystem probe
  // and the route 404s. Fallbacks must target the extensionless shell URL.
  const missing = ["/console-shell", "/admin", "/docs"]
    .filter((dest) => !hasFallback(dest))
    .map((dest) => dest);
  const htmlDestinations = rewrites
    .filter((r) => typeof r?.destination === "string" && r.destination.endsWith(".html"))
    .map((r) => r.destination);
  // Vercel's path-to-regexp parser only accepts negative lookahead inside a
  // NAMED parameter (e.g. /:path((?!assets/).*)), never as a bare group.
  const bareLookahead = rewrites
    .filter((r) => typeof r?.source === "string" && r.source.includes("(?!") && !r.source.includes(":path"))
    .map((r) => r.source);
  const ok = missing.length === 0 && htmlDestinations.length === 0 && bareLookahead.length === 0;
  return {
    ok,
    detail: ok
      ? ""
      : `missing=${missing.join(",")} htmlDest=${htmlDestinations.join(",")} bareLookahead=${bareLookahead.join(",")}`,
  };
});

// --- Check 3: build helpers ----------------------------------------------
check("scripts/build-backend.mjs exists", () => {
  return { ok: isFile(path.join(ROOT, "scripts/build-backend.mjs")), detail: isFile(path.join(ROOT, "scripts/build-backend.mjs")) ? "" : "missing file" };
});
check("scripts/build-frontend.mjs exists", () => {
  return { ok: isFile(path.join(ROOT, "scripts/build-frontend.mjs")), detail: isFile(path.join(ROOT, "scripts/build-frontend.mjs")) ? "" : "missing file" };
});

// --- Check 4: backend source must not import frontend/UI -----------------
check("apps/api/src does not import dashboard/admin/docs/packages-ui", () => {
  const offenders = scanImports(path.join(ROOT, "apps/api/src"), {
    physicalDirs: ["apps/dashboard", "apps/admin", "apps/docs", "packages/ui"],
    packages: ["@vellum/ui"],
  });
  return {
    ok: offenders.length === 0,
    detail: offenders.length ? offenders.slice(0, 5).join("; ") : "",
  };
});

// --- Check 5: frontend source must not import backend internals ----------
check(
  "frontend src does not import api/database-control/database-data/storage/document-engine",
  () => {
    const offenders = [];
    for (const app of ["dashboard", "admin", "docs"]) {
      offenders.push(
        ...scanImports(path.join(ROOT, `apps/${app}/src`), {
          physicalDirs: [
            "apps/api",
            "packages/database-control",
            "packages/database-data",
            "packages/storage",
            "packages/document-engine",
          ],
          packages: [
            "@vellum/api",
            "@vellum/database-control",
            "@vellum/database-data",
            "@vellum/storage",
            "@vellum/document-engine",
          ],
        })
      );
    }
    return {
      ok: offenders.length === 0,
      detail: offenders.length ? offenders.slice(0, 5).join("; ") : "",
    };
  }
);

// --- Check 6: no direct DB drivers in frontend source --------------------
check("frontend src has no direct pg/postgres/drizzle-orm/neon imports", () => {
  const drivers = ["pg", "postgres", "drizzle-orm", "@neondatabase/serverless", "neon"];
  const offenders = [];
  for (const app of ["dashboard", "admin", "docs"]) {
    for (const file of walkSource(path.join(ROOT, `apps/${app}/src`))) {
      const rel = normalize(path.relative(ROOT, file));
      for (const spec of specifiers(read(file))) {
        if (drivers.some((d) => spec === d || spec.startsWith(`${d}/`))) {
          offenders.push(`${rel}: ${spec}`);
        }
      }
    }
  }
  return {
    ok: offenders.length === 0,
    detail: offenders.length ? offenders.slice(0, 5).join("; ") : "",
  };
});

// --- Summary -------------------------------------------------------------
const total = results.length;
const passed = total - failed;
console.log("");
console.log(`Split verification: ${passed}/${total} checks passed.`);
if (failed > 0) {
  console.error(`SPLIT VERIFICATION FAILED (${failed} check(s) failed).`);
  process.exit(1);
}
console.log("SPLIT VERIFICATION PASSED — backend and frontend are independent.");
