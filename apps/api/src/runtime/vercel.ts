/**
 * @vellum/api - Vercel Functions runtime adapter.
 *
 * Vercel Functions serve WebSocket connections natively (Fluid Compute, public
 * beta since 2026). Hono apps with a Node `http.Server` are supported without a
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

const platform = await createVellumPlatformFromEnv();
const requestListener = getRequestListener((request) => platform.fetch(request));

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
});

/** Vercel Function entry point: an http.Server with REST + WebSocket attached. */
export default server;
