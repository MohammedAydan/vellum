/**
 * Server Configuration & Environment Variable Validator (`apps/api/src/config.ts`)
 * Uses Zod to parse, type-check, and fail-fast on invalid configuration.
 * Logs redacted configuration summary on startup (never prints secrets).
 */

import { z } from "zod";
import dotenv from "dotenv";
import path from "node:path";
import fs from "node:fs";

// Automatically load .env if present from cwd or monorepo root
const candidateEnvPaths = [
  path.resolve(process.cwd(), ".env"),
  path.resolve(process.cwd(), "../../.env"),
  path.resolve(process.cwd(), "../.env"),
];
if (process.env["PHASE5_REAL"] === "1") {
  candidateEnvPaths.unshift(path.resolve(process.cwd(), ".env.phase5.local"));
}
for (const envPath of candidateEnvPaths) {
  if (fs.existsSync(envPath)) {
    dotenv.config({ path: envPath });
    break;
  }
}

/**
 * Hardcoded development defaults. Allowed in development/test only —
 * `loadAndValidateConfig()` refuses to start in production while any of these
 * values is still in use. Kept in one place so schema defaults and the
 * production guard cannot drift apart.
 */
const DEV_SECRET_DEFAULTS = {
  BETTER_AUTH_SECRET: "dev_secret_change_me_to_32_char_random_string_abc123",
  API_KEY_PEPPER: "dev_pepper_change_me_to_32_char_random_string_xyz789",
  CURSOR_HMAC_SECRET: "dev_hmac_secret_change_me_to_32_char_random_string_def456",
  JWT_SECRET: "dev_jwt_secret_change_me_to_32_char_random_string_jkl345",
  MASTER_ENCRYPTION_KEY: "dev_master_key_change_me_to_64_hex_chars_0123456789abcdef0123456789abcdef",
} as const;

type DevDefaultSecretName = keyof typeof DEV_SECRET_DEFAULTS;

/** Masks credentials in a connection string without ever emitting a secret. */
const maskUrl = (value?: string): string => {
  if (!value) return "[NOT SET]";
  return value.replace(/:\/\/[^:]+:[^@]+@/, "://[USER]:[PASS]@");
};

