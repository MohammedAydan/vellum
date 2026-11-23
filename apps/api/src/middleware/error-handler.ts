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

export const errorHandler: ErrorHandler = (err, c) => {
  const reqId = c.get("requestId") || c.req.header("x-request-id") || "req_unknown";

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
