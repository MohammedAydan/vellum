#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";

console.log("🔍 Checking runtime configuration...");

const envPath = path.resolve(process.cwd(), ".env");
if (!fs.existsSync(envPath)) {
  console.warn("⚠️  No root .env file found. Creating one from .env.example...");
  const examplePath = path.resolve(process.cwd(), ".env.example");
  if (fs.existsSync(examplePath)) {
    fs.copyFileSync(examplePath, envPath);
    console.log("✅ Created .env from .env.example.");
  } else {
    console.error("❌ Neither .env nor .env.example found!");
    process.exit(1);
  }
}

// Basic parse of .env
const envContent = fs.readFileSync(envPath, "utf8");
const lines = envContent.split("\n");
const envVars = {};
for (const line of lines) {
  const trimmed = line.trim();
  if (trimmed && !trimmed.startsWith("#")) {
    const idx = trimmed.indexOf("=");
    if (idx > 0) {
      const key = trimmed.slice(0, idx).trim();
      const val = trimmed.slice(idx + 1).trim();
      envVars[key] = val;
    }
  }
}

// Rebrand aliases: VELLUM_* names are read first, legacy VELLUM_* names and the
// original unprefixed names keep working. Only variable names are ever printed.
const AUXILIARY_ALIASES = {
  VELLUM_DOMAIN: "VELLUM_DOMAIN",
  VELLUM_REPO_ROOT: "VELLUM_REPO_ROOT",
  VELLUM_ENDPOINT: "VELLUM_ENDPOINT",
  VELLUM_PROJECT_ID: "VELLUM_PROJECT_ID",
  VELLUM_API_KEY: "VELLUM_API_KEY",
  VELLUM_TEST_COLLECTION: "VELLUM_TEST_COLLECTION",
  VELLUM_REPORT: "VELLUM_REPORT",
  VELLUM_CONSOLE_EMAIL: "VELLUM_CONSOLE_EMAIL",
  VELLUM_CONSOLE_PASSWORD: "VELLUM_CONSOLE_PASSWORD",
  VELLUM_ADMIN_EMAIL: "VELLUM_ADMIN_EMAIL",
  VELLUM_ADMIN_PASSWORD: "VELLUM_ADMIN_PASSWORD",
  VELLUM_API_BASE: "VELLUM_API_BASE",
  VELLUM_API_BASE_URL: "VELLUM_API_BASE_URL",
  VELLUM_DASHBOARD_BASE_URL: "VELLUM_DASHBOARD_BASE_URL",
  VELLUM_BILLING_LEDGER_MASTER_KEY: "VELLUM_BILLING_LEDGER_MASTER_KEY",
};
// Extra accepted spellings for canonical names checked below.
const EXTRA_ALIASES = { API_BASE_URL: ["VELLUM_API_BASE", "VELLUM_API_BASE"] };

const hasValue = (name) => Boolean(envVars[name] || process.env[name]);
const valueFor = (name) => {
  const vellumName = `VELLUM_${name}`;
  const legacyName = AUXILIARY_ALIASES[vellumName] ?? `VELLUM_${name}`;
  return (
    hasValue(vellumName) ||
    hasValue(legacyName) ||
    (EXTRA_ALIASES[name] ?? []).some(hasValue) ||
    hasValue(name)
  );
};

// No external broker is required: realtime is PostgreSQL LISTEN/NOTIFY plus
// the durable realtime_outbox; caching/rate limits use in-process TTL LRU.
const required = [
  "CONTROL_DATABASE_URL",
  "DATA_DATABASE_URL",
  "BETTER_AUTH_SECRET",
  "API_KEY_PEPPER",
  "CURSOR_HMAC_SECRET",
  "MASTER_ENCRYPTION_KEY",
  "API_BASE_URL",
];

const missing = required.filter((k) => !valueFor(k));
if (missing.length > 0) {
  console.error("❌ Missing required environment variables in .env:");
  for (const m of missing) {
    console.error(`  - ${m}`);
  }
  process.exit(1);
}

// Production safety is enforced by apps/api/src/config.ts, which rejects the
// hardcoded JWT_SECRET default at startup. Warn here without blocking local dev.
if (!valueFor("JWT_SECRET")) {
  console.warn("⚠️  JWT_SECRET is not set; the development default will be used (rejected in production).");
}

// Realm session secrets are optional in development (fall back to JWT_SECRET)
// but required and distinct in production. Only field names are ever printed.
const realmSessionSecrets = ["CONSOLE_JWT_SECRET", "SUPER_ADMIN_JWT_SECRET"];
const missingRealmSecrets = realmSessionSecrets.filter((key) => !valueFor(key));
if (process.env.NODE_ENV === "production") {
  if (missingRealmSecrets.length > 0) {
    console.error("❌ Production requires these realm session secrets to be set:");
    for (const name of missingRealmSecrets) console.error(`  - ${name}`);
    process.exit(1);
  }
} else {
  for (const name of missingRealmSecrets) {
    console.warn(`⚠️  ${name} is not set; the development fallback (JWT_SECRET) will be used (rejected in production).`);
  }
}

console.log("✅ Runtime configuration check passed. All critical variables present.");
