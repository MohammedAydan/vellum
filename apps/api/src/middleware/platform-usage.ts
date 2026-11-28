/**
 * `@vellum/api - Platform usage metering middleware`
 *
 * Counts every request the platform serves into the O(1) platform meter: one
 * request counter by class, the handler's CPU time and the byte totals. It runs
 * outside the customer metering path (fortress step 8, which only covers the
 * document plane) so console, admin, auth and realtime traffic is priced too.
 *
 * The middleware never throws and never changes the response.
 */

import type { MiddlewareHandler } from "hono";
import { PLATFORM_SCOPE, type PlatformUsageMeter } from "@vellum/observability";

/** `/v1/projects/<uuid>/...` belongs to one project; everything else is platform scope. */
const PROJECT_PATH = /^\/v1\/projects\/([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})(?:\/|$)/;

const WRITE_METHODS: ReadonlySet<string> = new Set(["POST", "PUT", "PATCH", "DELETE"]);

function headerBytes(value: string | null | undefined): number {
  if (value === null || value === undefined) return 0;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.trunc(parsed) : 0;
}

export function platformUsageMetering(meter: PlatformUsageMeter): MiddlewareHandler {
  return async (c, next) => {
    const startedAt = performance.now();
    const inbound = headerBytes(c.req.header("content-length"));
    await next();
    try {
      const scope = PROJECT_PATH.exec(c.req.path)?.[1] ?? PLATFORM_SCOPE;
      const method = c.req.method.toUpperCase();
      const requestMetric = method === "GET" || method === "HEAD" ? "requests_read" : WRITE_METHODS.has(method) ? "requests_write" : "requests_other";
      meter.record(scope, requestMetric, 1);
      meter.record(scope, "cpu_ms", Math.round(performance.now() - startedAt));
      if (inbound > 0) meter.record(scope, "bytes_in", inbound);
      const outbound = headerBytes(c.res.headers.get("content-length"));
      if (outbound > 0) meter.record(scope, "bytes_out", outbound);
    } catch {
      // Metering is best effort: a failure must never alter the response.
    }
  };
}
