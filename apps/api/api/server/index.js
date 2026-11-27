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

// A database outage at cold start must never crash the function (which turns
// every route, including /v1/health/live, into FUNCTION_INVOCATION_FAILED).
// Init lazily; a failed init is retried on the next request and answered with
// a structured JSON 503 in the meantime.
let platformPromise = null;
function getPlatform() {
  if (!platformPromise) {
    platformPromise = createVellumPlatformFromEnv().catch((err) => {
      platformPromise = null;
      throw err;
    });
  }
  return platformPromise;
}

const DB_CONNECT_CODES = new Set([
  "53000", "53100", "53200", "53300", "57P01", "57P02", "57P03",
  "08000", "08001", "08003", "08004", "08006", "08007", "08P01",
  "ECONNREFUSED", "ETIMEDOUT", "ECONNRESET", "ENOTFOUND", "EPIPE", "EAI_AGAIN",
]);
function isDbConnectError(err, depth = 0) {
  if (depth > 4 || err === null || typeof err !== "object") return false;
  if (typeof err.code === "string" && DB_CONNECT_CODES.has(err.code)) return true;
  if (typeof err.message === "string" && /timeout exceeded when trying to connect|Connection terminated unexpectedly|remaining connection slots are reserved|too many connections/i.test(err.message)) return true;
  return isDbConnectError(err.cause, depth + 1);
}

function unavailableResponse(requestId) {
  return new Response(
    JSON.stringify({
      error: {
        code: "SERVICE_UNAVAILABLE",
        message: "The database is temporarily unavailable. Please retry shortly.",
        requestId,
        details: { retryAfterSeconds: 5, retryable: true },
      },
    }),
    { status: 503, headers: { "content-type": "application/json", "retry-after": "5", "x-request-id": requestId } }
  );
}

// pg/socket noise on idle connections must not kill the serverless process;
// anything else remains fatal and visible.
process.on("uncaughtException", (err) => {
  if (isDbConnectError(err)) {
    console.error("Ignored database socket error:", err instanceof Error ? err.message : String(err));
    return;
  }
  console.error(err);
  process.exit(1);
});

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

  const requestId = (req.headers && req.headers["x-request-id"]) || `req_${crypto.randomUUID()}`;

  let platform;
  try {
    platform = await getPlatform();
  } catch (err) {
    console.error("Platform init failed:", err instanceof Error ? err.message : String(err));
    await pipeWebResponse(unavailableResponse(requestId), res, {});
    return;
  }
  startPostInit(platform);

  let response;
  try {
    const request = new Request(new URL(target, "http://localhost"), init);
    // Scheduled maintenance (Vercel cron, bearer CRON_SECRET) is answered before the platform router.
    response = (await handleMaintenanceRequest(request, platform.dataStore)) ?? (await platform.fetch(request));
  } catch (err) {
    if (isDbConnectError(err)) {
      response = unavailableResponse(requestId);
    } else {
      response = new Response(
        JSON.stringify({ error: { code: "INTERNAL", message: "Internal Server Error", requestId } }),
        { status: 500, headers: { "content-type": "application/json" } }
      );
    }
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

// Retention (outbox, tombstones, TTL) and realtime WebSocket attach need the
// platform; both start once init first succeeds (and keep retrying via
// getPlatform() until it does).
let postInitStarted = false;
function startPostInit(platform) {
  if (postInitStarted) return;
  postInitStarted = true;
  if (process.env["VELLUM_DISABLE_PURGE_TICK"] !== "1") {
    startPurgeTick(platform.dataStore, (err) => {
      platform.logger.warn("Purge tick failed", { reason: err instanceof Error ? err.message.slice(0, 256) : String(err) });
    });
  }
  attachRealtimeWebSocketServer(server, platform.realtimeHub, {
    allowedOrigins: parseAllowedOrigins(getConfig().CORS_ALLOWED_ORIGINS),
    isProjectOriginAllowed: createProjectOriginChecker(platform.controlStore),
    // Vercel cuts a function at its max duration (300 s on Hobby). Close first, the SDK reconnects and resumes.
    maxLifetimeMs: Number(process.env["REALTIME_WS_MAX_LIFETIME_MS"] ?? 265_000),
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
// Upgrade requests arriving before platform init completes wait for it; if the
// database is still down the socket is closed so the client retries.
server.on("upgrade", (req, socket, head) => {
  const url = new URL(req.url || "/", "http://localhost");
  const target = url.searchParams.get("path");
  if (target) req.url = target;
  if (postInitStarted) return; // the realtime handler (registered next) takes it
  getPlatform()
    .then((platform) => {
      startPostInit(platform);
      server.emit("upgrade", req, socket, head);
    })
    .catch(() => {
      socket.destroy();
    });
});

// Warm the platform eagerly so the common path never pays the lazy-init cost.
getPlatform().then(startPostInit).catch(() => undefined);

export default server;
