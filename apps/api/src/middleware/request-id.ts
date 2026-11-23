/**
 * @vellum/api - Request ID Middleware
 */

import type { MiddlewareHandler } from "hono";
import crypto from "node:crypto";

declare module "hono" {
  interface ContextVariableMap {
    requestId: string;
  }
}

const SAFE_REQUEST_ID_RE = /^[A-Za-z0-9._-]{1,128}$/;

export function requestId(): MiddlewareHandler {
  return async (c, next) => {
    const incoming = c.req.header("x-request-id")?.trim();
    const id =
      incoming && SAFE_REQUEST_ID_RE.test(incoming)
        ? incoming
        : `req_${crypto.randomUUID().replace(/-/g, "")}`;
    c.set("requestId", id);
    c.header("x-request-id", id);
    await next();
  };
}
