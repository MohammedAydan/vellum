/**
 * Standalone Node.js HTTP + RFC 6455 WebSocket Server Adapter (`apps/api/src/node-server.ts`)
 * Used by `docker/Dockerfile.api` and local development.
 */

import { adminRuntimeTelemetry } from "./admin-runtime-telemetry.js";
import http from "node:http";
import { fileURLToPath } from "node:url";
import { type createVellumPlatform, createVellumPlatformFromEnv } from "./index.js";
import {
  attachRealtimeWebSocketServer,
  parseAllowedOrigins,
} from "./ws-rfc6455.js";
import {
  loadAndValidateConfig,
  getConfig,
  getRedactedConfigSummary,
} from "./config.js";
import { setShuttingDown } from "./routes/health.js";

export interface NodeApiServerOptions {
  port?: number;
  platform?: ReturnType<typeof createVellumPlatform>;
  workerIntervalMs?: number;
  /** Maximum time to wait for in-flight HTTP requests to drain during shutdown (default: 10s). */
  shutdownDrainTimeoutMs?: number;
}

/** Raw transport cap: 5 MiB (matches the canonical batch payload limit). */
const MAX_RAW_BODY_BYTES = 5_242_880;
const DEFAULT_SHUTDOWN_DRAIN_TIMEOUT_MS = 10_000;
const SIGNAL_SHUTDOWN_HARD_TIMEOUT_MS = 15_000;
const HTTP_HEADERS_TIMEOUT_MS = 15_000;
const HTTP_REQUEST_TIMEOUT_MS = 30_000;
const HTTP_KEEP_ALIVE_TIMEOUT_MS = 65_000;

export function startNodeApiServer({
  port,
  platform,
  workerIntervalMs = 30_000,
  shutdownDrainTimeoutMs = DEFAULT_SHUTDOWN_DRAIN_TIMEOUT_MS,
}: NodeApiServerOptions = {}) {
  const config = loadAndValidateConfig();
  const effectivePort = port ?? config.API_PORT;
  const platformPromise = platform ? Promise.resolve(platform) : createVellumPlatformFromEnv();

  return platformPromise.then((activePlatform) => {
    setShuttingDown(false);
    activePlatform.logger.info("Server starting with configuration", {
      ...getRedactedConfigSummary(config),
      storageMode: config.DATABASE_MODE,
    });

    let draining = false;
    let inFlightRequests = 0;

    const server = http.createServer(async (req, res) => {
      inFlightRequests += 1;
      res.once("close", () => {
        inFlightRequests = Math.max(0, inFlightRequests - 1);
      });

      if (draining) {
        res.setHeader("Connection", "close");
      }

      try {
        // Early Content-Length check before buffering any chunks.
        const rawContentLength = req.headers["content-length"];
        if (typeof rawContentLength === "string" && rawContentLength.length > 0) {
          const declared = Number(rawContentLength);
          if (Number.isFinite(declared) && declared > MAX_RAW_BODY_BYTES) {
            res.statusCode = 413;
            res.setHeader("Content-Type", "application/json");
            res.end(
              JSON.stringify({
                error: {
                  code: "PAYLOAD_TOO_LARGE",
                  message: `Request body exceeds ${MAX_RAW_BODY_BYTES} bytes`,
                },
              })
            );
            req.destroy();
            return;
          }
        }

        const chunks: Buffer[] = [];
        let receivedBytes = 0;
        for await (const chunk of req) {
          const buffer = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
          receivedBytes += buffer.length;
          if (receivedBytes > MAX_RAW_BODY_BYTES) {
            res.statusCode = 413;
            res.setHeader("Content-Type", "application/json");
            res.end(
              JSON.stringify({
                error: {
                  code: "PAYLOAD_TOO_LARGE",
                  message: `Request body exceeds ${MAX_RAW_BODY_BYTES} bytes`,
                },
              })
            );
            req.destroy();
            return;
          }
          chunks.push(buffer);
        }

        const bodyBuffer = Buffer.concat(chunks);
        const host = req.headers.host || `localhost:${effectivePort}`;
        const url = `http://${host}${req.url || "/"}`;

        const headers = new Headers();
        for (const [k, v] of Object.entries(req.headers)) {
          // Strip any client-spoofed internal remote-address header.
          if (k.toLowerCase() === "x-vellum-remote-addr") continue;
          if (Array.isArray(v)) headers.set(k, v.join(", "));
          else if (typeof v === "string") headers.set(k, v);
        }
        if (req.socket.remoteAddress) {
          headers.set("x-vellum-remote-addr", req.socket.remoteAddress);
        }

        const webReq = new Request(url, {
          method: req.method || "GET",
          headers,
          body: ["GET", "HEAD"].includes(req.method || "GET") || bodyBuffer.length === 0 ? null : bodyBuffer,
        });

        const webRes = await activePlatform.fetch(webReq);
        if (res.writableEnded || res.destroyed) return;

        res.statusCode = webRes.status;
        webRes.headers.forEach((val: string, key: string) => res.setHeader(key, val));
        // Write raw bytes: `webRes.text()` would UTF-8-decode compressed bodies and
        // corrupt the gzip magic bytes (0x1f 0x8b), causing Z_DATA_ERROR in clients
        // that transparently decompress responses advertised with Content-Encoding.
        const resBody = Buffer.from(await webRes.arrayBuffer());
        res.end(resBody);
      } catch (err: unknown) {
        if (!res.writableEnded && !res.destroyed) {
          res.statusCode = 500;
          res.setHeader("Content-Type", "application/json");
          res.end(
            JSON.stringify({
              error: {
                code: "INTERNAL",
                message: "Internal Server Error",
              },
            })
          );
        }
        activePlatform.logger.error("HTTP transport adapter error", {
          reason: err instanceof Error ? err.message.slice(0, 256) : "unknown error",
        });
      }
    });

    // Transport-level timeouts to defend against slowloris and hung sockets.
    server.headersTimeout = HTTP_HEADERS_TIMEOUT_MS;
    server.requestTimeout = HTTP_REQUEST_TIMEOUT_MS;
    server.keepAliveTimeout = HTTP_KEEP_ALIVE_TIMEOUT_MS;

    // browser WebSocket upgrades are restricted to the same allowed
    // origins as the HTTP API. Native clients without an Origin header remain
    // supported (browsers always send one, so CSRF is still blocked).
    const wsManager = attachRealtimeWebSocketServer(server, activePlatform.realtimeHub, {
      allowedOrigins: parseAllowedOrigins(getConfig().CORS_ALLOWED_ORIGINS),
    });

    // Guard maintenance workers against overlapping async ticks & unhandled rejections.
    let maintenanceInFlight = false;
    adminRuntimeTelemetry.maintenanceIntervalMs = workerIntervalMs;
    const workerTimer = setInterval(() => {
      if (maintenanceInFlight || draining) return;
      maintenanceInFlight = true;
      void activePlatform
        .runMaintenanceWorkers()
        .catch((err: unknown) => {
          activePlatform.logger.warn("Maintenance worker tick failed", {
            reason: err instanceof Error ? err.message.slice(0, 256) : String(err),
          });
        })
        .finally(() => {
          maintenanceInFlight = false;
        });
    }, workerIntervalMs);
    workerTimer.unref();

    let stopPromise: Promise<void> | null = null;

    return new Promise<{
      server: http.Server;
      port: number;
      platform: ReturnType<typeof createVellumPlatform>;
      stop: () => Promise<void>;
    }>((resolve) => {
      server.listen(effectivePort, config.API_HOST || "0.0.0.0", () => {
        const addr = server.address();
        const actualPort = typeof addr === "object" && addr !== null ? addr.port : effectivePort;
        resolve({
          server,
          port: actualPort,
          platform: activePlatform,
          stop: () => {
            if (stopPromise) return stopPromise;
            stopPromise = (async () => {
              draining = true;
              setShuttingDown(true);
              clearInterval(workerTimer);
              adminRuntimeTelemetry.maintenanceIntervalMs = null;

              // 1. Send 1001 Going Away to WebSocket clients cleanly.
              wsManager.closeAllWebSockets();

              // 2. Stop accepting new HTTP connections and close idle keep-alive sockets.
              // Wait up to `shutdownDrainTimeoutMs` for active requests to finish cleanly
              // before forcing remaining sockets closed.
              const closeServer = new Promise<void>((resClose) => {
                server.close(() => resClose());
              });
              server.closeIdleConnections?.();

              let drainTimer: ReturnType<typeof setTimeout> | undefined;
              await Promise.race([
                closeServer,
                new Promise<void>((resTimeout) => {
                  drainTimer = setTimeout(() => {
                    if (inFlightRequests > 0) {
                      activePlatform.logger.warn("Shutdown drain timeout reached; forcing open sockets closed", {
                        inFlightRequests,
                      });
                    }
                    server.closeAllConnections?.();
                    resTimeout();
                  }, shutdownDrainTimeoutMs);
                  drainTimer.unref?.();
                }),
              ]);
              if (drainTimer !== undefined) clearTimeout(drainTimer);
              server.closeAllConnections?.();

              // 3. Flush buffers, stop realtime poller/LISTEN, and close DB pools.
              const withStop = activePlatform as typeof activePlatform & { stop?: () => Promise<void> };
              if (withStop.stop) {
                await withStop.stop();
              } else {
                await activePlatform.metering.stop().catch(() => undefined);
                await activePlatform.flushIndexRecommendations().catch(() => undefined);
              }
            })();
            return stopPromise;
          },
        });
      });
    });
  });
}

