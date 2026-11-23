#!/usr/bin/env node
/**
 * Vellum two-project deployment helper.
 *
 * This script DOES NOT DEPLOY anything by default. It prints the exact plan for
 * the two independent Vercel projects, audits which required environment
 * variables are set (names only — never values), and prints the post-deploy
 * verification commands. Deployment is performed by a human with the Vercel
 * CLI/dashboard; this is a runbook/checklist helper, not a credential handler.
 *
 * Usage:
 *   node scripts/deploy-vercel.mjs            # print plan + env audit + verification
 *   node scripts/deploy-vercel.mjs --check    # env audit only; non-zero if missing
 *
 * SAFETY: no environment variable VALUE is ever printed or persisted.
 */

const TEAM = "MAG-1";
const REPO = "MohammedAydan/vellum";
const API_DOMAIN = "api.example.com";
const CONSOLE_DOMAIN = "console.example.com";

// ---------------------------------------------------------------------------
// Deployment plan
// ---------------------------------------------------------------------------

const PROJECTS = [
  {
    label: "BACKEND",
    name: "vellum-api",
    rootDirectory: "apps/api",
    framework: "Other",
    buildCommand: "corepack pnpm build:api",
    outputDirectory: "dist (informational; serverless functions)",
    functions: "apps/api/api/server/[...path].ts",
    nodeVersion: "22.x",
    env: [
      "DATABASE_MODE=memory|postgres",
      "CONTROL_DATABASE_URL, DATA_DATABASE_URL (postgres only)",
      "CORS_ALLOWED_ORIGINS=https://console.example.com (exact origin)",
      "JWT_SECRET, CONSOLE_JWT_SECRET, SUPER_ADMIN_JWT_SECRET",
      "BETTER_AUTH_SECRET, SESSION_COOKIE_SECRET, API_KEY_PEPPER",
      "CURSOR_HMAC_SECRET, MASTER_ENCRYPTION_KEY",
      "NODE_ENV=production",
    ],
  },
  {
    label: "FRONTEND",
    name: "vellum-console",
    rootDirectory: "(repository root)",
    framework: "Vite / static",
    buildCommand: "corepack pnpm build:console",
    outputDirectory: "dist-frontend",
    functions: "none (static only — no /api/server functions)",
    nodeVersion: "22.x",
    env: [
      "VITE_API_BASE_URL=https://api.example.com (build-time API origin)",
      "window.__VELLUM_API_BASE_URL__ (optional runtime override)",
      "NO DATABASE URLs, NO server-side secrets",
    ],
  },
];

function printPlan() {
  console.log("Automatic Vercel Git deployments are PAUSED for both projects, including main.");
  console.log("This prints a plan only. It neither deploys nor re-enables automation.");
  console.log("=== Vellum two-project deployment plan ===");
  console.log(`Repo: ${REPO}   Team: ${TEAM}`);
  console.log("One repo, two independent Vercel projects (separate failure domains).\n");

  for (const p of PROJECTS) {
    console.log(`--- ${p.label}: ${p.name} ---`);
    console.log(`  repo              : ${REPO}`);
    console.log(`  team              : ${TEAM}`);
    console.log(`  rootDirectory     : ${p.rootDirectory}`);
    console.log(`  framework         : ${p.framework}`);
    console.log(`  nodeVersion       : ${p.nodeVersion}`);
    console.log(`  buildCommand      : ${p.buildCommand}`);
    console.log(`  outputDirectory   : ${p.outputDirectory}`);
    console.log(`  function entry    : ${p.functions}`);
    console.log("  env vars (names only):");
    for (const line of p.env) console.log(`    - ${line}`);
    console.log("");
  }

  console.log("Deploy order: frontend first -> capture its URL -> set backend CORS_ALLOWED_ORIGINS -> redeploy backend.");
  console.log("See docs/DEPLOYMENT-SPLIT.md for the full runbook.\n");
}

// ---------------------------------------------------------------------------
// Environment audit (names only)
// ---------------------------------------------------------------------------

