/**
 * Vellum backend Vercel Function entry.
 *
 * Vercel pre-parses POST bodies into `req.body` and leaves the Node request
 * stream un-ended, so Hono's Node adaptor cannot read them. Call the platform's
 * Web-standard `fetch` directly instead. Rewrites pass the original `/v1/...`
 * path as a `?path=` query because Vercel cannot route a multi-segment rewrite
 * destination to a single-segment Function.
 */
import http from "node:http";
import { createVellumPlatformFromEnv } from "../../dist/index.js";
import { getConfig } from "../../dist/config.js";
import { attachRealtimeWebSocketServer, parseAllowedOrigins } from "../../dist/ws-rfc6455.js";
import { pipeWebResponse } from "../../dist/runtime/node-stream.js";
import { createProjectOriginChecker } from "../../dist/middleware/project-cors.js";
import { handleMaintenanceRequest, startPurgeTick } from "../../dist/runtime/vercel-maintenance.js";

const platform = await createVellumPlatformFromEnv();

const ALLOWED_VERCEL_ORIGINS = new Set([
  "https://vellum-console.vercel.app",
  "https://vellum-console-mag-1.vercel.app",
]);

// The rewrite carries the original path in `?path=` and appends the caller's own query
// parameters next to it. Put those parameters back on the forwarded request URL, otherwise
// every query string (pagination, OAuth code/state, apiKey) is silently dropped.
function rebuildTarget(url) {
  const target = new URL(url.searchParams.get("path") || "/", "http://localhost");
  for (const [key, value] of url.searchParams) {
    if (key !== "path") target.searchParams.append(key, value);
  }
  return target.pathname + target.search;
}

async function handler(req, res) {
  const url = new URL(req.url || "/", "http://localhost");
  const target = rebuildTarget(url);
  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers || {})) {
    if (Array.isArray(value)) for (const item of value) headers.append(key, String(item));
    else if (value !== undefined && value !== null) headers.set(key, String(value));
  }

  const init = { method: req.method || "GET", headers };
  if (!["GET", "HEAD"].includes(init.method)) {
    const body = req.body;
    if (body !== undefined && body !== null) {
      init.body = typeof body === "string" ? body : JSON.stringify(body);
    } else {
      // Served as an http.Server (needed for WebSocket upgrades): the body is an un-parsed stream.
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      if (chunks.length > 0) init.body = Buffer.concat(chunks);
    }
  }

  let response;
  try {
    const request = new Request(new URL(target, "http://localhost"), init);
    // Scheduled maintenance (Vercel cron, bearer CRON_SECRET) is answered before the platform router.
    response = (await handleMaintenanceRequest(request, platform.dataStore)) ?? (await platform.fetch(request));
  } catch (err) {
    response = new Response(
      JSON.stringify({ error: "INTERNAL_ERROR", reason: err instanceof Error ? err.message : String(err) }),
      { status: 500, headers: { "content-type": "application/json" } }
    );
  }

  const extra = {};
  const origin = req.headers && req.headers.origin;
  if (origin && ALLOWED_VERCEL_ORIGINS.has(origin)) {
    extra["Access-Control-Allow-Origin"] = origin;
    extra["Access-Control-Allow-Credentials"] = "true";
    extra["Vary"] = "Origin";
  }

  // Stream the body (do not buffer it): realtime over SSE depends on it.
  await pipeWebResponse(response, res, extra);
}

// Retention (outbox, tombstones, TTL): tick while the instance is alive; the daily cron is a backstop.
if (process.env["VELLUM_DISABLE_PURGE_TICK"] !== "1") {
  startPurgeTick(platform.dataStore, (err) => {
    platform.logger.warn("Purge tick failed", { reason: err instanceof Error ? err.message.slice(0, 256) : String(err) });
  });
}

// Vercel Functions serve WebSockets when the default export is an http.Server
// (Fluid compute, GA). The same server also handles every REST and SSE request.
const server = http.createServer((req, res) => {
  handler(req, res).catch((err) => {
    if (!res.headersSent) {
      res.statusCode = 500;
      res.setHeader("content-type", "application/json");
    }
    res.end(JSON.stringify({ error: "INTERNAL_ERROR", reason: err instanceof Error ? err.message : String(err) }));
  });
});

// Rewrites hand the function `/api/server?path=/v1/...`; the WebSocket handler needs the real path.
server.on("upgrade", (req) => {
  const url = new URL(req.url || "/", "http://localhost");
  const target = url.searchParams.get("path");
  if (target) req.url = target;
});

attachRealtimeWebSocketServer(server, platform.realtimeHub, {
  allowedOrigins: parseAllowedOrigins(getConfig().CORS_ALLOWED_ORIGINS),
  isProjectOriginAllowed: createProjectOriginChecker(platform.controlStore),
  // Vercel cuts a function at its max duration (300 s on Hobby). Close first, the SDK reconnects and resumes.
  maxLifetimeMs: Number(process.env["REALTIME_WS_MAX_LIFETIME_MS"] ?? 265_000),
});

export default server;
