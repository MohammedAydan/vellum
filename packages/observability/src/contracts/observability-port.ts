/**
 * @vellum/observability - Canonical Observability Port Contracts
 */

import type { LogEntry } from "../logger.js";
import type { RateLimiter } from "../rate-limiter.js";

/** Outbound port for structured, secret-redacting logging. */
export interface LoggerPort {
  log(level: string, msg: unknown, meta?: Record<string, unknown>): LogEntry;
  info(msg: unknown, meta?: Record<string, unknown>): LogEntry;
  warn(msg: unknown, meta?: Record<string, unknown>): LogEntry;
  error(msg: unknown, meta?: Record<string, unknown>): LogEntry;
}

/** Outbound port for bounded sliding-window rate limiting. */
export type RateLimiterPort = RateLimiter;
