/**
 * @vellum/api - Vercel Functions runtime adapter.
 *
 * Vercel Functions serve WebSockets (GA, Fluid compute) when the default export
 * is a Node `http.Server`. Realtime is also available over Server-Sent Events by
 * `POST /v1/realtime/stream` (see routes/realtime-sse.ts), which the SDKs use as
 * an automatic fallback. Hono apps with a Node `http.Server` are supported without a
 * Vercel-specific upgrade API: export the server as the function's default
 * export. This module reuses the exact same core (`createVellumApp` via the
 * platform factory) and the exact same RFC 6455 WebSocket handler used by the
 * standalone Node adapter — there is no separate backend implementation.
 *
 * The function is mounted behind a rewrite so the browser keeps the canonical
 * same-origin `/v1` URL. Vercel rewrites change the URL seen by the function,
 * so we strip the function prefix before handing the request to Hono and before
 * the WebSocket upgrade handler inspects `req.url`.
 */

import http from "node:http";
import { getRequestListener } from "@hono/node-server";
import { createVellumPlatformFromEnv } from "../index.js";
import { getConfig } from "../config.js";
import {
  attachRealtimeWebSocketServer,
  parseAllowedOrigins,
} from "../ws-rfc6455.js";

import { stripVercelFunctionPrefix } from "./vercel-path.js";
import { handleMaintenanceRequest, startPurgeTick } from "./vercel-maintenance.js";

const platform = await createVellumPlatformFromEnv();
const requestListener = getRequestListener(async (request) =>
  (await handleMaintenanceRequest(request, platform.dataStore)) ?? platform.fetch(request)
);

// Retention (outbox, tombstones, TTL) has no cron on this host: tick while the instance is alive.
if (process.env["VELLUM_DISABLE_PURGE_TICK"] !== "1") {
  startPurgeTick(platform.dataStore, (err) => {
    platform.logger.warn("Purge tick failed", { reason: err instanceof Error ? err.message.slice(0, 256) : String(err) });
  });
}

const server = http.createServer((req, res) => {
  req.url = stripVercelFunctionPrefix(req.url);
  requestListener(req, res);
});

// Registered BEFORE the WebSocket handler so the upgrade listener below sees
// the already-stripped `/v1/realtime` pathname.
server.on("upgrade", (req) => {
  req.url = stripVercelFunctionPrefix(req.url);
});

attachRealtimeWebSocketServer(server, platform.realtimeHub, {
  allowedOrigins: parseAllowedOrigins(getConfig().CORS_ALLOWED_ORIGINS),
  // Vercel cuts a function at its max duration (300 s on Hobby). Close first, the SDK reconnects and resumes.
  maxLifetimeMs: Number(process.env["REALTIME_WS_MAX_LIFETIME_MS"] ?? 265_000),
});

/** Vercel Function entry point: an http.Server with REST + WebSocket attached. */
export default server;
