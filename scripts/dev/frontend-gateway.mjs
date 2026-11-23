#!/usr/bin/env node
/**
 * FRONTEND-ONLY, zero-dependency gateway (HTTP + WebSocket) on port 3000.
 *
 *   --mode=dev   proxy dashboard (5173), admin (5174), docs (5175) and the API
 *   --mode=prod  serve dist-frontend/ directly, proxy /v1 (HTTP + WS) to a LOCAL API
 *
 * Only `node:*` modules are used — no backend imports, no database access. The
 * `/v1` proxy is a LOCAL DEVELOPMENT CONVENIENCE only: the deployed static site
 * never proxies `/v1` and instead calls the absolute backend URL from
 * `VITE_API_BASE_URL` / `window.__VELLUM_API_BASE_URL__`.
 *
 * Local API target precedence: VELLUM_API_BASE_URL -> VELLUM_API_BASE_URL ->
 * http://127.0.0.1:8080.
 */

import http from "node:http";
import https from "node:https";
import net from "node:net";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, spawnSync } from "node:child_process";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, "..");
const DIST = path.join(ROOT, "dist-frontend");

export const SECURITY_HEADERS = Object.freeze({
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "strict-origin-when-cross-origin",
});

export const MIME_TYPES = Object.freeze({
  ".html": "text/html; charset=utf-8",
  ".htm": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".mjs": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".otf": "font/otf",
  ".eot": "application/vnd.ms-fontobject",
  ".txt": "text/plain; charset=utf-8",
  ".xml": "application/xml; charset=utf-8",
  ".webmanifest": "application/manifest+json",
  ".wasm": "application/wasm",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
});

const ASSET_EXTS = new Set([
  ".js", ".mjs", ".css", ".map", ".json", ".png", ".jpg", ".jpeg", ".gif",
  ".webp", ".avif", ".svg", ".ico", ".woff", ".woff2", ".ttf", ".otf", ".eot",
  ".txt", ".xml", ".webmanifest", ".wasm", ".mp4", ".webm",
]);

export function applySecurityHeaders(res) {
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) res.setHeader(name, value);
}

export function applyCacheHeaders(res, pathname) {
  // Hashed/immutable assets only. Everything else must be revalidated so a new
  // deploy is visible immediately.
  if (/^\/(?:admin\/|docs\/)?assets\//.test(pathname)) {
    res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
  } else {
    res.setHeader("Cache-Control", "no-cache");
  }
}

export function looksLikeAsset(pathname) {
  return ASSET_EXTS.has(path.extname(pathname).toLowerCase());
}

/** Parse an API upstream URL into the pieces http.request needs. */
export function parseUpstream(raw) {
  const input = typeof raw === "string" && raw.trim() ? raw.trim() : "http://127.0.0.1:8080";
  let url;
  try {
    url = new URL(input);
  } catch {
    throw new Error(`Invalid API upstream "${input}" — expected e.g. http://127.0.0.1:8080`);
  }
  const protocol = url.protocol === "https:" ? "https:" : "http:";
  const hostname = url.hostname || "127.0.0.1";
  const port = url.port ? Number(url.port) : protocol === "https:" ? 443 : 8080;
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error(`Invalid API upstream port in "${input}"`);
  }
  return {
    protocol,
    hostname,
    port,
    hostHeader: `${hostname}:${port}`,
    module: protocol === "https:" ? https : http,
  };
}

/** Poll a TCP port until it accepts connections or the timeout elapses. */
export function waitForPort(host, port, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    let settled = false;
    const attempt = () => {
      if (settled) return;
      const socket = net.connect({ host, port });
      const finish = (err) => {
        socket.removeAllListeners();
        socket.destroy();
        if (settled) return;
        if (!err) {
          settled = true;
          resolve();
        } else if (Date.now() >= deadline) {
          settled = true;
          reject(new Error(`Timed out after ${timeoutMs}ms waiting for ${label} at ${host}:${port}`));
        } else {
          setTimeout(attempt, 250);
        }
      };
      socket.setTimeout(1000);
      socket.once("connect", () => finish(null));
      socket.once("error", finish);
      socket.once("timeout", () => finish(new Error("connect timeout")));
    };
    attempt();
  });
}

function localTarget(port) {
  return { protocol: "http:", hostname: "127.0.0.1", port, hostHeader: `127.0.0.1:${port}`, module: http };
}

function safeRelative(input) {
  return path
    .normalize(input)
    .replace(/^(\.\.[/\\])+/, "")
    .replace(/^[/\\]+/, "");
}

