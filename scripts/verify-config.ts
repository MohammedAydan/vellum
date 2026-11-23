/**
 * Focused verification harness for configuration changes.
 * Run: corepack pnpm exec tsx scripts/verify-config.ts
 * Exits non-zero on any failed assertion.
 */
import assert from "node:assert/strict";
import {
  ConfigSchema,
  getRedactedConfigSummary,
  loadAndValidateConfig,
} from "../apps/api/src/config.js";

const dev = ConfigSchema.parse({});
assert.ok(dev.JWT_SECRET.length >= 16, "JWT_SECRET default must be >= 16 characters");
assert.equal(
  Object.keys(dev).some((key) => /^(BROKER|PUBSUB|CACHE)_/.test(key)),
  false,
  "no external broker/cache URL field may exist in config",
);

// Production must refuse every hardcoded development secret.
assert.throws(
  () => loadAndValidateConfig({ NODE_ENV: "production" }),
  /Refusing to start in production with hardcoded default secret\(s\)/,
);

const strong = {
  NODE_ENV: "production",
  BETTER_AUTH_SECRET: "strong-better-auth-secret-1234567890",
  API_KEY_PEPPER: "strong-api-key-pepper-1234567890",
  CURSOR_HMAC_SECRET: "strong-cursor-hmac-secret-1234567890",
  JWT_SECRET: "strong-jwt-secret-1234567890",
  CONTROL_DATABASE_APP_URL: "postgres://vellum_app:pw@localhost:5432/control_db",
  DATA_DATABASE_APP_URL: "postgres://vellum_app:pw@localhost:5433/data_db",
};
const cfg = loadAndValidateConfig(strong);
assert.equal(cfg.JWT_SECRET, strong.JWT_SECRET);
assert.equal(cfg.CONTROL_DATABASE_APP_URL, strong.CONTROL_DATABASE_APP_URL);
assert.equal(cfg.DATA_DATABASE_APP_URL, strong.DATA_DATABASE_APP_URL);

assert.throws(
  () => ConfigSchema.parse({ JWT_SECRET: "short" }),
  /JWT_SECRET must be at least 16 characters/,
);

const summary = JSON.stringify(getRedactedConfigSummary(cfg));
assert.equal(summary.includes(strong.JWT_SECRET), false, "JWT_SECRET leaked into log summary");
assert.equal(summary.includes("vellum_app:pw"), false, "app URL credentials leaked into log summary");
assert.ok(summary.includes("[REDACTED]"), "redacted summary must mask secrets");

console.log(
  "[verify-config] PASS: JWT_SECRET (+min length), production default rejection, " +
    "optional app URLs, redaction, and zero external-broker config.",
);
