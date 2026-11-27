/**
 * @vellum/api - Error Handler Middleware
 * Formats errors into the canonical §11.2 ErrorEnvelope.
 * Never leaks stack traces or internal database details in production responses.
 */

import type { ErrorHandler } from "hono";
import { VellumError, ERROR_HTTP_STATUS } from "@vellum/core";
import type { ContentfulStatusCode } from "hono/utils/http-status";

/** Patterns indicating internal DB/network/runtime errors that must never leak. */
const INTERNAL_LEAK_RE =
  /(postgres(?:ql)?:\/\/|password=|ECONNREFUSED|ETIMEDOUT|ENOTFOUND|relation\s+"|column\s+"|syntax error at or near|pg_catalog|stack:|at\s+\S+\s+\()/i;

function isProduction(): boolean {
  return process.env["NODE_ENV"] === "production";
}

function safeUnexpectedMessage(err: unknown): string {
  if (isProduction()) return "Internal Server Error";
  if (err instanceof Error && err.message) {
    if (INTERNAL_LEAK_RE.test(err.message)) return "Internal Server Error";
    return err.message.slice(0, 256);
  }
  return "Internal Server Error";
}

/**
 * PostgreSQL SQLSTATEs and Node socket codes that mean "the database cannot be
 * reached right now" (quota/resource exhaustion, admin shutdown, connection
 * failure). Mapped to a structured 503 instead of a bare 500 so clients can
 * back off and retry.
 */
const DB_CONNECT_SQLSTATES = new Set([
  "53000", // out_of_memory / Neon project quota exhaustion
  "53100",
  "53200",
  "53300",
  "57P01", // admin_shutdown
  "57P02",
  "57P03",
  "08000",
  "08001",
  "08003",
  "08004",
  "08006",
  "08007",
  "08P01",
]);
const DB_CONNECT_NODE_CODES = new Set([
  "ECONNREFUSED",
  "ETIMEDOUT",
  "ECONNRESET",
  "ENOTFOUND",
  "EPIPE",
  "EAI_AGAIN",
]);
const DB_CONNECT_MESSAGE_RE =
  /timeout exceeded when trying to connect|Connection terminated unexpectedly|connection timeout|remaining connection slots are reserved|too many connections/i;

/** Walk the error/cause chain looking for a database-connectivity failure. */
function dbConnectErrorCode(err: unknown, depth = 0): string | null {
  if (depth > 4 || err === null || typeof err !== "object") return null;
  const code = (err as { code?: unknown }).code;
  if (typeof code === "string") {
    if (DB_CONNECT_SQLSTATES.has(code) || DB_CONNECT_NODE_CODES.has(code)) return code;
  }
  const message = (err as { message?: unknown }).message;
  if (typeof message === "string" && DB_CONNECT_MESSAGE_RE.test(message)) return "CONNECTION_ERROR";
  return dbConnectErrorCode((err as { cause?: unknown }).cause, depth + 1);
}

export const errorHandler: ErrorHandler = (err, c) => {
  const reqId = c.get("requestId") || c.req.header("x-request-id") || "req_unknown";

  // Database-connectivity failures degrade gracefully: structured JSON 503
  // with Retry-After, never a bare 500 (or worse, a platform-level crash page).
  if (!(err instanceof VellumError)) {
    const connectCode = dbConnectErrorCode(err);
    if (connectCode !== null) {
      c.header("Retry-After", "5");
      return c.json(
        {
          error: {
            code: "SERVICE_UNAVAILABLE",
            message: "The database is temporarily unavailable. Please retry shortly.",
            requestId: reqId,
            details: { retryAfterSeconds: 5, retryable: true },
          },
        },
        503
      );
    }
  }

  if (err instanceof VellumError) {
    const status = (ERROR_HTTP_STATUS[err.code] ?? 500) as ContentfulStatusCode;

    // Retryable throttles carry `retryAfterSeconds` in `details`. Surface it as
    // the canonical HTTP header as well (belt-and-braces with the header the
    // auth-rate-limit middleware writes before throwing).
    const retryAfter = err.details?.["retryAfterSeconds"];
    if (typeof retryAfter === "number" && Number.isFinite(retryAfter) && retryAfter > 0) {
      c.header("Retry-After", String(Math.ceil(retryAfter)));
    }

    const isServerError = status >= 500;
    const message =
      isProduction() && isServerError && INTERNAL_LEAK_RE.test(err.message)
        ? "Internal Server Error"
        : err.message;
    const includeDetails =
      !isServerError || !isProduction()
        ? Boolean(err.details && Object.keys(err.details).length > 0)
        : false;

    return c.json(
      {
        error: {
          code: err.code,
          message,
          requestId: reqId,
          ...(includeDetails ? { details: err.details } : {}),
          ...(err.details?.["retryableWithRefresh"] === true
            ? { retryableWithRefresh: true }
            : {}),
        },
      },
      status
    );
  }

  // Generic or unexpected error: never leak stack traces or internal DB details.
  return c.json(
    {
      error: {
        code: "INTERNAL",
        message: safeUnexpectedMessage(err),
        requestId: reqId,
      },
    },
    500
  );
};