function rewriteStripPrefix(prefix) {
  return (pathname) => {
    if (pathname === prefix) return "/";
    if (pathname.startsWith(`${prefix}/`)) return pathname.slice(prefix.length);
    return pathname;
  };
}

function resolvePath(req) {
  // A request-target of `//` is a protocol-relative URL with an empty host and
  // makes `new URL()` throw, which previously crashed the whole gateway.
  const raw = (req.url || "/").replace(/^\/{2,}/, "/");
  const parsed = new URL(raw, "http://localhost");
  let pathname;
  try {
    pathname = decodeURIComponent(parsed.pathname);
  } catch {
    pathname = parsed.pathname;
  }
  return { pathname, search: parsed.search };
}

function proxyRequest(req, res, target, rewrite) {
  const { pathname, search } = resolvePath(req);
  const outPath = (rewrite ? rewrite(pathname) : pathname) + search;
  const headers = { ...req.headers };
  headers.host = target.hostHeader; // changeOrigin-equivalent: avoids Vite 403
  headers["x-forwarded-host"] = req.headers.host || "";
  headers["x-forwarded-proto"] = "http";
  const upstream = target.module.request(
    { hostname: target.hostname, port: target.port, method: req.method, path: outPath, headers },
    (upstreamRes) => {
      // Vite's dev SPA fallback can answer a missing asset with index.html
      // (text/html). Never let that reach the browser as JavaScript/CSS — it
      // produces the dreaded "Unexpected token '<'". Answer 404 instead.
      const contentType = String(upstreamRes.headers["content-type"] || "").toLowerCase();
      if (looksLikeAsset(pathname) && contentType.startsWith("text/html")) {
        upstreamRes.resume();
        res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
        res.end(`404 Not Found: ${pathname}\n`);
        return;
      }
      res.writeHead(upstreamRes.statusCode || 502, upstreamRes.headers);
      upstreamRes.pipe(res);
    }
  );
  upstream.on("error", (err) => {
    if (!res.headersSent) {
      res.writeHead(502, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ error: "Bad Gateway", message: err.message }));
    } else {
      res.destroy();
    }
  });
  req.pipe(upstream);
}

function proxyUpgrade(req, socket, head, target, rewrite) {
  const { pathname, search } = resolvePath(req);
  const outPath = (rewrite ? rewrite(pathname) : pathname) + search;
  const headers = { ...req.headers };
  headers.host = target.hostHeader;
  headers["x-forwarded-host"] = req.headers.host || "";
  headers["x-forwarded-proto"] = "http";
  const upstream = target.module.request({
    hostname: target.hostname,
    port: target.port,
    method: "GET",
    path: outPath,
    headers,
  });
  upstream.on("upgrade", (upRes, upSocket, upHead) => {
    const responseHeaders = Object.entries(upRes.headers)
      .map(([key, value]) => `${key}: ${value}`)
      .join("\r\n");
    socket.write(`HTTP/1.1 101 Switching Protocols\r\n${responseHeaders}\r\n\r\n`);
    if (upHead && upHead.length) socket.write(upHead);
    upSocket.pipe(socket);
    socket.pipe(upSocket);
    // An abrupt browser/tab disconnect must never crash the gateway.
    socket.on("error", () => upSocket.destroy());
    upSocket.on("error", () => socket.destroy());
    socket.on("close", () => upSocket.destroy());
    upSocket.on("close", () => socket.destroy());
    if (head && head.length) upSocket.write(head);
  });
  socket.on("error", () => upstream.destroy());
  upstream.on("error", () => socket.destroy());
  upstream.end();
}

function send404(res, pathname) {
  res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
  res.end(`404 Not Found: ${pathname}\n`);
}

function isFile(filePath) {
  try {
    return fs.statSync(filePath).isFile();
  } catch {
    return false;
  }
}

function sendFile(res, filePath, pathname) {
  if (!isFile(filePath)) return send404(res, pathname);
  applyCacheHeaders(res, pathname);
  const ext = path.extname(filePath).toLowerCase();
  res.writeHead(200, { "Content-Type": MIME_TYPES[ext] || "application/octet-stream" });
  fs.createReadStream(filePath).pipe(res);
}