const REQUIRED_ALWAYS = ["DATABASE_MODE", "JWT_SECRET", "CORS_ALLOWED_ORIGINS"];
const PRODUCTION_SECRETS = [
  "CONSOLE_JWT_SECRET",
  "SUPER_ADMIN_JWT_SECRET",
  "BETTER_AUTH_SECRET",
  "SESSION_COOKIE_SECRET",
  "API_KEY_PEPPER",
  "CURSOR_HMAC_SECRET",
  "MASTER_ENCRYPTION_KEY",
];
const POSTGRES_ONLY = ["CONTROL_DATABASE_URL", "DATA_DATABASE_URL"];

function auditEnv() {
  const modeRaw = process.env.DATABASE_MODE;
  const mode = (modeRaw || "memory").toLowerCase();
  const isPostgres = mode === "postgres";
  const required = [...REQUIRED_ALWAYS];
  if (isPostgres) required.push(...POSTGRES_ONLY, ...PRODUCTION_SECRETS);

  const missing = [];
  console.log("=== Backend environment audit (values are never printed) ===");
  console.log(`DATABASE_MODE selected: ${!modeRaw ? "unset (code defaults to memory)" : isPostgres ? "postgres (production)" : mode}`);
  for (const name of required) {
    const set = typeof process.env[name] === "string" && process.env[name].length > 0;
    if (!set) missing.push(name);
    console.log(`  ${set ? "SET    " : "MISSING"}  ${name}`);
  }

  if (missing.length) {
    console.log(`\nMissing ${missing.length} required variable(s): ${missing.join(", ")}`);
  } else {
    console.log("\nAll required variables for the selected mode are set.");
  }
  return { missing, isPostgres };
}

// ---------------------------------------------------------------------------
// Post-deploy verification commands
// ---------------------------------------------------------------------------

function printVerification() {
  console.log("\n=== Post-deploy verification (replace example.com with real URLs) ===");
  console.log("# 1. Backend health (functions live; independent of the frontend)");
  console.log(`curl -fsS "https://${API_DOMAIN}/v1/health"`);
  console.log("\n# 2. Frontend loads (static UI renders even with the API down)");
  console.log(`curl -fsSI "https://${CONSOLE_DOMAIN}/" | head -n 1`);
  console.log(`curl -fsSI "https://${CONSOLE_DOMAIN}/admin/" | head -n 1`);
  console.log(`curl -fsSI "https://${CONSOLE_DOMAIN}/docs/" | head -n 1`);
  console.log("\n# 3. CORS: exact console origin allowed, wildcard never returned");
  console.log(
    `curl -sS -D - -o /dev/null -H "Origin: https://${CONSOLE_DOMAIN}" \\\n  "https://${API_DOMAIN}/v1/health" | grep -i '^access-control-allow-origin:'`
  );
  console.log(`# Expected: access-control-allow-origin: https://${CONSOLE_DOMAIN}`);
  console.log("# NOT `*` — wildcard with credentials is forbidden.");
  console.log("\n# 4. Split guardrail + independent build proof (CI jobs: split-boundaries, backend-build, frontend-build)");
  console.log("node scripts/verify-split.mjs");
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main() {
  const args = process.argv.slice(2);
  if (args.includes("--help") || args.includes("-h")) {
    console.log("Usage: node scripts/deploy-vercel.mjs [--check]");
    console.log("  --check  audit required env vars only; exit 1 if any are missing");
    return 0;
  }

  const checkOnly = args.includes("--check");
  if (!checkOnly) printPlan();

  const { missing, isPostgres } = auditEnv();

  if (!checkOnly) printVerification();

  if (checkOnly) {
    // Non-zero when production postgres mode is selected without DB URLs (or
    // when any other required variable is missing).
    if (missing.length) {
      console.error(`ERROR: ${missing.length} required environment variable(s) missing; refusing to proceed.`);
      return 1;
    }
    if (isPostgres) console.log("Production postgres configuration is complete.");
    return 0;
  }

  console.log("\nThis helper does not deploy. Deployment is a manual Vercel CLI/dashboard action.");
  return 0;
}

process.exit(main());