export const ConfigSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),

  /**
   * Storage backend selection.
   *   "memory"    – ephemeral in-process stores (unit tests, offline demo)
   *   "postgres"  – durable PostgreSQL control + data planes (production/staging)
   * Defaults to "memory" so the existing test suite keeps running hermetically.
   */
  DATABASE_MODE: z.enum(["memory", "postgres"]).default("memory"),

  // Control Plane Database
  CONTROL_DATABASE_URL: z
    .string()
    .default("postgres://vellum:vellum_dev_password@localhost:5432/control_db"),
  CONTROL_DATABASE_URL_DIRECT: z.string().optional(),
  CONTROL_DATABASE_DRIVER: z.enum(["pg", "neon"]).default("pg"),
  /**
   * Optional least-privilege (vellum_app, non-superuser) runtime URL.
   * Migrations/DDL ALWAYS use CONTROL_DATABASE_URL; request-time reads/writes
   * may use this URL when the operator supplies it.
   */
  CONTROL_DATABASE_APP_URL: z.string().optional(),

  // Data Plane Database
  DATA_DATABASE_URL: z
    .string()
    .default("postgres://vellum:vellum_dev_password@localhost:5433/data_db"),
  DATA_DATABASE_URL_DIRECT: z.string().optional(),
  /** Session-mode (non-pooler) endpoint used exclusively by the LISTEN client. */
  DATA_DATABASE_URL_LISTEN: z.string().optional(),
  DATA_DATABASE_DRIVER: z.enum(["pg", "neon"]).default("pg"),
  /** Optional least-privilege runtime URL. Migrations always use DATA_DATABASE_URL. */
  DATA_DATABASE_APP_URL: z.string().optional(),

  // Secrets & Authentication (minimum 16 chars; production rejects defaults)
  BETTER_AUTH_SECRET: z
    .string()
    .min(16, "BETTER_AUTH_SECRET must be at least 16 characters")
    .default(DEV_SECRET_DEFAULTS.BETTER_AUTH_SECRET),
  BETTER_AUTH_URL: z.string().url().default("http://localhost:8080"),
  API_KEY_PEPPER: z
    .string()
    .min(16, "API_KEY_PEPPER must be at least 16 characters")
    .default(DEV_SECRET_DEFAULTS.API_KEY_PEPPER),
  CURSOR_HMAC_SECRET: z
    .string()
    .min(16, "CURSOR_HMAC_SECRET must be at least 16 characters")
    .default(DEV_SECRET_DEFAULTS.CURSOR_HMAC_SECRET),
  /** Signs Console session access/refresh tokens (distinct from JWT_JWKS_URL). */
  JWT_SECRET: z
    .string()
    .min(16, "JWT_SECRET must be at least 16 characters")
    .default(DEV_SECRET_DEFAULTS.JWT_SECRET),
  /**
   * Realm-bound session secrets. Optional in development (fall back to
   * JWT_SECRET); required and distinct in production. Values are never logged.
   */
  CONSOLE_JWT_SECRET: z
    .string()
    .min(16, "CONSOLE_JWT_SECRET must be at least 16 characters")
    .optional(),
  SUPER_ADMIN_JWT_SECRET: z
    .string()
    .min(16, "SUPER_ADMIN_JWT_SECRET must be at least 16 characters")
    .optional(),
  /**
   * One-time bootstrap secret for `/v1/admin/setup-owner`. Required in
   * production so an anonymous visitor cannot claim the Master Owner role.
   * Optional in development/test for hermetic fixtures. Never logged.
   */
  ADMIN_SETUP_TOKEN: z
    .string()
    .min(16, "ADMIN_SETUP_TOKEN must be at least 16 characters")
    .optional(),
  SESSION_COOKIE_SECRET: z.string().optional(),
  /** AES-256-GCM master key for end-user auth secrets at rest (HKDF-derived). */
  MASTER_ENCRYPTION_KEY: z
    .string()
    .min(16, "MASTER_ENCRYPTION_KEY must be at least 16 characters")
    .default(DEV_SECRET_DEFAULTS.MASTER_ENCRYPTION_KEY),

  // End-user JWT options (optional)
  JWT_JWKS_URL: z.string().optional().or(z.literal("")),
  JWT_ISSUER: z.string().optional().or(z.literal("")),
  JWT_AUDIENCE: z.string().optional().or(z.literal("")),
  JWKS_FETCH_TIMEOUT_MS: z.coerce.number().default(5000),
  JWKS_CACHE_TTL_SECONDS: z.coerce.number().default(300),

  // API Server settings
  API_PORT: z.coerce.number().default(8080),
  API_HOST: z.string().default("0.0.0.0"),
  API_BASE_URL: z.string().default("http://localhost:8080"),
  CORS_ALLOWED_ORIGINS: z
    .string()
    // Shared-origin deployment puts both consoles on localhost:3000.
    .default("http://localhost:3000,http://localhost:5173,http://localhost:5174"),
  RATE_LIMIT_RPS_DEFAULT: z.coerce.number().default(100),

  // Observability
  SENTRY_DSN: z.string().optional(),
  OTEL_EXPORTER_OTLP_ENDPOINT: z.string().optional(),
});

export type AppConfig = z.infer<typeof ConfigSchema>;

let parsedConfig: AppConfig | null = null;