/** Production static routing. Missing assets NEVER fall back to index.html. */
function serveProduction(res, pathname) {
  const rel = pathname.replace(/^\/+/, "");

  if (pathname === "/admin") {
    res.writeHead(302, { Location: "/admin/" });
    return res.end();
  }
  if (pathname === "/docs" || pathname === "/docs/") {
    return sendFile(res, path.join(DIST, "docs", "index.html"), pathname);
  }

  if (pathname === "/admin/" || pathname.startsWith("/admin/")) {
    const sub = pathname.slice("/admin/".length);
    const base = path.join(DIST, "admin");
    if (sub === "") return sendFile(res, path.join(base, "index.html"), pathname);
    const direct = path.join(base, safeRelative(sub));
    if (isFile(direct)) return sendFile(res, direct, pathname);
    if (path.extname(sub)) return send404(res, pathname);
    const dirIndex = path.join(direct, "index.html");
    if (isFile(dirIndex)) return sendFile(res, dirIndex, pathname);
    return sendFile(res, path.join(base, "index.html"), pathname);
  }

  if (pathname.startsWith("/docs/")) {
    const sub = pathname.slice("/docs/".length);
    const base = path.join(DIST, "docs");
    const direct = path.join(base, safeRelative(sub));
    if (isFile(direct)) return sendFile(res, direct, pathname);
    const dirIndex = path.join(direct, "index.html");
    if (isFile(dirIndex)) return sendFile(res, dirIndex, pathname);
    // Extensionless routes only may fall back to the docs SPA entry point.
    if (path.extname(sub)) return send404(res, pathname);
    return sendFile(res, path.join(base, "index.html"), pathname);
  }

  // Dashboard (origin root).
  if (rel !== "") {
    const direct = path.join(DIST, safeRelative(rel));
    if (isFile(direct)) return sendFile(res, direct, pathname);
    if (path.extname(rel)) return send404(res, pathname);
  }
  return sendFile(res, path.join(DIST, "index.html"), pathname);
}

function isApiPath(pathname) {
  return pathname === "/v1" || pathname.startsWith("/v1/");
}

function pickDevTarget(pathname, dev) {
  if (pathname === "/admin" || pathname.startsWith("/admin/")) return dev.admin;
  if (pathname === "/docs" || pathname.startsWith("/docs/")) return dev.docs;
  return dev.dashboard;
}