const isMain =
  process.argv[1] !== undefined &&
  (process.argv[1] === fileURLToPath(import.meta.url) ||
    process.argv[1].endsWith("/node-server.js") ||
    process.argv[1].endsWith("/node-server.ts"));

/** Latest server handle; signal handlers close HTTP first, then the platform. */
let activeServerStop: (() => Promise<void>) | null = null;
let shutdownStarted = false;
const handleShutdown = (): void => {
  if (shutdownStarted) return;
  shutdownStarted = true;
  const forceExitTimer = setTimeout(() => {
    process.stderr.write("[vellum-api] Graceful shutdown exceeded timeout; forcing exit\n");
    process.exit(1);
  }, SIGNAL_SHUTDOWN_HARD_TIMEOUT_MS);
  forceExitTimer.unref?.();

  const stop = activeServerStop;
  if (!stop) {
    clearTimeout(forceExitTimer);
    process.exit(0);
    return;
  }
  void stop()
    .then(() => {
      clearTimeout(forceExitTimer);
      process.exit(0);
    })
    .catch((err: unknown) => {
      clearTimeout(forceExitTimer);
      process.stderr.write(
        `[vellum-api] Graceful shutdown failed: ${err instanceof Error ? err.message : String(err)}\n`
      );
      process.exit(1);
    });
};
process.once("SIGTERM", handleShutdown);
process.once("SIGINT", handleShutdown);

if (isMain) {
  startNodeApiServer()
    .then(({ port, stop }) => {
      activeServerStop = stop;
      console.log(`[vellum-api] Server listening on port ${port}`);
    })
    .catch((err) => {
      console.error("[vellum-api] Failed to start server:", err);
      process.exit(1);
    });
}