export function loadAndValidateConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const result = ConfigSchema.safeParse(env);
  if (!result.success) {
    const errorDetails = (result as Extract<typeof result, { success: false }>).error.issues
      .map((issue: z.ZodIssue) => `  - [${issue.path.join(".")}]: ${issue.message}`)
      .join("\n");
    console.error(`\n❌ [CONFIGURATION ERROR] Invalid configuration variables:\n${errorDetails}\n`);
    throw new Error(`Invalid configuration:\n${errorDetails}`);
  }

  // Fail closed in production: a shipped development secret must never reach a
  // real deployment, even if it satisfies the minimum-length rule above.
  if (result.data.NODE_ENV === "production") {
    const insecureDefaults = (Object.keys(DEV_SECRET_DEFAULTS) as DevDefaultSecretName[]).filter(
      (name) => result.data[name] === DEV_SECRET_DEFAULTS[name],
    );
    if (insecureDefaults.length > 0) {
      throw new Error(
        `[CONFIGURATION ERROR] Refusing to start in production with hardcoded default secret(s): ${insecureDefaults.join(", ")}. Set strong, unique values before deploying.`,
      );
    }

    // The two control-plane realms must use distinct, explicit secrets in
    // production. Report only field names, never the values themselves.
    const missingRealmSecrets = (
      ["CONSOLE_JWT_SECRET", "SUPER_ADMIN_JWT_SECRET"] as const
    ).filter((name) => !result.data[name]);
    if (missingRealmSecrets.length > 0) {
      throw new Error(
        `[CONFIGURATION ERROR] Refusing to start in production without realm secret(s): ${missingRealmSecrets.join(", ")}. Set strong, unique values before deploying.`,
      );
    }
    if (result.data.CONSOLE_JWT_SECRET === result.data.SUPER_ADMIN_JWT_SECRET) {
      throw new Error(
        "[CONFIGURATION ERROR] Refusing to start in production with identical realm secrets. Set strong, distinct values before deploying.",
      );
    }
  }

  parsedConfig = result.data;
  return parsedConfig;
}

export function getConfig(): AppConfig {
  if (!parsedConfig) {
    return loadAndValidateConfig();
  }
  return parsedConfig;
}

/**
 * Returns a sanitized copy of the config safe for logging (all secrets masked).
 */
export function getRedactedConfigSummary(cfg: AppConfig = getConfig()): Record<string, unknown> {
  const redact = (val?: string) => (val && val.length > 0 ? "[REDACTED]" : "[NOT SET]");
  return {
    NODE_ENV: cfg.NODE_ENV,
    LOG_LEVEL: cfg.LOG_LEVEL,
    DATABASE_MODE: cfg.DATABASE_MODE,
    API_PORT: cfg.API_PORT,
    API_HOST: cfg.API_HOST,
    API_BASE_URL: cfg.API_BASE_URL,
    CONTROL_DATABASE_DRIVER: cfg.CONTROL_DATABASE_DRIVER,
    CONTROL_DATABASE_URL: maskUrl(cfg.CONTROL_DATABASE_URL),
    CONTROL_DATABASE_APP_URL: maskUrl(cfg.CONTROL_DATABASE_APP_URL),
    DATA_DATABASE_DRIVER: cfg.DATA_DATABASE_DRIVER,
    DATA_DATABASE_URL: maskUrl(cfg.DATA_DATABASE_URL),
    DATA_DATABASE_APP_URL: maskUrl(cfg.DATA_DATABASE_APP_URL),
    BETTER_AUTH_SECRET: redact(cfg.BETTER_AUTH_SECRET),
    API_KEY_PEPPER: redact(cfg.API_KEY_PEPPER),
    CURSOR_HMAC_SECRET: redact(cfg.CURSOR_HMAC_SECRET),
    JWT_SECRET: redact(cfg.JWT_SECRET),
    CONSOLE_JWT_SECRET: redact(cfg.CONSOLE_JWT_SECRET),
    SUPER_ADMIN_JWT_SECRET: redact(cfg.SUPER_ADMIN_JWT_SECRET),
    ADMIN_SETUP_TOKEN: redact(cfg.ADMIN_SETUP_TOKEN),
    MASTER_ENCRYPTION_KEY: redact(cfg.MASTER_ENCRYPTION_KEY),
    CORS_ALLOWED_ORIGINS: cfg.CORS_ALLOWED_ORIGINS,
    RATE_LIMIT_RPS_DEFAULT: cfg.RATE_LIMIT_RPS_DEFAULT,
  };
}