function attachHandlers(server, apiTarget, dev) {
  server.on("request", (req, res) => {
    applySecurityHeaders(res);
    const { pathname } = resolvePath(req);
    applyCacheHeaders(res, pathname);

    if (isApiPath(pathname)) return proxyRequest(req, res, apiTarget);
    // Canonical trailing-slash redirects. The static docs site uses relative
    // asset URLs, so serving it at bare `/docs` would resolve them against `/`.
    if (pathname === "/docs") {
      res.writeHead(302, { Location: "/docs/" });
      return res.end();
    }
    if (pathname === "/admin") {
      res.writeHead(302, { Location: "/admin/" });
      return res.end();
    }
    if (dev) {
      const target = pickDevTarget(pathname, dev);
      return proxyRequest(req, res, target.target, target.rewrite);
    }
    return serveProduction(res, pathname);
  });

  server.on("upgrade", (req, socket, head) => {
    const { pathname } = resolvePath(req);
    if (isApiPath(pathname)) return proxyUpgrade(req, socket, head, apiTarget);
    if (dev) {
      const target = pickDevTarget(pathname, dev);
      return proxyUpgrade(req, socket, head, target.target, target.rewrite);
    }
    socket.end("HTTP/1.1 404 Not Found\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
  });
}

function parseMode() {
  const arg = process.argv.find((a) => a.startsWith("--mode="));
  const mode = arg ? arg.slice("--mode=".length) : "prod";
  if (mode !== "dev" && mode !== "prod") {
    throw new Error(`Unknown --mode "${mode}" — expected --mode=dev or --mode=prod`);
  }
  return mode;
}

function killChildren(children, signal = "SIGTERM") {
  for (const child of children) {
    if (!child.pid) continue;
    if (process.platform === "win32") {
      try {
        spawn("taskkill", ["/pid", String(child.pid), "/f", "/t"]);
      } catch {
        try { child.kill("SIGKILL"); } catch {}
      }
    } else {
      try {
        process.kill(-child.pid, signal); // detached process group: no orphans
      } catch {
        try {
          child.kill(signal);
        } catch {
          /* already gone */
        }
      }
    }
  }
}

async function startDevUpstreams() {
  const docsIndex = path.join(ROOT, "apps/docs/dist/index.html");
  if (!fs.existsSync(docsIndex)) {
    console.log("[web] docs build missing — building @vellum/docs once ...");
    const corepackCmd = process.platform === "win32" ? "corepack.cmd" : "corepack";
    const built = spawnSync(corepackCmd, ["pnpm", "--filter", "@vellum/docs", "build"], {
      cwd: ROOT,
      stdio: "inherit",
      env: process.env,
      shell: process.platform === "win32",
    });
    if (built.error || built.status !== 0) {
      throw new Error(`Failed to build @vellum/docs: ${built.error?.message || `exit ${built.status}`}`);
    }
  }

  const children = [];
  const launch = (cmd, args) => {
    const isWin = process.platform === "win32";
    const resolvedCmd = isWin && cmd === "corepack" ? "corepack.cmd" : cmd;
    const child = spawn(resolvedCmd, args, {
      cwd: ROOT,
      stdio: "inherit",
      detached: !isWin,
      shell: isWin,
      env: { ...process.env },
    });
    children.push(child);
    return child;
  };

  launch("corepack", ["pnpm", "--filter", "@vellum/dashboard", "exec", "vite", "--host", "127.0.0.1", "--port", "5173", "--strictPort"]);
  launch("corepack", ["pnpm", "--filter", "@vellum/admin", "exec", "vite", "--host", "127.0.0.1", "--port", "5174", "--strictPort"]);
  launch(process.execPath, [path.join(ROOT, "scripts/dev/docs-dev-server.mjs")]);

  console.log("[web] waiting for dev upstreams (5173, 5174, 5175) ...");
  await Promise.all([
    waitForPort("127.0.0.1", 5173, 60000, "dashboard dev server"),
    waitForPort("127.0.0.1", 5174, 60000, "admin dev server"),
    waitForPort("127.0.0.1", 5175, 60000, "docs dev server"),
  ]);

  const dev = {
    dashboard: { target: localTarget(5173) },
    admin: { target: localTarget(5174) },
    // The docs static server is rooted at apps/docs/dist, so strip /docs.
    docs: { target: localTarget(5175), rewrite: rewriteStripPrefix("/docs") },
  };
  return { children, dev };
}

async function main() {
  const mode = parseMode();
  const port = Number(process.env.PORT || 3000);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error(`Invalid PORT "${process.env.PORT}"`);
  }
  // LOCAL DEVELOPMENT ONLY. Precedence is VELLUM_* -> VELLUM_* -> local default.
  // The deployed static frontend never uses this proxy; it resolves the backend
  // URL via VITE_API_BASE_URL / window.__VELLUM_API_BASE_URL__.
  const apiTargetRaw =
    process.env.VELLUM_API_BASE_URL ||
    process.env.VELLUM_API_BASE_URL ||
    "http://127.0.0.1:8080";
  const apiTarget = parseUpstream(apiTargetRaw);
  const apiTargetSource = process.env.VELLUM_API_BASE_URL
    ? "VELLUM_API_BASE_URL"
    : process.env.VELLUM_API_BASE_URL
      ? "VELLUM_API_BASE_URL"
      : "default (http://127.0.0.1:8080)";

  let children = [];
  let dev = null;
  if (mode === "dev") {
    const started = await startDevUpstreams();
    children = started.children;
    dev = started.dev;
  } else if (!fs.existsSync(path.join(DIST, "index.html"))) {
    throw new Error("dist-frontend/ is missing — run `corepack pnpm build:frontend` first");
  }

  const server = http.createServer();
  server.on("error", (err) => {
    if (err.code === "EADDRINUSE") {
      console.error(`[web] Port ${port} is already in use. Stop that process or set PORT to another value.`);
    } else {
      console.error(`[web] Server error: ${err.message}`);
    }
    killChildren(children);
    process.exit(1);
  });
  attachHandlers(server, apiTarget, dev);

  await new Promise((resolve) => server.listen(port, "0.0.0.0", resolve));
  console.log(`[web] frontend gateway (${mode}) listening on http://localhost:${port}`);
  console.log(`[web] local API target (${apiTargetSource}): ${apiTarget.protocol}//${apiTarget.hostHeader}`);
  console.log("[web] /v1 proxy is for local dev only — deployed static site calls the backend directly via VITE_API_BASE_URL");

  let shuttingDown = false;
  const shutdown = (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`\n[web] ${signal} received — shutting down gateway and dev upstreams ...`);
    killChildren(children);
    server.close();
    const force = setTimeout(() => process.exit(0), 3000);
    force.unref();
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

const invokedDirectly =
  process.argv[1] && path.resolve(process.argv[1]) === __filename;
if (invokedDirectly) {
  main().catch((err) => {
    console.error(`[web] ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  });
}
