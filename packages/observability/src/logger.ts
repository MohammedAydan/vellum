/**
 * @vellum/observability - Structured JSON Logger with Deep Secret/PII Redaction
 *
 * Guarantees circular-reference safety, bounded recursion depth and cardinality,
 * comprehensive secret/PII pattern scrubbing (passwords, Bearer/Basic tokens,
 * JWTs, API keys, DB URIs, cookies), bounded in-memory log buffer, and
 * non-throwing telemetry sinks.
 */

import pino from "pino";
import type { LoggerPort } from "./contracts/observability-port.js";

const MAX_REDACT_DEPTH = 20;
const MAX_REDACT_KEYS = 200;
const MAX_REDACT_ARRAY_ITEMS = 500;
const DEFAULT_MAX_LOG_ENTRIES = 5_000;

const FORBIDDEN_KEYS: ReadonlySet<string> = new Set(["__proto__", "constructor", "prototype"]);

const SENSITIVE_KEY_REGEX =
  /api[-_]?key|secret|password|passwd|pwd|token|authorization|database[-_]?url|cookie|set[-_]?cookie|session[-_]?id|private[-_]?key|x[-_]?project[-_]?key|x[-_]?vellum[-_]?api[-_]?key|credit[-_]?card|card[-_]?number|cvv|ssn|credential/i;

/**
 * Linear-time regexes (no nested quantifiers / zero ReDoS risk) matching:
 * - Project / server / webhook API keys (pk_..., sk_..., rk_..., whsec_...)
 * - JWTs (three base64url segments starting with eyJ)
 * - Authorization Bearer / Basic schemes
 * - Database connection URIs (postgres/postgresql/redis/rediss/mongodb)
 * - Inline cookie/password key=value pairs in strings
 */
const SENSITIVE_VALUE_REGEX =
  /\b(?:pk_(?:(?:live|stg|dev)_)?[A-Za-z0-9]{8,}|sk_(?:(?:live|stg|dev)_)?[A-Za-z0-9]{8,}|rk_(?:(?:live|stg|dev)_)?[A-Za-z0-9]{8,}|whsec_[A-Za-z0-9_-]{8,}|eyJ[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}|(?:Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+|(?:postgres(?:ql)?|rediss?|mongodb(?:\+srv)?):\/\/[^\s"']+)/g;

const INLINE_COOKIE_OR_SECRET_REGEX =
  /\b((?:password|passwd|secret|api_key|apikey|access_token|refresh_token|cookie|set-cookie)\s*[:=]\s*)([^\s;,"']+)/gi;

function redactString(value: string): string {
  return value
    .replace(SENSITIVE_VALUE_REGEX, "[REDACTED]")
    .replace(INLINE_COOKIE_OR_SECRET_REGEX, "$1[REDACTED]");
}

function redactNode(input: unknown, depth: number, active: WeakSet<object>): unknown {
  if (typeof input === "string") {
    return redactString(input);
  }
  if (input === null || typeof input !== "object") {
    return input;
  }
  if (input instanceof Date) {
    return Number.isNaN(input.getTime()) ? "[Invalid Date]" : input.toISOString();
  }
  if (Buffer.isBuffer(input) || input instanceof Uint8Array) {
    return `[Buffer(${input.byteLength})]`;
  }
  if (depth >= MAX_REDACT_DEPTH) {
    return "[MaxDepth]";
  }
  if (active.has(input)) {
    return "[Circular]";
  }

  active.add(input);
  try {
    if (input instanceof Error) {
      const out: Record<string, unknown> = {
        name: input.name,
        message: redactString(input.message),
      };
      if (typeof input.stack === "string") {
        out["stack"] = redactString(input.stack);
      }
      return out;
    }

    if (Array.isArray(input)) {
      const limit = Math.min(input.length, MAX_REDACT_ARRAY_ITEMS);
      const result: unknown[] = new Array<unknown>(limit);
      for (let i = 0; i < limit; i++) {
        result[i] = redactNode(input[i], depth + 1, active);
      }
      if (input.length > MAX_REDACT_ARRAY_ITEMS) {
        result.push(`[+${input.length - MAX_REDACT_ARRAY_ITEMS} truncated]`);
      }
      return result;
    }

    const out: Record<string, unknown> = {};
    const entries = Object.entries(input as Record<string, unknown>);
    let count = 0;
    for (const [k, v] of entries) {
      if (FORBIDDEN_KEYS.has(k)) {
        continue;
      }
      if (count >= MAX_REDACT_KEYS) {
        out["_truncatedKeys"] = entries.length - count;
        break;
      }
      count += 1;
      if (SENSITIVE_KEY_REGEX.test(k)) {
        out[k] = "[REDACTED]";
      } else {
        out[k] = redactNode(v, depth + 1, active);
      }
    }
    return out;
  } catch {
    return "[Unserializable]";
  } finally {
    active.delete(input);
  }
}

export function redactSensitiveData(input: unknown): unknown {
  return redactNode(input, 0, new WeakSet<object>());
}

export interface LoggerConfig {
  service?: string | undefined;
  level?: string | undefined;
  sink?: ((entry: LogEntry) => void) | null | undefined;
  maxEntries?: number | undefined;
}

export interface LogEntry {
  ts: string;
  level: string;
  service: string;
  msg: unknown;
  [key: string]: unknown;
}

export function createLogger(config: LoggerConfig = {}): pino.Logger {
  return pino({
    name: config.service ?? "@vellum/api",
    level: config.level ?? "info",
    redact: {
      paths: [
        "authorization",
        "Authorization",
        "headers.authorization",
        "headers.Authorization",
        "headers.cookie",
        "headers['set-cookie']",
        "headers['x-project-key']",
        "headers['x-vellum-api-key']",
        "headers['x-api-key']",
        "x-project-key",
        "x-vellum-api-key",
        "cookie",
        "password",
        "secret",
        "token",
        "accessToken",
        "refreshToken",
        "idToken",
        "privateKey",
        "apiKey",
        "api_key",
        "database_url",
        "*.password",
        "*.secret",
        "*.token",
        "*.apiKey",
        "*.authorization",
      ],
      censor: "[REDACTED]",
    },
  });
}

export class StructuredLogger implements LoggerPort {
  service: string;
  sink: ((entry: LogEntry) => void) | null;
  entries: LogEntry[];
  private readonly maxEntries: number;

  constructor({ service = "@vellum/api", sink = null, maxEntries }: LoggerConfig = {}) {
    this.service = service;
    this.sink = sink ?? null;
    this.entries = [];
    this.maxEntries =
      typeof maxEntries === "number" && Number.isFinite(maxEntries) && maxEntries >= 1
        ? Math.trunc(maxEntries)
        : DEFAULT_MAX_LOG_ENTRIES;
  }

  log(level: string, msg: unknown, meta: Record<string, unknown> = {}): LogEntry {
    const redactedMeta = redactSensitiveData(meta);
    const safeMeta: Record<string, unknown> =
      redactedMeta !== null && typeof redactedMeta === "object" && !Array.isArray(redactedMeta)
        ? (redactedMeta as Record<string, unknown>)
        : {};

    const entry: LogEntry = {
      ...safeMeta,
      ts: new Date().toISOString(),
      level: typeof level === "string" ? level : "info",
      service: this.service,
      msg: redactSensitiveData(msg),
    };

    if (this.entries.length >= this.maxEntries) {
      const dropCount = Math.max(1, Math.floor(this.maxEntries / 10));
      this.entries.splice(0, dropCount);
    }
    this.entries.push(entry);

    if (this.sink) {
      try {
        this.sink(entry);
      } catch {
        // Telemetry sinks must never throw and crash request handling.
      }
    }
    return entry;
  }

  info(msg: unknown, meta?: Record<string, unknown>): LogEntry {
    return this.log("info", msg, meta);
  }

  warn(msg: unknown, meta?: Record<string, unknown>): LogEntry {
    return this.log("warn", msg, meta);
  }

  error(msg: unknown, meta?: Record<string, unknown>): LogEntry {
    return this.log("error", msg, meta);
  }
}
